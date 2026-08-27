import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { MAX_AWARENESS_BYTES, MAX_BODY_SOCKETS, MAX_CANDIDATE_BYTES, MAX_ROOT_SOCKETS } from "./contracts";
import { sha256Hex } from "./hex";
import type { VaultDocumentCache } from "./vaultDocumentCache";
import { safeBlobPath } from "./shared/vaultPath";
import { isCanonicalVaultId } from "./vaultId";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MAX_IDENTITY_LENGTH = 256;

export interface VaultSocketAttachment {
	vaultId: string;
	vaultGeneration: string;
	runtimeEpoch: string;
	documentId: string;
	kind: "root" | "body";
	deviceId: string;
	socketId: string;
}
export interface VaultSocketPort {
	close(code?: number, reason?: string): void;
	deserializeAttachment(): unknown;
	send(message: ArrayBuffer | ArrayBufferView | string): void;
}

function validIdentity(value: string): boolean {
	if (value.length === 0 || value.length > MAX_IDENTITY_LENGTH) return false;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export function parseVaultSocketAttachment(value: unknown): VaultSocketAttachment | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const attachment = value as Partial<VaultSocketAttachment>;
	if (!isCanonicalVaultId(attachment.vaultId) || !isCanonicalVaultId(attachment.vaultGeneration)
		|| typeof attachment.runtimeEpoch !== "string" || !validIdentity(attachment.runtimeEpoch)
		|| typeof attachment.deviceId !== "string" || !validIdentity(attachment.deviceId)
		|| typeof attachment.socketId !== "string" || !validIdentity(attachment.socketId)
		|| (attachment.kind !== "root" && attachment.kind !== "body")
		|| typeof attachment.documentId !== "string") return null;
	if (attachment.kind === "root" && attachment.documentId !== "root") return null;
	if (attachment.kind === "body" && attachment.documentId === "root") return null;
	return attachment as VaultSocketAttachment;
}

function protectedAttachmentState(doc: Y.Doc): string {
	const sorted = (map: Y.Map<unknown>): Record<string, unknown> =>
		Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
	return JSON.stringify({
		pathToBlob: sorted(doc.getMap("pathToBlob")),
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
	const tombstones = doc.getMap<unknown>("blobTombstones");
	for (const [path, value] of refs.entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)
			|| !("hash" in value) || typeof value.hash !== "string"
			|| !("size" in value) || typeof value.size !== "number"
			|| safeBlobPath(path, "", { hash: value.hash, size: value.size }) !== path
			|| tombstones.has(path)) return false;
	}
	for (const [path, value] of tombstones.entries()) {
		if (safeBlobPath(path) !== path || typeof value !== "object" || value === null || Array.isArray(value)
			|| !("deletedAt" in value) || !Number.isSafeInteger(value.deletedAt) || (value.deletedAt as number) < 0) return false;
	}
	for (const [hash, value] of doc.getMap<unknown>("blobMeta").entries()) {
		if (!/^[a-f0-9]{64}$/.test(hash) || typeof value !== "object" || value === null || Array.isArray(value)
			|| !("size" in value) || !Number.isSafeInteger(value.size) || (value.size as number) < 0
			|| !("mime" in value) || typeof value.mime !== "string" || value.mime.length === 0 || value.mime.length > 256
			|| !("createdAt" in value) || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) return false;
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

interface SocketServiceOptions {
	ctx: DurableObjectState;
	cache: VaultDocumentCache;
	vaultId: () => string;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	isActiveBody: (bodyId: string) => boolean;
	isDeviceRevoked(deviceId: string): boolean;
	scheduleFlush: (documentId: string) => void;
}

/** Owns hibernated root/body sockets, attachments, framing, and fan-out. */
export class VaultSocketService {
	constructor(private readonly options: SocketServiceOptions) {}

	openBodyIds(): ReadonlySet<string> {
		const result = new Set<string>();
		for (const socket of this.options.ctx.getWebSockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "body") result.add(attachment.documentId);
		}
		return result;
	}

	accept(documentId: string, kind: VaultSocketAttachment["kind"], deviceId: string): Response {
		if (!validIdentity(deviceId)) return Response.json({ error: "invalid_device_identity" }, { status: 400 });
		if (this.options.isDeviceRevoked(deviceId)) {
			return Response.json({ error: "device_membership_revoked" }, { status: 401 });
		}
		let rootCount = 0;
		let bodyCount = 0;
		for (const socket of this.options.ctx.getWebSockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "root") rootCount++;
			if (attachment?.kind === "body") bodyCount++;
		}
		if (kind === "root" && rootCount >= MAX_ROOT_SOCKETS) return Response.json({ error: "root_socket_limit" }, { status: 429 });
		if (kind === "body" && bodyCount >= MAX_BODY_SOCKETS) return Response.json({ error: "body_socket_limit" }, { status: 429 });
		if (kind === "body" && !this.options.cache.admitBody(documentId)) return Response.json({ error: "body_cache_count" }, { status: 429 });
		const loaded = this.options.cache.load(documentId, kind === "body", () => this.options.isActiveBody(documentId));
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const attachment: VaultSocketAttachment = {
			vaultId: this.options.vaultId(),
			vaultGeneration: this.options.vaultGeneration(),
			runtimeEpoch: this.options.runtimeEpoch,
			documentId,
			kind,
			deviceId,
			socketId: crypto.randomUUID(),
		};
		server.serializeAttachment(attachment);
		this.options.ctx.acceptWebSocket(server);
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeSyncStep1(encoder, loaded.doc);
		server.send(encoding.toUint8Array(encoder));
		this.sendControl(server, {
			type: "VAULT_READY",
			documentId,
			vaultGeneration: attachment.vaultGeneration,
			durableGeneration: loaded.generation,
			runtimeEpoch: attachment.runtimeEpoch,
		});
		return new Response(null, { status: 101, webSocket: client });
	}

	async message(socket: VaultSocketPort, message: string | ArrayBuffer): Promise<void> {
		if (typeof message === "string") {
			if (message.length > 64 * 1024) socket.close(1009, "text frame too large");
			return;
		}
		const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
		if (!attachment
			|| attachment.vaultId !== this.options.vaultId()
			|| attachment.vaultGeneration !== this.options.vaultGeneration()
			|| attachment.runtimeEpoch !== this.options.runtimeEpoch) {
			socket.close(1008, "socket authority mismatch");
			return;
		}
		if (this.options.isDeviceRevoked(attachment.deviceId)) {
			this.sendControl(socket, { type: "error", code: "unauthorized", reason: "device membership revoked" });
			socket.close(1008, "device membership revoked");
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
				else if (attachment.kind === "root") this.relayRootAwareness(socket, attachment, frame);
				return;
			}
			if (type !== MESSAGE_SYNC) return;
			if (attachment.kind === "body" && !this.options.isActiveBody(attachment.documentId)) {
				socket.close(1008, "body is not active");
				return;
			}
			await this.handleSyncFrame(socket, attachment, decoder);
		} catch (error) {
			this.sendControl(socket, { type: "VAULT_ERROR", message: error instanceof Error ? error.message : String(error) });
		}
	}

	closeBody(bodyId: string): void {
		for (const socket of this.options.ctx.getWebSockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "body" && attachment.documentId === bodyId) socket.close(1008, "body deleted");
		}
		this.options.cache.evict(bodyId);
	}
	closeDevice(deviceId: string): number {
		let closed = 0;
		for (const socket of this.options.ctx.getWebSockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.deviceId !== deviceId) continue;
			this.sendControl(socket, { type: "error", code: "unauthorized", reason: "device membership revoked" });
			try {
				socket.close(1008, "device membership revoked");
			} catch {
				// The durable revocation fence rejects any later frame.
			}
			closed++;
		}
		return closed;
	}

	closeAll(reason: string): void {
		for (const socket of this.options.ctx.getWebSockets()) {
			try { socket.close(1001, reason); } catch { /* already closed */ }
		}
	}

	notifyBodyCommitted(bodyId: string, durableGeneration: number): void {
		const value = {
			type: "BODY_COMMITTED",
			bodyId,
			vaultGeneration: this.options.vaultGeneration(),
			durableGeneration,
			runtimeEpoch: this.options.runtimeEpoch,
		};
		for (const socket of this.options.ctx.getWebSockets()) {
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "root" || attachment?.documentId === bodyId) this.sendControl(socket, value);
		}
	}

	broadcastDocumentUpdate(documentId: string, update: Uint8Array, origin: unknown): void {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeUpdate(encoder, update);
		const frame = encoding.toUint8Array(encoder);
		for (const socket of this.options.ctx.getWebSockets()) {
			if (socket === origin) continue;
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.documentId === documentId) {
				try { socket.send(frame); } catch { /* peer closed */ }
			}
		}
	}

	private async handleSyncFrame(socket: VaultSocketPort, attachment: VaultSocketAttachment, decoder: decoding.Decoder): Promise<void> {
		const loaded = this.options.cache.load(
			attachment.documentId,
			attachment.kind === "body",
			() => this.options.isActiveBody(attachment.documentId),
		);
		const syncType = decoding.readVarUint(decoder);
		if (syncType === 0) {
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
			if (rootUpdateChangesDocument(loaded.doc, update)) {
				socket.close(1008, "root updates require durable publication");
			}
			return;
		}
		const owned = update.slice();
		const digest = await sha256Hex(owned);
		const queued = this.options.cache.queue(attachment.documentId, {
			bytes: owned,
			digest,
			socketId: attachment.socketId,
		});
		if (!queued.ok) {
			this.sendControl(socket, { type: "VAULT_BACKPRESSURE", reason: queued.reason });
			socket.close(1013, "pending durability budget exceeded");
			return;
		}
		let changed = false;
		const observer = () => { changed = true; };
		loaded.doc.on("update", observer);
		try { Y.applyUpdate(loaded.doc, owned, socket); }
		finally { loaded.doc.off("update", observer); }
		if (!changed) {
			this.options.cache.removePendingDigest(attachment.documentId, digest);
			return;
		}
		this.broadcastDocumentUpdate(attachment.documentId, owned, socket);
		this.options.scheduleFlush(attachment.documentId);
	}

	private relayRootAwareness(origin: VaultSocketPort, source: VaultSocketAttachment, frame: Uint8Array): void {
		for (const socket of this.options.ctx.getWebSockets()) {
			if (socket === origin) continue;
			const attachment = parseVaultSocketAttachment(socket.deserializeAttachment());
			if (attachment?.kind === "root" && attachment.vaultId === source.vaultId) {
				try { socket.send(frame); } catch { /* peer closed */ }
			}
		}
	}

	private sendControl(socket: VaultSocketPort, value: unknown): void {
		try { socket.send(`__YPS:${JSON.stringify(value)}`); } catch { /* peer closed */ }
	}
}
