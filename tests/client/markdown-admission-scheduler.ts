import { strict as assert } from "node:assert";
import type { OperationOutcome } from "../../src/runtime/operationLifecycle";
import {
	DEFAULT_MAX_WAIT_MS,
	DEFAULT_SETTLE_MS,
	MarkdownAdmissionScheduler,
	type MarkdownAdmissionIntent,
} from "../../src/runtime/markdownAdmissionScheduler";
import type { OverdueWorkClock } from "../../src/runtime/overdueWorkKernel";
import { suite } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();

class FakeClock implements OverdueWorkClock {
	private value = 0;
	private sequence = 0;
	private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

	now(): number { return this.value; }
	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { dueAt: this.value + delayMs, callback });
		return id;
	}
	clearTimer(handle: unknown): void { this.timers.delete(handle as number); }
	advance(ms: number): void { this.value += ms; }
	fireDue(): void {
		for (const [id, timer] of [...this.timers.entries()]
			.filter(([, timer]) => timer.dueAt <= this.value)
			.sort((left, right) => left[1].dueAt - right[1].dueAt)) {
			this.timers.delete(id);
			timer.callback();
		}
	}
	get nextDueAt(): number | null {
		const due = [...this.timers.values()].map((timer) => timer.dueAt);
		return due.length === 0 ? null : Math.min(...due);
	}
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function settle(scheduler: MarkdownAdmissionScheduler, clock: FakeClock): Promise<void> {
	let resolved = false;
	const idle = scheduler.whenIdle().then(() => { resolved = true; });
	for (let index = 0; index < 50 && !resolved; index++) {
		await Promise.resolve();
		if (clock.nextDueAt !== null && clock.nextDueAt <= clock.now()) clock.fireDue();
	}
	await idle;
}

function completed(): OperationOutcome {
	return { kind: "completed", value: undefined };
}

const s = suite("markdown-admission-scheduler");

s.test("one noisy path cannot postpone another path", async () => {
	const clock = new FakeClock();
	const paths: string[] = [];
	const scheduler = new MarkdownAdmissionScheduler({
		clock,
		settleMs: 100,
		maxWaitMs: 250,
		process: async (intent) => { paths.push(intent.path); return completed(); },
		onError: assert.fail,
	});
	scheduler.queue({ path: "a.md", reason: "modify" });
	scheduler.queue({ path: "b.md", reason: "modify" });
	await settle(scheduler, clock);
	clock.advance(90);
	scheduler.queue({ path: "a.md", reason: "modify" });
	await settle(scheduler, clock);
	clock.advance(10);
	clock.fireDue();
	await settle(scheduler, clock);
	assert.deepEqual(paths, ["b.md"]);
	clock.advance(90);
	clock.fireDue();
	await settle(scheduler, clock);
	assert.deepEqual(paths, ["b.md", "a.md"]);
	scheduler.stop();
});

s.test("continuous events cannot extend the first per-path deadline", async () => {
	const clock = new FakeClock();
	const calls: MarkdownAdmissionIntent[] = [];
	const scheduler = new MarkdownAdmissionScheduler({
		clock,
		settleMs: 100,
		maxWaitMs: 250,
		process: async (intent) => { calls.push(intent); return completed(); },
		onError: assert.fail,
	});
	scheduler.queue({ path: "busy.md", reason: "modify" });
	for (let index = 0; index < 3; index++) {
		await settle(scheduler, clock);
		clock.advance(80);
		scheduler.queue({ path: "busy.md", reason: "modify" });
	}
	await settle(scheduler, clock);
	clock.advance(10);
	clock.fireDue();
	await settle(scheduler, clock);
	assert.equal(clock.now(), 250);
	assert.equal(calls.length, 1);
	scheduler.stop();
});

s.test("stale completion cannot settle a newer path revision", async () => {
	const clock = new FakeClock();
	const first = deferred<OperationOutcome>();
	const revisions: number[] = [];
	const scheduler = new MarkdownAdmissionScheduler({
		clock,
		settleMs: 0,
		process: async (intent) => {
			revisions.push(intent.revision);
			return revisions.length === 1 ? first.promise : completed();
		},
		onError: assert.fail,
	});
	scheduler.queue({ path: "race.md", reason: "create", opId: "stable" });
	clock.fireDue();
	for (let index = 0; index < 10 && revisions.length === 0; index++) await Promise.resolve();
	scheduler.queue({ path: "race.md", reason: "modify" });
	first.resolve(completed());
	await settle(scheduler, clock);
	clock.fireDue();
	await settle(scheduler, clock);
	assert.deepEqual(revisions, [1, 2]);
	scheduler.stop();
});

s.test("redirect and drop invalidate obsolete path revisions", async () => {
	const clock = new FakeClock();
	const paths: string[] = [];
	const scheduler = new MarkdownAdmissionScheduler({
		clock,
		settleMs: 20,
		process: async (intent) => { paths.push(intent.path); return completed(); },
		onError: assert.fail,
	});
	scheduler.queue({ path: "old.md", reason: "create", opId: "rename" });
	assert.equal(scheduler.redirect("old.md", "new.md"), true);
	scheduler.queue({ path: "excluded.md", reason: "create" });
	assert.equal(scheduler.drop("excluded.md"), true);
	await settle(scheduler, clock);
	clock.advance(20);
	clock.fireDue();
	await settle(scheduler, clock);
	assert.deepEqual(paths, ["new.md"]);
	scheduler.stop();
});

s.test("default disk batching settles after 2 s quiet and caps a noisy path at 5 s", async () => {
	assert.equal(DEFAULT_SETTLE_MS, 2_000);
	assert.equal(DEFAULT_MAX_WAIT_MS, 5_000);
	const clock = new FakeClock();
	const processed: Array<{ path: string; at: number }> = [];
	const scheduler = new MarkdownAdmissionScheduler({
		clock,
		process: async (intent) => { processed.push({ path: intent.path, at: clock.now() }); return completed(); },
		onError: assert.fail,
	});
	const step = async (ms: number) => {
		for (let elapsed = 0; elapsed < ms; elapsed += 100) {
			clock.advance(100);
			clock.fireDue();
			for (let index = 0; index < 5; index++) await Promise.resolve();
		}
	};
	// Quiet path: one change, processed once 2 s later (not at 350 ms).
	scheduler.queue({ path: "quiet.md", reason: "modify" });
	await step(1_900);
	assert.equal(processed.length, 0);
	await step(200);
	await settle(scheduler, clock);
	assert.deepEqual(processed.map((entry) => entry.path), ["quiet.md"]);
	assert.ok(processed[0]!.at >= 2_000 && processed[0]!.at <= 2_100);
	// Noisy path: a write every second never goes quiet for 2 s, so max wait
	// (5 s after the first change) forces one coalesced admission.
	processed.length = 0;
	const start = clock.now();
	scheduler.queue({ path: "noisy.md", reason: "modify", opId: "op-0" });
	for (let index = 1; index < 8 && processed.length === 0; index++) {
		await step(1_000);
		if (processed.length === 0) scheduler.queue({ path: "noisy.md", reason: "modify", opId: `op-${index}` });
	}
	await settle(scheduler, clock);
	assert.equal(processed.length, 1);
	assert.equal(processed[0]!.path, "noisy.md");
	assert.ok(processed[0]!.at - start >= 5_000 && processed[0]!.at - start <= 5_100, `noisy at ${processed[0]!.at - start}`);
	scheduler.stop();
});

await s.done();
