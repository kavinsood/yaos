import { strict as assert } from "node:assert";
import {
	ResidencyAdmissionCoordinator,
	type AdmissionRequestInput,
	type AdmissionReservation,
	type ResidencyAdmissionLimits,
	type ResidencyBodyObservation,
} from "../../src/runtime/residencyAdmissionCoordinator";
import { suite } from "../harness.ts";

const s = suite("residency-admission-coordinator");

const DEFAULT_LIMITS: ResidencyAdmissionLimits = {
	residentCost: 100,
	transientCost: 40,
	concurrentLoads: 2,
	warmBodies: 3,
	sockets: 4,
	reservedSockets: 1,
	warmRetentionMs: 1_000,
	backgroundPromotionMs: 10,
	maxPreferredBurst: 2,
};

function ids(): () => string {
	let sequence = 0;
	return () => `id-${++sequence}`;
}

function coordinator(overrides: Partial<ResidencyAdmissionLimits> = {}): ResidencyAdmissionCoordinator {
	return new ResidencyAdmissionCoordinator({ ...DEFAULT_LIMITS, ...overrides }, ids());
}

function body(
	bodyId: string,
	overrides: Partial<ResidencyBodyObservation> = {},
): ResidencyBodyObservation {
	return {
		bodyId,
		population: "warm",
		residentCost: 10,
		transientCost: 0,
		dirty: false,
		durablyPending: false,
		leaseCount: 0,
		socket: "none",
		lastUsedAt: 0,
		...overrides,
	};
}

function request(
	bodyId: string,
	overrides: Partial<AdmissionRequestInput> = {},
): AdmissionRequestInput {
	return {
		bodyId,
		priority: "background",
		needsLoad: true,
		needsSocket: false,
		residentCost: 10,
		transientCost: 5,
		finalPopulation: "warm",
		requestedAt: 0,
		...overrides,
	};
}

function grantNext(runtime: ResidencyAdmissionCoordinator, now: number): AdmissionReservation {
	const decision = runtime.decideNext(now);
	assert.equal(decision.kind, "granted");
	return decision.reservation;
}

s.test("diagnostics keep active, warm, loading, and cold populations distinct", () => {
	const runtime = coordinator();
	runtime.observeBody(body("active", { population: "active", residentCost: 20, socket: "open" }));
	runtime.observeBody(body("warm"));
	runtime.observeBody(body("loading", { population: "loading", residentCost: 4, transientCost: 7, socket: "opening" }));
	runtime.observeBody(body("cold", { population: "cold", residentCost: 0 }));
	const snapshot = runtime.snapshot();
	assert.deepEqual(snapshot.populations, { active: 1, warm: 1, loading: 1, cold: 1 });
	assert.deepEqual(snapshot.residentCost, { used: 34, reserved: 0, plannedRelease: 0, limit: 100 });
	assert.deepEqual(snapshot.transientCost, { used: 7, reserved: 0, limit: 40 });
	assert.deepEqual(snapshot.loads, { used: 1, reserved: 0, limit: 2 });
	assert.deepEqual(snapshot.sockets, { used: 2, reserved: 0, plannedRelease: 0, fixed: 1, limit: 4 });
});

s.test("editor opens lead catch-up, while an aged background request progresses after a bounded burst", () => {
	const runtime = coordinator({ concurrentLoads: 10 });
	runtime.request(request("background", { requestedAt: 0 }));
	runtime.request(request("editor-a", { priority: "editor", requestedAt: 20, finalPopulation: "active" }));
	const first = grantNext(runtime, 20);
	assert.equal(first.request.bodyId, "editor-a");
	runtime.settle(first.reservationId);

	runtime.request(request("editor-b", { priority: "editor", requestedAt: 21, finalPopulation: "active" }));
	const second = grantNext(runtime, 21);
	assert.equal(second.request.bodyId, "editor-b");
	runtime.settle(second.reservationId);

	runtime.request(request("editor-c", { priority: "editor", requestedAt: 22, finalPopulation: "active" }));
	const promoted = grantNext(runtime, 22);
	assert.equal(promoted.request.bodyId, "background", "aging grants background work after two preferred admissions");
	runtime.settle(promoted.reservationId);
	const resumedEditor = grantNext(runtime, 22);
	assert.equal(resumedEditor.request.bodyId, "editor-c", "a promoted background item delays a cold editor by at most one grant");
});

s.test("load and scratch reservations prevent concurrent over-admission", () => {
	const runtime = coordinator({ concurrentLoads: 1, transientCost: 6 });
	runtime.request(request("first", { transientCost: 6, priority: "editor", finalPopulation: "active" }));
	const first = grantNext(runtime, 0);
	assert.deepEqual(runtime.snapshot().loads, { used: 0, reserved: 1, limit: 1 });
	assert.deepEqual(runtime.snapshot().transientCost, { used: 0, reserved: 6, limit: 6 });

	runtime.request(request("second", { transientCost: 1, priority: "editor", finalPopulation: "active" }));
	const blocked = runtime.decideNext(1);
	assert.equal(blocked.kind, "backpressure");
	if (blocked.kind === "backpressure") assert.equal(blocked.reason, "concurrent_load_limit");

	runtime.settle(first.reservationId, {
		observation: body("first", { population: "active", residentCost: 10, lastUsedAt: 1 }),
	});
	const second = grantNext(runtime, 2);
	assert.equal(second.request.bodyId, "second");
	assert.equal(runtime.settle(second.reservationId), true);
	assert.equal(runtime.settle(second.reservationId), false, "late or double settlement cannot release another reservation");
});

s.test("warm reconstruction reserves transient cost without a load slot", () => {
	const runtime = coordinator({ transientCost: 10, concurrentLoads: 1 });
	runtime.observeBody(body("warm", { population: "warm", residentCost: 5 }));
	runtime.request(request("warm", {
		needsLoad: false,
		residentCost: 0,
		transientCost: 8,
	}));
	const decision = runtime.decideNext(10);
	assert.equal(decision.kind, "granted");
	if (decision.kind !== "granted") return;
	assert.equal(decision.reservation.loadSlots, 0);
	assert.equal(decision.reservation.transientCost, 8);
	assert.equal(runtime.snapshot().transientCost.reserved, 8);
});

s.test("oversized scratch requests fail before any reservation", () => {
	const runtime = coordinator({ transientCost: 5 });
	runtime.request(request("large-merge", { transientCost: 6, priority: "editor" }));
	const decision = runtime.decideNext(0);
	assert.equal(decision.kind, "backpressure");
	if (decision.kind === "backpressure") assert.equal(decision.reason, "transient_cost_limit");
	assert.equal(runtime.snapshot().reservations, 0);
});

s.test("a body larger than the resident budget has a distinct pre-decode outcome", () => {
	const runtime = coordinator({ residentCost: 5 });
	runtime.request(request("oversized", { residentCost: 6, priority: "editor" }));
	const decision = runtime.decideNext(0);
	assert.equal(decision.kind, "backpressure");
	if (decision.kind === "backpressure") assert.equal(decision.reason, "resident_cost_limit");
	assert.equal(runtime.snapshot().reservations, 0);
});

s.test("resident pressure evicts clean warm LRU state and never protected state", () => {
	const runtime = coordinator({ residentCost: 10, warmBodies: 10 });
	runtime.observeBody(body("old-clean", { residentCost: 4, lastUsedAt: 1 }));
	runtime.observeBody(body("new-clean", { residentCost: 3, lastUsedAt: 2 }));
	runtime.observeBody(body("dirty", { residentCost: 3, dirty: true, lastUsedAt: 0 }));
	runtime.request(request("incoming", {
		priority: "editor",
		residentCost: 5,
		finalPopulation: "active",
	}));
	const reservation = grantNext(runtime, 3);
	assert.deepEqual(reservation.evictBodyIds, ["old-clean", "new-clean"]);
	assert.equal(reservation.evictBodyIds.includes("dirty"), false);
});

s.test("dirty, durable, active, and leased saturation reports preservation backpressure", () => {
	const runtime = coordinator({ residentCost: 12, warmBodies: 10 });
	runtime.observeBody(body("dirty", { residentCost: 3, dirty: true }));
	runtime.observeBody(body("durable", { residentCost: 3, durablyPending: true }));
	runtime.observeBody(body("leased", { residentCost: 3, leaseCount: 1 }));
	runtime.observeBody(body("active", { population: "active", residentCost: 3 }));
	runtime.request(request("incoming", { priority: "editor", residentCost: 1, finalPopulation: "active" }));
	const decision = runtime.decideNext(0);
	assert.equal(decision.kind, "backpressure");
	if (decision.kind === "backpressure") assert.equal(decision.reason, "protected_residency_saturation");
	assert.deepEqual(runtime.snapshot().blockers, { dirty: 1, durablyPending: 1, leased: 1, active: 1 });
});

s.test("socket budget closes a clean warm provider without evicting its loaded body", () => {
	const runtime = coordinator({ sockets: 2, reservedSockets: 1 });
	runtime.observeBody(body("warm-socket", { socket: "open", residentCost: 20 }));
	runtime.request(request("active", {
		priority: "editor",
		needsLoad: false,
		needsSocket: true,
		residentCost: 0,
		transientCost: 0,
		finalPopulation: "active",
	}));
	const reservation = grantNext(runtime, 0);
	assert.deepEqual(reservation.evictBodyIds, []);
	assert.deepEqual(reservation.closeSocketBodyIds, ["warm-socket"]);
	assert.equal(runtime.snapshot().populations.warm, 1, "socket closure does not imply body eviction");
});

s.test("a protected warm socket backpressures independently of resident capacity", () => {
	const runtime = coordinator({ sockets: 2, reservedSockets: 1, residentCost: 1_000 });
	runtime.observeBody(body("pending-socket", { socket: "open", durablyPending: true }));
	runtime.request(request("active", {
		priority: "editor",
		needsLoad: false,
		needsSocket: true,
		residentCost: 0,
		transientCost: 0,
		finalPopulation: "active",
	}));
	const decision = runtime.decideNext(0);
	assert.equal(decision.kind, "backpressure");
	if (decision.kind === "backpressure") assert.equal(decision.reason, "socket_budget");
});

s.test("mobile background pauses optional admission and trims only clean durable warm state", () => {
	const runtime = coordinator();
	runtime.setRuntimeContext("mobile", "background");
	runtime.observeBody(body("clean", { socket: "open" }));
	runtime.observeBody(body("dirty", { dirty: true, socket: "open" }));
	runtime.observeBody(body("leased", { leaseCount: 1, socket: "open" }));
	runtime.observeBody(body("active", { population: "active", socket: "open" }));
	runtime.request(request("optional-editor", { priority: "editor", finalPopulation: "active" }));
	const paused = runtime.decideNext(100);
	assert.equal(paused.kind, "backpressure");
	if (paused.kind === "backpressure") assert.equal(paused.reason, "mobile_background");
	assert.deepEqual(runtime.planMaintenance(100), {
		evictBodyIds: ["clean"],
		closeSocketBodyIds: [],
	});

	runtime.request(request("essential", {
		needsLoad: false,
		residentCost: 0,
		transientCost: 0,
		essentialInBackground: true,
	}));
	const essential = grantNext(runtime, 100);
	assert.equal(essential.request.bodyId, "essential");
	runtime.setRuntimeContext("mobile", "foreground");
	runtime.settle(essential.reservationId);
	assert.equal(grantNext(runtime, 101).request.bodyId, "optional-editor");
});

s.test("rapid switching cancellation releases every reserved resource and can requeue safely", () => {
	const runtime = coordinator({ concurrentLoads: 1, sockets: 2, reservedSockets: 1 });
	runtime.request(request("note-a", {
		priority: "editor",
		needsSocket: true,
		finalPopulation: "active",
	}));
	const reservation = grantNext(runtime, 0);
	assert.equal(runtime.snapshot().reservations, 1);
	assert.equal(runtime.settle(reservation.reservationId, { requeue: true }), true);
	assert.equal(runtime.snapshot().reservations, 0);
	assert.deepEqual(runtime.snapshot().loads, { used: 0, reserved: 0, limit: 1 });
	assert.deepEqual(runtime.snapshot().sockets, { used: 0, reserved: 0, plannedRelease: 0, fixed: 1, limit: 2 });
	const retry = grantNext(runtime, 1);
	assert.equal(retry.request.requestId, reservation.request.requestId, "requeue preserves operation identity");
	runtime.settle(retry.reservationId);
	assert.equal(runtime.snapshot().reservations, 0);
});

s.test("queued requests for one body coalesce and upgrade under one stable identity", () => {
	const runtime = coordinator();
	const background = runtime.request(request("same", {
		priority: "background",
		needsSocket: false,
		residentCost: 5,
		transientCost: 2,
		requestedAt: 1,
	}));
	const editor = runtime.request(request("same", {
		priority: "editor",
		needsSocket: true,
		residentCost: 8,
		transientCost: 4,
		finalPopulation: "active",
		requestedAt: 2,
	}));
	assert.equal(editor.requestId, background.requestId);
	assert.equal(runtime.snapshot().queue.editor, 1);
	assert.equal(runtime.snapshot().queue.background, 0);
	const reservation = grantNext(runtime, 2);
	assert.equal(reservation.request.priority, "editor");
	assert.equal(reservation.request.needsSocket, true);
	assert.equal(reservation.request.residentCost, 8);
	assert.equal(reservation.request.transientCost, 4);
	assert.equal(reservation.request.finalPopulation, "active");
	assert.equal(reservation.request.requestedAt, 1);
});

s.test("warm maintenance applies measured retention and count without touching protected bodies", () => {
	const runtime = coordinator({ warmBodies: 2, warmRetentionMs: 50 });
	runtime.observeBody(body("expired", { lastUsedAt: 0 }));
	runtime.observeBody(body("old-over-cap", { lastUsedAt: 60 }));
	runtime.observeBody(body("new", { lastUsedAt: 90 }));
	runtime.observeBody(body("protected", { lastUsedAt: 0, leaseCount: 1 }));
	assert.deepEqual(runtime.planMaintenance(100).evictBodyIds, ["expired", "old-over-cap"]);
});

s.test("a zero warm target still admits finite background work for immediate cooling", () => {
	const runtime = coordinator({ warmBodies: 0 });
	runtime.request(request("one-shot", { finalPopulation: "warm" }));
	const reservation = grantNext(runtime, 0);
	assert.deepEqual(reservation.evictBodyIds, []);
	runtime.settle(reservation.reservationId, {
		observation: body("one-shot", { population: "warm", lastUsedAt: 0 }),
	});
	assert.deepEqual(runtime.planMaintenance(0).evictBodyIds, ["one-shot"]);
});

await s.done();
