import type { TwoDeviceScenarios } from "./shared";

export const basicScenarios: TwoDeviceScenarios = {
	/**
	 * Offline handoff:
	 *   A creates file while B is offline → A confirms receipt → B reconnects → B has file
	 */
	"offline-handoff-create": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s02-two-device-offline-handoff.md";

		// 1. Hard offline hold on B -- blocks ALL auto-reconnect paths
		log("Device B: activating offline hold...");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("offline")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForProviderDisconnected(10000)`);
		log("Device B: provider disconnected.");

		// 2. A creates the file and waits for its action-relative server receipt
		log("Device A: creating file...");
		const actionTs = await a.evalRaw<number>("Date.now()");
		await a.evalRaw(
			`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, "# Offline Handoff\\n\\nCreated on A while B offline.\\n")`
		);
		log("Device A: waiting for server receipt...");
		try {
			await a.evalRaw(`
				(async () => {
					const d = window.__YAOS_DEBUG__;
					if (!d) throw new Error("no debug API on A");
					await d.waitForReceiptAfter(${actionTs}, 30000);
				})()
			`);
			log("Device A: receipt confirmed ✓");
		} catch (e) {
			errors.push(`Device A receipt wait failed: ${String(e)}`);
		}

		// 3. Release B offline hold and reconnect
		log("Device B: releasing offline hold and reconnecting...");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("online")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch((e: unknown) => {
			errors.push(`Device B idle wait after reconnect failed: ${String(e)}`);
		});
		log("Device B: reconnected and idle.");

		// 4. Assert file arrived on B
		const fileExistsOnB = await b.evalRaw<boolean>(
			`app.vault.getAbstractFileByPath(${JSON.stringify(scratch)}) !== null`,
		).catch(() => false);

		if (!fileExistsOnB) {
			errors.push(`File did not arrive on device B after reconnect: ${scratch}`);
		} else {
			log("Device B: file arrived ✓");
		}

		// 5. Assert disk == CRDT on B
		if (fileExistsOnB) {
			const diskEqCrdt = await b.evalRaw<boolean>(`
				(async () => {
					const d = window.__YAOS_DEBUG__;
					if (!d) return false;
					const dh = await d.getDiskHash(${JSON.stringify(scratch)});
					const ch = await d.getCrdtHash(${JSON.stringify(scratch)});
					return dh !== null && dh === ch;
				})()
			`).catch(() => false);
			if (!diskEqCrdt) {
				errors.push(`Device B: disk != CRDT for ${scratch} after sync`);
			} else {
				log("Device B: disk == CRDT ✓");
			}
		}

		// Cleanup
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	/**
	 * Delete does not resurrect:
	 *   B goes stale → A deletes and confirms → B reconnects → file must NOT reappear
	 */
	"delete-does-not-resurrect": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s03-two-device-delete.md";

		// Setup: create on A, wait for sync to both. The timestamp is captured
		// in A's renderer immediately before the direct mutation, preserving the
		// intentionally strict waitForReceiptAfter contract.
		log("Device A: creating test file...");
		const actionTs = await a.evalRaw<number>("Date.now()");
		await a.evalRaw(
			`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, "# S03 Two-Device Delete\\n")`
		);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForReceiptAfter(${actionTs}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 20000)`);

		// Verify B has the file
		const existsOnBBefore = await b.evalRaw<boolean>(
			`app.vault.getAbstractFileByPath(${JSON.stringify(scratch)}) !== null`,
		).catch(() => false);
		if (!existsOnBBefore) {
			errors.push("File did not sync to device B before delete test");
		}

		// Hard offline hold on B (B goes stale -- all reconnect paths blocked)
		log("Device B: activating offline hold (going stale)...");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("offline")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForProviderDisconnected(10000)`);
		log("Device B: disconnected.");

		// A deletes and confirms
		log("Device A: deleting file...");
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_QA__?.waitForIdle(10000)`);
		log("Device A: file deleted.");

		// Release B's offline hold
		log("Device B: releasing offline hold...");
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("online")`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(20000)`).catch((e: unknown) => {
			errors.push(`Device B idle wait after reconnect failed: ${String(e)}`);
		});
		log("Device B: reconnected.");

		// Assert file is ABSENT on B
		const existsOnBAfter = await b.evalRaw<boolean>(
			`app.vault.getAbstractFileByPath(${JSON.stringify(scratch)}) !== null`,
		).catch(() => false);
		if (existsOnBAfter) {
			errors.push("RESURRECT BUG: file still present on device B after delete on device A");
		} else {
			log("Device B: file correctly absent ✓");
		}

		// Cleanup
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},
};
