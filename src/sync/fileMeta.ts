/**
 * Unified metadata read/write helpers for schema v2 (flat) and v3 (nested Y.Map) metadata.
 *
 * This module is the ONLY legal interface for reading/writing file metadata values.
 * All call sites must use these helpers instead of accessing metadata entries directly.
 *
 * Schema v3 uses nested Y.Map entries for field-level CRDT resolution.
 * Schema v2 used opaque JSON objects (FileMeta interface).
 * Readers must handle both shapes. Writers always produce nested Y.Maps.
 */

import * as Y from "yjs";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

/** Discriminator for which shape an entry was decoded from. */
export type FileMetaShape = "flat" | "nested";

/** Decoded metadata regardless of underlying storage shape. */
export interface DecodedFileMeta {
	shape: FileMetaShape;
	path: string;
	deletedAt?: number;
	deleted?: boolean;
	mtime?: number;
	device?: string;
}

/** Semantic change kinds emitted by metadata observers. */
export type MetaSemanticChange =
	| { kind: "added"; fileId: string; next: DecodedFileMeta }
	| { kind: "removed"; fileId: string; previous: DecodedFileMeta }
	| {
		kind: "path-changed";
		fileId: string;
		previousPath: string;
		nextPath: string;
		/** True if the entry was a tombstone before the path changed. */
		wasDeleted: boolean;
		/** True if the entry is a tombstone after the path changed. */
		isDeleted: boolean;
	}
	| { kind: "deleted"; fileId: string; path: string; deletedAt: number }
	| { kind: "revived"; fileId: string; path: string }
	| { kind: "mtime-changed"; fileId: string; path: string }
	| { kind: "device-changed"; fileId: string; path: string }
	| { kind: "invalid"; fileId: string };

/**
 * A batch of semantic metadata changes emitted by a single Yjs transaction.
 * Carries transaction origin so consumers can distinguish local from remote.
 */
export interface MetaChangeBatch {
	/**
	 * The Yjs transaction origin. Matches the second argument passed to
	 * `doc.transact(fn, origin)`. May be a string constant, a provider
	 * instance, or null for undistinguished local mutations.
	 */
	origin: unknown;
	/**
	 * True when this batch originated from a local transaction (known
	 * local origin strings, or any non-provider non-remote origin).
	 * DiskMirror must ignore local batches to avoid treating local
	 * metadata writes as remote file changes.
	 */
	isLocal: boolean;
	/** The semantic changes within this transaction. */
	changes: MetaSemanticChange[];
}

// -------------------------------------------------------------------
// Type guards
// -------------------------------------------------------------------

/** Check if a metadata value is a nested Y.Map (v3 schema). */
export function isNestedFileMeta(value: unknown): value is Y.Map<unknown> {
	return value instanceof Y.Map;
}

/** Check if a metadata value is a plain object record (v2 schema). */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !(value instanceof Y.Map);
}

// -------------------------------------------------------------------
// Decoder
// -------------------------------------------------------------------

/**
 * Decode a metadata value from either flat (v2) or nested (v3) shape into
 * a normalized DecodedFileMeta. Returns null for invalid/unrecognizable values.
 */
export function decodeFileMeta(value: unknown): DecodedFileMeta | null {
	if (value instanceof Y.Map) {
		const path = value.get("path");
		if (typeof path !== "string" || path.length === 0) return null;

		const deletedAtRaw = value.get("deletedAt");
		const deletedRaw = value.get("deleted");
		const mtimeRaw = value.get("mtime");
		const deviceRaw = value.get("device");

		const deletedAt =
			typeof deletedAtRaw === "number" && Number.isFinite(deletedAtRaw)
				? deletedAtRaw
				: undefined;

		const deleted = deletedRaw === true ? true : undefined;

		const mtime =
			typeof mtimeRaw === "number" && Number.isFinite(mtimeRaw)
				? mtimeRaw
				: undefined;

		const device = typeof deviceRaw === "string" ? deviceRaw : undefined;

		return {
			shape: "nested",
			path,
			...(deletedAt !== undefined ? { deletedAt } : {}),
			...(deleted !== undefined ? { deleted } : {}),
			...(mtime !== undefined ? { mtime } : {}),
			...(device !== undefined ? { device } : {}),
		};
	}

	if (isObjectRecord(value)) {
		const path = (value as Record<string, unknown>).path;
		if (typeof path !== "string" || path.length === 0) return null;

		const deletedAtRaw = (value as Record<string, unknown>).deletedAt;
		const deletedRaw = (value as Record<string, unknown>).deleted;
		const mtimeRaw = (value as Record<string, unknown>).mtime;
		const deviceRaw = (value as Record<string, unknown>).device;

		const deletedAt =
			typeof deletedAtRaw === "number" && Number.isFinite(deletedAtRaw)
				? deletedAtRaw
				: undefined;

		const deleted = deletedRaw === true ? true : undefined;

		const mtime =
			typeof mtimeRaw === "number" && Number.isFinite(mtimeRaw)
				? mtimeRaw
				: undefined;

		const device = typeof deviceRaw === "string" ? deviceRaw : undefined;

		return {
			shape: "flat",
			path,
			...(deletedAt !== undefined ? { deletedAt } : {}),
			...(deleted !== undefined ? { deleted } : {}),
			...(mtime !== undefined ? { mtime } : {}),
			...(device !== undefined ? { device } : {}),
		};
	}

	return null;
}

// -------------------------------------------------------------------
// Read helpers
// -------------------------------------------------------------------

/** Get the path from a metadata value (flat or nested). Returns null if invalid. */
export function getMetaPath(value: unknown): string | null {
	if (value instanceof Y.Map) {
		const path = value.get("path");
		return typeof path === "string" && path.length > 0 ? path : null;
	}
	if (isObjectRecord(value)) {
		const path = (value as Record<string, unknown>).path;
		return typeof path === "string" && path.length > 0 ? (path as string) : null;
	}
	return null;
}

/** Get the mtime from a metadata value (flat or nested). Returns null if absent/invalid. */
export function getMetaMtime(value: unknown): number | null {
	if (value instanceof Y.Map) {
		const mtime = value.get("mtime");
		return typeof mtime === "number" && Number.isFinite(mtime) ? mtime : null;
	}
	if (isObjectRecord(value)) {
		const mtime = (value as Record<string, unknown>).mtime;
		return typeof mtime === "number" && Number.isFinite(mtime) ? mtime : null;
	}
	return null;
}

/** Get the device from a metadata value (flat or nested). Returns null if absent. */
export function getMetaDevice(value: unknown): string | null {
	if (value instanceof Y.Map) {
		const device = value.get("device");
		return typeof device === "string" ? device : null;
	}
	if (isObjectRecord(value)) {
		const device = (value as Record<string, unknown>).device;
		return typeof device === "string" ? (device as string) : null;
	}
	return null;
}

/** Get the deletedAt timestamp from a metadata value. Returns null if not tombstoned. */
export function getMetaDeletedAt(value: unknown): number | null {
	if (value instanceof Y.Map) {
		const deletedAt = value.get("deletedAt");
		return typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : null;
	}
	if (isObjectRecord(value)) {
		const deletedAt = (value as Record<string, unknown>).deletedAt;
		return typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : null;
	}
	return null;
}

/** Check if a metadata value represents a deleted/tombstoned entry. Works with both shapes. */
export function isFileMetaDeletedValue(value: unknown): boolean {
	if (value instanceof Y.Map) {
		const deletedAt = value.get("deletedAt");
		if (typeof deletedAt === "number" && Number.isFinite(deletedAt)) return true;
		const deleted = value.get("deleted");
		return deleted === true;
	}
	if (isObjectRecord(value)) {
		const rec = value as Record<string, unknown>;
		if (typeof rec.deletedAt === "number" && Number.isFinite(rec.deletedAt)) return true;
		return rec.deleted === true;
	}
	return false;
}

// -------------------------------------------------------------------
// Write helpers — always produce nested Y.Map
// -------------------------------------------------------------------

/**
 * Create a nested Y.Map for an active (non-deleted) metadata entry.
 * This is the canonical way to create new metadata in schema v3.
 */
export function createNestedActiveMeta(
	path: string,
	mtime: number,
	device?: string,
): Y.Map<unknown> {
	const entry = new Y.Map<unknown>();
	entry.set("path", path);
	entry.set("mtime", mtime);
	if (device) entry.set("device", device);
	return entry;
}

/**
 * Create a nested Y.Map for a tombstoned metadata entry.
 * Tombstones are intentionally minimal: only path + deletedAt.
 */
export function createNestedDeletedMeta(
	path: string,
	deletedAt: number,
): Y.Map<unknown> {
	const entry = new Y.Map<unknown>();
	entry.set("path", path);
	entry.set("deletedAt", deletedAt);
	return entry;
}

/**
 * Create a nested Y.Map from a decoded metadata object.
 * Used during lazy conversion from flat to nested.
 */
export function createNestedMetaFromDecoded(decoded: DecodedFileMeta): Y.Map<unknown> {
	const entry = new Y.Map<unknown>();
	entry.set("path", decoded.path);

	// Tombstone entries
	if (decoded.deleted === true || typeof decoded.deletedAt === "number") {
		entry.set("deletedAt", decoded.deletedAt ?? Date.now());
		// Tombstones do NOT carry mtime/device
		return entry;
	}

	// Active entries
	if (typeof decoded.mtime === "number") {
		entry.set("mtime", decoded.mtime);
	}
	if (typeof decoded.device === "string") {
		entry.set("device", decoded.device);
	}

	return entry;
}

// -------------------------------------------------------------------
// Lazy conversion helper
// -------------------------------------------------------------------

/**
 * Ensure the metadata entry for a given fileId is a nested Y.Map.
 * If it's already nested, returns it directly.
 * If it's flat, converts it to nested (lazy on-write migration) and replaces the entry.
 * If it doesn't exist or is invalid, creates a new nested entry from the fallback.
 *
 * Returns null if no valid entry exists and no fallback is provided.
 *
 * IMPORTANT: This mutates the meta map (replaces the entry) when converting from flat.
 * Call this within a Yjs transaction for consistency.
 */
export function ensureNestedMetaEntry(
	metaMap: Y.Map<unknown>,
	fileId: string,
	fallback?: DecodedFileMeta,
): Y.Map<unknown> | null {
	const existing = metaMap.get(fileId);

	// Already nested — return directly
	if (existing instanceof Y.Map) {
		return existing;
	}

	// Flat entry exists — convert it
	const decoded = decodeFileMeta(existing);
	if (decoded) {
		const entry = createNestedMetaFromDecoded(decoded);
		metaMap.set(fileId, entry);
		return entry;
	}

	// No valid entry — use fallback if provided
	if (fallback) {
		const entry = createNestedMetaFromDecoded(fallback);
		metaMap.set(fileId, entry);
		return entry;
	}

	return null;
}

// -------------------------------------------------------------------
// Semantic diff computation for observers
// -------------------------------------------------------------------

/**
 * Compute semantic changes between two metadata snapshots.
 * Used by observeDeep handlers to determine what actually changed.
 */
export function computeMetaSemanticChanges(
	previous: Map<string, DecodedFileMeta>,
	current: Map<string, DecodedFileMeta>,
): MetaSemanticChange[] {
	const changes: MetaSemanticChange[] = [];

	// Check removed entries
	for (const [fileId, prev] of previous) {
		if (!current.has(fileId)) {
			changes.push({ kind: "removed", fileId, previous: prev });
		}
	}

	// Check added and modified entries
	for (const [fileId, curr] of current) {
		const prev = previous.get(fileId);

		if (!prev) {
			changes.push({ kind: "added", fileId, next: curr });
			continue;
		}

		const prevDeleted = prev.deleted === true || typeof prev.deletedAt === "number";
		const currDeleted = curr.deleted === true || typeof curr.deletedAt === "number";

		// Revive: was deleted, now active
		if (prevDeleted && !currDeleted) {
			changes.push({ kind: "revived", fileId, path: curr.path });
			continue;
		}

		// Delete: was active, now deleted
		if (!prevDeleted && currDeleted) {
			changes.push({ kind: "deleted", fileId, path: curr.path, deletedAt: curr.deletedAt ?? Date.now() });
			continue;
		}

		// Path change (can happen to tombstones too; consumers must check wasDeleted/isDeleted)
		if (prev.path !== curr.path) {
			changes.push({
				kind: "path-changed",
				fileId,
				previousPath: prev.path,
				nextPath: curr.path,
				wasDeleted: prevDeleted,
				isDeleted: currDeleted,
			});
			continue;
		}

		// Mtime change
		if (prev.mtime !== curr.mtime) {
			changes.push({ kind: "mtime-changed", fileId, path: curr.path });
			continue;
		}

		// Device change
		if (prev.device !== curr.device) {
			changes.push({ kind: "device-changed", fileId, path: curr.path });
		}
	}

	return changes;
}

/**
 * Build a decoded metadata snapshot from the current state of a meta map.
 * Used to initialize the observer's previous-state for semantic diffing.
 */
export function buildMetaSnapshot(metaMap: Y.Map<unknown>): Map<string, DecodedFileMeta> {
	const snapshot = new Map<string, DecodedFileMeta>();
	metaMap.forEach((value: unknown, fileId: string) => {
		const decoded = decodeFileMeta(value);
		if (decoded) {
			snapshot.set(fileId, decoded);
		}
	});
	return snapshot;
}

/**
 * Extract the set of fileIds affected by a batch of Yjs deep-observe events.
 *
 * Uses event `path` arrays (relative to the observed root) to avoid an O(N)
 * scan. For events on the top-level meta map, `path` is empty and affected
 * fileIds come from `event.changes.keys`. For nested events (field mutation
 * on a nested Y.Map), `path[0]` is the fileId.
 *
 * Returns `null` if the affected set cannot be determined from event paths
 * (e.g., an unexpected deep nesting), signalling that the caller should fall
 * back to a full snapshot diff.
 */
export function extractAffectedFileIds(
	events: Y.YEvent<Y.AbstractType<unknown>>[],
	metaMap: Y.Map<unknown>,
): Set<string> | null {
	const affected = new Set<string>();

	for (const event of events) {
		if (event.target === metaMap) {
			// Top-level event: the meta map itself changed (key added/removed/replaced).
			for (const [fileId] of event.changes.keys) {
				affected.add(fileId);
			}
		} else {
			// Nested event: a field inside a nested Y.Map changed.
			// event.path is relative to the observed root (the meta map),
			// so path[0] is the top-level fileId key.
			const path = event.path;
			if (path.length >= 1 && typeof path[0] === "string") {
				affected.add(path[0]);
			} else {
				// Cannot determine fileId — signal fallback.
				return null;
			}
		}
	}

	return affected;
}

/**
 * Compute incremental semantic changes for a specific set of affected fileIds.
 * Only decodes/diffs the changed entries, not the whole map.
 * Updates `snapshot` in-place with the new decoded values.
 */
export function computeIncrementalMetaChanges(
	snapshot: Map<string, DecodedFileMeta>,
	metaMap: Y.Map<unknown>,
	affectedFileIds: Set<string>,
): MetaSemanticChange[] {
	const changes: MetaSemanticChange[] = [];

	for (const fileId of affectedFileIds) {
		const prev = snapshot.get(fileId);
		const currentValue = metaMap.get(fileId);
		const curr = decodeFileMeta(currentValue);

		if (!curr) {
			if (prev) {
				// Entry removed or became invalid
				changes.push({ kind: "removed", fileId, previous: prev });
				snapshot.delete(fileId);
			} else {
				changes.push({ kind: "invalid", fileId });
			}
			continue;
		}

		// Update snapshot
		snapshot.set(fileId, curr);

		if (!prev) {
			changes.push({ kind: "added", fileId, next: curr });
			continue;
		}

		const prevDeleted = prev.deleted === true || typeof prev.deletedAt === "number";
		const currDeleted = curr.deleted === true || typeof curr.deletedAt === "number";

		if (prevDeleted && !currDeleted) {
			changes.push({ kind: "revived", fileId, path: curr.path });
			continue;
		}

		if (!prevDeleted && currDeleted) {
			changes.push({ kind: "deleted", fileId, path: curr.path, deletedAt: curr.deletedAt ?? Date.now() });
			continue;
		}

		if (prev.path !== curr.path) {
			changes.push({
				kind: "path-changed",
				fileId,
				previousPath: prev.path,
				nextPath: curr.path,
				wasDeleted: prevDeleted,
				isDeleted: currDeleted,
			});
			continue;
		}

		if (prev.mtime !== curr.mtime) {
			changes.push({ kind: "mtime-changed", fileId, path: curr.path });
			continue;
		}

		if (prev.device !== curr.device) {
			changes.push({ kind: "device-changed", fileId, path: curr.path });
		}
	}

	return changes;
}

// -------------------------------------------------------------------
// Observability / debug counters
// -------------------------------------------------------------------

/** Metadata shape statistics for debug surfaces. */
export interface MetaShapeStats {
	schemaVersion: number | null;
	flatMetaEntries: number;
	nestedMetaEntries: number;
	invalidMetaEntries: number;
	activeMetaEntries: number;
	tombstoneMetaEntries: number;
	totalMetaEntries: number;
}

/**
 * Compute metadata shape statistics for diagnostics.
 * Walks all meta entries once and classifies them by shape and state.
 */
export function computeMetaShapeStats(
	metaMap: Y.Map<unknown>,
	schemaVersion: number | null,
): MetaShapeStats {
	let flatMetaEntries = 0;
	let nestedMetaEntries = 0;
	let invalidMetaEntries = 0;
	let activeMetaEntries = 0;
	let tombstoneMetaEntries = 0;

	metaMap.forEach((value: unknown) => {
		const decoded = decodeFileMeta(value);
		if (!decoded) {
			invalidMetaEntries++;
			return;
		}

		if (decoded.shape === "nested") {
			nestedMetaEntries++;
		} else {
			flatMetaEntries++;
		}

		const isDel = decoded.deleted === true || typeof decoded.deletedAt === "number";
		if (isDel) {
			tombstoneMetaEntries++;
		} else {
			activeMetaEntries++;
		}
	});

	return {
		schemaVersion,
		flatMetaEntries,
		nestedMetaEntries,
		invalidMetaEntries,
		activeMetaEntries,
		tombstoneMetaEntries,
		totalMetaEntries: flatMetaEntries + nestedMetaEntries + invalidMetaEntries,
	};
}
