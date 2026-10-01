import { strict as assert } from "node:assert";
import {
	ReconciliationWorker,
	ReconciliationBackpressureError,
	ReconciliationIoTimeoutError,
	reconciliationRetainedBytes,
} from "../../src/runtime/reconciliationWorker";
import { suite, until } from "../harness.ts";

const tests = suite("reconciliation-worker-bounds");

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

tests.test("job admission is bounded without hidden enqueue waiters", async () => {
	const worker = new ReconciliationWorker({ maximumQueued: 2 });
	const held = gate();
	const running = worker.run(() => held.promise);
	const first = worker.run(async () => "first");
	const second = worker.run(async () => "second");
	for (let attempt = 0; attempt < 200; attempt++) {
		await assert.rejects(worker.run(async () => "overflow"), ReconciliationBackpressureError);
	}
	assert.deepEqual(worker.diagnostics(), { active: 1, queued: 2 });
	held.release();
	await running;
	assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
	await worker.whenIdle();
	assert.equal(worker.health().retainedBytes, 0);
});

tests.test("retained payload includes active work and cancelled jobs release accounting", async () => {
	const worker = new ReconciliationWorker({ maximumRetainedBytes: 10 });
	const held = gate();
	const running = worker.run(() => held.promise, { retainedBytes: 6 });
	const queued = worker.run(async () => undefined, { retainedBytes: 4 });
	const cancelled = assert.rejects(queued, { name: "AbortError" });
	assert.equal(worker.health().retainedBytes, 10);
	await assert.rejects(worker.run(async () => undefined, { retainedBytes: 1 }), ReconciliationBackpressureError);
	worker.reset();
	await cancelled;
	assert.equal(worker.health().retainedBytes, 6);
	held.release();
	await running;
	await worker.whenIdle();
	assert.equal(worker.health().retainedBytes, 0);
	assert.equal(reconciliationRetainedBytes("hello", null, undefined, "🌊"), 14);
});

tests.test("failed payload-bearing jobs release their references and accounting", async () => {
	const worker = new ReconciliationWorker({ maximumRetainedBytes: 10 });
	await assert.rejects(worker.run(async () => { throw new Error("failed input"); }, { retainedBytes: 10 }), /failed input/);
	await worker.whenIdle();
	assert.equal(worker.health().retainedBytes, 0);
	await worker.run(async () => undefined, { retainedBytes: 10 });
	await worker.whenIdle();
});

tests.test("filesystem timeout rejects work but retains the actual I/O fence", async () => {
	const worker = new ReconciliationWorker({ ioTimeoutMs: 15 });
	const entered = gate();
	const held = gate();
	const notifications: ReconciliationIoTimeoutError[] = [];
	worker.setStallHandler((error) => notifications.push(error));
	const running = worker.run(() => worker.io("read Note.md", async () => {
		entered.release();
		await held.promise;
		return "late bytes";
	}));
	const failedRunning = assert.rejects(running, ReconciliationIoTimeoutError);
	await entered.promise;
	let nextExecuted = false;
	const queued = worker.run(async () => { nextExecuted = true; });
	const failedQueued = assert.rejects(queued, ReconciliationIoTimeoutError);
	const idle = worker.whenIdle();
	const failedIdle = assert.rejects(idle, ReconciliationIoTimeoutError);
	await Promise.all([failedRunning, failedQueued, failedIdle]);
	assert.equal(notifications.length, 1);
	assert.equal(worker.isOperational, false);
	assert.equal(worker.health().pendingIo, 1);
	assert.equal(worker.health().idleWaiters, 0);
	assert.deepEqual(worker.diagnostics(), { active: 1, queued: 0 });
	worker.reset();
	await assert.rejects(worker.run(async () => "replacement"), ReconciliationIoTimeoutError);
	assert.equal(nextExecuted, false);
	held.release();
	await until(() => worker.health().pendingIo === 0 && worker.diagnostics().active === 0);
	assert.equal(worker.isOperational, false);
	worker.reset();
	assert.equal(await worker.run(async () => "recovered"), "recovered");
	await worker.whenIdle();
});

tests.test("timed-out calls cannot continue with another filesystem mutation", async () => {
	const worker = new ReconciliationWorker({ ioTimeoutMs: 15 });
	const held = gate();
	let wrote = false;
	const running = worker.run(async () => {
		try { await worker.io("read", () => held.promise); } catch { }
		await worker.io("write", async () => { wrote = true; });
	});
	await assert.rejects(running, ReconciliationIoTimeoutError);
	assert.equal(wrote, false);
	held.release();
	await until(() => worker.health().pendingIo === 0 && worker.diagnostics().active === 0);
	assert.equal(wrote, false);
});

tests.test("progress watchdog bounds a non-host pending callback without releasing it", async () => {
	const worker = new ReconciliationWorker({ ioTimeoutMs: 15 });
	const held = gate();
	const running = worker.run(() => held.promise, { label: "candidate persistence" });
	await assert.rejects(running, (error: unknown) => error instanceof ReconciliationIoTimeoutError && error.operation === "candidate persistence");
	worker.reset();
	assert.equal(worker.isOperational, false);
	assert.deepEqual(worker.diagnostics(), { active: 1, queued: 0 });
	held.release();
	await until(() => worker.diagnostics().active === 0);
	worker.reset();
	assert.equal(worker.isOperational, true);
});

tests.test("concurrent filesystem calls are refused rather than run outside ordering", async () => {
	const worker = new ReconciliationWorker();
	const held = gate();
	const first = worker.io("read", () => held.promise);
	await assert.rejects(worker.io("write", async () => undefined), ReconciliationBackpressureError);
	let queuedExecuted = false;
	const queued = worker.run(async () => { queuedExecuted = true; });
	assert.equal(queuedExecuted, false);
	held.release();
	await first;
	await queued;
	await worker.whenIdle();
	assert.equal(queuedExecuted, true);
});

tests.test("idle waiters are bounded and drained after completion", async () => {
	const worker = new ReconciliationWorker({ maximumQueued: 2 });
	const held = gate();
	const running = worker.run(() => held.promise);
	const first = worker.whenIdle();
	const second = worker.whenIdle();
	await assert.rejects(worker.whenIdle(), ReconciliationBackpressureError);
	held.release();
	await Promise.all([running, first, second]);
	assert.equal(worker.health().idleWaiters, 0);
});

tests.test("invalid byte budgets and limits cannot bypass admission", async () => {
	assert.throws(() => new ReconciliationWorker({ maximumQueued: 0 }), /Invalid/);
	assert.throws(() => new ReconciliationWorker({ maximumRetainedBytes: Infinity }), /Invalid/);
	assert.throws(() => new ReconciliationWorker({ ioTimeoutMs: NaN }), /Invalid/);
	const worker = new ReconciliationWorker();
	for (const retainedBytes of [-1, NaN, Infinity, 0.5]) {
		await assert.rejects(worker.run(async () => undefined, { retainedBytes }), /Invalid/);
	}
});

tests.test("late host completion cannot evade a deadline before its timer dispatches", async () => {
	let currentTime = 0;
	const worker = new ReconciliationWorker({ ioTimeoutMs: 100, monotonicNow: () => currentTime });
	await assert.rejects(worker.run(() => worker.io("blocked synchronous host", async () => {
		currentTime = 101;
		return "completed late";
	})), ReconciliationIoTimeoutError);
	await until(() => worker.diagnostics().active === 0);
	assert.equal(worker.health().pendingIo, 0);
	assert.equal(worker.isOperational, false);
});

tests.test("late callback completion is checked against monotonic progress deadline", async () => {
	let currentTime = 0;
	const worker = new ReconciliationWorker({ ioTimeoutMs: 100, monotonicNow: () => currentTime });
	await assert.rejects(worker.run(async () => {
		currentTime = 101;
		return "late callback";
	}), ReconciliationIoTimeoutError);
	await until(() => worker.diagnostics().active === 0);
	assert.equal(worker.isOperational, false);
});

tests.test("long batches use fresh host-call deadlines rather than one batch deadline", async () => {
	let currentTime = 0;
	const worker = new ReconciliationWorker({ ioTimeoutMs: 100, monotonicNow: () => currentTime });
	await worker.run(async () => {
		for (let step = 0; step < 5; step++) {
			await worker.io("batch move", async () => { currentTime += 90; });
		}
	});
	await worker.whenIdle();
	assert.equal(currentTime, 450);
	assert.equal(worker.isOperational, true);
});

tests.test("overdue synchronous preparation cannot refresh its deadline by starting a write", async () => {
	let currentTime = 0;
	let wrote = false;
	const worker = new ReconciliationWorker({ ioTimeoutMs: 100, monotonicNow: () => currentTime });
	await assert.rejects(worker.run(async () => {
		currentTime = 101;
		await worker.io("write after blocked preparation", async () => { wrote = true; });
	}), ReconciliationIoTimeoutError);
	assert.equal(wrote, false);
	await until(() => worker.diagnostics().active === 0);
});

await tests.done();
