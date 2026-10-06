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
import { startTestEngine, until } from "./testHarness";

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

test("frameNo: first allocation skips NS_DEDUPE_RING, then consecutive; the max survives restart via own rows", async () => {
	const relay = new SimRelay();
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a" });
	let a2: LogEngine | null = null;
	try {
		await settle(a);
		relay.pauseCommits();
		await a.createDoc("one.md" as VaultPath, "1");
		await a.createDoc("two.md" as VaultPath, "2");
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
		await settle(a2);
		await a2.createDoc("three.md" as VaultPath, "3");
		await a2.createDoc("four.md" as VaultPath, "4");
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
		await settle(a);
		assert.deepEqual(a.c.repo.frameNoFloor, { ns: 1000, cfg: 5 });
		await a.createDoc("one.md" as VaultPath, "1");
		await cfg(a, "1");
		await settle(a);
		assert.deepEqual(await ownFrameNos(a, NS_STREAM), [1000 + R + 1]);
		assert.deepEqual(await ownFrameNos(a, CFG_STREAM), [5 + R + 1]);
		await a.stop();

		({ engine: a2 } = await startTestEngine({ relay, deviceId: "dev-a", storage, extra: { frameNoFloor: { ns: 10, cfg: 2000 } } }));
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
