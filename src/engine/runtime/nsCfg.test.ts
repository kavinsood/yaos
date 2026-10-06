import assert from "node:assert/strict";
import { test } from "node:test";
import type { CfgFoldEvent } from "../../core/cfg/fold";
import { MAX_NS_OPS_PER_FRAME } from "../../core/limits";
import { CFG_STREAM, docStream, type CfgOp, type ConfigRelPath, type NsOp, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { CfgLogPort } from "../settings/cfgSync";
import type { FoldedNsFrame } from "../sync/nsRuntime";
import { chunkOps } from "./logApi";
import type { LogEngine } from "./engine";
import { converged, startTestEngine, until } from "./testHarness";

const APP = "app.json" as ConfigRelPath;
const CKPT = { rows: 1e9, bytes: 1e12, idleMs: 10, fallbackMs: 50, nsRows: 3, nsBytes: 1e9 };
const NO_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 1e9, fallbackMs: 1e9, nsRows: 1e9, nsBytes: 1e12 };

function jsonValue(e: LogEngine, key: string): string | null | undefined {
	return e.cfgView().json.get(`${APP}\u0000${key}`)?.value;
}
async function stopAll(...es: LogEngine[]): Promise<void> {
	for (const e of es) await e.stop();
}

test("chunkOps: count limit, then byte bisection", () => {
	const ops = Array.from({ length: MAX_NS_OPS_PER_FRAME * 2 + 1 }, (_, i) => i);
	assert.deepEqual(chunkOps(ops, () => new Uint8Array(1)).map((p) => p.length), [MAX_NS_OPS_PER_FRAME, MAX_NS_OPS_PER_FRAME, 1]);
	const big = (part: readonly number[]) => new Uint8Array(part.length > 2 ? 2 * 1024 * 1024 : 1);
	assert.deepEqual(chunkOps([1, 2, 3, 4, 5], big).map((p) => p.length), [2, 1, 2]);
	assert.throws(() => chunkOps([1], () => new Uint8Array(2 * 1024 * 1024)), RangeError);
});

test("cfg: submitCfg shows in cfgView at once, converges on a second engine, onCfgFold fires", async () => {
	const relay = new SimRelay();
	const evA: CfgFoldEvent[] = [];
	const evB: CfgFoldEvent[] = [];
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { onCfgFold: (ev) => evA.push(...ev) } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", extra: { onCfgFold: (ev) => evB.push(...ev) } });
	try {
		// CfgLogPort (settings/cfgSync) is satisfied by the engine.
		const port: CfgLogPort = { view: () => a.cfgView(), submitCfg: async (ops) => void (await a.submitCfg(ops)) };
		relay.pauseCommits();
		const ops: CfgOp[] = [
			{ t: "jsonSet", file: APP, key: "vimMode", valueJson: "true" },
			{ t: "pluginSet", pluginId: "dataview", enabled: true },
		];
		await port.submitCfg(ops);
		assert.equal(jsonValue(a, "vimMode"), "true", "own pending op overlaid");
		assert.equal(a.cfgView().plugins.get("dataview")?.value, true);
		assert.equal(a.c.cfg.state.json.size, 0, "committed fold untouched");
		// The view is a copy: mutating it does not reach the engine.
		a.cfgView().json.clear();
		assert.equal(jsonValue(a, "vimMode"), "true");

		relay.resumeCommits();
		await until(() => jsonValue(b, "vimMode") === "true" && b.cfgView().plugins.get("dataview")?.value === true, 3_000, "b converges");
		await until(() => a.isIdle() && a.c.cfg.state.json.size === 1, 3_000, "a committed");
		assert.ok(evB.some((e) => e.outcome.t === "applied" && e.deviceId === "dev-a"), "b onCfgFold sees a's applied ops");
		assert.ok(evA.some((e) => e.outcome.t === "applied"), "a onCfgFold sees its own frame");

		// LWW: a later write from b wins on both.
		await b.submitCfg([{ t: "jsonSet", file: APP, key: "vimMode", valueJson: "false" }]);
		await until(() => jsonValue(a, "vimMode") === "false" && b.isIdle() && b.c.outbox.size === 0, 3_000, "lww");
		assert.equal(jsonValue(b, "vimMode"), "false");
		assert.equal(await b.submitCfg([]).then((ids) => ids.length), 0);
	} finally {
		await stopAll(a, b);
	}
});

test("cfg: checkpoint + compaction; a fresh engine adopts the cfg checkpoint; restart reloads the fold", async () => {
	const relay = new SimRelay({ sealBytes: 64 });
	const tuning = { checkpoint: CKPT, nsCandidateModulus: 2, compactRows: 2 };
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a", tuning });
	let c: LogEngine | null = null;
	let a2: LogEngine | null = null;
	try {
		for (let i = 0; i < 8; i++) await a.submitCfg([{ t: "jsonSet", file: APP, key: `k${i}`, valueJson: String(i) }]);
		await until(() => (relay.checkpoint(CFG_STREAM)?.coversSeq ?? 0) > 0, 4_000, "cfg checkpoint");
		await until(() => (a.c.repo.stream(CFG_STREAM)?.snapshotCoversSeq ?? 0) > 0, 4_000, "cfg compaction");
		await until(() => (a.maint.stats.checkpointOutcomes["cfg-ok"] ?? 0) >= 1, 2_000, "cfg-ok outcome counted");

		c = (await startTestEngine({ relay, deviceId: "dev-c", tuning: { checkpoint: NO_CKPT } })).engine;
		await until(() => jsonValue(c!, "k7") === "7", 4_000, "c has every key");
		for (let i = 0; i < 8; i++) assert.equal(jsonValue(c, `k${i}`), String(i));

		await a.stop();
		a2 = (await startTestEngine({ relay, deviceId: "dev-a", storage, tuning })).engine;
		for (let i = 0; i < 8; i++) assert.equal(jsonValue(a2, `k${i}`), String(i), "restart: snapshot + tail fold");
	} finally {
		await stopAll(...[a2 ?? a, c].filter((e): e is LogEngine => e !== null));
	}
});

test("ns: submitNs splits into frames, nsView shows them pending, onNsFold reports them on both engines", async () => {
	const relay = new SimRelay();
	const foldA: FoldedNsFrame[] = [];
	const foldB: FoldedNsFrame[] = [];
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", extra: { onNsFold: (f) => foldA.push(...f) } });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", extra: { onNsFold: (f) => foldB.push(...f) } });
	try {
		relay.pauseCommits();
		const d = await a.createDoc("r/start.md" as VaultPath, "hello");
		const n = MAX_NS_OPS_PER_FRAME + 88;
		const ops: NsOp[] = Array.from({ length: n }, (_, i) => ({ t: "rename", docId: d, path: `r/n${i}.md` as VaultPath }));
		const ids = await a.submitNs(ops);
		assert.equal(ids.length, 2, "two frames");
		const v = a.nsView();
		assert.equal(v.pending.length, 3, "create + 2 rename frames pending");
		assert.deepEqual(v.pending.slice(1).map((f) => f.clientFrameId), ids);
		assert.ok(v.pendingDocs.has(d));
		assert.equal(v.state.entries.get(d)?.path, `r/n${n - 1}.md`, "overlay applies every op");
		assert.equal(a.c.ns.state.entries.has(d), false, "committed fold untouched");
		assert.equal(a.listDocs().find((x) => x.docId === d)?.state, "pending");

		relay.resumeCommits();
		await converged([a, b]);
		await until(() => a.nsView().pending.length === 0, 2_000, "a pending drained");
		assert.equal(b.nsView().state.entries.get(d)?.path, `r/n${n - 1}.md`);
		assert.equal(b.nsView().caughtUp, true);
		for (const folded of [foldA, foldB]) {
			const mine = folded.filter((f) => f.deviceId === "dev-a");
			assert.equal(mine.length, 3);
			assert.deepEqual(mine.slice(1).map((f) => f.clientFrameId), ids);
			assert.deepEqual(mine.slice(1).map((f) => f.ops.length), [MAX_NS_OPS_PER_FRAME, 88]);
			assert.ok(mine[0]!.events.length > 0 && mine.every((f, i) => i === 0 || f.seq > mine[i - 1]!.seq));
		}
	} finally {
		await stopAll(a, b);
	}
});

test("bodyInfo / openBody: pending create, body frame held on the create, remote doc info", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		assert.equal(a.bodyInfo("d-unknown" as never), null);
		relay.pauseCommits();
		const d = await a.createDoc("notes/x.md" as VaultPath, "");
		const stream = docStream("markdown", d)!;
		const createCfid = a.nsView().pending.find((f) => f.ops.some((o) => o.t === "create" && o.docId === d))!.clientFrameId;
		const info0 = a.bodyInfo(d)!;
		assert.equal(info0.stream, stream);
		assert.equal(info0.hasContent, false, "empty create: no body frames");
		assert.equal(info0.frozen, false);

		const h = (await a.openBody(d, "markdown"))!;
		assert.equal(h.docId, d);
		assert.equal(h.bound, false);
		h.doc.transact(() => h.doc.getText("text").insert(0, "body text"), h.mergeOrigin);
		const v1 = await h.commitEdits();
		assert.ok(v1.localOrder > 0, "commitEdits returns the version incl. the own frame");
		assert.deepEqual(h.version(), v1);
		h.release();
		h.release(); // idempotent

		const recs = a.c.outbox.ofStream(stream);
		assert.equal(recs.length, 1);
		assert.equal(recs[0]!.state, "held");
		assert.equal(recs[0]!.dependsOn, createCfid, "first body frame depends on the in-outbox create");
		assert.equal(a.bodyInfo(d)!.hasContent, true);
		assert.ok(a.docsWithPendingBody().has(d));

		relay.resumeCommits();
		await converged([a, b]);
		assert.equal(await b.docText(d), "body text");
		const ib = b.bodyInfo(d)!;
		assert.equal(ib.stream, stream);
		assert.equal(ib.hasContent, true);
		assert.equal(ib.caughtUp, true);
		assert.ok(ib.version.remoteSeq > 0);
		assert.equal(a.docsWithPendingBody().size, 0);

		// After the create is committed a body frame has no dependency.
		const h2 = (await a.openBody(d, "markdown"))!;
		h2.doc.transact(() => h2.doc.getText("text").insert(0, ">"), h2.mergeOrigin);
		await h2.commitEdits();
		h2.release();
		const r2 = a.c.outbox.ofStream(stream);
		assert.ok(r2.every((r) => r.dependsOn === null), "no dependency once the create is folded");
		await converged([a, b]);
		assert.equal(await b.docText(d), ">body text");
	} finally {
		await stopAll(a, b);
	}
});
