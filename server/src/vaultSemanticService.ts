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
import {
	BODY_EPOCH_HEADER,
	INITIAL_SEMANTIC_EPOCH,
	SemanticEpochMismatchError,
	parseSemanticEpoch,
	parseSemanticEpochHeader,
	type SemanticEpoch,
} from "./shared/semanticEpoch";
import { VaultDocumentCachePressureError, VaultDocumentValidationError } from "./vaultDocumentCache";

const IDENTITY = /^[A-Za-z0-9_-]{1,256}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
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
	shouldPauseAdmission?: (documentId: string) => boolean;
	onDocumentCommitted?: (documentId: string, ingressBytes: number, commitLatencyMs?: number) => void;
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
		let bodyEpoch: SemanticEpoch;
		let rootEpoch: SemanticEpoch;
		try {
			bodyEpoch = parseSemanticEpochHeader(request.headers, "body");
			rootEpoch = parseSemanticEpochHeader(request.headers, "root");
		} catch { return json({ error: "semantic_epochs_required" }, 400); }
		if (!IDENTITY.test(operationId) || !DIGEST.test(requestDigest) || safeCanvasPath(path) !== path
			|| !IDENTITY.test(documentId) || !IDENTITY.test(sourceRevision) || !DIGEST.test(sourceHash)
			|| !Number.isSafeInteger(sourceSize) || sourceSize < 0 || !DIGEST.test(contentHash)
			|| !Number.isSafeInteger(contentSize) || contentSize < 0 || !DIGEST.test(updateDigest)) {
			return json({ error: "invalid_semantic_promotion" }, 400);
		}
		let update: Uint8Array;
		try { update = await readBoundedBytes(request, MAX_CANDIDATE_BYTES, { allowEmpty: true }); }
		catch (error) {
			return json({ error: error instanceof BoundedBodyError ? error.kind : "promotion_read_failed" },
				error instanceof BoundedBodyError && error.kind === "body_too_large" ? 413 : 400);
		}
		if (await sha256Hex(update) !== updateDigest) return json({ error: "candidate_digest_mismatch" }, 400);
		const replay = this.options.store.semanticAuthorityReceipt(operationId);
		if (replay) {
			if (replay.bodyEpoch !== bodyEpoch) return this.epochMismatch("body", documentId, replay.bodyEpoch, bodyEpoch);
			if (replay.rootEpoch !== rootEpoch) return this.epochMismatch("root", "root", replay.rootEpoch, rootEpoch);
			return replay.requestDigest === requestDigest && replay.kind === "promote"
				? json(replay) : json({ error: "operation_id_reused" }, 409);
		}
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		const rootHead = this.options.store.documentHead("root");
		if (!rootHead) return json({ error: "semantic_root_head_missing" }, 409);
		if (rootHead.semanticEpoch !== rootEpoch) return this.epochMismatch("root", "root", rootHead.semanticEpoch, rootEpoch);
		if (bodyEpoch !== INITIAL_SEMANTIC_EPOCH) {
			return this.epochMismatch("body", documentId, INITIAL_SEMANTIC_EPOCH, bodyEpoch);
		}
		let rootUpdate: Uint8Array;
		const releaseRoot = this.options.cache.reserveFullStateOperation("root", 3);
		try {
			const root = this.options.store.reconstructDocument("root");
			try {
				const vector = Y.encodeStateVector(root.doc);
				const blob = root.doc.getMap<{ hash: string; size: number; revision: string }>("pathToBlob").get(path);
				if (!blob || blob.revision !== sourceRevision || blob.hash !== sourceHash || blob.size !== sourceSize) {
					return json({ error: "attachment_head_changed" }, 409);
				}
				if (root.doc.getMap("pathToId").has(path) || root.doc.getMap("pathToSemantic").has(path)) {
					return json({ error: "path_authority_conflict" }, 409);
				}
				const object = await this.options.objectStore?.head(blobKey(this.options.vaultId(), this.options.vaultGeneration(), sourceHash));
				if (!object || object.size !== sourceSize) {
					return json({ error: this.options.objectStore ? "promotion_blob_missing" : "attachments_unavailable" }, 409);
				}
				const releaseSemantic = this.options.cache.reserveFullStateOperation(documentId, 2, update.byteLength);
				const semantic = new Y.Doc({ guid: documentId });
				try {
					try { Y.applyUpdate(semantic, update, "semantic-promotion-validation"); }
					catch { return json({ error: "invalid_semantic_update" }, 409); }
					const validation = await validateCanvasDocument(semantic);
					if (validation) return json({ error: validation }, 409);
					const content = canonicalCanvasBytes(await materializeCanvasDocument(semantic, false));
					if (content.byteLength !== contentSize || await sha256Hex(content) !== contentHash) {
						return json({ error: "promotion_content_mismatch" }, 409);
					}
				} finally {
					semantic.destroy();
					releaseSemantic();
				}
				root.doc.getMap("pathToBlob").delete(path);
				root.doc.getMap<SemanticPathRef>("pathToSemantic").set(path, semanticRef(documentId));
				if (!hasSafeRootAttachmentSemantics(root.doc)) return json({ error: "unsafe_root_authority" }, 409);
				rootUpdate = Y.encodeStateAsUpdate(root.doc, vector);
			} finally { root.doc.destroy(); }
		} finally { releaseRoot(); }
		try {
			if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
			const receipt = this.options.store.commitSemanticPromotion({ operationId, requestDigest, path, documentId,
				sourceRevision, contentHash, size: contentSize, rollbackBlobHash: sourceHash,
				rollbackBlobSize: sourceSize, semanticUpdate: update, bodyEpoch, rootEpoch, rootUpdate,
				expectedRootGeneration: rootHead.generation,
				runtimeEpoch: this.options.runtimeEpoch, rollbackRetainedUntil: Date.now() + ROLLBACK_RETENTION_MS, actor });
			this.options.cache.applyDurableUpdate(documentId, update, receipt.documentGeneration, this);
			this.options.cache.applyDurableUpdate("root", rootUpdate, receipt.rootGeneration, this);
			this.options.sockets.broadcastDocumentUpdate("root", rootUpdate, this);
			this.options.sockets.notifySemanticCommitted(documentId, receipt.documentGeneration, receipt.rootSequence,
				{ lifecycle: "active", contentHash, size: contentSize });
			return json(receipt);
		} catch (error) {
			const currentRoot = this.options.store.documentHead("root");
			if (currentRoot && currentRoot.semanticEpoch !== rootEpoch) {
				return this.epochMismatch("root", "root", currentRoot.semanticEpoch, rootEpoch);
			}
			return json({ error: error instanceof Error ? error.message : "semantic_promotion_failed" }, 409);
		}
	}

	async demote(request: Request, actor: VaultActorContext): Promise<Response> {
		let input: { operationId?: unknown; requestDigest?: unknown; documentId?: unknown; path?: unknown;
			expectedGeneration?: unknown; expectedContentHash?: unknown; expectedSize?: unknown; blobHash?: unknown;
			blobSize?: unknown; mime?: unknown; bodyEpoch?: unknown; rootEpoch?: unknown };
		try { input = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		const operationId = stringValue(input.operationId);
		const requestDigest = stringValue(input.requestDigest).toLowerCase();
		const documentId = stringValue(input.documentId);
		const path = stringValue(input.path);
		const generation = Number(input.expectedGeneration);
		const contentHash = stringValue(input.expectedContentHash).toLowerCase();
		const size = Number(input.expectedSize);
		const blobHash = stringValue(input.blobHash).toLowerCase();
		const blobSize = Number(input.blobSize);
		const mime = stringValue(input.mime, "application/json");
		let bodyEpoch: SemanticEpoch;
		let rootEpoch: SemanticEpoch;
		try {
			bodyEpoch = parseSemanticEpoch(input.bodyEpoch, "Canvas demotion body epoch");
			rootEpoch = parseSemanticEpoch(input.rootEpoch, "Canvas demotion root epoch");
		} catch { return json({ error: "semantic_epochs_required" }, 400); }
		if (!IDENTITY.test(operationId) || !DIGEST.test(requestDigest) || !IDENTITY.test(documentId)
			|| safeCanvasPath(path) !== path || !Number.isSafeInteger(generation) || generation < 1
			|| !DIGEST.test(contentHash) || !Number.isSafeInteger(size) || size < 0 || blobHash !== contentHash
			|| blobSize !== size || mime.length === 0 || mime.length > 256) return json({ error: "invalid_semantic_demotion" }, 400);
		const replay = this.options.store.semanticAuthorityReceipt(operationId);
		if (replay) {
			if (replay.bodyEpoch !== bodyEpoch) return this.epochMismatch("body", documentId, replay.bodyEpoch, bodyEpoch);
			if (replay.rootEpoch !== rootEpoch) return this.epochMismatch("root", "root", replay.rootEpoch, rootEpoch);
			return replay.requestDigest === requestDigest && replay.kind === "demote"
				? json(replay) : json({ error: "operation_id_reused" }, 409);
		}
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		if (!await this.options.flush(documentId)) return json({ error: "semantic_persistence_unavailable" }, 503);
		const head = this.activeHead(documentId);
		if (head && head.bodyEpoch !== bodyEpoch) return this.epochMismatch("body", documentId, head.bodyEpoch, bodyEpoch);
		const rootHead = this.options.store.documentHead("root");
		if (!rootHead) return json({ error: "semantic_root_head_missing" }, 409);
		if (rootHead.semanticEpoch !== rootEpoch) return this.epochMismatch("root", "root", rootHead.semanticEpoch, rootEpoch);
		if (!head || head.path !== path || head.generation !== generation || head.contentHash !== contentHash || head.size !== size) {
			return json({ error: "semantic_head_changed" }, 409);
		}
		const object = await this.options.objectStore?.head(blobKey(this.options.vaultId(), this.options.vaultGeneration(), blobHash));
		if (!object || object.size !== blobSize) return json({ error: this.options.objectStore ? "demotion_blob_missing" : "attachments_unavailable" }, 409);
		const releaseState = this.options.cache.reserveFullStateOperation(documentId, 2);
		let materialized: Uint8Array;
		try {
			const state = this.options.store.reconstructDocument(documentId);
			try { materialized = canonicalCanvasBytes(await materializeCanvasDocument(state.doc, false)); }
			finally { state.doc.destroy(); }
		} finally { releaseState(); }
		if (materialized.byteLength !== size || await sha256Hex(materialized) !== contentHash) return json({ error: "semantic_head_content_mismatch" }, 409);
		const releaseRoot = this.options.cache.reserveFullStateOperation("root", 3);
		let rootUpdate: Uint8Array;
		try {
			const root = this.options.store.reconstructDocument("root");
			try {
				const vector = Y.encodeStateVector(root.doc);
				const current = root.doc.getMap<SemanticPathRef>("pathToSemantic").get(path);
				if (current?.documentId !== documentId || root.doc.getMap("pathToBlob").has(path) || root.doc.getMap("pathToId").has(path)) {
					return json({ error: "root_semantic_head_changed" }, 409);
				}
				root.doc.getMap("pathToSemantic").delete(path);
				root.doc.getMap("pathToBlob").set(path, { hash: blobHash, size: blobSize, revision: operationId });
				root.doc.getMap("blobMeta").set(blobHash, { size: blobSize, mime, createdAt: Date.now(), device: actor.deviceId });
				if (!hasSafeRootAttachmentSemantics(root.doc)) return json({ error: "unsafe_root_authority" }, 409);
				rootUpdate = Y.encodeStateAsUpdate(root.doc, vector);
			} finally { root.doc.destroy(); }
		} finally { releaseRoot(); }
		try {
			if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
			const receipt = this.options.store.commitSemanticDemotion({ operationId, requestDigest, path, documentId,
				sourceRevision: `${generation}:${contentHash}`, expectedDocumentGeneration: generation,
				contentHash, size, bodyEpoch, rootEpoch, mime, rootUpdate, expectedRootGeneration: rootHead.generation,
				expectedSemanticHead: head,
				runtimeEpoch: this.options.runtimeEpoch, actor });
			this.options.cache.applyDurableUpdate("root", rootUpdate, receipt.rootGeneration, this);
			this.options.sockets.broadcastDocumentUpdate("root", rootUpdate, this);
			this.options.sockets.notifySemanticCommitted(documentId, generation, receipt.rootSequence,
				{ lifecycle: "tombstoned", contentHash, size });
			this.options.sockets.closeSemantic(documentId);
			return json(receipt);
		} catch (error) {
			const currentBody = this.options.store.documentHead(documentId);
			if (currentBody && currentBody.semanticEpoch !== bodyEpoch) {
				return this.epochMismatch("body", documentId, currentBody.semanticEpoch, bodyEpoch);
			}
			const currentRoot = this.options.store.documentHead("root");
			if (currentRoot && currentRoot.semanticEpoch !== rootEpoch) {
				return this.epochMismatch("root", "root", currentRoot.semanticEpoch, rootEpoch);
			}
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
		let bodyEpoch: SemanticEpoch;
		try { bodyEpoch = parseSemanticEpoch(Number(request.headers.get(BODY_EPOCH_HEADER)), "Canvas candidate body epoch"); }
		catch { return json({ error: "invalid_body_epoch" }, 400); }
		// Reject a value that cannot fit one durable journal row before consulting
		// the document/catalog or applying anything to Yjs.
		let update: Uint8Array;
		try { update = await readBoundedBytes(request, MAX_CANDIDATE_BYTES); }
		catch (error) {
			return json({ error: error instanceof BoundedBodyError ? error.kind : "candidate_read_failed" },
				error instanceof BoundedBodyError && error.kind === "body_too_large" ? 413 : 400);
		}
		const initialHead = this.options.store.documentHead(documentId);
		const initialEpoch = initialHead?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
		if (bodyEpoch !== initialEpoch) return this.epochMismatch("body", documentId, initialEpoch, bodyEpoch);
		const replay = this.options.store.semanticCandidateReceipt(documentId, clientId, candidateId);
		if (replay) return replay.candidateDigest === candidateDigest && replay.bodyEpoch === bodyEpoch
			? json({ ...replay, vaultId: this.options.vaultId(), kind: "canvas", format: "json-canvas" })
			: replay.bodyEpoch !== bodyEpoch
					? this.epochMismatch("body", documentId, initialEpoch, bodyEpoch)
					: json({ error: "candidate_id_reused_with_different_digest" }, 409);
		if (await sha256Hex(update) !== candidateDigest) return json({ error: "candidate_digest_mismatch" }, 400);
		if (this.options.shouldPauseAdmission?.(documentId)) return this.compactionBackpressure();
		const initialSemanticHead = this.options.store.semanticHeadAt(this.options.store.currentSequence(), documentId);
		if (initialSemanticHead && initialSemanticHead.lifecycle !== "active") {
			return json({ error: "semantic_document_not_active" }, 409);
		}
		const createPath = request.headers.get("x-yaos-semantic-create-path");
		const operationId = request.headers.get("x-yaos-semantic-operation-id") ?? "";
		const requestDigest = request.headers.get("x-yaos-operation-digest")?.toLowerCase() ?? "";
		if (!initialSemanticHead && (safeCanvasPath(createPath ?? "") !== createPath || !IDENTITY.test(operationId) || !DIGEST.test(requestDigest))) {
			return json({ error: "semantic_document_not_active" }, 409);
		}
		if (initialSemanticHead && !await this.options.flush(documentId)) {
			return json({ error: "semantic_persistence_unavailable" }, 503);
		}
		return this.options.cache.serializeDocument(documentId, async () => {
			const currentHead = this.options.store.documentHead(documentId);
			const currentEpoch = currentHead?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
			if (currentEpoch !== bodyEpoch) return this.epochMismatch("body", documentId, currentEpoch, bodyEpoch);
			if (this.options.shouldPauseAdmission?.(documentId)) return this.compactionBackpressure();
			const active = this.options.store.semanticHeadAt(this.options.store.currentSequence(), documentId);
			if (active && active.lifecycle !== "active") return json({ error: "semantic_document_not_active" }, 409);
			if (!initialSemanticHead && active) return json({ error: "semantic_catalog_head_changed" }, 409);
			if (initialSemanticHead && !active) return json({ error: "semantic_catalog_head_changed" }, 409);
			const repeated = this.options.store.semanticCandidateReceipt(documentId, clientId, candidateId);
			if (repeated) return repeated.candidateDigest === candidateDigest && repeated.bodyEpoch === bodyEpoch
				? json({ ...repeated, vaultId: this.options.vaultId(), kind: "canvas", format: "json-canvas" })
				: json({ error: "candidate_id_reused_with_different_digest" }, 409);
			try {
				this.options.cache.load(documentId, true, () => this.options.cache.admitBody(documentId),
					"canvas", currentHead === null);
			} catch (error) {
				if (error instanceof VaultDocumentCachePressureError) return json({ error: error.reason }, 429);
				throw error;
			}
			let validated;
			try { validated = await this.options.cache.validateCanvasUpdate(documentId, update); }
			catch (error) {
				if (error instanceof VaultDocumentValidationError) return json({ error: error.reason }, 409);
				if (error instanceof VaultDocumentCachePressureError) return json({ error: error.reason }, 429);
				throw error;
			}
			const contentHash = await sha256Hex(validated.contentBytes);
			let durableGeneration = currentHead?.generation ?? 0;
			let vaultSequence = currentHead?.latestSequence ?? 0;
			let receiptCommitted = false;
			let commitLatencyMs: number | undefined;
			if (validated.changesState) {
				const nextGeneration = durableGeneration + 1;
				const startedAt = performance.now();
				try {
					if (!this.options.validateActor(actor)) {
						this.options.cache.discardValidatedBodyUpdate(documentId);
						return json({ error: "authority_superseded" }, 409);
					}
					const commit = this.options.store.commitUpdate({ documentId, update, kind: "semantic",
						expectedHead: currentHead,
						expectedSemanticHead: active,
						semanticCatalog: active ? { documentId, fileId: active.fileId, kind: "canvas", format: "json-canvas",
							formatVersion: 1, path: active.path, previousPath: null, lifecycle: "active",
							documentGeneration: nextGeneration, contentHash, size: validated.contentBytes.byteLength } : undefined,
						semanticCandidateReceipt: active ? { documentId, clientId, candidateId, candidateDigest,
							bodyEpoch, durableGeneration: nextGeneration, vaultGeneration: this.options.vaultGeneration(),
							runtimeEpoch: this.options.runtimeEpoch, contentHash, size: validated.contentBytes.byteLength } : undefined,
						actorAttributions: [{ actor, operationId: candidateId, requestDigest: candidateDigest }] });
					commitLatencyMs = performance.now() - startedAt;
					durableGeneration = commit.generation;
					vaultSequence = commit.vaultSequence;
					receiptCommitted = active !== null;
				} catch (error) {
					this.options.cache.discardValidatedBodyUpdate(documentId);
					const head = this.options.store.documentHead(documentId);
					if (head && head.semanticEpoch !== bodyEpoch) return this.epochMismatch("body", documentId, head.semanticEpoch, bodyEpoch);
					return json({ error: error instanceof Error ? error.message : "semantic_candidate_commit_failed" }, 409);
				}
				if (this.options.cache.commitValidatedBodyUpdate(documentId, update, durableGeneration,
					bodyEpoch, request, validated)) this.options.sockets.broadcastDocumentUpdate(documentId, update, request);
				this.options.onDocumentCommitted?.(documentId, update.byteLength, commitLatencyMs);
			}
			if (!active) {
				if (!this.options.validateActor(actor)) {
					this.options.cache.discardValidatedBodyUpdate(documentId);
					return json({ error: "authority_superseded" }, 409);
				}
				const publication = this.publishCreation(documentId, createPath!, operationId, requestDigest,
					durableGeneration, contentHash, validated.contentBytes.byteLength, actor,
					{ documentId, clientId, candidateId, candidateDigest, bodyEpoch, durableGeneration,
						vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch,
						contentHash, size: validated.contentBytes.byteLength });
				if (publication instanceof Response) return publication;
				vaultSequence = publication.vaultSequence;
				receiptCommitted = true;
			}
			const receipt = { documentId, clientId, candidateId, candidateDigest, bodyEpoch,
				durableGeneration, vaultSequence, vaultGeneration: this.options.vaultGeneration(),
				runtimeEpoch: this.options.runtimeEpoch, contentHash, size: validated.contentBytes.byteLength };
			if (!receiptCommitted) {
				try {
					if (!this.options.validateActor(actor)) {
						this.options.cache.discardValidatedBodyUpdate(documentId);
						return json({ error: "authority_superseded" }, 409);
					}
					this.options.store.recordSemanticCandidateReceipt(receipt, actor, currentHead, active!);
				} catch (error) {
					this.options.cache.discardValidatedBodyUpdate(documentId);
					return json({ error: error instanceof Error ? error.message : "semantic_candidate_receipt_failed" }, 409);
				}
				this.options.cache.stageValidatedBodyUpdate(documentId, validated);
			}
			if (active) this.options.sockets.notifySemanticCommitted(documentId, durableGeneration, vaultSequence,
				{ lifecycle: "active", contentHash, size: validated.contentBytes.byteLength });
			return json({ ...receipt, vaultId: this.options.vaultId(), kind: "canvas", format: "json-canvas" });
		});
	}

	private compactionBackpressure(): Response {
		return Response.json({ error: "semantic_compaction_backpressure" }, {
			status: 429, headers: { "cache-control": "no-store", "Retry-After": "1" },
		});
	}

	private epochMismatch(purpose: "body" | "root", documentId: string,
		expected: SemanticEpoch, received: SemanticEpoch): Response {
		const mismatch = purpose === "root"
			? new SemanticEpochMismatchError({ purpose: "root", documentId: "root",
				expectedRootEpoch: expected, receivedRootEpoch: received })
			: new SemanticEpochMismatchError({ purpose: "body", documentId,
				expectedBodyEpoch: expected, receivedBodyEpoch: received });
		return json(mismatch.toPayload(), mismatch.status);
	}

	private publishCreation(documentId: string, path: string, operationId: string, requestDigest: string,
		durableGeneration: number, contentHash: string, size: number, actor: VaultActorContext,
		candidateReceipt: Parameters<VaultStore["commitUpdate"]>[0]["semanticCandidateReceipt"]): { vaultSequence: number } | Response {
		const replay = this.options.store.semanticLifecycleReceipt(operationId);
		if (replay) return replay.requestDigest === requestDigest && replay.documentId === documentId
			? { vaultSequence: replay.vaultSequence } : json({ error: "operation_id_reused" }, 409);
		const rootHead = this.options.store.documentHead("root");
		if (!rootHead) return json({ error: "semantic_root_head_missing" }, 409);
		const releaseRoot = this.options.cache.reserveFullStateOperation("root", 3);
		let rootUpdate: Uint8Array;
		try {
			const root = this.options.store.reconstructDocument("root");
			try {
				const stateVector = Y.encodeStateVector(root.doc);
				if (root.doc.getMap("pathToId").has(path) || root.doc.getMap("pathToBlob").has(path)
					|| root.doc.getMap("pathToSemantic").has(path)) {
					return json({ error: "path_authority_conflict" }, 409);
				}
				root.doc.getMap<SemanticPathRef>("pathToSemantic").set(path, semanticRef(documentId));
				if (!hasSafeRootAttachmentSemantics(root.doc)) return json({ error: "unsafe_root_authority" }, 409);
				rootUpdate = Y.encodeStateAsUpdate(root.doc, stateVector);
			} finally { root.doc.destroy(); }
		} finally { releaseRoot(); }
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		const commit = this.options.store.commitUpdate({ documentId: "root", update: rootUpdate, kind: "semantic-create",
			expectedHead: rootHead,
			expectedSemanticHead: null,
			semanticCatalog: { documentId, fileId: documentId, kind: "canvas", format: "json-canvas", formatVersion: 1,
				path, previousPath: null, lifecycle: "active", documentGeneration: durableGeneration, contentHash, size },
			semanticLifecycleReceipt: { operationId, requestDigest, documentId, fileId: documentId, kind: "create",
				resultPath: path, resultLifecycle: "active", durableGeneration, bodyEpoch: candidateReceipt!.bodyEpoch,
				rootEpoch: rootHead.semanticEpoch, vaultGeneration: this.options.vaultGeneration(),
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
			fromPath?: unknown; toPath?: unknown; path?: unknown; bodyEpoch?: unknown; rootEpoch?: unknown };
		try { input = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
		const operationId = stringValue(input.operationId);
		const requestDigest = stringValue(input.requestDigest);
		const documentId = stringValue(input.documentId);
		const requestedKind = stringValue(input.kind);
		if (!IDENTITY.test(operationId) || !DIGEST.test(requestDigest) || !IDENTITY.test(documentId)
			|| !["rename", "delete", "revive"].includes(requestedKind)) return json({ error: "invalid_semantic_lifecycle" }, 400);
		const kind = requestedKind as "rename" | "delete" | "revive";
		let bodyEpoch: SemanticEpoch;
		let rootEpoch: SemanticEpoch;
		try {
			bodyEpoch = parseSemanticEpoch(input.bodyEpoch, "Canvas lifecycle body epoch");
			rootEpoch = parseSemanticEpoch(input.rootEpoch, "Canvas lifecycle root epoch");
		} catch { return json({ error: "semantic_epochs_required" }, 400); }
		const replay = this.options.store.semanticLifecycleReceipt(operationId);
		if (replay) {
			if (replay.bodyEpoch !== bodyEpoch) return this.epochMismatch("body", documentId, replay.bodyEpoch, bodyEpoch);
			if (replay.rootEpoch !== rootEpoch) return this.epochMismatch("root", "root", replay.rootEpoch, rootEpoch);
			return replay.requestDigest === requestDigest ? json(replay) : json({ error: "operation_id_reused" }, 409);
		}
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		if (kind !== "revive" && !await this.options.flush(documentId)) {
			return json({ error: "semantic_persistence_unavailable" }, 503);
		}
		const head = this.options.store.semanticHeadAt(this.options.store.currentSequence(), documentId);
		if (!head) return json({ error: "semantic_document_unknown" }, 404);
		if (head.bodyEpoch !== bodyEpoch) return this.epochMismatch("body", documentId, head.bodyEpoch, bodyEpoch);
		const rootHead = this.options.store.documentHead("root");
		if (!rootHead) return json({ error: "semantic_root_head_missing" }, 409);
		if (rootHead.semanticEpoch !== rootEpoch) return this.epochMismatch("root", "root", rootHead.semanticEpoch, rootEpoch);
		if (kind === "rename" && head.lifecycle !== "active") return json({ error: "semantic_document_not_active" }, 409);
		if (kind === "delete" && head.lifecycle !== "active") return json({ error: "semantic_document_not_active" }, 409);
		if (kind === "revive" && head.lifecycle !== "tombstoned") return json({ error: "semantic_document_not_tombstoned" }, 409);
		const resultPath = kind === "rename" ? stringValue(input.toPath)
			: kind === "revive" ? stringValue(input.path, head.path) : head.path;
		if (safeCanvasPath(resultPath) !== resultPath) return json({ error: "invalid_canvas_path" }, 400);
		if (kind === "rename" && input.fromPath !== head.path) return json({ error: "semantic_source_path_changed" }, 409);
		const releaseRoot = this.options.cache.reserveFullStateOperation("root", 3);
		let rootUpdate: Uint8Array;
		try {
			const root = this.options.store.reconstructDocument("root");
			try {
				const stateVector = Y.encodeStateVector(root.doc);
				const semantic = root.doc.getMap<SemanticPathRef>("pathToSemantic");
				if (kind !== "revive") {
					const current = semantic.get(head.path);
					if (current?.documentId !== documentId) return json({ error: "root_semantic_head_changed" }, 409);
					semantic.delete(head.path);
				}
				if (kind !== "delete") {
					if (root.doc.getMap("pathToId").has(resultPath) || root.doc.getMap("pathToBlob").has(resultPath)
						|| semantic.has(resultPath)) return json({ error: "path_authority_conflict" }, 409);
					semantic.set(resultPath, semanticRef(documentId));
				}
				if (!hasSafeRootAttachmentSemantics(root.doc)) return json({ error: "unsafe_root_authority" }, 409);
				rootUpdate = Y.encodeStateAsUpdate(root.doc, stateVector);
			} finally { root.doc.destroy(); }
		} finally { releaseRoot(); }
		const documentGeneration = this.options.store.documentHead(documentId)?.generation ?? head.generation;
		const lifecycle = kind === "delete" ? "tombstoned" as const : "active" as const;
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		const commit = this.options.store.commitUpdate({ documentId: "root", update: rootUpdate,
			expectedHead: rootHead,
			expectedSemanticHead: head,
			kind: kind === "rename" ? "semantic-rename" : kind === "delete" ? "semantic-delete" : "semantic-revive",
			semanticCatalog: { documentId, fileId: head.fileId, kind: "canvas", format: "json-canvas", formatVersion: 1,
				path: resultPath, previousPath: kind === "rename" ? head.path : null, lifecycle,
				documentGeneration, contentHash: head.contentHash, size: head.size },
			semanticLifecycleReceipt: { operationId, requestDigest, documentId, fileId: head.fileId, kind,
				resultPath, resultLifecycle: lifecycle, durableGeneration: documentGeneration,
				bodyEpoch, rootEpoch,
				vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch },
			actorAttributions: [{ actor, operationId, requestDigest }] });
		if (this.options.cache.applyDurableUpdate("root", rootUpdate, commit.generation, this)) {
			this.options.sockets.broadcastDocumentUpdate("root", rootUpdate, this);
		}
		this.options.sockets.notifySemanticCommitted(documentId, documentGeneration, commit.vaultSequence,
			{ lifecycle, contentHash: head.contentHash, size: head.size });
		const receipt: SemanticLifecycleReceipt = { operationId, requestDigest, documentId, fileId: head.fileId, kind,
			resultPath, resultLifecycle: lifecycle, durableGeneration: documentGeneration, vaultSequence: commit.vaultSequence,
			bodyEpoch, rootGeneration: commit.generation, rootEpoch,
			vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch };
		return json(receipt);
	}

	async state(documentId: string): Promise<Response> {
		const head = this.activeHead(documentId);
		if (!head) return json({ error: "semantic_document_not_active" }, 404);
		const state = this.options.cache.load(documentId, true, () => this.options.cache.admitBody(documentId), "canvas");
		const release = this.options.cache.reserveFullStateOperation(documentId, 1);
		try {
			const bytes = Y.encodeStateAsUpdate(state.doc);
			return new Response(bytes.slice().buffer, { headers: { "content-type": "application/octet-stream",
				"cache-control": "no-store", "x-yaos-document-id": documentId,
				[BODY_EPOCH_HEADER]: String(state.semanticEpoch),
				"x-yaos-generation": String(state.generation), "x-yaos-content-hash": head.contentHash ?? "",
				"x-yaos-size": String(head.size ?? 0), "x-yaos-kind": "canvas", "x-yaos-format": "json-canvas" } });
		} finally { release(); }
	}
}
