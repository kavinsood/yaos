/**
 * The engine's one write gate (e2ee-design §9.3, §12.4 "Fail closed"). While the keyring reports a key-missing
 * reason nothing is sealed and no blob is uploaded; the sender holds the outbox and maintenance writes no
 * checkpoint (keyringRuntime.ts, maintenance.ts). Every seal in the engine goes through gatedCrypto, so a code
 * path that forgets to ask still cannot produce a frame, a checkpoint or a sealed blob.
 */

import type { KeyMissingReason } from "../../protocol/status";
import type { BlobPort } from "../../ports/blob";
import type { CryptoPort, KeyringCrypto } from "../../ports/crypto";

export class KeyMissingError extends Error {
	constructor(readonly reason: KeyMissingReason) {
		super(`key-missing: ${reason} (this device writes nothing until the vault key is settled)`);
		this.name = "KeyMissingError";
	}
}

/** A key or pin command the keyring's state does not allow (§12.4, §18.4); answered with the `refused` code. */
export class KeyringRefusedError extends Error {
	constructor(message: string) {
		super(`e2ee: refused: ${message}`);
		this.name = "KeyringRefusedError";
	}
}

export type GateFn = () => KeyMissingReason | null;

export function assertWritable(gate: GateFn): void {
	const r = gate();
	if (r !== null) throw new KeyMissingError(r);
}

/** `inner` with seal / sealBlob refused while the gate is shut. onSeal counts own seals (the §4.2 roll trigger). */
export function gatedCrypto(inner: CryptoPort, gate: GateFn, onSeal: () => void): CryptoPort {
	return {
		get suite() {
			return inner.suite;
		},
		sealEpoch: () => inner.sealEpoch(),
		keyState: (e) => inner.keyState(e),
		seal: async (input) => {
			assertWritable(gate);
			onSeal();
			return inner.seal(input);
		},
		open: (input) => inner.open(input),
		sealBlob: async (input) => {
			assertWritable(gate);
			onSeal();
			return inner.sealBlob(input);
		},
		openBlob: (input) => inner.openBlob(input),
		blobAddress: (hash) => inner.blobAddress(hash),
		diagHash: (bytes) => inner.diagHash(bytes),
	};
}

/** `inner` with put and delete refused while the gate is shut (has / get / list stay: reading is allowed). */
export function gatedBlob(inner: BlobPort | null, gate: GateFn): BlobPort | null {
	if (!inner) return null;
	return {
		get maxBlobBytes() {
			return inner.maxBlobBytes;
		},
		has: (a, signal) => inner.has(a, signal),
		put: async (address, parts, signal) => {
			assertWritable(gate);
			return inner.put(address, parts, signal);
		},
		get: (a, signal) => inner.get(a, signal),
		list: (cursor, signal) => inner.list(cursor, signal),
		deleteIfUploadedBefore: async (addresses, cutoffMs, signal) => {
			assertWritable(gate);
			return inner.deleteIfUploadedBefore(addresses, cutoffMs, signal);
		},
	};
}

/** A suite-1 adapter (createWebCryptoSuite1) implements both ports; the noop suite-0 adapter does not. */
export function keyringCryptoOf(p: CryptoPort): (CryptoPort & KeyringCrypto) | null {
	const k = p as Partial<KeyringCrypto>;
	return typeof k.generate === "function" && typeof k.unwrap === "function" && typeof k.exportForHost === "function" ? (p as CryptoPort & KeyringCrypto) : null;
}
