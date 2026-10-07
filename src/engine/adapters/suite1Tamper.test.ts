/**
 * e2ee-design §20.2, measured at the crypto level (WP-E7): bit flips over every sealed type (frame, checkpoint,
 * sealed blob, k wrap and the k record around it), AAD substitution per bound field (§7.2, §11.2), cross-type
 * confusion and re-attribution. Each test counts outcomes and asserts all of them; none samples a single case.
 *
 * Real Node WebCrypto through createWebCryptoSuite1, seeded nonces (SeededRandom) and the keyring testkit's
 * fixed keys (byte ranges, not secrets). Header outcomes are predicted per flip by an independent model of the
 * §7.1 / §10.2 header rules written below, so the exact per-reason counts are asserted, not just "it failed".
 * YAOS_TAMPER_REPORT=1 prints the counts (counts only: never key bytes).
 *
 * §20.2 says "header → auth-failed or malformed". The header rules in §9.2 (open-failure table) and §10.2 (and the code) also
 * yield unsupported-version, unsupported-suite, suite-downgrade and unknown-key for a relabelled header; every one
 * of them is still a failure, and the counts below pin each.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { checkpointAad, encodeOuter, frameAad } from "../../core/codec/envelope";
import { Writer, concatBytes, utf8Encode } from "../../core/codec/lib0";
import { blobAad } from "../../core/codec/sealedBlob";
import { AAD_BLOB_PREFIX, AAD_KEYRING_PREFIX, type EnvelopeBinding, type EnvelopeHeader, type EnvelopeKind } from "../../core/envelope";
import type { ClientFrameId, ContentHash, DeviceId, Seq, StreamName, VaultId } from "../../core/types";
import type { BlobAddress, WrapRole } from "../../ports/crypto";
import { SeededRandom } from "../../sim/random";
import { openEnvelope, sealCheckpoint, sealFrame } from "../ingest/envelope";
import { gate, type GateCtx } from "../ingest/gate";
import { KeyRecordKind, decodeKeyRecord, wrapAad, wrapsOf, type KeyRecord } from "../keyring/record";
import { K, RK_A, VAULT, genesis, revoke, roll } from "../keyring/testkit/world";
import { deriveSubkey, gcmOpen, importBase } from "./suite1Primitives";
import { createWebCryptoSuite1, type Suite1Crypto } from "./webCryptoSuite1";

const V = VAULT as VaultId;
/** Seal epoch of the main port. Held: 1, 2, 3, so a keyEpoch flip 2 ^ 0x01 = 3 lands on a held key. */
const SEAL_E = 2;
const HELD: ReadonlySet<number> = new Set([1, 2, 3]);
const EVERY_BYTE_MAX = 4096;
const SAMPLED = 4096;
const NONCE = 12;
const TAG = 16;
const DEV = "dev-tamper-0000" as DeviceId;
const CF = "tamperframe00000000000" as ClientFrameId;
const DOC = "dddddddddddddddddddddd";
const HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" as ContentHash;
const ROLE_CODE: Readonly<Record<WrapRole, number>> = { next: 1, prev: 2, recovery: 3 };
const ROLES: readonly WrapRole[] = ["next", "prev", "recovery"];

const REPORT = process.env.YAOS_TAMPER_REPORT === "1";
const report = (label: string, data: unknown): void => {
	if (REPORT) console.log(`[tamper] ${label} ${JSON.stringify(data)}`);
};

// ---- helpers ------------------------------------------------------------------------

type Tally = Record<string, Record<string, number>>;
function bump(t: Tally, group: string, reason: string): void {
	const g = (t[group] ??= {});
	g[reason] = (g[reason] ?? 0) + 1;
}
const total = (t: Tally): number => Object.values(t).reduce((s, g) => s + Object.values(g).reduce((a, b) => a + b, 0), 0);
const count = (t: Tally, group: string): number => Object.values(t[group] ?? {}).reduce((a, b) => a + b, 0);
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);
const flip = (b: Uint8Array, p: number, mask: number): Uint8Array => {
	const o = b.slice();
	o[p] = o[p]! ^ mask;
	return o;
};

async function inBatches<T, R>(items: readonly T[], fn: (x: T, i: number) => Promise<R>, size = 512): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map((x, j) => fn(x, i + j)))));
	return out;
}

/** Main port: K_1..K_3 held and verified, sealing under SEAL_E, nonces from a seeded RandomPort. */
async function mainPort(seed = 7): Promise<Suite1Crypto> {
	const c = await createWebCryptoSuite1({ vaultId: VAULT, random: new SeededRandom(seed), keys: [1, 2, 3].map((e) => ({ e, k: K(e) })) });
	for (const e of [1, 2, 3]) c.markVerified(e);
	c.setSealEpoch(SEAL_E);
	return c;
}

/** A port holding the given keys (not verified: open and unwrap do not need it). */
const port = (keys: readonly { readonly e: number; readonly k: Uint8Array }[], vaultId = VAULT, seed = 11) =>
	createWebCryptoSuite1({ vaultId, random: new SeededRandom(seed), keys: keys.map((x) => ({ e: x.e, k: x.k.slice() })) });

type Region = "header" | "nonce" | "ciphertext" | "tag";
function regionOf(p: number, headerLen: number, n: number): Region {
	if (p < headerLen) return "header";
	if (p < headerLen + NONCE) return "nonce";
	if (p >= n - TAG) return "tag";
	return "ciphertext";
}

/**
 * §20.2: every byte for objects ≤ 4 KiB; otherwise 4096 seeded distinct positions, made of every header, nonce
 * and tag byte plus seeded ciphertext positions.
 */
function flipPositions(n: number, headerLen: number, rng: SeededRandom): number[] {
	if (n <= EVERY_BYTE_MAX) return range(0, n);
	const fixed = [...range(0, headerLen + NONCE), ...range(n - TAG, n)];
	const ct = range(headerLen + NONCE, n - TAG);
	const need = SAMPLED - fixed.length;
	for (let i = 0; i < need; i++) {
		const j = i + rng.int(ct.length - i);
		const t = ct[i]!;
		ct[i] = ct[j]!;
		ct[j] = t;
	}
	return [...fixed, ...ct.slice(0, need)].sort((a, b) => a - b);
}

/** Independent minimal-LEB128 reader (§7.1 varuint): the value, or null when truncated or non-minimal. */
function modelVaruint(b: Uint8Array, at: number): number | null {
	let v = 0;
	let mul = 1;
	for (let i = 0; i < 8; i++) {
		const x = b[at + i];
		if (x === undefined) return null;
		v += (x & 0x7f) * mul;
		if (x < 0x80) return i > 0 && x === 0 ? null : v;
		mul *= 0x80;
	}
	return null;
}

/** §7.1 / §9.2 outcome of an envelope whose 3-byte header was relabelled, for a reader holding `held`. */
function modelEnvelopeHeader(b: Uint8Array, held: ReadonlySet<number>): string {
	if (b[0] !== 1) return "unsupported-version";
	const suite = b[1]!;
	if (suite !== 0 && suite !== 1) return "unsupported-suite";
	const e = modelVaruint(b, 2);
	if (e === null || (suite === 0) !== (e === 0)) return "malformed";
	if (suite === 0) return "suite-downgrade";
	return held.has(e) ? "auth-failed" : "unknown-key";
}

/** §10.2 outcome of a sealed blob whose header was relabelled. */
function modelBlobHeader(b: Uint8Array, held: ReadonlySet<number>): string {
	if (b[0] !== 1 || b[1] !== 1) return "unsupported-suite";
	const e = modelVaruint(b, 2);
	if (e === null || e === 0) return "malformed";
	return held.has(e) ? "auth-failed" : "unknown-key";
}

interface FlipRun {
	readonly flips: number;
	readonly failures: number;
	readonly got: Tally;
	readonly want: Tally;
}

/**
 * Flips every chosen byte with mask 0x01, then again with a seeded nonzero mask. `open` returns "ok" or a failure
 * reason; nonce, ciphertext and tag must give `bodyReason`, the header what `header` predicts.
 */
async function flipRun(bytes: Uint8Array, headerLen: number, open: (b: Uint8Array) => Promise<string>, header: (b: Uint8Array) => string, seed: number, bodyReason = "auth-failed"): Promise<{ readonly x01: FlipRun; readonly rand: FlipRun; readonly positions: number }> {
	const rng = new SeededRandom(seed);
	const pos = flipPositions(bytes.length, headerLen, rng);
	const pass = async (mask: (i: number) => number): Promise<FlipRun> => {
		const got: Tally = {};
		const want: Tally = {};
		let failures = 0;
		const masks = pos.map((_, i) => mask(i));
		const results = await inBatches(pos, (p, i) => open(flip(bytes, p, masks[i]!)), bytes.length > 16384 ? 128 : 512);
		pos.forEach((p, i) => {
			const r = regionOf(p, headerLen, bytes.length);
			const reason = results[i]!;
			if (reason !== "ok") failures++;
			bump(got, r, reason);
			bump(want, r, r === "header" ? header(flip(bytes, p, masks[i]!)) : bodyReason);
		});
		return { flips: pos.length, failures, got, want };
	};
	const x01 = await pass(() => 0x01);
	const rand = await pass(() => 1 + rng.int(255));
	return { x01, rand, positions: pos.length };
}

function assertRun(label: string, run: { readonly x01: FlipRun; readonly rand: FlipRun; readonly positions: number }, n: number, headerLen: number): void {
	const expected = n <= EVERY_BYTE_MAX ? n : SAMPLED;
	assert.equal(run.positions, expected, `${label}: positions`);
	for (const [name, r] of [["x01", run.x01], ["rand", run.rand]] as const) {
		assert.equal(r.flips, expected, `${label} ${name}: flips`);
		assert.equal(r.failures, r.flips, `${label} ${name}: failures == flips`);
		assert.equal(total(r.got), r.flips, `${label} ${name}: every flip counted`);
		assert.deepEqual(r.got, r.want, `${label} ${name}: reason per region`);
		assert.equal(count(r.got, "header"), headerLen, `${label} ${name}: header bytes`);
		assert.equal(count(r.got, "nonce"), NONCE, `${label} ${name}: nonce bytes`);
		assert.equal(count(r.got, "tag"), TAG, `${label} ${name}: tag bytes`);
		assert.equal(count(r.got, "ciphertext"), expected - headerLen - NONCE - TAG, `${label} ${name}: ciphertext bytes`);
	}
	report(label, { bytes: n, positions: run.positions, x01: run.x01.got, rand: run.rand.got });
}

const frameBinding = (stream: string, deviceId: string = DEV, clientFrameId: string = CF): EnvelopeBinding =>
	({ t: "frame", stream: stream as StreamName, deviceId: deviceId as DeviceId, clientFrameId: clientFrameId as ClientFrameId });
const ckptBinding = (stream: string, coversSeq: number): EnvelopeBinding => ({ t: "checkpoint", stream: stream as StreamName, coversSeq: coversSeq as Seq });
const openFrame = async (c: Suite1Crypto, b: EnvelopeBinding, bytes: Uint8Array, vaultId: string = VAULT): Promise<string> => {
	const r = await openEnvelope(c, vaultId as VaultId, b, bytes);
	return r.ok ? "ok" : r.reason;
};
const openBlobR = async (c: Suite1Crypto, address: string, sealed: Uint8Array): Promise<string> => {
	const r = await c.openBlob({ address: address as BlobAddress, sealed });
	return r.ok ? "ok" : r.reason;
};

async function seal(c: Suite1Crypto, stream: string, kind: EnvelopeKind, content: Uint8Array, o: { deviceId?: string; clientFrameId?: string } = {}): Promise<Uint8Array> {
	const frameNo = kind === "nsOps" || kind === "cfgOps" ? 1 : 0;
	const s = await sealFrame(c, V, {
		stream: stream as StreamName, deviceId: (o.deviceId ?? DEV) as DeviceId, clientFrameId: (o.clientFrameId ?? CF) as ClientFrameId,
		kind, authorNsSeq: 17 as Seq, flags: 0, frameNo, content,
	});
	assert.equal(s.keyEpoch, SEAL_E);
	return s.sealed;
}

/** Hand-built blob AAD (§7.2), so blobFormat can be substituted too; checked equal to blobAad for the true values. */
function blobAadBy(o: { fmt?: number; suite?: number; e?: number; vaultId?: string; address: string }): Uint8Array {
	return new Writer(160).raw(utf8Encode(AAD_BLOB_PREFIX)).u8(o.fmt ?? 1).u8(o.suite ?? 1).varuint(o.e ?? SEAL_E).varstring(o.vaultId ?? VAULT).varstring(o.address).finish();
}

/** Hand-built wrap AAD (§11.2), so recordFormat, suite and role codes outside the enum can be substituted. */
function wrapAadBy(r: KeyRecord, role: WrapRole, o: { fmt?: number; suite?: number; vaultId?: string; e?: number; kind?: number; prevEpoch?: number; kcv?: Uint8Array; role?: number } = {}): Uint8Array {
	return new Writer(128)
		.raw(utf8Encode(AAD_KEYRING_PREFIX)).u8(o.fmt ?? 1).u8(o.suite ?? 1).varstring(o.vaultId ?? VAULT)
		.varuint(o.e ?? r.e).u8(o.kind ?? r.kind).varuint(o.prevEpoch ?? r.prevEpoch).fixed(o.kcv ?? r.kcv, 16).u8(o.role ?? ROLE_CODE[role])
		.finish();
}

const wrapOf = (r: KeyRecord, role: WrapRole): Uint8Array => (role === "next" ? r.nextWrap : role === "prev" ? r.prevWrap : r.recoveryWrap);
const presentRoles = (r: KeyRecord): WrapRole[] => ROLES.filter((role) => wrapsOf(r.kind)[role]);
/** The epoch whose key a wrap of `role` in a record for e is sealed under (§11.1), null for the RK. */
const byEpoch = (role: WrapRole, e: number): number | null => (role === "next" ? e - 1 : role === "prev" ? e : null);
const ofEpoch = (role: WrapRole, e: number): number => (role === "prev" ? e - 1 : e);
/** A reader holding only the key that opens `role` for a record of e (so a successful unwrap would install the other one). */
const readerFor = (role: WrapRole, e: number): Promise<Suite1Crypto> => {
	const by = byEpoch(role, e);
	return port(by === null ? [] : [{ e: by, k: K(by) }]);
};
const decoded = (bytes: Uint8Array): KeyRecord => {
	const r = decodeKeyRecord(bytes);
	assert.ok(r, "testkit record decodes");
	return r;
};

/** n distinct strings from `make`, none equal to `not`. */
function distinct(n: number, not: string, make: (i: number) => string): string[] {
	const out = new Set<string>();
	for (let i = 0; out.size < n; i++) {
		const s = make(i);
		if (s !== not) out.add(s);
	}
	return [...out];
}
const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const randId = (rng: SeededRandom, len: number): string => Array.from({ length: len }, () => b64[rng.int(64)]!).join("");
const vaultSubs = (rng: SeededRandom): string[] =>
	distinct(64, VAULT, (i) => (i === 0 ? "" : i === 1 ? `${VAULT}A` : i === 2 ? VAULT.slice(1) : i === 3 ? VAULT.toLowerCase() : randId(rng, 22)));
const u8Subs = (not: number): number[] => range(0, 256).filter((v) => v !== not);
const epochSubs = (not: number): number[] => [...new Set([0, 1, 3, 4, 5, 6, 7, 8, 127, 128, 255, 256, 16383, 16384, 2 ** 31, 2 ** 53 - 1, ...range(9, 60)])].filter((v) => v !== not).slice(0, 64);

// ---- 1. bit flips ---------------------------------------------------------------------

describe("§20.2 bit flips: every sealed type, every region (measured)", () => {
	it("frames: 287 B nsOps and 3103 B body (every byte), 64 KiB blobChunk (4096 seeded positions)", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(101);
		const objects: [string, string, EnvelopeKind, number][] = [["frame nsOps", "ns", "nsOps", 100], ["frame bodyUpdate", `b:${DOC}`, "bodyUpdate", 3000], ["frame blobChunk 64KiB", `x:${HASH}`, "blobChunk", 65536]];
		for (const [label, stream, kind, n] of objects) {
			const bytes = await seal(c, stream, kind, rng.bytes(n));
			assert.equal(await openFrame(c, frameBinding(stream), bytes), "ok", `${label}: control opens`);
			const run = await flipRun(bytes, 3, (b) => openFrame(c, frameBinding(stream), b), (b) => modelEnvelopeHeader(b, HELD), n);
			assertRun(label, run, bytes.length, 3);
			// The 0x01 pass is seed-independent: format 1→0, suite 1→0 (keyEpoch ≠ 0), keyEpoch 2→3 (held, wrong key and AAD).
			assert.deepEqual(run.x01.got.header, { "unsupported-version": 1, malformed: 1, "auth-failed": 1 }, label);
		}
	});

	it("checkpoints: 1 KiB (every byte) and 64 KiB (4096 seeded positions)", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(202);
		for (const [label, stream, coversSeq, n] of [["checkpoint 1KiB", "ns", 4242, 1000], ["checkpoint 64KiB", `b:${DOC}`, 99, 65536]] as const) {
			const bytes = await sealCheckpoint(c, V, stream as StreamName, coversSeq as Seq, rng.bytes(n), 5 as Seq);
			const b = ckptBinding(stream, coversSeq);
			assert.equal(await openFrame(c, b, bytes), "ok", `${label}: control opens`);
			const run = await flipRun(bytes, 3, (x) => openFrame(c, b, x), (x) => modelEnvelopeHeader(x, HELD), n + 1);
			assertRun(label, run, bytes.length, 3);
			assert.deepEqual(run.x01.got.header, { "unsupported-version": 1, malformed: 1, "auth-failed": 1 }, label);
		}
	});

	it("sealed blobs: 1000 B (every byte) and 64 KiB (4096 seeded positions)", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(303);
		const address = await c.blobAddress(HASH);
		for (const [label, n] of [["blob 1000B", 1000], ["blob 64KiB", 65536]] as const) {
			const pt = rng.bytes(n);
			const bytes = concatBytes(await c.sealBlob({ address, plaintext: pt }));
			assert.deepEqual(await c.openBlob({ address, sealed: bytes }), { ok: true, plaintext: pt }, `${label}: control opens`);
			const run = await flipRun(bytes, 3, (x) => openBlobR(c, address, x), (x) => modelBlobHeader(x, HELD), n + 2);
			assertRun(label, run, bytes.length, 3);
			// blobFormat 1→0 and suite 1→0 are unsupported-suite (§10.2); keyEpoch 2→3 is held: auth-failed.
			assert.deepEqual(run.x01.got.header, { "unsupported-suite": 2, "auth-failed": 1 }, label);
		}
	});

	it("k wraps: every byte of every next, prev and recovery wrap; unwrap is false for each and installs nothing", async () => {
		const recs: [string, KeyRecord][] = [["genesis", decoded(await genesis())], ["roll 2", decoded(await roll(2))], ["revoke 3", decoded(await revoke(3))]];
		let wraps = 0;
		for (const [name, r] of recs) {
			for (const role of presentRoles(r)) {
				const reader = await readerFor(role, r.e);
				const aad = wrapAad(VAULT, r, role);
				const w = wrapOf(r, role);
				assert.equal(w.length, 60);
				const run = await flipRun(w, 0, async (b) => ((await reader.unwrap(role, r.e, aad, b, RK_A.slice())) ? "ok" : "false"), () => "n/a", 400 + wraps, "false");
				assertRun(`wrap ${name} ${role}`, run, 60, 0);
				assert.equal(reader.keyState(ofEpoch(role, r.e)).held, false, `${name} ${role}: no flipped wrap installed a key`);
				assert.equal(await reader.unwrap(role, r.e, aad, w, RK_A.slice()), true, `${name} ${role}: control unwraps`);
				wraps++;
			}
		}
		assert.equal(wraps, 5, "genesis recovery, roll next + prev, revoke prev + recovery");
	});

	it("k records: every byte of genesis, roll and revoke; head flips are not records or fail every wrap, wrap flips fail that wrap", async () => {
		const out: Tally = {};
		let flips = 0;
		for (const [name, bytes] of [["genesis", await genesis()], ["roll 2", await roll(2)], ["revoke 2", await revoke(2)]] as const) {
			const r = decoded(bytes);
			const headLen = 2 + 1 + 1 + 1 + 16; // e and prevEpoch are one-byte varuints here
			const fields: { role: WrapRole; lenAt: number; from: number; to: number }[] = [];
			let at = headLen;
			for (const role of ROLES) {
				const n = wrapOf(r, role).length;
				fields.push({ role, lenAt: at, from: at + 1, to: at + 1 + n });
				at += 1 + n;
			}
			assert.equal(at, bytes.length, `${name}: layout`);
			const readers = new Map<WrapRole, Suite1Crypto>();
			for (const role of presentRoles(r)) readers.set(role, await readerFor(role, r.e));
			const rng = new SeededRandom(500 + bytes.length);
			for (const mask of [() => 0x01, () => 1 + rng.int(255)]) {
				const masks = range(0, bytes.length).map(() => mask());
				await inBatches(range(0, bytes.length), async (p, i) => {
					flips++;
					const region = p < headLen ? "head" : fields.some((f) => f.lenAt === p) ? "length" : `wrap ${fields.find((f) => p >= f.from && p < f.to)!.role}`;
					const d = decodeKeyRecord(flip(bytes, p, masks[i]!));
					if (!d) return bump(out, `${name} ${region}`, "not-a-record");
					assert.notEqual(region, "length", `${name}: a flipped wrap length never decodes`);
					// Head: the AAD of every wrap changed. Wrap body: that wrap changed.
					const roles = region === "head" ? presentRoles(d) : [fields.find((f) => p >= f.from && p < f.to)!.role];
					const opened = await Promise.all(roles.map((role) => readers.get(role)!.unwrap(role, d.e, wrapAad(VAULT, d, role), wrapOf(d, role), RK_A.slice())));
					bump(out, `${name} ${region}`, opened.every((x) => !x) ? (region === "head" ? "every-wrap-false" : "wrap-false") : "OPENED");
				}, 64);
			}
			for (const [role, reader] of readers) assert.equal(reader.keyState(ofEpoch(role, r.e)).held, false, `${name} ${role}: nothing installed`);
		}
		report("k records", out);
		assert.equal(flips, 2 * (84 + 144 + 144));
		assert.equal(total(out), flips);
		for (const [group, reasons] of Object.entries(out)) {
			assert.equal(reasons.OPENED, undefined, `${group}: a flipped record never yields a key`);
			if (group.endsWith("length")) assert.deepEqual(Object.keys(reasons), ["not-a-record"], group);
		}
		// A single flipped head byte decodes only inside the kcv (format, suite, e, kind, prevEpoch are all checked).
		for (const name of ["genesis", "roll 2", "revoke 2"]) {
			assert.equal(out[`${name} head`]!["every-wrap-false"], 32, `${name}: 16 kcv bytes × 2 passes fail every wrap`);
			assert.equal(out[`${name} head`]!["not-a-record"], 10, `${name}: 5 header bytes × 2 passes are not records`);
			for (const role of presentRoles(decoded(name === "genesis" ? await genesis() : name === "roll 2" ? await roll(2) : await revoke(2)))) {
				assert.deepEqual(out[`${name} wrap ${role}`], { "wrap-false": 120 }, `${name} ${role}: 60 bytes × 2 passes`);
			}
		}
	});
});

// ---- 2. AAD substitution --------------------------------------------------------------

describe("§20.2 AAD substitution: every bound field, auth-failed 100% (measured)", () => {
	it("frames: vaultId, stream, deviceId, clientFrameId via the binding; keyEpoch, suite, formatVersion via the header and directly", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(601);
		const bytes = await seal(c, "ns", "nsOps", rng.bytes(64));
		const sealedPart = bytes.subarray(3);
		const H: EnvelopeHeader = { formatVersion: 1, suite: 1, keyEpoch: SEAL_E };
		const out: Tally = {};
		const tally = async (field: string, xs: readonly (() => Promise<string>)[]) => {
			for (const r of await inBatches(xs, (f) => f())) bump(out, field, r);
		};
		await tally("vaultId", vaultSubs(rng).map((v) => () => openFrame(c, frameBinding("ns"), bytes, v)));
		await tally("stream", distinct(64, "ns", (i) => ["cfg", "snap", "k", "", "NS", "ns ", `b:${DOC}`, `c:${DOC}`, `x:${HASH}`][i] ?? `b:${randId(rng, 22)}`).map((s) => () => openFrame(c, frameBinding(s), bytes)));
		await tally("deviceId", distinct(64, DEV, (i) => (i === 0 ? "" : i === 1 ? `${DEV}x` : `dev-${randId(rng, 11)}`)).map((d) => () => openFrame(c, frameBinding("ns", d), bytes)));
		await tally("clientFrameId", distinct(64, CF, (i) => (i === 0 ? "" : randId(rng, 22))).map((f) => () => openFrame(c, frameBinding("ns", DEV, f), bytes)));
		// Header fields, directly: same key (epoch 2, kFrame), AAD built with the substituted value.
		const direct = (h: EnvelopeHeader) => async () => {
			const r = await c.open({ purpose: "frame", suite: 1, keyEpoch: SEAL_E, aad: frameAad(h, VAULT, "ns", DEV, CF), sealed: sealedPart });
			return r.ok ? "ok" : r.reason;
		};
		await tally("keyEpoch (AAD only)", epochSubs(SEAL_E).map((e) => direct({ ...H, keyEpoch: e })));
		await tally("suite (AAD only)", u8Subs(1).map((s) => direct({ ...H, suite: s as 0 | 1 })));
		await tally("formatVersion (AAD only)", u8Subs(1).map((f) => direct({ ...H, formatVersion: f })));
		// Header fields as the server would relabel them: the realistic reader (K_1..K_3) and one holding K_2's bytes at every epoch 1..65.
		const sameKey = await port(range(1, 66).map((e) => ({ e, k: K(SEAL_E) })));
		const relabel = (e: number) => (e === 0 ? Uint8Array.from([1, 1, 0, ...sealedPart]) : encodeOuter({ ...H, keyEpoch: e }, sealedPart));
		await tally("keyEpoch (header, reader K1-K3)", epochSubs(SEAL_E).map((e) => () => openFrame(c, frameBinding("ns"), relabel(e))));
		await tally("keyEpoch (header, same key at 1..65)", range(1, 66).filter((e) => e !== SEAL_E).map((e) => () => openFrame(sameKey, frameBinding("ns"), relabel(e))));
		await tally("suite (header)", u8Subs(1).map((s) => () => openFrame(c, frameBinding("ns"), Uint8Array.from([1, s, SEAL_E, ...sealedPart]))));
		await tally("suite (header, stripped to suite 0)", [() => openFrame(c, frameBinding("ns"), Uint8Array.from([1, 0, 0, ...sealedPart]))]);
		await tally("formatVersion (header)", u8Subs(1).map((f) => () => openFrame(c, frameBinding("ns"), Uint8Array.from([f, 1, SEAL_E, ...sealedPart]))));
		// Transplant: another vault's port with the same raw keys (HKDF info binds vaultId too, §5.1).
		const other = await port([1, 2, 3].map((e) => ({ e, k: K(e) })), "BBBBBBBBBBBBBBBBBBBBBB");
		await tally("vaultId (other vault's port, same raw keys)", [() => openFrame(other, frameBinding("ns"), bytes, "BBBBBBBBBBBBBBBBBBBBBB"), () => openFrame(other, frameBinding("ns"), bytes)]);
		report("AAD frames", out);
		assert.equal(await openFrame(c, frameBinding("ns"), bytes), "ok", "control");
		const want = (n: number) => ({ "auth-failed": n });
		assert.deepEqual(out, {
			vaultId: want(64), stream: want(64), deviceId: want(64), clientFrameId: want(64),
			"keyEpoch (AAD only)": want(64), "suite (AAD only)": want(255), "formatVersion (AAD only)": want(255),
			// e = 0 is malformed (suite 1 needs ≥ 1); 1 and 3 are held (wrong key and AAD); the rest are not held.
			"keyEpoch (header, reader K1-K3)": { malformed: 1, "auth-failed": 2, "unknown-key": 61 },
			"keyEpoch (header, same key at 1..65)": want(64),
			"suite (header)": { malformed: 1, "unsupported-suite": 254 },
			"suite (header, stripped to suite 0)": { "suite-downgrade": 1 },
			"formatVersion (header)": { "unsupported-version": 255 },
			"vaultId (other vault's port, same raw keys)": want(2),
		});
	});

	it("checkpoints: vaultId, stream, coversSeq via the binding; keyEpoch and suite via the header and directly", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(602);
		const coversSeq = 4242;
		const bytes = await sealCheckpoint(c, V, "ns" as StreamName, coversSeq as Seq, rng.bytes(300), 5 as Seq);
		const sealedPart = bytes.subarray(3);
		const H: EnvelopeHeader = { formatVersion: 1, suite: 1, keyEpoch: SEAL_E };
		const out: Tally = {};
		const tally = async (field: string, xs: readonly (() => Promise<string>)[]) => {
			for (const r of await inBatches(xs, (f) => f())) bump(out, field, r);
		};
		await tally("vaultId", vaultSubs(rng).map((v) => () => openFrame(c, ckptBinding("ns", coversSeq), bytes, v)));
		await tally("stream", distinct(64, "ns", (i) => ["cfg", "snap", `b:${DOC}`, `c:${DOC}`, "NS"][i] ?? `b:${randId(rng, 22)}`).map((s) => () => openFrame(c, ckptBinding(s, coversSeq), bytes)));
		const seqs = [...new Set([0, 1, coversSeq - 1, coversSeq + 1, 2 ** 53 - 1, 127, 128, ...Array.from({ length: 80 }, () => rng.int(2 ** 31))])].filter((s) => s !== coversSeq).slice(0, 64);
		await tally("coversSeq", seqs.map((s) => () => openFrame(c, ckptBinding("ns", s), bytes)));
		const direct = (h: EnvelopeHeader) => async () => {
			const r = await c.open({ purpose: "checkpoint", suite: 1, keyEpoch: SEAL_E, aad: checkpointAad(h, VAULT, "ns", coversSeq as Seq), sealed: sealedPart });
			return r.ok ? "ok" : r.reason;
		};
		await tally("keyEpoch (AAD only)", epochSubs(SEAL_E).map((e) => direct({ ...H, keyEpoch: e })));
		await tally("suite (AAD only)", u8Subs(1).map((s) => direct({ ...H, suite: s as 0 | 1 })));
		const sameKey = await port(range(1, 66).map((e) => ({ e, k: K(SEAL_E) })));
		await tally("keyEpoch (header, same key at 1..65)", range(1, 66).filter((e) => e !== SEAL_E).map((e) => () => openFrame(sameKey, ckptBinding("ns", coversSeq), encodeOuter({ ...H, keyEpoch: e }, sealedPart))));
		await tally("suite (header)", u8Subs(1).map((s) => () => openFrame(c, ckptBinding("ns", coversSeq), Uint8Array.from([1, s, SEAL_E, ...sealedPart]))));
		report("AAD checkpoints", out);
		assert.equal(await openFrame(c, ckptBinding("ns", coversSeq), bytes), "ok", "control");
		assert.deepEqual(out, {
			vaultId: { "auth-failed": 64 }, stream: { "auth-failed": 64 }, coversSeq: { "auth-failed": 64 },
			"keyEpoch (AAD only)": { "auth-failed": 64 }, "suite (AAD only)": { "auth-failed": 255 },
			"keyEpoch (header, same key at 1..65)": { "auth-failed": 64 },
			"suite (header)": { malformed: 1, "unsupported-suite": 254 },
		});
	});

	it("blobs: address via openBlob; vaultId, keyEpoch, suite, blobFormat via the header and directly under kBlob", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(603);
		const address = await c.blobAddress(HASH);
		const bytes = concatBytes(await c.sealBlob({ address, plaintext: rng.bytes(500) }));
		const body = bytes.subarray(3);
		assert.deepEqual(blobAadBy({ address }), blobAad(1, SEAL_E, VAULT, address), "hand-built AAD matches the codec");
		const kBlob = await deriveSubkey(crypto.subtle, await importBase(crypto.subtle, K(SEAL_E)), "blob", VAULT, SEAL_E);
		const out: Tally = {};
		const tally = async (field: string, xs: readonly (() => Promise<string>)[]) => {
			for (const r of await inBatches(xs, (f) => f())) bump(out, field, r);
		};
		const direct = (aad: Uint8Array) => async () => {
			const r = await gcmOpen(crypto.subtle, kBlob, aad, body);
			return typeof r === "string" ? r : "ok";
		};
		assert.equal(await direct(blobAadBy({ address }))(), "ok", "direct control");
		await tally("address", distinct(64, address, (i) => (i === 0 ? "" : i === 1 ? HASH : Array.from({ length: 64 }, () => "0123456789abcdef"[rng.int(16)]).join(""))).map((a) => () => openBlobR(c, a, bytes)));
		await tally("vaultId (AAD only)", vaultSubs(rng).map((v) => direct(blobAadBy({ address, vaultId: v }))));
		await tally("keyEpoch (AAD only)", epochSubs(SEAL_E).map((e) => direct(blobAadBy({ address, e }))));
		await tally("suite (AAD only)", u8Subs(1).map((s) => direct(blobAadBy({ address, suite: s }))));
		await tally("blobFormat (AAD only)", u8Subs(1).map((f) => direct(blobAadBy({ address, fmt: f }))));
		const sameKey = await port(range(1, 66).map((e) => ({ e, k: K(SEAL_E) })));
		await tally("keyEpoch (header, same key at 1..65)", range(1, 66).filter((e) => e !== SEAL_E).map((e) => () => openBlobR(sameKey, address, Uint8Array.from([1, 1, e, ...body]))));
		await tally("keyEpoch (header, reader K1-K3)", range(0, 128).filter((e) => e !== SEAL_E).map((e) => () => openBlobR(c, address, Uint8Array.from([1, 1, e, ...body]))));
		await tally("suite (header)", u8Subs(1).map((s) => () => openBlobR(c, address, Uint8Array.from([1, s, SEAL_E, ...body]))));
		await tally("blobFormat (header)", u8Subs(1).map((f) => () => openBlobR(c, address, Uint8Array.from([f, 1, SEAL_E, ...body]))));
		const other = await port([1, 2, 3].map((e) => ({ e, k: K(e) })), "BBBBBBBBBBBBBBBBBBBBBB");
		await tally("vaultId (other vault's port, same raw keys)", [() => openBlobR(other, address, bytes)]);
		report("AAD blobs", out);
		assert.deepEqual(await c.openBlob({ address, sealed: bytes }).then((r) => r.ok), true, "control");
		assert.deepEqual(out, {
			address: { "auth-failed": 64 },
			"vaultId (AAD only)": { "auth-failed": 64 }, "keyEpoch (AAD only)": { "auth-failed": 64 },
			"suite (AAD only)": { "auth-failed": 255 }, "blobFormat (AAD only)": { "auth-failed": 255 },
			"keyEpoch (header, same key at 1..65)": { "auth-failed": 64 },
			"keyEpoch (header, reader K1-K3)": { malformed: 1, "auth-failed": 2, "unknown-key": 124 },
			"suite (header)": { "unsupported-suite": 255 }, "blobFormat (header)": { "unsupported-suite": 255 },
			"vaultId (other vault's port, same raw keys)": { "auth-failed": 1 },
		});
	});

	it("k wraps: vaultId, e, kind, prevEpoch, kcv, role, recordFormat and suite, AAD-only under the same unwrapping key", async () => {
		const rng = new SeededRandom(604);
		const recs: [string, KeyRecord][] = [["genesis", decoded(await genesis())], ["roll 2", decoded(await roll(2))], ["revoke 3", decoded(await revoke(3))]];
		const out: Tally = {};
		for (const [name, r] of recs) {
			for (const role of presentRoles(r)) {
				const reader = await readerFor(role, r.e);
				const w = wrapOf(r, role);
				assert.deepEqual(wrapAadBy(r, role), wrapAad(VAULT, r, role), "hand-built AAD matches the codec");
				const subs: [string, Uint8Array[]][] = [
					["vaultId", vaultSubs(rng).map((v) => wrapAadBy(r, role, { vaultId: v }))],
					["e", epochSubs(r.e).map((e) => wrapAadBy(r, role, { e }))],
					["kind", u8Subs(r.kind).map((kind) => wrapAadBy(r, role, { kind }))],
					["prevEpoch", epochSubs(r.prevEpoch).map((prevEpoch) => wrapAadBy(r, role, { prevEpoch }))],
					["kcv", Array.from({ length: 64 }, (_, i) => { const k = r.kcv.slice(); k[i % 16] = k[i % 16]! ^ (1 + rng.int(255)); return wrapAadBy(r, role, { kcv: i < 16 ? k : rng.bytes(16) }); })],
					["role", u8Subs(ROLE_CODE[role]).map((code) => wrapAadBy(r, role, { role: code }))],
					["recordFormat", u8Subs(1).map((fmt) => wrapAadBy(r, role, { fmt }))],
					["suite", u8Subs(1).map((suite) => wrapAadBy(r, role, { suite }))],
				];
				for (const [field, aads] of subs) {
					const res = await inBatches(aads, (aad) => reader.unwrap(role, r.e, aad, w, RK_A.slice()), 128);
					for (const ok of res) bump(out, field, ok ? "OPENED" : "false");
				}
				// e as a reader would see it: the unwrapping key changes too (or is not held).
				const res = await inBatches(epochSubs(r.e).filter((e) => e >= 1), (e) => reader.unwrap(role, e, wrapAadBy(r, role, { e }), w, RK_A.slice()), 128);
				for (const ok of res) bump(out, "e (unwrap epoch and AAD)", ok ? "OPENED" : "false");
				assert.equal(reader.keyState(ofEpoch(role, r.e)).held, false, `${name} ${role}: nothing installed`);
				assert.equal(await reader.unwrap(role, r.e, wrapAad(VAULT, r, role), w, RK_A.slice()), true, `${name} ${role}: control`);
			}
		}
		report("AAD wraps (5 wraps)", out);
		// 5 wraps: genesis recovery (e 1, prevEpoch 0), roll 2 next + prev (e 2, prevEpoch 1), revoke 3 prev + recovery (e 3, prevEpoch 2).
		assert.deepEqual(out, {
			vaultId: { false: 320 }, e: { false: 320 }, kind: { false: 5 * 255 }, prevEpoch: { false: 320 }, kcv: { false: 320 },
			role: { false: 5 * 255 }, recordFormat: { false: 5 * 255 }, suite: { false: 5 * 255 },
			"e (unwrap epoch and AAD)": { false: 5 * 63 },
		});
	});
});

// ---- 3. cross-type confusion ----------------------------------------------------------

describe("§20.2 cross-type confusion (measured)", () => {
	it("frame ↔ checkpoint ↔ blob, k records as envelopes, wraps as frames: auth-failed every time", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(701);
		const address = await c.blobAddress(HASH);
		const N = 64;
		const streams = ["ns", "cfg", `b:${DOC}`, `c:${DOC}`, `x:${HASH}`, "snap"] as const;
		const kinds: Readonly<Record<string, EnvelopeKind>> = { ns: "nsOps", cfg: "cfgOps", snap: "snapOps", [`b:${DOC}`]: "bodyUpdate", [`c:${DOC}`]: "canvasUpdate", [`x:${HASH}`]: "blobChunk" };
		const frames = await inBatches(range(0, N), async (i) => {
			const s = streams[i % streams.length]!;
			return { s, bytes: await seal(c, s, kinds[s]!, rng.bytes(1 + i * 37), { clientFrameId: `cf${String(i).padStart(20, "0")}` }) };
		});
		const ckpts = await inBatches(range(0, N), async (i) => {
			const s = streams[i % streams.length]!;
			return { s, cs: 10 + i, bytes: await sealCheckpoint(c, V, s as StreamName, (10 + i) as Seq, rng.bytes(1 + i * 41), 3 as Seq) };
		});
		const blobs = await inBatches(range(0, N), async (i) => concatBytes(await c.sealBlob({ address, plaintext: rng.bytes(i * 43) })));
		const records = [await genesis(), await roll(2), await revoke(2), await roll(3), await revoke(3)];
		const recs = records.map(decoded);
		const out: Tally = {};
		const tally = async (pair: string, xs: readonly (() => Promise<string>)[]) => {
			for (const r of await inBatches(xs, (f) => f())) bump(out, pair, r);
		};
		await tally("frame as checkpoint", frames.map((f, i) => () => openFrame(c, ckptBinding(f.s, i), f.bytes)));
		await tally("checkpoint as frame", ckpts.map((k) => () => openFrame(c, frameBinding(k.s), k.bytes)));
		await tally("blob as frame", blobs.map((b, i) => () => openFrame(c, frameBinding(streams[i % streams.length]!), b)));
		await tally("blob as checkpoint", blobs.map((b, i) => () => openFrame(c, ckptBinding(streams[i % streams.length]!, i), b)));
		await tally("frame as blob", frames.map((f) => () => openBlobR(c, address, f.bytes)));
		await tally("checkpoint as blob", ckpts.map((k) => () => openBlobR(c, address, k.bytes)));
		// Purpose only (same AAD, other subkey): proves kFrame and kCkpt are separate (§5.1).
		await tally("frame sealed part, checkpoint key, frame AAD", frames.map((f, i) => async () => {
			const r = await c.open({ purpose: "checkpoint", suite: 1, keyEpoch: SEAL_E, aad: frameAad({ formatVersion: 1, suite: 1, keyEpoch: SEAL_E }, VAULT, f.s, DEV, `cf${String(i).padStart(20, "0")}`), sealed: f.bytes.subarray(3) });
			return r.ok ? "ok" : r.reason;
		}));
		// A k record starts 01 01 e: it parses as an envelope or blob header at keyEpoch e (held), so the AEAD decides.
		await tally("k record as frame", records.map((b) => () => openFrame(c, frameBinding("ns"), b)));
		await tally("k record as checkpoint", records.map((b) => () => openFrame(c, ckptBinding("ns", 1), b)));
		await tally("k record as blob", records.map((b) => () => openBlobR(c, address, b)));
		await tally("wrap as frame sealed part", recs.flatMap((r) => presentRoles(r).map((role) => async () => {
			const x = await c.open({ purpose: "frame", suite: 1, keyEpoch: SEAL_E, aad: frameAad({ formatVersion: 1, suite: 1, keyEpoch: SEAL_E }, VAULT, "ns", DEV, CF), sealed: wrapOf(r, role) });
			return x.ok ? "ok" : x.reason;
		})));
		report("cross-type envelopes", out);
		assert.deepEqual(out, {
			"frame as checkpoint": { "auth-failed": N }, "checkpoint as frame": { "auth-failed": N },
			"blob as frame": { "auth-failed": N }, "blob as checkpoint": { "auth-failed": N },
			"frame as blob": { "auth-failed": N }, "checkpoint as blob": { "auth-failed": N },
			"frame sealed part, checkpoint key, frame AAD": { "auth-failed": N },
			"k record as frame": { "auth-failed": 5 }, "k record as checkpoint": { "auth-failed": 5 }, "k record as blob": { "auth-failed": 5 },
			"wrap as frame sealed part": { "auth-failed": 9 },
		});
		// Controls: every object opens as its own type.
		assert.deepEqual((await inBatches(frames, (f, i) => openFrame(c, frameBinding(f.s, DEV, `cf${String(i).padStart(20, "0")}`), f.bytes))).filter((x) => x !== "ok"), []);
		assert.deepEqual((await inBatches(ckpts, (k) => openFrame(c, ckptBinding(k.s, k.cs), k.bytes))).filter((x) => x !== "ok"), []);
		assert.deepEqual((await inBatches(blobs, (b) => openBlobR(c, address, b))).filter((x) => x !== "ok"), []);
	});

	it("k wraps: next ↔ prev ↔ recovery, by key and AAD and by key alone, over genesis, rolls 2..9 and revokes 2..9", async () => {
		const recs = [decoded(await genesis()), ...(await Promise.all(range(2, 10).map((e) => roll(e)))).map(decoded), ...(await Promise.all(range(2, 10).map((e) => revoke(e)))).map(decoded)];
		// The reader holds every key a role needs (K_1..K_9 and the RK), so each false comes from the AEAD.
		const reader = await port(range(1, 10).map((e) => ({ e, k: K(e) })));
		const out: Tally = {};
		for (const r of recs) {
			for (const from of presentRoles(r)) {
				for (const as of ROLES.filter((x) => x !== from)) {
					const w = wrapOf(r, from);
					const [both, keyOnly] = await Promise.all([
						reader.unwrap(as, r.e, wrapAad(VAULT, r, as), w, RK_A.slice()),
						reader.unwrap(as, r.e, wrapAad(VAULT, r, from), w, RK_A.slice()),
					]);
					bump(out, `${from} as ${as}`, both ? "OPENED" : "false");
					bump(out, `${from} as ${as} (key only)`, keyOnly ? "OPENED" : "false");
				}
			}
		}
		report("cross-type wraps", out);
		// genesis: recovery; 8 rolls: next + prev; 8 revokes: prev + recovery.
		const f = (n: number) => ({ false: n });
		assert.deepEqual(out, {
			"recovery as next": f(9), "recovery as next (key only)": f(9), "recovery as prev": f(9), "recovery as prev (key only)": f(9),
			"next as prev": f(8), "next as prev (key only)": f(8), "next as recovery": f(8), "next as recovery (key only)": f(8),
			"prev as next": f(16), "prev as next (key only)": f(16), "prev as recovery": f(16), "prev as recovery (key only)": f(16),
		});
		// Controls: each wrap unwraps in its own role (the reader already holds the keys: "same key" answers true).
		for (const r of recs) for (const role of presentRoles(r)) assert.equal(await reader.unwrap(role, r.e, wrapAad(VAULT, r, role), wrapOf(r, role), RK_A.slice()), true);
	});
});

// ---- 4. re-attribution ----------------------------------------------------------------

describe("§20.2 re-attribution through the ingest gate (measured)", () => {
	it("rewriting a committed row's deviceId: crypto-auth (auth-failed, deterministic under a verified key) for every row and every other device", async () => {
		const c = await mainPort();
		const rng = new SeededRandom(801);
		const ctx: GateCtx = { crypto: c, vaultId: V, maxCheckpointStateBytes: 4 * 1024 * 1024, staleCheck: () => null };
		const devices = range(0, 32).map((i) => `dev-${String(i).padStart(4, "0")}-${randId(rng, 6)}` as DeviceId);
		const ydoc = new Y.Doc();
		ydoc.getText("text").insert(0, "hello");
		const yUpdate = Y.encodeStateAsUpdate(ydoc);
		const kinds: readonly [string, EnvelopeKind, () => Uint8Array][] = [["ns", "nsOps", () => rng.bytes(40)], ["cfg", "cfgOps", () => rng.bytes(40)], [`b:${DOC}`, "bodyUpdate", () => yUpdate], [`x:${HASH}`, "blobChunk", () => rng.bytes(200)]];
		const rows = await inBatches(range(0, 32 * 16), async (i) => {
			const deviceId = devices[i % 32]!;
			const [stream, kind, content] = kinds[i % kinds.length]!;
			const clientFrameId = `cf${String(i).padStart(20, "0")}` as ClientFrameId;
			return { stream: stream as StreamName, deviceId, clientFrameId, seq: i + 1, payload: await seal(c, stream, kind, content(), { deviceId, clientFrameId }) };
		});
		const out: Tally = {};
		const controls = await inBatches(rows, (r) => gate(ctx, { t: "row", ...r }));
		for (const g of controls) bump(out, "own deviceId", g.ok ? "ok" : `fail ${g.reason}`);
		const subs = rows.flatMap((r, i) => range(1, 9).map((k) => ({ ...r, deviceId: devices[(i + k * 3) % 32]! })));
		const results = await inBatches(subs, (r) => gate(ctx, { t: "row", ...r }));
		for (const g of results) bump(out, "rewritten deviceId", g.ok ? "ACCEPTED" : `${g.reason}/${g.detail}/${g.readerDependent ? "reader-dependent" : "deterministic"}`);
		report("re-attribution", out);
		assert.deepEqual(out, {
			"own deviceId": { ok: 512 },
			"rewritten deviceId": { "crypto-auth/auth-failed/deterministic": 4096 },
		});
	});
});
