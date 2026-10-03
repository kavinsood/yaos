import * as Y from "yjs";
import { canonicalizeMarkdown } from "@shared/markdownCodec";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "@shared/binaryEnvelope";
import { candidateDigestMaterial } from "@shared/candidateDigest";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "@shared/socketCloseCodes";
import {
	SOCKET_CLIENT_CAPABILITY_CATCH_UP_HINT,
	SOCKET_LIVENESS_IDLE_MS,
	SOCKET_LIVENESS_TIMEOUT_MS,
	parseBodyChangedHintFrame,
	parseBodyCurrentnessResultFrame,
	parseSocketControlCapabilities,
	parseSocketLivenessDescriptor,
	parseSocketSessionId,
	parseVaultPongFrame,
	type BodyChangedHintFrame,
	type BodyCurrentnessHead,
	type BodyCurrentnessResultFrame,
	type SocketControlCapabilities,
	type SocketLivenessDescriptor,
} from "@shared/socketLiveness";
import type YSyncProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import {
	BodyManager,
	DEFAULT_BODY_ESTIMATED_COST_BUDGET,
	type LoadedBody,
} from "./bodyManager";
import type { BodyResidencySnapshot } from "./bodyResidencyAccounting";
import type {
	StoredAttachmentPublicationMutation,
	StoredAttachmentPublicationOperation,
	StoredBodyCandidate,
	StoredBodyReceipt,
	StoredLifecycleOperation,
	StoredDocument,
	StoredSemanticEpochReplacement,
} from "./vaultIndexedDb";
import { obsidianRequest, type HttpRequester } from "../utils/http";
import { patchTicketInUrl, SocketTicketHttpError, ticketRefreshBufferMs, type SocketTicketScope } from "./socketTicket";
import { clientTimer } from "../runtime/testOnlyTimers";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "./schema";
import type { AttachmentHead, BlobMeta, BlobRef, BlobTombstone, SemanticPathRef } from "../types";
import { applyDiffToYText, tryApplyDiffToYText } from "./diff";
import { safeBlobPath, safeCanvasPath, safeMarkdownPath } from "./pathPolicy";
import { ORIGIN_DISK_COMMIT } from "./origins";
import { materializeFreshMarkdownUpdates } from "./freshMarkdownUpdates";

import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import { RuntimeScope, type OperationEpoch, type OperationOutcome } from "../runtime/operationLifecycle";
import { BodyCoordinator, type BodyLease } from "./bodyCoordinator";
import {
	ShortLivedConnectionBackoff,
	SocketAdmissionGate,
	SocketAdmissionCoordinator,
	type SocketAdmissionFailure,
	type SocketAdmissionProvider,
} from "../runtime/socketAdmissionCoordinator";
import {
	ResidencyAdmissionCoordinator,
	type AdmissionPriority,
	type AdmissionReservation,
	type ResidencyAdmissionLimits,
	type ResidencyAdmissionSnapshot,
	type RuntimePlatform,
	type RuntimeVisibility,
} from "../runtime/residencyAdmissionCoordinator";
import { ResidencyAdmissionRuntime } from "../runtime/residencyAdmissionRuntime";
import type { OverdueWorkClock, OverdueWorkDiagnostics, OverdueWorkRandom } from "../runtime/overdueWorkKernel";
import { CONNECTION_WORK_KEYS, isDetachedProviderRepairReason, VaultWorkScheduler } from "./vaultWorkScheduler";
import { FrontmatterSemanticMirror } from "./frontmatterSemanticMirror";
import {
	SocketLivenessCoordinator,
	type SocketLivenessSnapshot,
} from "../runtime/socketLivenessCoordinator";
import { fencedWebSocketConstructor, type NativeSocketClose, type SocketTapFactory } from "./fencedWebSocket";
import { RelayReceiptChannel, type RelayReceiptDiagnostics, type RelayReceiptInfo } from "./relayReceipts";
import { OwnAwarenessProvider } from "./ownAwarenessProvider";
import { sameAuthorityIdentity, type VaultAuthorityIdentity } from "../collaboration/authority";
import { CanvasManager, type CanvasPersistencePort, type CanvasProjectionPort } from "./canvas/canvasManager";
import { CanvasHttpTransport } from "./canvas/canvasTransport";
import { dailyLimitBackoffUntil, detectDailyLimitResponses, parseDailyLimitSignal, type DailyLimitInfo } from "./dailyLimit";
import {
	bulkCreateClientCaps,
	DEFAULT_BULK_CREATE_CLIENT_CAPS,
	parseBulkCreateServerCaps,
	type BulkCreateClientCaps,
	type BulkCreateServerCaps,
} from "./bulkCreateCaps";
import { validateBulkCreateRootUpdate } from "./bulkCreateRootValidation";
import {
	INITIAL_SEMANTIC_EPOCH,
	parseSemanticEpochMismatchPayload,
	parseSemanticEpochResetFrame,
	parseSemanticEpochHeader,
	type SemanticEpoch,
	type SemanticEpochMismatchPayload,
	type SemanticEpochResetFrame,
} from "@shared/semanticEpoch";
import {
	prepareSemanticEpochTransition,
	prepareRootSemanticEpochTransition,
	type SemanticEpochTransitionResult,
} from "./semanticEpochTransition";
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
	sendMessage?(message: string): void;
	forceAbort?(): void;
	on(event: "status", callback: (event: { status: string }) => void): void;
	on(event: "sync", callback: (synced: boolean) => void): void;
	on(event: "custom-message", callback: (payload: string) => void): void;
	/** Optional so test fakes may omit it; production providers always remove listeners. */
	off?(event: "sync", callback: (synced: boolean) => void): void;
}

export type FatalSyncCode =
	| "unauthorized"
	| "server_misconfigured"
	| "server_format_unsupported"
	| "unclaimed"
	| "update_required"
	| "authority_superseded"
	| "membership_revoked"
	| "device_revoked";
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
	readonly pendingAttachmentOperations: number;
	readonly fatalAttachmentPublications: number;
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
	/** b3-int D5: resolves true once a pending create for `path` has its receipt (false: none pending / not created). */
	whenCreateSettled?(path: string): Promise<boolean>;
	isEditorBodyReady?(path: string, consumerId: string): boolean;
	releaseEditorBody?(path: string, consumerId: string): void;
	completeEditorBodyBinding?(consumerId: string): void;
	reconnect?(reason?: string): Promise<OperationOutcome>;
	queueReconnect?(reason: string, delayMs?: number, maxWaitMs?: number): Promise<void>;
	pokeOverdueWork?(reason: string): void;
	getOverdueWorkDiagnostics?(): OverdueWorkDiagnostics;
	whenOverdueWorkIdle?(): Promise<void>;
	listAttachmentRefs(): Iterable<[string, BlobRef]>;
	getAttachmentRef(path: string): BlobRef | undefined;
	getObservedAttachmentHead(path: string): AttachmentHead;
	getProjectedAttachmentHead(path: string): AttachmentHead;
	isAttachmentTombstoned(path: string): boolean;
	setAttachmentRef(path: string, hash: string, size: number, mime: string, intent: {
		operationId: string;
		expectedRevision: string | null;
	}): Promise<AttachmentIntentOutcome>;
	deleteAttachmentRef(path: string, device?: string): Promise<AttachmentIntentOutcome>;
	renameAttachmentRef(oldPath: string, newPath: string): Promise<AttachmentIntentOutcome>;
	observeAttachmentChanges(callback: (change: AttachmentCatalogChange) => void): () => void;
	destroy(): Promise<void>;
}

export type EditorAdmissionTier = "same-consumer" | "shared-active" | "warm-live" | "warm-loaded" | "cold";
export type EditorAdmissionCurrentnessSource = "none" | "body-query" | "root-query" | "http-head";
export type EditorAdmissionFailureClass = "cancelled" | "identity" | "network" | "capacity" | "unknown";
export type EditorAdmissionBodySizeBucket = "unknown" | "lt-16-kib" | "16-256-kib" | "256-kib-1-mib" | "gte-1-mib";
export interface EditorAdmissionSample {
	tier: EditorAdmissionTier;
	outcome: "bound" | "acquired" | "failed";
	acquisitionMs: number;
	visibleToBoundMs: number | null;
	cmBindMs: number | null;
	queueDelayMs: number;
	localLoadMs: number;
	currentnessProofMs: number;
	stateFetchMs: number;
	providerAdmissionMs: number;
	providerSyncMs: number;
	projectionMs: number;
	currentnessSource: EditorAdmissionCurrentnessSource;
	httpFallback: boolean;
	socketCount: number;
	bodySizeBucket: EditorAdmissionBodySizeBucket;
	failureClass: EditorAdmissionFailureClass | null;
}

interface EditorAdmissionTrace {
	queueDelayMs: number;
	localLoadMs: number;
	currentnessProofMs: number;
	stateFetchMs: number;
	providerAdmissionMs: number;
	providerSyncMs: number;
	projectionMs: number;
	currentnessSource: EditorAdmissionCurrentnessSource;
	httpFallback: boolean;
}

export interface BodyHead {
	bodyId: string;
	bodyEpoch: SemanticEpoch;
	generation: number;
	contentHash?: string | null;
	size?: number | null;
	lifecycle?: "active" | "tombstoned" | "reaped";
}
export interface BodyState extends BodyHead {
	encodedState: Uint8Array;
}
export interface RootState {
	rootEpoch: SemanticEpoch;
	generation: number;
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
	bodyEpoch: SemanticEpoch;
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
	bodyEpoch: SemanticEpoch;
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
	rootEpoch: SemanticEpoch;
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
	bodyEpoch: SemanticEpoch;
	vaultGeneration: string;
	durableGeneration: number;
	runtimeEpoch: string;
	vaultSequence?: number;
	lifecycle?: "active" | "tombstoned" | "reaped";
	contentHash?: string | null;
	size?: number | null;
}
export type VaultControlFrame =
	| {
		type: "VAULT_READY";
		documentId: string;
		socketSessionId: string | null;
		vaultGeneration: string;
		durableGeneration: number;
		documentEpoch: SemanticEpoch;
		runtimeEpoch: string;
		liveness: SocketLivenessDescriptor;
		capabilities: SocketControlCapabilities | null;
	}
	| {
		type: "VAULT_PONG";
		probeId: string;
		documentId: string;
		documentEpoch: SemanticEpoch;
		vaultGeneration: string;
		runtimeEpoch: string;
	}
	| SemanticEpochResetFrame
	| { type: "VAULT_BACKPRESSURE"; reason: string }
	| { type: "VAULT_ERROR"; message: string; code?: string; resetAt?: number };
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

export interface FreshBodyBatchItemResult {
	fileId: string;
	/** The created body, or the server's existing body for `exists-*`. */
	bodyId: string;
	lifecycleOperationId: string;
	outcome: BulkCreateOutcomeKind;
	receipt: BodyReceipt | null;
	reason?: string;
}
export interface FreshBodyBatchCommitResult {
	results: FreshBodyBatchItemResult[];
}
export interface BodyCandidateCommitInput {
	bodyId: string;
	content: string;
	candidateId: string;
	reason: string;
}
export type CurrentBodyCandidateOutcome =
	| { kind: "completed"; receipt: BodyReceipt }
	/**
	 * The body already holds exactly the requested content (and the
	 * expected content): nothing to commit, no candidate was captured.
	 */
	| { kind: "completed"; receipt: null; unchanged: true }
	| { kind: "superseded" };
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
	putAttachmentOperation(operation: StoredAttachmentPublicationOperation): Promise<StoredAttachmentPublicationOperation>;
	listAttachmentOperations(): Promise<StoredAttachmentPublicationOperation[]>;
	deleteAttachmentOperation(operationId: string): Promise<void>;
}
export type AttachmentPublicationMutation = StoredAttachmentPublicationMutation;
export interface AttachmentPublicationReceipt {
	operationId: string;
	outcome: "committed";
	revisions: Array<{ path: string; revision: string; state: "active" | "deleted" }>;
	vaultGeneration: string;
	runtimeEpoch: string;
	vaultSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	rootUpdate: Uint8Array;
}
export interface CommittedOperationOutcome {
	operationId: string;
	requestDigest: string;
	vaultSequence: number;
	committed: true;
}
export type AttachmentIntentOutcome =
	| { kind: "committed"; revision: string }
	| { kind: "durably-pending"; operationId: string }
	| { kind: "superseded"; current: AttachmentHead };

export interface AttachmentRevisionMismatchDetails {
	path: string;
	current: AttachmentHead;
	currentHeads: Array<{ path: string; head: AttachmentHead }>;
	vaultGeneration: string;
	vaultSequence: number;
}

export class AttachmentPublicationError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly mismatch: AttachmentRevisionMismatchDetails | null = null,
		readonly semanticMismatch: SemanticEpochMismatchPayload | null = null,
	) {
		super(`attachment publication failed (${status}: ${code})`);
		this.name = "AttachmentPublicationError";
	}
}

export class VaultMutationRequestError extends Error {
	constructor(readonly status: number, readonly code: string, operation: string,
		readonly semanticMismatch: SemanticEpochMismatchPayload | null = null,
		/** Operation IDs named by the server (e.g. `bulk_create_partial_overlap`). */
		readonly operationIds: readonly string[] = [],
		/** Effective create-bulk caps carried by a create-bulk 413. */
		readonly bulkCreateCaps: BulkCreateServerCaps | null = null) {
		super(`${operation} failed (${status}: ${code})`);
		this.name = "VaultMutationRequestError";
	}
}

/** Default caps for `POST /lifecycle/create-bulk`; the effective ones follow the server (bulkCreateCaps.ts). */
export { BULK_CREATE_MAX_ITEMS, BULK_CREATE_MAX_BYTES, BULK_CREATE_CLIENT_BYTE_BUDGET } from "./bulkCreateCaps";
/** Coalescing window for editor/file-system creates before one bulk request. */
export const CREATE_COLLECTOR_DELAY_MS = 300;

export interface BulkCreateFileRequest {
	operationId: string;
	bodyId: string;
	path: string;
	updates: Uint8Array[];
}
export interface BulkCreateAttachmentRequest {
	operationId: string;
	path: string;
	hash: string;
	size: number;
	mime: string;
}
export interface BulkCreateRequest {
	batchId: string;
	rootEpoch: SemanticEpoch;
	rootStateVector?: Uint8Array;
	files: BulkCreateFileRequest[];
	attachments: BulkCreateAttachmentRequest[];
}
export type BulkCreateOutcomeKind = "created" | "exists-identical" | "exists-different" | "rejected";
export interface BulkCreateItemOutcome {
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
export interface BulkCreateResponse {
	batchId: string;
	outcomes: BulkCreateItemOutcome[];
	vaultSequence: number;
	rootGeneration: number;
	rootEpoch: SemanticEpoch;
	vaultGeneration: string;
	runtimeEpoch: string;
	replayed: boolean;
	rootUpdate?: Uint8Array;
}
/** Per-item envelope/frame overhead added to the canonical text size when splitting. */
const BULK_CREATE_ITEM_OVERHEAD_BYTES = 256;

type BulkCreateItemResult =
	| { outcome: "created"; result: FreshBodyCommitResult }
	| { outcome: "exists-identical" | "exists-different"; existingBodyId: string | null; operationId: string }
	| { outcome: "rejected"; reason: string; operationId: string }
	| { outcome: "cancelled" }
	| { outcome: "pending"; operationId: string; error: unknown };

interface CreateCollectorEntry {
	input: FreshBodyCommitInput;
	bytes: number;
	resolve(result: BulkCreateItemResult): void;
	/** {@link VaultSync.whenCreateSettled} waiters: woken when this entry is folded or sent. */
	observers: Array<() => void>;
}

interface PreparedCreate {
	operation: StoredLifecycleOperation;
	pending: PendingCandidate;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/** Splits by the bulk create caps; an item above the byte budget travels alone. */
export function splitByBulkCreateCaps<T>(
	items: readonly T[],
	bytesOf: (item: T) => number,
	caps: BulkCreateClientCaps = DEFAULT_BULK_CREATE_CLIENT_CAPS,
): T[][] {
	const chunks: T[][] = [];
	let current: T[] = [];
	let currentBytes = 0;
	for (const item of items) {
		const bytes = bytesOf(item);
		if (current.length > 0 && (current.length >= caps.maxItems
			|| currentBytes + bytes > caps.byteBudget)) {
			chunks.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(item);
		currentBytes += bytes;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

export class AttachmentPublicationProofError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentPublicationProofError";
	}
}
export interface VaultServerPort {
	currentHead(bodyId: string): Promise<BodyHead | null>;
	currentBody(bodyId: string): Promise<BodyState>;
	currentRoot?(): Promise<RootState>;
	submitCandidate(record: CandidateRecord): Promise<BodyReceipt>;
	submitCandidates?(records: readonly CandidateRecord[]): Promise<CandidateBatchReceipt>;
	/** The only create path: files and new attachments in one durable batch. */
	commitCreateBulk(request: BulkCreateRequest): Promise<BulkCreateResponse>;
	publishLifecycleRoot(
		operations: readonly LifecyclePublicationOperation[],
		rootUpdate: Uint8Array,
		rootEpoch: SemanticEpoch,
	): Promise<RootPublicationReceipt>;
	commitLifecycleBatch(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleBatchReceipt>;
	publishAttachment(mutation: AttachmentPublicationMutation, rootEpoch: SemanticEpoch): Promise<AttachmentPublicationReceipt>;
	committedOperationOutcome?(input: {
		operationId: string;
		requestDigest: string;
		authority: VaultAuthorityIdentity;
	}): Promise<CommittedOperationOutcome | null>;
}

export interface ProviderFactoryInput {
	kind: "root" | "body" | "semantic";
	documentId: string;
	documentEpoch: SemanticEpoch;
	doc: Y.Doc;
	onClose: (event: NativeSocketClose) => void;
	/**
	 * Body sockets only: relay receipt tap. A provider that sends through it
	 * gets envelopes, socket-ack receipts, and re-sends.
	 */
	socketTap?: SocketTapFactory;
}
export type ProviderFactory = (input: ProviderFactoryInput) => SyncProviderPort;
export type WebSocketImplementation = typeof WebSocket;
export interface SocketTicketResult {
	value: string;
	expiresAt: number;
	localExpiresAt: number;
	ttlMs: number;
}

export interface DocumentPersistencePort {
	getDocument(documentId: string): Promise<StoredDocument | null>;
	putDocument(document: StoredDocument): Promise<void>;
	replaceBodySemanticEpoch?(replacement: StoredSemanticEpochReplacement): Promise<void>;
	deleteDocument?(documentId: string): Promise<void>;
	close(): Promise<void>;
}

export type VaultDatabasePort =
	DocumentPersistencePort
	& AttachmentPersistencePort
	& Partial<CandidatePersistencePort & LifecyclePersistencePort>;

export interface SemanticEpochResetEvent {
	purpose: "root" | "body";
	documentId: string;
	previousEpoch: SemanticEpoch;
	currentEpoch: SemanticEpoch;
}

export interface VaultSyncOptions {
	vaultId: string;
	vaultGeneration: string;
	deviceId: string;
	host: string;
	token: string;
	database: VaultDatabasePort;
	canvasProjection?: CanvasProjectionPort;
	server?: VaultServerPort;
	providerFactory?: ProviderFactory;
	getSocketTicket?: (scope: SocketTicketScope, force?: boolean) => Promise<SocketTicketResult | null>;
	request?: HttpRequester;
	webSocket?: WebSocketImplementation;
	maxLoadedBodies?: number;
	residencyAdmissionLimits?: Partial<ResidencyAdmissionLimits>;
	candidateDebounceMs?: number;
	/** Create collector window (default {@link CREATE_COLLECTOR_DELAY_MS}). */
	createCollectorDelayMs?: number;
	/** The server's advertised create-bulk caps (`/api/capabilities` `bulkCreate`); absent, the defaults. */
	bulkCreateCaps?: () => unknown;
	bodySyncTimeoutMs?: number;
	candidateMaxWaitMs?: number;
	/**
	 * Socket-ack receipts on relay body sockets (`relayBodies >= 2`). Default
	 * true; only takes effect when the server advertises the capability.
	 */
	relayReceipts?: boolean;
	now?: () => number;
	workClock?: OverdueWorkClock;
	workRandom?: OverdueWorkRandom;
	log?: (message: string) => void;
	onRemoteRootStructuralUpdate?: () => void | Promise<void>;
	onAttachmentReconciliationRequired?: (
		paths: readonly string[],
		reason: "revision-mismatch",
	) => void | Promise<void>;
	/**
	 * D3: a bulk create found the path already active on the server (the root
	 * now maps it to `existingBodyId`). The local file must go through
	 * reconcile, never create.
	 */
	onCreatePathOwned?: (input: {
		path: string;
		existingBodyId: string | null;
		identical: boolean;
	}) => void | Promise<void>;
	/**
	 * A body committed while this client's socket belongs to an earlier
	 * server runtime (after a hibernation wake), so no `BODY_COMMITTED`
	 * receipt can be delivered on it. The hint carries no receipt or content
	 * proof: it is only a reason to schedule change-feed catch-up. Without
	 * this callback, `onRemoteRootStructuralUpdate` (also a catch-up trigger)
	 * is used.
	 */
	onBodyChangedHint?: (hint: BodyChangedHintFrame) => void | Promise<void>;
	onDurableBodyCommitted?: (
		notification: BodyCommittedNotification,
	) => void | Promise<void>;
	/**
	 * A remote update reached a live body that no editor is showing (a warm
	 * body of a closed note). Nothing else projects it: disk mirroring only
	 * observes open notes, and server catch-up will not replace a live body.
	 */
	onRemoteUpdateToClosedBody?: (event: { bodyId: string; path: string }) => void;
	onProductEvent?: (event: ProductFlightPathEventInput) => void;
	onControlFrame?: (frame: VaultControlFrame) => void;
	/**
	 * D8: the server reported Cloudflare's free-tier daily row limit (typed
	 * HTTP 503 or VAULT_ERROR code). Called on every trip; the runtime has
	 * already backed off. The host decides how often to notify.
	 */
	onDailyLimit?: (info: DailyLimitInfo) => void;
	/** TEST-ONLY: first D8 probe interval (default DAILY_LIMIT_FIRST_PROBE_MS, doubling to hourly). */
	dailyLimitProbeBaseMs?: number;
	onSemanticEpochReset?: (event: SemanticEpochResetEvent) => void | Promise<void>;
	onSemanticEpochRebaseConflict?: (event: {
		bodyId: string;
		path: string;
		previousEpoch: SemanticEpoch;
		currentEpoch: SemanticEpoch;
		kind: "conflict" | "too-large";
		pendingMarkdown: string;
		authoritativeContent: string;
	}) => void | Promise<void>;
	getAuthority?: () => VaultAuthorityIdentity;
	onAuthoritySuperseded?: (
		kind: "candidate" | "lifecycle" | "attachment",
		identity: string,
		authority: VaultAuthorityIdentity | null,
	) => void;
}

interface BodySession {
	bodyId: string;
	doc: Y.Doc;
	provider: SyncProviderPort;
	consumers: Set<string>;
	projectionLeases: Map<string, BodyLease>;
	lifetimeLease: BodyLease;
	updateObserver: (update: Uint8Array, origin: unknown) => void;
	ready: Promise<void>;
	pendingCommitted: BodyCommittedNotification | null;
	watermarkWork: Promise<void>;
	relay: RelayReceiptChannel | null;
}

interface SocketSession {
	readonly id: string | null;
	readonly runtimeEpoch: string;
	readonly capabilities: SocketControlCapabilities | null;
}

interface CurrentnessWaiter {
	readonly session: SocketSession;
	readonly bodyIds: ReadonlySet<string>;
	readonly resolve: (result: BodyCurrentnessResultFrame | null) => void;
	readonly timer: number;
}
interface PendingCandidate {
	record: CandidateRecord;
	submission: Promise<BodyReceipt> | null;
	path: string | null;
	/**
	 * Captured from updates all observed by this relay channel, up to `seq`.
	 * A relay receipt covering `seq` makes the candidate durable without HTTP.
	 */
	relayMark?: RelayMark | null;
}

interface RelayMark {
	readonly channel: RelayReceiptChannel;
	readonly seq: number;
}

type CandidateSubmitMode = "http" | "defer" | "await-relay";

/**
 * While a body's relay socket can deliver receipts, its candidates skip the
 * HTTP POST and wait for a socket receipt. Receipts arrive 0.3–1.5 s after the
 * frame (group commit); the channel re-sends after RECEIPT_RESEND_MS (5 s).
 * Only a candidate still unconfirmed this long falls back to HTTP.
 */
const RELAY_HTTP_FALLBACK_MS = 15_000;
/** Closing a note waits this long for a relay receipt before posting over HTTP. */
const RELAY_SETTLE_WAIT_MS = 3_000;
/** Remote, server and bootstrap origins: never local edits for receipts. */
const RELAY_NON_LOCAL_ORIGINS = new Set<unknown>(["server-catch-up", "server-bootstrap", "indexeddb-bootstrap"]);

const BODY_TEXT_NAME = "body";

// Initial import publishes up to 32 ordinary notes in one four-request batch.
// The byte-cost budget remains the controlling guard for large documents.
const DEFAULT_MAX_LOADED_BODIES = 32;
const DEFAULT_CANDIDATE_DEBOUNCE_MS = 250;
export class FreshAdmissionCancelledError extends Error {
	constructor(readonly path: string) {
		super(`fresh admission cancelled for ${path}`);
		this.name = "FreshAdmissionCancelledError";
	}
}

export class FreshAdmissionDurablyPendingError extends Error {
	constructor(
		readonly path: string,
		readonly lifecycleOperationId: string,
		readonly cause?: unknown,
	) {
		super(`fresh admission is durably pending for ${path}`);
		this.name = "FreshAdmissionDurablyPendingError";
	}
}

export class SemanticEpochRebaseError extends Error {
	constructor(readonly result: Exclude<SemanticEpochTransitionResult, { kind: "ready" }>) {
		super(`body ${result.bodyId} requires a preserved ${result.kind} rebase across semantic epoch`);
		this.name = "SemanticEpochRebaseError";
	}
}

const DEFAULT_CANDIDATE_MAX_WAIT_MS = 2_000;
const DEFAULT_BODY_SYNC_TIMEOUT_MS = 10_000;
const DEFAULT_CURRENTNESS_QUERY_TIMEOUT_MS = 2_000;
const DEFAULT_TRANSIENT_COST_BUDGET = 24 * 1024 * 1024;
const DEFAULT_BODY_SOCKET_BUDGET = 8;
const DEFAULT_WARM_RETENTION_MS = 5 * 60_000;
const DEFAULT_BACKGROUND_PROMOTION_MS = 5_000;
const DEFAULT_PREFERRED_BURST = 4;
const MAX_BACKOFF_TIME_MS = 30_000;
/**
 * Scheduler reason for the ticket-expiry check. Tickets are admission
 * credentials only: the server checks them at the WebSocket upgrade and never
 * again, so an open socket is never rotated when its ticket nears expiry.
 * The check only repairs providers that are not open, because y-partyserver's
 * built-in retry loop reuses the URL (and ticket) of its last attempt and can
 * never succeed once that ticket expires.
 */
const TICKET_EXPIRY_CHECK_REASON = "ticket-expiry-check";
/**
 * A socket still CONNECTING is an admission in flight, not a detached
 * provider. Only one stuck this long is torn down and admitted again.
 */
const PROVIDER_CONNECT_TIMEOUT_MS = 20_000;
/** Recheck delay for connection maintenance while root is still connecting. */
const ROOT_CONNECTING_RECHECK_MS = 2_000;

/** A socket admission the coordinator did not complete, with its outcome. */
class SocketAdmissionNotCompletedError extends Error {
	constructor(readonly outcome: OperationOutcome) {
		super(`body socket admission failed: ${outcome.kind}`);
		this.name = "SocketAdmissionNotCompletedError";
	}
}
/** Bound on waiting for an admission-closed socket to finish closing. */
const ADMISSION_SOCKET_RELEASE_TIMEOUT_MS = 3_000;
const ADMISSION_SOCKET_RELEASE_POLL_MS = 20;
const FATAL_CODES = new Set<FatalSyncCode>([
	"unauthorized",
	"server_misconfigured",
	"server_format_unsupported",
	"unclaimed",
	"update_required",
	"authority_superseded",
	"membership_revoked",
	"device_revoked",
]);
const ORIGIN_DURABLE_ROOT_PUBLICATION = "durable-root-publication";

export function parseActiveBodyHead(bodyId: string, value: unknown): BodyHead | null {
	if (value === null) return null;
	if (!value || typeof value !== "object") throw new Error("invalid body head response");
	const candidate = value as Partial<BodyHead>;
	if (
		candidate.bodyId !== bodyId
		|| !Number.isSafeInteger(candidate.bodyEpoch)
		|| (candidate.bodyEpoch as number) < 1
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
		bodyEpoch: candidate.bodyEpoch as SemanticEpoch,
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
		case "VAULT_READY": {
			const liveness = parseSocketLivenessDescriptor(record.liveness);
			const capabilities = parseSocketControlCapabilities(record.capabilities);
			const socketSessionId = parseSocketSessionId(record.socketSessionId);
			if (
				typeof record.documentId !== "string"
				|| typeof record.vaultGeneration !== "string"
				|| !record.vaultGeneration
				|| !Number.isSafeInteger(record.durableGeneration)
				|| (record.durableGeneration as number) < 0
				|| !Number.isSafeInteger(record.documentEpoch)
				|| (record.documentEpoch as number) < 1
				|| typeof record.runtimeEpoch !== "string"
				|| !record.runtimeEpoch
				|| (capabilities !== null && socketSessionId === null)
				|| !liveness
			) return null;
			return {
				type: "VAULT_READY",
				documentId: record.documentId,
				socketSessionId,
				vaultGeneration: record.vaultGeneration,
				durableGeneration: record.durableGeneration as number,
				documentEpoch: record.documentEpoch as SemanticEpoch,
				runtimeEpoch: record.runtimeEpoch,
				liveness,
				capabilities,
			};
		}
		case "VAULT_PONG": {
			const pong = parseVaultPongFrame(record);
			return pong;
		}
		case "SEMANTIC_EPOCH_RESET_REQUIRED":
			return parseSemanticEpochResetFrame(record);
		case "VAULT_BACKPRESSURE":
			return typeof record.reason === "string" && record.reason
				? { type: "VAULT_BACKPRESSURE", reason: record.reason }
				: null;
		case "VAULT_ERROR":
			return typeof record.message === "string" && record.message
				? {
					type: "VAULT_ERROR", message: record.message,
					...(typeof record.code === "string" ? { code: record.code } : {}),
					...(typeof record.resetAt === "number" ? { resetAt: record.resetAt } : {}),
				}
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
		|| !Number.isSafeInteger(record.bodyEpoch)
		|| (record.bodyEpoch as number) < 1
		|| typeof record.runtimeEpoch !== "string"
		|| !record.runtimeEpoch
		|| (record.vaultSequence !== undefined
			&& (!Number.isSafeInteger(record.vaultSequence) || (record.vaultSequence as number) < 0))
		|| (record.lifecycle !== undefined
			&& record.lifecycle !== "active" && record.lifecycle !== "tombstoned" && record.lifecycle !== "reaped")
		|| (record.contentHash !== undefined && record.contentHash !== null
			&& (typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.contentHash)))
		|| (record.size !== undefined && record.size !== null
			&& (!Number.isSafeInteger(record.size) || (record.size as number) < 0))
	) {
		return null;
	}
	return {
		type: "BODY_COMMITTED",
		bodyId: record.bodyId,
		bodyEpoch: record.bodyEpoch as SemanticEpoch,
		vaultGeneration: record.vaultGeneration,
		durableGeneration: record.durableGeneration,
		runtimeEpoch: record.runtimeEpoch,
		...(record.vaultSequence === undefined ? {} : { vaultSequence: record.vaultSequence as number }),
		...(record.lifecycle === undefined ? {} : { lifecycle: record.lifecycle }),
		...(record.contentHash === undefined ? {} : { contentHash: record.contentHash }),
		...(record.size === undefined ? {} : { size: record.size as number | null }),
	};
}

function semanticCommittedDocumentId(payload: string): string | null {
	try {
		const value = JSON.parse(payload) as Record<string, unknown>;
		return value.type === "SEMANTIC_COMMITTED" && value.kind === "canvas"
			&& typeof value.documentId === "string" ? value.documentId : null;
	} catch { return null; }
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalOperationJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value)) return Object.is(value, -0) ? "0" : String(value);
	if (Array.isArray(value)) return `[${value.map(canonicalOperationJson).join(",")}]`;
	if (!value || typeof value !== "object") throw new Error("operation digest contains an unsupported value");
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalOperationJson(record[key])}`).join(",")}}`;
}

async function operationRequestDigest(value: unknown): Promise<string> {
	return sha256Hex(new TextEncoder().encode(canonicalOperationJson(value)));
}

function isBulkCreateTooBig(error: VaultMutationRequestError): boolean {
	return error.status === 413
		&& (error.code === "bulk_create_too_large" || error.code === "bulk_create_too_many_items");
}

function mutationRequestError(response: { status: number; json?: unknown }, operation: string): VaultMutationRequestError {
	const value = response.json;
	const code = value && typeof value === "object" && "error" in value && typeof value.error === "string"
		? value.error
		: "request_failed";
	const operationIds = value && typeof value === "object" && "operationIds" in value
		&& Array.isArray(value.operationIds)
		? value.operationIds.filter((id): id is string => typeof id === "string")
		: [];
	return new VaultMutationRequestError(
		response.status,
		code,
		operation,
		parseSemanticEpochMismatchPayload(value),
		operationIds,
		value && typeof value === "object" && "bulkCreate" in value ? parseBulkCreateServerCaps(value.bulkCreate) : null,
	);
}
function parseAttachmentHead(value: unknown): AttachmentHead | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.kind === "missing" && record.revision === null) {
		return { kind: "missing", revision: null };
	}
	if (record.kind === "active"
		&& typeof record.revision === "string" && record.revision.length > 0 && record.revision.length <= 128
		&& typeof record.hash === "string" && /^[a-f0-9]{64}$/.test(record.hash)
		&& Number.isSafeInteger(record.size) && (record.size as number) >= 0) {
		return {
			kind: "active",
			revision: record.revision,
			hash: record.hash,
			size: record.size as number,
		};
	}
	if (record.kind === "deleted"
		&& typeof record.revision === "string" && record.revision.length > 0 && record.revision.length <= 128
		&& (record.previousHash === null
			|| (typeof record.previousHash === "string" && /^[a-f0-9]{64}$/.test(record.previousHash)))) {
		return {
			kind: "deleted",
			revision: record.revision,
			previousHash: record.previousHash,
		};
	}
	return null;
}

function parseAttachmentRevisionMismatch(value: unknown): AttachmentRevisionMismatchDetails | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const current = parseAttachmentHead(record.current);
	if (typeof record.path !== "string" || !current
		|| typeof record.vaultGeneration !== "string" || !record.vaultGeneration
		|| !Number.isSafeInteger(record.vaultSequence) || (record.vaultSequence as number) < 0
		|| !Array.isArray(record.currentHeads)) return null;
	const currentHeads: Array<{ path: string; head: AttachmentHead }> = [];
	for (const candidate of record.currentHeads) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
		const entry = candidate as Record<string, unknown>;
		const head = parseAttachmentHead(entry.head);
		if (typeof entry.path !== "string" || !head) return null;
		currentHeads.push({ path: entry.path, head });
	}
	return {
		path: record.path,
		current,
		currentHeads,
		vaultGeneration: record.vaultGeneration,
		vaultSequence: record.vaultSequence as number,
	};
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
		sendMessage: (message) => provider.sendMessage(message),
		forceAbort: () => {
			const socket = provider.ws as (WebSocket & { terminate?: () => void }) | null;
			provider.disconnect();
			if (typeof socket?.terminate === "function") socket.terminate();
			else socket?.close();
		},
		on: ((event: string, callback: (...values: never[]) => void) => provider.on(event, callback)) as SyncProviderPort["on"],
		off: (event, callback) => provider.off(event, callback),
	};
}

/** Authenticated production HTTP adapter for currentness checks and durable candidates. */
/** reconnectFloors key for the D8 back-off (not a document id). */
const DAILY_LIMIT_FLOOR_KEY = "\0daily-limit";

export class VaultSyncHttpPort implements VaultServerPort {
	private readonly base: string;

	constructor(
		host: string,
		private readonly vaultId: string,
		private readonly token: string,
		private readonly request: HttpRequester = obsidianRequest,
	) {
		this.base = host.replace(/\/$/, "");
	}

	async currentHead(bodyId: string): Promise<BodyHead | null> {
		const response = await this.request({
			url: `${this.route("head")}/${encodeURIComponent(bodyId)}`,
			method: "GET",
			headers: this.headers(),
		});
		if (response.status === 404) return null;
		if (response.status !== 200) throw new Error(`body head request failed (${response.status})`);
		return parseActiveBodyHead(bodyId, response.json);
	}

	async currentBody(bodyId: string): Promise<BodyState> {
		const response = await this.request({
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
			bodyEpoch: parseSemanticEpochHeader(response.headers, "body"),
			generation,
			contentHash,
			size,
			encodedState: new Uint8Array(response.arrayBuffer),
		};
	}

	async currentRoot(): Promise<RootState> {
		const response = await this.request({
			url: this.route("root"), method: "GET", headers: this.headers(),
		});
		if (response.status !== 200) throw new Error(`root state request failed (${response.status})`);
		const generation = Number(response.headers["x-yaos-generation"] ?? response.headers["X-Yaos-Generation"]);
		if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("root state omitted generation");
		return {
			rootEpoch: parseSemanticEpochHeader(response.headers, "root"),
			generation,
			encodedState: new Uint8Array(response.arrayBuffer),
		};
	}

	async submitCandidate(record: CandidateRecord): Promise<BodyReceipt> {
		const persistedFrames = record.encodedUpdates;
		const encodedUpdates = this.candidateUpdateFrames(record);
		if (encodedUpdates.length > 1) {
			const batch = await this.submitCandidates([record]);
			if (batch.receipts.length !== 1) throw new Error("single framed candidate receipt mismatch");
			return batch.receipts[0]!;
		}
		const response = await this.request({
			url: `${this.route("body")}/${encodeURIComponent(record.bodyId)}/candidate`,
			method: "POST",
			contentType: "application/octet-stream",
			body: persistedFrames?.length === 1
				? persistedFrames[0]
				: record.encodedUpdate,
				headers: {
					...this.headers(),
					"x-yaos-body-epoch": String(record.bodyEpoch),
					"x-yaos-candidate-id": record.candidateId,
				"x-yaos-candidate-digest": record.candidateDigest,
			},
		});
		if (response.status !== 200) throw mutationRequestError(response, "body candidate request");
		return response.json as BodyReceipt;
	}

	async submitCandidates(records: readonly CandidateRecord[]): Promise<CandidateBatchReceipt> {
		// Candidate persistence carries local replay metadata (including the full
		// pending Markdown string). Never mirror that record onto the wire: doing
		// so would duplicate a 5 MiB note beside its CRDT frames and defeat the
		// bounded candidate envelope.
		const candidates = records.map((candidate) => ({
			bodyId: candidate.bodyId,
			bodyEpoch: candidate.bodyEpoch,
			candidateId: candidate.candidateId,
			candidateDigest: candidate.candidateDigest,
			encodedUpdates: this.candidateUpdateFrames(candidate),
		}));
		const response = await this.request({
			url: this.route("body/candidates"),
			method: "POST",
			contentType: YAOS_BINARY_CONTENT_TYPE,
			body: encodeBinaryEnvelope({ candidates }).slice().buffer,
			headers: this.headers(),
		});
		if (response.status !== 200) throw mutationRequestError(response, "body candidate batch request");
		return response.json as CandidateBatchReceipt;
	}

	async commitCreateBulk(request: BulkCreateRequest): Promise<BulkCreateResponse> {
		const response = await this.request({
			url: this.route("lifecycle/create-bulk"),
			method: "POST",
			contentType: YAOS_BINARY_CONTENT_TYPE,
			body: encodeBinaryEnvelope({
				batchId: request.batchId,
				rootEpoch: request.rootEpoch,
				...(request.rootStateVector ? { rootStateVector: request.rootStateVector } : {}),
				files: request.files,
				attachments: request.attachments,
			}).slice().buffer,
			headers: this.headers(),
		});
		if (response.status !== 200) throw mutationRequestError(response, "bulk create");
		return decodeBinaryEnvelope(new Uint8Array(response.arrayBuffer)) as BulkCreateResponse;
	}

	async commitLifecycleBatch(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleBatchReceipt> {
		const response = await this.request({
			url: this.route("lifecycle/batch"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ operations: requests }),
			headers: this.headers(),
		});
		if (response.status !== 200) {
			throw mutationRequestError(response, "lifecycle batch commit");
		}
		return response.json as LifecycleBatchReceipt;
	}
	async publishLifecycleRoot(
		operations: readonly LifecyclePublicationOperation[],
		rootUpdate: Uint8Array,
		rootEpoch: SemanticEpoch,
	): Promise<RootPublicationReceipt> {
		const response = await this.request({
			url: this.route("lifecycle/publish"),
			method: "POST",
			contentType: YAOS_BINARY_CONTENT_TYPE,
			body: encodeBinaryEnvelope({ operations, rootUpdate, rootEpoch }).slice().buffer,
			headers: this.headers(),
		});
		if (response.status !== 200) {
			throw mutationRequestError(response, "lifecycle root publication");
		}
		return response.json as RootPublicationReceipt;
	}

	async publishAttachment(mutation: AttachmentPublicationMutation, rootEpoch: SemanticEpoch): Promise<AttachmentPublicationReceipt> {
		const response = await this.request({
			url: this.route("attachments/publish"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ ...mutation, rootEpoch }),
			headers: this.headers(),
		});
		if (response.status !== 200) {
			const body = response.json as { error?: unknown } | null;
			const code = typeof body?.error === "string" ? body.error : "unknown";
			const mismatch = code === "attachment_revision_mismatch"
				? parseAttachmentRevisionMismatch(response.json)
				: null;
			throw new AttachmentPublicationError(
				response.status,
				code,
				mismatch,
				parseSemanticEpochMismatchPayload(response.json),
			);
		}
		return decodeBinaryEnvelope(new Uint8Array(response.arrayBuffer)) as AttachmentPublicationReceipt;
	}

	async committedOperationOutcome(input: {
		operationId: string;
		requestDigest: string;
		authority: VaultAuthorityIdentity;
	}): Promise<CommittedOperationOutcome | null> {
		const query = new URLSearchParams({
			requestDigest: input.requestDigest,
			membershipRevision: String(input.authority.membershipRevision),
			deviceCredentialRevision: String(input.authority.deviceCredentialRevision),
			deviceId: input.authority.deviceId,
		});
		const response = await this.request({
			url: `${this.route(`operations/${encodeURIComponent(input.operationId)}/outcome`)}?${query}`,
			method: "GET",
			headers: this.headers(),
		});
		if (response.status === 404 && (response.json as { error?: unknown } | undefined)?.error === "operation_outcome_not_found") return null;
		if (response.status !== 200) throw new Error(`operation outcome request failed (${response.status})`);
		const value = response.json as Partial<CommittedOperationOutcome> | null;
		if (!value || value.operationId !== input.operationId || value.requestDigest !== input.requestDigest
			|| value.committed !== true || !Number.isSafeInteger(value.vaultSequence) || value.vaultSequence! < 0) {
			throw new Error("operation outcome proof mismatch");
		}
		return value as CommittedOperationOutcome;
	}

	private route(resource: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/${resource}`;
	}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}` };
	}

	private candidateUpdateFrames(record: CandidateRecord): Uint8Array[] {
		const updates = record.encodedUpdates;
		if (!updates || updates.length === 0) return [new Uint8Array(record.encodedUpdate)];
		return updates.map((update) => new Uint8Array(update.slice(0)));
	}
}

/**
 * Canonical client runtime. Root synchronization and awareness remain on one
 * provider; open Markdown bodies own ordinary reference-counted providers.
 */
export class VaultSync implements SyncRuntimePort {
	ydoc = new Y.Doc({ guid: ROOT_DOCUMENT_ID });
	private bulkRootRejectionCount = 0;
	private lastBulkRootRejection: { batchId: string; reason: string; at: number } | null = null;
	pathToId = this.ydoc.getMap<string>("pathToId");
	pathToBlob = this.ydoc.getMap<BlobRef>("pathToBlob");
	pathToSemantic = this.ydoc.getMap<SemanticPathRef>("pathToSemantic");
	blobMeta = this.ydoc.getMap<BlobMeta>("blobMeta");
	blobTombstones = this.ydoc.getMap<BlobTombstone & { previousHash?: string | null }>("blobTombstones");
	meta = this.ydoc.getMap<unknown>("meta");
	readonly bodies: BodyManager;
	readonly canvases: CanvasManager | null;
	provider: SyncProviderPort;
	readonly deviceId: string;

	private readonly options: Required<Pick<VaultSyncOptions,
		"maxLoadedBodies" | "candidateDebounceMs" | "candidateMaxWaitMs" | "bodySyncTimeoutMs">> & VaultSyncOptions;
	private readonly server: VaultServerPort;
	private readonly sessions = new Map<string, BodySession>();
	private readonly semanticMirrors = new Map<string, { doc: Y.Doc; mirror: FrontmatterSemanticMirror }>();
	private readonly currentnessChecks = new Map<string, Promise<LoadedBody>>();
	private readonly consumerGenerations = new Map<string, number>();
	private readonly textToBodyId = new WeakMap<Y.Text, string>();
	private readonly pendingCandidates = new Map<string, PendingCandidate>();
	/** D5 guard: bodies whose create has no receipt yet (bodyId → path). Nothing is submitted for them. */
	private readonly unconfirmedCreates = new Map<string, string>();
	/** Paths whose create batch is in flight; resolves after local settlement. */
	private readonly createsInFlight = new Map<string, Promise<BulkCreateItemResult>>();
	/** One in-flight disk revive per body; concurrent delete-revive paths share it. */
	private readonly revivesInFlight = new Map<string, { path: string; settled: Promise<void> }>();
	private readonly createCollector = new Map<string, CreateCollectorEntry>();
	private createCollectorBytes = 0;
	/** Create-bulk caps learned from a 413 body (tighter than or equal to the advertised ones). */
	private learnedBulkCreateCaps: BulkCreateServerCaps | null = null;
	private createCollectorTimer: ReturnType<typeof setTimeout> | null = null;
	private createBatchChain: Promise<void> = Promise.resolve();
	private readonly activeCreateBatches = new Set<string>();
	private readonly pendingUpdates = new Map<string, Uint8Array[]>();
	private readonly pendingRelayMarks = new Map<string, RelayMark | null>();
	private readonly relayFallbackTimers = new Map<string, unknown>();
	private readonly relayConfirmationWaiters = new Set<{
		channel: RelayReceiptChannel; seq: number; resolve: (confirmed: boolean) => void;
	}>();
	private relayClock!: OverdueWorkClock;
	private readonly bodyPersistenceWork = new Map<string, Promise<void>>();
	private readonly attachmentOperations = new Map<string, StoredAttachmentPublicationOperation>();
	private readonly attachmentOperationDurability = new Map<string, Promise<StoredAttachmentPublicationOperation>>();
	private readonly attachmentTerminalOutcomes = new Map<string, AttachmentIntentOutcome>();
	private readonly attachmentOutcomeWaiters = new Set<string>();
	/** Attachment operations that must use the single publication route. */
	private readonly attachmentBulkIneligible = new Set<string>();
	private readonly fatalAttachmentPublicationIds = new Set<string>();
	private attachmentPublicationDrain: Promise<void> | null = null;
	private attachmentPublicationWork: Promise<void> = Promise.resolve();
	private readonly providerSyncListeners = new Set<(generation: number) => void>();
	private readonly fatalAuthListeners = new Set<() => void>();
	private readonly runtimeScope = new RuntimeScope();
	private readonly socketAdmission: SocketAdmissionCoordinator;
	private readonly socketLiveness: SocketLivenessCoordinator;
	private readonly socketSessions = new WeakMap<SyncProviderPort, SocketSession>();
	private readonly currentnessWaiters = new Map<string, CurrentnessWaiter>();
	private readonly pendingRootCurrentness = new Map<string, Array<(value: { queried: boolean; head: BodyCurrentnessHead | null }) => void>>();
	private rootCurrentnessScheduled = false;
	/**
	 * Providers whose next `disconnected` status was caused by this runtime
	 * (liveness abort or a socket admission replacing the socket) and is
	 * already being recovered. Cleared by the next `connected` status.
	 */
	private readonly expectedDisconnects = new WeakSet<SyncProviderPort>();
	/** Root ticket minted by the current admission, consumed by the socket open. */
	private admissionRootTicket: {
		readonly ticket: SocketTicketResult;
		readonly rootEpoch: SemanticEpoch;
		readonly authority: VaultAuthorityIdentity | undefined;
	} | null = null;
	private readonly residencyAdmission: ResidencyAdmissionCoordinator;
	private readonly residencyRuntime: ResidencyAdmissionRuntime;
	private readonly workScheduler: VaultWorkScheduler;
	private readonly residencyObservedBodyIds = new Set<string>();
	private reconnectRequester: ((reason: string, delayMs?: number) => void) | null = null;
	/** Reconnect delay for sockets that close again right after opening (see ShortLivedConnectionBackoff). */
	private readonly flapBackoff: ShortLivedConnectionBackoff;
	/** Per-document admission rate limit (never-opened churn + circuit breaker). */
	private readonly admissionGate: SocketAdmissionGate;
	/** When a provider was first seen CONNECTING (see PROVIDER_CONNECT_TIMEOUT_MS). */
	private readonly providerConnectingSince = new WeakMap<SyncProviderPort, number>();
	/** Flap-backoff reconnect floors per document (see queueReconnect). */
	private readonly reconnectFloors = new Map<string, number>();
	private reconnectBlocked: (() => boolean) | null = null;
	private readonly renameBatch = new Map<string, string>();
	private renameTimer: number | null = null;
	private renameBatchListener: ((renames: Map<string, string>) => void) | null = null;
	private readonly pendingRenameTargets = new Map<string, string>();
	private destroyed = false;
	private _localReady = false;
	private _rootEpoch: SemanticEpoch = INITIAL_SEMANTIC_EPOCH;
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
	/** D8 back-off; unlike submissionPausedUntil, VAULT_READY does not clear it. */
	private dailyLimitPausedUntil = 0;
	private dailyLimit: DailyLimitInfo | null = null;
	/** D8: consecutive limited probes in this trip streak (sets the next probe interval). */
	private dailyLimitProbes = 0;
	/** Pending waitForSubmissionWindow sleeps; destroy() wakes them. */
	private readonly submissionWindowWakers = new Set<() => void>();
	private backpressureLevel = 0;
	private readonly editorAdmissionSamples: EditorAdmissionSample[] = [];
	private readonly editorAdmissionPending = new Map<string, { sample: EditorAdmissionSample; startedAt: number }>();
	private readonly semanticEpochResetRetryTimers = new Map<string, number>();

	static async create(options: VaultSyncOptions): Promise<VaultSync> {
		const root = await options.database.getDocument(ROOT_DOCUMENT_ID);
		const runtime = new VaultSync(options, root);
		await runtime.initialize(root);
		return runtime;
	}

	constructor(options: VaultSyncOptions, preloadedRoot?: StoredDocument | null) {
		if (!options.vaultGeneration.trim()) throw new Error("vault generation is required");
		this.options = {
			...options,
			maxLoadedBodies: options.maxLoadedBodies ?? DEFAULT_MAX_LOADED_BODIES,
			candidateDebounceMs: options.candidateDebounceMs ?? clientTimer("candidateDebounceMs", DEFAULT_CANDIDATE_DEBOUNCE_MS),
			candidateMaxWaitMs: options.candidateMaxWaitMs ?? clientTimer("candidateMaxWaitMs", DEFAULT_CANDIDATE_MAX_WAIT_MS),
			bodySyncTimeoutMs: options.bodySyncTimeoutMs ?? DEFAULT_BODY_SYNC_TIMEOUT_MS,
		};
		if (preloadedRoot && preloadedRoot.kind !== "root") throw new Error("root cache has non-root epoch metadata");
		if (preloadedRoot) {
			this._rootEpoch = preloadedRoot.rootEpoch;
			this._rootGeneration = preloadedRoot.generation;
			if (preloadedRoot.encodedState.byteLength) {
				Y.applyUpdate(this.ydoc, new Uint8Array(preloadedRoot.encodedState), "indexeddb-bootstrap");
			}
			if (this.ydoc.getMap("sys").get("schemaVersion") !== SCHEMA_VERSION) {
				throw new Error(`local root cache is not schema ${SCHEMA_VERSION}`);
			}
		}
		this.deviceId = options.deviceId;
		const request = detectDailyLimitResponses(options.request ?? obsidianRequest,
			(info) => this.tripDailyLimit(info), () => this.now());
		this.server = options.server ?? new VaultSyncHttpPort(
			options.host,
			options.vaultId,
			options.token,
			request,
		);
		const factory = options.providerFactory ?? ((input: ProviderFactoryInput) => this.createDefaultProvider(input));
		const canvasDatabase = this.canvasPersistence(options.database);
		this.canvases = canvasDatabase && options.canvasProjection ? new CanvasManager(
			options.vaultGeneration,
			canvasDatabase,
			new CanvasHttpTransport(options.host, options.vaultId, options.token, request),
			options.canvasProjection,
			options.now,
			32,
			(documentId, bodyEpoch, doc) => factory({ kind: "semantic", documentId,
				documentEpoch: bodyEpoch, doc,
				onClose: (event) => this.handleNativeSocketClose(event) }),
			{
				created: (documentId, provider) => {
					this.registerSocketLiveness(documentId, provider, () => this.canvases?.reconnectLive(documentId));
					provider.on("custom-message", (payload) => this.handleVaultControl(payload, documentId, provider));
					provider.on("status", ({ status }) => {
						if (status === "connected") {
							this.invalidateSocketSession(provider);
							this.socketLiveness.connected(documentId);
						} else if (status === "disconnected") {
							this.invalidateSocketSession(provider);
							this.socketLiveness.disconnected(documentId);
						}
					});
				},
				destroyed: (documentId, provider) => {
					this.socketLiveness.unregister(documentId);
					this.invalidateSocketSession(provider);
				},
				},
				() => this._rootEpoch,
				(minimumEpoch) => this.recoverRootSemanticEpoch(minimumEpoch),
			) : null;
		this.bodies = new BodyManager(
			options.database,
			options.now,
			undefined,
			undefined,
			new BodyCoordinator(this.runtimeScope),
		);
		const residencyLimits: ResidencyAdmissionLimits = {
			residentCost: DEFAULT_BODY_ESTIMATED_COST_BUDGET,
			transientCost: DEFAULT_TRANSIENT_COST_BUDGET,
			concurrentLoads: 2,
			warmBodies: this.options.maxLoadedBodies,
			sockets: DEFAULT_BODY_SOCKET_BUDGET,
			reservedSockets: 1,
			warmRetentionMs: DEFAULT_WARM_RETENTION_MS,
			backgroundPromotionMs: DEFAULT_BACKGROUND_PROMOTION_MS,
			maxPreferredBurst: DEFAULT_PREFERRED_BURST,
			...options.residencyAdmissionLimits,
		};
		this.residencyAdmission = new ResidencyAdmissionCoordinator(residencyLimits);
		this.residencyRuntime = new ResidencyAdmissionRuntime({
			coordinator: this.residencyAdmission,
			now: () => this.now(),
			refreshObservations: () => this.refreshResidencyObservations(),
			prepare: (reservation) => this.prepareResidencyReservation(reservation),
			onBackpressure: (bodyId, reason) => this.log(`body admission backpressured for ${bodyId}: ${reason}`),
		});
		this.provider = factory({ kind: "root", documentId: ROOT_DOCUMENT_ID,
			documentEpoch: this._rootEpoch, doc: this.ydoc,
			onClose: (event) => this.handleNativeSocketClose(event) });
		const admissionRandom = options.workRandom;
		this.admissionGate = new SocketAdmissionGate(admissionRandom ? { random: () => admissionRandom.next() } : {});
		this.socketAdmission = new SocketAdmissionCoordinator({
			scope: this.runtimeScope,
			gate: this.admissionGate,
			now: () => this.now(),
			refreshCredential: async (epoch, force, providerId) => {
				const ticket = await this.refreshProviderTickets(force, epoch, providerId === undefined || providerId === ROOT_DOCUMENT_ID);
				return { expiresAt: ticket.localExpiresAt };
			},
			providers: () => [this.asAdmissionProvider(ROOT_DOCUMENT_ID, this.provider)],
			afterAdmission: async (epoch) => {
				if (!epoch.isCurrent()) return;
				this.workScheduler.poke("socket-admission-completed");
			},
			classifyFailure: (error) => this.classifySocketAdmissionFailure(error),
			isBlocked: () => this.destroyed || this.fatalAuthError,
			log: (message) => this.log(message),
		});
		const workClock = options.workClock ?? {
			now: () => this.now(),
			setTimer: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
			clearTimer: (handle: unknown) => window.clearTimeout(handle as number),
		};
		this.relayClock = workClock;
		this.socketLiveness = new SocketLivenessCoordinator(workClock);
		const workRandom = options.workRandom;
		this.flapBackoff = new ShortLivedConnectionBackoff(workRandom ? { random: () => workRandom.next() } : {});
		this.registerSocketLiveness(ROOT_DOCUMENT_ID, this.provider);
		this.workScheduler = new VaultWorkScheduler({
			clock: workClock,
			...(options.workRandom === undefined ? {} : { random: options.workRandom }),
			reconnect: (reason) => this.runReconnectWork(reason),
			wakeBody: (bodyId, minimumGeneration) => this.runBodyWakeWork(bodyId, minimumGeneration),
			flushCandidate: (bodyId) => this.runCandidateWork(bodyId),
			retryLifecycle: (groupKey) => this.runLifecycleReplayWork(groupKey),
			retryAttachmentPublications: () => this.runAttachmentPublicationWork(),
			onError: (error) => this.log(`overdue work kernel error: ${String(error)}`),
		});
		this.wireRootProvider();
	}

	private canvasPersistence(database: VaultDatabasePort): CanvasPersistencePort | null {
		const candidate = database as VaultDatabasePort & Partial<CanvasPersistencePort>;
		return typeof candidate.putCanvasCandidate === "function"
			&& typeof candidate.listCanvasCandidates === "function"
			&& typeof candidate.deleteCanvasCandidate === "function"
			&& typeof candidate.putCanvasLifecycle === "function"
			&& typeof candidate.listCanvasLifecycle === "function"
			&& typeof candidate.deleteCanvasLifecycle === "function"
			&& typeof candidate.getCanvasSettlement === "function"
			&& typeof candidate.putCanvasSettlement === "function"
			&& typeof candidate.replaceCanvasSemanticEpoch === "function"
			? candidate as CanvasPersistencePort : null;
	}

	get localReady(): boolean { return this._localReady; }
	get connected(): boolean {
		const root = this.socketLiveness.snapshot().find((entry) => entry.id === ROOT_DOCUMENT_ID);
		return this.provider.wsconnected && this.provider.ws?.readyState === 1
			&& (root?.phase === "healthy" || (root?.phase === "probing"
				&& root.lastAcknowledgedAt !== null
				&& this.now() - root.lastAcknowledgedAt <= SOCKET_LIVENESS_IDLE_MS + SOCKET_LIVENESS_TIMEOUT_MS));
	}
	get websocketOpen(): boolean { return this.provider.wsconnected && this.provider.ws?.readyState === 1; }
	get applicationResponsive(): boolean | null {
		const root = this.socketLiveness.snapshot().find((entry) => entry.id === ROOT_DOCUMENT_ID);
		if (!this.websocketOpen || !root || root.phase === "disconnected" || root.phase === "awaiting_ready") return null;
		if (root.phase === "failed") return false;
		if (root.phase === "healthy") return true;
		if (root.phase === "probing" && root.lastAcknowledgedAt !== null
			&& this.now() - root.lastAcknowledgedAt <= SOCKET_LIVENESS_IDLE_MS + SOCKET_LIVENESS_TIMEOUT_MS) return true;
		return null;
	}
	get lastLivenessAckAt(): number | null {
		return this.socketLiveness.snapshot().find((entry) => entry.id === ROOT_DOCUMENT_ID)?.lastAcknowledgedAt ?? null;
	}
	getSocketLivenessSnapshot(): readonly SocketLivenessSnapshot[] { return this.socketLiveness.snapshot(); }
	getCanvasStats(): ReturnType<CanvasManager["stats"]> | null { return this.canvases?.stats() ?? null; }
	get hasPendingLocalWork(): boolean {
		const bodyStats = this.bodies.stats();
		return (
			this.workScheduler.diagnostics().queue.some((item) => !CONNECTION_WORK_KEYS.has(item.key))
			|| this.pendingUpdates.size > 0
			|| this.pendingCandidates.size > 0
			|| this.bodyPersistenceWork.size > 0
			|| this.attachmentOperations.size > 0
			|| bodyStats.dirty > 0
			|| bodyStats.unsettled > 0
			|| bodyStats.pendingLocalUpdates > 0
		);
	}
	get pendingAttachmentOperations(): number { return this.attachmentOperations.size; }
	get fatalAttachmentPublications(): number { return this.fatalAttachmentPublicationIds.size; }
	get connectionGeneration(): number { return this._connectionGeneration; }
	get fatalAuthError(): boolean { return this._fatalAuthCode !== null; }
	get fatalAuthCode(): FatalSyncCode | null { return this._fatalAuthCode; }
	get fatalAuthDetails(): FatalSyncDetails | null { return this._fatalAuthDetails; }
	get lastLocalUpdateAt(): number | null { return this._lastLocalUpdateAt; }
	get lastLocalUpdateWhileConnectedAt(): number | null { return this._lastLocalUpdateWhileConnectedAt; }
	get lastRemoteUpdateAt(): number | null { return this._lastRemoteUpdateAt; }
	get serverAppliedLocalState(): boolean | null {
		// Local edits still inside the candidate debounce are not captured as
		// candidates yet; claiming the server has "the latest local state" then
		// was false during every burst of typing (and every stalled socket).
		if (this.pendingCandidates.size > 0 || this.pendingUpdates.size > 0) return false;
		return this._lastReceiptAt === null ? null : true;
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

	getBodyResidencySnapshot(): BodyResidencySnapshot {
		this.refreshResidencyObservations();
		return this.bodies.residencySnapshot();
	}

	getResidencyAdmissionSnapshot(): ResidencyAdmissionSnapshot {
		this.refreshResidencyObservations();
		return this.residencyAdmission.snapshot();
	}

	setResidencyRuntimeContext(platform: RuntimePlatform, visibility: RuntimeVisibility): void {
		this.residencyAdmission.setRuntimeContext(platform, visibility);
		this.residencyRuntime.poke();
		if (platform === "mobile" && visibility === "background") {
			void this.runResidencyMaintenance().catch((error) => {
				this.log(`background residency maintenance failed: ${String(error)}`);
			});
		}
	}

	async runResidencyMaintenance(): Promise<void> {
		if (this.destroyed) return;
		this.refreshResidencyObservations();
		const plan = this.residencyAdmission.planMaintenance(this.now());
		for (const bodyId of plan.closeSocketBodyIds) this.closeIdleBodySession(bodyId);
		for (const bodyId of plan.evictBodyIds) {
			await this.evictIdleBody(bodyId);
		}
		this.refreshResidencyObservations();
		this.residencyRuntime.poke();
	}

	async initialize(preloadedRoot?: StoredDocument | null): Promise<void> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		const root = preloadedRoot === undefined
			? await this.options.database.getDocument(ROOT_DOCUMENT_ID)
			: preloadedRoot;
		if (this.destroyed) throw new Error("runtime closed during initialization");
		if (root && root.kind !== "root") throw new Error("root cache has non-root epoch metadata");
		if (preloadedRoot === undefined) {
			this._rootEpoch = root?.rootEpoch ?? INITIAL_SEMANTIC_EPOCH;
			this._rootGeneration = root?.generation ?? 0;
			if (root?.encodedState.byteLength) {
				Y.applyUpdate(this.ydoc, new Uint8Array(root.encodedState), "indexeddb-bootstrap");
			}
			if (root && this.ydoc.getMap("sys").get("schemaVersion") !== SCHEMA_VERSION) {
				throw new Error(`local root cache is not schema ${SCHEMA_VERSION}`);
			}
		}
		await this.canvases?.initialize(this.pathToSemantic.entries());
		await this.restoreUnconfirmedCreates();
		await this.restoreCandidates();
		await this.queueStoredLifecycleOperations();
		await this.workScheduler.whenIdle();
		await this.restoreAttachmentOperations();
		if (this.attachmentOperations.size > 0) {
			await this.workScheduler.queueAttachmentPublications();
			await this.workScheduler.whenIdle();
		}
		this._localReady = true;
		if (this.destroyed) throw new Error("runtime closed during initialization");
		const admission = await this.socketAdmission.admit(
			this.asAdmissionProvider(ROOT_DOCUMENT_ID, this.provider),
			"startup",
		);
		this.applyTerminalAdmissionOutcome(admission);
		if (admission.kind !== "completed") {
			throw new Error(`root socket admission failed: ${admission.kind}`);
		}
		const pendingBodyIds = new Set(
			Array.from(this.pendingCandidates.values(), (candidate) => candidate.record.bodyId),
		);
		for (const bodyId of pendingBodyIds) await this.workScheduler.queueCandidateNow(bodyId);
		this.workScheduler.poke("startup-reconstruction");
		await this.workScheduler.whenIdle();
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
		const capturedAuthority = this.captureAuthority();
		const replayGroupKey = batchId ? `batch:${batchId}` : `single:${requests[0]!.operationId}`;
		try {
		for (let index = 0; index < requests.length; index++) {
			const request = requests[index]!;
			this.assertLifecyclePaths(request);
			if (request.kind === "create") {
				throw new Error("creates travel only through bulk create (commitFreshBody/commitFreshBodies)");
			}
			await save.call(this.options.database, {
				...this.toStoredLifecycleOperation(request),
				authority: capturedAuthority,
				batchId,
				batchIndex: batchId ? index : null,
			});
		}
		if (!this.isCapturedAuthorityCurrent(capturedAuthority)) {
			const recovered = await this.recoverLifecycleReceipts(requests, requests.map(() => capturedAuthority));
			if (recovered) {
				await this.publishLifecycleRoot(requests, recovered);
				if (requests.length > 1) await removeBatch!.call(this.options.database, requests.map((request) => request.operationId));
				else await remove.call(this.options.database, requests[0]!.operationId);
				return recovered;
			}
			for (const request of requests) this.noteAuthoritySuperseded("lifecycle", request.operationId, capturedAuthority);
			throw new Error("authority_superseded");
		}
		let receipts: LifecycleReceipt[];
		try {
			receipts = await this.commitLifecycleRequests(requests);
		} catch (error) {
			if (this.isRedundantRevive(error, requests)) {
				// Another revive of the same body already won (concurrent
				// delete-revive paths): the stored op could never commit.
				if (requests.length > 1) await removeBatch!.call(this.options.database, requests.map((request) => request.operationId));
				else await remove.call(this.options.database, requests[0]!.operationId);
			}
			const recovered = this.shouldQueryOperationOutcome(error)
				? await this.recoverLifecycleReceipts(requests, requests.map(() => capturedAuthority))
				: null;
			if (!recovered) throw error;
			receipts = recovered;
		}
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
		} catch (error) {
			await this.queueLifecycleReplaySafely(replayGroupKey);
			throw error;
		}
	}

	onProviderSync(callback: (generation: number) => void): void {
		this.providerSyncListeners.add(callback);
	}

	onFatalAuth(callback: () => void): () => void {
		this.fatalAuthListeners.add(callback);
		if (this.fatalAuthError) callback();
		return () => this.fatalAuthListeners.delete(callback);
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
		return ref;
	}

	getObservedAttachmentHead(path: string): AttachmentHead {
		const ref = this.pathToBlob.get(path);
		if (ref && safeBlobPath(path, [], "", ref)) {
			return { kind: "active", revision: ref.revision, hash: ref.hash, size: ref.size };
		}
		const tombstone = this.blobTombstones.get(path);
		if (tombstone && safeBlobPath(path)) {
			return { kind: "deleted", revision: tombstone.revision, previousHash: tombstone.previousHash ?? null };
		}
		return { kind: "missing", revision: null };
	}

	getProjectedAttachmentHead(path: string): AttachmentHead {
		const heads = new Map<string, AttachmentHead>();
		const getHead = (candidatePath: string): AttachmentHead => {
			const existing = heads.get(candidatePath);
			if (existing) return existing;
			const observed = this.getObservedAttachmentHead(candidatePath);
			heads.set(candidatePath, observed);
			return observed;
		};
		for (const { mutation } of this.sortedAttachmentOperations()) {
			if (mutation.kind === "upsert") {
				heads.set(mutation.path, {
					kind: "active",
					revision: mutation.operationId,
					hash: mutation.hash,
					size: mutation.size,
				});
			} else if (mutation.kind === "delete") {
				const prior = getHead(mutation.path);
				heads.set(mutation.path, {
					kind: "deleted",
					revision: mutation.operationId,
					previousHash: prior.kind === "active" ? prior.hash : prior.kind === "deleted" ? prior.previousHash : null,
				});
			} else {
				const source = getHead(mutation.fromPath);
				heads.set(mutation.fromPath, {
					kind: "deleted",
					revision: mutation.operationId,
					previousHash: source.kind === "active" ? source.hash : source.kind === "deleted" ? source.previousHash : null,
				});
				if (source.kind === "active") {
					heads.set(mutation.toPath, { ...source, revision: mutation.operationId });
				}
			}
		}
		return getHead(path);
	}

	private sortedAttachmentOperations(): StoredAttachmentPublicationOperation[] {
		return [...this.attachmentOperations.values()].sort((left, right) => {
			const leftSequence = left.localSequence > 0 ? left.localSequence : Number.MAX_SAFE_INTEGER;
			const rightSequence = right.localSequence > 0 ? right.localSequence : Number.MAX_SAFE_INTEGER;
			return leftSequence - rightSequence;
		});
	}

	isAttachmentTombstoned(path: string): boolean {
		return safeBlobPath(path) !== null && this.blobTombstones.has(path);
	}

	async setAttachmentRef(path: string, hash: string, size: number, mime: string, intent: {
		operationId: string;
		expectedRevision: string | null;
	}): Promise<AttachmentIntentOutcome> {
		const ref = { hash, size, revision: "validation" };
		const canonical = safeBlobPath(path, [], "", ref);
		if (!canonical) throw new Error(`Invalid attachment path or reference: ${path}`);
		return this.commitAttachmentPublication({
			operationId: intent.operationId,
			kind: "upsert",
			path: canonical,
			expectedRevision: intent.expectedRevision,
			hash,
			size,
			mime,
		});
	}

	async deleteAttachmentRef(path: string, _device?: string): Promise<AttachmentIntentOutcome> {
		const canonical = safeBlobPath(path);
		if (!canonical) throw new Error(`Invalid attachment path: ${path}`);
		return this.commitAttachmentPublication({
			operationId: crypto.randomUUID(),
			kind: "delete",
			path: canonical,
			expectedRevision: this.getProjectedAttachmentHead(canonical).revision,
		});
	}

	async renameAttachmentRef(oldPath: string, newPath: string): Promise<AttachmentIntentOutcome> {
		const oldCanonical = safeBlobPath(oldPath);
		const source = oldCanonical ? this.getProjectedAttachmentHead(oldCanonical) : null;
		const ref = source?.kind === "active" ? { hash: source.hash, size: source.size, revision: source.revision } : undefined;
		const newCanonical = ref ? safeBlobPath(newPath, [], "", ref) : null;
		if (!oldCanonical || !newCanonical) throw new Error("Invalid attachment rename");
		if (oldCanonical === newCanonical || !ref || !source || source.kind !== "active") {
			return { kind: "committed", revision: source?.revision ?? "" };
		}
		return this.commitAttachmentPublication({
			operationId: crypto.randomUUID(),
			kind: "rename",
			fromPath: oldCanonical,
			toPath: newCanonical,
			expectedFromRevision: source.revision,
			expectedToRevision: this.getProjectedAttachmentHead(newCanonical).revision,
		});
	}

	private async commitAttachmentPublication(
		proposed: AttachmentPublicationMutation,
	): Promise<AttachmentIntentOutcome> {
		this.assertAttachmentMutation(proposed);
		const existing = this.attachmentOperations.get(proposed.operationId);
		if (existing && !this.sameAttachmentMutation(existing.mutation, proposed)) {
			this.emitAttachmentPublicationEvent(
				PRODUCT_EVENT_KIND.attachmentPublicationIdentityMismatch,
				existing,
				"error",
			);
			throw new AttachmentPublicationError(409, "attachment_operation_identity_mismatch");
		}
		const operation = existing ?? {
			vaultId: this.options.vaultId,
			vaultGeneration: this.options.vaultGeneration,
			rootEpoch: this._rootEpoch,
			mutation: proposed,
			localSequence: 0,
			createdAt: this.now(),
			attempts: 0,
			lastAttemptAt: null,
			authority: this.captureAuthority(),
		};
		if (!existing) {
			// Reserve the projected head before awaiting IndexedDB. A delete or
			// rename arriving during this durability boundary must chain after this
			// operation if it commits, rather than independently planning at R0.
			this.attachmentOperations.set(proposed.operationId, operation);
			const durability = this.options.database.putAttachmentOperation(operation);
			this.attachmentOperationDurability.set(proposed.operationId, durability);
			try {
				const stored = await durability;
				this.assertStoredAttachmentOperation(operation, stored);
				this.attachmentOperations.set(proposed.operationId, stored);
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
		this.attachmentOutcomeWaiters.add(operation.mutation.operationId);
		try {
			await this.workScheduler.queueAttachmentPublications();
			while (this.attachmentOperations.has(operation.mutation.operationId)) {
				await this.requestAttachmentPublicationDrain();
			}
			const terminal = this.attachmentTerminalOutcomes.get(operation.mutation.operationId);
			this.attachmentTerminalOutcomes.delete(operation.mutation.operationId);
			this.attachmentOutcomeWaiters.delete(operation.mutation.operationId);
			return terminal ?? { kind: "committed", revision: operation.mutation.operationId };
		} catch (error) {
			this.attachmentOutcomeWaiters.delete(operation.mutation.operationId);
			if (error instanceof AttachmentPublicationProofError) throw error;
			if (error instanceof AttachmentPublicationError && error.status < 500) throw error;
			this.emitAttachmentPublicationEvent(
				PRODUCT_EVENT_KIND.attachmentPublicationDurablePending,
				operation,
				"warn",
			);
			return { kind: "durably-pending", operationId: operation.mutation.operationId };
		}
	}

	private requestAttachmentPublicationDrain(): Promise<void> {
		if (this.attachmentPublicationDrain) return this.attachmentPublicationDrain;
		const drain = this.drainAttachmentPublications();
		this.attachmentPublicationDrain = drain;
		this.attachmentPublicationWork = drain.catch(() => undefined);
		void drain.finally(() => {
			if (this.attachmentPublicationDrain === drain) this.attachmentPublicationDrain = null;
		}).catch(() => undefined);
		return drain;
	}

	private async drainAttachmentPublications(): Promise<void> {
		while (true) {
			// D6: leading new-attachment upserts travel together in one bulk create.
			const run = this.leadingBulkAttachmentRun();
			if (run.length >= 2) {
				try {
					await this.publishAttachmentBulk(run);
				} catch (error) {
					// The single route owns every precise error path (mismatch chains,
					// proofs, durable pending); fall back to it for this run.
					if (error instanceof VaultMutationRequestError) this.learnBulkCreateCaps(error);
					for (const operation of run) this.attachmentBulkIneligible.add(operation.mutation.operationId);
					this.log(`bulk attachment publication fell back to single publication: ${String(error)}`);
				}
				continue;
			}
			const operation = this.sortedAttachmentOperations().find((candidate) => candidate.localSequence > 0);
			if (!operation) return;
			try {
				await this.publishStoredAttachmentOperation(operation);
			} catch (error) {
				if (error instanceof AttachmentPublicationError
					&& error.status === 409
					&& error.code === "attachment_revision_mismatch") {
					await this.retireSupersededAttachmentChain(operation, error);
					continue;
				}
				if (error instanceof AttachmentPublicationError
					&& error.code === "attachment_operation_identity_mismatch") {
					this.emitAttachmentPublicationEvent(
						PRODUCT_EVENT_KIND.attachmentPublicationIdentityMismatch,
						operation,
						"error",
					);
				} else if (error instanceof AttachmentPublicationError
					&& error.code === "attachment_mutation_busy") {
					this.emitAttachmentPublicationEvent(
						PRODUCT_EVENT_KIND.attachmentPublicationMutationBusy,
						operation,
						"warn",
					);
				}
				if (error instanceof AttachmentPublicationProofError
					|| (error instanceof AttachmentPublicationError && error.status < 500)) {
					this.fatalAttachmentPublicationIds.add(operation.mutation.operationId);
				}
				throw error;
			}
		}
	}

	private leadingBulkAttachmentRun(): StoredAttachmentPublicationOperation[] {
		const run: StoredAttachmentPublicationOperation[] = [];
		const paths = new Set<string>();
		for (const operation of this.sortedAttachmentOperations()) {
			if (operation.localSequence <= 0) continue;
			const mutation = operation.mutation;
			if (mutation.kind !== "upsert" || mutation.expectedRevision !== null || paths.has(mutation.path)
				|| this.attachmentBulkIneligible.has(mutation.operationId)
				|| operation.rootEpoch !== this._rootEpoch
				|| !this.isCapturedAuthorityCurrent(operation.authority)) break;
			paths.add(mutation.path);
			run.push(operation);
			if (run.length >= this.bulkCreateCaps().maxItems) break;
		}
		return run;
	}

	private async publishAttachmentBulk(run: readonly StoredAttachmentPublicationOperation[]): Promise<void> {
		const attempted: StoredAttachmentPublicationOperation[] = [];
		for (const operation of run) {
			const next = { ...operation, attempts: operation.attempts + 1, lastAttemptAt: this.now() };
			const stored = await this.options.database.putAttachmentOperation(next);
			this.assertStoredAttachmentOperation(next, stored);
			this.attachmentOperations.set(stored.mutation.operationId, stored);
			attempted.push(stored);
		}
		const ids = attempted.map((operation) => operation.mutation.operationId);
		// Deterministic identity: the same run retried is an exact replay.
		const batchId = `att-${(await sha256Hex(new TextEncoder().encode(ids.join("\n")))).slice(0, 40)}`;
		const attachments = attempted.map((operation): BulkCreateAttachmentRequest => {
			const mutation = operation.mutation as Extract<AttachmentPublicationMutation, { kind: "upsert" }>;
			return { operationId: mutation.operationId, path: mutation.path, hash: mutation.hash,
				size: mutation.size, mime: mutation.mime };
		});
		let response: BulkCreateResponse;
		try {
			response = await this.sendCreateBatch(batchId, [], attachments);
		} catch (error) {
			if (error instanceof VaultMutationRequestError && error.status === 409
				&& error.code === "bulk_create_partial_overlap") {
				const committed = new Set(error.operationIds);
				for (const operation of attempted) {
					if (committed.has(operation.mutation.operationId)) {
						await this.finishBulkAttachment(operation, operation.mutation.operationId);
					} else {
						this.attachmentBulkIneligible.add(operation.mutation.operationId);
					}
				}
				return;
			}
			throw error;
		}
		for (let index = 0; index < attempted.length; index++) {
			const operation = attempted[index]!;
			const mutation = operation.mutation as Extract<AttachmentPublicationMutation, { kind: "upsert" }>;
			const outcome = response.outcomes[index]!;
			if (outcome.outcome === "created") {
				const head = this.pathToBlob.get(mutation.path);
				if (!head || head.revision !== mutation.operationId || head.hash !== mutation.hash) {
					this.log(`bulk attachment receipt for ${mutation.path} is not reflected in the local root yet`);
				}
				await this.finishBulkAttachment(operation, mutation.operationId);
			} else if (outcome.outcome === "exists-identical") {
				await this.finishBulkAttachment(operation, outcome.existingRevision ?? mutation.operationId);
			} else {
				// exists-different / rejected: the single route yields the precise
				// revision mismatch or error for this operation.
				this.attachmentBulkIneligible.add(mutation.operationId);
			}
		}
	}

	private async finishBulkAttachment(operation: StoredAttachmentPublicationOperation, revision: string): Promise<void> {
		const operationId = operation.mutation.operationId;
		await this.options.database.deleteAttachmentOperation(operationId);
		this.attachmentOperations.delete(operationId);
		this.fatalAttachmentPublicationIds.delete(operationId);
		this.attachmentBulkIneligible.delete(operationId);
		if (revision !== operationId && this.attachmentOutcomeWaiters.has(operationId)) {
			this.attachmentTerminalOutcomes.set(operationId, { kind: "committed", revision });
		}
		this.emitAttachmentPublicationEvent(
			operation.attempts > 1
				? PRODUCT_EVENT_KIND.attachmentPublicationReplayed
				: PRODUCT_EVENT_KIND.attachmentPublicationCommitted,
			operation,
			"info",
		);
	}

	private async publishStoredAttachmentOperation(
		operation: StoredAttachmentPublicationOperation,
	): Promise<void> {
		if (!this.isCapturedAuthorityCurrent(operation.authority)) {
			if (await this.recoverAttachmentOutcome(operation)) return;
			this.noteAuthoritySuperseded("attachment", operation.mutation.operationId, operation.authority);
			this.attachmentOperations.delete(operation.mutation.operationId);
			return;
		}
		const attempted = {
			...operation,
			attempts: operation.attempts + 1,
			lastAttemptAt: this.now(),
		};
		const storedAttempt = await this.options.database.putAttachmentOperation(attempted);
		this.assertStoredAttachmentOperation(attempted, storedAttempt);
		this.attachmentOperations.set(storedAttempt.mutation.operationId, storedAttempt);
		let receipt: AttachmentPublicationReceipt;
		try {
			receipt = await this.server.publishAttachment(attempted.mutation, attempted.rootEpoch);
		} catch (error) {
			if (error instanceof AttachmentPublicationError && error.status === 409
				&& error.code === "attachment_operation_committed_by_bulk_create") {
				await this.finishBulkAttachment(storedAttempt, attempted.mutation.operationId);
				return;
			}
			if (this.shouldQueryAttachmentOutcome(error) && await this.recoverAttachmentOutcome(attempted)) return;
			if (error instanceof AttachmentPublicationError
				&& error.semanticMismatch?.purpose === "root"
				&& error.semanticMismatch.documentId === ROOT_DOCUMENT_ID
				&& error.semanticMismatch.receivedEpoch === attempted.rootEpoch) {
				await this.recoverRootSemanticEpoch(error.semanticMismatch.expectedEpoch);
				const rebased = { ...attempted, rootEpoch: this._rootEpoch };
				const stored = await this.options.database.putAttachmentOperation(rebased);
				this.assertStoredAttachmentOperation(rebased, stored);
				this.attachmentOperations.set(stored.mutation.operationId, stored);
				return;
			}
			throw error;
		}
		await this.applyAttachmentPublication(attempted, receipt);
		await this.options.database.deleteAttachmentOperation(attempted.mutation.operationId);
		this.attachmentOperations.delete(attempted.mutation.operationId);
		this.fatalAttachmentPublicationIds.delete(attempted.mutation.operationId);
		this.emitAttachmentPublicationEvent(
			storedAttempt.attempts > 1
				? PRODUCT_EVENT_KIND.attachmentPublicationReplayed
				: PRODUCT_EVENT_KIND.attachmentPublicationCommitted,
			storedAttempt,
			"info",
		);
	}

	private async retryAttachmentOperations(): Promise<void> {
		await this.restoreAttachmentOperations();
		await this.requestAttachmentPublicationDrain();
	}

	private async restoreAttachmentOperations(): Promise<void> {
		const operations = (await this.options.database.listAttachmentOperations())
			.sort((left, right) => left.localSequence - right.localSequence);
		const sequences = new Set<number>();
		for (const operation of operations) {
			this.assertAttachmentOperationScope(operation);
			if (!this.isCapturedAuthorityCurrent(operation.authority)) {
				if (await this.recoverAttachmentOutcome(operation)) continue;
				this.noteAuthoritySuperseded("attachment", operation.mutation.operationId, operation.authority);
				continue;
			}
			this.assertAttachmentMutation(operation.mutation);
			if (!Number.isSafeInteger(operation.localSequence) || operation.localSequence <= 0
				|| sequences.has(operation.localSequence)) {
				throw new AttachmentPublicationProofError("attachment publication sequence is invalid");
			}
			sequences.add(operation.localSequence);
			const existing = this.attachmentOperations.get(operation.mutation.operationId);
			if (existing && !this.sameAttachmentMutation(existing.mutation, operation.mutation)) {
				throw new AttachmentPublicationProofError("attachment operation identity is inconsistent in local storage");
			}
			this.attachmentOperations.set(operation.mutation.operationId, operation);
		}
	}

	private shouldQueryAttachmentOutcome(error: unknown): boolean {
		return this.shouldQueryOperationOutcome(error);
	}

	private async recoverAttachmentOutcome(operation: StoredAttachmentPublicationOperation): Promise<boolean> {
		const outcome = await this.exactCommittedOutcome(
			operation.mutation.operationId,
			await operationRequestDigest({ ...operation.mutation, rootEpoch: operation.rootEpoch }),
			operation.authority,
		);
		if (!outcome) return false;
		await this.options.database.deleteAttachmentOperation(operation.mutation.operationId);
		this.attachmentOperations.delete(operation.mutation.operationId);
		this.fatalAttachmentPublicationIds.delete(operation.mutation.operationId);
		if (this.attachmentOutcomeWaiters.has(operation.mutation.operationId)) {
			this.attachmentTerminalOutcomes.set(operation.mutation.operationId, {
				kind: "committed",
				revision: operation.mutation.operationId,
			});
		}
		await this.options.onAttachmentReconciliationRequired?.(
			this.attachmentMutationPaths(operation.mutation),
			"revision-mismatch",
		);
		this.emitAttachmentPublicationEvent(PRODUCT_EVENT_KIND.attachmentPublicationReplayed, operation, "info");
		this.log(`attachment ${operation.mutation.operationId} settled from exact committed outcome at sequence ${outcome.vaultSequence}`);
		return true;
	}

	private assertStoredAttachmentOperation(
		expected: StoredAttachmentPublicationOperation,
		stored: StoredAttachmentPublicationOperation,
	): void {
		this.assertAttachmentOperationScope(stored);
		this.assertAttachmentMutation(stored.mutation);
		if (expected.vaultId !== stored.vaultId
			|| expected.vaultGeneration !== stored.vaultGeneration
			|| expected.rootEpoch !== stored.rootEpoch
			|| !this.sameAttachmentMutation(expected.mutation, stored.mutation)
			|| !Number.isSafeInteger(stored.localSequence) || stored.localSequence <= 0
			|| (expected.localSequence > 0 && stored.localSequence !== expected.localSequence)) {
			throw new AttachmentPublicationProofError("attachment publication persistence changed operation identity");
		}
	}

	private assertAttachmentOperationScope(operation: StoredAttachmentPublicationOperation): void {
		if (operation.vaultId !== this.options.vaultId
			|| operation.vaultGeneration !== this.options.vaultGeneration
			|| !Number.isSafeInteger(operation.rootEpoch) || operation.rootEpoch < 1) {
			throw new AttachmentPublicationProofError(
				"attachment publication scope does not match the active vault generation",
			);
		}
	}

	private assertAttachmentMutation(mutation: AttachmentPublicationMutation): void {
		const validIdentity = (value: string): boolean => value.length > 0 && value.length <= 128;
		const validRevision = (value: string | null): boolean => value === null || validIdentity(value);
		if (!validIdentity(mutation.operationId)) {
			throw new AttachmentPublicationProofError("attachment operation ID is invalid");
		}
		if (mutation.kind === "upsert") {
			if (safeBlobPath(mutation.path, [], "", mutation) !== mutation.path
				|| !validRevision(mutation.expectedRevision)
				|| typeof mutation.mime !== "string" || !mutation.mime || mutation.mime.length > 256) {
				throw new AttachmentPublicationProofError("attachment upsert mutation is invalid");
			}
		} else if (mutation.kind === "delete") {
			if (safeBlobPath(mutation.path) !== mutation.path || !validRevision(mutation.expectedRevision)) {
				throw new AttachmentPublicationProofError("attachment delete mutation is invalid");
			}
		} else if (safeBlobPath(mutation.fromPath) !== mutation.fromPath
			|| safeBlobPath(mutation.toPath) !== mutation.toPath
			|| mutation.fromPath === mutation.toPath
			|| !validIdentity(mutation.expectedFromRevision)
			|| !validRevision(mutation.expectedToRevision)) {
			throw new AttachmentPublicationProofError("attachment rename mutation is invalid");
		}
	}

	private async retireSupersededAttachmentChain(
		failed: StoredAttachmentPublicationOperation,
		error: AttachmentPublicationError,
	): Promise<void> {
		const mismatch = error.mismatch;
		if (!mismatch || mismatch.vaultGeneration !== this.options.vaultGeneration) {
			throw new AttachmentPublicationProofError(
				"attachment revision mismatch proof is invalid for this vault generation",
			);
		}
		const failedPaths = new Set(this.attachmentMutationPaths(failed.mutation));
		const mismatchPaths = new Set(mismatch.currentHeads.map((entry) => entry.path));
		if (!failedPaths.has(mismatch.path) || mismatchPaths.size !== failedPaths.size
			|| [...failedPaths].some((path) => !mismatchPaths.has(path))) {
			throw new AttachmentPublicationProofError("attachment revision mismatch paths are invalid");
		}
		const currentByPath = new Map(mismatch.currentHeads.map((entry) => [entry.path, entry.head]));
		if (!currentByPath.has(mismatch.path)) currentByPath.set(mismatch.path, mismatch.current);
		const retiredIds = new Set([failed.mutation.operationId]);
		const retired: StoredAttachmentPublicationOperation[] = [];
		for (const operation of this.sortedAttachmentOperations()) {
			if (operation.mutation.operationId === failed.mutation.operationId
				|| this.attachmentMutationDependsOn(operation.mutation, retiredIds)) {
				retiredIds.add(operation.mutation.operationId);
				retired.push(operation);
			}
		}
		for (const operation of retired) {
			await this.options.database.deleteAttachmentOperation(operation.mutation.operationId);
		}
		const affectedPaths = new Set<string>();
		for (const operation of retired) {
			this.attachmentOperations.delete(operation.mutation.operationId);
			this.fatalAttachmentPublicationIds.delete(operation.mutation.operationId);
			const paths = this.attachmentMutationPaths(operation.mutation);
			for (const path of paths) affectedPaths.add(path);
			const primaryPath = operation.mutation.kind === "rename"
				? operation.mutation.toPath
				: operation.mutation.path;
			const current = currentByPath.get(primaryPath)
				?? currentByPath.get(paths[0]!)
				?? this.getObservedAttachmentHead(primaryPath);
			if (this.attachmentOutcomeWaiters.has(operation.mutation.operationId)) {
				this.attachmentTerminalOutcomes.set(operation.mutation.operationId, {
					kind: "superseded",
					current,
				});
			}
			this.emitAttachmentPublicationEvent(
				PRODUCT_EVENT_KIND.attachmentPublicationSupersededRemote,
				operation,
				"warn",
				current,
			);
		}
		const callback = this.options.onAttachmentReconciliationRequired;
		if (callback && affectedPaths.size > 0) {
			void Promise.resolve()
				.then(() => callback([...affectedPaths], "revision-mismatch"))
				.catch((callbackError) => {
					this.log(`attachment reconciliation scheduling failed: ${String(callbackError)}`);
				});
		}
	}

	private attachmentMutationDependsOn(
		mutation: AttachmentPublicationMutation,
		operationIds: ReadonlySet<string>,
	): boolean {
		if (mutation.kind === "rename") {
			return operationIds.has(mutation.expectedFromRevision)
				|| (mutation.expectedToRevision !== null && operationIds.has(mutation.expectedToRevision));
		}
		return mutation.expectedRevision !== null && operationIds.has(mutation.expectedRevision);
	}

	private attachmentMutationPaths(mutation: AttachmentPublicationMutation): string[] {
		return mutation.kind === "rename"
			? [mutation.fromPath, mutation.toPath]
			: [mutation.path];
	}

	private emitAttachmentPublicationEvent(
		kind: typeof PRODUCT_EVENT_KIND.attachmentPublicationDurablePending
			| typeof PRODUCT_EVENT_KIND.attachmentPublicationCommitted
			| typeof PRODUCT_EVENT_KIND.attachmentPublicationSupersededRemote
			| typeof PRODUCT_EVENT_KIND.attachmentPublicationReplayed
			| typeof PRODUCT_EVENT_KIND.attachmentPublicationIdentityMismatch
			| typeof PRODUCT_EVENT_KIND.attachmentPublicationMutationBusy,
		operation: StoredAttachmentPublicationOperation,
		severity: "info" | "warn" | "error",
		current?: AttachmentHead,
	): void {
		const mutation = operation.mutation;
		const path = mutation.kind === "rename" ? mutation.toPath : mutation.path;
		const expected = mutation.kind === "rename"
			? `${mutation.expectedFromRevision}:${mutation.expectedToRevision ?? "missing"}`
			: mutation.expectedRevision ?? "missing";
		this.options.onProductEvent?.({
			kind,
			severity,
			scope: "file",
			source: "vaultSync",
			layer: "server",
			priority: severity === "error" ? "critical" : "important",
			path,
			data: {
				operationPrefix: mutation.operationId.slice(0, 12),
				localSequence: operation.localSequence,
				expectedRevisionPrefix: expected.slice(0, 25),
				currentRevisionPrefix: current?.revision?.slice(0, 12) ?? null,
				queueAgeMs: Math.max(0, this.now() - operation.createdAt),
				attempts: operation.attempts,
			},
		});
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
					&& left.mime === right.mime
					&& left.expectedRevision === right.expectedRevision;
			case "delete":
				return right.kind === "delete" && left.path === right.path
					&& left.expectedRevision === right.expectedRevision;
			case "rename":
				return right.kind === "rename"
					&& left.fromPath === right.fromPath
					&& left.toPath === right.toPath
					&& left.expectedFromRevision === right.expectedFromRevision
					&& left.expectedToRevision === right.expectedToRevision;
		}
	}

	private async applyAttachmentPublication(
		operation: StoredAttachmentPublicationOperation,
		receipt: AttachmentPublicationReceipt,
	): Promise<void> {
		const mutation = operation.mutation;
		const expectedResults = mutation.kind === "rename"
			? new Map([[mutation.fromPath, "deleted"], [mutation.toPath, "active"]] as const)
			: new Map([[mutation.path, mutation.kind === "delete" ? "deleted" : "active"]] as const);
		const resultPaths = new Set(receipt.revisions.map((result) => result.path));
		if (receipt.operationId !== mutation.operationId || receipt.outcome !== "committed"
			|| receipt.revisions.length !== expectedResults.size
			|| resultPaths.size !== receipt.revisions.length
			|| !receipt.revisions.every((result) => result.revision === mutation.operationId
				&& expectedResults.get(result.path) === result.state)
			|| receipt.vaultGeneration !== this.options.vaultGeneration || !receipt.runtimeEpoch
			|| !Number.isSafeInteger(receipt.vaultSequence) || receipt.vaultSequence < 0
			|| !Number.isSafeInteger(receipt.rootGeneration) || receipt.rootGeneration < 0
			|| receipt.rootEpoch !== operation.rootEpoch || receipt.rootEpoch !== this._rootEpoch
			|| !(receipt.rootUpdate instanceof Uint8Array) || receipt.rootUpdate.byteLength === 0) {
			throw new AttachmentPublicationProofError("attachment publication proof mismatch");
		}
		let update: Uint8Array;
		try {
			update = receipt.rootUpdate;
			this.validateAttachmentPublicationUpdate(mutation, update);
		} catch (error) {
			if (error instanceof AttachmentPublicationProofError) throw error;
			throw new AttachmentPublicationProofError(String(error));
		}
		Y.applyUpdate(this.ydoc, update, ORIGIN_DURABLE_ROOT_PUBLICATION);
		this._rootGeneration = Math.max(this._rootGeneration, receipt.rootGeneration);
		await this.persistRoot();
	}

	private validateAttachmentPublicationUpdate(
		mutation: AttachmentPublicationMutation,
		update: Uint8Array,
	): void {
		const beforeSource = mutation.kind === "rename"
			? this.getObservedAttachmentHead(mutation.fromPath)
			: null;
		const beforePath = mutation.kind === "delete"
			? this.getObservedAttachmentHead(mutation.path)
			: null;
		const candidate = new Y.Doc({ guid: "attachment-publication-validation" });
		try {
			Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.ydoc));
			Y.applyUpdate(candidate, update);
			if (!this.hasSafeAttachmentRoot(candidate)) {
				throw new AttachmentPublicationProofError("attachment publication root semantics are invalid");
			}
			const head = (path: string): AttachmentHead => {
				const ref = candidate.getMap<BlobRef>("pathToBlob").get(path);
				if (ref) return { kind: "active", revision: ref.revision, hash: ref.hash, size: ref.size };
				const tombstone = candidate.getMap<BlobTombstone>("blobTombstones").get(path);
				if (tombstone) return {
					kind: "deleted",
					revision: tombstone.revision,
					previousHash: tombstone.previousHash,
				};
				return { kind: "missing", revision: null };
			};
			if (mutation.kind === "upsert") {
				const result = head(mutation.path);
				if (result.revision === mutation.expectedRevision
					|| (result.revision === mutation.operationId
						&& (result.kind !== "active" || result.hash !== mutation.hash || result.size !== mutation.size))) {
					throw new AttachmentPublicationProofError("attachment upsert result does not match its mutation");
				}
			} else if (mutation.kind === "delete") {
				const result = head(mutation.path);
				if (result.revision === mutation.expectedRevision
					|| (result.revision === mutation.operationId && result.kind !== "deleted")
					|| (result.revision === mutation.operationId
						&& result.kind === "deleted"
						&& beforePath?.revision === mutation.expectedRevision
						&& result.previousHash !== (beforePath.kind === "active"
							? beforePath.hash
							: beforePath.kind === "deleted" ? beforePath.previousHash : null))) {
					throw new AttachmentPublicationProofError("attachment delete result does not match its mutation");
				}
			} else {
				const source = head(mutation.fromPath);
				const target = head(mutation.toPath);
				if (source.revision === mutation.expectedFromRevision
					|| target.revision === mutation.expectedToRevision
					|| (source.revision === mutation.operationId && source.kind !== "deleted")
					|| (target.revision === mutation.operationId && target.kind !== "active")) {
					throw new AttachmentPublicationProofError("attachment rename result does not match its mutation");
				}
				if (target.revision === mutation.operationId
					&& beforeSource?.kind === "active"
					&& (target.kind !== "active"
						|| target.hash !== beforeSource.hash
						|| target.size !== beforeSource.size)) {
					throw new AttachmentPublicationProofError("attachment rename changed the source object identity");
				}
				if (source.revision === mutation.operationId
					&& target.revision === mutation.operationId
					&& (source.kind !== "deleted" || target.kind !== "active"
						|| source.previousHash !== target.hash)) {
					throw new AttachmentPublicationProofError("attachment rename result paths disagree");
				}
			}
		} finally {
			candidate.destroy();
		}
	}

	private hasSafeAttachmentRoot(doc: Y.Doc): boolean {
		if (doc.getMap("sys").get("schemaVersion") !== SCHEMA_VERSION
			|| doc.getMap("sys").get("protocolVersion") !== PROTOCOL_VERSION) return false;
		const refs = doc.getMap<BlobRef>("pathToBlob");
		const tombstones = doc.getMap<BlobTombstone>("blobTombstones");
		const metadata = doc.getMap<BlobMeta>("blobMeta");
		for (const [path, ref] of refs) {
			if (!ref || safeBlobPath(path, [], "", ref) !== path
				|| typeof ref.revision !== "string" || !ref.revision || ref.revision.length > 128
				|| tombstones.has(path)) return false;
			const meta = metadata.get(ref.hash);
			if (!meta || meta.size !== ref.size) return false;
		}
		for (const [path, tombstone] of tombstones) {
			if (safeBlobPath(path) !== path || !tombstone
				|| !Number.isSafeInteger(tombstone.deletedAt) || tombstone.deletedAt < 0
				|| typeof tombstone.revision !== "string" || !tombstone.revision || tombstone.revision.length > 128
				|| (tombstone.previousHash !== null && !/^[a-f0-9]{64}$/.test(tombstone.previousHash))
				|| refs.has(path)) return false;
		}
		for (const [hash, meta] of metadata) {
			if (!/^[a-f0-9]{64}$/.test(hash) || !meta
				|| !Number.isSafeInteger(meta.size) || meta.size < 0
				|| typeof meta.mime !== "string" || !meta.mime || meta.mime.length > 256
				|| !Number.isSafeInteger(meta.createdAt) || meta.createdAt < 0) return false;
		}
		return true;
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
	 * Creates a fresh identity through the one create path (D2): the create is
	 * collected for {@link CREATE_COLLECTOR_DELAY_MS} and sent in one
	 * `POST /lifecycle/create-bulk` batch with every other pending create.
	 *
	 * D5: a newer revision of a create that is still in the collector replaces
	 * it (fold; the older caller is cancelled). A revision of a create that is
	 * already in flight waits for that create's receipt and is then committed
	 * as an ordinary body candidate (hold), so edits never reach the server
	 * before their file.
	 */
	async commitFreshBody(
		input: FreshBodyCommitInput,
	): Promise<FreshBodyCommitResult> {
		input = { ...input, content: canonicalizeMarkdown(input.content) };
		if (this.destroyed) throw new Error("runtime is destroyed");
		if (input.admissionStillCurrent?.() === false) {
			throw new FreshAdmissionCancelledError(input.path);
		}
		const inFlight = this.createsInFlight.get(input.path);
		if (inFlight) return this.commitAfterInFlightCreate(input, inFlight);
		if (this.getFileId(input.path)) throw new Error(`path ${input.path} is already active`);
		const result = await this.enqueueCollectedCreate(input);
		return this.freshResultOrThrow(input, result);
	}

	private freshResultOrThrow(input: FreshBodyCommitInput, result: BulkCreateItemResult): FreshBodyCommitResult {
		switch (result.outcome) {
			case "created":
				this.log(`fresh body committed for ${input.path} (${input.reason})`);
				return result.result;
			case "pending":
				throw new FreshAdmissionDurablyPendingError(input.path, result.operationId, result.error);
			case "rejected":
				throw new Error(`bulk create rejected ${input.path}: ${result.reason}`);
			default:
				throw new FreshAdmissionCancelledError(input.path);
		}
	}

	/** D5 hold: the file's create is in flight; commit this revision only after its receipt. */
	private async commitAfterInFlightCreate(
		input: FreshBodyCommitInput,
		inFlight: Promise<BulkCreateItemResult>,
	): Promise<FreshBodyCommitResult> {
		const prior = await inFlight;
		if (prior.outcome === "pending") {
			// The file itself is not confirmed. Keep the edit on the device: the
			// disk file still holds it and is re-planned after the create replays.
			throw new FreshAdmissionDurablyPendingError(input.path, prior.operationId, new Error("create_unconfirmed"));
		}
		if (prior.outcome !== "created") throw new FreshAdmissionCancelledError(input.path);
		if (this.destroyed || input.admissionStillCurrent?.() === false) {
			throw new FreshAdmissionCancelledError(input.path);
		}
		const bodyId = prior.result.bodyId;
		const body = await this.loadCurrentBody(bodyId);
		if (body.doc.getText(BODY_TEXT_NAME).toJSON() === input.content) return prior.result;
		const receipt = await this.commitBodyCandidate({
			bodyId,
			content: input.content,
			candidateId: crypto.randomUUID(),
			reason: input.reason,
		});
		return { ...prior.result, receipt };
	}

	private enqueueCollectedCreate(input: FreshBodyCommitInput): Promise<BulkCreateItemResult> {
		return new Promise<BulkCreateItemResult>((resolve) => {
			const previous = this.createCollector.get(input.path);
			if (previous) {
				// D5 fold: the create is unsent, so its snapshot becomes the newer text.
				this.createCollectorBytes -= previous.bytes;
				this.createCollector.delete(input.path);
				previous.resolve({ outcome: "cancelled" });
			}
			const bytes = utf8ByteLength(input.content) + BULK_CREATE_ITEM_OVERHEAD_BYTES;
			this.createCollector.set(input.path, { input, bytes, resolve, observers: [] });
			for (const wake of previous?.observers ?? []) wake();
			this.createCollectorBytes += bytes;
			const caps = this.bulkCreateCaps();
			if (this.createCollector.size >= caps.maxItems
				|| this.createCollectorBytes >= caps.byteBudget) {
				this.flushCreateCollector();
			} else if (this.createCollectorTimer === null) {
				this.createCollectorTimer = globalThis.setTimeout(() => {
					this.createCollectorTimer = null;
					this.flushCreateCollector();
				}, this.options.createCollectorDelayMs ?? CREATE_COLLECTOR_DELAY_MS);
			}
		});
	}

	/** Sends every collected create now (split by the server caps). */
	flushPendingCreates(): void {
		this.flushCreateCollector();
	}

	private flushCreateCollector(): void {
		if (this.createCollectorTimer !== null) {
			globalThis.clearTimeout(this.createCollectorTimer);
			this.createCollectorTimer = null;
		}
		const entries = [...this.createCollector.values()];
		this.createCollector.clear();
		this.createCollectorBytes = 0;
		const live: CreateCollectorEntry[] = [];
		for (const entry of entries) {
			if (this.destroyed || entry.input.admissionStillCurrent?.() === false) {
				entry.resolve({ outcome: "cancelled" });
			} else {
				live.push(entry);
			}
		}
		for (const chunk of splitByBulkCreateCaps(live, (entry) => entry.bytes, this.bulkCreateCaps())) {
			const items = this.scheduleCreateBatch(chunk.map((entry) => entry.input), "foreground");
			chunk.forEach((entry, index) => {
				void items[index]!.then((result) => entry.resolve(result));
			});
		}
		// Waiters re-check: a sent entry is now in createsInFlight, a cancelled one is gone.
		for (const entry of entries) for (const wake of entry.observers) wake();
	}

	/**
	 * b3-int D5: the editor of a brand-new note cannot bind before the note's
	 * create receipt (the root catalog has no active body for it yet), but the
	 * user keeps typing into the unbound editor: those keystrokes stay in the
	 * editor/disk and reach the server only through the D5 fold/hold, so typing
	 * never blocks and only sending waits. This lets the editor binding retry
	 * the bind as soon as the create lands instead of waiting for the next
	 * layout event. Resolves true when the path has an active body after a
	 * pending create (folded or in flight) settled as created, or already has
	 * one; false when nothing is pending or the create did not commit.
	 */
	async whenCreateSettled(path: string): Promise<boolean> {
		for (let round = 0; round < 64; round++) {
			if (this.destroyed) return false;
			if (this.getFileId(path)) return true;
			const inFlight = this.createsInFlight.get(path);
			if (inFlight) {
				const result = await inFlight;
				if (result.outcome === "created") return !this.destroyed && Boolean(this.getFileId(path));
				if (result.outcome !== "cancelled") return false;
				continue;
			}
			const collected = this.createCollector.get(path);
			if (!collected) return false;
			await new Promise<void>((resolve) => { collected.observers.push(resolve); });
		}
		return false;
	}

	/**
	 * Queues one bulk-create batch behind earlier batches and registers each
	 * path as in flight until the batch has settled locally (root applied,
	 * candidates settled), which is what the D5 hold waits for.
	 */
	private scheduleCreateBatch(
		inputs: readonly FreshBodyCommitInput[],
		priority: "foreground" | "background",
	): Promise<BulkCreateItemResult>[] {
		const run = this.createBatchChain.then(() => this.runCreateBatch(inputs, priority));
		this.createBatchChain = run.then(() => undefined, () => undefined);
		return inputs.map((input, index) => {
			const item = run.then(
				(results) => results[index]!,
				(error): BulkCreateItemResult => ({ outcome: "rejected", reason: String(error), operationId: "" }),
			);
			this.createsInFlight.set(input.path, item);
			void item.then(() => {
				if (this.createsInFlight.get(input.path) === item) this.createsInFlight.delete(input.path);
			});
			return item;
		});
	}

	/**
	 * Initial import / folder drop: the same bulk path without the collector
	 * delay, split by the server caps. `exists-*` items report the server's
	 * existing body and are routed to reconcile through `onCreatePathOwned`.
	 */
	async commitFreshBodies(
		inputs: readonly FreshBodyCommitInput[],
	): Promise<FreshBodyBatchCommitResult> {
		inputs = inputs.map((input) => ({
			...input,
			content: canonicalizeMarkdown(input.content),
		}));
		if (this.destroyed) throw new Error("runtime is destroyed");
		if (inputs.length === 0) return { results: [] };
		if (!this.options.database.putLifecycleOperation) throw new Error("lifecycle persistence is unavailable");
		const paths = new Set<string>();
		const bodyIds = new Set<string>();
		const candidateIds = new Set<string>();
		for (const input of inputs) {
			if (
				this.getFileId(input.path)
				|| this.createsInFlight.has(input.path)
				|| paths.has(input.path)
				|| bodyIds.has(input.bodyId)
				|| candidateIds.has(input.candidateId)
			) {
				throw new Error(`duplicate or active fresh body batch item: ${input.path}`);
			}
			paths.add(input.path);
			bodyIds.add(input.bodyId);
			candidateIds.add(input.candidateId);
		}
		const results: FreshBodyBatchItemResult[] = [];
		for (const chunk of splitByBulkCreateCaps(
			inputs,
			(input) => utf8ByteLength(input.content) + BULK_CREATE_ITEM_OVERHEAD_BYTES,
			this.bulkCreateCaps(),
		)) {
			const items = await Promise.all(this.scheduleCreateBatch(chunk, "background"));
			for (let index = 0; index < chunk.length; index++) {
				const input = chunk[index]!;
				const item = items[index]!;
				switch (item.outcome) {
					case "created":
						results.push({ ...item.result, outcome: "created" });
						break;
					case "exists-identical":
					case "exists-different": {
						const bodyId = item.existingBodyId ?? input.bodyId;
						results.push({ fileId: bodyId, bodyId, lifecycleOperationId: item.operationId,
							outcome: item.outcome, receipt: null });
						break;
					}
					case "rejected":
						results.push({ fileId: input.bodyId, bodyId: input.bodyId, lifecycleOperationId: item.operationId,
							outcome: "rejected", receipt: null, reason: item.reason });
						break;
					case "pending":
						throw new FreshAdmissionDurablyPendingError(input.path, item.operationId, item.error);
					default:
						throw new FreshAdmissionCancelledError(input.path);
				}
			}
		}
		return { results };
	}

	/**
	 * Persists every create (operation + exact candidate) before one bulk
	 * request. Never throws: each item resolves to its outcome; a failure after
	 * local persistence leaves the batch durably pending for lifecycle replay.
	 */
	private async runCreateBatch(
		inputs: readonly FreshBodyCommitInput[],
		priority: "foreground" | "background",
	): Promise<BulkCreateItemResult[]> {
		const results: Array<BulkCreateItemResult | null> = inputs.map(() => null);
		const save = this.options.database.putLifecycleOperation;
		if (!save) {
			return inputs.map(() => ({ outcome: "rejected", reason: "lifecycle persistence is unavailable", operationId: "" }));
		}
		const batchId = crypto.randomUUID();
		const prepared: Array<{ index: number; item: PreparedCreate }> = [];
		const saved = new Map<number, StoredLifecycleOperation>();
		try {
			for (let index = 0; index < inputs.length; index++) {
				const input = inputs[index]!;
				if (this.destroyed || input.admissionStillCurrent?.() === false || this.getFileId(input.path)) {
					results[index] = { outcome: "cancelled" };
					continue;
				}
				const operationId = crypto.randomUUID();
				const request: LifecycleRequest = {
					operationId,
					kind: "create",
					fileId: input.bodyId,
					bodyId: input.bodyId,
					bodyEpoch: INITIAL_SEMANTIC_EPOCH,
					path: input.path,
				};
				let operation: StoredLifecycleOperation = {
					...this.toStoredLifecycleOperation(request),
					content: input.content,
					batchId,
					batchIndex: index,
				};
				await save.call(this.options.database, operation);
				saved.set(index, operation);
				// Guard before the candidate exists: nothing for this body may be
				// submitted until the create receipt (D5).
				this.unconfirmedCreates.set(input.bodyId, input.path);
				let pending = this.pendingCandidates.get(input.candidateId);
				if (pending && pending.record.bodyId !== input.bodyId) {
					throw new Error("candidate ID belongs to a different body");
				}
				if (!pending) {
					const body = await this.loadBodyWithPriority(input.bodyId, priority);
					if (input.admissionStillCurrent?.() === false) {
						await this.options.database.deleteLifecycleOperation?.(operationId);
						saved.delete(index);
						this.unconfirmedCreates.delete(input.bodyId);
						this.bodies.discardTransient(input.bodyId);
						await this.options.database.deleteDocument?.(input.bodyId);
						results[index] = { outcome: "cancelled" };
						continue;
					}
					const materialized = materializeFreshMarkdownUpdates(
						body.doc,
						input.content,
						() => this.ensureSemanticMirror(body).seedCurrent(),
					);
					pending = await this.captureCandidate(
						input.bodyId,
						materialized.encodedUpdate,
						input.candidateId,
						0,
						input.path,
						materialized.encodedUpdates,
					);
				}
				operation = {
					...operation,
					candidateId: pending.record.candidateId,
					candidateDigest: pending.record.candidateDigest,
				};
				await save.call(this.options.database, operation);
				saved.set(index, operation);
				prepared.push({ index, item: { operation, pending } });
			}
			if (prepared.length > 0) {
				const settled = await this.sendAndSettleCreateBatch(batchId, prepared.map((entry) => entry.item));
				prepared.forEach((entry, position) => { results[entry.index] = settled[position]!; });
			}
		} catch (error) {
			this.log(`create batch ${batchId} remains durably pending: ${String(error)}`);
			if (saved.size > 0) await this.queueStoredLifecycleOperationsSafely();
			for (let index = 0; index < inputs.length; index++) {
				if (results[index]) continue;
				const operation = saved.get(index);
				results[index] = operation
					? { outcome: "pending", operationId: operation.operationId, error }
					: { outcome: "rejected", reason: String(error), operationId: "" };
			}
		}
		return results.map((result) => result ?? { outcome: "cancelled" });
	}

	private async queueStoredLifecycleOperationsSafely(): Promise<void> {
		try {
			await this.queueStoredLifecycleOperations();
		} catch (error) {
			this.log(`lifecycle replay remains reconstructible after scheduler handoff failed: ${String(error)}`);
		}
	}

	private bulkCreateFileRequest(item: PreparedCreate): BulkCreateFileRequest {
		const record = item.pending.record;
		const frames = record.encodedUpdates && record.encodedUpdates.length > 0
			? record.encodedUpdates.map((frame) => new Uint8Array(frame))
			: [new Uint8Array(record.encodedUpdate)];
		return {
			operationId: item.operation.operationId,
			bodyId: item.operation.bodyId,
			path: item.operation.path,
			updates: frames,
		};
	}

	/** Re-files persisted creates under a new batch identity (split / overlap / lost frames). */
	private async rebatchCreates(items: readonly PreparedCreate[], batchId: string): Promise<PreparedCreate[]> {
		const save = this.options.database.putLifecycleOperation;
		if (!save) throw new Error("lifecycle persistence is unavailable");
		const out: PreparedCreate[] = [];
		for (let index = 0; index < items.length; index++) {
			const operation = { ...items[index]!.operation, batchId, batchIndex: index };
			await save.call(this.options.database, operation);
			out.push({ operation, pending: items[index]!.pending });
		}
		return out;
	}

	private async sendAndSettleCreateBatch(
		batchId: string,
		items: readonly PreparedCreate[],
	): Promise<BulkCreateItemResult[]> {
		this.activeCreateBatches.add(batchId);
		let response: BulkCreateResponse;
		try {
			try {
				response = await this.sendCreateBatch(batchId, items.map((item) => this.bulkCreateFileRequest(item)), []);
			} catch (error) {
				if (error instanceof VaultMutationRequestError && isBulkCreateTooBig(error) && items.length > 1) {
					// Nothing was written: split (by the server's caps, else in halves)
					// and send each part under its own batch.
					const out: BulkCreateItemResult[] = [];
					for (const half of this.splitAfterBulkCreate413(items, error)) {
						const halfId = crypto.randomUUID();
						out.push(...await this.sendAndSettleCreateBatch(halfId, await this.rebatchCreates(half, halfId)));
					}
					return out;
				}
				throw error;
			}
			return await this.settleCreateBatch(items, response);
		} finally {
			this.activeCreateBatches.delete(batchId);
		}
	}

	/**
	 * One bulk request; recovers a stale root epoch once. Applies the server's
	 * root delta (files and attachments created by this batch, plus anything
	 * this client had not seen) before returning.
	 */
	private async sendCreateBatch(
		batchId: string,
		files: BulkCreateFileRequest[],
		attachments: BulkCreateAttachmentRequest[],
	): Promise<BulkCreateResponse> {
		await this.waitForSubmissionWindow();
		const build = (): BulkCreateRequest => ({
			batchId,
			rootEpoch: this._rootEpoch,
			rootStateVector: Y.encodeStateVector(this.ydoc),
			files,
			attachments,
		});
		let response: BulkCreateResponse;
		try {
			response = await this.server.commitCreateBulk(build());
		} catch (error) {
			if (!(error instanceof VaultMutationRequestError)
				|| error.semanticMismatch?.purpose !== "root"
				|| error.semanticMismatch.documentId !== ROOT_DOCUMENT_ID
				|| error.semanticMismatch.receivedEpoch !== this._rootEpoch) throw error;
			await this.recoverRootSemanticEpoch(error.semanticMismatch.expectedEpoch);
			response = await this.server.commitCreateBulk(build());
		}
		this.noteDailyLimitWriteSucceeded();
		const expected = [...files.map((file) => file.operationId), ...attachments.map((item) => item.operationId)];
		if (
			response.batchId !== batchId
			|| !Array.isArray(response.outcomes)
			|| response.outcomes.length !== expected.length
			|| response.outcomes.some((outcome, index) => outcome.operationId !== expected[index])
			|| response.vaultGeneration !== this.options.vaultGeneration
			|| typeof response.runtimeEpoch !== "string" || !response.runtimeEpoch
			|| !Number.isSafeInteger(response.vaultSequence) || response.vaultSequence < 0
			|| !Number.isSafeInteger(response.rootGeneration) || response.rootGeneration < 0
			|| response.rootEpoch !== this._rootEpoch
		) {
			throw new Error("bulk create receipt mismatch");
		}
		if (response.rootUpdate instanceof Uint8Array && response.rootUpdate.byteLength > 0) {
			// P5: validate on a clone; the live root (and so disk) never sees a bad delta.
			const verdict = validateBulkCreateRootUpdate(this.ydoc, response.rootUpdate, {
				files: files.map((file, index) => ({ path: file.path, bodyId: file.bodyId,
					outcome: response.outcomes[index]!.outcome })),
				attachments: attachments.map((item, index) => ({ path: item.path, operationId: item.operationId,
					hash: item.hash, outcome: response.outcomes[files.length + index]!.outcome })),
			});
			if (!verdict.ok) {
				await this.recoverRootAfterRejectedBulkUpdate(batchId, verdict.reason);
				return response;
			}
			Y.applyUpdate(this.ydoc, response.rootUpdate, ORIGIN_DURABLE_ROOT_PUBLICATION);
		}
		this._rootGeneration = Math.max(this._rootGeneration, response.rootGeneration);
		await this.persistRoot();
		return response;
	}

	/** Diagnostics for bulk-create root deltas rejected by pre-validation (P5). */
	bulkCreateRootRejections(): { count: number; last: { batchId: string; reason: string; at: number } | null } {
		return { count: this.bulkRootRejectionCount, last: this.lastBulkRootRejection };
	}

	/**
	 * A bulk receipt's root delta failed validation: it is dropped and the root
	 * is re-read from the server and applied through the ordinary remote-root
	 * path (provider origin: invalid-path guard, persistence, catch-up). The
	 * batch itself is durable, so failure here only logs; the root socket
	 * delivers the same state on its next sync.
	 */
	private async recoverRootAfterRejectedBulkUpdate(batchId: string, reason: string): Promise<void> {
		this.bulkRootRejectionCount++;
		this.lastBulkRootRejection = { batchId, reason, at: this.now() };
		this.log(`bulk create root update rejected batch=${batchId}: ${reason}; resyncing root from the server`);
		try {
			if (!this.server.currentRoot) throw new Error("root state fetch is unavailable");
			const state = await this.server.currentRoot();
			if (state.rootEpoch > this._rootEpoch) {
				await this.recoverRootSemanticEpoch(state.rootEpoch);
				return;
			}
			if (state.rootEpoch !== this._rootEpoch) throw new Error("root state fetch returned an older epoch");
			Y.applyUpdate(this.ydoc, state.encodedState, this.provider.documentOrigin);
			this._rootGeneration = Math.max(this._rootGeneration, state.generation);
		} catch (error) {
			this.log(`root resync after rejected bulk update failed (socket sync will retry): ${String(error)}`);
		}
	}

	/**
	 * Local settlement after a bulk receipt: lifecycle records first (a crash
	 * after this point falls back to an idempotent candidate replay), then the
	 * create candidates are settled from the batch receipt, then the D5 guard
	 * is lifted. Non-created items discard their local fresh identity.
	 */
	private async settleCreateBatch(
		items: readonly PreparedCreate[],
		response: BulkCreateResponse,
	): Promise<BulkCreateItemResult[]> {
		const ids = items.map((item) => item.operation.operationId);
		if (ids.length > 1 && this.options.database.deleteLifecycleOperations) {
			await this.options.database.deleteLifecycleOperations(ids);
		} else {
			for (const id of ids) await this.options.database.deleteLifecycleOperation?.(id);
		}
		const results: BulkCreateItemResult[] = [];
		for (let index = 0; index < items.length; index++) {
			const { operation, pending } = items[index]!;
			const outcome = response.outcomes[index]!;
			const bodyId = operation.bodyId;
			if (outcome.outcome === "created") {
				if (this.getFileId(operation.path) !== bodyId) {
					this.log(`bulk create receipt for ${operation.path} did not map it to ${bodyId} in the local root`);
				}
				const receipt: BodyReceipt = {
					vaultId: pending.record.vaultId,
					vaultGeneration: response.vaultGeneration,
					bodyId,
					bodyEpoch: pending.record.bodyEpoch,
					clientId: this.options.deviceId,
					candidateId: pending.record.candidateId,
					candidateDigest: pending.record.candidateDigest,
					durableGeneration: 1,
					runtimeEpoch: response.runtimeEpoch,
				};
				this.unconfirmedCreates.delete(bodyId);
				try {
					await this.completeCandidateSubmission(pending, receipt);
				} catch (error) {
					this.log(`create candidate for ${operation.path} settles through candidate replay: ${String(error)}`);
				}
				this.emitCreatedProductEvent(operation.path, bodyId, operation.operationId);
				if (Array.from(this.pendingCandidates.values()).some((candidate) => candidate.record.bodyId === bodyId)) {
					void this.submitPendingForBody(bodyId);
				}
				results.push({
					outcome: "created",
					result: { fileId: bodyId, bodyId, lifecycleOperationId: operation.operationId, receipt },
				});
				continue;
			}
			await this.cancelFreshAdmission(pending, operation.operationId);
			this.unconfirmedCreates.delete(bodyId);
			if (outcome.outcome === "exists-identical" || outcome.outcome === "exists-different") {
				const existingBodyId = outcome.existingBodyId ?? outcome.bodyId ?? null;
				results.push({ outcome: outcome.outcome, existingBodyId, operationId: operation.operationId });
				this.notifyCreatePathOwned(operation.path, existingBodyId, outcome.outcome === "exists-identical");
			} else {
				this.log(`bulk create rejected ${operation.path}: ${outcome.reason ?? "rejected"}`);
				results.push({ outcome: "rejected", reason: outcome.reason ?? "rejected", operationId: operation.operationId });
			}
		}
		return results;
	}

	private notifyCreatePathOwned(path: string, existingBodyId: string | null, identical: boolean): void {
		const callback = this.options.onCreatePathOwned;
		if (!callback) return;
		void Promise.resolve()
			.then(() => callback({ path, existingBodyId, identical }))
			.catch((error) => this.log(`create path reconcile handoff failed for ${path}: ${String(error)}`));
	}

	private emitCreatedProductEvent(path: string, bodyId: string, operationId: string): void {
		this.options.onProductEvent?.({
			kind: PRODUCT_EVENT_KIND.crdtFileCreated,
			severity: "info",
			scope: "file",
			source: "vaultSync",
			layer: "crdt",
			priority: "important",
			path,
			opId: operationId,
			data: { bodyId, fromPath: null, toPath: null },
		});
	}

	/**
	 * Lifecycle replay for persisted creates: resend the same batch identity
	 * with the same frames (exact retry → stored receipt). Items already
	 * committed under another batch are settled by an idempotent candidate
	 * replay; the rest are re-filed under a new batch.
	 */
	private async retryCreateGroup(operations: readonly StoredLifecycleOperation[]): Promise<void> {
		const save = this.options.database.putLifecycleOperation;
		if (!save || operations.length === 0) return;
		const batchId = operations[0]!.batchId ?? operations[0]!.operationId;
		if (this.activeCreateBatches.has(batchId)) return;
		this.activeCreateBatches.add(batchId);
		try {
			const items: PreparedCreate[] = [];
			let rebatch = false;
			for (const stored of operations) {
				const operation = { ...stored };
				this.unconfirmedCreates.set(operation.bodyId, operation.path);
				let pending = Array.from(this.pendingCandidates.values()).find(
					(candidate) => candidate.record.bodyId === operation.bodyId
						&& (!operation.candidateId || candidate.record.candidateId === operation.candidateId),
				);
				if (!pending) {
					if (operation.content === null) {
						await this.options.database.deleteLifecycleOperation?.(operation.operationId);
						this.unconfirmedCreates.delete(operation.bodyId);
						continue;
					}
					// The exact frames may already have been sent under this batch;
					// new frames must travel under a new batch identity.
					if (operation.candidateId) rebatch = true;
					const body = await this.loadBodyWithPriority(operation.bodyId, "background", true);
					const text = body.doc.getText(BODY_TEXT_NAME);
					if (text.toJSON() !== operation.content) {
						applyDiffToYText(text, text.toJSON(), operation.content, ORIGIN_DISK_COMMIT);
						await this.bodies.markDirty(operation.bodyId);
					}
					pending = await this.captureCandidate(
						operation.bodyId,
						Y.encodeStateAsUpdate(body.doc),
						crypto.randomUUID(),
						0,
						operation.path,
					);
					operation.candidateId = pending.record.candidateId;
					operation.candidateDigest = pending.record.candidateDigest;
					await save.call(this.options.database, operation);
				}
				items.push({ operation, pending });
			}
			if (items.length === 0 || this.destroyed) return;
			if (rebatch) {
				await this.requeueCreates(items);
				return;
			}
			try {
				const response = await this.sendCreateBatch(batchId, items.map((item) => this.bulkCreateFileRequest(item)), []);
				await this.settleCreateBatch(items, response);
				this.log(`create batch ${batchId} settled by replay${response.replayed ? " (stored receipt)" : ""}`);
			} catch (error) {
				if (!(error instanceof VaultMutationRequestError)) throw error;
				if (error.status === 409 && error.code === "bulk_create_partial_overlap") {
					const committed = new Set(error.operationIds);
					for (const item of items) {
						if (!committed.has(item.operation.operationId)) continue;
						await this.options.database.deleteLifecycleOperation?.(item.operation.operationId);
						this.unconfirmedCreates.delete(item.operation.bodyId);
						void this.submitPendingForBody(item.operation.bodyId);
					}
					const rest = items.filter((item) => !committed.has(item.operation.operationId));
					if (rest.length > 0) await this.requeueCreates(rest);
					this.log(`create batch ${batchId} overlapped ${committed.size} committed item(s); rest re-filed`);
					return;
				}
				if (error.status === 409 && error.code === "bulk_create_batch_identity_mismatch") {
					await this.requeueCreates(items);
					return;
				}
				if (isBulkCreateTooBig(error) && items.length > 1) {
					for (const part of this.splitAfterBulkCreate413(items, error)) await this.requeueCreates(part);
					return;
				}
				throw error;
			}
		} catch (error) {
			this.log(`create batch ${batchId} remains pending: ${String(error)}`);
		} finally {
			this.activeCreateBatches.delete(batchId);
		}
	}

	/** Effective create-bulk caps: the defaults, the advertised server caps and any 413-learned caps. */
	private bulkCreateCaps(): BulkCreateClientCaps {
		return bulkCreateClientCaps(parseBulkCreateServerCaps(this.options.bulkCreateCaps?.()), this.learnedBulkCreateCaps);
	}

	private learnBulkCreateCaps(error: VaultMutationRequestError): void {
		if (error.bulkCreateCaps) this.learnedBulkCreateCaps = error.bulkCreateCaps;
	}

	/** A create-bulk 413 wrote nothing: split by the (learned) item cap, else halve (bytes are estimated). */
	private splitAfterBulkCreate413<T>(items: readonly T[], error: VaultMutationRequestError): T[][] {
		this.learnBulkCreateCaps(error);
		const byCount = splitByBulkCreateCaps(items, () => 0, this.bulkCreateCaps());
		if (byCount.length > 1) return byCount;
		const middle = Math.ceil(items.length / 2);
		return [items.slice(0, middle), items.slice(middle)];
	}

	private async requeueCreates(items: readonly PreparedCreate[]): Promise<void> {
		const batchId = crypto.randomUUID();
		await this.rebatchCreates(items, batchId);
		await this.queueLifecycleReplaySafely(`batch:${batchId}`);
	}

	/** Durable exact-candidate write for an already admitted body. */
	async commitBodyCandidate(
		input: BodyCandidateCommitInput,
	): Promise<BodyReceipt> {
		input = { ...input, content: canonicalizeMarkdown(input.content) };
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
	 * Loads the current body of `bodyId` so a disk import can be planned
	 * against it: residency-admitted and caught up with the server head
	 * (offline, a body with local state is used as is). Never changes the
	 * body and never captures a candidate. The body may be evicted again
	 * later; callers re-read it and re-plan through the conditional commit
	 * ({@link commitBodyCandidateIfCurrent}), which is what makes the import
	 * safe, not this load.
	 */
	async loadBodyForPlanning(bodyId: string): Promise<void> {
		if (this.destroyed) throw new Error("runtime closed before body planning load");
		await this.loadCurrentBody(bodyId);
	}

	async commitBodyCandidateIfCurrent(
		input: BodyCandidateCommitInput & { expectedContent: string; path?: string },
	): Promise<CurrentBodyCandidateOutcome> {
		input = {
			...input,
			content: canonicalizeMarkdown(input.content),
			expectedContent: canonicalizeMarkdown(input.expectedContent),
		};
		if (this.destroyed) return { kind: "superseded" };
		const body = await this.loadCurrentBody(input.bodyId);
		const lease = this.bodies.acquireLease(input.bodyId);
		try {
			const proof = this.bodies.captureRevision(input.bodyId);
			if (input.path && !this.bodies.coordinator.isPathCurrent(input.path, input.bodyId)) {
				return { kind: "superseded" };
			}
			const text = body.doc.getText(BODY_TEXT_NAME);
			const before = Y.encodeStateVector(body.doc);
			const applyOutcome = tryApplyDiffToYText(
				text,
				input.expectedContent,
				input.content,
				ORIGIN_DISK_COMMIT,
			);
			if (applyOutcome === "unchanged") return { kind: "completed", receipt: null, unchanged: true };
			if (applyOutcome !== "applied") return { kind: "superseded" };
			if (!proof.localRuntimeEpoch.isCurrent()
				|| (input.path && !this.bodies.coordinator.isPathCurrent(input.path, input.bodyId))) {
				return { kind: "superseded" };
			}
			await this.bodies.markDirty(input.bodyId);
			const pending = await this.captureCandidate(
				input.bodyId,
				Y.encodeStateAsUpdate(body.doc, before),
				input.candidateId,
				0,
				input.path,
			);
			const receipt = await this.submitCandidate(pending);
			this.log(`current body candidate committed for ${input.bodyId} (${input.reason})`);
			return { kind: "completed", receipt };
		} finally {
			lease.release();
		}
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
		if (lifecycle === "revive") await this.reviveOnce(input.bodyId, input.path);
		const revived = lifecycle === "revive";
		const body = await this.loadCurrentBody(input.bodyId);
		if (body.doc.getText(BODY_TEXT_NAME).toJSON() === input.content) {
			await this.runResidencyMaintenance();
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


	/**
	 * Revives a body at most once at a time. Two delete-revive paths (restart
	 * reconcile and the remote-delete observer) used to each store and send a
	 * revive; the loser got 409 body_not_tombstoned. A caller that finds a
	 * revive in flight for the same body and path shares its outcome; for a
	 * different path it waits and re-checks. isRedundantRevive stays as the
	 * defence for revives that still race (another device, a stored replay).
	 */
	private async reviveOnce(bodyId: string, path: string): Promise<void> {
		for (;;) {
			if (this.getFileId(path) === bodyId) return;
			const inFlight = this.revivesInFlight.get(bodyId);
			if (!inFlight) break;
			if (inFlight.path === path) {
				await inFlight.settled;
				return;
			}
			await inFlight.settled.catch(() => undefined);
		}
		const settled = (async () => {
			await this.commitLifecycle({
				operationId: crypto.randomUUID(),
				kind: "revive",
				fileId: bodyId,
				bodyId,
				bodyEpoch: await this.currentBodyEpoch(bodyId),
				path,
			});
		})();
		const entry = { path, settled };
		this.revivesInFlight.set(bodyId, entry);
		try {
			await settled;
		} finally {
			if (this.revivesInFlight.get(bodyId) === entry) this.revivesInFlight.delete(bodyId);
		}
	}

	isBodyLoaded(bodyId: string): boolean {
		return this.bodies.get(bodyId) !== null;
	}

	async currentBodyEpoch(bodyId: string): Promise<SemanticEpoch> {
		const resident = this.bodies.get(bodyId);
		if (resident) return resident.bodyEpoch;
		const head = await this.server.currentHead(bodyId);
		return head?.bodyEpoch ?? INITIAL_SEMANTIC_EPOCH;
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
		await this.flushBodyCandidate(bodyId, "await-relay");
		const hasPendingCandidate = Array.from(this.pendingCandidates.values()).some(
			(candidate) => candidate.record.bodyId === bodyId,
		);
		if (hasPendingCandidate || (this.pendingUpdates.get(bodyId)?.length ?? 0) > 0) {
			throw new Error(`body ${bodyId} still has pending local work`);
		}
		await this.loadCurrentBody(bodyId);
		await this.runResidencyMaintenance();
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
		void this.commitDelete(path, _device, opId)
			.catch((error) => this.log(`delete lifecycle remains pending for ${path}: ${String(error)}`));
	}

	/** Awaitable delete boundary for shutdown/final-drain callers. */
	async commitDelete(path: string, _device?: string, opId: string = crypto.randomUUID()): Promise<void> {
		const bodyId = this.getFileId(path);
		if (!bodyId) {
			if (this.getAttachmentRef(path)) {
				await this.deleteAttachmentRef(path, _device);
			}
			return;
		}
		const bodyEpoch = await this.currentBodyEpoch(bodyId);
		await this.commitStructuralBatch([{
			operationId: opId,
			kind: "delete",
			fileId: bodyId,
			bodyId,
			bodyEpoch,
			path,
		}]);
	}

	private async flushRenameBatch(): Promise<void> {
		if (this.renameBatch.size === 0) return;
		const batch = new Map(this.renameBatch);
		this.renameBatch.clear();
		const requests = (await Promise.all([...batch].map(async ([fromPath, toPath]): Promise<LifecycleRequest | null> => {
			const bodyId = this.getFileId(fromPath);
			return bodyId ? {
				operationId: crypto.randomUUID(),
				kind: "rename" as const,
				fileId: bodyId,
				bodyId,
				bodyEpoch: await this.currentBodyEpoch(bodyId),
				fromPath,
				toPath,
			} : null;
		}))).filter((request): request is LifecycleRequest => request !== null);
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
		const startedAt = this.monotonicNow();
		const bodyId = this.getFileId(path);
		const session = bodyId ? this.sessions.get(bodyId) : undefined;
		const tier: EditorAdmissionTier = session?.consumers.has(consumerId)
			? "same-consumer"
			: (session?.consumers.size ?? 0) > 0
				? "shared-active"
				: session
					? "warm-live"
					: bodyId && this.bodies.get(bodyId)
					? "warm-loaded"
						: "cold";
		const trace: EditorAdmissionTrace = {
			queueDelayMs: 0,
			localLoadMs: 0,
			currentnessProofMs: 0,
			stateFetchMs: 0,
			providerAdmissionMs: 0,
			providerSyncMs: 0,
			projectionMs: 0,
			currentnessSource: "none",
			httpFallback: false,
		};
		try {
			await this.acquireEditorBodyInternal(path, consumerId, trace);
			const sample: EditorAdmissionSample = {
				tier,
				outcome: "acquired",
				acquisitionMs: Math.max(0, this.monotonicNow() - startedAt),
				visibleToBoundMs: null,
				cmBindMs: null,
				...trace,
				socketCount: this.sessions.size + 1,
				bodySizeBucket: this.editorAdmissionBodySizeBucket(bodyId),
				failureClass: null,
			};
			this.recordEditorAdmission(sample);
			this.editorAdmissionPending.set(consumerId, { sample, startedAt });
		} catch (error) {
			this.recordEditorAdmission({
				tier,
				outcome: "failed",
				acquisitionMs: Math.max(0, this.monotonicNow() - startedAt),
				visibleToBoundMs: null,
				cmBindMs: null,
				...trace,
				socketCount: this.sessions.size + 1,
				bodySizeBucket: this.editorAdmissionBodySizeBucket(bodyId),
				failureClass: this.editorAdmissionFailureClass(error),
			});
			throw error;
		}
	}

	private async acquireEditorBodyInternal(
		path: string,
		consumerId: string,
		trace: EditorAdmissionTrace,
	): Promise<void> {
		if (this.destroyed) throw new Error("runtime is destroyed");
		const bodyId = this.getFileId(path);
		if (!bodyId) throw new Error(`root catalog has no active body for ${path}`);
		const already = this.sessions.get(bodyId);
		if (already?.consumers.has(consumerId)) return;
		const generation = (this.consumerGenerations.get(consumerId) ?? 0) + 1;
		this.consumerGenerations.set(consumerId, generation);
		const loaded = this.bodies.get(bodyId);
		if (already && already.consumers.size > 0 && loaded?.doc === already.doc) {
			const projectionStartedAt = this.monotonicNow();
			this.attachEditorConsumer(path, bodyId, consumerId, generation, already, loaded);
			trace.projectionMs += Math.max(0, this.monotonicNow() - projectionStartedAt);
			this.refreshResidencyObservations();
			return;
		}
		const queuedAt = this.monotonicNow();
		let reconnectInBackground = false;
		await this.withBodyAdmission(bodyId, "editor", true, "active", async () => {
			trace.queueDelayMs += Math.max(0, this.monotonicNow() - queuedAt);
			const existing = this.sessions.get(bodyId);
			const body = await this.loadCurrentBodyForEditor(bodyId, existing, trace);
			if (this.destroyed) throw new Error("runtime closed during body acquisition");
			let session = this.sessions.get(bodyId);
			if (!session || session.doc !== body.doc) {
				if (session) this.destroyBodySession(session);
				const providerAdmissionStartedAt = this.monotonicNow();
				session = this.createBodySession(body);
				this.sessions.set(bodyId, session);
				session.ready = this.waitForBodySync(session, body);
				trace.providerAdmissionMs += Math.max(0, this.monotonicNow() - providerAdmissionStartedAt);
			} else if (!this.isProviderOpen(session.provider) && !session.provider.wsconnecting) {
				// A warm session whose socket closed while no editor used it.
				// Online, the editor waits for the reconnect so it does not bind
				// to a body that cannot receive remote updates. Offline (root not
				// open) that wait can only fail; the local warm body is bound at
				// once, exactly as before, and reconnects in the background. A
				// failed online reconnect degrades the same way instead of
				// destroying a session that still holds the local state.
				if (this.isProviderOpen(this.provider)) {
					session.ready = this.waitForBodySync(session, body, true).catch((error: unknown) => {
						this.log(`warm body reopen reconnect failed for ${bodyId}: ${String(error)}`);
						reconnectInBackground = true;
					});
				} else {
					session.ready = Promise.resolve();
					reconnectInBackground = true;
				}
			}
			try {
				const providerSyncStartedAt = this.monotonicNow();
				await session.ready;
				trace.providerSyncMs += Math.max(0, this.monotonicNow() - providerSyncStartedAt);
			} catch (error) {
				if (this.sessions.get(bodyId) === session && session.consumers.size === 0) {
					this.destroyBodySession(session);
				}
				throw error;
			}
			if (this.destroyed) throw new Error("runtime closed during body synchronization");
			if (this.consumerGenerations.get(consumerId) !== generation) {
				if (this.sessions.get(bodyId) === session && session.consumers.size === 0) {
					this.destroyBodySession(session);
				}
				throw new Error(`stale body acquisition for ${path}`);
			}
			const projectionStartedAt = this.monotonicNow();
			this.attachEditorConsumer(path, bodyId, consumerId, generation, session, body);
			trace.projectionMs += Math.max(0, this.monotonicNow() - projectionStartedAt);
		}, false, true);
		this.refreshResidencyObservations();
		// The consumer is attached now, so the repair treats it as an editor body.
		if (reconnectInBackground && !this.destroyed) this.requestReconnect(`body-disconnected:${bodyId}`);
	}

	completeEditorBodyBinding(consumerId: string): void {
		const pending = this.editorAdmissionPending.get(consumerId);
		if (!pending) return;
		this.editorAdmissionPending.delete(consumerId);
		pending.sample.outcome = "bound";
		pending.sample.visibleToBoundMs = Math.max(0, this.monotonicNow() - pending.startedAt);
		pending.sample.cmBindMs = Math.max(0, pending.sample.visibleToBoundMs - pending.sample.acquisitionMs);
	}

	getEditorAdmissionDiagnostics(): readonly EditorAdmissionSample[] {
		return this.editorAdmissionSamples.map((sample) => ({ ...sample }));
	}

	private recordEditorAdmission(sample: EditorAdmissionSample): void {
		this.editorAdmissionSamples.push(sample);
		if (this.editorAdmissionSamples.length > 256) this.editorAdmissionSamples.shift();
	}

	private monotonicNow(): number {
		return typeof performance === "undefined" ? this.now() : performance.now();
	}

	private editorAdmissionBodySizeBucket(bodyId: string | undefined): EditorAdmissionBodySizeBucket {
		const bytes = bodyId ? this.bodies.get(bodyId)?.residencyMeasurement.materializedTextUtf8Bytes : undefined;
		if (bytes === undefined) return "unknown";
		if (bytes < 16 * 1024) return "lt-16-kib";
		if (bytes < 256 * 1024) return "16-256-kib";
		if (bytes < 1024 * 1024) return "256-kib-1-mib";
		return "gte-1-mib";
	}

	private editorAdmissionFailureClass(error: unknown): EditorAdmissionFailureClass {
		const message = error instanceof Error ? error.message : String(error);
		if (/stale|cancel|closed|destroyed|superseded/i.test(message)) return "cancelled";
		if (/catalog|identity|active|authority|generation|revision/i.test(message)) return "identity";
		if (/budget|capacity|429|admission/i.test(message)) return "capacity";
		if (/network|socket|provider|timeout|fetch|http/i.test(message)) return "network";
		return "unknown";
	}

	private attachEditorConsumer(
		path: string,
		bodyId: string,
		consumerId: string,
		generation: number,
		session: BodySession,
		body: LoadedBody,
	): void {
		if (this.destroyed || this.consumerGenerations.get(consumerId) !== generation
			|| this.sessions.get(bodyId) !== session || session.doc !== body.doc) {
			throw new Error(`stale body acquisition for ${path}`);
		}
		if (!session.consumers.has(consumerId)) {
			const projectionLease = this.bodies.coordinator.acquireProjection(path, bodyId, "editor", consumerId);
			session.consumers.add(consumerId);
			session.projectionLeases.set(consumerId, projectionLease);
			this.bodies.pin(bodyId);
		}
		this.bodies.coordinator.setResidency(bodyId, "active");
		this.textToBodyId.set(body.doc.getText(BODY_TEXT_NAME), bodyId);
	}

	isEditorBodyReady(path: string, consumerId: string): boolean {
		const bodyId = this.getFileId(path);
		if (!bodyId) return false;
		const session = this.sessions.get(bodyId);
		return !!session?.consumers.has(consumerId) && this.bodies.get(bodyId)?.doc === session.doc;
	}

	releaseEditorBody(path: string, consumerId: string): void {
		this.editorAdmissionPending.delete(consumerId);
		this.consumerGenerations.set(consumerId, (this.consumerGenerations.get(consumerId) ?? 0) + 1);
		const bodyId = this.findSessionBodyForConsumer(consumerId) ?? this.getFileId(path);
		if (!bodyId) return;
		const session = this.sessions.get(bodyId);
		if (!session || !session.consumers.delete(consumerId)) return;
		session.projectionLeases.get(consumerId)?.release();
		session.projectionLeases.delete(consumerId);
		this.bodies.unpin(bodyId);
		if (session.consumers.size === 0) {
			this.bodies.coordinator.setResidency(bodyId, "warm");
			this.refreshResidencyObservations();
			void this.runResidencyMaintenance().catch((error) => {
				this.log(`editor release residency maintenance failed: ${String(error)}`);
			});
		}
	}

	async flushBodyCandidate(bodyId: string, mode: CandidateSubmitMode = "http"): Promise<void> {
		const updates = this.pendingUpdates.get(bodyId);
		if (updates && updates.length > 0) {
			this.pendingUpdates.delete(bodyId);
			const relayMark = this.pendingRelayMarks.get(bodyId) ?? null;
			this.pendingRelayMarks.delete(bodyId);
			const encodedUpdate = updates.length === 1 ? updates[0]! : Y.mergeUpdates(updates);
			try {
				await this.bodies.markDirty(bodyId);
				const pending = await this.captureCandidate(
					bodyId,
					encodedUpdate,
					undefined,
					updates.length,
				);
				if (pending.relayMark === undefined) pending.relayMark = relayMark;
			} catch (error) {
				const newer = this.pendingUpdates.get(bodyId) ?? [];
				this.pendingUpdates.set(bodyId, [...updates, ...newer]);
				// Re-queued updates may now span channels: HTTP only.
				this.pendingRelayMarks.set(bodyId, null);
				throw error;
			}
		}
		await this.submitPendingForBody(bodyId, mode);
	}

	/** Relay receipt counters for one body session, or null without one. */
	getRelayReceiptDiagnostics(bodyId: string): RelayReceiptDiagnostics | null {
		return this.sessions.get(bodyId)?.relay?.diagnostics() ?? null;
	}

	async retryPendingCandidates(): Promise<void> {
		const bodyIds = new Set(Array.from(this.pendingCandidates.values(), (candidate) => candidate.record.bodyId));
		for (const bodyId of bodyIds) await this.submitPendingForBody(bodyId);
	}

	async reconnect(reason = "explicit"): Promise<OperationOutcome> {
		const outcome = await this.runReconnectWork(reason);
		if (outcome.kind === "retryable_failure" && !this.destroyed && !this.fatalAuthError) {
			const delayMs = outcome.retryAfterMs ?? ticketRefreshBufferMs();
			await this.workScheduler.queueReconnect(`retry:${reason}`, this.now() + delayMs);
		}
		return outcome;
	}

	queueReconnect(reason: string, delayMs = 0, maxWaitMs?: number): Promise<void> {
		const now = this.now();
		// The reconnect slot is last-write-wins: a later fast reconnect (app
		// foregrounded, network online, a second close) must not pull a
		// flap-backoff reconnect forward. The floor holds until it passes or the
		// flapping socket opens.
		const floor = this.reconnectFloor(now);
		return this.workScheduler.queueReconnect(
			reason,
			Math.max(now + Math.max(0, delayMs), floor),
			maxWaitMs === undefined ? undefined : Math.max(now + Math.max(0, maxWaitMs), floor),
		);
	}

	private holdReconnectFloor(documentId: string, delayMs: number): void {
		const until = this.now() + Math.max(0, delayMs);
		this.reconnectFloors.set(documentId, Math.max(this.reconnectFloors.get(documentId) ?? 0, until));
	}

	private reconnectFloor(now: number): number {
		let floor = 0;
		for (const [documentId, until] of this.reconnectFloors) {
			if (until <= now) this.reconnectFloors.delete(documentId);
			else floor = Math.max(floor, until);
		}
		return floor;
	}

	pokeOverdueWork(reason: string): void {
		this.workScheduler.poke(reason);
	}

	getOverdueWorkDiagnostics(): OverdueWorkDiagnostics {
		return this.workScheduler.diagnostics();
	}

	whenOverdueWorkIdle(): Promise<void> {
		return this.workScheduler.whenIdle();
	}

	private async runReconnectWork(reason: string): Promise<OperationOutcome> {
		if (this.destroyed) return { kind: "cancelled" };
		if (this.reconnectBlocked?.()) return { kind: "cancelled" };
		// Neither an expiring ticket nor a body close is a reason to replace an
		// open root socket: repair only what is detached.
		// `reconnect()` re-queues a failed pass as `retry:<reason>`; the retry
		// concerns the same providers. Unprefixed, a failed body repair came
		// back as a full admission that replaced the open root.
		const baseReason = reason.replace(/^(?:retry:)+/, "");
		if (baseReason === TICKET_EXPIRY_CHECK_REASON || isDetachedProviderRepairReason(baseReason)) {
			if (this.isProviderOpen(this.provider)) return this.repairDetachedProviders();
			// Root is mid-admission (CONNECTING). Replacing it here restarted
			// the admission it was waiting on; recheck once it had time to open.
			if (this.isProviderConnectingInTime(this.provider)) {
				return { kind: "retryable_failure", failure: "network", retryAfterMs: ROOT_CONNECTING_RECHECK_MS };
			}
		}
		const outcome = await this.socketAdmission.request(reason);
		this.applyTerminalAdmissionOutcome(outcome);
		if (outcome.kind === "completed") {
			this.canvases?.resumeLiveProviders();
			const repaired = await this.repairDetachedProviders();
			if (repaired.kind !== "completed") return repaired;
		}
		return outcome;
	}

	private isProviderOpen(provider: SyncProviderPort): boolean {
		const open = provider.wsconnected && provider.ws?.readyState === 1;
		if (open) this.providerConnectingSince.delete(provider);
		return open;
	}

	/**
	 * True while the provider's socket is CONNECTING and has been for less
	 * than {@link PROVIDER_CONNECT_TIMEOUT_MS}. A CONNECTING socket is not
	 * detached: tearing it down to "repair" it minted a new ticket, queued a
	 * new expiry check and opened another CONNECTING socket, ~10 per second
	 * (P0c storm).
	 */
	private isProviderConnectingInTime(provider: SyncProviderPort): boolean {
		const connecting = provider.wsconnecting || provider.ws?.readyState === 0;
		if (!connecting || this.isProviderOpen(provider)) {
			this.providerConnectingSince.delete(provider);
			return false;
		}
		const now = this.now();
		const since = this.providerConnectingSince.get(provider);
		if (since === undefined) {
			this.providerConnectingSince.set(provider, now);
			return true;
		}
		return now - since < PROVIDER_CONNECT_TIMEOUT_MS;
	}

	/**
	 * Reconnects body sessions and live canvases that are not open. Warm
	 * sessions (closed notes) are repaired too: a detached warm body keeps its
	 * lease, so server catch-up cannot replace it either, and remote edits
	 * would reach neither its Y.Doc nor disk until eviction.
	 */
	private async repairDetachedProviders(): Promise<OperationOutcome> {
		for (const session of [...this.sessions.values()]) {
			if (session.consumers.size === 0 || this.isProviderOpen(session.provider)) continue;
			if (this.isProviderConnectingInTime(session.provider)) continue;
			try {
				await this.reconnectBodySession(session);
			} catch (error) {
				this.log(`body reconnect failed for ${session.bodyId}: ${String(error)}`);
				if (!this.destroyed && !this.fatalAuthError) {
					// Keep the coordinator's backoff (e.g. a rate-limited admission's
					// retryAfterMs) instead of retrying on the generic network policy.
					const outcome = error instanceof SocketAdmissionNotCompletedError ? error.outcome : null;
					return outcome?.kind === "retryable_failure" ? outcome : { kind: "retryable_failure", failure: "network" };
				}
			}
		}
		for (const session of [...this.sessions.values()]) {
			if (session.consumers.size > 0 || this.isProviderOpen(session.provider)) continue;
			if (this.isProviderConnectingInTime(session.provider) || this.sessions.get(session.bodyId) !== session) continue;
			try {
				await this.reconnectBodySession(session, true);
			} catch (error) {
				this.log(`warm body reconnect failed for ${session.bodyId}: ${String(error)}`);
			}
		}
		for (const { documentId, provider } of this.canvases?.activeProviders() ?? []) {
			if (provider.wsconnected || provider.wsconnecting) continue;
			this.canvases?.reconnectLive(documentId);
		}
		return { kind: "completed", value: undefined };
	}

	private async runCandidateWork(bodyId: string): Promise<OperationOutcome> {
		if (this.destroyed) return { kind: "cancelled" };
		try {
			await this.flushBodyCandidate(bodyId, "defer");
			const remainsPending = [...this.pendingCandidates.values()]
				.some((candidate) => candidate.record.bodyId === bodyId && !this.isRelayDeferred(candidate));
			if (remainsPending) return { kind: "retryable_failure", failure: "network" };
			return { kind: "completed", value: undefined };
		} catch (error) {
			this.log(`candidate flush failed for ${bodyId}: ${String(error)}`);
			return {
				kind: "retryable_failure",
				failure: this.candidatePersistenceHealthy === false ? "local_persistence" : "network",
			};
		}
	}

	private async runBodyWakeWork(bodyId: string, minimumGeneration: number): Promise<OperationOutcome> {
		if (this.destroyed) return { kind: "cancelled" };
		const loaded = this.bodies.get(bodyId);
		if (!loaded || loaded.generation >= minimumGeneration) {
			return { kind: "completed", value: undefined };
		}
		try {
			const current = await this.withBodyAdmission(
				bodyId,
				"background",
				false,
				"warm",
				() => this.loadCurrentBodyUnadmitted(bodyId),
				true,
				true,
			);
			if (current.generation < minimumGeneration) {
				return { kind: "retryable_failure", failure: "network" };
			}
			return { kind: "completed", value: undefined };
		} catch (error) {
			this.log(`BODY_COMMITTED catch-up failed for ${bodyId}: ${String(error)}`);
			return { kind: "retryable_failure", failure: "network" };
		}
	}

	private async runAttachmentPublicationWork(): Promise<OperationOutcome> {
		if (this.destroyed) return { kind: "cancelled" };
		try {
			await this.retryAttachmentOperations();
			return { kind: "completed", value: undefined };
		} catch (error) {
			this.log(`attachment publication remains pending: ${String(error)}`);
			if (error instanceof AttachmentPublicationProofError) {
				return { kind: "permanently_blocked", failure: "malformed_response" };
			}
			if (error instanceof AttachmentPublicationError) {
				if (error.status === 401) return { kind: "permanently_blocked", failure: "unauthorized" };
				if (error.status === 403) return { kind: "permanently_blocked", failure: "revoked" };
				if (error.status === 404 || error.status === 426) {
					return { kind: "permanently_blocked", failure: "incompatible_protocol" };
				}
				if (error.status === 429) return { kind: "retryable_failure", failure: "rate_limited" };
				if (error.status >= 500) return { kind: "retryable_failure", failure: "network" };
				return { kind: "permanently_blocked", failure: "malformed_response" };
			}
			return { kind: "retryable_failure", failure: "local_persistence" };
		}
	}

	setReconnectRequester(requester: ((reason: string, delayMs?: number) => void) | null): void {
		this.reconnectRequester = requester;
	}

	setReconnectBlocked(blocked: (() => boolean) | null): void {
		this.reconnectBlocked = blocked;
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const wake of Array.from(this.submissionWindowWakers)) wake();
		for (const entry of this.createCollector.values()) for (const wake of entry.observers.splice(0)) wake();
		this.residencyRuntime.stop();
		this.workScheduler.stop();
		this.runtimeScope.stopAdmission();
		this.socketAdmission.stop();
		this.socketLiveness.stop();
		for (const timer of this.semanticEpochResetRetryTimers.values()) window.clearTimeout(timer);
		this.semanticEpochResetRetryTimers.clear();
		for (const waiter of this.currentnessWaiters.values()) {
			window.clearTimeout(waiter.timer);
			waiter.resolve(null);
		}
		this.currentnessWaiters.clear();
		for (const waiters of this.pendingRootCurrentness.values()) {
			for (const resolve of waiters) resolve({ queried: false, head: null });
		}
		this.pendingRootCurrentness.clear();
		this.reconnectRequester = null;
		this.reconnectBlocked = null;
		if (this.renameTimer !== null) {
			window.clearTimeout(this.renameTimer);
			this.renameTimer = null;
			await this.flushRenameBatch();
		}
		for (const timer of this.relayFallbackTimers.values()) this.relayClock.clearTimer(timer);
		this.relayFallbackTimers.clear();
		for (const bodyId of Array.from(this.pendingUpdates.keys())) {
			await this.flushBodyCandidate(bodyId).catch(() => undefined);
		}
		await this.workScheduler.whenIdle();
		await this.attachmentPublicationWork;
		for (const session of this.sessions.values()) {
			for (const lease of session.projectionLeases.values()) lease.release();
			session.projectionLeases.clear();
			session.lifetimeLease.release();
			session.doc.off("update", session.updateObserver);
			this.terminateProvider(session.provider);
			session.provider.destroy();
			session.relay?.destroy();
		}
		this.settleRelayWaiters(null);
		this.sessions.clear();
		for (const semantic of this.semanticMirrors.values()) semantic.mirror.destroy();
		this.semanticMirrors.clear();
		this.pendingRenameTargets.clear();
		this.terminateProvider(this.provider);
		this.provider.awareness.destroy();
		this.provider.destroy();
		await this.persistRoot();
		await this.bodies.destroy();
		const drain = await this.runtimeScope.drain(1_000);
		if (!drain.completed) {
			this.log(`runtime drain incomplete: work=${drain.unfinishedWork.join(",")} leases=${drain.activeLeases.join(",")}`);
		}
		this.canvases?.destroy();
		await this.options.database.close();
	}

	private setFatalAuth(code: FatalSyncCode, details: FatalSyncDetails): void {
		if (this.fatalAuthError) return;
		this._fatalAuthCode = code;
		this._fatalAuthDetails = details;
		this.provider.disconnect();
		for (const session of this.sessions.values()) session.provider.disconnect();
		this.canvases?.pauseLiveProviders();
		for (const callback of this.fatalAuthListeners) callback();
	}

	private handleNativeSocketClose(event: NativeSocketClose): void {
		if (event.code !== AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE) return;
		this.setFatalAuth("authority_superseded", {
			clientSchemaVersion: SCHEMA_VERSION,
			roomSchemaVersion: SCHEMA_VERSION,
			reason: event.reason || "socket authority superseded",
		});
	}

	private wireRootProvider(): void {
		const provider = this.provider;
		const document = this.ydoc;
		this.bodies.coordinator.replacePathBindings(this.pathToId.entries());
		this.ydoc.on("afterTransaction", () => {
			if (!this.destroyed && this.ydoc === document) {
				this.bodies.coordinator.replacePathBindings(this.pathToId.entries());
				this.canvases?.replaceCatalog(this.pathToSemantic.entries());
			}
		});
		provider.on("status", ({ status }) => {
			if (this.provider !== provider) return;
			if (status === "connected") {
				this.expectedDisconnects.delete(provider);
				this.flapBackoff.opened(ROOT_DOCUMENT_ID, this.now());
				this.admissionGate.opened(ROOT_DOCUMENT_ID);
				this.reconnectFloors.delete(ROOT_DOCUMENT_ID);
				this.invalidateSocketSession(provider);
				this.socketLiveness.connected(ROOT_DOCUMENT_ID);
				this._connectionGeneration++;
				this.workScheduler.poke("root-connected");
			} else if (status === "disconnected" && this.expectedDisconnects.delete(provider)) {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(ROOT_DOCUMENT_ID);
			} else if (status === "disconnected" && !this.fatalAuthError) {
				// An unplanned root close is always recovered, even while another
				// (e.g. body) admission is in flight: the coordinator runs the root
				// admission after in-flight provider admissions settle, and
				// admission-caused closes are marked expected above, so this
				// cannot loop. Dropping it left root offline until the next
				// ticket-expiry check. `disconnect()` stops y-partyserver's own
				// retry loop, which would reuse the closed socket's ticket.
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(ROOT_DOCUMENT_ID);
				provider.disconnect();
				// A socket closed right after it opened (e.g. rejected after
				// upgrade) backs off instead of reconnecting every second.
				const flapDelayMs = this.flapBackoff.closed(ROOT_DOCUMENT_ID, this.now());
				if (flapDelayMs !== null) this.holdReconnectFloor(ROOT_DOCUMENT_ID, flapDelayMs);
				this.requestReconnect("root-disconnected", flapDelayMs ?? undefined);
			} else if (status === "disconnected") {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(ROOT_DOCUMENT_ID);
			}
		});
		provider.on("sync", (synced) => {
			if (!synced || this.provider !== provider) return;
			for (const callback of this.providerSyncListeners) callback(this._connectionGeneration);
		});
		const handleFatal = (payload: string) => {
			if (this.provider !== provider) return;
			const fatal = asFatalSyncMessage(payload);
			if (!fatal) return;
			this.setFatalAuth(fatal.code, fatal.details);
		};
		const handleRootControl = (payload: string) => {
			if (this.provider !== provider) return;
			handleFatal(payload);
			this.handleVaultControl(payload, ROOT_DOCUMENT_ID, provider);
			this.handleCurrentnessResult(payload, provider);
			this.handleBodyChangedHint(payload);
			const committed = asBodyCommittedNotification(payload);
			const session = this.socketSessions.get(provider);
			if (committed && session
				&& committed.vaultGeneration === this.options.vaultGeneration
				&& committed.runtimeEpoch === session.runtimeEpoch) {
				void this.handleDurableBodyCommitted(committed).catch((error) => {
					this.log(`durable body commit handling failed: ${String(error)}`);
				});
			}
			const semanticDocumentId = semanticCommittedDocumentId(payload);
			if (semanticDocumentId) void this.canvases?.refresh(semanticDocumentId).catch((error) => {
				this.log(`Canvas refresh failed for ${semanticDocumentId}: ${String(error)}`);
			});
		};
		provider.on("custom-message", handleRootControl);
		this.ydoc.on("update", (_update, origin) => {
			if (this.ydoc !== document) return;
			if (origin === provider.documentOrigin) {
				this._lastRemoteUpdateAt = this.now();
				const invalidPath = this.invalidRootPath();
				if (invalidPath) {
					this.setFatalAuth("server_misconfigured", {
						clientSchemaVersion: SCHEMA_VERSION,
						roomSchemaVersion: SCHEMA_VERSION,
						reason: `invalid root path: ${invalidPath}`,
					});
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
		this.ensureSemanticMirror(body);
		const factory = this.options.providerFactory ?? ((input) => this.createDefaultProvider(input));
		// Created before the provider so its doc observer numbers each local
		// update before the provider's update handler sends it.
		let relayProvider: SyncProviderPort | null = null;
		const relay = new RelayReceiptChannel({
			bodyId: body.bodyId,
			doc: body.doc,
			bodyEpoch: () => this.bodies.get(body.bodyId)?.bodyEpoch ?? body.bodyEpoch,
			isLocalOrigin: (origin) => relayProvider !== null
				&& origin !== relayProvider.documentOrigin
				&& !RELAY_NON_LOCAL_ORIGINS.has(origin),
			receipts: this.options.relayReceipts !== false,
			setTimer: (callback, delayMs) => this.relayClock.setTimer(callback, delayMs),
			clearTimer: (handle) => this.relayClock.clearTimer(handle),
			...(this.options.workRandom ? { random: () => this.options.workRandom!.next() } : {}),
			newFrameId: () => crypto.randomUUID(),
			onConfirmed: (_seq, info) => this.handleRelayConfirmed(body.bodyId, relay, info),
			onRelayActiveChanged: (active) => this.handleRelayActiveChanged(body.bodyId, relay, active),
			log: (message) => this.log(message),
		});
		let provider: SyncProviderPort;
		try {
			provider = factory({ kind: "body", documentId: body.bodyId,
				documentEpoch: body.bodyEpoch, doc: body.doc,
				onClose: (event) => this.handleNativeSocketClose(event),
				socketTap: relay.tapFactory });
		} catch (error) {
			relay.destroy();
			throw error;
		}
		relayProvider = provider;
		this.registerSocketLiveness(body.bodyId, provider);
		const lifetimeLease = this.bodies.acquireLease(body.bodyId);
		let session!: BodySession;
		const handleControl = (payload: string) => {
			this.handleVaultControl(payload, body.bodyId, provider);
			this.handleCurrentnessResult(payload, provider);
			this.handleBodyChangedHint(payload, body.bodyId);
			const committed = asBodyCommittedNotification(payload);
			if (committed) this.handleBodySessionCommitted(session, committed);
		};
		provider.on("custom-message", handleControl);
		provider.on("status", ({ status }) => {
			if (status === "connected") {
				this.expectedDisconnects.delete(provider);
				this.flapBackoff.opened(body.bodyId, this.now());
				this.admissionGate.opened(body.bodyId);
				this.reconnectFloors.delete(body.bodyId);
				this.invalidateSocketSession(provider);
				this.socketLiveness.connected(body.bodyId);
			} else if (status === "disconnected" && this.expectedDisconnects.delete(provider)) {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(body.bodyId);
			} else if (status === "disconnected" && !this.fatalAuthError) {
				// As for root: never dropped because another admission is in flight.
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(body.bodyId);
				provider.disconnect();
				const flapDelayMs = this.flapBackoff.closed(body.bodyId, this.now());
				if (flapDelayMs !== null) this.holdReconnectFloor(body.bodyId, flapDelayMs);
				if ((this.sessions.get(body.bodyId)?.consumers.size ?? 0) > 0) {
					this.requestReconnect(`body-disconnected:${body.bodyId}`, flapDelayMs ?? undefined);
				}
			} else if (status === "disconnected") {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(body.bodyId);
			}
		});
		const updateObserver = (update: Uint8Array, origin: unknown) => {
			if (origin === provider.documentOrigin) {
				this._lastRemoteUpdateAt = this.now();
				if ((this.sessions.get(body.bodyId)?.consumers.size ?? 0) === 0) {
					const path = this.pathForBodyId(body.bodyId);
					if (path) this.options.onRemoteUpdateToClosedBody?.({ bodyId: body.bodyId, path });
				}
				void this.bodies.mergeFromServer(
					body.bodyId,
					new Uint8Array(),
					body.bodyEpoch,
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
			const mark = this.pendingRelayMarks.get(body.bodyId);
			this.pendingRelayMarks.set(body.bodyId, updates.length === 0 || mark?.channel === relay
				? { channel: relay, seq: relay.seq }
				: null);
			updates.push(update.slice());
			this.pendingUpdates.set(body.bodyId, updates);
			this.queueBodyPersistence(body.bodyId);
			this.scheduleCandidate(body.bodyId);
		};
		body.doc.on("update", updateObserver);
		session = {
			bodyId: body.bodyId,
			doc: body.doc,
			provider,
			consumers: new Set(),
			projectionLeases: new Map(),
			lifetimeLease,
			updateObserver,
			ready: Promise.resolve(),
			pendingCommitted: null,
			watermarkWork: Promise.resolve(),
			relay,
		};
		provider.on("sync", (synced) => {
			if (synced && session.pendingCommitted) this.handleBodySessionCommitted(session, session.pendingCommitted);
		});
		return session;
	}

	private async loadBodyWithPriority(
		bodyId: string,
		priority: AdmissionPriority,
		essentialInBackground = false,
	): Promise<LoadedBody> {
		const body = await this.withBodyAdmission(
			bodyId,
			priority,
			false,
			"warm",
			() => this.bodies.load(bodyId),
			essentialInBackground,
		);
		this.ensureSemanticMirror(body);
		return body;
	}

	private async withBodyAdmission<T>(
		bodyId: string,
		priority: AdmissionPriority,
		needsSocket: boolean,
		finalPopulation: "active" | "warm",
		execute: () => Promise<T>,
		essentialInBackground = false,
		reserveCurrentnessScratch = false,
	): Promise<T> {
		const needsLoad = this.bodies.get(bodyId) === null;
		const estimate = needsLoad || reserveCurrentnessScratch
			? await this.bodies.estimateColdLoadForBody(bodyId)
			: null;
		const session = this.sessions.get(bodyId);
		const socketOwned = session !== undefined
			&& (session.provider.wsconnecting
				|| (session.provider.wsconnected && session.provider.ws?.readyState === 1));
		return this.residencyRuntime.run({
			bodyId,
			priority,
			needsLoad,
			needsSocket: needsSocket && !socketOwned,
			residentCost: needsLoad ? estimate?.estimatedResidentBytes ?? 0 : 0,
			transientCost: estimate?.reconstructionScratchBytes ?? 0,
			finalPopulation,
			essentialInBackground,
		}, async () => {
			try {
				return await execute();
			} finally {
				this.refreshResidencyObservations();
			}
		});
	}

	private refreshResidencyObservations(): void {
		const loadedBodyIds = new Set(this.bodies.loadedBodyIds());
		for (const bodyId of this.residencyObservedBodyIds) {
			if (loadedBodyIds.has(bodyId)) continue;
			this.residencyAdmission.forgetBody(bodyId);
			this.bodies.clearExternalResourceSignals(bodyId);
			this.residencyObservedBodyIds.delete(bodyId);
		}
		for (const bodyId of loadedBodyIds) {
			const body = this.bodies.get(bodyId);
			if (!body) continue;
			const session = this.sessions.get(bodyId);
			const socket = !session
				? "none" as const
				: session.provider.wsconnected && session.provider.ws?.readyState === 1
					? "open" as const
					: session.provider.wsconnecting ? "opening" as const : "none" as const;
			const updateBytes = (this.pendingUpdates.get(bodyId) ?? [])
				.reduce((total, update) => total + update.byteLength, 0);
			const candidateBytes = [...this.pendingCandidates.values()]
				.filter((pending) => pending.record.bodyId === bodyId)
				.reduce((total, pending) => total + pending.record.encodedUpdate.byteLength, 0);
			this.bodies.setExternalResourceSignals(bodyId, {
				localPendingBufferBytes: updateBytes + candidateBytes,
				remotePendingBufferBytes: 0,
				providerCount: session ? 1 : 0,
				socketCount: socket === "none" ? 0 : 1,
				awarenessPeerCount: session?.provider.awareness.getStates().size ?? 0,
			});
			const coordination = this.bodies.coordinator.snapshot(bodyId);
			const population = coordination?.residency === "active"
				? "active" as const
				: coordination?.residency === "loading" ? "loading" as const : "warm" as const;
			this.residencyAdmission.observeBody({
				bodyId,
				population,
				residentCost: body.estimatedCost,
				transientCost: 0,
				dirty: body.dirty,
				durablyPending: body.unsettled > 0,
				leaseCount: Math.max(0, (coordination?.leaseCount ?? 0) - (session ? 1 : 0)),
				socket,
				lastUsedAt: body.lastUsedAt,
			});
			this.residencyObservedBodyIds.add(bodyId);
		}
		this.bodies.setSharedResourceSignals({
			rootCatalogReportedBytes: Y.encodeStateAsUpdate(this.ydoc).byteLength,
			pendingBufferBytes: 0,
			providerCount: 1,
			socketCount: this.connected || this.provider.wsconnecting ? 1 : 0,
			awarenessPeerCount: this.provider.awareness.getStates().size,
		});
	}

	private async prepareResidencyReservation(reservation: AdmissionReservation): Promise<void> {
		for (const bodyId of reservation.closeSocketBodyIds) {
			if (!this.closeIdleBodySession(bodyId)) {
				throw new Error(`body ${bodyId} is no longer eligible for socket closure`);
			}
		}
		for (const bodyId of reservation.evictBodyIds) {
			if (!await this.evictIdleBody(bodyId)) {
				throw new Error(`body ${bodyId} eviction was blocked`);
			}
		}
		this.refreshResidencyObservations();
	}

	private closeIdleBodySession(bodyId: string): boolean {
		const session = this.sessions.get(bodyId);
		if (!session) return true;
		const body = this.bodies.get(bodyId);
		const coordination = this.bodies.coordinator.snapshot(bodyId);
		if (!body
			|| session.consumers.size > 0
			|| body.dirty
			|| body.unsettled > 0
			|| body.pendingLocalUpdates > 0
			|| body.pins > 0
			|| (coordination?.leaseCount ?? 0) > 1
			|| coordination?.residency === "active") return false;
		this.destroyBodySession(session);
		return true;
	}

	private async evictIdleBody(bodyId: string): Promise<boolean> {
		if (!this.bodies.get(bodyId)) return true;
		const revision = this.bodies.captureRevision(bodyId);
		const session = this.sessions.get(bodyId);
		if (session && !this.closeIdleBodySession(bodyId)) return false;
		const evicted = this.bodies.isRevisionCurrent(revision)
			&& this.bodies.evict(bodyId, revision);
		if (evicted) this.destroySemanticMirror(bodyId);
		return evicted;
	}

	private destroyBodySession(session: BodySession): void {
		if (this.sessions.get(session.bodyId) === session) this.sessions.delete(session.bodyId);
		this.socketLiveness.unregister(session.bodyId);
		session.doc.off("update", session.updateObserver);
		session.lifetimeLease.release();
		this.terminateProvider(session.provider);
		session.provider.destroy();
		session.relay?.destroy();
		this.settleRelayWaiters(session.relay);
	}

	private ensureSemanticMirror(body: LoadedBody): FrontmatterSemanticMirror {
		const current = this.semanticMirrors.get(body.bodyId);
		if (current?.doc === body.doc) return current.mirror;
		current?.mirror.destroy();
		const mirror = new FrontmatterSemanticMirror(body.doc, {
			textName: BODY_TEXT_NAME,
			onOpaque: (reason) => this.log(`frontmatter semantic fallback for ${body.bodyId}: ${reason}`),
			onProjected: (fields) => this.log(
				`frontmatter semantic projection for ${body.bodyId}: ${fields.join(",")}`,
			),
		});
		this.semanticMirrors.set(body.bodyId, { doc: body.doc, mirror });
		return mirror;
	}

	private destroySemanticMirror(bodyId: string): void {
		const current = this.semanticMirrors.get(bodyId);
		if (!current) return;
		current.mirror.destroy();
		this.semanticMirrors.delete(bodyId);
	}

	private async loadCurrentBody(bodyId: string): Promise<LoadedBody> {
		return this.withBodyAdmission(
			bodyId,
			"foreground",
			false,
			"warm",
			() => this.loadCurrentBodyUnadmitted(bodyId),
			false,
			true,
		);
	}

	private async loadCurrentBodyForEditor(
		bodyId: string,
		session: BodySession | undefined,
		trace: EditorAdmissionTrace,
	): Promise<LoadedBody> {
		const localLoadStartedAt = this.monotonicNow();
		const body = await this.bodies.load(bodyId);
		trace.localLoadMs += Math.max(0, this.monotonicNow() - localLoadStartedAt);
		if (session && session.doc === body.doc && session.provider.synced
			&& session.provider.wsconnected && session.provider.ws?.readyState === 1) {
			const proofStartedAt = this.monotonicNow();
			const result = await this.queryCurrentness(session.provider, [bodyId]);
			if (result) {
				trace.currentnessSource = "body-query";
				const head = result.heads.find((candidate) => candidate.bodyId === bodyId) ?? null;
				if (!head || head.lifecycle !== "active") throw new Error(`body ${bodyId} is not active`);
				const promoted = await this.promoteBodyFromCurrentness(body, head);
				trace.currentnessProofMs += Math.max(0, this.monotonicNow() - proofStartedAt);
				if (promoted) return body;
				return this.catchUpBody(body, head, trace);
			}
			trace.currentnessProofMs += Math.max(0, this.monotonicNow() - proofStartedAt);
		}
		const rootProofStartedAt = this.monotonicNow();
		const queried = await this.queryRootBodyHead(bodyId);
		if (queried.queried) {
			trace.currentnessSource = "root-query";
			trace.currentnessProofMs += Math.max(0, this.monotonicNow() - rootProofStartedAt);
			if (!queried.head || queried.head.lifecycle !== "active") throw new Error(`body ${bodyId} is not active`);
			return this.catchUpBody(body, queried.head, trace);
		}
		trace.currentnessProofMs += Math.max(0, this.monotonicNow() - rootProofStartedAt);
		trace.currentnessSource = "http-head";
		trace.httpFallback = true;
		return this.catchUpBody(body, undefined, trace);
	}

	/**
	 * Feed catch-up for a body that is already loaded: if live sync already
	 * brought it to exactly the head's content (hash and size verified), record
	 * the head's generation instead of replacing the live document.
	 */
	async promoteLoadedBodyToHead(head: {
		bodyId: string;
		bodyEpoch: SemanticEpoch;
		generation: number;
		contentHash: string | null;
		size: number | null;
	}): Promise<boolean> {
		const body = this.bodies.get(head.bodyId);
		if (!body || body.dirty) return false;
		return this.promoteBodyFromCurrentness(body, { ...head, lifecycle: "active" });
	}

	private async promoteBodyFromCurrentness(body: LoadedBody, head: BodyCurrentnessHead): Promise<boolean> {
		if (head.lifecycle !== "active") return false;
		if (head.bodyEpoch !== body.bodyEpoch) return false;
		const revision = this.bodies.captureRevision(body.bodyId);
		if (!await this.bodyMatchesHead(body.doc, head)
			|| !this.bodies.coordinator.isContentCurrent(revision)) return false;
		if (body.generation >= head.generation) return true;
		return this.bodies.promoteExactGeneration(body.bodyId, body.doc, revision, head.generation);
	}

	private queryRootBodyHead(bodyId: string): Promise<{ queried: boolean; head: BodyCurrentnessHead | null }> {
		return new Promise((resolve) => {
			const waiters = this.pendingRootCurrentness.get(bodyId) ?? [];
			waiters.push(resolve);
			this.pendingRootCurrentness.set(bodyId, waiters);
			if (this.rootCurrentnessScheduled) return;
			this.rootCurrentnessScheduled = true;
			queueMicrotask(() => { void this.flushRootCurrentnessQueries(); });
		});
	}

	private async flushRootCurrentnessQueries(): Promise<void> {
		this.rootCurrentnessScheduled = false;
		const pending = [...this.pendingRootCurrentness.entries()];
		this.pendingRootCurrentness.clear();
		for (let offset = 0; offset < pending.length; offset += 100) {
			const batch = pending.slice(offset, offset + 100);
			const result = await this.queryCurrentness(this.provider, batch.map(([bodyId]) => bodyId));
			const heads = new Map(result?.heads.map((head) => [head.bodyId, head]));
			for (const [bodyId, waiters] of batch) {
				const value = { queried: result !== null, head: heads.get(bodyId) ?? null };
				for (const resolve of waiters) resolve(value);
			}
		}
	}

	private queryCurrentness(
		provider: SyncProviderPort,
		bodyIds: readonly string[],
	): Promise<BodyCurrentnessResultFrame | null> {
		const session = this.socketSessions.get(provider);
		if (!session?.id || !session.capabilities || !provider.sendMessage || !provider.wsconnected
			|| provider.ws?.readyState !== 1) return Promise.resolve(null);
		const queryId = crypto.randomUUID();
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => {
				this.settleCurrentnessWaiter(queryId, null);
			}, DEFAULT_CURRENTNESS_QUERY_TIMEOUT_MS);
			this.currentnessWaiters.set(queryId, {
				session,
				bodyIds: new Set(bodyIds),
				resolve,
				timer,
			});
			try {
				provider.sendMessage!(JSON.stringify({ type: "BODY_CURRENTNESS_QUERY", queryId, bodyIds }));
			} catch {
				this.invalidateSocketSession(provider);
			}
		});
	}

	private handleCurrentnessResult(payload: string, provider: SyncProviderPort): void {
		let value: unknown;
		try { value = JSON.parse(payload); } catch {
			this.invalidateSocketSession(provider);
			return;
		}
		const record = value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: null;
		if (record?.type !== "BODY_CURRENTNESS_RESULT") return;
		const queryId = typeof record.queryId === "string"
			? record.queryId
			: null;
		const waiter = queryId ? this.currentnessWaiters.get(queryId) : undefined;
		const result = parseBodyCurrentnessResultFrame(value);
		if (!result) {
			if (queryId && waiter) this.settleCurrentnessWaiter(queryId, null);
			this.invalidateSocketSession(provider);
			return;
		}
		if (!waiter) return;
		const session = this.socketSessions.get(provider);
		if (session !== waiter.session || result.socketSessionId !== waiter.session.id) {
			this.settleCurrentnessWaiter(result.queryId, null);
			if (session === waiter.session) this.invalidateSocketSession(provider);
			return;
		}
		const returned = new Set([...result.heads.map((head) => head.bodyId), ...result.missingBodyIds]);
		if (returned.size !== waiter.bodyIds.size
			|| [...waiter.bodyIds].some((bodyId) => !returned.has(bodyId))) {
			this.invalidateSocketSession(provider);
			return;
		}
		this.settleCurrentnessWaiter(result.queryId, result);
	}

	private settleCurrentnessWaiter(queryId: string, result: BodyCurrentnessResultFrame | null): void {
		const waiter = this.currentnessWaiters.get(queryId);
		if (!waiter) return;
		window.clearTimeout(waiter.timer);
		this.currentnessWaiters.delete(queryId);
		waiter.resolve(result);
	}

	private invalidateSocketSession(provider: SyncProviderPort): void {
		const session = this.socketSessions.get(provider);
		this.socketSessions.delete(provider);
		if (!session) return;
		for (const [queryId, waiter] of this.currentnessWaiters) {
			if (waiter.session !== session) continue;
			this.settleCurrentnessWaiter(queryId, null);
		}
	}

	private async loadCurrentBodyUnadmitted(bodyId: string, suppliedHead?: BodyHead | null): Promise<LoadedBody> {
		const inFlight = this.currentnessChecks.get(bodyId);
		if (inFlight) return inFlight;
		const run = this.bodies.load(bodyId).then((body) => this.catchUpBody(body, suppliedHead)).then((body) => {
			this.ensureSemanticMirror(body);
			return body;
		});
		this.currentnessChecks.set(bodyId, run);
		try {
			return await run;
		} finally {
			if (this.currentnessChecks.get(bodyId) === run) {
				this.currentnessChecks.delete(bodyId);
			}
		}
	}

	private async catchUpBody(
		body: LoadedBody,
		suppliedHead?: BodyHead | null,
		trace?: EditorAdmissionTrace,
	): Promise<LoadedBody> {
		let head: BodyHead | null;
		if (suppliedHead !== undefined) {
			head = suppliedHead;
		} else {
			try {
				const proofStartedAt = trace ? this.monotonicNow() : 0;
				head = await this.server.currentHead(body.bodyId);
				if (trace) trace.currentnessProofMs += Math.max(0, this.monotonicNow() - proofStartedAt);
			} catch (error) {
				if (body.generation > 0 || body.dirty) return body;
				throw error;
			}
		}
		if (!head) throw new Error(`body ${body.bodyId} is not active`);
		if (
			head.bodyEpoch === body.bodyEpoch
			&&
			head.generation <= body.generation
			&& await this.bodyMatchesHead(body.doc, head)
		) return body;
		const stateFetchStartedAt = trace ? this.monotonicNow() : 0;
		const state = await this.server.currentBody(body.bodyId);
		if (state.bodyId !== body.bodyId || state.bodyEpoch !== head.bodyEpoch || state.generation < head.generation) {
			throw new Error("stale body catch-up response");
		}
		await this.validateBodyStateIntegrity(head, state);
		if (trace) trace.stateFetchMs += Math.max(0, this.monotonicNow() - stateFetchStartedAt);
		if (state.bodyEpoch !== body.bodyEpoch) {
			return this.rebaseBodyAcrossSemanticEpoch(body, state);
		}
		return body.dirty || body.unsettled > 0 || body.pendingLocalUpdates > 0 || body.pins > 0
			|| (this.bodies.coordinator.snapshot(body.bodyId)?.leaseCount ?? 0) > 0
			? this.bodies.mergeFromServer(body.bodyId, state.encodedState, state.bodyEpoch, state.generation)
			: this.bodies.replaceFromServer(body.bodyId, state.encodedState, state.bodyEpoch, state.generation);
	}

	private async rebaseBodyAcrossSemanticEpoch(body: LoadedBody, state: BodyState): Promise<LoadedBody> {
		if (state.bodyEpoch <= body.bodyEpoch) throw new Error(`stale semantic epoch for body ${body.bodyId}`);
		const session = this.sessions.get(body.bodyId);
		let transition = prepareSemanticEpochTransition({
			bodyId: body.bodyId,
			previousBodyEpoch: body.bodyEpoch,
			nextBodyEpoch: state.bodyEpoch,
			previousBaseline: body.durableBaseline,
			pendingMarkdown: body.doc.getText(BODY_TEXT_NAME).toJSON(),
			authoritativeEncodedState: state.encodedState,
		});
		if (transition.kind !== "ready") {
			const rejected = transition;
			const path = this.pathForBodyId(body.bodyId);
			if (!path || !this.options.onSemanticEpochRebaseConflict) {
				throw new SemanticEpochRebaseError(rejected);
			}
			// Preserve the user's semantic intent outside the retired CRDT lineage
			// before installing the fresh authoritative epoch.  If preservation
			// fails, retain the old local document and fail closed.
			await this.options.onSemanticEpochRebaseConflict({
				bodyId: body.bodyId,
				path,
				previousEpoch: body.bodyEpoch,
				currentEpoch: state.bodyEpoch,
				kind: rejected.kind,
				pendingMarkdown: rejected.pendingMarkdown,
				authoritativeContent: rejected.authoritativeContent,
			});
			transition = prepareSemanticEpochTransition({
				bodyId: body.bodyId,
				previousBodyEpoch: body.bodyEpoch,
				nextBodyEpoch: state.bodyEpoch,
				previousBaseline: rejected.authoritativeContent,
				pendingMarkdown: rejected.authoritativeContent,
				authoritativeEncodedState: state.encodedState,
			});
			if (transition.kind !== "ready") throw new Error("authoritative semantic epoch transition did not converge");
		}
		const candidateId = transition.rebasedUpdate ? crypto.randomUUID() : null;
		const capturedAt = this.now();
		const candidateRecord: CandidateRecord | null = transition.rebasedUpdate && candidateId ? {
			vaultId: this.options.vaultId,
			bodyId: body.bodyId,
			bodyEpoch: transition.bodyEpoch,
			previousBaseline: transition.authoritativeContent,
			pendingMarkdown: transition.rebasedContent,
			candidateId,
			candidateDigest: await sha256Hex(transition.rebasedUpdate),
			encodedUpdate: transition.rebasedUpdate.slice().buffer,
			capturedAt,
			capturedLocalUpdates: body.pendingLocalUpdates,
			authority: this.captureAuthority(),
		} : null;
		const consumers = session ? [...session.consumers] : [];
		if (session) {
			for (const consumerId of consumers) {
				session.projectionLeases.get(consumerId)?.release();
				this.bodies.unpin(body.bodyId);
				this.consumerGenerations.set(consumerId, (this.consumerGenerations.get(consumerId) ?? 0) + 1);
			}
			session.projectionLeases.clear();
			session.consumers.clear();
			this.destroyBodySession(session);
		}
		let installed = false;
		try {
			const replacement = await this.bodies.installSemanticEpochTransition(
				transition,
				state.generation,
				candidateRecord,
			);
			installed = true;
			const staleCandidates = [...this.pendingCandidates.values()]
				.filter((candidate) => candidate.record.bodyId === body.bodyId);
			for (const candidate of staleCandidates) this.pendingCandidates.delete(candidate.record.candidateId);
			this.pendingUpdates.delete(body.bodyId);
			if (candidateRecord) {
				const pending: PendingCandidate = {
					record: candidateRecord,
					submission: null,
					path: this.pathForBodyId(body.bodyId),
				};
				this.pendingCandidates.set(candidateRecord.candidateId, pending);
				this._lastCandidateCapturedAt = capturedAt;
				this._candidatePersistenceHealthy = true;
				void this.submitCandidate(pending).catch((error) => {
					this.log(`semantic epoch rebase remains pending for ${body.bodyId}: ${String(error)}`);
				});
			}
			await this.notifySemanticEpochReset({
				purpose: "body", documentId: body.bodyId,
				previousEpoch: body.bodyEpoch, currentEpoch: state.bodyEpoch,
			});
			return replacement;
		} catch (error) {
			if (!installed && session && consumers.length > 0 && this.bodies.get(body.bodyId) === body) {
				const restored = this.createBodySession(body);
				this.sessions.set(body.bodyId, restored);
				for (const consumerId of consumers) {
					const generation = (this.consumerGenerations.get(consumerId) ?? 0) + 1;
					this.consumerGenerations.set(consumerId, generation);
					const path = this.pathForBodyId(body.bodyId);
					if (path) this.attachEditorConsumer(path, body.bodyId, consumerId, generation, restored, body);
				}
			}
			throw error;
		} finally {
			if (!installed) transition.document.destroy();
		}
	}

	/**
	 * Deliver the editor/runtime integration hook without making an installed
	 * authoritative epoch depend on UI code. A failed hook is retried until it
	 * succeeds (or the runtime is destroyed), and a newer reset replaces an
	 * older retry for the same document.
	 */
	private async notifySemanticEpochReset(event: SemanticEpochResetEvent, attempt = 0): Promise<void> {
		const callback = this.options.onSemanticEpochReset;
		if (!callback || this.destroyed) return;
		const key = `${event.purpose}:${event.documentId}`;
		try {
			await Promise.resolve(callback(event));
			const timer = this.semanticEpochResetRetryTimers.get(key);
			if (timer !== undefined) window.clearTimeout(timer);
			this.semanticEpochResetRetryTimers.delete(key);
		} catch (error) {
			this.log(`semantic epoch integration failed; retrying: ${String(error)}`);
			const prior = this.semanticEpochResetRetryTimers.get(key);
			if (prior !== undefined) window.clearTimeout(prior);
			const delay = Math.min(5_000, 100 * (2 ** Math.min(attempt, 5)));
			const timer = window.setTimeout(() => {
				if (this.semanticEpochResetRetryTimers.get(key) !== timer) return;
				this.semanticEpochResetRetryTimers.delete(key);
				void this.notifySemanticEpochReset(event, attempt + 1);
			}, delay);
			this.semanticEpochResetRetryTimers.set(key, timer);
		}
	}

	private async recoverBodySemanticEpoch(bodyId: string, minimumEpoch: SemanticEpoch): Promise<LoadedBody> {
		const body = this.bodies.get(bodyId) ?? await this.loadBodyWithPriority(bodyId, "foreground", true);
		if (body.bodyEpoch >= minimumEpoch) return body;
		const state = await this.server.currentBody(bodyId);
		if (state.bodyId !== bodyId || state.bodyEpoch < minimumEpoch) {
			throw new Error(`body ${bodyId} semantic epoch recovery returned a stale baseline`);
		}
		await this.validateBodyStateIntegrity(state, state);
		if (state.bodyEpoch === body.bodyEpoch) return body;
		return this.rebaseBodyAcrossSemanticEpoch(body, state);
	}

	private async recoverRootSemanticEpoch(minimumEpoch: SemanticEpoch): Promise<void> {
		if (this._rootEpoch >= minimumEpoch) return;
		if (!this.server.currentRoot) throw new Error("root semantic epoch recovery is unavailable");
		const state = await this.server.currentRoot();
		if (state.rootEpoch < minimumEpoch || state.rootEpoch <= this._rootEpoch) {
			throw new Error("root semantic epoch recovery returned a stale baseline");
		}
		const previousEpoch = this._rootEpoch;
		const transition = prepareRootSemanticEpochTransition({
			previousRootEpoch: previousEpoch,
			nextRootEpoch: state.rootEpoch,
			authoritativeEncodedState: state.encodedState,
		});
		await this.options.database.putDocument({
			kind: "root", documentId: ROOT_DOCUMENT_ID, rootEpoch: transition.rootEpoch,
			generation: state.generation,
			encodedState: Y.encodeStateAsUpdate(transition.document).slice().buffer,
			dirty: false, pendingLocalUpdates: 0, updatedAt: this.now(),
		});
		const previousDocument = this.ydoc;
		const previousProvider = this.provider;
		this.socketLiveness.unregister(ROOT_DOCUMENT_ID);
		this.invalidateSocketSession(previousProvider);
		this.terminateProvider(previousProvider);
		previousProvider.awareness.destroy();
		previousProvider.destroy();
		this.ydoc = transition.document;
		this.pathToId = this.ydoc.getMap<string>("pathToId");
		this.pathToBlob = this.ydoc.getMap<BlobRef>("pathToBlob");
		this.pathToSemantic = this.ydoc.getMap<SemanticPathRef>("pathToSemantic");
		this.blobMeta = this.ydoc.getMap<BlobMeta>("blobMeta");
		this.blobTombstones = this.ydoc.getMap<BlobTombstone & { previousHash?: string | null }>("blobTombstones");
		this.meta = this.ydoc.getMap<unknown>("meta");
		this._rootEpoch = transition.rootEpoch;
		this._rootGeneration = state.generation;
		const factory = this.options.providerFactory ?? ((input) => this.createDefaultProvider(input));
		this.provider = factory({ kind: "root", documentId: ROOT_DOCUMENT_ID,
			documentEpoch: this._rootEpoch, doc: this.ydoc,
			onClose: (event) => this.handleNativeSocketClose(event) });
		this.registerSocketLiveness(ROOT_DOCUMENT_ID, this.provider);
		this.wireRootProvider();
		previousDocument.destroy();
		this.bodies.coordinator.replacePathBindings(this.pathToId.entries());
		this.canvases?.replaceCatalog(this.pathToSemantic.entries());
		const admission = await this.socketAdmission.admit(
			this.asAdmissionProvider(ROOT_DOCUMENT_ID, this.provider),
			"semantic-epoch-reset",
		);
		this.applyTerminalAdmissionOutcome(admission);
		if (admission.kind !== "completed") throw new Error(`root socket epoch admission failed: ${admission.kind}`);
		await this.notifySemanticEpochReset({
			purpose: "root", documentId: ROOT_DOCUMENT_ID,
			previousEpoch, currentEpoch: this._rootEpoch,
		});
		await Promise.resolve(this.options.onRemoteRootStructuralUpdate?.());
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
		if (head.bodyEpoch !== state.bodyEpoch) throw new Error("body response epoch mismatch");
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


	private async waitForBodySync(session: BodySession, body: LoadedBody, reopen = false): Promise<void> {
		if (session.provider.synced && session.provider.wsconnected && session.provider.ws?.readyState === 1) return;
		let timer: number | null = null;
		let onSync: ((value: boolean) => void) | null = null;
		const synced = new Promise<boolean>((resolve) => {
			onSync = (value) => { if (value) resolve(true); };
			session.provider.on("sync", onSync);
			timer = window.setTimeout(() => resolve(false), this.options.bodySyncTimeoutMs);
		});
		// Every call registers one listener; it must not outlive the wait
		// (warm reopens call this repeatedly on the same provider).
		const release = () => {
			if (timer) window.clearTimeout(timer);
			if (onSync) session.provider.off?.("sync", onSync);
			onSync = null;
		};
		try {
			const admission = await this.socketAdmission.admit(
				this.asAdmissionProvider(session.bodyId, session.provider),
				"body-open",
			);
			this.applyTerminalAdmissionOutcome(admission);
			if (admission.kind !== "completed") {
				throw new Error(`body socket admission failed: ${admission.kind}`);
			}
			const completed = await synced;
			// A warm reopen already holds local state; never tear its provider
			// down over a slow sync.
			if (!completed && !reopen && body.generation === 0 && !body.dirty) {
				session.provider.destroy();
				throw new Error(`body ${body.bodyId} did not establish current state`);
			}
		} finally {
			release();
		}
	}

	private async reconnectBodySession(session: BodySession, warm = false): Promise<void> {
		await this.withBodyAdmission(
			session.bodyId,
			warm ? "background" : "editor",
			true,
			warm ? "warm" : "active",
			async () => {
				const admission = await this.socketAdmission.admit(
					this.asAdmissionProvider(session.bodyId, session.provider),
					"body-reconnect",
				);
				this.applyTerminalAdmissionOutcome(admission);
				if (admission.kind !== "completed") throw new SocketAdmissionNotCompletedError(admission);
			},
		);
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
		void this.workScheduler.queueCandidate(
			bodyId,
			this.options.candidateDebounceMs,
			this.options.candidateMaxWaitMs,
		).catch((error) => {
			this.log(`candidate scheduling failed for ${bodyId}: ${String(error)}`);
		});
	}

	private async handleDurableBodyCommitted(
		notification: BodyCommittedNotification,
	): Promise<void> {
		const callback = this.options.onDurableBodyCommitted;
		if (callback) {
			try {
				await callback(notification);
			} catch (error) {
				this.log(`durable body settlement scheduling failed: ${String(error)}`);
			}
			return;
		}
		// b3 fix: a BODY_COMMITTED frame can arrive after destroy() stopped the
		// scheduler; queueBodyWake then rejects ("vault work scheduler is stopped")
		// and the caller's `void` turned it into an unhandled rejection.
		if (this.destroyed) return;
		const session = this.sessions.get(notification.bodyId);
		if (!session || !session.provider.synced || !session.provider.wsconnected
			|| session.provider.ws?.readyState !== 1) {
			try {
				await this.workScheduler.queueBodyWake(
					notification.bodyId,
					notification.durableGeneration,
					"background",
				);
				await this.workScheduler.whenIdle();
			} catch (error) {
				if (this.destroyed) return;
				throw error;
			}
		}
	}

	/**
	 * Runtime-independent change hint from a socket admitted by an earlier
	 * server runtime. Deliberately never a receipt, a durable promotion or a
	 * watermark: it only schedules catch-up, which verifies content itself.
	 */
	private handleBodyChangedHint(payload: string, expectedBodyId?: string): void {
		let value: unknown;
		try { value = JSON.parse(payload); } catch { return; }
		const hint = parseBodyChangedHintFrame(value);
		if (!hint || hint.vaultGeneration !== this.options.vaultGeneration) return;
		if (expectedBodyId !== undefined && hint.bodyId !== expectedBodyId) return;
		this.log(`body changed hint for ${hint.bodyId} (generation ${hint.durableGeneration})`);
		const callback = this.options.onBodyChangedHint
			?? (() => this.options.onRemoteRootStructuralUpdate?.());
		void Promise.resolve()
			.then(() => callback(hint))
			.catch((error) => this.log(`body changed hint catch-up scheduling failed: ${String(error)}`));
	}

	private handleBodySessionCommitted(session: BodySession, notification: BodyCommittedNotification): void {
		const socketSession = this.socketSessions.get(session.provider);
		if (this.sessions.get(session.bodyId) !== session
			|| notification.bodyId !== session.bodyId
			|| notification.vaultGeneration !== this.options.vaultGeneration
			|| !socketSession || notification.runtimeEpoch !== socketSession.runtimeEpoch
			|| notification.lifecycle !== "active"
			|| notification.contentHash === undefined || notification.contentHash === null
			|| notification.size === undefined || notification.size === null) return;
		if (!session.pendingCommitted
			|| notification.durableGeneration >= session.pendingCommitted.durableGeneration) {
			session.pendingCommitted = notification;
		}
		if (!session.provider.synced) return;
		const target = session.pendingCommitted;
		if (!target) return;
		session.watermarkWork = session.watermarkWork.catch(() => undefined).then(async () => {
			if (this.sessions.get(session.bodyId) !== session || !session.provider.synced) return;
			const current = session.pendingCommitted;
			if (!current) return;
			const body = this.bodies.get(session.bodyId);
			if (!body || body.doc !== session.doc) return;
			const head: BodyCurrentnessHead = {
				bodyId: current.bodyId,
				bodyEpoch: current.bodyEpoch,
				lifecycle: "active",
				generation: current.durableGeneration,
				contentHash: current.contentHash ?? null,
				size: current.size ?? null,
			};
			if (await this.promoteBodyFromCurrentness(body, head)
				&& session.pendingCommitted === current) session.pendingCommitted = null;
		}).catch((error) => {
			this.log(`body watermark persistence failed for ${session.bodyId}: ${String(error)}`);
		});
	}

	private handleVaultControl(
		payload: string,
		expectedDocumentId: string,
		provider: SyncProviderPort,
	): void {
		let frame: VaultControlFrame | null;
		try {
			frame = parseVaultControlFrame(payload);
		} catch (error) {
			frame = { type: "VAULT_ERROR", message: String(error) };
		}
		if (!frame) return;
		if (frame.type === "VAULT_READY") {
			const expectedEpoch = expectedDocumentId === ROOT_DOCUMENT_ID
				? this._rootEpoch
				: this.bodies.get(expectedDocumentId)?.bodyEpoch
					?? this.canvases?.bodyEpoch(expectedDocumentId) ?? undefined;
			if (frame.documentId !== expectedDocumentId
				|| frame.vaultGeneration !== this.options.vaultGeneration
				|| expectedEpoch === undefined
				|| frame.documentEpoch !== expectedEpoch) {
				this.invalidateSocketSession(provider);
				frame = { type: "VAULT_ERROR", message: "ready socket authority mismatch" };
			} else {
				const current = this.socketSessions.get(provider);
				if (current?.id !== frame.socketSessionId) this.invalidateSocketSession(provider);
				const session = current?.id === frame.socketSessionId
					? current
					: Object.freeze({
						id: frame.socketSessionId,
						runtimeEpoch: frame.runtimeEpoch,
						capabilities: frame.capabilities,
					});
				this.socketSessions.set(provider, session);
				this.socketLiveness.ready(expectedDocumentId, frame.liveness, frame.runtimeEpoch);
				this.backpressureLevel = 0;
				this.submissionPausedUntil = 0;
				if (frame.documentId === ROOT_DOCUMENT_ID) {
					this._rootGeneration = Math.max(this._rootGeneration, frame.durableGeneration);
				}
			}
		} else if (frame.type === "VAULT_PONG") {
			const expectedEpoch = expectedDocumentId === ROOT_DOCUMENT_ID
				? this._rootEpoch
				: this.bodies.get(expectedDocumentId)?.bodyEpoch
					?? this.canvases?.bodyEpoch(expectedDocumentId) ?? undefined;
			if (frame.documentId !== expectedDocumentId
				|| frame.vaultGeneration !== this.options.vaultGeneration
				|| frame.documentEpoch !== expectedEpoch) return;
			this.socketLiveness.acknowledge(expectedDocumentId, frame.probeId, frame.runtimeEpoch);
			this.options.onControlFrame?.(frame);
			return;
		} else if (frame.type === "SEMANTIC_EPOCH_RESET_REQUIRED") {
			const reset = frame;
			const purpose = expectedDocumentId === ROOT_DOCUMENT_ID ? "root" : "body";
			const canvasEpoch = purpose === "body" ? this.canvases?.bodyEpoch(expectedDocumentId) ?? null : null;
			const currentEpoch = purpose === "root"
				? this._rootEpoch
				: this.bodies.get(expectedDocumentId)?.bodyEpoch ?? canvasEpoch ?? undefined;
			if (frame.purpose !== purpose || frame.documentId !== expectedDocumentId
				|| currentEpoch === undefined || frame.receivedEpoch !== currentEpoch
				|| frame.expectedEpoch <= currentEpoch) return;
			this.invalidateSocketSession(provider);
			this.forceAbortProvider(expectedDocumentId, provider);
			const recovery = reset.purpose === "body" && canvasEpoch !== null
				? this.canvases!.recoverSemanticEpoch(reset.documentId, reset.expectedEpoch).then(() =>
					this.notifySemanticEpochReset({
						purpose: "body", documentId: reset.documentId,
						previousEpoch: canvasEpoch, currentEpoch: reset.expectedEpoch,
					}))
				: reset.purpose === "body"
					? this.recoverBodySemanticEpoch(reset.documentId, reset.expectedEpoch)
				: this.recoverRootSemanticEpoch(reset.expectedEpoch);
			void recovery.catch((error) => this.log(`${purpose} semantic epoch recovery failed: ${String(error)}`));
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
			const dailyLimit = parseDailyLimitSignal(frame, this.now());
			if (dailyLimit) this.tripDailyLimit(dailyLimit);
		}
		this.options.onControlFrame?.(frame);
	}

	setSocketLivenessForeground(foreground: boolean): void {
		this.socketLiveness.setForeground(foreground);
	}

	probeSocketLiveness(reason: string): void {
		this.socketLiveness.probeNow(reason);
	}

	private registerSocketLiveness(documentId: string, provider: SyncProviderPort, recover?: () => void): void {
		this.socketLiveness.register({
			id: documentId,
			documentId,
			isOpen: () => provider.wsconnected && provider.ws?.readyState === 1,
			sendProbe: (probeId) => {
				if (!provider.sendMessage) throw new Error("provider does not support protocol control messages");
				// YSyncProvider owns the single `__YPS:` transport prefix.
				provider.sendMessage(JSON.stringify({ type: "VAULT_PING", probeId }));
			},
			onFailure: (reason) => {
				this.log(`socket liveness failed for ${documentId}: ${reason}`);
				if (documentId === ROOT_DOCUMENT_ID) {
					this.canvases?.pauseLiveProviders();
					this.forceAbortProvider(ROOT_DOCUMENT_ID, this.provider);
					for (const session of this.sessions.values()) {
						this.forceAbortProvider(session.bodyId, session.provider);
					}
					for (const semantic of this.canvases?.activeProviders() ?? []) {
						this.forceAbortProvider(semantic.documentId, semantic.provider);
					}
					this.refreshResidencyObservations();
					this.requestReconnect(`socket-liveness:${documentId}:${reason}`);
					return;
				}
				this.forceAbortProvider(documentId, provider);
				this.refreshResidencyObservations();
				if (recover) {
					recover();
					return;
				}
				const session = this.sessions.get(documentId);
				if (!session || session.provider !== provider || session.consumers.size === 0) return;
				void this.reconnectBodySession(session).catch((error) => {
					this.log(`body liveness recovery failed for ${documentId}: ${String(error)}`);
					if (!this.destroyed && !this.fatalAuthError) {
						this.requestReconnect(`socket-liveness-fallback:${documentId}:${reason}`);
					}
				});
			},
		});
	}

	private forceAbortProvider(documentId: string, provider: SyncProviderPort): void {
		this.socketLiveness.disconnected(documentId);
		this.expectedDisconnects.add(provider);
		if (provider.forceAbort) provider.forceAbort();
		else {
			provider.disconnect();
			this.terminateProvider(provider);
		}
	}

	/**
	 * D8: Cloudflare's free-tier daily row limit. Hold submissions and every
	 * reconnect until the UTC reset (probing at most hourly), instead of the
	 * 1 s VAULT_ERROR pause that would retry writes all day.
	 */
	tripDailyLimit(info: DailyLimitInfo): void {
		const now = this.now();
		if (this.dailyLimit && now >= this.dailyLimit.resetAt) this.dailyLimitProbes = 0;
		this.dailyLimit = info;
		// b3-clientblob A4: one back-off step per probe round. Concurrent requests
		// answered 503 while this round's pause stands do not escalate it.
		if (now >= this.dailyLimitPausedUntil) {
			const until = dailyLimitBackoffUntil(info, now, this.dailyLimitProbes, this.options.dailyLimitProbeBaseMs);
			this.dailyLimitProbes++;
			this.dailyLimitPausedUntil = until;
			this.holdReconnectFloor(DAILY_LIMIT_FLOOR_KEY, until - now);
			this.log(`cloudflare daily limit (${info.kind}); backing off until ${new Date(until).toISOString()}`);
		}
		this.options.onDailyLimit?.(info);
	}

	/**
	 * b3-clientblob A4: the server committed a write for this device, so the
	 * rows-written limit no longer applies. Clear D8 (state, back-off, reconnect
	 * floor) and release parked submissions now rather than at the next probe.
	 */
	private noteDailyLimitWriteSucceeded(): void {
		if (!this.dailyLimit && this.dailyLimitPausedUntil === 0) return;
		this.dailyLimit = null;
		this.dailyLimitPausedUntil = 0;
		this.dailyLimitProbes = 0;
		this.reconnectFloors.delete(DAILY_LIMIT_FLOOR_KEY);
		this.log("cloudflare daily limit cleared: a write succeeded");
		for (const wake of Array.from(this.submissionWindowWakers)) wake();
	}

	/** The active daily-limit trip, or null once its reset time has passed. */
	getDailyLimitState(): DailyLimitInfo | null {
		if (this.dailyLimit && this.now() >= this.dailyLimit.resetAt) this.dailyLimit = null;
		return this.dailyLimit;
	}

	/**
	 * Waits out the VAULT_ERROR pause and the D8 daily-limit back-off (up to an
	 * hour). Cancellable: destroy() wakes every waiter so teardown never waits
	 * for the back-off (b3 fix: destroy() used to hang here via whenIdle()).
	 * b3-bulk hook: bulk create admission goes through here too
	 * (commitCreateAdmissionRequests), so it is held by the same back-off.
	 */
	private async waitForSubmissionWindow(): Promise<void> {
		for (;;) {
			if (this.destroyed) throw new Error("runtime destroyed during submission backoff");
			const remaining = Math.max(this.submissionPausedUntil, this.dailyLimitPausedUntil) - this.now();
			if (remaining <= 0) return;
			// Woken early (destroy, or a D8 clear): re-check rather than assume the window opened.
			await new Promise<void>((resolve) => {
				const wake = () => {
					window.clearTimeout(timer);
					this.submissionWindowWakers.delete(wake);
					resolve();
				};
				const timer = window.setTimeout(wake, remaining);
				this.submissionWindowWakers.add(wake);
			});
		}
	}

	private async captureCandidate(
		bodyId: string,
		encodedUpdate: Uint8Array,
		candidateId: string | undefined = crypto.randomUUID(),
		capturedLocalUpdates = 0,
		path?: string,
		encodedUpdates?: readonly Uint8Array[],
	): Promise<PendingCandidate> {
		if (!candidateId) throw new Error("candidateId is required");
		const candidateDigest = await sha256Hex(candidateDigestMaterial(encodedUpdates ?? [encodedUpdate]));
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
		const body = this.bodies.get(bodyId);
		if (!body) throw new Error(`cannot capture candidate for unloaded body ${bodyId}`);
		const record: CandidateRecord = {
			vaultId: this.options.vaultId,
			bodyId,
			bodyEpoch: body.bodyEpoch,
			previousBaseline: body.durableBaseline,
			pendingMarkdown: body.doc.getText(BODY_TEXT_NAME).toJSON(),
			candidateId,
			candidateDigest,
			encodedUpdate: encodedUpdate.slice().buffer,
			encodedUpdates: encodedUpdates?.map((update) => update.slice().buffer),
			capturedAt,
			capturedLocalUpdates,
			authority: this.captureAuthority(),
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
		if (this.unconfirmedCreates.has(candidate.record.bodyId)) {
			// D5: edits never reach the server before their file.
			throw new Error(`create of body ${candidate.record.bodyId} is unconfirmed; candidate held on device`);
		}
		if (!this.isCapturedAuthorityCurrent(candidate.record.authority)) {
			const recovered = await this.recoverCandidateOutcome(candidate);
			if (recovered) return recovered;
			this.noteAuthoritySuperseded("candidate", candidate.record.candidateId, candidate.record.authority);
			this.pendingCandidates.delete(candidate.record.candidateId);
			throw new Error("authority_superseded");
		}
		await this.waitForSubmissionWindow();
		if (!this.isCapturedAuthorityCurrent(candidate.record.authority)) {
			const recovered = await this.recoverCandidateOutcome(candidate);
			if (recovered) return recovered;
			this.noteAuthoritySuperseded("candidate", candidate.record.candidateId, candidate.record.authority);
			this.pendingCandidates.delete(candidate.record.candidateId);
			throw new Error("authority_superseded");
		}
		try {
			const receipt = await this.server.submitCandidate(candidate.record);
			return this.completeCandidateSubmission(candidate, receipt);
		} catch (error) {
			if (error instanceof VaultMutationRequestError && error.semanticMismatch
				&& error.semanticMismatch.purpose === "body"
				&& error.semanticMismatch.documentId === candidate.record.bodyId
				&& error.semanticMismatch.receivedEpoch === candidate.record.bodyEpoch) {
				await this.recoverBodySemanticEpoch(candidate.record.bodyId, error.semanticMismatch.expectedEpoch);
				throw new Error(`candidate ${candidate.record.candidateId} was rebased onto semantic epoch ${error.semanticMismatch.expectedEpoch}`);
			}
			const recovered = this.shouldQueryOperationOutcome(error) ? await this.recoverCandidateOutcome(candidate) : null;
			if (recovered) return recovered;
			throw error;
		}
	}

	private async completeCandidateSubmission(
		candidate: PendingCandidate,
		receipt: BodyReceipt,
	): Promise<BodyReceipt> {
		await this.awaitBodyPersistence(candidate.record.bodyId);
		this.validateReceipt(candidate.record, receipt);
		this.noteDailyLimitWriteSucceeded();
		await this.confirmPersistedCandidate(candidate.record, receipt);
		this.pendingCandidates.delete(candidate.record.candidateId);
		await this.bodies.markCandidateSettled(
			candidate.record.bodyId,
			receipt.bodyEpoch,
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
		await this.runResidencyMaintenance();
		return receipt;
	}

	private async submitPendingForBody(bodyId: string, mode: CandidateSubmitMode = "http"): Promise<void> {
		const candidates = Array.from(this.pendingCandidates.values())
			.filter((candidate) => candidate.record.bodyId === bodyId)
			.sort((left, right) => left.record.capturedAt - right.record.capturedAt);
		for (const candidate of candidates) {
			if (this.pendingCandidates.get(candidate.record.candidateId) !== candidate) continue;
			try {
				if (await this.confirmFromRelayIfCovered(candidate)) continue;
				if (mode === "defer" && this.isRelayDeferred(candidate)) {
					this.scheduleRelayFallback(candidate);
					continue;
				}
				if (mode === "await-relay" && candidate.relayMark && candidate.relayMark.channel.relayActive
					&& await this.waitForRelayConfirmation(candidate.relayMark, RELAY_SETTLE_WAIT_MS)
					&& await this.confirmFromRelayIfCovered(candidate)) continue;
				if (this.pendingCandidates.get(candidate.record.candidateId) !== candidate) continue;
				await this.submitCandidate(candidate);
			} catch (error) {
				this.log(`candidate ${candidate.record.candidateId} remains pending: ${String(error)}`);
				break;
			}
		}
	}

	/** The candidate waits for a socket receipt instead of an HTTP POST. */
	private isRelayDeferred(candidate: PendingCandidate): boolean {
		const mark = candidate.relayMark;
		if (!mark || candidate.submission) return false;
		const session = this.sessions.get(candidate.record.bodyId);
		return session?.relay === mark.channel
			&& mark.channel.relayActive
			&& this.now() - candidate.record.capturedAt < RELAY_HTTP_FALLBACK_MS;
	}

	private scheduleRelayFallback(candidate: PendingCandidate): void {
		const bodyId = candidate.record.bodyId;
		if (this.relayFallbackTimers.has(bodyId) || this.destroyed) return;
		const delay = Math.max(0, candidate.record.capturedAt + RELAY_HTTP_FALLBACK_MS - this.now());
		this.relayFallbackTimers.set(bodyId, this.relayClock.setTimer(() => {
			this.relayFallbackTimers.delete(bodyId);
			if (this.destroyed) return;
			if (![...this.pendingCandidates.values()].some((pending) => pending.record.bodyId === bodyId)) return;
			this.log(`relay receipt fallback: posting pending candidates for ${bodyId} over HTTP`);
			void this.workScheduler.queueCandidateNow(bodyId).catch((error) => {
				this.log(`relay fallback scheduling failed for ${bodyId}: ${String(error)}`);
			});
		}, delay));
	}

	private handleRelayActiveChanged(bodyId: string, channel: RelayReceiptChannel, active: boolean): void {
		if (active || this.destroyed) {
			if (active) this.log(`relay receipts active for ${bodyId}`);
			return;
		}
		this.settleRelayWaiters(channel);
		const deferred = [...this.pendingCandidates.values()]
			.some((candidate) => candidate.record.bodyId === bodyId && candidate.relayMark?.channel === channel);
		if (!deferred) return;
		// The socket that would deliver the receipt is gone: HTTP is the fallback.
		void this.workScheduler.queueCandidateNow(bodyId).catch((error) => {
			this.log(`relay fallback scheduling failed for ${bodyId}: ${String(error)}`);
		});
	}

	private handleRelayConfirmed(bodyId: string, channel: RelayReceiptChannel, _info: RelayReceiptInfo): void {
		for (const waiter of [...this.relayConfirmationWaiters]) {
			if (waiter.channel === channel && channel.confirmedSeq >= waiter.seq) {
				this.relayConfirmationWaiters.delete(waiter);
				waiter.resolve(true);
			}
		}
		const covered = [...this.pendingCandidates.values()]
			.filter((candidate) => candidate.record.bodyId === bodyId
				&& candidate.relayMark?.channel === channel
				&& candidate.relayMark.seq <= channel.confirmedSeq)
			.sort((left, right) => left.record.capturedAt - right.record.capturedAt);
		if (covered.length === 0) return;
		void (async () => {
			for (const candidate of covered) {
				try {
					await this.confirmFromRelayIfCovered(candidate);
				} catch (error) {
					this.log(`relay receipt did not settle candidate ${candidate.record.candidateId}: ${String(error)}`);
				}
			}
		})();
	}

	private waitForRelayConfirmation(mark: RelayMark, timeoutMs: number): Promise<boolean> {
		if (mark.channel.confirmedSeq >= mark.seq) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const waiter = {
				channel: mark.channel,
				seq: mark.seq,
				resolve: (confirmed: boolean) => {
					this.relayClock.clearTimer(timer);
					resolve(confirmed);
				},
			};
			const timer = this.relayClock.setTimer(() => {
				if (this.relayConfirmationWaiters.delete(waiter)) resolve(false);
			}, timeoutMs);
			this.relayConfirmationWaiters.add(waiter);
		});
	}

	/** Resolves waiters on `channel` (or every waiter for null) as unconfirmed. */
	private settleRelayWaiters(channel: RelayReceiptChannel | null): void {
		for (const waiter of [...this.relayConfirmationWaiters]) {
			if (channel !== null && waiter.channel !== channel) continue;
			this.relayConfirmationWaiters.delete(waiter);
			waiter.resolve(false);
		}
	}

	/**
	 * Settles a candidate from a relay receipt when the channel has confirmed
	 * every update it captured. The receipt is synthesized from the socket
	 * `BODY_COMMITTED` and goes through the same completion as an HTTP receipt.
	 */
	private async confirmFromRelayIfCovered(candidate: PendingCandidate): Promise<boolean> {
		const mark = candidate.relayMark;
		const info = mark?.channel.lastConfirmation;
		if (!mark || !info || mark.channel.confirmedSeq < mark.seq) return false;
		if (candidate.submission) {
			await candidate.submission.catch(() => undefined);
			return !this.pendingCandidates.has(candidate.record.candidateId);
		}
		if (this.pendingCandidates.get(candidate.record.candidateId) !== candidate) return true;
		if (info.vaultGeneration !== this.options.vaultGeneration
			|| info.bodyId !== candidate.record.bodyId
			|| info.bodyEpoch !== candidate.record.bodyEpoch
			|| !this.isCapturedAuthorityCurrent(candidate.record.authority)) return false;
		const receipt: BodyReceipt = {
			vaultId: candidate.record.vaultId,
			vaultGeneration: info.vaultGeneration,
			bodyId: candidate.record.bodyId,
			bodyEpoch: info.bodyEpoch as SemanticEpoch,
			clientId: candidate.record.authority?.deviceId ?? this.options.deviceId,
			candidateId: candidate.record.candidateId,
			candidateDigest: candidate.record.candidateDigest,
			durableGeneration: info.durableGeneration,
			runtimeEpoch: `relay:${info.commitRuntimeEpoch ?? info.runtimeEpoch}`,
		};
		const run = this.completeCandidateSubmission(candidate, receipt);
		candidate.submission = run;
		try {
			await run;
		} finally {
			if (candidate.submission === run) candidate.submission = null;
		}
		return true;
	}

	private validateReceipt(candidate: CandidateRecord, receipt: BodyReceipt): void {
		if (
			receipt.vaultId !== candidate.vaultId
			|| receipt.bodyId !== candidate.bodyId
			|| receipt.bodyEpoch !== candidate.bodyEpoch
			|| receipt.clientId !== this.options.deviceId
			|| receipt.candidateId !== candidate.candidateId
			|| receipt.candidateDigest !== candidate.candidateDigest
			|| !Number.isSafeInteger(receipt.durableGeneration)
			|| receipt.durableGeneration < 0
			|| receipt.vaultGeneration !== this.options.vaultGeneration
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
				if (!this.isCapturedAuthorityCurrent(record.authority)) {
					const candidate: PendingCandidate = { record, submission: null, path: this.pathForBodyId(record.bodyId) };
					if (await this.recoverCandidateOutcome(candidate)) continue;
					this.noteAuthoritySuperseded("candidate", record.candidateId, record.authority);
					continue;
				}
				this.pendingCandidates.set(record.candidateId, {
					record,
					submission: null,
					path: this.pathForBodyId(record.bodyId),
				});
				const body = await this.loadBodyWithPriority(record.bodyId, "background", true);
				this.bodies.markUnsettled(record.bodyId);
				body.dirty = true;
			}
			this._candidatePersistenceHealthy = true;
		} catch (error) {
			this.noteCandidatePersistenceFailure(error);
		}
	}

	private captureAuthority(): VaultAuthorityIdentity | undefined {
		return this.options.getAuthority?.();
	}

	private isCapturedAuthorityCurrent(captured: VaultAuthorityIdentity | undefined): boolean {
		const getAuthority = this.options.getAuthority;
		if (!getAuthority) return true;
		if (!captured) return false;
		try {
			return sameAuthorityIdentity(captured, getAuthority());
		} catch {
			return false;
		}
	}

	private noteAuthoritySuperseded(
		kind: "candidate" | "lifecycle" | "attachment",
		identity: string,
		authority: VaultAuthorityIdentity | undefined,
	): void {
		this.options.onAuthoritySuperseded?.(kind, identity, authority ?? null);
		this.log(`${kind} ${identity} preserved under superseded authority`);
	}

	private async exactCommittedOutcome(
		operationId: string,
		requestDigest: string,
		authority: VaultAuthorityIdentity | undefined,
	): Promise<CommittedOperationOutcome | null> {
		if (!authority || !this.server.committedOperationOutcome) return null;
		try {
			return await this.server.committedOperationOutcome({ operationId, requestDigest, authority });
		} catch (error) {
			this.log(`exact operation outcome remains unknown for ${operationId}: ${String(error)}`);
			return null;
		}
	}

	private shouldQueryOperationOutcome(error: unknown): boolean {
		if (!(error instanceof VaultMutationRequestError) && !(error instanceof AttachmentPublicationError)) return true;
		return error.status >= 500 || error.status === 401 || error.status === 403
			|| error.code === "authority_superseded" || error.code === "membership_revoked" || error.code === "device_revoked";
	}

	private async recoverCandidateOutcome(candidate: PendingCandidate): Promise<BodyReceipt | null> {
		const outcome = await this.exactCommittedOutcome(
			candidate.record.candidateId,
			candidate.record.candidateDigest,
			candidate.record.authority,
		);
		if (!outcome) return null;
		const body = await this.loadBodyWithPriority(candidate.record.bodyId, "background", true);
		if (!this.pendingCandidates.has(candidate.record.candidateId)) {
			this.pendingCandidates.set(candidate.record.candidateId, candidate);
			this.bodies.markUnsettled(candidate.record.bodyId);
		}
		const receipt: BodyReceipt = {
			vaultId: candidate.record.vaultId,
			vaultGeneration: this.options.vaultGeneration,
			bodyId: candidate.record.bodyId,
			bodyEpoch: candidate.record.bodyEpoch,
			clientId: candidate.record.authority?.deviceId ?? this.options.deviceId,
			candidateId: candidate.record.candidateId,
			candidateDigest: candidate.record.candidateDigest,
			durableGeneration: body.generation,
			runtimeEpoch: `outcome:${outcome.vaultSequence}`,
		};
		await this.completeCandidateSubmission(candidate, receipt);
		this.log(`candidate ${candidate.record.candidateId} settled from exact committed outcome`);
		return receipt;
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

	private lifecycleGroupKey(operation: StoredLifecycleOperation): string {
		return operation.batchId
			? `batch:${operation.batchId}`
			: `single:${operation.operationId}`;
	}

	private async restoreUnconfirmedCreates(): Promise<void> {
		const list = this.options.database.listLifecycleOperations;
		if (!list) return;
		for (const operation of await list.call(this.options.database)) {
			if (operation.kind === "create") this.unconfirmedCreates.set(operation.bodyId, operation.path);
		}
	}

	private async queueStoredLifecycleOperations(): Promise<void> {
		const list = this.options.database.listLifecycleOperations;
		if (!list) return;
		const operations = await list.call(this.options.database);
		const groupKeys = new Set(operations.map((operation) => this.lifecycleGroupKey(operation)));
		for (const groupKey of groupKeys) await this.workScheduler.queueLifecycleReplay(groupKey);
	}

	private async queueLifecycleReplaySafely(groupKey: string): Promise<void> {
		try {
			await this.workScheduler.queueLifecycleReplay(groupKey);
		} catch (error) {
			this.log(`lifecycle ${groupKey} remains reconstructible after scheduler handoff failed: ${String(error)}`);
		}
	}

	private async runLifecycleReplayWork(groupKey: string): Promise<OperationOutcome> {
		if (this.destroyed) return { kind: "cancelled" };
		const list = this.options.database.listLifecycleOperations;
		if (!list) return { kind: "permanently_blocked", failure: "local_persistence" };
		try {
			const operations = await list.call(this.options.database);
			const group = operations
				.filter((operation) => this.lifecycleGroupKey(operation) === groupKey)
				.sort((left, right) => (left.batchIndex ?? 0) - (right.batchIndex ?? 0));
			if (group.length === 0) return { kind: "completed", value: undefined };
			if (group.some((operation) => !this.isCapturedAuthorityCurrent(operation.authority))) {
				const requests = group.map((operation) => this.fromStoredLifecycleOperation(operation));
				const recovered = await this.recoverLifecycleReceipts(requests, group.map((operation) => operation.authority));
				if (this.destroyed) return { kind: "cancelled" };
				if (recovered) {
					try {
						await this.publishLifecycleRoot(requests, recovered);
						await this.deleteLifecycleGroup(group);
						return { kind: "completed", value: undefined };
					} catch (error) {
						this.log(`recovered lifecycle root publication remains pending: ${String(error)}`);
					}
				}
				for (const operation of group) this.noteAuthoritySuperseded("lifecycle", operation.operationId, operation.authority);
				return { kind: "decision_required", failure: "unauthorized" };
			}
			await this.retryLifecycleGroup(group);
			if (this.destroyed) return { kind: "cancelled" };
			const remaining = await list.call(this.options.database);
			return remaining.some((operation) => this.lifecycleGroupKey(operation) === groupKey)
				? { kind: "retryable_failure", failure: "network" }
				: { kind: "completed", value: undefined };
		} catch (error) {
			this.log(`lifecycle scheduler failed for ${groupKey}: ${String(error)}`);
			return { kind: "retryable_failure", failure: "local_persistence" };
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
		if (attempted.some((operation) => !this.isCapturedAuthorityCurrent(operation.authority))) {
			const requests = attempted.map((operation) => this.fromStoredLifecycleOperation(operation));
			const recovered = await this.recoverLifecycleReceipts(requests, attempted.map((operation) => operation.authority));
			if (recovered) {
				try {
					await this.publishLifecycleRoot(requests, recovered);
					await this.deleteLifecycleGroup(attempted);
					return;
				} catch (error) {
					this.log(`recovered lifecycle root publication remains pending: ${String(error)}`);
				}
			}
			for (const operation of attempted) this.noteAuthoritySuperseded("lifecycle", operation.operationId, operation.authority);
			return;
		}
		if (attempted.every((operation) => operation.kind === "create")) {
			await this.retryCreateGroup(attempted);
			return;
		}
		if (attempted.some((operation) => operation.kind === "create")) {
			// Pre-W2 mixed groups: creates are bulk-only now and must not ride a
			// structural batch. Leave them for an explicit decision.
			this.log("lifecycle replay remains pending: a structural group contains a create");
			return;
		}
		const requests = attempted.map((operation) => this.fromStoredLifecycleOperation(operation));
		try {
			if (this.destroyed) return;
			const receipts = await this.commitLifecycleRequests(requests);
			if (this.destroyed) return;
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
			if (error instanceof VaultMutationRequestError && error.semanticMismatch
				&& error.semanticMismatch.purpose === "body") {
				const mismatch = error.semanticMismatch;
				const stale = attempted.filter((operation) => operation.bodyId === mismatch.documentId
					&& operation.bodyEpoch === mismatch.receivedEpoch);
				if (stale.length > 0) {
					const body = await this.recoverBodySemanticEpoch(mismatch.documentId, mismatch.expectedEpoch);
					for (const operation of stale) {
						operation.bodyEpoch = body.bodyEpoch;
						await save.call(this.options.database, operation);
					}
					this.log(`lifecycle group rebound to body semantic epoch ${body.bodyEpoch}`);
					return;
				}
			}
			const recovered = this.shouldQueryOperationOutcome(error)
				? await this.recoverLifecycleReceipts(requests, attempted.map((operation) => operation.authority))
				: null;
			if (recovered) {
				try {
					await this.publishLifecycleRoot(requests, recovered);
					await this.deleteLifecycleGroup(attempted);
					this.log(`lifecycle group settled from exact committed outcomes`);
					return;
				} catch (publicationError) {
					this.log(`recovered lifecycle root publication remains pending: ${String(publicationError)}`);
				}
			}
			if (this.isRedundantRevive(error, attempted)) {
				await this.deleteLifecycleGroup(attempted);
				this.log("lifecycle replay dropped: the body is already revived at its path");
				return;
			}
			this.log(`lifecycle replay remains pending: ${String(error)}`);
		}
	}

	/**
	 * A revive answered `body_not_tombstoned` while the root already maps each
	 * revived path to that body: a concurrent revive committed and published
	 * first, so this one is settled, not pending (b3-int: two delete-revive
	 * paths on daemon restart left a revive replaying 409 forever, and startup
	 * publication never settled).
	 */
	private isRedundantRevive(
		error: unknown,
		operations: ReadonlyArray<{ kind: string; bodyId?: string | null; path?: string | null }>,
	): boolean {
		return error instanceof VaultMutationRequestError
			&& error.status === 409
			&& error.code === "body_not_tombstoned"
			&& operations.length > 0
			&& operations.every((operation) => operation.kind === "revive"
				&& !!operation.bodyId && !!operation.path
				&& this.getFileId(operation.path) === operation.bodyId);
	}

	private async recoverLifecycleReceipts(
		requests: readonly LifecycleRequest[],
		authorities: readonly (VaultAuthorityIdentity | undefined)[],
	): Promise<LifecycleReceipt[] | null> {
		if (requests.length !== authorities.length) return null;
		const outcomes = await Promise.all(requests.map(async (request, index) => this.exactCommittedOutcome(
			request.operationId,
			await operationRequestDigest(request),
			authorities[index],
		)));
		if (outcomes.some((outcome) => outcome === null)) return null;
		return outcomes.map((outcome, index) => ({
			vaultId: this.options.vaultId,
			vaultGeneration: this.options.vaultGeneration,
			bodyId: requests[index]!.bodyId,
			bodyEpoch: this.bodies.get(requests[index]!.bodyId)?.bodyEpoch ?? INITIAL_SEMANTIC_EPOCH,
			operationId: requests[index]!.operationId,
			kind: requests[index]!.kind,
			durableGeneration: this.bodies.get(requests[index]!.bodyId)?.generation ?? 0,
			vaultSequence: outcome!.vaultSequence,
			runtimeEpoch: `outcome:${outcome!.vaultSequence}`,
		}));
	}

	private async deleteLifecycleGroup(operations: readonly StoredLifecycleOperation[]): Promise<void> {
		if (operations.length > 1 && this.options.database.deleteLifecycleOperations) {
			await this.options.database.deleteLifecycleOperations(operations.map((operation) => operation.operationId));
			return;
		}
		for (const operation of operations) await this.options.database.deleteLifecycleOperation?.(operation.operationId);
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
			pending.record.bodyEpoch,
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
			bodyEpoch: request.bodyEpoch,
			path,
			previousPath: request.fromPath ?? null,
			content: null,
			...(request.candidateId ? { candidateId: request.candidateId } : {}),
			...(request.candidateDigest ? { candidateDigest: request.candidateDigest } : {}),
			createdAt: this.now(),
			attempts: 0,
			lastAttemptAt: null,
			authority: this.captureAuthority(),
		};
	}

	private fromStoredLifecycleOperation(operation: StoredLifecycleOperation): LifecycleRequest {
		return {
			operationId: operation.operationId,
			kind: operation.kind,
			fileId: operation.bodyId,
			bodyId: operation.bodyId,
			bodyEpoch: operation.bodyEpoch,
			path: operation.kind === "rename" ? undefined : operation.path,
			fromPath: operation.previousPath ?? undefined,
			toPath: operation.kind === "rename" ? operation.path : undefined,
			candidateId: operation.candidateId,
			candidateDigest: operation.candidateDigest,
		};
	}

	private async commitLifecycleRequests(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleReceipt[]> {
		await this.waitForSubmissionWindow();
		const batch = await this.server.commitLifecycleBatch(requests);
		this.noteDailyLimitWriteSucceeded();
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
		let rootUpdate = this.buildLifecycleRootUpdate(requests);
		let proof: RootPublicationReceipt;
		try {
			proof = await this.server.publishLifecycleRoot(operations, rootUpdate, this._rootEpoch);
		} catch (error) {
			if (!(error instanceof VaultMutationRequestError)
				|| error.semanticMismatch?.purpose !== "root"
				|| error.semanticMismatch.documentId !== ROOT_DOCUMENT_ID
				|| error.semanticMismatch.receivedEpoch !== this._rootEpoch) throw error;
			await this.recoverRootSemanticEpoch(error.semanticMismatch.expectedEpoch);
			rootUpdate = this.buildLifecycleRootUpdate(requests);
			proof = await this.server.publishLifecycleRoot(operations, rootUpdate, this._rootEpoch);
		}
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
			|| proof.rootEpoch !== this._rootEpoch
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
			if (safeMarkdownPath(path) !== path || !bodyId || this.pathToBlob.has(path) || this.pathToSemantic.has(path)) return path;
		}
		for (const [path, ref] of this.pathToBlob) {
			if (safeBlobPath(path, [], "", ref) !== path || this.pathToSemantic.has(path)) return path;
		}
		const semanticIds = new Set<string>();
		for (const [path, ref] of this.pathToSemantic) {
			if (safeCanvasPath(path) !== path || ref.kind !== "canvas" || ref.format !== "json-canvas"
				|| ref.formatVersion !== 1 || !ref.documentId || semanticIds.has(ref.documentId)) return path;
			semanticIds.add(ref.documentId);
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
			const proofs = next.getMap("__yaosLifecyclePublicationProof");
			for (const request of requests) proofs.set(request.operationId, true);
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
			|| receipt.bodyEpoch !== request.bodyEpoch
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
			kind: "root",
			documentId: ROOT_DOCUMENT_ID,
			rootEpoch: this._rootEpoch,
			generation: this._rootGeneration,
			encodedState: Y.encodeStateAsUpdate(this.ydoc).slice().buffer,
			dirty: false,
			updatedAt: this.now(),
		});
	}

	private createDefaultProvider(input: ProviderFactoryInput): SyncProviderPort {
		const prefix = input.kind === "root"
			? `/vault/${encodeURIComponent(this.options.vaultId)}/ws/root`
			: input.kind === "body"
				? `/vault/${encodeURIComponent(this.options.vaultId)}/ws/body/${encodeURIComponent(input.documentId)}`
				: `/vault/${encodeURIComponent(this.options.vaultId)}/ws/semantic/${encodeURIComponent(input.documentId)}`;
		const baseWebSocket = this.options.webSocket ?? WebSocket;
		const provider = new OwnAwarenessProvider(this.options.host, input.documentId, input.doc, {
			prefix,
			connect: false,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
			WebSocketPolyfill: fencedWebSocketConstructor(baseWebSocket, input.onClose, input.socketTap),
			params: async () => {
				if (!this.options.getSocketTicket) {
					throw new Error("a short-lived socket ticket is required");
				}
				const scope: SocketTicketScope = input.kind === "root"
					? { purpose: "root", documentId: ROOT_DOCUMENT_ID, rootEpoch: this._rootEpoch }
					: input.kind === "body"
						? { purpose: "body", documentId: input.documentId,
							bodyEpoch: this.bodies.get(input.documentId)?.bodyEpoch ?? input.documentEpoch }
						: { purpose: "semantic", documentId: input.documentId, bodyEpoch: input.documentEpoch };
				// Tickets are fetched lazily, only to open a socket. A root open
				// driven by an admission reuses the ticket that admission just
				// minted instead of fetching a second one.
				const ticket = (scope.purpose === "root" ? this.takeAdmissionRootTicket(scope.rootEpoch) : null)
					?? await this.options.getSocketTicket(scope);
				if (!ticket) throw new Error("socket ticket request returned no ticket");
				this.scheduleTicketExpiryCheck(ticket);
				return {
					ticket: ticket.value,
					schemaVersion: String(SCHEMA_VERSION),
					protocolVersion: String(PROTOCOL_VERSION),
					// Additive capability: lets the server keep this socket open
					// across a runtime wake and send BODY_CHANGED_HINT instead
					// of closing it on every commit.
					caps: SOCKET_CLIENT_CAPABILITY_CATCH_UP_HINT,
				};
			},
			awareness: input.kind === "root" ? undefined : new (this.providerAwarenessConstructor())(input.doc),
		});
		if (input.kind !== "root") provider.awareness.setLocalState(null);
		return adaptProvider(provider);
	}

	private providerAwarenessConstructor(): new (doc: Y.Doc) => Awareness {
		return this.provider.awareness.constructor as new (doc: Y.Doc) => Awareness;
	}

	/**
	 * Schedules the check that rescues providers stuck retrying with this
	 * ticket after it expires. It has its own scheduler slot so it can neither
	 * postpone a pending reconnect nor be erased by one, and it never replaces
	 * an open socket (see {@link TICKET_EXPIRY_CHECK_REASON}).
	 */
	private scheduleTicketExpiryCheck(ticket: SocketTicketResult): void {
		if (this.destroyed || this.fatalAuthError) return;
		const now = this.now();
		const remaining = ticket.localExpiresAt - now;
		const buffer = Math.min(ticketRefreshBufferMs(), Math.floor(remaining / 2));
		const dueAt = now + Math.max(250, remaining - buffer);
		void this.workScheduler.queueTicketExpiryCheck(TICKET_EXPIRY_CHECK_REASON, dueAt).catch((error) => {
			this.log(`ticket expiry check scheduling failed: ${String(error)}`);
		});
	}

	private takeAdmissionRootTicket(rootEpoch: SemanticEpoch): SocketTicketResult | null {
		const stashed = this.admissionRootTicket;
		this.admissionRootTicket = null;
		if (!stashed || stashed.rootEpoch !== rootEpoch
			|| !this.isCapturedAuthorityCurrent(stashed.authority)
			|| stashed.ticket.localExpiresAt - this.now() <= ticketRefreshBufferMs()) return null;
		return stashed.ticket;
	}

	private async refreshProviderTickets(force: boolean, epoch: OperationEpoch, opensRoot: boolean): Promise<SocketTicketResult> {
		if (!this.options.getSocketTicket) {
			return { value: "provider-factory", expiresAt: Number.MAX_SAFE_INTEGER, localExpiresAt: Number.MAX_SAFE_INTEGER, ttlMs: Number.MAX_SAFE_INTEGER };
		}
		if (this.destroyed || this.fatalAuthError || !epoch.isCurrent()) throw new Error("socket admission superseded");
		const ticket = await this.options.getSocketTicket({
			purpose: "root", documentId: ROOT_DOCUMENT_ID, rootEpoch: this._rootEpoch,
		}, force);
		if (this.destroyed || this.fatalAuthError || !epoch.isCurrent()) throw new Error("socket admission superseded");
		if (!ticket) throw new Error("socket ticket request returned no ticket");
		this.provider.url = patchTicketInUrl(this.provider.url, ticket.value);
		// Only an admission that opens root next (a full admission, or a root
		// provider admission) may hand this ticket to the root open. A body
		// admission's credential check (possibly a cached, already used root
		// ticket) must not leave one behind for an unrelated later root open.
		this.admissionRootTicket = opensRoot
			? { ticket, rootEpoch: this._rootEpoch, authority: this.captureAuthority() }
			: null;
		this.scheduleTicketExpiryCheck(ticket);
		return ticket;
	}

	private requestReconnect(reason: string, delayMs?: number): void {
		if (this.destroyed || this.fatalAuthError) return;
		if (this.reconnectRequester) this.reconnectRequester(reason, delayMs);
		else void this.queueReconnect(reason, delayMs ?? 0);
	}

	private asAdmissionProvider(id: string, provider: SyncProviderPort): SocketAdmissionProvider {
		return {
			id,
			get connected() { return provider.wsconnected && provider.ws?.readyState === 1; },
			get connecting() { return provider.wsconnecting; },
			disconnect: () => {
				// The close of a live socket surfaces later as a `disconnected`
				// status. The admission is already replacing it, so that status
				// must not request a second admission (and a second ticket).
				if (provider.wsconnected) this.expectedDisconnects.add(provider);
				provider.disconnect();
			},
			connect: async () => {
				if (!await this.waitForSocketRelease(provider)) {
					// y-partyserver cannot open a new socket while the old one
					// is still closing, so a connect() now would be a silent
					// no-op and the admission would report a socket that does
					// not exist. Fail retryably; the scheduler retries.
					throw new Error("socket admission timed out waiting for the previous socket to close");
				}
				await provider.connect();
			},
		};
	}

	/**
	 * y-partyserver only opens a new socket once the previous one has fully
	 * closed (`ws === null`); before that `connect()` is a silent no-op and the
	 * admission would complete without a socket. Wait, bounded, for the close.
	 * Returns false when the previous socket is still there at the deadline.
	 */
	private async waitForSocketRelease(provider: SyncProviderPort): Promise<boolean> {
		if (!provider.ws) return true;
		const deadline = this.now() + ADMISSION_SOCKET_RELEASE_TIMEOUT_MS;
		let polls = Math.ceil(ADMISSION_SOCKET_RELEASE_TIMEOUT_MS / ADMISSION_SOCKET_RELEASE_POLL_MS);
		while (provider.ws && !this.destroyed && polls-- > 0 && this.now() < deadline) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, ADMISSION_SOCKET_RELEASE_POLL_MS));
		}
		return !provider.ws;
	}

	private classifySocketAdmissionFailure(error: unknown): SocketAdmissionFailure {
		if (error instanceof SocketTicketHttpError) {
			if (error.status === 429) return { failure: "rate_limited", terminal: false, retryAfterMs: error.retryAfterMs };
			if (error.status === 401) return { failure: "unauthorized", terminal: true };
			if (error.status === 403) return { failure: "revoked", terminal: true };
			if (error.status === 404 || error.status === 426) return { failure: "incompatible_protocol", terminal: true };
			if (error.status >= 500) return { failure: "network", terminal: false };
			return { failure: "malformed_response", terminal: true };
		}
		if (error instanceof Error && /malformed|no ticket/.test(error.message)) {
			return { failure: "malformed_response", terminal: true };
		}
		return { failure: "network", terminal: false };
	}

	private applyTerminalAdmissionOutcome(outcome: OperationOutcome): void {
		if (outcome.kind !== "permanently_blocked" || this.fatalAuthError) return;
		let code: FatalSyncCode;
		if (outcome.failure === "unauthorized" || outcome.failure === "revoked") {
			code = "unauthorized";
		} else if (outcome.failure === "incompatible_protocol") {
			code = "update_required";
		} else {
			code = "server_misconfigured";
		}
		this.setFatalAuth(code, {
			clientSchemaVersion: SCHEMA_VERSION,
			roomSchemaVersion: null,
			reason: `socket_admission_${outcome.failure}`,
		});
	}

	private findSessionBodyForConsumer(consumerId: string): string | undefined {
		for (const [bodyId, session] of this.sessions) {
			if (session.consumers.has(consumerId)) return bodyId;
		}
		return undefined;
	}

	private terminateProvider(provider: SyncProviderPort): void {
		if (provider.forceAbort) {
			provider.forceAbort();
			return;
		}
		provider.disconnect();
		if (typeof provider.ws?.terminate === "function") provider.ws.terminate();
		else if (typeof provider.ws?.close === "function") provider.ws.close();
	}

	getRecentEvents(limit = 120): Array<{ ts: string; msg: string }> {
		return limit > 0 ? this.recentEvents.slice(-limit) : [];
	}

	private now(): number { return this.options.workClock?.now() ?? this.options.now?.() ?? Date.now(); }
	private log(message: string): void {
		this.recentEvents.push({ ts: new Date(this.now()).toISOString(), msg: message });
		if (this.recentEvents.length > 600) {
			this.recentEvents.splice(0, this.recentEvents.length - 600);
		}
		this.options.log?.(message);
	}
}
