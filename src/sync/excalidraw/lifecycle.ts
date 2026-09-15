import { EXCALIDRAW_PROTOCOL_VERSION, canonicalExcalidrawJson, excalidrawRequestDigestInput } from "@shared/excalidrawProtocol";
import { randomId } from "../../utils/randomId";
import { sha256TextHex } from "../../utils/sha256";
import type { ExcalidrawPersistencePort } from "./persistence";
import type { ExcalidrawLifecycleTransportPort } from "./transport";
import type { ExcalidrawLifecycleRequest, StoredExcalidrawLifecycleIntent } from "./types";

export class ExcalidrawLifecycleCoordinator {
	private readonly running = new Set<string>();

	constructor(private readonly persistence: ExcalidrawPersistencePort,
		private readonly transport: ExcalidrawLifecycleTransportPort, private readonly now: () => number = Date.now) {}

	async rename(drawingId: string, drawingEpoch: number, fromPath: string, toPath: string): Promise<void> {
		await this.create({ protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: randomId(32), requestDigest: "",
			drawingId, drawingEpoch, kind: "rename", fromPath, toPath });
	}

	async delete(drawingId: string, drawingEpoch: number, path: string): Promise<void> {
		await this.create({ protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: randomId(32), requestDigest: "",
			drawingId, drawingEpoch, kind: "delete", path });
	}

	async resumeAll(): Promise<void> {
		for (const intent of await this.persistence.listLifecycleIntents()) await this.submit(intent);
	}

	private async create(unsigned: ExcalidrawLifecycleRequest): Promise<void> {
		const request = { ...unsigned, requestDigest: await sha256TextHex(canonicalExcalidrawJson(
			excalidrawRequestDigestInput(unsigned),
		)) } as ExcalidrawLifecycleRequest;
		const intent: StoredExcalidrawLifecycleIntent = { request, createdAt: this.now(), attempts: 0, lastAttemptAt: null };
		await this.persistence.putLifecycleIntent(intent);
		await this.submit(intent);
	}

	private async submit(intent: StoredExcalidrawLifecycleIntent): Promise<void> {
		if (this.running.has(intent.request.operationId)) return;
		this.running.add(intent.request.operationId);
		try {
			const attempted = { ...intent, attempts: intent.attempts + 1, lastAttemptAt: this.now() };
			await this.persistence.putLifecycleIntent(attempted);
			const receipt = await this.transport.lifecycle(attempted.request);
			if (receipt.operationId !== attempted.request.operationId
				|| receipt.requestDigest !== attempted.request.requestDigest
				|| receipt.drawingId !== attempted.request.drawingId
				|| receipt.drawingEpoch !== attempted.request.drawingEpoch
				|| receipt.kind !== attempted.request.kind) throw new Error("Excalidraw lifecycle receipt mismatch");
			await this.persistence.deleteLifecycleIntent(attempted.request.operationId);
		} finally { this.running.delete(intent.request.operationId); }
	}
}
