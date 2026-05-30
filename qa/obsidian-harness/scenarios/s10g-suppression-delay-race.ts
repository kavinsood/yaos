/**
 * S10g — Issue #22: suppression-delay race fault injection.
 *
 * Purpose: Prove that even if diskMirror's suppression TTL expires before
 * the vault modify event arrives (simulating slow iOS I/O), syncFileFromDisk
 * does NOT push stale content back when the CRDT just received a remote update.
 *
 * The suppression mechanism has a 500ms TTL. On iOS/slow filesystems, the vault
 * modify event might arrive AFTER this TTL expires — making the self-write
 * unsuppressed. This test verifies the second line of defense: the "crdt-current"
 * short-circuit and "disk lag" activity guard.
 *
 * Mechanism:
 *   1. Create file, open in editor, let binding settle.
 *   2. Inject remote content via forceCrdtContent(originClass: "remote").
 *      This updates Y.Text + editor + schedules diskMirror write.
 *   3. Wait for diskMirror to write and the suppression entry to EXPIRE (>500ms).
 *   4. Force syncFileFromDisk via ingestDiskFileNow.
 *      This simulates the vault modify event arriving late (after suppression expiry).
 *   5. Assert: the forced syncFileFromDisk does NOT push old content back.
 *      Expected branch: "crdt-current" (if disk was already updated by diskMirror)
 *      or "disk lag" (if editor/CRDT match but disk is somehow still stale).
 *   6. Assert: CRDT hash unchanged, no oscillation.
 *
 * What this proves:
 *   Even under a suppression TTL miss, the reconciliation path has adequate
 *   secondary defenses (crdt-current, disk lag, postcondition).
 *
 * What this does NOT prove:
 *   Real iOS filesystem timing behavior (only deterministic fault injection).
 *
 * Bug class: Issue #22 Candidate 2 (suppression TTL race).
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s10g-suppression-race.md";
const INITIAL = "# Suppression Race\n\nOriginal content.\nKeep this line.\n";
const REMOTE_EDIT = "# Suppression Race\n\nRemote edit applied.\nKeep this line.\nNew remote line.\n";

export const s10gSuppressionDelayRace: QaScenario = {
	id: "issue-22-suppression-delay-race",
	title: "Issue #22: suppression TTL miss does not cause stale recovery",
	tags: ["issue-22", "suppression", "race", "fault-injection", "single-device", "regression"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create and sync.
		await ctx.createFile(SCRATCH, INITIAL);
		await ctx.waitForIdle(10_000);
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// 2. Open in editor, let binding settle + activity guard expire.
		await ctx.openFile(SCRATCH);
		await ctx.waitForCrdtBinding(SCRATCH, 10_000);
		await ctx.sleep(2000);

		// 3. PRECONDITION: all match.
		await ctx.assert.diskEqualsCrdt(SCRATCH);

		// 4. Inject remote content (simulates remote device pushing an edit).
		//    This triggers: Y.Text update → y-codemirror → editor update →
		//    diskMirror observer → scheduleOpenWrite(1500ms).
		const injectResult = await ctx.yaos.forceCrdtContent(
			SCRATCH,
			REMOTE_EDIT,
			{ originClass: "remote" },
		);
		const expectedHash = injectResult.afterHash;
		if (!expectedHash || expectedHash === injectResult.beforeHash) {
			throw new Error("s10g: remote injection had no effect");
		}

		// 5. Wait for diskMirror's open-file write to complete (1500ms timer)
		//    AND for the suppression entry to EXPIRE (500ms TTL).
		//    After 2500ms: diskMirror has written, suppression has expired.
		await ctx.sleep(2500);

		// 6. Capture CRDT hash before the forced sync (should still be expectedHash).
		const crdtBefore = await ctx.yaos.getCrdtHash(SCRATCH);
		if (crdtBefore !== expectedHash) {
			throw new Error(
				`s10g: CRDT hash changed between injection and forced sync! ` +
				`Expected=${expectedHash.slice(0, 12)}, got=${crdtBefore?.slice(0, 12)}`,
			);
		}

		// 7. FAULT INJECTION: Force syncFileFromDisk as if a vault modify event
		//    arrived after suppression expired.
		//    If the suppression missed and the file was modified by diskMirror,
		//    disk content should == CRDT content → "crdt-current" → skip.
		//    If disk is somehow stale → depends on activity guard and postcondition.
		await ctx.yaos.ingestDiskFileNow(SCRATCH, "modify");

		// 8. Wait for any recovery/write to settle.
		await ctx.sleep(2000);

		// 9. CRITICAL: CRDT hash must NOT have changed.
		//    If it changed, stale content was pushed back (suppression miss + defense failure).
		const crdtAfter = await ctx.yaos.getCrdtHash(SCRATCH);
		if (crdtAfter !== expectedHash) {
			throw new Error(
				`s10g: SUPPRESSION RACE BUG — CRDT hash changed after forced syncFileFromDisk! ` +
				`Before=${expectedHash.slice(0, 12)}, after=${crdtAfter?.slice(0, 12)}. ` +
				`The secondary defenses (crdt-current/disk-lag/postcondition) FAILED.`,
			);
		}

		// 10. Stability soak.
		for (let i = 0; i < 4; i++) {
			await ctx.sleep(1000);
			const h = await ctx.yaos.getCrdtHash(SCRATCH);
			if (h !== expectedHash) {
				throw new Error(`s10g: late hash change at soak ${i + 1}`);
			}
		}
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileContent(SCRATCH, REMOTE_EDIT);
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.closeFile(SCRATCH).catch(() => {});
		await ctx.deleteFile(SCRATCH).catch(() => {});
	},
};
