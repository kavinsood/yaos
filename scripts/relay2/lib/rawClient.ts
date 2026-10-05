/**
 * Raw body-socket client (y-protocols framing + `__YPS:` control frames) with a real Y.Doc,
 * adapted from the v1 harness. Relay-specific wire additions go through a ProtocolAdapter so
 * the same scenarios run against flag-off (base) and relay deploys.
 */
import { createHash, randomBytes } from "node:crypto";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket, { type RawData } from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../../legacy-src/sync/schema";
import { canonicalMarkdownBytes } from "../../../server/src/shared/markdownCodec";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { fetchSocketTicket, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { now, r2, sleep } from "./common";

export type Control = Record<string, unknown>;

/** Sync-message subtype of an outgoing binary frame. */
export type SyncKind = "step1" | "step2" | "update";

export interface OutgoingUpdate {
	kind: Exclude<SyncKind, "step1">;
	/** Inner Yjs update bytes (the payload of the sync message). */
	update: Uint8Array;
	/** Client-assigned id; relay echoes it in BODY_COMMITTED. */
	clientFrameId: string;
	/** Text of the client doc after applying `update` (source of contentHash/size). */
	text: string;
}

export interface ProtocolAdapter {
	readonly name: string;
	/** Extra socket URL params (e.g. capability flags). */
	socketParams?(url: URL): void;
	/**
	 * Text frame(s) to send immediately before the binary frame. Must be synchronous so the
	 * envelope and its update stay adjacent on the socket (WS preserves order).
	 */
	envelope(client: RawClient, frame: OutgoingUpdate): string[];
	/** Is this control frame the origin's commit acknowledgement? */
	isAck(control: Control, client: RawClient): boolean;
	/** Echoed client frame id in an ack, if the protocol has one. */
	ackFrameId(control: Control): string | null;
	/** Acks without an echoed frame id never satisfy waitAck (relay: unpaired envelope = no receipt). */
	requireEcho?: boolean;
}

export function contentHashOf(text: string): { contentHash: string; size: number } {
	const bytes = canonicalMarkdownBytes(text);
	return { contentHash: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

/** Flag-off production protocol: no envelope; debounced BODY_COMMITTED for this body is the ack. */
export const baseAdapter: ProtocolAdapter = {
	name: "base",
	envelope: () => [],
	isAck: (c, client) => c.type === "BODY_COMMITTED" && (c.bodyId === undefined || c.bodyId === client.body),
	ackFrameId: () => null,
};

/**
 * Relay v2 adapter, per docs/relay2-protocol.md §3.2/§4.1: a `__YPS:` BODY_UPDATE_ENVELOPE text frame
 * immediately before each binary step2/update. payloadDigest = sha256 hex of the INNER update bytes.
 * stateVector (client SV after applying) is included by default because the server records
 * contentHash/size only when it equals the merged SV after the append (D6 currentness).
 * The origin ack is the relay BODY_COMMITTED (relay:true) echoing clientFrameId.
 */
export function relayAdapter(options: { envelopeType?: string; includeStateVector?: boolean; includeCandidate?: boolean } = {}): ProtocolAdapter {
	const type = options.envelopeType ?? process.env.RELAY2_ENVELOPE_TYPE ?? "BODY_UPDATE_ENVELOPE";
	const sv = options.includeStateVector ?? true;
	const cand = options.includeCandidate ?? true;
	return {
		name: `relay:${type}${sv ? "" : ":nosv"}${cand ? "" : ":nocand"}`,
		requireEcho: true,
		envelope(client, frame) {
			const { contentHash, size } = contentHashOf(frame.text);
			const digest = createHash("sha256").update(frame.update).digest("hex");
			const value: Control = {
				type, bodyId: client.body, bodyEpoch: client.bodyEpoch, clientFrameId: frame.clientFrameId,
				payloadDigest: digest, contentHash, size, frameKind: frame.kind,
			};
			if (cand) { value.candidateId = frame.clientFrameId; value.candidateDigest = digest; }
			if (sv) value.stateVector = Buffer.from(Y.encodeStateVector(client.doc)).toString("base64");
			return [`__YPS:${JSON.stringify(value)}`];
		},
		isAck: (c, client) => c.type === "BODY_COMMITTED" && c.relay === true
			&& (c.bodyId === undefined || c.bodyId === client.body),
		ackFrameId: (c) => typeof c.clientFrameId === "string" ? c.clientFrameId : null,
	};
}

export function adapterFor(name: string | undefined): ProtocolAdapter {
	if (!name || name === "base") return baseAdapter;
	if (name === "relay" || name === "relay-sv") return relayAdapter();
	if (name === "relay-nosv") return relayAdapter({ includeStateVector: false });
	if (name === "relay-nocand") return relayAdapter({ includeCandidate: false });
	throw new Error(`unknown adapter ${name}`);
}

function rawBytes(data: RawData): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export type OpenResult = { status: "ok" } | { status: "error"; httpStatus?: number; message: string };

/** `[0,0]`: an empty Yjs v1 update (handshake step2 with nothing missing); the server skips it without counting. */
function isEmptyUpdate(update: Uint8Array) { return update.byteLength === 0 || (update.byteLength === 2 && update[0] === 0 && update[1] === 0); }

/**
 * Close codes after which a resilient client does NOT reconnect: the server refused this client/frame
 * for a reason a resend cannot fix (epoch fence, authority, too large, body inactive / socket authority).
 */
const TERMINAL_CLOSE_CODES = new Set([4409, 4403, 1008, 1009]);

/** Our (server) 1013 reasons; any other 1013 (e.g. "Service overloaded", empty) is Cloudflare platform shedding. */
const SERVER_1013_REASONS = ["relay rate limit", "semantic compaction pressure", "body cache budget exceeded", "pending durability budget exceeded"];
export function closeOrigin(code: number, reason: string): string {
	if (code === 1013) return SERVER_1013_REASONS.some((r) => reason.includes(r)) ? "server-backpressure" : "cloudflare-platform";
	if (code === 1011) return reason.includes("relay frame error") ? "server-frame-error" : "server-internal";
	if (code === 1006) return "abnormal (no close frame)";
	if (code === 4409) return "epoch-fence";
	if (code === 4403) return "authority";
	if (code === 1009) return "too-large";
	if (code === 1008) return "policy (body inactive / socket authority)";
	if (code === 1000 || code === 1005) return "normal";
	return "other";
}

type OutFrame = { clientFrameId: string; kind: "update" | "step2"; texts: string[]; frame: Uint8Array; nonEmpty: boolean; createdAt: number; lastSentAt?: number };

/** Every RawClient created in this process (connection-event report for the scenario JSON). */
export const ALL_CLIENTS: RawClient[] = [];

export class RawClient {
	socket!: WebSocket;
	bytesIn = 0;
	bytesOut = 0;
	framesIn = 0;
	framesOut = 0;
	updatesIn = 0;
	updateBytesIn = 0;
	closed: { code: number; reason: string; at: number; wall: number } | null = null;
	readyAt = 0;
	syncedAt = 0;
	openAt = 0;
	startedAt = 0;
	ticketAt = 0;
	/** HTTP 101 received (upgrade complete, before the ws 'open' callback). */
	upgradeAt = 0;
	/** Wall clock when our step1 was sent (tail join). */
	step1SentWall = 0;
	/** First inbound frame (any type) after open. */
	firstFrameAt = 0;
	/** Size of the server step2 (reply to our step1) as received. */
	step2Bytes = 0;
	runtimeEpoch: unknown = null;
	controls: Array<{ at: number; value: Control }> = [];
	sent: Array<{ at: number; clientFrameId: string; kind: SyncKind; bytes: number; resend?: boolean }> = [];
	updateListeners: Array<(at: number, update: Uint8Array) => void> = [];
	controlListeners: Array<(value: Control, at: number) => void> = [];
	/** Acks (per adapter) with arrival time and echoed frame id. */
	acks: Array<{ at: number; frameId: string | null; value: Control }> = [];
	/** BODY_UPDATE_REJECTED / VAULT_BACKPRESSURE / error control frames (relay failure signals). */
	rejects: Array<{ at: number; value: Control }> = [];
	closeListeners: Array<(code: number, reason: string) => void> = [];
	/** When false, local doc updates are not forwarded (used for offline edits). */
	forwardLocal = true;
	keepControls = true;
	/**
	 * Resilient mode (round 3): on an unexpected close, reconnect with backoff, resync (our step1 + our step2
	 * answering the server step1), then resend every unacked frame (relay: original envelope + bytes, same
	 * clientFrameId, so candidate dedupe re-acks it) or every frame queued while not open (base). Frames are
	 * never silently skipped: while not open they are queued (resilient) or counted in `droppedWhileClosed`.
	 */
	reconnect = false;
	maxReconnectAttempts = 30;
	/** Every socket close (client- or server-initiated) with its time and connection number. */
	closeLog: Array<{ conn: number; code: number; reason: string; at: number; wall: number; byClient: boolean; origin: string }> = [];
	/** Socket/open errors and VAULT_ERROR / BODY_UPDATE_REJECTED controls. */
	errorLog: Array<{ conn: number; at: number; wall: number; message: string }> = [];
	reconnects: Array<{ afterCode: number; at: number; wall: number; ok: boolean; attempts: number; ms: number; resent: number; error?: string }> = [];
	/** Relay: sent-but-unacked frames (insertion order). Base: frames queued while not open. */
	private outbox = new Map<string, OutFrame>();
	connectionNo = 0;
	/** Non-empty update/step2 frames actually written to a socket (incl. resends): compare with server `updateFrames`. */
	nonEmptyFramesSent = 0;
	updateFramesSent = 0;
	resentFrames = 0;
	queuedWhileClosed = 0;
	droppedWhileClosed = 0;
	lastFrame: { clientFrameId: string; at: number; queued: boolean } | null = null;
	private userClosing = false;
	private reconnectPromise: Promise<boolean> | null = null;
	/**
	 * Relay v3 client resend emulation (RelayReceiptChannel RECEIPT_RESEND_MS): an unacked frame whose last send is
	 * older than `resendAfterMs` is resent (same envelope / clientFrameId) while the socket is open. 0 = off.
	 */
	resendAfterMs = 0;
	private resendTimer: ReturnType<typeof setInterval> | null = null;
	timeoutResends = 0;

	constructor(
		readonly identity: LiveIdentity,
		readonly body: string,
		readonly doc = new Y.Doc({ guid: body }),
		readonly adapter: ProtocolAdapter = baseAdapter,
		readonly bodyEpoch = 1,
	) {
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === this || !this.forwardLocal) return;
			// Never skip silently: sendSyncFrame queues (resilient) or counts the drop when not open.
			if (this.socket) this.sendUpdate(update);
		});
		ALL_CLIENTS.push(this);
	}

	/** Frames awaiting an echoed ack (relay) or queued for the next connection (base). */
	get unacked() { return this.outbox.size; }
	get reconnecting() { return this.reconnectPromise !== null; }
	/** Resolves when an in-flight reconnect finishes (true = open). */
	async settled(): Promise<boolean> { return this.reconnectPromise ? this.reconnectPromise : this.isOpen; }

	get isOpen() { return this.socket?.readyState === WebSocket.OPEN; }

	/** Send an update frame (envelope first per adapter). Returns the client frame id. */
	sendUpdate(update: Uint8Array, presetFrameId?: string): string {
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, 0);
		syncProtocol.writeUpdate(e, update);
		return this.sendSyncFrame("update", update, encoding.toUint8Array(e), presetFrameId);
	}

	private ensureResendTimer() {
		if (this.resendAfterMs <= 0 || this.resendTimer) return;
		this.resendTimer = setInterval(() => {
			if (!this.isOpen || this.adapter.requireEcho !== true) return;
			const t = now();
			for (const f of this.outbox.values()) {
				if (t - (f.lastSentAt ?? f.createdAt) < this.resendAfterMs) continue;
				this.timeoutResends++;
				this.writeFrame(f, true);
			}
		}, 250);
		(this.resendTimer as unknown as { unref?: () => void }).unref?.();
	}

	/** Send a pre-encoded sync frame carrying `update`, preceded by the adapter's envelope. */
	sendSyncFrame(kind: "update" | "step2", update: Uint8Array, frame: Uint8Array, presetFrameId?: string): string {
		const clientFrameId = presetFrameId ?? `f-${randomBytes(6).toString("hex")}`;
		const texts = this.adapter.envelope(this, { kind, update, clientFrameId, text: this.text() });
		const out: OutFrame = { clientFrameId, kind, texts, frame, nonEmpty: !isEmptyUpdate(update), createdAt: now() };
		const tracked = this.adapter.requireEcho === true;
		if (!this.isOpen) {
			// A handshake step2 is regenerated by the next connection's resync; only updates are queued.
			if (kind === "update" && (this.reconnect || this.reconnectPromise)) {
				this.outbox.set(clientFrameId, out);
				this.queuedWhileClosed++;
				this.lastFrame = { clientFrameId, at: out.createdAt, queued: true };
			} else if (kind === "update") this.droppedWhileClosed++;
			return clientFrameId;
		}
		if (tracked && out.nonEmpty) this.outbox.set(clientFrameId, out);
		this.writeFrame(out, false);
		return clientFrameId;
	}

	private writeFrame(out: OutFrame, resend: boolean) {
		for (const text of out.texts) this.send(text);
		const at = now();
		out.lastSentAt = at;
		if (this.resendAfterMs > 0) this.ensureResendTimer();
		this.sent.push({ at, clientFrameId: out.clientFrameId, kind: out.kind, bytes: out.frame.byteLength, ...(resend ? { resend: true } : {}) });
		if (this.sent.length > 20_000) this.sent.splice(0, 10_000);
		this.send(out.frame);
		this.updateFramesSent++;
		if (out.nonEmpty) this.nonEmptyFramesSent++;
		if (resend) this.resentFrames++;
		else this.lastFrame = { clientFrameId: out.clientFrameId, at, queued: false };
	}

	/** After a (re)connect: relay resends unacked frames (same ids); base flushes frames queued while closed. */
	private flushOutbox(): number {
		const tracked = this.adapter.requireEcho === true;
		const frames = [...this.outbox.values()];
		if (!tracked) this.outbox.clear();
		for (const f of frames) { if (!this.isOpen) break; this.writeFrame(f, true); }
		return frames.length;
	}

	private scheduleReconnect(code: number) {
		if (this.reconnectPromise) return;
		const started = now();
		this.reconnectPromise = (async () => {
			let attempts = 0;
			let lastError = "";
			while (!this.userClosing && attempts < this.maxReconnectAttempts) {
				attempts++;
				// Platform shedding / our backpressure: back off longer.
				const base = code === 1013 ? 1000 : 250;
				await sleep(Math.min(base * 2 ** Math.min(attempts - 1, 5), 8000));
				if (this.userClosing) break;
				const o = await this.openSocket(30_000);
				if (o.status === "ok") {
					const resent = this.flushOutbox();
					this.reconnects.push({ afterCode: code, at: r2(now()), wall: Date.now(), ok: true, attempts, ms: r2(now() - started), resent });
					return true;
				}
				lastError = o.message.slice(0, 200);
				if (this.closed && TERMINAL_CLOSE_CODES.has(this.closed.code)) break;
			}
			this.reconnects.push({ afterCode: code, at: r2(now()), wall: Date.now(), ok: false, attempts, ms: r2(now() - started), resent: 0, error: lastError || (this.userClosing ? "closed by client" : "gave up") });
			return false;
		})().finally(() => { this.reconnectPromise = null; });
	}

	/** Connection events for the scenario JSON. */
	connectionReport() {
		return { body: this.body, device: this.identity.deviceId, adapter: this.adapter.name, connections: this.connectionNo,
			closes: this.closeLog, errors: this.errorLog.slice(0, 50), errorCount: this.errorLog.length, reconnects: this.reconnects,
			unacked: this.adapter.requireEcho === true ? this.outbox.size : null, queuedForNextConnection: this.adapter.requireEcho === true ? null : this.outbox.size,
			updateFramesSent: this.updateFramesSent, nonEmptyFramesSent: this.nonEmptyFramesSent, resentFrames: this.resentFrames,
			queuedWhileClosed: this.queuedWhileClosed, droppedWhileClosed: this.droppedWhileClosed,
			...(this.resendAfterMs > 0 ? { resendAfterMs: this.resendAfterMs, timeoutResends: this.timeoutResends } : {}) };
	}

	/** True when this client lost its connection other than by its own close(). */
	get lostConnection() { return this.closeLog.some((c) => !c.byClient) || this.droppedWhileClosed > 0; }

	send(data: Uint8Array | string) {
		this.bytesOut += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
		this.framesOut++;
		this.socket.send(data);
	}

	transportBytes() {
		const t = this.socket as unknown as { _socket?: { bytesRead: number; bytesWritten: number } };
		return { read: t._socket?.bytesRead ?? null, written: t._socket?.bytesWritten ?? null };
	}

	/** Resolves once VAULT_READY and the server's step2 (answer to our step1) have arrived. */
	async open(timeoutMs = 20_000): Promise<OpenResult> {
		this.userClosing = false;
		const o = await this.openSocket(timeoutMs);
		if (o.status === "ok" && this.reconnect && this.outbox.size > 0) this.flushOutbox();
		return o;
	}

	private async openSocket(timeoutMs: number): Promise<OpenResult> {
		this.startedAt = now();
		this.closed = null;
		this.readyAt = 0;
		this.syncedAt = 0;
		this.upgradeAt = 0;
		this.firstFrameAt = 0;
		this.step2Bytes = 0;
		let ticket: string;
		try { ticket = (await fetchSocketTicket(this.identity, this.identity.vaultId, "body", this.body, this.bodyEpoch)).ticket; }
		catch (error) { return { status: "error", message: String(error) }; }
		this.ticketAt = now();
		const url = new URL(vaultRoute(this.identity, `ws/body/${encodeURIComponent(this.body)}`));
		url.protocol = url.protocol === "http:" ? "ws:" : "wss:"; // local wrangler dev is plain http
		url.searchParams.set("ticket", ticket);
		url.searchParams.set("schemaVersion", String(SCHEMA_VERSION));
		url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
		this.adapter.socketParams?.(url);
		const conn = ++this.connectionNo;
		const socket = new WebSocket(url.toString());
		this.socket = socket;
		return new Promise((resolve) => {
			let done = false;
			const finish = (v: OpenResult) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
			const timer = setTimeout(() => finish({ status: "error", message: "timeout" }), timeoutMs);
			this.socket.on("upgrade", () => { this.upgradeAt = now(); });
			this.socket.on("open", () => {
				this.openAt = now();
				this.step1SentWall = Date.now();
				const e = encoding.createEncoder();
				encoding.writeVarUint(e, 0);
				syncProtocol.writeSyncStep1(e, this.doc);
				this.send(encoding.toUint8Array(e));
			});
			this.socket.on("unexpected-response", (_req, res) => {
				let body = "";
				res.on("data", (c: Buffer) => { body += c.toString(); });
				res.on("end", () => finish({ status: "error", httpStatus: res.statusCode, message: body.slice(0, 300) }));
			});
			this.socket.on("error", (error) => {
				this.errorLog.push({ conn, at: r2(now()), wall: Date.now(), message: String(error).slice(0, 300) });
				finish({ status: "error", message: String(error) });
			});
			this.socket.on("close", (code, reason) => {
				const text = reason.toString();
				this.closed = { code, reason: text, at: now(), wall: Date.now() };
				const byClient = this.userClosing;
				this.closeLog.push({ conn, code, reason: text, at: r2(this.closed.at), wall: this.closed.wall, byClient, origin: closeOrigin(code, text) });
				for (const l of this.closeListeners) l(code, text);
				finish({ status: "error", message: `closed ${code} ${reason}` });
				// Only the current socket drives reconnects (an old socket closing late must not).
				if (socket === this.socket && done && this.reconnect && !byClient && !TERMINAL_CLOSE_CODES.has(code) && this.readyAt) this.scheduleReconnect(code);
			});
			this.socket.on("message", (data, isBinary) => {
				const at = now();
				const bytes = rawBytes(data);
				this.framesIn++;
				this.bytesIn += bytes.byteLength;
				if (!this.firstFrameAt) this.firstFrameAt = at;
				if (!isBinary) {
					const text = Buffer.from(bytes).toString("utf8");
					if (!text.startsWith("__YPS:")) return;
					let value: Control;
					try { value = JSON.parse(text.slice(6)); } catch { return; }
					if (this.keepControls) this.controls.push({ at, value });
					if (this.controls.length > 20_000) this.controls.splice(0, 10_000);
					if (value.type === "BODY_UPDATE_REJECTED" || value.type === "VAULT_BACKPRESSURE" || value.type === "error" || value.type === "VAULT_ERROR") {
						this.rejects.push({ at, value });
						if (value.type !== "VAULT_BACKPRESSURE") this.errorLog.push({ conn, at: r2(at), wall: Date.now(), message: JSON.stringify(value).slice(0, 300) });
						if (this.rejects.length > 5000) this.rejects.splice(0, 2500);
					}
					if (value.type === "VAULT_READY") { this.readyAt = at; this.runtimeEpoch = value.runtimeEpoch ?? null; }
					if (this.adapter.isAck(value, this)) {
						const fid = this.adapter.ackFrameId(value);
						if (fid) this.outbox.delete(fid);
						this.acks.push({ at, frameId: fid, value });
						if (this.acks.length > 20_000) this.acks.splice(0, 10_000);
					}
					for (const l of [...this.controlListeners]) l(value, at);
					if (this.readyAt && this.syncedAt) finish({ status: "ok" });
					return;
				}
				const d = decoding.createDecoder(bytes);
				if (decoding.readVarUint(d) !== 0) return;
				const peek = decoding.createDecoder(bytes.subarray(d.pos));
				const syncType = decoding.readVarUint(peek);
				const inner = syncType === 1 || syncType === 2 ? decoding.readVarUint8Array(peek) : null;
				const reply = encoding.createEncoder();
				encoding.writeVarUint(reply, 0);
				syncProtocol.readSyncMessage(d, reply, this.doc, this);
				// Reply to a server step1 with our step2 through the adapter (envelope-aware).
				if (encoding.length(reply) > 1) {
					const frame = encoding.toUint8Array(reply);
					if (syncType === 0) {
						const r = decoding.createDecoder(frame);
						decoding.readVarUint(r); decoding.readVarUint(r);
						this.sendSyncFrame("step2", decoding.readVarUint8Array(r), frame);
					} else this.send(frame);
				}
				if (syncType === 1 && !this.syncedAt) { this.syncedAt = at; this.step2Bytes = bytes.byteLength; }
				if (syncType === 2 && inner) {
					this.updatesIn++;
					this.updateBytesIn += inner.byteLength;
					for (const l of [...this.updateListeners]) l(at, inner);
				}
				if (this.readyAt && this.syncedAt) finish({ status: "ok" });
			});
		});
	}

	/**
	 * Per-phase open timing (ms, relative): ticket (HTTP), upgrade (TLS/WS 101), step1→step2 (server build + transfer
	 * of the full step2 message; ws delivers whole messages, so transfer is not separable here), ready.
	 */
	openPhases() {
		const rel = (a: number, b: number) => (a && b ? r2(a - b) : null);
		return { ticketMs: rel(this.ticketAt, this.startedAt), upgradeMs: rel(this.upgradeAt || this.openAt, this.ticketAt),
			openCallbackMs: rel(this.openAt, this.upgradeAt), firstFrameAfterOpenMs: rel(this.firstFrameAt, this.openAt),
			step1ToStep2Ms: rel(this.syncedAt, this.openAt), readyAfterOpenMs: rel(this.readyAt, this.openAt),
			totalMs: rel(Math.max(this.syncedAt, this.readyAt), this.startedAt), step2Bytes: this.step2Bytes,
			step1SentWall: this.step1SentWall };
	}

	text() { return this.doc.getText("body").toString(); }
	stateVector() { return Y.encodeStateVector(this.doc); }

	/** Local edit whose update is sent by the doc listener. */
	edit(fn: (text: Y.Text) => void) { this.doc.transact(() => fn(this.doc.getText("body"))); }

	/** Apply a pre-encoded update locally (not re-sent) and send it. */
	applyAndSend(update: Uint8Array): string {
		Y.applyUpdate(this.doc, update, this);
		return this.sendUpdate(update);
	}

	async close() {
		if (this.resendTimer) { clearInterval(this.resendTimer); this.resendTimer = null; }
		this.userClosing = true;
		if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => { this.socket.terminate(); resolve(); }, 500);
			this.socket.once("close", () => { clearTimeout(t); resolve(); });
			this.socket.close();
		});
	}

	terminate() {
		if (this.resendTimer) { clearInterval(this.resendTimer); this.resendTimer = null; }
		this.userClosing = true; this.socket?.terminate();
	}

	/** Relay acks in send order: index of the first unacked non-empty frame and whether any LATER frame was acked. */
	ackPrefixCheck() {
		const acked = new Set(this.acks.map((a) => a.frameId).filter(Boolean));
		const sent = this.sent.filter((s) => !s.resend && s.kind === "update");
		const firstUnacked = sent.findIndex((s) => !acked.has(s.clientFrameId));
		const ackedAfter = firstUnacked < 0 ? [] : sent.slice(firstUnacked + 1).filter((s) => acked.has(s.clientFrameId));
		return { sent: sent.length, acked: sent.filter((s) => acked.has(s.clientFrameId)).length, firstUnacked,
			ackedAfterFirstUnacked: ackedAfter.length, prefix: ackedAfter.length === 0 };
	}

	waitUpdate(timeoutMs: number): Promise<number | null> {
		return new Promise((resolve) => {
			const t = setTimeout(() => { this.updateListeners = this.updateListeners.filter((l) => l !== l2); resolve(null); }, timeoutMs);
			const l2 = (at: number) => { clearTimeout(t); this.updateListeners = this.updateListeners.filter((l) => l !== l2); resolve(at); };
			this.updateListeners.push(l2);
		});
	}

	waitControl(pred: (v: Control) => boolean, timeoutMs: number): Promise<{ at: number; value: Control } | null> {
		return new Promise((resolve) => {
			const t = setTimeout(() => { this.controlListeners = this.controlListeners.filter((l) => l !== l2); resolve(null); }, timeoutMs);
			const l2 = (v: Control, at: number) => {
				if (!pred(v)) return;
				clearTimeout(t); this.controlListeners = this.controlListeners.filter((l) => l !== l2); resolve({ at, value: v });
			};
			this.controlListeners.push(l2);
		});
	}

	/** Local edit (sent via the doc listener); returns the frame id and send time. */
	editTracked(fn: (text: Y.Text) => void): { frameId: string; sentAt: number } {
		const before = this.lastFrame;
		this.edit(fn);
		const last = this.lastFrame;
		// A frame queued during a reconnect counts from its creation (latency includes the outage).
		if (!last || last === before) throw new Error(`edit produced no frame (socket closed; dropped=${this.droppedWhileClosed})`);
		return { frameId: last.clientFrameId, sentAt: last.at };
	}

	/**
	 * Wait for the origin ack of `frameId`. With an echoing protocol the ack must carry the id;
	 * otherwise (base) the first ack arriving after `since` counts.
	 */
	async waitAck(frameId: string, since: number, timeoutMs: number): Promise<{ at: number; value: Control } | null> {
		const strict = this.adapter.requireEcho === true;
		const matches = (a: { at: number; frameId: string | null }) => a.frameId === null ? !strict && a.at >= since : a.frameId === frameId;
		const seen = this.acks.find(matches);
		if (seen) return seen;
		return this.waitControl((v) => {
			if (!this.adapter.isAck(v, this)) return false;
			const echoed = this.adapter.ackFrameId(v);
			return echoed === null ? !strict : echoed === frameId;
		}, timeoutMs);
	}

	waitClose(timeoutMs: number): Promise<{ code: number; reason: string; at: number } | null> {
		if (this.closed) return Promise.resolve(this.closed);
		return new Promise((resolve) => {
			const t = setTimeout(() => { this.closeListeners = this.closeListeners.filter((l) => l !== l2); resolve(null); }, timeoutMs);
			const l2 = (code: number, reason: string) => { clearTimeout(t); resolve({ code, reason, at: now() }); };
			this.closeListeners.push(l2);
		});
	}

	/** Wait until our doc text satisfies `pred`. */
	async waitText(pred: (text: string) => boolean, timeoutMs: number): Promise<number | null> {
		if (pred(this.text())) return now();
		return new Promise((resolve) => {
			const t = setTimeout(() => { this.doc.off("update", h); resolve(null); }, timeoutMs);
			const h = () => { if (pred(this.text())) { clearTimeout(t); this.doc.off("update", h); resolve(now()); } };
			this.doc.on("update", h);
		});
	}
}
