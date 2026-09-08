import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { VaultSemanticService } from "../../server/src/vaultSemanticService";
import { BODY_EPOCH_HEADER, ROOT_EPOCH_HEADER } from "../../server/src/shared/semanticEpoch";
import type { VaultActorContext } from "../../server/src/collaboration";
import type { SemanticCatalogHead } from "../../server/src/vaultStore";
import { canonicalCanvasBytes } from "../../server/src/shared/canvasCodec";
import { initializeCanvasDocument, materializeCanvasDocument } from "../../server/src/shared/canvasSemanticDocument";
import { suite } from "../harness.ts";

const s = suite("vault-semantic-candidate-runtime");
const DOCUMENT_ID = "canvas-candidate-runtime";
const CANDIDATE_ID = "canvas-candidate-id";

const actor: VaultActorContext = {
	vaultId: "vault-canvas-candidate",
	vaultGeneration: "generation-canvas-candidate",
	principalId: "principal-canvas-candidate",
	membershipRevision: 1,
	deviceId: "device-canvas-candidate",
	deviceCredentialRevision: 1,
	role: "member",
	policyVersion: 1,
	capabilityDigest: "capability-canvas-candidate",
};

async function digest(bytes: Uint8Array): Promise<string> {
	const value = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function candidateRequest(update: Uint8Array, bodyEpoch: number): Promise<Request> {
	return new Request("https://vault.test/semantic/candidate", {
		method: "POST",
		headers: {
			"x-yaos-candidate-id": CANDIDATE_ID,
			"x-yaos-candidate-digest": await digest(update),
			[BODY_EPOCH_HEADER]: String(bodyEpoch),
		},
		body: update,
	});
}

async function emptyCanvas(): Promise<{ update: Uint8Array; content: Uint8Array; contentHash: string }> {
	const document = new Y.Doc({ guid: DOCUMENT_ID });
	initializeCanvasDocument(document);
	const update = Y.encodeStateAsUpdate(document);
	const content = canonicalCanvasBytes(await materializeCanvasDocument(document, false));
	document.destroy();
	return { update, content, contentHash: await digest(content) };
}

s.test("stale Canvas candidate epoch is rejected before body read, cache admission, or durability", async () => {
	let cacheTouches = 0;
	let durableTouches = 0;
	const service = new VaultSemanticService({
		store: {
			documentHead: () => ({ generation: 7, semanticEpoch: 3, latestSequence: 11 }),
			semanticCandidateReceipt: () => null,
			commitUpdate: () => { durableTouches++; throw new Error("must not commit"); },
		},
		cache: {
			serializeDocument: () => { cacheTouches++; throw new Error("must not serialize"); },
			load: () => { cacheTouches++; throw new Error("must not load"); },
		},
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-canvas-candidate",
		validateActor: () => true,
		sockets: {},
		flush: async () => true,
	} as never);
	const response = await service.candidate(DOCUMENT_ID, await candidateRequest(new Uint8Array([1, 2, 3]), 2), actor);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "semantic_epoch_mismatch",
		purpose: "body",
		documentId: DOCUMENT_ID,
		expectedEpoch: 3,
		receivedEpoch: 2,
		reset: "fetch_fresh_baseline",
	});
	assert.equal(cacheTouches, 0);
	assert.equal(durableTouches, 0);
});

s.test("Canvas candidate commits with exact head CAS and discards validation mirror on durable failure", async () => {
	const head = { generation: 7, semanticEpoch: 3, latestSequence: 11 };
	let expectedHead: unknown = null;
	let discarded = 0;
	let liveCommits = 0;
	let broadcasts = 0;
	const update = new Uint8Array([8, 6, 7, 5, 3, 0, 9]);
	const service = new VaultSemanticService({
		store: {
			documentHead: () => head,
			currentSequence: () => 11,
			semanticHeadAt: () => ({ documentId: DOCUMENT_ID, fileId: DOCUMENT_ID,
				kind: "canvas", format: "json-canvas", formatVersion: 1, path: "Board.canvas",
				previousPath: null, lifecycle: "active", generation: 7, bodyEpoch: 3,
				contentHash: "a".repeat(64), size: 2, sequence: 11 }),
			semanticCandidateReceipt: () => null,
			commitUpdate: (input: { expectedHead?: unknown }) => {
				expectedHead = input.expectedHead;
				throw new Error("injected Canvas durable failure");
			},
		},
		cache: {
			serializeDocument: async (_documentId: string, operation: () => Promise<Response>) => operation(),
			admitBody: () => true,
			load: () => ({}),
			validateCanvasUpdate: async () => ({
				changesState: true,
				requiresDurableCommit: true,
				contentBytes: new TextEncoder().encode("{\"nodes\":[],\"edges\":[]}"),
				encodedStateBytes: 32,
				exactEncodedStateBytes: true,
			}),
			discardValidatedBodyUpdate: () => { discarded++; },
			commitValidatedBodyUpdate: () => { liveCommits++; return true; },
		},
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-canvas-candidate",
		validateActor: () => true,
		sockets: {
			broadcastDocumentUpdate: () => { broadcasts++; },
		},
		flush: async () => true,
	} as never);
	const response = await service.candidate(DOCUMENT_ID, await candidateRequest(update, 3), actor);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "injected Canvas durable failure" });
	assert.deepEqual(expectedHead, head, "commit is fenced by the exact generation, semantic epoch, and sequence");
	assert.equal(discarded, 1, "failed durability discards and rebuilds the private validation mirror");
	assert.equal(liveCommits, 0, "authoritative live Canvas never advances before SQLite");
	assert.equal(broadcasts, 0);
});

s.test("Canvas candidate catalog CAS rejects lifecycle changes during semantic validation", async () => {
	const head = { generation: 7, semanticEpoch: 3, latestSequence: 11 };
	const active: SemanticCatalogHead = { documentId: DOCUMENT_ID, fileId: DOCUMENT_ID,
		kind: "canvas" as const, format: "json-canvas" as const, formatVersion: 1 as const, path: "Board.canvas",
		previousPath: null, lifecycle: "active" as const, generation: 7, bodyEpoch: 3,
		contentHash: "a".repeat(64), size: 2, sequence: 11 };
	let catalogHead: SemanticCatalogHead = { ...active };
	let releaseValidation!: () => void;
	let validationEntered!: () => void;
	const entered = new Promise<void>((resolve) => { validationEntered = resolve; });
	const blocked = new Promise<void>((resolve) => { releaseValidation = resolve; });
	let expectedSemanticHead: unknown;
	let discarded = 0;
	let liveCommits = 0;
	const update = new Uint8Array([4, 2, 4, 2]);
	const service = new VaultSemanticService({
		store: {
			documentHead: () => head,
			currentSequence: () => catalogHead.sequence,
			semanticHeadAt: () => catalogHead,
			semanticCandidateReceipt: () => null,
			commitUpdate: (input: { expectedSemanticHead?: SemanticCatalogHead }) => {
				expectedSemanticHead = input.expectedSemanticHead;
				if (input.expectedSemanticHead?.sequence !== catalogHead.sequence
					|| input.expectedSemanticHead?.lifecycle !== catalogHead.lifecycle
					|| input.expectedSemanticHead?.path !== catalogHead.path) throw new Error("semantic_catalog_head_changed");
				throw new Error("fixture expected the semantic catalog CAS to fail");
			},
		},
		cache: {
			serializeDocument: async (_documentId: string, operation: () => Promise<Response>) => operation(),
			admitBody: () => true,
			load: () => ({}),
			validateCanvasUpdate: async () => {
				validationEntered();
				await blocked;
				return { changesState: true, requiresDurableCommit: true,
					contentBytes: new TextEncoder().encode("{\"nodes\":[],\"edges\":[]}"),
					encodedStateBytes: 32, exactEncodedStateBytes: true };
			},
			discardValidatedBodyUpdate: () => { discarded++; },
			commitValidatedBodyUpdate: () => { liveCommits++; return true; },
		},
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-canvas-candidate",
		validateActor: () => true,
		sockets: {},
		flush: async () => true,
	} as never);
	const responsePromise = service.candidate(DOCUMENT_ID, await candidateRequest(update, 3), actor);
	await entered;
	catalogHead = { ...active, sequence: 12, lifecycle: "tombstoned" };
	releaseValidation();
	const response = await responsePromise;
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "semantic_catalog_head_changed" });
	assert.deepEqual(expectedSemanticHead, active, "commit carries the exact pre-validation semantic authority");
	assert.equal(discarded, 1);
	assert.equal(liveCommits, 0);
});

s.test("revocation during a no-op Canvas candidate prevents its durable receipt", async () => {
	const head = { generation: 7, semanticEpoch: 3, latestSequence: 11 };
	const active: SemanticCatalogHead = { documentId: DOCUMENT_ID, fileId: DOCUMENT_ID,
		kind: "canvas" as const, format: "json-canvas" as const, formatVersion: 1 as const, path: "Board.canvas",
		previousPath: null, lifecycle: "active" as const, generation: 7, bodyEpoch: 3,
		contentHash: "a".repeat(64), size: 2, sequence: 11 };
	let actorAllowed = true;
	let releaseValidation!: () => void;
	let validationEntered!: () => void;
	const entered = new Promise<void>((resolve) => { validationEntered = resolve; });
	const blocked = new Promise<void>((resolve) => { releaseValidation = resolve; });
	let receipts = 0;
	let staged = 0;
	let discarded = 0;
	const update = new Uint8Array([1, 4, 1, 4]);
	const service = new VaultSemanticService({
		store: {
			documentHead: () => head,
			currentSequence: () => active.sequence,
			semanticHeadAt: () => active,
			semanticCandidateReceipt: () => null,
			recordSemanticCandidateReceipt: () => { receipts++; },
		},
		cache: {
			serializeDocument: async (_documentId: string, operation: () => Promise<Response>) => operation(),
			admitBody: () => true,
			load: () => ({}),
			validateCanvasUpdate: async () => {
				validationEntered();
				await blocked;
				return { changesState: false, requiresDurableCommit: false,
					contentBytes: new TextEncoder().encode("{\"nodes\":[],\"edges\":[]}"),
					encodedStateBytes: 32, exactEncodedStateBytes: true };
			},
			stageValidatedBodyUpdate: () => { staged++; },
			discardValidatedBodyUpdate: () => { discarded++; },
		},
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-canvas-candidate",
		validateActor: () => actorAllowed,
		sockets: {},
		flush: async () => true,
	} as never);
	const responsePromise = service.candidate(DOCUMENT_ID, await candidateRequest(update, 3), actor);
	await entered;
	actorAllowed = false;
	releaseValidation();
	const response = await responsePromise;
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "authority_superseded" });
	assert.equal(receipts, 0);
	assert.equal(staged, 0);
	assert.equal(discarded, 1);
});

s.test("revocation during Canvas promotion prevents the authority commit", async () => {
	const canvas = await emptyCanvas();
	const sourceHash = "b".repeat(64);
	const sourceSize = 17;
	const root = new Y.Doc({ guid: "root" });
	root.getMap("pathToBlob").set("Board.canvas", {
		hash: sourceHash, size: sourceSize, revision: "promotion-source",
	});
	let actorAllowed = true;
	let commits = 0;
	let releaseObjectHead!: () => void;
	let objectHeadEntered!: () => void;
	const entered = new Promise<void>((resolve) => { objectHeadEntered = resolve; });
	const blocked = new Promise<void>((resolve) => { releaseObjectHead = resolve; });
	const request = new Request("https://vault.test/semantic/promote", {
		method: "POST",
		headers: {
			"x-yaos-operation-id": "promotion-operation",
			"x-yaos-operation-digest": "c".repeat(64),
			"x-yaos-path": "Board.canvas",
			"x-yaos-document-id": DOCUMENT_ID,
			"x-yaos-source-revision": "promotion-source",
			"x-yaos-source-hash": sourceHash,
			"x-yaos-source-size": String(sourceSize),
			"x-yaos-content-hash": canvas.contentHash,
			"x-yaos-content-size": String(canvas.content.byteLength),
			"x-yaos-candidate-digest": await digest(canvas.update),
			[BODY_EPOCH_HEADER]: "1",
			[ROOT_EPOCH_HEADER]: "1",
		},
		body: canvas.update,
	});
	const service = new VaultSemanticService({
		store: {
			semanticAuthorityReceipt: () => null,
			documentHead: (documentId: string) => documentId === "root"
				? { generation: 4, semanticEpoch: 1, latestSequence: 8 } : null,
			reconstructDocument: () => ({ doc: root, generation: 4, semanticEpoch: 1, latestSequence: 8 }),
			commitSemanticPromotion: () => { commits++; throw new Error("must not commit"); },
		},
		cache: { reserveFullStateOperation: () => () => {} },
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-canvas-candidate",
		validateActor: () => actorAllowed,
		sockets: {},
		flush: async () => true,
		objectStore: {
			head: async () => {
				objectHeadEntered();
				await blocked;
				return { size: sourceSize };
			},
		},
	} as never);
	const responsePromise = service.promote(request, actor);
	await entered;
	actorAllowed = false;
	releaseObjectHead();
	const response = await responsePromise;
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "authority_superseded" });
	assert.equal(commits, 0);
});

s.test("revocation during Canvas demotion prevents the authority commit", async () => {
	const canvas = await emptyCanvas();
	const active: SemanticCatalogHead = { documentId: DOCUMENT_ID, fileId: DOCUMENT_ID,
		kind: "canvas", format: "json-canvas", formatVersion: 1, path: "Board.canvas",
		previousPath: null, lifecycle: "active", generation: 7, bodyEpoch: 3,
		contentHash: canvas.contentHash, size: canvas.content.byteLength, sequence: 11 };
	let actorAllowed = true;
	let commits = 0;
	let releaseFlush!: () => void;
	let flushEntered!: () => void;
	const entered = new Promise<void>((resolve) => { flushEntered = resolve; });
	const blocked = new Promise<void>((resolve) => { releaseFlush = resolve; });
	const request = new Request("https://vault.test/semantic/demote", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			operationId: "demotion-operation",
			requestDigest: "d".repeat(64),
			documentId: DOCUMENT_ID,
			path: active.path,
			expectedGeneration: active.generation,
			expectedContentHash: canvas.contentHash,
			expectedSize: canvas.content.byteLength,
			blobHash: canvas.contentHash,
			blobSize: canvas.content.byteLength,
			mime: "application/json",
			bodyEpoch: active.bodyEpoch,
			rootEpoch: 1,
		}),
	});
	const service = new VaultSemanticService({
		store: {
			semanticAuthorityReceipt: () => null,
			currentSequence: () => active.sequence,
			semanticHeadAt: () => active,
			documentHead: (documentId: string) => documentId === "root"
				? { generation: 4, semanticEpoch: 1, latestSequence: 8 }
				: { generation: active.generation, semanticEpoch: active.bodyEpoch, latestSequence: active.sequence },
			reconstructDocument: (documentId: string) => {
				if (documentId === DOCUMENT_ID) {
					const document = new Y.Doc({ guid: DOCUMENT_ID });
					Y.applyUpdate(document, canvas.update);
					return { doc: document, generation: active.generation,
						semanticEpoch: active.bodyEpoch, latestSequence: active.sequence };
				}
				const document = new Y.Doc({ guid: "root" });
				document.getMap("pathToSemantic").set(active.path, {
					documentId: DOCUMENT_ID, kind: "canvas", format: "json-canvas", formatVersion: 1,
				});
				return { doc: document, generation: 4, semanticEpoch: 1, latestSequence: 8 };
			},
			commitSemanticDemotion: () => { commits++; throw new Error("must not commit"); },
		},
		cache: { reserveFullStateOperation: () => () => {} },
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-canvas-candidate",
		validateActor: () => actorAllowed,
		sockets: {},
		flush: async () => {
			flushEntered();
			await blocked;
			return true;
		},
		objectStore: { head: async () => ({ size: canvas.content.byteLength }) },
	} as never);
	const responsePromise = service.demote(request, actor);
	await entered;
	actorAllowed = false;
	releaseFlush();
	const response = await responsePromise;
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "authority_superseded" });
	assert.equal(commits, 0);
});

s.test("tombstoned Canvas identity cannot bypass revive through candidate creation", async () => {
	let cacheTouches = 0;
	const update = new Uint8Array([2, 7, 1, 8]);
	const request = await candidateRequest(update, 3);
	request.headers.set("x-yaos-semantic-create-path", "Revived.canvas");
	request.headers.set("x-yaos-semantic-operation-id", "candidate-recreate");
	request.headers.set("x-yaos-operation-digest", "f".repeat(64));
	const service = new VaultSemanticService({
		store: {
			documentHead: () => ({ generation: 7, semanticEpoch: 3, latestSequence: 11 }),
			currentSequence: () => 12,
			semanticHeadAt: () => ({ documentId: DOCUMENT_ID, fileId: DOCUMENT_ID,
				kind: "canvas", format: "json-canvas", formatVersion: 1, path: "Board.canvas",
				previousPath: null, lifecycle: "tombstoned", generation: 7, bodyEpoch: 3,
				contentHash: "a".repeat(64), size: 2, sequence: 12 }),
			semanticCandidateReceipt: () => null,
		},
		cache: {
			serializeDocument: () => { cacheTouches++; throw new Error("must not serialize"); },
		},
		vaultId: () => actor.vaultId,
		vaultGeneration: () => actor.vaultGeneration,
		runtimeEpoch: "runtime-canvas-candidate",
		validateActor: () => true,
		sockets: {},
		flush: async () => true,
	} as never);
	const response = await service.candidate(DOCUMENT_ID, request, actor);
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "semantic_document_not_active" });
	assert.equal(cacheTouches, 0);
});

await s.done();
