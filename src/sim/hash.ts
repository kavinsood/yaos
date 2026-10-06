/**
 * HashPort for simulation and deterministic tests: core's pure-JS SHA-256,
 * resolved on a microtask (WebCrypto's digest resolves on a real thread-pool
 * callback, which would make virtual time nondeterministic).
 */

import { sha256 } from "../core/hash/sha256";
import type { HashPort } from "../ports/crypto";
import { hashItems } from "../engine/compose/hashService";
import type { HashOracle } from "../host/hashOracle";

export const sha256Sync = sha256;

export function simHashPort(): HashPort {
	return { sha256: (bytes) => Promise.resolve(sha256(bytes)) };
}

/**
 * HashOracle for the simulated host: the same contract as host/hashOracle.ts engineHashOracle, answered
 * in-process by the engine's hash service (the sim plays the engine side). Item bytes are moved like a
 * [T] transfer (the caller's buffer is detached when it owns it), so sim callers cannot rely on reuse.
 */
export function simHashOracle(): HashOracle {
	const hash = simHashPort();
	return {
		hash: (items) =>
			hashItems(items.map((it) => ({ path: it.path, want: it.want, bytes: moved(it.bytes) })), { hash, yieldNow: () => Promise.resolve() }),
	};
}

function moved(bytes: Uint8Array): Uint8Array {
	const ownsBuffer = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
	return ownsBuffer ? structuredClone(bytes, { transfer: [bytes.buffer as ArrayBuffer] }) : bytes.slice();
}
