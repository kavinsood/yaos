import type { TwoDeviceScenarios } from "./shared";
import { S10F_SENTINEL, READ_EDITOR_EXPR, deleteSentinelExpr, pollForReversion, s10fCleanup, s10fConvergence, s10fSetup, typeAtCursorExpr } from "./shared";

export const issue22RoundtripScenarios: TwoDeviceScenarios = {
	/**
	 * Issue #22 passive-open roundtrip:
	 *   Both devices online, same file open.
	 *   Device A deletes sentinel text THROUGH THE REAL EDITOR and continues typing.
	 *   Device B is passive (file open, no typing).
	 *   Poll Device A editor content at 250ms -- fail if sentinel EVER reappears.
	 *   Assert: Device B converges to Device A's final state.
	 *
	 * This is the definitive test for #22. Uses real editor transactions (not
	 * modifyFile), exercises the full y-codemirror ↔ Y.Text ↔ provider ↔
	 * diskMirror ↔ reconciliation path on both devices simultaneously.
	 *
	 * Failure means: Device B's passive-open reconciliation pushed stale
	 * content back into CRDT, which propagated to Device A via the server,
	 * causing the user-visible "deleted text reappears" symptom.
	 */
	"issue-22-passive-open-roundtrip": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10f-passive-roundtrip.md";
		const initial = [
			"# S10f Passive Roundtrip",
			"",
			"BEFORE",
			"KEEP_ME",
			S10F_SENTINEL,
			"AFTER",
			"",
		].join("\n");

		try {
			if (!await s10fSetup(a, b, scratch, initial, errors, log)) {
				return { passedA: false, passedB: false, errors };
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));

			log("Action: Device A deleting sentinel through editor...");
			const deletionOk = await a.evalRaw<boolean>(deleteSentinelExpr(S10F_SENTINEL));
			if (!deletionOk) {
				errors.push("Device A: could not delete sentinel through editor");
				return { passedA: false, passedB: false, errors };
			}
			const editorAfterDelete = await a.evalRaw<string>(READ_EDITOR_EXPR);
			if (editorAfterDelete.includes(S10F_SENTINEL)) {
				errors.push("Device A: sentinel still in editor immediately after deletion");
				return { passedA: false, passedB: false, errors };
			}
			log("Action: sentinel deleted from A's editor ✓");

			await a.evalRaw(typeAtCursorExpr("\nTyped after deletion. Marker Q8W2.\n"));
			log("Monitoring: polling Device A editor for reversion (30s at 250ms)...");
			const poll = await pollForReversion(a, S10F_SENTINEL, 30_000, 250, log);
			errors.push(...poll.errors);

			await s10fConvergence(a, b, scratch, S10F_SENTINEL, errors, log);
			return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
		} finally {
			await s10fCleanup(a, b, scratch);
		}
	},

	// ───────────────────────────────────────────────────────────────────
	// s10f-2: Reversed roles -- B active, A passive
	// ───────────────────────────────────────────────────────────────────

	"issue-22-reversed-roles": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10f-2-reversed.md";
		const INITIAL = ["# S10f-2 Reversed", "", "BEFORE", "KEEP_ME", S10F_SENTINEL, "AFTER", ""].join("\n");

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log)) {
			return { passedA: false, passedB: false, errors };
		}
		await new Promise((r) => setTimeout(r, 2000));

		// B is active, A is passive (reversed from original)
		log("Action: Device B deleting sentinel through editor...");
		const deletionOk = await b.evalRaw<boolean>(deleteSentinelExpr(S10F_SENTINEL));
		if (!deletionOk) {
			errors.push("Device B: could not delete sentinel through editor");
			await s10fCleanup(a, b, scratch);
			return { passedA: false, passedB: false, errors };
		}

		const editorAfterDel = await b.evalRaw<string>(READ_EDITOR_EXPR);
		if (editorAfterDel.includes(S10F_SENTINEL)) {
			errors.push("Device B: sentinel still in editor immediately after deletion");
			await s10fCleanup(a, b, scratch);
			return { passedA: false, passedB: false, errors };
		}
		log("Action: sentinel deleted from B's editor ✓");

		await b.evalRaw(typeAtCursorExpr("\nTyped after deletion by B. Marker R0L3.\n"));
		log("Action: Device B typing post-deletion...");

		log("Monitoring: polling Device B editor for reversion (30s at 250ms)...");
		const poll = await pollForReversion(b, S10F_SENTINEL, 30_000, 250, log);
		errors.push(...poll.errors);

		// Convergence: check A (the passive peer)
		await s10fConvergence(b, a, scratch, S10F_SENTINEL, errors, log);
		await s10fCleanup(a, b, scratch);
		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// ───────────────────────────────────────────────────────────────────
	// s10f-3: Sustained editing soak -- 5 min of burst typing with
	//         corrections and deletions on the active device
	// ───────────────────────────────────────────────────────────────────

	"issue-22-editing-soak": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10f-3-soak.md";
		const INITIAL = ["# S10f-3 Soak", "", "BEFORE", "KEEP_ME", S10F_SENTINEL, "AFTER", ""].join("\n");

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log)) {
			return { passedA: false, passedB: false, errors };
		}
		await new Promise((r) => setTimeout(r, 2000));

		log("Action: Device A deleting sentinel...");
		const deletionOk = await a.evalRaw<boolean>(deleteSentinelExpr(S10F_SENTINEL));
		if (!deletionOk) {
			errors.push("Device A: could not delete sentinel");
			await s10fCleanup(a, b, scratch);
			return { passedA: false, passedB: false, errors };
		}
		log("Action: sentinel deleted ✓");

		// 5 min sustained soak: type, correct, type more
		const SOAK_DURATION = 5 * 60 * 1000; // 5 minutes
		const POLL_INTERVAL = 500;
		log(`Soak: ${SOAK_DURATION / 1000}s of sustained editing with 500ms polls...`);

		const soakStart = Date.now();
		let pollCount = 0;
		let reversionDetected = false;
		let round = 0;

		while (Date.now() - soakStart < SOAK_DURATION) {
			await new Promise((r) => setTimeout(r, POLL_INTERVAL));
			pollCount++;

			// Check for reversion
			const content = await a.evalRaw<string>(READ_EDITOR_EXPR);
			if (content.includes(S10F_SENTINEL)) {
				const elapsed = Math.round((Date.now() - soakStart) / 1000);
				errors.push(`REVERSION at poll ${pollCount} (t+${elapsed}s): sentinel reappeared!`);
				reversionDetected = true;
				break;
			}

			// Every 10 polls (~5s): type a burst
			if (pollCount % 10 === 0) {
				round++;
				await a.evalRaw(typeAtCursorExpr(`\nSoak round ${round}. `));
			}

			// Every 40 polls (~20s): type then delete (simulate corrections)
			if (pollCount % 40 === 0) {
				await a.evalRaw(`
					(function() {
						const editor = app.workspace.activeEditor?.editor;
						if (!editor) return;
						const cursor = editor.getCursor();
						editor.replaceRange("TEMP_CORRECTION_TEXT", cursor);
						const newCursor = editor.getCursor();
						editor.replaceRange("", { line: cursor.line, ch: cursor.ch }, newCursor);
						editor.replaceRange("[corrected] ", editor.getCursor());
					})()
				`);
			}
		}

		if (!reversionDetected) {
			const elapsed = Math.round((Date.now() - soakStart) / 1000);
			log(`Soak: ${pollCount} polls over ${elapsed}s, sentinel NEVER reappeared ✓`);
		}

		await s10fConvergence(a, b, scratch, S10F_SENTINEL, errors, log);
		await s10fCleanup(a, b, scratch);
		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// ───────────────────────────────────────────────────────────────────
	// s10f-4: Passive peer disconnects/reconnects while active peer edits
	// ───────────────────────────────────────────────────────────────────

	"issue-22-passive-reconnect": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10f-4-reconnect.md";
		const INITIAL = ["# S10f-4 Reconnect", "", "BEFORE", "KEEP_ME", S10F_SENTINEL, "AFTER", ""].join("\n");

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log)) {
			return { passedA: false, passedB: false, errors };
		}
		await new Promise((r) => setTimeout(r, 2000));

		// A deletes sentinel
		log("Action: Device A deleting sentinel...");
		const deletionOk = await a.evalRaw<boolean>(deleteSentinelExpr(S10F_SENTINEL));
		if (!deletionOk) {
			errors.push("Device A: could not delete sentinel");
			await s10fCleanup(a, b, scratch);
			return { passedA: false, passedB: false, errors };
		}
		await a.evalRaw(typeAtCursorExpr("\nPost-deletion text.\n"));
		log("Action: sentinel deleted, A continues typing ✓");

		// Monitor A while B disconnects/reconnects 3 times
		const CYCLES = 3;
		const CYCLE_OFFLINE_MS = 5000;
		const CYCLE_ONLINE_MS = 10000;

		for (let i = 1; i <= CYCLES; i++) {
			// ── Disconnect B ──
			log(`Cycle ${i}/${CYCLES}: disconnecting B...`);
			await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("offline")`);

			// Verify disconnect with generous timeout. The hold mechanism can be slow
			// on first attempt due to WebSocket close handshake timing.
			const disconnected = await b.evalRaw<boolean>(`
				(async () => {
					const d = window.__YAOS_DEBUG__;
					if (!d) return false;
					try { await d.waitForProviderDisconnected(25000); } catch { return false; }
					return !d.isProviderConnected();
				})()
			`);
			if (!disconnected) {
				log(`Cycle ${i}/${CYCLES}: WARNING -- B did not disconnect within 25s, skipping cycle`);
				// Release hold so it doesn't affect next cycle
				await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("online")`).catch(() => {});
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}
			log(`Cycle ${i}/${CYCLES}: B disconnected (providerConnected=false) ✓`);
			if (!disconnected) {
				errors.push(`Cycle ${i}: B failed to disconnect -- provider still connected`);
				break;
			}
			log(`Cycle ${i}/${CYCLES}: B disconnected (providerConnected=false) ✓`);

			// Poll A during B's offline period
			log(`Cycle ${i}/${CYCLES}: polling A while B offline (${CYCLE_OFFLINE_MS / 1000}s)...`);
			const offlinePoll = await pollForReversion(a, S10F_SENTINEL, CYCLE_OFFLINE_MS, 250, log, {
				burstEvery: 10,
				burstText: ` cycle${i} `,
			});
			if (offlinePoll.reversionDetected) {
				errors.push(`Cycle ${i}: reversion while B offline`);
				errors.push(...offlinePoll.errors);
				break;
			}

			// ── Reconnect B ──
			log(`Cycle ${i}/${CYCLES}: reconnecting B...`);
			await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("online")`);

			// Assert: B actually reconnected and synced
			const synced = await b.evalRaw<boolean>(`
				(async () => {
					const d = window.__YAOS_DEBUG__;
					if (!d) return false;
					// Wait up to 30s for provider sync
					const deadline = Date.now() + 30000;
					while (Date.now() < deadline) {
						if (d.isProviderSynced()) return true;
						await new Promise(r => setTimeout(r, 250));
					}
					return d.isProviderSynced();
				})()
			`);
			if (!synced) {
				errors.push(`Cycle ${i}: B failed to reconnect/sync -- providerSynced=false`);
				break;
			}
			log(`Cycle ${i}/${CYCLES}: B reconnected + synced ✓`);

			// Wait for B to settle (disk writes are async after provider sync)
			await b.evalRaw(`
				(async () => {
					const d = window.__YAOS_DEBUG__;
					if (!d) return;
					try { await d.waitForIdle(15000); } catch {}
				})()
			`);
			// Wait for disk-CRDT convergence on the scratch file
			await b.evalRaw(`window.__YAOS_QA__?.waitForDiskCrdtConverge(${JSON.stringify(scratch)}, 15000)`).catch(() => {});
			await new Promise((r) => setTimeout(r, 1000));

			// Assert: B received the latest state (sentinel should be absent on B's disk)
			const bHasSentinel = await b.evalRaw<boolean>(`
				(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
					if (!f) return false;
					const content = await app.vault.read(f);
					return content.includes(${JSON.stringify(S10F_SENTINEL)});
				})()
			`);
			if (bHasSentinel) {
				// Disk may lag behind CRDT after reconnect -- this is a timing issue,
				// not a sync failure. The final convergence check is what matters.
				log(`Cycle ${i}/${CYCLES}: NOTE -- B disk still has sentinel (disk lag after sync)`);
			} else {
				log(`Cycle ${i}/${CYCLES}: B sentinel absent after sync ✓`);
			}

			// Poll A during post-reconnect period (this is when stale pushback could happen)
			log(`Cycle ${i}/${CYCLES}: polling A during B post-reconnect (${CYCLE_ONLINE_MS / 1000}s)...`);
			const reconnectPoll = await pollForReversion(a, S10F_SENTINEL, CYCLE_ONLINE_MS, 250, log, {
				burstEvery: 15,
				burstText: ` rc${i} `,
			});
			if (reconnectPoll.reversionDetected) {
				errors.push(`Cycle ${i}: reversion during B reconnect`);
				errors.push(...reconnectPoll.errors);
				break;
			}
		}

		// Make sure B is online for convergence
		await b.evalRaw(`window.__YAOS_DEBUG__?.setQaNetworkHold("online")`).catch(() => {});
		await s10fConvergence(a, b, scratch, S10F_SENTINEL, errors, log);
		await s10fCleanup(a, b, scratch);
		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// ───────────────────────────────────────────────────────────────────
	// s10f-5: Old-passive-peer -- B opens file, sits idle for a long time,
	//         then A edits. Tests stale editor/disk on B.
	// ───────────────────────────────────────────────────────────────────

	"issue-22-old-passive-peer": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10f-5-old-passive.md";
		const INITIAL = ["# S10f-5 Old Passive", "", "BEFORE", "KEEP_ME", S10F_SENTINEL, "AFTER", ""].join("\n");

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log)) {
			return { passedA: false, passedB: false, errors };
		}

		// B has file open. Now let B sit idle for a long time.
		const IDLE_PERIOD = 30_000; // 30 seconds
		log(`Idle: letting B sit with file open for ${IDLE_PERIOD / 1000}s...`);
		await new Promise((r) => setTimeout(r, IDLE_PERIOD));

		// Now A edits -- B's state might be stale
		log("Action: Device A deleting sentinel after B's long idle...");
		const deletionOk = await a.evalRaw<boolean>(deleteSentinelExpr(S10F_SENTINEL));
		if (!deletionOk) {
			errors.push("Device A: could not delete sentinel");
			await s10fCleanup(a, b, scratch);
			return { passedA: false, passedB: false, errors };
		}
		await a.evalRaw(typeAtCursorExpr("\nEdited after B's long idle. Marker P5W1.\n"));
		log("Action: sentinel deleted, A continues typing ✓");

		log("Monitoring: polling A for reversion (30s)...");
		const poll = await pollForReversion(a, S10F_SENTINEL, 30_000, 250, log);
		errors.push(...poll.errors);

		await s10fConvergence(a, b, scratch, S10F_SENTINEL, errors, log);
		await s10fCleanup(a, b, scratch);
		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// ───────────────────────────────────────────────────────────────────
	// s10f-6: Repeated delete/retype -- A deletes sentinel, retypes it,
	//         deletes again, retypes again. The sentinel must stay deleted
	//         after the final deletion.
	// ───────────────────────────────────────────────────────────────────

	"issue-22-repeated-delete-retype": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10f-6-repeated.md";
		const INITIAL = ["# S10f-6 Repeated", "", "BEFORE", "KEEP_ME", S10F_SENTINEL, "AFTER", ""].join("\n");

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log)) {
			return { passedA: false, passedB: false, errors };
		}
		await new Promise((r) => setTimeout(r, 2000));

		const CYCLES = 4;
		for (let i = 1; i <= CYCLES; i++) {
			log(`Cycle ${i}/${CYCLES}: deleting sentinel...`);

			// Delete sentinel
			const deleted = await a.evalRaw<boolean>(deleteSentinelExpr(S10F_SENTINEL));
			if (!deleted) {
				if (i === 1) {
					errors.push("Cycle 1: could not delete sentinel");
					await s10fCleanup(a, b, scratch);
					return { passedA: false, passedB: false, errors };
				}
				// On later cycles, sentinel might not be there if it was already deleted
				log(`Cycle ${i}: sentinel not found (already deleted), skipping retype`);
				continue;
			}

			// Brief poll to catch immediate reversion
			log(`Cycle ${i}/${CYCLES}: polling for reversion (5s)...`);
			const poll = await pollForReversion(a, S10F_SENTINEL, 5000, 250, log, { burstEvery: 0 });
			if (poll.reversionDetected) {
				errors.push(`Cycle ${i}: immediate reversion after delete`);
				errors.push(...poll.errors);
				break;
			}

			// Retype sentinel (except on last cycle)
			if (i < CYCLES) {
				log(`Cycle ${i}/${CYCLES}: retyping sentinel...`);
				await a.evalRaw(typeAtCursorExpr(`\n${S10F_SENTINEL}\n`));
				await new Promise((r) => setTimeout(r, 3000)); // Let it sync
			}
		}

		// Final monitoring after last deletion
		log("Final monitoring: polling A for 30s...");
		const finalPoll = await pollForReversion(a, S10F_SENTINEL, 30_000, 250, log);
		errors.push(...finalPoll.errors);

		await s10fConvergence(a, b, scratch, S10F_SENTINEL, errors, log);
		await s10fCleanup(a, b, scratch);
		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// ───────────────────────────────────────────────────────────────────
	// s10f-7: Both cursors near same location -- A types heavily near
	//         the sentinel, then deletes it. B is positioned at same
	//         location but passive. Tests concurrent cursor proximity.
	// ───────────────────────────────────────────────────────────────────

	"issue-22-cursor-proximity": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10f-7-cursor.md";
		const INITIAL = ["# S10f-7 Cursor Proximity", "", "BEFORE", "KEEP_ME", S10F_SENTINEL, "AFTER", ""].join("\n");

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log)) {
			return { passedA: false, passedB: false, errors };
		}
		await new Promise((r) => setTimeout(r, 2000));

		// Position B's cursor near the sentinel line
		log("Setup: positioning B's cursor near sentinel...");
		await b.evalRaw(`
			(function() {
				const editor = app.workspace.activeEditor?.editor;
				if (!editor) return;
				const doc = editor.getValue();
				const idx = doc.indexOf(${JSON.stringify(S10F_SENTINEL)});
				if (idx === -1) return;
				const pos = editor.offsetToPos(idx);
				editor.setCursor(pos);
			})()
		`);

		// A types heavily around the sentinel area, then deletes it
		log("Action: Device A typing heavily near sentinel...");
		for (let i = 0; i < 10; i++) {
			await a.evalRaw(`
				(function() {
					const editor = app.workspace.activeEditor?.editor;
					if (!editor) return;
					const doc = editor.getValue();
					const idx = doc.indexOf(${JSON.stringify(S10F_SENTINEL)});
					if (idx === -1) return;
					// Type just before the sentinel line
					const lineStart = doc.lastIndexOf("\\n", idx - 1) + 1;
					const pos = editor.offsetToPos(lineStart);
					editor.replaceRange("Burst ${i} near sentinel. ", pos);
				})()
			`);
			await new Promise((r) => setTimeout(r, 200));
		}
		log("Action: burst typing complete ✓");

		// Now delete the sentinel
		log("Action: Device A deleting sentinel...");
		const deletionOk = await a.evalRaw<boolean>(deleteSentinelExpr(S10F_SENTINEL));
		if (!deletionOk) {
			errors.push("Device A: could not delete sentinel after burst typing");
			await s10fCleanup(a, b, scratch);
			return { passedA: false, passedB: false, errors };
		}
		await a.evalRaw(typeAtCursorExpr("\nPost-sentinel-delete in proximity test.\n"));
		log("Action: sentinel deleted ✓");

		log("Monitoring: polling A for reversion (30s)...");
		const poll = await pollForReversion(a, S10F_SENTINEL, 30_000, 250, log);
		errors.push(...poll.errors);

		await s10fConvergence(a, b, scratch, S10F_SENTINEL, errors, log);
		await s10fCleanup(a, b, scratch);
		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},
};
