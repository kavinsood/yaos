import type { HttpRequester } from "../../utils/http";
import { obsidianRequest } from "../../utils/http";
import type { StoredCanvasCandidate } from "../vaultIndexedDb";
import {
	BODY_EPOCH_HEADER,
	ROOT_EPOCH_HEADER,
	parseSemanticEpoch,
	parseSemanticEpochHeader,
	parseSemanticEpochMismatchPayload,
	type SemanticEpoch,
	type SemanticEpochMismatchPayload,
} from "@shared/semanticEpoch";

export interface CanvasServerHead {
	documentId: string;
	path: string;
	generation: number;
	bodyEpoch: SemanticEpoch;
	contentHash: string;
	size: number;
	lifecycle: "active";
}

export interface CanvasState extends CanvasServerHead { encodedState: Uint8Array }

export interface CanvasCandidateReceipt {
	documentId: string;
	bodyEpoch: SemanticEpoch;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	vaultSequence: number;
	contentHash: string;
	size: number;
}

export class CanvasSemanticEpochMismatchError extends Error {
	readonly status = 409;
	constructor(readonly mismatch: SemanticEpochMismatchPayload) {
		super(`Canvas ${mismatch.documentId} epoch ${mismatch.receivedEpoch} is fenced; current epoch is ${mismatch.expectedEpoch}`);
		this.name = "CanvasSemanticEpochMismatchError";
	}
}

export interface CanvasLifecycleRequest {
	operationId: string;
	requestDigest: string;
	documentId: string;
	bodyEpoch: SemanticEpoch;
	rootEpoch: SemanticEpoch;
	kind: "rename" | "delete" | "revive";
	fromPath?: string;
	toPath?: string;
	path?: string;
}

export interface CanvasLifecycleReceipt {
	operationId: string;
	requestDigest: string;
	documentId: string;
	resultPath: string;
	resultLifecycle: "active" | "tombstoned";
	durableGeneration: number;
	bodyEpoch: SemanticEpoch;
	vaultSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
}

export interface CanvasAuthorityReceipt {
	operationId: string;
	requestDigest: string;
	kind: "promote" | "demote";
	path: string;
	documentId: string;
	sourceRevision: string;
	contentHash: string;
	size: number;
	documentGeneration: number;
	bodyEpoch: SemanticEpoch;
	rootSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	rollbackBlobHash: string | null;
}

export interface CanvasPromotionRequest {
	operationId: string; requestDigest: string; path: string; documentId: string;
	bodyEpoch: SemanticEpoch; rootEpoch: SemanticEpoch;
	sourceRevision: string; sourceHash: string; sourceSize: number;
	contentHash: string; contentSize: number;
	candidateDigest: string; encodedUpdate: ArrayBuffer;
}

export interface CanvasDemotionRequest {
	operationId: string; requestDigest: string; documentId: string; path: string;
	bodyEpoch: SemanticEpoch; rootEpoch: SemanticEpoch;
	expectedGeneration: number; expectedContentHash: string; expectedSize: number;
	blobHash: string; blobSize: number; mime: string;
}

export class CanvasHttpTransport {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly request: HttpRequester = obsidianRequest) {
		this.base = host.replace(/\/$/, "");
	}

	private route(resource: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/${resource}`;
	}

	private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` }; }

	private throwFailure(response: { status: number; json: unknown }, operation: string): never {
		const mismatch = response.status === 409 ? parseSemanticEpochMismatchPayload(response.json) : null;
		if (mismatch) throw new CanvasSemanticEpochMismatchError(mismatch);
		throw new Error(`${operation} (${response.status})`);
	}

	async state(documentId: string): Promise<CanvasState> {
		const response = await this.request({ url: this.route(`semantic/${encodeURIComponent(documentId)}/state`),
			method: "GET", headers: this.headers() });
		if (response.status !== 200) throw new Error(`Canvas state request failed (${response.status})`);
		const header = (name: string): string | undefined => response.headers[name]
			?? response.headers[name.toLowerCase()] ?? response.headers[name.toUpperCase()];
		const returnedId = header("x-yaos-document-id");
		const generation = Number(header("x-yaos-generation"));
		const bodyEpoch = parseSemanticEpochHeader(response.headers, "body");
		const contentHash = header("x-yaos-content-hash") ?? "";
		const size = Number(header("x-yaos-size"));
		if (returnedId !== documentId || !Number.isSafeInteger(generation) || generation < 1
			|| !/^[a-f0-9]{64}$/.test(contentHash) || !Number.isSafeInteger(size) || size < 0) {
			throw new Error("Canvas state proof mismatch");
		}
		return { documentId, path: "", generation, bodyEpoch, contentHash, size, lifecycle: "active",
			encodedState: new Uint8Array(response.arrayBuffer) };
	}

	async submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt> {
		const response = await this.request({
			url: this.route(`semantic/${encodeURIComponent(candidate.documentId)}/candidate`), method: "POST",
			contentType: "application/octet-stream", body: candidate.encodedUpdate,
			headers: { ...this.headers(), "x-yaos-candidate-id": candidate.candidateId,
				"x-yaos-candidate-digest": candidate.candidateDigest,
				[BODY_EPOCH_HEADER]: String(candidate.bodyEpoch),
				...(candidate.createPath ? { "x-yaos-semantic-create-path": candidate.createPath } : {}),
				...(candidate.operationId ? { "x-yaos-semantic-operation-id": candidate.operationId } : {}),
				...(candidate.operationDigest ? { "x-yaos-operation-digest": candidate.operationDigest } : {}) },
		});
		if (response.status !== 200) {
			const mismatch = response.status === 409 ? parseSemanticEpochMismatchPayload(response.json) : null;
			if (mismatch && mismatch.purpose === "body" && mismatch.documentId === candidate.documentId) {
				throw new CanvasSemanticEpochMismatchError(mismatch);
			}
			throw new Error(`Canvas candidate request failed (${response.status})`);
		}
		const receipt = response.json as Partial<CanvasCandidateReceipt>;
		if (receipt.documentId !== candidate.documentId || receipt.candidateId !== candidate.candidateId
			|| receipt.candidateDigest !== candidate.candidateDigest
			|| parseSemanticEpoch(receipt.bodyEpoch, "Canvas receipt body epoch") !== candidate.bodyEpoch
			|| !Number.isSafeInteger(receipt.durableGeneration) || (receipt.durableGeneration as number) < 1
			|| !Number.isSafeInteger(receipt.vaultSequence) || (receipt.vaultSequence as number) < 1
			|| typeof receipt.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.contentHash)
			|| !Number.isSafeInteger(receipt.size) || (receipt.size as number) < 0) {
			throw new Error("Canvas candidate receipt mismatch");
		}
		return receipt as CanvasCandidateReceipt;
	}

	async lifecycle(request: CanvasLifecycleRequest): Promise<CanvasLifecycleReceipt> {
		const response = await this.request({ url: this.route("semantic/lifecycle"), method: "POST",
			contentType: "application/json", body: JSON.stringify(request), headers: this.headers() });
		if (response.status !== 200) this.throwFailure(response, "Canvas lifecycle request failed");
		const receipt = response.json as Partial<CanvasLifecycleReceipt>;
		if (receipt.operationId !== request.operationId || receipt.requestDigest !== request.requestDigest
			|| receipt.documentId !== request.documentId
			|| parseSemanticEpoch(receipt.bodyEpoch, "Canvas lifecycle receipt body epoch") !== request.bodyEpoch
			|| parseSemanticEpoch(receipt.rootEpoch, "Canvas lifecycle receipt root epoch") !== request.rootEpoch) {
			throw new Error("Canvas lifecycle receipt mismatch");
		}
		return receipt as CanvasLifecycleReceipt;
	}

	async promote(input: CanvasPromotionRequest): Promise<CanvasAuthorityReceipt> {
		const response = await this.request({ url: this.route("semantic/authority/promote"), method: "POST",
			contentType: "application/octet-stream", body: input.encodedUpdate,
			headers: { ...this.headers(), "x-yaos-operation-id": input.operationId,
				"x-yaos-operation-digest": input.requestDigest, "x-yaos-path": input.path,
				"x-yaos-document-id": input.documentId, "x-yaos-source-revision": input.sourceRevision,
				"x-yaos-source-hash": input.sourceHash, "x-yaos-source-size": String(input.sourceSize),
				"x-yaos-content-hash": input.contentHash, "x-yaos-content-size": String(input.contentSize),
				"x-yaos-candidate-digest": input.candidateDigest,
				[BODY_EPOCH_HEADER]: String(input.bodyEpoch), [ROOT_EPOCH_HEADER]: String(input.rootEpoch) } });
		if (response.status !== 200) this.throwFailure(response, "Canvas promotion failed");
		const receipt = response.json as Partial<CanvasAuthorityReceipt>;
		if (parseSemanticEpoch(receipt.bodyEpoch, "Canvas promotion receipt body epoch") !== input.bodyEpoch
			|| parseSemanticEpoch(receipt.rootEpoch, "Canvas promotion receipt root epoch") !== input.rootEpoch) {
			throw new Error("Canvas promotion receipt mismatch");
		}
		return receipt as CanvasAuthorityReceipt;
	}

	async uploadBlob(hash: string, bytes: ArrayBuffer, mime = "application/json"): Promise<void> {
		const response = await this.request({ url: this.route(`blobs/${hash}`), method: "PUT",
			contentType: mime, body: bytes, headers: this.headers() });
		if (response.status !== 204) throw new Error(`Canvas rollback blob upload failed (${response.status})`);
	}

	async demote(input: CanvasDemotionRequest): Promise<CanvasAuthorityReceipt> {
		const response = await this.request({ url: this.route("semantic/authority/demote"), method: "POST",
			contentType: "application/json", body: JSON.stringify(input), headers: this.headers() });
		if (response.status !== 200) this.throwFailure(response, "Canvas demotion failed");
		const receipt = response.json as Partial<CanvasAuthorityReceipt>;
		if (parseSemanticEpoch(receipt.bodyEpoch, "Canvas demotion receipt body epoch") !== input.bodyEpoch
			|| parseSemanticEpoch(receipt.rootEpoch, "Canvas demotion receipt root epoch") !== input.rootEpoch) {
			throw new Error("Canvas demotion receipt mismatch");
		}
		return receipt as CanvasAuthorityReceipt;
	}
}
