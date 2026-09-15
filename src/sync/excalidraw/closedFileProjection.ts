import { randomId } from "../../utils/randomId";
import { sha256BytesHex } from "../../utils/sha256";
import type { ExcalidrawPersistencePort } from "./persistence";
import { ExcalidrawFormatAdapter, type ParsedExcalidrawContainer } from "./formatAdapter";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile,
	StoredExcalidrawProjectionPlan } from "./types";

export interface ExcalidrawDiskSnapshot {
	fileId: string;
	bytes: Uint8Array;
}

export interface ExcalidrawClosedFileDiskPort {
	read(path: string): Promise<ExcalidrawDiskSnapshot | null>;
	replaceAtomic(input: { path: string; expectedFileId: string; expectedHash: string;
		bytes: Uint8Array }): Promise<"written" | "changed" | "missing">;
	preserveAlternative(input: { path: string; drawingId: string; bytes: Uint8Array; reason: string }): Promise<boolean>;
}

export interface ExcalidrawProjectionTarget {
	drawingId: string;
	path: string;
	sequence: number;
	container: ParsedExcalidrawContainer;
	elements: ExcalidrawElementRecord[];
	files: ExcalidrawNativeFile[];
}

export type ExcalidrawProjectionResult =
	| { kind: "settled"; operationId: string }
	| { kind: "local-alternative"; operationId: string }
	| { kind: "blocked"; operationId: string; reason: string }
	| { kind: "superseded"; operationId: string };

function bytesOf(buffer: ArrayBuffer): Uint8Array { return new Uint8Array(buffer.slice(0)); }

/** Durable plan/recheck/write/verify coordinator for semantic Excalidraw files with no open view. */
export class ExcalidrawClosedFileProjectionCoordinator {
	constructor(private readonly persistence: ExcalidrawPersistencePort,
		private readonly disk: ExcalidrawClosedFileDiskPort,
		private readonly adapter = new ExcalidrawFormatAdapter(),
		private readonly captureAlternative: (drawingId: string, parsed: ParsedExcalidrawContainer) => Promise<void>,
		private readonly now: () => number = Date.now) {}

	async plan(target: ExcalidrawProjectionTarget): Promise<ExcalidrawProjectionResult> {
		const current = await this.disk.read(target.path);
		if (!current) return { kind: "blocked", operationId: "", reason: "projection path is missing" };
		const expectedDiskHash = await sha256BytesHex(current.bytes);
		const targetBytes = this.adapter.materialize(target.container, target.elements, target.files);
		const targetBuffer = new ArrayBuffer(targetBytes.byteLength);
		new Uint8Array(targetBuffer).set(targetBytes);
		const plan: StoredExcalidrawProjectionPlan = { operationId: randomId(32), drawingId: target.drawingId,
			path: target.path, expectedFileId: current.fileId, expectedDiskHash, targetBytes: targetBuffer,
			targetBytesHash: await sha256BytesHex(targetBytes), targetCanonicalSceneHash: target.container.canonicalSceneHash,
			targetSequence: target.sequence, createdAt: this.now(), attempts: 0 };
		await this.persistence.putProjectionPlan(plan);
		return this.execute(plan);
	}

	async resumeAll(): Promise<ExcalidrawProjectionResult[]> {
		const results: ExcalidrawProjectionResult[] = [];
		for (const plan of await this.persistence.listProjectionPlans()) results.push(await this.execute(plan));
		return results;
	}

	private async execute(plan: StoredExcalidrawProjectionPlan): Promise<ExcalidrawProjectionResult> {
		const current = await this.disk.read(plan.path);
		if (!current || current.fileId !== plan.expectedFileId) {
			return this.preserveChanged(plan, current, "projection file identity changed");
		}
		const currentHash = await sha256BytesHex(current.bytes);
		if (currentHash !== plan.expectedDiskHash) return this.preserveChanged(plan, current, "projection bytes changed after planning");
		const targetBytes = bytesOf(plan.targetBytes);
		const result = await this.disk.replaceAtomic({ path: plan.path, expectedFileId: plan.expectedFileId,
			expectedHash: plan.expectedDiskHash, bytes: targetBytes });
		if (result !== "written") {
			const raced = await this.disk.read(plan.path);
			return this.preserveChanged(plan, raced, `projection atomic replace reported ${result}`);
		}
		const written = await this.disk.read(plan.path);
		if (!written || written.fileId !== plan.expectedFileId || await sha256BytesHex(written.bytes) !== plan.targetBytesHash) {
			return { kind: "blocked", operationId: plan.operationId, reason: "projection write verification failed" };
		}
		const parsed = await this.adapter.parse(written.bytes);
		if (parsed.kind !== "valid" || parsed.value.canonicalSceneHash !== plan.targetCanonicalSceneHash) {
			await this.disk.preserveAlternative({ path: plan.path, drawingId: plan.drawingId,
				bytes: written.bytes, reason: "materialized projection failed semantic verification" });
			return { kind: "blocked", operationId: plan.operationId, reason: "projection semantic verification failed" };
		}
		await this.persistence.deleteProjectionPlan(plan.operationId);
		return { kind: "settled", operationId: plan.operationId };
	}

	private async preserveChanged(plan: StoredExcalidrawProjectionPlan, current: ExcalidrawDiskSnapshot | null,
		reason: string): Promise<ExcalidrawProjectionResult> {
		if (!current) return { kind: "superseded", operationId: plan.operationId };
		const parsed = await this.adapter.parse(current.bytes);
		if (parsed.kind !== "valid") {
			await this.disk.preserveAlternative({ path: plan.path, drawingId: plan.drawingId, bytes: current.bytes, reason });
			return { kind: "blocked", operationId: plan.operationId, reason: "changed disk alternative is not safely parseable" };
		}
		await this.captureAlternative(plan.drawingId, parsed.value);
		await this.persistence.deleteProjectionPlan(plan.operationId);
		return { kind: "local-alternative", operationId: plan.operationId };
	}
}
