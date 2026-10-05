/**
 * Tests for fingerprint quarantine policy.
 *
 * Proves:
 * - Quarantine triggers at threshold (3 repeats)
 * - Count resets after TTL expires
 * - Count resets on different fingerprint
 * - Count increments within TTL window
 * - Fingerprint computation is deterministic
 * - Map eviction finds oldest entry
 * - Edge cases (first attempt, exactly at threshold)
 */

import {
	computeRecoveryFingerprint,
	evaluateFingerprintQuarantine,
	findOldestFingerprintEntry,
	FINGERPRINT_QUARANTINE_THRESHOLD,
	FINGERPRINT_QUARANTINE_TTL_MS,
	FINGERPRINT_MAP_MAX_SIZE,
	type FingerprintEntry,
} from "../../legacy-src/runtime/reconcile/fingerprintQuarantinePolicy";
import { suite } from "../harness.ts";

const s = suite("fingerprint-quarantine-policy");

s.section("Test 1: Constants are correct");
s.check(FINGERPRINT_QUARANTINE_THRESHOLD === 3, "threshold is 3");
s.check(FINGERPRINT_QUARANTINE_TTL_MS === 10 * 60_000, "TTL is 10 minutes");
s.check(FINGERPRINT_MAP_MAX_SIZE === 200, "map max size is 200");

s.section("Test 2: Fingerprint computation is deterministic");
{
	const fp1 = computeRecoveryFingerprint("reason-a", "prev", "next");
	const fp2 = computeRecoveryFingerprint("reason-a", "prev", "next");
	s.check(fp1 === fp2, "same inputs produce same fingerprint");

	const fp3 = computeRecoveryFingerprint("reason-b", "prev", "next");
	s.check(fp1 !== fp3, "different reason produces different fingerprint");

	const fp4 = computeRecoveryFingerprint("reason-a", "different", "next");
	s.check(fp1 !== fp4, "different previousContent produces different fingerprint");

	const fp5 = computeRecoveryFingerprint("reason-a", "prev", "different");
	s.check(fp1 !== fp5, "different nextContent produces different fingerprint");
}

s.section("Test 3: First attempt does not quarantine");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now: 1000,
		previous: undefined,
	});
	s.check(result.quarantined === false, "first attempt not quarantined");
	s.check(result.newEntry.count === 1, "count starts at 1");
	s.check(result.newEntry.fingerprint === fingerprint, "fingerprint stored");
	s.check(result.newEntry.lastAt === 1000, "timestamp stored");
}

s.section("Test 4: Second attempt increments count");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const previous: FingerprintEntry = { fingerprint, count: 1, lastAt: 1000 };
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now: 2000,
		previous,
	});
	s.check(result.quarantined === false, "second attempt not quarantined");
	s.check(result.newEntry.count === 2, "count incremented to 2");
}

s.section("Test 5: Third attempt triggers quarantine");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const previous: FingerprintEntry = { fingerprint, count: 2, lastAt: 2000 };
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now: 3000,
		previous,
	});
	s.check(result.quarantined === true, "third attempt quarantined");
	s.check(result.newEntry.count === 3, "count is 3");
	if (result.quarantined) {
		s.check(result.reason.includes("3 attempts"), "reason mentions count");
	}
}

s.section("Test 6: Count resets on different fingerprint");
{
	const fp1 = computeRecoveryFingerprint("test", "a", "b");
	const fp2 = computeRecoveryFingerprint("test", "a", "c"); // different next content
	const previous: FingerprintEntry = { fingerprint: fp1, count: 2, lastAt: 2000 };
	const result = evaluateFingerprintQuarantine({
		fingerprint: fp2,
		now: 3000,
		previous,
	});
	s.check(result.quarantined === false, "different fingerprint not quarantined");
	s.check(result.newEntry.count === 1, "count reset to 1");
	s.check(result.newEntry.fingerprint === fp2, "new fingerprint stored");
}

s.section("Test 7: Count resets after TTL expires");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const previous: FingerprintEntry = { fingerprint, count: 2, lastAt: 1000 };
	// TTL is 10 minutes = 600,000ms. Advance past it.
	const now = 1000 + FINGERPRINT_QUARANTINE_TTL_MS + 1;
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now,
		previous,
	});
	s.check(result.quarantined === false, "expired fingerprint not quarantined");
	s.check(result.newEntry.count === 1, "count reset to 1 after TTL");
}

s.section("Test 8: Count preserved just before TTL expires (triggers quarantine)");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const previous: FingerprintEntry = { fingerprint, count: 2, lastAt: 1000 };
	// Just before TTL expires - count increments to 3 (threshold)
	const now = 1000 + FINGERPRINT_QUARANTINE_TTL_MS - 1;
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now,
		previous,
	});
	s.check(result.quarantined === true, "within TTL, count reaches 3, quarantined");
	s.check(result.newEntry.count === 3, "count incremented to 3");
}

s.section("Test 9: Fourth attempt stays quarantined");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const previous: FingerprintEntry = { fingerprint, count: 3, lastAt: 3000 };
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now: 4000,
		previous,
	});
	s.check(result.quarantined === true, "fourth attempt also quarantined");
	s.check(result.newEntry.count === 4, "count is 4");
}

s.section("Test 10: findOldestFingerprintEntry on empty map");
{
	const entries = new Map<string, FingerprintEntry>();
	const oldest = findOldestFingerprintEntry(entries);
	s.check(oldest === null, "returns null for empty map");
}

s.section("Test 11: findOldestFingerprintEntry finds oldest");
{
	const entries = new Map<string, FingerprintEntry>([
		["path/a.md", { fingerprint: "fp-a", count: 1, lastAt: 3000 }],
		["path/b.md", { fingerprint: "fp-b", count: 2, lastAt: 1000 }], // oldest
		["path/c.md", { fingerprint: "fp-c", count: 1, lastAt: 2000 }],
	]);
	const oldest = findOldestFingerprintEntry(entries);
	s.check(oldest === "path/b.md", "finds entry with smallest lastAt");
}

s.section("Test 12: Exact boundary - exactly at threshold");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	// Threshold is 3, so count === 3 should trigger
	const previous: FingerprintEntry = { fingerprint, count: 2, lastAt: 2000 };
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now: 3000,
		previous,
	});
	s.check(result.quarantined === true, "exactly at threshold triggers");
	s.check(result.newEntry.count === 3, "count is exactly 3");
}

s.section("Test 13: Below threshold does not quarantine");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	// count === 2 is below threshold of 3
	const previous: FingerprintEntry = { fingerprint, count: 1, lastAt: 1000 };
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now: 2000,
		previous,
	});
	s.check(result.quarantined === false, "below threshold does not trigger");
	s.check(result.newEntry.count === 2, "count is 2");
}

s.section("Test 14: Exact TTL boundary - exactly at TTL resets");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const previous: FingerprintEntry = { fingerprint, count: 2, lastAt: 1000 };
	// Exactly at TTL boundary: (now - lastAt) === TTL
	// The code uses < TTL, so === TTL should reset
	const now = 1000 + FINGERPRINT_QUARANTINE_TTL_MS;
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now,
		previous,
	});
	s.check(result.quarantined === false, "exactly at TTL boundary resets count");
	s.check(result.newEntry.count === 1, "count reset to 1 at exact TTL");
}

s.section("Test 15: Different fingerprint within TTL resets count");
{
	const fp1 = computeRecoveryFingerprint("test", "content-a", "content-b");
	const fp2 = computeRecoveryFingerprint("test", "content-a", "content-c"); // different next
	const previous: FingerprintEntry = { fingerprint: fp1, count: 2, lastAt: 1000 };
	// Same path, within TTL, but different fingerprint
	const result = evaluateFingerprintQuarantine({
		fingerprint: fp2,
		now: 2000, // well within TTL
		previous,
	});
	s.check(result.quarantined === false, "different fingerprint within TTL does not quarantine");
	s.check(result.newEntry.count === 1, "count reset to 1 for different fingerprint");
	s.check(result.newEntry.fingerprint === fp2, "new fingerprint stored");
}

s.section("Test 16: Exact reason string (golden test)");
{
	const fingerprint = computeRecoveryFingerprint("test", "a", "b");
	const previous: FingerprintEntry = { fingerprint, count: 2, lastAt: 1000 };
	const result = evaluateFingerprintQuarantine({
		fingerprint,
		now: 2000,
		previous,
	});
	s.check(result.quarantined === true, "quarantined for golden test");
	if (result.quarantined) {
		const expected = "repeated recovery fingerprint (3 attempts)";
		s.check(
			result.reason === expected,
			`exact reason string matches: got "${result.reason}"`,
		);
	}
}
await s.done();
