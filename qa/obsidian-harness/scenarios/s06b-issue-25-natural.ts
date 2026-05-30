/**
 * S06b — Issue #25: natural event-pipeline no-loop soak regression.
 *
 * Purpose: prove that the real Obsidian event pipeline does NOT produce a
 * recovery loop when the user edits a file with repeated tasks block anchors
 * and performs a selection delete crossing the checkpoint boundary.
 *
 * No forced internal methods (__qaOnly*) are used. Everything goes through
 * real vault events, real editor, real CRDT sync.
 *
 * Soak design:
 *   The original report observed a loop for ~6 minutes with a stable +57 char
 *   delta every ~4s. We soak for 3 minutes. A loop would be detectable by:
 *   (a) monotonic file size growth > 1 KB, OR
 *   (b) disk != CRDT after soak.
 *
 * Important: use ctx.sleep() for the soak, NOT waitForIdle().
 *   waitForIdle() returns as soon as YAOS is quiescent (~2s).
 *   sleep() is the actual wall-clock soak.
 *
 * Auto-save timing:
 *   After editor operations, Obsidian auto-saves asynchronously (~1-2s).
 *   We add a 3s sleep before size/hash checks to let that complete.
 */

import type { QaScenario } from "../types";
import { buildIssue25Fixture, issue25UniquePath, ISSUE_25_TASKS_ANCHOR_1 } from "./issue-25-fixture";

const AUTOSAVE_WAIT_MS = 3_000;  // wait for Obsidian auto-save after last edit
const SOAK_MS = 180_000;          // 3 minutes — original report loop duration
const SOAK_SAMPLE_INTERVAL_MS = 30_000; // size sample every 30s during soak
const MAX_ALLOWED_GROWTH_BYTES = 1024;  // 1 KB tolerance

async function getFileSize(ctx: { app: { vault: { getAbstractFileByPath(p: string): unknown } } }, path: string): Promise<number> {
	const f = ctx.app.vault.getAbstractFileByPath(path);
	return f ? ((f as unknown as { stat?: { size?: number } }).stat?.size ?? 0) : 0;
}

export const s06bIssue25Natural: QaScenario = {
	id: "issue-25-editor-bound-loop-natural",
	title: "Issue #25: natural event-pipeline no-loop soak (3 min)",
	tags: ["issue-25", "editor-bound", "recovery", "single-device", "regression", "natural", "soak"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx): Promise<void> {
		await ctx.waitForIdle(8000);
	},

	async run(ctx): Promise<void> {
		const path = issue25UniquePath();
		const fixture = buildIssue25Fixture({ fillerLines: 400 });

		// 1. Create file and wait for CRDT to ingest it.
		await ctx.createFile(path, fixture);
		await ctx.waitForFile(path, 15000);
		await ctx.waitForIdle(10000);

		// 2. Open in editor.
		await ctx.openFile(path);
		await ctx.sleep(1500); // let binding settle

		// 3. Type bursty checkbox edits above the tasks blocks
		//    (mirrors reporter's checkbox editing).
		await ctx.typeIntoFile(path, "\n- [ ] alpha");
		await ctx.typeIntoFile(path, "\n- [ ] beta");
		await ctx.typeIntoFile(path, "\n- [ ] ");
		await ctx.typeIntoFile(path, "\n- [ ] gamma");
		await ctx.typeIntoFile(path, "\n- [ ] delta");

		// 4. Selection delete crossing from checkbox list into first tasks block.
		//    This is the exact trigger from the reporter's description.
		let editor: {
			getValue(): string;
			setSelection(a: unknown, b: unknown): void;
			replaceSelection(s: string): void;
		} | null = null;
		ctx.app.workspace.iterateAllLeaves((leaf) => {
			if (editor) return;
			const v = leaf.view as unknown as { file?: { path?: string }; editor?: typeof editor };
			if (v?.file?.path === path && v.editor) {
				editor = v.editor;
			}
		});

		if (editor) {
			const full: string = (editor as { getValue(): string }).getValue();
			// Select from first checkbox addition through the sort-by-priority anchor
			// in the first tasks block — this is the boundary the reporter crossed.
			const selStart = full.indexOf("- [ ] alpha");
			const selEnd = full.indexOf(ISSUE_25_TASKS_ANCHOR_1) + ISSUE_25_TASKS_ANCHOR_1.length;
			if (selStart >= 0 && selEnd > selStart) {
				const toPos = (text: string, idx: number) => {
					const lines = text.slice(0, idx).split("\n");
					return { line: lines.length - 1, ch: lines[lines.length - 1].length };
				};
				(editor as { setSelection(a: unknown, b: unknown): void }).setSelection(
					toPos(full, selStart),
					toPos(full, selEnd),
				);
				(editor as { replaceSelection(s: string): void }).replaceSelection("");
			}
		}

		// 5. Wait for Obsidian auto-save to write to disk, and for YAOS to
		//    process the resulting disk event. Without this, disk hash will
		//    still reflect the pre-edit content.
		await ctx.sleep(AUTOSAVE_WAIT_MS);
		await ctx.waitForIdle(10000);

		// 6. Record starting size for the stable-delta detector.
		const sizeAtSoakStart = await getFileSize(ctx, path);
		const sizeSamples: number[] = [sizeAtSoakStart];

		// 7. Soak loop — sample size periodically, fail fast on growth.
		//    Use sleep(), NOT waitForIdle() — we want wall-clock time.
		const soakSteps = Math.floor(SOAK_MS / SOAK_SAMPLE_INTERVAL_MS);
		for (let i = 0; i < soakSteps; i++) {
			await ctx.sleep(SOAK_SAMPLE_INTERVAL_MS);
			const sampleSize = await getFileSize(ctx, path);
			sizeSamples.push(sampleSize);
			const growth = sampleSize - sizeAtSoakStart;
			console.log(`[S06b] soak sample ${i + 1}/${soakSteps}: size=${sampleSize}, growth=${growth >= 0 ? "+" : ""}${growth}`);
			if (growth > MAX_ALLOWED_GROWTH_BYTES) {
				throw new Error(
					`Issue-25 (natural): file grew by ${growth} bytes at soak step ${i + 1}/${soakSteps} ` +
					`— possible loop. Sizes: [${sizeSamples.join(", ")}]`,
				);
			}
		}

		// 8. Final hash assertions after soak.
		const diskHash = await ctx.yaos.getDiskHash(path);
		const crdtHash = await ctx.yaos.getCrdtHash(path);
		const editorHash = await ctx.yaos.getEditorHash(path);

		if (!diskHash || !crdtHash) {
			throw new Error("Issue-25 (natural): could not read postcondition hashes after soak");
		}
		if (diskHash !== crdtHash) {
			throw new Error(
				`Issue-25 (natural): disk != CRDT after ${SOAK_MS / 1000}s soak\n` +
				`  disk: ${diskHash}\n  crdt: ${crdtHash}\n` +
				`  size samples: [${sizeSamples.join(", ")}]`,
			);
		}
		if (editorHash && editorHash !== diskHash) {
			throw new Error(
				`Issue-25 (natural): editor != disk after soak\n` +
				`  editor: ${editorHash}\n  disk: ${diskHash}`,
			);
		}

		await ctx.closeFile(path);
		await ctx.deleteFile(path);
	},

	async assert(ctx): Promise<void> {
		await ctx.assert.noConflictCopies("QA-issue-25");
	},

	async cleanup(ctx): Promise<void> {
		await ctx.waitForIdle(5000);
	},
};
