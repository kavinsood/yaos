/**
 * Host-side hashing for write preconditions and bound-save fingerprints.
 *
 * DiskFingerprint = sha256(exact bytes). ContentHash = logical hash:
 * markdown-lf-v1 canonical bytes for markdown (strip one BOM, CRLF/CR -> LF),
 * exact bytes for blobs.
 *
 * INTEGRATION: canvas logical hash must become WP-B's
 * core/hash/canvasCanonical.canvasContentHash; until then canvas hashes its
 * exact bytes (a "hash" precondition on a canvas file only passes when the
 * engine computed the hash the same way).
 */

import type { ContentHash, DiskFingerprint } from "../core/types";
import { kindOfPath } from "../core/types";
import type { HashPort } from "../ports/crypto";

export interface Hasher {
	fingerprint(bytes: Uint8Array): Promise<DiskFingerprint>;
	contentHash(path: string, bytes: Uint8Array): Promise<ContentHash>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(text: string): Uint8Array {
	return encoder.encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, "0");
	return out;
}

/** markdown-lf-v1 (ported from server/src/shared/markdownCodec.ts). */
export function canonicalizeMarkdown(content: string): string {
	const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
	return withoutBom.replace(/\r\n?/g, "\n");
}

export function createHasher(hash: HashPort): Hasher {
	return {
		async fingerprint(bytes) {
			return toHex(await hash.sha256(bytes)) as DiskFingerprint;
		},
		async contentHash(path, bytes) {
			if (kindOfPath(path) === "markdown") {
				return toHex(await hash.sha256(utf8(canonicalizeMarkdown(fromUtf8(bytes))))) as ContentHash;
			}
			return toHex(await hash.sha256(bytes)) as ContentHash;
		},
	};
}

/** WebCrypto HashPort (main thread and worker). */
export function webCryptoHashPort(): HashPort {
	return {
		async sha256(bytes) {
			const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
			return new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
		},
	};
}
