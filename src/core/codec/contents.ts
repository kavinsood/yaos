/**
 * Small kind-specific contents (DESIGN §b.4, §b.5): checkpoint, blobChunk,
 * bodyUpdateRef. Decoders return null on malformed input.
 *
 * Decisions: unknown CheckpointEncoding -> malformed; blobChunk requires
 * total >= 1 and index < total; bodyUpdateRef rejects trailing bytes.
 */

import {
	CheckpointEncoding,
	type BlobChunkContent,
	type BodyUpdateRefContent,
	type CheckpointContent,
} from "../envelope";
import { CodecError, Reader, Writer } from "./lib0";
import { bytesToHash, hashToBytes } from "./ids";

const ENCODINGS = new Set<number>(Object.values(CheckpointEncoding));

function guard<T>(fn: () => T): T | null {
	try {
		return fn();
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}

export function encodeCheckpointContent(c: CheckpointContent): Uint8Array {
	if (!ENCODINGS.has(c.encoding)) throw new CodecError(`unknown checkpoint encoding ${c.encoding}`);
	return new Writer(c.state.length + 24).u8(c.encoding).varuint(c.coversSeq).varuint(c.foldRulesVersion).raw(c.state).finish();
}

export function decodeCheckpointContent(bytes: Uint8Array): CheckpointContent | null {
	return guard(() => {
		const r = new Reader(bytes);
		const encoding = r.u8();
		if (!ENCODINGS.has(encoding)) throw new CodecError("unknown checkpoint encoding");
		const coversSeq = r.varuint();
		const foldRulesVersion = r.varuint();
		return { encoding: encoding as CheckpointEncoding, coversSeq, foldRulesVersion, state: r.rest() };
	});
}

export function encodeBlobChunk(c: BlobChunkContent): Uint8Array {
	if (c.total < 1 || c.index >= c.total) throw new CodecError("blob chunk index out of range");
	return new Writer(c.chunk.length + 64)
		.fixed(hashToBytes(c.hash), 32)
		.varuint(c.index)
		.varuint(c.total)
		.varuint(c.totalSize)
		.raw(c.chunk)
		.finish();
}

export function decodeBlobChunk(bytes: Uint8Array): BlobChunkContent | null {
	return guard(() => {
		const r = new Reader(bytes);
		const hash = bytesToHash(r.copy(32));
		const index = r.varuint();
		const total = r.varuint();
		const totalSize = r.varuint();
		if (total < 1 || index >= total) throw new CodecError("blob chunk index out of range");
		return { hash, index, total, totalSize, chunk: r.rest() };
	});
}

export function encodeBodyUpdateRef(c: BodyUpdateRefContent): Uint8Array {
	return new Writer(48).fixed(hashToBytes(c.hash), 32).varuint(c.size).finish();
}

export function decodeBodyUpdateRef(bytes: Uint8Array): BodyUpdateRefContent | null {
	return guard(() => {
		const r = new Reader(bytes);
		const hash = bytesToHash(r.copy(32));
		const size = r.varuint();
		r.end();
		return { hash, size };
	});
}
