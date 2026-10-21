/**
 * SimRelay store: server/src/streams/store.ts semantics without SQLite.
 *
 * Per stream: sealed segments (oldest first) plus the open segment. A commit
 * assigns the next vault seqs in arrival order; dedupe looks at frames earlier
 * in the batch (vault-wide key), then the stream's H2 window (server
 * streams/dedupe.ts): the newest dedupeWindowBytes of stored-row bytes, as of
 * before the commit. The window is memory only, as the server's index:
 * forgetDedupe() (a relay restart) drops it and the next lookup rebuilds it
 * from the rows still in segments, so collected rows are out of it then. Rows
 * are pre-sealed before the open segment would
 * pass maxSegmentBytes and sealed after the commit once >= sealBytes.
 * putCheckpoint is a CAS; it deletes sealed segments wholly <= coversSeq and
 * gcSeq becomes the highest deleted seq. The open segment is the retain window,
 * except that a checkpoint at lastSeq retires the stream (server H7,
 * store.ts putCheckpoint): the open segment goes too and gcSeq = lastSeq. A
 * warm window keeps the keys of collected rows; a resend of one (seq <= gcSeq)
 * is deduped at the original seq without a byte compare (server H2 lookup).
 */

import type { ClientFrameId, DeviceId, Seq, StreamName } from "../core/types";
import type { RelayRow } from "../ports/relay";
import { bytesEqual } from "../core/codec/lib0";
import { frameKey, rowBytes, type SimRow } from "./a-relay-util";

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
	/**
	 * The H2 window (server StreamDedupeIndex): (key, seq, rowBytes) oldest first, trimmed to the newest
	 * dedupeWindowBytes; null = cold (rebuilt from the segment rows at the next lookup).
	 */
	window: { readonly key: string; readonly seq: Seq; readonly bytes: number }[] | null;
	windowBytes: number;
}

export interface StoreConfig {
	readonly sealBytes: number;
	readonly maxSegmentBytes: number;
	readonly dedupeWindowBytes: number;
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
		// A snapshot / restore (server D8b) forgets every cached fact, the dedupe index included.
		lastSeq: st.lastSeq, checkpoint: st.checkpoint, gcSeq: st.gcSeq, history: st.history.slice(), window: null, windowBytes: 0,
	};
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

	/** Server H2 lookup: the newest windowed row of `key` (its seq; the row itself from history), or undefined. */
	private lookup(state: StreamState | undefined, key: string): SimRow | undefined {
		if (state === undefined) return undefined;
		const window = this.warm(state);
		for (let i = window.length - 1; i >= 0; i--) {
			const w = window[i]!;
			if (w.key !== key) continue;
			return state.history.find((r) => r.seq === w.seq);
		}
		return undefined;
	}

	/** The stream's window, rebuilt (cold scan) from the rows still in segments when it was forgotten. */
	private warm(state: StreamState): NonNullable<StreamState["window"]> {
		if (state.window !== null) return state.window;
		state.window = [];
		state.windowBytes = 0;
		for (const row of [...state.sealed.flatMap((g) => g.rows), ...state.open.rows]) this.windowAdd(state, row);
		return state.window;
	}

	/** Server StreamDedupeIndex.add: append the newest row, then drop the oldest while the rest still hold >= W bytes. */
	private windowAdd(state: StreamState, row: SimRow): void {
		const window = state.window;
		if (window === null) return;
		const bytes = rowBytes(row);
		window.push({ key: frameKey(row.deviceId, row.clientFrameId), seq: row.seq, bytes });
		state.windowBytes += bytes;
		let drop = 0;
		while (window.length - drop > 1 && state.windowBytes - window[drop]!.bytes >= this.config.dedupeWindowBytes) state.windowBytes -= window[drop++]!.bytes;
		if (drop > 0) window.splice(0, drop);
	}

	/** Relay restart: every stream's H2 window is forgotten (memory only). */
	forgetDedupe(): void {
		for (const state of this.streamMap.values()) {
			state.window = null;
			state.windowBytes = 0;
		}
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
				// A collected original (H7 retire) cannot be compared: deduped, the checkpoint covers it (server H2).
				const collected = stored.seq <= (this.streamMap.get(frame.stream)?.gcSeq ?? 0);
				outcomes.push(collected || bytesEqual(stored.payload, frame.payload) ? { kind: "deduped", seq: stored.seq } : { kind: "conflict", seq: stored.seq });
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
			state = { name: stream, sealed: [], open: { rows: [], bytes: 0 }, lastSeq: 0, checkpoint: null, gcSeq: 0, history: [], window: [], windowBytes: 0 };
			this.streamMap.set(stream, state);
		}
		for (const row of rows) {
			const size = rowBytes(row);
			if (state.open.bytes > 0 && state.open.bytes + size > this.config.maxSegmentBytes) this.seal(state);
			state.open.rows.push(row);
			state.open.bytes += size;
			state.lastSeq = row.seq;
			state.history.push(row);
			// Rows join the index once durable (server commit()); a cold window picks them up when it is rebuilt.
			this.windowAdd(state, row);
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

	/** CAS on the current checkpoint coversSeq, then GC of sealed segments wholly <= coversSeq (and of the open one at lastSeq). */
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
			// H7: a checkpoint at lastSeq retires the stream; the open segment is dropped with the same head update.
			if (coversSeq === state.lastSeq) {
				state.open = { rows: [], bytes: 0 };
				state.gcSeq = state.lastSeq;
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
