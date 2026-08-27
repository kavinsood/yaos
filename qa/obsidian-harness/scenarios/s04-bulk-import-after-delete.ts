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
 * These writes go through Obsidian's adapter layer rather than the external
 * OS watcher path.
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

interface BulkImportVariant {
	id: string;
	title: string;
	count: number;
	concurrent: boolean;
	settleMs: number;
	idleTimeoutMs: number;
	verifyContent: boolean;
	tags: string[];
}

function buildBulkImportScenario(variant: BulkImportVariant): QaScenario {
	const files = makeFiles(variant.count);
	return {
		id: variant.id,
		title: variant.title,
		tags: variant.tags,

		async setup(ctx): Promise<void> {
			await cleanupFiles(ctx, files);
			await ctx.waitForIdle(variant.concurrent ? 8000 : 5000);
		},

		async run(ctx): Promise<void> {
			const importTs = Date.now();
			if (variant.concurrent) {
				await Promise.all(
					files.map(({ path, content }) => ctx.writeAdapterFile(path, content)),
				);
			} else {
				for (const { path, content } of files) {
					await ctx.writeAdapterFile(path, content);
				}
			}
			await ctx.sleep(variant.settleMs);
			await ctx.waitForIdle(variant.idleTimeoutMs);
			await ctx.yaos.waitForReceiptAfter(importTs, 30_000);
		},

		async assert(ctx): Promise<void> {
			const failures: string[] = [];
			for (const { path, content } of files) {
				try {
					await ctx.assert.fileExists(path);
					if (variant.verifyContent) await ctx.assert.fileContent(path, content);
					await ctx.assert.diskEqualsCrdt(path);
				} catch (error) {
					failures.push(`${path}: ${String(error)}`);
				}
			}
			if (failures.length > 0) {
				throw new Error(
					`${variant.concurrent ? "Storm" : "Sequential"} import: ` +
					`${failures.length} file(s) failed:\n${failures.join("\n")}`,
				);
			}
			await ctx.assert.noConflictCopies(PREFIX);
		},

		async cleanup(ctx): Promise<void> {
			await cleanupFiles(ctx, files);
		},
	};
}

export const s04aBulkImportSmoke = buildBulkImportScenario({
	id: "bulk-import-after-delete-smoke",
	title: "Bulk import: 10 sequential adapter writes after delete",
	count: 10,
	concurrent: false,
	settleMs: 2000,
	idleTimeoutMs: 20_000,
	verifyContent: true,
	tags: ["bulk-import", "single-device", "layer2"],
});

export const s04bBulkImportStorm = buildBulkImportScenario({
	id: "bulk-import-after-delete-storm",
	title: "Bulk import: 50 concurrent adapter writes (watcher storm)",
	count: 50,
	concurrent: true,
	settleMs: 3000,
	idleTimeoutMs: 30_000,
	verifyContent: false,
	tags: ["bulk-import", "stress", "single-device", "layer2"],
});
