/**
 * Crash at every §e.2 transaction boundary (DESIGN §k.3 WP-C #1).
 *
 * One scenario (feed + read on start, create, edits, live rows from a peer,
 * receipts, lazy T_sent, local compaction, remote checkpoints, rename, delete,
 * relay restart + resend) is run once to count device A's read-write commits,
 * then once per commit index k with A's storage crashing just before / just
 * after commit k. After each crash: the committed state is probed (cursor V
 * never passes an unaccounted seq), A restarts on it, and A + B must converge
 * with every durable outbox frame committed exactly once.
 *
 * YAOS_CRASH_SAMPLE=n runs every n-th index only (default 1 = every index).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientFrameId, DeviceId, StreamName, VaultId } from "../../core/types";
import { Repo } from "../store/repo";
import { MemStoragePort, type CommitDecision } from "../sync/__standins__/memStorage";
import { SimRelay } from "../sync/__standins__/simRelay";
import type { LogEngine } from "./engine";
import { converged, sleep, startTestEngine, until } from "./testHarness";

const TUNING = { compactRows: 4, checkpoint: { rows: 3, bytes: 1e9, idleMs: 10, fallbackMs: 40, nsRows: 3, nsBytes: 1e9 } };
const SAMPLE = Math.max(1, Number(process.env.YAOS_CRASH_SAMPLE ?? "1"));
const PAR = 6;

// Label each commit with the Repo transaction running on the crashing port.
const repoOf = new Map<unknown, Repo>();
const origOpen = Repo.open.bind(Repo);
(Repo as unknown as { open: typeof Repo.open }).open = async (storage, id, now, o) => {
	const r = await origOpen(storage, id, now, o);
	if (r.repo) repoOf.set(storage, r.repo);
	return r;
};

interface RunResult {
	readonly labels: string[];
	readonly crashed: { index: number; label: string } | null;
}

async function kill(e: LogEngine | null): Promise<void> {
	if (!e) return;
	e.disconnect();
	await Promise.race([e.stop().catch(() => undefined), sleep(1_000)]);
}

const IDENT = { vaultId: "vault-test" as VaultId, vaultEpoch: "sim-epoch-1", deviceId: "dev-a" as DeviceId, clientVersion: "test" };
const totals = { probes: 0, probedRows: 0, durableChecked: 0 };

async function probe(storage: MemStoragePort, relay: SimRelay): Promise<Set<ClientFrameId>> {
	const o = await Repo.open(storage, IDENT, Date.now());
	if (!o.repo) return new Set(); // crashed before the identity committed
	const repo = o.repo;
	const v = repo.cursor.vaultSeq;
	totals.probes++;
	for (const stream of relay.streams()) {
		const rec = repo.stream(stream);
		const tail = new Set((await repo.getTail(stream, 0, v)).map((r) => r.seq));
		for (const row of relay.rows(stream, { includeGc: true })) {
			if (row.seq > v) continue;
			totals.probedRows++;
			// Accounted: folded into the snapshot, stored in the tail, or (stream stale) above appliedSeq and below the known remote head.
			const ok = rec !== undefined && (row.seq <= rec.snapshotCoversSeq || tail.has(row.seq) || rec.frozen === 1
				|| (rec.stale === 1 && row.seq > rec.appliedSeq && rec.remoteHeadSeq >= row.seq));
			assert.ok(ok, `V=${v} passes unaccounted seq ${row.seq} (${stream.slice(0, 2)}; applied ${rec?.appliedSeq} remoteHead ${rec?.remoteHeadSeq} stale ${rec?.stale})`);
		}
	}
	const out = new Set((await repo.outboxAll()).filter((r) => r.state !== "adoptable").map((r) => r.clientFrameId));
	repo.close();
	return out;
}

async function scenario(k: number | null, decision: CommitDecision): Promise<RunResult> {
	const relay = new SimRelay();
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", tuning: TUNING });
	const storage = new MemStoragePort();
	const labels: string[] = [];
	let crashed: RunResult["crashed"] = null;
	storage.setCommitHook((info) => {
		const label = repoOf.get(storage)?.txLabel ?? "open";
		labels.push(label);
		if (k !== null && info.index === k) {
			crashed = { index: k, label };
			return decision;
		}
		return "commit";
	});
	const durable = new Set<ClientFrameId>();
	let a: LogEngine | null = null;
	let a2: LogEngine | null = null;
	try {
		await until(() => b.status().phase === "live", 3_000, "b live");
		const pre = await b.createDoc("pre.md", "b-before;");
		await until(() => b.isIdle(), 3_000, "b idle");
		const step = async (fn: () => Promise<unknown>) => {
			if (storage.dead) return;
			try {
				await fn();
			} catch {
				/* the crash surfaces as connection-lost somewhere */
			}
		};
		await step(async () => {
			a = (await startTestEngine({ relay, deviceId: "dev-a", storage, tuning: TUNING })).engine;
			const repo = a.c.repo;
			const orig = repo.tEdit.bind(repo);
			repo.tEdit = async (...args) => {
				const recs = await orig(...args);
				for (const r of recs) if (r.state !== "adoptable") durable.add(r.clientFrameId);
				return recs;
			};
		});
		const A = () => a!;
		await step(() => until(() => storage.dead || A().isIdle(), 3_000, "a idle"));
		let a1 = "" as never;
		await step(async () => void (a1 = await A().createDoc("a1.md", "alpha;") as never));
		for (let i = 0; i < 6; i++) {
			await step(() => A().editDoc(a1, (t) => t.insert(t.length, `e${i};`)));
			await step(() => sleep(15));
		}
		await b.editDoc(pre, (t) => t.insert(t.length, "b-live;"));
		await step(() => until(() => storage.dead || A().isIdle(), 3_000, "a idle 2"));
		await step(() => A().editDoc(pre, (t) => t.insert(0, "a-on-pre;")));
		await step(() => A().renameDoc(a1, "a1-renamed.md"));
		await step(async () => {
			const tmp = await A().createDoc("tmp.md", "gone soon");
			await until(() => storage.dead || A().isIdle(), 3_000, "a idle 3");
			await A().deleteDoc(tmp);
		});
		await step(async () => {
			relay.pauseCommits();
			await A().editDoc(a1, (t) => t.insert(0, "paused;"));
			await until(() => storage.dead || A().c.sender.inflightCount > 0, 2_000, "inflight");
			relay.restart();
			relay.resumeCommits();
		});
		relay.resumeCommits();
		await step(() => sleep(120)); // checkpoints / compaction / T_sent ticks
		await step(() => until(() => storage.dead || A().isIdle(), 3_000, "a idle 4"));
		if (k === null) {
			assert.equal(storage.dead, false);
			await converged([A(), b]);
			return { labels, crashed };
		}
		await kill(a);
		a = null;
		const copy = storage.crash();
		const inOutbox = await probe(copy, relay);
		const restartStore = copy.crash();
		for (const id of inOutbox) durable.add(id);
		a2 = (await startTestEngine({ relay, deviceId: "dev-a", storage: restartStore, tuning: TUNING })).engine;
		await converged([a2, b], 10_000);
		const mine = new Map<string, number>();
		for (const s of relay.streams()) for (const r of relay.rows(s as StreamName, { includeGc: true })) if (r.deviceId === "dev-a") mine.set(r.clientFrameId, (mine.get(r.clientFrameId) ?? 0) + 1);
		totals.durableChecked += durable.size;
		for (const id of durable) assert.equal(mine.get(id), 1, `durable frame ${id} committed exactly once (crash ${decision} #${k} ${(crashed as RunResult["crashed"])?.label})`);
		assert.equal(a2.c.outbox.size, 0, "outbox drained");
		assert.equal(a2.c.repo.cursor.vaultSeq, relay.head());
		assert.ok((await b.docText(pre)).includes("b-before;b-live;"));
		return { labels, crashed };
	} catch (e) {
		throw new Error(`crash ${decision} #${k} (${(crashed as RunResult["crashed"])?.label ?? "-"}): ${String(e instanceof Error ? e.stack : e)}`);
	} finally {
		await kill(a);
		await kill(a2);
		await b.stop();
	}
}

async function sweep(decision: CommitDecision, n: number): Promise<Map<string, number>> {
	const covered = new Map<string, number>();
	const ks: number[] = [];
	for (let k = 0; k < n + 4; k += SAMPLE) ks.push(k);
	for (let i = 0; i < ks.length; i += PAR) {
		const rs = await Promise.all(ks.slice(i, i + PAR).map((k) => scenario(k, decision)));
		for (const r of rs) if (r.crashed) covered.set(r.crashed.label, (covered.get(r.crashed.label) ?? 0) + 1);
	}
	return covered;
}

let baseline: string[] = [];

test("crash probe is not vacuous: a V jump past unread rows is reported", async () => {
	const relay = new SimRelay();
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b" });
	try {
		await until(() => b.status().phase === "live", 3_000, "live");
		await b.createDoc("x.md", "rows");
		await until(() => b.isIdle(), 3_000, "idle");
		const storage = new MemStoragePort();
		const o = await Repo.open(storage, IDENT, Date.now());
		await o.repo!.tFeedPage([], relay.head(), relay.head(), Date.now()); // bug: V jumps, no stream marked stale
		o.repo!.close();
		await assert.rejects(probe(storage, relay), /passes unaccounted seq/);
	} finally {
		await b.stop();
	}
});

test("crash sweep: baseline scenario converges and exercises every e.2 transaction", async () => {
	const r = await scenario(null, "commit");
	baseline = r.labels;
	const kinds = new Set(baseline);
	for (const t of ["open", "tFeedPage", "tReadPage", "tEdit", "tLive", "tSent", "tSnapshot", "tPatchStreams"]) assert.ok(kinds.has(t), `scenario runs ${t} (got ${[...kinds].join(",")})`);
	console.log(`crash baseline: ${baseline.length} commits: ${[...kinds].map((t) => `${t}x${baseline.filter((l) => l === t).length}`).join(" ")}`);
});

for (const decision of ["crash-before", "crash-after"] as const) {
	test(`crash sweep: ${decision} at every commit -> restart reconstructs, no frame lost, V accounted, converges`, async () => {
		assert.ok(baseline.length > 0);
		const covered = await sweep(decision, baseline.length);
		console.log(`crash ${decision}: ${[...covered].map(([t, n]) => `${t}x${n}`).join(" ")}; totals ${JSON.stringify(totals)}`);
		if (SAMPLE === 1) for (const t of ["open", "tFeedPage", "tReadPage", "tEdit", "tLive", "tSnapshot", "tPatchStreams"]) assert.ok(covered.has(t), `${decision} covered ${t}`);
	});
}
