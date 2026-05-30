/**
 * S03 — Delete does not resurrect (single-device).
 *
 * Purpose: Prove that after a local delete, CRDT reconciliation does NOT
 * resurrect the file on this device. Tests the tombstone→reconcile path.
 *
 * Note: the multi-device version ("delete-does-not-resurrect" in two-device.ts)
 * is the real release gate. This single-device variant catches local resurrection
 * from stale CRDT state.
 *
 * Steps:
 *   1. Create file, confirm receipt
 *   2. Delete via Obsidian (vault-delete mode)
 *   3. Force reconcile (simulate background reconcile)
 *   4. Wait for idle
 *   5. Assert file absent
 *
 * Key events expected:
 *   disk.delete.observed → crdt.file.tombstoned
 *   (NO crdt.file.revived, NO disk.write.ok for the path)
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s03-delete-resurrect.md";
const CONTENT = "# Delete Does Not Resurrect\n\nThis file must stay deleted.\n";

export const s03DeleteDoesNotResurrect: QaScenario = {
	id: "delete-does-not-resurrect",
	title: "Single device: delete → reconcile → file stays gone",
	tags: ["delete", "single-device", "layer1", "release-gate"],

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(5000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create and confirm receipt
		await ctx.createFile(SCRATCH, CONTENT);
		await ctx.waitForIdle(8000);
		const createTs = Date.now();
		await ctx.yaos.waitForReceiptAfter(createTs, 30_000);

		// 2. Delete via vault API (permanent)
		await ctx.deleteFile(SCRATCH, "vault-delete");

		// 3. Force reconcile to ensure tombstone is processed
		await ctx.yaos.forceReconcile();

		// 4. Wait for idle
		await ctx.waitForIdle(10_000);

		// 5. Test also with adapter-remove mode if vault-delete passed
		// (exercises a different code path — raw fs removal)
		const adapterPath = "QA-scratch/s03-delete-resurrect-adapter.md";
		await ctx.createFile(adapterPath, CONTENT);
		await ctx.waitForIdle(5000);
		await ctx.deleteFile(adapterPath, "adapter-remove");
		await ctx.yaos.forceReconcile();
		await ctx.waitForIdle(8000);
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileNotExists(SCRATCH);
		await ctx.assert.fileNotExists("QA-scratch/s03-delete-resurrect-adapter.md");
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.deleteFile("QA-scratch/s03-delete-resurrect-adapter.md").catch(() => {});
	},
};
