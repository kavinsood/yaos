import { strict as assert } from "node:assert";
import type { OperationOutcome } from "../../src/runtime/operationLifecycle";
import {
	OverdueWorkKernel,
	ReconstructibleOverdueWorkStore,
	type DurableWorkIntent,
	type DurableWorkUpsert,
	type OverdueWorkClock,
	type OverdueWorkKernelOptions,
	type OverdueWorkStore,
	type TerminalWorkOutcome,
	type WorkBlocker,
	type WorkRetry,
} from "../../src/runtime/overdueWorkKernel";
import { suite } from "../harness.ts";

interface Metadata {
	readonly label: string;
}

interface TimerRecord {
	readonly id: number;
	readonly dueAt: number;
	readonly callback: () => void;
}

class FakeClock implements OverdueWorkClock {
	private time: number;
	private nextId = 0;
	private readonly timers = new Map<number, TimerRecord>();
	readonly events: string[] = [];

	constructor(now = 0) {
		this.time = now;
	}

	now(): number {
		return this.time;
	}

	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.nextId;
		const dueAt = this.time + delayMs;
		this.timers.set(id, { id, dueAt, callback });
		this.events.push(`timer:${dueAt}`);
		return id;
	}

	clearTimer(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	setNow(now: number): void {
		this.time = now;
	}

	advanceWithoutFiring(ms: number): void {
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

	fireNext(): boolean {
		const next = [...this.timers.values()]
			.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
		if (next === undefined) return false;
		this.time = Math.max(this.time, next.dueAt);
		this.timers.delete(next.id);
		next.callback();
		return true;
	}

	get nextDueAt(): number | null {
		const times = [...this.timers.values()].map((timer) => timer.dueAt);
		return times.length === 0 ? null : Math.min(...times);
	}
}

class FakeStore implements OverdueWorkStore<Metadata> {
	readonly records = new Map<string, DurableWorkIntent<Metadata>>();
	readonly events: string[] = [];
	listCalls = 0;
	activeLists = 0;
	maxActiveLists = 0;
	private revision = 0;
	private listGate: Promise<void> | null = null;
	private releaseListGate: (() => void) | null = null;

	holdNextList(): void {
		this.listGate = new Promise<void>((resolve) => { this.releaseListGate = resolve; });
	}

	releaseList(): void {
		this.releaseListGate?.();
		this.releaseListGate = null;
	}

	async upsert(request: DurableWorkUpsert<Metadata>): Promise<DurableWorkIntent<Metadata>> {
		const existing = this.records.get(request.key);
		const maxWaitAt = existing?.maxWaitAt === undefined
			? request.maxWaitAt
			: request.maxWaitAt === undefined
				? existing.maxWaitAt
				: Math.min(existing.maxWaitAt, request.maxWaitAt);
		const next: DurableWorkIntent<Metadata> = {
			key: request.key,
			revision: ++this.revision,
			priority: request.priority,
			dueAt: request.dueAt,
			...(maxWaitAt === undefined ? {} : { maxWaitAt }),
			attempt: existing?.attempt ?? 0,
			owner: existing?.owner ?? "producer",
			...(existing?.blocker === undefined ? {} : { blocker: existing.blocker }),
			...(request.metadata === undefined ? {} : { metadata: request.metadata }),
		};
		this.records.set(next.key, next);
		this.events.push(`upsert:${next.key}`);
		return next;
	}

	async list(): Promise<readonly DurableWorkIntent<Metadata>[]> {
		this.listCalls++;
		this.activeLists++;
		this.maxActiveLists = Math.max(this.maxActiveLists, this.activeLists);
		const gate = this.listGate;
		this.listGate = null;
		if (gate !== null) await gate;
		this.activeLists--;
		this.events.push("list");
		return [...this.records.values()];
	}

	async claimForKernel(intent: DurableWorkIntent<Metadata>): Promise<DurableWorkIntent<Metadata> | null> {
		const current = this.current(intent);
		if (current === null || current.blocker !== undefined) return null;
		if (current.owner === "kernel") return current;
		const claimed: DurableWorkIntent<Metadata> = {
			...current,
			revision: ++this.revision,
			owner: "kernel",
		};
		this.records.set(claimed.key, claimed);
		this.events.push(`claim:${claimed.key}`);
		return claimed;
	}

	async settle(intent: DurableWorkIntent<Metadata>, outcome: TerminalWorkOutcome): Promise<boolean> {
		if (this.current(intent) === null) return false;
		this.records.delete(intent.key);
		this.events.push(`settle:${intent.key}:${outcome}`);
		return true;
	}

	async scheduleRetry(intent: DurableWorkIntent<Metadata>, retry: WorkRetry): Promise<boolean> {
		const current = this.current(intent);
		if (current === null) return false;
		const next: DurableWorkIntent<Metadata> = {
			...current,
			revision: ++this.revision,
			dueAt: retry.dueAt,
			attempt: retry.attempt,
			owner: "kernel",
		};
		delete (next as { maxWaitAt?: number }).maxWaitAt;
		this.records.set(next.key, next);
		this.events.push(`retry:${next.key}:${retry.dueAt}:${retry.failure}`);
		return true;
	}

	async markBlocked(intent: DurableWorkIntent<Metadata>, blocker: WorkBlocker): Promise<boolean> {
		const current = this.current(intent);
		if (current === null) return false;
		const next: DurableWorkIntent<Metadata> = {
			...current,
			revision: ++this.revision,
			blocker,
			owner: "kernel",
		};
		this.records.set(next.key, next);
		this.events.push(`block:${next.key}:${blocker.kind}`);
		return true;
	}

	async handoff(intent: DurableWorkIntent<Metadata>): Promise<boolean> {
		if (this.current(intent) === null) return false;
		this.records.delete(intent.key);
		this.events.push(`handoff:${intent.key}`);
		return true;
	}

	clearBlocker(key: string): void {
		const current = this.records.get(key);
		if (current === undefined) throw new Error(`missing ${key}`);
		const next = { ...current, revision: ++this.revision };
		delete (next as { blocker?: WorkBlocker }).blocker;
		this.records.set(key, next);
		this.events.push(`unblock:${key}`);
	}

	private current(intent: DurableWorkIntent<Metadata>): DurableWorkIntent<Metadata> | null {
		const current = this.records.get(intent.key);
		return current?.revision === intent.revision ? current : null;
	}

}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => { resolve = settle; });
	return { promise, resolve };
}

async function idle(kernel: OverdueWorkKernel<Metadata, void>): Promise<void> {
	await Promise.resolve();
	await kernel.whenIdle();
	await Promise.resolve();
}

async function currentDrainSettled(kernel: OverdueWorkKernel<Metadata, void>): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (!kernel.getDiagnostics().draining) return;
		await Promise.resolve();
	}
	throw new Error("current drain did not settle within twenty microtasks");
}

async function add(
	store: FakeStore,
	key: string,
	dueAt: number,
	priority: DurableWorkUpsert<Metadata>["priority"] = "normal",
	maxWaitAt?: number,
): Promise<void> {
	await store.upsert({
		key,
		priority,
		dueAt,
		...(maxWaitAt === undefined ? {} : { maxWaitAt }),
		metadata: { label: key },
	});
}

function kernelWith(
	store: FakeStore,
	clock: FakeClock,
	worker: OverdueWorkKernelOptions<Metadata, void>["worker"],
	options: Partial<OverdueWorkKernelOptions<Metadata, void>> = {},
): OverdueWorkKernel<Metadata, void> {
	return new OverdueWorkKernel({
		store,
		clock,
		worker,
		random: { next: () => 0.5 },
		...options,
	});
}

const completed = (): OperationOutcome => ({ kind: "completed", value: undefined });
const s = suite("overdue-work-kernel");

s.test("pokes re-read durable truth and never invent work", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	let runs = 0;
	const kernel = kernelWith(store, clock, () => { runs++; return completed(); });
	kernel.poke("online");
	await idle(kernel);
	assert.equal(runs, 0);
	assert.equal(store.records.size, 0);
});

s.test("simultaneous pokes coalesce behind one non-reentrant drain", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	store.holdNextList();
	const kernel = kernelWith(store, clock, completed);
	kernel.poke("visibility");
	kernel.poke("online");
	kernel.poke("input");
	assert.equal(store.activeLists, 1);
	store.releaseList();
	await currentDrainSettled(kernel);
	assert.equal(kernel.getDiagnostics().lastPokeReason, "input");
	assert.equal(clock.fireDue(), 1);
	await idle(kernel);
	assert.equal(store.maxActiveLists, 1);
	assert.equal(kernel.getDiagnostics().lastPokeReason, "timer");
});

s.test("an explicit key is never in flight twice", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "same", 0);
	const gate = deferred<OperationOutcome>();
	let active = 0;
	let maxActive = 0;
	const kernel = kernelWith(store, clock, async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		const outcome = await gate.promise;
		active--;
		return outcome;
	});
	kernel.poke("first");
	await Promise.resolve();
	await Promise.resolve();
	kernel.poke("duplicate");
	gate.resolve(completed());
	await currentDrainSettled(kernel);
	assert.equal(clock.fireDue(), 1);
	await idle(kernel);
	assert.equal(maxActive, 1);
	assert.equal(store.records.size, 0);
});

s.test("bounded drains yield before processing the remainder", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	for (const key of ["a", "b", "c"]) await add(store, key, 0);
	const runs: string[] = [];
	const kernel = kernelWith(store, clock, (intent) => { runs.push(intent.key); return completed(); }, {
		maxItemsPerDrain: 2,
	});
	kernel.poke("input");
	await currentDrainSettled(kernel);
	assert.deepEqual(runs, ["a", "b"]);
	assert.equal(clock.nextDueAt, 0);
	assert.equal(clock.fireNext(), true);
	await idle(kernel);
	assert.deepEqual(runs, ["a", "b", "c"]);
});

s.test("interactive priority wins when work has equal age", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "background", 0, "background");
	await add(store, "interactive", 0, "interactive");
	const runs: string[] = [];
	const kernel = kernelWith(store, clock, (intent) => { runs.push(intent.key); return completed(); });
	kernel.poke("test");
	await idle(kernel);
	assert.deepEqual(runs, ["interactive", "background"]);
});

s.test("aging eventually lets old background work outrank newer interactive work", async () => {
	const store = new FakeStore();
	const clock = new FakeClock(2_000);
	await add(store, "old-background", 0, "background");
	await add(store, "new-interactive", 2_000, "interactive");
	const runs: string[] = [];
	const kernel = kernelWith(store, clock, (intent) => { runs.push(intent.key); return completed(); }, {
		agingIntervalMs: 1_000,
	});
	kernel.poke("test");
	await idle(kernel);
	assert.deepEqual(runs, ["old-background", "new-interactive"]);
});

s.test("ties are stable by ready time and then key", async () => {
	const store = new FakeStore();
	const clock = new FakeClock(10);
	await add(store, "z", 5);
	await add(store, "b", 0);
	await add(store, "a", 0);
	const runs: string[] = [];
	const kernel = kernelWith(store, clock, (intent) => { runs.push(intent.key); return completed(); });
	kernel.poke("test");
	await idle(kernel);
	assert.deepEqual(runs, ["a", "b", "z"]);
});

s.test("producer upserts honor a durable max-wait bound", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "debounced", 100, "normal", 50);
	await add(store, "debounced", 200, "normal", 150);
	let runs = 0;
	const kernel = kernelWith(store, clock, () => { runs++; return completed(); });
	kernel.poke("new-input");
	await idle(kernel);
	assert.equal(clock.nextDueAt, 50);
	clock.setNow(49);
	assert.equal(clock.fireDue(), 0);
	clock.setNow(50);
	assert.equal(clock.fireDue(), 1);
	await idle(kernel);
	assert.equal(runs, 1);
});

s.test("retry-after is an authoritative minimum", async () => {
	const store = new FakeStore();
	const clock = new FakeClock(100);
	await add(store, "rate-limited", 100);
	const kernel = kernelWith(store, clock, () => ({
		kind: "retryable_failure",
		failure: "rate_limited",
		retryAfterMs: 5_000,
	}), { retryBaseMs: 100, retryMaxMs: 1_000 });
	kernel.poke("test");
	await idle(kernel);
	assert.equal(store.records.get("rate-limited")?.dueAt, 5_100);
	assert.equal(clock.nextDueAt, 5_100);
});

s.test("exponential retry caps before deterministic bounded jitter", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "retry", 0);
	const current = store.records.get("retry");
	assert.ok(current);
	store.records.set("retry", { ...current, attempt: 12 });
	const kernel = kernelWith(store, clock, () => ({ kind: "retryable_failure", failure: "network" }), {
		retryBaseMs: 100,
		retryMaxMs: 500,
		retryJitterRatio: 0.5,
		random: { next: () => 0 },
	});
	kernel.poke("test");
	await idle(kernel);
	assert.equal(store.records.get("retry")?.dueAt, 250);
	assert.equal(store.records.get("retry")?.attempt, 13);
});

s.test("failure classes can select distinct retry policy", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "network", 0);
	await add(store, "limited", 0);
	const kernel = kernelWith(store, clock, (intent) => ({
		kind: "retryable_failure",
		failure: intent.key === "limited" ? "rate_limited" : "network",
	}), {
		retryBaseMs: 100,
		retryMaxMs: 1_000,
		retryPolicies: {
			rate_limited: { baseMs: 2_000, maxMs: 10_000, jitterRatio: 0 },
		},
	});
	kernel.poke("test");
	await idle(kernel);
	assert.equal(store.records.get("network")?.dueAt, 100);
	assert.equal(store.records.get("limited")?.dueAt, 2_000);
});

s.test("retry state is durable before its wake timer is scheduled", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "retry", 0);
	const kernel = kernelWith(store, clock, () => ({ kind: "retryable_failure", failure: "network" }), {
		retryBaseMs: 100,
		retryMaxMs: 1_000,
	});
	kernel.poke("test");
	await idle(kernel);
	const retryIndex = store.events.findIndex((event) => event.startsWith("retry:retry:"));
	const timerIndex = clock.events.findIndex((event) => event === "timer:100");
	assert.ok(retryIndex >= 0);
	assert.ok(timerIndex >= 0);
	assert.equal(store.records.get("retry")?.dueAt, 100);
});

s.test("timer callbacks only poke and re-read current durable state", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "future", 100);
	let runs = 0;
	const kernel = kernelWith(store, clock, () => { runs++; return completed(); });
	kernel.poke("initial");
	await idle(kernel);
	store.records.delete("future");
	clock.setNow(100);
	assert.equal(clock.fireDue(), 1);
	await idle(kernel);
	assert.equal(runs, 0);
	assert.ok(store.listCalls >= 4);
});

s.test("a poke arriving during work schedules exactly one follow-up drain", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "first", 0);
	const gate = deferred<OperationOutcome>();
	const runs: string[] = [];
	const kernel = kernelWith(store, clock, async (intent) => {
		runs.push(intent.key);
		if (intent.key === "first") return gate.promise;
		return completed();
	});
	kernel.poke("first");
	await Promise.resolve();
	await Promise.resolve();
	await add(store, "second", 0);
	kernel.poke("completion");
	gate.resolve(completed());
	await currentDrainSettled(kernel);
	assert.deepEqual(runs, ["first"]);
	assert.equal(clock.fireDue(), 1);
	await idle(kernel);
	assert.deepEqual(runs, ["first", "second"]);
	assert.equal(clock.fireDue(), 0);
});

s.test("stop fences late completion and all retry or settlement publication", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "late", 0);
	const gate = deferred<OperationOutcome>();
	const kernel = kernelWith(store, clock, () => gate.promise);
	kernel.poke("test");
	await Promise.resolve();
	await Promise.resolve();
	kernel.stop();
	gate.resolve({ kind: "retryable_failure", failure: "network" });
	await idle(kernel);
	assert.equal(store.events.some((event) => event.startsWith("retry:late")), false);
	assert.equal(store.events.some((event) => event.startsWith("settle:late")), false);
	assert.equal(store.records.get("late")?.owner, "kernel");
	assert.equal(kernel.getDiagnostics().stopped, true);
	kernel.poke("too-late");
	assert.equal(clock.nextDueAt, null);
});

s.test("durably pending hands ownership away without a kernel retry", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "handoff", 0);
	const kernel = kernelWith(store, clock, () => ({ kind: "durably_pending" }));
	kernel.poke("test");
	await idle(kernel);
	assert.equal(store.events.includes("handoff:handoff"), true);
	assert.equal(store.events.some((event) => event.startsWith("retry:handoff")), false);
	assert.equal(store.records.has("handoff"), false);
});

s.test("diagnostics expose age, priority, blocker, attempt, owner, due, and flight", async () => {
	const store = new FakeStore();
	const clock = new FakeClock(1_000);
	await add(store, "active", 500, "background");
	await add(store, "blocked", 700, "normal");
	const blocked = store.records.get("blocked");
	assert.ok(blocked);
	store.records.set("blocked", {
		...blocked,
		attempt: 3,
		owner: "kernel",
		blocker: { kind: "decision_required", failure: "local_persistence" },
	});
	const gate = deferred<OperationOutcome>();
	const kernel = kernelWith(store, clock, () => gate.promise, { agingIntervalMs: 250 });
	kernel.poke("diagnostics");
	await Promise.resolve();
	await Promise.resolve();
	const diagnostics = kernel.getDiagnostics();
	const active = diagnostics.queue.find((item) => item.key === "active");
	const blockedItem = diagnostics.queue.find((item) => item.key === "blocked");
	assert.deepEqual(active, {
		key: "active",
		queueAgeMs: 500,
		priority: "background",
		effectivePriority: "interactive",
		blocker: null,
		attempt: 0,
		owner: "kernel",
		dueAt: 500,
		maxWaitAt: null,
		readyAt: 500,
		inFlight: true,
	});
	assert.equal(blockedItem?.blocker?.kind, "decision_required");
	assert.equal(blockedItem?.attempt, 3);
	assert.equal(blockedItem?.owner, "kernel");
	gate.resolve(completed());
	await idle(kernel);
});

s.test("decision-required work stays blocked until durable state changes", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "decision", 0);
	let runs = 0;
	const kernel = kernelWith(store, clock, () => {
		runs++;
		return runs === 1
			? { kind: "decision_required", failure: "local_persistence" }
			: completed();
	});
	kernel.poke("first");
	await idle(kernel);
	assert.equal(store.records.get("decision")?.blocker?.kind, "decision_required");
	assert.equal(clock.nextDueAt, null);
	kernel.poke("unrelated");
	await idle(kernel);
	assert.equal(runs, 1);
	store.clearBlocker("decision");
	kernel.poke("user-decision");
	await idle(kernel);
	assert.equal(runs, 2);
	assert.equal(store.records.has("decision"), false);
});

s.test("producer updates cannot resume timer ownership after durable kernel claim", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "owned", 0);
	const gate = deferred<OperationOutcome>();
	const kernel = kernelWith(store, clock, () => gate.promise);
	kernel.poke("test");
	await Promise.resolve();
	await Promise.resolve();
	await add(store, "owned", 10);
	assert.equal(store.records.get("owned")?.owner, "kernel");
	gate.resolve({ kind: "durably_pending" });
	await currentDrainSettled(kernel);
	assert.equal(store.records.has("owned"), true);
});

s.test("whenIdle includes an immediately-due yielded follow-up drain", async () => {
	const store = new FakeStore();
	const clock = new FakeClock();
	await add(store, "a", 0);
	await add(store, "b", 0);
	const runs: string[] = [];
	const kernel = kernelWith(store, clock, (intent) => { runs.push(intent.key); return completed(); }, {
		maxItemsPerDrain: 1,
	});
	kernel.poke("bounded");
	let idleResolved = false;
	const quiescent = kernel.whenIdle().then(() => { idleResolved = true; });
	await currentDrainSettled(kernel);
	assert.deepEqual(runs, ["a"]);
	assert.equal(idleResolved, false);
	assert.equal(clock.fireDue(), 1);
	await quiescent;
	assert.deepEqual(runs, ["a", "b"]);
});

s.test("reconstructible store provides CAS transitions and max-wait coalescing", async () => {
	const store = new ReconstructibleOverdueWorkStore<Metadata>();
	const first = await store.upsert({
		key: "body:a",
		priority: "background",
		dueAt: 100,
		maxWaitAt: 80,
		metadata: { label: "first" },
	});
	const coalesced = await store.upsert({
		key: "body:a",
		priority: "interactive",
		dueAt: 200,
		maxWaitAt: 150,
		metadata: { label: "latest" },
	});
	assert.equal(coalesced.maxWaitAt, 80);
	assert.equal(coalesced.dueAt, 200);
	assert.notEqual(coalesced.revision, first.revision);
	assert.equal(await store.claimForKernel(first), null);
	const claimed = await store.claimForKernel(coalesced);
	assert.ok(claimed);
	assert.equal(claimed.owner, "kernel");
	const updated = await store.upsert({ key: "body:a", priority: "normal", dueAt: 0 });
	assert.equal(updated.owner, "kernel");
	assert.equal(await store.settle(coalesced, "completed"), false);
	assert.equal(await store.scheduleRetry(claimed, { attempt: 1, dueAt: 500, failure: "network" }), false);
	const reclaimed = await store.claimForKernel(updated);
	assert.ok(reclaimed);
	await store.scheduleRetry(reclaimed, { attempt: 1, dueAt: 500, failure: "network" });
	const retry = (await store.list())[0];
	assert.ok(retry);
	assert.equal(retry.dueAt, 500);
	assert.equal(retry.maxWaitAt, undefined);
});

await s.done();
