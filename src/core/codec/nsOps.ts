/**
 * nsOps content codec (DESIGN §b.3).
 *
 *   varuint opCount (1..512)
 *   opCount x { u8 tag, varuint bodyLen, body[bodyLen] }
 *
 * Bytes after the known fields inside a body are ignored (forward-compatible
 * optional fields). Everything else that does not parse makes the WHOLE frame
 * malformed: decodeNsOps returns null and the caller folds it as an empty
 * frame (ops: []). Op-level problems (invalid paths, ...) are not
 * malformation; the fold ignores those ops.
 */

import type { ContentHash, DocId, DocKind, NsOp } from "../types";
import { DocKindCode, NsOpTag } from "../envelope";
import { MAX_NS_OPS_PER_FRAME } from "../limits";
import { CodecError, Reader, Writer } from "./lib0";
import { bytesToHash, hashToBytes, isDocId } from "./ids";

const KIND_BY_CODE: ReadonlyMap<number, DocKind> = new Map([
	[DocKindCode.markdown, "markdown"],
	[DocKindCode.canvas, "canvas"],
	[DocKindCode.blob, "blob"],
]);

export function docKindCode(kind: DocKind): number {
	const c = DocKindCode[kind];
	if (c === undefined) throw new CodecError(`unknown doc kind ${String(kind)}`);
	return c;
}

export function docKindFromCode(code: number): DocKind {
	const k = KIND_BY_CODE.get(code);
	if (k === undefined) throw new CodecError(`unknown kind code ${code}`);
	return k;
}

/** Reads a docId varstring; throws unless it is a 22-char base64url id. */
export function readDocId(r: Reader): DocId {
	const s = r.varstring();
	if (!isDocId(s)) throw new CodecError("invalid docId");
	return s;
}

export function writeDocId(w: Writer, docId: string): void {
	if (!isDocId(docId)) throw new CodecError(`invalid docId ${docId}`);
	w.varstring(docId);
}

function readHash(r: Reader): ContentHash {
	return bytesToHash(r.copy(32));
}

function encodeOpBody(op: NsOp): { tag: number; body: Uint8Array } {
	const w = new Writer(64);
	switch (op.t) {
		case "create":
			writeDocId(w, op.docId);
			w.u8(docKindCode(op.kind)).varstring(op.path).fixed(hashToBytes(op.contentHash), 32).varuint(op.size);
			return { tag: NsOpTag.create, body: w.finish() };
		case "rename":
			writeDocId(w, op.docId);
			w.varstring(op.path);
			return { tag: NsOpTag.rename, body: w.finish() };
		case "delete":
			writeDocId(w, op.docId);
			w.varuint(op.baseBodySeq);
			return { tag: NsOpTag.delete, body: w.finish() };
		case "restore":
			writeDocId(w, op.docId);
			w.varstring(op.path).varuint(op.againstDeleteSeq);
			return { tag: NsOpTag.restore, body: w.finish() };
		case "setBlob":
			writeDocId(w, op.docId);
			w.fixed(hashToBytes(op.hash), 32).varuint(op.size).varuint(op.baseRev);
			return { tag: NsOpTag.setBlob, body: w.finish() };
		case "upgradeRules":
			w.varuint(op.version);
			return { tag: NsOpTag.upgradeRules, body: w.finish() };
	}
}

/** Throws CodecError for an unencodable op list (count out of range, bad docId/hash, lone surrogate). */
export function encodeNsOps(ops: readonly NsOp[]): Uint8Array {
	if (ops.length < 1 || ops.length > MAX_NS_OPS_PER_FRAME) throw new CodecError(`ns opCount ${ops.length} out of range`);
	const w = new Writer(ops.length * 96);
	w.varuint(ops.length);
	for (const op of ops) {
		const { tag, body } = encodeOpBody(op);
		w.u8(tag).varbytes(body);
	}
	return w.finish();
}

function decodeOpBody(tag: number, r: Reader): NsOp {
	switch (tag) {
		case NsOpTag.create: {
			const docId = readDocId(r);
			const kind = docKindFromCode(r.u8());
			const path = r.varstring();
			const contentHash = readHash(r);
			const size = r.varuint();
			return { t: "create", docId, kind, path, contentHash, size };
		}
		case NsOpTag.rename:
			return { t: "rename", docId: readDocId(r), path: r.varstring() };
		case NsOpTag.delete:
			return { t: "delete", docId: readDocId(r), baseBodySeq: r.varuint() };
		case NsOpTag.restore: {
			const docId = readDocId(r);
			const path = r.varstring();
			return { t: "restore", docId, path, againstDeleteSeq: r.varuint() };
		}
		case NsOpTag.setBlob: {
			const docId = readDocId(r);
			const hash = readHash(r);
			const size = r.varuint();
			return { t: "setBlob", docId, hash, size, baseRev: r.varuint() };
		}
		case NsOpTag.upgradeRules:
			return { t: "upgradeRules", version: r.varuint() };
		default:
			throw new CodecError(`unknown ns op tag ${tag}`);
	}
}

/** Generic `{opCount, {u8 tag, varuint bodyLen, body}*}` frame walker shared by nsOps and cfgOps. */
export function decodeTaggedOps<T>(content: Uint8Array, decodeBody: (tag: number, body: Reader) => T): T[] | null {
	try {
		const r = new Reader(content);
		const count = r.varuint();
		if (count < 1 || count > MAX_NS_OPS_PER_FRAME) return null;
		const ops: T[] = [];
		for (let i = 0; i < count; i++) {
			const tag = r.u8();
			const body = new Reader(r.raw(r.varuint()));
			ops.push(decodeBody(tag, body)); // trailing bytes inside the body are ignored
		}
		r.end();
		return ops;
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}

/** null = malformed frame (fold it as an empty frame, DESIGN §b.3). */
export function decodeNsOps(content: Uint8Array): NsOp[] | null {
	return decodeTaggedOps(content, decodeOpBody);
}
