import { strict as assert } from "node:assert";
import type { OperationOutcome } from "../../src/runtime/operationLifecycle";
import type { OverdueWorkClock } from "../../src/runtime/overdueWorkKernel";
import { RecoveryWorkScheduler } from "../../src/snapshots/recoveryWorkScheduler";
import { SettingsWorkScheduler } from "../../src/sync/settingsSync/workScheduler";
import { suite } from "../harness.ts";

interface TimerRecord {
	readonly id: number;
	readonly dueAt: number;
	readonly callback: () => void;
}

class FakeClock implements OverdueWorkClock {
	private time = 0;
	private sequence = 0;
	private readonly timers = new Map<number, TimerRecord>();

	now(): number {
		return this.time;
	}

	setTimer(callback: () => void, delayMs: number): unknown {
		const id = ++this.sequence;
		this.timers.set(id, { id, dueAt: this.time + delayMs, callback });
		if (delayMs === 0) queueMicrotask(() => this.fireDue());
		return id;
	}

	clearTimer(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(ms: number): void {
		this.time += ms;
		this.fireDue();
	}

	private fireDue(): void {
		for (const timer of [...this.timers.values()]
			.filter((entry) => entry.dueAt <= this.time)
			.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)) {
			this.timers.delete(timer.id);
			timer.callback();
		}
	}
}

const s = suite("domain-work-schedulers");

s.test("recovery work is keyed by immutable operation identity and retries failures", async () => {
	const clock = new FakeClock();
	const calls: string[] = [];
	let captureAttempts = 0;
	const scheduler = new RecoveryWorkScheduler({
		clock,
		random: { next: () => 0.5 },
		runCapture: async (captureId): Promise<OperationOutcome> => {
			calls.push(`capture:${captureId}`);
			captureAttempts++;
			return captureAttempts === 1
				? { kind: "retryable_failure", failure: "network" }
				: { kind: "completed", value: undefined };
		},
		runRestore: async (restoreId, snapshotId) => {
			calls.push(`restore:${restoreId}:${snapshotId}`);
			return { kind: "completed", value: undefined };
		},
		onError: (error) => { throw error; },
	});

	await Promise.all([
		scheduler.queueCapture("capture-1"),
		scheduler.queueCapture("capture-1"),
		scheduler.queueRestore("restore-1", "snapshot-1"),
	]);
	await scheduler.whenIdle();
	assert.deepEqual(calls, ["restore:restore-1:snapshot-1", "capture:capture-1"]);
	const retry = scheduler.diagnostics().queue.find((item) => item.key === "recovery-capture:capture-1");
	assert.equal(retry?.attempt, 1);
	assert.equal(retry?.dueAt, 5_000);

	clock.advance(5_000);
	await scheduler.whenIdle();
	assert.equal(captureAttempts, 2);
	assert.equal(scheduler.diagnostics().queue.length, 0);
	scheduler.stop();
});

s.test("settings work keeps reconcile recurrence and apply in separate collision domains", async () => {
	const clock = new FakeClock();
	const calls: string[] = [];
	let scheduler!: SettingsWorkScheduler;
	scheduler = new SettingsWorkScheduler({
		clock,
		random: { next: () => 0.5 },
		runReconcile: async () => {
			calls.push("reconcile");
			await scheduler.queueReconcile("scope-1", 2_000);
			return { kind: "completed", value: undefined };
		},
		runApply: async () => {
			calls.push("apply");
			return { kind: "completed", value: undefined };
		},
		onError: (error) => { throw error; },
	});

	await Promise.all([
		scheduler.queueReconcile("scope-1"),
		scheduler.queueReconcile("scope-1"),
		scheduler.queueApply("scope-1"),
	]);
	await scheduler.whenIdle();
	assert.deepEqual(calls, ["apply", "reconcile"]);
	assert.deepEqual(
		scheduler.diagnostics().queue.map((item) => [item.key, item.dueAt]),
		[["settings-reconcile:scope-1", 2_000]],
	);

	clock.advance(2_000);
	await scheduler.whenIdle();
	assert.deepEqual(calls, ["apply", "reconcile", "reconcile"]);
	scheduler.stop();
});

s.test("recovery cancellation can revise delayed continuation to settle immediately", async () => {
	const clock = new FakeClock();
	const captures: string[] = [];
	const scheduler = new RecoveryWorkScheduler({
		clock,
		runCapture: async (captureId) => {
			captures.push(captureId);
			return { kind: "superseded" };
		},
		runRestore: async () => ({ kind: "superseded" }),
		onError: (error) => { throw error; },
	});
	await scheduler.queueCapture("capture-cancelled", 60_000);
	assert.equal(scheduler.diagnostics().queue[0]?.dueAt, 60_000);
	await scheduler.queueCapture("capture-cancelled");
	await scheduler.whenIdle();
	assert.deepEqual(captures, ["capture-cancelled"]);
	assert.equal(scheduler.diagnostics().queue.length, 0);
	scheduler.stop();
});

await s.done();
