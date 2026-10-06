/**
 * snapFoldV1: canonical SnapFoldState bytes (checkpoint encoding of the `snap` stream, DESIGN §b.5 / §j.4).
 *
 *   varuint formatVersion (= 1)
 *   varuint coversSeq
 *   varuint floorCount,  floorCount x (ascending deviceId): varstring deviceId, varuint createdAtMs (> 0)
 *   varuint delCount,    delCount x (ascending key):        varstring deviceId, varstring snapshotId
 *   varuint recordCount, recordCount x (ascending key):     varstring deviceId, varbytes putBody (encodeSnapRecord)
 *
 * key = deviceId + "/" + snapshotId. Decoding is strict (every id, record and bound is checked); the gate
 * additionally requires the canonical re-encode to be byte-identical, so ordering and duplicates are rejected.
 */

import type { DeviceId } from "../types";
import type { SnapFoldState } from "../snap/fold";
import { decodeSnapRecord, encodeSnapRecord, isDeviceId, parseSnapshotId, snapKey } from "../snap/record";
import { CodecError, Reader, Writer, compareCodeUnits } from "./lib0";

export const SNAP_FOLD_FORMAT_VERSION = 1;

const byKey = <T>(m: ReadonlyMap<string, T>): string[] => [...m.keys()].sort(compareCodeUnits);

export function encodeSnapFoldV1(state: SnapFoldState): Uint8Array {
	const w = new Writer(256);
	w.varuint(state.formatVersion).varuint(state.coversSeq);
	const devices = byKey(state.floors);
	w.varuint(devices.length);
	for (const d of devices) w.varstring(d).varuint(state.floors.get(d as DeviceId)!);
	const dels = byKey(state.dels);
	w.varuint(dels.length);
	for (const k of dels) { const d = state.dels.get(k)!; w.varstring(d.deviceId).varstring(d.snapshotId); }
	const recs = byKey(state.records);
	w.varuint(recs.length);
	for (const k of recs) { const e = state.records.get(k)!; w.varstring(e.deviceId).varbytes(encodeSnapRecord(e.record)); }
	return w.finish();
}

function readDevice(r: Reader): DeviceId {
	const d = r.varstring();
	if (!isDeviceId(d)) throw new CodecError("snapFold: bad deviceId");
	return d;
}

export function decodeSnapFoldV1Strict(bytes: Uint8Array): SnapFoldState {
	const r = new Reader(bytes);
	const formatVersion = r.varuint();
	if (formatVersion !== SNAP_FOLD_FORMAT_VERSION) throw new CodecError(`unsupported snapFold formatVersion ${formatVersion}`);
	const coversSeq = r.varuint();
	const state: SnapFoldState = { formatVersion: 1, coversSeq, floors: new Map(), dels: new Map(), records: new Map() };
	for (let i = 0, n = r.varuint(); i < n; i++) {
		const d = readDevice(r);
		const f = r.varuint();
		if (f === 0 || state.floors.has(d)) throw new CodecError("snapFold: bad floor");
		state.floors.set(d, f);
	}
	for (let i = 0, n = r.varuint(); i < n; i++) {
		const deviceId = readDevice(r);
		const snapshotId = r.varstring();
		const id = parseSnapshotId(snapshotId);
		if (!id || id.createdAtMs < (state.floors.get(deviceId) ?? 0)) throw new CodecError("snapFold: bad del");
		state.dels.set(snapKey(deviceId, snapshotId), { deviceId, snapshotId });
	}
	for (let i = 0, n = r.varuint(); i < n; i++) {
		const deviceId = readDevice(r);
		const bytes = r.varbytes();
		const record = decodeSnapRecord(bytes);
		if (!record || record.createdAtMs < (state.floors.get(deviceId) ?? 0)) throw new CodecError("snapFold: bad record");
		const key = snapKey(deviceId, record.snapshotId);
		if (state.dels.has(key)) throw new CodecError("snapFold: record is deleted");
		state.records.set(key, { deviceId, record, bytes });
	}
	r.end();
	return state;
}

export function decodeSnapFoldV1(bytes: Uint8Array): SnapFoldState | null {
	try {
		return decodeSnapFoldV1Strict(bytes);
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}
