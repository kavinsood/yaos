// Opaque streams: socket relay, group commit, receipts and HTTP reads
// (docs/client-remake/relay-wire.md). Streams are always on (DECISIONS §2.1).
// Depends only on ../ports; never imports a CRDT engine: payloads are opaque bytes.
//
// Write path: a binary APPEND is admitted (raw rate gate, authority, write
// capability, daily limit), broadcast at once as PROVISIONAL when its stream is
// b:/c:, and buffered. The vault-wide buffer commits in one transaction on
// idle / max age / bytes (StreamStore.commit assigns contiguous seqs in arrival
// order). After the commit: COMMITTED frames (or COMMIT_NOTICEs for sockets that
// already got the PROVISIONAL), then one STREAM_RECEIPTS per origin socket.
// Invariant: durable before receipt, and every seq is delivered live only after
// its commit.
import { bytesToBase64 } from "../base64url";
import { SYSTEM_CLOCK, SYSTEM_TIMERS, type ClockPort, type SocketPort, type SocketRegistryPort, type TimerPort } from "../ports";
import { BoundedBodyError, readBoundedBytes } from "../readBoundedBytes";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "../shared/socketCloseCodes";
import { SOCKET_LIVENESS_DESCRIPTOR, parseVaultPingFrame } from "../shared/socketLiveness";
import {
	MAX_CLIENT_FRAME_ID_BYTES,
	MAX_STREAM_BINARY_MESSAGE_BYTES,
	MAX_STREAM_CHECKPOINT_BYTES,
	MAX_STREAM_NAME_BYTES,
	MAX_STREAM_PAYLOAD_BYTES,
	MAX_STREAM_SOCKETS,
	MAX_STREAM_TEXT_MESSAGE_BYTES,
	STREAM_FEED_DEFAULT_LIMIT,
	STREAM_FEED_MAX_LIMIT,
	STREAM_READ_DEFAULT_BYTES,
	STREAM_READ_MAX_BYTES,
	STREAMS_CAPABILITY_VERSION,
	STREAMS_DOCUMENT_ID,
	bytesEqual,
	decodeAppendFrame,
	encodeCommitNotice,
	encodeCommitted,
	encodeProvisional,
	isProvisionalStream,
	validStreamName,
} from "./protocol";
import { frameKey, type StreamStore } from "./store";

// ---- configuration ----------------------------------------------------------

export interface StreamRelayConfig {
	/** Commit after this long without a new frame... */
	gcIdleMs: number;
	/** ...or this long after the first buffered frame... */
	gcMaxMs: number;
	/** ...or once the buffer holds this many payload bytes. */
	gcMaxBytes: number;
	/** Idle commits wait at least this long after the previous commit (0 = off). */
	gcMinIntervalMs: number;
	/** Per-socket raw admission token bucket (every received message, before parsing). */
	rateBytesPerSec: number;
	burstBytes: number;
	maxSockets: number;
}

export const DEFAULT_STREAM_RELAY_CONFIG: Readonly<StreamRelayConfig> = Object.freeze({
	gcIdleMs: 300,
	gcMaxMs: 1_500,
	gcMaxBytes: 64 * 1024,
	gcMinIntervalMs: 0,
	rateBytesPerSec: 256 * 1024,
	burstBytes: 2 * 1024 * 1024,
	maxSockets: MAX_STREAM_SOCKETS,
});

export interface StreamsEnv {
	YAOS_STREAMS_GC_IDLE_MS?: string;
	YAOS_STREAMS_GC_MAX_MS?: string;
	YAOS_STREAMS_GC_MAX_BYTES?: string;
	YAOS_STREAMS_GC_MIN_INTERVAL_MS?: string;
	YAOS_STREAMS_RATE_BYTES_PER_SEC?: string;
	YAOS_STREAMS_BURST_BYTES?: string;
	YAOS_STREAMS_MAX_SOCKETS?: string;
}

function readInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

export function readStreamRelayConfig(env: StreamsEnv | null | undefined): StreamRelayConfig {
	const d = DEFAULT_STREAM_RELAY_CONFIG;
	return {
		gcIdleMs: readInteger(env?.YAOS_STREAMS_GC_IDLE_MS, d.gcIdleMs, 0, 60_000),
		gcMaxMs: readInteger(env?.YAOS_STREAMS_GC_MAX_MS, d.gcMaxMs, 0, 60_000),
		gcMaxBytes: readInteger(env?.YAOS_STREAMS_GC_MAX_BYTES, d.gcMaxBytes, 1, 8 * 1024 * 1024),
		gcMinIntervalMs: readInteger(env?.YAOS_STREAMS_GC_MIN_INTERVAL_MS, d.gcMinIntervalMs, 0, 60_000),
		rateBytesPerSec: readInteger(env?.YAOS_STREAMS_RATE_BYTES_PER_SEC, d.rateBytesPerSec, 1024, 1 << 30),
		// The bucket must hold one maximum-size message, or such a message is refused forever.
		burstBytes: readInteger(env?.YAOS_STREAMS_BURST_BYTES, d.burstBytes, MAX_STREAM_BINARY_MESSAGE_BYTES, 1 << 30),
		maxSockets: readInteger(env?.YAOS_STREAMS_MAX_SOCKETS, d.maxSockets, 1, 32_768),
	};
}

// ---- actor and socket attachment ----------------------------------------------

/** VAULT_READY `role` (relay-wire §16): the type keeps "member"; only "owner" is sent (DECISIONS D6). */
export type VaultRole = "owner" | "member";

/** The identity a streams socket is admitted with (the D6 constants plus the device). */
export interface StreamActor {
	vaultId: string;
	vaultGeneration: string;
	principalId: string;
	membershipRevision: number;
	deviceId: string;
	deviceName?: string;
	deviceCredentialRevision: number;
	role: VaultRole;
	policyVersion: number;
	capabilityDigest: string;
}

export interface StreamSocketAttachment {
	kind: "streams";
	vaultId: string;
	vaultGeneration: string;
	runtimeEpoch: string;
	socketId: string;
	principalId: string;
	membershipRevision: number;
	deviceId: string;
	deviceName?: string;
	deviceCredentialRevision: number;
	role: VaultRole;
	policyVersion: number;
	capabilityDigest: string;
	canWrite: boolean;
	admittedAt: number;
}

export function parseStreamSocketAttachment(value: unknown): StreamSocketAttachment | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.kind !== "streams") return null;
	return typeof record.vaultId === "string" && typeof record.vaultGeneration === "string"
		&& typeof record.runtimeEpoch === "string" && typeof record.socketId === "string"
		&& typeof record.principalId === "string" && Number.isSafeInteger(record.membershipRevision)
		&& typeof record.deviceId === "string" && Number.isSafeInteger(record.deviceCredentialRevision)
		&& (record.role === "owner" || record.role === "member") && Number.isSafeInteger(record.policyVersion)
		&& typeof record.capabilityDigest === "string" && typeof record.canWrite === "boolean"
		&& Number.isSafeInteger(record.admittedAt)
		&& (record.deviceName === undefined || typeof record.deviceName === "string")
		? record as unknown as StreamSocketAttachment : null;
}

function actorOf(attachment: StreamSocketAttachment): StreamActor {
	return {
		vaultId: attachment.vaultId,
		vaultGeneration: attachment.vaultGeneration,
		principalId: attachment.principalId,
		membershipRevision: attachment.membershipRevision,
		deviceId: attachment.deviceId,
		...(attachment.deviceName ? { deviceName: attachment.deviceName } : {}),
		deviceCredentialRevision: attachment.deviceCredentialRevision,
		role: attachment.role,
		policyVersion: attachment.policyVersion,
		capabilityDigest: attachment.capabilityDigest,
	};
}

// ---- service ------------------------------------------------------------------

export interface StreamRelayOptions {
	config: StreamRelayConfig;
	/** Getter: the runtime replaces storage-bound objects on vault delete. */
	store: () => StreamStore;
	sockets: SocketRegistryPort;
	/** `__YPS:` control send with the host's decorateControl (D8 daily-limit typing). */
	sendControl: (socket: SocketPort, value: unknown) => void;
	/** The host's authority check (the vault DO: the actor's device is in the device map). */
	validateActor: (actor: StreamActor) => boolean;
	/** D8: the free-plan daily row limit is latched. */
	dailyLimitActive: () => boolean;
	/** D8: records a failed commit's error (latches the daily limit when it is one). */
	noteCommitError: (error: unknown) => void;
	vaultId: () => string;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	clock?: ClockPort;
	timers?: TimerPort;
}

/** R12-style raw admission gate of one socket. */
interface RawGate { tokens: number; at: number; refused: boolean }

interface Waiter { socket: SocketPort; socketId: string }

interface PendingFrame {
	key: string;
	stream: string;
	deviceId: string;
	clientFrameId: string;
	payload: Uint8Array;
	origin: Waiter;
	/** Resends of the same frame while it was pending: they get the same receipt. */
	duplicates: Waiter[];
	provisional: boolean;
	/** Socket ordinal at the PROVISIONAL broadcast: later sockets get COMMITTED instead of a notice. */
	ordinal: number;
}

export type StreamFlushReason = "idle" | "max" | "bytes" | "forced";

export interface StreamRelayCounters {
	appendFrames: number;
	commits: number;
	committedRows: number;
	storeDedupes: number;
	pendingDedupes: number;
	conflicts: number;
	commitFailures: number;
	flushIdle: number;
	flushMax: number;
	flushBytes: number;
	flushForced: number;
	provisionalBroadcasts: number;
	committedBroadcasts: number;
	notices: number;
	rateCloses: number;
	oversizeCloses: number;
	rawDrops: number;
	authorityCloses: number;
	dailyLimitRejects: number;
	wakeNotices: number;
}

export type StreamReceipt = { stream: string; clientFrameId: string; seq: number; deduped: boolean };

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
	return Response.json(body, { status, ...(headers ? { headers } : {}) });
}

function nonNegativeInteger(raw: string | null, fallback: number): number | null {
	if (raw === null || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

export class StreamRelayService {
	readonly config: StreamRelayConfig;
	readonly counters: StreamRelayCounters = {
		appendFrames: 0, commits: 0, committedRows: 0, storeDedupes: 0, pendingDedupes: 0, conflicts: 0,
		commitFailures: 0, flushIdle: 0, flushMax: 0, flushBytes: 0, flushForced: 0, provisionalBroadcasts: 0,
		committedBroadcasts: 0, notices: 0, rateCloses: 0, oversizeCloses: 0, rawDrops: 0, authorityCloses: 0,
		dailyLimitRejects: 0, wakeNotices: 0,
	};
	private readonly clock: ClockPort;
	private readonly timers: TimerPort;
	private readonly gates = new WeakMap<object, RawGate>();
	private readonly attachments = new WeakMap<object, StreamSocketAttachment | null>();
	private readonly ordinals = new WeakMap<object, number>();
	private socketOrdinal = 0;
	private pending: PendingFrame[] = [];
	private pendingBytes = 0;
	private readonly pendingByKey = new Map<string, PendingFrame>();
	private idleTimer: unknown = null;
	private maxTimer: unknown = null;
	private lastCommitAt = Number.NEGATIVE_INFINITY;
	private wakeChecked = false;

	constructor(private readonly options: StreamRelayOptions) {
		this.config = options.config;
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.timers = options.timers ?? SYSTEM_TIMERS;
	}

	private now(): number {
		return this.clock.now();
	}

	private attachmentOf(socket: SocketPort): StreamSocketAttachment | null {
		if (this.attachments.has(socket)) return this.attachments.get(socket)!;
		let attachment: StreamSocketAttachment | null = null;
		try { attachment = parseStreamSocketAttachment(socket.deserializeAttachment()); } catch { /* closed */ }
		this.attachments.set(socket, attachment);
		return attachment;
	}

	/** Whether `socket` is a streams socket (the runtime routes its messages here). */
	owns(socket: SocketPort): boolean {
		return this.attachmentOf(socket) !== null;
	}

	private streamSockets(): Array<{ socket: SocketPort; attachment: StreamSocketAttachment }> {
		const result: Array<{ socket: SocketPort; attachment: StreamSocketAttachment }> = [];
		for (const socket of this.options.sockets.sockets()) {
			const attachment = this.attachmentOf(socket);
			if (attachment) result.push({ socket, attachment });
		}
		return result;
	}

	head(): number {
		return this.options.store().head();
	}

	limits() {
		return {
			maxStreamNameBytes: MAX_STREAM_NAME_BYTES,
			maxClientFrameIdBytes: MAX_CLIENT_FRAME_ID_BYTES,
			maxPayloadBytes: MAX_STREAM_PAYLOAD_BYTES,
			maxBinaryMessageBytes: MAX_STREAM_BINARY_MESSAGE_BYTES,
			maxTextMessageBytes: MAX_STREAM_TEXT_MESSAGE_BYTES,
			maxCheckpointBytes: MAX_STREAM_CHECKPOINT_BYTES,
			feedDefaultLimit: STREAM_FEED_DEFAULT_LIMIT,
			feedMaxLimit: STREAM_FEED_MAX_LIMIT,
			readDefaultBytes: STREAM_READ_DEFAULT_BYTES,
			readMaxBytes: STREAM_READ_MAX_BYTES,
			rateBytesPerSec: this.config.rateBytesPerSec,
			burstBytes: this.config.burstBytes,
			groupCommit: { idleMs: this.config.gcIdleMs, maxMs: this.config.gcMaxMs, maxBytes: this.config.gcMaxBytes,
				minIntervalMs: this.config.gcMinIntervalMs },
		};
	}

	// ---- accept -----------------------------------------------------------

	/** Accepts an authorized streams socket upgrade (the host has verified the ticket and the device). */
	accept(actor: StreamActor, canWrite: boolean): Response {
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		if (this.streamSockets().length >= this.config.maxSockets) {
			return json({ error: "stream_socket_limit" }, 429, { "Retry-After": "1" });
		}
		this.ensureWakeNotice();
		const pair = this.options.sockets.createPair();
		const server = pair.server;
		const now = this.now();
		const attachment: StreamSocketAttachment = {
			kind: "streams",
			vaultId: this.options.vaultId(),
			vaultGeneration: this.options.vaultGeneration(),
			runtimeEpoch: this.options.runtimeEpoch,
			socketId: crypto.randomUUID(),
			principalId: actor.principalId,
			membershipRevision: actor.membershipRevision,
			deviceId: actor.deviceId,
			...(actor.deviceName ? { deviceName: actor.deviceName } : {}),
			deviceCredentialRevision: actor.deviceCredentialRevision,
			role: actor.role,
			policyVersion: actor.policyVersion,
			capabilityDigest: actor.capabilityDigest,
			canWrite,
			admittedAt: now,
		};
		server.serializeAttachment(attachment);
		this.options.sockets.accept(server);
		this.attachments.set(server, attachment);
		this.ordinals.set(server, ++this.socketOrdinal);
		this.options.sendControl(server, {
			type: "VAULT_READY",
			documentId: STREAMS_DOCUMENT_ID,
			socketSessionId: attachment.socketId,
			vaultId: attachment.vaultId,
			vaultGeneration: attachment.vaultGeneration,
			vaultEpoch: attachment.vaultGeneration,
			runtimeEpoch: attachment.runtimeEpoch,
			head: this.head(),
			liveness: SOCKET_LIVENESS_DESCRIPTOR,
			capabilities: { streams: STREAMS_CAPABILITY_VERSION },
			limits: this.limits(),
			canWrite,
			principalId: actor.principalId,
			deviceId: actor.deviceId,
			role: actor.role,
			membershipRevision: actor.membershipRevision,
			deviceCredentialRevision: actor.deviceCredentialRevision,
			policyVersion: actor.policyVersion,
			capabilityDigest: actor.capabilityDigest,
		});
		return this.options.sockets.upgradeResponse(pair.client);
	}

	/**
	 * Once per runtime: streams sockets admitted by an earlier runtime (hibernation
	 * wake, or an eviction that may have dropped buffered frames) are told to
	 * resend every unacknowledged append. Resends are deduplicated.
	 */
	ensureWakeNotice(): void {
		if (this.wakeChecked) return;
		this.wakeChecked = true;
		let head: number | null = null;
		for (const { socket, attachment } of this.streamSockets()) {
			if (attachment.runtimeEpoch === this.options.runtimeEpoch) continue;
			const updated = { ...attachment, runtimeEpoch: this.options.runtimeEpoch };
			try { socket.serializeAttachment(updated); } catch { continue; }
			this.attachments.set(socket, updated);
			head ??= this.head();
			this.options.sendControl(socket, { type: "STREAM_RESEND", reason: "runtime_restarted",
				runtimeEpoch: this.options.runtimeEpoch, head });
			this.counters.wakeNotices++;
		}
	}

	// ---- messages -----------------------------------------------------------

	message(socket: SocketPort, message: string | ArrayBuffer): void {
		const attachment = this.attachmentOf(socket);
		if (!attachment) { try { socket.close(1008, "not a streams socket"); } catch { /* closed */ } return; }
		if (!this.charge(socket, message)) return;
		this.ensureWakeNotice();
		if (typeof message === "string") this.control(socket, attachment, message);
		else this.append(socket, attachment, new Uint8Array(message));
	}

	/**
	 * Raw admission: charges the received size (bytes for binary, UTF-16 units for
	 * text) before any parsing. An oversize message closes 1009; an overdraft
	 * sends VAULT_BACKPRESSURE and closes 1013. Either way every later message of
	 * the socket is dropped in O(1). Frames buffered before still commit.
	 */
	private charge(socket: SocketPort, message: string | ArrayBuffer): boolean {
		let gate = this.gates.get(socket);
		const now = this.now();
		if (!gate) {
			gate = { tokens: this.config.burstBytes, at: now, refused: false };
			this.gates.set(socket, gate);
		}
		if (gate.refused) { this.counters.rawDrops++; return false; }
		const size = typeof message === "string" ? message.length : message.byteLength;
		const max = typeof message === "string" ? MAX_STREAM_TEXT_MESSAGE_BYTES : MAX_STREAM_BINARY_MESSAGE_BYTES;
		gate.tokens = Math.min(this.config.burstBytes, gate.tokens + (Math.max(0, now - gate.at) * this.config.rateBytesPerSec) / 1000);
		gate.at = now;
		if (size <= max && gate.tokens >= size) {
			gate.tokens -= size;
			return true;
		}
		gate.refused = true;
		if (size > max) {
			this.counters.oversizeCloses++;
			try { socket.close(1009, "message exceeds stream admission limit"); } catch { /* closed */ }
		} else {
			this.counters.rateCloses++;
			this.options.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" });
			try { socket.close(1013, "relay rate limit"); } catch { /* closed */ }
		}
		return false;
	}

	private authorityHolds(socket: SocketPort, attachment: StreamSocketAttachment): boolean {
		if (this.options.validateActor(actorOf(attachment))) return true;
		this.counters.authorityCloses++;
		this.options.sendControl(socket, { type: "error", code: "authority_superseded", reason: "socket authority superseded" });
		try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "socket authority superseded"); } catch { /* closed */ }
		return false;
	}

	private control(socket: SocketPort, attachment: StreamSocketAttachment, message: string): void {
		if (!message.startsWith("__YPS:")) return;
		let value: unknown;
		try { value = JSON.parse(message.slice(6)); } catch { return; }
		const ping = parseVaultPingFrame(value);
		if (!ping) return;
		if (!this.authorityHolds(socket, attachment)) return;
		this.options.sendControl(socket, {
			type: "VAULT_PONG",
			probeId: ping.probeId,
			documentId: STREAMS_DOCUMENT_ID,
			vaultGeneration: attachment.vaultGeneration,
			runtimeEpoch: this.options.runtimeEpoch,
			head: this.head(),
		});
	}

	private reject(socket: SocketPort, stream: string, clientFrameId: string, code: string, extra: Record<string, unknown> = {}): void {
		this.options.sendControl(socket, { type: "STREAM_APPEND_REJECTED", stream, clientFrameId, code, ...extra });
	}

	private append(socket: SocketPort, attachment: StreamSocketAttachment, bytes: Uint8Array): void {
		const frame = decodeAppendFrame(bytes);
		if ("error" in frame) {
			const code = frame.error === "payload_too_large" ? 1009 : 1008;
			try { socket.close(code, `stream frame rejected: ${frame.error}`); } catch { /* closed */ }
			return;
		}
		this.counters.appendFrames++;
		if (!attachment.canWrite) { this.reject(socket, frame.stream, frame.clientFrameId, "write_forbidden"); return; }
		if (!this.authorityHolds(socket, attachment)) return;
		const waiter = { socket, socketId: attachment.socketId };
		const key = frameKey(attachment.deviceId, frame.clientFrameId);
		const pending = this.pendingByKey.get(key);
		if (pending) {
			if (pending.stream === frame.stream && bytesEqual(pending.payload, frame.payload)) {
				this.counters.pendingDedupes++;
				pending.duplicates.push(waiter);
			} else {
				this.counters.conflicts++;
				this.reject(socket, frame.stream, frame.clientFrameId, "client_frame_id_conflict");
			}
			return;
		}
		if (this.options.dailyLimitActive()) {
			// D8: decorateControl types this as cf_daily_limit with resetAt.
			this.counters.dailyLimitRejects++;
			this.options.sendControl(socket, { type: "VAULT_ERROR", code: "durability_failed",
				message: "append was not committed; resend after the daily limit resets",
				stream: frame.stream, clientFrameIds: [frame.clientFrameId] });
			return;
		}
		const provisional = isProvisionalStream(frame.stream);
		const entry: PendingFrame = { key, stream: frame.stream, deviceId: attachment.deviceId,
			clientFrameId: frame.clientFrameId, payload: frame.payload, origin: waiter, duplicates: [],
			provisional, ordinal: this.socketOrdinal };
		if (provisional) {
			const message = encodeProvisional({ stream: frame.stream, deviceId: attachment.deviceId,
				clientFrameId: frame.clientFrameId, payload: frame.payload });
			for (const peer of this.streamSockets()) {
				if (peer.attachment.socketId === attachment.socketId) continue;
				try { peer.socket.send(message); this.counters.provisionalBroadcasts++; } catch { /* closed */ }
			}
		}
		this.pending.push(entry);
		this.pendingByKey.set(key, entry);
		this.pendingBytes += frame.payload.byteLength;
		this.schedule();
	}

	private schedule(): void {
		if (this.pendingBytes >= this.config.gcMaxBytes) { this.flush("bytes"); return; }
		if (this.maxTimer === null) this.maxTimer = this.timers.set(() => { this.maxTimer = null; this.flush("max"); }, this.config.gcMaxMs);
		if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
		const wait = Math.max(this.config.gcIdleMs, this.lastCommitAt + this.config.gcMinIntervalMs - this.now());
		this.idleTimer = this.timers.set(() => { this.idleTimer = null; this.flush("idle"); }, wait);
	}

	private clearTimers(): void {
		if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
		if (this.maxTimer !== null) this.timers.clear(this.maxTimer);
		this.idleTimer = null;
		this.maxTimer = null;
	}

	pendingFrames(): number {
		return this.pending.length;
	}

	/** Commits the buffer now, synchronously (authority fences, drain, restart). */
	flushForAuthorityFence(): void {
		this.flush("forced");
	}

	/** Commits every buffered frame in one transaction, then sends broadcasts and receipts. */
	flush(reason: StreamFlushReason): void {
		const frames = this.pending;
		this.clearTimers();
		if (frames.length === 0) return;
		this.pending = [];
		this.pendingBytes = 0;
		this.pendingByKey.clear();
		if (reason === "idle") this.counters.flushIdle++;
		else if (reason === "max") this.counters.flushMax++;
		else if (reason === "bytes") this.counters.flushBytes++;
		else this.counters.flushForced++;
		let outcomes;
		try {
			outcomes = this.options.store().commit(frames).outcomes;
		} catch (error) {
			this.counters.commitFailures++;
			this.options.noteCommitError(error);
			console.warn("[yaos-streams] commit failed", error instanceof Error ? error.message : String(error));
			this.failed(frames);
			return;
		}
		this.lastCommitAt = this.now();
		this.counters.commits++;
		const sockets = this.streamSockets();
		const receipts = new Map<string, { socket: SocketPort; receipts: StreamReceipt[] }>();
		const addReceipt = (waiter: Waiter, receipt: StreamReceipt) => {
			let entry = receipts.get(waiter.socketId);
			if (!entry) { entry = { socket: waiter.socket, receipts: [] }; receipts.set(waiter.socketId, entry); }
			entry.receipts.push(receipt);
		};
		for (let index = 0; index < frames.length; index++) {
			const frame = frames[index]!;
			const outcome = outcomes[index]!;
			const identity = { stream: frame.stream, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId };
			if (outcome.kind === "conflict") {
				this.counters.conflicts++;
				this.reject(frame.origin.socket, frame.stream, frame.clientFrameId, "client_frame_id_conflict", { seq: outcome.seq });
				for (const duplicate of frame.duplicates) {
					this.reject(duplicate.socket, frame.stream, frame.clientFrameId, "client_frame_id_conflict", { seq: outcome.seq });
				}
				if (frame.provisional) this.dropProvisional(sockets, frame, "client_frame_id_conflict");
				continue;
			}
			const seq = outcome.seq;
			if (outcome.kind === "appended") this.counters.committedRows++;
			else this.counters.storeDedupes++;
			// Live delivery: rows appended now go to every other socket (notice for those
			// that hold the PROVISIONAL); a row deduped against an earlier commit was
			// delivered then, so only holders of the new PROVISIONAL get a notice.
			let committed: Uint8Array | null = null;
			let notice: Uint8Array | null = null;
			for (const peer of sockets) {
				if (peer.attachment.socketId === frame.origin.socketId) continue;
				const sawProvisional = frame.provisional && (this.ordinals.get(peer.socket) ?? 0) <= frame.ordinal;
				try {
					if (sawProvisional) {
						notice ??= encodeCommitNotice({ ...identity, seq });
						peer.socket.send(notice);
						this.counters.notices++;
					} else if (outcome.kind === "appended") {
						committed ??= encodeCommitted({ ...identity, seq, payload: frame.payload });
						peer.socket.send(committed);
						this.counters.committedBroadcasts++;
					}
				} catch { /* closed */ }
			}
			const receipt = { stream: frame.stream, clientFrameId: frame.clientFrameId, seq, deduped: outcome.kind === "deduped" };
			addReceipt(frame.origin, receipt);
			for (const duplicate of frame.duplicates) addReceipt(duplicate, { ...receipt, deduped: true });
		}
		const head = this.head();
		for (const entry of receipts.values()) {
			this.options.sendControl(entry.socket, { type: "STREAM_RECEIPTS", head, receipts: entry.receipts });
		}
	}

	private dropProvisional(sockets: ReadonlyArray<{ socket: SocketPort; attachment: StreamSocketAttachment }>,
		frame: PendingFrame, reason: string): void {
		for (const peer of sockets) {
			if (peer.attachment.socketId === frame.origin.socketId) continue;
			if ((this.ordinals.get(peer.socket) ?? 0) > frame.ordinal) continue;
			this.options.sendControl(peer.socket, { type: "STREAM_PROVISIONAL_DROPPED", stream: frame.stream,
				deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, reason });
		}
	}

	/** A failed commit: nothing was written. Origins resend; holders of PROVISIONALs drop them. */
	private failed(frames: readonly PendingFrame[]): void {
		const sockets = this.streamSockets();
		const byOrigin = new Map<string, { socket: SocketPort; streams: Map<string, string[]> }>();
		for (const frame of frames) {
			for (const waiter of [frame.origin, ...frame.duplicates]) {
				let entry = byOrigin.get(waiter.socketId);
				if (!entry) { entry = { socket: waiter.socket, streams: new Map() }; byOrigin.set(waiter.socketId, entry); }
				const ids = entry.streams.get(frame.stream) ?? [];
				ids.push(frame.clientFrameId);
				entry.streams.set(frame.stream, ids);
			}
			if (frame.provisional) this.dropProvisional(sockets, frame, "commit_failed");
		}
		for (const entry of byOrigin.values()) {
			for (const [stream, clientFrameIds] of entry.streams) {
				this.options.sendControl(entry.socket, { type: "VAULT_ERROR", code: "durability_failed",
					message: "append was not committed; resend", stream, clientFrameIds });
			}
		}
	}

	// ---- authority ------------------------------------------------------------

	closeDevice(deviceId: string): number {
		return this.closeWhere((attachment) => attachment.deviceId === deviceId, "device authority changed");
	}

	closePrincipal(principalId: string): number {
		return this.closeWhere((attachment) => attachment.principalId === principalId, "membership revoked");
	}

	private closeWhere(match: (attachment: StreamSocketAttachment) => boolean, reason: string): number {
		let closed = 0;
		for (const { socket, attachment } of this.streamSockets()) {
			if (!match(attachment)) continue;
			this.options.sendControl(socket, { type: "error", code: "authority_superseded", reason });
			try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, reason); } catch { /* fenced durably */ }
			closed++;
		}
		return closed;
	}

	socketClosed(socket: SocketPort): void {
		this.gates.delete(socket);
	}

	/** Drops the buffer unacked (vault wipe; TEST-ONLY relay-crash simulation). Returns the dropped frame count. */
	dropPending(): number {
		const dropped = this.pending.length;
		this.clearTimers();
		this.pending = [];
		this.pendingBytes = 0;
		this.pendingByKey.clear();
		return dropped;
	}

	/** Vault storage was wiped: drop the buffer unacked and every cached fact. */
	reset(): void {
		this.dropPending();
		this.options.store().reset();
	}

	diagnostics() {
		return { pendingFrames: this.pending.length, pendingBytes: this.pendingBytes, head: this.head(),
			counters: { ...this.counters }, tables: this.options.store().tableCounts() };
	}

	// ---- HTTP -----------------------------------------------------------------

	/** GET /streams/feed?after=S&limit=N */
	feed(url: URL): Response {
		const after = nonNegativeInteger(url.searchParams.get("after"), 0);
		const limit = nonNegativeInteger(url.searchParams.get("limit"), STREAM_FEED_DEFAULT_LIMIT);
		if (after === null) return json({ error: "invalid_cursor" }, 400);
		if (limit === null || limit < 1) return json({ error: "invalid_limit" }, 400);
		const page = this.options.store().feed(after, Math.min(limit, STREAM_FEED_MAX_LIMIT));
		return json({ vaultEpoch: this.options.vaultGeneration(), ...page });
	}

	/** GET /streams/read?stream=X&after=S&maxBytes=B&checkpoint=1 */
	read(url: URL): Response {
		const stream = url.searchParams.get("stream");
		if (!validStreamName(stream)) return json({ error: "invalid_stream" }, 400);
		const after = nonNegativeInteger(url.searchParams.get("after"), 0);
		const maxBytes = nonNegativeInteger(url.searchParams.get("maxBytes"), STREAM_READ_DEFAULT_BYTES);
		if (after === null) return json({ error: "invalid_cursor" }, 400);
		if (maxBytes === null || maxBytes < 1) return json({ error: "invalid_max_bytes" }, 400);
		const page = this.options.store().read(stream, after, Math.min(maxBytes, STREAM_READ_MAX_BYTES),
			url.searchParams.get("checkpoint") === "1");
		return json({
			vaultEpoch: this.options.vaultGeneration(),
			head: this.head(),
			stream: page.stream,
			lastSeq: page.lastSeq,
			checkpointSeq: page.checkpointSeq,
			gcSeq: page.gcSeq,
			checkpoint: page.checkpoint ? { coversSeq: page.checkpoint.coversSeq, bytes: bytesToBase64(page.checkpoint.bytes) } : null,
			rows: page.rows.map((row) => ({ seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId,
				payload: bytesToBase64(row.payload) })),
			nextAfter: page.nextAfter,
		});
	}

	/** PUT /streams/checkpoint?stream=X&coversSeq=N&expectedCoversSeq=M, body = opaque checkpoint bytes. */
	async putCheckpoint(request: Request, url: URL): Promise<Response> {
		const stream = url.searchParams.get("stream");
		if (!validStreamName(stream)) return json({ error: "invalid_stream" }, 400);
		const coversSeq = nonNegativeInteger(url.searchParams.get("coversSeq"), -1);
		const expected = nonNegativeInteger(url.searchParams.get("expectedCoversSeq"), -1);
		if (coversSeq === null || coversSeq < 1) return json({ error: "invalid_covers_seq" }, 400);
		if (expected === null || expected < 0) return json({ error: "invalid_expected_covers_seq" }, 400);
		let bytes: Uint8Array;
		try { bytes = await readBoundedBytes(request, MAX_STREAM_CHECKPOINT_BYTES, { allowEmpty: true }); }
		catch (error) {
			const kind = error instanceof BoundedBodyError ? error.kind : "body_read_failed";
			return json({ error: kind }, kind === "body_too_large" ? 413 : 400);
		}
		const result = this.options.store().putCheckpoint(stream, coversSeq, expected, bytes);
		if (!result.ok) {
			const { ok: _ok, status, ...body } = result;
			return json(body, status);
		}
		return json({ stream, coversSeq: result.coversSeq, gcSeq: result.gcSeq, deletedSegments: result.deletedSegments });
	}
}
