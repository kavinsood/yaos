import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { canonicalCanvasBytes, parseCanvasBytes } from "../../server/src/shared/canvasCodec";
import { applyCanvasSnapshot, createCanvasDocument, materializeCanvasDocument } from "../../server/src/shared/canvasSemanticDocument";
import type { SemanticPathRef } from "../../server/src/shared/canvasTypes";
import { CanvasManager, type CanvasProjectionPort, type CanvasProviderPort } from "../../src/sync/canvas/canvasManager";
import { CanvasHttpTransport, CanvasSemanticEpochMismatchError } from "../../src/sync/canvas/canvasTransport";
import type { CanvasAuthorityReceipt, CanvasCandidateReceipt, CanvasDemotionRequest, CanvasLifecycleRequest,
	CanvasPromotionRequest, CanvasState } from "../../src/sync/canvas/canvasTransport";
import type { StoredCanvasCandidate, StoredCanvasEpochReplacement, StoredCanvasLifecycle, StoredCanvasSettlement, StoredDocument } from "../../src/sync/vaultIndexedDb";
import { sha256BytesHex } from "../../src/utils/sha256";
import { suite } from "../harness.ts";

const s = suite("canvas-manager");
const encoder = new TextEncoder();

function bytes(text = "one"): Uint8Array {
	return encoder.encode(JSON.stringify({ nodes: [{ id: "n", type: "text", text, x: 0, y: 0, width: 100, height: 40 }], edges: [] }));
}

function bytesWithServerNode(text: string): Uint8Array {
	return encoder.encode(JSON.stringify({ nodes: [
		{ id: "n", type: "text", text, x: 0, y: 0, width: 100, height: 40 },
		{ id: "server", type: "text", text: "server-only", x: 150, y: 0, width: 100, height: 40 },
	], edges: [] }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for Canvas condition");
		await delay(10);
	}
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
	async replaceCanvasSemanticEpoch(value: StoredCanvasEpochReplacement) {
		for (const [id, candidate] of this.candidates) {
			if (candidate.documentId === value.document.documentId) this.candidates.delete(id);
		}
		for (const [id, operation] of this.lifecycle) {
			if (operation.documentId === value.document.documentId) this.lifecycle.delete(id);
		}
		this.documents.set(value.document.documentId, value.document);
		this.settlements.set(value.settlement.documentId, value.settlement);
		if (value.candidate) this.candidates.set(value.candidate.candidateId, value.candidate);
		for (const operation of value.lifecycle) this.lifecycle.set(operation.operationId, operation);
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
	epoch = new Map<string, number>();
	blobs = new Map<string, ArrayBuffer>();
	submitted: StoredCanvasCandidate[] = [];
	async state(documentId: string): Promise<CanvasState> {
		const doc = this.docs.get(documentId)!;
		const canonical = canonicalCanvasBytes(await materializeCanvasDocument(doc));
		return { documentId, path: this.paths.get(documentId) ?? "", bodyEpoch: this.epoch.get(documentId) ?? 1,
			generation: this.generation.get(documentId) ?? 1,
			contentHash: await sha256BytesHex(canonical), size: canonical.byteLength, lifecycle: "active",
			encodedState: Y.encodeStateAsUpdate(doc) };
	}
	async submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt> {
		this.submitted.push(candidate);
		const bodyEpoch = this.epoch.get(candidate.documentId) ?? 1;
		if (candidate.bodyEpoch !== bodyEpoch) throw new Error("stale Canvas candidate epoch");
		let doc = this.docs.get(candidate.documentId);
		if (!doc) { doc = new Y.Doc({ guid: candidate.documentId }); this.docs.set(candidate.documentId, doc); }
		Y.applyUpdate(doc, new Uint8Array(candidate.encodedUpdate));
		if (candidate.createPath) this.paths.set(candidate.documentId, candidate.createPath);
		const generation = (this.generation.get(candidate.documentId) ?? 0) + 1;
		this.generation.set(candidate.documentId, generation);
		const canonical = canonicalCanvasBytes(await materializeCanvasDocument(doc));
		return { documentId: candidate.documentId, bodyEpoch, candidateId: candidate.candidateId,
			candidateDigest: candidate.candidateDigest, durableGeneration: generation, vaultSequence: generation,
			contentHash: await sha256BytesHex(canonical), size: canonical.byteLength };
	}
	async lifecycle(request: CanvasLifecycleRequest) {
		return { operationId: request.operationId, requestDigest: request.requestDigest, documentId: request.documentId,
			bodyEpoch: request.bodyEpoch, rootEpoch: request.rootEpoch,
			resultPath: request.toPath ?? request.path ?? this.paths.get(request.documentId) ?? "",
			resultLifecycle: request.kind === "delete" ? "tombstoned" as const : "active" as const,
			durableGeneration: this.generation.get(request.documentId) ?? 1, vaultSequence: 1, rootGeneration: 1 };
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
			bodyEpoch: request.bodyEpoch, rootSequence: 2, rootGeneration: 2, rootEpoch: request.rootEpoch,
			rollbackBlobHash: request.sourceHash };
	}
	async uploadBlob(hash: string, value: ArrayBuffer) { this.blobs.set(hash, value); }
	async demote(request: CanvasDemotionRequest): Promise<CanvasAuthorityReceipt> {
		return { operationId: request.operationId, requestDigest: request.requestDigest, kind: "demote",
			path: request.path, documentId: request.documentId,
			sourceRevision: `${request.expectedGeneration}:${request.expectedContentHash}`,
			contentHash: request.expectedContentHash, size: request.expectedSize,
			documentGeneration: request.expectedGeneration, bodyEpoch: request.bodyEpoch,
			rootSequence: 3, rootGeneration: 3, rootEpoch: request.rootEpoch,
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
	emit(payload: unknown) {
		const encoded = typeof payload === "string" ? payload : JSON.stringify(payload);
		for (const listener of this.messageListeners) listener(encoded);
	}
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
		(_documentId, _bodyEpoch, doc) => {
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
	const manager = new CanvasManager("generation", persistence, transport, new MemoryProjection(), Date.now, 32,
		undefined, undefined, () => 7);
	await manager.initialize([]);
	const source = bytes("replay promotion");
	await assert.rejects(manager.promote("Replay.canvas", source, { revision: "attachment-revision",
		hash: await sha256BytesHex(source), size: source.byteLength }), /response lost/);
	assert.equal(persistence.lifecycle.size, 1, "promotion identity and exact bytes remain durable");
	const pending = [...persistence.lifecycle.values()][0];
	assert.equal(pending?.kind, "promote");
	if (!pending || pending.kind !== "promote") return;
	assert.equal(pending.bodyEpoch, 1);
	assert.equal(pending.rootEpoch, 7, "retry intent retains the exact root lineage fence");
	assert.ok(pending.encodedUpdate instanceof ArrayBuffer);
	assert.deepEqual(new Uint8Array(pending.sourceBytes), source,
		"retry state owns the original attachment bytes without base64 expansion");
	assert.equal("encodedUpdateBase64" in pending, false);
	assert.equal("sourceBytesBase64" in pending, false);
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

s.test("semantically rebases local Canvas intent onto a fresh server epoch", async () => {
	class EpochTransport extends MemoryTransport {
		rejectEpochOne = false;
		override async submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt> {
			if (this.rejectEpochOne && candidate.bodyEpoch === 1) {
				this.submitted.push(candidate);
				throw new Error("epoch-one candidate paused");
			}
			return super.submit(candidate);
		}
	}
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new EpochTransport();
	const base = parseCanvasBytes(bytes("base"));
	assert.equal(base.kind, "valid");
	if (base.kind !== "valid") return;
	transport.docs.set("canvas-epoch", createCanvasDocument(base.data));
	transport.paths.set("canvas-epoch", "Epoch.canvas");
	transport.generation.set("canvas-epoch", 1);
	transport.epoch.set("canvas-epoch", 1);
	projection.files.set("Epoch.canvas", bytes("base"));
	const providers: Array<{ epoch: number; provider: MemoryProvider }> = [];
	const manager = new CanvasManager("generation", persistence, transport, projection, Date.now, 32,
		(_documentId, bodyEpoch, doc) => {
			const provider = new MemoryProvider(doc);
			providers.push({ epoch: bodyEpoch, provider });
			return provider;
		});
	await manager.initialize([["Epoch.canvas", { documentId: "canvas-epoch", kind: "canvas",
		format: "json-canvas", formatVersion: 1 }]]);
	await manager.setLiveConsumer("epoch-view", "Epoch.canvas");
	const oldProvider = providers[0]!;
	const oldClientId = oldProvider.provider.doc.clientID;
	transport.rejectEpochOne = true;
	projection.files.set("Epoch.canvas", bytes("local-only"));
	await assert.rejects(manager.ingest("Epoch.canvas", bytes("local-only")), /epoch-one candidate paused/);
	const staleCandidateId = [...persistence.candidates.keys()][0];
	assert.ok(staleCandidateId);

	const server = parseCanvasBytes(bytesWithServerNode("base"));
	assert.equal(server.kind, "valid");
	if (server.kind !== "valid") return;
	transport.docs.get("canvas-epoch")?.destroy();
	transport.docs.set("canvas-epoch", createCanvasDocument(server.data));
	transport.generation.set("canvas-epoch", 1);
	transport.epoch.set("canvas-epoch", 2);
	transport.rejectEpochOne = false;
	oldProvider.provider.emit({ type: "SEMANTIC_EPOCH_RESET_REQUIRED", code: "semantic_epoch_mismatch",
		purpose: "body", documentId: "canvas-epoch", expectedEpoch: 2, receivedEpoch: 1 });
	await waitFor(() => manager.bodyEpoch("canvas-epoch") === 2
		&& persistence.candidates.size === 0 && providers.length === 2);

	const authoritative = await materializeCanvasDocument(transport.docs.get("canvas-epoch")!);
	assert.equal(authoritative.nodes.get("n")?.text, "local-only", "offline semantic edit crosses the reset");
	assert.equal(authoritative.nodes.get("server")?.text, "server-only", "independent server edit survives the merge");
	assert.equal(persistence.candidates.has(staleCandidateId!), false, "old-lineage candidate is retired");
	assert.ok(transport.submitted.some((candidate) => candidate.bodyEpoch === 2
		&& candidate.candidateId !== staleCandidateId), "rebased intent uses a fresh epoch-bound candidate");
	assert.equal(providers[0]!.provider.destroyed, true);
	assert.deepEqual(providers.map((entry) => entry.epoch), [1, 2]);
	assert.equal(providers[1]!.provider.wsconnected, true, "the existing consumer is rebound to the fresh provider");
	assert.equal(Y.decodeStateVector(Y.encodeStateVector(providers[1]!.provider.doc)).has(oldClientId), false,
		"old Yjs struct identities never enter the new lineage");
	const stored = persistence.documents.get("canvas-epoch");
	assert.equal(stored?.kind, "semantic");
	if (stored?.kind === "semantic") assert.equal(stored.bodyEpoch, 2);
	assert.equal(persistence.settlements.get("canvas-epoch")?.bodyEpoch, 2);
	assert.equal(persistence.settlements.get("canvas-epoch")?.serverContentHash,
		await sha256BytesHex(canonicalCanvasBytes(authoritative)));
	manager.destroy();
	for (const doc of transport.docs.values()) doc.destroy();
});

s.test("rebinds a root-fenced Canvas lifecycle operation and settles it after restart", async () => {
	class RootFenceTransport extends MemoryTransport {
		attempts = 0;
		override async lifecycle(request: CanvasLifecycleRequest) {
			this.attempts++;
			if (request.rootEpoch === 1) {
				throw new CanvasSemanticEpochMismatchError({ error: "semantic_epoch_mismatch", purpose: "root", documentId: "root",
					expectedEpoch: 2, receivedEpoch: 1, reset: "fetch_fresh_baseline" });
			}
			return super.lifecycle(request);
		}
	}
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new RootFenceTransport();
	const parsed = parseCanvasBytes(bytes("root fence"));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	transport.docs.set("canvas-root-fence", createCanvasDocument(parsed.data));
	transport.paths.set("canvas-root-fence", "Old.canvas");
	transport.generation.set("canvas-root-fence", 1);
	transport.epoch.set("canvas-root-fence", 1);
	projection.files.set("Old.canvas", bytes("root fence"));
	let rootEpoch = 1;
	let recoveries = 0;
	const catalog: Array<[string, SemanticPathRef]> = [["Old.canvas", {
		documentId: "canvas-root-fence", kind: "canvas", format: "json-canvas", formatVersion: 1,
	}]];
	const first = new CanvasManager("generation", persistence, transport, projection, Date.now, 32,
		undefined, undefined, () => rootEpoch, async (minimum) => {
			recoveries++;
			rootEpoch = minimum;
		});
	await first.initialize(catalog);
	await assert.rejects(first.rename("canvas-root-fence", "Old.canvas", "New.canvas"), /rebound/);
	const stored = [...persistence.lifecycle.values()][0];
	assert.ok(stored);
	assert.equal(stored!.rootEpoch, 2);
	assert.equal(stored!.attempts, 0);
	assert.equal(recoveries, 1);
	first.destroy();

	const second = new CanvasManager("generation", persistence, transport, projection, Date.now, 32,
		undefined, undefined, () => rootEpoch);
	await second.initialize(catalog);
	await waitFor(() => persistence.lifecycle.size === 0);
	assert.equal(transport.attempts, 2);
	second.destroy();
	transport.docs.get("canvas-root-fence")?.destroy();
});

s.test("Canvas replacement commits rebound lifecycle intent before a simulated crash", async () => {
	class CrashAfterReplacementPersistence extends MemoryPersistence {
		crash = true;
		override async replaceCanvasSemanticEpoch(value: StoredCanvasEpochReplacement) {
			await super.replaceCanvasSemanticEpoch(value);
			if (this.crash) {
				this.crash = false;
				throw new Error("simulated crash after replacement commit");
			}
		}
	}
	class BodyFenceTransport extends MemoryTransport {
		attempts = 0;
		override async lifecycle(request: CanvasLifecycleRequest) {
			this.attempts++;
			if (request.bodyEpoch === 1) {
				this.epoch.set(request.documentId, 2);
				throw new CanvasSemanticEpochMismatchError({ error: "semantic_epoch_mismatch", purpose: "body", documentId: request.documentId,
					expectedEpoch: 2, receivedEpoch: 1, reset: "fetch_fresh_baseline" });
			}
			return super.lifecycle(request);
		}
	}
	const persistence = new CrashAfterReplacementPersistence();
	const projection = new MemoryProjection();
	const transport = new BodyFenceTransport();
	const parsed = parseCanvasBytes(bytes("body fence"));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	transport.docs.set("canvas-body-fence", createCanvasDocument(parsed.data));
	transport.paths.set("canvas-body-fence", "Fence.canvas");
	transport.generation.set("canvas-body-fence", 1);
	transport.epoch.set("canvas-body-fence", 1);
	projection.files.set("Fence.canvas", bytes("body fence"));
	const catalog: Array<[string, SemanticPathRef]> = [["Fence.canvas", {
		documentId: "canvas-body-fence", kind: "canvas", format: "json-canvas", formatVersion: 1,
	}]];
	const first = new CanvasManager("generation", persistence, transport, projection);
	await first.initialize(catalog);
	await assert.rejects(first.delete("canvas-body-fence"), /simulated crash/);
	const committed = [...persistence.lifecycle.values()][0];
	assert.ok(committed, "the lifecycle intent must be in the same committed replacement transaction");
	assert.equal(committed!.bodyEpoch, 2, "no old-epoch lifecycle row survives the crash boundary");
	assert.equal((persistence.documents.get("canvas-body-fence") as { bodyEpoch?: number })?.bodyEpoch, 2);
	first.destroy();

	const second = new CanvasManager("generation", persistence, transport, projection);
	await second.initialize(catalog);
	await waitFor(() => persistence.lifecycle.size === 0);
	assert.equal(transport.attempts, 3,
		"one exact old-identity probe precedes the fresh-epoch restart submission");
	second.destroy();
	transport.docs.get("canvas-body-fence")?.destroy();
});

s.test("committed Canvas rename survives body compaction replay and restart catalog recovery", async () => {
	class LostCommittedLifecycleTransport extends MemoryTransport {
		attempts = 0;
		private readonly receipts = new Map<string, Awaited<ReturnType<MemoryTransport["lifecycle"]>>>();
		override async lifecycle(request: CanvasLifecycleRequest) {
			this.attempts++;
			const replay = this.receipts.get(request.operationId);
			if (replay) return replay;
			const receipt = await super.lifecycle(request);
			if (request.kind === "rename" && request.toPath) {
				this.paths.set(request.documentId, request.toPath);
			}
			this.receipts.set(request.operationId, receipt);
			throw new Error("response lost after durable Canvas lifecycle commit");
		}
	}
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new LostCommittedLifecycleTransport();
	const parsed = parseCanvasBytes(bytes("committed lifecycle"));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	transport.docs.set("canvas-committed-lifecycle", createCanvasDocument(parsed.data));
	transport.paths.set("canvas-committed-lifecycle", "Committed.canvas");
	transport.generation.set("canvas-committed-lifecycle", 1);
	transport.epoch.set("canvas-committed-lifecycle", 1);
	projection.files.set("Committed.canvas", bytes("committed lifecycle"));
	const catalog: Array<[string, SemanticPathRef]> = [["Committed.canvas", {
		documentId: "canvas-committed-lifecycle", kind: "canvas", format: "json-canvas", formatVersion: 1,
	}]];
	const first = new CanvasManager("generation", persistence, transport, projection);
	await first.initialize(catalog);
	await assert.rejects(first.rename("canvas-committed-lifecycle", "Committed.canvas", "Renamed.canvas"),
		/response lost/);
	assert.equal(persistence.lifecycle.size, 1, "lost response retains the immutable old request");

	transport.epoch.set("canvas-committed-lifecycle", 2);
	await first.recoverSemanticEpoch("canvas-committed-lifecycle", 2);
	assert.equal(transport.attempts, 2, "replacement probes the exact old operation identity once");
	assert.equal(persistence.lifecycle.size, 0,
		"the matching durable replay retires the row instead of inventing a conflicting digest");
	assert.equal(first.documentIdForPath("Committed.canvas"), "canvas-committed-lifecycle",
		"a lost response cannot speculate the local root rename before catalog recovery");
	first.destroy();

	projection.files.set("Renamed.canvas", bytes("committed lifecycle"));
	const restartedCatalog: Array<[string, SemanticPathRef]> = [["Renamed.canvas", {
		documentId: "canvas-committed-lifecycle", kind: "canvas", format: "json-canvas", formatVersion: 1,
	}]];
	const second = new CanvasManager("generation", persistence, transport, projection);
	await second.initialize(restartedCatalog);
	await delay(550);
	assert.equal(transport.attempts, 2, "restart has no immortal rewritten operation to retry");
	assert.equal(second.documentIdForPath("Committed.canvas"), null);
	assert.equal(second.documentIdForPath("Renamed.canvas"), "canvas-committed-lifecycle",
		"restart adopts the authoritative root path produced by the committed rename");
	second.destroy();
	transport.docs.get("canvas-committed-lifecycle")?.destroy();
});

s.test("retires a promotion whose fresh semantic identity is already occupied", async () => {
	class OccupiedPromotionTransport extends MemoryTransport {
		attempts = 0;
		override async promote(request: CanvasPromotionRequest): Promise<CanvasAuthorityReceipt> {
			this.attempts++;
			throw new CanvasSemanticEpochMismatchError({ error: "semantic_epoch_mismatch", purpose: "body", documentId: request.documentId,
				expectedEpoch: 2, receivedEpoch: 1, reset: "fetch_fresh_baseline" });
		}
	}
	const persistence = new MemoryPersistence();
	const transport = new OccupiedPromotionTransport();
	const manager = new CanvasManager("generation", persistence, transport, new MemoryProjection());
	await manager.initialize([]);
	const source = bytes("occupied promotion");
	await assert.rejects(manager.promote("Occupied.canvas", source, {
		revision: "attachment-revision", hash: await sha256BytesHex(source), size: source.byteLength,
	}), /retired/);
	assert.equal(persistence.lifecycle.size, 0, "an occupied create identity cannot become an immortal retry");
	await delay(550);
	assert.equal(transport.attempts, 1);
	manager.destroy();
});

s.test("does not resurrect a demotion retired by atomic body-epoch replacement", async () => {
	class DemotionBodyFenceTransport extends MemoryTransport {
		attempts = 0;
		override async demote(request: CanvasDemotionRequest): Promise<CanvasAuthorityReceipt> {
			this.attempts++;
			if (request.bodyEpoch === 1) {
				if ((this.epoch.get(request.documentId) ?? 1) === 1) {
					const changed = parseCanvasBytes(bytes("authoritative content changed"));
					assert.equal(changed.kind, "valid");
					if (changed.kind !== "valid") throw new Error("invalid fixture");
					this.docs.get(request.documentId)?.destroy();
					this.docs.set(request.documentId, createCanvasDocument(changed.data));
					this.epoch.set(request.documentId, 2);
					this.generation.set(request.documentId, 2);
				}
				throw new CanvasSemanticEpochMismatchError({ error: "semantic_epoch_mismatch", purpose: "body",
					documentId: request.documentId, expectedEpoch: 2, receivedEpoch: 1,
					reset: "fetch_fresh_baseline" });
			}
			return super.demote(request);
		}
	}
	const persistence = new MemoryPersistence();
	const projection = new MemoryProjection();
	const transport = new DemotionBodyFenceTransport();
	const parsed = parseCanvasBytes(bytes("demotion source"));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	transport.docs.set("canvas-demotion-fence", createCanvasDocument(parsed.data));
	transport.paths.set("canvas-demotion-fence", "Demotion.canvas");
	transport.generation.set("canvas-demotion-fence", 1);
	transport.epoch.set("canvas-demotion-fence", 1);
	projection.files.set("Demotion.canvas", bytes("demotion source"));
	const manager = new CanvasManager("generation", persistence, transport, projection);
	await manager.initialize([["Demotion.canvas", {
		documentId: "canvas-demotion-fence", kind: "canvas", format: "json-canvas", formatVersion: 1,
	}]]);
	await assert.rejects(manager.demote("Demotion.canvas"), /retired/);
	assert.equal(persistence.lifecycle.size, 0,
		"atomic replacement retirement must not be overwritten by the outer mismatch handler");
	await delay(550);
	assert.equal(transport.attempts, 2,
		"only the original request and immutable-outcome probe run; no rebound demotion is queued");
	manager.destroy();
	for (const doc of transport.docs.values()) doc.destroy();
});

s.test("rejects a candidate receipt from a different Canvas epoch", async () => {
	class StaleReceiptTransport extends MemoryTransport {
		override async submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt> {
			const receipt = await super.submit(candidate);
			return { ...receipt, bodyEpoch: receipt.bodyEpoch + 1 };
		}
	}
	const persistence = new MemoryPersistence();
	const manager = new CanvasManager("generation", persistence, new StaleReceiptTransport(), new MemoryProjection());
	await manager.initialize([]);
	await assert.rejects(manager.ingest("Fenced.canvas", bytes("fenced")), /receipt mismatch/);
	assert.equal(persistence.candidates.size, 1, "an untrusted receipt cannot retire durable intent");
	assert.equal([...persistence.candidates.values()][0]?.bodyEpoch, 1);
	manager.destroy();
});

s.test("sends Canvas candidate epochs and exposes a typed HTTP epoch fence", async () => {
	let sentEpoch: string | undefined;
	const transport = new CanvasHttpTransport("https://worker.example", "vault", "token", async (request) => {
		sentEpoch = request.headers?.["x-yaos-body-epoch"];
		return {
			status: 409,
			headers: { "content-type": "application/json" },
			arrayBuffer: new ArrayBuffer(0),
			text: "",
			json: { error: "semantic_epoch_mismatch", purpose: "body", documentId: "canvas-http",
				expectedEpoch: 4, receivedEpoch: 3, reset: "fetch_fresh_baseline" },
		};
	});
	const candidate: StoredCanvasCandidate = { candidateId: "candidate", documentId: "canvas-http", bodyEpoch: 3,
		candidateDigest: "a".repeat(64), encodedUpdate: new ArrayBuffer(1), capturedAt: 1,
		attempts: 0, lastAttemptAt: null };
	await assert.rejects(transport.submit(candidate), (error: unknown) =>
		error instanceof CanvasSemanticEpochMismatchError
			&& error.mismatch.expectedEpoch === 4 && error.mismatch.receivedEpoch === 3);
	assert.equal(sentEpoch, "3");
});

s.test("sends both Canvas lifecycle epochs and exposes typed root fencing", async () => {
	let sentBodyEpoch: unknown;
	let sentRootEpoch: unknown;
	const transport = new CanvasHttpTransport("https://worker.example", "vault", "token", async (request) => {
		const sent = JSON.parse(String(request.body)) as Record<string, unknown>;
		sentBodyEpoch = sent.bodyEpoch;
		sentRootEpoch = sent.rootEpoch;
		return { status: 409, headers: { "content-type": "application/json" }, arrayBuffer: new ArrayBuffer(0), text: "",
			json: { error: "semantic_epoch_mismatch", purpose: "root", documentId: "root",
				expectedEpoch: 8, receivedEpoch: 7, reset: "fetch_fresh_baseline" } };
	});
	await assert.rejects(transport.lifecycle({ operationId: "operation", requestDigest: "a".repeat(64),
		documentId: "canvas-http", bodyEpoch: 3, rootEpoch: 7, kind: "delete" }), (error: unknown) =>
		error instanceof CanvasSemanticEpochMismatchError && error.mismatch.purpose === "root"
			&& error.mismatch.expectedEpoch === 8 && error.mismatch.receivedEpoch === 7);
	assert.equal(sentBodyEpoch, 3);
	assert.equal(sentRootEpoch, 7);
});

await s.done();
