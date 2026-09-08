import { strict as assert } from "node:assert";
import * as Y from "yjs";
import type { VaultAuthorityIdentity } from "../../src/collaboration/authority";
import {
	VaultSync,
	type CandidateRecord,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument, StoredLifecycleOperation } from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("authority-outcome-recovery");

const oldAuthority: VaultAuthorityIdentity = {
	vaultId: "vault-1", vaultGeneration: "generation-1", principalId: "principal-1",
	membershipRevision: 1, deviceId: "device-1", deviceCredentialRevision: 1,
};
const currentAuthority: VaultAuthorityIdentity = { ...oldAuthority, membershipRevision: 2 };

function encodedDocument(documentId: string, configure?: (doc: Y.Doc) => void): StoredDocument {
	const doc = new Y.Doc({ guid: documentId });
	if (documentId === "root") {
		doc.getMap("sys").set("schemaVersion", 8);
		doc.getMap("sys").set("protocolVersion", 4);
	}
	configure?.(doc);
	const encodedState = Y.encodeStateAsUpdate(doc).slice().buffer;
	doc.destroy();
	return { documentId, generation: 1, encodedState, dirty: true, updatedAt: 1 };
}

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

s.test("stale candidate recovery clears only an exact committed prior-authority operation", async () => {
	const candidate: CandidateRecord = {
		vaultId: "vault-1", bodyId: "body-1", candidateId: "candidate-1", candidateDigest: "a".repeat(64),
		encodedUpdate: new Uint8Array([1]).buffer, capturedAt: 1, capturedLocalUpdates: 1, authority: oldAuthority,
	};
	const documents = new Map<string, StoredDocument>([
		["root", encodedDocument("root")],
		["body-1", encodedDocument("body-1", (doc) => doc.getText("body").insert(0, "committed"))],
	]);
	const candidates = new Map([[candidate.candidateId, candidate]]);
	let submissions = 0;
	let preserved = 0;
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (id) => documents.get(id) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (record) => { candidates.set(record.candidateId, record); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	});
	const server = partialOf<VaultServerPort>({
		submitCandidate: async () => { submissions++; throw new Error("must not resubmit"); },
		committedOperationOutcome: async ({ operationId, requestDigest, authority }) => {
			assert.deepEqual(authority, oldAuthority);
			return { operationId, requestDigest, vaultSequence: 9, committed: true };
		},
	});
	const runtime = await VaultSync.create({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server, providerFactory: provider,
		getAuthority: () => currentAuthority, onAuthoritySuperseded: () => { preserved++; },
	});
	assert.equal(candidates.size, 0);
	assert.equal(submissions, 0);
	assert.equal(preserved, 0);
	await runtime.destroy();
});

s.test("stale lifecycle recovery uses the exact outcome then only publishes its root proof", async () => {
	const documents = new Map<string, StoredDocument>([["root", encodedDocument("root")]]);
	const lifecycle = new Map<string, StoredLifecycleOperation>();
	lifecycle.set("lifecycle-1", {
		operationId: "lifecycle-1", kind: "delete", bodyId: "body-1", path: "Old.md", previousPath: null,
		content: null, createdAt: 1, attempts: 1, lastAttemptAt: 1, authority: oldAuthority,
	});
	let lifecycleMutations = 0;
	let rootPublications = 0;
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (id) => documents.get(id) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async () => {}, deleteCandidate: async () => {}, listCandidates: async () => [],
		putLifecycleOperation: async (operation) => { lifecycle.set(operation.operationId, operation); },
		listLifecycleOperations: async () => [...lifecycle.values()],
		deleteLifecycleOperation: async (operationId) => { lifecycle.delete(operationId); },
		putAttachmentOperation: async (operation) => operation,
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	});
	const server = partialOf<VaultServerPort>({
		commitLifecycle: async () => { lifecycleMutations++; throw new Error("must not recommit lifecycle"); },
		committedOperationOutcome: async ({ operationId, requestDigest }) => ({ operationId, requestDigest, vaultSequence: 11, committed: true }),
		publishLifecycleRoot: async (operations) => {
			rootPublications++;
			return { operationIds: operations.map((operation) => operation.operationId), vaultGeneration: "generation-1", runtimeEpoch: "epoch-2", vaultSequence: 12, rootGeneration: 2 };
		},
	});
	const runtime = await VaultSync.create({
		vaultId: "vault-1", vaultGeneration: "generation-1", deviceId: "device-1",
		host: "https://sync.test", token: "token", database, server, providerFactory: provider,
		getAuthority: () => currentAuthority,
	});
	assert.equal(lifecycle.size, 0);
	assert.equal(lifecycleMutations, 0);
	assert.equal(rootPublications, 1);
	await runtime.destroy();
});

await s.done();
