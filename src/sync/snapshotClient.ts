/**
 * Plugin-side snapshot client.
 *
 * Communicates with the server's snapshot endpoints to:
 *   - Trigger daily/on-demand snapshots
 *   - List available snapshots
 *   - Download snapshot CRDT data for restore
 *   - Diff snapshot state against current CRDT
 *   - Restore selected files (soft restore: replace Y.Text content)
 */

import * as Y from "yjs";
import { gunzipSync } from "fflate";
import type { VaultSyncSettings } from "../settings";
import type { FileMeta, BlobRef } from "../types";
import { appendTraceParams, type TraceHttpContext } from "../debug/trace";
import { obsidianRequest } from "../utils/http";
import { yTextToString } from "../utils/format";
import { normalizeVaultPath } from "../utils/normalizeVaultPath";

// -------------------------------------------------------------------
// Types (mirrors server SnapshotIndex)
// -------------------------------------------------------------------

export interface SnapshotIndex {
	snapshotId: string;
	vaultId: string;
	createdAt: string;
	day: string;
	schemaVersion: number | undefined;
	markdownFileCount: number;
	blobFileCount: number;
	crdtSizeBytes: number;
	crdtRawSizeBytes: number;
	referencedBlobHashes: string[];
	triggeredBy?: string;
}

export interface SnapshotResult {
	status: "created" | "noop" | "unavailable";
	snapshotId?: string;
	snapshotKey?: string;
	reason?: string;
	index?: SnapshotIndex;
	error?: string;
}

/**
 * Diff between a snapshot and the current CRDT state.
 */
export interface SnapshotDiff {
	/** Files present in snapshot but not in current CRDT (deleted since snapshot). */
	deletedSinceSnapshot: Array<{ path: string; fileId: string }>;
	/** Files present in current CRDT but not in snapshot (created since snapshot). */
	createdSinceSnapshot: string[];
	/** Files present in both but with different content. */
	contentChanged: Array<{ path: string; fileId: string; snapshotContent: string; currentContent: string }>;
	/** Files present in both with identical content. */
	unchanged: string[];
	/** Blob paths in snapshot but not in current state. */
	blobsDeletedSinceSnapshot: Array<{ path: string; hash: string }>;
	/** Blob paths in current state but not in snapshot. */
	blobsCreatedSinceSnapshot: string[];
	/** Blob paths with different hashes. */
	blobsChanged: Array<{ path: string; snapshotHash: string; currentHash: string }>;
}


function getStoredSchemaVersion(doc: Y.Doc): number | null {
	const stored = doc.getMap("sys").get("schemaVersion");
	if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 0) return null;
	return stored;
}

function usesV2MetaPathModel(doc: Y.Doc): boolean {
	const version = getStoredSchemaVersion(doc);
	return version !== null && version >= 2;
}

function isCandidateMetaNewer(
	candidateId: string,
	candidateMeta: FileMeta,
	existingId: string,
	existingMeta: FileMeta | undefined,
): boolean {
	const candidateMtime = typeof candidateMeta.mtime === "number" ? candidateMeta.mtime : 0;
	const existingMtime = typeof existingMeta?.mtime === "number" ? existingMeta.mtime : 0;
	if (candidateMtime !== existingMtime) return candidateMtime > existingMtime;
	return candidateId > existingId;
}

/**
 * Resolve active markdown paths from a doc.
 *
 * v2: meta is authoritative and pathToId is ignored.
 * v1/legacy: prefer pathToId, then backfill from active meta entries.
 */
function collectActiveMarkdownPaths(doc: Y.Doc): Map<string, string> {
	const meta = doc.getMap<FileMeta>("meta");
	const pathToId = doc.getMap<string>("pathToId");
	const resolved = new Map<string, string>();

	if (usesV2MetaPathModel(doc)) {
		meta.forEach((entry, fileId) => {
			if (isDeletedMeta(entry) || typeof entry.path !== "string") return;
			const path = normalizeVaultPath(entry.path);
			if (!path) return;
			const existingId = resolved.get(path);
			if (!existingId) {
				resolved.set(path, fileId);
				return;
			}
			const existingMeta = meta.get(existingId);
			if (isCandidateMetaNewer(fileId, entry, existingId, existingMeta)) {
				resolved.set(path, fileId);
			}
		});
		return resolved;
	}

	// v1 compatibility: pathToId remains authoritative.
	pathToId.forEach((fileId, rawPath) => {
		const path = normalizeVaultPath(rawPath);
		if (!path) return;
		const entry = meta.get(fileId);
		if (isDeletedMeta(entry)) return;
		resolved.set(path, fileId);
	});

	// Backfill paths that only exist in meta (mixed/partially migrated states).
	meta.forEach((entry, fileId) => {
		if (isDeletedMeta(entry) || typeof entry.path !== "string") return;
		const path = normalizeVaultPath(entry.path);
		if (!path || resolved.has(path)) return;
		resolved.set(path, fileId);
	});

	return resolved;
}

// -------------------------------------------------------------------
// HTTP client
// -------------------------------------------------------------------

/**
 * Build the base URL for server HTTP endpoints.
 */
function baseUrl(settings: VaultSyncSettings): string {
	const host = settings.host.replace(/\/$/, "");
	return `${host}/vault/${encodeURIComponent(settings.vaultId)}`;
}

async function serverPost(
	settings: VaultSyncSettings,
	endpoint: string,
	body?: Record<string, unknown>,
	trace?: TraceHttpContext,
): Promise<unknown> {
	const url = appendTraceParams(
		`${baseUrl(settings)}/${endpoint}`,
		trace,
	);
	const res = await obsidianRequest({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${settings.token}`,
		},
		body: body ? JSON.stringify(body) : "{}",
		contentType: "application/json",
	});
	if (res.status < 200 || res.status >= 300) {
		const text = res.text;
		throw new Error(`Server ${endpoint} failed (${res.status}): ${text}`);
	}
	return res.json;
}

async function serverGet(
	settings: VaultSyncSettings,
	endpoint: string,
	trace?: TraceHttpContext,
): Promise<unknown> {
	const url = appendTraceParams(
		`${baseUrl(settings)}/${endpoint}`,
		trace,
	);
	const res = await obsidianRequest({
		url,
		method: "GET",
		headers: {
			Authorization: `Bearer ${settings.token}`,
		},
	});
	if (res.status < 200 || res.status >= 300) {
		const text = res.text;
		throw new Error(`Server ${endpoint} failed (${res.status}): ${text}`);
	}
	return res.json;
}

// -------------------------------------------------------------------
// Snapshot triggers
// -------------------------------------------------------------------

/**
 * Request a daily snapshot (noop if already done today).
 */
export async function requestDailySnapshot(
	settings: VaultSyncSettings,
	device?: string,
	trace?: TraceHttpContext,
): Promise<SnapshotResult> {
	return await serverPost(settings, "snapshots/maybe", { device }, trace) as SnapshotResult;
}

/**
 * Force-create a snapshot right now.
 */
export async function requestSnapshotNow(
	settings: VaultSyncSettings,
	device?: string,
	trace?: TraceHttpContext,
): Promise<SnapshotResult> {
	return await serverPost(settings, "snapshots", { device }, trace) as SnapshotResult;
}

// -------------------------------------------------------------------
// Snapshot listing
// -------------------------------------------------------------------

/**
 * List all available snapshots, newest first.
 */
export async function listSnapshots(
	settings: VaultSyncSettings,
	trace?: TraceHttpContext,
): Promise<SnapshotIndex[]> {
	const result = await serverGet(settings, "snapshots", trace) as { snapshots: SnapshotIndex[] };
	return result.snapshots ?? [];
}

// -------------------------------------------------------------------
// Snapshot download + decode
// -------------------------------------------------------------------

/**
 * Download and decode a snapshot's CRDT data into a temporary Y.Doc.
 * The returned doc is a standalone offline doc — not connected to any provider.
 */
export async function downloadSnapshot(
	settings: VaultSyncSettings,
	snapshot: SnapshotIndex,
	trace?: TraceHttpContext,
): Promise<Y.Doc> {
	const url = appendTraceParams(
		`${baseUrl(settings)}/snapshots/${encodeURIComponent(snapshot.snapshotId)}`,
		trace,
	);
	const res = await obsidianRequest({
		url,
		method: "GET",
		headers: {
			Authorization: `Bearer ${settings.token}`,
		},
	});
	if (res.status !== 200) {
		throw new Error(`Snapshot download failed (${res.status})`);
	}

	const compressed = new Uint8Array(res.arrayBuffer);

	// Decompress
	const rawUpdate = gunzipSync(compressed);

	// Apply to a fresh Y.Doc
	const snapshotDoc = new Y.Doc();
	Y.applyUpdate(snapshotDoc, rawUpdate);

	return snapshotDoc;
}

// -------------------------------------------------------------------
// Diff
// -------------------------------------------------------------------

/**
 * Compute a diff between a snapshot Y.Doc and the live Y.Doc.
 * Returns structured information about what changed.
 */
export function diffSnapshot(
	snapshotDoc: Y.Doc,
	liveDoc: Y.Doc,
): SnapshotDiff {
	const snapIdToText = snapshotDoc.getMap<Y.Text>("idToText");
	const snapPathToBlob = snapshotDoc.getMap<BlobRef>("pathToBlob");

	const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
	const livePathToBlob = liveDoc.getMap<BlobRef>("pathToBlob");

	const diff: SnapshotDiff = {
		deletedSinceSnapshot: [],
		createdSinceSnapshot: [],
		contentChanged: [],
		unchanged: [],
		blobsDeletedSinceSnapshot: [],
		blobsCreatedSinceSnapshot: [],
		blobsChanged: [],
	};

	const snapshotPaths = collectActiveMarkdownPaths(snapshotDoc); // path -> fileId
	const livePaths = collectActiveMarkdownPaths(liveDoc); // path -> fileId

	// Markdown diff
	for (const [path, snapFileId] of snapshotPaths) {
		const liveFileId = livePaths.get(path);
		if (!liveFileId) {
			// Deleted since snapshot
			diff.deletedSinceSnapshot.push({ path, fileId: snapFileId });
			continue;
		}

		const snapText = snapIdToText.get(snapFileId);
		const liveText = liveIdToText.get(liveFileId);
		const snapContent = yTextToString(snapText) ?? "";
		const liveContent = yTextToString(liveText) ?? "";

		if (snapContent === liveContent) {
			diff.unchanged.push(path);
		} else {
			diff.contentChanged.push({
				path,
				fileId: snapFileId,
				snapshotContent: snapContent,
				currentContent: liveContent,
			});
		}
	}

	// Files created since snapshot
	for (const path of livePaths.keys()) {
		if (!snapshotPaths.has(path)) {
			diff.createdSinceSnapshot.push(path);
		}
	}

	// Blob diff
	const snapshotBlobs = new Map<string, string>(); // path -> hash
	snapPathToBlob.forEach((ref, path) => {
		snapshotBlobs.set(path, ref.hash);
	});

	const liveBlobs = new Map<string, string>();
	livePathToBlob.forEach((ref, path) => {
		liveBlobs.set(path, ref.hash);
	});

	for (const [path, snapHash] of snapshotBlobs) {
		const liveHash = liveBlobs.get(path);
		if (!liveHash) {
			diff.blobsDeletedSinceSnapshot.push({ path, hash: snapHash });
		} else if (liveHash !== snapHash) {
			diff.blobsChanged.push({ path, snapshotHash: snapHash, currentHash: liveHash });
		}
	}

	for (const path of liveBlobs.keys()) {
		if (!snapshotBlobs.has(path)) {
			diff.blobsCreatedSinceSnapshot.push(path);
		}
	}

	return diff;
}

// -------------------------------------------------------------------
// Restore
// -------------------------------------------------------------------

/** Origin for restore transactions, so disk mirror and other observers can identify them. */
export const ORIGIN_RESTORE = "snapshot-restore";

export interface RestoreOptions {
	/** Paths of markdown files to restore from the snapshot. */
	markdownPaths?: string[];
	/** Paths of blob files to restore from the snapshot (re-point pathToBlob). */
	blobPaths?: string[];
	/** Device name for metadata. */
	device?: string;
}

export interface RestoreResult {
	/** Number of markdown files restored (content replaced). */
	markdownRestored: number;
	/** Number of markdown files undeleted (re-added from tombstone). */
	markdownUndeleted: number;
	/** Number of blob references restored. */
	blobsRestored: number;
}

/**
 * Soft restore: apply snapshot content to the live Y.Doc for selected files.
 *
 * For markdown: replaces the Y.Text content with snapshot content.
 * For blobs: re-points pathToBlob to the snapshot's hash.
 *
 * This is a "soft" restore — it operates within the existing CRDT, so
 * changes propagate to all connected devices. If another device has
 * concurrent edits, Yjs will merge them.
 */
export function restoreFromSnapshot(
	snapshotDoc: Y.Doc,
	liveDoc: Y.Doc,
	options: RestoreOptions,
): RestoreResult {
	const snapIdToText = snapshotDoc.getMap<Y.Text>("idToText");
	const snapPathToBlob = snapshotDoc.getMap<BlobRef>("pathToBlob");

	const livePathToId = liveDoc.getMap<string>("pathToId");
	const liveIdToText = liveDoc.getMap<Y.Text>("idToText");
	const liveMeta = liveDoc.getMap<FileMeta>("meta");
	const livePathToBlob = liveDoc.getMap<BlobRef>("pathToBlob");
	const liveBlobTombstones = liveDoc.getMap("blobTombstones");
	const liveUsesV2 = usesV2MetaPathModel(liveDoc);
	const snapshotPaths = collectActiveMarkdownPaths(snapshotDoc);
	const livePaths = collectActiveMarkdownPaths(liveDoc);

	const result: RestoreResult = {
		markdownRestored: 0,
		markdownUndeleted: 0,
		blobsRestored: 0,
	};

	liveDoc.transact(() => {
		// Restore markdown files
		for (const requestedPath of options.markdownPaths ?? []) {
			const path = normalizeVaultPath(requestedPath);
			const snapFileId = snapshotPaths.get(path);
			if (!snapFileId) continue;

			const snapText = snapIdToText.get(snapFileId);
			if (!snapText) continue;
			const snapContent = snapText.toJSON();

			const liveFileId = livePaths.get(path);

			if (liveFileId) {
				// File still exists in live — replace content
				const liveText = liveIdToText.get(liveFileId);
				if (liveText) {
					const currentContent = liveText.toJSON();
					if (currentContent !== snapContent) {
						liveText.delete(0, liveText.length);
						liveText.insert(0, snapContent);
						result.markdownRestored++;

						// Update metadata
						liveMeta.set(liveFileId, {
							path,
							deleted: undefined,
							deletedAt: undefined,
							mtime: Date.now(),
							device: options.device,
						});
					}
				}
				if (!liveUsesV2) {
					livePathToId.set(path, liveFileId);
				}
				livePaths.set(path, liveFileId);
			} else {
				// File was deleted since snapshot — undelete
				// Re-create with the snapshot's file ID and content
				if (!liveUsesV2) {
					livePathToId.set(path, snapFileId);
				}

				// Check if the Y.Text still exists (tombstoning doesn't delete it)
				let liveText = liveIdToText.get(snapFileId);
				if (liveText) {
					// Clear and replace content
					if (liveText.length > 0) {
						liveText.delete(0, liveText.length);
					}
					liveText.insert(0, snapContent);
				} else {
					// Create a new Y.Text with the snapshot content
					liveText = new Y.Text();
					liveText.insert(0, snapContent);
					liveIdToText.set(snapFileId, liveText);
				}

				// Drop stale tombstones for this path to avoid path-squat ghosts.
				const staleTombstones: string[] = [];
				liveMeta.forEach((entry, fileId) => {
					if (
						fileId !== snapFileId
						&& entry.path === path
						&& isDeletedMeta(entry)
					) {
						staleTombstones.push(fileId);
					}
				});
				for (const staleId of staleTombstones) {
					liveMeta.delete(staleId);
				}

				// Clear tombstone and set fresh metadata
				liveMeta.set(snapFileId, {
					path,
					deleted: undefined,
					deletedAt: undefined,
					mtime: Date.now(),
					device: options.device,
				});
				livePaths.set(path, snapFileId);

				result.markdownUndeleted++;
			}
		}

		// Restore blob references
		for (const path of options.blobPaths ?? []) {
			const snapRef = snapPathToBlob.get(path);
			if (!snapRef) continue;

			livePathToBlob.set(path, snapRef);

			// Clear any tombstone at this path
			if (liveBlobTombstones.has(path)) {
				liveBlobTombstones.delete(path);
			}

			result.blobsRestored++;
		}
	}, ORIGIN_RESTORE);

	return result;
}
function isDeletedMeta(meta: FileMeta | undefined): boolean {
	if (!meta) return false;
	return meta.deleted === true || (typeof meta.deletedAt === "number" && Number.isFinite(meta.deletedAt));
}
