import * as Y from "yjs";
import { base64ToBytes, bytesToBase64Url } from "./base64url";
import { MAX_BLOB_UPLOAD_BYTES, MAX_CATCH_UP_BODIES, MAX_JSON_BYTES, type LifecycleRequest, type LifecycleReceipt, type RootPublicationReceipt } from "./contracts";
import { canonicalJsonText } from "./recoveryCanonicalJson";
import { readBoundedBytes } from "./readBoundedBytes";
import { safeBlobPath, safeMarkdownPath } from "./shared/vaultPath";
import type {
	CatalogMutation,
	DurableCandidateReceipt,
	DurableLifecycleRecord,
	DurableRootPublication,
	PendingCreationCandidate,
	VaultStore,
	AttachmentCatalogEvent,
} from "./vaultStore";
import type { VaultDocumentCache } from "./vaultDocumentCache";
import type { VaultSocketService } from "./vaultSocketService";

const MAX_IDENTITY_LENGTH = 256;

type AttachmentMutation =
	| { operationId: string; kind: "upsert"; path: string; expectedRevision: string | null; hash: string; size: number; mime: string }
	| { operationId: string; kind: "delete"; path: string; expectedRevision: string | null }
	| { operationId: string; kind: "rename"; fromPath: string; toPath: string; expectedFromRevision: string; expectedToRevision: string | null };

type AttachmentHeadSummary =
	| { kind: "missing"; revision: null }
	| { kind: "active"; revision: string; hash: string; size: number }
	| { kind: "deleted"; revision: string; previousHash: string | null };

type AttachmentTombstone = {
	deletedAt: number;
	device?: string;
	previousHash: string | null;
	revision: string;
};

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

function isValidBodyId(value: string): boolean {
	return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

async function boundedJson(request: Request): Promise<unknown> {
	const bytes = await readBoundedBytes(request, MAX_JSON_BYTES);
	try { return JSON.parse(new TextDecoder().decode(bytes)); }
	catch { throw new Error("invalid_json"); }
}

function jsonValue(value: unknown): unknown {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) return null;
	const parsed: unknown = JSON.parse(encoded);
	return parsed;
}

function parseLifecycleRequest(value: unknown): LifecycleRequest | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)
		|| !("operationId" in value) || !validIdentity(value.operationId)
		|| !("fileId" in value) || !validIdentity(value.fileId)
		|| !("bodyId" in value) || typeof value.bodyId !== "string" || !isValidBodyId(value.bodyId)
		|| !("kind" in value)
		|| (value.kind !== "create" && value.kind !== "delete" && value.kind !== "revive" && value.kind !== "rename")
		|| ("path" in value && value.path !== undefined && typeof value.path !== "string")
		|| ("fromPath" in value && value.fromPath !== undefined && typeof value.fromPath !== "string")
		|| ("toPath" in value && value.toPath !== undefined && typeof value.toPath !== "string")
		|| ("candidateId" in value && value.candidateId !== undefined && typeof value.candidateId !== "string")
		|| ("candidateDigest" in value && value.candidateDigest !== undefined && typeof value.candidateDigest !== "string")) {
		return null;
	}
	return {
		operationId: value.operationId,
		kind: value.kind,
		fileId: value.fileId,
		bodyId: value.bodyId,
		path: "path" in value && typeof value.path === "string" ? value.path : undefined,
		fromPath: "fromPath" in value && typeof value.fromPath === "string" ? value.fromPath : undefined,
		toPath: "toPath" in value && typeof value.toPath === "string" ? value.toPath : undefined,
		candidateId: "candidateId" in value && typeof value.candidateId === "string" ? value.candidateId : undefined,
		candidateDigest: "candidateDigest" in value && typeof value.candidateDigest === "string" ? value.candidateDigest : undefined,
	};
}

interface LifecycleServiceOptions {
	store: VaultStore;
	cache: VaultDocumentCache;
	sockets: () => VaultSocketService;
	vaultId: () => string;
	vaultGeneration: () => string;
	runtimeEpoch: string;
	hasBlob(hash: string): Promise<boolean>;
	flush: (documentId: string) => Promise<boolean>;
}

interface BodyMetadata {
	contentHash: string;
	size: number;
}

interface LifecyclePublicationOperation extends LifecycleRequest {
	vaultSequence: number;
}

/** Owns create/rename/delete/revive fences and exact root publication. */
export class VaultLifecycleService {
	constructor(private readonly options: LifecycleServiceOptions) {}

	activeBodyHead(bodyId: string) {
		const head = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), bodyId);
		return head?.lifecycle === "active" && head.fileId === bodyId && !this.options.store.creationCandidate(bodyId) ? head : null;
	}

	async handle(request: Request): Promise<Response> {
		let decoded: unknown;
		try { decoded = await boundedJson(request); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "invalid_json" }, 400); }
		const input = parseLifecycleRequest(decoded);
		if (!input || input.bodyId !== input.fileId) {
			return json({ error: "invalid_lifecycle_request" }, 400);
		}
		if (input.kind === "create" && (!validIdentity(input.candidateId)
			|| typeof input.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.candidateDigest.toLowerCase()))) {
			return json({ error: "creation_candidate_required" }, 400);
		}
		const existing = this.options.store.lifecycleRecord(input.operationId);
		if (existing) {
			if (!this.inputMatchesRecord(input, existing)) return json({ error: "operation_identity_mismatch" }, 409);
			if (!this.isCurrent(existing)) return json({ error: "lifecycle_operation_superseded" }, 409);
			return json(this.receipt(existing));
		}
		if (input.kind === "create") return this.admitCreate(input);
		return this.commitLifecycle(input);
	}

	async handleBatch(request: Request): Promise<Response> {
		let decoded: unknown;
		try { decoded = await boundedJson(request); }
		catch { return json({ error: "invalid_json" }, 400); }
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)
			|| !("operations" in decoded) || !Array.isArray(decoded.operations)
			|| decoded.operations.length === 0 || decoded.operations.length > MAX_CATCH_UP_BODIES) {
			return json({ error: "invalid_lifecycle_batch" }, 400);
		}
		const candidates: unknown[] = decoded.operations;
		const operations: LifecycleRequest[] = [];
		const operationIds = new Set<string>();
		const bodyIds = new Set<string>();
		for (const candidate of candidates) {
			const operation = parseLifecycleRequest(candidate);
			if (!operation || operation.bodyId !== operation.fileId || operation.kind === "create"
				|| operationIds.has(operation.operationId) || bodyIds.has(operation.bodyId)) {
				return json({ error: "invalid_lifecycle_batch_operation" }, 400);
			}
			operations.push(operation);
			operationIds.add(operation.operationId);
			bodyIds.add(operation.bodyId);
		}
		const existing = operations.map((operation) => this.options.store.lifecycleRecord(operation.operationId));
		if (existing.every((record) => record !== null)) {
			const records = existing;
			if (!records.every((record, index) => this.inputMatchesRecord(operations[index]!, record) && this.isCurrent(record))) {
				return json({ error: "lifecycle_batch_superseded" }, 409);
			}
			return json({ receipts: records.map((record) => this.receipt(record)), vaultSequence: records[0]!.vaultSequence, runtimeEpoch: records[0]!.runtimeEpoch });
		}
		if (existing.some((record) => record !== null)) return json({ error: "lifecycle_batch_partial_retry" }, 409);
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		for (const bodyId of bodyIds) if (!await this.options.flush(bodyId)) return json({ error: "body_persistence_unavailable" }, 503);
		const mutexOwner = `lifecycle-batch:${crypto.randomUUID()}`;
		if (!this.options.store.acquireRecoveryMutex(mutexOwner)) return json({ error: "recovery_boundary_in_progress" }, 409);
		try {
			const values: Array<{ catalog: CatalogMutation; receipt: Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration"> }> = [];
			for (const operation of operations) {
				const prepared = this.prepareMutation(operation);
				if (prepared instanceof Response) return prepared;
				values.push(prepared);
			}
			const rootUpdate = this.markerUpdate(operations);
			const commit = this.options.store.commitRootLifecycle({
				rootUpdate,
				kind: "lifecycle-batch",
				catalog: values.map((value) => value.catalog),
				lifecycleReceipts: values.map((value) => value.receipt),
			});
			this.applyRoot(rootUpdate, commit.generation, request);
			for (const operation of operations) if (operation.kind === "delete") this.options.sockets().closeBody(operation.bodyId);
			const records = operations.map((operation) => this.options.store.lifecycleRecord(operation.operationId)!);
			return json({ receipts: records.map((record) => this.receipt(record)), vaultSequence: commit.vaultSequence, runtimeEpoch: this.options.runtimeEpoch });
		} finally {
			this.options.store.releaseRecoveryMutex(mutexOwner);
		}
	}

	async publish(request: Request): Promise<Response> {
		let decoded: unknown;
		try { decoded = await boundedJson(request); }
		catch { return json({ error: "invalid_json" }, 400); }
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)
			|| !("operations" in decoded) || !Array.isArray(decoded.operations) || decoded.operations.length === 0
			|| decoded.operations.length > MAX_CATCH_UP_BODIES
			|| !("rootUpdateBase64" in decoded) || typeof decoded.rootUpdateBase64 !== "string") {
			return json({ error: "invalid_lifecycle_publication" }, 400);
		}
		const candidates: unknown[] = decoded.operations;
		const records: DurableLifecycleRecord[] = [];
		const prior: Array<DurableRootPublication | null> = [];
		const operationIds = new Set<string>();
		for (const candidate of candidates) {
			const operation = parseLifecycleRequest(candidate);
			if (!operation || typeof candidate !== "object" || candidate === null || !("vaultSequence" in candidate)
				|| typeof candidate.vaultSequence !== "number" || !Number.isInteger(candidate.vaultSequence)
				|| operationIds.has(operation.operationId)) {
				return json({ error: "invalid_lifecycle_publication_operation" }, 400);
			}
			const published: LifecyclePublicationOperation = { ...operation, vaultSequence: candidate.vaultSequence };
			operationIds.add(published.operationId);
			const record = this.options.store.lifecycleRecord(published.operationId);
			if (!record || record.vaultSequence !== published.vaultSequence || !this.inputMatchesRecord(published, record) || !this.isCurrent(record)) {
				return json({ error: "lifecycle_publication_mismatch" }, 409);
			}
			records.push(record);
			prior.push(this.options.store.lifecyclePublication(published.operationId));
		}
		if (prior.every((value) => value !== null)) {
			const first = prior[0]!;
			return json({ operationIds: [...operationIds], vaultSequence: first.rootSequence, rootGeneration: first.rootGeneration,
				vaultGeneration: first.vaultGeneration, runtimeEpoch: first.runtimeEpoch } satisfies RootPublicationReceipt);
		}
		if (prior.some((value) => value !== null)) return json({ error: "lifecycle_publication_partial_retry" }, 409);
		let rootUpdate: Uint8Array;
		try { rootUpdate = base64ToBytes(decoded.rootUpdateBase64); }
		catch { return json({ error: "invalid_root_update" }, 400); }
		if (rootUpdate.byteLength === 0 || rootUpdate.byteLength > MAX_JSON_BYTES) return json({ error: "invalid_root_update_size" }, 400);
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		this.options.cache.load("root", false, () => true);
		if (!this.publicationMatches(rootUpdate, records)) return json({ error: "root_publication_result_mismatch" }, 409);
		const commit = this.options.store.commitUpdate({
			documentId: "root",
			update: rootUpdate,
			kind: "root",
			rootPublications: records.map((record) => ({ operationId: record.operationId, lifecycleSequence: record.vaultSequence,
				vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch })),
		});
		this.applyRoot(rootUpdate, commit.generation, request);
		return json({ operationIds: [...operationIds], vaultSequence: commit.vaultSequence, rootGeneration: commit.generation,
			vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch } satisfies RootPublicationReceipt);
	}

	async publishAttachment(request: Request): Promise<Response> {
		let decoded: unknown;
		try {
			decoded = await boundedJson(request);
		} catch {
			return json({ error: "invalid_json" }, 400);
		}
		const mutation = this.parseAttachmentMutation(decoded);
		if (!mutation) return json({ error: "invalid_attachment_publication" }, 400);
		const requestDigest = await this.attachmentRequestDigest(mutation);
		const replay = this.options.store.attachmentOperation(mutation.operationId);
		const replayEvents = this.options.store.attachmentEventsForOperation(mutation.operationId);
		if (replay || replayEvents.length > 0) return this.attachmentReplayResult(mutation, requestDigest, replay, replayEvents);
		if (mutation.kind === "upsert" && !await this.options.hasBlob(mutation.hash)) {
			return json({ error: "attachment_blob_missing" }, 409);
		}
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		const mutexOwner = `attachment:${mutation.operationId}:${crypto.randomUUID()}`;
		if (!this.options.store.acquireVaultMutationLease(mutexOwner)) {
			return json({ error: "attachment_mutation_busy" }, 503);
		}
		try {
			const insideReplay = this.options.store.attachmentOperation(mutation.operationId);
			const insideReplayEvents = this.options.store.attachmentEventsForOperation(mutation.operationId);
			if (insideReplay || insideReplayEvents.length > 0) {
				return this.attachmentReplayResult(mutation, requestDigest, insideReplay, insideReplayEvents);
			}
			const current = this.options.store.reconstructDocument("root");
			try {
				const vector = Y.encodeStateVector(current.doc);
				const refs = current.doc.getMap<{ hash: string; size: number; revision: string }>("pathToBlob");
				const metadata = current.doc.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta");
				const tombstones = current.doc.getMap<AttachmentTombstone>("blobTombstones");
				const affected = mutation.kind === "rename" ? [mutation.fromPath, mutation.toPath] : [mutation.path];
				for (const path of affected) {
					const sql = this.options.store.attachmentHead(path);
					if (!this.attachmentHeadIsConsistent(path, sql, refs, metadata, tombstones)) {
						return json({ error: "attachment_catalog_root_mismatch" }, 500);
					}
				}
				if (mutation.kind === "upsert") {
					const meta = metadata.get(mutation.hash);
					if (meta && (meta.size !== mutation.size
						|| typeof meta.mime !== "string" || meta.mime.length === 0 || meta.mime.length > 256
						|| !Number.isSafeInteger(meta.createdAt) || meta.createdAt < 0)) {
						return json({ error: "attachment_catalog_root_mismatch" }, 500);
					}
				}
				const checks = mutation.kind === "rename"
					? [[mutation.fromPath, mutation.expectedFromRevision], [mutation.toPath, mutation.expectedToRevision]] as const
					: [[mutation.path, mutation.expectedRevision]] as const;
				for (const [path, expectedRevision] of checks) {
					const currentHead = this.attachmentHeadSummary(path, refs, tombstones);
					if (currentHead.revision !== expectedRevision) {
						return this.attachmentRevisionMismatch(path, currentHead, affected, refs, tombstones);
					}
				}
				if (mutation.kind === "rename") {
					const sourceHead = this.attachmentHeadSummary(mutation.fromPath, refs, tombstones);
					if (sourceHead.kind !== "active") {
						return this.attachmentRevisionMismatch(mutation.fromPath, sourceHead, affected, refs, tombstones);
					}
				}
				const events: Array<Omit<AttachmentCatalogEvent, "sequence"> & { operationId: string }> = [];
				if (mutation.kind === "upsert") {
					refs.set(mutation.path, { hash: mutation.hash, size: mutation.size, revision: mutation.operationId });
					if (!metadata.has(mutation.hash)) metadata.set(mutation.hash, { size: mutation.size, mime: mutation.mime, createdAt: Date.now() });
					tombstones.delete(mutation.path);
					events.push({ operationId: mutation.operationId, path: mutation.path, contentHash: mutation.hash, size: mutation.size, mime: mutation.mime, lifecycle: "active" });
				} else if (mutation.kind === "delete") {
					const prior = refs.get(mutation.path);
					const previousHash = prior?.hash ?? tombstones.get(mutation.path)?.previousHash ?? null;
					refs.delete(mutation.path);
					tombstones.set(mutation.path, { deletedAt: Date.now(), device: request.headers.get("x-yaos-device-id") ?? undefined,
						previousHash, revision: mutation.operationId });
					events.push({ operationId: mutation.operationId, path: mutation.path, contentHash: previousHash, size: prior?.size ?? null, mime: null, lifecycle: "deleted" });
				} else {
					const prior = refs.get(mutation.fromPath)!;
					const meta = metadata.get(prior.hash);
					refs.delete(mutation.fromPath);
					refs.set(mutation.toPath, { ...prior, revision: mutation.operationId });
					tombstones.set(mutation.fromPath, { deletedAt: Date.now(), previousHash: prior.hash, revision: mutation.operationId });
					tombstones.delete(mutation.toPath);
					events.push(
						{ operationId: mutation.operationId, path: mutation.fromPath, contentHash: prior.hash, size: prior.size, mime: meta?.mime ?? null, lifecycle: "deleted" },
						{ operationId: mutation.operationId, path: mutation.toPath, contentHash: prior.hash, size: prior.size, mime: meta?.mime ?? null, lifecycle: "active" },
					);
				}
				const update = Y.encodeStateAsUpdate(current.doc, vector);
				if (update.byteLength === 0 || update.byteLength > MAX_JSON_BYTES) return json({ error: "invalid_attachment_root_update" }, 400);
				const commit = this.options.store.commitRootAttachments(update, events, { operationId: mutation.operationId, requestDigest });
				this.applyRoot(update, commit.generation, request);
				return this.attachmentReceipt(mutation.operationId, events, update, commit.vaultSequence, commit.generation);
			} finally {
				current.doc.destroy();
			}
		} finally {
			this.options.store.releaseVaultMutationLease(mutexOwner);
		}
	}

	finalizeCreation(creation: PendingCreationCandidate, candidate: DurableCandidateReceipt, metadata: BodyMetadata): boolean {
		const owner = `lifecycle-create:${creation.operationId}:${crypto.randomUUID()}`;
		if (!this.options.store.acquireRecoveryMutex(owner)) return false;
		try {
			const existing = this.options.store.lifecycleRecord(creation.operationId);
			if (existing) {
				if (existing.candidateId !== creation.candidateId || existing.candidateDigest !== creation.candidateDigest) {
					throw new Error("completed creation identity mismatch");
				}
				this.options.store.completeCreationCandidate(creation.bodyId, creation.candidateId, creation.candidateDigest);
				return true;
			}
			const request: LifecycleRequest = { operationId: creation.operationId, kind: "create", fileId: creation.fileId,
				bodyId: creation.bodyId, path: creation.path, candidateId: creation.candidateId, candidateDigest: creation.candidateDigest };
			const rootUpdate = this.markerUpdate([request]);
			const commit = this.options.store.commitRootLifecycle({
				rootUpdate,
				kind: "create",
				catalog: { bodyId: creation.bodyId, fileId: creation.fileId, path: creation.path, previousPath: null,
					lifecycle: "active", bodyGeneration: candidate.durableGeneration, contentHash: metadata.contentHash, size: metadata.size },
				lifecycleReceipt: { operationId: creation.operationId, kind: "create", bodyId: creation.bodyId, fileId: creation.fileId,
					candidateId: creation.candidateId, candidateDigest: creation.candidateDigest, sourcePath: null, resultPath: creation.path,
					resultLifecycle: "active", durableGeneration: candidate.durableGeneration,
					vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: creation.runtimeEpoch },
				completeCreation: { bodyId: creation.bodyId, candidateId: creation.candidateId, candidateDigest: creation.candidateDigest },
			});
			this.applyRoot(rootUpdate, commit.generation, creation);
			return true;
		} finally {
			this.options.store.releaseRecoveryMutex(owner);
		}
	}

	private admitCreate(input: LifecycleRequest): Response {
		if (typeof input.path !== "string" || safeMarkdownPath(input.path) !== input.path) return json({ error: "path_required" }, 400);
		const candidateId = input.candidateId!;
		const candidateDigest = input.candidateDigest!.toLowerCase();
		const existing = this.options.store.creationCandidate(input.bodyId);
		if (existing) {
			if (existing.operationId !== input.operationId || existing.path !== input.path || existing.candidateId !== candidateId || existing.candidateDigest !== candidateDigest) {
				return json({ error: "creation_candidate_fence_mismatch" }, 409);
			}
			return json(this.pendingReceipt(existing));
		}
		if (this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), input.bodyId)) return json({ error: "body_identity_already_exists" }, 409);
		let bodyHead = this.options.store.documentHead(input.bodyId);
		if (!bodyHead) {
			const empty = new Y.Doc({ guid: input.bodyId });
			const commit = this.options.store.commitUpdate({ documentId: input.bodyId, update: Y.encodeStateAsUpdate(empty), kind: "body" });
			empty.destroy();
			bodyHead = { generation: commit.generation, latestSequence: commit.vaultSequence };
		}
		const fence = this.options.store.expectCreationCandidate({ bodyId: input.bodyId, fileId: input.fileId, path: input.path,
			operationId: input.operationId, candidateId, candidateDigest, durableGeneration: bodyHead.generation,
			vaultSequence: bodyHead.latestSequence, vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch });
		return json(this.pendingReceipt(fence));
	}

	private async commitLifecycle(input: LifecycleRequest): Promise<Response> {
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		if (!await this.options.flush(input.bodyId)) return json({ error: "body_persistence_unavailable" }, 503);
		const prepared = this.prepareMutation(input);
		if (prepared instanceof Response) return prepared;
		const rootUpdate = this.markerUpdate([input]);
		const commit = this.options.store.commitRootLifecycle({ rootUpdate, kind: input.kind, catalog: prepared.catalog, lifecycleReceipt: prepared.receipt });
		const record = this.options.store.lifecycleRecord(input.operationId)!;
		this.applyRoot(rootUpdate, commit.generation, input);
		if (input.kind === "delete") this.options.sockets().closeBody(input.bodyId);
		this.options.sockets().notifyBodyCommitted(input.bodyId, prepared.receipt.durableGeneration);
		return json(this.receipt(record));
	}

	private prepareMutation(input: LifecycleRequest): { catalog: CatalogMutation; receipt: Omit<DurableLifecycleRecord, "vaultSequence" | "rootGeneration"> } | Response {
		const current = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), input.bodyId);
		if (!current || current.fileId !== input.fileId) return json({ error: "body_not_found" }, 404);
		if (this.options.store.creationCandidate(input.bodyId)) return json({ error: "body_creation_not_committed" }, 409);
		if ((input.kind === "delete" || input.kind === "rename") && current.lifecycle !== "active") return json({ error: "body_not_active" }, 409);
		if (input.kind === "revive" && current.lifecycle !== "tombstoned") return json({ error: "body_not_tombstoned" }, 409);
		if (input.kind === "rename" && input.fromPath !== current.path) return json({ error: "stale_source_path" }, 409);
		const path = input.kind === "rename" ? input.toPath : input.kind === "revive" ? input.path : current.path;
		if (typeof path !== "string" || safeMarkdownPath(path) !== path) return json({ error: "path_required" }, 400);
		const head = this.options.store.documentHead(input.bodyId);
		if (!head || head.generation <= 0) return json({ error: "body_state_missing" }, 500);
		const lifecycle = input.kind === "delete" ? "tombstoned" : "active";
		return {
			catalog: { bodyId: input.bodyId, fileId: input.fileId, path, previousPath: input.kind === "rename" ? current.path : null,
				lifecycle, bodyGeneration: head.generation, contentHash: current.contentHash, size: current.size },
			receipt: { operationId: input.operationId, kind: input.kind as "rename" | "delete" | "revive", bodyId: input.bodyId,
				fileId: input.fileId, candidateId: null, candidateDigest: null, sourcePath: current.path, resultPath: path,
				resultLifecycle: lifecycle, durableGeneration: head.generation, vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch },
		};
	}

	private markerUpdate(inputs: LifecycleRequest[]): Uint8Array {
		const root = this.options.store.reconstructDocument("root");
		const vector = Y.encodeStateVector(root.doc);
		const markers = root.doc.getMap("__yaosLifecycle");
		for (const input of inputs) markers.set(input.operationId, { kind: input.kind, fileId: input.fileId, bodyId: input.bodyId,
			path: input.path ?? null, fromPath: input.fromPath ?? null, toPath: input.toPath ?? null });
		const update = Y.encodeStateAsUpdate(root.doc, vector);
		root.doc.destroy();
		return update;
	}

	private attachmentReplay(operationId: string): Response {
		const root = this.options.store.reconstructDocument("root");
		try {
			const events = this.options.store.attachmentEventsForOperation(operationId);
			const operation = this.options.store.attachmentOperation(operationId);
			if (!operation || events.length === 0) return json({ error: "attachment_replay_corrupt" }, 500);
			return this.attachmentReceipt(
				operationId,
				events,
				Y.encodeStateAsUpdate(root.doc),
				operation.rootSequence,
				root.generation,
			);
		} finally {
			root.doc.destroy();
		}
	}

	private attachmentReplayResult(
		mutation: AttachmentMutation,
		requestDigest: string,
		operation: ReturnType<VaultStore["attachmentOperation"]>,
		events: AttachmentCatalogEvent[],
	): Response {
		if (!operation || events.length === 0
			|| !Number.isSafeInteger(operation.rootSequence) || operation.rootSequence <= 0
			|| !Number.isSafeInteger(operation.rootGeneration) || operation.rootGeneration <= 0
			|| !/^[a-f0-9]{64}$/.test(operation.requestDigest)
			|| events.some((event) => event.operationId !== mutation.operationId || event.sequence !== operation.rootSequence)) {
			return json({ error: "attachment_replay_corrupt" }, 500);
		}
		if (operation.requestDigest !== requestDigest) return json({ error: "attachment_operation_identity_mismatch" }, 409);
		if (!this.attachmentReplayEventsMatchMutation(mutation, events)) return json({ error: "attachment_replay_corrupt" }, 500);
		return this.attachmentReplay(mutation.operationId);
	}

	private attachmentReplayEventsMatchMutation(mutation: AttachmentMutation, events: AttachmentCatalogEvent[]): boolean {
		if (new Set(events.map((event) => event.path)).size !== events.length) return false;
		if (mutation.kind === "upsert") {
			const event = events[0];
			return events.length === 1 && event?.path === mutation.path && event.lifecycle === "active"
				&& event.contentHash === mutation.hash && event.size === mutation.size && event.mime === mutation.mime;
		}
		if (mutation.kind === "delete") {
			return events.length === 1 && events[0]?.path === mutation.path && events[0].lifecycle === "deleted";
		}
		if (events.length !== 2) return false;
		const source = events.find((event) => event.path === mutation.fromPath);
		const target = events.find((event) => event.path === mutation.toPath);
		return source?.lifecycle === "deleted" && target?.lifecycle === "active"
			&& source.contentHash !== null && source.contentHash === target.contentHash
			&& source.size === target.size;
	}

	private attachmentRevisionMismatch(
		path: string,
		current: AttachmentHeadSummary,
		affected: string[],
		refs: Y.Map<{ hash: string; size: number; revision: string }>,
		tombstones: Y.Map<AttachmentTombstone>,
	): Response {
		return json({
			error: "attachment_revision_mismatch",
			path,
			current,
			currentHeads: affected.map((affectedPath) => ({
				path: affectedPath,
				head: this.attachmentHeadSummary(affectedPath, refs, tombstones),
			})),
			vaultGeneration: this.options.vaultGeneration(),
			vaultSequence: this.options.store.currentSequence(),
		}, 409);
	}

	private attachmentHeadIsConsistent(
		path: string,
		sql: AttachmentCatalogEvent | null,
		refs: Y.Map<{ hash: string; size: number; revision: string }>,
		metadata: Y.Map<{ size: number; mime: string; createdAt: number }>,
		tombstones: Y.Map<AttachmentTombstone>,
	): boolean {
		const ref = refs.get(path);
		const tombstone = tombstones.get(path);
		if (ref && tombstone) return false;
		if (!ref && !tombstone) return sql === null;
		if (ref) {
			const meta = metadata.get(ref.hash);
			return validIdentity(ref.revision)
				&& /^[a-f0-9]{64}$/.test(ref.hash)
				&& Number.isSafeInteger(ref.size) && ref.size >= 0 && ref.size <= MAX_BLOB_UPLOAD_BYTES
				&& !!meta && meta.size === ref.size
				&& typeof meta.mime === "string" && meta.mime.length > 0 && meta.mime.length <= 256
				&& Number.isSafeInteger(meta.createdAt) && meta.createdAt >= 0
				&& sql?.lifecycle === "active"
				&& sql.operationId === ref.revision
				&& sql.contentHash === ref.hash
				&& sql.size === ref.size;
		}
		return !!tombstone
			&& validIdentity(tombstone.revision)
			&& Number.isSafeInteger(tombstone.deletedAt) && tombstone.deletedAt >= 0
			&& (tombstone.device === undefined || validIdentity(tombstone.device))
			&& (tombstone.previousHash === null || /^[a-f0-9]{64}$/.test(tombstone.previousHash))
			&& sql?.lifecycle === "deleted"
			&& sql.operationId === tombstone.revision
			&& sql.contentHash === tombstone.previousHash;
	}

	private attachmentReceipt(
		operationId: string,
		events: Array<Pick<AttachmentCatalogEvent, "path" | "lifecycle">>,
		update: Uint8Array,
		vaultSequence: number,
		rootGeneration: number,
	): Response {
		return json({
			operationId,
			outcome: "committed",
			revisions: events.map((event) => ({
				path: event.path,
				revision: operationId,
				state: event.lifecycle,
			})),
			vaultGeneration: this.options.vaultGeneration(),
			runtimeEpoch: this.options.runtimeEpoch,
			vaultSequence,
			rootGeneration,
			rootUpdateBase64Url: bytesToBase64Url(update),
		});
	}

	private parseAttachmentMutation(decoded: unknown): AttachmentMutation | null {
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
		const value = decoded as Record<string, unknown>;
		if (!validIdentity(value.operationId)) return null;
		const validRevision = (revision: unknown): revision is string | null => revision === null || validIdentity(revision);
		const exactKeys = (keys: string[]): boolean => {
			const actual = Object.keys(value).sort();
			return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
		};
		if (value.kind === "upsert") {
			const hash = typeof value.hash === "string" ? value.hash.toLowerCase() : "";
			const ref = { hash, size: typeof value.size === "number" ? value.size : -1 };
			if (!exactKeys(["operationId", "kind", "path", "expectedRevision", "hash", "size", "mime"])
				|| typeof value.path !== "string" || safeBlobPath(value.path, "", ref) !== value.path
				|| !validRevision(value.expectedRevision) || !/^[a-f0-9]{64}$/.test(hash)
				|| !Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_BLOB_UPLOAD_BYTES
				|| typeof value.mime !== "string" || !value.mime || value.mime.length > 256) return null;
			return { operationId: value.operationId, kind: "upsert", path: value.path, expectedRevision: value.expectedRevision,
				hash, size: value.size as number, mime: value.mime };
		}
		if (value.kind === "delete") {
			if (!exactKeys(["operationId", "kind", "path", "expectedRevision"])
				|| typeof value.path !== "string" || safeBlobPath(value.path) !== value.path
				|| !validRevision(value.expectedRevision)) return null;
			return { operationId: value.operationId, kind: "delete", path: value.path, expectedRevision: value.expectedRevision };
		}
		if (value.kind === "rename") {
			if (!exactKeys(["operationId", "kind", "fromPath", "toPath", "expectedFromRevision", "expectedToRevision"])
				|| typeof value.fromPath !== "string" || safeBlobPath(value.fromPath) !== value.fromPath
				|| typeof value.toPath !== "string" || safeBlobPath(value.toPath) !== value.toPath
				|| value.fromPath === value.toPath || !validIdentity(value.expectedFromRevision)
				|| !validRevision(value.expectedToRevision)) return null;
			return { operationId: value.operationId, kind: "rename", fromPath: value.fromPath, toPath: value.toPath,
				expectedFromRevision: value.expectedFromRevision, expectedToRevision: value.expectedToRevision };
		}
		return null;
	}

	private async attachmentRequestDigest(mutation: AttachmentMutation): Promise<string> {
		const bytes = new TextEncoder().encode(canonicalJsonText(mutation));
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
	}

	private attachmentHeadSummary(
		path: string,
		refs: Y.Map<{ hash: string; size: number; revision: string }>,
		tombstones: Y.Map<AttachmentTombstone>,
	): AttachmentHeadSummary {
		const ref = refs.get(path);
		if (ref) return { kind: "active", revision: ref.revision, hash: ref.hash, size: ref.size };
		const tombstone = tombstones.get(path);
		if (tombstone) return { kind: "deleted", revision: tombstone.revision, previousHash: tombstone.previousHash };
		return { kind: "missing", revision: null };
	}

	private applyRoot(update: Uint8Array, generation: number, origin: unknown): void {
		this.options.cache.applyDurableUpdate("root", update, generation, origin);
		this.options.sockets().broadcastDocumentUpdate("root", update, origin);
	}
	private publicationMatches(update: Uint8Array, records: DurableLifecycleRecord[]): boolean {
		const reconstructed = this.options.store.reconstructDocument("root");
		const expected = new Y.Doc();
		const actual = new Y.Doc();
		try {
			const baseline = Y.encodeStateAsUpdate(reconstructed.doc);
			Y.applyUpdate(expected, baseline);
			Y.applyUpdate(actual, baseline);
			const expectedPaths = expected.getMap<string>("pathToId");
			for (const record of records) if (record.sourcePath) expectedPaths.delete(record.sourcePath);
			for (const record of records) if (record.resultLifecycle === "active") expectedPaths.set(record.resultPath, record.fileId);
			Y.applyUpdate(actual, update);
			const actualPaths = actual.getMap<string>("pathToId");
			const expectedPathEntries = [...expectedPaths.entries()].sort(([left], [right]) => left.localeCompare(right));
			const actualPathEntries = [...actualPaths.entries()].sort(([left], [right]) => left.localeCompare(right));
			const keys = [...new Set([...expected.share.keys(), ...actual.share.keys()])].sort();
			for (const key of keys) {
				if (key === "pathToId") {
					if (canonicalJsonText(expectedPathEntries) !== canonicalJsonText(actualPathEntries)) return false;
					continue;
				}
				const expectedType = expected.share.get(key);
				const actualType = actual.share.get(key);
				if (!expectedType || !actualType
					|| canonicalJsonText(jsonValue(expectedType.toJSON()))
						!== canonicalJsonText(jsonValue(actualType.toJSON()))) {
					return false;
				}
			}
			return true;
		} catch {
			return false;
		}
		finally {
			reconstructed.doc.destroy();
			expected.destroy();
			actual.destroy();
		}
	}

	private inputMatchesRecord(input: LifecycleRequest, record: DurableLifecycleRecord): boolean {
		if (input.operationId !== record.operationId || input.kind !== record.kind || input.bodyId !== record.bodyId || input.fileId !== record.fileId
			|| (input.candidateId ?? null) !== record.candidateId || (input.candidateDigest?.toLowerCase() ?? null) !== record.candidateDigest) return false;
		if (input.kind === "create") return record.sourcePath === null && input.path === record.resultPath;
		if (input.kind === "rename") return input.fromPath === record.sourcePath && input.toPath === record.resultPath;
		if (input.kind === "revive") return input.path === record.resultPath;
		return record.sourcePath === record.resultPath;
	}

	private isCurrent(record: DurableLifecycleRecord): boolean {
		const current = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), record.bodyId);
		return current !== null && current.sequence === record.vaultSequence && current.path === record.resultPath
			&& current.lifecycle === record.resultLifecycle && current.generation === record.durableGeneration;
	}

	private receipt(record: DurableLifecycleRecord): LifecycleReceipt {
		return { vaultId: this.options.vaultId(), vaultGeneration: record.vaultGeneration, bodyId: record.bodyId, fileId: record.fileId,
			operationId: record.operationId, kind: record.kind, lifecycle: record.resultLifecycle, path: record.resultPath,
			durableGeneration: record.durableGeneration, vaultSequence: record.vaultSequence, runtimeEpoch: record.runtimeEpoch };
	}

	private pendingReceipt(record: PendingCreationCandidate): LifecycleReceipt {
		return { vaultId: this.options.vaultId(), vaultGeneration: record.vaultGeneration, bodyId: record.bodyId, fileId: record.fileId,
			operationId: record.operationId, kind: "create", lifecycle: "active", path: record.path,
			durableGeneration: record.durableGeneration, vaultSequence: record.vaultSequence, runtimeEpoch: record.runtimeEpoch };
	}
}
