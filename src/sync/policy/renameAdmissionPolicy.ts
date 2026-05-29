/**
 * Rename admission policy — decides what to do when a file rename is
 * observed, based on whether the source and destination are syncable.
 *
 * This replaces the inline post-mutation tombstone logic. The decision
 * is made BEFORE any CRDT mutation, so applyRenameBatch never receives
 * an excluded destination.
 */

import type { PathAdmission } from "./pathAdmissionPolicy";
import type { PathSyncCategory } from "../../paths/pathCategory";

/**
 * @deprecated Remove after autophagy campaign 2. No production caller remains.
 * Only kept for test coverage of the legacy decision matrix.
 * Removal target: next deletion pass after TraceSink second cluster.
 */
export type RenameAdmissionDecision =
	| { kind: "rename"; oldPath: string; newPath: string }
	| { kind: "tombstone-old"; oldPath: string; newPath: string; reason: string }
	| { kind: "admit-new"; oldPath: string; newPath: string; reason: string }
	| { kind: "ignore"; oldPath: string; newPath: string; reason: string };

/**
 * Decide what to do with a rename given the admission status of both paths.
 *
 * @deprecated Remove after autophagy campaign 2. No production caller remains.
 * Use planCategoryRenameAction for new code.
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
// Category-aware rename planning.
//
// Actions are split by subject (markdown vs blob) so the executor knows
// which subsystem to call. Actions that this layer cannot handle are
// explicitly marked as deferred to existing event handling.
//
// IMPORTANT: All execution paths use displayPath (the original runtime
// path from Obsidian), NOT normalizedPath. Canonical keys are for
// identity comparison only. Execution APIs have not been migrated.
// -----------------------------------------------------------------------

export type RenameAction =
	| { kind: "queue-markdown-rename"; oldPath: string; newPath: string }
	| { kind: "queue-blob-rename"; oldPath: string; newPath: string }
	| { kind: "tombstone-markdown"; oldPath: string; dropDirty: string[] }
	| { kind: "admit-markdown"; newPath: string; dropDirty: string[] }
	| { kind: "admit-blob-via-event"; newPath: string; dropDirty: string[] }
	| { kind: "defer-blob-to-events"; oldPath: string; newPath: string; dropDirty: string[] }
	| { kind: "same-identity"; oldPath: string; newPath: string }
	| { kind: "ignore" };

/**
 * Plan rename action from PathSyncCategory objects (preferred API).
 *
 * Uses displayPath for all execution paths. Canonical keys are used
 * only for same-identity detection.
 *
 * Full category matrix:
 *   same canonical key           = same-identity (no-op)
 *   markdown → markdown          = queue markdown rename
 *   markdown → blob              = tombstone markdown (blob via Obsidian create event)
 *   markdown → excluded          = tombstone markdown
 *   blob     → blob              = queue blob rename
 *   blob     → markdown          = admit markdown (blob via Obsidian delete event)
 *   blob     → excluded          = defer to blob events (Obsidian delete event)
 *   excluded → markdown          = admit markdown
 *   excluded → blob              = admit blob (via Obsidian create event)
 *   excluded → excluded          = ignore
 */
export function planCategoryRenameAction(input: {
	oldCategory: PathSyncCategory;
	newCategory: PathSyncCategory;
}): RenameAction {
	const { oldCategory, newCategory } = input;

	// Use displayPath for execution — existing APIs have not been migrated
	// to canonical keys.
	const oldPath = oldCategory.path.displayPath;
	const newPath = newCategory.path.displayPath;

	// Same canonical identity = no-op. Rename between NFC/NFD forms or
	// separator variants does not create a new sync identity.
	if (oldCategory.path.canonicalKey === newCategory.path.canonicalKey) {
		return { kind: "same-identity", oldPath, newPath };
	}

	// excluded → excluded
	if (oldCategory.kind === "excluded" && newCategory.kind === "excluded") {
		return { kind: "ignore" };
	}

	// excluded → markdown
	if (oldCategory.kind === "excluded" && newCategory.kind === "markdown") {
		return { kind: "admit-markdown", newPath, dropDirty: [oldPath] };
	}

	// excluded → blob
	if (oldCategory.kind === "excluded" && newCategory.kind === "blob") {
		return { kind: "admit-blob-via-event", newPath, dropDirty: [oldPath] };
	}

	// markdown → excluded
	if (oldCategory.kind === "markdown" && newCategory.kind === "excluded") {
		return { kind: "tombstone-markdown", oldPath, dropDirty: [oldPath, newPath] };
	}

	// markdown → markdown
	if (oldCategory.kind === "markdown" && newCategory.kind === "markdown") {
		return { kind: "queue-markdown-rename", oldPath, newPath };
	}

	// markdown → blob (markdown identity removed, blob appears via create event)
	if (oldCategory.kind === "markdown" && newCategory.kind === "blob") {
		return { kind: "tombstone-markdown", oldPath, dropDirty: [oldPath, newPath] };
	}

	// blob → excluded (blob leaves sync scope, handled by Obsidian delete event)
	if (oldCategory.kind === "blob" && newCategory.kind === "excluded") {
		return { kind: "defer-blob-to-events", oldPath, newPath, dropDirty: [oldPath, newPath] };
	}

	// blob → blob
	if (oldCategory.kind === "blob" && newCategory.kind === "blob") {
		return { kind: "queue-blob-rename", oldPath, newPath };
	}

	// blob → markdown (admit markdown, blob removed via Obsidian delete event)
	if (oldCategory.kind === "blob" && newCategory.kind === "markdown") {
		return { kind: "admit-markdown", newPath, dropDirty: [oldPath] };
	}

	// Unreachable — all 9 cases handled above.
	return { kind: "ignore" };
}
