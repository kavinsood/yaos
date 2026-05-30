/**
 * Tests for QA port fencing.
 *
 * Verifies:
 * 1. YaosDebugPort and YaosUnsafeQaPort interfaces exist and are well-typed
 * 2. The guard:qa-isolation script passes (sync/runtime don't import QA)
 * 3. Port interfaces correctly categorize safe vs unsafe operations
 */

import type { YaosDebugPort } from "../src/telemetry/debug/ports/yaosDebugPort";
import type { YaosUnsafeQaPort } from "../qa/harness/ports/yaosUnsafeQaPort";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

console.log("\n--- Test 1: YaosDebugPort interface shape ---");
{
	// Type-level check: a mock implementation compiles.
	const mockDebugPort: YaosDebugPort = {
		isLocalReady: () => true,
		isProviderSynced: () => true,
		isProviderConnected: () => true,
		isReconciled: () => true,
		isReconcileInFlight: () => false,
		getConnectionState: () => "connected",
		getServerReceiptState: () => "confirmed",
		getReceiptSnapshot: () => ({ serverAppliedLocalState: true, lastServerReceiptEchoAt: 1, lastKnownServerReceiptEchoAt: 1, hasCandidateSv: false }),
		getActiveMarkdownPaths: () => [],
		getDiskMarkdownPaths: () => [],
		getEditorBindingHealth: () => ({ path: "x.md", hasCm6Extension: true, hasYjsBinding: true, isQaPaused: false, editorViewExists: true }),
		getRuntimeState: () => "foreground",
		getDiskHash: async () => null,
		getCrdtHash: async () => null,
		getEditorHash: async () => null,
		waitForIdle: async () => {},
		waitForLocalReady: async () => {},
		waitForProviderSynced: async () => {},
		waitForReconciled: async () => {},
		waitForFile: async () => {},
		waitForReceiptAfter: async () => {},
		forceReconcile: async () => {},
		forceReconnect: () => {},
		disconnectProvider: () => {},
		connectProvider: () => {},
		startFlightTrace: async () => {},
		stopFlightTrace: async () => {},
		exportFlightTrace: async () => "",
		getActiveTraceInfo: () => null,
	};

	assert(typeof mockDebugPort.isLocalReady === "function", "isLocalReady is a function");
	assert(typeof mockDebugPort.waitForIdle === "function", "waitForIdle is a function");
	assert(typeof mockDebugPort.forceReconcile === "function", "forceReconcile is a function");
	assert(typeof mockDebugPort.getDiskHash === "function", "getDiskHash is a function");
	assert(typeof mockDebugPort.getActiveTraceInfo === "function", "getActiveTraceInfo is a function");

	// Verify no unsafe methods leak into debug port.
	const debugPortKeys = Object.keys(mockDebugPort);
	assert(!debugPortKeys.some(k => k.includes("__qaOnly")), "no __qaOnly methods in debug port");
	assert(!debugPortKeys.some(k => k.includes("Scenario")), "no scenario methods in debug port");
	assert(!debugPortKeys.some(k => k.includes("Unsafe")), "no Unsafe methods in debug port");
}

console.log("\n--- Test 2: YaosUnsafeQaPort interface shape ---");
{
	const mockUnsafePort: YaosUnsafeQaPort = {
		__qaOnlyForceCrdtContentUnsafe: async () => ({ beforeHash: null, afterHash: "abc", fileExisted: false }),
		__qaOnlyForceSyncFileFromDiskUnsafe: async () => {},
		__qaOnlyPauseEditorBindingPropagationUnsafe: async () => true,
		__qaOnlyResumeEditorBindingPropagationUnsafe: async () => true,
		setQaNetworkHold: () => {},
		__qaOnlySetScenarioRunIdUnsafe: () => {},
		__qaOnlyAdvanceScenarioStepUnsafe: () => {},
		__qaOnlyEmitPhaseUnsafe: async () => {},
		__qaOnlySetExternalEditPolicyOverrideUnsafe: async () => ({ previous: null }),
		witnessDeviceSettled: async () => {},
		computeWitnessStateHash: async () => "hash",
		getDeviceId: () => "device-1",
	};

	assert(typeof mockUnsafePort.__qaOnlyForceCrdtContentUnsafe === "function", "forceCrdt exists");
	assert(typeof mockUnsafePort.setQaNetworkHold === "function", "network hold exists");
	assert(typeof mockUnsafePort.__qaOnlySetScenarioRunIdUnsafe === "function", "scenario run id exists");
	assert(typeof mockUnsafePort.__qaOnlyAdvanceScenarioStepUnsafe === "function", "scenario step exists");
	assert(typeof mockUnsafePort.witnessDeviceSettled === "function", "witness settled exists");

	// Verify all methods have __qaOnly or explicit unsafe/scenario naming.
	const unsafeKeys = Object.keys(mockUnsafePort);
	const safeReadKeys = ["witnessDeviceSettled", "computeWitnessStateHash", "getDeviceId", "setQaNetworkHold"];
	const unsafeOnlyKeys = unsafeKeys.filter(k => !safeReadKeys.includes(k));
	assert(
		unsafeOnlyKeys.every(k => k.includes("__qaOnly") || k.includes("Unsafe")),
		"all mutation methods have __qaOnly or Unsafe in name",
	);
}

console.log("\n--- Test 3: debug port has no data-mutating methods ---");
{
	// The key contract: YaosDebugPort should not be able to mutate CRDT content,
	// control scenarios, or override policies.
	const debugMethods = [
		"isLocalReady", "isProviderSynced", "isProviderConnected", "isReconciled",
		"isReconcileInFlight", "getConnectionState", "getServerReceiptState",
		"getReceiptSnapshot", "getActiveMarkdownPaths", "getDiskMarkdownPaths",
		"getEditorBindingHealth", "getRuntimeState", "getDiskHash", "getCrdtHash",
		"getEditorHash", "waitForIdle", "waitForLocalReady", "waitForProviderSynced",
		"waitForReconciled", "waitForFile", "waitForReceiptAfter",
		"forceReconcile", "forceReconnect", "disconnectProvider", "connectProvider",
		"startFlightTrace", "stopFlightTrace", "exportFlightTrace", "getActiveTraceInfo",
	];

	const dangerousPatterns = ["forceCrdt", "forceSync", "Scenario", "networkHold", "Override"];
	for (const method of debugMethods) {
		assert(
			!dangerousPatterns.some(p => method.toLowerCase().includes(p.toLowerCase())),
			`debug port method '${method}' is not dangerous`,
		);
	}
}

console.log("\n--- Test 4: guard:qa-isolation passes ---");
{
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync("node", ["scripts/guard-qa-isolation.mjs"], { encoding: "utf8" });
	assert(result.status === 0, "guard:qa-isolation passes");
	assert(result.stdout.includes("PASS"), "output includes PASS");
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
