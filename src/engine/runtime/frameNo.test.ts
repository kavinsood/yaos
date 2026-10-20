/**
 * Own frameNo allocation at engine level (e2ee-design §8.2): per stream,
 * 1 + the highest own frameNo known (fold R, own tail rows, outbox, floor),
 * the first allocation of each runtime skipping NS_DEDUPE_RING; the epoch
 * migration floor persists in meta (max-merged).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { NS_DEDUPE_RING } from "../../core/limits";
import { CFG_STREAM, NS_STREAM, type ConfigRelPath, type StreamName, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import type { ReadRequest, RelayPort } from "../../ports/relay";
import { startTestEngine, until, createDoc, sleep } from "./testHarness";

const APP = "app.json" as ConfigRelPath;
const R = NS_DEDUPE_RING;

async function ownFrameNos(e: LogEngine, stream: StreamName): Promise<number[]> {
	const tail = (await e.c.repo.getTail(stream)).filter((r) => r.deviceId === e.c.self).map((r) => r.frameNo ?? 0);
	const pending = [...e.c.outbox.ofStream(stream)].map((r) => r.frameNo ?? 0);
	return [...tail, ...pending];
}
async function settle(e: LogEngine): Promise<void> {
	await until(() => e.status().phase === "live" && e.isIdle() && e.c.outbox.size === 0, 3_000, "idle");
}
const cfg = (e: LogEngine, v: string) => e.submitCfg([{ t: "jsonSet", file: APP, key: "k", valueJson: v }]);
/** The tests above the in-flight one pin the skip's NS_DEDUPE_RING part: no wall-clock floor. */
function noClockFloor(e: LogEngine): LogEngine {
	e.c.ns.wallMs = e.c.cfg.wallMs = () => 0;
	return e;
}

test("frameNo: first allocation skips NS_DEDUPE_RING, then consecutive; the max survives restart via own rows", async () => {
	const relay = new SimRelay();
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a" });
	let a2: LogEngine | null = null;
	try {
		noClockFloor(a);
		await settle(a);
		relay.pauseCommits();
		await createDoc(a, "one.md" as VaultPath, "1");
		await createDoc(a, "two.md" as VaultPath, "2");
		void cfg(a, "1");
		await until(() => [...a.c.outbox.ofStream(CFG_STREAM)].length === 1, 3_000, "cfg queued");
		assert.deepEqual(await ownFrameNos(a, NS_STREAM), [R + 1, R + 2], "outbox frames, before any receipt");
		relay.resumeCommits();
		await settle(a);
		await cfg(a, "2");
		assert.deepEqual(await ownFrameNos(a, NS_STREAM), [R + 1, R + 2], "receipted: the own tail rows keep the frameNo");
		assert.deepEqual(await ownFrameNos(a, CFG_STREAM), [R + 1, R + 2], "cfg allocates on its own stream");
		await a.stop();

		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", storage }));
		noClockFloor(a2);
		await settle(a2);
		await createDoc(a2, "three.md" as VaultPath, "3");
		await createDoc(a2, "four.md" as VaultPath, "4");
		await settle(a2);
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [R + 1, R + 2, 2 * R + 3, 2 * R + 4], "restart: skip again from the persisted max");
	} finally {
		await a.stop();
		await a2?.stop();
	}
});

test("frameNo: the epoch-migration floor raises allocation and is kept in meta (max-merged)", async () => {
	const relay = new SimRelay();
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a", extra: { frameNoFloor: { ns: 1000, cfg: 5 } } });
	let a2: LogEngine | null = null;
	try {
		noClockFloor(a);
		await settle(a);
		assert.deepEqual(a.c.repo.frameNoFloor, { ns: 1000, cfg: 5 });
		await createDoc(a, "one.md" as VaultPath, "1");
		await cfg(a, "1");
		await settle(a);
		assert.deepEqual(await ownFrameNos(a, NS_STREAM), [1000 + R + 1]);
		assert.deepEqual(await ownFrameNos(a, CFG_STREAM), [5 + R + 1]);
		await a.stop();

		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", storage, extra: { frameNoFloor: { ns: 10, cfg: 2000 } } }));
		noClockFloor(a2);
		await settle(a2);
		assert.deepEqual(a2.c.repo.frameNoFloor, { ns: 1000, cfg: 2000 }, "max-merged, never lowered");
		await cfg(a2, "2");
		await settle(a2);
		assert.deepEqual(await ownFrameNos(a2, CFG_STREAM), [5 + R + 1, 2000 + R + 1]);
	} finally {
		await a.stop();
		await a2?.stop();
	}
});

// A store that lost IndexedDB knows nothing of its own committed frames until it reads ns: a frame allocated before
// that read (offline) took R + 1, a number its earlier frames had already used, and every reader ignored it as
// replay-duplicate: the create never folded (suite-1 seed 163). Before ns/cfg sends open, such frames are numbered
// again above the committed edge (+ NS_DEDUPE_RING, as the first allocation).
test("frameNo: frames allocated before a lost store read ns are renumbered above its committed frames", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	let a2: LogEngine | null = null;
	try {
		noClockFloor(a);
		await settle(a);
		await createDoc(a, "one.md" as VaultPath, "1");
		await createDoc(a, "two.md" as VaultPath, "2");
		await cfg(a, "1");
		await settle(a);
		await a.stop();

		relay.setConnectFailure("unavailable");
		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", extra: { vaultEpoch: relay.vaultEpoch() } })); // fresh storage: IndexedDB lost
		noClockFloor(a2);
		await createDoc(a2, "three.md" as VaultPath, "3");
		await cfg(a2, "2");
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [R + 1], "allocated before ns was read");
		relay.setConnectFailure(null);
		await settle(a2);
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [R + 1, R + 2, R + 2 + R + 1]);
		assert.deepEqual(await ownFrameNos(a2, CFG_STREAM), [R + 1, R + 1 + R + 1]);
		const live = (e: LogEngine, p: string) => e.listDocs().some((d) => d.path === p && d.state === "live");
		await until(() => live(b, "three.md") && live(a2!, "three.md"), 3_000, "the create folded on both devices");
		const k = (e: LogEngine) => e.c.cfg.state.json.get(`${APP}\u0000k`)?.value ?? null;
		await until(() => k(b) === "2" && k(a2!) === "2", 3_000, "the cfg set folded on both devices");
	} finally {
		await a.stop();
		await b.stop();
		await a2?.stop();
	}
});

/** `relay`, with every read of ns or cfg failing (network) while `failing.on`: the socket and the feed still work. */
function failingNsReads(relay: SimRelay, failing: { on: boolean }): RelayPort {
	const fails = (streams: readonly StreamName[]) => failing.on && streams.some((s) => s === NS_STREAM || s === CFG_STREAM);
	return {
		connect: async (p) => {
			const r = await relay.connect(p);
			if (!r.ok) return r;
			const s = r.session;
			const session = new Proxy(s, {
				get(t, k) {
					if (k === "read") return (st: StreamName, after: number, pc: boolean) => (fails([st]) ? Promise.reject(new Error("network_error")) : t.read(st, after, pc));
					if (k === "readBatch") return (reqs: readonly ReadRequest[]) => (fails(reqs.map((q) => q.stream)) ? Promise.reject(new Error("network_error")) : t.readBatch(reqs));
					const v: unknown = Reflect.get(t, k, t);
					return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
				},
			});
			return { ok: true, session };
		},
	};
}

// Suite-1 seed 51: after an IDB wipe the session came up but every ns/cfg read failed. The engine still went live and
// opened the ns sends: the planner took the empty ns view for "every synced file deleted remotely" and trashed them,
// and the creates made meanwhile went out under frameNos the device had used, ignored as replay-stale. The phase stays
// catching-up and ns/cfg frames wait until the reads complete; then the frames are renumbered.
test("frameNo: a session whose ns/cfg reads fail stays catching-up with ns sends closed until a read completes", async () => {
	const relay = new SimRelay();
	const failing = { on: false };
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	let a2: LogEngine | null = null;
	try {
		noClockFloor(a);
		await settle(a);
		await createDoc(a, "one.md" as VaultPath, "1");
		await createDoc(a, "two.md" as VaultPath, "2");
		await settle(a);
		await a.stop();

		failing.on = true;
		({ engine: a2 } = await startTestEngine({ relay: failingNsReads(relay, failing), deviceId: "dev-a" })); // IDB lost
		noClockFloor(a2);
		await until(() => a2!.c.session !== null, 3_000, "session up");
		await createDoc(a2, "three.md" as VaultPath, "3");
		await sleep(300);
		assert.equal(a2.status().phase, "catching-up", "ns not read: not live");
		assert.equal(a2.c.sender.nsWindowOpen, false, "ns not read: ns sends closed");
		assert.equal(relay.rows(NS_STREAM).filter((r) => r.deviceId === "dev-a").length, 2, "nothing sent under a blind frameNo");
		failing.on = false;
		await settle(a2);
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [R + 1, R + 2, R + 2 + R + 1]);
		const live = (e: LogEngine, p: string) => e.listDocs().some((d) => d.path === p && d.state === "live");
		await until(() => live(b, "three.md") && live(a2!, "three.md"), 3_000, "the create folded on both devices");
	} finally {
		await a.stop();
		await b.stop();
		await a2?.stop();
	}
});

// Sim seed 222 (2 devices, fault-heavy): A crashed, restarted and sent a create under R + R + 1 (its runtime's first
// allocation, the skip above its fold edge R). The relay had not committed it when A's IndexedDB was wiped. The new
// store read ns at the same edge R and its first allocation took the same number; the old frame committed first and
// every reader ignored the new one as replay-duplicate. The new create never folded, the planner took the synced
// doc for pruned and trashed the attachment. A skip from the same known edge repeats the lost runtime's number, so
// the first allocation of a runtime also starts at least at the wall clock in ms (e2ee-design §8.2).
test("frameNo: a store that lost IndexedDB does not reuse the number of a frame still in flight from before", async () => {
	const relay = new SimRelay();
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	let a1: LogEngine | null = null;
	let a2: LogEngine | null = null;
	try {
		await settle(a);
		await createDoc(a, "one.md" as VaultPath, "1");
		await settle(a);
		await a.stop();

		({ engine: a1 } = await startTestEngine({ relay, deviceId: "dev-a", storage }));
		await settle(a1);
		relay.pauseCommits();
		await createDoc(a1, "two.md" as VaultPath, "2");
		await until(() => relay.pendingCount() > 0, 3_000, "two.md in flight");
		await a1.stop(); // the old socket's frame stays with the relay

		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", extra: { vaultEpoch: relay.vaultEpoch() } })); // fresh storage: IndexedDB lost
		await until(() => a2!.status().phase === "live", 3_000, "a2 live");
		await createDoc(a2, "three.md" as VaultPath, "3");
		await until(() => relay.pendingCount() > 1, 3_000, "three.md in flight");
		relay.resumeCommits();
		await settle(a2);
		const live = (e: LogEngine, p: string) => e.listDocs().some((d) => d.path === p && d.state === "live");
		await until(() => live(b, "two.md") && live(b, "three.md") && live(a2!, "three.md"), 3_000, "both creates folded");
	} finally {
		await a.stop();
		await b.stop();
		await a1?.stop();
		await a2?.stop();
	}
});

test("frameNo: the skip takes a plausible wall clock as its floor and ignores a wild one", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		const now = Date.UTC(2026, 9, 20);
		a.c.ns.wallMs = () => now;
		b.c.ns.wallMs = () => Number.MAX_SAFE_INTEGER - 10; // a later increment would leave the codec's range
		await settle(a);
		await settle(b);
		await createDoc(a, "a.md" as VaultPath, "a");
		await createDoc(b, "b.md" as VaultPath, "b");
		await settle(a);
		await settle(b);
		assert.deepEqual(await ownFrameNos(a, NS_STREAM), [now + 1]);
		assert.deepEqual(await ownFrameNos(b, NS_STREAM), [R + 1], "a wild clock falls back to the NS_DEDUPE_RING skip");
	} finally {
		await a.stop();
		await b.stop();
	}
});
