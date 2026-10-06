/**
 * HashPort for simulation and deterministic tests: core's pure-JS SHA-256,
 * resolved on a microtask (WebCrypto's digest resolves on a real thread-pool
 * callback, which would make virtual time nondeterministic).
 */

import { sha256 } from "../core/hash/sha256";
import type { HashPort } from "../ports/crypto";

export const sha256Sync = sha256;

export function simHashPort(): HashPort {
	return { sha256: (bytes) => Promise.resolve(sha256(bytes)) };
}
