/**
 * STAND-IN engine pieces: per-doc state, persistence record, conservative
 * merge, Y.Text diff apply, status snapshot. See engine.ts.
 */

import * as Y from "yjs";
import type { DeviceClass } from "../../core/limits";
import { MERGE_MAX_EDITS_PER_SIDE, MERGE_MAX_INPUT_CHARS } from "../../core/limits";
import type { DiskFingerprint, DocId, MergeFn, MergeLimits } from "../../core/types";
import type { StatusSnapshot } from "../../protocol/status";

export const HUB_IN = Symbol("standin-hub-in");
export const MAIN_IN = Symbol("standin-main-in");
export const LOAD = Symbol("standin-load");

export const STANDIN_MERGE_LIMITS: MergeLimits = { maxInputChars: MERGE_MAX_INPUT_CHARS, maxEditsPerSide: MERGE_MAX_EDITS_PER_SIDE };

/** Conservative merge (same as host/__standins__/merge.ts): two-sided edits conflict. */
export const conservativeMerge: MergeFn = ({ base, disk, crdt, limits }) => {
	if (disk === crdt) return { kind: "identical" };
	if (base === null) return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "no-base" };
	if (crdt === base) return { kind: "disk-only", text: disk };
	if (disk === base) return { kind: "crdt-only", text: crdt };
	if (Math.max(base.length, disk.length, crdt.length) > limits.maxInputChars) return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "too-large" };
	return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "both-edited" };
};

/** Replace `from` with `to` in ytext as one prefix/suffix-trimmed hunk. */
export function applyTextDiff(ytext: Y.Text, to: string, origin: unknown): boolean {
	const from = ytext.toString();
	if (from === to) return false;
	let start = 0;
	const max = Math.min(from.length, to.length);
	while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
	let ef = from.length;
	let et = to.length;
	while (ef > start && et > start && from.charCodeAt(ef - 1) === to.charCodeAt(et - 1)) {
		ef--;
		et--;
	}
	const doc = ytext.doc;
	if (!doc) throw new Error("ytext without doc");
	doc.transact(() => {
		if (ef > start) ytext.delete(start, ef - start);
		if (et > start) ytext.insert(start, to.slice(start, et));
	}, origin);
	return true;
}

/** What survives an engine restart (the real engine keeps this in IndexedDB). */
export interface PersistedDoc {
	readonly path: string;
	readonly state: Uint8Array;
	readonly base: string | null;
	readonly diskText: string | null;
	readonly diskFp: DiskFingerprint | null;
}

/** Per-device persistent store shared across engine incarnations (sim). */
export type StandinStore = Map<string, PersistedDoc>;

export interface DocState {
	readonly key: string;
	readonly docId: DocId;
	path: string;
	readonly doc: Y.Doc;
	readonly ytext: Y.Text;
	/** Last synced text (merge base); null = none. */
	base: string | null;
	/** What we believe is on disk (last read or written); null = absent/unknown. */
	diskText: string | null;
	diskFp: DiskFingerprint | null;
	readonly bound: Set<number>;
	/** Serializes disk work for this doc. */
	chain: Promise<void>;
	projectQueued: boolean;
	persistTimer: number | null;
}

export function newDocState(key: string, docId: DocId, path: string): DocState {
	const doc = new Y.Doc();
	return { key, docId, path, doc, ytext: doc.getText("text"), base: null, diskText: null, diskFp: null, bound: new Set(), chain: Promise.resolve(), projectQueued: false, persistTimer: null };
}

export function persistedOf(st: DocState): PersistedDoc {
	return { path: st.path, state: Y.encodeStateAsUpdate(st.doc), base: st.base, diskText: st.diskText, diskFp: st.diskFp };
}

export function statusSnapshot(input: { deviceClass: DeviceClass; transport: "worker" | "inline"; liveDocs: number; residentDocs: number; pendingDiskOps: number; online: boolean; nowMs: number }): StatusSnapshot {
	return {
		phase: input.online ? "live" : "offline",
		deviceClass: input.deviceClass,
		transport: input.transport,
		vaultEpoch: null,
		vaultSeq: 0 as StatusSnapshot["vaultSeq"],
		headSeq: 0 as StatusSnapshot["headSeq"],
		relay: { connected: input.online, lastCloseCode: null, reconnectInMs: null, rttMs: null },
		counts: {
			liveDocs: input.liveDocs, staleStreams: 0, outboxFrames: 0, outboxBytes: 0, unreceiptedFrames: 0,
			residentDocs: input.residentDocs, residentBytesEstimate: 0, pendingDiskOps: input.pendingDiskOps,
			pendingBlobs: 0, quarantinedRows: 0, frozenDocs: 0, conflictCopiesToday: 0,
		},
		bootstrap: null,
		brake: null,
		lastFullReconcileAtMs: null,
		lastSyncedAtMs: input.online ? input.nowMs : null,
		dailyFramesUsed: 0,
		notices: [],
	};
}

/** Conflict copy name for engine-side merges: "<stem> (conflict <label>[ n])<ext>". */
export function engineConflictPath(path: string, label: string, n: number): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const hasExt = dot > slash + 1;
	const stem = hasExt ? path.slice(0, dot) : path;
	const ext = hasExt ? path.slice(dot) : "";
	const safe = label.replace(/[\\/*"<>:|?\u0000-\u001f\u007f]/g, "-").slice(0, 40) || "device";
	return `${stem} (conflict ${safe}${n > 1 ? ` ${n}` : ""})${ext}`;
}
