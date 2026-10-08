/**
 * e2ee-design §20.2 "Stale epoch", measured: after a revoke wins at S_rot, old-epoch frames sealed with K_{r−1}
 * and committed past S_rot are all ignored, nothing is quarantined, and the ns/cfg fold digests equal those of the
 * same rows without them. Old-epoch frames committed before the revoke row are still accepted. 1000 seeds; every
 * row of every seed is checked, nothing sampled. The rule is §14.3, as the gate implements it: the verdict
 * comes from the outer header's keyEpoch before any open (src/engine/ingest/gate.ts:137-146, keyring answer
 * src/engine/keyring/book.ts:158-165). gateRow (src/engine/sync/ingestRow.ts:47) then makes a stale ns/cfg row a
 * tail row flagged LOCAL_FLAG_STALE_EPOCH with frameNo 0 and empty content (ingestRow.ts:59), which folds as one
 * ignored/stale-epoch event and changes neither the ring nor the window (foldRuntime.ts:151, nsRuntime.ts /
 * cfgRuntime.ts foldStale). A stale body/canvas row is only accounted: no quarantine, no freeze
 * (ingestRow.ts:58).
 *
 * Per seed: a reader with a real testkit Keyring (testkit/world.ts) is pinned at epoch 1 (genesis, K_1). The
 * revoke(2) record is its `k` row at S_rot, and installQr(2, K_2) settles it as the winner, the same steps as
 * keyring.ops.test.ts "stale past S_rot below r". The reader gates with that keyring's crypto and staleCheck.
 *  - Before S_rot: honest devices H1, H2, the device R that is later revoked, and the lagging device L seal under
 *    K_1, on ns, cfg and b: streams. These are the old-epoch frames committed BEFORE the revoke row, and all of
 *    them must be accepted.
 *  - After S_rot: H1 and H2 seal under K_2. R (revoked, still holding K_1, §14.4) appends K_1 frames on ns, cfg,
 *    b: and c:, with fresh clientFrameIds and frameNos right above its window, so only §14.3 stops them.
 *    L had not seen the revoke yet: its first post-S_rot ns/cfg frames commit sealed under K_1, and later come its
 *    copies re-sealed under K_2, which keep the frameNo and get a new clientFrameId (ingestRow.ts:86-94 ownCommitCopy,
 *    §14.2 step 4). Half the seeds put an injected row at S_rot + 1, and half put an accepted K_1 row at S_rot − 1.
 *  - Checkpoints (§14.3, second half): a K_1 checkpoint at a coversSeq <= S_rot opens, a K_1 checkpoint at a
 *    coversSeq > S_rot is rejected as stale-epoch (not reader-dependent: treated as absent), and a K_2 one at the
 *    same coversSeq opens.
 * "Injected" = R's post-S_rot rows and L's stale originals. Run A folds every other row; run B folds all rows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import type { CfgFoldEvent } from "../../core/cfg/fold";
import { encodeCfgOps } from "../../core/codec/cfgOps";
import { encodeCheckpointContent } from "../../core/codec/contents";
import { bytesEqual } from "../../core/codec/lib0";
import { encodeNsOps } from "../../core/codec/nsOps";
import type { EnvelopeKind } from "../../core/envelope";
import { NS_DEDUPE_RING } from "../../core/limits";
import {
	CFG_STREAM, NS_STREAM, bodyStream, canvasStream, streamClass,
	type CfgOp, type ClientFrameId, type ContentHash, type DeviceId, type DocId, type NsFoldEvent, type NsOp, type Seq, type StreamName, type VaultId, type VaultPath,
} from "../../core/types";
import { SeededRandom } from "../../sim/random";
import { createWebCryptoSuite1, type Suite1Crypto } from "../adapters/webCryptoSuite1";
import { createWebHash } from "../adapters/webHash";
import { sealCheckpoint, sealFrame } from "../ingest/envelope";
import { gate, type GateCtx } from "../ingest/gate";
import type { Repo } from "../store/repo";
import type { TailRecord } from "../store/schema";
import { CfgRuntime } from "../sync/cfgRuntime";
import { LOCAL_FLAG_STALE_EPOCH } from "../sync/foldRuntime";
import { gateRow } from "../sync/ingestRow";
import { NsRuntime } from "../sync/nsRuntime";
import { K, VAULT, device, genesis, revoke } from "./testkit/world";

const SEEDS = 1000;
const H1 = "dev-h1" as DeviceId, H2 = "dev-h2" as DeviceId, R = "dev-revoked" as DeviceId, L = "dev-lagging" as DeviceId;
const READER = "dev-reader" as DeviceId;
const FOLDED = [NS_STREAM, CFG_STREAM] as const;
type Cls = "ns" | "cfg" | "body" | "canvas";
const CLASSES: readonly Cls[] = ["ns", "cfg", "body", "canvas"];
type Role = "pre" | "post" | "copy" | "injected";

interface Row {
	readonly stream: StreamName;
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly role: Role;
	readonly epoch: 1 | 2;
	readonly kind: EnvelopeKind;
	readonly frameNo: number;
	readonly authorNsSeq: Seq;
	readonly content: Uint8Array;
}

const id22 = (s: string) => s.padEnd(22, "_");
const hex = (n: number) => n.toString(16).padStart(64, "0");
const ydoc = (text: string, map = false): Uint8Array => {
	const d = new Y.Doc();
	if (map) d.getMap("nodes").set("n", text);
	else d.getText("text").insert(0, text);
	return Y.encodeStateAsUpdate(d);
};
const reasonOf = (e: NsFoldEvent | CfgFoldEvent): string | null => {
	const o = e.outcome as { readonly kind?: string; readonly t?: string; readonly reason?: string };
	return o.kind === "ignored" || o.t === "ignored" ? o.reason ?? null : null;
};
const FRAME_LEVEL = new Set(["duplicate-frame", "replay-stale", "replay-duplicate", "stale-epoch", "rules-version"]);

function repoOf(stream: StreamName, rows: readonly TailRecord[]): Repo {
	const appliedSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : 0;
	return {
		stream: (s: StreamName) => (s === stream ? { stream, appliedSeq } : undefined),
		getSnapshot: async () => undefined,
		getTail: async (s: StreamName, after: Seq = 0, through: Seq = Number.MAX_SAFE_INTEGER) =>
			s === stream ? rows.filter((r) => r.seq > after && r.seq <= through) : [],
	} as unknown as Repo;
}
async function fold(stream: StreamName, rows: readonly TailRecord[]): Promise<{ readonly rt: NsRuntime | CfgRuntime; readonly events: Map<Seq, readonly (NsFoldEvent | CfgFoldEvent)[]> }> {
	const rt = stream === NS_STREAM ? new NsRuntime(repoOf(stream, rows), READER) : new CfgRuntime(repoOf(stream, rows), READER);
	const folded = await rt.load();
	assert.equal(rt.halted, null);
	assert.equal(folded.length, rows.length);
	return { rt, events: new Map(folded.map((f) => [f.seq, f.events as readonly (NsFoldEvent | CfgFoldEvent)[]])) };
}

/** One seed's relay rows, in seq order (the `k` rows at 1 and S_rot are the keyring's). */
function timeline(seed: number): { readonly rows: Row[]; readonly sRot: Seq } {
	const rnd = new SeededRandom(0x57a1_e000 + seed);
	const rows: Row[] = [];
	const tag = seed.toString(36);
	let seq = 1; // genesis `k` row
	let lastNs = 0;
	let n = 0;
	const frameNo = new Map<string, number>();
	const docs: DocId[] = [];
	const bodyDocs = [id22(`b${tag}x`) as DocId, id22(`b${tag}y`) as DocId];
	const nextFrameNo = (dev: DeviceId, stream: StreamName) => {
		const k = `${dev}|${stream}`;
		const f = (frameNo.get(k) ?? NS_DEDUPE_RING) + 1; // fresh runtimes start at 65 (foldRuntime.ts:239-247)
		frameNo.set(k, f);
		return f;
	};
	const nsContent = (dev: DeviceId, hostile: boolean): Uint8Array => {
		const ops: NsOp[] = [];
		if (docs.length < 2 || rnd.chance(0.35)) {
			const docId = id22(`d${tag}${(n++).toString(36)}`) as DocId;
			docs.push(docId);
			ops.push({ t: "create", docId, kind: "markdown", path: `${hostile ? "evil" : dev === H1 ? "h" : "g"}${rnd.int(12)}.md` as VaultPath, contentHash: hex(rnd.int(1 << 20)) as ContentHash, size: rnd.int(50) });
		} else ops.push({ t: "rename", docId: rnd.pick(docs), path: `${hostile ? "evil" : "r"}${rnd.int(12)}.md` as VaultPath });
		return encodeNsOps(ops);
	};
	const cfgContent = (hostile: boolean): Uint8Array => {
		const ops: CfgOp[] = rnd.chance(0.6)
			? [{ t: "jsonSet", file: "app.json", key: `k${rnd.int(6)}`, valueJson: hostile ? "666" : String(rnd.int(100)) }]
			: [{ t: "pluginSet", pluginId: `p${rnd.int(4)}`, enabled: hostile ? true : rnd.chance(0.5) }];
		return encodeCfgOps(ops);
	};
	const frame = (role: Role, epoch: 1 | 2, dev: DeviceId, cls: Cls, at?: Seq): Row => {
		const s = at ?? (rnd.chance(0.25) ? (seq += rnd.range(2, 4)) : ++seq);
		seq = s;
		const hostile = role === "injected" && dev === R;
		let stream: StreamName, kind: EnvelopeKind, content: Uint8Array, f = 0;
		switch (cls) {
			case "ns": stream = NS_STREAM; kind = "nsOps"; content = nsContent(dev, hostile); f = nextFrameNo(dev, stream); break;
			case "cfg": stream = CFG_STREAM; kind = "cfgOps"; content = cfgContent(hostile); f = nextFrameNo(dev, stream); break;
			case "body": stream = bodyStream(rnd.pick(bodyDocs)); kind = "bodyUpdate"; content = ydoc(hostile ? "EVIL " : `t${rnd.int(100)} `); break;
			case "canvas": stream = canvasStream(rnd.pick(bodyDocs)); kind = "canvasUpdate"; content = ydoc("EVIL", true); break;
		}
		const row: Row = { stream, seq: s, deviceId: dev, clientFrameId: id22(`f${tag}${(n++).toString(36)}`) as ClientFrameId, role, epoch, kind, frameNo: f, authorNsSeq: lastNs, content };
		if (stream === NS_STREAM) lastNs = s;
		rows.push(row);
		return row;
	};
	const honestCls = (): Cls => rnd.weighted<Cls>([["ns", 4], ["cfg", 3], ["body", 3]]);

	// Before S_rot: everyone under K_1.
	const nPre = rnd.range(8, 40);
	for (let i = 0; i < nPre; i++) frame("pre", 1, rnd.pick([H1, H2, R, L]), i < 2 ? "ns" : honestCls());
	const edgePre = rnd.chance(0.5);
	if (edgePre) frame("pre", 1, rnd.pick([R, L, H1]), rnd.pick<Cls>(["ns", "cfg", "body"]));
	const sRot = seq + (edgePre ? 1 : rnd.range(2, 6));
	seq = sRot;

	// After S_rot: H under K_2; R's K_1 injections; L's stale K_1 originals, then their K_2 copies.
	const tokens: ("H" | "R" | "Lo")[] = [];
	const nPost = rnd.range(8, 40), nR = rnd.range(4, 30), nLag = rnd.range(1, 4);
	for (let i = 0; i < nPost; i++) tokens.push("H");
	for (let i = 0; i < nR; i++) tokens.push("R");
	for (let i = 0; i < nLag; i++) tokens.push("Lo");
	rnd.shuffle(tokens);
	const lastLo = tokens.lastIndexOf("Lo");
	const plan: ("H" | "R" | "Lo" | "Lc")[] = [...tokens];
	for (let i = 0; i < nLag; i++) plan.splice(rnd.range(lastLo + 1 + i, plan.length), 0, "Lc");
	if (rnd.chance(0.5)) plan.unshift("R"); // an injected row at S_rot + 1
	const originals: Row[] = [];
	let first = true;
	for (const t of plan) {
		const at = first ? sRot + 1 : undefined;
		first = false;
		if (t === "H") frame("post", 2, rnd.pick([H1, H2]), honestCls(), at);
		else if (t === "R") frame("injected", 1, R, rnd.weighted<Cls>([["ns", 3], ["cfg", 3], ["body", 2], ["canvas", 1]]), at);
		else if (t === "Lo") originals.push(frame("injected", 1, L, rnd.pick<Cls>(["ns", "cfg"]), at));
		else {
			// ownCommitCopy: same frame re-sealed under the current epoch, new clientFrameId, same frameNo.
			const o = originals.shift()!;
			const s = rnd.chance(0.25) ? (seq += rnd.range(2, 4)) : ++seq;
			const copy: Row = { ...o, seq: s, role: "copy", epoch: 2, clientFrameId: id22(`c${tag}${(n++).toString(36)}`) as ClientFrameId };
			if (o.stream === NS_STREAM) lastNs = s;
			rows.push(copy);
		}
	}
	// Each folded stream ends with a genuine row (stale rows also move coversSeq).
	frame("post", 2, H1, "ns");
	frame("post", 2, H2, "cfg");
	return { rows, sRot };
}

describe("stale epoch (e2ee-design §20.2, §14.3), measured over 1000 seeds", () => {
	it("after a revoke at S_rot, K_{r−1} frames past it are all ignored, none quarantined, digests unchanged; before it they are accepted", async () => {
		const t0 = performance.now();
		const g = await genesis();
		const rv = await revoke(2);
		const hash = createWebHash();
		const sealer = async (e: 1 | 2): Promise<Suite1Crypto> => {
			const c = await createWebCryptoSuite1({ vaultId: VAULT, random: new SeededRandom(0x5ea1 + e), keys: e === 1 ? [{ e: 1, k: K(1) }] : [{ e: 1, k: K(1) }, { e: 2, k: K(2) }] });
			c.markVerified(1);
			if (e === 2) c.markVerified(2);
			c.setSealEpoch(e);
			return c;
		};
		const seal = { 1: await sealer(1), 2: await sealer(2) } as const;

		const n = {
			rows: 0, injected: 0, staleVerdicts: 0, staleTail: 0, accounted: 0, quarantined: 0, staleEvents: 0, digestsEqual: 0,
			preAccepted: 0, preAcceptedByDevice: { [R]: 0, [L]: 0, H: 0 } as Record<string, number>, edgePre: 0, edgePost: 0, copiesAccepted: 0,
			ckptOpenPre: 0, ckptStaleRejected: 0, ckptOpenR: 0,
			injectedBy: Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<Cls, number>,
			preBy: Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<Cls, number>,
		};

		for (let seed = 0; seed < SEEDS; seed++) {
			const { rows, sRot } = timeline(seed);
			// The reader: pinned at 1, the revoke(2) `k` row at S_rot, settled by the re-key QR.
			const d = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
			await d.ingest([1, g], [sRot, rv]);
			assert.equal(d.kr.staleCheck(1, sRot + 1), "hold", "an open revoke holds");
			assert.equal(await d.kr.installQr(2, K(2)), "verified");
			assert.equal(d.kr.staleCheck(1, sRot), null);
			assert.equal(d.kr.staleCheck(1, sRot + 1), "stale");
			assert.equal(d.kr.staleCheck(2, sRot + 1), null);
			const ctx: GateCtx = { crypto: d.kc, vaultId: VAULT as VaultId, maxCheckpointStateBytes: 1 << 20, staleCheck: (e, s) => d.kr.staleCheck(e, s ?? Number.MAX_SAFE_INTEGER) };

			const payloads = await Promise.all(rows.map(async (r) =>
				(await sealFrame(seal[r.epoch], VAULT as VaultId, { stream: r.stream, deviceId: r.deviceId, clientFrameId: r.clientFrameId, kind: r.kind, authorNsSeq: r.authorNsSeq, flags: 0, frameNo: r.frameNo, content: r.content })).sealed));
			const gated = await Promise.all(rows.map(async (r, i) => {
				const input = { stream: r.stream, seq: r.seq, deviceId: r.deviceId, clientFrameId: r.clientFrameId, payload: payloads[i]! };
				return { row: r, g: await gateRow(ctx, hash, input, 0), verdict: r.role === "injected" ? await gate(ctx, { t: "row", ...input }) : null };
			}));
			n.rows += rows.length;
			if (rows.some((r) => r.seq === sRot - 1 && r.role === "pre")) n.edgePre++;
			if (rows.some((r) => r.seq === sRot + 1 && r.role === "injected")) n.edgePost++;

			const tails = new Map<StreamName, { a: TailRecord[]; b: TailRecord[] }>(FOLDED.map((s) => [s, { a: [], b: [] }]));
			for (const { row: r, g: res, verdict } of gated) {
				const cls = streamClass(r.stream) as Cls;
				if (res.t === "quarantine") n.quarantined++;
				assert.notEqual(res.t, "quarantine", `seed ${seed}: nothing is quarantined`);
				if (r.role === "injected") {
					assert.ok(r.seq > sRot && r.epoch === 1);
					n.injected++;
					n.injectedBy[cls]++;
					assert.ok(verdict && verdict.ok && verdict.t === "stale" && verdict.keyEpoch === 1, "gate: stale before open");
					n.staleVerdicts++;
					if (cls === "ns" || cls === "cfg") {
						assert.equal(res.t, "row");
						const t = (res as { readonly row: TailRecord }).row;
						assert.ok(t.flags === LOCAL_FLAG_STALE_EPOCH && t.frameNo === 0 && t.content.length === 0 && t.authorNsSeq === 0);
						n.staleTail++;
						tails.get(r.stream)!.b.push(t);
					} else {
						assert.equal(res.t, "account", "a stale body/canvas row is accounted only");
						n.accounted++;
					}
					continue;
				}
				// Genuine: opens to what was sealed, under either epoch.
				assert.equal(res.t, "row", `seed ${seed} ${r.role} ${cls}`);
				const t = (res as { readonly row: TailRecord }).row;
				assert.ok(t.flags === 0 && t.frameNo === r.frameNo && t.kind === r.kind && bytesEqual(t.content, r.content));
				if (r.role === "pre") {
					assert.ok(r.seq < sRot && r.epoch === 1);
					n.preAccepted++;
					n.preBy[cls]++;
					const who = r.deviceId === R || r.deviceId === L ? r.deviceId : "H";
					n.preAcceptedByDevice[who] = (n.preAcceptedByDevice[who] ?? 0) + 1;
				}
				if (cls === "ns" || cls === "cfg") {
					tails.get(r.stream)!.a.push(t);
					tails.get(r.stream)!.b.push(t);
				}
			}

			for (const stream of FOLDED) {
				const { a, b } = tails.get(stream)!;
				b.sort((x, y) => x.seq - y.seq);
				const A = await fold(stream, a);
				const B = await fold(stream, b);
				assert.ok(bytesEqual(A.rt.encodeState(), B.rt.encodeState()), `seed ${seed} ${stream}: digest changed by stale rows`);
				n.digestsEqual++;
				const aSeqs = new Set(a.map((r) => r.seq));
				let staleA = 0, staleB = 0;
				for (const evs of A.events.values()) for (const e of evs) {
					assert.ok(!FRAME_LEVEL.has(reasonOf(e) ?? ""), "every genuine frame (incl. K_1 before S_rot and L's copies) is accepted");
					if (reasonOf(e) === "stale-epoch") staleA++;
				}
				for (const [s, evs] of B.events) {
					if (aSeqs.has(s)) {
						assert.equal(JSON.stringify(evs), JSON.stringify(A.events.get(s)), "genuine rows fold the same");
						continue;
					}
					assert.equal(evs.length, 1);
					assert.ok(evs[0]!.index === -1 && reasonOf(evs[0]!) === "stale-epoch");
					staleB++;
				}
				assert.equal(staleA, 0);
				assert.equal(staleB, b.length - a.length, `seed ${seed} ${stream}: one ignored/stale-epoch event per injected row`);
				n.staleEvents += staleB;
				// R's K_1 frames before S_rot moved its window; its frames past S_rot did not (nor the ring).
				const preR = rows.filter((r) => r.stream === stream && r.deviceId === R && r.role === "pre");
				const injectedIds = new Set(rows.filter((r) => r.stream === stream && r.role === "injected").map((r) => r.clientFrameId));
				assert.equal(B.rt.state.replay.get(R)?.r, preR.length > 0 ? preR[preR.length - 1]!.frameNo : undefined);
				for (const ring of B.rt.state.recentFrames.values()) assert.ok(ring.every((c) => !injectedIds.has(c)));
				n.copiesAccepted += rows.filter((r) => r.stream === stream && r.role === "copy").length;

				// Checkpoints: K_1 at coversSeq <= S_rot opens; K_1 past S_rot is stale-epoch; K_2 past S_rot opens.
				const preRows = a.filter((r) => r.seq < sRot);
				const ckpt = async (e: 1 | 2, rt: NsRuntime | CfgRuntime) => {
					const content = encodeCheckpointContent({ encoding: rt.encoding, coversSeq: rt.coversSeq, foldRulesVersion: rt.rulesVersion, state: rt.encodeState() });
					const payload = await sealCheckpoint(seal[e], VAULT as VaultId, stream, rt.coversSeq, content, 0);
					return gate(ctx, { t: "checkpoint", stream, coversSeq: rt.coversSeq, payload });
				};
				if (preRows.length > 0) {
					const P = await fold(stream, preRows);
					const v = await ckpt(1, P.rt);
					assert.ok(v.ok && v.t === "checkpoint", "K_1 checkpoint at coversSeq <= S_rot opens");
					n.ckptOpenPre++;
				}
				const v1 = await ckpt(1, A.rt);
				assert.ok(!v1.ok && v1.reason === "stale-epoch" && !v1.readerDependent, "K_1 checkpoint past S_rot: stale-epoch");
				n.ckptStaleRejected++;
				const v2 = await ckpt(2, A.rt);
				assert.ok(v2.ok && v2.t === "checkpoint");
				n.ckptOpenR++;
			}
		}
		const wall = performance.now() - t0;

		assert.equal(n.quarantined, 0);
		assert.equal(n.staleVerdicts, n.injected);
		assert.equal(n.staleTail + n.accounted, n.injected);
		assert.equal(n.staleEvents, n.staleTail, "every injected ns/cfg row: exactly one ignored/stale-epoch event");
		assert.equal(n.digestsEqual, SEEDS * FOLDED.length);
		for (const c of CLASSES) assert.ok(n.injectedBy[c] > 0, `injected ${c}`);
		for (const c of ["ns", "cfg", "body"] as const) assert.ok(n.preBy[c] > 0, `pre-S_rot ${c}`);
		assert.ok(n.preAcceptedByDevice[R]! > 0 && n.preAcceptedByDevice[L]! > 0 && n.edgePre > 0 && n.edgePost > 0 && n.copiesAccepted > 0);
		console.log([
			`stale-epoch measured: ${SEEDS} seeds, ${n.rows} rows, wall ${(wall / 1000).toFixed(1)} s`,
			`  injected past S_rot ${n.injected} (${CLASSES.map((c) => `${c} ${n.injectedBy[c]}`).join(", ")}): gate stale ${n.staleVerdicts}, stale tail rows ${n.staleTail}, accounted ${n.accounted}, quarantined ${n.quarantined}`,
			`  ignored/stale-epoch events ${n.staleEvents} == injected ns/cfg ${n.staleTail}; digests equal ${n.digestsEqual}/${SEEDS * FOLDED.length}`,
			`  K_1 before S_rot accepted ${n.preAccepted} (${(["ns", "cfg", "body"] as const).map((c) => `${c} ${n.preBy[c]}`).join(", ")}; revoked ${n.preAcceptedByDevice[R]}, lagging ${n.preAcceptedByDevice[L]}, honest ${n.preAcceptedByDevice.H}); seeds with a K_1 row at S_rot-1 ${n.edgePre}, injected at S_rot+1 ${n.edgePost}`,
			`  lagging copies under K_2 accepted ${n.copiesAccepted}`,
			`  checkpoints: K_1 at coversSeq <= S_rot opened ${n.ckptOpenPre}; K_1 past S_rot rejected stale-epoch ${n.ckptStaleRejected}; K_2 past S_rot opened ${n.ckptOpenR}`,
		].join("\n"));
	});
});
