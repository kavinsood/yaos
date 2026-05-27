import * as Y from "yjs";
import { gzipSync } from "fflate";
import { mapWithConcurrency } from "./concurrency";

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
	reason?: string;
	index?: SnapshotIndex;
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

function snapshotPrefix(vaultId: string, day: string, snapshotId: string): string {
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

export async function createSnapshot(
	ydoc: Y.Doc,
	vaultId: string,
	bucket: R2Bucket,
	triggeredBy?: string,
): Promise<SnapshotIndex> {
	const day = today();
	const snapshotId = generateSnapshotId();
	const prefix = snapshotPrefix(vaultId, day, snapshotId);

	const rawUpdate = Y.encodeStateAsUpdate(ydoc);
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
		triggeredBy,
	};

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

	return index;
}

export async function listSnapshots(
	vaultId: string,
	bucket: R2Bucket,
): Promise<SnapshotIndex[]> {
	const keys = await listAllKeys(bucket, `v1/${vaultId}/snapshots/`);
	const indexKeys = keys.filter((key) => key.endsWith("/index.json"));

	const indexes = await mapWithConcurrency(
		indexKeys,
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

	return indexes
		.filter((index): index is SnapshotIndex => index !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
