/**
 * Identifiers (DESIGN §b.2, §g.3): docId and clientFrameId are 16 random
 * bytes, base64url without padding (22 chars). Content hashes are lowercase
 * hex SHA-256 in types and 32 raw bytes on the wire.
 * Ported from the old client's utils/randomId.ts, reworked to 16-byte base64url.
 */

import type { ClientFrameId, ContentHash, DocId } from "../types";
import type { RandomPort } from "../../ports/random";
import { CodecError, bytesToHex, hexToBytes } from "./lib0";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export function base64urlEncode(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
	}
	const rem = bytes.length - i;
	if (rem === 1) {
		const n = bytes[i]! << 16;
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
	} else if (rem === 2) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
		out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
	}
	return out;
}

export function base64urlDecode(s: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new CodecError("invalid base64url");
	const out = new Uint8Array(Math.floor((s.length * 3) / 4));
	let o = 0;
	let acc = 0;
	let bits = 0;
	for (let i = 0; i < s.length; i++) {
		acc = (acc << 6) | B64URL.indexOf(s[i]!);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (acc >> bits) & 0xff;
		}
	}
	return out.subarray(0, o);
}

/** 22-char base64url string (DESIGN §b.3 malformation rule). */
export function isIdString(s: string): boolean {
	return ID_RE.test(s);
}
export function isDocId(s: string): s is DocId {
	return ID_RE.test(s);
}
export function isClientFrameId(s: string): s is ClientFrameId {
	return ID_RE.test(s);
}

export function newId(random: RandomPort): string {
	const bytes = random.bytes(16);
	if (bytes.length !== 16) throw new Error("RandomPort.bytes returned the wrong length");
	return base64urlEncode(bytes);
}
export function newDocId(random: RandomPort): DocId {
	return newId(random) as DocId;
}
export function newClientFrameId(random: RandomPort): ClientFrameId {
	return newId(random) as ClientFrameId;
}

export function isContentHash(s: string): s is ContentHash {
	return HASH_RE.test(s);
}
export function hashToBytes(hash: ContentHash): Uint8Array {
	if (!HASH_RE.test(hash)) throw new CodecError("invalid content hash");
	return hexToBytes(hash);
}
export function bytesToHash(bytes: Uint8Array): ContentHash {
	if (bytes.length !== 32) throw new CodecError("hash must be 32 bytes");
	return bytesToHex(bytes) as ContentHash;
}
