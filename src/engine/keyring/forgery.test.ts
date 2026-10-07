/**
 * e2ee-design §20.2 keyring forgery, measured (WP-E7): garbage `k` rows (random bytes of many lengths, truncated
 * and extended records, non-canonical varuints, oversize), every single-byte flip of a genesis, a roll and a revoke
 * (mask 0x01 and a seeded nonzero mask), valid records of other vaults, and well-formed records with random kcv and
 * wraps. Each case runs on a fresh device of the real Keyring over the real adapter, and the device's whole state is
 * compared with what §11.3 predicts: diagnostics, keyMissing, seal epoch, winners, held keys, K_1 intact, nothing
 * persisted but a revoke held open (stored with the winners so that a reset does not lift it, §11.5; never a key). Extends keyring.test.ts (two garbage rows, one forged roll after a revoke, one duplicate).
 * YAOS_TAMPER_REPORT=1 prints the outcome counts (counts only: never key bytes).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bytesEqual } from "../../core/codec/lib0";
import type { Seq } from "../../core/types";
import { SeededRandom } from "../../sim/random";
import { KeyRecordKind, decodeKeyRecord, encodeKeyRecord, newKeyRecord, wrapsOf } from "./record";
import { K, RK_A, VAULT, device, genesis, genesisFor, holds, record, revoke, roll, type Device } from "./testkit/world";

const REPORT = process.env.YAOS_TAMPER_REPORT === "1";
const report = (label: string, data: unknown): void => {
	if (REPORT) console.log(`[forgery] ${label} ${JSON.stringify(data)}`);
};

type Tally = Record<string, Record<string, number>>;
function bump(t: Tally, group: string, key: string): void {
	const g = (t[group] ??= {});
	g[key] = (g[key] ?? 0) + 1;
}
const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);
const flip = (b: Uint8Array, p: number, mask: number): Uint8Array => {
	const o = b.slice();
	o[p] = o[p]! ^ mask;
	return o;
};
const cat = (...parts: readonly Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};
async function inBatches<T, R>(items: readonly T[], fn: (x: T, i: number) => Promise<R>, size = 48): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map((x, j) => fn(x, i + j)))));
	return out;
}

// ---- devices and their observable state ---------------------------------------------------

/** pinned: suite 1 holding K_1 with its genesis stored. unpinned: no pin, no keys. nokey: pinned suite 1 before the keys are entered (§13.3). */
type DevKind = "pinned" | "unpinned" | "nokey";

interface Obs {
	/** keyring/* diagnostics, counted in order of first occurrence; "none" when there are none. */
	readonly diag: string;
	readonly km: string;
	readonly seen: boolean;
	/** Keyring.sealEpoch() / adapter sealEpoch(). */
	readonly seal: string;
	/** Winning epochs. */
	readonly epochs: string;
	/** Epochs 1..12 whose key the adapter holds. */
	readonly held: string;
	/** K_1 verified and byte-identical to the honest key. */
	readonly k1: boolean;
	readonly persist: number;
	readonly extra?: string;
}
const fmt = (o: Obs): string =>
	`${o.diag} km:${o.km} seen:${o.seen} seal:${o.seal} epochs:[${o.epochs}] held:[${o.held}] k1:${o.k1} persist:${o.persist}${o.extra ? ` ${o.extra}` : ""}`;
const BASE: Readonly<Record<DevKind, Omit<Obs, "diag" | "km" | "seen">>> = {
	pinned: { seal: "1/1", epochs: "1", held: "1", k1: true, persist: 0 },
	unpinned: { seal: "0/0", epochs: "", held: "", k1: false, persist: 0 },
	nokey: { seal: "0/0", epochs: "", held: "", k1: false, persist: 0 },
};
/** A revoke held open is stored with the winners (one keyringChanged, no key): a reset does not lift it (§11.5). */
const OPEN = { persist: 1 } as const;
const want = (kind: DevKind, diag: string, km: string | null, seen: boolean, more: Partial<Obs> = {}): string =>
	fmt({ ...BASE[kind], diag, km: String(km), seen, ...more });

function diagSummary(d: Device): string {
	const n = new Map<string, number>();
	for (const c of d.codes()) n.set(c.slice("keyring/".length), (n.get(c.slice("keyring/".length)) ?? 0) + 1);
	return n.size === 0 ? "none" : [...n].map(([c, k]) => `${c}×${k}`).join("+");
}

async function observe(d: Device, extra?: string): Promise<string> {
	return fmt({
		diag: diagSummary(d),
		km: String(d.kr.keyMissing()),
		seen: d.kr.keyringSeen,
		seal: `${d.kr.sealEpoch()}/${d.kc.sealEpoch()}`,
		epochs: d.kr.summary().epochs.map((x) => x.e).join(","),
		held: range(1, 13).filter((e) => d.kc.keyState(e).held).join(","),
		k1: await holds(d, 1, K(1)),
		persist: d.changes.length,
		extra,
	});
}

let G: Uint8Array | null = null;
/** The honest genesis (K_1 under RK_A), shared by every pinned device. */
const honestGenesis = async (): Promise<Uint8Array> => (G ??= await genesis());
const make = async (kind: DevKind): Promise<Device> =>
	kind === "pinned" ? device({ keys: [{ e: 1, k: K(1) }], records: [await honestGenesis()] }) : kind === "unpinned" ? device({ mode: "unpinned" }) : device();
const SEQ = 10 as Seq;

/** Runs every case on its own fresh device; asserts the observed state per group equals the predicted one. */
async function measure<C extends { readonly group: string }>(label: string, cases: readonly C[], run: (c: C) => Promise<string>, expected: (c: C) => string): Promise<Tally> {
	const got: Tally = {};
	const exp: Tally = {};
	const obs = await inBatches(cases, (c) => run(c));
	cases.forEach((c, i) => {
		bump(got, c.group, obs[i]!);
		bump(exp, c.group, expected(c));
	});
	report(label, got);
	assert.deepEqual(got, exp, label);
	for (const s of Object.values(got).flatMap((g) => Object.keys(g))) if (!label.includes("observation")) assert.ok(!s.includes("adopted"), `${label}: nothing adopted`);
	return got;
}

// ---- record layout and flips --------------------------------------------------------------

type Reg = "head" | "kcv" | "length" | "next" | "prev" | "recovery";
/** Region of every byte of a canonical record whose e and prevEpoch fit one byte. */
function layout(bytes: Uint8Array): Reg[] {
	const r = decodeKeyRecord(bytes);
	assert.ok(r && r.e < 128, "testkit record decodes");
	const out: Reg[] = [...Array<Reg>(5).fill("head"), ...Array<Reg>(16).fill("kcv")];
	for (const [role, w] of [["next", r.nextWrap], ["prev", r.prevWrap], ["recovery", r.recoveryWrap]] as const) out.push("length", ...Array<Reg>(w.length).fill(role));
	assert.equal(out.length, bytes.length);
	return out;
}
/** Every byte flipped with 0x01, then with a seeded nonzero mask. */
function flips(bytes: Uint8Array, seed: number): { readonly group: Reg; readonly bytes: Uint8Array }[] {
	const regs = layout(bytes);
	const rng = new SeededRandom(seed);
	return [0x01, -1].flatMap((m) => range(0, bytes.length).map((p) => ({ group: regs[p]!, bytes: flip(bytes, p, m > 0 ? m : 1 + rng.int(255)) })));
}
const notRecord = (g: Reg): boolean => g === "head" || g === "length";

/** A byte at `at` holding a one-byte varuint, re-encoded as the non-minimal two bytes (b | 0x80, 0x00). */
const nonMinimal = (b: Uint8Array, at: number): Uint8Array => cat(b.subarray(0, at), Uint8Array.of(b[at]! | 0x80, 0), b.subarray(at + 1));

// ---- 5. keyring forgery -------------------------------------------------------------------

describe("§20.2 keyring forgery: garbage rows are never adopted (measured)", () => {
	it("garbage: random bytes 0..300 B, structured prefixes, every truncation, trailing bytes, non-canonical varuints, oversize; on every device kind", async () => {
		const rng = new SeededRandom(9001);
		const recs = [await honestGenesis(), await roll(2), await revoke(2)];
		const sets: Record<string, Uint8Array[]> = {
			"random 0..300 B ×4": range(0, 301).flatMap(() => range(0, 4)).map((_, i) => rng.bytes(Math.floor(i / 4))),
			"record-like head + random tail": range(0, 256).map((i) => cat(Uint8Array.of(1, 1, 1 + (i % 10), 1 + (i % 3), i % 10), rng.bytes(16 + rng.int(200)))),
			"every proper prefix": recs.flatMap((r) => range(0, r.length).map((n) => r.slice(0, n))),
			"record + 1..16 random bytes": recs.flatMap((r) => range(1, 17).map((n) => cat(r, rng.bytes(n)))),
			"record + 1..8 zero bytes": recs.flatMap((r) => range(1, 9).map((n) => cat(r, new Uint8Array(n)))),
			"non-canonical varuint": recs.flatMap((r) => [2, 4, ...layout(r).flatMap((g, i) => (g === "length" ? [i] : []))].map((at) => nonMinimal(r, at))),
			"oversize 257..1024 B": range(0, 32).map(() => rng.bytes(257 + rng.int(768))),
		};
		const rows = Object.values(sets).flat();
		for (const b of rows) assert.equal(decodeKeyRecord(b), null, "every row is garbage to the codec");
		const counts = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, v.length]));
		report("garbage rows", counts);
		assert.deepEqual(counts, {
			"random 0..300 B ×4": 1204, "record-like head + random tail": 256, "every proper prefix": 372,
			"record + 1..16 random bytes": 48, "record + 1..8 zero bytes": 24, "non-canonical varuint": 15, "oversize 257..1024 B": 32,
		});
		const N = rows.length;
		const out: Record<string, string> = {};
		for (const kind of ["pinned", "unpinned", "nokey"] as const) {
			const d = await make(kind);
			await d.ingest(...rows.map((b, i) => [(i + 1) as Seq, b] as const));
			assert.equal(d.kr.rowCount, N);
			out[kind] = await observe(d);
			if (kind !== "pinned") out[`${kind} + RK`] = await observe(d, `rk:${await d.kr.installRk(RK_A.slice())}`);
		}
		const g = `garbage×${N}`;
		report("garbage devices", out);
		assert.deepEqual(out, {
			pinned: want("pinned", g, null, false),
			unpinned: want("unpinned", g, "no-pin", false),
			"unpinned + RK": want("unpinned", g, "no-pin", false, { extra: "rk:pending" }),
			nokey: want("nokey", g, "no-key", false),
			"nokey + RK": want("nokey", g, "no-key", false, { extra: "rk:pending" }),
		});
		// Stored (SecretStorage) garbage next to the honest genesis: reported, never a winner.
		const stored = rows.filter((_, i) => i % 29 === 0);
		const s = await device({ keys: [{ e: 1, k: K(1) }], records: [await honestGenesis(), ...stored] });
		assert.equal(await observe(s), want("pinned", `garbage×${stored.length}`, null, false));
		assert.deepEqual(s.diags.map((x) => x.fields.stored), stored.map(() => true));
	});

	it("every flip of a roll for 2 on a device holding K_1: garbage or invalid, K_2 never installed", async () => {
		const cases = flips(await roll(2), 9101);
		const t = await measure("roll(2) flips, pinned", cases, async (c) => {
			const d = await make("pinned");
			await d.ingest([SEQ, c.bytes]);
			return observe(d);
		}, (c) => (notRecord(c.group) ? want("pinned", "garbage×1", null, false) : want("pinned", "invalid×1", null, true)));
		assert.equal(cases.length, 288);
		assert.equal(Object.values(t).reduce((s, g) => s + Object.values(g).reduce((a, b) => a + b, 0), 0), 288);
	});

	it("every flip of a revoke for 2 on a device holding K_1: pending (revoked-epoch) until the RK; then pending or invalid, never adopted", async () => {
		const cases = flips(await revoke(2), 9201);
		await measure("revoke(2) flips, pinned, then RK", cases, async (c) => {
			const d = await make("pinned");
			await d.ingest([SEQ, c.bytes]);
			const before = await observe(d);
			return `${before} => ${await observe(d, `rk:${await d.kr.installRk(RK_A.slice())}`)}`;
		}, (c) => {
			if (notRecord(c.group)) return `${want("pinned", "garbage×1", null, false)} => ${want("pinned", "garbage×1", null, false, { extra: "rk:verified" })}`;
			const before = want("pinned", "none", "revoked-epoch", true, OPEN);
			// kcv (in every wrap's AAD) or recoveryWrap: the RK cannot open it, and a forged recoveryWrap cannot be told
			// from a wrong RK: pending (§11.3). prevWrap: K_2 opens and matches kcv, prevWrap does not open: invalid.
			// Judged invalid, it is no longer open: a second keyringChanged drops it from the stored records.
			if (c.group === "prev") return `${before} => ${want("pinned", "invalid×1", null, true, { persist: 2, extra: "rk:verified" })}`;
			return `${before} => ${want("pinned", "none", "revoked-epoch", true, { ...OPEN, extra: "rk:verified" })}`;
		});
	});

	it("every flip of the genesis: a duplicate where K_1 won; pending on unpinned and keyless devices, with or without the RK", async () => {
		const cases = flips(await honestGenesis(), 9301);
		await measure("genesis flips, pinned", cases, async (c) => {
			const d = await make("pinned");
			await d.ingest([SEQ, c.bytes]);
			return observe(d);
		}, (c) => (notRecord(c.group) ? want("pinned", "garbage×1", null, false) : want("pinned", "duplicate×1", null, true)));
		for (const kind of ["unpinned", "nokey"] as const) {
			await measure(`genesis flips, ${kind}, then RK`, cases, async (c) => {
				const d = await make(kind);
				await d.ingest([SEQ, c.bytes]);
				return `${await observe(d)} => ${await observe(d, `rk:${await d.kr.installRk(RK_A.slice())}`)}`;
			}, (c) => {
				const garbage = notRecord(c.group);
				const km = kind === "nokey" ? "no-key" : garbage ? "no-pin" : "encrypted-vault";
				const diag = garbage ? "garbage×1" : "none";
				return `${want(kind, diag, km, !garbage)} => ${want(kind, diag, km, !garbage, { extra: "rk:pending" })}`;
			});
		}
	});

	it("valid records of 8 other vaults: duplicate, invalid or pending, on every device kind", async () => {
		const others = range(0, 8).map((i) => `${VAULT.slice(0, i * 2)}B${VAULT.slice(i * 2 + 1)}`);
		assert.equal(new Set([VAULT, ...others]).size, 9);
		const cases = (await Promise.all(others.map(async (v) => [
			{ group: "genesis → pinned", bytes: await genesisFor(v) },
			{ group: "genesis → unpinned + RK", bytes: await genesisFor(v) },
			{ group: "genesis → unpinned + QR K_1", bytes: await genesisFor(v) },
			{ group: "genesis → nokey + RK", bytes: await genesisFor(v) },
			{ group: "roll 2 → pinned", bytes: await record(KeyRecordKind.roll, 2, [{ e: 1, k: K(1) }, { e: 2, k: K(2) }], undefined, v) },
			{ group: "revoke 2 → pinned + RK", bytes: await record(KeyRecordKind.revoke, 2, [{ e: 1, k: K(1) }, { e: 2, k: K(2) }], RK_A, v) },
		]))).flat();
		await measure("other-vault records", cases, async (c) => {
			const kind: DevKind = c.group.includes("unpinned") ? "unpinned" : c.group.includes("nokey") ? "nokey" : "pinned";
			const d = await make(kind);
			const qr = c.group.includes("QR") ? await d.kr.installQr(1, K(1).slice()) : null;
			await d.ingest([SEQ, c.bytes]);
			const rk = c.group.includes("RK") ? await d.kr.installRk(RK_A.slice()) : null;
			return observe(d, [qr && `qr:${qr}`, rk && `rk:${rk}`].filter(Boolean).join(" "));
		}, (c) => {
			switch (c.group) {
				case "genesis → pinned": return want("pinned", "duplicate×1", null, true);
				case "genesis → unpinned + RK": return want("unpinned", "none", "encrypted-vault", true, { extra: "rk:pending" });
				// The kcv binds vaultId (§5.1): the QR key is authoritative, the record is rejected.
				case "genesis → unpinned + QR K_1": return want("unpinned", "conflict×1+invalid×1", "encrypted-vault", true, { held: "1", extra: "qr:pending" });
				case "genesis → nokey + RK": return want("nokey", "none", "no-key", true, { extra: "rk:pending" });
				case "roll 2 → pinned": return want("pinned", "invalid×1", null, true);
				default: return want("pinned", "none", "revoked-epoch", true, { ...OPEN, extra: "rk:verified" });
			}
		});
	});

	it("well-formed records with random kcv and wraps: invalid where judgeable, otherwise pending; never adopted", async () => {
		const rng = new SeededRandom(9401);
		const forge = (e: number, kind: KeyRecordKind): Uint8Array => {
			const w = wrapsOf(kind);
			return encodeKeyRecord(newKeyRecord(e, kind, rng.bytes(16), { next: w.next ? rng.bytes(60) : undefined, prev: w.prev ? rng.bytes(60) : undefined, recovery: w.recovery ? rng.bytes(60) : undefined }));
		};
		const cases = [
			...range(0, 64).map(() => ({ group: "roll 2 → pinned", bytes: forge(2, KeyRecordKind.roll) })),
			...range(3, 11).flatMap((e) => range(0, 8).map(() => ({ group: "roll 3..10 → pinned", bytes: forge(e, KeyRecordKind.roll) }))),
			...range(2, 11).flatMap((e) => range(0, 8).map(() => ({ group: "revoke 2..10 → pinned + RK", bytes: forge(e, KeyRecordKind.revoke) }))),
			...range(0, 64).map(() => ({ group: "genesis → pinned", bytes: forge(1, KeyRecordKind.genesis) })),
			...range(0, 64).map(() => ({ group: "genesis → unpinned + RK", bytes: forge(1, KeyRecordKind.genesis) })),
			...range(0, 64).map(() => ({ group: "genesis → nokey + RK", bytes: forge(1, KeyRecordKind.genesis) })),
		];
		await measure("random well-formed records", cases, async (c) => {
			const kind: DevKind = c.group.includes("unpinned") ? "unpinned" : c.group.includes("nokey") ? "nokey" : "pinned";
			const d = await make(kind);
			await d.ingest([SEQ, c.bytes]);
			return c.group.includes("RK") ? `${await observe(d)} => ${await observe(d, `rk:${await d.kr.installRk(RK_A.slice())}`)}` : observe(d);
		}, (c) => {
			switch (c.group) {
				case "roll 2 → pinned": return want("pinned", "invalid×1", null, true);
				// No winner for e − 1: not judgeable, and no revoke or genesis above the held keys: the device keeps sealing.
				case "roll 3..10 → pinned": return want("pinned", "none", null, true);
				case "revoke 2..10 → pinned + RK": return `${want("pinned", "none", "revoked-epoch", true, OPEN)} => ${want("pinned", "none", "revoked-epoch", true, { ...OPEN, extra: "rk:verified" })}`;
				case "genesis → pinned": return want("pinned", "duplicate×1", null, true);
				case "genesis → unpinned + RK": return `${want("unpinned", "none", "encrypted-vault", true)} => ${want("unpinned", "none", "encrypted-vault", true, { extra: "rk:pending" })}`;
				default: return `${want("nokey", "none", "no-key", true)} => ${want("nokey", "none", "no-key", true, { extra: "rk:pending" })}`;
			}
		});
		assert.equal(cases.length, 64 + 64 + 72 + 192);
	});

	it("observation: an out-of-band key cannot judge a recoveryWrap, so a record whose recoveryWrap was flipped is adopted with the honest key", async () => {
		// §11.3: validity is kcv plus prevWrap. With K_e from a QR, the recoveryWrap is never opened, so a flip there is
		// adopted (the key is the honest K_e; only the stored record's recoveryWrap is broken). Every other flip is rejected.
		const gFlips = flips(await honestGenesis(), 9501);
		await measure("observation: genesis flips, unpinned with QR K_1", gFlips, async (c) => {
			const d = await make("unpinned");
			const qr = await d.kr.installQr(1, K(1).slice());
			await d.ingest([SEQ, c.bytes]);
			const stored = d.changes.at(-1)?.records;
			return observe(d, `qr:${qr}${stored ? ` stored:${stored.length === 1 && bytesEqual(stored[0]!, c.bytes) ? "flipped" : "other"}` : ""}`);
		}, (c) => {
			const u = { held: "1", extra: "qr:pending" };
			if (notRecord(c.group)) return want("unpinned", "garbage×1", "no-pin", false, u);
			if (c.group === "kcv") return want("unpinned", "conflict×1+invalid×1", "encrypted-vault", true, u);
			return want("unpinned", "adopted×1", "encrypted-vault", true, { seal: "0/1", epochs: "1", held: "1", k1: true, persist: 1, extra: "qr:pending stored:flipped" });
		});
		const rFlips = flips(await revoke(2), 9502);
		await measure("observation: revoke(2) flips, pinned with QR K_2", rFlips, async (c) => {
			const d = await make("pinned");
			const qr = await d.kr.installQr(2, K(2).slice());
			await d.ingest([SEQ, c.bytes]);
			const stored = d.changes.at(-1)?.records;
			const k2 = await holds(d, 2, K(2));
			return observe(d, `qr:${qr} k2:${k2}${stored ? ` stored:${stored.length === 2 && bytesEqual(stored[1]!, c.bytes) ? "flipped" : "other"}` : ""}`);
		}, (c) => {
			const p = { held: "1,2", extra: "qr:pending k2:false" };
			if (notRecord(c.group)) return want("pinned", "garbage×1", null, false, p);
			if (c.group === "kcv") return want("pinned", "conflict×1+invalid×1", null, true, p);
			if (c.group === "prev") return want("pinned", "invalid×1", null, true, p);
			return want("pinned", "adopted×1", null, true, { seal: "2/2", epochs: "1,2", held: "1,2", persist: 1, extra: "qr:pending k2:true stored:flipped" });
		});
	});

	it("a roll for 3 forged under K_2 after a revoke for 3, 16 forged keys × both orders: blocked, revoked-epoch, a QR settles it", async () => {
		const rng = new SeededRandom(9601);
		const g = await honestGenesis();
		const [r2, rev] = [await roll(2), await revoke(3)];
		const forged = await Promise.all(range(0, 16).map(() => roll(3, K(2), rng.bytes(32))));
		const out: Tally = {};
		await inBatches(forged.flatMap((f) => [[f, "revoke first"], [f, "forged first"]] as const), async ([f, order]) => {
			const d = await device({ keys: [{ e: 1, k: K(1) }, { e: 2, k: K(2) }], records: [g, r2] });
			await d.ingest(...(order === "revoke first" ? [[SEQ, rev], [(SEQ + 1) as Seq, f]] as const : [[SEQ, f], [(SEQ + 1) as Seq, rev]] as const));
			const before = `km:${d.kr.keyMissing()} seal:${d.kc.sealEpoch()} held3:${d.kc.keyState(3).held} adopted:${d.codes().includes("keyring/adopted")}`;
			const qr = await d.kr.installQr(3, K(3).slice());
			bump(out, order, `${before} => qr:${qr} seal:${d.kc.sealEpoch()} k3:${await holds(d, 3, K(3))} km:${d.kr.keyMissing()}`);
		});
		report("forged roll after revoke", out);
		const s = "km:revoked-epoch seal:2 held3:false adopted:false => qr:verified seal:3 k3:true km:null";
		assert.deepEqual(out, { "revoke first": { [s]: 16 }, "forged first": { [s]: 16 } });
	});

	it("32 other valid rolls for 2 after the honest winner: every one a duplicate, K_2 unchanged", async () => {
		const rng = new SeededRandom(9701);
		const r2 = await roll(2);
		const others = await Promise.all(range(0, 32).map(() => roll(2, K(1), rng.bytes(32))));
		const d = await device({ keys: [{ e: 1, k: K(1) }], records: [await honestGenesis()] });
		await d.ingest([SEQ, r2], ...others.map((b, i) => [(SEQ + 1 + i) as Seq, b] as const));
		assert.deepEqual(d.codes(), ["keyring/adopted", ...others.map(() => "keyring/duplicate")]);
		assert.ok(await holds(d, 2, K(2)));
		assert.deepEqual(d.kr.summary().epochs.map((x) => [x.e, x.firstSeq]), [[1, null], [2, SEQ]]);
		assert.equal(d.kc.sealEpoch(), 2);
		report("duplicate rolls", { duplicates: others.length });
	});
});
