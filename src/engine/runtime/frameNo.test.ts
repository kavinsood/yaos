/**
 * Own frameNo allocation at engine level (e2ee-design §8.2): per stream, 1 + the highest own frameNo the store knows
 * (fold R, own tail rows, the outbox). A deviceId serves exactly one store (identity-per-store §1.3), so that is
 * exact: a fresh store starts at 1, a restart continues from its own rows, and a store that replaced a lost one is
 * another device with its own replay window, whatever the lost store had in flight.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CFG_STREAM, NS_STREAM, type ConfigRelPath, type StreamName, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import type { ReadRequest, RelayPort } from "../../ports/relay";
import { startTestEngine, until, createDoc, sleep } from "./testHarness";

const APP = "app.json" as ConfigRelPath;

async function ownFrameNos(e: LogEngine, stream: StreamName): Promise<number[]> {
	const tail = (await e.c.repo.getTail(stream)).filter((r) => r.deviceId === e.c.self).map((r) => r.frameNo ?? 0);
	const pending = [...e.c.outbox.ofStream(stream)].map((r) => r.frameNo ?? 0);
	return [...tail, ...pending];
}
async function settle(e: LogEngine): Promise<void> {
	await until(() => e.status().phase === "live" && e.isIdle() && e.c.outbox.size === 0, 3_000, "idle");
}
const cfg = (e: LogEngine, v: string) => e.submitCfg([{ t: "jsonSet", file: APP, key: "k", valueJson: v }]);
const live = (e: LogEngine, p: string) => e.listDocs().some((d) => d.path === p && d.state === "live");

test("frameNo: a fresh store starts at 1, consecutive per stream; a restart continues from its own rows, no skip", async () => {
	const relay = new SimRelay();
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a" });
	let a2: LogEngine | null = null;
	try {
		await settle(a);
		relay.pauseCommits();
		await createDoc(a, "one.md" as VaultPath, "1");
		await createDoc(a, "two.md" as VaultPath, "2");
		void cfg(a, "1");
		await until(() => [...a.c.outbox.ofStream(CFG_STREAM)].length === 1, 3_000, "cfg queued");
		assert.deepEqual(await ownFrameNos(a, NS_STREAM), [1, 2], "outbox frames, before any receipt");
		relay.resumeCommits();
		await settle(a);
		await cfg(a, "2");
		assert.deepEqual(await ownFrameNos(a, NS_STREAM), [1, 2], "receipted: the own tail rows keep the frameNo");
		assert.deepEqual(await ownFrameNos(a, CFG_STREAM), [1, 2], "cfg allocates on its own stream");
		await a.stop();

		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", storage }));
		await settle(a2);
		await createDoc(a2, "three.md" as VaultPath, "3");
		await createDoc(a2, "four.md" as VaultPath, "4");
		await settle(a2);
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [1, 2, 3, 4], "restart: 1 + the persisted max");
	} finally {
		await a.stop();
		await a2?.stop();
	}
});

test("frameNo: a restart with an own frame committed but not receipted continues above it", async () => {
	const relay = new SimRelay();
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a" });
	let a2: LogEngine | null = null;
	try {
		await settle(a);
		await createDoc(a, "one.md" as VaultPath, "1");
		await settle(a);
		relay.pauseCommits();
		await createDoc(a, "two.md" as VaultPath, "2");
		await until(() => relay.pendingCount() > 0, 3_000, "two.md in flight");
		await a.stop();
		relay.resumeCommits(); // it commits with the socket gone: no receipt reaches the store

		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", storage }));
		await createDoc(a2, "three.md" as VaultPath, "3");
		await settle(a2);
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [1, 2, 3], "the unreceipted frame kept its number (its resend settles as a late receipt)");
		await until(() => live(a2!, "two.md") && live(a2!, "three.md"), 3_000, "both folded");
	} finally {
		await a.stop();
		await a2?.stop();
	}
});

// Sim seed 222 (2 devices, fault-heavy): A's create was still in the relay's buffer when A's IndexedDB was wiped. With
// one deviceId for both stores the new store's first frame took the same frameNo and whichever committed second was
// ignored as replay-duplicate (the attachment was trashed); a wall-clock floor papered over it. Now the new store is
// a new device (identity-per-store §4): its numbers start at 1 in a window of its own, and both creates fold.
test("frameNo: the store replacing a lost one is a new device: the lost store's frame in flight never collides", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	let a2: LogEngine | null = null;
	try {
		await settle(a);
		await createDoc(a, "one.md" as VaultPath, "1");
		await settle(a);
		relay.pauseCommits();
		await createDoc(a, "two.md" as VaultPath, "2");
		await until(() => relay.pendingCount() > 0, 3_000, "two.md in flight");
		await a.stop(); // the old socket's frame stays with the relay

		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a2", extra: { vaultEpoch: relay.vaultEpoch() } })); // IndexedDB lost: a new store
		await until(() => a2!.status().phase === "live", 3_000, "a2 live");
		await createDoc(a2, "three.md" as VaultPath, "3");
		await until(() => relay.pendingCount() > 1, 3_000, "three.md in flight");
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [1], "a new device starts at 1");
		relay.resumeCommits();
		await settle(a2);
		await until(() => live(b, "two.md") && live(b, "three.md") && live(a2!, "three.md"), 3_000, "both creates folded");
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
// opened the ns sends: the planner took the empty ns view for "every synced file deleted remotely" and trashed them.
// The phase stays catching-up and ns/cfg frames wait until the reads complete (the late-receipt reads and the stale-
// epoch reseal need them too, DESIGN §d.7, e2ee-design §14.2).
test("frameNo: a session whose ns/cfg reads fail stays catching-up with ns sends closed until a read completes", async () => {
	const relay = new SimRelay();
	const failing = { on: false };
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	let a2: LogEngine | null = null;
	try {
		await settle(a);
		await createDoc(a, "one.md" as VaultPath, "1");
		await createDoc(a, "two.md" as VaultPath, "2");
		await settle(a);
		await a.stop();

		failing.on = true;
		({ engine: a2 } = await startTestEngine({ relay: failingNsReads(relay, failing), deviceId: "dev-a2" })); // IDB lost: a new store
		await until(() => a2!.c.session !== null, 3_000, "session up");
		await createDoc(a2, "three.md" as VaultPath, "3");
		await sleep(300);
		assert.equal(a2.status().phase, "catching-up", "ns not read: not live");
		assert.equal(a2.c.sender.nsWindowOpen, false, "ns not read: ns sends closed");
		assert.equal(relay.rows(NS_STREAM).filter((r) => r.deviceId === "dev-a2").length, 0, "nothing sent before the reads");
		failing.on = false;
		await settle(a2);
		assert.deepEqual(await ownFrameNos(a2, NS_STREAM), [1]);
		await until(() => live(b, "three.md") && live(a2!, "three.md"), 3_000, "the create folded on both devices");
	} finally {
		await a.stop();
		await b.stop();
		await a2?.stop();
	}
});
