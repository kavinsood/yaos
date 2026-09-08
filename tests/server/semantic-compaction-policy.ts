import assert from "node:assert/strict";

import {
	BODY_COMPACTION_THRESHOLDS,
	compactionMeasurementDue,
	evaluateSemanticCompaction,
	recordCompactionActivity,
	resetCompactionActivity,
} from "../../server/src/semanticCompactionPolicy";
import { suite } from "../harness.ts";

const s = suite("semantic-compaction-policy");
const DAY = 24 * 60 * 60_000;

function body(overrides: Partial<Parameters<typeof evaluateSemanticCompaction>[0]> = {}) {
	return {
		scope: "body" as const,
		encodedStateBytes: 1_000_000,
		liveStateBytes: 700_000,
		estimatedFreshStateBytes: 700_000,
		totalStructs: 10_000,
		deletedStructs: 1_000,
		latencyViolationStreak: 0,
		memoryPressure: false,
		...overrides,
	};
}

s.test("the pathology trace trips multiple soft signals", () => {
	const decision = evaluateSemanticCompaction(body({
		encodedStateBytes: 2_128_183,
		liveStateBytes: 711_596,
		estimatedFreshStateBytes: 711_596,
		totalStructs: 97_356,
		deletedStructs: 34_449,
	}), { lastCompactedAt: null, postCompactionEncodedStateBytes: null }, DAY);
	assert.equal(decision.urgency, "soft");
	assert.equal(decision.pauseAdmission, false);
	assert.equal(decision.semanticResetRecommended, true);
	assert.ok(decision.reasons.includes("struct-count-soft-limit"));
	assert.ok(decision.reasons.includes("deleted-ratio-soft-limit"));
	assert.ok(decision.reasons.includes("history-amplification-soft-limit"));
});

s.test("a large but irreducible document is not churned by a soft reset", () => {
	const decision = evaluateSemanticCompaction(body({
		encodedStateBytes: 2_000_000,
		liveStateBytes: 1_900_000,
		estimatedFreshStateBytes: 1_800_000,
		totalStructs: 55_000,
		deletedStructs: 2_000,
	}), { lastCompactedAt: null, postCompactionEncodedStateBytes: null }, DAY);
	assert.equal(decision.urgency, "none");
	assert.deepEqual(decision.reasons, ["insufficient-projected-reduction"]);
});

s.test("cooldown and low-water hysteresis prevent reset loops", () => {
	const metrics = body({
		encodedStateBytes: 1_600_000,
		estimatedFreshStateBytes: 700_000,
		totalStructs: 60_000,
		deletedStructs: 20_000,
	});
	assert.deepEqual(
		evaluateSemanticCompaction(metrics, { lastCompactedAt: DAY, postCompactionEncodedStateBytes: 500_000 }, DAY + 1).reasons,
		["soft-cooldown"],
	);
	const lowWater = evaluateSemanticCompaction(
		{ ...metrics, encodedStateBytes: 700_000, liveStateBytes: 300_000, estimatedFreshStateBytes: 300_000 },
		{ lastCompactedAt: 0, postCompactionEncodedStateBytes: 500_000 },
		2 * DAY,
		{ ...BODY_COMPACTION_THRESHOLDS, softEncodedStateBytes: 600_000, softStructs: 50_000 },
	);
	assert.deepEqual(lowWater.reasons, ["hysteresis-low-water"]);
	assert.equal(evaluateSemanticCompaction(metrics, {
		lastCompactedAt: 0, postCompactionEncodedStateBytes: 500_000,
	}, 2 * DAY).urgency, "soft");
});

s.test("hard operational pressure bypasses savings, cooldown and hysteresis", () => {
	const decision = evaluateSemanticCompaction(body({ memoryPressure: true }), {
		lastCompactedAt: DAY,
		postCompactionEncodedStateBytes: 900_000,
	}, DAY + 1);
	assert.equal(decision.urgency, "hard");
	assert.equal(decision.pauseAdmission, true);
	assert.equal(decision.semanticResetRecommended, false, "a reset cannot solve irreducible memory pressure");
	assert.deepEqual(decision.reasons, ["memory-pressure", "insufficient-projected-reduction"]);
});

s.test("body and root thresholds are independently selectable", () => {
	const metrics = body({
		scope: "root",
		encodedStateBytes: 1_100_000,
		liveStateBytes: 300_000,
		estimatedFreshStateBytes: 300_000,
		totalStructs: 25_000,
		deletedStructs: 10_000,
	});
	const decision = evaluateSemanticCompaction(metrics, { lastCompactedAt: null, postCompactionEncodedStateBytes: null }, DAY);
	assert.equal(decision.urgency, "hard", "root deleted ratio reaches the hard threshold");
	assert.ok(decision.reasons.includes("history-amplification-hard-limit"));
});

s.test("cheap counters schedule but do not perform exact measurement", () => {
	let counters = resetCompactionActivity(1_000);
	counters = recordCompactionActivity(counters, { commits: 63, ingressBytes: 100 });
	assert.equal(compactionMeasurementDue(counters, 2_000), false);
	counters = recordCompactionActivity(counters, { ingressBytes: 100 });
	assert.equal(compactionMeasurementDue(counters, 2_000), true);
	assert.equal(compactionMeasurementDue(resetCompactionActivity(0), 15 * 60_000), true);
	assert.equal(compactionMeasurementDue({ commits: 0, ingressBytes: 384 * 1024, lastMeasuredAt: 1 }, 2), true);
});

s.test("invalid censuses fail closed", () => {
	assert.throws(() => evaluateSemanticCompaction(body({ totalStructs: 1, deletedStructs: 2 }), {
		lastCompactedAt: null, postCompactionEncodedStateBytes: null,
	}, 1), /invalid struct census/);
});

s.test("ratios do not thrash tiny documents", () => {
	const decision = evaluateSemanticCompaction(body({
		encodedStateBytes: 100,
		liveStateBytes: 1,
		estimatedFreshStateBytes: 1,
		totalStructs: 2,
		deletedStructs: 1,
	}), { lastCompactedAt: null, postCompactionEncodedStateBytes: null }, 1);
	assert.equal(decision.urgency, "none");
});

await s.done();
