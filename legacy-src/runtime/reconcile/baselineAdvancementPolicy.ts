/**
 * Pure policy for selecting the disk-index contentHash after a completed
 * reconciliation action.
 */

/** Reconciliation outcomes that establish a settled content baseline. */
export type BaselineActionKind =
	| "crdt-created-on-disk"
	| "disk-seeded-to-crdt"
	| "import-disk-to-crdt"
	| "conflict-disk-wins"
	| "conflict-crdt-wins"
	| "apply-remote-to-disk"
	| "no-op"
	| "defer-to-crdt-flush";

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
}

/** The hash the controller should persist as the settled baseline. */
export type BaselineAdvanceAction = {
	readonly kind: "advance";
	readonly hash: string;
	readonly reason: string;
};

/**
 * Select the settled baseline hash for a completed reconciliation action.
 *
 * Throws if the caller omitted the hash required by that action.
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

		default: {
			// Exhaustiveness check
			const _exhaustive: never = actionKind;
			throw new Error(`planBaselineAdvancement: unknown actionKind: ${String(_exhaustive)}`);
		}
	}
}
