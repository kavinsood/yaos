import * as Y from "yjs";
import { gzipSync } from "fflate";
import { mapWithConcurrency } from "./concurrency";
import { sha256Hex, bytesToHex } from "./hex";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export type SnapshotReason = "daily" | "manual" | "pre-upgrade" | "pre-migration" | "pre-bulk-operation";

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
	/**
	 * SHA-256 hex of the full encoded CRDT update (Y.encodeStateAsUpdate).
	 * This is the only safe dedup gate because it includes both insertions
	 * and the delete set. State vectors alone miss deletions.
	 */
	fullUpdateHash?: string;
	/**
	 * SHA-256 hex of sorted active paths + blob hashes.
	 * Detects structural changes (file add/remove/rename, blob changes)
	 * but does NOT detect content edits to existing files.
	 * Named honestly: this is a structure hash, not a semantic hash.
	 */
	structureHash?: string;
	/** Whether this snapshot is pinned (exempt from automatic retention). */
	pinned?: boolean;
	/** Why this snapshot was created. Informs retention decisions. */
	reason?: SnapshotReason;

	// --- Legacy fields (still read, no longer written) ---
	/** @deprecated Use fullUpdateHash instead. State vector misses deletions. */
	stateVectorHash?: string;
	/** @deprecated Renamed to structureHash for honesty. */
	semanticHash?: string;
}

export interface SnapshotResult {
	status: "created" | "noop" | "unavailable";
	snapshotId?: string;
	reason?: string;
	index?: SnapshotIndex;
	/** True if manual snapshot is byte-for-byte identical to latest. */
	snapshotIdenticalToLatest?: boolean;
	/** @deprecated Legacy alias for snapshotIdenticalToLatest. Kept for old clients. */
	semanticUnchanged?: boolean;
}

export interface CreateSnapshotOptions {
	triggeredBy?: string;
	reason?: SnapshotReason;
	/** Explicitly set pinned status. Defaults: manual=true, daily=false. */
	pinned?: boolean;
	/**
	 * Precomputed raw CRDT update to avoid double-encoding.
	 * If provided, createSnapshot will not call Y.encodeStateAsUpdate again.
	 */
	precomputedRawUpdate?: Uint8Array;
	/**
	 * Precomputed SHA-256 hex of the raw update.
	 * Must correspond to precomputedRawUpdate if both are provided.
	 */
	precomputedFullUpdateHash?: string;
}

// -------------------------------------------------------------------
// Retention policy
// -------------------------------------------------------------------

export interface RetentionPolicy {
	keepDays: number;
	keepWeekly: number;
	keepMonthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
	keepDays: 7,
	keepWeekly: 4,
	keepMonthly: 12,
};

export interface RetentionOptions {
	/**
	 * If true, legacy snapshots (without a `reason` field) are eligible for
	 * pruning. Default: false (legacy snapshots are conservatively kept).
	 *
	 * Only set this to true when the user explicitly requests pruning of
	 * legacy snapshots (e.g., via a dedicated "prune legacy" command with
	 * clear warnings).
	 */
	pruneLegacy?: boolean;
}

const SNAPSHOT_FETCH_CONCURRENCY = 4;

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function blobKey(vaultId: string, hash: string): string {
	return `v1/${vaultId}/blobs/${hash}`;
}

function generateSnapshotId(): string {
	const ts = Date.now().toString(36);
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const rand = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${ts}-${rand}`;
}

export function snapshotPrefix(vaultId: string, day: string, snapshotId: string): string {
	return `v1/${vaultId}/snapshots/${day}/${snapshotId}`;
}

function normalizeBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (data instanceof Uint8Array) {
		return data;
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	while (true) {
		const page = await bucket.list({
			prefix,
			limit: 1000,
			cursor,
		});

		for (const object of page.objects) {
			keys.push(object.key);
		}

		if (!page.truncated) break;
		cursor = page.cursor;
	}

	return keys;
}

export async function hasSnapshotForDay(
	vaultId: string,
	day: string,
	bucket: R2Bucket,
): Promise<boolean> {
	const page = await bucket.list({
		prefix: `v1/${vaultId}/snapshots/${day}/`,
		limit: 1,
	});
	return page.objects.length > 0;
}

// -------------------------------------------------------------------
// Hash computation
// -------------------------------------------------------------------

/**
 * Compute the full update hash: SHA-256 of Y.encodeStateAsUpdate(ydoc).
 * This is the ONLY safe dedup gate. It includes both insertions AND
 * the delete set, so it correctly detects delete-only changes.
 *
 * Cost: O(document size). Acceptable for daily snapshot frequency.
 */
export async function computeFullUpdateHash(ydoc: Y.Doc): Promise<string> {
	const update = Y.encodeStateAsUpdate(ydoc);
	return sha256Hex(update);
}

/**
 * Compute the structure hash: SHA-256 of sorted active paths and their
 * associated structural identifiers (file IDs for markdown, blob hashes for blobs).
 *
 * This detects structural changes (file add/remove/rename, blob ref changes)
 * but does NOT detect content edits to existing files (fileId is stable across edits).
 *
 * Named "structure" (not "semantic") to avoid implying it captures content changes.
 *
 * WARNING: Do not use this for content dedup or snapshot skip decisions.
 * It uses pathToId only (does not consider v2 meta path model) and misses
 * all Markdown content changes. It exists for diagnostics and future CAS
 * manifest dedup where structure-only comparison is explicitly desired.
 */
export async function computeStructureHash(ydoc: Y.Doc): Promise<string> {
	const pathToId = ydoc.getMap<string>("pathToId");
	const pathToBlob = ydoc.getMap<unknown>("pathToBlob");

	const entries: string[] = [];

	pathToId.forEach((fileId, path) => {
		entries.push(`md:${path}:${fileId}`);
	});

	pathToBlob.forEach((ref: unknown, path) => {
		if (!ref || typeof ref !== "object" || !("hash" in ref)) return;
		const hash = (ref as { hash?: unknown }).hash;
		if (typeof hash === "string") {
			entries.push(`blob:${path}:${hash}`);
		}
	});

	entries.sort();
	const payload = new TextEncoder().encode(entries.join("\n"));
	return sha256Hex(payload);
}

/**
 * @deprecated Use computeFullUpdateHash instead.
 * State vector misses deletions. Kept for backward compat reads only.
 */
export async function computeStateVectorHash(ydoc: Y.Doc): Promise<string> {
	const sv = Y.encodeStateVector(ydoc);
	return sha256Hex(sv);
}

// Legacy alias
export const computeSemanticHash = computeStructureHash;

// -------------------------------------------------------------------
// Latest snapshot index (avoids full listing for dedup check)
// -------------------------------------------------------------------

const LATEST_INDEX_KEY_SUFFIX = "latest-index.json";

function latestIndexKey(vaultId: string): string {
	return `v1/${vaultId}/snapshots/${LATEST_INDEX_KEY_SUFFIX}`;
}

/**
 * Retrieve the latest snapshot index without scanning all snapshot keys.
 * Falls back to null if no latest pointer exists yet.
 */
export async function getLatestSnapshotIndex(
	vaultId: string,
	bucket: R2Bucket,
): Promise<SnapshotIndex | null> {
	try {
		const object = await bucket.get(latestIndexKey(vaultId));
		if (!object) return null;
		const text = await object.text();
		return JSON.parse(text) as SnapshotIndex;
	} catch {
		return null;
	}
}

/**
 * Verify that the snapshot referenced by a latest-index pointer actually
 * exists in storage and is consistent with the pointer metadata.
 *
 * Checks:
 *   1. Both payload (crdt.bin.gz) and index (index.json) objects exist.
 *   2. The stored index.json matches the pointer's snapshotId and fullUpdateHash.
 *   3. The payload size matches index.crdtSizeBytes (if R2 reports size).
 *
 * This prevents "poisoned pointer" scenarios where latest-index.json
 * references a snapshot that is missing, corrupt, or inconsistent.
 */
export async function verifySnapshotExists(
	vaultId: string,
	index: SnapshotIndex,
	bucket: R2Bucket,
): Promise<boolean> {
	const prefix = snapshotPrefix(vaultId, index.day, index.snapshotId);
	const [payloadHead, indexObj] = await Promise.all([
		bucket.head(`${prefix}/crdt.bin.gz`),
		bucket.get(`${prefix}/index.json`),
	]);

	// Payload must exist
	if (!payloadHead) return false;

	// Index must exist and be parseable
	if (!indexObj) return false;
	let storedIndex: SnapshotIndex;
	try {
		const text = await indexObj.text();
		storedIndex = JSON.parse(text) as SnapshotIndex;
	} catch {
		return false; // Malformed JSON
	}

	// Verify consistency between pointer and stored index
	if (storedIndex.snapshotId !== index.snapshotId) return false;
	if (storedIndex.fullUpdateHash && index.fullUpdateHash &&
		storedIndex.fullUpdateHash !== index.fullUpdateHash) return false;

	// Verify payload size matches if available
	if (payloadHead.size !== undefined && storedIndex.crdtSizeBytes > 0 &&
		payloadHead.size !== storedIndex.crdtSizeBytes) return false;

	return true;
}

/**
 * Persist the latest snapshot index pointer for fast retrieval.
 * MUST be called only after payload and index are durably written.
 */
async function writeLatestIndex(
	vaultId: string,
	index: SnapshotIndex,
	bucket: R2Bucket,
): Promise<void> {
	await bucket.put(latestIndexKey(vaultId), JSON.stringify(index), {
		httpMetadata: { contentType: "application/json" },
	});
}

// -------------------------------------------------------------------
// Snapshot creation
// -------------------------------------------------------------------

export async function createSnapshot(
	ydoc: Y.Doc,
	vaultId: string,
	bucket: R2Bucket,
	options?: CreateSnapshotOptions | string,
): Promise<SnapshotIndex> {
	// Backwards compat: old callers pass triggeredBy as string
	const opts: CreateSnapshotOptions = typeof options === "string"
		? { triggeredBy: options }
		: options ?? {};

	const reason = opts.reason ?? "daily";
	const pinned = opts.pinned ?? (reason === "manual" || reason === "pre-upgrade" || reason === "pre-migration");

	const day = today();
	const snapshotId = generateSnapshotId();
	const prefix = snapshotPrefix(vaultId, day, snapshotId);

	// Use precomputed raw update if available (avoids double O(doc) encode)
	const rawUpdate = opts.precomputedRawUpdate ?? Y.encodeStateAsUpdate(ydoc);
	const compressed = gzipSync(rawUpdate);

	const pathToId = ydoc.getMap<string>("pathToId");
	const pathToBlob = ydoc.getMap<unknown>("pathToBlob");
	const sys = ydoc.getMap<unknown>("sys");

	const referencedBlobHashes: string[] = [];
	pathToBlob.forEach((ref: unknown) => {
		if (!ref || typeof ref !== "object" || !("hash" in ref)) return;
		const hash = (ref as { hash?: unknown }).hash;
		if (typeof hash === "string") {
			referencedBlobHashes.push(hash);
		}
	});

	const [fullUpdateHash, structureHash] = await Promise.all([
		opts.precomputedFullUpdateHash
			? Promise.resolve(opts.precomputedFullUpdateHash)
			: sha256Hex(rawUpdate),
		computeStructureHash(ydoc),
	]);

	const index: SnapshotIndex = {
		snapshotId,
		vaultId,
		createdAt: new Date().toISOString(),
		day,
		schemaVersion: sys.get("schemaVersion") as number | undefined,
		markdownFileCount: pathToId.size,
		blobFileCount: pathToBlob.size,
		crdtSizeBytes: compressed.byteLength,
		crdtRawSizeBytes: rawUpdate.byteLength,
		referencedBlobHashes,
		triggeredBy: opts.triggeredBy,
		fullUpdateHash,
		structureHash,
		pinned,
		reason,
	};

	// Write payload and index first. Pointer MUST come after.
	// If pointer writes before payload is durable, we get a corrupt
	// latest pointer pointing to a non-existent snapshot.
	await Promise.all([
		bucket.put(`${prefix}/crdt.bin.gz`, compressed, {
			httpMetadata: {
				contentType: "application/gzip",
			},
		}),
		bucket.put(`${prefix}/index.json`, JSON.stringify(index), {
			httpMetadata: {
				contentType: "application/json",
			},
		}),
	]);

	// Only write latest pointer after payload + index are durable.
	await writeLatestIndex(vaultId, index, bucket);

	return index;
}

// -------------------------------------------------------------------
// Listing
// -------------------------------------------------------------------

export interface ListSnapshotsResult {
	snapshots: SnapshotIndex[];
	/** Number of index keys found (may exceed fetched count). */
	totalIndexKeys: number;
	/** True if listing was capped before fetching all indexes. */
	limited: boolean;
}

export async function listSnapshots(
	vaultId: string,
	bucket: R2Bucket,
	limit?: number,
): Promise<ListSnapshotsResult> {
	// NOTE: This still does a full key scan. The key listing is unbounded.
	// A proper v1 catalog would avoid this. For Phase 0, we are honest about
	// this limitation: we cap *index fetches* but the key scan is O(snapshots).
	const keys = await listAllKeys(bucket, `v1/${vaultId}/snapshots/`);
	const indexKeys = keys
		.filter((key) => key.endsWith("/index.json") && !key.endsWith(LATEST_INDEX_KEY_SUFFIX))
		.sort()
		.reverse(); // newest day prefixes first (lexicographic desc of YYYY-MM-DD)

	const totalIndexKeys = indexKeys.length;
	const bounded = limit ? indexKeys.slice(0, limit) : indexKeys;
	const limited = limit ? indexKeys.length > limit : false;

	const indexes = await mapWithConcurrency(
		bounded,
		SNAPSHOT_FETCH_CONCURRENCY,
		async (key) => {
			try {
				const object = await bucket.get(key);
				if (!object) return null;
				const text = await object.text();
				return JSON.parse(text) as SnapshotIndex;
			} catch {
				return null;
			}
		},
	);

	const snapshots = indexes
		.filter((index): index is SnapshotIndex => index !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

	return { snapshots, totalIndexKeys, limited };
}

/**
 * Derive the UTC calendar day (`YYYY-MM-DD`) encoded in a snapshot ID.
 *
 * Snapshot IDs are generated as `${Date.now().toString(36)}-${8hexRandom}`.
 * `Number.prototype.toString(36)` produces only lowercase `0-9` and `a-z`,
 * and the random suffix is always 4 bytes rendered as 8 lowercase hex chars.
 *
 * Strict validation rules (all must pass, no bucket I/O is ever attempted
 * for invalid input):
 *   - Shape: `^([0-9a-z]+)-([0-9a-f]{8,})$`
 *   - Timestamp segment parses to a safe positive integer
 *   - Resulting `Date` has a finite time value (guards against overflow edge
 *     cases beyond Number.MAX_SAFE_INTEGER where `new Date()` would be Invalid)
 *
 * Returns `null` for any input that fails these rules.
 */
export function dayFromSnapshotId(snapshotId: string): string | null {
	// Validate the full shape before any numeric parsing.  This rejects
	// uppercase prefixes, symbol characters, empty segments, and short or
	// missing random suffixes in a single step.
	const match = /^([0-9a-z]+)-([0-9a-f]{8,})$/.exec(snapshotId);
	if (!match) return null;

	const tsMs = Number.parseInt(match[1], 36);
	// Number.isSafeInteger guards against overflow values that parseInt
	// would accept but that lose precision as IEEE-754 doubles.
	if (!Number.isSafeInteger(tsMs) || tsMs <= 0) return null;

	const d = new Date(tsMs);
	// Extra guard: new Date() returns "Invalid Date" for values outside the
	// ECMAScript time range (±8.64e15 ms).  isSafeInteger already covers
	// most such cases, but this defends against future edge cases.
	if (!Number.isFinite(d.getTime())) return null;

	return d.toISOString().slice(0, 10);
}

/**
 * Fetch a single snapshot by ID using O(1) R2 operations.
 *
 * The snapshot day is derived directly from the timestamp embedded in the
 * snapshot ID, so no bucket listing is required.  Both the index and the
 * CRDT payload are fetched in parallel with two `bucket.get()` calls.
 *
 * Schema contract (locked):
 *   `createSnapshot` always writes exactly two objects per snapshot:
 *     `v1/{vaultId}/snapshots/{day}/{snapshotId}/index.json`  — SnapshotIndex
 *     `v1/{vaultId}/snapshots/{day}/{snapshotId}/crdt.bin.gz` — gzip CRDT update
 *   The payload key `crdt.bin.gz` is unconditional; it is not stored in the
 *   index and is not configurable.  Any change to the payload key format
 *   must be accompanied by a migration and a bumped schema version.
 *
 * Returns `null` when the snapshot ID is malformed, or when either the
 * `index.json` or `crdt.bin.gz` object is absent from the bucket.
 */
export async function getSnapshotPayload(
	vaultId: string,
	snapshotId: string,
	bucket: R2Bucket,
): Promise<{ index: SnapshotIndex; payload: Uint8Array } | null> {
	const day = dayFromSnapshotId(snapshotId);
	if (!day) return null;

	const prefix = snapshotPrefix(vaultId, day, snapshotId);

	const [indexObject, payloadObject] = await Promise.all([
		bucket.get(`${prefix}/index.json`),
		bucket.get(`${prefix}/crdt.bin.gz`),
	]);

	if (!indexObject || !payloadObject) return null;

	const index = JSON.parse(await indexObject.text()) as SnapshotIndex;
	const body = await payloadObject.arrayBuffer();
	return {
		index,
		payload: normalizeBytes(body),
	};
}

// -------------------------------------------------------------------
// Retention
// -------------------------------------------------------------------

/**
 * Given a list of snapshot indexes (sorted newest-first), determine which
 * to keep and which to prune based on the retention policy.
 *
 * Rules:
 *   - Always keep the latest snapshot.
 *   - Always keep pinned snapshots.
 *   - Unless pruneLegacy=true, keep all snapshots without a `reason` field
 *     (they may be old manual snapshots from before reason tracking).
 *   - Keep all snapshots from the last `keepDays` days.
 *   - Keep the newest snapshot per rough week for `keepWeekly` weeks.
 *   - Keep the newest snapshot per month for `keepMonthly` months.
 *   - Everything else is a prune candidate.
 */
export function selectRetention(
	snapshots: SnapshotIndex[],
	policy: RetentionPolicy = DEFAULT_RETENTION,
	now: Date = new Date(),
	options: RetentionOptions = {},
): { keep: SnapshotIndex[]; prune: SnapshotIndex[] } {
	if (snapshots.length === 0) return { keep: [], prune: [] };

	const { pruneLegacy = false } = options;
	const keepSet = new Set<string>();

	// Always keep latest
	keepSet.add(snapshots[0].snapshotId);

	// Always keep pinned
	for (const s of snapshots) {
		if (s.pinned) keepSet.add(s.snapshotId);
	}

	// Protect legacy snapshots unless explicitly asked to prune them.
	if (!pruneLegacy) {
		for (const s of snapshots) {
			if (!s.reason) {
				keepSet.add(s.snapshotId);
			}
		}
	}

	// Keep all non-daily reasons (manual, pre-upgrade, etc.) regardless
	for (const s of snapshots) {
		if (s.reason && s.reason !== "daily") {
			keepSet.add(s.snapshotId);
		}
	}

	const nowMs = now.getTime();
	const dayMs = 24 * 60 * 60 * 1000;

	// Keep all within keepDays
	const daysCutoff = nowMs - policy.keepDays * dayMs;
	for (const s of snapshots) {
		if (new Date(s.createdAt).getTime() >= daysCutoff) {
			keepSet.add(s.snapshotId);
		}
	}

	// Keep newest per rough week for keepWeekly weeks (beyond keepDays)
	const weeklyCutoff = nowMs - (policy.keepDays + policy.keepWeekly * 7) * dayMs;
	const seenWeeks = new Set<string>();
	for (const s of snapshots) {
		const ts = new Date(s.createdAt).getTime();
		if (ts >= daysCutoff) continue; // already kept by daily rule
		if (ts < weeklyCutoff) continue;
		const week = roughWeekKey(new Date(s.createdAt));
		if (!seenWeeks.has(week)) {
			seenWeeks.add(week);
			keepSet.add(s.snapshotId);
		}
	}

	// Keep newest per month for keepMonthly months (beyond weekly window)
	const monthlyCutoff = nowMs - (policy.keepDays + policy.keepWeekly * 7 + policy.keepMonthly * 30) * dayMs;
	const seenMonths = new Set<string>();
	for (const s of snapshots) {
		const ts = new Date(s.createdAt).getTime();
		if (ts >= weeklyCutoff) continue; // already handled
		if (ts < monthlyCutoff) continue;
		const month = s.createdAt.slice(0, 7); // "YYYY-MM"
		if (!seenMonths.has(month)) {
			seenMonths.add(month);
			keepSet.add(s.snapshotId);
		}
	}

	const keep: SnapshotIndex[] = [];
	const prune: SnapshotIndex[] = [];
	for (const s of snapshots) {
		if (keepSet.has(s.snapshotId)) {
			keep.push(s);
		} else {
			prune.push(s);
		}
	}
	return { keep, prune };
}

/**
 * Delete pruned snapshot objects from R2.
 * Returns the number of snapshots successfully deleted and per-failure details.
 */
export async function pruneSnapshots(
	vaultId: string,
	toPrune: SnapshotIndex[],
	bucket: R2Bucket,
): Promise<{ deleted: number; failed: number; errors: string[] }> {
	let deleted = 0;
	let failed = 0;
	const errors: string[] = [];

	for (const s of toPrune) {
		const prefix = snapshotPrefix(vaultId, s.day, s.snapshotId);
		try {
			await bucket.delete([`${prefix}/crdt.bin.gz`, `${prefix}/index.json`]);
			deleted++;
		} catch (err) {
			failed++;
			errors.push(`${s.snapshotId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return { deleted, failed, errors };
}

/**
 * Run retention: list snapshots, select retention, prune excess.
 * Returns full diagnostic information about what happened.
 */
export async function applyRetention(
	vaultId: string,
	bucket: R2Bucket,
	policy: RetentionPolicy = DEFAULT_RETENTION,
	options: RetentionOptions = {},
): Promise<{ kept: number; pruned: number; failed: number; errors: string[] }> {
	const { snapshots: all } = await listSnapshots(vaultId, bucket);
	const { keep, prune } = selectRetention(all, policy, new Date(), options);
	if (prune.length === 0) return { kept: keep.length, pruned: 0, failed: 0, errors: [] };
	const result = await pruneSnapshots(vaultId, prune, bucket);
	return { kept: keep.length, pruned: result.deleted, failed: result.failed, errors: result.errors };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Approximate week key for retention bucketing.
 *
 * NOTE: This is NOT a proper ISO 8601 week calculation. It uses a rough
 * day-of-year / 7 computation. The approximation is acceptable for retention
 * bucketing where exact week boundaries are not critical. Named "rough" to
 * be honest about the approximation.
 *
 * Known edge cases:
 *   - Dec 31 / Jan 1 boundary: may assign adjacent days to different years.
 *   - Does not follow ISO 8601 "week starts on Monday" convention.
 *
 * For retention purposes, ±1 day error in bucket boundaries is acceptable.
 */
export function roughWeekKey(date: Date): string {
	const year = date.getUTCFullYear();
	const jan1 = new Date(Date.UTC(year, 0, 1));
	const dayOfYear = Math.ceil((date.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
	const weekNum = Math.ceil((dayOfYear + jan1.getUTCDay()) / 7);
	return `${year}-W${String(weekNum).padStart(2, "0")}`;
}
