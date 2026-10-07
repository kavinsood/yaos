/**
 * Live creates (DESIGN §d.4, §e.1) crashed at every §e.2 transaction boundary, in the style of crash.test.ts:
 * live creates with body frames in one commit, a create merged away with its frames committed (junk) or sent
 * and dropped unreceipted, a live create across a relay restart. After each crash A restarts on the committed
 * state; it must converge with B, drain its outbox (no orphaned held or gated record) and commit every durable
 * frame exactly once, except a merged-away create's body frames: at most once (junk rows on the loser stream).
 *
 * YAOS_CRASH_SAMPLE=n runs every n-th index only (default 1 = every index).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { newDocId } from "../../core/codec/ids";
import { NS_STREAM, docStream, type ClientFrameId, type ContentHash, type DeviceId, type DocId, type NsOp, type StreamName, type VaultId } from "../../core/types";
import { Repo } from "../store/repo";
import { VirtualClock } from "../../sim/clock";
import type { CommitDecision } from "../../sim/storage";
import { SimRelay, type SimCommitInfo } from "../../sim/relay";
import type { LogEngine } from "./engine";
import { converged, drive, sleep, startTestEngine, testStorage, until } from "./testHarness";

const SAMPLE = Math.max(1, Number(process.env.YAOS_CRASH_SAMPLE ?? "1"));
const PAR = 6;
const IDENT = { vaultId: "vault-test" as VaultId, vaultEpoch: "sim-epoch-1", deviceId: "dev-a" as DeviceId, clientVersion: "test" };

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

async function kill(e: LogEngine | null, clock: VirtualClock): Promise<void> {
	if (!e) return;
	e.disconnect();
	await drive(e.stop(), clock, 1_000).catch(() => undefined);
}

function create(a: LogEngine, path: string, contentHash: ContentHash): Extract<NsOp, { t: "create" }> {
	return { t: "create", docId: newDocId(a.c.ports.random), kind: "markdown", path, contentHash, size: 1 };
}

async function write(a: LogEngine, docId: DocId, text: string): Promise<void> {
	const h = (await a.openBody(docId, "markdown"))!;
	h.doc.transact(() => h.doc.getText("text").insert(0, text), h.mergeOrigin);
	await h.commitEdits();
	h.release();
}

async function scenario(k: number | null, decision: CommitDecision): Promise<RunResult> {
	const clock = new VirtualClock();
	const relay = new SimRelay({ clock });
	const commits: SimCommitInfo[] = [];
	relay.onCommit((c) => commits.push(c));
	const run = <T>(p: Promise<T>, what?: string) => drive(p, clock, 60_000, what);
	const { engine: b } = await startTestEngine({ relay, deviceId: "dev-b", clock });
	const storage = testStorage(clock);
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
	const durable = new Map<ClientFrameId, StreamName>();
	const losers = new Set<StreamName>();
	let a: LogEngine | null = null;
	let a2: LogEngine | null = null;
	try {
		await until(() => b.status().phase === "live", 3_000, "b live", clock);
		const w = await run(b.createDoc("same.md", "WINNER;"));
		await until(() => b.isIdle(), 3_000, "b idle", clock);
		const hash = b.nsView().state.entries.get(w)!.createHash;
		const step = async (fn: () => Promise<unknown>) => {
			if (storage.dead) return;
			try {
				await fn();
			} catch (e) {
				if (!storage.dead) throw e; // the crash surfaces as connection-lost somewhere
			}
		};
		await step(async () => {
			a = (await startTestEngine({ relay, deviceId: "dev-a", storage, clock })).engine;
			const repo = a.c.repo;
			const orig = repo.tEdit.bind(repo);
			repo.tEdit = async (...args) => {
				const recs = await orig(...args);
				for (const r of recs) if (r.state !== "adoptable") durable.set(r.clientFrameId, r.stream);
				return recs;
			};
		});
		const A = () => a!;
		const idle = (what: string) => until(() => storage.dead || A().isIdle(), 3_000, what, clock);
		await step(() => idle("a idle"));
		// 1. A live create and two body frames, corked: one commit.
		let one: StreamName | null = null;
		await step(async () => {
			const op = create(A(), "one.md", "0".repeat(64) as ContentHash);
			one = docStream("markdown", op.docId)!;
			const uncork = A().corkNs();
			await run(A().submitNs([op], { liveCreates: true }));
			await run(write(A(), op.docId, "one;"));
			await run(write(A(), op.docId, "two;"));
			uncork();
			await idle("a idle 1");
		});
		// 2. Merged away, its body frame committed with it (junk).
		await step(async () => {
			const op = create(A(), "same.md", hash);
			losers.add(docStream("markdown", op.docId)!);
			await run(A().submitNs([op], { liveCreates: true }));
			await run(write(A(), op.docId, "LOSER2;"));
			await idle("a idle 2");
		});
		// 3. Merged away, the create committed alone, the body frame sent before the receipt and dropped at the merge.
		await step(async () => {
			relay.setLink("dev-a" as DeviceId, { downlinkMs: 300 });
			relay.pauseCommits();
			const op = create(A(), "same.md", hash);
			losers.add(docStream("markdown", op.docId)!);
			const [cf] = await run(A().submitNs([op], { liveCreates: true }));
			await until(() => storage.dead || (A().c.outbox.get(cf!)?.state === "sent" && relay.pendingCount() === 1), 2_000, "create at the relay", clock);
			relay.commitNow();
			await run(write(A(), op.docId, "LOSER3;"));
			const body = A().c.outbox.ofStream(docStream("markdown", op.docId)!)[0];
			await until(() => storage.dead || A().c.outbox.get(body!.clientFrameId)?.state === "sent", 2_000, "body sent before the receipt", clock);
			await until(() => storage.dead || A().c.ns.state.entries.get(op.docId)?.state === "merged", 3_000, "merged", clock);
			relay.resumeCommits();
			relay.setLink("dev-a" as DeviceId, {});
			await until(() => relay.pendingCount() === 0, 3_000, "relay committed the dropped body", clock);
			await idle("a idle 3");
		});
		relay.resumeCommits();
		relay.setLink("dev-a" as DeviceId, {});
		// 4. A live create across a relay restart: buffer lost, STREAM_RESEND, the create resent before its body.
		await step(async () => {
			relay.pauseCommits();
			const op = create(A(), "four.md", "0".repeat(64) as ContentHash);
			await run(A().submitNs([op], { liveCreates: true }));
			await run(write(A(), op.docId, "four;"));
			await until(() => storage.dead || A().c.sender.inflightCount >= 2, 2_000, "inflight", clock);
			relay.restart();
			relay.resumeCommits();
			await idle("a idle 4");
		});
		relay.resumeCommits();
		await step(() => sleep(120, clock));
		await step(() => idle("a idle 5"));
		if (k === null) {
			assert.equal(storage.dead, false);
			await converged([A(), b], 8_000, clock);
			assert.equal(A().c.outbox.size, 0);
			const streams = (c: SimCommitInfo) => c.frames.map((f) => f.stream);
			assert.ok(commits.some((c) => streams(c).join() === [NS_STREAM, one, one].join()), "one.md: the create and both body frames in one commit");
			const [l2, l3] = [...losers];
			assert.ok(commits.some((c) => streams(c).includes(NS_STREAM) && streams(c).includes(l2!)), "same.md #2: body committed with its create (junk)");
			assert.ok(commits.some((c) => streams(c).includes(l3!)), "same.md #3: body sent before the receipt, dropped, still committed (junk)");
			assert.equal(await run(b.docText(w)), "WINNER;");
			return { labels, crashed };
		}
		await kill(a, clock);
		a = null;
		const copy = storage.crash();
		const o = await Repo.open(copy, IDENT, Date.now());
		if (o.repo) {
			for (const r of await o.repo.outboxAll()) if (r.state !== "adoptable") durable.set(r.clientFrameId, r.stream);
			o.repo.close();
		}
		a2 = (await startTestEngine({ relay, deviceId: "dev-a", storage: copy.crash(), clock })).engine;
		await converged([a2, b], 10_000, clock);
		const mine = new Map<string, number>();
		for (const s of relay.streams()) for (const r of relay.rows(s, { includeGc: true })) if (r.deviceId === "dev-a") mine.set(r.clientFrameId, (mine.get(r.clientFrameId) ?? 0) + 1);
		const at = `(crash ${decision} #${k} ${(crashed as RunResult["crashed"])?.label})`;
		for (const [id, stream] of durable) {
			const n = mine.get(id) ?? 0;
			// A merged-away create's body frames: committed with it (junk) or dropped unreceipted at the merge.
			if (losers.has(stream)) assert.ok(n <= 1, `loser frame ${id} committed ${n} times ${at}`);
			else assert.equal(n, 1, `durable frame ${id} committed exactly once ${at}`);
		}
		assert.equal(a2.c.outbox.size, 0, "outbox drained: no orphaned held or gated record");
		assert.equal(await run(b.docText(w)), "WINNER;", "no loser content in the winner");
		assert.equal(a2.c.repo.cursor.vaultSeq, relay.head());
		return { labels, crashed };
	} catch (e) {
		throw new Error(`crash ${decision} #${k} (${(crashed as RunResult["crashed"])?.label ?? "-"}): ${String(e instanceof Error ? e.stack : e)}`);
	} finally {
		await kill(a, clock);
		await kill(a2, clock);
		await run(b.stop());
	}
}

let baseline: string[] = [];

void test("live create crash sweep: baseline converges and runs the live-create transactions", async () => {
	const r = await scenario(null, "commit");
	baseline = r.labels;
	const kinds = new Set(baseline);
	for (const t of ["open", "tEdit", "tLive", "tOutbox"]) assert.ok(kinds.has(t), `scenario runs ${t} (got ${[...kinds].join(",")})`);
});

for (const decision of ["crash-before", "crash-after"] as const) {
	void test(`live create crash sweep: ${decision} at every commit -> no frame lost, no orphaned record, converges`, async () => {
		assert.ok(baseline.length > 0);
		const covered = new Map<string, number>();
		const ks: number[] = [];
		for (let k = 0; k < baseline.length + 4; k += SAMPLE) ks.push(k);
		for (let i = 0; i < ks.length; i += PAR) {
			const rs = await Promise.all(ks.slice(i, i + PAR).map((k) => scenario(k, decision)));
			for (const r of rs) if (r.crashed) covered.set(r.crashed.label, (covered.get(r.crashed.label) ?? 0) + 1);
		}
		if (SAMPLE === 1) for (const t of ["tEdit", "tLive", "tOutbox"]) assert.ok(covered.has(t), `${decision} covered ${t}`);
	});
}
