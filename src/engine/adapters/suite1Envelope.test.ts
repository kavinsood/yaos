/**
 * Suite-1 envelope golden vectors, one per kind (e2ee-design §7, §20.1, WP-E2).
 * Fake K_1 = 00..1f at epoch 1, vaultId "AAAAAAAAAAAAAAAAAAAAAA", scripted
 * nonces b1..b7. Each vector is checked three ways: the core codec over the
 * WebCrypto adapter, an independent node:crypto reference written below from
 * the design text (outer header ‖ AES-GCM(HKDF subkey, AAD v2, Padmé(inner v2))),
 * and the committed hex. Then: AAD binding, header tamper, downgrade, padding.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync } from "node:crypto";
import { bytesToHex, hexToBytes } from "../../core/codec/lib0";
import { openEnvelope, sealEnvelope } from "../../core/codec/envelope";
import { padmeLen } from "../../core/codec/padme";
import { EnvelopeKindCode, type EnvelopeBinding, type EnvelopeKind } from "../../core/envelope";
import type { ClientFrameId, DeviceId, Seq, StreamName } from "../../core/types";
import { ScriptedRandom } from "./testkit/scriptedRandom";
import { createWebCryptoSuite1 } from "./webCryptoSuite1";

const VAULT = "AAAAAAAAAAAAAAAAAAAAAA";
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i);
const DEV = "dev-golden" as DeviceId;
const CF = "goldenframe00000000000" as ClientFrameId;
const DOC = "dddddddddddddddddddddd";
const HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const nonce = (b: number) => new Uint8Array(12).fill(b);

interface Vector { stream: string; kind: EnvelopeKind; authorNsSeq: number; flags: number; frameNo: number; nonce: number; coversSeq?: number }
const V: Record<string, Vector> = {
	nsOps: { stream: "ns", kind: "nsOps", authorNsSeq: 300, flags: 0, frameNo: 1, nonce: 0xb1 },
	bodyUpdate: { stream: `b:${DOC}`, kind: "bodyUpdate", authorNsSeq: 7, flags: 1, frameNo: 0, nonce: 0xb2 },
	canvasUpdate: { stream: `c:${DOC}`, kind: "canvasUpdate", authorNsSeq: 7, flags: 8, frameNo: 0, nonce: 0xb3 },
	cfgOps: { stream: "cfg", kind: "cfgOps", authorNsSeq: 12, flags: 0, frameNo: 70000, nonce: 0xb4 },
	checkpoint: { stream: "ns", kind: "checkpoint", authorNsSeq: 4242, flags: 0, frameNo: 0, nonce: 0xb5, coversSeq: 4242 },
	blobChunk: { stream: `x:${HASH}`, kind: "blobChunk", authorNsSeq: 0, flags: 0, frameNo: 0, nonce: 0xb6 },
	bodyUpdateRef: { stream: `b:${DOC}`, kind: "bodyUpdateRef", authorNsSeq: 9, flags: 2, frameNo: 0, nonce: 0xb7 },
};
const content = (name: string) => new TextEncoder().encode(`golden ${name}`);
const binding = (v: Vector): EnvelopeBinding => v.coversSeq !== undefined
	? { t: "checkpoint", stream: v.stream as StreamName, coversSeq: v.coversSeq as Seq }
	: { t: "frame", stream: v.stream as StreamName, deviceId: DEV, clientFrameId: CF };

// ---- independent reference (node:crypto) -------------------------------------------

const utf8 = (s: string) => Buffer.from(s, "utf8");
const varuint = (n: number) => { const o: number[] = []; while (n > 0x7f) { o.push(0x80 | (n & 0x7f)); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const varstring = (s: string) => Buffer.concat([varuint(utf8(s).length), utf8(s)]);
const info = (purpose: string, e: number) => Buffer.concat([utf8(`yaos/v1/${purpose}`), Buffer.from([0]), utf8(VAULT), Buffer.from([0]), varuint(e)]);
const sub = (purpose: string, e: number) => Buffer.from(hkdfSync("sha256", K1, utf8("yaos-hkdf-v1"), info(purpose, e), 32));
const gcm = (key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array) => {
	const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
	c.setAAD(aad);
	return Buffer.concat([iv, c.update(pt), c.final(), c.getAuthTag()]);
};
const padRef = (data: Uint8Array) => {
	const m = Math.max(data.length + 1, 256);
	const E = m.toString(2).length - 1;
	const step = 2 ** (E - E.toString(2).length);
	const out = Buffer.alloc(Math.ceil(m / step) * step);
	out.set(data);
	out[data.length] = 0x80;
	return out;
};
const HEADER = Buffer.from([1, 1, 1]);
const refAad = (v: Vector) => v.coversSeq !== undefined
	? Buffer.concat([utf8("yaos/c2"), HEADER, varstring(VAULT), varstring(v.stream), varuint(v.coversSeq)])
	: Buffer.concat([utf8("yaos/f2"), HEADER, varstring(VAULT), varstring(v.stream), varstring(DEV), varstring(CF)]);
const refInner = (name: string, v: Vector) =>
	Buffer.concat([Buffer.from([EnvelopeKindCode[v.kind]]), varuint(v.authorNsSeq), varuint(v.flags), varuint(v.frameNo), content(name)]);
const refSeal = (v: Vector, plaintext: Uint8Array) =>
	Buffer.concat([HEADER, gcm(sub(v.coversSeq !== undefined ? "checkpoint" : "frame", 1), nonce(v.nonce), refAad(v), plaintext)]);

// ---- committed golden hex -----------------------------------------------------------

const GOLDEN: Record<string, string> = {
	nsOps: "010101b1b1b1b1b1b1b1b1b1b1b1b125163cdb9077b11d2777c83db120ffeaf0d2929f573aacb7b2630a3e805830ae3523217e55d8008619bf9f25513873aedc424f53fb3526b9b92836a92be04a74d6165279794d5a4b4e1593841477af41fb1d62d16a6b16072b49157756d6033bc6bfafee4e848e5f168a399ba18373e160d604d7dd19b61c937ae96abe41af81b3422f2dfdc68ac38356ccf1a88187d7e82f80b8f062e462c5a76dcaddd5bbf2dd914b9ccfc47b7bc36cae5c6f907d87815e33b2d87f099ba448db0403cc3a3c2e3c10bec9e3a6430dedd1f7414da2979ace1bab54794813526e7e3dc9f927942a00fe56aac506641eb05691c6436000e379b9397f44c000055497fa02ef9cb37238b143da00f310e924140b7559b4c6",
	bodyUpdate: "010101b2b2b2b2b2b2b2b2b2b2b2b27f6405dfa1358753f01d04c3fe7e720279c819fdf3286a855d1951c1ead1071219fbbf317f760f402a475c09898d5f1c2f7c03edca7a4d5bebd1fc66331bc922a377876be3900552b8638f9dbc84259fa16cd3406fa5387f55ae0ac3d5888844aa1029d2ffaeeba1e352482c9016d18868b985ac6078b537fc6ee065b9627f698378faf32a62452777aefb11621c6cbdc03ceb7f18cb4bef56fa73c2bf40252cd4cc0fbf9947fa3f08b8ddbd8ca7afa16017658c8d4c11896e6abfdfeec801959993484a70f42d97ea2c81d2a7a49808db05ac9e291d1c722235653fe2cb9ff987eca0476566d0e93afc2da4e096576c70835f27bf7f0524380c0a5cab63b11373de1a9f29119d00a77ea7c8377b9ca8",
	canvasUpdate: "010101b3b3b3b3b3b3b3b3b3b3b3b3ceb04ad1f2c4260538aa152ea26e19d43bbb6756e3bb34b6f01aa3d4d0d42ae898ba6ee1820ff04e12dc33cd393f1fa683342c0946e8d539d59c889248411e632b04082550dc45f8e3c8d58f2b445ab18ddd810049a873178f72aadc0cbfcdc91a1453f8d33ac1a5628f93e545dfd571003dbfe70508507db445c366d275fa9269d665af5d8045e5b414d1e5998b1322068e97a74d8e6d1073d63ae4d34323558efbc3196fa3086e3136be14e6f5bdd3a2a49f5a97c5343f15013e37b9017e732b49df6c1ce555918768b1384e0d1115d6e032821d84f880dc0c707205ab2d5497ecb5453fbcf6f7de6057d53ecc2d10b97abc0b6dddc20d20485753fe7f3a1183dda525f9229c3808be36098b7d46ee",
	cfgOps: "010101b4b4b4b4b4b4b4b4b4b4b4b450bf701bc4cddb52edd0a724747265f270637a4290c58ef189c7b99f6a2154ec21d1af30dfd3fc3a282f99f2edf86e959195c99b225d5d0c321e0490592a84372eaf9889f12c7044290428694a1f5840fac447a2d181d2613ff83e9617282410a5fc3c807d2d69406e70bd4c9773b92a34f3388bccbdab43d3b62bce71108039bbc71e5df33d916c03af0d63ee997bcc7cbb935c6840f276e4ca8b953d2812d3850acee09614126ee250694fe9cf585f0d5a8a2906ac333256f9569b4b772f8ff521134e2c7c962e6608fad4cde3ea5220abe956fb87b86c65e6bcfc2a2a74f7f272ab6b0fa842cc36235306d88809de6189bdc6bd2ac1d8249799488971a2ae3cb9f30372e3e8913c176df1218f9605",
	checkpoint: "010101b5b5b5b5b5b5b5b5b5b5b5b5c744ee41bd30ff6fc7c39b1f6a0ef25f220b3c02bd930bdd4ecd4638272b31068d5de4d029c2de71c78e8aae18ec529702b3e889e08f822520404b44ef45f7f7c936b54d82a46baeac6d0f37b1d69f640136aa0a036f104571290f6c187955aaea48a058372b8381e350429be24a919fd38122f2202db1d6411e3e23ae26c1d64e4f671eb6cbeb6a607467aca88d6c7e18bf20767570d52ac6c5ef64d8e7e896e9b7906e131f20ffb3ec975617706f750d4939f1e1c56558d083b897d970c66c9733e094e4a7eed715c25c8f835f7c8ffdfcb1e07e8264ac7e58fdcb6117f406d640198d0efc151642c61dbd926f27fe78062b74c946d572ecc07c334891648b2f745eed9a9bad400038a5fe5daebdb5",
	blobChunk: "010101b6b6b6b6b6b6b6b6b6b6b6b6883f79065fec66d308ea20c88521264336fc7c38665a224da5425b6c0b9bdd711545ee2cd1d34b806ed084e0b9289bd8eb481a47744cc8b08b545094346cd8eb23de51dbc86b4b6535b7237d59679764d79e6e18e5fb87971b2f115e2d0fc26a5cbacae905f8b03cb3fb3b6491d850deaad53182819495010e817d898a56b177c84deb21766e551411f4be5d8be4e0056d942f2c3425db81644b2cd428cef4ce393854133c792e4cc5fe6eef73c47b607514477b4ab764963b19b91782eac5518b548cb14d1364bb0f56950e18322f93173dcbc5d9ade23fce64d8c2f3df315df908dcfe1aedb577d6b23208a445cfa8b99674c2b9ede28f0ce10cf23ac62a41e58a6b27b049407f9d652fd0c4c046c4",
	bodyUpdateRef: "010101b7b7b7b7b7b7b7b7b7b7b7b7864d6923e8a460a19ec26d9b78ecbf6b82ddc7150b8889590d10efb16d36d244672db6233b13bd101b3f2516c2c7a7f721edee00cafc934f2a3254b2481c954eec1dc5397e3cd500608700b516be4c4dc9b049fafda9da24507e882115affb469d4d7f1e2a86b8ffeb6ff291cec0374f6865fe87572939e7ba176e759dd2bf7efc8b9ecdcaa3803d35a0bfb0db12d2d81217d1e8e5ddf0a1315c11076ce7b9ecd01097c7a09c65df773acdb709e4f442d3362b025b6923c959efbc49f053b1a49d6b18ea582d67892e32dd95c7de9330a296c2eea823c7d30a3e8a1de8ce4ae950ce96ac7b84a376cdda5f10edebef437b4741c5d04f73d186f847e0009bbe6aba00dd64df898f331090f9d087714f86",
};

async function adapter(seal = true) {
	const random = new ScriptedRandom();
	const c = await createWebCryptoSuite1({ vaultId: VAULT, random, keys: [{ e: 1, k: K1.slice() }] });
	c.markVerified(1);
	if (seal) c.setSealEpoch(1);
	return { c, random };
}
const open = (c: Awaited<ReturnType<typeof adapter>>["c"], b: EnvelopeBinding, bytes: Uint8Array, vaultId = VAULT) =>
	openEnvelope(c, { vaultId, binding: b, bytes });

describe("suite 1 envelope golden vectors (one per kind)", () => {
	it("reference matches the committed hex", () => {
		for (const [name, v] of Object.entries(V)) assert.equal(refSeal(v, padRef(refInner(name, v))).toString("hex"), GOLDEN[name], name);
	});

	it("adapter seals every kind to the committed hex, and it opens", async () => {
		const { c, random } = await adapter();
		for (const [name, v] of Object.entries(V)) {
			random.push(nonce(v.nonce));
			const inner = { kind: v.kind, authorNsSeq: v.authorNsSeq as Seq, flags: v.flags, frameNo: v.frameNo, content: content(name) };
			const s = await sealEnvelope(c, { vaultId: VAULT, binding: binding(v), inner });
			assert.equal(bytesToHex(s.sealed), GOLDEN[name], name);
			assert.equal(s.sealed.length, 3 + 28 + padmeLen(refInner(name, v).length + 1), `${name}: Padmé-bucketed length`);
			assert.deepEqual(await open(c, binding(v), hexToBytes(GOLDEN[name]!)), { ok: true, header: { formatVersion: 1, suite: 1, keyEpoch: 1 }, inner }, name);
		}
	});

	it("sealing needs a seal epoch (no setSealEpoch, no seal)", async () => {
		const { c, random } = await adapter(false);
		random.push(nonce(1));
		const inner = { kind: "nsOps" as const, authorNsSeq: 1 as Seq, flags: 0, frameNo: 1, content: content("x") };
		await assert.rejects(sealEnvelope(c, { vaultId: VAULT, binding: binding(V.nsOps!), inner }));
	});
});

describe("suite 1 envelope: binding, tamper, downgrade, padding", () => {
	it("every AAD-bound field is bound: auth-failed when any differs", async () => {
		const { c } = await adapter();
		const H = { formatVersion: 1, suite: 1, keyEpoch: 1 };
		const ns = hexToBytes(GOLDEN.nsOps!);
		const cp = hexToBytes(GOLDEN.checkpoint!);
		const f = binding(V.nsOps!) as Extract<EnvelopeBinding, { t: "frame" }>;
		const cases: [EnvelopeBinding, Uint8Array, string, string?][] = [
			[{ ...f, deviceId: "dev-golden2" as DeviceId }, ns, "deviceId"],
			[{ ...f, clientFrameId: "goldenframe00000000001" as ClientFrameId }, ns, "clientFrameId"],
			[{ ...f, stream: "cfg" as StreamName }, ns, "stream"],
			[f, ns, "vaultId", "BAAAAAAAAAAAAAAAAAAAAA"],
			[{ t: "checkpoint", stream: "ns" as StreamName, coversSeq: 4243 as Seq }, cp, "coversSeq"],
			[{ t: "checkpoint", stream: "ns" as StreamName, coversSeq: 1 as Seq }, ns, "frame opened as checkpoint (purpose)"],
			[f, cp, "checkpoint opened as frame (purpose)"],
		];
		for (const [b, bytes, why, vault] of cases) assert.deepEqual(await open(c, b, bytes, vault), { ok: false, reason: "auth-failed", header: H }, why);
	});

	it("header tamper: relabelled epoch, unknown epoch, suite 0, format 2", async () => {
		const { c } = await adapter();
		const b = binding(V.nsOps!);
		const ns = hexToBytes(GOLDEN.nsOps!);
		const with_ = (i: number, x: number) => { const o = ns.slice(); o[i] = x; return o; };
		const k2 = await createWebCryptoSuite1({ vaultId: VAULT, random: new ScriptedRandom(), keys: [{ e: 1, k: K1.slice() }, { e: 2, k: new Uint8Array(32).fill(0x20) }] });
		assert.deepEqual(await open(k2, b, with_(2, 2)), { ok: false, reason: "auth-failed", header: { formatVersion: 1, suite: 1, keyEpoch: 2 } }, "relabelled epoch");
		assert.deepEqual(await open(c, b, with_(2, 9)), { ok: false, reason: "unknown-key", header: { formatVersion: 1, suite: 1, keyEpoch: 9 } });
		// Suite-0 bytes to a suite-1 reader (a server stripping encryption): never accepted.
		const plain = Uint8Array.from([1, 0, 0, ...refInner("nsOps", V.nsOps!)]);
		assert.deepEqual(await open(c, b, plain), { ok: false, reason: "suite-downgrade", header: { formatVersion: 1, suite: 0, keyEpoch: 0 } });
		assert.deepEqual(await open(c, b, with_(1, 0)), { ok: false, reason: "malformed" }, "suite 0 with keyEpoch 1");
		assert.deepEqual(await open(c, b, with_(0, 2)), { ok: false, reason: "unsupported-version" });
	});

	it("a valid tag over plaintext without the 0x80 marker is bad-padding (deterministic)", async () => {
		const { c } = await adapter();
		const v = V.nsOps!;
		const noMarker = Buffer.alloc(256);
		noMarker.set(refInner("nsOps", v));
		assert.deepEqual(await open(c, binding(v), refSeal(v, noMarker)), { ok: false, reason: "bad-padding", header: { formatVersion: 1, suite: 1, keyEpoch: 1 } });
		const wrongMarker = Buffer.from(noMarker);
		wrongMarker[refInner("nsOps", v).length] = 0x81;
		assert.deepEqual(await open(c, binding(v), refSeal(v, wrongMarker)), { ok: false, reason: "bad-padding", header: { formatVersion: 1, suite: 1, keyEpoch: 1 } });
		assert.deepEqual(await open(c, binding(v), refSeal(v, new Uint8Array(0))), { ok: false, reason: "bad-padding", header: { formatVersion: 1, suite: 1, keyEpoch: 1 } }, "empty");
		// §7.3 open checks the marker, not the length: a key holder's non-Padmé length still opens.
		const odd = Buffer.alloc(refInner("nsOps", v).length + 301);
		odd.set(refInner("nsOps", v));
		odd[refInner("nsOps", v).length] = 0x80;
		assert.equal((await open(c, binding(v), refSeal(v, odd))).ok, true);
	});
});
