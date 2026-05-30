/**
 * S05 — Frontmatter safety loop (two variants).
 *
 * Purpose: Prove that external frontmatter edits do not cause a write loop
 * or duplicate frontmatter corruption.
 *
 * Variants:
 *   s05a — closed file: write frontmatter twice while file is closed
 *   s05b — open editor: type in body, then write frontmatter externally
 *           while the file is open in the editor (the historical failure case)
 *
 * Key events expected:
 *   disk.modify.observed × N (external writes)
 *   (NO disk.event.not_suppressed — suppress must work)
 *   (NO recovery.loop.detected)
 *   (NO conflict artifacts)
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH_CLOSED = "QA-scratch/s05-frontmatter-closed.md";
const SCRATCH_OPEN = "QA-scratch/s05-frontmatter-open-editor.md";

const INITIAL_FM = [
	"---",
	"title: S05 Frontmatter Test",
	"created: 2024-01-01",
	"---",
	"",
	"Initial body content.",
	"",
].join("\n");

const FM_EDIT_1 = [
	"---",
	"title: S05 Frontmatter Test",
	"created: 2024-01-01",
	"updated: 2024-06-01",
	"status: active",
	"---",
	"",
	"Initial body content.",
	"",
].join("\n");

const FM_EDIT_2 = [
	"---",
	"title: S05 Frontmatter Test (revised)",
	"created: 2024-01-01",
	"updated: 2024-06-02",
	"status: published",
	"---",
	"",
	"Initial body content.",
	"",
].join("\n");

// -----------------------------------------------------------------------
// S05a — closed file variant (baseline test)
// -----------------------------------------------------------------------

export const s05aFrontmatterClosedFile: QaScenario = {
	id: "frontmatter-safety-loop-closed",
	title: "Frontmatter: two external writes on closed file, no loop",
	tags: ["frontmatter", "single-device", "layer2"],

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH_CLOSED).catch(() => {});
		await ctx.waitForIdle(5000);
	},

	async run(ctx: QaContext): Promise<void> {
		// Create and sync
		await ctx.createFile(SCRATCH_CLOSED, INITIAL_FM);
		await ctx.waitForIdle(8000);
		await ctx.yaos.waitForReceiptAfter(Date.now(), 20_000);

		// First external frontmatter edit
		await ctx.writeAdapterFile(SCRATCH_CLOSED, FM_EDIT_1);
		await new Promise((r) => setTimeout(r, 1500));

		// Second external frontmatter edit
		await ctx.writeAdapterFile(SCRATCH_CLOSED, FM_EDIT_2);
		await new Promise((r) => setTimeout(r, 1500));

		await ctx.waitForIdle(15_000);
		await ctx.yaos.waitForReceiptAfter(Date.now(), 20_000);
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileExists(SCRATCH_CLOSED);
		await ctx.assert.fileContent(SCRATCH_CLOSED, FM_EDIT_2);
		await ctx.assert.diskEqualsCrdt(SCRATCH_CLOSED);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH_CLOSED).catch(() => {});
	},
};

// -----------------------------------------------------------------------
// S05b — open editor variant (the nasty historical failure case)
//
// Steps:
//   1. Create and open file in editor
//   2. Type into body (binds editor to CRDT)
//   3. External frontmatter write while editor is OPEN → test guard
//   4. Second external frontmatter write while editor is OPEN
//   5. Wait for idle
//   6. Assert: no duplication, no stale heal, disk == CRDT
// -----------------------------------------------------------------------

export const s05bFrontmatterOpenEditor: QaScenario = {
	id: "frontmatter-safety-loop-open-editor",
	title: "Frontmatter: two external writes while editor is OPEN, no loop/dupe",
	tags: ["frontmatter", "editor-bound", "single-device", "layer2"],

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH_OPEN).catch(() => {});
		await ctx.waitForIdle(5000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create and open in editor
		await ctx.createFile(SCRATCH_OPEN, INITIAL_FM);
		await ctx.waitForIdle(8000);
		await ctx.openFile(SCRATCH_OPEN);

		// 2. Type in body to bind the editor to CRDT
		await ctx.typeIntoFile(SCRATCH_OPEN, "\n\nTyped while editor open.");
		await ctx.waitForIdle(5000);

		// 3. External frontmatter write WHILE editor is open
		await ctx.writeAdapterFile(SCRATCH_OPEN, FM_EDIT_1 + "\n\nTyped while editor open.");
		await new Promise((r) => setTimeout(r, 1500));

		// 4. Second external frontmatter write WHILE editor is still open
		await ctx.writeAdapterFile(SCRATCH_OPEN, FM_EDIT_2 + "\n\nTyped while editor open.");
		await new Promise((r) => setTimeout(r, 1500));

		// 5. Wait for full convergence
		await ctx.waitForIdle(20_000);
		await ctx.yaos.waitForReceiptAfter(Date.now(), 20_000);

		// 6. Close
		await ctx.closeFile(SCRATCH_OPEN);
		await ctx.waitForIdle(8000);
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileExists(SCRATCH_OPEN);
		await ctx.assert.diskEqualsCrdt(SCRATCH_OPEN);
		// File should have exactly ONE frontmatter block (not duplicated)
		const content = await (async () => {
			const file = (ctx as unknown as { app: { vault: { read: (f: object) => Promise<string> }; getFileByPath: (p: string) => object | null } }).app.vault.getFileByPath(SCRATCH_OPEN);
			if (!file) throw new Error(`File not found: ${SCRATCH_OPEN}`);
			return (ctx as unknown as { app: { vault: { read: (f: object) => Promise<string> } } }).app.vault.read(file);
		})();
		const fmMatches = (content.match(/^---$/gm) ?? []).length;
		if (fmMatches !== 2) {
			throw new Error(
				`Expected exactly 2 '---' markers (one frontmatter block) but found ${fmMatches}.\n` +
				`Content:\n${content}`,
			);
		}
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.closeFile(SCRATCH_OPEN).catch(() => {});
		await ctx.deleteFile(SCRATCH_OPEN).catch(() => {});
	},
};
