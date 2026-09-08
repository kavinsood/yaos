import * as Y from "yjs";
import { MAX_CANDIDATE_BYTES } from "./contracts";
import type { VaultActorContext } from "./collaboration";
import type { ObjectStorePort } from "./platformPorts";
import { sha256Hex } from "./hex";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import { canonicalCanvasBytes } from "./shared/canvasCodec";
import { materializeCanvasDocument, validateCanvasDocument } from "./shared/canvasSemanticDocument";
import type { SemanticPathRef } from "./shared/canvasTypes";
import { safeCanvasPath } from "./shared/vaultPath";
import { blobKey } from "./vaultObjectStore";
import { hasSafeRootAttachmentSemantics } from "./vaultSocketService";
import type { SemanticCatalogHead, SemanticLifecycleReceipt, VaultStore } from "./vaultStore";
import type { VaultDocumentCache } from "./vaultDocumentCache";
import type { VaultSocketService } from "./vaultSocketService";

const IDENTITY = /^[A-Za-z0-9_-]{1,256}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function semanticRef(documentId: string): SemanticPathRef {
	return { documentId, kind: "canvas", format: "json-canvas", formatVersion: 1 };
}

interface SemanticServiceOptions {
	store: VaultStore;
	vaultId: () => string;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	validateActor: (actor: VaultActorContext) => boolean;
	cache: VaultDocumentCache;
	sockets: VaultSocketService;
	flush: (documentId: string) => Promise<boolean>;
	objectStore?: ObjectStorePort;
}

const ROLLBACK_RETENTION_MS = 30 * 24 * 60 * 60_000;

export class VaultSemanticService {
	constructor(private readonly options: SemanticServiceOptions) {}

	activeHead(documentId: string): SemanticCatalogHead | null {
		const head = this.options.store.semanticHeadAt(this.options.store.currentSequence(), documentId);
		return head?.lifecycle === "active" ? head : null;
	}

	async promote(request: Request, actor: VaultActorContext): Promise<Response> {
		const operationId = request.headers.get("x-yaos-operation-id") ?? "";
		const requestDigest = request.headers.get("x-yaos-operation-digest")?.toLowerCase() ?? "";
		const path = request.headers.get("x-yaos-path") ?? "";
		const documentId = request.headers.get("x-yaos-document-id") ?? "";
		const sourceRevision = request.headers.get("x-yaos-source-revision") ?? "";
		const sourceHash = request.headers.get("x-yaos-source-hash")?.toLowerCase() ?? "";
		const sourceSize = Number(request.headers.get("x-yaos-source-size"));
		const contentHash = request.headers.get("x-yaos-content-hash")?.toLowerCase() ?? "";
		const contentSize = Number(request.headers.get("x-yaos-content-size"));
		const updateDigest = request.headers.get("x-yaos-candidate-digest")?.toLowerCase() ?? "";
		if (!IDENTITY.test(operationId) || !DIGEST.test(requestDigest) || safeCanvasPath(path) !== path
			|| !IDENTITY.test(documentId) || !IDENTITY.test(sourceRevision) || !DIGEST.test(sourceHash)
			|| !Number.isSafeInteger(sourceSize) || sourceSize < 0 || !DIGEST.test(contentHash)
			|| !Number.isSafeInteger(contentSize) || contentSize < 0 || !DIGEST.test(updateDigest)) {
			return json({ error: "invalid_semantic_promotion" }, 400);
		}
		const replay = this.options.store.semanticAuthorityReceipt(operationId);
		if (replay) return replay.requestDigest === requestDigest && replay.kind === "promote"
			? json(replay) : json({ error: "operation_id_reused" }, 409);
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		const root = this.options.store.reconstructDocument("root");
		const vector = Y.encodeStateVector(root.doc);
		const blob = root.doc.getMap<{ hash: string; size: number; revision: string }>("pathToBlob").get(path);
		if (!blob || blob.revision !== sourceRevision || blob.hash !== sourceHash || blob.size !== sourceSize) {
			root.doc.destroy();
			return json({ error: "attachment_head_changed" }, 409);
		}
		if (root.doc.getMap("pathToId").has(path) || root.doc.getMap("pathToSemantic").has(path)) {
			root.doc.destroy();
			return json({ error: "path_authority_conflict" }, 409);
		}
		const object = await this.options.objectStore?.head(blobKey(this.options.vaultId(), this.options.vaultGeneration(), sourceHash));
		if (!object || object.size !== sourceSize) {
			root.doc.destroy();
			return json({ error: this.options.objectStore ? "promotion_blob_missing" : "attachments_unavailable" }, 409);
		}
		let update: Uint8Array;
		try { update = await readBoundedBytes(request, MAX_CANDIDATE_BYTES); }
		catch (error) {
			root.doc.destroy();
			return json({ error: error instanceof BoundedBodyError ? error.kind : "promotion_read_failed" },
				error instanceof BoundedBodyError && error.kind === "body_too_large" ? 413 : 400);
		}
		if (await sha256Hex(update) !== updateDigest) { root.doc.destroy(); return json({ error: "candidate_digest_mismatch" }, 400); }
		const semantic = new Y.Doc({ guid: documentId });
		try { Y.applyUpdate(semantic, update, "semantic-promotion-validation"); }
		catch { semantic.destroy(); root.doc.destroy(); return json({ error: "invalid_semantic_update" }, 409); }
		const validation = await validateCanvasDocument(semantic);
		if (validation) { semantic.destroy(); root.doc.destroy(); return json({ error: validation }, 409); }
		const content = canonicalCanvasBytes(await materializeCanvasDocument(semantic, false));
		semantic.destroy();
		if (content.byteLength !== contentSize || await sha256Hex(content) !== contentHash) {
			root.doc.destroy();
			return json({ error: "promotion_content_mismatch" }, 409);
		}
		root.doc.getMap("pathToBlob").delete(path);
		root.doc.getMap<SemanticPathRef>("pathToSemantic").set(path, semanticRef(documentId));
		if (!hasSafeRootAttachmentSemantics(root.doc)) { root.doc.destroy(); return json({ error: "unsafe_root_authority" }, 409); }
		const rootUpdate = Y.encodeStateAsUpdate(root.doc, vector);
		root.doc.destroy();
		try {
			const receipt = this.options.store.commitSemanticPromotion({ operationId, requestDigest, path, documentId,
				sourceRevision, contentHash, size: contentSize, rollbackBlobHash: sourceHash,
				rollbackBlobSize: sourceSize, semanticUpdate: update, rootUpdate,
				expectedRootGeneration: root.generation,
				runtimeEpoch: this.options.runtimeEpoch, rollbackRetainedUntil: Date.now() + ROLLBACK_RETENTION_MS, actor });
			this.options.cache.applyDurableUpdate(documentId, update, receipt.documentGeneration, this);
			this.options.cache.applyDurableUpdate("root", rootUpdate, receipt.rootGeneration, this);
			this.options.sockets.broadcastDocumentUpdate("root", rootUpdate, this);
			this.options.sockets.notifySemanticCommitted(documentId, receipt.documentGeneration, receipt.rootSequence,
				{ lifecycle: "active", contentHash, size: contentSize });
			return json(receipt);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "semantic_promotion_failed" }, 409);
		}
	}

	async demote(request: Request, actor: VaultActorContext): Promise<Response> {
		let input: { operationId?: unknown; requestDigest?: unknown; documentId?: unknown; path?: unknown;
			expectedGeneration?: unknown; expectedContentHash?: unknown; expectedSize?: unknown; blobHash?: unknown;
			blobSize?: unknown; mime?: unknown };
		try { input = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		const operationId = String(input.operationId ?? "");
		const requestDigest = String(input.requestDigest ?? "").toLowerCase();
		const documentId = String(input.documentId ?? "");
		const path = String(input.path ?? "");
		const generation = Number(input.expectedGeneration);
		const contentHash = String(input.expectedContentHash ?? "").toLowerCase();
		const size = Number(input.expectedSize);
		const blobHash = String(input.blobHash ?? "").toLowerCase();
		const blobSize = Number(input.blobSize);
		const mime = String(input.mime ?? "application/json");
		if (!IDENTITY.test(operationId) || !DIGEST.test(requestDigest) || !IDENTITY.test(documentId)
			|| safeCanvasPath(path) !== path || !Number.isSafeInteger(generation) || generation < 1
			|| !DIGEST.test(contentHash) || !Number.isSafeInteger(size) || size < 0 || blobHash !== contentHash
			|| blobSize !== size || mime.length === 0 || mime.length > 256) return json({ error: "invalid_semantic_demotion" }, 400);
		const replay = this.options.store.semanticAuthorityReceipt(operationId);
		if (replay) return replay.requestDigest === requestDigest && replay.kind === "demote"
			? json(replay) : json({ error: "operation_id_reused" }, 409);
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		if (!await this.options.flush(documentId)) return json({ error: "semantic_persistence_unavailable" }, 503);
		const head = this.activeHead(documentId);
		if (!head || head.path !== path || head.generation !== generation || head.contentHash !== contentHash || head.size !== size) {
			return json({ error: "semantic_head_changed" }, 409);
		}
		const object = await this.options.objectStore?.head(blobKey(this.options.vaultId(), this.options.vaultGeneration(), blobHash));
		if (!object || object.size !== blobSize) return json({ error: this.options.objectStore ? "demotion_blob_missing" : "attachments_unavailable" }, 409);
		const state = this.options.store.reconstructDocument(documentId);
		const materialized = canonicalCanvasBytes(await materializeCanvasDocument(state.doc, false));
		state.doc.destroy();
		if (materialized.byteLength !== size || await sha256Hex(materialized) !== contentHash) return json({ error: "semantic_head_content_mismatch" }, 409);
		const root = this.options.store.reconstructDocument("root");
		const vector = Y.encodeStateVector(root.doc);
		const current = root.doc.getMap<SemanticPathRef>("pathToSemantic").get(path);
		if (current?.documentId !== documentId || root.doc.getMap("pathToBlob").has(path) || root.doc.getMap("pathToId").has(path)) {
			root.doc.destroy();
			return json({ error: "root_semantic_head_changed" }, 409);
		}
		root.doc.getMap("pathToSemantic").delete(path);
		root.doc.getMap("pathToBlob").set(path, { hash: blobHash, size: blobSize, revision: operationId });
		root.doc.getMap("blobMeta").set(blobHash, { size: blobSize, mime, createdAt: Date.now(), device: actor.deviceId });
		if (!hasSafeRootAttachmentSemantics(root.doc)) { root.doc.destroy(); return json({ error: "unsafe_root_authority" }, 409); }
		const rootUpdate = Y.encodeStateAsUpdate(root.doc, vector);
		root.doc.destroy();
		try {
			const receipt = this.options.store.commitSemanticDemotion({ operationId, requestDigest, path, documentId,
				sourceRevision: `${generation}:${contentHash}`, expectedDocumentGeneration: generation,
				contentHash, size, mime, rootUpdate, expectedRootGeneration: root.generation,
				runtimeEpoch: this.options.runtimeEpoch, actor });
			this.options.cache.applyDurableUpdate("root", rootUpdate, receipt.rootGeneration, this);
			this.options.sockets.broadcastDocumentUpdate("root", rootUpdate, this);
			this.options.sockets.notifySemanticCommitted(documentId, generation, receipt.rootSequence,
				{ lifecycle: "tombstoned", contentHash, size });
			this.options.sockets.closeSemantic(documentId);
			return json(receipt);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "semantic_demotion_failed" }, 409);
		}
	}

	async candidate(documentId: string, request: Request, actor: VaultActorContext): Promise<Response> {
		if (!IDENTITY.test(documentId)) return json({ error: "invalid_semantic_document_id" }, 400);
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		const clientId = actor.deviceId;
		const candidateId = request.headers.get("x-yaos-candidate-id") ?? "";
		const candidateDigest = request.headers.get("x-yaos-candidate-digest")?.toLowerCase() ?? "";
		if (!IDENTITY.test(candidateId) || !DIGEST.test(candidateDigest)) return json({ error: "invalid_candidate_identity" }, 400);
		const replay = this.options.store.semanticCandidateReceipt(documentId, clientId, candidateId);
		if (replay) return replay.candidateDigest === candidateDigest ? json({ ...replay, vaultId: this.options.vaultId(),
			kind: "canvas", format: "json-canvas" })
			: json({ error: "candidate_id_reused_with_different_digest" }, 409);
		let update: Uint8Array;
		try { update = await readBoundedBytes(request, MAX_CANDIDATE_BYTES); }
		catch (error) {
			return json({ error: error instanceof BoundedBodyError ? error.kind : "candidate_read_failed" },
				error instanceof BoundedBodyError && error.kind === "body_too_large" ? 413 : 400);
		}
		if (await sha256Hex(update) !== candidateDigest) return json({ error: "candidate_digest_mismatch" }, 400);
		const active = this.activeHead(documentId);
		const createPath = request.headers.get("x-yaos-semantic-create-path");
		const operationId = request.headers.get("x-yaos-semantic-operation-id") ?? "";
		const requestDigest = request.headers.get("x-yaos-operation-digest")?.toLowerCase() ?? "";
		if (!active && (safeCanvasPath(createPath ?? "") !== createPath || !IDENTITY.test(operationId) || !DIGEST.test(requestDigest))) {
			return json({ error: "semantic_document_not_active" }, 409);
		}
		if (active && !await this.options.flush(documentId)) {
			return json({ error: "semantic_persistence_unavailable" }, 503);
		}
		const currentHead = this.options.store.documentHead(documentId);
		const reconstructed = this.options.store.reconstructDocument(documentId);
		let changed = false;
		const observer = (): void => { changed = true; };
		reconstructed.doc.on("update", observer);
		try { Y.applyUpdate(reconstructed.doc, update, "semantic-candidate-validation"); }
		catch { reconstructed.doc.destroy(); return json({ error: "invalid_semantic_update" }, 409); }
		finally { reconstructed.doc.off("update", observer); }
		const validation = await validateCanvasDocument(reconstructed.doc);
		if (validation) { reconstructed.doc.destroy(); return json({ error: validation }, 409); }
		const data = await materializeCanvasDocument(reconstructed.doc, false);
		const content = canonicalCanvasBytes(data);
		const contentHash = await sha256Hex(content);
		reconstructed.doc.destroy();
		let durableGeneration = currentHead?.generation ?? 0;
		let vaultSequence = currentHead?.latestSequence ?? 0;
		let receiptCommitted = false;
		const latestHead = this.options.store.documentHead(documentId);
		if (latestHead?.generation !== currentHead?.generation
			|| latestHead?.latestSequence !== currentHead?.latestSequence) {
			return json({ error: "semantic_candidate_generation_fence_changed" }, 409);
		}
		if (changed) {
			const nextGeneration = durableGeneration + 1;
			const commit = this.options.store.commitUpdate({ documentId, update, kind: "semantic",
				semanticCatalog: active ? { documentId, fileId: active.fileId, kind: "canvas", format: "json-canvas",
					formatVersion: 1, path: active.path, previousPath: null, lifecycle: "active",
					documentGeneration: nextGeneration, contentHash, size: content.byteLength } : undefined,
				semanticCandidateReceipt: active ? { documentId, clientId, candidateId, candidateDigest,
					durableGeneration: nextGeneration, vaultGeneration: this.options.vaultGeneration(),
					runtimeEpoch: this.options.runtimeEpoch, contentHash, size: content.byteLength } : undefined,
				actorAttributions: [{ actor, operationId: candidateId, requestDigest: candidateDigest }] });
			durableGeneration = commit.generation;
			vaultSequence = commit.vaultSequence;
			receiptCommitted = active !== null;
			if (this.options.cache.applyDurableUpdate(documentId, update, durableGeneration, request)) {
				this.options.sockets.broadcastDocumentUpdate(documentId, update, request);
			}
			if (active) this.options.sockets.notifySemanticCommitted(documentId, durableGeneration, vaultSequence,
				{ lifecycle: "active", contentHash, size: content.byteLength });
		}
		if (!active) {
			const publication = this.publishCreation(documentId, createPath!, operationId, requestDigest,
				durableGeneration, contentHash, content.byteLength, actor,
				{ documentId, clientId, candidateId, candidateDigest, durableGeneration,
					vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch,
					contentHash, size: content.byteLength });
			if (publication instanceof Response) return publication;
			vaultSequence = publication.vaultSequence;
			receiptCommitted = true;
		}
		const receipt = { documentId, clientId, candidateId, candidateDigest, durableGeneration, vaultSequence,
			vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch,
			contentHash, size: content.byteLength };
		if (!receiptCommitted) this.options.store.recordSemanticCandidateReceipt(receipt);
		return json({ ...receipt, vaultId: this.options.vaultId(), kind: "canvas", format: "json-canvas",
			contentHash, size: content.byteLength });
	}

	private publishCreation(documentId: string, path: string, operationId: string, requestDigest: string,
		durableGeneration: number, contentHash: string, size: number, actor: VaultActorContext,
		candidateReceipt: Parameters<VaultStore["commitUpdate"]>[0]["semanticCandidateReceipt"]): { vaultSequence: number } | Response {
		const replay = this.options.store.semanticLifecycleReceipt(operationId);
		if (replay) return replay.requestDigest === requestDigest && replay.documentId === documentId
			? { vaultSequence: replay.vaultSequence } : json({ error: "operation_id_reused" }, 409);
		const root = this.options.store.reconstructDocument("root");
		const stateVector = Y.encodeStateVector(root.doc);
		if (root.doc.getMap("pathToId").has(path) || root.doc.getMap("pathToBlob").has(path)
			|| root.doc.getMap("pathToSemantic").has(path)) {
			root.doc.destroy();
			return json({ error: "path_authority_conflict" }, 409);
		}
		root.doc.getMap<SemanticPathRef>("pathToSemantic").set(path, semanticRef(documentId));
		if (!hasSafeRootAttachmentSemantics(root.doc)) { root.doc.destroy(); return json({ error: "unsafe_root_authority" }, 409); }
		const rootUpdate = Y.encodeStateAsUpdate(root.doc, stateVector);
		root.doc.destroy();
		const commit = this.options.store.commitUpdate({ documentId: "root", update: rootUpdate, kind: "semantic-create",
			semanticCatalog: { documentId, fileId: documentId, kind: "canvas", format: "json-canvas", formatVersion: 1,
				path, previousPath: null, lifecycle: "active", documentGeneration: durableGeneration, contentHash, size },
			semanticLifecycleReceipt: { operationId, requestDigest, documentId, fileId: documentId, kind: "create",
				resultPath: path, resultLifecycle: "active", durableGeneration, vaultGeneration: this.options.vaultGeneration(),
				runtimeEpoch: this.options.runtimeEpoch },
			semanticCandidateReceipt: candidateReceipt,
			actorAttributions: [{ actor, operationId, requestDigest }] });
		if (this.options.cache.applyDurableUpdate("root", rootUpdate, commit.generation, this)) {
			this.options.sockets.broadcastDocumentUpdate("root", rootUpdate, this);
		}
		this.options.sockets.notifySemanticCommitted(documentId, durableGeneration, commit.vaultSequence,
			{ lifecycle: "active", contentHash, size });
		return { vaultSequence: commit.vaultSequence };
	}

	async lifecycle(request: Request, actor: VaultActorContext): Promise<Response> {
		let input: { operationId?: unknown; requestDigest?: unknown; documentId?: unknown; kind?: unknown;
			fromPath?: unknown; toPath?: unknown; path?: unknown };
		try { input = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		if (!IDENTITY.test(String(input.operationId ?? "")) || !DIGEST.test(String(input.requestDigest ?? ""))
			|| !IDENTITY.test(String(input.documentId ?? ""))
			|| !["rename", "delete", "revive"].includes(String(input.kind))) return json({ error: "invalid_semantic_lifecycle" }, 400);
		const operationId = String(input.operationId);
		const requestDigest = String(input.requestDigest);
		const documentId = String(input.documentId);
		const kind = input.kind as "rename" | "delete" | "revive";
		const replay = this.options.store.semanticLifecycleReceipt(operationId);
		if (replay) return replay.requestDigest === requestDigest ? json(replay) : json({ error: "operation_id_reused" }, 409);
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		if (kind !== "revive" && !await this.options.flush(documentId)) {
			return json({ error: "semantic_persistence_unavailable" }, 503);
		}
		const head = this.options.store.semanticHeadAt(this.options.store.currentSequence(), documentId);
		if (!head) return json({ error: "semantic_document_unknown" }, 404);
		if (kind === "rename" && head.lifecycle !== "active") return json({ error: "semantic_document_not_active" }, 409);
		if (kind === "delete" && head.lifecycle !== "active") return json({ error: "semantic_document_not_active" }, 409);
		if (kind === "revive" && head.lifecycle !== "tombstoned") return json({ error: "semantic_document_not_tombstoned" }, 409);
		const resultPath = kind === "rename" ? String(input.toPath ?? "")
			: kind === "revive" ? String(input.path ?? head.path) : head.path;
		if (safeCanvasPath(resultPath) !== resultPath) return json({ error: "invalid_canvas_path" }, 400);
		if (kind === "rename" && input.fromPath !== head.path) return json({ error: "semantic_source_path_changed" }, 409);
		const root = this.options.store.reconstructDocument("root");
		const stateVector = Y.encodeStateVector(root.doc);
		const semantic = root.doc.getMap<SemanticPathRef>("pathToSemantic");
		if (kind !== "revive") {
			const current = semantic.get(head.path);
			if (current?.documentId !== documentId) { root.doc.destroy(); return json({ error: "root_semantic_head_changed" }, 409); }
			semantic.delete(head.path);
		}
		if (kind !== "delete") {
			if (root.doc.getMap("pathToId").has(resultPath) || root.doc.getMap("pathToBlob").has(resultPath)
				|| semantic.has(resultPath)) { root.doc.destroy(); return json({ error: "path_authority_conflict" }, 409); }
			semantic.set(resultPath, semanticRef(documentId));
		}
		if (!hasSafeRootAttachmentSemantics(root.doc)) { root.doc.destroy(); return json({ error: "unsafe_root_authority" }, 409); }
		const rootUpdate = Y.encodeStateAsUpdate(root.doc, stateVector);
		root.doc.destroy();
		const documentGeneration = this.options.store.documentHead(documentId)?.generation ?? head.generation;
		const lifecycle = kind === "delete" ? "tombstoned" as const : "active" as const;
		const commit = this.options.store.commitUpdate({ documentId: "root", update: rootUpdate,
			kind: kind === "rename" ? "semantic-rename" : kind === "delete" ? "semantic-delete" : "semantic-revive",
			semanticCatalog: { documentId, fileId: head.fileId, kind: "canvas", format: "json-canvas", formatVersion: 1,
				path: resultPath, previousPath: kind === "rename" ? head.path : null, lifecycle,
				documentGeneration, contentHash: head.contentHash, size: head.size },
			semanticLifecycleReceipt: { operationId, requestDigest, documentId, fileId: head.fileId, kind,
				resultPath, resultLifecycle: lifecycle, durableGeneration: documentGeneration,
				vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch },
			actorAttributions: [{ actor, operationId, requestDigest }] });
		if (this.options.cache.applyDurableUpdate("root", rootUpdate, commit.generation, this)) {
			this.options.sockets.broadcastDocumentUpdate("root", rootUpdate, this);
		}
		this.options.sockets.notifySemanticCommitted(documentId, documentGeneration, commit.vaultSequence,
			{ lifecycle, contentHash: head.contentHash, size: head.size });
		const receipt: SemanticLifecycleReceipt = { operationId, requestDigest, documentId, fileId: head.fileId, kind,
			resultPath, resultLifecycle: lifecycle, durableGeneration: documentGeneration, vaultSequence: commit.vaultSequence,
			rootGeneration: commit.generation, vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch };
		return json(receipt);
	}

	async state(documentId: string): Promise<Response> {
		const head = this.activeHead(documentId);
		if (!head) return json({ error: "semantic_document_not_active" }, 404);
		const state = this.options.store.reconstructDocument(documentId);
		const bytes = Y.encodeStateAsUpdate(state.doc);
		state.doc.destroy();
		return new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream",
			"cache-control": "no-store", "x-yaos-document-id": documentId,
			"x-yaos-generation": String(state.generation), "x-yaos-content-hash": head.contentHash ?? "",
			"x-yaos-size": String(head.size ?? 0), "x-yaos-kind": "canvas", "x-yaos-format": "json-canvas" } });
	}
}
