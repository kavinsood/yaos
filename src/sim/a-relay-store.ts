/**
 * SimRelay store: server/src/streams/store.ts semantics without SQLite.
 *
 * Per stream: sealed segments (oldest first) plus the open segment. A commit
 * assigns the next vault seqs in arrival order; dedupe looks at frames earlier
 * in the batch (vault-wide key), then the stream's open segment, plus the
 * newest sealed segment while the open segment holds < tailRows rows (both as
 * of before the commit). Rows are pre-sealed before the open segment would
 * pass maxSegmentBytes and sealed after the commit once >= sealBytes.
 * putCheckpoint is a CAS; it deletes sealed segments wholly <= coversSeq and
 * gcSeq becomes the highest deleted seq. The open segment is never collected.
 */

import type { ClientFrameId, DeviceId, Seq, StreamName } from "../core/types";
import type { RelayRow } from "../ports/relay";
import { bytesEqual, frameKey, rowBytes, type SimRow } from "./a-relay-util";

export interface StoreFrame {
	readonly stream: StreamName;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly payload: Uint8Array;
}

export type StoreOutcome =
	| { readonly kind: "appended"; readonly seq: Seq }
	| { readonly kind: "deduped"; readonly seq: Seq }
	| { readonly kind: "conflict"; readonly seq: Seq };

export interface StoreFeed {
	readonly head: Seq;
	readonly changes: readonly { readonly stream: StreamName; readonly lastSeq: Seq }[];
	readonly nextAfter: Seq | null;
}

export interface StoreRead {
	readonly lastSeq: Seq;
	readonly checkpointSeq: Seq;
	readonly gcSeq: Seq;
	readonly checkpoint: { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null;
	readonly rows: readonly RelayRow[];
	/** null on the last page (wire). */
	readonly nextAfter: Seq | null;
}

export type StoreCheckpointResult =
	| { readonly ok: true; readonly gcSeq: Seq; readonly deletedSegments: number }
	| { readonly ok: false; readonly error: "stream_not_found" }
	| { readonly ok: false; readonly error: "checkpoint_conflict" | "checkpoint_not_advancing"; readonly current: Seq }
	| { readonly ok: false; readonly error: "checkpoint_ahead_of_stream"; readonly current: Seq; readonly lastSeq: Seq };

export interface SegmentInfo {
	readonly firstSeq: Seq;
	readonly lastSeq: Seq;
	readonly rows: number;
	readonly bytes: number;
}

interface Segment {
	readonly rows: SimRow[];
	bytes: number;
}

interface StreamState {
	readonly name: StreamName;
	readonly sealed: Segment[];
	open: Segment;
	lastSeq: Seq;
	checkpoint: { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null;
	gcSeq: Seq;
	/** Every committed row (introspection only). */
	readonly history: SimRow[];
}

export interface StoreConfig {
	readonly sealBytes: number;
	readonly maxSegmentBytes: number;
	readonly tailRows: number;
	readonly gcOnCheckpoint: boolean;
}

/** A RelayStore snapshot (RelayStore.snapshot / restore). */
export interface StoreSnapshot {
	readonly head: Seq;
	readonly streams: readonly StreamState[];
}

function copyState(st: StreamState): StreamState {
	return {
		name: st.name, sealed: st.sealed.map((g) => ({ rows: g.rows.slice(), bytes: g.bytes })), open: { rows: st.open.rows.slice(), bytes: st.open.bytes },
		lastSeq: st.lastSeq, checkpoint: st.checkpoint, gcSeq: st.gcSeq, history: st.history.slice(),
	};
}

function findKey(rows: readonly SimRow[], key: string): SimRow | undefined {
	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i]!;
		if (frameKey(row.deviceId, row.clientFrameId) === key) return row;
	}
	return undefined;
}

export class RelayStore {
	private headSeq: Seq = 0;
	private readonly streamMap = new Map<StreamName, StreamState>();

	constructor(private readonly config: StoreConfig) {}

	head(): Seq {
		return this.headSeq;
	}

	reset(): void {
		this.headSeq = 0;
		this.streamMap.clear();
	}

	/** The whole store as of now (rows are immutable and shared; segment lists are copied). */
	snapshot(): StoreSnapshot {
		return { head: this.headSeq, streams: [...this.streamMap.values()].map(copyState) };
	}

	/** Point-in-time restore: the store becomes `snap` exactly (server D8b "content == T"). */
	restore(snap: StoreSnapshot): void {
		this.headSeq = snap.head;
		this.streamMap.clear();
		for (const st of snap.streams) this.streamMap.set(st.name, copyState(st));
	}

	/**
	 * Hostile relay (sim only, e2ee-design §20.2): append `frames` as new rows, in order, with no dedupe lookup
	 * (a replayed (deviceId, clientFrameId) lands again at a new seq).
	 */
	forge(frames: readonly StoreFrame[]): SimRow[] {
		let head = this.headSeq;
		const rows: SimRow[] = [];
		for (const f of frames) {
			const row: SimRow = { stream: f.stream, seq: ++head, deviceId: f.deviceId, clientFrameId: f.clientFrameId, payload: f.payload };
			this.writeStream(f.stream, [row]);
			rows.push(row);
		}
		this.headSeq = head;
		return rows;
	}

	private lookup(state: StreamState | undefined, key: string): SimRow | undefined {
		if (state === undefined) return undefined;
		const open = findKey(state.open.rows, key);
		if (open !== undefined || state.open.rows.length >= this.config.tailRows || state.sealed.length === 0) return open;
		return findKey(state.sealed[state.sealed.length - 1]!.rows, key);
	}

	/** One transaction: outcomes in frame order; seqs of appended rows are contiguous. */
	commit(frames: readonly StoreFrame[]): { readonly outcomes: StoreOutcome[]; readonly rows: SimRow[]; readonly head: Seq } {
		let head = this.headSeq;
		const batch = new Map<string, { readonly stream: StreamName; readonly seq: Seq; readonly payload: Uint8Array }>();
		const appends = new Map<StreamName, SimRow[]>();
		const outcomes: StoreOutcome[] = [];
		const rows: SimRow[] = [];
		for (const frame of frames) {
			const key = frameKey(frame.deviceId, frame.clientFrameId);
			const earlier = batch.get(key);
			if (earlier !== undefined) {
				outcomes.push(earlier.stream === frame.stream && bytesEqual(earlier.payload, frame.payload)
					? { kind: "deduped", seq: earlier.seq } : { kind: "conflict", seq: earlier.seq });
				continue;
			}
			const stored = this.lookup(this.streamMap.get(frame.stream), key);
			if (stored !== undefined) {
				outcomes.push(bytesEqual(stored.payload, frame.payload) ? { kind: "deduped", seq: stored.seq } : { kind: "conflict", seq: stored.seq });
				continue;
			}
			const seq = ++head;
			const row: SimRow = { stream: frame.stream, seq, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, payload: frame.payload };
			const list = appends.get(frame.stream);
			if (list === undefined) appends.set(frame.stream, [row]);
			else list.push(row);
			batch.set(key, { stream: frame.stream, seq, payload: frame.payload });
			outcomes.push({ kind: "appended", seq });
			rows.push(row);
		}
		for (const [stream, list] of appends) this.writeStream(stream, list);
		this.headSeq = head;
		return { outcomes, rows, head };
	}

	private writeStream(stream: StreamName, rows: readonly SimRow[]): void {
		let state = this.streamMap.get(stream);
		if (state === undefined) {
			state = { name: stream, sealed: [], open: { rows: [], bytes: 0 }, lastSeq: 0, checkpoint: null, gcSeq: 0, history: [] };
			this.streamMap.set(stream, state);
		}
		for (const row of rows) {
			const size = rowBytes(row);
			if (state.open.bytes > 0 && state.open.bytes + size > this.config.maxSegmentBytes) this.seal(state);
			state.open.rows.push(row);
			state.open.bytes += size;
			state.lastSeq = row.seq;
			state.history.push(row);
		}
		if (state.open.bytes >= this.config.sealBytes) this.seal(state);
	}

	private seal(state: StreamState): void {
		if (state.open.rows.length === 0) return;
		state.sealed.push(state.open);
		state.open = { rows: [], bytes: 0 };
	}

	/** Streams whose last seq is after `after`, ascending by lastSeq. */
	feed(after: Seq, limit: number): StoreFeed {
		const changed: { stream: StreamName; lastSeq: Seq }[] = [];
		for (const state of this.streamMap.values()) if (state.lastSeq > after) changed.push({ stream: state.name, lastSeq: state.lastSeq });
		changed.sort((a, b) => a.lastSeq - b.lastSeq);
		const more = changed.length > limit;
		const changes = changed.slice(0, limit);
		return { head: this.headSeq, changes, nextAfter: more ? changes[changes.length - 1]!.lastSeq : null };
	}

	/**
	 * Rows after `after`, oldest first. The checkpoint is included when
	 * after < gcSeq, or with preferCheckpoint when after < checkpointSeq; rows
	 * then start after its coversSeq. maxBytes counts payload (and checkpoint)
	 * bytes; a page always has at least one row or the checkpoint.
	 */
	read(stream: StreamName, after: Seq, maxBytes: number, preferCheckpoint: boolean, maxRows = Number.POSITIVE_INFINITY): StoreRead {
		const state = this.streamMap.get(stream);
		if (state === undefined) return { lastSeq: 0, checkpointSeq: 0, gcSeq: 0, checkpoint: null, rows: [], nextAfter: null };
		const cp = state.checkpoint;
		let from = after;
		let budget = maxBytes;
		let checkpoint: StoreRead["checkpoint"] = null;
		if (cp !== null && cp.coversSeq > 0 && (after < state.gcSeq || (preferCheckpoint && after < cp.coversSeq))) {
			checkpoint = { coversSeq: cp.coversSeq, bytes: cp.bytes.slice() };
			from = cp.coversSeq;
			budget -= cp.bytes.byteLength;
		}
		const rows: RelayRow[] = [];
		let more = false;
		outer: for (const segment of [...state.sealed, state.open]) {
			if (segment.rows.length === 0 || segment.rows[segment.rows.length - 1]!.seq <= from) continue;
			for (const row of segment.rows) {
				if (row.seq <= from) continue;
				if ((rows.length > 0 || checkpoint !== null) && (budget - row.payload.byteLength < 0 || rows.length >= maxRows)) {
					more = true;
					break outer;
				}
				rows.push({ seq: row.seq, deviceId: row.deviceId, clientFrameId: row.clientFrameId, payload: row.payload.slice() });
				budget -= row.payload.byteLength;
			}
		}
		const last = rows.length > 0 ? rows[rows.length - 1]!.seq : checkpoint?.coversSeq ?? null;
		return { lastSeq: state.lastSeq, checkpointSeq: cp?.coversSeq ?? 0, gcSeq: state.gcSeq, checkpoint, rows, nextAfter: more && last !== null ? last : null };
	}

	/** CAS on the current checkpoint coversSeq, then GC of sealed segments wholly <= coversSeq. */
	putCheckpoint(stream: StreamName, coversSeq: Seq, expectedPrevCoversSeq: Seq, bytes: Uint8Array): StoreCheckpointResult {
		const state = this.streamMap.get(stream);
		if (state === undefined) return { ok: false, error: "stream_not_found" };
		const current = state.checkpoint?.coversSeq ?? 0;
		if (current !== expectedPrevCoversSeq) return { ok: false, error: "checkpoint_conflict", current };
		if (coversSeq <= current) return { ok: false, error: "checkpoint_not_advancing", current };
		if (coversSeq > state.lastSeq) return { ok: false, error: "checkpoint_ahead_of_stream", current, lastSeq: state.lastSeq };
		state.checkpoint = { coversSeq, bytes: bytes.slice() };
		let deletedSegments = 0;
		if (this.config.gcOnCheckpoint) {
			while (state.sealed.length > 0) {
				const first = state.sealed[0]!;
				const lastSeq = first.rows[first.rows.length - 1]!.seq;
				if (lastSeq > coversSeq) break;
				state.sealed.shift();
				state.gcSeq = Math.max(state.gcSeq, lastSeq);
				deletedSegments++;
			}
		}
		return { ok: true, gcSeq: state.gcSeq, deletedSegments };
	}

	// ---- introspection ------------------------------------------------------

	/** Readable rows (still in a segment), or every committed row with includeGc. */
	rows(stream: StreamName, includeGc = false): readonly SimRow[] {
		const state = this.streamMap.get(stream);
		if (state === undefined) return [];
		if (includeGc) return state.history.slice();
		return [...state.sealed.flatMap((s) => s.rows), ...state.open.rows];
	}

	/** Streams in first-commit order. */
	streams(): readonly StreamName[] {
		return Array.from(this.streamMap.keys());
	}

	lastSeq(stream: StreamName): Seq {
		return this.streamMap.get(stream)?.lastSeq ?? 0;
	}

	checkpoint(stream: StreamName): { readonly coversSeq: Seq; readonly bytes: Uint8Array } | null {
		const cp = this.streamMap.get(stream)?.checkpoint ?? null;
		return cp === null ? null : { coversSeq: cp.coversSeq, bytes: cp.bytes.slice() };
	}

	gcSeq(stream: StreamName): Seq {
		return this.streamMap.get(stream)?.gcSeq ?? 0;
	}

	/** Sealed segments (oldest first) and the open segment (null when empty). */
	segments(stream: StreamName): { readonly sealed: readonly SegmentInfo[]; readonly open: SegmentInfo | null } {
		const state = this.streamMap.get(stream);
		const info = (s: Segment): SegmentInfo => ({ firstSeq: s.rows[0]!.seq, lastSeq: s.rows[s.rows.length - 1]!.seq, rows: s.rows.length, bytes: s.bytes });
		if (state === undefined) return { sealed: [], open: null };
		return { sealed: state.sealed.map(info), open: state.open.rows.length > 0 ? info(state.open) : null };
	}

	/** Whether a resend of (deviceId, clientFrameId) on `stream` would be deduped right now (inside the window). */
	inDedupeWindow(stream: StreamName, deviceId: DeviceId, clientFrameId: ClientFrameId): boolean {
		return this.lookup(this.streamMap.get(stream), frameKey(deviceId, clientFrameId)) !== undefined;
	}
}
