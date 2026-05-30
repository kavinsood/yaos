/**
 * Frontmatter-guard orchestration regression test.
 *
 * Spec: .kiro/specs/frontmatter-guard-orchestration/requirements.md
 *
 * Drives ReconciliationController against an unsafe frontmatter transition
 * (stubbed shouldBlockFrontmatterIngest) and asserts the controller bails
 * without mutating CRDT state, emits a recovery.skipped flight event with
 * data.reason === "frontmatter-ingest-blocked", and produces the expected
 * branch discriminator. Scenarios A through E cover the four
 * handleBoundFileSyncGap block sites and the two syncFileFromDisk block
 * sites by way of the helper-call invariant; the bound branches are
 * exercised end-to-end through __qaOnlyForceSyncFileFromDiskUnsafe.
 *
 * In-scope (ingest direction, six sites in src/runtime/reconciliationController.ts,
 * identified by enclosing function and predicate `reason` literal):
 *   1. syncFileFromDisk, unbound disk-to-CRDT existing-text branch
 *      (predicate reason: "disk-to-crdt"; emit branch: "disk-to-crdt-existing")
 *   2. syncFileFromDisk, unbound disk-to-CRDT seed branch
 *      (predicate reason: "disk-to-crdt-seed"; emit branch: "disk-to-crdt-seed")
 *   3. handleBoundFileSyncGap, localOnly recovery existing-text branch
 *      (predicate reason: "bound-file-local-only-divergence";
 *       emit branch: "bound-file-local-only-divergence")
 *   4. handleBoundFileSyncGap, localOnly recovery seed branch
 *      (predicate reason: "bound-file-local-only-seed";
 *       emit branch: "bound-file-local-only-seed")
 *   5. handleBoundFileSyncGap, crdtOnly recovery existing-text branch
 *      (predicate reason: "bound-file-open-idle-disk-recovery";
 *       emit branch: "bound-file-open-idle-disk-recovery")
 *   6. handleBoundFileSyncGap, crdtOnly recovery seed branch
 *      (predicate reason: "bound-file-open-idle-seed";
 *       emit branch: "bound-file-open-idle-seed")
 *
 * Out-of-scope (egress direction):
 *   - DiskMirror.shouldBlockFrontmatterWrite at src/sync/diskMirror.ts. The
 *     CRDT->disk write-side guard is a separate orchestration-coverage gap
 *     that this test does NOT close. A future spec may close it; this
 *     spec's "no new analyzer rule, no new flight kind, no new harness
 *     primitive" constraints intentionally limit scope to the ingest path.
 *
 * Limitations (deliberate):
 *   - shouldBlockFrontmatterIngest is stubbed; the real predicate
 *     (validateFrontmatterTransition) is exercised by
 *     tests/frontmatter-guard-regressions.mjs.
 *   - The vault edge surface (app.vault.read, adapter.stat,
 *     getAbstractFileByPath) is hand-rolled stubs cast to `any`.
 *   - No live MarkdownView / CodeMirror state; bound-file branches are
 *     exercised against a stub view whose editor.getValue() returns a
 *     fixed string.
 */

import { MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../src/runtime/engineControlPort";
import {
	FLIGHT_KIND,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../src/telemetry/debug/flightEvents";
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
} from "../src/sync/origins";

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
	console.error(
		`  FAIL  ${msg}\n        expected=${String(expected)}\n        actual=${String(actual)}`,
	);
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

interface CapturedTrace {
	source: string;
	msg: string;
	details: unknown;
}

interface FrontmatterFixture {
	path: string;
	file: TFile;
	view: MarkdownView;
	doc: Y.Doc;
	ytext: Y.Text | null;
	getYText(): Y.Text | null;
	captured: CapturedEvent[];
	traces: CapturedTrace[];
	snapshotCalls: string[];
	repairCalls: Array<{ deviceName: string; reason: string }>;
	transactionOrigins: unknown[];
	ensureFileCalls: Array<{ path: string; content: string }>;
	controller: ReconciliationController;
	setDiskContent(content: string): void;
	setEditorContent(content: string): void;
	setShouldBlock(predicate: BlockPredicate): void;
	clearBoundRecoveryLock(): void;
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
}

type BlockPredicate = (
	path: string,
	previousContent: string | null,
	nextContent: string,
	reason: string,
) => boolean;

interface FixtureOptions {
	path: string;
	disk: string;
	editor: string;
	/**
	 * Initial CRDT content. When `null`, the fixture starts with no Y.Text
	 * for the path (vaultSync.getTextForPath returns null) — used to drive
	 * the bound-seed branch.
	 */
	crdt: string | null;
	shouldBlock: BlockPredicate;
	/**
	 * When set to a positive number, the stub editorBindings reports
	 * recent activity that many ms ago. Default null (no recent activity).
	 */
	lastEditorActivityAgoMs?: number | null;
}

function buildFrontmatterFixture(options: FixtureOptions): FrontmatterFixture {
	const path = options.path;
	let diskContent = options.disk;
	let editorContent = options.editor;
	let blockPredicate: BlockPredicate = options.shouldBlock;
	let diskIngestPort: DiskIngestPort | null = null;

	const doc = new Y.Doc();
	let ytext: Y.Text | null = null;
	if (options.crdt !== null) {
		ytext = doc.getText("content");
		ytext.insert(0, options.crdt);
	}

	const file = makeTFile(path);
	const view = new MarkdownView() as MarkdownView & {
		file: TFile;
		editor: { getValue(): string };
	};
	view.file = file;
	view.editor = { getValue: () => editorContent };

	const captured: CapturedEvent[] = [];
	const traces: CapturedTrace[] = [];
	const snapshotCalls: string[] = [];
	const repairCalls: Array<{ deviceName: string; reason: string }> = [];
	const transactionOrigins: unknown[] = [];
	const ensureFileCalls: Array<{ path: string; content: string }> = [];

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
			// Force unhealthy so the localOnly branch's binding-health-
			// conditional repair fires. Healthy-binding skip is exercised
			// by tests/controller-recovery-orchestration-amplifier.ts. See:
			// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R7.
			cmMatches: false,
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: false,
			awarenessMatchesProvider: true,
			yTextMatchesExpected: true,
			undoManagerMatchesFacet: true,
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
		getLastEditorActivityForPath: () => {
			const ago = options.lastEditorActivityAgoMs;
			if (ago == null) return null;
			return Date.now() - ago;
		},
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
		ensureFile: (
			p: string,
			content: string,
			_deviceName: string,
			_options?: unknown,
		) => {
			ensureFileCalls.push({ path: p, content });
			// Mimic real ensureFile: create the Y.Text if it does not exist and
			// seed it from the disk content. This lets Scenario D's second
			// pass (which goes through the bound-localOnly-divergence branch
			// with existingText set) observe a real CRDT state.
			if (p === path && ytext == null) {
				ytext = doc.getText("content");
				if (ytext.length === 0) {
					ytext.insert(0, content);
				}
			}
		},
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
		shouldBlockFrontmatterIngest: (
			p: string,
			previousContent: string | null,
			nextContent: string,
			reason: string,
		) => blockPredicate(p, previousContent, nextContent, reason),
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: (source: string, msg: string, details: unknown) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: (label: string) => {
			snapshotCalls.push(label);
		},
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
		get ytext(): Y.Text | null {
			return ytext;
		},
		getYText: () => ytext,
		captured,
		traces,
		snapshotCalls,
		repairCalls,
		transactionOrigins,
		ensureFileCalls,
		controller,
		setDiskContent: (c) => { diskContent = c; },
		setEditorContent: (c) => { editorContent = c; },
		setShouldBlock: (p) => { blockPredicate = p; },
		clearBoundRecoveryLock: () => {
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
// Scenario A — localOnly recovery branch blocked by frontmatter
// -------------------------------------------------------------------

console.log("\n--- Scenario A: localOnly recovery branch blocked by frontmatter ---");
const scenarioAFix = buildFrontmatterFixture({
	path: "Notes/scenario-a.md",
	// Editor matches disk D; CRDT is C (different) — localOnly precondition.
	disk: "DDDD",
	editor: "DDDD",
	crdt: "CCCC",
	shouldBlock: (_path, _prev, _next, reason) =>
		reason === "bound-file-local-only-divergence",
});

await await scenarioAFix.ingestDiskFileNow("modify");

{
	const skipped = scenarioAFix.captured.filter(
		(e) => e.kind === FLIGHT_KIND.recoverySkipped && e.path === scenarioAFix.path,
	);
	assertEq(skipped.length, 1, "Scenario A: exactly one recovery.skipped event");
	assertEq(
		skipped[0]?.data.reason,
		"frontmatter-ingest-blocked",
		"Scenario A: data.reason === 'frontmatter-ingest-blocked'",
	);
	assertEq(skipped[0]?.data.wasBound, true, "Scenario A: data.wasBound === true");
	assertEq(
		skipped[0]?.data.branch,
		"bound-file-local-only-divergence",
		"Scenario A: data.branch === 'bound-file-local-only-divergence'",
	);
	assertEq(skipped[0]?.layer, "recovery", "Scenario A: layer === 'recovery'");
	assertEq(
		skipped[0]?.source,
		"reconciliationController",
		"Scenario A: source === 'reconciliationController'",
	);
	assertEq(skipped[0]?.severity, "info", "Scenario A: severity === 'info'");
	assertEq(skipped[0]?.priority, "important", "Scenario A: priority === 'important'");

	// Negative invariants: no mutation/repair/quarantine events.
	const mutationKinds = [
		FLIGHT_KIND.recoveryApplyStart,
		FLIGHT_KIND.recoveryApplyDone,
		FLIGHT_KIND.recoveryPostconditionFailed,
		FLIGHT_KIND.recoveryQuarantined,
	];
	for (const kind of mutationKinds) {
		const events = scenarioAFix.captured.filter(
			(e) => e.kind === kind && e.path === scenarioAFix.path,
		);
		assertEq(events.length, 0, `Scenario A: no ${kind} event for the test path`);
	}
	const repairs = scenarioAFix.captured.filter(
		(e) => e.kind === FLIGHT_KIND.editorRepairApplied && e.path === scenarioAFix.path,
	);
	assertEq(repairs.length, 0, "Scenario A: no editor.repair.applied event");
	const heals = scenarioAFix.captured.filter(
		(e) => e.kind === FLIGHT_KIND.editorHealApplied && e.path === scenarioAFix.path,
	);
	assertEq(heals.length, 0, "Scenario A: no editor.heal.applied event");
	assertEq(scenarioAFix.repairCalls.length, 0, "Scenario A: editorBindings.repair not invoked");

	// Y.Text is unchanged.
	const ytext = scenarioAFix.getYText();
	assertEq(ytext?.toString(), "CCCC", "Scenario A: Y.Text still equals CRDT content C");

	// No transaction with the recovery origin occurred.
	assert(
		!scenarioAFix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"Scenario A: no Y.Doc transaction with ORIGIN_DISK_SYNC_RECOVER_BOUND",
	);
}

// -------------------------------------------------------------------
// Scenario B — crdtOnly recovery branch blocked by frontmatter
// -------------------------------------------------------------------

console.log("\n--- Scenario B: crdtOnly recovery branch blocked by frontmatter ---");
const scenarioBFix = buildFrontmatterFixture({
	path: "Notes/scenario-b.md",
	// Editor matches CRDT C; disk is D — crdtOnly precondition.
	disk: "DDDD",
	editor: "CCCC",
	crdt: "CCCC",
	shouldBlock: (_path, _prev, _next, reason) =>
		reason === "bound-file-open-idle-disk-recovery",
	// lastEditorActivityAgoMs unset -> null -> idle-grace bail does NOT fire.
});

await await scenarioBFix.ingestDiskFileNow("modify");

{
	const skipped = scenarioBFix.captured.filter(
		(e) => e.kind === FLIGHT_KIND.recoverySkipped && e.path === scenarioBFix.path,
	);
	assertEq(skipped.length, 1, "Scenario B: exactly one recovery.skipped event");
	assertEq(
		skipped[0]?.data.reason,
		"frontmatter-ingest-blocked",
		"Scenario B: data.reason === 'frontmatter-ingest-blocked'",
	);
	assertEq(skipped[0]?.data.wasBound, true, "Scenario B: data.wasBound === true");
	assertEq(
		skipped[0]?.data.branch,
		"bound-file-open-idle-disk-recovery",
		"Scenario B: data.branch === 'bound-file-open-idle-disk-recovery'",
	);

	// Negative invariants.
	const mutationKinds = [
		FLIGHT_KIND.recoveryApplyStart,
		FLIGHT_KIND.recoveryApplyDone,
		FLIGHT_KIND.recoveryPostconditionFailed,
		FLIGHT_KIND.recoveryQuarantined,
		FLIGHT_KIND.editorRepairApplied,
		FLIGHT_KIND.editorHealApplied,
	];
	for (const kind of mutationKinds) {
		const events = scenarioBFix.captured.filter(
			(e) => e.kind === kind && e.path === scenarioBFix.path,
		);
		assertEq(events.length, 0, `Scenario B: no ${kind} event for the test path`);
	}

	// Y.Text unchanged.
	const ytext = scenarioBFix.getYText();
	assertEq(ytext?.toString(), "CCCC", "Scenario B: Y.Text still equals CRDT content C");

	// No transaction with the open-idle-recover origin.
	assert(
		!scenarioBFix.transactionOrigins.includes(ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER),
		"Scenario B: no Y.Doc transaction with ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER",
	);
}

// -------------------------------------------------------------------
// Scenario C — seed branch blocked by frontmatter
// -------------------------------------------------------------------
//
// Note: this fixture intentionally combines isBound(path) === true with
// getTextForPath(path) === null. That is an inconsistent state in a healthy
// editor binding, but it is exactly the path needed to drive the
// handleBoundFileSyncGap seed branch with existingText === null. The
// invariant under test is the controller's behavior at the seed branch,
// NOT the realism of the editor binding.

console.log("\n--- Scenario C: seed branch blocked by frontmatter ---");
const scenarioCFix = buildFrontmatterFixture({
	path: "Notes/scenario-c.md",
	disk: "DDDD",
	editor: "DDDD",
	crdt: null, // no Y.Text yet -> seed branch
	shouldBlock: (_path, _prev, _next, reason) =>
		reason === "bound-file-local-only-seed",
});

await await scenarioCFix.ingestDiskFileNow("modify");

{
	const skipped = scenarioCFix.captured.filter(
		(e) => e.kind === FLIGHT_KIND.recoverySkipped && e.path === scenarioCFix.path,
	);
	assertEq(skipped.length, 1, "Scenario C: exactly one recovery.skipped event");
	assertEq(
		skipped[0]?.data.reason,
		"frontmatter-ingest-blocked",
		"Scenario C: data.reason === 'frontmatter-ingest-blocked'",
	);
	assertEq(skipped[0]?.data.wasBound, true, "Scenario C: data.wasBound === true");
	assertEq(
		skipped[0]?.data.branch,
		"bound-file-local-only-seed",
		"Scenario C: data.branch === 'bound-file-local-only-seed'",
	);

	assertEq(
		scenarioCFix.ensureFileCalls.length,
		0,
		"Scenario C: vaultSync.ensureFile NOT invoked for the test path",
	);
	const fileCreated = scenarioCFix.captured.filter(
		(e) => e.kind === FLIGHT_KIND.crdtFileCreated && e.path === scenarioCFix.path,
	);
	assertEq(fileCreated.length, 0, "Scenario C: no crdt.file.created event");

	// getTextForPath still returns null after the call — no CRDT entry was created.
	assertEq(scenarioCFix.getYText(), null, "Scenario C: getTextForPath still returns null");
}

// -------------------------------------------------------------------
// Scenario D — clear-and-readmit cycle (extends Scenario A)
// -------------------------------------------------------------------

console.log("\n--- Scenario D: clear-and-readmit cycle ---");
{
	// Capture the event count from the first pass so we can isolate the
	// second-pass deltas.
	const firstPassCount = scenarioAFix.captured.length;
	const firstPassTransactionCount = scenarioAFix.transactionOrigins.length;

	// Change disk content from D (unsafe) to D2 (safe). Editor follows disk
	// (the user's "fix" landed in the editor first, then on disk).
	scenarioAFix.setDiskContent("DDDD2");
	scenarioAFix.setEditorContent("DDDD2");

	// Re-wire shouldBlockFrontmatterIngest: the new transition is safe.
	// previousContent is the current CRDT (still C), nextContent is D2,
	// reason is "bound-file-local-only-divergence".
	scenarioAFix.setShouldBlock(() => false);

	// Clear bound recovery lock so the lock-active bail does not fire.
	scenarioAFix.clearBoundRecoveryLock();

	await scenarioAFix.ingestDiskFileNow("modify");

	const secondPassEvents = scenarioAFix.captured.slice(firstPassCount);
	const secondPassPathEvents = secondPassEvents.filter((e) => e.path === scenarioAFix.path);
	const recoveryAndEditorKinds = secondPassPathEvents
		.filter((e) => e.layer === "recovery" || e.layer === "editor")
		.map((e) => e.kind);

	assert(
		recoveryAndEditorKinds.includes(FLIGHT_KIND.recoveryDecision),
		"Scenario D: second pass emits recovery.decision",
	);
	assert(
		recoveryAndEditorKinds.includes(FLIGHT_KIND.recoveryApplyStart),
		"Scenario D: second pass emits recovery.apply.start",
	);
	assert(
		recoveryAndEditorKinds.includes(FLIGHT_KIND.recoveryApplyDone),
		"Scenario D: second pass emits recovery.apply.done",
	);
	assert(
		recoveryAndEditorKinds.includes(FLIGHT_KIND.editorRepairApplied),
		"Scenario D: second pass emits editor.repair.applied",
	);

	// Order: decision, apply.start, apply.done, editor.repair.applied.
	const decisionIdx = recoveryAndEditorKinds.indexOf(FLIGHT_KIND.recoveryDecision);
	const startIdx = recoveryAndEditorKinds.indexOf(FLIGHT_KIND.recoveryApplyStart);
	const doneIdx = recoveryAndEditorKinds.indexOf(FLIGHT_KIND.recoveryApplyDone);
	const repairIdx = recoveryAndEditorKinds.indexOf(FLIGHT_KIND.editorRepairApplied);
	assert(
		decisionIdx < startIdx && startIdx < doneIdx && doneIdx < repairIdx,
		"Scenario D: ordering is decision -> apply.start -> apply.done -> editor.repair.applied",
	);

	const decision = secondPassPathEvents.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assertEq(
		decision?.data.reason,
		"bound-file-local-only-divergence",
		"Scenario D: recovery.decision.reason === 'bound-file-local-only-divergence'",
	);
	const applyDone = secondPassPathEvents.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	assertEq(applyDone?.data.matchesExpected, true, "Scenario D: recovery.apply.done matchesExpected === true");

	// No new recovery.skipped event in the second pass.
	const newSkipped = secondPassPathEvents.filter(
		(e) => e.kind === FLIGHT_KIND.recoverySkipped,
	);
	assertEq(newSkipped.length, 0, "Scenario D: no new recovery.skipped event in second pass");

	// Y.Text equals D2 after the second pass.
	const ytext = scenarioAFix.getYText();
	assertEq(ytext?.toString(), "DDDD2", "Scenario D: Y.Text equals disk content D2");

	// Transaction with ORIGIN_DISK_SYNC_RECOVER_BOUND from the second pass; zero from the first.
	const newTransactions = scenarioAFix.transactionOrigins.slice(firstPassTransactionCount);
	const newRecoverBoundTxns = newTransactions.filter(
		(o) => o === ORIGIN_DISK_SYNC_RECOVER_BOUND,
	);
	assertEq(
		newRecoverBoundTxns.length,
		1,
		"Scenario D: exactly one transaction with ORIGIN_DISK_SYNC_RECOVER_BOUND from second pass",
	);
	const firstPassTransactions = scenarioAFix.transactionOrigins.slice(0, firstPassTransactionCount);
	const oldRecoverBoundTxns = firstPassTransactions.filter(
		(o) => o === ORIGIN_DISK_SYNC_RECOVER_BOUND,
	);
	assertEq(
		oldRecoverBoundTxns.length,
		0,
		"Scenario D: zero transactions with ORIGIN_DISK_SYNC_RECOVER_BOUND from first pass",
	);
}

// -------------------------------------------------------------------
// Scenario E — secondary trace channel observability
// -------------------------------------------------------------------
//
// E1: For Scenario A (a bound localOnly block), the legacy
//     scheduleTraceStateSnapshot("frontmatter-ingest-blocked") channel
//     must still fire alongside the new flight event.
//
// E2: For Scenario C (a bound seed block), the same applies — bound
//     handleBoundFileSyncGap call sites all carry the snapshot call.
//
// E3: No "recovery-postcondition-skipped" trace was emitted for the test
//     path during the block pass. That message is the recovery-lock-active
//     trace and must not be conflated with a frontmatter block.
//
// The unbound syncFileFromDisk sites do NOT call scheduleTraceStateSnapshot
// today. This test does NOT assert that they do; the primary
// recovery.skipped flight-event assertion remains the proof for those two
// sites (covered by Requirement 2.3 / 2.4 invariants and the helper-
// invocation check in tests/typed-trace-schema.ts).
//
// If the secondary trace assertion fails but the primary flight assertion
// passed (all earlier asserts in Scenarios A and C produced PASS), the
// failure message below distinguishes "primary signal passed; secondary
// trace channel regressed" from a primary regression.

console.log("\n--- Scenario E: secondary trace channel observability ---");
{
	const scenarioASnapshotCalls = scenarioAFix.snapshotCalls.filter(
		(label) => label === "frontmatter-ingest-blocked",
	);
	assert(
		scenarioASnapshotCalls.length >= 1,
		"Scenario E: scheduleTraceStateSnapshot(\"frontmatter-ingest-blocked\") fired during Scenario A " +
		"(secondary trace channel; primary flight evidence already asserted)",
	);

	const scenarioCSnapshotCalls = scenarioCFix.snapshotCalls.filter(
		(label) => label === "frontmatter-ingest-blocked",
	);
	assert(
		scenarioCSnapshotCalls.length >= 1,
		"Scenario E: scheduleTraceStateSnapshot(\"frontmatter-ingest-blocked\") fired during Scenario C " +
		"(secondary trace channel; primary flight evidence already asserted)",
	);

	// Scenario A's traces SHALL NOT contain a recovery-postcondition-skipped
	// entry for the test path. recovery-postcondition-skipped is the
	// recovery-lock-active free-form trace; it must not be conflated with
	// a frontmatter block.
	const scenarioAPostcondSkipped = scenarioAFix.traces.filter(
		(t) => t.source === "recovery" && t.msg === "recovery-postcondition-skipped",
	);
	assertEq(
		scenarioAPostcondSkipped.length,
		0,
		"Scenario E: no \"recovery-postcondition-skipped\" trace during Scenario A's block pass",
	);

	// Scenario C: same — no recovery-postcondition-skipped during the block.
	const scenarioCPostcondSkipped = scenarioCFix.traces.filter(
		(t) => t.source === "recovery" && t.msg === "recovery-postcondition-skipped",
	);
	assertEq(
		scenarioCPostcondSkipped.length,
		0,
		"Scenario E: no \"recovery-postcondition-skipped\" trace during Scenario C's block pass",
	);
}

// -------------------------------------------------------------------
// Wrap up
// -------------------------------------------------------------------

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
