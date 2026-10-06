/**
 * Seeded entropy for reproducible simulation runs.
 *
 * Yjs draws Y.Doc clientIDs (and guids) from lib0/random, which binds
 * `webcrypto.getRandomValues` once, at module load. Concurrent inserts at the
 * same position are ordered by clientID, so random clientIDs make the same
 * seed converge to different (equally valid) texts. This module replaces
 * node's `webcrypto.getRandomValues` (globalThis.crypto) with a switchable source BEFORE lib0 loads
 * (import it first; jiti keeps import order) and lets the runner seed it per
 * run. Outside a seeded run it delegates to the real CSPRNG.
 *
 * Test-only. The engine draws clientIDs the same way, so this works for the
 * real engine as long as it is imported first.
 */

import { SeededRandom } from "./random";

type Fill = <T extends ArrayBufferView | null>(array: T) => T;

// In Node >= 19 globalThis.crypto IS node:crypto's webcrypto (what lib0 binds).
const webcrypto = (globalThis as unknown as { crypto: object }).crypto;
const target = webcrypto as unknown as { getRandomValues: Fill; __yaosSeeded?: boolean };
const original: Fill = target.getRandomValues.bind(webcrypto) as Fill;
let source: SeededRandom | null = null;

if (!target.__yaosSeeded) {
	target.__yaosSeeded = true;
	target.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
		if (!source || !array) return original(array);
		const u8 = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
		u8.set(source.bytes(u8.length));
		return array;
	}) as Fill;
}

/** Seed (or with null, unseed) every subsequent getRandomValues call in this process. */
export function seedEntropy(seed: number | null): void {
	source = seed === null ? null : new SeededRandom(seed >>> 0);
}

/** True when lib0 picked up the seeded source (it was imported after this module). */
export function entropyIsSeeded(probe: () => number): boolean {
	const prev = source;
	seedEntropy(0x5eed);
	const a = probe();
	seedEntropy(0x5eed);
	const b = probe();
	source = prev;
	return a === b;
}
