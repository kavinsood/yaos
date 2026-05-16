/**
 * witnessQuorumEventually unit tests
 *
 * Proves the contract:
 *   1. B settles with G (intermediate), then H (final) → passes, intermediateHashes[B] contains G
 *   2. B emits stale_hash_after_newer_witness → fails immediately
 *   3. B never settles with H → quorum_timeout
 *   4. Single device, settles with H directly → passes, no intermediates
 */

import assert from "node:assert/strict";
import { witnessQuorumEventually } from "../qa/obsidian-harness/witness-primitives";
import type { DeviceHandle, WitnessBufferEntry } from "../qa/obsidian-harness/witness-primitives";
import type { YaosQaDebugApi } from "../src/qaDebugApi";

let passed = 0;
let failed = 0;

const tests: Array<[string, () => Promise<void>]> = [];
function test(name: string, fn: () => Promise<void>): void { tests.push([name, fn]); }

// -----------------------------------------------------------------------
// Fake device handle
// -----------------------------------------------------------------------

function makeHandle(
	deviceId: string,
	events: WitnessBufferEntry[],
	opts: { runtimeState?: string; hasSecret?: boolean } = {},
): DeviceHandle {
	let seq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) : 0;
	const api: Partial<YaosQaDebugApi> & {
		getActiveTraceInfo(): { traceId: string; qaTraceSecretHash: string; deviceId: string; hasQaTraceSecret: boolean } | null;
	} = {
		getWitnessBuffer: () => events,
		currentWitnessSeq: () => seq,
		getRuntimeState: () => (opts.runtimeState ?? "foreground") as "foreground",
		getDeviceId: () => deviceId,
		getActiveTraceInfo: () => ({
			traceId: "trace-test",
			qaTraceSecretHash: "sha256:abc",
			deviceId,
			hasQaTraceSecret: opts.hasSecret ?? true,
		}),
	};
	return { deviceId, api: api as YaosQaDebugApi };
}

function settled(seq: number, path: string, stateHash: string, stableAfterMs = 2000): WitnessBufferEntry {
	return { kind: "settled", path, seq, data: { stateHash, stateKind: "present", stableAfterMs } };
}

function diverged(seq: number, path: string, reason: string): WitnessBufferEntry {
	return { kind: "diverged", path, seq, data: { reason, stateKind: "present" } };
}

const PATH = "test.md";
const G = "h:intermediate-hash-g";
const H = "h:final-hash-h";

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

test("B settles with G then H → passes, intermediateHashes[B] contains G", async () => {
	// B has G at seq=1 (intermediate), H at seq=2 (final)
	const eventsB: WitnessBufferEntry[] = [
		settled(1, PATH, G),
		settled(2, PATH, H),
	];
	const handleB = makeHandle("device-b", eventsB);

	const result = await witnessQuorumEventually([handleB], PATH, {
		pathId: PATH,
		stateKind: "present",
		expectedStateHash: H,
		timeoutMs: 2000,
		minStableAfterMs: 0,
		startSeqOverride: { "device-b": 0 },
	});

	assert.ok(result.ok, `Expected ok=true, got: ${result.summary}`);
	assert.ok(result.intermediateHashes["device-b"]!.length >= 1, "Should have intermediate hash G");
	assert.equal(result.intermediateHashes["device-b"]![0]!.stateHash, G);
});

test("B emits stale_hash_after_newer_witness → fails immediately", async () => {
	const eventsB: WitnessBufferEntry[] = [
		diverged(1, PATH, "stale_hash_after_newer_witness"),
	];
	const handleB = makeHandle("device-b", eventsB);

	const result = await witnessQuorumEventually([handleB], PATH, {
		pathId: PATH,
		stateKind: "present",
		expectedStateHash: H,
		timeoutMs: 2000,
		minStableAfterMs: 0,
		startSeqOverride: { "device-b": 0 },
	});

	assert.ok(!result.ok, "Should fail on stale_hash_after_newer_witness");
	assert.equal(result.reason, "stale_hash_after_newer_witness");
});

test("B never settles with H → quorum_timeout with perDevice evidence", async () => {
	// B only has G, never H
	const eventsB: WitnessBufferEntry[] = [settled(1, PATH, G)];
	const handleB = makeHandle("device-b", eventsB);

	const result = await witnessQuorumEventually([handleB], PATH, {
		pathId: PATH,
		stateKind: "present",
		expectedStateHash: H,
		timeoutMs: 300,
		minStableAfterMs: 0,
		startSeqOverride: { "device-b": 0 },
	});

	assert.ok(!result.ok, "Should fail on timeout");
	assert.equal(result.reason, "quorum_timeout");
	assert.ok(result.perDevice?.["device-b"], "Should have perDevice evidence for B");
	assert.equal(result.perDevice!["device-b"]!.settledCount, 1);
	assert.ok(result.intermediateHashes["device-b"]!.length >= 1, "Should record G as intermediate");
});

test("Single device settles with H directly → passes, no intermediates", async () => {
	const eventsA: WitnessBufferEntry[] = [settled(1, PATH, H)];
	const handleA = makeHandle("device-a", eventsA);

	const result = await witnessQuorumEventually([handleA], PATH, {
		pathId: PATH,
		stateKind: "present",
		expectedStateHash: H,
		timeoutMs: 2000,
		minStableAfterMs: 0,
		startSeqOverride: { "device-a": 0 },
	});

	assert.ok(result.ok, `Expected ok=true, got: ${result.summary}`);
	assert.equal(result.intermediateHashes["device-a"]!.length, 0, "No intermediate hashes expected");
});

test("diagnostics-class divergence (unavailable) does not fail quorum", async () => {
	// B emits unavailable (diagnostics class), then settles with H
	const eventsB: WitnessBufferEntry[] = [
		diverged(1, PATH, "unavailable"),
		settled(2, PATH, H),
	];
	const handleB = makeHandle("device-b", eventsB);

	const result = await witnessQuorumEventually([handleB], PATH, {
		pathId: PATH,
		stateKind: "present",
		expectedStateHash: H,
		timeoutMs: 2000,
		minStableAfterMs: 0,
		startSeqOverride: { "device-b": 0 },
	});

	assert.ok(result.ok, `Diagnostics divergence should not fail quorum, got: ${result.summary}`);
});

test("two devices, A has H, B has G then H → both pass", async () => {
	const eventsA: WitnessBufferEntry[] = [settled(1, PATH, H)];
	const eventsB: WitnessBufferEntry[] = [settled(1, PATH, G), settled(2, PATH, H)];
	const handleA = makeHandle("device-a", eventsA);
	const handleB = makeHandle("device-b", eventsB);

	const result = await witnessQuorumEventually([handleA, handleB], PATH, {
		pathId: PATH,
		stateKind: "present",
		expectedStateHash: H,
		timeoutMs: 2000,
		minStableAfterMs: 0,
		startSeqOverride: { "device-a": 0, "device-b": 0 },
	});

	assert.ok(result.ok, `Expected ok=true, got: ${result.summary}`);
	assert.equal(result.intermediateHashes["device-b"]!.length, 1);
	assert.equal(result.intermediateHashes["device-a"]!.length, 0);
});

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

async function runAll(): Promise<void> {
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log(`  PASS  ${name}`);
			passed++;
		} catch (err: unknown) {
			console.error(`  FAIL  ${name}`);
			console.error(`        ${err instanceof Error ? err.message : String(err)}`);
			failed++;
		}
	}
	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

void runAll();
