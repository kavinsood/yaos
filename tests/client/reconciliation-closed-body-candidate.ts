import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { DiskIndex } from "../../src/sync/diskIndex";
import {
	VaultSync,
	type CandidateRecord,
	type BodyReceipt,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type { StoredDocument } from "../../src/sync/vaultIndexedDb";
import type { DiskIngestPort } from "../../src/runtime/engineControlPort";
import { suite, until } from "../harness.ts";
import { partialOf } from "../mocks/productFixture.ts";
import { installDomCrypto } from "./helpers/installDomCrypto.ts";

installDomCrypto();
const s = suite("reconciliation-closed-body-candidate");

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = bytes.buffer;
	if (
		buffer instanceof ArrayBuffer
		&& bytes.byteOffset === 0
		&& bytes.byteLength === buffer.byteLength
	) return buffer;
	const owned = new Uint8Array(bytes.byteLength);
	owned.set(bytes);
	return owned.buffer;
}

s.test("a loaded but closed body submits a durable candidate before advancing its disk baseline", async () => {
	const path = "Closed.md";
	const bodyId = "body-closed";
	const documents = new Map<string, StoredDocument>();
	const candidates = new Map<string, CandidateRecord>();
	const bodyDoc = new Y.Doc({ guid: bodyId });
	bodyDoc.getText("body").insert(0, "before");
	documents.set(bodyId, {
		documentId: bodyId,
		generation: 1,
		encodedState: exactArrayBuffer(Y.encodeStateAsUpdate(bodyDoc)),
		dirty: false,
		updatedAt: 1,
	});
	bodyDoc.destroy();

	const database: VaultDatabasePort = {
		getDocument: async (documentId) => documents.get(documentId) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_candidateBodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putAttachmentOperation: async (operation) => ({ ...operation, localSequence: operation.localSequence || 1 }),
		listAttachmentOperations: async () => [],
		deleteAttachmentOperation: async () => {},
		close: async () => {},
	};

	const observed: { submitted?: CandidateRecord; submissions: CandidateRecord[] } = { submissions: [] };
	let resolveReceipt!: (receipt: BodyReceipt) => void;
	const receipt = new Promise<BodyReceipt>((resolve) => {
		resolveReceipt = resolve;
	});
	const server = partialOf<VaultServerPort>({
		currentHead: async (requestedBodyId) => ({ bodyId: requestedBodyId, generation: 1 }),
		submitCandidate: async (candidate) => {
			observed.submitted = candidate;
			observed.submissions.push(candidate);
			if (observed.submissions.length === 1) return receipt;
			return {
				vaultId: "vault-1",
				vaultGeneration: "generation-1",
				bodyId: candidate.bodyId,
				clientId: "device-1",
				candidateId: candidate.candidateId,
				candidateDigest: candidate.candidateDigest,
				durableGeneration: 3,
				runtimeEpoch: "epoch-1",
			};
		},
	});
	const awareness = partialOf<SyncAwarenessPort>({
		setLocalStateField: () => {},
		destroy: () => {},
		getStates: () => new Map(),
	});
	const provider = partialOf<SyncProviderPort>({
		awareness,
		documentOrigin: {},
		ws: null,
		wsconnected: false,
		wsconnecting: false,
		synced: false,
		url: "ws://test/root",
		connect: () => {},
		disconnect: () => {},
		destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
	const runtime = new VaultSync({
		vaultId: "vault-1",
		vaultGeneration: "generation-1",
		deviceId: "device-1",
		host: "https://sync.test",
		token: "token",
		database,
		server,
		providerFactory: () => provider,
	});
	runtime.ydoc.transact(() => runtime.pathToId.set(path, bodyId), "indexeddb-bootstrap");
	await runtime.bodies.load(bodyId);
	assert.equal(runtime.isBodyLoaded(bodyId), true);
	assert.equal(runtime.isBodyOpen(bodyId), false);

	const file = new TFile();
	file.path = path;
	let diskIndex: DiskIndex = {};
	let ingest: DiskIngestPort | null = null;
	new ReconciliationController({
		app: {
			vault: {
				read: async () => "after",
				getAbstractFileByPath: (requestedPath: string) => requestedPath === path ? file : null,
				adapter: { stat: async () => ({ mtime: 2, size: 5 }) },
			},
			workspace: { iterateAllLeaves: () => {} },
		} as never,
		getSettings: () => ({ deviceName: "Test device" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => runtime,
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getEditorBindings: () => null,
		getDiskIndex: () => diskIndex,
		setDiskIndex: (next) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true,
		shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {},
		validateOpenEditorBindings: () => {},
		onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false,
		setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {},
		refreshStatusBar: () => {},
		trace: () => {},
		scheduleTraceStateSnapshot: () => {},
		log: () => {},
		registerDiskIngestPort: (port) => { ingest = port; },
	});
	if (!ingest) throw new Error("disk ingest port was not registered");
	const ingestPromise = (ingest as DiskIngestPort).ingestDiskFileNow(path, "modify");
	await until(() => observed.submitted !== undefined, {
		timeoutMs: 1_000,
		intervalMs: 0,
		message: "closed-body candidate was submitted",
	});
	assert.equal(candidates.size, 1, "candidate is persisted before submission receipt");
	assert.equal(diskIndex[path], undefined, "disk baseline waits for the durable receipt");
	const candidate = observed.submitted;
	if (!candidate) throw new Error("candidate submission was not observed");
	resolveReceipt({
		vaultId: "vault-1",
		vaultGeneration: "generation-1",
		bodyId,
		clientId: "device-1",
		candidateId: candidate.candidateId,
		candidateDigest: candidate.candidateDigest,
		durableGeneration: 2,
		runtimeEpoch: "epoch-1",
	});
	await ingestPromise;

	assert.equal(candidates.size, 0, "validated receipt clears the persisted candidate");
	assert.equal(runtime.getPathContent(path), "after");
	assert.equal((diskIndex as DiskIndex)[path]?.size, 5, "disk baseline advances after candidate receipt");

	const beforeMerge = documents.get(bodyId)?.encodedState;
	if (!beforeMerge) throw new Error("settled body state was not persisted");
	const mergeOutcome = await runtime.commitBodyCandidateIfCurrent({
		bodyId,
		path,
		expectedContent: "after",
		content: "after + merged",
		candidateId: "merge-candidate",
		reason: "three-way-merge",
	});
	assert.equal(mergeOutcome.kind, "completed");
	const mergeCandidate = observed.submissions.at(-1);
	if (!mergeCandidate) throw new Error("merge candidate was not submitted");
	assert.ok(mergeCandidate.encodedUpdate.byteLength > 2, "safe merge submits a nonempty captured Yjs delta");
	const reconstructed = new Y.Doc({ guid: bodyId });
	Y.applyUpdate(reconstructed, new Uint8Array(beforeMerge));
	Y.applyUpdate(reconstructed, new Uint8Array(mergeCandidate.encodedUpdate));
	assert.equal(reconstructed.getText("body").toString(), "after + merged");
	reconstructed.destroy();
	await runtime.destroy();
});

await s.done();
