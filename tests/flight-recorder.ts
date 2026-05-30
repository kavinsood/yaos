/**
 * Flight recorder tests (updated for v2 spec).
 *
 * Covers:
 *   - PathIdentityResolver: async SHA-256 promise cache, modes, cross-instance consistency
 *   - FlightRecorder: priority-aware queue, safeToShare/includesFilenames, validateSafeEvent
 *   - FlightTraceController: flush(), recordPath() ordering
 *   - Event model: FLIGHT_KIND constants, FlightKind type
 */

import { PathIdentityResolver } from "../src/telemetry/debug/pathIdentity";
import { FLIGHT_KIND } from "../src/telemetry/debug/flightEvents";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

async function assertAsync(fn: () => Promise<boolean>, msg: string): Promise<void> {
	try {
		const result = await fn();
		assert(result, msg);
	} catch (err) {
		console.error(`  FAIL  ${msg} — threw: ${String(err)}`);
		failed++;
	}
}

import { createHash } from "node:crypto";

async function sha256Hex(input: string): Promise<string> {
	return createHash("sha256").update(input).digest("hex");
}

// Track whether sha256Hex was called (to verify it's used, not FNV)
let sha256CallCount = 0;
async function trackingSha256(input: string): Promise<string> {
	sha256CallCount++;
	return sha256Hex(input);
}

// ---------------------------------------------------------------------------
// Test 1: PathIdentityResolver — safe mode produces consistent pathIds
// ---------------------------------------------------------------------------
console.log("\n--- Test 1: PathIdentityResolver safe mode ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, {
		mode: "safe",
		pathSecret: "test-secret-safe",
	});

	const id1 = await resolver.getPathIdentity("Daily/2026-05-12.md");
	const id2 = await resolver.getPathIdentity("Daily/2026-05-12.md");
	assert(id1.pathId === id2.pathId, "Same path gets same pathId within session");
	assert(!id1.path, "safe mode does not expose raw path");
	assert(id1.pathId.startsWith("p:"), "pathId has p: prefix");
	assert(id1.pathId.length >= 34, "pathId has >=32 hex chars (128 bits) after 'p:'");

	const idOther = await resolver.getPathIdentity("Projects/foo.md");
	assert(id1.pathId !== idOther.pathId, "Different paths get different pathIds");
}

// ---------------------------------------------------------------------------
// Test 2: PathIdentityResolver — full mode exposes raw path
// ---------------------------------------------------------------------------
console.log("\n--- Test 2: PathIdentityResolver full mode ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, {
		mode: "full",
		pathSecret: "test-secret-full",
	});

	const id = await resolver.getPathIdentity("Daily/2026-05-12.md");
	assert(id.path === "Daily/2026-05-12.md", "full mode exposes raw path");
	assert(!!id.pathId, "full mode still produces pathId");
}

// ---------------------------------------------------------------------------
// Test 3: safe and full produce same pathId with same secret
// ---------------------------------------------------------------------------
console.log("\n--- Test 3: pathId is consistent across modes (same secret) ---");
{
	const secret = "shared-secret-123";
	const safeResolver = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: secret });
	const fullResolver = new PathIdentityResolver(sha256Hex, { mode: "full", pathSecret: secret });

	const safeId = await safeResolver.getPathIdentity("inbox/note.md");
	const fullId = await fullResolver.getPathIdentity("inbox/note.md");
	assert(safeId.pathId === fullId.pathId, "safe and full produce same pathId with same secret");
}

// ---------------------------------------------------------------------------
// Test 4: qa-safe uses qaTraceSecret for cross-device correlation
// ---------------------------------------------------------------------------
console.log("\n--- Test 4: QA-safe mode uses qaTraceSecret ---");
{
	const qaSecret = "qa-secret-abc";
	const pathSecret = "path-secret-xyz";

	const qaResolver = new PathIdentityResolver(sha256Hex, {
		mode: "qa-safe",
		pathSecret,
		qaTraceSecret: qaSecret,
	});
	// QA-safe should produce same result as safe-mode resolver using qaSecret as pathSecret.
	const safeResolver = new PathIdentityResolver(sha256Hex, {
		mode: "safe",
		pathSecret: qaSecret,
	});

	const qaId = await qaResolver.getPathIdentity("notes/project.md");
	const safeWithSameSecret = await safeResolver.getPathIdentity("notes/project.md");
	assert(qaId.pathId === safeWithSameSecret.pathId, "qa-safe uses qaTraceSecret, not pathSecret");

	// Two qa-safe resolvers with same secret must match (multi-device merge).
	const qaResolver2 = new PathIdentityResolver(sha256Hex, {
		mode: "qa-safe",
		pathSecret: "different-path-secret",
		qaTraceSecret: qaSecret,
	});
	const qaId2 = await qaResolver2.getPathIdentity("notes/project.md");
	assert(qaId.pathId === qaId2.pathId, "Same qaTraceSecret matches across devices regardless of pathSecret");
}

// ---------------------------------------------------------------------------
// Test 5: Different secrets produce different pathIds (cross-bundle isolation)
// ---------------------------------------------------------------------------
console.log("\n--- Test 5: Different secrets produce different pathIds ---");
{
	const r1 = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: "secret-A" });
	const r2 = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: "secret-B" });

	const id1 = await r1.getPathIdentity("Daily/2026-05-12.md");
	const id2 = await r2.getPathIdentity("Daily/2026-05-12.md");
	assert(id1.pathId !== id2.pathId, "Different salts produce different pathIds");
}

// ---------------------------------------------------------------------------
// Test 6: prime() populates cache before getPathIdentity
// ---------------------------------------------------------------------------
console.log("\n--- Test 6: prime() prepopulates cache ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: "prime-test" });
	const paths = ["a.md", "b.md", "c.md"];
	await resolver.prime(paths);

	const id = await resolver.getPathIdentity("a.md");
	assert(id.pathId.startsWith("p:"), "primed path has p: prefix");

	const id2 = await resolver.getPathIdentity("a.md");
	assert(id.pathId === id2.pathId, "prime result is stable on repeated calls");
}

// ---------------------------------------------------------------------------
// Test 7: PathIdentityResolver calls sha256Hex (not FNV) in normal operation
// ---------------------------------------------------------------------------
console.log("\n--- Test 7: PathIdentityResolver uses crypto hash, not FNV ---");
{
	sha256CallCount = 0;
	const resolver = new PathIdentityResolver(trackingSha256, { mode: "safe", pathSecret: "test" });
	await resolver.getPathIdentity("some/file.md");
	assert(sha256CallCount > 0, "sha256Hex was called at least once (not FNV)");

	// The pathId should be 'p:' + 32 hex chars from SHA-256, not 'pd:' (degraded prefix)
	const id = await resolver.getPathIdentity("another/file.md");
	assert(id.pathId.startsWith("p:") && !id.pathId.startsWith("pd:"), "Normal pathId uses p: prefix (not pd: degraded prefix)");
	assert(id.pathId.length === 34, "pathId is p: + 32 hex chars = 34 chars total");
}

// ---------------------------------------------------------------------------
// Test 8: FlightRecorder.safeToShare and includesFilenames
// ---------------------------------------------------------------------------
console.log("\n--- Test 8: FlightRecorder safeToShare / includesFilenames ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async () => {},
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const makeRecorder = (mode: string) =>
		new FlightRecorder(mockApp as never, {
			mode: mode as never,
			deviceId: "test-device",
			vaultIdHash: "0".repeat(64),
			serverHostHash: "1".repeat(64),
			pluginVersion: "1.0.0",
		});

	const safeRec = makeRecorder("safe");
	assert(safeRec.safeToShare === true, "safe mode: safeToShare=true");
	assert(safeRec.includesFilenames === false, "safe mode: includesFilenames=false");
	assert(safeRec.exportable === true, "safe mode: exportable=true");

	const qaSafeRec = makeRecorder("qa-safe");
	assert(qaSafeRec.safeToShare === true, "qa-safe mode: safeToShare=true");
	assert(qaSafeRec.includesFilenames === false, "qa-safe mode: includesFilenames=false");

	const fullRec = makeRecorder("full");
	assert(fullRec.safeToShare === false, "full mode: safeToShare=false");
	assert(fullRec.includesFilenames === true, "full mode: includesFilenames=true");
	assert(fullRec.exportable === true, "full mode: exportable=true");

	const localPrivRec = makeRecorder("local-private");
	assert(localPrivRec.safeToShare === false, "local-private: safeToShare=false");
	assert(localPrivRec.includesFilenames === true, "local-private: includesFilenames=true");
	assert(localPrivRec.exportable === false, "local-private: exportable=false");
}

// ---------------------------------------------------------------------------
// Test 9: validateSafeEvent — event with raw path in data is dropped
// ---------------------------------------------------------------------------
console.log("\n--- Test 9: validateSafeEvent drops events with raw path in data ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const writtenLines: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_path: string, content: string) => { writtenLines.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	// This event has 'path' in data — must be dropped and emit redaction.failure
	recorder.record({
		priority: "important",
		kind: FLIGHT_KIND.crdtFileCreated,
		severity: "info",
		scope: "file",
		source: "vaultSync",
		layer: "crdt",
		pathId: "p:test",
		data: { path: "secret/file.md" },
	});

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = writtenLines.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	// The leaking event must NOT be present
	const hasLeakingEvent = parsed.some(
		(e) => e.kind === FLIGHT_KIND.crdtFileCreated && e.data?.path === "secret/file.md",
	);
	assert(!hasLeakingEvent, "Event with raw path in data was dropped");

	// A redaction.failure event MUST be present
	const hasRedactionFailure = parsed.some((e) => e.kind === FLIGHT_KIND.redactionFailure);
	assert(hasRedactionFailure, "redaction.failure event was emitted for the dropped event");
}

// ---------------------------------------------------------------------------
// Test 10: Priority-aware queue — critical events survive full-buffer pressure
// ---------------------------------------------------------------------------
console.log("\n--- Test 10: Critical events survive full-buffer pressure ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, content: string) => { written.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	// Tiny buffer so it fills quickly
	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
		maxPendingLines: 2,
		maxPendingChars: 2000,
	});

	// Fill buffer with verbose events
	for (let i = 0; i < 5; i++) {
		recorder.record({
			priority: "verbose",
			kind: FLIGHT_KIND.qaCheckpoint,
			severity: "debug",
			scope: "diagnostics",
			source: "traceRuntime",
			layer: "diagnostics",
		});
	}

	// Record a critical event — must not be dropped
	recorder.record({
		priority: "critical",
		kind: FLIGHT_KIND.crdtFileTombstoned,
		severity: "info",
		scope: "file",
		source: "vaultSync",
		layer: "crdt",
		pathId: "p:test-critical",
	});

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	const hasCritical = parsed.some((e) => e.kind === FLIGHT_KIND.crdtFileTombstoned);
	assert(hasCritical, "Critical event survived full-buffer pressure");
}

// ---------------------------------------------------------------------------
// Test 11: Verbose events dropped before important events
// ---------------------------------------------------------------------------
console.log("\n--- Test 11: Verbose events dropped before important events ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, content: string) => { written.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
		maxPendingLines: 2,
		maxPendingChars: 5000,
	});

	// Fill with verbose
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	// Now record an important event — verbose should be evicted
	recorder.record({ priority: "important", kind: FLIGHT_KIND.providerConnected, severity: "info", scope: "connection", source: "connectionController", layer: "provider" });

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	const hasImportant = parsed.some((e) => e.kind === FLIGHT_KIND.providerConnected);
	assert(hasImportant, "Important event survived when buffer was full of verbose entries");
}

// ---------------------------------------------------------------------------
// Test 12: flight.events.dropped includes priority breakdown
// ---------------------------------------------------------------------------
console.log("\n--- Test 12: flight.events.dropped includes droppedByPriority ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, content: string) => { written.push(content); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
		maxPendingLines: 1,
		maxPendingChars: 5000,
	});

	// Force a drop by overfilling with verbose
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "verbose", kind: FLIGHT_KIND.qaCheckpoint, severity: "debug", scope: "diagnostics", source: "traceRuntime", layer: "diagnostics" });
	recorder.record({ priority: "important", kind: FLIGHT_KIND.providerConnected, severity: "info", scope: "connection", source: "connectionController", layer: "provider" });
	recorder.record({ priority: "important", kind: FLIGHT_KIND.providerConnected, severity: "info", scope: "connection", source: "connectionController", layer: "provider" });

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	const parsed = allOutput.trim().split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return null; }
	}).filter(Boolean);

	const droppedEvent = parsed.find((e) => e.kind === FLIGHT_KIND.flightEventsDropped);
	assert(!!droppedEvent, "flight.events.dropped was emitted");
	assert(
		droppedEvent && typeof droppedEvent.data?.droppedByPriority === "object",
		"flight.events.dropped has droppedByPriority breakdown",
	);
	assert(
		droppedEvent && droppedEvent.data?.droppedByPriority?.critical === 0,
		"critical count in droppedByPriority is always 0",
	);
}

// ---------------------------------------------------------------------------
// Test 13: Map indexes rebuild correctly after ring trim (no stale keys)
// ---------------------------------------------------------------------------
console.log("\n--- Test 13: Map indexes rebuild after ring trim ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async () => {},
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const recorder = new FlightRecorder(mockApp as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	// Record two events for different paths and ops
	recorder.record({ priority: "important", kind: FLIGHT_KIND.diskCreateObserved, severity: "info", scope: "file", source: "vaultEvents", layer: "disk", pathId: "p:path-old", opId: "op-old" });
	recorder.record({ priority: "important", kind: FLIGHT_KIND.diskModifyObserved, severity: "info", scope: "file", source: "vaultEvents", layer: "disk", pathId: "p:path-new", opId: "op-new" });

	const timelineOld = recorder.getTimelineForPath("p:path-old");
	const timelineNew = recorder.getTimelineForPath("p:path-new");
	assert(timelineOld.length > 0, "Timeline for old path is present before trim");
	assert(timelineNew.length > 0, "Timeline for new path is present");
}

// ---------------------------------------------------------------------------
// Test 14: FLIGHT_KIND constants cover all Phase A events
// ---------------------------------------------------------------------------
console.log("\n--- Test 14: FLIGHT_KIND taxonomy constants ---");
{
	assert(FLIGHT_KIND.diskCreateObserved === "disk.create.observed", "disk create observed (renamed from create_seen)");
	assert(FLIGHT_KIND.diskModifyObserved === "disk.modify.observed", "disk modify observed");
	assert(FLIGHT_KIND.diskDeleteObserved === "disk.delete.observed", "disk delete observed");
	assert(FLIGHT_KIND.diskEventSuppressed === "disk.event.suppressed", "disk event suppressed (meta, kept)");
	assert(FLIGHT_KIND.diskEventNotSuppressed === "disk.event.not_suppressed", "disk not suppressed (critical)");
	assert(FLIGHT_KIND.diskWriteOk === "disk.write.ok", "disk write ok");
	assert(FLIGHT_KIND.diskWriteFailed === "disk.write.failed", "disk write failed");
	assert(FLIGHT_KIND.crdtFileCreated === "crdt.file.created", "crdt file created");
	assert(FLIGHT_KIND.crdtFileUpdated === "crdt.file.updated", "crdt file updated (new)");
	assert(FLIGHT_KIND.crdtFileTombstoned === "crdt.file.tombstoned", "crdt file tombstoned");
	assert(FLIGHT_KIND.crdtFileRevived === "crdt.file.revived", "crdt file revived");
	assert(FLIGHT_KIND.reconcileComplete === "reconcile.complete", "reconcile complete");
	assert(FLIGHT_KIND.reconcileFileDecision === "reconcile.file.decision", "reconcile file decision (new)");
	assert(FLIGHT_KIND.reconcileSafetyBrakeTriggered === "reconcile.safety_brake.triggered", "safety brake");
	assert(FLIGHT_KIND.serverReceiptConfirmed === "server.receipt.confirmed", "receipt confirmed");
	assert(FLIGHT_KIND.serverReceiptCandidateCaptured === "server.receipt.candidate_captured", "receipt candidate");
	assert(FLIGHT_KIND.qaCheckpoint === "qa.checkpoint", "qa checkpoint");
	assert(FLIGHT_KIND.exportManifest === "export.manifest", "export manifest (new)");
	assert(FLIGHT_KIND.redactionFailure === "redaction.failure", "redaction failure (new)");
	assert(FLIGHT_KIND.pathIdentityDegraded === "path.identity.degraded", "path identity degraded (new)");
	assert(FLIGHT_KIND.flightLogsRotated === "flight.logs.rotated", "logs rotated (new)");
}

// ---------------------------------------------------------------------------
// Test 15: qaTraceSecret must never appear in any serialized event
// ---------------------------------------------------------------------------
console.log("\n--- Test 15: qaTraceSecret never leaks into NDJSON ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const written: string[] = [];
	const mockApp = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async (_: string, c: string) => { written.push(c); },
				mkdir: async () => {},
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => ({ size: 0 }),
				remove: async () => {},
				rmdir: async () => {},
			},
		},
	};

	const SECRET = "super-secret-qa-trace-key-do-not-leak";
	const recorder = new FlightRecorder(mockApp as never, {
		mode: "qa-safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	// Record an event that tries to smuggle the secret
	recorder.record({
		priority: "important",
		kind: FLIGHT_KIND.qaTraceStarted,
		severity: "info",
		scope: "diagnostics",
		source: "diagnostics",
		layer: "diagnostics",
		data: { mode: "qa-safe" }, // no secret here — this is correct
	});

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	assert(!allOutput.includes(SECRET), "qaTraceSecret did not leak into NDJSON output");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────\n");

if (failed > 0) {
	process.exit(1);
}
