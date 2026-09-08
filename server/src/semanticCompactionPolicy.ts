/**
 * Semantic compaction deliberately creates a fresh Y.Doc from canonical live
 * state. Re-encoding or applying the current state to another Y.Doc is not
 * compaction: it preserves the old CRDT identities and tombstones.
 *
 * This module only decides *when* a body or root is a compaction candidate.
 * The caller owns queue draining, atomic epoch advancement, checkpointing and
 * stale-client fencing.
 */

export type SemanticCompactionScope = "body" | "canvas" | "root";
export type SemanticCompactionUrgency = "none" | "soft" | "hard";

export interface SemanticCompactionMetrics {
	scope: SemanticCompactionScope;
	encodedStateBytes: number;
	liveStateBytes: number;
	estimatedFreshStateBytes: number;
	totalStructs: number;
	deletedStructs: number;
	/** Consecutive measurements over the configured latency objective. */
	latencyViolationStreak: number;
	/** The resident document is threatening its memory/cache budget. */
	memoryPressure: boolean;
}

export interface SemanticCompactionState {
	lastCompactedAt: number | null;
	/** Encoded size immediately after the previous semantic reset. */
	postCompactionEncodedStateBytes: number | null;
}

export interface SemanticCompactionThresholds {
	softEncodedStateBytes: number;
	hardEncodedStateBytes: number;
	softStructs: number;
	hardStructs: number;
	softDeletedStructs: number;
	minimumRatioStructs: number;
	softDeletedRatio: number;
	hardDeletedRatio: number;
	softAmplification: number;
	hardAmplification: number;
	minimumAmplificationBytes: number;
	minimumProjectedReduction: number;
	softCooldownMs: number;
	/** Required regrowth from the last compacted low-water mark. */
	rearmGrowthFactor: number;
	hardLatencyViolationStreak: number;
}

export interface SemanticCompactionDecision {
	urgency: SemanticCompactionUrgency;
	reasons: string[];
	projectedReduction: number;
	amplification: number;
	deletedRatio: number;
	/** Hard decisions may briefly stop admission; soft decisions wait for idle. */
	pauseAdmission: boolean;
	/** False means pressure is real but a reset would not materially shrink it. */
	semanticResetRecommended: boolean;
}

export const BODY_COMPACTION_THRESHOLDS: Readonly<SemanticCompactionThresholds> = Object.freeze({
	softEncodedStateBytes: 1_500_000,
	hardEncodedStateBytes: 3_000_000,
	softStructs: 50_000,
	hardStructs: 100_000,
	softDeletedStructs: 20_000,
	minimumRatioStructs: 10_000,
	softDeletedRatio: 0.25,
	hardDeletedRatio: 0.40,
	softAmplification: 2,
	hardAmplification: 3,
	minimumAmplificationBytes: 1_500_000,
	minimumProjectedReduction: 0.40,
	softCooldownMs: 24 * 60 * 60_000,
	rearmGrowthFactor: 1.5,
	hardLatencyViolationStreak: 3,
});

/** Root churn is usually metadata-sized, so it gets an earlier struct alarm. */
export const ROOT_COMPACTION_THRESHOLDS: Readonly<SemanticCompactionThresholds> = Object.freeze({
	...BODY_COMPACTION_THRESHOLDS,
	softEncodedStateBytes: 1_000_000,
	hardEncodedStateBytes: 2_000_000,
	softStructs: 20_000,
	hardStructs: 50_000,
	softDeletedStructs: 10_000,
	minimumRatioStructs: 5_000,
	minimumAmplificationBytes: 1_000_000,
});

export interface CompactionActivityCounters {
	commits: number;
	ingressBytes: number;
	lastMeasuredAt: number;
}

export interface CompactionMeasurementCadence {
	commits: number;
	ingressBytes: number;
	maxIntervalMs: number;
}

export const DEFAULT_COMPACTION_MEASUREMENT_CADENCE: Readonly<CompactionMeasurementCadence> = Object.freeze({
	commits: 64,
	ingressBytes: 384 * 1024,
	maxIntervalMs: 15 * 60_000,
});

function finiteNonNegative(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name}`);
}

function validateMetrics(metrics: SemanticCompactionMetrics): void {
	finiteNonNegative(metrics.encodedStateBytes, "encoded state bytes");
	finiteNonNegative(metrics.liveStateBytes, "live state bytes");
	finiteNonNegative(metrics.estimatedFreshStateBytes, "estimated fresh state bytes");
	finiteNonNegative(metrics.totalStructs, "total structs");
	finiteNonNegative(metrics.deletedStructs, "deleted structs");
	finiteNonNegative(metrics.latencyViolationStreak, "latency violation streak");
	if (!Number.isInteger(metrics.totalStructs) || !Number.isInteger(metrics.deletedStructs)
		|| metrics.deletedStructs > metrics.totalStructs) throw new Error("invalid struct census");
}

export function compactionThresholds(scope: SemanticCompactionScope): Readonly<SemanticCompactionThresholds> {
	return scope === "root" ? ROOT_COMPACTION_THRESHOLDS : BODY_COMPACTION_THRESHOLDS;
}

/** Cheap counters decide when paying for an exact encoded-state census is worthwhile. */
export function recordCompactionActivity(
	counters: Readonly<CompactionActivityCounters>,
	input: { commits?: number; ingressBytes: number },
): CompactionActivityCounters {
	const commits = input.commits ?? 1;
	finiteNonNegative(commits, "commit count");
	finiteNonNegative(input.ingressBytes, "ingress bytes");
	if (!Number.isInteger(commits)) throw new Error("invalid commit count");
	return {
		commits: counters.commits + commits,
		ingressBytes: counters.ingressBytes + input.ingressBytes,
		lastMeasuredAt: counters.lastMeasuredAt,
	};
}

export function compactionMeasurementDue(
	counters: Readonly<CompactionActivityCounters>,
	now: number,
	cadence: Readonly<CompactionMeasurementCadence> = DEFAULT_COMPACTION_MEASUREMENT_CADENCE,
): boolean {
	finiteNonNegative(now, "measurement time");
	return counters.commits >= cadence.commits
		|| counters.ingressBytes >= cadence.ingressBytes
		|| now - counters.lastMeasuredAt >= cadence.maxIntervalMs;
}

export function resetCompactionActivity(now: number): CompactionActivityCounters {
	finiteNonNegative(now, "measurement time");
	return { commits: 0, ingressBytes: 0, lastMeasuredAt: now };
}

export function evaluateSemanticCompaction(
	metrics: Readonly<SemanticCompactionMetrics>,
	state: Readonly<SemanticCompactionState>,
	now: number,
	thresholds: Readonly<SemanticCompactionThresholds> = compactionThresholds(metrics.scope),
): SemanticCompactionDecision {
	validateMetrics(metrics);
	finiteNonNegative(now, "evaluation time");
	const encoded = metrics.encodedStateBytes;
	const usefulBaseline = Math.max(1, metrics.estimatedFreshStateBytes || metrics.liveStateBytes);
	const amplification = encoded / usefulBaseline;
	const deletedRatio = metrics.totalStructs === 0 ? 0 : metrics.deletedStructs / metrics.totalStructs;
	const projectedReduction = encoded === 0 ? 0 : Math.max(0, 1 - metrics.estimatedFreshStateBytes / encoded);

	const hardReasons: string[] = [];
	if (encoded >= thresholds.hardEncodedStateBytes) hardReasons.push("encoded-state-hard-limit");
	if (metrics.totalStructs >= thresholds.hardStructs) hardReasons.push("struct-count-hard-limit");
	if (metrics.totalStructs >= thresholds.minimumRatioStructs && deletedRatio >= thresholds.hardDeletedRatio) {
		hardReasons.push("deleted-ratio-hard-limit");
	}
	if (encoded >= thresholds.minimumAmplificationBytes && amplification >= thresholds.hardAmplification) {
		hardReasons.push("history-amplification-hard-limit");
	}
	if (metrics.latencyViolationStreak >= thresholds.hardLatencyViolationStreak) hardReasons.push("repeated-latency-pressure");
	if (metrics.memoryPressure) hardReasons.push("memory-pressure");
	if (hardReasons.length > 0) {
		const semanticResetRecommended = projectedReduction >= thresholds.minimumProjectedReduction;
		if (!semanticResetRecommended) hardReasons.push("insufficient-projected-reduction");
		return {
			urgency: "hard", reasons: hardReasons, projectedReduction, amplification, deletedRatio,
			pauseAdmission: true, semanticResetRecommended,
		};
	}

	const softReasons: string[] = [];
	const softEncodedLimit = Math.max(thresholds.softEncodedStateBytes, metrics.liveStateBytes * thresholds.softAmplification);
	if (encoded >= softEncodedLimit) softReasons.push("encoded-state-soft-limit");
	if (metrics.totalStructs >= thresholds.softStructs) softReasons.push("struct-count-soft-limit");
	if (metrics.deletedStructs >= thresholds.softDeletedStructs) softReasons.push("deleted-count-soft-limit");
	if (metrics.totalStructs >= thresholds.minimumRatioStructs && deletedRatio >= thresholds.softDeletedRatio) {
		softReasons.push("deleted-ratio-soft-limit");
	}
	if (encoded >= thresholds.minimumAmplificationBytes && amplification >= thresholds.softAmplification) {
		softReasons.push("history-amplification-soft-limit");
	}
	if (softReasons.length === 0) {
		return {
			urgency: "none", reasons: [], projectedReduction, amplification, deletedRatio,
			pauseAdmission: false, semanticResetRecommended: false,
		};
	}
	if (projectedReduction < thresholds.minimumProjectedReduction) {
		return {
			urgency: "none", reasons: ["insufficient-projected-reduction"], projectedReduction, amplification, deletedRatio,
			pauseAdmission: false, semanticResetRecommended: false,
		};
	}
	if (state.lastCompactedAt !== null && now - state.lastCompactedAt < thresholds.softCooldownMs) {
		return {
			urgency: "none", reasons: ["soft-cooldown"], projectedReduction, amplification, deletedRatio,
			pauseAdmission: false, semanticResetRecommended: false,
		};
	}
	if (state.postCompactionEncodedStateBytes !== null
		&& encoded < state.postCompactionEncodedStateBytes * thresholds.rearmGrowthFactor) {
		return {
			urgency: "none", reasons: ["hysteresis-low-water"], projectedReduction, amplification, deletedRatio,
			pauseAdmission: false, semanticResetRecommended: false,
		};
	}
	return {
		urgency: "soft", reasons: softReasons, projectedReduction, amplification, deletedRatio,
		pauseAdmission: false, semanticResetRecommended: true,
	};
}
