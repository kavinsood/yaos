/**
 * k records (e2ee-design §11.1) and their wrap AAD (§11.2).
 *
 *   u8 recordFormat = 1 ‖ u8 cryptoSuite = 1 ‖ varuint e (≥ 1) ‖ u8 kind ‖ varuint prevEpoch
 *   ‖ bytes16 kcv ‖ varbytes nextWrap ‖ varbytes prevWrap ‖ varbytes recoveryWrap
 *
 * kind 1 genesis (e 1, prevEpoch 0, recoveryWrap), 2 roll (prevEpoch e − 1, nextWrap + prevWrap),
 * 3 revoke (prevEpoch e − 1, prevWrap + recoveryWrap). Absent wraps are empty; present ones are
 * nonce(12) ‖ ct(32) ‖ tag(16). Decoding is canonical: anything else (trailing bytes, a wrap in the
 * wrong field, a bad length) is not a record, so one record has exactly one encoding.
 */

import { AAD_KEYRING_PREFIX } from "../../core/envelope";
import { CodecError, Reader, Writer, bytesEqual, utf8Encode } from "../../core/codec/lib0";
import type { WrapRole } from "../../ports/crypto";

export const KEY_RECORD_FORMAT = 1;
export const KEY_RECORD_SUITE = 1;
export const KCV_LEN = 16;
export const WRAP_LEN = 60;
/** Gate cap for a k payload: a record is at most 2 + 9 + 1 + 9 + 16 + 3 × 61 = 220 bytes. */
export const KEY_RECORD_MAX_BYTES = 256;

export const KeyRecordKind = { genesis: 1, roll: 2, revoke: 3 } as const;
export type KeyRecordKind = (typeof KeyRecordKind)[keyof typeof KeyRecordKind];

const ROLE_CODE: Readonly<Record<WrapRole, number>> = { next: 1, prev: 2, recovery: 3 };

export interface KeyRecord {
	readonly e: number;
	readonly kind: KeyRecordKind;
	/** 0 for genesis, else e − 1. */
	readonly prevEpoch: number;
	readonly kcv: Uint8Array;
	readonly nextWrap: Uint8Array;
	readonly prevWrap: Uint8Array;
	readonly recoveryWrap: Uint8Array;
}

const EMPTY = new Uint8Array(0);

/** Which wraps a kind carries (§11.1 table). */
export function wrapsOf(kind: KeyRecordKind): { readonly next: boolean; readonly prev: boolean; readonly recovery: boolean } {
	return { next: kind === KeyRecordKind.roll, prev: kind !== KeyRecordKind.genesis, recovery: kind !== KeyRecordKind.roll };
}

function wrapOk(w: Uint8Array, present: boolean): boolean {
	return present ? w.length === WRAP_LEN : w.length === 0;
}

function shapeOk(r: KeyRecord): boolean {
	if (!Number.isSafeInteger(r.e) || r.e < 1) return false;
	if (r.kind !== KeyRecordKind.genesis && r.kind !== KeyRecordKind.roll && r.kind !== KeyRecordKind.revoke) return false;
	// Genesis introduces K_1 only (enable, §15.1); roll and revoke chain to e − 1.
	if (r.kind === KeyRecordKind.genesis ? r.prevEpoch !== 0 || r.e !== 1 : r.prevEpoch !== r.e - 1 || r.e < 2) return false;
	if (r.kcv.length !== KCV_LEN) return false;
	const w = wrapsOf(r.kind);
	return wrapOk(r.nextWrap, w.next) && wrapOk(r.prevWrap, w.prev) && wrapOk(r.recoveryWrap, w.recovery);
}

export function encodeKeyRecord(r: KeyRecord): Uint8Array {
	if (!shapeOk(r)) throw new CodecError(`k record: bad shape (e ${r.e}, kind ${r.kind})`);
	return new Writer(KEY_RECORD_MAX_BYTES)
		.u8(KEY_RECORD_FORMAT).u8(KEY_RECORD_SUITE).varuint(r.e).u8(r.kind).varuint(r.prevEpoch)
		.fixed(r.kcv, KCV_LEN).varbytes(r.nextWrap).varbytes(r.prevWrap).varbytes(r.recoveryWrap)
		.finish();
}

/** null: not a canonical suite-1 record of format 1 (garbage, or a future format this reader skips). */
export function decodeKeyRecord(bytes: Uint8Array): KeyRecord | null {
	if (bytes.length > KEY_RECORD_MAX_BYTES) return null;
	try {
		const rd = new Reader(bytes);
		if (rd.u8() !== KEY_RECORD_FORMAT || rd.u8() !== KEY_RECORD_SUITE) return null;
		const e = rd.varuint();
		const kind = rd.u8() as KeyRecordKind;
		const prevEpoch = rd.varuint();
		const kcv = rd.copy(KCV_LEN);
		const nextWrap = rd.copy(rd.varuint());
		const prevWrap = rd.copy(rd.varuint());
		const recoveryWrap = rd.copy(rd.varuint());
		if (!rd.done()) return null;
		const r: KeyRecord = { e, kind, prevEpoch, kcv, nextWrap, prevWrap, recoveryWrap };
		if (!shapeOk(r)) return null;
		// Canonical varuints: re-encoding must give the same bytes.
		return bytesEqual(encodeKeyRecord(r), bytes) ? r : null;
	} catch (err) {
		if (err instanceof CodecError) return null;
		throw err;
	}
}

/** "yaos/k2" ‖ u8 format ‖ u8 suite ‖ varstring vaultId ‖ varuint e ‖ u8 kind ‖ varuint prevEpoch ‖ bytes16 kcv ‖ u8 role (§11.2). */
export function wrapAad(vaultId: string, r: Pick<KeyRecord, "e" | "kind" | "prevEpoch" | "kcv">, role: WrapRole): Uint8Array {
	return new Writer(96)
		.raw(utf8Encode(AAD_KEYRING_PREFIX)).u8(KEY_RECORD_FORMAT).u8(KEY_RECORD_SUITE).varstring(vaultId)
		.varuint(r.e).u8(r.kind).varuint(r.prevEpoch).fixed(r.kcv, KCV_LEN).u8(ROLE_CODE[role])
		.finish();
}

export function newKeyRecord(e: number, kind: KeyRecordKind, kcv: Uint8Array, wraps: { readonly next?: Uint8Array; readonly prev?: Uint8Array; readonly recovery?: Uint8Array }): KeyRecord {
	return {
		e, kind, prevEpoch: kind === KeyRecordKind.genesis ? 0 : e - 1, kcv,
		nextWrap: wraps.next ?? EMPTY, prevWrap: wraps.prev ?? EMPTY, recoveryWrap: wraps.recovery ?? EMPTY,
	};
}
