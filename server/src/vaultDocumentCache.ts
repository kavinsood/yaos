import type { YwasmCrdtDocument } from "./crdt/ywasmCrdtEngine";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import {
	MAX_BODY_SOCKETS,
	MAX_LOADED_BODY_ENCODED_STATE_BYTES,
	MAX_ROOT_RESIDENT_ENCODED_STATE_BYTES,
	MAX_PENDING_BYTES_PER_DOCUMENT,
	MAX_PENDING_BYTES_PER_SOCKET,
	MAX_PENDING_BYTES_PER_VAULT,
	MAX_TRANSIENT_PENDING_BYTES,
} from "./contracts";
import type { SemanticCatalogHead, VaultStore } from "./vaultStore";
import type { ReconstructedDocument } from "./vaultDocumentStore";
import type { VaultActorContext } from "./collaboration";
import { validateCanvasDocument } from "./crdt/canvasSemanticDocument";
import { canonicalMarkdownBytes, canonicalizeMarkdown } from "./shared/markdownCodec";
import {
	MAX_CANDIDATE_UPDATE_BYTES,
	MAX_CANDIDATE_UPDATE_FRAMES,
	MAX_CLIENT_MARKDOWN_BYTES,
	MAX_DURABLE_UPDATE_BYTES,
} from "./shared/durableLimits";
import { validateFrontmatterSemanticRoots } from "./crdt/frontmatterSemanticValidation";
import { INITIAL_SEMANTIC_EPOCH, type SemanticEpoch } from "./shared/semanticEpoch";

// Exact encoding is an observability/compaction census, not an admission
// proof. Keep it sparse enough that many tiny frames cannot turn monitoring
// into quadratic work; the independent byte trigger still catches large
// ingress bursts promptly.
const VALIDATION_EXACT_EVERY = 500;
const VALIDATION_EXACT_INPUT_BYTES = 256 * 1024;
/** Reserved below the compiled maximum for allocator metadata and unmodelled binding copies. */
const YWASM_LINEAR_MEMORY_SAFETY_MARGIN = 8 * 1024 * 1024;

export type VaultDocumentKind = "root" | "body" | "canvas";

export interface LoadedVaultDocument {
	documentId: string;
	lineageKey: string;
	kind: VaultDocumentKind;
	doc: YwasmCrdtDocument;
	validationDoc: YwasmCrdtDocument;
	generation: number;
	semanticEpoch: SemanticEpoch;
	lastUsedAt: number;
	dirty: boolean;
	encodedStateBytes: number;
	validationEncodedStateBytes: number;
	transientBytes: number;
	validationPending: boolean;
	validationLastExactEncodedBytes: number;
	validationUpdatesSinceExact: number;
	validationInputBytesSinceExact: number;
}

export interface ValidatedBodyUpdate {
	readonly changesState: boolean;
	/** False only when the live durable view already proves this is a no-op. */
	readonly requiresDurableCommit: boolean;
	readonly contentBytes: Uint8Array;
	readonly encodedStateBytes: number;
	readonly exactEncodedStateBytes: boolean;
}

export class VaultDocumentValidationError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "VaultDocumentValidationError";
	}
}

export interface PendingVaultUpdate {
	bytes: Uint8Array;
	digest: string;
	socketId: string;
	actor?: VaultActorContext;
	/** Frozen socket admission scope. Required for every runtime-produced entry. */
	kind?: "body" | "semantic";
	documentEpoch?: SemanticEpoch;
	/** Exact active Canvas catalog authority observed immediately before admission. */
	semanticHead?: SemanticCatalogHead;
	contentHash?: string;
	contentSize?: number;
}

export type CachePressureReason =
	| "document_pending_bytes"
	| "socket_pending_bytes"
	| "vault_pending_bytes"
	| "vault_transient_bytes"
	| "wasm_linear_memory_envelope"
	| "body_cache_count"
	| "body_cache_encoded_state_bytes"
	| "root_cache_encoded_state_bytes";

export class VaultDocumentCachePressureError extends Error {
	constructor(readonly reason: CachePressureReason) {
		super(reason);
		this.name = "VaultDocumentCachePressureError";
	}
}

export interface VaultDocumentCacheLimits {
	loadedBodies: number;
	encodedStateBytes: number;
	rootEncodedStateBytes: number;
	transientBytes: number;
}

const DEFAULT_CACHE_LIMITS: VaultDocumentCacheLimits = {
	loadedBodies: MAX_BODY_SOCKETS,
	encodedStateBytes: MAX_LOADED_BODY_ENCODED_STATE_BYTES,
	rootEncodedStateBytes: MAX_ROOT_RESIDENT_ENCODED_STATE_BYTES,
	transientBytes: MAX_TRANSIENT_PENDING_BYTES,
};

export interface VaultDocumentCacheDiagnostics {
	loaded: Array<{
		documentId: string;
		lineageKey: string;
		kind: VaultDocumentKind;
		generation: number;
		semanticEpoch: SemanticEpoch;
		dirty: boolean;
		lastUsedAt: number;
		encodedStateBytes: number;
		validationEncodedStateBytes: number;
		residentEncodedStateBytes: number;
		transientBytes: number;
		memoryPressure: boolean;
	}>;
	accounting: {
		formatVersion: 1;
		claim: "encoded-crdt-state-proxy-plus-wasm-linear-memory";
	};
	crdtMemory: ReturnType<typeof crdtEngine.memoryDiagnostics>;
	costs: {
		encodedStateBytes: number;
		bodyEncodedStateBytes: number;
		rootEncodedStateBytes: number;
		transientBytes: number;
	};
	limits: VaultDocumentCacheLimits;
	pending: Record<string, number>;
	pendingByLineage: Record<string, number>;
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

function applyAndDetect(doc: YwasmCrdtDocument, update: Uint8Array, origin: string): boolean {
	return crdtEngine.applyUpdateAndCheckIfChanged(doc, update, origin);
}

function boundedCandidateFrames(value: Uint8Array | readonly Uint8Array[]): readonly Uint8Array[] {
	const frames = value instanceof Uint8Array ? [value] : value;
	if (frames.length === 0 || frames.length > MAX_CANDIDATE_UPDATE_FRAMES) {
		throw new VaultDocumentValidationError("invalid_candidate_frames");
	}
	let total = 0;
	for (const frame of frames) {
		if (!(frame instanceof Uint8Array) || frame.byteLength === 0
			|| frame.byteLength > MAX_DURABLE_UPDATE_BYTES) {
			throw new VaultDocumentValidationError("invalid_candidate_frames");
		}
		total += frame.byteLength;
		if (!Number.isSafeInteger(total) || total > MAX_CANDIDATE_UPDATE_BYTES) {
			throw new VaultDocumentValidationError("candidate_update_too_large");
		}
	}
	return frames;
}

function applyManyAndDetect(doc: YwasmCrdtDocument, updates: readonly Uint8Array[], origin: string): boolean {
	let changed = false;
	for (const update of updates) {
		changed = crdtEngine.applyUpdateAndCheckIfChanged(doc, update, origin) || changed;
	}
	return changed;
}

/** Owns loaded Y.Docs, dirty queues, cost accounting, and clean-body LRU admission. */
export class VaultDocumentCache {
	private loadObserver: ((loaded: Readonly<LoadedVaultDocument>) => void) | null = null;
	/** Resident and speculative state is keyed by immutable CRDT lineage. */
	private readonly loaded = new Map<string, LoadedVaultDocument>();
	/** One active lineage per logical document; old lineages are never addressable by document ID. */
	private readonly activeLineageByDocument = new Map<string, string>();
	private readonly pending = new Map<string, PendingVaultUpdate[]>();
	private readonly pendingBytesByDocument = new Map<string, number>();
	private readonly pendingBytesBySocket = new Map<string, number>();
	private readonly transientReservationsByDocument = new Map<string, number>();
	private readonly loadFailures = new Map<string, string>();
	private pendingBytesTotal = 0;
	private transientReservationsTotal = 0;
	private reservationEpoch = 0;
	/** Epoch-keyed operation lanes; a new lineage still waits for every older lane
	 * of the same logical document before it may run. */
	private readonly documentLanes = new Map<string, Promise<void>>();

	constructor(
		private readonly store: VaultStore,
		private readonly openBodyIds: () => ReadonlySet<string>,
		private readonly pinnedBodyIds: () => ReadonlySet<string>,
		private readonly limits: VaultDocumentCacheLimits = DEFAULT_CACHE_LIMITS,
	) {
		if (!Number.isSafeInteger(limits.loadedBodies) || limits.loadedBodies < 0
			|| !Number.isSafeInteger(limits.encodedStateBytes) || limits.encodedStateBytes < 0
			|| !Number.isSafeInteger(limits.rootEncodedStateBytes) || limits.rootEncodedStateBytes < 0
			|| !Number.isSafeInteger(limits.transientBytes) || limits.transientBytes < 0) {
			throw new Error("cache limits must be non-negative safe integers");
		}
	}

	setLoadObserver(observer: ((loaded: Readonly<LoadedVaultDocument>) => void) | null): void {
		this.loadObserver = observer;
	}

	get(documentId: string): LoadedVaultDocument | undefined {
		const key = this.activeLineageByDocument.get(documentId);
		return key ? this.loaded.get(key) : undefined;
	}

	load(
		documentId: string,
		body: boolean,
		admitted: () => boolean,
		kind: VaultDocumentKind = documentId === "root" ? "root" : this.documentKind(documentId),
		allowMissing = false,
	): LoadedVaultDocument {
		const existing = this.get(documentId);
		if (existing) {
			if (existing.kind !== kind) throw new Error(`document kind changed for ${documentId}`);
			const durableEpoch = this.store.documentHead(documentId)?.semanticEpoch;
			if (durableEpoch === undefined || durableEpoch === existing.semanticEpoch) {
				existing.lastUsedAt = Date.now();
				return existing;
			}
			// A different durable epoch is a different CRDT identity. Never return an
			// old resident object under the logical document ID, even briefly.
			this.discardResident(documentId);
			this.retirePendingLineages(documentId, this.lineageKey(documentId, durableEpoch));
		}
		if ((documentId === "root") !== (kind === "root") || body !== (kind !== "root")) {
			throw new Error(`invalid document kind for ${documentId}`);
		}
		if (body && !admitted()) throw new Error("body is not admitted");
		const durableCost = this.durableStateCost(documentId);
		if (body) {
			const reason = this.ensureBodyCapacity(documentId, this.mirroredResidentCost(durableCost));
			if (reason) throw new VaultDocumentCachePressureError(reason);
		}
		// Reconstruction, full-state encoding, and creation of the validation
		// mirror can overlap. Durable history is only an estimate here, so apply
		// uncertainty headroom; it is never used as a post-state safety proof.
		const releaseTransient = this.reserveFullStateOperation(documentId, 2, durableCost);
		let reconstructed: ReconstructedDocument;
		try {
			reconstructed = this.store.reconstructDocument(documentId);
			if (reconstructed.generation <= 0 && !allowMissing) {
				crdtEngine.destroyDocument(reconstructed.doc);
				throw new Error(`${body ? "body" : "root"} state is missing`);
			}
		} catch (error) {
			this.loadFailures.set(this.currentLineageKey(documentId), message(error));
			releaseTransient();
			throw error;
		}
		try {
			const encoded = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
			const encodedStateBytes = encoded.byteLength;
			if (body) {
				const reason = this.ensureBodyCapacity(documentId, this.mirroredResidentCost(encodedStateBytes));
				if (reason) {
					crdtEngine.destroyDocument(reconstructed.doc);
					throw new VaultDocumentCachePressureError(reason);
				}
			}
				const loaded: LoadedVaultDocument = {
					documentId,
					lineageKey: this.lineageKey(documentId, reconstructed.semanticEpoch),
				kind,
				doc: reconstructed.doc,
				validationDoc: crdtEngine.createDocument(`${documentId}-validation`),
				generation: reconstructed.generation,
				semanticEpoch: reconstructed.semanticEpoch,
				lastUsedAt: Date.now(),
				dirty: false,
				encodedStateBytes,
				validationEncodedStateBytes: encodedStateBytes,
				transientBytes: this.documentTransientBytes(documentId),
				validationPending: false,
				validationLastExactEncodedBytes: encodedStateBytes,
				validationUpdatesSinceExact: 0,
				validationInputBytesSinceExact: 0,
			};
			crdtEngine.applyUpdate(loaded.validationDoc, encoded, "validation-baseline");
				this.retirePendingLineages(documentId, loaded.lineageKey);
				this.loaded.set(loaded.lineageKey, loaded);
				this.activeLineageByDocument.set(documentId, loaded.lineageKey);
				this.clearLoadFailures(documentId);
				// Defer the observer so the reconstruction reservation in this method's
				// finally block is always released before maintenance allocates again.
				queueMicrotask(() => {
					try { this.loadObserver?.(loaded); }
					catch (error) { console.warn("[yaos-vault] document load observer failed", error); }
				});
			return loaded;
		} finally {
			releaseTransient();
		}
	}

	async serializeDocument<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
		const lineageKey = this.currentLineageKey(documentId);
		// Capture every lineage tail synchronously. This preserves per-document
		// exclusion across an epoch transition without letting the lane itself lose
		// its CRDT identity.
		const previous = Promise.all([...this.documentLanes]
			.filter(([key]) => this.belongsToDocument(key, documentId))
			.map(([, tail]) => tail)).then(() => undefined);
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => current);
		this.documentLanes.set(lineageKey, tail);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.documentLanes.get(lineageKey) === tail) this.documentLanes.delete(lineageKey);
		}
	}

	admitBody(documentId: string): boolean {
		if (this.get(documentId)) return true;
		const candidates = this.cleanBodyCandidates(documentId);
		let count = this.loadedBodyCount();
		while (count >= this.limits.loadedBodies && candidates.length > 0) {
			const [id, value] = candidates.shift()!;
			this.loaded.delete(id);
			this.activeLineageByDocument.delete(value.documentId);
			crdtEngine.destroyDocument(value.doc);
			crdtEngine.destroyDocument(value.validationDoc);
			count--;
		}
		return count < this.limits.loadedBodies;
	}

	queue(
		documentId: string,
		entry: PendingVaultUpdate,
	): { ok: true } | { ok: false; reason: CachePressureReason } {
		const bytes = entry.bytes.byteLength;
		const lineageKey = this.lineageKey(
			documentId,
			entry.documentEpoch ?? this.get(documentId)?.semanticEpoch
				?? this.store.documentHead(documentId)?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH,
		);
		const documentBytes = this.pendingBytesForDocument(documentId);
		const socketBytes = this.pendingBytesBySocket.get(entry.socketId) ?? 0;
		if (documentBytes + bytes > MAX_PENDING_BYTES_PER_DOCUMENT) return { ok: false, reason: "document_pending_bytes" };
		if (socketBytes + bytes > MAX_PENDING_BYTES_PER_SOCKET) return { ok: false, reason: "socket_pending_bytes" };
		if (this.pendingBytesTotal + bytes > MAX_PENDING_BYTES_PER_VAULT) return { ok: false, reason: "vault_pending_bytes" };
		if (this.transientBytesTotal() + bytes > this.limits.transientBytes) return { ok: false, reason: "vault_transient_bytes" };
		const pending = this.pending.get(lineageKey) ?? [];
		pending.push(entry);
		this.pending.set(lineageKey, pending);
		this.pendingBytesByDocument.set(lineageKey,
			(this.pendingBytesByDocument.get(lineageKey) ?? 0) + bytes);
		this.pendingBytesBySocket.set(entry.socketId, socketBytes + bytes);
		this.pendingBytesTotal += bytes;
		const loaded = this.get(documentId);
		if (loaded) {
			loaded.dirty = true;
			loaded.transientBytes = this.documentTransientBytes(documentId);
		}
		return { ok: true };
	}

	pendingFor(documentId: string): readonly PendingVaultUpdate[] {
		return this.pendingEntries(documentId);
	}

	takePending(documentId: string): PendingVaultUpdate[] {
		const key = this.currentLineageKey(documentId);
		const entries = this.pending.get(key) ?? [];
		this.pending.delete(key);
		for (const entry of entries) this.releasePendingBytes(
			key, documentId, entry.socketId, entry.bytes.byteLength,
		);
		const loaded = this.get(documentId);
		if (loaded) {
			// Remain dirty until the caller confirms the detached batch committed.
			// This prevents live checkpointing while persistence is in flight.
			loaded.dirty = entries.length > 0 || this.hasPending(documentId);
			loaded.transientBytes = this.documentTransientBytes(documentId);
		}
		return entries;
	}

	completePendingPersistence(documentId: string): void {
		const loaded = this.get(documentId);
		if (!loaded) return;
		loaded.dirty = this.hasPending(documentId);
		loaded.transientBytes = this.documentTransientBytes(documentId);
	}

	restorePending(documentId: string, entries: PendingVaultUpdate[]): void {
		for (const entry of entries) {
			const result = this.queue(documentId, entry);
			if (!result.ok) throw new Error(`could not restore pending update: ${result.reason}`);
		}
	}

	removePendingDigest(documentId: string, digest: string): void {
		const key = this.currentLineageKey(documentId);
		const entries = this.pending.get(key) ?? [];
		const keep: PendingVaultUpdate[] = [];
		for (const entry of entries) {
			if (entry.digest === digest) this.releasePendingBytes(
				key, documentId, entry.socketId, entry.bytes.byteLength,
			);
			else keep.push(entry);
		}
		if (keep.length === 0) this.pending.delete(key);
		else this.pending.set(key, keep);
		const loaded = this.get(documentId);
		if (loaded) {
			loaded.dirty = this.hasPending(documentId);
			loaded.transientBytes = this.documentTransientBytes(documentId);
		}
	}

	validateBodyUpdate(documentId: string, update: Uint8Array | readonly Uint8Array[]): ValidatedBodyUpdate {
		const updates = boundedCandidateFrames(update);
		const inputBytes = updates.reduce((sum, frame) => sum + frame.byteLength, 0);
		const loaded = this.get(documentId);
		if (!loaded || loaded.kind !== "body") throw new Error("body validation requires a loaded Markdown body");
		if (loaded.validationPending) throw new Error("body validation already has a staged update");
		// Reserve enough to throw away and exactly rebuild the private mirror if
		// this untrusted update is malformed. Admission failure happens before the
		// mirror is touched; incoming bytes are deliberately not the estimate.
		const hadSpeculativeDurability = loaded.dirty || this.hasPending(documentId);
		const releaseTransient = this.reserveFullStateOperation(
			documentId, 2, this.safeAdd(this.stateSizeEstimate(documentId), inputBytes),
		);
		try {
			let changesState = false;
			try {
				changesState = applyManyAndDetect(loaded.validationDoc, updates, "persistent-validation");
			} catch {
				this.rebuildValidation(loaded, documentId);
				throw new VaultDocumentValidationError("invalid_yjs_update");
			}
			try {
				const semanticError = validateFrontmatterSemanticRoots(loaded.validationDoc);
				if (semanticError) throw new VaultDocumentValidationError(semanticError);
				const content = crdtEngine.readText(loaded.validationDoc, "body");
				if (content !== canonicalizeMarkdown(content)) {
					throw new VaultDocumentValidationError("candidate_markdown_not_canonical");
				}
				const contentBytes = canonicalMarkdownBytes(content);
				if (contentBytes.byteLength > MAX_CLIENT_MARKDOWN_BYTES) {
					throw new VaultDocumentValidationError("markdown_size_limit");
				}
				loaded.validationPending = true;
				loaded.validationUpdatesSinceExact++;
				loaded.validationInputBytesSinceExact += inputBytes;
				const exact = loaded.validationUpdatesSinceExact >= VALIDATION_EXACT_EVERY
					|| loaded.validationInputBytesSinceExact >= VALIDATION_EXACT_INPUT_BYTES;
				// Between exact samples this is deliberately an operational proxy, not
				// a proof about Yjs encoding size. The multiplier supplies cache headroom;
				// row admission relies only on the exact wire byte length.
				const measuredBytes = exact
					? crdtEngine.encodeStateAsUpdate(loaded.validationDoc).byteLength
					: loaded.validationLastExactEncodedBytes + (2 * loaded.validationInputBytesSinceExact)
						+ (64 * loaded.validationUpdatesSinceExact);
				// This periodic/proxy census is observability for residency and semantic
				// compaction. It is deliberately not an admission proof: only the exact
				// wire/content bounds and pre-apply transient reservation may reject here.
				loaded.validationEncodedStateBytes = measuredBytes;
				return {
					changesState,
					requiresDurableCommit: changesState || hadSpeculativeDurability,
					contentBytes,
					encodedStateBytes: measuredBytes,
					exactEncodedStateBytes: exact,
				};
			} catch (error) {
				this.rebuildValidation(loaded, documentId);
				throw error;
			}
		} finally {
			releaseTransient();
		}
	}

	async validateCanvasUpdate(documentId: string, update: Uint8Array): Promise<ValidatedBodyUpdate> {
		const loaded = this.get(documentId);
		if (!loaded || loaded.kind !== "canvas") throw new Error("Canvas validation requires a loaded Canvas document");
		if (loaded.validationPending) throw new Error("Canvas validation already has a staged update");
		const hadSpeculativeDurability = loaded.dirty || this.hasPending(documentId);
		const releaseTransient = this.reserveFullStateOperation(
			documentId, 2, this.safeAdd(this.stateSizeEstimate(documentId), update.byteLength),
		);
		try {
			let changesState = false;
			try {
				changesState = applyAndDetect(loaded.validationDoc, update, "persistent-canvas-validation");
			} catch {
				this.rebuildValidation(loaded, documentId);
				throw new VaultDocumentValidationError("invalid_canvas_update");
			}
			try {
				const validation = await validateCanvasDocument(loaded.validationDoc);
				if (validation.error !== null) throw new VaultDocumentValidationError(validation.error);
				const contentBytes = validation.canonicalBytes;
				loaded.validationPending = true;
				loaded.validationUpdatesSinceExact++;
				loaded.validationInputBytesSinceExact += update.byteLength;
				const exact = loaded.validationUpdatesSinceExact >= VALIDATION_EXACT_EVERY
					|| loaded.validationInputBytesSinceExact >= VALIDATION_EXACT_INPUT_BYTES;
				const measuredBytes = exact
					? crdtEngine.encodeStateAsUpdate(loaded.validationDoc).byteLength
					: loaded.validationLastExactEncodedBytes + (2 * loaded.validationInputBytesSinceExact)
						+ (64 * loaded.validationUpdatesSinceExact);
				// See Markdown validation above: the proxy schedules pressure work but
				// cannot reject an otherwise bounded and semantically valid update.
				loaded.validationEncodedStateBytes = measuredBytes;
				return {
					changesState,
					requiresDurableCommit: changesState || hadSpeculativeDurability,
					contentBytes,
					encodedStateBytes: measuredBytes,
					exactEncodedStateBytes: exact,
				};
			} catch (error) {
				this.rebuildValidation(loaded, documentId);
				throw error;
			}
		} finally {
			releaseTransient();
		}
	}

	commitValidatedBodyUpdate(
		documentId: string,
		update: Uint8Array | readonly Uint8Array[],
		generation: number,
		semanticEpoch: SemanticEpoch,
		origin: unknown,
		validated: ValidatedBodyUpdate,
	): boolean {
		const updates = boundedCandidateFrames(update);
		const loaded = this.get(documentId);
		if (!loaded || !loaded.validationPending) throw new Error("body update was not validated");
		let changed = false;
		try {
			changed = applyManyAndDetect(loaded.doc, updates.map((frame) => frame.slice()), String(origin));
		} catch {
			// The receipt/journal commit precedes this resident application. An
			// exceptional local apply failure must not leave the old durable view in
			// RAM; publish the accepted update and reconstruct on next admission.
			this.discardResident(documentId);
			return true;
		}
		loaded.generation = Math.max(loaded.generation, generation);
		loaded.semanticEpoch = semanticEpoch;
		loaded.lastUsedAt = Date.now();
		loaded.encodedStateBytes = validated.encodedStateBytes;
		loaded.validationEncodedStateBytes = validated.encodedStateBytes;
		loaded.validationPending = false;
		if (validated.exactEncodedStateBytes) {
			loaded.validationLastExactEncodedBytes = validated.encodedStateBytes;
			loaded.validationUpdatesSinceExact = 0;
			loaded.validationInputBytesSinceExact = 0;
		}
		return changed;
	}

	/**
	 * Accepts one validated socket frame into the speculative mirror only.
	 * The authoritative document is advanced later, after SQLite commits the
	 * corresponding pending batch.
	 */
	stageValidatedBodyUpdate(documentId: string, validated: ValidatedBodyUpdate): boolean {
		const loaded = this.get(documentId);
		if (!loaded || !loaded.validationPending) throw new Error("body update was not validated");
		loaded.validationEncodedStateBytes = validated.encodedStateBytes;
		loaded.validationPending = false;
		if (validated.exactEncodedStateBytes) {
			loaded.validationLastExactEncodedBytes = validated.encodedStateBytes;
			loaded.validationUpdatesSinceExact = 0;
			loaded.validationInputBytesSinceExact = 0;
		}
		return validated.changesState;
	}

	discardValidatedBodyUpdate(documentId: string): void {
		const loaded = this.get(documentId);
		if (!loaded?.validationPending) return;
		const releaseTransient = this.reserveFullStateOperation(documentId, 2);
		try { this.rebuildValidation(loaded, documentId); }
		finally { releaseTransient(); }
	}

	/**
	 * Root sockets are replication outputs, but Yjs peers answer the handshake
	 * with their locally persisted root state. Prove that frame is already
	 * represented by applying it only to the private mirror. A real mutation or
	 * malformed frame poisons no authority and exceptionally rebuilds the mirror.
	 */
	validateRootSyncNoop(documentId: string, update: Uint8Array): boolean {
		const loaded = this.get(documentId);
		if (!loaded || loaded.kind !== "root") throw new Error("root sync validation requires a loaded root");
		if (loaded.validationPending) throw new Error("root validation mirror is busy");
		const releaseTransient = this.reserveFullStateOperation(
			documentId, 2, this.safeAdd(this.stateSizeEstimate(documentId), update.byteLength),
		);
		try {
			const changed = applyAndDetect(loaded.validationDoc, update, "root-sync-validation");
			if (!changed) return true;
			this.rebuildValidation(loaded, documentId);
			return false;
		} catch {
			this.rebuildValidation(loaded, documentId);
			return false;
		} finally {
			releaseTransient();
		}
	}

	/** Exceptional recovery: replace both resident documents from exact durability. */
	reloadFromDurable(documentId: string): void {
		const loaded = this.get(documentId);
		if (!loaded) return;
		const releaseTransient = this.reserveFullStateOperation(documentId, 3);
		let reconstructed: ReconstructedDocument | null = null;
		try {
			reconstructed = this.store.reconstructDocument(documentId);
			const encoded = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
			if (documentId !== "root") {
				const reason = this.ensureBodyCapacity(documentId, this.mirroredResidentCost(encoded.byteLength));
				if (reason) throw new VaultDocumentCachePressureError(reason);
			}
			const validationDoc = crdtEngine.createDocument(`${documentId}-validation`);
			crdtEngine.applyUpdate(validationDoc, encoded, "durable-reload-validation");
			crdtEngine.destroyDocument(loaded.doc);
			crdtEngine.destroyDocument(loaded.validationDoc);
			this.loaded.delete(loaded.lineageKey);
			loaded.doc = reconstructed.doc;
			reconstructed = null;
			loaded.validationDoc = validationDoc;
			loaded.generation = this.store.documentHead(documentId)?.generation ?? loaded.generation;
			loaded.semanticEpoch = this.store.documentHead(documentId)?.semanticEpoch ?? loaded.semanticEpoch;
			loaded.lineageKey = this.lineageKey(documentId, loaded.semanticEpoch);
			this.retirePendingLineages(documentId, loaded.lineageKey);
			loaded.dirty = this.hasPending(documentId);
			loaded.encodedStateBytes = encoded.byteLength;
			loaded.validationEncodedStateBytes = encoded.byteLength;
			loaded.validationLastExactEncodedBytes = encoded.byteLength;
			loaded.validationUpdatesSinceExact = 0;
			loaded.validationInputBytesSinceExact = 0;
			loaded.validationPending = false;
			loaded.lastUsedAt = Date.now();
			loaded.transientBytes = this.documentTransientBytes(documentId);
			this.loaded.set(loaded.lineageKey, loaded);
			this.activeLineageByDocument.set(documentId, loaded.lineageKey);
		} finally {
			if (reconstructed) crdtEngine.destroyDocument(reconstructed.doc);
			releaseTransient();
		}
	}

	/** Drops any resident authority, including root, so the next use reloads exact durability. */
	discardResident(documentId: string): void {
		const loaded = this.get(documentId);
		if (!loaded) return;
		this.loaded.delete(loaded.lineageKey);
		this.activeLineageByDocument.delete(documentId);
		crdtEngine.destroyDocument(loaded.doc);
		crdtEngine.destroyDocument(loaded.validationDoc);
	}

	installSemanticReset(documentId: string, document: YwasmCrdtDocument, generation: number, semanticEpoch: SemanticEpoch): void {
		const loaded = this.get(documentId);
		if (!loaded) {
			crdtEngine.destroyDocument(document);
			return;
		}
		if (loaded.dirty || loaded.validationPending || this.hasPendingAnyLineage(documentId)) {
			crdtEngine.destroyDocument(document);
			throw new Error("semantic reset requires a clean resident document");
		}
		const encoded = crdtEngine.encodeStateAsUpdate(document);
		if (documentId !== "root") {
			const reason = this.ensureBodyCapacity(documentId, this.mirroredResidentCost(encoded.byteLength));
			if (reason) {
				crdtEngine.destroyDocument(document);
				throw new VaultDocumentCachePressureError(reason);
			}
		}
		const validationDoc = crdtEngine.createDocument(`${documentId}-validation`);
		try { crdtEngine.applyUpdate(validationDoc, encoded, "semantic-reset-validation"); }
		catch (error) {
			crdtEngine.destroyDocument(validationDoc);
			throw error;
		}
		crdtEngine.destroyDocument(loaded.doc);
		crdtEngine.destroyDocument(loaded.validationDoc);
		this.loaded.delete(loaded.lineageKey);
		loaded.doc = document;
		loaded.validationDoc = validationDoc;
		loaded.generation = generation;
		loaded.semanticEpoch = semanticEpoch;
		loaded.lineageKey = this.lineageKey(documentId, semanticEpoch);
		loaded.encodedStateBytes = encoded.byteLength;
		loaded.validationEncodedStateBytes = encoded.byteLength;
		loaded.validationLastExactEncodedBytes = encoded.byteLength;
		loaded.validationUpdatesSinceExact = 0;
		loaded.validationInputBytesSinceExact = 0;
		loaded.validationPending = false;
		loaded.lastUsedAt = Date.now();
		this.loaded.set(loaded.lineageKey, loaded);
		this.activeLineageByDocument.set(documentId, loaded.lineageKey);
	}

	applyDurableUpdate(documentId: string, update: Uint8Array, generation: number, origin: unknown): boolean {
		const loaded = this.get(documentId);
		if (!loaded) return false;
		if (loaded.validationPending) throw new Error("cannot apply an external durable update over staged validation");
		let releaseTransient: () => void;
		try {
			releaseTransient = this.reserveFullStateOperation(
				documentId, 2, this.safeAdd(this.stateSizeEstimate(documentId), update.byteLength),
			);
		} catch (error) {
			if (!(error instanceof VaultDocumentCachePressureError)) throw error;
			// Durability has already won at every caller of this method. If there is
			// not enough headroom to advance and re-encode both resident mirrors,
			// discard the stale cache entry and let the caller publish the exact
			// durable update. The next admission reconstructs from SQLite.
			this.discardResident(documentId);
			return true;
		}
		try {
		let changed = false;
		try {
			changed = applyAndDetect(loaded.doc, update, String(origin));
			crdtEngine.applyUpdate(loaded.validationDoc, update, "durable-validation-sync");
		} catch (error) {
			this.discardResident(documentId);
			throw error;
		}
		loaded.generation = Math.max(loaded.generation, generation);
		loaded.lastUsedAt = Date.now();
		loaded.encodedStateBytes = crdtEngine.encodeStateAsUpdate(loaded.doc).byteLength;
		loaded.validationEncodedStateBytes = crdtEngine.encodeStateAsUpdate(loaded.validationDoc).byteLength;
		if (documentId !== "root") {
			// The update is already durable and therefore cannot be rejected here.
			// Evict clean peers where possible; any remaining overage is surfaced as
			// memory pressure so admission is fenced until semantic compaction runs.
			this.ensureBodyCapacity(documentId, this.mirroredResidentCost(loaded.encodedStateBytes));
		}
		loaded.validationLastExactEncodedBytes = loaded.validationEncodedStateBytes;
		loaded.validationUpdatesSinceExact = 0;
		loaded.validationInputBytesSinceExact = 0;
		return changed;
		} finally {
			releaseTransient();
		}
	}

	/**
	 * Advances the authoritative mirror after a socket batch becomes durable.
	 * Socket admission already applied every frame to validationDoc, so applying
	 * the merged batch there again would only repeat work across the Wasm FFI.
	 */
	applyStagedDurableUpdate(documentId: string, update: Uint8Array, generation: number, origin: unknown): boolean {
		const loaded = this.get(documentId);
		if (!loaded) return false;
		if (loaded.validationPending) throw new Error("cannot commit while validation is in progress");
		let releaseTransient: () => void;
		try {
			releaseTransient = this.reserveFullStateOperation(
				documentId, 1, this.safeAdd(this.stateSizeEstimate(documentId), update.byteLength),
			);
		} catch (error) {
			if (!(error instanceof VaultDocumentCachePressureError)) throw error;
			this.discardResident(documentId);
			return true;
		}
		try {
			let changed: boolean;
			try {
				changed = applyAndDetect(loaded.doc, update, String(origin));
			} catch (error) {
				this.discardResident(documentId);
				throw error;
			}
			loaded.generation = Math.max(loaded.generation, generation);
			loaded.lastUsedAt = Date.now();
			// validationDoc represents the end of the detached queue. During a
			// partitioned flush this may temporarily overestimate doc, but cannot
			// undercount resident state and is exact once the final partition lands.
			loaded.encodedStateBytes = loaded.validationEncodedStateBytes;
			if (documentId !== "root") {
				this.ensureBodyCapacity(documentId, this.mirroredResidentCost(loaded.validationEncodedStateBytes));
			}
			return changed;
		} finally {
			releaseTransient();
		}
	}

	/**
	 * Reserves operational headroom for complete-state allocations. The durable
	 * byte total and cached encoded size are estimates, not hard Yjs bounds, so
	 * the estimate is doubled before charging the expected overlapping copies.
	 */
	reserveFullStateOperation(documentId: string, overlappingCopies: number, knownStateBytes?: number): () => void {
		if (!Number.isSafeInteger(overlappingCopies) || overlappingCopies < 1) {
			throw new Error("full-state copy count must be a positive safe integer");
		}
		const estimate = knownStateBytes ?? this.stateSizeEstimate(documentId);
		if (!Number.isSafeInteger(estimate) || estimate < 0) throw new Error("full-state estimate must be a non-negative safe integer");
		const withUncertainty = this.safeMultiply(Math.max(estimate, 1), 2);
		return this.recordTransient(documentId, this.safeMultiply(withUncertainty, overlappingCopies));
	}

	/** Pressure signal consumed by semantic-compaction scheduling. */
	hasResidentMemoryPressure(documentId: string): boolean {
		const loaded = this.get(documentId);
		if (!loaded) return false;
		if (documentId === "root") return this.residentCost(loaded) > this.limits.rootEncodedStateBytes;
		return this.loadedBodyResidentEncodedStateBytes() >= this.limits.encodedStateBytes;
	}

	recordTransient(documentId: string, bytes: number): () => void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("transient reservation must be a non-negative safe integer");
		const memory = crdtEngine.memoryDiagnostics();
		if (memory && this.safeAdd(
			this.safeAdd(memory.linearMemoryBytes, this.transientReservationsTotal),
			this.safeAdd(bytes, YWASM_LINEAR_MEMORY_SAFETY_MARGIN),
		) > memory.maximumLinearMemoryBytes) {
			throw new VaultDocumentCachePressureError("wasm_linear_memory_envelope");
		}
		if (this.transientBytesTotal() + bytes > this.limits.transientBytes) {
			throw new VaultDocumentCachePressureError("vault_transient_bytes");
		}
		const lineageKey = this.currentLineageKey(documentId);
		this.transientReservationsTotal += bytes;
		this.transientReservationsByDocument.set(
			lineageKey,
			(this.transientReservationsByDocument.get(lineageKey) ?? 0) + bytes,
		);
		this.refreshDocumentTransientBytes(documentId);
		const reservationEpoch = this.reservationEpoch;
		let released = false;
		return () => {
			if (released || reservationEpoch !== this.reservationEpoch) return;
			released = true;
			const current = this.transientReservationsByDocument.get(lineageKey) ?? 0;
			const releasedBytes = Math.min(bytes, current);
			const remaining = current - releasedBytes;
			if (remaining === 0) this.transientReservationsByDocument.delete(lineageKey);
			else this.transientReservationsByDocument.set(lineageKey, remaining);
			this.transientReservationsTotal -= releasedBytes;
			this.refreshDocumentTransientBytes(documentId);
		};
	}

	evict(documentId: string): boolean {
		if (documentId === "root" || this.hasPending(documentId)) return false;
		const loaded = this.get(documentId);
		if (!loaded || loaded.dirty || this.openBodyIds().has(documentId) || this.pinnedBodyIds().has(documentId)) return false;
		this.loaded.delete(loaded.lineageKey);
		this.activeLineageByDocument.delete(documentId);
		crdtEngine.destroyDocument(loaded.doc);
		crdtEngine.destroyDocument(loaded.validationDoc);
		return true;
	}

	clear(): void {
		for (const loaded of this.loaded.values()) {
			crdtEngine.destroyDocument(loaded.doc);
			crdtEngine.destroyDocument(loaded.validationDoc);
		}
		this.loaded.clear();
		this.activeLineageByDocument.clear();
		this.pending.clear();
		this.pendingBytesByDocument.clear();
		this.pendingBytesBySocket.clear();
		this.transientReservationsByDocument.clear();
		this.loadFailures.clear();
		this.pendingBytesTotal = 0;
		this.transientReservationsTotal = 0;
		this.reservationEpoch++;
		this.documentLanes.clear();
	}

	diagnostics(): VaultDocumentCacheDiagnostics {
		let bodyEncodedStateBytes = 0;
		let rootEncodedStateBytes = 0;
		const loaded = [...this.loaded.values()].map((value) => {
			const documentId = value.documentId;
			const residentEncodedStateBytes = this.residentCost(value);
			if (documentId === "root") rootEncodedStateBytes += residentEncodedStateBytes;
			else bodyEncodedStateBytes += residentEncodedStateBytes;
			const transientBytes = this.documentTransientBytes(documentId);
			return {
				documentId,
				lineageKey: value.lineageKey,
				kind: value.kind,
				generation: value.generation,
				semanticEpoch: value.semanticEpoch,
				dirty: value.dirty,
				lastUsedAt: value.lastUsedAt,
				encodedStateBytes: value.encodedStateBytes,
				validationEncodedStateBytes: value.validationEncodedStateBytes,
				residentEncodedStateBytes,
				transientBytes,
				memoryPressure: this.hasResidentMemoryPressure(documentId),
			};
		});
		return {
			loaded,
			accounting: {
				formatVersion: 1,
				claim: "encoded-crdt-state-proxy-plus-wasm-linear-memory",
			},
			crdtMemory: crdtEngine.memoryDiagnostics(),
			costs: {
				encodedStateBytes: this.safeAdd(bodyEncodedStateBytes, rootEncodedStateBytes),
				bodyEncodedStateBytes,
				rootEncodedStateBytes,
				transientBytes: this.transientBytesTotal(),
			},
			limits: { ...this.limits },
			pending: this.pendingCountDiagnostics(),
			pendingByLineage: Object.fromEntries([...this.pending].map(([id, values]) => [id, values.length])),
			pendingBytes: {
				total: this.pendingBytesTotal,
				byDocument: this.pendingByteDiagnostics(),
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

	documentKind(documentId: string): VaultDocumentKind {
		const loaded = this.get(documentId);
		if (loaded) return loaded.kind;
		if (documentId === "root") return "root";
		const store = this.store as VaultStore & {
			currentSequence?: () => number;
			semanticHeadAt?: (sequence: number, id: string) => unknown;
		};
		return typeof store.currentSequence === "function" && typeof store.semanticHeadAt === "function"
			&& store.semanticHeadAt(store.currentSequence(), documentId) ? "canvas" : "body";
	}

	private loadedBodyCount(): number {
		let count = 0;
		for (const value of this.loaded.values()) if (value.documentId !== "root") count++;
		return count;
	}

	private ensureBodyCapacity(documentId: string, incomingBytes: number): CachePressureReason | null {
		if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) throw new Error("body encoded-state bytes must be a non-negative safe integer");
		const existing = this.get(documentId);
		const replacingBytes = existing ? this.residentCost(existing) : 0;
		const additionalCount = existing ? 0 : 1;
		const candidates = this.cleanBodyCandidates(documentId);
		let count = this.loadedBodyCount();
		let encodedStateBytes = this.loadedBodyResidentEncodedStateBytes() - replacingBytes;
		while (
			(count + additionalCount > this.limits.loadedBodies
				|| encodedStateBytes + incomingBytes > this.limits.encodedStateBytes)
			&& candidates.length > 0
		) {
			const [id, value] = candidates.shift()!;
			this.loaded.delete(id);
			this.activeLineageByDocument.delete(value.documentId);
			encodedStateBytes -= this.residentCost(value);
			count--;
			crdtEngine.destroyDocument(value.doc);
			crdtEngine.destroyDocument(value.validationDoc);
		}
		if (count + additionalCount > this.limits.loadedBodies) return "body_cache_count";
		if (encodedStateBytes + incomingBytes > this.limits.encodedStateBytes) return "body_cache_encoded_state_bytes";
		return null;
	}

	private cleanBodyCandidates(excludingDocumentId: string): Array<[string, LoadedVaultDocument]> {
		const open = this.openBodyIds();
		const pinned = this.pinnedBodyIds();
		return [...this.loaded.entries()]
			.filter(([, value]) => value.documentId !== "root" && value.documentId !== excludingDocumentId && !value.dirty
				&& !this.hasPending(value.documentId) && !open.has(value.documentId) && !pinned.has(value.documentId))
			.sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
	}

	private durableStateCost(documentId: string): number {
		const head = this.store.documentHead(documentId);
		return head ? this.store.documentEncodedHistoryBytes(documentId, head.latestSequence) : 0;
	}

	private loadedBodyResidentEncodedStateBytes(): number {
		let bytes = 0;
		for (const loaded of this.loaded.values()) if (loaded.documentId !== "root") bytes += this.residentCost(loaded);
		return bytes;
	}

	private residentCost(loaded: LoadedVaultDocument): number {
		return this.safeAdd(loaded.encodedStateBytes, loaded.validationEncodedStateBytes);
	}

	private mirroredResidentCost(encodedStateBytes: number): number {
		return this.safeMultiply(encodedStateBytes, 2);
	}

	private stateSizeEstimate(documentId: string): number {
		const loaded = this.get(documentId);
		if (loaded) return Math.max(loaded.encodedStateBytes, loaded.validationEncodedStateBytes);
		return this.durableStateCost(documentId);
	}

	private safeAdd(left: number, right: number): number {
		return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
	}

	private safeMultiply(value: number, multiplier: number): number {
		return value > Math.floor(Number.MAX_SAFE_INTEGER / multiplier)
			? Number.MAX_SAFE_INTEGER
			: value * multiplier;
	}

	private transientBytesTotal(): number {
		return this.pendingBytesTotal + this.transientReservationsTotal;
	}

	private documentTransientBytes(documentId: string): number {
		let bytes = 0;
		for (const [key, value] of this.pendingBytesByDocument) if (this.belongsToDocument(key, documentId)) bytes += value;
		for (const [key, value] of this.transientReservationsByDocument) if (this.belongsToDocument(key, documentId)) bytes += value;
		return bytes;
	}

	private refreshDocumentTransientBytes(documentId: string): void {
		const loaded = this.get(documentId);
		if (loaded) loaded.transientBytes = this.documentTransientBytes(documentId);
	}

	private rebuildValidation(loaded: LoadedVaultDocument, documentId: string): void {
		crdtEngine.destroyDocument(loaded.validationDoc);
		loaded.validationDoc = crdtEngine.createDocument(`${documentId}-validation`);
		const encoded = crdtEngine.encodeStateAsUpdate(loaded.doc);
		crdtEngine.applyUpdate(loaded.validationDoc, encoded, "validation-rebuild");
		for (const entry of this.pendingEntries(documentId)) {
			crdtEngine.applyUpdate(loaded.validationDoc, entry.bytes, "validation-rebuild-pending");
		}
		loaded.encodedStateBytes = encoded.byteLength;
		const validationBytes = crdtEngine.encodeStateAsUpdate(loaded.validationDoc).byteLength;
		loaded.validationEncodedStateBytes = validationBytes;
		loaded.validationLastExactEncodedBytes = validationBytes;
		loaded.validationPending = false;
		loaded.validationUpdatesSinceExact = 0;
		loaded.validationInputBytesSinceExact = 0;
	}

	private lineageKey(documentId: string, epoch: SemanticEpoch): string {
		return `${documentId}@epoch:${epoch}`;
	}

	private belongsToDocument(lineageKey: string, documentId: string): boolean {
		return lineageKey.startsWith(`${documentId}@epoch:`);
	}

	private documentIdFromLineage(lineageKey: string): string {
		const marker = lineageKey.lastIndexOf("@epoch:");
		if (marker <= 0) throw new Error("invalid cache lineage key");
		return lineageKey.slice(0, marker);
	}

	private currentLineageKey(documentId: string): string {
		const loaded = this.get(documentId);
		if (loaded) return loaded.lineageKey;
		// Reservations can precede document admission (for example bootstrap reads).
		// Their accounting must not add a storage read—or make a memory guard depend
		// on SQLite availability. Once admitted, the exact epoch replaces this
		// provisional initial-lineage label.
		return this.lineageKey(documentId, INITIAL_SEMANTIC_EPOCH);
	}

	private clearLoadFailures(documentId: string): void {
		for (const key of this.loadFailures.keys()) {
			if (this.belongsToDocument(key, documentId)) this.loadFailures.delete(key);
		}
	}

	private pendingEntries(documentId: string): PendingVaultUpdate[] {
		return this.pending.get(this.currentLineageKey(documentId)) ?? [];
	}

	private hasPending(documentId: string): boolean {
		return this.pendingEntries(documentId).length > 0;
	}

	private hasPendingAnyLineage(documentId: string): boolean {
		for (const [key, values] of this.pending) {
			if (values.length > 0 && this.belongsToDocument(key, documentId)) return true;
		}
		return false;
	}

	/** Old CRDT updates can never be interpreted against a fresh semantic epoch. */
	private retirePendingLineages(documentId: string, keepLineageKey: string): void {
		for (const [key, entries] of [...this.pending]) {
			if (key === keepLineageKey || !this.belongsToDocument(key, documentId)) continue;
			this.pending.delete(key);
			for (const entry of entries) this.releasePendingBytes(
				key, documentId, entry.socketId, entry.bytes.byteLength,
			);
		}
	}

	private pendingBytesForDocument(documentId: string): number {
		let bytes = 0;
		for (const [key, value] of this.pendingBytesByDocument) {
			if (this.belongsToDocument(key, documentId)) bytes += value;
		}
		return bytes;
	}

	private pendingCountDiagnostics(): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [key, values] of this.pending) {
			const documentId = this.documentIdFromLineage(key);
			result[documentId] = (result[documentId] ?? 0) + values.length;
		}
		return result;
	}

	private pendingByteDiagnostics(): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [key, bytes] of this.pendingBytesByDocument) {
			const documentId = this.documentIdFromLineage(key);
			result[documentId] = (result[documentId] ?? 0) + bytes;
		}
		return result;
	}

	private releasePendingBytes(lineageKey: string, documentId: string, socketId: string, bytes: number): void {
		this.pendingBytesTotal = Math.max(0, this.pendingBytesTotal - bytes);
		const documentBytes = Math.max(0, (this.pendingBytesByDocument.get(lineageKey) ?? 0) - bytes);
		const socketBytes = Math.max(0, (this.pendingBytesBySocket.get(socketId) ?? 0) - bytes);
		if (documentBytes === 0) this.pendingBytesByDocument.delete(lineageKey);
		else this.pendingBytesByDocument.set(lineageKey, documentBytes);
		if (socketBytes === 0) this.pendingBytesBySocket.delete(socketId);
		else this.pendingBytesBySocket.set(socketId, socketBytes);
		this.refreshDocumentTransientBytes(documentId);
	}
}
