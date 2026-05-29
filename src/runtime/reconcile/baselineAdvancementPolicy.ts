/**
 * Baseline Advancement Policy — decides when to advance, defer, or clear
 * the disk-index contentHash baseline.
 *
 * This is a pure function with no I/O, no async, no side effects.
 * The controller computes hashes, calls this policy, then executes the result.
 *
 * Design:
 *   - "advance" means write a specific hash as the new settled baseline
 *   - "defer" means do not change the hash (stat-only update acceptable)
 *   - "clear" means explicitly delete the hash (reserved for future use)
 */

/**
 * Action kinds that lead to baseline decisions.
 * These map to specific reconciliation or live-sync outcomes.
 */
export type BaselineActionKind =
	// Reconcile phase actions
	| "crdt-created-on-disk"       // CRDT file written to new disk location
	| "disk-seeded-to-crdt"        // Disk file seeded into CRDT for first time
	| "import-disk-to-crdt"        // Disk wins clean (crdt was at baseline)
	| "conflict-disk-wins"         // Conflict artifact created, disk winner
	| "conflict-crdt-wins"         // Conflict artifact created, crdt winner
	| "apply-remote-to-disk"       // CRDT changed, disk unchanged, flushed
	| "no-op"                      // Disk == CRDT, settle the common content
	| "defer-to-crdt-flush"        // Open/bound/non-authoritative, flushed
	// Live-sync actions (future use)
	| "live-disk-to-crdt"          // External edit imported
	| "live-stat-only"             // Policy-never/quarantine/frontmatter block
	// Error/safety actions
	| "conflict-artifact-failed"   // Artifact creation threw
	| "safety-brake";              // Safety brake blocked writes

/**
 * Input to the baseline advancement decision.
 * All hashes must be pre-computed by the caller (async boundary stays outside).
 */
export interface BaselineAdvancementInput {
	/** The action that was taken (or will be taken) for this path. */
	readonly actionKind: BaselineActionKind;
	/** SHA-256 of disk content at decision time. Null if disk not read. */
	readonly diskHash: string | null;
	/** SHA-256 of CRDT content at decision time. Null if CRDT not available. */
	readonly crdtHash: string | null;
	/** Previously persisted baseline. Null if first run or cleared. */
	readonly previousBaselineHash: string | null;
}

/**
 * What the controller should do to the disk-index contentHash.
 */
export type BaselineAdvanceAction =
	| { readonly kind: "advance"; readonly hash: string; readonly reason: string }
	| { readonly kind: "defer"; readonly reason: string }
	| { readonly kind: "clear"; readonly reason: string };

/**
 * Decide whether to advance, defer, or clear the baseline hash.
 *
 * Pure function: no I/O, no async, no side effects.
 *
 * Invariant: never returns "advance" with a missing hash. If the required
 * hash is null, throws an error (caller bug — should have computed hash).
 */
export function planBaselineAdvancement(
	input: BaselineAdvancementInput,
): BaselineAdvanceAction {
	const { actionKind, diskHash, crdtHash } = input;

	switch (actionKind) {
		// --- Reconcile: CRDT is authority ---
		case "crdt-created-on-disk":
			if (crdtHash === null) {
				throw new Error("planBaselineAdvancement: crdt-created-on-disk requires crdtHash");
			}
			return { kind: "advance", hash: crdtHash, reason: "crdt-authority-disk-created" };

		case "apply-remote-to-disk":
			if (crdtHash === null) {
				throw new Error("planBaselineAdvancement: apply-remote-to-disk requires crdtHash");
			}
			return { kind: "advance", hash: crdtHash, reason: "remote-applied-to-disk" };

		case "conflict-crdt-wins":
			if (crdtHash === null) {
				throw new Error("planBaselineAdvancement: conflict-crdt-wins requires crdtHash");
			}
			return { kind: "advance", hash: crdtHash, reason: "conflict-resolved-crdt-wins" };

		case "no-op":
			// Disk and CRDT are identical. Use crdtHash (same as diskHash).
			if (crdtHash === null) {
				throw new Error("planBaselineAdvancement: no-op requires crdtHash");
			}
			return { kind: "advance", hash: crdtHash, reason: "content-identical" };

		case "defer-to-crdt-flush":
			// File was open/bound or non-authoritative mode. CRDT was flushed.
			if (crdtHash === null) {
				throw new Error("planBaselineAdvancement: defer-to-crdt-flush requires crdtHash");
			}
			return { kind: "advance", hash: crdtHash, reason: "flush-completed" };

		// --- Reconcile: Disk is authority ---
		case "disk-seeded-to-crdt":
			if (diskHash === null) {
				throw new Error("planBaselineAdvancement: disk-seeded-to-crdt requires diskHash");
			}
			return { kind: "advance", hash: diskHash, reason: "disk-authority-first-seed" };

		case "import-disk-to-crdt":
			if (diskHash === null) {
				throw new Error("planBaselineAdvancement: import-disk-to-crdt requires diskHash");
			}
			return { kind: "advance", hash: diskHash, reason: "disk-wins-clean" };

		case "conflict-disk-wins":
			if (diskHash === null) {
				throw new Error("planBaselineAdvancement: conflict-disk-wins requires diskHash");
			}
			return { kind: "advance", hash: diskHash, reason: "conflict-resolved-disk-wins" };

		// --- Live-sync ---
		case "live-disk-to-crdt":
			if (diskHash === null) {
				throw new Error("planBaselineAdvancement: live-disk-to-crdt requires diskHash");
			}
			return { kind: "advance", hash: diskHash, reason: "external-edit-imported" };

		case "live-stat-only":
			return { kind: "defer", reason: "stat-only-no-content" };

		// --- Error/safety ---
		case "conflict-artifact-failed":
			return { kind: "defer", reason: "artifact-creation-failed" };

		case "safety-brake":
			return { kind: "defer", reason: "safety-brake-blocked" };

		default: {
			// Exhaustiveness check
			const _exhaustive: never = actionKind;
			throw new Error(`planBaselineAdvancement: unknown actionKind: ${String(_exhaustive)}`);
		}
	}
}
