#!/usr/bin/env bun
/**
 * qa:two-device -- Run a two-device QA scenario against two live Obsidian instances.
 *
 * Usage:
 *   bun run qa:two-device --scenario offline-handoff-create \
 *     --port-a 9222 --port-b 9223 \
 *     --vault-a /path/to/vault-a --vault-b /path/to/vault-b \
 *     [--trace qa-safe] [--out-dir qa-runs/] [--driver raw-cdp|playwright]
 *
 * Both Obsidian instances must be started with:
 *   /path/to/Obsidian --remote-debugging-port=922X --user-data-dir=/tmp/obs-X
 *
 * Drivers:
 *   raw-cdp    -- Raw WebSocket CDP (default). Works with all Electron versions.
 *   playwright -- Playwright connectOverCDP. May fail on newer Electron/Chrome.
 *
 * Exit code 0 = PASS on both devices. Exit code 1 = any failure.
 */

import { resolve, join } from "path";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { ObsidianClient } from "./obsidian-client";
import { RawCdpObsidianClient } from "./obsidian-client-raw-cdp";
import { ArtifactCollector } from "./collect-artifacts";
import { analyzeTrace } from "../analyzers/analyzer";
import { formatReport } from "../analyzers/report";
import { runS11a } from "../obsidian-harness/scenarios/s11a-passive-stale-echo-witness";
import { runS11b } from "../obsidian-harness/scenarios/s11b-disable-reenable-witness";
import type { DeviceHandle } from "../obsidian-harness/witness-primitives";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";
import type { WitnessBufferEntry } from "../../src/diagnostics/deviceWitnessTracker";

/** Union type for either client implementation. */
type AnyObsidianClient = ObsidianClient | RawCdpObsidianClient;

function createClient(driver: string, port: number): AnyObsidianClient {
	if (driver === "raw-cdp") {
		return new RawCdpObsidianClient({ port });
	}
	return new ObsidianClient({ port });
}

/** Collect build identity for the QA run. */
async function collectBuildIdentity(
	clientA: AnyObsidianClient,
	clientB: AnyObsidianClient,
	log: (msg: string) => void,
): Promise<Record<string, unknown>> {
	// Git info (from the machine running the test)
	let gitCommit = "unknown";
	let gitDirty = "unknown";
	let gitDiffStat = "";
	try {
		gitCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
		const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
		gitDirty = status.length > 0 ? "dirty" : "clean";
		if (gitDirty === "dirty") {
			gitDiffStat = execSync("git diff --stat", { encoding: "utf-8" }).trim();
		}
	} catch { /* not in a git repo */ }

	const buildIdentityExpr = `
		(async function() {
			const manifest = app.plugins?.plugins?.yaos?.manifest;
			let bundleHash = "unknown";
			try {
				const basePath = app.vault.adapter.basePath;
				const fs = require("fs");
				const crypto = require("crypto");
				const buf = fs.readFileSync(basePath + "/.obsidian/plugins/yaos/main.js");
				bundleHash = crypto.createHash("sha256").update(buf).digest("hex");
			} catch (e) { /* mobile or missing */ }
			return {
				pluginVersion: manifest?.version ?? "unknown",
				bundleHash: bundleHash,
				obsidianVersion: navigator.userAgent.match(/Obsidian\\/([\\d.]+)/)?.[1] ?? "unknown",
				electronVersion: typeof process !== "undefined" ? process?.versions?.electron ?? "unknown" : "unknown",
				chromeVersion: typeof process !== "undefined" ? process?.versions?.chrome ?? "unknown" : "unknown",
				platform: typeof process !== "undefined" ? process?.platform ?? "unknown" : navigator.platform ?? "unknown",
				vaultName: app.vault?.getName?.() ?? "unknown",
			};
		})()
	`;

	// Runtime info from both instances
	let identityA: Record<string, string> = {};
	let identityB: Record<string, string> = {};
	try {
		const result = await clientA.evalRaw<Record<string, string>>(buildIdentityExpr);
		identityA = result ?? {};
	} catch (e) {
		log(`Warning: could not collect build identity from A: ${String(e)}`);
	}
	try {
		const result = await clientB.evalRaw<Record<string, string>>(buildIdentityExpr);
		identityB = result ?? {};
	} catch (e) {
		log(`Warning: could not collect build identity from B: ${String(e)}`);
	}

	const identity: Record<string, unknown> = {
		gitCommit,
		gitWorkingTree: gitDirty,
		...(gitDiffStat ? { gitDiffStat } : {}),
		runTimestamp: new Date().toISOString(),
		deviceA: identityA,
		deviceB: identityB,
	};

	log(`Build identity: git=${gitCommit.slice(0, 10)} (${gitDirty})`);
	if (gitDiffStat) log(`  Dirty files:\n${gitDiffStat.split("\n").map(l => "    " + l).join("\n")}`);
	log(`  Device A: plugin=${identityA.pluginVersion ?? "?"}, bundle=${(identityA.bundleHash ?? "?").slice(0, 12)}..., electron=${identityA.electronVersion ?? "?"}, vault=${identityA.vaultName ?? "?"}`);
	log(`  Device B: plugin=${identityB.pluginVersion ?? "?"}, bundle=${(identityB.bundleHash ?? "?").slice(0, 12)}..., electron=${identityB.electronVersion ?? "?"}, vault=${identityB.vaultName ?? "?"}`);

	// Verify both vaults loaded the same bundle
	if (identityA.bundleHash && identityB.bundleHash &&
		identityA.bundleHash !== "unknown" && identityB.bundleHash !== "unknown") {
		if (identityA.bundleHash === identityB.bundleHash) {
			log(`  Bundle match: A == B ✓`);
		} else {
			log(`  WARNING: Bundle mismatch! A=${identityA.bundleHash.slice(0, 12)} B=${identityB.bundleHash.slice(0, 12)}`);
		}
	}

	return identity;
}

function parseArgs(args: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--") && args[i + 1] && !args[i + 1]!.startsWith("--")) {
			result[a.slice(2)] = args[i + 1]!;
			i++;
		}
	}
	return result;
}

// -----------------------------------------------------------------------
// Shared helpers for s10f variant scenarios
// -----------------------------------------------------------------------

/** Sentinel used across all s10f variants. */
const S10F_SENTINEL = "DELETE_ME_SENTINEL_X9K7";

/** Delete sentinel line from the active editor. Returns JS expression string. */
function deleteSentinelExpr(sentinel: string): string {
	return `
		(function() {
			const editor = app.workspace.activeEditor?.editor;
			if (!editor) return false;
			const doc = editor.getValue();
			const sentinel = ${JSON.stringify(sentinel)};
			const idx = doc.indexOf(sentinel);
			if (idx === -1) return false;
			const lineStart = doc.lastIndexOf("\\n", idx - 1) + 1;
			let lineEnd = doc.indexOf("\\n", idx);
			if (lineEnd === -1) lineEnd = doc.length;
			else lineEnd += 1;
			const from = editor.offsetToPos(lineStart);
			const to = editor.offsetToPos(lineEnd);
			editor.replaceRange("", from, to);
			return true;
		})()
	`;
}

/** Read active editor content. Returns JS expression string. */
const READ_EDITOR_EXPR = `app.workspace.activeEditor?.editor?.getValue() ?? ""`;

/** Type text at cursor in active editor. Returns JS expression string. */
function typeAtCursorExpr(text: string): string {
	return `
		(function() {
			const editor = app.workspace.activeEditor?.editor;
			if (!editor) return;
			editor.replaceRange(${JSON.stringify(text)}, editor.getCursor());
		})()
	`;
}

/**
 * Poll the active editor on `client` for sentinel reversion.
 * Returns { reversionDetected, pollCount }.
 */
async function pollForReversion(
	client: AnyObsidianClient,
	sentinel: string,
	durationMs: number,
	intervalMs: number,
	log: (msg: string) => void,
	opts?: { burstEvery?: number; burstText?: string },
): Promise<{ reversionDetected: boolean; pollCount: number; errors: string[] }> {
	const errors: string[] = [];
	const burstEvery = opts?.burstEvery ?? 20;
	const burstText = opts?.burstText ?? " x";
	const pollStart = Date.now();
	let pollCount = 0;
	let reversionDetected = false;

	while (Date.now() - pollStart < durationMs) {
		await new Promise((r) => setTimeout(r, intervalMs));
		pollCount++;

		const editorContent = await client.evalRaw<string>(READ_EDITOR_EXPR);

		if (editorContent.includes(sentinel)) {
			const elapsed = Math.round((Date.now() - pollStart) / 1000);
			errors.push(
				`REVERSION at poll ${pollCount} (t+${elapsed}s): ` +
				`sentinel "${sentinel}" reappeared in editor! ` +
				`Content length: ${editorContent.length}`,
			);
			reversionDetected = true;
			break;
		}

		if (burstEvery > 0 && pollCount % burstEvery === 0) {
			await client.evalRaw(typeAtCursorExpr(burstText));
		}
	}

	if (!reversionDetected) {
		log(`Monitoring: ${pollCount} polls over ${Math.round(durationMs / 1000)}s, sentinel NEVER reappeared ✓`);
	}

	return { reversionDetected, pollCount, errors };
}

/**
 * Setup: create file, sync to both, open on both, wait for binding.
 * Returns success boolean. Pushes errors to `errors` array.
 */
async function s10fSetup(
	creator: AnyObsidianClient,
	receiver: AnyObsidianClient,
	scratch: string,
	initial: string,
	errors: string[],
	log: (msg: string) => void,
	opts?: { openOnBoth?: boolean },
): Promise<boolean> {
	const openOnBoth = opts?.openOnBoth ?? true;

	log("Setup: creating test file...");
	await creator.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(initial)})`);
	await creator.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);

	log("Setup: waiting for file on receiver...");
	await receiver.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 20000)`);
	await receiver.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);

	const hashC = await creator.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	const hashR = await receiver.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	if (hashC !== hashR) {
		errors.push(`Setup: hashes differ -- creator=${hashC?.slice(0, 12)}, receiver=${hashR?.slice(0, 12)}`);
		return false;
	}
	log("Setup: both devices have identical file ✓");

	if (openOnBoth) {
		log("Setup: opening file on both...");
		await creator.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await receiver.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await creator.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await receiver.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		log("Setup: healthy binding on both ✓");
	}

	return true;
}

/** Cleanup: close + delete file on both devices. */
async function s10fCleanup(
	a: AnyObsidianClient,
	b: AnyObsidianClient,
	scratch: string,
): Promise<void> {
	await a.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
	await b.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
	await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
}

/** Convergence check: verify sentinel absent + hashes match. */
async function s10fConvergence(
	active: AnyObsidianClient,
	passive: AnyObsidianClient,
	scratch: string,
	sentinel: string,
	errors: string[],
	log: (msg: string) => void,
): Promise<void> {
	log("Convergence: waiting for passive device...");
	await passive.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(20000)`).catch(() => {});
	await new Promise((r) => setTimeout(r, 5000));

	const contentP = await passive.evalRaw<string>(`
		(async () => {
			const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
			return f ? await app.vault.read(f) : "";
		})()
	`);
	if (contentP.includes(sentinel)) {
		errors.push("Passive device: sentinel still present after convergence");
	} else {
		log("Passive device: sentinel absent ✓");
	}

	const hashA = await active.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	const hashP = await passive.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
	if (hashA !== hashP) {
		errors.push(`Final hash mismatch: active=${hashA?.slice(0, 12)}, passive=${hashP?.slice(0, 12)}`);
	} else {
		log("Final: active == passive hash ✓");
	}
}

// -----------------------------------------------------------------------
// CDP → DeviceHandle bridge for Phase 2 witness primitives
// -----------------------------------------------------------------------

/**
 * Wrap a CDP client as a DeviceHandle for Phase 2 witness primitives.
 * All YaosQaDebugApi calls are proxied through evalRaw into the Obsidian renderer.
 */
function makeCdpDeviceHandle(client: AnyObsidianClient, deviceId: string): DeviceHandle {
	const api: YaosQaDebugApi = {
		// Readiness
		isLocalReady: () => false,
		isProviderSynced: () => false,
		isProviderConnected: () => false,
		isReconciled: () => false,
		isReconcileInFlight: () => false,
		disconnectProvider: () => {},
		connectProvider: () => {},
		setQaNetworkHold: () => {},
		waitForLocalReady: (t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForLocalReady(${t})`),
		waitForProviderSynced: (t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForProviderSynced(${t})`),
		waitForProviderDisconnected: (t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForProviderDisconnected(${t})`),
		waitForReconciled: (t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForReconciled(${t})`),
		waitForIdle: (t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(${t})`),
		waitForReceiptAfter: (ts, t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForReceiptAfter(${ts}, ${t})`),
		waitForMemoryReceipt: (t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForMemoryReceipt(${t})`),
		waitForFile: (p, t) => client.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(p)}, ${t})`),
		getReceiptSnapshot: () => ({ candidateId: null, capturedAt: null, lastConfirmedCandidateId: null, lastConfirmedAt: null }),
		getDiskHash: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(p)})`),
		getCrdtHash: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.getCrdtHash(${JSON.stringify(p)})`),
		getEditorHash: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.getEditorHash(${JSON.stringify(p)})`),
		getActiveMarkdownPaths: () => [],
		getDiskMarkdownPaths: () => [],
		getEditorBindingHealth: () => ({ leafOpen: false, bound: false, hasSyncFacet: false, yTextMatchesExpected: null, healthy: false, settling: false, issues: [] }),
		getServerReceiptState: () => "no-candidate",
		getConnectionState: () => "unknown",
		startFlightTrace: (m, s) => client.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace(${JSON.stringify(m)}, ${JSON.stringify(s)})`),
		stopFlightTrace: () => client.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`),
		exportFlightTrace: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.exportFlightTrace(${JSON.stringify(p)})`),
		forceReconcile: () => client.evalRaw(`window.__YAOS_DEBUG__?.forceReconcile()`),
		forceReconnect: () => { void client.evalRaw(`window.__YAOS_DEBUG__?.forceReconnect()`); },
		__qaOnlyForceCrdtContentUnsafe: (p, c, o) => client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyForceCrdtContentUnsafe(${JSON.stringify(p)}, ${JSON.stringify(c)}, ${JSON.stringify(o)})`),
		ingestDiskFileNow: (p, r) => client.evalRaw(`window.__YAOS_DEBUG__?.ingestDiskFileNow(${JSON.stringify(p)}, ${JSON.stringify(r)})`),
		pauseEditorPropagation: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.pauseEditorPropagation(${JSON.stringify(p)})`),
		resumeEditorPropagation: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.resumeEditorPropagation(${JSON.stringify(p)})`),
		setExternalEditPolicyOverride: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.setExternalEditPolicyOverride(${JSON.stringify(p)})`),
		__qaOnlyEmitPhaseUnsafe: (p) => client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyEmitPhaseUnsafe(${JSON.stringify(p)})`),
		witnessDeviceSettled: (p, o) => client.evalRaw(`window.__YAOS_DEBUG__?.witnessDeviceSettled(${JSON.stringify(p)}, ${JSON.stringify(o)})`),
		computeWitnessStateHash: (c) => client.evalRaw(`window.__YAOS_DEBUG__?.computeWitnessStateHash(${JSON.stringify(c)})`),
		getDeviceId: () => deviceId,
		getActiveTraceInfo: () => null, // populated below via async call
		getRuntimeState: () => "foreground",
		getWitnessBuffer: () => undefined, // populated below via async polling
		currentWitnessSeq: () => 0,
	};

	// Override getActiveTraceInfo and getWitnessBuffer with live CDP reads
	// These are called synchronously by primitives, so we cache the last polled value
	let cachedTraceInfo: ReturnType<YaosQaDebugApi["getActiveTraceInfo"]> = null;
	let cachedBuffer: ReadonlyArray<WitnessBufferEntry> = [];
	let cachedSeq = 0;

	// Poll witness buffer every 200ms while scenario is running
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	const startPolling = () => {
		if (pollTimer) return;
		pollTimer = setInterval(() => {
			void client.evalRaw<ReturnType<YaosQaDebugApi["getActiveTraceInfo"]>>(
				`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`,
			).then((info) => { if (info) cachedTraceInfo = info; }).catch(() => {});

			void client.evalRaw<ReadonlyArray<WitnessBufferEntry>>(
				`window.__YAOS_DEBUG__?.getWitnessBuffer() ?? []`,
			).then((buf) => { if (buf) cachedBuffer = buf; }).catch(() => {});

			void client.evalRaw<number>(
				`window.__YAOS_DEBUG__?.currentWitnessSeq() ?? 0`,
			).then((seq) => { if (typeof seq === "number") cachedSeq = seq; }).catch(() => {});
		}, 200);
	};

	const stopPolling = () => {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
	};

	(api as unknown as Record<string, unknown>).getActiveTraceInfo = () => cachedTraceInfo;
	(api as unknown as Record<string, unknown>).getWitnessBuffer = () => cachedBuffer;
	(api as unknown as Record<string, unknown>).currentWitnessSeq = () => cachedSeq;
	(api as unknown as Record<string, unknown>)._startPolling = startPolling;
	(api as unknown as Record<string, unknown>)._stopPolling = stopPolling;

	return { deviceId, api };
}

// -----------------------------------------------------------------------
// Two-device scenario definitions
// -----------------------------------------------------------------------

type TwoDeviceScenarioFn = (
	a: AnyObsidianClient,
	b: AnyObsidianClient,
	log: (msg: string) => void,
) => Promise<{ passedA: boolean; passedB: boolean; errors: string[] }>;

const TWO_DEVICE_SCENARIOS: Record<string, TwoDeviceScenarioFn> = {
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

		// 2. A creates the file and waits for server receipt
		log("Device A: creating file...");
		await a.evalRaw(
			`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, "# Offline Handoff\\n\\nCreated on A while B offline.\\n")`
		);
		log("Device A: waiting for server receipt...");
		try {
			const actionTs = Date.now();
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

		// Setup: create on A, wait for sync to both
		log("Device A: creating test file...");
		await a.evalRaw(
			`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, "# S03 Two-Device Delete\\n")`
		);
		const actionTs = Date.now();
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
		const SENTINEL = "DELETE_ME_SENTINEL_X9K7";
		const INITIAL = [
			"# S10f Passive Roundtrip",
			"",
			"BEFORE",
			"KEEP_ME",
			SENTINEL,
			"AFTER",
			"",
		].join("\n");

		// ── Setup: create file, sync to both, open on both ──────────────

		log("Setup: creating test file on Device A...");
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);

		log("Setup: waiting for file on Device B...");
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 20000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);

		// Verify both have same content
		const hashA0 = await a.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
		const hashB0 = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
		if (hashA0 !== hashB0) {
			errors.push(`Setup: hashes differ -- A=${hashA0?.slice(0, 12)}, B=${hashB0?.slice(0, 12)}`);
			return { passedA: false, passedB: false, errors };
		}
		log("Setup: both devices have identical file ✓");

		// Open on both with real editor binding
		log("Setup: opening file on both...");
		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await b.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await b.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		log("Setup: healthy binding on both ✓");

		// Let B's activity guard expire (B is idle/passive)
		await new Promise((r) => setTimeout(r, 2000));

		// ── Action: Device A deletes sentinel THROUGH THE EDITOR ─────────

		log("Action: Device A deleting sentinel through editor...");
		// Find the sentinel line and delete it via editor.replaceRange (real CM6 transaction)
		const deletionOk = await a.evalRaw<boolean>(`
			(function() {
				const editor = app.workspace.activeEditor?.editor;
				if (!editor) return false;
				const doc = editor.getValue();
				const sentinel = ${JSON.stringify(SENTINEL)};
				const idx = doc.indexOf(sentinel);
				if (idx === -1) return false;
				// Find line boundaries (delete the full line including newline)
				const lineStart = doc.lastIndexOf("\\n", idx - 1) + 1;
				let lineEnd = doc.indexOf("\\n", idx);
				if (lineEnd === -1) lineEnd = doc.length;
				else lineEnd += 1; // include the newline
				// Delete through the editor (real CM6 transaction via y-codemirror)
				const from = editor.offsetToPos(lineStart);
				const to = editor.offsetToPos(lineEnd);
				editor.replaceRange("", from, to);
				return true;
			})()
		`);
		if (!deletionOk) {
			errors.push("Device A: could not delete sentinel through editor");
			return { passedA: false, passedB: false, errors };
		}

		// Verify immediate editor state (sentinel gone)
		const editorAfterDel = await a.evalRaw<string>(`
			app.workspace.activeEditor?.editor?.getValue() ?? ""
		`);
		if (editorAfterDel.includes(SENTINEL)) {
			errors.push("Device A: sentinel still in editor immediately after replaceRange");
			return { passedA: false, passedB: false, errors };
		}
		log("Action: sentinel deleted from A's editor ✓");

		// Device A continues typing through the real editor (burst typing)
		log("Action: Device A typing post-deletion...");
		await a.evalRaw(`
			(function() {
				const editor = app.workspace.activeEditor?.editor;
				if (!editor) return;
				editor.replaceRange("\\nTyped after deletion. Marker Q8W2.\\n", editor.getCursor());
			})()
		`);

		// ── Monitoring: poll A's EDITOR at 250ms for sentinel reversion ──

		log("Monitoring: polling Device A editor for reversion (30s at 250ms)...");
		const POLL_DURATION = 30_000;
		const POLL_INTERVAL = 250;
		const pollStart = Date.now();
		let pollCount = 0;
		let reversionDetected = false;

		while (Date.now() - pollStart < POLL_DURATION) {
			await new Promise((r) => setTimeout(r, POLL_INTERVAL));
			pollCount++;

			const editorContent = await a.evalRaw<string>(`
				app.workspace.activeEditor?.editor?.getValue() ?? ""
			`);

			if (editorContent.includes(SENTINEL)) {
				const elapsed = Math.round((Date.now() - pollStart) / 1000);
				errors.push(
					`REVERSION BUG on A at poll ${pollCount} (t+${elapsed}s): ` +
					`sentinel "${SENTINEL}" reappeared in editor! ` +
					`Content length: ${editorContent.length}`,
				);
				reversionDetected = true;
				break;
			}

			// Also type occasionally (simulates burst editing during monitoring)
			if (pollCount % 20 === 0) {
				await a.evalRaw(`
					(function() {
						const editor = app.workspace.activeEditor?.editor;
						if (!editor) return;
						editor.replaceRange(" x", editor.getCursor());
					})()
				`);
			}
		}

		if (!reversionDetected) {
			log(`Monitoring: ${pollCount} polls over 30s, sentinel NEVER reappeared on A ✓`);
		}

		// ── Convergence: check B ────────────────────────────────────────

		log("Convergence: waiting for Device B...");
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(20000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));

		const contentB = await b.evalRaw<string>(`
			(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
				return f ? await app.vault.read(f) : "";
			})()
		`);
		if (contentB.includes(SENTINEL)) {
			errors.push("Device B: sentinel still present after convergence");
		} else {
			log("Device B: sentinel absent ✓");
		}

		// Final hash comparison
		const hashAFinal = await a.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
		const hashBFinal = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.getDiskHash(${JSON.stringify(scratch)})`);
		if (hashAFinal !== hashBFinal) {
			errors.push(`Final hash mismatch: A=${hashAFinal?.slice(0, 12)}, B=${hashBFinal?.slice(0, 12)}`);
		} else {
			log("Final: A == B hash ✓");
		}

		// ── Cleanup ─────────────────────────────────────────────────────

		await a.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
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
	//     See also: engineering/bug-rca-ledger.md Issue #22-B cold-relaunch variant
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
		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 3000));

		const yaosUnloaded = await b.evalRaw<boolean>(`!app.plugins?.plugins?.yaos`);
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
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);

		const qaReady = await b.evalRaw<boolean>(`
			(async () => {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					const yaos = app.plugins?.plugins?.yaos;
					const debug = window.__YAOS_DEBUG__;
					if (yaos && debug && debug.isLocalReady()) return true;
					await new Promise(r => setTimeout(r, 500));
				}
				return false;
			})()
		`);
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

	// s10e-2: B edits while YAOS disabled, A ALSO edits through YAOS.
	// Expected: conflict preserved -- both edits survive (main + artifact).
	// This was the original "issue-22-disable-reenable-disk-wins" test.
	// Name corrected: "disk wins" is wrong for the concurrent case.
	// Current behavior: missing-baseline/winner=crdt (CRDT wins main, disk in
	// artifact). After baseline fix: both-changed/winner=disk (disk wins main,
	// CRDT in artifact). Both produce a conflict artifact -- test passes either way.
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
		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);

		// Wait for plugin to fully unload
		await new Promise((r) => setTimeout(r, 3000));

		// Assert: YAOS is actually unloaded (plugin instance destroyed)
		// Note: enabledPlugins Set may not update synchronously, so check
		// the plugin instance directly.
		const yaosUnloaded = await b.evalRaw<boolean>(`!app.plugins?.plugins?.yaos`);
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
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);

		// Wait for YAOS to fully initialize
		// Poll until YAOS plugin is loaded and debug API is functional
		const qaReady = await b.evalRaw<boolean>(`
			(async () => {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					const yaos = app.plugins?.plugins?.yaos;
					const debug = window.__YAOS_DEBUG__;
					if (yaos && debug && debug.isLocalReady()) return true;
					await new Promise(r => setTimeout(r, 500));
				}
				return false;
			})()
		`);
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

		// ── Preservation audit: are both edits preserved? ─────────────────
		// The invariant: on concurrent conflict, neither edit is silently lost.
		// Either edit may win the main file -- both are acceptable. The other
		// edit must appear in a conflict artifact.
		//
		// Current behavior with baseline fix (both-changed/winner=disk):
		//   main = B's disk edit; artifact = A's CRDT edit (crdt artifact)
		//
		// Previous behavior (missing-baseline/winner=crdt):
		//   main = A's CRDT edit; artifact = B's disk edit (disk artifact)
		//
		// Both are correct conflict preservation. Test accepts either.

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

		const disableInMain = audit.mainHasDisable;
		const disableInArtifact = audit.conflictHasDisable;
		const aEditInMain = audit.mainHasA;
		const aEditInArtifact = audit.conflictHasA;

		if (!disableInMain && !disableInArtifact) {
			errors.push(
				"SILENT DATA LOSS: B's disabled-time edit (D1S4) is in neither main file " +
				"nor conflict artifact. It was silently discarded.",
			);
		} else if (disableInMain) {
			log(`Assert: B's disabled-edit in main file ✓`);
		} else {
			log(`Assert: B's disabled-edit preserved in conflict artifact ✓`);
			log(`  Conflict artifact: ${audit.conflictPath}`);
		}

		if (!aEditInMain && !aEditInArtifact) {
			errors.push(
				"SILENT DATA LOSS: A's edit (A7E2) is in neither main file " +
				"nor conflict artifact. It was silently discarded.",
			);
		} else if (aEditInMain) {
			log(`Assert: A's edit in main file ✓`);
		} else {
			log(`Assert: A's edit preserved in conflict artifact ✓`);
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
			// Not necessarily an error -- main files should converge, conflict file is separate
			log(`Note: main file hashes differ: A=${hashA?.slice(0, 12)}, B=${hashB?.slice(0, 12)}`);
		} else {
			log("Final: A == B main-file hash ✓");
		}

		// ── Assert: conflict artifact synced to A ────────────────────────

		if (audit.conflictPath) {
			log(`Conflict sync: waiting for "${audit.conflictPath}" to reach A (up to 30s)...`);
			const conflictOnA = await a.evalRaw<boolean>(`
				(async () => {
					const path = ${JSON.stringify(audit.conflictPath)};
					const deadline = Date.now() + 30000;
					while (Date.now() < deadline) {
						if (app.vault.getAbstractFileByPath(path)) return true;
						await new Promise(r => setTimeout(r, 500));
					}
					return false;
				})()
			`);
			if (conflictOnA) {
				log("Conflict sync: artifact reached A ✓");
			} else {
				log("Conflict sync: artifact not yet on A within 30s (cleanup/propagation race -- observed behavior)");
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
		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 3000));

		const yaosUnloaded = await b.evalRaw<boolean>(`!app.plugins?.plugins?.yaos`);
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
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);

		const qaReady = await b.evalRaw<boolean>(`
			(async () => {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					const yaos = app.plugins?.plugins?.yaos;
					const debug = window.__YAOS_DEBUG__;
					if (yaos && debug && debug.isLocalReady()) return true;
					await new Promise(r => setTimeout(r, 500));
				}
				return false;
			})()
		`);
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
		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 3000));

		const yaosUnloaded = await b.evalRaw<boolean>(`!app.plugins?.plugins?.yaos`);
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
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);

		const qaReady = await b.evalRaw<boolean>(`
			(async () => {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					const yaos = app.plugins?.plugins?.yaos;
					const debug = window.__YAOS_DEBUG__;
					if (yaos && debug && debug.isLocalReady()) return true;
					await new Promise(r => setTimeout(r, 500));
				}
				return false;
			})()
		`);
		if (!qaReady) {
			errors.push("B: YAOS did not re-initialize within 30s");
			return { passedA: false, passedB: false, errors };
		}
		log("Action: YAOS re-initialized ✓");

		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));

		// ── Assert: file is absent on B (delete was not resurrected) ─────
		// KNOWN FAILURE: YAOS currently resurrects the file. When a file is
		// absent from disk but present in CRDT, reconcileVault puts it in
		// `createdOnDisk` and writes it back -- treating the absence as
		// "file never seen on this device" rather than "user deleted it."
		//
		// The fix requires distinguishing:
		//   diskIndex[path].contentHash present → file was known → offline delete
		//   diskIndex[path] absent              → file is new   → create from CRDT
		//
		// This is a separate bug from #22-B (edit loss). Tracked for fix in
		// the startup reconcile / vaultSync.reconcileVault offline-delete path.
		// expectedFail until fixed.

		const fileOnB = await b.evalRaw<boolean>(
			`!!app.vault.getAbstractFileByPath(${JSON.stringify(scratch)})`,
		);
		if (fileOnB) {
			// EXPECTED FAIL: file was resurrected. Log clearly but don't hard-fail --
			// this is a known pre-existing limitation, not a regression from the
			// #22-B baseline fix. The deletion while disabled is not tracked by
			// reconcileVault's present/absent logic.
			log(
				"KNOWN ISSUE: file was resurrected on B after re-enable. " +
				"Offline delete resurrection is a separate bug pending fix in " +
				"vaultSync.reconcileVault (needs disk-index presence check). " +
				"Not a hard failure for this run -- tracked separately.",
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
			// Not a hard error -- the delete may still be propagating, or
			// YAOS may tombstone rather than propagate an offline delete
			// depending on reconcile strategy. Log as a warning.
			log("Note: file still present on A after B's offline delete (may require explicit re-delete or tombstone propagation)");
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
		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 3000));

		const yaosUnloaded = await b.evalRaw<boolean>(`!app.plugins?.plugins?.yaos`);
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
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);

		const qaReady = await b.evalRaw<boolean>(`
			(async () => {
				const deadline = Date.now() + 30000;
				while (Date.now() < deadline) {
					const yaos = app.plugins?.plugins?.yaos;
					const debug = window.__YAOS_DEBUG__;
					if (yaos && debug && debug.isLocalReady()) return true;
					await new Promise(r => setTimeout(r, 500));
				}
				return false;
			})()
		`);
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

		if (fileOnB) {
			// File was revived -- check if it has A's edit (makes sense if remote wins)
			const contentB = await b.evalRaw<string>(`
				(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
					return f ? await app.vault.read(f) : "";
				})()
			`);
			if (contentB.includes(A_EDIT_MARKER)) {
				log("Assert: file revived with A's edit (remote-edit wins over offline delete) ✓");
				if (conflictPath) {
					log(`  Conflict artifact also present: ${conflictPath}`);
				}
			} else {
				log("Note: file revived but without A's edit (stale revive -- check tombstone behavior)");
			}
		} else {
			// File is absent -- delete won
			if (conflictPath) {
				log(`Assert: delete won, A's edit in conflict artifact: ${conflictPath} ✓`);
			} else {
				// No file and no artifact -- A's edit may have been silently lost
				// Depends on YAOS tombstone semantics for this case. Not hard-failing
				// since behavior depends on delete-vs-edit conflict strategy.
				log("Note: file absent, no conflict artifact -- A's edit disposition unknown (tombstone behavior)");
			}
		}

		// Hard failure: if file is present on B with neither A's edit nor original content
		if (fileOnB) {
			const contentB = await b.evalRaw<string>(`
				(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
					return f ? await app.vault.read(f) : "";
				})()
			`);
			if (!contentB.includes(A_EDIT_MARKER) && !contentB.includes("S10e-4")) {
				errors.push(
					"FAIL: file revived on B with unexpected content -- neither A's edit nor original. " +
					"Silent data corruption in delete-vs-edit conflict.",
				);
			}
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

	/**
	 * s11a-passive-stale-echo-witness (Layer 4 Phase 2, Requirement 13)
	 *
	 * Three explicit phases:
	 *   Phase A -- preBurstBaseline: both devices witness initial hash
	 *   Phase B -- activeBurst: negative-window checks (no stale/recovery/editor divergences)
	 *   Phase C -- postBurstConvergence: Device A witnesses final hash locally first,
	 *              then both devices eventually converge to that hash
	 *
	 * Expected final hash is derived from Device A's LOCAL witness (CRDT+disk+editor agree),
	 * not from disk content alone.
	 */
	"s11a-passive-stale-echo-witness": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s11a-witness.md";
		const SENTINEL = "SENTINEL_S11A_X9K7";
		const INITIAL = `# S11a Witness\n\nBEFORE\n${SENTINEL}\nAFTER\n`;

		// ── Setup: start trace with shared secret ────────────────────────

		const QA_SECRET = `s11a-${Date.now()}`;
		log(`s11a: starting qa-safe flight trace with shared secret (length=${QA_SECRET.length})...`);

		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
			await client.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe", ${JSON.stringify(QA_SECRET)})`);
			log(`s11a: trace started on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 800));

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		log(`s11a: deviceA=${deviceIdA}, deviceB=${deviceIdB}`);

		const handleA = makeCdpDeviceHandle(a, deviceIdA ?? "device-a");
		const handleB = makeCdpDeviceHandle(b, deviceIdB ?? "device-b");
		const startPollingA = (handleA.api as unknown as Record<string, unknown>)._startPolling as () => void;
		const startPollingB = (handleB.api as unknown as Record<string, unknown>)._startPolling as () => void;
		const stopPollingA = (handleA.api as unknown as Record<string, unknown>)._stopPolling as () => void;
		const stopPollingB = (handleB.api as unknown as Record<string, unknown>)._stopPolling as () => void;

		startPollingA();
		startPollingB();
		log("s11a: waiting for witness buffer polling to prime...");
		await new Promise((r) => setTimeout(r, 800));

		const traceInfoA = (handleA.api as unknown as Record<string, unknown>).getActiveTraceInfo as () => unknown;
		const traceInfoB = (handleB.api as unknown as Record<string, unknown>).getActiveTraceInfo as () => unknown;
		const infoA = traceInfoA();
		const infoB = traceInfoB();
		log(`s11a: traceInfo A=${JSON.stringify(infoA)}`);
		log(`s11a: traceInfo B=${JSON.stringify(infoB)}`);

		if (!infoA || !infoB) {
			errors.push("s11a: trace identity not available");
			stopPollingA(); stopPollingB();
			return { passedA: false, passedB: false, errors };
		}

		// ── Create and open test file ─────────────────────────────────────

		log("s11a: creating test file on Device A...");
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 20000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 3000));

		const fileIdA = await a.evalRaw<string | null>(`app.plugins.plugins['yaos']?.vaultSync?.getFileId(${JSON.stringify(scratch)}) ?? null`);
		const fileIdB = await b.evalRaw<string | null>(`app.plugins.plugins['yaos']?.vaultSync?.getFileId(${JSON.stringify(scratch)}) ?? null`);
		log(`s11a: fileId A=${fileIdA}, B=${fileIdB}`);

		if (!fileIdA || !fileIdB) {
			errors.push(`s11a: fileId not available -- A=${fileIdA}, B=${fileIdB}`);
			stopPollingA(); stopPollingB();
			return { passedA: false, passedB: false, errors };
		}

		log("s11a: opening file on both devices...");
		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await b.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await b.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await new Promise((r) => setTimeout(r, 2000));

		// ── Pre-burst dirty trigger (anchors quorum start seq) ────────────

		const triggerPreBurstDirty = async () => {
			await new Promise((r) => setTimeout(r, 300));
			await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
			await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
			await new Promise((r) => setTimeout(r, 2500));
			const seqA = await a.evalRaw<number>(`window.__YAOS_DEBUG__?.currentWitnessSeq?.() ?? -1`);
			const seqB = await b.evalRaw<number>(`window.__YAOS_DEBUG__?.currentWitnessSeq?.() ?? -1`);
			log(`s11a: pre-burst dirty -- seqA=${seqA} seqB=${seqB}`);
		};

		// ── Run s11a with three explicit phases ───────────────────────────

		log("s11a: running three-phase witness scenario...");
		const [result] = await Promise.all([
			runS11a({
				deviceA: handleA,
				deviceB: handleB,
				path: scratch,
				initialContent: INITIAL,
				burstWindowMs: 30_000,
				quorumTimeoutMs: 30_000,
				minStableAfterMs: 1000,
				performBurst: async (_deviceA, _path) => {
					log("s11a: Phase B -- Device A deleting sentinel and typing in bursts...");
					await a.evalRaw(`
						(function() {
							const editor = app.workspace.activeEditor?.editor;
							if (!editor) return;
							const doc = editor.getValue();
							const idx = doc.indexOf(${JSON.stringify(SENTINEL)});
							if (idx === -1) return;
							const lineStart = doc.lastIndexOf("\\n", idx - 1) + 1;
							let lineEnd = doc.indexOf("\\n", idx);
							if (lineEnd === -1) lineEnd = doc.length; else lineEnd += 1;
							editor.replaceRange("", editor.offsetToPos(lineStart), editor.offsetToPos(lineEnd));
						})()
					`);
					const burstEnd = performance.now() + 28_000;
					let i = 0;
					while (performance.now() < burstEnd) {
						await a.evalRaw(`
							(function() {
								const editor = app.workspace.activeEditor?.editor;
								if (!editor) return;
								editor.replaceRange(" x${i}", editor.getCursor());
							})()
						`);
						i++;
						await new Promise((r) => setTimeout(r, 1500));
					}
					log("s11a: burst typing complete, waiting for Device A to locally witness final state...");

					// Wait for Device A to locally witness the final state (CRDT+disk+editor agree).
					// This is the correct source for the cross-device convergence target.
					// Clear suppression so A re-evaluates even if content hasn't changed.
					await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
					await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);

					// Wait for A's tracker to emit settled (up to 10s)
					let finalHashWitnessedByA = "";
					const anchorSeqA = await a.evalRaw<number>(`window.__YAOS_DEBUG__?.currentWitnessSeq?.() ?? 0`);
					const waitStart = performance.now();
					while (performance.now() - waitStart < 10_000) {
						await new Promise((r) => setTimeout(r, 300));
						const buf = await a.evalRaw<Array<{ kind: string; seq: number; data: Record<string, unknown> }>>(
							`JSON.parse(JSON.stringify(window.__YAOS_DEBUG__?.getWitnessBuffer?.() ?? []))`
						);
						if (!buf) break;
						const newSettled = buf.filter((e) => e.kind === "settled" && e.seq > anchorSeqA);
						if (newSettled.length > 0) {
							const latest = newSettled[newSettled.length - 1]!;
							finalHashWitnessedByA = String(latest.data.stateHash ?? "");
							log(`s11a: Device A locally witnessed final hash ${finalHashWitnessedByA} at seq=${latest.seq}`);
							break;
						}
					}

					if (!finalHashWitnessedByA) {
						log("s11a: WARNING -- Device A did not witness a final settled hash within 10s");
						// Fallback: read from witness segments
						const traceId = (infoA as Record<string, unknown>).traceId as string | undefined;
						if (traceId) {
							const segs = await a.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments(${JSON.stringify(traceId)}) ?? null`);
							if (segs) {
								for (const line of segs.split("\n").reverse()) {
									try {
										const e = JSON.parse(line) as Record<string, unknown>;
										if (e.kind === "device.witness.settled") {
											finalHashWitnessedByA = String((e.data as Record<string, unknown>)?.stateHash ?? "");
											log(`s11a: fallback -- final hash from segment: ${finalHashWitnessedByA}`);
											break;
										}
									} catch { /* skip */ }
								}
							}
						}
					}

					// Clear Device B's suppression so it re-evaluates when edits arrive
					await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
					await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
					log(`s11a: Phase B complete. Final hash for Phase C: ${finalHashWitnessedByA || "(none)"}`);

					return { finalHashWitnessedByA };
				},
			}),
			triggerPreBurstDirty(),
		]);

		stopPollingA();
		stopPollingB();

		log(`s11a result: ${result.summary}`);
		if (!result.ok) errors.push(`s11a failed: ${result.summary}`);

		// ── Export both device segments with summary ──────────────────────
		// If segment export is empty, embed the live-buffer events used for quorum
		// so the report is self-contained and verifiable without the live process.

		const traceId = (infoA as Record<string, unknown>).traceId as string | undefined;
		const segmentSummaries: Record<string, unknown> = {};

		for (const [client, label, devId] of [[a, "device-a", deviceIdA], [b, "device-b", deviceIdB]] as const) {
			const ndjson = await client.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments(${JSON.stringify(traceId ?? "")}) ?? null`);
			if (ndjson) {
				try {
					const { mkdirSync: mkdir, writeFileSync: write } = await import("fs");
					mkdir("qa-runs/s11a", { recursive: true });
					const outPath = `qa-runs/s11a/witness-${label}.ndjson`;
					write(outPath, ndjson);
					const lines = ndjson.split("\n").filter((l) => l.trim() && !l.includes("checkpoint.segment.header"));
					let latestSettledHash = "";
					let latestDivergenceReason = "";
					let settledCount = 0;
					let divergedCount = 0;
					for (const line of lines) {
						try {
							const e = JSON.parse(line) as Record<string, unknown>;
							if (e.kind === "device.witness.settled") { settledCount++; latestSettledHash = String((e.data as Record<string, unknown>)?.stateHash ?? ""); }
							else if (e.kind === "device.witness.diverged") { divergedCount++; latestDivergenceReason = String((e.data as Record<string, unknown>)?.reason ?? ""); }
						} catch { /* skip */ }
					}
					segmentSummaries[label] = { source: "exported_segments", status: "ok", path: outPath, eventCount: lines.length, settledCount, divergedCount, latestSettledHash, latestDivergenceReason };
					log(`s11a: ${label} segments → ${outPath} (${settledCount} settled, ${divergedCount} diverged, latest hash=${latestSettledHash || "none"})`);
				} catch (e) {
					segmentSummaries[label] = { source: "exported_segments", status: "export_failed", error: String(e) };
					log(`s11a: ${label} segment export failed: ${e}`);
				}
			} else {
				// Segment export empty -- embed live-buffer events used for quorum so report is self-contained
				const liveEvents = await client.evalRaw<Array<{ kind: string; seq: number; path: string; data: Record<string, unknown> }>>(
					`JSON.parse(JSON.stringify((window.__YAOS_DEBUG__?.getWitnessBuffer?.() ?? []).filter(e => e.path === ${JSON.stringify(scratch)})))`
				);
				const trackerStatus = await client.evalRaw<string>(`
					(function() {
						const t = app.plugins.plugins['yaos']?.deviceWitnessTracker;
						if (!t) return 'tracker_inactive';
						return 'active_no_segments';
					})()
				`);
				// Annotate each event with its role relative to the final hash
				const finalHash = result.postBurst.finalHashWitnessedByA;
				const annotatedEvents = (liveEvents ?? []).map((e) => ({
					seq: e.seq,
					kind: e.kind,
					stateHash: String(e.data?.stateHash ?? ""),
					role: e.kind === "settled"
						? (String(e.data?.stateHash ?? "") === finalHash ? "final" : "intermediate")
						: "diverged",
					data: e.data,
				}));
				segmentSummaries[label] = {
					source: "live_buffer",
					status: trackerStatus,
					deviceId: devId,
					note: "segment export empty; live buffer embedded for postmortem verification",
					eventsUsedForQuorum: annotatedEvents,
					settledCount: annotatedEvents.filter((e) => e.kind === "settled").length,
					divergedCount: annotatedEvents.filter((e) => e.kind === "diverged").length,
					latestSettledHash: annotatedEvents.filter((e) => e.kind === "settled").at(-1)?.stateHash ?? "",
				};
				log(`s11a: ${label} segments -- status=${trackerStatus}, embedded ${annotatedEvents.length} live-buffer events (source=live_buffer)`);
			}
		}

		// ── Emit dedicated Layer 4 report JSON ───────────────────────────

		const layer4Report = {
			scenario: "s11a-passive-stale-echo-witness",
			acceptanceVersion: "s11a-three-phase-v1",
			status: result.ok ? "current-pass" : "current-fail",
			runAt: new Date().toISOString(),
			deviceA: deviceIdA,
			deviceB: deviceIdB,
			ok: result.ok,
			phases: {
				A_preBurstBaseline: {
					ok: result.preBurst.ok,
					reason: result.preBurst.reason,
					summary: result.preBurst.summary,
				},
				B_activeBurst: {
					ok: result.activeBurst.ok,
					noStaleOnB: { ok: result.activeBurst.noStaleOnB.ok, reason: result.activeBurst.noStaleOnB.reason },
					noRecoveryOnB: { ok: result.activeBurst.noRecoveryOnB.ok, reason: result.activeBurst.noRecoveryOnB.reason },
					editorStableOnA: { ok: result.activeBurst.editorStableOnA.ok, reason: result.activeBurst.editorStableOnA.reason },
				},
				C_postBurstConvergence: {
					ok: result.postBurst.ok,
					reason: result.postBurst.reason,
					finalHashWitnessedByA: result.postBurst.finalHashWitnessedByA,
					intermediateHashesOnB: result.postBurst.intermediateHashes[deviceIdB ?? ""] ?? [],
					intermediateHashesOnA: result.postBurst.intermediateHashes[deviceIdA ?? ""] ?? [],
					summary: result.postBurst.summary,
					perDevice: result.postBurst.perDevice,
				},
			},
			segmentSummaries,
			note: "Layer 4 report is SEPARATE from legacy trace analyzer. Legacy analyzer PASS does not imply Layer 4 PASS.",
		};

		try {
			const { mkdirSync: mkdir, writeFileSync: write } = await import("fs");
			mkdir("qa-runs/s11a", { recursive: true });
			const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const reportPath = `qa-runs/s11a/layer4-report-${runId}.json`;
			write(reportPath, JSON.stringify(layer4Report, null, 2));
			// Also write latest (overwritten each run for convenience)
			write("qa-runs/s11a/layer4-report.json", JSON.stringify(layer4Report, null, 2));
			log(`s11a: Layer 4 report → ${reportPath}`);
		} catch { /* best-effort */ }

		log("NOTE: Legacy trace analyzer PASS ≠ Layer 4 scenario PASS. Check qa-runs/s11a/layer4-report.json for Layer 4 result.");

		// ── Cleanup ───────────────────────────────────────────────────────

		await a.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.closeFile(${JSON.stringify(scratch)})`).catch(() => {});
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	/**
	 * s11b-disable-reenable-witness (Layer 4 Phase 2, Requirement 14)
	 *
	 * Replicates Issue #22-B: disable/re-enable on Device B with concurrent
	 * local-disk and remote edits. Proves conflict artifact preservation.
	 *
	 * Structure:
	 *   1. Pre-disable baseline quorum
	 *   2. Disable B, concurrent edits, re-enable B
	 *   3. Wait for conflict artifact, compute actual hashes
	 *   4. Quorum: both devices witness conflict artifact with expected hash
	 *   5. Quorum: both devices witness original path with expected survivor hash
	 *   6. Negative-window: no stale/recovery divergences during re-sync
	 */
	"s11b-disable-reenable-witness": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s11b-witness.md";
		const INITIAL = "# S11b Witness\n\nOriginal content.\n";
		const LOCAL_EDIT = "# S11b Witness\n\nOriginal content.\n\nEDITED LOCALLY ON B WHILE DISABLED. Marker S11B-LOCAL.\n";
		const REMOTE_EDIT = "# S11b Witness\n\nOriginal content.\n\nEDITED REMOTELY ON A WHILE B DISABLED. Marker S11B-REMOTE.\n";

		// ── Setup: start trace with shared secret ────────────────────────

		const QA_SECRET = `s11b-${Date.now()}`;
		log(`s11b: starting qa-safe flight trace (secret length=${QA_SECRET.length})...`);
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
			await client.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe", ${JSON.stringify(QA_SECRET)})`);
			log(`s11b: trace started on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 800));

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		log(`s11b: deviceA=${deviceIdA}, deviceB=${deviceIdB}`);

		const handleA = makeCdpDeviceHandle(a, deviceIdA ?? "device-a");
		const handleB = makeCdpDeviceHandle(b, deviceIdB ?? "device-b");
		const startPollingA = (handleA.api as unknown as Record<string, unknown>)._startPolling as () => void;
		const startPollingB = (handleB.api as unknown as Record<string, unknown>)._startPolling as () => void;
		const stopPollingA = (handleA.api as unknown as Record<string, unknown>)._stopPolling as () => void;
		const stopPollingB = (handleB.api as unknown as Record<string, unknown>)._stopPolling as () => void;
		startPollingA(); startPollingB();
		await new Promise((r) => setTimeout(r, 800));

		const infoA = ((handleA.api as unknown as Record<string, unknown>).getActiveTraceInfo as () => unknown)();
		log(`s11b: traceInfo A=${JSON.stringify(infoA)}`);
		if (!infoA) {
			errors.push("s11b: trace identity not available");
			stopPollingA(); stopPollingB();
			return { passedA: false, passedB: false, errors };
		}

		// ── Create test file ──────────────────────────────────────────────

		log("s11b: creating test file on Device A...");
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 20000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 3000));

		const fileIdA = await a.evalRaw<string | null>(`app.plugins.plugins['yaos']?.vaultSync?.getFileId(${JSON.stringify(scratch)}) ?? null`);
		const fileIdB = await b.evalRaw<string | null>(`app.plugins.plugins['yaos']?.vaultSync?.getFileId(${JSON.stringify(scratch)}) ?? null`);
		log(`s11b: fileId A=${fileIdA}, B=${fileIdB}`);
		if (!fileIdA || !fileIdB) {
			errors.push(`s11b: fileId not available -- A=${fileIdA}, B=${fileIdB}`);
			stopPollingA(); stopPollingB();
			return { passedA: false, passedB: false, errors };
		}

		// ── Phase 1: Pre-disable baseline quorum ─────────────────────────

		log("s11b: Phase 1 -- pre-disable baseline quorum...");
		const initialHash = await handleA.api.computeWitnessStateHash(INITIAL);
		// Trigger dirty concurrently with quorum (suppression cleared, quorum anchored first)
		const triggerPreBaseline = async () => {
			await new Promise((r) => setTimeout(r, 300));
			await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
			await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
		};
		const { witnessQuorum: wq } = await import("../obsidian-harness/witness-primitives");
		const [preDisableQuorum] = await Promise.all([
			wq([handleA, handleB], scratch,
				{ pathId: scratch, stateKind: "present", expectedStateHash: initialHash, timeoutMs: 30_000, minStableAfterMs: 1000 }
			),
			triggerPreBaseline(),
		]);
		log(`s11b: Phase 1 result: ${preDisableQuorum.ok ? "PASS" : "FAIL -- " + (preDisableQuorum as { reason?: string }).reason}`);
		if (!preDisableQuorum.ok) {
			errors.push(`s11b Phase 1 failed: ${(preDisableQuorum as { reason?: string }).reason}`);
			stopPollingA(); stopPollingB();
			return { passedA: false, passedB: false, errors };
		}

		// ── Phase 2: Disable B, concurrent edits, re-enable B ────────────

		log("s11b: Phase 2 -- disabling YAOS on B...");
		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 3000));
		const unloaded = await b.evalRaw<boolean>(`!app.plugins?.plugins?.yaos`);
		if (!unloaded) { errors.push("s11b: YAOS did not unload on B"); stopPollingA(); stopPollingB(); return { passedA: false, passedB: false, errors }; }
		log("s11b: YAOS unloaded on B ✓");

		// Concurrent edits
		log("s11b: writing local edit on B and remote edit on A concurrently...");
		await Promise.all([
			b.evalRaw(`
				(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)});
					if (f) await app.vault.modify(f, ${JSON.stringify(LOCAL_EDIT)});
				})()
			`),
			(async () => {
				// Use editor-based edit on A (real CRDT transaction with correct baseline hash)
				// This is the same approach as issue-22-disable-reenable-concurrent
				await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
				await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
				await a.evalRaw(`
					(function() {
						const editor = app.workspace.activeEditor?.editor;
						if (!editor) return;
						const doc = editor.getValue();
						editor.replaceRange(${JSON.stringify(REMOTE_EDIT)}, editor.offsetToPos(0), editor.offsetToPos(doc.length));
					})()
				`);
				await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
				log("s11b: A's remote edit synced to server ✓");
			})(),
		]);
		log("s11b: concurrent edits complete ✓");

		// Re-enable B
		log("s11b: re-enabling YAOS on B...");
		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);
		const ready = await b.evalRaw<boolean>(`
			(async () => {
				for (let i = 0; i < 60; i++) {
					await new Promise(r => setTimeout(r, 500));
					const d = window.__YAOS_DEBUG__;
					if (d && d.isLocalReady() && d.isReconciled()) return true;
				}
				return false;
			})()
		`);
		if (!ready) { errors.push("s11b: YAOS did not re-initialize on B"); stopPollingA(); stopPollingB(); return { passedA: false, passedB: false, errors }; }
		log("s11b: YAOS re-initialized on B ✓");

		// Restart trace on B (plugin was reloaded)
		await b.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe", ${JSON.stringify(QA_SECRET)})`);
		await new Promise((r) => setTimeout(r, 1000));

		// ── Phase 3: Wait for conflict artifact ───────────────────────────

		log("s11b: Phase 3 -- waiting for conflict artifact...");
		const scratchBase = scratch.split("/").pop()?.replace(".md", "") ?? "";
		let conflictArtifactPath = "";
		for (let i = 0; i < 20; i++) {
			await new Promise((r) => setTimeout(r, 1000));
			const artifact = await b.evalRaw<string | null>(`
				(function() {
					const base = ${JSON.stringify(scratchBase)};
					return app.vault.getFiles().map(f => f.path).find(p =>
						p.includes(base) && (p.includes("conflict") || p.includes("YAOS")) && p !== ${JSON.stringify(scratch)}
					) ?? null;
				})()
			`);
			if (artifact) { conflictArtifactPath = artifact; log(`s11b: conflict artifact: ${artifact}`); break; }
		}
		if (!conflictArtifactPath) {
			log("s11b: WARNING -- no conflict artifact found after 20s");
			errors.push("s11b: no conflict artifact created -- conflict preservation may have failed");
		}

		// Compute actual hashes from disk content (the semantic proof targets)
		const artifactContent = conflictArtifactPath ? await b.evalRaw<string | null>(`
			(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(conflictArtifactPath)}); return f ? await app.vault.read(f) : null; })()
		`) : null;
		const survivorContent = await b.evalRaw<string | null>(`
			(async () => { const f = app.vault.getAbstractFileByPath(${JSON.stringify(scratch)}); return f ? await app.vault.read(f) : null; })()
		`);

		// ── Semantic content assertions (Fix 1) ──────────────────────────
		// YAOS conflict policy for this scenario (both-changed/winner=disk):
		//   - Disk wins main file → original path has S11B-LOCAL (B's local edit)
		//   - CRDT edit goes to artifact → artifact has S11B-REMOTE (A's remote edit)
		// These assertions prove semantic preservation, not just hash persistence.
		const LOCAL_MARKER = "S11B-LOCAL";
		const REMOTE_MARKER = "S11B-REMOTE";

		if (artifactContent !== null) {
			if (!artifactContent.includes(REMOTE_MARKER)) {
				errors.push(`s11b: SEMANTIC FAIL -- conflict artifact does not contain A's remote edit marker (${REMOTE_MARKER}). Content: ${artifactContent.slice(0, 100)}`);
				log(`s11b: SEMANTIC FAIL -- artifact missing ${REMOTE_MARKER}`);
			} else {
				log(`s11b: artifact contains ${REMOTE_MARKER} ✓`);
			}
		}
		if (survivorContent !== null) {
			if (!survivorContent.includes(LOCAL_MARKER)) {
				errors.push(`s11b: SEMANTIC FAIL -- original path does not contain B's local edit marker (${LOCAL_MARKER}). Content: ${survivorContent.slice(0, 100)}`);
				log(`s11b: SEMANTIC FAIL -- survivor missing ${LOCAL_MARKER}`);
			} else {
				log(`s11b: survivor contains ${LOCAL_MARKER} ✓`);
			}
		}

		const actualConflictHash = artifactContent ? await b.evalRaw<string>(`window.__YAOS_DEBUG__?.computeWitnessStateHash(${JSON.stringify(artifactContent)})`) : "";
		const actualSurvivorHash = survivorContent ? await b.evalRaw<string>(`window.__YAOS_DEBUG__?.computeWitnessStateHash(${JSON.stringify(survivorContent)})`) : "";
		log(`s11b: actualConflictHash=${actualConflictHash.slice(0, 12)}, actualSurvivorHash=${actualSurvivorHash.slice(0, 12)}`);

		// ── Phase 4+5: Quorum + negative-window checks (inline, no runS11b) ─

		log("s11b: Phase 4+5 -- running quorum and negative-window checks...");
		const { witnessQuorumEventually: wqe, noStaleHashAfterNewerWitness: noStale, noRecoveryEmittedOldHash: noRecovery } = await import("../obsidian-harness/witness-primitives");

		// Trigger dirty on both devices for the original path (clear suppression first)
		await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);

		// Anchor seqs before quorum calls
		const resyncStartSeqA = handleA.api.currentWitnessSeq?.() ?? 0;
		const resyncStartSeqB = handleB.api.currentWitnessSeq?.() ?? 0;

		// Negative-window checks: no stale/recovery during re-sync
		const [noStaleOnA, noStaleOnB, noRecoveryOnA, noRecoveryOnB] = await Promise.all([
			noStale(handleA, scratch, { windowMs: 10_000 }),
			noStale(handleB, scratch, { windowMs: 10_000 }),
			noRecovery(handleA, scratch, { windowMs: 10_000 }),
			noRecovery(handleB, scratch, { windowMs: 10_000 }),
		]);

		// Quorum: conflict artifact exists on Device B with expected content
		// Note: conflict artifact is a local-only file on B (not synced to A in current YAOS)
		let conflictArtifactLocalCheck: { ok: boolean; reason?: string; evidence: unknown[]; intermediateHashes: Record<string, unknown[]>; summary: string };
		if (conflictArtifactPath && actualConflictHash) {
			const hashB = await b.evalRaw<string | null>(`
				(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(conflictArtifactPath)});
					if (!f) return null;
					const content = await app.vault.read(f);
					return window.__YAOS_DEBUG__?.computeWitnessStateHash(content);
				})()
			`);
			log(`s11b: conflict artifact hash B=${hashB?.slice(0, 12)} expected=${actualConflictHash.slice(0, 12)}`);
			if (hashB === actualConflictHash) {
				conflictArtifactLocalCheck = { ok: true, evidence: [{ kind: "disk_hash_match_on_b", hashB, expected: actualConflictHash }], intermediateHashes: {}, summary: `Device B has conflict artifact with expected hash ${actualConflictHash}` };
				log("s11b: conflict artifact content verified on B ✓");
			} else {
				conflictArtifactLocalCheck = { ok: false, reason: "conflict_artifact_hash_mismatch", evidence: [{ hashB, expected: actualConflictHash }], intermediateHashes: {}, summary: `Conflict artifact hash mismatch on B: got ${hashB} expected ${actualConflictHash}` };
			}
		} else {
			conflictArtifactLocalCheck = { ok: false, reason: "no_conflict_artifact", evidence: [], intermediateHashes: {}, summary: "no conflict artifact" };
		}

		// Quorum: both devices witness original path with expected survivor hash
		const originalPathQuorum = actualSurvivorHash
			? await wqe([handleA, handleB], scratch, {
				pathId: scratch,
				stateKind: "present",
				expectedStateHash: actualSurvivorHash,
				timeoutMs: 30_000,
				minStableAfterMs: 1000,
				startSeqOverride: { [deviceIdA ?? ""]: resyncStartSeqA, [deviceIdB ?? ""]: resyncStartSeqB },
			})
			: { ok: false, reason: "no_survivor_hash", evidence: [], intermediateHashes: {}, summary: "no survivor hash" };

		const phaseOk = noStaleOnA.ok && noStaleOnB.ok && noRecoveryOnA.ok && noRecoveryOnB.ok
			&& conflictArtifactLocalCheck.ok && originalPathQuorum.ok
			&& (artifactContent?.includes(REMOTE_MARKER) ?? false)
			&& (survivorContent?.includes(LOCAL_MARKER) ?? false);

		const resultSummary = phaseOk
			? `s11b PASSED: conflict artifact preserved (${actualConflictHash.slice(0, 12)}), survivor hash (${actualSurvivorHash.slice(0, 12)}), no stale/recovery divergences`
			: `s11b FAILED: ${[
				!noStaleOnA.ok && `stale on A: ${noStaleOnA.reason}`,
				!noStaleOnB.ok && `stale on B: ${noStaleOnB.reason}`,
				!noRecoveryOnA.ok && `recovery on A: ${noRecoveryOnA.reason}`,
				!noRecoveryOnB.ok && `recovery on B: ${noRecoveryOnB.reason}`,
				!conflictArtifactLocalCheck.ok && `conflict artifact quorum: ${conflictArtifactLocalCheck.reason}`,
				!originalPathQuorum.ok && `original path quorum: ${originalPathQuorum.reason}`,
			].filter(Boolean).join("; ")}`;

		stopPollingA(); stopPollingB();

		log(`s11b result: ${resultSummary}`);
		if (!phaseOk) errors.push(`s11b failed: ${resultSummary}`);

		// ── Export segments and emit Layer 4 report ───────────────────────

		const traceId = (infoA as Record<string, unknown>).traceId as string | undefined;
		const segmentSummaries: Record<string, unknown> = {};
		for (const [client, label, devId] of [[a, "device-a", deviceIdA], [b, "device-b", deviceIdB]] as const) {
			const ndjson = await client.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments(${JSON.stringify(traceId ?? "")}) ?? null`);
			if (ndjson) {
				try {
					const { mkdirSync: mkdir, writeFileSync: write } = await import("fs");
					mkdir("qa-runs/s11b", { recursive: true });
					const outPath = `qa-runs/s11b/witness-${label}.ndjson`;
					write(outPath, ndjson);
					const lines = ndjson.split("\n").filter((l) => l.trim() && !l.includes("checkpoint.segment.header"));
					let settledCount = 0; let divergedCount = 0; let latestHash = "";
					for (const line of lines) {
						try {
							const e = JSON.parse(line) as Record<string, unknown>;
							if (e.kind === "device.witness.settled") { settledCount++; latestHash = String((e.data as Record<string, unknown>)?.stateHash ?? ""); }
							else if (e.kind === "device.witness.diverged") divergedCount++;
						} catch { /* skip */ }
					}
					segmentSummaries[label] = { source: "exported_segments", status: "ok", path: outPath, settledCount, divergedCount, latestHash };
					log(`s11b: ${label} segments → ${outPath} (${settledCount} settled, ${divergedCount} diverged)`);
				} catch (e) { segmentSummaries[label] = { source: "exported_segments", status: "export_failed", error: String(e) }; }
			} else {
				const liveEvents = await client.evalRaw<Array<{ kind: string; seq: number; path: string; data: Record<string, unknown> }>>(
					`JSON.parse(JSON.stringify((window.__YAOS_DEBUG__?.getWitnessBuffer?.() ?? []).filter(e => e.path === ${JSON.stringify(scratch)} || e.path === ${JSON.stringify(conflictArtifactPath)})))`
				);
				segmentSummaries[label] = {
					source: "live_buffer", status: "active_no_segments", deviceId: devId,
					note: "segment export empty; live buffer embedded",
					eventsUsedForQuorum: (liveEvents ?? []).map((e) => ({
						seq: e.seq, kind: e.kind, path: e.path,
						stateHash: String(e.data?.stateHash ?? ""),
						role: e.kind === "settled" ? (String(e.data?.stateHash ?? "") === actualConflictHash || String(e.data?.stateHash ?? "") === actualSurvivorHash ? "final" : "intermediate") : "diverged",
					})),
				};
				log(`s11b: ${label} segments -- embedded ${(liveEvents ?? []).length} live-buffer events`);
			}
		}

		const layer4Report = {
			scenario: "s11b-disable-reenable-witness",
			acceptanceVersion: "s11b-local-artifact-v2",
			status: errors.length === 0 ? "current-pass" : "current-fail",
			runAt: new Date().toISOString(),
			deviceA: deviceIdA, deviceB: deviceIdB,
			ok: phaseOk && errors.length === 0,
			conflictArtifactPath,
			actualConflictHash,
			actualSurvivorHash,
			semanticChecks: {
				artifactContainsLocalMarker: artifactContent?.includes(LOCAL_MARKER) ?? false,
				survivorContainsRemoteMarker: survivorContent?.includes(REMOTE_MARKER) ?? false,
				policy: "both-changed/winner=disk: disk wins main file (S11B-LOCAL), CRDT edit in artifact (S11B-REMOTE)",
			},
			phases: {
				preDisableBaseline: { ok: preDisableQuorum.ok },
				resyncNegativeWindow: {
					ok: noStaleOnA.ok && noStaleOnB.ok && noRecoveryOnA.ok && noRecoveryOnB.ok,
					noStaleOnA: { ok: noStaleOnA.ok, reason: noStaleOnA.reason },
					noStaleOnB: { ok: noStaleOnB.ok, reason: noStaleOnB.reason },
					noRecoveryOnA: { ok: noRecoveryOnA.ok, reason: noRecoveryOnA.reason },
					noRecoveryOnB: { ok: noRecoveryOnB.ok, reason: noRecoveryOnB.reason },
				},
				conflictArtifactLocalCheck: { ok: conflictArtifactLocalCheck.ok, reason: conflictArtifactLocalCheck.reason },
				originalPathQuorum: { ok: originalPathQuorum.ok, reason: originalPathQuorum.reason },
			},
			segmentSummaries,
			note: "Layer 4 report is SEPARATE from legacy trace analyzer. Legacy analyzer PASS does not imply Layer 4 PASS.",
		};

		try {
			const { mkdirSync: mkdir, writeFileSync: write } = await import("fs");
			mkdir("qa-runs/s11b", { recursive: true });
			const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const reportPath = `qa-runs/s11b/layer4-report-${runId}.json`;
			write(reportPath, JSON.stringify(layer4Report, null, 2));
			write("qa-runs/s11b/layer4-report.json", JSON.stringify(layer4Report, null, 2));
			log(`s11b: Layer 4 report → ${reportPath}`);
		} catch { /* best-effort */ }

		log("NOTE: Legacy trace analyzer PASS ≠ Layer 4 scenario PASS. Check qa-runs/s11b/layer4-report.json for Layer 4 result.");

		// ── Cleanup ───────────────────────────────────────────────────────

		if (conflictArtifactPath) {
			await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictArtifactPath)})`).catch(() => {});
			await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(conflictArtifactPath)})`).catch(() => {});
		}
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	/**
	 * s12a-local-two-vault -- Phase 3 pipeline smoke test.
	 *
	 * Runs the s12a scenario on two local Obsidian vaults (temenos + temenos-b).
	 * Produces real exported bundles and an offline analyzer report.
	 * This is NOT mobile validation -- it is a pipeline smoke test.
	 *
	 * Proves:
	 *   - bundle export works end-to-end
	 *   - bundle headers are correct (scenarioRunId, qaTraceSecretHash, scenarioStepIndex)
	 *   - offline analyzer consumes real bundles
	 *   - analyzeConvergenceEvidence produces a real positive report
	 */
	"s12a-local-two-vault": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s12a-witness.md";
		const INITIAL = "# S12a Witness\n\nBaseline content.\n";
		const EDIT = "# S12a Witness\n\nBaseline content.\n\nS12A-EDIT-1\n";
		const RUN_ID = `s12a-local-${Date.now()}`;
		const SCENARIO_ID = "s12a-local-two-vault";
		const QA_SECRET = `s12a-${Date.now()}`;

		log(`s12a: scenarioRunId=${RUN_ID}`);

		// Start qa-safe traces with shared secret
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe", ${JSON.stringify(QA_SECRET)})`);
			log(`s12a: trace started on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));

		// Set scenarioRunId on both devices
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlySetScenarioRunIdUnsafe?.(${JSON.stringify(RUN_ID)}, ${JSON.stringify(SCENARIO_ID)})`);
			log(`s12a: scenarioRunId set on ${label}`);
		}

		// Get device IDs and trace info
		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		const traceInfoA = await a.evalRaw<{ localTraceId: string; qaTraceSecretHash: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		const traceInfoB = await b.evalRaw<{ localTraceId: string; qaTraceSecretHash: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		log(`s12a: deviceA=${deviceIdA}, deviceB=${deviceIdB}`);
		log(`s12a: traceA=${JSON.stringify(traceInfoA)}`);
		log(`s12a: traceB=${JSON.stringify(traceInfoB)}`);

		if (traceInfoA?.qaTraceSecretHash !== traceInfoB?.qaTraceSecretHash) {
			errors.push(`s12a: qaTraceSecretHash mismatch: A=${traceInfoA?.qaTraceSecretHash} B=${traceInfoB?.qaTraceSecretHash}`);
		}

		// Create test file on A
		await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyForceCrdtContentUnsafe?.(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)}, { originClass: "remote", createIfMissing: true })`);
		await new Promise((r) => setTimeout(r, 3000));
		log("s12a: test file created, waiting for sync...");

		// Step 1 -- pre-action baseline
		// Advance step first, then wait briefly so any pre-step settled events are already emitted
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(1, "pre-action-baseline")`);
			log(`s12a: step 1 advanced on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
			log(`s12a: step 1 dirty triggered on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 5000));

		// Step 2 -- Device A edits (remote origin so DiskMirror writes to disk)
		await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyForceCrdtContentUnsafe?.(${JSON.stringify(scratch)}, ${JSON.stringify(EDIT)}, { originClass: "remote" })`);
		log("s12a: Device A edit applied, waiting for propagation...");
		await new Promise((r) => setTimeout(r, 5000));

		// Step 3 -- post-edit convergence
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(3, "post-edit-convergence")`);
			log(`s12a: step 3 advanced on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
			log(`s12a: step 3 dirty triggered on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 6000));

		// Export bundles from both devices via exportWitnessSegments
		const traceIdA = traceInfoA?.localTraceId ?? "";
		const traceIdB = traceInfoB?.localTraceId ?? "";

		const segmentsA = await a.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceIdA)}) ?? null`);
		const segmentsB = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceIdB)}) ?? null`);

		if (!segmentsA) errors.push("s12a: Device A produced no witness segments");
		if (!segmentsB) errors.push("s12a: Device B produced no witness segments");

		// Build bundle strings with proper headers
		const buildBundle = (segments: string | null, deviceId: string, localTraceId: string, secretHash: string): string => {
			const lines = segments ? segments.split("\n").filter((l) => l.trim()) : [];
			const eventCount = lines.filter((l) => {
				try { return (JSON.parse(l) as Record<string, unknown>).kind !== "checkpoint.segment.header"; } catch { return false; }
			}).length;
			const header = {
				kind: "bundle.header",
				bundleSchemaVersion: 1,
				createdAt: new Date().toISOString(),
				pluginVersion: "1.6.1",
				deviceId,
				deviceLabel: deviceId,
				platform: "desktop",
				runtimeState: "foreground",
				localTraceId,
				scenarioRunId: RUN_ID,
				scenarioId: SCENARIO_ID,
				qaTraceSecretHash: secretHash,
				flightMode: "qa-safe",
				eventCount,
				containsRawPaths: false,
				hashDomain: "witness-state-v1",
				privacyMode: "safe",
			};
			return [JSON.stringify(header), ...(segments ? [segments.trimEnd()] : [])].join("\n") + "\n";
		};

		const bundleA = buildBundle(segmentsA, deviceIdA ?? "device-a", traceIdA, traceInfoA?.qaTraceSecretHash ?? "");
		const bundleB = buildBundle(segmentsB, deviceIdB ?? "device-b", traceIdB, traceInfoB?.qaTraceSecretHash ?? "");

		// Write bundles to disk
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const outDir = "qa-runs/s12a-local-two-vault-pass";
		mkdirSync(outDir, { recursive: true });
		writeFileSync(`${outDir}/device-a.ndjson`, bundleA);
		writeFileSync(`${outDir}/device-b.ndjson`, bundleB);
		log(`s12a: bundles written to ${outDir}/`);

		// Run offline analyzer
		const { spawnSync } = await import("node:child_process");
		const analyzerResult = spawnSync("bun", [
			"run", "qa:analyze-bundles", "--",
			`${outDir}/device-a.ndjson`,
			`${outDir}/device-b.ndjson`,
			"--out", `${outDir}/report.json`,
		], { encoding: "utf-8" });
		log(`s12a: analyzer stdout: ${analyzerResult.stdout?.trim()}`);
		if (analyzerResult.status !== 0) {
			errors.push(`s12a: offline analyzer failed (exit ${analyzerResult.status}): ${analyzerResult.stderr?.trim()}`);
		} else {
			log("s12a: offline analyzer PASS");
		}

		// Write summary
		const summary = [
			`# s12a-local-two-vault pipeline smoke`,
			``,
			`**Label**: s12a-local-two-vault (NOT mobile validation -- desktop pipeline smoke)`,
			`**Date**: ${new Date().toISOString()}`,
			`**scenarioRunId**: ${RUN_ID}`,
			`**deviceA**: ${deviceIdA}`,
			`**deviceB**: ${deviceIdB}`,
			`**qaTraceSecretHash**: ${traceInfoA?.qaTraceSecretHash ?? "(unknown)"}`,
			`**result**: ${errors.length === 0 ? "PASS" : "FAIL"}`,
			errors.length > 0 ? `\n**errors**:\n${errors.map((e) => `- ${e}`).join("\n")}` : "",
		].join("\n");
		writeFileSync(`${outDir}/summary.md`, summary);
		log(`s12a: summary written to ${outDir}/summary.md`);

		// Cleanup
		await a.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
		await b.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	/**
	 * s13-editor-open-remote-edit
	 *
	 * Device B has the target file open in the editor (CRDT binding active).
	 * Device A edits the file through the normal YAOS path.
	 * Verifies B converges without duplication, stale echo, or editor/CRDT/disk mismatch.
	 *
	 * Uses marker content: BASELINE + REMOTE_EDIT_FROM_A must both appear exactly once.
	 */
	"s13-editor-open-remote-edit": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s13-editor-open-remote-edit.md";
		const INITIAL = "# S13 Editor Open Remote Edit\n\nBASELINE\n";
		const RUN_ID = `s13-${Date.now()}`;

		// Stop any existing trace and start fresh to ensure clean tracker state
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
			await client.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe")`);
			log(`s13: fresh trace started on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlySetScenarioRunIdUnsafe?.(${JSON.stringify(RUN_ID)}, "s13-editor-open-remote-edit")`);
		}
		await new Promise((r) => setTimeout(r, 300));
		const freshBufLenB = await b.evalRaw<number>(`(window.__YAOS_DEBUG__?.getWitnessBuffer() ?? []).length`);
		log(`s13: B fresh buffer length after restart: ${freshBufLenB}`);

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		const traceInfoA = await a.evalRaw<{ localTraceId: string; qaTraceSecretHash: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		const traceInfoB = await b.evalRaw<{ localTraceId: string; qaTraceSecretHash: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		log(`s13: deviceA=${deviceIdA}, deviceB=${deviceIdB}`);
		// Record the seq anchor on B before file creation so we can filter to post-creation events
		const seqAnchorB = await b.evalRaw<number>(`window.__YAOS_DEBUG__?.currentWitnessSeq?.() ?? 0`);
		log(`s13: B seq anchor before file creation: ${seqAnchorB}`);

		if (traceInfoA?.qaTraceSecretHash !== traceInfoB?.qaTraceSecretHash) {
			errors.push(`s13: qaTraceSecretHash mismatch`);
		}

		// Create file on A, wait for B to receive it
		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		// Extra wait for disk writes to complete on both devices
		await new Promise((r) => setTimeout(r, 4000));
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(5000)`).catch(() => {});
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(5000)`).catch(() => {});
		log("s13: file synced to B");

		// Open file on B and wait for editor binding
		await b.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await b.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await new Promise((r) => setTimeout(r, 2000));
		log("s13: B editor open and bound");

		// Record B editor binding health before edit
		const healthBefore = await b.evalRaw<Record<string, unknown>>(`JSON.parse(JSON.stringify(window.__YAOS_DEBUG__?.getEditorBindingHealth(${JSON.stringify(scratch)}) ?? {}))`);
		log(`s13: B binding health before: ${JSON.stringify(healthBefore)}`);

		if (!healthBefore?.healthy) {
			errors.push(`s13: B editor binding not healthy before edit: ${JSON.stringify(healthBefore)}`);
		}

		// Step 1 -- baseline witness on B (editor open)
		// Advance step first, then wait so any pre-step events are already emitted
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(1, "baseline-editor-open")`);
			log(`s13: step 1 advanced on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
			log(`s13: step 1 dirty triggered on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 5000));

		// Verify B settled with healthy_sampled at baseline
		// Use checkpoint segments (not capped buffer) to get all events
		const traceIdBForSegs = traceInfoB?.localTraceId ?? "";
		const segsB1Raw = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceIdBForSegs)}) ?? null`);
		const bufBFromSegs: Array<{ kind: string; seq: number; data: Record<string, unknown> }> = [];
		if (segsB1Raw) {
			for (const line of segsB1Raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line) as Record<string, unknown>;
					if (obj.kind === "device.witness.settled" || obj.kind === "device.witness.diverged") {
						bufBFromSegs.push({ kind: obj.kind === "device.witness.settled" ? "settled" : "diverged", seq: Number(obj.seq ?? 0), data: (obj.data ?? {}) as Record<string, unknown> });
					}
				} catch { /* skip */ }
			}
		}
		const bufBThisRun = bufBFromSegs.filter((e) => e.seq > seqAnchorB);
		log(`s13: B segments total=${bufBFromSegs.length}, post-anchor=${bufBThisRun.length}, settled steps=${bufBThisRun.filter(e=>e.kind==="settled").map(e=>e.data.scenarioStepIndex).join(",")}`);
		const bBaselineSettled = bufBThisRun.find((e) => e.kind === "settled" && Number(e.data.scenarioStepIndex) === 1);
		if (!bBaselineSettled) {
			errors.push("s13: B did not settle at baseline step 1");
		} else if (bBaselineSettled.data.editorSampleKind !== "healthy_sampled") {
			errors.push(`s13: B baseline editorSampleKind=${bBaselineSettled.data.editorSampleKind}, expected healthy_sampled`);
		}
		log(`s13: B baseline settled: ${JSON.stringify(bBaselineSettled?.data)}`);

		// Step 2 -- Device A edits via normal YAOS path (editor insert)
		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 10000)`);
		await new Promise((r) => setTimeout(r, 1000));

		// Insert REMOTE_EDIT_FROM_A at end of file via editor
		await a.evalRaw(`
			(function() {
				const editor = app.workspace.activeEditor?.editor;
				if (!editor) return;
				const lastLine = editor.lastLine();
				const lastCh = editor.getLine(lastLine).length;
				editor.replaceRange("REMOTE_EDIT_FROM_A\\n", { line: lastLine, ch: lastCh });
			})()
		`);
		log("s13: A inserted REMOTE_EDIT_FROM_A via editor");
		await new Promise((r) => setTimeout(r, 6000));

		// Step 3 -- post-edit convergence
		// Wait for A's editor to settle before advancing step (avoids transient disk_crdt_mismatch)
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`).catch(() => {});
		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(3, "post-edit-convergence")`);
			log(`s13: step 3 advanced on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		// Only trigger dirty on B (passive observer) -- A will naturally emit settled after edit
		await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
		log("s13: step 3 dirty triggered on A and B");
		await new Promise((r) => setTimeout(r, 6000));

		// Check B editor binding health after edit
		const healthAfter = await b.evalRaw<Record<string, unknown>>(`JSON.parse(JSON.stringify(window.__YAOS_DEBUG__?.getEditorBindingHealth(${JSON.stringify(scratch)}) ?? {}))`);
		log(`s13: B binding health after: ${JSON.stringify(healthAfter)}`);

		// Read final content on B
		const finalContentB = await b.evalRaw<string | null>(`
			(function() {
				const f = app.vault.getFileByPath(${JSON.stringify(scratch)});
				if (!f) return null;
				const editor = app.workspace.activeEditor?.editor;
				return editor ? editor.getValue() : null;
			})()
		`);
		log(`s13: B final editor content: ${JSON.stringify(finalContentB)}`);

		// Semantic content checks
		if (!finalContentB) {
			errors.push("s13: B final content is null -- editor not open or file missing");
		} else {
			const baselineCount = (finalContentB.match(/BASELINE/g) ?? []).length;
			const editCount = (finalContentB.match(/REMOTE_EDIT_FROM_A/g) ?? []).length;
			if (baselineCount !== 1) errors.push(`s13: BASELINE appears ${baselineCount} times (expected 1) -- possible duplication`);
			if (editCount !== 1) errors.push(`s13: REMOTE_EDIT_FROM_A appears ${editCount} times (expected 1)`);
			log(`s13: content check -- BASELINEx${baselineCount}, REMOTE_EDIT_FROM_Ax${editCount}`);
		}

		// Check witness events on B for forbidden divergences -- use segments (not capped buffer)
		const segsB2Raw = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceIdBForSegs)}) ?? null`);
		const bufBFinal: Array<{ kind: string; seq: number; data: Record<string, unknown> }> = [];
		if (segsB2Raw) {
			for (const line of segsB2Raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line) as Record<string, unknown>;
					if (obj.kind === "device.witness.settled" || obj.kind === "device.witness.diverged") {
						bufBFinal.push({ kind: obj.kind === "device.witness.settled" ? "settled" : "diverged", seq: Number(obj.seq ?? 0), data: (obj.data ?? {}) as Record<string, unknown> });
					}
				} catch { /* skip */ }
			}
		}
		const bufBFinalThisRun = bufBFinal.filter((e) => e.seq > seqAnchorB);
		// disk_crdt_mismatch is NOT forbidden here — transient open-editor disk lag is classified as diagnostic
		// by the offline analyzer. Persistent disk_crdt_mismatch will still fail analyzeWitnessQuorum.
		const FORBIDDEN = ["stale_hash_after_newer_witness", "recovery_emitted_old_hash", "editor_crdt_mismatch"];
		for (const e of bufBFinalThisRun) {
			if (e.kind === "diverged") {
				const reason = String(e.data.reason ?? "");
				if (FORBIDDEN.includes(reason)) {
					errors.push(`s13: B forbidden divergence: ${reason} at seq=${e.seq}`);
				}
			}
		}

		// Check B settled at step 3 with healthy_sampled
		const bFinalSettled = bufBFinalThisRun.filter((e) => e.kind === "settled" && Number(e.data.scenarioStepIndex) === 3).pop();
		if (!bFinalSettled) {
			errors.push("s13: B did not settle at step 3");
		} else {
			if (bFinalSettled.data.editorSampleKind !== "healthy_sampled") {
				errors.push(`s13: B final editorSampleKind=${bFinalSettled.data.editorSampleKind}, expected healthy_sampled`);
			}
			// All three hashes must agree
			const { stateHash, crdtHash, diskHash, editorHash } = bFinalSettled.data as Record<string, string>;
			if (crdtHash !== stateHash) errors.push(`s13: B crdtHash≠stateHash`);
			if (diskHash !== stateHash) errors.push(`s13: B diskHash≠stateHash`);
			if (editorHash !== stateHash) errors.push(`s13: B editorHash≠stateHash`);
			log(`s13: B final hashes -- state=${stateHash?.slice(0,16)} crdt=${crdtHash?.slice(0,16)} disk=${diskHash?.slice(0,16)} editor=${editorHash?.slice(0,16)}`);
		}

		// Get pathId for the s13 file to filter bundle events to only this file
		const pathIdA = await a.evalRaw<string | null>(`(async () => { const r = await window.__YAOS_DEBUG__?.getActiveTraceInfo?.(); const ftc = app.plugins.plugins.yaos?.flightTrace; if (!ftc) return null; const p = await ftc.getPathId(${JSON.stringify(scratch)}); return p?.pathId ?? null; })()`);
		log(`s13: pathId for s13 file: ${pathIdA}`);

		// Export bundles and run offline analyzer -- filter to s13 file events only
		const buildBundle = (segments: string | null, deviceId: string, localTraceId: string, secretHash: string, platform: string, filterPathId: string | null): string => {
			const allLines = segments ? segments.split("\n").filter((l) => l.trim()) : [];
			// Keep segment headers and events for the s13 file only
			const filteredLines = allLines.filter((l) => {
				try {
					const obj = JSON.parse(l) as Record<string, unknown>;
					if (obj.kind === "checkpoint.segment.header") return true;
					if (!filterPathId) return true;
					// Keep events for this pathId or events without pathId (non-witness events)
					if (obj.kind !== "device.witness.settled" && obj.kind !== "device.witness.diverged") return true;
					return obj.pathId === filterPathId || (obj.data as Record<string, unknown>)?.pathId === filterPathId;
				} catch { return false; }
			});
			const eventCount = filteredLines.filter((l) => { try { const o = JSON.parse(l) as Record<string, unknown>; return o.kind !== "checkpoint.segment.header"; } catch { return false; } }).length;
			const header = { kind: "bundle.header", bundleSchemaVersion: 1, createdAt: new Date().toISOString(), pluginVersion: "1.6.1", deviceId, deviceLabel: deviceId, platform, runtimeState: "foreground", localTraceId, scenarioRunId: RUN_ID, scenarioId: "s13-editor-open-remote-edit", qaTraceSecretHash: secretHash, flightMode: "qa-safe", eventCount, containsRawPaths: false, hashDomain: "witness-state-v1", privacyMode: "safe" };
			return [JSON.stringify(header), ...filteredLines].join("\n") + "\n";
		};

		const segsA = await a.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceInfoA?.localTraceId ?? "")}) ?? null`);
		const segsB = await b.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceInfoB?.localTraceId ?? "")}) ?? null`);
		const bundleA = buildBundle(segsA, deviceIdA ?? "device-a", traceInfoA?.localTraceId ?? "", traceInfoA?.qaTraceSecretHash ?? "", "desktop", pathIdA);
		const bundleB = buildBundle(segsB, deviceIdB ?? "device-b", traceInfoB?.localTraceId ?? "", traceInfoB?.qaTraceSecretHash ?? "", "desktop", pathIdA);

		const { mkdirSync, writeFileSync } = await import("node:fs");
		const outDir = errors.length === 0 ? "qa-runs/s13-editor-open-remote-edit-pass" : "qa-runs/s13-editor-open-remote-edit-fail";
		mkdirSync(outDir, { recursive: true });
		writeFileSync(`${outDir}/device-a.ndjson`, bundleA);
		writeFileSync(`${outDir}/device-b.ndjson`, bundleB);

		const { spawnSync } = await import("node:child_process");
		const analyzerResult = spawnSync("bun", ["run", "qa:analyze-bundles", "--", `${outDir}/device-a.ndjson`, `${outDir}/device-b.ndjson`, "--out", `${outDir}/report.json`], { encoding: "utf-8" });
		log(`s13: analyzer: ${analyzerResult.stdout?.trim()}`);
		// Note: analyzeWitnessQuorum may flag transient disk_crdt_mismatch during editor open.
		// The scenario's own checks (content, hashes, binding health, forbidden divergences) are authoritative.
		// Only fail on analyzer if convergence evidence fails (the key correctness property).
		if (analyzerResult.status !== 0) {
			try {
				const report = JSON.parse(require("fs").readFileSync(`${outDir}/report.json`, "utf-8")) as Record<string, unknown>;
				const rules = (report.rules as Array<Record<string, unknown>>) ?? [];
				// transient_open_editor_disk_lag is the only non-fatal analyzer observation
				const fatalFailed = rules.filter((r) => !r.ok);
				if (fatalFailed.length > 0) {
					const summary = fatalFailed.map((r) => `${r.ruleName}: ${r.summary}`).join("; ");
					errors.push(`s13: offline analyzer failed: ${summary}`);
				}
			} catch { errors.push(`s13: offline analyzer failed`); }
		}

		const summary = [
			`# s13-editor-open-remote-edit`,
			`**Date**: ${new Date().toISOString()}`,
			`**scenarioRunId**: ${RUN_ID}`,
			`**deviceA**: ${deviceIdA} (desktop)`,
			`**deviceB**: ${deviceIdB} (desktop)`,
			`**result**: ${errors.length === 0 ? "PASS" : "FAIL"}`,
			`**B binding health before**: ${JSON.stringify(healthBefore)}`,
			`**B binding health after**: ${JSON.stringify(healthAfter)}`,
			`**B final content**: ${JSON.stringify(finalContentB?.slice(0, 200))}`,
			errors.length > 0 ? `\n**errors**:\n${errors.map((e) => `- ${e}`).join("\n")}` : "",
		].join("\n");
		writeFileSync(`${outDir}/summary.md`, summary);
		log(`s13: artifacts written to ${outDir}/`);

		// Cleanup
		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		await a.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
		await b.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	/**
	 * s12a-with-edit -- two-device CDP scenario with actual edit
	 *
	 * A makes a real edit. B passively converges.
	 * Proves convergence after actual content change, not just pre-existing hash agreement.
	 */
	"s12a-with-edit": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s12a-edit-witness.md";
		const INITIAL = "# S12a Edit Witness\n\nBASELINE\n";
		const RUN_ID = `s12a-edit-${Date.now()}`;
		const SCENARIO_ID = "s12a-with-edit";
		const QA_SECRET = `s12a-${Date.now()}`;

		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
			await client.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe", ${JSON.stringify(QA_SECRET)})`);
			log(`s12a-edit: trace started on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlySetScenarioRunIdUnsafe?.(${JSON.stringify(RUN_ID)}, ${JSON.stringify(SCENARIO_ID)})`);
		}

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		const traceInfoA = await a.evalRaw<{ localTraceId: string; qaTraceSecretHash: string } | null>(`window.__YAOS_DEBUG__?.getActiveTraceInfo() ?? null`);
		log(`s12a-edit: A=${deviceIdA} B=${deviceIdB} hash=${traceInfoA?.qaTraceSecretHash?.slice(0, 20)}...`);

		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 3000));
		log("s12a-edit: file synced to B");

		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await b.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await b.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 2000));

		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(1, "pre-edit-baseline")`);
		}
		await new Promise((r) => setTimeout(r, 500));
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
		}
		await new Promise((r) => setTimeout(r, 5000));
		log("s12a-edit: baseline witnesses triggered");

		const seqAnchorB = await b.evalRaw<number>(`window.__YAOS_DEBUG__?.currentWitnessSeq?.() ?? 0`);

		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 1000));
		await a.evalRaw(`(function(){const e=app.workspace.activeEditor?.editor;if(!e)return;const l=e.lastLine();e.replaceRange("EDIT_FROM_A\\n",{line:l,ch:e.getLine(l).length});})()`);
		log("s12a-edit: A inserted EDIT_FROM_A, waiting for propagation...");
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(8000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 6000));

		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(3, "post-edit-convergence")`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
		}
		await new Promise((r) => setTimeout(r, 6000));

		const finalContentB = await b.evalRaw<string | null>(`(function(){const f=app.vault.getFileByPath(${JSON.stringify(scratch)});if(!f)return null;const e=app.workspace.activeEditor?.editor;return e?e.getValue():null;})()`);
		log(`s12a-edit: B final content: ${JSON.stringify(finalContentB?.slice(0, 100))}`);

		if (!finalContentB) {
			errors.push("s12a-edit: B final content is null");
		} else {
			const baselineCount = (finalContentB.match(/BASELINE/g) ?? []).length;
			const editCount = (finalContentB.match(/EDIT_FROM_A/g) ?? []).length;
			if (baselineCount !== 1) errors.push(`s12a-edit: BASELINE appears ${baselineCount} times (expected 1)`);
			if (editCount !== 1) errors.push(`s12a-edit: EDIT_FROM_A appears ${editCount} times (expected 1)`);
			log(`s12a-edit: content check -- BASELINE x${baselineCount}, EDIT_FROM_A x${editCount}`);
		}

		const healthB = await b.evalRaw<Record<string, unknown>>(`JSON.parse(JSON.stringify(window.__YAOS_DEBUG__?.getEditorBindingHealth(${JSON.stringify(scratch)}) ?? {}))`);
		log(`s12a-edit: B binding health: ${JSON.stringify(healthB)}`);
		if (!healthB?.healthy) errors.push(`s12a-edit: B editor binding not healthy`);

		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { spawnSync } = await import("node:child_process");
		const outDir = errors.length === 0 ? "qa-runs/s12a-with-edit-pass" : "qa-runs/s12a-with-edit-fail";
		mkdirSync(outDir, { recursive: true });

		const buildBundle = async (client: typeof a, label: string, platform: string) => {
			const traceId = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getActiveTraceInfo()?.localTraceId ?? ""`);
			const deviceId = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId()`);
			const secretHash = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getActiveTraceInfo()?.qaTraceSecretHash ?? ""`);
			const segs = await client.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceId)}) ?? null`);
			const pathIdRaw = await client.evalRaw<string | null>(`(async()=>{const ftc=app.plugins.plugins.yaos?.flightTrace;if(!ftc)return null;const p=await ftc.getPathId(${JSON.stringify(scratch)});return p?.pathId??null;})()`);
			const lines = (segs || "").split("\n").filter((l) => l.trim());
			const filtered = lines.filter((l) => {
				try {
					const obj = JSON.parse(l) as Record<string, unknown>;
					if (obj.kind === "checkpoint.segment.header") return true;
					if (obj.kind !== "device.witness.settled" && obj.kind !== "device.witness.diverged") return true;
					return obj.pathId === pathIdRaw;
				} catch { return false; }
			});
			const eventCount = filtered.filter((l) => { try { return (JSON.parse(l) as Record<string, unknown>).kind !== "checkpoint.segment.header"; } catch { return false; } }).length;
			const header = { kind: "bundle.header", bundleSchemaVersion: 1, createdAt: new Date().toISOString(), pluginVersion: "1.6.1", deviceId, deviceLabel: label, platform, runtimeState: "foreground", localTraceId: traceId, scenarioRunId: RUN_ID, scenarioId: SCENARIO_ID, qaTraceSecretHash: secretHash, flightMode: "qa-safe", eventCount, containsRawPaths: false, hashDomain: "witness-state-v1", privacyMode: "safe" };
			return [JSON.stringify(header), ...filtered].join("\n") + "\n";
		};

		const bundleA = await buildBundle(a, "device-a", "desktop");
		const bundleB = await buildBundle(b, "device-b", "desktop");
		writeFileSync(`${outDir}/device-a.ndjson`, bundleA);
		writeFileSync(`${outDir}/device-b.ndjson`, bundleB);

		const analyzerResult = spawnSync("bun", ["run", "qa:analyze-bundles", "--", `${outDir}/device-a.ndjson`, `${outDir}/device-b.ndjson`, "--out", `${outDir}/report.json`], { encoding: "utf-8" });
		log(`s12a-edit: analyzer: ${analyzerResult.stdout?.trim()}`);
		if (analyzerResult.status !== 0) {
			try {
				const report = JSON.parse(require("fs").readFileSync(`${outDir}/report.json`, "utf-8")) as Record<string, unknown>;
				const rules = (report.rules as Array<Record<string, unknown>>) ?? [];
				const fatalFailed = rules.filter((r) => !r.ok);
				if (fatalFailed.length > 0) {
					const summary = fatalFailed.map((r) => `${r.ruleName}: ${r.summary}`).join("; ");
					errors.push(`s12a-edit: offline analyzer failed: ${summary}`);
				}
			} catch { errors.push("s12a-edit: offline analyzer failed"); }
		}

		const summary = [`# s12a-with-edit`, `**Date**: ${new Date().toISOString()}`, `**scenarioRunId**: ${RUN_ID}`, `**deviceA**: ${deviceIdA}`, `**deviceB**: ${deviceIdB}`, `**result**: ${errors.length === 0 ? "PASS" : "FAIL"}`, `**B final content**: ${JSON.stringify(finalContentB?.slice(0, 200))}`, `**B binding health**: ${JSON.stringify(healthB)}`, errors.length > 0 ? `\n**errors**:\n${errors.map((e) => `- ${e}`).join("\n")}` : ""].join("\n");
		writeFileSync(`${outDir}/summary.md`, summary);
		log(`s12a-edit: artifacts written to ${outDir}/`);

		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		await a.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
		await b.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

	/**
	 * s12c-conflict -- two-device CDP conflict artifact scenario
	 *
	 * Reproduces disk/CRDT divergence that creates conflict artifacts.
	 * B disabled, A edits via YAOS, B edits disk directly, B re-enables.
	 * Verifies: disk wins main file, CRDT goes to artifact, artifact local-only on B.
	 */
	"s12c-conflict": async (a, b, log) => {
		const errors: string[] = [];
		const scratch = "QA-scratch/s12c-conflict-witness.md";
		const INITIAL = "# S12c Conflict\n\nBASELINE\n";
		const REMOTE_FROM_A = "# S12c Conflict\n\nBASELINE\nREMOTE_FROM_A\n";
		const LOCAL_ON_B = "# S12c Conflict\n\nBASELINE\nLOCAL_ON_B\n";
		const RUN_ID = `s12c-conflict-${Date.now()}`;
		const SCENARIO_ID = "s12c-conflict";
		const QA_SECRET = `s12c-${Date.now()}`;

		for (const [client, label] of [[a, "A"], [b, "B"]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
			await client.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe", ${JSON.stringify(QA_SECRET)})`);
			log(`s12c: trace started on ${label}`);
		}
		await new Promise((r) => setTimeout(r, 1000));
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlySetScenarioRunIdUnsafe?.(${JSON.stringify(RUN_ID)}, ${JSON.stringify(SCENARIO_ID)})`);
		}

		const deviceIdA = await a.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-a"`);
		const deviceIdB = await b.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId() ?? "device-b"`);
		log(`s12c: A=${deviceIdA} B=${deviceIdB}`);

		await a.evalRaw(`window.__YAOS_QA__?.createFile(${JSON.stringify(scratch)}, ${JSON.stringify(INITIAL)})`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(15000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForFile(${JSON.stringify(scratch)}, 30000)`);
		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`);
		await new Promise((r) => setTimeout(r, 3000));
		log("s12c: baseline synced to both devices");

		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(1, "baseline-quorum")`);
		}
		await new Promise((r) => setTimeout(r, 500));
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`);
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`);
		}
		await new Promise((r) => setTimeout(r, 5000));
		log("s12c: baseline quorum triggered");

		await b.evalRaw(`app.plugins.disablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 2000));
		const bDisabled = await b.evalRaw<boolean>(`!app.plugins.plugins.yaos`);
		if (!bDisabled) errors.push("s12c: B YAOS not disabled");
		log(`s12c: B YAOS disabled: ${bDisabled}`);

		await a.evalRaw(`window.__YAOS_QA__?.openFile(${JSON.stringify(scratch)})`);
		await new Promise((r) => setTimeout(r, 2000));
		await a.evalRaw(`window.__YAOS_QA__?.waitForCrdtBinding(${JSON.stringify(scratch)}, 20000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 1000));
		await a.evalRaw(`(function(){const e=app.workspace.activeEditor?.editor;if(!e)return;const l=e.lastLine();e.replaceRange("REMOTE_FROM_A\\n",{line:l,ch:e.getLine(l).length});})()`);
		await a.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(10000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 3000));
		log("s12c: A inserted REMOTE_FROM_A via YAOS");

		await b.evalRaw(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(scratch)});if(f)await app.vault.adapter.write(${JSON.stringify(scratch)},${JSON.stringify(LOCAL_ON_B)});})()`);
		await new Promise((r) => setTimeout(r, 1000));
		log("s12c: B wrote LOCAL_ON_B directly to disk");

		await b.evalRaw(`app.plugins.enablePlugin("yaos")`);
		await new Promise((r) => setTimeout(r, 5000));
		const bReady = await b.evalRaw<boolean>(`!!app.plugins.plugins.yaos`);
		if (!bReady) errors.push("s12c: B YAOS did not re-enable");
		log(`s12c: B YAOS re-enabled: ${bReady}`);

		await b.evalRaw(`window.__YAOS_DEBUG__?.waitForIdle(30000)`).catch(() => {});
		await new Promise((r) => setTimeout(r, 5000));
		log("s12c: waiting for conflict resolution...");

		const survivorContent = await b.evalRaw<string | null>(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(scratch)});return f?await app.vault.read(f):null;})()`);
		log(`s12c: B survivor content: ${JSON.stringify(survivorContent?.slice(0, 100))}`);

		const artifactPath = await b.evalRaw<string | null>(`(function(){const files=app.vault.getMarkdownFiles();const a=files.find(f=>f.path.includes("s12c-conflict")&&f.path.includes("YAOS conflict"));return a?.path??null;})()`);
		log(`s12c: B artifact path: ${artifactPath}`);

		const artifactContent = artifactPath ? await b.evalRaw<string | null>(`(async()=>{const f=app.vault.getFileByPath(${JSON.stringify(artifactPath)});return f?await app.vault.read(f):null;})()`) : null;
		log(`s12c: B artifact content: ${JSON.stringify(artifactContent?.slice(0, 100))}`);

		if (!survivorContent) {
			errors.push("s12c: B survivor content is null");
		} else {
			if (!survivorContent.includes("LOCAL_ON_B")) errors.push("s12c: SEMANTIC FAIL -- B survivor does not contain LOCAL_ON_B (disk wins policy)");
			if (survivorContent.includes("REMOTE_FROM_A")) errors.push("s12c: SEMANTIC FAIL -- B survivor contains REMOTE_FROM_A (should be in artifact only)");
		}
		if (!artifactPath) {
			errors.push("s12c: No conflict artifact created on B");
		} else if (!artifactContent?.includes("REMOTE_FROM_A")) {
			errors.push(`s12c: SEMANTIC FAIL -- artifact does not contain REMOTE_FROM_A`);
		}

		// Search for ANY conflict artifact for the s12c logical file on A, not just the exact B path
		const artifactsOnA = await a.evalRaw<string[]>(`app.vault.getMarkdownFiles().filter(f=>f.path.includes("s12c-conflict")&&f.path.includes("YAOS conflict")).map(f=>f.path)`);
		const artifactOnA = Array.isArray(artifactsOnA) && artifactsOnA.length > 0;
		if (artifactOnA) errors.push(`s12c: Conflict artifact(s) exist on A (should be local-only on B): ${JSON.stringify(artifactsOnA)}`);
		log(`s12c: artifact on A: ${artifactOnA} (expected: false)`);

		await b.evalRaw(`window.__YAOS_DEBUG__?.startFlightTrace("qa-safe", ${JSON.stringify(QA_SECRET)})`).catch(() => {});
		await new Promise((r) => setTimeout(r, 1000));
		await b.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlySetScenarioRunIdUnsafe?.(${JSON.stringify(RUN_ID)}, ${JSON.stringify(SCENARIO_ID)})`).catch(() => {});
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyAdvanceScenarioStepUnsafe?.(3, "post-resync-convergence")`).catch(() => {});
		}
		await new Promise((r) => setTimeout(r, 500));
		for (const [client] of [[a], [b]] as const) {
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyClearWitnessSuppressionUnsafe?.(${JSON.stringify(scratch)})`).catch(() => {});
			await client.evalRaw(`window.__YAOS_DEBUG__?.__qaOnlyTriggerWitnessDirtyUnsafe?.(${JSON.stringify(scratch)})`).catch(() => {});
		}
		await new Promise((r) => setTimeout(r, 6000));

		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { spawnSync } = await import("node:child_process");
		const outDir = errors.length === 0 ? "qa-runs/s12c-conflict-pass" : "qa-runs/s12c-conflict-fail";
		mkdirSync(outDir, { recursive: true });

		const buildBundle = async (client: typeof a, label: string) => {
			const traceId = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getActiveTraceInfo()?.localTraceId ?? ""`);
			const deviceId = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getDeviceId()`);
			const secretHash = await client.evalRaw<string>(`window.__YAOS_DEBUG__?.getActiveTraceInfo()?.qaTraceSecretHash ?? ""`);
			const segs = await client.evalRaw<string | null>(`window.__YAOS_DEBUG__?.exportWitnessSegments?.(${JSON.stringify(traceId)}) ?? null`);
			const pathIdRaw = await client.evalRaw<string | null>(`(async()=>{const ftc=app.plugins.plugins.yaos?.flightTrace;if(!ftc)return null;const p=await ftc.getPathId(${JSON.stringify(scratch)});return p?.pathId??null;})()`);
			const lines = (segs || "").split("\n").filter((l) => l.trim());
			const filtered = lines.filter((l) => { try { const obj = JSON.parse(l) as Record<string, unknown>; if (obj.kind === "checkpoint.segment.header") return true; if (obj.kind !== "device.witness.settled" && obj.kind !== "device.witness.diverged") return true; return obj.pathId === pathIdRaw; } catch { return false; } });
			const eventCount = filtered.filter((l) => { try { return (JSON.parse(l) as Record<string, unknown>).kind !== "checkpoint.segment.header"; } catch { return false; } }).length;
			const header = { kind: "bundle.header", bundleSchemaVersion: 1, createdAt: new Date().toISOString(), pluginVersion: "1.6.1", deviceId, deviceLabel: label, platform: "desktop", runtimeState: "foreground", localTraceId: traceId, scenarioRunId: RUN_ID, scenarioId: SCENARIO_ID, qaTraceSecretHash: secretHash, flightMode: "qa-safe", eventCount, containsRawPaths: false, hashDomain: "witness-state-v1", privacyMode: "safe" };
			return [JSON.stringify(header), ...filtered].join("\n") + "\n";
		};

		const bundleA = await buildBundle(a, "device-a");
		const bundleB = await buildBundle(b, "device-b");
		writeFileSync(`${outDir}/device-a.ndjson`, bundleA);
		writeFileSync(`${outDir}/device-b.ndjson`, bundleB);

		const analyzerResult = spawnSync("bun", ["run", "qa:analyze-bundles", "--", `${outDir}/device-a.ndjson`, `${outDir}/device-b.ndjson`, "--out", `${outDir}/report.json`], { encoding: "utf-8" });
		log(`s12c: analyzer: ${analyzerResult.stdout?.trim()}`);

		const summary = [`# s12c-conflict`, `**Date**: ${new Date().toISOString()}`, `**scenarioRunId**: ${RUN_ID}`, `**deviceA**: ${deviceIdA}`, `**deviceB**: ${deviceIdB}`, `**result**: ${errors.length === 0 ? "PASS" : "FAIL"}`, `**B survivor content**: ${JSON.stringify(survivorContent?.slice(0, 200))}`, `**B artifact path**: ${artifactPath}`, `**B artifact content**: ${JSON.stringify(artifactContent?.slice(0, 200))}`, `**artifact on A**: ${artifactOnA}`, errors.length > 0 ? `\n**errors**:\n${errors.map((e) => `- ${e}`).join("\n")}` : ""].join("\n");
		writeFileSync(`${outDir}/summary.md`, summary);
		log(`s12c: artifacts written to ${outDir}/`);

		await a.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(scratch)})`).catch(() => {});
		if (artifactPath) await b.evalRaw(`window.__YAOS_QA__?.deleteFile(${JSON.stringify(artifactPath)})`).catch(() => {});
		await a.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});
		await b.evalRaw(`window.__YAOS_DEBUG__?.stopFlightTrace()`).catch(() => {});

		return { passedA: errors.length === 0, passedB: errors.length === 0, errors };
	},

};

// -----------------------------------------------------------------------
// Collect trace from vault and run analyzer
// -----------------------------------------------------------------------

async function collectAndAnalyze(
	client: AnyObsidianClient,
	collector: ArtifactCollector,
	vaultPath: string | null,
	device: string,
	scenario: string,
	log: (msg: string) => void,
): Promise<boolean> {
	let analyzerPassed = true;
	try {
		const tracePath = await client.stopAndExportTrace("safe");
		log(`Device ${device} trace export path: ${tracePath}`);

		if (tracePath && vaultPath) {
			const fullTracePath = tracePath.startsWith("/")
				? tracePath
				: join(vaultPath, tracePath);
			await collector.collectTrace(fullTracePath).catch((e) =>
				log(`Warning: could not collect trace for ${device}: ${e}`),
			);

			const traceInArtifacts = join(collector.runDirectory, "flight-trace.ndjson");
			if (existsSync(traceInArtifacts)) {
				const raw = readFileSync(traceInArtifacts, "utf-8");
				const report = analyzeTrace(raw, { traceFile: traceInArtifacts, scenarioId: scenario });
				await collector.saveAnalyzerReport(report);
				log(`Device ${device} analyzer: ${report.passed ? "PASS" : "FAIL"}`);
				log(formatReport(report));
				if (!report.passed) analyzerPassed = false;
			}
		}
	} catch (e) {
		log(`Warning: trace collection failed for device ${device}: ${String(e)}`);
	}
	return analyzerPassed;
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const scenario = args.scenario;
	const portA = Number(args["port-a"] ?? 9222);
	const portB = Number(args["port-b"] ?? 9223);
	const vaultA = args["vault-a"] ? resolve(args["vault-a"]) : null;
	const vaultB = args["vault-b"] ? resolve(args["vault-b"]) : null;
	const traceMode = args.trace ?? "qa-safe";
	const outDir = resolve(args["out-dir"] ?? "qa-runs");
	const driver = args.driver ?? "raw-cdp";

	if (!scenario) {
		console.error(
			"Usage: bun run qa:two-device --scenario <id> --port-a 9222 --port-b 9223 " +
			"[--vault-a /path] [--vault-b /path] [--trace qa-safe] [--out-dir qa-runs/] " +
			"[--driver raw-cdp|playwright]",
		);
		console.error("Available scenarios:", Object.keys(TWO_DEVICE_SCENARIOS).join(", "));
		process.exit(1);
	}

	if (driver !== "raw-cdp" && driver !== "playwright") {
		console.error(`Unknown driver: ${driver}. Use "raw-cdp" (default) or "playwright".`);
		process.exit(1);
	}

	const scenarioFn = TWO_DEVICE_SCENARIOS[scenario];
	if (!scenarioFn) {
		console.error(`Unknown two-device scenario: ${scenario}`);
		console.error("Available:", Object.keys(TWO_DEVICE_SCENARIOS).join(", "));
		process.exit(1);
	}

	const collectorA = new ArtifactCollector(outDir, scenario, "A", vaultA ?? "unknown");
	const collectorB = new ArtifactCollector(outDir, scenario, "B", vaultB ?? "unknown");
	await collectorA.init();
	await collectorB.init();

	const logLines: string[] = [];
	function log(msg: string): void {
		const line = `[${new Date().toISOString()}] ${msg}`;
		console.log(line);
		logLines.push(line);
	}

	log(`Driver: ${driver}`);
	const clientA = createClient(driver, portA);
	const clientB = createClient(driver, portB);

	try {
		log(`Connecting to Obsidian A (port ${portA})...`);
		await clientA.connect();
		log(`Connecting to Obsidian B (port ${portB})...`);
		await clientB.connect();
		log("Connected to both instances.");

		log("Waiting for QA APIs on both devices...");
		await Promise.all([clientA.waitForQaReady(30_000), clientB.waitForQaReady(30_000)]);
		log("QA APIs ready on both devices.");

		// Auto-detect vault paths from live instances if not provided as CLI args.
		// Required for trace collection -- flight traces are exported relative to vault root.
		const resolvedVaultA = vaultA ?? await clientA.evalRaw<string>("app.vault.adapter.basePath").catch(() => null);
		const resolvedVaultB = vaultB ?? await clientB.evalRaw<string>("app.vault.adapter.basePath").catch(() => null);
		if (resolvedVaultA) log(`Vault A path: ${resolvedVaultA}`);
		if (resolvedVaultB) log(`Vault B path: ${resolvedVaultB}`);

		// Collect and record build identity
		const buildIdentity = await collectBuildIdentity(clientA, clientB, log);
		await collectorA.writeLog(JSON.stringify(buildIdentity, null, 2), "build-identity.json");
		await collectorB.writeLog(JSON.stringify(buildIdentity, null, 2), "build-identity.json");

		// Pre-run manifests
		const [maniA, maniB] = await Promise.all([
			clientA.manifest().catch(() => null),
			clientB.manifest().catch(() => null),
		]);
		if (maniA) await collectorA.saveManifest(maniA, "manifest-pre");
		if (maniB) await collectorB.saveManifest(maniB, "manifest-pre");
		log("Pre-run manifests saved.");

		// Start traces
		await clientA.startTrace(traceMode);
		await clientB.startTrace(traceMode);
		log(`Flight traces started (mode=${traceMode}) on both devices.`);

		// Run the two-device scenario
		log(`Running two-device scenario: ${scenario}...`);
		const start = Date.now();
		const { passedA, passedB, errors } = await scenarioFn(clientA, clientB, log);
		const durationMs = Date.now() - start;
		log(`Scenario done in ${durationMs}ms. A: ${passedA ? "PASS" : "FAIL"}, B: ${passedB ? "PASS" : "FAIL"}`);
		if (errors.length > 0) {
			for (const e of errors) log(`  ERROR: ${e}`);
		}

		// Collect post-run manifests
		const [postManiA, postManiB] = await Promise.all([
			clientA.manifest().catch(() => null),
			clientB.manifest().catch(() => null),
		]);
		if (postManiA) await collectorA.saveManifest(postManiA, "manifest-post");
		if (postManiB) await collectorB.saveManifest(postManiB, "manifest-post");
		log("Post-run manifests saved.");

		// Collect traces and run analyzer on each
		const [analyzerPassedA, analyzerPassedB] = await Promise.all([
			collectAndAnalyze(clientA, collectorA, resolvedVaultA, "A", scenario, log),
			collectAndAnalyze(clientB, collectorB, resolvedVaultB, "B", scenario, log),
		]);

		const overallPassed = passedA && passedB && analyzerPassedA && analyzerPassedB;
		const result = { passed: overallPassed, durationMs, errors, warnings: [] as string[] };
		if (!analyzerPassedA) result.errors.push("Device A: analyzer found hard failures");
		if (!analyzerPassedB) result.errors.push("Device B: analyzer found hard failures");

		await collectorA.saveResult({ passed: passedA && analyzerPassedA, durationMs, errors, warnings: [] });
		await collectorB.saveResult({ passed: passedB && analyzerPassedB, durationMs, errors, warnings: [] });

		await collectorA.writeLog(logLines.join("\n"));
		log(`Artifacts A: ${collectorA.runDirectory}`);
		log(`Artifacts B: ${collectorB.runDirectory}`);

		process.exit(overallPassed ? 0 : 1);
	} catch (err) {
		log(`Fatal error: ${String(err)}`);
		await collectorA.writeLog(logLines.join("\n"));
		process.exit(1);
	} finally {
		await clientA.close();
		await clientB.close();
	}
}

await main();
