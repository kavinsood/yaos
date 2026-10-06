import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodecError, utf8Encode } from "../../core/codec/lib0";
import { KEY_RECORD_MAX_BYTES, KeyRecordKind, decodeKeyRecord, encodeKeyRecord, newKeyRecord, wrapAad, type KeyRecord } from "./record";

const kcv = new Uint8Array(16).fill(7);
const w = (b: number) => new Uint8Array(60).fill(b);
const genesis = newKeyRecord(1, KeyRecordKind.genesis, kcv, { recovery: w(3) });
const roll = newKeyRecord(2, KeyRecordKind.roll, kcv, { next: w(1), prev: w(2) });
const revoke = newKeyRecord(300, KeyRecordKind.revoke, kcv, { prev: w(2), recovery: w(3) });

describe("k record codec (§11.1)", () => {
	it("round-trips every kind; layout is fmt ‖ suite ‖ e ‖ kind ‖ prevEpoch ‖ kcv ‖ next ‖ prev ‖ recovery", () => {
		for (const r of [genesis, roll, revoke]) assert.deepEqual(decodeKeyRecord(encodeKeyRecord(r)), r);
		const g = encodeKeyRecord(genesis);
		assert.deepEqual([...g.subarray(0, 5)], [1, 1, 1, 1, 0]);
		assert.deepEqual(g.subarray(5, 21), kcv);
		assert.deepEqual([...g.subarray(21, 24)], [0, 0, 60]);
		assert.equal(g.length, 24 + 60);
		const v = encodeKeyRecord(revoke);
		assert.deepEqual([...v.subarray(0, 7)], [1, 1, 0xac, 0x02, 3, 0xab, 0x02]);
		assert.ok(encodeKeyRecord(roll).length <= KEY_RECORD_MAX_BYTES);
	});

	it("rejects wrong shapes on encode and on decode", () => {
		const bad: KeyRecord[] = [
			{ ...genesis, e: 0 },
			{ ...genesis, e: 2 }, // genesis introduces K_1 only
			{ ...genesis, prevEpoch: 1 },
			{ ...roll, prevEpoch: 0 },
			{ ...newKeyRecord(1, KeyRecordKind.roll, kcv, { next: w(1), prev: w(2) }) }, // roll needs e ≥ 2
			{ ...genesis, nextWrap: w(1) },
			{ ...genesis, recoveryWrap: new Uint8Array(0) },
			{ ...roll, recoveryWrap: w(3) },
			{ ...revoke, nextWrap: w(1) },
			{ ...revoke, prevWrap: w(2).subarray(0, 59) },
			{ ...genesis, kcv: kcv.subarray(0, 15) },
			{ ...genesis, kind: 4 as KeyRecordKind },
		];
		for (const r of bad) assert.throws(() => encodeKeyRecord(r), CodecError, JSON.stringify({ e: r.e, kind: r.kind }));
		// Same shapes, hand-encoded, decode to null.
		const enc = (r: KeyRecord) => {
			const parts = [1, 1, ...varuint(r.e), r.kind, ...varuint(r.prevEpoch), ...r.kcv];
			for (const x of [r.nextWrap, r.prevWrap, r.recoveryWrap]) parts.push(...varuint(x.length), ...x);
			return Uint8Array.from(parts);
		};
		assert.notEqual(decodeKeyRecord(enc(genesis)), null);
		for (const r of bad.filter((r) => r.kcv.length === 16)) assert.equal(decodeKeyRecord(enc(r)), null);
	});

	it("is canonical: trailing bytes, truncation, other format or suite, non-minimal varuint and oversize are not records", () => {
		const g = encodeKeyRecord(genesis);
		assert.equal(decodeKeyRecord(Uint8Array.from([...g, 0])), null);
		for (let n = 0; n < g.length; n++) assert.equal(decodeKeyRecord(g.subarray(0, n)), null, `prefix ${n}`);
		assert.equal(decodeKeyRecord(Uint8Array.from([2, ...g.subarray(1)])), null);
		assert.equal(decodeKeyRecord(Uint8Array.from([1, 0, ...g.subarray(2)])), null);
		assert.equal(decodeKeyRecord(Uint8Array.from([1, 1, 0x81, 0x00, ...g.subarray(3)])), null); // e = 1, two bytes
		assert.equal(decodeKeyRecord(new Uint8Array(KEY_RECORD_MAX_BYTES + 1)), null);
		assert.equal(decodeKeyRecord(utf8Encode("garbage")), null);
	});

	it("wrap AAD binds format, suite, vault, e, kind, prevEpoch, kcv and role (§11.2)", () => {
		const a = wrapAad("V", roll, "next");
		assert.deepEqual(a, Uint8Array.from([...utf8Encode("yaos/k2"), 1, 1, 1, 0x56, 2, 2, 1, ...kcv, 1]));
		const variants = [
			wrapAad("W", roll, "next"), wrapAad("V", roll, "prev"), wrapAad("V", roll, "recovery"),
			wrapAad("V", { ...roll, e: 3 }, "next"), wrapAad("V", { ...roll, kind: KeyRecordKind.revoke }, "next"),
			wrapAad("V", { ...roll, prevEpoch: 0 }, "next"), wrapAad("V", { ...roll, kcv: new Uint8Array(16) }, "next"),
		];
		for (const v of variants) assert.notDeepEqual(v, a);
	});
});

function varuint(n: number): number[] {
	const o: number[] = [];
	while (n > 0x7f) { o.push(0x80 | (n & 0x7f)); n = Math.floor(n / 128); }
	o.push(n);
	return o;
}
