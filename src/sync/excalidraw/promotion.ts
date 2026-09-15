import { EXCALIDRAW_PROTOCOL_VERSION, canonicalExcalidrawJson } from "@shared/excalidrawProtocol";
import { randomId } from "../../utils/randomId";
import { sha256TextHex } from "../../utils/sha256";
import type { ExcalidrawPersistencePort } from "./persistence";
import type { ExcalidrawPromotionTransportPort } from "./transport";
import type { ExcalidrawElementRecord, ExcalidrawSceneMetadata, ExcalidrawSourceAuthority,
	StoredExcalidrawPromotionIntent } from "./types";

export interface ExcalidrawPromotionInput {
	drawingId: string;
	path: string;
	source: ExcalidrawSourceAuthority;
	elements: ExcalidrawElementRecord[];
	metadata: ExcalidrawSceneMetadata;
}

async function digest<T extends { requestDigest: string }>(value: Omit<T, "requestDigest">): Promise<T> {
	return { ...value, requestDigest: await sha256TextHex(canonicalExcalidrawJson(value)) } as T;
}

/** Durable three-effect promotion saga. Every response-loss retry reuses exact operation identities and digests. */
export class ExcalidrawPromotionCoordinator {
	constructor(private readonly persistence: ExcalidrawPersistencePort,
		private readonly transport: ExcalidrawPromotionTransportPort, private readonly now: () => number = Date.now) {}

	async create(input: ExcalidrawPromotionInput): Promise<void> {
		const prepareOperationId = randomId(32);
		const initializeOperationId = randomId(32);
		const initialize = await digest<StoredExcalidrawPromotionIntent["initialize"]>({
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: initializeOperationId,
			prepareOperationId, drawingEpoch: 1, elements: input.elements, metadata: input.metadata,
		});
		const prepare = await digest<StoredExcalidrawPromotionIntent["prepare"]>({
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: prepareOperationId,
			drawingId: input.drawingId, path: input.path, source: input.source,
			initializationRequestDigest: initialize.requestDigest,
		});
		const finalize = await digest<StoredExcalidrawPromotionIntent["finalize"]>({
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: randomId(32), prepareOperationId,
			initializationOperationId: initializeOperationId, initializationRequestDigest: initialize.requestDigest,
		});
		const timestamp = this.now();
		const intent: StoredExcalidrawPromotionIntent = { drawingId: input.drawingId, path: input.path,
			prepare, initialize, finalize, stage: "captured", createdAt: timestamp, updatedAt: timestamp };
		await this.persistence.putPromotionIntent(intent);
		await this.resume(intent);
	}

	async resumeAll(): Promise<void> {
		for (const intent of await this.persistence.listPromotionIntents()) await this.resume(intent);
	}

	private async resume(intent: StoredExcalidrawPromotionIntent): Promise<void> {
		if (intent.stage === "captured") {
			const receipt = await this.transport.preparePromotion(intent.prepare);
			if (receipt.operationId !== intent.prepare.operationId || receipt.requestDigest !== intent.prepare.requestDigest
				|| receipt.drawingId !== intent.drawingId || receipt.path !== intent.path || receipt.drawingEpoch !== 1) {
				throw new Error("Excalidraw promotion prepare receipt mismatch");
			}
			intent = { ...intent, stage: "prepared", updatedAt: this.now() };
			await this.persistence.putPromotionIntent(intent);
		}
		if (intent.stage === "prepared") {
			const receipt = await this.transport.initializeDrawing(intent.drawingId, intent.initialize);
			if (receipt.operationId !== intent.initialize.operationId
				|| receipt.requestDigest !== intent.initialize.requestDigest || receipt.drawingId !== intent.drawingId
				|| receipt.drawingEpoch !== 1) throw new Error("Excalidraw initialization receipt mismatch");
			intent = { ...intent, stage: "initialized", updatedAt: this.now() };
			await this.persistence.putPromotionIntent(intent);
		}
		const receipt = await this.transport.finalizePromotion(intent.drawingId, intent.finalize);
		if (receipt.operationId !== intent.finalize.operationId || receipt.requestDigest !== intent.finalize.requestDigest
			|| receipt.drawingId !== intent.drawingId || receipt.path !== intent.path || receipt.drawingEpoch !== 1) {
			throw new Error("Excalidraw promotion finalize receipt mismatch");
		}
		await this.persistence.deletePromotionIntent(intent.drawingId);
	}
}
