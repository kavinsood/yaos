/**
 * No-event reconcile admission regression test.
 *
 * Spec: .kiro/specs/no-event-reconcile-admission/requirements.md
 *
 * Followup closed: `engineering/followups.md` "Validation gaps" entry
 *   "No-event reconcile admission" — concrete proof that a syncable file
 *   appearing on disk without the normal vault create event pipeline is
 *   admitted by reconcile rather than becoming a silent local-only file.
 *
 * ============================================================================
 * Architectural decision (Requirement 2.1)
 * ============================================================================
 *
 * **Option (b) — opId-factory callback.** Chosen.
 *
 *   `VaultSync.reconcileVault` accepts an OPTIONAL `mintAdmissionOpId(path)`
 *   callback. When supplied, the seed loop calls it at each `seed-to-crdt`
 *   decision point, runs the returned `emitDecision()` BEFORE the CRDT
 *   mutation, and threads `opId` into `ensureFile` via `options.opId`.
 *   When omitted, `reconcileVault` behaves exactly as today (no order
 *   change, no opId, no decision emission from inside reconcileVault).
 *
 *   Rationale: smallest surface-area refactor that produces the spec-
 *   required emission order `reconcile.file.decision` → `crdt.file.created`
 *   with a shared envelope `opId`. Existing callers and existing tests of
 *   `reconcileVault` (e.g. `tests/reconciliation-safety-brake.ts`) continue
 *   to work unmodified because they do not supply the callback.
 *
 *   Trade-off: introduces an optional parameter on a hot-path method
 *   instead of splitting the planner from the mutation. Option (a) would
 *   have been the cleanest semantic separation but touches every caller
 *   of `reconcileVault` and is a much larger refactor for the same
 *   observable outcome.
 *
 * ============================================================================
 * Fixture form (Requirement 3.10)
 * ============================================================================
 *
 * **Form (a) — `Object.create(VaultSync.prototype)` plus minimal-field init.**
 *
 *   The full `VaultSync` constructor wires a `y-partyserver` provider,
 *   an `IndexeddbPersistence` adapter, runtime cleanup, and a server-ack
 *   tracker. None of those are needed to drive `reconcileVault` and
 *   `ensureFile`, and instantiating them in plain Node would require
 *   either a mock or a network. This test uses `Object.create(VaultSync.prototype)`
 *   plus an in-line `__qaOnlyForTestInit` helper that initializes only the
 *   fields the production methods read or write:
 *     - `ydoc`, `pathToId`, `idToText`, `meta`, `sys`, `pathToBlob`,
 *       `blobMeta`, `blobTombstones` (real `Y.Map`s for `runIntegrityChecks`)
 *     - `_textToFileId`, `_pathIndex`, `_deletedPathIndex`,
 *       `_pathIndexesDirty` (the path-index machinery)
 *     - `_localReady`, `_providerSynced` (so `getSafeReconcileMode` resolves)
 *     - `_renameBatchNewToOld` (so `promotePendingRenameTarget` is a no-op)
 *     - `_eventRing`, `debug`, `trace`, `onFlightEvent`, `onFlightPathEvent`,
 *       `_device` (logging/telemetry edges)
 *     - `provider = { wsconnected: false }` (so the `connected` getter works)
 *
 *   The phrase "real VaultSync instance" is NOT used — constructor
 *   instantiation is not supported in this test environment.
 *
 * ============================================================================
 * White-box framing (Requirement 3.12 / Gate 6)
 * ============================================================================
 *
 *   The test reaches into `ReconciliationController` private state via
 *   `(controller as unknown as { untrackedFiles: string[]; lastReconcileTime: number }).<member>`
 *   to (a) read `untrackedFiles` for the conservative-lane precondition
 *   asserted by Scenarios B/C/D/E, and (b) zero `lastReconcileTime`
 *   between successive `runReconciliation` calls so the 10-second cooldown
 *   does not block Scenario E's second pass. This is acceptable for a
 *   controller-internals regression — the spec acknowledges the framing
 *   explicitly.
 *
 * ============================================================================
 * Admission-emission audit (Requirement 8 / Gate 5)
 * ============================================================================
 *
 *   Source: `src/runtime/reconciliationController.ts` `runReconciliation()`.
 *   Every `recordFlightPathEvent({ kind: FLIGHT_KIND.reconcileFileDecision, ... })`
 *   callsite that participates in admission/refusal is enumerated below.
 *
 *   | Loop / branch                                 | Function name           | Decision discriminator                                                          | Notes                                                            |
 *   |-----------------------------------------------|-------------------------|----------------------------------------------------------------------------------|------------------------------------------------------------------|
 *   | `result.tombstonedDiskConflicts` post-result  | `runReconciliation`     | `skip-tombstoned`                                                                | Disk-present-at-tombstoned-path; refusal.                       |
 *   | `result.untracked` post-result                | `runReconciliation`     | `skip-untracked`                                                                 | Conservative-mode deferral (Scenario B); refusal-for-now.       |
 *   | `result.createdOnDisk` post-result            | `runReconciliation`     | `write-crdt-to-disk`                                                             | CRDT-to-disk write; not admission per se.                       |
 *   | `result.seededToCrdt` callback (Option (b))   | seed-loop callback      | `seed-disk-to-crdt`                                                              | Authoritative-mode admission (Scenario A); positive.            |
 *   | `result.updatedOnDisk` per-path branch        | `runReconciliation`     | `preserve-conflict` / `apply-remote-to-disk` / `import-disk-to-crdt` / `no-op`   | Closed-file conflict family; not admission per se.              |
 *   | `importUntrackedFiles` preserved skip         | `importUntrackedFiles`  | (no `reconcile.file.decision`; legacy free-form trace)                           | Preserved-unresolved guard (Scenario D); refusal via free-form. |
 *   | `importUntrackedFiles` admission              | `importUntrackedFiles`  | (no `reconcile.file.decision`; emits `crdt.file.created` only)                   | Conservative-lane admission (Scenarios C, E); positive.         |
 *
 *   Conclusion: NO admission/refusal branch reachable from `runReconciliation`
 *   or `importUntrackedFiles` is missing a `reconcile.file.decision` event
 *   today, AND the existing free-form `import-untracked-skipped-preserved-unresolved`
 *   trace covers the preserved-unresolved skip (Scenario D). The existing
 *   eight `reconcile.file.decision` discriminators plus the legacy trace
 *   plus `recovery.skipped` cover every branch this spec asserts on. No new
 *   `FlightKind` is required; `FLIGHT_TAXONOMY_VERSION` stays at 9.
 *
 * ============================================================================
 * Scenario F — callback failure semantics (reviewer follow-up)
 * ============================================================================
 *
 *   Added in response to a B-grade review of the original implementation.
 *   The reviewer flagged that the `mintAdmissionOpId` / `emitDecision`
 *   callback contract was implicit. Scenario F is the explicit policy
 *   test: when `emitDecision()` throws, the exception propagates synchronously
 *   out of `reconcileVault`, the path's `ensureFile` is NOT called, the
 *   path is NOT appended to `seededToCrdt`, AND no `crdt.file.created`
 *   envelope is emitted. The full contract is documented as JSDoc on the
 *   `mintAdmissionOpId` parameter in `src/sync/vaultSync.ts`.
 */

import * as Y from "yjs";
import { TFile } from "obsidian";
import {
	VaultSync,
	type ReconcileMode,
} from "../src/sync/vaultSync";
import { ReconciliationController } from "../src/runtime/reconciliationController";
import {
	FLIGHT_KIND,
	FLIGHT_TAXONOMY_VERSION,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../src/telemetry/debug/flightEvents";

// -------------------------------------------------------------------
// Assertion harness (matches tests/reconciliation-safety-brake.ts)
// -------------------------------------------------------------------

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

// -------------------------------------------------------------------
// Captured event helpers
// -------------------------------------------------------------------

interface CapturedEvent {
	kind: string;
	path: string;
	scope: string;
	priority: string;
	severity: string;
	source: string;
	layer: string;
	opId?: string;
	fileId?: string;
	data: Record<string, unknown>;
}

function asPathEvent(e: FlightPathEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: e.path,
		scope: e.scope,
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
		opId: (e as { opId?: string }).opId,
		fileId: (e as { fileId?: string }).fileId ?? (e.data as Record<string, unknown>)?.fileId as string | undefined,
		data: (e.data as Record<string, unknown>) ?? {},
	};
}

function asAnyEvent(e: FlightEventInput): CapturedEvent {
	return {
		kind: e.kind,
		path: (e as { path?: string }).path ?? "",
		scope: e.scope,
		priority: e.priority,
		severity: e.severity,
		source: e.source,
		layer: e.layer,
		opId: (e as { opId?: string }).opId,
		fileId: (e as { fileId?: string }).fileId,
		data: (e.data as Record<string, unknown>) ?? {},
	};
}

interface CapturedTrace {
	source: string;
	msg: string;
	details?: Record<string, unknown>;
}

function makeTFile(path: string): TFile {
	const file = new TFile() as TFile & { path: string };
	file.path = path;
	return file;
}

// -------------------------------------------------------------------
// __qaOnlyForTestInit: minimal-fields initializer for VaultSync.prototype
//
// Initializes only the fields read or written by `reconcileVault`,
// `ensureFile`, `getActiveMarkdownPaths`, `getTextForPath`,
// `getSafeReconcileMode`, `runIntegrityChecks`, `markInitialized`, and
// `setMetaActive`. The full VaultSync constructor (provider, IDB,
// server-ack tracker) is intentionally bypassed — see fixture form (a)
// in the top comment.
//
// ============================================================================
// !! TEST-ONLY HELPER. DO NOT IMPORT FROM PRODUCTION CODE. !!
// ============================================================================
//
// This function exists to make Object.create(VaultSync.prototype) viable
// for white-box admission testing in plain Node, with no provider, no
// IndexedDB, and no server-ack tracker. It deliberately leaves many
// VaultSync invariants (provider connection, IDB persistence,
// updateTracker attachment, server-ack scope) unset.
//
// It MUST NOT be exported from this file, MUST NOT be moved into
// `src/`, MUST NOT be referenced by `main.ts` or any plugin runtime
// path, AND MUST NOT acquire callers outside this regression test.
// If a future test needs the same fixture, copy this helper into that
// test file rather than promoting it to a shared module — sharing it
// is how white-box scaffolding silently becomes a runtime dependency,
// and at that point one weird VaultSync state will leak into
// production behavior.
//
// If anyone proposes "let's just expose __qaOnlyForTestInit from
// VaultSync so other tests can reuse it" — the answer is no. Delete
// the helper, or rebuild it from scratch in the new caller.
// ============================================================================
// -------------------------------------------------------------------

interface QaTestInitOptions {
	providerSynced: boolean;
	localReady: boolean;
	deviceName: string;
	onFlightPathEvent: (event: FlightPathEventInput) => void;
}

function __qaOnlyForTestInit(opts: QaTestInitOptions): VaultSync {
	const vs = Object.create(VaultSync.prototype) as VaultSync &
		Record<string, unknown>;
	vs.ydoc = new Y.Doc();
	vs.pathToId = vs.ydoc.getMap("pathToId");
	vs.idToText = vs.ydoc.getMap("idToText");
	vs.meta = vs.ydoc.getMap("meta");
	vs.sys = vs.ydoc.getMap("sys");
	vs.pathToBlob = vs.ydoc.getMap("pathToBlob");
	vs.blobMeta = vs.ydoc.getMap("blobMeta");
	vs.blobTombstones = vs.ydoc.getMap("blobTombstones");
	vs._textToFileId = new WeakMap();
	vs._pathIndex = new Map();
	vs._deletedPathIndex = new Set();
	vs._pathIndexesDirty = true;
	vs._localReady = opts.localReady;
	vs._providerSynced = opts.providerSynced;
	vs._connectionGeneration = 0;
	vs._renameBatch = new Map();
	vs._renameBatchNewToOld = new Map();
	vs._renameTimer = null;
	vs._eventRing = [];
	vs._device = opts.deviceName;
	vs.debug = false;
	vs.trace = undefined;
	vs.onFlightEvent = undefined;
	vs.onFlightPathEvent = opts.onFlightPathEvent;
	// `connected` getter reads `this.provider.wsconnected`.
	vs.provider = { wsconnected: false };
	return vs as VaultSync;
}

// -------------------------------------------------------------------
// Fixture builder
// -------------------------------------------------------------------

interface Fixture {
	path: string;
	diskContent: string;
	events: CapturedEvent[];
	traces: CapturedTrace[];
	vaultSync: VaultSync;
	controller: ReconciliationController;
	preservedUnresolved: Set<string>;
}

function buildFixture(opts: {
	path: string;
	diskContent: string;
	mode: ReconcileMode;
}): Fixture {
	const events: CapturedEvent[] = [];
	const traces: CapturedTrace[] = [];
	const preservedUnresolved = new Set<string>();

	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		events.push(asPathEvent(event));
	};
	const recordFlightEvent = (event: FlightEventInput): void => {
		events.push(asAnyEvent(event));
	};

	const vaultSync = __qaOnlyForTestInit({
		providerSynced: opts.mode === "authoritative",
		localReady: opts.mode === "authoritative",
		deviceName: "TestDevice",
		onFlightPathEvent: recordFlightPathEvent,
	});

	const file = makeTFile(opts.path);
	const stat = { mtime: 1, size: opts.diskContent.length };

	const app = {
		vault: {
			getMarkdownFiles: () => [file],
			read: async (f: TFile & { path: string }) => {
				if (f.path !== opts.path) {
					throw new Error(`unexpected read: ${f.path}`);
				}
				return opts.diskContent;
			},
			adapter: {
				stat: async () => stat,
			},
			getAbstractFileByPath: (p: string) => (p === opts.path ? file : null),
		},
		workspace: {
			iterateAllLeaves: () => {},
		},
	};

	// Hand-rolled diskMirror stub. Holds preserved-unresolved paths in a
	// plain Set<string> to keep the fixture scope tight; this matches the
	// spec's R6.1 alternative form (record preservedUnresolved without
	// driving `handleRemoteDelete`).
	const diskMirror = {
		isPreservedUnresolved: (p: string) => preservedUnresolved.has(p),
		clearPreservedUnresolved: (p: string) => {
			preservedUnresolved.delete(p);
		},
		recordPreservedUnresolved: (p: string) => {
			preservedUnresolved.add(p);
		},
		flushWrite: async () => {
			/* no createdOnDisk in admission scenarios */
		},
		recordPreservedUnresolvedAlt: () => {},
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
		getVaultSync: () => vaultSync,
		getDiskMirror: () => diskMirror as never,
		getBlobSync: () => null,
		getEditorBindings: () => null,
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
		trace: (source, msg, details) => {
			traces.push({ source, msg, details });
		},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		recordFlightEvent,
		recordFlightPathEvent,
	});

	return {
		path: opts.path,
		diskContent: opts.diskContent,
		events,
		traces,
		vaultSync,
		controller,
		preservedUnresolved,
	};
}

// -------------------------------------------------------------------
// Sanity: taxonomy at the version current at the time of this spec
// -------------------------------------------------------------------

console.log("\n--- Taxonomy: FLIGHT_TAXONOMY_VERSION ---");
{
	// Bumped to 10 by the editor-bound localOnly amplifier guard spec
	// (recovery.amplification.quarantined). This spec does not bump.
	assertEq(
		FLIGHT_TAXONOMY_VERSION,
		10,
		"FLIGHT_TAXONOMY_VERSION === 10 (no bump for this spec)",
	);
}

// -------------------------------------------------------------------
// Scenario A — fresh admission via the authoritative-mode lane
// -------------------------------------------------------------------

console.log("\n--- Scenario A: authoritative-mode lane admits a no-event disk file ---");
{
	const fx = buildFixture({
		path: "Notes/no-event-arrival.md",
		diskContent: "D",
		mode: "authoritative",
	});

	// Preconditions: not in CRDT, not in preservedUnresolved, no prior
	// markMarkdownDirty queued (default fixture state).
	assert(
		fx.vaultSync.getTextForPath(fx.path) === null,
		"precondition: getTextForPath returns null before reconcile",
	);
	assert(
		!fx.preservedUnresolved.has(fx.path),
		"precondition: path not in preservedUnresolved",
	);
	assertEq(
		fx.vaultSync.getSafeReconcileMode(),
		"authoritative",
		"precondition: getSafeReconcileMode returns 'authoritative'",
	);

	await fx.controller.runReconciliation("authoritative");

	// 5.i — reconcile.start
	const startIdx = fx.events.findIndex((e) => e.kind === "reconcile.start");
	assert(startIdx >= 0, "Scenario A: reconcile.start fires");
	if (startIdx >= 0) {
		assertEq(
			fx.events[startIdx].scope,
			"vault",
			"reconcile.start scope === 'vault'",
		);
	}

	// 5.ii — reconcile.file.decision (seed-disk-to-crdt) for test path
	const decisionIdx = fx.events.findIndex(
		(e) =>
			e.kind === "reconcile.file.decision" &&
			e.path === fx.path &&
			e.data.decision === "seed-disk-to-crdt",
	);
	assert(decisionIdx >= 0, "Scenario A: reconcile.file.decision (seed-disk-to-crdt) fires for test path");
	if (decisionIdx >= 0) {
		assertEq(fx.events[decisionIdx].scope, "file", "decision event scope === 'file'");
		assertEq(
			fx.events[decisionIdx].data.reason,
			"disk-file-not-in-crdt",
			"decision event reason === 'disk-file-not-in-crdt'",
		);
		assertEq(
			fx.events[decisionIdx].data.conflictRisk,
			"none",
			"decision event conflictRisk === 'none'",
		);
	}

	// 5.iii — crdt.file.created for the same path with a non-empty fileId
	const createdIdx = fx.events.findIndex(
		(e) => e.kind === "crdt.file.created" && e.path === fx.path,
	);
	assert(createdIdx >= 0, "Scenario A: crdt.file.created fires for test path");
	if (createdIdx >= 0) {
		assertEq(fx.events[createdIdx].scope, "file", "crdt.file.created scope === 'file'");
		assert(
			typeof fx.events[createdIdx].fileId === "string" &&
				(fx.events[createdIdx].fileId as string).length > 0,
			"crdt.file.created carries a non-empty fileId",
		);
	}

	// 5.iv — reconcile.complete
	const completeIdx = fx.events.findIndex((e) => e.kind === "reconcile.complete");
	assert(completeIdx >= 0, "Scenario A: reconcile.complete fires");
	if (completeIdx >= 0) {
		assertEq(
			fx.events[completeIdx].scope,
			"vault",
			"reconcile.complete scope === 'vault'",
		);
	}

	// 3.6 — semantic order: decision BEFORE crdt.file.created
	if (decisionIdx >= 0 && createdIdx >= 0) {
		const orderOk = decisionIdx < createdIdx;
		if (!orderOk) {
			console.error(
				`  context: ${fx.events.map((e) => e.kind).join(" -> ")}`,
			);
		}
		assert(
			orderOk,
			"Scenario A: reconcile.file.decision emits BEFORE crdt.file.created",
		);
	}

	// 3.5 — overall ordering: start < decision < created < complete
	if (startIdx >= 0 && decisionIdx >= 0 && createdIdx >= 0 && completeIdx >= 0) {
		const fullOrderOk =
			startIdx < decisionIdx && decisionIdx < createdIdx && createdIdx < completeIdx;
		if (!fullOrderOk) {
			console.error(
				`  context: ${fx.events.map((e) => e.kind).join(" -> ")}`,
			);
		}
		assert(
			fullOrderOk,
			"Scenario A: full order start -> decision -> created -> complete",
		);
	}

	// 3.7 — shared opId between decision and crdt.file.created
	if (decisionIdx >= 0 && createdIdx >= 0) {
		const decisionOpId = fx.events[decisionIdx].opId;
		const createdOpId = fx.events[createdIdx].opId;
		assert(
			typeof decisionOpId === "string" && decisionOpId.length > 0,
			"decision opId is a non-empty string",
		);
		assert(
			typeof createdOpId === "string" && createdOpId.length > 0,
			"crdt.file.created opId is a non-empty string",
		);
		if (typeof decisionOpId === "string") {
			assert(
				/^op-reconcile-seed-[0-9a-z]+-[0-9a-z]+$/.test(decisionOpId),
				`decision opId matches op-reconcile-seed-<base36-time>-<base36-rand> (got ${decisionOpId})`,
			);
		}
		assertEq(
			createdOpId,
			decisionOpId,
			"decision and crdt.file.created share the same envelope opId",
		);
	}

	// 3.8 — postcondition: Y.Text exists and equals disk content
	const ytext = fx.vaultSync.getTextForPath(fx.path);
	assert(ytext !== null, "Scenario A: getTextForPath returns non-null Y.Text after admission");
	if (ytext) {
		assertEq(ytext.toJSON(), "D", "admitted Y.Text content equals disk content 'D'");
	}

	// 3.9 — no recovery.* events for the admitted path
	const recoveryEvents = fx.events.filter(
		(e) =>
			e.path === fx.path &&
			(e.kind === "recovery.decision" ||
				e.kind === "recovery.apply.start" ||
				e.kind === "recovery.apply.done" ||
				e.kind === "recovery.skipped"),
	);
	assertEq(
		recoveryEvents.length,
		0,
		"Scenario A: zero recovery.* events for the admitted path",
	);
}

// -------------------------------------------------------------------
// Scenarios B & C — conservative-mode reconcile + importUntrackedFiles
// (shared fixture; Scenario C extends Scenario B's setup directly)
// -------------------------------------------------------------------

console.log("\n--- Scenario B: conservative-mode reconcile emits skip-untracked ---");
{
	const fx = buildFixture({
		path: "Notes/conservative-arrival.md",
		diskContent: "D",
		mode: "conservative",
	});

	assertEq(
		fx.vaultSync.getSafeReconcileMode(),
		"conservative",
		"precondition: getSafeReconcileMode returns 'conservative'",
	);

	await fx.controller.runReconciliation("conservative");

	const eventsB = fx.events.slice();

	// 4.3 — reconcile.start, decision (skip-untracked), reconcile.complete (in order)
	const startIdx = eventsB.findIndex((e) => e.kind === "reconcile.start");
	const skipIdx = eventsB.findIndex(
		(e) =>
			e.kind === "reconcile.file.decision" &&
			e.path === fx.path &&
			e.data.decision === "skip-untracked",
	);
	const completeIdx = eventsB.findIndex((e) => e.kind === "reconcile.complete");
	assert(startIdx >= 0, "Scenario B: reconcile.start fires");
	assert(skipIdx >= 0, "Scenario B: reconcile.file.decision (skip-untracked) fires");
	if (skipIdx >= 0) {
		assertEq(
			eventsB[skipIdx].data.reason,
			"conservative-mode-no-auto-seed",
			"Scenario B: skip-untracked reason === 'conservative-mode-no-auto-seed'",
		);
	}
	assert(completeIdx >= 0, "Scenario B: reconcile.complete fires");
	if (startIdx >= 0 && skipIdx >= 0 && completeIdx >= 0) {
		assert(
			startIdx < skipIdx && skipIdx < completeIdx,
			"Scenario B: order start -> skip-untracked decision -> complete",
		);
	}

	// 4.4 — no crdt.file.created during Scenario B
	const createdInB = eventsB.filter(
		(e) => e.kind === "crdt.file.created" && e.path === fx.path,
	);
	assertEq(createdInB.length, 0, "Scenario B: zero crdt.file.created for test path");

	// 4.6 — controller.untrackedFiles contains test path
	const untracked = (
		fx.controller as unknown as { untrackedFiles: string[] }
	).untrackedFiles;
	assert(
		untracked.includes(fx.path),
		`Scenario B: controller.untrackedFiles contains test path (got: ${JSON.stringify(untracked)})`,
	);

	// 4.7 — Y.Text still null
	assert(
		fx.vaultSync.getTextForPath(fx.path) === null,
		"Scenario B: getTextForPath still null after conservative reconcile",
	);

	// ---------------------------------------------------------------
	// Scenario C — importUntrackedFiles admits the deferred path
	// ---------------------------------------------------------------
	console.log("\n--- Scenario C: importUntrackedFiles admits the deferred path ---");

	const eventsBeforeImport = fx.events.length;

	await fx.controller.importUntrackedFiles();

	const eventsDuringC = fx.events.slice(eventsBeforeImport);

	// 5.2 — exactly one crdt.file.created during Scenario C with op-import-untracked-* opId
	const createdInC = eventsDuringC.filter(
		(e) => e.kind === "crdt.file.created" && e.path === fx.path,
	);
	assertEq(createdInC.length, 1, "Scenario C: exactly one crdt.file.created during this scenario");
	if (createdInC.length === 1) {
		const importOpId = createdInC[0].opId;
		assert(
			typeof importOpId === "string" && importOpId.length > 0,
			"Scenario C: crdt.file.created opId is non-empty",
		);
		if (typeof importOpId === "string") {
			assert(
				/^op-import-untracked-[0-9a-z]+-[0-9a-z]+$/.test(importOpId),
				`Scenario C: opId matches op-import-untracked-<base36-time>-<base36-rand> (got ${importOpId})`,
			);
		}

		// 5.3 — opId distinct from any Scenario B opId
		const scenarioBOpIds = new Set(
			eventsB.map((e) => e.opId).filter((v): v is string => typeof v === "string"),
		);
		assert(
			!scenarioBOpIds.has(importOpId as string),
			"Scenario C: opId is distinct from any Scenario B opId",
		);
	}

	// 5.4 — Y.Text non-null and equals disk content
	const ytextC = fx.vaultSync.getTextForPath(fx.path);
	assert(
		ytextC !== null,
		"Scenario C: getTextForPath returns non-null Y.Text after import",
	);
	if (ytextC) {
		assertEq(
			ytextC.toJSON(),
			"D",
			"Scenario C: admitted Y.Text content equals disk content 'D'",
		);
	}

	// 5.5 — controller.untrackedFiles drained
	const untrackedAfter = (
		fx.controller as unknown as { untrackedFiles: string[] }
	).untrackedFiles;
	assert(
		!untrackedAfter.includes(fx.path),
		`Scenario C: controller.untrackedFiles no longer contains test path (got: ${JSON.stringify(untrackedAfter)})`,
	);
}

// -------------------------------------------------------------------
// Scenarios D & E — preserved-unresolved guard + clear-and-readmit
// (shared fixture; Scenario E extends Scenario D's setup directly)
// -------------------------------------------------------------------

console.log("\n--- Scenario D: preserved-unresolved guard blocks admission ---");
{
	const fx = buildFixture({
		path: "Notes/unknown-baseline.md",
		diskContent: "D",
		mode: "conservative",
	});

	// Register the path as preserved-unresolved BEFORE reconcile.
	// Form chosen (R6.1): direct register on the hand-rolled diskMirror
	// stub's preserved-unresolved set. The alternative form (driving
	// handleRemoteDelete on a real DiskMirror with a CRDT-baseline-missing
	// setup, as in trace-event-behavior.ts Test 5) was not chosen because
	// it would require constructing a real DiskMirror whose dependencies
	// are out of scope for this admission test.
	fx.preservedUnresolved.add(fx.path);
	assert(
		fx.preservedUnresolved.has(fx.path),
		"Scenario D: precondition path is in preservedUnresolved",
	);
	assert(
		fx.vaultSync.getTextForPath(fx.path) === null,
		"Scenario D: precondition path is not in CRDT",
	);

	// 6.2 — drive runReconciliation("conservative") to populate untrackedFiles
	// naturally (NOT pre-seeded), THEN invoke importUntrackedFiles().
	await fx.controller.runReconciliation("conservative");
	const untracked = (
		fx.controller as unknown as { untrackedFiles: string[] }
	).untrackedFiles;
	assert(
		untracked.includes(fx.path),
		`Scenario D: runReconciliation populated untrackedFiles naturally (not pre-seeded; got: ${JSON.stringify(untracked)})`,
	);

	const eventsBeforeImport = fx.events.length;
	const tracesBeforeImport = fx.traces.length;
	await fx.controller.importUntrackedFiles();
	const eventsDuringD = fx.events.slice(eventsBeforeImport);
	const tracesDuringD = fx.traces.slice(tracesBeforeImport);

	// 6.3 — zero crdt.file.created for the test path during Scenario D
	const createdInD = eventsDuringD.filter(
		(e) => e.kind === "crdt.file.created" && e.path === fx.path,
	);
	assertEq(
		createdInD.length,
		0,
		"Scenario D: zero crdt.file.created for preserved-unresolved path",
	);

	// 6.4 — exactly one import-untracked-skipped-preserved-unresolved trace
	const skipTrace = tracesDuringD.find(
		(t) =>
			t.source === "reconcile" &&
			t.msg === "import-untracked-skipped-preserved-unresolved" &&
			(t.details?.path as string) === fx.path,
	);
	assert(
		!!skipTrace,
		"Scenario D: import-untracked-skipped-preserved-unresolved trace fires for test path",
	);

	// 6.5 — Y.Text still null AND isPreservedUnresolved still true
	assert(
		fx.vaultSync.getTextForPath(fx.path) === null,
		"Scenario D: Y.Text remains null after skip",
	);
	assert(
		fx.preservedUnresolved.has(fx.path),
		"Scenario D: isPreservedUnresolved remains true (not auto-cleared by skip)",
	);

	// ---------------------------------------------------------------
	// Scenario E — clear-and-readmit cycle
	// ---------------------------------------------------------------
	console.log("\n--- Scenario E: clearPreservedUnresolved unblocks admission ---");

	// 7.1 — clear preserved-unresolved
	fx.preservedUnresolved.delete(fx.path);
	assert(
		!fx.preservedUnresolved.has(fx.path),
		"Scenario E: isPreservedUnresolved returns false after clear",
	);

	// 7.2 — re-run conservative reconcile (zeroing the cooldown so the
	// 10-second gate does not block the second pass), then importUntrackedFiles.
	(fx.controller as unknown as { lastReconcileTime: number }).lastReconcileTime = 0;
	await fx.controller.runReconciliation("conservative");

	// untrackedFiles must be re-populated by the natural flow.
	const untrackedAfterRescan = (
		fx.controller as unknown as { untrackedFiles: string[] }
	).untrackedFiles;
	assert(
		untrackedAfterRescan.includes(fx.path),
		`Scenario E: runReconciliation re-populated untrackedFiles after clear (got: ${JSON.stringify(untrackedAfterRescan)})`,
	);

	// Capture the boundary BEFORE importUntrackedFiles so we observe ONLY
	// Scenario-E events.
	const eventsBeforeReadmit = fx.events.length;
	const opIdsBeforeReadmit = new Set(
		fx.events
			.map((e) => e.opId)
			.filter((v): v is string => typeof v === "string"),
	);
	await fx.controller.importUntrackedFiles();
	const eventsDuringE = fx.events.slice(eventsBeforeReadmit);

	// 7.3 — exactly one crdt.file.created during Scenario E with op-import-untracked-* opId
	const createdInE = eventsDuringE.filter(
		(e) => e.kind === "crdt.file.created" && e.path === fx.path,
	);
	assertEq(
		createdInE.length,
		1,
		"Scenario E: exactly one crdt.file.created during this scenario",
	);
	if (createdInE.length === 1) {
		const readmitOpId = createdInE[0].opId;
		assert(
			typeof readmitOpId === "string" && readmitOpId.length > 0,
			"Scenario E: crdt.file.created opId is non-empty",
		);
		if (typeof readmitOpId === "string") {
			assert(
				/^op-import-untracked-[0-9a-z]+-[0-9a-z]+$/.test(readmitOpId),
				`Scenario E: opId matches op-import-untracked-<base36-time>-<base36-rand> (got ${readmitOpId})`,
			);
			// 7.4 — opId distinct from any earlier opId in the captured array
			assert(
				!opIdsBeforeReadmit.has(readmitOpId),
				"Scenario E: readmit opId distinct from any earlier captured opId",
			);
		}
	}

	// 7.5 — Y.Text non-null and equals disk content
	const ytextE = fx.vaultSync.getTextForPath(fx.path);
	assert(ytextE !== null, "Scenario E: getTextForPath returns non-null Y.Text after readmit");
	if (ytextE) {
		assertEq(
			ytextE.toJSON(),
			"D",
			"Scenario E: admitted Y.Text content equals disk content 'D'",
		);
	}

	// 7.6 — sanity: clearPreservedUnresolved reflected
	assert(
		!fx.preservedUnresolved.has(fx.path),
		"Scenario E: isPreservedUnresolved remains false after clear",
	);
}

// -------------------------------------------------------------------
// Scenario F — callback failure semantics (Reviewer follow-up)
//
// Documents the contract on `mintAdmissionOpId` / `emitDecision`:
// when `emitDecision()` throws, the exception propagates out of
// `reconcileVault`, the path's `ensureFile` is NOT called, and the
// path is NOT appended to `seededToCrdt`. This is the policy that
// keeps `crdt.file.created` from ever firing without a preceding
// `reconcile.file.decision`.
//
// We drive `reconcileVault` directly here (bypassing the controller)
// so we can observe the synchronous failure cleanly. Going through
// `runReconciliation` would also work, but it adds the
// reconcile.start / reconcile.complete envelope and the
// `try { ... } finally { reconcileInFlight = false; ... }` wrap,
// which obscures the seed-loop semantics this scenario asserts on.
// -------------------------------------------------------------------

console.log("\n--- Scenario F: emitDecision() throw propagates and seed mutation is skipped ---");
{
	const events: CapturedEvent[] = [];
	const recordFlightPathEvent = (event: FlightPathEventInput): void => {
		events.push(asPathEvent(event));
	};
	const vaultSync = __qaOnlyForTestInit({
		providerSynced: true,
		localReady: true,
		deviceName: "TestDevice",
		onFlightPathEvent: recordFlightPathEvent,
	});

	const path = "Notes/throws-on-emit.md";
	const diskFiles = new Map<string, string>([[path, "D"]]);
	const diskPresent = new Set<string>([path]);

	let mintCalls = 0;
	let emitCalls = 0;
	const sentinel = new Error("synthetic emitDecision failure");

	let thrown: unknown = null;
	try {
		vaultSync.reconcileVault(
			diskFiles,
			diskPresent,
			"authoritative",
			"TestDevice",
			(p) => {
				mintCalls++;
				assertEq(p, path, "Scenario F: callback received the expected path");
				return {
					opId: "op-reconcile-seed-test-throws",
					emitDecision: () => {
						emitCalls++;
						throw sentinel;
					},
				};
			},
		);
	} catch (err) {
		thrown = err;
	}

	assertEq(mintCalls, 1, "Scenario F: mintAdmissionOpId called exactly once");
	assertEq(emitCalls, 1, "Scenario F: emitDecision called exactly once");
	assertEq(thrown, sentinel, "Scenario F: emitDecision throw propagates out of reconcileVault");

	// Postcondition: the seed mutation did NOT happen.
	assert(
		vaultSync.getTextForPath(path) === null,
		"Scenario F: getTextForPath returns null (seed mutation skipped)",
	);

	// Postcondition: no `crdt.file.created` envelope was emitted from
	// `ensureFile` for this path.
	const createdForPath = events.filter(
		(e) => e.kind === "crdt.file.created" && e.path === path,
	);
	assertEq(
		createdForPath.length,
		0,
		"Scenario F: zero crdt.file.created events for the path that failed admission",
	);
}

console.log(`\nno-event-reconcile-admission: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
