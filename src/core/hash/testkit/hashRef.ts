/**
 * Reference digests for tests and the sim, of any size: node:crypto's SHA-256, synchronous. Never shipped (only
 * tests and the sim may import testkit/**, scripts/check-deps.mjs). Product code hashes through HashPort
 * (core/hash/digest.ts); core's pure-JS sha256 refuses inputs over SYNC_HASH_MAX_BYTES, and these helpers exist
 * so tests never need that guard loosened.
 */

import type { HashPort } from "../../../ports/crypto";
import type { CanvasSemanticData } from "../canvasCanonical";
import { canvasHashInput, canvasLogicalHashInput } from "../canvasCanonical";
import { markdownCanonicalBytes } from "../markdownLf";
import type { ContentHash, DiskFingerprint } from "../../types";

/** node:crypto's createHash, typed here: the source tree compiles without node's types (tsconfig.json "types": []). */
interface NodeHash {
	update(data: Uint8Array): NodeHash;
	digest(): Uint8Array;
	digest(encoding: "hex"): string;
}
const nodeCrypto = (
	globalThis as unknown as { process: { getBuiltinModule(id: "node:crypto"): { createHash(algorithm: "sha256"): NodeHash } } }
).process.getBuiltinModule("node:crypto");

export function sha256Ref(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(nodeCrypto.createHash("sha256").update(bytes).digest());
}

export function sha256HexRef(bytes: Uint8Array): string {
	return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/** markdownContentHash, synchronously. */
export function markdownHashRef(content: string): ContentHash {
	return sha256HexRef(markdownCanonicalBytes(content)) as ContentHash;
}

/** exactFingerprint, synchronously. */
export function fingerprintRef(bytes: Uint8Array): DiskFingerprint {
	return sha256HexRef(bytes) as DiskFingerprint;
}

/** canvasContentHash, synchronously. */
export function canvasHashRef(bytes: Uint8Array): ContentHash {
	return sha256HexRef(canvasHashInput(bytes)) as ContentHash;
}

/** canvasLogicalHash, synchronously. */
export function canvasLogicalHashRef(data: CanvasSemanticData): ContentHash {
	return sha256HexRef(canvasLogicalHashInput(data)) as ContentHash;
}

/** A HashPort over sha256Ref, resolved on a microtask (deterministic under virtual time, unlike WebCrypto's thread pool). */
export const refHashPort: HashPort = { sha256: (bytes) => Promise.resolve(sha256Ref(bytes)) };
