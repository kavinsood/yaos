/**
 * cfgFoldV1: canonical CfgFoldState bytes (DESIGN §b.5 "same shape as
 * nsFoldV1"). Layout decided by WP-A:
 *
 *   varuint formatVersion (= 1)
 *   varuint coversSeq
 *   varuint deviceCount, deviceCount x (ascending deviceId)
 *     varstring deviceId, varuint n (1..64), n x varstring clientFrameId (oldest first)
 *   varuint jsonCount,   jsonCount x (ascending key = file + "\0" + topLevelKey)
 *     varstring key, u8 present, [varstring valueJson], version
 *   varuint fileCount,   fileCount x (ascending path)
 *     varstring path, u8 present, [u8 contentTag, (varbytes | 32B hash, varuint size), varstring pluginVersion ("" = null)], version
 *   varuint pluginCount, pluginCount x (ascending id)
 *     varstring pluginId, u8 present, [u8 enabled], version
 *   version = varuint seq, varuint index, varstring deviceId
 */

import type { CfgFileContent, CfgFoldState, CfgRegister, CfgVersion, ConfigRelPath, DeviceId } from "../types";
import { CodecError, Reader, Writer } from "./lib0";
import { readRings, sortedKeys, writeRings } from "./nsFoldV1";
import { readCfgFileContent, writeCfgFileContent } from "./cfgOps";

export const CFG_FOLD_FORMAT_VERSION = 1;

type FileValue = { readonly content: CfgFileContent; readonly pluginVersion: string | null };

function writeVersion(w: Writer, v: CfgVersion): void {
	w.varuint(v.seq).varuint(v.index).varstring(v.deviceId);
}
function readVersion(r: Reader): CfgVersion {
	const seq = r.varuint();
	const index = r.varuint();
	return { seq, index, deviceId: r.varstring() as DeviceId };
}

function writeSection<T>(w: Writer, m: ReadonlyMap<string, CfgRegister<T>>, writeValue: (w: Writer, v: T) => void): void {
	const keys = sortedKeys(m);
	w.varuint(keys.length);
	for (const k of keys) {
		const reg = m.get(k)!;
		w.varstring(k);
		if (reg.value === null) w.u8(0);
		else { w.u8(1); writeValue(w, reg.value); }
		writeVersion(w, reg.version);
	}
}

function readSection<T>(r: Reader, readValue: (r: Reader) => T): Map<string, CfgRegister<T>> {
	const m = new Map<string, CfgRegister<T>>();
	const n = r.varuint();
	for (let i = 0; i < n; i++) {
		const k = r.varstring();
		const present = r.u8();
		if (present > 1) throw new CodecError("present byte must be 0 or 1");
		const value = present === 1 ? readValue(r) : null;
		m.set(k, { value, version: readVersion(r) });
	}
	return m;
}

export function encodeCfgFoldV1(state: CfgFoldState): Uint8Array {
	const w = new Writer(256);
	w.varuint(state.formatVersion).varuint(state.coversSeq);
	writeRings(w, state.recentFrames);
	writeSection(w, state.json, (w, v) => { w.varstring(v); });
	writeSection<FileValue>(w, state.files, (w, v) => {
		writeCfgFileContent(w, v.content);
		w.varstring(v.pluginVersion ?? "");
	});
	writeSection(w, state.plugins, (w, v) => { w.u8(v ? 1 : 0); });
	return w.finish();
}

export function decodeCfgFoldV1Strict(bytes: Uint8Array): CfgFoldState {
	const r = new Reader(bytes);
	const formatVersion = r.varuint();
	if (formatVersion !== CFG_FOLD_FORMAT_VERSION) throw new CodecError(`unsupported cfgFold formatVersion ${formatVersion}`);
	const coversSeq = r.varuint();
	const recentFrames = readRings(r);
	const json = readSection(r, (r) => r.varstring());
	const files = readSection<FileValue>(r, (r) => {
		const content = readCfgFileContent(r);
		const pv = r.varstring();
		return { content, pluginVersion: pv === "" ? null : pv };
	}) as Map<ConfigRelPath, CfgRegister<FileValue>>;
	const plugins = readSection(r, (r) => {
		const b = r.u8();
		if (b > 1) throw new CodecError("enabled byte must be 0 or 1");
		return b === 1;
	});
	r.end();
	return { formatVersion: 1, coversSeq, recentFrames, json, files, plugins };
}

export function decodeCfgFoldV1(bytes: Uint8Array): CfgFoldState | null {
	try {
		return decodeCfgFoldV1Strict(bytes);
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}
