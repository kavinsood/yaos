import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { PRODUCT_EVENT_KIND } from "../../src/observability/productEventKinds";
import { ConflictEpisodes } from "../../src/sync/conflictEpisodes";
import { DiskMirror } from "../../src/sync/diskMirror";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { ReconciliationController } from "../../src/runtime/reconciliationController";
import { contentBaselineHash, currentContentHash, setCurrentContentHash, type DiskIndex } from "../../src/sync/diskIndex";
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

async function fixture(diskContent = "before\nafter", initialBody = "before") {
	const path = "Closed.md";
	const bodyId = "body-closed";
	const documents = new Map<string, StoredDocument>();
	const candidates = new Map<string, CandidateRecord>();
	const bodyDoc = new Y.Doc({ guid: bodyId });
	bodyDoc.getText("body").insert(0, initialBody);
	documents.set(bodyId, {
		kind: "body",
		documentId: bodyId,
		bodyEpoch: 1,
		durableBaseline: initialBody,
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
		currentHead: async (requestedBodyId) => ({ bodyId: requestedBodyId, bodyEpoch: 1, generation: 1 }),
		submitCandidate: async (candidate) => {
			observed.submitted = candidate;
			observed.submissions.push(candidate);
			if (observed.submissions.length === 1) return receipt;
			return {
				vaultId: "vault-1",
				vaultGeneration: "generation-1",
				bodyId: candidate.bodyId,
				bodyEpoch: candidate.bodyEpoch,
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
	let receiptConfirmed = false;
	const artifacts = new Map<string, string>();
	const writes: string[] = [];
	const episodes = new ConflictEpisodes({ episodes: {}, artifacts: {} }, {
		read: async (requested) => artifacts.get(requested) ?? null,
		write: async (requested, content, expected) => {
			assert.equal(artifacts.get(requested) ?? null, expected);
			artifacts.set(requested, content);
		},
		persist: async () => {}, changed: () => {}, notify: () => {},
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
		onProductEvent: (event) => {
			if (event.kind !== PRODUCT_EVENT_KIND.serverReceiptConfirmed) return;
			receiptConfirmed = true;
			controller.notifyLocalWorkSettled();
		},
	});
	runtime.ydoc.transact(() => runtime.pathToId.set(path, bodyId), "indexeddb-bootstrap");
	await runtime.bodies.load(bodyId);
	assert.equal(runtime.isBodyLoaded(bodyId), true);
	assert.equal(runtime.isBodyOpen(bodyId), false);

	const file = new TFile();
	file.path = path;
	file.stat = { ctime: 1, mtime: 2, size: diskContent.length };
	const beforeHash = await contentBaselineHash(initialBody);
	const baselineEntry = { mtime: 1, size: initialBody.length };
	setCurrentContentHash(baselineEntry, beforeHash);
	let diskIndex: DiskIndex = { [path]: baselineEntry };
	let ingest: DiskIngestPort | null = null;
	const app = {
		vault: {
			read: async () => diskContent,
			getAbstractFileByPath: (requested: string) => requested === path ? file : null,
			process: async (_file: TFile, transform: (content: string) => string) => {
				diskContent = transform(diskContent);
				writes.push(diskContent);
				return diskContent;
			},
			adapter: { stat: async () => ({ mtime: 2, size: diskContent.length }) },
		},
		workspace: { iterateAllLeaves: () => {}, getActiveViewOfType: () => null },
	};
	const mirror = new DiskMirror(app as never, runtime, partialOf<EditorBindingManager>({ isBound: () => false }), false);
	mirror.configureSettlement({
		conflictEpisodes: episodes,
		getBaseline: (requested) => ({ contentHash: currentContentHash(diskIndex[requested]) ?? null, trustedWhole: true }),
		getCommonBase: async () => ({ kind: "missing" }),
		commitLocalBody: async (input) => (await runtime.commitBodyCandidateIfCurrent({
			bodyId: input.bodyId, path: input.path, content: input.content, expectedContent: input.expectedBodyContent!,
			candidateId: crypto.randomUUID(), reason: input.reason, waitForReceipt: false,
		})).kind,
	});
	const controller = new ReconciliationController({
		app: app as never,
		getConflictEpisodes: () => episodes,
		getSettings: () => ({ deviceName: "Test device" }) as never,
		getRuntimeConfig: () => ({
			maxFileSizeBytes: 0,
			maxFileSizeKB: 0,
			excludePatterns: [],
			externalEditPolicy: "always",
		}) as never,
		getVaultSync: () => runtime,
		getDiskMirror: () => mirror,
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
	mirror.setDiskWriteCallback((requested, hash, content) => controller.recordProjectedDiskWrite(requested, hash, content));
	return {
		path, bodyId, runtime, mirror, controller, documents, candidates, observed, beforeHash, resolveReceipt, episodes, artifacts, writes,
		disk: () => diskContent,
		index: () => diskIndex,
		receiptConfirmed: () => receiptConfirmed,
		ingest: () => {
			if (!ingest) throw new Error("disk ingest port was not registered");
			return (ingest as DiskIngestPort).ingestDiskFileNow(path, "modify");
		},
		destroy: async () => { mirror.destroy(); episodes.dispose(); await runtime.destroy(); },
	};
}

s.test("a loaded but closed body persists an additive candidate before ACK and advances its baseline only after acceptance", async () => {
	const subject = await fixture();
	try {
		await subject.ingest();
		await until(() => subject.observed.submitted !== undefined, { message: "closed-body candidate was submitted" });
		assert.equal(subject.candidates.size, 1, "candidate is persisted before submission receipt");
		assert.equal(currentContentHash(subject.index()[subject.path]), subject.beforeHash, "disk baseline waits for the durable receipt");
		assert.equal(subject.receiptConfirmed(), false);
		assert.equal(subject.runtime.getPathContent(subject.path), "before\nafter");
		const persisted = subject.documents.get(subject.bodyId)!;
		const pendingBody = new Y.Doc({ guid: subject.bodyId });
		try {
			Y.applyUpdate(pendingBody, new Uint8Array(persisted.encodedState));
			assert.equal(pendingBody.getText("body").toString(), "before\nafter", "locally accepted body is durable before ACK");
		} finally { pendingBody.destroy(); }
		await subject.mirror.getReconciliationWorker().whenIdle();
		assert.equal(await subject.mirror.settleBody({ path: subject.path, bodyId: subject.bodyId, generation: 1, content: "before\nafter" }), "replan");
		assert.equal(currentContentHash(subject.index()[subject.path]), subject.beforeHash);
		const candidate = subject.observed.submitted!;
		subject.resolveReceipt({
			vaultId: "vault-1", vaultGeneration: "generation-1", bodyId: subject.bodyId, bodyEpoch: 1,
			clientId: "device-1", candidateId: candidate.candidateId, candidateDigest: candidate.candidateDigest,
			durableGeneration: 2, runtimeEpoch: "epoch-1",
		});
		await until(() => subject.receiptConfirmed(), { message: "durable candidate receipt confirmed" });
		assert.equal(await subject.mirror.settleBody({ path: subject.path, bodyId: subject.bodyId, generation: 2, content: "before\nafter" }), "settled");
		const acceptedHash = await contentBaselineHash("before\nafter");
		await until(() => currentContentHash(subject.index()[subject.path]) === acceptedHash, { message: "accepted additive body establishes its disk baseline" });
		assert.equal(subject.candidates.size, 0, "validated receipt clears the persisted candidate");
		assert.equal(subject.runtime.getPathContent(subject.path), "before\nafter");
		assert.equal(subject.index()[subject.path]?.size, "before\nafter".length);
		assert.equal(currentContentHash(subject.index()[subject.path]), acceptedHash);
		const beforeMerge = subject.documents.get(subject.bodyId)?.encodedState;
		if (!beforeMerge) throw new Error("settled body state was not persisted");
		const mergeOutcome = await subject.runtime.commitBodyCandidateIfCurrent({
			bodyId: subject.bodyId, path: subject.path, expectedContent: "before\nafter", content: "before\nafter + merged",
			candidateId: "merge-candidate", reason: "three-way-merge",
		});
		assert.equal(mergeOutcome.kind, "completed");
		const mergeCandidate = subject.observed.submissions.at(-1)!;
		assert.ok(mergeCandidate.encodedUpdate.byteLength > 2, "safe merge submits a nonempty captured Yjs delta");
		const reconstructed = new Y.Doc({ guid: subject.bodyId });
		try {
			Y.applyUpdate(reconstructed, new Uint8Array(beforeMerge));
			Y.applyUpdate(reconstructed, new Uint8Array(mergeCandidate.encodedUpdate));
			assert.equal(reconstructed.getText("body").toString(), "before\nafter + merged");
		} finally { reconstructed.destroy(); }
	} finally { await subject.destroy(); }
});

s.test("a disk replacement with unknown removal ancestry explicitly preserves both inputs without publication", async () => {
	const subject = await fixture("before", "before\naccepted remote edit");
	try {
		const beforeIndex = structuredClone(subject.index());
		await subject.ingest();
		assert.equal(subject.runtime.getPathContent(subject.path), "before\naccepted remote edit");
		assert.equal(subject.disk(), "before");
		assert.equal(subject.observed.submissions.length, 0);
		assert.equal(subject.candidates.size, 0);
		assert.equal(currentContentHash(subject.index()[subject.path]), currentContentHash(beforeIndex[subject.path]), "preservation does not advance the accepted baseline");
		assert.deepEqual(subject.writes, []);
		const episode = subject.episodes.get(subject.bodyId);
		assert.ok(episode, "the removal is preserved as an explicit conflict episode, not silently ignored");
		assert.equal(subject.episodes.list().length, 1);
		for (const content of ["before", "before\naccepted remote edit"]) {
			const hash = await contentBaselineHash(content);
			assert.equal(await subject.episodes.readVersion(subject.bodyId, hash), content);
		}
		await subject.ingest();
		assert.equal(subject.episodes.list().length, 1, "repeated raw removal does not duplicate the conflict");
	} finally { await subject.destroy(); }
});

await s.done();
