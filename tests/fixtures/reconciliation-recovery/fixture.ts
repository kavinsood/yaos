import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { serialize, deserialize } from "node:v8";
import * as Y from "yjs";
import { TFile } from "obsidian";
import type { VaultAuthorityIdentity } from "../../../src/collaboration/authority";
import { ReconciliationWorker } from "../../../src/runtime/reconciliationWorker";
import { ReconciliationController } from "../../../src/runtime/reconciliationController";
import type { DiskIngestPort } from "../../../src/runtime/engineControlPort";
import { BodySettlementRepository, type BodySettlementStore, type StoredBodySettlement } from "../../../src/sync/bodySettlement";
import { ConflictEpisodes, type ConflictEpisodeState } from "../../../src/sync/conflictEpisodes";
import { DiskMirror } from "../../../src/sync/diskMirror";
import { contentBaselineHash, setCurrentContentHash, type DiskIndex } from "../../../src/sync/diskIndex";
import type { EditorBindingManager } from "../../../src/sync/editorBinding";
import { SCHEMA_VERSION, PROTOCOL_VERSION } from "../../../src/sync/schema";
import { VaultSync, type CandidateRecord, type BodyReceipt, type SyncProviderPort, type VaultDatabasePort, type VaultServerPort } from "../../../src/sync/vaultSync";
import type { StoredDocument } from "../../../src/sync/vaultIndexedDb";
import { partialOf } from "../../mocks/productFixture.ts";
import { installDomCrypto } from "../../client/helpers/installDomCrypto.ts";

installDomCrypto();
if (typeof window === "undefined") Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

export const NOTE_PATH = "Recovery.md";
export const BODY_ID = "recovery-body";
export const VAULT_GENERATION = "recovery-generation";
export const RECOVERY_AUTHORITY: VaultAuthorityIdentity = {
	vaultId: "recovery-vault", vaultGeneration: VAULT_GENERATION, principalId: "recovery-principal",
	membershipRevision: 1, deviceId: "recovery-device", deviceCredentialRevision: 1,
};
export type Checkpoint = (name: string) => Promise<void>;

export interface DurableState {
	documents: Record<string, StoredDocument>;
	candidates: Record<string, CandidateRecord>;
	settlements: Record<string, StoredBodySettlement>;
	episodes: ConflictEpisodeState;
}

export interface RemoteState {
	encodedState: ArrayBuffer;
	generation: number;
	receipts: Record<string, BodyReceipt>;
	attempts: string[];
}

export function durableWrite(path: string, bytes: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.pending`;
	const descriptor = openSync(temporary, "w");
	try {
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
	const directory = openSync(dirname(path), "r");
	try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function readState(root: string): DurableState {
	return deserialize(readFileSync(join(root, "database.bin"))) as DurableState;
}

export function readRemote(root: string): RemoteState {
	return deserialize(readFileSync(join(root, "remote.bin"))) as RemoteState;
}

export function decodeText(encodedState: ArrayBuffer): string {
	const document = new Y.Doc();
	try {
		Y.applyUpdate(document, new Uint8Array(encodedState));
		return document.getText("body").toString();
	} finally { document.destroy(); }
}

export function readDisk(root: string): string {
	return readFileSync(join(root, "vault", NOTE_PATH), "utf8");
}

export function editDisk(root: string, content: string): void {
	durableWrite(join(root, "vault", NOTE_PATH), content);
}

export function artifactContents(root: string): string[] {
	return readdirSync(join(root, "vault")).filter((path) => path !== NOTE_PATH && path.endsWith(".md"))
		.map((path) => readFileSync(join(root, "vault", path), "utf8"));
}

function settlementStore(state: DurableState, save: () => void, checkpoint: Checkpoint): BodySettlementStore {
	return {
		getBodySettlement: async (bodyId) => state.settlements[bodyId] ?? null,
		compareAndSwapBodySettlement: async (settlement, expectedRevision) => {
			await checkpoint("before-agreement");
			if ((state.settlements[settlement.bodyId]?.localSettlementRevision ?? null) !== expectedRevision) return false;
			state.settlements[settlement.bodyId] = settlement;
			save();
			await checkpoint("after-agreement");
			return true;
		},
		deleteBodySettlement: async (bodyId) => { delete state.settlements[bodyId]; save(); },
	};
}

export async function seedRecovery(root: string, input: { body: string; disk: string; base: string | null }): Promise<void> {
	const document = new Y.Doc({ guid: BODY_ID });
	document.getText("body").insert(0, input.body);
	const encodedState = Y.encodeStateAsUpdate(document).slice().buffer;
	document.destroy();
	const rootDocument = new Y.Doc({ guid: "root" });
	rootDocument.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
	rootDocument.getMap("sys").set("protocolVersion", PROTOCOL_VERSION);
	rootDocument.getMap("pathToId").set(NOTE_PATH, BODY_ID);
	const state: DurableState = {
		documents: {
			root: { kind: "root", documentId: "root", rootEpoch: 1, generation: 1, encodedState: Y.encodeStateAsUpdate(rootDocument).slice().buffer, dirty: false, updatedAt: 1 },
			[BODY_ID]: { kind: "body", documentId: BODY_ID, bodyEpoch: 1, generation: 2, durableBaseline: input.body, encodedState, dirty: false, updatedAt: 1 },
		},
		candidates: {}, settlements: {}, episodes: { episodes: {}, artifacts: {} },
	};
	rootDocument.destroy();
	const save = () => durableWrite(join(root, "database.bin"), serialize(state));
	const repository = new BodySettlementRepository(settlementStore(state, save, async () => {}), BodySettlementRepository.markdownScope(VAULT_GENERATION), contentBaselineHash);
	if (input.base !== null) {
		const hash = await contentBaselineHash(input.base);
		await repository.settle({ bodyId: BODY_ID, content: input.base, contentHash: hash, serverContentHash: hash,
			durableGeneration: 1, diskFingerprint: { bytes: new TextEncoder().encode(input.base).length, hash },
			pathAtSettlement: NOTE_PATH, expectedLocalSettlementRevision: null, settledAt: 1 });
	}
	save();
	durableWrite(join(root, "remote.bin"), serialize({ encodedState, generation: 2, receipts: {}, attempts: [] } satisfies RemoteState));
	editDisk(root, input.disk);
}

export async function openRecovery(root: string, options: { checkpoint?: Checkpoint; raceDisk?: string; initialize?: boolean; authority?: VaultAuthorityIdentity } = {}) {
	const checkpoint = options.checkpoint ?? (async () => {});
	const state = readState(root);
	const save = () => durableWrite(join(root, "database.bin"), serialize(state));
	const repository = new BodySettlementRepository(settlementStore(state, save, checkpoint), BodySettlementRepository.markdownScope(VAULT_GENERATION), contentBaselineHash);
	const database: VaultDatabasePort = {
		getDocument: async (documentId) => state.documents[documentId] ?? null,
		putDocument: async (document) => {
			if (document.kind === "body" && document.dirty) await checkpoint("before-body-persistence");
			state.documents[document.documentId] = structuredClone(document); save();
			if (document.kind === "body" && document.dirty) await checkpoint("after-body-persistence");
		},
		putCandidate: async (candidate) => {
			await checkpoint("before-candidate-persistence");
			state.candidates[candidate.candidateId] = structuredClone(candidate); save();
			await checkpoint("after-candidate-persistence");
		},
		deleteCandidate: async (_bodyId, candidateId) => {
			await checkpoint("before-candidate-removal");
			delete state.candidates[candidateId]; save();
			await checkpoint("after-candidate-removal");
		},
		listCandidates: async () => Object.values(state.candidates),
		putAttachmentOperation: async (operation) => ({ ...operation, localSequence: operation.localSequence || 1 }),
		listAttachmentOperations: async () => [], deleteAttachmentOperation: async () => {}, close: async () => {},
	};
	const server = partialOf<VaultServerPort>({
		currentHead: async () => {
			await checkpoint("before-current-head");
			return { bodyId: BODY_ID, bodyEpoch: 1, generation: readRemote(root).generation };
		},
		currentBody: async () => {
			const remote = readRemote(root);
			return { bodyId: BODY_ID, bodyEpoch: 1, generation: remote.generation, encodedState: new Uint8Array(remote.encodedState) };
		},
		submitCandidate: async (candidate) => {
			await checkpoint("before-remote-effect");
			const remote = readRemote(root);
			remote.attempts.push(candidate.candidateId);
			let receipt = remote.receipts[candidate.candidateId];
			if (!receipt) {
				const document = new Y.Doc({ guid: BODY_ID });
				Y.applyUpdate(document, new Uint8Array(remote.encodedState));
				Y.applyUpdate(document, new Uint8Array(candidate.encodedUpdate));
				remote.encodedState = Y.encodeStateAsUpdate(document).slice().buffer;
				document.destroy();
				receipt = { vaultId: "recovery-vault", vaultGeneration: VAULT_GENERATION, bodyId: BODY_ID,
					bodyEpoch: 1, clientId: "recovery-device", candidateId: candidate.candidateId,
					candidateDigest: candidate.candidateDigest, durableGeneration: ++remote.generation, runtimeEpoch: "recovery-runtime" };
				remote.receipts[candidate.candidateId] = receipt;
			} else assert.equal(receipt.candidateDigest, candidate.candidateDigest);
			durableWrite(join(root, "remote.bin"), serialize(remote));
			await checkpoint("after-remote-effect");
			return receipt;
		},
	});
	const providerFactory = () => partialOf<SyncProviderPort>({
		awareness: { setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map() },
		documentOrigin: {}, ws: null, wsconnected: false, wsconnecting: false, synced: false,
		url: "ws://recovery.test/root", connect: () => {}, disconnect: () => {}, destroy: () => {}, on: (() => {}) as SyncProviderPort["on"],
	});
	const runtimeOptions = { vaultId: "recovery-vault", vaultGeneration: VAULT_GENERATION, deviceId: "recovery-device",
		host: "https://recovery.test", token: "token", database, server, providerFactory, getAuthority: () => options.authority ?? RECOVERY_AUTHORITY };
	const runtime = options.initialize ? await VaultSync.create(runtimeOptions) : new VaultSync(runtimeOptions);
	if (!options.initialize) Y.applyUpdate(runtime.ydoc, new Uint8Array(state.documents.root!.encodedState), "indexeddb-bootstrap");
	await runtime.bodies.load(BODY_ID);
	const files = new Map<string, TFile>();
	const getFile = (path: string): TFile | null => {
		const physicalPath = join(root, "vault", path);
		if (!existsSync(physicalPath)) return null;
		let file = files.get(path);
		if (!file) { file = new TFile(); file.path = path; files.set(path, file); }
		Object.assign(file, { stat: { ctime: 1, mtime: 1, size: readFileSync(physicalPath).length } });
		return file;
	};
	let processCalls = 0;
	let modifyCalls = 0;
	let raceDisk = options.raceDisk;
	const vault = {
		getAbstractFileByPath: getFile,
		read: async (file: TFile) => readFileSync(join(root, "vault", file.path), "utf8"),
		process: async (file: TFile, callback: (current: string) => string) => {
			await checkpoint("before-disk-effect");
			if (raceDisk !== undefined) { editDisk(root, raceDisk); raceDisk = undefined; }
			processCalls++;
			const next = callback(readFileSync(join(root, "vault", file.path), "utf8"));
			durableWrite(join(root, "vault", file.path), next);
			await checkpoint("after-disk-effect");
			return next;
		},
		modify: async () => { modifyCalls++; throw new Error("Vault.modify must not bypass exact CAS"); },
		create: async (path: string, content: string) => {
			assert.equal(existsSync(join(root, "vault", path)), false);
			durableWrite(join(root, "vault", path), content); return getFile(path)!;
		},
		createFolder: async (path: string) => { mkdirSync(join(root, "vault", path), { recursive: true }); },
		adapter: {
			exists: async (path: string) => existsSync(join(root, "vault", path)),
			stat: async (path: string) => ({ mtime: 2, size: readFileSync(join(root, "vault", path)).length }),
		},
	};
	const episodes = new ConflictEpisodes(structuredClone(state.episodes), {
		read: async (path) => existsSync(join(root, "vault", path)) ? readFileSync(join(root, "vault", path), "utf8") : null,
		write: async (path, content, expected) => {
			await checkpoint("before-artifact-effect");
			const current = existsSync(join(root, "vault", path)) ? readFileSync(join(root, "vault", path), "utf8") : null;
			assert.equal(current, expected);
			durableWrite(join(root, "vault", path), content);
			await checkpoint("after-artifact-effect");
		},
		persist: async (snapshot) => {
			await checkpoint("before-episode-persistence");
			state.episodes = snapshot; save();
			await checkpoint("after-episode-persistence");
		}, changed: () => {}, notify: () => {},
	});
	const worker = new ReconciliationWorker();
	const mirror = new DiskMirror({ vault, workspace: { getActiveViewOfType: () => null } } as never, runtime,
		partialOf<EditorBindingManager>({ isBound: () => false, getLastEditorActivityForPath: () => null }), false, undefined, () => false);
	mirror.setReconciliationWorker(worker);
	assert.equal(mirror.getReconciliationWorker(), worker);
	const commit = async (content: string, expectedContent: string, waitForReceipt = true) => (await runtime.commitBodyCandidateIfCurrent({
		bodyId: BODY_ID, path: NOTE_PATH, content, expectedContent, candidateId: crypto.randomUUID(), reason: "recovery-test", waitForReceipt,
	})).kind;
	mirror.configureSettlement({
		getBaseline: () => null, getCommonBase: (bodyId) => repository.read(bodyId), conflictEpisodes: episodes,
		commitLocalBody: (input) => commit(input.content, input.expectedBodyContent ?? runtime.bodies.get(BODY_ID)!.doc.getText("body").toString(), false),
		commitMergedBody: (input) => commit(input.mergedContent, input.expectedBodyContent, false),
	});
	let agreementWork: Promise<unknown> = Promise.resolve();
	mirror.setDiskWriteCallback((_path, hash, content) => {
		agreementWork = agreementWork.then(async () => {
			const current = await repository.read(BODY_ID);
			return repository.settle({ bodyId: BODY_ID, content, contentHash: hash, serverContentHash: hash,
				durableGeneration: runtime.bodies.get(BODY_ID)!.generation,
				diskFingerprint: { bytes: new TextEncoder().encode(content).length, hash }, pathAtSettlement: NOTE_PATH,
				expectedLocalSettlementRevision: current.kind === "available" ? current.settlement.localSettlementRevision : null, settledAt: Date.now() });
		});
	});
	let diskIndex: DiskIndex = {};
	const initialSettlement = await repository.read(BODY_ID);
	if (initialSettlement.kind === "available") {
		const entry = { mtime: 1, size: initialSettlement.settlement.diskFingerprint.bytes };
		setCurrentContentHash(entry, initialSettlement.settlement.contentHash);
		diskIndex[NOTE_PATH] = entry;
	}
	let ingestPort: DiskIngestPort | undefined;
	const controller = new ReconciliationController({
		app: { vault, workspace: { iterateAllLeaves: () => {} } } as never, reconciliationWorker: worker,
		getSettings: () => ({ deviceName: "recovery-device" }) as never,
		getRuntimeConfig: () => ({ maxFileSizeBytes: 0, maxFileSizeKB: 0, excludePatterns: [], externalEditPolicy: "always" }) as never,
		getVaultSync: () => runtime, getDiskMirror: () => mirror, getBlobSync: () => null, getEditorBindings: () => null,
		getConflictEpisodes: () => episodes, getDiskIndex: () => diskIndex, setDiskIndex: (next) => { diskIndex = next; },
		isMarkdownPathSyncable: () => true, shouldBlockFrontmatterIngest: () => false,
		refreshServerCapabilities: async () => {}, validateOpenEditorBindings: () => {}, onReconciled: () => {},
		getAwaitingFirstProviderSyncAfterStartup: () => false, setAwaitingFirstProviderSyncAfterStartup: () => {},
		saveDiskIndex: async () => {}, refreshStatusBar: () => {}, trace: () => {}, scheduleTraceStateSnapshot: () => {}, log: () => {},
		registerDiskIngestPort: (port) => { ingestPort = port; },
	});
	return {
		runtime, mirror, repository, episodes, worker, state,
		commit,
		ingest: async () => {
			if (!ingestPort) throw new Error("controller did not register disk ingest port");
			await ingestPort.ingestDiskFileNow(NOTE_PATH, "modify");
		},
		counts: () => ({ processCalls, modifyCalls }),
		reconcile: async () => {
			const body = runtime.bodies.get(BODY_ID)!;
			const outcome = await mirror.settleBody({ path: NOTE_PATH, bodyId: BODY_ID, generation: body.generation, content: body.doc.getText("body").toString() });
			await agreementWork;
			const agreement = await repository.read(BODY_ID);
			if (outcome === "settled" && agreement.kind === "available") controller.recordProjectedDiskWrite(NOTE_PATH, agreement.settlement.contentHash, agreement.settlement.content);
			await worker.whenIdle(); return outcome;
		},
		close: async () => { await worker.whenIdle(); await runtime.destroy(); },
	};
}
