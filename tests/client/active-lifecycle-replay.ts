import { strict as assert } from "node:assert";
import {
	FreshAdmissionDurablyPendingError,
	VaultSync,
	type LifecycleBatchReceipt,
	type LifecycleRequest,
	type LifecycleReceipt,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument, StoredLifecycleOperation } from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";
import { FakeBulkCreateServer, memoryVault, testProvider } from "./helpers/fakeBulkCreateServer.ts";

installDomCrypto();
const s = suite("active-lifecycle-replay");

s.test("bulk create faults before and after commit hand off to replay under the same batch identity", async () => {
	for (const stage of ["before", "after"] as const) {
		const vault = memoryVault();
		const server = new FakeBulkCreateServer();
		server.failNext(stage);
		const runtime = new VaultSync({
			vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
			host: "https://sync.test", token: "token", database: vault.database, server: server.port(),
			providerFactory: testProvider, createCollectorDelayMs: 0,
		});
		await assert.rejects(runtime.commitFreshBody({
			bodyId: "body-1", path: "Recovered.md", content: "durable", reason: "test", candidateId: "candidate-1",
		}), FreshAdmissionDurablyPendingError);
		await runtime.whenOverdueWorkIdle();
		assert.equal(vault.lifecycle.size, 0, `${stage}: replay settles the create`);
		assert.equal(vault.candidates.size, 0, `${stage}: the create candidate settles from the bulk receipt`);
		assert.equal(runtime.getFileId("Recovered.md"), "body-1");
		assert.equal(server.calls.length, 2, `${stage}: one original request and one replay`);
		assert.equal(server.calls[1]!.batchId, server.calls[0]!.batchId, `${stage}: replay reuses the batch identity`);
		assert.equal(server.candidateCalls, 0, `${stage}: no separate candidate submission`);
		assert.equal(server.bodyText("body-1"), "durable");
		await runtime.destroy();
	}
});

s.test("teardown fences an in-flight replay and startup reconstructs it", async () => {
	const documents = new Map<string, StoredDocument>();
	const lifecycle = new Map<string, StoredLifecycleOperation>([["delete-1", {
		operationId: "delete-1", kind: "delete", bodyId: "body-1", path: "Gone.md", previousPath: null,
		bodyEpoch: 1, content: null, createdAt: 1, attempts: 0, lastAttemptAt: 0,
	}]]);
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (id) => documents.get(id) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async () => {}, deleteCandidate: async () => {}, listCandidates: async () => [],
		putLifecycleOperation: async (operation) => { lifecycle.set(operation.operationId, { ...operation }); },
		listLifecycleOperations: async () => [...lifecycle.values()].map((operation) => ({ ...operation })),
		deleteLifecycleOperation: async (operationId) => { lifecycle.delete(operationId); },
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	});
	let release!: (receipt: LifecycleBatchReceipt) => void;
	let firstRequest: LifecycleRequest | null = null;
	const blocked = new Promise<LifecycleBatchReceipt>((resolve) => { release = resolve; });
	const firstServer = partialOf<VaultServerPort>({
		commitLifecycleBatch: async (requests) => { firstRequest = requests[0] ?? null; return blocked; },
	});
	const first = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server: firstServer, providerFactory: testProvider,
	});
	const initialization = first.initialize();
	await until(() => firstRequest !== null, { timeoutMs: 1_000, intervalMs: 0, message: "lifecycle replay started" });
	const destruction = first.destroy();
	const request = firstRequest as LifecycleRequest | null;
	if (!request) throw new Error("lifecycle request was not captured");
	release({ receipts: [{
		vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: request.bodyId,
		bodyEpoch: request.bodyEpoch, operationId: request.operationId, kind: request.kind,
		durableGeneration: 1, vaultSequence: 1, runtimeEpoch: "runtime-1",
	}], vaultSequence: 1, runtimeEpoch: "runtime-1" });
	await destruction;
	await assert.rejects(initialization);
	assert.equal(lifecycle.size, 1, "teardown leaves durable replay ownership intact");
	documents.delete("root");

	const recoveryServer = partialOf<VaultServerPort>({
		commitLifecycleBatch: async (requests): Promise<LifecycleBatchReceipt> => ({
			receipts: requests.map((next): LifecycleReceipt => ({
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: next.bodyId,
				bodyEpoch: next.bodyEpoch, operationId: next.operationId, kind: next.kind,
				durableGeneration: 1, vaultSequence: 2, runtimeEpoch: "runtime-2",
			})),
			vaultSequence: 2, runtimeEpoch: "runtime-2",
		}),
		publishLifecycleRoot: async (operations, _update, rootEpoch) => ({
			vaultGeneration: "generation-1", operationIds: operations.map((operation) => operation.operationId),
			vaultSequence: 2, rootGeneration: 1, rootEpoch, runtimeEpoch: "runtime-2",
		}),
	});
	const recovered = await VaultSync.create({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server: recoveryServer, providerFactory: testProvider,
	});
	assert.equal(lifecycle.size, 0);
	await recovered.destroy();
});

s.test("partial overlap settles committed creates by candidate replay and re-files the rest", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	server.failNext("after");
	for (let attempt = 0; attempt < 20; attempt++) server.failNext("before");
	const options = {
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database,
		providerFactory: testProvider, createCollectorDelayMs: 0,
	};
	const first = new VaultSync({ ...options, server: server.port() });
	await assert.rejects(first.commitFreshBodies([
		{ bodyId: "body-a", path: "a.md", content: "alpha", candidateId: "candidate-a", reason: "import" },
	]), FreshAdmissionDurablyPendingError);
	await assert.rejects(first.commitFreshBodies([
		{ bodyId: "body-c", path: "c.md", content: "gamma", candidateId: "candidate-c", reason: "import" },
	]), FreshAdmissionDurablyPendingError);
	await first.destroy();
	assert.ok(server.bodies.has("body-a"), "the first batch committed before its response was lost");
	assert.ok(!server.bodies.has("body-c"));
	// Both creates now share a new batch identity, as after a lost-candidate rebatch.
	for (const [id, operation] of vault.lifecycle) vault.lifecycle.set(id, { ...operation, batchId: "batch-merged" });
	server.clearFailures();
	vault.documents.delete("root");
	const callsBefore = server.calls.length;
	const recovered = await VaultSync.create({ ...options, server: server.port() });
	await recovered.whenOverdueWorkIdle();
	const replays = server.calls.slice(callsBefore);
	assert.equal(replays[0]!.batchId, "batch-merged");
	assert.equal(replays[0]!.files.length, 2);
	assert.equal(replays.length, 2, "one overlapped replay and one re-filed batch for the uncommitted create");
	assert.deepEqual(replays[1]!.files.map((file) => file.path), ["c.md"]);
	assert.notEqual(replays[1]!.batchId, "batch-merged");
	assert.equal(server.candidateCalls, 1, "the committed create settles through an idempotent candidate replay");
	assert.equal(vault.lifecycle.size, 0);
	assert.equal(vault.candidates.size, 0);
	assert.equal(recovered.getFileId("a.md"), "body-a");
	assert.equal(recovered.getFileId("c.md"), "body-c");
	assert.equal(server.bodyText("body-a"), "alpha");
	assert.equal(server.bodyText("body-c"), "gamma");
	await recovered.destroy();
});

s.test("fresh import batch uses one bulk request and no candidate, lifecycle, or root publication", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database,
		server: server.port({
			submitCandidate: async () => { throw new Error("fresh import must not issue individual candidate requests"); },
			submitCandidates: async () => { throw new Error("fresh import must not issue candidate batches"); },
		}),
		providerFactory: testProvider,
	});
	const result = await runtime.commitFreshBodies([
		{ bodyId: "body-a", path: "a.md", content: "alpha", candidateId: "candidate-a", reason: "import" },
		{ bodyId: "body-b", path: "b.md", content: "beta", candidateId: "candidate-b", reason: "import" },
	]);
	assert.equal(server.calls.length, 1);
	assert.deepEqual(result.results.map((item) => item.outcome), ["created", "created"]);
	assert.equal(vault.candidates.size, 0);
	assert.equal(vault.lifecycle.size, 0);
	assert.equal(runtime.getFileId("a.md"), "body-a");
	assert.equal(runtime.getFileId("b.md"), "body-b");
	await runtime.destroy();
});

await s.done();
