import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { modifyAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { MAX_AWARENESS_BYTES, MAX_BODY_SOCKETS, MAX_CANDIDATE_BYTES, MAX_ROOT_SOCKETS } from "./contracts";
import { sha256Hex } from "./hex";
import {
	VaultDocumentCachePressureError,
	VaultDocumentValidationError,
	type LoadedVaultDocument,
	type VaultDocumentCache,
} from "./vaultDocumentCache";
import { safeBlobPath, safeCanvasPath } from "./shared/vaultPath";
import type { SemanticPathRef } from "./shared/canvasTypes";
import { isSupportedExcalidrawPath } from "./shared/excalidrawProtocol";
import { isCanonicalVaultId } from "./vaultId";
import {
	SOCKET_CONTROL_CAPABILITIES,
	SOCKET_LIVENESS_DESCRIPTOR,
	parseBodyCurrentnessQueryFrame,
	parseVaultPingFrame,
	type BodyCurrentnessHead,
} from "./shared/socketLiveness";
import { validateFrontmatterSemanticRoots } from "./shared/frontmatterSemanticValidation";
import { canonicalMarkdownBytes } from "./shared/markdownCodec";
import { MAX_CLIENT_MARKDOWN_BYTES } from "./shared/durableLimits";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "./shared/socketCloseCodes";
import type { VaultActorContext } from "./collaboration";
import type { SemanticCatalogHead } from "./vaultStore";
import {
	SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE,
	SemanticEpochMismatchError,
	parseSemanticEpoch,
	type SemanticEpoch,
} from "./shared/semanticEpoch";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MAX_IDENTITY_LENGTH = 256;

export interface VaultSocketAttachment {
	vaultId: string;
	vaultGeneration: string;
	runtimeEpoch: string;
	documentId: string;
	kind: "root" | "body" | "semantic";
	documentEpoch: SemanticEpoch;
	deviceId: string;
	deviceName?: string;
	principalId: string;
	membershipRevision: number;
	deviceCredentialRevision: number;
	role: "owner" | "member";
	policyVersion: number;
	capabilityDigest: string;
	awarenessClientId?: number;
	socketId: string;
}
export interface VaultSocketPort {
	close(code?: number, reason?: string): void;
	deserializeAttachment(): unknown;
	serializeAttachment(value: unknown): void;
	send(message: ArrayBuffer | ArrayBufferView | string): void;
}

export interface VaultSocketRegistryPort {
	sockets(): readonly VaultSocketPort[];
	createPair(): { client: unknown; server: VaultSocketPort };
	accept(socket: VaultSocketPort): void;
	upgradeResponse(client: unknown): Response;
}

function validIdentity(value: string): boolean {
	if (value.length === 0 || value.length > MAX_IDENTITY_LENGTH) return false;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

function presenceColors(seed: string): { color: string; colorLight: string } {
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index++) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const hue = hash % 360;
	return { color: `hsl(${hue}, 72%, 52%)`, colorLight: `hsla(${hue}, 72%, 52%, 0.2)` };
}

export function parseVaultSocketAttachment(value: unknown): VaultSocketAttachment | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const attachment = value as Partial<VaultSocketAttachment>;
	if (!isCanonicalVaultId(attachment.vaultId) || !isCanonicalVaultId(attachment.vaultGeneration)
		|| typeof attachment.runtimeEpoch !== "string" || !validIdentity(attachment.runtimeEpoch)
		|| typeof attachment.deviceId !== "string" || !validIdentity(attachment.deviceId)
		|| (attachment.deviceName !== undefined && (typeof attachment.deviceName !== "string" || !validIdentity(attachment.deviceName)))
		|| typeof attachment.principalId !== "string" || !validIdentity(attachment.principalId)
		|| typeof attachment.membershipRevision !== "number" || !Number.isSafeInteger(attachment.membershipRevision) || attachment.membershipRevision < 1
		|| typeof attachment.deviceCredentialRevision !== "number" || !Number.isSafeInteger(attachment.deviceCredentialRevision) || attachment.deviceCredentialRevision < 1
		|| (attachment.role !== "owner" && attachment.role !== "member")
		|| typeof attachment.policyVersion !== "number" || !Number.isSafeInteger(attachment.policyVersion) || attachment.policyVersion < 1
		|| typeof attachment.capabilityDigest !== "string" || !validIdentity(attachment.capabilityDigest)
		|| (attachment.awarenessClientId !== undefined && (!Number.isSafeInteger(attachment.awarenessClientId)
			|| attachment.awarenessClientId < 0))
		|| typeof attachment.socketId !== "string" || !validIdentity(attachment.socketId)
		|| (attachment.kind !== "root" && attachment.kind !== "body" && attachment.kind !== "semantic")
		|| typeof attachment.documentId !== "string"
		|| typeof attachment.documentEpoch !== "number"
		|| !Number.isSafeInteger(attachment.documentEpoch) || attachment.documentEpoch < 1) return null;
	if (attachment.kind === "root" && attachment.documentId !== "root") return null;
	if (attachment.kind === "body" && attachment.documentId === "root") return null;
	if (attachment.kind === "semantic" && attachment.documentId === "root") return null;
	return attachment as VaultSocketAttachment;
}

function protectedAttachmentState(doc: Y.Doc): string {
	const sorted = (map: Y.Map<unknown>): Record<string, unknown> =>
		Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
	return JSON.stringify({
		pathToBlob: sorted(doc.getMap("pathToBlob")),
		pathToSemantic: sorted(doc.getMap("pathToSemantic")),
		blobMeta: sorted(doc.getMap("blobMeta")),
		blobTombstones: sorted(doc.getMap("blobTombstones")),
	});
}

export function rootUpdateChangesProtectedAttachmentMaps(current: Y.Doc, update: Uint8Array): boolean {
	const candidate = new Y.Doc({ guid: "root-protected-map-validation" });
	try {
		Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current));
		const before = protectedAttachmentState(candidate);
		Y.applyUpdate(candidate, update);
		return protectedAttachmentState(candidate) !== before;
	} catch {
		return true;
	} finally {
		candidate.destroy();
	}
}

export function hasSafeRootAttachmentSemantics(doc: Y.Doc): boolean {
	const refs = doc.getMap<unknown>("pathToBlob");
	const markdown = doc.getMap<unknown>("pathToId");
	const semantic = doc.getMap<unknown>("pathToSemantic");
	const tombstones = doc.getMap<unknown>("blobTombstones");
	for (const [path, value] of refs.entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)
			|| !("hash" in value) || typeof value.hash !== "string"
			|| !("size" in value) || typeof value.size !== "number"
			|| !("revision" in value) || typeof value.revision !== "string" || !validIdentity(value.revision)
			|| safeBlobPath(path, "", { hash: value.hash, size: value.size }) !== path
			|| tombstones.has(path)) return false;
	}
	for (const [path, value] of tombstones.entries()) {
		if (safeBlobPath(path) !== path || typeof value !== "object" || value === null || Array.isArray(value)
			|| !("deletedAt" in value) || !Number.isSafeInteger(value.deletedAt) || (value.deletedAt as number) < 0
			|| !("revision" in value) || typeof value.revision !== "string" || !validIdentity(value.revision)
			|| !("previousHash" in value) || (value.previousHash !== null
				&& (typeof value.previousHash !== "string" || !/^[a-f0-9]{64}$/.test(value.previousHash)))) return false;
	}
	for (const [hash, value] of doc.getMap<unknown>("blobMeta").entries()) {
		if (!/^[a-f0-9]{64}$/.test(hash) || typeof value !== "object" || value === null || Array.isArray(value)
			|| !("size" in value) || !Number.isSafeInteger(value.size) || (value.size as number) < 0
			|| !("mime" in value) || typeof value.mime !== "string" || value.mime.length === 0 || value.mime.length > 256
			|| !("createdAt" in value) || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) return false;
	}
	for (const [path, value] of markdown.entries()) {
		if (typeof value !== "string" || !validIdentity(value) || !path.endsWith(".md")
			|| refs.has(path) || semantic.has(path)) return false;
	}
	const semanticIds = new Set<string>();
	for (const [path, value] of semantic.entries()) {
		if (refs.has(path) || markdown.has(path)
			|| typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const ref = value as Partial<SemanticPathRef>;
		const documentId = ref.documentId;
		const validFormat = ref.kind === "canvas"
			? safeCanvasPath(path) === path && ref.format === "json-canvas" && ref.formatVersion === 1
			: ref.kind === "excalidraw" && isSupportedExcalidrawPath(path)
				&& ref.format === "excalidraw-native" && ref.formatVersion === 1;
		if (typeof documentId !== "string" || !validIdentity(documentId) || !validFormat || semanticIds.has(documentId)) return false;
		semanticIds.add(documentId);
	}
	return true;
}

export function rootUpdateHasSafeAttachmentSemantics(current: Y.Doc, update: Uint8Array): boolean {
	const candidate = new Y.Doc({ guid: "root-attachment-validation" });
	try {
		Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current));
		Y.applyUpdate(candidate, update);
		return hasSafeRootAttachmentSemantics(candidate);
	} catch {
		return false;
	} finally {
		candidate.destroy();
	}
}

/** Root sockets are replication outputs. Only durable publication services may mutate the root. */
export function rootUpdateChangesDocument(current: Y.Doc, update: Uint8Array): boolean {
	const candidate = new Y.Doc({ guid: "root-client-update-validation" });
	let changed = false;
	try {
		Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current));
		const observer = (): void => { changed = true; };
		candidate.on("update", observer);
		try {
			Y.applyUpdate(candidate, update, "root-client-update-validation");
		} finally {
			candidate.off("update", observer);
		}
		return changed;
	} catch {
		return true;
	} finally {
		candidate.destroy();
	}
}

/** The Yjs handshake sends a sync-step-2 update even when the peer has no data. */
export function isStructurallyEmptyYjsUpdate(update: Uint8Array): boolean {
	try {
		const decoded = Y.decodeUpdate(update);
		return decoded.structs.length === 0 && decoded.ds.clients.size === 0;
	} catch {
		return false;
	}
}

export function bodyUpdateAdmissionError(current: Y.Doc, update: Uint8Array): string | null {
	const candidate = new Y.Doc({ guid: "body-frontmatter-semantic-validation" });
	try {
		Y.applyUpdate(candidate, Y.encodeStateAsUpdate(current));
		Y.applyUpdate(candidate, update, "body-frontmatter-semantic-validation");
		const semanticError = validateFrontmatterSemanticRoots(candidate);
		if (semanticError) return semanticError;
		return canonicalMarkdownBytes(Y.Text.prototype.toString.call(candidate.getText("body"))).byteLength
			> MAX_CLIENT_MARKDOWN_BYTES ? "markdown_size_limit" : null;
	} catch {
		return "frontmatter_semantic_root_invalid";
	} finally {
		candidate.destroy();
	}
}

export const bodyUpdateFrontmatterSemanticError = bodyUpdateAdmissionError;

export interface SocketServiceOptions {
	sockets: VaultSocketRegistryPort;
	cache: VaultDocumentCache;
	vaultId: () => string;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	isActiveBody: (bodyId: string) => boolean;
	isActiveSemantic?: (documentId: string) => boolean;
	currentSemanticHead?: (documentId: string) => SemanticCatalogHead | null;
	currentRootEpoch: () => SemanticEpoch;
	currentSemanticEpoch?: (documentId: string) => SemanticEpoch | null;
	currentBodyHead: (bodyId: string) => (BodyCurrentnessHead & { sequence: number }) | null;
	currentSequence: () => number;
	validateActor(actor: VaultActorContext): boolean;
	principalPresence(principalId: string): { displayName: string; colorSeed: string } | null;
	scheduleFlush: (documentId: string) => void;
	shouldPauseAdmission?: (documentId: string) => boolean;
}

function cachePressureResponse(reason: "body_cache_count" | "body_cache_encoded_state_bytes" | "vault_transient_bytes"): Response {
	return Response.json(
		{ error: reason },
		{ status: 429, headers: { "Retry-After": "1" } },
	);
}

/** Owns hibernated root/body sockets, attachments, framing, and fan-out. */
export class VaultSocketService {
	constructor(private readonly options: SocketServiceOptions) {}

	openBodyIds(): ReadonlySet<string> {
		const result = new Set<string>();
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "body"
				&& this.options.currentBodyHead(attachment.documentId)?.bodyEpoch === attachment.documentEpoch) {
				result.add(attachment.documentId);
			}
			if (attachment?.kind === "semantic"
				&& this.options.currentSemanticEpoch?.(attachment.documentId) === attachment.documentEpoch) {
				result.add(attachment.documentId);
			}
		}
		return result;
	}

	accept(documentId: string, kind: VaultSocketAttachment["kind"], documentEpoch: SemanticEpoch,
		actorOrDevice: VaultActorContext | string): Response {
		documentEpoch = parseSemanticEpoch(documentEpoch, "socket document epoch");
		const actor: VaultActorContext = typeof actorOrDevice === "string"
			? { vaultId: this.options.vaultId(), vaultGeneration: this.options.vaultGeneration(), principalId: actorOrDevice,
				membershipRevision: 1, deviceId: actorOrDevice, deviceCredentialRevision: 1, role: "member",
				policyVersion: 1, capabilityDigest: "legacy" }
			: actorOrDevice;
		if (!(this.options.validateActor?.(actor) ?? true)) return Response.json({ error: "authority_superseded" }, { status: 409 });
		let rootCount = 0;
		let bodyCount = 0;
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment && this.fenceSocketIfStale(socket, attachment)) continue;
			if (attachment?.kind === "root") rootCount++;
			if (attachment?.kind === "body" || attachment?.kind === "semantic") bodyCount++;
		}
		if (kind === "root" && rootCount >= MAX_ROOT_SOCKETS) return Response.json({ error: "root_socket_limit" }, { status: 429 });
		if (kind !== "root" && bodyCount >= MAX_BODY_SOCKETS) return Response.json({ error: "body_socket_limit" }, { status: 429 });
		if (kind !== "root" && this.options.shouldPauseAdmission?.(documentId)) {
			return Response.json({ error: "semantic_compaction_backpressure" }, {
				status: 429, headers: { "Retry-After": "1" },
			});
		}
		if (kind !== "root" && !this.options.cache.admitBody(documentId)) {
			return cachePressureResponse("body_cache_count");
		}
		let loaded: LoadedVaultDocument;
		try {
			loaded = this.options.cache.load(documentId, kind !== "root", () => kind === "body"
				? this.options.isActiveBody(documentId) : this.options.isActiveSemantic?.(documentId) === true,
				kind === "root" ? "root" : kind === "semantic" ? "canvas" : "body");
		} catch (error) {
			if (kind !== "root" && error instanceof VaultDocumentCachePressureError) {
				if (error.reason === "body_cache_count"
					|| error.reason === "body_cache_encoded_state_bytes"
					|| error.reason === "vault_transient_bytes") {
					return cachePressureResponse(error.reason);
				}
			}
			throw error;
		}
		if (loaded.semanticEpoch !== documentEpoch) {
			const mismatch = kind === "root"
				? new SemanticEpochMismatchError({ purpose: "root", documentId: "root",
					expectedRootEpoch: loaded.semanticEpoch, receivedRootEpoch: documentEpoch })
				: new SemanticEpochMismatchError({ purpose: "body", documentId,
					expectedBodyEpoch: loaded.semanticEpoch, receivedBodyEpoch: documentEpoch });
			return Response.json(mismatch.toPayload(), { status: mismatch.status });
		}
		const pair = this.options.sockets.createPair();
		const client = pair.client;
		const server = pair.server;
		const attachment: VaultSocketAttachment = {
			vaultId: this.options.vaultId(),
			vaultGeneration: this.options.vaultGeneration(),
			runtimeEpoch: this.options.runtimeEpoch,
			documentId,
			kind,
			documentEpoch,
			deviceId: actor.deviceId,
			...(actor.deviceName ? { deviceName: actor.deviceName } : {}),
			principalId: actor.principalId,
			membershipRevision: actor.membershipRevision,
			deviceCredentialRevision: actor.deviceCredentialRevision,
			role: actor.role,
			policyVersion: actor.policyVersion,
			capabilityDigest: actor.capabilityDigest,
			socketId: crypto.randomUUID(),
		};
		server.serializeAttachment(attachment);
		this.options.sockets.accept(server);
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeSyncStep1(encoder, loaded.doc);
		server.send(encoding.toUint8Array(encoder));
		this.sendControl(server, {
			type: "VAULT_READY",
			documentId,
			documentEpoch: attachment.documentEpoch,
			socketSessionId: attachment.socketId,
			vaultGeneration: attachment.vaultGeneration,
			durableGeneration: loaded.generation,
			runtimeEpoch: attachment.runtimeEpoch,
			liveness: SOCKET_LIVENESS_DESCRIPTOR,
			capabilities: SOCKET_CONTROL_CAPABILITIES,
			principalId: actor.principalId,
			deviceId: actor.deviceId,
			role: actor.role,
			membershipRevision: actor.membershipRevision,
			deviceCredentialRevision: actor.deviceCredentialRevision,
			policyVersion: actor.policyVersion,
			capabilityDigest: actor.capabilityDigest,
		});
		return this.options.sockets.upgradeResponse(client);
	}

	async message(socket: VaultSocketPort, message: string | ArrayBuffer): Promise<void> {
		const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
		if (!attachment
			|| attachment.vaultId !== this.options.vaultId()
			|| attachment.vaultGeneration !== this.options.vaultGeneration()
			|| attachment.runtimeEpoch !== this.options.runtimeEpoch) {
			socket.close(1008, "socket authority mismatch");
			return;
		}
		if (!(this.options.validateActor?.(this.actorFromAttachment(attachment)) ?? true)) {
			this.sendControl(socket, { type: "error", code: "authority_superseded", reason: "socket authority superseded" });
			socket.close(1008, "socket authority superseded");
			return;
		}
		if (this.fenceSocketIfStale(socket, attachment)) return;
		if ((attachment.kind === "body" && !this.options.isActiveBody(attachment.documentId))
			|| (attachment.kind === "semantic" && this.options.isActiveSemantic?.(attachment.documentId) !== true)) {
			socket.close(1008, "body is not active");
			return;
		}
		if (typeof message === "string") {
			if (message.length > 64 * 1024) {
				socket.close(1009, "text frame too large");
				return;
			}
			if (!message.startsWith("__YPS:")) return;
			let value: unknown;
			try { value = JSON.parse(message.slice(6)); }
			catch { return; }
			const ping = parseVaultPingFrame(value);
			if (ping) {
				this.sendControl(socket, {
					type: "VAULT_PONG",
					probeId: ping.probeId,
					documentId: attachment.documentId,
					documentEpoch: attachment.documentEpoch,
					vaultGeneration: attachment.vaultGeneration,
					runtimeEpoch: attachment.runtimeEpoch,
				});
				return;
			}
			const query = parseBodyCurrentnessQueryFrame(value);
			if (!query) return;
			if (attachment.kind === "body"
				&& (query.bodyIds.length !== 1 || query.bodyIds[0] !== attachment.documentId)) {
				socket.close(1008, "body currentness query authority mismatch");
				return;
			}
			const heads: BodyCurrentnessHead[] = [];
			const missingBodyIds: string[] = [];
			for (const bodyId of query.bodyIds) {
				const head = this.options.currentBodyHead(bodyId);
				if (head) heads.push({
					bodyId: head.bodyId,
					bodyEpoch: head.bodyEpoch,
					lifecycle: head.lifecycle,
					generation: head.generation,
					contentHash: head.contentHash,
					size: head.size,
				});
				else missingBodyIds.push(bodyId);
			}
			this.sendControl(socket, {
				type: "BODY_CURRENTNESS_RESULT",
				queryId: query.queryId,
				socketSessionId: attachment.socketId,
				vaultSequence: this.options.currentSequence(),
				heads,
				missingBodyIds,
			});
			return;
		}
		try {
			const frame = new Uint8Array(message);
			if (frame.byteLength > MAX_CANDIDATE_BYTES + 64) {
				socket.close(1009, "frame exceeds durable admission limit");
				return;
			}
			const decoder = decoding.createDecoder(frame);
			const type = decoding.readVarUint(decoder);
			if (type === MESSAGE_AWARENESS) {
				if (frame.byteLength > MAX_AWARENESS_BYTES) socket.close(1009, "awareness frame too large");
				else this.relayAwareness(socket, attachment, frame);
				return;
			}
			if (type !== MESSAGE_SYNC) return;
			await this.handleSyncFrame(socket, attachment, decoder);
		} catch (error) {
			this.sendControl(socket, { type: "VAULT_ERROR", message: error instanceof Error ? error.message : String(error) });
		}
	}

	closeBody(bodyId: string): void {
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "body" && attachment.documentId === bodyId) socket.close(1008, "body deleted");
		}
		this.options.cache.evict(bodyId);
	}
	closeSemantic(documentId: string): void {
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "semantic" && attachment.documentId === documentId) {
				socket.close(1008, "semantic document demoted");
			}
		}
		this.options.cache.evict(documentId);
	}

	/** Fences all hibernated/open sockets that still speak the retired CRDT lineage. */
	fenceSemanticEpoch(documentId: string, previousEpoch: SemanticEpoch, currentEpoch: SemanticEpoch): number {
		const receivedEpoch = parseSemanticEpoch(previousEpoch, "previous semantic epoch");
		const expectedEpoch = parseSemanticEpoch(currentEpoch, "current semantic epoch");
		if (receivedEpoch === expectedEpoch) throw new Error("semantic epoch fence requires an advancing epoch");
		let closed = 0;
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (!attachment || attachment.documentId !== documentId || attachment.documentEpoch !== receivedEpoch) continue;
			const mismatch = attachment.kind === "root"
				? new SemanticEpochMismatchError({ purpose: "root", documentId: "root",
					expectedRootEpoch: expectedEpoch, receivedRootEpoch: receivedEpoch })
				: new SemanticEpochMismatchError({ purpose: "body", documentId,
					expectedBodyEpoch: expectedEpoch, receivedBodyEpoch: receivedEpoch });
			this.sendControl(socket, mismatch.toSocketFrame());
			try { socket.close(SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE, "semantic epoch reset"); } catch { /* durable fence remains */ }
			closed++;
		}
		return closed;
	}
	closeDevice(deviceId: string): number {
		let closed = 0;
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.deviceId !== deviceId) continue;
			this.sendControl(socket, { type: "error", code: "authority_superseded", reason: "device authority changed" });
			try {
				socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "device authority changed");
			} catch {
				// The durable revocation fence rejects any later frame.
			}
			closed++;
		}
		return closed;
	}
	closePrincipal(principalId: string): number {
		let closed = 0;
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.principalId !== principalId) continue;
			this.sendControl(socket, { type: "error", code: "authority_superseded", reason: "membership revoked" });
			try { socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "membership revoked"); } catch { /* fenced durably */ }
			closed++;
		}
		return closed;
	}

	closeAll(reason: string): void {
		for (const socket of this.options.sockets.sockets()) {
			try { socket.close(1001, reason); } catch { /* already closed */ }
		}
	}

	notifyBodyCommitted(bodyId: string, durableGeneration: number, vaultSequence: number): void {
		const head = this.options.currentBodyHead(bodyId);
		const bodyEpoch = head?.bodyEpoch ?? this.options.cache.get(bodyId)?.semanticEpoch;
		if (bodyEpoch === undefined) throw new Error(`body ${bodyId} has no semantic epoch for commit notification`);
		const value = {
			type: "BODY_COMMITTED",
			bodyId,
			bodyEpoch,
			vaultGeneration: this.options.vaultGeneration(),
			durableGeneration,
			vaultSequence,
			lifecycle: head?.lifecycle ?? "reaped",
			contentHash: head?.contentHash ?? null,
			size: head?.size ?? null,
			runtimeEpoch: this.options.runtimeEpoch,
		};
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "root"
				|| (attachment?.documentId === bodyId && attachment.documentEpoch === bodyEpoch)) this.sendControl(socket, value);
		}
	}

	notifySemanticCommitted(documentId: string, durableGeneration: number, vaultSequence: number,
		head: { lifecycle: string; contentHash: string | null; size: number | null }): void {
		const bodyEpoch = this.options.currentSemanticEpoch?.(documentId)
			?? this.options.cache.get(documentId)?.semanticEpoch;
		if (bodyEpoch === undefined || bodyEpoch === null) throw new Error(`Canvas ${documentId} has no semantic epoch`);
		const value = { type: "SEMANTIC_COMMITTED", documentId, kind: "canvas", format: "json-canvas",
			bodyEpoch, vaultGeneration: this.options.vaultGeneration(), durableGeneration, vaultSequence,
			lifecycle: head.lifecycle, contentHash: head.contentHash, size: head.size, runtimeEpoch: this.options.runtimeEpoch };
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "root" || attachment?.documentId === documentId) this.sendControl(socket, value);
		}
	}

	broadcastDocumentUpdate(documentId: string, update: Uint8Array, origin: unknown): void {
		this.broadcastDocumentUpdateExcept(documentId, update, (socket) => socket === origin);
	}

	/** Publishes a durably committed socket frame without echoing it to its origin. */
	broadcastCommittedSocketUpdate(documentId: string, update: Uint8Array, originSocketId: string): void {
		this.broadcastDocumentUpdateExcept(documentId, update, (socket) => {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			return attachment?.socketId === originSocketId;
		});
	}

	closeUndurableOrigins(documentId: string, entries: readonly { socketId: string }[]): void {
		const socketIds = new Set(entries.map((entry) => entry.socketId));
		for (const socket of this.options.sockets.sockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.documentId !== documentId || !socketIds.has(attachment.socketId)) continue;
			this.sendControl(socket, { type: "VAULT_ERROR", code: "durability_failed", message: "update was not committed; reconnect to resend" });
			try { socket.close(1011, "durable commit failed"); } catch { /* reconnect is still required */ }
		}
	}

	private broadcastDocumentUpdateExcept(
		documentId: string,
		update: Uint8Array,
		excluded: (socket: VaultSocketPort) => boolean,
	): void {
		// A Durable Object may wake with hibernated sockets before its document
		// cache has been rebuilt.  Publication is already durable at this point,
		// so lack of residency must neither turn the successful mutation into a
		// 500 nor suppress its delta to those sockets.  The durable head is the
		// epoch authority when no resident document is available.
		const documentEpoch = this.options.cache.get(documentId)?.semanticEpoch
			?? (documentId === "root"
				? this.options.currentRootEpoch()
				: this.options.currentSemanticEpoch?.(documentId) ?? null);
		if (documentEpoch === null) return;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeUpdate(encoder, update);
		const frame = encoding.toUint8Array(encoder);
		for (const socket of this.options.sockets.sockets()) {
			if (excluded(socket)) continue;
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.documentId === documentId && attachment.documentEpoch === documentEpoch) {
				try { socket.send(frame); } catch { /* peer closed */ }
			}
		}
	}

	private async handleSyncFrame(socket: VaultSocketPort, attachment: VaultSocketAttachment, decoder: decoding.Decoder): Promise<void> {
		if (attachment.kind !== "root" && this.options.shouldPauseAdmission?.(attachment.documentId)) {
			this.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: "semantic_compaction_backpressure" });
			socket.close(1013, "semantic compaction pressure");
			return;
		}
		const syncType = decoding.readVarUint(decoder);
		if (syncType === 0) {
			const loaded = this.options.cache.load(
				attachment.documentId,
				attachment.kind !== "root",
				() => attachment.kind === "body"
					? this.options.isActiveBody(attachment.documentId)
					: attachment.kind === "semantic" && this.options.isActiveSemantic?.(attachment.documentId) === true,
				attachment.kind === "root" ? "root" : attachment.kind === "semantic" ? "canvas" : "body",
			);
			if (loaded.semanticEpoch !== attachment.documentEpoch) {
				this.fenceSocketIfStale(socket, attachment, loaded.semanticEpoch);
				return;
			}
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, MESSAGE_SYNC);
			syncProtocol.writeSyncStep2(encoder, loaded.doc, decoding.readVarUint8Array(decoder));
			socket.send(encoding.toUint8Array(encoder));
			return;
		}
		if (syncType !== 1 && syncType !== 2) throw new Error(`unsupported sync message ${syncType}`);
		const update = decoding.readVarUint8Array(decoder);
		if (update.byteLength === 0 || update.byteLength > MAX_CANDIDATE_BYTES) {
			socket.close(1009, "sync update exceeds durable value limit");
			return;
		}
		if (attachment.kind === "root") {
			// Root sockets are download-only, but Yjs itself emits a structurally
			// empty sync-step-2 update during every handshake. Inspect its decoded
			// structure without applying or cloning; any structs/deletes are a real
			// client mutation and remain forbidden.
			if (isStructurallyEmptyYjsUpdate(update)) return;
			const root = this.options.cache.load("root", false, () => true, "root");
			if (root.semanticEpoch !== attachment.documentEpoch) {
				this.fenceSocketIfStale(socket, attachment, root.semanticEpoch);
				return;
			}
			if (this.options.cache.validateRootSyncNoop("root", update)) return;
			socket.close(1008, "root updates require durable publication");
			return;
		}
		const owned = update.slice();
		const digest = await sha256Hex(owned);
		await this.options.cache.serializeDocument(attachment.documentId, async () => {
			if (this.options.shouldPauseAdmission?.(attachment.documentId)) {
				this.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: "semantic_compaction_backpressure" });
				socket.close(1013, "semantic compaction pressure");
				return;
			}
			const current = this.options.cache.load(
				attachment.documentId,
				true,
				() => attachment.kind === "body"
					? this.options.isActiveBody(attachment.documentId)
					: this.options.isActiveSemantic?.(attachment.documentId) === true,
				attachment.kind === "semantic" ? "canvas" : "body",
			);
			if (current.semanticEpoch !== attachment.documentEpoch) {
				this.fenceSocketIfStale(socket, attachment, current.semanticEpoch);
				return;
			}
			let validated;
			try {
				validated = attachment.kind === "semantic"
					? await this.options.cache.validateCanvasUpdate(attachment.documentId, owned)
					: this.options.cache.validateBodyUpdate(attachment.documentId, owned);
			} catch (error) {
				if (error instanceof VaultDocumentValidationError) {
					const message = attachment.kind === "semantic" ? "invalid semantic Canvas update" : "invalid body update";
					this.sendControl(socket, { type: "VAULT_ERROR", code: error.reason, message });
					socket.close(1008, message);
					return;
				}
				if (error instanceof VaultDocumentCachePressureError) {
					this.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: error.reason });
					socket.close(1013, "body cache budget exceeded");
					return;
				}
				throw error;
			}
			const contentHash = await sha256Hex(validated.contentBytes);
			const actor = this.actorFromAttachment(attachment);
			if (!(this.options.validateActor?.(actor) ?? true)) {
				this.options.cache.discardValidatedBodyUpdate(attachment.documentId);
				this.sendControl(socket, { type: "error", code: "authority_superseded", reason: "socket authority superseded" });
				socket.close(AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, "socket authority superseded");
				return;
			}
			if (this.fenceSocketIfStale(socket, attachment)) {
				this.options.cache.discardValidatedBodyUpdate(attachment.documentId);
				return;
			}
			let semanticHead: SemanticCatalogHead | undefined;
			if (attachment.kind === "semantic") {
				const current = this.options.currentSemanticHead?.(attachment.documentId);
				if ((this.options.currentSemanticHead && (!current || current.lifecycle !== "active"))
					|| (!this.options.currentSemanticHead && this.options.isActiveSemantic?.(attachment.documentId) !== true)) {
					this.options.cache.discardValidatedBodyUpdate(attachment.documentId);
					this.sendControl(socket, { type: "VAULT_ERROR", code: "semantic_document_not_active",
						message: "semantic Canvas is no longer active" });
					socket.close(1008, "semantic document is not active");
					return;
				}
				if (current?.bodyEpoch !== undefined && current.bodyEpoch !== attachment.documentEpoch) {
					this.options.cache.discardValidatedBodyUpdate(attachment.documentId);
					this.fenceSocketIfStale(socket, attachment, current.bodyEpoch);
					return;
				}
				semanticHead = current ?? undefined;
			} else if (!this.options.isActiveBody(attachment.documentId)) {
				this.options.cache.discardValidatedBodyUpdate(attachment.documentId);
				this.sendControl(socket, { type: "VAULT_ERROR", code: "body_not_active", message: "body is no longer active" });
				socket.close(1008, "body is not active");
				return;
			}
			if (!validated.requiresDurableCommit) {
				this.options.cache.stageValidatedBodyUpdate(attachment.documentId, validated);
				return;
			}
			const queued = this.options.cache.queue(attachment.documentId, {
				bytes: owned,
				digest,
				socketId: attachment.socketId,
				actor,
				kind: attachment.kind === "semantic" ? "semantic" : "body",
				documentEpoch: attachment.documentEpoch,
				...(semanticHead ? { semanticHead } : {}),
				contentHash,
				contentSize: validated.contentBytes.byteLength,
			});
			if (!queued.ok) {
				this.options.cache.discardValidatedBodyUpdate(attachment.documentId);
				this.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: queued.reason });
				socket.close(1013, "pending durability budget exceeded");
				return;
			}
			this.options.cache.stageValidatedBodyUpdate(attachment.documentId, validated);
			this.options.scheduleFlush(attachment.documentId);
		});
	}

	private relayAwareness(origin: VaultSocketPort, source: VaultSocketAttachment, frame: Uint8Array): void {
		const decoder = decoding.createDecoder(frame);
		decoding.readVarUint(decoder);
		const presence = this.options.principalPresence(source.principalId);
		if (!presence) return;
		let payload: Uint8Array;
		let awarenessClientId: number;
		try {
			payload = decoding.readVarUint8Array(decoder);
			const identity = decoding.createDecoder(payload);
			if (decoding.readVarUint(identity) !== 1) throw new Error("one awareness identity required");
			awarenessClientId = decoding.readVarUint(identity);
			if (!Number.isSafeInteger(awarenessClientId) || awarenessClientId < 0) throw new Error("invalid awareness identity");
		} catch {
			origin.close(1008, "invalid awareness identity");
			return;
		}
		if (source.awarenessClientId !== undefined && source.awarenessClientId !== awarenessClientId) {
			origin.close(1008, "awareness identity changed");
			return;
		}
		if (source.awarenessClientId === undefined) {
			for (const socket of this.options.sockets.sockets()) {
				if (socket === origin) continue;
				const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
				if (attachment?.awarenessClientId === awarenessClientId
					&& attachment.documentId === source.documentId && attachment.kind === source.kind) {
					origin.close(1008, "awareness identity already in use");
					return;
				}
			}
			source.awarenessClientId = awarenessClientId;
			origin.serializeAttachment(source);
		}
		let update: Uint8Array;
		try {
			update = modifyAwarenessUpdate(payload, (state: unknown) => {
				if (!state || typeof state !== "object" || Array.isArray(state)) return state;
				return { ...state, user: {
					name: presence.displayName, id: source.deviceId, principalId: source.principalId,
					deviceId: source.deviceId,
					...(source.deviceName ? { deviceName: source.deviceName } : {}),
					colorSeed: presence.colorSeed,
					...presenceColors(presence.colorSeed),
				} };
			});
		} catch { return; }
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(encoder, update);
		const trustedFrame = encoding.toUint8Array(encoder);
		for (const socket of this.options.sockets.sockets()) {
			if (socket === origin) continue;
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === source.kind && attachment.documentId === source.documentId
				&& attachment.documentEpoch === source.documentEpoch
				&& attachment.vaultId === source.vaultId && attachment.vaultGeneration === source.vaultGeneration) {
				try { socket.send(trustedFrame); } catch { /* peer closed */ }
			}
		}
	}

	private fenceSocketIfStale(socket: VaultSocketPort, attachment: VaultSocketAttachment,
		knownCurrentEpoch?: SemanticEpoch): boolean {
		const currentEpoch = knownCurrentEpoch ?? (attachment.kind === "root"
			? this.options.currentRootEpoch?.() ?? attachment.documentEpoch
			: attachment.kind === "semantic"
				? this.options.currentSemanticEpoch?.(attachment.documentId)
					?? this.options.currentSemanticHead?.(attachment.documentId)?.bodyEpoch
					?? attachment.documentEpoch
				: this.options.currentBodyHead?.(attachment.documentId)?.bodyEpoch ?? attachment.documentEpoch);
		if (currentEpoch === undefined || currentEpoch === attachment.documentEpoch) return false;
		const mismatch = attachment.kind === "root"
			? new SemanticEpochMismatchError({ purpose: "root", documentId: "root",
				expectedRootEpoch: currentEpoch, receivedRootEpoch: attachment.documentEpoch })
			: new SemanticEpochMismatchError({ purpose: "body", documentId: attachment.documentId,
				expectedBodyEpoch: currentEpoch, receivedBodyEpoch: attachment.documentEpoch });
		this.sendControl(socket, mismatch.toSocketFrame());
		try { socket.close(SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE, "semantic epoch reset"); } catch { /* durably fenced */ }
		return true;
	}

	private actorFromAttachment(attachment: VaultSocketAttachment): VaultActorContext {
		return {
			vaultId: attachment.vaultId, vaultGeneration: attachment.vaultGeneration,
			principalId: attachment.principalId, membershipRevision: attachment.membershipRevision,
			deviceId: attachment.deviceId, deviceCredentialRevision: attachment.deviceCredentialRevision,
			...(attachment.deviceName ? { deviceName: attachment.deviceName } : {}),
			role: attachment.role, policyVersion: attachment.policyVersion,
			capabilityDigest: attachment.capabilityDigest,
		};
	}

	private sendControl(socket: VaultSocketPort, value: unknown): void {
		try { socket.send(`__YPS:${JSON.stringify(value)}`); } catch { /* peer closed */ }
	}
}
