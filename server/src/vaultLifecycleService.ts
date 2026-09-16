import type { CrdtRootOperation, CrdtRootSnapshot, CrdtValueSnapshot } from "./crdt/crdtEngine";
import { mapValue, snapshotRootMap } from "./crdt/rootSchema";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
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
import type { VaultActorContext } from "./collaboration";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "./shared/binaryEnvelope";
import {
	INITIAL_SEMANTIC_EPOCH,
	SemanticEpochMismatchError,
	parseSemanticEpoch,
	type SemanticEpoch,
} from "./shared/semanticEpoch";

const MAX_IDENTITY_LENGTH = 256;

type AttachmentMutation =
	(| { operationId: string; kind: "upsert"; path: string; expectedRevision: string | null; hash: string; size: number; mime: string }
	| { operationId: string; kind: "delete"; path: string; expectedRevision: string | null }
	| { operationId: string; kind: "rename"; fromPath: string; toPath: string; expectedFromRevision: string; expectedToRevision: string | null })
	& { rootEpoch: SemanticEpoch };

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

function canonicalSnapshotValue(value: CrdtValueSnapshot): unknown {
	if (value.shared === "value") return value.value;
	if (value.shared === "text") return { shared: "text", value: value.value };
	if (value.shared === "array") return { shared: "array", values: value.values.map(canonicalSnapshotValue) };
	return { shared: "map", entries: [...value.entries]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, nested]) => [key, canonicalSnapshotValue(nested)]) };
}

function canonicalRootState(doc: Parameters<typeof crdtEngine.snapshotRoots>[0]): string {
	const roots: CrdtRootSnapshot[] = crdtEngine.snapshotRoots(doc)
		.filter((root) => root.name !== "__yaosLifecyclePublicationProof")
		.slice().sort((left, right) => left.name.localeCompare(right.name));
	return canonicalJsonText(jsonValue(roots.map((root) => [root.name, canonicalSnapshotValue(root.value)])));
}

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
		|| !("bodyEpoch" in value) || !Number.isSafeInteger(value.bodyEpoch) || (value.bodyEpoch as number) < 1
		|| !("kind" in value)
		|| (value.kind !== "create" && value.kind !== "delete" && value.kind !== "revive" && value.kind !== "rename")
		|| ("path" in value && value.path !== undefined && typeof value.path !== "string")
		|| ("fromPath" in value && value.fromPath !== undefined && typeof value.fromPath !== "string")
		|| ("toPath" in value && value.toPath !== undefined && typeof value.toPath !== "string")
		|| ("candidateId" in value && value.candidateId !== undefined && typeof value.candidateId !== "string")
		|| ("candidateDigest" in value && value.candidateDigest !== undefined && typeof value.candidateDigest !== "string")) {
		return null;
	}
	const optional = value as Record<string, unknown>;
	return {
		operationId: value.operationId,
		kind: value.kind,
		fileId: value.fileId,
		bodyId: value.bodyId,
		bodyEpoch: value.bodyEpoch as SemanticEpoch,
		...(typeof optional.path === "string" ? { path: optional.path } : {}),
		...(typeof optional.fromPath === "string" ? { fromPath: optional.fromPath } : {}),
		...(typeof optional.toPath === "string" ? { toPath: optional.toPath } : {}),
		...(typeof optional.candidateId === "string" ? { candidateId: optional.candidateId } : {}),
		...(typeof optional.candidateDigest === "string" ? { candidateDigest: optional.candidateDigest } : {}),
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
	validateActor: (actor: VaultActorContext) => boolean;
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

	async handle(request: Request, actor: VaultActorContext): Promise<Response> {
		let decoded: unknown;
		try { decoded = await boundedJson(request); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "invalid_json" }, 400); }
		const input = parseLifecycleRequest(decoded);
		return this.handleInput(input, actor);
	}

	async handleCreateAdmissionsBatch(request: Request, actor: VaultActorContext): Promise<Response> {
		let decoded: unknown;
		try { decoded = await boundedJson(request); }
		catch { return json({ error: "invalid_json" }, 400); }
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)
			|| !("operations" in decoded) || !Array.isArray(decoded.operations)
			|| decoded.operations.length === 0 || decoded.operations.length > MAX_CATCH_UP_BODIES) {
			return json({ error: "invalid_create_admission_batch" }, 400);
		}
		const operations: LifecycleRequest[] = [];
		const operationIds = new Set<string>();
		const bodyIds = new Set<string>();
		const paths = new Set<string>();
		const candidateIds = new Set<string>();
		for (const candidate of decoded.operations) {
			const operation = parseLifecycleRequest(candidate);
			if (!operation || operation.kind !== "create" || operation.bodyId !== operation.fileId
				|| !validIdentity(operation.candidateId)
				|| typeof operation.candidateDigest !== "string"
				|| !/^[a-f0-9]{64}$/.test(operation.candidateDigest.toLowerCase())
				|| typeof operation.path !== "string" || safeMarkdownPath(operation.path) !== operation.path
				|| operationIds.has(operation.operationId) || bodyIds.has(operation.bodyId)
				|| paths.has(operation.path) || candidateIds.has(operation.candidateId)) {
				return json({ error: "invalid_create_admission_batch_item" }, 400);
			}
			operations.push(operation);
			operationIds.add(operation.operationId);
			bodyIds.add(operation.bodyId);
			paths.add(operation.path);
			candidateIds.add(operation.candidateId);
		}
		const receipts: LifecycleReceipt[] = [];
		for (const operation of operations) {
			const response = await this.handleInput(operation, actor);
			if (response.status !== 200) return response;
			receipts.push(await response.json());
		}
		return json({
			receipts,
			vaultSequence: Math.max(...receipts.map((receipt) => receipt.vaultSequence)),
			runtimeEpoch: this.options.runtimeEpoch,
		});
	}

	private async handleInput(input: LifecycleRequest | null, actor: VaultActorContext): Promise<Response> {
		if (!input || input.bodyId !== input.fileId) {
			return json({ error: "invalid_lifecycle_request" }, 400);
		}
		if (input.kind === "create" && (!validIdentity(input.candidateId)
			|| typeof input.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.candidateDigest.toLowerCase()))) {
			return json({ error: "creation_candidate_required" }, 400);
		}
		const existing = this.options.store.lifecycleRecord(input.operationId);
		if (existing) {
			if (existing.bodyEpoch !== input.bodyEpoch) return this.bodyEpochMismatch(input.bodyId, input.bodyEpoch);
			if (!this.inputMatchesRecord(input, existing)) return json({ error: "operation_identity_mismatch" }, 409);
			// A root publication is the terminal durable outcome. Once it exists,
			// replaying the immutable lifecycle request must keep returning its
			// receipt even if a later semantic reset makes the historical body
			// epoch non-current. This is what lets a restarted client retire a local
			// row after losing the original response.
			if (!this.isCurrent(existing) && !this.options.store.lifecyclePublication(existing.operationId)) {
				return json({ error: "lifecycle_operation_superseded" }, 409);
			}
			return json(this.receipt(existing));
		}
		const requestDigest = await this.lifecycleRequestDigest(input);
		const currentEpoch = this.options.store.documentHead(input.bodyId)?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
		if (currentEpoch !== input.bodyEpoch) return this.bodyEpochMismatch(input.bodyId, input.bodyEpoch, currentEpoch);
		if (input.kind === "create") return this.admitCreate(input, actor, requestDigest);
		return this.commitLifecycle(input, actor, requestDigest);
	}

	async handleBatch(request: Request, actor: VaultActorContext): Promise<Response> {
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
		const requestDigests = await Promise.all(operations.map((operation) => this.lifecycleRequestDigest(operation)));
		if (existing.every((record) => record !== null)) {
			const records = existing;
			for (let index = 0; index < records.length; index++) {
				if (records[index]!.bodyEpoch !== operations[index]!.bodyEpoch) {
					return this.bodyEpochMismatch(operations[index]!.bodyId, operations[index]!.bodyEpoch);
				}
			}
			if (!records.every((record, index) => this.inputMatchesRecord(operations[index]!, record)
				&& (this.isCurrent(record) || this.options.store.lifecyclePublication(record.operationId) !== null))) {
				return json({ error: "lifecycle_batch_superseded" }, 409);
			}
			return json({ receipts: records.map((record) => this.receipt(record)), vaultSequence: records[0]!.vaultSequence, runtimeEpoch: records[0]!.runtimeEpoch });
		}
		if (existing.some((record) => record !== null)) {
			for (let index = 0; index < existing.length; index++) {
				const record = existing[index];
				if (record && record.bodyEpoch !== operations[index]!.bodyEpoch) {
					return this.bodyEpochMismatch(operations[index]!.bodyId, operations[index]!.bodyEpoch);
				}
			}
			return json({ error: "lifecycle_batch_partial_retry" }, 409);
		}
		for (const operation of operations) {
			const currentEpoch = this.options.store.documentHead(operation.bodyId)?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
			if (currentEpoch !== operation.bodyEpoch) return this.bodyEpochMismatch(operation.bodyId, operation.bodyEpoch, currentEpoch);
		}
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		for (const bodyId of bodyIds) if (!await this.options.flush(bodyId)) return json({ error: "body_persistence_unavailable" }, 503);
		const mutexOwner = `lifecycle-batch:${crypto.randomUUID()}`;
		if (!this.options.store.acquireRecoveryMutex(mutexOwner)) return json({ error: "recovery_boundary_in_progress" }, 409);
		try {
			if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
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
				actorAttributions: operations.map((operation, index) => ({ actor, operationId: operation.operationId,
					requestDigest: requestDigests[index] })),
			});
			this.applyRoot(rootUpdate, commit.generation, request);
			for (const operation of operations) if (operation.kind === "delete") this.options.sockets().closeBody(operation.bodyId);
			const records = operations.map((operation) => this.options.store.lifecycleRecord(operation.operationId)!);
			return json({ receipts: records.map((record) => this.receipt(record)), vaultSequence: commit.vaultSequence, runtimeEpoch: this.options.runtimeEpoch });
		} finally {
			this.options.store.releaseRecoveryMutex(mutexOwner);
		}
	}

	async publish(request: Request, actor: VaultActorContext): Promise<Response> {
		let decoded: unknown;
		try { decoded = decodeBinaryEnvelope(await readBoundedBytes(request, MAX_JSON_BYTES), MAX_JSON_BYTES); }
		catch { return json({ error: "invalid_binary_envelope" }, 400); }
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)
			|| !("operations" in decoded) || !Array.isArray(decoded.operations) || decoded.operations.length === 0
			|| decoded.operations.length > MAX_CATCH_UP_BODIES
			|| !("rootUpdate" in decoded) || !(decoded.rootUpdate instanceof Uint8Array)
			|| !("rootEpoch" in decoded) || !Number.isSafeInteger(decoded.rootEpoch) || (decoded.rootEpoch as number) < 1) {
			return json({ error: "invalid_lifecycle_publication" }, 400);
		}
		const rootEpoch = parseSemanticEpoch(decoded.rootEpoch, "lifecycle publication root epoch");
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
			if (!record || record.vaultSequence !== published.vaultSequence || !this.inputMatchesRecord(published, record)) {
				return json({ error: "lifecycle_publication_mismatch" }, 409);
			}
			const publication = this.options.store.lifecyclePublication(published.operationId);
			// An exact durable publication remains replayable after a later body
			// epoch reset makes the historical lifecycle receipt non-current. This
			// is also how a client retires work which root compaction migrated on
			// its behalf. Unpublished receipts must still describe current catalog
			// authority before they are allowed to mutate the root.
			if (!publication && !this.isCurrent(record)) {
				return json({ error: "lifecycle_publication_mismatch" }, 409);
			}
			records.push(record);
			prior.push(publication);
		}
		if (prior.every((value) => value !== null)) {
			const first = prior[0]!;
			return json({ operationIds: [...operationIds], vaultSequence: first.rootSequence, rootGeneration: first.rootGeneration,
				rootEpoch: first.rootEpoch, vaultGeneration: first.vaultGeneration,
				runtimeEpoch: first.runtimeEpoch } satisfies RootPublicationReceipt);
		}
		if (prior.some((value) => value !== null)) return json({ error: "lifecycle_publication_partial_retry" }, 409);
		const currentRootEpoch = this.options.store.documentHead("root")?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
		if (currentRootEpoch !== rootEpoch) return this.rootEpochMismatch(rootEpoch, currentRootEpoch);
		const rootUpdate = decoded.rootUpdate;
		if (rootUpdate.byteLength === 0 || rootUpdate.byteLength > MAX_JSON_BYTES) return json({ error: "invalid_root_update_size" }, 400);
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		this.options.cache.load("root", false, () => true);
		if (!this.publicationMatches(rootUpdate, records)) return json({ error: "root_publication_result_mismatch" }, 409);
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		const commit = this.options.store.commitUpdate({
			documentId: "root",
			update: rootUpdate,
			kind: "root",
			rootPublications: records.map((record) => ({ operationId: record.operationId, lifecycleSequence: record.vaultSequence,
				rootEpoch, vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch })),
			actorAttributions: records.map((record) => ({ actor, operationId: record.operationId })),
		});
		this.applyRoot(rootUpdate, commit.generation, request);
		return json({ operationIds: [...operationIds], vaultSequence: commit.vaultSequence, rootGeneration: commit.generation,
			rootEpoch: commit.semanticEpoch, vaultGeneration: this.options.vaultGeneration(),
			runtimeEpoch: this.options.runtimeEpoch } satisfies RootPublicationReceipt);
	}

	async publishAttachment(request: Request, suppliedActor?: VaultActorContext): Promise<Response> {
		const actor = suppliedActor ?? { vaultId: this.options.vaultId(), vaultGeneration: this.options.vaultGeneration(),
			principalId: request.headers.get("x-yaos-device-id") ?? "legacy", membershipRevision: 1,
			deviceId: request.headers.get("x-yaos-device-id") ?? "legacy", deviceCredentialRevision: 1,
			role: "member" as const, policyVersion: 1, capabilityDigest: "legacy" };
		let decoded: unknown;
		try {
			if (!(this.options.validateActor?.(actor) ?? true)) return json({ error: "authority_superseded" }, 409);
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
		const currentRootEpoch = this.options.store.documentHead("root")?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
		if (mutation.rootEpoch !== currentRootEpoch) return this.rootEpochMismatch(mutation.rootEpoch, currentRootEpoch);
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
			if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
			const rootHead = this.options.store.documentHead("root");
			if (!rootHead) return json({ error: "root_state_missing" }, 500);
			if (rootHead.semanticEpoch !== mutation.rootEpoch) {
				return this.rootEpochMismatch(mutation.rootEpoch, rootHead.semanticEpoch);
			}
			const releaseTransient = this.options.cache.reserveFullStateOperation("root", 2);
			let current: ReturnType<VaultStore["reconstructDocument"]>;
			try { current = this.options.store.reconstructDocument("root"); }
			catch (error) {
				releaseTransient();
				throw error;
			}
			try {
				const vector = crdtEngine.encodeStateVector(current.doc);
				const refs = new Map(snapshotRootMap(current.doc, "pathToBlob")) as Map<string, { hash: string; size: number; revision: string }>;
				const metadata = new Map(snapshotRootMap(current.doc, "blobMeta")) as Map<string, { size: number; mime: string; createdAt: number }>;
				const tombstones = new Map(snapshotRootMap(current.doc, "blobTombstones")) as Map<string, AttachmentTombstone>;
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
				const operations: CrdtRootOperation[] = [];
				if (mutation.kind === "upsert") {
					refs.set(mutation.path, { hash: mutation.hash, size: mutation.size, revision: mutation.operationId });
					operations.push({ kind: "map-set", root: "pathToBlob", key: mutation.path,
						value: mapValue(refs.get(mutation.path)) });
					if (!metadata.has(mutation.hash)) {
						metadata.set(mutation.hash, { size: mutation.size, mime: mutation.mime, createdAt: Date.now() });
						operations.push({ kind: "map-set", root: "blobMeta", key: mutation.hash,
							value: mapValue(metadata.get(mutation.hash)) });
					}
					tombstones.delete(mutation.path);
					operations.push({ kind: "map-delete", root: "blobTombstones", key: mutation.path });
					events.push({ operationId: mutation.operationId, path: mutation.path, contentHash: mutation.hash, size: mutation.size, mime: mutation.mime, lifecycle: "active" });
				} else if (mutation.kind === "delete") {
					const prior = refs.get(mutation.path);
					const previousHash = prior?.hash ?? tombstones.get(mutation.path)?.previousHash ?? null;
					refs.delete(mutation.path);
					tombstones.set(mutation.path, { deletedAt: Date.now(), device: request.headers.get("x-yaos-device-id") ?? undefined,
						previousHash, revision: mutation.operationId });
					operations.push(
						{ kind: "map-delete", root: "pathToBlob", key: mutation.path },
						{ kind: "map-set", root: "blobTombstones", key: mutation.path,
							value: mapValue(tombstones.get(mutation.path)) },
					);
					events.push({ operationId: mutation.operationId, path: mutation.path, contentHash: previousHash, size: prior?.size ?? null, mime: null, lifecycle: "deleted" });
				} else {
					const prior = refs.get(mutation.fromPath)!;
					const meta = metadata.get(prior.hash);
					refs.delete(mutation.fromPath);
					refs.set(mutation.toPath, { ...prior, revision: mutation.operationId });
					tombstones.set(mutation.fromPath, { deletedAt: Date.now(), previousHash: prior.hash, revision: mutation.operationId });
					tombstones.delete(mutation.toPath);
					operations.push(
						{ kind: "map-delete", root: "pathToBlob", key: mutation.fromPath },
						{ kind: "map-set", root: "pathToBlob", key: mutation.toPath,
							value: mapValue(refs.get(mutation.toPath)) },
						{ kind: "map-set", root: "blobTombstones", key: mutation.fromPath,
							value: mapValue(tombstones.get(mutation.fromPath)) },
						{ kind: "map-delete", root: "blobTombstones", key: mutation.toPath },
					);
					events.push(
						{ operationId: mutation.operationId, path: mutation.fromPath, contentHash: prior.hash, size: prior.size, mime: meta?.mime ?? null, lifecycle: "deleted" },
						{ operationId: mutation.operationId, path: mutation.toPath, contentHash: prior.hash, size: prior.size, mime: meta?.mime ?? null, lifecycle: "active" },
					);
				}
				crdtEngine.applyRootOperations(current.doc, operations, `attachment-${mutation.kind}`);
				const update = crdtEngine.encodeStateAsUpdate(current.doc, vector);
				if (update.byteLength === 0 || update.byteLength > MAX_JSON_BYTES) return json({ error: "invalid_attachment_root_update" }, 400);
				const commit = this.options.store.commitRootAttachments(update, events,
					{ operationId: mutation.operationId, requestDigest, rootEpoch: mutation.rootEpoch }, rootHead,
					undefined, [{ actor, operationId: mutation.operationId, requestDigest }]);
				this.applyRoot(update, commit.generation, request);
				return this.attachmentReceipt(mutation.operationId, events, update, commit.vaultSequence,
					commit.generation, commit.semanticEpoch);
			} finally {
				crdtEngine.destroyDocument(current.doc);
				releaseTransient();
			}
		} finally {
			this.options.store.releaseVaultMutationLease(mutexOwner);
		}
	}

	finalizeCreation(
		creation: PendingCreationCandidate,
		candidate: DurableCandidateReceipt,
		metadata: BodyMetadata,
		actor: VaultActorContext,
	): "committed" | "busy" | "superseded" {
		const owner = `lifecycle-create:${creation.operationId}:${crypto.randomUUID()}`;
		if (!this.options.store.acquireRecoveryMutex(owner)) return "busy";
		try {
			if (creation.bodyEpoch !== candidate.bodyEpoch) throw new Error("creation candidate body epoch mismatch");
			const existing = this.options.store.lifecycleRecord(creation.operationId);
			if (existing) {
				if (existing.candidateId !== creation.candidateId || existing.candidateDigest !== creation.candidateDigest) {
					throw new Error("completed creation identity mismatch");
				}
				this.options.store.completeCreationCandidate(creation.bodyId, creation.candidateId, creation.candidateDigest);
				return "committed";
			}
			const pathOwner = this.options.store.activeCatalogHeadAtPath(
				this.options.store.currentSequence(), creation.path,
			);
			if (pathOwner) {
				// A concurrent/replayed creation won this path before this exact fence
				// could publish. Retire the fence so it cannot retry forever. The body
				// candidate remains a harmless orphan until normal retention reaps it.
				this.options.store.completeCreationCandidate(
					creation.bodyId, creation.candidateId, creation.candidateDigest,
				);
				return "superseded";
			}
			const request: LifecycleRequest = { operationId: creation.operationId, kind: "create", fileId: creation.fileId,
				bodyEpoch: creation.bodyEpoch,
				bodyId: creation.bodyId, path: creation.path, candidateId: creation.candidateId, candidateDigest: creation.candidateDigest };
			const rootUpdate = this.markerUpdate([request]);
			const commit = this.options.store.commitRootLifecycle({
				rootUpdate,
				kind: "create",
				catalog: { bodyId: creation.bodyId, fileId: creation.fileId, path: creation.path, previousPath: null,
					lifecycle: "active", bodyGeneration: candidate.durableGeneration, contentHash: metadata.contentHash, size: metadata.size },
				lifecycleReceipt: { operationId: creation.operationId, kind: "create", bodyId: creation.bodyId, fileId: creation.fileId,
					bodyEpoch: candidate.bodyEpoch,
					candidateId: creation.candidateId, candidateDigest: creation.candidateDigest, sourcePath: null, resultPath: creation.path,
					resultLifecycle: "active", durableGeneration: candidate.durableGeneration,
					vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: creation.runtimeEpoch },
				completeCreation: { bodyId: creation.bodyId, candidateId: creation.candidateId, candidateDigest: creation.candidateDigest },
				actorAttributions: [{ actor, operationId: creation.operationId, requestDigest: creation.candidateDigest }],
			});
			this.applyRoot(rootUpdate, commit.generation, creation);
			return "committed";
		} finally {
			this.options.store.releaseRecoveryMutex(owner);
		}
	}

	private admitCreate(input: LifecycleRequest, actor: VaultActorContext, requestDigest: string): Response {
		if (typeof input.path !== "string" || safeMarkdownPath(input.path) !== input.path) return json({ error: "path_required" }, 400);
		const candidateId = input.candidateId!;
		const candidateDigest = input.candidateDigest!.toLowerCase();
		const existing = this.options.store.creationCandidate(input.bodyId);
		if (existing && (existing.operationId !== input.operationId || existing.path !== input.path
			|| existing.candidateId !== candidateId || existing.candidateDigest !== candidateDigest)) {
			return json({ error: "creation_candidate_fence_mismatch" }, 409);
		}
		const pathOwner = this.options.store.activeCatalogHeadAtPath(
			this.options.store.currentSequence(), input.path,
		);
		if (pathOwner) {
			if (existing) {
				this.options.store.completeCreationCandidate(input.bodyId, existing.candidateId, existing.candidateDigest);
			}
			return json({ error: "creation_path_superseded", path: input.path, ownerBodyId: pathOwner.bodyId }, 409);
		}
		if (existing) {
			return json(this.pendingReceipt(existing));
		}
		if (this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), input.bodyId)) return json({ error: "body_identity_already_exists" }, 409);
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		let bodyHead = this.options.store.documentHead(input.bodyId);
		if (!bodyHead) {
			const empty = crdtEngine.createDocument(input.bodyId);
			const commit = this.options.store.commitUpdate({ documentId: input.bodyId,
				update: crdtEngine.encodeStateAsUpdate(empty), kind: "body",
				actorAttributions: [{ actor, operationId: input.operationId, requestDigest }] });
			crdtEngine.destroyDocument(empty);
			bodyHead = {
				generation: commit.generation,
				semanticEpoch: commit.semanticEpoch,
				latestSequence: commit.vaultSequence,
			};
		}
		const fence = this.options.store.expectCreationCandidate({ bodyId: input.bodyId, fileId: input.fileId, path: input.path,
			bodyEpoch: bodyHead.semanticEpoch,
			operationId: input.operationId, candidateId, candidateDigest, durableGeneration: bodyHead.generation,
			vaultSequence: bodyHead.latestSequence, vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch });
		return json(this.pendingReceipt(fence));
	}

	private async commitLifecycle(input: LifecycleRequest, actor: VaultActorContext, requestDigest: string): Promise<Response> {
		if (!await this.options.flush("root")) return json({ error: "root_persistence_unavailable" }, 503);
		if (!await this.options.flush(input.bodyId)) return json({ error: "body_persistence_unavailable" }, 503);
		if (!this.options.validateActor(actor)) return json({ error: "authority_superseded" }, 409);
		const prepared = this.prepareMutation(input);
		if (prepared instanceof Response) return prepared;
		const rootUpdate = this.markerUpdate([input]);
		const commit = this.options.store.commitRootLifecycle({ rootUpdate, kind: input.kind, catalog: prepared.catalog,
			lifecycleReceipt: prepared.receipt, actorAttributions: [{ actor, operationId: input.operationId, requestDigest }] });
		const record = this.options.store.lifecycleRecord(input.operationId)!;
		this.applyRoot(rootUpdate, commit.generation, input);
		if (input.kind === "delete") this.options.sockets().closeBody(input.bodyId);
		this.options.sockets().notifyBodyCommitted(input.bodyId, prepared.receipt.durableGeneration, commit.vaultSequence);
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
		if (head.semanticEpoch !== input.bodyEpoch) return this.bodyEpochMismatch(input.bodyId, input.bodyEpoch, head.semanticEpoch);
		const lifecycle = input.kind === "delete" ? "tombstoned" : "active";
		return {
			catalog: { bodyId: input.bodyId, fileId: input.fileId, path, previousPath: input.kind === "rename" ? current.path : null,
				lifecycle, bodyGeneration: head.generation, contentHash: current.contentHash, size: current.size },
			receipt: { operationId: input.operationId, kind: input.kind as "rename" | "delete" | "revive", bodyId: input.bodyId,
				bodyEpoch: head.semanticEpoch,
				fileId: input.fileId, candidateId: null, candidateDigest: null, sourcePath: current.path, resultPath: path,
				resultLifecycle: lifecycle, durableGeneration: head.generation, vaultGeneration: this.options.vaultGeneration(), runtimeEpoch: this.options.runtimeEpoch },
		};
	}

	private markerUpdate(inputs: LifecycleRequest[]): Uint8Array {
		const release = this.options.cache.reserveFullStateOperation("root", 2);
		try {
			const root = this.options.store.reconstructDocument("root");
			try {
				const vector = crdtEngine.encodeStateVector(root.doc);
				crdtEngine.applyRootOperations(root.doc, inputs.map((input) => ({
					kind: "map-set" as const, root: "__yaosLifecycle", key: input.operationId,
					value: mapValue({ kind: input.kind, fileId: input.fileId, bodyId: input.bodyId,
						path: input.path ?? null, fromPath: input.fromPath ?? null, toPath: input.toPath ?? null }),
				})), "lifecycle-marker");
				return crdtEngine.encodeStateAsUpdate(root.doc, vector);
			} finally { crdtEngine.destroyDocument(root.doc); }
		} finally { release(); }
	}

	private attachmentReplay(operationId: string): Response {
		const release = this.options.cache.reserveFullStateOperation("root", 2);
		let root: ReturnType<VaultStore["reconstructDocument"]>;
		const operation = this.options.store.attachmentOperation(operationId);
		if (!operation) {
			release();
			return json({ error: "attachment_replay_corrupt" }, 500);
		}
		try { root = this.options.store.reconstructDocument("root", operation.rootSequence); }
		catch (error) {
			release();
			throw error;
		}
		try {
			const events = this.options.store.attachmentEventsForOperation(operationId);
			if (events.length === 0 || root.generation !== operation.rootGeneration
				|| root.semanticEpoch !== operation.rootEpoch) return json({ error: "attachment_replay_corrupt" }, 500);
			return this.attachmentReceipt(
				operationId,
				events,
				crdtEngine.encodeStateAsUpdate(root.doc),
				operation.rootSequence,
				operation.rootGeneration,
				operation.rootEpoch,
			);
		} finally {
			crdtEngine.destroyDocument(root.doc);
			release();
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
			|| !Number.isSafeInteger(operation.rootEpoch) || operation.rootEpoch < 1
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
		refs: ReadonlyMap<string, { hash: string; size: number; revision: string }>,
		tombstones: ReadonlyMap<string, AttachmentTombstone>,
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
		refs: ReadonlyMap<string, { hash: string; size: number; revision: string }>,
		metadata: ReadonlyMap<string, { size: number; mime: string; createdAt: number }>,
		tombstones: ReadonlyMap<string, AttachmentTombstone>,
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
		rootEpoch: SemanticEpoch,
	): Response {
		const body = encodeBinaryEnvelope({
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
			rootEpoch,
			rootUpdate: update,
		}, MAX_JSON_BYTES);
		return new Response(body.slice().buffer, { headers: { "content-type": YAOS_BINARY_CONTENT_TYPE, "cache-control": "no-store" } });
	}

	private parseAttachmentMutation(decoded: unknown): AttachmentMutation | null {
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
		const value = decoded as Record<string, unknown>;
		if (!validIdentity(value.operationId)) return null;
		if (!Number.isSafeInteger(value.rootEpoch) || (value.rootEpoch as number) < 1) return null;
		const rootEpoch = parseSemanticEpoch(value.rootEpoch, "attachment root epoch");
		const validRevision = (revision: unknown): revision is string | null => revision === null || validIdentity(revision);
		const exactKeys = (keys: string[]): boolean => {
			const actual = Object.keys(value).sort();
			return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
		};
		if (value.kind === "upsert") {
			const hash = typeof value.hash === "string" ? value.hash.toLowerCase() : "";
			const ref = { hash, size: typeof value.size === "number" ? value.size : -1 };
			if (!exactKeys(["operationId", "kind", "path", "expectedRevision", "hash", "size", "mime", "rootEpoch"])
				|| typeof value.path !== "string" || safeBlobPath(value.path, "", ref) !== value.path
				|| !validRevision(value.expectedRevision) || !/^[a-f0-9]{64}$/.test(hash)
				|| !Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > MAX_BLOB_UPLOAD_BYTES
				|| typeof value.mime !== "string" || !value.mime || value.mime.length > 256) return null;
			return { operationId: value.operationId, kind: "upsert", rootEpoch, path: value.path, expectedRevision: value.expectedRevision,
				hash, size: value.size as number, mime: value.mime };
		}
		if (value.kind === "delete") {
			if (!exactKeys(["operationId", "kind", "path", "expectedRevision", "rootEpoch"])
				|| typeof value.path !== "string" || safeBlobPath(value.path) !== value.path
				|| !validRevision(value.expectedRevision)) return null;
			return { operationId: value.operationId, kind: "delete", rootEpoch, path: value.path, expectedRevision: value.expectedRevision };
		}
		if (value.kind === "rename") {
			if (!exactKeys(["operationId", "kind", "fromPath", "toPath", "expectedFromRevision", "expectedToRevision", "rootEpoch"])
				|| typeof value.fromPath !== "string" || safeBlobPath(value.fromPath) !== value.fromPath
				|| typeof value.toPath !== "string" || safeBlobPath(value.toPath) !== value.toPath
				|| value.fromPath === value.toPath || !validIdentity(value.expectedFromRevision)
				|| !validRevision(value.expectedToRevision)) return null;
			return { operationId: value.operationId, kind: "rename", rootEpoch, fromPath: value.fromPath, toPath: value.toPath,
				expectedFromRevision: value.expectedFromRevision, expectedToRevision: value.expectedToRevision };
		}
		return null;
	}

	private async attachmentRequestDigest(mutation: AttachmentMutation): Promise<string> {
		const bytes = new TextEncoder().encode(canonicalJsonText(mutation));
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
	}

	private async lifecycleRequestDigest(input: LifecycleRequest): Promise<string> {
		const bytes = new TextEncoder().encode(canonicalJsonText(jsonValue(input)));
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
	}

	private attachmentHeadSummary(
		path: string,
		refs: ReadonlyMap<string, { hash: string; size: number; revision: string }>,
		tombstones: ReadonlyMap<string, AttachmentTombstone>,
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
		const release = this.options.cache.reserveFullStateOperation("root", 4);
		let reconstructed: ReturnType<VaultStore["reconstructDocument"]>;
		try { reconstructed = this.options.store.reconstructDocument("root"); }
		catch (error) {
			release();
			throw error;
		}
		const expected = crdtEngine.createDocument("root-publication-expected");
		const actual = crdtEngine.createDocument("root-publication-actual");
		try {
			const baseline = crdtEngine.encodeStateAsUpdate(reconstructed.doc);
			crdtEngine.applyUpdate(expected, baseline);
			crdtEngine.applyUpdate(actual, baseline);
			crdtEngine.applyRootOperations(expected, [
				...records.filter((record) => record.sourcePath).map((record) => ({
					kind: "map-delete" as const, root: "pathToId", key: record.sourcePath!,
				})),
				...records.filter((record) => record.resultLifecycle === "active").map((record) => ({
					kind: "map-set" as const, root: "pathToId", key: record.resultPath, value: mapValue(record.fileId),
				})),
			], "publication-expected");
			crdtEngine.applyUpdate(actual, update);
			return canonicalRootState(expected) === canonicalRootState(actual);
		} catch {
			return false;
		}
		finally {
			crdtEngine.destroyDocument(reconstructed.doc);
			crdtEngine.destroyDocument(expected);
			crdtEngine.destroyDocument(actual);
			release();
		}
	}

	private inputMatchesRecord(input: LifecycleRequest, record: DurableLifecycleRecord): boolean {
		if (input.operationId !== record.operationId || input.kind !== record.kind || input.bodyId !== record.bodyId || input.fileId !== record.fileId
			|| input.bodyEpoch !== record.bodyEpoch
			|| (input.candidateId ?? null) !== record.candidateId || (input.candidateDigest?.toLowerCase() ?? null) !== record.candidateDigest) return false;
		if (input.kind === "create") return record.sourcePath === null && input.path === record.resultPath;
		if (input.kind === "rename") return input.fromPath === record.sourcePath && input.toPath === record.resultPath;
		if (input.kind === "revive") return input.path === record.resultPath;
		return record.sourcePath === record.resultPath;
	}

	private isCurrent(record: DurableLifecycleRecord): boolean {
		const current = this.options.store.getCatalogHeadAt(this.options.store.currentSequence(), record.bodyId);
		return current !== null && current.sequence === record.vaultSequence && current.path === record.resultPath
			&& current.lifecycle === record.resultLifecycle && current.generation === record.durableGeneration
			&& current.bodyEpoch === record.bodyEpoch;
	}

	private receipt(record: DurableLifecycleRecord): LifecycleReceipt {
		return { vaultId: this.options.vaultId(), vaultGeneration: record.vaultGeneration, bodyId: record.bodyId, fileId: record.fileId,
			bodyEpoch: record.bodyEpoch,
			operationId: record.operationId, kind: record.kind, lifecycle: record.resultLifecycle, path: record.resultPath,
			durableGeneration: record.durableGeneration, vaultSequence: record.vaultSequence, runtimeEpoch: record.runtimeEpoch };
	}

	private pendingReceipt(record: PendingCreationCandidate): LifecycleReceipt {
		return { vaultId: this.options.vaultId(), vaultGeneration: record.vaultGeneration, bodyId: record.bodyId, fileId: record.fileId,
			bodyEpoch: record.bodyEpoch,
			operationId: record.operationId, kind: "create", lifecycle: "active", path: record.path,
			durableGeneration: record.durableGeneration, vaultSequence: record.vaultSequence, runtimeEpoch: record.runtimeEpoch };
	}

	private bodyEpochMismatch(bodyId: string, received: SemanticEpoch, expected?: SemanticEpoch): Response {
		const current = expected ?? this.options.store.documentHead(bodyId)?.semanticEpoch ?? INITIAL_SEMANTIC_EPOCH;
		if (current === received) return json({ error: "lifecycle_epoch_identity_mismatch" }, 409);
		const mismatch = new SemanticEpochMismatchError({ purpose: "body", documentId: bodyId,
			expectedBodyEpoch: current, receivedBodyEpoch: received });
		return json(mismatch.toPayload(), mismatch.status);
	}

	private rootEpochMismatch(received: SemanticEpoch, expected: SemanticEpoch): Response {
		const mismatch = new SemanticEpochMismatchError({ purpose: "root", documentId: "root",
			expectedRootEpoch: expected, receivedRootEpoch: received });
		return json(mismatch.toPayload(), mismatch.status);
	}
}
