/**
 * cfgOps content codec (DESIGN §b.4). Same framing and malformation rules as
 * nsOps (null = malformed frame, folded as empty).
 *
 *   jsonSet(1):   varstring file, varstring key, varstring valueJson
 *   jsonDel(2):   varstring file, varstring key
 *   filePut(3):   varstring file, u8 contentTag, (tag 1: varbytes bytes | tag 2: 32B hash, varuint size),
 *                 varstring pluginVersion ("" = null)
 *   fileDel(4):   varstring file
 *   pluginSet(5): varstring pluginId, u8 enabled
 *   pluginDel(6): varstring pluginId
 *
 * Decisions: contentTag outside {1,2} and enabled outside {0,1} are malformed.
 */

import type { CfgFileContent, CfgOp } from "../types";
import { CfgOpTag } from "../envelope";
import { MAX_NS_OPS_PER_FRAME } from "../limits";
import { CodecError, Reader, Writer } from "./lib0";
import { bytesToHash, hashToBytes } from "./ids";
import { decodeTaggedOps } from "./nsOps";

export const CfgContentTag = { inline: 1, blob: 2 } as const;

export function writeCfgFileContent(w: Writer, c: CfgFileContent): void {
	if (c.t === "inline") w.u8(CfgContentTag.inline).varbytes(c.bytes);
	else w.u8(CfgContentTag.blob).fixed(hashToBytes(c.hash), 32).varuint(c.size);
}

export function readCfgFileContent(r: Reader): CfgFileContent {
	const tag = r.u8();
	if (tag === CfgContentTag.inline) return { t: "inline", bytes: r.varbytes() };
	if (tag === CfgContentTag.blob) {
		const hash = bytesToHash(r.copy(32));
		return { t: "blob", hash, size: r.varuint() };
	}
	throw new CodecError(`unknown cfg content tag ${tag}`);
}

function encodeOpBody(op: CfgOp): { tag: number; body: Uint8Array } {
	const w = new Writer(64);
	switch (op.t) {
		case "jsonSet":
			w.varstring(op.file).varstring(op.key).varstring(op.valueJson);
			return { tag: CfgOpTag.jsonSet, body: w.finish() };
		case "jsonDel":
			w.varstring(op.file).varstring(op.key);
			return { tag: CfgOpTag.jsonDel, body: w.finish() };
		case "filePut":
			w.varstring(op.file);
			writeCfgFileContent(w, op.content);
			w.varstring(op.pluginVersion ?? "");
			return { tag: CfgOpTag.filePut, body: w.finish() };
		case "fileDel":
			w.varstring(op.file);
			return { tag: CfgOpTag.fileDel, body: w.finish() };
		case "pluginSet":
			w.varstring(op.pluginId).u8(op.enabled ? 1 : 0);
			return { tag: CfgOpTag.pluginSet, body: w.finish() };
		case "pluginDel":
			w.varstring(op.pluginId);
			return { tag: CfgOpTag.pluginDel, body: w.finish() };
	}
}

export function encodeCfgOps(ops: readonly CfgOp[]): Uint8Array {
	if (ops.length < 1 || ops.length > MAX_NS_OPS_PER_FRAME) throw new CodecError(`cfg opCount ${ops.length} out of range`);
	const w = new Writer(ops.length * 64);
	w.varuint(ops.length);
	for (const op of ops) {
		const { tag, body } = encodeOpBody(op);
		w.u8(tag).varbytes(body);
	}
	return w.finish();
}

function decodeOpBody(tag: number, r: Reader): CfgOp {
	switch (tag) {
		case CfgOpTag.jsonSet: {
			const file = r.varstring();
			const key = r.varstring();
			return { t: "jsonSet", file, key, valueJson: r.varstring() };
		}
		case CfgOpTag.jsonDel: {
			const file = r.varstring();
			return { t: "jsonDel", file, key: r.varstring() };
		}
		case CfgOpTag.filePut: {
			const file = r.varstring();
			const content = readCfgFileContent(r);
			const pv = r.varstring();
			return { t: "filePut", file, content, pluginVersion: pv === "" ? null : pv };
		}
		case CfgOpTag.fileDel:
			return { t: "fileDel", file: r.varstring() };
		case CfgOpTag.pluginSet: {
			const pluginId = r.varstring();
			const e = r.u8();
			if (e > 1) throw new CodecError("pluginSet enabled must be 0 or 1");
			return { t: "pluginSet", pluginId, enabled: e === 1 };
		}
		case CfgOpTag.pluginDel:
			return { t: "pluginDel", pluginId: r.varstring() };
		default:
			throw new CodecError(`unknown cfg op tag ${tag}`);
	}
}

/** null = malformed frame (fold it as an empty frame). */
export function decodeCfgOps(content: Uint8Array): CfgOp[] | null {
	return decodeTaggedOps(content, decodeOpBody);
}
