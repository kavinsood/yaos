import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { decodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import {
	MAX_CANDIDATE_UPDATE_BYTES,
	MAX_CLIENT_MARKDOWN_BYTES,
	MAX_DURABLE_UPDATE_BYTES,
} from "../../server/src/shared/durableLimits";
import {
	VaultSync,
	type CandidateRecord,
	type LifecycleRequest,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
} from "../../src/sync/vaultSync";
import type { StoredDocument, StoredLifecycleOperation } from "../../src/sync/vaultIndexedDb";
import type { HttpRequest, HttpResponse } from "../../src/utils/http";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("fresh-large-http-roundtrips");

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

function response(json: unknown): HttpResponse {
	return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json, text: "" };
}

s.test("exact 5 MiB Unicode creation uses durable frames and exactly four HTTP requests", async () => {
	const prefix = "---\ntitle: 大きなノート 👩‍🚀\n---\n";
	const prefixBytes = new TextEncoder().encode(prefix).byteLength;
	const content = prefix + "x".repeat(MAX_CLIENT_MARKDOWN_BYTES - prefixBytes);
	assert.equal(new TextEncoder().encode(content).byteLength, MAX_CLIENT_MARKDOWN_BYTES);

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
		deleteLifecycleOperation: async (operationId) => { lifecycle.delete(operationId); },
		deleteLifecycleOperations: async (operationIds) => {
			for (const operationId of operationIds) lifecycle.delete(operationId);
		},
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	});

	const requests: HttpRequest[] = [];
	const request = async (input: HttpRequest): Promise<HttpResponse> => {
		requests.push(input);
		if (input.url.endsWith("/lifecycle/admissions")) {
			const operations = (JSON.parse(input.body as string) as { operations: LifecycleRequest[] }).operations;
			return response({
				receipts: operations.map((operation, index) => ({
					vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: operation.bodyId,
					bodyEpoch: operation.bodyEpoch, operationId: operation.operationId, kind: operation.kind,
					durableGeneration: 1, vaultSequence: index + 1, runtimeEpoch: "runtime-1",
				})),
				vaultSequence: operations.length, runtimeEpoch: "runtime-1",
			});
		}
		if (input.url.endsWith("/body/candidates")) {
			assert.ok((input.body as ArrayBuffer).byteLength <= 8 * 1024 * 1024,
				`candidate envelope is ${(input.body as ArrayBuffer).byteLength} bytes`);
			const envelope = decodeBinaryEnvelope(new Uint8Array(input.body as ArrayBuffer)) as {
				candidates: Array<{ bodyId: string; bodyEpoch: number; candidateId: string;
					candidateDigest: string; encodedUpdates: Uint8Array[] }>;
			};
			assert.equal(envelope.candidates.length, 1);
			const candidate = envelope.candidates[0]!;
			assert.ok(candidate.encodedUpdates.length > 1);
			assert.ok(candidate.encodedUpdates.every((update) =>
				update.byteLength > 0 && update.byteLength <= MAX_DURABLE_UPDATE_BYTES));
			assert.ok(candidate.encodedUpdates.reduce((sum, update) => sum + update.byteLength, 0)
				<= MAX_CANDIDATE_UPDATE_BYTES);
			const reconstructed = new Y.Doc();
			try {
				for (const update of candidate.encodedUpdates) Y.applyUpdate(reconstructed, update);
				assert.equal(reconstructed.getText("body").toString(), content);
			} finally {
				reconstructed.destroy();
			}
			return response({ receipts: [{
				vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: candidate.bodyId,
				bodyEpoch: candidate.bodyEpoch, clientId: "device-1", candidateId: candidate.candidateId,
				candidateDigest: candidate.candidateDigest, durableGeneration: 1, runtimeEpoch: "runtime-1",
			}], highWater: 1 });
		}
		if (input.url.endsWith("/lifecycle/publish")) {
			const envelope = decodeBinaryEnvelope(new Uint8Array(input.body as ArrayBuffer)) as {
				operations: Array<{ operationId: string; vaultSequence: number }>; rootEpoch: number;
			};
			return response({
				vaultGeneration: "generation-1",
				operationIds: envelope.operations.map((operation) => operation.operationId),
				vaultSequence: Math.max(...envelope.operations.map((operation) => operation.vaultSequence)),
				rootGeneration: 1, rootEpoch: envelope.rootEpoch, runtimeEpoch: "runtime-1",
			});
		}
		throw new Error(`unexpected request: ${input.url}`);
	};

	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, request, providerFactory: provider,
	});
	try {
		await runtime.commitFreshBodies([{
			bodyId: "body-large", path: "large.md", content, candidateId: "candidate-large", reason: "import",
		}]);
		assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
			"/vault/vault-1/lifecycle/admissions",
			"/vault/vault-1/body/candidates",
			"/vault/vault-1/lifecycle/admissions",
			"/vault/vault-1/lifecycle/publish",
		]);
		assert.equal(candidates.size, 0);
		assert.equal(lifecycle.size, 0);
	} finally {
		await runtime.destroy();
	}
});

s.test("32 ordinary notes use one four-request production HTTP batch with default residency", async () => {
	const inputs = Array.from({ length: 32 }, (_, index) => ({
		bodyId: `body-${index}`,
		path: `batch/note-${index}.md`,
		content: `# Note ${index}\n${"x".repeat(4 * 1024)}`,
		candidateId: `candidate-${index}`,
		reason: "import",
	}));
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
		deleteLifecycleOperation: async (operationId) => { lifecycle.delete(operationId); },
		deleteLifecycleOperations: async (operationIds) => {
			for (const operationId of operationIds) lifecycle.delete(operationId);
		},
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	});
	const requests: HttpRequest[] = [];
	const request = async (input: HttpRequest): Promise<HttpResponse> => {
		requests.push(input);
		if (input.url.endsWith("/lifecycle/admissions")) {
			const operations = (JSON.parse(input.body as string) as { operations: LifecycleRequest[] }).operations;
			assert.equal(operations.length, 32);
			return response({
				receipts: operations.map((operation, index) => ({
					vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: operation.bodyId,
					bodyEpoch: operation.bodyEpoch, operationId: operation.operationId, kind: operation.kind,
					durableGeneration: 1, vaultSequence: index + 1, runtimeEpoch: "runtime-1",
				})),
				vaultSequence: operations.length, runtimeEpoch: "runtime-1",
			});
		}
		if (input.url.endsWith("/body/candidates")) {
			assert.ok((input.body as ArrayBuffer).byteLength <= 8 * 1024 * 1024);
			const envelope = decodeBinaryEnvelope(new Uint8Array(input.body as ArrayBuffer)) as {
				candidates: Array<{ bodyId: string; bodyEpoch: number; candidateId: string;
					candidateDigest: string; encodedUpdates: Uint8Array[] }>;
			};
			assert.equal(envelope.candidates.length, 32);
			assert.equal(new Set(envelope.candidates.map((candidate) => candidate.bodyId)).size, 32);
			assert.ok(envelope.candidates.every((candidate) => candidate.encodedUpdates.every((update) =>
				update.byteLength > 0 && update.byteLength <= MAX_DURABLE_UPDATE_BYTES)));
			return response({
				receipts: envelope.candidates.map((candidate) => ({
					vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: candidate.bodyId,
					bodyEpoch: candidate.bodyEpoch, clientId: "device-1", candidateId: candidate.candidateId,
					candidateDigest: candidate.candidateDigest, durableGeneration: 1, runtimeEpoch: "runtime-1",
				})),
				highWater: 32,
			});
		}
		if (input.url.endsWith("/lifecycle/publish")) {
			const envelope = decodeBinaryEnvelope(new Uint8Array(input.body as ArrayBuffer)) as {
				operations: Array<{ operationId: string; vaultSequence: number }>; rootEpoch: number;
			};
			assert.equal(envelope.operations.length, 32);
			return response({
				vaultGeneration: "generation-1",
				operationIds: envelope.operations.map((operation) => operation.operationId),
				vaultSequence: Math.max(...envelope.operations.map((operation) => operation.vaultSequence)),
				rootGeneration: 1, rootEpoch: envelope.rootEpoch, runtimeEpoch: "runtime-1",
			});
		}
		throw new Error(`unexpected request: ${input.url}`);
	};
	const runtime = new VaultSync({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, request, providerFactory: provider,
	});
	try {
		const committed = await runtime.commitFreshBodies(inputs);
		assert.equal(committed.results.length, 32);
		assert.deepEqual(requests.map((entry) => new URL(entry.url).pathname), [
			"/vault/vault-1/lifecycle/admissions",
			"/vault/vault-1/body/candidates",
			"/vault/vault-1/lifecycle/admissions",
			"/vault/vault-1/lifecycle/publish",
		]);
		assert.ok(inputs.every((input) => runtime.getFileId(input.path) === input.bodyId));
		assert.equal(candidates.size, 0);
		assert.equal(lifecycle.size, 0);
	} finally {
		await runtime.destroy();
	}
});

await s.done();
