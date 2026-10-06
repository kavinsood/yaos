// Opaque streams: durable storage (docs/client-remake/relay-wire.md §Storage).
//
// Three WITHOUT ROWID tables, no CRDT code:
//
//   stream_head        one row per stream: last seq, checkpoint/GC marks and the
//                      open (unsealed) segment of the newest rows, inline.
//                      Index stream_head_last_seq makes the feed an index range
//                      scan and the vault head one index probe.
//   stream_segment     sealed segments: concatenated rows, ~64 KiB each.
//   stream_checkpoint  the stream's current client checkpoint, in row-safe chunks.
//
// Billed rows (Cloudflare model, tests/server/helpers/cfRowModel.ts): a commit
// writes 2 rows per touched stream (head UPDATE/INSERT + its last_seq index
// entry), plus 1 per sealed segment. There is no clock row, receipt row or
// per-frame row. The H2 dedupe index (./dedupe.ts) is memory only.
import type { SqlValue, StoragePort } from "../ports";
import {
	DedupeIndexes,
	STREAM_DEDUPE_MAX_ENTRIES,
	STREAM_DEDUPE_SCAN_SEGMENTS,
	STREAM_DEDUPE_WINDOW_BYTES,
	StreamDedupeIndex,
	frameKeyHash,
} from "./dedupe";
import { bytesEqual, decodeRows, encodeRow, type StreamRow } from "./protocol";

/** The open segment is sealed (moved to stream_segment) once it reaches this size. */
export const STREAM_SEGMENT_SEAL_BYTES = 64 * 1024;
/** Hard cap of one stored segment/head blob (under SQLITE_ROW_SAFE_BYTES = 1.75 MB). */
export const STREAM_SEGMENT_MAX_BYTES = 1_500_000;
/** Checkpoint chunk size (one stream_checkpoint row each). */
export const STREAM_CHECKPOINT_CHUNK_BYTES = 1_000_000;

/**
 * The three stream tables. The vault DO runs this at vault init only (DECISIONS §6.1) and constructs the store with
 * `schemaReady: true`; a store without that flag (WB tests) runs it lazily on first use.
 */
export const STREAM_SCHEMA = `
	CREATE TABLE IF NOT EXISTS stream_head (
		stream TEXT NOT NULL PRIMARY KEY,
		last_seq INTEGER NOT NULL,
		ckpt_seq INTEGER NOT NULL DEFAULT 0,
		gc_seq INTEGER NOT NULL DEFAULT 0,
		tail_first INTEGER,
		open_rows INTEGER NOT NULL DEFAULT 0,
		open BLOB
	) WITHOUT ROWID;
	CREATE INDEX IF NOT EXISTS stream_head_last_seq ON stream_head(last_seq);
	CREATE TABLE IF NOT EXISTS stream_segment (
		stream TEXT NOT NULL,
		first_seq INTEGER NOT NULL,
		last_seq INTEGER NOT NULL,
		rows INTEGER NOT NULL,
		bytes BLOB NOT NULL,
		PRIMARY KEY (stream, first_seq)
	) WITHOUT ROWID;
	CREATE TABLE IF NOT EXISTS stream_checkpoint (
		stream TEXT NOT NULL,
		chunk INTEGER NOT NULL,
		covers_seq INTEGER NOT NULL,
		bytes BLOB NOT NULL,
		PRIMARY KEY (stream, chunk)
	) WITHOUT ROWID;
`;

export interface StreamAppendInput {
	stream: string;
	deviceId: string;
	clientFrameId: string;
	payload: Uint8Array;
}

export type StreamAppendOutcome =
	/** New row at `seq`. */
	| { kind: "appended"; seq: number }
	/**
	 * Same (deviceId, clientFrameId, payload) earlier in this batch, or stored among the newest
	 * STREAM_DEDUPE_WINDOW_BYTES of the stream, at `seq` (H2). A windowed original already garbage collected
	 * (seq ≤ gcSeq) cannot be compared and counts as deduped: the checkpoint covers it.
	 */
	| { kind: "deduped"; seq: number }
	/** Same (deviceId, clientFrameId) stored at `seq` with different bytes: rejected. */
	| { kind: "conflict"; seq: number };

export interface StreamCommitResult {
	outcomes: StreamAppendOutcome[];
	/** Vault head after the commit. */
	head: number;
}

export interface StreamFeedPage {
	head: number;
	changes: Array<{ stream: string; lastSeq: number }>;
	nextAfter: number | null;
}

export interface StreamReadPage {
	stream: string;
	lastSeq: number;
	checkpointSeq: number;
	gcSeq: number;
	checkpoint: { coversSeq: number; bytes: Uint8Array } | null;
	rows: StreamRow[];
	nextAfter: number | null;
}

export type StreamCheckpointResult =
	| { ok: true; coversSeq: number; gcSeq: number; deletedSegments: number }
	| { ok: false; status: 404; error: "stream_not_found" }
	| { ok: false; status: 409; error: "checkpoint_conflict"; current: { coversSeq: number } }
	| { ok: false; status: 409; error: "checkpoint_ahead_of_stream"; lastSeq: number; current: { coversSeq: number } }
	| { ok: false; status: 400; error: "checkpoint_not_advancing"; current: { coversSeq: number } };

interface HeadRow extends Record<string, SqlValue> {
	last_seq: number;
	ckpt_seq: number;
	gc_seq: number;
	tail_first: number | null;
	open_rows: number;
	open: ArrayBuffer | null;
}

/** A sealed segment loaded by one commit to compare a dedupe hit. */
interface LoadedSegment { first: number; last: number; rows: StreamRow[] }

/** Per-stream working state of one commit. */
class StreamCommitState {
	readonly appends: StreamRow[] = [];
	/** H2 key hash of each appended row. */
	readonly appendHashes: number[] = [];
	/** Encoded (stored) size of each appended row, set by writeStream. */
	readonly appendBytes: number[] = [];
	openRows: StreamRow[] | null = null;
	readonly segments: LoadedSegment[] = [];

	constructor(readonly stream: string, readonly head: HeadRow | null) {}
}

export function frameKey(deviceId: string, clientFrameId: string): string {
	return `${deviceId}\u0000${clientFrameId}`;
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
	if (parts.length === 1) return parts[0]!;
	const out = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
	return out;
}

export interface StreamStoreOptions {
	/** The owner has run STREAM_SCHEMA (vault init): the store never runs DDL on a request path. */
	schemaReady?: boolean;
	/** H2 DO-wide dedupe index cap in entries (default STREAM_DEDUPE_MAX_ENTRIES). */
	dedupeMaxEntries?: number;
}

export class StreamStore {
	private readonly schemaManaged: boolean;
	private schemaReady: boolean;
	private headCache: number | null = null;
	private readonly dedupe: DedupeIndexes;

	constructor(private readonly storage: StoragePort, options: StreamStoreOptions = {}) {
		this.schemaManaged = options.schemaReady === true;
		this.schemaReady = this.schemaManaged;
		this.dedupe = new DedupeIndexes(options.dedupeMaxEntries ?? STREAM_DEDUPE_MAX_ENTRIES);
	}

	/** Storage was wiped or rewound (vault delete, D8b restore): forget every cached fact, the dedupe index included. */
	reset(): void {
		this.schemaReady = this.schemaManaged;
		this.headCache = null;
		this.dedupe.clear();
	}

	/**
	 * D8a: deletes every row of the three stream tables. Synchronous and transaction-agnostic: the caller may run it
	 * inside its own `transactionSync` (then a rollback restores the rows). Forgets the cached head and the dedupe
	 * index (rebuilt lazily, so a rollback leaves nothing stale). Bills one row per deleted row (§6.2).
	 */
	deleteAllStreamRows(): void {
		this.ensureSchema();
		this.headCache = null;
		this.dedupe.clear();
		for (const table of ["stream_head", "stream_segment", "stream_checkpoint"]) {
			this.storage.sql.exec(`DELETE FROM ${table}`).toArray();
		}
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.storage.sql.exec(STREAM_SCHEMA);
		this.schemaReady = true;
	}

	/** Vault head: the highest committed seq (0 = nothing committed). One index probe, then cached. */
	head(): number {
		this.ensureSchema();
		if (this.headCache === null) {
			this.headCache = this.storage.sql.exec<{ head: number }>(
				"SELECT COALESCE(MAX(last_seq), 0) AS head FROM stream_head").one().head;
		}
		return this.headCache;
	}

	private headRow(stream: string): HeadRow | null {
		return this.storage.sql.exec<HeadRow>(
			"SELECT last_seq, ckpt_seq, gc_seq, tail_first, open_rows, open FROM stream_head WHERE stream = ?", stream,
		).toArray()[0] ?? null;
	}

	/** H2 diagnostics: built stream indexes and their entries (tests and debug). */
	dedupeStats(): { streams: number; entries: number } {
		return { streams: this.dedupe.size, entries: this.dedupe.entries };
	}

	/**
	 * Commits `frames` (arrival order) in one transaction. Every new row gets the
	 * next vault seq in arrival order, so the seqs of one commit are contiguous.
	 * A frame whose (deviceId, clientFrameId) is earlier in the batch, or stored
	 * in the stream's H2 window, gets that row's seq instead.
	 */
	commit(frames: readonly StreamAppendInput[]): StreamCommitResult {
		this.ensureSchema();
		const start = this.head();
		const states = new Map<string, StreamCommitState>();
		const result = this.storage.transactionSync(() => {
			let head = start;
			states.clear();
			const batch = new Map<string, { stream: string; seq: number; payload: Uint8Array }>();
			const outcomes: StreamAppendOutcome[] = [];
			for (const frame of frames) {
				let state = states.get(frame.stream);
				if (!state) {
					state = new StreamCommitState(frame.stream, this.headRow(frame.stream));
					states.set(frame.stream, state);
				}
				const key = frameKey(frame.deviceId, frame.clientFrameId);
				const earlier = batch.get(key);
				if (earlier) {
					outcomes.push(earlier.stream === frame.stream && bytesEqual(earlier.payload, frame.payload)
						? { kind: "deduped", seq: earlier.seq } : { kind: "conflict", seq: earlier.seq });
					continue;
				}
				const hash = frameKeyHash(frame.deviceId, frame.clientFrameId);
				const stored = this.lookup(state, frame, hash);
				if (stored) {
					outcomes.push(stored);
					continue;
				}
				const seq = ++head;
				state.appends.push({ seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, payload: frame.payload });
				state.appendHashes.push(hash);
				batch.set(key, { stream: frame.stream, seq, payload: frame.payload });
				outcomes.push({ kind: "appended", seq });
			}
			for (const state of states.values()) if (state.appends.length > 0) this.writeStream(state);
			return { outcomes, head };
		});
		this.headCache = result.head;
		// H2: rows join the index only once durable. A stream evicted under the cap meanwhile rescans on next use.
		for (const state of states.values()) {
			if (state.appends.length === 0) continue;
			const index = this.dedupe.touch(state.stream);
			if (!index) continue;
			let delta = 0;
			for (let i = 0; i < state.appends.length; i++) {
				delta += index.add(state.appendHashes[i]!, state.appends[i]!.seq, state.appendBytes[i]!);
			}
			this.dedupe.grew(state.stream, delta);
		}
		return result;
	}

	/** The stream's H2 index: built by one bounded cold scan on first use in this runtime (or after an eviction). */
	private indexFor(state: StreamCommitState): StreamDedupeIndex {
		const built = this.dedupe.touch(state.stream);
		if (built) return built;
		const index = this.coldScan(state.stream, state.head);
		this.dedupe.install(state.stream, index);
		return index;
	}

	/**
	 * H2 cold scan, inside the commit transaction and before its writes: the head row (already read by the commit),
	 * then the newest sealed segments, newest first, stopping once ≥ W bytes are held: at most
	 * STREAM_DEDUPE_SCAN_SEGMENTS rows (every sealed segment is ≥ 64 KiB). Keys are parsed, payloads skipped.
	 */
	private coldScan(stream: string, head: HeadRow | null): StreamDedupeIndex {
		const index = new StreamDedupeIndex();
		if (!head) return index;
		const open = head.open && head.open.byteLength > 0 ? new Uint8Array(head.open) : null;
		let bytes = open?.byteLength ?? 0;
		const sealed: Uint8Array[] = [];
		if (head.tail_first !== null && bytes < STREAM_DEDUPE_WINDOW_BYTES) {
			const segments = this.storage.sql.exec<{ bytes: ArrayBuffer }>(
				"SELECT bytes FROM stream_segment WHERE stream = ? ORDER BY first_seq DESC LIMIT ?", stream, STREAM_DEDUPE_SCAN_SEGMENTS);
			for (const segment of segments) {
				const blob = new Uint8Array(segment.bytes);
				sealed.push(blob);
				bytes += blob.byteLength;
				if (bytes >= STREAM_DEDUPE_WINDOW_BYTES) break;
			}
		}
		for (let i = sealed.length - 1; i >= 0; i--) index.scan(sealed[i]!);
		if (open) index.scan(open);
		return index;
	}

	/**
	 * H2 lookup: an index hit is a candidate only. An original at or below gcSeq was collected: deduped with its seq.
	 * Otherwise its row is loaded (open segment: 0 rows read; sealed: 1, cached for the commit) and compared: another
	 * key (a hash collision) is a miss, equal bytes deduped, different bytes a conflict.
	 */
	private lookup(state: StreamCommitState, frame: StreamAppendInput, hash: number): StreamAppendOutcome | null {
		const seq = this.indexFor(state).get(hash);
		if (seq === undefined || !state.head) return null;
		if (seq <= state.head.gc_seq) return { kind: "deduped", seq };
		const row = this.storedRow(state, seq);
		if (!row || row.deviceId !== frame.deviceId || row.clientFrameId !== frame.clientFrameId) return null;
		return bytesEqual(row.payload, frame.payload) ? { kind: "deduped", seq } : { kind: "conflict", seq };
	}

	private storedRow(state: StreamCommitState, seq: number): StreamRow | null {
		const open = state.head?.open;
		if (open && open.byteLength > 0) {
			state.openRows ??= decodeRows(new Uint8Array(open));
			const first = state.openRows[0];
			if (first && seq >= first.seq) return state.openRows.find((row) => row.seq === seq) ?? null;
		}
		let segment = state.segments.find((loaded) => loaded.first <= seq && seq <= loaded.last);
		if (!segment) {
			const stored = this.storage.sql.exec<{ first_seq: number; bytes: ArrayBuffer }>(
				"SELECT first_seq, bytes FROM stream_segment WHERE stream = ? AND first_seq <= ? ORDER BY first_seq DESC LIMIT 1",
				state.stream, seq).toArray()[0];
			if (!stored) return null;
			const rows = decodeRows(new Uint8Array(stored.bytes));
			segment = { first: stored.first_seq, last: rows.at(-1)?.seq ?? stored.first_seq, rows };
			state.segments.push(segment);
		}
		return segment.rows.find((row) => row.seq === seq) ?? null;
	}

	private writeStream(state: StreamCommitState): void {
		const head = state.head;
		let parts: Uint8Array[] = [];
		let size = 0;
		let openRows = head?.open_rows ?? 0;
		let firstSeq: number | null = null;
		let lastSeq = head?.last_seq ?? 0;
		let tailFirst = head?.tail_first ?? null;
		if (head?.open && head.open.byteLength > 0) {
			const open = new Uint8Array(head.open);
			parts.push(open);
			size = open.byteLength;
			firstSeq = decodeRows(open)[0]?.seq ?? null;
		}
		const seal = () => {
			if (size === 0 || firstSeq === null) return;
			this.storage.sql.exec(
				"INSERT INTO stream_segment(stream, first_seq, last_seq, rows, bytes) VALUES (?, ?, ?, ?, ?)",
				state.stream, firstSeq, lastSeq, openRows, concat(parts, size)).toArray();
			tailFirst = firstSeq;
			parts = [];
			size = 0;
			openRows = 0;
			firstSeq = null;
		};
		for (const row of state.appends) {
			const record = encodeRow(row);
			state.appendBytes.push(record.byteLength);
			if (size > 0 && size + record.byteLength > STREAM_SEGMENT_MAX_BYTES) seal();
			parts.push(record);
			size += record.byteLength;
			openRows++;
			firstSeq ??= row.seq;
			lastSeq = row.seq;
		}
		if (size >= STREAM_SEGMENT_SEAL_BYTES) seal();
		const open = size > 0 ? concat(parts, size) : null;
		if (head) {
			this.storage.sql.exec(
				"UPDATE stream_head SET last_seq = ?, tail_first = ?, open_rows = ?, open = ? WHERE stream = ?",
				lastSeq, tailFirst, openRows, open, state.stream).toArray();
		} else {
			this.storage.sql.exec(
				"INSERT INTO stream_head(stream, last_seq, tail_first, open_rows, open) VALUES (?, ?, ?, ?, ?)",
				state.stream, lastSeq, tailFirst, openRows, open).toArray();
		}
	}

	/** Streams whose last seq is after `after`, ascending by lastSeq (an index range scan). */
	feed(after: number, limit: number): StreamFeedPage {
		const head = this.head();
		const rows = this.storage.sql.exec<{ stream: string; last_seq: number }>(
			"SELECT stream, last_seq FROM stream_head WHERE last_seq > ? ORDER BY last_seq LIMIT ?", after, limit + 1,
		).toArray();
		const more = rows.length > limit;
		const changes = rows.slice(0, limit).map((row) => ({ stream: row.stream, lastSeq: row.last_seq }));
		return { head, changes, nextAfter: more ? changes.at(-1)!.lastSeq : null };
	}

	/**
	 * Rows of `stream` after `after`, oldest first, unmerged. The checkpoint is
	 * included when rows at or below `after` + 1 may have been garbage collected
	 * (after < gcSeq), or on request when after < checkpointSeq; rows then start
	 * after its coversSeq. A page holds at most `maxBytes` of payload but always
	 * at least one row (or the checkpoint).
	 */
	read(stream: string, after: number, maxBytes: number, preferCheckpoint = false): StreamReadPage {
		this.ensureSchema();
		const head = this.storage.sql.exec<HeadRow>(
			"SELECT last_seq, ckpt_seq, gc_seq, tail_first, open_rows, open FROM stream_head WHERE stream = ?", stream,
		).toArray()[0];
		if (!head) return { stream, lastSeq: 0, checkpointSeq: 0, gcSeq: 0, checkpoint: null, rows: [], nextAfter: null };
		let from = after;
		let budget = maxBytes;
		let checkpoint: StreamReadPage["checkpoint"] = null;
		if (head.ckpt_seq > 0 && (after < head.gc_seq || (preferCheckpoint && after < head.ckpt_seq))) {
			const chunks = this.storage.sql.exec<{ covers_seq: number; bytes: ArrayBuffer }>(
				"SELECT covers_seq, bytes FROM stream_checkpoint WHERE stream = ? ORDER BY chunk", stream).toArray();
			const parts = chunks.map((chunk) => new Uint8Array(chunk.bytes));
			const size = parts.reduce((total, part) => total + part.byteLength, 0);
			checkpoint = { coversSeq: head.ckpt_seq, bytes: concat(parts.length ? parts : [new Uint8Array(0)], size) };
			from = head.ckpt_seq;
			budget -= size;
		}
		const rows: StreamRow[] = [];
		let more = false;
		const take = (row: StreamRow): boolean => {
			if (row.seq <= from) return true;
			if ((rows.length > 0 || checkpoint) && budget - row.payload.byteLength < 0) { more = true; return false; }
			rows.push(row);
			budget -= row.payload.byteLength;
			return true;
		};
		let stopped = false;
		if (head.tail_first !== null && from < head.last_seq) {
			const segments = this.storage.sql.exec<{ bytes: ArrayBuffer }>(
				`SELECT bytes FROM stream_segment
				 WHERE stream = ?
				   AND first_seq >= COALESCE((SELECT MAX(first_seq) FROM stream_segment WHERE stream = ? AND first_seq <= ?), 0)
				   AND last_seq > ?
				 ORDER BY first_seq`, stream, stream, from, from);
			for (const segment of segments) {
				for (const row of decodeRows(new Uint8Array(segment.bytes))) {
					if (!take(row)) { stopped = true; break; }
				}
				if (stopped) break;
			}
		}
		if (!stopped && head.open) {
			for (const row of decodeRows(new Uint8Array(head.open))) if (!take(row)) break;
		}
		const last = rows.at(-1)?.seq ?? checkpoint?.coversSeq ?? null;
		return { stream, lastSeq: head.last_seq, checkpointSeq: head.ckpt_seq, gcSeq: head.gc_seq, checkpoint, rows,
			nextAfter: more && last !== null ? last : null };
	}

	/**
	 * CAS: replaces the stream's checkpoint when its current coversSeq equals
	 * `expectedPrevCoversSeq`, then deletes sealed segments wholly at or below
	 * `coversSeq`. The open segment (the newest rows) is the retain window, except
	 * that a checkpoint at lastSeq retires the stream (H7): the same head UPDATE
	 * drops the open segment too and sets gcSeq = lastSeq (no indexed column in
	 * SET, still 1 row). The head row stays.
	 */
	putCheckpoint(stream: string, coversSeq: number, expectedPrevCoversSeq: number, bytes: Uint8Array): StreamCheckpointResult {
		this.ensureSchema();
		return this.storage.transactionSync((): StreamCheckpointResult => {
			const head = this.headRow(stream);
			if (!head) return { ok: false, status: 404, error: "stream_not_found" };
			const current = { coversSeq: head.ckpt_seq };
			if (head.ckpt_seq !== expectedPrevCoversSeq) return { ok: false, status: 409, error: "checkpoint_conflict", current };
			if (coversSeq <= head.ckpt_seq) return { ok: false, status: 400, error: "checkpoint_not_advancing", current };
			if (coversSeq > head.last_seq) {
				return { ok: false, status: 409, error: "checkpoint_ahead_of_stream", lastSeq: head.last_seq, current };
			}
			if (head.ckpt_seq > 0) this.storage.sql.exec("DELETE FROM stream_checkpoint WHERE stream = ?", stream).toArray();
			for (let chunk = 0, offset = 0; offset < bytes.byteLength || chunk === 0; chunk++, offset += STREAM_CHECKPOINT_CHUNK_BYTES) {
				this.storage.sql.exec("INSERT INTO stream_checkpoint(stream, chunk, covers_seq, bytes) VALUES (?, ?, ?, ?)",
					stream, chunk, coversSeq, bytes.subarray(offset, offset + STREAM_CHECKPOINT_CHUNK_BYTES)).toArray();
			}
			const retire = coversSeq === head.last_seq;
			let gcSeq = head.gc_seq;
			let tailFirst = head.tail_first;
			let deletedSegments = 0;
			if (tailFirst !== null) {
				const doomed = this.storage.sql.exec<{ count: number; last: number | null }>(
					"SELECT COUNT(*) AS count, MAX(last_seq) AS last FROM stream_segment WHERE stream = ? AND last_seq <= ?",
					stream, coversSeq).one();
				if (doomed.count > 0) {
					this.storage.sql.exec("DELETE FROM stream_segment WHERE stream = ? AND last_seq <= ?", stream, coversSeq).toArray();
					deletedSegments = doomed.count;
					gcSeq = Math.max(gcSeq, doomed.last ?? 0);
					tailFirst = retire ? null : this.storage.sql.exec<{ first: number | null }>(
						"SELECT MAX(first_seq) AS first FROM stream_segment WHERE stream = ?", stream).one().first;
				}
			}
			if (retire) {
				// Every sealed segment ends at or below lastSeq, so all were deleted above.
				this.storage.sql.exec(
					"UPDATE stream_head SET ckpt_seq = ?, gc_seq = ?, tail_first = NULL, open_rows = 0, open = NULL WHERE stream = ?",
					coversSeq, head.last_seq, stream).toArray();
				return { ok: true, coversSeq, gcSeq: head.last_seq, deletedSegments };
			}
			this.storage.sql.exec("UPDATE stream_head SET ckpt_seq = ?, gc_seq = ?, tail_first = ? WHERE stream = ?",
				coversSeq, gcSeq, tailFirst, stream).toArray();
			return { ok: true, coversSeq, gcSeq, deletedSegments };
		});
	}

	/** Diagnostics: row counts per table (tests and debug). */
	tableCounts(): { heads: number; segments: number; checkpointChunks: number } {
		this.ensureSchema();
		const count = (table: string) => this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
		return { heads: count("stream_head"), segments: count("stream_segment"), checkpointChunks: count("stream_checkpoint") };
	}
}
