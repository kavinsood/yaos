import * as Y from "yjs";
import {
	VaultMutationRequestError,
	type BodyReceipt,
	type BulkCreateItemOutcome,
	type BulkCreateRequest,
	type BulkCreateResponse,
	type CandidateRecord,
	type SyncAwarenessPort,
	type SyncProviderPort,
	type VaultDatabasePort,
	type VaultServerPort,
} from "../../../src/sync/vaultSync";
import type {
	StoredAttachmentPublicationOperation,
	StoredDocument,
	StoredLifecycleOperation,
} from "../../../src/sync/vaultIndexedDb";
import { partialOf } from "../../mocks/productFixture.ts";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../../src/sync/schema";

/**
 * In-memory model of `POST /lifecycle/create-bulk` with the server's
 * semantics: exact batch replay, partial-overlap rejection, per-path
 * outcomes, a server root that answers with the delta the client lacks, and a
 * candidate endpoint that merges frames into the server's bodies.
 */
export class FakeBulkCreateServer {
	readonly calls: BulkCreateRequest[] = [];
	readonly events: string[] = [];
	readonly root = new Y.Doc({ guid: "fake-server-root" });
	readonly bodies = new Map<string, Y.Doc>();
	readonly blobs = new Set<string>();
	private readonly receipts = new Map<string, { digest: string; response: BulkCreateResponse }>();
	private readonly committedAttachmentOps = new Set<string>();
	private sequence = 0;
	private generation = 0;
	private failures: Array<"before" | "after" | VaultMutationRequestError> = [];
	private gate: Promise<void> | null = null;
	private releaseGate: (() => void) | null = null;
	candidateCalls = 0;

	constructor(readonly options: { vaultGeneration?: string; runtimeEpoch?: string } = {}) {
		this.root.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
		this.root.getMap("sys").set("protocolVersion", PROTOCOL_VERSION);
	}

	get vaultGeneration(): string { return this.options.vaultGeneration ?? "generation-1"; }
	get runtimeEpoch(): string { return this.options.runtimeEpoch ?? "runtime-1"; }

	/** Next request fails before (nothing written) or after (written, response lost) the commit. */
	failNext(stage: "before" | "after" | VaultMutationRequestError): void { this.failures.push(stage); }

	/** Blocks every bulk request until {@link release}. */
	hold(): void {
		this.gate = new Promise((resolve) => { this.releaseGate = resolve; });
	}

	release(): void {
		this.releaseGate?.();
		this.gate = null;
		this.releaseGate = null;
	}

	/** Puts a body at a path as if another device created it. */
	seedExisting(path: string, bodyId: string, text: string): void {
		const doc = new Y.Doc();
		doc.getText("body").insert(0, text);
		this.bodies.set(bodyId, doc);
		this.root.getMap<string>("pathToId").set(path, bodyId);
	}

	/** Port with bulk create and candidates; any other route throws so tests see unexpected traffic. */
	port(overrides: Partial<VaultServerPort> = {}): VaultServerPort {
		return partialOf<VaultServerPort>({
			commitCreateBulk: (request) => this.commitCreateBulk(request),
			submitCandidate: (record) => this.submitCandidate(record),
			publishLifecycleRoot: async () => { throw new Error("bulk create must not publish lifecycle roots"); },
			commitLifecycleBatch: async () => { throw new Error("bulk create must not commit lifecycle batches"); },
			...overrides,
		});
	}

	clearFailures(): void { this.failures = []; }

	bodyText(bodyId: string): string | null {
		return this.bodies.get(bodyId)?.getText("body").toJSON() ?? null;
	}

	async commitCreateBulk(request: BulkCreateRequest): Promise<BulkCreateResponse> {
		this.calls.push(structuredClone(request));
		this.events.push(`bulk:${request.files.map((file) => file.path).concat(request.attachments.map((item) => item.path)).join(",")}`);
		if (this.gate) await this.gate;
		const failure = this.failures.shift();
		if (failure instanceof VaultMutationRequestError) throw failure;
		if (failure === "before") throw new Error("injected bulk outage before commit");
		const response = this.apply(request);
		if (failure === "after") throw new Error("injected bulk outage after commit");
		return response;
	}

	async submitCandidate(record: CandidateRecord): Promise<BodyReceipt> {
		this.candidateCalls++;
		const body = this.bodies.get(record.bodyId);
		this.events.push(`candidate:${record.bodyId}`);
		if (!body) throw new VaultMutationRequestError(409, "body_not_active", "body candidate request");
		const frames = record.encodedUpdates?.length ? record.encodedUpdates : [record.encodedUpdate];
		for (const frame of frames) Y.applyUpdate(body, new Uint8Array(frame));
		return {
			vaultId: record.vaultId, vaultGeneration: this.vaultGeneration, bodyId: record.bodyId,
			bodyEpoch: record.bodyEpoch, clientId: "device-1", candidateId: record.candidateId,
			candidateDigest: record.candidateDigest, durableGeneration: 2, runtimeEpoch: this.runtimeEpoch,
		};
	}

	private digest(request: BulkCreateRequest): string {
		return JSON.stringify({
			files: request.files.map((file) => [file.operationId, file.bodyId, file.path,
				file.updates.map((frame) => Buffer.from(frame).toString("base64"))]),
			attachments: request.attachments,
		});
	}

	private apply(request: BulkCreateRequest): BulkCreateResponse {
		const digest = this.digest(request);
		const stored = this.receipts.get(request.batchId);
		const delta = (): Uint8Array => Y.encodeStateAsUpdate(this.root, request.rootStateVector);
		if (stored) {
			if (stored.digest !== digest) {
				throw new VaultMutationRequestError(409, "bulk_create_batch_identity_mismatch", "bulk create");
			}
			return { ...stored.response, replayed: true, rootUpdate: delta() };
		}
		const overlap = [
			...request.files.filter((file) => this.bodies.has(file.bodyId)).map((file) => file.operationId),
			...request.attachments.filter((item) => this.committedAttachmentOps.has(item.operationId))
				.map((item) => item.operationId),
		];
		if (overlap.length > 0) {
			throw new VaultMutationRequestError(409, "bulk_create_partial_overlap", "bulk create", null, overlap);
		}
		const pathToId = this.root.getMap<string>("pathToId");
		const pathToBlob = this.root.getMap<{ hash: string; size: number; revision: string }>("pathToBlob");
		const outcomes: BulkCreateItemOutcome[] = [];
		const seen = new Set<string>();
		let wrote = false;
		this.root.transact(() => {
			for (const file of request.files) {
				const doc = new Y.Doc();
				for (const frame of file.updates) Y.applyUpdate(doc, frame);
				const text = doc.getText("body").toJSON();
				const base = { kind: "file" as const, operationId: file.operationId, path: file.path };
				if (!file.path.endsWith(".md") || seen.has(file.path)) {
					outcomes.push({ ...base, outcome: "rejected", reason: seen.has(file.path) ? "duplicate_path_in_batch" : "invalid_path" });
					continue;
				}
				seen.add(file.path);
				const existing = pathToId.get(file.path);
				if (existing) {
					const same = this.bodyText(existing) === text;
					outcomes.push({ ...base, outcome: same ? "exists-identical" : "exists-different",
						bodyId: existing, existingBodyId: existing });
					continue;
				}
				this.bodies.set(file.bodyId, doc);
				pathToId.set(file.path, file.bodyId);
				outcomes.push({ ...base, outcome: "created", bodyId: file.bodyId });
				wrote = true;
			}
			for (const item of request.attachments) {
				const base = { kind: "attachment" as const, operationId: item.operationId, path: item.path };
				if (!this.blobs.has(item.hash)) {
					outcomes.push({ ...base, outcome: "rejected", reason: "attachment_blob_missing" });
					continue;
				}
				const existing = pathToBlob.get(item.path);
				if (existing) {
					outcomes.push({ ...base, outcome: existing.hash === item.hash ? "exists-identical" : "exists-different",
						existingRevision: existing.revision });
					continue;
				}
				pathToBlob.set(item.path, { hash: item.hash, size: item.size, revision: item.operationId });
				this.committedAttachmentOps.add(item.operationId);
				outcomes.push({ ...base, outcome: "created" });
				wrote = true;
			}
		});
		if (wrote) {
			this.sequence++;
			this.generation++;
		}
		const response: BulkCreateResponse = {
			batchId: request.batchId, outcomes, vaultSequence: this.sequence, rootGeneration: this.generation,
			rootEpoch: request.rootEpoch, vaultGeneration: this.vaultGeneration, runtimeEpoch: this.runtimeEpoch,
			replayed: false,
		};
		if (wrote) this.receipts.set(request.batchId, { digest, response });
		return { ...response, rootUpdate: delta() };
	}
}

export interface MemoryVault {
	database: VaultDatabasePort;
	documents: Map<string, StoredDocument>;
	candidates: Map<string, CandidateRecord>;
	lifecycle: Map<string, StoredLifecycleOperation>;
	attachments: Map<string, StoredAttachmentPublicationOperation>;
}

/** Minimal durable store with every lifecycle, candidate and attachment method bulk create uses. */
export function memoryVault(): MemoryVault {
	const documents = new Map<string, StoredDocument>();
	const candidates = new Map<string, CandidateRecord>();
	const lifecycle = new Map<string, StoredLifecycleOperation>();
	const attachments = new Map<string, StoredAttachmentPublicationOperation>();
	let attachmentSequence = 0;
	const database = partialOf<VaultDatabasePort>({
		getDocument: async (id) => documents.get(id) ?? null,
		putDocument: async (document) => { documents.set(document.documentId, document); },
		deleteDocument: async (id) => { documents.delete(id); },
		putCandidate: async (candidate) => { candidates.set(candidate.candidateId, candidate); },
		deleteCandidate: async (_bodyId, candidateId) => { candidates.delete(candidateId); },
		listCandidates: async () => [...candidates.values()],
		putLifecycleOperation: async (operation) => { lifecycle.set(operation.operationId, { ...operation }); },
		listLifecycleOperations: async () => [...lifecycle.values()].map((operation) => ({ ...operation })),
		deleteLifecycleOperation: async (operationId) => { lifecycle.delete(operationId); },
		deleteLifecycleOperations: async (operationIds) => { for (const id of operationIds) lifecycle.delete(id); },
		putAttachmentOperation: async (operation) => {
			const stored = operation.localSequence > 0 ? operation : { ...operation, localSequence: ++attachmentSequence };
			attachments.set(stored.mutation.operationId, structuredClone(stored));
			return structuredClone(stored);
		},
		listAttachmentOperations: async () => [...attachments.values()].map((operation) => structuredClone(operation)),
		deleteAttachmentOperation: async (operationId) => { attachments.delete(operationId); },
		close: async () => {},
	});
	return { database, documents, candidates, lifecycle, attachments };
}

export function testProvider(): SyncProviderPort {
	const awareness = partialOf<SyncAwarenessPort>({
		setLocalStateField: () => {}, destroy: () => {}, getStates: () => new Map(),
	});
	return partialOf<SyncProviderPort>({
		awareness, ws: null, wsconnected: false, wsconnecting: false, synced: false,
		url: "ws://test/root", connect: () => {}, disconnect: () => {}, destroy: () => {},
		on: (() => {}) as SyncProviderPort["on"],
	});
}
