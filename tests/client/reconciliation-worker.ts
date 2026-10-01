import { strict as assert } from "node:assert";
import { ReconciliationWorker } from "../../src/runtime/reconciliationWorker";
import { planMarkdownAgreement } from "../../src/sync/markdownAgreement";
import { suite } from "../harness.ts";

const tests = suite("reconciliation-worker");

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

tests.test("all filesystem work shares one FIFO regardless of path or operation", async () => {
	const worker = new ReconciliationWorker();
	const entered = gate();
	const held = gate();
	const order: string[] = [];
	const first = worker.run(async () => {
		order.push("read-one");
		entered.release();
		await held.promise;
		order.push("read-complete");
		return "disk-content";
	});
	await entered.promise;
	const second = worker.run(async () => { order.push("write-unrelated"); return 42; });
	const third = worker.run(async () => { order.push("rename"); });
	assert.deepEqual(worker.diagnostics(), { active: 1, queued: 2 });
	await Promise.resolve();
	assert.deepEqual(order, ["read-one"]);
	held.release();
	assert.deepEqual(await Promise.all([first, second, third]), ["disk-content", 42, undefined]);
	await worker.whenIdle();
	assert.deepEqual(order, ["read-one", "read-complete", "write-unrelated", "rename"]);
	assert.deepEqual(worker.diagnostics(), { active: 0, queued: 0 });
});

tests.test("reset cancels queued work but retains running I/O ahead of the new generation", async () => {
	const worker = new ReconciliationWorker();
	const entered = gate();
	const held = gate();
	let obsoleteEntered = false;
	let replacementEntered = false;
	const running = worker.run(async () => { entered.release(); await held.promise; return "old-result"; });
	await entered.promise;
	const obsolete = worker.run(async () => { obsoleteEntered = true; return "obsolete"; });
	const cancelled = assert.rejects(obsolete, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
	worker.reset();
	await cancelled;
	const replacement = worker.run(async () => { replacementEntered = true; return "replacement"; });
	await Promise.resolve();
	assert.equal(obsoleteEntered, false);
	assert.equal(replacementEntered, false);
	assert.deepEqual(worker.diagnostics(), { active: 1, queued: 1 });
	held.release();
	assert.equal(await running, "old-result");
	assert.equal(await replacement, "replacement");
	await worker.whenIdle();
	assert.deepEqual(worker.diagnostics(), { active: 0, queued: 0 });
});

tests.test("a caller timeout never releases outstanding I/O", async () => {
	const worker = new ReconciliationWorker();
	const entered = gate();
	const held = gate();
	const timeout = gate();
	let nextEntered = false;
	const running = worker.run(async () => { entered.release(); await held.promise; return "finished"; });
	await entered.promise;
	const timed = Promise.race([running, timeout.promise.then(() => "timeout")]);
	timeout.release();
	assert.equal(await timed, "timeout");
	const next = worker.run(async () => { nextEntered = true; });
	await Promise.resolve();
	assert.equal(nextEntered, false);
	assert.deepEqual(worker.diagnostics(), { active: 1, queued: 1 });
	held.release();
	assert.equal(await running, "finished");
	await next;
	await worker.whenIdle();
	assert.equal(nextEntered, true);
});

tests.test("failure does not poison later work or retain active state", async () => {
	const worker = new ReconciliationWorker();
	const failed = worker.run(async () => { throw new Error("disk read failed"); });
	const next = worker.run(async () => "next");
	await assert.rejects(failed, /disk read failed/);
	assert.equal(await next, "next");
	await worker.whenIdle();
	assert.deepEqual(worker.diagnostics(), { active: 0, queued: 0 });
});

tests.test("a synchronous callback failure also releases the worker", async () => {
	const worker = new ReconciliationWorker();
	await assert.rejects(worker.run(() => { throw new Error("synchronous failure"); }), /synchronous failure/);
	assert.equal(await worker.run(async () => "next"), "next");
	await worker.whenIdle();
	assert.deepEqual(worker.diagnostics(), { active: 0, queued: 0 });
});

tests.test("whenIdle includes replacement work queued after reset", async () => {
	const worker = new ReconciliationWorker();
	const firstEntered = gate();
	const firstHeld = gate();
	const secondEntered = gate();
	const secondHeld = gate();
	let idle = false;
	const first = worker.run(async () => { firstEntered.release(); await firstHeld.promise; });
	await firstEntered.promise;
	const idleWait = worker.whenIdle().then(() => { idle = true; });
	worker.reset();
	const second = worker.run(async () => { secondEntered.release(); await secondHeld.promise; });
	firstHeld.release();
	await secondEntered.promise;
	assert.equal(idle, false);
	assert.deepEqual(worker.diagnostics(), { active: 1, queued: 0 });
	secondHeld.release();
	await Promise.all([first, second, idleWait]);
	assert.equal(idle, true);
});

tests.test("repeated reset only cancels queued generations", async () => {
	const worker = new ReconciliationWorker();
	const entered = gate();
	const held = gate();
	const first = worker.run(async () => { entered.release(); await held.promise; });
	await entered.promise;
	for (let generation = 0; generation < 3; generation++) {
		const obsolete = worker.run(async () => { assert.fail("obsolete generation executed"); });
		const cancelled = assert.rejects(obsolete, { name: "AbortError" });
		worker.reset();
		await cancelled;
		assert.deepEqual(worker.diagnostics(), { active: 1, queued: 0 });
	}
	held.release();
	await first;
	await worker.whenIdle();
	worker.reset();
	assert.equal(await worker.run(async () => "fresh"), "fresh");
});

tests.test("agreement planner preserves canonical equality and one-sided edits", () => {
	assert.deepEqual(planMarkdownAgreement({ local: "same\r\n", body: "same\n", base: null }), { kind: "agree" });
	assert.deepEqual(planMarkdownAgreement({ local: "base", body: "remote", base: "base" }), { kind: "project-body" });
	assert.deepEqual(planMarkdownAgreement({ local: "local", body: "base", base: "base" }), { kind: "import-local" });
	assert.deepEqual(planMarkdownAgreement({ local: "base", body: "remote", base: null, localMatchesAgreement: true }), { kind: "project-body" });
	assert.deepEqual(planMarkdownAgreement({ local: "local", body: "base", base: null, bodyMatchesAgreement: true }), { kind: "import-local" });
});

tests.test("agreement planner preserves unknown provenance and overlapping edits", () => {
	assert.deepEqual(planMarkdownAgreement({ local: "local", body: "remote", base: null }), { kind: "preserve", merge: null });
	assert.equal(planMarkdownAgreement({ local: "local\n", body: "remote\n", base: "base\n" }).kind, "preserve");
});

tests.test("agreement planner merges disjoint edits", () => {
	const plan = planMarkdownAgreement({ local: "local\nsecond\n", body: "first\nremote\n", base: "first\nsecond\n" });
	assert.equal(plan.kind, "merge");
	if (plan.kind === "merge") assert.equal(plan.merge.content, "local\nremote\n");
});

await tests.done();
