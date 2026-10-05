/**
 * Amplification quarantine policy — pure decision logic for recovery loop detection.
 *
 * The amplification quarantine detects monotonic-growth recovery loops: cycles
 * where content grows incrementally (e.g., typing-cadence loops where each
 * cycle adds a few characters). This is independent of fingerprint quarantine,
 * which catches identical repeats.
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
 * mutable state (history map) and passes current state to the policy.
 */

// -----------------------------------------------------------------------
// Policy constants — can be tuned without touching decision logic
// -----------------------------------------------------------------------

/** Maximum entries to keep in history per path. */
export const AMPLIFICATION_HISTORY_MAX_ENTRIES = 5;

/** Number of entries needed to evaluate quarantine. */
export const AMPLIFICATION_QUARANTINE_THRESHOLD = 3;

/** Time window (ms) within which entries must fall to trigger quarantine. */
export const AMPLIFICATION_WINDOW_MS = 15_000;

// -----------------------------------------------------------------------
// State types — managed by caller, passed to policy
// -----------------------------------------------------------------------

export interface AmplificationEntry {
	readonly prevLen: number;
	readonly nextLen: number;
	readonly at: number;
}

export interface AmplificationQuarantineInput {
	/** Current recovery: previous content length. */
	readonly prevLen: number;
	/** Current recovery: next content length. */
	readonly nextLen: number;
	/** Current timestamp (ms since epoch). */
	readonly now: number;
	/** Existing history for this path (may be empty). */
	readonly history: readonly AmplificationEntry[];
}

// -----------------------------------------------------------------------
// Output types — the policy decision
// -----------------------------------------------------------------------

export type AmplificationQuarantineDecision =
	| {
			readonly quarantined: false;
			/** Updated history (including the new entry). */
			readonly newHistory: AmplificationEntry[];
	  }
	| {
			readonly quarantined: true;
			/** The slice that triggered quarantine. */
			readonly triggerSlice: AmplificationEntry[];
			/** Whether all entries had the same delta. */
			readonly consistentDelta: boolean;
			/** First prevLen in the slice. */
			readonly firstPrevLen: number;
			/** Last nextLen in the slice. */
			readonly lastNextLen: number;
	  };

// -----------------------------------------------------------------------
// Policy function — pure, no side effects
// -----------------------------------------------------------------------

/**
 * Evaluate whether a recovery should be quarantined based on amplification pattern.
 *
 * The amplification pattern is detected when the most recent
 * AMPLIFICATION_QUARANTINE_THRESHOLD entries ALL satisfy:
 *   1. Fall within AMPLIFICATION_WINDOW_MS of the most recent entry
 *   2. Have strictly positive delta (nextLen - prevLen > 0)
 *   3. Non-decreasing prevLen across the slice
 *   4. Non-decreasing nextLen across the slice
 *   5. Genuine growth: both prevLen and nextLen are STRICTLY larger at
 *      the end than at the beginning of the slice
 *
 * When quarantined, the caller should clear the history for the path.
 */
export function evaluateAmplificationQuarantine(
	input: AmplificationQuarantineInput,
): AmplificationQuarantineDecision {
	const { prevLen, nextLen, now, history } = input;
	const entry: AmplificationEntry = { prevLen, nextLen, at: now };

	// Build updated history (mutable copy).
	const newHistory = [...history, entry];

	// Keep at most MAX entries, evict oldest.
	while (newHistory.length > AMPLIFICATION_HISTORY_MAX_ENTRIES) {
		newHistory.shift();
	}

	// Not enough entries to evaluate.
	if (newHistory.length < AMPLIFICATION_QUARANTINE_THRESHOLD) {
		return { quarantined: false, newHistory };
	}

	// Take the most recent THRESHOLD entries.
	const slice = newHistory.slice(-AMPLIFICATION_QUARANTINE_THRESHOLD);
	const last = slice[slice.length - 1]!;

	// 1. All entries must be within the window of the most recent one.
	const inWindow = slice.every((e) => last.at - e.at <= AMPLIFICATION_WINDOW_MS);
	if (!inWindow) {
		return { quarantined: false, newHistory };
	}

	// 2. Strictly positive delta in every entry.
	const allPositiveDelta = slice.every((e) => e.nextLen - e.prevLen > 0);
	if (!allPositiveDelta) {
		return { quarantined: false, newHistory };
	}

	// 3 & 4. Non-decreasing prevLen and non-decreasing nextLen across the slice.
	let monotonicPrev = true;
	let monotonicNext = true;
	for (let i = 1; i < slice.length; i++) {
		if (slice[i]!.prevLen < slice[i - 1]!.prevLen) monotonicPrev = false;
		if (slice[i]!.nextLen < slice[i - 1]!.nextLen) monotonicNext = false;
	}
	if (!monotonicPrev || !monotonicNext) {
		return { quarantined: false, newHistory };
	}

	// 5. Genuine growth: both prevLen and nextLen must be STRICTLY larger
	// at the end of the slice than at the beginning.
	const grew =
		slice[slice.length - 1]!.prevLen > slice[0]!.prevLen &&
		slice[slice.length - 1]!.nextLen > slice[0]!.nextLen;
	if (!grew) {
		return { quarantined: false, newHistory };
	}

	// Quarantine triggered!
	// Diagnostic: did every entry have the same delta?
	const firstDelta = slice[0]!.nextLen - slice[0]!.prevLen;
	const consistentDelta = slice.every(
		(e) => e.nextLen - e.prevLen === firstDelta,
	);

	return {
		quarantined: true,
		triggerSlice: slice,
		consistentDelta,
		firstPrevLen: slice[0]!.prevLen,
		lastNextLen: last.nextLen,
	};
}

// -----------------------------------------------------------------------
// Map eviction helper — pure function for LRU-style eviction
// -----------------------------------------------------------------------

/**
 * Find the oldest entry in an amplification history map for eviction.
 *
 * Returns the path of the oldest entry, or null if the map is empty.
 * The "oldest" is determined by the `at` timestamp of the last entry
 * in each path's history.
 */
export function findOldestAmplificationEntry(
	entries: ReadonlyMap<string, readonly AmplificationEntry[]>,
	excludePath?: string,
): string | null {
	let oldestPath: string | null = null;
	let oldestAt = Infinity;

	for (const [path, history] of entries) {
		if (path === excludePath) continue;
		const last = history[history.length - 1];
		if (last && last.at < oldestAt) {
			oldestAt = last.at;
			oldestPath = path;
		}
	}

	return oldestPath;
}
