import type { VaultSyncSettings } from "../settings";
import { appendTraceParams, type TraceHttpContext } from "../observability/traceContext";
import { obsidianRequest } from "../utils/http";

export const RECOVERY_SCHEMA_VERSION = 4 as const;
export const RECOVERY_SNAPSHOT_FORMAT_VERSION = 2 as const;
export const RECOVERY_MANIFEST_TREE_FORMAT_VERSION = 1 as const;
const MAX_RECOVERY_CONTENT_BYTES = 10 * 1024 * 1024;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RecoveryJobState =
	| "initializing"
	| "queued"
	| "planning"
	| "materializing"
	| "building"
	| "publishing"
	| "retrying"
	| "complete"
	| "complete_with_gaps"
	| "failed"
	| "cancelled";

export interface SnapshotRootV2 {
	format: "yaos-recovery-v2";
	snapshotFormatVersion: typeof RECOVERY_SNAPSHOT_FORMAT_VERSION;
	snapshotId: string;
	vaultIdHash: string;
	vaultGenerationHash: string;
	runtimeEpoch: string;
	boundarySequence: number;
	rootGeneration: number;
	sourcePlanDigest: string;
	manifestGraphDigest: string;
	manifestNodeCount: number;
	createdAt: string;
	completedAt: string;
	health: "complete" | "complete_with_gaps";
	reason: "initial" | "daily" | "manual" | "pre-bulk-operation";
	activeFilesTreeHash: string;
	deletedFilesTreeHash: string;
	attachmentsTreeHash: string;
	totals: {
		activeFiles: number;
		deletedFiles: number;
		unavailableFiles: number;
		attachments: number;
		markdownBytes: number;
		attachmentBytes: number;
	};
	previousSnapshotId: string | null;
}

export type ActiveFileManifestEntry =
	| {
		availability: "available";
		path: string;
		fileId: string;
		bodyId: string;
		bodyGeneration: number;
		contentHash: string;
		size: number;
	}
	| {
		availability: "unavailable";
		path: string;
		fileId: string;
		bodyId: string;
		bodyGeneration: number;
		errorCode: "corrupt_history" | "hash_mismatch" | "missing_history";
		errorReference: string;
	};

export type DeletedFileManifestEntry =
	| {
		availability: "available";
		bodyId: string;
		fileId: string;
		lastPath: string;
		deletedAtSequence: number;
		baselineContentHash: string;
		baselineSize: number;
		bodyReaped: boolean;
	}
	| {
		availability: "unavailable";
		bodyId: string;
		fileId: string;
		lastPath: string;
		deletedAtSequence: number;
		errorCode: "corrupt_history" | "missing_history" | "missing_content" | "recovery_disabled";
		errorReference: string;
		bodyReaped: boolean;
	};

export type AttachmentManifestEntry =
	| {
		availability: "available";
		path: string;
		hash: string;
		size: number;
		mime: string | null;
	}
	| {
		availability: "unavailable";
		path: string;
		expectedHash: string;
		expectedSize: number;
		mime: string | null;
		errorCode: "missing_blob" | "corrupt_blob";
		errorReference: string;
	};

export type SnapshotPathEntry = ActiveFileManifestEntry | AttachmentManifestEntry;
export interface RecoverySnapshotSummary {
	snapshotId: string;
	boundarySequence: number;
	rootHash: string;
	reason: "initial" | "daily" | "manual" | "pre-bulk-operation";
	pinned: boolean;
	createdAt: number;
	completedAt: number;
}

export interface RecoverySnapshotPage {
	snapshots: RecoverySnapshotSummary[];
	nextCursor: string | null;
}

export interface CaptureStarted {
	captureId: string;
	boundarySequence: number;
	state: "queued";
	statusUrl: string;
}

export interface CaptureStatus {
	captureId: string;
	state: RecoveryJobState;
	boundarySequence: number;
	processedEntries: number;
	totalEntries: number | null;
	contentObjectsWritten: number;
	contentObjectsReused: number;
	manifestNodesWritten: number;
	bytesRead: number;
	bytesWritten: number;
	retryCount: number;
	nextAttemptAt: number | null;
	error: { code: string; reference: string | null } | null;
	pinSoftExpiresAt: number | null;
	pinHardExpiresAt: number | null;
	snapshotId: string | null;
}

export interface RecoveryLiveFile {
	fileId: string;
	bodyId: string;
	generation: number;
	contentHash: string;
}

export interface RecoveryDiskSettlementInput {
	path: string;
	bodyId: string;
	generation: number;
	content: string;
	expectedContentHash: string;
	expectedSize: number;
}

export interface RecoveryDiskSettlement {
	contentHash: string;
	size: number;
}

export interface RecoveryCandidateReceipt {
	vaultId: string;
	vaultGeneration: string;
	bodyId: string;
	clientId: string;
	candidateId: string;
	candidateDigest: string;
	durableGeneration: number;
	runtimeEpoch: string;
}

export interface RecoveryRuntimePort {
	getLive(path: string): Promise<RecoveryLiveFile | null>;
	restoreExisting(input: { bodyId: string; content: string; candidateId: string; snapshotContentHash: string }): Promise<RecoveryCandidateReceipt>;
	restoreFresh(input: { path: string; content: string; candidateId: string; sourceSnapshotId: string; sourceFileId: string }): Promise<{ fileId: string; bodyId: string; lifecycleOperationId: string; receipt: RecoveryCandidateReceipt }>;
	settleDisk(input: RecoveryDiskSettlementInput): Promise<RecoveryDiskSettlement>;
}

export interface RecoveryRuntimeBridge {
	commitBodyCandidate(input: { bodyId: string; content: string; candidateId: string; reason: string }): Promise<RecoveryCandidateReceipt>;
	commitFreshBody(input: { bodyId: string; path: string; content: string; candidateId: string; reason: string }): Promise<{
		fileId: string;
		bodyId: string;
		lifecycleOperationId: string;
		receipt: RecoveryCandidateReceipt;
	}>;
}

export interface RecoveryRuntimeAdapterOptions {
	runtime: RecoveryRuntimeBridge;
	getLive(path: string): Promise<RecoveryLiveFile | null>;
	settleDisk(input: RecoveryDiskSettlementInput): Promise<RecoveryDiskSettlement>;
	mintIdentity?(): string;
}

export function recoveryFreshBodyId(candidateId: string): string {
	if (!/^restore-[a-f0-9]{32}$/.test(candidateId)) throw new Error("invalid recovery candidate identity");
	return `recovery-${candidateId.slice("restore-".length)}`;
}

/** Adapts the production candidate/lifecycle runtime without a restore-only transport. */
export function createRecoveryRuntimePort(options: RecoveryRuntimeAdapterOptions): RecoveryRuntimePort {
	return {
		getLive: (path) => options.getLive(path),
		restoreExisting: ({ bodyId, content, candidateId }) => options.runtime.commitBodyCandidate({
			bodyId,
			content,
			candidateId,
			reason: "recovery-restore",
		}),
		restoreFresh: async ({ path, content, candidateId }) => {
			const bodyId = options.mintIdentity?.() ?? recoveryFreshBodyId(candidateId);
			return options.runtime.commitFreshBody({ bodyId, path, content, candidateId, reason: "recovery-restore" });
		},
		settleDisk: (input) => options.settleDisk(input),
	};
}

export type RestoreSelection =
	| { kind: "all" }
	| { kind: "markdown-paths"; paths: string[] }
	| { kind: "attachment-paths"; paths: string[] }
	| { kind: "deleted-identities"; bodyIds: string[] };

export interface StartRestoreRequest {
	requestId: string;
	snapshotId: string;
	selection: RestoreSelection;
}

export interface RestoreStarted {
	restoreId: string;
	state: string;
	statusUrl: string;
}

export type RestoreItem =
	| {
		kind: "markdown";
		itemId: string;
		path: string;
		sourceFileId: string;
		sourceKind: "active" | "deleted";
		sourceBodyId: string;
		contentHash: string;
		size: number;
		contentUrl: string;
	}
	| {
		kind: "attachment";
		itemId: string;
		path: string;
		contentHash: string;
		size: number;
		mime: string | null;
		contentUrl: string;
	};

export interface RestoreItemResult {
	itemId: string;
	outcome: "restored" | "created-fresh" | "skipped-changed" | "failed";
	errorCode?: string;
}

export class RecoveryTerminalItemError extends Error {
	constructor(readonly errorCode: string, message: string) {
		super(message);
		this.name = "RecoveryTerminalItemError";
	}
}

export interface RestoreItemPage {
	items: RestoreItem[];
	nextCursor: string | null;
	total: number | null;
}

export interface RestoreStatus {
	restoreId: string;
	snapshotId: string;
	state: string;
	processedItems: number;
	totalItems: number | null;
	retryCount: number;
	nextAttemptAt: number | null;
	error: { code: string; reference: string | null } | null;
}

export interface RecoveryStatus {
	syncReady: boolean;
	recoveryReady: boolean;
	storageAvailable: boolean;
	projectionState: string;
	projectionProcessed: number;
	projectionTotal: number | null;
	projectionLag: number;
	oldestPinAgeMs: number | null;
	lastSuccessfulSnapshot: { snapshotId: string; completedAt: string | number } | null;
	activeCapture: CaptureStatus | null;
	activeRestore: RestoreStatus | null;
}

export interface VaultDeletionStatus {
	state: "queued" | "purging" | "retrying" | "complete" | "failed";
	deletedObjects: number;
	deletedBytes: number;
	retryCount: number;
	nextAttemptAt: number | null;
	error: { code: string; reference: string | null } | null;
	cursor: string | null;
}

export interface RecoveryTransportResponse {
	status: number;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

export interface RecoveryTransport {
	request(input: { url: string; method: "GET" | "POST" | "DELETE"; headers: Record<string, string>; body?: string }): Promise<RecoveryTransportResponse>;
}

const defaultTransport: RecoveryTransport = {
	request: (input) => obsidianRequest({
		...input,
		contentType: input.body === undefined ? undefined : "application/json",
	}) as Promise<RecoveryTransportResponse>,
};

function baseUrl(settings: VaultSyncSettings): string {
	return `${settings.host.replace(/\/$/, "")}/vault/${encodeURIComponent(settings.vaultId)}/recovery`;
}

export function isRecoveryTerminal(state: string): boolean {
	return state === "complete" || state === "complete_with_gaps" || state === "failed" || state === "cancelled";
}

function isHexHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function requiredHash(value: unknown, name: string): string {
	if (!isHexHash(value)) throw new Error(`recovery response has invalid ${name}`);
	return value;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`recovery response has invalid ${name}`);
	return value;
}

function requiredInteger(value: unknown, name: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`recovery response has invalid ${name}`);
	}
	return value;
}

function nullableInteger(value: unknown, name: string): number | null {
	return value === null ? null : requiredInteger(value, name);
}

const ENTRY_AVAILABILITIES = ["available", "unavailable"] as const;
const ACTIVE_UNAVAILABLE_CODES = ["corrupt_history", "hash_mismatch", "missing_history"] as const;
const ATTACHMENT_UNAVAILABLE_CODES = ["missing_blob", "corrupt_blob"] as const;
const DELETED_UNAVAILABLE_CODES = [
	"corrupt_history",
	"missing_history",
	"missing_content",
	"recovery_disabled",
] as const;

function requiredChoice<const T extends string>(
	value: unknown,
	name: string,
	choices: readonly T[],
): T {
	const match = choices.find((choice) => choice === value);
	if (match === undefined) throw new Error(`recovery response has invalid ${name}`);
	return match;
}

function isSafeVaultPath(path: unknown): path is string {
	if (typeof path !== "string" || !path || new TextEncoder().encode(path).byteLength > 16 * 1024) return false;
	if (path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../") || path.includes("\\")) return false;
	for (let index = 0; index < path.length; index++) {
		const code = path.charCodeAt(index);
		if (code <= 31 || code === 127) return false;
	}
	return true;
}

function assertSafePath(path: unknown): asserts path is string {
	if (!isSafeVaultPath(path)) throw new Error("recovery response contains an unsafe vault path");
}

function assertSafeRecoveryIdentity(value: string, name: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error(`invalid recovery ${name}`);
}

function sameLive(left: RecoveryLiveFile | null, right: RecoveryLiveFile | null): boolean {
	if (left === null || right === null) return left === right;
	return left.fileId === right.fileId && left.bodyId === right.bodyId && left.generation === right.generation && left.contentHash === right.contentHash;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let output = "";
	for (const byte of digest) output += byte.toString(16).padStart(2, "0");
	return output;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isUnknownRecord(value)) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function header(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
	return undefined;
}

function parseSnapshotRoot(value: unknown): SnapshotRootV2 {
	if (
		!isUnknownRecord(value)
		|| value.format !== "yaos-recovery-v2"
		|| value.snapshotFormatVersion !== RECOVERY_SNAPSHOT_FORMAT_VERSION
	) {
		throw new Error("recovery snapshot is not supported recovery-v2");
	}
	if (!isUnknownRecord(value.totals)) throw new Error("recovery snapshot totals are invalid");
	const health = value.health;
	const reason = value.reason;
	if (health !== "complete" && health !== "complete_with_gaps") throw new Error("recovery snapshot health is invalid");
	if (reason !== "initial" && reason !== "daily" && reason !== "manual" && reason !== "pre-bulk-operation") throw new Error("recovery snapshot reason is invalid");
	const vaultIdHash = requiredHash(value.vaultIdHash, "vaultIdHash");
	const vaultGenerationHash = requiredHash(value.vaultGenerationHash, "vaultGenerationHash");
	const sourcePlanDigest = requiredHash(value.sourcePlanDigest, "sourcePlanDigest");
	const manifestGraphDigest = requiredHash(value.manifestGraphDigest, "manifestGraphDigest");
	const activeFilesTreeHash = requiredHash(value.activeFilesTreeHash, "activeFilesTreeHash");
	const deletedFilesTreeHash = requiredHash(value.deletedFilesTreeHash, "deletedFilesTreeHash");
	const attachmentsTreeHash = requiredHash(value.attachmentsTreeHash, "attachmentsTreeHash");
	const totals = value.totals;
	return {
		format: "yaos-recovery-v2",
		snapshotFormatVersion: RECOVERY_SNAPSHOT_FORMAT_VERSION,
		snapshotId: requiredString(value.snapshotId, "snapshotId"),
		vaultIdHash,
		vaultGenerationHash,
		runtimeEpoch: requiredString(value.runtimeEpoch, "runtimeEpoch"),
		boundarySequence: requiredInteger(value.boundarySequence, "boundarySequence"),
		rootGeneration: requiredInteger(value.rootGeneration, "rootGeneration"),
		sourcePlanDigest,
		manifestGraphDigest,
		manifestNodeCount: requiredInteger(value.manifestNodeCount, "manifestNodeCount"),
		createdAt: requiredString(value.createdAt, "createdAt"),
		completedAt: requiredString(value.completedAt, "completedAt"),
		health,
		reason,
		activeFilesTreeHash,
		deletedFilesTreeHash,
		attachmentsTreeHash,
		totals: {
			activeFiles: requiredInteger(totals.activeFiles, "totals.activeFiles"),
			deletedFiles: requiredInteger(totals.deletedFiles, "totals.deletedFiles"),
			unavailableFiles: requiredInteger(totals.unavailableFiles, "totals.unavailableFiles"),
			attachments: requiredInteger(totals.attachments, "totals.attachments"),
			markdownBytes: requiredInteger(totals.markdownBytes, "totals.markdownBytes"),
			attachmentBytes: requiredInteger(totals.attachmentBytes, "totals.attachmentBytes"),
		},
		previousSnapshotId: value.previousSnapshotId === null ? null : requiredString(value.previousSnapshotId, "previousSnapshotId"),
	};
}

function parsePathEntry(value: unknown): SnapshotPathEntry {
	const candidate = isUnknownRecord(value) && isUnknownRecord(value.entry) ? value.entry : value;
	if (!isUnknownRecord(candidate)) throw new Error("recovery entry response is invalid");
	assertSafePath(candidate.path);
	const path = candidate.path;
	const availability = requiredChoice(candidate.availability, "entry.availability", ENTRY_AVAILABILITIES);
	if ("bodyGeneration" in candidate) {
		const fileId = requiredString(candidate.fileId, "entry.fileId");
		const bodyId = requiredString(candidate.bodyId, "entry.bodyId");
		const bodyGeneration = requiredInteger(candidate.bodyGeneration, "entry.bodyGeneration");
		if (availability === "available") {
			return {
				availability,
				path,
				fileId,
				bodyId,
				bodyGeneration,
				contentHash: requiredHash(candidate.contentHash, "entry.contentHash"),
				size: requiredInteger(candidate.size, "entry.size"),
			};
		}
		return {
			availability,
			path,
			fileId,
			bodyId,
			bodyGeneration,
			errorCode: requiredChoice(candidate.errorCode, "entry.errorCode", ACTIVE_UNAVAILABLE_CODES),
			errorReference: requiredString(candidate.errorReference, "entry.errorReference"),
		};
	}
	const mime = candidate.mime;
	if (mime !== null && typeof mime !== "string") {
		throw new Error("recovery response has invalid entry.mime");
	}
	if (availability === "available") {
		return {
			availability,
			path,
			hash: requiredHash(candidate.hash, "entry.hash"),
			size: requiredInteger(candidate.size, "entry.size"),
			mime,
		};
	}
	return {
		availability,
		path,
		expectedHash: requiredHash(candidate.expectedHash, "entry.expectedHash"),
		expectedSize: requiredInteger(candidate.expectedSize, "entry.expectedSize"),
		mime,
		errorCode: requiredChoice(candidate.errorCode, "entry.errorCode", ATTACHMENT_UNAVAILABLE_CODES),
		errorReference: requiredString(candidate.errorReference, "entry.errorReference"),
	};
}

function parseDeletedEntry(value: unknown): DeletedFileManifestEntry {
	const candidate = isUnknownRecord(value) && isUnknownRecord(value.entry) ? value.entry : value;
	if (!isUnknownRecord(candidate)) throw new Error("recovery deleted entry response is invalid");
	assertSafePath(candidate.lastPath);
	const bodyReaped = candidate.bodyReaped;
	if (typeof bodyReaped !== "boolean") {
		throw new Error("recovery response has invalid deleted.bodyReaped");
	}
	const common = {
		bodyId: requiredString(candidate.bodyId, "deleted.bodyId"),
		fileId: requiredString(candidate.fileId, "deleted.fileId"),
		lastPath: candidate.lastPath,
		deletedAtSequence: requiredInteger(candidate.deletedAtSequence, "deleted.deletedAtSequence"),
		bodyReaped,
	};
	const availability = requiredChoice(candidate.availability, "deleted.availability", ENTRY_AVAILABILITIES);
	if (availability === "available") {
		return {
			availability,
			...common,
			baselineContentHash: requiredHash(candidate.baselineContentHash, "deleted.baselineContentHash"),
			baselineSize: requiredInteger(candidate.baselineSize, "deleted.baselineSize"),
		};
	}
	return {
		availability,
		...common,
		errorCode: requiredChoice(candidate.errorCode, "deleted.errorCode", DELETED_UNAVAILABLE_CODES),
		errorReference: requiredString(candidate.errorReference, "deleted.errorReference"),
	};
}

function parseCaptureStatus(value: unknown): CaptureStatus {
	if (!isUnknownRecord(value)) throw new Error("capture status response is invalid");
	const state = requiredString(value.state, "capture.state") as RecoveryJobState;
	if (!["initializing", "queued", "planning", "materializing", "building", "publishing", "retrying", "complete", "complete_with_gaps", "failed", "cancelled"].includes(state)) throw new Error("capture state is invalid");
	const error = value.error;
	return {
		captureId: requiredString(value.captureId, "captureId"),
		state,
		boundarySequence: requiredInteger(value.boundarySequence, "boundarySequence"),
		processedEntries: requiredInteger(value.processedEntries, "processedEntries"),
		totalEntries: nullableInteger(value.totalEntries, "totalEntries"),
		contentObjectsWritten: requiredInteger(value.contentObjectsWritten, "contentObjectsWritten"),
		contentObjectsReused: requiredInteger(value.contentObjectsReused, "contentObjectsReused"),
		manifestNodesWritten: requiredInteger(value.manifestNodesWritten, "manifestNodesWritten"),
		bytesRead: requiredInteger(value.bytesRead, "bytesRead"),
		bytesWritten: requiredInteger(value.bytesWritten, "bytesWritten"),
		retryCount: requiredInteger(value.retryCount, "retryCount"),
		nextAttemptAt: nullableInteger(value.nextAttemptAt, "nextAttemptAt"),
		error: error === null ? null : isUnknownRecord(error) ? { code: requiredString(error.code, "error.code"), reference: error.reference === null ? null : requiredString(error.reference, "error.reference") } : (() => { throw new Error("capture error is invalid"); })(),
		pinSoftExpiresAt: nullableInteger(value.pinSoftExpiresAt, "pinSoftExpiresAt"),
		pinHardExpiresAt: nullableInteger(value.pinHardExpiresAt, "pinHardExpiresAt"),
		snapshotId: value.snapshotId === null ? null : requiredString(value.snapshotId, "snapshotId"),
	};
}

function parseRestoreItem(value: unknown): RestoreItem {
	if (!isUnknownRecord(value)) throw new Error("restore item is invalid");
	assertSafePath(value.path);
	const common = {
		itemId: requiredString(value.itemId, "itemId"),
		path: value.path,
		contentHash: isHexHash(value.contentHash) ? value.contentHash : (() => { throw new Error("restore content hash is invalid"); })(),
		size: requiredInteger(value.size, "item.size"),
		contentUrl: requiredString(value.contentUrl, "item.contentUrl"),
	};
	if (value.kind === "markdown") {
		if (value.sourceKind !== "active" && value.sourceKind !== "deleted") throw new Error("restore Markdown source kind is invalid");
		return {
			kind: "markdown",
			...common,
			sourceKind: value.sourceKind,
			sourceFileId: requiredString(value.sourceFileId, "sourceFileId"),
			sourceBodyId: requiredString(value.sourceBodyId, "sourceBodyId"),
		};
	}
	if (value.kind === "attachment") {
		if (value.mime !== null && typeof value.mime !== "string") throw new Error("restore attachment MIME is invalid");
		return { kind: "attachment", ...common, mime: value.mime };
	}
	throw new Error("restore item kind is invalid");
}

export class RecoveryClient {
	constructor(
		private readonly settings: VaultSyncSettings,
		private readonly trace?: TraceHttpContext,
		private readonly transport: RecoveryTransport = defaultTransport,
	) {}

	async startCapture(reason: "daily" | "manual" | "pre-bulk-operation", requestId = crypto.randomUUID()): Promise<CaptureStarted> {
		const response = await this.request("captures", "POST", { reason, requestId });
		if (response.status !== 202) throw this.responseError("capture start", response);
		const value = response.json;
		if (!isUnknownRecord(value) || value.state !== "queued") throw new Error("capture start response is invalid");
		return {
			captureId: requiredString(value.captureId, "captureId"),
			boundarySequence: requiredInteger(value.boundarySequence, "boundarySequence"),
			state: "queued",
			statusUrl: requiredString(value.statusUrl, "statusUrl"),
		};
	}

	async getCaptureStatus(captureId: string): Promise<CaptureStatus> {
		return parseCaptureStatus(await this.json(`captures/${encodeURIComponent(captureId)}`, "GET"));
	}

	async cancelCapture(captureId: string): Promise<CaptureStatus> {
		const response = await this.request(`captures/${encodeURIComponent(captureId)}`, "DELETE");
		if (response.status < 200 || response.status >= 300) throw this.responseError("capture cancellation", response);
		try {
			return parseCaptureStatus(response.json);
		} catch {
			return this.getCaptureStatus(captureId);
		}
	}

	async listSnapshots(cursor: string | null = null, limit = 50): Promise<RecoverySnapshotPage> {
		const query = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, limit))) });
		if (cursor) query.set("cursor", cursor);
		const value = await this.json<unknown>(`snapshots?${query}`, "GET");
		if (!isUnknownRecord(value) || !Array.isArray(value.snapshots)) throw new Error("snapshot list response is invalid");
		return {
			snapshots: value.snapshots.map((entry) => {
				if (!isUnknownRecord(entry)) throw new Error("snapshot catalog entry is invalid");
				const reason = entry.reason;
				if (reason !== "initial" && reason !== "daily" && reason !== "manual" && reason !== "pre-bulk-operation") throw new Error("snapshot catalog reason is invalid");
				if (!isHexHash(entry.rootHash) || typeof entry.pinned !== "boolean") throw new Error("snapshot catalog root is invalid");
				return {
					snapshotId: requiredString(entry.snapshotId, "snapshotId"),
					boundarySequence: requiredInteger(entry.boundarySequence, "boundarySequence"),
					rootHash: entry.rootHash,
					reason,
					pinned: entry.pinned,
					createdAt: requiredInteger(entry.createdAt, "createdAt"),
					completedAt: requiredInteger(entry.completedAt, "completedAt"),
				};
			}),
			nextCursor: value.nextCursor === null ? null : requiredString(value.nextCursor, "nextCursor"),
		};
	}

	async getSnapshotRoot(snapshotId: string, expectedRootHash?: string): Promise<SnapshotRootV2> {
		const root = parseSnapshotRoot(await this.json(`snapshots/${encodeURIComponent(snapshotId)}`, "GET"));
		if (root.snapshotId !== snapshotId) throw new Error("recovery root identity does not match the retained catalog");
		if (expectedRootHash && await sha256Hex(new TextEncoder().encode(canonicalJson(root))) !== expectedRootHash) {
			throw new Error("recovery root hash does not match the retained catalog");
		}
		return root;
	}

	async lookupPathEntry(snapshotId: string, path: string): Promise<SnapshotPathEntry | null> {
		assertSafePath(path);
		const response = await this.request(`snapshots/${encodeURIComponent(snapshotId)}/entry?path=${encodeURIComponent(path)}`, "GET");
		if (response.status === 404) return null;
		if (response.status !== 200) throw this.responseError("snapshot entry lookup", response);
		return parsePathEntry(response.json);
	}

	async lookupDeletedEntry(snapshotId: string, bodyId: string): Promise<DeletedFileManifestEntry | null> {
		assertSafeRecoveryIdentity(bodyId, "body identity");
		const response = await this.request(`snapshots/${encodeURIComponent(snapshotId)}/deleted/${encodeURIComponent(bodyId)}`, "GET");
		if (response.status === 404) return null;
		if (response.status !== 200) throw this.responseError("deleted entry lookup", response);
		return parseDeletedEntry(response.json);
	}

	async downloadSnapshotFile(snapshotId: string, path: string, expectedSize: number): Promise<Uint8Array> {
		assertSafePath(path);
		return this.verifiedContent(`snapshots/${encodeURIComponent(snapshotId)}/file?path=${encodeURIComponent(path)}`, expectedSize);
	}

	async downloadDeletedFile(snapshotId: string, bodyId: string, expectedSize: number): Promise<Uint8Array> {
		assertSafeRecoveryIdentity(bodyId, "body identity");
		return this.verifiedContent(`snapshots/${encodeURIComponent(snapshotId)}/deleted/${encodeURIComponent(bodyId)}/file`, expectedSize);
	}

	async startRestore(snapshotId: string, selection: RestoreSelection, requestId = crypto.randomUUID()): Promise<RestoreStarted> {
		const response = await this.request("restores", "POST", { requestId, snapshotId, selection });
		if (response.status !== 202) throw this.responseError("restore start", response);
		const value = response.json;
		if (!isUnknownRecord(value)) throw new Error("restore start response is invalid");
		const restoreId = typeof value.restoreId === "string" ? value.restoreId : requestId;
		return {
			restoreId,
			state: requiredString(value.state, "restore.state"),
			statusUrl: typeof value.statusUrl === "string"
				? value.statusUrl
				: `${baseUrl(this.settings)}/restores/${encodeURIComponent(restoreId)}`,
		};
	}

	async getRestoreStatus(restoreId: string): Promise<RestoreStatus> {
		return this.parseRestoreStatusValue(await this.json<unknown>(`restores/${encodeURIComponent(restoreId)}`, "GET"), restoreId);
	}

	async listRestoreItems(restoreId: string, cursor: string | null = null, limit = 50): Promise<RestoreItemPage> {
		const query = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, limit))) });
		if (cursor) query.set("cursor", cursor);
		const value = await this.json<unknown>(`restores/${encodeURIComponent(restoreId)}/items?${query}`, "GET");
		if (!isUnknownRecord(value) || !Array.isArray(value.items)) throw new Error("restore item page is invalid");
		return {
			items: value.items.map(parseRestoreItem),
			nextCursor: value.nextCursor === null ? null : requiredString(value.nextCursor, "nextCursor"),
			total: value.total === undefined || value.total === null ? null : requiredInteger(value.total, "total"),
		};
	}

	async downloadRestoreItem(restoreId: string, item: RestoreItem): Promise<Uint8Array> {
		const bytes = await this.verifiedContent(`restores/${encodeURIComponent(restoreId)}/items/${encodeURIComponent(item.itemId)}/content`, item.size);
		if (bytes.byteLength !== item.size || await sha256Hex(bytes) !== item.contentHash) {
			throw new RecoveryTerminalItemError("content_corrupt", "restore item content does not match its descriptor");
		}
		return bytes;
	}

	async reportRestoreResults(restoreId: string, results: RestoreItemResult[]): Promise<RestoreStatus> {
		if (results.length === 0 || results.length > 100) throw new Error("restore result batch is outside the supported bound");
		await this.json(`restores/${encodeURIComponent(restoreId)}/results`, "POST", { results });
		return this.getRestoreStatus(restoreId);
	}

	async cancelRestore(restoreId: string): Promise<RestoreStatus> {
		return this.getRestoreStatusFromDelete(restoreId);
	}

	async applyMarkdownItem(restoreId: string, snapshotId: string, item: Extract<RestoreItem, { kind: "markdown" }>, liveAtReview: RecoveryLiveFile | null, runtime: RecoveryRuntimePort): Promise<RestoreItemResult> {
		const bytes = await this.downloadRestoreItem(restoreId, item);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new RecoveryTerminalItemError("markdown_invalid_utf8", "snapshot Markdown is not valid UTF-8");
		}
		const current = await runtime.getLive(item.path);
		if (!sameLive(current, liveAtReview)) return { itemId: item.itemId, outcome: "skipped-changed" };
		const candidateId = `restore-${(await sha256Hex(new TextEncoder().encode(`${restoreId}\u0000${item.itemId}`))).slice(0, 32)}`;
		if (current?.bodyId === recoveryFreshBodyId(candidateId) && current.contentHash === item.contentHash) {
			await this.settleVerifiedDisk(runtime, item, current.bodyId, current.generation, content);
			return { itemId: item.itemId, outcome: "created-fresh" };
		}
		if (item.sourceKind === "deleted" && current) {
			return { itemId: item.itemId, outcome: "skipped-changed" };
		}
		if (current?.contentHash === item.contentHash) {
			await this.settleVerifiedDisk(runtime, item, current.bodyId, current.generation, content);
			return { itemId: item.itemId, outcome: "restored" };
		}
		if (current) {
			const receipt = await runtime.restoreExisting({ bodyId: current.bodyId, content, candidateId, snapshotContentHash: item.contentHash });
			this.validateReceipt(receipt, current.bodyId, candidateId);
			await this.settleVerifiedDisk(runtime, item, current.bodyId, receipt.durableGeneration, content);
			return { itemId: item.itemId, outcome: "restored" };
		}
		const fresh = await runtime.restoreFresh({ path: item.path, content, candidateId, sourceSnapshotId: snapshotId, sourceFileId: item.sourceFileId });
		this.validateReceipt(fresh.receipt, fresh.bodyId, candidateId);
		if (fresh.fileId === item.sourceFileId || fresh.bodyId === item.sourceBodyId) {
			throw new RecoveryTerminalItemError("historical_identity_reused", "fresh restore reused a historical identity");
		}
		await this.settleVerifiedDisk(runtime, item, fresh.bodyId, fresh.receipt.durableGeneration, content);
		return { itemId: item.itemId, outcome: "created-fresh" };
	}

	async deleteSnapshot(snapshotId: string): Promise<{ deleted: boolean }> {
		const value = await this.json<unknown>(`snapshots/${encodeURIComponent(snapshotId)}`, "DELETE");
		if (!isUnknownRecord(value) || typeof value.deleted !== "boolean") throw new Error("snapshot deletion response is invalid");
		return { deleted: value.deleted };
	}
	async applyRetention(): Promise<{ retained: number; removed: number; deferred: number }> {
		const value = await this.json<unknown>("retention", "POST", {});
		if (!isUnknownRecord(value) || !Array.isArray(value.retained) || !Array.isArray(value.removed) || !Array.isArray(value.deferred)) {
			throw new Error("retention response is invalid");
		}
		return { retained: value.retained.length, removed: value.removed.length, deferred: value.deferred.length };
	}

	async startGarbageCollection(requestId = crypto.randomUUID()): Promise<{ jobId: string; state: string }> {
		const response = await this.request("gc", "POST", { requestId });
		if (response.status !== 202) throw this.responseError("garbage collection start", response);
		const value = response.json;
		if (!isUnknownRecord(value)) throw new Error("garbage collection response is invalid");
		return { jobId: requiredString(value.jobId, "jobId"), state: requiredString(value.state, "state") };
	}

	async getRecoveryStatus(): Promise<RecoveryStatus> {
		const value = await this.json<unknown>("status", "GET");
		if (!isUnknownRecord(value)) throw new Error("recovery status response is invalid");
		const projection = isUnknownRecord(value.projection) ? value.projection : null;
		const oldestPin = isUnknownRecord(value.oldestPin) ? value.oldestPin : null;
		const lastSnapshot = isUnknownRecord(value.lastSuccessfulSnapshot) ? value.lastSuccessfulSnapshot : null;
		const completedAt = lastSnapshot?.completedAt;
		if (lastSnapshot && completedAt === undefined) throw new Error("last snapshot completion time is missing");
		if (completedAt !== undefined && typeof completedAt !== "string" && !Number.isSafeInteger(completedAt)) {
			throw new Error("last snapshot completion time is invalid");
		}
		return {
			syncReady: value.syncReady === true,
			recoveryReady: value.recoveryReady === true,
			storageAvailable: value.storageAvailable === true,
			projectionState: projection ? requiredString(projection.state, "projection.state") : "disabled",
			projectionProcessed: projection ? requiredInteger(projection.processedEntries, "projection.processedEntries") : 0,
			projectionTotal: projection ? nullableInteger(projection.totalEntries, "projection.totalEntries") : null,
			projectionLag: projection ? requiredInteger(projection.lagSequences, "projection.lagSequences") : 0,
			oldestPinAgeMs: oldestPin ? requiredInteger(oldestPin.ageMs, "oldestPin.ageMs") : null,
			lastSuccessfulSnapshot: lastSnapshot ? {
				snapshotId: requiredString(lastSnapshot.snapshotId, "last snapshot ID"),
				completedAt: completedAt as string | number,
			} : null,
			activeCapture: value.activeCapture === null || value.activeCapture === undefined ? null : parseCaptureStatus(value.activeCapture),
			activeRestore: value.activeRestore === null || value.activeRestore === undefined ? null : await this.parseRestoreStatusValue(value.activeRestore),
		};
	}

	async getVaultDeletionStatus(): Promise<VaultDeletionStatus> {
		const response = await this.requestFromVault("deletion", "GET");
		if (response.status !== 200) throw this.responseError("vault deletion status", response);
		const value = response.json;
		if (!isUnknownRecord(value)) throw new Error("vault deletion status response is invalid");
		const state = requiredString(value.state, "deletion.state") as VaultDeletionStatus["state"];
		if (!["queued", "purging", "retrying", "complete", "failed"].includes(state)) throw new Error("vault deletion state is invalid");
		const error = value.error;
		return {
			state,
			deletedObjects: requiredInteger(value.deletedObjects, "deletedObjects"),
			deletedBytes: requiredInteger(value.deletedBytes, "deletedBytes"),
			retryCount: requiredInteger(value.retries, "retries"),
			nextAttemptAt: nullableInteger(value.nextAttemptAt, "nextAttemptAt"),
			error: error === null ? null : isUnknownRecord(error) ? { code: requiredString(error.code, "error.code"), reference: error.reference === null ? null : requiredString(error.reference, "error.reference") } : (() => { throw new Error("deletion error is invalid"); })(),
			cursor: value.cursor === null ? null : requiredString(value.cursor, "cursor"),
		};
	}

	private async parseRestoreStatusValue(value: unknown, expectedRestoreId?: string): Promise<RestoreStatus> {
		if (!isUnknownRecord(value)) throw new Error("restore status response is invalid");
		const error = value.error;
		const restoreId = typeof value.restoreId === "string" ? value.restoreId : expectedRestoreId;
		return {
			restoreId: requiredString(restoreId, "restoreId"),
			snapshotId: requiredString(value.snapshotId, "snapshotId"),
			state: requiredString(value.state, "state"),
			processedItems: requiredInteger(value.processedItems ?? value.processedEntries, "processedItems"),
			totalItems: nullableInteger(value.totalItems ?? value.totalEntries, "totalItems"),
			retryCount: requiredInteger(value.retryCount, "retryCount"),
			nextAttemptAt: nullableInteger(value.nextAttemptAt, "nextAttemptAt"),
			error: error === null ? null : isUnknownRecord(error) ? { code: requiredString(error.code, "error.code"), reference: error.reference === null ? null : requiredString(error.reference, "error.reference") } : null,
		};
	}

	private async getRestoreStatusFromDelete(restoreId: string): Promise<RestoreStatus> {
		const response = await this.request(`restores/${encodeURIComponent(restoreId)}`, "DELETE");
		if (response.status < 200 || response.status >= 300) throw this.responseError("restore cancellation", response);
		try {
			return await this.parseRestoreStatusValue(response.json, restoreId);
		} catch {
			return this.getRestoreStatus(restoreId);
		}
	}

	private async settleVerifiedDisk(
		runtime: RecoveryRuntimePort,
		item: Extract<RestoreItem, { kind: "markdown" }>,
		bodyId: string,
		generation: number,
		content: string,
	): Promise<void> {
		const settlement = await runtime.settleDisk({
			path: item.path,
			bodyId,
			generation,
			content,
			expectedContentHash: item.contentHash,
			expectedSize: item.size,
		});
		if (settlement.contentHash !== item.contentHash || settlement.size !== item.size) {
			throw new Error("recovery disk settlement did not persist the verified snapshot bytes");
		}
	}

	private validateReceipt(receipt: RecoveryCandidateReceipt, bodyId: string, candidateId: string): void {
		if (!receipt || receipt.bodyId !== bodyId || receipt.candidateId !== candidateId || !receipt.vaultId || !receipt.vaultGeneration || !receipt.clientId || !isHexHash(receipt.candidateDigest) || !Number.isSafeInteger(receipt.durableGeneration) || receipt.durableGeneration < 1 || !receipt.runtimeEpoch) {
			throw new Error("restore candidate returned an invalid durable receipt");
		}
	}

	private async verifiedContent(resource: string, expectedSize: number): Promise<Uint8Array> {
		if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_RECOVERY_CONTENT_BYTES) {
			throw new RecoveryTerminalItemError("content_too_large", "recovery content exceeds the client read bound");
		}
		const response = await this.request(resource, "GET");
		if (response.status === 404 || response.status === 410) {
			throw new RecoveryTerminalItemError("content_unavailable", "recovery content is unavailable");
		}
		if (response.status !== 200) throw this.responseError("recovery content download", response);
		const declaredLength = header(response.headers, "content-length");
		if (
			declaredLength !== undefined
			&& (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== expectedSize)
		) {
			throw new RecoveryTerminalItemError("content_corrupt", "recovery content length is invalid");
		}
		const bytes = new Uint8Array(response.arrayBuffer);
		if (bytes.byteLength !== expectedSize || bytes.byteLength > MAX_RECOVERY_CONTENT_BYTES) {
			throw new RecoveryTerminalItemError("content_corrupt", "recovery content size does not match its descriptor");
		}
		const contentHash = header(response.headers, "x-yaos-content-sha256");
		const contentSize = header(response.headers, "x-yaos-content-size");
		if (!isHexHash(contentHash) || await sha256Hex(bytes) !== contentHash) {
			throw new RecoveryTerminalItemError("content_corrupt", "recovery content integrity mismatch");
		}
		if (contentSize !== undefined && (!/^\d+$/.test(contentSize) || Number(contentSize) !== bytes.byteLength)) {
			throw new RecoveryTerminalItemError("content_corrupt", "recovery content size mismatch");
		}
		return bytes;
	}

	private async json<T>(resource: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>): Promise<T> {
		const response = await this.request(resource, method, body);
		if (response.status < 200 || response.status >= 300) throw this.responseError("recovery request", response);
		return response.json as T;
	}

	private request(resource: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>): Promise<RecoveryTransportResponse> {
		return this.transport.request({
			url: appendTraceParams(`${baseUrl(this.settings)}/${resource}`, this.trace),
			method,
			headers: { Authorization: `Bearer ${this.settings.deviceToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
	}

	private requestFromVault(resource: string, method: "GET" | "POST" | "DELETE", body?: Record<string, unknown>): Promise<RecoveryTransportResponse> {
		return this.transport.request({
			url: appendTraceParams(`${this.settings.host.replace(/\/$/, "")}/vault/${encodeURIComponent(this.settings.vaultId)}/${resource}`, this.trace),
			method,
			headers: { Authorization: `Bearer ${this.settings.deviceToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
	}

	private responseError(operation: string, response: RecoveryTransportResponse): Error {
		return new Error(`${operation} failed (${response.status}): ${response.text}`);
	}
}
