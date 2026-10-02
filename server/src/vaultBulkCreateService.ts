// Write-budget spike W2 (experiments/PHASE3-WRITE-BUDGET-SPIKE.md D2/D3/D5/D6):
// `POST /lifecycle/create-bulk` is the only Markdown create path. One request
// is one SQLite transaction: per file a finished snapshot + body head +
// catalog event, per batch one root update / sequence / attribution / receipt.
// Attachment upserts for unoccupied paths ride in the same batch (D6).
import type { CrdtRootOperation } from "./crdt/crdtEngine";
import { mapValue, snapshotRootMaps } from "./crdt/rootSchema";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { validateFrontmatterSemanticRoots } from "./crdt/frontmatterSemanticValidation";
import { MAX_BLOB_UPLOAD_BYTES } from "./contracts";
import { canonicalJsonText } from "./recoveryCanonicalJson";
import { BoundedBodyError, readBoundedBytes } from "./readBoundedBytes";
import { candidateDigestMaterial } from "./shared/candidateDigest";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "./shared/binaryEnvelope";
import {
	MAX_CANDIDATE_UPDATE_BYTES,
	MAX_CANDIDATE_UPDATE_FRAMES,
	MAX_CLIENT_MARKDOWN_BYTES,
	MAX_DURABLE_UPDATE_BYTES,
} from "./shared/durableLimits";
import { canonicalMarkdownBytes, canonicalizeMarkdown } from "./shared/markdownCodec";
import { INITIAL_SEMANTIC_EPOCH, SemanticEpochMismatchError, parseSemanticEpoch, type SemanticEpoch } from "./shared/semanticEpoch";
import { safeBlobPath, safeMarkdownPath } from "./shared/vaultPath";
import type { VaultActorContext } from "./collaboration";
import { VaultDocumentCachePressureError, type VaultDocumentCache } from "./vaultDocumentCache";
import { SQLITE_BLOB_CHUNK_BYTES, sha256HexSync as sha256HexSyncOf } from "./vaultDocumentStore";
import type { VaultSocketService } from "./vaultSocketService";
import type { BulkCreateAttachmentWrite, BulkCreateFileWrite, VaultStore } from "./vaultStore";
import { BULK_CREATE_DEFAULT_MAX_BYTES, BULK_CREATE_DEFAULT_MAX_ITEMS, type BulkCreateLimits } from "./relayFlag";

/** Default (and maximum) count cap per request (files + attachments); `YAOS_BULK_CREATE_MAX_ITEMS` lowers it. */
export const BULK_CREATE_MAX_ITEMS = BULK_CREATE_DEFAULT_MAX_ITEMS;
/**
 * Byte cap per request over all file update frames. A batch of exactly one
 * file may instead use the full per-note candidate ceiling, so a single note
 * larger than 4 MB (up to the 5 MiB Markdown limit) is still creatable.
 */
export const BULK_CREATE_MAX_BYTES = BULK_CREATE_DEFAULT_MAX_BYTES;
export const BULK_CREATE_SINGLE_FILE_MAX_BYTES = MAX_CANDIDATE_UPDATE_BYTES;
const ENVELOPE_OVERHEAD_BYTES = 512 * 1024;
export const BULK_CREATE_MAX_REQUEST_BYTES = Math.max(BULK_CREATE_MAX_BYTES, BULK_CREATE_SINGLE_FILE_MAX_BYTES) + ENVELOPE_OVERHEAD_BYTES;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Existing relay bodies with no recorded hash are reconstructed to compare; bounded per request. */
const MAX_IDENTITY_RECONSTRUCTIONS = 32;
const MAX_IDENTITY_LENGTH = 256;

export type BulkCreateOutcomeKind = "created" | "exists-identical" | "exists-different" | "rejected";

export interface BulkCreateOutcome {
	kind: "file" | "attachment";
	operationId: string;
	path: string;
	outcome: BulkCreateOutcomeKind;
	bodyId?: string;
	reason?: string;
	existingBodyId?: string;
	existingRevision?: string;
	contentHash?: string;
	size?: number;
}

interface ParsedFile {
	operationId: string;
	bodyId: string;
	path: string;
	updates: Uint8Array[];
}

interface ParsedAttachment {
	operationId: string;
	path: string;
	hash: string;
	size: number;
	mime: string;
}

interface ParsedRequest {
	batchId: string;
	rootEpoch: SemanticEpoch;
	rootStateVector: Uint8Array | null;
	files: ParsedFile[];
	attachments: ParsedAttachment[];
}

interface PreparedFile extends BulkCreateFileWrite {
	operationId: string;
}

interface BulkCreateServiceOptions {
	store: VaultStore;
	cache: VaultDocumentCache;
	sockets: () => VaultSocketService;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	hasBlob(hash: string): Promise<boolean>;
	flush: (documentId: string) => Promise<boolean>;
	validateActor: (actor: VaultActorContext) => boolean;
	/** Effective caps (`readBulkCreateLimits`); absent, the defaults. */
	limits?: BulkCreateLimits;
	/**
	 * Post-commit hook (see `VaultBulkCreateService.onBulkCreateCommitted`). Called
	 * synchronously after the bulk transaction commits and before the receipt is
	 * built; it must not block (schedule async work, e.g. via `waitUntil`).
	 */
	onBulkCreateCommitted?: (event: BulkCreateCommittedEvent) => void;
}

/** One body created by a committed bulk batch, with the exact bytes stored for it. */
export interface BulkCreateCommittedBody {
	bodyId: string;
	path: string;
	/** Full encoded Yjs state stored as the body's checkpoint (all chunks, concatenated). */
	state: Uint8Array;
	/** sha256 hex of `state` (the manifest's `state_sha256`). */
	stateSha256: string;
	/** The checkpoint chunk layout as stored (SQLITE_BLOB_CHUNK_BYTES each, last one shorter). */
	chunks: ReadonlyArray<{ byteLength: number; sha256: string }>;
	contentHash: string;
	size: number;
}

/** Everything a durable mirror needs about one committed bulk-create batch. */
export interface BulkCreateCommittedEvent {
	batchId: string;
	/** The batch's single vault sequence: every new body's checkpoint_sequence and head latest_sequence. */
	vaultSequence: number;
	/** Every new body starts at generation 1, body epoch 1. */
	bodyGeneration: 1;
	bodyEpoch: 1;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	bodies: BulkCreateCommittedBody[];
}

type AttachmentRef = { hash: string; size: number; revision: string };
type AttachmentMeta = { size: number; mime: string; createdAt: number };

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH
		&& ![...value].some((character) => {
			const code = character.codePointAt(0)!;
			return code < 0x20 || code === 0x7f;
		});
}

function isValidBodyId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let out = "";
	for (const value of digest) out += value.toString(16).padStart(2, "0");
	return out;
}

class BulkRequestError extends Error {
	constructor(readonly code: string, readonly status = 400) { super(code); }
}

function parseRequest(decoded: unknown, limits: BulkCreateLimits): ParsedRequest {
	if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new BulkRequestError("invalid_bulk_create");
	const value = decoded as Record<string, unknown>;
	if (!validIdentity(value.batchId)) throw new BulkRequestError("invalid_bulk_create_batch_id");
	if (!Number.isSafeInteger(value.rootEpoch) || (value.rootEpoch as number) < 1) throw new BulkRequestError("invalid_bulk_create_root_epoch");
	if (value.rootStateVector !== undefined && value.rootStateVector !== null && !(value.rootStateVector instanceof Uint8Array)) {
		throw new BulkRequestError("invalid_bulk_create_state_vector");
	}
	const rawFiles = value.files ?? [];
	const rawAttachments = value.attachments ?? [];
	if (!Array.isArray(rawFiles) || !Array.isArray(rawAttachments)) throw new BulkRequestError("invalid_bulk_create");
	const count = rawFiles.length + rawAttachments.length;
	if (count === 0) throw new BulkRequestError("empty_bulk_create");
	if (count > limits.maxItems) throw new BulkRequestError("bulk_create_too_many_items", 413);
	const operationIds = new Set<string>();
	const bodyIds = new Set<string>();
	const files: ParsedFile[] = [];
	let totalBytes = 0;
	for (const raw of rawFiles) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BulkRequestError("invalid_bulk_create_file");
		const file = raw as Record<string, unknown>;
		if (!validIdentity(file.operationId) || !isValidBodyId(file.bodyId) || typeof file.path !== "string"
			|| !Array.isArray(file.updates) || file.updates.length > MAX_CANDIDATE_UPDATE_FRAMES
			|| file.updates.some((frame) => !(frame instanceof Uint8Array) || frame.byteLength === 0
				|| frame.byteLength > MAX_DURABLE_UPDATE_BYTES)) {
			throw new BulkRequestError("invalid_bulk_create_file");
		}
		if (operationIds.has(file.operationId) || bodyIds.has(file.bodyId)) throw new BulkRequestError("duplicate_bulk_create_identity");
		operationIds.add(file.operationId);
		bodyIds.add(file.bodyId);
		const updates = file.updates as Uint8Array[];
		for (const frame of updates) totalBytes += frame.byteLength;
		files.push({ operationId: file.operationId, bodyId: file.bodyId, path: file.path, updates });
	}
	const limit = files.length === 1 && rawAttachments.length === 0 ? BULK_CREATE_SINGLE_FILE_MAX_BYTES : limits.maxBytes;
	if (totalBytes > limit) throw new BulkRequestError("bulk_create_too_large", 413);
	const attachments: ParsedAttachment[] = [];
	for (const raw of rawAttachments) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BulkRequestError("invalid_bulk_create_attachment");
		const attachment = raw as Record<string, unknown>;
		if (!validIdentity(attachment.operationId) || typeof attachment.path !== "string"
			|| typeof attachment.hash !== "string" || typeof attachment.size !== "number" || typeof attachment.mime !== "string") {
			throw new BulkRequestError("invalid_bulk_create_attachment");
		}
		if (operationIds.has(attachment.operationId)) throw new BulkRequestError("duplicate_bulk_create_identity");
		operationIds.add(attachment.operationId);
		attachments.push({ operationId: attachment.operationId, path: attachment.path, hash: attachment.hash.toLowerCase(),
			size: attachment.size, mime: attachment.mime });
	}
	return {
		batchId: value.batchId,
		rootEpoch: parseSemanticEpoch(value.rootEpoch, "bulk create root epoch"),
		rootStateVector: value.rootStateVector instanceof Uint8Array && value.rootStateVector.byteLength > 0 ? value.rootStateVector : null,
		files,
		attachments,
	};
}

/** Binds the exact request (not the root epoch / state vector) so a retry after an epoch recovery still replays. */
async function requestDigest(input: ParsedRequest): Promise<string> {
	const files = [];
	for (const file of input.files) {
		files.push({ operationId: file.operationId, bodyId: file.bodyId, path: file.path,
			framesDigest: file.updates.length === 0 ? "empty" : await sha256Hex(candidateDigestMaterial(file.updates)) });
	}
	const material = canonicalJsonText({ batchId: input.batchId, files,
		attachments: input.attachments.map((attachment) => ({ ...attachment })) });
	return sha256Hex(new TextEncoder().encode(material));
}

export class VaultBulkCreateService {
	private readonly limits: BulkCreateLimits;

	constructor(private readonly options: BulkCreateServiceOptions) {
		this.limits = options.limits ?? { maxItems: BULK_CREATE_MAX_ITEMS, maxBytes: BULK_CREATE_MAX_BYTES };
	}

	async handle(request: Request, actor: VaultActorContext, authorizeAttachments: () => Response | null): Promise<Response> {
		let parsed: ParsedRequest;
		try {
			const bytes = await readBoundedBytes(request, BULK_CREATE_MAX_REQUEST_BYTES);
			let decoded: unknown;
			try { decoded = decodeBinaryEnvelope(bytes, BULK_CREATE_MAX_REQUEST_BYTES); }
			catch { return json({ error: "invalid_binary_envelope" }, 400); }
			parsed = parseRequest(decoded, this.limits);
		} catch (error) {
			if (error instanceof BoundedBodyError) {
				return error.kind === "body_too_large"
					? json({ error: "bulk_create_too_large", bulkCreate: this.limits }, 413)
					: json({ error: error.kind }, 400);
			}
			// A 413 carries the effective caps so the client can re-split without a capabilities refresh.
			if (error instanceof BulkRequestError) {
				return json(error.status === 413 ? { error: error.code, bulkCreate: this.limits } : { error: error.code }, error.status);
			}
			return json({ error: "invalid_bulk_create" }, 400);
		}
		if (parsed.attachments.length > 0) {
			const denied = authorizeAttachments();
			if (denied) return denied;
		}
		const digest = await requestDigest(parsed);
		const early = this.replayOrOverlap(parsed, digest);
		if (early) return early;
		const currentRootEpoch = this.options.store.documentHead("root")?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
		if (currentRootEpoch !== parsed.rootEpoch) return this.rootEpochMismatch(parsed.rootEpoch, currentRootEpoch);

		// ---- Validation (no durable effects). ----
		const outcomes = new Map<string, BulkCreateOutcome>();
		const prepared: PreparedFile[] = [];
		const seenPaths = new Set<string>();
		const totalInput = parsed.files.reduce((sum, file) => file.updates.reduce((inner, frame) => inner + frame.byteLength, sum), 0);
		let releaseTransient: () => void;
		try { releaseTransient = this.options.cache.recordTransient("root", Math.max(1, totalInput) * 3); }
		catch (error) {
			if (error instanceof VaultDocumentCachePressureError) return json({ error: error.reason }, 429);
			throw error;
		}
		try {
			for (const file of parsed.files) {
				const reject = (reason: string): void => {
					outcomes.set(file.operationId, { kind: "file", operationId: file.operationId, bodyId: file.bodyId,
						path: file.path, outcome: "rejected", reason });
				};
				if (safeMarkdownPath(file.path) !== file.path) { reject("invalid_path"); continue; }
				if (seenPaths.has(file.path)) { reject("duplicate_path_in_batch"); continue; }
				seenPaths.add(file.path);
				const validated = this.validateFile(file);
				if (typeof validated === "string") { reject(validated); continue; }
				const chunks: Array<{ byteLength: number; sha256: string }> = [];
				for (let offset = 0; offset < validated.state.byteLength; offset += SQLITE_BLOB_CHUNK_BYTES) {
					const chunk = validated.state.subarray(offset, Math.min(validated.state.byteLength, offset + SQLITE_BLOB_CHUNK_BYTES));
					chunks.push({ byteLength: chunk.byteLength, sha256: await sha256Hex(chunk) });
				}
				prepared.push({ operationId: file.operationId, bodyId: file.bodyId, path: file.path, state: validated.state,
					// A single-chunk state (every note up to SQLITE_BLOB_CHUNK_BYTES) hashes to its chunk's hash.
					stateSha256: chunks.length === 1 ? chunks[0]!.sha256 : await sha256Hex(validated.state), chunks,
					contentHash: await sha256Hex(validated.contentBytes), size: validated.contentBytes.byteLength });
			}
			const attachmentCandidates: ParsedAttachment[] = [];
			const seenAttachmentPaths = new Set<string>();
			for (const attachment of parsed.attachments) {
				const reject = (reason: string): void => {
					outcomes.set(attachment.operationId, { kind: "attachment", operationId: attachment.operationId,
						path: attachment.path, outcome: "rejected", reason });
				};
				if (!/^[a-f0-9]{64}$/.test(attachment.hash) || !Number.isSafeInteger(attachment.size) || attachment.size < 0
					|| attachment.size > MAX_BLOB_UPLOAD_BYTES || !attachment.mime || attachment.mime.length > 256) {
					reject("invalid_attachment"); continue;
				}
				if (safeBlobPath(attachment.path, "", { hash: attachment.hash, size: attachment.size }) !== attachment.path) {
					reject("invalid_path"); continue;
				}
				if (seenAttachmentPaths.has(attachment.path) || seenPaths.has(attachment.path)) { reject("duplicate_path_in_batch"); continue; }
				seenAttachmentPaths.add(attachment.path);
				attachmentCandidates.push(attachment);
			}
			const blobPresence = await Promise.all(attachmentCandidates.map((attachment) => this.options.hasBlob(attachment.hash)));
			const attachments = attachmentCandidates.filter((attachment, index) => {
				if (blobPresence[index]) return true;
				outcomes.set(attachment.operationId, { kind: "attachment", operationId: attachment.operationId,
					path: attachment.path, outcome: "rejected", reason: "attachment_blob_missing" });
				return false;
			});
			if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);

			// ---- Synchronous section: no awaits from here to the commit. ----
			const replay = this.replayOrOverlap(parsed, digest);
			if (replay) return replay;
			if (this.options.store.recoveryMutexHeld()) return json({ error: "recovery_boundary_in_progress" }, 409);
			if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
			const rootHead = this.options.store.documentHead("root");
			if (!rootHead) return json({ error: "root_state_missing" }, 500);
			if (rootHead.semanticEpoch !== parsed.rootEpoch) return this.rootEpochMismatch(parsed.rootEpoch, rootHead.semanticEpoch);
			return this.commit(parsed, digest, actor, request, rootHead, prepared, attachments, outcomes);
		} finally {
			releaseTransient();
		}
	}

	private commit(
		parsed: ParsedRequest,
		digest: string,
		actor: VaultActorContext,
		origin: unknown,
		rootHead: { generation: number; semanticEpoch: SemanticEpoch; latestSequence: number },
		prepared: PreparedFile[],
		attachments: ParsedAttachment[],
		outcomes: Map<string, BulkCreateOutcome>,
	): Response {
		const releaseRoot = this.options.cache.reserveFullStateOperation("root", 2);
		let root: ReturnType<VaultStore["reconstructDocument"]>;
		try { root = this.options.store.reconstructDocument("root"); }
		catch (error) { releaseRoot(); throw error; }
		try {
			const vector = crdtEngine.encodeStateVector(root.doc);
			const operations: CrdtRootOperation[] = [];
			// D3 routing: occupied Markdown paths never create.
			const owners = this.options.store.activeCatalogHeadsAtPaths(prepared.map((file) => file.path));
			let reconstructions = 0;
			const files: PreparedFile[] = [];
			for (const file of prepared) {
				const owner = owners.get(file.path);
				if (!owner) {
					files.push(file);
					operations.push({ kind: "map-set", root: "pathToId", key: file.path, value: mapValue(file.bodyId) });
					outcomes.set(file.operationId, { kind: "file", operationId: file.operationId, bodyId: file.bodyId,
						path: file.path, outcome: "created", contentHash: file.contentHash, size: file.size });
					continue;
				}
				let existingHash = owner.contentHash;
				if (existingHash === null && reconstructions < MAX_IDENTITY_RECONSTRUCTIONS) {
					reconstructions++;
					existingHash = this.reconstructedContentHash(owner.bodyId);
				}
				outcomes.set(file.operationId, { kind: "file", operationId: file.operationId, bodyId: file.bodyId, path: file.path,
					outcome: existingHash === file.contentHash ? "exists-identical" : "exists-different",
					existingBodyId: owner.bodyId });
			}
			// The attachment root maps are only read for attachments: a notes-only batch skips the snapshots.
			const maps = attachments.length > 0 ? snapshotRootMaps(root.doc, ["pathToBlob", "blobMeta", "blobTombstones"]) : null;
			const refs = new Map(maps?.get("pathToBlob") ?? []) as Map<string, AttachmentRef>;
			const metadata = new Map(maps?.get("blobMeta") ?? []) as Map<string, AttachmentMeta>;
			const tombstones = new Map(maps?.get("blobTombstones") ?? []) as Map<string, unknown>;
			const createdAttachments: BulkCreateAttachmentWrite[] = [];
			const now = Date.now();
			for (const attachment of attachments) {
				const settle = (outcome: BulkCreateOutcomeKind, extra: Partial<BulkCreateOutcome> = {}): void => {
					outcomes.set(attachment.operationId, { kind: "attachment", operationId: attachment.operationId,
						path: attachment.path, outcome, ...extra });
				};
				const ref = refs.get(attachment.path);
				const sql = this.options.store.attachmentHead(attachment.path);
				if (ref) {
					settle(ref.hash === attachment.hash && ref.size === attachment.size ? "exists-identical" : "exists-different",
						{ existingRevision: ref.revision });
					continue;
				}
				if (tombstones.has(attachment.path) || sql !== null) {
					// A tombstone (or an inconsistent SQL head) needs revision-aware handling:
					// the client falls back to the per-operation attachment path.
					settle("exists-different", sql?.lifecycle === "deleted" ? { existingRevision: sql.operationId } : {});
					continue;
				}
				const meta = metadata.get(attachment.hash);
				if (meta && meta.size !== attachment.size) { settle("rejected", { reason: "attachment_catalog_root_mismatch" }); continue; }
				const value: AttachmentRef = { hash: attachment.hash, size: attachment.size, revision: attachment.operationId };
				refs.set(attachment.path, value);
				operations.push({ kind: "map-set", root: "pathToBlob", key: attachment.path, value: mapValue(value) });
				if (!meta) {
					const created: AttachmentMeta = { size: attachment.size, mime: attachment.mime, createdAt: now };
					metadata.set(attachment.hash, created);
					operations.push({ kind: "map-set", root: "blobMeta", key: attachment.hash, value: mapValue(created) });
				}
				createdAttachments.push({ operationId: attachment.operationId, path: attachment.path, hash: attachment.hash,
					size: attachment.size, mime: attachment.mime });
				settle("created");
			}
			const ordered = this.orderedOutcomes(parsed, outcomes);
			if (operations.length === 0) {
				// Nothing to write: answer without a durable receipt (a retry recomputes the same outcomes).
				return this.response(parsed.batchId, ordered, rootHead.latestSequence, rootHead.generation,
					rootHead.semanticEpoch, false, parsed.rootStateVector
						? crdtEngine.encodeStateAsUpdate(root.doc, parsed.rootStateVector) : null);
			}
			crdtEngine.applyRootOperations(root.doc, operations, "bulk-create");
			const update = crdtEngine.encodeStateAsUpdate(root.doc, vector);
			if (update.byteLength === 0 || update.byteLength > MAX_DURABLE_UPDATE_BYTES) {
				return json({ error: "bulk_create_root_update_too_large" }, 413);
			}
			let commit: ReturnType<VaultStore["commitBulkCreate"]>;
			try {
				commit = this.options.store.commitBulkCreate({ batchId: parsed.batchId, requestDigest: digest, rootUpdate: update,
					expectedRootHead: rootHead, files, attachments: createdAttachments, actor, outcomes: ordered, now });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message === "document_head_changed" || message === "active_path_conflict"
					|| message === "bulk_create_batch_exists" || message === "bulk_create_body_exists") {
					return json({ error: message }, 409);
				}
				if (message === "recovery_boundary_in_progress" || message.includes("authority")) return json({ error: message }, 409);
				throw error;
			}
			this.onBulkCreateCommitted({ batchId: parsed.batchId, vaultSequence: commit.vaultSequence, bodyGeneration: 1,
				bodyEpoch: 1, rootGeneration: commit.generation, rootEpoch: commit.semanticEpoch,
				bodies: files.map((file) => ({ bodyId: file.bodyId, path: file.path, state: file.state,
					stateSha256: file.stateSha256, chunks: file.chunks, contentHash: file.contentHash, size: file.size })) });
			this.options.cache.applyDurableUpdate("root", update, commit.generation, origin);
			this.options.sockets().broadcastDocumentUpdate("root", update, origin);
			for (const file of files) this.options.cache.discardResident(file.bodyId);
			return this.response(parsed.batchId, ordered, commit.vaultSequence, commit.generation, commit.semanticEpoch, false,
				parsed.rootStateVector ? crdtEngine.encodeStateAsUpdate(root.doc, parsed.rootStateVector) : update);
		} finally {
			crdtEngine.destroyDocument(root.doc);
			releaseRoot();
		}
	}

	/**
	 * HOOK for b3-recovery (R2 body mirror): runs exactly once per batch, right
	 * after `commitBulkCreate` has committed the SQLite transaction and before the
	 * receipt is answered. `event.bodies` carries the exact stored state bytes of
	 * every body the batch created, at `event.vaultSequence` (checkpoint sequence =
	 * head sequence; generation 1, epoch 1), so a mirror can write them to R2
	 * without decoding or re-reading SQLite. Not called for a replayed batch (its
	 * bodies were mirrored on the first commit) or for a batch that created nothing.
	 *
	 * Contract: best effort and non-blocking. SQLite is the source of truth; the
	 * receipt never waits on the mirror (PHASE4 P2), and a throwing or slow
	 * mirror must not fail the request. Implementations schedule their async
	 * writes (e.g. `ctx.waitUntil`) and return immediately. Not implemented here:
	 * without `options.onBulkCreateCommitted` this is a no-op.
	 */
	private onBulkCreateCommitted(event: BulkCreateCommittedEvent): void {
		const hook = this.options.onBulkCreateCommitted;
		if (!hook) return;
		try { hook(event); }
		catch (error) {
			console.warn("bulk create post-commit hook failed", error instanceof Error ? error.message : String(error));
		}
	}

	/** Exact retry → stored receipt; any item already committed under another batch → clean 409. */
	private replayOrOverlap(parsed: ParsedRequest, digest: string): Response | null {
		const receipt = this.options.store.bulkCreateReceipt(parsed.batchId);
		if (receipt) {
			if (receipt.requestDigest !== digest) return json({ error: "bulk_create_batch_identity_mismatch" }, 409);
			const rootHead = this.options.store.documentHead("root");
			const currentEpoch = rootHead?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
			if (currentEpoch !== parsed.rootEpoch) return this.rootEpochMismatch(parsed.rootEpoch, currentEpoch);
			const release = this.options.cache.reserveFullStateOperation("root", 2);
			try {
				const root = this.options.store.reconstructDocument("root");
				try {
					const update = crdtEngine.encodeStateAsUpdate(root.doc, parsed.rootStateVector ?? undefined);
					return this.response(parsed.batchId, receipt.outcomes as BulkCreateOutcome[], receipt.vaultSequence,
						receipt.rootGeneration, receipt.rootEpoch, true, update);
				} finally { crdtEngine.destroyDocument(root.doc); }
			} finally { release(); }
		}
		const bodies = this.options.store.existingBodyIds(parsed.files.map((file) => file.bodyId));
		const attachmentOps = this.options.store.committedAttachmentOperationIds(parsed.attachments.map((item) => item.operationId));
		if (bodies.size > 0 || attachmentOps.size > 0) {
			return json({ error: "bulk_create_partial_overlap",
				operationIds: [
					...parsed.files.filter((file) => bodies.has(file.bodyId)).map((file) => file.operationId),
					...parsed.attachments.filter((item) => attachmentOps.has(item.operationId)).map((item) => item.operationId),
				] }, 409);
		}
		return null;
	}

	private validateFile(file: ParsedFile): { state: Uint8Array; contentBytes: Uint8Array } | string {
		const doc = crdtEngine.createDocument(file.bodyId);
		try {
			try { for (const frame of file.updates) crdtEngine.applyUpdate(doc, frame, "bulk-create-validation"); }
			catch { return "invalid_yjs_update"; }
			const semanticError = validateFrontmatterSemanticRoots(doc);
			if (semanticError) return semanticError;
			const content = crdtEngine.readText(doc, "body");
			if (content !== canonicalizeMarkdown(content)) return "candidate_markdown_not_canonical";
			const contentBytes = canonicalMarkdownBytes(content);
			if (contentBytes.byteLength > MAX_CLIENT_MARKDOWN_BYTES) return "markdown_size_limit";
			return { state: crdtEngine.encodeStateAsUpdate(doc), contentBytes };
		} finally {
			crdtEngine.destroyDocument(doc);
		}
	}

	private reconstructedContentHash(bodyId: string): string | null {
		try {
			const body = this.options.store.reconstructDocument(bodyId);
			try { return sha256HexSyncOf(canonicalMarkdownBytes(crdtEngine.readText(body.doc, "body"))); }
			finally { crdtEngine.destroyDocument(body.doc); }
		} catch {
			return null;
		}
	}

	private orderedOutcomes(parsed: ParsedRequest, outcomes: Map<string, BulkCreateOutcome>): BulkCreateOutcome[] {
		return [...parsed.files.map((file) => file.operationId), ...parsed.attachments.map((item) => item.operationId)]
			.map((operationId) => {
				const outcome = outcomes.get(operationId);
				if (!outcome) throw new Error("bulk create item has no outcome");
				return outcome;
			});
	}

	private response(
		batchId: string,
		outcomes: BulkCreateOutcome[],
		vaultSequence: number,
		rootGeneration: number,
		rootEpoch: SemanticEpoch,
		replayed: boolean,
		rootUpdate: Uint8Array | null,
	): Response {
		const body = encodeBinaryEnvelope({
			batchId,
			outcomes,
			vaultSequence,
			rootGeneration,
			rootEpoch,
			vaultGeneration: this.options.vaultGeneration(),
			runtimeEpoch: this.options.runtimeEpoch,
			replayed,
			...(rootUpdate && rootUpdate.byteLength > 0 ? { rootUpdate } : {}),
		}, MAX_RESPONSE_BYTES);
		return new Response(body.slice().buffer, { headers: { "content-type": YAOS_BINARY_CONTENT_TYPE, "cache-control": "no-store" } });
	}

	private rootEpochMismatch(received: SemanticEpoch, expected: SemanticEpoch): Response {
		const mismatch = new SemanticEpochMismatchError({ purpose: "root", documentId: "root",
			expectedRootEpoch: expected, receivedRootEpoch: received });
		return json(mismatch.toPayload(), mismatch.status);
	}
}
