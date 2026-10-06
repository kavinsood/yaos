/**
 * Snapshot index fold (DESIGN §j.4). Pure and total. The state is a join of the folded ops, so the result
 * does not depend on the order of rows or on duplicates (no dedupe ring is needed):
 *
 * - floors:  per device, max over its own floor ops. A device's snapshots created before its floor are deleted.
 * - dels:    keys (deviceId/snapshotId) deleted by any device, kept only at or above the target device's floor.
 * - records: per key, the put whose canonical body is smallest (bytewise), unless the key is deleted or below the
 *            floor. Two different puts for one key only come from a buggy or hostile writer; the minimum keeps
 *            every reader on the same choice.
 *
 * A put's key is (the row's deviceId, record.snapshotId): a device can only add its own snapshots. Ids embed
 * createdAtMs, so floor pruning of dels and records is exact and the state stays bounded by what retention keeps.
 * `coversSeq` only tracks the runtime's position (FoldRuntime); it is not part of the join.
 */

import type { DeviceId, Seq } from "../types";
import { bytesToHex, compareCodeUnits } from "../codec/lib0";
import {
	SNAP_VIEW_PER_DEVICE, encodeSnapRecord, isValidSnapOp, parseSnapshotId, snapKey,
	type SnapOp, type SnapRecord,
} from "./record";

export const SNAP_FOLD_RULES_VERSION = 1;

export interface SnapEntry {
	readonly deviceId: DeviceId;
	readonly record: SnapRecord;
	/** Canonical put body (encodeSnapRecord). */
	readonly bytes: Uint8Array;
}

export interface SnapFoldState {
	readonly formatVersion: 1;
	coversSeq: Seq;
	readonly floors: Map<DeviceId, number>;
	readonly dels: Map<string, { readonly deviceId: DeviceId; readonly snapshotId: string }>;
	readonly records: Map<string, SnapEntry>;
}

export interface SnapFrame {
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	/** [] for a malformed payload. */
	readonly ops: readonly SnapOp[];
}

export type SnapOpOutcome =
	| { readonly t: "applied" }
	| { readonly t: "same" }
	| { readonly t: "ignored"; readonly reason: "invalid-op" | "unknown-version" | "deleted" | "below-floor" | "conflict-lost" };

export interface SnapFoldEvent {
	readonly seq: Seq;
	readonly index: number;
	readonly deviceId: DeviceId;
	/** Key the op touched (null for invalid ops, unknown versions and floors). */
	readonly key: string | null;
	readonly outcome: SnapOpOutcome;
}

export function newSnapFold(): SnapFoldState {
	return { formatVersion: 1, coversSeq: 0, floors: new Map(), dels: new Map(), records: new Map() };
}

export function cloneSnapFold(s: SnapFoldState): SnapFoldState {
	return { formatVersion: 1, coversSeq: s.coversSeq, floors: new Map(s.floors), dels: new Map(s.dels), records: new Map(s.records) };
}

const createdOf = (id: string): number => parseSnapshotId(id)?.createdAtMs ?? -1;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
	return a.length - b.length;
}

/** Applies one op by `author`. Order- and duplicate-independent (see the module comment). */
export function applySnapOp(state: SnapFoldState, author: DeviceId, op: SnapOp): { key: string | null; outcome: SnapOpOutcome } {
	if (!isValidSnapOp(op)) return { key: null, outcome: { t: "ignored", reason: op.t === "putUnknown" ? "unknown-version" : "invalid-op" } };
	switch (op.t) {
		case "putUnknown":
			return { key: null, outcome: { t: "ignored", reason: "unknown-version" } };
		case "floor": {
			const cur = state.floors.get(author) ?? 0;
			if (op.createdAtMs <= cur) return { key: null, outcome: { t: "same" } };
			state.floors.set(author, op.createdAtMs);
			const prefix = `${author}/`;
			for (const [k, d] of state.dels) if (d.deviceId === author && createdOf(d.snapshotId) < op.createdAtMs) state.dels.delete(k);
			for (const [k, e] of state.records) if (k.startsWith(prefix) && e.deviceId === author && e.record.createdAtMs < op.createdAtMs) state.records.delete(k);
			return { key: null, outcome: { t: "applied" } };
		}
		case "del": {
			const key = snapKey(op.deviceId, op.snapshotId);
			if (createdOf(op.snapshotId) < (state.floors.get(op.deviceId) ?? 0)) return { key, outcome: { t: "ignored", reason: "below-floor" } };
			const had = state.records.delete(key);
			if (state.dels.has(key)) return { key, outcome: { t: "same" } };
			state.dels.set(key, { deviceId: op.deviceId, snapshotId: op.snapshotId });
			return { key, outcome: had ? { t: "applied" } : { t: "same" } };
		}
		case "put": {
			const key = snapKey(author, op.record.snapshotId);
			if (op.record.createdAtMs < (state.floors.get(author) ?? 0)) return { key, outcome: { t: "ignored", reason: "below-floor" } };
			if (state.dels.has(key)) return { key, outcome: { t: "ignored", reason: "deleted" } };
			const bytes = encodeSnapRecord(op.record);
			const cur = state.records.get(key);
			if (cur) {
				const c = compareBytes(bytes, cur.bytes);
				if (c === 0) return { key, outcome: { t: "same" } };
				if (c > 0) return { key, outcome: { t: "ignored", reason: "conflict-lost" } };
			}
			state.records.set(key, { deviceId: author, record: op.record, bytes });
			return { key, outcome: { t: "applied" } };
		}
	}
}

/** Folds one committed frame (rows at or below coversSeq were already folded). */
export function foldSnapFrame(state: SnapFoldState, frame: SnapFrame): SnapFoldEvent[] {
	if (frame.seq <= state.coversSeq) return [];
	const events = frame.ops.map((op, index): SnapFoldEvent => ({ seq: frame.seq, index, deviceId: frame.deviceId, ...applySnapOp(state, frame.deviceId, op) }));
	state.coversSeq = frame.seq;
	return events;
}

/** Own pending frames over a copy of the committed state (pseudo-seqs above coversSeq). */
export function overlayPendingSnap(state: SnapFoldState, self: DeviceId, frames: readonly { readonly ops: readonly SnapOp[] }[]): SnapFoldState {
	const s = cloneSnapFold(state);
	frames.forEach((f, i) => { foldSnapFrame(s, { seq: state.coversSeq + 1 + i, deviceId: self, ops: f.ops }); });
	return s;
}

/** Live records, newest first (createdAtMs desc, then key), at most SNAP_VIEW_PER_DEVICE per device. */
export function snapLive(state: SnapFoldState, perDevice = SNAP_VIEW_PER_DEVICE): SnapEntry[] {
	const all = [...state.records.entries()].sort(([ka, a], [kb, b]) => b.record.createdAtMs - a.record.createdAtMs || compareCodeUnits(ka, kb));
	const seen = new Map<DeviceId, number>();
	const out: SnapEntry[] = [];
	for (const [, e] of all) {
		const n = seen.get(e.deviceId) ?? 0;
		if (n >= perDevice) continue;
		seen.set(e.deviceId, n + 1);
		out.push(e);
	}
	return out;
}

/**
 * Retention of one device's uploads: keep the newest `keep` (>= 1) of `createdAts`; returns the floor that
 * deletes the rest (the createdAtMs of the oldest kept one), or null when nothing needs deleting.
 */
export function retentionFloor(createdAts: readonly number[], keep: number): number | null {
	const k = Math.max(1, Math.floor(keep));
	if (createdAts.length <= k) return null;
	const sorted = [...createdAts].sort((a, b) => b - a);
	return sorted[k - 1]!;
}

/** Stable digest of the join (tests and diagnostics): coversSeq excluded. */
export function snapFoldFingerprint(s: SnapFoldState): string {
	const floors = [...s.floors.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([d, f]) => `${d}=${f}`);
	const dels = [...s.dels.keys()].sort(compareCodeUnits);
	const recs = [...s.records.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([k, e]) => `${k}:${bytesToHex(e.bytes)}`);
	return JSON.stringify([floors, dels, recs]);
}
