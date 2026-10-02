import { strict as assert } from "node:assert";
import {
	FreshAdmissionDurablyPendingError,
	VaultMutationRequestError,
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

s.test("b3-int: a revive answered body_not_tombstoned is dropped once the body is already active at its path", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	let lifecycleCalls = 0;
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database,
		server: server.port({
			commitLifecycleBatch: async () => {
				lifecycleCalls++;
				throw new VaultMutationRequestError(409, "body_not_tombstoned", "lifecycle batch commit");
			},
		}),
		providerFactory: testProvider, createCollectorDelayMs: 0,
	});
	await runtime.commitFreshBody({ bodyId: "body-1", path: "Revived.md", content: "dirty work", reason: "test", candidateId: "candidate-1" });
	assert.equal(runtime.getFileId("Revived.md"), "body-1");

	// Live path: a second, concurrent delete-revive loses the race.
	await assert.rejects(runtime.commitLifecycle({
		operationId: "revive-live", kind: "revive", fileId: "body-1", bodyId: "body-1", bodyEpoch: 1, path: "Revived.md",
	}), VaultMutationRequestError);
	assert.equal(vault.lifecycle.has("revive-live"), false, "the losing revive is not left to replay forever");

	// Replay path (daemon restart): a stored redundant revive settles.
	const stored = (operationId: string, path: string): StoredLifecycleOperation => ({
		operationId, kind: "revive", bodyId: "body-1", path, previousPath: null,
		bodyEpoch: 1, content: null, createdAt: 1, attempts: 0, lastAttemptAt: 0,
	});
	vault.lifecycle.set("revive-stored", stored("revive-stored", "Revived.md"));
	const replay = (key: string) => (runtime as unknown as { runLifecycleReplayWork(key: string): Promise<{ kind: string }> }).runLifecycleReplayWork(key);
	assert.equal((await replay("single:revive-stored")).kind, "completed");
	assert.equal(vault.lifecycle.has("revive-stored"), false);

	// Not redundant: the root does not map that path to the body, so it stays pending.
	vault.lifecycle.set("revive-other", stored("revive-other", "Elsewhere.md"));
	assert.equal((await replay("single:revive-other")).kind, "retryable_failure");
	assert.equal(vault.lifecycle.has("revive-other"), true, "a 409 for an unmapped path is not silently dropped");
	assert.ok(lifecycleCalls >= 3);
	vault.lifecycle.delete("revive-other");
	await runtime.destroy();
});

s.test("b3-int: concurrent disk revives of one deleted note issue exactly one revive", async () => {
	const vault = memoryVault();
	const server = new FakeBulkCreateServer();
	const revives: string[] = [];
	let sequence = 1;
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database: vault.database,
		server: server.port({
			commitLifecycleBatch: async (requests): Promise<LifecycleBatchReceipt> => {
				for (const request of requests) if (request.kind === "revive") revives.push(request.operationId);
				// Hold the commit open so a second revive would overlap it.
				await new Promise((resolve) => setTimeout(resolve, 20));
				sequence++;
				return {
					receipts: requests.map((next): LifecycleReceipt => ({
						vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: next.bodyId,
						bodyEpoch: next.bodyEpoch, operationId: next.operationId, kind: next.kind,
						durableGeneration: 1, vaultSequence: sequence, runtimeEpoch: "runtime-1",
					})),
					vaultSequence: sequence, runtimeEpoch: "runtime-1",
				};
			},
			publishLifecycleRoot: async (operations, _update, rootEpoch) => ({
				vaultGeneration: "generation-1", operationIds: operations.map((operation) => operation.operationId),
				vaultSequence: sequence, rootGeneration: sequence, rootEpoch, runtimeEpoch: "runtime-1",
			}),
		}),
		providerFactory: testProvider, createCollectorDelayMs: 0,
	});
	await runtime.commitFreshBody({ bodyId: "body-1", path: "Revived.md", content: "dirty work", reason: "test", candidateId: "candidate-1" });
	await runtime.commitLifecycle({
		operationId: "delete-1", kind: "delete", fileId: "body-1", bodyId: "body-1",
		bodyEpoch: await runtime.currentBodyEpoch("body-1"), path: "Revived.md",
	});
	assert.equal(runtime.getFileId("Revived.md") ?? null, null);

	// Two delete-revive paths (e.g. restart reconcile and the remote-delete
	// observer) bring the dirty note back at the same moment.
	const revive = () => runtime.commitDiskBody({
		bodyId: "body-1", path: "Revived.md", content: "dirty work", reason: "test", lifecycle: "revive",
	});
	const results = await Promise.all([revive(), revive()]);
	assert.equal(revives.length, 1, `exactly one revive request reaches the server (got ${revives.length})`);
	assert.deepEqual(results.map((result) => result.revived), [true, true]);
	assert.equal(runtime.getFileId("Revived.md"), "body-1");
	assert.equal(vault.lifecycle.size, 0, "no revive is left to replay");
	await runtime.destroy();
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
