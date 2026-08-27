import type { TwoDeviceScenarios } from "./shared";
import { disableYaos, enableYaosAndWait, s10fCleanup, s10fSetup, typeAtCursorExpr } from "./shared";

export const issue22ReconnectScenarios: TwoDeviceScenarios = {
	// ───────────────────────────────────────────────────────────────────
	// ───────────────────────────────────────────────────────────────────
	// s10e: Real plugin disable/re-enable.
	//
	// Two sub-scenarios covering the "I turned YAOS off, edited, turned
	// it back on" reporter path (Issue #22-B):
	//
	//   s10e-1 (issue-22-disable-reenable-local-only):
	//     B edits while YAOS is disabled. A makes NO changes while B is
	//     disabled. On re-enable, disk should cleanly win: B's edit goes
	//     into CRDT/server, no conflict artifact needed.
	//     INVARIANT: local disk changed, remote unchanged → disk wins.
	//     STATUS: PASSES via the clean-disable baseline path.
	//             teardownSync persists the baseline before kill; reconcile
	//             sees crdt-at-baseline → import-disk-to-crdt.
	//
	//   s10e-2 (issue-22-disable-reenable-concurrent):
	//     B edits while YAOS is disabled. A ALSO edits through YAOS while
	//     B is disabled. On re-enable, both sides changed from baseline →
	//     conflict preserved. Neither edit silently lost.
	//     INVARIANT: both changed from baseline → preserve-conflict.
	//
	// COLD-RELAUNCH VARIANT (missing-baseline):
	//     If the process is killed before teardownSync runs (e.g. iOS
	//     suspend/kill), the baseline is not persisted. The
	//     missing-baseline path now uses diskMtime evidence:
	//     if diskMtime > lastDiskIndexPersistedAt → disk wins.
	//     Repro: qa/scripts/repro-missing-baseline-kill.ts
	//     Backlog: docs/BACKLOG.md QA-03
	// ───────────────────────────────────────────────────────────────────

	// s10e-1: B edits while YAOS disabled, A makes NO changes.
	// Expected: B's disk edit cleanly wins (import-disk-to-crdt, no artifact).
	// Status: PASSES. The baseline is persisted by teardownSync on clean disable,
	// so reconcile sees crdt-at-baseline → import-disk-to-crdt. No artifact needed.
	"issue-22-disable-reenable-local-only": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10e-local-only.md";
		const INITIAL = "# S10e Local-Only\n\nOriginal content.\n";
		const EDIT_WHILE_DISABLED = "\nEDITED WHILE YAOS WAS DISABLED. Marker D1S4.\n";
		const DISABLE_MARKER = "Marker D1S4";

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log, { openOnBoth: false })) {
			return { passedA: false, passedB: false, errors };
		}

		const preDisableHash = await b.evalRaw<string | null>(
			`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`,
		);
		log(`Pre-disable B disk hash: ${preDisableHash?.slice(0, 12)}`);

		// ── Disable YAOS on B ────────────────────────────────────────────

		log("Action: disabling YAOS plugin on Device B...");
		const yaosUnloaded = await disableYaos(b);
		if (!yaosUnloaded) {
			errors.push("B: YAOS plugin instance still present after disablePlugin");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS unloaded on B ✓");

		// ── A does NOT edit (this is the local-only scenario) ────────────

		log("Note: A makes no changes while B has YAOS disabled (local-only scenario).");
		await new Promise((r) => setTimeout(r, 2000)); // small idle window

		// ── B edits while YAOS is disabled ───────────────────────────────

		log("Action: editing file on B while YAOS is disabled...");
		await b.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (!f) throw new Error("File not found on B after disable");
				const content = await app.vault.read(f);
				await app.vault.modify(f, content + ${JSON.stringify(EDIT_WHILE_DISABLED)});
			})()
		`);

		const editedContent = await b.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);
		if (!editedContent.includes(DISABLE_MARKER)) {
			errors.push("B: edit did not land on disk while YAOS was disabled");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: edit landed on B disk while YAOS disabled ✓");

		// ── Re-enable YAOS on B ──────────────────────────────────────────

		log("Action: re-enabling YAOS plugin on Device B...");
		const qaReady = await enableYaosAndWait(b);
		if (!qaReady) {
			errors.push("B: YAOS did not re-initialize within 30s after enablePlugin");
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS re-initialized on B ✓");

		const startupOk = await b.evalRaw<boolean>(`
			(async () => {
				const d = window.__YAOS_DEBUG__;
				if (!d) return false;
				try {
					await d.waitForIdle(30000);
					return d.isLocalReady() && d.isProviderSynced() && d.isReconciled();
				} catch { return false; }
			})()
		`);
		if (!startupOk) {
			errors.push("B: startup reconciliation did not complete within 30s");
		} else {
			log("Action: B startup reconciliation complete ✓");
		}

		await new Promise((r) => setTimeout(r, 5000));

		// ── Assert: B's disk edit wins main file (no conflict artifact) ──

		const finalContentB = await b.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);

		if (!finalContentB.includes(DISABLE_MARKER)) {
			errors.push(
				"FAIL: B's disk edit was overwritten on re-enable. " +
				"Expected local-only disk edit to win cleanly (import-disk-to-crdt).",
			);
		} else {
			log("Assert: B's disk edit survived re-enable in main file ✓");
		}

		// Assert: no conflict artifact created (disk-only change needs no artifact)
		const scratchBaseName = scratch.split("/").pop()?.replace(".md", "") ?? "";
		const conflictPath = await b.evalRaw<string | null>(`
			(function() {
				const baseName = ${JSON.stringify(scratchBaseName)};
				const vaultFiles = app.vault.getFiles().map(f => f.path);
				return vaultFiles.find(p =>
					p.includes(baseName) && p.includes("conflict") && p !== ${JSON.stringify(scratch)}
				) ?? null;
			})()
		`);
		if (conflictPath) {
			errors.push(
				`FAIL: conflict artifact was created for a local-only change (no server edit). ` +
				`Artifact: ${conflictPath}.`,
			);
			// Cleanup artifact
			await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictPath)})`).catch(() => {});
			await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictPath)})`).catch(() => {});
		} else {
			log("Assert: no spurious conflict artifact created ✓");
		}

		// Assert: B's edit reached A (proves disk→CRDT import worked)
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));
		const contentA = await a.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);
		if (!contentA.includes(DISABLE_MARKER)) {
			errors.push("FAIL: B's disk edit did not propagate to A after re-enable");
		} else {
			log("Assert: B's disk edit propagated to A ✓");
		}

		await a.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// s10e-2: B edits while YAOS disabled while A edits through YAOS.
	// Contract: both-changed resolves with B's disk edit at the original path
	// and preserves A's CRDT edit in a synchronizing Markdown conflict artifact.
	"issue-22-disable-reenable-concurrent": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10e-disable-reenable.md";
		const INITIAL = "# S10e Disable Re-enable\n\nOriginal content from both devices.\n";
		const EDIT_WHILE_DISABLED = "\nEDITED WHILE YAOS WAS DISABLED. Marker D1S4.\n";
		const DISABLE_MARKER = "Marker D1S4";

		// ── Setup: create file, sync to both ─────────────────────────────

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log, { openOnBoth: false })) {
			return { passedA: false, passedB: false, errors };
		}

		// Record pre-disable content hash on B
		const preDisableHash = await b.evalRaw<string | null>(
			`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`,
		);
		log(`Pre-disable B disk hash: ${preDisableHash?.slice(0, 12)}`);

		// ── Disable YAOS on B ────────────────────────────────────────────

		log("Action: disabling YAOS plugin on Device B...");
		const yaosUnloaded = await disableYaos(b);
		if (!yaosUnloaded) {
			errors.push("B: YAOS plugin instance still present after disablePlugin");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS unloaded on B (plugin instance gone) ✓");

		// ── Assert: __YAOS_DEBUG__ removed on unload ──────────────────────
		// Plugin-owned debug global must be deleted on unload to prevent stale
		// API references from confusing test harnesses.
		const debugGoneAfterUnload = await b.evalRaw<boolean>(
			`typeof window.__YAOS_DEBUG__ === "undefined"`,
		);
		if (!debugGoneAfterUnload) {
			errors.push(
				"B: window.__YAOS_DEBUG__ still exists after YAOS unload. " +
				"Stale global not cleaned up in onunload().",
			);
		} else {
			log("Assert: __YAOS_DEBUG__ removed after unload ✓");
		}

		// ── Edit on B while YAOS is disabled ─────────────────────────────
		// Use raw Obsidian vault API -- no YAOS involved

		log("Action: editing file on B while YAOS is disabled...");
		await b.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (!f) throw new Error("File not found on B after disable");
				const content = await app.vault.read(f);
				await app.vault.modify(f, content + ${JSON.stringify(EDIT_WHILE_DISABLED)});
			})()
		`);

		// Verify the edit is on disk
		const editedContent = await b.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);
		if (!editedContent.includes(DISABLE_MARKER)) {
			errors.push("B: edit did not land on disk while YAOS was disabled");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: edit landed on B disk while YAOS disabled ✓");

		// Meanwhile, A continues editing through YAOS (A is still online)
		log("Action: A continues editing while B has YAOS disabled...");
		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await a.evalRaw(typeAtCursorExpr("\nEdited on A while B was disabled. Marker A7E2.\n"));
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		log("Action: A edit synced to server ✓");

		// ── Re-enable YAOS on B ──────────────────────────────────────────

		log("Action: re-enabling YAOS plugin on Device B...");
		const qaReady = await enableYaosAndWait(b);
		if (!qaReady) {
			errors.push("B: YAOS did not re-initialize within 30s after enablePlugin");
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS re-initialized on B (APIs available) ✓");

		// Assert: fresh __YAOS_DEBUG__ installed after re-enable
		const debugFreshAfterReload = await b.evalRaw<boolean>(
			`typeof window.__YAOS_DEBUG__ !== "undefined" && typeof window.__YAOS_DEBUG__?.isLocalReady === "function"`,
		);
		if (!debugFreshAfterReload) {
			errors.push(
				"B: window.__YAOS_DEBUG__ missing or malformed after YAOS re-enable.",
			);
		} else {
			log("Assert: fresh __YAOS_DEBUG__ installed after re-enable ✓");
		}

		// Wait for full startup: local ready + provider synced + reconciled
		log("Action: waiting for B startup reconciliation...");
		const startupOk = await b.evalRaw<boolean>(`
			(async () => {
				const d = window.__YAOS_DEBUG__;
				if (!d) return false;
				try {
					await d.waitForIdle(30000);
					return d.isLocalReady() && d.isProviderSynced() && d.isReconciled();
				} catch { return false; }
			})()
		`);
		if (!startupOk) {
			errors.push("B: startup reconciliation did not complete within 30s");
			// Still check content anyway
		} else {
			log("Action: B startup reconciliation complete ✓");
		}

		// Extra settle time for disk writes
		await new Promise((r) => setTimeout(r, 5000));

		// ── Contract audit: disk wins; CRDT survives in the artifact ──────

		log("Preservation audit: checking B vault for conflict artifact...");
		const scratchBaseName = scratch.split("/").pop()?.replace(".md", "") ?? "";
		const audit = await b.evalRaw<{
			mainHasDisable: boolean;
			mainHasA: boolean;
			conflictPath: string | null;
			conflictHasDisable: boolean;
			conflictHasA: boolean;
		}>(`
			(async () => {
				const vaultFiles = app.vault.getFiles().map(f => f.path);
				const baseName = ${JSON.stringify(scratchBaseName)};
				const disableMarker = ${JSON.stringify(DISABLE_MARKER)};

				const mainFile = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				const mainContent = mainFile ? await app.vault.read(mainFile) : "";
				const mainHasDisable = mainContent.includes(disableMarker);
				const mainHasA = mainContent.includes("Marker A7E2");

				const conflictPath = vaultFiles.find(p =>
					p.includes(baseName) && p.includes("conflict") && p !== ${JSON.stringify(scratch)}
				) ?? null;
				const conflictFile = conflictPath ? app.vault.getAbstractFileByPath(conflictPath) : null;
				const conflictContent = conflictFile ? await app.vault.read(conflictFile) : "";
				const conflictHasDisable = conflictContent.includes(disableMarker);
				const conflictHasA = conflictContent.includes("Marker A7E2");

				return { mainHasDisable, mainHasA, conflictPath, conflictHasDisable, conflictHasA };
			})()
		`);

		if (!audit.mainHasDisable) {
			errors.push("B: disabled-time disk edit D1S4 did not win the original path");
		} else {
			log("Assert: B's disabled-time disk edit won the original path ✓");
		}
		if (audit.mainHasA) {
			errors.push("B: original path contains A7E2; remote CRDT edit belongs only in the conflict artifact");
		}
		if (!audit.conflictHasA) {
			errors.push("B: conflict artifact does not preserve A's remote edit A7E2");
		} else {
			log("Assert: A's remote edit is preserved in the conflict artifact ✓");
		}
		if (audit.conflictHasDisable) {
			errors.push("B: conflict artifact contains the disk-winning edit instead of only the preserved remote side");
		}

		if (!audit.conflictPath) {
			errors.push(
				"MISSING CONFLICT ARTIFACT: Concurrent conflict (both sides changed) should " +
				"produce a conflict artifact. None found.",
			);
		}

		// ── Assert: A and B converged on same main file ──────────────────

		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));

		const hashA = await a.evalRaw<string | null>(
			`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`,
		);
		const hashB = await b.evalRaw<string | null>(
			`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`,
		);
		if (hashA !== hashB) {
			errors.push(`Main file hashes diverged: A=${hashA?.slice(0, 12)}, B=${hashB?.slice(0, 12)}`);
		} else {
			log("Final: A == B main-file hash ✓");
		}

		// ── Assert: conflict artifact synced to A ────────────────────────

		if (audit.conflictPath) {
			log(`Conflict sync: waiting for "${audit.conflictPath}" to reach A (up to 30s)...`);
			const artifactContentOnA = await a.evalRaw<string | null>(`
				(async () => {
					const path = ${JSON.stringify(audit.conflictPath)};
					const deadline = Date.now() + 30000;
					while (Date.now() < deadline) {
						const file = app.vault.getFileByPath(path);
						if (file) return await app.vault.read(file);
						await new Promise(r => setTimeout(r, 500));
					}
					return null;
				})()
			`);
			if (artifactContentOnA === null) {
				errors.push("Conflict artifact did not reach A within 30s");
			} else if (!artifactContentOnA.includes("Marker A7E2")) {
				errors.push("Conflict artifact on A does not contain the preserved remote edit A7E2");
			} else {
				log("Conflict sync: artifact reached A with preserved remote content ✓");
			}
		}

		// ── Cleanup ──────────────────────────────────────────────────────

		// Delete conflict artifact from both devices if present
		if (audit.conflictPath) {
			await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(audit.conflictPath)})`).catch(() => {});
			await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(audit.conflictPath)})`).catch(() => {});
		}
		await a.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// s10e-7: Baseline must advance after an edit while YAOS is enabled.
	//
	// Flow:
	//   1. Create file, sync to both. Baseline = INITIAL.
	//   2. B edits the file WHILE YAOS IS RUNNING (normal edit through vault API).
	//      YAOS observes it → diskMirror flushes to A → setDiskWriteCallback fires
	//      → baseline advances to AFTER_ENABLED_EDIT.
	//   3. Wait for the edit to propagate and disk index to be saved (waitForIdle).
	//   4. B disables YAOS (teardownSync → flushAllPendingWrites → saveDiskIndex).
	//   5. B edits while disabled. Disk = AFTER_ENABLED_EDIT + DISABLED_EDIT.
	//   6. A does NOT edit.
	//   7. B re-enables. Startup reconcile runs.
	//      baseline = AFTER_ENABLED_EDIT (not INITIAL)
	//      disk     = AFTER_ENABLED_EDIT + DISABLED_EDIT
	//      crdt     = AFTER_ENABLED_EDIT  (A has it, unchanged by A)
	//      → crdt == baseline, disk != baseline → import-disk-to-crdt (disk wins)
	//      → NO conflict artifact
	//
	// This directly proves that contentBaselineHash advances during normal
	// operation, not just from initial setup. Without this, a long-lived YAOS
	// session could have a stale baseline from startup, causing spurious conflicts
	// on every later disable/re-enable.
	"issue-22-disable-reenable-baseline-advances": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10e-7-baseline-advances.md";
		const INITIAL = "# S10e-7 Baseline Advances\n\nOriginal content.\n";
		const ENABLED_EDIT_MARKER = "Marker E7-ENABLED";
		const DISABLED_EDIT_MARKER = "Marker E7-DISABLED";

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log, { openOnBoth: false })) {
			return { passedA: false, passedB: false, errors };
		}

		// ── Step 2: B edits while YAOS is running ────────────────────────
		// This goes through the normal vault modify path; YAOS observes the
		// disk change, seeded/imported into CRDT, setDiskWriteCallback fires.

		log("Action: B edits file while YAOS is running (baseline must advance)...");
		const enabledEditContent = `\n${ENABLED_EDIT_MARKER}. Edit through running YAOS.\n`;
		await b.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (!f) throw new Error("File not found on B");
				const content = await app.vault.read(f);
				await app.vault.modify(f, content + ${JSON.stringify(enabledEditContent)});
			})()
		`);

		// Wait for YAOS to observe and process this edit (disk→CRDT pipeline)
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await new Promise((r) => setTimeout(r, 2000));

		// Verify the edit is visible on B
		const afterEnabledEdit = await b.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);
		if (!afterEnabledEdit.includes(ENABLED_EDIT_MARKER)) {
			errors.push("B: enabled-time edit did not land on disk");
			await s10fCleanup(a, b, scratch);
			return { passedA: false, passedB: false, errors };
		}
		log("Action: B enabled-time edit confirmed on disk ✓");

		// Wait for the edit to propagate to A (proves CRDT also has it)
		const editOnA = await a.evalRaw<boolean>(`
			(async () => {
				const deadline = Date.now() + 15000;
				while (Date.now() < deadline) {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
					const content = f ? await app.vault.read(f) : "";
					if (content.includes(${JSON.stringify(ENABLED_EDIT_MARKER)})) return true;
					await new Promise(r => setTimeout(r, 500));
				}
				return false;
			})()
		`);
		if (!editOnA) {
			errors.push("A: B's enabled-time edit never arrived on A (CRDT may not have it)");
		} else {
			log("Action: B's enabled-time edit propagated to A (CRDT has it) ✓");
		}

		// ── Step 4: Disable YAOS on B ─────────────────────────────────────
		// teardownSync() will: flushAllPendingWrites() → saveDiskIndex()
		// The saved index should now have contentHash = SHA-256(INITIAL + ENABLED_EDIT)

		log("Action: disabling YAOS on B (baseline should be post-enabled-edit)...");
		const yaosUnloaded = await disableYaos(b);
		if (!yaosUnloaded) {
			errors.push("B: YAOS still present after disablePlugin");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS unloaded ✓");

		// Assert __YAOS_DEBUG__ cleaned up
		const debugGone = await b.evalRaw<boolean>(`typeof window.__YAOS_DEBUG__ === "undefined"`);
		if (!debugGone) {
			errors.push("B: __YAOS_DEBUG__ still exists after unload");
		} else {
			log("Assert: __YAOS_DEBUG__ removed ✓");
		}

		// ── Step 5: B edits while disabled ───────────────────────────────
		// A does NOT edit. So CRDT = post-enabled-edit state.
		// With correct baseline: disk-only change → import-disk-to-crdt, no artifact.

		log("Action: B edits while disabled (A unchanged)...");
		const disabledEditContent = `\n${DISABLED_EDIT_MARKER}. Edit while disabled.\n`;
		await b.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (!f) throw new Error("File not found on B");
				const content = await app.vault.read(f);
				await app.vault.modify(f, content + ${JSON.stringify(disabledEditContent)});
			})()
		`);

		const editedContent = await b.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);
		if (!editedContent.includes(DISABLED_EDIT_MARKER)) {
			errors.push("B: disabled-time edit did not land on disk");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: disabled-time edit on disk ✓");

		// ── Step 7: Re-enable YAOS on B ───────────────────────────────────

		log("Action: re-enabling YAOS on B...");
		const qaReady = await enableYaosAndWait(b);
		if (!qaReady) {
			errors.push("B: YAOS did not re-initialize within 30s");
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS re-initialized ✓");

		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));

		// ── Assertions ───────────────────────────────────────────────────

		// The disabled-time edit should win the main file (disk-only change
		// with correct baseline → import-disk-to-crdt, no conflict artifact).
		const finalContentB = await b.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);

		if (!finalContentB.includes(DISABLED_EDIT_MARKER)) {
			errors.push(
				"FAIL: B's disabled-time edit was overwritten on re-enable. " +
				"Baseline did NOT advance after the enabled-time edit. " +
				"contentBaselineHash is not being updated by setDiskWriteCallback.",
			);
		} else {
			log("Assert: disabled-time edit survived re-enable (baseline advanced) ✓");
		}

		// No conflict artifact should have been created (disk-only change)
		const scratchBaseName = scratch.split("/").pop()?.replace(".md", "") ?? "";
		const conflictPath = await b.evalRaw<string | null>(`
			(function() {
				const baseName = ${JSON.stringify(scratchBaseName)};
				const vaultFiles = app.vault.getFiles().map(f => f.path);
				return vaultFiles.find(p =>
					p.includes(baseName) && p.includes("conflict") && p !== ${JSON.stringify(scratch)}
				) ?? null;
			})()
		`);
		if (conflictPath) {
			errors.push(
				`FAIL: spurious conflict artifact created for a local-only disabled edit ` +
				`when baseline should have been known. Artifact: ${conflictPath}`,
			);
			await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictPath)})`).catch(() => {});
			await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictPath)})`).catch(() => {});
		} else {
			log("Assert: no spurious conflict artifact ✓");
		}

		// Both edits should have propagated
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));
		const contentA = await a.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);
		if (!contentA.includes(DISABLED_EDIT_MARKER)) {
			errors.push("FAIL: B's disabled-time edit did not propagate to A");
		} else {
			log("Assert: disabled-time edit propagated to A ✓");
		}

		await s10fCleanup(a, b, scratch);
		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// ───────────────────────────────────────────────────────────────────
	// s10e-3: Disabled local delete, remote unchanged.
	//
	// Flow:
	//   1. Create file, sync to both (baseline recorded).
	//   2. B disables YAOS.
	//   3. B deletes the file from disk while YAOS is unloaded.
	//   4. A does NOT edit the file.
	//   5. B re-enables YAOS. Startup reconcile runs.
	//      baseline = INITIAL (both sides had it)
	//      disk:  file GONE on B
	//      CRDT:  file present (A has it, unchanged)
	//
	//   Expected: The local delete wins (or is preserved).
	//   The key invariant: YAOS must not silently resurrect the file B deleted.
	//   tombstone/delete semantics for offline delete.
	// ───────────────────────────────────────────────────────────────────
	"issue-22-disable-reenable-local-delete-remote-unchanged": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10e-3-local-delete.md";
		const INITIAL = "# S10e-3 Local Delete\n\nFile to be deleted while disabled.\n";

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log, { openOnBoth: false })) {
			return { passedA: false, passedB: false, errors };
		}

		// ── Disable YAOS on B ────────────────────────────────────────────

		log("Action: disabling YAOS on B...");
		const yaosUnloaded = await disableYaos(b);
		if (!yaosUnloaded) {
			errors.push("B: YAOS still present after disablePlugin");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS unloaded ✓");

		// ── B deletes file while YAOS is unloaded ─────────────────────────

		log("Action: B deletes file while YAOS is disabled...");
		const deleteOk = await b.evalRaw<boolean>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (!f) return false;
				await app.vault.delete(f);
				return !app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
			})()
		`);
		if (!deleteOk) {
			errors.push("B: could not delete file while YAOS was disabled");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: file deleted on B disk ✓");

		// A does not edit
		log("Note: A does not edit (local-delete-remote-unchanged scenario).");

		// ── Re-enable YAOS on B ──────────────────────────────────────────

		log("Action: re-enabling YAOS on B...");
		const qaReady = await enableYaosAndWait(b);
		if (!qaReady) {
			errors.push("B: YAOS did not re-initialize within 30s");
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS re-initialized ✓");

		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));

		// The offline delete is a hard invariant: startup reconciliation must
		// not silently recreate a file that this device deleted while YAOS was
		// disabled.

		const fileOnB = await b.evalRaw<boolean>(
			`!!app.vault.getAbstractFileByPath(${JSON.stringify(scratch)})`,
		);
		if (fileOnB) {
			errors.push(
				"FAIL: B's offline local delete was silently resurrected during re-enable",
			);
		} else {
			log("Assert: file absent on B (local delete respected) ✓");
		}

		// ── Assert: delete propagated to A ───────────────────────────────

		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));

		const fileOnA = await a.evalRaw<boolean>(
			`!!app.vault.getAbstractFileByPath(${JSON.stringify(scratch)})`,
		);
		if (fileOnA) {
			errors.push("FAIL: B's offline local delete did not propagate to A");
		} else {
			log("Assert: delete propagated to A ✓");
		}

		// Cleanup if file ended up somewhere
		await a.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (f) await app.vault.delete(f);
			})()
		`).catch(() => {});
		await b.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (f) await app.vault.delete(f);
			})()
		`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	// ───────────────────────────────────────────────────────────────────
	// s10e-4: Disabled local delete, remote edits same file.
	//
	// Flow:
	//   1. Create file, sync to both (baseline recorded).
	//   2. B disables YAOS.
	//   3. B deletes the file while YAOS is unloaded.
	//   4. A edits the file through YAOS (remote changes from baseline).
	//   5. B re-enables YAOS. Startup reconcile runs.
	//      baseline = INITIAL
	//      disk:  file GONE on B
	//      CRDT:  file present with A's edit
	//
	//   This is a concurrent conflict between a delete and an edit.
	//   Expected: conflict preserved -- either:
	//     - delete wins + A's edit in conflict artifact
	//     - or A's edit wins + B's delete noted
	//   The key invariant: YAOS must not silently resurrect OR silently drop
	//   either side. User must know about the conflict.
	//
	//   This is one of the hardest cases in sync semantics.
	// ───────────────────────────────────────────────────────────────────
	"issue-22-disable-reenable-local-delete-remote-edits": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s10e-4-delete-conflict.md";
		const INITIAL = "# S10e-4 Delete Conflict\n\nFile for delete-vs-edit conflict.\n";
		const A_EDIT_MARKER = "Marker S10E4-A-EDIT";

		if (!await s10fSetup(a, b, scratch, INITIAL, errors, log, { openOnBoth: false })) {
			return { passedA: false, passedB: false, errors };
		}

		// ── Disable YAOS on B ────────────────────────────────────────────

		log("Action: disabling YAOS on B...");
		const yaosUnloaded = await disableYaos(b);
		if (!yaosUnloaded) {
			errors.push("B: YAOS still present after disablePlugin");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS unloaded ✓");

		// ── B deletes file, A edits concurrently ─────────────────────────

		log("Action: B deletes file while YAOS is disabled...");
		const deleteOk = await b.evalRaw<boolean>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (!f) return false;
				await app.vault.delete(f);
				return !app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
			})()
		`);
		if (!deleteOk) {
			errors.push("B: could not delete file while YAOS was disabled");
			await b.evalRaw(`app.plugins.enablePlugin("yaos")`).catch(() => {});
			return { passedA: false, passedB: false, errors };
		}
		log("Action: file deleted on B disk ✓");

		log("Action: A edits the same file through YAOS (concurrent with B's delete)...");
		const aEditContent = `\n${A_EDIT_MARKER}. Edit concurrent with B's offline delete.\n`;
		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(typeAtCursorExpr(aEditContent));
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		log("Action: A's edit synced to server ✓");

		// ── Re-enable YAOS on B ──────────────────────────────────────────

		log("Action: re-enabling YAOS on B...");
		const qaReady = await enableYaosAndWait(b);
		if (!qaReady) {
			errors.push("B: YAOS did not re-initialize within 30s");
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS re-initialized ✓");

		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));

		// ── Assert: no silent data loss ───────────────────────────────────
		// YAOS must handle delete-vs-edit conflict without silently losing
		// either side. Check what happened:
		const fileOnB = await b.evalRaw<boolean>(
			`!!app.vault.getAbstractFileByPath(${JSON.stringify(scratch)})`,
		);

		// Find any conflict artifact or recovery artifact
		const scratchBaseName = scratch.split("/").pop()?.replace(".md", "") ?? "";
		const conflictPath = await b.evalRaw<string | null>(`
			(function() {
				const baseName = ${JSON.stringify(scratchBaseName)};
				const vaultFiles = app.vault.getFiles().map(f => f.path);
				return vaultFiles.find(p =>
					p.includes(baseName) && (p.includes("conflict") || p.includes("YAOS")) && p !== ${JSON.stringify(scratch)}
				) ?? null;
			})()
		`);

		const contentB = fileOnB
			? await b.evalRaw<string>(`
				(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
					return f ? await app.vault.read(f) : "";
				})()
			`)
			: "";
		const conflictContent = conflictPath
			? await b.evalRaw<string>(`
				(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(conflictPath)});
					return f ? await app.vault.read(f) : "";
				})()
			`)
			: "";

		if (fileOnB) {
			if (!contentB.includes(A_EDIT_MARKER)) {
				errors.push(
					"FAIL: file was resurrected on B without A's concurrent remote edit",
				);
			}
			if (!conflictPath) {
				errors.push(
					"FAIL: remote edit won but B's offline delete was silently discarded without a conflict artifact",
				);
			}
		} else if (!conflictPath) {
			errors.push(
				"FAIL: delete won but A's concurrent remote edit was not preserved in a conflict artifact",
			);
		} else if (!conflictContent.includes(A_EDIT_MARKER)) {
			errors.push(
				"FAIL: delete won but the conflict artifact does not contain A's concurrent remote edit",
			);
		}

		if (errors.length === 0) {
			log(
				fileOnB
					? "Assert: remote edit won and offline delete was surfaced as a conflict ✓"
					: "Assert: offline delete won and remote edit was preserved as a conflict artifact ✓",
			);
		}

		// Cleanup
		await a.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
		if (conflictPath) {
			await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictPath)})`).catch(() => {});
			await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictPath)})`).catch(() => {});
		}
		await a.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (f) await app.vault.delete(f);
			})()
		`).catch(() => {});
		await b.evalRaw(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				if (f) await app.vault.delete(f);
			})()
		`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},
};
