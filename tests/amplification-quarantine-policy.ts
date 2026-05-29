/**
 * Tests for amplification quarantine policy.
 *
 * Proves:
 * - Quarantine triggers on monotonic growth pattern
 * - Does not trigger with insufficient history
 * - Does not trigger outside time window
 * - Does not trigger without positive deltas
 * - Does not trigger without monotonic lengths
 * - Does not trigger without genuine growth
 * - History is properly managed (max entries)
 * - Map eviction finds oldest entry
 */

import {
	evaluateAmplificationQuarantine,
	findOldestAmplificationEntry,
	AMPLIFICATION_HISTORY_MAX_ENTRIES,
	AMPLIFICATION_QUARANTINE_THRESHOLD,
	AMPLIFICATION_WINDOW_MS,
	type AmplificationEntry,
} from "../src/runtime/reconcile/amplificationQuarantinePolicy";

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
assert(AMPLIFICATION_HISTORY_MAX_ENTRIES === 5, "max entries is 5");
assert(AMPLIFICATION_QUARANTINE_THRESHOLD === 3, "threshold is 3");
assert(AMPLIFICATION_WINDOW_MS === 15_000, "window is 15 seconds");

console.log("\n--- Test 2: First entry does not quarantine ---");
{
	const result = evaluateAmplificationQuarantine({
		prevLen: 100,
		nextLen: 110,
		now: 1000,
		history: [],
	});
	assert(result.quarantined === false, "first entry not quarantined");
	if (!result.quarantined) {
		assert(result.newHistory.length === 1, "history has 1 entry");
		assert(result.newHistory[0]!.prevLen === 100, "prevLen stored");
		assert(result.newHistory[0]!.nextLen === 110, "nextLen stored");
	}
}

console.log("\n--- Test 3: Two entries does not quarantine ---");
{
	const history: AmplificationEntry[] = [{ prevLen: 100, nextLen: 110, at: 1000 }];
	const result = evaluateAmplificationQuarantine({
		prevLen: 110,
		nextLen: 120,
		now: 2000,
		history,
	});
	assert(result.quarantined === false, "two entries not quarantined");
	if (!result.quarantined) {
		assert(result.newHistory.length === 2, "history has 2 entries");
	}
}

console.log("\n--- Test 4: Three monotonic growth entries triggers quarantine ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
		{ prevLen: 110, nextLen: 120, at: 2000 },
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 120,
		nextLen: 130,
		now: 3000,
		history,
	});
	assert(result.quarantined === true, "three monotonic growth entries quarantined");
	if (result.quarantined) {
		assert(result.triggerSlice.length === 3, "trigger slice has 3 entries");
		assert(result.firstPrevLen === 100, "firstPrevLen correct");
		assert(result.lastNextLen === 130, "lastNextLen correct");
		assert(result.consistentDelta === true, "consistent delta (all +10)");
	}
}

console.log("\n--- Test 5: Entries outside window do not trigger ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
		{ prevLen: 110, nextLen: 120, at: 2000 },
	];
	// Third entry is way outside the 15s window
	const result = evaluateAmplificationQuarantine({
		prevLen: 120,
		nextLen: 130,
		now: 1000 + AMPLIFICATION_WINDOW_MS + 1000, // 16+ seconds later
		history,
	});
	assert(result.quarantined === false, "entries outside window not quarantined");
}

console.log("\n--- Test 6: Non-positive delta does not trigger ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
		{ prevLen: 110, nextLen: 120, at: 2000 },
	];
	// Third entry has negative delta (nextLen < prevLen)
	const result = evaluateAmplificationQuarantine({
		prevLen: 130,
		nextLen: 120, // negative delta
		now: 3000,
		history,
	});
	assert(result.quarantined === false, "negative delta not quarantined");
}

console.log("\n--- Test 7: Zero delta does not trigger ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
		{ prevLen: 110, nextLen: 120, at: 2000 },
	];
	// Third entry has zero delta
	const result = evaluateAmplificationQuarantine({
		prevLen: 120,
		nextLen: 120, // zero delta
		now: 3000,
		history,
	});
	assert(result.quarantined === false, "zero delta not quarantined");
}

console.log("\n--- Test 8: Non-monotonic prevLen does not trigger ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
		{ prevLen: 90, nextLen: 100, at: 2000 }, // prevLen decreased
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 100,
		nextLen: 110,
		now: 3000,
		history,
	});
	assert(result.quarantined === false, "non-monotonic prevLen not quarantined");
}

console.log("\n--- Test 9: Non-monotonic nextLen does not trigger ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
		{ prevLen: 110, nextLen: 105, at: 2000 }, // nextLen decreased (but still > prevLen)
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 105,
		nextLen: 115,
		now: 3000,
		history,
	});
	assert(result.quarantined === false, "non-monotonic nextLen not quarantined");
}

console.log("\n--- Test 10: No genuine growth does not trigger ---");
{
	// All entries have same prevLen/nextLen (stationary, not growing)
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
		{ prevLen: 100, nextLen: 110, at: 2000 },
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 100,
		nextLen: 110,
		now: 3000,
		history,
	});
	assert(result.quarantined === false, "stationary (no growth) not quarantined");
}

console.log("\n--- Test 11: History is capped at max entries ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 10, nextLen: 20, at: 100 },
		{ prevLen: 20, nextLen: 30, at: 200 },
		{ prevLen: 30, nextLen: 40, at: 300 },
		{ prevLen: 40, nextLen: 50, at: 400 },
		{ prevLen: 50, nextLen: 60, at: 500 },
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 60,
		nextLen: 70,
		now: 600,
		history,
	});
	// New entry added, oldest evicted
	if (!result.quarantined) {
		assert(result.newHistory.length === 5, "history capped at 5 entries");
		assert(result.newHistory[0]!.prevLen === 20, "oldest entry evicted");
	}
}

console.log("\n--- Test 12: Inconsistent deltas still quarantine but reported ---");
{
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 105, at: 1000 }, // delta +5
		{ prevLen: 105, nextLen: 120, at: 2000 }, // delta +15
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 120,
		nextLen: 130, // delta +10
		now: 3000,
		history,
	});
	assert(result.quarantined === true, "inconsistent deltas still quarantine");
	if (result.quarantined) {
		assert(result.consistentDelta === false, "consistentDelta is false");
	}
}

console.log("\n--- Test 13: findOldestAmplificationEntry on empty map ---");
{
	const entries = new Map<string, AmplificationEntry[]>();
	const oldest = findOldestAmplificationEntry(entries);
	assert(oldest === null, "returns null for empty map");
}

console.log("\n--- Test 14: findOldestAmplificationEntry finds oldest ---");
{
	const entries = new Map<string, AmplificationEntry[]>([
		["path/a.md", [{ prevLen: 100, nextLen: 110, at: 3000 }]],
		["path/b.md", [{ prevLen: 100, nextLen: 110, at: 1000 }]], // oldest
		["path/c.md", [{ prevLen: 100, nextLen: 110, at: 2000 }]],
	]);
	const oldest = findOldestAmplificationEntry(entries);
	assert(oldest === "path/b.md", "finds entry with smallest lastAt");
}

console.log("\n--- Test 15: findOldestAmplificationEntry respects excludePath ---");
{
	const entries = new Map<string, AmplificationEntry[]>([
		["path/a.md", [{ prevLen: 100, nextLen: 110, at: 3000 }]],
		["path/b.md", [{ prevLen: 100, nextLen: 110, at: 1000 }]], // oldest, but excluded
		["path/c.md", [{ prevLen: 100, nextLen: 110, at: 2000 }]], // second oldest
	]);
	const oldest = findOldestAmplificationEntry(entries, "path/b.md");
	assert(oldest === "path/c.md", "skips excluded path, finds second oldest");
}

console.log("\n--- Test 16: Only prevLen growing but not nextLen does not trigger ---");
{
	// prevLen grows but nextLen stays same (not genuine amplification)
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 150, at: 1000 },
		{ prevLen: 110, nextLen: 150, at: 2000 },
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 120,
		nextLen: 150, // nextLen not growing
		now: 3000,
		history,
	});
	assert(result.quarantined === false, "prevLen-only growth not quarantined");
}

console.log("\n───────────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("───────────────────────────────────────────────────────\n");

process.exit(failed > 0 ? 1 : 0);
