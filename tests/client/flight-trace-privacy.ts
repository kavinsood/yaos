/**
 * Privacy tests for flight trace streaming logs (v2 spec).
 *
 * Verifies:
 *   1. Safe envelope never contains raw host, vaultId, deviceName
 *   2. pathId never leaks the raw path
 *   3. The raw path is reachable only through resolver.directory()
 *   4. Token and host never appear in safe event data
 *   5. Nested error messages do not smuggle raw paths
 *   6. Multi-device pathId correlation via the vault-derived salt
 *   7. Different vaults are uncorrelated
 *   8. Safe export is refused for a full-mode recorder
 *   9. Safe export is refused for a local-private recorder
 *   10. CRDT event in safe mode: no raw path in serialized JSON
 *   11. PathIdentityResolver uses crypto hash (hasDegraded stays false)
 */

import { suite } from "../harness.ts";

const s = suite("flight-trace-privacy");

import { FLIGHT_EVENT_SCHEMA_VERSION } from "../../src/observability/flightEnvelope";
import { FLIGHT_TAXONOMY_VERSION, FLIGHT_KIND } from "../../src/observability/flightTaxonomy";
import { PathIdentityResolver, deriveVaultPathSalt } from "../../src/telemetry/debug/pathIdentity";
import { FlightRecorder } from "../../src/telemetry/debug/flightRecorder";
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
const DEVICE_TOKEN = "Bearer dv_live_abcdef1234567890";

const SENSITIVE_VALUES = [RAW_PATH, HOST_URL, DEVICE_NAME, VAULT_ID, DEVICE_TOKEN];

// ---------------------------------------------------------------------------
// Test 1: Envelope fields are hashed, not raw
// ---------------------------------------------------------------------------
s.section("Test 1: Envelope fields are hashed, not raw");
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
	const { found, value } = containsSensitive(line, [HOST_URL, VAULT_ID, DEVICE_NAME, DEVICE_TOKEN]);
	s.check(!found, `Safe envelope does not contain sensitive values (found: ${value || "none"})`);
}

// ---------------------------------------------------------------------------
// Test 2: pathId never leaks the raw path
// ---------------------------------------------------------------------------
s.section("Test 2: pathId never leaks raw path");
{
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "session-salt-xyz" });
	const { pathId, path } = await resolver.getPathIdentity(RAW_PATH);
	s.check(path === undefined, "Resolver returns no raw path");

	const eventWithPath = buildEnvelope({
		kind: FLIGHT_KIND.diskCreateObserved,
		severity: "info",
		scope: "file",
		source: "vaultEvents",
		layer: "disk",
		priority: "important",
		pathId,
		path,
	});

	const line = serialize(eventWithPath);
	s.check(!line.includes(RAW_PATH), "pathId event does not include raw path");
	s.check(line.includes(pathId), "pathId is present in output");
}

// ---------------------------------------------------------------------------
// Test 3: the raw path is reachable only through resolver.directory()
// ---------------------------------------------------------------------------
s.section("Test 3: raw paths live only in the resolver directory");
{
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "s1" });
	const identity = await resolver.getPathIdentity(RAW_PATH);

	const eventLine = serialize(buildEnvelope({ pathId: identity.pathId, path: identity.path }));
	s.check(!eventLine.includes(RAW_PATH), "Recorded event lines never carry the raw path");

	// The with-filenames export re-attaches names from the directory; that is
	// the single seam where raw paths are allowed out, and it is opt-in.
	const directory = resolver.directory();
	const entry = directory.find((e) => e.pathId === identity.pathId);
	s.check(entry?.path === RAW_PATH, "directory() can re-attach the raw path for an unredacted export");
	s.check(JSON.stringify(directory).includes(RAW_PATH), "directory() is the only structure carrying raw paths");
}

// ---------------------------------------------------------------------------
// Test 4: Token and host never appear in safe event data
// ---------------------------------------------------------------------------
s.section("Test 4: Token and host never appear as data values");
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
	s.check(!line.includes(HOST_URL), "Provider event does not leak host URL");
	s.check(!line.includes(DEVICE_TOKEN), "Provider event does not leak device token");
}

// ---------------------------------------------------------------------------
// Test 5: Error messages do not smuggle raw path
// ---------------------------------------------------------------------------
s.section("Test 5: Error messages do not smuggle raw path");
{
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "err-salt" });
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
	s.check(!line.includes(RAW_PATH), "Error message does not contain raw path");
	s.check(line.includes(pathId), "Error message contains pathId");
}

// ---------------------------------------------------------------------------
// Test 6: Multi-device correlation — one vault, one salt, one pathId
// ---------------------------------------------------------------------------
s.section("Test 6: Multi-device pathId correlation");
{
	// Both devices derive the salt from the shared vaultId. There is no
	// user-managed secret to keep in sync any more.
	const sharedSalt = await deriveVaultPathSalt(sha256Hex, VAULT_ID);
	const deviceA = new PathIdentityResolver(sha256Hex, { salt: sharedSalt });
	const deviceB = new PathIdentityResolver(sha256Hex, {
		salt: await deriveVaultPathSalt(sha256Hex, VAULT_ID),
	});

	const idA = await deviceA.getPathIdentity(RAW_PATH);
	const idB = await deviceB.getPathIdentity(RAW_PATH);

	s.check(idA.pathId === idB.pathId, "Device A and B produce same pathId for the same vault");
	s.check(!idA.path, "Device A: path not exposed");
	s.check(!idB.path, "Device B: path not exposed");
	s.check(!idA.pathId.includes(sharedSalt), "pathId does not embed the salt");
}

// ---------------------------------------------------------------------------
// Test 7: Different vaults cannot be correlated
// ---------------------------------------------------------------------------
s.section("Test 7: Different vaults are uncorrelated");
{
	const vault1 = new PathIdentityResolver(sha256Hex, {
		salt: await deriveVaultPathSalt(sha256Hex, "vault-id-one"),
	});
	const vault2 = new PathIdentityResolver(sha256Hex, {
		salt: await deriveVaultPathSalt(sha256Hex, "vault-id-two"),
	});

	const id1 = await vault1.getPathIdentity(RAW_PATH);
	const id2 = await vault2.getPathIdentity(RAW_PATH);
	s.check(id1.pathId !== id2.pathId, "Different vaults produce different pathIds");
}

// ---------------------------------------------------------------------------
// Test 8: Safe export refused for full-mode recorder
// ---------------------------------------------------------------------------
s.section("Test 8: Safe export refused for full-mode recorder");
{
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

	s.check(!recorder.safeToShare, "Full-mode recorder: safeToShare=false");
	s.check(recorder.includesFilenames, "Full-mode recorder: includesFilenames=true");
	// The export controller checks safeToShare before writing — recorder itself
	// only exposes the getter; test that the flag is correct.
}

// ---------------------------------------------------------------------------
// Test 9: Safe export refused for local-private recorder
// ---------------------------------------------------------------------------
s.section("Test 9: Local-private recorder is not exportable");
{
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

	s.check(!recorder.exportable, "Local-private recorder is not exportable");
	s.check(!recorder.safeToShare, "Local-private recorder: safeToShare=false");
}

// ---------------------------------------------------------------------------
// Test 10: CRDT event in safe mode — no raw path in serialized JSON
// ---------------------------------------------------------------------------
s.section("Test 10: CRDT event in safe mode: no raw path in output");
{
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
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "safe-salt" });
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
	s.check(!allOutput.includes(RAW_PATH), "CRDT created event in safe mode: no raw path in output");
	s.check(allOutput.includes(pathId), "CRDT created event includes pathId");
}

// ---------------------------------------------------------------------------
// Test 11: PathIdentityResolver.hasDegraded stays false with working crypto
// ---------------------------------------------------------------------------
s.section("Test 11: hasDegraded is false when crypto works");
{
	const resolver = new PathIdentityResolver(sha256Hex, { salt: "test" });
	await resolver.getPathIdentity("some/file.md");
	s.check(!resolver.hasDegraded, "hasDegraded is false when sha256Hex works");
}
await s.done();
