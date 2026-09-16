import { strict as assert } from "node:assert";
import {
	FreshAdmissionDurablyPendingError,
	VaultSync,
	type BodyReceipt,
	type CandidateRecord,
	type LifecycleRequest,
	type LifecycleReceipt,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument, StoredLifecycleOperation } from "../../src/sync/vaultIndexedDb";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("active-lifecycle-replay");

function provider(): SyncProviderPort {
	const awareness = partialOf<SyncAwarenessPort>({
		setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map(),
	});
	return partialOf<SyncProviderPort>({
		awareness, ws: null, wsconnected: false, wsconnecting: false, synced: false,
		url: "ws://test/root", connect: () => {}, disconnect: () => {}, destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
}

s.test("post-persistence fault stages hand off once to active lifecycle replay", async () => {
	for (const faultStage of ["lifecycle", "candidate", "root", "cleanup"] as const) {
	const documents = new Map<string, StoredDocument>();
	const candidates = new Map<string, CandidateRecord>();
	const lifecycle = new Map<string, StoredLifecycleOperation>();
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (id) => documents.get(id) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putLifecycleOperation: async (operation) => { lifecycle.set(operation.operationId, { ...operation }); },
		listLifecycleOperations: async () => [...lifecycle.values()].map((operation) => ({ ...operation })),
		deleteLifecycleOperation: async (operationId) => {
			deleteCalls++;
			if (faultStage === "cleanup" && deleteCalls === 1) throw new Error("injected cleanup outage");
			lifecycle.delete(operationId);
		},
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	});
	let lifecycleCalls = 0;
	let candidateCalls = 0;
	let rootCalls = 0;
	let deleteCalls = 0;
	const server = partialOf<VaultServerPort>({
		commitLifecycle: async (request): Promise<LifecycleReceipt> => {
			lifecycleCalls++;
			if (faultStage === "lifecycle" && lifecycleCalls === 1) throw new Error("injected lifecycle outage");
			return {
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: request.bodyId,
				bodyEpoch: request.bodyEpoch, operationId: request.operationId, kind: request.kind,
				durableGeneration: 1, vaultSequence: lifecycleCalls, runtimeEpoch: "runtime-1",
			};
		},
		submitCandidate: async (candidate): Promise<BodyReceipt> => {
			candidateCalls++;
			if (faultStage === "candidate" && candidateCalls === 1) throw new Error("injected candidate outage");
			return {
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: candidate.bodyId,
				bodyEpoch: candidate.bodyEpoch, clientId: "device-1", candidateId: candidate.candidateId,
				candidateDigest: candidate.candidateDigest, durableGeneration: 1, runtimeEpoch: "runtime-1",
			};
		},
		publishLifecycleRoot: async (operations, _update, rootEpoch) => {
			rootCalls++;
			if (faultStage === "root" && rootCalls === 1) throw new Error("injected root publication outage");
			return {
				vaultGeneration: "generation-1", operationIds: operations.map((operation) => operation.operationId),
				vaultSequence: Math.max(...operations.map((operation) => operation.vaultSequence)),
				rootGeneration: rootCalls, rootEpoch, runtimeEpoch: "runtime-1",
			};
		},
	});
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server, providerFactory: provider,
	});
	await assert.rejects(runtime.commitFreshBody({
		bodyId: "body-1", path: "Recovered.md", content: "durable", reason: "test", candidateId: "candidate-1",
	}), FreshAdmissionDurablyPendingError);
	assert.equal(lifecycle.size, 1, "the durable lifecycle row owns recovery after handoff");
	await runtime.whenOverdueWorkIdle();
	assert.equal(lifecycle.size, 0);
	assert.equal(candidates.size, 0);
	assert.equal(runtime.getFileId("Recovered.md"), "body-1");
	assert.equal(candidateCalls, faultStage === "candidate" ? 2 : 1, `${faultStage}: candidate submissions`);
	assert.equal(rootCalls, faultStage === "root" || faultStage === "cleanup" ? 2 : 1, `${faultStage}: root publications`);
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
	let release!: (receipt: LifecycleReceipt) => void;
	let firstRequest: Parameters<NonNullable<VaultServerPort["commitLifecycle"]>>[0] | null = null;
	const blocked = new Promise<LifecycleReceipt>((resolve) => { release = resolve; });
	const firstServer = partialOf<VaultServerPort>({
		commitLifecycle: async (request) => { firstRequest = request; return blocked; },
	});
	const first = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server: firstServer, providerFactory: provider,
	});
	const initialization = first.initialize();
	await until(() => firstRequest !== null, { timeoutMs: 1_000, intervalMs: 0, message: "lifecycle replay started" });
	const destruction = first.destroy();
	const request = firstRequest as LifecycleRequest | null;
	if (!request) throw new Error("lifecycle request was not captured");
	release({
		vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: request.bodyId,
		bodyEpoch: request.bodyEpoch, operationId: request.operationId, kind: request.kind,
		durableGeneration: 1, vaultSequence: 1, runtimeEpoch: "runtime-1",
	});
	await destruction;
	await assert.rejects(initialization);
	assert.equal(lifecycle.size, 1, "teardown leaves durable replay ownership intact");
	documents.delete("root");

	const recoveryServer = partialOf<VaultServerPort>({
		commitLifecycle: async (next): Promise<LifecycleReceipt> => ({
			vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: next.bodyId,
			bodyEpoch: next.bodyEpoch, operationId: next.operationId, kind: next.kind,
			durableGeneration: 1, vaultSequence: 2, runtimeEpoch: "runtime-2",
		}),
		publishLifecycleRoot: async (operations, _update, rootEpoch) => ({
			vaultGeneration: "generation-1", operationIds: operations.map((operation) => operation.operationId),
			vaultSequence: 2, rootGeneration: 1, rootEpoch, runtimeEpoch: "runtime-2",
		}),
	});
	const recovered = await VaultSync.create({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server: recoveryServer, providerFactory: provider,
	});
	assert.equal(lifecycle.size, 0);
	await recovered.destroy();
});

await s.done();
