import { strict as assert } from "node:assert";
import type { ExcalidrawHostSnapshot, ExcalidrawViewBinding } from "../../src/host/obsidianExcalidrawHostAdapter";
import { canonicalExcalidrawJson } from "../../src/sync/excalidraw/canonical";
import { ExcalidrawSameVaultEngine } from "../../src/sync/excalidraw/engine";
import { ExcalidrawIndexedDbPersistence, MemoryExcalidrawPersistence } from "../../src/sync/excalidraw/persistence";
import { SameVaultExcalidrawResources, type ExcalidrawResourceStorePort } from "../../src/sync/excalidraw/resources";
import type { ExcalidrawRecoveryResult, ExcalidrawRoomSubscription,
	ExcalidrawTransportPort } from "../../src/sync/excalidraw/transport";
import type { ExcalidrawBatchReceipt, ExcalidrawBatchRequest, ExcalidrawElementRecord,
	ExcalidrawNativeFile, ExcalidrawRoomEvent, ExcalidrawSnapshot } from "../../src/sync/excalidraw/types";
import { sha256TextHex } from "../../src/utils/sha256";
import { suite } from "../harness.ts";
import { FakeIndexedDb } from "../mocks/indexedDb";

const s = suite("excalidraw-engine");

if (!("window" in globalThis)) Object.assign(globalThis, { window: globalThis });

function element(id: string, version: number, nonce: number, text: string, isDeleted = false): ExcalidrawElementRecord {
	return { id, version, versionNonce: nonce, isDeleted, index: id, type: "rectangle", text };
}

const emptyMetadata = { resourceManifest: { version: 1 as const, entries: [] } };

class Resources implements ExcalidrawResourceStorePort {
	failUploads = false;
	async put(_hash: string, _bytes: Uint8Array, _mime: string) {}
	async get(_hash: string, _size: number, _mime: string) { return null; }
	async resolveVaultResource() { return null; }
}

class Host implements ExcalidrawViewBinding {
	elements: ExcalidrawElementRecord[];
	files: ExcalidrawNativeFile[] = [];
	applies: Array<{ elements: ExcalidrawElementRecord[]; files: ExcalidrawNativeFile[] }> = [];
	constructor(elements: ExcalidrawElementRecord[]) { this.elements = elements; }
	proof() { return { leaf: {} as never, view: {}, file: { path: "Drawing.md" } as never, path: "Drawing.md" }; }
	capabilities() { return { detect: true, sceneHook: true, readIncludingDeleted: true, applyNever: true,
		readFiles: true, addFiles: true, realtime: true, reason: null }; }
	async read(): Promise<ExcalidrawHostSnapshot> {
		return { proof: this.proof(), elements: structuredClone(this.elements), files: structuredClone(this.files),
			suppressedRevisionKeys: new Set() };
	}
	async apply(elements: readonly ExcalidrawElementRecord[], files: readonly ExcalidrawNativeFile[]) {
		this.elements = structuredClone([...elements]);
		this.applies.push({ elements: structuredClone([...elements]), files: structuredClone([...files]) });
		return true;
	}
	release() {}
}

class Transport implements ExcalidrawTransportPort {
	submitted: ExcalidrawBatchRequest[] = [];
	failSubmissions = 0;
	callback: ((event: ExcalidrawRoomEvent) => void) | null = null;
	settleOnSubmit = true;
	constructor(public recovery: ExcalidrawRecoveryResult) {}
	async recover() { return this.recovery; }
	async submit(drawingId: string, request: ExcalidrawBatchRequest): Promise<ExcalidrawBatchReceipt> {
		this.submitted.push(structuredClone(request));
		if (this.failSubmissions-- > 0) throw new Error("response lost");
		if (this.settleOnSubmit) {
			const before = this.recovery.kind === "snapshot" ? this.recovery.snapshot.sequence
				: this.recovery.kind === "current" ? this.recovery.sequence : this.recovery.page.through;
			const event: ExcalidrawRoomEvent = { protocolVersion: 1, drawingEpoch: request.drawingEpoch,
				sequence: before + 1, operationId: request.operationId, elements: request.elements,
				...(request.metadata ? { metadata: request.metadata } : {}) };
			this.recovery = { kind: "replay", page: { protocolVersion: 1, drawingId, drawingEpoch: request.drawingEpoch,
				after: before, through: before + 1, compactedThrough: 0, snapshotRequired: false,
				events: [event], nextCursor: null } };
		}
		return { protocolVersion: 1, operationId: request.operationId, requestDigest: request.requestDigest,
			drawingId, drawingEpoch: request.drawingEpoch, sequence: 2, acceptedElementIds: request.elements.map((value) => value.id),
			staleElementIds: [], metadataAccepted: true, replayed: this.submitted.length > 1 };
	}
	async subscribe(_drawingId: string, _drawingEpoch: number, _afterSequence: number,
		callbacks: { onEvent(event: ExcalidrawRoomEvent): void }): Promise<ExcalidrawRoomSubscription> {
		this.callback = callbacks.onEvent; return { close: () => { this.callback = null; } };
	}
}

function snapshot(elements: ExcalidrawElementRecord[], epoch = 1, sequence = 1): ExcalidrawSnapshot {
	return { protocolVersion: 1, drawingId: "drawing1", drawingEpoch: epoch, sequence,
		compactedThrough: 0, elements, metadata: emptyMetadata };
}

function scene(elements: ExcalidrawElementRecord[]): ExcalidrawHostSnapshot {
	return { proof: { leaf: {} as never, view: {}, file: { path: "Drawing.md" } as never, path: "Drawing.md" },
		elements, files: [], suppressedRevisionKeys: new Set() };
}

function engine(host: Host, persistence: MemoryExcalidrawPersistence, transport: Transport,
	resourceStore: Resources = new Resources()) {
	return new ExcalidrawSameVaultEngine({ drawingId: "drawing1", drawingEpoch: 1, path: "Drawing.md",
		persistence, transport, host, resources: new SameVaultExcalidrawResources(resourceStore), now: () => 10 });
}

s.test("snapshot recovery merges by lower nonce, applies atomically, and submits one exact-digest operation", async () => {
	const local = element("element1", 7, 200, "local-high-nonce");
	const remote = element("element1", 7, 100, "remote-low-nonce");
	const second = element("element2", 1, 50, "second");
	const host = new Host([local]);
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new Transport({ kind: "snapshot", snapshot: snapshot([remote]) });
	const sync = engine(host, persistence, transport);
	await sync.start();
	assert.equal(host.elements[0]?.text, "remote-low-nonce");
	host.elements = [element("element1", 8, 90, "edited"), second];
	await sync.capture(scene(host.elements));
	assert.equal(transport.submitted.length, 1);
	assert.deepEqual(transport.submitted[0]?.elements.map((value) => value.id), ["element1", "element2"],
		"one host callback remains one atomic request");
	const submitted = transport.submitted[0]!;
	const { requestDigest: _requestDigest, ...digestInput } = submitted;
	assert.equal(submitted.requestDigest, await sha256TextHex(canonicalExcalidrawJson(digestInput)));
	assert.equal((await persistence.listOutbox("drawing1")).length, 0);
	sync.stop();
});

s.test("response loss leaves the exact operation durable and retry reuses its identity", async () => {
	const base = element("element1", 1, 10, "base");
	const host = new Host([base]);
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new Transport({ kind: "snapshot", snapshot: snapshot([base]) });
	transport.failSubmissions = 1;
	const sync = engine(host, persistence, transport);
	await sync.start();
	host.elements = [element("element1", 2, 20, "offline")];
	await sync.capture(scene(host.elements));
	const durable = await persistence.listOutbox("drawing1");
	assert.equal(durable.length, 1);
	assert.equal(durable[0]?.attempts, 1);
	await sync.flushOutbox();
	assert.equal(transport.submitted.length, 2);
	assert.equal(transport.submitted[0]?.operationId, transport.submitted[1]?.operationId);
	assert.equal(transport.submitted[0]?.requestDigest, transport.submitted[1]?.requestDigest);
	assert.equal((await persistence.listOutbox("drawing1")).length, 0);
	sync.stop();
});

s.test("a receipt cannot retire its outbox row until replay durably settles that sequence", async () => {
	const base = element("element1", 1, 10, "base");
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new Transport({ kind: "snapshot", snapshot: snapshot([base]) });
	transport.settleOnSubmit = false;
	const host = new Host([base]);
	const sync = engine(host, persistence, transport);
	await sync.start();
	host.elements = [element("element1", 2, 20, "pending-event")];
	await assert.rejects(sync.capture(scene(host.elements)), /canonical settlement has not caught up/);
	const durable = await persistence.listOutbox("drawing1");
	assert.equal(durable.length, 1);
	const request = durable[0]!.operation;
	transport.recovery = { kind: "replay", page: { protocolVersion: 1, drawingId: "drawing1", drawingEpoch: 1,
		after: 1, through: 2, compactedThrough: 0, snapshotRequired: false, nextCursor: null,
		events: [{ protocolVersion: 1, sequence: 2, operationId: request.operationId, drawingEpoch: 1,
			elements: request.elements, metadata: request.metadata }] } };
	await sync.flushOutbox();
	assert.equal((await persistence.getProjection("drawing1"))?.sequence, 2);
	assert.deepEqual(await persistence.listOutbox("drawing1"), []);
	sync.stop();
});

s.test("an epoch replacement preserves old outbox bytes as an inspectable alternative before retirement", async () => {
	const base = element("element1", 1, 10, "base");
	const persistence = new MemoryExcalidrawPersistence();
	await persistence.putProjection({ format: 1, drawingId: "drawing1", drawingEpoch: 1, sequence: 1,
		elements: [base], metadata: emptyMetadata, updatedAt: 1 });
	const operation: ExcalidrawBatchRequest = { protocolVersion: 1, operationId: "oldoperation1",
		requestDigest: "a".repeat(64), drawingEpoch: 1, elements: [element("element1", 2, 20, "offline-old-epoch")],
		metadata: emptyMetadata };
	await persistence.putOutbox({ drawingId: "drawing1", operation, createdAt: 2, attempts: 0, lastAttemptAt: null });
	const transport = new Transport({ kind: "snapshot", snapshot: snapshot([base], 2, 1) });
	const sync = engine(new Host([base]), persistence, transport);
	await sync.start();
	assert.deepEqual(await persistence.listOutbox("drawing1"), []);
	const alternatives = await persistence.listAlternatives("drawing1");
	assert.equal(alternatives[0]?.operation.operationId, "oldoperation1");
	assert.equal(alternatives[0]?.fromDrawingEpoch, 1);
	assert.equal(alternatives[0]?.currentDrawingEpoch, 2);
	assert.equal(sync.status().phase, "degraded");
	sync.stop();
});

s.test("resource upload failure still durably captures the scene and advances baseline only after outbox creation", async () => {
	const base = element("element1", 1, 10, "base");
	const host = new Host([base]);
	host.files = [{ id: "resource1", dataURL: "data:image/png;base64,YQ==", mimeType: "image/png", created: 1 }];
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new Transport({ kind: "snapshot", snapshot: snapshot([base]) });
	const store = new Resources();
	store.put = async () => { throw new Error("CAS unavailable"); };
	const sync = engine(host, persistence, transport, store);
	await sync.start();
	const changed = scene([element("element1", 2, 20, "scene survives missing resource")]);
	changed.files = host.files;
	await sync.capture(changed);
	assert.equal(transport.submitted.length, 1);
	await sync.capture(changed);
	assert.equal(transport.submitted.length, 1, "baseline advances only after the durable operation exists");
	sync.stop();
});

s.test("replays monotonic events and applies tombstones without waiting for opaque file sync", async () => {
	const base = element("element1", 1, 10, "base");
	const tombstone = element("element1", 2, 9, "deleted", true);
	const persistence = new MemoryExcalidrawPersistence();
	await persistence.putProjection({ format: 1, drawingId: "drawing1", drawingEpoch: 1, sequence: 1,
		elements: [base], metadata: emptyMetadata, updatedAt: 1 });
	const event: ExcalidrawRoomEvent = { protocolVersion: 1, drawingEpoch: 1, sequence: 2,
		operationId: "operation1", elements: [tombstone] };
	const transport = new Transport({ kind: "replay", page: { protocolVersion: 1, drawingId: "drawing1",
		drawingEpoch: 1, after: 1, through: 2, compactedThrough: 0, snapshotRequired: false,
		events: [event], nextCursor: null } });
	const host = new Host([base]);
	const sync = engine(host, persistence, transport);
	await sync.start();
	assert.equal(host.elements[0]?.isDeleted, true);
	assert.equal(sync.status().sequence, 2);
	sync.stop();
});

s.test("outbox and projection survive a client restart in generation-scoped IndexedDB", async () => {
	const indexedDb = new FakeIndexedDb();
	const first = new ExcalidrawIndexedDbPersistence("vault1:generation1:folder1", indexedDb);
	const operation: ExcalidrawBatchRequest = { protocolVersion: 1, operationId: "operation1",
		requestDigest: "a".repeat(64), drawingEpoch: 1, elements: [element("element1", 2, 10, "pending")],
		metadata: emptyMetadata };
	await first.putProjection({ format: 1, drawingId: "drawing1", drawingEpoch: 1, sequence: 1,
		elements: [element("element1", 1, 20, "base")], metadata: emptyMetadata, updatedAt: 1 });
	await first.putOutbox({ drawingId: "drawing1", operation, createdAt: 2, attempts: 0, lastAttemptAt: null });
	const restarted = new ExcalidrawIndexedDbPersistence("vault1:generation1:folder1", indexedDb);
	assert.equal((await restarted.getProjection("drawing1"))?.sequence, 1);
	assert.equal((await restarted.listOutbox("drawing1"))[0]?.operation.operationId, "operation1");
	await restarted.markOutboxAttempt("operation1", 1, 3);
	assert.equal((await restarted.listOutbox("drawing1"))[0]?.attempts, 1);
	await restarted.deleteOutbox("operation1");
	assert.deepEqual(await restarted.listOutbox("drawing1"), []);
});

await s.done();
