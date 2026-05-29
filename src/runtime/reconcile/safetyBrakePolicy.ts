/**
 * Safety brake policy — pure decision logic for the reconcile safety brake.
 *
 * The safety brake prevents catastrophic overwrites during reconciliation.
 * When CRDT-to-disk writes exceed a threshold (both absolute count AND
 * proportion of local files), the brake triggers to protect user data.
 *
 * Constraints:
 *   - Synchronous (no async)
 *   - No Obsidian imports
 *   - No disk I/O
 *   - No trace calls
 *   - No `this`
 *   - Pure: same inputs → same output
 */

// -----------------------------------------------------------------------
// Policy constants — can be tuned without touching decision logic
// -----------------------------------------------------------------------

/** Minimum absolute count of destructive writes to consider braking. */
export const SAFETY_BRAKE_MIN_COUNT = 20;

/** Minimum ratio of destructive writes to total local files to brake. */
export const SAFETY_BRAKE_MIN_RATIO = 0.25;

// -----------------------------------------------------------------------
// Input type — everything the policy needs to decide
// -----------------------------------------------------------------------

export interface SafetyBrakeInput {
	/** Number of CRDT-to-disk overwrites planned. */
	readonly destructiveCount: number;
	/** Total number of files currently on disk (vault size). */
	readonly localFileCount: number;
}

// -----------------------------------------------------------------------
// Output type — the policy decision
// -----------------------------------------------------------------------

export type SafetyBrakeDecision =
	| {
			readonly triggered: false;
			readonly destructiveRatio: number;
	  }
	| {
			readonly triggered: true;
			readonly destructiveRatio: number;
			readonly reason: string;
	  };

// -----------------------------------------------------------------------
// Policy function — pure, no side effects
// -----------------------------------------------------------------------

/**
 * Evaluate whether the safety brake should trigger.
 *
 * The brake triggers when BOTH conditions are met:
 *   1. destructiveCount > SAFETY_BRAKE_MIN_COUNT (20)
 *   2. destructiveRatio > SAFETY_BRAKE_MIN_RATIO (0.25)
 *
 * This dual threshold prevents:
 *   - False positives on small vaults (e.g., 5 of 10 files = 50% but only 5 files)
 *   - False negatives on large vaults (e.g., 100 of 10,000 = 1% but still 100 files)
 */
export function evaluateSafetyBrake(input: SafetyBrakeInput): SafetyBrakeDecision {
	const { destructiveCount, localFileCount } = input;

	const destructiveRatio =
		localFileCount > 0 ? destructiveCount / localFileCount : 0;

	if (
		destructiveCount > SAFETY_BRAKE_MIN_COUNT &&
		destructiveRatio > SAFETY_BRAKE_MIN_RATIO
	) {
		return {
			triggered: true,
			destructiveRatio,
			reason:
				`refusing to overwrite ${destructiveCount} local files ` +
				`(${Math.round(destructiveRatio * 100)}% of disk files)`,
		};
	}

	return {
		triggered: false,
		destructiveRatio,
	};
}
