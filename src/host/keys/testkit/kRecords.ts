/**
 * TEST ONLY (testkit/: never imported by product code). Shape-valid `k` records with filler bytes for the reader
 * and pin tests: what a device that enabled E2EE would have appended (e2ee-design §11.1), minus real cryptography
 * (the E4 reader only decodes; verifying is WP-E3's keyring runtime).
 */

import { encodeKeyRecord, KCV_LEN, KeyRecordKind, newKeyRecord, WRAP_LEN } from "../../../engine/keyring/record";

/** An encoded genesis record (e 1, recovery wrap only). `fill` varies the filler bytes. */
export function fakeGenesisRecord(fill = 0x5a): Uint8Array {
	return encodeKeyRecord(newKeyRecord(1, KeyRecordKind.genesis, new Uint8Array(KCV_LEN).fill(fill), { recovery: new Uint8Array(WRAP_LEN).fill(fill ^ 0xff) }));
}

/** A 32-byte epoch key made of `fill` (stand-in key material: distinctive, so a leak scan can find it). */
export function fakeEpochKey(fill: number): Uint8Array {
	const k = new Uint8Array(32);
	for (let i = 0; i < k.length; i++) k[i] = (fill + i * 37) & 0xff;
	return k;
}
