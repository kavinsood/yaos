#!/usr/bin/env bun
/**
 * repro-open-file-reenable-data-loss
 *
 * Reproduces the Issue #22-B variant the iPad run hit on real hardware:
 *   "I had the note open, turned YAOS off, edited the note, turned YAOS
 *    back on, and lost my edits."
 *
 * The closed-file three-way conflict logic in ReconciliationController
 * (line ~726) only runs when the file is NOT open in the editor:
 *
 *   if (mode === "authoritative" && !isOpenOrBound && ...) {
 *     const decision = decideClosedFileConflict(...);
 *     // disk-vs-crdt-vs-baseline policy
 *   }
 *   updatesToFlush.push(path);  // <-- open files fall through to here
 *
 * For OPEN files in `result.updatedOnDisk`, the conflict policy is
 * skipped entirely and CRDT is unconditionally written to disk via
 * diskMirror.flushWrite(path). User work in the editor + on disk is
 * silently overwritten with no conflict artifact.
 *
 * Test shape (no process kill — that's a separate scenario):
 *   1. A and B synced. Same vault, same workspace.
 *   2. B opens the test file in the active editor.
 *   3. A creates baseline file, B receives it on disk and in editor.
 *   4. Disable YAOS on B. Editor stays open.
 *   5. A modifies file via YAOS — REMOTE_FROM_A propagates to server.
 *   6. B types LOCAL_ON_B into the editor (replaces the editor buffer).
 *   7. Wait long enough for Obsidian's autosave to flush editor → disk.
 *   8. Re-enable YAOS on B.
 *   9. Wait for reconcile.
 *   10. Assert:
 *       - B main file contains LOCAL_ON_B (user's edit wins)
 *       - if remote also changed, conflict artifact contains REMOTE_FROM_A
 *       - no silent overwrite of user's editor content
 *
 * Expected behavior on CURRENT code: B main file contains REMOTE_FROM_A,
 * LOCAL_ON_B is lost. That's the bug.
 *
 * Expected behavior AFTER fix: B main file contains LOCAL_ON_B, conflict
 * artifact contains REMOTE_FROM_A.
 */

import { RawCdpObsidianClient } from "../controllers/obsidian-client-raw-cdp";
import { randomBytes } from "node:crypto";

const RUN_ID = randomBytes(4).toString("hex");
const SCRATCH = `QA-scratch/openfile-reenable-${RUN_ID}.md`;
const INITIAL = `# Open file re-enable proof ${RUN_ID}\n\nBASELINE_${RUN_ID}\n`;
const REMOTE_FROM_A = `REMOTE_FROM_A_${RUN_ID}\n`;
const LOCAL_ON_B = `LOCAL_ON_B_${RUN_ID}\n`;

const PORT_A = 9222;
const PORT_B = 9223;

function log(msg: string) {
	console.log(`[${new Date().toISOString()}] ${msg}`);
}
function pass(msg: string) { console.log(`  PASS  ${msg}`); }
function fail(msg: string) { console.error(`  FAIL  ${msg}`); }

async function waitMs(ms: number) { await new Promise(r => setTimeout(r, ms)); }

async function main() {
	log(`=== open-file-reenable-data-loss repro (run=${RUN_ID}) ===`);
	log(`Path: ${SCRATCH}`);

	const a = new RawCdpObsidianClient({ port: PORT_A });
	const b = new RawCdpObsidianClient({ port: PORT_B });

	await a.connect();
	await b.connect();
	await a.waitForQaReady(30_000);
	await b.waitForQaReady(30_000);
	log("Connected to A and B.");

	// Cleanup any stale path from previous runs
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await waitMs(3000);

	// --- Phase 1: Create file on A, wait for B to receive on disk ---

	log("Phase 1: Creating baseline on A...");
	await a.evalRaw(`(async()=>{ await app.vault.create(${JSON.stringify(SCRATCH)}, ${JSON.stringify(INITIAL)}); })()`);
	await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`).catch(() => {});

	log("Waiting for B to receive baseline...");
	const bGot = await b.evalRaw<boolean>(`
		(async () => {
			try { await window.__YAOS_DEBUG__.waitForFile(${JSON.stringify(SCRATCH)}, 60000); return true; } catch { return false; }
		})()
	`).catch(() => false);
	if (!bGot) {
		log("ABORT: B did not receive baseline file");
		await a.close(); await b.close(); process.exit(1);
	}
	await waitMs(3000); // let flushWrite store baseline hash

	// --- Phase 2: B opens the file in the editor ---

	log("Phase 2: B opens the file in editor...");
	await b.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(SCRATCH)})`);
	await waitMs(2000);
	const bEditorReady = await b.evalRaw<boolean>(`
		(async () => {
			const view = app.workspace.getActiveViewOfType(app.workspace.constructor.name === "Workspace" ? Object.values(app.metadataCache.cache).constructor : Object);
			const e = app.workspace.activeEditor?.editor;
			return !!e;
		})()
	`).catch(() => false);
	const bEditorContent = await b.evalRaw<string | null>(`
		app.workspace.activeEditor?.editor?.getValue() ?? null
	`).catch(() => null);
	log(`B editor ready: ${bEditorReady}, content: ${JSON.stringify(bEditorContent?.slice(0, 60))}`);

	if (!bEditorContent?.includes("BASELINE")) {
		log("ABORT: B editor not loaded with baseline content");
		await a.close(); await b.close(); process.exit(1);
	}

	// --- Phase 3: Disable YAOS on B (editor stays open) ---

	log("Phase 3: Disabling YAOS on B (editor remains open)...");
	await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
	await waitMs(3000); // let teardownSync persist baseline cleanly
	const bDisabled = await b.evalRaw<boolean>(`!app.plugins.plugins.yaos`);
	log(`B YAOS disabled: ${bDisabled}`);

	// Confirm editor is still open and shows baseline
	const bEditorAfterDisable = await b.evalRaw<string | null>(`
		app.workspace.activeEditor?.editor?.getValue() ?? null
	`).catch(() => null);
	log(`B editor content after disable: ${JSON.stringify(bEditorAfterDisable?.slice(0, 60))}`);

	// --- Phase 4: A appends REMOTE_FROM_A through YAOS ---

	log("Phase 4a: A inserting REMOTE_FROM_A through YAOS...");
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
	log("A edit settled (server has REMOTE_FROM_A).");

	// --- Phase 5: B replaces editor content with LOCAL_ON_B ---

	log("Phase 5: B replaces editor content with LOCAL_ON_B...");
	// Replace entire editor buffer — simulates user retyping/editing the note
	await b.evalRaw(`
		(async () => {
			const e = app.workspace.activeEditor?.editor;
			if (!e) throw new Error("no active editor on B");
			e.setValue(${JSON.stringify(LOCAL_ON_B)});
			// Trigger Obsidian's autosave: blur and refocus, or wait for autosave timer
		})()
	`);
	// Wait for Obsidian to autosave the editor change to disk
	// Obsidian autosave is on a ~2s timer for active editor changes
	await waitMs(5000);

	// Verify the disk file actually has LOCAL_ON_B before re-enable
	const bDiskAfterEdit = await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null);
	log(`B disk content after editor edit: ${JSON.stringify(bDiskAfterEdit?.slice(0, 60))}`);

	if (!bDiskAfterEdit?.includes("LOCAL_ON_B")) {
		log("WARNING: B disk does not yet contain LOCAL_ON_B — Obsidian autosave may not have fired.");
		log("This run may not exercise the bug; if so, increase the wait or use vault.modify directly.");
	}

	// --- Phase 6: Re-enable YAOS on B ---

	log("Phase 6: Re-enabling YAOS on B...");
	await b.evalRaw(`app.plugins.enablePlugin("yaos")`);
	await waitMs(5000);

	const bReady = await b.evalRaw<boolean>(`
		(async () => {
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				const d = window.__YAOS_DEBUG__;
				if (d && d.isLocalReady() && d.isReconciled()) return true;
				await new Promise(r => setTimeout(r, 500));
			}
			return false;
		})()
	`).catch(() => false);
	log(`B YAOS ready and reconciled: ${bReady}`);
	await waitMs(8000); // let reconcile + post-resync settle

	// --- Phase 7: Read results ---

	const bMainFile = await b.evalRaw<string | null>(`
		(async () => {
			const f = app.vault.getFileByPath(${JSON.stringify(SCRATCH)});
			return f ? await app.vault.read(f) : null;
		})()
	`).catch(() => null);
	log(`B main-file content: ${JSON.stringify(bMainFile)}`);

	const bEditorFinal = await b.evalRaw<string | null>(`
		app.workspace.activeEditor?.editor?.getValue() ?? null
	`).catch(() => null);
	log(`B editor content: ${JSON.stringify(bEditorFinal)}`);

	const decisionEvents = await b.evalRaw<Array<Record<string, unknown>>>(`
		(function() {
			const plugin = app.plugins.plugins.yaos;
			if (!plugin) return [];
			const recorder = plugin.flightTrace?.currentRecorder;
			if (!recorder) return [];
			return recorder.recentEvents
				.filter(e => e.kind === "reconcile.file.decision" || e.kind === "recovery.decision" || e.kind === "recovery.apply.done" || e.kind === "crdt.file.updated" || e.kind === "disk.write.ok")
				.filter(e => !e.path || e.path.includes(${JSON.stringify(RUN_ID)}))
				.map(e => ({ kind: e.kind, data: e.data ?? {}, path: e.path }));
		})()
	`).catch(() => []);
	log(`B relevant flight events:`);
	for (const e of decisionEvents) {
		log(`  ${e.kind}: ${JSON.stringify(e.data).slice(0, 200)}`);
	}

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

	// --- Assertions ---

	console.log("\n=== ASSERTIONS ===");

	const localContentSurvived = bMainFile?.includes("LOCAL_ON_B") ?? false;
	const remoteAppearedInMain = bMainFile?.includes("REMOTE_FROM_A") ?? false;
	const artifactExists = artifactPath !== null;
	const artifactHasRemote = artifactContent?.includes("REMOTE_FROM_A") ?? false;

	if (localContentSurvived && !remoteAppearedInMain && artifactExists && artifactHasRemote) {
		console.log("\n=== PASS: open-file re-enable preserved local edit, remote in artifact ===");
		pass("local edit survives main file");
		pass("remote content preserved in artifact");
		pass("no silent overwrite");
	} else if (localContentSurvived && !remoteAppearedInMain && !artifactExists) {
		console.log("\n=== PARTIAL PASS: local edit survived but no artifact for remote ===");
		pass("local edit survives main file");
		fail("no conflict artifact preserved REMOTE_FROM_A — possible data loss on remote side");
	} else if (!localContentSurvived && remoteAppearedInMain) {
		console.log("\n=== BUG CONFIRMED: ISSUE #22-B open-file path — local edit silently lost ===");
		fail("local edit lost from main file — CRDT silently overwrote user's editor content");
		if (artifactExists) {
			pass(`artifact exists: ${artifactPath}`);
			console.log(`Artifact content: ${JSON.stringify(artifactContent)}`);
			fail("local edit was demoted to artifact (bad UX)");
		} else {
			fail("NO ARTIFACT — local edit is completely gone");
		}
		console.log("\nRoot cause likely: ReconciliationController updatedOnDisk loop skips");
		console.log("decideClosedFileConflict for open files (isOpenOrBound check at line 726).");
		console.log("Open files fall through to updatesToFlush which writes CRDT to disk");
		console.log("unconditionally with no conflict policy.");
	} else {
		console.log(`\n=== UNEXPECTED STATE ===`);
		console.log(`mainFile: ${JSON.stringify(bMainFile)}`);
		console.log(`editor:   ${JSON.stringify(bEditorFinal)}`);
		console.log(`artifact: ${artifactPath} content=${JSON.stringify(artifactContent)}`);
	}

	// Cleanup
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(SCRATCH)})`).catch(() => {});
	if (artifactPath) await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(artifactPath)})`).catch(() => {});

	await a.close();
	await b.close();
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
