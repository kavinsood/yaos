import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { canonicalMarkdownBytes } from "./shared/markdownCodec";
import type { SemanticEpoch } from "./shared/semanticEpoch";
import {
	prepareCanvasSemanticReset,
	prepareRootSemanticReset,
	prepareSemanticReset,
	type PreparedSemanticReset,
} from "./semanticCompaction";
import {
	DEFAULT_COMPACTION_MEASUREMENT_CADENCE,
	compactionMeasurementDue,
	compactionThresholds,
	evaluateSemanticCompaction,
	recordCompactionActivity,
	resetCompactionActivity,
	type CompactionActivityCounters,
	type CompactionMeasurementCadence,
	type SemanticCompactionDecision,
	type SemanticCompactionScope,
	type SemanticCompactionState,
	type SemanticCompactionThresholds,
} from "./semanticCompactionPolicy";
import { VaultDocumentCachePressureError, type VaultDocumentCache } from "./vaultDocumentCache";
import type { SemanticCompactionFailureClass, SemanticResetResult } from "./vaultDocumentStore";
import type { VaultStore } from "./vaultStore";

export interface SemanticCompactionRuntimeOptions {
	store: Pick<VaultStore, "documentHead" | "rootAuthoritySnapshotAt" | "semanticCompactionState"
		| "semanticResetFromEncodedState" | "markSemanticCompactionRetry"
		| "markSemanticCompactionResourceLimit" | "clearSemanticCompactionRetry" | "listSemanticCompactionRetries"
		| "nextSemanticCompactionRetryAt">;
	cache: VaultDocumentCache;
	fenceSockets(documentId: string, previousEpoch: SemanticEpoch, currentEpoch: SemanticEpoch): number;
	/** Local durable-commit latency above which one observation extends the pressure streak. */
	commitLatencyObjectiveMs?: number;
	now?: () => number;
	cadence?: Readonly<CompactionMeasurementCadence>;
	thresholds?: (scope: SemanticCompactionScope) => Readonly<SemanticCompactionThresholds>;
}

export type SemanticCompactionOutcome =
	| { status: "not-due" | "not-resident" | "busy" | "head-changed" }
	| { status: "measured"; decision: SemanticCompactionDecision }
	| {
		status: "compacted";
		decision: SemanticCompactionDecision;
		result: SemanticResetResult;
		previousStructs: number;
		freshStructs: number;
		fencedSockets: number;
	};

interface DocumentCompactionState {
	activity: CompactionActivityCounters;
	policy: SemanticCompactionState;
	latencyViolationStreak: number;
	admissionPaused: boolean;
	retryRequired: boolean;
	retryNotBefore: number | null;
	retryFailureCount: number;
	lastFailureClass: SemanticCompactionFailureClass | null;
	lastFailureAt: number | null;
}

/** Deliberately generous for a local Durable Object SQLite transaction. */
export const DEFAULT_COMMIT_LATENCY_OBJECTIVE_MS = 100;
export const SEMANTIC_COMPACTION_RETRY_MS = 1_000;

/**
 * Turns cheap commit counters into an occasional exact census and, when the
 * policy recommends it, atomically replaces one CRDT lineage with a fresh one.
 * Every expensive operation runs inside the document cache's serialization
 * lane, which is the same lane used by validation and socket admission.
 */
export class SemanticCompactionRuntime {
	private readonly documents = new Map<string, DocumentCompactionState>();
	private readonly attempts = new Map<string, Promise<SemanticCompactionOutcome>>();

	constructor(private readonly options: SemanticCompactionRuntimeOptions) {}

	async recordCommit(
		documentId: string,
		ingressBytes: number,
		commitLatencyMs?: number,
	): Promise<SemanticCompactionOutcome> {
		const now = this.now();
		const state = this.state(documentId, now);
		const activity = recordCompactionActivity(state.activity, { ingressBytes });
		const latencyViolationStreak = this.nextLatencyViolationStreak(state, commitLatencyMs);
		state.activity = activity;
		state.latencyViolationStreak = latencyViolationStreak;
		const scope = this.options.cache.documentKind(documentId);
		const thresholds = (this.options.thresholds ?? compactionThresholds)(scope);
		const latencyRequiresMeasurement = state.latencyViolationStreak >= thresholds.hardLatencyViolationStreak;
		if (!compactionMeasurementDue(state.activity, now,
			this.options.cadence ?? DEFAULT_COMPACTION_MEASUREMENT_CADENCE) && !latencyRequiresMeasurement) {
			return { status: "not-due" };
		}
		return this.measureAndMaybeCompact(documentId);
	}

	/** Synchronous admission guard for socket and candidate entry points. */
	shouldPauseAdmission(documentId: string): boolean {
		return this.state(documentId, this.now()).admissionPaused;
	}

	dueRetries(now = this.now(), limit = 25): string[] {
		return this.options.store.listSemanticCompactionRetries(now, limit).map((entry) => entry.documentId);
	}

	nextRetryAt(): number | null {
		return this.options.store.nextSemanticCompactionRetryAt();
	}

	recordLoadFailure(documentId: string, error: unknown): void {
		const now = this.now();
		const state = this.state(documentId, now);
		if (!state.retryRequired) return;
		this.persistRetry(documentId, state.admissionPaused,
			error instanceof VaultDocumentCachePressureError ? "transient-budget" : "not-resident", true, now);
	}

	/** Called after a completed cache load, when reconstruction headroom has been released. */
	documentLoaded(documentId: string, encodedStateBytes: number): Promise<SemanticCompactionOutcome> | null {
		const now = this.now();
		const state = this.state(documentId, now);
		const scope = this.options.cache.documentKind(documentId);
		const thresholds = (this.options.thresholds ?? compactionThresholds)(scope);
		if (state.retryRequired && (state.retryNotBefore ?? 0) <= now) {
			return this.measureAndMaybeCompact(documentId);
		}
		if (encodedStateBytes >= thresholds.softEncodedStateBytes) {
			return this.measureAndMaybeCompact(documentId);
		}
		return null;
	}

	async measureAndMaybeCompact(
		documentId: string,
		operational: { latencyViolationStreak?: number; memoryPressure?: boolean } = {},
	): Promise<SemanticCompactionOutcome> {
		const currentAttempt = this.attempts.get(documentId);
		if (currentAttempt) return currentAttempt;
		const attempt: Promise<SemanticCompactionOutcome> = this.options.cache.serializeDocument(documentId, async () => {
			const now = this.now();
			const state = this.state(documentId, now);
			const scope = this.options.cache.documentKind(documentId);
			const thresholds = (this.options.thresholds ?? compactionThresholds)(scope);
			const latencyViolationStreak = Math.max(
				state.latencyViolationStreak,
				operational.latencyViolationStreak ?? 0,
			);
			const memoryPressure = this.options.cache.hasResidentMemoryPressure(documentId)
				|| operational.memoryPressure === true;
			// Known hard operational pressure must fence admission before any
			// condition which can prevent the exact census. Otherwise a dirty body
			// or denied transient reservation can continue growing indefinitely.
			if (memoryPressure || latencyViolationStreak >= thresholds.hardLatencyViolationStreak) {
				state.admissionPaused = true;
				this.persistRetry(documentId, true, null, false, now);
			}
			const loaded = this.options.cache.get(documentId);
			if (!loaded) {
				if (state.retryRequired) this.persistRetry(documentId, state.admissionPaused, "not-resident", true, now);
				return { status: "not-resident" };
			}
			if (loaded.dirty || loaded.validationPending || this.options.cache.pendingFor(documentId).length > 0) {
				if (state.retryRequired) this.persistRetry(documentId, state.admissionPaused, "busy", true, now);
				return { status: "busy" };
			}
			const head = this.options.store.documentHead(documentId);
			if (!head || head.generation !== loaded.generation || head.semanticEpoch !== loaded.semanticEpoch) {
				if (state.retryRequired) this.persistRetry(documentId, state.admissionPaused, "head-changed", true, now);
				return { status: "head-changed" };
			}

			// Encoding the old state, building the fresh document and hashing/writing
			// its complete checkpoint overlap transiently. Reserve conservatively.
			const reservationBytes = Math.min(
				Number.MAX_SAFE_INTEGER,
				Math.max(loaded.encodedStateBytes, 1) * 4,
			);
			let release: (() => void) | null = null;
			let prepared: PreparedSemanticReset | null = null;
			try {
				release = this.options.cache.recordTransient(documentId, reservationBytes);
				prepared = scope === "canvas"
					? await prepareCanvasSemanticReset(loaded.doc)
					: scope === "root"
						? prepareRootSemanticReset(
							loaded.doc,
							this.options.store.rootAuthoritySnapshotAt(head.latestSequence),
						)
						: prepareSemanticReset(loaded.doc, "body");
				const liveStateBytes = scope === "root"
					? prepared.fresh.encodedStateBytes
					: scope === "canvas"
						? (prepared as Awaited<ReturnType<typeof prepareCanvasSemanticReset>>).liveStateBytes
						: canonicalMarkdownBytes(crdtEngine.readText(loaded.doc, "body")).byteLength;
				const decision = evaluateSemanticCompaction({
					scope,
					encodedStateBytes: prepared.previous.encodedStateBytes,
					liveStateBytes,
					estimatedFreshStateBytes: prepared.fresh.encodedStateBytes,
					totalStructs: prepared.previous.totalStructs,
					deletedStructs: prepared.previous.deletedStructs,
					latencyViolationStreak,
					memoryPressure,
				}, state.policy, now, thresholds);
				state.activity = resetCompactionActivity(now);
				// An exact census consumes the latency window. Hard pressure remains
				// fenced through admissionPaused until a reset succeeds or a later
				// exact census observes that every hard signal has cleared.
				state.latencyViolationStreak = 0;
				state.admissionPaused = decision.pauseAdmission;
				if (!decision.semanticResetRecommended) {
					crdtEngine.destroyDocument(prepared.document);
					prepared = null;
					const irreducibleHardLimit = decision.reasons.some((reason) =>
						reason !== "repeated-latency-pressure" && reason !== "insufficient-projected-reduction");
					if (decision.pauseAdmission && irreducibleHardLimit) {
						const limited = this.options.store.markSemanticCompactionResourceLimit(documentId, {
							throughSequence: head.latestSequence, generation: head.generation,
							semanticEpoch: head.semanticEpoch,
						}, now);
						if (!limited) {
							this.persistRetry(documentId, true, "head-changed", true, now);
							return { status: "head-changed" };
						}
						state.retryRequired = false;
						state.retryNotBefore = null;
						state.lastFailureClass = "resource-limit";
						state.lastFailureAt = now;
					} else if (!decision.pauseAdmission) {
						const cleared = this.options.store.clearSemanticCompactionRetry(documentId, {
							throughSequence: head.latestSequence, generation: head.generation,
							semanticEpoch: head.semanticEpoch,
						});
						if (!cleared && state.retryRequired) {
							this.persistRetry(documentId, false, "head-changed", true, now);
							return { status: "head-changed" };
						}
						this.clearLocalRetry(state);
					}
					return { status: "measured", decision };
				}

				// Re-read immediately before CAS. If anything bypassed the cache lane,
				// the storage reset still fails closed on the exact durable head.
				const exactHead = this.options.store.documentHead(documentId);
				if (!exactHead || exactHead.generation !== head.generation
					|| exactHead.semanticEpoch !== head.semanticEpoch
					|| exactHead.latestSequence !== head.latestSequence) {
					crdtEngine.destroyDocument(prepared.document);
					prepared = null;
					this.persistRetry(documentId, state.admissionPaused, "head-changed", true, now);
					return { status: "head-changed" };
				}
				const result = this.options.store.semanticResetFromEncodedState(
					documentId,
					prepared.encodedState,
					{
						throughSequence: exactHead.latestSequence,
						generation: exactHead.generation,
						semanticEpoch: exactHead.semanticEpoch,
					},
					now,
				);
				const previousStructs = prepared.previous.totalStructs;
				const freshStructs = prepared.fresh.totalStructs;
				const freshDocument = prepared.document;
				prepared = null;
				try {
					this.options.cache.installSemanticReset(
						documentId,
						freshDocument,
						result.generation,
						result.semanticEpoch,
					);
				} catch {
					// SQLite already published the new epoch. Never retain the old
					// resident authority or skip fencing merely because the in-memory
					// mirror could not be replaced under pressure.
					crdtEngine.destroyDocument(freshDocument);
					this.options.cache.discardResident(documentId);
				}
				state.policy = {
					lastCompactedAt: now,
					postCompactionEncodedStateBytes: result.totalBytes,
				};
				state.admissionPaused = false;
				this.clearLocalRetry(state);
				const fencedSockets = this.options.fenceSockets(
					documentId,
					result.previousSemanticEpoch,
					result.semanticEpoch,
				);
				return {
					status: "compacted", decision, result, previousStructs, freshStructs, fencedSockets,
				};
			} catch (error) {
				const failureClass: SemanticCompactionFailureClass = error instanceof VaultDocumentCachePressureError
					? "transient-budget" : "internal";
				try { this.persistRetry(documentId, state.admissionPaused, failureClass, true, now); }
				catch (retryError) { console.warn("[yaos-vault] failed to persist semantic compaction retry", retryError); }
				throw error;
			} finally {
				if (prepared) crdtEngine.destroyDocument(prepared.document);
				release?.();
			}
		});
		this.attempts.set(documentId, attempt);
		try { return await attempt; }
		finally {
			if (this.attempts.get(documentId) === attempt) this.attempts.delete(documentId);
		}
	}

	diagnostics(): Record<string, {
		activity: CompactionActivityCounters;
		policy: SemanticCompactionState;
		latencyViolationStreak: number;
		admissionPaused: boolean;
		retryRequired: boolean;
		retryNotBefore: number | null;
		retryFailureCount: number;
		lastFailureClass: SemanticCompactionFailureClass | null;
		lastFailureAt: number | null;
	}> {
		return Object.fromEntries([...this.documents].map(([documentId, value]) => [documentId, {
			activity: { ...value.activity },
			policy: { ...value.policy },
			latencyViolationStreak: value.latencyViolationStreak,
			admissionPaused: value.admissionPaused,
			retryRequired: value.retryRequired,
			retryNotBefore: value.retryNotBefore,
			retryFailureCount: value.retryFailureCount,
			lastFailureClass: value.lastFailureClass,
			lastFailureAt: value.lastFailureAt,
		}]));
	}

	private state(documentId: string, now: number): DocumentCompactionState {
		let value = this.documents.get(documentId);
		if (!value) {
			const durable = this.options.store.semanticCompactionState(documentId);
			value = durable ? {
				activity: resetCompactionActivity(now),
				policy: {
					lastCompactedAt: durable.lastCompactedAt,
					postCompactionEncodedStateBytes: durable.postCompactionEncodedStateBytes,
				},
				latencyViolationStreak: 0,
				admissionPaused: durable.admissionPaused,
				retryRequired: durable.retryRequired,
				retryNotBefore: durable.retryNotBefore,
				retryFailureCount: durable.retryFailureCount,
				lastFailureClass: durable.lastFailureClass,
				lastFailureAt: durable.lastFailureAt,
			} : {
				activity: resetCompactionActivity(now),
				policy: { lastCompactedAt: null, postCompactionEncodedStateBytes: null },
				latencyViolationStreak: 0,
				admissionPaused: false,
				retryRequired: false,
				retryNotBefore: null,
				retryFailureCount: 0,
				lastFailureClass: null,
				lastFailureAt: null,
			};
			this.documents.set(documentId, value);
		}
		return value;
	}

	private persistRetry(
		documentId: string,
		admissionPaused: boolean,
		failureClass: SemanticCompactionFailureClass | null,
		failedAttempt: boolean,
		now: number,
	): void {
		const current = this.documents.get(documentId);
		const failureCount = current?.retryFailureCount ?? 0;
		const backoff = Math.min(60_000, SEMANTIC_COMPACTION_RETRY_MS * (2 ** Math.min(6, failureCount)));
		const jitter = [...documentId].reduce((sum, character) => (sum + character.charCodeAt(0)) % 251, 0);
		const durable = this.options.store.markSemanticCompactionRetry(documentId, {
			admissionPaused,
			retryNotBefore: now + backoff + jitter,
			...(failureClass ? { failureClass } : {}),
			failedAttempt,
			now,
		});
		if (current) {
			current.admissionPaused = durable.admissionPaused;
			current.retryRequired = durable.retryRequired;
			current.retryNotBefore = durable.retryNotBefore;
			current.retryFailureCount = durable.retryFailureCount;
			current.lastFailureClass = durable.lastFailureClass;
			current.lastFailureAt = durable.lastFailureAt;
		}
	}

	private clearLocalRetry(state: DocumentCompactionState): void {
		state.admissionPaused = false;
		state.retryRequired = false;
		state.retryNotBefore = null;
		state.retryFailureCount = 0;
		state.lastFailureClass = null;
		state.lastFailureAt = null;
	}

	private nextLatencyViolationStreak(
		state: Readonly<DocumentCompactionState>,
		commitLatencyMs: number | undefined,
	): number {
		if (commitLatencyMs === undefined) return state.latencyViolationStreak;
		if (!Number.isFinite(commitLatencyMs) || commitLatencyMs < 0) {
			throw new Error("invalid commit latency");
		}
		const objective = this.options.commitLatencyObjectiveMs ?? DEFAULT_COMMIT_LATENCY_OBJECTIVE_MS;
		if (!Number.isFinite(objective) || objective <= 0) throw new Error("invalid commit latency objective");
		return commitLatencyMs > objective
			? Math.min(Number.MAX_SAFE_INTEGER, state.latencyViolationStreak + 1)
			: 0;
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}
