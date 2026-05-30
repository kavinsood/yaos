/**
 * Controller-level recovery orchestration test.
 *
 * Spec: .kiro/specs/controller-recovery-orchestration/requirements.md
 *
 * Drives a localOnly three-way divergence (editor==disk, ≠ CRDT) end-to-end
 * through ReconciliationController and asserts:
 *   - the recovery.* flight-event timeline
 *   - editor.repair.applied fires once per affected view
 *   - editor.heal.applied does NOT fire
 *   - second-pass on a converged file emits recovery.skipped (crdt-current-no-op)
 *   - bound recovery write does not round-trip as a disk.write.* event
 *   - third identical attempt is quarantined (recovery.quarantined +
 *     recovery.loop.detected) without recovery.apply.*
 *   - ORIGIN_DISK_SYNC_RECOVER_BOUND is in LOCAL_STRING_ORIGIN_SET (the
 *     guard that makes round-trip suppression work)
 *
 * Plus targeted source-grep regressions on src/sync/editorBinding.ts
 * verifying that the real EditorBindingManager emits editor.repair.applied
 * from applyBinding() (action==="repair") and editor.heal.applied from
 * heal() after applyDiffToYText.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import {
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	isLocalOrigin,
	isLocalStringOrigin,
	LOCAL_REPAIR_ORIGINS,
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

// -------------------------------------------------------------------
// Test fixture builder
// -------------------------------------------------------------------

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
	getCurrentDiskContent(): string;
	ingestDiskFileNow(reason?: "create" | "modify"): Promise<void>;
}

function buildFixture(initial: {
	path: string;
	disk: string;
	editor: string;
	crdt: string;
}): Fixture {
	const path = initial.path;
	let diskContent = initial.disk;
	let editorContent = initial.editor;
	let diskIngestPort: DiskIngestPort | null = null;

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

	// Path-scoped flight event capture (used by the controller and the
	// editorBindings stub). Mirrors what main.ts wires through
	// recordFlightPathEvent.
	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		captured.push(asPathEvent(event));
	};

	// Vault-scoped capture (used by DiskMirror). Augments the same array so
	// disk.write.ok / disk.write.failed land in the timeline.
	const recordFlightEvent = (event: FlightEventInput): void => {
		captured.push(asAnyEvent(event));
	};

	// editorBindings stub. Mimics the real EditorBindingManager wiring:
	// repair() succeeds and emits an editor.repair.applied flight event
	// through the same callback the real manager uses (see src/main.ts).
	//
	// NOTE: this fixture intentionally reports an UNHEALTHY binding so the
	// localOnly recovery branch's binding-health-conditional repair fires.
	// Healthy-binding behavior (no repair on every recovery) is exercised
	// by tests/controller-recovery-orchestration-amplifier.ts. See spec:
	// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R7.
	const editorBindings = {
		isBound: () => true,
		getBindingDebugInfoForView: () => ({
			leafId: "stub-leaf-1",
			storedCmId: "stub-cm-1",
			liveCmId: "stub-cm-1",
			cmMatches: false, // force unhealthy → repair is called
		}),
		getCollabDebugInfoForView: () => ({
			hasSyncFacet: false, // force unhealthy
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
		getLastEditorActivityForPath: () => null,
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
		getCurrentDiskContent: () => diskContent,
		ingestDiskFileNow: (reason: "create" | "modify" = "modify") => {
			if (!diskIngestPort) throw new Error("diskIngestPort not registered");
			return diskIngestPort.ingestDiskFileNow(path, reason);
		},
	};
}

// -------------------------------------------------------------------
// Test 0 — taxonomy + flight kinds present
// -------------------------------------------------------------------

console.log("\n--- Test 0: flight taxonomy bumped and new kinds present ---");
{
	assertEq(FLIGHT_TAXONOMY_VERSION, 10, "FLIGHT_TAXONOMY_VERSION === 10");
	assertEq(FLIGHT_KIND.recoverySkipped, "recovery.skipped", "FLIGHT_KIND.recoverySkipped");
	assertEq(FLIGHT_KIND.editorRepairApplied, "editor.repair.applied", "FLIGHT_KIND.editorRepairApplied");
	assertEq(FLIGHT_KIND.editorHealApplied, "editor.heal.applied", "FLIGHT_KIND.editorHealApplied");
}

// -------------------------------------------------------------------
// Test 1 — round-trip suppression invariant: recovery origin is local
// -------------------------------------------------------------------

console.log("\n--- Test 1: ORIGIN_DISK_SYNC_RECOVER_BOUND is a local origin ---");
{
	assert(
		isLocalStringOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"isLocalStringOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND) === true",
	);
	assert(
		isLocalOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND, /* provider */ undefined),
		"isLocalOrigin(ORIGIN_DISK_SYNC_RECOVER_BOUND, undefined) === true",
	);
	assert(
		LOCAL_REPAIR_ORIGINS.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"LOCAL_REPAIR_ORIGINS includes ORIGIN_DISK_SYNC_RECOVER_BOUND",
	);
}

// -------------------------------------------------------------------
// Test 2 — orchestration: localOnly recovery emits the expected sequence
// -------------------------------------------------------------------

console.log("\n--- Test 2: localOnly recovery flight-event timeline ---");
{
	const fix = buildFixture({
		path: "Notes/orch-test.md",
		disk: "DDDD",
		editor: "DDDD",
		crdt: "CCCC",
	});

	await fix.ingestDiskFileNow("modify");

	const recoveryKinds = fix.captured
		.filter((e) => e.layer === "recovery" || e.layer === "editor")
		.map((e) => e.kind);

	assert(
		recoveryKinds[0] === FLIGHT_KIND.recoveryDecision,
		"first recovery/editor event is recovery.decision",
	);
	assert(
		recoveryKinds[1] === FLIGHT_KIND.recoveryApplyStart,
		"second recovery/editor event is recovery.apply.start",
	);
	assert(
		recoveryKinds[2] === FLIGHT_KIND.recoveryApplyDone,
		"third recovery/editor event is recovery.apply.done",
	);
	assert(
		recoveryKinds[3] === FLIGHT_KIND.editorRepairApplied,
		"fourth recovery/editor event is editor.repair.applied",
	);
	assertEq(recoveryKinds.length, 4, "exactly 4 recovery/editor events");

	const decision = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assert(decision !== undefined, "recovery.decision present");
	assertEq(decision?.data.reason, "bound-file-local-only-divergence", "decision.reason");
	assertEq(decision?.data.action, "apply-diff", "decision.action");
	assertEq(decision?.data.editorEqualsDisk, true, "decision.editorEqualsDisk === true");
	assertEq(decision?.data.editorEqualsCrdt, false, "decision.editorEqualsCrdt === false");

	const applyStart = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	assertEq(applyStart?.data.origin, ORIGIN_DISK_SYNC_RECOVER_BOUND, "apply.start.origin");

	const applyDone = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	assertEq(applyDone?.data.matchesExpected, true, "apply.done.matchesExpected === true");
	assertEq(applyDone?.data.forceReplaceApplied, false, "apply.done.forceReplaceApplied === false");

	assertEq(fix.repairCalls.length, 1, "editorBindings.repair called once");
	assertEq(
		fix.repairCalls[0]?.reason,
		"bound-file-local-only-divergence",
		"editorBindings.repair reason",
	);

	const healEvents = fix.captured.filter((e) => e.kind === FLIGHT_KIND.editorHealApplied);
	assertEq(healEvents.length, 0, "no editor.heal.applied events in localOnly recovery (primary invariant: heal() not invoked)");
	const anyHealKind = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(anyHealKind.length, 0, "no editor.heal.* event of any kind in localOnly recovery");

	assertEq(fix.ytext.toString(), "DDDD", "Y.Text postcondition matches disk");

	assert(
		fix.transactionOrigins.includes(ORIGIN_DISK_SYNC_RECOVER_BOUND),
		"recovery transaction carried ORIGIN_DISK_SYNC_RECOVER_BOUND",
	);
}

// -------------------------------------------------------------------
// Test 3 — second pass on converged file emits recovery.skipped only
// -------------------------------------------------------------------

console.log("\n--- Test 3: second pass on converged file emits only recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/skip-test.md",
		disk: "SAME",
		editor: "SAME",
		crdt: "DIFF",
	});

	await fix.ingestDiskFileNow("modify");
	const firstPassCount = fix.captured.length;
	assert(firstPassCount > 0, "first pass produced events");

	// Clear the bound recovery lock so the lock-active bail does not fire.
	(fix.controller as unknown as { boundRecoveryLocks: Map<string, number> })
		.boundRecoveryLocks.clear();

	// Now editor and disk and CRDT all agree on "SAME". Drive a second pass.
	await fix.ingestDiskFileNow("modify");

	const secondPassEvents = fix.captured.slice(firstPassCount);
	assertEq(secondPassEvents.length, 1, "second pass emits exactly one event");
	assertEq(secondPassEvents[0]?.kind, FLIGHT_KIND.recoverySkipped, "second-pass event is recovery.skipped");
	assertEq(
		secondPassEvents[0]?.data.reason,
		"crdt-current-no-op",
		"recovery.skipped reason is crdt-current-no-op",
	);
	assertEq(secondPassEvents[0]?.data.wasBound, true, "recovery.skipped wasBound === true");

	const healOnSecondPass = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnSecondPass.length, 0, "no editor.heal.* events across both passes");

	assertEq(fix.ytext.toString(), "SAME", "Y.Text unchanged on second pass");
}

// -------------------------------------------------------------------
// Test 4 — bound recovery lock active emits recovery.skipped
// -------------------------------------------------------------------

console.log("\n--- Test 4: recovery-lock-active bail emits recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/lock-test.md",
		disk: "X",
		editor: "X",
		crdt: "Y",
	});

	// Drive one recovery to set the lock, then drive a second one immediately.
	await fix.ingestDiskFileNow("modify");
	const firstPassCount = fix.captured.length;

	// Force a fresh divergence so the second pass would otherwise enter the
	// localOnly branch.
	fix.ytext.delete(0, fix.ytext.length);
	fix.ytext.insert(0, "Y2");

	// Lock is still active (1500ms window, set by first pass). Second pass
	// should bail with recovery.skipped(reason=recovery-lock-active).
	await fix.ingestDiskFileNow("modify");

	const secondPassEvents = fix.captured.slice(firstPassCount);
	assertEq(secondPassEvents.length, 1, "lock-active second pass emits exactly one event");
	assertEq(secondPassEvents[0]?.kind, FLIGHT_KIND.recoverySkipped, "event is recovery.skipped");
	assertEq(
		secondPassEvents[0]?.data.reason,
		"recovery-lock-active",
		"recovery.skipped reason is recovery-lock-active",
	);
	assert(
		typeof secondPassEvents[0]?.data.lockRemainingMs === "number" &&
		(secondPassEvents[0].data.lockRemainingMs as number) > 0,
		"recovery.skipped includes lockRemainingMs > 0",
	);

	const healOnLockBail = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnLockBail.length, 0, "no editor.heal.* events on lock-active bail");
}

// -------------------------------------------------------------------
// Test 5 — crdtOnly idle-grace bail emits recovery.skipped
// -------------------------------------------------------------------

console.log("\n--- Test 5: crdtOnly idle-grace bail emits recovery.skipped ---");
{
	const fix = buildFixture({
		path: "Notes/idle-test.md",
		// editor==CRDT≠disk (crdtOnly branch precondition)
		disk: "DISK",
		editor: "CRDT",
		crdt: "CRDT",
	});

	// Override editorBindings to report recent activity (within
	// OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200ms).
	const eb = (fix.controller as unknown as {
		deps: { getEditorBindings(): { getLastEditorActivityForPath: (p: string) => number | null } };
	}).deps.getEditorBindings();
	const original = eb.getLastEditorActivityForPath.bind(eb);
	eb.getLastEditorActivityForPath = () => Date.now() - 200; // 200ms ago

	try {
		await fix.ingestDiskFileNow("modify");
	} finally {
		eb.getLastEditorActivityForPath = original;
	}

	const skipped = fix.captured.find((e) => e.kind === FLIGHT_KIND.recoverySkipped);
	assert(skipped !== undefined, "recovery.skipped emitted");
	assertEq(skipped?.data.reason, "recent-editor-activity", "reason is recent-editor-activity");
	assert(
		typeof skipped?.data.idleMs === "number" &&
		(skipped!.data.idleMs as number) >= 0 &&
		(skipped!.data.idleMs as number) < 1200,
		"recovery.skipped idleMs in (0, 1200)",
	);

	// And no recovery.decision was emitted.
	const decisionEvents = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	assertEq(decisionEvents.length, 0, "no recovery.decision in idle-grace bail");

	const healOnIdleBail = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnIdleBail.length, 0, "no editor.heal.* events on idle-grace bail");
}

// -------------------------------------------------------------------
// Test 6 — quarantine after three identical attempts
// -------------------------------------------------------------------

console.log("\n--- Test 6: third identical recovery is quarantined ---");
{
	const fix = buildFixture({
		path: "Notes/quarantine-test.md",
		disk: "AAA",
		editor: "AAA",
		crdt: "BBB",
	});

	// Drive three attempts with identical fingerprint (same prev/next content).
	for (let i = 0; i < 3; i++) {
		// Reset CRDT to BBB so each attempt has the same prev/next pair.
		if (i > 0) {
			fix.ytext.delete(0, fix.ytext.length);
			fix.ytext.insert(0, "BBB");
		}
		// Clear the lock so each attempt re-enters the recovery branch.
		(fix.controller as unknown as { boundRecoveryLocks: Map<string, number> })
			.boundRecoveryLocks.clear();
		await fix.ingestDiskFileNow("modify");
	}

	const decisions = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryDecision);
	const applyStarts = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyStart);
	const applyDones = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryApplyDone);
	const repairs = fix.captured.filter((e) => e.kind === FLIGHT_KIND.editorRepairApplied);
	const quarantined = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryQuarantined);
	const loopDetected = fix.captured.filter((e) => e.kind === FLIGHT_KIND.recoveryLoopDetected);

	assertEq(decisions.length, 3, "three recovery.decision events (one per attempt)");
	assertEq(applyStarts.length, 2, "only the first two attempts entered apply.start");
	assertEq(applyDones.length, 2, "only the first two attempts emitted apply.done");
	assertEq(repairs.length, 2, "only the first two attempts emitted editor.repair.applied");
	assertEq(quarantined.length, 1, "exactly one recovery.quarantined event");
	assertEq(loopDetected.length, 1, "exactly one recovery.loop.detected event");

	assertEq(quarantined[0]?.data.repeatCount, 3, "quarantined.repeatCount === 3");
	assertEq(
		quarantined[0]?.data.reason,
		"bound-file-local-only-divergence",
		"quarantined.reason",
	);
	assert(
		typeof quarantined[0]?.data.signature === "string" &&
		(quarantined[0].data.signature as string).length > 0,
		"quarantined.signature is non-empty string",
	);

	assertEq(loopDetected[0]?.data.repeatCount, 3, "loop.detected.repeatCount === 3");
	assertEq(
		loopDetected[0]?.data.signature,
		quarantined[0]?.data.signature,
		"loop.detected.signature matches quarantined.signature",
	);

	// Assert the quarantine ordering on the third attempt: after the
	// recovery.decision fires, the next recovery-layer event is
	// recovery.quarantined (not apply.start).
	const recoveryLayerKinds = fix.captured
		.filter((e) => e.layer === "recovery")
		.map((e) => e.kind);
	const lastDecisionIdx = recoveryLayerKinds.lastIndexOf(FLIGHT_KIND.recoveryDecision);
	assert(lastDecisionIdx >= 0, "third recovery.decision present");
	assertEq(
		recoveryLayerKinds[lastDecisionIdx + 1],
		FLIGHT_KIND.recoveryQuarantined,
		"event after third decision is recovery.quarantined",
	);
	assertEq(
		recoveryLayerKinds[lastDecisionIdx + 2],
		FLIGHT_KIND.recoveryLoopDetected,
		"event after recovery.quarantined is recovery.loop.detected",
	);

	// Y.Text final state: third attempt was quarantined before applying any
	// diff, so the second attempt's CRDT content (BBB → AAA) is the last
	// applied state. We reset ytext to BBB before the third attempt; since
	// the third was quarantined, ytext should remain BBB.
	assertEq(
		fix.ytext.toString(),
		"BBB",
		"Y.Text remains at BBB after quarantined third attempt",
	);

	const healOnQuarantine = fix.captured.filter((e) => typeof e.kind === "string" && e.kind.startsWith("editor.heal."));
	assertEq(healOnQuarantine.length, 0, "no editor.heal.* events across the three quarantine attempts");
}

// -------------------------------------------------------------------
// Test 7 — round-trip suppression: bound recovery does not emit disk.write.*
// -------------------------------------------------------------------

console.log("\n--- Test 7: bound recovery does not round-trip as disk.write ---");
{
	const fix = buildFixture({
		path: "Notes/round-trip-test.md",
		disk: "DISKDISK",
		editor: "DISKDISK",
		crdt: "CRDTCRDT",
	});

	await fix.ingestDiskFileNow("modify");

	// Wait one tick to drain any microtask-scheduled disk emission.
	await new Promise((r) => setTimeout(r, 50));

	const writeOk = fix.captured.find(
		(e) => e.kind === "disk.write.ok" && e.path === fix.path,
	);
	const writeFailed = fix.captured.find(
		(e) => e.kind === "disk.write.failed" && e.path === fix.path,
	);

	assertEq(writeOk, undefined, "no disk.write.ok for recovery write");
	assertEq(writeFailed, undefined, "no disk.write.failed for recovery write");
}

// -------------------------------------------------------------------
// Test 8 — source-grep regressions on src/sync/editorBinding.ts
// -------------------------------------------------------------------

console.log("\n--- Test 8: source-grep regressions on EditorBindingManager emit sites ---");
{
	const bindingSourcePath = fileURLToPath(
		new URL("../src/sync/editorBinding.ts", import.meta.url),
	);
	const src = readFileSync(bindingSourcePath, "utf8");

	// Constructor accepts the optional flight callback.
	assert(
		src.includes("private recordFlightPathEvent?: (event: ProductFlightPathEventInput) => void"),
		"constructor accepts optional recordFlightPathEvent callback",
	);
	assert(
		src.includes('import type { ProductFlightPathEventInput } from "../observability/traceSink"'),
		"ProductFlightPathEventInput imported from observability",
	);

	// applyBinding emits editor.repair.applied for action==="repair" only.
	const applyBindingIdx = src.indexOf(
		"private applyBinding(",
	);
	assert(applyBindingIdx > 0, "applyBinding method present");
	const applyBindingTail = src.slice(applyBindingIdx, applyBindingIdx + 4500);
	assert(
		applyBindingTail.includes("PRODUCT_EVENT_KIND.editorRepairApplied"),
		"applyBinding emits PRODUCT_EVENT_KIND.editorRepairApplied",
	);
	assert(
		applyBindingTail.includes('if (action === "repair")'),
		"applyBinding gates emission on action===\"repair\"",
	);

	// heal() emits editor.heal.applied on every successful entry that
	// resolves a binding target (not gated on the diff branch). Carries
	// diffApplied: boolean so absence of the event proves heal() was not
	// invoked.
	const healIdx = src.indexOf(
		"heal(view: MarkdownView, deviceName: string, reason: string): boolean {",
	);
	assert(healIdx > 0, "heal method present");
	const healBody = src.slice(healIdx, healIdx + 2500);
	const applyDiffIdx = healBody.indexOf("applyDiffToYText(target.ytext, crdtContent, currentContent, ORIGIN_EDITOR_HEALTH_HEAL)");
	const healEmitIdx = healBody.indexOf("PRODUCT_EVENT_KIND.editorHealApplied");
	assert(applyDiffIdx > 0, "heal() calls applyDiffToYText with ORIGIN_EDITOR_HEALTH_HEAL");
	assert(healEmitIdx > 0, "heal() emits PRODUCT_EVENT_KIND.editorHealApplied");
	assert(
		healEmitIdx > applyDiffIdx,
		"PRODUCT_EVENT_KIND.editorHealApplied emit follows applyDiffToYText",
	);
	// editor.heal.applied is NOT gated on the diff branch — the emit must
	// be after the if (diffApplied) block, not inside it. We assert this by
	// checking that the emit index is past the closing brace of the diff
	// branch. The diff branch is short (just the log + applyDiffToYText) so
	// we can detect it textually.
	assert(
		healBody.includes("const diffApplied = crdtContent !== currentContent"),
		"heal() computes diffApplied flag",
	);
	assert(
		healBody.includes("diffApplied,"),
		"heal() emit data carries diffApplied flag",
	);
	const ifBranchIdx = healBody.indexOf("if (diffApplied) {");
	assert(ifBranchIdx > 0, "heal() has if(diffApplied) block");
	// The emit must NOT be inside the if(diffApplied) block. Find the
	// closing brace of that block by walking braces.
	let depth = 0;
	let closeIdx = -1;
	for (let i = ifBranchIdx + "if (diffApplied) {".length - 1; i < healBody.length; i++) {
		const ch = healBody[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) { closeIdx = i; break; }
		}
	}
	assert(closeIdx > 0, "heal() if(diffApplied) block closing brace found");
	assert(
		healEmitIdx > closeIdx,
		"PRODUCT_EVENT_KIND.editorHealApplied emit is OUTSIDE if(diffApplied) block (fires on every successful entry)",
	);
}

// -------------------------------------------------------------------
// Test 9 — production code has no new heal() callers
// -------------------------------------------------------------------

console.log("\n--- Test 9: heal() retains zero production callers ---");
{
	const bindingSourcePath = fileURLToPath(
		new URL("../src/sync/editorBinding.ts", import.meta.url),
	);
	const bindingSrc = readFileSync(bindingSourcePath, "utf8");

	// Grep production sources outside editorBinding.ts itself for `.heal(`.
	const productionFiles = [
		"../src/main.ts",
		"../src/runtime/reconciliationController.ts",
		"../src/runtime/editorWorkspaceOrchestrator.ts",
		"../src/sync/diskMirror.ts",
	];

	for (const rel of productionFiles) {
		const url = new URL(rel, import.meta.url);
		try {
			const text = readFileSync(fileURLToPath(url), "utf8");
			// editorBindings.heal( or .heal( on something resembling a manager.
			// Allow editorBindings?.heal? in trace strings, but not as a call.
			const callMatches = text.match(/editorBindings(?:\??\s*\.\s*|\s*\.\s*)heal\s*\(/g);
			assertEq(
				callMatches,
				null,
				`no editorBindings.heal( call in ${rel.replace("../", "")}`,
			);
		} catch (err) {
			// File missing is fine for editorWorkspaceOrchestrator.ts in
			// older revisions.
			void err;
		}
	}

	// And inside editorBinding.ts itself, heal() should still call repair()
	// and not be invoked by validateOpenBindings, bind, or maybeHealBinding.
	assert(
		!bindingSrc.match(/this\.heal\s*\(/),
		"no this.heal( call inside editorBinding.ts (repair flows do not invoke heal)",
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
