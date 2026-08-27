import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { BodyManager, DEFAULT_BODY_ESTIMATED_COST_BUDGET } from "../../src/sync/bodyManager";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";

const s = suite("body-manager-load-race");

function encoded(content: string): ArrayBuffer {
	const doc = new Y.Doc();
	doc.getText("body").insert(0, content);
	const bytes = Y.encodeStateAsUpdate(doc).slice().buffer;
	doc.destroy();
	return bytes;
}

s.test("late IndexedDB load returns the newer in-memory winner", async () => {
	let release!: (stored: StoredDocument | null) => void;
	const reads = new Promise<StoredDocument | null>((resolve) => { release = resolve; });
	const writes: StoredDocument[] = [];
	const manager = new BodyManager({
		getDocument: async () => reads,
		putDocument: async (document) => { writes.push(document); },
	}, () => 10);
	const loading = manager.load("body-race");
	await Promise.resolve();
	const winner = await manager.replaceFromServer("body-race", new Uint8Array(encoded("server-winner")), 5);
	release({
		documentId: "body-race",
		generation: 1,
		encodedState: encoded("stale-indexeddb"),
		dirty: false,
		pendingLocalUpdates: 0,
		updatedAt: 1,
	});
	const loaded = await loading;
	assert.equal(loaded, winner, "late load returns the body already installed in memory");
	assert.equal(manager.get("body-race"), winner);
	assert.equal(winner.doc.getText("body").toString(), "server-winner");
	assert.equal(winner.generation, 5);
	assert.equal(writes.length, 1, "stale IndexedDB load does not persist over the winner");
	await manager.destroy();
});

s.test("pin, dirty, unsettled, clean eviction, and body-local cost hooks remain explicit", async () => {
	const writes: StoredDocument[] = [];
	const changes: Array<{ bodyId: string; previousCost: number; currentCost: number }> = [];
	const manager = new BodyManager({
		getDocument: async () => null,
		putDocument: async (document) => { writes.push(document); },
	}, () => 20, {
		measure: ({ encodedBytes }) => encodedBytes * 2,
		onChange: (change) => { changes.push(change); },
	});
	const body = await manager.replaceFromServer(
		"body-state",
		new Uint8Array(encoded("costed")),
		1,
	);
	assert.equal(body.estimatedCost, writes.at(-1)!.encodedState.byteLength * 2);
	assert.equal(manager.stats().estimatedCost, body.estimatedCost);

	manager.pin(body.bodyId);
	await manager.markLocalUpdate(body.bodyId);
	manager.markUnsettled(body.bodyId);
	assert.equal(await manager.evict(body.bodyId), false, "active state fences eviction");
	assert.deepEqual(
		manager.stats(),
		{
			loaded: 1,
			dirty: 1,
			unsettled: 1,
			pendingLocalUpdates: 1,
			pinned: 1,
			estimatedCost: body.estimatedCost,
			estimatedCostLimit: DEFAULT_BODY_ESTIMATED_COST_BUDGET,
		},
	);

	await manager.markCandidateSettled(body.bodyId, 2, 1);
	manager.unpin(body.bodyId);
	assert.equal(await manager.evict(body.bodyId), true, "clean unpinned body is evictable");
	assert.equal(manager.stats().loaded, 0);
	assert.deepEqual(changes.at(-1), {
		bodyId: body.bodyId,
		previousCost: writes.at(-1)!.encodedState.byteLength * 2,
		currentCost: 0,
	});
	await manager.destroy();
});

s.test("least-recently-used eviction skips dirty and pinned bodies", async () => {
	let now = 0;
	const manager = new BodyManager({
		getDocument: async () => null,
		putDocument: async () => {},
	}, () => ++now);
	await manager.replaceFromServer("old-dirty", new Uint8Array(encoded("old")), 1);
	await manager.markDirty("old-dirty");
	await manager.replaceFromServer("new-clean", new Uint8Array(encoded("new")), 1);
	assert.deepEqual(await manager.evictLeastRecentlyUsed(0), ["new-clean"]);
	assert.ok(manager.get("old-dirty"), "dirty LRU remains resident");

	await manager.markCandidateSettled("old-dirty", 2);
	manager.pin("old-dirty");
	assert.deepEqual(await manager.evictLeastRecentlyUsed(0), []);
	manager.unpin("old-dirty");
	assert.deepEqual(await manager.evictLeastRecentlyUsed(0), ["old-dirty"]);
	await manager.destroy();
});

s.test("aggregate load admission evicts mixed-size bodies in least-recently-used order", async () => {
	let now = 0;
	const stored = new Map<string, StoredDocument>();
	for (const bodyId of ["old-large", "new-small", "incoming"]) {
		stored.set(bodyId, {
			documentId: bodyId,
			generation: 1,
			encodedState: encoded(bodyId),
			dirty: false,
			pendingLocalUpdates: 0,
			updatedAt: 1,
		});
	}
	const costs: Record<string, number> = { "old-large": 7, "new-small": 3, incoming: 7 };
	const manager = new BodyManager({
		getDocument: async (bodyId) => stored.get(bodyId) ?? null,
		putDocument: async (document) => { stored.set(document.documentId, document); },
	}, () => ++now, {
		measure: ({ bodyId }) => costs[bodyId]!,
	}, { estimatedCost: 10 });
	await manager.load("old-large");
	await manager.load("new-small");
	await manager.load("incoming");
	assert.equal(manager.get("old-large"), null);
	assert.ok(manager.get("new-small"));
	assert.ok(manager.get("incoming"));
	assert.deepEqual(manager.stats(), {
		loaded: 2,
		dirty: 0,
		unsettled: 0,
		pendingLocalUpdates: 0,
		pinned: 0,
		estimatedCost: 10,
		estimatedCostLimit: 10,
	});
	await manager.destroy();
});

s.test("dirty and pinned bodies make aggregate replacement admission refuse safely", async () => {
	const costs: Record<string, number> = { dirty: 3, pinned: 3, incoming: 1 };
	const manager = new BodyManager({
		getDocument: async () => null,
		putDocument: async () => {},
	}, Date.now, {
		measure: ({ bodyId }) => costs[bodyId]!,
	}, { estimatedCost: 6 });
	await manager.replaceFromServer("dirty", new Uint8Array(encoded("dirty")), 1);
	await manager.markLocalUpdate("dirty");
	await manager.replaceFromServer("pinned", new Uint8Array(encoded("pinned")), 1);
	manager.pin("pinned");
	await assert.rejects(
		manager.replaceFromServer("incoming", new Uint8Array(encoded("incoming")), 1),
		/body_estimated_cost_budget/,
	);
	assert.ok(manager.get("dirty"));
	assert.ok(manager.get("pinned"));
	assert.equal(manager.get("incoming"), null);
	assert.equal(manager.stats().estimatedCost, 6);
	manager.unpin("pinned");
	await manager.destroy();
});

s.test("a single over-budget body is rejected before persistence or retention", async () => {
	const writes: StoredDocument[] = [];
	const manager = new BodyManager({
		getDocument: async () => null,
		putDocument: async (document) => { writes.push(document); },
	}, Date.now, {
		measure: () => 11,
	}, { estimatedCost: 10 });
	await assert.rejects(
		manager.replaceFromServer("oversized", new Uint8Array(encoded("oversized")), 1),
		/body_estimated_cost_budget/,
	);
	assert.equal(writes.length, 0);
	assert.equal(manager.get("oversized"), null);
	assert.equal(manager.stats().estimatedCost, 0);
	assert.equal(manager.stats().estimatedCostLimit, 10);
	await manager.destroy();
});

await s.done();
