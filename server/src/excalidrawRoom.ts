import { authorizeVaultAction, type VaultActorContext } from "./collaboration";
import { actorHeaders, parseVaultActor } from "./vaultAuthority";
import { CloudflareObjectStore } from "./cloudflarePorts";
import { sha256Hex } from "./hex";
import type { ActorCallPort, ObjectStorePort } from "./platformPorts";
import { randomBase64Url } from "./base64url";
import { blobKey } from "./vaultObjectStore";
import { PresenceKernel, type PresenceSocketAttachment } from "./presenceKernel";
import {
	EXCALIDRAW_PROTOCOL_VERSION,
	MAX_EXCALIDRAW_ACTIVE_ELEMENTS,
	MAX_EXCALIDRAW_REPLAY_BYTES,
	MAX_EXCALIDRAW_REPLAY_EVENTS,
	MAX_EXCALIDRAW_SCENE_ELEMENTS,
	canonicalExcalidrawJson,
	decideExcalidrawElement,
	excalidrawRequestDigestInput,
	isExcalidrawDigest,
	isExcalidrawEpoch,
	isExcalidrawIdentity,
	validateExcalidrawElements,
	validateExcalidrawMetadata,
	type ExcalidrawAuthorityPermit,
	type ExcalidrawAuthorityReservationRequest,
	type ExcalidrawBatchReceipt,
	type ExcalidrawBatchRequest,
	type ExcalidrawElementRecord,
	type ExcalidrawInitializeRequest,
	type ExcalidrawReplayPage,
	type ExcalidrawResetRequest,
	type ExcalidrawRoomEvent,
	type ExcalidrawSceneMetadata,
	type ExcalidrawSnapshot,
} from "./shared/excalidrawProtocol";
import {
	EXCALIDRAW_SHARE_PROTOCOL_VERSION,
	EXCALIDRAW_SHARE_SESSION_TTL_MS,
	MAX_EXCALIDRAW_SHARE_SESSIONS,
	MAX_EXCALIDRAW_SHARES_PER_DRAWING,
	PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1,
	PUBLIC_EXCALIDRAW_ELEMENT_TYPES_V1,
	canonicalExcalidrawShareJson,
	excalidrawShareDigestInput,
	isExcalidrawSharePermission,
	validateExcalidrawPublicResources,
	validateExcalidrawShareExpiry,
	type ExcalidrawPublicResource,
	type ExcalidrawShareCreateRequest,
	type ExcalidrawShareGrantPublic,
	type ExcalidrawSharePermission,
	type ExcalidrawShareRevokeRequest,
	type ExcalidrawShareUpdateRequest,
} from "./shared/excalidrawShareProtocol";
import {
	MAX_PRESENCE_FRAME_BYTES,
	MAX_PRESENCE_SESSIONS,
	MAX_SCENE_SOCKET_BUFFER_BYTES,
	parsePresenceClientUpdate,
	presenceColors,
} from "./shared/presenceProtocol";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "./shared/socketCloseCodes";

const DRAWING_ID_HEADER = "x-yaos-drawing-id";
const MAX_ROOM_EVENTS_BEFORE_COMPACTION = 2_048;
const RETAIN_ROOM_EVENTS = 256;

interface CloudflareExcalidrawRoomEnvironment {
	YAOS_SYNC: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
}

interface RoomMetaRow extends Record<string, SqlStorageValue> {
	vault_id: string;
	vault_generation: string;
	drawing_id: string;
	drawing_epoch: number;
	sequence: number;
	compacted_through: number;
	metadata_json: string;
}

interface ElementRow extends Record<string, SqlStorageValue> {
	element_json: string;
}

interface ReceiptRow extends Record<string, SqlStorageValue> {
	request_digest: string;
	receipt_json: string;
}

interface EventRow extends Record<string, SqlStorageValue> {
	sequence: number;
	event_json: string;
}

interface ShareRow extends Record<string, SqlStorageValue> {
	share_id: string;
	public_drawing_id: string;
	link_secret_hash: string;
	grant_revision: number;
	permission: ExcalidrawSharePermission;
	expires_at: number;
	state: "active" | "revoked";
	resources_json: string;
}

interface ShareSessionRow extends Record<string, SqlStorageValue> {
	session_id: string;
	share_id: string;
	grant_revision: number;
	token_hash: string;
	display_name: string;
	color_seed: string;
	expires_at: number;
}

interface ShareExpiryRow extends Record<string, SqlStorageValue> {
	expires_at: number | null;
}

interface RoomSocketAttachment extends PresenceSocketAttachment {
	authorityKind?: "vault" | "share";
	sessionId: string;
	vaultId: string;
	vaultGeneration: string;
	drawingId: string;
	drawingEpoch: number;
	principalId: string;
	deviceId: string;
	displayName: string;
	colorSeed: string;
	shareId?: string;
	grantRevision?: number;
}

interface RoomSqlCursor<T> extends Iterable<T> {
	toArray(): T[];
	one(): T;
	rowsWritten: number;
}

interface RoomSqlPort {
	exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): RoomSqlCursor<T>;
}

export interface ExcalidrawRoomStoragePort {
	readonly sql: RoomSqlPort;
	transactionSync<T>(closure: () => T): T;
}

export interface ExcalidrawRoomSocketPort {
	readonly bufferedAmount?: number;
	send(message: string | ArrayBuffer): void;
	close(code?: number, reason?: string): void;
	serializeAttachment(attachment: unknown): void;
	deserializeAttachment(): unknown;
}

export interface ExcalidrawRoomSocketRegistryPort {
	sockets(): readonly ExcalidrawRoomSocketPort[];
	createPair(): { client: unknown; server: ExcalidrawRoomSocketPort };
	accept(socket: ExcalidrawRoomSocketPort): void;
	upgradeResponse(client: unknown): Response;
}

export interface ExcalidrawRoomRuntimeOptions {
	storage: ExcalidrawRoomStoragePort;
	sockets: ExcalidrawRoomSocketRegistryPort;
	vaults: ActorCallPort;
	objectStore?: ObjectStorePort;
	now?: () => number;
	schedule?: (delayMs: number, callback: () => void) => void;
	alarms?: { setAlarm(scheduledTime: number): Promise<void>; deleteAlarm(): Promise<void> };
}

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export class ExcalidrawRoomRuntime {
	private readonly sql: RoomSqlPort;
	private readonly presence: PresenceKernel<RoomSocketAttachment, ExcalidrawRoomSocketPort>;

	constructor(private readonly options: ExcalidrawRoomRuntimeOptions) {
		this.sql = options.storage.sql;
		this.initializeSchema();
		this.presence = new PresenceKernel({
			sockets: () => options.sockets.sockets(),
			isAuthoritative: (attachment) => this.socketIsAuthoritative(attachment),
			projectEntry: (entry, source, recipient) => {
				if (recipient.authorityKind !== "share") {
					if (source.authorityKind !== "share") return entry;
					const participantId = publicPresenceParticipantId(source.shareId, source.sessionId);
					return { ...entry, sessionId: participantId, identity: {
						principalId: `guest_${participantId}`, deviceId: `session_${participantId}`,
						displayName: source.displayName, ...presenceColors(participantId) } };
				}
				const participantId = publicPresenceParticipantId(recipient.shareId, source.sessionId);
				const followSessionId = entry.state.followSessionId;
				return { ...entry, sessionId: participantId, identity: { participantId,
					kind: source.authorityKind === "share" ? "guest" : "member",
					displayName: source.authorityKind === "share" ? source.displayName : "Vault collaborator",
					...presenceColors(participantId) }, state: followSessionId
						? { ...entry.state, followSessionId: publicPresenceParticipantId(recipient.shareId, followSessionId) }
						: entry.state };
			},
			projectSessionId: (sessionId, source, recipient) => recipient.authorityKind === "share"
				? publicPresenceParticipantId(recipient.shareId, sessionId)
				: source.authorityKind === "share" ? publicPresenceParticipantId(source.shareId, sessionId) : sessionId,
			authorityCloseCode: AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE,
			authorityCloseReason: "drawing authority changed",
			...(options.now ? { now: options.now } : {}),
			...(options.schedule ? { schedule: options.schedule } : {}),
		});
	}

	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url);
			const drawingId = request.headers.get(DRAWING_ID_HEADER);
			const vaultId = request.headers.get("x-yaos-vault-id");
			const vaultGeneration = request.headers.get("x-yaos-vault-generation");
			if (!isExcalidrawIdentity(drawingId) || !isExcalidrawIdentity(vaultId)
				|| !isExcalidrawIdentity(vaultGeneration)) return json({ error: "invalid_excalidraw_room_identity" }, 400);
			if (request.method === "POST" && url.pathname === "/__yaos/authority-fence") {
				return this.closeFencedActors(drawingId, vaultId, vaultGeneration, await request.json());
			}
			if (url.pathname.startsWith("/__yaos/public/")) {
				return await this.publicFetch(request, url, drawingId, vaultId, vaultGeneration);
			}
			const actor = parseVaultActor(request, vaultId, vaultGeneration);
			if (!actor) return json({ error: "missing_trusted_actor" }, 401);
			if (url.pathname === "/shares" && request.method === "GET") return this.listShares(actor, drawingId);
			if (url.pathname === "/shares" && request.method === "POST") {
				return await this.createShare(actor, drawingId, await request.json<ExcalidrawShareCreateRequest>());
			}
			if (url.pathname.startsWith("/shares/") && request.method === "PATCH") {
				return await this.updateShare(actor, drawingId, url.pathname.slice(8), await request.json<ExcalidrawShareUpdateRequest>());
			}
			if (url.pathname.startsWith("/shares/") && request.method === "DELETE") {
				return await this.revokeShare(actor, drawingId, url.pathname.slice(8), await request.json<ExcalidrawShareRevokeRequest>());
			}
			if (request.method === "POST" && url.pathname === "/initialize") {
				return await this.initializeRoom(drawingId, actor, await request.json<ExcalidrawInitializeRequest>());
			}
			if (request.method === "POST" && url.pathname === "/batch") {
				return await this.applyBatch(drawingId, actor, await request.json<ExcalidrawBatchRequest>());
			}
			if (request.method === "POST" && url.pathname === "/reset") {
				return await this.reset(drawingId, actor, await request.json<ExcalidrawResetRequest>());
			}
			if (request.method === "GET" && url.pathname === "/snapshot") {
				await this.authorizeRead(actor, drawingId);
				return this.snapshot(drawingId);
			}
			if (request.method === "GET" && url.pathname === "/replay") {
				await this.authorizeRead(actor, drawingId);
				return this.replay(drawingId, Number(url.searchParams.get("after") ?? "0"));
			}
			if (request.method === "GET" && url.pathname === "/receipt") {
				const operationId = url.searchParams.get("operationId");
				const requestDigest = url.searchParams.get("requestDigest");
				if (!isExcalidrawIdentity(operationId) || !isExcalidrawDigest(requestDigest)) return json({ error: "invalid_excalidraw_receipt_query" }, 400);
				const receipt = this.receipt(operationId);
				return receipt?.request_digest === requestDigest ? json(JSON.parse(receipt.receipt_json))
					: json({ error: "excalidraw_receipt_not_found" }, 404);
			}
			if (request.method === "GET" && url.pathname === "/ws") return await this.connect(request, drawingId, actor);
			return json({ error: "not_found" }, 404);
		} catch (error) {
			const message = error instanceof Error ? error.message : "excalidraw_room_failed";
			const status = message.includes("too_large") ? 413
				: message.includes("dependency_closure") || message.includes("equivocation") || message.includes("diverged") ? 409
				: message.includes("invalid") || message.includes("duplicate") ? 400
					: message.includes("not_active") ? 404 : 409;
			return json({ error: message }, status);
		}
	}

	async webSocketMessage(socket: ExcalidrawRoomSocketPort, message: string | ArrayBuffer): Promise<void> {
		const attachment = socket.deserializeAttachment() as RoomSocketAttachment | null;
		const meta = this.meta();
		if (!attachment || !meta || !this.socketIsAuthoritative(attachment)) {
			socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "drawing authority changed");
			return;
		}
		try {
			const bytes = typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
			if (bytes.byteLength > MAX_PRESENCE_FRAME_BYTES) {
				socket.close(1009, "room frame too large");
				return;
			}
			const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
			if (isPingFrame(input)) {
				this.presence.sweepExpired();
				this.presence.flushDue();
				this.safeSendDurable(socket, canonicalExcalidrawJson({ type: "pong",
					protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, nonce: input.nonce }));
				return;
			}
			const update = parsePresenceClientUpdate(input);
			if (!update) throw new TypeError("invalid_presence_frame");
			this.presence.acceptUpdate(socket, attachment, update.clientSequence, update.state);
		} catch (error) {
			if (error instanceof SyntaxError || error instanceof TypeError) socket.close(1008, "invalid room frame");
			else socket.close(1011, "room frame failed");
		}
	}

	webSocketClose(socket?: ExcalidrawRoomSocketPort): void {
		if (socket) this.presence.remove(socket, "closed");
	}

	webSocketError(socket: ExcalidrawRoomSocketPort): void {
		this.presence.remove(socket, "closed");
		try { socket.close(1011, "socket error"); } catch { /* already closed */ }
	}

	async alarm(): Promise<void> {
		const now = this.now();
		this.options.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM excalidraw_share_sessions WHERE expires_at <= ?", now).toArray();
		});
		for (const socket of this.options.sockets.sockets()) {
			const attachment = socket.deserializeAttachment() as RoomSocketAttachment | null;
			if (attachment?.authorityKind !== "share" || this.socketIsAuthoritative(attachment)) continue;
			this.presence.remove(socket, "expired");
			try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "share authority expired"); }
			catch { /* already closed */ }
		}
		await this.rescheduleShareExpiryAlarm();
	}

	private closeFencedActors(drawingId: string, vaultId: string, vaultGeneration: string, input: unknown): Response {
		const meta = this.meta();
		if (!meta || meta.drawing_id !== drawingId || meta.vault_id !== vaultId
			|| meta.vault_generation !== vaultGeneration) return json({ error: "excalidraw_drawing_not_active" }, 404);
		if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "invalid_authority_fence" }, 400);
		const body = input as { all?: unknown; revokeShares?: unknown; principalIds?: unknown; deviceIds?: unknown };
		if (!Array.isArray(body.principalIds) || !Array.isArray(body.deviceIds)
			|| (body.all !== undefined && typeof body.all !== "boolean")
			|| (body.revokeShares !== undefined && typeof body.revokeShares !== "boolean")
			|| body.principalIds.some((value) => !isExcalidrawIdentity(value))
			|| body.deviceIds.some((value) => !isExcalidrawIdentity(value))) return json({ error: "invalid_authority_fence" }, 400);
		const principalIds = new Set(body.principalIds as string[]);
		const deviceIds = new Set(body.deviceIds as string[]);
		if (body.revokeShares === true) this.options.storage.transactionSync(() => {
			this.sql.exec("UPDATE excalidraw_share_grants SET state = 'revoked', grant_revision = grant_revision + 1, updated_at = ? WHERE state = 'active'",
				Date.now()).toArray();
			this.sql.exec("DELETE FROM excalidraw_share_sessions").toArray();
		});
		let closed = 0;
		for (const socket of this.options.sockets.sockets()) {
			const attachment = socket.deserializeAttachment() as RoomSocketAttachment | null;
			if (!attachment || (body.all !== true
				&& !principalIds.has(attachment.principalId) && !deviceIds.has(attachment.deviceId))) continue;
			this.presence.remove(socket, "fenced");
			try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "vault authority changed"); closed++; }
			catch { /* already closed */ }
		}
		return json({ closed });
	}

	compact(): { compactedThrough: number; deletedEvents: number } {
		const meta = this.requireMeta();
		const floor = Math.max(meta.compacted_through, meta.sequence - RETAIN_ROOM_EVENTS);
		let deletedEvents = 0;
		this.options.storage.transactionSync(() => {
			const deletion = this.sql.exec("DELETE FROM excalidraw_room_events WHERE sequence <= ?", floor);
			deletion.toArray();
			deletedEvents = deletion.rowsWritten;
			this.sql.exec("UPDATE excalidraw_room_meta SET compacted_through = ? WHERE id = 1", floor).toArray();
		});
		return { compactedThrough: floor, deletedEvents };
	}

	private async initializeRoom(drawingId: string, actor: VaultActorContext, request: ExcalidrawInitializeRequest): Promise<Response> {
		await this.validateInitialize(request);
		this.validateDependencyClosure(new Map(request.elements.map((element) => [element.id, element] as const)));
		if (this.meta()) return this.replayReceipt(request.operationId, request.requestDigest, "excalidraw_room_already_initialized");
		const permit = await this.reserve(actor, drawingId, {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			operationId: request.operationId,
			requestDigest: request.requestDigest,
			drawingId,
			drawingEpoch: 1,
			kind: "initialize",
			prepareOperationId: request.prepareOperationId,
		});
		let receipt: ExcalidrawBatchReceipt;
		this.options.storage.transactionSync(() => {
			if (this.meta()) throw new Error("excalidraw_room_already_initialized");
			const metadataJson = canonicalExcalidrawJson(request.metadata);
			this.sql.exec(`INSERT INTO excalidraw_room_meta(
			 id, vault_id, vault_generation, drawing_id, drawing_epoch, sequence, compacted_through, metadata_json
			) VALUES (1, ?, ?, ?, 1, 1, 1, ?)`, actor.vaultId, actor.vaultGeneration, drawingId, metadataJson).toArray();
			for (const element of request.elements) this.writeElement(element, 1);
			receipt = this.makeReceipt(request, drawingId, 1, request.elements.map((element) => element.id), [], true, false);
			this.writeReceipt(receipt!, permit.permitId);
		});
		return json(receipt!, 201);
	}

	private async applyBatch(drawingId: string, actor: VaultActorContext, request: ExcalidrawBatchRequest): Promise<Response> {
		await this.validateBatch(request);
		const prior = this.receipt(request.operationId);
		if (prior) return prior.request_digest === request.requestDigest
			? json({ ...(JSON.parse(prior.receipt_json) as ExcalidrawBatchReceipt), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
		const metaBefore = this.requireActiveMeta(drawingId, actor, request.drawingEpoch);
		const permit = await this.reserve(actor, drawingId, {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			operationId: request.operationId,
			requestDigest: request.requestDigest,
			drawingId,
			drawingEpoch: request.drawingEpoch,
			kind: "mutate",
		});
		let event: ExcalidrawRoomEvent | null = null;
		let receipt: ExcalidrawBatchReceipt;
		this.options.storage.transactionSync(() => {
			const raced = this.receipt(request.operationId);
			if (raced) {
				if (raced.request_digest !== request.requestDigest) throw new Error("excalidraw_operation_id_reused");
				receipt = { ...(JSON.parse(raced.receipt_json) as ExcalidrawBatchReceipt), replayed: true };
				return;
			}
			const meta = this.requireActiveMeta(drawingId, actor, request.drawingEpoch);
			if (meta.sequence !== metaBefore.sequence) {
				// Native element reconciliation is sequence-independent, but this re-read
				// ensures all decisions are made against the latest transactional state.
			}
			const accepted: ExcalidrawElementRecord[] = [];
			const stale: string[] = [];
			for (const incoming of request.elements) {
				const current = this.element(incoming.id);
				if (!current) accepted.push(incoming);
				else {
					const decision = decideExcalidrawElement(incoming, current);
					if (decision === "divergent") throw new Error("excalidraw_equal_revision_diverged");
					if (decision === "incoming") accepted.push(incoming);
					else stale.push(incoming.id);
				}
			}
			if (accepted.length > 0) {
				const proposed = new Map(this.sql.exec<ElementRow>(
					"SELECT element_json FROM excalidraw_room_elements",
				).toArray().map((row) => {
					const element = JSON.parse(row.element_json) as ExcalidrawElementRecord;
					return [element.id, element] as const;
				}));
				for (const element of accepted) proposed.set(element.id, element);
				if (proposed.size > MAX_EXCALIDRAW_SCENE_ELEMENTS) throw new Error("excalidraw_scene_too_large");
				this.validateDependencyClosure(proposed);
			}
			const mergedMetadata = request.metadata === undefined ? undefined
				: mergeSceneMetadata(JSON.parse(meta.metadata_json) as ExcalidrawSceneMetadata, request.metadata);
			const metadataChanged = mergedMetadata !== undefined
				&& canonicalExcalidrawJson(mergedMetadata) !== meta.metadata_json;
			const changesState = accepted.length > 0 || metadataChanged;
			const sequence = changesState ? meta.sequence + 1 : meta.sequence;
			for (const element of accepted) this.writeElement(element, sequence);
			if (changesState) {
				if (mergedMetadata) this.sql.exec(
					"UPDATE excalidraw_room_meta SET sequence = ?, metadata_json = ? WHERE id = 1",
					sequence, canonicalExcalidrawJson(mergedMetadata),
				).toArray();
				else this.sql.exec("UPDATE excalidraw_room_meta SET sequence = ? WHERE id = 1", sequence).toArray();
				event = { protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, sequence,
					operationId: request.operationId, drawingEpoch: request.drawingEpoch, elements: accepted,
					...(mergedMetadata ? { metadata: mergedMetadata } : {}) };
				this.sql.exec("INSERT INTO excalidraw_room_events(sequence, operation_id, event_json) VALUES (?, ?, ?)",
					sequence, request.operationId, canonicalExcalidrawJson(event)).toArray();
			}
			receipt = this.makeReceipt(request, drawingId, sequence, accepted.map((element) => element.id), stale,
				metadataChanged, false);
			this.writeReceipt(receipt!, permit.permitId);
		});
		if (event) this.broadcastDurableEvent(event);
		this.maybeCompact();
		return json(receipt!);
	}

	private async reset(drawingId: string, actor: VaultActorContext, request: ExcalidrawResetRequest): Promise<Response> {
		await this.validateReset(request);
		this.validateDependencyClosure(new Map(request.elements.map((element) => [element.id, element] as const)));
		const prior = this.receipt(request.operationId);
		if (prior) return prior.request_digest === request.requestDigest
			? json({ ...(JSON.parse(prior.receipt_json) as ExcalidrawBatchReceipt), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
		const current = this.requireActiveMeta(drawingId, actor, request.previousDrawingEpoch);
		if (request.drawingEpoch !== request.previousDrawingEpoch + 1) return json({ error: "invalid_excalidraw_epoch_transition" }, 400);
		const permit = await this.reserve(actor, drawingId, {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			operationId: request.operationId,
			requestDigest: request.requestDigest,
			drawingId,
			drawingEpoch: request.drawingEpoch,
			kind: "reset",
			previousDrawingEpoch: request.previousDrawingEpoch,
		});
		let receipt: ExcalidrawBatchReceipt;
		const sequence = current.sequence + 1;
		this.options.storage.transactionSync(() => {
			const exact = this.requireActiveMeta(drawingId, actor, request.previousDrawingEpoch);
			if (exact.sequence !== current.sequence) throw new Error("excalidraw_reset_head_changed");
			this.sql.exec("DELETE FROM excalidraw_room_elements").toArray();
			this.sql.exec("DELETE FROM excalidraw_room_events").toArray();
			this.sql.exec(`UPDATE excalidraw_room_meta SET drawing_epoch = ?, sequence = ?, compacted_through = ?,
			 metadata_json = ? WHERE id = 1`, request.drawingEpoch, sequence, sequence,
			canonicalExcalidrawJson(request.metadata)).toArray();
			for (const element of request.elements) this.writeElement(element, sequence);
			receipt = this.makeReceipt(request, drawingId, sequence, request.elements.map((element) => element.id), [], true, false);
			this.writeReceipt(receipt!, permit.permitId);
		});
		this.closeSockets("drawing epoch reset");
		return json(receipt!);
	}

	private snapshot(drawingId: string): Response {
		try { return json(this.snapshotValue(drawingId)); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "excalidraw_drawing_not_active" }, 404); }
	}

	private snapshotValue(drawingId: string): ExcalidrawSnapshot {
		const meta = this.requireMeta();
		if (meta.drawing_id !== drawingId) throw new Error("excalidraw_drawing_not_active");
		const snapshot: ExcalidrawSnapshot = {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			drawingId,
			drawingEpoch: meta.drawing_epoch,
			sequence: meta.sequence,
			compactedThrough: meta.compacted_through,
			elements: this.sql.exec<ElementRow>(
				"SELECT element_json FROM excalidraw_room_elements ORDER BY element_index, element_id",
			).toArray().map((row) => JSON.parse(row.element_json) as ExcalidrawElementRecord),
			metadata: JSON.parse(meta.metadata_json) as ExcalidrawSceneMetadata,
		};
		return snapshot;
	}

	private replay(drawingId: string, after: number): Response {
		if (!Number.isSafeInteger(after) || after < 0) return json({ error: "invalid_excalidraw_replay_cursor" }, 400);
		const meta = this.requireMeta();
		if (meta.drawing_id !== drawingId) return json({ error: "excalidraw_drawing_not_active" }, 404);
		if (after > meta.sequence) return json({ error: "invalid_excalidraw_replay_cursor" }, 400);
		const result: ExcalidrawRoomEvent[] = [];
		let bytes = 0;
		let truncated = false;
		for (const row of this.sql.exec<EventRow>(
			"SELECT sequence, event_json FROM excalidraw_room_events WHERE sequence > ? ORDER BY sequence LIMIT ?",
			after, MAX_EXCALIDRAW_REPLAY_EVENTS + 1,
		)) {
			const rowBytes = new TextEncoder().encode(row.event_json).byteLength;
			if (result.length >= MAX_EXCALIDRAW_REPLAY_EVENTS || bytes + rowBytes > MAX_EXCALIDRAW_REPLAY_BYTES) {
				truncated = true;
				break;
			}
			bytes += rowBytes;
			result.push(JSON.parse(row.event_json) as ExcalidrawRoomEvent);
		}
		const through = result.at(-1)?.sequence ?? after;
		const response: ExcalidrawReplayPage = {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			drawingId,
			drawingEpoch: meta.drawing_epoch,
			after,
			through,
			compactedThrough: meta.compacted_through,
			snapshotRequired: after < meta.compacted_through,
			events: after < meta.compacted_through ? [] : result,
			nextCursor: after < meta.compacted_through ? null : truncated ? through : null,
		};
		return json(response);
	}

	private async connect(request: Request, drawingId: string, actor: VaultActorContext): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
		const url = new URL(request.url);
		const sessionId = url.searchParams.get("sessionId");
		const drawingEpoch = Number(request.headers.get("x-yaos-drawing-epoch"));
		if (!isExcalidrawIdentity(sessionId) || !isExcalidrawEpoch(drawingEpoch)) return json({ error: "invalid_excalidraw_session" }, 400);
		this.requireActiveMeta(drawingId, actor, drawingEpoch);
		this.presence.sweepExpired();
		if (this.presence.hasSession(sessionId)) return json({ error: "excalidraw_session_already_connected" }, 409);
		if (this.presence.authoritativeSockets().length >= MAX_PRESENCE_SESSIONS) {
			return json({ error: "excalidraw_room_session_limit" }, 429);
		}
		const requestDigest = await sha256Hex(new TextEncoder().encode(canonicalExcalidrawJson({ sessionId, drawingId, drawingEpoch })));
		const permit = await this.reserve(actor, drawingId, {
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			operationId: sessionId,
			requestDigest,
			drawingId,
			drawingEpoch,
			kind: "connect",
		});
		const pair = this.options.sockets.createPair();
		pair.server.serializeAttachment({ authorityKind: "vault", sessionId, vaultId: actor.vaultId, vaultGeneration: actor.vaultGeneration,
			drawingId, drawingEpoch, principalId: permit.principalId, deviceId: permit.deviceId,
			displayName: permit.displayName, colorSeed: permit.colorSeed } satisfies RoomSocketAttachment);
		this.options.sockets.accept(pair.server);
		this.safeSendDurable(pair.server, canonicalExcalidrawJson({ type: "hello", protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			drawingId, drawingEpoch, sequence: this.requireMeta().sequence, sessionId }));
		this.presence.sendSnapshot(pair.server);
		return this.options.sockets.upgradeResponse(pair.client);
	}

	private async publicFetch(request: Request, url: URL, drawingId: string,
		vaultId: string, vaultGeneration: string): Promise<Response> {
		const shareId = request.headers.get("x-yaos-share-id");
		if (!isExcalidrawIdentity(shareId)) return json({ error: "invalid_excalidraw_share" }, 400);
		const meta = this.requireMeta();
		if (Number(request.headers.get("x-yaos-drawing-epoch")) !== meta.drawing_epoch) {
			return json({ error: "excalidraw_share_authority_superseded" }, 409);
		}
		if (request.method === "POST" && url.pathname === "/__yaos/public/session") {
			const body = await request.json<{ linkSecretHash?: unknown; displayName?: unknown }>();
			return this.createShareSession(shareId, body.linkSecretHash, body.displayName);
		}
		const session = this.authorizeShareSession(request, shareId);
		if (!session) return json({ error: "excalidraw_share_session_invalid" }, 401);
		const grant = this.requireActiveShare(shareId, session.grant_revision);
		if (request.method === "GET" && url.pathname === "/__yaos/public/snapshot") {
			return json(this.publicSnapshot(drawingId, grant));
		}
		if (request.method === "GET" && url.pathname === "/__yaos/public/replay") {
			return this.publicReplay(drawingId, grant, Number(url.searchParams.get("after") ?? "0"));
		}
		if (request.method === "POST" && url.pathname === "/__yaos/public/batch") {
			if (grant.permission !== "read-write") return json({ error: "excalidraw_share_read_only" }, 403);
			return this.applyPublicBatch(drawingId, vaultId, vaultGeneration, grant, session,
				await request.json<ExcalidrawBatchRequest>());
		}
		if (request.method === "GET" && url.pathname === "/__yaos/public/ws") {
			return this.connectPublic(request, drawingId, grant, session);
		}
		if (url.pathname.startsWith("/__yaos/public/resources/")) {
			const publicResourceId = url.pathname.slice("/__yaos/public/resources/".length);
			if (!isExcalidrawIdentity(publicResourceId)) return json({ error: "invalid_excalidraw_share_resource" }, 400);
			if (request.method === "GET") return await this.readPublicResource(vaultId, vaultGeneration, grant, publicResourceId);
			if (request.method === "POST") {
				if (grant.permission !== "read-write") return json({ error: "excalidraw_share_read_only" }, 403);
				return await this.writePublicResource(request, vaultId, vaultGeneration, grant, session, publicResourceId);
			}
		}
		return json({ error: "not_found" }, 404);
	}

	private listShares(actor: VaultActorContext, drawingId: string): Response {
		const denied = authorizeVaultAction(actor, "vault.excalidraw.shares.manage");
		if (!denied.allowed) return json({ error: denied.reason }, 403);
		this.requireActiveMeta(drawingId, actor, this.requireMeta().drawing_epoch);
		const grants = this.sql.exec<ShareRow>(`SELECT share_id, public_drawing_id, link_secret_hash, grant_revision,
		 permission, expires_at, state, resources_json FROM excalidraw_share_grants ORDER BY share_id`).toArray();
		return json({ shares: grants.map((grant) => this.publicGrant(grant)) });
	}

	private async createShare(actor: VaultActorContext, drawingId: string, input: ExcalidrawShareCreateRequest): Promise<Response> {
		const denied = authorizeVaultAction(actor, "vault.excalidraw.shares.manage");
		if (!denied.allowed) return json({ error: denied.reason }, 403);
		await this.validateShareCreate(input);
		const replay = this.shareManagementReplay(input.operationId, input.requestDigest);
		if (replay) return replay;
		this.requireActiveMeta(drawingId, actor, this.requireMeta().drawing_epoch);
		const existing = this.share(input.shareId);
		if (existing) return json({ error: "excalidraw_share_id_reused" }, 409);
		const count = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM excalidraw_share_grants WHERE state = 'active'").one().count;
		if (count >= MAX_EXCALIDRAW_SHARES_PER_DRAWING) return json({ error: "excalidraw_share_limit" }, 409);
		await this.materializeResources(actor.vaultId, actor.vaultGeneration, input.shareId, 1, input.resources);
		const resourcesJson = canonicalExcalidrawShareJson(input.resources);
		this.options.storage.transactionSync(() => {
			this.sql.exec(`INSERT INTO excalidraw_share_grants(
		 share_id, public_drawing_id, link_secret_hash, grant_revision, permission, expires_at, state, resources_json,
		 created_by_principal_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 'active', ?, ?, ?, ?)`,
		input.shareId, input.publicDrawingId, input.linkSecretHash, input.permission, input.expiresAt, resourcesJson,
		actor.principalId, Date.now(), Date.now()).toArray();
			this.writeShareManagementReceipt(input.operationId, input.requestDigest, this.publicGrant(this.share(input.shareId)!));
		});
		await this.rescheduleShareExpiryAlarm();
		return json(this.publicGrant(this.share(input.shareId)!), 201);
	}

	private async updateShare(actor: VaultActorContext, drawingId: string, shareId: string,
		input: ExcalidrawShareUpdateRequest): Promise<Response> {
		const denied = authorizeVaultAction(actor, "vault.excalidraw.shares.manage");
		if (!denied.allowed) return json({ error: denied.reason }, 403);
		await this.validateShareUpdate(input);
		const replay = this.shareManagementReplay(input.operationId, input.requestDigest);
		if (replay) return replay;
		if (input.shareId !== shareId || !isExcalidrawIdentity(shareId)) return json({ error: "invalid_excalidraw_share" }, 400);
		this.requireActiveMeta(drawingId, actor, this.requireMeta().drawing_epoch);
		const current = this.share(shareId);
		if (!current || current.state !== "active") return json({ error: "excalidraw_share_not_active" }, 404);
		if (current.grant_revision !== input.expectedGrantRevision) return json({ error: "excalidraw_share_revision_changed" }, 409);
		const nextRevision = current.grant_revision + 1;
		await this.materializeResources(actor.vaultId, actor.vaultGeneration, shareId, nextRevision, input.resources);
		this.options.storage.transactionSync(() => {
			const exact = this.requireActiveShare(shareId, input.expectedGrantRevision);
			this.sql.exec(`UPDATE excalidraw_share_grants SET grant_revision = ?, permission = ?, expires_at = ?,
			 resources_json = ?, updated_at = ? WHERE share_id = ? AND grant_revision = ?`, nextRevision, input.permission,
			input.expiresAt, canonicalExcalidrawShareJson(input.resources), Date.now(), shareId, exact.grant_revision).toArray();
			this.sql.exec("DELETE FROM excalidraw_share_sessions WHERE share_id = ?", shareId).toArray();
			this.writeShareManagementReceipt(input.operationId, input.requestDigest, this.publicGrant(this.share(shareId)!));
		});
		this.closeShareSockets(shareId, "share authority changed");
		await this.rescheduleShareExpiryAlarm();
		return json(this.publicGrant(this.share(shareId)!));
	}

	private async revokeShare(actor: VaultActorContext, drawingId: string, shareId: string,
		input: ExcalidrawShareRevokeRequest): Promise<Response> {
		const denied = authorizeVaultAction(actor, "vault.excalidraw.shares.manage");
		if (!denied.allowed) return json({ error: denied.reason }, 403);
		await this.validateShareRevoke(input);
		const replay = this.shareManagementReplay(input.operationId, input.requestDigest);
		if (replay) return replay;
		if (input.shareId !== shareId || !isExcalidrawIdentity(shareId)) return json({ error: "invalid_excalidraw_share" }, 400);
		this.requireActiveMeta(drawingId, actor, this.requireMeta().drawing_epoch);
		const current = this.share(shareId);
		if (!current) return json({ error: "excalidraw_share_not_found" }, 404);
		if (current.state === "revoked") return json(this.publicGrant(current));
		if (current.grant_revision !== input.expectedGrantRevision) return json({ error: "excalidraw_share_revision_changed" }, 409);
		this.options.storage.transactionSync(() => {
			this.requireActiveShare(shareId, input.expectedGrantRevision);
			this.sql.exec("UPDATE excalidraw_share_grants SET grant_revision = grant_revision + 1, state = 'revoked', updated_at = ? WHERE share_id = ?",
				Date.now(), shareId).toArray();
			this.sql.exec("DELETE FROM excalidraw_share_sessions WHERE share_id = ?", shareId).toArray();
			this.writeShareManagementReceipt(input.operationId, input.requestDigest, this.publicGrant(this.share(shareId)!));
		});
		this.closeShareSockets(shareId, "share revoked");
		await this.rescheduleShareExpiryAlarm();
		return json(this.publicGrant(this.share(shareId)!));
	}

	private async createShareSession(shareId: string, linkSecretHash: unknown, displayName: unknown): Promise<Response> {
		const safeDisplayName = displayName === undefined ? "Guest" : displayName;
		if (!isExcalidrawDigest(linkSecretHash) || typeof safeDisplayName !== "string" || !validPublicDisplayName(safeDisplayName)) {
			return json({ error: "invalid_excalidraw_share_session" }, 400);
		}
		const grant = this.share(shareId);
		if (!grant || grant.state !== "active" || grant.expires_at <= this.now()
			|| !constantTimeText(grant.link_secret_hash, linkSecretHash)) return json({ error: "excalidraw_share_unavailable" }, 404);
		const count = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM excalidraw_share_sessions WHERE share_id = ? AND expires_at > ?",
			shareId, this.now()).one().count;
		if (count >= MAX_EXCALIDRAW_SHARE_SESSIONS) return json({ error: "excalidraw_share_session_limit" }, 429);
		const sessionId = randomBase64Url(18);
		const sessionToken = randomBase64Url(32);
		const expiresAt = Math.min(grant.expires_at, this.now() + EXCALIDRAW_SHARE_SESSION_TTL_MS);
		const tokenHash = await sha256Hex(new TextEncoder().encode(sessionToken));
		this.options.storage.transactionSync(() => {
			this.sql.exec(`INSERT INTO excalidraw_share_sessions(session_id, share_id, grant_revision, token_hash,
			 display_name, color_seed, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, sessionId, shareId,
			grant.grant_revision, tokenHash, safeDisplayName, randomBase64Url(16), expiresAt, this.now()).toArray();
		});
		await this.rescheduleShareExpiryAlarm();
		return json({ protocolVersion: EXCALIDRAW_SHARE_PROTOCOL_VERSION, sessionId, sessionToken,
			publicDrawingId: grant.public_drawing_id, grantRevision: grant.grant_revision,
			permission: grant.permission, expiresAt });
	}

	private authorizeShareSession(request: Request, shareId: string): ShareSessionRow | null {
		const sessionId = request.headers.get("x-yaos-share-session-id");
		const tokenHash = request.headers.get("x-yaos-share-session-token-hash");
		if (!isExcalidrawIdentity(sessionId) || !isExcalidrawDigest(tokenHash)) return null;
		const session = this.sql.exec<ShareSessionRow>(`SELECT session_id, share_id, grant_revision, token_hash,
		 display_name, color_seed, expires_at FROM excalidraw_share_sessions WHERE session_id = ?`, sessionId).toArray()[0] ?? null;
		return session && session.share_id === shareId && session.expires_at > this.now()
			&& constantTimeText(session.token_hash, tokenHash) ? session : null;
	}

	private publicSnapshot(drawingId: string, grant: ShareRow): Record<string, unknown> {
		const snapshot = this.snapshotValue(drawingId);
		return { ...this.projectSnapshot(snapshot, grant), shareProtocolVersion: EXCALIDRAW_SHARE_PROTOCOL_VERSION,
			publicDrawingId: grant.public_drawing_id, grantRevision: grant.grant_revision, permission: grant.permission };
	}

	private publicReplay(drawingId: string, grant: ShareRow, after: number): Response {
		const meta = this.requireMeta();
		if (!Number.isSafeInteger(after) || after < 0 || after > meta.sequence) return json({ error: "invalid_excalidraw_replay_cursor" }, 400);
		if (after < meta.compacted_through) return json({ shareProtocolVersion: EXCALIDRAW_SHARE_PROTOCOL_VERSION,
			publicDrawingId: grant.public_drawing_id, drawingEpoch: meta.drawing_epoch,
			grantRevision: grant.grant_revision, after,
			through: after, compactedThrough: meta.compacted_through, snapshotRequired: true, events: [], nextCursor: null });
		const rows = this.sql.exec<EventRow>(
			"SELECT sequence, event_json FROM excalidraw_room_events WHERE sequence > ? ORDER BY sequence LIMIT ?",
			after, MAX_EXCALIDRAW_REPLAY_EVENTS + 1).toArray();
		const selected = rows.slice(0, MAX_EXCALIDRAW_REPLAY_EVENTS).map((row) =>
			this.projectEvent(JSON.parse(row.event_json) as ExcalidrawRoomEvent, grant));
		const through = selected.at(-1)?.sequence ?? after;
		return json({ shareProtocolVersion: EXCALIDRAW_SHARE_PROTOCOL_VERSION, publicDrawingId: grant.public_drawing_id,
			drawingEpoch: meta.drawing_epoch,
			grantRevision: grant.grant_revision, after, through, compactedThrough: meta.compacted_through,
			snapshotRequired: false, events: selected, nextCursor: rows.length > selected.length ? through : null });
	}

	private async applyPublicBatch(drawingId: string, vaultId: string, vaultGeneration: string, grant: ShareRow,
		session: ShareSessionRow, request: ExcalidrawBatchRequest): Promise<Response> {
		await this.validateBatch(request);
		if (request.metadata !== undefined) return json({ error: "excalidraw_share_metadata_forbidden" }, 400);
		const canonicalElements = this.canonicalizePublicElements(request.elements, grant);
		const prior = this.shareReceipt(grant.share_id, request.operationId);
		if (prior) return prior.request_digest === request.requestDigest
			? json({ ...(JSON.parse(prior.receipt_json) as ExcalidrawBatchReceipt), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
		const permit = await this.reserveShareMutation(vaultId, vaultGeneration, drawingId, grant, session, request);
		let event: ExcalidrawRoomEvent | null = null;
		let receipt: ExcalidrawBatchReceipt;
		this.options.storage.transactionSync(() => {
			const exactGrant = this.requireActiveShare(grant.share_id, grant.grant_revision);
			if (exactGrant.permission !== "read-write") throw new Error("excalidraw_share_read_only");
			const exactSession = this.sql.exec<ShareSessionRow>(`SELECT session_id, share_id, grant_revision, token_hash,
			 display_name, color_seed, expires_at FROM excalidraw_share_sessions WHERE session_id = ?`, session.session_id).toArray()[0];
			if (!exactSession || exactSession.grant_revision !== exactGrant.grant_revision || exactSession.expires_at <= this.now()) {
				throw new Error("excalidraw_share_authority_superseded");
			}
			const raced = this.shareReceipt(grant.share_id, request.operationId);
			if (raced) {
				if (raced.request_digest !== request.requestDigest) throw new Error("excalidraw_operation_id_reused");
				receipt = { ...(JSON.parse(raced.receipt_json) as ExcalidrawBatchReceipt), replayed: true };
				return;
			}
			const meta = this.requireMeta();
			if (meta.drawing_id !== drawingId || meta.drawing_epoch !== request.drawingEpoch) throw new Error("excalidraw_authority_superseded");
			const accepted: ExcalidrawElementRecord[] = [];
			const stale: string[] = [];
			for (const incoming of canonicalElements) {
				const current = this.element(incoming.id);
				if (!current) accepted.push(incoming);
				else {
					const decision = decideExcalidrawElement(incoming, current);
					if (decision === "divergent") throw new Error("excalidraw_equal_revision_diverged");
					if (decision === "incoming") accepted.push(incoming); else stale.push(incoming.id);
				}
			}
			if (accepted.length > 0) {
				const proposed = new Map(this.sql.exec<ElementRow>("SELECT element_json FROM excalidraw_room_elements").toArray().map((row) => {
					const element = JSON.parse(row.element_json) as ExcalidrawElementRecord;
					return [element.id, element] as const;
				}));
				for (const element of accepted) proposed.set(element.id, element);
				this.validateDependencyClosure(proposed);
			}
			const sequence = accepted.length > 0 ? meta.sequence + 1 : meta.sequence;
			for (const element of accepted) this.writeElement(element, sequence);
			if (accepted.length > 0) {
				this.sql.exec("UPDATE excalidraw_room_meta SET sequence = ? WHERE id = 1", sequence).toArray();
				event = { protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, sequence, operationId: request.operationId,
					drawingEpoch: request.drawingEpoch, elements: accepted };
				this.sql.exec("INSERT INTO excalidraw_room_events(sequence, operation_id, event_json) VALUES (?, ?, ?)",
					sequence, `share:${grant.share_id}:${request.operationId}`, canonicalExcalidrawJson(event)).toArray();
			}
			receipt = this.makeReceipt(request, exactGrant.public_drawing_id, sequence,
				accepted.map((element) => element.id), stale, false, false);
			this.sql.exec(`INSERT INTO excalidraw_share_receipts(share_id, operation_id, request_digest, permit_id,
			 receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, grant.share_id, request.operationId,
				request.requestDigest, permit, canonicalExcalidrawJson(receipt), Date.now()).toArray();
		});
		if (event) this.broadcastDurableEvent(event);
		this.maybeCompact();
		return json(receipt!);
	}

	private async connectPublic(request: Request, drawingId: string, grant: ShareRow,
		session: ShareSessionRow): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
		const meta = this.requireMeta();
		if (meta.drawing_id !== drawingId) return json({ error: "excalidraw_drawing_not_active" }, 404);
		if (this.presence.hasSession(session.session_id)) return json({ error: "excalidraw_session_already_connected" }, 409);
		const pair = this.options.sockets.createPair();
		pair.server.serializeAttachment({ authorityKind: "share", sessionId: session.session_id,
			vaultId: meta.vault_id, vaultGeneration: meta.vault_generation, drawingId, drawingEpoch: meta.drawing_epoch,
			principalId: `share_${grant.share_id}`, deviceId: `session_${session.session_id}`,
			displayName: session.display_name, colorSeed: session.color_seed,
			shareId: grant.share_id, grantRevision: grant.grant_revision } satisfies RoomSocketAttachment);
		this.options.sockets.accept(pair.server);
		this.safeSendDurable(pair.server, canonicalExcalidrawJson({ type: "hello",
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, shareProtocolVersion: EXCALIDRAW_SHARE_PROTOCOL_VERSION,
			publicDrawingId: grant.public_drawing_id, drawingEpoch: meta.drawing_epoch, sequence: meta.sequence,
			sessionId: session.session_id, grantRevision: grant.grant_revision, permission: grant.permission }));
		this.presence.sendSnapshot(pair.server);
		return this.options.sockets.upgradeResponse(pair.client);
	}

	private async readPublicResource(vaultId: string, vaultGeneration: string, grant: ShareRow,
		publicResourceId: string): Promise<Response> {
		if (!this.options.objectStore) return json({ error: "excalidraw_share_resources_unavailable" }, 503);
		const resource = this.shareResources(grant).find((entry) => entry.publicResourceId === publicResourceId);
		if (!resource) return json({ error: "excalidraw_share_resource_not_found" }, 404);
		const object = await this.options.objectStore.get(shareResourceKey(vaultId, vaultGeneration, grant.share_id,
			grant.grant_revision, resource.publicResourceId, resource.contentHash));
		if (!object || object.size !== resource.size) return json({ error: "excalidraw_share_resource_not_found" }, 404);
		return new Response(object.bytes, { headers: { "content-type": resource.mime, "cache-control": "private, max-age=300",
			"x-content-type-options": "nosniff" } });
	}

	private async writePublicResource(request: Request, vaultId: string, vaultGeneration: string, grant: ShareRow,
		session: ShareSessionRow, publicResourceId: string): Promise<Response> {
		if (!this.options.objectStore) return json({ error: "excalidraw_share_resources_unavailable" }, 503);
		const expectedHash = request.headers.get("x-yaos-content-sha256");
		if (!isExcalidrawDigest(expectedHash)) return json({ error: "invalid_excalidraw_share_resource" }, 400);
		const bytes = new Uint8Array(await request.arrayBuffer());
		const mime = request.headers.get("content-type") ?? "application/octet-stream";
		if (!validPublicRaster(bytes, mime)) return json({ error: "invalid_excalidraw_share_resource_media" }, 415);
		const candidate: ExcalidrawPublicResource = { publicResourceId, sourceResourceId: publicResourceId,
			contentHash: expectedHash, size: bytes.byteLength, mime };
		validateExcalidrawPublicResources([candidate]);
		if (await sha256Hex(bytes) !== expectedHash) return json({ error: "excalidraw_share_resource_hash_mismatch" }, 400);
		if (this.shareResources(grant).some((entry) => entry.publicResourceId === publicResourceId)) {
			return json({ error: "excalidraw_share_resource_id_reused" }, 409);
		}
		this.options.storage.transactionSync(() => {
			const exact = this.requireActiveShare(grant.share_id, grant.grant_revision);
			if (exact.permission !== "read-write") throw new Error("excalidraw_share_read_only");
			const currentSession = this.sql.exec<ShareSessionRow>(`SELECT session_id, share_id, grant_revision, token_hash,
			 display_name, color_seed, expires_at FROM excalidraw_share_sessions WHERE session_id = ?`, session.session_id).toArray()[0];
			if (!currentSession || currentSession.grant_revision !== exact.grant_revision || currentSession.expires_at <= this.now()) {
				throw new Error("excalidraw_share_authority_superseded");
			}
		});
		await this.options.objectStore.createOnly(shareQuarantineKey(vaultId, vaultGeneration, grant.share_id,
			grant.grant_revision, session.session_id, publicResourceId, expectedHash), bytes, { contentType: mime });
		return json({ publicResourceId, contentHash: expectedHash, size: bytes.byteLength, mime,
			state: "validated", attached: false }, 202);
	}

	private async validateShareCreate(input: ExcalidrawShareCreateRequest): Promise<void> {
		if (input.protocolVersion !== EXCALIDRAW_SHARE_PROTOCOL_VERSION || !isExcalidrawIdentity(input.operationId)
			|| !isExcalidrawDigest(input.requestDigest) || !isExcalidrawIdentity(input.shareId)
			|| !isExcalidrawIdentity(input.publicDrawingId) || !isExcalidrawDigest(input.linkSecretHash)
			|| !isExcalidrawSharePermission(input.permission)) throw new TypeError("invalid_excalidraw_share");
		validateExcalidrawShareExpiry(input.expiresAt);
		validateExcalidrawPublicResources(input.resources);
		await this.assertShareDigest(input);
	}

	private async validateShareUpdate(input: ExcalidrawShareUpdateRequest): Promise<void> {
		if (input.protocolVersion !== EXCALIDRAW_SHARE_PROTOCOL_VERSION || !isExcalidrawIdentity(input.operationId)
			|| !isExcalidrawDigest(input.requestDigest) || !isExcalidrawIdentity(input.shareId)
			|| !Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision < 1
			|| !isExcalidrawSharePermission(input.permission)) throw new TypeError("invalid_excalidraw_share");
		validateExcalidrawShareExpiry(input.expiresAt);
		validateExcalidrawPublicResources(input.resources);
		await this.assertShareDigest(input);
	}

	private async validateShareRevoke(input: ExcalidrawShareRevokeRequest): Promise<void> {
		if (input.protocolVersion !== EXCALIDRAW_SHARE_PROTOCOL_VERSION || !isExcalidrawIdentity(input.operationId)
			|| !isExcalidrawDigest(input.requestDigest) || !isExcalidrawIdentity(input.shareId)
			|| !Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision < 1) {
			throw new TypeError("invalid_excalidraw_share");
		}
		await this.assertShareDigest(input);
	}

	private async assertShareDigest(input: { requestDigest: string }): Promise<void> {
		const bytes = new TextEncoder().encode(canonicalExcalidrawShareJson(excalidrawShareDigestInput(input)));
		if (await sha256Hex(bytes) !== input.requestDigest) throw new TypeError("invalid_excalidraw_share_request_digest");
	}

	private share(shareId: string): ShareRow | null {
		return this.sql.exec<ShareRow>(`SELECT share_id, public_drawing_id, link_secret_hash, grant_revision,
		 permission, expires_at, state, resources_json FROM excalidraw_share_grants WHERE share_id = ?`, shareId).toArray()[0] ?? null;
	}

	private requireActiveShare(shareId: string, revision: number): ShareRow {
		const grant = this.share(shareId);
		if (!grant || grant.state !== "active" || grant.expires_at <= this.now()
			|| grant.grant_revision !== revision) throw new Error("excalidraw_share_authority_superseded");
		return grant;
	}

	private shareResources(grant: ShareRow): ExcalidrawPublicResource[] {
		const resources: unknown = JSON.parse(grant.resources_json);
		validateExcalidrawPublicResources(resources);
		return resources;
	}

	private publicGrant(grant: ShareRow): ExcalidrawShareGrantPublic {
		return { protocolVersion: EXCALIDRAW_SHARE_PROTOCOL_VERSION, shareId: grant.share_id,
			publicDrawingId: grant.public_drawing_id, drawingEpoch: this.requireMeta().drawing_epoch,
			grantRevision: grant.grant_revision,
			permission: grant.permission, expiresAt: grant.expires_at, state: grant.state,
			resources: this.shareResources(grant).map(({ sourceResourceId: _sourceResourceId, ...resource }) => resource) };
	}

	private shareReceipt(shareId: string, operationId: string): ReceiptRow | null {
		return this.sql.exec<ReceiptRow>(`SELECT request_digest, receipt_json FROM excalidraw_share_receipts
		 WHERE share_id = ? AND operation_id = ?`, shareId, operationId).toArray()[0] ?? null;
	}

	private shareManagementReplay(operationId: string, requestDigest: string): Response | null {
		const row = this.sql.exec<ReceiptRow>(`SELECT request_digest, receipt_json FROM excalidraw_share_management_receipts
		 WHERE operation_id = ?`, operationId).toArray()[0];
		if (!row) return null;
		return row.request_digest === requestDigest
			? json({ ...(JSON.parse(row.receipt_json) as Record<string, unknown>), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
	}

	private writeShareManagementReceipt(operationId: string, requestDigest: string, receipt: unknown): void {
		this.sql.exec(`INSERT INTO excalidraw_share_management_receipts(operation_id, request_digest, receipt_json, created_at)
		 VALUES (?, ?, ?, ?)`, operationId, requestDigest, canonicalExcalidrawShareJson(receipt), Date.now()).toArray();
	}

	private async materializeResources(vaultId: string, vaultGeneration: string, shareId: string,
		grantRevision: number, resources: readonly ExcalidrawPublicResource[]): Promise<void> {
		if (resources.length === 0) return;
		if (!this.options.objectStore) throw new Error("excalidraw_share_resources_unavailable");
		for (const resource of resources) {
			const source = await this.options.objectStore.get(blobKey(vaultId, vaultGeneration, resource.contentHash));
			if (!source || source.size !== resource.size || await sha256Hex(source.bytes) !== resource.contentHash) {
				throw new Error("excalidraw_share_resource_source_missing");
			}
			await this.options.objectStore.createOnly(shareResourceKey(vaultId, vaultGeneration, shareId, grantRevision,
				resource.publicResourceId, resource.contentHash), source.bytes, { contentType: resource.mime });
		}
	}

	private canonicalizePublicElements(elements: readonly ExcalidrawElementRecord[], grant: ShareRow): ExcalidrawElementRecord[] {
		const reverse = new Map(this.shareResources(grant).map((entry) => [entry.publicResourceId, entry.sourceResourceId]));
		return elements.map((element) => {
			assertPublicElementInput(element);
			const current = this.element(element.id);
			if (current && current.type !== element.type) throw new Error("excalidraw_share_element_type_changed");
			const publicFields = copyPublicElementFields(element);
			const result = current
				? JSON.parse(canonicalExcalidrawJson(current)) as ExcalidrawElementRecord
				: {} as ExcalidrawElementRecord;
			for (const field of PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1) delete result[field];
			Object.assign(result, publicFields);
			if (typeof result.fileId === "string") {
				const source = reverse.get(result.fileId);
				if (!source) throw new Error("excalidraw_share_resource_not_published");
				result.fileId = source;
			}
			return result;
		});
	}

	private projectElement(element: ExcalidrawElementRecord, grant: ShareRow): ExcalidrawElementRecord {
		const mapping = new Map(this.shareResources(grant).map((entry) => [entry.sourceResourceId, entry.publicResourceId]));
		const result = copyPublicElementFields(element);
		if (typeof result.fileId === "string") result.fileId = mapping.get(result.fileId) ?? null;
		return result;
	}

	private projectMetadata(metadata: ExcalidrawSceneMetadata, grant: ShareRow): ExcalidrawSceneMetadata {
		const appState = metadata.appState;
		const safeAppState = appState ? Object.fromEntries(["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled"]
			.filter((key) => Object.prototype.hasOwnProperty.call(appState, key)).map((key) => [key, appState[key]])) : undefined;
		return { ...(safeAppState && Object.keys(safeAppState).length > 0 ? { appState: safeAppState } : {}),
			resourceManifest: { version: 1, entries: this.shareResources(grant).map((entry) => ({ kind: "embedded" as const,
				resourceId: entry.publicResourceId, contentHash: entry.contentHash, size: entry.size, mime: entry.mime, created: 0 })) } };
	}

	private projectEvent(event: ExcalidrawRoomEvent, grant: ShareRow): ExcalidrawRoomEvent {
		return { ...event, elements: event.elements.map((element) => this.projectElement(element, grant)),
			...(event.metadata ? { metadata: this.projectMetadata(event.metadata, grant) } : {}) };
	}

	private projectSnapshot(snapshot: ExcalidrawSnapshot, grant: ShareRow): ExcalidrawSnapshot {
		return { ...snapshot, drawingId: grant.public_drawing_id,
			elements: snapshot.elements.map((element) => this.projectElement(element, grant)),
			metadata: this.projectMetadata(snapshot.metadata, grant) };
	}

	private async reserveShareMutation(vaultId: string, vaultGeneration: string, drawingId: string,
		grant: ShareRow, session: ShareSessionRow, request: ExcalidrawBatchRequest): Promise<string> {
		const response = await this.options.vaults.call(vaultId, new Request("https://internal/__yaos/excalidraw/share-reserve", {
			method: "POST", headers: { "content-type": "application/json", "x-yaos-vault-id": vaultId,
				"x-yaos-vault-generation": vaultGeneration }, body: canonicalExcalidrawShareJson({
					drawingId, drawingEpoch: request.drawingEpoch, shareId: grant.share_id,
					grantRevision: grant.grant_revision, sessionId: session.session_id,
					operationId: request.operationId, requestDigest: request.requestDigest,
				}) }));
		const body: { error?: unknown; permitId?: unknown } = await response.json<{ error?: unknown; permitId?: unknown }>()
			.catch(() => ({}));
		if (!response.ok || typeof body.permitId !== "string") throw new Error(typeof body.error === "string"
			? body.error : "excalidraw_authority_unavailable");
		return body.permitId;
	}

	private closeShareSockets(shareId: string, reason: string): void {
		for (const socket of this.options.sockets.sockets()) {
			const attachment = socket.deserializeAttachment() as RoomSocketAttachment | null;
			if (attachment?.authorityKind !== "share" || attachment.shareId !== shareId) continue;
			this.presence.remove(socket, "fenced");
			try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, reason); } catch { /* closed */ }
		}
	}

	private async validateInitialize(request: ExcalidrawInitializeRequest): Promise<void> {
		if (request.protocolVersion !== EXCALIDRAW_PROTOCOL_VERSION || !isExcalidrawIdentity(request.operationId)
			|| !isExcalidrawDigest(request.requestDigest) || !isExcalidrawIdentity(request.prepareOperationId)
			|| request.drawingEpoch !== 1) throw new TypeError("invalid_excalidraw_initialize");
		validateExcalidrawElements(request.elements, MAX_EXCALIDRAW_SCENE_ELEMENTS, true);
		validateExcalidrawMetadata(request.metadata);
		await this.assertDigest(request);
	}

	private async validateBatch(request: ExcalidrawBatchRequest): Promise<void> {
		if (request.protocolVersion !== EXCALIDRAW_PROTOCOL_VERSION || !isExcalidrawIdentity(request.operationId)
			|| !isExcalidrawDigest(request.requestDigest) || !isExcalidrawEpoch(request.drawingEpoch)) {
			throw new TypeError("invalid_excalidraw_batch");
		}
		validateExcalidrawElements(request.elements, undefined, request.metadata !== undefined);
		if (request.metadata !== undefined) validateExcalidrawMetadata(request.metadata);
		await this.assertDigest(request);
	}

	private async validateReset(request: ExcalidrawResetRequest): Promise<void> {
		if (request.protocolVersion !== EXCALIDRAW_PROTOCOL_VERSION || !isExcalidrawIdentity(request.operationId)
			|| !isExcalidrawDigest(request.requestDigest) || !isExcalidrawEpoch(request.previousDrawingEpoch)
			|| !isExcalidrawEpoch(request.drawingEpoch)) throw new TypeError("invalid_excalidraw_reset");
		validateExcalidrawElements(request.elements, MAX_EXCALIDRAW_SCENE_ELEMENTS, true);
		validateExcalidrawMetadata(request.metadata);
		await this.assertDigest(request);
	}

	private async assertDigest(request: { requestDigest: string }): Promise<void> {
		const bytes = new TextEncoder().encode(canonicalExcalidrawJson(excalidrawRequestDigestInput(request)));
		if (await sha256Hex(bytes) !== request.requestDigest) throw new TypeError("invalid_excalidraw_request_digest");
	}

	private async reserve(
		actor: VaultActorContext,
		drawingId: string,
		reservation: ExcalidrawAuthorityReservationRequest,
	): Promise<ExcalidrawAuthorityPermit> {
		const headers = actorHeaders(actor);
		headers.set("content-type", "application/json");
		headers.set("x-yaos-vault-id", actor.vaultId);
		headers.set("x-yaos-vault-generation", actor.vaultGeneration);
		const response = await this.options.vaults.call(actor.vaultId, new Request("https://internal/__yaos/excalidraw/reserve", {
			method: "POST", headers, body: canonicalExcalidrawJson(reservation),
		}));
		const body = await response.json<Record<string, unknown>>();
		if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "excalidraw_authority_unavailable");
		if (body.drawingId !== drawingId) throw new Error("excalidraw_authority_mismatch");
		return body as unknown as ExcalidrawAuthorityPermit;
	}

	private async authorizeRead(actor: VaultActorContext, drawingId: string): Promise<void> {
		const headers = actorHeaders(actor);
		headers.set("x-yaos-vault-id", actor.vaultId);
		headers.set("x-yaos-vault-generation", actor.vaultGeneration);
		const url = new URL("https://internal/__yaos/excalidraw/read");
		url.searchParams.set("drawingId", drawingId);
		const response = await this.options.vaults.call(actor.vaultId, new Request(url, { headers }));
		if (!response.ok) {
			const body: { error?: unknown } = await response.json<{ error?: unknown }>().catch(() => ({}));
			throw new Error(typeof body.error === "string" ? body.error : "excalidraw_authority_unavailable");
		}
	}

	private makeReceipt(
		request: { operationId: string; requestDigest: string; drawingEpoch: number },
		drawingId: string,
		sequence: number,
		acceptedElementIds: string[],
		staleElementIds: string[],
		metadataAccepted: boolean,
		replayed: boolean,
	): ExcalidrawBatchReceipt {
		return { protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: request.operationId,
			requestDigest: request.requestDigest, drawingId, drawingEpoch: request.drawingEpoch, sequence,
			acceptedElementIds, staleElementIds, metadataAccepted, replayed };
	}

	private replayReceipt(operationId: string, requestDigest: string, fallback: string): Response {
		const prior = this.receipt(operationId);
		if (!prior) return json({ error: fallback }, 409);
		return prior.request_digest === requestDigest
			? json({ ...(JSON.parse(prior.receipt_json) as ExcalidrawBatchReceipt), replayed: true })
			: json({ error: "excalidraw_operation_id_reused" }, 409);
	}

	private receipt(operationId: string): ReceiptRow | null {
		return this.sql.exec<ReceiptRow>(
			"SELECT request_digest, receipt_json FROM excalidraw_room_receipts WHERE operation_id = ?",
			operationId,
		).toArray()[0] ?? null;
	}

	private writeReceipt(receipt: ExcalidrawBatchReceipt, permitId: string): void {
		this.sql.exec(`INSERT INTO excalidraw_room_receipts(
		 operation_id, request_digest, permit_id, receipt_json, created_at
		) VALUES (?, ?, ?, ?, ?)`, receipt.operationId, receipt.requestDigest, permitId,
		canonicalExcalidrawJson(receipt), Date.now()).toArray();
	}

	private element(elementId: string): ExcalidrawElementRecord | null {
		const row = this.sql.exec<ElementRow>(
			"SELECT element_json FROM excalidraw_room_elements WHERE element_id = ?", elementId,
		).toArray()[0];
		return row ? JSON.parse(row.element_json) as ExcalidrawElementRecord : null;
	}

	private writeElement(element: ExcalidrawElementRecord, sequence: number): void {
		this.sql.exec(`INSERT INTO excalidraw_room_elements(
		 element_id, version, version_nonce, is_deleted, element_index, element_json, sequence
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(element_id) DO UPDATE SET version=excluded.version, version_nonce=excluded.version_nonce,
		 is_deleted=excluded.is_deleted, element_index=excluded.element_index,
		 element_json=excluded.element_json, sequence=excluded.sequence`, element.id, element.version,
		element.versionNonce, element.isDeleted ? 1 : 0, typeof element.index === "string" ? element.index : "",
		canonicalExcalidrawJson(element), sequence).toArray();
	}

	private validateDependencyClosure(elements: ReadonlyMap<string, ExcalidrawElementRecord>): void {
		let activeCount = 0;
		const requireActive = (owner: ExcalidrawElementRecord, targetId: unknown): ExcalidrawElementRecord | null => {
			if (typeof targetId !== "string") return null;
			const target = elements.get(targetId);
			if (!target || target.isDeleted) throw new Error(`excalidraw_invalid_dependency_closure:${owner.id}`);
			return target;
		};
		const boundEntries = (element: ExcalidrawElementRecord): Array<{ id: string; type: string }> => {
			if (element.boundElements == null) return [];
			if (!Array.isArray(element.boundElements)) throw new Error(`excalidraw_invalid_dependency_closure:${element.id}`);
			return element.boundElements.map((entry) => {
				if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string"
					|| typeof (entry as { type?: unknown }).type !== "string") {
					throw new Error(`excalidraw_invalid_dependency_closure:${element.id}`);
				}
				return entry as { id: string; type: string };
			});
		};
		for (const element of elements.values()) {
			if (element.isDeleted) continue;
			activeCount++;
			const container = requireActive(element, element.containerId);
			if (container && !boundEntries(container).some((entry) => entry.id === element.id && entry.type === "text")) {
				throw new Error(`excalidraw_invalid_dependency_closure:${element.id}`);
			}
			requireActive(element, element.frameId);
			for (const key of ["startBinding", "endBinding"] as const) {
				const binding = element[key];
				if (binding && typeof binding === "object") {
					const target = requireActive(element, (binding as { elementId?: unknown }).elementId);
					if (target && !boundEntries(target).some((entry) => entry.id === element.id && entry.type === "arrow")) {
						throw new Error(`excalidraw_invalid_dependency_closure:${element.id}`);
					}
				}
			}
			for (const entry of boundEntries(element)) {
				const bound = requireActive(element, entry.id)!;
				const reciprocal = entry.type === "text"
					? bound.containerId === element.id
					: entry.type === "arrow" && [bound.startBinding, bound.endBinding].some((binding) =>
						binding && typeof binding === "object"
						&& (binding as { elementId?: unknown }).elementId === element.id);
				if (!reciprocal) throw new Error(`excalidraw_invalid_dependency_closure:${element.id}`);
			}
		}
		if (activeCount > MAX_EXCALIDRAW_ACTIVE_ELEMENTS) throw new Error("excalidraw_scene_too_large");
	}

	private meta(): RoomMetaRow | null {
		return this.sql.exec<RoomMetaRow>(`SELECT vault_id, vault_generation, drawing_id, drawing_epoch,
		 sequence, compacted_through, metadata_json FROM excalidraw_room_meta WHERE id = 1`).toArray()[0] ?? null;
	}

	private requireMeta(): RoomMetaRow {
		const meta = this.meta();
		if (!meta) throw new Error("excalidraw_room_not_initialized");
		return meta;
	}

	private requireActiveMeta(drawingId: string, actor: VaultActorContext, drawingEpoch: number): RoomMetaRow {
		const meta = this.requireMeta();
		if (meta.vault_id !== actor.vaultId || meta.vault_generation !== actor.vaultGeneration
			|| meta.drawing_id !== drawingId || meta.drawing_epoch !== drawingEpoch) {
			throw new Error("excalidraw_authority_superseded");
		}
		return meta;
	}

	private maybeCompact(): void {
		const count = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM excalidraw_room_events").one().count;
		if (count > MAX_ROOM_EVENTS_BEFORE_COMPACTION) this.compact();
	}

	private socketIsAuthoritative(attachment: RoomSocketAttachment): boolean {
		const meta = this.meta();
		if (!meta || !socketAuthorityMatches(attachment, meta)) return false;
		if (attachment.authorityKind !== "share") return true;
		if (!attachment.shareId || !attachment.grantRevision) return false;
		const grant = this.share(attachment.shareId);
		const session = this.sql.exec<ShareSessionRow>(`SELECT session_id, share_id, grant_revision, token_hash,
		 display_name, color_seed, expires_at FROM excalidraw_share_sessions WHERE session_id = ?`, attachment.sessionId).toArray()[0];
		return Boolean(grant && session && grant.state === "active" && grant.expires_at > this.now()
			&& grant.grant_revision === attachment.grantRevision && session.grant_revision === grant.grant_revision
			&& session.expires_at > this.now());
	}

	private now(): number { return this.options.now?.() ?? Date.now(); }

	private async rescheduleShareExpiryAlarm(): Promise<void> {
		if (!this.options.alarms) return;
		const now = this.now();
		const next = this.sql.exec<ShareExpiryRow>(`SELECT MIN(expires_at) AS expires_at FROM (
			SELECT expires_at FROM excalidraw_share_grants WHERE state = 'active' AND expires_at > ?
			UNION ALL SELECT expires_at FROM excalidraw_share_sessions WHERE expires_at > ?
		)`, now, now).one().expires_at;
		if (typeof next === "number") await this.options.alarms.setAlarm(next);
		else await this.options.alarms.deleteAlarm();
	}

	private broadcastDurableEvent(event: ExcalidrawRoomEvent): void {
		for (const socket of this.presence.authoritativeSockets()) {
			const attachment = socket.deserializeAttachment() as RoomSocketAttachment | null;
			if (attachment?.authorityKind === "share" && attachment.shareId) {
				const grant = this.share(attachment.shareId);
				if (!grant) continue;
				this.safeSendDurable(socket, canonicalExcalidrawJson({ type: "scene", event: this.projectEvent(event, grant),
					publicDrawingId: grant.public_drawing_id, grantRevision: grant.grant_revision }));
			} else this.safeSendDurable(socket, canonicalExcalidrawJson({ type: "scene", event }));
		}
	}

	private safeSendDurable(socket: ExcalidrawRoomSocketPort, frame: string): void {
		if ((socket.bufferedAmount ?? 0) > MAX_SCENE_SOCKET_BUFFER_BYTES) {
			try { socket.close(1013, "scene delivery backpressure"); } catch { /* closed */ }
			return;
		}
		try { socket.send(frame); } catch { try { socket.close(1011, "delivery failed"); } catch { /* closed */ } }
	}

	private closeSockets(reason: string): void {
		for (const socket of this.options.sockets.sockets()) {
			this.presence.remove(socket, "reset");
			try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, reason); } catch { /* already closed */ }
		}
	}

	private initializeSchema(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS excalidraw_room_meta (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				vault_id TEXT NOT NULL,
				vault_generation TEXT NOT NULL,
				drawing_id TEXT NOT NULL,
				drawing_epoch INTEGER NOT NULL CHECK(drawing_epoch >= 1),
				sequence INTEGER NOT NULL CHECK(sequence >= 0),
				compacted_through INTEGER NOT NULL CHECK(compacted_through >= 0),
				metadata_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS excalidraw_room_elements (
				element_id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				version_nonce INTEGER NOT NULL,
				is_deleted INTEGER NOT NULL,
				element_index TEXT NOT NULL,
				element_json TEXT NOT NULL,
				sequence INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS excalidraw_room_receipts (
				operation_id TEXT PRIMARY KEY,
				request_digest TEXT NOT NULL,
				permit_id TEXT NOT NULL,
				receipt_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS excalidraw_room_events (
				sequence INTEGER PRIMARY KEY,
				operation_id TEXT NOT NULL UNIQUE,
				event_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS excalidraw_share_grants (
				share_id TEXT PRIMARY KEY,
				public_drawing_id TEXT NOT NULL UNIQUE,
				link_secret_hash TEXT NOT NULL,
				grant_revision INTEGER NOT NULL CHECK(grant_revision >= 1),
				permission TEXT NOT NULL CHECK(permission IN ('read-only', 'read-write')),
				expires_at INTEGER NOT NULL,
				state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
				resources_json TEXT NOT NULL,
				created_by_principal_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS excalidraw_share_sessions (
				session_id TEXT PRIMARY KEY,
				share_id TEXT NOT NULL,
				grant_revision INTEGER NOT NULL,
				token_hash TEXT NOT NULL,
				display_name TEXT NOT NULL,
				color_seed TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS excalidraw_share_sessions_share ON excalidraw_share_sessions(share_id);
			CREATE TABLE IF NOT EXISTS excalidraw_share_receipts (
				share_id TEXT NOT NULL,
				operation_id TEXT NOT NULL,
				request_digest TEXT NOT NULL,
				permit_id TEXT NOT NULL,
				receipt_json TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY(share_id, operation_id)
			);
			CREATE TABLE IF NOT EXISTS excalidraw_share_management_receipts (
				operation_id TEXT PRIMARY KEY,
				request_digest TEXT NOT NULL,
				receipt_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
		`);
	}
}

function socketAuthorityMatches(attachment: RoomSocketAttachment, meta: RoomMetaRow): boolean {
	return attachment.vaultId === meta.vault_id && attachment.vaultGeneration === meta.vault_generation
		&& attachment.drawingId === meta.drawing_id && attachment.drawingEpoch === meta.drawing_epoch;
}

function validPublicDisplayName(value: string): boolean {
	if (value.length < 1 || value.length > 80) return false;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

function constantTimeText(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let mismatch = 0;
	for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return mismatch === 0;
}

function opaquePresenceId(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

function publicPresenceParticipantId(shareId: string | undefined, sessionId: string): string {
	return `participant_${opaquePresenceId(`${shareId ?? "share"}:${sessionId}`)}`;
}

const PUBLIC_ELEMENT_FIELD_SET = new Set<string>(PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1);
const PUBLIC_ELEMENT_TYPE_SET = new Set<string>(PUBLIC_EXCALIDRAW_ELEMENT_TYPES_V1);

function assertPublicElementInput(element: ExcalidrawElementRecord): void {
	if (typeof element.type !== "string" || !PUBLIC_ELEMENT_TYPE_SET.has(element.type)) {
		throw new TypeError("invalid_excalidraw_share_element_type");
	}
	for (const field of Object.keys(element)) {
		if (!PUBLIC_ELEMENT_FIELD_SET.has(field)) throw new TypeError("invalid_excalidraw_share_element_field");
	}
}

function copyPublicElementFields(element: ExcalidrawElementRecord): ExcalidrawElementRecord {
	if (typeof element.type !== "string" || !PUBLIC_ELEMENT_TYPE_SET.has(element.type)) {
		throw new Error("excalidraw_public_projection_unsupported_element");
	}
	const result: Record<string, unknown> = {};
	for (const field of PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1) {
		if (!Object.prototype.hasOwnProperty.call(element, field)) continue;
		const value = element[field];
		result[field] = value;
	}
	return JSON.parse(canonicalExcalidrawJson(result)) as ExcalidrawElementRecord;
}

function validPublicRaster(bytes: Uint8Array, mime: string): boolean {
	if (mime === "image/png") return bytes.length >= 8
		&& bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
		&& bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
	if (mime === "image/jpeg") return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
		&& bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
	if (mime === "image/webp") return bytes.length >= 12
		&& new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
		&& new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
	return false;
}

function shareResourceKey(vaultId: string, vaultGeneration: string, shareId: string, grantRevision: number,
	publicResourceId: string, hash: string): string {
	return `vault/${encodeURIComponent(vaultId)}/${encodeURIComponent(vaultGeneration)}/excalidraw-shares/`+
		`${encodeURIComponent(shareId)}/${grantRevision}/${encodeURIComponent(publicResourceId)}/${hash}`;
}

function shareQuarantineKey(vaultId: string, vaultGeneration: string, shareId: string, grantRevision: number,
	sessionId: string, publicResourceId: string, hash: string): string {
	return `vault/${encodeURIComponent(vaultId)}/${encodeURIComponent(vaultGeneration)}/excalidraw-shares/`+
		`${encodeURIComponent(shareId)}/${grantRevision}/quarantine/${encodeURIComponent(sessionId)}/`+
		`${encodeURIComponent(publicResourceId)}/${hash}`;
}

function isPingFrame(value: unknown): value is { type: "ping"; nonce: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const input = value as { type?: unknown; nonce?: unknown };
	return input.type === "ping" && typeof input.nonce === "string" && isExcalidrawIdentity(input.nonce);
}

function mergeSceneMetadata(current: ExcalidrawSceneMetadata,
	incoming: ExcalidrawSceneMetadata): ExcalidrawSceneMetadata {
	const resources = new Map(current.resourceManifest.entries.map((entry) => [entry.resourceId, entry] as const));
	for (const entry of incoming.resourceManifest.entries) {
		const existing = resources.get(entry.resourceId);
		if (existing && canonicalExcalidrawJson(existing) !== canonicalExcalidrawJson(entry)) {
			throw new Error("excalidraw_resource_id_equivocation");
		}
		resources.set(entry.resourceId, entry);
	}
	const merged: ExcalidrawSceneMetadata = {
		resourceManifest: { version: 1, entries: [...resources.values()].sort((left, right) =>
			left.resourceId === right.resourceId ? 0 : left.resourceId < right.resourceId ? -1 : 1) },
		...(incoming.appState === undefined ? current.appState === undefined ? {} : { appState: current.appState }
			: { appState: incoming.appState }),
		...(incoming.plugin === undefined ? current.plugin === undefined ? {} : { plugin: current.plugin }
			: { plugin: incoming.plugin }),
	};
	validateExcalidrawMetadata(merged);
	return merged;
}

class CloudflareExcalidrawSocketRegistry implements ExcalidrawRoomSocketRegistryPort {
	constructor(private readonly state: DurableObjectState) {}
	sockets(): readonly ExcalidrawRoomSocketPort[] { return this.state.getWebSockets(); }
	createPair(): { client: unknown; server: ExcalidrawRoomSocketPort } {
		const pair = new WebSocketPair();
		return { client: pair[0], server: pair[1] };
	}
	accept(socket: ExcalidrawRoomSocketPort): void { this.state.acceptWebSocket(socket as WebSocket); }
	upgradeResponse(client: unknown): Response { return new Response(null, { status: 101, webSocket: client as WebSocket }); }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- Workers RPC requires the exported class type to carry its brand.
export interface ExcalidrawRoomDO extends Rpc.DurableObjectBranded {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- Declaration merging preserves the Workers RPC brand on the Cloudflare wrapper.
export class ExcalidrawRoomDO implements DurableObject {
	private readonly runtime: ExcalidrawRoomRuntime;

	constructor(state: DurableObjectState, env: CloudflareExcalidrawRoomEnvironment) {
		this.runtime = new ExcalidrawRoomRuntime({
			storage: state.storage as ExcalidrawRoomStoragePort,
			sockets: new CloudflareExcalidrawSocketRegistry(state),
			vaults: { call: (name, request) => env.YAOS_SYNC.get(env.YAOS_SYNC.idFromName(name)).fetch(request) },
			objectStore: env.YAOS_BUCKET ? new CloudflareObjectStore(env.YAOS_BUCKET) : undefined,
			alarms: {
				setAlarm: (scheduledTime) => state.storage.setAlarm(scheduledTime),
				deleteAlarm: () => state.storage.deleteAlarm(),
			},
		});
	}

	fetch(request: Request): Promise<Response> { return this.runtime.fetch(request); }
	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		return this.runtime.webSocketMessage(socket, message);
	}
	webSocketClose(socket: WebSocket): void { this.runtime.webSocketClose(socket); }
	webSocketError(socket: WebSocket): void { this.runtime.webSocketError(socket); }
	alarm(): Promise<void> { return this.runtime.alarm(); }
}
