/**
 * Fingerprint quarantine policy — pure decision logic for recovery loop detection.
 *
 * The fingerprint quarantine detects when the same recovery operation is
 * repeating (same previous→next content transition). This catches loops
 * where an external edit keeps arriving identically, triggering repeated
 * CRDT imports.
 *
 * Constraints:
 *   - Synchronous (no async)
 *   - No Obsidian imports
 *   - No disk I/O
 *   - No trace calls
 *   - No `this`
 *   - Pure: same inputs → same output
 *
 * Note: This policy is stateless. The caller (controller) manages the
 * mutable state (fingerprint map) and passes current state to the policy.
 */

import { contentFingerprint } from "../../sync/diskIndex";

// -----------------------------------------------------------------------
// Policy constants — can be tuned without touching decision logic
// -----------------------------------------------------------------------

/** Number of repeated fingerprints before quarantine triggers. */
export const FINGERPRINT_QUARANTINE_THRESHOLD = 3;

/** Time-to-live for fingerprint counts. Beyond this, count resets to 1. */
export const FINGERPRINT_QUARANTINE_TTL_MS = 10 * 60_000; // 10 minutes

/** Maximum entries in the fingerprint map before eviction. */
export const FINGERPRINT_MAP_MAX_SIZE = 200;

// -----------------------------------------------------------------------
// Fingerprint computation — exported for use by controller
// -----------------------------------------------------------------------

/**
 * Compute a recovery fingerprint from reason and content transition.
 *
 * The fingerprint captures the "shape" of the recovery: what kind of
 * recovery it is and what content changed. Two recoveries with the same
 * fingerprint are semantically identical operations.
 */
export function computeRecoveryFingerprint(
	reason: string,
	previousContent: string,
	nextContent: string,
): string {
	return `${reason}\x00${contentFingerprint(previousContent)}\x00${contentFingerprint(nextContent)}`;
}

// -----------------------------------------------------------------------
// State types — managed by caller, passed to policy
// -----------------------------------------------------------------------

export interface FingerprintEntry {
	readonly fingerprint: string;
	readonly count: number;
	readonly lastAt: number;
}

export interface FingerprintQuarantineInput {
	/** Current fingerprint for this recovery attempt. */
	readonly fingerprint: string;
	/** Current timestamp (ms since epoch). */
	readonly now: number;
	/** Previous entry for this path, if any. */
	readonly previous: FingerprintEntry | undefined;
}

// -----------------------------------------------------------------------
// Output types — the policy decision
// -----------------------------------------------------------------------

export type FingerprintQuarantineDecision =
	| {
			readonly quarantined: false;
			readonly newEntry: FingerprintEntry;
	  }
	| {
			readonly quarantined: true;
			readonly newEntry: FingerprintEntry;
			readonly reason: string;
	  };

// -----------------------------------------------------------------------
// Policy function — pure, no side effects
// -----------------------------------------------------------------------

/**
 * Evaluate whether a recovery should be quarantined based on fingerprint repetition.
 *
 * Decision logic:
 * - Same fingerprint within TTL → increment count
 * - Same fingerprint beyond TTL → reset to 1 (fresh start)
 * - Different fingerprint → reset to 1
 * - If count reaches threshold → quarantine
 *
 * Returns both the decision and the new entry to store.
 */
export function evaluateFingerprintQuarantine(
	input: FingerprintQuarantineInput,
): FingerprintQuarantineDecision {
	const { fingerprint, now, previous } = input;

	const sameFingerprint = previous?.fingerprint === fingerprint;
	const withinTtl =
		sameFingerprint && now - (previous?.lastAt ?? 0) < FINGERPRINT_QUARANTINE_TTL_MS;
	const count = withinTtl ? previous.count + 1 : 1;

	const newEntry: FingerprintEntry = {
		fingerprint,
		count,
		lastAt: now,
	};

	if (count >= FINGERPRINT_QUARANTINE_THRESHOLD) {
		return {
			quarantined: true,
			newEntry,
			reason: `repeated recovery fingerprint (${count} attempts)`,
		};
	}

	return {
		quarantined: false,
		newEntry,
	};
}

// -----------------------------------------------------------------------
// Map eviction helper — pure function for LRU-style eviction
// -----------------------------------------------------------------------

/**
 * Find the oldest entry in a fingerprint map for eviction.
 *
 * Returns the path of the oldest entry, or null if the map is empty.
 * Caller should delete this entry when map size exceeds FINGERPRINT_MAP_MAX_SIZE.
 */
export function findOldestFingerprintEntry(
	entries: ReadonlyMap<string, FingerprintEntry>,
): string | null {
	let oldestPath: string | null = null;
	let oldestAt = Infinity;

	for (const [path, entry] of entries) {
		if (entry.lastAt < oldestAt) {
			oldestAt = entry.lastAt;
			oldestPath = path;
		}
	}

	return oldestPath;
}
