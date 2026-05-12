/**
 * Shared type definitions for the vault CRDT sync plugin.
 */

import { isExcluded } from "./sync/exclude";

// -------------------------------------------------------------------
// Markdown CRDT types
// -------------------------------------------------------------------

/** Metadata stored per file ID in the CRDT meta map. */
export interface FileMeta {
	/** Vault-relative path (normalized). */
	path: string;
	/** v2 tombstone timestamp (ms since epoch). */
	deletedAt?: number;
	/** Legacy v1 soft-delete flag (kept for migration compatibility). */
	deleted?: boolean;
	/** Last-modified timestamp (ms since epoch). Informational only. */
	mtime?: number;
	/** Device that last modified this entry. */
	device?: string;
}

// -------------------------------------------------------------------
// Blob / attachment types
// -------------------------------------------------------------------

/**
 * Reference stored in pathToBlob map: vault-relative path -> blob info.
 * This is what gets synced via CRDT so other devices know which blob
 * belongs to which path.
 */
export interface BlobRef {
	/** SHA-256 hex hash of the file content. */
	hash: string;
	/** File size in bytes (denormalized for quick checks without HEAD). */
	size: number;
}

/**
 * Metadata for a content-addressed blob in R2.
 * Stored in blobMeta map: sha256 hex -> metadata.
 */
export interface BlobMeta {
	/** File size in bytes. */
	size: number;
	/** MIME type (e.g. "image/png"). */
	mime: string;
	/** Timestamp when first uploaded (ms since epoch). */
	createdAt: number;
	/** Device that first uploaded this blob. */
	device?: string;
}

/**
 * Tombstone for a deleted blob path. Prevents resurrection when a
 * device comes online with a stale disk state.
 * Stored in blobTombstones map: vault-relative path -> tombstone.
 */
export interface BlobTombstone {
	/** Timestamp when deleted (ms since epoch). */
	deletedAt: number;
	/** Device that performed the delete. */
	device?: string;
}

// -------------------------------------------------------------------
// Origins
// -------------------------------------------------------------------

/** Origin string used for Yjs transactions initiated by this plugin. */
export const ORIGIN_LOCAL = "vault-crdt-local";
// Canonical declaration lives in src/sync/origins.ts — re-exported here for
// legacy importers. New code should import directly from origins.ts.
export { ORIGIN_SEED } from "./sync/origins";

// -------------------------------------------------------------------
// File classification
// -------------------------------------------------------------------

/**
 * Check if a vault-relative path is a markdown file eligible for CRDT sync.
 * Single choke point for all ".md" checks in the codebase.
 */
export function isMarkdownSyncable(path: string, excludePatterns: string[], configDir: string): boolean {
	if (!path.endsWith(".md")) return false;
	return !isExcluded(path, excludePatterns, configDir);
}

/**
 * Check if a vault-relative path is a non-markdown file eligible for
 * blob/attachment sync. Excludes the config directory, .trash/, user patterns,
 * and markdown files (handled by the CRDT text pipeline).
 */
export function isBlobSyncable(path: string, excludePatterns: string[], configDir: string): boolean {
	if (path.endsWith(".md")) return false;
	return !isExcluded(path, excludePatterns, configDir);
}
