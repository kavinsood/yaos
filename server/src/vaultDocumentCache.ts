import * as Y from "yjs";
import {
	MAX_BODY_SOCKETS,
	MAX_PENDING_BYTES_PER_DOCUMENT,
	MAX_PENDING_BYTES_PER_SOCKET,
	MAX_PENDING_BYTES_PER_VAULT,
} from "./contracts";
import type { VaultStore } from "./vaultStore";

export interface LoadedVaultDocument {
	doc: Y.Doc;
	generation: number;
	lastUsedAt: number;
	dirty: boolean;
	estimatedBytes: number;
	residentBytes: number;
	transientBytes: number;
}

export interface PendingVaultUpdate {
	bytes: Uint8Array;
	digest: string;
	socketId: string;
}

export type CachePressureReason =
	| "document_pending_bytes"
	| "socket_pending_bytes"
	| "vault_pending_bytes"
	| "body_cache_count";

export interface VaultDocumentCacheDiagnostics {
	loaded: Array<{
		documentId: string;
		generation: number;
		dirty: boolean;
		lastUsedAt: number;
		estimatedBytes: number;
		residentBytes: number;
		transientBytes: number;
	}>;
	costs: { estimatedBytes: number; residentBytes: number; transientBytes: number };
	pending: Record<string, number>;
	pendingBytes: {
		total: number;
		byDocument: Record<string, number>;
		bySocket: Record<string, number>;
		limits: { document: number; socket: number; vault: number };
	};
	loadFailures: Record<string, string>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Owns loaded Y.Docs, dirty queues, cost accounting, and clean-body LRU admission. */
export class VaultDocumentCache {
	private readonly loaded = new Map<string, LoadedVaultDocument>();
	private readonly pending = new Map<string, PendingVaultUpdate[]>();
	private readonly pendingBytesByDocument = new Map<string, number>();
	private readonly pendingBytesBySocket = new Map<string, number>();
	private readonly loadFailures = new Map<string, string>();
	private pendingBytesTotal = 0;

	constructor(
		private readonly store: VaultStore,
		private readonly openBodyIds: () => ReadonlySet<string>,
		private readonly pinnedBodyIds: () => ReadonlySet<string>,
	) {}

	get(documentId: string): LoadedVaultDocument | undefined {
		return this.loaded.get(documentId);
	}

	load(documentId: string, body: boolean, admitted: () => boolean): LoadedVaultDocument {
		const existing = this.loaded.get(documentId);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing;
		}
		if (body && !admitted()) throw new Error("body is not admitted");
		if (body && !this.admitBody(documentId)) throw new Error("body_cache_count");
		try {
			const reconstructed = this.store.reconstructDocument(documentId);
			if (reconstructed.generation <= 0) {
				reconstructed.doc.destroy();
				throw new Error(`${body ? "body" : "root"} state is missing`);
			}
			const estimatedBytes = Y.encodeStateAsUpdate(reconstructed.doc).byteLength;
			const loaded: LoadedVaultDocument = {
				doc: reconstructed.doc,
				generation: reconstructed.generation,
				lastUsedAt: Date.now(),
				dirty: false,
				estimatedBytes,
				residentBytes: estimatedBytes,
				transientBytes: 0,
			};
			this.loaded.set(documentId, loaded);
			this.loadFailures.delete(documentId);
			return loaded;
		} catch (error) {
			this.loadFailures.set(documentId, message(error));
			throw error;
		}
	}

	admitBody(documentId: string): boolean {
		if (this.loaded.has(documentId)) return true;
		this.evictCleanBodiesUntilBelow(MAX_BODY_SOCKETS);
		return this.loadedBodyCount() < MAX_BODY_SOCKETS;
	}

	queue(
		documentId: string,
		entry: PendingVaultUpdate,
	): { ok: true } | { ok: false; reason: CachePressureReason } {
		const bytes = entry.bytes.byteLength;
		const documentBytes = this.pendingBytesByDocument.get(documentId) ?? 0;
		const socketBytes = this.pendingBytesBySocket.get(entry.socketId) ?? 0;
		if (documentBytes + bytes > MAX_PENDING_BYTES_PER_DOCUMENT) return { ok: false, reason: "document_pending_bytes" };
		if (socketBytes + bytes > MAX_PENDING_BYTES_PER_SOCKET) return { ok: false, reason: "socket_pending_bytes" };
		if (this.pendingBytesTotal + bytes > MAX_PENDING_BYTES_PER_VAULT) return { ok: false, reason: "vault_pending_bytes" };
		const pending = this.pending.get(documentId) ?? [];
		pending.push(entry);
		this.pending.set(documentId, pending);
		this.pendingBytesByDocument.set(documentId, documentBytes + bytes);
		this.pendingBytesBySocket.set(entry.socketId, socketBytes + bytes);
		this.pendingBytesTotal += bytes;
		const loaded = this.loaded.get(documentId);
		if (loaded) {
			loaded.dirty = true;
			loaded.transientBytes += bytes;
		}
		return { ok: true };
	}

	pendingFor(documentId: string): readonly PendingVaultUpdate[] {
		return this.pending.get(documentId) ?? [];
	}

	takePending(documentId: string): PendingVaultUpdate[] {
		const entries = this.pending.get(documentId) ?? [];
		this.pending.delete(documentId);
		for (const entry of entries) this.releasePendingBytes(documentId, entry.socketId, entry.bytes.byteLength);
		const loaded = this.loaded.get(documentId);
		if (loaded) {
			loaded.dirty = false;
			loaded.transientBytes = 0;
		}
		return entries;
	}

	restorePending(documentId: string, entries: PendingVaultUpdate[]): void {
		for (const entry of entries) {
			const result = this.queue(documentId, entry);
			if (!result.ok) throw new Error(`could not restore pending update: ${result.reason}`);
		}
	}

	removePendingDigest(documentId: string, digest: string): void {
		const entries = this.pending.get(documentId);
		if (!entries) return;
		const keep: PendingVaultUpdate[] = [];
		for (const entry of entries) {
			if (entry.digest === digest) this.releasePendingBytes(documentId, entry.socketId, entry.bytes.byteLength);
			else keep.push(entry);
		}
		if (keep.length === 0) this.pending.delete(documentId);
		else this.pending.set(documentId, keep);
		const loaded = this.loaded.get(documentId);
		if (loaded) {
			loaded.dirty = keep.length > 0;
			loaded.transientBytes = keep.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
		}
	}

	applyDurableUpdate(documentId: string, update: Uint8Array, generation: number, origin: unknown): boolean {
		const loaded = this.loaded.get(documentId);
		if (!loaded) return false;
		let changed = false;
		const observer = () => { changed = true; };
		loaded.doc.on("update", observer);
		try {
			Y.applyUpdate(loaded.doc, update, origin);
		} finally {
			loaded.doc.off("update", observer);
		}
		loaded.generation = Math.max(loaded.generation, generation);
		loaded.lastUsedAt = Date.now();
		loaded.estimatedBytes = Y.encodeStateAsUpdate(loaded.doc).byteLength;
		loaded.residentBytes = loaded.estimatedBytes;
		return changed;
	}

	recordTransient(documentId: string, bytes: number): () => void {
		const loaded = this.loaded.get(documentId);
		if (loaded) loaded.transientBytes += bytes;
		return () => {
			const current = this.loaded.get(documentId);
			if (current) current.transientBytes = Math.max(0, current.transientBytes - bytes);
		};
	}

	evict(documentId: string): boolean {
		if (documentId === "root" || this.pending.has(documentId)) return false;
		const loaded = this.loaded.get(documentId);
		if (!loaded || loaded.dirty || this.openBodyIds().has(documentId) || this.pinnedBodyIds().has(documentId)) return false;
		this.loaded.delete(documentId);
		loaded.doc.destroy();
		return true;
	}

	clear(): void {
		for (const loaded of this.loaded.values()) loaded.doc.destroy();
		this.loaded.clear();
		this.pending.clear();
		this.pendingBytesByDocument.clear();
		this.pendingBytesBySocket.clear();
		this.loadFailures.clear();
		this.pendingBytesTotal = 0;
	}

	diagnostics(): VaultDocumentCacheDiagnostics {
		let estimatedBytes = 0;
		let residentBytes = 0;
		let transientBytes = 0;
		const loaded = [...this.loaded].map(([documentId, value]) => {
			estimatedBytes += value.estimatedBytes;
			residentBytes += value.residentBytes;
			transientBytes += value.transientBytes;
			return {
				documentId,
				generation: value.generation,
				dirty: value.dirty,
				lastUsedAt: value.lastUsedAt,
				estimatedBytes: value.estimatedBytes,
				residentBytes: value.residentBytes,
				transientBytes: value.transientBytes,
			};
		});
		return {
			loaded,
			costs: { estimatedBytes, residentBytes, transientBytes },
			pending: Object.fromEntries([...this.pending].map(([id, values]) => [id, values.length])),
			pendingBytes: {
				total: this.pendingBytesTotal,
				byDocument: Object.fromEntries(this.pendingBytesByDocument),
				bySocket: Object.fromEntries(this.pendingBytesBySocket),
				limits: {
					document: MAX_PENDING_BYTES_PER_DOCUMENT,
					socket: MAX_PENDING_BYTES_PER_SOCKET,
					vault: MAX_PENDING_BYTES_PER_VAULT,
				},
			},
			loadFailures: Object.fromEntries(this.loadFailures),
		};
	}

	private loadedBodyCount(): number {
		let count = 0;
		for (const id of this.loaded.keys()) if (id !== "root") count++;
		return count;
	}

	private evictCleanBodiesUntilBelow(limit: number): void {
		const open = this.openBodyIds();
		const pinned = this.pinnedBodyIds();
		const candidates = [...this.loaded.entries()]
			.filter(([id, value]) => id !== "root" && !value.dirty && !this.pending.has(id) && !open.has(id) && !pinned.has(id))
			.sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
		let count = this.loadedBodyCount();
		while (count >= limit && candidates.length > 0) {
			const [id, value] = candidates.shift()!;
			this.loaded.delete(id);
			value.doc.destroy();
			count--;
		}
	}

	private releasePendingBytes(documentId: string, socketId: string, bytes: number): void {
		this.pendingBytesTotal = Math.max(0, this.pendingBytesTotal - bytes);
		const documentBytes = Math.max(0, (this.pendingBytesByDocument.get(documentId) ?? 0) - bytes);
		const socketBytes = Math.max(0, (this.pendingBytesBySocket.get(socketId) ?? 0) - bytes);
		if (documentBytes === 0) this.pendingBytesByDocument.delete(documentId);
		else this.pendingBytesByDocument.set(documentId, documentBytes);
		if (socketBytes === 0) this.pendingBytesBySocket.delete(socketId);
		else this.pendingBytesBySocket.set(socketId, socketBytes);
	}
}
