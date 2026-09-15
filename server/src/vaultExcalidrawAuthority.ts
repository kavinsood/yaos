import * as Y from "yjs";
import type { VaultActorContext } from "./collaboration";
import { actorHeaders, parseVaultActor } from "./vaultAuthority";
import { sha256Hex } from "./hex";
import type { ActorCallPort, VaultRuntimeStoragePort } from "./platformPorts";
import type { SemanticPathRef } from "./shared/canvasTypes";
import {
	EXCALIDRAW_PROTOCOL_VERSION,
	canonicalExcalidrawJson,
	excalidrawRequestDigestInput,
	isExcalidrawDigest,
	isExcalidrawEpoch,
	isExcalidrawIdentity,
	isSupportedExcalidrawPath,
	type ExcalidrawAuthorityPermit,
	type ExcalidrawAuthorityReservationRequest,
	type ExcalidrawBatchReceipt,
	type ExcalidrawPromotionFinalizeReceipt,
	type ExcalidrawPromotionFinalizeRequest,
	type ExcalidrawPromotionPrepareReceipt,
	type ExcalidrawPromotionPrepareRequest,
	type ExcalidrawSourceAuthority,
	type ExcalidrawLifecycleRequest,
	type ExcalidrawLifecycleReceipt,
} from "./shared/excalidrawProtocol";
import { hasSafeRootAttachmentSemantics } from "./vaultSocketService";
import type { VaultStore } from "./vaultStore";

interface PreparedRow extends Record<string, SqlStorageValue> {
	operation_id: string;
	request_digest: string;
	drawing_id: string;
	path: string;
	source_json: string;
	initialization_request_digest: string;
	prepare_permit_id: string;
	principal_id: string;
	membership_revision: number;
	device_id: string;
	device_credential_revision: number;
}

interface DrawingRow extends Record<string, SqlStorageValue> {
	drawing_id: string;
	file_id: string;
	path: string;
	drawing_epoch: number;
	lifecycle: "active" | "tombstoned";
}

interface PermitRow extends Record<string, SqlStorageValue> {
	request_digest: string;
	permit_json: string;
}

interface FinalizeRow extends Record<string, SqlStorageValue> {
	request_digest: string;
	receipt_json: string;
}

export interface VaultExcalidrawAuthorityOptions {
	storage: VaultRuntimeStoragePort;
	store: () => VaultStore;
	drawings?: ActorCallPort;
	runtimeEpoch: string;
	onRootCommitted: (update: Uint8Array, generation: number) => void;
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export class VaultExcalidrawAuthorityService {
	private initialized = false;

	constructor(private readonly options: VaultExcalidrawAuthorityOptions) {}

	async prepare(request: Request, actor: VaultActorContext): Promise<Response> {
		this.initializeSchema();
		let input: ExcalidrawPromotionPrepareRequest;
		try { input = await request.json<ExcalidrawPromotionPrepareRequest>(); }
		catch { return json({ error: "invalid_json" }, 400); }
		try { await this.validatePrepare(input); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "invalid_excalidraw_prepare" }, 400); }
		const replay = this.prepared(input.operationId);
		if (replay) return replay.request_digest === input.requestDigest
			? json(this.prepareReceipt(replay, true)) : json({ error: "excalidraw_operation_id_reused" }, 409);
		if (this.options.store().validateActor(actor) !== "allowed") return json({ error: "authority_superseded" }, 409);
		const permitId = crypto.randomUUID();
		try {
			this.options.storage.transactionSync(() => {
				if (this.options.store().validateActor(actor) !== "allowed") throw new Error("authority_superseded");
				if (this.activeDrawing(input.drawingId)) throw new Error("excalidraw_drawing_already_active");
				if (this.options.store().listActiveExcalidrawAt(this.options.store().currentSequence(), "", 1000).length >= 1000) {
					throw new Error("excalidraw_drawing_limit_reached");
				}
				const pathOwner = this.options.storage.sql.exec<{ document_id: string }>(`SELECT document_id
				 FROM vault_semantic_catalog_events e WHERE path = ? AND lifecycle = 'active'
				 AND sequence = (SELECT MAX(sequence) FROM vault_semantic_catalog_events WHERE document_id = e.document_id) LIMIT 1`, input.path).toArray()[0];
				if (pathOwner) throw new Error("path_authority_conflict");
				this.assertSourceCurrent(input.path, input.source);
				this.options.storage.sql.exec(`INSERT INTO vault_excalidraw_prepares(
					 operation_id, request_digest, drawing_id, path, source_json, initialization_request_digest, prepare_permit_id,
					 principal_id, membership_revision, device_id, device_credential_revision, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.operationId, input.requestDigest,
				input.drawingId, input.path, canonicalExcalidrawJson(input.source), input.initializationRequestDigest, permitId,
				actor.principalId, actor.membershipRevision, actor.deviceId, actor.deviceCredentialRevision, Date.now()).toArray();
			});
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "excalidraw_prepare_failed" }, 409);
		}
		return json(this.prepareReceipt(this.prepared(input.operationId)!, false), 201);
	}

	async finalize(request: Request, actor: VaultActorContext): Promise<Response> {
		this.initializeSchema();
		let input: ExcalidrawPromotionFinalizeRequest;
		try { input = await request.json<ExcalidrawPromotionFinalizeRequest>(); }
		catch { return json({ error: "invalid_json" }, 400); }
		try { await this.validateFinalize(input); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "invalid_excalidraw_finalize" }, 400); }
		const replay = this.finalizeReceipt(input.operationId);
		if (replay) return replay.request_digest === input.requestDigest
			? json({ ...(JSON.parse(replay.receipt_json) as ExcalidrawPromotionFinalizeReceipt), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
		const prepared = this.prepared(input.prepareOperationId);
		if (!prepared) return json({ error: "excalidraw_prepare_not_found" }, 404);
		if (prepared.principal_id !== actor.principalId || prepared.device_id !== actor.deviceId) {
			return json({ error: "excalidraw_prepare_actor_mismatch" }, 403);
		}
		if (this.options.store().validateActor(actor) !== "allowed") return json({ error: "authority_superseded" }, 409);
		const initialization = await this.initializationReceipt(prepared, input, actor);
		if (initialization instanceof Response) return initialization;
		const source = JSON.parse(prepared.source_json) as ExcalidrawSourceAuthority;
		const rootHead = this.options.store().documentHead("root");
		if (!rootHead) return json({ error: "excalidraw_root_missing" }, 409);
		const reconstructed = this.options.store().reconstructDocument("root");
		let rootUpdate: Uint8Array;
		try {
			const vector = Y.encodeStateVector(reconstructed.doc);
			const semantic = reconstructed.doc.getMap<SemanticPathRef>("pathToSemantic");
			const existing = semantic.get(prepared.path);
			if (existing) {
				if (existing.kind !== "excalidraw" || existing.documentId !== prepared.drawing_id) {
					return json({ error: "path_authority_conflict" }, 409);
				}
			} else {
				if (source.kind === "markdown") {
					if (reconstructed.doc.getMap<string>("pathToId").get(prepared.path) !== source.fileId) {
						return json({ error: "excalidraw_source_changed" }, 409);
					}
					reconstructed.doc.getMap("pathToId").delete(prepared.path);
				} else {
					const blob = reconstructed.doc.getMap<{ hash: string; size: number; revision: string }>("pathToBlob").get(prepared.path);
					if (!blob || blob.hash !== source.contentHash || blob.size !== source.size || blob.revision !== source.revision) {
						return json({ error: "excalidraw_source_changed" }, 409);
					}
					reconstructed.doc.getMap("pathToBlob").delete(prepared.path);
				}
				semantic.set(prepared.path, { documentId: prepared.drawing_id, kind: "excalidraw",
					format: "excalidraw-native", formatVersion: 1 });
			}
			if (!hasSafeRootAttachmentSemantics(reconstructed.doc)) return json({ error: "unsafe_root_authority" }, 409);
			rootUpdate = Y.encodeStateAsUpdate(reconstructed.doc, vector);
		} finally { reconstructed.doc.destroy(); }
		if (rootUpdate.byteLength === 0) return this.repairFinalize(input, prepared, initialization, rootHead);
		try {
			const fileId = source.kind === "markdown" ? source.fileId : prepared.drawing_id;
			const commit = this.options.store().commitUpdate({
				documentId: "root", update: rootUpdate, kind: "semantic-promote", expectedHead: rootHead,
				actorAttributions: [{ actor, operationId: input.operationId, requestDigest: input.requestDigest }],
				excalidrawCatalog: { documentId: prepared.drawing_id, fileId, kind: "excalidraw",
					format: "excalidraw-native", formatVersion: 1, path: prepared.path, previousPath: null,
					lifecycle: "active", documentGeneration: initialization.sequence, documentEpoch: 1,
					contentHash: null, size: null },
				...(source.kind === "markdown" ? { catalog: { bodyId: source.documentId, fileId: source.fileId,
					path: prepared.path, previousPath: null, lifecycle: "tombstoned" as const,
					bodyGeneration: source.generation, contentHash: source.contentHash, size: source.size } }
					: { attachmentCatalog: [{ path: prepared.path, contentHash: source.contentHash,
						size: source.size, mime: "application/json", lifecycle: "deleted" as const,
						operationId: input.operationId }] }),
			});
			const receipt = this.storeFinalize(input, prepared, initialization, commit.vaultSequence, commit.generation);
			this.options.onRootCommitted(rootUpdate, commit.generation);
			return json(receipt);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "excalidraw_finalize_failed" }, 409);
		}
	}

	async lifecycle(request: Request, actor: VaultActorContext): Promise<Response> {
		this.initializeSchema();
		let input: ExcalidrawLifecycleRequest;
		try { input = await request.json<ExcalidrawLifecycleRequest>(); }
		catch { return json({ error: "invalid_json" }, 400); }
		try { await this.validateLifecycle(input); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "invalid_excalidraw_lifecycle" }, 400); }
		const replay = this.options.store().semanticLifecycleReceipt(input.operationId);
		if (replay) {
			if (replay.requestDigest !== input.requestDigest || replay.documentId !== input.drawingId) {
				return json({ error: "excalidraw_operation_id_reused" }, 409);
			}
			const receipt = this.lifecycleReceipt(input, replay.resultPath, replay.resultLifecycle,
				replay.vaultSequence, replay.rootGeneration, true);
			if (input.kind === "delete") await this.fenceDrawing(input.drawingId);
			return json(receipt);
		}
		if (this.options.store().validateActor(actor) !== "allowed") return json({ error: "authority_superseded" }, 409);
		const head = this.options.store().excalidrawHeadAt(this.options.store().currentSequence(), input.drawingId);
		if (!head) return json({ error: "excalidraw_drawing_unknown" }, 404);
		if (head.lifecycle !== "active") return json({ error: "excalidraw_drawing_not_active" }, 409);
		if (head.documentEpoch !== input.drawingEpoch) return json({ error: "excalidraw_epoch_changed" }, 409);
		const resultPath = input.kind === "rename" ? input.toPath : input.path;
		if ((input.kind === "rename" ? input.fromPath : input.path) !== head.path) {
			return json({ error: "excalidraw_source_path_changed" }, 409);
		}
		const rootHead = this.options.store().documentHead("root");
		if (!rootHead) return json({ error: "excalidraw_root_missing" }, 409);
		const reconstructed = this.options.store().reconstructDocument("root");
		let rootUpdate: Uint8Array;
		try {
			const vector = Y.encodeStateVector(reconstructed.doc);
			const semantic = reconstructed.doc.getMap<SemanticPathRef>("pathToSemantic");
			const current = semantic.get(head.path);
			if (current?.kind !== "excalidraw" || current.documentId !== input.drawingId) {
				return json({ error: "root_semantic_head_changed" }, 409);
			}
			semantic.delete(head.path);
			if (input.kind === "rename") {
				if (reconstructed.doc.getMap("pathToId").has(resultPath)
					|| reconstructed.doc.getMap("pathToBlob").has(resultPath) || semantic.has(resultPath)) {
					return json({ error: "path_authority_conflict" }, 409);
				}
				semantic.set(resultPath, current);
			}
			if (!hasSafeRootAttachmentSemantics(reconstructed.doc)) return json({ error: "unsafe_root_authority" }, 409);
			rootUpdate = Y.encodeStateAsUpdate(reconstructed.doc, vector);
		} finally { reconstructed.doc.destroy(); }
		if (this.options.store().validateActor(actor) !== "allowed") return json({ error: "authority_superseded" }, 409);
		try {
			const lifecycle = input.kind === "delete" ? "tombstoned" as const : "active" as const;
			const commit = this.options.store().commitUpdate({ documentId: "root", update: rootUpdate,
				kind: input.kind === "rename" ? "semantic-rename" : "semantic-delete", expectedHead: rootHead,
				excalidrawCatalog: { documentId: input.drawingId, fileId: head.fileId, kind: "excalidraw",
					format: "excalidraw-native", formatVersion: 1, path: resultPath,
					previousPath: input.kind === "rename" ? head.path : null, lifecycle,
					documentGeneration: head.documentGeneration, documentEpoch: head.documentEpoch,
					contentHash: head.contentHash, size: head.size },
				excalidrawLifecycleReceipt: { operationId: input.operationId, requestDigest: input.requestDigest,
					documentId: input.drawingId, fileId: head.fileId, kind: input.kind, resultPath,
					resultLifecycle: lifecycle, durableGeneration: head.documentGeneration,
					bodyEpoch: head.documentEpoch, rootEpoch: rootHead.semanticEpoch,
					vaultGeneration: actor.vaultGeneration, runtimeEpoch: this.options.runtimeEpoch },
				actorAttributions: [{ actor, operationId: input.operationId, requestDigest: input.requestDigest }] });
			this.options.onRootCommitted(rootUpdate, commit.generation);
			if (input.kind === "delete") await this.fenceDrawing(input.drawingId);
			return json(this.lifecycleReceipt(input, resultPath, lifecycle, commit.vaultSequence, commit.generation, false));
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "excalidraw_lifecycle_failed" }, 409);
		}
	}

	reserve(request: Request): Promise<Response> {
		return this.reserveInternal(request);
	}

	async reserveShare(request: Request): Promise<Response> {
		this.initializeSchema();
		const metadata = this.options.store().vaultMetadata();
		if (!metadata) return json({ error: "vault_not_provisioned" }, 409);
		let input: Record<string, unknown>;
		try { input = await request.json<Record<string, unknown>>(); }
		catch { return json({ error: "invalid_json" }, 400); }
		if (!isExcalidrawIdentity(input.drawingId) || !isExcalidrawEpoch(input.drawingEpoch)
			|| !isExcalidrawIdentity(input.shareId) || !Number.isSafeInteger(input.grantRevision)
			|| (input.grantRevision as number) < 1 || !isExcalidrawIdentity(input.sessionId)
			|| !isExcalidrawIdentity(input.operationId) || !isExcalidrawDigest(input.requestDigest)) {
			return json({ error: "invalid_excalidraw_share_reservation" }, 400);
		}
		const key = `${input.shareId}:${input.operationId}`;
		const prior = this.options.storage.sql.exec<PermitRow>(`SELECT request_digest, permit_json
		 FROM vault_excalidraw_share_permits WHERE operation_key = ?`, key).toArray()[0];
		if (prior) return prior.request_digest === input.requestDigest
			? json({ ...(JSON.parse(prior.permit_json) as Record<string, unknown>), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
		const permit = { protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: input.operationId,
			requestDigest: input.requestDigest, drawingId: input.drawingId, drawingEpoch: input.drawingEpoch,
			shareId: input.shareId, grantRevision: input.grantRevision, sessionId: input.sessionId,
			permitId: crypto.randomUUID(), replayed: false };
		try {
			this.options.storage.transactionSync(() => {
				const drawing = this.activeDrawing(input.drawingId as string);
				if (!drawing || drawing.drawing_epoch !== input.drawingEpoch) throw new Error("excalidraw_drawing_not_active");
				this.options.storage.sql.exec(`INSERT INTO vault_excalidraw_share_permits(
				 operation_key, request_digest, drawing_id, drawing_epoch, share_id, grant_revision, session_id,
				 permit_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, key, input.requestDigest,
					input.drawingId, input.drawingEpoch, input.shareId, input.grantRevision, input.sessionId,
					canonicalExcalidrawJson(permit), Date.now()).toArray();
			});
			return json(permit, 201);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "excalidraw_share_reservation_failed" }, 409);
		}
	}

	read(request: Request): Response {
		this.initializeSchema();
		const metadata = this.options.store().vaultMetadata();
		const drawingId = new URL(request.url).searchParams.get("drawingId");
		if (!metadata || !isExcalidrawIdentity(drawingId)) return json({ error: "invalid_excalidraw_read" }, 400);
		const actor = parseVaultActor(request, metadata.vaultId, metadata.vaultGeneration);
		if (!actor || this.options.store().validateActor(actor) !== "allowed") return json({ error: "authority_superseded" }, 409);
		const drawing = this.activeDrawing(drawingId);
		return drawing ? json({ drawingId, drawingEpoch: drawing.drawing_epoch })
			: json({ error: "excalidraw_drawing_not_active" }, 404);
	}

	async closeActorSockets(principalIds: readonly string[], deviceIds: readonly string[]): Promise<void> {
		if (!this.options.drawings || (principalIds.length === 0 && deviceIds.length === 0)) return;
		const metadata = this.options.store().vaultMetadata();
		if (!metadata) return;
		let cursor = "";
		for (;;) {
			const drawings = this.options.store().listActiveExcalidrawAt(this.options.store().currentSequence(), cursor, 1000);
			await Promise.all(drawings.map(async (drawing) => {
				const response = await this.options.drawings!.call(`${metadata.vaultGeneration}:${drawing.documentId}`,
					new Request("https://internal/__yaos/authority-fence", {
						method: "POST",
						headers: { "content-type": "application/json", "x-yaos-vault-id": metadata.vaultId,
							"x-yaos-vault-generation": metadata.vaultGeneration, "x-yaos-drawing-id": drawing.documentId },
						body: JSON.stringify({ principalIds, deviceIds }),
					}));
				if (!response.ok && response.status !== 404) throw new Error("excalidraw_socket_fence_failed");
			}));
			if (drawings.length < 1000) return;
			cursor = drawings.at(-1)!.documentId;
		}
	}

	async fenceAllDrawings(): Promise<void> {
		if (!this.options.drawings) return;
		const metadata = this.options.store().vaultMetadata();
		if (!metadata) return;
		let cursor = "";
		for (;;) {
			const drawings = this.options.store().listActiveExcalidrawAt(this.options.store().currentSequence(), cursor, 1000);
			await Promise.all(drawings.map(async (drawing) => {
				const response = await this.options.drawings!.call(`${metadata.vaultGeneration}:${drawing.documentId}`,
					new Request("https://internal/__yaos/authority-fence", { method: "POST", headers: {
						"content-type": "application/json", "x-yaos-vault-id": metadata.vaultId,
						"x-yaos-vault-generation": metadata.vaultGeneration, "x-yaos-drawing-id": drawing.documentId,
					}, body: JSON.stringify({ all: true, revokeShares: true, principalIds: [], deviceIds: [] }) }));
				if (!response.ok && response.status !== 404) throw new Error("excalidraw_drawing_fence_failed");
			}));
			if (drawings.length < 1000) return;
			cursor = drawings.at(-1)!.documentId;
		}
	}

	private async reserveInternal(request: Request): Promise<Response> {
		this.initializeSchema();
		const metadata = this.options.store().vaultMetadata();
		if (!metadata) return json({ error: "vault_not_provisioned" }, 409);
		const actor = parseVaultActor(request, metadata.vaultId, metadata.vaultGeneration);
		if (!actor) return json({ error: "missing_trusted_actor" }, 401);
		let input: ExcalidrawAuthorityReservationRequest;
		try { input = await request.json<ExcalidrawAuthorityReservationRequest>(); }
		catch { return json({ error: "invalid_json" }, 400); }
		if (input.protocolVersion !== EXCALIDRAW_PROTOCOL_VERSION || !isExcalidrawIdentity(input.operationId)
			|| !isExcalidrawDigest(input.requestDigest) || !isExcalidrawIdentity(input.drawingId)
			|| !isExcalidrawEpoch(input.drawingEpoch)
			|| !["initialize", "mutate", "reset", "connect"].includes(input.kind)) {
			return json({ error: "invalid_excalidraw_reservation" }, 400);
		}
		const replay = this.options.storage.sql.exec<PermitRow>(
			"SELECT request_digest, permit_json FROM vault_excalidraw_permits WHERE operation_id = ?", input.operationId,
		).toArray()[0];
		if (replay) return replay.request_digest === input.requestDigest
			? json({ ...(JSON.parse(replay.permit_json) as ExcalidrawAuthorityPermit), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
		const principal = this.options.store().principalAuthority(actor.principalId);
		if (!principal) return json({ error: "authority_superseded" }, 409);
		const permit: ExcalidrawAuthorityPermit = {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: input.operationId,
			requestDigest: input.requestDigest, drawingId: input.drawingId, drawingEpoch: input.drawingEpoch,
			permitId: crypto.randomUUID(), principalId: actor.principalId, membershipRevision: actor.membershipRevision,
			deviceId: actor.deviceId, deviceCredentialRevision: actor.deviceCredentialRevision,
			displayName: principal.displayName, colorSeed: principal.colorSeed, replayed: false,
		};
		try {
			this.options.storage.transactionSync(() => {
				if (this.options.store().validateActor(actor) !== "allowed") throw new Error("authority_superseded");
				if (input.kind === "initialize") {
					const prepared = input.prepareOperationId ? this.prepared(input.prepareOperationId) : null;
					if (!prepared || prepared.drawing_id !== input.drawingId || input.drawingEpoch !== 1
						|| prepared.initialization_request_digest !== input.requestDigest
						|| prepared.principal_id !== actor.principalId || prepared.device_id !== actor.deviceId) {
						throw new Error("excalidraw_prepare_not_current");
					}
				} else {
					const drawing = this.activeDrawing(input.drawingId);
					if (!drawing) throw new Error("excalidraw_drawing_not_active");
					if (input.kind === "reset") {
						if (!isExcalidrawEpoch(input.previousDrawingEpoch) || drawing.drawing_epoch !== input.previousDrawingEpoch
							|| input.drawingEpoch !== input.previousDrawingEpoch + 1) throw new Error("excalidraw_epoch_changed");
						this.options.storage.sql.exec("UPDATE vault_excalidraw_drawings SET drawing_epoch = ? WHERE drawing_id = ?",
							input.drawingEpoch, input.drawingId).toArray();
					} else if (drawing.drawing_epoch !== input.drawingEpoch) throw new Error("excalidraw_epoch_changed");
				}
				this.options.storage.sql.exec(`INSERT INTO vault_excalidraw_permits(
				 operation_id, request_digest, drawing_id, drawing_epoch, kind, permit_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`, input.operationId, input.requestDigest, input.drawingId,
				input.drawingEpoch, input.kind, canonicalExcalidrawJson(permit), Date.now()).toArray();
			});
			return json(permit, 201);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "excalidraw_reservation_failed" }, 409);
		}
	}

	private async initializationReceipt(
		prepared: PreparedRow,
		input: ExcalidrawPromotionFinalizeRequest,
		actor: VaultActorContext,
	): Promise<ExcalidrawBatchReceipt | Response> {
		if (!this.options.drawings) return json({ error: "excalidraw_rooms_unavailable" }, 503);
		const headers = actorHeaders(actor);
		headers.set("x-yaos-vault-id", actor.vaultId);
		headers.set("x-yaos-vault-generation", actor.vaultGeneration);
		headers.set("x-yaos-drawing-id", prepared.drawing_id);
		const url = new URL("https://internal/receipt");
		url.searchParams.set("operationId", input.initializationOperationId);
		url.searchParams.set("requestDigest", input.initializationRequestDigest);
		const response = await this.options.drawings.call(`${actor.vaultGeneration}:${prepared.drawing_id}`, new Request(url, { headers }));
		if (!response.ok) return json({ error: "excalidraw_initialization_unproven" }, 409);
		const receipt = await response.json<ExcalidrawBatchReceipt>();
		return receipt.drawingId === prepared.drawing_id && receipt.drawingEpoch === 1
			? receipt : json({ error: "excalidraw_initialization_mismatch" }, 409);
	}

	private repairFinalize(
		input: ExcalidrawPromotionFinalizeRequest,
		prepared: PreparedRow,
		initialization: ExcalidrawBatchReceipt,
		rootHead: { generation: number; latestSequence: number },
	): Response {
		const active = this.options.store().excalidrawHeadAt(this.options.store().currentSequence(), prepared.drawing_id);
		if (!active || active.lifecycle !== "active") return json({ error: "excalidraw_finalize_state_missing" }, 409);
		return json(this.storeFinalize(input, prepared, initialization, rootHead.latestSequence, rootHead.generation));
	}

	private storeFinalize(
		input: ExcalidrawPromotionFinalizeRequest,
		prepared: PreparedRow,
		initialization: ExcalidrawBatchReceipt,
		vaultSequence: number,
		rootGeneration: number,
	): ExcalidrawPromotionFinalizeReceipt {
		const source = JSON.parse(prepared.source_json) as ExcalidrawSourceAuthority;
		const receipt: ExcalidrawPromotionFinalizeReceipt = {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: input.operationId,
			requestDigest: input.requestDigest, drawingId: prepared.drawing_id, drawingEpoch: 1,
			path: prepared.path, vaultSequence, rootGeneration, replayed: false,
		};
		this.options.storage.transactionSync(() => {
			this.options.storage.sql.exec(`INSERT INTO vault_excalidraw_drawings(
			 drawing_id, file_id, path, drawing_epoch, lifecycle, room_sequence, initialized_operation_id, updated_at
			) VALUES (?, ?, ?, 1, 'active', ?, ?, ?)
			ON CONFLICT(drawing_id) DO UPDATE SET lifecycle='active', room_sequence=excluded.room_sequence,
			 initialized_operation_id=excluded.initialized_operation_id, updated_at=excluded.updated_at`,
			prepared.drawing_id, source.kind === "markdown" ? source.fileId : prepared.drawing_id,
			prepared.path, initialization.sequence, initialization.operationId, Date.now()).toArray();
			this.options.storage.sql.exec(`INSERT INTO vault_excalidraw_finalize_receipts(
			 operation_id, request_digest, receipt_json, created_at
			) VALUES (?, ?, ?, ?)`, input.operationId, input.requestDigest, canonicalExcalidrawJson(receipt), Date.now()).toArray();
		});
		return receipt;
	}

	private async validatePrepare(input: ExcalidrawPromotionPrepareRequest): Promise<void> {
		if (input.protocolVersion !== EXCALIDRAW_PROTOCOL_VERSION || !isExcalidrawIdentity(input.operationId)
			|| !isExcalidrawDigest(input.requestDigest) || !isExcalidrawIdentity(input.drawingId)
			|| !isExcalidrawDigest(input.initializationRequestDigest)
			|| !isSupportedExcalidrawPath(input.path) || !validSource(input.source)) throw new TypeError("invalid_excalidraw_prepare");
		await assertRequestDigest(input);
	}

	private async validateFinalize(input: ExcalidrawPromotionFinalizeRequest): Promise<void> {
		if (input.protocolVersion !== EXCALIDRAW_PROTOCOL_VERSION || !isExcalidrawIdentity(input.operationId)
			|| !isExcalidrawDigest(input.requestDigest) || !isExcalidrawIdentity(input.prepareOperationId)
			|| !isExcalidrawIdentity(input.initializationOperationId)
			|| !isExcalidrawDigest(input.initializationRequestDigest)) throw new TypeError("invalid_excalidraw_finalize");
		await assertRequestDigest(input);
	}

	private async validateLifecycle(input: ExcalidrawLifecycleRequest): Promise<void> {
		if (input.protocolVersion !== EXCALIDRAW_PROTOCOL_VERSION || !isExcalidrawIdentity(input.operationId)
			|| !isExcalidrawDigest(input.requestDigest) || !isExcalidrawIdentity(input.drawingId)
			|| !isExcalidrawEpoch(input.drawingEpoch) || !["rename", "delete"].includes(input.kind)
			|| (input.kind === "rename" && (!isSupportedExcalidrawPath(input.fromPath) || !isSupportedExcalidrawPath(input.toPath)))
			|| (input.kind === "delete" && !isSupportedExcalidrawPath(input.path))) {
			throw new TypeError("invalid_excalidraw_lifecycle");
		}
		await assertRequestDigest(input);
	}

	private lifecycleReceipt(input: ExcalidrawLifecycleRequest, resultPath: string,
		resultLifecycle: "active" | "tombstoned", vaultSequence: number, rootGeneration: number,
		replayed: boolean): ExcalidrawLifecycleReceipt {
		return { protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: input.operationId,
			requestDigest: input.requestDigest, drawingId: input.drawingId, drawingEpoch: input.drawingEpoch,
			kind: input.kind, resultPath, resultLifecycle, vaultSequence, rootGeneration, replayed };
	}

	private async fenceDrawing(drawingId: string): Promise<void> {
		if (!this.options.drawings) return;
		const metadata = this.options.store().vaultMetadata();
		if (!metadata) return;
		const response = await this.options.drawings.call(`${metadata.vaultGeneration}:${drawingId}`,
			new Request("https://internal/__yaos/authority-fence", { method: "POST", headers: {
				"content-type": "application/json", "x-yaos-vault-id": metadata.vaultId,
				"x-yaos-vault-generation": metadata.vaultGeneration, "x-yaos-drawing-id": drawingId,
			}, body: JSON.stringify({ all: true, revokeShares: true, principalIds: [], deviceIds: [] }) }));
		if (!response.ok && response.status !== 404) throw new Error("excalidraw_socket_fence_failed");
	}

	private assertSourceCurrent(path: string, source: ExcalidrawSourceAuthority): void {
		if (source.kind === "markdown") {
			const row = this.options.storage.sql.exec<{ file_id: string; lifecycle: string; generation: number;
				body_epoch: number; content_hash: string | null; size: number | null; path: string }>(`SELECT file_id, lifecycle,
			 generation, body_epoch, content_hash, size, path FROM vault_catalog_events
			 WHERE body_id = ? ORDER BY sequence DESC LIMIT 1`, source.documentId).toArray()[0];
			if (!row || row.lifecycle !== "active" || row.path !== path || row.file_id !== source.fileId
				|| row.generation !== source.generation || row.body_epoch !== source.bodyEpoch
				|| row.content_hash !== source.contentHash || row.size !== source.size) throw new Error("excalidraw_source_changed");
		} else {
			const row = this.options.storage.sql.exec<{ lifecycle: string; content_hash: string | null; size: number | null;
				operation_id: string }>(`SELECT lifecycle, content_hash, size, operation_id
			 FROM vault_attachment_catalog_events WHERE path = ? ORDER BY sequence DESC LIMIT 1`, path).toArray()[0];
			if (!row || row.lifecycle !== "active" || row.content_hash !== source.contentHash
				|| row.size !== source.size || row.operation_id !== source.revision) throw new Error("excalidraw_source_changed");
		}
	}

	private prepared(operationId: string): PreparedRow | null {
		return this.options.storage.sql.exec<PreparedRow>(`SELECT operation_id, request_digest, drawing_id, path,
			 source_json, initialization_request_digest, prepare_permit_id, principal_id, membership_revision, device_id, device_credential_revision
		 FROM vault_excalidraw_prepares WHERE operation_id = ?`, operationId).toArray()[0] ?? null;
	}

	private activeDrawing(drawingId: string): DrawingRow | null {
		const head = this.options.store().excalidrawHeadAt(this.options.store().currentSequence(), drawingId);
		if (!head || head.lifecycle !== "active") return null;
		return { drawing_id: drawingId, file_id: head.fileId, path: head.path,
			drawing_epoch: head.documentEpoch, lifecycle: "active" };
	}

	private finalizeReceipt(operationId: string): FinalizeRow | null {
		return this.options.storage.sql.exec<FinalizeRow>(`SELECT request_digest, receipt_json
		 FROM vault_excalidraw_finalize_receipts WHERE operation_id = ?`, operationId).toArray()[0] ?? null;
	}

	private prepareReceipt(row: PreparedRow, replayed: boolean): ExcalidrawPromotionPrepareReceipt {
		return { protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: row.operation_id,
			requestDigest: row.request_digest, drawingId: row.drawing_id, drawingEpoch: 1,
			path: row.path, source: JSON.parse(row.source_json) as ExcalidrawSourceAuthority,
			preparePermitId: row.prepare_permit_id, replayed };
	}

	private initializeSchema(): void {
		if (this.initialized) return;
		this.options.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS vault_excalidraw_prepares (
				operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, drawing_id TEXT NOT NULL,
				path TEXT NOT NULL, source_json TEXT NOT NULL, initialization_request_digest TEXT NOT NULL,
				prepare_permit_id TEXT NOT NULL UNIQUE,
				principal_id TEXT NOT NULL, membership_revision INTEGER NOT NULL, device_id TEXT NOT NULL,
				device_credential_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE UNIQUE INDEX IF NOT EXISTS vault_excalidraw_prepare_drawing ON vault_excalidraw_prepares(drawing_id);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_drawings (
				drawing_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
				drawing_epoch INTEGER NOT NULL, lifecycle TEXT NOT NULL, room_sequence INTEGER NOT NULL,
				initialized_operation_id TEXT NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_permits (
				operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, drawing_id TEXT NOT NULL,
				drawing_epoch INTEGER NOT NULL, kind TEXT NOT NULL, permit_json TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_finalize_receipts (
				operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS vault_excalidraw_share_permits (
				operation_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, drawing_id TEXT NOT NULL,
				drawing_epoch INTEGER NOT NULL, share_id TEXT NOT NULL, grant_revision INTEGER NOT NULL,
				session_id TEXT NOT NULL, permit_json TEXT NOT NULL, created_at INTEGER NOT NULL
			);
		`);
		this.initialized = true;
	}
}

async function assertRequestDigest<T extends { requestDigest: string }>(input: T): Promise<void> {
	const actual = await sha256Hex(new TextEncoder().encode(canonicalExcalidrawJson(excalidrawRequestDigestInput(input))));
	if (actual !== input.requestDigest) throw new TypeError("invalid_excalidraw_request_digest");
}

function validSource(source: unknown): source is ExcalidrawSourceAuthority {
	if (!source || typeof source !== "object" || Array.isArray(source)) return false;
	const value = source as Record<string, unknown>;
	if (!isExcalidrawDigest(value.contentHash) || !Number.isSafeInteger(value.size) || (value.size as number) < 0) return false;
	return value.kind === "markdown"
		? isExcalidrawIdentity(value.documentId) && isExcalidrawIdentity(value.fileId)
			&& isExcalidrawEpoch(value.bodyEpoch) && Number.isSafeInteger(value.generation) && (value.generation as number) >= 1
		: value.kind === "attachment" && isExcalidrawIdentity(value.revision);
}
