import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { VaultLifecycleService } from "../../server/src/vaultLifecycleService.ts";
import type { AttachmentCatalogEvent, DurableAttachmentOperation } from "../../server/src/vaultCatalogStore.ts";
import { suite } from "../harness.ts";

const s = suite("attachment-publication-cas");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const VAULT_GENERATION = "generation-attachment-cas-0001";

interface UpsertMutation {
	operationId: string;
	kind: "upsert";
	path: string;
	expectedRevision: string | null;
	hash: string;
	size: number;
	mime: string;
}

class AttachmentStore {
	readonly root = new Y.Doc({ guid: "root" });
	readonly events: AttachmentCatalogEvent[] = [];
	readonly operations = new Map<string, DurableAttachmentOperation>();
	sequence = 1;
	generation = 1;
	leaseHeld = false;
	forceBusy = false;
	failNextCommit = false;
	leaseAcquisitions = 0;
	commitCalls = 0;

	attachmentOperation(operationId: string): DurableAttachmentOperation | null {
		return this.operations.get(operationId) ?? null;
	}

	attachmentEventsForOperation(operationId: string): AttachmentCatalogEvent[] {
		return this.events.filter((event) => event.operationId === operationId);
	}

	attachmentHead(path: string): AttachmentCatalogEvent | null {
		return [...this.events].reverse().find((event) => event.path === path) ?? null;
	}

	currentSequence(): number {
		return this.sequence;
	}

	reconstructDocument(): { doc: Y.Doc; generation: number } {
		const doc = new Y.Doc({ guid: "root" });
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.root));
		return { doc, generation: this.generation };
	}

	acquireVaultMutationLease(): boolean {
		this.leaseAcquisitions++;
		if (this.forceBusy || this.leaseHeld) return false;
		this.leaseHeld = true;
		return true;
	}

	releaseVaultMutationLease(): boolean {
		const held = this.leaseHeld;
		this.leaseHeld = false;
		return held;
	}

	commitRootAttachments(
		update: Uint8Array,
		events: Array<Omit<AttachmentCatalogEvent, "sequence">>,
		operation: { operationId: string; requestDigest: string },
	): { vaultSequence: number; generation: number } {
		assert.equal(this.leaseHeld, true, "CAS commit must remain inside the mutation lease");
		this.commitCalls++;
		if (this.failNextCommit) {
			this.failNextCommit = false;
			throw new Error("injected atomic commit failure");
		}
		this.sequence++;
		this.generation++;
		Y.applyUpdate(this.root, update);
		for (const event of events) this.events.push({ ...event, sequence: this.sequence });
		this.operations.set(operation.operationId, {
			...operation,
			rootSequence: this.sequence,
			rootGeneration: this.generation,
		});
		return { vaultSequence: this.sequence, generation: this.generation };
	}

	seedActive(path: string, revision: string, hash = HASH_A, size = 1): void {
		this.root.getMap("pathToBlob").set(path, { hash, size, revision });
		this.root.getMap("blobMeta").set(hash, { size, mime: "application/octet-stream", createdAt: 1 });
		this.root.getMap("blobTombstones").delete(path);
		this.events.push({ sequence: this.sequence, path, contentHash: hash, size, mime: "application/octet-stream", lifecycle: "active", operationId: revision });
	}

	seedDeleted(path: string, revision: string, previousHash: string | null = HASH_A): void {
		this.root.getMap("pathToBlob").delete(path);
		this.root.getMap("blobTombstones").set(path, { deletedAt: 1, previousHash, revision });
		this.events.push({ sequence: this.sequence, path, contentHash: previousHash, size: previousHash ? 1 : null, mime: null, lifecycle: "deleted", operationId: revision });
	}
}

function fixture(input: { store?: AttachmentStore; hasBlob?: (hash: string) => Promise<boolean>; flush?: () => Promise<boolean> } = {}) {
	const store = input.store ?? new AttachmentStore();
	let broadcasts = 0;
	const service = new VaultLifecycleService({
		store,
		cache: { applyDurableUpdate: () => false },
		sockets: () => ({ broadcastDocumentUpdate: () => { broadcasts++; } }),
		vaultId: () => "vault-attachment-cas-0001",
		vaultGeneration: () => VAULT_GENERATION,
		runtimeEpoch: "runtime-attachment-cas-0001",
		hasBlob: input.hasBlob ?? (async () => true),
		flush: input.flush ?? (async () => true),
	} as never);
	return { store, service, broadcasts: () => broadcasts };
}

function request(mutation: unknown): Request {
	return new Request("https://internal/attachments/publish", {
		method: "POST",
		headers: { "content-type": "application/json", "x-yaos-device-id": "device-attachment-cas-0001" },
		body: JSON.stringify(mutation),
	});
}

async function publish(service: VaultLifecycleService, mutation: unknown): Promise<{ response: Response; body: Record<string, unknown> }> {
	const response = await service.publishAttachment(request(mutation));
	return { response, body: await response.json() as Record<string, unknown> };
}

function upsert(operationId: string, path: string, expectedRevision: string | null, hash = HASH_A): UpsertMutation {
	return { operationId, kind: "upsert", path, expectedRevision, hash, size: 1, mime: "application/octet-stream" };
}

s.test("strict mutation parsing rejects omitted preconditions, surplus fields, and nullable rename sources", async () => {
	const { service, store } = fixture();
	for (const mutation of [
		{ operationId: "strict-upsert", kind: "upsert", path: "a.bin", hash: HASH_A, size: 1, mime: "application/octet-stream" },
		{ ...upsert("strict-extra", "a.bin", null), extra: true },
		{ operationId: "strict-rename", kind: "rename", fromPath: "a.bin", toPath: "b.bin", expectedFromRevision: null, expectedToRevision: null },
		{ operationId: "strict-delete", kind: "delete", path: "a.bin", expectedRevision: undefined },
	]) {
		const result = await publish(service, mutation);
		assert.equal(result.response.status, 400);
		assert.equal(result.body.error, "invalid_attachment_publication");
	}
	assert.equal(store.commitCalls, 0);
});

s.test("blob existence is checked before the lease and missing bytes cannot create state", async () => {
	const { service, store } = fixture({ hasBlob: async () => false });
	const result = await publish(service, upsert("missing-blob", "missing.bin", null));
	assert.equal(result.response.status, 409);
	assert.equal(result.body.error, "attachment_blob_missing");
	assert.equal(store.leaseAcquisitions, 0);
	assert.equal(store.commitCalls, 0);
});

s.test("a committed attachment broadcasts while the hibernated root cache is unloaded", async () => {
	const { service, broadcasts } = fixture();
	const result = await publish(service, upsert("hibernated-root", "hibernated.bin", null));
	assert.equal(result.response.status, 200);
	assert.equal(broadcasts(), 1, "durable publication must wake hibernated root peers even without a loaded cache entry");
});

s.test("stale upsert and delete return bounded authoritative heads without writing", async () => {
	const store = new AttachmentStore();
	store.seedDeleted("asset.bin", "revision-delete");
	const { service } = fixture({ store });
	for (const mutation of [
		upsert("stale-upsert", "asset.bin", "revision-active"),
		{ operationId: "stale-delete", kind: "delete", path: "asset.bin", expectedRevision: "revision-active" },
	]) {
		const result = await publish(service, mutation);
		assert.equal(result.response.status, 409);
		assert.equal(result.body.error, "attachment_revision_mismatch");
		assert.equal(result.body.vaultGeneration, VAULT_GENERATION);
		assert.equal(result.body.vaultSequence, 1);
		assert.deepEqual(result.body.current, { kind: "deleted", revision: "revision-delete", previousHash: HASH_A });
		assert.equal((result.body.currentHeads as unknown[]).length, 1);
	}
	assert.equal(store.commitCalls, 0);
});

s.test("an upsert naming the tombstone revision is an explicit revival", async () => {
	const store = new AttachmentStore();
	store.seedDeleted("asset.bin", "revision-delete");
	const { service } = fixture({ store });
	const result = await publish(service, upsert("revision-revive", "asset.bin", "revision-delete", HASH_B));
	assert.equal(result.response.status, 200);
	assert.deepEqual(store.root.getMap("pathToBlob").get("asset.bin"), { hash: HASH_B, size: 1, revision: "revision-revive" });
	assert.equal(store.root.getMap("blobTombstones").has("asset.bin"), false);
});

s.test("delete of a missing path creates a revisioned tombstone", async () => {
	const { service, store } = fixture();
	const result = await publish(service, { operationId: "delete-missing", kind: "delete", path: "asset.bin", expectedRevision: null });
	assert.equal(result.response.status, 200);
	assert.deepEqual(store.root.getMap("blobTombstones").get("asset.bin"), {
		deletedAt: (store.root.getMap("blobTombstones").get("asset.bin") as { deletedAt: number }).deletedAt,
		device: "device-attachment-cas-0001",
		previousHash: null,
		revision: "delete-missing",
	});
});

s.test("rename rejects a changed target atomically", async () => {
	const store = new AttachmentStore();
	store.seedActive("from.bin", "revision-source", HASH_A);
	store.seedActive("to.bin", "revision-target", HASH_B);
	const { service } = fixture({ store });
	const result = await publish(service, {
		operationId: "rename-stale-target",
		kind: "rename",
		fromPath: "from.bin",
		toPath: "to.bin",
		expectedFromRevision: "revision-source",
		expectedToRevision: null,
	});
	assert.equal(result.response.status, 409);
	assert.equal(result.body.path, "to.bin");
	assert.equal((result.body.currentHeads as unknown[]).length, 2);
	assert.equal((store.root.getMap("pathToBlob").get("from.bin") as { revision: string }).revision, "revision-source");
	assert.equal((store.root.getMap("pathToBlob").get("to.bin") as { revision: string }).revision, "revision-target");
	assert.equal(store.commitCalls, 0);
});

s.test("two concurrent R0 writers serialize so exactly one commits", async () => {
	let arrivals = 0;
	let release!: () => void;
	const bothArrived = new Promise<void>((resolve) => { release = resolve; });
	const { service, store } = fixture({
		hasBlob: async () => {
			arrivals++;
			if (arrivals === 2) release();
			await bothArrived;
			return true;
		},
	});
	const results = await Promise.all([
		publish(service, upsert("writer-a", "race.bin", null, HASH_A)),
		publish(service, upsert("writer-b", "race.bin", null, HASH_B)),
	]);
	assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
	assert.equal(store.commitCalls, 1);
	assert.equal(store.events.filter((event) => event.path === "race.bin").length, 1);
});

s.test("same-ID concurrent requests recheck replay inside the lease", async () => {
	let arrivals = 0;
	let release!: () => void;
	const bothArrived = new Promise<void>((resolve) => { release = resolve; });
	const { service, store } = fixture({
		hasBlob: async () => {
			arrivals++;
			if (arrivals === 2) release();
			await bothArrived;
			return true;
		},
	});
	const mutation = upsert("same-operation", "same.bin", null);
	const results = await Promise.all([publish(service, mutation), publish(service, mutation)]);
	assert.deepEqual(results.map((result) => result.response.status), [200, 200]);
	assert.equal(store.commitCalls, 1);
	assert.equal(results[0]!.body.vaultSequence, results[1]!.body.vaultSequence);
});

s.test("response-loss replay succeeds only for the exact canonical mutation", async () => {
	let blobChecks = 0;
	const { service, store } = fixture({ hasBlob: async () => { blobChecks++; return true; } });
	const mutation = upsert("response-loss", "replay.bin", null);
	const committed = await publish(service, mutation);
	const replayed = await publish(service, { mime: mutation.mime, size: mutation.size, hash: mutation.hash,
		expectedRevision: mutation.expectedRevision, path: mutation.path, kind: mutation.kind, operationId: mutation.operationId });
	assert.equal(committed.response.status, 200);
	assert.equal(replayed.response.status, 200);
	assert.equal(replayed.body.vaultSequence, committed.body.vaultSequence);
	assert.equal(store.commitCalls, 1);
	assert.equal(blobChecks, 1, "exact replay does not need to recheck immutable bytes");
	const mismatch = await publish(service, { ...mutation, hash: HASH_B });
	assert.equal(mismatch.response.status, 409);
	assert.equal(mismatch.body.error, "attachment_operation_identity_mismatch");
});

s.test("event-only and ledger-only replay corruption fail closed before identity decisions", async () => {
	const eventOnly = new AttachmentStore();
	eventOnly.events.push({ sequence: 1, path: "event.bin", contentHash: HASH_A, size: 1, mime: "application/octet-stream", lifecycle: "active", operationId: "corrupt-event" });
	const eventResult = await publish(fixture({ store: eventOnly }).service, upsert("corrupt-event", "event.bin", null));
	assert.equal(eventResult.response.status, 500);
	assert.equal(eventResult.body.error, "attachment_replay_corrupt");

	const ledgerOnly = new AttachmentStore();
	ledgerOnly.operations.set("corrupt-ledger", { operationId: "corrupt-ledger", requestDigest: HASH_B, rootSequence: 1, rootGeneration: 1 });
	const ledgerResult = await publish(fixture({ store: ledgerOnly }).service, upsert("corrupt-ledger", "ledger.bin", null));
	assert.equal(ledgerResult.response.status, 500);
	assert.equal(ledgerResult.body.error, "attachment_replay_corrupt");
});

s.test("root and SQL lifecycle or content disagreement fails closed", async () => {
	for (const corrupt of [
		(store: AttachmentStore) => { store.events[0] = { ...store.events[0]!, lifecycle: "deleted" }; },
		(store: AttachmentStore) => { store.events[0] = { ...store.events[0]!, contentHash: HASH_B }; },
		(store: AttachmentStore) => { store.root.getMap("blobTombstones").set("asset.bin", { deletedAt: 1, previousHash: HASH_A, revision: "revision-active" }); },
	]) {
		const store = new AttachmentStore();
		store.seedActive("asset.bin", "revision-active");
		corrupt(store);
		const result = await publish(fixture({ store }).service, { operationId: `delete-${store.events[0]!.lifecycle}-${store.events[0]!.contentHash?.slice(0, 1)}`,
			kind: "delete", path: "asset.bin", expectedRevision: "revision-active" });
		assert.equal(result.response.status, 500);
		assert.equal(result.body.error, "attachment_catalog_root_mismatch");
		assert.equal(store.commitCalls, 0);
	}
});

s.test("a recovery-held mutation lease is retryable busy, not supersession", async () => {
	const store = new AttachmentStore();
	store.forceBusy = true;
	const result = await publish(fixture({ store }).service, upsert("busy-operation", "busy.bin", null));
	assert.equal(result.response.status, 503);
	assert.equal(result.body.error, "attachment_mutation_busy");
	assert.equal(store.commitCalls, 0);
});

s.test("commit failure leaves root, catalog, and replay ledger unchanged", async () => {
	const store = new AttachmentStore();
	store.failNextCommit = true;
	const { service } = fixture({ store });
	await assert.rejects(() => service.publishAttachment(request(upsert("rollback-operation", "rollback.bin", null))), /injected atomic commit failure/);
	assert.equal(store.root.getMap("pathToBlob").has("rollback.bin"), false);
	assert.equal(store.events.length, 0);
	assert.equal(store.operations.size, 0);
	const retry = await publish(service, upsert("rollback-operation", "rollback.bin", null));
	assert.equal(retry.response.status, 200);
	assert.equal(store.events.length, 1);
	assert.equal(store.operations.size, 1);
});

await s.done();
