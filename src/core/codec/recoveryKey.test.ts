import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CodecError } from "./lib0";
import { RK_BYTES, RK_PREFIX, RK_SECRET_BYTES, decodeRecoveryKey, encodeRecoveryKey, makeRecoveryKey } from "./recoveryKey";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** xorshift32: deterministic secrets, so a failure reproduces. */
function prng(seed: number): (n: number) => Uint8Array {
	let x = seed >>> 0 || 1;
	const next = (): number => {
		x = (x ^ (x << 13)) >>> 0;
		x = (x ^ (x >>> 17)) >>> 0;
		x = (x ^ (x << 5)) >>> 0;
		return x & 0xff;
	};
	return (n) => Uint8Array.from({ length: n }, next);
}

/** Independent reference: the 35 bytes as one big-endian BigInt, written as 56 five-bit digits, MSB first. */
function base32Ref(rk: Uint8Array): string {
	let n = BigInt(`0x${Buffer.from(rk).toString("hex")}`);
	let s = "";
	for (let i = 0; i < 56; i++) {
		s = CROCKFORD.charAt(Number(n & 31n)) + s;
		n >>= 5n;
	}
	return s;
}

const checksumRef = (secret: Uint8Array) => new Uint8Array(createHash("sha256").update(secret).digest().subarray(0, 3));
/** The 56 base32 chars of an encoded key. */
const body = (text: string) => text.slice(RK_PREFIX.length).replace(/-/g, "");
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);
const SAMPLE = makeRecoveryKey(SECRET);
const TEXT = encodeRecoveryKey(SAMPLE);

/** The first of `count` seeded keys whose body contains `ch`. */
function keyWith(ch: string, seed: number, count = 400): { rk: Uint8Array; b: string } {
	const rand = prng(seed);
	for (let i = 0; i < count; i++) {
		const rk = makeRecoveryKey(rand(32));
		const b = body(encodeRecoveryKey(rk));
		if (b.includes(ch)) return { rk, b };
	}
	throw new Error(`no seeded key contains ${ch}`);
}

describe("recovery key (§13.1)", () => {
	it("layout: secret ‖ first 3 bytes of SHA-256(secret); only 32-byte secrets", () => {
		assert.equal(RK_BYTES, 35);
		assert.equal(RK_SECRET_BYTES, 32);
		assert.equal(SAMPLE.length, 35);
		assert.deepEqual(SAMPLE.subarray(0, 32), SECRET);
		assert.deepEqual(SAMPLE.subarray(32), checksumRef(SECRET));
		for (const n of [0, 31, 33, 35]) assert.throws(() => makeRecoveryKey(new Uint8Array(n)), CodecError, `n=${n}`);
	});

	it("text form: prefix + 14 groups of 4 Crockford chars, equal to a BigInt reference, and round-trips", () => {
		const shape = /^YAOS-RK1-(?:[0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/;
		const rand = prng(0x5eed);
		const secrets = [new Uint8Array(32), new Uint8Array(32).fill(0xff), SECRET];
		for (let i = 0; i < 2000; i++) secrets.push(rand(32));
		for (const secret of secrets) {
			const rk = makeRecoveryKey(secret);
			const text = encodeRecoveryKey(rk);
			assert.match(text, shape);
			assert.equal(body(text), base32Ref(rk));
			assert.deepEqual(decodeRecoveryKey(text), rk);
			assert.deepEqual(decodeRecoveryKey(body(text)), rk);
		}
	});

	it("ignores case, dashes and whitespace; the prefix is optional", () => {
		const b = body(TEXT);
		const variants = [
			TEXT.toLowerCase(),
			[...TEXT].map((c, i) => (i % 2 ? c.toLowerCase() : c)).join(""),
			TEXT.replace(/-/g, ""),
			TEXT.replace(/-/g, " "),
			TEXT.replace(/-/g, "\u00a0"),
			`  ${TEXT.replace(/-/g, "\t")}\n`,
			b,
			b.toLowerCase(),
			b.replace(/(.{4})/g, "$1 - "),
			b.split("").join("-"),
			`yaos-rk1 ${b}`,
			`${RK_PREFIX.toLowerCase()}${b}`,
		];
		for (const v of variants) assert.deepEqual(decodeRecoveryKey(v), SAMPLE, JSON.stringify(v));
	});

	it("maps I and L to 1 and O to 0", () => {
		const rand = prng(7);
		let rk: Uint8Array;
		let b: string;
		do {
			rk = makeRecoveryKey(rand(32));
			b = body(encodeRecoveryKey(rk));
		} while (!(b.includes("0") && b.includes("1")));
		for (const [one, zero] of [["I", "O"], ["i", "o"], ["L", "O"], ["l", "o"]] as const) {
			assert.deepEqual(decodeRecoveryKey(b.replace(/1/g, one).replace(/0/g, zero)), rk, `${one}/${zero}`);
		}
	});

	it("the checksum catches every single-character substitution of the sample", () => {
		const b = body(TEXT);
		const value = (c: string) => (c === "I" || c === "L" ? "1" : c === "O" ? "0" : c);
		let tried = 0;
		const accepted: string[] = [];
		for (let i = 0; i < b.length; i++) {
			for (const c of `${CROCKFORD}ILO`) {
				if (value(c) === b[i]) continue;
				tried++;
				const typo = b.slice(0, i) + c + b.slice(i + 1);
				if (decodeRecoveryKey(typo) !== null) accepted.push(typo);
			}
		}
		assert.ok(tried >= 56 * 31, `tried ${tried}`);
		assert.deepEqual(accepted, []);
	});

	it("rejects wrong lengths and prefixes; encode rejects a wrong length or checksum", () => {
		const b = body(TEXT);
		const bad = [
			"", RK_PREFIX, b.slice(1), `${b}0`, RK_PREFIX + b.slice(1), `${RK_PREFIX}${b}0`, `XAOS-RK1-${b}`, `YAOS-RK2-${b}`,
			`YAOS-${b}`, RK_PREFIX + RK_PREFIX + b, b + b,
		];
		for (const t of bad) assert.equal(decodeRecoveryKey(t), null, t);
		for (const n of [0, 32, 34, 36]) assert.throws(() => encodeRecoveryKey(new Uint8Array(n)), CodecError, `n=${n}`);
		const flipped = SAMPLE.slice();
		flipped[34] = SAMPLE[34]! ^ 1;
		assert.throws(() => encodeRecoveryKey(flipped), CodecError);
		assert.equal(decodeRecoveryKey(base32Ref(flipped)), null);
	});

	it("rejects U (an alias of no digit) and every other character; never throws", () => {
		// For each digit, swap one occurrence for U: if U aliased that digit, the key would still decode.
		CROCKFORD.split("").forEach((d, i) => {
			const { b } = keyWith(d, 100 + i);
			for (const u of ["U", "u"]) assert.equal(decodeRecoveryKey(b.replace(d, u)), null, `${d} -> ${u}`);
		});
		// Non-ASCII letters that toUpperCase would turn into valid chars: dotless ı → I (→ 1), long ſ → S.
		for (const [d, alias] of [["1", "ı"], ["S", "ſ"]] as const) {
			const { b } = keyWith(d, 7);
			assert.equal(decodeRecoveryKey(b.replace(d, alias)), null, alias);
		}
		const b = body(TEXT);
		for (const ch of ["*", "_", ".", "+", "=", "/", "Ö", "\u0000", "\ud800", "😀"]) {
			assert.equal(decodeRecoveryKey(b.slice(0, 10) + ch + b.slice(11)), null, JSON.stringify(ch));
		}
		const rand = prng(42);
		const pool = `${CROCKFORD}ILOUilou -\t\n*ßı\ud800😀`;
		for (let i = 0; i < 3000; i++) {
			const r = rand(1 + (i % 80));
			const s = Array.from(r.subarray(1), (x) => pool.charAt(x % pool.length)).join("");
			const out = decodeRecoveryKey(s);
			assert.ok(out === null || out.length === RK_BYTES, s);
		}
	});
});
