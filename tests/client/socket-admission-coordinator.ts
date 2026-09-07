import { strict as assert } from "node:assert";
import { RuntimeScope } from "../../src/runtime/operationLifecycle";
import {
	SocketAdmissionCoordinator,
	type SocketAdmissionProvider,
} from "../../src/runtime/socketAdmissionCoordinator";
import { suite } from "../harness.ts";

const s = suite("socket-admission-coordinator");

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => { resolve = settle; });
	return { promise, resolve };
}

function fakeProvider(id: string, events: string[]): SocketAdmissionProvider {
	return {
		id,
		connected: false,
		connecting: false,
		disconnect: () => events.push(`${id}:disconnect`),
		connect: () => { events.push(`${id}:connect`); },
	};
}

s.test("simultaneous pokes share refresh and admit root then bodies", async () => {
	const scope = new RuntimeScope();
	const events: string[] = [];
	const gate = deferred();
	let refreshes = 0;
	const coordinator = new SocketAdmissionCoordinator({
		scope,
		refreshCredential: async () => {
			refreshes++;
			events.push("refresh:start");
			await gate.promise;
			events.push("refresh:end");
			return { expiresAt: Date.now() + 60_000 };
		},
		providers: () => [fakeProvider("root", events), fakeProvider("body", events)],
		afterAdmission: async () => { events.push("after"); },
		classifyFailure: () => ({ failure: "internal", terminal: false }),
		isBlocked: () => false,
		log: () => {},
	});

	const visibility = coordinator.request("visible");
	const online = coordinator.request("online");
	assert.strictEqual(visibility, online);
	gate.resolve();
	assert.equal((await visibility).kind, "completed");
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

await s.done();
