// Relay v2 spike (brief §5.1–§5.4): the relay body hot path. Body sockets
// never hold a CRDT document: the server keeps the merged state as bytes
// (checkpoint + journal tail, merged with ywasm byte ops) and appends each
// client update to `vault_journal` in one lean transaction. Only reached when
// `YAOS_RELAY_BODIES === "true"`. See docs/relay2-protocol.md.
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
import { readSyncMessage, SYNC_STEP_2, SYNC_UPDATE } from "./crdt/syncFraming";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "./shared/socketCloseCodes";
import { canonicalMarkdownBytes } from "./shared/markdownCodec";
import type { SemanticEpoch } from "./shared/semanticEpoch";
import type { RelayConfig } from "./relayFlag";
import {
	RelayAppendError, RelayBodyStore, type RelayLeaseResult, type RelayResetOutcome, type RelayResetPolicyState,
} from "./relayBodyStore";
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
}

interface Bucket { tokens: number; at: number }

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
	private readonly buckets = new Map<string, Bucket>();
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
	};

	constructor(private readonly options: RelayBodyServiceOptions) {
		this.config = options.config;
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
	}

	private rejectAuthority(socket: VaultSocketPort): void {
		this.counters.authorityCloses++;
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
			if (!this.validateActor(actorOf(attachment))) { this.rejectAuthority(socket); return; }
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
			return;
		}
		const update = message.update;
		const pending = this.pendingEnvelopes.get(attachment.socketId) ?? null;
		this.pendingEnvelopes.delete(attachment.socketId);
		if (update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
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
			if (envelope) this.ackNoop(socket, attachment, envelope, digest);
			return;
		}
		// 2. Authority (cached, invalidated by every in-process authority writer).
		// Before dedupe (G7): a revoked device gets 4403, never a re-ack.
		if (!this.validateActor(actor)) { this.rejectAuthority(socket); return; }
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
		// 4. Budget.
		if (!this.consumeTokens(attachment.socketId, update.byteLength)) {
			this.counters.rateLimitCloses++;
			host.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" });
			try { socket.close(1013, "relay rate limit"); } catch { /* closed */ }
			return;
		}
		const frame: QueuedFrame = { socket, attachment, actor, update: update.slice(), envelope, digest };
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

	/** Commits every pending micro-batch of a body now (timer, reset, tests, drain). */
	flushBatch(bodyId: string): void {
		const prefix = `${bodyId}\u0000`;
		for (const key of [...this.batches.keys()]) if (key.startsWith(prefix)) this.flushKey(bodyId, key);
	}

	flushAllBatches(): void {
		for (const key of [...this.batches.keys()]) this.flushKey(key.slice(0, key.indexOf("\u0000")), key);
	}

	private consumeTokens(socketId: string, bytes: number): boolean {
		const now = this.now();
		const bucket = this.buckets.get(socketId) ?? { tokens: this.config.burstBytes, at: now };
		const elapsed = Math.max(0, now - bucket.at);
		bucket.tokens = Math.min(this.config.burstBytes, bucket.tokens + (elapsed * this.config.rateBytesPerSec) / 1000);
		bucket.at = now;
		this.buckets.set(socketId, bucket);
		if (bucket.tokens < bytes) return false;
		bucket.tokens -= bytes;
		return true;
	}

	/**
	 * G2 + G11 for queued frames: drop frames whose device lost authority since
	 * they were queued (4403, invariant #4 holds with batching on), and collapse
	 * repeated (device, candidateId) pairs inside the batch: the same digest is
	 * acked as a dedupe of the first frame's commit, a different digest is
	 * rejected `candidate_id_reused`. Returns the frames to commit and the
	 * duplicates to ack after the commit.
	 */
	private screenBatch(frames: QueuedFrame[]): { live: QueuedFrame[]; duplicates: QueuedFrame[] } {
		const live: QueuedFrame[] = [];
		const duplicates: QueuedFrame[] = [];
		const seen = new Map<string, string>();
		const revoked = new Set<string>();
		for (const frame of frames) {
			if (revoked.has(frame.attachment.socketId) || !this.validateActor(frame.actor)) {
				this.counters.authorityDrops++;
				if (!revoked.has(frame.attachment.socketId)) this.rejectAuthority(frame.socket);
				revoked.add(frame.attachment.socketId);
				continue;
			}
			const candidateId = frame.envelope?.candidateId;
			if (candidateId) {
				const key = `${frame.attachment.deviceId}\u0000${candidateId}`;
				const digest = frame.envelope!.candidateDigest ?? frame.envelope!.payloadDigest;
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

	/** Steps 5–7: growth cap, single-transaction commit, then acks and fan-out. */
	private commitFrames(bodyId: string, frames: QueuedFrame[], batched: boolean): void {
		const host = this.requireHost();
		const { live, duplicates } = batched ? this.screenBatch(frames) : { live: frames, duplicates: [] as QueuedFrame[] };
		if (live.length === 0) return;
		const epoch = live[0]!.attachment.documentEpoch;
		const state = this.headState(bodyId);
		if (!state) {
			for (const frame of live) try { frame.socket.close(1008, "body is not active"); } catch { /* closed */ }
			return;
		}
		if (state.epoch !== epoch) {
			for (const frame of live) {
				this.counters.epochFences++;
				host.fenceRelaySocket(frame.socket, frame.attachment, state.epoch);
			}
			return;
		}
		const update = live.length === 1 ? live[0]!.update : mergeUpdates(live.map((frame) => frame.update));
		if (update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			// Only reachable by micro-batching many near-limit frames: commit one by one.
			for (const frame of live) this.commitFrames(bodyId, [frame], false);
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
			nextStateVector = noop ? state.stateVector : maxStateVector(state.stateVector, stateVectorFromUpdate(update));
		}
		if (noop) {
			this.counters.noopSkips += live.length + duplicates.length;
			for (const frame of [...live, ...duplicates]) {
				if (frame.envelope) this.ackNoop(frame.socket, frame.attachment, frame.envelope, frame.digest, state);
			}
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
		let result;
		try {
			result = this.options.relayStore().appendRelayBodyUpdate({
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
						this.counters.epochFences++;
						host.fenceRelaySocket(frame.socket, frame.attachment, error.currentEpoch);
					}
					return;
				}
				for (const frame of live) try { frame.socket.close(1008, "body is not active"); } catch { /* closed */ }
				return;
			}
			this.counters.commitFailures++;
			this.invalidate(bodyId);
			console.warn("[yaos-relay] append failed", error);
			for (const frame of live) {
				host.sendControl(frame.socket, { type: "VAULT_ERROR", code: "durability_failed",
					message: "update was not committed; reconnect to resend" });
				try { frame.socket.close(1011, "durable commit failed"); } catch { /* closed */ }
			}
			return;
		}
		this.counters.appends++;
		this.counters.appendFrames += live.length;
		this.counters.rowsWritten += result.rowsWritten;
		if (accepted) this.counters.hashAccepted++;
		else this.counters.hashUnknown++;
		const now = this.now();
		this.appendTimes.push(now);
		while (this.appendTimes.length > 0 && this.appendTimes[0]! < now - 10_000) this.appendTimes.shift();
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
		this.remember(bodyId, entry);
		this.syncDocumentCache(bodyId);
		// 7. After commit: origin acks, peer fan-out, base notices.
		for (const [index, frame] of live.entries()) {
			if (frame.envelope) {
				this.ackOrigin(frame.socket, frame.attachment, frame.envelope, frame.digest, {
					durableGeneration: result.generation, vaultSequence: result.vaultSequence,
					contentHashAccepted: index === acceptedIndex, deduped: false, noop: false,
					contentHash: result.contentHash, size: result.size,
				});
			}
		}
		for (const frame of duplicates) {
			this.ackOrigin(frame.socket, frame.attachment, frame.envelope!, frame.digest, {
				durableGeneration: result.generation, vaultSequence: result.vaultSequence,
				contentHashAccepted: false, deduped: true, noop: false,
				contentHash: result.contentHash, size: result.size,
			});
		}
		const origins = new Set([...live, ...duplicates].map((frame) => frame.attachment.socketId));
		for (const frame of live) {
			host.broadcastRelayUpdate(bodyId, epoch, syncFrame(SYNC_UPDATE, frame.update), frame.attachment.socketId);
		}
		// G16: every origin gets exactly its own ack, never a peer notice as well.
		host.notifyBodyCommitted(bodyId, result.generation, result.vaultSequence, origins);
		if (entry.tailEntries >= this.config.checkpointEntries || entry.tailBytes >= this.config.checkpointBytes) {
			this.options.armCheckpointAlarm();
		}
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
		let durable: ReturnType<VaultStore["durableMergedBytes"]>;
		try {
			durable = this.options.store().durableMergedBytes(bodyId, throughSequence, budget);
		} catch (error) {
			if (!(error instanceof RelayMergeBudgetError)) throw error;
			// Never call into wasm past the budget (defence in depth; the prefix is sized to fit).
			this.markOverBudget(bodyId, head.semanticEpoch, error.inputBytes);
			return null;
		}
		if (durable.tailEntries === 0) return null;
		const partial = throughSequence < head.latestSequence;
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
		this.evictStaleResidents();
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
		let rowsPruned = 0;
		const now = this.now();
		const pins = store.activePins(now);
		let floor = Math.max(0, store.currentSequence() - options.retainSequences);
		for (const pin of pins) floor = Math.min(floor, pin.boundarySequence - 1);
		if (floor > store.journalFloor()) {
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
			bodies: [...this.merged.entries()].map(([bodyId, entry]) => ({
				bodyId, epoch: entry.epoch, latestSequence: entry.latestSequence, generation: entry.generation,
				logRows: entry.tailEntries, logBytes: entry.tailBytes, checkpointSequence: entry.checkpointSequence,
				stateVectorBytes: entry.stateVector.byteLength, mergedBytes: entry.bytes?.byteLength ?? null, stateVectorExact: entry.stateVectorExact,
			})),
			mergedCacheBytes: this.mergedBytesTotal,
			pendingEnvelopes: this.pendingEnvelopes.size,
			pendingBatches: this.batches.size,
			staleResidents: this.staleResidents.size,
			overBudgetBodies: [...this.overBudgetMarkers().keys()],
			// COUNT(*) over the journal: this method backs /diagnostics only (G15).
			vaultJournalRows: this.options.relayStore().journalRowCount(),
			documentMaterialisations: this.options.store().documentMaterialisations,
			ywasmLinearMemoryBytes: ywasmLinearMemoryBytes(),
		};
	}
}
