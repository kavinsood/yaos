import * as Y from "yjs";
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
import type { VaultDocumentCache } from "./vaultDocumentCache";
import type { SemanticResetResult } from "./vaultDocumentStore";
import type { VaultStore } from "./vaultStore";

export interface SemanticCompactionRuntimeOptions {
	store: Pick<VaultStore, "documentHead" | "rootAuthoritySnapshotAt" | "semanticCompactionState"
		| "semanticResetFromEncodedState">;
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
}

/** Deliberately generous for a local Durable Object SQLite transaction. */
export const DEFAULT_COMMIT_LATENCY_OBJECTIVE_MS = 100;

/**
 * Turns cheap commit counters into an occasional exact census and, when the
 * policy recommends it, atomically replaces one CRDT lineage with a fresh one.
 * Every expensive operation runs inside the document cache's serialization
 * lane, which is the same lane used by validation and socket admission.
 */
export class SemanticCompactionRuntime {
	private readonly documents = new Map<string, DocumentCompactionState>();

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
		return this.documents.get(documentId)?.admissionPaused ?? false;
	}

	async measureAndMaybeCompact(
		documentId: string,
		operational: { latencyViolationStreak?: number; memoryPressure?: boolean } = {},
	): Promise<SemanticCompactionOutcome> {
		return this.options.cache.serializeDocument(documentId, async () => {
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
			}
			const loaded = this.options.cache.get(documentId);
			if (!loaded) return { status: "not-resident" };
			if (loaded.dirty || loaded.validationPending || this.options.cache.pendingFor(documentId).length > 0) {
				return { status: "busy" };
			}
			const head = this.options.store.documentHead(documentId);
			if (!head || head.generation !== loaded.generation || head.semanticEpoch !== loaded.semanticEpoch) {
				return { status: "head-changed" };
			}

			// Encoding the old state, building the fresh document and hashing/writing
			// its complete checkpoint overlap transiently. Reserve conservatively.
			const reservationBytes = Math.min(
				Number.MAX_SAFE_INTEGER,
				Math.max(loaded.encodedStateBytes, 1) * 4,
			);
			const release = this.options.cache.recordTransient(documentId, reservationBytes);
			let prepared: PreparedSemanticReset | null = null;
			try {
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
						: canonicalMarkdownBytes(Y.Text.prototype.toString.call(loaded.doc.getText("body"))).byteLength;
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
					prepared.document.destroy();
					prepared = null;
					return { status: "measured", decision };
				}

				// Re-read immediately before CAS. If anything bypassed the cache lane,
				// the storage reset still fails closed on the exact durable head.
				const exactHead = this.options.store.documentHead(documentId);
				if (!exactHead || exactHead.generation !== head.generation
					|| exactHead.semanticEpoch !== head.semanticEpoch
					|| exactHead.latestSequence !== head.latestSequence) {
					prepared.document.destroy();
					prepared = null;
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
					freshDocument.destroy();
					this.options.cache.discardResident(documentId);
				}
				state.policy = {
					lastCompactedAt: now,
					postCompactionEncodedStateBytes: result.totalBytes,
				};
				state.admissionPaused = false;
				const fencedSockets = this.options.fenceSockets(
					documentId,
					result.previousSemanticEpoch,
					result.semanticEpoch,
				);
				return {
					status: "compacted", decision, result, previousStructs, freshStructs, fencedSockets,
				};
			} finally {
				prepared?.document.destroy();
				release();
			}
		});
	}

	diagnostics(): Record<string, {
		activity: CompactionActivityCounters;
		policy: SemanticCompactionState;
		latencyViolationStreak: number;
		admissionPaused: boolean;
	}> {
		return Object.fromEntries([...this.documents].map(([documentId, value]) => [documentId, {
			activity: { ...value.activity },
			policy: { ...value.policy },
			latencyViolationStreak: value.latencyViolationStreak,
			admissionPaused: value.admissionPaused,
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
				// Activity and operational pressure stay write-free on the hot path.
				// A restart re-arms their local windows; only cooldown and low-water
				// policy need durable, reset-transactional continuity.
				latencyViolationStreak: 0,
				admissionPaused: false,
			} : {
				activity: resetCompactionActivity(now),
				policy: { lastCompactedAt: null, postCompactionEncodedStateBytes: null },
				latencyViolationStreak: 0,
				admissionPaused: false,
			};
			this.documents.set(documentId, value);
		}
		return value;
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
