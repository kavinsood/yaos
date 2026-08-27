import * as Y from "yjs";
import { gzipSync } from "fflate";
import { sha256Hex } from "./hex.js";
import {
	decodeHashedRecoveryObject,
	encodeHashedRecoveryObject,
	gunzipRecoveryBytes,
} from "./recoveryCanonicalJson.js";
import {
	CAPTURE_PLAN_STREAMS,
	MAX_CAPTURE_PLAN_BYTES,
	MAX_RECIPE_BYTES,
	RECOVERY_RPC_HEADER,
	RECOVERY_RPC_MAX_JSON_BYTES,
	RECOVERY_RPC_PATH,
	decodeRecoveryRpcPayload,
	encodeRecoveryRpcPayload,
	type BodyRecipeDescriptor,
	type CapturePlanEntry,
	type CapturePlanRequest,
	type CapturePlanResponse,
	type CatalogDeltaPageRequest,
	type CatalogDeltaPageResponse,
	type ContentMaterialized,
	type CoverageCheckRequest,
	type CoverageCheckResponse,
	type FinalizeCaptureRequest,
	type FinalizedCapture,
	type IncrementalBase,
	type ManifestNodeMaterialized,
	type MaterializationLease,
	type MaterializationLeaseRequest,
	type RecipeChunk,
	type RecipeChunkRequest,
	type RecipeDescriptorRequest,
	type RecoveryDefectRecord,
	type SweepLease,
	type SweepLeaseRequest,
} from "./recoveryProtocol.js";
import {
	MANIFEST_BRANCH_FORMAT,
	MANIFEST_MUTATION_CHUNK_ENTRIES,
	R2ManifestNodeStore,
	lookupManifestEntry,
	createEmptyManifestTree,
	computeManifestGraphDigest,
	encodeSnapshotRoot,
	manifestNodeObjectKey,
	mutateManifestTreeChunk,
	rebuildManifestTree,
	parseAndVerifySnapshotRoot,
	validateSnapshotRoot,
	readAndVerifyManifestNode,
	recoveryContentObjectKey,
	recoveryStagingPrefix,
	recoveryV2Prefix,
	type ActiveFileManifestEntry,
	type AttachmentManifestEntry,
	type DeletedFileManifestEntry,
	type EncodedManifestNode,
	type ManifestEntryByTree,
	type ManifestNodeSource,
	type ManifestNodeStore,
	type ManifestTreeKind,
	type ManifestTreeMutation,
	type ReachableManifestNode,
	type SnapshotRootV2,
} from "./recoveryManifestTree.js";
import type { ImmutableArtifactStore } from "./bootstrap.js";
import {
	recoveryJobId,
	type CaptureStartDescriptor,
	type GcDescriptor,
	type ProjectionDescriptor,
	type PurgeDescriptor,
	type RecoveryJobDescriptor,
	type RecoveryJobStatus,
	type RestoreDescriptor,
} from "./recoveryExecutor.js";
import { isCanonicalVaultId } from "./vaultId.js";
import {
	RecoveryJobStateStore,
	isTerminalRecoveryState,
	type RecoveryJobRecord,
	type RestoreItemOutcome,
	type StoredRestoreItem,
} from "./recoveryJobState.js";

const MAX_BODIES_PER_ALARM = 25;
const ALARM_SLICE_WALL_MS = 4_000;
const MAX_R2_IN_FLIGHT = 4;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 15 * 60_000;
const MAX_BODY_DEFECT_ATTEMPTS = 3;
const MAX_MARK_PAGE = 128;
const GC_GRACE_MS = 48 * 60 * 60_000;
const MAX_RESTORE_PAGE = 100;
const MAX_RESTORE_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_TURN_REBUILD_ENTRIES = 10_000;
const MANIFEST_INVENTORY_PAGE = 32;
const encoder = new TextEncoder();

export interface RecoveryJobEnvironment {
	YAOS_SYNC: DurableObjectNamespace;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
}
interface LeaseStatus {
	valid: true;
	captureId: string;
	boundarySequence: number;
	state: string;
	softExpiresAt: number;
	hardExpiresAt: number;
	baseSnapshotId: string | null;
}


interface ProjectionWorkPage {
	entries: Array<{ bodyId: string; generation: number; contentHash: string; size: number }>;
	nextCursor: string | null;
	terminal: boolean;
}


interface GcRootPage {
	roots: Array<{ objectKey: string; domain: "recovery" | "blob" }>;
	marks: Array<{ objectKeyHash: string; domain: "recovery" | "blob" | "staging" }>;
	nextCursor: string | null;
	terminal: boolean;
}

interface RecoveryAuthorityRpc {
	checkRecoveryJobLease(input: { captureId: string; boundarySequence: number; capability: string; progress?: number }): Promise<LeaseStatus>;
	getCapturePlanPage(request: CapturePlanRequest): Promise<CapturePlanResponse>;
	getRecipeDescriptors(request: RecipeDescriptorRequest): Promise<BodyRecipeDescriptor[]>;
	getRecipeChunk(request: RecipeChunkRequest): Promise<RecipeChunk>;
	acquireMaterializationLease(request: MaterializationLeaseRequest): Promise<MaterializationLease>;
	releaseMaterializationLease(leaseId: string): Promise<void>;
	acknowledgeContentMaterialized(request: ContentMaterialized): Promise<void>;
	acknowledgeManifestNodesMaterialized(input: { captureId: string; boundarySequence: number; capability: string; nodes: ManifestNodeMaterialized[] }): Promise<void>;
	resetCaptureDelta(input: { captureId: string; boundarySequence: number; capability: string }): Promise<void>;
	checkRecoveryCoverage(request: CoverageCheckRequest): Promise<CoverageCheckResponse>;
	getIncrementalBase(input: { captureId: string; boundarySequence: number; capability: string }): Promise<IncrementalBase | null>;
	getCatalogDeltaPage(request: CatalogDeltaPageRequest): Promise<CatalogDeltaPageResponse>;
	recordRecoveryDefects(input: { captureId: string; boundarySequence: number; capability: string; defects: RecoveryDefectRecord[] }): Promise<void>;
	finalizeCapture(request: FinalizeCaptureRequest): Promise<FinalizedCapture>;
	acknowledgeJobCancelled(input: { captureId: string; boundarySequence: number; capability: string }): Promise<void>;
	getProjectionWorkPage(input: { vaultId: string; vaultGeneration: string; leaseId: string; capability: string; cursor: string | null; maxEntries: number; maxResponseBytes: number }): Promise<ProjectionWorkPage>;
	getProjectionRecipeDescriptor(input: { vaultId: string; vaultGeneration: string; leaseId: string; capability: string; bodyId: string; expectedHeadGeneration: number }): Promise<BodyRecipeDescriptor>;
	getProjectionRecipeChunk(input: { vaultId: string; vaultGeneration: string; leaseId: string; capability: string; bodyId: string; expectedHeadGeneration: number; recipeId: string; cursor: string; maxResponseBytes: number }): Promise<RecipeChunk>;
	acknowledgeProjectionContentMaterialized(input: { vaultId: string; vaultGeneration: string; leaseId: string; capability: string; bodyId: string; expectedHeadGeneration: number; contentHash: string; plainBytes: number; objectKey: string }): Promise<void>;
	validateRestoreAuthority(input: { vaultId: string; vaultGeneration: string; restoreId: string; snapshotId: string; capability: string }): Promise<{ rootKey: string; rootHash: string; selection: RestoreDescriptor["selection"]; capabilityExpiresAt: number }>;
	completeRestore(input: { vaultId: string; vaultGeneration: string; restoreId: string; snapshotId: string; capability: string }): Promise<void>;
	getGcRootPage(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string; cursor: string | null; maxEntries: number }): Promise<GcRootPage>;
	completeGcMark(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string }): Promise<void>;
	acquireSweepLease(request: SweepLeaseRequest & { vaultId: string; vaultGeneration: string; capability: string }): Promise<SweepLease>;
	releaseSweepLease(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string; leaseId: string }): Promise<void>;
	invalidateSweptObjects(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string; leaseId: string; domain: "recovery" | "blob"; objectKeys: string[] }): Promise<void>;
	completeGcSweep(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string }): Promise<void>;
	abortRecoveryGc(input: { vaultId: string; vaultGeneration: string; epoch: number; capability: string; reason: string }): Promise<void>;
}

interface CaptureProgress {
	mode: "delta" | "plan" | "build" | "inventory" | "publish";
	streamIndex: number;
	cursor: string | null;
	pageSequence: number;
	currentPage: string | null;
	entryIndex: number;
	planDigest: string | null;
	deltaDigest: string | null;
	baseSnapshotId: string | null;
	baseRootKey: string | null;
	baseRootHash: string | null;
	fullRebuild: boolean;
	buildTreeIndex: number;
	buildPageIndex: number;
	buildDeltaIndex: number;
}

interface TreeCheckpointMetadata {
	rootHash: string;
	entries: number;
	nodes: number;
}

interface RestoreItem {
	kind: "markdown" | "attachment";
	itemId: string;
	path: string;
	contentHash: string;
	size: number;
	contentUrl: string;
	sourceKind?: "active" | "deleted";
	sourceFileId?: string;
	sourceBodyId?: string;
	mime?: string | null;
}

class RetryableRecoveryError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

class TerminalRecoveryError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

class BodyDefectError extends Error {
	constructor(
		readonly code: "corrupt_history" | "hash_mismatch" | "missing_history",
		readonly entry: Extract<CapturePlanEntry, { kind: "active" | "deleted" }>,
		message: string,
	) {
		super(message);
	}
}

function metadataRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TerminalRecoveryError("corrupt_job_state", `${label} must be an object`);
	}
	return Object.fromEntries(Object.entries(value));
}

function assertMetadataKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	label: string,
	optional: readonly string[] = [],
): void {
	const allowed = [...required, ...optional];
	if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !allowed.includes(key))) {
		throw new TerminalRecoveryError("corrupt_job_state", `invalid ${label} fields`);
	}
}

function metadataString(value: unknown, label: string): string;
function metadataString(value: unknown, label: string, nullable: true): string | null;
function metadataString(value: unknown, label: string, nullable = false): string | null {
	if (nullable && value === null) return null;
	if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > 4096) {
		throw new TerminalRecoveryError("corrupt_job_state", `invalid ${label}`);
	}
	return value;
}

function metadataInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
		throw new TerminalRecoveryError("corrupt_job_state", `invalid ${label}`);
	}
	return value;
}

function metadataNullableHash(value: unknown, label: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new TerminalRecoveryError("corrupt_job_state", `invalid ${label}`);
	}
	return value;
}

function parseCaptureProgress(value: unknown): CaptureProgress {
	const progress = metadataRecord(value, "capture progress");
	assertMetadataKeys(progress, [
		"mode", "streamIndex", "cursor", "pageSequence", "currentPage", "entryIndex", "planDigest",
		"deltaDigest", "baseSnapshotId", "baseRootKey", "baseRootHash", "fullRebuild",
		"buildTreeIndex", "buildPageIndex", "buildDeltaIndex",
	], "capture progress");
	if (progress.mode !== "delta" && progress.mode !== "plan" && progress.mode !== "build"
		&& progress.mode !== "inventory" && progress.mode !== "publish") {
		throw new TerminalRecoveryError("corrupt_job_state", "invalid capture progress mode");
	}
	const nullableString = (candidate: unknown, label: string): string | null => {
		if (candidate === null) return null;
		return metadataString(candidate, label);
	};
	if (typeof progress.fullRebuild !== "boolean") {
		throw new TerminalRecoveryError("corrupt_job_state", "invalid capture rebuild mode");
	}
	return {
		mode: progress.mode,
		streamIndex: metadataInteger(progress.streamIndex, "capture stream index"),
		cursor: nullableString(progress.cursor, "capture cursor"),
		pageSequence: metadataInteger(progress.pageSequence, "capture page sequence"),
		currentPage: nullableString(progress.currentPage, "capture current page"),
		entryIndex: metadataInteger(progress.entryIndex, "capture entry index"),
		planDigest: metadataNullableHash(progress.planDigest, "capture plan digest"),
		deltaDigest: metadataNullableHash(progress.deltaDigest, "capture delta digest"),
		baseSnapshotId: nullableString(progress.baseSnapshotId, "capture base snapshot ID"),
		baseRootKey: nullableString(progress.baseRootKey, "capture base root key"),
		baseRootHash: metadataNullableHash(progress.baseRootHash, "capture base root hash"),
		fullRebuild: progress.fullRebuild,
		buildTreeIndex: metadataInteger(progress.buildTreeIndex, "capture build tree index"),
		buildPageIndex: metadataInteger(progress.buildPageIndex, "capture build page index"),
		buildDeltaIndex: metadataInteger(progress.buildDeltaIndex, "capture build delta index"),
	};
}

function parseTreeCheckpoint(value: unknown): TreeCheckpointMetadata {
	const checkpoint = metadataRecord(value, "manifest tree checkpoint");
	assertMetadataKeys(checkpoint, ["rootHash", "entries", "nodes"], "manifest tree checkpoint", ["writtenHashes", "reusedHashes", "reachable"]);
	const rootHash = metadataNullableHash(checkpoint.rootHash, "manifest tree root hash");
	if (rootHash === null) throw new TerminalRecoveryError("corrupt_job_state", "missing manifest tree root hash");
	for (const field of ["writtenHashes", "reusedHashes"] as const) {
		const hashes = checkpoint[field];
		if (hashes !== undefined && (!Array.isArray(hashes)
			|| hashes.some((hash) => metadataNullableHash(hash, `manifest tree ${field}`) === null))) {
			throw new TerminalRecoveryError("corrupt_job_state", `invalid manifest tree ${field}`);
		}
	}
	if (checkpoint.reachable !== undefined && !Array.isArray(checkpoint.reachable)) {
		throw new TerminalRecoveryError("corrupt_job_state", "invalid manifest tree reachable inventory");
	}
	return {
		rootHash,
		entries: metadataInteger(checkpoint.entries, "manifest tree entry count"),
		nodes: metadataInteger(checkpoint.nodes, "manifest tree node count"),
	};
}

function checkpointMetadata(checkpoint: TreeCheckpointMetadata): TreeCheckpointMetadata {
	return { rootHash: checkpoint.rootHash, entries: checkpoint.entries, nodes: checkpoint.nodes };
}

function parseRecoveryTotals(value: unknown): FinalizeCaptureRequest["totals"] {
	const totals = metadataRecord(value, "snapshot totals");
	const fields = ["activeFiles", "deletedFiles", "unavailableFiles", "attachments", "markdownBytes", "attachmentBytes"] as const;
	assertMetadataKeys(totals, fields, "snapshot totals");
	return {
		activeFiles: metadataInteger(totals.activeFiles, "active file total"),
		deletedFiles: metadataInteger(totals.deletedFiles, "deleted file total"),
		unavailableFiles: metadataInteger(totals.unavailableFiles, "unavailable file total"),
		attachments: metadataInteger(totals.attachments, "attachment total"),
		markdownBytes: metadataInteger(totals.markdownBytes, "markdown byte total"),
		attachmentBytes: metadataInteger(totals.attachmentBytes, "attachment byte total"),
	};
}

interface SnapshotRootArtifactMetadata {
	completedAt: number;
	manifestGraphDigest: string;
	manifestNodeCount: number;
	totals: FinalizeCaptureRequest["totals"];
}

function parseSnapshotRootArtifactMetadata(value: unknown): SnapshotRootArtifactMetadata {
	const metadata = metadataRecord(value, "snapshot root artifact");
	assertMetadataKeys(metadata, ["completedAt", "manifestGraphDigest", "manifestNodeCount", "totals"], "snapshot root artifact");
	const manifestGraphDigest = metadataNullableHash(metadata.manifestGraphDigest, "manifest graph digest");
	if (manifestGraphDigest === null) throw new TerminalRecoveryError("corrupt_job_state", "missing manifest graph digest");
	return {
		completedAt: metadataInteger(metadata.completedAt, "snapshot completion time"),
		manifestGraphDigest,
		manifestNodeCount: metadataInteger(metadata.manifestNodeCount, "manifest node count"),
		totals: parseRecoveryTotals(metadata.totals),
	};
}


function requiredMetadata<T>(value: T | null, label: string): T {
	if (value === null) throw new TerminalRecoveryError("corrupt_job_state", `missing ${label}`);
	return value;
}
function parseStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new TerminalRecoveryError("corrupt_job_state", `invalid ${label}`);
	}
	return value.map((item) => metadataString(item, label));
}

function parseRestoreSelection(value: unknown): RestoreDescriptor["selection"] {
	const selection = metadataRecord(value, "restore selection");
	if (selection.kind === "all") {
		assertMetadataKeys(selection, ["kind"], "restore selection");
		return { kind: "all" };
	}
	if (selection.kind === "markdown-paths" || selection.kind === "attachment-paths") {
		assertMetadataKeys(selection, ["kind", "paths"], "restore selection");
		return { kind: selection.kind, paths: parseStringArray(selection.paths, "restore paths") };
	}
	if (selection.kind === "deleted-identities") {
		assertMetadataKeys(selection, ["kind", "bodyIds"], "restore selection");
		return { kind: "deleted-identities", bodyIds: parseStringArray(selection.bodyIds, "restore body IDs") };
	}
	throw new TerminalRecoveryError("corrupt_job_state", "invalid restore selection kind");
}

function parseStoredDescriptor(record: RecoveryJobRecord, value: unknown): RecoveryJobDescriptor {
	const descriptor = metadataRecord(value, "job descriptor");
	const baseKeys = ["vaultId", "vaultGeneration", "createdAt", "capabilityExpiresAt"] as const;
	const vaultId = metadataString(descriptor.vaultId, "descriptor vault ID");
	const vaultGeneration = metadataString(descriptor.vaultGeneration, "descriptor vault generation");
	const createdAt = metadataInteger(descriptor.createdAt, "descriptor creation time");
	const storedCapabilityExpiresAt = metadataInteger(descriptor.capabilityExpiresAt, "descriptor capability expiry");
	if (!isCanonicalVaultId(vaultId) || !isCanonicalVaultId(vaultGeneration)
		|| vaultId !== record.vaultId || vaultGeneration !== record.vaultGeneration
		|| !record.capability || record.capabilityExpiresAt === null
		|| storedCapabilityExpiresAt <= createdAt || record.capabilityExpiresAt <= createdAt) {
		throw new TerminalRecoveryError("corrupt_job_state", "job descriptor identity mismatch");
	}
	const common = { vaultId, vaultGeneration, createdAt, capability: record.capability, capabilityExpiresAt: record.capabilityExpiresAt };
	if (record.kind === "capture") {
		assertMetadataKeys(descriptor, [...baseKeys, "captureId", "snapshotId", "boundarySequence", "rootGeneration", "runtimeEpoch", "reason", "pinSoftExpiresAt", "pinHardExpiresAt"], "capture descriptor");
		if (descriptor.reason !== "initial" && descriptor.reason !== "daily" && descriptor.reason !== "manual" && descriptor.reason !== "pre-bulk-operation") {
			throw new TerminalRecoveryError("corrupt_job_state", "invalid capture reason");
		}
		const boundarySequence = metadataInteger(descriptor.boundarySequence, "capture boundary sequence");
		if (boundarySequence !== record.boundarySequence) throw new TerminalRecoveryError("corrupt_job_state", "capture boundary mismatch");
		return {
			...common,
			captureId: metadataString(descriptor.captureId, "capture ID"),
			snapshotId: metadataString(descriptor.snapshotId, "snapshot ID"),
			boundarySequence,
			rootGeneration: metadataInteger(descriptor.rootGeneration, "capture root generation"),
			runtimeEpoch: metadataString(descriptor.runtimeEpoch, "capture runtime epoch"),
			reason: descriptor.reason,
			pinSoftExpiresAt: metadataInteger(descriptor.pinSoftExpiresAt, "capture soft pin expiry"),
			pinHardExpiresAt: metadataInteger(descriptor.pinHardExpiresAt, "capture hard pin expiry"),
		};
	}
	if (record.kind === "projection") {
		assertMetadataKeys(descriptor, [...baseKeys, "leaseId"], "projection descriptor");
		return { ...common, leaseId: metadataString(descriptor.leaseId, "projection lease ID") };
	}
	if (record.kind === "restore") {
		assertMetadataKeys(descriptor, [...baseKeys, "restoreId", "snapshotId", "selection"], "restore descriptor");
		return {
			...common,
			restoreId: metadataString(descriptor.restoreId, "restore ID"),
			snapshotId: metadataString(descriptor.snapshotId, "snapshot ID"),
			selection: parseRestoreSelection(descriptor.selection),
		};
	}
	if (record.kind === "gc") {
		assertMetadataKeys(descriptor, [...baseKeys, "epoch", "markStartedAt", "deadlineAt", "gracePeriodMs", "domains"], "GC descriptor");
		const domains = parseStringArray(descriptor.domains, "GC domains");
		if (domains.some((domain) => domain !== "recovery" && domain !== "blob")) {
			throw new TerminalRecoveryError("corrupt_job_state", "invalid GC domains");
		}
		const typedDomains: Array<"recovery" | "blob"> = [];
		for (const domain of domains) typedDomains.push(domain === "recovery" ? "recovery" : "blob");
		return {
			...common,
			epoch: metadataInteger(descriptor.epoch, "GC epoch"),
			markStartedAt: metadataInteger(descriptor.markStartedAt, "GC mark start"),
			deadlineAt: metadataInteger(descriptor.deadlineAt, "GC deadline"),
			gracePeriodMs: metadataInteger(descriptor.gracePeriodMs, "GC grace period"),
			domains: typedDomains,
		};
	}
	assertMetadataKeys(descriptor, [...baseKeys, "allowedPrefixes", "deletionId"], "purge descriptor");
	return {
		...common,
		allowedPrefixes: parseStringArray(descriptor.allowedPrefixes, "purge prefixes"),

		deletionId: metadataString(descriptor.deletionId, "purge deletion ID"),
	};
}
function parseBodyDefectRetry(value: unknown): { key: string; attempts: number } {
	const retry = metadataRecord(value, "body defect retry");
	assertMetadataKeys(retry, ["key", "attempts"], "body defect retry");
	return {
		key: metadataString(retry.key, "body defect retry key"),
		attempts: metadataInteger(retry.attempts, "body defect retry attempts"),
	};
}

function parseCursorMetadata(value: unknown, label: string): { cursor: string | null } {
	const metadata = metadataRecord(value, label);
	assertMetadataKeys(metadata, ["cursor"], label);
	return { cursor: rpcNullableString(metadata.cursor, `${label} cursor`) };
}

function parseIndexMetadata(value: unknown, label: string, field: "index" | "prefixIndex"): number {
	const metadata = metadataRecord(value, label);
	assertMetadataKeys(metadata, [field], label);
	return metadataInteger(metadata[field], `${label} index`);
}

function parseRestoreLeaf(value: unknown): { nodeHash: string; index: number } {
	const leaf = metadataRecord(value, "restore leaf");
	assertMetadataKeys(leaf, ["nodeHash", "index"], "restore leaf");
	return { nodeHash: rpcHash(leaf.nodeHash, "restore leaf node hash"), index: metadataInteger(leaf.index, "restore leaf index") };
}

function parseGcSweepMetadata(value: unknown): { domainIndex: number; cursor: string | null } {
	const sweep = metadataRecord(value, "GC sweep progress");
	assertMetadataKeys(sweep, ["domainIndex", "cursor"], "GC sweep progress");
	return {
		domainIndex: metadataInteger(sweep.domainIndex, "GC sweep domain index"),
		cursor: rpcNullableString(sweep.cursor, "GC sweep cursor"),
	};
}

function descriptorKind(descriptor: RecoveryJobDescriptor): "capture" | "projection" | "restore" | "gc" | "purge" {
	if ("captureId" in descriptor) return "capture";
	if ("leaseId" in descriptor) return "projection";
	if ("restoreId" in descriptor) return "restore";
	if ("epoch" in descriptor) return "gc";
	return "purge";
}

function retryDelay(retryCount: number): number {
	const exponent = Math.min(20, Math.max(0, retryCount));
	const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** exponent));
	const random = new Uint32Array(1);
	crypto.getRandomValues(random);
	return Math.floor((random[0]! / 0x1_0000_0000) * ceiling);
}

function isRetryableFailure(error: unknown): boolean {
	if (error instanceof RetryableRecoveryError) return true;
	if (error instanceof TerminalRecoveryError) return false;
	const message = error instanceof Error ? error.message : String(error);
	return /(?:10001|timeout|timed out|temporar|overload|\b5\d\d\b|network|fetch failed|internal error;\s*reference)/i.test(message);
}

async function objectBytes(object: R2ObjectBody): Promise<Uint8Array> {
	return new Uint8Array(await object.arrayBuffer());
}

async function mapFour<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(MAX_R2_IN_FLIGHT, items.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			await worker(items[index]!);
		}
	});
	await Promise.all(workers);
}

function vaultPrefix(vaultId: string, vaultGeneration: string): string {
	if (!isCanonicalVaultId(vaultId) || !isCanonicalVaultId(vaultGeneration)) {
		throw new TerminalRecoveryError("invalid_vault_identity", "invalid vault generation identity");
	}
	return `vault/${encodeURIComponent(vaultId)}/${encodeURIComponent(vaultGeneration)}`;
}

function blobObjectKey(vaultId: string, vaultGeneration: string, hash: string): string {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new TerminalRecoveryError("invalid_hash", "invalid attachment hash");
	return `${vaultPrefix(vaultId, vaultGeneration)}/blobs/${hash}`;
}

export function isRecoveryGcSweepCandidate(
	uploadedAt: number,
	markStartedAt: number,
	now: number,
	gracePeriodMs: number,
): boolean {
	const graceCutoff = now - Math.max(GC_GRACE_MS, gracePeriodMs);
	return uploadedAt < markStartedAt && uploadedAt < graceCutoff;
}

export async function putCreateOnlyRecoveryRoot(
	bucket: R2Bucket,
	objectKey: string,
	canonicalBytes: Uint8Array,
	expectedHash: string,
): Promise<void> {
	const existing = await bucket.get(objectKey);
	if (existing) {
		await parseAndVerifySnapshotRoot(await objectBytes(existing), expectedHash);
		return;
	}
	const written = await bucket.put(objectKey, canonicalBytes, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType: "application/json" },
	});
	if (written !== null) return;
	const raced = await bucket.get(objectKey);
	if (!raced) throw new RetryableRecoveryError("root_put_lost", "snapshot root create response lost");
	await parseAndVerifySnapshotRoot(await objectBytes(raced), expectedHash);
}

export function canCancelRecoveryJob(state: RecoveryJobRecord["state"]): boolean {
	return !isTerminalRecoveryState(state);
}

export function recoveryRestoreProgress(total: number, terminal: number): { processedEntries: number; totalEntries: number; complete: boolean } {
	if (!Number.isSafeInteger(total) || !Number.isSafeInteger(terminal) || total < 0 || terminal < 0 || terminal > total) {
		throw new Error("invalid restore progress");
	}
	return { processedEntries: terminal, totalEntries: total, complete: terminal === total };
}

export function advanceRecoveryPurgeProgress(
	prefixIndex: number,
	listedObjects: number,
): { prefixIndex: number; pageComplete: boolean } {
	if (!Number.isSafeInteger(prefixIndex) || prefixIndex < 0 || !Number.isSafeInteger(listedObjects) || listedObjects < 0) {
		throw new Error("invalid purge progress");
	}
	return listedObjects === 0
		? { prefixIndex: prefixIndex + 1, pageComplete: true }
		: { prefixIndex, pageComplete: false };
}

export function recoveryProjectionPageAction(
	entryCount: number,
	terminal: boolean,
	nextCursor: string | null,
): { kind: "work" } | { kind: "sleep" } | { kind: "advance"; cursor: string } {
	if (entryCount > 0) return { kind: "work" };
	if (terminal) return { kind: "sleep" };
	if (nextCursor === null) throw new Error("non-terminal projection page omitted its cursor");
	return { kind: "advance", cursor: nextCursor };
}

export function shouldTraverseRecoveryGcObject(
	domain: "recovery" | "blob" | "staging",
	objectKey: string,
	tree: ManifestTreeKind | undefined,
): boolean {
	return domain === "recovery" && (objectKey.includes("/roots/sha256/") || tree !== undefined);
}

export async function createFailedRestoreItem(
	restoreId: string,
	tree: ManifestTreeKind,
	selectionKey: string,
	entry: ManifestEntryByTree[ManifestTreeKind] | null,
	cursorOrder: number,
): Promise<StoredRestoreItem> {
	let path = selectionKey;
	let contentHash = "0".repeat(64);
	let size = 0;
	let metadata: Record<string, unknown>;
	if (tree === "attachments") {
		const attachment = entry as Extract<AttachmentManifestEntry, { availability: "unavailable" }> | null;
		if (attachment) {
			path = attachment.path;
			contentHash = attachment.expectedHash;
			size = attachment.expectedSize;
		}
		metadata = { mime: attachment?.mime ?? null };
	} else if (tree === "deleted") {
		const deleted = entry as Extract<DeletedFileManifestEntry, { availability: "unavailable" }> | null;
		if (deleted) path = deleted.lastPath;
		metadata = {
			sourceKind: "deleted",
			sourceFileId: deleted?.fileId ?? "",
			sourceBodyId: deleted?.bodyId ?? selectionKey,
		};
	} else {
		const active = entry as Extract<ActiveFileManifestEntry, { availability: "unavailable" }> | null;
		if (active) path = active.path;
		metadata = {
			sourceKind: "active",
			sourceFileId: active?.fileId ?? "",
			sourceBodyId: active?.bodyId ?? "",
		};
	}
	const errorCode = entry && "errorCode" in entry ? entry.errorCode : "snapshot_item_missing";
	return {
		itemId: (await sha256Hex(encoder.encode(`${restoreId}:${tree}:${selectionKey}:${errorCode}`))).slice(0, 48),
		cursorOrder,
		kind: tree === "attachments" ? "attachment" : "markdown",
		path,
		contentHash,
		size,
		outcome: "failed",
		errorCode,
		metadata,
	};
}
function rpcBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new TerminalRecoveryError("invalid_authority_response", `invalid ${label}`);
	return value;
}

function rpcNullableString(value: unknown, label: string): string | null {
	if (value === null) return null;
	return metadataString(value, label);
}

function rpcHash(value: unknown, label: string): string {
	const hash = metadataNullableHash(value, label);
	if (hash === null) throw new TerminalRecoveryError("invalid_authority_response", `missing ${label}`);
	return hash;
}

function parseCapturePlanEntry(value: unknown): CapturePlanEntry {
	const entry = metadataRecord(value, "capture plan entry");
	if (entry.kind === "active") {
		assertMetadataKeys(entry, ["kind", "bodyId", "fileId", "canonicalPath", "generation", "contentHash", "size"], "active capture plan entry");
		return {
			kind: "active",
			bodyId: metadataString(entry.bodyId, "active body ID"),
			fileId: metadataString(entry.fileId, "active file ID"),
			canonicalPath: metadataString(entry.canonicalPath, "active canonical path"),
			generation: metadataInteger(entry.generation, "active generation"),
			contentHash: rpcHash(entry.contentHash, "active content hash"),
			size: metadataInteger(entry.size, "active content size"),
		};
	}
	if (entry.kind === "deleted") {
		assertMetadataKeys(entry, ["kind", "bodyId", "fileId", "lastPath", "generation", "baselineContentHash", "baselineSize", "bodyReaped", "deletedAtSequence"], "deleted capture plan entry");
		return {
			kind: "deleted",
			bodyId: metadataString(entry.bodyId, "deleted body ID"),
			fileId: metadataString(entry.fileId, "deleted file ID"),
			lastPath: metadataString(entry.lastPath, "deleted path"),
			generation: metadataInteger(entry.generation, "deleted generation"),
			baselineContentHash: rpcHash(entry.baselineContentHash, "deleted baseline hash"),
			baselineSize: metadataInteger(entry.baselineSize, "deleted baseline size"),
			bodyReaped: rpcBoolean(entry.bodyReaped, "deleted body reap state"),
			deletedAtSequence: metadataInteger(entry.deletedAtSequence, "deleted sequence"),
		};
	}
	if (entry.kind === "attachment") {
		assertMetadataKeys(entry, ["kind", "canonicalPath", "contentHash", "size", "mime"], "attachment capture plan entry");
		return {
			kind: "attachment",
			canonicalPath: metadataString(entry.canonicalPath, "attachment path"),
			contentHash: rpcHash(entry.contentHash, "attachment content hash"),
			size: metadataInteger(entry.size, "attachment size"),
			mime: entry.mime === null ? null : metadataString(entry.mime, "attachment MIME type"),
		};
	}
	throw new TerminalRecoveryError("invalid_authority_response", "invalid capture plan entry kind");
}

function parseCapturePlanResponse(value: unknown): CapturePlanResponse {
	const page = metadataRecord(value, "capture plan response");
	assertMetadataKeys(page, ["entries", "casHints", "nextCursor", "terminal", "pageHash", "planDigest"], "capture plan response");
	if (!Array.isArray(page.entries)) throw new TerminalRecoveryError("invalid_authority_response", "invalid capture plan entries");
	const hints = metadataRecord(page.casHints, "capture CAS hints");
	const casHints: Record<string, boolean> = {};
	for (const [key, hint] of Object.entries(hints)) casHints[key] = rpcBoolean(hint, "capture CAS hint");
	return {
		entries: page.entries.map(parseCapturePlanEntry),
		casHints,
		nextCursor: rpcNullableString(page.nextCursor, "capture plan cursor"),
		terminal: rpcBoolean(page.terminal, "capture plan terminal state"),
		pageHash: rpcHash(page.pageHash, "capture plan page hash"),
		planDigest: rpcHash(page.planDigest, "capture plan digest"),
	};
}

function parseRecipeDescriptor(value: unknown): BodyRecipeDescriptor {
	const descriptor = metadataRecord(value, "recipe descriptor");
	assertMetadataKeys(descriptor, ["recipeId", "bodyId", "generation", "expectedContentHash", "expectedSize", "encodedHistoryBytes", "firstCursor"], "recipe descriptor");
	return {
		recipeId: metadataString(descriptor.recipeId, "recipe ID"),
		bodyId: metadataString(descriptor.bodyId, "recipe body ID"),
		generation: metadataInteger(descriptor.generation, "recipe generation"),
		expectedContentHash: rpcHash(descriptor.expectedContentHash, "recipe content hash"),
		expectedSize: metadataInteger(descriptor.expectedSize, "recipe expected size"),
		encodedHistoryBytes: metadataInteger(descriptor.encodedHistoryBytes, "recipe encoded byte count"),
		firstCursor: metadataString(descriptor.firstCursor, "recipe cursor"),
	};
}

function parseRecipeChunk(value: unknown): RecipeChunk {
	const chunk = metadataRecord(value, "recipe chunk");
	assertMetadataKeys(chunk, ["recipeId", "cursor", "nextCursor", "parts", "encodedBytes"], "recipe chunk");
	if (!Array.isArray(chunk.parts)) throw new TerminalRecoveryError("invalid_authority_response", "invalid recipe chunk parts");
	const parts = chunk.parts.map((candidate) => {
		const part = metadataRecord(candidate, "recipe chunk part");
		assertMetadataKeys(part, ["kind", "sequence", "update"], "recipe chunk part");
		let kind: "checkpoint" | "journal";
		if (part.kind === "checkpoint") kind = "checkpoint";
		else if (part.kind === "journal") kind = "journal";
		else throw new TerminalRecoveryError("invalid_authority_response", "invalid recipe chunk part kind");
		if (!(part.update instanceof Uint8Array)) throw new TerminalRecoveryError("invalid_authority_response", "invalid recipe chunk update");
		return { kind, sequence: metadataInteger(part.sequence, "recipe chunk sequence"), update: part.update };
	});
	return {
		recipeId: metadataString(chunk.recipeId, "recipe chunk ID"),
		cursor: metadataString(chunk.cursor, "recipe chunk cursor"),
		nextCursor: rpcNullableString(chunk.nextCursor, "next recipe cursor"),
		parts,
		encodedBytes: metadataInteger(chunk.encodedBytes, "recipe chunk encoded byte count"),
	};
}

function parseMaterializationLease(value: unknown): MaterializationLease {
	const lease = metadataRecord(value, "materialization lease");
	assertMetadataKeys(lease, ["leaseId", "ownerKind", "ownerId", "objectKeys", "expiresAt"], "materialization lease");
	if (lease.ownerKind !== "capture" && lease.ownerKind !== "projection") throw new TerminalRecoveryError("invalid_authority_response", "invalid materialization lease owner");
	return {
		leaseId: metadataString(lease.leaseId, "materialization lease ID"),
		ownerKind: lease.ownerKind,
		ownerId: metadataString(lease.ownerId, "materialization lease owner ID"),
		objectKeys: parseStringArray(lease.objectKeys, "materialization lease object keys"),
		expiresAt: metadataInteger(lease.expiresAt, "materialization lease expiry"),
	};
}

function parseCoverageResponse(value: unknown): CoverageCheckResponse {
	const coverage = metadataRecord(value, "coverage response");
	assertMetadataKeys(coverage, ["missingContentHashes", "missingNodeHashes"], "coverage response");
	return {
		missingContentHashes: parseStringArray(coverage.missingContentHashes, "missing content hashes").map((hash) => rpcHash(hash, "missing content hash")),
		missingNodeHashes: parseStringArray(coverage.missingNodeHashes, "missing node hashes").map((hash) => rpcHash(hash, "missing node hash")),
	};
}

function parseIncrementalBase(value: unknown): IncrementalBase | null {
	if (value === null) return null;
	const base = metadataRecord(value, "incremental base");
	assertMetadataKeys(base, ["snapshotId", "boundarySequence", "rootKey", "rootHash"], "incremental base");
	return {
		snapshotId: metadataString(base.snapshotId, "incremental base snapshot ID"),
		boundarySequence: metadataInteger(base.boundarySequence, "incremental base boundary"),
		rootKey: metadataString(base.rootKey, "incremental base root key"),
		rootHash: rpcHash(base.rootHash, "incremental base root hash"),
	};
}

function parseCatalogDeltaResponse(value: unknown): CatalogDeltaPageResponse {
	const page = metadataRecord(value, "catalog delta response");
	assertMetadataKeys(page, ["entries", "nextCursor", "terminal", "pageHash", "deltaDigest"], "catalog delta response");
	if (!Array.isArray(page.entries)) throw new TerminalRecoveryError("invalid_authority_response", "invalid catalog delta entries");
	const entries = page.entries.map((candidate) => {
		const entry = metadataRecord(candidate, "catalog delta entry");
		assertMetadataKeys(entry, ["sequence", "order", "kind", "identity", "path", "previousPath", "contentHash", "size", "mime"], "catalog delta entry");
		let kind: "create" | "rename" | "delete" | "revive" | "body-hash" | "attachment-upsert" | "attachment-delete";
		if (entry.kind === "create" || entry.kind === "rename" || entry.kind === "delete" || entry.kind === "revive"
			|| entry.kind === "body-hash" || entry.kind === "attachment-upsert" || entry.kind === "attachment-delete") {
			kind = entry.kind;
		} else {
			throw new TerminalRecoveryError("invalid_authority_response", "invalid catalog delta kind");
		}
		return {
			sequence: metadataInteger(entry.sequence, "catalog delta sequence"),
			order: metadataInteger(entry.order, "catalog delta order"),
			kind,
			identity: metadataString(entry.identity, "catalog delta identity"),
			path: metadataString(entry.path, "catalog delta path"),
			previousPath: rpcNullableString(entry.previousPath, "catalog delta previous path"),
			contentHash: entry.contentHash === null ? null : rpcHash(entry.contentHash, "catalog delta content hash"),
			size: entry.size === null ? null : metadataInteger(entry.size, "catalog delta size"),
			mime: entry.mime === null ? null : metadataString(entry.mime, "catalog delta MIME type"),
		};
	});
	return {
		entries,
		nextCursor: rpcNullableString(page.nextCursor, "catalog delta cursor"),
		terminal: rpcBoolean(page.terminal, "catalog delta terminal state"),
		pageHash: rpcHash(page.pageHash, "catalog delta page hash"),
		deltaDigest: rpcHash(page.deltaDigest, "catalog delta digest"),
	};
}

function parseProjectionWorkPage(value: unknown): ProjectionWorkPage {
	const page = metadataRecord(value, "projection work page");
	assertMetadataKeys(page, ["entries", "nextCursor", "terminal"], "projection work page");
	if (!Array.isArray(page.entries)) throw new TerminalRecoveryError("invalid_authority_response", "invalid projection work entries");
	return {
		entries: page.entries.map((candidate) => {
			const entry = metadataRecord(candidate, "projection work entry");
			assertMetadataKeys(entry, ["bodyId", "generation", "contentHash", "size"], "projection work entry");
			return {
				bodyId: metadataString(entry.bodyId, "projection body ID"),
				generation: metadataInteger(entry.generation, "projection generation"),
				contentHash: rpcHash(entry.contentHash, "projection content hash"),
				size: metadataInteger(entry.size, "projection content size"),
			};
		}),
		nextCursor: rpcNullableString(page.nextCursor, "projection work cursor"),
		terminal: rpcBoolean(page.terminal, "projection terminal state"),
	};
}

function parseGcRootPage(value: unknown): GcRootPage {
	const page = metadataRecord(value, "GC root page");
	assertMetadataKeys(page, ["roots", "marks", "nextCursor", "terminal"], "GC root page");
	if (!Array.isArray(page.roots) || !Array.isArray(page.marks)) throw new TerminalRecoveryError("invalid_authority_response", "invalid GC root page entries");
	return {
		roots: page.roots.map((candidate) => {
			const root = metadataRecord(candidate, "GC root");
			assertMetadataKeys(root, ["objectKey", "domain"], "GC root");
			if (root.domain !== "recovery" && root.domain !== "blob") throw new TerminalRecoveryError("invalid_authority_response", "invalid GC root domain");
			return { objectKey: metadataString(root.objectKey, "GC root object key"), domain: root.domain };
		}),
		marks: page.marks.map((candidate) => {
			const mark = metadataRecord(candidate, "GC mark");
			assertMetadataKeys(mark, ["objectKeyHash", "domain"], "GC mark");
			if (mark.domain !== "recovery" && mark.domain !== "blob" && mark.domain !== "staging") throw new TerminalRecoveryError("invalid_authority_response", "invalid GC mark domain");
			return { objectKeyHash: rpcHash(mark.objectKeyHash, "GC mark object key hash"), domain: mark.domain };
		}),
		nextCursor: rpcNullableString(page.nextCursor, "GC root cursor"),
		terminal: rpcBoolean(page.terminal, "GC root terminal state"),
	};
}

function parseSweepLease(value: unknown): SweepLease {
	const lease = metadataRecord(value, "sweep lease");
	assertMetadataKeys(lease, ["leaseId", "epoch", "ownerId", "domain", "approvedKeys", "expiresAt"], "sweep lease");
	let domain: "recovery" | "blob";
	if (lease.domain === "recovery") domain = "recovery";
	else if (lease.domain === "blob") domain = "blob";
	else throw new TerminalRecoveryError("invalid_authority_response", "invalid sweep lease domain");
	return {
		leaseId: metadataString(lease.leaseId, "sweep lease ID"),
		epoch: metadataInteger(lease.epoch, "sweep lease epoch"),
		ownerId: metadataString(lease.ownerId, "sweep lease owner ID"),
		domain,
		approvedKeys: parseStringArray(lease.approvedKeys, "sweep lease approved keys"),
		expiresAt: metadataInteger(lease.expiresAt, "sweep lease expiry"),
	};
}

function parseLeaseStatus(value: unknown): LeaseStatus {
	const status = metadataRecord(value, "recovery lease status");
	assertMetadataKeys(status, ["valid", "captureId", "boundarySequence", "state", "softExpiresAt", "hardExpiresAt", "baseSnapshotId"], "recovery lease status");
	if (status.valid !== true) throw new TerminalRecoveryError("invalid_authority_response", "invalid recovery lease");
	return {
		valid: true,
		captureId: metadataString(status.captureId, "lease capture ID"),
		boundarySequence: metadataInteger(status.boundarySequence, "lease boundary"),
		state: metadataString(status.state, "lease state"),
		softExpiresAt: metadataInteger(status.softExpiresAt, "lease soft expiry"),
		hardExpiresAt: metadataInteger(status.hardExpiresAt, "lease hard expiry"),
		baseSnapshotId: rpcNullableString(status.baseSnapshotId, "lease base snapshot ID"),
	};
}

function parseFinalizedCapture(value: unknown): FinalizedCapture {
	const finalized = metadataRecord(value, "finalized capture");
	assertMetadataKeys(finalized, ["snapshotId", "rootKey", "rootHash", "completedAt", "state"], "finalized capture");
	if (finalized.state !== "complete") throw new TerminalRecoveryError("invalid_authority_response", "invalid finalized capture state");
	return {
		snapshotId: metadataString(finalized.snapshotId, "finalized snapshot ID"),
		rootKey: metadataString(finalized.rootKey, "finalized root key"),
		rootHash: rpcHash(finalized.rootHash, "finalized root hash"),
		completedAt: metadataInteger(finalized.completedAt, "finalized completion time"),
		state: "complete",
	};
}

function parseRestoreAuthority(value: unknown): {
	rootKey: string;
	rootHash: string;
	selection: RestoreDescriptor["selection"];
	capabilityExpiresAt: number;
} {
	const authority = metadataRecord(value, "restore authority");
	assertMetadataKeys(authority, ["rootKey", "rootHash", "selection", "capabilityExpiresAt"], "restore authority");
	return {
		rootKey: metadataString(authority.rootKey, "restore root key"),
		rootHash: rpcHash(authority.rootHash, "restore root hash"),
		selection: parseRestoreSelection(authority.selection),
		capabilityExpiresAt: metadataInteger(authority.capabilityExpiresAt, "restore authority expiry"),
	};
}

function requireNullAuthorityResponse(value: unknown, method: keyof RecoveryAuthorityRpc): void {
	if (value !== null) throw new TerminalRecoveryError("invalid_authority_response", `invalid ${method} acknowledgement`);
}

function parseStagedDelta(value: unknown): { kind: string; identity: string; path: string; previousPath: string | null } {
	const delta = metadataRecord(value, "staged catalog delta");
	if (delta.kind !== "create" && delta.kind !== "rename" && delta.kind !== "delete" && delta.kind !== "revive"
		&& delta.kind !== "body-hash" && delta.kind !== "attachment-upsert" && delta.kind !== "attachment-delete") {
		throw new TerminalRecoveryError("staging_corrupt", "invalid staged catalog delta kind");
	}
	return {
		kind: delta.kind,
		identity: metadataString(delta.identity, "staged catalog delta identity"),
		path: metadataString(delta.path, "staged catalog delta path"),
		previousPath: rpcNullableString(delta.previousPath, "staged catalog delta previous path"),
	};
}

const RECOVERY_AUTHORITY_METHODS: Record<keyof RecoveryAuthorityRpc, true> = {
	checkRecoveryJobLease: true,
	getCapturePlanPage: true,
	getRecipeDescriptors: true,
	getRecipeChunk: true,
	acquireMaterializationLease: true,
	releaseMaterializationLease: true,
	acknowledgeContentMaterialized: true,
	acknowledgeManifestNodesMaterialized: true,
	resetCaptureDelta: true,
	checkRecoveryCoverage: true,
	getIncrementalBase: true,
	getCatalogDeltaPage: true,
	recordRecoveryDefects: true,
	finalizeCapture: true,
	acknowledgeJobCancelled: true,
	getProjectionWorkPage: true,
	getProjectionRecipeDescriptor: true,
	getProjectionRecipeChunk: true,
	acknowledgeProjectionContentMaterialized: true,
	validateRestoreAuthority: true,
	completeRestore: true,
	getGcRootPage: true,
	completeGcMark: true,
	acquireSweepLease: true,
	releaseSweepLease: true,
	invalidateSweptObjects: true,
	completeGcSweep: true,
	abortRecoveryGc: true,
};

async function callRecoveryAuthority(
	stub: DurableObjectStub,
	vaultId: string,
	vaultGeneration: string,
	method: keyof RecoveryAuthorityRpc,
	params: unknown,
): Promise<unknown> {
	if (RECOVERY_AUTHORITY_METHODS[method] !== true) throw new Error("unsupported recovery authority method");
	const requestBytes = encoder.encode(JSON.stringify({
		method,
		params: encodeRecoveryRpcPayload(params),
	}));
	if (requestBytes.byteLength > RECOVERY_RPC_MAX_JSON_BYTES) throw new Error("recovery RPC request exceeds byte bound");
	const response = await stub.fetch(new Request(`https://internal${RECOVERY_RPC_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[RECOVERY_RPC_HEADER]: "1",
			"x-yaos-vault-id": vaultId,
			"x-yaos-vault-generation": vaultGeneration,
		},
		body: requestBytes,
	}));
	const responseBytes = new Uint8Array(await response.arrayBuffer());
	if (responseBytes.byteLength > RECOVERY_RPC_MAX_JSON_BYTES) throw new Error("recovery RPC response exceeds byte bound");
	let envelope: unknown;
	try {
		envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(responseBytes));
	} catch {
		throw new Error(`recovery RPC returned invalid JSON (${response.status})`);
	}
	const record = metadataRecord(envelope, "recovery RPC envelope");
	if (record.ok !== true) {
		const error = metadataRecord(record.error, "recovery RPC error");
		const message = typeof error.message === "string" ? error.message.slice(0, 512) : `HTTP ${response.status}`;
		throw new Error(`recovery RPC ${method} failed: ${message}`);
	}
	assertMetadataKeys(record, ["ok", "result"], "recovery RPC success envelope");
	return decodeRecoveryRpcPayload(record.result);
}

class DirectR2Artifacts implements ImmutableArtifactStore {
	constructor(private readonly bucket: R2Bucket) {}

	async exists(key: string): Promise<boolean> {
		return await this.bucket.head(key) !== null;
	}

	async get(key: string): Promise<Uint8Array | null> {
		const object = await this.bucket.get(key);
		return object ? objectBytes(object) : null;
	}

	async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
		await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}
}

class CaptureManifestStore implements ManifestNodeStore {
	private readonly base: R2ManifestNodeStore;
	private readonly queuedWrites = new Map<string, EncodedManifestNode>();

	constructor(
		artifacts: ImmutableArtifactStore,
		private readonly authority: RecoveryAuthorityRpc,
		private readonly state: RecoveryJobStateStore,
		private readonly descriptor: CaptureStartDescriptor,
		private readonly prefix: string,
	) {
		this.base = new R2ManifestNodeStore(artifacts, prefix);
	}

	readNode(hash: string): Promise<Uint8Array | null> {
		return this.base.readNode(hash);
	}

	async writeNode(node: EncodedManifestNode): Promise<"written" | "reused"> {
		const existing = this.state.getArtifact("manifest-object", node.hash);
		if (existing) return existing.metadata?.written === true ? "written" : "reused";
		if (this.queuedWrites.has(node.hash)) return "reused";
		this.queuedWrites.set(node.hash, node);
		return "written";
	}

	async flush(): Promise<void> {
		while (this.queuedWrites.size > 0) {
			const nodes = [...this.queuedWrites.values()].slice(0, 64);
			const lease = await this.authority.acquireMaterializationLease({
				ownerKind: "capture",
				ownerId: this.descriptor.captureId,
				capability: this.descriptor.capability,
				objectKeys: nodes.map((node) => node.objectKey),
			});
			try {
				await mapFour(nodes, async (node) => {
					const outcome = await this.base.writeNode(node);
					this.state.putArtifact({
						artifactKind: "manifest-object",
						logicalKey: node.hash,
						objectKey: node.objectKey,
						objectHash: node.hash,
						entries: node.subtreeEntries,
						bytes: node.canonicalBytes.byteLength,
						metadata: { written: outcome === "written", format: node.format },
					});
				});
			} finally {
				await this.authority.releaseMaterializationLease(lease.leaseId);
			}
			for (const node of nodes) this.queuedWrites.delete(node.hash);
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging -- Workers RPC requires an exported branded class type.
export interface RecoveryJob extends Rpc.DurableObjectBranded {}

/** Alarm-driven, SQLite-backed recovery worker. Public Worker routes never reach fetch(). */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- Merge the Workers RPC brand into the runtime class.
export class RecoveryJob implements DurableObject {
	private readonly store: RecoveryJobStateStore;

	private deferredAlarmAt: number | null = null;
	constructor(private readonly ctx: DurableObjectState, private readonly env: RecoveryJobEnvironment) {
		this.store = new RecoveryJobStateStore(ctx.storage);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.headers.get(RECOVERY_RPC_HEADER) !== "1") return new Response("not found", { status: 404 });
		const routedVaultId = request.headers.get("x-yaos-vault-id");
		const routedVaultGeneration = request.headers.get("x-yaos-vault-generation");
		if (!isCanonicalVaultId(routedVaultId) || !isCanonicalVaultId(routedVaultGeneration)) {
			return new Response("not found", { status: 404 });
		}
		const existing = this.store.load();
		if (existing && (existing.vaultId !== routedVaultId || existing.vaultGeneration !== routedVaultGeneration)) {
			return new Response("not found", { status: 404 });
		}
		const route = url.pathname;
		try {
			if (route === "/__yaos/recovery-job/initialization" && request.method === "GET") {
				return Response.json(await this.getInitialization());
			}
			if (route === "/__yaos/recovery-job/status" && request.method === "GET") {
				return Response.json(await this.getStatus());
			}
			if (route === "/__yaos/recovery-job/initialize" && request.method === "POST") {
				const descriptor = await this.readJobRequest<RecoveryJobDescriptor>(request);
				if (descriptor.vaultId !== routedVaultId || descriptor.vaultGeneration !== routedVaultGeneration) return new Response("not found", { status: 404 });
				return Response.json(await this.initialize(descriptor));
			}
			if (route === "/__yaos/recovery-job/cancel" && request.method === "POST") {
				await this.cancel();
				return Response.json(null);
			}
			if (route === "/__yaos/recovery-job/projection/refresh" && request.method === "POST") {
				const descriptor = await this.readJobRequest<ProjectionDescriptor>(request);
				if (descriptor.vaultId !== routedVaultId || descriptor.vaultGeneration !== routedVaultGeneration) return new Response("not found", { status: 404 });
				return Response.json(await this.refreshProjection(descriptor));
			}
			if (route === "/__yaos/recovery-job/projection/wake" && request.method === "POST") {
				const record = this.store.load();
				if (!record || record.kind !== "projection") throw new Error("projection job is not initialized");
				await this.ctx.storage.setAlarm(Date.now());
				return Response.json(null);
			}
			if (route === "/__yaos/recovery-job/purge/rotate-capability" && request.method === "POST") {
				return Response.json(await this.rotatePurgeCapability(await this.readJobRequest<{
					deletionId: string; capability: string; capabilityExpiresAt: number;
				}>(request)));
			}
			if (route === "/__yaos/recovery-job/purge/wake" && request.method === "POST") {
				await this.wakePurge();
				return Response.json(null);
			}
			if (route === "/__yaos/recovery-job/purge/republish" && request.method === "POST") {
				await this.republishPurge();
				return Response.json(null);
			}
			if (route === "/__yaos/recovery-job/restore/items" && request.method === "POST") {
				return Response.json(await this.listItems(await this.readJobRequest<{ cursor: string | null; limit: number }>(request)));
			}
			if (route === "/__yaos/recovery-job/restore/content" && request.method === "POST") {
				return await this.getItemContent(await this.readJobRequest<{ itemId: string }>(request));
			}
			if (route === "/__yaos/recovery-job/restore/results" && request.method === "POST") {
				return Response.json(await this.recordResults(await this.readJobRequest<{ results: Array<{ itemId: string; outcome: RestoreItemOutcome; errorCode?: string }> }>(request)));
			}
			if (route === "/__yaos/recovery-job/delete-state" && request.method === "POST") {
				await this.deleteState();
				return Response.json(null);
			}
			return new Response("not found", { status: 404 });
		} catch (error) {
			return Response.json({
				error: RecoveryJobStateStore.safeInternalError(error),
			}, { status: error instanceof TerminalRecoveryError ? 422 : 409 });
		}
	}

	private async readJobRequest<T>(request: Request): Promise<T> {
		if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
			throw new Error("recovery job request must be JSON");
		}
		const declared = request.headers.get("content-length");
		if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 1024 * 1024)) {
			throw new Error("recovery job request exceeds byte bound");
		}
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) throw new Error("invalid recovery job request size");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as T;
	}

	private bucket(): R2Bucket {
		if (!this.env.YAOS_BUCKET) throw new RetryableRecoveryError("recovery_storage_unavailable", "recovery bucket unavailable");
		return this.env.YAOS_BUCKET;
	}

	private authority(vaultId: string, vaultGeneration: string): RecoveryAuthorityRpc {
		const stub = this.env.YAOS_SYNC.get(this.env.YAOS_SYNC.idFromName(vaultId));
		const call = (method: keyof RecoveryAuthorityRpc, params: unknown): Promise<unknown> =>
			callRecoveryAuthority(stub, vaultId, vaultGeneration, method, params);
		return {
			checkRecoveryJobLease: async (input) => parseLeaseStatus(await call("checkRecoveryJobLease", input)),
			getCapturePlanPage: async (input) => parseCapturePlanResponse(await call("getCapturePlanPage", input)),
			getRecipeDescriptors: async (input) => {
				const value = await call("getRecipeDescriptors", input);
				if (!Array.isArray(value)) throw new TerminalRecoveryError("invalid_authority_response", "invalid recipe descriptor list");
				return value.map(parseRecipeDescriptor);
			},
			getRecipeChunk: async (input) => parseRecipeChunk(await call("getRecipeChunk", input)),
			acquireMaterializationLease: async (input) => parseMaterializationLease(await call("acquireMaterializationLease", input)),
			releaseMaterializationLease: async (input) => requireNullAuthorityResponse(await call("releaseMaterializationLease", input), "releaseMaterializationLease"),
			acknowledgeContentMaterialized: async (input) => requireNullAuthorityResponse(await call("acknowledgeContentMaterialized", input), "acknowledgeContentMaterialized"),
			acknowledgeManifestNodesMaterialized: async (input) => requireNullAuthorityResponse(await call("acknowledgeManifestNodesMaterialized", input), "acknowledgeManifestNodesMaterialized"),
			resetCaptureDelta: async (input) => requireNullAuthorityResponse(await call("resetCaptureDelta", input), "resetCaptureDelta"),
			checkRecoveryCoverage: async (input) => parseCoverageResponse(await call("checkRecoveryCoverage", input)),
			getIncrementalBase: async (input) => parseIncrementalBase(await call("getIncrementalBase", input)),
			getCatalogDeltaPage: async (input) => parseCatalogDeltaResponse(await call("getCatalogDeltaPage", input)),
			recordRecoveryDefects: async (input) => requireNullAuthorityResponse(await call("recordRecoveryDefects", input), "recordRecoveryDefects"),
			finalizeCapture: async (input) => parseFinalizedCapture(await call("finalizeCapture", input)),
			acknowledgeJobCancelled: async (input) => requireNullAuthorityResponse(await call("acknowledgeJobCancelled", input), "acknowledgeJobCancelled"),
			getProjectionWorkPage: async (input) => parseProjectionWorkPage(await call("getProjectionWorkPage", input)),
			getProjectionRecipeDescriptor: async (input) => parseRecipeDescriptor(await call("getProjectionRecipeDescriptor", input)),
			getProjectionRecipeChunk: async (input) => parseRecipeChunk(await call("getProjectionRecipeChunk", input)),
			acknowledgeProjectionContentMaterialized: async (input) => requireNullAuthorityResponse(await call("acknowledgeProjectionContentMaterialized", input), "acknowledgeProjectionContentMaterialized"),
			validateRestoreAuthority: async (input) => parseRestoreAuthority(await call("validateRestoreAuthority", input)),
			completeRestore: async (input) => requireNullAuthorityResponse(await call("completeRestore", input), "completeRestore"),
			getGcRootPage: async (input) => parseGcRootPage(await call("getGcRootPage", input)),
			completeGcMark: async (input) => { await call("completeGcMark", input); },
			acquireSweepLease: async (input) => parseSweepLease(await call("acquireSweepLease", input)),
			releaseSweepLease: async (input) => requireNullAuthorityResponse(await call("releaseSweepLease", input), "releaseSweepLease"),
			invalidateSweptObjects: async (input) => requireNullAuthorityResponse(await call("invalidateSweptObjects", input), "invalidateSweptObjects"),
			completeGcSweep: async (input) => { await call("completeGcSweep", input); },
			abortRecoveryGc: async (input) => { await call("abortRecoveryGc", input); },
		};
	}

	private descriptor(kind: "capture"): CaptureStartDescriptor;
	private descriptor(kind: "projection"): ProjectionDescriptor;
	private descriptor(kind: "restore"): RestoreDescriptor;
	private descriptor(kind: "gc"): GcDescriptor;
	private descriptor(kind: "purge"): PurgeDescriptor;
	private descriptor(kind: RecoveryJobRecord["kind"]): RecoveryJobDescriptor;
	private descriptor(kind: "capture" | "projection" | "restore" | "gc" | "purge"): RecoveryJobDescriptor {
		const record = this.store.load();
		if (!record || record.kind !== kind || !record.capability || record.capabilityExpiresAt === null) {
			throw new TerminalRecoveryError("corrupt_job_state", "job capability or kind mismatch");
		}
		const metadata = this.store.getMetadata("descriptor");
		if (metadata === null) throw new TerminalRecoveryError("corrupt_job_state", "missing job descriptor");
		return parseStoredDescriptor(record, metadata);
	}

	private commit(record: RecoveryJobRecord, patch: Parameters<RecoveryJobStateStore["update"]>[1]): RecoveryJobRecord {
		const updated = this.store.update(record.revision, patch);
		if (!updated) throw new RetryableRecoveryError("state_conflict", "recovery state changed concurrently");
		return updated;
	}

	async initialize(descriptor: RecoveryJobDescriptor): Promise<{ jobId: string; kind: string; capabilityHash: string; created: boolean }> {
		const kind = descriptorKind(descriptor);
		const operationId = "captureId" in descriptor
			? descriptor.captureId
			: "restoreId" in descriptor ? descriptor.restoreId : undefined;
		const expectedId = recoveryJobId(kind, descriptor.vaultId, descriptor.vaultGeneration, operationId);
		if (descriptor.jobId !== undefined && descriptor.jobId !== expectedId) throw new Error("recovery job identity mismatch");
		const capability = descriptor.capability;
		if (!capability) throw new Error("recovery job capability is required");
		if ("allowedPrefixes" in descriptor) {
			const purge = descriptor;
			const prefix = vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration);
			const expectedPrefixes = [`${prefix}/recovery-v2/`, `${prefix}/blobs/`];
			if (purge.allowedPrefixes.length !== expectedPrefixes.length
				|| purge.allowedPrefixes.some((value, index) => value !== expectedPrefixes[index])) {
				throw new Error("invalid purge prefixes");
			}
		}
		const metadata: Record<string, unknown> = { ...descriptor };
		delete metadata.capability;
		delete metadata.jobId;
		delete metadata.kind;
		const initialized = this.store.initialize({
			jobId: expectedId,
			vaultId: descriptor.vaultId,
			vaultGeneration: descriptor.vaultGeneration,
			kind,
			...("captureId" in descriptor ? { boundarySequence: descriptor.boundarySequence } : {}),
			capability,
			capabilityExpiresAt: descriptor.capabilityExpiresAt,
			createdAt: descriptor.createdAt,
			metadata,
		});
		await this.ctx.storage.setAlarm(Date.now());
		return { jobId: expectedId, kind, capabilityHash: await sha256Hex(encoder.encode(capability)), created: initialized.created };
	}

	async refreshProjection(
		descriptor: ProjectionDescriptor,
	): Promise<{ jobId: string; kind: "projection"; capabilityHash: string; created: false }> {
		const record = this.store.load();
		const expectedId = recoveryJobId("projection", descriptor.vaultId, descriptor.vaultGeneration);
		if (!record || record.kind !== "projection" || record.jobId !== expectedId || record.vaultId !== descriptor.vaultId || record.vaultGeneration !== descriptor.vaultGeneration) {
			throw new Error("projection job identity mismatch");
		}
		const metadata: Record<string, unknown> = { ...descriptor };
		delete metadata.capability;
		delete metadata.jobId;
		delete metadata.kind;
		this.store.setMetadata("descriptor", metadata);
		this.store.clearReconstruction();
		this.store.setMetadata("projection-cursor", { cursor: null });
		this.commit(record, {
			state: "queued",
			capability: descriptor.capability,
			capabilityExpiresAt: descriptor.capabilityExpiresAt,
			nextAttemptAt: null,
			errorCode: null,
			errorRef: null,
			internalError: null,
			completedAt: null,
			updatedAt: Date.now(),
		});
		await this.ctx.storage.setAlarm(Date.now());
		return {
			jobId: expectedId,
			kind: "projection",
			capabilityHash: await sha256Hex(encoder.encode(descriptor.capability)),
			created: false,
		};
	}

	async rotatePurgeCapability(input: {
		deletionId: string;
		capability: string;
		capabilityExpiresAt: number;
	}): Promise<{ capabilityHash: string; state: RecoveryJobRecord["state"] }> {
		const record = this.store.load();
		if (!record || record.kind !== "purge") throw new Error("purge job is not initialized");
		const descriptor = this.descriptor("purge");
		if (descriptor.deletionId !== input.deletionId) throw new Error("purge deletion identity mismatch");
		if (!input.capability || encoder.encode(input.capability).byteLength > 512
			|| !Number.isSafeInteger(input.capabilityExpiresAt) || input.capabilityExpiresAt <= Date.now()) {
			throw new Error("invalid purge capability rotation");
		}
		if (record.state === "cancelled") throw new Error("cancelled purge cannot rotate capability");
		const state = record.state === "failed" ? "queued" : record.state;
		this.commit(record, {
			state,
			capability: input.capability,
			capabilityExpiresAt: input.capabilityExpiresAt,
			nextAttemptAt: null,
			errorCode: null,
			errorRef: null,
			internalError: null,
			completedAt: state === "complete" ? record.completedAt : null,
			updatedAt: Date.now(),
		});
		if (!isTerminalRecoveryState(state)) await this.ctx.storage.setAlarm(Date.now());
		return {
			capabilityHash: await sha256Hex(encoder.encode(input.capability)),
			state,
		};
	}

	async wakePurge(): Promise<void> {
		const record = this.store.load();
		if (!record || record.kind !== "purge"
			|| (record.state !== "queued" && record.state !== "purging")) {
			throw new Error("purge job is not wakeable");
		}
		await this.ctx.storage.setAlarm(Date.now());
	}

	async republishPurge(): Promise<void> {
		const record = this.store.load();
		if (!record || record.kind !== "purge") throw new Error("purge job is not initialized");
		await this.publishPurgeProgress(record, this.descriptor("purge"));
	}

	initializeCapture(descriptor: CaptureStartDescriptor): Promise<{ jobId: string; kind: string; capabilityHash: string; created: boolean }> {
		return this.initialize(descriptor);
	}

	initializeRestore(descriptor: RestoreDescriptor): Promise<{ jobId: string; kind: string; capabilityHash: string; created: boolean }> {
		return this.initialize(descriptor);
	}

	initializeGc(descriptor: GcDescriptor): Promise<{ jobId: string; kind: string; capabilityHash: string; created: boolean }> {
		return this.initialize(descriptor);
	}

	async getInitialization(): Promise<{ initialized: false } | { initialized: true; jobId: string; vaultId: string; vaultGeneration: string; kind: string; boundarySequence: number | null; capabilityHash: string; capabilityExpiresAt: number | null }> {
		const record = this.store.load();
		if (!record) return { initialized: false };
		return {
			initialized: true,
			jobId: record.jobId,
			vaultId: record.vaultId,
			vaultGeneration: record.vaultGeneration,
			kind: record.kind,
			boundarySequence: record.boundarySequence,
			capabilityHash: record.capability ? await sha256Hex(encoder.encode(record.capability)) : "",
			capabilityExpiresAt: record.capabilityExpiresAt,
		};
	}

	async getStatus(): Promise<RecoveryJobStatus> {
		const record = this.store.load();
		if (!record) throw new Error("recovery job not initialized");
		const descriptor = this.descriptor(record.kind);
		return {
			jobId: record.jobId,
			vaultId: record.vaultId,
			vaultGeneration: record.vaultGeneration,
			kind: record.kind,
			state: record.state,
			boundarySequence: record.boundarySequence,
			processedEntries: record.processedEntries,
			totalEntries: record.totalEntries,
			contentObjectsWritten: record.contentObjectsWritten,
			contentObjectsReused: record.contentObjectsReused,
			manifestNodesWritten: record.manifestNodesWritten,
			bytesRead: record.bytesRead,
			bytesWritten: record.bytesWritten,
			retryCount: record.retryCount,
			nextAttemptAt: record.nextAttemptAt,
			error: record.errorCode ? { code: record.errorCode, reference: record.errorRef } : null,
			cancelRequested: record.cancelRequested,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			completedAt: record.completedAt,
			deletedObjects: record.deletedObjects,
			deletedBytes: record.deletedBytes,
			...("captureId" in descriptor ? { captureId: descriptor.captureId } : {}),
			...("restoreId" in descriptor ? { restoreId: descriptor.restoreId } : {}),
			...("snapshotId" in descriptor ? { snapshotId: descriptor.snapshotId } : {}),
			...("captureId" in descriptor ? {
				pinSoftExpiresAt: descriptor.pinSoftExpiresAt,
				pinHardExpiresAt: descriptor.pinHardExpiresAt,
			} : {}),
		};
	}

	async cancel(): Promise<void> {
		const record = this.store.load();
		if (!record) throw new Error("recovery job not initialized");
		if (record.state === "complete" || record.state === "complete_with_gaps") throw new Error("completed recovery job cannot be cancelled");
		if (!canCancelRecoveryJob(record.state)) return;
		this.store.requestCancellation(Date.now());
		await this.ctx.storage.setAlarm(Date.now());
	}

	requestCancellation(): Promise<void> {
		return this.cancel();
	}

	async deleteState(): Promise<void> {
		const record = this.store.load();
		if (record && !isTerminalRecoveryState(record.state)) throw new Error("active recovery job state cannot be deleted");
		await this.ctx.storage.deleteAll();
		this.store.resetAfterDeleteAll();
	}

	async alarm(): Promise<void> {
		const startedAt = Date.now();
		this.deferredAlarmAt = null;
		try {
			for (let unit = 0; unit < MAX_BODIES_PER_ALARM; unit++) {
				let record = this.store.load();
				if (!record || isTerminalRecoveryState(record.state)) return;
				const now = Date.now();
				if (record.nextAttemptAt !== null && record.nextAttemptAt > now) {
					await this.ctx.storage.setAlarm(record.nextAttemptAt);
					return;
				}
				if (record.cancelRequested) {
					await this.finishCancellation(record);
					return;
				}
				if (record.capabilityExpiresAt !== null && now >= record.capabilityExpiresAt) {
					throw new TerminalRecoveryError("capability_expired", "recovery capability expired");
				}
				const authority = this.authority(record.vaultId, record.vaultGeneration);
				if (record.kind === "capture") {
					const capture = this.descriptor("capture");
					await authority.checkRecoveryJobLease({
						captureId: capture.captureId,
						boundarySequence: capture.boundarySequence,
						capability: capture.capability,
						progress: record.processedEntries,
					});
				}
				if (record.kind === "capture") await this.runCaptureSlice(record, authority);
				else if (record.kind === "projection") await this.runProjectionSlice(record, authority);
				else if (record.kind === "restore") await this.runRestoreSlice(record, authority);
				else if (record.kind === "gc") await this.runGcSlice(record, authority);
				else await this.runPurgeSlice(record);
				record = this.store.load();
				if (!record || isTerminalRecoveryState(record.state)) return;
				if (this.deferredAlarmAt !== null || Date.now() - startedAt >= ALARM_SLICE_WALL_MS) break;
			}
			await this.ctx.storage.setAlarm(this.deferredAlarmAt ?? Date.now());
		} catch (error) {
			await this.handleFailure(error);
		}
	}

	private async finishCancellation(record: RecoveryJobRecord): Promise<void> {
		if (record.kind === "capture" && record.capability && record.boundarySequence !== null) {
			const descriptor = this.descriptor("capture");
			await this.authority(record.vaultId, record.vaultGeneration).acknowledgeJobCancelled({
				captureId: descriptor.captureId,
				boundarySequence: record.boundarySequence,
				capability: record.capability,
			});
		}
		this.store.clearReconstruction();
		this.commit(record, {
			state: "cancelled",
			completedAt: Date.now(),
			nextAttemptAt: null,
			errorCode: null,
			errorRef: null,
			updatedAt: Date.now(),
		});
	}

	private async handleFailure(error: unknown): Promise<void> {
		const record = this.store.load();
		if (!record || isTerminalRecoveryState(record.state)) return;
		if (record.cancelRequested) {
			await this.finishCancellation(record);
			return;
		}
		const now = Date.now();
		if (isRetryableFailure(error)) {
			const retryCount = record.retryCount + 1;
			console.warn("[yaos-recovery-job] retrying", {
				jobId: record.jobId,
				kind: record.kind,
				retryCount,
				error: RecoveryJobStateStore.safeInternalError(error),
			});
			const nextAttemptAt = now + retryDelay(retryCount);
			this.commit(record, {
				state: "retrying",
				retryCount,
				nextAttemptAt,
				errorCode: error instanceof RetryableRecoveryError ? error.code : "transient_failure",
				errorRef: null,
				internalError: RecoveryJobStateStore.safeInternalError(error),
				updatedAt: now,
			});
			await this.ctx.storage.setAlarm(nextAttemptAt);
			return;
		}
		const code = error instanceof TerminalRecoveryError ? error.code : "recovery_failed";
		console.error("[yaos-recovery-job] terminal failure", {
			jobId: record.jobId,
			kind: record.kind,
			error: RecoveryJobStateStore.safeInternalError(error),
		});
		this.commit(record, {
			state: "failed",
			completedAt: now,
			nextAttemptAt: null,
			errorCode: code,
			errorRef: null,
			internalError: RecoveryJobStateStore.safeInternalError(error),
			updatedAt: now,
		});
	}

	private initialCaptureProgress(): CaptureProgress {
		return {
			mode: "delta", streamIndex: 0, cursor: null, pageSequence: 0, currentPage: null,
			entryIndex: 0, planDigest: null, deltaDigest: null, baseSnapshotId: null,
			baseRootKey: null, baseRootHash: null, fullRebuild: false,
			buildTreeIndex: 0, buildPageIndex: 0, buildDeltaIndex: 0,
		};
	}

	private captureProgress(): CaptureProgress {
		return this.store.getParsedMetadata("capture-progress", parseCaptureProgress) ?? this.initialCaptureProgress();
	}

	private saveCaptureProgress(progress: CaptureProgress): void {
		this.store.setMetadata("capture-progress", progress);
	}

	private async runCaptureSlice(record: RecoveryJobRecord, authority: RecoveryAuthorityRpc): Promise<void> {
		const descriptor = this.descriptor("capture");
		let progress = this.captureProgress();
		if (record.state === "queued" || record.state === "retrying") {
			record = this.commit(record, { state: progress.mode === "build" || progress.mode === "inventory" ? "building" : "planning", nextAttemptAt: null, errorCode: null, errorRef: null, updatedAt: Date.now() });
		}
		if (progress.mode === "delta") {
			progress = await this.captureDeltaSlice(descriptor, authority, progress);
			this.saveCaptureProgress(progress);
			return;
		}
		if (progress.mode === "plan") {
			await this.capturePlanSlice(record, descriptor, authority, progress);
			return;
		}
		if (progress.mode === "build") {
			await this.captureBuildSlice(record, descriptor, authority, progress);
			return;
		}
		if (progress.mode === "inventory") {
			await this.captureInventorySlice(record, descriptor, authority, progress);
			return;
		}
		await this.capturePublishSlice(record, descriptor, authority, progress);
	}

	private async captureDeltaSlice(descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, progress: CaptureProgress): Promise<CaptureProgress> {
		if (progress.baseRootHash === null && progress.cursor === null && progress.pageSequence === 0) {
			const base = await authority.getIncrementalBase({ captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability });
			if (!base) return { ...progress, mode: "plan", fullRebuild: true };
			const object = await this.bucket().get(base.rootKey);
			if (!object) return { ...progress, mode: "plan", fullRebuild: true };
			try {
				const root = await parseAndVerifySnapshotRoot(await objectBytes(object), base.rootHash);
				this.store.setMetadata("base-root", root);
				progress = { ...progress, baseSnapshotId: base.snapshotId, baseRootKey: base.rootKey, baseRootHash: base.rootHash };
			} catch {
				return { ...progress, mode: "plan", fullRebuild: true, baseSnapshotId: null, baseRootKey: null, baseRootHash: null };
			}
		}
		const baseRoot = requiredMetadata(this.store.getParsedMetadata("base-root", validateSnapshotRoot), "incremental base root");
		try {
			const page = await authority.getCatalogDeltaPage({
				captureId: descriptor.captureId,
				boundarySequence: descriptor.boundarySequence,
				capability: descriptor.capability,
				afterSequence: baseRoot.boundarySequence,
				cursor: progress.cursor,
				maxEntries: MAX_BODIES_PER_ALARM,
				maxResponseBytes: MAX_CAPTURE_PLAN_BYTES,
			});
			await this.stagePage("delta-page", progress.pageSequence, page.entries, {
				nextCursor: page.nextCursor, terminal: page.terminal, deltaDigest: page.deltaDigest,
			});
			return page.terminal
				? { ...progress, mode: "plan", cursor: null, pageSequence: 0, deltaDigest: page.deltaDigest }
				: { ...progress, cursor: page.nextCursor, pageSequence: progress.pageSequence + 1, deltaDigest: page.deltaDigest };
		} catch (error) {
			const committedPages = progress.pageSequence > 0 || this.store.listArtifacts("delta-page").length > 0;
			if (!committedPages && isRetryableFailure(error)) {
				throw new RetryableRecoveryError("capture_delta_transient", RecoveryJobStateStore.safeInternalError(error));
			}
			await authority.resetCaptureDelta({
				captureId: descriptor.captureId,
				boundarySequence: descriptor.boundarySequence,
				capability: descriptor.capability,
			});
			return { ...progress, mode: "plan", cursor: null, pageSequence: 0, fullRebuild: true, deltaDigest: null };
		}
	}

	private async capturePlanSlice(record: RecoveryJobRecord, descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, progress: CaptureProgress): Promise<void> {
		if (progress.streamIndex >= CAPTURE_PLAN_STREAMS.length) {
			this.saveCaptureProgress({ ...progress, mode: "build", buildTreeIndex: 0, buildPageIndex: 0, buildDeltaIndex: 0 });
			this.commit(record, { state: "building", updatedAt: Date.now() });
			return;
		}
		const stream = CAPTURE_PLAN_STREAMS[progress.streamIndex]!;
		let pageArtifact = progress.currentPage ? this.store.getArtifact(`plan-page-${stream}`, progress.currentPage) : null;
		if (!pageArtifact) {
			const page = await authority.getCapturePlanPage({
				vaultId: descriptor.vaultId,
				vaultGeneration: descriptor.vaultGeneration,
				captureId: descriptor.captureId,
				boundarySequence: descriptor.boundarySequence,
				capability: descriptor.capability,
				stream,
				cursor: progress.cursor,
				maxEntries: MANIFEST_MUTATION_CHUNK_ENTRIES,
				maxResponseBytes: MAX_CAPTURE_PLAN_BYTES,
			});
			const logicalKey = String(progress.pageSequence).padStart(12, "0");
			pageArtifact = await this.stagePage(`plan-page-${stream}`, progress.pageSequence, page.entries, {
				stream, pageHash: page.pageHash, nextCursor: page.nextCursor, terminal: page.terminal,
				planDigest: page.planDigest, casHints: page.casHints,
			});
			let reused = 0;
			for (const entry of page.entries) {
				if (entry.kind === "attachment") continue;
				const hash = entry.kind === "active" ? entry.contentHash : entry.baselineContentHash;
				if (page.casHints[hash] !== true) continue;
				const identity = `${entry.bodyId}:${entry.generation}`;
				if (this.store.getArtifact("content-reused", identity)) continue;
				const size = entry.kind === "active" ? entry.size : entry.baselineSize;
				this.store.putArtifact({
					artifactKind: "content-reused",
					logicalKey: identity,
					objectKey: recoveryContentObjectKey(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), hash),
					objectHash: hash,
					entries: 1,
					bytes: size,
					metadata: null,
				});
				reused++;
			}
			if (reused > 0) {
				const latest = this.store.load();
				if (latest) this.commit(latest, { contentObjectsReused: latest.contentObjectsReused + reused, updatedAt: Date.now() });
			}
			this.saveCaptureProgress({ ...progress, currentPage: logicalKey, entryIndex: 0, planDigest: page.planDigest });
			return;
		}
		const entries = await this.readStagedArray(pageArtifact.objectKey, pageArtifact.objectHash, parseCapturePlanEntry);
		let reusedEnd = progress.entryIndex;
		while (reusedEnd < entries.length) {
			const candidate = entries[reusedEnd]!;
			if (candidate.kind === "attachment") break;
			if (!this.store.getArtifact("content-reused", `${candidate.bodyId}:${candidate.generation}`)) break;
			reusedEnd++;
		}
		if (reusedEnd > progress.entryIndex) {
			const consumed = reusedEnd - progress.entryIndex;
			const latest = this.store.load();
			if (!latest) return;
			this.saveCaptureProgress({ ...progress, entryIndex: reusedEnd });
			this.commit(latest, { processedEntries: latest.processedEntries + consumed, updatedAt: Date.now() });
			return;
		}
		if (progress.entryIndex < entries.length) {
			const entry = entries[progress.entryIndex]!;
			try {
				await this.materializePlanEntry(descriptor, authority, entry);
			} catch (error) {
				if (!(error instanceof BodyDefectError)) throw error;
				const reconstruction = this.store.getReconstruction();
				const retryKey = `${error.entry.kind}:${error.entry.bodyId}:${error.entry.generation}`;
				const retryMetadata = this.store.getParsedMetadata("body-defect-retry", parseBodyDefectRetry);
				const metadataAttempts = retryMetadata?.key === retryKey ? retryMetadata.attempts : 0;
				const attempts = reconstruction?.attempts ?? metadataAttempts;
				if (attempts + 1 < MAX_BODY_DEFECT_ATTEMPTS) {
					if (reconstruction) this.store.setReconstruction({ ...reconstruction, attempts: attempts + 1 });
					else this.store.setMetadata("body-defect-retry", { key: retryKey, attempts: attempts + 1 });
					throw new RetryableRecoveryError("body_recipe_retry", error.message);
				}
				console.error("[yaos-recovery-job] body defect", {
					jobId: record.jobId,
					kind: error.entry.kind,
					identity: await sha256Hex(encoder.encode(error.entry.bodyId)),
					error: RecoveryJobStateStore.safeInternalError(error),
				});
				await this.recordBodyDefect(descriptor, authority, error);
			}
			this.store.deleteMetadata("body-defect-retry");
			this.store.clearReconstruction();
			const latest = this.store.load();
			if (!latest) return;
			this.saveCaptureProgress({ ...progress, entryIndex: progress.entryIndex + 1 });
			this.commit(latest, { processedEntries: latest.processedEntries + 1, updatedAt: Date.now() });
			return;
		}
		const metadata = pageArtifact.metadata ?? {};
		const terminal = metadata.terminal === true;
		this.saveCaptureProgress(terminal
			? { ...progress, streamIndex: progress.streamIndex + 1, cursor: null, pageSequence: 0, currentPage: null, entryIndex: 0 }
			: { ...progress, cursor: typeof metadata.nextCursor === "string" ? metadata.nextCursor : null, pageSequence: progress.pageSequence + 1, currentPage: null, entryIndex: 0 });
	}

	private async stagePage(kind: string, sequence: number, value: unknown[], metadata: Record<string, unknown>): Promise<ReturnType<RecoveryJobStateStore["putArtifact"]>> {
		const encoded = await encodeHashedRecoveryObject(value);
		const record = this.store.load();
		if (!record) throw new Error("recovery job not initialized");
		const key = `${recoveryStagingPrefix(recoveryV2Prefix(vaultPrefix(record.vaultId, record.vaultGeneration)), record.jobId)}/${kind}/${encoded.hash}.json.gz`;
		const existing = await this.bucket().get(key);
		if (existing) await decodeHashedRecoveryObject(await objectBytes(existing), encoded.hash);
		else await this.bucket().put(key, encoded.compressedBytes, { httpMetadata: { contentType: "application/gzip" } });
		return this.store.putArtifact({
			artifactKind: kind,
			logicalKey: String(sequence).padStart(12, "0"),
			objectKey: key,
			objectHash: encoded.hash,
			entries: value.length,
			bytes: encoded.canonicalBytes.byteLength,
			metadata,
		});
	}

	private async readStagedArray<T>(key: string, hash: string, parser: (value: unknown) => T): Promise<T[]> {
		const object = await this.bucket().get(key);
		if (!object) throw new RetryableRecoveryError("staging_missing", "recovery staging page missing");
		const value = await decodeHashedRecoveryObject(await objectBytes(object), hash);
		if (!Array.isArray(value)) throw new TerminalRecoveryError("staging_corrupt", "staging page is not an array");
		return value.map(parser);
	}

	private async materializePlanEntry(descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, entry: CapturePlanEntry): Promise<void> {
		if (entry.kind === "attachment") {
			const object = await this.bucket().head(blobObjectKey(descriptor.vaultId, descriptor.vaultGeneration, entry.contentHash));
			if (!object || object.size !== entry.size) {
				const reference = await sha256Hex(encoder.encode(`attachment:${entry.canonicalPath}:${entry.contentHash}`));
				const defect: RecoveryDefectRecord = { captureId: descriptor.captureId, kind: "attachment", identity: entry.canonicalPath, generation: null, code: object ? "corrupt_blob" : "missing_blob", referenceHash: reference, createdAt: Date.now() };
				await authority.recordRecoveryDefects({ captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability, defects: [defect] });
				this.store.putDefect({ logicalKey: `attachment:${entry.canonicalPath}`, kind: "attachment", code: defect.code, reference, metadata: {} });
			}
			this.store.putArtifact({
				artifactKind: "attachment-reference",
				logicalKey: entry.canonicalPath,
				objectKey: blobObjectKey(descriptor.vaultId, descriptor.vaultGeneration, entry.contentHash),
				objectHash: entry.contentHash,
				entries: 1,
				bytes: entry.size,
				metadata: null,
			});
			return;
		}
		const hash = entry.kind === "active" ? entry.contentHash : entry.baselineContentHash;
		const size = entry.kind === "active" ? entry.size : entry.baselineSize;
		const identity = `${entry.bodyId}:${entry.generation}`;
		const written = this.store.getArtifact("content-object", identity);
		if (written) {
			await authority.acknowledgeContentMaterialized({ captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability, bodyId: entry.bodyId, generation: entry.generation, contentHash: hash, plainBytes: size, objectKey: written.objectKey });
			return;
		}
		const reused = this.store.getArtifact("content-reused", identity);
		if (reused) return;
		const coverage = await authority.checkRecoveryCoverage({ captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability, contentHashes: [hash] });
		if (coverage.missingContentHashes.length === 0) {
			this.store.putArtifact({ artifactKind: "content-reused", logicalKey: identity, objectKey: recoveryContentObjectKey(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), hash), objectHash: hash, entries: 1, bytes: size, metadata: null });
			const record = this.store.load();
			if (record) this.commit(record, { contentObjectsReused: record.contentObjectsReused + 1, updatedAt: Date.now() });
			return;
		}
		let reconstruction = this.store.getReconstruction();
		if (!reconstruction) {
			let recipes: BodyRecipeDescriptor[];
			try {
				recipes = await authority.getRecipeDescriptors({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability, entries: [{ bodyId: entry.bodyId, generation: entry.generation }] });
			} catch (error) {
				if (isRetryableFailure(error)) throw new RetryableRecoveryError("recipe_descriptor_transient", RecoveryJobStateStore.safeInternalError(error));
				throw new BodyDefectError("missing_history", entry, RecoveryJobStateStore.safeInternalError(error));
			}
			const recipe = recipes[0];
			if (!recipe || recipe.expectedContentHash !== hash || recipe.expectedSize !== size) throw new BodyDefectError("corrupt_history", entry, "recipe descriptor mismatch");
			reconstruction = { bodyId: entry.bodyId, generation: entry.generation, recipeId: recipe.recipeId, expectedContentHash: hash, expectedSize: size, cursor: recipe.firstCursor, stagingKey: null, stagingHash: null, encodedBytes: 0, attempts: 0 };
			this.store.setReconstruction(reconstruction);
		}
		await this.advanceCaptureReconstruction(descriptor, authority, entry, reconstruction);
	}

	private async advanceCaptureReconstruction(descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, entry: Extract<CapturePlanEntry, { kind: "active" | "deleted" }>, reconstruction: NonNullable<ReturnType<RecoveryJobStateStore["getReconstruction"]>>): Promise<void> {
		const doc = new Y.Doc({ guid: entry.bodyId });
		let oldStagingKey: string | null = null;
		try {
			if (reconstruction.stagingKey) {
				const staged = await this.bucket().get(reconstruction.stagingKey);
				if (!staged || !reconstruction.stagingHash) throw new BodyDefectError("missing_history", entry, "staged reconstruction missing");
				const encoded = await objectBytes(staged);
				if (await sha256Hex(encoded) !== reconstruction.stagingHash) throw new BodyDefectError("corrupt_history", entry, "staged reconstruction corrupt");
				Y.applyUpdate(doc, encoded);
				oldStagingKey = reconstruction.stagingKey;
			}
			let chunk: RecipeChunk;
			try {
				chunk = await authority.getRecipeChunk({ captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability, recipeId: reconstruction.recipeId, cursor: reconstruction.cursor, maxResponseBytes: MAX_RECIPE_BYTES });
			} catch (error) {
				if (isRetryableFailure(error)) throw new RetryableRecoveryError("recipe_chunk_transient", RecoveryJobStateStore.safeInternalError(error));
				throw new BodyDefectError("missing_history", entry, RecoveryJobStateStore.safeInternalError(error));
			}
			if (chunk.encodedBytes > MAX_RECIPE_BYTES && chunk.parts.length !== 1) throw new BodyDefectError("corrupt_history", entry, "recipe chunk exceeds bound");
			for (const part of chunk.parts) Y.applyUpdate(doc, part.update);
			if (chunk.nextCursor !== null) {
				const encoded = Y.encodeStateAsUpdate(doc);
				const hash = await sha256Hex(encoded);
				const key = `${recoveryStagingPrefix(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), recoveryJobId("capture", descriptor.vaultId, descriptor.vaultGeneration, descriptor.captureId))}/body/${entry.bodyId}/${hash}.yjs`;
				await this.bucket().put(key, encoded, { httpMetadata: { contentType: "application/octet-stream" } });
				this.store.setReconstruction({ ...reconstruction, cursor: chunk.nextCursor, stagingKey: key, stagingHash: hash, encodedBytes: encoded.byteLength });
				if (oldStagingKey && oldStagingKey !== key) await this.bucket().delete(oldStagingKey);
				return;
			}
			const bodyText: string = doc.getText("body").toJSON();
			const plain = encoder.encode(bodyText);
			if (plain.byteLength !== reconstruction.expectedSize || await sha256Hex(plain) !== reconstruction.expectedContentHash) {
				throw new BodyDefectError("hash_mismatch", entry, "reconstructed Markdown mismatch");
			}
			const key = recoveryContentObjectKey(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), reconstruction.expectedContentHash);
			const lease = await authority.acquireMaterializationLease({ ownerKind: "capture", ownerId: descriptor.captureId, capability: descriptor.capability, objectKeys: [key] });
			try {
				const compressed = gzipSync(plain, { level: 6 });
				const existing = await this.bucket().get(key);
				if (existing) {
					try {
						const current = gunzipRecoveryBytes(await objectBytes(existing), 4 * 1024 * 1024, 1_500_000);
						if (await sha256Hex(current) !== reconstruction.expectedContentHash) {
							throw new TerminalRecoveryError("content_collision", "content-addressed object collision");
						}
					} catch (error) {
						if (error instanceof TerminalRecoveryError) throw error;
						throw new TerminalRecoveryError("content_collision", "content-addressed object is corrupt");
					}
				} else {
					await this.bucket().put(key, compressed, { httpMetadata: { contentType: "application/gzip" } });
				}
				this.store.putArtifact({ artifactKind: "content-object", logicalKey: `${entry.bodyId}:${entry.generation}`, objectKey: key, objectHash: reconstruction.expectedContentHash, entries: 1, bytes: plain.byteLength, metadata: null });
				await authority.acknowledgeContentMaterialized({ captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability, bodyId: entry.bodyId, generation: entry.generation, contentHash: reconstruction.expectedContentHash, plainBytes: plain.byteLength, objectKey: key });
				const record = this.store.load();
				if (record) this.commit(record, { contentObjectsWritten: record.contentObjectsWritten + 1, bytesRead: record.bytesRead + chunk.encodedBytes, bytesWritten: record.bytesWritten + compressed.byteLength, updatedAt: Date.now() });
			} finally {
				await authority.releaseMaterializationLease(lease.leaseId);
			}
			if (oldStagingKey) await this.bucket().delete(oldStagingKey);
		} catch (error) {
			if (error instanceof BodyDefectError || error instanceof TerminalRecoveryError || error instanceof RetryableRecoveryError) throw error;
			if (isRetryableFailure(error)) throw new RetryableRecoveryError("reconstruction_transient", RecoveryJobStateStore.safeInternalError(error));
			throw new BodyDefectError("corrupt_history", entry, RecoveryJobStateStore.safeInternalError(error));
		} finally {
			doc.destroy();
		}
	}

	private async recordBodyDefect(descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, error: BodyDefectError): Promise<void> {
		const reference = await sha256Hex(encoder.encode(`${error.entry.bodyId}:${error.entry.generation}:${error.code}`));
		const defect: RecoveryDefectRecord = { captureId: descriptor.captureId, kind: error.entry.kind, identity: error.entry.bodyId, generation: error.entry.generation, code: error.code, referenceHash: reference, createdAt: Date.now() };
		await authority.recordRecoveryDefects({ captureId: descriptor.captureId, boundarySequence: descriptor.boundarySequence, capability: descriptor.capability, defects: [defect] });
		this.store.putDefect({ logicalKey: `${error.entry.kind}:${error.entry.bodyId}:${error.entry.generation}`, kind: "body", code: error.code, reference, metadata: {} });
	}

	private planEntryToManifest(entry: CapturePlanEntry): ManifestEntryByTree[ManifestTreeKind] {
		if (entry.kind === "active") {
			const defect = this.store.getDefect(`active:${entry.bodyId}:${entry.generation}`);
			return defect ? { availability: "unavailable", path: entry.canonicalPath, fileId: entry.fileId, bodyId: entry.bodyId, bodyGeneration: entry.generation, errorCode: defect.code as "corrupt_history" | "hash_mismatch" | "missing_history", errorReference: defect.reference } : { availability: "available", path: entry.canonicalPath, fileId: entry.fileId, bodyId: entry.bodyId, bodyGeneration: entry.generation, contentHash: entry.contentHash, size: entry.size };
		}
		if (entry.kind === "deleted") {
			const defect = this.store.getDefect(`deleted:${entry.bodyId}:${entry.generation}`);
			return defect ? { availability: "unavailable", bodyId: entry.bodyId, fileId: entry.fileId, lastPath: entry.lastPath, deletedAtSequence: entry.deletedAtSequence, errorCode: defect.code === "hash_mismatch" ? "corrupt_history" : defect.code as "corrupt_history" | "missing_history" | "missing_content", errorReference: defect.reference, bodyReaped: entry.bodyReaped } : { availability: "available", bodyId: entry.bodyId, fileId: entry.fileId, lastPath: entry.lastPath, deletedAtSequence: entry.deletedAtSequence, baselineContentHash: entry.baselineContentHash, baselineSize: entry.baselineSize, bodyReaped: entry.bodyReaped };
		}
		const defect = this.store.getDefect(`attachment:${entry.canonicalPath}`);
		return defect ? { availability: "unavailable", path: entry.canonicalPath, expectedHash: entry.contentHash, expectedSize: entry.size, mime: entry.mime, errorCode: defect.code as "missing_blob" | "corrupt_blob", errorReference: defect.reference } : { availability: "available", path: entry.canonicalPath, hash: entry.contentHash, size: entry.size, mime: entry.mime };
	}

	private async captureBuildSlice(record: RecoveryJobRecord, descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, progress: CaptureProgress): Promise<void> {
		const trees: ManifestTreeKind[] = ["active", "deleted", "attachments"];
		if (progress.buildTreeIndex >= trees.length) {
			const roots = trees.map((tree) => requiredMetadata(this.store.getParsedMetadata(`tree-${tree}`, parseTreeCheckpoint), `${tree} tree`));
			this.store.clearManifestFrontier();
			this.store.enqueueManifestFrontier(trees.map((tree, index) => ({ tree, logicalPrefix: "", nodeHash: roots[index]!.rootHash })));
			this.saveCaptureProgress({ ...progress, mode: "inventory" });
			return;
		}
		const tree = trees[progress.buildTreeIndex]!;
		const prefix = recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration));
		const artifacts = new DirectR2Artifacts(this.bucket());
		const manifestStore: CaptureManifestStore = new CaptureManifestStore(artifacts, authority, this.store, descriptor, prefix);
		let checkpoint = this.store.getParsedMetadata(`tree-${tree}`, parseTreeCheckpoint);
		if (!checkpoint) {
			if (!progress.fullRebuild) {
				const base = requiredMetadata(this.store.getParsedMetadata("base-root", validateSnapshotRoot), "base root");
				const rootHash = tree === "active" ? base.activeFilesTreeHash : tree === "deleted" ? base.deletedFilesTreeHash : base.attachmentsTreeHash;
				try {
					const root = await readAndVerifyManifestNode(manifestStore, tree, rootHash);
					checkpoint = { rootHash, entries: root.subtreeEntries, nodes: root.subtreeNodes };
				} catch {
					progress = { ...progress, fullRebuild: true, buildTreeIndex: 0, buildPageIndex: 0, buildDeltaIndex: 0 };
					for (const kind of trees) this.store.deleteMetadata(`tree-${kind}`);
					this.saveCaptureProgress(progress);
					return;
				}
			} else {
				const pages = this.store.listArtifacts(`plan-page-${tree}`);
				const entryCount = pages.reduce((total, page) => total + (page.entries ?? 0), 0);
				if (entryCount <= MAX_SINGLE_TURN_REBUILD_ENTRIES) {
					const entries: ManifestEntryByTree[typeof tree][] = [];
					for (const page of pages) {
						const staged = await this.readStagedArray(page.objectKey, page.objectHash, parseCapturePlanEntry);
						for (const entry of staged) entries.push(this.planEntryToManifest(entry));
					}
					const rebuilt = await rebuildManifestTree(manifestStore, prefix, tree, entries);
					await manifestStore.flush();
					checkpoint = rebuilt;
					this.store.setMetadata(`tree-${tree}`, checkpointMetadata(rebuilt));
					this.saveCaptureProgress({ ...progress, buildPageIndex: pages.length });
					const latest = this.store.load();
					if (latest) this.commit(latest, { manifestNodesWritten: latest.manifestNodesWritten + rebuilt.writtenHashes.length, updatedAt: Date.now() });
					return;
				}
				checkpoint = await createEmptyManifestTree(manifestStore, prefix, tree);
				await manifestStore.flush();
			}
			this.store.setMetadata(`tree-${tree}`, checkpointMetadata(checkpoint));
			return;
		}
		const mutations: Array<ManifestTreeMutation<ManifestEntryByTree[typeof tree]>> = [];
		if (!progress.fullRebuild) {
			const deltaPages = this.store.listArtifacts("delta-page");
			if (progress.buildDeltaIndex < deltaPages.length) {
				const page = deltaPages[progress.buildDeltaIndex]!;
				const entries = await this.readStagedArray(page.objectKey, page.objectHash, parseStagedDelta);
				for (const delta of entries) {
					if (tree === "active" && delta.previousPath) mutations.push({ type: "delete", key: delta.previousPath });
					if (tree === "active" && delta.kind === "delete") mutations.push({ type: "delete", key: delta.path });
					if (tree === "deleted" && delta.kind === "revive") mutations.push({ type: "delete", key: delta.identity });
					if (tree === "attachments" && delta.kind === "attachment-delete") mutations.push({ type: "delete", key: delta.path });
				}
				const next = await mutateManifestTreeChunk(manifestStore, prefix, tree, checkpoint.rootHash, mutations.slice(0, 25));
				await manifestStore.flush();
				this.store.setMetadata(`tree-${tree}`, checkpointMetadata(next));
				this.saveCaptureProgress({ ...progress, buildDeltaIndex: progress.buildDeltaIndex + 1 });
				return;
			}
		}
		const pages = this.store.listArtifacts(`plan-page-${tree}`);
		if (progress.buildPageIndex < pages.length) {
			const page = pages[progress.buildPageIndex]!;
			const entries = await this.readStagedArray(page.objectKey, page.objectHash, parseCapturePlanEntry);
			for (const entry of entries) mutations.push({ type: "upsert", entry: this.planEntryToManifest(entry) });
			const next = await mutateManifestTreeChunk(manifestStore, prefix, tree, checkpoint.rootHash, mutations);
			await manifestStore.flush();
			this.store.setMetadata(`tree-${tree}`, checkpointMetadata(next));
			this.saveCaptureProgress({ ...progress, buildPageIndex: progress.buildPageIndex + 1 });
			const latest = this.store.load();
			if (latest) this.commit(latest, { manifestNodesWritten: latest.manifestNodesWritten + next.writtenHashes.length, updatedAt: Date.now() });
			return;
		}
		this.saveCaptureProgress({ ...progress, buildTreeIndex: progress.buildTreeIndex + 1, buildPageIndex: 0, buildDeltaIndex: 0 });
	}

	private async captureInventorySlice(record: RecoveryJobRecord, descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, progress: CaptureProgress): Promise<void> {
		const frontiers = this.store.listManifestFrontier(MANIFEST_INVENTORY_PAGE);
		if (frontiers.length === 0) {
			this.saveCaptureProgress({ ...progress, mode: "publish" });
			this.commit(record, { state: "publishing", updatedAt: Date.now() });
			return;
		}
		const prefix = recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration));
		const source = new R2ManifestNodeStore(new DirectR2Artifacts(this.bucket()), prefix);
		const verified = await Promise.all(frontiers.map(async (frontier) => {
			const node = await readAndVerifyManifestNode(source, frontier.tree, frontier.nodeHash);
			return { frontier, node, artifact: this.store.getArtifact("manifest-object", frontier.nodeHash), objectKey: manifestNodeObjectKey(prefix, frontier.nodeHash) };
		}));
		const lease = await authority.acquireMaterializationLease({
			ownerKind: "capture",
			ownerId: descriptor.captureId,
			capability: descriptor.capability,
			objectKeys: [...new Set(verified.map((item) => item.objectKey))],
		});
		try {
			await authority.acknowledgeManifestNodesMaterialized({
				captureId: descriptor.captureId,
				boundarySequence: descriptor.boundarySequence,
				capability: descriptor.capability,
				nodes: verified.map(({ frontier, node, artifact, objectKey }) => ({
					captureId: descriptor.captureId,
					boundarySequence: descriptor.boundarySequence,
					capability: descriptor.capability,
					tree: frontier.tree,
					logicalPrefix: frontier.logicalPrefix,
					nodeHash: frontier.nodeHash,
					objectKey,
					nodeFormat: node.node.format,
					subtreeEntries: node.subtreeEntries,
					subtreeNodes: node.subtreeNodes,
					provenanceSnapshotId: artifact ? null : progress.baseSnapshotId,
				})),
			});
		} finally {
			await authority.releaseMaterializationLease(lease.leaseId);
		}
		for (const { frontier, node, objectKey } of verified) {
			this.store.putArtifact({ artifactKind: "manifest-reachable", logicalKey: `${frontier.tree}:${frontier.logicalPrefix}`, objectKey, objectHash: frontier.nodeHash, entries: node.subtreeEntries, bytes: node.compressedBytes, metadata: { tree: frontier.tree, logicalPrefix: frontier.logicalPrefix, nodeFormat: node.node.format, subtreeNodes: node.subtreeNodes } });
			if (node.node.format === MANIFEST_BRANCH_FORMAT) {
				this.store.enqueueManifestFrontier(Object.entries(node.node.children).map(([childPrefix, child]) => ({ tree: frontier.tree, logicalPrefix: `${frontier.logicalPrefix}${childPrefix}`, nodeHash: child.hash })));
			}
			this.store.completeManifestFrontier(frontier.tree, frontier.logicalPrefix);
		}
	}

	private async capturePublishSlice(record: RecoveryJobRecord, descriptor: CaptureStartDescriptor, authority: RecoveryAuthorityRpc, progress: CaptureProgress): Promise<void> {
		const reachable = this.store.listArtifacts("manifest-reachable").map((artifact): ReachableManifestNode => {
			const metadata = metadataRecord(artifact.metadata, "reachable manifest artifact");
			assertMetadataKeys(metadata, ["tree", "logicalPrefix", "nodeFormat", "subtreeNodes"], "reachable manifest artifact");
			if (metadata.tree !== "active" && metadata.tree !== "deleted" && metadata.tree !== "attachments") {
				throw new TerminalRecoveryError("corrupt_job_state", "invalid reachable manifest tree");
			}
			if (typeof metadata.logicalPrefix !== "string" || !/^(?:[a-f0-9]{2})*$/.test(metadata.logicalPrefix)) {
				throw new TerminalRecoveryError("corrupt_job_state", "invalid reachable manifest prefix");
			}
			if (metadata.nodeFormat !== "yaos-manifest-branch-v1" && metadata.nodeFormat !== "yaos-manifest-leaf-v1") {
				throw new TerminalRecoveryError("corrupt_job_state", "invalid reachable manifest format");
			}
			if (artifact.entries === null) throw new TerminalRecoveryError("corrupt_job_state", "missing reachable manifest entry count");
			return {
				tree: metadata.tree,
				logicalPrefix: metadata.logicalPrefix,
				nodeHash: artifact.objectHash,
				nodeFormat: metadata.nodeFormat,
				subtreeEntries: metadataInteger(artifact.entries, "reachable manifest entry count"),
				subtreeNodes: metadataInteger(metadata.subtreeNodes, "reachable manifest node count"),
			};
		});
		const manifestGraphDigest = await computeManifestGraphDigest(reachable);
		const active = requiredMetadata(this.store.getParsedMetadata("tree-active", parseTreeCheckpoint), "active tree");
		const deleted = requiredMetadata(this.store.getParsedMetadata("tree-deleted", parseTreeCheckpoint), "deleted tree");
		const attachments = requiredMetadata(this.store.getParsedMetadata("tree-attachments", parseTreeCheckpoint), "attachments tree");
		const completedAtMetadata = this.store.getMetadata("root-completion");
		let completedAt = Date.now();
		if (completedAtMetadata !== null) {
			assertMetadataKeys(completedAtMetadata, ["completedAt"], "root completion");
			completedAt = metadataInteger(completedAtMetadata.completedAt, "root completion time");
		} else {
			this.store.setMetadata("root-completion", { completedAt });
		}
		const planEntries = [
			...this.store.listArtifacts("plan-page-active"),
			...this.store.listArtifacts("plan-page-deleted"),
			...this.store.listArtifacts("plan-page-attachments"),
		];
		const markdownBytes = [
			...this.store.listArtifacts("content-object"),
			...this.store.listArtifacts("content-reused"),
		].reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0);
		const attachmentBytes = this.store.listArtifacts("attachment-reference")
			.reduce((sum, artifact) => sum + (artifact.bytes ?? 0), 0);
		const totals = {
			activeFiles: active.entries,
			deletedFiles: deleted.entries,
			unavailableFiles: this.store.defectCount(),
			attachments: attachments.entries,
			markdownBytes,
			attachmentBytes,
		};
		let rootArtifact = this.store.getArtifact("snapshot-root", "root");
		if (!rootArtifact) {
			const root: SnapshotRootV2 = {
				format: "yaos-recovery-v2",
				snapshotFormatVersion: 2,
				snapshotId: descriptor.snapshotId,
				vaultIdHash: await sha256Hex(encoder.encode(descriptor.vaultId)),
				vaultGenerationHash: await sha256Hex(encoder.encode(descriptor.vaultGeneration)),
				runtimeEpoch: descriptor.runtimeEpoch,
				boundarySequence: descriptor.boundarySequence,
				rootGeneration: descriptor.rootGeneration,
				sourcePlanDigest: progress.planDigest ?? "",
				manifestGraphDigest,
				manifestNodeCount: reachable.length,
				createdAt: new Date(descriptor.createdAt).toISOString(),
				completedAt: new Date(completedAt).toISOString(),
				health: this.store.defectCount() > 0 ? "complete_with_gaps" : "complete",
				reason: descriptor.reason,
				activeFilesTreeHash: active.rootHash,
				deletedFilesTreeHash: deleted.rootHash,
				attachmentsTreeHash: attachments.rootHash,
				totals,
				previousSnapshotId: progress.baseSnapshotId,
			};
			const encoded = await encodeSnapshotRoot(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), root);
			await putCreateOnlyRecoveryRoot(this.bucket(), encoded.objectKey, encoded.canonicalBytes, encoded.hash);
			rootArtifact = this.store.putArtifact({
				artifactKind: "snapshot-root",
				logicalKey: "root",
				objectKey: encoded.objectKey,
				objectHash: encoded.hash,
				entries: planEntries.reduce((sum, page) => sum + (page.entries ?? 0), 0),
				bytes: encoded.canonicalBytes.byteLength,
				metadata: { completedAt, manifestGraphDigest, manifestNodeCount: reachable.length, totals },
			});
		}
		const rootMetadata = parseSnapshotRootArtifactMetadata(rootArtifact.metadata);
		await authority.finalizeCapture({
			captureId: descriptor.captureId,
			boundarySequence: descriptor.boundarySequence,
			capability: descriptor.capability,
			sourcePlanDigest: progress.planDigest ?? "",
			sourceDeltaDigest: progress.deltaDigest,
			manifestGraphDigest: rootMetadata.manifestGraphDigest,
			manifestNodeCount: rootMetadata.manifestNodeCount,
			snapshotRootKey: rootArtifact.objectKey,
			snapshotRootHash: rootArtifact.objectHash,
			totals: rootMetadata.totals,
			completedAt: rootMetadata.completedAt,
		});
		this.commit(record, {
			state: this.store.defectCount() > 0 ? "complete_with_gaps" : "complete",
			completedAt,
			totalEntries: rootArtifact.entries,
			nextAttemptAt: null,
			errorCode: null,
			errorRef: null,
			updatedAt: Date.now(),
		});
	}

	private async runProjectionSlice(record: RecoveryJobRecord, authority: RecoveryAuthorityRpc): Promise<void> {
		const descriptor = this.descriptor("projection");
		const cursor = this.store.getParsedMetadata(
			"projection-cursor",
			(value) => parseCursorMetadata(value, "projection progress"),
		)?.cursor ?? null;
		const page = await authority.getProjectionWorkPage({
			vaultId: descriptor.vaultId,
				vaultGeneration: descriptor.vaultGeneration,
			leaseId: descriptor.leaseId,
			capability: descriptor.capability,
			cursor,
			maxEntries: 1,
			maxResponseBytes: MAX_CAPTURE_PLAN_BYTES,
		});
		const action = recoveryProjectionPageAction(page.entries.length, page.terminal, page.nextCursor);
		if (action.kind !== "work") {
			if (action.kind === "sleep") {
				this.store.setMetadata("projection-cursor", { cursor: null });
				this.deferredAlarmAt = Date.now() + 30_000;
			} else {
				this.store.setMetadata("projection-cursor", { cursor: action.cursor });
			}
			return;
		}
		const entry = page.entries[0]!;
		let reconstruction = this.store.getReconstruction();
		if (!reconstruction) {
			const recipe = await authority.getProjectionRecipeDescriptor({
				vaultId: descriptor.vaultId,
				vaultGeneration: descriptor.vaultGeneration,
				leaseId: descriptor.leaseId,
				capability: descriptor.capability,
				bodyId: entry.bodyId,
				expectedHeadGeneration: entry.generation,
			});
			reconstruction = {
				bodyId: entry.bodyId,
				generation: entry.generation,
				recipeId: recipe.recipeId,
				expectedContentHash: entry.contentHash,
				expectedSize: entry.size,
				cursor: recipe.firstCursor,
				stagingKey: null,
				stagingHash: null,
				encodedBytes: 0,
				attempts: 0,
			};
			this.store.setReconstruction(reconstruction);
		}
		if (reconstruction.bodyId !== entry.bodyId || reconstruction.generation !== entry.generation) {
			this.store.clearReconstruction();
			return;
		}
		const doc = new Y.Doc({ guid: entry.bodyId });
		let oldStagingKey: string | null = null;
		try {
			if (reconstruction.stagingKey) {
				const staged = await this.bucket().get(reconstruction.stagingKey);
				if (!staged || !reconstruction.stagingHash) throw new RetryableRecoveryError("projection_staging_missing", "projection staging state missing");
				const encoded = await objectBytes(staged);
				if (await sha256Hex(encoded) !== reconstruction.stagingHash) throw new TerminalRecoveryError("projection_staging_corrupt", "projection staging state corrupt");
				Y.applyUpdate(doc, encoded);
				oldStagingKey = reconstruction.stagingKey;
			}
			const chunk = await authority.getProjectionRecipeChunk({
				vaultId: descriptor.vaultId,
				vaultGeneration: descriptor.vaultGeneration,
				leaseId: descriptor.leaseId,
				capability: descriptor.capability,
				bodyId: entry.bodyId,
				expectedHeadGeneration: entry.generation,
				recipeId: reconstruction.recipeId,
				cursor: reconstruction.cursor,
				maxResponseBytes: MAX_RECIPE_BYTES,
			});
			for (const part of chunk.parts) Y.applyUpdate(doc, part.update);
			if (chunk.nextCursor !== null) {
				const encoded = Y.encodeStateAsUpdate(doc);
				const hash = await sha256Hex(encoded);
				const key = `${recoveryStagingPrefix(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), recoveryJobId("projection", descriptor.vaultId, descriptor.vaultGeneration))}/body/${entry.bodyId}/${hash}.yjs`;
				await this.bucket().put(key, encoded, { httpMetadata: { contentType: "application/octet-stream" } });
				this.store.setReconstruction({ ...reconstruction, cursor: chunk.nextCursor, stagingKey: key, stagingHash: hash, encodedBytes: encoded.byteLength });
				if (oldStagingKey && oldStagingKey !== key) await this.bucket().delete(oldStagingKey);
				return;
			}
			const bodyText: string = doc.getText("body").toJSON();
			const plain = encoder.encode(bodyText);
			if (plain.byteLength !== entry.size || await sha256Hex(plain) !== entry.contentHash) {
				throw new TerminalRecoveryError("projection_hash_mismatch", "projection content mismatch");
			}
			const key = recoveryContentObjectKey(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), entry.contentHash);
			const lease = await authority.acquireMaterializationLease({
				ownerKind: "projection",
				ownerId: descriptor.leaseId,
				capability: descriptor.capability,
				objectKeys: [key],
			});
			try {
				if (!await this.bucket().head(key)) {
					await this.bucket().put(key, gzipSync(plain, { level: 6 }), { httpMetadata: { contentType: "application/gzip" } });
				}
				await authority.acknowledgeProjectionContentMaterialized({
					vaultId: descriptor.vaultId,
				vaultGeneration: descriptor.vaultGeneration,
					leaseId: descriptor.leaseId,
					capability: descriptor.capability,
					bodyId: entry.bodyId,
					expectedHeadGeneration: entry.generation,
					contentHash: entry.contentHash,
					plainBytes: plain.byteLength,
					objectKey: key,
				});
			} finally {
				await authority.releaseMaterializationLease(lease.leaseId);
			}
			if (oldStagingKey) await this.bucket().delete(oldStagingKey);
			this.store.clearReconstruction();
			this.store.setMetadata("projection-cursor", { cursor: page.nextCursor });
			this.commit(record, { state: "materializing", processedEntries: record.processedEntries + 1, updatedAt: Date.now() });
		} finally {
			doc.destroy();
		}
	}

	private async runRestoreSlice(record: RecoveryJobRecord, authority: RecoveryAuthorityRpc): Promise<void> {
		const descriptor = this.descriptor("restore");
		const prefix = recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration));
		const source = new R2ManifestNodeStore(new DirectR2Artifacts(this.bucket()), prefix);
		let root = this.store.getParsedMetadata("restore-root", validateSnapshotRoot);
		if (!root) {
			const proof = await authority.validateRestoreAuthority({
				vaultId: descriptor.vaultId,
				vaultGeneration: descriptor.vaultGeneration,
				restoreId: descriptor.restoreId,
				snapshotId: descriptor.snapshotId,
				capability: descriptor.capability,
			});
			if (Date.now() >= proof.capabilityExpiresAt) throw new TerminalRecoveryError("restore_expired", "restore authority expired");
			if (JSON.stringify(proof.selection) !== JSON.stringify(descriptor.selection)) {
				throw new TerminalRecoveryError("restore_selection_mismatch", "restore selection authority mismatch");
			}
			const object = await this.bucket().get(proof.rootKey);
			if (!object) throw new TerminalRecoveryError("restore_root_missing", "retained snapshot root is missing");
			root = await parseAndVerifySnapshotRoot(await objectBytes(object), proof.rootHash);
			if (root.snapshotId !== descriptor.snapshotId) throw new TerminalRecoveryError("restore_root_mismatch", "restore snapshot identity mismatch");
			this.store.setMetadata("restore-root", root);
			if (descriptor.selection.kind === "all") {
				this.store.clearManifestFrontier();
				this.store.enqueueManifestFrontier([
					{ tree: "active", logicalPrefix: "", nodeHash: root.activeFilesTreeHash },
					{ tree: "deleted", logicalPrefix: "", nodeHash: root.deletedFilesTreeHash },
					{ tree: "attachments", logicalPrefix: "", nodeHash: root.attachmentsTreeHash },
				]);
			} else {
				this.store.setMetadata("restore-direct", { index: 0 });
			}
			this.commit(record, { state: "enumerating", updatedAt: Date.now() });
			return;
		}
		if (record.state === "queued" || record.state === "retrying") {
			record = this.commit(record, { state: "enumerating", nextAttemptAt: null, errorCode: null, errorRef: null, updatedAt: Date.now() });
		}
		if (record.state === "enumerating" && descriptor.selection.kind !== "all") {
			const index = this.store.getParsedMetadata(
				"restore-direct",
				(value) => parseIndexMetadata(value, "direct restore progress", "index"),
			) ?? 0;
			const keys = "paths" in descriptor.selection ? descriptor.selection.paths : descriptor.selection.bodyIds;
			if (index < keys.length) {
				const tree: ManifestTreeKind = descriptor.selection.kind === "attachment-paths" ? "attachments"
					: descriptor.selection.kind === "deleted-identities" ? "deleted" : "active";
				const rootHash = tree === "active" ? root.activeFilesTreeHash
					: tree === "deleted" ? root.deletedFilesTreeHash : root.attachmentsTreeHash;
				const result = await lookupManifestEntry(source, tree, rootHash, keys[index]!);
				if (!result.entry || result.entry.availability !== "available") {
					await this.storeFailedRestoreSelection(descriptor, tree, keys[index]!, result.entry);
				} else {
					await this.storeRestoreManifestEntries(descriptor, tree, [result.entry]);
				}
				this.store.setMetadata("restore-direct", { index: index + 1 });
				return;
			}
			const counts = this.store.restoreCounts();
			this.commit(record, { state: "awaiting-results", totalEntries: counts.total, updatedAt: Date.now() });
			return;
		}
		if (record.state === "enumerating") {
			const frontier = this.store.nextManifestFrontier();
			if (!frontier) {
				const counts = this.store.restoreCounts();
				this.commit(record, { state: "awaiting-results", totalEntries: counts.total, updatedAt: Date.now() });
				return;
			}
			const verified = await readAndVerifyManifestNode(source, frontier.tree, frontier.nodeHash);
			if (verified.node.format === MANIFEST_BRANCH_FORMAT) {
				this.store.enqueueManifestFrontier(Object.entries(verified.node.children).map(([part, child]) => ({
					tree: frontier.tree,
					logicalPrefix: `${frontier.logicalPrefix}${part}`,
					nodeHash: child.hash,
				})));
				this.store.completeManifestFrontier(frontier.tree, frontier.logicalPrefix);
				return;
			}
			const leaf = this.store.getParsedMetadata("restore-leaf", parseRestoreLeaf);
			const index = leaf === null || leaf.nodeHash !== frontier.nodeHash ? 0 : leaf.index;
			const entries = verified.node.entries.slice(index, index + 25);
			await this.storeRestoreManifestEntries(descriptor, frontier.tree, entries);
			if (index + entries.length >= verified.node.entries.length) {
				this.store.deleteMetadata("restore-leaf");
				this.store.completeManifestFrontier(frontier.tree, frontier.logicalPrefix);
			} else {
				this.store.setMetadata("restore-leaf", { nodeHash: frontier.nodeHash, index: index + entries.length });
			}
			return;
		}
		const counts = this.store.restoreCounts();
		if (counts.terminal === counts.total) {
			await authority.completeRestore({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, restoreId: descriptor.restoreId, snapshotId: descriptor.snapshotId, capability: descriptor.capability });
			this.commit(record, { state: "complete", processedEntries: counts.terminal, totalEntries: counts.total, completedAt: Date.now(), updatedAt: Date.now() });
		}
	}

	private async storeRestoreManifestEntries(
		descriptor: RestoreDescriptor,
		tree: ManifestTreeKind,
		entries: readonly ManifestEntryByTree[ManifestTreeKind][],
	): Promise<void> {
		const counts = this.store.restoreCounts();
		const items: StoredRestoreItem[] = [];
		for (const entry of entries) {
			if (entry.availability !== "available") continue;
			if (tree === "active") {
				const active = entry as Extract<ActiveFileManifestEntry, { availability: "available" }>;
				items.push({
					itemId: (await sha256Hex(encoder.encode(`${descriptor.restoreId}:active:${active.path}:${active.contentHash}`))).slice(0, 48),
					cursorOrder: counts.total + items.length,
					kind: "markdown",
					path: active.path,
					contentHash: active.contentHash,
					size: active.size,
					outcome: null,
					errorCode: null,
					metadata: { sourceKind: "active", sourceFileId: active.fileId, sourceBodyId: active.bodyId },
				});
			} else if (tree === "deleted") {
				const deleted = entry as Extract<DeletedFileManifestEntry, { availability: "available" }>;
				items.push({
					itemId: (await sha256Hex(encoder.encode(`${descriptor.restoreId}:deleted:${deleted.bodyId}:${deleted.baselineContentHash}`))).slice(0, 48),
					cursorOrder: counts.total + items.length,
					kind: "markdown",
					path: deleted.lastPath,
					contentHash: deleted.baselineContentHash,
					size: deleted.baselineSize,
					outcome: null,
					errorCode: null,
					metadata: { sourceKind: "deleted", sourceFileId: deleted.fileId, sourceBodyId: deleted.bodyId },
				});
			} else {
				const attachment = entry as Extract<AttachmentManifestEntry, { availability: "available" }>;
				items.push({
					itemId: (await sha256Hex(encoder.encode(`${descriptor.restoreId}:attachment:${attachment.path}:${attachment.hash}`))).slice(0, 48),
					cursorOrder: counts.total + items.length,
					kind: "attachment",
					path: attachment.path,
					contentHash: attachment.hash,
					size: attachment.size,
					outcome: null,
					errorCode: null,
					metadata: { mime: attachment.mime },
				});
			}
		}
		this.store.putRestoreItems(items);
	}

	private async storeFailedRestoreSelection(
		descriptor: RestoreDescriptor,
		tree: ManifestTreeKind,
		selectionKey: string,
		entry: ManifestEntryByTree[ManifestTreeKind] | null,
	): Promise<void> {
		const counts = this.store.restoreCounts();
		this.store.putRestoreItems([
			await createFailedRestoreItem(descriptor.restoreId, tree, selectionKey, entry, counts.total),
		]);
	}

	async listItems(input: { cursor: string | null; limit: number }): Promise<{ items: RestoreItem[]; nextCursor: string | null; total: number }> {
		const { cursor = null, limit = 25 } = input;
		const record = this.store.load();
		if (!record || record.kind !== "restore") throw new Error("restore job not initialized");
		const descriptor = this.descriptor("restore");
		const after = cursor === null ? -1 : Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(after) || after < -1) throw new Error("invalid restore cursor");
		const rows = this.store.listRestoreItems(after, Math.max(1, Math.min(MAX_RESTORE_PAGE, limit)), true);
		const items = rows.map((row): RestoreItem => ({
			kind: row.kind,
			itemId: row.itemId,
			path: row.path,
			contentHash: row.contentHash,
			size: row.size,
			contentUrl: `/vault/${encodeURIComponent(record.vaultId)}/recovery/restores/${encodeURIComponent(descriptor.restoreId)}/items/${encodeURIComponent(row.itemId)}/content`,
			...(row.kind === "markdown" ? {
				sourceKind: row.metadata.sourceKind === "deleted" ? "deleted" as const : "active" as const,
				sourceFileId: typeof row.metadata.sourceFileId === "string" ? row.metadata.sourceFileId : "",
				sourceBodyId: typeof row.metadata.sourceBodyId === "string" ? row.metadata.sourceBodyId : "",
			} : { mime: typeof row.metadata.mime === "string" ? row.metadata.mime : null }),
		}));
		const counts = this.store.restoreCounts();
		return { items, nextCursor: rows.length === 0 ? null : String(rows[rows.length - 1]!.cursorOrder), total: counts.total };
	}

	async getItemContent(input: { itemId: string }): Promise<Response> {
		const { itemId } = input;
		const record = this.store.load();
		if (!record || record.kind !== "restore" || isTerminalRecoveryState(record.state)) return new Response("restore unavailable", { status: 410 });
		const item = this.store.getRestoreItem(itemId);
		if (!item || item.outcome !== null) return new Response("restore item unavailable", { status: 410 });
		const key = item.kind === "markdown"
			? recoveryContentObjectKey(recoveryV2Prefix(vaultPrefix(record.vaultId, record.vaultGeneration)), item.contentHash)
			: blobObjectKey(record.vaultId, record.vaultGeneration, item.contentHash);
		const object = await this.bucket().get(key);
		if (!object || object.size > MAX_RESTORE_CONTENT_BYTES) return new Response("restore content missing", { status: 409 });
		let bytes = await objectBytes(object);
		if (item.kind === "markdown") bytes = gunzipRecoveryBytes(bytes, MAX_RESTORE_CONTENT_BYTES, MAX_RESTORE_CONTENT_BYTES);
		if (bytes.byteLength !== item.size || await sha256Hex(bytes) !== item.contentHash) return new Response("restore content corrupt", { status: 409 });
		return new Response(bytes, { headers: { "content-type": item.kind === "markdown" ? "text/markdown; charset=utf-8" : "application/octet-stream", "x-yaos-content-sha256": item.contentHash, "x-yaos-content-size": String(item.size) } });
	}

	async recordResults(input: { results: Array<{ itemId: string; outcome: RestoreItemOutcome; errorCode?: string }> }): Promise<{ accepted: number; complete: boolean; terminal: boolean }> {
		if (!Array.isArray(input.results) || input.results.length === 0 || input.results.length > 100) throw new Error("invalid restore result batch");
		let accepted = 0;
		for (const result of input.results) {
			if (!/^[A-Za-z0-9_-]{1,256}$/.test(result.itemId) || !["restored", "created-fresh", "skipped-changed", "failed"].includes(result.outcome)) throw new Error("invalid restore result");
			const item = this.store.getRestoreItem(result.itemId);
			if (!item) throw new Error("unknown restore item");
			if (item.kind === "markdown" && item.metadata.sourceKind === "deleted" && result.outcome === "restored") throw new Error("deleted restore must create a fresh identity");
			if (this.store.acknowledgeRestoreItem(result.itemId, result.outcome, result.errorCode ?? null)) accepted++;
		}
		const counts = this.store.restoreCounts();
		const progress = recoveryRestoreProgress(counts.total, counts.terminal);
		const record = this.store.load();
		if (record) {
			this.commit(record, { processedEntries: progress.processedEntries, totalEntries: progress.totalEntries, updatedAt: Date.now() });
			await this.ctx.storage.setAlarm(Date.now());
		}
		return { accepted, complete: progress.complete, terminal: progress.complete };
	}

	private async runGcSlice(record: RecoveryJobRecord, authority: RecoveryAuthorityRpc): Promise<void> {
		const descriptor = this.descriptor("gc");
		if (Date.now() >= descriptor.deadlineAt) {
			await authority.abortRecoveryGc({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, epoch: descriptor.epoch, capability: descriptor.capability, reason: "deadline_exceeded" });
			throw new TerminalRecoveryError("gc_deadline_exceeded", "GC epoch exceeded its deadline");
		}
		if (record.state === "queued" || record.state === "marking" || record.state === "retrying") {
			const page = await authority.getGcRootPage({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, epoch: descriptor.epoch, capability: descriptor.capability, cursor: record.cursor, maxEntries: MAX_MARK_PAGE });
			this.store.addGcMarks(page.marks.map((mark) => ({ epoch: descriptor.epoch, domain: mark.domain, objectKeyHash: mark.objectKeyHash })));
			this.store.enqueueGcFrontier(page.roots.map((root) => ({ ...root })));
			if (!page.terminal) {
				this.commit(record, { state: "marking", cursor: page.nextCursor, updatedAt: Date.now() });
				return;
			}
			const frontier = this.store.nextGcFrontier();
			if (frontier) {
				await this.traverseGcObject(descriptor, frontier);
				return;
			}
			await authority.completeGcMark({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, epoch: descriptor.epoch, capability: descriptor.capability });
			this.store.setMetadata("gc-sweep", { domainIndex: 0, cursor: null });
			this.commit(record, { state: "sweeping", cursor: null, updatedAt: Date.now() });
			return;
		}
		await this.sweepGcPage(record, descriptor, authority);
	}

	private async traverseGcObject(descriptor: GcDescriptor, frontier: { objectKey: string; domain: "recovery" | "blob" | "staging"; tree?: ManifestTreeKind }): Promise<void> {
		const hash = await sha256Hex(encoder.encode(frontier.objectKey));
		this.store.addGcMarks([{ epoch: descriptor.epoch, domain: frontier.domain, objectKeyHash: hash }]);
		const traversable = shouldTraverseRecoveryGcObject(frontier.domain, frontier.objectKey, frontier.tree);
		if (traversable) {
			const object = await this.bucket().get(frontier.objectKey);
			if (!object) throw new TerminalRecoveryError("gc_root_missing", "GC root graph object missing");
			if (frontier.objectKey.includes("/roots/sha256/")) {
				const expected = frontier.objectKey.match(/\/([a-f0-9]{64})\.json$/)?.[1];
				if (!expected) throw new TerminalRecoveryError("gc_root_corrupt", "invalid GC root key");
				const root = await parseAndVerifySnapshotRoot(await objectBytes(object), expected);
				const prefix = recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration));
				this.store.enqueueGcFrontier([
					{ objectKey: manifestNodeObjectKey(prefix, root.activeFilesTreeHash), domain: "recovery", tree: "active" },
					{ objectKey: manifestNodeObjectKey(prefix, root.deletedFilesTreeHash), domain: "recovery", tree: "deleted" },
					{ objectKey: manifestNodeObjectKey(prefix, root.attachmentsTreeHash), domain: "recovery", tree: "attachments" },
				]);
			} else if (frontier.tree) {
				const expected = frontier.objectKey.match(/\/([a-f0-9]{64})\.json\.gz$/)?.[1];
				if (!expected) throw new TerminalRecoveryError("gc_manifest_corrupt", "invalid manifest key");
				const source: ManifestNodeSource = { readNode: async () => objectBytes(object) };
				const verified = await readAndVerifyManifestNode(source, frontier.tree, expected);
				if (verified.node.format === MANIFEST_BRANCH_FORMAT) {
					this.store.enqueueGcFrontier(Object.values(verified.node.children).map((child) => ({
						objectKey: manifestNodeObjectKey(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), child.hash),
						domain: "recovery" as const,
						tree: frontier.tree,
					})));
				} else {
					const children: Array<{ objectKey: string; domain: "recovery" | "blob" }> = [];
					for (const entry of verified.node.entries) {
						if (entry.availability !== "available") continue;
						if (frontier.tree === "active") children.push({ objectKey: recoveryContentObjectKey(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), (entry as ActiveFileManifestEntry & { contentHash: string }).contentHash), domain: "recovery" });
						else if (frontier.tree === "deleted") children.push({ objectKey: recoveryContentObjectKey(recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)), (entry as DeletedFileManifestEntry & { baselineContentHash: string }).baselineContentHash), domain: "recovery" });
						else children.push({ objectKey: blobObjectKey(descriptor.vaultId, descriptor.vaultGeneration, (entry as AttachmentManifestEntry & { hash: string }).hash), domain: "blob" });
					}
					this.store.enqueueGcFrontier(children);
				}
			}
		}
		this.store.completeGcFrontier(frontier.objectKey);
	}

	private async sweepGcPage(record: RecoveryJobRecord, descriptor: GcDescriptor, authority: RecoveryAuthorityRpc): Promise<void> {
		const metadata = this.store.getParsedMetadata("gc-sweep", parseGcSweepMetadata) ?? { domainIndex: 0, cursor: null };
		const domainIndex = metadata.domainIndex;
		if (domainIndex >= descriptor.domains.length) {
			await authority.completeGcSweep({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, epoch: descriptor.epoch, capability: descriptor.capability });
			this.store.clearGcMarks(descriptor.epoch);
			this.store.clearGcFrontier();
			this.commit(record, { state: "complete", completedAt: Date.now(), updatedAt: Date.now() });
			return;
		}
		const domain = descriptor.domains[domainIndex]!;
		const prefix = domain === "recovery" ? `${recoveryV2Prefix(vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration))}/` : `${vaultPrefix(descriptor.vaultId, descriptor.vaultGeneration)}/blobs/`;
		const page = await this.bucket().list({ prefix, cursor: typeof metadata.cursor === "string" ? metadata.cursor : undefined, limit: MAX_MARK_PAGE });
		const candidates: string[] = [];
		for (const object of page.objects) {
			if (!isRecoveryGcSweepCandidate(object.uploaded.getTime(), descriptor.markStartedAt, Date.now(), descriptor.gracePeriodMs)) continue;
			const keyHash = await sha256Hex(encoder.encode(object.key));
			if (!this.store.isGcMarked(descriptor.epoch, domain, keyHash)) candidates.push(object.key);
		}
		if (candidates.length > 0) {
			const lease = await authority.acquireSweepLease({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, epoch: descriptor.epoch, ownerId: record.jobId, domain, objectKeys: candidates, capability: descriptor.capability });
			try {
				await mapFour(lease.approvedKeys, async (key) => this.bucket().delete(key));
				await authority.invalidateSweptObjects({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, epoch: descriptor.epoch, capability: descriptor.capability, leaseId: lease.leaseId, domain, objectKeys: lease.approvedKeys });
				const latest = this.store.load();
				if (latest) this.commit(latest, { deletedObjects: latest.deletedObjects + lease.approvedKeys.length, updatedAt: Date.now() });
			} finally {
				await authority.releaseSweepLease({ vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, epoch: descriptor.epoch, capability: descriptor.capability, leaseId: lease.leaseId });
			}
		}
		this.store.setMetadata("gc-sweep", page.truncated ? { domainIndex, cursor: page.cursor ?? null } : { domainIndex: domainIndex + 1, cursor: null });
	}

	private async runPurgeSlice(record: RecoveryJobRecord): Promise<void> {
		const descriptor = this.descriptor("purge");
		const prefixIndex = this.store.getParsedMetadata(
			"purge-progress",
			(value) => parseIndexMetadata(value, "purge progress", "prefixIndex"),
		) ?? 0;
		if (prefixIndex >= descriptor.allowedPrefixes.length) {
			const completedAt = Date.now();
			const completion: RecoveryJobRecord = {
				...record,
				state: "complete",
				completedAt,
				cursor: null,
				updatedAt: completedAt,
			};
			await this.publishPurgeProgress(completion, descriptor);
			this.commit(record, { state: "complete", completedAt, cursor: null, updatedAt: completedAt });
			return;
		}
		const prefix = descriptor.allowedPrefixes[prefixIndex]!;
		const page = await this.bucket().list({ prefix, limit: MAX_MARK_PAGE });
		const checkpoint = advanceRecoveryPurgeProgress(prefixIndex, page.objects.length);
		if (checkpoint.pageComplete) {
			this.store.setMetadata("purge-progress", { prefixIndex: checkpoint.prefixIndex });
			const next = this.commit(record, { state: "purging", cursor: descriptor.allowedPrefixes[checkpoint.prefixIndex] ?? null, updatedAt: Date.now() });
			await this.publishPurgeProgress(next, descriptor);
			return;
		}
		await mapFour(page.objects, async (object) => this.bucket().delete(object.key));
		const bytes = page.objects.reduce((sum, object) => sum + object.size, 0);
		const next = this.commit(record, { state: "purging", cursor: prefix, deletedObjects: record.deletedObjects + page.objects.length, deletedBytes: record.deletedBytes + bytes, updatedAt: Date.now() });
		await this.publishPurgeProgress(next, descriptor);
	}

	private async publishPurgeProgress(record: RecoveryJobRecord, descriptor: PurgeDescriptor): Promise<void> {
		const stub = this.env.YAOS_CONFIG.get(this.env.YAOS_CONFIG.idFromName("global-config"));
		const response = await stub.fetch(new Request("https://internal/__yaos/deletion/progress", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deletionId: descriptor.deletionId, vaultId: descriptor.vaultId, vaultGeneration: descriptor.vaultGeneration, jobId: record.jobId, capability: descriptor.capability, state: record.state, cursor: record.cursor, deletedObjects: record.deletedObjects, deletedBytes: record.deletedBytes, retryCount: record.retryCount, nextAttemptAt: record.nextAttemptAt, error: record.errorCode ? { code: record.errorCode, reference: record.errorRef } : null }),
		}));
		if (!response.ok) throw new RetryableRecoveryError("purge_progress_rejected", `purge progress rejected: ${response.status}`);
	}
}

export { retryDelay as recoveryRetryDelay, isRetryableFailure as isRetryableRecoveryFailure };
