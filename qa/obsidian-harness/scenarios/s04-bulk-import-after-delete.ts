/**
 * S04 — Bulk import after delete (adapter write, smoke + storm variants).
 *
 * Purpose: Prove that re-importing a batch of files after deletion converges
 * correctly. Two sub-tests:
 *
 *   s04a — smoke: 10 files, sequential adapter writes
 *   s04b — storm: 50 files, CONCURRENT adapter writes (watcher storm simulation)
 *
 * The storm variant is critical: concurrent writes fire many disk events
 * simultaneously, stressing the reconciler's batching and deduplication.
 *
 * Note: For a TRUE external-write storm (OS watcher path), use the Node
 * controller's writeNodeFiles() from qa:two-device or qa:obsidian scripts.
 * These adapter writes go through Obsidian's adapter layer.
 *
 * Key events expected:
 *   disk.create.observed × N (after adapter writes + watcher fires)
 *   crdt.file.created × N
 *   server.receipt.confirmed
 */

import type { QaScenario, QaContext } from "../types";

const PREFIX = "QA-scratch/s04-bulk";

function makeFiles(count: number): Array<{ path: string; content: string }> {
	return Array.from({ length: count }, (_, i) => ({
		path: `${PREFIX}/note-${String(i + 1).padStart(4, "0")}.md`,
		content: `# Note ${i + 1}\n\nContent for bulk note ${i + 1}.\n\n- [ ] Task A\n- [ ] Task B\n`,
	}));
}

async function cleanupFiles(ctx: QaContext, files: Array<{ path: string }>): Promise<void> {
	for (const { path } of files) {
		await ctx.deleteFile(path).catch(() => {});
	}
}

// -----------------------------------------------------------------------
// S04a — smoke: 10 sequential adapter writes
// -----------------------------------------------------------------------

export const s04aBulkImportSmoke: QaScenario = {
	id: "bulk-import-after-delete-smoke",
	title: "Bulk import: 10 sequential adapter writes after delete",
	tags: ["bulk-import", "single-device", "layer2"],

	async setup(ctx: QaContext): Promise<void> {
		await cleanupFiles(ctx, makeFiles(10));
		await ctx.waitForIdle(5000);
	},

	async run(ctx: QaContext): Promise<void> {
		const files = makeFiles(10);

		// Write sequentially (smoke: verify basic correctness)
		for (const { path, content } of files) {
			await ctx.writeAdapterFile(path, content);
		}

		// Give reconciler time to observe and batch
		await new Promise((r) => setTimeout(r, 2000));
		await ctx.waitForIdle(20_000);

		const importTs = Date.now();
		await ctx.yaos.waitForReceiptAfter(importTs, 30_000);
	},

	async assert(ctx: QaContext): Promise<void> {
		const files = makeFiles(10);
		for (const { path, content } of files) {
			await ctx.assert.fileExists(path);
			await ctx.assert.fileContent(path, content);
			await ctx.assert.diskEqualsCrdt(path);
		}
		await ctx.assert.noConflictCopies(PREFIX);
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await cleanupFiles(ctx, makeFiles(10));
	},
};

// -----------------------------------------------------------------------
// S04b — storm: 50 concurrent adapter writes
// -----------------------------------------------------------------------

export const s04bBulkImportStorm: QaScenario = {
	id: "bulk-import-after-delete-storm",
	title: "Bulk import: 50 concurrent adapter writes (watcher storm)",
	tags: ["bulk-import", "stress", "single-device", "layer2"],

	async setup(ctx: QaContext): Promise<void> {
		await cleanupFiles(ctx, makeFiles(50));
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		const files = makeFiles(50);

		// Write CONCURRENTLY — stress-tests the reconciler's batching
		await Promise.all(
			files.map(({ path, content }) => ctx.writeAdapterFile(path, content)),
		);

		// Give reconciler time to drain the storm
		await new Promise((r) => setTimeout(r, 3000));
		await ctx.waitForIdle(30_000);

		const importTs = Date.now();
		await ctx.yaos.waitForReceiptAfter(importTs, 30_000);
	},

	async assert(ctx: QaContext): Promise<void> {
		const files = makeFiles(50);
		const failures: string[] = [];
		for (const { path } of files) {
			try {
				await ctx.assert.fileExists(path);
				await ctx.assert.diskEqualsCrdt(path);
			} catch (e) {
				failures.push(`${path}: ${String(e)}`);
			}
		}
		if (failures.length > 0) {
			throw new Error(`Storm import: ${failures.length} file(s) failed:\n${failures.join("\n")}`);
		}
		await ctx.assert.noConflictCopies(PREFIX);
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await cleanupFiles(ctx, makeFiles(50));
	},
};
