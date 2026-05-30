/**
 * S01 — Single device: create, edit (in editor), verify, delete.
 *
 * Purpose: Prove the basic local disk→CRDT→server→receipt lifecycle on one
 * device with real editor interaction.
 *
 * Assertions:
 *   - After create: disk == CRDT, receipt confirmed
 *   - After editor typing: disk == CRDT, typed text present, receipt confirmed
 *   - After delete: file absent
 *
 * Key events expected:
 *   disk.create.observed → crdt.file.created
 *   server.receipt.candidate_captured → server.receipt.confirmed
 *   crdt.file.updated (after editor type)
 *   disk.delete.observed → crdt.file.tombstoned
 */

import type { QaScenario, QaContext } from "../types";

// Unique per-run path. Prevents stale CRDT/server state pollution from prior
// runs on the same vault. Each invocation creates a distinct file, so assertion
// failures are real product bugs, not contamination from previous test state.
function scratchPath(): string {
	const ts = Date.now();
	const rand = Math.random().toString(36).slice(2, 7);
	return `QA-scratch/s01-basic-edit-${ts}-${rand}.md`;
}

const INITIAL = "# S01 Basic Edit\n\nInitial content.\n";
const TYPED = "\nEdited via harness.";
const EXPECTED_AFTER_EDIT = INITIAL + TYPED;

// Shared across phases for the current run. Safe because scenarios run
// sequentially and the value is set at the start of run() before any phase
// that needs it.
let _currentScratch = "QA-scratch/s01-basic-edit-unknown.md";

export const s01SingleDeviceBasicEdit: QaScenario = {
	id: "single-device-basic-edit",
	title: "Single device: create, editor-type, verify disk==CRDT, delete",
	tags: ["basic", "single-device", "layer1", "release-gate"],

	async setup(ctx: QaContext): Promise<void> {
		// No pre-cleanup: each run uses a unique path — no prior state to clean.
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// Generate and record the unique path for this invocation.
		_currentScratch = scratchPath();
		const SCRATCH = _currentScratch;

		// 1. Create via Obsidian API. Capture timestamp before create for receipt wait.
		const createTs = Date.now();
		await ctx.createFile(SCRATCH, INITIAL);
		await ctx.waitForIdle(8000);

		// 2. Wait for server receipt — this ensures the file event was processed by
		//    DiskMirror and the Y.Text was seeded and sent to the server.
		//    Receipt confirmation implies the CRDT is non-null for this path.
		await ctx.yaos.waitForReceiptAfter(createTs, 30_000);

		// 3. Wait for disk→CRDT convergence for this specific path.
		//
		//    After receipt confirmation, background Y.Doc sync (other files in the
		//    same vault sharing the Y.Doc) can transiently update the CRDT content
		//    for this path. waitForDiskCrdtConverge polls until both hashes match,
		//    ensuring the content has fully stabilized before asserting.
		//
		//    Ordering matters: waitForReceiptAfter must run first to ensure the CRDT
		//    is seeded (non-null). waitForDiskCrdtConverge polling against a null CRDT
		//    would time out immediately because null !== disk.
		await ctx.waitForDiskCrdtConverge(SCRATCH, 15_000);

		// 4. Verify create synced to CRDT
		await ctx.assert.fileExists(SCRATCH);
		await ctx.assert.diskEqualsCrdt(SCRATCH);

		// 5. Open in editor and type (exercises y-codemirror binding)
		await ctx.openFile(SCRATCH);
		const editTs = Date.now();
		await ctx.typeIntoFile(SCRATCH, TYPED);

		// 6. Wait for idle after edit
		await ctx.waitForIdle(10_000);

		// 7. Wait for server receipt after the editor edit.
		await ctx.yaos.waitForReceiptAfter(editTs, 30_000);

		// 8. Wait for disk→CRDT convergence after the editor edit.
		//    The editor applies content to the Y.Text; DiskMirror must then write
		//    it to disk. Poll until both match before asserting.
		await ctx.waitForDiskCrdtConverge(SCRATCH, 15_000);

		// 9. Assert the edit actually synced to CRDT — this is the binding test
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		await ctx.assert.fileContent(SCRATCH, EXPECTED_AFTER_EDIT);

		// 10. Close and delete
		await ctx.closeFile(SCRATCH);
		await ctx.deleteFile(SCRATCH);
		await ctx.waitForIdle(8000);
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileNotExists(_currentScratch);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		// run() deletes the file; cleanup is a best-effort safety net.
		await ctx.closeFile(_currentScratch).catch(() => {});
		await ctx.deleteFile(_currentScratch).catch(() => {});
	},
};
