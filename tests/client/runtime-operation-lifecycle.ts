import { strict as assert } from "node:assert";
import { RuntimeScope } from "../../src/runtime/operationLifecycle";
import { suite } from "../harness.ts";

const s = suite("runtime-operation-lifecycle");

s.test("stop synchronously invalidates epochs and rejects new admission", async () => {
	const scope = new RuntimeScope();
	const epoch = scope.captureEpoch();
	const lease = scope.acquireLease("editor:note-a");
	assert.ok(epoch);
	assert.ok(lease);
	assert.equal(epoch.isCurrent(), true);

	scope.stopAdmission();
	assert.equal(epoch.isCurrent(), false);
	assert.equal(scope.captureEpoch(), null);
	assert.equal(scope.acquireLease("late"), null);
	await assert.rejects(scope.track("late", Promise.resolve()), /not accepting/);

	lease.release();
	lease.release();
	assert.equal(lease.released, true);
	assert.equal((await scope.drain(10)).completed, true);
});

s.test("bounded drain reports unfinished work and active lease labels", async () => {
	const scope = new RuntimeScope();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	void scope.track("persist-root", pending);
	const lease = scope.acquireLease("body:body-a");
	assert.ok(lease);

	const report = await scope.drain(1);
	assert.equal(report.completed, false);
	assert.deepEqual(report.unfinishedWork, ["persist-root"]);
	assert.deepEqual(report.activeLeases, ["body:body-a"]);

	release();
	lease.release();
	await pending;
	assert.equal((await scope.drain(10)).completed, true);
});

await s.done();
