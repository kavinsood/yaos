import * as Y from "yjs";
import {
	MAX_BODY_SOCKETS,
	MAX_LOADED_BODY_ESTIMATED_BYTES,
	MAX_PENDING_BYTES_PER_DOCUMENT,
	MAX_PENDING_BYTES_PER_SOCKET,
	MAX_PENDING_BYTES_PER_VAULT,
	MAX_TRANSIENT_PENDING_BYTES,
} from "./contracts";
import type { VaultStore } from "./vaultStore";
import type { ReconstructedDocument } from "./vaultDocumentStore";

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
	| "vault_transient_bytes"
	| "body_cache_count"
	| "body_cache_resident_bytes";

export interface VaultDocumentCacheLimits {
	loadedBodies: number;
	residentBytes: number;
	transientBytes: number;
}

const DEFAULT_CACHE_LIMITS: VaultDocumentCacheLimits = {
	loadedBodies: MAX_BODY_SOCKETS,
	residentBytes: MAX_LOADED_BODY_ESTIMATED_BYTES,
	transientBytes: MAX_TRANSIENT_PENDING_BYTES,
};

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
	limits: VaultDocumentCacheLimits;
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
	private readonly transientReservationsByDocument = new Map<string, number>();
	private readonly loadFailures = new Map<string, string>();
	private pendingBytesTotal = 0;
	private transientReservationsTotal = 0;
	private reservationEpoch = 0;

	constructor(
		private readonly store: VaultStore,
		private readonly openBodyIds: () => ReadonlySet<string>,
		private readonly pinnedBodyIds: () => ReadonlySet<string>,
		private readonly limits: VaultDocumentCacheLimits = DEFAULT_CACHE_LIMITS,
	) {
		if (!Number.isSafeInteger(limits.loadedBodies) || limits.loadedBodies < 0
			|| !Number.isSafeInteger(limits.residentBytes) || limits.residentBytes < 0
			|| !Number.isSafeInteger(limits.transientBytes) || limits.transientBytes < 0) {
			throw new Error("cache limits must be non-negative safe integers");
		}
	}

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
		if (body) {
			const reason = this.ensureBodyCapacity(documentId, this.durableBodyCost(documentId));
			if (reason) throw new Error(reason);
		}
		let reconstructed: ReconstructedDocument;
		try {
			reconstructed = this.store.reconstructDocument(documentId);
			if (reconstructed.generation <= 0) {
				reconstructed.doc.destroy();
				throw new Error(`${body ? "body" : "root"} state is missing`);
			}
		} catch (error) {
			this.loadFailures.set(documentId, message(error));
			throw error;
		}
		const estimatedBytes = Y.encodeStateAsUpdate(reconstructed.doc).byteLength;
		if (body) {
			const reason = this.ensureBodyCapacity(documentId, estimatedBytes);
			if (reason) {
				reconstructed.doc.destroy();
				throw new Error(reason);
			}
		}
		const loaded: LoadedVaultDocument = {
			doc: reconstructed.doc,
			generation: reconstructed.generation,
			lastUsedAt: Date.now(),
			dirty: false,
			estimatedBytes,
			residentBytes: estimatedBytes,
			transientBytes: this.documentTransientBytes(documentId),
		};
		this.loaded.set(documentId, loaded);
		this.loadFailures.delete(documentId);
		return loaded;
	}

	admitBody(documentId: string): boolean {
		if (this.loaded.has(documentId)) return true;
		const candidates = this.cleanBodyCandidates(documentId);
		let count = this.loadedBodyCount();
		while (count >= this.limits.loadedBodies && candidates.length > 0) {
			const [id, value] = candidates.shift()!;
			this.loaded.delete(id);
			value.doc.destroy();
			count--;
		}
		return count < this.limits.loadedBodies;
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
		if (this.transientBytesTotal() + bytes > this.limits.transientBytes) return { ok: false, reason: "vault_transient_bytes" };
		const pending = this.pending.get(documentId) ?? [];
		pending.push(entry);
		this.pending.set(documentId, pending);
		this.pendingBytesByDocument.set(documentId, documentBytes + bytes);
		this.pendingBytesBySocket.set(entry.socketId, socketBytes + bytes);
		this.pendingBytesTotal += bytes;
		const loaded = this.loaded.get(documentId);
		if (loaded) {
			loaded.dirty = true;
			loaded.transientBytes = this.documentTransientBytes(documentId);
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
			loaded.transientBytes = this.documentTransientBytes(documentId);
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
			loaded.transientBytes = this.documentTransientBytes(documentId);
		}
	}

	applyDurableUpdate(documentId: string, update: Uint8Array, generation: number, origin: unknown): boolean {
		const loaded = this.loaded.get(documentId);
		if (!loaded) return false;
		let measuredBytes = loaded.residentBytes;
		if (documentId !== "root") {
			const candidate = new Y.Doc({ guid: documentId });
			try {
				Y.applyUpdate(candidate, Y.encodeStateAsUpdate(loaded.doc), "cache-budget-baseline");
				Y.applyUpdate(candidate, update, "cache-budget-candidate");
				measuredBytes = Y.encodeStateAsUpdate(candidate).byteLength;
			} finally {
				candidate.destroy();
			}
			const reason = this.ensureBodyCapacity(documentId, measuredBytes);
			if (reason) throw new Error(reason);
		}
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
		loaded.estimatedBytes = documentId === "root"
			? Y.encodeStateAsUpdate(loaded.doc).byteLength
			: measuredBytes;
		loaded.residentBytes = loaded.estimatedBytes;
		return changed;
	}

	recordTransient(documentId: string, bytes: number): () => void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("transient reservation must be a non-negative safe integer");
		if (this.transientBytesTotal() + bytes > this.limits.transientBytes) throw new Error("vault_transient_bytes");
		this.transientReservationsTotal += bytes;
		this.transientReservationsByDocument.set(
			documentId,
			(this.transientReservationsByDocument.get(documentId) ?? 0) + bytes,
		);
		this.refreshDocumentTransientBytes(documentId);
		const reservationEpoch = this.reservationEpoch;
		let released = false;
		return () => {
			if (released || reservationEpoch !== this.reservationEpoch) return;
			released = true;
			const current = this.transientReservationsByDocument.get(documentId) ?? 0;
			const releasedBytes = Math.min(bytes, current);
			const remaining = current - releasedBytes;
			if (remaining === 0) this.transientReservationsByDocument.delete(documentId);
			else this.transientReservationsByDocument.set(documentId, remaining);
			this.transientReservationsTotal -= releasedBytes;
			this.refreshDocumentTransientBytes(documentId);
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
		this.transientReservationsByDocument.clear();
		this.loadFailures.clear();
		this.pendingBytesTotal = 0;
		this.transientReservationsTotal = 0;
		this.reservationEpoch++;
	}

	diagnostics(): VaultDocumentCacheDiagnostics {
		let estimatedBytes = 0;
		let residentBytes = 0;
		const loaded = [...this.loaded].map(([documentId, value]) => {
			if (documentId !== "root") {
				estimatedBytes += value.estimatedBytes;
				residentBytes += value.residentBytes;
			}
			const transientBytes = this.documentTransientBytes(documentId);
			return {
				documentId,
				generation: value.generation,
				dirty: value.dirty,
				lastUsedAt: value.lastUsedAt,
				estimatedBytes: value.estimatedBytes,
				residentBytes: value.residentBytes,
				transientBytes,
			};
		});
		return {
			loaded,
			costs: { estimatedBytes, residentBytes, transientBytes: this.transientBytesTotal() },
			limits: { ...this.limits },
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

	private ensureBodyCapacity(documentId: string, incomingBytes: number): CachePressureReason | null {
		if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) throw new Error("body estimated bytes must be a non-negative safe integer");
		const existing = this.loaded.get(documentId);
		const replacingBytes = existing?.residentBytes ?? 0;
		const additionalCount = existing ? 0 : 1;
		const candidates = this.cleanBodyCandidates(documentId);
		let count = this.loadedBodyCount();
		let residentBytes = this.loadedBodyResidentBytes() - replacingBytes;
		while (
			(count + additionalCount > this.limits.loadedBodies
				|| residentBytes + incomingBytes > this.limits.residentBytes)
			&& candidates.length > 0
		) {
			const [id, value] = candidates.shift()!;
			this.loaded.delete(id);
			residentBytes -= value.residentBytes;
			count--;
			value.doc.destroy();
		}
		if (count + additionalCount > this.limits.loadedBodies) return "body_cache_count";
		if (residentBytes + incomingBytes > this.limits.residentBytes) return "body_cache_resident_bytes";
		return null;
	}

	private cleanBodyCandidates(excludingDocumentId: string): Array<[string, LoadedVaultDocument]> {
		const open = this.openBodyIds();
		const pinned = this.pinnedBodyIds();
		return [...this.loaded.entries()]
			.filter(([id, value]) => id !== "root" && id !== excludingDocumentId && !value.dirty
				&& !this.pending.has(id) && !open.has(id) && !pinned.has(id))
			.sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
	}

	private durableBodyCost(documentId: string): number {
		const head = this.store.documentHead(documentId);
		return head ? this.store.documentEncodedHistoryBytes(documentId, head.latestSequence) : 0;
	}

	private loadedBodyResidentBytes(): number {
		let bytes = 0;
		for (const [id, loaded] of this.loaded) if (id !== "root") bytes += loaded.residentBytes;
		return bytes;
	}

	private transientBytesTotal(): number {
		return this.pendingBytesTotal + this.transientReservationsTotal;
	}

	private documentTransientBytes(documentId: string): number {
		return (this.pendingBytesByDocument.get(documentId) ?? 0)
			+ (this.transientReservationsByDocument.get(documentId) ?? 0);
	}

	private refreshDocumentTransientBytes(documentId: string): void {
		const loaded = this.loaded.get(documentId);
		if (loaded) loaded.transientBytes = this.documentTransientBytes(documentId);
	}

	private releasePendingBytes(documentId: string, socketId: string, bytes: number): void {
		this.pendingBytesTotal = Math.max(0, this.pendingBytesTotal - bytes);
		const documentBytes = Math.max(0, (this.pendingBytesByDocument.get(documentId) ?? 0) - bytes);
		const socketBytes = Math.max(0, (this.pendingBytesBySocket.get(socketId) ?? 0) - bytes);
		if (documentBytes === 0) this.pendingBytesByDocument.delete(documentId);
		else this.pendingBytesByDocument.set(documentId, documentBytes);
		if (socketBytes === 0) this.pendingBytesBySocket.delete(socketId);
		else this.pendingBytesBySocket.set(socketId, socketBytes);
		this.refreshDocumentTransientBytes(documentId);
	}
}
