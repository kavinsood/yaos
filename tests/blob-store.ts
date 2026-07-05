import {
	BLOB_GRACE_MS,
	initBlobStoreSchema,
	putBlobRecord,
	getBlobRecord,
	existsBlobHashes,
	storageStatus,
	sweepOrphans,
	type SqlStorage,
} from "../server/src/blobStoreSql";
import { CHUNK_BYTES } from "../server/src/blobChunk";

// --- FakeSql (in-memory) ---
type BlobMeta = {
	hash: string;
	size: number;
	mime: string | null;
	chunk_count: number;
	created_at: number;
};

class FakeSql implements SqlStorage {
	private readonly tables = {
		blob_meta: new Map<string, BlobMeta>(),
		blob_chunk: new Map<string, Uint8Array>(),
	};

	private normalize(sql: string): string {
		return sql.replace(/\s+/g, " ").trim().toLowerCase();
	}

	exec(sql: string, ...bindings: unknown[]): unknown {
		const normalized = this.normalize(sql);

		if (normalized.startsWith("create table")) return [];
		if (normalized === "begin" || normalized === "commit" || normalized === "rollback") return [];

		if (normalized.includes("select 1 from blob_meta where hash =")) {
			const [hash] = bindings as [string];
			return this.tables.blob_meta.has(hash) ? [{ "1": 1 }] : [];
		}

		if (normalized.includes("insert into blob_meta")) {
			const [hash, size, mime, chunk_count, created_at] = bindings as [
				string,
				number,
				string | null,
				number,
				number,
			];
			this.tables.blob_meta.set(hash, { hash, size, mime, chunk_count, created_at });
			return [];
		}

		if (normalized.includes("insert into blob_chunk")) {
			const [hash, idx, bytes] = bindings as [string, number, Uint8Array];
			this.tables.blob_chunk.set(`${hash}:${idx}`, bytes);
			return [];
		}

		if (normalized.includes("select mime from blob_meta where hash =")) {
			const [hash] = bindings as [string];
			const meta = this.tables.blob_meta.get(hash);
			return meta ? [{ mime: meta.mime }] : [];
		}

		if (normalized.includes("select bytes from blob_chunk where hash =") && normalized.includes("order by idx")) {
			const [hash] = bindings as [string];
			const rows: { bytes: Uint8Array }[] = [];
			const prefix = `${hash}:`;
			const indices = [...this.tables.blob_chunk.keys()]
				.filter((key) => key.startsWith(prefix))
				.map((key) => Number(key.slice(prefix.length)))
				.sort((a, b) => a - b);
			for (const idx of indices) {
				const bytes = this.tables.blob_chunk.get(`${hash}:${idx}`);
				if (bytes) rows.push({ bytes });
			}
			return rows;
		}

		if (normalized.includes("select hash from blob_meta where hash in")) {
			const hashes = bindings as string[];
			return hashes
				.filter((hash) => this.tables.blob_meta.has(hash))
				.map((hash) => ({ hash }));
		}

		if (
			normalized.includes("select coalesce(sum(size), 0) as used_bytes, count(*) as blob_count from blob_meta")
		) {
			let usedBytes = 0;
			for (const meta of this.tables.blob_meta.values()) {
				usedBytes += meta.size;
			}
			return [{ used_bytes: usedBytes, blob_count: this.tables.blob_meta.size }];
		}

		if (normalized.includes("select hash, size from blob_meta where created_at <=")) {
			const [cutoff] = bindings as [number];
			const rest = bindings.slice(1) as string[];
			const live = new Set(rest);
			const notIn = normalized.includes("hash not in");
			return [...this.tables.blob_meta.values()]
				.filter((meta) => {
					if (meta.created_at > cutoff) return false;
					if (!notIn) return true;
					return !live.has(meta.hash);
				})
				.map((meta) => ({ hash: meta.hash, size: meta.size }));
		}

		if (normalized.includes("delete from blob_chunk where hash in")) {
			const hashes = bindings as string[];
			for (const hash of hashes) {
				for (const key of [...this.tables.blob_chunk.keys()]) {
					if (key.startsWith(`${hash}:`)) this.tables.blob_chunk.delete(key);
				}
			}
			return [];
		}

		if (normalized.includes("delete from blob_meta where hash in")) {
			const hashes = bindings as string[];
			for (const hash of hashes) {
				this.tables.blob_meta.delete(hash);
			}
			return [];
		}

		throw new Error(`FakeSql unhandled: ${sql}`);
	}
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

function freshSql(): FakeSql {
	const sql = new FakeSql();
	initBlobStoreSchema(sql);
	return sql;
}

console.log("\n--- Test 1: put + get round-trip (2 chunks) ---");
{
	const sql = freshSql() as unknown as SqlStorage;
	const hash = "a".repeat(64);
	const bytes = new Uint8Array(CHUNK_BYTES + 100);
	bytes[0] = 1;
	bytes[CHUNK_BYTES] = 2;

	putBlobRecord(sql, hash, "image/png", bytes, Date.now());
	const loaded = getBlobRecord(sql, hash);
	assert(loaded !== null, "getBlob returns record");
	assert(loaded!.bytes.byteLength === bytes.byteLength, "get round-trip size");
	assert(loaded!.bytes[0] === 1 && loaded!.bytes[CHUNK_BYTES] === 2, "get round-trip bytes");
	assert(loaded!.mime === "image/png", "get round-trip mime");
}

console.log("\n--- Test 2: existsBlobHashes returns only present ---");
{
	const sql = freshSql() as unknown as SqlStorage;
	const hash = "a".repeat(64);
	const bytes = new Uint8Array([1, 2, 3]);
	putBlobRecord(sql, hash, "image/png", bytes, Date.now());
	assert(existsBlobHashes(sql, [hash, "b".repeat(64)]).length === 1, "exists returns only present hash");
}

console.log("\n--- Test 3: storageStatus count/bytes ---");
{
	const sql = freshSql() as unknown as SqlStorage;
	const hash = "a".repeat(64);
	const bytes = new Uint8Array(CHUNK_BYTES + 100);
	putBlobRecord(sql, hash, "image/png", bytes, Date.now());
	const status = storageStatus(sql);
	assert(status.blobCount === 1, "storage status count");
	assert(status.usedBytes === bytes.byteLength, "storage status bytes");
}

console.log("\n--- Test 4: sweep with empty live set deletes orphan ---");
{
	const sql = freshSql() as unknown as SqlStorage;
	const hash = "a".repeat(64);
	const bytes = new Uint8Array([7]);
	putBlobRecord(sql, hash, "image/png", bytes, Date.now());
	const deleted = sweepOrphans(sql, [], 0, Date.now());
	assert(deleted.deleted === 1, "sweep with empty live set deletes orphan");
	assert(deleted.freedBytes === bytes.byteLength, "sweep reports freed bytes");
	assert(getBlobRecord(sql, hash) === null, "orphan removed after sweep");
}

console.log("\n--- Test 5: re-put same hash is idempotent ---");
{
	const sql = freshSql() as unknown as SqlStorage;
	const hash = "a".repeat(64);
	const bytes = new Uint8Array(CHUNK_BYTES + 100);
	putBlobRecord(sql, hash, "image/png", bytes, Date.now());
	putBlobRecord(sql, hash, "image/png", bytes, Date.now());
	const status2 = storageStatus(sql);
	assert(status2.blobCount === 1, "re-put same hash is idempotent");
}

console.log("\n--- Test 6: grace — young orphan survives, old orphan deleted ---");
{
	const sql = freshSql() as unknown as SqlStorage;
	const orphanHash = "c".repeat(64);
	const orphanBytes = new Uint8Array([9]);
	const now = Date.now();
	putBlobRecord(sql, orphanHash, "application/octet-stream", orphanBytes, now - 30 * 60 * 1000);
	const young = sweepOrphans(sql, [], BLOB_GRACE_MS, now);
	assert(young.deleted === 0, "young orphan within grace survives");
	const old = sweepOrphans(sql, [], BLOB_GRACE_MS, now + 2 * 60 * 60 * 1000);
	assert(old.deleted >= 1, "old orphan past grace is deleted");
}

console.log("\n--- Test 7: live hash kept after sweep ---");
{
	const sql = freshSql() as unknown as SqlStorage;
	const hash = "a".repeat(64);
	const bytes = new Uint8Array([1, 2, 3]);
	const now = Date.now();
	putBlobRecord(sql, hash, "image/png", bytes, now);
	const kept = sweepOrphans(sql, [hash], 0, now + 999_999);
	assert(existsBlobHashes(sql, [hash]).length === 1, "live hash kept after sweep");
	assert(kept.deleted === 0, "sweep with live hash deletes nothing");
}

console.log(`\nblob-store: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
