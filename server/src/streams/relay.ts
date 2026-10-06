// Opaque streams: socket relay, group commit, receipts and HTTP reads
// (docs/client-remake/relay-wire.md). Streams are always on (DECISIONS §2.1).
// Depends only on ../ports; never imports a CRDT engine: payloads are opaque bytes.
//
// Write path: a binary APPEND is admitted (authority, per-device raw rate gate,
// write capability, daily limit), broadcast at once as PROVISIONAL when its stream is
// b:/c:, and buffered. The vault-wide buffer commits in one transaction on
// idle / max age / bytes (StreamStore.commit assigns contiguous seqs in arrival
// order); a frame that opens a buffer after a quiet spell commits after the short
// lead window instead of the idle window. After the commit: COMMITTED frames (or COMMIT_NOTICEs for sockets that
// already got the PROVISIONAL), then one STREAM_RECEIPTS per origin socket.
// Invariant: durable before receipt, and every seq is delivered live only after
// its commit. H2 fallback: a stream's frames commit only once its dedupe index
// is built; builds advance one bounded step per incoming message and per timer
// flush (StreamStore.stepDedupe).
import { bytesToBase64 } from "../base64url";
import { dailyLimitControl, dailyLimitKind, dailyLimitResponse, isCloudflareDailyLimitError, type DailyLimitKind } from "../dailyLimit";
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
	MAX_STREAM_SOCKETS_PER_DEVICE,
	MAX_STREAM_TEXT_MESSAGE_BYTES,
	STREAM_FEED_DEFAULT_LIMIT,
	STREAM_FEED_MAX_LIMIT,
	STREAM_READ_BATCH_MAX_STREAMS,
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
import { frameKey, type StreamAppendOutcome, type StreamReadPage, type StreamStore } from "./store";

// ---- configuration ----------------------------------------------------------

export interface StreamRelayConfig {
	/** Commit after this long without a new frame... */
	gcIdleMs: number;
	/** ...or this long after the first buffered frame... */
	gcMaxMs: number;
	/** ...or once the buffer holds this many payload bytes. */
	gcMaxBytes: number;
	/** Idle commits wait at least this long after the previous commit (H8; 0 = off). */
	gcMinIntervalMs: number;
	/**
	 * Leading edge: a frame that finds the buffer empty and no commit in the last gcQuietMs commits (with whatever
	 * joins it) after gcLeadMs instead of gcIdleMs, so an isolated edit is not held for the idle window. A burst pays
	 * at most one extra commit (2 rows per stream it touches) at its start; at most one lead commit per gcQuietMs.
	 * gcQuietMs 0 = off.
	 */
	gcLeadMs: number;
	gcQuietMs: number;
	/** H6: per-device raw admission token bucket, shared by the device's sockets (every received message, before parsing). */
	rateBytesPerSec: number;
	burstBytes: number;
	maxSockets: number;
}

export const DEFAULT_STREAM_RELAY_CONFIG: Readonly<StreamRelayConfig> = Object.freeze({
	gcIdleMs: 300,
	gcMaxMs: 1_500,
	gcMaxBytes: 64 * 1024,
	gcMinIntervalMs: 1_000,
	gcLeadMs: 20,
	gcQuietMs: 1_500,
	rateBytesPerSec: 256 * 1024,
	burstBytes: 2 * 1024 * 1024,
	maxSockets: MAX_STREAM_SOCKETS,
});

export interface StreamsEnv {
	YAOS_STREAMS_GC_IDLE_MS?: string;
	YAOS_STREAMS_GC_MAX_MS?: string;
	YAOS_STREAMS_GC_MAX_BYTES?: string;
	YAOS_STREAMS_GC_MIN_INTERVAL_MS?: string;
	YAOS_STREAMS_GC_LEAD_MS?: string;
	YAOS_STREAMS_GC_QUIET_MS?: string;
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
		gcLeadMs: readInteger(env?.YAOS_STREAMS_GC_LEAD_MS, d.gcLeadMs, 0, 60_000),
		gcQuietMs: readInteger(env?.YAOS_STREAMS_GC_QUIET_MS, d.gcQuietMs, 0, 3_600_000),
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
	/** `__YPS:` control send of `value` as is (the relay types its own frames, H3). */
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
	/** H3 retry jitter source in [0, 1) (default Math.random). */
	random?: () => number;
}

/** H6 raw admission bucket of one device. */
interface DeviceBucket { tokens: number; at: number }

/** H5 cache entry: the attachment parsed once per runtime and the actor the device map is checked with. */
interface CachedSocket { attachment: StreamSocketAttachment; actor: StreamActor }

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
	/** H2: a flush held it back while its stream's index builds; its bytes no longer count toward the bytes trigger. */
	held: boolean;
}

export type StreamFlushReason = "lead" | "idle" | "max" | "bytes" | "forced";

export interface StreamRelayCounters {
	appendFrames: number;
	commits: number;
	committedRows: number;
	storeDedupes: number;
	pendingDedupes: number;
	conflicts: number;
	commitFailures: number;
	flushLead: number;
	flushIdle: number;
	flushMax: number;
	flushBytes: number;
	flushForced: number;
	provisionalBroadcasts: number;
	committedBroadcasts: number;
	notices: number;
	rateCloses: number;
	oversizeCloses: number;
	deviceSocketEvictions: number;
	rawDrops: number;
	authorityCloses: number;
	dailyLimitRejects: number;
	wakeNotices: number;
	/** H2: frames a flush held back because their stream's index was still building (once per flush). */
	dedupeHeld: number;
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

/** One read page on the wire (single read body / one batched read entry). */
function wirePage(page: StreamReadPage) {
	return {
		stream: page.stream,
		lastSeq: page.lastSeq,
		checkpointSeq: page.checkpointSeq,
		gcSeq: page.gcSeq,
		checkpoint: page.checkpoint ? { coversSeq: page.checkpoint.coversSeq, bytes: bytesToBase64(page.checkpoint.bytes) } : null,
		rows: page.rows.map((row) => ({ seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId,
			payload: bytesToBase64(row.payload) })),
		nextAfter: page.nextAfter,
	};
}

export class StreamRelayService {
	readonly config: StreamRelayConfig;
	readonly counters: StreamRelayCounters = {
		appendFrames: 0, commits: 0, committedRows: 0, storeDedupes: 0, pendingDedupes: 0, conflicts: 0,
		commitFailures: 0, flushLead: 0, flushIdle: 0, flushMax: 0, flushBytes: 0, flushForced: 0, provisionalBroadcasts: 0,
		committedBroadcasts: 0, notices: 0, rateCloses: 0, oversizeCloses: 0, deviceSocketEvictions: 0, rawDrops: 0,
		authorityCloses: 0, dailyLimitRejects: 0, wakeNotices: 0, dedupeHeld: 0,
	};
	private readonly clock: ClockPort;
	private readonly timers: TimerPort;
	private readonly random: () => number;
	/** Every socket's parsed attachment (null: not a streams socket): `deserializeAttachment` once per socket per runtime. */
	private readonly attachments = new WeakMap<object, StreamSocketAttachment | null>();
	/**
	 * H5 fanout set: the open streams sockets of admitted devices. Null until built once per runtime from
	 * `getWebSockets()` (ensureWakeNotice); then maintained on accept, close, error and every close this relay makes.
	 */
	private cache: Map<SocketPort, CachedSocket> | null = null;
	/** H5/H6: each device's cached sockets, oldest admitted first. */
	private readonly byDevice = new Map<string, SocketPort[]>();
	/** Sockets this relay closed or saw close: their later messages are dropped in O(1). */
	private readonly closing = new WeakSet<object>();
	/** H6: one bucket per device, full when first used in a runtime, kept for the runtime (a reconnect does not refill it), deleted on revoke. */
	private readonly buckets = new Map<string, DeviceBucket>();
	private readonly ordinals = new WeakMap<object, number>();
	private socketOrdinal = 0;
	private pending: PendingFrame[] = [];
	/** Payload bytes of the buffered frames not held back (H2): the bytes trigger. */
	private pendingBytes = 0;
	private readonly pendingByKey = new Map<string, PendingFrame>();
	private idleTimer: unknown = null;
	private maxTimer: unknown = null;
	private lastCommitAt = Number.NEGATIVE_INFINITY;
	/** Commit deadline of a buffer opened after a quiet spell (leading edge), else null. */
	private leadAt: number | null = null;
	/** H3: consecutive failed commits in this runtime (reset by a successful commit). */
	private failures = 0;
	/** H3: kind of the last daily-limit error this relay classified (typing of up-front refusals). */
	private dailyKind: DailyLimitKind = "rows-written";
	private writes = 0;

	constructor(private readonly options: StreamRelayOptions) {
		this.config = options.config;
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.timers = options.timers ?? SYSTEM_TIMERS;
		this.random = options.random ?? Math.random;
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

	/**
	 * The fanout set (H5): the cached sockets, built once per runtime. `getWebSockets()` may still return a socket
	 * after `close()` (developers.cloudflare.com/durable-objects/api/state/#getwebsockets), so membership is kept
	 * here, not read from the platform. The device map is still consulted per socket (one Map lookup): a device the
	 * host dropped from the map without `revokeDevice` is superseded here and leaves the set (D7).
	 */
	private streamSockets(): Array<{ socket: SocketPort; attachment: StreamSocketAttachment }> {
		this.ensureWakeNotice();
		const result: Array<{ socket: SocketPort; attachment: StreamSocketAttachment }> = [];
		for (const [socket, entry] of this.cache!) {
			if (this.options.validateActor(entry.actor)) result.push({ socket, attachment: entry.attachment });
			else this.supersede(socket);
		}
		return result;
	}

	private cacheAdd(socket: SocketPort, attachment: StreamSocketAttachment): void {
		if (this.cache!.has(socket)) return;
		this.cache!.set(socket, { attachment, actor: actorOf(attachment) });
		const own = this.byDevice.get(attachment.deviceId);
		if (own) own.push(socket);
		else this.byDevice.set(attachment.deviceId, [socket]);
	}

	private cacheRemove(socket: SocketPort): void {
		const entry = this.cache?.get(socket);
		if (!entry) return;
		this.cache!.delete(socket);
		const own = this.byDevice.get(entry.attachment.deviceId);
		if (!own) return;
		const at = own.indexOf(socket);
		if (at >= 0) own.splice(at, 1);
		if (own.length === 0) this.byDevice.delete(entry.attachment.deviceId);
	}

	/** Closes a socket this relay refuses: it leaves the fanout set in this turn and its later messages are dropped. */
	private closeSocket(socket: SocketPort, code: number, reason: string): void {
		this.closing.add(socket);
		this.cacheRemove(socket);
		try { socket.close(code, reason); } catch { /* closed */ }
	}

	head(): number {
		return this.options.store().head();
	}

	/** D8b finish: committed appended rows plus successful checkpoint writes since this runtime booted. */
	get writesThisRuntime(): number {
		return this.writes;
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
			readBatchMaxStreams: STREAM_READ_BATCH_MAX_STREAMS,
			rateBytesPerSec: this.config.rateBytesPerSec,
			burstBytes: this.config.burstBytes,
			groupCommit: { idleMs: this.config.gcIdleMs, maxMs: this.config.gcMaxMs, maxBytes: this.config.gcMaxBytes,
				minIntervalMs: this.config.gcMinIntervalMs, leadMs: this.config.gcLeadMs, quietMs: this.config.gcQuietMs },
		};
	}

	// ---- accept -----------------------------------------------------------

	/**
	 * Accepts an authorized streams socket upgrade (the host has verified the ticket and the device). H6: a device
	 * at MAX_STREAM_SOCKETS_PER_DEVICE first closes its oldest socket (1001 `device_socket_limit`); this runs before
	 * the vault-wide cap, so a device at its cap can always reconnect.
	 */
	accept(actor: StreamActor, canWrite: boolean): Response {
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		this.ensureWakeNotice();
		const own = this.byDevice.get(actor.deviceId);
		while (own && own.length >= MAX_STREAM_SOCKETS_PER_DEVICE) {
			this.counters.deviceSocketEvictions++;
			this.closeSocket(own[0]!, 1001, "device_socket_limit");
		}
		if (this.streamSockets().length >= this.config.maxSockets) {
			return json({ error: "stream_socket_limit" }, 429, { "Retry-After": "1" });
		}
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
		this.cacheAdd(server, attachment);
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
	 * Once per runtime, H5 rebuild: the socket cache is built from `getWebSockets()`, each attachment parsed once.
	 * Streams sockets admitted by an earlier runtime (hibernation wake, or an eviction that may have dropped
	 * buffered frames) are told to resend every unacknowledged append; resends are deduplicated. A surviving socket
	 * whose device is no longer in the device map is skipped and gets authority_superseded + 4403 (D7, O3).
	 */
	ensureWakeNotice(): void {
		if (this.cache !== null) return;
		this.cache = new Map();
		let head: number | null = null;
		const kept: Array<{ socket: SocketPort; attachment: StreamSocketAttachment }> = [];
		for (const socket of this.options.sockets.sockets()) {
			if (this.closing.has(socket)) continue;
			let attachment = this.attachmentOf(socket);
			if (!attachment) continue;
			if (!this.options.validateActor(actorOf(attachment))) { this.supersede(socket); continue; }
			if (attachment.runtimeEpoch !== this.options.runtimeEpoch) {
				const updated = { ...attachment, runtimeEpoch: this.options.runtimeEpoch };
				try { socket.serializeAttachment(updated); } catch { continue; }
				this.attachments.set(socket, updated);
				attachment = updated;
				head ??= this.head();
				this.options.sendControl(socket, { type: "STREAM_RESEND", reason: "runtime_restarted",
					runtimeEpoch: this.options.runtimeEpoch, head });
				this.counters.wakeNotices++;
			}
			kept.push({ socket, attachment });
		}
		kept.sort((left, right) => left.attachment.admittedAt - right.attachment.admittedAt);
		for (const entry of kept) this.cacheAdd(entry.socket, entry.attachment);
	}

	// ---- messages -----------------------------------------------------------

	message(socket: SocketPort, message: string | ArrayBuffer): void {
		if (this.closing.has(socket)) { this.counters.rawDrops++; return; }
		this.ensureWakeNotice();
		let entry = this.cache!.get(socket);
		if (!entry) {
			// The rebuild may have just superseded it.
			if (this.closing.has(socket)) { this.counters.rawDrops++; return; }
			const attachment = this.attachmentOf(socket);
			if (!attachment) { this.closeSocket(socket, 1008, "not a streams socket"); return; }
			// An open streams socket the cache lost track of: admitted → back into the set; otherwise superseded below.
			if (this.options.validateActor(actorOf(attachment))) this.cacheAdd(socket, attachment);
			entry = { attachment, actor: actorOf(attachment) };
		}
		// D7: the device map is checked first, before any echo, PROVISIONAL broadcast or buffering.
		if (!this.authorityHolds(socket, entry.actor)) return;
		if (!this.charge(socket, entry.attachment, message)) return;
		let buffered = false;
		if (typeof message === "string") this.control(socket, entry.attachment, message);
		else buffered = this.append(socket, entry.attachment, new Uint8Array(message));
		// H2 fallback: an incoming message is a fresh CPU budget (DO limits: each WebSocket message resets it), so it
		// carries one bounded build step, before a bytes-triggered flush can try to commit the frame.
		this.stepDedupe();
		if (buffered) this.schedule();
	}

	/** H2 fallback: one bounded build step. A failed read leaves the build queued: the next flush retries it. */
	private stepDedupe(): void {
		try {
			this.options.store().stepDedupe();
		} catch (error) {
			this.options.noteCommitError(error);
			console.warn("[yaos-streams] dedupe build failed", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * H6 raw admission: charges the received size (bytes for binary, UTF-16 units
	 * for text) to the device's bucket before any parsing. An oversize message
	 * closes 1009 (uncharged); an overdraft sends VAULT_BACKPRESSURE and closes the
	 * overdrawing socket 1013. Either way every later message of the socket is
	 * dropped in O(1). Frames the socket buffered before the close still commit: a
	 * rate or size close is not a revoke (a D7 revoke drops them, see revokeDevice).
	 */
	private charge(socket: SocketPort, attachment: StreamSocketAttachment, message: string | ArrayBuffer): boolean {
		const size = typeof message === "string" ? message.length : message.byteLength;
		const max = typeof message === "string" ? MAX_STREAM_TEXT_MESSAGE_BYTES : MAX_STREAM_BINARY_MESSAGE_BYTES;
		if (size > max) {
			this.counters.oversizeCloses++;
			this.closeSocket(socket, 1009, "message exceeds stream admission limit");
			return false;
		}
		const now = this.now();
		let bucket = this.buckets.get(attachment.deviceId);
		if (!bucket) {
			bucket = { tokens: this.config.burstBytes, at: now };
			this.buckets.set(attachment.deviceId, bucket);
		}
		bucket.tokens = Math.min(this.config.burstBytes,
			bucket.tokens + (Math.max(0, now - bucket.at) * this.config.rateBytesPerSec) / 1000);
		bucket.at = now;
		if (bucket.tokens >= size) {
			bucket.tokens -= size;
			return true;
		}
		this.counters.rateCloses++;
		this.options.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" });
		this.closeSocket(socket, 1013, "relay rate limit");
		return false;
	}

	private authorityHolds(socket: SocketPort, actor: StreamActor): boolean {
		if (this.options.validateActor(actor)) return true;
		this.supersede(socket);
		return false;
	}

	private control(socket: SocketPort, attachment: StreamSocketAttachment, message: string): void {
		if (!message.startsWith("__YPS:")) return;
		let value: unknown;
		try { value = JSON.parse(message.slice(6)); } catch { return; }
		const ping = parseVaultPingFrame(value);
		if (!ping) return;
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

	/** Admits one APPEND. Returns true when it was buffered (the caller schedules the flush). */
	private append(socket: SocketPort, attachment: StreamSocketAttachment, bytes: Uint8Array): boolean {
		const frame = decodeAppendFrame(bytes);
		if ("error" in frame) {
			// H1: the close reason is the bare error code (`malformed_frame` for every codec violation).
			this.closeSocket(socket, frame.error === "payload_too_large" ? 1009 : 1008, frame.error);
			return false;
		}
		this.counters.appendFrames++;
		if (!attachment.canWrite) { this.reject(socket, frame.stream, frame.clientFrameId, "write_forbidden"); return false; }
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
			return false;
		}
		if (this.options.dailyLimitActive()) {
			// H3: refused before any broadcast or buffering. DECISIONS-GAP: the host exposes only "latched", not the
			// latched kind; the kind is the one this relay last classified, else "rows-written" (the latch default).
			this.counters.dailyLimitRejects++;
			this.options.sendControl(socket, dailyLimitControl(this.now(), this.dailyKind, frame.stream, [frame.clientFrameId]));
			return false;
		}
		const provisional = isProvisionalStream(frame.stream);
		const entry: PendingFrame = { key, stream: frame.stream, deviceId: attachment.deviceId,
			clientFrameId: frame.clientFrameId, payload: frame.payload, origin: waiter, duplicates: [],
			provisional, ordinal: this.socketOrdinal, held: false };
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
		this.options.store().queueDedupe(frame.stream);
		return true;
	}

	private schedule(): void {
		if (this.pendingBytes >= this.config.gcMaxBytes) { this.flush("bytes"); return; }
		if (this.maxTimer === null) this.maxTimer = this.timers.set(() => { this.maxTimer = null; this.flush("max"); }, this.config.gcMaxMs);
		const now = this.now();
		const quiet = this.config.gcQuietMs > 0 && now - this.lastCommitAt >= this.config.gcQuietMs;
		if (this.pending.length === 1 && quiet) this.leadAt = now + this.config.gcLeadMs;
		if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
		const floor = this.lastCommitAt + this.config.gcMinIntervalMs - now;
		const lead = this.leadAt !== null;
		const wait = lead ? Math.max(0, this.leadAt! - now, floor) : Math.max(this.config.gcIdleMs, floor);
		this.idleTimer = this.timers.set(() => { this.idleTimer = null; this.flush(lead ? "lead" : "idle"); }, wait);
	}

	private clearTimers(): void {
		if (this.idleTimer !== null) this.timers.clear(this.idleTimer);
		if (this.maxTimer !== null) this.timers.clear(this.maxTimer);
		this.idleTimer = null;
		this.maxTimer = null;
		this.leadAt = null;
	}

	pendingFrames(): number {
		return this.pending.length;
	}

	/**
	 * Commits the buffered frames in one transaction, then sends broadcasts and receipts. H2 fallback: frames of a
	 * stream whose index is still building are held back, in order, for a later flush (re-armed here); a timer flush
	 * first advances the builds one step (a bytes flush runs in a message turn, which already stepped). A forced
	 * flush holds nothing back (the commit builds inline). A failed flush fails every frame it took.
	 *
	 * DECISIONS-GAP: H2 does not say what drives the steps. They run once per incoming message and once per timer
	 * flush. A message resets the DO's CPU budget and a timer does not, so with no messages arriving the timer steps
	 * of one build share a single budget window (a fresh budget per step would need an alarm, which the vault host
	 * owns).
	 */
	flush(reason: StreamFlushReason): void {
		const taken = this.pending;
		this.clearTimers();
		if (taken.length === 0) return;
		this.pending = [];
		this.pendingBytes = 0;
		this.pendingByKey.clear();
		if (reason === "lead") this.counters.flushLead++;
		else if (reason === "idle") this.counters.flushIdle++;
		else if (reason === "max") this.counters.flushMax++;
		else if (reason === "bytes") this.counters.flushBytes++;
		else this.counters.flushForced++;
		let frames = taken;
		const held: PendingFrame[] = [];
		let outcomes: StreamAppendOutcome[] = [];
		try {
			const store = this.options.store();
			if (reason !== "forced") {
				for (const frame of taken) store.queueDedupe(frame.stream);
				if (reason !== "bytes") store.stepDedupe();
				frames = [];
				for (const frame of taken) (store.dedupeReady(frame.stream) ? frames : held).push(frame);
			}
			if (frames.length > 0) outcomes = store.commit(frames).outcomes;
		} catch (error) {
			this.counters.commitFailures++;
			this.failures++;
			this.options.noteCommitError(error);
			console.warn("[yaos-streams] commit failed", error instanceof Error ? error.message : String(error));
			this.failed(taken, error);
			return;
		}
		if (frames.length > 0) {
			this.failures = 0;
			this.lastCommitAt = this.now();
			this.counters.commits++;
		}
		if (held.length > 0) {
			this.counters.dedupeHeld += held.length;
			for (const frame of held) { frame.held = true; this.pendingByKey.set(frame.key, frame); }
			this.pending = held;
			this.schedule();
		}
		if (frames.length === 0) return;
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
			if (outcome.kind === "appended") { this.counters.committedRows++; this.writes++; }
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

	/**
	 * A failed commit: nothing was written. Origins resend; holders of PROVISIONALs drop them. H3: the error is typed
	 * here, at the source: the daily limit → `VAULT_ERROR cf_daily_limit`, anything else → `durability_failed` with
	 * `retryAfterMs` (exponential in the consecutive failed commits n, jittered per message).
	 */
	private failed(frames: readonly PendingFrame[], error: unknown): void {
		const daily = isCloudflareDailyLimitError(error);
		if (daily) this.dailyKind = dailyLimitKind(error);
		const now = this.now();
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
				this.options.sendControl(entry.socket, daily ? dailyLimitControl(now, this.dailyKind, stream, clientFrameIds)
					: { type: "VAULT_ERROR", code: "durability_failed", message: "append was not committed; resend", stream, clientFrameIds,
						retryAfterMs: this.retryAfterMs() });
			}
		}
	}

	/** H3: round(min(30000, 1000·2^(n−1)) · (0.5 + 0.5·rand)), n = consecutive failed commits in this runtime. */
	private retryAfterMs(): number {
		return Math.round(Math.min(30_000, 1000 * 2 ** (this.failures - 1)) * (0.5 + 0.5 * this.random()));
	}

	// ---- authority ------------------------------------------------------------

	/**
	 * D7 revoke, synchronous (the host calls it in the same turn that deleted the
	 * device row and its device-map entry). Every socket of the device gets
	 * authority_superseded, closes 4403 and leaves the H5 fanout set; its H6 bucket
	 * goes. Its buffered frames are dropped: they never commit and get no receipt;
	 * peers that got their PROVISIONAL get STREAM_PROVISIONAL_DROPPED. Nothing is
	 * flushed: other devices' frames stay buffered for their normal commit.
	 */
	revokeDevice(deviceId: string): { droppedFrames: number; closedSockets: number } {
		// Cold path: walks getWebSockets() so a socket is found even before this runtime built its cache.
		let closedSockets = 0;
		for (const socket of this.options.sockets.sockets()) {
			if (this.closing.has(socket) || this.attachmentOf(socket)?.deviceId !== deviceId) continue;
			this.supersede(socket);
			closedSockets++;
		}
		this.buckets.delete(deviceId);
		const kept: PendingFrame[] = [];
		const dropped: PendingFrame[] = [];
		for (const frame of this.pending) (frame.deviceId === deviceId ? dropped : kept).push(frame);
		if (dropped.length > 0) {
			this.pending = kept;
			this.pendingBytes = 0;
			for (const frame of kept) if (!frame.held) this.pendingBytes += frame.payload.byteLength;
			for (const frame of dropped) this.pendingByKey.delete(frame.key);
			if (kept.length === 0) this.clearTimers();
			const peers = this.streamSockets();
			// DECISIONS-GAP: the D7 reason value is unspecified; the wire's existing "commit_failed" is reused
			// (the frame was not committed; the client ignores `reason`).
			for (const frame of dropped) if (frame.provisional) this.dropProvisional(peers, frame, "commit_failed");
		}
		return { droppedFrames: dropped.length, closedSockets };
	}

	private supersede(socket: SocketPort): void {
		this.counters.authorityCloses++;
		this.options.sendControl(socket, { type: "error", code: "authority_superseded", reason: "socket authority superseded" });
		this.closeSocket(socket, AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "socket authority superseded");
	}

	/** The runtime saw the socket close or error: it leaves the fanout set. */
	socketClosed(socket: SocketPort): void {
		this.closing.add(socket);
		this.cacheRemove(socket);
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

	/** Vault storage was wiped (the host closed every streams socket): drop the buffer unacked and every cached fact. */
	reset(): void {
		this.dropPending();
		this.options.store().reset();
		for (const socket of this.options.sockets.sockets()) if (this.attachmentOf(socket)) this.closing.add(socket);
		this.cache = new Map();
		this.byDevice.clear();
	}

	/**
	 * D8a reset / D8b restore: drops the pending buffer (no commit, no receipts, no frames), the head cache and the
	 * dedupe index, then closes every streams socket with `closeCode`/`reason` and forgets it. Synchronous.
	 */
	discardAll(closeCode: number, reason: string): void {
		this.dropPending();
		this.options.store().reset();
		for (const socket of this.options.sockets.sockets()) {
			if (this.closing.has(socket) || !this.attachmentOf(socket)) continue;
			this.closeSocket(socket, closeCode, reason);
		}
		this.cache = new Map();
		this.byDevice.clear();
	}

	diagnostics() {
		return { pendingFrames: this.pending.length, pendingBytes: this.pendingBytes, head: this.head(),
			sockets: this.cache?.size ?? null, dedupe: this.options.store().dedupeStats(),
			counters: { ...this.counters }, tables: this.options.store().tableCounts() };
	}

	// ---- HTTP -----------------------------------------------------------------

	/** GET /streams/feed?after=S&limit=N */
	feed(url: URL): Response {
		const after = nonNegativeInteger(url.searchParams.get("after"), 0);
		const limit = nonNegativeInteger(url.searchParams.get("limit"), STREAM_FEED_DEFAULT_LIMIT);
		if (after === null) return json({ error: "invalid_cursor" }, 400);
		if (limit === null || limit < 1) return json({ error: "invalid_limit" }, 400);
		return this.dailyLimitAware(() => {
			const page = this.options.store().feed(after, Math.min(limit, STREAM_FEED_MAX_LIMIT));
			return json({ vaultEpoch: this.options.vaultGeneration(), ...page });
		});
	}

	/**
	 * GET /streams/read?stream=X&after=S&maxBytes=B&checkpoint=1, or the batched form
	 * GET /streams/read?maxBytes=B&r=<after>.<0|1>.<stream>&r=... (at most STREAM_READ_BATCH_MAX_STREAMS entries):
	 * the first page of each entry in request order under one maxBytes budget. The first entry always gets its
	 * page (as a single read); a later page that would overrun the remaining budget ends the batch, and the
	 * client re-requests the entries without a page.
	 */
	read(url: URL): Response {
		const maxBytes = nonNegativeInteger(url.searchParams.get("maxBytes"), STREAM_READ_DEFAULT_BYTES);
		if (maxBytes === null || maxBytes < 1) return json({ error: "invalid_max_bytes" }, 400);
		const budget = Math.min(maxBytes, STREAM_READ_MAX_BYTES);
		const entries = url.searchParams.getAll("r");
		if (entries.length > 0) return this.readBatch(entries, budget);
		const stream = url.searchParams.get("stream");
		if (!validStreamName(stream)) return json({ error: "invalid_stream" }, 400);
		const after = nonNegativeInteger(url.searchParams.get("after"), 0);
		if (after === null) return json({ error: "invalid_cursor" }, 400);
		return this.dailyLimitAware(() => {
			const page = this.options.store().read(stream, after, budget, url.searchParams.get("checkpoint") === "1");
			return json({ vaultEpoch: this.options.vaultGeneration(), head: this.head(), ...wirePage(page) });
		});
	}

	private readBatch(raw: string[], maxBytes: number): Response {
		if (raw.length > STREAM_READ_BATCH_MAX_STREAMS) return json({ error: "batch_too_large", max: STREAM_READ_BATCH_MAX_STREAMS }, 400);
		const entries: { stream: string; after: number; checkpoint: boolean }[] = [];
		for (const entry of raw) {
			const match = /^(\d+)\.([01])\.(.+)$/s.exec(entry);
			const after = match ? nonNegativeInteger(match[1]!, 0) : null;
			if (!match || after === null) return json({ error: "invalid_read_entry" }, 400);
			if (!validStreamName(match[3])) return json({ error: "invalid_stream" }, 400);
			entries.push({ stream: match[3], after, checkpoint: match[2] === "1" });
		}
		return this.dailyLimitAware(() => {
			const store = this.options.store();
			const pages: ReturnType<typeof wirePage>[] = [];
			let left = maxBytes;
			for (const entry of entries) {
				if (pages.length > 0 && left <= 0) break;
				const page = store.read(entry.stream, entry.after, pages.length > 0 ? left : maxBytes, entry.checkpoint);
				const size = (page.checkpoint?.bytes.byteLength ?? 0) + page.rows.reduce((total, row) => total + row.payload.byteLength, 0);
				if (pages.length > 0 && size > left) break;
				pages.push(wirePage(page));
				left -= size;
			}
			return json({ vaultEpoch: this.options.vaultGeneration(), head: this.head(), pages });
		});
	}

	/**
	 * PUT /streams/checkpoint?stream=X&coversSeq=N&expectedCoversSeq=M, body = opaque checkpoint bytes. `admitted`
	 * runs after the body read, in the writing turn: a device revoked during the read gets 401, nothing written (D7).
	 */
	async putCheckpoint(request: Request, url: URL, admitted: () => boolean = () => true): Promise<Response> {
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
		if (!admitted()) return json({ error: "unauthorized" }, 401);
		return this.dailyLimitAware(() => {
			const result = this.options.store().putCheckpoint(stream, coversSeq, expected, bytes);
			if (!result.ok) {
				const { ok: _ok, status, ...body } = result;
				return json(body, status);
			}
			this.writes++;
			return json({ stream, coversSeq: result.coversSeq, gcSeq: result.gcSeq, deletedSegments: result.deletedSegments });
		});
	}

	/** H3: a handler that fails on the daily limit answers `503 cf_daily_limit` itself; other errors propagate. */
	private dailyLimitAware(run: () => Response): Response {
		try {
			return run();
		} catch (error) {
			if (!isCloudflareDailyLimitError(error)) throw error;
			return dailyLimitResponse(this.now(), dailyLimitKind(error));
		}
	}
}
