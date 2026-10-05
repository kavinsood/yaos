import { strict as assert } from "node:assert";
import { RuntimeScope } from "../../legacy-src/runtime/operationLifecycle";
import {
	ShortLivedConnectionBackoff,
	SocketAdmissionCoordinator,
	SocketAdmissionGate,
	type SocketAdmissionProvider,
} from "../../legacy-src/runtime/socketAdmissionCoordinator";
import { suite, until } from "../harness.ts";

const s = suite("socket-admission-coordinator");

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => { resolve = settle; });
	return { promise, resolve };
}

function fakeProvider(id: string, events: string[]): SocketAdmissionProvider & { connected: boolean } {
	const provider = {
		id,
		connected: false,
		connecting: false,
		disconnect: () => {
			provider.connected = false;
			events.push(`${id}:disconnect`);
		},
		connect: () => {
			provider.connected = true;
			events.push(`${id}:connect`);
		},
	};
	return provider;
}

s.test("simultaneous pokes share refresh and admit root then bodies", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	const gate = deferred();
	let refreshes = 0;
	const owned = [fakeProvider("root", events), fakeProvider("body", events)];
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async () => {
			refreshes++;
			events.push("refresh:start");
			await gate.promise;
			events.push("refresh:end");
			return { expiresAt: Date.now() + 60_000 };
		},
		providers: () => owned,
		afterAdmission: async () => { events.push("after"); },
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});

	const visibility = coordinator.request("visible");
	const online = coordinator.request("online");
	gate.resolve();
	assert.equal((await visibility).kind, "completed");
	assert.equal((await online).kind, "completed", "the coalesced request shares the admission outcome");
	assert.equal(refreshes, 1);
	assert.deepEqual(events, [
		"refresh:start", "refresh:end",
		"root:disconnect", "body:disconnect",
		"root:connect", "body:connect", "after",
	]);
});

s.test("runtime stop fences a late credential response before provider mutation", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	const gate = deferred();
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async () => {
			await gate.promise;
			return { expiresAt: Date.now() + 60_000 };
		},
		providers: () => [fakeProvider("root", events)],
		afterAdmission: async () => {},
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});
	const attempt = coordinator.request("visible");
	scope.stopAdmission();
	coordinator.stop();
	gate.resolve();
	assert.equal((await attempt).kind, "superseded");
	assert.deepEqual(events, []);
});

s.test("forced reconnect waits for an admitted body and then refreshes again", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	const firstRefresh = deferred();
	let refreshes = 0;
	const body = fakeProvider("body", events);
	const root = fakeProvider("root", events);
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async (_epoch, force) => {
			refreshes++;
			events.push(`refresh:${force ? "forced" : "current"}`);
			if (refreshes === 1) await firstRefresh.promise;
			return { expiresAt: Date.now() + 60_000 };
		},
		providers: () => [root, body],
		afterAdmission: async () => { events.push("after"); },
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});
	const bodyAdmission = coordinator.admit(body, "body-open");
	const reconnect = coordinator.request("online");
	firstRefresh.resolve();
	assert.equal((await bodyAdmission).kind, "completed");
	assert.equal((await reconnect).kind, "completed");
	assert.deepEqual(events, [
		"refresh:current", "body:disconnect", "body:connect",
		"refresh:forced", "root:disconnect", "body:disconnect",
		"root:connect", "body:connect", "after",
	]);
});

s.test("a completed global admission does not capture later reconnects", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	let refreshes = 0;
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async () => {
			refreshes++;
			return { expiresAt: Date.now() + 60_000 };
		},
		providers: () => [fakeProvider("root", events)],
		afterAdmission: async () => {},
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});
	assert.equal((await coordinator.request("first")).kind, "completed");
	assert.equal((await coordinator.request("liveness-recovery")).kind, "completed");
	assert.equal(refreshes, 2);
	assert.deepEqual(events, [
		"root:disconnect", "root:connect",
		"root:disconnect", "root:connect",
	]);
});

s.test("a provider admission requested during a global admission runs after it instead of being dropped", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	const gate = deferred();
	const body = fakeProvider("body", events);
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async (_epoch, force) => {
			events.push(`refresh:${force ? "forced" : "current"}`);
			if (force) await gate.promise;
			return { expiresAt: Date.now() + 60_000 };
		},
		providers: () => [fakeProvider("root", events)],
		afterAdmission: async () => { events.push("after"); },
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});
	const reconnect = coordinator.request("root-disconnected");
	const bodyAdmission = coordinator.admit(body, "body-open");
	gate.resolve();
	assert.equal((await reconnect).kind, "completed");
	assert.equal((await bodyAdmission).kind, "completed");
	assert.deepEqual(events, [
		"refresh:forced", "root:disconnect", "root:connect", "after",
		"refresh:current", "body:disconnect", "body:connect",
	]);
});

s.test("a provider the global admission already brought up is not admitted twice", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	let rootConnected = false;
	const root: SocketAdmissionProvider = {
		id: "root",
		get connected() { return rootConnected; },
		connecting: false,
		disconnect: () => { rootConnected = false; events.push("root:disconnect"); },
		connect: () => { rootConnected = true; events.push("root:connect"); },
	};
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async () => ({ expiresAt: Date.now() + 60_000 }),
		providers: () => [root],
		afterAdmission: async () => {},
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});
	const reconnect = coordinator.request("root-disconnected");
	const rootAdmission = coordinator.admit(root, "semantic-epoch-reset");
	assert.equal((await reconnect).kind, "completed");
	assert.equal((await rootAdmission).kind, "completed");
	assert.deepEqual(events, ["root:disconnect", "root:connect"]);
});

s.test("terminal and retryable credential failures remain distinct", async () => {
	for (const expected of ["permanently_blocked", "retryable_failure"] as const) {
		const scope = new RuntimeScope();
		const coordinator = new SocketAdmissionCoordinator({
			scope,
			refreshCredential: async () => { throw new Error(expected); },
			providers: () => [],
			afterAdmission: async () => {},
			classifyFailure: () => expected === "permanently_blocked"
				? { failure: "revoked", terminal: true }
				: { failure: "rate_limited", terminal: false, retryAfterMs: 250 },
			isBlocked: () => false,
			log: () => {},
		});
		const outcome = await coordinator.request(expected);
		assert.equal(outcome.kind, expected);
		if (outcome.kind === "retryable_failure") assert.equal(outcome.retryAfterMs, 250);
	}
});

s.test("a root close during an in-flight root admission is re-requested, not coalesced into completed (S5)", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	const root = fakeProvider("root", events);
	const firstAfter = deferred();
	let admissions = 0;
	const delays: number[] = [];
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async () => ({ expiresAt: Date.now() + 60_000 }),
		providers: () => [root],
		afterAdmission: async () => {
			admissions++;
			if (admissions === 1) await firstAfter.promise;
		},
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
		delay: async (ms) => { delays.push(ms); },
		random: () => 0.5,
	});
	const first = coordinator.request("initial");
	await until(() => root.connected, { message: "first admission opened root" });
	// The server closes the freshly opened root before the admission finishes.
	root.connected = false;
	const recovery = coordinator.request("root-disconnected");
	firstAfter.resolve();
	assert.equal((await first).kind, "completed");
	assert.equal((await recovery).kind, "completed");
	assert.equal(admissions, 2, "the coalesced request ran its own admission");
	assert.deepEqual(delays, [250], "after a backoff");
	assert.equal(root.connected, true);
});

s.test("coalesced re-requests are bounded and then hand a retryable failure to the scheduler", async () => {
	const scope = new RuntimeScope();
	const gate = deferred();
	let admissions = 0;
	const delays: number[] = [];
	const root: SocketAdmissionProvider = {
		id: "root", connected: false, connecting: false, disconnect: () => {}, connect: () => {},
	};
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async () => ({ expiresAt: Date.now() + 60_000 }),
		providers: () => [root],
		afterAdmission: async () => {
			admissions++;
			if (admissions === 1) await gate.promise;
		},
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
		// Each backoff lands while another admission is in flight, so every
		// re-request coalesces again.
		delay: async (ms) => {
			delays.push(ms);
			void coordinator.request("competing");
		},
		random: () => 0.5,
	});
	void coordinator.request("initial");
	const coalesced = coordinator.request("root-disconnected");
	gate.resolve();
	const outcome = await coalesced;
	assert.equal(outcome.kind, "retryable_failure");
	assert.deepEqual(delays, [250, 500, 1_000], "exponential backoff, bounded");
});

s.test("short-lived connections back off exponentially from the second flap, capped, and reset", () => {
	const backoff = new ShortLivedConnectionBackoff({ random: () => 0.5, maxMs: 4_000 });
	backoff.opened("root", 0);
	assert.equal(backoff.closed("root", 100), null, "a single short-lived connection is ordinary");
	const delays: Array<number | null> = [];
	for (let index = 0; index < 5; index++) {
		backoff.opened("root", 1_000 * index);
		delays.push(backoff.closed("root", 1_000 * index + 50));
	}
	assert.deepEqual(delays, [1_000, 2_000, 4_000, 4_000, 4_000]);
	backoff.opened("root", 100_000);
	assert.equal(backoff.closed("root", 111_000), null, "a connection that lived past the window resets the streak");
	backoff.opened("root", 200_000);
	assert.equal(backoff.closed("root", 200_010), null);
	assert.equal(backoff.closed("unknown", 1), null, "a close without an open is not a flap");
	const jittered = new ShortLivedConnectionBackoff({ random: () => 1 });
	jittered.opened("body", 0); jittered.closed("body", 1);
	jittered.opened("body", 2);
	assert.equal(jittered.closed("body", 3), 1_200, "+20 % jitter");
});

s.test("admissions whose socket never opens back off after two free attempts (N3)", () => {
	const gate = new SocketAdmissionGate({ random: () => 0.5 });
	let now = 0;
	const admit = (): number => {
		const waitMs = gate.blockedFor("body-a", now);
		if (waitMs === 0) gate.record("body-a", now);
		return waitMs;
	};
	assert.equal(admit(), 0);
	now += 10; assert.equal(admit(), 0, "one retry of a socket that never opened is free");
	now += 10; assert.equal(admit(), 0);
	now += 10; assert.equal(admit(), 990, "the third never-opened admission holds the next one for 1 s");
	now += 990; assert.equal(admit(), 0);
	now += 10; assert.equal(admit(), 1_990, "…then 2 s");
	assert.equal(gate.blockedFor("body-b", now), 0, "per document");
	gate.opened("body-a");
	now += 1; assert.equal(admit(), 0, "an open resets the streak");
});

s.test("the admission circuit breaker trips above 10/min and backs off exponentially, then resets (N3)", () => {
	const gate = new SocketAdmissionGate({ random: () => 0.5, freeUnopenedAttempts: Number.MAX_SAFE_INTEGER });
	let now = 0;
	let admitted = 0;
	const refusals: number[] = [];
	// A storm: something asks for an admission every 100 ms for 3 minutes.
	for (; now < 180_000; now += 100) {
		const waitMs = gate.blockedFor("root", now);
		if (waitMs === 0) {
			gate.record("root", now);
			admitted++;
		} else if (refusals.length === 0 || waitMs > refusals[refusals.length - 1]!) {
			refusals.push(waitMs);
		}
	}
	assert.equal(refusals[0], 2_000, "first trip blocks 2 s");
	assert.ok(refusals.includes(4_000) && refusals.includes(8_000), `doubling: ${refusals.join(",")}`);
	// 10 in the first second, then a handful: nowhere near 1 800 (one per 100 ms).
	assert.ok(admitted <= 17, `admissions bounded in a 3-minute storm: ${admitted}`);
	now += 5 * 60_000;
	for (let index = 0; index < 10; index++) {
		assert.equal(gate.blockedFor("root", now), 0, "quiet period resets the breaker");
		gate.record("root", now);
		now += 1;
	}
	assert.equal(gate.blockedFor("root", now), 2_000, "back to the base delay");
	// Admissions whose socket opens (rapid note switching) never trip it.
	const healthy = new SocketAdmissionGate({ random: () => 0.5 });
	for (let index = 0; index < 100; index++) {
		assert.equal(healthy.blockedFor("body", index), 0, `opened admission ${index}`);
		healthy.record("body", index);
		healthy.opened("body");
	}
});

s.test("a gated admission refuses before minting a credential and reports rate_limited retryAfterMs (N3)", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	let refreshes = 0;
	let now = 0;
	const gate = new SocketAdmissionGate({ random: () => 0.5, maxAdmissionsPerWindow: 2 });
	const root = fakeProvider("root", events);
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		gate,
		now: () => now,
		refreshCredential: async () => { refreshes++; return { expiresAt: 60_000 }; },
		providers: () => [root],
		afterAdmission: async () => {},
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});
	assert.equal((await coordinator.request("a")).kind, "completed");
	now += 1;
	assert.equal((await coordinator.request("b")).kind, "completed");
	now += 1;
	const refused = await coordinator.request("c");
	assert.deepEqual(refused, { kind: "retryable_failure", failure: "rate_limited", retryAfterMs: 2_000 });
	const body = fakeProvider("body", events);
	assert.equal((await coordinator.admit(body, "body-reconnect")).kind, "completed", "other documents are not gated");
	assert.equal((await coordinator.admit(body, "body-reconnect")).kind, "completed");
	const bodyRefused = await coordinator.admit(body, "body-reconnect");
	assert.equal(bodyRefused.kind, "retryable_failure");
	assert.equal(refreshes, 4, "refused admissions mint no ticket");
});

await s.done();
