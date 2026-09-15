import { canonicalExcalidrawJson } from "@shared/excalidrawProtocol";
import type { ExcalidrawPersistencePort } from "./persistence";
import type { PublicShareAuthorityEvent } from "./browserTransport";
import type { StoredExcalidrawAlternative, StoredExcalidrawOutboxOperation } from "./types";

export interface PublicShareWorkExport {
	format: "yaos-excalidraw-public-work-v1";
	publicDrawingId: string;
	exportedAt: number;
	operations: StoredExcalidrawOutboxOperation["operation"][];
}

/** Moves public edits out of the retrying outbox before authority is discarded. */
export class PublicShareWorkPreserver {
	constructor(private readonly persistence: ExcalidrawPersistencePort, private readonly publicDrawingId: string,
		private readonly now: () => number = Date.now) {}

	async preservePending(currentDrawingEpoch: number): Promise<StoredExcalidrawAlternative[]> {
		const pending = await this.persistence.listOutbox(this.publicDrawingId);
		const preserved: StoredExcalidrawAlternative[] = [];
		for (const record of pending) {
			const alternative: StoredExcalidrawAlternative = {
				alternativeId: record.operation.operationId,
				drawingId: this.publicDrawingId,
				reason: "authority_superseded",
				operation: record.operation,
				fromDrawingEpoch: record.operation.drawingEpoch,
				currentDrawingEpoch,
				preservedAt: this.now(),
			};
			await this.persistence.putAlternative(alternative);
			await this.persistence.deleteOutbox(record.operation.operationId);
			preserved.push(alternative);
		}
		return preserved;
	}

	async handleAuthority(event: PublicShareAuthorityEvent, stop: () => void,
		currentDrawingEpoch: number): Promise<StoredExcalidrawAlternative[]> {
		if (event.state === "active" && event.permission === "read-write") return [];
		stop();
		return this.preservePending(currentDrawingEpoch);
	}

	async exportPreserved(): Promise<{ value: PublicShareWorkExport; text: string }> {
		const alternatives = await this.persistence.listAlternatives(this.publicDrawingId);
		const value: PublicShareWorkExport = {
			format: "yaos-excalidraw-public-work-v1",
			publicDrawingId: this.publicDrawingId,
			exportedAt: this.now(),
			operations: alternatives.map((alternative) => structuredClone(alternative.operation)),
		};
		return { value, text: canonicalExcalidrawJson(value) };
	}
}
