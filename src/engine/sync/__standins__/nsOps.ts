/**
 * STAND-IN for WP-A src/core/codec/nsOps.ts. Replace at integration. Layout: DESIGN §b.3.
 */

import { DocKindCode, NsOpTag } from "../../../core/envelope";
import { MAX_NS_OPS_PER_FRAME } from "../../../core/limits";
import type { ContentHash, DocId, DocKind, NsOp } from "../../../core/types";
import { CodecError, Reader, Writer, fromHex, toHex } from "./bytes";
import { isId } from "./ids";

const KIND_CODE: Record<DocKind, number> = { markdown: DocKindCode.markdown, canvas: DocKindCode.canvas, blob: DocKindCode.blob };
const KIND_BY_CODE = new Map<number, DocKind>([[1, "markdown"], [2, "canvas"], [3, "blob"]]);

function encodeOpBody(op: NsOp): { tag: number; body: Uint8Array } {
	const w = new Writer();
	switch (op.t) {
		case "create":
			w.varstring(op.docId).u8(KIND_CODE[op.kind]).varstring(op.path).bytes(fromHex(op.contentHash)).varuint(op.size);
			return { tag: NsOpTag.create, body: w.finish() };
		case "rename":
			w.varstring(op.docId).varstring(op.path);
			return { tag: NsOpTag.rename, body: w.finish() };
		case "delete":
			w.varstring(op.docId).varuint(op.baseBodySeq);
			return { tag: NsOpTag.delete, body: w.finish() };
		case "restore":
			w.varstring(op.docId).varstring(op.path).varuint(op.againstDeleteSeq);
			return { tag: NsOpTag.restore, body: w.finish() };
		case "setBlob":
			w.varstring(op.docId).bytes(fromHex(op.hash)).varuint(op.size).varuint(op.baseRev);
			return { tag: NsOpTag.setBlob, body: w.finish() };
		case "upgradeRules":
			w.varuint(op.version);
			return { tag: NsOpTag.upgradeRules, body: w.finish() };
	}
}

export function encodeNsOps(ops: readonly NsOp[]): Uint8Array {
	if (ops.length < 1 || ops.length > MAX_NS_OPS_PER_FRAME) throw new CodecError(`opCount ${ops.length}`);
	const w = new Writer().varuint(ops.length);
	for (const op of ops) {
		const { tag, body } = encodeOpBody(op);
		w.u8(tag).varbytes(body);
	}
	return w.finish();
}

function docId(r: Reader): DocId {
	const s = r.varstring();
	if (!isId(s)) throw new CodecError("bad docId");
	return s as DocId;
}
function hash(r: Reader): ContentHash {
	return toHex(r.bytes(32)) as ContentHash;
}

/** Throws CodecError when the frame is malformed (§b.3). Trailing bytes inside an op body are ignored. */
export function decodeNsOps(bytes: Uint8Array): NsOp[] {
	const r = new Reader(bytes);
	const n = r.varuint();
	if (n < 1 || n > MAX_NS_OPS_PER_FRAME) throw new CodecError(`opCount ${n}`);
	const ops: NsOp[] = [];
	for (let i = 0; i < n; i++) {
		const tag = r.u8();
		const b = new Reader(r.varbytes());
		switch (tag) {
			case NsOpTag.create: {
				const id = docId(b);
				const kind = KIND_BY_CODE.get(b.u8());
				if (!kind) throw new CodecError("bad kindCode");
				ops.push({ t: "create", docId: id, kind, path: b.varstring(), contentHash: hash(b), size: b.varuint() });
				break;
			}
			case NsOpTag.rename:
				ops.push({ t: "rename", docId: docId(b), path: b.varstring() });
				break;
			case NsOpTag.delete:
				ops.push({ t: "delete", docId: docId(b), baseBodySeq: b.varuint() });
				break;
			case NsOpTag.restore:
				ops.push({ t: "restore", docId: docId(b), path: b.varstring(), againstDeleteSeq: b.varuint() });
				break;
			case NsOpTag.setBlob:
				ops.push({ t: "setBlob", docId: docId(b), hash: hash(b), size: b.varuint(), baseRev: b.varuint() });
				break;
			case NsOpTag.upgradeRules:
				ops.push({ t: "upgradeRules", version: b.varuint() });
				break;
			default:
				throw new CodecError(`unknown tag ${tag}`);
		}
	}
	r.end();
	return ops;
}
