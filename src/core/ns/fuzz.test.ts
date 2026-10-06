/**
 * 10k-op fold fuzz (DESIGN §l.4).
 *
 *   YAOS_FUZZ_SEEDS=1000 npm run test:client -- core/ns/fuzz     (default 4 seeds)
 *   YAOS_FUZZ_SEED=123   npm run test:client -- core/ns/fuzz     (reproduce one seed)
 *   YAOS_FUZZ_SEED_START=500                                      (shard offset)
 *   YAOS_FUZZ_OPS=10000                                           (ops per seed)
 *
 * Per seed: 3-8 devices emit frames (1-20 ops) against lagged snapshots of
 * the fold, with an adversarial path alphabet, resends inside/outside the
 * ring, malformed frames, rare upgradeRules, and a small tombstone cap on
 * half the seeds. After every frame every V2 invariant is checked (and the
 * incremental index must equal the rebuilt one). At 50 cut points
 * decode(encode(state)) + folding the rest must give the same final bytes,
 * and folding the whole sequence twice gives identical bytes and events.
 * A failure prints the seed and a delta-debugged minimal frame list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientFrameId, ContentHash, DeviceId, DocId, DocKind, NsEntry, NsFoldEvent, NsFoldIndex, NsFoldState, NsFrame, NsOp, VaultPath } from "../types";
import { kindOfPath } from "../types";
import { bytesEqual } from "../codec/lib0";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../codec/nsFoldV1";
import { decodeNsOps, encodeNsOps } from "../codec/nsOps";
import { DEFAULT_NS_FOLD_RULES, foldNsFrameWith, nsFoldHalted, type NsFoldRules } from "./fold";
import { buildIndex, cloneNsFold, newNsFoldIndex, newNsFoldState } from "./index";
import { checkNsInvariants } from "./verify";

declare const process: { env: Record<string, string | undefined> };

// ---------------------------------------------------------------------------
// Seeded PRNG (sfc32 seeded through splitmix32), local so the test has no sim/ dependency.
// ---------------------------------------------------------------------------

function rngFor(seed: number) {
	let s = seed >>> 0;
	const split = () => {
		s = (s + 0x9e3779b9) >>> 0;
		let z = s;
		z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
		z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
		return (z ^ (z >>> 16)) >>> 0;
	};
	let a = split(), b = split(), c = split(), d = split();
	const next = () => {
		const t = (((a + b) >>> 0) + d) >>> 0;
		d = (d + 1) >>> 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) >>> 0;
		c = ((c << 21) | (c >>> 11)) >>> 0;
		c = (c + t) >>> 0;
		return t / 4294967296;
	};
	const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
	const chance = (p: number) => next() < p;
	return { next, int, pick, chance };
}
type Rng = ReturnType<typeof rngFor>;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const randId = (r: Rng) => Array.from({ length: 22 }, () => B64[r.int(0, 63)]).join("");
const HASHES = Array.from({ length: 6 }, (_, i) => ((i + 1) * 17).toString(16).padStart(2, "0").repeat(32) as ContentHash);

// ---------------------------------------------------------------------------
// Adversarial paths
// ---------------------------------------------------------------------------

const FOLDERS = [
	"Notes", "notes", "NOTES", "Straße", "STRASSE", "strasse", "STRAẞE", "Café", "Café", "CAFÉ", "Σίσυφος", "ΣΊΣΥΦΟΣ",
	"ﬁle", "FILE", "File", "Kelvin", "Kelvin", "İstanbul", "i̇stanbul", "CON", "aux.d", "dir.", "dir ", ".hidden", "a",
	"A", "x".repeat(250), "y".repeat(256), "ǅungla", "ǄUNGLA", "img.png", "Plan.md",
];
const STEMS = ["a", "A", "plan", "Plan", "PLAN", "Maße", "MASSE", "x".repeat(240), "naïve", "naïve", "nul", "trail.", "sp ", "😀", "Notes", "notes", "img", "ﬁ", "fi"];
const EXTS = [".md", ".md", ".md", ".MD", ".canvas", ".png", ".PNG", "", ".canvaſ", ".tar.gz"];

function caseVariant(r: Rng, s: string): string {
	switch (r.int(0, 3)) {
		case 0: return s.toUpperCase();
		case 1: return s.toLowerCase();
		case 2: return [...s].map((ch) => (r.chance(0.5) ? ch.toUpperCase() : ch.toLowerCase())).join("");
		default: return s;
	}
}

function randPath(r: Rng): string {
	const depth = r.chance(0.2) ? 0 : r.chance(0.7) ? 1 : r.int(2, 5);
	const segs: string[] = [];
	for (let i = 0; i < depth; i++) segs.push(r.chance(0.8) ? r.pick(FOLDERS) : caseVariant(r, r.pick(FOLDERS)));
	const leaf = r.chance(0.08) ? r.pick(FOLDERS) : r.pick(STEMS) + r.pick(EXTS);
	segs.push(r.chance(0.2) ? caseVariant(r, leaf) : leaf);
	return segs.join("/");
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface Gen {
	readonly frames: NsFrame[];
	readonly rules: NsFoldRules;
	readonly devices: DeviceId[];
}

function liveIds(state: NsFoldState): DocId[] {
	return [...state.entries.keys()];
}

function genOp(r: Rng, view: NsFoldState, ids: DocId[], used: Set<string>): NsOp[] {
	const anyEntry = (): NsEntry | null => (ids.length === 0 ? null : view.entries.get(r.pick(ids)) ?? null);
	const someId = (): DocId => {
		const e = anyEntry();
		return e && !r.chance(0.03) ? e.docId : (randId(r) as DocId);
	};
	const roll = r.next();
	if (roll < 0.32 || ids.length === 0) {
		const path = randPath(r);
		let docId = randId(r) as DocId;
		if (r.chance(0.02) && ids.length > 0) docId = r.pick(ids);
		used.add(docId);
		const kind: DocKind = r.chance(0.03) ? r.pick(["markdown", "canvas", "blob"] as const) : kindOfPath(path);
		return [{ t: "create", docId, kind, path, contentHash: r.pick(HASHES), size: r.int(0, 5000) }];
	}
	if (roll < 0.55) {
		const e = anyEntry()!;
		const docId = r.chance(0.03) ? (randId(r) as DocId) : e.docId;
		let path: string;
		const mode = r.int(0, 5);
		if (mode === 0) path = caseVariant(r, e.path);
		else if (mode === 1) {
			// Folder rename: all live entries under a prefix of e.path, in one frame.
			const segs = e.path.split("/");
			if (segs.length > 1 && e.state === "live") {
				const depth = r.int(0, segs.length - 2);
				const prefix = segs.slice(0, depth + 1).join("/");
				const replaced = r.chance(0.6) ? [...segs.slice(0, depth), caseVariant(r, segs[depth]!)].join("/") : randPath(r).split("/").slice(0, depth + 1).join("/");
				const ops: NsOp[] = [];
				for (const id of ids) {
					const x = view.entries.get(id)!;
					if (x.state !== "live" || !x.path.startsWith(prefix + "/")) continue;
					ops.push({ t: "rename", docId: id, path: replaced + x.path.slice(prefix.length) });
					if (ops.length >= 20) break;
				}
				if (ops.length > 0) return ops;
			}
			path = randPath(r);
		} else {
			const p = randPath(r);
			// Keep the kind most of the time.
			path = r.chance(0.85) ? p.replace(/(\.[^./]*)?$/, e.path.match(/\.[^./]*$/)?.[0] ?? "") : p;
			if (path === "" || path.endsWith("/")) path = p;
		}
		return [{ t: "rename", docId, path }];
	}
	if (roll < 0.7) return [{ t: "delete", docId: someId(), baseBodySeq: r.int(0, 50) }];
	if (roll < 0.8) {
		const dead = ids.filter((id) => view.entries.get(id)!.state === "deleted");
		const e = dead.length > 0 ? view.entries.get(r.pick(dead))! : anyEntry()!;
		return [{ t: "restore", docId: e.docId, path: r.chance(0.8) ? e.path : randPath(r), againstDeleteSeq: r.chance(0.85) ? e.deletedSeq : r.int(0, view.coversSeq) }];
	}
	if (roll < 0.995) {
		const blobs = ids.filter((id) => view.entries.get(id)!.kind === "blob");
		const e = blobs.length > 0 && r.chance(0.9) ? view.entries.get(r.pick(blobs))! : anyEntry()!;
		return [{ t: "setBlob", docId: e.docId, hash: r.pick(HASHES), size: r.int(0, 9999), baseRev: r.chance(0.85) ? (e.blob?.rev ?? 0) : r.int(0, view.coversSeq) }];
	}
	return [{ t: "upgradeRules", version: r.pick([1, 1, 2, 2, 3]) }];
}

function generate(seed: number, totalOps: number): Gen {
	const r = rngFor(seed);
	const smallCap = r.chance(0.5);
	const cap = smallCap ? r.int(10, 300) : DEFAULT_NS_FOLD_RULES.tombstoneCap;
	const rules: NsFoldRules = {
		...DEFAULT_NS_FOLD_RULES,
		tombstoneCap: cap,
		pruneHysteresis: smallCap ? r.int(1, Math.max(1, Math.floor(cap / 2))) : DEFAULT_NS_FOLD_RULES.pruneHysteresis,
		knownRulesVersion: r.chance(0.5) ? 2 : 1,
	};
	const devices = Array.from({ length: r.int(3, 8) }, (_, i) => `dev${i}` as DeviceId);
	const frames: NsFrame[] = [];
	const state = newNsFoldState();
	const index = newNsFoldIndex();
	const snapshots: NsFoldState[] = [];
	const used = new Set<string>();
	let seq = 0;
	let ops = 0;
	const lastOwn = new Map<DeviceId, number>();
	const lastFrameNo = new Map<DeviceId, number>();
	while (ops < totalOps) {
		seq += r.chance(0.05) ? r.int(2, 30) : 1;
		const roll = r.next();
		let frame: NsFrame;
		if (roll < 0.05 && frames.length > 0) {
			// Resend of a past frame at a new seq: recent (likely inside the ring) or any (often outside).
			const past = r.chance(0.6) ? frames[r.int(Math.max(0, frames.length - 20), frames.length - 1)]! : r.pick(frames);
			// Every third resend reuses the frameNo under a fresh clientFrameId (a misbehaving key
			// holder; the ring misses it, the frameNo window must not). No extra draws: seeds keep their frames.
			const fresh = seq % 3 === 0 ? (`r${String(seq).padStart(21, "0")}` as ClientFrameId) : past.clientFrameId;
			frame = { ...past, seq, clientFrameId: fresh };
		} else {
			const deviceId = r.pick(devices);
			const lag = snapshots.length === 0 || r.chance(0.5) ? 0 : r.int(1, snapshots.length);
			const view = lag === 0 ? state : snapshots[snapshots.length - lag]!;
			const ids = liveIds(view);
			const clientFrameId = randId(r) as ClientFrameId;
			// An honest per-device frameNo counter; replays of `past` above reuse theirs (§8.2).
			const frameNo = (lastFrameNo.get(deviceId) ?? 0) + 1;
			lastFrameNo.set(deviceId, frameNo);
			if (roll < 0.08) {
				frame = { seq, deviceId, clientFrameId, frameNo, authorNsSeq: view.coversSeq, ops: [] }; // malformed
			} else {
				const want = r.int(1, 20);
				const list: NsOp[] = [];
				while (list.length < want) list.push(...genOp(r, view, ids, used));
				const authorNsSeq = r.chance(0.15) ? r.int(0, view.coversSeq) : view.coversSeq;
				frame = { seq, deviceId, clientFrameId, frameNo, authorNsSeq: Math.max(authorNsSeq, lastOwn.get(deviceId) ?? 0), ops: list.slice(0, 512) };
			}
			lastOwn.set(deviceId, frame.authorNsSeq);
		}
		// Ops must survive the wire codec (the fold only ever sees decoded frames).
		if (frame.ops.length > 0) {
			const round = decodeNsOps(encodeNsOps(frame.ops));
			assert.ok(round, "generated ops round-trip");
			frame = { ...frame, ops: round };
		}
		frames.push(frame);
		ops += Math.max(1, frame.ops.length);
		foldNsFrameWith(rules, state, index, frame);
		if (r.chance(0.35)) {
			snapshots.push(cloneNsFold(state, index).state);
			if (snapshots.length > 10) snapshots.shift();
		}
	}
	return { frames, rules, devices };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface RunResult {
	readonly bytes: Uint8Array;
	readonly events: string;
}

function eventsKey(ev: readonly NsFoldEvent[]): string {
	return JSON.stringify(ev);
}

function foldAll(
	rules: NsFoldRules,
	frames: readonly NsFrame[],
	from: { state: NsFoldState; index: NsFoldIndex } = { state: newNsFoldState(), index: newNsFoldIndex() },
	start = 0,
	check: ((i: number, state: NsFoldState, index: NsFoldIndex, ev: readonly NsFoldEvent[]) => void) | null = null,
	collectEvents = false,
): RunResult {
	const { state, index } = from;
	const all: string[] = [];
	for (let i = start; i < frames.length; i++) {
		const ev = foldNsFrameWith(rules, state, index, frames[i]!);
		if (collectEvents) all.push(eventsKey(ev));
		if (check) check(i, state, index, ev);
	}
	return { bytes: encodeNsFoldV1(state), events: all.join("\n") };
}

/** Throws on the first violation. */
function checkRun(rules: NsFoldRules, frames: readonly NsFrame[], cutSeed: number): void {
	const r = rngFor(cutSeed);
	const cuts = new Set<number>();
	const nCuts = Math.min(50, frames.length);
	while (cuts.size < nCuts) cuts.add(r.int(0, frames.length - 1));
	const snapshotsAt = new Map<number, Uint8Array>();
	const ref = foldAll(rules, frames, undefined, 0, (i, state, index, ev) => {
		const f = frames[i]!;
		const err = checkNsInvariants(state, index, { tombstoneCap: rules.tombstoneCap });
		if (err !== null) throw new Error(`V2 violation after frame ${i} (seq ${f.seq}): ${err}`);
		if (nsFoldHalted(ev)) {
			if (state.coversSeq >= f.seq) throw new Error(`halt advanced coversSeq at frame ${i}`);
		} else if (state.coversSeq !== f.seq && f.seq > 0) {
			// seq <= coversSeq frames are never generated, so every non-halt frame advances coversSeq.
			throw new Error(`coversSeq ${state.coversSeq} != seq ${f.seq} after frame ${i}`);
		}
		const perOp = ev.filter((e) => e.index >= 0).length;
		const FRAME_LEVEL = ["duplicate-frame", "replay-duplicate", "replay-stale"];
		const dup = ev.length === 1 && ev[0]!.index === -1 && ev[0]!.outcome.kind === "ignored" && FRAME_LEVEL.includes(ev[0]!.outcome.reason);
		if (!nsFoldHalted(ev) && !dup && perOp !== f.ops.length) throw new Error(`event count ${perOp} != ops ${f.ops.length} at frame ${i}`);
		if (cuts.has(i)) snapshotsAt.set(i, encodeNsFoldV1(state));
	}, true);
	// Double fold: identical bytes and events.
	const again = foldAll(rules, frames, undefined, 0, null, true);
	if (!bytesEqual(again.bytes, ref.bytes)) throw new Error("second fold: final bytes differ");
	if (again.events !== ref.events) throw new Error("second fold: events differ");
	// Cut points: decode(encode(state)) then fold the rest.
	for (const [i, bytes] of snapshotsAt) {
		const s = decodeNsFoldV1(bytes);
		if (!s) throw new Error(`cut ${i}: snapshot does not decode`);
		if (!bytesEqual(encodeNsFoldV1(s), bytes)) throw new Error(`cut ${i}: snapshot not canonical`);
		const cont = foldAll(rules, frames, { state: s, index: buildIndex(s) }, i + 1);
		if (!bytesEqual(cont.bytes, ref.bytes)) throw new Error(`cut ${i}: continuation final bytes differ`);
	}
}

/** ddmin over frames: smallest frame list that still fails (any error). */
function minimize(rules: NsFoldRules, frames: NsFrame[], cutSeed: number): NsFrame[] {
	const fails = (fs: NsFrame[]) => {
		try {
			checkRun(rules, fs, cutSeed);
			return false;
		} catch {
			return true;
		}
	};
	let cur = frames;
	let n = 2;
	let budget = 400;
	while (cur.length >= 2 && budget-- > 0) {
		const size = Math.ceil(cur.length / n);
		let reduced = false;
		for (let i = 0; i < n && budget-- > 0; i++) {
			const complement = [...cur.slice(0, i * size), ...cur.slice((i + 1) * size)];
			if (complement.length > 0 && fails(complement)) {
				cur = complement;
				n = Math.max(n - 1, 2);
				reduced = true;
				break;
			}
		}
		if (!reduced) {
			if (n >= cur.length) break;
			n = Math.min(cur.length, n * 2);
		}
	}
	return cur;
}

function runSeed(seed: number, totalOps: number): void {
	const g = generate(seed, totalOps);
	try {
		checkRun(g.rules, g.frames, seed ^ 0x5eed);
	} catch (e) {
		const min = minimize(g.rules, g.frames, seed ^ 0x5eed);
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(
			`ns fold fuzz failed: seed=${seed} (reproduce: YAOS_FUZZ_SEED=${seed} npm run test:client -- core/ns/fuzz)\n${msg}\n` +
				`rules=${JSON.stringify(g.rules)}\nminimized to ${min.length} frames:\n${JSON.stringify(min, null, 1).slice(0, 20000)}`,
		);
	}
}

const env = process.env;
const one = env.YAOS_FUZZ_SEED;
const count = one !== undefined ? 1 : Number(env.YAOS_FUZZ_SEEDS ?? 4);
const start = one !== undefined ? Number(one) : Number(env.YAOS_FUZZ_SEED_START ?? 1);
const totalOps = Number(env.YAOS_FUZZ_OPS ?? 10_000);

test(`ns fold fuzz: ${count} seed(s) from ${start}, ${totalOps} ops each`, () => {
	const t0 = Date.now();
	for (let s = start; s < start + count; s++) runSeed(s, totalOps);
	const ms = Date.now() - t0;
	if (count > 4) console.log(`ns fold fuzz: ${count} seeds x ${totalOps} ops in ${(ms / 1000).toFixed(1)} s`);
});

test("fuzz generator is deterministic per seed and exercises every outcome", () => {
	const a = generate(7, 3000);
	const b = generate(7, 3000);
	assert.equal(JSON.stringify(a.frames), JSON.stringify(b.frames));
	const seen = new Set<string>();
	for (const seed of [1, 2, 3, 4, 5, 6]) {
		const g = generate(seed, 10_000);
		foldAll(g.rules, g.frames, undefined, 0, (_i, _s, _x, ev) => {
			for (const e of ev) seen.add(e.outcome.kind === "ignored" ? `ignored/${e.outcome.reason}` : e.outcome.kind);
		});
	}
	const expected = [
		"applied", "suffixed", "merged", "revived", "deleted", "pruned",
		"ignored/duplicate-frame", "ignored/duplicate-docid", "ignored/unknown-docid", "ignored/invalid-path", "ignored/kind-mismatch",
		"ignored/stale-delete", "ignored/already-deleted", "ignored/not-deleted", "ignored/restore-not-current", "ignored/stale-revive",
		"ignored/rev-mismatch", "ignored/not-blob", "ignored/noop", "ignored/rules-version",
		"ignored/replay-duplicate", "ignored/replay-stale",
	];
	assert.deepEqual(expected.filter((k) => !seen.has(k)), []);
});

export type { VaultPath };
