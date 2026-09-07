import { strict as assert } from "node:assert";
import {
	OperationalResourceSnapshotTracker,
} from "../../src/runtime/operationalResourceSnapshot";
import {
	ResidencyAdmissionCoordinator,
	type ResidencyAdmissionLimits,
} from "../../src/runtime/residencyAdmissionCoordinator";
import type { OverdueWorkDiagnostics } from "../../src/runtime/overdueWorkKernel";
import type { BodyResidencySnapshot } from "../../src/sync/bodyResidencyAccounting";
import { suite } from "../harness.ts";

const limits: ResidencyAdmissionLimits = {
	residentCost: 100,
	transientCost: 40,
	concurrentLoads: 1,
	warmBodies: 2,
	sockets: 2,
	reservedSockets: 1,
	warmRetentionMs: 60_000,
	backgroundPromotionMs: 10_000,
	maxPreferredBurst: 2,
};

function residency(current = 90): BodyResidencySnapshot {
	const distribution = { count: 0, min: 0, p50: 0, p95: 0, max: 0 };
	return {
		formatVersion: 1,
		estimatorVersion: "yaos-body-residency-v1",
		claim: "heuristic-resident-estimate-not-heap-measurement",
		capturedAt: 8_000,
		residentBudget: {
			bytes: 100,
			scope: "body-resident-estimates-only",
			includesTemporaryReservations: false,
			includesSharedRootAndCatalog: false,
		},
		totals: {
			loadedBodies: 1,
			loadingBodies: 0,
			estimatedResidentBytes: current,
			temporaryReservedBytes: 5,
			sharedReportedBytes: 0,
			accountedEstimatedBytes: current + 5,
			evictableBodies: 0,
			blockedBodies: 1,
		},
		shared: {
			rootCatalogReportedBytes: 0,
			pendingBufferBytes: 0,
			providerCount: 1,
			socketCount: 1,
			awarenessPeerCount: 0,
			estimatedBytes: 0,
		},
		highWater: { estimatedResidentBytes: 95, accountedEstimatedBytes: 100, loadedBodies: 1 },
		loads: {
			requests: 1,
			cacheHits: 0,
			joinedInFlight: 0,
			coldLoads: 1,
			failures: 0,
			cacheHitRate: 0,
			latencyMs: distribution,
		},
		evictions: { completed: 0, blockedAttempts: 1, blockerObservations: { dirty: 1 } },
		distributions: {
			estimatedResidentBytes: distribution,
			encodedDocumentBytes: distribution,
			yjsStructCount: distribution,
			structsPerThousandTextCodeUnits: distribution,
		},
		temporaryReservations: [],
		bodies: [],
		caveats: ["Not a heap measurement."],
	};
}

function overdue(blocked = false): OverdueWorkDiagnostics {
	return {
		stopped: false,
		draining: false,
		pokePending: false,
		lastPokeReason: null,
		nextWakeAt: null,
		queue: [{
			key: "candidate:redacted",
			queueAgeMs: 7_000,
			priority: "normal",
			effectivePriority: "normal",
			blocker: blocked ? { kind: "decision_required", failure: "unauthorized" } : null,
			attempt: 0,
			owner: "kernel",
			dueAt: 0,
			maxWaitAt: null,
			readyAt: 0,
			inFlight: false,
		}],
	};
}

const s = suite("operational-resource-snapshot");

s.test("aggregate reports exact pressure, bounded queues, blockers, sockets, and heuristic budget", () => {
	const coordinator = new ResidencyAdmissionCoordinator(limits, () => "fixed");
	coordinator.observeBody({
		bodyId: "active",
		population: "active",
		residentCost: 90,
		transientCost: 0,
		dirty: true,
		durablyPending: false,
		leaseCount: 0,
		socket: "open",
		lastUsedAt: 0,
	});
	const request = coordinator.request({
		bodyId: "next",
		priority: "editor",
		needsLoad: true,
		needsSocket: true,
		residentCost: 20,
		transientCost: 0,
		finalPopulation: "active",
		requestedAt: 1_000,
	});
	const decision = coordinator.decideNext(9_000);
	assert.equal(decision.kind, "backpressure");
	if (decision.kind !== "backpressure") return;
	assert.equal(decision.reason, "protected_residency_saturation");
	const snapshot = new OperationalResourceSnapshotTracker().capture({
		residency: residency(),
		admission: coordinator.snapshot(),
		overdue: [overdue()],
	}, 10_000);
	assert.equal(snapshot.estimateClaim, "heuristic-resident-estimate-not-heap-measurement");
	assert.equal(snapshot.residency.currentEstimatedBytes, 90);
	assert.equal(snapshot.residency.configuredBudgetBytes, 100);
	assert.equal(snapshot.queued.admission.total, 1);
	assert.equal(snapshot.queued.overdue.normal, 1);
	assert.equal(snapshot.queued.oldestAgeMs, 9_000);
	assert.equal(snapshot.blockers.bodyObservations.dirty, 1);
	assert.equal(snapshot.sockets.used, 1);
	assert.equal(snapshot.currentPressure?.reason, "protected_residency_saturation");
	assert.equal(snapshot.currentPressure?.actionable, true);
	coordinator.cancelRequest(request.requestId);
});

s.test("resolved admission pressure becomes history and blocked overdue work becomes current", () => {
	const coordinator = new ResidencyAdmissionCoordinator(limits, () => "fixed");
	const oversized = coordinator.request({
		bodyId: "oversized",
		priority: "editor",
		needsLoad: true,
		needsSocket: false,
		residentCost: 101,
		transientCost: 0,
		finalPopulation: "active",
		requestedAt: 1_000,
	});
	assert.equal(coordinator.decideNext(2_000).kind, "backpressure");
	const tracker = new OperationalResourceSnapshotTracker();
	const first = tracker.capture({ residency: residency(0), admission: coordinator.snapshot(), overdue: [overdue()] }, 3_000);
	assert.equal(first.currentPressure?.reason, "resident_cost_limit");
	coordinator.cancelRequest(oversized.requestId);
	const resolved = tracker.capture({ residency: residency(0), admission: coordinator.snapshot(), overdue: [{ ...overdue(), queue: [] }] }, 5_000);
	assert.equal(resolved.currentPressure, null);
	assert.equal(resolved.lastPressure?.reason, "resident_cost_limit");

	const blocked = tracker.capture({ residency: residency(0), admission: coordinator.snapshot(), overdue: [overdue(true)] }, 10_000);
	assert.equal(blocked.currentPressure?.reason, "decision_required");
	assert.equal(blocked.blockers.overdueDecisionRequired, 1);
	const newScope = tracker.capture({
		residency: residency(0),
		admission: new ResidencyAdmissionCoordinator(limits).snapshot(),
		overdue: [{ ...overdue(), queue: [] }],
	}, 11_000, "next-vault-generation");
	assert.equal(newScope.lastPressure, null);
});

s.test("current admission pressure clears on coalescing, cancellation, and grant", () => {
	const coordinator = new ResidencyAdmissionCoordinator(limits, () => "fixed");
	coordinator.setRuntimeContext("mobile", "background");
	const first = coordinator.request({
		bodyId: "body",
		priority: "background",
		needsLoad: true,
		needsSocket: false,
		residentCost: 10,
		transientCost: 0,
		finalPopulation: "warm",
		requestedAt: 1,
	});
	assert.equal(coordinator.decideNext(2).kind, "backpressure");
	assert.equal(coordinator.snapshot().pressure?.current?.reason, "mobile_background");

	const coalesced = coordinator.request({
		bodyId: "body",
		priority: "foreground",
		needsLoad: true,
		needsSocket: false,
		residentCost: 10,
		transientCost: 0,
		finalPopulation: "active",
		requestedAt: 2,
	});
	assert.equal(coalesced.requestId, first.requestId);
	assert.equal(coordinator.snapshot().pressure?.current, null);
	assert.equal(coordinator.decideNext(3).kind, "backpressure");
	assert.equal(coordinator.cancelRequest(first.requestId), true);
	assert.equal(coordinator.snapshot().pressure?.current, null);
	assert.equal(coordinator.snapshot().pressure?.last?.reason, "mobile_background");

	coordinator.request({
		bodyId: "next",
		priority: "foreground",
		needsLoad: true,
		needsSocket: false,
		residentCost: 10,
		transientCost: 0,
		finalPopulation: "active",
		requestedAt: 4,
	});
	assert.equal(coordinator.decideNext(5).kind, "backpressure");
	coordinator.setRuntimeContext("mobile", "foreground");
	assert.equal(coordinator.decideNext(6).kind, "granted");
	assert.equal(coordinator.snapshot().pressure?.current, null);
});

await s.done();
