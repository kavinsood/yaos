/**
 * Published known-answer tests for the suite-1 primitives (e2ee-design §20.1):
 * AES-256-GCM (GCM spec test case 16), HKDF-SHA-256 (RFC 5869 A.1-A.3) and
 * HMAC-SHA-256 (RFC 4231 TC1-TC7). Each runs under Node WebCrypto through the
 * adapter's helpers and again under node:crypto (createCipheriv, hkdfSync,
 * createHmac), so one implementation cannot certify itself.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHmac, hkdfSync } from "node:crypto";
import { bytesToHex, hexToBytes } from "../../core/codec/lib0";
import { gcmOpen, gcmSeal, hmac } from "./suite1Primitives";

const subtle = globalThis.crypto.subtle;
const h = hexToBytes;
const ascii = (s: string) => bytesToHex(new TextEncoder().encode(s));
const seq = (from: number, to: number) => bytesToHex(Uint8Array.from({ length: to - from + 1 }, (_, i) => from + i));

const GCM_TC16 = {
	key: "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
	iv: "cafebabefacedbaddecaf888",
	aad: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
	pt: "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
	ct: "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
	tag: "76fc6ece0f4e1768cddf8853bb2d551b",
};

const HKDF = [
	{ name: "A.1", ikm: "0b".repeat(22), salt: seq(0x00, 0x0c), info: seq(0xf0, 0xf9), len: 42,
		okm: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865" },
	{ name: "A.2", ikm: seq(0x00, 0x4f), salt: seq(0x60, 0xaf), info: seq(0xb0, 0xff), len: 82,
		okm: "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87" },
	{ name: "A.3", ikm: "0b".repeat(22), salt: "", info: "", len: 42,
		okm: "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8" },
];

const HMAC = [
	{ name: "TC1", key: "0b".repeat(20), data: ascii("Hi There"), mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7" },
	{ name: "TC2", key: ascii("Jefe"), data: ascii("what do ya want for nothing?"), mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" },
	{ name: "TC3", key: "aa".repeat(20), data: "dd".repeat(50), mac: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe" },
	{ name: "TC4", key: seq(0x01, 0x19), data: "cd".repeat(50), mac: "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b" },
	{ name: "TC5 (truncated to 128 bits)", key: "0c".repeat(20), data: ascii("Test With Truncation"), mac: "a3b6167473100ee06e0c796c2955552b" },
	{ name: "TC6", key: "aa".repeat(131), data: ascii("Test Using Larger Than Block-Size Key - Hash Key First"),
		mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54" },
	{ name: "TC7", key: "aa".repeat(131),
		data: ascii("This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm."),
		mac: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2" },
];

describe("suite 1 KATs: AES-256-GCM (GCM spec TC16)", () => {
	it("WebCrypto via gcmSeal/gcmOpen, with a non-extractable key", async () => {
		const key = await subtle.importKey("raw", h(GCM_TC16.key), "AES-GCM", false, ["encrypt", "decrypt"]);
		assert.equal(key.extractable, false);
		const sealed = await gcmSeal(subtle, key, h(GCM_TC16.iv), h(GCM_TC16.aad), h(GCM_TC16.pt));
		assert.equal(bytesToHex(sealed), GCM_TC16.iv + GCM_TC16.ct + GCM_TC16.tag);
		const opened = await gcmOpen(subtle, key, h(GCM_TC16.aad), sealed);
		assert.ok(opened instanceof Uint8Array);
		assert.equal(bytesToHex(opened), GCM_TC16.pt);
	});

	it("node:crypto createCipheriv agrees", () => {
		const c = createCipheriv("aes-256-gcm", h(GCM_TC16.key), h(GCM_TC16.iv), { authTagLength: 16 });
		c.setAAD(h(GCM_TC16.aad));
		const ct = Buffer.concat([c.update(h(GCM_TC16.pt)), c.final()]);
		assert.equal(ct.toString("hex"), GCM_TC16.ct);
		assert.equal(c.getAuthTag().toString("hex"), GCM_TC16.tag);
	});
});

describe("suite 1 KATs: HKDF-SHA-256 (RFC 5869)", () => {
	for (const v of HKDF) {
		it(`${v.name}: WebCrypto deriveBits and node:crypto hkdfSync`, async () => {
			const base = await subtle.importKey("raw", h(v.ikm), "HKDF", false, ["deriveBits"]);
			const okm = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: h(v.salt), info: h(v.info) }, base, v.len * 8);
			assert.equal(bytesToHex(new Uint8Array(okm)), v.okm);
			assert.equal(Buffer.from(hkdfSync("sha256", h(v.ikm), h(v.salt), h(v.info), v.len)).toString("hex"), v.okm);
		});
	}
});

describe("suite 1 KATs: HMAC-SHA-256 (RFC 4231)", () => {
	for (const v of HMAC) {
		it(`${v.name}: WebCrypto via hmac() and node:crypto createHmac`, async () => {
			const key = await subtle.importKey("raw", h(v.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const web = bytesToHex(await hmac(subtle, key, h(v.data)));
			const node = createHmac("sha256", h(v.key)).update(h(v.data)).digest("hex");
			assert.equal(web.slice(0, v.mac.length), v.mac);
			assert.equal(node.slice(0, v.mac.length), v.mac);
		});
	}
});
