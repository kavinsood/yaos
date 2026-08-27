import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import { BodyManager, type LoadedBody } from "./bodyManager";
import type {
	StoredAttachmentPublicationMutation,
	StoredAttachmentPublicationOperation,
	StoredBodyCandidate,
	StoredBodyReceipt,
	StoredLifecycleOperation,
	StoredDocument,
} from "./vaultIndexedDb";
import { obsidianRequest } from "../utils/http";
import { patchTicketInUrl, TICKET_REFRESH_BUFFER_MS } from "./socketTicket";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "./schema";
import type { BlobMeta, BlobRef, BlobTombstone } from "../types";
import { applyDiffToYText } from "./diff";
import { safeBlobPath, safeMarkdownPath } from "./pathPolicy";
import { ORIGIN_DISK_COMMIT } from "./origins";

import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
export const ROOT_DOCUMENT_ID = "root";

export interface SyncAwarenessPort {
	setLocalStateField(field: string, value: unknown): void;
	destroy(): void;
	getStates(): Map<number, unknown>;
}

export interface SyncProviderPort {
	readonly awareness: SyncAwarenessPort;
	/** Object used as the Y.Doc transaction origin for remote provider updates. */
	readonly documentOrigin?: unknown;
	readonly ws: {
		readonly readyState?: number;
		terminate?: () => void;
		close?: () => void;
	} | null;
	readonly wsconnected: boolean;
	readonly wsconnecting: boolean;
	readonly synced: boolean;
	url: string;
	connect(): void | Promise<void>;
	disconnect(): void;
	destroy(): void;
	on(event: "status", callback: (event: { status: string }) => void): void;
	on(event: "sync", callback: (synced: boolean) => void): void;
	on(event: "custom-message", callback: (payload: string) => void): void;
	on(event: "message", callback: (event: MessageEvent) => void): void;
}

export type FatalSyncCode =
	| "unauthorized"
	| "server_misconfigured"
	| "server_format_unsupported"
	| "unclaimed"
	| "update_required";
export interface FatalSyncDetails {
	clientSchemaVersion: number | null;
	roomSchemaVersion: number | null;
	reason: string | null;
}
export type AttachmentCatalogChange =
	| { kind: "upsert"; path: string; ref: BlobRef; local: boolean }
	| { kind: "tombstone"; path: string; previousHash: string | null; local: boolean };

export type ServerReceiptStartupValidation =
	| "not_started"
	| "validated"
	| "unavailable";

export interface VaultSyncReceiptSnapshot {
	serverAppliedLocalState: boolean | null;
	lastServerReceiptEchoAt: number | null;
	lastKnownServerReceiptEchoAt: number | null;
	candidatePersistenceHealthy: boolean | null;
	candidatePersistenceFailureCount: number;
	hasUnconfirmedCandidate: boolean;
	candidateCapturedAt: number | null;
	serverReceiptStartupValidation: ServerReceiptStartupValidation;
	serverPersistenceDegraded: boolean;
}

export type ReconcileMode = "conservative" | "authoritative";


/** Narrow port consumed by connection, editor, disk, telemetry, and command surfaces. */
export interface SyncRuntimePort {
	readonly provider: SyncProviderPort;
	readonly localReady: boolean;
	readonly connected: boolean;
	readonly connectionGeneration: number;
	readonly deviceId: string;
	readonly fatalAuthError: boolean;
	readonly fatalAuthCode: FatalSyncCode | null;
	readonly fatalAuthDetails: FatalSyncDetails | null;
	readonly lastLocalUpdateAt: number | null;
	readonly hasPendingLocalWork?: boolean;
	readonly lastLocalUpdateWhileConnectedAt: number | null;
	readonly lastRemoteUpdateAt: number | null;
	readonly serverAppliedLocalState: boolean | null;
	readonly lastServerReceiptEchoAt: number | null;
	readonly lastKnownServerReceiptEchoAt: number | null;
	readonly candidatePersistenceHealthy: boolean | null;
	readonly candidatePersistenceFailureCount: number;
	readonly hasUnconfirmedServerReceiptCandidate: boolean;
	readonly serverReceiptCandidateCapturedAt: number | null;
	onProviderSync(callback: (generation: number) => void): void;
	getTextForPath(path: string): Y.Text | null;
	getBodyOrigin(path: string): unknown;
	getBodyAwareness(path: string): SyncAwarenessPort;
	getFileId(path: string): string | undefined;
	getRecoveryLive(path: string): Promise<{
		fileId: string;
		bodyId: string;
		generation: number;
		contentHash: string;
	} | null>;
	getFileIdForText(text: Y.Text): string | undefined;
	ensureFile(path: string, content: string, device?: string): Y.Text | null;
	isPendingRenameTarget(path: string): boolean;
	markPendingRenameTarget(path: string, bodyId: string): void;
	clearPendingRenameTarget(path: string, bodyId?: string): void;
	isMarkdownTombstoned(path: string): boolean;
	acquireEditorBody?(path: string, consumerId: string): Promise<void>;
	isEditorBodyReady?(path: string, consumerId: string): boolean;
	releaseEditorBody?(path: string, consumerId: string): void;
	reconnect?(): void | Promise<void>;
	listAttachmentRefs(): Iterable<[string, BlobRef]>;
	getAttachmentRef(path: string): BlobRef | undefined;
	isAttachmentTombstoned(path: string): boolean;
	setAttachmentRef(path: string, hash: string, size: number, mime: string): void | Promise<void>;
	deleteAttachmentRef(path: string, device?: string): void | Promise<void>;
	renameAttachmentRef(oldPath: string, newPath: string): void | Promise<void>;
	observeAttachmentChanges(callback: (change: AttachmentCatalogChange) => void): () => void;
	destroy(): Promise<void>;
}

export interface BodyHead {
	bodyId: string;
	generation: number;
	contentHash?: string | null;
	size?: number | null;
	lifecycle?: "active" | "tombstoned" | "reaped";
}
export interface BodyState extends BodyHead {
	encodedState: Uint8Array;
}
export type BodyReceipt = StoredBodyReceipt;
export type CandidateRecord = StoredBodyCandidate;
export type LifecycleKind = "create" | "delete" | "revive" | "rename";
export interface LifecycleRequest {
	operationId: string;
	kind: LifecycleKind;
	fileId: string;
	bodyId: string;
	path?: string;
	fromPath?: string;
	toPath?: string;
	candidateId?: string;
	candidateDigest?: string;
}
export interface LifecycleReceipt {
	vaultId: string;
	vaultGeneration: string;
	bodyId: string;
	operationId: string;
	kind: LifecycleKind;
	durableGeneration: number;
	vaultSequence: number;
	runtimeEpoch: string;
}
export type LifecyclePublicationOperation =
	LifecycleRequest & { vaultSequence: number };
export interface RootPublicationReceipt {
	vaultGeneration: string;
	operationIds: string[];
	vaultSequence: number;
	rootGeneration: number;
	runtimeEpoch: string;
}
export interface LifecycleBatchReceipt {
	receipts: LifecycleReceipt[];
	vaultSequence: number;
	runtimeEpoch: string;
}

export interface CandidateBatchReceipt {
	receipts: BodyReceipt[];
	highWater: number;
}
export interface BodyCommittedNotification {
	type: "BODY_COMMITTED";
	bodyId: string;
	vaultGeneration: string;
	durableGeneration: number;
	runtimeEpoch: string;
}
export type VaultControlFrame =
	| {
		type: "VAULT_READY";
		documentId: string;
		vaultGeneration: string;
		durableGeneration: number;
		runtimeEpoch: string;
	}
	| { type: "VAULT_BACKPRESSURE"; reason: string }
	| { type: "VAULT_ERROR"; message: string };
export interface DiskBodyCommitInput {
	bodyId: string;
	path: string;
	content: string;
	reason: string;
	/** Required when the root path is absent; creation and revival are not inferred. */
	lifecycle?: "create" | "revive";
	candidateId?: string;
	admissionStillCurrent?: () => boolean;
}
export interface DiskBodyCommitResult {
	lifecycle: "create" | "revive" | null;
	revived: boolean;
	receipt: BodyReceipt | null;
}
export interface FreshBodyCommitInput {
	bodyId: string;
	path: string;
	content: string;
	reason: string;
	candidateId: string;
	admissionStillCurrent?: () => boolean;
}
export interface FreshBodyCommitResult {
	fileId: string;
	bodyId: string;
	lifecycleOperationId: string;
	receipt: BodyReceipt;
}

export interface FreshBodyBatchCommitResult {
	results: FreshBodyCommitResult[];
}
export interface BodyCandidateCommitInput {
	bodyId: string;
	content: string;
	candidateId: string;
	reason: string;
}
export interface CandidatePersistencePort {
	putCandidate(record: CandidateRecord): Promise<void>;
	deleteCandidate(bodyId: string, candidateId: string): Promise<void>;
	listCandidates(): Promise<CandidateRecord[]>;
	confirmPendingCandidate?(receipt: BodyReceipt): Promise<void>;
}
export interface LifecyclePersistencePort {
	deleteLifecycleOperations?(operationIds: readonly string[]): Promise<void>;
	putLifecycleOperation(operation: StoredLifecycleOperation): Promise<void>;
	listLifecycleOperations(): Promise<StoredLifecycleOperation[]>;
	deleteLifecycleOperation(operationId: string): Promise<void>;
}
export interface AttachmentPersistencePort {
	putAttachmentOperation(operation: StoredAttachmentPublicationOperation): Promise<void>;
	listAttachmentOperations(): Promise<StoredAttachmentPublicationOperation[]>;
	deleteAttachmentOperation(operationId: string): Promise<void>;
}
export type AttachmentPublicationMutation = StoredAttachmentPublicationMutation;
export interface AttachmentPublicationReceipt {
	operationId: string;
	vaultGeneration: string;
	runtimeEpoch: string;
	vaultSequence: number;
	rootGeneration: number;
	rootUpdateBase64Url: string;
}
export interface VaultServerPort {
	currentHead(bodyId: string): Promise<BodyHead | null>;
	currentBody(bodyId: string): Promise<BodyState>;
	submitCandidate(record: CandidateRecord): Promise<BodyReceipt>;
	submitCandidates?(records: readonly CandidateRecord[]): Promise<CandidateBatchReceipt>;
	commitLifecycle(request: LifecycleRequest): Promise<LifecycleReceipt>;
	commitCreateAdmissionsBatch?(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleBatchReceipt>;
	publishLifecycleRoot(
		operations: readonly LifecyclePublicationOperation[],
		rootUpdate: Uint8Array,
	): Promise<RootPublicationReceipt>;
	commitLifecycleBatch(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleBatchReceipt>;
	publishAttachment(mutation: AttachmentPublicationMutation): Promise<AttachmentPublicationReceipt>;
}

export interface ProviderFactoryInput {
	kind: "root" | "body";
	documentId: string;
	doc: Y.Doc;
}
export type ProviderFactory = (input: ProviderFactoryInput) => SyncProviderPort;
export interface SocketTicketResult {
	value: string;
	expiresAt: number;
	localExpiresAt: number;
	ttlMs: number;
}

export interface DocumentPersistencePort {
	getDocument(documentId: string): Promise<StoredDocument | null>;
	putDocument(document: StoredDocument): Promise<void>;
	deleteDocument?(documentId: string): Promise<void>;
	close(): Promise<void>;
}

export type VaultDatabasePort =
	DocumentPersistencePort
	& Partial<CandidatePersistencePort & LifecyclePersistencePort & AttachmentPersistencePort>;

export interface VaultSyncOptions {
	vaultId: string;
	deviceId: string;
	host: string;
	token: string;
	database: VaultDatabasePort;
	server?: VaultServerPort;
	providerFactory?: ProviderFactory;
	getSocketTicket?: (force?: boolean) => Promise<SocketTicketResult | null>;
	maxLoadedBodies?: number;
	candidateDebounceMs?: number;
	bodySyncTimeoutMs?: number;
	candidateMaxWaitMs?: number;
	now?: () => number;
	log?: (message: string) => void;
	onRemoteRootStructuralUpdate?: () => void | Promise<void>;
	onDurableBodyCommitted?: (
		notification: BodyCommittedNotification,
	) => void | Promise<void>;
	onProductEvent?: (event: ProductFlightPathEventInput) => void;
	onControlFrame?: (frame: VaultControlFrame) => void;
}

interface BodySession {
	bodyId: string;
	doc: Y.Doc;
	provider: SyncProviderPort;
	consumers: Set<string>;
	updateObserver: (update: Uint8Array, origin: unknown) => void;
	ready: Promise<void>;
}
interface PendingCandidate {
	record: CandidateRecord;
	submission: Promise<BodyReceipt> | null;
	path: string | null;
}

const BODY_TEXT_NAME = "body";

const DEFAULT_MAX_LOADED_BODIES = 24;
const DEFAULT_CANDIDATE_DEBOUNCE_MS = 250;
export class FreshAdmissionCancelledError extends Error {
	constructor(readonly path: string) {
		super(`fresh admission cancelled for ${path}`);
		this.name = "FreshAdmissionCancelledError";
	}
}

const DEFAULT_CANDIDATE_MAX_WAIT_MS = 2_000;
const DEFAULT_BODY_SYNC_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_TIME_MS = 30_000;
const FATAL_CODES = new Set<FatalSyncCode>([
	"unauthorized",
	"server_misconfigured",
	"server_format_unsupported",
	"unclaimed",
	"update_required",
]);
const ORIGIN_DURABLE_ROOT_PUBLICATION = "durable-root-publication";

export function parseActiveBodyHead(bodyId: string, value: unknown): BodyHead | null {
	if (value === null) return null;
	if (!value || typeof value !== "object") throw new Error("invalid body head response");
	const candidate = value as Partial<BodyHead>;
	if (
		candidate.bodyId !== bodyId
		|| typeof candidate.generation !== "number"
		|| (candidate.lifecycle !== undefined
			&& candidate.lifecycle !== "active"
			&& candidate.lifecycle !== "tombstoned"
			&& candidate.lifecycle !== "reaped")
		|| (candidate.contentHash !== undefined
			&& candidate.contentHash !== null
			&& (typeof candidate.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(candidate.contentHash)))
		|| (candidate.size !== undefined
			&& candidate.size !== null
			&& (typeof candidate.size !== "number" || !Number.isSafeInteger(candidate.size) || candidate.size < 0))
	) throw new Error("invalid body head response");
	if (candidate.lifecycle !== undefined && candidate.lifecycle !== "active") return null;
	return {
		bodyId,
		generation: candidate.generation,
		contentHash: candidate.contentHash,
		size: candidate.size,
		lifecycle: candidate.lifecycle,
	};
}

function asFatalSyncMessage(payload: string): { code: FatalSyncCode; details: FatalSyncDetails } | null {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.type !== "error" || typeof record.code !== "string" || !FATAL_CODES.has(record.code as FatalSyncCode)) {
		return null;
	}
	return {
		code: record.code as FatalSyncCode,
		details: {
			clientSchemaVersion: typeof record.clientSchemaVersion === "number" ? record.clientSchemaVersion : null,
			roomSchemaVersion: typeof record.roomSchemaVersion === "number" ? record.roomSchemaVersion : null,
			reason: typeof record.reason === "string" ? record.reason : null,
		},
	};
}
export function parseVaultControlFrame(payload: string): VaultControlFrame | null {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	switch (record.type) {
		case "VAULT_READY":
			if (
				typeof record.documentId !== "string"
				|| typeof record.vaultGeneration !== "string"
				|| !record.vaultGeneration
				|| !Number.isSafeInteger(record.durableGeneration)
				|| (record.durableGeneration as number) < 0
				|| typeof record.runtimeEpoch !== "string"
				|| !record.runtimeEpoch
			) return null;
			return {
				type: "VAULT_READY",
				documentId: record.documentId,
				vaultGeneration: record.vaultGeneration,
				durableGeneration: record.durableGeneration as number,
				runtimeEpoch: record.runtimeEpoch,
			};
		case "VAULT_BACKPRESSURE":
			return typeof record.reason === "string" && record.reason
				? { type: "VAULT_BACKPRESSURE", reason: record.reason }
				: null;
		case "VAULT_ERROR":
			return typeof record.message === "string" && record.message
				? { type: "VAULT_ERROR", message: record.message }
				: null;
		default:
			return null;
	}
}

function asBodyCommittedNotification(payload: string): BodyCommittedNotification | null {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (
		record.type !== "BODY_COMMITTED"
		|| typeof record.bodyId !== "string"
		|| typeof record.vaultGeneration !== "string"
		|| !record.vaultGeneration
		|| typeof record.durableGeneration !== "number"
		|| !Number.isSafeInteger(record.durableGeneration)
		|| record.durableGeneration < 0
		|| typeof record.runtimeEpoch !== "string"
		|| !record.runtimeEpoch
	) {
		return null;
	}
	return {
		type: "BODY_COMMITTED",
		bodyId: record.bodyId,
		vaultGeneration: record.vaultGeneration,
		durableGeneration: record.durableGeneration,
		runtimeEpoch: record.runtimeEpoch,
	};
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function adaptProvider(provider: YSyncProvider): SyncProviderPort {
	return {
		get awareness() { return provider.awareness; },
		get documentOrigin() { return provider; },
		get wsconnected() { return provider.wsconnected; },
		get wsconnecting() { return provider.wsconnecting; },
		get synced() { return provider.synced; },
		get ws() { return provider.ws; },
		get url() { return provider.url; },
		set url(value: string) { provider.url = value; },
		connect: () => provider.connect(),
		disconnect: () => provider.disconnect(),
		destroy: () => provider.destroy(),
		on: ((event: string, callback: (...values: never[]) => void) => provider.on(event, callback)) as SyncProviderPort["on"],
	};
}

/** Authenticated production HTTP adapter for currentness checks and durable candidates. */
export class VaultSyncHttpPort implements VaultServerPort {
	private readonly base: string;

	constructor(host: string, private readonly vaultId: string, private readonly token: string) {
		this.base = host.replace(/\/$/, "");
	}

	async currentHead(bodyId: string): Promise<BodyHead | null> {
		const response = await obsidianRequest({
			url: `${this.route("head")}/${encodeURIComponent(bodyId)}`,
			method: "GET",
			headers: this.headers(),
		});
		if (response.status === 404) return null;
		if (response.status !== 200) throw new Error(`body head request failed (${response.status})`);
		return parseActiveBodyHead(bodyId, response.json);
	}

	async currentBody(bodyId: string): Promise<BodyState> {
		const response = await obsidianRequest({
			url: `${this.route("body")}/${encodeURIComponent(bodyId)}`,
			method: "GET",
			headers: this.headers(),
		});
		if (response.status !== 200) throw new Error(`body state request failed (${response.status})`);
		const returnedBodyId =
			response.headers["x-yaos-body-id"]
			?? response.headers["X-Yaos-Body-Id"];
		if (returnedBodyId !== bodyId) throw new Error("body state identity mismatch");
		const generation = Number(response.headers["x-yaos-generation"] ?? response.headers["X-Yaos-Generation"]);
		if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("body state omitted generation");
		const contentHash =
			response.headers["x-yaos-content-hash"]
			?? response.headers["X-Yaos-Content-Hash"];
		const sizeHeader =
			response.headers["x-yaos-size"]
			?? response.headers["X-Yaos-Size"];
		if (!contentHash || !/^[a-f0-9]{64}$/.test(contentHash)) {
			throw new Error("body state content hash is missing or invalid");
		}
		if (sizeHeader === undefined) throw new Error("body state size is missing");
		const size = Number(sizeHeader);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error("body state size is invalid");
		}
		return {
			bodyId,
			generation,
			contentHash,
			size,
			encodedState: new Uint8Array(response.arrayBuffer),
		};
	}

	async submitCandidate(record: CandidateRecord): Promise<BodyReceipt> {
		const response = await obsidianRequest({
			url: `${this.route("body")}/${encodeURIComponent(record.bodyId)}/candidate`,
			method: "POST",
			contentType: "application/octet-stream",
			body: record.encodedUpdate.slice(0),
			headers: {
				...this.headers(),
				"x-yaos-candidate-id": record.candidateId,
				"x-yaos-candidate-digest": record.candidateDigest,
			},
		});
		if (response.status !== 200) throw new Error(`body candidate request failed (${response.status})`);
		return response.json as BodyReceipt;
	}

	async commitLifecycle(request: LifecycleRequest): Promise<LifecycleReceipt> {
		const response = await obsidianRequest({
			url: this.route("lifecycle"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify(request),
			headers: this.headers(),
		});
		if (response.status !== 200) {
			throw new Error(`lifecycle commit failed (${response.status})`);
		}
		return response.json as LifecycleReceipt;
	}

	async commitLifecycleBatch(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleBatchReceipt> {
		const response = await obsidianRequest({
			url: this.route("lifecycle/batch"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ operations: requests }),
			headers: this.headers(),
		});
		if (response.status !== 200) {
			throw new Error(`lifecycle batch commit failed (${response.status})`);
		}
		return response.json as LifecycleBatchReceipt;
	}
	async publishLifecycleRoot(
		operations: readonly LifecyclePublicationOperation[],
		rootUpdate: Uint8Array,
	): Promise<RootPublicationReceipt> {
		const response = await obsidianRequest({
			url: this.route("lifecycle/publish"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({
				operations,
				rootUpdateBase64: bytesToBase64(rootUpdate),
			}),
			headers: this.headers(),
		});
		if (response.status !== 200) {
			throw new Error(`lifecycle root publication failed (${response.status})`);
		}
		return response.json as RootPublicationReceipt;
	}

	async publishAttachment(mutation: AttachmentPublicationMutation): Promise<AttachmentPublicationReceipt> {
		const response = await obsidianRequest({
			url: this.route("attachments/publish"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify(mutation),
			headers: this.headers(),
		});
		if (response.status !== 200) throw new Error(`attachment publication failed (${response.status})`);
		return response.json as AttachmentPublicationReceipt;
	}

	private route(resource: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/${resource}`;
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}` };
	}
}

/**
 * Canonical client runtime. Root synchronization and awareness remain on one
 * provider; open Markdown bodies own ordinary reference-counted providers.
 */
export class VaultSync implements SyncRuntimePort {
	readonly ydoc = new Y.Doc({ guid: ROOT_DOCUMENT_ID });
	readonly pathToId = this.ydoc.getMap<string>("pathToId");
	readonly pathToBlob = this.ydoc.getMap<BlobRef>("pathToBlob");
	readonly blobMeta = this.ydoc.getMap<BlobMeta>("blobMeta");
	readonly blobTombstones = this.ydoc.getMap<BlobTombstone & { previousHash?: string | null }>("blobTombstones");
	readonly meta = this.ydoc.getMap<unknown>("meta");
	readonly bodies: BodyManager;
	readonly provider: SyncProviderPort;
	readonly deviceId: string;

	private readonly options: Required<Pick<VaultSyncOptions,
		"maxLoadedBodies" | "candidateDebounceMs" | "candidateMaxWaitMs" | "bodySyncTimeoutMs">> & VaultSyncOptions;
	private readonly server: VaultServerPort;
	private readonly sessions = new Map<string, BodySession>();
	private readonly currentnessChecks = new Map<string, Promise<LoadedBody>>();
	private readonly consumerGenerations = new Map<string, number>();
	private readonly textToBodyId = new WeakMap<Y.Text, string>();
	private readonly pendingCandidates = new Map<string, PendingCandidate>();
	private readonly pendingUpdates = new Map<string, Uint8Array[]>();
	private readonly candidateTimers = new Map<string, number>();
	private readonly candidateMaxWaitTimers = new Map<string, number>();
	private readonly bodyPersistenceWork = new Map<string, Promise<void>>();
	private readonly attachmentOperations = new Map<string, StoredAttachmentPublicationOperation>();
	private readonly attachmentOperationDurability = new Map<string, Promise<void>>();
	private readonly attachmentSubmissions = new Map<string, Promise<void>>();
	private attachmentPublicationWork: Promise<void> = Promise.resolve();
	private readonly providerSyncListeners = new Set<(generation: number) => void>();
	private readonly renameBatch = new Map<string, string>();
	private renameTimer: number | null = null;
	private renameBatchListener: ((renames: Map<string, string>) => void) | null = null;
	private readonly pendingRenameTargets = new Map<string, string>();
	private ticketRefreshTimer: number | null = null;
	private destroyed = false;
	private _localReady = false;
	private _connectionGeneration = 0;
	private _fatalAuthCode: FatalSyncCode | null = null;
	private _fatalAuthDetails: FatalSyncDetails | null = null;
	private _lastLocalUpdateAt: number | null = null;
	private _lastLocalUpdateWhileConnectedAt: number | null = null;
	private _lastRemoteUpdateAt: number | null = null;
	private _lastReceiptAt: number | null = null;
	private _lastCandidateCapturedAt: number | null = null;
	private _candidatePersistenceHealthy: boolean | null = null;
	private readonly recentEvents: Array<{ ts: string; msg: string }> = [];
	private _candidatePersistenceFailureCount = 0;
	private _rootGeneration = 0;
	private submissionPausedUntil = 0;
	private backpressureLevel = 0;

	static async create(options: VaultSyncOptions): Promise<VaultSync> {
		const runtime = new VaultSync(options);
		await runtime.initialize();
		return runtime;
	}

	constructor(options: VaultSyncOptions) {
		this.options = {
			...options,
			maxLoadedBodies: options.maxLoadedBodies ?? DEFAULT_MAX_LOADED_BODIES,
			candidateDebounceMs: options.candidateDebounceMs ?? DEFAULT_CANDIDATE_DEBOUNCE_MS,
			candidateMaxWaitMs: options.candidateMaxWaitMs ?? DEFAULT_CANDIDATE_MAX_WAIT_MS,
			bodySyncTimeoutMs: options.bodySyncTimeoutMs ?? DEFAULT_BODY_SYNC_TIMEOUT_MS,
		};
		this.deviceId = options.deviceId;
		this.server = options.server ?? new VaultSyncHttpPort(options.host, options.vaultId, options.token);
		this.bodies = new BodyManager(options.database, options.now);
		const factory = options.providerFactory ?? ((input) => this.createDefaultProvider(input));
		this.provider = factory({ kind: "root", documentId: ROOT_DOCUMENT_ID, doc: this.ydoc });
		this.wireRootProvider();
	}

	get localReady(): boolean { return this._localReady; }
	get connected(): boolean {
		return this.provider.wsconnected && this.provider.ws?.readyState === 1;
	}
	get hasPendingLocalWork(): boolean {
		const bodyStats = this.bodies.stats();
		return (
			this.candidateTimers.size > 0
			|| this.candidateMaxWaitTimers.size > 0
			|| this.pendingUpdates.size > 0
			|| this.pendingCandidates.size > 0
			|| this.bodyPersistenceWork.size > 0
			|| this.attachmentOperations.size > 0
			|| bodyStats.dirty > 0
			|| bodyStats.unsettled > 0
			|| bodyStats.pendingLocalUpdates > 0
		);
	}
	get connectionGeneration(): number { return this._connectionGeneration; }
	get fatalAuthError(): boolean { return this._fatalAuthCode !== null; }
	get fatalAuthCode(): FatalSyncCode | null { return this._fatalAuthCode; }
	get fatalAuthDetails(): FatalSyncDetails | null { return this._fatalAuthDetails; }
	get lastLocalUpdateAt(): number | null { return this._lastLocalUpdateAt; }
	get lastLocalUpdateWhileConnectedAt(): number | null { return this._lastLocalUpdateWhileConnectedAt; }
	get lastRemoteUpdateAt(): number | null { return this._lastRemoteUpdateAt; }
	get serverAppliedLocalState(): boolean | null {
		return this.pendingCandidates.size > 0 ? false : (this._lastReceiptAt === null ? null : true);
	}
	get lastServerReceiptEchoAt(): number | null { return this._lastReceiptAt; }
	get lastKnownServerReceiptEchoAt(): number | null { return this._lastReceiptAt; }
	get candidatePersistenceHealthy(): boolean | null { return this._candidatePersistenceHealthy; }
	get candidatePersistenceFailureCount(): number { return this._candidatePersistenceFailureCount; }
	get hasUnconfirmedServerReceiptCandidate(): boolean { return this.pendingCandidates.size > 0; }
	get serverReceiptCandidateCapturedAt(): number | null { return this._lastCandidateCapturedAt; }

	get providerSynced(): boolean { return this.provider.synced; }
	get isInitialized(): boolean { return this._localReady; }
	get idbError(): boolean { return false; }
	get idbErrorDetails(): null { return null; }
	get supportedSchemaVersion(): number { return SCHEMA_VERSION; }
	get storedSchemaVersion(): number { return SCHEMA_VERSION; }
	get blobPathCount(): number { return this.pathToBlob.size; }
	get roomGeneration(): number { return this._rootGeneration; }
	get serverReceipt(): VaultSyncReceiptSnapshot { return this.getServerReceiptSnapshot(); }

	getServerReceiptSnapshot(): VaultSyncReceiptSnapshot {
		return {
			serverAppliedLocalState: this.serverAppliedLocalState,
			lastServerReceiptEchoAt: this.lastServerReceiptEchoAt,
			lastKnownServerReceiptEchoAt: this.lastKnownServerReceiptEchoAt,
			candidatePersistenceHealthy: this.candidatePersistenceHealthy,
			candidatePersistenceFailureCount: this.candidatePersistenceFailureCount,
			hasUnconfirmedCandidate: this.hasUnconfirmedServerReceiptCandidate,
			candidateCapturedAt: this.serverReceiptCandidateCapturedAt,
			serverReceiptStartupValidation: this._localReady ? "validated" : "not_started",
			serverPersistenceDegraded: false,
		};
	}

	getActiveMarkdownPaths(): string[] {
		return [...this.pathToId.keys()];
	}

	getPathContent(path: string): string | null {
		return this.getTextForPath(path)?.toJSON() ?? null;
	}

	getSafeReconcileMode(): ReconcileMode {
		return this._localReady ? "authoritative" : "conservative";
	}

	async initialize(): Promise<void> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		const root = await this.options.database.getDocument(ROOT_DOCUMENT_ID);
		if (this.destroyed) throw new Error("runtime closed during initialization");
		this._rootGeneration = root?.generation ?? 0;
		if (root?.encodedState.byteLength) {
			Y.applyUpdate(this.ydoc, new Uint8Array(root.encodedState), "indexeddb-bootstrap");
		}
		if (root && this.ydoc.getMap("sys").get("schemaVersion") !== SCHEMA_VERSION) {
			throw new Error("local root cache is not schema 4");
		}
		await this.restoreCandidates();
		await this.retryLifecycleOperations();
		await this.retryAttachmentOperations();
		this._localReady = true;
		if (this.destroyed) throw new Error("runtime closed during initialization");
		await this.provider.connect();
	}

	waitForLocalPersistence(): Promise<boolean> {
		return Promise.resolve(this._localReady);
	}

	waitForProviderSync(timeoutMs = 10_000): Promise<boolean> {
		if (this.provider.synced) return Promise.resolve(true);
		if (this.fatalAuthError) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timeout);
				resolve(value);
			};
			const timeout = window.setTimeout(() => finish(false), timeoutMs);
			this.provider.on("sync", (synced) => {
				if (synced) finish(true);
			});
		});
	}

	async flushReceiptPersistence(): Promise<void> {
		for (const work of this.bodyPersistenceWork.values()) await work;
	}

	/**
	 * Persists one lifecycle intent, obtains its durable receipt, and only then
	 * publishes the corresponding root mutation.
	 */
	async commitLifecycle(request: LifecycleRequest): Promise<LifecycleReceipt> {
		const receipts = await this.commitStructuralBatch([request]);
		return receipts[0]!;
	}

	/**
	 * Commits every structural operation durably before publishing their root
	 * mutations in one Yjs transaction. This preserves path swaps and folder
	 * rename batches without exposing an intermediate root layout.
	 */
	async commitStructuralBatch(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleReceipt[]> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		if (requests.length === 0) return [];
		const save = this.options.database.putLifecycleOperation;
		const remove = this.options.database.deleteLifecycleOperation;
		const removeBatch = this.options.database.deleteLifecycleOperations;
		if (!save || !remove) throw new Error("lifecycle persistence is unavailable");
		if (requests.length > 1 && !removeBatch) {
			throw new Error("atomic lifecycle batch cleanup is unavailable");
		}
		const batchId = requests.length > 1 ? crypto.randomUUID() : null;
		for (let index = 0; index < requests.length; index++) {
			const request = requests[index]!;
			this.assertLifecyclePaths(request);
			if (
				request.kind === "create"
				&& (!request.candidateId || !request.candidateDigest)
			) {
				throw new Error("fresh create requires an exact candidate fence");
			}
			await save.call(this.options.database, {
				...this.toStoredLifecycleOperation(request),
				batchId,
				batchIndex: batchId ? index : null,
			});
		}
		const receipts = await this.commitLifecycleRequests(requests);
		await this.publishLifecycleRoot(requests, receipts);
		if (requests.length > 1) {
			await removeBatch!.call(
				this.options.database,
				requests.map((request) => request.operationId),
			);
		} else {
			await remove.call(this.options.database, requests[0]!.operationId);
		}
		return receipts;
	}

	onProviderSync(callback: (generation: number) => void): void {
		this.providerSyncListeners.add(callback);
	}

	getFileId(path: string): string | undefined {
		return this.pathToId.get(path);
	}

	async getRecoveryLive(path: string): Promise<{
		fileId: string;
		bodyId: string;
		generation: number;
		contentHash: string;
	} | null> {
		const bodyId = this.getFileId(path);
		if (!bodyId) return null;
		const head = await this.server.currentHead(bodyId);
		if (!head || head.bodyId !== bodyId || typeof head.contentHash !== "string") return null;
		return {
			fileId: bodyId,
			bodyId,
			generation: head.generation,
			contentHash: head.contentHash,
		};
	}

	listAttachmentRefs(): Iterable<[string, BlobRef]> {
		return [...this.pathToBlob.entries()].filter(([path, ref]) =>
			safeBlobPath(path, [], "", ref) !== null
		);
	}

	getAttachmentRef(path: string): BlobRef | undefined {
		const ref = this.pathToBlob.get(path);
		if (!ref || !safeBlobPath(path, [], "", ref)) return undefined;
		const publicationPending = Array.from(this.attachmentOperations.values()).some((operation) =>
			operation.mutation.kind === "upsert"
			&& operation.mutation.path === path
			&& operation.mutation.hash === ref.hash
			&& operation.mutation.size === ref.size
		);
		return publicationPending ? undefined : ref;
	}

	isAttachmentTombstoned(path: string): boolean {
		return safeBlobPath(path) !== null && this.blobTombstones.has(path);
	}

	async setAttachmentRef(path: string, hash: string, size: number, mime: string): Promise<void> {
		const ref = { hash, size };
		const canonical = safeBlobPath(path, [], "", ref);
		if (!canonical) throw new Error(`Invalid attachment path or reference: ${path}`);
		await this.commitAttachmentPublication({
			operationId: crypto.randomUUID(),
			kind: "upsert",
			path: canonical,
			hash,
			size,
			mime,
		});
	}

	async deleteAttachmentRef(path: string, _device?: string): Promise<void> {
		const canonical = safeBlobPath(path);
		if (!canonical) throw new Error(`Invalid attachment path: ${path}`);
		await this.commitAttachmentPublication({
			operationId: crypto.randomUUID(),
			kind: "delete",
			path: canonical,
		});
	}

	async renameAttachmentRef(oldPath: string, newPath: string): Promise<void> {
		const oldCanonical = safeBlobPath(oldPath);
		const ref = oldCanonical ? this.pathToBlob.get(oldCanonical) : undefined;
		const newCanonical = ref ? safeBlobPath(newPath, [], "", ref) : null;
		if (!oldCanonical || !newCanonical) throw new Error("Invalid attachment rename");
		if (oldCanonical === newCanonical || !ref) return;
		await this.commitAttachmentPublication({
			operationId: crypto.randomUUID(),
			kind: "rename",
			fromPath: oldCanonical,
			toPath: newCanonical,
		});
	}

	private async commitAttachmentPublication(
		proposed: AttachmentPublicationMutation,
	): Promise<void> {
		const save = this.options.database.putAttachmentOperation;
		if (!save) throw new Error("attachment publication persistence is unavailable");
		const existing = Array.from(this.attachmentOperations.values()).find((operation) =>
			this.sameAttachmentMutation(operation.mutation, proposed)
		);
		const operation = existing ?? {
			mutation: proposed,
			createdAt: this.now(),
			attempts: 0,
			lastAttemptAt: null,
		};
		if (!existing) {
			this.attachmentOperations.set(proposed.operationId, operation);
			const durability = save.call(this.options.database, operation);
			this.attachmentOperationDurability.set(proposed.operationId, durability);
			try {
				await durability;
			} catch (error) {
				if (this.attachmentOperations.get(proposed.operationId) === operation) {
					this.attachmentOperations.delete(proposed.operationId);
				}
				throw error;
			} finally {
				if (this.attachmentOperationDurability.get(proposed.operationId) === durability) {
					this.attachmentOperationDurability.delete(proposed.operationId);
				}
			}
		} else {
			await this.attachmentOperationDurability.get(existing.mutation.operationId);
		}
		await this.enqueueAttachmentPublication(operation.mutation.operationId);
	}

	private enqueueAttachmentPublication(operationId: string): Promise<void> {
		const existing = this.attachmentSubmissions.get(operationId);
		if (existing) return existing;
		const submission = this.attachmentPublicationWork.then(async () => {
			const operation = this.attachmentOperations.get(operationId);
			if (!operation) return;
			await this.publishStoredAttachmentOperation(operation);
		});
		this.attachmentPublicationWork = submission.catch(() => undefined);
		this.attachmentSubmissions.set(operationId, submission);
		void submission.finally(() => {
			if (this.attachmentSubmissions.get(operationId) === submission) {
				this.attachmentSubmissions.delete(operationId);
			}
		}).catch(() => undefined);
		return submission;
	}

	private async publishStoredAttachmentOperation(
		operation: StoredAttachmentPublicationOperation,
	): Promise<void> {
		const save = this.options.database.putAttachmentOperation;
		const remove = this.options.database.deleteAttachmentOperation;
		if (!save || !remove) throw new Error("attachment publication persistence is unavailable");
		const attempted = {
			...operation,
			attempts: operation.attempts + 1,
			lastAttemptAt: this.now(),
		};
		await save.call(this.options.database, attempted);
		this.attachmentOperations.set(attempted.mutation.operationId, attempted);
		const receipt = await this.server.publishAttachment(attempted.mutation);
		await this.applyAttachmentPublication(attempted.mutation.operationId, receipt);
		await remove.call(this.options.database, attempted.mutation.operationId);
		this.attachmentOperations.delete(attempted.mutation.operationId);
	}

	private async retryAttachmentOperations(): Promise<void> {
		const load = this.options.database.listAttachmentOperations;
		if (!load) throw new Error("attachment publication persistence is unavailable");
		const operations = (await load.call(this.options.database)).sort((left, right) =>
			left.createdAt - right.createdAt
			|| left.mutation.operationId.localeCompare(right.mutation.operationId)
		);
		for (const operation of operations) {
			this.attachmentOperations.set(operation.mutation.operationId, operation);
		}
		for (const operation of operations) {
			try {
				await this.enqueueAttachmentPublication(operation.mutation.operationId);
			} catch (error) {
				this.log(
					`attachment publication remains pending for ${operation.mutation.operationId}: ${String(error)}`,
				);
				break;
			}
		}
	}

	private sameAttachmentMutation(
		left: AttachmentPublicationMutation,
		right: AttachmentPublicationMutation,
	): boolean {
		if (left.kind !== right.kind) return false;
		switch (left.kind) {
			case "upsert":
				return right.kind === "upsert"
					&& left.path === right.path
					&& left.hash === right.hash
					&& left.size === right.size
					&& left.mime === right.mime;
			case "delete":
				return right.kind === "delete" && left.path === right.path;
			case "rename":
				return right.kind === "rename"
					&& left.fromPath === right.fromPath
					&& left.toPath === right.toPath;
		}
	}

	private async applyAttachmentPublication(
		operationId: string,
		receipt: AttachmentPublicationReceipt,
	): Promise<void> {
		if (receipt.operationId !== operationId || !receipt.vaultGeneration || !receipt.runtimeEpoch
			|| !Number.isSafeInteger(receipt.vaultSequence) || receipt.vaultSequence < 0
			|| !Number.isSafeInteger(receipt.rootGeneration) || receipt.rootGeneration < 0
			|| typeof receipt.rootUpdateBase64Url !== "string" || !receipt.rootUpdateBase64Url) {
			throw new Error("attachment publication proof mismatch");
		}
		const update = base64UrlToBytes(receipt.rootUpdateBase64Url);
		Y.applyUpdate(this.ydoc, update, ORIGIN_DURABLE_ROOT_PUBLICATION);
		this._rootGeneration = Math.max(this._rootGeneration, receipt.rootGeneration);
		await this.persistRoot();
	}

	observeAttachmentChanges(callback: (change: AttachmentCatalogChange) => void): () => void {
		const onRefs = (event: Y.YMapEvent<BlobRef>, transaction: Y.Transaction) => {
			const local = transaction.origin !== this.provider.documentOrigin;
			for (const [path, change] of event.changes.keys) {
				if (change.action === "delete") continue;
				const ref = this.pathToBlob.get(path);
				const canonical = ref ? safeBlobPath(path, [], "", ref) : null;
				if (ref && canonical) callback({ kind: "upsert", path: canonical, ref, local });
				else this.log(`quarantined invalid remote attachment path: ${path}`);
			}
		};
		const onTombstones = (
			event: Y.YMapEvent<BlobTombstone & { previousHash?: string | null }>,
			transaction: Y.Transaction,
		) => {
			const local = transaction.origin !== this.provider.documentOrigin;
			for (const [path, change] of event.changes.keys) {
				if (change.action === "delete") continue;
				const canonical = safeBlobPath(path);
				if (!canonical) {
					this.log(`quarantined invalid remote attachment tombstone: ${path}`);
					continue;
				}
				const tombstone = this.blobTombstones.get(path);
				callback({
					kind: "tombstone",
					path: canonical,
					previousHash: tombstone?.previousHash ?? null,
					local,
				});
			}
		};
		this.pathToBlob.observe(onRefs);
		this.blobTombstones.observe(onTombstones);
		return () => {
			this.pathToBlob.unobserve(onRefs);
			this.blobTombstones.unobserve(onTombstones);
		};
	}
	/**
	 * Creates a fresh identity without publishing it empty: local lifecycle and
	 * candidate records first, durable server admission second, durable body
	 * receipt third, and root publication last.
	 */
	async commitFreshBody(
		input: FreshBodyCommitInput,
	): Promise<FreshBodyCommitResult> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		if (input.admissionStillCurrent?.() === false) {
			throw new FreshAdmissionCancelledError(input.path);
		}
		if (this.getFileId(input.path)) throw new Error(`path ${input.path} is already active`);
		const save = this.options.database.putLifecycleOperation;
		const remove = this.options.database.deleteLifecycleOperation;
		if (!save || !remove) throw new Error("lifecycle persistence is unavailable");
		const operationId = crypto.randomUUID();
		const request: LifecycleRequest = {
			operationId,
			kind: "create",
			fileId: input.bodyId,
			bodyId: input.bodyId,
			path: input.path,
		};
		const storedOperation: StoredLifecycleOperation = {
			...this.toStoredLifecycleOperation(request),
			content: input.content,
		};
		await save.call(this.options.database, storedOperation);
		if (input.admissionStillCurrent?.() === false) {
			await remove.call(this.options.database, operationId);
			throw new FreshAdmissionCancelledError(input.path);
		}
		let pending = this.pendingCandidates.get(input.candidateId);
		if (pending && pending.record.bodyId !== input.bodyId) {
			throw new Error("candidate ID belongs to a different body");
		}
		if (!pending) {
			const body = await this.bodies.load(input.bodyId);
			if (input.admissionStillCurrent?.() === false) {
				await remove.call(this.options.database, operationId);
				this.bodies.discardTransient(input.bodyId);
				await this.options.database.deleteDocument?.(input.bodyId);
				throw new FreshAdmissionCancelledError(input.path);
			}
			const text = body.doc.getText(BODY_TEXT_NAME);
			const before = Y.encodeStateVector(body.doc);
			applyDiffToYText(
				text,
				text.toJSON(),
				input.content,
				ORIGIN_DISK_COMMIT,
			);
			pending = await this.captureCandidate(
				input.bodyId,
				Y.encodeStateAsUpdate(body.doc, before),
				input.candidateId,
				0,
				input.path,
			);
		}
		if (input.admissionStillCurrent?.() === false) {
			await this.cancelFreshAdmission(pending, operationId);
			throw new FreshAdmissionCancelledError(input.path);
		}
		request.candidateId = pending.record.candidateId;
		request.candidateDigest = pending.record.candidateDigest;
		const admissionReceipt = await this.server.commitLifecycle(request);
		this.validateLifecycleReceipt(request, admissionReceipt);
		if (input.admissionStillCurrent?.() === false) {
			await this.cancelFreshAdmission(pending, operationId);
			throw new FreshAdmissionCancelledError(input.path);
		}
		const receipt = await this.submitCandidate(pending);
		await save.call(this.options.database, {
			...storedOperation,
			content: null,
		});
		const lifecycleReceipt = await this.server.commitLifecycle(request);
		this.validateLifecycleReceipt(request, lifecycleReceipt);
		if (lifecycleReceipt.vaultSequence < admissionReceipt.vaultSequence) {
			throw new Error("fresh lifecycle final sequence regressed");
		}
		await this.publishLifecycleRoot([request], [lifecycleReceipt]);
		await remove.call(this.options.database, operationId);
		this.log(`fresh body committed for ${input.path} (${input.reason})`);
		return {
			fileId: input.bodyId,
			bodyId: input.bodyId,
			lifecycleOperationId: operationId,
			receipt,
		};
	}

	/**
	 * Initial import path: one bounded admission request, one candidate request,
	 * one lifecycle readback, and one root publication for the whole batch.
	 * Durable local operations remain resumable if any network step fails.
	 */
	async commitFreshBodies(
		inputs: readonly FreshBodyCommitInput[],
	): Promise<FreshBodyBatchCommitResult> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		if (inputs.length === 0) return { results: [] };
		if (inputs.length > 100) throw new Error("fresh body batch exceeds 100 items");
		const save = this.options.database.putLifecycleOperation;
		const removeBatch = this.options.database.deleteLifecycleOperations;
		if (!save || !removeBatch) throw new Error("batch lifecycle persistence is unavailable");
		const paths = new Set<string>();
		const bodyIds = new Set<string>();
		const candidateIds = new Set<string>();
		const prepared: Array<{
			input: FreshBodyCommitInput;
			request: LifecycleRequest;
			pending: PendingCandidate;
		}> = [];
		const batchId = crypto.randomUUID();
		for (let index = 0; index < inputs.length; index++) {
			const input = inputs[index]!;
			if (input.admissionStillCurrent?.() === false) {
				throw new FreshAdmissionCancelledError(input.path);
			}
			if (
				this.getFileId(input.path)
				|| paths.has(input.path)
				|| bodyIds.has(input.bodyId)
				|| candidateIds.has(input.candidateId)
			) {
				throw new Error(`duplicate or active fresh body batch item: ${input.path}`);
			}
			paths.add(input.path);
			bodyIds.add(input.bodyId);
			candidateIds.add(input.candidateId);
			const operationId = crypto.randomUUID();
			const request: LifecycleRequest = {
				operationId,
				kind: "create",
				fileId: input.bodyId,
				bodyId: input.bodyId,
				path: input.path,
			};
			await save.call(this.options.database, {
				...this.toStoredLifecycleOperation(request),
				content: input.content,
				batchId,
				batchIndex: index,
			});
			const body = await this.bodies.load(input.bodyId);
			const text = body.doc.getText(BODY_TEXT_NAME);
			const before = Y.encodeStateVector(body.doc);
			applyDiffToYText(text, text.toJSON(), input.content, ORIGIN_DISK_COMMIT);
			const pending = await this.captureCandidate(
				input.bodyId,
				Y.encodeStateAsUpdate(body.doc, before),
				input.candidateId,
				0,
				input.path,
			);
			request.candidateId = pending.record.candidateId;
			request.candidateDigest = pending.record.candidateDigest;
			prepared.push({ input, request, pending });
		}

		const requests = prepared.map((item) => item.request);
		if (this.server.commitCreateAdmissionsBatch) {
			const admissions = await this.server.commitCreateAdmissionsBatch(requests);
			if (admissions.receipts.length !== requests.length) {
				throw new Error("create admission batch response count mismatch");
			}
			for (let index = 0; index < requests.length; index++) {
				this.validateLifecycleReceipt(requests[index]!, admissions.receipts[index]!);
			}
		} else {
			for (const request of requests) {
				this.validateLifecycleReceipt(request, await this.server.commitLifecycle(request));
			}
		}

		let bodyReceipts: BodyReceipt[];
		if (this.server.submitCandidates) {
			const batch = await this.server.submitCandidates(prepared.map((item) => item.pending.record));
			bodyReceipts = batch.receipts;
			if (bodyReceipts.length !== prepared.length) {
				throw new Error("candidate batch receipt count mismatch");
			}
			const byBody = new Map(bodyReceipts.map((receipt) => [receipt.bodyId, receipt]));
			for (const item of prepared) {
				const receipt = byBody.get(item.pending.record.bodyId);
				if (!receipt) throw new Error("candidate batch omitted body receipt");
				await this.completeCandidateSubmission(item.pending, receipt);
			}
		} else {
			bodyReceipts = [];
			for (const item of prepared) bodyReceipts.push(await this.submitCandidate(item.pending));
		}

		const lifecycleReceipts = await this.commitLifecycleRequests(requests);
		await this.publishLifecycleRoot(requests, lifecycleReceipts);
		await removeBatch.call(
			this.options.database,
			requests.map((request) => request.operationId),
		);
		const receiptByBody = new Map(bodyReceipts.map((receipt) => [receipt.bodyId, receipt]));
		return {
			results: prepared.map(({ input, request }) => ({
				fileId: input.bodyId,
				bodyId: input.bodyId,
				lifecycleOperationId: request.operationId,
				receipt: receiptByBody.get(input.bodyId)!,
			})),
		};
	}

	/** Durable exact-candidate write for an already admitted body. */
	async commitBodyCandidate(
		input: BodyCandidateCommitInput,
	): Promise<BodyReceipt> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		const existing = this.pendingCandidates.get(input.candidateId);
		if (existing) {
			if (existing.record.bodyId !== input.bodyId) {
				throw new Error("candidate ID belongs to a different body");
			}
			return this.submitCandidate(existing);
		}
		const body = await this.loadCurrentBody(input.bodyId);
		const text = body.doc.getText(BODY_TEXT_NAME);
		const before = Y.encodeStateVector(body.doc);
		applyDiffToYText(
			text,
			text.toJSON(),
			input.content,
			ORIGIN_DISK_COMMIT,
		);
		await this.bodies.markDirty(input.bodyId);
		const pending = await this.captureCandidate(
			input.bodyId,
			Y.encodeStateAsUpdate(body.doc, before),
			input.candidateId,
		);
		const receipt = await this.submitCandidate(pending);
		this.log(`body candidate committed for ${input.bodyId} (${input.reason})`);
		return receipt;
	}

	/**
	 * Imports an ordinary-file winner through the same durable body candidate
	 * path as editor changes. A missing root identity is revived durably before
	 * the root path is republished.
	 */
	async commitDiskBody(
		input: DiskBodyCommitInput,
	): Promise<DiskBodyCommitResult> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		const activeBodyId = this.getFileId(input.path);
		if (activeBodyId && activeBodyId !== input.bodyId) {
			throw new Error(`path ${input.path} belongs to a different body`);
		}
		const lifecycle: "create" | "revive" | null =
			activeBodyId === input.bodyId ? null : (input.lifecycle ?? null);
		if (!activeBodyId && !lifecycle) {
			throw new Error(`disk body ${input.path} requires explicit create or revive lifecycle`);
		}
		if (lifecycle === "create") {
			const fresh = await this.commitFreshBody({
				...input,
				candidateId: input.candidateId ?? crypto.randomUUID(),
			});
			return {
				lifecycle: "create",
				revived: false,
				receipt: fresh.receipt,
			};
		}
		if (lifecycle === "revive") {
			await this.commitLifecycle({
				operationId: crypto.randomUUID(),
				kind: "revive",
				fileId: input.bodyId,
				bodyId: input.bodyId,
				path: input.path,
			});
		}
		const revived = lifecycle === "revive";
		const body = await this.loadCurrentBody(input.bodyId);
		if (body.doc.getText(BODY_TEXT_NAME).toJSON() === input.content) {
			await this.bodies.evictLeastRecentlyUsed(this.options.maxLoadedBodies);
			return { lifecycle, revived, receipt: null };
		}
		try {
			const receipt = await this.commitBodyCandidate({
				bodyId: input.bodyId,
				content: input.content,
				candidateId: input.candidateId ?? crypto.randomUUID(),
				reason: input.reason,
			});
			return { lifecycle, revived, receipt };
		} catch (error) {
			this.log(`disk body candidate remains pending for ${input.path} (${input.reason}): ${String(error)}`);
			throw error;
		}
	}


	isBodyLoaded(bodyId: string): boolean {
		return this.bodies.get(bodyId) !== null;
	}

	isBodyOpen(bodyId: string): boolean {
		return (this.sessions.get(bodyId)?.consumers.size ?? 0) > 0;
	}
	getBodyOrigin(path: string): unknown {
		const bodyId = this.getFileId(path);
		return bodyId ? this.sessions.get(bodyId)?.provider.documentOrigin : undefined;
	}


	async settleBodyOnClose(bodyId: string): Promise<void> {
		if (this.isBodyOpen(bodyId)) return;
		await this.flushBodyCandidate(bodyId);
		const hasPendingCandidate = Array.from(this.pendingCandidates.values()).some(
			(candidate) => candidate.record.bodyId === bodyId,
		);
		if (hasPendingCandidate || (this.pendingUpdates.get(bodyId)?.length ?? 0) > 0) {
			throw new Error(`body ${bodyId} still has pending local work`);
		}
		await this.loadCurrentBody(bodyId);
		await this.bodies.evictLeastRecentlyUsed(this.options.maxLoadedBodies);
	}

	getTextForPath(path: string): Y.Text | null {
		const bodyId = this.getFileId(path);
		if (!bodyId) return null;
		const body = this.bodies.get(bodyId);
		if (!body) return null;
		const text = body.doc.getText(BODY_TEXT_NAME);
		this.textToBodyId.set(text, bodyId);
		return text;
	}

	getFileIdForText(text: Y.Text): string | undefined {
		return this.textToBodyId.get(text);
	}

	/** V4 file creation is a durable lifecycle operation and cannot occur from a synchronous editor bind. */
	ensureFile(path: string): Y.Text | null {
		return this.getTextForPath(path);
	}

	isPendingRenameTarget(path: string): boolean {
		const bodyId = this.pendingRenameTargets.get(path);
		if (!bodyId) return false;
		const current = this.pathToId.get(path);
		if (current) {
			this.pendingRenameTargets.delete(path);
			return false;
		}
		return true;
	}

	markPendingRenameTarget(path: string, bodyId: string): void {
		this.pendingRenameTargets.set(path, bodyId);
	}

	clearPendingRenameTarget(path: string, bodyId?: string): void {
		if (bodyId !== undefined && this.pathToId.get(path) !== bodyId) return;
		this.pendingRenameTargets.delete(path);
	}

	isMarkdownTombstoned(path: string): boolean {
		for (const [fileId, raw] of this.meta) {
			if (!raw || typeof raw !== "object") continue;

			const value = raw as Record<string, unknown>;
			if (value.path === path && (typeof value.deletedAt === "number" || value.lifecycle === "tombstoned")) {
				return this.pathToId.get(path) !== fileId;
			}
		}
		return false;
	}
	getBodyAwareness(path: string): SyncAwarenessPort {
		const bodyId = this.getFileId(path);
		return bodyId
			? (this.sessions.get(bodyId)?.provider.awareness ?? this.provider.awareness)
			: this.provider.awareness;
	}

	queueRename(oldPath: string, newPath: string): void {
		const bodyId = this.getFileId(oldPath);
		if (!bodyId) {
			if (this.getAttachmentRef(oldPath)) {
				void this.renameAttachmentRef(oldPath, newPath)
					.catch((error) => this.log(`attachment rename remains pending for ${oldPath}: ${String(error)}`));
			}
			return;
		}
		this.renameBatch.set(oldPath, newPath);
		this.markPendingRenameTarget(newPath, bodyId);
		if (this.renameTimer !== null) window.clearTimeout(this.renameTimer);
		this.renameTimer = window.setTimeout(() => {
			this.renameTimer = null;
			void this.flushRenameBatch();
		}, 50);
	}

	onRenameBatchFlushed(callback: (renames: Map<string, string>) => void): void {
		this.renameBatchListener = callback;
	}

	handleDelete(path: string, _device?: string, opId: string = crypto.randomUUID()): void {
		const bodyId = this.getFileId(path);
		if (!bodyId) {
			if (this.getAttachmentRef(path)) {
				void this.deleteAttachmentRef(path, _device)
					.catch((error) => this.log(`attachment delete remains pending for ${path}: ${String(error)}`));
			}
			return;
		}
		void this.commitStructuralBatch([{
			operationId: opId,
			kind: "delete",
			fileId: bodyId,
			bodyId,
			path,
		}]).catch((error) => this.log(`delete lifecycle remains pending for ${path}: ${String(error)}`));
	}

	private async flushRenameBatch(): Promise<void> {
		if (this.renameBatch.size === 0) return;
		const batch = new Map(this.renameBatch);
		this.renameBatch.clear();
		const requests = [...batch].flatMap(([fromPath, toPath]) => {
			const bodyId = this.getFileId(fromPath);
			return bodyId ? [{
				operationId: crypto.randomUUID(),
				kind: "rename" as const,
				fileId: bodyId,
				bodyId,
				fromPath,
				toPath,
			}] : [];
		});
		try {
			if (requests.length > 0) await this.commitStructuralBatch(requests);
			this.renameBatchListener?.(batch);
		} catch (error) {
			for (const [fromPath, toPath] of batch) {
				const bodyId = this.getFileId(fromPath);
				if (bodyId) this.markPendingRenameTarget(toPath, bodyId);
			}
			this.log(`rename batch remains pending: ${String(error)}`);
		} finally {
			for (const toPath of batch.values()) this.clearPendingRenameTarget(toPath);
		}
	}

	async acquireEditorBody(path: string, consumerId: string): Promise<void> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		const bodyId = this.getFileId(path);
		if (!bodyId) throw new Error(`root catalog has no active body for ${path}`);
		const already = this.sessions.get(bodyId);
		if (already?.consumers.has(consumerId)) return;
		const generation = (this.consumerGenerations.get(consumerId) ?? 0) + 1;
		this.consumerGenerations.set(consumerId, generation);

		const body = await this.loadCurrentBody(bodyId);
		if (this.destroyed) throw new Error("runtime closed during body acquisition");
		let session = this.sessions.get(bodyId);
		if (!session || session.doc !== body.doc) {
			session?.provider.destroy();
			if (session) session.doc.off("update", session.updateObserver);
			session = this.createBodySession(body);
			this.sessions.set(bodyId, session);
			session.ready = this.waitForBodySync(session, body);
		}
		try {
			await session.ready;
		} catch (error) {
			if (this.sessions.get(bodyId) === session && session.consumers.size === 0) {
				session.doc.off("update", session.updateObserver);
				session.provider.destroy();
				this.sessions.delete(bodyId);
			}
			throw error;
		}
		if (this.destroyed) throw new Error("runtime closed during body synchronization");
		if (this.consumerGenerations.get(consumerId) !== generation) {
			if (this.sessions.get(bodyId) === session && session.consumers.size === 0) {
				session.doc.off("update", session.updateObserver);
				session.provider.destroy();
				this.sessions.delete(bodyId);
			}
			throw new Error(`stale body acquisition for ${path}`);
		}
		if (!session.consumers.has(consumerId)) {
			session.consumers.add(consumerId);
			this.bodies.pin(bodyId);
		}
		const text = body.doc.getText(BODY_TEXT_NAME);
		this.textToBodyId.set(text, bodyId);
	}

	isEditorBodyReady(path: string, consumerId: string): boolean {
		const bodyId = this.getFileId(path);
		if (!bodyId) return false;
		const session = this.sessions.get(bodyId);
		return !!session?.consumers.has(consumerId) && this.bodies.get(bodyId)?.doc === session.doc;
	}

	releaseEditorBody(path: string, consumerId: string): void {
		this.consumerGenerations.set(consumerId, (this.consumerGenerations.get(consumerId) ?? 0) + 1);
		const bodyId = this.findSessionBodyForConsumer(consumerId) ?? this.getFileId(path);
		if (!bodyId) return;
		const session = this.sessions.get(bodyId);
		if (!session || !session.consumers.delete(consumerId)) return;
		this.bodies.unpin(bodyId);
		if (session.consumers.size === 0) {
			session.doc.off("update", session.updateObserver);
			session.provider.destroy();
			this.sessions.delete(bodyId);
		}
	}

	async flushBodyCandidate(bodyId: string): Promise<void> {
		this.clearCandidateTimers(bodyId);
		const updates = this.pendingUpdates.get(bodyId);
		if (updates && updates.length > 0) {
			this.pendingUpdates.delete(bodyId);
			const encodedUpdate = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
			try {
				await this.bodies.markDirty(bodyId);
				await this.captureCandidate(
					bodyId,
					encodedUpdate,
					undefined,
					updates.length,
				);
			} catch (error) {
				const newer = this.pendingUpdates.get(bodyId) ?? [];
				this.pendingUpdates.set(bodyId, [...updates, ...newer]);
				if (!this.destroyed) this.scheduleCandidate(bodyId);
				throw error;
			}
		}
		await this.submitPendingForBody(bodyId);
	}

	async retryPendingCandidates(): Promise<void> {
		const bodyIds = new Set(Array.from(this.pendingCandidates.values(), (candidate) => candidate.record.bodyId));
		for (const bodyId of bodyIds) await this.submitPendingForBody(bodyId);
	}

	async reconnect(): Promise<void> {
		if (this.fatalAuthError || this.destroyed) return;
		await this.refreshProviderTickets(true);
		if (this.fatalAuthError || this.destroyed) return;
		this.provider.disconnect();
		await this.provider.connect();
		for (const session of this.sessions.values()) {
			session.provider.disconnect();
			await session.provider.connect();
		}
		await this.retryPendingCandidates();
		await this.retryAttachmentOperations();
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		if (this.renameTimer !== null) {
			window.clearTimeout(this.renameTimer);
			this.renameTimer = null;
			await this.flushRenameBatch();
		}
		this.destroyed = true;
		if (this.ticketRefreshTimer) window.clearTimeout(this.ticketRefreshTimer);
		for (const timer of this.candidateTimers.values()) window.clearTimeout(timer);
		for (const timer of this.candidateMaxWaitTimers.values()) window.clearTimeout(timer);
		this.candidateTimers.clear();
		this.candidateMaxWaitTimers.clear();
		for (const bodyId of Array.from(this.pendingUpdates.keys())) {
			await this.flushBodyCandidate(bodyId).catch(() => undefined);
		}
		await this.attachmentPublicationWork;
		for (const session of this.sessions.values()) {
			session.doc.off("update", session.updateObserver);
			this.terminateProvider(session.provider);
			session.provider.destroy();
		}
		this.sessions.clear();
		this.pendingRenameTargets.clear();
		this.terminateProvider(this.provider);
		this.provider.awareness.destroy();
		this.provider.destroy();
		await this.persistRoot();
		await this.bodies.destroy();
		await this.options.database.close();
	}

	private wireRootProvider(): void {
		this.provider.on("status", ({ status }) => {
			if (status === "connected") {
				this._connectionGeneration++;
				void this.retryPendingCandidates();
				void this.retryAttachmentOperations().catch((error) => {
					this.log(`attachment publication replay failed: ${String(error)}`);
				});
			} else if (status === "disconnected" && !this.fatalAuthError) {
				void this.refreshProviderTickets(true);
			}
		});
		this.provider.on("sync", (synced) => {
			if (!synced) return;
			for (const callback of this.providerSyncListeners) callback(this._connectionGeneration);
		});
		const handleFatal = (payload: string) => {
			const fatal = asFatalSyncMessage(payload);
			if (!fatal) return;
			this._fatalAuthCode = fatal.code;
			this._fatalAuthDetails = fatal.details;
			if (this.ticketRefreshTimer !== null) {
				window.clearTimeout(this.ticketRefreshTimer);
				this.ticketRefreshTimer = null;
			}
			this.provider.disconnect();
			for (const session of this.sessions.values()) session.provider.disconnect();
		};
		const handleRootControl = (payload: string) => {
			handleFatal(payload);
			this.handleVaultControl(payload, ROOT_DOCUMENT_ID);
			const committed = asBodyCommittedNotification(payload);
			if (committed) void this.handleDurableBodyCommitted(committed);
		};
		this.provider.on("custom-message", handleRootControl);
		this.provider.on("message", (event) => {
			if (typeof event.data === "string") handleRootControl(event.data);
		});
		this.ydoc.on("update", (_update, origin) => {
			if (origin === this.provider.documentOrigin) {
				this._lastRemoteUpdateAt = this.now();
				const invalidPath = this.invalidRootPath();
				if (invalidPath) {
					this._fatalAuthCode = "server_misconfigured";
					this._fatalAuthDetails = {
						clientSchemaVersion: SCHEMA_VERSION,
						roomSchemaVersion: SCHEMA_VERSION,
						reason: `invalid root path: ${invalidPath}`,
					};
					this.provider.disconnect();
					this.log(`quarantined invalid remote root path: ${invalidPath}`);
					return;
				}
				void this.persistRoot().catch((error) => {
					this.log(`remote root persistence failed: ${String(error)}`);
				});
				const callback = this.options.onRemoteRootStructuralUpdate;
				if (callback) {
					void Promise.resolve()
						.then(() => callback())
						.catch((error) => {
							this.log(`remote root catch-up scheduling failed: ${String(error)}`);
						});
				}
				return;
			}
			if (
				origin === "indexeddb-bootstrap"
				|| origin === ORIGIN_DURABLE_ROOT_PUBLICATION
			) return;
			const now = this.now();
			this._lastLocalUpdateAt = now;
			if (this.connected) this._lastLocalUpdateWhileConnectedAt = now;
			void this.persistRoot().catch((error) => {
				this.log(`root persistence failed: ${String(error)}`);
			});
		});
	}

	private createBodySession(body: LoadedBody): BodySession {
		const factory = this.options.providerFactory ?? ((input) => this.createDefaultProvider(input));
		const provider = factory({ kind: "body", documentId: body.bodyId, doc: body.doc });
		const handleControl = (payload: string) => this.handleVaultControl(payload, body.bodyId);
		provider.on("custom-message", handleControl);
		provider.on("message", (event) => {
			if (typeof event.data === "string") handleControl(event.data);
		});
		const updateObserver = (update: Uint8Array, origin: unknown) => {
			if (origin === provider.documentOrigin) {
				this._lastRemoteUpdateAt = this.now();
				void this.bodies.mergeFromServer(
					body.bodyId,
					new Uint8Array(),
					body.generation,
				).catch((error) => {
					this.log(`remote body persistence failed for ${body.bodyId}: ${String(error)}`);
				});
				return;
			}
			if (
				origin === ORIGIN_DISK_COMMIT
				|| origin === "server-catch-up"
				|| origin === "server-bootstrap"
				|| origin === "indexeddb-bootstrap"
			) return;
			const now = this.now();
			this._lastLocalUpdateAt = now;
			if (this.connected) this._lastLocalUpdateWhileConnectedAt = now;
			const updates = this.pendingUpdates.get(body.bodyId) ?? [];
			updates.push(update.slice());
			this.pendingUpdates.set(body.bodyId, updates);
			this.queueBodyPersistence(body.bodyId);
			this.scheduleCandidate(body.bodyId);
		};
		body.doc.on("update", updateObserver);
		return {
			bodyId: body.bodyId,
			doc: body.doc,
			provider,
			consumers: new Set(),
			updateObserver,
			ready: Promise.resolve(),
		};
	}

	private async loadCurrentBody(bodyId: string): Promise<LoadedBody> {
		const inFlight = this.currentnessChecks.get(bodyId);
		if (inFlight) return inFlight;
		const run = this.bodies.load(bodyId).then((body) => this.catchUpBody(body));
		this.currentnessChecks.set(bodyId, run);
		try {
			return await run;
		} finally {
			if (this.currentnessChecks.get(bodyId) === run) {
				this.currentnessChecks.delete(bodyId);
			}
		}
	}

	private async catchUpBody(body: LoadedBody): Promise<LoadedBody> {
		let head: BodyHead | null;
		try {
			head = await this.server.currentHead(body.bodyId);
		} catch (error) {
			if (body.generation > 0 || body.dirty) return body;
			throw error;
		}
		if (!head) throw new Error(`body ${body.bodyId} is not active`);
		if (
			head.generation <= body.generation
			&& await this.bodyMatchesHead(body.doc, head)
		) return body;
		const state = await this.server.currentBody(body.bodyId);
		if (state.bodyId !== body.bodyId || state.generation < head.generation) {
			throw new Error("stale body catch-up response");
		}
		await this.validateBodyStateIntegrity(head, state);
		return body.dirty || body.unsettled > 0 || body.pendingLocalUpdates > 0 || body.pins > 0
			? this.bodies.mergeFromServer(body.bodyId, state.encodedState, state.generation)
			: this.bodies.replaceFromServer(body.bodyId, state.encodedState, state.generation);
	}
	private async bodyMatchesHead(doc: Y.Doc, head: BodyHead): Promise<boolean> {
		if (
			(head.contentHash === undefined || head.contentHash === null)
			&& (head.size === undefined || head.size === null)
		) return true;
		const metadata = await this.bodyContentMetadata(doc);
		return (
			(head.contentHash === undefined
				|| head.contentHash === null
				|| head.contentHash === metadata.contentHash)
			&& (head.size === undefined || head.size === null || head.size === metadata.size)
		);
	}

	private async bodyContentMetadata(
		doc: Y.Doc,
	): Promise<{ contentHash: string; size: number }> {
		const bytes = new TextEncoder().encode(doc.getText(BODY_TEXT_NAME).toJSON());
		return {
			contentHash: await sha256Hex(bytes),
			size: bytes.byteLength,
		};
	}

	private async validateBodyStateIntegrity(
		head: BodyHead,
		state: BodyState,
	): Promise<void> {
		const doc = new Y.Doc();
		try {
			Y.applyUpdate(doc, state.encodedState);
			const bytes = new TextEncoder().encode(doc.getText(BODY_TEXT_NAME).toJSON());
			const contentHash = await sha256Hex(bytes);
			if (head.contentHash !== undefined && head.contentHash !== null && head.contentHash !== contentHash) {
				throw new Error("body content hash mismatch");
			}
			if (head.size !== undefined && head.size !== null && head.size !== bytes.byteLength) {
				throw new Error("body content size mismatch");
			}
			if (state.contentHash !== undefined && state.contentHash !== null && state.contentHash !== contentHash) {
				throw new Error("body response content hash mismatch");
			}
			if (state.size !== undefined && state.size !== null && state.size !== bytes.byteLength) {
				throw new Error("body response content size mismatch");
			}
		} finally {
			doc.destroy();
		}
	}


	private async waitForBodySync(session: BodySession, body: LoadedBody): Promise<void> {
		if (session.provider.synced) return;
		let timer: number | null = null;
		const synced = new Promise<boolean>((resolve) => {
			session.provider.on("sync", (value) => { if (value) resolve(true); });
			timer = window.setTimeout(() => resolve(false), this.options.bodySyncTimeoutMs);
		});
		await session.provider.connect();
		const completed = await synced;
		if (timer) window.clearTimeout(timer);
		if (!completed && body.generation === 0 && !body.dirty) {
			session.provider.destroy();
			throw new Error(`body ${body.bodyId} did not establish current state`);
		}
	}

	private queueBodyPersistence(bodyId: string): void {
		const prior = this.bodyPersistenceWork.get(bodyId);
		const run = (prior ? prior.catch(() => undefined) : Promise.resolve())
			.then(() => this.bodies.markLocalUpdate(bodyId));
		this.bodyPersistenceWork.set(bodyId, run);
		void run.catch((error) => {
			this.log(`body persistence failed for ${bodyId}: ${String(error)}`);
		});
	}

	private async awaitBodyPersistence(bodyId: string): Promise<void> {
		const work = this.bodyPersistenceWork.get(bodyId);
		if (!work) return;
		try {
			await work;
		} finally {
			if (this.bodyPersistenceWork.get(bodyId) === work) {
				this.bodyPersistenceWork.delete(bodyId);
			}
		}
	}

	private scheduleCandidate(bodyId: string): void {
		const existing = this.candidateTimers.get(bodyId);
		if (existing) window.clearTimeout(existing);
		this.candidateTimers.set(bodyId, window.setTimeout(() => {
			void this.flushBodyCandidate(bodyId).catch((error) => {
				this.log(`candidate flush failed for ${bodyId}: ${String(error)}`);
			});
		}, this.options.candidateDebounceMs));
		if (!this.candidateMaxWaitTimers.has(bodyId)) {
			this.candidateMaxWaitTimers.set(bodyId, window.setTimeout(() => {
				void this.flushBodyCandidate(bodyId).catch((error) => {
					this.log(`candidate max-wait flush failed for ${bodyId}: ${String(error)}`);
				});
			}, this.options.candidateMaxWaitMs));
		}
	}

	private clearCandidateTimers(bodyId: string): void {
		const debounce = this.candidateTimers.get(bodyId);
		if (debounce) window.clearTimeout(debounce);
		this.candidateTimers.delete(bodyId);
		const maxWait = this.candidateMaxWaitTimers.get(bodyId);
		if (maxWait) window.clearTimeout(maxWait);
		this.candidateMaxWaitTimers.delete(bodyId);
	}

	private async handleDurableBodyCommitted(
		notification: BodyCommittedNotification,
	): Promise<void> {
		await this.catchUpCommittedBody(notification);
		const callback = this.options.onDurableBodyCommitted;
		if (!callback) return;
		try {
			await callback(notification);
		} catch (error) {
			this.log(`durable body settlement scheduling failed: ${String(error)}`);
		}
	}

	private async catchUpCommittedBody(notification: BodyCommittedNotification): Promise<void> {
		const body = this.bodies.get(notification.bodyId);
		if (!body || body.generation >= notification.durableGeneration) return;
		try {
			const state = await this.server.currentBody(notification.bodyId);
			if (state.generation < notification.durableGeneration) return;
			await this.bodies.mergeFromServer(
				notification.bodyId,
				state.encodedState,
				state.generation,
			);
		} catch (error) {
			this.log(`BODY_COMMITTED catch-up failed for ${notification.bodyId}: ${String(error)}`);
		}
	}

	private handleVaultControl(payload: string, expectedDocumentId: string): void {
		let frame: VaultControlFrame | null;
		try {
			frame = parseVaultControlFrame(payload);
		} catch (error) {
			frame = { type: "VAULT_ERROR", message: String(error) };
		}
		if (!frame) return;
		if (frame.type === "VAULT_READY") {
			if (frame.documentId !== expectedDocumentId) {
				frame = { type: "VAULT_ERROR", message: "ready document identity mismatch" };
			} else {
				this.backpressureLevel = 0;
				this.submissionPausedUntil = 0;
				if (frame.documentId === ROOT_DOCUMENT_ID) {
					this._rootGeneration = Math.max(this._rootGeneration, frame.durableGeneration);
				} else {
					const body = this.bodies.get(frame.documentId);
					if (body) body.generation = Math.max(body.generation, frame.durableGeneration);
				}
			}
		} else if (frame.type === "VAULT_BACKPRESSURE") {
			this.backpressureLevel = Math.min(this.backpressureLevel + 1, 5);
			const delay = Math.min(
				MAX_BACKOFF_TIME_MS,
				1_000 * (2 ** (this.backpressureLevel - 1)),
			);
			this.submissionPausedUntil = Math.max(this.submissionPausedUntil, this.now() + delay);
			this.log(`server backpressure: ${frame.reason}; submissions paused ${delay}ms`);
		} else {
			this.submissionPausedUntil = Math.max(this.submissionPausedUntil, this.now() + 1_000);
			this.log(`server vault error: ${frame.message}`);
		}
		this.options.onControlFrame?.(frame);
	}

	private async waitForSubmissionWindow(): Promise<void> {
		const remaining = this.submissionPausedUntil - this.now();
		if (remaining <= 0) return;
		await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
		if (this.destroyed) throw new Error("runtime destroyed during submission backoff");
	}

	private async captureCandidate(
		bodyId: string,
		encodedUpdate: Uint8Array,
		candidateId: string | undefined = crypto.randomUUID(),
		capturedLocalUpdates = 0,
		path?: string,
	): Promise<PendingCandidate> {
		if (!candidateId) throw new Error("candidateId is required");
		const candidateDigest = await sha256Hex(encodedUpdate);
		const existing = this.pendingCandidates.get(candidateId);
		if (existing) {
			const prior = new Uint8Array(existing.record.encodedUpdate);
			const sameBytes = prior.byteLength === encodedUpdate.byteLength
				&& prior.every((byte, index) => byte === encodedUpdate[index]);
			if (
				existing.record.bodyId !== bodyId
				|| existing.record.candidateDigest !== candidateDigest
				|| !sameBytes
			) {
				throw new Error("candidate ID reused with different bytes");
			}
			return existing;
		}
		const capturedAt = this.now();
		const record: CandidateRecord = {
			vaultId: this.options.vaultId,
			bodyId,
			candidateId,
			candidateDigest,
			encodedUpdate: encodedUpdate.slice().buffer,
			capturedAt,
			capturedLocalUpdates,
		};
		await this.bodies.markDirty(bodyId);
		await this.persistCandidate(record);
		const candidatePath = path ?? this.pathForBodyId(bodyId);
		const pending: PendingCandidate = { record, submission: null, path: candidatePath };
		this.pendingCandidates.set(record.candidateId, pending);
		this.bodies.markUnsettled(bodyId);
		this._lastCandidateCapturedAt = capturedAt;
		if (candidatePath) {
			this.options.onProductEvent?.({
				kind: PRODUCT_EVENT_KIND.serverReceiptCandidateCaptured,
				severity: "info",
				scope: "file",
				source: "vaultSync",
				layer: "server",
				priority: "important",
				path: candidatePath,
				data: { bodyId, candidateId, candidateDigest },
			});
		}
		return pending;
	}

	private submitCandidate(candidate: PendingCandidate): Promise<BodyReceipt> {
		if (candidate.submission) return candidate.submission;
		const run = this.performCandidateSubmission(candidate);
		candidate.submission = run;
		void run.then(
			() => {
				if (candidate.submission === run) candidate.submission = null;
			},
			() => {
				if (candidate.submission === run) candidate.submission = null;
			},
		);
		return run;
	}

	private async performCandidateSubmission(
		candidate: PendingCandidate,
	): Promise<BodyReceipt> {
		await this.waitForSubmissionWindow();
		const receipt = await this.server.submitCandidate(candidate.record);
		return this.completeCandidateSubmission(candidate, receipt);
	}

	private async completeCandidateSubmission(
		candidate: PendingCandidate,
		receipt: BodyReceipt,
	): Promise<BodyReceipt> {
		await this.awaitBodyPersistence(candidate.record.bodyId);
		this.validateReceipt(candidate.record, receipt);
		await this.confirmPersistedCandidate(candidate.record, receipt);
		this.pendingCandidates.delete(candidate.record.candidateId);
		await this.bodies.markCandidateSettled(
			candidate.record.bodyId,
			receipt.durableGeneration,
			candidate.record.capturedLocalUpdates ?? 0,
		);
		this._lastReceiptAt = this.now();
		const path = candidate.path ?? this.pathForBodyId(candidate.record.bodyId);
		if (path) {
			this.options.onProductEvent?.({
				kind: PRODUCT_EVENT_KIND.serverReceiptConfirmed,
				severity: "info",
				scope: "file",
				source: "vaultSync",
				layer: "server",
				priority: "important",
				path,
				data: {
					bodyId: candidate.record.bodyId,
					candidateId: candidate.record.candidateId,
					durableGeneration: receipt.durableGeneration,
				},
			});
		}
		await this.bodies.evictLeastRecentlyUsed(this.options.maxLoadedBodies);
		return receipt;
	}

	private async submitPendingForBody(bodyId: string): Promise<void> {
		const candidates = Array.from(this.pendingCandidates.values())
			.filter((candidate) => candidate.record.bodyId === bodyId)
			.sort((left, right) => left.record.capturedAt - right.record.capturedAt);
		for (const candidate of candidates) {
			try {
				await this.submitCandidate(candidate);
			} catch (error) {
				this.log(`candidate ${candidate.record.candidateId} remains pending: ${String(error)}`);
				break;
			}
		}
	}

	private validateReceipt(candidate: CandidateRecord, receipt: BodyReceipt): void {
		if (
			receipt.vaultId !== candidate.vaultId
			|| receipt.bodyId !== candidate.bodyId
			|| receipt.clientId !== this.options.deviceId
			|| receipt.candidateId !== candidate.candidateId
			|| receipt.candidateDigest !== candidate.candidateDigest
			|| !Number.isSafeInteger(receipt.durableGeneration)
			|| receipt.durableGeneration < 0
			|| typeof receipt.vaultGeneration !== "string"
			|| receipt.vaultGeneration.length === 0
			|| typeof receipt.runtimeEpoch !== "string"
			|| receipt.runtimeEpoch.length === 0
		) {
			throw new Error("candidate receipt identity mismatch");
		}
	}

	private async restoreCandidates(): Promise<void> {
		const list = this.options.database.listCandidates;
		if (!list) return;
		try {
			for (const record of await list.call(this.options.database)) {
				this.pendingCandidates.set(record.candidateId, {
					record,
					submission: null,
					path: this.pathForBodyId(record.bodyId),
				});
				const body = await this.bodies.load(record.bodyId);
				this.bodies.markUnsettled(record.bodyId);
				body.dirty = true;
			}
			this._candidatePersistenceHealthy = true;
		} catch (error) {
			this.noteCandidatePersistenceFailure(error);
		}
	}
	private async persistCandidate(record: CandidateRecord): Promise<void> {
		const save = this.options.database.putCandidate;
		if (!save) {
			this._candidatePersistenceHealthy = false;
			this._candidatePersistenceFailureCount++;
			throw new Error("candidate persistence is unavailable");
		}
		try {
			await save.call(this.options.database, record);
			this._candidatePersistenceHealthy = true;
		} catch (error) {
			this.noteCandidatePersistenceFailure(error);
			throw error;
		}
	}

	private async retryLifecycleOperations(): Promise<void> {
		const list = this.options.database.listLifecycleOperations;
		if (!list) return;
		const operations = await list.call(this.options.database);
		const groups = new Map<string, StoredLifecycleOperation[]>();
		for (const operation of operations) {
			const key = operation.batchId
				? `batch:${operation.batchId}`
				: `single:${operation.operationId}`;
			const group = groups.get(key) ?? [];
			group.push(operation);
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			group.sort((left, right) => (left.batchIndex ?? 0) - (right.batchIndex ?? 0));
			await this.retryLifecycleGroup(group);
		}
	}

	private async retryLifecycleGroup(
		operations: readonly StoredLifecycleOperation[],
	): Promise<void> {
		const save = this.options.database.putLifecycleOperation;
		const remove = this.options.database.deleteLifecycleOperation;
		const removeBatch = this.options.database.deleteLifecycleOperations;
		if (!save || !remove || operations.length === 0) return;
		if (operations.length > 1 && !removeBatch) {
			this.log("lifecycle replay remains pending: atomic batch cleanup is unavailable");
			return;
		}
		const attempted = operations.map((operation): StoredLifecycleOperation => ({
			...operation,
			attempts: operation.attempts + 1,
			lastAttemptAt: this.now(),
		}));
		for (const operation of attempted) {
			await save.call(this.options.database, operation);
		}
		const requests = attempted.map((operation) => this.fromStoredLifecycleOperation(operation));
		try {
			for (let index = 0; index < attempted.length; index++) {
				const operation = attempted[index]!;
				if (operation.kind !== "create" || operation.content === null) continue;
				const request = requests[index]!;
				let pending = Array.from(this.pendingCandidates.values()).find(
					(candidate) => candidate.record.bodyId === operation.bodyId,
				);
				if (!pending) {
					const body = await this.bodies.load(operation.bodyId);
					const text = body.doc.getText(BODY_TEXT_NAME);
					if (text.toJSON() !== operation.content) {
						applyDiffToYText(
							text,
							text.toJSON(),
							operation.content,
							ORIGIN_DISK_COMMIT,
						);
						await this.bodies.markDirty(operation.bodyId);
					}
					pending = await this.captureCandidate(
						operation.bodyId,
						Y.encodeStateAsUpdate(body.doc),
					);
				}
				request.candidateId = pending.record.candidateId;
				request.candidateDigest = pending.record.candidateDigest;
			}
			const receipts = await this.commitLifecycleRequests(requests);
			for (const operation of attempted) {
				if (operation.kind !== "create" || operation.content === null) continue;
				await this.submitPendingForBody(operation.bodyId);
				const stillPending = Array.from(this.pendingCandidates.values()).some(
					(candidate) => candidate.record.bodyId === operation.bodyId,
				);
				if (stillPending) throw new Error(`fresh body ${operation.bodyId} is not durable`);
				await save.call(this.options.database, {
					...operation,
					content: null,
				});
			}
			for (let index = 0; index < attempted.length; index++) {
				const operation = attempted[index]!;
				if (operation.kind !== "create" || operation.content === null) continue;
				const finalReceipt = await this.server.commitLifecycle(requests[index]!);
				this.validateLifecycleReceipt(requests[index]!, finalReceipt);
				if (finalReceipt.vaultSequence < receipts[index]!.vaultSequence) {
					throw new Error("fresh lifecycle final sequence regressed");

				}
				receipts[index] = finalReceipt;
			}
			await this.publishLifecycleRoot(requests, receipts);
			if (attempted.length > 1) {
				await removeBatch!.call(
					this.options.database,
					attempted.map((operation) => operation.operationId),
				);
			} else {
				await remove.call(this.options.database, attempted[0]!.operationId);
			}
		} catch (error) {
			this.log(`lifecycle replay remains pending: ${String(error)}`);
		}
	}

	private async cancelFreshAdmission(
		pending: PendingCandidate,
		operationId: string,
	): Promise<void> {
		await this.options.database.deleteCandidate?.(
			pending.record.bodyId,
			pending.record.candidateId,
		);
		this.pendingCandidates.delete(pending.record.candidateId);
		await this.bodies.markCandidateSettled(
			pending.record.bodyId,
			this.bodies.get(pending.record.bodyId)?.generation ?? 0,
			pending.record.capturedLocalUpdates ?? 0,
		);
		this.bodies.discardTransient(pending.record.bodyId);
		await this.options.database.deleteDocument?.(pending.record.bodyId);
		await this.options.database.deleteLifecycleOperation?.(operationId);
	}

	private toStoredLifecycleOperation(request: LifecycleRequest): StoredLifecycleOperation {
		const path = request.toPath ?? request.path;
		if (!path) throw new Error(`lifecycle ${request.kind} requires a path`);
		if (request.fileId !== request.bodyId) throw new Error("vault requires bodyId=fileId");
		return {
			operationId: request.operationId,
			kind: request.kind,
			bodyId: request.bodyId,
			path,
			previousPath: request.fromPath ?? null,
			content: null,
			createdAt: this.now(),
			attempts: 0,
			lastAttemptAt: null,
		};
	}

	private fromStoredLifecycleOperation(operation: StoredLifecycleOperation): LifecycleRequest {
		return {
			operationId: operation.operationId,
			kind: operation.kind,
			fileId: operation.bodyId,
			bodyId: operation.bodyId,
			path: operation.kind === "rename" ? undefined : operation.path,
			fromPath: operation.previousPath ?? undefined,
			toPath: operation.kind === "rename" ? operation.path : undefined,
		};
	}

	private async commitLifecycleRequests(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleReceipt[]> {
		await this.waitForSubmissionWindow();
		if (requests.length === 1) {
			const receipt = await this.server.commitLifecycle(requests[0]!);
			this.validateLifecycleReceipt(requests[0]!, receipt);
			return [receipt];
		}
		const batch = await this.server.commitLifecycleBatch(requests);
		if (
			batch.receipts.length !== requests.length
			|| !Number.isSafeInteger(batch.vaultSequence)
			|| batch.vaultSequence < 0
			|| !batch.runtimeEpoch
		) {
			throw new Error("lifecycle batch receipt mismatch");
		}
		for (let index = 0; index < requests.length; index++) {
			this.validateLifecycleReceipt(requests[index]!, batch.receipts[index]!);
		}
		const maxReceiptSequence = Math.max(
			...batch.receipts.map((receipt) => receipt.vaultSequence),
		);
		if (batch.vaultSequence < maxReceiptSequence) {
			throw new Error("lifecycle batch sequence mismatch");
		}
		return batch.receipts;
	}

	private async publishLifecycleRoot(
		requests: readonly LifecycleRequest[],
		receipts: readonly LifecycleReceipt[],
	): Promise<void> {
		if (requests.length !== receipts.length || requests.length === 0) {
			throw new Error("lifecycle root publication input mismatch");
		}
		const operations = requests.map((request, index): LifecyclePublicationOperation => ({
			...request,
			vaultSequence: receipts[index]!.vaultSequence,
		}));
		const rootUpdate = this.buildLifecycleRootUpdate(requests);
		const proof = await this.server.publishLifecycleRoot(operations, rootUpdate);
		const expectedIds = requests.map((request) => request.operationId);
		const actualIds = proof.operationIds;
		const minimumSequence = Math.max(...receipts.map((receipt) => receipt.vaultSequence));
		if (
			actualIds.length !== expectedIds.length
			|| actualIds.some((operationId, index) => operationId !== expectedIds[index])
			|| !Number.isSafeInteger(proof.vaultSequence)
			|| proof.vaultSequence < minimumSequence
			|| !Number.isSafeInteger(proof.rootGeneration)
			|| proof.rootGeneration < 0
			|| typeof proof.vaultGeneration !== "string"
			|| !proof.vaultGeneration
			|| !proof.runtimeEpoch
		) {
			throw new Error("lifecycle root publication proof mismatch");
		}
		Y.applyUpdate(this.ydoc, rootUpdate, ORIGIN_DURABLE_ROOT_PUBLICATION);
		this._rootGeneration = Math.max(this._rootGeneration, proof.rootGeneration);
		await this.persistRoot();
		for (const request of requests) {
			const path = request.kind === "rename" ? request.toPath : request.path;
			if (!path) continue;
			const kind = request.kind === "create"
				? PRODUCT_EVENT_KIND.crdtFileCreated
				: request.kind === "rename"
					? PRODUCT_EVENT_KIND.crdtFileRenamed
					: request.kind === "delete"
						? PRODUCT_EVENT_KIND.crdtFileTombstoned
						: PRODUCT_EVENT_KIND.crdtFileRevived;
			this.options.onProductEvent?.({
				kind,
				severity: "info",
				scope: "file",
				source: "vaultSync",
				layer: "crdt",
				priority: request.kind === "delete" ? "critical" : "important",
				path,
				opId: request.operationId,
				data: {
					bodyId: request.bodyId,
					fromPath: request.fromPath ?? null,
					toPath: request.toPath ?? null,
				},
			});
		}
	}

	private assertLifecyclePaths(request: LifecycleRequest): void {
		const paths = request.kind === "rename"
			? [request.fromPath, request.toPath]
			: [request.path];
		if (paths.some((path) => !path || safeMarkdownPath(path) !== path)) {
			throw new Error(`Invalid lifecycle path for ${request.kind}`);
		}
	}

	private invalidRootPath(): string | null {
		for (const [path, bodyId] of this.pathToId) {
			if (safeMarkdownPath(path) !== path || !bodyId) return path;
		}
		for (const [path, ref] of this.pathToBlob) {
			if (safeBlobPath(path, [], "", ref) !== path) return path;
		}
		for (const path of this.blobTombstones.keys()) {
			if (safeBlobPath(path) !== path) return path;
		}
		return null;
	}


	private pathForBodyId(bodyId: string): string | null {
		for (const [path, activeBodyId] of this.pathToId) {
			if (activeBodyId === bodyId) return path;
		}
		return null;
	}


	private buildLifecycleRootUpdate(
		requests: readonly LifecycleRequest[],
	): Uint8Array {
		const next = new Y.Doc();
		Y.applyUpdate(next, Y.encodeStateAsUpdate(this.ydoc));
		const before = Y.encodeStateVector(next);
		next.transact(() => {
			this.mutateLifecycleRoot(next.getMap<string>("pathToId"), requests);
		}, ORIGIN_DURABLE_ROOT_PUBLICATION);
		const update = Y.encodeStateAsUpdate(next, before);
		next.destroy();
		return update;
	}

	private mutateLifecycleRoot(
		pathToId: Y.Map<string>,
		requests: readonly LifecycleRequest[],
	): void {
		for (const request of requests) {
			if (request.kind === "rename" && request.fromPath) {
				pathToId.delete(request.fromPath);
			} else if (request.kind === "delete" && request.path) {
				pathToId.delete(request.path);
			}
		}
		for (const request of requests) {
			if (request.kind === "rename" && request.toPath) {
				pathToId.set(request.toPath, request.fileId);
			} else if (
				(request.kind === "create" || request.kind === "revive")
				&& request.path
			) {
				pathToId.set(request.path, request.fileId);
			}
		}
	}

	private validateLifecycleReceipt(
		request: LifecycleRequest,
		receipt: LifecycleReceipt,
	): void {
		if (
			receipt.vaultId !== this.options.vaultId
			|| receipt.bodyId !== request.bodyId
			|| receipt.operationId !== request.operationId
			|| receipt.kind !== request.kind
			|| !Number.isSafeInteger(receipt.durableGeneration)
			|| receipt.durableGeneration < 0
			|| !Number.isSafeInteger(receipt.vaultSequence)
			|| receipt.vaultSequence < 0
			|| typeof receipt.vaultGeneration !== "string"
			|| receipt.vaultGeneration.length === 0
			|| typeof receipt.runtimeEpoch !== "string"
			|| receipt.runtimeEpoch.length === 0
		) {
			throw new Error("lifecycle receipt identity mismatch");
		}
	}

	private async confirmPersistedCandidate(
		record: CandidateRecord,
		receipt: BodyReceipt,
	): Promise<void> {
		const confirm = this.options.database.confirmPendingCandidate;
		if (confirm) {
			try {
				await confirm.call(this.options.database, receipt);
				this._candidatePersistenceHealthy = true;
				return;
			} catch (error) {
				this.noteCandidatePersistenceFailure(error);
				throw error;
			}
		}
		await this.deletePersistedCandidate(record);
	}

	private async deletePersistedCandidate(record: CandidateRecord): Promise<void> {
		const remove = this.options.database.deleteCandidate;
		if (!remove) throw new Error("candidate persistence is unavailable");
		try {
			await remove.call(this.options.database, record.bodyId, record.candidateId);
			this._candidatePersistenceHealthy = true;
		} catch (error) {
			this.noteCandidatePersistenceFailure(error);
			throw error;
		}
	}

	private noteCandidatePersistenceFailure(error: unknown): void {
		this._candidatePersistenceHealthy = false;
		this._candidatePersistenceFailureCount++;
		this.log(`candidate persistence failed: ${String(error)}`);
	}

	private async persistRoot(): Promise<void> {
		await this.options.database.putDocument({
			documentId: ROOT_DOCUMENT_ID,
			generation: this._rootGeneration,
			encodedState: Y.encodeStateAsUpdate(this.ydoc).slice().buffer,
			dirty: false,
			updatedAt: this.now(),
		});
	}

	private createDefaultProvider(input: ProviderFactoryInput): SyncProviderPort {
		const prefix = input.kind === "root"
			? `/vault/${encodeURIComponent(this.options.vaultId)}/ws/root`
			: `/vault/${encodeURIComponent(this.options.vaultId)}/ws/body/${encodeURIComponent(input.documentId)}`;
		const provider = new YSyncProvider(this.options.host, input.documentId, input.doc, {
			prefix,
			connect: false,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
			params: async () => {
				if (!this.options.getSocketTicket) {
					throw new Error("a short-lived socket ticket is required");
				}
				const ticket = await this.options.getSocketTicket();
				if (!ticket) throw new Error("socket ticket request returned no ticket");
				this.scheduleTicketRefresh(ticket);
				return {
					ticket: ticket.value,
					schemaVersion: String(SCHEMA_VERSION),
					protocolVersion: String(PROTOCOL_VERSION),
				};
			},
			awareness: input.kind === "root" ? undefined : new (this.providerAwarenessConstructor())(input.doc),
		});
		if (input.kind === "body") provider.awareness.setLocalState(null);
		return adaptProvider(provider);
	}

	private providerAwarenessConstructor(): new (doc: Y.Doc) => Awareness {
		return this.provider.awareness.constructor as new (doc: Y.Doc) => Awareness;
	}

	private scheduleTicketRefresh(ticket: SocketTicketResult): void {
		if (this.destroyed || this.fatalAuthError) return;
		if (this.ticketRefreshTimer) window.clearTimeout(this.ticketRefreshTimer);
		const remaining = ticket.localExpiresAt - this.now();
		const buffer = Math.min(TICKET_REFRESH_BUFFER_MS, Math.floor(remaining / 2));
		this.ticketRefreshTimer = window.setTimeout(() => {
			this.ticketRefreshTimer = null;
			void this.refreshProviderTickets(true);
		}, Math.max(250, remaining - buffer));
	}

	private async refreshProviderTickets(force: boolean): Promise<void> {
		if (!this.options.getSocketTicket || this.destroyed || this.fatalAuthError) return;
		try {
			const ticket = await this.options.getSocketTicket(force);
			if (this.destroyed || this.fatalAuthError || !ticket) return;
			this.provider.url = patchTicketInUrl(this.provider.url, ticket.value);
			for (const session of this.sessions.values()) {
				session.provider.url = patchTicketInUrl(session.provider.url, ticket.value);
			}
			this.scheduleTicketRefresh(ticket);
		} catch (error) {
			if (this.destroyed || this.fatalAuthError) return;
			this.log(`socket ticket refresh failed: ${String(error)}`);
			this.ticketRefreshTimer = window.setTimeout(() => {
				this.ticketRefreshTimer = null;
				void this.refreshProviderTickets(true);
			}, TICKET_REFRESH_BUFFER_MS);
		}
	}

	private findSessionBodyForConsumer(consumerId: string): string | undefined {
		for (const [bodyId, session] of this.sessions) {
			if (session.consumers.has(consumerId)) return bodyId;
		}
		return undefined;
	}

	private terminateProvider(provider: SyncProviderPort): void {
		if (typeof provider.ws?.terminate === "function") provider.ws.terminate();
		else if (typeof provider.ws?.close === "function") provider.ws.close();
	}

	getRecentEvents(limit = 120): Array<{ ts: string; msg: string }> {
		return limit > 0 ? this.recentEvents.slice(-limit) : [];
	}

	private now(): number { return this.options.now?.() ?? Date.now(); }
	private log(message: string): void {
		this.recentEvents.push({ ts: new Date(this.now()).toISOString(), msg: message });
		if (this.recentEvents.length > 600) {
			this.recentEvents.splice(0, this.recentEvents.length - 600);
		}
		this.options.log?.(message);
	}
}
