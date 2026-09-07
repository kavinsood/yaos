import { strict as assert } from "node:assert";
import {
	BodyCoordinator,
	BodyProjectionOwnershipError,
} from "../../src/sync/bodyCoordinator";
import { RuntimeScope } from "../../src/runtime/operationLifecycle";
import { suite } from "../harness.ts";

const s = suite("body-coordinator");

s.test("revision tokens become stale when body state advances", () => {
	let id = 0;
	const coordinator = new BodyCoordinator(new RuntimeScope(), () => `id-${++id}`);
	const first = coordinator.capture("body");
	coordinator.advanceContent("body");
	assert.equal(coordinator.isCurrent(first), false);
	coordinator.setSynchronization("body", "locally-pending");
	assert.equal(coordinator.snapshot("body")?.synchronization, "locally-pending");
});

s.test("projection ownership is exclusive across domains and shared by editor consumers", () => {
	let id = 0;
	const coordinator = new BodyCoordinator(new RuntimeScope(), () => `id-${++id}`);
	coordinator.bindPath("note.md", "body");
	const first = coordinator.acquireProjection("note.md", "body", "editor", "leaf-a");
	const second = coordinator.acquireProjection("note.md", "body", "editor", "leaf-b");
	assert.equal(coordinator.snapshot("body")?.leaseCount, 2);
	assert.throws(
		() => coordinator.acquireProjection("note.md", "body", "disk", "write"),
		BodyProjectionOwnershipError,
	);
	first.release();
	assert.equal(coordinator.snapshot("body")?.projectionOwner, "editor");
	second.release();
	assert.equal(coordinator.snapshot("body")?.projectionOwner, null);
});

s.test("path reuse invalidates the old body's lifecycle proof and ownership", () => {
	let id = 0;
	const coordinator = new BodyCoordinator(new RuntimeScope(), () => `id-${++id}`);
	coordinator.bindPath("note.md", "old-body");
	const oldProof = coordinator.capture("old-body");
	coordinator.bindPath("note.md", "new-body");
	assert.equal(coordinator.isCurrent(oldProof), false);
	assert.equal(coordinator.isPathCurrent("note.md", "old-body"), false);
	assert.throws(
		() => coordinator.acquireProjection("note.md", "old-body", "disk", "old-write"),
		/not currently bound/,
	);
});

s.test("rename removes the old reverse binding in the same catalog transition", () => {
	const coordinator = new BodyCoordinator(new RuntimeScope());
	coordinator.bindPath("old.md", "body");
	coordinator.bindPath("new.md", "body");
	assert.equal(coordinator.isPathCurrent("old.md", "body"), false);
	assert.equal(coordinator.isPathCurrent("new.md", "body"), true);
	assert.equal(coordinator.pathForBody("body"), "new.md");
});

s.test("effect-specific proofs do not conflate content and ownership", () => {
	const coordinator = new BodyCoordinator(new RuntimeScope());
	coordinator.bindPath("note.md", "body");
	const contentProof = coordinator.capture("body");
	const editor = coordinator.acquireProjection("note.md", "body", "editor", "leaf");
	assert.equal(coordinator.isContentCurrent(contentProof), true);
	assert.equal(coordinator.isProjectionCurrent(contentProof, "note.md"), false);
	editor.release();
});

s.test("leases fence eviction and release idempotently", () => {
	const coordinator = new BodyCoordinator(new RuntimeScope(), () => crypto.randomUUID());
	const lease = coordinator.acquireLease("body");
	assert.equal(coordinator.canEvict("body"), false);
	lease.release();
	lease.release();
	assert.equal(coordinator.canEvict("body"), true);
});

s.test("quiesce invalidates every captured completion before async drain", () => {
	let id = 0;
	const scope = new RuntimeScope();
	const coordinator = new BodyCoordinator(scope, () => `id-${++id}`);
	const token = coordinator.capture("body");
	scope.stopAdmission();
	coordinator.quiesce();
	assert.equal(coordinator.isCurrent(token), false);
	assert.equal(coordinator.snapshot("body")?.lifetime, "quiescing");
	assert.throws(() => coordinator.acquireLease("new"), /not accepting/);
});

await s.done();
