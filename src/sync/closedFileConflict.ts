export type ClosedFileConflictDecision =
	| { kind: "no-op" }
	| { kind: "apply-remote-to-disk"; reason: "disk-at-baseline" }
	| { kind: "import-disk-to-crdt"; reason: "crdt-at-baseline" }
	| {
		kind: "preserve-conflict";
		reason: "both-changed" | "missing-baseline";
		winner: "disk" | "crdt";
		preserveCrdt?: true;
		preserveDisk?: true;
	};

export interface ClosedFileConflictInput {
	baselineHash: string | null;
	diskHash: string;
	crdtHash: string;
	/**
	 * mtime (Unix ms) of the disk file at reconciliation time.
	 * Used together with lastDiskIndexPersistedAt to detect "edited while
	 * YAOS was inactive" in the missing-baseline path.
	 * Optional — when absent, mtime evidence is not used.
	 */
	diskMtime?: number;
	/**
	 * Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Persisted in data.json as _lastDiskIndexPersistedAt.
	 * Semantics: "last time YAOS durably persisted disk-index baselines."
	 * This is a GLOBAL heuristic — not per-file. It can produce false negatives
	 * when an unrelated file triggers a save after the target file was modified
	 * (see engineering/bug-rca-ledger.md Issue #22-B for the known limits).
	 * Optional — when absent, mtime evidence is not used.
	 */
	lastDiskIndexPersistedAt?: number;
}

/**
 * Why the disk was chosen as the missing-baseline winner.
 * Present in reconcile.file.decision.data when reason === "missing-baseline"
 * and diskMtime evidence was available.
 */
export type MissingBaselineWinnerPolicy =
	| "disk-mtime-after-last-index-save"  // diskMtime > lastDiskIndexPersistedAt
	| "crdt-default-no-evidence"          // no mtime evidence, safe distributed default
	| "crdt-default-disk-not-newer";      // evidence present but disk not newer than last save

export function decideClosedFileConflict(
	input: ClosedFileConflictInput,
): ClosedFileConflictDecision & { _missingBaselinePolicy?: MissingBaselineWinnerPolicy } {
	const { baselineHash, diskHash, crdtHash, diskMtime, lastDiskIndexPersistedAt } = input;
	if (diskHash === crdtHash) return { kind: "no-op" };

	if (baselineHash === null) {
		// No persisted baseline — unknown who changed what.
		//
		// Use mtime evidence to break the tie. Heuristic:
		//   If the disk file's mtime is strictly AFTER the last time YAOS
		//   durably persisted its disk-index state, the file was likely edited
		//   while YAOS was inactive/killed/suspended. Disk wins the main file;
		//   CRDT remote content is preserved as a conflict artifact.
		//
		//   This addresses Issue #22-B ("I turned YAOS off, edited my note,
		//   turned it back on, and lost my edits" — the cold-relaunch / process-
		//   killed variant where no baseline was persisted before death).
		//
		// Known limits of this heuristic (documented, not hidden):
		//   - Global timestamp: an unrelated file triggering a save AFTER the
		//     target file's mtime can make disk look "not newer," causing CRDT
		//     to win even though the user made a local edit.
		//   - mtime coarseness: filesystems with 1-second precision, external
		//     editors that preserve mtime, or iCloud/Android document providers
		//     may produce unexpected mtime values.
		//   - When either input is absent, falls back to CRDT wins (safe default).
		//
		// See: engineering/bug-rca-ledger.md Issue #22-B
		const hasMtimeEvidence =
			diskMtime !== undefined &&
			lastDiskIndexPersistedAt !== undefined;
		const diskNewerThanLastSave =
			hasMtimeEvidence && diskMtime! > lastDiskIndexPersistedAt!;

		if (diskNewerThanLastSave) {
			return {
				kind: "preserve-conflict",
				reason: "missing-baseline",
				winner: "disk",
				preserveCrdt: true,
				_missingBaselinePolicy: "disk-mtime-after-last-index-save",
			};
		}
		return {
			kind: "preserve-conflict",
			reason: "missing-baseline",
			winner: "crdt",
			preserveDisk: true,
			_missingBaselinePolicy: hasMtimeEvidence
				? "crdt-default-disk-not-newer"
				: "crdt-default-no-evidence",
		};
	}

	if (diskHash === baselineHash && crdtHash !== baselineHash) {
		return { kind: "apply-remote-to-disk", reason: "disk-at-baseline" };
	}
	if (crdtHash === baselineHash && diskHash !== baselineHash) {
		return { kind: "import-disk-to-crdt", reason: "crdt-at-baseline" };
	}
	return {
		kind: "preserve-conflict",
		reason: "both-changed",
		winner: "disk",
		preserveCrdt: true,
	};
}
