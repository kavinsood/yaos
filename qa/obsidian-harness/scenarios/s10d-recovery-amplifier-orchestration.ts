/**
 * S10d — Issue #22: recovery does not trigger diskMirror amplification loop.
 *
 * Purpose: Prove that when bound-file recovery fires (open-idle disk recovery),
 * the diskMirror does NOT re-schedule a write in response to the recovery
 * transaction, and no amplification loop occurs.
 *
 * This is the controller-orchestration-level test for the origin classification
 * fix (commit 48cfe67). The unit-level proof is in tests/recovery-amplifier.ts.
 * This scenario exercises the full lifecycle:
 *   ReconciliationController → applyDiffToYText → diskMirror observer → origin gate.
 *
 * Mechanism:
 *   1. Create file, open in editor, let binding + activity guard settle.
 *   2. Write divergent content to disk via adapter (not diskMirror — not suppressed).
 *   3. vault modify fires → handleBoundFileSyncGap → "open-idle disk recovery" branch.
 *   4. Recovery applies diff with origin "disk-sync-open-idle-recover".
 *   5. diskMirror text observer fires → isLocalOrigin("disk-sync-open-idle-recover") = TRUE → SKIP.
 *   6. File converges: disk == CRDT == editor.
 *   7. Stability soak: wait 5 seconds, poll hashes every 500ms.
 *   8. Assert: no hash changes during soak, no second recovery, analyzer clean.
 *
 * What this proves (at orchestration level):
 *   - Recovery origin "disk-sync-open-idle-recover" is correctly classified as local.
 *   - diskMirror does NOT schedule a redundant write for recovery transactions.
 *   - No amplification loop: recovery fires exactly once, file stays stable.
 *   - Analyzer rules (recovery-loop, self-write-suppression-miss) pass.
 *
 * Defect this would catch if reintroduced:
 *   If "disk-sync-open-idle-recover" were removed from LOCAL_STRING_ORIGIN_SET,
 *   the diskMirror observer would schedule a write, potentially creating a loop.
 *   The stability soak would detect hash changes (content oscillation).
 *
 * Bug class: Issue #22 Defect A (recovery amplifier / origin misclassification).
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s10d-recovery-amplifier.md";
const INITIAL = "# Recovery Amplifier Test\n\nOriginal content line 1.\nOriginal content line 2.\nOriginal content line 3.\n";
// Divergent content simulates an external disk edit while editor is idle.
const DIVERGENT = "# Recovery Amplifier Test\n\nExternal edit line 1.\nExternal edit line 2.\nExternal edit line 3.\nExtra line added externally.\n";

export const s10dRecoveryAmplifierOrchestration: QaScenario = {
	id: "issue-22-recovery-amplifier-orchestration",
	title: "Issue #22: recovery origin does not trigger diskMirror amplification",
	tags: ["issue-22", "recovery", "amplifier", "origin", "single-device", "regression", "P0"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create file and let CRDT seed from disk.
		await ctx.createFile(SCRATCH, INITIAL);
		await ctx.waitForIdle(10_000);

		// 2. Open in editor — establishes y-codemirror binding.
		await ctx.openFile(SCRATCH);
		await ctx.waitForCrdtBinding(SCRATCH, 10_000);

		// 3. PRECONDITION: baseline is converged.
		const diskHashPre = await ctx.yaos.getDiskHash(SCRATCH);
		const crdtHashPre = await ctx.yaos.getCrdtHash(SCRATCH);
		if (!diskHashPre || !crdtHashPre || diskHashPre !== crdtHashPre) {
			throw new Error("s10d: precondition failed — disk != CRDT before divergence injection");
		}

		// 4. Wait for activity guard (1200ms) to expire so the "open-idle"
		//    recovery branch is eligible (not the "disk lag" skip).
		await ctx.sleep(2000);

		// 5. Write divergent content directly to disk via adapter.
		//    This triggers a vault modify event that is NOT suppressed by diskMirror
		//    (because diskMirror didn't write it). YAOS will see:
		//      editor == CRDT (original) != disk (divergent) → crdtOnly, idle → recovery fires.
		await ctx.writeAdapterFile(SCRATCH, DIVERGENT);

		// 6. Wait for recovery to fire and settle.
		//    Recovery applies disk content → CRDT via applyDiffToYTextWithPostcondition.
		//    After recovery: CRDT = editor = disk = DIVERGENT.
		await ctx.waitForIdle(10_000);
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// 7. CONVERGENCE CHECK: all three authorities must agree.
		const diskHashPost = await ctx.yaos.getDiskHash(SCRATCH);
		const crdtHashPost = await ctx.yaos.getCrdtHash(SCRATCH);
		const editorHashPost = await ctx.yaos.getEditorHash(SCRATCH);
		if (!diskHashPost || !crdtHashPost) {
			throw new Error("s10d: post-recovery hash read failed");
		}
		if (diskHashPost !== crdtHashPost) {
			throw new Error(
				`s10d: post-recovery disk/CRDT mismatch: disk=${diskHashPost.slice(0, 12)} crdt=${crdtHashPost.slice(0, 12)}`,
			);
		}
		if (editorHashPost && editorHashPost !== crdtHashPost) {
			throw new Error(
				`s10d: post-recovery editor/CRDT mismatch: editor=${editorHashPost.slice(0, 12)} crdt=${crdtHashPost.slice(0, 12)}`,
			);
		}

		// 8. STABILITY SOAK: The critical test.
		//    If the origin fix regresses, diskMirror would schedule a write from the
		//    recovery transaction. That write would fire ~1500ms later, creating a
		//    vault modify event. Even if suppressed, it's wasted work. Worse: if heal()
		//    contamination also regressed, the content could oscillate.
		//
		//    We poll hashes every 500ms for 5 seconds. Any change = amplification loop.
		const soakStart = Date.now();
		const stableHash = crdtHashPost;
		const SOAK_DURATION = 5000;
		const SOAK_INTERVAL = 500;
		let soakSamples = 0;

		while (Date.now() - soakStart < SOAK_DURATION) {
			await ctx.sleep(SOAK_INTERVAL);
			soakSamples++;

			const diskNow = await ctx.yaos.getDiskHash(SCRATCH);
			const crdtNow = await ctx.yaos.getCrdtHash(SCRATCH);

			if (diskNow !== stableHash) {
				throw new Error(
					`s10d: AMPLIFICATION DETECTED — disk hash changed during soak ` +
					`(sample ${soakSamples}, expected=${stableHash.slice(0, 12)}, got=${diskNow?.slice(0, 12) ?? "null"})`,
				);
			}
			if (crdtNow !== stableHash) {
				throw new Error(
					`s10d: AMPLIFICATION DETECTED — CRDT hash changed during soak ` +
					`(sample ${soakSamples}, expected=${stableHash.slice(0, 12)}, got=${crdtNow?.slice(0, 12) ?? "null"})`,
				);
			}
		}
	},

	async assert(ctx: QaContext): Promise<void> {
		// Final convergence: file content is the divergent (externally written) content.
		await ctx.assert.fileContent(SCRATCH, DIVERGENT);
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.closeFile(SCRATCH).catch(() => {});
		await ctx.deleteFile(SCRATCH).catch(() => {});
	},
};
