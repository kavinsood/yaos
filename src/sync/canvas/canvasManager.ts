import * as Y from "yjs";
import { canonicalCanvasBytes, formatCanvasBytes, parseCanvasBytes } from "@shared/canvasCodec";
import { applyCanvasSnapshot, createCanvasDocument, materializeCanvasDocument, validateCanvasDocument } from "@shared/canvasSemanticDocument";
import { mergeCanvasThreeWay } from "@shared/canvasMerge";
import type { CanvasMergeConflict, CanvasSemanticData, SemanticPathRef } from "@shared/canvasTypes";
import {
	INITIAL_SEMANTIC_EPOCH,
	parseSemanticEpoch,
	parseSemanticEpochResetFrame,
	type SemanticEpoch,
} from "@shared/semanticEpoch";
import { sha256BytesHex } from "../../utils/sha256";
import { randomId } from "../../utils/randomId";
import type { StoredCanvasCandidate, StoredCanvasEpochReplacement, StoredCanvasLifecycle,
	StoredCanvasSettlement, StoredDocument } from "../vaultIndexedDb";
import { CanvasSemanticEpochMismatchError } from "./canvasTransport";
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
	replaceCanvasSemanticEpoch(replacement: StoredCanvasEpochReplacement): Promise<void>;
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

export type CanvasProviderFactory = (documentId: string, bodyEpoch: SemanticEpoch, doc: Y.Doc) => CanvasProviderPort;

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
	documentId: string; path: string; doc: Y.Doc; bodyEpoch: SemanticEpoch; generation: number; revision: number;
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
	bodyEpoch: SemanticEpoch;
	generation: number;
	contentHash: string;
	size: number;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

class CanvasEpochRecoveredError extends Error {
	constructor() { super("Canvas candidate was semantically rebased onto a newer epoch"); }
}

class CanvasLifecycleRetiredError extends Error {
	constructor(kind: StoredCanvasLifecycle["kind"], reason: string) {
		super(`Canvas ${kind} intent was retired: ${reason}`);
	}
}

class CanvasLifecycleReplannedError extends Error {
	constructor(kind: StoredCanvasLifecycle["kind"]) {
		super(`Canvas ${kind} intent was rebound to the current semantic epoch`);
	}
}

export class CanvasManager {
	private readonly residents = new Map<string, ResidentCanvas>();
	private readonly pathToDocument = new Map<string, string>();
	private readonly submissions = new Map<string, Promise<void>>();
	private readonly lifecycleSubmissions = new Map<string, Promise<void>>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly refreshes = new Map<string, Promise<void>>();
	private readonly refreshAttempts = new Map<string, number>();
	private readonly epochRecoveries = new Map<string, Promise<void>>();
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
		private readonly providerLifecycle?: CanvasProviderLifecycle,
		private readonly currentRootEpoch: () => SemanticEpoch = () => INITIAL_SEMANTIC_EPOCH,
		private readonly recoverRootEpoch?: (minimumEpoch: SemanticEpoch) => Promise<void>) {}

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
	bodyEpoch(documentId: string): SemanticEpoch | null {
		return this.residents.get(documentId)?.bodyEpoch ?? null;
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
		return { documentId, bodyEpoch: state.bodyEpoch, generation: state.generation,
			contentHash: state.contentHash, size: state.size };
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
		const bodyEpoch = INITIAL_SEMANTIC_EPOCH;
		const rootEpoch = parseSemanticEpoch(this.currentRootEpoch(), "Canvas promotion root epoch");
		const requestDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify({ operationId, path,
			documentId, sourceRevision: expected.revision, sourceHash: expected.hash, sourceSize: expected.size,
			contentHash, contentSize: parsed.canonicalBytes.byteLength, candidateDigest, bodyEpoch, rootEpoch })));
		doc.destroy();
		const operation: StoredCanvasLifecycle = { operationId, requestDigest, kind: "promote", path, documentId,
			bodyEpoch, rootEpoch,
			sourceRevision: expected.revision, sourceHash: expected.hash, sourceSize: expected.size,
			contentHash, contentSize: parsed.canonicalBytes.byteLength, candidateDigest,
			encodedUpdate: ownedBuffer(update), sourceBytes: ownedBuffer(bytes),
			createdAt: this.now(), attempts: 0, lastAttemptAt: null };
		await this.persistence.putCanvasLifecycle(operation);
		try {
			const receipt = await this.submitLifecycle(operation);
			if (!("kind" in receipt) || receipt.kind !== "promote") throw new Error("Canvas promotion receipt mismatch");
			return receipt;
		}
		catch (error) { if (!(error instanceof CanvasLifecycleRetiredError)) this.scheduleLifecycleRetry(operation); throw error; }
	}

	async demote(path: string): Promise<CanvasAuthorityReceipt> {
		if (!this.transport.demote || !this.transport.uploadBlob) throw new Error("Canvas demotion is unavailable");
		const documentId = this.pathToDocument.get(path);
		if (!documentId) throw new Error("Canvas is not under semantic authority");
		const resident = await this.load(documentId, path);
		const remote = await this.transport.state(documentId);
		if (remote.bodyEpoch > resident.bodyEpoch) {
			await this.recoverSemanticEpoch(documentId, remote.bodyEpoch, remote);
			return this.demote(path);
		}
		if (remote.bodyEpoch < resident.bodyEpoch) throw new Error("Canvas demotion state returned a stale semantic epoch");
		Y.applyUpdate(resident.doc, remote.encodedState, "canvas-demotion-currentness");
		const data = await materializeCanvasDocument(resident.doc, false);
		const bytes = canonicalCanvasBytes(data);
		const contentHash = await sha256BytesHex(bytes);
		if (contentHash !== remote.contentHash || bytes.byteLength !== remote.size) throw new Error("Canvas semantic head changed during demotion");
		const operationId = randomId(32);
		const bodyEpoch = remote.bodyEpoch;
		const rootEpoch = parseSemanticEpoch(this.currentRootEpoch(), "Canvas demotion root epoch");
		const requestDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify({ operationId, documentId,
			path, generation: remote.generation, contentHash, size: bytes.byteLength, bodyEpoch, rootEpoch })));
		const operation: StoredCanvasLifecycle = { operationId, requestDigest, kind: "demote", documentId, path,
			bodyEpoch, rootEpoch,
			expectedGeneration: remote.generation, expectedContentHash: contentHash, expectedSize: bytes.byteLength,
			blobHash: contentHash, blobSize: bytes.byteLength, mime: "application/json",
			semanticBytes: ownedBuffer(bytes), createdAt: this.now(), attempts: 0, lastAttemptAt: null };
		await this.persistence.putCanvasLifecycle(operation);
		try {
			const receipt = await this.submitLifecycle(operation);
			if (!("kind" in receipt) || receipt.kind !== "demote") throw new Error("Canvas demotion receipt mismatch");
			return receipt;
		}
		catch (error) { if (!(error instanceof CanvasLifecycleRetiredError)) this.scheduleLifecycleRetry(operation); throw error; }
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
				if (remote.bodyEpoch > resident.bodyEpoch) {
					await this.recoverSemanticEpoch(documentId, remote.bodyEpoch, remote);
					return "formatting-only";
				}
				if (remote.bodyEpoch < resident.bodyEpoch) throw new Error("Canvas state returned a stale semantic epoch");
				const contentHash = await sha256BytesHex(parsed.canonicalBytes);
				if (remote.contentHash === contentHash && remote.size === parsed.canonicalBytes.byteLength) {
					await this.settle(resident, parsed.canonicalBytes, bytes, remote.generation, remote.contentHash);
				}
			}
			return "formatting-only";
		}
		const settlement = await this.persistence.getCanvasSettlement(documentId);
		const base = settlement?.bodyEpoch === resident.bodyEpoch ? this.parseSettlement(settlement) : null;
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

	async recoverSemanticEpoch(documentId: string, minimumEpoch: SemanticEpoch,
		knownState?: CanvasState): Promise<void> {
		const current = this.epochRecoveries.get(documentId);
		if (current) return current;
		const work = this.runSemanticEpochRecovery(documentId,
			parseSemanticEpoch(minimumEpoch, "Canvas recovery epoch"), knownState)
			.finally(() => {
				if (this.epochRecoveries.get(documentId) === work) this.epochRecoveries.delete(documentId);
			});
		this.epochRecoveries.set(documentId, work);
		return work;
	}

	private async runSemanticEpochRecovery(documentId: string, minimumEpoch: SemanticEpoch,
		knownState?: CanvasState): Promise<void> {
		const path = [...this.pathToDocument].find((entry) => entry[1] === documentId)?.[0];
		if (!path) return;
		const resident = await this.load(documentId, path);
		if (resident.bodyEpoch >= minimumEpoch) return;
		const proof = { revision: resident.revision, path };
		const previousEpoch = resident.bodyEpoch;
		const previousSettlement = await this.persistence.getCanvasSettlement(documentId);
		const base = previousSettlement?.bodyEpoch === previousEpoch
			? this.parseSettlement(previousSettlement)
			: null;
		let local = await materializeCanvasDocument(resident.doc);
		let diskBytes: Uint8Array | null;
		try { diskBytes = await this.projection.read(path); }
		catch (error) { this.pathStates.set(path, "degraded"); throw error; }
		if (diskBytes) {
			const parsedDisk = parseCanvasBytes(diskBytes);
			if (parsedDisk.kind !== "valid") {
				this.pathStates.set(path, parsedDisk.kind === "oversized" ? "oversized" : "invalid");
				throw new Error(`Canvas epoch recovery cannot semantically rebase ${parsedDisk.kind} local bytes`);
			}
			const localMerge = mergeCanvasThreeWay(base, local, parsedDisk.data);
			if (localMerge.conflicts.length > 0 && !await this.projection.preserveConflict({
				path, documentId, bytes: diskBytes, conflicts: localMerge.conflicts,
			})) {
				this.pathStates.set(path, "conflict");
				throw new Error("Canvas epoch recovery conflict was not preserved");
			}
			local = localMerge.data;
		}
		const remote = knownState && knownState.bodyEpoch >= minimumEpoch
			? knownState
			: await this.transport.state(documentId);
		if (remote.documentId !== documentId || remote.bodyEpoch < minimumEpoch
			|| remote.bodyEpoch <= previousEpoch) {
			throw new Error("Canvas semantic epoch recovery returned a stale baseline");
		}
		const authoritativeDoc = new Y.Doc({ guid: documentId });
		try { Y.applyUpdate(authoritativeDoc, remote.encodedState, "canvas-epoch-authoritative-baseline"); }
		catch (error) { authoritativeDoc.destroy(); throw error; }
		const validation = await validateCanvasDocument(authoritativeDoc);
		if (validation) { authoritativeDoc.destroy(); throw new Error(validation); }
		const authoritative = await materializeCanvasDocument(authoritativeDoc, false);
		const authoritativeCanonical = canonicalCanvasBytes(authoritative);
		if (authoritativeCanonical.byteLength !== remote.size
			|| await sha256BytesHex(authoritativeCanonical) !== remote.contentHash) {
			authoritativeDoc.destroy();
			throw new Error("Canvas epoch baseline content proof mismatch");
		}
		authoritativeDoc.destroy();
		const merged = mergeCanvasThreeWay(base, authoritative, local);
		const conflictBytes = diskBytes ?? canonicalCanvasBytes(local);
		if (merged.conflicts.length > 0 && !await this.projection.preserveConflict({
			path, documentId, bytes: conflictBytes, conflicts: merged.conflicts,
		})) {
			this.pathStates.set(path, "conflict");
			throw new Error("Canvas epoch recovery conflict was not preserved");
		}
		if (!this.current(resident, proof)) return;
		const nextDoc = new Y.Doc({ guid: documentId });
		Y.applyUpdate(nextDoc, remote.encodedState, "canvas-epoch-fresh-baseline");
		const origin = {};
		const updates: Uint8Array[] = [];
		const observer = (update: Uint8Array, updateOrigin: unknown): void => {
			if (updateOrigin === origin) updates.push(update.slice());
		};
		nextDoc.on("update", observer);
		try { await applyCanvasSnapshot(nextDoc, merged.data, randomId(32), origin); }
		finally { nextDoc.off("update", observer); }
		const nextValidation = await validateCanvasDocument(nextDoc);
		if (nextValidation) { nextDoc.destroy(); throw new Error(nextValidation); }
		const mergedCanonical = canonicalCanvasBytes(merged.data);
		const update = updates.length === 0 ? null : updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
		const candidate: StoredCanvasCandidate | null = update ? {
			candidateId: randomId(32), documentId, bodyEpoch: remote.bodyEpoch,
			candidateDigest: await sha256BytesHex(update), encodedUpdate: ownedBuffer(update), capturedAt: this.now(),
			attempts: 0, lastAttemptAt: null,
		} : null;
		const encodedState = Y.encodeStateAsUpdate(nextDoc);
		const nextSettlement: StoredCanvasSettlement = {
			format: 1, documentId, bodyEpoch: remote.bodyEpoch, vaultGeneration: this.vaultGeneration,
			canonicalContent: ownedBuffer(authoritativeCanonical),
			contentHash: remote.contentHash, durableGeneration: remote.generation,
			serverContentHash: remote.contentHash,
			diskFingerprint: { bytes: authoritativeCanonical.byteLength, hash: remote.contentHash },
			pathAtSettlement: path,
			localSettlementRevision: (previousSettlement?.localSettlementRevision ?? 0) + 1,
			settledAt: this.now(),
		};
		const pendingLifecycle = (await this.persistence.listCanvasLifecycle())
			.filter((operation) => operation.documentId === documentId);
		const lifecycle: StoredCanvasLifecycle[] = [];
		for (const operation of pendingLifecycle) {
			// Probe the immutable old request before changing its identity.  A
			// response-lost commit replays its exact receipt; only a typed epoch fence
			// proves that the old operation is absent and therefore safe to replan.
			if (await this.probeLifecycleBeforeSemanticReplacement(operation)) continue;
			const rebound = await this.replanLifecycleForSemanticReplacement(
				operation, remote, candidate, mergedCanonical,
			);
			if (rebound) lifecycle.push(rebound);
		}
		const replacement: StoredCanvasEpochReplacement = {
			document: { kind: "semantic", documentId, bodyEpoch: remote.bodyEpoch,
				generation: remote.generation, encodedState: ownedBuffer(encodedState), dirty: candidate !== null,
				updatedAt: this.now() },
			settlement: nextSettlement,
			candidate,
			lifecycle,
		};
		if (!this.current(resident, proof)) { nextDoc.destroy(); return; }
		const staleCandidates = (await this.persistence.listCanvasCandidates())
			.filter((stored) => stored.documentId === documentId);
		if (!this.current(resident, proof)) { nextDoc.destroy(); return; }
		await this.persistence.replaceCanvasSemanticEpoch(replacement);
		for (const stale of staleCandidates) this.clearRetry(`candidate:${stale.candidateId}`);
		for (const operation of replacement.lifecycle) this.clearRetry(`lifecycle:${operation.operationId}`);
		const consumers = [...(this.liveSessions.get(documentId)?.consumers ?? [])];
		this.closeLiveSession(documentId);
		const previousDoc = resident.doc;
		resident.doc = nextDoc;
		resident.bodyEpoch = remote.bodyEpoch;
		resident.generation = remote.generation;
		resident.encodedBytes = encodedState.byteLength;
		resident.lastUsedAt = this.now();
		resident.revision++;
		previousDoc.destroy();
		if (candidate) this.pendingDocuments.add(documentId);
		else this.pendingDocuments.delete(documentId);
		// Do not start rebound lifecycle work until the resident epoch has moved
		// with the atomic disk replacement.  This keeps in-process retries behind
		// the same fence a restart would observe.
		for (const operation of replacement.lifecycle) this.scheduleLifecycle(operation);
		if (consumers.length > 0 && this.providerFactory) {
			const session = this.createLiveSession(resident);
			for (const consumerId of consumers) {
				session.consumers.add(consumerId);
				this.liveConsumers.set(consumerId, {
					documentId,
					revision: this.liveConsumerRevisions.get(consumerId) ?? 0,
				});
			}
			if (!this.liveProvidersPaused) await session.provider.connect();
		}
		const formatted = formatCanvasBytes(merged.data);
		try { await this.projection.write(path, formatted); }
		catch (error) { this.pathStates.set(path, "degraded"); throw error; }
		this.pathStates.set(path, merged.conflicts.length > 0 ? "conflict" : "semantic");
		if (candidate) {
			const receipt = await this.submit(candidate, resident);
			const canonical = canonicalCanvasBytes(await materializeCanvasDocument(resident.doc));
			await this.settle(resident, canonical, formatted, receipt.durableGeneration, receipt.contentHash);
		}
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
		if (remote.bodyEpoch > resident.bodyEpoch) {
			await this.recoverSemanticEpoch(documentId, remote.bodyEpoch, remote);
			return;
		}
		if (remote.bodyEpoch < resident.bodyEpoch) throw new Error("Canvas state returned a stale semantic epoch");
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
			const merged = mergeCanvasThreeWay(settlement?.bodyEpoch === resident.bodyEpoch
				? this.parseSettlement(settlement) : null, shared, parsed.data);
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

	private async lifecycle(input: Omit<CanvasLifecycleRequest, "operationId" | "requestDigest" | "bodyEpoch" | "rootEpoch">): Promise<void> {
		const operationId = randomId(32);
		const bodyEpoch = await this.operationBodyEpoch(input.documentId);
		const rootEpoch = parseSemanticEpoch(this.currentRootEpoch(), "Canvas lifecycle root epoch");
		const requestDigest = await sha256BytesHex(new TextEncoder().encode(JSON.stringify({ operationId, ...input,
			bodyEpoch, rootEpoch })));
		const common = { operationId, requestDigest, documentId: input.documentId,
			bodyEpoch, rootEpoch,
			createdAt: this.now(), attempts: 0, lastAttemptAt: null };
		const operation: StoredCanvasLifecycle = input.kind === "rename"
			? { ...common, kind: "rename", fromPath: input.fromPath ?? "", toPath: input.toPath ?? "" }
			: input.kind === "revive" ? { ...common, kind: "revive", path: input.path ?? "" }
				: { ...common, kind: "delete" };
		await this.persistence.putCanvasLifecycle(operation);
		try { await this.submitLifecycle(operation); }
		catch (error) { if (!(error instanceof CanvasLifecycleRetiredError)) this.scheduleLifecycleRetry(operation); throw error; }
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
						documentId: operation.documentId, bodyEpoch: operation.bodyEpoch, rootEpoch: operation.rootEpoch,
						kind: "rename", fromPath: operation.fromPath, toPath: operation.toPath }
					: operation.kind === "revive"
						? { operationId: operation.operationId, requestDigest: operation.requestDigest,
							documentId: operation.documentId, bodyEpoch: operation.bodyEpoch, rootEpoch: operation.rootEpoch,
							kind: "revive", path: operation.path }
						: { operationId: operation.operationId, requestDigest: operation.requestDigest,
							documentId: operation.documentId, bodyEpoch: operation.bodyEpoch,
							rootEpoch: operation.rootEpoch, kind: "delete" });
			if (receipt.operationId !== operation.operationId || receipt.requestDigest !== operation.requestDigest
				|| receipt.documentId !== operation.documentId || receipt.bodyEpoch !== operation.bodyEpoch
				|| receipt.rootEpoch !== operation.rootEpoch) throw new Error("Canvas lifecycle receipt mismatch");
			await this.persistence.deleteCanvasLifecycle(operation.operationId);
			this.clearRetry(`lifecycle:${operation.operationId}`);
			return receipt;
		} catch (error) {
			if (error instanceof CanvasSemanticEpochMismatchError) {
				const rebound = await this.rebindLifecycleEpoch(operation, error);
				if (!rebound) {
					await this.persistence.deleteCanvasLifecycle(operation.operationId);
					this.clearRetry(`lifecycle:${operation.operationId}`);
					throw new CanvasLifecycleRetiredError(operation.kind, "its semantic identity is already occupied");
				}
				Object.assign(operation, rebound);
				await this.persistence.putCanvasLifecycle(operation);
				this.scheduleLifecycleRetry(operation);
				throw new CanvasLifecycleReplannedError(operation.kind);
			}
			this.scheduleLifecycleRetry(operation);
			throw error;
		}
	}

	private async rebindLifecycleEpoch(operation: StoredCanvasLifecycle,
		error: CanvasSemanticEpochMismatchError): Promise<StoredCanvasLifecycle | null> {
		let bodyEpoch = operation.bodyEpoch;
		let rootEpoch = operation.rootEpoch;
		if (error.mismatch.purpose === "root") {
			if (!this.recoverRootEpoch) throw error;
			await this.recoverRootEpoch(error.mismatch.expectedEpoch);
			rootEpoch = parseSemanticEpoch(this.currentRootEpoch(), "recovered Canvas root epoch");
			if (rootEpoch < error.mismatch.expectedEpoch) throw new Error("Canvas root epoch recovery remained stale");
		} else {
			if (error.mismatch.documentId !== operation.documentId) throw error;
			if (operation.kind === "promote") return null;
			await this.recoverSemanticEpoch(operation.documentId, error.mismatch.expectedEpoch);
			// Body recovery atomically replans or retires every lifecycle operation
			// for this document. Read that decision back instead of rebuilding the
			// old object: an unsafe demotion intentionally omitted from the
			// replacement must stay retired rather than being resurrected here.
			const replacement = (await this.persistence.listCanvasLifecycle())
				.find((candidate) => candidate.operationId === operation.operationId);
			if (!replacement) return null;
			if (replacement.documentId !== operation.documentId
				|| replacement.bodyEpoch < error.mismatch.expectedEpoch) {
				throw new Error("Canvas body epoch recovery returned an invalid lifecycle replacement");
			}
			return replacement;
		}
		return { ...operation, bodyEpoch, rootEpoch,
			requestDigest: await this.lifecycleRequestDigest(operation, bodyEpoch, rootEpoch),
			attempts: 0, lastAttemptAt: null };
	}

	private async replanLifecycleForSemanticReplacement(operation: StoredCanvasLifecycle,
		remote: CanvasState, candidate: StoredCanvasCandidate | null,
		mergedCanonical: Uint8Array): Promise<StoredCanvasLifecycle | null> {
		const rootEpoch = parseSemanticEpoch(this.currentRootEpoch(), "Canvas replacement root epoch");
		if (operation.kind === "promote") {
			// A remotely visible semantic document means this promotion identity is
			// already occupied.  Replaying its epoch-one create update is unsafe.
			return null;
		}
		if (operation.kind === "demote") {
			// Demotion carries exact content bytes.  It can cross a history-only reset
			// only when no semantic rebase candidate is pending and those bytes still
			// identify the authoritative head.  Any content-changing reset retires it.
			const semanticBytes = new Uint8Array(operation.semanticBytes);
			if (candidate || semanticBytes.byteLength !== remote.size
				|| mergedCanonical.byteLength !== remote.size
				|| await sha256BytesHex(semanticBytes) !== remote.contentHash
				|| await sha256BytesHex(mergedCanonical) !== remote.contentHash) return null;
			const rebound: StoredCanvasLifecycle = {
				...operation, bodyEpoch: remote.bodyEpoch, rootEpoch,
				expectedGeneration: remote.generation, expectedContentHash: remote.contentHash,
				expectedSize: remote.size, attempts: 0, lastAttemptAt: null,
			};
			return { ...rebound,
				requestDigest: await this.lifecycleRequestDigest(rebound, rebound.bodyEpoch, rebound.rootEpoch) };
		}
		const rebound: StoredCanvasLifecycle = {
			...operation, bodyEpoch: remote.bodyEpoch, rootEpoch, attempts: 0, lastAttemptAt: null,
		};
		return { ...rebound,
			requestDigest: await this.lifecycleRequestDigest(rebound, rebound.bodyEpoch, rebound.rootEpoch) };
	}

	/** Returns true only when the server replayed an exact durable old-epoch receipt. */
	private async probeLifecycleBeforeSemanticReplacement(operation: StoredCanvasLifecycle): Promise<boolean> {
		try {
			const receipt = operation.kind === "promote"
				? await this.transport.promote?.({
					operationId: operation.operationId, requestDigest: operation.requestDigest,
					path: operation.path, documentId: operation.documentId,
					bodyEpoch: operation.bodyEpoch, rootEpoch: operation.rootEpoch,
					sourceRevision: operation.sourceRevision, sourceHash: operation.sourceHash,
					sourceSize: operation.sourceSize, contentHash: operation.contentHash,
					contentSize: operation.contentSize, candidateDigest: operation.candidateDigest,
					encodedUpdate: operation.encodedUpdate.slice(0),
				})
				: operation.kind === "demote"
					? await this.probeDemotion(operation)
					: await this.transport.lifecycle(operation.kind === "rename"
						? { operationId: operation.operationId, requestDigest: operation.requestDigest,
							documentId: operation.documentId, bodyEpoch: operation.bodyEpoch,
							rootEpoch: operation.rootEpoch, kind: "rename",
							fromPath: operation.fromPath, toPath: operation.toPath }
						: operation.kind === "revive"
							? { operationId: operation.operationId, requestDigest: operation.requestDigest,
								documentId: operation.documentId, bodyEpoch: operation.bodyEpoch,
								rootEpoch: operation.rootEpoch, kind: "revive", path: operation.path }
							: { operationId: operation.operationId, requestDigest: operation.requestDigest,
								documentId: operation.documentId, bodyEpoch: operation.bodyEpoch,
								rootEpoch: operation.rootEpoch, kind: "delete" });
			if (!receipt || receipt.operationId !== operation.operationId
				|| receipt.requestDigest !== operation.requestDigest
				|| receipt.documentId !== operation.documentId
				|| receipt.bodyEpoch !== operation.bodyEpoch
				|| receipt.rootEpoch !== operation.rootEpoch) {
				throw new Error("Canvas lifecycle outcome replay mismatch");
			}
			return true;
		} catch (error) {
			if (!(error instanceof CanvasSemanticEpochMismatchError)) throw error;
			const mismatch = error.mismatch;
			const provesOldRequestAbsent = mismatch.purpose === "body"
				? mismatch.documentId === operation.documentId && mismatch.receivedEpoch === operation.bodyEpoch
				: mismatch.documentId === "root" && mismatch.receivedEpoch === operation.rootEpoch;
			if (!provesOldRequestAbsent) throw error;
			return false;
		}
	}

	private async probeDemotion(operation: Extract<StoredCanvasLifecycle, { kind: "demote" }>): Promise<CanvasAuthorityReceipt> {
		if (!this.transport.demote || !this.transport.uploadBlob) {
			throw new Error("Canvas demotion outcome recovery is unavailable");
		}
		await this.transport.uploadBlob(operation.blobHash, operation.semanticBytes.slice(0), operation.mime);
		return this.transport.demote({ operationId: operation.operationId,
			requestDigest: operation.requestDigest, documentId: operation.documentId, path: operation.path,
			bodyEpoch: operation.bodyEpoch, rootEpoch: operation.rootEpoch,
			expectedGeneration: operation.expectedGeneration,
			expectedContentHash: operation.expectedContentHash, expectedSize: operation.expectedSize,
			blobHash: operation.blobHash, blobSize: operation.blobSize, mime: operation.mime });
	}

	private async lifecycleRequestDigest(operation: StoredCanvasLifecycle, bodyEpoch: SemanticEpoch,
		rootEpoch: SemanticEpoch): Promise<string> {
		let identity: Record<string, unknown>;
		if (operation.kind === "promote") identity = {
			operationId: operation.operationId, path: operation.path, documentId: operation.documentId,
			sourceRevision: operation.sourceRevision, sourceHash: operation.sourceHash, sourceSize: operation.sourceSize,
			contentHash: operation.contentHash, contentSize: operation.contentSize,
			candidateDigest: operation.candidateDigest, bodyEpoch, rootEpoch,
		};
		else if (operation.kind === "demote") identity = {
			operationId: operation.operationId, documentId: operation.documentId, path: operation.path,
			generation: operation.expectedGeneration, contentHash: operation.expectedContentHash,
			size: operation.expectedSize, bodyEpoch, rootEpoch,
		};
		else identity = operation.kind === "rename"
			? { operationId: operation.operationId, documentId: operation.documentId, kind: operation.kind,
				fromPath: operation.fromPath, toPath: operation.toPath, bodyEpoch, rootEpoch }
			: operation.kind === "revive"
				? { operationId: operation.operationId, documentId: operation.documentId, kind: operation.kind,
					path: operation.path, bodyEpoch, rootEpoch }
				: { operationId: operation.operationId, documentId: operation.documentId, kind: operation.kind,
					bodyEpoch, rootEpoch };
		return sha256BytesHex(new TextEncoder().encode(JSON.stringify(identity)));
	}

	private async submitPromotion(operation: Extract<StoredCanvasLifecycle, { kind: "promote" }>): Promise<CanvasAuthorityReceipt> {
		if (!this.transport.promote) throw new Error("Canvas promotion is unavailable");
		const update = new Uint8Array(operation.encodedUpdate);
		const sourceBytes = new Uint8Array(operation.sourceBytes);
		const receipt = await this.transport.promote({ operationId: operation.operationId,
			requestDigest: operation.requestDigest, path: operation.path, documentId: operation.documentId,
			bodyEpoch: operation.bodyEpoch, rootEpoch: operation.rootEpoch,
			sourceRevision: operation.sourceRevision, sourceHash: operation.sourceHash, sourceSize: operation.sourceSize,
			contentHash: operation.contentHash, contentSize: operation.contentSize,
			candidateDigest: operation.candidateDigest, encodedUpdate: ownedBuffer(update) });
		if (receipt.operationId !== operation.operationId || receipt.requestDigest !== operation.requestDigest
			|| receipt.kind !== "promote" || receipt.documentId !== operation.documentId
			|| receipt.bodyEpoch !== operation.bodyEpoch || receipt.rootEpoch !== operation.rootEpoch
			|| receipt.path !== operation.path || receipt.contentHash !== operation.contentHash
			|| receipt.rollbackBlobHash !== operation.sourceHash) throw new Error("Canvas promotion receipt mismatch");
		let resident = this.residents.get(operation.documentId);
		if (!resident) {
			const doc = new Y.Doc({ guid: operation.documentId });
			Y.applyUpdate(doc, update, "canvas-promotion-replay");
			resident = { documentId: operation.documentId, path: operation.path, doc,
				bodyEpoch: INITIAL_SEMANTIC_EPOCH,
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
		const bytes = new Uint8Array(operation.semanticBytes);
		await this.transport.uploadBlob(operation.blobHash, ownedBuffer(bytes), operation.mime);
		const receipt = await this.transport.demote({ operationId: operation.operationId,
			requestDigest: operation.requestDigest, documentId: operation.documentId, path: operation.path,
			bodyEpoch: operation.bodyEpoch, rootEpoch: operation.rootEpoch,
			expectedGeneration: operation.expectedGeneration, expectedContentHash: operation.expectedContentHash,
			expectedSize: operation.expectedSize, blobHash: operation.blobHash, blobSize: operation.blobSize,
			mime: operation.mime });
		if (receipt.operationId !== operation.operationId || receipt.requestDigest !== operation.requestDigest
			|| receipt.kind !== "demote" || receipt.documentId !== operation.documentId
			|| receipt.bodyEpoch !== operation.bodyEpoch || receipt.rootEpoch !== operation.rootEpoch
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

	private async operationBodyEpoch(documentId: string): Promise<SemanticEpoch> {
		const resident = this.residents.get(documentId);
		if (resident) return resident.bodyEpoch;
		const stored = await this.persistence.getDocument(documentId);
		if (stored?.kind === "semantic") return stored.bodyEpoch;
		return (await this.transport.state(documentId)).bodyEpoch;
	}

	private async create(path: string, data: CanvasSemanticData): Promise<void> {
		const documentId = randomId(32);
		const doc = createCanvasDocument(data);
		const validation = await validateCanvasDocument(doc);
		if (validation) { doc.destroy(); throw new Error(validation); }
		const resident = { documentId, path, doc, bodyEpoch: INITIAL_SEMANTIC_EPOCH, generation: 0, revision: 1,
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
		if (stored && stored.kind !== "semantic") throw new Error("Canvas cache has non-semantic epoch metadata");
		const doc = new Y.Doc({ guid: documentId });
		let bodyEpoch: SemanticEpoch;
		let generation: number;
		if (stored) {
			bodyEpoch = parseSemanticEpoch(stored.bodyEpoch, "stored Canvas body epoch");
			generation = stored.generation;
			Y.applyUpdate(doc, new Uint8Array(stored.encodedState), "canvas-local-load");
		}
		else {
			const remote = await this.transport.state(documentId);
			bodyEpoch = remote.bodyEpoch;
			generation = remote.generation;
			Y.applyUpdate(doc, remote.encodedState, "canvas-remote-load");
		}
		const validation = await validateCanvasDocument(doc);
		if (validation) { doc.destroy(); throw new Error(validation); }
		const resident = { documentId, path, doc, bodyEpoch, generation, revision: 1,
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
		try { return await this.submit(candidate, resident); }
		catch (error) {
			if (error instanceof CanvasEpochRecoveredError) return null;
			throw error;
		}
	}

	private async persistCandidate(documentId: string, update: Uint8Array,
		creation: Pick<StoredCanvasCandidate, "createPath" | "operationId" | "operationDigest"> = {}): Promise<StoredCanvasCandidate> {
		const resident = this.residents.get(documentId);
		if (!resident) throw new Error("Canvas candidate requires a resident document");
		const candidate: StoredCanvasCandidate = { candidateId: randomId(32), documentId,
			bodyEpoch: resident.bodyEpoch,
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
		if (candidate.bodyEpoch !== resident.bodyEpoch) {
			await this.persistence.deleteCanvasCandidate(candidate.candidateId);
			this.clearRetry(`candidate:${candidate.candidateId}`);
			throw new Error("stale Canvas candidate semantic epoch");
		}
		candidate.attempts++;
		candidate.lastAttemptAt = this.now();
		await this.persistence.putCanvasCandidate(candidate);
		try {
			const receipt = await this.transport.submit(candidate);
			if (receipt.candidateId !== candidate.candidateId || receipt.candidateDigest !== candidate.candidateDigest
				|| receipt.documentId !== candidate.documentId || receipt.bodyEpoch !== candidate.bodyEpoch
				|| resident.bodyEpoch !== candidate.bodyEpoch) throw new Error("Canvas candidate receipt mismatch");
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
			if (error instanceof CanvasSemanticEpochMismatchError
				&& error.mismatch.expectedEpoch > candidate.bodyEpoch
				&& !this.epochRecoveries.has(candidate.documentId)) {
				await this.recoverSemanticEpoch(candidate.documentId, error.mismatch.expectedEpoch);
				throw new CanvasEpochRecoveredError();
			}
			if (resident.bodyEpoch === candidate.bodyEpoch) this.scheduleCandidateRetry(candidate);
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
		await this.persistence.putDocument({ kind: "semantic", documentId: resident.documentId,
			bodyEpoch: resident.bodyEpoch, generation: resident.generation,
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
			bodyEpoch: resident.bodyEpoch,
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
		const provider = this.providerFactory(resident.documentId, resident.bodyEpoch, resident.doc);
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
			let reset = null;
			try { reset = parseSemanticEpochResetFrame(JSON.parse(payload)); }
			catch { reset = null; }
			if (reset?.purpose === "body" && reset.documentId === resident.documentId
				&& reset.receivedEpoch === resident.bodyEpoch && reset.expectedEpoch > resident.bodyEpoch) {
				void this.recoverSemanticEpoch(resident.documentId, reset.expectedEpoch).catch(() => undefined);
				return;
			}
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
			const merged = mergeCanvasThreeWay(settlement?.bodyEpoch === resident.bodyEpoch
				? this.parseSettlement(settlement) : null, shared, parsed.data);
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
		const value = text.toJSON();
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
