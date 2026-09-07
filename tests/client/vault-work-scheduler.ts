import { strict as assert } from "node:assert";
import type { OperationOutcome } from "../../src/runtime/operationLifecycle";
import type { DurableWorkIntent, OverdueWorkClock } from "../../src/runtime/overdueWorkKernel";
import {
	VaultWorkScheduler,
	type VaultWorkMetadata,
	type VaultWorkSchedulerDeps,
} from "../../src/sync/vaultWorkScheduler";
import { suite } from "../harness.ts";

interface TimerRecord {
	readonly id: number;
	readonly dueAt: number;
	readonly callback: () => void;
}

class FakeClock implements OverdueWorkClock {
	private time: number;
	private sequence = 0;
	private readonly timers = new Map<number, TimerRecord>();

	constructor(now = 0) {
		this.time = now;
	}

	now(): number {
		return this.time;
	}

	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { id, dueAt: this.time + delayMs, callback });
		return id;
	}

	clearTimer(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(ms: number): void {
		this.time += ms;
	}

	fireDue(): number {
		const due = [...this.timers.values()]
			.filter((timer) => timer.dueAt <= this.time)
			.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
		for (const timer of due) {
			this.timers.delete(timer.id);
			timer.callback();
		}
		return due.length;
	}

	get nextDueAt(): number | null {
		const times = [...this.timers.values()].map((timer) => timer.dueAt);
		return times.length === 0 ? null : Math.min(...times);
	}
}

interface SchedulerFixture {
	readonly scheduler: VaultWorkScheduler;
	readonly errors: unknown[];
}

const schedulerClocks = new WeakMap<VaultWorkScheduler, FakeClock>();

function completed(): OperationOutcome {
	return { kind: "completed", value: undefined };
}

function createScheduler(
	clock: FakeClock,
	overrides: Partial<VaultWorkSchedulerDeps> = {},
): SchedulerFixture {
	const errors: unknown[] = [];
	const scheduler = new VaultWorkScheduler({
		clock,
		random: { next: () => 0.5 },
		reconnect: async () => completed(),
		wakeBody: async () => completed(),
		flushCandidate: async () => completed(),
		retryAttachmentPublications: async () => completed(),
		onError: (error) => { errors.push(error); },
		...overrides,
	});
	schedulerClocks.set(scheduler, clock);
	return { scheduler, errors };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => { resolve = settle; });
	return { promise, resolve };
}

async function idle(scheduler: VaultWorkScheduler): Promise<void> {
	const clock = schedulerClocks.get(scheduler);
	if (!clock) throw new Error("scheduler has no test clock");
	let resolved = false;
	const quiescent = scheduler.whenIdle().then(() => { resolved = true; });
	for (let attempt = 0; attempt < 50 && !resolved; attempt++) {
		await Promise.resolve();
		const diagnostics = scheduler.diagnostics();
		if (!diagnostics.draining
			&& diagnostics.nextWakeAt !== null
			&& diagnostics.nextWakeAt <= clock.now()) {
			clock.fireDue();
		}
	}
	await quiescent;
}

async function currentDrainSettled(scheduler: VaultWorkScheduler): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (!scheduler.diagnostics().draining) return;
		await Promise.resolve();
	}
	throw new Error("current drain did not settle within twenty microtasks");
}

async function started(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("work did not start within twenty microtasks");
}

const s = suite("vault-work-scheduler");

s.test("candidate debounce uses one key and preserves the first max-wait bound", async () => {
	const clock = new FakeClock(1_000);
	const bodies: string[] = [];
	const { scheduler } = createScheduler(clock, {
		flushCandidate: async (bodyId) => { bodies.push(bodyId); return completed(); },
	});
	await scheduler.queueCandidate("body-1", 100, 150);
	await idle(scheduler);
	assert.equal(clock.nextDueAt, 1_100);
	clock.advance(90);
	await scheduler.queueCandidate("body-1", 100, 150);
	await idle(scheduler);
	const diagnostic = scheduler.diagnostics().queue.find((item) => item.key === "candidate:body-1");
	assert.equal(diagnostic?.dueAt, 1_190);
	assert.equal(diagnostic?.maxWaitAt, 1_150);
	assert.equal(diagnostic?.readyAt, 1_150);
	assert.equal(clock.nextDueAt, 1_150);
	clock.advance(59);
	assert.equal(clock.fireDue(), 0);
	clock.advance(1);
	assert.equal(clock.fireDue(), 1);
	await idle(scheduler);
	assert.deepEqual(bodies, ["body-1"]);
	assert.equal(scheduler.diagnostics().queue.length, 0);
	scheduler.stop();
});

s.test("domain callbacks route through explicit stable keys", async () => {
	const clock = new FakeClock(500);
	const calls: string[] = [];
	const { scheduler, errors } = createScheduler(clock, {
		reconnect: async (reason) => { calls.push(`reconnect:${reason}`); return completed(); },
		wakeBody: async (bodyId, generation) => { calls.push(`wake:${bodyId}:${generation}`); return completed(); },
		flushCandidate: async (bodyId) => { calls.push(`candidate:${bodyId}`); return completed(); },
		retryAttachmentPublications: async () => { calls.push("attachment"); return completed(); },
	});
	await Promise.all([
		scheduler.queueReconnect("online"),
		scheduler.queueBodyWake("body-1", 7),
		scheduler.queueCandidateNow("body-2"),
		scheduler.queueAttachmentPublications(),
	]);
	await idle(scheduler);
	assert.deepEqual(new Set(calls), new Set([
		"reconnect:online",
		"wake:body-1:7",
		"candidate:body-2",
		"attachment",
	]));
	assert.equal(scheduler.diagnostics().queue.length, 0);
	assert.deepEqual(errors, []);
	scheduler.stop();
});

s.test("network retry stays kernel-owned and uses the injected clock", async () => {
	const clock = new FakeClock(10_000);
	let attempts = 0;
	const { scheduler } = createScheduler(clock, {
		reconnect: async () => {
			attempts++;
			return attempts === 1
				? { kind: "retryable_failure", failure: "network" }
				: completed();
		},
	});
	await scheduler.queueReconnect("offline");
	await idle(scheduler);
	const retry = scheduler.diagnostics().queue[0];
	assert.equal(attempts, 1);
	assert.equal(retry?.owner, "kernel");
	assert.equal(retry?.attempt, 1);
	assert.equal(retry?.dueAt, 11_000);
	assert.equal(retry?.inFlight, false);
	assert.equal(clock.nextDueAt, 11_000);
	clock.advance(999);
	assert.equal(clock.fireDue(), 0);
	clock.advance(1);
	assert.equal(clock.fireDue(), 1);
	await idle(scheduler);
	assert.equal(attempts, 2);
	assert.equal(scheduler.diagnostics().queue.length, 0);
	scheduler.stop();
});

s.test("retry-after remains authoritative over failure-class backoff", async () => {
	const clock = new FakeClock(100);
	const { scheduler } = createScheduler(clock, {
		reconnect: async () => ({
			kind: "retryable_failure",
			failure: "rate_limited",
			retryAfterMs: 10_000,
		}),
	});
	await scheduler.queueReconnect("rate-limited");
	await idle(scheduler);
	assert.equal(scheduler.diagnostics().queue[0]?.dueAt, 10_100);
	assert.equal(clock.nextDueAt, 10_100);
	scheduler.stop();
});

s.test("producer upsert supersedes an in-flight candidate without taking retry ownership", async () => {
	const clock = new FakeClock();
	const first = deferred<OperationOutcome>();
	let attempts = 0;
	const { scheduler, errors } = createScheduler(clock, {
		flushCandidate: async () => {
			attempts++;
			return attempts === 1 ? first.promise : completed();
		},
	});
	await scheduler.queueCandidateNow("body-1");
	await started(() => attempts === 1);
	await scheduler.queueCandidateNow("body-1");
	assert.equal(scheduler.diagnostics().queue[0]?.owner, "kernel");
	first.resolve(completed());
	await currentDrainSettled(scheduler);
	assert.equal(attempts, 1);
	assert.equal(clock.nextDueAt, 0);
	assert.equal(clock.fireDue(), 1);
	await idle(scheduler);
	assert.equal(attempts, 2);
	assert.equal(scheduler.diagnostics().queue.length, 0);
	assert.deepEqual(errors, []);
	scheduler.stop();
});

s.test("body wake coalescing never regresses the requested generation", async () => {
	const clock = new FakeClock();
	const first = deferred<OperationOutcome>();
	const generations: number[] = [];
	const { scheduler } = createScheduler(clock, {
		wakeBody: async (_bodyId, generation) => {
			generations.push(generation);
			return generations.length === 1 ? first.promise : completed();
		},
	});
	await scheduler.queueBodyWake("body-1", 8, "interactive");
	await started(() => generations.length === 1);
	await scheduler.queueBodyWake("body-1", 3, "background");
	assert.equal(scheduler.diagnostics().queue[0]?.owner, "kernel");
	first.resolve(completed());
	await currentDrainSettled(scheduler);
	assert.equal(scheduler.diagnostics().queue[0]?.priority, "interactive");
	assert.equal(clock.fireDue(), 1);
	await idle(scheduler);
	assert.deepEqual(generations, [8, 8]);
	scheduler.stop();
});

s.test("durably-pending attachment work hands retry ownership back to its domain", async () => {
	const clock = new FakeClock();
	const { scheduler } = createScheduler(clock, {
		retryAttachmentPublications: async () => ({ kind: "durably_pending" }),
	});
	await scheduler.queueAttachmentPublications();
	await idle(scheduler);
	assert.equal(scheduler.diagnostics().queue.length, 0);
	assert.equal(clock.nextDueAt, null);
	scheduler.stop();
});

s.test("decision-required callbacks remain blocked and visible", async () => {
	const clock = new FakeClock(2_000);
	let attempts = 0;
	const { scheduler } = createScheduler(clock, {
		reconnect: async () => {
			attempts++;
			return { kind: "decision_required", failure: "unauthorized" };
		},
	});
	await scheduler.queueReconnect("credentials");
	await idle(scheduler);
	const item = scheduler.diagnostics().queue[0];
	assert.equal(item?.key, "reconnect");
	assert.equal(item?.blocker?.kind, "decision_required");
	assert.equal(item?.blocker?.failure, "unauthorized");
	assert.equal(item?.owner, "kernel");
	assert.equal(clock.nextDueAt, null);
	scheduler.poke("visibility");
	await idle(scheduler);
	assert.equal(attempts, 1);
	scheduler.stop();
});

s.test("startup reconstruction drains pending domain intent", async () => {
	const clock = new FakeClock(1_000);
	const initial: DurableWorkIntent<VaultWorkMetadata> = {
		key: "candidate:restored",
		revision: "domain:4",
		priority: "normal",
		dueAt: 900,
		attempt: 2,
		owner: "producer",
		metadata: { kind: "candidate", bodyId: "restored" },
	};
	const calls: string[] = [];
	const { scheduler } = createScheduler(clock, {
		initialIntents: [initial],
		flushCandidate: async (bodyId) => { calls.push(bodyId); return completed(); },
	});
	await idle(scheduler);
	assert.deepEqual(calls, ["restored"]);
	assert.equal(scheduler.diagnostics().lastPokeReason, "startup-reconstruction");
	assert.equal(scheduler.diagnostics().queue.length, 0);
	scheduler.stop();
});

s.test("stop fences late callback publication and rejects later enqueue", async () => {
	const clock = new FakeClock();
	const gate = deferred<OperationOutcome>();
	let attempts = 0;
	const { scheduler } = createScheduler(clock, {
		reconnect: async () => { attempts++; return gate.promise; },
	});
	assert.throws(() => scheduler.queueCandidate("body", Number.NaN, 10), /debounceMs must be/);
	await scheduler.queueReconnect("shutdown-race");
	await started(() => attempts === 1);
	scheduler.stop();
	gate.resolve({ kind: "retryable_failure", failure: "network" });
	await idle(scheduler);
	const diagnostics = scheduler.diagnostics();
	assert.equal(diagnostics.stopped, true);
	assert.equal(diagnostics.queue[0]?.owner, "kernel");
	assert.equal(diagnostics.queue[0]?.attempt, 0);
	assert.equal(clock.nextDueAt, null);
	await assert.rejects(scheduler.queueReconnect("late"), /scheduler is stopped/);
});

await s.done();
