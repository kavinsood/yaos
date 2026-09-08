import { strict as assert } from "node:assert";
import {
	YaosPublicApiService,
	YaosPublicApiStaleHandleError,
	type YaosPublicSnapshotInput,
} from "../../src/publicApi";
import { suite } from "../harness.ts";

const s = suite("public-api");

function state(path = "Notes/alpha.md", bodyId = "body-alpha"): YaosPublicSnapshotInput {
	return {
		availability: "ready",
		collaboration: {
			authorityState: "active",
			principalId: "principal-alice",
			displayName: "Alice",
			deviceId: "device-laptop",
			deviceName: "Laptop",
			role: "member",
			membershipRevision: 3,
			deviceCredentialRevision: 2,
			policyVersion: 1,
			capabilities: ["vault.content.read", "vault.content.write"],
			members: [{
				principalId: "principal-alice",
				displayName: "Alice",
				role: "member",
				state: "active",
				deviceCount: 1,
				lastSeenAt: 100,
			}],
			presence: [{
				principalId: "principal-alice",
				deviceId: "device-laptop",
				displayName: "Alice",
				deviceName: "Laptop",
			}],
			ownershipTransfers: [],
			preservedUnpublishedWork: 0,
		},
		files: [{
			path,
			bodyId,
			body: {
				contentRevision: 3,
				lifecycleRevision: 2,
				ownershipRevision: 1,
				residency: "active",
				projectionOwner: "editor",
				synchronization: "clean",
				divergence: "none",
				lifetime: "accepting",
				leaseCount: 1,
			},
			settlement: {
				state: "settled",
				durableGeneration: 4,
				localSettlementRevision: 3,
				agreement: "agreed",
				settledAt: 100,
			},
			conflicts: { preservedUnresolved: 0, frontmatterQuarantined: 0 },
		}],
		counts: {
			files: 1,
			residentBodies: 1,
			pendingSettlements: 0,
			preservedUnresolved: 0,
			frontmatterQuarantined: 0,
			semanticCanvases: 0,
			residentCanvases: 0,
			pendingCanvasOperations: 0,
			invalidCanvases: 0,
			oversizedCanvases: 0,
			conflictCanvases: 0,
			degradedCanvases: 0,
		},
	};
}

s.test("snapshots are whitelisted, deeply frozen, and independent of source mutation", () => {
	const input = state();
	const service = new YaosPublicApiService(input);
	(input.files[0]! as { path: string; body: { contentRevision: number } }).path = "mutated.md";
	(input.files[0]! as { path: string; body: { contentRevision: number } }).body.contentRevision = 99;
	const snapshot = service.api.v0.getSnapshot();
	assert.equal(snapshot.files[0]!.path, "Notes/alpha.md");
	assert.equal(snapshot.files[0]!.body.contentRevision, 3);
	assert.equal(Object.isFrozen(snapshot), true);
	assert.equal(Object.isFrozen(snapshot.files), true);
	assert.equal(Object.isFrozen(snapshot.files[0]!.body), true);
	assert.equal(Object.isFrozen(snapshot.collaboration), true);
	assert.equal(Object.isFrozen(snapshot.collaboration.members), true);
	assert.throws(() => {
		(snapshot.files[0]!.body as { contentRevision: number }).contentRevision = 100;
	}, TypeError);

	const untrusted = state() as YaosPublicSnapshotInput & { credential: string };
	untrusted.credential = "must-not-escape";
	const isolated = new YaosPublicApiService(untrusted).api.v0.getSnapshot() as unknown as Record<string, unknown>;
	assert.equal("credential" in isolated, false);
});

s.test("subscription captures an atomic snapshot and delivers monotonic revisions", () => {
	const service = new YaosPublicApiService(state());
	const seen: number[] = [];
	const subscription = service.api.v0.subscribe((event) => seen.push(event.revision));
	assert.equal(subscription.snapshot.revision, 0);
	service.publish(state("Notes/beta.md", "body-beta"));
	service.publish(state("Notes/gamma.md", "body-gamma"));
	assert.deepEqual(seen, [1, 2]);
	assert.equal(service.api.v0.getSnapshot().revision, 2);
	assert.equal(subscription.snapshot.revision, 0);
});

s.test("listener failures and reentrant unsubscribe cannot interrupt other listeners", () => {
	const service = new YaosPublicApiService(state());
	let delivered = 0;
	service.api.v0.subscribe(() => {
		throw new Error("consumer bug");
	});
	let second: ReturnType<typeof service.api.v0.subscribe> | null = null;
	service.api.v0.subscribe(() => second?.unsubscribe());
	second = service.api.v0.subscribe(() => { delivered++; });
	service.publish(state());
	assert.equal(delivered, 0);
	second.unsubscribe();
	service.api.v0.subscribe(() => { delivered++; });
	service.publish(state());
	assert.equal(delivered, 1);
});

s.test("file lookups expose only safe projected values", () => {
	const api = new YaosPublicApiService(state()).api.v0;
	assert.equal(api.getFile("Notes/alpha.md")?.bodyId, "body-alpha");
	assert.equal(api.getFileByBodyId("body-alpha")?.path, "Notes/alpha.md");
	assert.equal(api.getFile("missing.md"), null);
	assert.equal(api.getFileByBodyId("missing"), null);
	const keys = Object.keys(api.getSnapshot()).sort();
	assert.deepEqual(keys, ["apiVersion", "availability", "collaboration", "counts", "files", "revision"]);
});

s.test("a disposed plugin instance fences retained handles and stops callbacks", () => {
	const service = new YaosPublicApiService(state());
	let delivered = 0;
	const subscription = service.api.v0.subscribe(() => { delivered++; });
	service.dispose();
	subscription.unsubscribe();
	assert.equal(delivered, 0);
	for (const action of [
		() => service.api.v0.getSnapshot(),
		() => service.api.v0.getFile("Notes/alpha.md"),
		() => service.api.v0.getFileByBodyId("body-alpha"),
		() => service.api.v0.subscribe(() => undefined),
		() => service.publish(state()),
	]) {
		assert.throws(action, YaosPublicApiStaleHandleError);
	}
});

await s.done();
