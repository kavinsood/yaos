import { base64UrlToBytes, bytesToBase64Url } from "./base64url.js";
import { canonicalJsonText } from "./recoveryCanonicalJson.js";
import {
	manifestNodeObjectKey,
	recoveryContentObjectKey,
	snapshotRootObjectKey as recoverySnapshotRootObjectKey,
} from "./recoveryManifestTree.js";
import { isSha256Hex } from "./hex.js";
import { isCanonicalVaultId } from "./vaultId.js";
export const RECOVERY_FORMAT = "yaos-recovery-v2" as const;
export const RECOVERY_PLAN_DIGEST_SEED = "YAOS_CAPTURE_PLAN_V1";
export const RECOVERY_DELTA_DIGEST_SEED = "YAOS_CAPTURE_DELTA_V1";
export const MAX_CAPTURE_PLAN_ENTRIES = 1_000;
export const MAX_CAPTURE_PLAN_BYTES = 4 * 1024 * 1024;
export const MAX_RECIPE_BODIES = 25;
export const MAX_RECIPE_BYTES = 4 * 1024 * 1024;
export const MAX_LEASE_KEYS = 128;
export const MAX_DEFECTS_PER_CALL = 25;
export const CAPTURE_SOFT_TTL_MS = 60 * 60_000;
export const CAPTURE_HARD_TTL_MS = 24 * 60 * 60_000;
export const KEY_LEASE_TTL_MS = 60_000;
export const SWEEP_LEASE_TTL_MS = 60_000;
export const RECOVERY_RPC_MAX_JSON_BYTES = 6 * 1024 * 1024;
export const RECOVERY_RPC_PATH = "/__yaos/recovery-rpc";
export const RECOVERY_RPC_HEADER = "x-yaos-internal-recovery-rpc";
export const RECOVERY_PUBLIC_RPC_PATH = "/__yaos/recovery-public";
export const RECOVERY_PUBLIC_RPC_HEADER = "x-yaos-internal-recovery-public";

export interface RecoveryRpcRequest {
	method: string;
	params: unknown;
}
export type RecoveryRpcResponse =
	| { ok: true; result: unknown }
	| { ok: false; error: { code: "recovery_rpc_failed"; message: string } };

export function encodeRecoveryRpcPayload(value: unknown, ancestors = new Set<object>()): unknown {
	if (value instanceof Uint8Array) return { $bytes: bytesToBase64Url(value) };
	if (value === null || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isSafeInteger(value))) return value;
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new Error("cyclic recovery RPC payload");
		ancestors.add(value);
		const result = value.map((item) => encodeRecoveryRpcPayload(item, ancestors));
		ancestors.delete(value);
		return result;
	}
	if (value && typeof value === "object") {
		if (ancestors.has(value)) throw new Error("cyclic recovery RPC payload");
		ancestors.add(value);
		const result = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) result[key] = encodeRecoveryRpcPayload(item, ancestors);
		}
		ancestors.delete(value);
		return result;
	}
	throw new Error("unsupported recovery RPC payload value");
}

export function decodeRecoveryRpcPayload(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isSafeInteger(value))) return value;
	if (Array.isArray(value)) return value.map(decodeRecoveryRpcPayload);
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 1 && entries[0]![0] === "$bytes" && typeof entries[0]![1] === "string") {
			return base64UrlToBytes(entries[0]![1]);
		}
		const result = Object.create(null) as Record<string, unknown>;
		for (const [key, item] of entries) result[key] = decodeRecoveryRpcPayload(item);
		return result;
	}
	throw new Error("invalid recovery RPC payload value");
}

export type RecoveryReason = "initial" | "daily" | "manual" | "pre-bulk-operation";
export type RecoveryCaptureState =
	| "initializing" | "queued" | "planning" | "materializing" | "building" | "publishing" | "retrying"
	| "complete" | "complete_with_gaps" | "failed" | "cancelled";
export type CapturePlanStream = "active" | "deleted" | "attachments";
export const CAPTURE_PLAN_STREAMS: readonly CapturePlanStream[] = ["active", "deleted", "attachments"];
export type RecoveryTree = CapturePlanStream;

export interface RecoveryTotals {
	activeFiles: number;
	deletedFiles: number;
	unavailableFiles: number;
	attachments: number;
	markdownBytes: number;
	attachmentBytes: number;
}

export interface CaptureDescriptor {
	captureId: string; requestId: string; vaultId: string; vaultGeneration: string; boundarySequence: number; rootGeneration: number; runtimeEpoch: string;
	reason: RecoveryReason; state: RecoveryCaptureState; jobId: string; capabilityHash: string; capabilityExpiresAt: number;
	pinSoftExpiresAt: number; pinHardExpiresAt: number; planDigest: string | null; deltaDigest: string | null;
	planComplete: boolean; gcEpoch: number | null; baseSnapshotId: string | null; plannedActiveFiles: number;
	plannedDeletedFiles: number; plannedAttachments: number; snapshotRootKey: string | null; snapshotRootHash: string | null;
	createdAt: number; updatedAt: number; error: string | null;
}

export interface StartCaptureRequest { vaultId: string; reason: RecoveryReason; requestId: string }
export interface CaptureStarted { captureId: string; boundarySequence: number; state: "queued"; statusUrl: string }
export interface CaptureStatus {
	captureId: string; state: RecoveryCaptureState; boundarySequence: number;
	processedEntries: number; totalEntries: number | null; contentObjectsWritten: number; contentObjectsReused: number;
	manifestNodesWritten: number; bytesRead: number; bytesWritten: number; retryCount: number; nextAttemptAt: number | null;
	pinSoftExpiresAt: number | null; pinHardExpiresAt: number | null; snapshotId: string | null;
	error: { code: string; reference: string | null } | null;
}

export type RestoreSelection =
	| { kind: "all" }
	| { kind: "markdown-paths"; paths: string[] }
	| { kind: "attachment-paths"; paths: string[] }
	| { kind: "deleted-identities"; bodyIds: string[] };
export interface RestoreDescriptor {
	jobId?: string; vaultId: string; vaultGeneration: string; createdAt: number; capability: string; capabilityExpiresAt: number;
	restoreId: string; snapshotId: string; selection: RestoreSelection;
}
export interface GcDescriptor {
	jobId?: string; vaultId: string; vaultGeneration: string; createdAt: number; capability: string; capabilityExpiresAt: number;
	epoch: number; markStartedAt: number; deadlineAt: number; gracePeriodMs: number; domains: Array<"recovery" | "blob">;
}
export interface ProjectionWorkPageRequest {
	vaultId: string; vaultGeneration: string; leaseId: string; capability: string; cursor: string | null; maxEntries: number; maxResponseBytes: number;
}
export interface ProjectionWorkPage {
	entries: Array<{ bodyId: string; generation: number; contentHash: string; size: number }>;
	nextCursor: string | null; terminal: boolean;
}
export interface GcRootPageRequest {
	vaultId: string; vaultGeneration: string; epoch: number; capability: string; cursor: string | null; maxEntries: number;
}
export interface GcRootPage {
	roots: Array<{ objectKey: string; domain: "recovery" | "blob" }>;
	marks: Array<{ objectKeyHash: string; domain: "recovery" | "blob" | "staging" }>;
	nextCursor: string | null; terminal: boolean;
}
export interface CapturePlanRequest {
	vaultId: string; vaultGeneration: string; captureId: string; boundarySequence: number; capability: string; stream: CapturePlanStream;
	cursor: string | null; maxEntries: number; maxResponseBytes: number;
}
export type CapturePlanEntry =
	| { kind: "active"; bodyId: string; fileId: string; canonicalPath: string; generation: number; contentHash: string; size: number }
	| { kind: "deleted"; bodyId: string; fileId: string; lastPath: string; generation: number; baselineContentHash: string; baselineSize: number; bodyReaped: boolean; deletedAtSequence: number }
	| { kind: "attachment"; canonicalPath: string; contentHash: string; size: number; mime: string | null };
export interface CapturePlanResponse {
	entries: CapturePlanEntry[]; casHints: Record<string, boolean>; nextCursor: string | null; terminal: boolean;
	pageHash: string; planDigest: string;
}
export interface RecoveryJobLeaseRequest { vaultId?: string; vaultGeneration?: string; captureId: string; boundarySequence: number; capability: string; progress?: number }
export interface RecoveryJobLeaseStatus {
	valid: true; captureId: string; boundarySequence: number; state: RecoveryCaptureState;
	softExpiresAt: number; hardExpiresAt: number; baseSnapshotId: string | null;
}

export interface RecipeDescriptorRequest {
	vaultId: string; vaultGeneration: string; captureId: string; boundarySequence: number; capability: string;
	entries: Array<{ bodyId: string; generation: number }>;
}
export interface BodyRecipeDescriptor {
	recipeId: string; bodyId: string; generation: number; expectedContentHash: string; expectedSize: number;
	encodedHistoryBytes: number; firstCursor: string;
}
export interface RecipeChunkRequest { captureId: string; boundarySequence: number; capability: string; recipeId: string; cursor: string; maxResponseBytes: number }
export interface RecipeChunkPart { kind: "checkpoint" | "journal"; sequence: number; update: Uint8Array }
export interface RecipeChunk { recipeId: string; cursor: string; nextCursor: string | null; parts: RecipeChunkPart[]; encodedBytes: number }

export interface MaterializationLeaseRequest { ownerKind: "capture" | "projection"; ownerId: string; capability: string; objectKeys: string[]; ttlMs?: number }
export interface MaterializationLease { leaseId: string; ownerKind: "capture" | "projection"; ownerId: string; objectKeys: string[]; expiresAt: number }
export interface ContentMaterialized {
	captureId: string; boundarySequence: number; capability: string; bodyId: string; generation: number;
	contentHash: string; plainBytes: number; objectKey: string;
}
export interface ManifestNodeMaterialized {
	captureId: string; boundarySequence: number; capability: string; tree: RecoveryTree; logicalPrefix: string;
	nodeHash: string; objectKey: string; nodeFormat: "yaos-manifest-branch-v1" | "yaos-manifest-leaf-v1";
	subtreeEntries: number; subtreeNodes: number; provenanceSnapshotId?: string | null;
}
export interface CoverageCheckRequest { captureId: string; boundarySequence: number; capability: string; contentHashes: string[]; nodeHashes?: string[] }
export interface CoverageCheckResponse { missingContentHashes: string[]; missingNodeHashes: string[] }

export interface IncrementalBase { snapshotId: string; boundarySequence: number; rootKey: string; rootHash: string }
export interface CatalogDeltaPageRequest {
	captureId: string; boundarySequence: number; capability: string; afterSequence: number; cursor: string | null;
	maxEntries: number; maxResponseBytes: number;
}
export interface CatalogDeltaEntry {
	sequence: number; order: number; kind: "create" | "rename" | "delete" | "revive" | "body-hash" | "attachment-upsert" | "attachment-delete";
	identity: string; path: string; previousPath: string | null; contentHash: string | null; size: number | null; mime: string | null;
}
export interface CatalogDeltaPageResponse { entries: CatalogDeltaEntry[]; nextCursor: string | null; terminal: boolean; pageHash: string; deltaDigest: string }

export interface RecoveryDefectRecord {
	captureId: string; kind: "active" | "deleted" | "attachment"; identity: string; generation: number | null;
	code: string; referenceHash: string; createdAt: number;
}
export interface RecordRecoveryDefectsRequest { captureId: string; boundarySequence: number; capability: string; defects: RecoveryDefectRecord[] }

export interface FinalizeCaptureRequest {
	captureId: string; boundarySequence: number; capability: string; sourcePlanDigest: string; sourceDeltaDigest: string | null;
	manifestGraphDigest: string; manifestNodeCount: number; snapshotRootKey: string; snapshotRootHash: string; totals: RecoveryTotals;
	completedAt: number;
}
export interface FinalizedCapture { snapshotId: string; rootKey: string; rootHash: string; completedAt: number; state: "complete" }
export interface RecoverySnapshotCatalogEntry {
	snapshotId: string; boundarySequence: number; rootKey: string; rootHash: string; reason: RecoveryReason;
	pinned: boolean; createdAt: number; completedAt: number;
}

export interface AttachmentCatalogMutation {
	operationId: string; kind: "upsert" | "delete" | "rename"; path: string; toPath?: string; contentHash?: string;
	size?: number; mime?: string | null; createdAt?: number; deletedAt?: number; device?: string; rootUpdate: Uint8Array;
}
export interface AttachmentCatalogEvent {
	sequence: number; path: string; contentHash: string | null; size: number | null; mime: string | null; lifecycle: "active" | "deleted";
}

export interface ProjectionLease { vaultId: string; vaultGeneration: string; leaseId: string; capabilityHash: string; expiresAt: number; enabled: boolean; runtimeEpoch: string }
export interface ProjectionRecipeRequest { vaultId: string; vaultGeneration: string; leaseId: string; capability: string; bodyId: string; expectedHeadGeneration: number }

export interface RecoverySnapshotDependency { operationKind: "capture" | "restore"; operationId: string; snapshotId: string }
export interface GcEpoch { epoch: number; requestId: string; state: "marking" | "sweeping" | "complete" | "aborted"; markBoundarySequence: number; markStartedAt: number; markCompletedAt: number | null; sweepCompletedAt: number | null; deadlineAt: number }
export interface SweepLeaseRequest { epoch: number; ownerId: string; domain: "recovery" | "blob"; objectKeys: string[]; ttlMs?: number }
export interface SweepLease { leaseId: string; epoch: number; ownerId: string; domain: "recovery" | "blob"; approvedKeys: string[]; expiresAt: number }

export const canonicalJson = canonicalJsonText;

export function isSafeRecoveryIdentity(value: string): boolean { return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value); }
export function vaultGenerationPrefix(vaultId: string, vaultGeneration: string): string {
	if (!isCanonicalVaultId(vaultId) || !isCanonicalVaultId(vaultGeneration)) throw new Error("invalid vault identity");
	return `vault/${encodeURIComponent(vaultId)}/${encodeURIComponent(vaultGeneration)}`;
}
export function recoveryPrefix(vaultId: string, vaultGeneration: string): string {
	return `${vaultGenerationPrefix(vaultId, vaultGeneration)}/recovery-v2`;
}
export function blobObjectKey(vaultId: string, vaultGeneration: string, hash: string): string {
	if (!isSha256Hex(hash)) throw new Error("invalid blob hash");
	return `${vaultGenerationPrefix(vaultId, vaultGeneration)}/blobs/${hash}`;
}
export function contentObjectKey(vaultId: string, vaultGeneration: string, hash: string): string {
	return recoveryContentObjectKey(recoveryPrefix(vaultId, vaultGeneration), hash);
}
export function manifestObjectKey(vaultId: string, vaultGeneration: string, hash: string): string {
	return manifestNodeObjectKey(recoveryPrefix(vaultId, vaultGeneration), hash);
}
export function snapshotRootObjectKey(vaultId: string, vaultGeneration: string, hash: string): string {
	return recoverySnapshotRootObjectKey(recoveryPrefix(vaultId, vaultGeneration), hash);
}
