/**
 * Decoded document summary: what the vault's CRDT actually contains, and
 * whether its three maps agree with each other.
 *
 * Extracted from VaultSyncServer so the counting rules can be tested against a
 * constructed document.  They could not be before, and the consequence was that
 * a real 92-file vault reported `activePathsWithText: 0` — a number nobody could
 * check and therefore nobody trusted or acted on.
 *
 * THE RULE THAT MATTERS
 *
 * Every cross-map counter has to resolve an active path to a fileId, and which
 * map answers that depends on the schema version:
 *
 *   legacy (v1)   `pathToId` is authoritative and is consulted first.
 *   id-first (v2+) `meta` is authoritative.  The metadata KEY *is* the fileId,
 *                  and the client stops writing `pathToId` altogether, so
 *                  whatever survives migration is frozen at that instant and
 *                  points into the pre-migration fileId space.
 *
 * Resolving through `pathToId` on a migrated vault therefore looks up live paths
 * in a dead map, misses every time, and reports total inconsistency for a vault
 * that is perfectly healthy.  `pathModel` is included in the output so the
 * numbers are interpretable rather than merely present.
 */

import * as Y from "yjs";
import { usesLegacyPathModel } from "./schemaModel";

export interface DocumentSummary {
	activePathCount: number;
	tombstonedPathCount: number;
	metaCount: number;
	pathToIdCount: number;
	idToTextCount: number;
	/** Active entries whose fileId has a body in `idToText`. */
	activePathsWithText: number;
	/** Active entries with no resolvable fileId.  Legacy model only. */
	activePathsMissingFromPathToId: number;
	/** Active entries that resolve to a fileId with no body. */
	activePathsMissingText: number;
	/**
	 * `pathToId` keys with no active metadata.  Under the id-first model this is
	 * expected residue from migration, not drift.
	 */
	pathToIdWithoutActiveMeta: number;
	schemaVersion: unknown;
	/** Which map the counters above resolved through. */
	pathModel: "legacy" | "id-first";
	/** Metadata stored as a flat JSON object (v2). */
	flatMetaEntries: number;
	/** Metadata stored as a nested Y.Map (v3). */
	nestedMetaEntries: number;
	/** Entries with no readable path.  Counted in neither active nor tombstoned. */
	invalidMetaEntries: number;
}

/**
 * Narrow a metadata value to something with a Y.Map-style `get`.
 *
 * Duck-typed rather than `value instanceof Y.Map`: Yjs warns that loading two
 * copies of the library breaks constructor checks, and under that condition an
 * instanceof test silently reports every nested (v3) entry as a plain object.
 * Here that would misclassify shapes and mis-read tombstones.  Plain JSON
 * metadata has no callable `get`, so structural detection cannot fail that way.
 */
export function asMapLike(value: unknown): { get: (key: string) => unknown } | null {
	if (value === null || typeof value !== "object") return null;
	const candidate = value as { get?: unknown };
	return typeof candidate.get === "function"
		? (value as { get: (key: string) => unknown })
		: null;
}

/** Read the path from a metadata value, in either shape. */
export function readMetaPath(value: unknown): string | null {
	const nested = asMapLike(value);
	if (nested) {
		const path = nested.get("path");
		return typeof path === "string" && path.length > 0 ? path : null;
	}
	if (typeof value === "object" && value !== null && "path" in value) {
		// `in` narrows the property to unknown, so this read is checked.
		const path = value.path;
		return typeof path === "string" && path.length > 0 ? path : null;
	}
	return null;
}

/** Read a finite deletion timestamp from metadata in either supported shape. */
export function readMetaDeletedAt(value: unknown): number | null {
	const nested = asMapLike(value);
	if (nested) {
		const deletedAt = nested.get("deletedAt");
		return typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : null;
	}
	if (typeof value === "object" && value !== null && "deletedAt" in value) {
		const deletedAt = value.deletedAt;
		return typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : null;
	}
	return null;
}

/** Whether a metadata value is a tombstone, in either shape. */
export function isMetaDeleted(value: unknown): boolean {
	if (readMetaDeletedAt(value) !== null) return true;
	const nested = asMapLike(value);
	if (nested) return nested.get("deleted") === true;
	return typeof value === "object"
		&& value !== null
		&& "deleted" in value
		&& value.deleted === true;
}

export function buildDocumentSummary(doc: Y.Doc): DocumentSummary {
	const meta = doc.getMap("meta");
	const pathToId = doc.getMap<string>("pathToId");
	const idToText = doc.getMap("idToText");

	const legacyPathModel = usesLegacyPathModel(doc);

	let activePathCount = 0;
	let tombstonedPathCount = 0;
	let activePathsWithText = 0;
	let activePathsMissingFromPathToId = 0;
	let activePathsMissingText = 0;
	let flatMetaEntries = 0;
	let nestedMetaEntries = 0;
	let invalidMetaEntries = 0;

	const activeMetaPaths = new Set<string>();
	meta.forEach((value: unknown, fileId: string) => {
		const path = readMetaPath(value);
		if (!path) {
			invalidMetaEntries++;
			return;
		}

		if (asMapLike(value)) nestedMetaEntries++;
		else flatMetaEntries++;

		if (isMetaDeleted(value)) {
			tombstonedPathCount++;
			return;
		}

		activePathCount++;
		activeMetaPaths.add(path);

		// Legacy: the path must appear in pathToId and that id must have a body.
		// id-first: the metadata key IS the fileId, so ask idToText directly and
		// never consult the frozen map.
		const id = legacyPathModel ? pathToId.get(path) : fileId;
		if (!id) activePathsMissingFromPathToId++;
		else if (!idToText.has(id)) activePathsMissingText++;
		else activePathsWithText++;
	});

	let pathToIdWithoutActiveMeta = 0;
	pathToId.forEach((_id: string, path: string) => {
		if (!activeMetaPaths.has(path)) pathToIdWithoutActiveMeta++;
	});

	return {
		activePathCount,
		tombstonedPathCount,
		metaCount: meta.size,
		pathToIdCount: pathToId.size,
		idToTextCount: idToText.size,
		activePathsWithText,
		activePathsMissingFromPathToId,
		activePathsMissingText,
		pathToIdWithoutActiveMeta,
		schemaVersion: doc.getMap("sys").get("schemaVersion") ?? null,
		pathModel: legacyPathModel ? "legacy" : "id-first",
		flatMetaEntries,
		nestedMetaEntries,
		invalidMetaEntries,
	};
}
