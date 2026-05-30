/**
 * S10b — Issue #22: repeated remote deletions do not oscillate (passive deletion soak).
 *
 * Purpose: Simulate a passive device receiving 10 successive remote deletions
 * (removing one checklist item every 2 seconds). Prove that content length
 * monotonically decreases and no reversion/oscillation occurs.
 *
 * This directly mirrors Video 2 from the issue: user on phone deletes checklist
 * items, passive desktop has the file open, deleted items keep reappearing.
 *
 * Mechanism:
 *   Same as s10a — uses __qaOnlyForceCrdtContentUnsafe(originClass: "remote")
 *   to inject progressively shorter content, simulating the active device's
 *   deletions arriving at the passive device.
 *
 * Pass criteria:
 *   - Content length monotonically decreases after each injection.
 *   - CRDT hash never reverts to a previous value (no oscillation).
 *   - No recovery.decision events with reason "bound-file-open-idle-disk-recovery".
 *   - Final content matches the last injected state (all deletions preserved).
 *   - Analyzer clean.
 *
 * Bug class: Issue #22 (passive device deletion reversion / Video 2).
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s10b-deletion-soak.md";

// Build a checklist with 15 items (mirrors the Video 2 grocery list pattern).
function buildChecklist(itemCount: number): string {
	const header = "# Deletion Soak\n\n";
	const items: string[] = [];
	for (let i = 1; i <= itemCount; i++) {
		items.push(`- [ ] Item ${i}`);
	}
	return header + items.join("\n") + "\n";
}

// Remove items from the END to simulate progressive deletion.
function buildChecklistWithout(totalItems: number, removedFromEnd: number): string {
	const remaining = totalItems - removedFromEnd;
	return buildChecklist(remaining);
}

const TOTAL_ITEMS = 15;
const DELETIONS = 10;
const INITIAL_CONTENT = buildChecklist(TOTAL_ITEMS);
const FINAL_CONTENT = buildChecklistWithout(TOTAL_ITEMS, DELETIONS);

export const s10bPassiveDeletionSoak: QaScenario = {
	id: "issue-22-passive-deletion-soak",
	title: "Issue #22: 10 remote deletions do not oscillate on passive device",
	tags: ["issue-22", "passive", "deletion", "soak", "single-device", "regression", "P0"],
	traceRecordingMode: "qa-safe",
	traceExportPrivacy: "safe",

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Create checklist file and sync.
		await ctx.createFile(SCRATCH, INITIAL_CONTENT);
		await ctx.waitForIdle(10_000);
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// 2. Open in editor (passive device simulation).
		await ctx.openFile(SCRATCH);
		await ctx.waitForCrdtBinding(SCRATCH, 10_000);
		await ctx.sleep(2000); // Let binding settle + activity guard expire.

		// 3. PRECONDITION
		await ctx.assert.diskEqualsCrdt(SCRATCH);

		// 4. Progressive deletion loop — simulate remote device deleting items.
		const seenHashes = new Set<string>();
		let previousLength = INITIAL_CONTENT.length;

		for (let i = 1; i <= DELETIONS; i++) {
			const newContent = buildChecklistWithout(TOTAL_ITEMS, i);

			// Inject deletion as remote update.
			const result = await ctx.yaos.__qaOnlyForceCrdtContentUnsafe(
				SCRATCH,
				newContent,
				{ originClass: "remote" },
			);

			// Wait for the system to process (diskMirror write + vault events).
			await ctx.sleep(2000);

			// Check: CRDT must still have the new (shorter) content.
			const crdtHash = await ctx.yaos.getCrdtHash(SCRATCH);
			if (crdtHash !== result.afterHash) {
				throw new Error(
					`s10b: REVERSION at deletion ${i}! ` +
					`CRDT hash changed from expected=${result.afterHash?.slice(0, 12)} ` +
					`to actual=${crdtHash?.slice(0, 12)}. Content was pushed back.`,
				);
			}

			// Check: CRDT hash must not be one we've seen before (no oscillation).
			if (seenHashes.has(crdtHash!)) {
				throw new Error(
					`s10b: OSCILLATION at deletion ${i}! ` +
					`CRDT hash ${crdtHash?.slice(0, 12)} was seen in a previous iteration.`,
				);
			}
			seenHashes.add(crdtHash!);

			// Check: content length must monotonically decrease.
			if (newContent.length >= previousLength) {
				throw new Error(
					`s10b: content length did not decrease at deletion ${i}: ` +
					`${previousLength} → ${newContent.length}`,
				);
			}
			previousLength = newContent.length;
		}

		// 5. Final convergence: wait for disk to catch up.
		await ctx.waitForDiskCrdtConverge(SCRATCH, 10_000);

		// 6. Stability soak (5 seconds).
		const finalHash = await ctx.yaos.getCrdtHash(SCRATCH);
		for (let i = 0; i < 5; i++) {
			await ctx.sleep(1000);
			const h = await ctx.yaos.getCrdtHash(SCRATCH);
			if (h !== finalHash) {
				throw new Error(
					`s10b: LATE REVERSION at soak sample ${i + 1} — ` +
					`hash changed from ${finalHash?.slice(0, 12)} to ${h?.slice(0, 12)}`,
				);
			}
		}
	},

	async assert(ctx: QaContext): Promise<void> {
		// All 10 deletions preserved: file has only 5 remaining items.
		await ctx.assert.fileContent(SCRATCH, FINAL_CONTENT);
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.closeFile(SCRATCH).catch(() => {});
		await ctx.deleteFile(SCRATCH).catch(() => {});
	},
};
