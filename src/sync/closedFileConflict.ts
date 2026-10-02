/**
 * Closed-file reconcile policy (write-budget spike D4). The production path is
 * DiskMirror.settleBody (configured with getCommonBase + commitMergedBody in
 * main.ts); this hash-only decision is its fallback when that API is absent.
 *
 * - With a last-synced base (disk-index baseline content or the stored common
 *   base from BodySettlementRepository): three-way LINE merge
 *   (src/sync/lineMerge.ts, diff3 with base = last-synced text, ours = disk,
 *   theirs = server body).
 *   - Clean: the merged text is committed as a normal CRDT edit (minimal
 *     diff via commitBodyCandidateIfCurrent) and then written to disk.
 *   - Overlapping, differing changes: the server side is written as a
 *     conflict copy (existing artifact mechanism), disk stays at the path,
 *     the path is marked decision-required and ThreeWayConflictModal is
 *     offered once per unresolved overlap (its regions are whole lines).
 * - No base: identical content settles with no write (0 rows); different
 *   content preserves disk as a conflict copy and projects the server body
 *   to the path. No "superset wins" heuristic.
 * - The mtime tiebreak below only picks which side stays at the path in this
 *   legacy hash-only fallback; both sides are always kept, so it never
 *   decides what content is lost.
 */
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
	 * when an unrelated file triggers a save after the target file was modified.
	 * See docs/BACKLOG.md QA-03 for the known limits.
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
		// With no baseline, complete mtime evidence can show that disk changed
		// after YAOS last persisted its disk index. Disk then wins and CRDT is
		// preserved; otherwise CRDT is the conservative default. The global
		// timestamp/filesystem limits are tracked in docs/BACKLOG.md QA-03.
		const hasMtimeEvidence =
			diskMtime !== undefined &&
			lastDiskIndexPersistedAt !== undefined;
		const diskNewerThanLastSave =
			hasMtimeEvidence && diskMtime > lastDiskIndexPersistedAt;

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
