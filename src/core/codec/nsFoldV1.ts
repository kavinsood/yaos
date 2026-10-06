/**
 * nsFoldV1: canonical NsFoldState bytes (DESIGN §b.5). Digests (V3) are over
 * these uncompressed bytes; the envelope deflates them.
 *
 * The encoder is canonical (entries by ascending docId, devices by ascending
 * deviceId, UTF-16 code-unit order). The decoder is strict about bytes
 * (minimal varuints, UTF-8, no trailing bytes, ring n in 1..64, replay
 * windows canonical) but not about order/uniqueness: V1 (re-encode equality,
 * src/core/ns/verify.ts) catches those, V2 catches field inconsistencies.
 *
 * After the rings comes the frameNo replay state (e2ee-design §8.2, "V2" in
 * that document; redefined in place, §18): varuint deviceCount, then per
 * device (ascending deviceId) varstring deviceId, varuint r, 8 bytes bitmap
 * (big-endian; bit i = frameNo r − i).
 */

import type { ClientFrameId, DeviceId, DocId, NsEntry, NsEntryState, NsFoldState, ReplayWindow } from "../types";
import { NS_DEDUPE_RING } from "../limits";
import { REPLAY_BITS_BYTES, replayBitsFromBytes, replayBitsToBytes, replayWindowValid } from "../replayWindow";
import { pathKey } from "../paths/pathKey";
import { CodecError, Reader, Writer, compareCodeUnits } from "./lib0";
import { bytesToHash, hashToBytes } from "./ids";
import { docKindCode, docKindFromCode } from "./nsOps";

export const NS_FOLD_FORMAT_VERSION = 1;

const STATE_CODE: Record<NsEntryState, number> = { live: 1, deleted: 2, merged: 3 };
const STATE_BY_CODE: ReadonlyMap<number, NsEntryState> = new Map([[1, "live"], [2, "deleted"], [3, "merged"]]);

export function sortedKeys<K extends string>(m: ReadonlyMap<K, unknown>): K[] {
	return [...m.keys()].sort(compareCodeUnits);
}

export function writeRings(w: Writer, rings: ReadonlyMap<DeviceId, readonly ClientFrameId[]>): void {
	const devices = sortedKeys(rings);
	w.varuint(devices.length);
	for (const d of devices) {
		const ring = rings.get(d)!;
		w.varstring(d).varuint(ring.length);
		for (const id of ring) w.varstring(id);
	}
}

export function readRings(r: Reader): Map<DeviceId, ClientFrameId[]> {
	const rings = new Map<DeviceId, ClientFrameId[]>();
	const n = r.varuint();
	for (let i = 0; i < n; i++) {
		const d = r.varstring() as DeviceId;
		const count = r.varuint();
		if (count < 1 || count > NS_DEDUPE_RING) throw new CodecError("ring size out of range");
		const ring: ClientFrameId[] = [];
		for (let j = 0; j < count; j++) ring.push(r.varstring() as ClientFrameId);
		rings.set(d, ring);
	}
	return rings;
}

export function writeReplay(w: Writer, replay: ReadonlyMap<DeviceId, ReplayWindow>): void {
	const devices = sortedKeys(replay);
	w.varuint(devices.length);
	for (const d of devices) {
		const win = replay.get(d)!;
		w.varstring(d).varuint(win.r).fixed(replayBitsToBytes(win.bits), REPLAY_BITS_BYTES);
	}
}

export function readReplay(r: Reader): Map<DeviceId, ReplayWindow> {
	const out = new Map<DeviceId, ReplayWindow>();
	const n = r.varuint();
	for (let i = 0; i < n; i++) {
		const d = r.varstring() as DeviceId;
		const win: ReplayWindow = { r: r.varuint(), bits: replayBitsFromBytes(r.copy(REPLAY_BITS_BYTES)) };
		if (!replayWindowValid(win)) throw new CodecError("replay window not canonical");
		out.set(d, win);
	}
	return out;
}

export function encodeNsFoldV1(state: NsFoldState): Uint8Array {
	const w = new Writer(64 + state.entries.size * 120);
	w.varuint(state.formatVersion).varuint(state.foldRulesVersion).varuint(state.coversSeq);
	const ids = sortedKeys(state.entries);
	w.varuint(ids.length);
	for (const id of ids) {
		const e = state.entries.get(id)!;
		w.varstring(e.docId).u8(docKindCode(e.kind)).u8(STATE_CODE[e.state]).varstring(e.path);
		w.varuint(e.createdSeq).varstring(e.createdBy).varuint(e.lastTouchSeq).varuint(e.deletedSeq).varuint(e.deleteBaseBodySeq);
		w.fixed(hashToBytes(e.createHash), 32).varuint(e.createSize);
		if (e.blob) w.u8(1).fixed(hashToBytes(e.blob.hash), 32).varuint(e.blob.size).varuint(e.blob.rev);
		else w.u8(0);
		if (e.aliasOf !== null) w.u8(1).varstring(e.aliasOf);
		else w.u8(0);
	}
	writeRings(w, state.recentFrames);
	writeReplay(w, state.replay);
	return w.finish();
}

function readFlag(r: Reader): boolean {
	const b = r.u8();
	if (b > 1) throw new CodecError("flag byte must be 0 or 1");
	return b === 1;
}

/** Throws CodecError on malformed bytes. */
export function decodeNsFoldV1Strict(bytes: Uint8Array): NsFoldState {
	const r = new Reader(bytes);
	const formatVersion = r.varuint();
	if (formatVersion !== NS_FOLD_FORMAT_VERSION) throw new CodecError(`unsupported nsFold formatVersion ${formatVersion}`);
	const foldRulesVersion = r.varuint();
	const coversSeq = r.varuint();
	const count = r.varuint();
	const entries = new Map<DocId, NsEntry>();
	for (let i = 0; i < count; i++) {
		const docId = r.varstring() as DocId;
		const kind = docKindFromCode(r.u8());
		const state = STATE_BY_CODE.get(r.u8());
		if (state === undefined) throw new CodecError("unknown entry state");
		const path = r.varstring();
		const createdSeq = r.varuint();
		const createdBy = r.varstring() as DeviceId;
		const lastTouchSeq = r.varuint();
		const deletedSeq = r.varuint();
		const deleteBaseBodySeq = r.varuint();
		const createHash = bytesToHash(r.copy(32));
		const createSize = r.varuint();
		let blob: NsEntry["blob"] = null;
		if (readFlag(r)) {
			const hash = bytesToHash(r.copy(32));
			const size = r.varuint();
			blob = { hash, size, rev: r.varuint() };
		}
		const aliasOf = readFlag(r) ? (r.varstring() as DocId) : null;
		entries.set(docId, {
			docId, kind, path, pathKey: pathKey(path), state, createdSeq, createdBy, lastTouchSeq,
			deletedSeq, deleteBaseBodySeq, createHash, createSize, blob, aliasOf,
		});
	}
	const recentFrames = readRings(r);
	const replay = readReplay(r);
	r.end();
	return { formatVersion: 1, foldRulesVersion, coversSeq, entries, recentFrames, replay };
}

/** null = malformed (bytes). Canonical form and invariants: src/core/ns/verify.ts. */
export function decodeNsFoldV1(bytes: Uint8Array): NsFoldState | null {
	try {
		return decodeNsFoldV1Strict(bytes);
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}
