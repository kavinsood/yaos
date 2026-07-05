import { concatChunks, splitBytes } from "./blobChunk";

export interface SqlStorage {
	exec(sql: string, ...bindings: unknown[]): unknown;
}

export const BLOB_GRACE_MS = 60 * 60 * 1000; // 1 hour

type SqlRow = Record<string, unknown>;

function sqlRows(result: unknown): SqlRow[] {
	if (result == null) return [];
	if (Array.isArray(result)) return result;
	if (typeof result === "object" && Symbol.iterator in result) {
		return [...(result as Iterable<SqlRow>)];
	}
	return [];
}

export function initBlobStoreSchema(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS blob_meta (
		hash TEXT PRIMARY KEY,
		size INTEGER NOT NULL,
		mime TEXT,
		chunk_count INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS blob_chunk (
		hash TEXT NOT NULL,
		idx INTEGER NOT NULL,
		bytes BLOB NOT NULL,
		PRIMARY KEY (hash, idx)
	)`);
}

export function putBlobRecord(
	sql: SqlStorage,
	hash: string,
	mime: string,
	bytes: Uint8Array,
	createdAt: number,
): { ok: true } | { error: "full" } {
	try {
		const existing = sqlRows(sql.exec(`SELECT 1 FROM blob_meta WHERE hash = ?`, hash));
		if (existing.length > 0) return { ok: true };

		const chunks = splitBytes(bytes);
		sql.exec(`BEGIN`);
		sql.exec(
			`INSERT INTO blob_meta (hash, size, mime, chunk_count, created_at) VALUES (?, ?, ?, ?, ?)`,
			hash,
			bytes.byteLength,
			mime,
			chunks.length,
			createdAt,
		);
		for (let idx = 0; idx < chunks.length; idx++) {
			sql.exec(`INSERT INTO blob_chunk (hash, idx, bytes) VALUES (?, ?, ?)`, hash, idx, chunks[idx]);
		}
		sql.exec(`COMMIT`);
		return { ok: true };
	} catch (err) {
		try {
			sql.exec(`ROLLBACK`);
		} catch {
			// ignore rollback failures in best-effort cleanup
		}
		if (String(err).includes("SQLITE_FULL")) return { error: "full" };
		throw err;
	}
}

export function getBlobRecord(
	sql: SqlStorage,
	hash: string,
): { mime: string; bytes: Uint8Array } | null {
	const metaRows = sqlRows(sql.exec(`SELECT mime FROM blob_meta WHERE hash = ?`, hash));
	if (metaRows.length === 0) return null;

	const chunkRows = sqlRows(
		sql.exec(`SELECT bytes FROM blob_chunk WHERE hash = ? ORDER BY idx ASC`, hash),
	);
	const chunks = chunkRows.map((row) => row.bytes as Uint8Array);
	const mime = metaRows[0]!.mime;
	return {
		mime: mime == null ? "" : String(mime),
		bytes: concatChunks(chunks),
	};
}

export function existsBlobHashes(sql: SqlStorage, hashes: string[]): string[] {
	if (hashes.length === 0) return [];
	const placeholders = hashes.map(() => "?").join(", ");
	const rows = sqlRows(
		sql.exec(`SELECT hash FROM blob_meta WHERE hash IN (${placeholders})`, ...hashes),
	);
	return rows.map((row) => String(row.hash));
}

export function storageStatus(sql: SqlStorage): { usedBytes: number; blobCount: number } {
	const rows = sqlRows(
		sql.exec(`SELECT COALESCE(SUM(size), 0) AS used_bytes, COUNT(*) AS blob_count FROM blob_meta`),
	);
	const row = rows[0] ?? { used_bytes: 0, blob_count: 0 };
	return {
		usedBytes: Number(row.used_bytes ?? 0),
		blobCount: Number(row.blob_count ?? 0),
	};
}

export function sweepOrphans(
	sql: SqlStorage,
	liveHashes: string[],
	graceMs: number,
	nowMs: number,
): { deleted: number; freedBytes: number } {
	const cutoff = nowMs - graceMs;
	let orphanRows: SqlRow[];

	if (liveHashes.length === 0) {
		orphanRows = sqlRows(
			sql.exec(`SELECT hash, size FROM blob_meta WHERE created_at <= ?`, cutoff),
		);
	} else {
		const placeholders = liveHashes.map(() => "?").join(", ");
		orphanRows = sqlRows(
			sql.exec(
				`SELECT hash, size FROM blob_meta WHERE created_at <= ? AND hash NOT IN (${placeholders})`,
				cutoff,
				...liveHashes,
			),
		);
	}

	if (orphanRows.length === 0) return { deleted: 0, freedBytes: 0 };

	const hashes = orphanRows.map((row) => String(row.hash));
	const freedBytes = orphanRows.reduce((sum, row) => sum + Number(row.size ?? 0), 0);
	const placeholders = hashes.map(() => "?").join(", ");

	sql.exec(`DELETE FROM blob_chunk WHERE hash IN (${placeholders})`, ...hashes);
	sql.exec(`DELETE FROM blob_meta WHERE hash IN (${placeholders})`, ...hashes);

	return { deleted: hashes.length, freedBytes };
}
