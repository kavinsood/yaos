import { strict as assert } from "node:assert";
import { MemoryExcalidrawPersistence } from "../../src/sync/excalidraw/persistence";
import { ExcalidrawPromotionCoordinator } from "../../src/sync/excalidraw/promotion";
import type { ExcalidrawPromotionTransportPort } from "../../src/sync/excalidraw/transport";
import type { ExcalidrawBatchReceipt, ExcalidrawInitializeRequest, ExcalidrawPromotionFinalizeRequest,
	ExcalidrawPromotionPrepareRequest } from "../../src/sync/excalidraw/types";
import { suite } from "../harness.ts";

const s = suite("excalidraw-promotion");

class Transport implements ExcalidrawPromotionTransportPort {
	prepare: ExcalidrawPromotionPrepareRequest[] = [];
	initialize: ExcalidrawInitializeRequest[] = [];
	finalize: ExcalidrawPromotionFinalizeRequest[] = [];
	failInitialize = true;
	failFinalize = true;
	async preparePromotion(request: ExcalidrawPromotionPrepareRequest) {
		this.prepare.push(structuredClone(request));
		return { ...request, drawingEpoch: 1 as const, preparePermitId: "permit1", replayed: this.prepare.length > 1 };
	}
	async initializeDrawing(drawingId: string, request: ExcalidrawInitializeRequest): Promise<ExcalidrawBatchReceipt> {
		this.initialize.push(structuredClone(request));
		if (this.failInitialize) { this.failInitialize = false; throw new Error("initialize response lost"); }
		return { protocolVersion: 1, operationId: request.operationId, requestDigest: request.requestDigest,
			drawingId, drawingEpoch: 1, sequence: 1, acceptedElementIds: request.elements.map((element) => element.id),
			staleElementIds: [], metadataAccepted: true, replayed: this.initialize.length > 1 };
	}
	async finalizePromotion(drawingId: string, request: ExcalidrawPromotionFinalizeRequest) {
		this.finalize.push(structuredClone(request));
		if (this.failFinalize) { this.failFinalize = false; throw new Error("finalize response lost"); }
		return { protocolVersion: 1 as const, operationId: request.operationId, requestDigest: request.requestDigest,
			drawingId, drawingEpoch: 1 as const, path: "Drawing.md", vaultSequence: 1, rootGeneration: 1,
			replayed: this.finalize.length > 1 };
	}
}

s.test("promotion resumes each lost-response boundary with exact durable operation identities", async () => {
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new Transport();
	const coordinator = new ExcalidrawPromotionCoordinator(persistence, transport, () => 10);
	await assert.rejects(coordinator.create({ drawingId: "drawing1", path: "Drawing.md",
		source: { kind: "attachment", revision: "revision1", contentHash: "a".repeat(64), size: 10 },
		elements: [{ id: "element1", version: 1, versionNonce: 10, isDeleted: false }],
		metadata: { resourceManifest: { version: 1, entries: [] } } }), /response lost/);
	assert.equal((await persistence.listPromotionIntents())[0]?.stage, "prepared");
	await assert.rejects(coordinator.resumeAll(), /finalize response lost/);
	assert.equal((await persistence.listPromotionIntents())[0]?.stage, "initialized");
	await coordinator.resumeAll();
	assert.equal(transport.prepare.length, 1, "durable prepared stage never repeats the prior effect");
	assert.equal(transport.initialize.length, 2);
	assert.equal(transport.initialize[0]?.operationId, transport.initialize[1]?.operationId);
	assert.equal(transport.initialize[0]?.requestDigest, transport.initialize[1]?.requestDigest);
	assert.equal(transport.finalize.length, 2);
	assert.equal(transport.finalize[0]?.operationId, transport.finalize[1]?.operationId);
	assert.deepEqual(await persistence.listPromotionIntents(), []);
});

await s.done();
