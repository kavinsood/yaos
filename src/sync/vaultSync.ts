import * as Y from "yjs";
import { canonicalizeMarkdown } from "@shared/markdownCodec";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "@shared/binaryEnvelope";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "@shared/socketCloseCodes";
import {
	SOCKET_LIVENESS_IDLE_MS,
	SOCKET_LIVENESS_TIMEOUT_MS,
	parseBodyCurrentnessResultFrame,
	parseSocketControlCapabilities,
	parseSocketLivenessDescriptor,
	parseSocketSessionId,
	parseVaultPongFrame,
	type BodyCurrentnessHead,
	type BodyCurrentnessResultFrame,
	type SocketControlCapabilities,
	type SocketLivenessDescriptor,
} from "@shared/socketLiveness";
import YSyncProvider from "y-partyserver/provider";
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
import { patchTicketInUrl, SocketTicketHttpError, TICKET_REFRESH_BUFFER_MS, type SocketTicketScope } from "./socketTicket";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "./schema";
import type { AttachmentHead, BlobMeta, BlobRef, BlobTombstone, SemanticPathRef } from "../types";
import { applyDiffToYText, tryApplyDiffToYText } from "./diff";
import { safeBlobPath, safeCanvasPath, safeMarkdownPath } from "./pathPolicy";
import { ORIGIN_DISK_COMMIT } from "./origins";

import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import { RuntimeScope, type OperationEpoch, type OperationOutcome } from "../runtime/operationLifecycle";
import { BodyCoordinator, type BodyLease } from "./bodyCoordinator";
import {
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
import { VaultWorkScheduler } from "./vaultWorkScheduler";
import { FrontmatterSemanticMirror } from "./frontmatterSemanticMirror";
import {
	SocketLivenessCoordinator,
	type SocketLivenessSnapshot,
} from "../runtime/socketLivenessCoordinator";
import { fencedWebSocketConstructor, type NativeSocketClose } from "./fencedWebSocket";
import { sameAuthorityIdentity, type VaultAuthorityIdentity } from "../collaboration/authority";
import { CanvasManager, type CanvasPersistencePort, type CanvasProjectionPort } from "./canvas/canvasManager";
import { CanvasHttpTransport } from "./canvas/canvasTransport";
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
export type CurrentBodyCandidateOutcome =
	| { kind: "completed"; receipt: BodyReceipt }
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
		readonly semanticMismatch: SemanticEpochMismatchPayload | null = null) {
		super(`${operation} failed (${status}: ${code})`);
		this.name = "VaultMutationRequestError";
	}
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
	commitLifecycle(request: LifecycleRequest): Promise<LifecycleReceipt>;
	commitCreateAdmissionsBatch?(
		requests: readonly LifecycleRequest[],
	): Promise<LifecycleBatchReceipt>;
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
	bodySyncTimeoutMs?: number;
	candidateMaxWaitMs?: number;
	now?: () => number;
	workClock?: OverdueWorkClock;
	workRandom?: OverdueWorkRandom;
	log?: (message: string) => void;
	onRemoteRootStructuralUpdate?: () => void | Promise<void>;
	onAttachmentReconciliationRequired?: (
		paths: readonly string[],
		reason: "revision-mismatch",
	) => void | Promise<void>;
	onDurableBodyCommitted?: (
		notification: BodyCommittedNotification,
	) => void | Promise<void>;
	onProductEvent?: (event: ProductFlightPathEventInput) => void;
	onControlFrame?: (frame: VaultControlFrame) => void;
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

function mutationRequestError(response: { status: number; json?: unknown }, operation: string): VaultMutationRequestError {
	const value = response.json;
	const code = value && typeof value === "object" && "error" in value && typeof value.error === "string"
		? value.error
		: "request_failed";
	return new VaultMutationRequestError(
		response.status,
		code,
		operation,
		parseSemanticEpochMismatchPayload(value),
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
	};
}

/** Authenticated production HTTP adapter for currentness checks and durable candidates. */
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
		const response = await this.request({
			url: `${this.route("body")}/${encodeURIComponent(record.bodyId)}/candidate`,
			method: "POST",
			contentType: "application/octet-stream",
			body: record.encodedUpdate,
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

	async commitLifecycle(request: LifecycleRequest): Promise<LifecycleReceipt> {
		const response = await this.request({
			url: this.route("lifecycle"),
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify(request),
			headers: this.headers(),
		});
		if (response.status !== 200) throw mutationRequestError(response, "lifecycle commit");
		return response.json as LifecycleReceipt;
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
}

/**
 * Canonical client runtime. Root synchronization and awareness remain on one
 * provider; open Markdown bodies own ordinary reference-counted providers.
 */
export class VaultSync implements SyncRuntimePort {
	ydoc = new Y.Doc({ guid: ROOT_DOCUMENT_ID });
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
	private readonly pendingUpdates = new Map<string, Uint8Array[]>();
	private readonly bodyPersistenceWork = new Map<string, Promise<void>>();
	private readonly attachmentOperations = new Map<string, StoredAttachmentPublicationOperation>();
	private readonly attachmentOperationDurability = new Map<string, Promise<StoredAttachmentPublicationOperation>>();
	private readonly attachmentTerminalOutcomes = new Map<string, AttachmentIntentOutcome>();
	private readonly attachmentOutcomeWaiters = new Set<string>();
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
	private readonly expectedLivenessDisconnects = new WeakSet<SyncProviderPort>();
	private readonly residencyAdmission: ResidencyAdmissionCoordinator;
	private readonly residencyRuntime: ResidencyAdmissionRuntime;
	private readonly workScheduler: VaultWorkScheduler;
	private readonly residencyObservedBodyIds = new Set<string>();
	private reconnectRequester: ((reason: string) => void) | null = null;
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
			candidateDebounceMs: options.candidateDebounceMs ?? DEFAULT_CANDIDATE_DEBOUNCE_MS,
			candidateMaxWaitMs: options.candidateMaxWaitMs ?? DEFAULT_CANDIDATE_MAX_WAIT_MS,
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
		this.server = options.server ?? new VaultSyncHttpPort(
			options.host,
			options.vaultId,
			options.token,
			options.request,
		);
		const factory = options.providerFactory ?? ((input: ProviderFactoryInput) => this.createDefaultProvider(input));
		const canvasDatabase = this.canvasPersistence(options.database);
		this.canvases = canvasDatabase && options.canvasProjection ? new CanvasManager(
			options.vaultGeneration,
			canvasDatabase,
			new CanvasHttpTransport(options.host, options.vaultId, options.token, options.request),
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
		this.socketAdmission = new SocketAdmissionCoordinator({
			scope: this.runtimeScope,
			refreshCredential: async (epoch, force) => {
				const ticket = await this.refreshProviderTickets(force, epoch);
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
		this.socketLiveness = new SocketLivenessCoordinator(workClock);
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
			this.workScheduler.diagnostics().queue.some((item) => item.key !== "reconnect")
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
			if (
				request.kind === "create"
				&& (!request.candidateId || !request.candidateDigest)
			) {
				throw new Error("fresh create requires an exact candidate fence");
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
	 * Creates a fresh identity without publishing it empty: local lifecycle and
	 * candidate records first, durable server admission second, durable body
	 * receipt third, and root publication last.
	 */
	async commitFreshBody(
		input: FreshBodyCommitInput,
	): Promise<FreshBodyCommitResult> {
		input = { ...input, content: canonicalizeMarkdown(input.content) };
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
			bodyEpoch: INITIAL_SEMANTIC_EPOCH,
			path: input.path,
		};
		const storedOperation: StoredLifecycleOperation = {
			...this.toStoredLifecycleOperation(request),
			content: input.content,
		};
		await save.call(this.options.database, storedOperation);
		try {
		if (input.admissionStillCurrent?.() === false) {
			await remove.call(this.options.database, operationId);
			throw new FreshAdmissionCancelledError(input.path);
		}
		let pending = this.pendingCandidates.get(input.candidateId);
		if (pending && pending.record.bodyId !== input.bodyId) {
			throw new Error("candidate ID belongs to a different body");
		}
		if (!pending) {
			const body = await this.loadBodyWithPriority(input.bodyId, "foreground");
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
			this.ensureSemanticMirror(body).seedCurrent();
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
		let admissionReceipt: LifecycleReceipt;
		try {
			admissionReceipt = await this.server.commitLifecycle(request);
		} catch (error) {
			if (this.isCreationPathSuperseded(error)) {
				await this.cancelFreshAdmission(pending, operationId);
				throw new FreshAdmissionCancelledError(input.path);
			}
			throw error;
		}
		this.validateLifecycleReceipt(request, admissionReceipt);
		if (input.admissionStillCurrent?.() === false) {
			await this.cancelFreshAdmission(pending, operationId);
			throw new FreshAdmissionCancelledError(input.path);
		}
		const receipt = await this.submitCandidate(pending);
		await save.call(this.options.database, {
			...storedOperation,
			candidateId: request.candidateId,
			candidateDigest: request.candidateDigest,
			content: null,
		});
		let lifecycleReceipt: LifecycleReceipt;
		try {
			lifecycleReceipt = await this.server.commitLifecycle(request);
		} catch (error) {
			if (this.isCreationPathSuperseded(error)) {
				await this.retireSupersededCreations([{
					...storedOperation,
					candidateId: request.candidateId,
					candidateDigest: request.candidateDigest,
					content: null,
				}]);
				throw new FreshAdmissionCancelledError(input.path);
			}
			throw error;
		}
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
		} catch (error) {
			if (error instanceof FreshAdmissionCancelledError) throw error;
			await this.queueLifecycleReplaySafely(`single:${operationId}`);
			throw new FreshAdmissionDurablyPendingError(input.path, operationId, error);
		}
	}

	/**
	 * Initial import path: one bounded admission request, one candidate request,
	 * one lifecycle readback, and one root publication for the whole batch.
	 * Durable local operations remain resumable if any network step fails.
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
		try {
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
				bodyEpoch: INITIAL_SEMANTIC_EPOCH,
				path: input.path,
			};
			await save.call(this.options.database, {
				...this.toStoredLifecycleOperation(request),
				content: input.content,
				batchId,
				batchIndex: index,
			});
			const body = await this.loadBodyWithPriority(input.bodyId, "background");
			const text = body.doc.getText(BODY_TEXT_NAME);
			const before = Y.encodeStateVector(body.doc);
			applyDiffToYText(text, text.toJSON(), input.content, ORIGIN_DISK_COMMIT);
			this.ensureSemanticMirror(body).seedCurrent();
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
		} catch (error) {
			await this.queueLifecycleReplaySafely(`batch:${batchId}`);
			throw error;
		}
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
		if (lifecycle === "revive") {
			await this.commitLifecycle({
				operationId: crypto.randomUUID(),
				kind: "revive",
				fileId: input.bodyId,
				bodyId: input.bodyId,
				bodyEpoch: await this.currentBodyEpoch(input.bodyId),
				path: input.path,
			});
		}
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
		await this.flushBodyCandidate(bodyId);
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

	async flushBodyCandidate(bodyId: string): Promise<void> {
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
				throw error;
			}
		}
		await this.submitPendingForBody(bodyId);
	}

	async retryPendingCandidates(): Promise<void> {
		const bodyIds = new Set(Array.from(this.pendingCandidates.values(), (candidate) => candidate.record.bodyId));
		for (const bodyId of bodyIds) await this.submitPendingForBody(bodyId);
	}

	async reconnect(reason = "explicit"): Promise<OperationOutcome> {
		const outcome = await this.runReconnectWork(reason);
		if (outcome.kind === "retryable_failure" && !this.destroyed && !this.fatalAuthError) {
			const delayMs = outcome.retryAfterMs ?? TICKET_REFRESH_BUFFER_MS;
			await this.workScheduler.queueReconnect(`retry:${reason}`, this.now() + delayMs);
		}
		return outcome;
	}

	queueReconnect(reason: string, delayMs = 0, maxWaitMs?: number): Promise<void> {
		const now = this.now();
		return this.workScheduler.queueReconnect(
			reason,
			now + Math.max(0, delayMs),
			maxWaitMs === undefined ? undefined : now + Math.max(0, maxWaitMs),
		);
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
		const outcome = await this.socketAdmission.request(reason);
		this.applyTerminalAdmissionOutcome(outcome);
		if (outcome.kind === "completed") {
			this.canvases?.resumeLiveProviders();
			for (const session of this.sessions.values()) {
				if (session.consumers.size === 0
					|| (session.provider.wsconnected && session.provider.ws?.readyState === 1)) continue;
				try {
					await this.reconnectBodySession(session);
				} catch (error) {
					this.log(`body reconnect failed for ${session.bodyId}: ${String(error)}`);
					if (!this.destroyed && !this.fatalAuthError) {
						return { kind: "retryable_failure", failure: "network" };
					}
				}
			}
			for (const { documentId, provider } of this.canvases?.activeProviders() ?? []) {
				if (provider.wsconnected || provider.wsconnecting) continue;
				this.canvases?.reconnectLive(documentId);
			}
		}
		return outcome;
	}

	private async runCandidateWork(bodyId: string): Promise<OperationOutcome> {
		if (this.destroyed) return { kind: "cancelled" };
		try {
			await this.flushBodyCandidate(bodyId);
			const remainsPending = [...this.pendingCandidates.values()]
				.some((candidate) => candidate.record.bodyId === bodyId);
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

	setReconnectRequester(requester: ((reason: string) => void) | null): void {
		this.reconnectRequester = requester;
	}

	setReconnectBlocked(blocked: (() => boolean) | null): void {
		this.reconnectBlocked = blocked;
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
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
		}
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
				this.expectedLivenessDisconnects.delete(provider);
				this.invalidateSocketSession(provider);
				this.socketLiveness.connected(ROOT_DOCUMENT_ID);
				this._connectionGeneration++;
				this.workScheduler.poke("root-connected");
			} else if (status === "disconnected" && this.expectedLivenessDisconnects.delete(provider)) {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(ROOT_DOCUMENT_ID);
			} else if (status === "disconnected" && !this.fatalAuthError && !this.socketAdmission.isAttempting) {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(ROOT_DOCUMENT_ID);
				provider.disconnect();
				this.requestReconnect("root-disconnected");
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
			const committed = asBodyCommittedNotification(payload);
			const session = this.socketSessions.get(provider);
			if (committed && session
				&& committed.vaultGeneration === this.options.vaultGeneration
				&& committed.runtimeEpoch === session.runtimeEpoch) {
				void this.handleDurableBodyCommitted(committed);
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
		const provider = factory({ kind: "body", documentId: body.bodyId,
			documentEpoch: body.bodyEpoch, doc: body.doc,
			onClose: (event) => this.handleNativeSocketClose(event) });
		this.registerSocketLiveness(body.bodyId, provider);
		const lifetimeLease = this.bodies.acquireLease(body.bodyId);
		let session!: BodySession;
		const handleControl = (payload: string) => {
			this.handleVaultControl(payload, body.bodyId, provider);
			this.handleCurrentnessResult(payload, provider);
			const committed = asBodyCommittedNotification(payload);
			if (committed) this.handleBodySessionCommitted(session, committed);
		};
		provider.on("custom-message", handleControl);
		provider.on("status", ({ status }) => {
			if (status === "connected") {
				this.expectedLivenessDisconnects.delete(provider);
				this.invalidateSocketSession(provider);
				this.socketLiveness.connected(body.bodyId);
			} else if (status === "disconnected" && this.expectedLivenessDisconnects.delete(provider)) {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(body.bodyId);
			} else if (status === "disconnected" && !this.fatalAuthError && !this.socketAdmission.isAttempting) {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(body.bodyId);
				provider.disconnect();
				if ((this.sessions.get(body.bodyId)?.consumers.size ?? 0) > 0) {
					this.requestReconnect(`body-disconnected:${body.bodyId}`);
				}
			} else if (status === "disconnected") {
				this.invalidateSocketSession(provider);
				this.socketLiveness.disconnected(body.bodyId);
			}
		});
		const updateObserver = (update: Uint8Array, origin: unknown) => {
			if (origin === provider.documentOrigin) {
				this._lastRemoteUpdateAt = this.now();
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


	private async waitForBodySync(session: BodySession, body: LoadedBody): Promise<void> {
		if (session.provider.synced && session.provider.wsconnected && session.provider.ws?.readyState === 1) return;
		let timer: number | null = null;
		const synced = new Promise<boolean>((resolve) => {
			session.provider.on("sync", (value) => { if (value) resolve(true); });
			timer = window.setTimeout(() => resolve(false), this.options.bodySyncTimeoutMs);
		});
		const admission = await this.socketAdmission.admit(
			this.asAdmissionProvider(session.bodyId, session.provider),
			"body-open",
		);
		this.applyTerminalAdmissionOutcome(admission);
		if (admission.kind !== "completed") {
			if (timer) window.clearTimeout(timer);
			throw new Error(`body socket admission failed: ${admission.kind}`);
		}
		const completed = await synced;
		if (timer) window.clearTimeout(timer);
		if (!completed && body.generation === 0 && !body.dirty) {
			session.provider.destroy();
			throw new Error(`body ${body.bodyId} did not establish current state`);
		}
	}

	private async reconnectBodySession(session: BodySession): Promise<void> {
		await this.withBodyAdmission(
			session.bodyId,
			"editor",
			true,
			"active",
			async () => {
				const admission = await this.socketAdmission.admit(
					this.asAdmissionProvider(session.bodyId, session.provider),
					"body-reconnect",
				);
				this.applyTerminalAdmissionOutcome(admission);
				if (admission.kind !== "completed") {
					throw new Error(`body socket admission failed: ${admission.kind}`);
				}
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
		const session = this.sessions.get(notification.bodyId);
		if (!session || !session.provider.synced || !session.provider.wsconnected
			|| session.provider.ws?.readyState !== 1) {
			await this.workScheduler.queueBodyWake(
				notification.bodyId,
				notification.durableGeneration,
				"background",
			);
			await this.workScheduler.whenIdle();
		}
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
		this.expectedLivenessDisconnects.add(provider);
		if (provider.forceAbort) provider.forceAbort();
		else {
			provider.disconnect();
			this.terminateProvider(provider);
		}
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
		const requests = attempted.map((operation) => this.fromStoredLifecycleOperation(operation));
		try {
			for (let index = 0; index < attempted.length; index++) {
				const operation = attempted[index]!;
				if (operation.kind !== "create" || operation.content === null) continue;
				const request = requests[index]!;
				let pending = Array.from(this.pendingCandidates.values()).find(
					(candidate) => candidate.record.bodyId === operation.bodyId
						&& (!operation.candidateId || candidate.record.candidateId === operation.candidateId),
				);
				if (!pending) {
					const body = await this.loadBodyWithPriority(operation.bodyId, "background", true);
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
				operation.candidateId = pending.record.candidateId;
				operation.candidateDigest = pending.record.candidateDigest;
				await save.call(this.options.database, operation);
			}
			if (this.destroyed) return;
			const receipts = await this.commitLifecycleRequests(requests);
			if (this.destroyed) return;
			for (const operation of attempted) {
				if (this.destroyed) return;
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
				if (this.destroyed) return;
				const operation = attempted[index]!;
				if (operation.kind !== "create" || operation.content === null) continue;
				const finalReceipt = await this.server.commitLifecycle(requests[index]!);
				this.validateLifecycleReceipt(requests[index]!, finalReceipt);
				if (finalReceipt.vaultSequence < receipts[index]!.vaultSequence) {
					throw new Error("fresh lifecycle final sequence regressed");

				}
				receipts[index] = finalReceipt;
			}
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
						if (operation.kind === "create") {
							// The candidate belongs to the retired CRDT lineage.  The next
							// replay binds the same semantic lifecycle intent to the fresh
							// epoch's persisted rebase candidate.
							delete operation.candidateId;
							delete operation.candidateDigest;
						}
						await save.call(this.options.database, operation);
					}
					this.log(`lifecycle group rebound to body semantic epoch ${body.bodyEpoch}`);
					return;
				}
			}
			if (this.isCreationPathSuperseded(error)
				&& attempted.every((operation) => operation.kind === "create")) {
				await this.retireSupersededCreations(attempted);
				this.log("superseded creation lifecycle was retired after authoritative path ownership changed");
				return;
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
			this.log(`lifecycle replay remains pending: ${String(error)}`);
		}
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

	private isCreationPathSuperseded(error: unknown): boolean {
		return error instanceof VaultMutationRequestError
			&& error.status === 409
			&& error.code === "creation_path_superseded";
	}

	private async retireSupersededCreations(
		operations: readonly StoredLifecycleOperation[],
	): Promise<void> {
		for (const operation of operations) {
			const pending = Array.from(this.pendingCandidates.values()).find(
				(candidate) => candidate.record.bodyId === operation.bodyId
					&& (!operation.candidateId || candidate.record.candidateId === operation.candidateId),
			);
			if (pending) {
				await this.cancelFreshAdmission(pending, operation.operationId);
				continue;
			}
			const loaded = this.bodies.get(operation.bodyId);
			if (loaded && !loaded.dirty && loaded.unsettled === 0
				&& loaded.pendingLocalUpdates === 0 && loaded.pins === 0) {
				this.bodies.discardTransient(operation.bodyId);
			}
			await this.options.database.deleteDocument?.(operation.bodyId);
			await this.options.database.deleteLifecycleOperation?.(operation.operationId);
		}
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
		const provider = new YSyncProvider(this.options.host, input.documentId, input.doc, {
			prefix,
			connect: false,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
			WebSocketPolyfill: fencedWebSocketConstructor(baseWebSocket, input.onClose),
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
				const ticket = await this.options.getSocketTicket(scope);
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
		if (input.kind !== "root") provider.awareness.setLocalState(null);
		return adaptProvider(provider);
	}

	private providerAwarenessConstructor(): new (doc: Y.Doc) => Awareness {
		return this.provider.awareness.constructor as new (doc: Y.Doc) => Awareness;
	}

	private scheduleTicketRefresh(ticket: SocketTicketResult): void {
		if (this.destroyed || this.fatalAuthError) return;
		const now = this.now();
		const remaining = ticket.localExpiresAt - now;
		const buffer = Math.min(TICKET_REFRESH_BUFFER_MS, Math.floor(remaining / 2));
		const dueAt = now + Math.max(250, remaining - buffer);
		void this.workScheduler.queueReconnect("ticket-refresh-due", dueAt).catch((error) => {
			this.log(`ticket refresh scheduling failed: ${String(error)}`);
		});
	}

	private async refreshProviderTickets(force: boolean, epoch: OperationEpoch): Promise<SocketTicketResult> {
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
		this.scheduleTicketRefresh(ticket);
		return ticket;
	}

	private requestReconnect(reason: string): void {
		if (this.destroyed || this.fatalAuthError) return;
		if (this.reconnectRequester) this.reconnectRequester(reason);
		else void this.queueReconnect(reason);
	}

	private asAdmissionProvider(id: string, provider: SyncProviderPort): SocketAdmissionProvider {
		return {
			id,
			get connected() { return provider.wsconnected && provider.ws?.readyState === 1; },
			get connecting() { return provider.wsconnecting; },
			disconnect: () => provider.disconnect(),
			connect: () => provider.connect(),
		};
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
