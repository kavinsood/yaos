/**
 * S15 — Schema v3 metadata sync validation.
 *
 * Constants and spec for the schema v3 end-to-end QA scenario.
 * Scenario implementation lives in two-device.ts under "s15-schema-v3-metadata-sync".
 *
 * What this scenario proves:
 *   1. File create on A → file appears on B's disk
 *   2. File rename on A → file renamed on B's disk
 *   3. File delete on A → file deleted from B's disk
 *   4. File revive (un-delete) on A → file re-written to B's disk
 *   5. mtime-only save on A (no content change) → B's disk file unchanged
 *   6. Schema v3 marker: room has sys.schemaVersion === 3 after both connect
 *
 * Known analyzer false positive on Device B:
 *   [orphan-after-rename] fires on B because handleRemoteRename performs a disk
 *   rename on B directly (via the OS), which triggers disk.rename.observed.
 *   B never fires crdt.file.renamed because B is the passive receiver — the
 *   CRDT rename was initiated by A. This is expected behavior, not a bug.
 *   The orphan-after-rename rule is designed for the active renaming device.
 */

export const SCENARIO_ID = "s15-schema-v3-metadata-sync";

/** File paths used during the scenario — in QA-scratch to avoid polluting the vault. */
export const PATHS = {
	create: "QA-scratch/s15-create-test.md",
	rename_src: "QA-scratch/s15-rename-src.md",
	rename_dst: "QA-scratch/s15-rename-dst.md",
	delete: "QA-scratch/s15-delete-test.md",
	revive: "QA-scratch/s15-revive-test.md",
	mtime: "QA-scratch/s15-mtime-test.md",
} as const;

/** Initial content written to each test file. */
export const INITIAL_CONTENT: Record<string, string> = {
	[PATHS.create]: "# S15 Create\n\nCreated on device A.\n",
	[PATHS.rename_src]: "# S15 Rename\n\nWill be renamed.\n",
	[PATHS.delete]: "# S15 Delete\n\nWill be deleted.\n",
	[PATHS.revive]: "# S15 Revive\n\nWill be deleted then revived.\n",
	[PATHS.mtime]: "# S15 Mtime\n\nContent stays the same. mtime changes only.\n",
};

/** Timeout constants (ms). */
export const TIMEOUTS = {
	waitForIdle: 15_000,
	waitForFile: 30_000,
	waitForFileDeletion: 20_000,
	syncSettleExtra: 5_000,
	mtimeSettleExtra: 8_000,
} as const;

/**
 * Semantic change kinds this scenario is expected to trigger on Device B's DiskMirror:
 *   - "deleted" for the delete and revive phases (before revive)
 *   - "revived" for the revive phase (after delete)
 *   - "path-changed" for the rename phase
 * Not tested at the semantic event level here — those are proven in unit tests.
 * This scenario proves the disk outcomes.
 */
export const EXPECTED_DISK_OUTCOMES = {
	create: "file present on B's disk with matching content hash",
	rename: "old path absent on B, new path present with matching content hash",
	delete: "file absent from B's disk after A deletes",
	revive: "file present on B's disk again after A revives",
	mtime: "B's disk hash unchanged after A bumps mtime without changing content",
	schemaVersion: "sys.schemaVersion === 3 on both devices after scenario",
} as const;
