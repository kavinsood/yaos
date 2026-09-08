import type { HttpRequester } from "../../utils/http";
import { obsidianRequest } from "../../utils/http";
import type { StoredCanvasCandidate } from "../vaultIndexedDb";

export interface CanvasServerHead {
	documentId: string;
	path: string;
	generation: number;
	contentHash: string;
	size: number;
	lifecycle: "active";
}

export interface CanvasState extends CanvasServerHead { encodedState: Uint8Array }

export interface CanvasCandidateReceipt {
	documentId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	vaultSequence: number;
	contentHash: string;
	size: number;
}

export interface CanvasLifecycleRequest {
	operationId: string;
	requestDigest: string;
	documentId: string;
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
	vaultSequence: number;
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
	rootSequence: number;
	rootGeneration: number;
	rollbackBlobHash: string | null;
}

export interface CanvasPromotionRequest {
	operationId: string; requestDigest: string; path: string; documentId: string;
	sourceRevision: string; sourceHash: string; sourceSize: number;
	contentHash: string; contentSize: number;
	candidateDigest: string; encodedUpdate: ArrayBuffer;
}

export interface CanvasDemotionRequest {
	operationId: string; requestDigest: string; documentId: string; path: string;
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

	async state(documentId: string): Promise<CanvasState> {
		const response = await this.request({ url: this.route(`semantic/${encodeURIComponent(documentId)}/state`),
			method: "GET", headers: this.headers() });
		if (response.status !== 200) throw new Error(`Canvas state request failed (${response.status})`);
		const header = (name: string): string | undefined => response.headers[name]
			?? response.headers[name.toLowerCase()] ?? response.headers[name.toUpperCase()];
		const returnedId = header("x-yaos-document-id");
		const generation = Number(header("x-yaos-generation"));
		const contentHash = header("x-yaos-content-hash") ?? "";
		const size = Number(header("x-yaos-size"));
		if (returnedId !== documentId || !Number.isSafeInteger(generation) || generation < 1
			|| !/^[a-f0-9]{64}$/.test(contentHash) || !Number.isSafeInteger(size) || size < 0) {
			throw new Error("Canvas state proof mismatch");
		}
		return { documentId, path: "", generation, contentHash, size, lifecycle: "active",
			encodedState: new Uint8Array(response.arrayBuffer) };
	}

	async submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt> {
		const response = await this.request({
			url: this.route(`semantic/${encodeURIComponent(candidate.documentId)}/candidate`), method: "POST",
			contentType: "application/octet-stream", body: candidate.encodedUpdate,
			headers: { ...this.headers(), "x-yaos-candidate-id": candidate.candidateId,
				"x-yaos-candidate-digest": candidate.candidateDigest,
				...(candidate.createPath ? { "x-yaos-semantic-create-path": candidate.createPath } : {}),
				...(candidate.operationId ? { "x-yaos-semantic-operation-id": candidate.operationId } : {}),
				...(candidate.operationDigest ? { "x-yaos-operation-digest": candidate.operationDigest } : {}) },
		});
		if (response.status !== 200) throw new Error(`Canvas candidate request failed (${response.status})`);
		return response.json as CanvasCandidateReceipt;
	}

	async lifecycle(request: CanvasLifecycleRequest): Promise<CanvasLifecycleReceipt> {
		const response = await this.request({ url: this.route("semantic/lifecycle"), method: "POST",
			contentType: "application/json", body: JSON.stringify(request), headers: this.headers() });
		if (response.status !== 200) throw new Error(`Canvas lifecycle request failed (${response.status})`);
		return response.json as CanvasLifecycleReceipt;
	}

	async promote(input: CanvasPromotionRequest): Promise<CanvasAuthorityReceipt> {
		const response = await this.request({ url: this.route("semantic/authority/promote"), method: "POST",
			contentType: "application/octet-stream", body: input.encodedUpdate,
			headers: { ...this.headers(), "x-yaos-operation-id": input.operationId,
				"x-yaos-operation-digest": input.requestDigest, "x-yaos-path": input.path,
				"x-yaos-document-id": input.documentId, "x-yaos-source-revision": input.sourceRevision,
				"x-yaos-source-hash": input.sourceHash, "x-yaos-source-size": String(input.sourceSize),
				"x-yaos-content-hash": input.contentHash, "x-yaos-content-size": String(input.contentSize),
				"x-yaos-candidate-digest": input.candidateDigest } });
		if (response.status !== 200) throw new Error(`Canvas promotion failed (${response.status})`);
		return response.json as CanvasAuthorityReceipt;
	}

	async uploadBlob(hash: string, bytes: ArrayBuffer, mime = "application/json"): Promise<void> {
		const response = await this.request({ url: this.route(`blobs/${hash}`), method: "PUT",
			contentType: mime, body: bytes, headers: this.headers() });
		if (response.status !== 204) throw new Error(`Canvas rollback blob upload failed (${response.status})`);
	}

	async demote(input: CanvasDemotionRequest): Promise<CanvasAuthorityReceipt> {
		const response = await this.request({ url: this.route("semantic/authority/demote"), method: "POST",
			contentType: "application/json", body: JSON.stringify(input), headers: this.headers() });
		if (response.status !== 200) throw new Error(`Canvas demotion failed (${response.status})`);
		return response.json as CanvasAuthorityReceipt;
	}
}
