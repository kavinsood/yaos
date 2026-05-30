#!/usr/bin/env bun
/**
 * repro-s12c-missing-baseline
 *
 * Reproduces the bug observed on real iPad:
 *   - YAOS is disabled on Device B before the file has a stored baselineHash
 *   - A disk edit is made while B is disabled
 *   - On re-enable, decideClosedFileConflict gets baselineHash=null
 *   - CRDT wins instead of disk (LOCAL_ON_B content is lost)
 *
 * Two-device desktop CDP reproduction.
 * Ports: A=9222 (temenos), B=9223 (temenos-b)
 */

import { RawCdpObsidianClient as ObsidianClient } from "../controllers/obsidian-client-raw-cdp";

const SCRATCH = "QA-scratch/s12c-repro.md";
const INITIAL = "S12C-BASELINE\n";
const REMOTE_FROM_A = "REMOTE_FROM_A\n";
const LOCAL_ON_B = "S12C-LOCAL\n";

const a = new ObsidianClient({ port: 9222 });
const b = new ObsidianClient({ port: 9223 });

function log(msg: string) {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
	} else {
		console.error(`  FAIL  ${msg}`);
	}
	return condition;
}

async function waitForIdle(client: ObsidianClient, ms = 15000) {
	await client.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(${ms})`).catch(() => {});
}

async function main() {
	log("Connecting to A (9222) and B (9223)...");
	await a.connect();
	await b.connect();
	log("Connected.");

	await a.waitForQaReady(30_000);
	await b.waitForQaReady(30_000);
	log("QA APIs ready on both.");

	// Cleanup from any prior run
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await waitForIdle(a, 5000);
	await waitForIdle(b, 5000);

	// -----------------------------------------------------------------------
	// Phase 1: Create file on A, wait for it to sync to B
	// This creates the file in CRDT and on disk for both devices.
	// IMPORTANT: we do NOT wait long enough here for B to run flushWrite,
	// simulating the iPad scenario where the file arrives but YAOS hasn't
	// stored a baselineHash on B yet.
	// -----------------------------------------------------------------------

	log("Phase 1: Creating file on A...");
	await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(SCRATCH)}, ${JSON.stringify(INITIAL)})`);
	await waitForIdle(a, 15000);

	log("Waiting for B to see the file via CRDT (but racing to disable before flushWrite stores baseline)...");
	// Wait for B's CRDT to have the file — but NOT long enough for flushWrite
	// to run and store a contentHash in the disk index.
	// flushWrite has a DEBOUNCE_MS=300ms + open-file defers, but for a new file
	// it runs quickly. We need to disable right after CRDT admission.
	// Strategy: poll until CRDT has the text, then immediately disable.
	const crdtAdmitted = await b.evalRaw<boolean>(`
		(async () => {
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const yaos = app.plugins.plugins.yaos;
				if (!yaos) return false;
				const text = yaos.vaultSync?.getTextForPath?.(${JSON.stringify(SCRATCH)});
				if (text && text.toString().length > 0) return true;
				await new Promise(r => setTimeout(r, 100));
			}
			return false;
		})()
	`).catch(() => false);
	log(`B CRDT admitted: ${crdtAdmitted} — disabling IMMEDIATELY before flushWrite can store baseline`);
	// No sleep here — race to disable before the 300ms debounce fires

	// Check B's baseline hash BEFORE we disable — this is the key diagnostic
	const baselineBeforeDisable = await b.evalRaw<string | null>(`
		(function() {
			const plugin = app.plugins.plugins.yaos;
			if (!plugin) return "NO_PLUGIN";
			const idx = plugin.getDiskIndex?.() ?? plugin._diskIndex ?? null;
			if (!idx) return "NO_INDEX";
			const entry = idx[${JSON.stringify(SCRATCH)}];
			if (!entry) return "NO_ENTRY";
			return entry.contentHash ?? "NO_HASH";
		})()
	`).catch(() => "ERROR");
	log(`B baselineHash BEFORE disable: ${baselineBeforeDisable}`);

	// Also check if the file is physically on disk on B yet
	const bDiskContent = await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			if (!f) return null;
			return await app.vault.read(f);
		})()
	`).catch(() => null);
	log(`B disk content before disable: ${JSON.stringify(bDiskContent?.slice(0, 50))}`);

	// -----------------------------------------------------------------------
	// Phase 2: Disable YAOS on B
	// -----------------------------------------------------------------------

	log("Phase 2: Disabling YAOS on B...");
	await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
	await new Promise((r) => setTimeout(r, 2000));
	const bDisabled = await b.evalRaw<boolean>(`!app.plugins.plugins.yaos`);
	log(`B YAOS disabled: ${bDisabled}`);

	// -----------------------------------------------------------------------
	// Phase 3: A makes a remote edit (propagates via CRDT to server)
	// -----------------------------------------------------------------------

	log("Phase 3: A inserting REMOTE_FROM_A...");
	await a.evalRaw(`(function() {
		const e = app.workspace.activeEditor?.editor;
		if (!e) {
			// File not open in editor, use vault.modify instead
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			if (f) app.vault.modify(f, ${JSON.stringify(INITIAL + REMOTE_FROM_A)});
			return;
		}
		const l = e.lastLine();
		e.replaceRange(${JSON.stringify(REMOTE_FROM_A)}, { line: l, ch: e.getLine(l).length });
	})()`);
	await waitForIdle(a, 10000);
	await new Promise((r) => setTimeout(r, 3000));
	log("A edit settled.");

	// -----------------------------------------------------------------------
	// Phase 4: B makes a LOCAL disk edit while YAOS is disabled
	// This is the out-of-band edit (simulates Files app on iPad)
	// -----------------------------------------------------------------------

	log("Phase 4: B writing LOCAL_ON_B directly to disk (YAOS disabled)...");
	await b.evalRaw(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			if (f) await app.vault.adapter.write(${JSON.stringify(SCRATCH)}, ${JSON.stringify(LOCAL_ON_B)});
		})()
	`);
	await new Promise((r) => setTimeout(r, 1000));
	const bDiskAfterEdit = await b.evalRaw<string | null>(`
		(async () => {
			return await app.vault.adapter.read(${JSON.stringify(SCRATCH)});
		})()
	`).catch(() => null);
	log(`B disk content after local edit: ${JSON.stringify(bDiskAfterEdit)}`);

	// -----------------------------------------------------------------------
	// Phase 5: Re-enable YAOS on B
	// This triggers startup reconciliation — the bug should manifest here
	// -----------------------------------------------------------------------

	log("Phase 5: Re-enabling YAOS on B...");
	await b.evalRaw(`app.plugins.enablePlugin("yaos")`);
	await new Promise((r) => setTimeout(r, 5000));
	const bReady = await b.evalRaw<boolean>(`!!app.plugins.plugins.yaos`);
	log(`B YAOS re-enabled: ${bReady}`);

	// Wait for reconciliation to complete
	await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
	await new Promise((r) => setTimeout(r, 5000));

	// Read the reconcile.file.decision flight event to see exactly which path ran
	const recentDecision = await b.evalRaw<{kind: string; data: Record<string, unknown>} | null>(`
		(function() {
			const plugin = app.plugins.plugins.yaos;
			if (!plugin) return null;
			const recorder = plugin.flightTrace?.currentRecorder;
			if (!recorder) return null;
			const events = recorder.recentEvents;
			// Find the most recent reconcile.file.decision for our path
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i];
				if (e.kind === "reconcile.file.decision") {
					return { kind: e.kind, data: e.data ?? {} };
				}
			}
			return null;
		})()
	`).catch(() => null);
	log(`B reconcile.file.decision: ${JSON.stringify(recentDecision)}`);

	// Also read the FULL disk index for our path
	const diskIndexEntry = await b.evalRaw<unknown>(`
		(function() {
			const plugin = app.plugins.plugins.yaos;
			if (!plugin) return "NO_PLUGIN";
			// Try multiple access paths
			const idx1 = plugin.getDiskIndex?.();
			const idx2 = plugin._diskIndex;
			const idx3 = plugin.reconciliationController?._diskIndex;
			const key = ${JSON.stringify(SCRATCH)};
			return {
				via_getDiskIndex: idx1?.[key] ?? "null",
				via_diskIndex: idx2?.[key] ?? "null",
				via_controller: idx3?.[key] ?? "null",
			};
		})()
	`).catch(() => "ERROR");
	log(`B disk index entry for path: ${JSON.stringify(diskIndexEntry)}`);

	// -----------------------------------------------------------------------
	// Phase 6: Read results
	// -----------------------------------------------------------------------

	const survivorContent = await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null);
	log(`B final content: ${JSON.stringify(survivorContent)}`);

	// What decision was made?
	const baselineAfter = await b.evalRaw<string | null>(`
		(function() {
			const plugin = app.plugins.plugins.yaos;
			if (!plugin) return "NO_PLUGIN";
			const idx = plugin.getDiskIndex?.() ?? plugin._diskIndex ?? null;
			if (!idx) return "NO_INDEX";
			const entry = idx?.[${JSON.stringify(SCRATCH)}];
			if (!entry) return "NO_ENTRY";
			return entry.contentHash ?? "NO_HASH";
		})()
	`).catch(() => "ERROR");
	log(`B baselineHash AFTER re-enable: ${baselineAfter}`);

	// Look for conflict artifact — broader search
	const allVaultFiles = await b.evalRaw<string[]>(`
		app.vault.getMarkdownFiles().map(f => f.path)
	`).catch(() => []);
	log(`All vault files on B: ${JSON.stringify(allVaultFiles.filter(p => p.includes("QA-scratch") || p.includes("conflict") || p.includes("YAOS")))}`);

	const artifactPath = await b.evalRaw<string | null>(`
		(function() {
			const files = app.vault.getMarkdownFiles();
			const a = files.find(f => f.path.includes("s12c-repro") && (f.path.includes("YAOS") || f.path.includes("conflict")));
			return a?.path ?? null;
		})()
	`).catch(() => null);
	log(`B conflict artifact path: ${artifactPath}`);

	const artifactContent = artifactPath ? await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(artifactPath)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null) : null;
	log(`B conflict artifact content: ${JSON.stringify(artifactContent)}`);

	// -----------------------------------------------------------------------
	// Assertions — what SHOULD happen vs what DID happen
	// -----------------------------------------------------------------------

	console.log("\n=== RESULTS ===");
	const diskWon = assert(
		survivorContent === LOCAL_ON_B,
		`disk wins: B survivor === LOCAL_ON_B (got ${JSON.stringify(survivorContent)})`
	);
	assert(
		artifactPath !== null,
		`conflict artifact created on B (got ${artifactPath})`
	);
	assert(
		artifactContent?.includes("REMOTE_FROM_A") ?? false,
		`artifact contains REMOTE_FROM_A (got ${JSON.stringify(artifactContent)})`
	);
	assert(
		baselineBeforeDisable === "NO_HASH" || baselineBeforeDisable === "NO_ENTRY",
		`DIAGNOSTIC: B had no baselineHash before disable (confirms missing-baseline trigger) — got: ${baselineBeforeDisable}`
	);

	if (!diskWon) {
		console.log("\n=== BUG CONFIRMED ===");
		console.log("decideClosedFileConflict returned winner:crdt because baselineHash was null");
		console.log("LOCAL_ON_B was lost — REMOTE_FROM_A content replaced disk");
		console.log("Root cause: YAOS never stored a baselineHash on B for this file");
		console.log("           (B received the file via CRDT but flushWrite never ran)");
	} else {
		console.log("\n=== DISK WON (expected) ===");
	}

	// Cleanup
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	if (artifactPath) await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(artifactPath)})`).catch(() => {});

	await a.close();
	await b.close();
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
