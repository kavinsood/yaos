// Relay v2 spike (brief §5.1–§5.4): the relay body hot path. Body sockets
// never hold a CRDT document: the server keeps the merged state as bytes
// (checkpoint + journal tail, merged with ywasm byte ops) and appends each
// client update to `vault_journal` in one lean transaction. Only reached when
// `YAOS_RELAY_BODIES === "true"`. See docs/relay2-protocol.md.
//
// Relay v3 (`YAOS_RELAY_GROUP_COMMIT`, docs/relay3-group-commit.md): a validated
// frame is broadcast at once and buffered per (body, epoch); the buffer commits
// in one transaction (one tail row, the head, one receipt row per device) on
// idle / max age / bytes, and origins are acked only after that commit. The
// invariant is "durable before receipt" (v2: "durable before broadcast").
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { base64ToBytes, bytesToBase64 } from "./base64url";
import type { VaultActorContext } from "./collaboration";
import { MAX_CATCH_UP_BYTES, MAX_DURABLE_UPDATE_BYTES } from "./contracts";
import {
	EMPTY_UPDATE_V1,
	decodeStateVector,
	defaultYwasmByteOps,
	diffUpdate,
	mergeUpdates,
	stateVectorCoveredBy,
	stateVectorFromUpdate,
	stateVectorsEqual,
	ywasmLinearMemoryBytes,
} from "./crdt/ywasmByteOps";
import { readSyncMessage, SYNC_STEP_1, SYNC_STEP_2, SYNC_UPDATE } from "./crdt/syncFraming";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "./shared/socketCloseCodes";
import { canonicalMarkdownBytes } from "./shared/markdownCodec";
import type { SemanticEpoch } from "./shared/semanticEpoch";
import type { RelayConfig } from "./relayFlag";
import {
	RelayAppendError, RelayBodyStore, type RelayLeaseResult, type RelayResetOutcome, type RelayResetPolicyState,
} from "./relayBodyStore";
import { CANDIDATE_RECEIPT_TTL_MS } from "./vaultCatalogStore";
import { RelayMergeBudgetError, sha256HexSync } from "./vaultDocumentStore";
import type { VaultDocumentCache } from "./vaultDocumentCache";
import type { VaultStore } from "./vaultStore";
import type { VaultSocketAttachment, VaultSocketPort } from "./vaultSocketService";

const MESSAGE_SYNC = 0;
const MAX_ENVELOPE_ID_LENGTH = 256;
/** Snapshot ceiling for one semantic reset (binary body; the JSON body shares the same request cap). */
export const RELAY_MAX_RESET_SNAPSHOT_BYTES = MAX_CATCH_UP_BYTES;

/** Capability advertised in VAULT_READY on relay body sockets. */
export const RELAY_BODIES_CAPABILITY_VERSION = 2;

/** Socket-service side of the relay path (implemented by VaultSocketService). */
export interface RelaySocketHost {
	sockets(): readonly VaultSocketPort[];
	sendControl(socket: VaultSocketPort, value: unknown): void;
	/** Sends the epoch-mismatch frame and closes 4409. */
	fenceRelaySocket(socket: VaultSocketPort, attachment: VaultSocketAttachment, currentEpoch: SemanticEpoch): void;
	broadcastRelayUpdate(bodyId: string, epoch: SemanticEpoch, frame: Uint8Array, excludeSocketId: string): void;
	/** Base BODY_COMMITTED to root sockets and peer body sockets (never the origins: they get their own ack). */
	notifyBodyCommitted(bodyId: string, durableGeneration: number, vaultSequence: number,
		excludeSocketIds?: ReadonlySet<string>): void;
	/** v3 wake re-sync: open relay body sockets with their attachments. */
	relayBodySockets?(): Array<{ socket: VaultSocketPort; attachment: VaultSocketAttachment }>;
}

/** v3: tail frames that trigger a checkpoint regardless of bytes. */
export const RELAY_GC_TAIL_MAX_FRAMES = 512;
/**
 * b3-a1fix: a full checkpoint whose byte-merged state is over this size is
 * re-encoded through a GC'd ywasm document before it is written. Byte merges
 * (mergeUpdates) keep the content of deleted items, so a whole-text rewrite
 * grew the checkpoint by the full note size on every save (measured A1: the
 * 50 KB note passed exactMergeBytes by save ~6, then every save rewrote a
 * multi-chunk checkpoint). The re-encode keeps every CRDT identity and the
 * state vector (deleted items become ContentDeleted, as in any gc:true Y.Doc);
 * it is not a semantic reset and needs no client fence.
 */
export const RELAY_GC_COMPACT_MIN_BYTES = 128 * 1024;
/** Upper bound for the in-checkpoint GC re-encode (wasm decode cost is linear in input). */
export const RELAY_GC_COMPACT_MAX_BYTES = 4 * 1024 * 1024;

type GroupFlushReason = "idle" | "max" | "bytes" | "forced" | "read";

/** v3: bound on acks held per socket while its wake re-sync step2 is outstanding (excess acks are dropped; the client resends). */
const WAKE_HELD_ACKS_MAX = 1024;

interface GroupBuffer {
	bodyId: string;
	frames: QueuedFrame[];
	bytes: number;
	idleTimer: unknown;
	maxTimer: unknown;
}

export interface RelayEnvelope {
	bodyId: string;
	bodyEpoch: number;
	clientFrameId: string;
	payloadDigest: string;
	candidateId?: string;
	candidateDigest?: string;
	contentHash?: string;
	size?: number;
	stateVector?: Uint8Array;
	frameKind?: string;
}

interface MergedEntry {
	epoch: SemanticEpoch;
	latestSequence: number;
	generation: number;
	/** Merged durable bytes; null when stale (large body, incremental SV only). */
	bytes: Uint8Array | null;
	/** Head state vector, maintained incrementally per append (K3 guidance). */
	stateVector: Uint8Array;
	/** True when `stateVector` was computed from full merged bytes. */
	stateVectorExact: boolean;
	/** Last appended update (resend growth-cap check for large bodies). */
	lastUpdate: Uint8Array | null;
	tailEntries: number;
	tailBytes: number;
	checkpointSequence: number;
	/** True when checkpoint + tail exceed `maxMergeInputBytes`: bytes are never merged in-process. */
	overBudget?: boolean;
}

interface QueuedFrame {
	socket: VaultSocketPort;
	attachment: VaultSocketAttachment;
	actor: VaultActorContext;
	update: Uint8Array;
	envelope: RelayEnvelope | null;
	digest: string | null;
	/** v3: arrival order across the runtime (cumulative-ack fence, see markFailed). */
	seq: number;
	/** v3: held acks released once this frame (a wake re-sync step2) is durable or a no-op. */
	onDurable?: Array<() => void>;
}

/**
 * R12 raw admission gate of one relay socket: a token bucket charged with every
 * received message's raw size before any parsing, and the refused flag that
 * turns every later message of the socket into an O(1) drop.
 */
interface RawGate { tokens: number; at: number; refused: boolean }

/** Timer seam (tests drive virtual time); defaults to the global timers. */
export interface RelayTimers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const GLOBAL_TIMERS: RelayTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * O(1) peek: a binary MESSAGE_SYNC step2/update frame with a non-empty update
 * (what handleSyncFrame would count in updateFrames). Reads at most 5 bytes.
 */
function peekSyncUpdate(message: string | ArrayBuffer): boolean {
	if (typeof message === "string" || message.byteLength < 3) return false;
	const head = new Uint8Array(message, 0, Math.min(5, message.byteLength));
	if (head[0] !== 0 || (head[1] !== SYNC_STEP_2 && head[1] !== SYNC_UPDATE)) return false;
	if (head[2] === 0) return false;
	if (head[2] === 2 && head[3] === 0 && head[4] === 0) return false;
	return true;
}

export interface RelayCounters {
	appends: number;
	appendFrames: number;
	emptySkips: number;
	noopSkips: number;
	dedupeHits: number;
	dedupeConflicts: number;
	envelopeMismatches: number;
	hashAccepted: number;
	hashUnknown: number;
	materialisations: number;
	checkpoints: number;
	lastCheckpointMs: number;
	checkpointRowsWritten: number;
	resets: number;
	leaseGrants: number;
	leaseDenials: number;
	rowsWritten: number;
	rateLimitCloses: number;
	epochFences: number;
	authorityCloses: number;
	commitFailures: number;
	mergedCacheRebuilds: number;
	step2Replies: number;
	incrementalAppends: number;
	stateVectorDrift: number;
	partialCheckpoints: number;
	/** Byte merges refused by the `maxMergeInputBytes` budget (never called into wasm). */
	mergeBudgetRejects: number;
	/** Step1 replies sent as unmerged checkpoint + tail parts (over-budget bodies). */
	unmergedStep2Replies: number;
	/** HTTP reads that left an unknown hash unknown because the body is over `lazyHashMaxBytes`. */
	lazyHashSkips: number;
	/** HTTP reads served from the per-(body, epoch, head sequence) lazy hash cache (G4). */
	lazyHashCacheHits: number;
	/** Queued micro-batch frames dropped at commit because the device lost authority (G2). */
	authorityDrops: number;
	/** Frames in one micro-batch that repeated an earlier frame's (device, candidateId) (G11). */
	batchDuplicateCandidates: number;
	/** Relay appends that found a dirty/validating resident document and left it for later eviction (G5). */
	residentStaleSkips: number;
	/** Feed-floor advances performed by the relay checkpoint pass (G1). */
	floorAdvances: number;
	/** Journal rows pruned by those floor advances. */
	floorRowsPruned: number;
	/**
	 * Non-empty SYNC_UPDATE frames received. No silent drops (round 4): every one
	 * ends in exactly one of appendFrames, noopSkips, dedupeHits, dedupeConflicts,
	 * batchDuplicateCandidates, authorityCloses/authorityDrops, rateLimitCloses,
	 * epochFences, bodyInactiveCloses, tooLargeCloses, commitFailures, frameErrors
	 * (the last seven close the socket with an error code); v3 adds groupDropped
	 * and failedSocketDrops.
	 */
	updateFrames: number;
	/** Frames whose processing threw before the append (ywasm/SQL/rebuild error): VAULT_ERROR + close 1011. */
	frameErrors: number;
	/** Steps after a successful append that threw (cache/ack/fan-out); the remaining steps still ran. */
	postCommitErrors: number;
	/** Frames refused because the body is not active (close 1008). */
	bodyInactiveCloses: number;
	/** Frames over the durable value limit (close 1009). */
	tooLargeCloses: number;
	/** Lean rows (§6.4): catalog events written by the coalescing pass, and their rows (incl. clock sync). */
	leanCatalogEvents: number;
	/** Full checkpoints written from the in-memory merged bytes (no SQLite read, no wasm merge). */
	checkpointsFromCache: number;
	/** b3-a1fix: full checkpoints re-encoded through a GC'd document, and the bytes that dropped. */
	checkpointGcCompactions: number;
	checkpointGcBytesDropped: number;
	leanCoalesceRowsWritten: number;
	/** v3: group commits (one transaction each) and the frames they covered. */
	groupCommits: number;
	groupFrames: number;
	/** v3: why each buffer flushed. */
	groupFlushIdle: number;
	groupFlushMax: number;
	groupFlushBytes: number;
	groupFlushForced: number;
	/** v3: buffers flushed early by an HTTP candidate or a currentness query for the body. */
	groupFlushReads: number;
	/** v3: frames broadcast before commit (fan-out at receipt). */
	groupBroadcasts: number;
	/** v3: buffered frames dropped unacked by a simulated crash (the origin resends). */
	groupDropped: number;
	/** v3: frames found already committed (receipt ring) at flush; acked as dedupes. */
	groupFlushDedupes: number;
	/** v3: checkpoints triggered by the tail cap, and groups that fell back to a journal row. */
	tailCheckpoints: number;
	tailJournalFallbacks: number;
	/** v3: buffered frames replayed to a socket after its step2 (they were broadcast before it joined). */
	pendingReplayFrames: number;
	/** v3: wake re-syncs (step1 sent to sockets of an earlier runtime). */
	wakeResyncs: number;
	wakeResyncSockets: number;
	/**
	 * v3 cumulative-ack safety: update frames dropped unacked because an earlier
	 * frame of the same socket was refused (rate limit, too large, authority,
	 * epoch fence, inactive body, commit failure, frame error). The socket is
	 * already closing; without this a later frame could be acked and the client
	 * (which treats an ack for frame N as confirming every earlier frame) would
	 * forget the refused one. A frame outcome.
	 */
	failedSocketDrops: number;
	/** v3: acks held until the socket's wake re-sync step2 was committed (then sent), and acks dropped at the cap. */
	wakeHeldAcks: number;
	wakeHeldAcksDropped: number;
	/** v3 R11: synchronous flushes of every group buffer right before an authority write (fence/revoke). */
	authorityFenceFlushes: number;
	/**
	 * v3 R11: buffered frames whose device lost authority before the flush but
	 * that passed authority at receipt and were already broadcast: committed (so
	 * durable state matches what peers applied) and the socket closed 4403.
	 * Reachable only for an authority writer that skipped the fence flush. A
	 * subset of appendFrames/noopSkips, not a separate outcome.
	 */
	revokedBroadcastCommits: number;
	/**
	 * v3 HTTP save: candidate POSTs for a body committed through the group-commit
	 * store (tail + head + receipt ring) instead of the base path, and those that
	 * changed nothing (receipt ring row only). Not frame outcomes.
	 */
	httpRelayCommits: number;
	httpRelayNoops: number;
	/** v3 commit-rate cap: idle flushes pushed out to the body's previous commit + gcMinIntervalMs. */
	groupIdleDeferred: number;
	/**
	 * R12 raw gate: sockets closed by it (1013 rate, 1009 size; any message
	 * kind), and messages dropped in O(1) after it refused one (no attachment
	 * parse, decode, digest, authority check or broadcast). An over-rate sync
	 * update also counts in updateFrames + rateLimitCloses/tooLargeCloses, and a
	 * dropped one in updateFrames + failedSocketDrops, so the outcome sum holds.
	 */
	rateGateCloses: number;
	rawGateDrops: number;
}

export interface RelayBodyServiceOptions {
	config: RelayConfig;
	/** Getters: the runtime replaces its store on vault delete. */
	store: () => VaultStore;
	relayStore: () => RelayBodyStore;
	cache: VaultDocumentCache;
	runtimeEpoch: string;
	/** Arms the DO alarm (checkpoint). */
	armCheckpointAlarm: () => void;
	now?: () => number;
	/** Group-commit timers (tests: virtual time). */
	timers?: RelayTimers;
}

function isEnvelopeId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ENVELOPE_ID_LENGTH;
}

function isHex64(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function parseRelayEnvelope(value: unknown): RelayEnvelope | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (input.type !== "BODY_UPDATE_ENVELOPE" || !isEnvelopeId(input.bodyId)
		|| !Number.isSafeInteger(input.bodyEpoch) || (input.bodyEpoch as number) < 1
		|| !isEnvelopeId(input.clientFrameId) || !isHex64(input.payloadDigest)) return null;
	const envelope: RelayEnvelope = { bodyId: input.bodyId, bodyEpoch: input.bodyEpoch as number,
		clientFrameId: input.clientFrameId, payloadDigest: input.payloadDigest };
	if (input.candidateId !== undefined) {
		if (!isEnvelopeId(input.candidateId)) return null;
		envelope.candidateId = input.candidateId;
	}
	if (input.candidateDigest !== undefined) {
		if (!isEnvelopeId(input.candidateDigest)) return null;
		envelope.candidateDigest = input.candidateDigest;
	}
	if (input.contentHash !== undefined && input.contentHash !== null) {
		if (!isHex64(input.contentHash)) return null;
		envelope.contentHash = input.contentHash;
	}
	if (input.size !== undefined && input.size !== null) {
		if (!Number.isSafeInteger(input.size) || (input.size as number) < 0) return null;
		envelope.size = input.size as number;
	}
	if (input.stateVector !== undefined && input.stateVector !== null) {
		if (typeof input.stateVector !== "string" || input.stateVector.length > 1024 * 1024) return null;
		try { envelope.stateVector = base64ToBytes(input.stateVector); decodeStateVector(envelope.stateVector); }
		catch { return null; }
	}
	if (typeof input.frameKind === "string" && input.frameKind.length <= 32) envelope.frameKind = input.frameKind;
	return envelope;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}

function syncFrame(kind: number, payload: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	encoding.writeVarUint(encoder, kind);
	encoding.writeVarUint8Array(encoder, payload);
	return encoding.toUint8Array(encoder);
}

/** Pointwise max of two V1 state vectors (incremental head SV). */
export function maxStateVector(left: Uint8Array, right: Uint8Array): Uint8Array {
	const merged = decodeStateVector(left);
	for (const [client, clock] of decodeStateVector(right)) {
		if ((merged.get(client) ?? 0) < clock) merged.set(client, clock);
	}
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, merged.size);
	for (const [client, clock] of [...merged.entries()].sort((a, b) => b[0] - a[0])) {
		encoding.writeVarUint(encoder, client);
		encoding.writeVarUint(encoder, clock);
	}
	return encoding.toUint8Array(encoder);
}

function actorOf(attachment: VaultSocketAttachment): VaultActorContext {
	return {
		vaultId: attachment.vaultId, vaultGeneration: attachment.vaultGeneration,
		principalId: attachment.principalId, membershipRevision: attachment.membershipRevision,
		deviceId: attachment.deviceId, deviceCredentialRevision: attachment.deviceCredentialRevision,
		...(attachment.deviceName ? { deviceName: attachment.deviceName } : {}),
		role: attachment.role, policyVersion: attachment.policyVersion,
		capabilityDigest: attachment.capabilityDigest,
	};
}

export class RelayBodyService {
	readonly config: RelayConfig;
	private host: RelaySocketHost | null = null;
	private readonly pendingEnvelopes = new Map<string, RelayEnvelope>();
	/** R12: raw gates by socket id (survive a re-parse) and by socket object (O(1) lookup before any parse). */
	private readonly buckets = new Map<string, RawGate>();
	private readonly gates = new WeakMap<object, RawGate>();
	/** v3 commit-rate cap: time of the last group commit per (body, epoch). */
	private readonly lastGroupCommit = new Map<string, number>();
	private readonly timers: RelayTimers;
	private readonly merged = new Map<string, MergedEntry>();
	private mergedBytesTotal = 0;
	private readonly batches = new Map<string, { frames: QueuedFrame[]; timer: ReturnType<typeof setTimeout> }>();
	private readonly appendTimes: number[] = [];
	/**
	 * Bodies whose checkpoint cannot progress within the merge budget, by epoch
	 * (G20: persisted in `relay_body_budget`, loaded lazily; a new epoch clears it).
	 */
	private overBudgetBodies: Map<string, number> | null = null;
	/** Resident base-path documents left stale by a relay append (dirty or validating); evicted later (G5). */
	private readonly staleResidents = new Set<string>();
	/** Lazily materialised hashes keyed by body, valid for one (epoch, head sequence) (G4). */
	private readonly lazyHashes = new Map<string, { epoch: SemanticEpoch; sequence: number; contentHash: string; size: number }>();
	readonly counters: RelayCounters = {
		appends: 0, appendFrames: 0, emptySkips: 0, noopSkips: 0, dedupeHits: 0, dedupeConflicts: 0,
		envelopeMismatches: 0, hashAccepted: 0, hashUnknown: 0, materialisations: 0, checkpoints: 0,
		lastCheckpointMs: 0, checkpointRowsWritten: 0, resets: 0, leaseGrants: 0, leaseDenials: 0,
		rowsWritten: 0, rateLimitCloses: 0, epochFences: 0, authorityCloses: 0, commitFailures: 0,
		mergedCacheRebuilds: 0, step2Replies: 0, incrementalAppends: 0, stateVectorDrift: 0, partialCheckpoints: 0,
		mergeBudgetRejects: 0, unmergedStep2Replies: 0, lazyHashSkips: 0, lazyHashCacheHits: 0, authorityDrops: 0,
		batchDuplicateCandidates: 0, residentStaleSkips: 0, floorAdvances: 0, floorRowsPruned: 0,
		updateFrames: 0, frameErrors: 0, postCommitErrors: 0, bodyInactiveCloses: 0, tooLargeCloses: 0,
		leanCatalogEvents: 0, leanCoalesceRowsWritten: 0, checkpointsFromCache: 0, checkpointGcCompactions: 0, checkpointGcBytesDropped: 0,
		groupCommits: 0, groupFrames: 0, groupFlushIdle: 0, groupFlushMax: 0, groupFlushBytes: 0, groupFlushForced: 0,
		groupBroadcasts: 0, groupDropped: 0, groupFlushDedupes: 0, tailCheckpoints: 0, tailJournalFallbacks: 0,
		pendingReplayFrames: 0, wakeResyncs: 0, wakeResyncSockets: 0, groupFlushReads: 0, failedSocketDrops: 0,
		wakeHeldAcks: 0, wakeHeldAcksDropped: 0, authorityFenceFlushes: 0, revokedBroadcastCommits: 0,
		httpRelayCommits: 0, httpRelayNoops: 0, groupIdleDeferred: 0, rateGateCloses: 0, rawGateDrops: 0,
	};
	/** v3 group-commit buffers keyed by (body, epoch). */
	private readonly groups = new Map<string, GroupBuffer>();
	private wakeResyncDone = false;
	/**
	 * v3: socket → arrival seq of its first refused frame. Frames of the socket
	 * that arrived after it are dropped unacked (cumulative-ack safety); frames
	 * buffered before it still commit and ack.
	 */
	private readonly failedSockets = new Map<string, number>();
	private frameSeq = 0;
	/** v3: sockets sent a wake re-sync step1 whose step2 has not arrived yet: their acks are held. */
	private readonly wakeHeld = new Map<string, Array<() => void>>();
	/** Last pre-append frame error (diagnostics only; message text, no payload bytes). */
	private lastFrameError: { at: number; message: string } | null = null;

	constructor(private readonly options: RelayBodyServiceOptions) {
		this.config = options.config;
		this.timers = options.timers ?? GLOBAL_TIMERS;
	}

	bindHost(host: RelaySocketHost): void {
		this.host = host;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private requireHost(): RelaySocketHost {
		if (!this.host) throw new Error("relay socket host is not bound");
		return this.host;
	}

	validateActor(actor: VaultActorContext): boolean {
		return this.options.store().validateActorCached(actor, this.now()) === "allowed";
	}

	documentHead(bodyId: string) {
		return this.options.store().documentHead(bodyId);
	}

	// ---- merged bytes -------------------------------------------------------

	/**
	 * Head entry for a body, validated against the durable head (one SQL read).
	 * `bytes` may be null for large bodies; use `fullState` when bytes are needed.
	 */
	headState(bodyId: string): MergedEntry | null {
		const head = this.options.store().documentHead(bodyId);
		if (!head) return null;
		const cached = this.merged.get(bodyId);
		if (cached && cached.epoch === head.semanticEpoch && cached.latestSequence === head.latestSequence) {
			// LRU touch.
			this.merged.delete(bodyId);
			this.merged.set(bodyId, cached);
			return cached;
		}
		return this.rebuild(bodyId, head.latestSequence);
	}

	/** Head entry with merged bytes materialised (step1 replies, HTTP reads, exact merges). */
	fullState(bodyId: string): (MergedEntry & { bytes: Uint8Array }) | null {
		const entry = this.headState(bodyId);
		if (!entry) return null;
		if (entry.bytes) return entry as MergedEntry & { bytes: Uint8Array };
		if (entry.overBudget) throw new RelayMergeBudgetError(bodyId, -1, this.config.maxMergeInputBytes);
		const rebuilt = this.rebuild(bodyId, entry.latestSequence, entry);
		if (!rebuilt.bytes) throw new RelayMergeBudgetError(bodyId, -1, this.config.maxMergeInputBytes);
		return rebuilt as MergedEntry & { bytes: Uint8Array };
	}

	/**
	 * Rebuilds the head entry from checkpoint + tail. Over the merge budget the
	 * entry keeps `bytes: null` and the pointwise max of the parts' SVs, which
	 * can overstate the true head SV when a part has gaps (pending structs), so
	 * it is marked inexact (G8: no content-hash claim is accepted against it).
	 * Appends and step1 still work; merged-byte readers get `RelayMergeBudgetError`.
	 */
	private rebuild(bodyId: string, throughSequence: number, previous?: MergedEntry): MergedEntry {
		let durable: { semanticEpoch: SemanticEpoch; latestSequence: number; generation: number; tailEntries: number;
			tailBytes: number; checkpointSequence: number; bytes: Uint8Array | null };
		let stateVector: Uint8Array;
		try {
			durable = this.options.store().durableMergedBytes(bodyId, throughSequence, this.config.maxMergeInputBytes);
			stateVector = stateVectorFromUpdate(durable.bytes!);
		} catch (error) {
			if (!(error instanceof RelayMergeBudgetError)) throw error;
			this.counters.mergeBudgetRejects++;
			const { parts, ...rest } = this.options.store().durableParts(bodyId, throughSequence);
			durable = { ...rest, bytes: null };
			stateVector = parts.map((part) => stateVectorFromUpdate(part))
				.reduce((left, right) => maxStateVector(left, right));
		}
		this.counters.mergedCacheRebuilds++;
		if (previous && !previous.stateVectorExact && !stateVectorsEqual(previous.stateVector, stateVector)) {
			this.counters.stateVectorDrift++;
		}
		const entry: MergedEntry = {
			epoch: durable.semanticEpoch,
			latestSequence: durable.latestSequence,
			generation: durable.generation,
			bytes: durable.bytes,
			stateVector,
			stateVectorExact: durable.bytes !== null,
			lastUpdate: previous?.lastUpdate ?? null,
			tailEntries: durable.tailEntries,
			tailBytes: durable.tailBytes,
			checkpointSequence: durable.checkpointSequence,
			...(durable.bytes === null ? { overBudget: true } : {}),
		};
		this.remember(bodyId, entry);
		return entry;
	}

	private static entryBytes(entry: MergedEntry): number {
		return (entry.bytes?.byteLength ?? 0) + entry.stateVector.byteLength + (entry.lastUpdate?.byteLength ?? 0);
	}

	private remember(bodyId: string, entry: MergedEntry): void {
		const previous = this.merged.get(bodyId);
		if (previous) {
			this.mergedBytesTotal -= RelayBodyService.entryBytes(previous);
			this.merged.delete(bodyId);
		}
		this.merged.set(bodyId, entry);
		this.mergedBytesTotal += RelayBodyService.entryBytes(entry);
		for (const [key, value] of this.merged) {
			if (this.mergedBytesTotal <= this.config.mergedCacheBytes || key === bodyId) break;
			this.merged.delete(key);
			this.mergedBytesTotal -= RelayBodyService.entryBytes(value);
		}
	}

	invalidate(bodyId: string): void {
		const previous = this.merged.get(bodyId);
		if (!previous) return;
		this.merged.delete(bodyId);
		this.mergedBytesTotal -= RelayBodyService.entryBytes(previous);
	}

	/** Step1 payload for a newly admitted relay body socket. */
	stateVector(bodyId: string): Uint8Array {
		return this.headState(bodyId)?.stateVector ?? stateVectorFromUpdate(EMPTY_UPDATE_V1);
	}

	// ---- socket frames ------------------------------------------------------

	/** `__YPS:` control frame the base socket path does not own. Returns true when consumed. */
	handleControl(socket: VaultSocketPort, attachment: VaultSocketAttachment, message: string): boolean {
		let value: unknown;
		try { value = JSON.parse(message.slice(6)); } catch { return false; }
		const envelope = parseRelayEnvelope(value);
		if (!envelope) return false;
		if (envelope.bodyId !== attachment.documentId || envelope.bodyEpoch !== attachment.documentEpoch) return true;
		// A second envelope before a binary frame replaces the first.
		this.pendingEnvelopes.set(attachment.socketId, envelope);
		return true;
	}

	/**
	 * Over-budget step1: the checkpoint + tail parts as they are stored, one
	 * SYNC_STEP_2 per part (no diff, no merge; clients merge idempotently).
	 */
	private replyStep2Unmerged(socket: VaultSocketPort, attachment: VaultSocketAttachment): void {
		const bodyId = attachment.documentId;
		const head = this.options.store().documentHead(bodyId);
		if (!head) { socket.close(1008, "body is not active"); return; }
		if (head.semanticEpoch !== attachment.documentEpoch) {
			this.counters.epochFences++;
			this.requireHost().fenceRelaySocket(socket, attachment, head.semanticEpoch);
			return;
		}
		const { parts } = this.options.store().durableParts(bodyId, head.latestSequence);
		this.counters.step2Replies++;
		this.counters.unmergedStep2Replies++;
		try { for (const part of parts) socket.send(syncFrame(SYNC_STEP_2, part)); } catch { /* closed */ }
	}

	/**
	 * Per-socket in-memory state only. A pending envelope is lost on close and on
	 * hibernation (G13): the next binary frame is then simply envelope-less (it
	 * commits, the origin gets no ack and resends on reconnect as a no-op). It can
	 * never pair with a different frame: pairing requires the payload digest.
	 * Queued micro-batch frames of a closed socket still commit (they were
	 * authorised and are re-checked at commit, G2).
	 */
	socketClosed(socketId: string): void {
		this.pendingEnvelopes.delete(socketId);
		this.buckets.delete(socketId);
		this.failedSockets.delete(socketId);
		this.wakeHeld.delete(socketId);
	}

	/**
	 * v3 cumulative-ack safety: a frame of this socket was refused (not
	 * committed, not acked) and the socket is being closed. Every later frame
	 * of the socket is dropped unacked, so no ack can ever cover the refused one.
	 */
	private markFailed(socketId: string | undefined, seq = ++this.frameSeq): void {
		if (!this.config.groupCommit || !socketId) return;
		const existing = this.failedSockets.get(socketId);
		if (existing === undefined || seq < existing) this.failedSockets.set(socketId, seq);
	}

	/** v3: the frame arrived after a refused frame of its socket. */
	private afterFailure(frame: QueuedFrame): boolean {
		const point = this.failedSockets.get(frame.attachment.socketId);
		return point !== undefined && frame.seq > point;
	}

	/** `count` is false for a queued frame already counted in `authorityDrops` (one outcome per frame). */
	private rejectAuthority(socket: VaultSocketPort, count = true, socketId?: string, seq?: number): void {
		this.markFailed(socketId, seq);
		if (count) this.counters.authorityCloses++;
		this.requireHost().sendControl(socket, { type: "error", code: "authority_superseded", reason: "socket authority superseded" });
		try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "socket authority superseded"); } catch { /* closed */ }
	}

	/** Binary MESSAGE_SYNC on a relay body socket (outer tag already read). Synchronous. */
	handleSyncFrame(socket: VaultSocketPort, attachment: VaultSocketAttachment, decoder: decoding.Decoder): void {
		const host = this.requireHost();
		const message = readSyncMessage(decoder);
		const bodyId = attachment.documentId;
		if (message.kind === "step-1") {
			// G6: never serve body bytes to a socket whose authority was superseded (cached check).
			if (!this.validateActor(actorOf(attachment))) { this.rejectAuthority(socket, true, attachment.socketId); return; }
			let state: MergedEntry | null;
			try { state = this.fullState(bodyId); } catch (error) {
				if (!(error instanceof RelayMergeBudgetError)) throw error;
				this.replyStep2Unmerged(socket, attachment);
				return;
			}
			if (!state?.bytes) { socket.close(1008, "body is not active"); return; }
			if (state.epoch !== attachment.documentEpoch) {
				this.counters.epochFences++;
				host.fenceRelaySocket(socket, attachment, state.epoch);
				return;
			}
			this.counters.step2Replies++;
			try { socket.send(syncFrame(SYNC_STEP_2, diffUpdate(state.bytes, message.stateVector))); } catch { /* closed */ }
			this.replayPendingGroup(socket, attachment);
			return;
		}
		const update = message.update;
		const pending = this.pendingEnvelopes.get(attachment.socketId) ?? null;
		this.pendingEnvelopes.delete(attachment.socketId);
		// v3: the answer to a wake re-sync step1. Acks held since the step1 are
		// released once this step2 is durable (or adds nothing): only then can an
		// ack be cumulative over frames a dropped buffer lost (see ensureWakeResync).
		let released: Array<() => void> | null = null;
		if (message.kind === "step-2" && this.wakeHeld.has(attachment.socketId)) {
			released = this.wakeHeld.get(attachment.socketId)!;
			this.wakeHeld.delete(attachment.socketId);
		}
		if (update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			this.markFailed(attachment.socketId);
			this.counters.tooLargeCloses++;
			socket.close(1009, "sync update exceeds durable value limit");
			return;
		}
		let envelope: RelayEnvelope | null = null;
		let digest: string | null = null;
		if (pending) {
			digest = sha256HexSync(update);
			if (digest === pending.payloadDigest) envelope = pending;
			else this.counters.envelopeMismatches++;
		}
		const actor = actorOf(attachment);
		// 1. Empty skip (`[0,0]` handshake step2).
		if (update.byteLength === 0 || sameBytes(update, EMPTY_UPDATE_V1)) {
			this.counters.emptySkips++;
			if (released && !this.failedSockets.has(attachment.socketId)) for (const ack of released) this.postCommit(ack);
			if (envelope) this.ackNoop(socket, attachment, envelope, digest);
			return;
		}
		this.counters.updateFrames++;
		if (this.failedSockets.has(attachment.socketId)) { this.counters.failedSocketDrops++; return; }
		// 2. Authority (cached, invalidated by every in-process authority writer).
		// Before dedupe (G7): a revoked device gets 4403, never a re-ack.
		if (!this.validateActor(actor)) { this.rejectAuthority(socket, true, attachment.socketId); return; }
		// 3. Candidate dedupe.
		if (envelope?.candidateId) {
			const candidateDigest = envelope.candidateDigest ?? envelope.payloadDigest;
			const receipt = this.options.store().candidateReceipt(bodyId, attachment.deviceId, envelope.candidateId);
			if (receipt) {
				if (receipt.candidateDigest === candidateDigest) {
					this.counters.dedupeHits++;
					this.ackOrigin(socket, attachment, envelope, digest, {
						durableGeneration: receipt.durableGeneration, vaultSequence: receipt.vaultSequence,
						contentHashAccepted: false, deduped: true, noop: false,
					});
				} else {
					this.counters.dedupeConflicts++;
					host.sendControl(socket, { type: "BODY_UPDATE_REJECTED", clientFrameId: envelope.clientFrameId,
						candidateId: envelope.candidateId, reason: "candidate_id_reused" });
				}
				return;
			}
		}
		// 4. Budget: charged on the raw message before any parsing (admitRaw, R12).
		const frame: QueuedFrame = { socket, attachment, actor, update: update.slice(), envelope, digest, seq: ++this.frameSeq,
			...(released && released.length > 0 ? { onDurable: released } : {}) };
		if (this.config.groupCommit) {
			this.groupEnqueue(bodyId, frame);
			return;
		}
		if (this.config.microbatchMs > 0) {
			this.enqueue(bodyId, frame);
			return;
		}
		this.commitFrames(bodyId, [frame], false);
	}

	/** G3: batches are keyed by (body, epoch); frames of different epochs never share a commit. */
	private static batchKey(bodyId: string, epoch: SemanticEpoch): string {
		return `${bodyId}\u0000${epoch}`;
	}

	private enqueue(bodyId: string, frame: QueuedFrame): void {
		const key = RelayBodyService.batchKey(bodyId, frame.attachment.documentEpoch);
		const existing = this.batches.get(key);
		if (existing) {
			existing.frames.push(frame);
			return;
		}
		const timer = setTimeout(() => this.flushKey(bodyId, key), this.config.microbatchMs);
		this.batches.set(key, { frames: [frame], timer });
	}

	private flushKey(bodyId: string, key: string): void {
		const batch = this.batches.get(key);
		if (!batch) return;
		clearTimeout(batch.timer);
		this.batches.delete(key);
		this.commitFrames(bodyId, batch.frames, true);
	}

	/** Commits every pending micro-batch (and v3 group buffer) of a body now (timer, reset, tests, drain). */
	flushBatch(bodyId: string): void {
		const prefix = `${bodyId}\u0000`;
		for (const key of [...this.batches.keys()]) if (key.startsWith(prefix)) this.flushKey(bodyId, key);
		for (const key of [...this.groups.keys()]) if (key.startsWith(prefix)) this.flushGroup(key, "forced");
	}

	flushAllBatches(): void {
		for (const key of [...this.batches.keys()]) this.flushKey(key.slice(0, key.indexOf("\u0000")), key);
		for (const key of [...this.groups.keys()]) this.flushGroup(key, "forced");
	}

	// ---- v3 group commit ------------------------------------------------------

	/**
	 * v3 B1: epoch-check, broadcast now, buffer for the group commit. The frame
	 * already passed authority, dedupe and the rate budget (handleSyncFrame).
	 * Frames are re-screened at flush (authority G2, epoch, receipt ring, growth
	 * cap); an origin is acked only after the commit that made its frame durable.
	 */
	private groupEnqueue(bodyId: string, frame: QueuedFrame): void {
		const host = this.requireHost();
		const epoch = frame.attachment.documentEpoch;
		const head = this.options.store().documentHead(bodyId);
		if (!head) {
			this.markFailed(frame.attachment.socketId, frame.seq);
			this.counters.bodyInactiveCloses++;
			try { frame.socket.close(1008, "body is not active"); } catch { /* closed */ }
			return;
		}
		if (head.semanticEpoch !== epoch) {
			this.markFailed(frame.attachment.socketId, frame.seq);
			this.counters.epochFences++;
			host.fenceRelaySocket(frame.socket, frame.attachment, head.semanticEpoch);
			return;
		}
		this.counters.groupBroadcasts++;
		try {
			host.broadcastRelayUpdate(bodyId, epoch, syncFrame(SYNC_UPDATE, frame.update), frame.attachment.socketId);
		} catch (error) { this.recordPostCommitError(error); }
		const key = RelayBodyService.batchKey(bodyId, epoch);
		let group = this.groups.get(key);
		if (!group) {
			group = { bodyId, frames: [], bytes: 0, idleTimer: null, maxTimer: null };
			group.maxTimer = this.timers.set(() => this.flushGroup(key, "max"), this.config.gcMaxMs);
			this.groups.set(key, group);
		}
		group.frames.push(frame);
		group.bytes += frame.update.byteLength;
		if (group.idleTimer) this.timers.clear(group.idleTimer);
		group.idleTimer = this.timers.set(() => this.flushGroup(key, "idle"), this.idleDelay(key));
		if (group.bytes >= this.config.gcMaxBytes) this.flushGroup(key, "bytes");
	}

	/**
	 * v3 commit-rate cap: the idle timer fires at max(last frame + gcIdleMs,
	 * previous commit of the body + gcMinIntervalMs). Re-armed on every frame,
	 * so when it fires both conditions hold; a deferred idle flush is scheduled
	 * (never left waiting for the next frame). The max window (gcMaxMs after
	 * the group's first frame) still bounds every frame's wait.
	 */
	private idleDelay(key: string): number {
		const idle = this.config.gcIdleMs;
		const min = this.config.gcMinIntervalMs;
		if (min <= 0) return idle;
		const last = this.lastGroupCommit.get(key);
		if (last === undefined) return idle;
		const wait = last + min - this.now();
		if (wait <= idle) return idle;
		this.counters.groupIdleDeferred++;
		return wait;
	}

	private noteGroupCommit(key: string): void {
		if (this.config.gcMinIntervalMs <= 0) return;
		const now = this.now();
		this.lastGroupCommit.delete(key);
		this.lastGroupCommit.set(key, now);
		// Bounded: entries older than the interval no longer defer anything (insertion order = commit order).
		if (this.lastGroupCommit.size > 1024) {
			for (const [entry, at] of this.lastGroupCommit) {
				if (now - at < this.config.gcMinIntervalMs) break;
				this.lastGroupCommit.delete(entry);
			}
		}
	}

	private takeGroup(key: string): GroupBuffer | null {
		const group = this.groups.get(key);
		if (!group) return null;
		if (group.idleTimer) this.timers.clear(group.idleTimer);
		if (group.maxTimer) this.timers.clear(group.maxTimer);
		this.groups.delete(key);
		return group;
	}

	private flushGroup(key: string, reason: GroupFlushReason): void {
		const group = this.takeGroup(key);
		if (!group) return;
		if (reason === "idle") this.counters.groupFlushIdle++;
		else if (reason === "max") this.counters.groupFlushMax++;
		else if (reason === "bytes") this.counters.groupFlushBytes++;
		else if (reason === "read") this.counters.groupFlushReads++;
		else this.counters.groupFlushForced++;
		// Every commit (exempt reasons included) restarts the body's min interval.
		this.noteGroupCommit(key);
		this.commitFrames(group.bodyId, group.frames, true, true);
	}

	/**
	 * v3: an HTTP candidate or a currentness query for this body commits its
	 * buffered frames first, so the answer reflects every frame the relay has
	 * already received (no stale "not current" answer, and an HTTP fallback of
	 * bytes the relay holds finds them durable and is a no-op). Returns whether
	 * anything was flushed. No-op without group commit.
	 */
	flushForRead(bodyId: string): boolean {
		if (!this.config.groupCommit) return false;
		const prefix = `${bodyId}\u0000`;
		let flushed = false;
		for (const key of [...this.groups.keys()]) {
			if (!key.startsWith(prefix)) continue;
			this.flushGroup(key, "read");
			flushed = true;
		}
		return flushed;
	}

	/**
	 * v3 R11: call synchronously (same turn, no await in between) right before
	 * any authority write. Every buffered frame was authorised at receipt and
	 * already broadcast, so it is committed now, under the authority that relayed
	 * it; the writer then bumps the store's authorityVersion in the same turn, so
	 * the next frame of a revoked device misses the actor cache, fails the fresh
	 * check at receipt and is never broadcast nor buffered. Peers and durable
	 * state stay equal across the fence. No-op without group commit.
	 */
	flushForAuthorityFence(): void {
		if (!this.config.groupCommit) return;
		this.counters.authorityFenceFlushes++;
		for (const key of [...this.groups.keys()]) this.flushGroup(key, "forced");
	}

	/**
	 * v3 HTTP save (closed-note path): commits a candidate POST that
	 * VaultCandidateService already validated (ywasm apply, canonical markdown,
	 * exact content hash) through the group-commit store: tail 1 + head 1 +
	 * receipt ring 1 = 3 rows, instead of the base path's clock, journal,
	 * attribution, head upsert, catalog event, operation outcome and candidate
	 * receipt (14 rows). A candidate that changes nothing writes its ring entry
	 * only (1 row). The ring answers replay (candidateReceipt), digest reuse and
	 * GET operations/:id/outcome exactly like the base receipt rows. The catalog
	 * event is coalesced later from the tail's hash (as for relay frames).
	 * Buffered relay frames of the body commit first (same turn). Returns null
	 * when the path does not apply (flag off, merged update over the durable
	 * value limit): the caller uses the base path.
	 */
	commitHttpCandidate(input: { bodyId: string; bodyEpoch: SemanticEpoch; actor: VaultActorContext; candidateId: string;
		candidateDigest: string; updates: readonly Uint8Array[]; changesState: boolean;
		content: { contentHash: string; size: number } | null; runtimeEpoch: string }):
		| { ok: true; durableGeneration: number; vaultSequence: number; bodyEpoch: SemanticEpoch }
		| { ok: false; reason: "epoch_mismatch" | "body_not_active"; epoch: SemanticEpoch | null }
		| null {
		if (!this.config.groupCommit || !this.options.store().relayTail || input.updates.length === 0) return null;
		const update = input.updates.length === 1 ? input.updates[0]! : mergeUpdates([...input.updates]);
		if (update.byteLength > MAX_DURABLE_UPDATE_BYTES) return null;
		this.flushForRead(input.bodyId);
		const receipts = [{ actor: input.actor, candidateId: input.candidateId, candidateDigest: input.candidateDigest,
			runtimeEpoch: input.runtimeEpoch }];
		try {
			if (!input.changesState) {
				const recorded = this.options.relayStore().recordRelayReceipts({ bodyId: input.bodyId,
					expectedEpoch: input.bodyEpoch, receipts, receiptTtlMs: CANDIDATE_RECEIPT_TTL_MS, now: this.now() });
				this.counters.httpRelayNoops++;
				this.counters.rowsWritten += recorded.rowsWritten;
				return { ok: true, durableGeneration: recorded.generation, vaultSequence: recorded.vaultSequence,
					bodyEpoch: recorded.semanticEpoch };
			}
			const result = this.options.relayStore().appendRelayGroupCommit({
				bodyId: input.bodyId, expectedEpoch: input.bodyEpoch, update, lastActor: input.actor,
				catalogContent: input.content, receipts, receiptTtlMs: CANDIDATE_RECEIPT_TTL_MS, now: this.now(),
			});
			this.counters.httpRelayCommits++;
			this.counters.rowsWritten += result.rowsWritten;
			if (result.journalFallback) this.counters.tailJournalFallbacks++;
			if (result.tailBytes >= this.config.gcTailBytes || result.tailFrames >= RELAY_GC_TAIL_MAX_FRAMES
				|| result.journalFallback) {
				this.postCommit(() => { this.checkpointTail(input.bodyId); });
			}
			if (this.config.gcCatalogDelayMs > 0) this.postCommit(() => this.options.armCheckpointAlarm());
			// The merged-bytes cache revalidates against the durable head (headState).
			return { ok: true, durableGeneration: result.generation, vaultSequence: result.vaultSequence,
				bodyEpoch: result.semanticEpoch };
		} catch (error) {
			if (error instanceof RelayAppendError) {
				if (error.reason === "epoch_mismatch") this.invalidate(input.bodyId);
				return { ok: false, reason: error.reason === "epoch_mismatch" ? "epoch_mismatch" : "body_not_active",
					epoch: error.currentEpoch };
			}
			this.invalidate(input.bodyId);
			throw error;
		}
	}

	/** v3: frames buffered for a body/epoch were broadcast before this socket joined; send them after its step2. */
	private replayPendingGroup(socket: VaultSocketPort, attachment: VaultSocketAttachment): void {
		const group = this.groups.get(RelayBodyService.batchKey(attachment.documentId, attachment.documentEpoch));
		if (!group) return;
		for (const frame of group.frames) {
			if (frame.attachment.socketId === attachment.socketId) continue;
			this.counters.pendingReplayFrames++;
			try { socket.send(syncFrame(SYNC_UPDATE, frame.update)); } catch { return; }
		}
	}

	/** v3 pending group-commit state (diagnostics, tests). */
	pendingGroups(): Array<{ bodyId: string; frames: number; bytes: number }> {
		return [...this.groups.values()].map((group) => ({ bodyId: group.bodyId, frames: group.frames.length,
			bytes: group.bytes }));
	}

	/**
	 * TEST-ONLY crash simulation: drops every buffered group without committing
	 * or acking (an isolate eviction loses exactly this). Peers already have the
	 * frames (broadcast at receipt); origins resend their unacked frames on
	 * reconnect, and the next runtime's wake re-sync pulls state from peers.
	 */
	dropPendingGroupCommits(): number {
		let dropped = 0;
		for (const key of [...this.groups.keys()]) dropped += this.takeGroup(key)?.frames.length ?? 0;
		this.counters.groupDropped += dropped;
		return dropped;
	}

	/**
	 * v3 wake re-sync: once per runtime, send step1 (the durable state vector) to
	 * every open relay body socket admitted by an earlier runtime whose epoch is
	 * still current. Each client answers with a step2 of what the server lacks
	 * (e.g. frames a crashed runtime broadcast but never committed); a step2 the
	 * server already covers is a growth-cap no-op and writes no rows.
	 */
	ensureWakeResync(): number {
		if (!this.config.groupCommit || this.wakeResyncDone) return 0;
		const host = this.host;
		if (!host?.relayBodySockets) return 0;
		this.wakeResyncDone = true;
		const stateVectors = new Map<string, { epoch: SemanticEpoch; stateVector: Uint8Array } | null>();
		let sent = 0;
		for (const { socket, attachment } of host.relayBodySockets()) {
			if (attachment.runtimeEpoch === this.options.runtimeEpoch) continue;
			const bodyId = attachment.documentId;
			if (!stateVectors.has(bodyId)) {
				try {
					const state = this.headState(bodyId);
					stateVectors.set(bodyId, state ? { epoch: state.epoch, stateVector: state.stateVector } : null);
				} catch (error) {
					this.recordPostCommitError(error);
					stateVectors.set(bodyId, null);
				}
			}
			const state = stateVectors.get(bodyId);
			if (!state || state.epoch !== attachment.documentEpoch) continue;
			try {
				socket.send(syncFrame(SYNC_STEP_1, state.stateVector));
				sent++;
				// Hold this socket's acks until its step2 is durable: a frame it sent
				// before the wake may have been lost with the dropped buffer, and an
				// ack for a later frame would confirm it (cumulative acks).
				this.wakeHeld.set(attachment.socketId, []);
			} catch { /* closed */ }
		}
		this.counters.wakeResyncs++;
		this.counters.wakeResyncSockets += sent;
		return sent;
	}

	/**
	 * R12 raw admission, step 1: the very first thing the socket handler does
	 * with a message, before the attachment is parsed. O(1): a WeakMap lookup,
	 * the refused flag, a size compare and the bucket arithmetic. "unknown" =
	 * first message of this socket in this runtime (the caller parses the
	 * attachment and, for a relay socket, calls admitRelay).
	 */
	admitKnown(socket: object, message: string | ArrayBuffer, maxBytes: number): "pass" | "drop" | "unknown" {
		const gate = this.gates.get(socket);
		if (!gate) return "unknown";
		return this.charge(socket as VaultSocketPort, null, gate, message, maxBytes) ? "pass" : "drop";
	}

	/** R12: both admission steps for a socket whose attachment is already parsed (tests, direct callers). */
	admitRaw(socket: VaultSocketPort, attachment: VaultSocketAttachment, message: string | ArrayBuffer,
		maxBytes: number): boolean {
		const known = this.admitKnown(socket, message, maxBytes);
		return known === "unknown" ? this.admitRelay(socket, attachment, message, maxBytes) : known === "pass";
	}

	/** R12 raw admission, step 2: first message of a relay socket in this runtime (bucket keyed by socket id). */
	admitRelay(socket: VaultSocketPort, attachment: VaultSocketAttachment, message: string | ArrayBuffer,
		maxBytes: number): boolean {
		let gate = this.buckets.get(attachment.socketId);
		if (!gate) {
			gate = { tokens: this.config.burstBytes, at: this.now(), refused: false };
			this.buckets.set(attachment.socketId, gate);
		}
		this.gates.set(socket, gate);
		return this.charge(socket, attachment.socketId, gate, message, maxBytes);
	}

	/**
	 * Charges the raw received size (bytes for binary, UTF-16 units for text;
	 * every message kind: envelopes, step1/step2, updates, awareness, pings).
	 * The first overdraft or oversize message refuses the socket: cumulative-ack
	 * fence (frames buffered before it still commit and ack, nothing later is
	 * acked), 1013 "relay rate limit" (or 1009), and every later message of the
	 * socket is dropped here without any further work.
	 */
	private charge(socket: VaultSocketPort, socketId: string | null, gate: RawGate, message: string | ArrayBuffer,
		maxBytes: number): boolean {
		if (gate.refused) {
			this.counters.rawGateDrops++;
			if (peekSyncUpdate(message)) { this.counters.updateFrames++; this.counters.failedSocketDrops++; }
			return false;
		}
		const size = typeof message === "string" ? message.length : message.byteLength;
		const now = this.now();
		const elapsed = Math.max(0, now - gate.at);
		gate.tokens = Math.min(this.config.burstBytes, gate.tokens + (elapsed * this.config.rateBytesPerSec) / 1000);
		gate.at = now;
		const oversize = size > maxBytes;
		if (!oversize && gate.tokens >= size) {
			gate.tokens -= size;
			return true;
		}
		gate.refused = true;
		this.counters.rateGateCloses++;
		const id = socketId ?? this.socketIdOf(socket);
		this.markFailed(id ?? undefined);
		if (id !== null) this.pendingEnvelopes.delete(id);
		if (peekSyncUpdate(message)) {
			this.counters.updateFrames++;
			if (oversize) this.counters.tooLargeCloses++;
			else this.counters.rateLimitCloses++;
		}
		if (oversize) {
			try { socket.close(1009, "frame exceeds relay admission limit"); } catch { /* closed */ }
		} else {
			try { this.requireHost().sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" }); }
			catch { /* closed */ }
			try { socket.close(1013, "relay rate limit"); } catch { /* closed */ }
		}
		return false;
	}

	/** Socket id of a gated socket (refusal path only: one attachment read per refused socket). */
	private socketIdOf(socket: VaultSocketPort): string | null {
		try {
			const value = socket.deserializeAttachment() as { socketId?: unknown } | null;
			return typeof value?.socketId === "string" ? value.socketId : null;
		} catch { return null; }
	}

	/**
	 * G2 + G11 for queued frames: drop frames whose device lost authority since
	 * they were queued (4403, invariant #4 holds with batching on; v2 micro-batch
	 * only: v2 broadcasts after the commit; v3 commits them, see R11), and collapse
	 * repeated (device, candidateId) pairs inside the batch: the same digest is
	 * acked as a dedupe of the first frame's commit, a different digest is
	 * rejected `candidate_id_reused`. Returns the frames to commit and the
	 * duplicates to ack after the commit.
	 */
	private screenBatch(frames: QueuedFrame[], groupedBodyId: string | null = null):
		{ live: QueuedFrame[]; duplicates: QueuedFrame[] } {
		const live: QueuedFrame[] = [];
		const duplicates: QueuedFrame[] = [];
		const seen = new Map<string, string>();
		const revoked = new Set<string>();
		for (const frame of frames) {
			if (groupedBodyId !== null && this.afterFailure(frame)) {
				// An earlier frame of this socket was refused (e.g. one frame of an over-limit split failed).
				this.counters.failedSocketDrops++;
				continue;
			}
			if (revoked.has(frame.attachment.socketId) || !this.validateActor(frame.actor)) {
				if (groupedBodyId !== null) {
					// v3 R11: the frame passed authority at receipt and peers already applied
					// it (broadcast at receipt). Dropping it here diverged peers from durable
					// state, so commit it; close the socket 4403 with a fence after every
					// buffered frame (later frames are refused at receipt anyway).
					this.counters.revokedBroadcastCommits++;
					if (!revoked.has(frame.attachment.socketId)) this.rejectAuthority(frame.socket, false, frame.attachment.socketId);
					revoked.add(frame.attachment.socketId);
				} else {
					this.counters.authorityDrops++;
					if (!revoked.has(frame.attachment.socketId)) this.rejectAuthority(frame.socket, false, frame.attachment.socketId, frame.seq);
					revoked.add(frame.attachment.socketId);
					continue;
				}
			}
			const candidateId = frame.envelope?.candidateId;
			if (candidateId) {
				const key = `${frame.attachment.deviceId}\u0000${candidateId}`;
				const digest = frame.envelope!.candidateDigest ?? frame.envelope!.payloadDigest;
				if (groupedBodyId !== null && !seen.has(key)) {
					// v3: a resend that arrived while its first copy was still buffered
					// is found committed here (receipt ring): ack it as a dedupe (B6).
					const receipt = this.options.store().candidateReceipt(groupedBodyId, frame.attachment.deviceId, candidateId);
					if (receipt) {
						if (receipt.candidateDigest === digest) {
							this.counters.dedupeHits++;
							this.counters.groupFlushDedupes++;
							this.postCommit(() => this.ackOrigin(frame.socket, frame.attachment, frame.envelope!, frame.digest, {
								durableGeneration: receipt.durableGeneration, vaultSequence: receipt.vaultSequence,
								contentHashAccepted: false, deduped: true, noop: false,
							}));
						} else {
							this.counters.dedupeConflicts++;
							this.requireHost().sendControl(frame.socket, { type: "BODY_UPDATE_REJECTED",
								clientFrameId: frame.envelope!.clientFrameId, candidateId, reason: "candidate_id_reused" });
						}
						continue;
					}
				}
				const first = seen.get(key);
				if (first !== undefined) {
					this.counters.batchDuplicateCandidates++;
					if (first === digest) duplicates.push(frame);
					else {
						this.counters.dedupeConflicts++;
						this.requireHost().sendControl(frame.socket, { type: "BODY_UPDATE_REJECTED",
							clientFrameId: frame.envelope!.clientFrameId, candidateId, reason: "candidate_id_reused" });
					}
					continue;
				}
				seen.set(key, digest);
			}
			live.push(frame);
		}
		return { live, duplicates };
	}

	/**
	 * No silent drops (round 4, invariant #3): a throw before the append (ywasm
	 * merge/SV, head rebuild, SQL read) used to escape to the socket service,
	 * which answered VAULT_ERROR and kept the socket open, so the origin never
	 * learned the frame was lost and every later update of that client stayed
	 * pending at peers. Now every frame of the failed commit gets VAULT_ERROR and
	 * a 1011 close (the client reconnects and resends its unacked updates), the
	 * merged cache of the body is dropped, and `frameErrors` counts it. The
	 * micro-batch timer path goes through here too, so a throw there can no
	 * longer escape a setTimeout callback.
	 */
	private commitFrames(bodyId: string, frames: QueuedFrame[], batched: boolean, grouped = false): void {
		let appended = false;
		try {
			this.commitFramesUnguarded(bodyId, frames, batched, () => { appended = true; }, grouped);
		} catch (error) {
			if (appended) {
				// Unreachable in practice: post-commit steps are individually guarded.
				this.recordPostCommitError(error);
				return;
			}
			this.failFrames(bodyId, frames, error);
		}
	}

	/** Pre-append failure of one frame or batch: count, log, VAULT_ERROR, close 1011. */
	failFrames(bodyId: string, frames: ReadonlyArray<{ socket: VaultSocketPort; attachment?: { socketId: string };
		seq?: number }>, error: unknown): void {
		for (const frame of frames) this.markFailed(frame.attachment?.socketId, frame.seq);
		this.counters.frameErrors += Math.max(1, frames.length);
		const message = error instanceof Error ? error.message : String(error);
		this.lastFrameError = { at: this.now(), message: message.slice(0, 200) };
		try { this.invalidate(bodyId); } catch { /* cache already gone */ }
		console.error("[yaos-relay] frame error", message);
		for (const frame of frames) {
			try {
				this.requireHost().sendControl(frame.socket, { type: "VAULT_ERROR", code: "relay_frame_error",
					message: "update was not committed; reconnect to resend" });
			} catch { /* closed */ }
			try { frame.socket.close(1011, "relay frame error"); } catch { /* closed */ }
		}
	}

	private recordPostCommitError(error: unknown): void {
		this.counters.postCommitErrors++;
		console.error("[yaos-relay] post-commit step failed", error instanceof Error ? error.message : String(error));
	}

	/** Runs one post-commit step; a throw is counted and the next steps still run. */
	private postCommit(step: () => void): void {
		try { step(); } catch (error) { this.recordPostCommitError(error); }
	}

	/** Steps 5–7: growth cap, single-transaction commit, then acks and fan-out. */
	private commitFramesUnguarded(bodyId: string, frames: QueuedFrame[], batched: boolean, markAppended: () => void,
		grouped = false): void {
		const host = this.requireHost();
		const { live, duplicates } = batched ? this.screenBatch(frames, grouped ? bodyId : null)
			: { live: frames, duplicates: [] as QueuedFrame[] };
		if (live.length === 0) return;
		const epoch = live[0]!.attachment.documentEpoch;
		const state = this.headState(bodyId);
		if (!state) {
			this.counters.bodyInactiveCloses += live.length;
			for (const frame of live) {
				this.markFailed(frame.attachment.socketId, frame.seq);
				try { frame.socket.close(1008, "body is not active"); } catch { /* closed */ }
			}
			return;
		}
		if (state.epoch !== epoch) {
			for (const frame of live) {
				this.markFailed(frame.attachment.socketId, frame.seq);
				this.counters.epochFences++;
				host.fenceRelaySocket(frame.socket, frame.attachment, state.epoch);
			}
			return;
		}
		const update = live.length === 1 ? live[0]!.update : mergeUpdates(live.map((frame) => frame.update));
		if (update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			// Only reachable by micro-batching many near-limit frames: commit one by one.
			for (const frame of live) this.commitFrames(bodyId, [frame], grouped, grouped);
			for (const frame of duplicates) this.ackNoop(frame.socket, frame.attachment, frame.envelope!, frame.digest);
			return;
		}
		// 5. Growth cap. Small bodies: exact byte merge (no-op iff merged bytes are
		// unchanged) and an exact merged SV. Large bodies (K3: whole-state merge/SV
		// costs 7-14 ms for 5-10 MB): incremental SV (pointwise max with the
		// update's SV) and a resend-only no-op check; bytes are rebuilt lazily.
		const exact = state.bytes !== null && state.bytes.byteLength <= this.config.exactMergeBytes;
		let nextMerged: Uint8Array | null = null;
		let nextStateVector: Uint8Array;
		let noop: boolean;
		if (exact) {
			nextMerged = mergeUpdates([state.bytes!, update]);
			noop = sameBytes(nextMerged, state.bytes!);
			nextStateVector = noop ? state.stateVector : stateVectorFromUpdate(nextMerged);
		} else {
			noop = state.lastUpdate !== null && sameBytes(state.lastUpdate, update);
			const updateStateVector = stateVectorFromUpdate(update);
			if (!noop && grouped && state.bytes !== null && !state.overBudget
				&& stateVectorCoveredBy(updateStateVector, state.stateVector)) {
				// v3: a covered update on a large body (a wake re-sync step2, a resend)
				// gets the exact check, so it writes no tail row when it adds nothing.
				noop = sameBytes(mergeUpdates([state.bytes, update]), state.bytes);
			}
			nextStateVector = noop ? state.stateVector : maxStateVector(state.stateVector, updateStateVector);
		}
		if (noop) {
			this.counters.noopSkips += live.length + duplicates.length;
			for (const frame of [...live, ...duplicates]) {
				if (frame.envelope) this.ackNoop(frame.socket, frame.attachment, frame.envelope, frame.digest, state);
			}
			this.releaseHeld(live);
			return;
		}
		if (!exact) this.counters.incrementalAppends++;
		// D6 currentness: the newest paired claim whose SV equals the merged SV,
		// and only when that SV is exact (G8): the incremental SV of the large-body
		// path can overstate the head (update gaps), so claims there stay unknown.
		let acceptedIndex = -1;
		for (let index = exact ? live.length - 1 : -1; index >= 0; index--) {
			const envelope = live[index]!.envelope;
			if (envelope?.stateVector && envelope.contentHash !== undefined && envelope.size !== undefined
				&& stateVectorsEqual(envelope.stateVector, nextStateVector)) {
				acceptedIndex = index;
				break;
			}
		}
		const accepted = acceptedIndex >= 0 ? live[acceptedIndex]!.envelope! : null;
		const receipts = live.flatMap((frame) => frame.envelope?.candidateId ? [{
			clientId: frame.attachment.deviceId,
			candidateId: frame.envelope.candidateId,
			candidateDigest: frame.envelope.candidateDigest ?? frame.envelope.payloadDigest,
			runtimeEpoch: frame.attachment.runtimeEpoch,
		}] : []);
		let result: ReturnType<RelayBodyStore["appendRelayBodyUpdate"]> & { tailFrames?: number; tailBytes?: number;
			journalFallback?: boolean };
		try {
			result = grouped ? this.options.relayStore().appendRelayGroupCommit({
				bodyId,
				expectedEpoch: epoch,
				update,
				lastActor: live[live.length - 1]!.actor,
				catalogContent: accepted ? { contentHash: accepted.contentHash!, size: accepted.size! } : null,
				receipts: live.flatMap((frame) => frame.envelope?.candidateId ? [{
					actor: frame.actor,
					candidateId: frame.envelope.candidateId,
					candidateDigest: frame.envelope.candidateDigest ?? frame.envelope.payloadDigest,
					runtimeEpoch: frame.attachment.runtimeEpoch,
				}] : []),
				receiptTtlMs: CANDIDATE_RECEIPT_TTL_MS,
				now: this.now(),
			}) : this.options.relayStore().appendRelayBodyUpdate({
				bodyId,
				expectedEpoch: epoch,
				update,
				attributions: live.map((frame) => frame.envelope?.candidateId
					? { actor: frame.actor, operationId: frame.envelope.candidateId,
						requestDigest: frame.envelope.candidateDigest ?? frame.envelope.payloadDigest }
					: { actor: frame.actor, ...(frame.digest ? { requestDigest: frame.digest } : {}) }),
				catalogContent: accepted ? { contentHash: accepted.contentHash!, size: accepted.size! } : null,
				receipts,
				now: this.now(),
			});
		} catch (error) {
			if (error instanceof RelayAppendError) {
				if (error.reason === "epoch_mismatch" && error.currentEpoch !== null) {
					this.invalidate(bodyId);
					for (const frame of live) {
						this.markFailed(frame.attachment.socketId, frame.seq);
						this.counters.epochFences++;
						host.fenceRelaySocket(frame.socket, frame.attachment, error.currentEpoch);
					}
					return;
				}
				this.counters.bodyInactiveCloses += live.length;
				for (const frame of live) {
					this.markFailed(frame.attachment.socketId, frame.seq);
					try { frame.socket.close(1008, "body is not active"); } catch { /* closed */ }
				}
				return;
			}
			this.counters.commitFailures += live.length;
			this.invalidate(bodyId);
			console.warn("[yaos-relay] append failed", error);
			for (const frame of live) {
				this.markFailed(frame.attachment.socketId, frame.seq);
				host.sendControl(frame.socket, { type: "VAULT_ERROR", code: "durability_failed",
					message: "update was not committed; reconnect to resend" });
				try { frame.socket.close(1011, "durable commit failed"); } catch { /* closed */ }
			}
			return;
		}
		markAppended();
		this.counters.appends++;
		this.counters.appendFrames += live.length;
		this.counters.rowsWritten += result.rowsWritten;
		if (grouped) {
			this.counters.groupCommits++;
			this.counters.groupFrames += live.length;
			if (result.journalFallback) this.counters.tailJournalFallbacks++;
		}
		if (accepted) this.counters.hashAccepted++;
		else this.counters.hashUnknown++;
		// Everything below runs after a durable append: each step is guarded so a
		// throw in one (cache bookkeeping, one origin's ack) can never cost a peer
		// its fan-out frame (a missing update would leave every later update of
		// that client pending at the peer).
		this.postCommit(() => {
			const now = this.now();
			this.appendTimes.push(now);
			while (this.appendTimes.length > 0 && this.appendTimes[0]! < now - 10_000) this.appendTimes.shift();
		});
		const entry: MergedEntry = {
			epoch,
			latestSequence: result.vaultSequence,
			generation: result.generation,
			bytes: nextMerged,
			stateVector: nextStateVector,
			stateVectorExact: exact && state.stateVectorExact,
			lastUpdate: update.byteLength <= 64 * 1024 ? update : null,
			tailEntries: state.tailEntries + 1,
			tailBytes: state.tailBytes + update.byteLength,
			checkpointSequence: state.checkpointSequence,
			...(state.overBudget ? { overBudget: true } : {}),
		};
		this.postCommit(() => {
			try { this.remember(bodyId, entry); }
			catch (error) { this.invalidate(bodyId); throw error; }
		});
		this.postCommit(() => this.syncDocumentCache(bodyId));
		// 7. After commit: origin acks, peer fan-out, base notices.
		for (const [index, frame] of live.entries()) {
			if (!frame.envelope) continue;
			this.postCommit(() => this.ackOrigin(frame.socket, frame.attachment, frame.envelope!, frame.digest, {
				durableGeneration: result.generation, vaultSequence: result.vaultSequence,
				contentHashAccepted: index === acceptedIndex, deduped: false, noop: false,
				contentHash: result.contentHash, size: result.size,
			}));
		}
		for (const frame of duplicates) {
			this.postCommit(() => this.ackOrigin(frame.socket, frame.attachment, frame.envelope!, frame.digest, {
				durableGeneration: result.generation, vaultSequence: result.vaultSequence,
				contentHashAccepted: false, deduped: true, noop: false,
				contentHash: result.contentHash, size: result.size,
			}));
		}
		this.releaseHeld(live);
		const origins = new Set([...live, ...duplicates].map((frame) => frame.attachment.socketId));
		// v3: peers got every frame at receipt (groupEnqueue); no second fan-out.
		if (!grouped) {
			for (const frame of live) {
				this.postCommit(() => host.broadcastRelayUpdate(bodyId, epoch, syncFrame(SYNC_UPDATE, frame.update),
					frame.attachment.socketId));
			}
		}
		// G16: every origin gets exactly its own ack, never a peer notice as well.
		this.postCommit(() => host.notifyBodyCommitted(bodyId, result.generation, result.vaultSequence, origins));
		if (grouped) {
			// v3: no alarm per commit (setAlarm is a written row). The tail cap
			// checkpoints inline, off the ack path; catalog coalescing rides along.
			if ((result.tailBytes ?? 0) >= this.config.gcTailBytes || (result.tailFrames ?? 0) >= RELAY_GC_TAIL_MAX_FRAMES
				|| result.journalFallback) {
				this.postCommit(() => { this.checkpointTail(bodyId); });
			}
			// The catalog delta feed lags until a coalescing pass; the host arms the
			// alarm at most once per gcCatalogDelayMs window (deduped in-memory).
			if (this.config.gcCatalogDelayMs > 0) this.postCommit(() => this.options.armCheckpointAlarm());
			return;
		}
		// Lean rows: every append leaves a catalog event to coalesce (the host delays this alarm).
		if (this.options.store().leanRows || entry.tailEntries >= this.config.checkpointEntries || entry.tailBytes >= this.config.checkpointBytes) {
			this.postCommit(() => this.options.armCheckpointAlarm());
		}
	}

	/**
	 * v3 B2: checkpoint a body whose tail reached the cap. Coalesces its catalog
	 * event first (the tail row carries the accepted hash; the checkpoint drops
	 * it), then writes the byte-merged checkpoint at the head, which deletes the
	 * tail row in the same transaction (records an active pin needs move to
	 * journal rows). Returns the checkpoint result, or null when nothing ran.
	 */
	checkpointTail(bodyId: string): ReturnType<RelayBodyService["checkpointBody"]> {
		if (this.isOverBudget(bodyId)) return null;
		const coalesced = this.options.relayStore().coalesceLeanCatalog({ bodyId });
		this.counters.leanCatalogEvents += coalesced.bodies;
		this.counters.leanCoalesceRowsWritten += coalesced.rowsWritten;
		const written = this.checkpointBody(bodyId);
		if (written) this.counters.tailCheckpoints++;
		return written;
	}

	/**
	 * G5: a relay append never runs ywasm on a resident base-path document (the
	 * HTTP candidate path may have one loaded). A clean resident is discarded (the
	 * next user reloads from durable state). A dirty one (pending base-path queue
	 * entries, not reachable for relay bodies in practice) or one with a staged
	 * candidate validation is left alone and remembered; `evictStaleResidents`
	 * drops it once it is clean. Neither case applies the update in-process.
	 */
	private syncDocumentCache(bodyId: string): void {
		const loaded = this.options.cache.get(bodyId);
		if (!loaded) return;
		if (!loaded.dirty && !loaded.validationPending && this.options.cache.pendingFor(bodyId).length === 0) {
			this.options.cache.discardResident(bodyId);
			this.staleResidents.delete(bodyId);
			return;
		}
		this.counters.residentStaleSkips++;
		this.staleResidents.add(bodyId);
	}

	/** Drops resident documents a relay append left stale, once they are clean (alarm pass). */
	evictStaleResidents(): number {
		let evicted = 0;
		for (const bodyId of [...this.staleResidents]) {
			const loaded = this.options.cache.get(bodyId);
			if (!loaded) { this.staleResidents.delete(bodyId); continue; }
			if (loaded.dirty || loaded.validationPending || this.options.cache.pendingFor(bodyId).length > 0) continue;
			this.options.cache.discardResident(bodyId);
			this.staleResidents.delete(bodyId);
			evicted++;
		}
		return evicted;
	}

	/** True while a relay append left this body's resident document behind the durable head. */
	residentIsStale(bodyId: string): boolean {
		return this.staleResidents.has(bodyId);
	}

	/** v3: a wake re-sync step2 in `frames` is durable (or a no-op): send the acks held behind it. */
	private releaseHeld(frames: QueuedFrame[]): void {
		for (const frame of frames) {
			if (!frame.onDurable) continue;
			const acks = frame.onDurable;
			delete frame.onDurable;
			if (this.failedSockets.has(frame.attachment.socketId)) continue;
			for (const ack of acks) this.postCommit(ack);
		}
	}

	private ackNoop(socket: VaultSocketPort, attachment: VaultSocketAttachment, envelope: RelayEnvelope,
		digest: string | null, state?: MergedEntry): void {
		const head = state ?? this.headState(attachment.documentId);
		this.ackOrigin(socket, attachment, envelope, digest, {
			durableGeneration: head?.generation ?? 0, vaultSequence: head?.latestSequence ?? 0,
			contentHashAccepted: false, deduped: false, noop: true,
		});
	}

	private ackOrigin(socket: VaultSocketPort, attachment: VaultSocketAttachment, envelope: RelayEnvelope,
		digest: string | null, fields: { durableGeneration: number; vaultSequence: number; contentHashAccepted: boolean;
			deduped: boolean; noop: boolean; contentHash?: string | null; size?: number | null }): void {
		const held = this.wakeHeld.get(attachment.socketId);
		if (held) {
			// v3: wake re-sync step2 outstanding; sent once that step2 is durable.
			if (held.length >= WAKE_HELD_ACKS_MAX) { this.counters.wakeHeldAcksDropped++; return; }
			this.counters.wakeHeldAcks++;
			held.push(() => this.ackOrigin(socket, attachment, envelope, digest, fields));
			return;
		}
		const catalog = fields.contentHash === undefined
			? this.options.store().getCatalogHeadAt(this.options.store().currentSequence(), attachment.documentId)
			: null;
		this.requireHost().sendControl(socket, {
			type: "BODY_COMMITTED",
			bodyId: attachment.documentId,
			bodyEpoch: attachment.documentEpoch,
			vaultGeneration: attachment.vaultGeneration,
			durableGeneration: fields.durableGeneration,
			vaultSequence: fields.vaultSequence,
			lifecycle: "active",
			contentHash: fields.contentHash !== undefined ? fields.contentHash : catalog?.contentHash ?? null,
			size: fields.size !== undefined ? fields.size : catalog?.size ?? null,
			runtimeEpoch: attachment.runtimeEpoch,
			relay: true,
			clientFrameId: envelope.clientFrameId,
			...(envelope.candidateId ? { candidateId: envelope.candidateId } : {}),
			...(envelope.candidateId ? { candidateDigest: envelope.candidateDigest ?? envelope.payloadDigest } : {}),
			payloadDigest: digest ?? envelope.payloadDigest,
			commitRuntimeEpoch: this.options.runtimeEpoch,
			contentHashAccepted: fields.contentHashAccepted,
			deduped: fields.deduped,
			noop: fields.noop,
		});
	}

	// ---- checkpoint (D5.3: byte merge, no document) -------------------------

	/** Writes a byte-merged checkpoint at the exact durable head. Returns null when nothing to do. */
	checkpointBody(bodyId: string): { rowsWritten: number; ms: number; tailEntries: number; bytes: number;
		partial: boolean } | null {
		const startedAt = performance.now();
		const head = this.options.store().documentHead(bodyId);
		if (!head) return null;
		const tail = this.options.store().documentJournalTailStats(bodyId);
		if (tail.entries === 0) return null;
		// K3: merge cost is superlinear in frame count, so merge checkpoint + at most
		// `checkpointMaxRows` tail rows per pass; the alarm re-arms for the rest.
		// G20: the prefix is also bounded by bytes, so checkpoint + prefix input
		// stays within `maxMergeInputBytes` and big bodies advance incrementally.
		const relayStore = this.options.relayStore();
		const checkpointBytes = relayStore.checkpointByteLength(bodyId, tail.checkpointSequence);
		const budget = this.config.maxMergeInputBytes;
		let throughSequence = head.latestSequence;
		if (tail.entries > this.config.checkpointMaxRows || checkpointBytes + tail.bytes > budget) {
			if (this.options.store().relayTailRow(bodyId)) {
				// v3: prefix checkpoints are journal-only; a tailed body over the budget
				// stays checkpoint + tail (the tail is hard-capped; past it groups fall
				// back to journal rows) until a client semantic reset shrinks it.
				if (checkpointBytes + tail.bytes > budget) {
					this.markOverBudget(bodyId, head.semanticEpoch, checkpointBytes + tail.bytes);
					return null;
				}
			} else {
			const prefix = relayStore.tailPrefixBounded(bodyId, tail.checkpointSequence, this.config.checkpointMaxRows,
				budget - checkpointBytes);
			if (!prefix) {
				// Not even one tail row fits next to the checkpoint: the body stays
				// checkpoint + tail until a client semantic reset shrinks it.
				this.markOverBudget(bodyId, head.semanticEpoch, checkpointBytes + tail.bytes);
				return null;
			}
			throughSequence = prefix.sequence;
			}
		}
		let durable: ReturnType<VaultStore["durableMergedBytes"]>;
		const cached = this.merged.get(bodyId);
		try {
			// Round 4 (mb=0 tails): the in-memory merged bytes already equal checkpoint +
			// tail at the head, so a full checkpoint skips the SQLite read and wasm merge.
			if (throughSequence === head.latestSequence && cached?.bytes && !cached.overBudget
				&& cached.epoch === head.semanticEpoch && cached.latestSequence === head.latestSequence
				&& cached.generation === head.generation) {
				this.counters.checkpointsFromCache++;
				durable = { documentId: bodyId, throughSequence: head.latestSequence, latestSequence: head.latestSequence,
					generation: head.generation, semanticEpoch: head.semanticEpoch, checkpointSequence: tail.checkpointSequence,
					tailEntries: tail.entries, tailBytes: tail.bytes, bytes: cached.bytes, rowsRead: 0 };
			} else {
				durable = this.options.store().durableMergedBytes(bodyId, throughSequence, budget);
			}
		} catch (error) {
			if (!(error instanceof RelayMergeBudgetError)) throw error;
			// Never call into wasm past the budget (defence in depth; the prefix is sized to fit).
			this.markOverBudget(bodyId, head.semanticEpoch, error.inputBytes);
			return null;
		}
		if (durable.tailEntries === 0) return null;
		const partial = throughSequence < head.latestSequence;
		if (!partial) durable = { ...durable, bytes: this.gcCompacted(durable.bytes) };
		const written = partial
			? this.options.store().writeRelayCheckpointThrough(bodyId, durable.bytes, {
				throughSequence, generation: durable.generation, semanticEpoch: head.semanticEpoch })
			: this.options.store().writeCheckpointFromEncodedState(bodyId, durable.bytes, {
				throughSequence: head.latestSequence, generation: head.generation, semanticEpoch: head.semanticEpoch });
		const ms = performance.now() - startedAt;
		this.counters.checkpoints++;
		if (partial) this.counters.partialCheckpoints++;
		this.counters.lastCheckpointMs = ms;
		this.counters.checkpointRowsWritten += written.rowsWritten;
		if (partial) {
			this.invalidate(bodyId);
		} else {
			const previous = this.merged.get(bodyId);
			const stateVector = stateVectorFromUpdate(durable.bytes);
			if (previous && !previous.stateVectorExact && previous.latestSequence === head.latestSequence
				&& !stateVectorsEqual(previous.stateVector, stateVector)) this.counters.stateVectorDrift++;
			this.remember(bodyId, {
				epoch: head.semanticEpoch, latestSequence: head.latestSequence, generation: head.generation,
				bytes: durable.bytes, stateVector, stateVectorExact: true, lastUpdate: previous?.lastUpdate ?? null,
				tailEntries: 0, tailBytes: 0, checkpointSequence: head.latestSequence,
			});
		}
		return { rowsWritten: written.rowsWritten, ms, tailEntries: durable.tailEntries,
			bytes: durable.bytes.byteLength, partial };
	}

	/** Drops deleted-item content from a byte-merged state (same identities, same state vector); never throws. */
	private gcCompacted(bytes: Uint8Array): Uint8Array {
		if (bytes.byteLength <= RELAY_GC_COMPACT_MIN_BYTES || bytes.byteLength > RELAY_GC_COMPACT_MAX_BYTES) return bytes;
		let doc: ReturnType<typeof crdtEngine.openDocument> | null = null;
		try {
			doc = crdtEngine.openDocument("relay-checkpoint-gc", bytes);
			const compacted = crdtEngine.encodeStateAsUpdate(doc);
			if (compacted.byteLength >= bytes.byteLength) return bytes;
			this.counters.checkpointGcCompactions++;
			this.counters.checkpointGcBytesDropped += bytes.byteLength - compacted.byteLength;
			return compacted;
		} catch {
			return bytes;
		} finally {
			if (doc) crdtEngine.destroyDocument(doc);
		}
	}

	private overBudgetMarkers(): Map<string, number> {
		this.overBudgetBodies ??= this.options.relayStore().overBudgetMarkers();
		return this.overBudgetBodies;
	}

	private markOverBudget(bodyId: string, epoch: SemanticEpoch, inputBytes: number): void {
		this.counters.mergeBudgetRejects++;
		this.overBudgetMarkers().set(bodyId, epoch);
		this.options.relayStore().markOverBudget(bodyId, epoch, inputBytes, this.now());
	}

	/** True while the checkpoint of this body cannot progress within the merge budget (this epoch). */
	isOverBudget(bodyId: string): boolean {
		const epoch = this.overBudgetMarkers().get(bodyId);
		if (epoch === undefined) return false;
		if (this.options.store().documentHead(bodyId)?.semanticEpoch === epoch) return true;
		this.overBudgetMarkers().delete(bodyId);
		this.options.relayStore().clearOverBudget(bodyId);
		return false;
	}

	/**
	 * One relay checkpoint pass (the DO alarm): byte-merge checkpoints for the
	 * bodies over the relay thresholds, then (G1) advance the feed floor so the
	 * journal rows those checkpoints cover are pruned. The floor keeps the last
	 * `retainSequences` sequences and stops below the oldest active pin, so
	 * relay-only workloads have a bounded journal without `maintain()`.
	 */
	runCheckpointPass(options: { retainSequences: number; skip?: (bodyId: string) => boolean; limit?: number }):
		{ checkpoints: number; retry: boolean; floor: number; rowsPruned: number } {
		const store = this.options.store();
		let checkpoints = 0;
		let retry = false;
		let coalesceFailed = false;
		this.evictStaleResidents();
		if (store.leanRows) {
			// §6.4: publish coalesced catalog events before any journal row can be pruned.
			try {
				const coalesced = this.options.relayStore().coalesceLeanCatalog({ limit: 200 });
				this.counters.leanCatalogEvents += coalesced.bodies;
				this.counters.leanCoalesceRowsWritten += coalesced.rowsWritten;
				if (coalesced.bodies >= 200 || coalesced.more) retry = true;
			} catch (error) {
				retry = true;
				coalesceFailed = true;
				console.warn("[yaos-relay] lean catalog coalesce failed", error);
			}
		}
		for (const bodyId of store.listJournalCheckpointCandidates(
			this.config.checkpointEntries, this.config.checkpointBytes, options.limit ?? 25,
		)) {
			if (options.skip?.(bodyId) || this.isOverBudget(bodyId)) continue;
			try {
				const written = this.checkpointBody(bodyId);
				if (written) checkpoints++;
				if (written?.partial || this.needsCheckpoint(bodyId)) retry = true;
			} catch (error) {
				retry = true;
				console.warn("[yaos-relay] checkpoint failed", error);
			}
		}
		if (store.relayTail) {
			for (const bodyId of this.options.relayStore().tailCheckpointCandidates(this.config.gcTailBytes,
				RELAY_GC_TAIL_MAX_FRAMES, options.limit ?? 25)) {
				if (options.skip?.(bodyId)) continue;
				try { if (this.checkpointTail(bodyId)) checkpoints++; }
				catch (error) { retry = true; console.warn("[yaos-relay] tail checkpoint failed", error); }
			}
		}
		let rowsPruned = 0;
		const now = this.now();
		const pins = store.activePins(now);
		let floor = Math.max(0, store.currentSequence() - options.retainSequences);
		for (const pin of pins) floor = Math.min(floor, pin.boundarySequence - 1);
		if (!coalesceFailed && floor > store.journalFloor()) {
			try {
				rowsPruned = store.advanceFeedFloor(floor, now).rowsWritten;
				this.counters.floorAdvances++;
				this.counters.floorRowsPruned += rowsPruned;
			} catch (error) {
				console.warn("[yaos-relay] feed floor advance failed", error);
			}
		}
		return { checkpoints, retry, floor: store.journalFloor(), rowsPruned };
	}

	/** True when a body's journal tail is over the relay checkpoint thresholds. */
	needsCheckpoint(bodyId: string): boolean {
		if (this.isOverBudget(bodyId)) return false;
		const tail = this.options.store().documentJournalTailStats(bodyId);
		return tail.entries >= this.config.checkpointEntries || tail.bytes >= this.config.checkpointBytes;
	}

	// ---- HTTP ---------------------------------------------------------------

	/**
	 * Body state for HTTP reads: merged stored bytes + catalog hash. An unknown
	 * (NULL) hash is materialised once off the hot path and backfilled in place
	 * (the one remaining relay-mode document materialisation on reads; counted
	 * in `materialisations` and in the store's `documentMaterialisations`).
	 */
	bodyHttpState(bodyId: string): { bytes: Uint8Array; generation: number; semanticEpoch: SemanticEpoch;
		latestSequence: number; contentHash: string | null; size: number | null; materialised: boolean;
		hashState: "known" | "materialised" | "unknown" } | null {
		const state = this.fullState(bodyId);
		const catalog = this.options.store().getCatalogHeadAt(this.options.store().currentSequence(), bodyId);
		if (!state || !catalog) return null;
		const base = { bytes: state.bytes, generation: state.generation, semanticEpoch: state.epoch,
			latestSequence: state.latestSequence };
		if (catalog.contentHash !== null && catalog.size !== null) {
			return { ...base, contentHash: catalog.contentHash, size: catalog.size, materialised: false, hashState: "known" };
		}
		const cached = this.lazyHashes.get(bodyId);
		if (cached && cached.epoch === state.epoch && cached.sequence === state.latestSequence) {
			// G4: backfill normally makes the hash "known"; this covers a refused backfill.
			this.counters.lazyHashCacheHits++;
			return { ...base, contentHash: cached.contentHash, size: cached.size, materialised: false, hashState: "known" };
		}
		if (state.bytes.byteLength > this.config.lazyHashMaxBytes) {
			// A document for a large (possibly struct-dense) body can exceed the
			// wasm budget; leave the hash unknown until a client reset/hash claim.
			this.counters.lazyHashSkips++;
			return { ...base, contentHash: null, size: null, materialised: false, hashState: "unknown" };
		}
		const reconstructed = this.options.store().reconstructDocument(bodyId);
		try {
			const content = canonicalMarkdownBytes(crdtEngine.readText(reconstructed.doc, "body"));
			const contentHash = sha256HexSync(content);
			this.counters.materialisations++;
			this.options.relayStore().backfillCatalogHash(bodyId, catalog.sequence, contentHash, content.byteLength);
			this.lazyHashes.delete(bodyId);
			this.lazyHashes.set(bodyId, { epoch: state.epoch, sequence: state.latestSequence, contentHash,
				size: content.byteLength });
			while (this.lazyHashes.size > 256) this.lazyHashes.delete(this.lazyHashes.keys().next().value!);
			return { ...base, contentHash, size: content.byteLength, materialised: true, hashState: "materialised" };
		} finally {
			crdtEngine.destroyDocument(reconstructed.doc);
		}
	}

	/** HEAD body: durable head + catalog only (no byte merge, no document; the hash may be unknown). */
	bodyHttpHead(bodyId: string): { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number;
		contentHash: string | null; size: number | null; hashState: "known" | "unknown" } | null {
		const head = this.options.store().documentHead(bodyId);
		const catalog = this.options.store().getCatalogHeadAt(this.options.store().currentSequence(), bodyId);
		if (!head || !catalog) return null;
		const known = catalog.contentHash !== null && catalog.size !== null;
		return { generation: head.generation, semanticEpoch: head.semanticEpoch, latestSequence: head.latestSequence,
			contentHash: known ? catalog.contentHash : null, size: known ? catalog.size : null,
			hashState: known ? "known" : "unknown" };
	}

	acquireLease(bodyId: string, actor: VaultActorContext, expectedEpoch: number, ttlMs: number | undefined):
		RelayLeaseResult & { stateVector?: string } {
		// G19: the route authorised before reading the body; re-check (cached) now.
		if (!this.validateActor(actor)) {
			this.counters.leaseDenials++;
			return { granted: false, reason: "authority_superseded", epoch: null, headSequence: null };
		}
		const result = this.options.relayStore().acquireLease(bodyId, actor, expectedEpoch, ttlMs, this.now(),
			this.config.resetCooldownMs);
		if (!result.granted) {
			this.counters.leaseDenials++;
			return result;
		}
		this.counters.leaseGrants++;
		const state = this.headState(bodyId);
		return { ...result, stateVector: bytesToBase64(state?.stateVector ?? new Uint8Array([0])) };
	}

	resetPolicy(bodyId: string): RelayResetPolicyState {
		return this.options.relayStore().resetPolicy(bodyId, this.config.resetCooldownMs, this.now());
	}

	/**
	 * Structural snapshot check (round 2): a parseable v1 update (byte-op SV
	 * extraction, no document), non-empty unless the claimed content is empty,
	 * and under the snapshot cap. It deliberately does not compare state
	 * vectors: a lineage-fresh snapshot never covers the old lineage's client
	 * ids, and SV coverage is not a currency proof (delete-only updates leave
	 * the SV unchanged). Currency = lease + epoch CAS + exact coveredSequence.
	 */
	snapshotStructurallyValid(snapshot: Uint8Array, contentBytes: number): boolean {
		if (snapshot.byteLength < 2 || snapshot.byteLength > RELAY_MAX_RESET_SNAPSHOT_BYTES) return false;
		let stateVector: Uint8Array;
		try { stateVector = stateVectorFromUpdate(snapshot); } catch { return false; }
		return contentBytes === 0 || decodeStateVector(stateVector).size > 0;
	}

	/**
	 * Lease-fenced reset; drops the merged cache entry on success. Pending
	 * micro-batches of the body are committed first (G3): frames received before
	 * the reset are then either covered by it or make it fail `head_advanced`.
	 * Authority is re-checked at install time (G19), after the body read.
	 */
	semanticReset(bodyId: string, actor: VaultActorContext, input: { leaseId: string; expectedEpoch: number;
		coveredSequence: number; snapshot: Uint8Array; contentHash: string; contentBytes: number }): RelayResetOutcome {
		this.flushBatch(bodyId);
		const outcome = this.options.relayStore().semanticReset({ bodyId, actor, ...input, now: this.now(),
			cooldownMs: this.config.resetCooldownMs, authorize: () => this.validateActor(actor) });
		if (!outcome.ok) {
			this.counters.leaseDenials++;
			return outcome;
		}
		this.counters.resets++;
		this.invalidate(bodyId);
		this.lazyHashes.delete(bodyId);
		if (this.overBudgetMarkers().delete(bodyId)) this.options.relayStore().clearOverBudget(bodyId);
		return outcome;
	}

	diagnostics(): Record<string, unknown> {
		const now = this.now();
		const recent = this.appendTimes.filter((at) => at >= now - 10_000).length;
		return {
			enabled: true,
			byteOps: defaultYwasmByteOps.name,
			config: this.config,
			counters: { ...this.counters, appendsPerSecond: recent / 10 },
			lastFrameError: this.lastFrameError,
			bodies: [...this.merged.entries()].map(([bodyId, entry]) => ({
				bodyId, epoch: entry.epoch, latestSequence: entry.latestSequence, generation: entry.generation,
				logRows: entry.tailEntries, logBytes: entry.tailBytes, checkpointSequence: entry.checkpointSequence,
				stateVectorBytes: entry.stateVector.byteLength, mergedBytes: entry.bytes?.byteLength ?? null, stateVectorExact: entry.stateVectorExact,
			})),
			mergedCacheBytes: this.mergedBytesTotal,
			pendingEnvelopes: this.pendingEnvelopes.size,
			pendingBatches: this.batches.size,
			pendingGroups: this.pendingGroups(),
			staleResidents: this.staleResidents.size,
			overBudgetBodies: [...this.overBudgetMarkers().keys()],
			// COUNT(*) over the journal: this method backs /diagnostics only (G15).
			vaultJournalRows: this.options.relayStore().journalRowCount(),
			documentMaterialisations: this.options.store().documentMaterialisations,
			ywasmLinearMemoryBytes: ywasmLinearMemoryBytes(),
		};
	}
}
