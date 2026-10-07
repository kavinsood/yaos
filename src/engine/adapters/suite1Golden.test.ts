/**
 * YAOS suite-1 golden vectors (e2ee-design §20.1, WP-E1 part). Inputs: fake
 * key K_1 = 00..1f, K_2 = 20..3f, vaultId "AAAAAAAAAAAAAAAAAAAAAA", a 35-byte
 * fake RK = 40..62, and scripted nonces. Every output is checked three ways:
 * the adapter (WebCrypto), an independent node:crypto reference written
 * below from the design text (hkdfSync, createCipheriv, createHmac), and the
 * committed hex. Per-kind envelope vectors are WP-E2, k records and the RK
 * encoding WP-E3, the setup link WP-E5. `storeAbc2` (WP-E6a) is what the blob
 * store holds for the plaintext "abc" sealed at epoch 2: stored at the K_1
 * address of its sha256, sealed under K_2.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, hkdfSync } from "node:crypto";
import { bytesToHex, hexToBytes, utf8Encode } from "../../core/codec/lib0";
import type { ContentHash } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { getOpened, putSealed } from "../blobs/blobStore";
import { ScriptedRandom } from "./testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "./webCryptoSuite1";

const h = hexToBytes;
const range = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);
const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const K1 = range(0x00, 32);
const K2 = range(0x20, 32);
const RK = range(0x40, 35);
const nonce = (b: number) => new Uint8Array(12).fill(b);
const AAD = new TextEncoder().encode("golden aad");
const PLAINTEXT = new TextEncoder().encode("hello, suite 1");
const HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" as ContentHash; // sha256("abc")

// ---- independent reference (node:crypto) -------------------------------------------

const utf8 = (s: string) => Buffer.from(s, "utf8");
const varuint = (n: number) => { const o: number[] = []; while (n > 0x7f) { o.push(0x80 | (n & 0x7f)); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const varstring = (s: string) => Buffer.concat([varuint(utf8(s).length), utf8(s)]);
const info = (purpose: string, e: number) => Buffer.concat([utf8(`yaos/v1/${purpose}`), Buffer.from([0]), utf8(VAULT), Buffer.from([0]), varuint(e)]);
const sub = (k: Uint8Array, purpose: string, e: number) => Buffer.from(hkdfSync("sha256", k, utf8("yaos-hkdf-v1"), info(purpose, e), 32));
const mac = (key: Uint8Array, msg: Uint8Array) => createHmac("sha256", key).update(msg).digest();
const gcm = (key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array) => {
	const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
	c.setAAD(aad);
	return Buffer.concat([iv, c.update(pt), c.final(), c.getAuthTag()]).toString("hex");
};
/** Padmé (§7.3) with integer arithmetic only. */
const padRef = (data: Uint8Array) => {
	const m = Math.max(data.length + 1, 256);
	const E = m.toString(2).length - 1;
	const S = E.toString(2).length;
	const step = 2 ** (E - S);
	const out = Buffer.alloc(Math.ceil(m / step) * step);
	out.set(data);
	out[data.length] = 0x80;
	return out;
};
const ref = {
	kcv: (k: Uint8Array, e: number) => mac(sub(k, "kcv", e), info("kcv", e)).subarray(0, 16).toString("hex"),
	address: (k1: Uint8Array) => mac(sub(k1, "addr", 1), h(HASH)).toString("hex"),
	diag: (k1: Uint8Array) => mac(sub(k1, "diag", 1), PLAINTEXT).toString("hex").slice(0, 16),
	seal: (k: Uint8Array, purpose: string, e: number, iv: Uint8Array) => gcm(sub(k, purpose, e), iv, AAD, PLAINTEXT),
	blob: (k: Uint8Array, e: number, iv: Uint8Array, address: string, plaintext: Uint8Array = PLAINTEXT) =>
		Buffer.from([1, 1, ...varuint(e)]).toString("hex")
		+ gcm(sub(k, "blob", e), iv, Buffer.concat([utf8("yaos/b2"), Buffer.from([1, 1]), varuint(e), varstring(VAULT), varstring(address)]), padRef(plaintext)),
	wrap: (by: Uint8Array, byEpoch: number, of: Uint8Array, iv: Uint8Array) => gcm(sub(by, "wrap", byEpoch), iv, AAD, of),
	recovery: (of: Uint8Array, iv: Uint8Array) =>
		gcm(Buffer.from(hkdfSync("sha256", RK.subarray(0, 32), utf8("yaos-hkdf-v1"), info("recovery-kek", 0), 32)), iv, AAD, of),
};

// ---- committed golden hex -----------------------------------------------------------

const GOLDEN = {
	kcv1: "935783edfc4edac0a28eb13b432665e9",
	kcv2: "10e200d24d24f1a6fa66afe96a0f7196",
	address: "372fe601f7d68b5b2e26ab28a07ba5acae1193e752b827a71f2a7fb051fa3ef3",
	diag: "75311d2baf7f6ab4",
	frame1: "a1a1a1a1a1a1a1a1a1a1a1a1c8ccfea53aacb40990920db69ea20c7569956ef0747ffc3a87204ba60935",
	checkpoint1: "a2a2a2a2a2a2a2a2a2a2a2a2a401e9cab712f7adcc81a2a3b6c8c97a864a9837b37419abe046f2c899c1",
	frame2: "a3a3a3a3a3a3a3a3a3a3a3a358bc70e2bcdd54d7b372761a2296c1540f26fa6054cbe24eb1a90f670da5",
	blob1:
		"010101a4a4a4a4a4a4a4a4a4a4a4a4b553b3960750e75d2c606a5a87531898c9d3c6a6a4a26b62ff170dc995c8dd55aa048dce2d7a10b81faf2e0f12853dd235"
		+ "4fb373c3c59d76212b6da3f941ecbbcc5dbcfe2bba18459492223b748884f9832d2c7a1777583d77b65a6ef00a482acd385a99a90fd4dd7f5f6f0d830d123397"
		+ "f2404f73cb09ff871179d255e24c8e589e8be6c1a90fd97a12e0afbee470b9e3d9826595ede2948d0af38d198c9ccb86d7b6e46603cb8214d1912a1a051a69f9"
		+ "b6ef639af76a217d427d6e723a31c65ae686d58f2e0e8a6c5f05cd85e0693616a88c32acb463d331bd68fe888e7e865bd3b4f4b790a52ceb686baf976f9991b3"
		+ "7d76732d2111d6bbd2e82aca5fccb4f3606510a9a814820a7c32d09db44a86",
	next2: "a5a5a5a5a5a5a5a5a5a5a5a5ad15eebad20296225f346f3b492d428eab689313c2040ffe96a52db59862ae8134cb9d4d8b242155f7a1104888fe6b63",
	prev2: "a6a6a6a6a6a6a6a6a6a6a6a6ac136477def448879eaa9cf7385142e4ad635f3ac1fde23284ec97336b189aa52e7c49eebfd504958890ee9e1eefc5cd",
	recovery1: "a7a7a7a7a7a7a7a7a7a7a7a79c141ec610bf49fdb70e2c52bcd7454c1b01077b157f6f55b99507560cffcf8faad11f793fb9b657b72dd3515faa19b5",
	storeAbc2:
		"010102b1b1b1b1b1b1b1b1b1b1b1b17d31266aa06736c6eb4a634fd217cd80fc5e7cd0f4f58071b38c4182056589519eaa8ba9e04d7952bc8e3e928a5774e716"
		+ "f0682dabc9ebb0df57aad6cc4db29bc6f02fbe9df1f95f5f83f24ccd285eb14e747adf99330872071dadc07b04497b4fa8ff50ff27bc12ea0c7d843334baf775"
		+ "2476a7e8128cb22033248a1c29374b609111005224b7c7a1f0bd1eb4c2adf75da955dee03f987eeb2e5e7db87b30c0f361830cdee177a157d1ead018f4a775"
		+ "9f35649e104339726d71699ab61905fef8af654888b319bf43ca376b008ac0369d9abc3be6e1670357e426ee7c23f59d43174047f13d453c7efcdd02a010b19f"
		+ "9a593657aaddfa34b32f549b7d588e2a6b3f12e0b7e44a0f92ad7d1a7f10373c",
};
const ABC = utf8Encode("abc");

async function adapter() {
	const random = new ScriptedRandom();
	const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys: [{ e: 1, k: K1.slice() }, { e: 2, k: K2.slice() }] });
	c.markVerified(1);
	c.markVerified(2);
	return { c, random };
}

describe("suite 1 golden vectors", () => {
	it("reference matches the committed hex", () => {
		const address = ref.address(K1);
		const got = {
			kcv1: ref.kcv(K1, 1), kcv2: ref.kcv(K2, 2), address, diag: ref.diag(K1),
			frame1: ref.seal(K1, "frame", 1, nonce(0xa1)), checkpoint1: ref.seal(K1, "checkpoint", 1, nonce(0xa2)),
			frame2: ref.seal(K2, "frame", 2, nonce(0xa3)), blob1: ref.blob(K1, 1, nonce(0xa4), address),
			next2: ref.wrap(K1, 1, K2, nonce(0xa5)), prev2: ref.wrap(K2, 2, K1, nonce(0xa6)), recovery1: ref.recovery(K1, nonce(0xa7)),
			storeAbc2: ref.blob(K2, 2, nonce(0xb1), address, ABC),
		};
		assert.equal(createHash("sha256").update(ABC).digest("hex"), HASH);
		assert.deepEqual(got, GOLDEN);
	});

	it("adapter: kcv, blob address and diagHash", async () => {
		const { c } = await adapter();
		assert.equal(bytesToHex(await c.kcv(1)), GOLDEN.kcv1);
		assert.equal(bytesToHex(await c.kcv(2)), GOLDEN.kcv2);
		assert.equal(await c.blobAddress(HASH), GOLDEN.address);
		assert.equal(await c.diagHash(PLAINTEXT), GOLDEN.diag);
	});

	it("adapter: frame and checkpoint seals, and they open", async () => {
		const { c, random } = await adapter();
		random.push(nonce(0xa1), nonce(0xa2), nonce(0xa3));
		const f1 = await c.seal({ purpose: "frame", keyEpoch: 1, aad: AAD, plaintext: PLAINTEXT });
		const c1 = await c.seal({ purpose: "checkpoint", keyEpoch: 1, aad: AAD, plaintext: PLAINTEXT });
		const f2 = await c.seal({ purpose: "frame", keyEpoch: 2, aad: AAD, plaintext: PLAINTEXT });
		assert.deepEqual([bytesToHex(f1), bytesToHex(c1), bytesToHex(f2)], [GOLDEN.frame1, GOLDEN.checkpoint1, GOLDEN.frame2]);
		assert.deepEqual(await c.open({ purpose: "frame", suite: 1, keyEpoch: 1, aad: AAD, sealed: h(GOLDEN.frame1) }), { ok: true, plaintext: PLAINTEXT });
		assert.deepEqual(await c.open({ purpose: "checkpoint", suite: 1, keyEpoch: 1, aad: AAD, sealed: h(GOLDEN.checkpoint1) }), { ok: true, plaintext: PLAINTEXT });
	});

	it("adapter: sealed blob (header, padding, address-bound AAD)", async () => {
		const { c, random } = await adapter();
		c.setSealEpoch(1);
		random.push(nonce(0xa4));
		const address = GOLDEN.address as BlobAddress;
		assert.equal(bytesToHex(await c.sealBlob({ address, plaintext: PLAINTEXT })), GOLDEN.blob1);
		assert.deepEqual(await c.openBlob({ address, sealed: h(GOLDEN.blob1) }), { ok: true, plaintext: PLAINTEXT });
	});

	it("adapter: next, prev and recovery wraps, and they unwrap to the same keys", async () => {
		const { c, random } = await adapter();
		random.push(nonce(0xa5), nonce(0xa6), nonce(0xa7));
		assert.equal(bytesToHex(await c.wrap("next", 2, AAD)), GOLDEN.next2);
		assert.equal(bytesToHex(await c.wrap("prev", 2, AAD)), GOLDEN.prev2);
		assert.equal(bytesToHex(await c.wrap("recovery", 1, AAD, RK)), GOLDEN.recovery1);
		// A device holding only K_1 follows next to K_2; one holding only K_2 follows prev to K_1; RK alone gives K_1.
		for (const [role, e, held, gets, wrapped] of [["next", 2, K1, 2, GOLDEN.next2], ["prev", 2, K2, 1, GOLDEN.prev2], ["recovery", 1, null, 1, GOLDEN.recovery1]] as const) {
			const keys = held ? [{ e: gets === 2 ? 1 : 2, k: held.slice() }] : [];
			const d = await createWebCryptoSuite1({ vaultId: VAULT, random: new ScriptedRandom(), keys });
			assert.equal(await d.unwrap(role, e, AAD, h(wrapped), RK), true, role);
			assert.equal(bytesToHex(await d.kcv(gets)), gets === 1 ? GOLDEN.kcv1 : GOLDEN.kcv2, role);
		}
	});

	it("store path (WP-E6a): putSealed stores the golden bytes at blobAddress(sha256), never under the hash; another device opens them", async () => {
		const { c, random } = await adapter();
		c.setSealEpoch(2);
		random.push(nonce(0xb1));
		const objects = new Map<string, Uint8Array>();
		const store: BlobPort = {
			maxBlobBytes: 10 * 1024 * 1024,
			has: async (as) => new Set(as.filter((a) => objects.has(a))),
			put: async (a, b) => void objects.set(a, b.slice()),
			get: async (a) => objects.get(a)?.slice() ?? null,
			list: async () => { throw new Error("unused"); },
			deleteIfUploadedBefore: async () => { throw new Error("unused"); },
		};
		await putSealed(store, c, HASH, ABC);
		assert.deepEqual([...objects.keys()], [GOLDEN.address], "the K_1 address, not the sha256");
		assert.equal(bytesToHex(objects.get(GOLDEN.address)!), GOLDEN.storeAbc2);
		await putSealed(store, c, HASH, ABC);
		assert.equal(random.calls, 1, "already present (has): not sealed again");
		const reader = await createWebCryptoSuite1({ vaultId: VAULT, random: new ScriptedRandom(), keys: [{ e: 1, k: K1.slice() }, { e: 2, k: K2.slice() }] });
		reader.markVerified(1);
		reader.markVerified(2);
		const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
		assert.deepEqual(await getOpened(store, reader, HASH, sha), { ok: true, bytes: ABC });
	});
});
