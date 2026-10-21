/** gateRow's §14.3 rows (e2ee-design §9.3): stale ns/cfg/snap fold as empty, stale bodies are accounted only, hold waits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CFG_STREAM, NS_STREAM, SNAP_STREAM, type ClientFrameId, type DeviceId, type StreamName, type VaultId } from "../../core/types";
import { encodeOuter } from "../../core/codec/envelope";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import type { GateCtx } from "../ingest/gate";
import type { OutboxRecord, TailRecord } from "../store/schema";
import { sealFrame } from "../ingest/envelope";
import { gateRow, ownCommitCopy } from "./ingestRow";
import { SnapRuntime } from "./snapRuntime";
import { SeededRandom } from "../../sim/random";
import { LOCAL_FLAG_STALE_EPOCH, LOCAL_FLAG_UNOPENED, type FoldRepo } from "./foldRuntime";

const hash = createWebHash();
const ctx: GateCtx = { crypto: createNoopCrypto(hash), vaultId: "v1" as VaultId, maxCheckpointStateBytes: 1 << 20, staleCheck: (e) => (e === 9 ? "hold" : e < 3 ? "stale" : null) };
const under = (e: number) => encodeOuter({ formatVersion: 1, suite: 1, keyEpoch: e }, new Uint8Array(48).fill(5));
const at = (stream: StreamName, e: number) => gateRow(ctx, hash, { stream, seq: 11, deviceId: "dev-x" as DeviceId, clientFrameId: "cf" as ClientFrameId, payload: under(e) }, 0);

test("gateRow: stale ns/cfg/snap rows are stored flagged and empty, frameNo 0; stale body/canvas/x are accounted only", async () => {
	for (const [stream, kind] of [[NS_STREAM, "nsOps"], [CFG_STREAM, "cfgOps"], [SNAP_STREAM, "snapOps"]] as const) {
		const r = await at(stream, 2);
		assert.ok(r.t === "row");
		assert.equal(r.row.kind, kind);
		assert.equal(r.row.flags, LOCAL_FLAG_STALE_EPOCH);
		assert.equal(r.row.frameNo, 0, "never touches the replay window");
		assert.equal(r.row.content.length, 0);
	}
	for (const s of ["b:doc1", "c:doc2", "x:blob"]) assert.deepEqual(await at(s as StreamName, 2), { t: "account" }, `${s}: no quarantine, no freeze`);
});

test("gateRow: hold keeps ns rows unopened (raw payload, the fold halts) and quarantines bodies as keyring-hold", async () => {
	const ns = await at(NS_STREAM, 9);
	assert.ok(ns.t === "row" && ns.row.flags === LOCAL_FLAG_UNOPENED);
	assert.deepEqual(ns.row.content, under(9));
	const body = await at("b:doc1" as StreamName, 9);
	assert.ok(body.t === "quarantine" && body.rec.reason === "keyring-hold");
});

/** The snapshot plus the tail; nothing else of the Repo is used by FoldRuntime.load() and gap(). */
function repoOf(rows: readonly TailRecord[]): FoldRepo {
	const appliedSeq = rows[rows.length - 1]!.seq;
	return {
		stream: (s: StreamName) => (s === SNAP_STREAM ? { stream: s, appliedSeq } : undefined),
		getSnapshot: async () => undefined,
		getTail: async (s: StreamName, after: number = 0, through: number = Number.MAX_SAFE_INTEGER) =>
			s === SNAP_STREAM ? rows.filter((r) => r.seq > after && r.seq <= through) : [],
	};
}

test("a stale snap row last in the stream: the snap fold covers it as ignored, and it is no gap (sim seed 174)", async () => {
	// A replay of an old-epoch snap frame landed last (hostileReplay): every reader judges it stale. Accounted and
	// not stored, the fold's coversSeq stayed below the stream's head for good.
	const r = await at(SNAP_STREAM, 2);
	assert.ok(r.t === "row");
	const rt = new SnapRuntime(repoOf([r.row]), "dev-r" as DeviceId);
	const folded = await rt.load();
	assert.equal(rt.coversSeq, 11);
	assert.equal(folded[0]?.events[0]?.outcome.t, "ignored");
	assert.equal(await rt.gap(), null, "every reader ignores a stale-epoch row: nothing of the index is missing");
});

test("a row every reader's gate refused is a gap for blob GC, and no gap for retirement (sim HOSTILE_FAULTS seed 20)", async () => {
	// A hostile member's garbage on a fold stream fails the gate for every reader (not reader-dependent): stored empty.
	// Retirement's "no create can be hidden" (body/retire.ts FoldCompleteness) holds over it; blob GC stays strict.
	const binding = { stream: SNAP_STREAM, deviceId: "dev-x" as DeviceId, clientFrameId: "cf" as ClientFrameId };
	// A body update on a fold stream (hostile.ts wrongKind).
	const sealed = await sealFrame(ctx.crypto, ctx.vaultId, { ...binding, kind: "bodyUpdate", authorNsSeq: 0, flags: 0, frameNo: 0, content: new Uint8Array([1, 2, 3]) });
	const r = await gateRow(ctx, hash, { ...binding, seq: 11, payload: sealed.sealed }, 0);
	assert.ok(r.t === "row" && r.row.flags === 0 && r.row.content.length === 0);
	const rt = new SnapRuntime(repoOf([r.row]), "dev-r" as DeviceId);
	await rt.load();
	assert.equal(rt.coversSeq, 11, "the fold covers it");
	assert.deepEqual(await rt.gap(), { seq: 11, reason: "row failed the gate" });
	assert.equal(await rt.gap({ rejectedComplete: true }), null);
});

test("ownCommitCopy: an own snap frame committed stale is stored as readers store it, not folded as sent", () => {
	const ob: OutboxRecord = {
		clientFrameId: "cf" as ClientFrameId, order: 1, stream: SNAP_STREAM, kind: "snapOps", state: "pending", sealed: under(2), content: new Uint8Array([1, 2]),
		authorNsSeq: 0, flags: 0, frameNo: null, keyEpoch: 2, dependsOn: null, adoptOf: null, createdAtMs: 0,
	};
	const copy = ownCommitCopy(ctx, new SeededRandom(1), "dev-x" as DeviceId, ob, 11);
	assert.ok(copy?.row);
	assert.equal(copy.row.flags, LOCAL_FLAG_STALE_EPOCH);
	assert.equal(copy.row.content.length, 0);
});
