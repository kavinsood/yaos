import { strict as assert } from "node:assert";
import * as Y from "yjs";
import {
	AttachmentPublicationError,
	AttachmentPublicationProofError,
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
	nextAttachmentSequence: number;
}

function createMemoryState(): MemoryState {
	return {
		documents: new Map(),
		attachmentOperations: new Map(),
		failRootWrites: 0,
		nextAttachmentSequence: 0,
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
			const stored = operation.localSequence > 0
				? operation
				: { ...operation, localSequence: ++state.nextAttachmentSequence };
			state.attachmentOperations.set(
				stored.mutation.operationId,
				structuredClone(stored),
			);
			return structuredClone(stored);
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

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(base64);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

class AttachmentServer {
	readonly calls: AttachmentPublicationMutation[] = [];
	readonly readinessDuringPublish: boolean[] = [];
	private readonly root = new Y.Doc({ guid: "server-root" });
	private readonly receipts = new Map<string, AttachmentPublicationReceipt>();
	private rootGeneration = 0;
	private vaultSequence = 0;
	private loseResponse = false;
	private rejectedAttempts = 0;
	private nextReceiptTransform: ((receipt: AttachmentPublicationReceipt) => AttachmentPublicationReceipt) | null = null;
	isClientReady: (() => boolean) | null = null;

	constructor() {
		this.root.getMap("sys").set("schemaVersion", 5);
		this.root.getMap("sys").set("protocolVersion", 1);
	}

	loseNextResponse(): void {
		this.loseResponse = true;
	}

	rejectNextBeforeApply(): void {
		this.rejectedAttempts++;
	}

	rejectNextAttempts(count: number): void {
		this.rejectedAttempts += count;
	}

	transformNextReceipt(
		transform: (receipt: AttachmentPublicationReceipt) => AttachmentPublicationReceipt,
	): void {
		this.nextReceiptTransform = transform;
	}

	remoteUpsert(path: string, hash: string, operationId: string): void {
		this.root.transact(() => {
			this.root.getMap<{ hash: string; size: number; revision: string }>("pathToBlob")
				.set(path, { hash, size: 7, revision: operationId });
			this.root.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta")
				.set(hash, { size: 7, mime: "application/octet-stream", createdAt: ++this.rootGeneration });
			this.root.getMap("blobTombstones").delete(path);
		});
		this.vaultSequence++;
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
		if (this.rejectedAttempts > 0) {
			this.rejectedAttempts--;
			throw new Error("simulated publication rejection");
		}

		const pathToBlob = this.root.getMap<{ hash: string; size: number; revision: string }>("pathToBlob");
		const blobMeta = this.root.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta");
		const tombstones = this.root.getMap<{ deletedAt: number; previousHash: string | null; revision: string }>("blobTombstones");
		const currentHead = (path: string) => {
			const ref = pathToBlob.get(path);
			if (ref) return { kind: "active" as const, revision: ref.revision, hash: ref.hash, size: ref.size };
			const tombstone = tombstones.get(path);
			if (tombstone) return {
				kind: "deleted" as const,
				revision: tombstone.revision,
				previousHash: tombstone.previousHash,
			};
			return { kind: "missing" as const, revision: null };
		};
		const checks = mutation.kind === "rename"
			? [[mutation.fromPath, mutation.expectedFromRevision], [mutation.toPath, mutation.expectedToRevision]] as const
			: [[mutation.path, mutation.expectedRevision]] as const;
		for (const [path, expected] of checks) {
			const current = currentHead(path);
			if (current.revision !== expected) {
				throw new AttachmentPublicationError(409, "attachment_revision_mismatch", {
					path,
					current,
					currentHeads: checks.map(([affected]) => ({ path: affected, head: currentHead(affected) })),
					vaultGeneration: "generation-1",
					vaultSequence: this.vaultSequence,
				});
			}
		}
		this.root.transact(() => {
			switch (mutation.kind) {
				case "upsert":
					pathToBlob.set(mutation.path, { hash: mutation.hash, size: mutation.size, revision: mutation.operationId });
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
							revision: mutation.operationId,
					});
					break;
				}
				case "rename": {
					const ref = pathToBlob.get(mutation.fromPath);
					if (ref) pathToBlob.set(mutation.toPath, { ...ref, revision: mutation.operationId });
					pathToBlob.delete(mutation.fromPath);
					tombstones.delete(mutation.toPath);
					tombstones.set(mutation.fromPath, {
						deletedAt: this.rootGeneration + 1,
						previousHash: ref?.hash ?? null,
						revision: mutation.operationId,
					});
					break;
				}
			}
		});
		this.rootGeneration++;
		this.vaultSequence++;
		const receipt: AttachmentPublicationReceipt = {
			operationId: mutation.operationId,
			outcome: "committed",
			revisions: mutation.kind === "rename"
				? [
					{ path: mutation.fromPath, revision: mutation.operationId, state: "deleted" },
					{ path: mutation.toPath, revision: mutation.operationId, state: "active" },
				]
				: [{ path: mutation.path, revision: mutation.operationId, state: mutation.kind === "delete" ? "deleted" : "active" }],
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
		const transform = this.nextReceiptTransform;
		this.nextReceiptTransform = null;
		return structuredClone(transform ? transform(receipt) : receipt);
	}
}

interface RuntimeFixture {
	runtime: VaultSync;
	connectedAfterReady: boolean[];
	reconciliations: string[][];
}

async function startRuntime(state: MemoryState, server: AttachmentServer): Promise<RuntimeFixture> {
	if (!state.documents.has("root")) {
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", 5);
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
	const reconciliations: string[][] = [];
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
		vaultGeneration: "generation-1",
		deviceId: "device-1",
		host: "https://worker.example",
		token: "token",
		database: memoryDatabase(state),
		server: server.port(),
		providerFactory: () => provider,
		onAttachmentReconciliationRequired: (paths) => { reconciliations.push([...paths]); },
		now: (() => {
			let value = 100;
			return () => ++value;
		})(),
	});
	server.isClientReady = () => runtime.localReady;
	await runtime.initialize();
	return { runtime, connectedAfterReady, reconciliations };
}

function uploadIntent(runtime: VaultSync, path: string, operationId: string = crypto.randomUUID()): {
	operationId: string;
	expectedRevision: string | null;
} {
	return { operationId, expectedRevision: runtime.getProjectedAttachmentHead(path).revision };
}

s.test("lost response survives restart with the same operation ID and cleans up only after root persistence", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const first = await startRuntime(state, server);
	server.loseNextResponse();
	assert.equal((await first.runtime.setAttachmentRef(
		"attachments/photo.png", "a".repeat(64), 42, "image/png",
		uploadIntent(first.runtime, "attachments/photo.png"),
	)).kind, "durably-pending");
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
	const retryIntent = uploadIntent(fixture.runtime, "attachments/retry.bin");
	assert.equal((await fixture.runtime.setAttachmentRef(
		"attachments/retry.bin", "b".repeat(64), 8, "application/octet-stream", retryIntent,
	)).kind, "durably-pending");
	const pending = Array.from(state.attachmentOperations.values())[0]!;
	assert.equal(
		fixture.runtime.getAttachmentRef("attachments/retry.bin")?.hash,
		"b".repeat(64),
		"observed head remains explicit even while durable cleanup is pending",
	);
	const operationId = pending.mutation.operationId;
	await fixture.runtime.setAttachmentRef(
		"attachments/retry.bin",
		"b".repeat(64),
		8,
		"application/octet-stream",
		retryIntent,
	);
	assert.equal(server.calls.at(-1)?.operationId, operationId, "upload retry reuses its durable operation");
	assert.equal(state.attachmentOperations.size, 0);
	await fixture.runtime.destroy();
});

s.test("delete and rename failures remain exact durable intents and replay across restart", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	let fixture = await startRuntime(state, server);
	await fixture.runtime.setAttachmentRef(
		"attachments/old.bin", "c".repeat(64), 12, "application/octet-stream",
		uploadIntent(fixture.runtime, "attachments/old.bin"),
	);

	server.rejectNextBeforeApply();
	assert.equal((await fixture.runtime.deleteAttachmentRef("attachments/old.bin")).kind, "durably-pending");
	let pending = Array.from(state.attachmentOperations.values())[0]!;
	assert.deepEqual(pending.mutation, {
		operationId: pending.mutation.operationId,
		kind: "delete",
		path: "attachments/old.bin",
		expectedRevision: fixture.runtime.getObservedAttachmentHead("attachments/old.bin").revision,
	});
	const deleteOperationId = pending.mutation.operationId;
	await fixture.runtime.destroy();
	fixture = await startRuntime(state, server);
	assert.equal(server.calls.at(-1)?.operationId, deleteOperationId);
	assert.equal(fixture.runtime.getAttachmentRef("attachments/old.bin"), undefined);
	assert.equal(fixture.runtime.isAttachmentTombstoned("attachments/old.bin"), true);
	assert.equal(state.attachmentOperations.size, 0);

	await fixture.runtime.setAttachmentRef(
		"attachments/from.bin", "d".repeat(64), 16, "application/octet-stream",
		uploadIntent(fixture.runtime, "attachments/from.bin"),
	);
	server.rejectNextBeforeApply();
	assert.equal((await fixture.runtime.renameAttachmentRef("attachments/from.bin", "attachments/to.bin")).kind, "durably-pending");
	pending = Array.from(state.attachmentOperations.values())[0]!;
	assert.deepEqual(pending.mutation, {
		operationId: pending.mutation.operationId,
		kind: "rename",
		fromPath: "attachments/from.bin",
		toPath: "attachments/to.bin",
		expectedFromRevision: fixture.runtime.getObservedAttachmentHead("attachments/from.bin").revision,
		expectedToRevision: null,
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

s.test("startup replay uses local sequence ordering independent of timestamps and storage order", async () => {
	const state = createMemoryState();
	state.attachmentOperations.set("operation-z", {
		vaultId: "vault-1",
		vaultGeneration: "generation-1",
		mutation: { operationId: "operation-z", kind: "delete", path: "attachments/order.bin", expectedRevision: "operation-a" },
		localSequence: 2,
		createdAt: 10,
		attempts: 0,
		lastAttemptAt: null,
	});
	state.attachmentOperations.set("operation-a", {
		vaultId: "vault-1",
		vaultGeneration: "generation-1",
		mutation: {
			operationId: "operation-a",
			kind: "upsert",
			path: "attachments/order.bin",
			expectedRevision: null,
			hash: "e".repeat(64),
			size: 4,
			mime: "application/octet-stream",
		},
		localSequence: 1,
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

s.test("a transient predecessor blocks its durable successor until causal replay succeeds", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	server.rejectNextAttempts(2);
	const path = "attachments/causal.bin";
	const firstIntent = uploadIntent(fixture.runtime, path, "operation-causal-upsert");
	assert.equal((await fixture.runtime.setAttachmentRef(
		path, "1".repeat(64), 10, "application/octet-stream", firstIntent,
	)).kind, "durably-pending");
	assert.equal((await fixture.runtime.deleteAttachmentRef(path)).kind, "durably-pending");
	assert.deepEqual(
		server.calls.map((mutation) => mutation.operationId),
		["operation-causal-upsert", "operation-causal-upsert"],
		"the delete cannot bypass the failed upsert it expects",
	);
	assert.equal(state.attachmentOperations.size, 2);
	assert.equal((await fixture.runtime.setAttachmentRef(
		path, "1".repeat(64), 10, "application/octet-stream", firstIntent,
	)).kind, "committed");
	assert.deepEqual(
		server.calls.slice(-2).map((mutation) => mutation.kind),
		["upsert", "delete"],
	);
	assert.equal(fixture.runtime.isAttachmentTombstoned(path), true);
	assert.equal(state.attachmentOperations.size, 0);
	await fixture.runtime.destroy();
});

s.test("remote supersession retires the failed operation and every dependent successor", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	const path = "attachments/superseded.bin";
	server.rejectNextBeforeApply();
	assert.equal((await fixture.runtime.setAttachmentRef(
		path,
		"2".repeat(64),
		11,
		"application/octet-stream",
		uploadIntent(fixture.runtime, path, "operation-superseded-upsert"),
	)).kind, "durably-pending");
	server.remoteUpsert(path, "3".repeat(64), "remote-revision");
	const outcome = await fixture.runtime.deleteAttachmentRef(path);
	assert.equal(outcome.kind, "superseded");
	if (outcome.kind === "superseded") assert.equal(outcome.current.revision, "remote-revision");
	assert.equal(state.attachmentOperations.size, 0, "the failed upsert and dependent delete both retire");
	assert.equal(fixture.runtime.pendingAttachmentOperations, 0);
	assert.deepEqual(
		server.calls.map((mutation) => mutation.operationId),
		["operation-superseded-upsert", "operation-superseded-upsert"],
		"the dependent delete is never silently rebased or submitted",
	);
	await Promise.resolve();
	assert.deepEqual(fixture.reconciliations, [[path]]);
	await fixture.runtime.destroy();
});

s.test("projected heads preserve object identity through arbitrary pending rename chains", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	server.rejectNextAttempts(3);
	const hash = "4".repeat(64);
	assert.equal((await fixture.runtime.setAttachmentRef(
		"attachments/a.bin", hash, 12, "application/octet-stream",
		uploadIntent(fixture.runtime, "attachments/a.bin", "operation-chain-upsert"),
	)).kind, "durably-pending");
	assert.equal((await fixture.runtime.renameAttachmentRef("attachments/a.bin", "attachments/b.bin")).kind, "durably-pending");
	assert.equal((await fixture.runtime.renameAttachmentRef("attachments/b.bin", "attachments/c.bin")).kind, "durably-pending");
	assert.equal(fixture.runtime.getProjectedAttachmentHead("attachments/a.bin").kind, "deleted");
	assert.equal(fixture.runtime.getProjectedAttachmentHead("attachments/b.bin").kind, "deleted");
	assert.deepEqual(fixture.runtime.getProjectedAttachmentHead("attachments/c.bin"), {
		kind: "active",
		revision: Array.from(state.attachmentOperations.values())
			.sort((left, right) => left.localSequence - right.localSequence)[2]!.mutation.operationId,
		hash,
		size: 12,
	});
	await fixture.runtime.destroy();
});

s.test("operation identity is exact and equal bytes with a successor ID never alias", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	const path = "attachments/identity.bin";
	const first = uploadIntent(fixture.runtime, path, "operation-identity-a");
	server.rejectNextAttempts(3);
	await fixture.runtime.setAttachmentRef(path, "5".repeat(64), 13, "application/octet-stream", first);
	await fixture.runtime.setAttachmentRef(path, "5".repeat(64), 13, "application/octet-stream", {
		operationId: "operation-identity-b",
		expectedRevision: "operation-identity-a",
	});
	assert.deepEqual(
		[...state.attachmentOperations.keys()].sort(),
		["operation-identity-a", "operation-identity-b"],
	);
	await assert.rejects(
		fixture.runtime.setAttachmentRef(path, "6".repeat(64), 13, "application/octet-stream", first),
		(error: unknown) => error instanceof AttachmentPublicationError
			&& error.code === "attachment_operation_identity_mismatch",
	);
	await fixture.runtime.destroy();
});

s.test("receipt generation and exact resulting object identity fail closed before durable cleanup", async () => {
	const generationState = createMemoryState();
	const generationServer = new AttachmentServer();
	const generationFixture = await startRuntime(generationState, generationServer);
	generationServer.transformNextReceipt((receipt) => ({ ...receipt, vaultGeneration: "wrong-generation" }));
	await assert.rejects(
		generationFixture.runtime.setAttachmentRef(
			"attachments/generation.bin", "7".repeat(64), 14, "application/octet-stream",
			uploadIntent(generationFixture.runtime, "attachments/generation.bin"),
		),
		(error: unknown) => error instanceof AttachmentPublicationProofError,
	);
	assert.equal(generationState.attachmentOperations.size, 1);
	assert.equal(generationFixture.runtime.fatalAttachmentPublications, 1);
	await generationFixture.runtime.destroy();

	const identityState = createMemoryState();
	const identityServer = new AttachmentServer();
	const identityFixture = await startRuntime(identityState, identityServer);
	identityServer.transformNextReceipt((receipt) => {
		const doc = new Y.Doc();
		Y.applyUpdate(doc, base64UrlToBytes(receipt.rootUpdateBase64Url));
		const wrongHash = "9".repeat(64);
		doc.getMap<{ hash: string; size: number; revision: string }>("pathToBlob")
			.set("attachments/result.bin", { hash: wrongHash, size: 15, revision: receipt.operationId });
		doc.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta")
			.set(wrongHash, { size: 15, mime: "application/octet-stream", createdAt: 1 });
		return { ...receipt, rootUpdateBase64Url: bytesToBase64Url(Y.encodeStateAsUpdate(doc)) };
	});
	await assert.rejects(
		identityFixture.runtime.setAttachmentRef(
			"attachments/result.bin", "8".repeat(64), 15, "application/octet-stream",
			uploadIntent(identityFixture.runtime, "attachments/result.bin"),
		),
		(error: unknown) => error instanceof AttachmentPublicationProofError,
	);
	assert.equal(identityState.attachmentOperations.size, 1);
	assert.equal(identityFixture.runtime.fatalAttachmentPublications, 1);
	await identityFixture.runtime.destroy();
});

s.test("equal content hashes remain independent across paths", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	const hash = "a".repeat(64);
	const firstPath = "attachments/equal-a.bin";
	const secondPath = "attachments/equal-b.bin";
	const renamedPath = "attachments/equal-c.bin";
	await fixture.runtime.setAttachmentRef(
		firstPath, hash, 21, "application/octet-stream", uploadIntent(fixture.runtime, firstPath),
	);
	await fixture.runtime.setAttachmentRef(
		secondPath, hash, 21, "application/octet-stream", uploadIntent(fixture.runtime, secondPath),
	);
	const secondRevision = fixture.runtime.getObservedAttachmentHead(secondPath).revision;

	assert.equal((await fixture.runtime.renameAttachmentRef(firstPath, renamedPath)).kind, "committed");
	assert.equal(fixture.runtime.getAttachmentRef(firstPath), undefined);
	assert.equal(fixture.runtime.getAttachmentRef(renamedPath)?.hash, hash);
	assert.deepEqual(fixture.runtime.getObservedAttachmentHead(secondPath), {
		kind: "active",
		revision: secondRevision,
		hash,
		size: 21,
	});

	assert.equal((await fixture.runtime.deleteAttachmentRef(renamedPath)).kind, "committed");
	assert.equal(fixture.runtime.getAttachmentRef(renamedPath), undefined);
	assert.equal(fixture.runtime.getAttachmentRef(secondPath)?.hash, hash);
	assert.equal(fixture.runtime.getObservedAttachmentHead(secondPath).revision, secondRevision);
	await fixture.runtime.destroy();
});

s.test("rename supersession reconciles both source and target paths", async () => {
	const state = createMemoryState();
	const server = new AttachmentServer();
	const fixture = await startRuntime(state, server);
	const sourcePath = "attachments/rename-source.bin";
	const targetPath = "attachments/rename-target.bin";
	await fixture.runtime.setAttachmentRef(
		sourcePath,
		"b".repeat(64),
		22,
		"application/octet-stream",
		uploadIntent(fixture.runtime, sourcePath),
	);
	server.rejectNextBeforeApply();
	assert.equal((await fixture.runtime.renameAttachmentRef(sourcePath, targetPath)).kind, "durably-pending");
	server.remoteUpsert(sourcePath, "c".repeat(64), "remote-rename-winner");

	assert.equal((await fixture.runtime.deleteAttachmentRef(targetPath)).kind, "superseded");
	await Promise.resolve();
	assert.deepEqual(
		fixture.reconciliations.map((paths) => [...paths].sort()),
		[[sourcePath, targetPath].sort()],
	);
	assert.equal(state.attachmentOperations.size, 0);
	await fixture.runtime.destroy();
});

s.test("startup refuses a durable attachment publication from another vault generation", async () => {
	const state = createMemoryState();
	state.attachmentOperations.set("operation-old-generation", {
		vaultId: "vault-1",
		vaultGeneration: "generation-old",
		mutation: {
			operationId: "operation-old-generation",
			kind: "upsert",
			path: "attachments/old-generation.bin",
			expectedRevision: null,
			hash: "d".repeat(64),
			size: 23,
			mime: "application/octet-stream",
		},
		localSequence: 1,
		createdAt: 1,
		attempts: 0,
		lastAttemptAt: null,
	});
	const server = new AttachmentServer();
	await assert.rejects(
		startRuntime(state, server),
		(error: unknown) => error instanceof AttachmentPublicationProofError
			&& error.message.includes("active vault generation"),
	);
	assert.equal(server.calls.length, 0, "the stale publication never reaches the server");
	assert.equal(state.attachmentOperations.size, 1, "scope rejection does not rewrite or rebase the stale operation");
});

await s.done();
