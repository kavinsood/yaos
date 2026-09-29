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
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../../src/sync/schema";
import { canonicalMarkdownBytes } from "../../../server/src/shared/markdownCodec";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { fetchSocketTicket, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { now } from "./common";

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
	runtimeEpoch: unknown = null;
	controls: Array<{ at: number; value: Control }> = [];
	sent: Array<{ at: number; clientFrameId: string; kind: SyncKind; bytes: number }> = [];
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

	constructor(
		readonly identity: LiveIdentity,
		readonly body: string,
		readonly doc = new Y.Doc({ guid: body }),
		readonly adapter: ProtocolAdapter = baseAdapter,
		readonly bodyEpoch = 1,
	) {
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === this || !this.forwardLocal) return;
			if (this.socket?.readyState === WebSocket.OPEN) this.sendUpdate(update);
		});
	}

	get isOpen() { return this.socket?.readyState === WebSocket.OPEN; }

	/** Send an update frame (envelope first per adapter). Returns the client frame id. */
	sendUpdate(update: Uint8Array): string {
		const e = encoding.createEncoder();
		encoding.writeVarUint(e, 0);
		syncProtocol.writeUpdate(e, update);
		return this.sendSyncFrame("update", update, encoding.toUint8Array(e));
	}

	/** Send a pre-encoded sync frame carrying `update`, preceded by the adapter's envelope. */
	sendSyncFrame(kind: "update" | "step2", update: Uint8Array, frame: Uint8Array): string {
		const clientFrameId = `f-${randomBytes(6).toString("hex")}`;
		for (const text of this.adapter.envelope(this, { kind, update, clientFrameId, text: this.text() })) this.send(text);
		this.sent.push({ at: now(), clientFrameId, kind, bytes: frame.byteLength });
		if (this.sent.length > 20_000) this.sent.splice(0, 10_000);
		this.send(frame);
		return clientFrameId;
	}

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
		this.startedAt = now();
		this.closed = null;
		this.readyAt = 0;
		this.syncedAt = 0;
		let ticket: string;
		try { ticket = (await fetchSocketTicket(this.identity, this.identity.vaultId, "body", this.body, this.bodyEpoch)).ticket; }
		catch (error) { return { status: "error", message: String(error) }; }
		this.ticketAt = now();
		const url = new URL(vaultRoute(this.identity, `ws/body/${encodeURIComponent(this.body)}`));
		url.protocol = "wss:";
		url.searchParams.set("ticket", ticket);
		url.searchParams.set("schemaVersion", String(SCHEMA_VERSION));
		url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
		this.adapter.socketParams?.(url);
		this.socket = new WebSocket(url.toString());
		return new Promise((resolve) => {
			let done = false;
			const finish = (v: OpenResult) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
			const timer = setTimeout(() => finish({ status: "error", message: "timeout" }), timeoutMs);
			this.socket.on("open", () => {
				this.openAt = now();
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
			this.socket.on("error", (error) => finish({ status: "error", message: String(error) }));
			this.socket.on("close", (code, reason) => {
				this.closed = { code, reason: reason.toString(), at: now(), wall: Date.now() };
				for (const l of this.closeListeners) l(code, reason.toString());
				finish({ status: "error", message: `closed ${code} ${reason}` });
			});
			this.socket.on("message", (data, isBinary) => {
				const at = now();
				const bytes = rawBytes(data);
				this.framesIn++;
				this.bytesIn += bytes.byteLength;
				if (!isBinary) {
					const text = Buffer.from(bytes).toString("utf8");
					if (!text.startsWith("__YPS:")) return;
					let value: Control;
					try { value = JSON.parse(text.slice(6)); } catch { return; }
					if (this.keepControls) this.controls.push({ at, value });
					if (this.controls.length > 20_000) this.controls.splice(0, 10_000);
					if (value.type === "BODY_UPDATE_REJECTED" || value.type === "VAULT_BACKPRESSURE" || value.type === "error") {
						this.rejects.push({ at, value });
						if (this.rejects.length > 5000) this.rejects.splice(0, 2500);
					}
					if (value.type === "VAULT_READY") { this.readyAt = at; this.runtimeEpoch = value.runtimeEpoch ?? null; }
					if (this.adapter.isAck(value, this)) {
						this.acks.push({ at, frameId: this.adapter.ackFrameId(value), value });
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
				if (syncType === 1 && !this.syncedAt) this.syncedAt = at;
				if (syncType === 2 && inner) {
					this.updatesIn++;
					this.updateBytesIn += inner.byteLength;
					for (const l of [...this.updateListeners]) l(at, inner);
				}
				if (this.readyAt && this.syncedAt) finish({ status: "ok" });
			});
		});
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
		if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => { this.socket.terminate(); resolve(); }, 500);
			this.socket.once("close", () => { clearTimeout(t); resolve(); });
			this.socket.close();
		});
	}

	terminate() { this.socket?.terminate(); }

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
		const before = this.sent.length;
		this.edit(fn);
		const last = this.sent.at(-1);
		if (this.sent.length === before || !last) throw new Error("edit produced no frame (socket closed?)");
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
