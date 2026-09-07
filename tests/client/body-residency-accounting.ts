import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { BodyManager } from "../../src/sync/bodyManager";
import {
	BODY_RESIDENCY_ESTIMATOR_VERSION,
	estimateReconstructionReservation,
	measureBodyResidency,
	numericDistribution,
} from "../../src/sync/bodyResidencyAccounting";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";

const s = suite("body-residency-accounting");

function encoded(content: string): Uint8Array {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, content);
	const state = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return state;
}

s.test("measurement separates exact observations from the heuristic estimate", () => {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, "hello 🌍");
	const state = Y.encodeStateAsUpdate(doc);
	const measurement = measureBodyResidency(doc, state.byteLength, {
		localPendingBufferBytes: 120,
		remotePendingBufferBytes: 80,
		providerCount: 1,
		socketCount: 1,
		awarenessPeerCount: 3,
	});
	assert.equal(measurement.estimatorVersion, BODY_RESIDENCY_ESTIMATOR_VERSION);
	assert.equal(measurement.encodedDocumentBytes, state.byteLength);
	assert.equal(measurement.materializedTextCodeUnits, "hello 🌍".length);
	assert.equal(measurement.external.localPendingBufferBytes, 120);
	assert.equal(measurement.external.socketCount, 1);
	assert.ok(measurement.yjsStructCount > 0);
	assert.ok(measurement.estimatedResidentBytes > state.byteLength);
	assert.equal(measurement.claim, "heuristic-resident-estimate-not-heap-measurement");
	doc.destroy();
});

s.test("fragmented history remains distinguishable from compact equal text", () => {
	const compact = new Y.Doc();
	compact.getText("body").insert(0, "stable");
	const fragmented = new Y.Doc();
	const text = fragmented.getText("body");
	text.insert(0, "stable");
	for (let index = 0; index < 80; index++) {
		text.insert(text.length, "x");
		text.delete(text.length - 1, 1);
	}
	assert.equal(text.toString(), compact.getText("body").toString());
	const compactMeasurement = measureBodyResidency(compact, Y.encodeStateAsUpdate(compact).byteLength);
	const fragmentedMeasurement = measureBodyResidency(fragmented, Y.encodeStateAsUpdate(fragmented).byteLength);
	assert.ok(fragmentedMeasurement.yjsStructCount > compactMeasurement.yjsStructCount);
	assert.ok(fragmentedMeasurement.yjsDeletedStructCount > compactMeasurement.yjsDeletedStructCount);
	assert.ok(fragmentedMeasurement.estimatedResidentBytes > compactMeasurement.estimatedResidentBytes);
	compact.destroy();
	fragmented.destroy();
});

s.test("manager reports scratch reservations, transport signals, and eviction blockers", async () => {
	let snapshotDuringPersistence = 0;
	let manager!: BodyManager;
	manager = new BodyManager({
		getDocument: async () => null,
		putDocument: async () => {
			snapshotDuringPersistence = manager.residencySnapshot().totals.temporaryReservedBytes;
		},
	});
	const body = await manager.replaceFromServer("measured-body", encoded("body text"), 1);
	assert.ok(snapshotDuringPersistence > 0, "replacement/persistence reserves scratch before work completes");
	manager.setExternalResourceSignals(body.bodyId, {
		localPendingBufferBytes: 512,
		remotePendingBufferBytes: 256,
		providerCount: 1,
		socketCount: 1,
		awarenessPeerCount: 2,
	});
	manager.setSharedResourceSignals({
		rootCatalogReportedBytes: 4096,
		pendingBufferBytes: 128,
		providerCount: 1,
		socketCount: 1,
		awarenessPeerCount: 1,
	});
	manager.pin(body.bodyId);
	await manager.markLocalUpdate(body.bodyId);
	manager.markUnsettled(body.bodyId);
	const lease = manager.acquireLease(body.bodyId);
	assert.equal(await manager.evict(body.bodyId), false);
	const snapshot = manager.residencySnapshot();
	const measured = snapshot.bodies.find((entry) => entry.bodyId === body.bodyId)!;
	assert.equal(measured.providerCount, 1);
	assert.equal(measured.socketCount, 1);
	assert.equal(measured.localPendingBufferBytes, 512);
	for (const blocker of ["dirty", "unsettled-candidate", "pending-local-update", "pin", "lease", "synchronization"] as const) {
		assert.ok(measured.blockers.includes(blocker), `snapshot includes ${blocker} blocker`);
		assert.ok((snapshot.evictions.blockerObservations[blocker] ?? 0) > 0);
	}
	assert.ok(snapshot.shared.estimatedBytes > snapshot.shared.rootCatalogReportedBytes);
	assert.ok(snapshot.totals.accountedEstimatedBytes > snapshot.totals.estimatedResidentBytes);
	assert.equal(snapshot.residentBudget.includesTemporaryReservations, false);
	assert.deepEqual(manager.loadedBodyIds(), [body.bodyId]);
	const observation = manager.bodyResidencyObservation(body.bodyId)!;
	observation.blockers.length = 0;
	assert.ok(manager.bodyResidencyObservation(body.bodyId)!.blockers.length > 0, "body observations are defensive values");
	const cold = manager.estimateColdLoadAdmission(2048);
	assert.equal(cold.encodedInputBytes, 2048);
	assert.ok(cold.estimatedPeakAdditionalBytes > cold.estimatedResidentBytes);
	assert.equal(cold.claim, "pre-decode-heuristic-not-admission-proof");
	lease.release();
	await manager.destroy();
});

s.test("load metrics distinguish cold, joined, and cache-hit requests", async () => {
	let release!: (value: StoredDocument | null) => void;
	const stored = new Promise<StoredDocument | null>((resolve) => { release = resolve; });
	let now = 100;
	const manager = new BodyManager({
		getDocument: async () => stored,
		putDocument: async () => {},
	}, () => now++);
	const first = manager.load("load-metrics");
	const joined = manager.load("load-metrics");
	release(null);
	assert.equal(await first, await joined);
	await manager.load("load-metrics");
	const snapshot = manager.residencySnapshot();
	assert.equal(snapshot.loads.requests, 3);
	assert.equal(snapshot.loads.coldLoads, 1);
	assert.equal(snapshot.loads.joinedInFlight, 1);
	assert.equal(snapshot.loads.cacheHits, 1);
	assert.equal(snapshot.loads.cacheHitRate, 1 / 3);
	assert.equal(snapshot.loads.latencyMs.count, 1);
	assert.ok(snapshot.highWater.loadedBodies >= 1);
	await manager.destroy();
});

s.test("public temporary reservations are idempotent and visible", async () => {
	const manager = new BodyManager({ getDocument: async () => null, putDocument: async () => {} });
	const reservation = manager.reserveTemporary("merge", "merge-session", 1234);
	assert.equal(manager.residencySnapshot().totals.temporaryReservedBytes, 1234);
	assert.equal(manager.residencySnapshot().temporaryReservations[0]?.kind, "merge");
	reservation.release();
	reservation.release();
	assert.equal(manager.residencySnapshot().totals.temporaryReservedBytes, 0);
	assert.ok(estimateReconstructionReservation(100) > 200);
	assert.deepEqual(numericDistribution([1, 2, 3, 100]), { count: 4, min: 1, p50: 2, p95: 100, max: 100 });
	await manager.destroy();
});

await s.done();
