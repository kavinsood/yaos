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
} from "../../legacy-src/runtime/reconcile/amplificationQuarantinePolicy";
import { suite } from "../harness.ts";

const s = suite("amplification-quarantine-policy");

s.section("Test 1: Constants are correct");
s.check(AMPLIFICATION_HISTORY_MAX_ENTRIES === 5, "max entries is 5");
s.check(AMPLIFICATION_QUARANTINE_THRESHOLD === 3, "threshold is 3");
s.check(AMPLIFICATION_WINDOW_MS === 15_000, "window is 15 seconds");

s.section("Test 2: First entry does not quarantine");
{
	const result = evaluateAmplificationQuarantine({
		prevLen: 100,
		nextLen: 110,
		now: 1000,
		history: [],
	});
	s.check(result.quarantined === false, "first entry not quarantined");
	if (!result.quarantined) {
		s.check(result.newHistory.length === 1, "history has 1 entry");
		s.check(result.newHistory[0]!.prevLen === 100, "prevLen stored");
		s.check(result.newHistory[0]!.nextLen === 110, "nextLen stored");
	}
}

s.section("Test 3: Two entries does not quarantine");
{
	const history: AmplificationEntry[] = [{ prevLen: 100, nextLen: 110, at: 1000 }];
	const result = evaluateAmplificationQuarantine({
		prevLen: 110,
		nextLen: 120,
		now: 2000,
		history,
	});
	s.check(result.quarantined === false, "two entries not quarantined");
	if (!result.quarantined) {
		s.check(result.newHistory.length === 2, "history has 2 entries");
	}
}

s.section("Test 4: Three monotonic growth entries triggers quarantine");
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
	s.check(result.quarantined === true, "three monotonic growth entries quarantined");
	if (result.quarantined) {
		s.check(result.triggerSlice.length === 3, "trigger slice has 3 entries");
		s.check(result.firstPrevLen === 100, "firstPrevLen correct");
		s.check(result.lastNextLen === 130, "lastNextLen correct");
		s.check(result.consistentDelta === true, "consistent delta (all +10)");
	}
}

s.section("Test 5: Entries outside window do not trigger");
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
	s.check(result.quarantined === false, "entries outside window not quarantined");
}

s.section("Test 6: Non-positive delta does not trigger");
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
	s.check(result.quarantined === false, "negative delta not quarantined");
}

s.section("Test 7: Zero delta does not trigger");
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
	s.check(result.quarantined === false, "zero delta not quarantined");
}

s.section("Test 8: Non-monotonic prevLen does not trigger");
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
	s.check(result.quarantined === false, "non-monotonic prevLen not quarantined");
}

s.section("Test 9: Non-monotonic nextLen does not trigger");
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
	s.check(result.quarantined === false, "non-monotonic nextLen not quarantined");
}

s.section("Test 10: No genuine growth does not trigger");
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
	s.check(result.quarantined === false, "stationary (no growth) not quarantined");
}

s.section("Test 11a: History is capped at max entries (no quarantine, non-monotonic nextLen in last-3 slice)");
{
	// Feed 5 entries where the 4th entry has a LOWER nextLen than the 3rd.
	// After appending the new entry and capping, the last-3 slice includes
	// the non-monotonic entry, so quarantine must NOT fire.
	const history: AmplificationEntry[] = [
		{ prevLen: 10, nextLen: 20, at: 100 }, // ← will be evicted by capping
		{ prevLen: 20, nextLen: 30, at: 200 },
		{ prevLen: 30, nextLen: 40, at: 300 },
		{ prevLen: 40, nextLen: 50, at: 400 },
		{ prevLen: 50, nextLen: 35, at: 500 }, // nextLen DROPS (50 → 35)
	];
	// After appending {prevLen:35, nextLen:45, at:600} and evicting oldest:
	// capped = [{20→30}, {30→40}, {40→50}, {50→35}, {35→45}]
	// last-3 slice: [{40→50}, {50→35}, {35→45}]
	//   nextLen sequence: 50, 35, 45 → 50→35 violates non-decreasing → no quarantine
	const result = evaluateAmplificationQuarantine({
		prevLen: 35,
		nextLen: 45,
		now: 600,
		history,
	});
	s.check(result.quarantined === false, "non-monotonic nextLen in last-3 slice prevents quarantine");
	if (!result.quarantined) {
		s.check(result.newHistory.length === 5, "history capped at max entries (5)");
		s.check(result.newHistory[0]!.prevLen === 20, "oldest entry (prevLen=10) evicted");
	}
}

s.section("Test 11b: History capping also occurs before a quarantine decision");
{
	// Feed a full 5-entry monotonic history. Adding one more should cap to 5 AND
	// trigger quarantine on the resulting slice. We confirm quarantine fires AND
	// that the internal newHistory (built before the quarantine check) would have
	// had the oldest entry evicted — evidenced by the triggerSlice not containing
	// the original first entry.
	const history: AmplificationEntry[] = [
		{ prevLen: 10, nextLen: 20, at: 100 }, // ← this entry should be evicted
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
	s.check(result.quarantined === true, "monotonic growth on full history quarantines");
	if (result.quarantined) {
		// The trigger slice is the last 3 entries of the capped history.
		// After capping, the 5 entries are [20→30, 30→40, 40→50, 50→60, 60→70].
		// Slice of last 3: [40→50, 50→60, 60→70].
		s.check(result.triggerSlice.length === 3, "trigger slice has 3 entries");
		s.check(result.triggerSlice[0]!.prevLen === 40, "oldest evicted; slice starts at prevLen=40");
		s.check(result.firstPrevLen === 40, "firstPrevLen reflects post-eviction slice");
		s.check(result.lastNextLen === 70, "lastNextLen is the new entry");
	}
}

s.section("Test 12: Inconsistent deltas still quarantine but reported");
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
	s.check(result.quarantined === true, "inconsistent deltas still quarantine");
	if (result.quarantined) {
		s.check(result.consistentDelta === false, "consistentDelta is false");
	}
}

s.section("Test 13: findOldestAmplificationEntry on empty map");
{
	const entries = new Map<string, AmplificationEntry[]>();
	const oldest = findOldestAmplificationEntry(entries);
	s.check(oldest === null, "returns null for empty map");
}

s.section("Test 14: findOldestAmplificationEntry finds oldest");
{
	const entries = new Map<string, AmplificationEntry[]>([
		["path/a.md", [{ prevLen: 100, nextLen: 110, at: 3000 }]],
		["path/b.md", [{ prevLen: 100, nextLen: 110, at: 1000 }]], // oldest
		["path/c.md", [{ prevLen: 100, nextLen: 110, at: 2000 }]],
	]);
	const oldest = findOldestAmplificationEntry(entries);
	s.check(oldest === "path/b.md", "finds entry with smallest lastAt");
}

s.section("Test 15: findOldestAmplificationEntry respects excludePath");
{
	const entries = new Map<string, AmplificationEntry[]>([
		["path/a.md", [{ prevLen: 100, nextLen: 110, at: 3000 }]],
		["path/b.md", [{ prevLen: 100, nextLen: 110, at: 1000 }]], // oldest, but excluded
		["path/c.md", [{ prevLen: 100, nextLen: 110, at: 2000 }]], // second oldest
	]);
	const oldest = findOldestAmplificationEntry(entries, "path/b.md");
	s.check(oldest === "path/c.md", "skips excluded path, finds second oldest");
}

s.section("Test 16: Only prevLen growing but not nextLen does not trigger");
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
	s.check(result.quarantined === false, "prevLen-only growth not quarantined");
}

s.section("Test 17: Quarantine decision does NOT return newHistory");
{
	// When quarantined, the policy returns triggerSlice but NOT newHistory.
	// This is intentional: the caller should DELETE the history, not update it.
	// This test documents that contract.
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
	s.check(result.quarantined === true, "quarantine triggered");
	if (result.quarantined) {
		// `in` probes at runtime the same contract the discriminated union
		// enforces at compile time.
		const hasNewHistory = "newHistory" in result;
		s.check(!hasNewHistory, "quarantine decision has no newHistory (caller should delete)");
		s.check("triggerSlice" in result, "quarantine decision has triggerSlice");
	}
}

s.section("Test 18: Non-quarantine decision returns newHistory");
{
	// When NOT quarantined, the policy returns newHistory for the caller to store.
	const history: AmplificationEntry[] = [
		{ prevLen: 100, nextLen: 110, at: 1000 },
	];
	const result = evaluateAmplificationQuarantine({
		prevLen: 110,
		nextLen: 120,
		now: 2000,
		history,
	});
	s.check(result.quarantined === false, "not quarantined");
	if (!result.quarantined) {
		s.check("newHistory" in result, "non-quarantine decision has newHistory");
		s.check(result.newHistory.length === 2, "newHistory includes new entry");
	}
}
await s.done();
