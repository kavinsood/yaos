import * as Y from "yjs";
import { canonicalCanvasBytes, formatCanvasBytes, parseCanvasBytes } from "@shared/canvasCodec";
import { applyCanvasSnapshot, createCanvasDocument, materializeCanvasDocument, validateCanvasDocument } from "@shared/canvasSemanticDocument";
import { mergeCanvasThreeWay } from "@shared/canvasMerge";
import type { CanvasMergeConflict, CanvasSemanticData, SemanticPathRef } from "@shared/canvasTypes";
import { sha256BytesHex } from "../../utils/sha256";
import { randomId } from "../../utils/randomId";
import type { StoredCanvasCandidate, StoredCanvasLifecycle, StoredCanvasSettlement, StoredDocument } from "../vaultIndexedDb";
import type { CanvasAuthorityReceipt, CanvasCandidateReceipt, CanvasDemotionRequest, CanvasLifecycleReceipt,
	CanvasLifecycleRequest, CanvasPromotionRequest, CanvasState } from "./canvasTransport";

export interface CanvasPersistencePort {
	getDocument(documentId: string): Promise<StoredDocument | null>;
	putDocument(document: StoredDocument): Promise<void>;
	putCanvasCandidate(candidate: StoredCanvasCandidate): Promise<void>;
	listCanvasCandidates(): Promise<StoredCanvasCandidate[]>;
	deleteCanvasCandidate(candidateId: string): Promise<void>;
	putCanvasLifecycle(operation: StoredCanvasLifecycle): Promise<void>;
	listCanvasLifecycle(): Promise<StoredCanvasLifecycle[]>;
	deleteCanvasLifecycle(operationId: string): Promise<void>;
	getCanvasSettlement(documentId: string): Promise<StoredCanvasSettlement | null>;
	putCanvasSettlement(settlement: StoredCanvasSettlement, expectedRevision: number | null): Promise<boolean>;
}

export interface CanvasTransportPort {
	state(documentId: string): Promise<CanvasState>;
	submit(candidate: StoredCanvasCandidate): Promise<CanvasCandidateReceipt>;
	lifecycle(request: CanvasLifecycleRequest): Promise<CanvasLifecycleReceipt>;
	promote?(request: CanvasPromotionRequest): Promise<CanvasAuthorityReceipt>;
	uploadBlob?(hash: string, bytes: ArrayBuffer, mime?: string): Promise<void>;
	demote?(request: CanvasDemotionRequest): Promise<CanvasAuthorityReceipt>;
}

export interface CanvasProviderPort {
	readonly awareness: {
		setLocalStateField(field: string, value: unknown): void;
		destroy(): void;
		getStates(): Map<number, unknown>;
	};
	readonly documentOrigin?: unknown;
	readonly ws: { readonly readyState?: number; terminate?: () => void; close?: () => void } | null;
	readonly wsconnected: boolean;
	readonly wsconnecting: boolean;
	readonly synced: boolean;
	url: string;
	connect(): void | Promise<void>;
	disconnect(): void;
	destroy(): void;
	sendMessage?(message: string): void;
	forceAbort?(): void;
	on(event: "status", callback: (event: { status: string }) => void): void;
	on(event: "sync", callback: (synced: boolean) => void): void;
	on(event: "custom-message", callback: (payload: string) => void): void;
}

export type CanvasProviderFactory = (documentId: string, doc: Y.Doc) => CanvasProviderPort;

export interface CanvasProviderLifecycle {
	created(documentId: string, provider: CanvasProviderPort): void;
	destroyed(documentId: string, provider: CanvasProviderPort): void;
}

export interface CanvasProjectionPort {
	read(path: string): Promise<Uint8Array | null>;
	write(path: string, bytes: Uint8Array): Promise<void>;
	fingerprint?(path: string): Promise<Uint8Array | null>;
	preserveConflict(input: { path: string; documentId: string; bytes: Uint8Array;
		conflicts: readonly CanvasMergeConflict[] }): Promise<boolean>;
}

interface ResidentCanvas {
	documentId: string; path: string; doc: Y.Doc; generation: number; revision: number;
	lastUsedAt: number; encodedBytes: number;
}

interface CanvasLiveSession {
	provider: CanvasProviderPort;
	consumers: Set<string>;
	updateObserver: (update: Uint8Array, origin: unknown) => void;
	projectionWork: Promise<void>;
}

export interface CanvasManagerStats {
	estimatorVersion: "canvas-residency-v1";
	semanticDocuments: number;
	residentDocuments: number;
	liveProviders: number;
	openSockets: number;
	residentEncodedBytes: number;
	estimatedResidentBytes: number;
	nodeRecords: number;
	edgeRecords: number;
	textCodeUnits: number;
	textUtf8Bytes: number;
	orderingRankBytes: number;
	tombstones: number;
	resolvedConflicts: number;
	invalidDocuments: number;
	oversizedDocuments: number;
	conflictDocuments: number;
	degradedDocuments: number;
	pendingDocuments: number;
	pendingSubmissions: number;
}

export interface CanvasLiveReview {
	documentId: string;
	generation: number;
	contentHash: string;
	size: number;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000)));
	}
	return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export class CanvasManager {
	private readonly residents = new Map<string, ResidentCanvas>();
	private readonly pathToDocument = new Map<string, string>();
	private readonly submissions = new Map<string, Promise<void>>();
	private readonly lifecycleSubmissions = new Map<string, Promise<void>>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly refreshes = new Map<string, Promise<void>>();
	private readonly refreshAttempts = new Map<string, number>();
	private readonly pendingDocuments = new Set<string>();
	private readonly pathStates = new Map<string, "semantic" | "invalid" | "oversized" | "conflict" | "degraded">();
	private readonly liveSessions = new Map<string, CanvasLiveSession>();
	private readonly liveConsumers = new Map<string, { documentId: string; revision: number }>();
	private readonly liveConsumerRevisions = new Map<string, number>();
	private liveProvidersPaused = false;
	private disposed = false;
	private ready = false;

	constructor(private readonly vaultGeneration: string, private readonly persistence: CanvasPersistencePort,
		private readonly transport: CanvasTransportPort, private readonly projection: CanvasProjectionPort,
		private readonly now: () => number = Date.now, private readonly maximumResidents = 32,
		private readonly providerFactory?: CanvasProviderFactory,
		private readonly providerLifecycle?: CanvasProviderLifecycle) {}

	async initialize(catalog: Iterable<[string, SemanticPathRef]>): Promise<void> {
		this.replaceCatalog(catalog);
		for (const candidate of await this.persistence.listCanvasCandidates()) {
			this.pendingDocuments.add(candidate.documentId);
			this.scheduleSubmission(candidate);
		}
		for (const operation of await this.persistence.listCanvasLifecycle()) this.scheduleLifecycle(operation);
		for (const documentId of new Set(this.pathToDocument.values())) {
			await this.refresh(documentId).catch(() => undefined);
		}
		this.ready = true;
	}

	replaceCatalog(catalog: Iterable<[string, SemanticPathRef]>): void {
		const previousIds = new Set(this.pathToDocument.values());
		this.pathToDocument.clear();
		for (const [path, ref] of catalog) if (ref.kind === "canvas" && ref.format === "json-canvas" && ref.formatVersion === 1) {
			this.pathToDocument.set(path, ref.documentId);
			if (!this.pathStates.has(path)) this.pathStates.set(path, "semantic");
			const resident = this.residents.get(ref.documentId);
			if (resident && resident.path !== path) { resident.path = path; resident.revision++; }
		}
		for (const resident of this.residents.values()) if (this.pathToDocument.get(resident.path) !== resident.documentId) resident.revision++;
		for (const documentId of this.liveSessions.keys()) if (![...this.pathToDocument.values()].includes(documentId)) {
			this.closeLiveSession(documentId);
		}
		for (const path of [...this.pathStates.keys()]) if (!this.pathToDocument.has(path)) this.pathStates.delete(path);
		for (const documentId of new Set(this.pathToDocument.values())) if (this.ready && !previousIds.has(documentId)) {
			void this.refresh(documentId).catch(() => undefined);
		}
	}

	async setLiveConsumer(consumerId: string, path: string | null): Promise<void> {
		const targetDocumentId = path === null ? null : this.pathToDocument.get(path) ?? null;
		const current = this.liveConsumers.get(consumerId);
		if (targetDocumentId !== null && current?.documentId === targetDocumentId
			&& this.liveSessions.get(targetDocumentId)?.consumers.has(consumerId)) return;
		const revision = (this.liveConsumerRevisions.get(consumerId) ?? 0) + 1;
		this.liveConsumerRevisions.set(consumerId, revision);
		this.releaseLiveConsumer(consumerId);
		if (this.disposed || path === null || !this.providerFactory) return;
		const documentId = targetDocumentId;
		if (!documentId) return;
		const resident = await this.load(documentId, path);
		if (this.disposed || this.liveConsumerRevisions.get(consumerId) !== revision
			|| this.pathToDocument.get(path) !== documentId) return;
		let session = this.liveSessions.get(documentId);
		if (!session) session = this.createLiveSession(resident);
		session.consumers.add(consumerId);
		this.liveConsumers.set(consumerId, { documentId, revision });
		if (!this.liveProvidersPaused && !session.provider.wsconnected && !session.provider.wsconnecting) {
			await session.provider.connect();
		}
	}

	releaseLiveConsumer(consumerId: string): void {
		const current = this.liveConsumers.get(consumerId);
		if (!current) return;
		this.liveConsumers.delete(consumerId);
		const session = this.liveSessions.get(current.documentId);
		if (!session) return;
		session.consumers.delete(consumerId);
		if (session.consumers.size === 0) this.closeLiveSession(current.documentId);
	}

	reconnectLive(documentId: string): void {
		const session = this.liveSessions.get(documentId);
		if (this.liveProvidersPaused || !session || session.consumers.size === 0
			|| session.provider.wsconnected || session.provider.wsconnecting) return;
		void Promise.resolve(session.provider.connect()).catch(() => this.scheduleLiveReconnect(documentId));
	}

	pauseLiveProviders(): void {
		this.liveProvidersPaused = true;
		for (const { provider } of this.activeProviders()) provider.disconnect();
	}

	resumeLiveProviders(): void {
		if (!this.liveProvidersPaused) return;
		this.liveProvidersPaused = false;
		for (const { documentId } of this.activeProviders()) this.reconnectLive(documentId);
	}

	activeProviders(): ReadonlyArray<{ documentId: string; provider: CanvasProviderPort }> {
		return [...this.liveSessions].map(([documentId, session]) => ({ documentId, provider: session.provider }));
	}

	async applyCatalogEvents(events: ReadonlyArray<{ documentId: string; path: string;
		lifecycle: "active" | "tombstoned" | "reaped"; kind: "canvas"; format: "json-canvas"; formatVersion: 1 }>): Promise<void> {
		for (const event of events) {
			for (const [path, documentId] of this.pathToDocument) if (documentId === event.documentId) {
				this.pathToDocument.delete(path);
				this.pathStates.delete(path);
			}
			const resident = this.residents.get(event.documentId);
			if (resident) resident.revision++;
			if (event.lifecycle === "active") {
				this.pathToDocument.set(event.path, event.documentId);
				this.pathStates.set(event.path, "semantic");
				if (resident) resident.path = event.path;
				await this.refresh(event.documentId).catch(() => undefined);
			}
		}
	}

	isSemanticPath(path: string): boolean { return this.pathToDocument.has(path); }
	documentIdForPath(path: string): string | null { return this.pathToDocument.get(path) ?? null; }
	activeEntries(): ReadonlyArray<{ path: string; documentId: string }> {
		return [...this.pathToDocument].map(([path, documentId]) => ({ path, documentId }));
	}
	async findExactRenameSource(bytes: Uint8Array, candidatePaths: readonly string[]): Promise<string | null> {
		const parsed = parseCanvasBytes(bytes);
		if (parsed.kind !== "valid") return null;
		const contentHash = await sha256BytesHex(parsed.canonicalBytes);
		const matches: string[] = [];
		for (const path of candidatePaths) {
			const live = await this.getLive(path).catch(() => null);
			if (live?.contentHash === contentHash && live.size === parsed.canonicalBytes.byteLength) matches.push(path);
			if (matches.length > 1) return null;
		}
		return matches[0] ?? null;
	}
	async getLive(path: string): Promise<CanvasLiveReview | null> {
		const documentId = this.pathToDocument.get(path);
		if (!documentId) return null;
		const state = await this.transport.state(documentId);
		if (this.pathToDocument.get(path) !== documentId) return null;
		return { documentId, generation: state.generation, contentHash: state.contentHash, size: state.size };
	}

	stats(): CanvasManagerStats {
		const estimates = [...this.residents.values()].map((resident) => estimateCanvasResident(resident));
		return { estimatorVersion: "canvas-residency-v1", semanticDocuments: this.pathToDocument.size,
			residentDocuments: this.residents.size,
			liveProviders: this.liveSessions.size,
			openSockets: [...this.liveSessions.values()].filter((session) => session.provider.wsconnected
				&& session.provider.ws?.readyState === 1).length,
			residentEncodedBytes: [...this.residents.values()].reduce((total, resident) => total + resident.encodedBytes, 0),
			estimatedResidentBytes: estimates.reduce((total, estimate) => total + estimate.estimatedBytes, 0),
			nodeRecords: estimates.reduce((total, estimate) => total + estimate.nodes, 0),
			edgeRecords: estimates.reduce((total, estimate) => total + estimate.edges, 0),
			textCodeUnits: estimates.reduce((total, estimate) => total + estimate.textCodeUnits, 0),
			textUtf8Bytes: estimates.reduce((total, estimate) => total + estimate.textUtf8Bytes, 0),
			orderingRankBytes: estimates.reduce((total, estimate) => total + estimate.rankBytes, 0),
			tombstones: estimates.reduce((total, estimate) => total + estimate.tombstones, 0),
			resolvedConflicts: estimates.reduce((total, estimate) => total + estimate.resolvedConflicts, 0),
			invalidDocuments: countCanvasState(this.pathStates, "invalid"),
			oversizedDocuments: countCanvasState(this.pathStates, "oversized"),
			conflictDocuments: countCanvasState(this.pathStates, "conflict"),
			degradedDocuments: countCanvasState(this.pathStates, "degraded"),
			pendingDocuments: this.pendingDocuments.size, pendingSubmissions: this.submissions.size };
	}

	async promote(path: string, bytes: Uint8Array, expected: { revision: string; hash: string; size: number }): Promise<CanvasAuthorityReceipt> {
		if (!this.transport.promote) throw new Error("Canvas promotion is unavailable");
		if (this.pathToDocument.has(path)) throw new Error("Canvas is already semantic");
		const parsed = parseCanvasBytes(bytes);
		if (parsed.kind !== "valid") throw new Error(`Canvas is not eligible for semantic sync: ${parsed.kind}`);
		const sourceHash = await sha256BytesHex(bytes);
		if (sourceHash !== expected.hash || bytes.byteLength !== expected.size) {
			throw new Error("Canvas attachment changed before promotion");
		}
		const contentHash = await sha256BytesHex(parsed.canonicalBytes);
		const documentId = randomId(32);
		const operationId = randomId(32);
		const doc = createCanvasDocument(parsed.data);
		const update = Y.encodeStateAsUpdate(doc);
		const candidateDigest = await sha256BytesHex(update);
		const requestDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify({ operationId, path,
			documentId, sourceRevision: expected.revision, sourceHash: expected.hash, sourceSize: expected.size,
			contentHash, contentSize: parsed.canonicalBytes.byteLength, candidateDigest })));
		doc.destroy();
		const operation: StoredCanvasLifecycle = { operationId, requestDigest, kind: "promote", path, documentId,
			sourceRevision: expected.revision, sourceHash: expected.hash, sourceSize: expected.size,
			contentHash, contentSize: parsed.canonicalBytes.byteLength, candidateDigest,
			encodedUpdateBase64: encodeBase64(update), sourceBytesBase64: encodeBase64(bytes),
			createdAt: this.now(), attempts: 0, lastAttemptAt: null };
		await this.persistence.putCanvasLifecycle(operation);
		try {
			const receipt = await this.submitLifecycle(operation);
			if (!("kind" in receipt) || receipt.kind !== "promote") throw new Error("Canvas promotion receipt mismatch");
			return receipt;
		}
		catch (error) { this.scheduleLifecycleRetry(operation); throw error; }
	}

	async demote(path: string): Promise<CanvasAuthorityReceipt> {
		if (!this.transport.demote || !this.transport.uploadBlob) throw new Error("Canvas demotion is unavailable");
		const documentId = this.pathToDocument.get(path);
		if (!documentId) throw new Error("Canvas is not under semantic authority");
		const resident = await this.load(documentId, path);
		const remote = await this.transport.state(documentId);
		Y.applyUpdate(resident.doc, remote.encodedState, "canvas-demotion-currentness");
		const data = await materializeCanvasDocument(resident.doc, false);
		const bytes = canonicalCanvasBytes(data);
		const contentHash = await sha256BytesHex(bytes);
		if (contentHash !== remote.contentHash || bytes.byteLength !== remote.size) throw new Error("Canvas semantic head changed during demotion");
		const operationId = randomId(32);
		const requestDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify({ operationId, documentId,
			path, generation: remote.generation, contentHash, size: bytes.byteLength })));
		const operation: StoredCanvasLifecycle = { operationId, requestDigest, kind: "demote", documentId, path,
			expectedGeneration: remote.generation, expectedContentHash: contentHash, expectedSize: bytes.byteLength,
			blobHash: contentHash, blobSize: bytes.byteLength, mime: "application/json",
			semanticBytesBase64: encodeBase64(bytes), createdAt: this.now(), attempts: 0, lastAttemptAt: null };
		await this.persistence.putCanvasLifecycle(operation);
		try {
			const receipt = await this.submitLifecycle(operation);
			if (!("kind" in receipt) || receipt.kind !== "demote") throw new Error("Canvas demotion receipt mismatch");
			return receipt;
		}
		catch (error) { this.scheduleLifecycleRetry(operation); throw error; }
	}

	async ingest(path: string, bytes: Uint8Array): Promise<"created" | "updated" | "formatting-only" | "blocked"> {
		if (this.disposed) return "blocked";
		const parsed = parseCanvasBytes(bytes);
		if (parsed.kind !== "valid") {
			this.pathStates.set(path, parsed.kind === "oversized" ? "oversized" : "invalid");
			return "blocked";
		}
		const documentId = this.pathToDocument.get(path);
		if (!documentId) {
			await this.create(path, parsed.data);
			this.pathStates.set(path, "semantic");
			return "created";
		}
		const resident = await this.load(documentId, path);
		const proof = { revision: resident.revision, path: resident.path };
		const shared = await materializeCanvasDocument(resident.doc);
		if (await sha256BytesHex(canonicalCanvasBytes(shared)) === await sha256BytesHex(parsed.canonicalBytes)) {
			if (!this.pendingDocuments.has(documentId)) {
				const remote = await this.transport.state(documentId);
				const contentHash = await sha256BytesHex(parsed.canonicalBytes);
				if (remote.contentHash === contentHash && remote.size === parsed.canonicalBytes.byteLength) {
					await this.settle(resident, parsed.canonicalBytes, bytes, remote.generation, remote.contentHash);
				}
			}
			return "formatting-only";
		}
		const settlement = await this.persistence.getCanvasSettlement(documentId);
		const base = settlement ? this.parseSettlement(settlement) : null;
		const merged = mergeCanvasThreeWay(base, shared, parsed.data);
		if (merged.conflicts.length > 0 && !await this.projection.preserveConflict({ path, documentId, bytes, conflicts: merged.conflicts })) {
			this.pathStates.set(path, "conflict");
			return "blocked";
		}
		if (!this.current(resident, proof)) return "blocked";
		await this.applyAndSubmit(resident, merged.data);
		this.pathStates.set(path, merged.conflicts.length > 0 ? "conflict" : "semantic");
		return "updated";
	}

	async refresh(documentId: string): Promise<void> {
		const current = this.refreshes.get(documentId);
		if (current) return current;
		const work = this.runRefresh(documentId).finally(() => {
			if (this.refreshes.get(documentId) === work) this.refreshes.delete(documentId);
		});
		this.refreshes.set(documentId, work);
		return work;
	}

	private async runRefresh(documentId: string): Promise<void> {
		try {
			await this.refreshOnce(documentId);
			this.refreshAttempts.delete(documentId);
			this.clearRetry(`refresh:${documentId}`);
		} catch (error) {
			const attempts = (this.refreshAttempts.get(documentId) ?? 0) + 1;
			this.refreshAttempts.set(documentId, attempts);
			this.scheduleRetry(`refresh:${documentId}`, attempts,
				() => void this.refresh(documentId).catch(() => undefined));
			throw error;
		}
	}

	private async refreshOnce(documentId: string): Promise<void> {
		const path = [...this.pathToDocument].find((entry) => entry[1] === documentId)?.[0];
		if (!path) return;
		const resident = await this.load(documentId, path);
		const proof = { revision: resident.revision, path };
		const remote = await this.transport.state(documentId);
		if (!this.current(resident, proof)) return;
		Y.applyUpdate(resident.doc, remote.encodedState, "canvas-remote-state");
		const validation = await validateCanvasDocument(resident.doc);
		if (validation) throw new Error(validation);
		resident.generation = remote.generation;
		await this.persist(resident, false);
		let disk: Uint8Array | null;
		try { disk = await this.projection.read(path); }
		catch (error) { this.pathStates.set(path, "degraded"); throw error; }
		if (!this.current(resident, proof)) return;
		if (disk) {
			const parsed = parseCanvasBytes(disk);
			if (parsed.kind !== "valid") {
				this.pathStates.set(path, parsed.kind === "oversized" ? "oversized" : "invalid");
				return;
			}
			const shared = await materializeCanvasDocument(resident.doc);
			const settlement = await this.persistence.getCanvasSettlement(documentId);
			const merged = mergeCanvasThreeWay(settlement ? this.parseSettlement(settlement) : null, shared, parsed.data);
			if (merged.conflicts.length > 0 && !await this.projection.preserveConflict({ path, documentId, bytes: disk,
				conflicts: merged.conflicts })) {
				this.pathStates.set(path, "conflict");
				return;
			}
			const receipt = await this.applyAndSubmit(resident, merged.data);
			if (receipt) {
				remote.generation = receipt.durableGeneration;
				remote.contentHash = receipt.contentHash;
				remote.size = receipt.size;
			}
			this.pathStates.set(path, merged.conflicts.length > 0 ? "conflict" : "semantic");
		}
		const data = await materializeCanvasDocument(resident.doc);
		const canonical = canonicalCanvasBytes(data);
		const formatted = formatCanvasBytes(data);
		if (!this.current(resident, proof)) return;
		try { await this.projection.write(path, formatted); }
		catch (error) { this.pathStates.set(path, "degraded"); throw error; }
		if (!this.current(resident, proof)) return;
		let projectedDisk: Uint8Array | null;
		try { projectedDisk = this.projection.fingerprint ? await this.projection.fingerprint(path) : formatted; }
		catch (error) { this.pathStates.set(path, "degraded"); throw error; }
		if (!projectedDisk || !this.current(resident, proof)) return;
		await this.settle(resident, canonical, projectedDisk, remote.generation, remote.contentHash);
		if (this.pathStates.get(path) !== "conflict") this.pathStates.set(path, "semantic");
	}

	async rename(documentId: string, fromPath: string, toPath: string): Promise<void> {
		await this.lifecycle({ documentId, kind: "rename", fromPath, toPath });
		this.pathToDocument.delete(fromPath);
		this.pathToDocument.set(toPath, documentId);
		const state = this.pathStates.get(fromPath) ?? "semantic";
		this.pathStates.delete(fromPath);
		this.pathStates.set(toPath, state);
		const resident = this.residents.get(documentId);
		if (resident) { resident.path = toPath; resident.revision++; }
	}

	async delete(documentId: string): Promise<void> {
		const resident = this.residents.get(documentId);
		await this.lifecycle({ documentId, kind: "delete" });
		for (const [path, currentDocumentId] of this.pathToDocument) if (currentDocumentId === documentId) {
			this.pathToDocument.delete(path);
			this.pathStates.delete(path);
		}
		if (resident) resident.revision++;
		this.closeLiveSession(documentId);
	}

	private async lifecycle(input: Omit<CanvasLifecycleRequest, "operationId" | "requestDigest">): Promise<void> {
		const operationId = randomId(32);
		const requestDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify({ operationId, ...input })));
		const common = { operationId, requestDigest, documentId: input.documentId,
			createdAt: this.now(), attempts: 0, lastAttemptAt: null };
		const operation: StoredCanvasLifecycle = input.kind === "rename"
			? { ...common, kind: "rename", fromPath: input.fromPath ?? "", toPath: input.toPath ?? "" }
			: input.kind === "revive" ? { ...common, kind: "revive", path: input.path ?? "" }
				: { ...common, kind: "delete" };
		await this.persistence.putCanvasLifecycle(operation);
		try { await this.submitLifecycle(operation); }
		catch (error) { this.scheduleLifecycleRetry(operation); throw error; }
	}

	private async submitLifecycle(operation: StoredCanvasLifecycle): Promise<CanvasLifecycleReceipt | CanvasAuthorityReceipt> {
		operation.attempts++;
		operation.lastAttemptAt = this.now();
		await this.persistence.putCanvasLifecycle(operation);
		try {
			const receipt = operation.kind === "promote" ? await this.submitPromotion(operation)
				: operation.kind === "demote" ? await this.submitDemotion(operation)
				: await this.transport.lifecycle(operation.kind === "rename"
					? { operationId: operation.operationId, requestDigest: operation.requestDigest,
						documentId: operation.documentId, kind: "rename", fromPath: operation.fromPath, toPath: operation.toPath }
					: operation.kind === "revive"
						? { operationId: operation.operationId, requestDigest: operation.requestDigest,
							documentId: operation.documentId, kind: "revive", path: operation.path }
						: { operationId: operation.operationId, requestDigest: operation.requestDigest,
							documentId: operation.documentId, kind: "delete" });
			if (receipt.operationId !== operation.operationId || receipt.requestDigest !== operation.requestDigest
				|| receipt.documentId !== operation.documentId) throw new Error("Canvas lifecycle receipt mismatch");
			await this.persistence.deleteCanvasLifecycle(operation.operationId);
			this.clearRetry(`lifecycle:${operation.operationId}`);
			return receipt;
		} catch (error) {
			this.scheduleLifecycleRetry(operation);
			throw error;
		}
	}

	private async submitPromotion(operation: Extract<StoredCanvasLifecycle, { kind: "promote" }>): Promise<CanvasAuthorityReceipt> {
		if (!this.transport.promote) throw new Error("Canvas promotion is unavailable");
		const update = decodeBase64(operation.encodedUpdateBase64);
		const sourceBytes = decodeBase64(operation.sourceBytesBase64);
		const receipt = await this.transport.promote({ operationId: operation.operationId,
			requestDigest: operation.requestDigest, path: operation.path, documentId: operation.documentId,
			sourceRevision: operation.sourceRevision, sourceHash: operation.sourceHash, sourceSize: operation.sourceSize,
			contentHash: operation.contentHash, contentSize: operation.contentSize,
			candidateDigest: operation.candidateDigest, encodedUpdate: ownedBuffer(update) });
		if (receipt.operationId !== operation.operationId || receipt.requestDigest !== operation.requestDigest
			|| receipt.kind !== "promote" || receipt.documentId !== operation.documentId
			|| receipt.path !== operation.path || receipt.contentHash !== operation.contentHash
			|| receipt.rollbackBlobHash !== operation.sourceHash) throw new Error("Canvas promotion receipt mismatch");
		let resident = this.residents.get(operation.documentId);
		if (!resident) {
			const doc = new Y.Doc({ guid: operation.documentId });
			Y.applyUpdate(doc, update, "canvas-promotion-replay");
			resident = { documentId: operation.documentId, path: operation.path, doc,
				generation: receipt.documentGeneration, revision: 1, lastUsedAt: this.now(), encodedBytes: update.byteLength };
			this.residents.set(operation.documentId, resident);
		} else {
			Y.applyUpdate(resident.doc, update, "canvas-promotion-replay");
			resident.path = operation.path;
			resident.generation = Math.max(resident.generation, receipt.documentGeneration);
		}
		this.pathToDocument.set(operation.path, operation.documentId);
		this.pathStates.set(operation.path, "semantic");
		await this.persist(resident, false);
		const canonical = canonicalCanvasBytes(await materializeCanvasDocument(resident.doc, false));
		if (await sha256BytesHex(canonical) !== receipt.contentHash || canonical.byteLength !== receipt.size) {
			throw new Error("Canvas promotion materialization mismatch");
		}
		await this.settle(resident, canonical, sourceBytes, receipt.documentGeneration, receipt.contentHash);
		return receipt;
	}

	private async submitDemotion(operation: Extract<StoredCanvasLifecycle, { kind: "demote" }>): Promise<CanvasAuthorityReceipt> {
		if (!this.transport.demote || !this.transport.uploadBlob) throw new Error("Canvas demotion is unavailable");
		const bytes = decodeBase64(operation.semanticBytesBase64);
		await this.transport.uploadBlob(operation.blobHash, ownedBuffer(bytes), operation.mime);
		const receipt = await this.transport.demote({ operationId: operation.operationId,
			requestDigest: operation.requestDigest, documentId: operation.documentId, path: operation.path,
			expectedGeneration: operation.expectedGeneration, expectedContentHash: operation.expectedContentHash,
			expectedSize: operation.expectedSize, blobHash: operation.blobHash, blobSize: operation.blobSize,
			mime: operation.mime });
		if (receipt.operationId !== operation.operationId || receipt.requestDigest !== operation.requestDigest
			|| receipt.kind !== "demote" || receipt.documentId !== operation.documentId
			|| receipt.path !== operation.path || receipt.contentHash !== operation.expectedContentHash) {
			throw new Error("Canvas demotion receipt mismatch");
		}
		this.pathToDocument.delete(operation.path);
		this.pathStates.delete(operation.path);
		this.closeLiveSession(operation.documentId);
		const resident = this.residents.get(operation.documentId);
		if (resident) {
			resident.revision++;
			this.residents.delete(operation.documentId);
			resident.doc.destroy();
		}
		return receipt;
	}

	private async create(path: string, data: CanvasSemanticData): Promise<void> {
		const documentId = randomId(32);
		const doc = createCanvasDocument(data);
		const validation = await validateCanvasDocument(doc);
		if (validation) { doc.destroy(); throw new Error(validation); }
		const resident = { documentId, path, doc, generation: 0, revision: 1,
			lastUsedAt: this.now(), encodedBytes: Y.encodeStateAsUpdate(doc).byteLength };
		this.residents.set(documentId, resident);
		this.pathToDocument.set(path, documentId);
		this.pathStates.set(path, "semantic");
		await this.persist(resident, true);
		const operationId = randomId(32);
		const operationDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify({ operationId, documentId, path })));
		const update = Y.encodeStateAsUpdate(doc);
		const candidate = await this.persistCandidate(documentId, update, { createPath: path, operationId, operationDigest });
		await this.submit(candidate, resident);
	}

	private async load(documentId: string, path: string): Promise<ResidentCanvas> {
		const existing = this.residents.get(documentId);
		if (existing) { existing.lastUsedAt = this.now(); return existing; }
		this.evictIfNeeded(documentId);
		const stored = await this.persistence.getDocument(documentId);
		const doc = new Y.Doc({ guid: documentId });
		if (stored) Y.applyUpdate(doc, new Uint8Array(stored.encodedState), "canvas-local-load");
		else {
			const remote = await this.transport.state(documentId);
			Y.applyUpdate(doc, remote.encodedState, "canvas-remote-load");
		}
		const validation = await validateCanvasDocument(doc);
		if (validation) { doc.destroy(); throw new Error(validation); }
		const resident = { documentId, path, doc, generation: stored?.generation ?? 0, revision: 1,
			lastUsedAt: this.now(), encodedBytes: Y.encodeStateAsUpdate(doc).byteLength };
		this.residents.set(documentId, resident);
		return resident;
	}

	private async applyAndSubmit(resident: ResidentCanvas, data: CanvasSemanticData): Promise<CanvasCandidateReceipt | null> {
		const origin = {};
		const updates: Uint8Array[] = [];
		const observer = (update: Uint8Array, updateOrigin: unknown): void => {
			if (updateOrigin === origin) updates.push(update.slice());
		};
		resident.doc.on("update", observer);
		try { await applyCanvasSnapshot(resident.doc, data, randomId(32), origin); }
		finally { resident.doc.off("update", observer); }
		if (updates.length === 0) return null;
		const update = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
		await this.persist(resident, true);
		const candidate = await this.persistCandidate(resident.documentId, update);
		return this.submit(candidate, resident);
	}

	private async persistCandidate(documentId: string, update: Uint8Array,
		creation: Pick<StoredCanvasCandidate, "createPath" | "operationId" | "operationDigest"> = {}): Promise<StoredCanvasCandidate> {
		const candidate: StoredCanvasCandidate = { candidateId: randomId(32), documentId,
			candidateDigest: await sha256BytesHex(update), encodedUpdate: ownedBuffer(update), capturedAt: this.now(),
			attempts: 0, lastAttemptAt: null, ...creation };
		await this.persistence.putCanvasCandidate(candidate);
		this.pendingDocuments.add(documentId);
		return candidate;
	}

	private scheduleSubmission(candidate: StoredCanvasCandidate): void {
		if (this.submissions.has(candidate.candidateId)) return;
		const work = this.load(candidate.documentId, candidate.createPath ?? "")
			.then((resident) => this.submit(candidate, resident))
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => this.submissions.delete(candidate.candidateId));
		this.submissions.set(candidate.candidateId, work);
	}

	private scheduleLifecycle(operation: StoredCanvasLifecycle): void {
		if (this.lifecycleSubmissions.has(operation.operationId)) return;
		const work = this.submitLifecycle(operation)
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => this.lifecycleSubmissions.delete(operation.operationId));
		this.lifecycleSubmissions.set(operation.operationId, work);
	}

	private async submit(candidate: StoredCanvasCandidate, resident: ResidentCanvas): Promise<CanvasCandidateReceipt> {
		candidate.attempts++;
		candidate.lastAttemptAt = this.now();
		await this.persistence.putCanvasCandidate(candidate);
		try {
			const receipt = await this.transport.submit(candidate);
			if (receipt.candidateId !== candidate.candidateId || receipt.candidateDigest !== candidate.candidateDigest
				|| receipt.documentId !== candidate.documentId) throw new Error("Canvas candidate receipt mismatch");
			resident.generation = Math.max(resident.generation, receipt.durableGeneration);
			await this.persistence.deleteCanvasCandidate(candidate.candidateId);
			this.clearRetry(`candidate:${candidate.candidateId}`);
			const stillPending = (await this.persistence.listCanvasCandidates())
				.some((stored) => stored.documentId === candidate.documentId);
			await this.persist(resident, stillPending);
			if (!stillPending) {
				this.pendingDocuments.delete(candidate.documentId);
			}
			return receipt;
		} catch (error) {
			this.scheduleCandidateRetry(candidate);
			throw error;
		}
	}

	private scheduleCandidateRetry(candidate: StoredCanvasCandidate): void {
		this.scheduleRetry(`candidate:${candidate.candidateId}`, candidate.attempts, () => this.scheduleSubmission(candidate));
	}

	private scheduleLifecycleRetry(operation: StoredCanvasLifecycle): void {
		this.scheduleRetry(`lifecycle:${operation.operationId}`, operation.attempts, () => this.scheduleLifecycle(operation));
	}

	private scheduleRetry(key: string, attempts: number, retry: () => void): void {
		if (this.disposed || this.retryTimers.has(key)) return;
		const delay = Math.min(30_000, 500 * (2 ** Math.min(6, Math.max(0, attempts - 1))));
		const timer = setTimeout(() => {
			this.retryTimers.delete(key);
			if (!this.disposed) retry();
		}, delay);
		this.retryTimers.set(key, timer);
	}

	private clearRetry(key: string): void {
		const timer = this.retryTimers.get(key);
		if (timer !== undefined) clearTimeout(timer);
		this.retryTimers.delete(key);
	}

	private async persist(resident: ResidentCanvas, dirty: boolean): Promise<void> {
		const encoded = Y.encodeStateAsUpdate(resident.doc);
		resident.encodedBytes = encoded.byteLength;
		resident.lastUsedAt = this.now();
		await this.persistence.putDocument({ documentId: resident.documentId, generation: resident.generation,
			encodedState: ownedBuffer(encoded), dirty, updatedAt: this.now() });
	}

	private parseSettlement(settlement: StoredCanvasSettlement): CanvasSemanticData | null {
		const parsed = parseCanvasBytes(new Uint8Array(settlement.canonicalContent));
		return parsed.kind === "valid" ? parsed.data : null;
	}

	private async settle(resident: ResidentCanvas, canonical: Uint8Array, disk: Uint8Array,
		durableGeneration: number, serverContentHash: string): Promise<void> {
		const current = await this.persistence.getCanvasSettlement(resident.documentId);
		const contentHash = await sha256BytesHex(canonical);
		const settlement: StoredCanvasSettlement = { format: 1, documentId: resident.documentId,
			vaultGeneration: this.vaultGeneration, canonicalContent: ownedBuffer(canonical), contentHash,
			durableGeneration, serverContentHash, diskFingerprint: { bytes: disk.byteLength, hash: await sha256BytesHex(disk) },
			pathAtSettlement: resident.path, localSettlementRevision: (current?.localSettlementRevision ?? 0) + 1,
			settledAt: this.now() };
		await this.persistence.putCanvasSettlement(settlement, current?.localSettlementRevision ?? null);
	}

	private current(resident: ResidentCanvas, proof: { revision: number; path: string }): boolean {
		return !this.disposed && resident.revision === proof.revision && resident.path === proof.path
			&& this.pathToDocument.get(proof.path) === resident.documentId;
	}

	private evictIfNeeded(incomingDocumentId: string): void {
		while (this.residents.size >= this.maximumResidents && !this.residents.has(incomingDocumentId)) {
			const candidate = [...this.residents.values()]
				.filter((resident) => !this.pendingDocuments.has(resident.documentId) && !this.liveSessions.has(resident.documentId))
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
			if (!candidate) throw new Error("canvas_residency_protected_saturation");
			this.residents.delete(candidate.documentId);
			candidate.revision++;
			candidate.doc.destroy();
		}
	}

	destroy(): void {
		this.disposed = true;
		for (const timer of this.retryTimers.values()) clearTimeout(timer);
		this.retryTimers.clear();
		for (const documentId of [...this.liveSessions.keys()]) this.closeLiveSession(documentId);
		this.liveConsumers.clear();
		this.liveConsumerRevisions.clear();
		for (const resident of this.residents.values()) resident.doc.destroy();
		this.residents.clear();
		this.pathToDocument.clear();
		this.pathStates.clear();
		this.pendingDocuments.clear();
	}

	private createLiveSession(resident: ResidentCanvas): CanvasLiveSession {
		if (!this.providerFactory) throw new Error("Canvas live provider is unavailable");
		const provider = this.providerFactory(resident.documentId, resident.doc);
		let session!: CanvasLiveSession;
		const updateObserver = (_update: Uint8Array, origin: unknown): void => {
			if (origin !== provider.documentOrigin || this.disposed) return;
			session.projectionWork = session.projectionWork
				.then(() => this.projectLiveState(resident))
				.catch(() => undefined);
		};
		resident.doc.on("update", updateObserver);
		session = { provider, consumers: new Set(), updateObserver, projectionWork: Promise.resolve() };
		this.liveSessions.set(resident.documentId, session);
		provider.on("status", ({ status }) => {
			if (status === "connected") this.clearRetry(`provider:${resident.documentId}`);
			else if (status === "disconnected" && session.consumers.size > 0
				&& !this.disposed && !this.liveProvidersPaused) {
				this.scheduleLiveReconnect(resident.documentId);
			}
		});
		provider.on("custom-message", (payload) => {
			if (semanticCommitMatches(payload, resident.documentId)) {
				void this.refresh(resident.documentId).catch(() => undefined);
			}
		});
		this.providerLifecycle?.created(resident.documentId, provider);
		return session;
	}

	private closeLiveSession(documentId: string): void {
		const session = this.liveSessions.get(documentId);
		if (!session) return;
		this.liveSessions.delete(documentId);
		this.clearRetry(`provider:${documentId}`);
		for (const consumerId of session.consumers) this.liveConsumers.delete(consumerId);
		const resident = this.residents.get(documentId);
		resident?.doc.off("update", session.updateObserver);
		session.provider.disconnect();
		this.providerLifecycle?.destroyed(documentId, session.provider);
		session.provider.destroy();
	}

	private scheduleLiveReconnect(documentId: string): void {
		this.scheduleRetry(`provider:${documentId}`, 1, () => this.reconnectLive(documentId));
	}

	private async projectLiveState(resident: ResidentCanvas): Promise<void> {
		const proof = { revision: resident.revision, path: resident.path };
		if (!this.current(resident, proof) || !this.liveSessions.has(resident.documentId)) return;
		const validation = await validateCanvasDocument(resident.doc);
		if (validation) throw new Error(validation);
		await this.persist(resident, true);
		let local: Uint8Array | null;
		try { local = await this.projection.read(proof.path); }
		catch (error) { this.pathStates.set(proof.path, "degraded"); throw error; }
		if (!this.current(resident, proof)) return;
		if (local) {
			const parsed = parseCanvasBytes(local);
			if (parsed.kind !== "valid") {
				this.pathStates.set(proof.path, parsed.kind === "oversized" ? "oversized" : "invalid");
				return;
			}
			const shared = await materializeCanvasDocument(resident.doc);
			const settlement = await this.persistence.getCanvasSettlement(resident.documentId);
			const merged = mergeCanvasThreeWay(settlement ? this.parseSettlement(settlement) : null, shared, parsed.data);
			if (merged.conflicts.length > 0 && !await this.projection.preserveConflict({ path: proof.path,
				documentId: resident.documentId, bytes: local, conflicts: merged.conflicts })) {
				this.pathStates.set(proof.path, "conflict");
				return;
			}
			await this.applyAndSubmit(resident, merged.data);
			this.pathStates.set(proof.path, merged.conflicts.length > 0 ? "conflict" : "semantic");
		}
		const formatted = formatCanvasBytes(await materializeCanvasDocument(resident.doc));
		if (!this.current(resident, proof)) return;
		try { await this.projection.write(proof.path, formatted); }
		catch (error) { this.pathStates.set(proof.path, "degraded"); throw error; }
	}
}

function semanticCommitMatches(payload: string, documentId: string): boolean {
	try {
		const value = JSON.parse(payload) as Record<string, unknown>;
		return value.type === "SEMANTIC_COMMITTED" && value.kind === "canvas" && value.documentId === documentId;
	} catch { return false; }
}

function countCanvasState(states: ReadonlyMap<string, string>, expected: string): number {
	let count = 0;
	for (const state of states.values()) if (state === expected) count++;
	return count;
}

function estimateCanvasResident(resident: ResidentCanvas): { estimatedBytes: number; nodes: number; edges: number;
	textCodeUnits: number; textUtf8Bytes: number; rankBytes: number; tombstones: number; resolvedConflicts: number } {
	const nodes = resident.doc.getMap<Y.Map<unknown>>("nodes");
	const edges = resident.doc.getMap<Y.Map<unknown>>("edges");
	let textCodeUnits = 0;
	let textUtf8Bytes = 0;
	for (const node of nodes.values()) {
		const text = node instanceof Y.Map ? node.get("text") : null;
		if (!(text instanceof Y.Text)) continue;
		const value = text.toString();
		textCodeUnits += value.length;
		textUtf8Bytes += new TextEncoder().encode(value).byteLength;
	}
	let rankBytes = 0;
	for (const rank of resident.doc.getMap<string>("nodeOrder").values()) rankBytes += new TextEncoder().encode(rank).byteLength;
	for (const rank of resident.doc.getMap<string>("edgeOrder").values()) rankBytes += new TextEncoder().encode(rank).byteLength;
	const tombstones = resident.doc.getMap("nodeTombstones").size + resident.doc.getMap("edgeTombstones").size;
	const resolvedConflicts = resident.doc.getMap("resolvedConflicts").size;
	const structuralBytes = nodes.size * 320 + edges.size * 256 + tombstones * 192 + resolvedConflicts * 192
		+ rankBytes + textCodeUnits * 2 + textUtf8Bytes;
	return { estimatedBytes: resident.encodedBytes + structuralBytes + 4096, nodes: nodes.size, edges: edges.size,
		textCodeUnits, textUtf8Bytes, rankBytes, tombstones, resolvedConflicts };
}
