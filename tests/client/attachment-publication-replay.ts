import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	VaultSync,
	type AttachmentPublicationMutation,
	type AttachmentPublicationReceipt,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../src/sync/vaultSync";
import type {
	StoredAttachmentPublicationOperation,
	StoredDocument,
} from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";
import { installDomCrypto } from "./helpers/installDomCrypto";
import { partialOf } from "../mocks/productFixture.ts";

installDomCrypto();
const s = suite("attachment-publication-replay");

interface MemoryState {
	documents: Map<string, StoredDocument>;
	attachmentOperations: Map<string, StoredAttachmentPublicationOperation>;
	failRootWrites: number;
}

function createMemoryState(): MemoryState {
	return {
		documents: new Map(),
		attachmentOperations: new Map(),
		failRootWrites: 0,
	};
}

function cloneDocument(document: StoredDocument): StoredDocument {
	return {
		...document,
		encodedState: document.encodedState.slice(0),
	};
}

function memoryDatabase(state: MemoryState): VaultDatabasePort {
	return {
		getDocument: async (documentId) => {
			const document = state.documents.get(documentId);
			return document ? cloneDocument(document) : null;
		},
		putDocument: async (document) => {
			if (document.documentId === "root" && state.failRootWrites > 0) {
				state.failRootWrites--;
				throw new Error("simulated root persistence failure");
			}
			state.documents.set(document.documentId, cloneDocument(document));
		},
		putAttachmentOperation: async (operation) => {
			state.attachmentOperations.set(
				operation.mutation.operationId,
				structuredClone(operation),
			);
		},
		listAttachmentOperations: async () => Array.from(
			state.attachmentOperations.values(),
			(operation) => structuredClone(operation),
		).reverse(),
		deleteAttachmentOperation: async (operationId) => {
			state.attachmentOperations.delete(operationId);
		},
		close: async () => {},
	};
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

class AttachmentServer {
	readonly calls: AttachmentPublicationMutation[] = [];
	readonly readinessDuringPublish: boolean[] = [];
	private readonly root = new Y.Doc({ guid: "server-root" });
	private readonly receipts = new Map<string, AttachmentPublicationReceipt>();
	private rootGeneration = 0;
	private vaultSequence = 0;
	private loseResponse = false;
	private rejectBeforeApply = false;
	isClientReady: (() => boolean) | null = null;

	constructor() {
		this.root.getMap("sys").set("schemaVersion", 4);
		this.root.getMap("sys").set("protocolVersion", 1);
	}

	loseNextResponse(): void {
		this.loseResponse = true;
	}

	rejectNextBeforeApply(): void {
		this.rejectBeforeApply = true;
	}

	port(): VaultServerPort {
		return partialOf<VaultServerPort>({
			publishAttachment: async (mutation) => this.publish(mutation),
		});
	}

	private async publish(
		mutation: AttachmentPublicationMutation,
	): Promise<AttachmentPublicationReceipt> {
		this.calls.push(structuredClone(mutation));
		this.readinessDuringPublish.push(this.isClientReady?.() ?? false);
		const prior = this.receipts.get(mutation.operationId);
		if (prior) return structuredClone(prior);
		if (this.rejectBeforeApply) {
			this.rejectBeforeApply = false;
			throw new Error("simulated publication rejection");
		}

		const pathToBlob = this.root.getMap<{ hash: string; size: number }>("pathToBlob");
		const blobMeta = this.root.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta");
		const tombstones = this.root.getMap<{ deletedAt: number; previousHash?: string | null }>("blobTombstones");
		this.root.transact(() => {
			switch (mutation.kind) {
				case "upsert":
					pathToBlob.set(mutation.path, { hash: mutation.hash, size: mutation.size });
					blobMeta.set(mutation.hash, {
						size: mutation.size,
						mime: mutation.mime,
						createdAt: this.rootGeneration + 1,
					});
					tombstones.delete(mutation.path);
					break;
				case "delete": {
					const previousHash = pathToBlob.get(mutation.path)?.hash ?? null;
					pathToBlob.delete(mutation.path);
					tombstones.set(mutation.path, {
						deletedAt: this.rootGeneration + 1,
						previousHash,
					});
					break;
				}
				case "rename": {
					const ref = pathToBlob.get(mutation.fromPath);
					if (ref) pathToBlob.set(mutation.toPath, ref);
					pathToBlob.delete(mutation.fromPath);
					tombstones.delete(mutation.toPath);
					tombstones.set(mutation.fromPath, {
						deletedAt: this.rootGeneration + 1,
						previousHash: ref?.hash ?? null,
					});
					break;
				}
			}
		});
		this.rootGeneration++;
		this.vaultSequence++;
		const receipt: AttachmentPublicationReceipt = {
			operationId: mutation.operationId,
			vaultGeneration: "generation-1",
			runtimeEpoch: "runtime-1",
			vaultSequence: this.vaultSequence,
			rootGeneration: this.rootGeneration,
			rootUpdateBase64Url: bytesToBase64Url(Y.encodeStateAsUpdate(this.root)),
		};
		this.receipts.set(mutation.operationId, receipt);
		if (this.loseResponse) {
			this.loseResponse = false;
			throw new Error("simulated lost server response");
		}
		return structuredClone(receipt);
	}
}

interface RuntimeFixture {
	runtime: VaultSync;
	connectedAfterReady: boolean[];
}

async function startRuntime(state: MemoryState, server: AttachmentServer): Promise<RuntimeFixture> {
	if (!state.documents.has("root")) {
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", 4);
		root.getMap("sys").set("protocolVersion", 1);
		state.documents.set("root", {
			documentId: "root",
			generation: 1,
			encodedState: Y.encodeStateAsUpdate(root).slice().buffer,
			dirty: false,
			updatedAt: 1,
		});
		root.destroy();
	}
	const connectedAfterReady: boolean[] = [];
	let runtime!: VaultSync;
	const awareness = partialOf<SyncAwarenessPort>({
		setLocalStateField: () => {},
		destroy: () => {},
		getStates: () => new Map(),
	});
	const provider = partialOf<SyncProviderPort>({
		awareness,
		ws: null,
		wsconnected: false,
		wsconnecting: false,
		synced: false,
		url: "ws://test/root",
		connect: () => { connectedAfterReady.push(runtime.localReady); },
		disconnect: () => {},
		destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
	runtime = new VaultSync({
		vaultId: "vault-1",
		deviceId: "device-1",
		host: "https://worker.example",
		token: "token",
		database: memoryDatabase(state),
		server: server.port(),
		providerFactory: () => provider,
		now: (() => {
			let value = 100;
			return () => ++value;
		})(),
	});
	server.isClientReady = () => runtime.localReady;
	await runtime.initialize();
	return { runtime, connectedAfterReady };
}

s.test("lost response survives restart with the same operation ID and cleans up only after root persistence", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const first = await startRuntime(state, server);
	server.loseNextResponse();
	await assert.rejects(
		first.runtime.setAttachmentRef("attachments/photo.png", "a".repeat(64), 42, "image/png"),
		/lost server response/,
	);
	assert.equal(state.attachmentOperations.size, 1);
	assert.equal(first.runtime.hasPendingLocalWork, true);
	const pending = Array.from(state.attachmentOperations.values())[0]!;
	assert.deepEqual(pending.mutation, server.calls.at(-1));
	const operationId = pending.mutation.operationId;
	await first.runtime.destroy();

	const replayed = await startRuntime(state, server);
	assert.equal(server.calls.at(-1)?.operationId, operationId, "restart reuses the stable operation ID");
	assert.equal(server.readinessDuringPublish.at(-1), false, "startup replay precedes local readiness");
	assert.deepEqual(replayed.connectedAfterReady, [true], "provider connection follows replay readiness");
	assert.equal(replayed.runtime.getAttachmentRef("attachments/photo.png")?.hash, "a".repeat(64));
	assert.equal(state.attachmentOperations.size, 0, "validated receipt and persisted root remove intent");
	assert.equal(replayed.runtime.hasPendingLocalWork, false);
	await replayed.runtime.destroy();
});

s.test("root persistence failure retains the exact upsert for an in-process upload retry", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	state.failRootWrites = 1;
	await assert.rejects(
		fixture.runtime.setAttachmentRef("attachments/retry.bin", "b".repeat(64), 8, "application/octet-stream"),
		/root persistence failure/,
	);
	const pending = Array.from(state.attachmentOperations.values())[0]!;
	assert.equal(
		fixture.runtime.getAttachmentRef("attachments/retry.bin"),
		undefined,
		"pending publication cannot be mistaken for a completed catalog entry",
	);
	const operationId = pending.mutation.operationId;
	await fixture.runtime.setAttachmentRef(
		"attachments/retry.bin",
		"b".repeat(64),
		8,
		"application/octet-stream",
	);
	assert.equal(server.calls.at(-1)?.operationId, operationId, "upload retry reuses its durable operation");
	assert.equal(state.attachmentOperations.size, 0);
	await fixture.runtime.destroy();
});

s.test("delete and rename failures remain exact durable intents and replay across restart", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	let fixture = await startRuntime(state, server);
	await fixture.runtime.setAttachmentRef("attachments/old.bin", "c".repeat(64), 12, "application/octet-stream");

	server.rejectNextBeforeApply();
	await assert.rejects(fixture.runtime.deleteAttachmentRef("attachments/old.bin"), /publication rejection/);
	let pending = Array.from(state.attachmentOperations.values())[0]!;
	assert.deepEqual(pending.mutation, {
		operationId: pending.mutation.operationId,
		kind: "delete",
		path: "attachments/old.bin",
	});
	const deleteOperationId = pending.mutation.operationId;
	await fixture.runtime.destroy();
	fixture = await startRuntime(state, server);
	assert.equal(server.calls.at(-1)?.operationId, deleteOperationId);
	assert.equal(fixture.runtime.getAttachmentRef("attachments/old.bin"), undefined);
	assert.equal(fixture.runtime.isAttachmentTombstoned("attachments/old.bin"), true);
	assert.equal(state.attachmentOperations.size, 0);

	await fixture.runtime.setAttachmentRef("attachments/from.bin", "d".repeat(64), 16, "application/octet-stream");
	server.rejectNextBeforeApply();
	await assert.rejects(
		fixture.runtime.renameAttachmentRef("attachments/from.bin", "attachments/to.bin"),
		/publication rejection/,
	);
	pending = Array.from(state.attachmentOperations.values())[0]!;
	assert.deepEqual(pending.mutation, {
		operationId: pending.mutation.operationId,
		kind: "rename",
		fromPath: "attachments/from.bin",
		toPath: "attachments/to.bin",
	});
	const renameOperationId = pending.mutation.operationId;
	await fixture.runtime.destroy();
	fixture = await startRuntime(state, server);
	assert.equal(server.calls.at(-1)?.operationId, renameOperationId);
	assert.equal(fixture.runtime.getAttachmentRef("attachments/from.bin"), undefined);
	assert.equal(fixture.runtime.getAttachmentRef("attachments/to.bin")?.hash, "d".repeat(64));
	assert.equal(state.attachmentOperations.size, 0);
	await fixture.runtime.destroy();
});

s.test("startup replay uses created-at and operation-ID ordering independent of storage order", async () => {
	const state = createMemoryState();
	state.attachmentOperations.set("operation-z", {
		mutation: { operationId: "operation-z", kind: "delete", path: "attachments/order.bin" },
		createdAt: 20,
		attempts: 0,
		lastAttemptAt: null,
	});
	state.attachmentOperations.set("operation-a", {
		mutation: {
			operationId: "operation-a",
			kind: "upsert",
			path: "attachments/order.bin",
			hash: "e".repeat(64),
			size: 4,
			mime: "application/octet-stream",
		},
		createdAt: 10,
		attempts: 0,
		lastAttemptAt: null,
	});
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	assert.deepEqual(server.calls.map((call) => call.operationId), ["operation-a", "operation-z"]);
	assert.equal(fixture.runtime.isAttachmentTombstoned("attachments/order.bin"), true);
	assert.equal(state.attachmentOperations.size, 0);
	await fixture.runtime.destroy();
});

await s.done();
