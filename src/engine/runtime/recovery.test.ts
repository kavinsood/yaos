/**
 * Recovery paths: outbox mirror after IDB loss (DESIGN §e.4, §i.5) and live
 * queue overflow -> T_stale -> read (DESIGN §d.7).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientFrameId } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import type { LogEngine } from "./engine";
import type { SideFilePort } from "../../ports/vault";
import { MemStoragePort } from "../../sim/storage";
import { MemSideFiles, converged, sleep, startTestEngine, until } from "./testHarness";

async function live(...es: LogEngine[]): Promise<void> {
	await until(() => es.every((e) => e.status().phase === "live"), 3_000, "live");
}

function countsByFrame(relay: SimRelay): Map<string, number> {
	const m = new Map<string, number>();
	for (const s of relay.streams()) for (const r of relay.rows(s, { includeGc: true })) if (r.deviceId === "dev-a") m.set(r.clientFrameId, (m.get(r.clientFrameId) ?? 0) + 1);
	return m;
}

for (const committed of [false, true]) {
	const what = committed ? "relay committed them (receipts lost)" : "relay lost them (restart)";
	test(`mirror recovery: IDB lost with unreceipted frames, ${what} -> fresh DB imports the mirror, resends, each frame once`, async () => {
		const relay = new SimRelay();
		const side = new MemSideFiles();
		const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
		const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a", sideFiles: side });
		let a2: LogEngine | null = null;
		try {
			await live(a, b);
			const id = await a.createDoc("m.md", "base;");
			await converged([a, b]);
			relay.pauseCommits();
			await a.editDoc(id, (t) => t.insert(t.length, "lost1;"));
			const made = await a.createDoc("new.md", "made offline-ish;");
			await a.renameDoc(id, "m-renamed.md");
			await until(() => a.c.sender.inflightCount >= 3, 2_000, "sent");
			const frames = [...a.c.outbox.values()].map((r) => r.clientFrameId as ClientFrameId);
			assert.ok(frames.length >= 4);
			await sleep(60); // mirror debounce
			const w = side.writes;
			assert.ok(w > 0, "outbox mirror written");
			a.disconnect();
			await a.stop();
			if (committed) relay.resumeCommits();
			else {
				relay.restart();
				relay.resumeCommits();
			}
			await relay.settled();
			a2 = (await startTestEngine({ relay, deviceId: "dev-a", sideFiles: side })).engine; // new MemStoragePort: the DB is gone
			assert.ok(a2.status().notices.some((n) => n.code === "recovered-from-mirror"));
			await converged([a2, b], 10_000);
			assert.equal(await b.docText(id), "base;lost1;");
			assert.equal(await b.docText(made), "made offline-ish;");
			assert.equal(b.listDocs().find((d) => d.docId === id)?.path, "m-renamed.md");
			const counts = countsByFrame(relay);
			for (const f of frames) assert.equal(counts.get(f), 1, `frame ${f} committed exactly once`);
			assert.equal(a2.c.outbox.size, 0);
			assert.equal(a2.c.repo.cursor.vaultSeq, relay.head());
			// The imported synced records carry no localOrder: the imported frames' text is not known to be on disk.
			assert.ok((a2.bodyInfo(id)?.version.localOrder ?? 0) > 0, "imported body frames move localOrder");
			await a2.editDoc(id, (t) => t.insert(0, "A2;"));
			await converged([a2, b]);
			assert.equal(await b.docText(id), "A2;base;lost1;");
		} finally {
			await b.stop();
			await a2?.stop();
		}
	});
}

/** Side files of an app process that can die: after kill() nothing it writes lands. */
function mortal(side: MemSideFiles): { port: SideFilePort; kill: () => void } {
	let alive = true;
	const port: SideFilePort = {
		read: (n) => side.read(n), remove: (n) => side.remove(n), list: (p) => side.list(p),
		write: async (n, b) => {
			if (alive) await side.write(n, b);
		},
	};
	return { port, kill: () => (alive = false) };
}

/** Sim heavy seed 246: the app died inside the mirror debounce; the next run over that store must rewrite the mirror. */
test("mirror recovery: a restart over stored frames the mirror lacks rewrites it, so a later IDB loss still resends them", async () => {
	const relay = new SimRelay();
	const side = new MemSideFiles();
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	const p1 = mortal(side);
	const { engine: a, storage } = await startTestEngine({ relay, deviceId: "dev-a", sideFiles: p1.port, tuning: { mirrorDebounceMs: 60_000 } });
	let a2: LogEngine | null = null;
	let a3: LogEngine | null = null;
	try {
		await live(a, b);
		const id = await a.createDoc("m.md", "base;");
		await converged([a, b]);
		relay.pauseCommits();
		await a.editDoc(id, (t) => t.insert(t.length, "kept;"));
		await until(() => a.c.outbox.size > 0, 2_000, "frame stored");
		p1.kill(); // dies before the debounced mirror write
		const copy = (storage as MemStoragePort).crash();
		a.disconnect();
		await a.stop().catch(() => undefined);
		relay.restart(); // the uncommitted frame is gone from the relay too
		relay.resumeCommits();
		relay.setConnectFailure("unavailable"); // the second run stays offline: its outbox never changes
		const p2 = mortal(side);
		a2 = (await startTestEngine({ relay, deviceId: "dev-a", sideFiles: p2.port, storage: copy, extra: { vaultEpoch: relay.vaultEpoch() } })).engine;
		assert.ok(a2.c.outbox.size > 0);
		await sleep(80); // mirror debounce
		p2.kill(); // IDB wiped with the app down
		a2.disconnect();
		await a2.stop().catch(() => undefined);
		relay.setConnectFailure(null);
		a3 = (await startTestEngine({ relay, deviceId: "dev-a", sideFiles: side })).engine; // fresh DB
		assert.ok(a3.status().notices.some((n) => n.code === "recovered-from-mirror"), "recovered from the mirror");
		await converged([a3, b], 10_000);
		assert.equal(await b.docText(id), "base;kept;");
	} finally {
		await b.stop();
		await a3?.stop();
	}
});

/** Sim heavy seed 150: keystrokes receipted before the IDB loss, never saved to disk, read back as "own". */
test("IDB lost without a mirror: this device's earlier rows read back are remote (remoteSeq moves)", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	let a2: LogEngine | null = null;
	try {
		await live(a);
		const id = await a.createDoc("o.md", "a1;");
		await a.editDoc(id, (t) => t.insert(t.length, "a2;"));
		await until(() => a.c.outbox.size === 0, 2_000, "receipted");
		assert.equal(a.bodyInfo(id)?.version.remoteSeq, 0, "own receipted rows are local in their store");
		await a.stop();
		a2 = (await startTestEngine({ relay, deviceId: "dev-a" })).engine; // fresh DB, no side files
		await live(a2);
		// "live" is set before the body catch-up reads o.md's stream (sessionLoop.onSession): wait for the read-back.
		await until(async () => (await a2!.docText(id)) === "a1;a2;", 2_000, "own rows read back");
		await until(() => (a2!.bodyInfo(id)?.version.remoteSeq ?? 0) > 0, 2_000, "remoteSeq moved");
		const before = a2.bodyInfo(id)!.version;
		await a2.editDoc(id, (t) => t.insert(0, "b;"));
		await until(() => a2!.c.outbox.size === 0, 2_000, "receipted again");
		assert.equal(a2.bodyInfo(id)!.version.remoteSeq, before.remoteSeq, "rows this store receipted stay local");
	} finally {
		await a2?.stop();
	}
});

test("live overflow: queue over liveQueueMaxRows drops cold payloads -> stale -> read later; converges", async () => {
	const relay = new SimRelay();
	const { engine: a } = await startTestEngine({ relay, deviceId: "dev-a" });
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", tuning: { liveQueueMaxRows: 3 } });
	try {
		await live(a, b);
		relay.pauseCommits();
		const ids = [];
		for (let i = 0; i < 12; i++) ids.push(await a.createDoc(`o${i}.md`, `body ${i};`));
		await until(() => a.c.sender.inflightCount >= 12, 2_000, "ns creates sent (bodies held on them)");
		relay.resumeCommits();
		await converged([a, b], 10_000);
		assert.ok(b.c.live.stats.overflows > 0, "overflowed");
		assert.ok(b.c.live.stats.stale > 0, "rows recorded stale");
		for (let i = 0; i < ids.length; i++) assert.equal(await b.docText(ids[i]!), `body ${i};`);
		assert.equal(b.c.repo.cursor.vaultSeq, relay.head());
		assert.equal([...b.c.repo.streams()].filter((r) => r.stale).length, 0);
	} finally {
		await a.stop();
		await b.stop();
	}
});
