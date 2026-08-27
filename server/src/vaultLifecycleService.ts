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
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
			return json({ error: "invalid_attachment_publication" }, 400);
		}
		const value = decoded as Record<string, unknown>;
		const operationId = value.operationId;
		const kind = value.kind;
		if (typeof operationId !== "string" || !validIdentity(operationId)
			|| (kind !== "upsert" && kind !== "delete" && kind !== "rename")) {
			return json({ error: "invalid_attachment_publication" }, 400);
		}
		const replay = this.options.store.attachmentEventsForOperation(operationId);
		if (replay.length > 0) return this.attachmentReplay(operationId);
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		const current = this.options.store.reconstructDocument("root");
		const vector = Y.encodeStateVector(current.doc);
		const refs = current.doc.getMap<{ hash: string; size: number }>("pathToBlob");
		const metadata = current.doc.getMap<{ size: number; mime: string; createdAt: number }>("blobMeta");
		const tombstones = current.doc.getMap<{ deletedAt: number; device?: string; previousHash: string | null }>("blobTombstones");
		const events: Array<Omit<AttachmentCatalogEvent, "sequence"> & { operationId: string }> = [];
		try {
			if (kind === "upsert") {
				const path = typeof value.path === "string" ? value.path : "";
				const hash = typeof value.hash === "string" ? value.hash.toLowerCase() : "";
				const size = value.size;
				const mime = typeof value.mime === "string" ? value.mime : "";
				const ref = { hash, size: typeof size === "number" ? size : -1 };
				if (safeBlobPath(path, "", ref) !== path || !/^[a-f0-9]{64}$/.test(hash)
					|| !Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MAX_BLOB_UPLOAD_BYTES
					|| !mime || mime.length > 256) {
					return json({ error: "invalid_attachment_upsert" }, 400);
				}
				if (!await this.options.hasBlob(hash)) {
					return json({ error: "attachment_blob_missing" }, 409);
				}
				refs.set(path, { hash, size: size as number });
				if (!metadata.has(hash)) metadata.set(hash, { size: size as number, mime, createdAt: Date.now() });
				tombstones.delete(path);
				events.push({ operationId, path, contentHash: hash, size: size as number, mime, lifecycle: "active" });
			} else if (kind === "delete") {
				const path = typeof value.path === "string" ? value.path : "";
				if (safeBlobPath(path) !== path) return json({ error: "invalid_attachment_delete" }, 400);
				const prior = refs.get(path);
				refs.delete(path);
				tombstones.set(path, {
					deletedAt: Date.now(),
					device: request.headers.get("x-yaos-device-id") ?? undefined,
					previousHash: prior?.hash ?? null,
				});
				events.push({ operationId, path, contentHash: prior?.hash ?? null, size: prior?.size ?? null, mime: null, lifecycle: "deleted" });
			} else {
				const fromPath = typeof value.fromPath === "string" ? value.fromPath : "";
				const toPath = typeof value.toPath === "string" ? value.toPath : "";
				const prior = refs.get(fromPath);
				if (!prior || safeBlobPath(fromPath) !== fromPath || safeBlobPath(toPath, "", prior) !== toPath) {
					return json({ error: "invalid_attachment_rename" }, 400);
				}
				const meta = metadata.get(prior.hash);
				refs.delete(fromPath);
				refs.set(toPath, prior);
				tombstones.set(fromPath, { deletedAt: Date.now(), previousHash: prior.hash });
				tombstones.delete(toPath);
				events.push(
					{ operationId, path: fromPath, contentHash: prior.hash, size: prior.size, mime: meta?.mime ?? null, lifecycle: "deleted" },
					{ operationId, path: toPath, contentHash: prior.hash, size: prior.size, mime: meta?.mime ?? null, lifecycle: "active" },
				);
			}
			const update = Y.encodeStateAsUpdate(current.doc, vector);
			if (update.byteLength === 0 || update.byteLength > MAX_JSON_BYTES) {
				return json({ error: "invalid_attachment_root_update" }, 400);
			}
			const commit = this.options.store.commitRootAttachments(update, events);
			this.applyRoot(update, commit.generation, request);
			return json({
				operationId,
				vaultGeneration: this.options.vaultGeneration(),
				runtimeEpoch: this.options.runtimeEpoch,
				vaultSequence: commit.vaultSequence,
				rootGeneration: commit.generation,
				rootUpdateBase64Url: bytesToBase64Url(update),
			});
		} finally {
			current.doc.destroy();
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
			return json({
				operationId,
				vaultGeneration: this.options.vaultGeneration(),
				runtimeEpoch: this.options.runtimeEpoch,
				vaultSequence: Math.max(...events.map((event) => event.sequence)),
				rootGeneration: root.generation,
				rootUpdateBase64Url: bytesToBase64Url(Y.encodeStateAsUpdate(root.doc)),
			});
		} finally {
			root.doc.destroy();
		}
	}

	private applyRoot(update: Uint8Array, generation: number, origin: unknown): void {
		if (this.options.cache.applyDurableUpdate("root", update, generation, origin)) {
			this.options.sockets().broadcastDocumentUpdate("root", update, origin);
		}
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
