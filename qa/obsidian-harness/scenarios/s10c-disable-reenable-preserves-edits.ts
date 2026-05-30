/**
 * S10c — Issue #22: offline edits survive reconnect (disk authority).
 *
 * Purpose: Prove that edits made while YAOS is disconnected are preserved
 * when the provider reconnects, and are NOT overwritten by stale CRDT state
 * from the server.
 *
 * This targets the user report: "I tried turning off the YAOS plugin, then
 * after completing the note turned it back on, only to LOSE ALL MY EDITS."
 *
 * Mechanism:
 *   1. Create file, sync to server, confirm receipt.
 *   2. Go fully offline (setQaNetworkHold("offline")).
 *   3. Open file in editor, type substantial new content.
 *   4. Wait for Obsidian to autosave (disk has new content, CRDT is local-only).
 *   5. Reconnect (setQaNetworkHold("online")).
 *   6. Wait for full idle + receipt.
 *   7. Assert: disk edits survived, disk == CRDT, no conflict copies.
 *
 * What this proves:
 *   After reconnect, the authoritative reconciliation does NOT overwrite
 *   local disk edits with stale server CRDT state. The local edits propagate
 *   to CRDT and then to the server.
 *
 * What this does NOT prove:
 *   - Actual plugin disable/enable lifecycle (requires Obsidian plugin reload)
 *   - Multi-device convergence after reconnect
 *   - Mobile app suspension/resume
 *
 * Bug class: Issue #22 (reconnect data loss variant).
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s10c-reconnect-preserves.md";
const INITIAL = "# S10c Reconnect\n\nInitial content before disconnect.\n";
const OFFLINE_EDIT = "\nEdited while offline. This content MUST survive reconnect.\n";
const OFFLINE_EDIT_2 = "Second offline paragraph with unique marker: xK9mQ7.\n";
const EXPECTED_FINAL = INITIAL + OFFLINE_EDIT + OFFLINE_EDIT_2;

export const s10cDisableReenablePreservesEdits: QaScenario = {
	id: "issue-22-disable-reenable-preserves-edits",
	title: "Issue #22: offline edits survive reconnect (disk authority)",
	tags: ["issue-22", "offline", "reconnect", "data-loss", "single-device", "regression", "P0"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create file and wait for FULL sync (disk == CRDT, server has it).
		await ctx.createFile(SCRATCH, INITIAL);
		await ctx.waitForIdle(15_000);
		await ctx.waitForDiskCrdtConverge(SCRATCH, 15_000);

		// 2. PRECONDITION: file is synced.
		await ctx.assert.diskEqualsCrdt(SCRATCH);

		// 3. Go fully offline. This blocks ALL reconnect paths.
		//    Use sleep instead of waitForProviderDisconnected to avoid race.
		ctx.yaos.setQaNetworkHold("offline");
		await ctx.sleep(2000);

		// 4. Edit file while offline via vault API (reliable disk write).
		//    This simulates the user's scenario: edits go to disk while sync is off.
		//    We use modifyFile (not typeIntoFile) because the test target is
		//    "disk authority on reconnect," not "editor typing mechanics."
		await ctx.modifyFile(SCRATCH, EXPECTED_FINAL);

		// 5. Wait for CRDT to ingest the modify event (local-only, no server).
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// 6. Verify edits are on disk AND in CRDT before reconnect.
		await ctx.assert.fileContent(SCRATCH, EXPECTED_FINAL);
		await ctx.assert.diskEqualsCrdt(SCRATCH);

		// 7. Reconnect. The Yjs state-vector merge must preserve local edits
		//    that the server hasn't seen yet (local state vector is ahead).
		ctx.yaos.setQaNetworkHold("online");

		// 8. Wait for reconnect to fully settle (provider + reconciliation).
		//    Use generous timeout — reconnect can take 10-20s in practice.
		await ctx.waitForIdle(60_000);

		// 9. Final convergence: disk still has our edits after server merge.
		await ctx.waitForDiskCrdtConverge(SCRATCH, 15_000);
	},

	async assert(ctx: QaContext): Promise<void> {
		// THE critical assertion: disk edits survived reconnect.
		await ctx.assert.fileContent(SCRATCH, EXPECTED_FINAL);

		// disk == CRDT: no divergence after reconnect.
		await ctx.assert.diskEqualsCrdt(SCRATCH);

		// No conflict copies: the merge was clean, no ambiguous state.
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		// Always release hold, even on failure.
		ctx.yaos.setQaNetworkHold("online");
		await ctx.closeFile(SCRATCH).catch(() => {});
		await ctx.deleteFile(SCRATCH).catch(() => {});
	},
};
