#!/usr/bin/env bun
/**
 * repro-missing-baseline-kill
 *
 * Forces the missing-baseline code path (Path 4 in closedFileConflict.ts):
 *   baselineHash === null → preserve-conflict → winner: crdt
 *
 * This is the desktop approximation of the iPad scenario:
 *   "iOS killed/suspended Obsidian before YAOS had a clean shutdown,
 *    user edited via Files while the app was dead."
 *
 * Mechanism:
 *   1.  A creates baseline file. B receives it via CRDT.
 *   2.  HARD PRECONDITION: B's disk-index entry must have contentHash === null.
 *       If it's non-null, abort — we would be testing the already-proven
 *       persisted-baseline path, not missing-baseline.
 *   3.  Kill B's Obsidian process immediately — no disablePlugin, no teardownSync,
 *       no data.json save. The contentHash never gets written.
 *   4.  A writes REMOTE_FROM_A through YAOS (propagates to server).
 *   5.  Node/fs writes LOCAL_ON_B to B's vault file while B is dead.
 *   6.  Relaunch B.
 *   7.  Observe: reconcile.file.decision, final content, conflict artifact.
 *
 * Expected behavior with CURRENT code:
 *   - baselineHash === null → missing-baseline path fires
 *   - winner: crdt → CRDT wins main file, disk becomes artifact
 *   - B main file = BASELINE + REMOTE_FROM_A (user's LOCAL_ON_B is demoted)
 *
 * That is the Issue #22-B scenario. If this produces "CRDT wins" we have
 * confirmed the bug. Then we fix it.
 */

import { RawCdpObsidianClient } from "../controllers/obsidian-client-raw-cdp";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";

const RUN_ID = randomBytes(4).toString("hex");
const SCRATCH = `QA-scratch/missing-baseline-${RUN_ID}.md`;
const INITIAL = `BASELINE_${RUN_ID}\n`;
const REMOTE_FROM_A = `REMOTE_FROM_A_${RUN_ID}\n`;
const LOCAL_ON_B = `LOCAL_ON_B_${RUN_ID}\n`;

const VAULT_B = `${process.env.HOME}/temenos-b`;
const DATA_JSON_B = `${VAULT_B}/.obsidian/plugins/yaos/data.json`;
const PORT_A = 9222;
const PORT_B = 9223;
const USER_DATA_B = "/tmp/obs-b";

function log(msg: string) {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}
function pass(msg: string) { console.log(`  PASS  ${msg}`); }
function fail(msg: string) { console.error(`  FAIL  ${msg}`); }

function readDiskIndexEntry(path: string): unknown {
	try {
		const raw = readFileSync(DATA_JSON_B, "utf-8");
		const d = JSON.parse(raw) as Record<string, unknown>;
		const idx = (d._diskIndex ?? {}) as Record<string, unknown>;
		return idx[path] ?? null;
	} catch { return "ERROR"; }
}

function scrubDiskIndexEntry(path: string): void {
	try {
		const raw = readFileSync(DATA_JSON_B, "utf-8");
		const d = JSON.parse(raw) as Record<string, unknown>;
		const idx = (d._diskIndex ?? {}) as Record<string, unknown>;
		if (path in idx) {
			delete idx[path];
			d._diskIndex = idx;
			writeFileSync(DATA_JSON_B, JSON.stringify(d, null, 2));
			log(`Scrubbed disk-index entry for "${path}"`);
		}
	} catch (e) { log(`Warning: scrub failed: ${e}`); }
}

function getBPid(): number | null {
	try {
		const raw = execSync(
			`command ps aux | grep "obsidian/app.asar" | grep "${PORT_B}" | grep -v grep | awk '{print $2}' | head -1`,
			{ encoding: "utf-8" },
		).trim();
		const pid = parseInt(raw, 10);
		return isNaN(pid) ? null : pid;
	} catch { return null; }
}

async function relaunchB(): Promise<RawCdpObsidianClient> {
	const proc = spawn("obsidian",
		[`--remote-debugging-port=${PORT_B}`, `--user-data-dir=${USER_DATA_B}`, VAULT_B],
		{ detached: true, stdio: "ignore" });
	proc.unref();
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://localhost:${PORT_B}/json/version`);
			if (res.ok) break;
		} catch { /* not up yet */ }
		await new Promise(r => setTimeout(r, 500));
	}
	await new Promise(r => setTimeout(r, 4000)); // let renderer initialize
	const client = new RawCdpObsidianClient({ port: PORT_B });
	await client.connect();
	await client.waitForQaReady(30_000);
	log("B reconnected and QA-ready after relaunch");
	return client;
}

async function waitMs(ms: number) { await new Promise(r => setTimeout(r, ms)); }

async function main() {
	log(`=== missing-baseline-kill repro (run=${RUN_ID}) ===`);
	log(`Path: ${SCRATCH}`);

	// --- Setup ---
	const a = new RawCdpObsidianClient({ port: PORT_A });
	let b = new RawCdpObsidianClient({ port: PORT_B });
	await a.connect();
	await b.connect();
	await a.waitForQaReady(30_000);
	await b.waitForQaReady(30_000);
	log("Connected.");

	// Clean up any stale path from previous runs
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	scrubDiskIndexEntry(SCRATCH);
	await waitMs(2000);

	// --- Phase 1: Create baseline on A, wait for B to receive on disk ---

	log("Phase 1: Creating baseline on A...");
	await a.evalRaw(`(async()=>{ await app.vault.create(${JSON.stringify(SCRATCH)}, ${JSON.stringify(INITIAL)}); })()`);
	await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});

	log("Waiting for B to receive file on disk...");
	const bGot = await b.evalRaw<boolean>(`
		(async () => {
			try {
				await window.__YAOS_DEBUG__.waitForFile(${JSON.stringify(SCRATCH)}, 60000);
				return true;
			} catch { return false; }
		})()
	`).catch(() => false);

	if (!bGot) {
		log("ABORT: B did not receive file");
		await a.close(); await b.close(); process.exit(1);
	}
	log("B has the file.");

	// Wait briefly — but NOT long enough for flushWrite (300ms debounce + possible idle)
	// We want contentHash to still be null.
	// The previous clean-disable repro showed contentHash is null after settle wait.
	// We just need to read the state right now.
	await waitMs(500);

	// --- HARD PRECONDITION: contentHash must be null ---
	const indexBeforeKill = readDiskIndexEntry(SCRATCH);
	const contentHashBeforeKill = (indexBeforeKill as Record<string, unknown> | null)?.contentHash ?? null;
	log(`B disk-index entry BEFORE kill: ${JSON.stringify(indexBeforeKill)}`);
	log(`contentHash before kill: ${contentHashBeforeKill}`);

	if (contentHashBeforeKill !== null && contentHashBeforeKill !== undefined) {
		log("ABORT: contentHash is already set — this would test persisted-baseline, not missing-baseline.");
		log("Run again or scrub the disk index entry manually.");
		await a.close(); await b.close(); process.exit(1);
	}
	log("Precondition satisfied: contentHash is null. About to kill B.");

	// --- Phase 2: Kill B immediately — no disablePlugin, no teardownSync ---

	const bPid = getBPid();
	log(`B main process PID: ${bPid}`);
	if (!bPid) {
		log("ABORT: could not find B PID");
		await a.close(); await b.close(); process.exit(1);
	}

	await b.close(); // disconnect CDP before kill
	execSync(`kill -9 ${bPid}`);
	await waitMs(2000);
	log("B killed (no clean shutdown).");

	// Verify contentHash is STILL null in data.json (process was killed before save)
	const indexAfterKill = readDiskIndexEntry(SCRATCH);
	const contentHashAfterKill = (indexAfterKill as Record<string, unknown> | null)?.contentHash ?? null;
	log(`B disk-index AFTER kill: ${JSON.stringify(indexAfterKill)}`);
	if (contentHashAfterKill !== null && contentHashAfterKill !== undefined) {
		log("WARNING: contentHash appeared in data.json after kill — the process may have saved before kill completed.");
		log("This run may not exercise the missing-baseline path. Continuing anyway.");
	}

	// --- Phase 3: While B is dead, A makes remote edit and B gets disk edit ---

	log("Phase 3a: A writing REMOTE_FROM_A through YAOS...");
	await a.evalRaw(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			if (!f) throw new Error("file not found on A");
			const current = await app.vault.read(f);
			await app.vault.modify(f, current + ${JSON.stringify(REMOTE_FROM_A)});
		})()
	`);
	await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});
	await waitMs(3000);
	log("A edit settled.");

	log("Phase 3b: Writing LOCAL_ON_B directly to disk (Node/fs, B dead)...");
	await writeFile(`${VAULT_B}/${SCRATCH}`, LOCAL_ON_B, "utf-8");
	const written = readFileSync(`${VAULT_B}/${SCRATCH}`, "utf-8");
	log(`Wrote to B disk: ${JSON.stringify(written)}`);

	// --- Phase 4: Relaunch B from cold ---

	log("Phase 4: Relaunching B...");
	b = await relaunchB();

	// YAOS may need to be re-enabled if it was in a disabled state
	const bPluginPresent = await b.evalRaw<boolean>(`!!app.plugins.plugins.yaos`).catch(() => false);
	if (!bPluginPresent) {
		log("B YAOS plugin not present — re-enabling...");
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);
		await waitMs(5000);
	}

	// Wait for reconciliation to complete
	const bReconciled = await b.evalRaw<boolean>(`
		(async () => {
			const d = window.__YAOS_DEBUG__;
			if (!d) return false;
			try { await d.waitForIdle(30000); return d.isReconciled(); } catch { return false; }
		})()
	`).catch(() => false);
	log(`B reconciled: ${bReconciled}`);
	await waitMs(5000);

	// --- Phase 5: Read results ---

	const survivorContent = await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null);
	log(`B main-file content: ${JSON.stringify(survivorContent)}`);

	const decisionEvent = await b.evalRaw<Record<string, unknown> | null>(`
		(function() {
			const plugin = app.plugins.plugins.yaos;
			if (!plugin) return null;
			const recorder = plugin.flightTrace?.currentRecorder;
			if (!recorder) return null;
			const events = recorder.recentEvents;
			for (let i = events.length - 1; i >= 0; i--) {
				if (events[i].kind === "reconcile.file.decision" && events[i].data) return events[i].data;
			}
			return null;
		})()
	`).catch(() => null);
	log(`B reconcile.file.decision: ${JSON.stringify(decisionEvent)}`);

	const allFiles = await b.evalRaw<string[]>(`
		app.vault.getMarkdownFiles().map(f => f.path).filter(p => p.includes(${JSON.stringify(RUN_ID)}))
	`).catch(() => []);
	log(`B vault files matching run ID: ${JSON.stringify(allFiles)}`);

	const artifactPath = allFiles.find(p => p !== SCRATCH && (p.includes("YAOS") || p.includes("conflict"))) ?? null;
	const artifactContent = artifactPath ? await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(artifactPath)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null) : null;
	log(`B conflict artifact: ${artifactPath ?? "none"}`);
	log(`B artifact content: ${JSON.stringify(artifactContent)}`);

	// Verify contentHash in data.json after run
	const indexAfterRun = readDiskIndexEntry(SCRATCH);
	log(`B disk-index AFTER run: ${JSON.stringify(indexAfterRun)}`);

	// --- Assertions ---

	console.log("\n=== ASSERTIONS ===");
	console.log(`Decision: ${decisionEvent?.decision ?? "unknown"} / ${decisionEvent?.reason ?? "unknown"}`);
	console.log(`baselineHash: ${decisionEvent?.baselineHash ?? "null"}`);
	console.log(`missingBaselinePolicy: ${decisionEvent?.missingBaselinePolicy ?? "n/a"}`);
	console.log(`diskMtime: ${decisionEvent?.diskMtime ?? "n/a"}  lastDiskIndexPersistedAt: ${decisionEvent?.lastDiskIndexPersistedAt ?? "n/a"}  mtimeEvidence: ${decisionEvent?.mtimeEvidence ?? "n/a"}`);

	const missingBaselineFired = decisionEvent?.reason === "missing-baseline";
	const diskWon = survivorContent === LOCAL_ON_B;
	const crdtWon = !diskWon && survivorContent?.includes(REMOTE_FROM_A);
	const artifactExists = artifactPath !== null;

	if (missingBaselineFired) {
		console.log("  INFO  missing-baseline path fired (baselineHash was null at reconcile time)");
	} else if (decisionEvent?.reason === "both-changed") {
		console.log("  INFO  both-changed path fired (baselineHash was non-null — clean shutdown may have saved it)");
	} else {
		console.log(`  INFO  Decision reason: ${decisionEvent?.reason ?? "not found"}`);
	}

	if (missingBaselineFired && crdtWon) {
		console.log("\n=== BUG: missing-baseline + mtime evidence should give disk, got CRDT ===");
		console.log("CRDT won the main file. User's LOCAL_ON_B was demoted.");
		console.log("Fix likely broke or mtime evidence was not threaded through.");
		fail("disk wins: B survivor should be LOCAL_ON_B");
	} else if (missingBaselineFired && diskWon) {
		console.log("\n=== PASS: missing-baseline + mtime evidence → disk wins (FIXED) ===");
		pass("disk wins: user's local edit survives cold relaunch");
		if (artifactExists) {
			pass(`conflict artifact preserved CRDT remote content: ${artifactPath}`);
			pass(`artifact content: ${JSON.stringify(artifactContent?.slice(0, 60))}`);
		} else {
			fail("expected conflict artifact for remote content but none found");
		}
	} else if (!missingBaselineFired && diskWon) {
		pass("disk wins via both-changed path (baseline was persisted before kill)");
		console.log("NOTE: This is the persisted-baseline path, not missing-baseline.");
		console.log("The tight-race window was missed — run again to hit missing-baseline.");
	} else {
		fail(`Unexpected state: decision=${decisionEvent?.decision}, survivor=${JSON.stringify(survivorContent)}`);
	}

	// Cleanup
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	if (artifactPath) await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(artifactPath)})`).catch(() => {});
	await a.close();
	await b.close();
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
