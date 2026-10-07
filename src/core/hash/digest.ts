/**
 * Content hashing through HashPort (WebCrypto in the engine, off the engine thread's critical path): every
 * file, blob, canvas, config, snapshot and brake digest goes through here. Core's pure-JS sha256 takes only
 * inputs up to SYNC_HASH_MAX_BYTES (core/hash/sha256.ts).
 */

import type { HashPort } from "../../ports/crypto";
import { toHex } from "./sha256";

/** Lowercase hex SHA-256 of `bytes`. */
export async function digestHex(hash: HashPort, bytes: Uint8Array): Promise<string> {
	return toHex(await hash.sha256(bytes));
}
