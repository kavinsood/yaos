/**
 * STAND-IN for WP-A src/core/codec/envelope.ts (+ checkpoint / bodyUpdateRef
 * content codecs). Replace at integration. Layout: DESIGN §b.1, §b.4, §b.5.
 */

import { Inflate, deflateSync } from "fflate";
import {
	AAD_CHECKPOINT_PREFIX, AAD_FRAME_PREFIX, CheckpointEncoding, EnvelopeFlag, EnvelopeKindCode, ENVELOPE_FORMAT_VERSION,
	type BodyUpdateRefContent, type CheckpointContent, type CryptoSuite, type EnvelopeHeader, type EnvelopeKind, type InnerEnvelope,
} from "../../../core/envelope";
import type { ClientFrameId, ContentHash, Seq, StreamName, VaultId } from "../../../core/types";
import { CodecError, Reader, Writer, fromHex, toHex, utf8 } from "./bytes";

/** Deflate when content >= this and the saving is >= 10 % (DESIGN §b.1). */
export const DEFLATE_MIN_BYTES = 4096;
/** Hard cap on inflated content (bomb guard). Checkpoint states may be large. */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

const KIND_BY_CODE = new Map<number, EnvelopeKind>(
	(Object.keys(EnvelopeKindCode) as EnvelopeKind[]).map((k) => [EnvelopeKindCode[k], k]),
);

export function frameAad(vaultId: VaultId, stream: StreamName, clientFrameId: ClientFrameId): Uint8Array {
	return new Writer().bytes(utf8(AAD_FRAME_PREFIX)).varstring(vaultId).varstring(stream).varstring(clientFrameId).finish();
}
export function checkpointAad(vaultId: VaultId, stream: StreamName, coversSeq: Seq): Uint8Array {
	return new Writer().bytes(utf8(AAD_CHECKPOINT_PREFIX)).varstring(vaultId).varstring(stream).varuint(coversSeq).finish();
}

/**
 * Inner envelope bytes. `content` is raw (uncompressed); the deflate flag is
 * decided here and must not be passed in. Returns the bytes and the final flags.
 */
export function encodeInner(kind: EnvelopeKind, authorNsSeq: Seq, flags: number, content: Uint8Array): { bytes: Uint8Array; flags: number } {
	let f = flags & ~EnvelopeFlag.deflate;
	let body = content;
	if (content.length >= DEFLATE_MIN_BYTES) {
		const d = deflateSync(content, { level: 6 });
		if (d.length <= content.length * 0.9) {
			body = d;
			f |= EnvelopeFlag.deflate;
		}
	}
	const bytes = new Writer().u8(EnvelopeKindCode[kind]).varuint(authorNsSeq).varuint(f).bytes(body).finish();
	return { bytes, flags: f };
}

/** Decodes inner bytes; content is returned inflated, flags keep the deflate bit as sealed. Throws CodecError. */
export function decodeInner(bytes: Uint8Array): InnerEnvelope {
	const r = new Reader(bytes);
	const code = r.u8();
	const kind = KIND_BY_CODE.get(code);
	if (kind === undefined) throw new CodecError(`unknown kind ${code}`);
	const authorNsSeq = r.varuint();
	const flags = r.varuint();
	let content = r.rest();
	if (flags & EnvelopeFlag.deflate) content = inflateBounded(content, MAX_INFLATED_BYTES);
	return { kind, authorNsSeq, flags, content: content.slice() };
}

export function inflateBounded(data: Uint8Array, max: number): Uint8Array {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let failed: Error | null = null;
	const inf = new Inflate((chunk) => {
		total += chunk.length;
		if (total > max) failed = new CodecError("inflated content too large");
		else chunks.push(chunk);
	});
	try {
		inf.push(data, true);
	} catch {
		throw new CodecError("bad deflate stream");
	}
	if (failed) throw failed;
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

export function encodeOuter(header: EnvelopeHeader, sealed: Uint8Array): Uint8Array {
	return new Writer().u8(header.formatVersion).u8(header.suite).varuint(header.keyEpoch).bytes(sealed).finish();
}

/** Throws CodecError on truncation. Unknown versions/suites are returned for the caller to classify. */
export function decodeOuter(bytes: Uint8Array): { header: EnvelopeHeader; sealed: Uint8Array } {
	const r = new Reader(bytes);
	const formatVersion = r.u8();
	const suite = r.u8() as CryptoSuite;
	const keyEpoch = r.varuint();
	return { header: { formatVersion, suite, keyEpoch }, sealed: r.rest() };
}

export const CURRENT_FORMAT_VERSION = ENVELOPE_FORMAT_VERSION;

const ENCODINGS = new Set<number>(Object.values(CheckpointEncoding));

export function encodeCheckpointContent(c: CheckpointContent): Uint8Array {
	return new Writer().u8(c.encoding).varuint(c.coversSeq).varuint(c.foldRulesVersion).bytes(c.state).finish();
}
export function decodeCheckpointContent(bytes: Uint8Array): CheckpointContent {
	const r = new Reader(bytes);
	const encoding = r.u8();
	if (!ENCODINGS.has(encoding)) throw new CodecError(`unknown checkpoint encoding ${encoding}`);
	const coversSeq = r.varuint();
	const foldRulesVersion = r.varuint();
	return { encoding: encoding as CheckpointContent["encoding"], coversSeq, foldRulesVersion, state: r.rest() };
}

export function encodeBodyRef(ref: BodyUpdateRefContent): Uint8Array {
	return new Writer().bytes(fromHex(ref.hash)).varuint(ref.size).finish();
}
export function decodeBodyRef(bytes: Uint8Array): BodyUpdateRefContent {
	const r = new Reader(bytes);
	const hash = toHex(r.bytes(32)) as ContentHash;
	const size = r.varuint();
	r.end();
	return { hash, size };
}
