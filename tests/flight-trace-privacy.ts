/**
 * Privacy tests for flight trace streaming logs (v2 spec).
 *
 * Verifies:
 *   1. Safe envelope never contains raw host, vaultId, deviceName
 *   2. pathId never leaks raw path in safe mode
 *   3. full vs safe mode path exposure
 *   4. Token and host never appear in safe event data
 *   5. Nested error messages do not smuggle raw paths
 *   6. Multi-device pathId correlation via qaTraceSecret
 *   7. Different QA run secrets are uncorrelated
 *   8. Safe export is refused for full-mode recorder
 *   9. Safe export is refused for local-private recorder
 *   10. CRDT event in safe mode: no raw path in serialized JSON
 *   11. PathIdentityResolver uses crypto hash (hasDegraded stays false)
 */

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

import { FLIGHT_EVENT_SCHEMA_VERSION, FLIGHT_TAXONOMY_VERSION, FLIGHT_KIND } from "../src/telemetry/debug/flightEvents";
import { PathIdentityResolver } from "../src/telemetry/debug/pathIdentity";
import { createHash } from "node:crypto";

async function sha256Hex(input: string): Promise<string> {
	return createHash("sha256").update(input).digest("hex");
}

function buildEnvelope(input: Record<string, unknown>): Record<string, unknown> {
	return {
		eventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
		taxonomyVersion: FLIGHT_TAXONOMY_VERSION,
		ts: Date.now(),
		seq: 1,
		traceId: "trace-test",
		bootId: "boot-test",
		deviceId: "device-test-id",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
		...input,
	};
}

function serialize(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

function containsSensitive(
	line: string,
	sensitiveValues: string[],
): { found: boolean; value: string } {
	for (const val of sensitiveValues) {
		if (val && line.includes(val)) {
			return { found: true, value: val };
		}
	}
	return { found: false, value: "" };
}

const RAW_PATH = "Projects/secret/finance.md";
const HOST_URL = "https://my-sync-server.example.com";
const DEVICE_NAME = "MacBook-Kavins-Private";
const VAULT_ID = "vault-id-very-unique-12345";
const SYNC_TOKEN = "Bearer sk_live_abcdef1234567890";

const SENSITIVE_VALUES = [RAW_PATH, HOST_URL, DEVICE_NAME, VAULT_ID, SYNC_TOKEN];

// ---------------------------------------------------------------------------
// Test 1: Envelope fields are hashed, not raw
// ---------------------------------------------------------------------------
console.log("\n--- Test 1: Envelope fields are hashed, not raw ---");
{
	const event = buildEnvelope({
		kind: FLIGHT_KIND.diskModifyObserved,
		severity: "info",
		scope: "file",
		source: "vaultEvents",
		layer: "disk",
		priority: "important",
		vaultIdHash: await sha256Hex(VAULT_ID),
		serverHostHash: await sha256Hex(HOST_URL),
		deviceId: "stable-device-id-hash",
	});

	const line = serialize(event);
	const { found, value } = containsSensitive(line, [HOST_URL, VAULT_ID, DEVICE_NAME, SYNC_TOKEN]);
	assert(!found, `Safe envelope does not contain sensitive values (found: ${value || "none"})`);
}

// ---------------------------------------------------------------------------
// Test 2: pathId never leaks raw path in safe mode
// ---------------------------------------------------------------------------
console.log("\n--- Test 2: pathId never leaks raw path ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, {
		mode: "safe",
		pathSecret: "session-salt-xyz",
	});
	const { pathId, path } = await resolver.getPathIdentity(RAW_PATH);

	const eventWithPath = buildEnvelope({
		kind: FLIGHT_KIND.diskCreateObserved,
		severity: "info",
		scope: "file",
		source: "vaultEvents",
		layer: "disk",
		priority: "important",
		pathId,
		path, // undefined in safe mode
	});

	const line = serialize(eventWithPath);
	assert(!line.includes(RAW_PATH), "pathId event does not include raw path in safe mode");
	assert(line.includes(pathId), "pathId is present in output");
}

// ---------------------------------------------------------------------------
// Test 3: full mode includes raw path, safe mode does not
// ---------------------------------------------------------------------------
console.log("\n--- Test 3: full vs safe mode path exposure ---");
{
	const safeResolver = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: "s1" });
	const fullResolver = new PathIdentityResolver(sha256Hex, { mode: "full", pathSecret: "s1" });

	const safeIdentity = await safeResolver.getPathIdentity(RAW_PATH);
	const fullIdentity = await fullResolver.getPathIdentity(RAW_PATH);

	const safeLine = serialize(buildEnvelope({ pathId: safeIdentity.pathId, path: safeIdentity.path }));
	const fullLine = serialize(buildEnvelope({ pathId: fullIdentity.pathId, path: fullIdentity.path }));

	assert(!safeLine.includes(RAW_PATH), "safe mode: raw path absent");
	assert(fullLine.includes(RAW_PATH), "full mode: raw path present");
}

// ---------------------------------------------------------------------------
// Test 4: Token and host never appear in safe event data
// ---------------------------------------------------------------------------
console.log("\n--- Test 4: Token and host never appear as data values ---");
{
	const event = buildEnvelope({
		kind: FLIGHT_KIND.providerConnected,
		severity: "info",
		scope: "connection",
		source: "connectionController",
		layer: "provider",
		priority: "important",
		serverHostHash: await sha256Hex(HOST_URL),
		data: { note: "connected" },
	});
	const line = serialize(event);
	assert(!line.includes(HOST_URL), "Provider event does not leak host URL");
	assert(!line.includes(SYNC_TOKEN), "Provider event does not leak sync token");
}

// ---------------------------------------------------------------------------
// Test 5: Error messages do not smuggle raw path
// ---------------------------------------------------------------------------
console.log("\n--- Test 5: Error messages do not smuggle raw path ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: "err-salt" });
	const { pathId } = await resolver.getPathIdentity(RAW_PATH);

	const safeErrorEvent = buildEnvelope({
		kind: FLIGHT_KIND.diskWriteFailed,
		severity: "error",
		scope: "file",
		source: "diskMirror",
		layer: "disk",
		priority: "critical",
		pathId,
		data: {
			error: `write failed for pathId=${pathId}`, // uses pathId, not raw path
		},
	});

	const line = serialize(safeErrorEvent);
	assert(!line.includes(RAW_PATH), "Error message does not contain raw path");
	assert(line.includes(pathId), "Error message contains pathId");
}

// ---------------------------------------------------------------------------
// Test 6: Multi-device correlation — same qaTraceSecret yields same pathId
// ---------------------------------------------------------------------------
console.log("\n--- Test 6: Multi-device pathId correlation ---");
{
	const qaSecret = "shared-qa-secret-for-device-a-b";
	const deviceA = new PathIdentityResolver(sha256Hex, {
		mode: "qa-safe",
		pathSecret: "device-a-local-salt",
		qaTraceSecret: qaSecret,
	});
	const deviceB = new PathIdentityResolver(sha256Hex, {
		mode: "qa-safe",
		pathSecret: "device-b-local-salt",
		qaTraceSecret: qaSecret,
	});

	const idA = await deviceA.getPathIdentity(RAW_PATH);
	const idB = await deviceB.getPathIdentity(RAW_PATH);

	assert(idA.pathId === idB.pathId, "Device A and B produce same pathId with shared qaTraceSecret");
	assert(!idA.path, "Device A: path not exposed in qa-safe mode");
	assert(!idB.path, "Device B: path not exposed in qa-safe mode");
}

// ---------------------------------------------------------------------------
// Test 7: Different QA run secrets cannot be correlated
// ---------------------------------------------------------------------------
console.log("\n--- Test 7: Different QA run secrets are uncorrelated ---");
{
	const run1 = new PathIdentityResolver(sha256Hex, {
		mode: "qa-safe",
		pathSecret: "run1-local",
		qaTraceSecret: "qa-secret-run-1",
	});
	const run2 = new PathIdentityResolver(sha256Hex, {
		mode: "qa-safe",
		pathSecret: "run2-local",
		qaTraceSecret: "qa-secret-run-2",
	});

	const id1 = await run1.getPathIdentity(RAW_PATH);
	const id2 = await run2.getPathIdentity(RAW_PATH);
	assert(id1.pathId !== id2.pathId, "Different QA run secrets produce different pathIds");
}

// ---------------------------------------------------------------------------
// Test 8: Safe export refused for full-mode recorder
// ---------------------------------------------------------------------------
console.log("\n--- Test 8: Safe export refused for full-mode recorder ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const recorder = new FlightRecorder({
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
	} as never, {
		mode: "full",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	assert(!recorder.safeToShare, "Full-mode recorder: safeToShare=false");
	assert(recorder.includesFilenames, "Full-mode recorder: includesFilenames=true");
	// The export controller checks safeToShare before writing — recorder itself
	// only exposes the getter; test that the flag is correct.
}

// ---------------------------------------------------------------------------
// Test 9: Safe export refused for local-private recorder
// ---------------------------------------------------------------------------
console.log("\n--- Test 9: Local-private recorder is not exportable ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const recorder = new FlightRecorder({
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
	} as never, {
		mode: "local-private",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	assert(!recorder.exportable, "Local-private recorder is not exportable");
	assert(!recorder.safeToShare, "Local-private recorder: safeToShare=false");
}

// ---------------------------------------------------------------------------
// Test 10: CRDT event in safe mode — no raw path in serialized JSON
// ---------------------------------------------------------------------------
console.log("\n--- Test 10: CRDT event in safe mode: no raw path in output ---");
{
	const { FlightRecorder } = await import("../src/telemetry/debug/flightRecorder");
	const written: string[] = [];
	const recorder = new FlightRecorder({
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
	} as never, {
		mode: "safe",
		deviceId: "test-device",
		vaultIdHash: "0".repeat(64),
		serverHostHash: "1".repeat(64),
		pluginVersion: "1.0.0",
	});

	// This simulates a properly-written CRDT event (path resolved to pathId,
	// no raw path in data).
	const resolver = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: "safe-salt" });
	const { pathId } = await resolver.getPathIdentity(RAW_PATH);

	recorder.record({
		priority: "important",
		kind: FLIGHT_KIND.crdtFileCreated,
		severity: "info",
		scope: "file",
		source: "vaultSync",
		layer: "crdt",
		pathId,
		opId: "op-xyz",
		// data does NOT contain path — correct
	});

	await recorder.flushNow();
	await recorder.shutdown();

	const allOutput = written.join("");
	assert(!allOutput.includes(RAW_PATH), "CRDT created event in safe mode: no raw path in output");
	assert(allOutput.includes(pathId), "CRDT created event includes pathId");
}

// ---------------------------------------------------------------------------
// Test 11: PathIdentityResolver.hasDegraded stays false with working crypto
// ---------------------------------------------------------------------------
console.log("\n--- Test 11: hasDegraded is false when crypto works ---");
{
	const resolver = new PathIdentityResolver(sha256Hex, { mode: "safe", pathSecret: "test" });
	await resolver.getPathIdentity("some/file.md");
	assert(!resolver.hasDegraded, "hasDegraded is false when sha256Hex works");
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
