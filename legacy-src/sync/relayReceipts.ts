import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type { SocketSendData, SocketTap, SocketTapFactory } from "./fencedWebSocket";
import { sha256HexSync } from "../utils/sha256Sync";

/**
 * Socket-ack receipts for relay bodies (RFC relay-bodies §4.7, phase 2).
 *
 * The relay commits frames in groups: a frame is broadcast at once, and its
 * origin `BODY_COMMITTED` ("saved") receipt arrives only after the group
 * commit, typically 0.3–1.5 s later. A receipt is therefore never expected
 * quickly. Silence is treated as loss only after {@link RECEIPT_RESEND_MS},
 * and then the unconfirmed bytes are re-sent, which is idempotent because Yjs
 * updates are idempotent.
 *
 * Model (one channel per body session, one tap per socket):
 * - Every local Y.Doc update gets a monotonically increasing `seq`, and its
 *   bytes are kept in memory until confirmed. Durability across restarts is
 *   the existing IndexedDB candidate path; this log only drives re-sends.
 * - When a socket's VAULT_READY advertises `relayBodies >= 2`, the tap sets a
 *   sync point: it re-sends all unconfirmed bytes as one enveloped frame (the
 *   "resend on reconnect"). From then on every update frame is enveloped.
 * - The relay commits a socket's frames in order with no silent drops (an
 *   error closes the socket). A receipt for an enveloped frame sent at `seq`
 *   therefore proves every local update with seq <= that frame's seq durable:
 *   each was either in the sync-point frame or in a later frame on the same
 *   socket.
 * - Step2 frames and frames sent before the sync point are never enveloped,
 *   so an immediate empty-step2 no-op ack is never mistaken for a barrier.
 */

/** No receipt for this long after the newest confirmation or send: re-send. */
export const RECEIPT_RESEND_MS = 5_000;
/** Cap for the exponential re-send backoff. */
export const RECEIPT_RESEND_MAX_MS = 60_000;
/** Re-send delays are spread by ±20 % so reconnecting devices do not align. */
export const RECEIPT_RESEND_JITTER_RATIO = 0.2;
/** VAULT_READY `capabilities.relayBodies` version that pairs envelopes with receipts. */
export const RELAY_BODIES_RECEIPT_CAPABILITY = 2;
/** Above this many unconfirmed entries the log is merged into one entry. */
const MAX_UNCONFIRMED_ENTRIES = 64;

const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const CONTROL_PREFIX = "__YPS:";

export interface RelayReceiptInfo {
	readonly bodyId: string;
	readonly bodyEpoch: number;
	readonly vaultGeneration: string;
	readonly durableGeneration: number;
	readonly vaultSequence: number | null;
	readonly runtimeEpoch: string;
	readonly commitRuntimeEpoch: string | null;
	readonly clientFrameId: string;
	readonly deduped: boolean;
	readonly noop: boolean;
}

export interface RelayReceiptChannelOptions {
	readonly bodyId: string;
	readonly doc: Y.Doc;
	readonly bodyEpoch: () => number;
	/** False for remote-origin and server-origin transactions; true for local edits. */
	readonly isLocalOrigin: (origin: unknown) => boolean;
	/** Envelopes and receipts on (still gated by the server capability). Default true. */
	readonly receipts?: boolean;
	readonly resendBaseMs?: number;
	readonly resendMaxMs?: number;
	readonly jitterRatio?: number;
	readonly random?: () => number;
	readonly setTimer: (callback: () => void, delayMs: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
	readonly newFrameId: () => string;
	readonly onConfirmed?: (seq: number, info: RelayReceiptInfo) => void;
	/** Relay receipts became usable (true) or the socket that carried them closed (false). */
	readonly onRelayActiveChanged?: (active: boolean) => void;
	readonly log?: (message: string) => void;
}

export interface RelayReceiptDiagnostics {
	localSeq: number;
	confirmedSeq: number;
	unconfirmedEntries: number;
	framesInFlight: number;
	envelopesSent: number;
	receipts: number;
	resends: { timeout: number; reconnect: number };
	resendAttempt: number;
	relayActive: boolean;
}

interface SentFrame {
	readonly clientFrameId: string;
	readonly seq: number;
	readonly payloadDigest: string;
}

interface Entry {
	seq: number;
	update: Uint8Array;
}

function toBytes(data: SocketSendData): Uint8Array | null {
	if (typeof data === "string") return null;
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (typeof SharedArrayBuffer !== "undefined" && data instanceof SharedArrayBuffer) return new Uint8Array(data);
	return null;
}

/** y-protocols sync frame shape: `[messageType, syncType?, inner?]`. */
export function parseSyncFrame(bytes: Uint8Array): { type: number; sync: number | null; inner: Uint8Array | null } {
	try {
		const decoder = decoding.createDecoder(bytes);
		const type = decoding.readVarUint(decoder);
		if (type !== MESSAGE_SYNC) return { type, sync: null, inner: null };
		const sync = decoding.readVarUint(decoder);
		if (sync === SYNC_STEP_1) return { type, sync, inner: null };
		return { type, sync, inner: decoding.readVarUint8Array(decoder) };
	} catch {
		return { type: -1, sync: null, inner: null };
	}
}

export function encodeSyncUpdateFrame(inner: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	encoding.writeVarUint(encoder, SYNC_UPDATE);
	encoding.writeVarUint8Array(encoder, inner);
	return encoding.toUint8Array(encoder);
}

function isEmptyUpdate(update: Uint8Array): boolean {
	return update.byteLength === 0 || (update.byteLength === 2 && update[0] === 0 && update[1] === 0);
}

class RelayTap implements SocketTap {
	relay = false;
	syncPoint = false;
	closed = false;
	readonly frames: SentFrame[] = [];

	constructor(
		private readonly channel: RelayReceiptChannel,
		readonly raw: (data: SocketSendData) => boolean,
	) {}

	send(data: SocketSendData): void { this.channel.handleOutgoing(this, data); }
	onMessage(data: unknown): void { this.channel.handleIncoming(this, data); }
	beforeClose(): void {}
	onClose(): void { this.channel.handleClose(this); }
}

export class RelayReceiptChannel {
	private localSeq = 0;
	private confirmedSeqValue = 0;
	private entries: Entry[] = [];
	private current: RelayTap | null = null;
	private resendTimer: unknown = null;
	private resendAttempt = 0;
	private destroyed = false;
	private lastInfo: RelayReceiptInfo | null = null;
	private readonly stats = {
		envelopesSent: 0, receipts: 0, timeoutResends: 0, reconnectResends: 0,
	};
	private readonly observer = (update: Uint8Array, origin: unknown): void => {
		if (this.destroyed || !this.options.isLocalOrigin(origin)) return;
		this.localSeq++;
		this.entries.push({ seq: this.localSeq, update: update.slice() });
		if (this.entries.length > MAX_UNCONFIRMED_ENTRIES) {
			const last = this.entries[this.entries.length - 1]!;
			this.entries = [{ seq: last.seq, update: Y.mergeUpdates(this.entries.map((entry) => entry.update)) }];
		}
	};

	/** Construct before the provider so this observer runs before its update handler. */
	constructor(private readonly options: RelayReceiptChannelOptions) {
		options.doc.on("update", this.observer);
	}

	/** Pass as `fencedWebSocketConstructor(..., tapFactory)`; one tap per socket. */
	readonly tapFactory: SocketTapFactory = (raw) => {
		if (this.destroyed) return null;
		if (this.current && !this.current.closed) this.handleClose(this.current);
		const tap = new RelayTap(this, raw);
		this.current = tap;
		return tap;
	};

	get seq(): number { return this.localSeq; }
	get confirmedSeq(): number { return this.confirmedSeqValue; }
	get lastConfirmation(): RelayReceiptInfo | null { return this.lastInfo; }

	/** Receipts can currently confirm local updates on an open socket. */
	get relayActive(): boolean {
		const tap = this.current;
		return !this.destroyed && tap !== null && !tap.closed && tap.relay && tap.syncPoint && this.receiptsEnabled;
	}

	private get receiptsEnabled(): boolean { return this.options.receipts !== false; }

	diagnostics(): RelayReceiptDiagnostics {
		return {
			localSeq: this.localSeq,
			confirmedSeq: this.confirmedSeqValue,
			unconfirmedEntries: this.entries.length,
			framesInFlight: this.current?.frames.length ?? 0,
			envelopesSent: this.stats.envelopesSent,
			receipts: this.stats.receipts,
			resends: { timeout: this.stats.timeoutResends, reconnect: this.stats.reconnectResends },
			resendAttempt: this.resendAttempt,
			relayActive: this.relayActive,
		};
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.options.doc.off("update", this.observer);
		this.clearResendTimer();
		if (this.current) this.current.closed = true;
		this.current = null;
		this.entries = [];
	}

	handleOutgoing(tap: RelayTap, data: SocketSendData): void {
		if (tap !== this.current || tap.closed || this.destroyed) {
			tap.raw(data);
			return;
		}
		const bytes = toBytes(data);
		if (!bytes) {
			tap.raw(data);
			return;
		}
		const frame = parseSyncFrame(bytes);
		if (frame.type !== MESSAGE_SYNC) {
			tap.raw(data);
			return;
		}
		if (frame.sync !== SYNC_UPDATE || !frame.inner) {
			tap.raw(data);
			return;
		}
		this.emitUpdate(tap, frame.inner, "update", bytes);
	}

	handleIncoming(tap: RelayTap, data: unknown): void {
		if (this.destroyed || tap.closed || typeof data !== "string" || !data.startsWith(CONTROL_PREFIX)) return;
		let value: unknown;
		try { value = JSON.parse(data.slice(CONTROL_PREFIX.length)); } catch { return; }
		if (!value || typeof value !== "object") return;
		const frame = value as Record<string, unknown>;
		if (frame.type === "VAULT_READY") {
			this.handleReady(tap, frame);
		} else if (frame.type === "BODY_COMMITTED" && frame.relay === true && typeof frame.clientFrameId === "string") {
			this.handleReceipt(tap, frame);
		} else if (frame.type === "BODY_UPDATE_REJECTED" && typeof frame.clientFrameId === "string") {
			this.options.log?.(`relay frame ${frame.clientFrameId} for ${this.options.bodyId} rejected: ${String(frame.reason)}`);
		}
	}

	handleClose(tap: RelayTap): void {
		if (tap.closed) return;
		tap.closed = true;
		const wasActive = tap.relay && tap.syncPoint;
		if (this.current === tap) {
			this.clearResendTimer();
			if (wasActive && this.receiptsEnabled) this.options.onRelayActiveChanged?.(false);
		}
	}

	private handleReady(tap: RelayTap, frame: Record<string, unknown>): void {
		if (tap !== this.current || tap.relay || !this.receiptsEnabled) return;
		if (frame.documentId !== this.options.bodyId) return;
		const capabilities = frame.capabilities as Record<string, unknown> | undefined;
		const version = capabilities?.relayBodies;
		if (typeof version !== "number" || version < RELAY_BODIES_RECEIPT_CAPABILITY) return;
		tap.relay = true;
		tap.syncPoint = true;
		if (this.unconfirmed().length > 0) {
			this.stats.reconnectResends++;
			this.resend(tap, "reconnect");
		} else {
			this.confirmedSeqValue = Math.max(this.confirmedSeqValue, this.localSeq);
			this.entries = [];
		}
		this.options.onRelayActiveChanged?.(true);
	}

	private handleReceipt(tap: RelayTap, frame: Record<string, unknown>): void {
		const index = tap.frames.findIndex((sent) => sent.clientFrameId === frame.clientFrameId);
		if (index < 0) return;
		const sent = tap.frames[index]!;
		if (frame.bodyId !== this.options.bodyId) return;
		if (typeof frame.payloadDigest === "string" && frame.payloadDigest !== sent.payloadDigest) {
			this.options.log?.(`relay receipt digest mismatch for ${sent.clientFrameId}`);
			return;
		}
		if (typeof frame.durableGeneration !== "number" || !Number.isSafeInteger(frame.durableGeneration)
			|| typeof frame.vaultGeneration !== "string" || typeof frame.runtimeEpoch !== "string"
			|| !Number.isSafeInteger(frame.bodyEpoch)) return;
		this.stats.receipts++;
		// In-order commit: this receipt also settles every earlier frame on the socket.
		tap.frames.splice(0, index + 1);
		const info: RelayReceiptInfo = {
			bodyId: this.options.bodyId,
			bodyEpoch: frame.bodyEpoch as number,
			vaultGeneration: frame.vaultGeneration,
			durableGeneration: frame.durableGeneration,
			vaultSequence: Number.isSafeInteger(frame.vaultSequence) ? frame.vaultSequence as number : null,
			runtimeEpoch: frame.runtimeEpoch,
			commitRuntimeEpoch: typeof frame.commitRuntimeEpoch === "string" ? frame.commitRuntimeEpoch : null,
			clientFrameId: sent.clientFrameId,
			deduped: frame.deduped === true,
			noop: frame.noop === true,
		};
		this.lastInfo = info;
		this.resendAttempt = 0;
		this.clearResendTimer();
		if (sent.seq > this.confirmedSeqValue) {
			this.confirmedSeqValue = sent.seq;
			this.entries = this.entries.filter((entry) => entry.seq > sent.seq);
			this.options.onConfirmed?.(sent.seq, info);
		}
		this.armResend();
	}

	private unconfirmed(): Entry[] {
		return this.entries.filter((entry) => entry.seq > this.confirmedSeqValue);
	}

	private resend(tap: RelayTap, kind: "reconnect" | "timeout"): void {
		const pending = this.unconfirmed();
		if (pending.length === 0) return;
		const merged = pending.length === 1 ? pending[0]!.update : Y.mergeUpdates(pending.map((entry) => entry.update));
		if (isEmptyUpdate(merged)) return;
		this.emitUpdate(tap, merged, kind);
	}

	private emitUpdate(tap: RelayTap, inner: Uint8Array, kind: "update" | "reconnect" | "timeout",
		encoded?: Uint8Array): void {
		const frame = encoded ?? encodeSyncUpdateFrame(inner);
		if (!this.receiptsEnabled || !tap.relay || !tap.syncPoint || isEmptyUpdate(inner)) {
			tap.raw(frame);
			return;
		}
		const clientFrameId = this.options.newFrameId();
		const payloadDigest = sha256HexSync(inner);
		const envelope = {
			type: "BODY_UPDATE_ENVELOPE",
			bodyId: this.options.bodyId,
			bodyEpoch: this.options.bodyEpoch(),
			clientFrameId,
			payloadDigest,
			frameKind: kind,
		};
		// Envelope and frame back to back: nothing may interleave on the socket.
		if (!tap.raw(`${CONTROL_PREFIX}${JSON.stringify(envelope)}`)) return;
		if (!tap.raw(frame)) return;
		this.stats.envelopesSent++;
		tap.frames.push({ clientFrameId, seq: this.localSeq, payloadDigest });
		this.armResend();
	}

	private armResend(): void {
		if (this.resendTimer !== null || this.destroyed || this.unconfirmed().length === 0) return;
		const base = this.options.resendBaseMs ?? RECEIPT_RESEND_MS;
		const cap = this.options.resendMaxMs ?? RECEIPT_RESEND_MAX_MS;
		const ratio = this.options.jitterRatio ?? RECEIPT_RESEND_JITTER_RATIO;
		const random = this.options.random ?? Math.random;
		const backoff = Math.min(cap, base * 2 ** this.resendAttempt);
		const delay = Math.max(0, Math.round(backoff * (1 - ratio + 2 * ratio * random())));
		this.resendTimer = this.options.setTimer(() => {
			this.resendTimer = null;
			const tap = this.current;
			if (this.destroyed || !tap || !this.relayActive) return;
			if (this.unconfirmed().length === 0) return;
			this.resendAttempt++;
			this.stats.timeoutResends++;
			this.options.log?.(`relay receipt overdue for ${this.options.bodyId}; re-sending unconfirmed updates (attempt ${this.resendAttempt})`);
			this.resend(tap, "timeout");
			this.armResend();
		}, delay);
	}

	private clearResendTimer(): void {
		if (this.resendTimer === null) return;
		this.options.clearTimer(this.resendTimer);
		this.resendTimer = null;
	}
}
