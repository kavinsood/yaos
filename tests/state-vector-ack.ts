/**
 * Unit tests for isStateVectorGe().
 *
 * Tests the full matrix from the design doc:
 *   equal, server-ahead, server-missing-client, server-extra-client,
 *   empty cases, malformed input, old client IDs from prior sessions.
 */

import * as Y from "yjs";
import { isStateVectorGe } from "../src/sync/stateVectorAck";

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

function makeSv(entries: [number, number][]): Uint8Array {
	const doc = new Y.Doc({ gc: false });
	// Build an SV by applying synthetic updates to a fresh doc.
	// Easier: encode directly from a Map using Yjs internals.
	// Use encodeStateVectorFromUpdateV1 workaround: build via real doc ops.
	// Simplest: build a doc with a known clientId by setting it explicitly.
	// Actually the cleanest approach is to build real SVs via real Y.Doc ops.
	// For precise control, use Y.encodeStateVectorFromUpdate with a constructed update.
	// But simplest: create a doc, apply an update that sets known clocks.
	// We'll use the fact that Y.Doc lets us set clientID.
	doc.destroy();

	// Construct via encoding a Map manually to match Y.encodeStateVector output format.
	// y-protocols uses lib0 variable-length encoding for the SV.
	// Format: { length } entries of { clientId (varUint), clock (varUint) }
	// Use lib0/encoding directly for precision.
	// Alternative: build real docs with real operations.
	// For test purposes, build real SVs from real Y.Doc instances.
	return new Uint8Array(0); // placeholder — not used directly
}

// Build a real state vector from a Y.Doc with a specific clientId.
function makeSvFromDoc(clientId: number, clock: number): Uint8Array {
	const doc = new Y.Doc({ gc: false });
	// Force clientId — needed to build predictable SVs.
	(doc as unknown as { clientID: number }).clientID = clientId;
	const text = doc.getText("t");
	for (let i = 0; i < clock; i++) {
		text.insert(0, "x");
	}
	const sv = Y.encodeStateVector(doc);
	doc.destroy();
	return sv;
}

// Merge two SVs by applying one doc's state to another.
function mergeSvs(...svArrays: Uint8Array[]): Uint8Array {
	const doc = new Y.Doc({ gc: false });
	for (const sv of svArrays) {
		// sv is already a state vector, not an update — we need update to apply
		// This approach only works if we have actual update data.
		// Instead, build a combined doc by running all operations.
		void sv;
	}
	doc.destroy();
	// Fallback: just return first SV — callers build their own
	return svArrays[0] ?? new Uint8Array(0);
}

// Build a state vector with multiple client contributions.
function buildMultiClientSv(clients: [number, number][]): Uint8Array {
	const collector = new Y.Doc({ gc: false });
	for (const [clientId, clock] of clients) {
		const src = new Y.Doc({ gc: false });
		(src as unknown as { clientID: number }).clientID = clientId;
		const text = src.getText("t");
		for (let i = 0; i < clock; i++) text.insert(0, "a");
		const update = Y.encodeStateAsUpdate(src);
		Y.applyUpdate(collector, update);
		src.destroy();
	}
	const sv = Y.encodeStateVector(collector);
	collector.destroy();
	return sv;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n--- Test 1: equal state vectors ---");
{
	const sv = buildMultiClientSv([[100, 3], [200, 5]]);
	assert(isStateVectorGe(sv, sv), "equal SVs => true");
	const sv2 = buildMultiClientSv([[100, 3], [200, 5]]);
	assert(isStateVectorGe(sv, sv2), "identical SVs (separate instances) => true");
	assert(isStateVectorGe(sv2, sv), "symmetric: also true");
}

console.log("\n--- Test 2: server ahead of candidate ---");
{
	const candidate = buildMultiClientSv([[100, 3]]);
	const server = buildMultiClientSv([[100, 5]]);
	assert(isStateVectorGe(server, candidate), "server clock 5 >= candidate clock 3 => true");
	assert(!isStateVectorGe(candidate, server), "candidate clock 3 < server clock 5 => false");
}

console.log("\n--- Test 3: server missing client present in candidate ---");
{
	const candidate = buildMultiClientSv([[100, 3], [200, 2]]);
	const server = buildMultiClientSv([[100, 3]]);
	assert(!isStateVectorGe(server, candidate), "server missing client 200 => false");
}

console.log("\n--- Test 4: server has extra client not in candidate ---");
{
	const candidate = buildMultiClientSv([[100, 3]]);
	const server = buildMultiClientSv([[100, 3], [999, 10]]);
	assert(isStateVectorGe(server, candidate), "server extra client doesn't invalidate => true");
}

console.log("\n--- Test 5: empty state vectors ---");
{
	// A valid empty SV is Y.encodeStateVector(new Y.Doc()) = Uint8Array([0]).
	// new Uint8Array(0) is malformed input and fails closed (false) — see Test 7.
	const emptyDoc = new Y.Doc();
	const emptySv = Y.encodeStateVector(emptyDoc);
	emptyDoc.destroy();
	const nonEmpty = buildMultiClientSv([[100, 3]]);
	assert(isStateVectorGe(emptySv, emptySv), "empty SV vs empty SV => true (vacuously)");
	assert(!isStateVectorGe(emptySv, nonEmpty), "empty server SV vs non-empty candidate => false");
	assert(isStateVectorGe(nonEmpty, emptySv), "non-empty server vs empty candidate SV => true (vacuously)");
	// Truly malformed (zero bytes) fails closed:
	assert(!isStateVectorGe(new Uint8Array(0), new Uint8Array(0)), "zero-byte input: malformed => false");
}

console.log("\n--- Test 6: server behind on one of multiple clients ---");
{
	const candidate = buildMultiClientSv([[100, 5], [200, 3]]);
	const server = buildMultiClientSv([[100, 5], [200, 2]]);
	assert(!isStateVectorGe(server, candidate), "server behind on client 200 => false");
}

console.log("\n--- Test 7: malformed input fails closed ---");
{
	const valid = buildMultiClientSv([[100, 3]]);
	const garbage = new Uint8Array([255, 255, 255, 255, 0]); // not valid varint encoding
	assert(!isStateVectorGe(garbage, valid), "malformed server SV => false (fail closed)");
	assert(!isStateVectorGe(valid, garbage), "malformed candidate SV => false (fail closed)");
	assert(!isStateVectorGe(garbage, garbage), "both malformed => false (fail closed)");
}

console.log("\n--- Test 8: old client ID from a prior Y.Doc session ---");
{
	// Client 100 had clock 5 in a prior session. The new server doc has client
	// 100 at clock 5 (same data, possibly same or different session restart).
	const candidateWithOldId = buildMultiClientSv([[100, 5], [777, 2]]);
	const serverMissingOldClient = buildMultiClientSv([[100, 5]]);
	assert(
		!isStateVectorGe(serverMissingOldClient, candidateWithOldId),
		"server missing old client 777 from prior session => false",
	);

	const serverWithOldClientAtCorrectClock = buildMultiClientSv([[100, 5], [777, 2]]);
	assert(
		isStateVectorGe(serverWithOldClientAtCorrectClock, candidateWithOldId),
		"server has old client 777 at correct clock => true",
	);

	const serverWithOldClientBehind = buildMultiClientSv([[100, 5], [777, 1]]);
	assert(
		!isStateVectorGe(serverWithOldClientBehind, candidateWithOldId),
		"server has old client 777 but clock behind => false",
	);
}

console.log("\n--- Test 9: multi-client mixed scenarios ---");
{
	const candidate = buildMultiClientSv([[1, 10], [2, 5], [3, 3]]);
	const serverMissingOne = buildMultiClientSv([[1, 10], [2, 5]]);
	assert(!isStateVectorGe(serverMissingOne, candidate), "server missing client 3 => false");

	const serverAheadOnAll = buildMultiClientSv([[1, 11], [2, 6], [3, 4]]);
	assert(isStateVectorGe(serverAheadOnAll, candidate), "server ahead on all => true");

	const serverBehindOnOne = buildMultiClientSv([[1, 9], [2, 5], [3, 3]]);
	assert(!isStateVectorGe(serverBehindOnOne, candidate), "server behind on client 1 => false");
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
