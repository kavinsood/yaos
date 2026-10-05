/**
 * Tests for TraceSink infrastructure.
 *
 * Proves:
 * - FlightTraceSink maps domain events to flight events correctly
 * - NoopTraceSink drops events
 * - Domain event kinds map to correct FLIGHT_KIND constants
 * - Unknown domain events are silently dropped
 * - recordPath is non-blocking (no Promise returned to caller)
 * - record() increments droppedEventCount (non-path events not yet mapped)
 * - Every PRODUCT_EVENT_KIND string value has a matching FLIGHT_KIND entry
 *   (compatibility — events may bypass the adapter but their strings must
 *   remain valid within the flight taxonomy)
 *
 * SCOPE / MIGRATION STATUS:
 *
 *   FlightTraceSink.recordPath() is the domain→flight ADAPTER. It maps 12
 *   domain event kinds (rename, disk observation, CRDT lifecycle, reconcile
 *   deferred) to the flight schema. These events originate from main.ts's
 *   vault event handlers via this.traceSink.recordPath().
 *
 *   Most PRODUCT_EVENT_KIND values (recovery.*, reconcile.start/complete/
 *   safety-brake, editor.*, disk.write.*) bypass the adapter entirely — they
 *   are emitted as fully-formed ProductFlightPathEventInput objects directly
 *   through plugin.recordFlightPathEvent(). They already carry kind, source,
 *   layer, and priority and need no adapter mapping.
 *
 *   What is NOT yet migrated to TraceSink (and is explicitly deferred):
 *   - diskMirror.ts: emits disk.write.ok/failed via raw flight callbacks
 *   - main.ts: provider.connected/disconnected/sync.complete via recordFlightEvent
 *   - Full domain-event type coverage (only ~12 of ~47 flight kinds go through TraceSink)
 *
 *   These tests DO NOT claim that all product events route through TraceSink.
 *   They prove: (A) adapter mapping is exhaustive for its 12 domain kinds,
 *   (B) product event strings remain compatible with flight taxonomy strings,
 *   (C) unmapped/non-path events are dropped observably.
 */

import { FlightTraceSink } from "../../legacy-src/telemetry/debug/flightTraceSink";
import { NoopTraceSink } from "../../legacy-src/observability/noopTraceSink";
import { FLIGHT_KIND } from "../../legacy-src/observability/flightTaxonomy";
import { PRODUCT_EVENT_KIND } from "../../legacy-src/observability/productEventKinds";
import type { DomainPathTraceEvent } from "../../legacy-src/observability/traceSink";
import { suite } from "../harness.ts";

const s = suite("trace-sink");

s.section("Test 1: FlightTraceSink maps rename.observed to diskRenameObserved");
{
	const recorded: unknown[] = [];
	const sink = new FlightTraceSink((event) => recorded.push(event));

	sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		opId: "op-123",
		path: "notes/file.md",
		data: { renameRole: "source", category: "markdown", opId: "op-123" },
	});

	s.check(recorded.length === 1, "one event recorded");
	const event = recorded[0] as Record<string, unknown>;
	s.check(event.kind === FLIGHT_KIND.diskRenameObserved, "mapped to diskRenameObserved");
	s.check(event.path === "notes/file.md", "path preserved");
	s.check(event.priority === "important", "info severity -> important priority");
	s.check(event.source === "vaultEvents", "source is vaultEvents");
	s.check(event.layer === "disk", "layer is disk");
}

s.section("Test 2: FlightTraceSink maps rename.admission.invariant-failed");
{
	const recorded: unknown[] = [];
	const sink = new FlightTraceSink((event) => recorded.push(event));

	sink.recordPath({
		kind: "rename.admission.invariant-failed",
		scope: "file",
		severity: "error",
		path: ".trash/leaked.md",
		data: { bug: "excluded-destination-reached-applyRenameBatch" },
	});

	s.check(recorded.length === 1, "one event recorded");
	const event = recorded[0] as Record<string, unknown>;
	s.check(event.kind === FLIGHT_KIND.renameAdmissionInvariantFailed, "mapped to renameAdmissionInvariantFailed");
	s.check(event.priority === "critical", "error severity -> critical priority");
	s.check(event.layer === "policy", "layer is policy for admission events");
}

s.section("Test 3: unknown domain event is silently dropped");
{
	const recorded: unknown[] = [];
	const sink = new FlightTraceSink((event) => recorded.push(event));

	sink.recordPath({
		kind: "some.future.event",
		scope: "file",
		severity: "debug",
		path: "notes/x.md",
	});

	s.check(recorded.length === 0, "unknown event dropped silently");
	s.check(sink.getDroppedEventCount() === 1, "dropped event count incremented");
}

s.section("Test 3b: getDroppedEventCount tracks multiple drops");
{
	const sink = new FlightTraceSink(() => {});

	sink.recordPath({ kind: "unknown.a", scope: "file", severity: "debug", path: "a.md" });
	sink.recordPath({ kind: "unknown.b", scope: "file", severity: "debug", path: "b.md" });
	sink.recordPath({ kind: "rename.observed", scope: "file", severity: "info", path: "c.md", data: { renameRole: "source", category: "markdown", opId: "op-1" } });
	sink.recordPath({ kind: "unknown.c", scope: "file", severity: "debug", path: "d.md" });

	s.check(sink.getDroppedEventCount() === 3, "dropped count is 3 (excludes mapped event)");
}

s.section("Test 4: NoopTraceSink drops everything");
{
	const sink = new NoopTraceSink();
	// Should not throw.
	sink.record({ kind: "test", scope: "vault", severity: "info" });
	sink.recordPath({ kind: "test", scope: "file", severity: "info", path: "x.md" });
	s.check(true, "NoopTraceSink does not throw");
}

s.section("Test 5: recordPath is non-blocking (returns void, not Promise)");
{
	const sink = new FlightTraceSink(() => {});
	const result = sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		path: "x.md",
		data: { renameRole: "source", category: "markdown", opId: "op-1" },
	});
	s.check(result === undefined, "recordPath returns undefined (not a Promise)");
}

s.section("Test 6: flush returns a Promise");
{
	const sink = new FlightTraceSink(() => {});
	const result = sink.flush();
	s.check(result instanceof Promise, "flush returns a Promise");
}

s.section("Test 7: severity mapping");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	const severities = ["debug", "info", "warn", "error"] as const;
	for (const sev of severities) {
		sink.recordPath({
			kind: "rename.observed",
			scope: "file",
			severity: sev,
			path: "x.md",
			data: { renameRole: "source", category: "markdown", opId: "op-1" },
		});
	}

	s.check(recorded[0]!.priority === "verbose", "debug -> verbose");
	s.check(recorded[1]!.priority === "important", "info -> important");
	s.check(recorded[2]!.priority === "important", "warn -> important");
	s.check(recorded[3]!.priority === "critical", "error -> critical");
}

s.section("Test 8: rename event pair (source + target)");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	// Simulate what main.ts does:
	sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		opId: "op-99",
		path: "notes/old.md",
		data: { renameRole: "source", category: "markdown", opId: "op-99" },
	});
	sink.recordPath({
		kind: "rename.observed",
		scope: "file",
		severity: "info",
		opId: "op-99",
		path: "notes/new.md",
		data: { renameRole: "target", category: "markdown", opId: "op-99" },
	});

	s.check(recorded.length === 2, "two events for rename pair");
	s.check(recorded[0]!.path === "notes/old.md", "first event is source");
	s.check(recorded[1]!.path === "notes/new.md", "second event is target");
	s.check(recorded[0]!.opId === "op-99", "opId preserved on source");
	s.check(recorded[1]!.opId === "op-99", "opId preserved on target");
}

s.section("Test 9: disk.create.observed maps correctly");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	sink.recordPath({
		kind: "disk.create.observed",
		scope: "file",
		severity: "info",
		opId: "op-create-1",
		path: "notes/new-file.md",
		data: { size: 1024 },
	});

	s.check(recorded.length === 1, "one event recorded");
	s.check(recorded[0]!.kind === FLIGHT_KIND.diskCreateObserved, "mapped to diskCreateObserved");
	s.check(recorded[0]!.path === "notes/new-file.md", "path preserved");
	s.check(recorded[0]!.priority === "important", "info severity -> important priority");
	s.check(recorded[0]!.layer === "disk", "layer is disk");
	s.check((recorded[0]!.data as Record<string, unknown>).size === 1024, "data.size preserved");
}

s.section("Test 10: disk.modify.observed maps correctly");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	sink.recordPath({
		kind: "disk.modify.observed",
		scope: "file",
		severity: "info",
		opId: "op-modify-1",
		path: "notes/edited.md",
		data: {
			size: 2048,
			writerGuess: "external",
			suppressWindowActive: false,
			lastDiskWriteOkAtMs: 1000,
			msSinceLastDiskWriteOk: 5000,
		},
	});

	s.check(recorded.length === 1, "one event recorded");
	s.check(recorded[0]!.kind === FLIGHT_KIND.diskModifyObserved, "mapped to diskModifyObserved");
	s.check(recorded[0]!.layer === "disk", "layer is disk");
	const data = recorded[0]!.data as Record<string, unknown>;
	s.check(data.writerGuess === "external", "data.writerGuess preserved");
	s.check(data.suppressWindowActive === false, "data.suppressWindowActive preserved");
}

s.section("Test 11: disk.delete.observed with priority override");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	sink.recordPath({
		kind: "disk.delete.observed",
		scope: "file",
		severity: "info",
		priority: "critical",  // explicit override
		opId: "op-delete-1",
		path: "notes/deleted.md",
	});

	s.check(recorded.length === 1, "one event recorded");
	s.check(recorded[0]!.kind === FLIGHT_KIND.diskDeleteObserved, "mapped to diskDeleteObserved");
	s.check(recorded[0]!.priority === "critical", "priority override respected (not derived from severity)");
	s.check(recorded[0]!.layer === "disk", "layer is disk");
}

s.section("Test 12: disk.event.suppressed with reason/decision extraction");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	sink.recordPath({
		kind: "disk.event.suppressed",
		scope: "file",
		severity: "debug",
		priority: "important",  // explicit override
		opId: "op-suppress-1",
		path: "notes/suppressed.md",
		data: {
			reason: "suppressed-remote-writeback",
			decision: "suppress",
		},
	});

	s.check(recorded.length === 1, "one event recorded");
	s.check(recorded[0]!.kind === FLIGHT_KIND.diskEventSuppressed, "mapped to diskEventSuppressed");
	s.check(recorded[0]!.priority === "important", "priority override respected");
	s.check(recorded[0]!.layer === "policy", "layer is policy for suppression");
	s.check(recorded[0]!.reason === "suppressed-remote-writeback", "reason lifted from data");
	s.check(recorded[0]!.decision === "suppress", "decision lifted from data");
}

s.section("Test 13: droppedEventCount stays zero for all mapped disk events");
{
	const sink = new FlightTraceSink(() => {});

	sink.recordPath({ kind: "disk.create.observed", scope: "file", severity: "info", path: "a.md", data: { size: 1 } });
	sink.recordPath({ kind: "disk.modify.observed", scope: "file", severity: "info", path: "b.md", data: {} });
	sink.recordPath({ kind: "disk.delete.observed", scope: "file", severity: "info", priority: "critical", path: "c.md" });
	sink.recordPath({ kind: "disk.event.suppressed", scope: "file", severity: "debug", priority: "important", path: "d.md", data: { reason: "x", decision: "y" } });

	s.check(sink.getDroppedEventCount() === 0, "no dropped events for mapped disk kinds");
}

s.section("Test 14: CRDT lifecycle events route correctly through FlightTraceSink");
{
	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	sink.recordPath({ kind: "crdt.file.created",    scope: "file", severity: "info",  priority: "important", path: "a.md", opId: "op-1", data: { fileId: "id-1" } });
	sink.recordPath({ kind: "crdt.file.renamed",    scope: "file", severity: "info",  priority: "important", path: "b.md", data: { fileId: "id-2", batchSize: 1 } });
	sink.recordPath({ kind: "crdt.file.tombstoned", scope: "file", severity: "info",  priority: "critical",  path: "c.md", opId: "op-2", data: { fileId: "id-3" } });
	sink.recordPath({ kind: "crdt.file.revived",    scope: "file", severity: "info",  priority: "critical",  path: "d.md", opId: "op-3", data: { reason: "force-revive" } });

	s.check(recorded.length === 4, "all 4 CRDT events recorded");
	s.check(recorded[0]!.kind === FLIGHT_KIND.crdtFileCreated,    "crdt.file.created → crdtFileCreated");
	s.check(recorded[1]!.kind === FLIGHT_KIND.crdtFileRenamed,    "crdt.file.renamed → crdtFileRenamed");
	s.check(recorded[2]!.kind === FLIGHT_KIND.crdtFileTombstoned, "crdt.file.tombstoned → crdtFileTombstoned");
	s.check(recorded[3]!.kind === FLIGHT_KIND.crdtFileRevived,    "crdt.file.revived → crdtFileRevived");
	s.check(recorded[0]!.layer === "crdt",    "CRDT events use crdt layer");
	s.check(recorded[0]!.source === "vaultSync", "CRDT events source is vaultSync");
	s.check(recorded[0]!.fileId === "id-1",   "fileId lifted from data");
	s.check(recorded[2]!.priority === "critical", "priority override preserved for tombstone");
	s.check(recorded[3]!.reason === "force-revive", "reason lifted from data for revived");
	s.check(sink.getDroppedEventCount() === 0, "no dropped events for CRDT kinds");
}

s.section("Test 15A: Complete domain adapter coverage — all 12 mapped kinds produce zero drops");
{
	// This is the exhaustive adapter-mapping CI invariant.
	// Every domain event kind in DOMAIN_TO_FLIGHT_KIND must:
	//   1. Not be dropped (droppedEventCount stays 0)
	//   2. Produce exactly one recorded flight event
	//   3. Map to the correct FLIGHT_KIND string
	//
	// If a new entry is added to DOMAIN_TO_FLIGHT_KIND without appearing here,
	// the test will not catch it — but the inverse (removing a mapping) WILL
	// cause other tests (13, 14) to fail. This test is the positive exhaustive check.

	const EXPECTED_MAPPINGS: Array<{ domainKind: string; flightKind: string; layer: string; source: string }> = [
		// Rename cluster
		{ domainKind: "rename.observed",                     flightKind: FLIGHT_KIND.diskRenameObserved,              layer: "disk",      source: "vaultEvents" },
		{ domainKind: "rename.admission.invariant-failed",   flightKind: FLIGHT_KIND.renameAdmissionInvariantFailed,  layer: "policy",    source: "vaultEvents" },
		{ domainKind: "rename.admission.canonical-collision", flightKind: FLIGHT_KIND.renameAdmissionCanonicalCollision, layer: "policy", source: "vaultEvents" },
		// Disk observation cluster
		{ domainKind: "disk.create.observed",                flightKind: FLIGHT_KIND.diskCreateObserved,              layer: "disk",      source: "vaultEvents" },
		{ domainKind: "disk.modify.observed",                flightKind: FLIGHT_KIND.diskModifyObserved,              layer: "disk",      source: "vaultEvents" },
		{ domainKind: "disk.delete.observed",                flightKind: FLIGHT_KIND.diskDeleteObserved,              layer: "disk",      source: "vaultEvents" },
		{ domainKind: "disk.event.suppressed",               flightKind: FLIGHT_KIND.diskEventSuppressed,             layer: "policy",    source: "vaultEvents" },
		// CRDT lifecycle cluster
		{ domainKind: "crdt.file.created",                   flightKind: FLIGHT_KIND.crdtFileCreated,                 layer: "crdt",      source: "vaultSync" },
		{ domainKind: "crdt.file.renamed",                   flightKind: FLIGHT_KIND.crdtFileRenamed,                 layer: "crdt",      source: "vaultSync" },
		{ domainKind: "crdt.file.tombstoned",                flightKind: FLIGHT_KIND.crdtFileTombstoned,              layer: "crdt",      source: "vaultSync" },
		{ domainKind: "crdt.file.revived",                   flightKind: FLIGHT_KIND.crdtFileRevived,                 layer: "crdt",      source: "vaultSync" },
		// Reconcile deferred
		{ domainKind: "reconcile.file.deferred",             flightKind: FLIGHT_KIND.reconcileFileDeferred,           layer: "reconcile", source: "vaultSync" },
	];

	const recorded: Array<Record<string, unknown>> = [];
	const sink = new FlightTraceSink((event) => recorded.push(event as Record<string, unknown>));

	for (const { domainKind } of EXPECTED_MAPPINGS) {
		sink.recordPath({ kind: domainKind, scope: "file", severity: "info", path: "test.md", data: {} });
	}

	s.check(sink.getDroppedEventCount() === 0,
		`all ${EXPECTED_MAPPINGS.length} domain kinds mapped without drops (droppedEventCount=0)`);
	s.check(recorded.length === EXPECTED_MAPPINGS.length,
		`exactly ${EXPECTED_MAPPINGS.length} events recorded (got ${recorded.length})`);

	for (let i = 0; i < EXPECTED_MAPPINGS.length; i++) {
		const expected = EXPECTED_MAPPINGS[i]!;
		const actual = recorded[i]!;
		s.check(actual.kind === expected.flightKind,
			`${expected.domainKind} → kind "${expected.flightKind}"`);
		s.check(actual.layer === expected.layer,
			`${expected.domainKind} → layer "${expected.layer}"`);
		s.check(actual.source === expected.source,
			`${expected.domainKind} → source "${expected.source}"`);
	}
}

s.section("Test 15B: PRODUCT_EVENT_KIND string compatibility with FLIGHT_KIND");
{
	// This test proves that every PRODUCT_EVENT_KIND string value has a matching
	// entry in FLIGHT_KIND. This is NOT the same as saying they all route through
	// FlightTraceSink — most bypass the adapter and go directly through
	// recordFlightPathEvent. But their string values must remain valid flight
	// taxonomy constants so the flight recorder can classify them correctly.
	//
	// If a new PRODUCT_EVENT_KIND is introduced with a string that does not
	// match any FLIGHT_KIND value, this test fails — catching the incompatibility
	// before it produces unclassifiable flight events.

	const flightKindValues = new Set(Object.values(FLIGHT_KIND));
	const productKindValues = Object.values(PRODUCT_EVENT_KIND);

	let allCompatible = true;
	for (const productKind of productKindValues) {
		if (!flightKindValues.has(productKind as typeof FLIGHT_KIND[keyof typeof FLIGHT_KIND])) {
			s.check(false, `PRODUCT_EVENT_KIND value "${productKind}" has no matching FLIGHT_KIND entry`);
			allCompatible = false;
		}
	}
	s.check(allCompatible,
		`all ${productKindValues.length} PRODUCT_EVENT_KIND values have matching FLIGHT_KIND entries`);
}

s.section("Test 15C: record() and unmapped recordPath() both increment droppedEventCount");
{
	// FlightTraceSink.record() is a stub — non-path events are not yet mapped.
	// It must visibly drop events (increment counter) rather than silently discard.
	// FlightTraceSink.recordPath() with an unknown kind must also drop observably.
	// This is the behavioral contract for observability: QA/dev mode can detect
	// missing mappings via getDroppedEventCount().

	const sink = new FlightTraceSink(() => {});

	// record() always drops (non-path events not yet mapped)
	sink.record({ kind: "reconcile.start", scope: "vault", severity: "info" });
	sink.record({ kind: "provider.connected", scope: "connection", severity: "info" });
	sink.record({ kind: "some.future.non-path.event", scope: "vault", severity: "debug" });

	s.check(sink.getDroppedEventCount() === 3,
		"record() increments droppedEventCount for every call (3 non-path events dropped)");

	// recordPath() with unmapped kind also drops
	sink.recordPath({ kind: "recovery.decision", scope: "file", severity: "info", path: "x.md" });
	sink.recordPath({ kind: "totally.unknown.kind", scope: "file", severity: "debug", path: "y.md" });

	s.check(sink.getDroppedEventCount() === 5,
		"unmapped recordPath() kinds also increment droppedEventCount (total 5)");

	// Verify that a mapped kind does NOT increment the counter
	sink.recordPath({ kind: "disk.create.observed", scope: "file", severity: "info", path: "z.md", data: {} });
	s.check(sink.getDroppedEventCount() === 5,
		"mapped recordPath() kind does NOT increment droppedEventCount (still 5)");
}
await s.done();
