/**
 * §5.3 socket-ack-as-receipt prototype (harness side; src/sync/vaultSync.ts is untouched).
 *
 * `receiptWebSocket(options)` returns a `ws` subclass to pass as `VaultSyncOptions.webSocket`. The real
 * provider stack is unchanged: YSyncProvider → FencedWebSocket.send → this.send. For every binary
 * y-protocols sync frame on a body socket (update, or a non-empty step2), this wrapper:
 *   1. builds a real `CandidateRecord` (StoredBodyCandidate shape) for exactly that frame's inner update,
 *      with candidateDigest = sha256(candidateDigestMaterial([inner])), the production digest function;
 *   2. persists it to the real client store (`database.putCandidate`, e.g. the CLI SQLite
 *      NodeVaultDatabase), either before the send (`persist: "before-send"`: all sends on the socket go
 *      through an ordered queue) or in parallel (`"after-send"`: settlement waits for the put);
 *   3. sends `__YPS:{BODY_UPDATE_ENVELOPE, clientFrameId, candidateId, candidateDigest, payloadDigest,
 *      contentHash, size, stateVector, frameKind}` and then the binary frame back to back (nothing can
 *      interleave: one synchronous section, or one queue step);
 *   4. on the origin `BODY_COMMITTED` echo (`relay:true`, matching clientFrameId, candidateId and
 *      candidateDigest) builds the `BodyReceipt` and calls the real `database.confirmPendingCandidate`,
 *      the same store call VaultSync's `completeCandidateSubmission` makes after an HTTP receipt
 *      (falls back to `deleteCandidate` when the store has no confirm).
 * Unsettled records stay in the real store, so the HTTP path remains the fallback: VaultSync's
 * `restoreCandidates()` resubmits them over HTTP on the next start.
 *
 * `debounceMs > 0` emulates a client-side candidate debounce on the relay path: update frames are held,
 * merged (`Y.mergeUpdates`) and sent as one frame + one envelope (250 ms / 2 s maxWait like production).
 * Step2 frames flush the buffer first, so the frame order the provider produced is kept.
 */
import { createHash, randomUUID } from "node:crypto";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import * as Y from "yjs";
import { candidateDigestMaterial } from "../../../server/src/shared/candidateDigest";
import { now, r2 } from "./common";
import { contentHashOf } from "./rawClient";

type Obj = Record<string, unknown>;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface ReceiptStore {
	putCandidate(record: Obj): Promise<void>;
	deleteCandidate(bodyId: string, candidateId: string): Promise<void>;
	confirmPendingCandidate?(receipt: Obj): Promise<void>;
}

export interface ReceiptOptions {
	vaultId: string;
	vaultGeneration: string;
	deviceId: string;
	database: ReceiptStore;
	/** Registered bodies: the harness registers the Y.Doc + epoch after acquiring a body. Unregistered → pass-through. */
	bodies: Map<string, { doc: Y.Doc; bodyEpoch: number }>;
	persist?: "before-send" | "after-send";
	debounceMs?: number;
	maxWaitMs?: number;
	/** Envelope non-empty step2 frames (reconnect with offline edits). Default true. */
	envelopeStep2?: boolean;
	/** Omit candidate fields (envelope only; no receipt settlement). */
	noCandidate?: boolean;
	/** Count frames only; never envelope (base / flag-off runs). */
	passive?: boolean;
	/** Live socket registry (harness fault injection: terminate a body socket to force an offline window). */
	registry?: Set<WebSocket & { bodyId: string | null }>;
	/** Every binary frame the provider hands to send() on a body socket (before any harness debounce/envelope). */
	sendLog?: { at: number; bodyId: string; kind: string; bytes: number }[];
}

export interface FrameRecord {
	clientFrameId: string; candidateId: string | null; candidateDigest: string | null; payloadDigest: string;
	bodyId: string; kind: "update" | "step2"; mergedUpdates: number; bytes: number;
	firstLocalAt: number; persistedAt: number | null; sentAt: number | null; echoAt: number | null; settledAt: number | null;
	echo: Obj | null; outcome: "pending" | "settled" | "rejected" | "digest_mismatch" | "settle_failed";
	error?: string;
}

export interface ReceiptStats {
	sockets: number; bodySockets: number;
	framesOut: Record<string, number>; bytesOut: number; framesIn: Record<string, number>; bytesIn: number;
	envelopesSent: Record<string, number>; envelopeLessBinary: Record<string, number>;
	echoesPaired: number; echoDigestMismatch: number; originCommitsWithoutFrameId: number; peerCommits: number;
	dedupedEchoes: number; noopEchoes: number; hashAccepted: number; hashNotAccepted: number;
	rejects: Obj[]; backpressure: Obj[]; closes: Obj[]; settled: number; settleFailures: number;
	echoOutOfOrder: number; emptyStep2PassThrough: number; unregisteredBody: number;
}

export function newReceiptStats(): ReceiptStats {
	return { sockets: 0, bodySockets: 0, framesOut: {}, bytesOut: 0, framesIn: {}, bytesIn: 0, envelopesSent: {},
		envelopeLessBinary: {}, echoesPaired: 0, echoDigestMismatch: 0, originCommitsWithoutFrameId: 0, peerCommits: 0,
		dedupedEchoes: 0, noopEchoes: 0, hashAccepted: 0, hashNotAccepted: 0, rejects: [], backpressure: [], closes: [],
		settled: 0, settleFailures: 0, echoOutOfOrder: 0, emptyStep2PassThrough: 0, unregisteredBody: 0 };
}

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

/** Parse a y-protocols frame: [messageType, syncType?, inner?]. */
export function parseSyncFrame(bytes: Uint8Array): { type: number; sync: number | null; inner: Uint8Array | null } {
	try {
		const d = decoding.createDecoder(bytes);
		const type = decoding.readVarUint(d);
		if (type !== 0) return { type, sync: null, inner: null };
		const sync = decoding.readVarUint(d);
		if (sync === 0) return { type, sync, inner: null };
		return { type, sync, inner: decoding.readVarUint8Array(d) };
	} catch { return { type: -1, sync: null, inner: null }; }
}

function syncFrame(sync: number, inner: Uint8Array): Uint8Array {
	const e = encoding.createEncoder();
	encoding.writeVarUint(e, 0);
	encoding.writeVarUint(e, sync);
	encoding.writeVarUint8Array(e, inner);
	return encoding.toUint8Array(e);
}

const frameName = (p: ReturnType<typeof parseSyncFrame>) =>
	p.type === 0 ? (p.sync === 0 ? "step1" : p.sync === 1 ? "step2" : "update") : p.type === 1 ? "awareness" : `type${p.type}`;

export function receiptWebSocket(options: ReceiptOptions, stats: ReceiptStats, frames: FrameRecord[]) {
	const persist = options.persist ?? "before-send";
	const debounceMs = options.debounceMs ?? 0;
	const maxWaitMs = options.maxWaitMs ?? 2000;
	const byFrameId = new Map<string, { frame: FrameRecord; record: Obj | null; persisted: Promise<void> }>();

	return class ReceiptWebSocket extends WebSocket {
		readonly bodyId: string | null;
		private chain: Promise<void> = Promise.resolve();
		private buffer: { inner: Uint8Array; at: number }[] = [];
		private timer: ReturnType<typeof setTimeout> | null = null;
		private firstBufferedAt = 0;
		private readonly sentOrder: string[] = [];

		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols ?? []);
			stats.sockets++;
			const m = new URL(String(url)).pathname.match(/\/ws\/body\/([^/?]+)/);
			this.bodyId = m ? decodeURIComponent(m[1]!) : null;
			if (this.bodyId) stats.bodySockets++;
			options.registry?.add(this);
			this.on("close", (code, reason) => { options.registry?.delete(this); stats.closes.push({ bodyId: this.bodyId, code, reason: reason.toString(), at: r2(now()) }); });
			this.on("message", (data, isBinary) => {
				const size = Array.isArray(data) ? data.reduce((s, b) => s + b.byteLength, 0) : (data as Buffer).byteLength;
				stats.bytesIn += size;
				if (isBinary) { bump(stats.framesIn, frameName(parseSyncFrame(new Uint8Array(data as Buffer)))); return; }
				const text = data.toString();
				if (!text.startsWith("__YPS:")) { bump(stats.framesIn, "text"); return; }
				let msg: Obj;
				try { msg = JSON.parse(text.slice(6)) as Obj; } catch { bump(stats.framesIn, "badjson"); return; }
				bump(stats.framesIn, String(msg.type));
				if (this.bodyId) void this.onControl(msg);
			});
		}

		override send(data: unknown, ...rest: unknown[]): void {
			const raw = (d: unknown) => {
				const size = typeof d === "string" ? Buffer.byteLength(d) : (d as Uint8Array).byteLength;
				stats.bytesOut += size;
				(super.send as (...a: unknown[]) => void)(d, ...rest);
			};
			if (typeof data === "string" || !this.bodyId) {
				if (typeof data !== "string") bump(stats.framesOut, frameName(parseSyncFrame(toBytes(data))));
				else bump(stats.framesOut, "text");
				this.enqueue(() => raw(data));
				return;
			}
			const bytes = toBytes(data);
			const parsed = parseSyncFrame(bytes);
			const name = frameName(parsed);
			bump(stats.framesOut, name);
			options.sendLog?.push({ at: now(), bodyId: this.bodyId, kind: name, bytes: bytes.byteLength });
			if (options.passive) { this.enqueue(() => raw(bytes)); return; }
			const body = options.bodies.get(this.bodyId);
			const appendable = parsed.type === 0 && (parsed.sync === 1 || parsed.sync === 2) && parsed.inner;
			if (!appendable) { this.enqueue(() => raw(bytes)); return; }
			if (!body) { stats.unregisteredBody++; bump(stats.envelopeLessBinary, `${name}:unregistered`); this.enqueue(() => raw(bytes)); return; }
			const inner = parsed.inner!;
			const empty = inner.byteLength === 2 && inner[0] === 0 && inner[1] === 0;
			if (parsed.sync === 1 && (empty || options.envelopeStep2 === false)) {
				if (empty) stats.emptyStep2PassThrough++;
				bump(stats.envelopeLessBinary, empty ? "step2:empty" : "step2");
				this.flushBuffer(raw);
				this.enqueue(() => raw(bytes));
				return;
			}
			if (parsed.sync === 2 && debounceMs > 0) {
				if (this.buffer.length === 0) this.firstBufferedAt = now();
				this.buffer.push({ inner, at: now() });
				if (this.timer) clearTimeout(this.timer);
				const wait = Math.max(0, Math.min(debounceMs, this.firstBufferedAt + maxWaitMs - now()));
				this.timer = setTimeout(() => this.flushBuffer(raw), wait);
				return;
			}
			if (parsed.sync === 1) this.flushBuffer(raw);
			this.emit_(parsed.sync === 1 ? "step2" : "update", [{ inner, at: now() }], raw);
		}

		private flushBuffer(raw: (d: unknown) => void) {
			if (this.timer) { clearTimeout(this.timer); this.timer = null; }
			if (this.buffer.length === 0) return;
			const items = this.buffer;
			this.buffer = [];
			this.emit_("update", items, raw);
		}

		private enqueue(fn: () => void) {
			if (persist === "before-send") this.chain = this.chain.then(() => { if (this.readyState === WebSocket.OPEN) fn(); });
			else if (this.readyState === WebSocket.OPEN) fn();
		}

		/** Build candidate + envelope for one logical frame and send envelope+frame adjacently. */
		private emit_(kind: "update" | "step2", items: { inner: Uint8Array; at: number }[], raw: (d: unknown) => void) {
			const bodyId = this.bodyId!;
			const body = options.bodies.get(bodyId)!;
			const inner = items.length === 1 ? items[0]!.inner : Y.mergeUpdates(items.map((i) => i.inner));
			const frameBytes = syncFrame(kind === "step2" ? 1 : 2, inner);
			const payloadDigest = sha(inner);
			const candidateDigest = options.noCandidate ? null : sha(candidateDigestMaterial([inner]));
			const candidateId = options.noCandidate ? null : randomUUID();
			const clientFrameId = randomUUID();
			// State after the update: the provider sends from the doc "update" handler, so the doc already
			// contains it (and, when debounced, every buffered local update).
			const text = body.doc.getText("body").toString();
			const hash = contentHashOf(text);
			const envelope: Obj = { type: "BODY_UPDATE_ENVELOPE", bodyId, bodyEpoch: body.bodyEpoch, clientFrameId, payloadDigest,
				contentHash: hash.contentHash, size: hash.size,
				stateVector: Buffer.from(Y.encodeStateVector(body.doc)).toString("base64"), frameKind: kind };
			if (candidateId) Object.assign(envelope, { candidateId, candidateDigest });
			const frame: FrameRecord = { clientFrameId, candidateId, candidateDigest, payloadDigest, bodyId, kind,
				mergedUpdates: items.length, bytes: frameBytes.byteLength, firstLocalAt: items[0]!.at, persistedAt: null,
				sentAt: null, echoAt: null, settledAt: null, echo: null, outcome: "pending" };
			frames.push(frame);
			const record: Obj | null = candidateId ? {
				vaultId: options.vaultId, bodyId, bodyEpoch: body.bodyEpoch,
				previousBaseline: "", pendingMarkdown: text, candidateId, candidateDigest,
				encodedUpdate: inner.slice().buffer, capturedAt: Date.now(), capturedLocalUpdates: 0,
			} : null;
			const sendPair = () => {
				raw(`__YPS:${JSON.stringify(envelope)}`);
				raw(frameBytes);
				frame.sentAt = now();
				bump(stats.envelopesSent, kind);
				this.sentOrder.push(clientFrameId);
			};
			let persisted: Promise<void> = Promise.resolve();
			if (!record) { this.enqueue(sendPair); }
			else if (persist === "before-send") {
				persisted = options.database.putCandidate(record).then(() => { frame.persistedAt = now(); });
				this.chain = this.chain.then(() => persisted).then(() => { if (this.readyState === WebSocket.OPEN) sendPair(); },
					(e) => { frame.outcome = "settle_failed"; frame.error = `put: ${String(e)}`; });
			} else {
				if (this.readyState === WebSocket.OPEN) sendPair();
				persisted = options.database.putCandidate(record).then(() => { frame.persistedAt = now(); });
			}
			byFrameId.set(clientFrameId, { frame, record, persisted });
		}

		private async onControl(msg: Obj) {
			if (msg.type === "BODY_UPDATE_REJECTED") {
				stats.rejects.push(msg);
				const hit = typeof msg.clientFrameId === "string" ? byFrameId.get(msg.clientFrameId) : undefined;
				if (hit) hit.frame.outcome = "rejected";
				return;
			}
			if (msg.type === "VAULT_BACKPRESSURE") { stats.backpressure.push(msg); return; }
			if (msg.type !== "BODY_COMMITTED" || msg.bodyId !== this.bodyId || msg.relay !== true) return;
			if (msg.peer === true) { stats.peerCommits++; return; }
			if (typeof msg.clientFrameId !== "string") { stats.originCommitsWithoutFrameId++; return; }
			const hit = byFrameId.get(msg.clientFrameId);
			if (!hit) { stats.originCommitsWithoutFrameId++; return; }
			const { frame, record, persisted } = hit;
			frame.echoAt = now();
			frame.echo = { vaultSequence: msg.vaultSequence, durableGeneration: msg.durableGeneration, deduped: msg.deduped,
				noop: msg.noop, contentHashAccepted: msg.contentHashAccepted, commitRuntimeEpoch: msg.commitRuntimeEpoch };
			stats.echoesPaired++;
			if (this.sentOrder[0] === msg.clientFrameId) this.sentOrder.shift();
			else { stats.echoOutOfOrder++; this.sentOrder.splice(this.sentOrder.indexOf(msg.clientFrameId), 1); }
			if (msg.deduped === true) stats.dedupedEchoes++;
			if (msg.noop === true) stats.noopEchoes++;
			if (msg.contentHashAccepted === true) stats.hashAccepted++; else stats.hashNotAccepted++;
			if (msg.payloadDigest !== frame.payloadDigest || (record && (msg.candidateId !== frame.candidateId
				|| msg.candidateDigest !== frame.candidateDigest))) {
				stats.echoDigestMismatch++;
				frame.outcome = "digest_mismatch";
				return;
			}
			if (!record) { frame.outcome = "settled"; frame.settledAt = now(); return; }
			try {
				await persisted;
				const receipt = { vaultId: options.vaultId, vaultGeneration: String(msg.vaultGeneration ?? options.vaultGeneration),
					bodyId: frame.bodyId, bodyEpoch: Number(msg.bodyEpoch), clientId: options.deviceId,
					candidateId: frame.candidateId!, candidateDigest: frame.candidateDigest!,
					durableGeneration: Number(msg.durableGeneration),
					runtimeEpoch: String(msg.commitRuntimeEpoch ?? msg.runtimeEpoch) };
				// Same identity checks VaultSync.validateReceipt applies to an HTTP receipt.
				if (receipt.bodyEpoch !== record.bodyEpoch || !Number.isSafeInteger(receipt.durableGeneration) || !receipt.runtimeEpoch)
					throw new Error("receipt identity mismatch");
				if (options.database.confirmPendingCandidate) await options.database.confirmPendingCandidate(receipt);
				else await options.database.deleteCandidate(frame.bodyId, frame.candidateId!);
				frame.settledAt = now();
				frame.outcome = "settled";
				stats.settled++;
			} catch (e) {
				frame.outcome = "settle_failed"; frame.error = String(e); stats.settleFailures++;
			}
		}
	};
}

function toBytes(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return new Uint8Array(data as ArrayBuffer);
}

/** Pairing summary for reports. */
export function pairingSummary(stats: ReceiptStats, frames: FrameRecord[]) {
	const by = (o: FrameRecord["outcome"]) => frames.filter((f) => f.outcome === o).length;
	return {
		envelopesSent: stats.envelopesSent, envelopeLessBinary: stats.envelopeLessBinary,
		hits: stats.echoesPaired, misses: frames.filter((f) => f.sentAt !== null && f.echoAt === null).length,
		notSent: frames.filter((f) => f.sentAt === null).length,
		originCommitsWithoutFrameId: stats.originCommitsWithoutFrameId, echoDigestMismatch: stats.echoDigestMismatch,
		echoOutOfOrder: stats.echoOutOfOrder, deduped: stats.dedupedEchoes, noop: stats.noopEchoes,
		hashAccepted: stats.hashAccepted, hashNotAccepted: stats.hashNotAccepted,
		outcomes: { settled: by("settled"), pending: by("pending"), rejected: by("rejected"), digestMismatch: by("digest_mismatch"),
			settleFailed: by("settle_failed") },
		rejects: stats.rejects.slice(0, 20), backpressure: stats.backpressure.slice(0, 20), closes: stats.closes.slice(0, 20),
		emptyStep2PassThrough: stats.emptyStep2PassThrough, unregisteredBody: stats.unregisteredBody,
		framesOut: stats.framesOut, framesIn: stats.framesIn, bytesOut: stats.bytesOut, bytesIn: stats.bytesIn,
	};
}
