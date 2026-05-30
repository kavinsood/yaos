#!/usr/bin/env bun
/**
 * repro-cold-relaunch-external-edit
 *
 * Tests the specific failure class the iPad run exposed:
 *   "cold relaunch / process death / missing persisted baseline / external edit"
 *
 * This is NOT the same as plugin disable/re-enable (s12c desktop, which passes).
 * This is: Obsidian process is killed while YAOS is disabled, user edits disk
 * externally, Obsidian relaunches from cold, YAOS re-enables.
 *
 * Test shape:
 *   1.  A creates baseline file. B syncs it. Both have disk + CRDT + baseline hash.
 *   2.  B: disable YAOS plugin.
 *   3.  B: kill the Obsidian process entirely (not just disable plugin).
 *   4.  While B is dead: A edits file via YAOS (REMOTE_FROM_A propagates to server).
 *   5.  While B is dead: write LOCAL_ON_B directly to B's vault file on disk (node:fs).
 *   6.  Relaunch B with the same CDP port and user-data-dir.
 *   7.  Wait for B's YAOS to re-enable and finish startup reconciliation.
 *   8.  Observe: what is on B's main file? Does a conflict artifact exist on B?
 *       What did reconcile.file.decision emit?
 *
 * Fresh path every run (UUID suffix) to avoid stale disk-index contamination.
 * Disk-index entry for the path is explicitly scrubbed from data.json before the run.
 */

import { RawCdpObsidianClient } from "../controllers/obsidian-client-raw-cdp";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const RUN_ID = randomBytes(4).toString("hex");
const SCRATCH = `QA-scratch/cold-s12c-${RUN_ID}.md`;
const INITIAL = `# Cold S12c Repro ${RUN_ID}\n\nBASELINE\n`;
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

function assert(condition: boolean, msg: string): boolean {
	if (condition) {
		console.log(`  PASS  ${msg}`);
	} else {
		console.error(`  FAIL  ${msg}`);
	}
	return condition;
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
			log(`Scrubbed disk-index entry for "${path}" from B data.json`);
		} else {
			log(`No disk-index entry for "${path}" in B data.json (clean)`);
		}
	} catch (e) {
		log(`Warning: could not scrub disk-index: ${e}`);
	}
}

function readDiskIndexEntry(path: string): unknown {
	try {
		const raw = readFileSync(DATA_JSON_B, "utf-8");
		const d = JSON.parse(raw) as Record<string, unknown>;
		const idx = (d._diskIndex ?? {}) as Record<string, unknown>;
		return idx[path] ?? null;
	} catch {
		return "ERROR_READING_DATA_JSON";
	}
}

async function waitMs(ms: number) {
	await new Promise((r) => setTimeout(r, ms));
}

async function relaunchB(): Promise<RawCdpObsidianClient> {
	log("Relaunching B Obsidian process...");
	const proc = spawn(
		"obsidian",
		[
			`--remote-debugging-port=${PORT_B}`,
			`--user-data-dir=${USER_DATA_B}`,
			VAULT_B,
		],
		{ detached: true, stdio: "ignore" },
	);
	proc.unref();

	// Wait for CDP to become available
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://localhost:${PORT_B}/json/version`);
			if (res.ok) {
				log("B CDP port is responding");
				break;
			}
		} catch {
			// not up yet
		}
		await waitMs(500);
	}

	await waitMs(4000); // let Obsidian renderer fully initialize

	const client = new RawCdpObsidianClient({ port: PORT_B });
	await client.connect();
	log("B reconnected via CDP");

	await client.waitForQaReady(30_000);
	log("B QA APIs ready after relaunch");
	return client;
}

async function main() {
	log(`=== cold-relaunch-external-edit repro (run=${RUN_ID}) ===`);
	log(`Path: ${SCRATCH}`);

	// --- Phase 0: Connect to both, clean state ---

	const a = new RawCdpObsidianClient({ port: PORT_A });
	let b = new RawCdpObsidianClient({ port: PORT_B });

	log("Connecting to A and B...");
	await a.connect();
	await b.connect();
	await a.waitForQaReady(30_000);
	await b.waitForQaReady(30_000);
	log("Connected and QA-ready.");

	// Clean up stale path on both devices
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await waitMs(3000);

	// Scrub disk-index entry for this path from B's persisted data.json
	// This is the key step that was missing in earlier runs.
	scrubDiskIndexEntry(SCRATCH);
	const indexBefore = readDiskIndexEntry(SCRATCH);
	log(`B disk-index entry BEFORE run: ${JSON.stringify(indexBefore)}`);

	// --- Phase 1: Create baseline on A, sync to B, confirm both have it ---

	log("Phase 1: Creating baseline on A...");
	await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(SCRATCH)}, ${JSON.stringify(INITIAL)})`);

	// Wait for A to fully settle
	await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});

	// Wait for B to receive the file via CRDT and write it to disk
	log("Waiting for B to receive the file and flush it to disk...");
	const bGotFile = await b.evalRaw<boolean>(`
		(async () => {
			// Use YAOS waitForFile which polls for CRDT admission
			try {
				await window.__YAOS_DEBUG__.waitForFile(${JSON.stringify(SCRATCH)}, 60000);
			} catch { return false; }
			// Then wait for the disk write (flushWrite has a 300ms debounce)
			const deadline = Date.now() + 15000;
			while (Date.now() < deadline) {
				const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
				if (f) {
					try {
						const content = await app.vault.read(f);
						if (content.includes("BASELINE")) return true;
					} catch {}
				}
				await new Promise(r => setTimeout(r, 500));
			}
			return false;
		})()
	`).catch(() => false);
	log(`B has the file on disk: ${bGotFile}`);

	if (!bGotFile) {
		log("ABORT: B did not receive the file within 30s");
		await a.close();
		await b.close();
		process.exit(1);
	}

	// Give B's DiskMirror time to run flushWrite and store the baseline hash
	// This is the critical window — the baseline hash must be persisted to data.json
	// before we kill the process.
	await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`).catch(() => {});
	await waitMs(3000); // extra buffer for data.json persistence

	// Read B's disk-index entry NOW — it should have contentHash stored
	const indexAfterSettle = readDiskIndexEntry(SCRATCH);
	log(`B disk-index entry AFTER settle: ${JSON.stringify(indexAfterSettle)}`);

	const bDiskContent = await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null);
	log(`B disk content at baseline: ${JSON.stringify(bDiskContent?.slice(0, 50))}`);

	// --- Phase 2: Disable YAOS on B (before killing) ---

	log("Phase 2: Disabling YAOS on B (plugin only, process still alive)...");
	await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
	await waitMs(2000);
	const bPluginDisabled = await b.evalRaw<boolean>(`!app.plugins.plugins.yaos`);
	log(`B plugin disabled: ${bPluginDisabled}`);

	// Wait for data.json to be written after plugin unload
	// (plugin unload triggers a final save)
	await waitMs(2000);
	const indexAfterDisable = readDiskIndexEntry(SCRATCH);
	log(`B disk-index entry AFTER plugin disable: ${JSON.stringify(indexAfterDisable)}`);

	// --- Phase 3: Kill B's Obsidian process ---

	// Find B's main process PID
	const { execSync } = await import("node:child_process");
	const bPidRaw = execSync(
		`command ps aux | grep "obsidian/app.asar" | grep "${PORT_B}" | grep -v grep | awk '{print $2}' | head -1`,
		{ encoding: "utf-8" },
	).trim();
	const bPid = parseInt(bPidRaw, 10);
	log(`B main process PID: ${bPid}`);

	if (!bPid || isNaN(bPid)) {
		log("ABORT: Could not find B's process PID");
		await a.close();
		await b.close();
		process.exit(1);
	}

	log(`Phase 3: Killing B process (PID ${bPid})...`);
	await b.close(); // disconnect CDP before killing
	execSync(`kill -9 ${bPid}`, { encoding: "utf-8" });
	await waitMs(2000);
	log("B process killed.");

	// Read the disk-index from data.json AFTER process kill — this is what
	// a cold relaunch will see.
	const indexAfterKill = readDiskIndexEntry(SCRATCH);
	log(`B disk-index entry AFTER kill (from data.json): ${JSON.stringify(indexAfterKill)}`);

	// --- Phase 4: While B is dead, A edits and B gets disk edit ---

	log("Phase 4a: A inserting REMOTE_FROM_A (propagates to server)...");
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

	log("Phase 4b: Writing LOCAL_ON_B directly to B's vault file (node:fs, B process dead)...");
	const fullVaultPath = `${VAULT_B}/${SCRATCH}`;
	await writeFile(fullVaultPath, LOCAL_ON_B, "utf-8");
	const writtenContent = readFileSync(fullVaultPath, "utf-8");
	log(`Wrote to B disk: ${JSON.stringify(writtenContent)}`);

	// --- Phase 5: Relaunch B cold ---

	log("Phase 5: Relaunching B from cold...");
	b = await relaunchB();

	// Wait for YAOS to initialize on relaunch
	log("Waiting for B YAOS to init after cold relaunch...");
	const bYaosReady = await b.evalRaw<boolean>(`
		(async () => {
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const d = window.__YAOS_DEBUG__;
				if (d && d.isLocalReady()) return true;
				await new Promise(r => setTimeout(r, 500));
			}
			return false;
		})()
	`).catch(() => false);
	log(`B YAOS ready after cold relaunch: ${bYaosReady}`);

	// YAOS may have been disabled before kill — re-enable it
	const bPluginPresent = await b.evalRaw<boolean>(`!!app.plugins.plugins.yaos`).catch(() => false);
	if (!bPluginPresent) {
		log("B YAOS plugin not present after relaunch — re-enabling...");
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);
		await waitMs(5000);
		const bYaosReady2 = await b.evalRaw<boolean>(`
			(async () => {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					const d = window.__YAOS_DEBUG__;
					if (d && d.isLocalReady()) return true;
					await new Promise(r => setTimeout(r, 500));
				}
				return false;
			})()
		`).catch(() => false);
		log(`B YAOS ready after re-enable: ${bYaosReady2}`);
	}

	// Wait for reconciliation to complete
	await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
	await waitMs(5000);

	// --- Phase 6: Read results ---

	// Main file content on B
	const survivorContent = await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null);
	log(`B final file content: ${JSON.stringify(survivorContent)}`);

	// What reconcile decision was made?
	const decisionEvent = await b.evalRaw<{decision: string; reason: string; baselineHash: string | null; diskHash: string; crdtHash: string} | null>(`
		(function() {
			const plugin = app.plugins.plugins.yaos;
			if (!plugin) return null;
			const recorder = plugin.flightTrace?.currentRecorder;
			if (!recorder) return null;
			const events = recorder.recentEvents;
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i];
				if (e.kind === "reconcile.file.decision" && e.data) {
					return e.data;
				}
			}
			return null;
		})()
	`).catch(() => null);
	log(`B reconcile.file.decision: ${JSON.stringify(decisionEvent)}`);

	// Conflict artifact
	const allMarkdownFiles = await b.evalRaw<string[]>(`
		app.vault.getMarkdownFiles().map(f => f.path).filter(p =>
			p.includes(${JSON.stringify(RUN_ID)})
		)
	`).catch(() => []);
	log(`B vault files matching run ID: ${JSON.stringify(allMarkdownFiles)}`);

	const artifactPath = allMarkdownFiles.find(p => p.includes("YAOS conflict") || p.includes("conflict")) ?? null;
	const artifactContent = artifactPath ? await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(artifactPath)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null) : null;
	log(`B conflict artifact: ${artifactPath ?? "none"}`);
	log(`B artifact content: ${JSON.stringify(artifactContent)}`);

	// Disk index after all this
	const indexAfterRun = readDiskIndexEntry(SCRATCH);
	log(`B disk-index entry AFTER run: ${JSON.stringify(indexAfterRun)}`);

	// --- Phase 7: Assertions ---

	console.log("\n=== ASSERTIONS ===");
	console.log(`Decision path: ${decisionEvent?.decision ?? "unknown"} / ${decisionEvent?.reason ?? "unknown"}`);
	console.log(`baselineHash was: ${decisionEvent?.baselineHash ?? "null"}`);
	console.log(`diskHash: ${decisionEvent?.diskHash?.slice(0, 16)}`);
	console.log(`crdtHash: ${decisionEvent?.crdtHash?.slice(0, 16)}`);

	const diskWon = assert(
		survivorContent === LOCAL_ON_B,
		`disk wins: B survivor === LOCAL_ON_B`,
	);
	const artifactExists = assert(
		artifactPath !== null,
		`conflict artifact exists on B`,
	);
	assert(
		artifactContent?.includes(REMOTE_FROM_A.trim()) ?? false,
		`artifact contains REMOTE_FROM_A`,
	);
	assert(
		!survivorContent?.includes("REMOTE_FROM_A") ?? true,
		`REMOTE_FROM_A not in main file (should be in artifact only)`,
	);

	// Key diagnostic: was the baseline null when the decision ran?
	const hadNullBaseline = decisionEvent?.baselineHash === null;
	assert(
		decisionEvent !== null,
		`reconcile.file.decision event was emitted`,
	);

	if (!diskWon) {
		console.log("\n=== BUG CONFIRMED: COLD RELAUNCH EXTERNAL EDIT DATA LOSS ===");
		console.log("CRDT overwrite B's disk edit on cold relaunch.");
		console.log(`Decision: ${decisionEvent?.decision} / reason: ${decisionEvent?.reason}`);
		if (hadNullBaseline) {
			console.log("Root: baselineHash was null → missing-baseline → winner:crdt");
			console.log("Fix candidate: change missing-baseline default from winner:crdt to winner:disk");
		} else {
			console.log(`Root: baselineHash was non-null: ${decisionEvent?.baselineHash?.slice(0, 16)}`);
			console.log("Requires deeper investigation — baseline was present but wrong winner was chosen");
		}
	} else if (!artifactExists) {
		console.log("\n=== BUG CONFIRMED: DISK WON BUT NO CONFLICT ARTIFACT ===");
		console.log("B's disk content survived but the conflict artifact was not created.");
		console.log("REMOTE_FROM_A was silently dropped — data loss on the CRDT side.");
	} else {
		console.log("\n=== PASS: DISK WON AND ARTIFACT EXISTS ===");
		console.log("Cold relaunch handled correctly: disk wins, CRDT in artifact.");
	}

	// Cleanup
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	if (artifactPath) await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(artifactPath)})`).catch(() => {});

	await a.close();
	await b.close();
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
