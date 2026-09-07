import { strict as assert } from "node:assert";
import {
	ResidencyAdmissionCoordinator,
	type AdmissionReservation,
} from "../../src/runtime/residencyAdmissionCoordinator";
import {
	ResidencyAdmissionBackpressureError,
	ResidencyAdmissionRuntime,
} from "../../src/runtime/residencyAdmissionRuntime";
import { suite } from "../harness.ts";

const s = suite("residency-admission-runtime");

function coordinator(): ResidencyAdmissionCoordinator {
	let nextId = 0;
	return new ResidencyAdmissionCoordinator({
		residentCost: 100,
		transientCost: 20,
		concurrentLoads: 1,
		warmBodies: 2,
		sockets: 3,
		reservedSockets: 1,
		warmRetentionMs: 1_000,
		backgroundPromotionMs: 100,
		maxPreferredBurst: 2,
	}, () => `id-${++nextId}`);
}

s.test("dispatcher holds queued work until the active reservation settles", async () => {
	const policy = coordinator();
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const starts: string[] = [];
	const runtime = new ResidencyAdmissionRuntime({
		coordinator: policy,
		now: () => 10,
		refreshObservations: () => {},
		prepare: async () => {},
	});
	const input = (bodyId: string) => ({
		bodyId,
		priority: "editor" as const,
		needsLoad: true,
		needsSocket: false,
		residentCost: 10,
		transientCost: 10,
		finalPopulation: "active" as const,
	});
	const first = runtime.run(input("first"), async () => {
		starts.push("first");
		await firstGate;
		return 1;
	});
	const second = runtime.run(input("second"), async () => {
		starts.push("second");
		return 2;
	});
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	assert.deepEqual(starts, ["first"]);
	releaseFirst();
	assert.equal(await first, 1);
	assert.equal(await second, 2);
	assert.deepEqual(starts, ["first", "second"]);
});

s.test("dispatcher performs the coordinator's eviction plan before work", async () => {
	const policy = coordinator();
	policy.observeBody({
		bodyId: "old",
		population: "warm",
		residentCost: 95,
		transientCost: 0,
		dirty: false,
		durablyPending: false,
		leaseCount: 0,
		socket: "none",
		lastUsedAt: 1,
	});
	const events: string[] = [];
	const runtime = new ResidencyAdmissionRuntime({
		coordinator: policy,
		now: () => 10,
		refreshObservations: () => {},
		prepare: async (reservation: AdmissionReservation) => {
			events.push(`evict:${reservation.evictBodyIds.join(",")}`);
		},
	});
	await runtime.run({
		bodyId: "new",
		priority: "editor",
		needsLoad: true,
		needsSocket: false,
		residentCost: 20,
		transientCost: 5,
		finalPopulation: "active",
	}, async () => {
		events.push("work");
	});
	assert.deepEqual(events, ["evict:old", "work"]);
});

s.test("coalesced callers all execute and settle", async () => {
	const policy = coordinator();
	let releasePrepare!: () => void;
	const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
	const runtime = new ResidencyAdmissionRuntime({
		coordinator: policy,
		now: () => 10,
		refreshObservations: () => {},
		prepare: () => prepareGate,
	});
	const input = {
		bodyId: "same",
		priority: "foreground" as const,
		needsLoad: true,
		needsSocket: false,
		residentCost: 10,
		transientCost: 5,
		finalPopulation: "warm" as const,
	};
	const first = runtime.run(input, async () => "first");
	const second = runtime.run(input, async () => "second");
	releasePrepare();
	assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
	assert.equal(policy.snapshot().reservations, 0);
});

s.test("active reservation accepts only compatible late callers", async () => {
	const policy = coordinator();
	let prepares = 0;
	let releaseFirst!: () => void;
	const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const starts: string[] = [];
	const runtime = new ResidencyAdmissionRuntime({
		coordinator: policy,
		now: () => 10,
		refreshObservations: () => {},
		prepare: async () => { prepares++; },
	});
	const first = runtime.run({
		bodyId: "same", priority: "editor", needsLoad: true, needsSocket: false,
		residentCost: 10, transientCost: 5, finalPopulation: "active",
	}, async () => { starts.push("first"); await gate; });
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	const compatible = runtime.run({
		bodyId: "same", priority: "foreground", needsLoad: true, needsSocket: false,
		residentCost: 8, transientCost: 4, finalPopulation: "warm",
	}, async () => { starts.push("compatible"); });
	const incompatible = runtime.run({
		bodyId: "same", priority: "editor", needsLoad: false, needsSocket: true,
		residentCost: 0, transientCost: 0, finalPopulation: "active",
	}, async () => { starts.push("socket"); });
	releaseFirst();
	await Promise.all([first, compatible, incompatible]);
	assert.equal(starts[0], "first");
	assert.deepEqual(new Set(starts), new Set(["first", "compatible", "socket"]));
	assert.equal(prepares, 2);
});

s.test("mobile background work remains queued until foreground", async () => {
	const policy = coordinator();
	policy.setRuntimeContext("mobile", "background");
	const runtime = new ResidencyAdmissionRuntime({
		coordinator: policy,
		now: () => 10,
		refreshObservations: () => {},
		prepare: async () => {},
	});
	let started = false;
	const result = runtime.run({
		bodyId: "paused", priority: "background", needsLoad: true, needsSocket: false,
		residentCost: 1, transientCost: 1, finalPopulation: "warm",
	}, async () => { started = true; });
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	assert.equal(started, false);
	assert.equal(policy.snapshot().queue.background, 1);
	policy.setRuntimeContext("mobile", "foreground");
	runtime.poke();
	await result;
	assert.equal(started, true);
});

s.test("stop rejects queued work and prevents later admission", async () => {
	const policy = coordinator();
	policy.setRuntimeContext("mobile", "background");
	const runtime = new ResidencyAdmissionRuntime({
		coordinator: policy,
		now: () => 10,
		refreshObservations: () => {},
		prepare: async () => {},
	});
	const queued = runtime.run({
		bodyId: "queued", priority: "background", needsLoad: true, needsSocket: false,
		residentCost: 1, transientCost: 1, finalPopulation: "warm",
	}, async () => undefined);
	runtime.stop();
	await assert.rejects(queued, /residency admission stopped/);
	assert.equal(policy.snapshot().queue.background, 0);
	await assert.rejects(
		runtime.run({
			bodyId: "late", priority: "editor", needsLoad: false, needsSocket: false,
			residentCost: 0, transientCost: 0, finalPopulation: "active",
		}, async () => undefined),
		/residency admission is stopped/,
	);
});

s.test("hard protected saturation rejects with typed backpressure", async () => {
	const policy = coordinator();
	policy.observeBody({
		bodyId: "dirty",
		population: "warm",
		residentCost: 100,
		transientCost: 0,
		dirty: true,
		durablyPending: true,
		leaseCount: 0,
		socket: "none",
		lastUsedAt: 1,
	});
	const runtime = new ResidencyAdmissionRuntime({
		coordinator: policy,
		now: () => 10,
		refreshObservations: () => {},
		prepare: async () => {},
	});
	await assert.rejects(
		runtime.run({
			bodyId: "new",
			priority: "background",
			needsLoad: true,
			needsSocket: false,
			residentCost: 1,
			transientCost: 1,
			finalPopulation: "warm",
		}, async () => undefined),
		(error: unknown) => error instanceof ResidencyAdmissionBackpressureError
			&& error.reason === "protected_residency_saturation",
	);
});

await s.done();
