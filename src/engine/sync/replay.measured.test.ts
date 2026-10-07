/**
 * e2ee-design §20.2 "Replay", measured. A hostile relay re-appends recorded genuine ns and cfg frames as new rows
 * at ages a = r − f of 1, 63, 64, 65, 1000 and 100000 own frames, where r is the author's replay right edge in
 * the reader's fold when the replay is appended. For each of 1000 seeds the fold digest equals the digest of the
 * same rows without the replays. Every injected row produces exactly one ignored/replay-stale,
 * ignored/replay-duplicate or ignored/duplicate-frame event, and its reason is the one an independent model of the
 * precedence predicts. All rows of every seed are checked; nothing is sampled.
 *
 * Path: relay payloads are sealed by the suite-1 adapter (createWebCryptoSuite1, testkit K(1), seeded RandomPort),
 * then go through gateRow (src/engine/sync/ingestRow.ts:46, the entry the engine runs on every committed row),
 * then NsRuntime / CfgRuntime.load() over a minimal Repo that holds only the snapshot and the tail
 * (src/engine/sync/foldRuntime.ts:109-163). Every replay authenticates: the AAD binds vaultId, stream, deviceId
 * and clientFrameId (§7.2), and a replay repeats those columns byte for byte. Its gated row carries the recorded
 * frameNo and content, and the fold still ignores it.
 *
 * Honest sequences only (e2ee-design §8.2; see also core/ns/replayExactness.test.ts):
 *  - frameNos per (device, stream) follow FoldRuntime.allocFrameNo (foldRuntime.ts:239-247): 1 + the highest own
 *    frameNo, plus NS_DEDUPE_RING on a runtime's first allocation. A fresh device therefore starts at 65, and a
 *    restart (a quarter of the lanes) leaves a gap of 64.
 *  - All of a seed's frames are authored (and sealed) before its first commit, so authorNsSeq and setBlob baseRev
 *    are what the authors had seen.
 *  - The relay commits a device's frame f only while f < (lowest uncommitted own frameNo) + NS_SEND_WINDOW, which
 *    is the Sender's window. Even seeds commit each lane in frameNo order. Odd seeds reorder within that window.
 *  - Relay seqs are global across streams, so seq gaps are normal. No replay follows a stream's last genuine row,
 *    so both runs end at the same coversSeq.
 *
 * Long ages: an age of 100000 needs r > 100064, i.e. 100000 committed own frames. Folding that many frames per seed
 * is too slow, so one honest prefix is built once instead. L1 commits 100200 frames per stream (frameNo
 * 65..100264) and L2 1100 (65..1164), interleaved and in order. The prefix fold is the snapshot every seed starts
 * from, as for a reader that holds a checkpoint at that seq. Prefix rows enter the fold as tail records, because
 * gating is pure. A prefix frame that is a replay target is sealed on first use, and its gated row must equal the
 * prefix row byte for byte, so the snapshot is the fold of exactly the frames the relay replays. As a result every
 * seed reaches every age: L1 all six, L2 up to 1000, and a fresh device F (every third seed) 1..65. Each
 * (seed, stream, lane, age) has QUOTA = 2 replays, appended at the first commit on or after a random arm where
 * f = r − a is a committed frame. A gap or an uncommitted f makes the age unreachable for that lane and seed; the
 * number of skipped slots is reported as "missed".
 *
 * Expected reasons come from an independent model of the precedence, not from replayCheck:
 *   1. ns only: the upgradeRules pre-scan (core/ns/fold.ts:267-270). No generated frame carries upgradeRules.
 *   2. The per-device ring of the last NS_DEDUPE_RING accepted clientFrameIds gives duplicate-frame
 *      (core/ns/fold.ts:271-276, core/cfg/fold.ts:209-213).
 *   3. The window gives replay-stale when f <= r − REPLAY_WINDOW and replay-duplicate when the bit is set
 *      (core/replayWindow.ts:30-35, called at core/ns/fold.ts:277-286 and core/cfg/fold.ts:214-223). A rejected
 *      frame changes neither the ring nor the window, only coversSeq.
 * So, in frameNo order with no gap among the ring's frames, a <= 63 gives duplicate-frame and a >= 64 gives
 * replay-stale. A restart gap keeps older frames in the ring, which gives duplicate-frame at a >= 64. Reordering can
 * push a frame with a <= 63 out of the ring while its bit is still set, which gives replay-duplicate; it can also
 * keep a frame with a = 64 in the ring, which gives duplicate-frame.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CfgFoldEvent } from "../../core/cfg/fold";
import { encodeCfgOps } from "../../core/codec/cfgOps";
import { bytesEqual } from "../../core/codec/lib0";
import { encodeNsOps } from "../../core/codec/nsOps";
import { NS_DEDUPE_RING, NS_SEND_WINDOW, REPLAY_WINDOW } from "../../core/limits";
import {
	CFG_STREAM, NS_STREAM,
	type CfgOp, type ClientFrameId, type ContentHash, type DeviceId, type DocId, type NsFoldEvent, type NsOp, type Seq, type StreamName, type VaultId, type VaultPath,
} from "../../core/types";
import { SeededRandom } from "../../sim/random";
import { createWebCryptoSuite1, type Suite1Crypto } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { sealFrame } from "../ingest/envelope";
import type { GateCtx } from "../ingest/gate";
import { K, VAULT } from "../keyring/testkit/world";
import type { Repo } from "../store/repo";
import type { SnapshotRecord, TailRecord } from "../store/schema";
import { CfgRuntime } from "./cfgRuntime";
import type { FoldRuntime } from "./foldRuntime";
import { gateRow } from "./ingestRow";
import { NsRuntime } from "./nsRuntime";

const SEEDS = 1000;
const QUOTA = 2;
const AGES = [1, 63, 64, 65, 1000, 100_000] as const;
type Age = (typeof AGES)[number];
type Cls = "L1" | "L2" | "F";
const DEV: Record<Cls, DeviceId> = { L1: "dev-L1" as DeviceId, L2: "dev-L2" as DeviceId, F: "dev-F" as DeviceId };
const READER = "dev-reader" as DeviceId;
const AGES_OF: Record<Cls, readonly Age[]> = { L1: AGES, L2: [1, 63, 64, 65, 1000], F: [1, 63, 64, 65] };
const PREFIX_FRAMES = { L1: 100_200, L2: 1_100 } as const;
/** First frameNo of a fresh runtime (foldRuntime.ts:239-247). */
const FIRST = NS_DEDUPE_RING + 1;
const STREAMS = [NS_STREAM, CFG_STREAM] as const;
type Reason = "replay-stale" | "replay-duplicate" | "duplicate-frame";
const REASONS: readonly Reason[] = ["duplicate-frame", "replay-stale", "replay-duplicate"];

const id22 = (s: string) => s.padEnd(22, "_");
const cfid = (tag: string, stream: StreamName, f: number) => id22(`${tag}${stream === NS_STREAM ? "n" : "c"}${f.toString(36)}`) as ClientFrameId;
const MD = Array.from({ length: 8 }, (_, i) => id22(`md${i}`) as DocId);
const BL = Array.from({ length: 8 }, (_, i) => id22(`bl${i}`) as DocId);
const hex = (n: number) => n.toString(16).padStart(64, "0") as ContentHash;
const mdPath = (n: number) => `m${n % 24}.md` as VaultPath;
const blPath = (n: number) => `b${n % 24}.png` as VaultPath;

/** A genuine frame as its author sealed it. */
interface Frame {
	readonly frameNo: number;
	readonly clientFrameId: ClientFrameId;
	readonly authorNsSeq: Seq;
	readonly content: Uint8Array;
}
interface PrefixFrame extends Frame { readonly seq: Seq }

const reasonOf = (e: NsFoldEvent | CfgFoldEvent): string | null => {
	const o = e.outcome as { readonly kind?: string; readonly t?: string; readonly reason?: string };
	return o.kind === "ignored" || o.t === "ignored" ? o.reason ?? null : null;
};
const isReplayReason = (r: string | null): r is Reason => r === "replay-stale" || r === "replay-duplicate" || r === "duplicate-frame";

/** The snapshot plus the tail; nothing else of the Repo is used by FoldRuntime.load(). */
function repoOf(stream: StreamName, snap: SnapshotRecord | undefined, rows: readonly TailRecord[]): Repo {
	const appliedSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : snap?.coversSeq ?? 0;
	return {
		stream: (s: StreamName) => (s === stream ? { stream, appliedSeq } : undefined),
		getSnapshot: async (s: StreamName) => (s === stream ? snap : undefined),
		getTail: async (s: StreamName, after: Seq = 0, through: Seq = Number.MAX_SAFE_INTEGER) =>
			s === stream ? rows.filter((r) => r.seq > after && r.seq <= through) : [],
	} as unknown as Repo;
}

type AnyRuntime = FoldRuntime<NsOp, NsFoldEvent> | FoldRuntime<CfgOp, CfgFoldEvent>;
const runtimeOf = (stream: StreamName, repo: Repo): AnyRuntime => (stream === NS_STREAM ? new NsRuntime(repo, READER) : new CfgRuntime(repo, READER));

const tailOf = (stream: StreamName, seq: Seq, deviceId: DeviceId, f: Frame): TailRecord => ({
	stream, seq, deviceId, clientFrameId: f.clientFrameId, kind: stream === NS_STREAM ? "nsOps" : "cfgOps", authorNsSeq: f.authorNsSeq, flags: 0, frameNo: f.frameNo, content: f.content,
});

// ---------------------------------------------------------------------------
// Shared prefix (built once)
// ---------------------------------------------------------------------------

interface Prefix {
	readonly frames: Record<StreamName, Record<"L1" | "L2", PrefixFrame[]>>;
	readonly snap: Record<StreamName, SnapshotRecord>;
	readonly lastSeq: Seq;
	readonly nsSeq: Seq;
	readonly blobRev: ReadonlyMap<DocId, Seq>;
}

async function buildPrefix(): Promise<Prefix> {
	const frames = { [NS_STREAM]: { L1: [], L2: [] }, [CFG_STREAM]: { L1: [], L2: [] } } as Record<StreamName, Record<"L1" | "L2", PrefixFrame[]>>;
	const blobRev = new Map<DocId, Seq>();
	let seq = 0;
	let nsSeq = 0;
	const nsOps = (cls: "L1" | "L2", j: number, s: Seq): NsOp[] => {
		if (cls === "L1" && j < 16) {
			if (j < 8) return [{ t: "create", docId: MD[j]!, kind: "markdown", path: mdPath(j), contentHash: hex(j + 1), size: j }];
			blobRev.set(BL[j - 8]!, s);
			return [{ t: "create", docId: BL[j - 8]!, kind: "blob", path: blPath(j - 8), contentHash: hex(j + 1), size: j }];
		}
		const k = cls === "L1" ? j : j + 1;
		switch (k % 3) {
			case 0: return [{ t: "rename", docId: MD[k % 8]!, path: mdPath(k * 7) }];
			case 1: return [{ t: "rename", docId: BL[k % 8]!, path: blPath(k * 5) }];
			default: {
				const docId = BL[k % 8]!;
				const baseRev = blobRev.get(docId)!;
				blobRev.set(docId, s);
				return [{ t: "setBlob", docId, hash: hex(s), size: k % 1000, baseRev }];
			}
		}
	};
	const cfgOps = (cls: "L1" | "L2", j: number): CfgOp[] =>
		(j + (cls === "L2" ? 1 : 0)) % 2 === 0
			? [{ t: "jsonSet", file: "app.json", key: `k${j % 20}`, valueJson: String(j) }]
			: [{ t: "pluginSet", pluginId: `p${j % 5}`, enabled: (j >> 1) % 2 === 0 }];
	const push = (cls: "L1" | "L2", stream: StreamName, j: number) => {
		const s = ++seq;
		const content = stream === NS_STREAM ? encodeNsOps(nsOps(cls, j, s)) : encodeCfgOps(cfgOps(cls, j));
		frames[stream]![cls].push({ seq: s, frameNo: FIRST + j, clientFrameId: cfid(`p${cls}`, stream, FIRST + j), authorNsSeq: nsSeq, content });
		if (stream === NS_STREAM) nsSeq = s;
	};
	for (let j = 0, k = 0; j < PREFIX_FRAMES.L1; j++) {
		push("L1", NS_STREAM, j);
		push("L1", CFG_STREAM, j);
		if (j % 91 === 90 && k < PREFIX_FRAMES.L2) {
			push("L2", NS_STREAM, k);
			push("L2", CFG_STREAM, k);
			k++;
		}
	}
	assert.equal(frames[NS_STREAM]!.L2.length, PREFIX_FRAMES.L2);
	const snap = {} as Record<StreamName, SnapshotRecord>;
	for (const stream of STREAMS) {
		const rows = [...frames[stream]!.L1.map((f) => tailOf(stream, f.seq, DEV.L1, f)), ...frames[stream]!.L2.map((f) => tailOf(stream, f.seq, DEV.L2, f))].sort((a, b) => a.seq - b.seq);
		const rt = runtimeOf(stream, repoOf(stream, undefined, rows));
		const folded = await rt.load();
		assert.equal(folded.length, rows.length, "the whole prefix folds");
		assert.equal(rt.halted, null);
		let ignoredFrames = 0;
		for (const fr of folded) for (const e of fr.events as readonly (NsFoldEvent | CfgFoldEvent)[]) if (isReplayReason(reasonOf(e))) ignoredFrames++;
		assert.equal(ignoredFrames, 0, "every honest prefix frame is accepted (§8.2 exactness)");
		const st = (rt as NsRuntime | CfgRuntime).state;
		for (const cls of ["L1", "L2"] as const) assert.equal(st.replay.get(DEV[cls])?.r, FIRST + PREFIX_FRAMES[cls] - 1, `${stream} ${cls} right edge`);
		if (rt instanceof NsRuntime) {
			for (const [docId, rev] of blobRev) assert.equal(rt.state.entries.get(docId)?.blob?.rev, rev, "every prefix setBlob was authored on the rev it saw (CAS applied)");
		}
		snap[stream] = { stream, coversSeq: rt.coversSeq, encoding: rt.encoding, bytes: rt.encodeState(), createdAtMs: 0 };
	}
	return { frames, snap, lastSeq: seq, nsSeq, blobRev };
}

// ---------------------------------------------------------------------------
// Per-seed lanes: one (device, stream) each
// ---------------------------------------------------------------------------

interface Lane {
	readonly stream: StreamName;
	readonly cls: Cls;
	readonly dev: DeviceId;
	/** Highest prefix frameNo (prefix frames FIRST..prefixMax are all committed); 0 for F. */
	readonly prefixMax: number;
	readonly frames: Frame[];
	readonly byFrameNo: Map<number, Frame>;
	/** Indices into frames not committed yet, ascending (= ascending frameNo). */
	readonly uncommitted: number[];
	readonly committed: Set<number>;
	readonly restartAt: number | null;
	/** Model of the reader's fold for this author: right edge and the ring (accept order). */
	r: number;
	readonly ring: ClientFrameId[];
	readonly ringF: number[];
	commits: number;
	readonly arms: Map<Age, number[]>;
}

interface Replay {
	readonly lane: Lane;
	readonly seq: Seq;
	readonly f: number;
	readonly age: Age;
	readonly expected: Reason;
	/** In frameNo order and the ring holds exactly r−63..r: the crisp rule applies. */
	readonly crisp: boolean;
	/** The window alone would have said replay-stale (f <= r − 64). */
	readonly windowStale: boolean;
	readonly inOrder: boolean;
}

const isCommitted = (l: Lane, f: number) => (f >= FIRST && f <= l.prefixMax) || l.committed.has(f);

function recorded(prefix: Prefix, l: Lane, f: number): Frame {
	if (f <= l.prefixMax) return prefix.frames[l.stream]![l.cls as "L1" | "L2"][f - FIRST]!;
	return l.byFrameNo.get(f)!;
}

/** The precedence of core/ns/fold.ts:271-286 = core/cfg/fold.ts:209-223, restated. */
function model(prefix: Prefix, l: Lane, f: number): Reason | "accept" {
	if (l.ring.includes(recorded(prefix, l, f).clientFrameId)) return "duplicate-frame";
	if (f <= l.r - REPLAY_WINDOW) return "replay-stale";
	if (isCommitted(l, f)) return "replay-duplicate";
	return "accept";
}

function suffixOps(rnd: SeededRandom, stream: StreamName, blobRev: ReadonlyMap<DocId, Seq>, newDoc: () => DocId): Uint8Array {
	const n = rnd.range(1, 2);
	if (stream === NS_STREAM) {
		const ops: NsOp[] = [];
		for (let i = 0; i < n; i++) {
			const k = rnd.int(10);
			if (k < 4) ops.push({ t: "rename", docId: rnd.pick(MD), path: mdPath(rnd.int(24)) });
			else if (k < 7) ops.push({ t: "rename", docId: rnd.pick(BL), path: blPath(rnd.int(24)) });
			else if (k < 9) {
				const docId = rnd.pick(BL);
				ops.push({ t: "setBlob", docId, hash: hex(0x10_0000 + rnd.int(1 << 20)), size: rnd.int(5000), baseRev: blobRev.get(docId)! });
			} else ops.push({ t: "create", docId: newDoc(), kind: "markdown", path: mdPath(rnd.int(24)), contentHash: hex(rnd.int(1 << 20)), size: rnd.int(100) });
		}
		return encodeNsOps(ops);
	}
	const ops: CfgOp[] = [];
	for (let i = 0; i < n; i++) {
		const k = rnd.int(10);
		if (k < 5) ops.push({ t: "jsonSet", file: "app.json", key: `k${rnd.int(20)}`, valueJson: String(rnd.int(1000)) });
		else if (k < 6) ops.push({ t: "jsonDel", file: "app.json", key: `k${rnd.int(20)}` });
		else ops.push({ t: "pluginSet", pluginId: `p${rnd.int(5)}`, enabled: rnd.chance(0.5) });
	}
	return encodeCfgOps(ops);
}

function makeLane(rnd: SeededRandom, seed: number, prefix: Prefix, stream: StreamName, cls: Cls): Lane {
	const prefixMax = cls === "F" ? 0 : FIRST + PREFIX_FRAMES[cls] - 1;
	const n = cls === "F" ? rnd.range(70, 100) : rnd.range(24, 40);
	const restartAt = rnd.chance(0.25) ? rnd.int(n) : null;
	const frames: Frame[] = [];
	const byFrameNo = new Map<number, Frame>();
	// allocFrameNo (foldRuntime.ts:239-247): L1/L2 continue the prefix runtime; F is fresh; a restart skips NS_DEDUPE_RING.
	let max = prefixMax;
	let allocated = cls !== "F";
	let docs = 0;
	const tag = `s${seed.toString(36)}${cls}`;
	for (let j = 0; j < n; j++) {
		if (!allocated || j === restartAt) {
			max += NS_DEDUPE_RING;
			allocated = true;
		}
		const frameNo = ++max;
		const fr: Frame = {
			frameNo, clientFrameId: cfid(tag, stream, frameNo), authorNsSeq: prefix.nsSeq,
			content: suffixOps(rnd, stream, prefix.blobRev, () => id22(`${tag}d${(docs++).toString(36)}`) as DocId),
		};
		frames.push(fr);
		byFrameNo.set(frameNo, fr);
	}
	const pf = cls === "F" ? [] : prefix.frames[stream]![cls].slice(-NS_DEDUPE_RING);
	const arms = new Map<Age, number[]>();
	for (const a of AGES_OF[cls]) arms.set(a, Array.from({ length: QUOTA }, () => rnd.int(n)).sort((x, y) => x - y));
	return {
		stream, cls, dev: DEV[cls], prefixMax, frames, byFrameNo, uncommitted: frames.map((_, i) => i), committed: new Set(), restartAt,
		r: prefixMax, ring: pf.map((f) => f.clientFrameId), ringF: pf.map((f) => f.frameNo), commits: 0, arms,
	};
}

const ringContiguous = (l: Lane) => l.ringF.length === NS_DEDUPE_RING && l.ringF[0] === l.r - NS_DEDUPE_RING + 1 && l.ringF.every((f, i) => i === 0 || f === l.ringF[i - 1]! + 1);

// ---------------------------------------------------------------------------

describe("replay (e2ee-design §20.2), measured over 1000 seeds", () => {
	it("recorded genuine ns/cfg frames re-appended at ages 1, 63, 64, 65, 1000, 100000: same digest; every row ignored as replay-*/duplicate-frame", async () => {
		const t0 = performance.now();
		const prefix = await buildPrefix();
		const tPrefix = performance.now() - t0;

		const sealer: Suite1Crypto = await createWebCryptoSuite1({ vaultId: VAULT, random: new SeededRandom(0x5ea1), keys: [{ e: 1, k: K(1) }] });
		sealer.markVerified(1);
		sealer.setSealEpoch(1);
		const reader: Suite1Crypto = await createWebCryptoSuite1({ vaultId: VAULT, random: new SeededRandom(0x4ead), keys: [{ e: 1, k: K(1) }] });
		reader.markVerified(1);
		const ctx: GateCtx = { crypto: reader, vaultId: VAULT as VaultId, maxCheckpointStateBytes: 1 << 20, staleCheck: () => null };
		const hash = createWebHash();
		const seal = async (l: Lane, f: Frame) =>
			(await sealFrame(sealer, VAULT as VaultId, { stream: l.stream, deviceId: l.dev, clientFrameId: f.clientFrameId, kind: l.stream === NS_STREAM ? "nsOps" : "cfgOps", authorNsSeq: f.authorNsSeq, flags: 0, frameNo: f.frameNo, content: f.content })).sealed;
		/** A prefix frame's payload as the relay recorded it (sealed once, on first use as a replay target). */
		const prefixPayload = new Map<string, Promise<Uint8Array>>();

		const tally = new Map<string, number>();
		const bump = (k: string, by = 1) => tally.set(k, (tally.get(k) ?? 0) + by);
		let genuineRows = 0, injected = 0, ignoredEvents = 0, digestsEqual = 0, replaysAuthenticated = 0, prefixTargets = 0;
		let crispChecked = 0, ringOverWindow = 0, windowDuplicate = 0, missed = 0, restarts = 0, seedsWithF = 0;

		for (let seed = 0; seed < SEEDS; seed++) {
			const rnd = new SeededRandom(0x7e9a_0000 + seed);
			const inOrder = seed % 2 === 0;
			const classes: Cls[] = seed % 3 === 0 ? ["L1", "L2", "F"] : ["L1", "L2"];
			if (classes.includes("F")) seedsWithF++;
			const lanes = STREAMS.flatMap((stream) => classes.map((cls) => makeLane(rnd, seed, prefix, stream, cls)));
			restarts += lanes.filter((l) => l.restartAt !== null).length;
			const payload = new Map<Frame, Uint8Array>();
			await Promise.all(lanes.flatMap((l) => l.frames.map(async (f) => void payload.set(f, await seal(l, f)))));

			// Commit schedule (relay order) with replays appended after genuine commits.
			let seq = prefix.lastSeq;
			const remaining = new Map<StreamName, number>(STREAMS.map((s) => [s, lanes.filter((l) => l.stream === s).reduce((n, l) => n + l.frames.length, 0)]));
			const genuine: { readonly lane: Lane; readonly seq: Seq; readonly f: Frame }[] = [];
			const replays: Replay[] = [];
			for (;;) {
				const live = lanes.filter((l) => l.uncommitted.length > 0);
				if (live.length === 0) break;
				const l = rnd.pick(live);
				let pos = 0;
				if (!inOrder) {
					const u = l.frames[l.uncommitted[0]!]!.frameNo;
					let w = 0;
					while (w < l.uncommitted.length && l.frames[l.uncommitted[w]!]!.frameNo < u + NS_SEND_WINDOW) w++;
					pos = rnd.int(w);
				}
				const f = l.frames[l.uncommitted.splice(pos, 1)[0]!]!;
				if (rnd.chance(0.2)) seq += rnd.range(1, 5); // rows of other streams
				genuine.push({ lane: l, seq: ++seq, f });
				assert.equal(model(prefix, l, f.frameNo), "accept", "an honest first commit is never a replay (§8.2)");
				l.r = Math.max(l.r, f.frameNo);
				l.committed.add(f.frameNo);
				l.ring.push(f.clientFrameId);
				l.ringF.push(f.frameNo);
				if (l.ring.length > NS_DEDUPE_RING) {
					l.ring.shift();
					l.ringF.shift();
				}
				l.commits++;
				const left = remaining.get(l.stream)! - 1;
				remaining.set(l.stream, left);
				if (left === 0) continue; // the stream's last row stays genuine
				for (const age of AGES_OF[l.cls]) {
					const arms = l.arms.get(age)!;
					if (arms.length === 0 || l.commits <= arms[0]!) continue;
					const target = l.r - age;
					if (!isCommitted(l, target)) continue;
					arms.shift();
					const expected = model(prefix, l, target);
					assert.notEqual(expected, "accept");
					replays.push({
						lane: l, seq: ++seq, f: target, age, expected: expected as Reason, inOrder,
						crisp: inOrder && ringContiguous(l), windowStale: target <= l.r - REPLAY_WINDOW,
					});
				}
			}
			for (const l of lanes) for (const a of l.arms.values()) missed += a.length;

			// Gate every row once (pure): genuine rows serve both runs.
			const replayPayload = (r: Replay): Promise<Uint8Array> => {
				const l = r.lane;
				if (r.f > l.prefixMax) return Promise.resolve(payload.get(l.byFrameNo.get(r.f)!)!);
				prefixTargets++;
				const key = `${l.stream}:${l.cls}:${r.f}`;
				let p = prefixPayload.get(key);
				if (!p) prefixPayload.set(key, (p = seal(l, recorded(prefix, l, r.f))));
				return p;
			};
			const gate = async (stream: StreamName, seq: Seq, l: Lane, f: Frame, bytes: Uint8Array): Promise<TailRecord> => {
				const g = await gateRow(ctx, hash, { stream, seq, deviceId: l.dev, clientFrameId: f.clientFrameId, payload: bytes }, 0);
				assert.equal(g.t, "row");
				const row = (g as { readonly row: TailRecord }).row;
				assert.ok(row.frameNo === f.frameNo && row.flags === 0 && row.authorNsSeq === f.authorNsSeq && bytesEqual(row.content, f.content), "opens to the recorded frame");
				return row;
			};
			const gRows = await Promise.all(genuine.map((g) => gate(g.lane.stream, g.seq, g.lane, g.f, payload.get(g.f)!)));
			const rRows = await Promise.all(replays.map(async (r) => gate(r.lane.stream, r.seq, r.lane, recorded(prefix, r.lane, r.f), await replayPayload(r))));
			genuineRows += gRows.length;
			replaysAuthenticated += rRows.length;
			injected += replays.length;

			for (const stream of STREAMS) {
				const a = gRows.filter((r) => r.stream === stream);
				const b = [...a, ...rRows.filter((r) => r.stream === stream)].sort((x, y) => x.seq - y.seq);
				const runA = runtimeOf(stream, repoOf(stream, prefix.snap[stream], a));
				const runB = runtimeOf(stream, repoOf(stream, prefix.snap[stream], b));
				const foldedA = await runA.load();
				const foldedB = await runB.load();
				assert.equal(runA.halted, null);
				assert.equal(runB.halted, null);
				assert.equal(foldedA.length, a.length);
				assert.equal(foldedB.length, b.length);
				assert.equal(runA.coversSeq, a[a.length - 1]!.seq);
				assert.ok(bytesEqual(runA.encodeState(), runB.encodeState()), `seed ${seed} ${stream}: fold digest differs with replays`);
				digestsEqual++;

				const evB = new Map<Seq, readonly (NsFoldEvent | CfgFoldEvent)[]>(foldedB.map((fr) => [fr.seq, fr.events as readonly (NsFoldEvent | CfgFoldEvent)[]]));
				const aSeqs = new Set(a.map((r) => r.seq));
				const genuineB = foldedB.filter((fr) => aSeqs.has(fr.seq));
				assert.equal(JSON.stringify(foldedA.map((fr) => fr.events)), JSON.stringify(genuineB.map((fr) => fr.events)), `seed ${seed} ${stream}: genuine rows fold the same`);
				let countA = 0, countB = 0;
				for (const fr of foldedA) for (const e of fr.events as readonly (NsFoldEvent | CfgFoldEvent)[]) if (isReplayReason(reasonOf(e))) countA++;
				for (const fr of foldedB) for (const e of fr.events as readonly (NsFoldEvent | CfgFoldEvent)[]) if (isReplayReason(reasonOf(e))) countB++;
				const mine = replays.filter((r) => r.lane.stream === stream);
				assert.equal(countA, 0, "no genuine row is ever ignored as a replay");
				assert.equal(countB, mine.length, `seed ${seed} ${stream}: ignored replay-*/duplicate-frame events == injected rows`);
				ignoredEvents += countB;
				for (const r of mine) {
					const evs = evB.get(r.seq)!;
					assert.equal(evs.length, 1);
					const e = evs[0]!;
					assert.ok(e.index === -1 && e.deviceId === r.lane.dev && e.clientFrameId === recorded(prefix, r.lane, r.f).clientFrameId);
					assert.equal(reasonOf(e), r.expected, `seed ${seed} ${stream} ${r.lane.cls} age ${r.age}: reason`);
					bump(`${stream}|${r.lane.cls}|${r.age}|${r.expected}`);
					bump(`${r.inOrder ? "inorder" : "reorder"}|${r.age}|${r.expected}`);
					if (r.crisp) {
						crispChecked++;
						assert.equal(r.expected, r.age <= REPLAY_WINDOW - 1 ? "duplicate-frame" : "replay-stale", "in frameNo order, no gap: a <= 63 ring, a >= 64 stale");
					}
					if (r.windowStale && r.expected === "duplicate-frame") ringOverWindow++;
					if (r.expected === "replay-duplicate") windowDuplicate++;
				}
			}
		}
		const wall = performance.now() - t0;

		// Totals: exact accounting, both precedence branches exercised.
		assert.equal(ignoredEvents, injected);
		assert.equal(replaysAuthenticated, injected);
		assert.equal(digestsEqual, SEEDS * STREAMS.length);
		const byAge = (age: Age, reason: Reason) => [...tally].filter(([k]) => k.startsWith("inorder|") || k.startsWith("reorder|")).filter(([k]) => k.endsWith(`|${age}|${reason}`)).reduce((n, [, v]) => n + v, 0);
		for (const age of AGES) {
			// Structure of the precedence: f > r − 64 is never replay-stale; f <= r − 64 is never replay-duplicate.
			if (age < REPLAY_WINDOW) assert.equal(byAge(age, "replay-stale"), 0, `age ${age}`);
			else assert.equal(byAge(age, "replay-duplicate"), 0, `age ${age}`);
			// Ages far outside the ring's reach: only the window speaks.
			if (age >= 1000) assert.equal(byAge(age, "duplicate-frame"), 0, `age ${age}`);
		}
		for (const stream of STREAMS) for (const cls of ["L1", "L2", "F"] as const) for (const age of AGES_OF[cls]) {
			const n = REASONS.reduce((s, r) => s + (tally.get(`${stream}|${cls}|${age}|${r}`) ?? 0), 0);
			assert.ok(n > 0, `${stream} ${cls} age ${age} covered`);
		}
		assert.ok(crispChecked > 0 && ringOverWindow > 0 && windowDuplicate > 0, "the ring-first and window-duplicate branches both occur");

		const lines = [
			`replay measured: ${SEEDS} seeds (${seedsWithF} with fresh F), ${genuineRows} genuine rows, ${injected} injected replays (${prefixTargets} of prefix frames), ${missed} quota slots unreachable, ${restarts} lane restarts`,
			`  digests equal ${digestsEqual}/${SEEDS * STREAMS.length}; ignored replay events ${ignoredEvents} == injected ${injected}; replays authenticated ${replaysAuthenticated}`,
			`  crisp-rule rows ${crispChecked}; ring-over-window (duplicate-frame with f <= r-64) ${ringOverWindow}; replay-duplicate ${windowDuplicate}`,
			`  wall ${(wall / 1000).toFixed(1)} s (prefix ${(tPrefix / 1000).toFixed(1)} s)`,
		];
		for (const mode of ["inorder", "reorder"]) for (const age of AGES) lines.push(`  ${mode} age ${age}: ${REASONS.map((r) => `${r} ${tally.get(`${mode}|${age}|${r}`) ?? 0}`).join(", ")}`);
		for (const stream of STREAMS) for (const cls of ["L1", "L2", "F"] as const) for (const age of AGES_OF[cls])
			lines.push(`  ${stream} ${cls} age ${age}: ${REASONS.map((r) => `${r} ${tally.get(`${stream}|${cls}|${age}|${r}`) ?? 0}`).join(", ")}`);
		console.log(lines.join("\n"));
	});
});
