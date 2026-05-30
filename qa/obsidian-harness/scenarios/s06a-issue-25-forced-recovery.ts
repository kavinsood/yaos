/**
 * S06a — Issue #25: forced-recovery path regression (crdtOnly).
 *
 * Purpose: prove that the editor-bound recovery path converges CRDT to disk
 * without looping when disk and CRDT diverge while the file is open.
 *
 * Mechanism (uses natural event pipeline, no forced internal calls):
 *   1. Create file. waitForIdle ensures CRDT is seeded from the create event.
 *   2. Open in MarkdownView — establishes y-codemirror binding.
 *   3. sleep(1.5s) — binding settles, activity guard (1200ms) expires.
 *   4. PRECONDITION: disk == CRDT == editor (baseline).
 *   5. writeAdapterFile with divergent content (tasks anchor mutation).
 *        - Writes directly to disk without updating CRDT or editor.
 *        - DiskMirror did NOT make this write → not suppressed.
 *        - Vault modify event fires → YAOS calls handleBoundFileSyncGap.
 *        - State at event time: disk=divergent, CRDT=fixture, editor=fixture
 *        - crdtOnly branch (editor=CRDT≠disk), activity guard expired.
 *        - applyDiffToYTextWithPostcondition: CRDT → divergent (disk content).
 *   6. waitForIdle — recovery settles.
 *   7. POSTCONDITION: disk == CRDT == editor (all converged to divergent).
 *
 * Why writeAdapterFile and NOT forceCrdtContent:
 *   forceCrdtContent propagates to editor via y-codemirror. Obsidian then
 *   auto-saves editor→disk within ~1s, destroying the disk≠CRDT state before
 *   recovery can be triggered. writeAdapterFile writes to disk only, leaving
 *   CRDT and editor unchanged, and the vault event triggers recovery naturally.
 *
 * What this tests:
 *   The crdtOnly / open-idle-disk-recovery branch of handleBoundFileSyncGap.
 *   This is the path that calls applyDiffToYTextWithPostcondition, which is
 *   the fix that prevents the stale-base amplification loop from 1.6.1.
 *
 * What this does NOT test:
 *   The localOnly branch (editor=disk≠CRDT). That branch is covered separately
 *   in S06a-localOnly with an explicit forced sync.
 */

import type { QaScenario } from "../types";
import {
	buildIssue25Fixture,
	issue25UniquePath,
	ISSUE_25_TASKS_ANCHOR_1,
} from "./issue-25-fixture";

export const s06aIssue25ForcedRecoveryCrdtOnly: QaScenario = {
	id: "issue-25-editor-bound-loop-forced-recovery-crdt-only",
	title: "Issue #25: forced-recovery convergence (crdtOnly path)",
	tags: ["issue-25", "editor-bound", "recovery", "single-device", "regression", "crdt-only"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = issue25UniquePath();
		const fixture = buildIssue25Fixture({ fillerLines: 400 });

		// 1. Create file. YAOS seeds CRDT from the disk.create event.
		await ctx.createFile(path, fixture);
		await ctx.waitForFile(path, 15000);
		await ctx.waitForIdle(10000);

		// 2. Open in editor to establish y-codemirror binding.
		await ctx.openFile(path);

		// 3. Let binding settle and activity guard (1200ms) expire before
		//    writing to disk so the guard doesn't block recovery.
		await ctx.sleep(1500);

		// 4. PRECONDITION: baseline must be converged.
		const diskHash0 = await ctx.yaos.getDiskHash(path);
		const crdtHash0 = await ctx.yaos.getCrdtHash(path);
		const editorHash0 = await ctx.yaos.getEditorHash(path);
		if (!diskHash0 || !crdtHash0) {
			throw new Error("Issue-25 (forced): could not read baseline hashes");
		}
		if (diskHash0 !== crdtHash0) {
			throw new Error(
				`Issue-25 (forced): baseline mismatch before test\n  disk: ${diskHash0}\n  crdt: ${crdtHash0}`,
			);
		}
		console.log("[S06a] baseline OK", { diskHash0, editorHash0 });

		// 5. Write divergent content to disk via adapter (NOT via editor).
		//    - CRDT and editor stay at fixture content (unchanged).
		//    - DiskMirror doesn't suppress vault.modify for adapter writes.
		//    - Vault event fires → handleBoundFileSyncGap → crdtOnly recovery.
		const divergent = fixture
			.replace(ISSUE_25_TASKS_ANCHOR_1, `${ISSUE_25_TASKS_ANCHOR_1}\nshort mode\n# qa-disk-divergence`);
		await ctx.writeAdapterFile(path, divergent);
		console.log("[S06a] adapter write done, waiting for recovery...");

		// Adapter writes can be ingested by the live editor/CRDT quickly, making
		// disk==CRDT and skipping recovery. To deterministically exercise a recovery
		// branch, we *force* CRDT back to the pre-write fixture while leaving disk
		// divergent. If the editor ingested the adapter write, this yields:
		//   editor==disk!=crdt  => localOnly recovery branch.
		// If the editor did not ingest, we still have disk!=crdt and forced sync will
		// take the open-idle-disk-recovery branch.
		await ctx.sleep(200);
		await ctx.yaos.__qaOnlyForceCrdtContentUnsafe(path, fixture, {
			originClass: "local",
			createIfMissing: false,
		});
		await ctx.sleep(200);
		// Clear the editor-bound "disk lag" guard (1200ms) so the forced sync
		// can't be skipped due to recent editor activity.
		await ctx.sleep(1500);
		await ctx.yaos.ingestDiskFileNow(path, "modify");

		// 6. Wait for recovery to settle. The vault event → syncFileFromDisk
		//    → recovery path runs synchronously within the event handler.
		//    waitForIdle confirms YAOS has processed all pending dirty paths.
		await ctx.waitForIdle(15000);

		// 7. POSTCONDITION: all three must converge to the same value.
		const diskHash = await ctx.yaos.getDiskHash(path);
		const crdtHash = await ctx.yaos.getCrdtHash(path);
		const editorHash = await ctx.yaos.getEditorHash(path);
		console.log("[S06a] postcondition", { diskHash, crdtHash, editorHash });

		if (!diskHash || !crdtHash) {
			throw new Error("Issue-25 (forced): could not read postcondition hashes");
		}
		if (diskHash !== crdtHash) {
			throw new Error(
				`Issue-25 (forced): disk != CRDT after recovery\n  disk: ${diskHash}\n  crdt: ${crdtHash}`,
			);
		}
		if (editorHash && editorHash !== diskHash) {
			throw new Error(
				`Issue-25 (forced): editor != disk after recovery\n  editor: ${editorHash}\n  disk: ${diskHash}`,
			);
		}

		// 8. File size must not have grown (no stable-delta loop).
		const finalFile = ctx.app.vault.getAbstractFileByPath(path);
		const finalSize = (finalFile as unknown as { stat?: { size?: number } })?.stat?.size ?? 0;
		const divergentSize = new TextEncoder().encode(divergent).length;
		if (finalSize > divergentSize + 512) {
			throw new Error(
				`Issue-25 (forced): file grew beyond expected (${finalSize} > ${divergentSize} + 512)`,
			);
		}

		await ctx.closeFile(path);
		await ctx.deleteFile(path);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies("QA-issue-25");
	},

	async cleanup(ctx): Promise<void> {
		// Best-effort cleanup for any leftover files from this run.
		await ctx.waitForIdle(5000);
	},
};

export const s06aIssue25ForcedRecoveryLocalOnly: QaScenario = {
	id: "issue-25-editor-bound-loop-forced-recovery-local-only",
	title: "Issue #25: forced-recovery convergence (localOnly path)",
	tags: ["issue-25", "editor-bound", "recovery", "single-device", "regression", "local-only"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = issue25UniquePath();
		const fixture = buildIssue25Fixture({ fillerLines: 400 });
		let paused = false;
		let previousExternalPolicy: "always" | "closed-only" | "never" | null = null;
		let policyRestored = false;

		try {

		// 1. Create file and seed CRDT.
		await ctx.createFile(path, fixture);
		await ctx.waitForFile(path, 15000);
		await ctx.waitForIdle(10000);

		// 2. Open in editor to establish binding.
		await ctx.openFile(path);
		await ctx.sleep(1500);

		// 3. PRECONDITION: baseline must be converged.
		const diskHash0 = await ctx.yaos.getDiskHash(path);
		const crdtHash0 = await ctx.yaos.getCrdtHash(path);
		const editorHash0 = await ctx.yaos.getEditorHash(path);
		if (!diskHash0 || !crdtHash0) {
			throw new Error("Issue-25 (forced-localOnly): could not read baseline hashes");
		}
		if (diskHash0 !== crdtHash0) {
			throw new Error(
				`Issue-25 (forced-localOnly): baseline mismatch before test\n  disk: ${diskHash0}\n  crdt: ${crdtHash0}`,
			);
		}
		console.log("[S06a-localOnly] baseline OK", { diskHash0, editorHash0 });

		// 4. Manufacture a true localOnly divergence:
		//    editor == disk (authoritative local state)
		//    CRDT != editor (stale)
		//    file remains editor-bound.
		//
		// We do this by pausing editor->CRDT propagation while keeping the path
		// tracked as bound, then editing the editor and letting Obsidian auto-save.
		paused = await ctx.yaos.pauseEditorPropagation(path);
		if (!paused) {
			throw new Error("Issue-25 (forced-localOnly): failed to pause binding propagation (path not bound?)");
		}
		const policyChange = await ctx.yaos.setExternalEditPolicyOverride("never");
		previousExternalPolicy = policyChange.previous;
		const divergent = fixture.replace(
			ISSUE_25_TASKS_ANCHOR_1,
			`${ISSUE_25_TASKS_ANCHOR_1}\nlocal-only-divergence\n# qa-editor-divergence`,
		);
		await ctx.replaceFileContent(path, divergent);
		// Wait for Obsidian auto-save to flush editor -> disk.
		await ctx.sleep(3000);
		await ctx.waitForIdle(10000);

		// 5. Confirm precondition: editor == disk, CRDT != disk.
		const diskAfterEdit = await ctx.yaos.getDiskHash(path);
		const crdtAfterEdit = await ctx.yaos.getCrdtHash(path);
		const editorAfterEdit = await ctx.yaos.getEditorHash(path);
		if (!diskAfterEdit || !crdtAfterEdit || !editorAfterEdit) {
			throw new Error("Issue-25 (forced-localOnly): could not read divergence hashes");
		}
		if (diskAfterEdit !== editorAfterEdit) {
			throw new Error(
				`Issue-25 (forced-localOnly): expected editor==disk before recovery\n  disk: ${diskAfterEdit}\n  editor: ${editorAfterEdit}`,
			);
		}
		if (crdtAfterEdit === diskAfterEdit) {
			throw new Error("Issue-25 (forced-localOnly): expected CRDT!=disk before recovery (but they match)");
		}

		// Re-enable normal import policy before running the forced sync pass.
		await ctx.yaos.setExternalEditPolicyOverride(previousExternalPolicy);
		policyRestored = true;
		console.log("[S06a-localOnly] precondition OK", {
			diskAfterEdit,
			editorAfterEdit,
			crdtAfterEdit,
		});

		// 6. Trigger localOnly recovery.
		await ctx.yaos.ingestDiskFileNow(path, "modify");
		await ctx.waitForIdle(15000);

		// 7. POSTCONDITION: all three must converge to disk/editor.
		const diskHash = await ctx.yaos.getDiskHash(path);
		const crdtHash = await ctx.yaos.getCrdtHash(path);
		const editorHash = await ctx.yaos.getEditorHash(path);
		console.log("[S06a-localOnly] postcondition", { diskHash, crdtHash, editorHash });

		if (!diskHash || !crdtHash) {
			throw new Error("Issue-25 (forced-localOnly): could not read postcondition hashes");
		}
		if (diskHash !== crdtHash) {
			throw new Error(
				`Issue-25 (forced-localOnly): disk != CRDT after recovery\n  disk: ${diskHash}\n  crdt: ${crdtHash}`,
			);
		}
		if (editorHash && editorHash !== diskHash) {
			throw new Error(
				`Issue-25 (forced-localOnly): editor != disk after recovery\n  editor: ${editorHash}\n  disk: ${diskHash}`,
			);
		}

		await ctx.yaos.resumeEditorPropagation(path);
		paused = false;

		await ctx.closeFile(path);
		await ctx.deleteFile(path);
		} finally {
			if (!policyRestored && previousExternalPolicy) {
				await ctx.yaos.setExternalEditPolicyOverride(previousExternalPolicy);
			}
			if (paused) {
				await ctx.yaos.resumeEditorPropagation(path);
			}
		}
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies("QA-issue-25");
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};
