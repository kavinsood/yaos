/**
 * Relay v2 spike (§5.5): client trigger policy for lease-based semantic reset.
 *
 * The thresholds and the decision function are imported unchanged from the
 * server's `server/src/semanticCompactionPolicy.ts` (pure module, no engine
 * imports): soft 1.5 MB encoded / 50k structs / 20k deleted structs, deleted
 * ratio 0.25 (≥10k structs), amplification 2× (≥1.5 MB), projected reduction
 * ≥ 40 %, 24 h soft cooldown, 1.5× re-arm hysteresis; hard at 3 MB / 100k /
 * 0.40 / 3×. In production this module would move to server/src/shared/.
 *
 * What differs on the client:
 * - There is no resident authority, commit latency streak or cache memory
 *   pressure, so `latencyViolationStreak = 0` and `memoryPressure = false`.
 *   Hard urgency therefore only arises from size/structs/ratio/amplification;
 *   the server-side `pauseAdmission` has no client meaning (the relay never
 *   pauses admission for a lease) and is ignored.
 * - Two-phase evaluation. Phase 1 (cheap, before asking for a lease) uses an
 *   *estimated* fresh size; phase 2 (after the build, before upload) re-runs
 *   the same function with the exact fresh size — exactly how the server's
 *   runtime evaluates (it builds first, then decides). A phase-2 "no" releases
 *   the lease without uploading.
 * - Measurement cadence reuses DEFAULT_COMPACTION_MEASUREMENT_CADENCE
 *   (64 commits / 384 KiB ingress / 15 min) counted over updates *this device
 *   observed* on the body (local + remote), plus the server's documentLoaded
 *   rule (loaded encoded state ≥ soft bytes ⇒ measure now).
 * - Cooldown/hysteresis state must be shared by all devices, so it comes from
 *   the server (lease response / body head) when available; the server must
 *   also enforce it when granting a lease (a client can't be trusted to).
 */
import * as Y from "yjs";
import {
	BODY_COMPACTION_THRESHOLDS,
	DEFAULT_COMPACTION_MEASUREMENT_CADENCE,
	compactionMeasurementDue,
	evaluateSemanticCompaction,
	recordCompactionActivity,
	resetCompactionActivity,
	type CompactionActivityCounters,
	type SemanticCompactionDecision,
	type SemanticCompactionMetrics,
	type SemanticCompactionState,
	type SemanticCompactionThresholds,
} from "../../../server/src/semanticCompactionPolicy";
import { canonicalMarkdownBytes } from "../../../server/src/shared/markdownCodec";
import { BODY_TEXT_ROOT, documentCensus, type DocumentCensus, type FreshSnapshot } from "./builder";

export { BODY_COMPACTION_THRESHOLDS, DEFAULT_COMPACTION_MEASUREMENT_CADENCE };
export type { SemanticCompactionDecision, SemanticCompactionState };

/** Fixed per-snapshot Yjs framing overhead allowance (client/struct headers, root names). */
export const FRESH_STATE_OVERHEAD_BYTES = 256;
/**
 * Randomised delay before a lease request so that N devices that all observe
 * the same threshold crossing don't all hit the lease CAS at once. The CAS makes
 * collisions safe; jitter only makes them rare.
 */
export const LEASE_REQUEST_JITTER_MS = 30_000;

export interface ClientBodyMeasurement {
	census: DocumentCensus;
	liveStateBytes: number;
	estimatedFreshStateBytes: number;
	metrics: SemanticCompactionMetrics;
	measureMs: number;
}

/**
 * Conservative fresh-size estimate without building: canonical body bytes +
 * JSON size of the non-body roots + fixed overhead. A fresh body is one
 * ContentString item per text root, one item per map entry.
 */
export function estimateFreshStateBytes(doc: Y.Doc, liveStateBytes: number): number {
	let other = 0;
	for (const [name, type] of doc.share) {
		if (name === BODY_TEXT_ROOT) continue;
		try { other += JSON.stringify(type.toJSON()).length + name.length + 8; }
		catch { other += 1024; }
	}
	return liveStateBytes + other + FRESH_STATE_OVERHEAD_BYTES;
}

export function measureClientBody(doc: Y.Doc): ClientBodyMeasurement {
	const started = performance.now();
	const census = documentCensus(doc);
	const liveStateBytes = canonicalMarkdownBytes(doc.getText(BODY_TEXT_ROOT).toJSON()).byteLength;
	const estimatedFreshStateBytes = Math.min(census.encodedStateBytes, estimateFreshStateBytes(doc, liveStateBytes));
	return {
		census,
		liveStateBytes,
		estimatedFreshStateBytes,
		metrics: {
			scope: "body",
			encodedStateBytes: census.encodedStateBytes,
			liveStateBytes,
			estimatedFreshStateBytes,
			totalStructs: census.totalStructs,
			deletedStructs: census.deletedStructs,
			latencyViolationStreak: 0,
			memoryPressure: false,
		},
		measureMs: performance.now() - started,
	};
}

export interface ClientPolicyVerdict {
	requestLease: boolean;
	decision: SemanticCompactionDecision;
	measurement: ClientBodyMeasurement;
}

/** Phase 1: should this device (which has the note loaded) ask for a compaction lease? */
export function evaluateClientTrigger(
	doc: Y.Doc,
	state: SemanticCompactionState,
	now: number,
	thresholds: Readonly<SemanticCompactionThresholds> = BODY_COMPACTION_THRESHOLDS,
): ClientPolicyVerdict {
	const measurement = measureClientBody(doc);
	const decision = evaluateSemanticCompaction(measurement.metrics, state, now, thresholds);
	return { requestLease: decision.semanticResetRecommended, decision, measurement };
}

/** Phase 2: with the exact fresh size, is the upload still worth it? */
export function confirmAfterBuild(
	fresh: FreshSnapshot,
	state: SemanticCompactionState,
	now: number,
	thresholds: Readonly<SemanticCompactionThresholds> = BODY_COMPACTION_THRESHOLDS,
): SemanticCompactionDecision {
	return evaluateSemanticCompaction({
		scope: "body",
		encodedStateBytes: fresh.before.encodedStateBytes,
		liveStateBytes: fresh.contentBytes,
		estimatedFreshStateBytes: fresh.after.encodedStateBytes,
		totalStructs: fresh.before.totalStructs,
		deletedStructs: fresh.before.deletedStructs,
		latencyViolationStreak: 0,
		memoryPressure: false,
	}, state, now, thresholds);
}

/** Per-body cadence tracker (cheap counters → occasional exact census), as the server runtime does. */
export class ClientCompactionCadence {
	private readonly counters = new Map<string, CompactionActivityCounters>();

	constructor(private readonly now: () => number = Date.now) {}

	/** Record an update observed on the body; returns true when an exact measurement is due. */
	observe(bodyId: string, updateBytes: number): boolean {
		const current = this.counters.get(bodyId) ?? resetCompactionActivity(this.now());
		const next = recordCompactionActivity(current, { ingressBytes: updateBytes });
		this.counters.set(bodyId, next);
		return compactionMeasurementDue(next, this.now(), DEFAULT_COMPACTION_MEASUREMENT_CADENCE);
	}

	/** Server documentLoaded rule: a loaded state ≥ soft bytes is measured immediately. */
	loaded(bodyId: string, encodedStateBytes: number): boolean {
		this.counters.set(bodyId, resetCompactionActivity(this.now()));
		return encodedStateBytes >= BODY_COMPACTION_THRESHOLDS.softEncodedStateBytes;
	}

	measured(bodyId: string): void {
		this.counters.set(bodyId, resetCompactionActivity(this.now()));
	}
}
