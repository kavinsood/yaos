/**
 * Editor-bound localOnly amplifier guard regression.
 *
 * Spec: .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md
 *
 * Defends against the topology captured in the 2026-05-27 iPad trace
 * (~/temenos/.obsidian/plugins/yaos/flight-logs/2026-05-27/
 *  boot-wL7i012vR4mGXA-1.ndjson, pathId p:476818d2ecba90d4e95e2a0c4f3ad1eb).
 *
 * The bound-file-local-only-divergence branch ran every ~2.36s while the
 * user typed; CRDT length and disk length each grew by exactly +5 per
 * cycle. Existing protections did not catch it:
 *   - BOUND_RECOVERY_LOCK_MS (1500ms) lock expired before the next cycle.
 *   - shouldQuarantineRepeatedRecovery is fingerprint-keyed; every cycle
 *     had a unique (prev, next) so the count never reached 3.
 *   - OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS (1200ms) idle guard exists
 *     in the crdtOnly branch but not in localOnly.
 *
 * This test exercises the two new defenses:
 *   - Scenario 1: localOnly idle guard (recent-editor-activity-local-only)
 *   - Scenario 2: monotonic-growth amplification quarantine
 *   - Scenario 3: fingerprint quarantine still trips on its shape (regression)
 *   - Scenario 4: pause from the idle guard resets the amplification detector
 */

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";
import {
	FLIGHT_KIND,
	FLIGHT_TAXONOMY_VERSION,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../src/telemetry/debug/flightEvents";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}\n        expected=${String(expected)}\n        actual=${String(actual)}`);
	failed++;
}

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

interface CapturedEvent {
	kind: string;
	path: string;
	data: Record<string, unknown>;
	priority: string;
	severity: string;
	source: string;
	layer: string;
}

function asPathEvent(e: FlightPathEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path,
		data: (e.data as Record<string, unknown>) ?? {},
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
	};
}

function asAnyEvent(e: FlightEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path ?? "",
		data: (e.data as Record<string, unknown>) ?? {},
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
	};
}

interface Fixture {
	path: string;
	file: TFile;
	view: MarkdownView;
	doc: Y.Doc;
	ytext: Y.Text;
	captured: CapturedEvent[];
	repairCalls: Array<{ deviceName: string; reason: string }>;
	transactionOrigins: unknown[];
	controller: ReconciliationController;
	setDiskContent(content: string): void;
	setEditorContent(content: string): void;
	setLastEditorActivity(value: number | null): void;
	setBindingHealthy(healthy: boolean): void;
	clearBoundRecoveryLocks(): void;
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
}

function buildFixture(initial: {
	path: string;
	disk: string;
	editor: string;
	crdt: string;
	lastEditorActivity?: number | null;
	bindingHealthy?: boolean;
}): Fixture {
	const path = initial.path;
	let diskContent = initial.disk;
	let editorContent = initial.editor;
	let diskIngestPort: DiskIngestPort | null = null;
	let lastEditorActivity: number | null = initial.lastEditorActivity ?? null;
	let bindingHealthy = initial.bindingHealthy ?? true;

	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, initial.crdt);

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const captured: CapturedEvent[] = [];
	const repairCalls: Array<{ deviceName: string; reason: string }> = [];
	const transactionOrigins: unknown[] = [];

	doc.on("afterTransaction", (txn) => {
		transactionOrigins.push(txn.origin);
	});

	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		captured.push(asPathEvent(event));
	};
	const recordFlightEvent = (event: FlightEventInput): void => {
		captured.push(asAnyEvent(event));
	};

	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => ({
			leafId: "stub-leaf-1",
			storedCmId: "stub-cm-1",
			liveCmId: "stub-cm-1",
			cmMatches: bindingHealthy,
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: bindingHealthy,
			awarenessMatchesProvider: bindingHealthy,
			yTextMatchesExpected: bindingHealthy,
			undoManagerMatchesFacet: bindingHealthy,
			facetFileId: null,
			expectedFileId: null,
		}),
		repair: (_view: MarkdownView, deviceName: string, reason: string): boolean => {
			repairCalls.push({ deviceName, reason });
			recordFlightPathEvent({
				priority: "important",
				kind: FLIGHT_KIND.editorRepairApplied,
				severity: "info",
				scope: "file",
				source: "editorBinding",
				layer: "editor",
				path,
				data: {
					leafId: "stub-leaf-1",
					cmId: "stub-cm-1",
					reason,
					rapidSwitch: false,
				},
			});
			return true;
		},
		rebind: () => {},
		unbindByPath: () => {},
		getLastEditorActivityForPath: () => lastEditorActivity,
	};

	const app = {
		vault: {
			read: async (f: TFile & { path: string }) => {
				if (f.path !== path) throw new Error(`unexpected read: ${f.path}`);
				return diskContent;
			},
			adapter: {
				stat: async () => ({ mtime: 1, size: diskContent.length }),
			},
			getAbstractFileByPath: (p: string) => (p === path ? file : null),
			getMarkdownFiles: () => [file],
		},
		workspace: {
			iterateAllLeaves: (cb: (leaf: { view: MarkdownView }) => void) => {
				cb({ view });
			},
		},
	};

	const vaultSync = {
		getTextForPath: (p: string) => (p === path ? ytext : null),
		serverAckTracker: {
			withActiveOpId: (_opId: string | undefined, fn: () => void) => fn(),
		},
		getFileIdForText: () => "stub-file-id",
	};

	const controller = new ReconciliationController({
		app: app as never,
		getSettings: () => ({ deviceName: "TestDevice" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => vaultSync as never,
		getDiskMirror: () => ({
			isPreservedUnresolved: () => false,
			clearPreservedUnresolved: () => {},
			flushWrite: async () => {},
		}) as never,
		getBlobSync: () => null,
		getEditorBindings: () => editorBindings as never,
		getDiskIndex: () => ({}),
		setDiskIndex: () => {},
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent,
		recordFlightPathEvent,
		registerDiskIngestPort: (p: DiskIngestPort) => { diskIngestPort = p; },
	});

	return {
		path,
		file,
		view,
		doc,
		ytext,
		captured,
		repairCalls,
		transactionOrigins,
		controller,
		setDiskContent: (c) => { diskContent = c; },
		setEditorContent: (c) => { editorContent = c; },
		setLastEditorActivity: (v) => { lastEditorActivity = v; },
		setBindingHealthy: (h) => { bindingHealthy = h; },
		clearBoundRecoveryLocks: () => {
			(controller as unknown as { boundRecoveryLocks: Map<string, number> })
				.boundRecoveryLocks.clear();
		},
		ingestDiskFileNow: (reason: "create" | "modify" = "modify") => {
			if (!diskIngestPort) throw new Error("diskIngestPort not registered");
			return diskIngestPort.ingestDiskFileNow(path, reason);
		},
	};
}

// -------------------------------------------------------------------
// Test 0 — taxonomy bumped, new flight kind present
// -------------------------------------------------------------------

console.log("\n--- Test 0: taxonomy bumped to 10, recovery.amplification.quarantined defined ---");
{
	assertEq(FLIGHT_TAXONOMY_VERSION, 10, "FLIGHT_TAXONOMY_VERSION === 10");
	assertEq(
		FLIGHT_KIND.recoveryAmplificationQuarantined,
		"recovery.amplification.quarantined",
		"FLIGHT_KIND.recoveryAmplificationQuarantined",
	);
}

// -------------------------------------------------------------------
// Scenario 1 — localOnly idle guard fires when editor was just typed
// -------------------------------------------------------------------

console.log("\n--- Scenario 1: localOnly idle guard defers when editor typed recently ---");
{
	const fix = buildFixture({
		path: "Notes/scenario-1.md",
		disk: "DDDDD",
		editor: "DDDDD",
		crdt: "CCC",
		lastEditorActivity: Date.now() - 200, // 200ms ago, well within 3000ms guard
	});

	await fix.ingestDiskFileNow("modify");

	const skipped = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoverySkipped);
	const localOnlySkip = skipped.find(
		(e) => e.data.reason === "recent-editor-activity-local-only",
	);
	assert(localOnlySkip !== undefined, "recovery.skipped emitted with recent-editor-activity-local-only");
	assert(
		typeof localOnlySkip?.data.idleMs === "number" &&
		(localOnlySkip!.data.idleMs as number) >= 0 &&
		(localOnlySkip!.data.idleMs as number) < 3000,
		"idleMs in [0, 3000)",
	);

	const forbidden = fix.captured.filter((e) =>
		e.kind === FLIGHT_KIND.recoveryDecision ||
		e.kind === FLIGHT_KIND.recoveryApplyStart ||
		e.kind === FLIGHT_KIND.recoveryApplyDone ||
		e.kind === FLIGHT_KIND.recoveryAmplificationQuarantined ||
		e.kind === FLIGHT_KIND.recoveryQuarantined ||
		e.kind === FLIGHT_KIND.editorRepairApplied ||
		e.kind === FLIGHT_KIND.editorHealApplied
	);
	assertEq(forbidden.length, 0, "no recovery.* / editor.* events fire on idle-guarded skip");

	assertEq(fix.ytext.toString(), "CCC", "Y.Text unchanged when guard fires");

	// Now move the simulated activity outside the 3000ms guard and try again.
	fix.setLastEditorActivity(Date.now() - 5000);
	const beforeCount = fix.captured.length;
	await fix.ingestDiskFileNow("modify");
	const newEvents = fix.captured.slice(beforeCount);

	const decision = newEvents.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const applyStart = newEvents.find((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	const applyDone = newEvents.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const repair = newEvents.find((e) => e.kind === FLIGHT_KIND.editorRepairApplied);
	assert(decision !== undefined, "second pass: recovery.decision emitted");
	assert(applyStart !== undefined, "second pass: recovery.apply.start emitted");
	assert(applyDone !== undefined, "second pass: recovery.apply.done emitted");
	// Healthy binding: repair must NOT be called. Reviewer item:
	// "Stop unconditional editor repair unless binding health is bad."
	assert(repair === undefined, "second pass: NO editor.repair.applied (binding healthy)");
	// recovery.decision now carries a binding-health snapshot for RCA.
	assertEq(decision?.data.anyBindingUnhealthy, false, "second pass: anyBindingUnhealthy === false");

	assertEq(fix.ytext.toString(), "DDDDD", "Y.Text equals disk after second pass");
}

// -------------------------------------------------------------------
// Scenario 2 — monotonic-growth amplification quarantine on cycle 3
// -------------------------------------------------------------------

console.log("\n--- Scenario 2: monotonic-growth quarantine fires on cycle 3 ---");
{
	const fix = buildFixture({
		path: "Notes/scenario-2.md",
		disk: "x".repeat(50),
		editor: "x".repeat(50),
		crdt: "x".repeat(45), // CRDT trails by 5
		lastEditorActivity: null, // disable the idle guard
	});

	// Cycle 1: prev=45, next=50
	await fix.ingestDiskFileNow("modify");

	// Reset CRDT to trail by 5 again, advance disk and editor by +5.
	// Clear the bound recovery lock so the next attempt re-enters.
	fix.clearBoundRecoveryLocks();
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "x".repeat(50));
	fix.setDiskContent("y".repeat(55));
	fix.setEditorContent("y".repeat(55));

	// Cycle 2: prev=50, next=55
	await fix.ingestDiskFileNow("modify");

	fix.clearBoundRecoveryLocks();
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "y".repeat(55));
	fix.setDiskContent("z".repeat(60));
	fix.setEditorContent("z".repeat(60));

	// Cycle 3: prev=55, next=60 — should quarantine, NOT apply.
	await fix.ingestDiskFileNow("modify");

	const decisions = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const applyStarts = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	const applyDones = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const repairs = fix.captured.filter((e) => e.kind === FLIGHT_KIND.editorRepairApplied);
	const ampQuarantined = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryAmplificationQuarantined);
	const loopDetected = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryLoopDetected);
	const fingerprintQuarantined = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryQuarantined);

	assertEq(decisions.length, 3, "three recovery.decision events (one per cycle)");
	assertEq(applyStarts.length, 2, "only the first two cycles entered apply.start");
	assertEq(applyDones.length, 2, "only the first two cycles emitted apply.done");
	// Healthy binding throughout, so repair is never called even though
	// recovery applied the diff. This is the conditional-repair rule:
	// content recovery and binding repair are independent operations.
	assertEq(repairs.length, 0, "binding healthy throughout: no editor.repair.applied");
	assertEq(ampQuarantined.length, 1, "exactly one recovery.amplification.quarantined event");
	assertEq(loopDetected.length, 1, "exactly one recovery.loop.detected event");
	assertEq(fingerprintQuarantined.length, 0, "fingerprint quarantine did NOT fire (different fingerprints)");

	const ev = ampQuarantined[0]!;
	assertEq(ev.data.reason, "bound-file-local-only-divergence", "reason on amplification event");
	assertEq(ev.data.entries, 3, "entries === 3");
	assertEq(ev.data.firstPrevLen, 45, "firstPrevLen === 45");
	assertEq(ev.data.lastNextLen, 60, "lastNextLen === 60");
	assertEq(ev.data.consistentDelta, true, "consistentDelta === true (every cycle was +5)");
	assertEq(ev.severity, "warn", "severity === warn");
	assertEq(ev.priority, "critical", "priority === critical");
	assertEq(ev.layer, "recovery", "layer === recovery");
	assertEq(ev.source, "reconciliationController", "source === reconciliationController");

	// Y.Text was set to y(55) before cycle 3 entered, and cycle 3 was
	// quarantined before any diff was applied. So Y.Text is still y(55).
	assertEq(fix.ytext.toString(), "y".repeat(55), "Y.Text equals cycle-2 disk after quarantine");
}

// -------------------------------------------------------------------
// Scenario 3 — fingerprint quarantine still fires on identical-diff repeat
// -------------------------------------------------------------------

console.log("\n--- Scenario 3: fingerprint quarantine still trips on its shape ---");
{
	const fix = buildFixture({
		path: "Notes/scenario-3.md",
		disk: "AAA",
		editor: "AAA",
		crdt: "BBB",
		lastEditorActivity: null,
	});

	for (let i = 0; i < 3; i++) {
		if (i > 0) {
			fix.ytext.delete(0, fix.ytext.length);
			fix.ytext.insert(0, "BBB");
		}
		fix.clearBoundRecoveryLocks();
		await fix.ingestDiskFileNow("modify");
	}

	const fingerprint = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryQuarantined);
	const amplification = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryAmplificationQuarantined);
	assertEq(fingerprint.length, 1, "exactly one recovery.quarantined event (fingerprint shape)");
	assertEq(amplification.length, 0, "no recovery.amplification.quarantined event (delta is zero)");
}

// -------------------------------------------------------------------
// Scenario 4 — pause via idle guard resets the amplification detector
// -------------------------------------------------------------------

console.log("\n--- Scenario 4: pause from idle guard resets the amplification detector ---");
{
	const fix = buildFixture({
		path: "Notes/scenario-4.md",
		disk: "x".repeat(50),
		editor: "x".repeat(50),
		crdt: "x".repeat(45),
		lastEditorActivity: null,
	});

	// Cycle 1: monotonic-growth recovery (prev=45, next=50)
	await fix.ingestDiskFileNow("modify");

	// Cycle 2: monotonic-growth recovery (prev=50, next=55)
	fix.clearBoundRecoveryLocks();
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "x".repeat(50));
	fix.setDiskContent("y".repeat(55));
	fix.setEditorContent("y".repeat(55));
	await fix.ingestDiskFileNow("modify");

	const beforePauseCount = fix.captured.length;

	// Now simulate a typing pause: idle guard fires, history clears.
	fix.clearBoundRecoveryLocks();
	fix.setLastEditorActivity(Date.now() - 200); // 200ms ago, within 3000ms guard
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "y".repeat(55));
	fix.setDiskContent("z".repeat(60));
	fix.setEditorContent("z".repeat(60));
	await fix.ingestDiskFileNow("modify");

	const pauseEvents = fix.captured.slice(beforePauseCount);
	const pauseSkip = pauseEvents.find(
		(e) => e.kind === FLIGHT_KIND.recoverySkipped &&
			e.data.reason === "recent-editor-activity-local-only",
	);
	assert(pauseSkip !== undefined, "pause emitted recent-editor-activity-local-only skip");

	// Drop the recent-editor-activity stub so the next call re-enters the
	// recovery branch. The amplification history was cleared by the skip.
	fix.setLastEditorActivity(null);
	fix.clearBoundRecoveryLocks();
	const beforeFinalCount = fix.captured.length;

	// Final cycle: the user resumes. Amplification history was cleared
	// by the pause skip, so this single cycle SHOULD apply normally and
	// SHOULD NOT trip amplification quarantine.
	await fix.ingestDiskFileNow("modify");

	const finalEvents = fix.captured.slice(beforeFinalCount);
	const finalDecision = finalEvents.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const finalApplyStart = finalEvents.find((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	const finalApplyDone = finalEvents.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const finalRepair = finalEvents.find((e) => e.kind === FLIGHT_KIND.editorRepairApplied);
	const finalAmpQuarantined = finalEvents.find((e) => e.kind === FLIGHT_KIND.recoveryAmplificationQuarantined);

	assert(finalDecision !== undefined, "final cycle: recovery.decision emitted");
	assert(finalApplyStart !== undefined, "final cycle: recovery.apply.start emitted");
	assert(finalApplyDone !== undefined, "final cycle: recovery.apply.done emitted");
	// Binding healthy → no repair (conditional-repair rule).
	assert(finalRepair === undefined, "final cycle: NO editor.repair.applied (binding healthy)");
	assert(finalAmpQuarantined === undefined, "final cycle: NO recovery.amplification.quarantined (history cleared)");

	assertEq(fix.ytext.toString(), "z".repeat(60), "Y.Text equals final disk after recovery");
}

// -------------------------------------------------------------------
// Scenario 5 — unhealthy binding gets repaired
// -------------------------------------------------------------------

console.log("\n--- Scenario 5: unhealthy binding triggers editor.repair.applied ---");
{
	const fix = buildFixture({
		path: "Notes/scenario-5.md",
		disk: "DDDDD",
		editor: "DDDDD",
		crdt: "CCC",
		lastEditorActivity: null, // disable idle guard
		bindingHealthy: false,    // force unhealthy from start
	});

	await fix.ingestDiskFileNow("modify");

	const decision = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const applyDone = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const repair = fix.captured.find((e) => e.kind === FLIGHT_KIND.editorRepairApplied);

	assert(decision !== undefined, "unhealthy: recovery.decision emitted");
	assert(applyDone !== undefined, "unhealthy: recovery.apply.done emitted");
	// Unhealthy binding → repair IS called.
	assert(repair !== undefined, "unhealthy binding: editor.repair.applied emitted");
	assertEq(decision?.data.anyBindingUnhealthy, true, "anyBindingUnhealthy === true");
	const health = decision?.data.bindingHealth as Array<{ healthy: boolean; reasons: string[] }>;
	assert(Array.isArray(health) && health.length === 1, "bindingHealth array has one entry");
	assert(health[0]?.healthy === false, "bindingHealth[0].healthy === false");
	assert(health[0]?.reasons.length > 0, "bindingHealth[0].reasons populated");

	// Now flip to healthy and force another recovery — repair must NOT
	// be called this time even though content recovery applies.
	fix.setBindingHealthy(true);
	fix.clearBoundRecoveryLocks();
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "EEE"); // re-establish localOnly divergence
	const beforeCount = fix.captured.length;
	await fix.ingestDiskFileNow("modify");
	const newEvents = fix.captured.slice(beforeCount);
	const newDecision = newEvents.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const newApplyDone = newEvents.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const newRepair = newEvents.find((e) => e.kind === FLIGHT_KIND.editorRepairApplied);
	assert(newDecision !== undefined, "healthy pass: recovery.decision emitted");
	assert(newApplyDone !== undefined, "healthy pass: recovery.apply.done emitted");
	assert(newRepair === undefined, "healthy pass: NO editor.repair.applied");
}

// -------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
