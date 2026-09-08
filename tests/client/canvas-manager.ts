import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { canonicalCanvasBytes, parseCanvasBytes } from "../../server/src/shared/canvasCodec";
import { applyCanvasSnapshot, createCanvasDocument, materializeCanvasDocument } from "../../server/src/shared/canvasSemanticDocument";
import { CanvasManager, type CanvasProjectionPort, type CanvasProviderPort } from "../../src/sync/canvas/canvasManager";
import type { CanvasAuthorityReceipt, CanvasCandidateReceipt, CanvasDemotionRequest, CanvasLifecycleRequest,
	CanvasPromotionRequest, CanvasState } from "../../src/sync/canvas/canvasTransport";
import type { StoredCanvasCandidate, StoredCanvasLifecycle, StoredCanvasSettlement, StoredDocument } from "../../src/sync/vaultIndexedDb";
import { sha256BytesHex } from "../../src/utils/sha256";
import { suite } from "../harness.ts";

const s = suite("canvas-manager");
const encoder = new TextEncoder();

function bytes(text = "one"): Uint8Array {
	return encoder.encode(JSON.stringify({ nodes: [{ id: "n", type: "text", text, x: 0, y: 0, width: 100, height: 40 }], edges: [] }));
}

class MemoryPersistence {
	documents = new Map<string, StoredDocument>();
	candidates = new Map<string, StoredCanvasCandidate>();
	settlements = new Map<string, StoredCanvasSettlement>();
	lifecycle = new Map<string, StoredCanvasLifecycle>();
	async getDocument(id: string) { return this.documents.get(id) ?? null; }
	async putDocument(value: StoredDocument) { this.documents.set(value.documentId, value); }
	async putCanvasCandidate(value: StoredCanvasCandidate) { this.candidates.set(value.candidateId, value); }
	async listCanvasCandidates() { return [...this.candidates.values()]; }
	async deleteCanvasCandidate(id: string) { this.candidates.delete(id); }
	async putCanvasLifecycle(value: StoredCanvasLifecycle) { this.lifecycle.set(value.operationId, value); }
	async listCanvasLifecycle() { return [...this.lifecycle.values()]; }
	async deleteCanvasLifecycle(id: string) { this.lifecycle.delete(id); }
	async getCanvasSettlement(id: string) { return this.settlements.get(id) ?? null; }
	async putCanvasSettlement(value: StoredCanvasSettlement, expected: number | null) {
		if ((this.settlements.get(value.documentId)?.localSettlementRevision ?? null) !== expected) return false;
		this.settlements.set(value.documentId, value);
		return true;
	}
}

class MemoryProjection implements CanvasProjectionPort {
	files = new Map<string, Uint8Array>();
	conflicts = 0;
	async read(path: string) { return this.files.get(path) ?? null; }
	async write(path: string, value: Uint8Array) { this.files.set(path, value); }
	async preserveConflict() { this.conflicts++; return true; }
}

class MemoryTransport {
	docs = new Map<string, Y.Doc>();
	paths = new Map<string, string>();
	generation = new Map<string, number>();
	blobs = new Map<string, ArrayBuffer>();
	async state(documentId: string): Promise<CanvasState> {
		const doc = this.docs.get(documentId)!;
		const canonical = canonicalCanvasBytes(await materializeCanvasDocument(doc));
		return { documentId, path: this.paths.get(documentId) ?? "", generation: this.generation.get(documentId) ?? 1,
			contentHash: await sha256BytesHex(canonical), size: canonical.byteLength, lifecycle: "active",
			encodedState: Y.encodeStateAsUpdate(doc) };
	}
	async submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt> {
		let doc = this.docs.get(candidate.documentId);
		if (!doc) { doc = new Y.Doc({ guid: candidate.documentId }); this.docs.set(candidate.documentId, doc); }
		Y.applyUpdate(doc, new Uint8Array(candidate.encodedUpdate));
		if (candidate.createPath) this.paths.set(candidate.documentId, candidate.createPath);
		const generation = (this.generation.get(candidate.documentId) ?? 0) + 1;
		this.generation.set(candidate.documentId, generation);
		const canonical = canonicalCanvasBytes(await materializeCanvasDocument(doc));
		return { documentId: candidate.documentId, candidateId: candidate.candidateId,
			candidateDigest: candidate.candidateDigest, durableGeneration: generation, vaultSequence: generation,
			contentHash: await sha256BytesHex(canonical), size: canonical.byteLength };
	}
	async lifecycle(request: CanvasLifecycleRequest) {
		return { operationId: request.operationId, requestDigest: request.requestDigest, documentId: request.documentId,
			resultPath: request.toPath ?? request.path ?? this.paths.get(request.documentId) ?? "",
			resultLifecycle: request.kind === "delete" ? "tombstoned" as const : "active" as const,
			durableGeneration: this.generation.get(request.documentId) ?? 1, vaultSequence: 1 };
	}
	async promote(request: CanvasPromotionRequest): Promise<CanvasAuthorityReceipt> {
		const doc = new Y.Doc({ guid: request.documentId });
		Y.applyUpdate(doc, new Uint8Array(request.encodedUpdate));
		this.docs.set(request.documentId, doc);
		this.paths.set(request.documentId, request.path);
		this.generation.set(request.documentId, 1);
		return { operationId: request.operationId, requestDigest: request.requestDigest, kind: "promote",
			path: request.path, documentId: request.documentId, sourceRevision: request.sourceRevision,
			contentHash: request.contentHash, size: request.contentSize, documentGeneration: 1,
			rootSequence: 2, rootGeneration: 2, rollbackBlobHash: request.sourceHash };
	}
	async uploadBlob(hash: string, value: ArrayBuffer) { this.blobs.set(hash, value); }
	async demote(request: CanvasDemotionRequest): Promise<CanvasAuthorityReceipt> {
		return { operationId: request.operationId, requestDigest: request.requestDigest, kind: "demote",
			path: request.path, documentId: request.documentId,
			sourceRevision: `${request.expectedGeneration}:${request.expectedContentHash}`,
			contentHash: request.expectedContentHash, size: request.expectedSize,
			documentGeneration: request.expectedGeneration, rootSequence: 3, rootGeneration: 3,
			rollbackBlobHash: null };
	}
}

class MemoryProvider implements CanvasProviderPort {
	readonly awareness = { setLocalStateField() {}, destroy() {}, getStates: () => new Map<number, unknown>() };
	readonly documentOrigin = {};
	ws: { readyState?: number } | null = null;
	wsconnected = false;
	wsconnecting = false;
	synced = false;
	url = "ws://semantic";
	destroyed = false;
	private readonly statusListeners: Array<(event: { status: string }) => void> = [];
	private readonly syncListeners: Array<(synced: boolean) => void> = [];
	private readonly messageListeners: Array<(payload: string) => void> = [];
	constructor(readonly doc: Y.Doc) {}
	connect() {
		this.wsconnected = true;
		this.synced = true;
		this.ws = { readyState: 1 };
		for (const listener of this.statusListeners) listener({ status: "connected" });
		for (const listener of this.syncListeners) listener(true);
	}
	disconnect() {
		this.wsconnected = false;
		this.synced = false;
		this.ws = null;
		for (const listener of this.statusListeners) listener({ status: "disconnected" });
	}
	destroy() { this.destroyed = true; }
	on(event: "status", callback: (event: { status: string }) => void): void;
	on(event: "sync", callback: (synced: boolean) => void): void;
	on(event: "custom-message", callback: (payload: string) => void): void;
	on(event: "status" | "sync" | "custom-message",
		callback: ((event: { status: string }) => void) | ((synced: boolean) => void) | ((payload: string) => void)): void {
		if (event === "status") this.statusListeners.push(callback as (event: { status: string }) => void);
		else if (event === "sync") this.syncListeners.push(callback as (synced: boolean) => void);
		else this.messageListeners.push(callback as (payload: string) => void);
	}
}

s.test("creates a semantic Canvas only after persisting its exact candidate", async () => {
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new MemoryTransport();
	const manager = new CanvasManager("generation", persistence, transport, projection);
	await manager.initialize([]);
	assert.equal(await manager.ingest("Board.canvas", bytes()), "created");
	const documentId = manager.documentIdForPath("Board.canvas");
	assert.ok(documentId);
	assert.equal(persistence.candidates.size, 0, "receipt clears only the submitted durable candidate");
	assert.equal(transport.paths.get(documentId!), "Board.canvas");
	assert.equal((await materializeCanvasDocument(transport.docs.get(documentId!)!)).nodes.get("n")?.text, "one");
	manager.destroy();
});

s.test("reconciles a closed-file local edit and settles the exact projection", async () => {
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new MemoryTransport();
	const parsed = parseCanvasBytes(bytes());
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	const doc = createCanvasDocument(parsed.data);
	transport.docs.set("canvas-id", doc);
	transport.paths.set("canvas-id", "Board.canvas");
	transport.generation.set("canvas-id", 1);
	const manager = new CanvasManager("generation", persistence, transport, projection);
	await manager.initialize([["Board.canvas", { documentId: "canvas-id", kind: "canvas", format: "json-canvas", formatVersion: 1 }]]);
	projection.files.set("Board.canvas", bytes());
	await manager.refresh("canvas-id");
	projection.files.set("Board.canvas", bytes("local"));
	assert.equal(await manager.ingest("Board.canvas", bytes("local")), "updated");
	assert.equal((await materializeCanvasDocument(transport.docs.get("canvas-id")!)).nodes.get("n")?.text, "local");
	await manager.refresh("canvas-id");
	assert.equal(persistence.settlements.get("canvas-id")?.pathAtSettlement, "Board.canvas");
	assert.equal(persistence.settlements.get("canvas-id")?.durableGeneration, transport.generation.get("canvas-id"));
	assert.equal(persistence.settlements.get("canvas-id")?.serverContentHash,
		await sha256BytesHex(canonicalCanvasBytes(await materializeCanvasDocument(transport.docs.get("canvas-id")!))));
	assert.ok(projection.files.get("Board.canvas"));
	manager.destroy();
	doc.destroy();
});

s.test("promotes formatted attachment bytes and demotes the exact canonical semantic head", async () => {
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new MemoryTransport();
	const manager = new CanvasManager("generation", persistence, transport, projection);
	await manager.initialize([]);
	const formatted = bytes("promotion");
	const sourceHash = await sha256BytesHex(formatted);
	const promotion = await manager.promote("Board.canvas", formatted,
		{ revision: "attachment-revision", hash: sourceHash, size: formatted.byteLength });
	assert.equal(promotion.rollbackBlobHash, sourceHash, "presentation blob remains the rollback authority");
	assert.notEqual(promotion.contentHash, sourceHash, "semantic authority uses canonical content identity");
	assert.equal(manager.isSemanticPath("Board.canvas"), true);
	const demotion = await manager.demote("Board.canvas");
	assert.equal(demotion.contentHash, promotion.contentHash);
	assert.equal(transport.blobs.has(promotion.contentHash), true, "demotion uploads the exact semantic bytes first");
	assert.equal(manager.isSemanticPath("Board.canvas"), false);
	manager.destroy();
});

s.test("opens one live provider per active Canvas and projects pending remote socket updates", async () => {
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new MemoryTransport();
	const parsed = parseCanvasBytes(bytes("base"));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	const authority = createCanvasDocument(parsed.data);
	transport.docs.set("canvas-id", authority);
	transport.paths.set("canvas-id", "Board.canvas");
	transport.generation.set("canvas-id", 1);
	const providers: MemoryProvider[] = [];
	const manager = new CanvasManager("generation", persistence, transport, projection, Date.now, 32,
		(_documentId, doc) => {
			const created = new MemoryProvider(doc);
			providers.push(created);
			return created;
		});
	await manager.initialize([["Board.canvas", { documentId: "canvas-id", kind: "canvas",
		format: "json-canvas", formatVersion: 1 }]]);
	await manager.setLiveConsumer("view:1", "Board.canvas");
	await manager.setLiveConsumer("view:2", "Board.canvas");
	const provider = providers[0];
	assert.ok(provider);
	assert.equal(manager.activeProviders().length, 1);
	assert.equal(provider.wsconnected, true);
	const remote = new Y.Doc({ guid: "canvas-id" });
	Y.applyUpdate(remote, Y.encodeStateAsUpdate(provider.doc));
	const remoteParsed = parseCanvasBytes(bytes("remote-pending"));
	assert.equal(remoteParsed.kind, "valid");
	if (remoteParsed.kind !== "valid") return;
	const vector = Y.encodeStateVector(provider.doc);
	await applyCanvasSnapshot(remote, remoteParsed.data, "remote-peer");
	Y.applyUpdate(provider.doc, Y.encodeStateAsUpdate(remote, vector), provider.documentOrigin);
	await delay(20);
	const projected = parseCanvasBytes(projection.files.get("Board.canvas")!);
	assert.equal(projected.kind, "valid");
	if (projected.kind === "valid") assert.equal(projected.data.nodes.get("n")?.text, "remote-pending");
	assert.equal(transport.generation.get("canvas-id"), 1, "remote socket projection does not invent a local candidate");
	manager.releaseLiveConsumer("view:1");
	assert.equal(provider.wsconnected, true);
	manager.releaseLiveConsumer("view:2");
	assert.equal(provider.wsconnected, false);
	assert.equal(provider.destroyed, true);
	manager.destroy();
	remote.destroy();
	authority.destroy();
});

s.test("replays the exact promotion intent after a committed response is lost", async () => {
	class LostPromotionResponseTransport extends MemoryTransport {
		attempts = 0;
		override async promote(request: CanvasPromotionRequest): Promise<CanvasAuthorityReceipt> {
			this.attempts++;
			const receipt = await super.promote(request);
			if (this.attempts === 1) throw new Error("response lost after commit");
			return receipt;
		}
	}
	const persistence = new MemoryPersistence();
	const transport = new LostPromotionResponseTransport();
	const manager = new CanvasManager("generation", persistence, transport, new MemoryProjection());
	await manager.initialize([]);
	const source = bytes("replay promotion");
	await assert.rejects(manager.promote("Replay.canvas", source, { revision: "attachment-revision",
		hash: await sha256BytesHex(source), size: source.byteLength }), /response lost/);
	assert.equal(persistence.lifecycle.size, 1, "promotion identity and exact bytes remain durable");
	await delay(650);
	assert.equal(transport.attempts, 2);
	assert.equal(persistence.lifecycle.size, 0);
	assert.equal(manager.isSemanticPath("Replay.canvas"), true);
	manager.destroy();
});

s.test("replays a persisted Canvas candidate after a transient submission failure", async () => {
	class FlakyTransport extends MemoryTransport {
		attempts = 0;
		override async submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt> {
			this.attempts++;
			if (this.attempts === 1) throw new Error("temporarily unavailable");
			return super.submit(candidate);
		}
	}
	const persistence = new MemoryPersistence();
	const transport = new FlakyTransport();
	const manager = new CanvasManager("generation", persistence, transport, new MemoryProjection());
	await manager.initialize([]);
	await assert.rejects(manager.ingest("Retry.canvas", bytes("durable")), /temporarily unavailable/);
	assert.equal(persistence.candidates.size, 1, "the exact candidate remains durable while offline");
	assert.equal(await manager.ingest("Retry.canvas", bytes("durable")), "formatting-only");
	assert.equal(persistence.settlements.size, 0, "pending candidate evidence never advances a common base");
	await delay(650);
	assert.equal(transport.attempts, 2);
	assert.equal(persistence.candidates.size, 0);
	const documentId = manager.documentIdForPath("Retry.canvas");
	assert.ok(documentId && transport.docs.has(documentId));
	manager.destroy();
});

s.test("a lifecycle delete removes a nonresident Canvas from the local catalog", async () => {
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new MemoryTransport();
	for (const [documentId, path, text] of [["first", "First.canvas", "first"], ["second", "Second.canvas", "second"]] as const) {
		const parsed = parseCanvasBytes(bytes(text));
		assert.equal(parsed.kind, "valid");
		if (parsed.kind !== "valid") return;
		transport.docs.set(documentId, createCanvasDocument(parsed.data));
		transport.paths.set(documentId, path);
		transport.generation.set(documentId, 1);
		projection.files.set(path, bytes(text));
	}
	const manager = new CanvasManager("generation", persistence, transport, projection, Date.now, 1);
	await manager.initialize([
		["First.canvas", { documentId: "first", kind: "canvas", format: "json-canvas", formatVersion: 1 }],
		["Second.canvas", { documentId: "second", kind: "canvas", format: "json-canvas", formatVersion: 1 }],
	]);
	await manager.delete("first");
	assert.equal(manager.documentIdForPath("First.canvas"), null);
	assert.equal(manager.stats().semanticDocuments, 1);
	manager.destroy();
	for (const doc of transport.docs.values()) doc.destroy();
});

s.test("never overwrites invalid local Canvas bytes during remote refresh", async () => {
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new MemoryTransport();
	const parsed = parseCanvasBytes(bytes("server"));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	const doc = createCanvasDocument(parsed.data);
	transport.docs.set("canvas-invalid-local", doc);
	transport.paths.set("canvas-invalid-local", "Broken.canvas");
	transport.generation.set("canvas-invalid-local", 1);
	const invalid = encoder.encode("{not valid json");
	projection.files.set("Broken.canvas", invalid);
	const manager = new CanvasManager("generation", persistence, transport, projection);
	await manager.initialize([["Broken.canvas", { documentId: "canvas-invalid-local", kind: "canvas",
		format: "json-canvas", formatVersion: 1 }]]);
	assert.deepEqual(projection.files.get("Broken.canvas"), invalid);
	assert.equal(manager.stats().invalidDocuments, 1);
	manager.destroy();
	doc.destroy();
});

await s.done();
