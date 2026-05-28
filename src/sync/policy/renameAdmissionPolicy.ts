/**
 * Rename admission policy — decides what to do when a file rename is
 * observed, based on whether the source and destination are syncable.
 *
 * This replaces the inline post-mutation tombstone logic. The decision
 * is made BEFORE any CRDT mutation, so applyRenameBatch never receives
 * an excluded destination.
 */

import type { PathAdmission } from "./pathAdmissionPolicy";

export type RenameAdmissionDecision =
	| { kind: "rename"; oldPath: string; newPath: string }
	| { kind: "tombstone-old"; oldPath: string; newPath: string; reason: string }
	| { kind: "admit-new"; oldPath: string; newPath: string; reason: string }
	| { kind: "ignore"; oldPath: string; newPath: string; reason: string };

/**
 * Decide what to do with a rename given the admission status of both paths.
 *
 * Decision matrix:
 *   syncable → syncable   = rename (normal CRDT rename)
 *   syncable → excluded   = tombstone-old (file left sync scope)
 *   excluded → syncable   = admit-new (file entered sync scope)
 *   excluded → excluded   = ignore (irrelevant to sync)
 */
export function decideRenameAdmission(input: {
	oldPath: string;
	newPath: string;
	oldAdmission: PathAdmission;
	newAdmission: PathAdmission;
}): RenameAdmissionDecision {
	const oldSyncable = input.oldAdmission.kind === "syncable";
	const newSyncable = input.newAdmission.kind === "syncable";

	if (oldSyncable && newSyncable) {
		return { kind: "rename", oldPath: input.oldPath, newPath: input.newPath };
	}

	if (oldSyncable && !newSyncable) {
		return {
			kind: "tombstone-old",
			oldPath: input.oldPath,
			newPath: input.newPath,
			reason: `destination-excluded: ${(input.newAdmission as { reason: string }).reason}`,
		};
	}

	if (!oldSyncable && newSyncable) {
		return {
			kind: "admit-new",
			oldPath: input.oldPath,
			newPath: input.newPath,
			reason: `source-excluded: ${(input.oldAdmission as { reason: string }).reason}`,
		};
	}

	return {
		kind: "ignore",
		oldPath: input.oldPath,
		newPath: input.newPath,
		reason: "excluded-to-excluded",
	};
}

// -----------------------------------------------------------------------
// Action planning — maps decisions into concrete side-effects.
// main.ts calls planRenameAction, then executes the returned action.
// This keeps the dispatch logic testable without duplicating a switch.
// -----------------------------------------------------------------------

export type RenameAction =
	| { kind: "queue-rename"; oldPath: string; newPath: string }
	| { kind: "tombstone-old"; oldPath: string; newPath: string; dropDirty: string[] }
	| { kind: "admit-new"; newPath: string; dropDirty: string[] }
	| { kind: "ignore" };

/**
 * Plan the side-effects for a rename admission decision.
 * Pure function — no I/O, no mutation. Caller executes the returned action.
 */
export function planRenameAction(decision: RenameAdmissionDecision): RenameAction {
	switch (decision.kind) {
		case "rename":
			return { kind: "queue-rename", oldPath: decision.oldPath, newPath: decision.newPath };

		case "tombstone-old":
			return {
				kind: "tombstone-old",
				oldPath: decision.oldPath,
				newPath: decision.newPath,
				dropDirty: [decision.oldPath, decision.newPath],
			};

		case "admit-new":
			return {
				kind: "admit-new",
				newPath: decision.newPath,
				dropDirty: [decision.oldPath],
			};

		case "ignore":
			return { kind: "ignore" };
	}
}
