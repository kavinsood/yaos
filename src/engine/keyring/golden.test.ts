/**
 * k record golden vectors (e2ee-design §20.1, WP-E3 part): genesis, roll and revoke records (§11.1, wrap
 * AAD §11.2) and the RK text form (§13.1). Inputs: fake K_1 = 00..1f, K_2 = 20..3f, K_3 = 60..7f, vaultId
 * "AAAAAAAAAAAAAAAAAAAAAA", the 35-byte fake RK = 40..62 (only RK[0..32] feeds KEK_RK, §5.1) and scripted
 * nonces b1..b5, consumed in wrap field order (next, prev, recovery). Every record is checked three ways:
 * buildKeyRecord over the WebCrypto adapter, an independent node:crypto reference written below from the
 * design text (hkdfSync, createCipheriv, createHmac, createHash), and the committed hex.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { bytesToHex, hexToBytes } from "../../core/codec/lib0";
import { decodeRecoveryKey, encodeRecoveryKey, makeRecoveryKey } from "../../core/codec/recoveryKey";
import type { WrapRole } from "../../ports/crypto";
import { ScriptedRandom } from "../adapters/testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { buildKeyRecord } from "./build";
import { KeyRecordKind, decodeKeyRecord, encodeKeyRecord, wrapAad, type KeyRecord } from "./record";

const h = hexToBytes;
const range = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);
const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const K1 = range(0x00, 32);
const K2 = range(0x20, 32);
const K3 = range(0x60, 32);
const RK = range(0x40, 35);
const RK_SECRET = range(0x40, 32);
const nonce = (b: number) => new Uint8Array(12).fill(b);
/** WP-E1's committed kcv(K_1, 1) and kcv(K_2, 2) (suite1Golden.test.ts); the records must carry the same. */
const WP_E1_KCV = { 1: "935783edfc4edac0a28eb13b432665e9", 2: "10e200d24d24f1a6fa66afe96a0f7196" } as const;

// ---- independent reference (node:crypto) -------------------------------------------

const utf8 = (s: string) => Buffer.from(s, "utf8");
const varuint = (n: number) => { const o: number[] = []; while (n > 0x7f) { o.push(0x80 | (n & 0x7f)); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const varstring = (s: string) => Buffer.concat([varuint(utf8(s).length), utf8(s)]);
const varbytes = (b: Uint8Array) => Buffer.concat([varuint(b.length), b]);
const info = (purpose: string, e: number) => Buffer.concat([utf8(`yaos/v1/${purpose}`), Buffer.from([0]), utf8(VAULT), Buffer.from([0]), varuint(e)]);
const sub = (k: Uint8Array, purpose: string, e: number) => Buffer.from(hkdfSync("sha256", k, utf8("yaos-hkdf-v1"), info(purpose, e), 32));
const mac = (key: Uint8Array, msg: Uint8Array) => createHmac("sha256", key).update(msg).digest();
const gcm = (key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array) => {
	const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
	c.setAAD(aad);
	return Buffer.concat([iv, c.update(pt), c.final(), c.getAuthTag()]);
};
const kcvRef = (k: Uint8Array, e: number) => mac(sub(k, "kcv", e), info("kcv", e)).subarray(0, 16);
const KEK_RK = Buffer.from(hkdfSync("sha256", RK.subarray(0, 32), utf8("yaos-hkdf-v1"), info("recovery-kek", 0), 32));
const ROLE = { next: 1, prev: 2, recovery: 3 } as const;

interface WrapRef { readonly by: Uint8Array; readonly of: Uint8Array; readonly iv: Uint8Array }

/** §11.1 record introducing e under K_e; each present wrap is AES-GCM(by, of) with the §11.2 AAD. */
function recordRef(e: number, kind: number, kE: Uint8Array, wraps: Partial<Record<WrapRole, WrapRef>>): string {
	const prevEpoch = kind === 1 ? 0 : e - 1;
	const kcv = kcvRef(kE, e);
	const aad = (role: WrapRole) => Buffer.concat([
		utf8("yaos/k2"), Buffer.from([1, 1]), varstring(VAULT), varuint(e), Buffer.from([kind]), varuint(prevEpoch), kcv, Buffer.from([ROLE[role]]),
	]);
	const wrap = (role: WrapRole) => { const w = wraps[role]; return w ? gcm(w.by, w.iv, aad(role), w.of) : Buffer.alloc(0); };
	return Buffer.concat([
		Buffer.from([1, 1]), varuint(e), Buffer.from([kind]), varuint(prevEpoch), kcv,
		varbytes(wrap("next")), varbytes(wrap("prev")), varbytes(wrap("recovery")),
	]).toString("hex");
}

/** §13.1: secret ‖ SHA-256(secret)[0..3], as one big-endian BigInt in 56 Crockford digits, MSB first. */
const rkRef = Buffer.concat([RK_SECRET, createHash("sha256").update(RK_SECRET).digest().subarray(0, 3)]);
function rkTextRef(rk: Uint8Array): string {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let n = BigInt(`0x${Buffer.from(rk).toString("hex")}`);
	let s = "";
	for (let i = 0; i < 56; i++) {
		s = alphabet.charAt(Number(n & 31n)) + s;
		n >>= 5n;
	}
	return `YAOS-RK1-${s.match(/.{4}/g)!.join("-")}`;
}

const ref = {
	genesis: () => recordRef(1, 1, K1, { recovery: { by: KEK_RK, of: K1, iv: nonce(0xb1) } }),
	roll: () => recordRef(2, 2, K2, {
		next: { by: sub(K1, "wrap", 1), of: K2, iv: nonce(0xb2) },
		prev: { by: sub(K2, "wrap", 2), of: K1, iv: nonce(0xb3) },
	}),
	revoke: () => recordRef(3, 3, K3, {
		prev: { by: sub(K3, "wrap", 3), of: K2, iv: nonce(0xb4) },
		recovery: { by: KEK_RK, of: K3, iv: nonce(0xb5) },
	}),
};

// ---- committed golden hex -----------------------------------------------------------

// Split per field: format ‖ suite ‖ e ‖ kind ‖ prevEpoch ‖ kcv, then varbytes nextWrap, prevWrap, recoveryWrap.
const GOLDEN = {
	genesis: "0101010100935783edfc4edac0a28eb13b432665e9" + "00" + "00"
		+ "3cb1b1b1b1b1b1b1b1b1b1b1b1eb15c63cae4fc62155d24752521c86d15911f6a557cf2773777e07da3eb345b66adecbf3b79fe87810129af3119f6c54",
	roll: "010102020110e200d24d24f1a6fa66afe96a0f7196"
		+ "3cb2b2b2b2b2b2b2b2b2b2b2b2b6e3b8713cfb8c5074d5a1b75df1952b7a3204663d6a13a5449c9fc4004dc8fc04c75d4daa8039fd64713ec11314fbac"
		+ "3cb3b3b3b3b3b3b3b3b3b3b3b3ad01c97efaed7079e52975d64893c0882e467027de4ae064b628cbbb488d7b79376639606286bf259a52ba84709a135d"
		+ "00",
	revoke: "0101030302e07dfe16de9d6ebf6a6bc60edc8b3e4b" + "00"
		+ "3cb4b4b4b4b4b4b4b4b4b4b4b4417b78e2198fc0988f5f6323bdd04291620fbe43841929cf8338fef572a89abc154acadef3e6ca8c6cfc6873c5bba7ee"
		+ "3cb5b5b5b5b5b5b5b5b5b5b5b5260ff8d3646a077d81cd6d8a33b78b1d0cd3ad194442596fcc756536c34fd46b8a78aa5cc9084029f2a6d45ec1224087",
	rk: "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5fca2a4f",
	rkText: "YAOS-RK1-810M-4GT4-8N34-EJ29-995M-RKAE-9X85-2MJK-AHAN-CNTR-B5D5-PQ2X-BSFW-MAJF",
};

type RecordName = "genesis" | "roll" | "revoke";
const record = (name: RecordName): KeyRecord => {
	const r = decodeKeyRecord(h(GOLDEN[name]));
	assert.ok(r, `${name} decodes`);
	return r;
};
const wrapIn = (r: KeyRecord, role: WrapRole) => (role === "next" ? r.nextWrap : role === "prev" ? r.prevWrap : r.recoveryWrap);

describe("k record golden vectors", () => {
	it("reference matches the committed hex", () => {
		const got = { genesis: ref.genesis(), roll: ref.roll(), revoke: ref.revoke(), rk: rkRef.toString("hex"), rkText: rkTextRef(rkRef) };
		assert.deepEqual(got, GOLDEN);
	});

	it("adapter: buildKeyRecord gives the committed bytes", async () => {
		const random = new ScriptedRandom();
		const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys: [{ e: 1, k: K1.slice() }, { e: 2, k: K2.slice() }, { e: 3, k: K3.slice() }] });
		random.push(nonce(0xb1));
		assert.equal(bytesToHex(await buildKeyRecord(c, VAULT, 1, KeyRecordKind.genesis, RK)), GOLDEN.genesis);
		random.push(nonce(0xb2), nonce(0xb3));
		assert.equal(bytesToHex(await buildKeyRecord(c, VAULT, 2, KeyRecordKind.roll)), GOLDEN.roll);
		random.push(nonce(0xb4), nonce(0xb5));
		assert.equal(bytesToHex(await buildKeyRecord(c, VAULT, 3, KeyRecordKind.revoke, RK)), GOLDEN.revoke);
		assert.deepEqual([random.calls, random.pending], [5, 0]);
	});

	it("decode: fields as built, WP-E1's kcvs, and a byte-identical re-encode", () => {
		const want: Record<RecordName, { e: number; kind: number; prevEpoch: number; wraps: number[] }> = {
			genesis: { e: 1, kind: KeyRecordKind.genesis, prevEpoch: 0, wraps: [0, 0, 60] },
			roll: { e: 2, kind: KeyRecordKind.roll, prevEpoch: 1, wraps: [60, 60, 0] },
			revoke: { e: 3, kind: KeyRecordKind.revoke, prevEpoch: 2, wraps: [0, 60, 60] },
		};
		for (const name of ["genesis", "roll", "revoke"] as const) {
			const r = record(name);
			assert.deepEqual(
				{ e: r.e, kind: r.kind, prevEpoch: r.prevEpoch, wraps: [r.nextWrap.length, r.prevWrap.length, r.recoveryWrap.length] },
				want[name],
				name,
			);
			assert.equal(bytesToHex(encodeKeyRecord(r)), GOLDEN[name], name);
		}
		assert.equal(bytesToHex(record("genesis").kcv), WP_E1_KCV[1]);
		assert.equal(bytesToHex(record("roll").kcv), WP_E1_KCV[2]);
	});

	it("a fresh adapter recovers each record's key, and its kcv matches the record", async () => {
		const kcvOf: Record<number, Uint8Array> = { 1: record("genesis").kcv, 2: record("roll").kcv, 3: record("revoke").kcv };
		const held: Record<number, Uint8Array> = { 1: K1, 2: K2, 3: K3 };
		const cases: readonly { name: RecordName; role: WrapRole; holds: number | null; gets: number }[] = [
			{ name: "genesis", role: "recovery", holds: null, gets: 1 }, // RK alone gives K_1
			{ name: "roll", role: "next", holds: 1, gets: 2 }, // a K_1 holder follows the roll
			{ name: "roll", role: "prev", holds: 2, gets: 1 }, // backward chain
			{ name: "revoke", role: "recovery", holds: null, gets: 3 }, // RK alone gives K_3
			{ name: "revoke", role: "prev", holds: 3, gets: 2 },
		];
		for (const { name, role, holds, gets } of cases) {
			const r = record(name);
			const keys = holds === null ? [] : [{ e: holds, k: held[holds]!.slice() }];
			const d = await createWebCryptoSuite1({ vaultId: VAULT, random: new ScriptedRandom(), keys });
			const label = `${name} ${role}`;
			assert.equal(d.keyState(gets).held, false, label);
			assert.equal(await d.unwrap(role, r.e, wrapAad(VAULT, r, role), wrapIn(r, role), role === "recovery" ? RK : undefined), true, label);
			assert.deepEqual(await d.kcv(gets), kcvOf[gets], label);
		}
	});

	it("RK text: makeRecoveryKey(40..5f) encodes to the committed string and decodes back", async () => {
		const rk = makeRecoveryKey(RK_SECRET);
		assert.equal(bytesToHex(rk), GOLDEN.rk);
		assert.equal(encodeRecoveryKey(rk), GOLDEN.rkText);
		assert.deepEqual(decodeRecoveryKey(GOLDEN.rkText), h(GOLDEN.rk));
		// Its RK[0..32] is the fake RK's, so the key typed from the committed text opens the genesis recoveryWrap.
		const g = record("genesis");
		const d = await createWebCryptoSuite1({ vaultId: VAULT, random: new ScriptedRandom() });
		assert.equal(await d.unwrap("recovery", 1, wrapAad(VAULT, g, "recovery"), g.recoveryWrap, decodeRecoveryKey(GOLDEN.rkText.toLowerCase())!), true);
		assert.deepEqual(await d.kcv(1), g.kcv);
	});
});
