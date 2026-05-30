/**
 * S02 — Single-device offline handoff create (adapter write while offline).
 *
 * Purpose: Prove that a file written to disk while the provider is intentionally
 * disconnected is correctly uploaded when the provider reconnects.
 *
 * This is the single-device version. For the true two-device test see
 * "offline-handoff-create" in qa/controllers/two-device.ts.
 *
 * Steps:
 *   1. Disconnect provider (real disconnect, not reconnect cycle)
 *   2. Wait for provider to confirm disconnected
 *   3. Write file to disk via adapter (simulates local-only creation while offline)
 *   4. Wait for Obsidian to observe the file (reconciler batches)
 *   5. Reconnect provider
 *   6. Wait for idle (sync complete)
 *   7. Assert file synced to CRDT and server confirmed
 *
 * Key events expected:
 *   disk.create.observed (after adapter write + reconnect)
 *   crdt.file.created
 *   server.receipt.confirmed
 *   disk.write.ok (reconciler may write CRDT back to disk — should suppress)
 */

import type { QaScenario, QaContext } from "../types";

const SCRATCH = "QA-scratch/s02-offline-handoff.md";
const CONTENT = "# Offline Handoff\n\nCreated while provider disconnected.\n";

export const s02OfflineHandoffCreate: QaScenario = {
	id: "offline-handoff-create",
	title: "Single device: adapter write while offline → reconnect → receipt confirmed",
	tags: ["offline", "single-device", "layer1", "release-gate"],

	async setup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		await ctx.waitForIdle(8000);
	},

	async run(ctx: QaContext): Promise<void> {
		// 1. Hard offline hold — blocks ALL reconnect paths (visibility, network, timers)
		ctx.yaos.setQaNetworkHold("offline");
		await ctx.yaos.waitForProviderDisconnected(10_000);

		// 2. Write file while offline (adapter write = bypasses vault event pipeline)
		await ctx.writeAdapterFile(SCRATCH, CONTENT);

		// Small delay to let Obsidian's file watcher fire
		await new Promise((r) => setTimeout(r, 1500));

		// 3. Release hold and reconnect
		const reconnectTs = Date.now();
		ctx.yaos.setQaNetworkHold("online");

		// 4. Wait for full idle (provider synced + reconciled)
		await ctx.waitForIdle(30_000);

		// 5. Wait for receipt that was confirmed AFTER we reconnected
		await ctx.yaos.waitForReceiptAfter(reconnectTs, 30_000);
	},

	async assert(ctx: QaContext): Promise<void> {
		await ctx.assert.fileExists(SCRATCH);
		await ctx.assert.diskEqualsCrdt(SCRATCH);
		await ctx.assert.fileContent(SCRATCH, CONTENT);
		await ctx.assert.noConflictCopies("QA-scratch");
	},

	async cleanup(ctx: QaContext): Promise<void> {
		await ctx.deleteFile(SCRATCH).catch(() => {});
		// Always release offline hold on cleanup, even if test failed midway
		ctx.yaos.setQaNetworkHold("online");
	},
};
