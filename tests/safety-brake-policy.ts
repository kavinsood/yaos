/**
 * Tests for safety brake policy.
 *
 * Proves:
 * - Brake does NOT trigger when count is below threshold
 * - Brake does NOT trigger when ratio is below threshold
 * - Brake triggers only when BOTH thresholds exceeded
 * - Ratio computation is correct
 * - Reason string is descriptive
 * - Edge cases (zero files, exact boundaries)
 */

import {
	evaluateSafetyBrake,
	SAFETY_BRAKE_MIN_COUNT,
	SAFETY_BRAKE_MIN_RATIO,
} from "../src/runtime/reconcile/safetyBrakePolicy";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

console.log("\n--- Test 1: Constants are correct ---");
assert(SAFETY_BRAKE_MIN_COUNT === 20, "min count is 20");
assert(SAFETY_BRAKE_MIN_RATIO === 0.25, "min ratio is 0.25");

console.log("\n--- Test 2: No brake when count below threshold ---");
{
	// 10 of 20 files = 50% ratio, but only 10 destructive (below 20)
	const result = evaluateSafetyBrake({ destructiveCount: 10, localFileCount: 20 });
	assert(result.triggered === false, "not triggered when count < 20");
	assert(result.destructiveRatio === 0.5, "ratio computed correctly (0.5)");
}

console.log("\n--- Test 3: No brake when ratio below threshold ---");
{
	// 25 of 200 files = 12.5% ratio (below 25%), but 25 destructive (above 20)
	const result = evaluateSafetyBrake({ destructiveCount: 25, localFileCount: 200 });
	assert(result.triggered === false, "not triggered when ratio < 0.25");
	assert(result.destructiveRatio === 0.125, "ratio computed correctly (0.125)");
}

console.log("\n--- Test 4: Brake triggers when both thresholds exceeded ---");
{
	// 30 of 100 files = 30% ratio (above 25%), and 30 destructive (above 20)
	const result = evaluateSafetyBrake({ destructiveCount: 30, localFileCount: 100 });
	assert(result.triggered === true, "triggered when both exceeded");
	assert(result.destructiveRatio === 0.3, "ratio computed correctly (0.3)");
	if (result.triggered) {
		assert(result.reason.includes("30 local files"), "reason mentions count");
		assert(result.reason.includes("30%"), "reason mentions percentage");
	}
}

console.log("\n--- Test 5: Exact boundary - count exactly 20 ---");
{
	// Exactly 20 destructive, 40 total = 50% ratio
	// count must be > 20 (not >=), so 20 should NOT trigger
	const result = evaluateSafetyBrake({ destructiveCount: 20, localFileCount: 40 });
	assert(result.triggered === false, "not triggered at exactly 20 (must be > 20)");
}

console.log("\n--- Test 6: Exact boundary - count exactly 21 ---");
{
	// 21 destructive, 42 total = 50% ratio
	// Both thresholds exceeded
	const result = evaluateSafetyBrake({ destructiveCount: 21, localFileCount: 42 });
	assert(result.triggered === true, "triggered at 21 (> 20)");
}

console.log("\n--- Test 7: Exact boundary - ratio exactly 0.25 ---");
{
	// 25 of 100 = exactly 0.25 ratio
	// ratio must be > 0.25 (not >=), so 0.25 should NOT trigger
	const result = evaluateSafetyBrake({ destructiveCount: 25, localFileCount: 100 });
	assert(result.triggered === false, "not triggered at exactly 0.25 (must be > 0.25)");
}

console.log("\n--- Test 8: Exact boundary - ratio just above 0.25 ---");
{
	// 26 of 100 = 0.26 ratio (just above threshold)
	// Both thresholds exceeded
	const result = evaluateSafetyBrake({ destructiveCount: 26, localFileCount: 100 });
	assert(result.triggered === true, "triggered at 0.26 (> 0.25)");
}

console.log("\n--- Test 9: Zero local files ---");
{
	// 30 destructive but 0 local files (edge case)
	// Ratio should be 0, not trigger
	const result = evaluateSafetyBrake({ destructiveCount: 30, localFileCount: 0 });
	assert(result.triggered === false, "not triggered when localFileCount is 0");
	assert(result.destructiveRatio === 0, "ratio is 0 when no local files");
}

console.log("\n--- Test 10: Zero destructive count ---");
{
	// 0 destructive, 100 local files
	const result = evaluateSafetyBrake({ destructiveCount: 0, localFileCount: 100 });
	assert(result.triggered === false, "not triggered when no destructive writes");
	assert(result.destructiveRatio === 0, "ratio is 0");
}

console.log("\n--- Test 11: Large vault, low ratio ---");
{
	// 50 of 10000 files = 0.5% ratio
	const result = evaluateSafetyBrake({ destructiveCount: 50, localFileCount: 10000 });
	assert(result.triggered === false, "not triggered on large vault with low ratio");
	assert(result.destructiveRatio === 0.005, "ratio computed correctly (0.005)");
}

console.log("\n--- Test 12: Large vault, high ratio ---");
{
	// 3000 of 10000 files = 30% ratio
	const result = evaluateSafetyBrake({ destructiveCount: 3000, localFileCount: 10000 });
	assert(result.triggered === true, "triggered on large vault with high ratio");
	assert(result.destructiveRatio === 0.3, "ratio computed correctly (0.3)");
	if (result.triggered) {
		assert(result.reason.includes("3000 local files"), "reason mentions count");
	}
}

console.log("\n--- Test 13: Small vault, all files ---");
{
	// 5 of 5 files = 100% ratio, but only 5 files
	const result = evaluateSafetyBrake({ destructiveCount: 5, localFileCount: 5 });
	assert(result.triggered === false, "not triggered on tiny vault (count < 20)");
	assert(result.destructiveRatio === 1.0, "ratio is 1.0 (100%)");
}

console.log("\n--- Test 14: Exact reason string (golden test) ---");
{
	// 21 of 80 = 26.25% ratio -> rounds to 26%
	const result = evaluateSafetyBrake({ destructiveCount: 21, localFileCount: 80 });
	assert(result.triggered === true, "triggered for golden test");
	if (result.triggered) {
		const expected = "refusing to overwrite 21 local files (26% of disk files)";
		assert(
			result.reason === expected,
			`exact reason string matches: got "${result.reason}"`,
		);
	}
}

console.log("\n--- Test 15: Exact reason string with different values ---");
{
	// 150 of 500 = 30% ratio
	const result = evaluateSafetyBrake({ destructiveCount: 150, localFileCount: 500 });
	assert(result.triggered === true, "triggered for second golden test");
	if (result.triggered) {
		const expected = "refusing to overwrite 150 local files (30% of disk files)";
		assert(
			result.reason === expected,
			`exact reason string matches: got "${result.reason}"`,
		);
	}
}

console.log("\n───────────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("───────────────────────────────────────────────────────\n");

process.exit(failed > 0 ? 1 : 0);
