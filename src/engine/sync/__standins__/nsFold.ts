/**
 * STAND-IN for WP-A src/core/ns/{fold,index}.ts and src/core/codec/nsFoldV1.ts.
 * Replace at integration. Implements a minimal subset of DESIGN §c:
 *  - frame-level dedupe ring (§c.3), coversSeq;
 *  - create (duplicate-docid, identical-duplicate merge, " (n)" suffix),
 *    rename (suffix on collision), delete (live only), restore (against the
 *    current deletedSeq), setBlob (baseRev CAS), upgradeRules (ignored);
 *  - no folder-casing rules, no pruning, no edit-beats-delete, simplified pathKey
 *    (NFC + toLowerCase, NOT the frozen 15.1 table).
 * nsFoldV1 canonical encoding follows §b.5 exactly.
 */

import { DocKindCode } from "../../../core/envelope";
import { FOLD_RULES_VERSION, NS_DEDUPE_RING } from "../../../core/limits";
import type {
	ClientFrameId, ContentHash, DeviceId, DocId, DocKind, NsEntry, NsFoldEvent, NsFoldIndex, NsFoldState, NsFrame, NsOp,
	NsOpOutcome, PathKey, Seq, VaultPath,
} from "../../../core/types";
import { kindOfPath } from "../../../core/types";
import { CodecError, Reader, Writer, fromHex, toHex } from "./bytes";
import { isId } from "./ids";

export function pathKeyStandin(path: VaultPath): PathKey {
	return path.normalize("NFC").toLowerCase().normalize("NFC") as PathKey;
}

export function isValidPathStandin(path: string): boolean {
	if (path.length === 0 || path !== path.normalize("NFC")) return false;
	if (path.startsWith("/") || path.endsWith("/")) return false;
	for (const seg of path.split("/")) {
		if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) return false;
		if (/[\\*"<>:|?\u0000-\u001f\u007f]/.test(seg)) return false;
		if (seg.endsWith(".") || seg.endsWith(" ")) return false;
	}
	return true;
}

export function emptyNsState(): NsFoldState {
	return { formatVersion: 1, foldRulesVersion: FOLD_RULES_VERSION, coversSeq: 0, entries: new Map(), recentFrames: new Map() };
}

export function buildIndex(state: NsFoldState): NsFoldIndex {
	const byPathKey = new Map<PathKey, DocId>();
	const folderRefs = new Map<PathKey, { path: VaultPath; count: number }>();
	let tombstones = 0;
	for (const e of state.entries.values()) {
		if (e.state !== "live") {
			tombstones++;
			continue;
		}
		byPathKey.set(e.pathKey, e.docId);
		const segs = e.path.split("/");
		for (let i = 1; i < segs.length; i++) {
			const p = segs.slice(0, i).join("/");
			const k = pathKeyStandin(p);
			const ref = folderRefs.get(k);
			if (ref) ref.count++;
			else folderRefs.set(k, { path: p, count: 1 });
		}
	}
	return { byPathKey, folderRefs, tombstones };
}

function suffixed(path: VaultPath, n: number): VaultPath {
	const slash = path.lastIndexOf("/");
	const leaf = path.slice(slash + 1);
	const dot = leaf.lastIndexOf(".");
	const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
	const ext = dot > 0 ? leaf.slice(dot) : "";
	return `${path.slice(0, slash + 1)}${stem} (${n})${ext}`;
}

function place(index: NsFoldIndex, path: VaultPath, self: DocId | null): VaultPath {
	const taken = (p: VaultPath) => {
		const holder = index.byPathKey.get(pathKeyStandin(p));
		return holder !== undefined && holder !== self;
	};
	if (!taken(path)) return path;
	for (let n = 2; n < 10_000; n++) {
		const p = suffixed(path, n);
		if (!taken(p)) return p;
	}
	return suffixed(path, 10_000);
}

function setEntry(state: NsFoldState, index: NsFoldIndex, next: NsEntry): void {
	const prev = state.entries.get(next.docId);
	if (prev && prev.state === "live" && index.byPathKey.get(prev.pathKey) === prev.docId) index.byPathKey.delete(prev.pathKey);
	state.entries.set(next.docId, next);
	if (next.state === "live") index.byPathKey.set(next.pathKey, next.docId);
	// folderRefs/tombstones are not used by the stand-in runtime; recompute lazily.
}

function foldOp(state: NsFoldState, index: NsFoldIndex, frame: NsFrame, op: NsOp): { docId: DocId | null; outcome: NsOpOutcome } {
	const ign = (docId: DocId | null, reason: Extract<NsOpOutcome, { kind: "ignored" }>["reason"]) => ({ docId, outcome: { kind: "ignored", reason } as NsOpOutcome });
	switch (op.t) {
		case "create": {
			if (state.entries.has(op.docId)) return ign(op.docId, "duplicate-docid");
			if (!isValidPathStandin(op.path)) return ign(op.docId, "invalid-path");
			if (kindOfPath(op.path) !== op.kind) return ign(op.docId, "kind-mismatch");
			const holderId = index.byPathKey.get(pathKeyStandin(op.path));
			const holder = holderId ? state.entries.get(holderId) : undefined;
			const base: NsEntry = {
				docId: op.docId, kind: op.kind, path: op.path, pathKey: pathKeyStandin(op.path), state: "live",
				createdSeq: frame.seq, createdBy: frame.deviceId, lastTouchSeq: frame.seq, deletedSeq: 0, deleteBaseBodySeq: 0,
				createHash: op.contentHash, createSize: op.size,
				blob: op.kind === "blob" ? { hash: op.contentHash, size: op.size, rev: frame.seq } : null, aliasOf: null,
			};
			if (holder && holder.kind === op.kind && holder.createHash === op.contentHash) {
				setEntry(state, index, { ...base, path: holder.path, pathKey: holder.pathKey, state: "merged", blob: null, aliasOf: holder.docId });
				return { docId: op.docId, outcome: { kind: "merged", into: holder.docId } };
			}
			const finalPath = place(index, op.path, null);
			setEntry(state, index, { ...base, path: finalPath, pathKey: pathKeyStandin(finalPath) });
			return { docId: op.docId, outcome: finalPath === op.path ? { kind: "applied" } : { kind: "suffixed", requestedPath: op.path, finalPath } };
		}
		case "rename": {
			const e = resolve(state, op.docId);
			if (!e) return ign(op.docId, "unknown-docid");
			if (e.state !== "live") return ign(e.docId, "not-deleted");
			if (!isValidPathStandin(op.path)) return ign(e.docId, "invalid-path");
			if (kindOfPath(op.path) !== e.kind) return ign(e.docId, "kind-mismatch");
			if (op.path === e.path) return ign(e.docId, "noop");
			const finalPath = place(index, op.path, e.docId);
			setEntry(state, index, { ...e, path: finalPath, pathKey: pathKeyStandin(finalPath), lastTouchSeq: frame.seq });
			return { docId: e.docId, outcome: finalPath === op.path ? { kind: "applied" } : { kind: "suffixed", requestedPath: op.path, finalPath } };
		}
		case "delete": {
			const e = resolve(state, op.docId);
			if (!e) return ign(op.docId, "unknown-docid");
			if (e.state !== "live") return ign(e.docId, "already-deleted");
			setEntry(state, index, { ...e, state: "deleted", deletedSeq: frame.seq, deleteBaseBodySeq: op.baseBodySeq, lastTouchSeq: frame.seq });
			return { docId: e.docId, outcome: { kind: "deleted" } };
		}
		case "restore": {
			const e = resolve(state, op.docId);
			if (!e) return ign(op.docId, "unknown-docid");
			if (e.state !== "deleted") return ign(e.docId, "not-deleted");
			if (e.deletedSeq !== op.againstDeleteSeq) return ign(e.docId, "restore-not-current");
			if (!isValidPathStandin(op.path) || kindOfPath(op.path) !== e.kind) return ign(e.docId, "invalid-path");
			const finalPath = place(index, op.path, e.docId);
			setEntry(state, index, { ...e, state: "live", path: finalPath, pathKey: pathKeyStandin(finalPath), deletedSeq: 0, deleteBaseBodySeq: 0, lastTouchSeq: frame.seq });
			return { docId: e.docId, outcome: finalPath === op.path ? { kind: "applied" } : { kind: "suffixed", requestedPath: op.path, finalPath } };
		}
		case "setBlob": {
			const e = resolve(state, op.docId);
			if (!e) return ign(op.docId, "unknown-docid");
			if (e.kind !== "blob" || !e.blob) return ign(e.docId, "not-blob");
			if (e.blob.rev !== op.baseRev) return ign(e.docId, "rev-mismatch");
			setEntry(state, index, { ...e, blob: { hash: op.hash, size: op.size, rev: frame.seq }, lastTouchSeq: frame.seq });
			return { docId: e.docId, outcome: { kind: "applied" } };
		}
		case "upgradeRules":
			return ign(null, "rules-version");
	}
}

function resolve(state: NsFoldState, docId: DocId): NsEntry | undefined {
	const e = state.entries.get(docId);
	if (e && e.state === "merged" && e.aliasOf) return state.entries.get(e.aliasOf);
	return e;
}

/** FoldNsFrame stand-in. A frame with zero ops is the "empty frame" a malformed row folds as. */
export function foldNsFrameStandin(state: NsFoldState, index: NsFoldIndex, frame: NsFrame): NsFoldEvent[] {
	const events: NsFoldEvent[] = [];
	const ring = state.recentFrames.get(frame.deviceId) ?? [];
	if (ring.includes(frame.clientFrameId)) {
		events.push({ seq: frame.seq, index: -1, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, docId: null, outcome: { kind: "ignored", reason: "duplicate-frame" } });
		state.coversSeq = Math.max(state.coversSeq, frame.seq);
		return events;
	}
	ring.push(frame.clientFrameId);
	while (ring.length > NS_DEDUPE_RING) ring.shift();
	state.recentFrames.set(frame.deviceId, ring);
	frame.ops.forEach((op, i) => {
		const r = foldOp(state, index, frame, op);
		events.push({ seq: frame.seq, index: i, deviceId: frame.deviceId, clientFrameId: frame.clientFrameId, docId: r.docId, outcome: r.outcome });
	});
	state.coversSeq = Math.max(state.coversSeq, frame.seq);
	return events;
}

// ---------------------------------------------------------------------------
// nsFoldV1 (§b.5)
// ---------------------------------------------------------------------------

const KIND_CODE: Record<DocKind, number> = { markdown: DocKindCode.markdown, canvas: DocKindCode.canvas, blob: DocKindCode.blob };
const KIND_BY_CODE = new Map<number, DocKind>([[1, "markdown"], [2, "canvas"], [3, "blob"]]);
const STATE_CODE = { live: 1, deleted: 2, merged: 3 } as const;
const STATE_BY_CODE = new Map<number, NsEntry["state"]>([[1, "live"], [2, "deleted"], [3, "merged"]]);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function encodeNsFoldV1(state: NsFoldState): Uint8Array {
	const w = new Writer().varuint(1).varuint(state.foldRulesVersion).varuint(state.coversSeq);
	const ids = [...state.entries.keys()].sort(cmp);
	w.varuint(ids.length);
	for (const id of ids) {
		const e = state.entries.get(id) as NsEntry;
		w.varstring(e.docId).u8(KIND_CODE[e.kind]).u8(STATE_CODE[e.state]).varstring(e.path).varuint(e.createdSeq).varstring(e.createdBy)
			.varuint(e.lastTouchSeq).varuint(e.deletedSeq).varuint(e.deleteBaseBodySeq).bytes(fromHex(e.createHash)).varuint(e.createSize);
		if (e.blob && e.kind === "blob" && e.state !== "merged") w.u8(1).bytes(fromHex(e.blob.hash)).varuint(e.blob.size).varuint(e.blob.rev);
		else w.u8(0);
		if (e.state === "merged" && e.aliasOf) w.u8(1).varstring(e.aliasOf);
		else w.u8(0);
	}
	const devices = [...state.recentFrames.keys()].sort(cmp);
	w.varuint(devices.length);
	for (const d of devices) {
		const ring = state.recentFrames.get(d) as ClientFrameId[];
		w.varstring(d).varuint(ring.length);
		for (const f of ring) w.varstring(f);
	}
	return w.finish();
}

/** Throws CodecError. Stand-in: V1 (canonical re-encode) is checked by the caller via encode∘decode equality. */
export function decodeNsFoldV1(bytes: Uint8Array): NsFoldState {
	const r = new Reader(bytes);
	if (r.varuint() !== 1) throw new CodecError("nsFoldV1 formatVersion");
	const foldRulesVersion = r.varuint();
	const coversSeq: Seq = r.varuint();
	const entries = new Map<DocId, NsEntry>();
	const n = r.varuint();
	for (let i = 0; i < n; i++) {
		const docId = r.varstring() as DocId;
		if (!isId(docId)) throw new CodecError("bad docId");
		const kind = KIND_BY_CODE.get(r.u8());
		const st = STATE_BY_CODE.get(r.u8());
		if (!kind || !st) throw new CodecError("bad kind/state");
		const path = r.varstring();
		const createdSeq = r.varuint();
		const createdBy = r.varstring() as DeviceId;
		const lastTouchSeq = r.varuint();
		const deletedSeq = r.varuint();
		const deleteBaseBodySeq = r.varuint();
		const createHash = toHex(r.bytes(32)) as ContentHash;
		const createSize = r.varuint();
		const blob = r.u8() === 1 ? { hash: toHex(r.bytes(32)) as ContentHash, size: r.varuint(), rev: r.varuint() } : null;
		const aliasOf = r.u8() === 1 ? (r.varstring() as DocId) : null;
		entries.set(docId, {
			docId, kind, path, pathKey: pathKeyStandin(path), state: st, createdSeq, createdBy, lastTouchSeq, deletedSeq, deleteBaseBodySeq,
			createHash, createSize, blob, aliasOf,
		});
	}
	const recentFrames = new Map<DeviceId, ClientFrameId[]>();
	const dn = r.varuint();
	for (let i = 0; i < dn; i++) {
		const d = r.varstring() as DeviceId;
		const k = r.varuint();
		if (k < 1 || k > NS_DEDUPE_RING) throw new CodecError("bad ring");
		const ring: ClientFrameId[] = [];
		for (let j = 0; j < k; j++) ring.push(r.varstring() as ClientFrameId);
		recentFrames.set(d, ring);
	}
	r.end();
	return { formatVersion: 1, foldRulesVersion, coversSeq, entries, recentFrames };
}

export function cloneNsState(s: NsFoldState): NsFoldState {
	return {
		formatVersion: 1, foldRulesVersion: s.foldRulesVersion, coversSeq: s.coversSeq, entries: new Map(s.entries),
		recentFrames: new Map([...s.recentFrames].map(([k, v]) => [k, [...v]])),
	};
}
