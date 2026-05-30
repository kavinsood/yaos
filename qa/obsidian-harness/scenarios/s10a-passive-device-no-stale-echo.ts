/**
 * S10a — Issue #22: passive device does not push stale content back on remote update.
 *
 * Purpose: Simulate a passive device receiving remote edits (including deletions)
 * for a file that is open in the editor but idle. Prove that YAOS classifies
 * the resulting disk≠CRDT state as "disk lag" (not "open-idle recovery"), and
 * does NOT push stale disk content back into CRDT.
 *
 * This exercises the exact chain that caused #22 on the passive device:
 *   remote CRDT update → y-codemirror dispatches to editor → diskMirror schedules
 *   write → vault modify fires → handleBoundFileSyncGap must NOT fire recovery.
 *
 * We use __qaOnlyForceCrdtContentUnsafe(originClass: "remote") to inject content
 * as if it arrived from the Yjs provider. This triggers the same Y.Text observers,
 * origin gates, and disk write scheduling as a real multi-device remote update.
 *
 * Variant A (insertion): remote adds content.
 * Variant B (deletion — the #22 trigger): remote removes content.
 *
 * Pass criteria:
 *   - After remote injection: editor == CRDT == newContent (y-codemirror applied it)
 *   - After settle: disk catches up (diskMirror writes, or Obsidian autosaves)
 *   - disk == CRDT == editor == newContent throughout
 *   - No recovery.decision events in trace for this file
 *   - No content oscillation (stability soak)
 *   - Analyzer: no recovery-loop, no unsafe-overwrite, no self-write-suppression-miss
 *
 * Bug class: Issue #22 primary (passive device stale echo).
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s10a-passive-remote.md";
const INITIAL = "# Passive Remote Test\n\nLine one.\nLine two.\nLine three.\nLine four.\nLine five.\n";
// Simulated remote edit: a deletion (removes lines 3-4, the #22 trigger pattern)
const REMOTE_DELETION = "# Passive Remote Test\n\nLine one.\nLine two.\nLine five.\n";
// Simulated remote edit: an addition
const REMOTE_ADDITION = "# Passive Remote Test\n\nLine one.\nLine two.\nLine five.\nNew remote line.\n";

export const s10aPassiveDeviceNoStaleEcho: QaScenario = {
	id: "issue-22-passive-device-no-stale-echo",
	title: "Issue #22: passive device remote update does not trigger stale recovery",
	tags: ["issue-22", "passive", "remote", "recovery", "single-device", "regression", "P0"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create file and sync.
		await ctx.createFile(SCRATCH, INITIAL);
		await ctx.waitForIdle(10_000);
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// 2. Open in editor — establishes y-codemirror binding (simulates passive device).
		await ctx.openFile(SCRATCH);
		await ctx.waitForCrdtBinding(SCRATCH, 10_000);

		// 3. Let binding settle and activity guard EXPIRE.
		//    This puts the file in the "idle" state — the dangerous zone where
		//    "open-idle disk recovery" could fire if incorrectly triggered.
		await ctx.sleep(2000);

		// 4. PRECONDITION: all three authorities agree.
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		const editorHash = await ctx.yaos.getEditorHash(SCRATCH);
		const crdtHash = await ctx.yaos.getCrdtHash(SCRATCH);
		if (editorHash !== crdtHash) {
			throw new Error("s10a: precondition failed — editor != CRDT before remote injection");
		}

		// ─── Phase 1: Remote DELETION (the #22 trigger) ───────────────────

		// 5. Inject remote deletion — as if another device deleted lines 3-4.
		//    This modifies Y.Text with provider origin, triggering:
		//    - y-codemirror observer → dispatches deletion to editor
		//    - diskMirror text observer → schedules write (remote origin)
		//    - handleLiveEditorUpdate → updates lastEditorChangeAtMs
		const result1 = await ctx.yaos.__qaOnlyForceCrdtContentUnsafe(
			SCRATCH,
			REMOTE_DELETION,
			{ originClass: "remote" },
		);
		if (result1.afterHash === result1.beforeHash) {
			throw new Error("s10a: remote injection had no effect (hashes unchanged)");
		}

		// 6. Wait for the system to settle. The sequence should be:
		//    - y-codemirror dispatches deletion to editor (immediate)
		//    - diskMirror schedules open-file write (1500ms timer)
		//    - Or: Obsidian autosaves editor content to disk (~2s)
		//    - Vault modify fires → handleBoundFileSyncGap
		//    - Should classify as "disk lag" or "crdt-current" — NOT recovery.
		await ctx.sleep(4000);

		// 7. POST-DELETION CHECK: all authorities must agree on REMOTE_DELETION.
		const diskAfterDel = await ctx.yaos.getDiskHash(SCRATCH);
		const crdtAfterDel = await ctx.yaos.getCrdtHash(SCRATCH);
		const editorAfterDel = await ctx.yaos.getEditorHash(SCRATCH);
		if (crdtAfterDel !== result1.afterHash) {
			throw new Error(
				`s10a: CRDT hash changed after deletion settle! ` +
				`Expected=${result1.afterHash?.slice(0, 12)}, got=${crdtAfterDel?.slice(0, 12)}. ` +
				`This indicates stale content was pushed back (RECOVERY AMPLIFIER).`,
			);
		}
		if (editorAfterDel !== crdtAfterDel) {
			throw new Error(
				`s10a: editor != CRDT after deletion. ` +
				`editor=${editorAfterDel?.slice(0, 12)}, crdt=${crdtAfterDel?.slice(0, 12)}`,
			);
		}
		// disk might still be catching up — verify convergence
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// ─── Phase 2: Remote ADDITION ─────────────────────────────────────

		// 8. Let activity guard expire again.
		await ctx.sleep(2000);

		// 9. Inject remote addition.
		const result2 = await ctx.yaos.__qaOnlyForceCrdtContentUnsafe(
			SCRATCH,
			REMOTE_ADDITION,
			{ originClass: "remote" },
		);

		// 10. Wait for settle.
		await ctx.sleep(4000);

		// 11. POST-ADDITION CHECK.
		const crdtAfterAdd = await ctx.yaos.getCrdtHash(SCRATCH);
		if (crdtAfterAdd !== result2.afterHash) {
			throw new Error(
				`s10a: CRDT hash changed after addition settle! ` +
				`Expected=${result2.afterHash?.slice(0, 12)}, got=${crdtAfterAdd?.slice(0, 12)}. ` +
				`RECOVERY AMPLIFIER detected.`,
			);
		}
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// ─── Phase 3: Stability soak ──────────────────────────────────────

		// 12. Final soak: verify no late recovery fires.
		const stableHash = await ctx.yaos.getCrdtHash(SCRATCH);
		for (let i = 0; i < 6; i++) {
			await ctx.sleep(1000);
			const h = await ctx.yaos.getCrdtHash(SCRATCH);
			if (h !== stableHash) {
				throw new Error(
					`s10a: LATE AMPLIFICATION at soak sample ${i + 1} — ` +
					`hash changed from ${stableHash?.slice(0, 12)} to ${h?.slice(0, 12)}`,
				);
			}
		}
	},

	async assert(ctx: QaContext): Promise<void> {
		// Final state: file has the remote addition content.
		await ctx.assert.fileContent(SCRATCH, REMOTE_ADDITION);
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.closeFile(SCRATCH).catch(() => {});
		await ctx.deleteFile(SCRATCH).catch(() => {});
	},
};
