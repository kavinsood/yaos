/**
 * Retired streams of dead docs (DESIGN §b.5 "retired", §c.9, §d.9; body/retire.ts): the writer (duty device at
 * once, the others after the fallback), the local drop (Repo.tDropStream), a late writer re-retiring, the CAS
 * outcomes, a fresh device reading a retired stream, merged aliases, and the normal checkpoint of a deleted (not
 * pruned) doc's stream. On a virtual clock: a non-duty device learns retirements in one batched read and drops them
 * in one transaction, and a pruning device that lost its duty to a restart retires within the short grace.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckpointEncoding } from "../../core/envelope";
import { encodeCheckpointContent } from "../../core/codec/contents";
import { NS_STREAM, docStream, type DeviceId, type DocId, type NsEntry, type NsFoldEvent, type StreamName } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { RETIRE_GRACE_MS, writeRetired } from "../body/retire";
import { CHECKPOINT_FALLBACK_MS } from "../body/checkpoints";
import { compactFold } from "../body/compaction";
import { VirtualClock } from "../../sim/clock";
import type { ReadRequest, RelaySession } from "../../ports/relay";
import { prunedRestoreDuty, removedDeletes } from "../../core/ns/pruned";
import { ComposedLog } from "../compose/logPort";
import { gate } from "../ingest/gate";
import { sealCheckpoint } from "../ingest/envelope";
import type { LogEngine } from "./engine";
import type { EngineTuning } from "./options";
import { converged, createDoc, deleteDoc, drive, editDoc, maintenanceTicks, startTestEngine, testStorage, until } from "./testHarness";
import { STORE } from "../store/schema";

const NO_CKPT = { rows: 1e9, bytes: 1e12, idleMs: 1e9, hardRows: 1e9, hardBytes: 1e15, settleMs: 1e9, fallbackMs: 300, nsRows: 1e9, nsBytes: 1e12 };
/** Prune when a second tombstone appears, down to one (the oldest goes). */
const TUNING: Partial<EngineTuning> = { compactRows: 1e9, compactBytes: 1e12, checkpoint: NO_CKPT, nsPrune: { tombstoneCap: 1, pruneHysteresis: 0 } };
/** Fallback 3 s (+ jitter): the duty device's put, at once, never races another device's fallback, even under load. */
const DUTY_TUNING: Partial<EngineTuning> = { ...TUNING, checkpoint: { ...NO_CKPT, fallbackMs: 3_000 } };

async function engines(relay: SimRelay, names: readonly string[], tuning: Partial<EngineTuning> = TUNING): Promise<LogEngine[]> {
	const es: LogEngine[] = [];
	for (const d of names) es.push((await startTestEngine({ relay, deviceId: `dev-${d}`, tuning })).engine);
	await until(() => es.every((e) => e.status().phase === "live"), 3_000, "live");
	return es;
}

const md = (id: DocId): StreamName => docStream("markdown", id)!;

/** The relay holds nothing of the stream beyond its checkpoint (H7: gcSeq = lastSeq). */
function retiredOnRelay(relay: SimRelay, stream: StreamName): boolean {
	const all = relay.rows(stream, { includeGc: true });
	const last = all[all.length - 1]?.seq ?? 0;
	return last > 0 && relay.gcSeq(stream) === last && relay.checkpoint(stream)?.coversSeq === last && relay.rows(stream).length === 0;
}

async function holds(e: LogEngine, stream: StreamName): Promise<string[]> {
	const out: string[] = [];
	if (e.c.repo.stream(stream)) out.push("stream");
	if (await e.c.repo.getSnapshot(stream)) out.push("snapshot");
	if ((await e.c.repo.getTail(stream)).length > 0) out.push("tail");
	if ((await e.c.repo.quarantineOf(stream)).length > 0) out.push("quarantine");
	if (e.c.handles.peek(stream)) out.push("replica");
	return out;
}

async function encodingOf(e: LogEngine, relay: SimRelay, stream: StreamName): Promise<number | null> {
	const ck = relay.checkpoint(stream);
	if (!ck) return null;
	const g = await gate(e.c.gateCtx, { t: "checkpoint", stream, coversSeq: ck.coversSeq, payload: ck.bytes });
	return g.ok && g.t === "checkpoint" ? g.checkpoint.encoding : -1;
}

/** Two docs with a few rows each, both deleted on `by`: the older one is pruned (cap 1), the newer stays deleted. */
async function pruneOne(es: LogEngine[], by: LogEngine): Promise<{ pruned: DocId; kept: DocId }> {
	const pruned = await createDoc(by, "p.md", "p;");
	const kept = await createDoc(by, "k.md", "k;");
	await converged(es);
	for (let i = 0; i < 3; i++) await editDoc(by, pruned, (t) => t.insert(t.length, `${i};`));
	await converged(es);
	await deleteDoc(by, pruned);
	await converged(es);
	await deleteDoc(by, kept);
	await until(() => es.every((e) => e.c.ns.entry(pruned) === undefined && e.c.ns.entry(kept)?.state === "deleted"), 5_000, "pruned");
	return { pruned, kept };
}

test("retire: the pruning device retires the dead stream at once; every device drops its records; a deleted doc keeps them", async () => {
	const relay = new SimRelay();
	const es = await engines(relay, ["a", "b"], DUTY_TUNING);
	const [a, b] = es as [LogEngine, LogEngine];
	try {
		const { pruned, kept } = await pruneOne(es, a);
		const stream = md(pruned);
		// The duty device's next tick puts it (ticked here: an idle engine's own tick may be seconds away under load).
		await until(async () => {
			await a.maint.tick();
			return retiredOnRelay(relay, stream);
		}, 5_000, "retired on the relay");
		assert.equal(await encodingOf(a, relay, stream), CheckpointEncoding.retired);
		// The relay holds the put before its response reaches the writer.
		await until(() => a.c.retire.stats.written >= 1, 5_000, "the duty device (its frame pruned the doc) wrote it");
		await until(async () => (await holds(a, stream)).length === 0 && (await holds(b, stream)).length === 0, 15_000, "dropped everywhere");
		assert.equal(b.c.retire.stats.written, 0, "the other device found it retired (fallback refresh), no second put");
		assert.ok(b.c.retire.stats.refreshed >= 1);
		for (const e of es) {
			assert.deepEqual(await holds(e, md(kept)).then((h) => h.includes("stream")), true, "the deleted doc keeps its stream (restore)");
			assert.equal(e.c.retire.pending, 0);
		}
		assert.equal(relay.rows(md(kept)).length > 0, true, "the deleted doc's rows stay");
	} finally {
		for (const e of es) await e.stop();
	}
});

test("retire: a late row on a retired stream (a long-offline edit of a pruned doc) is retired again by its author", async () => {
	const relay = new SimRelay();
	const es = await engines(relay, ["a", "b"], DUTY_TUNING);
	const [a, b] = es as [LogEngine, LogEngine];
	try {
		const pruned = await createDoc(a, "p.md", "p;");
		const kept = await createDoc(a, "k.md", "k;");
		await converged(es);
		b.disconnect();
		await editDoc(b, pruned, (t) => t.insert(0, "offline;"));
		await deleteDoc(a, pruned);
		await deleteDoc(a, kept);
		const stream = md(pruned);
		await until(() => a.c.ns.entry(pruned) === undefined && retiredOnRelay(relay, stream), 5_000, "retired while b is offline");
		const first = relay.checkpoint(stream)!.coversSeq;
		await until(async () => (await holds(a, stream)).length === 0, 15_000, "a dropped it");
		await b.reconnect();
		// b's own frame commits above the retired checkpoint; b folds the prune and, as the row's author, retires again.
		await until(() => relay.rows(stream, { includeGc: true }).some((r) => r.seq > first && r.deviceId === b.c.self), 5_000, "late row");
		await until(async () => {
			await b.maint.tick();
			return retiredOnRelay(relay, stream) && relay.checkpoint(stream)!.coversSeq > first;
		}, 5_000, "retired again");
		assert.ok(b.c.retire.stats.written >= 1, "the late writer re-retired");
		await until(async () => (await holds(a, stream)).length === 0 && (await holds(b, stream)).length === 0, 15_000, "dropped everywhere");
		await converged(es);
	} finally {
		for (const e of es) await e.stop();
	}
});

test("retire: CAS on the known checkpoint seq: a stale expectedPrev conflicts, records the current seq, and the retry lands", async () => {
	const relay = new SimRelay();
	// No duty writes: the fallback is out of reach, so only the explicit calls below put anything.
	const tuning: Partial<EngineTuning> = { ...TUNING, checkpoint: { ...NO_CKPT, fallbackMs: 1e9 } };
	const es = await engines(relay, ["a", "b"], tuning);
	const [a, b] = es as [LogEngine, LogEngine];
	try {
		const id = await createDoc(a, "x.md", "x;");
		await converged(es);
		for (let i = 0; i < 3; i++) await editDoc(a, id, (t) => t.insert(t.length, `${i};`));
		await converged(es);
		const stream = md(id);
		const last = relay.rows(stream).at(-1)!.seq;
		// Someone (a's session, by hand) retired part of the stream: b's record still says no checkpoint.
		const mid = relay.rows(stream)[1]!.seq;
		const content = encodeCheckpointContent({ encoding: CheckpointEncoding.retired, coversSeq: mid, foldRulesVersion: 1, state: new Uint8Array(0) });
		const sealed = await sealCheckpoint(a.c.deps.crypto, a.c.deps.vaultId, stream, mid, content, 0);
		assert.equal((await a.c.session!.putCheckpoint(stream, mid, 0, sealed)).t, "ok");
		assert.equal(b.c.repo.stream(stream)!.remoteCheckpointCoversSeq, 0);
		const o1 = await writeRetired(b.c.deps, b.c.ckpt, b.c.session!, stream);
		assert.deepEqual(o1, { t: "conflict", current: mid, retry: true });
		assert.equal(b.c.repo.stream(stream)!.remoteCheckpointCoversSeq, mid, "conflict records the current seq");
		const o2 = await writeRetired(b.c.deps, b.c.ckpt, b.c.session!, stream);
		assert.deepEqual(o2, { t: "ok", coversSeq: last });
		assert.ok(retiredOnRelay(relay, stream));
		// a's record is stale on the checkpoint: its put conflicts with current = lastSeq, which covers the stream.
		const o3 = await writeRetired(a.c.deps, a.c.ckpt, a.c.session!, stream);
		assert.deepEqual(o3, { t: "conflict", current: last, retry: false });
		// A fallback write re-reads first and finds nothing left to do.
		const o4 = await writeRetired(a.c.deps, a.c.ckpt, a.c.session!, stream, { refreshFirst: true });
		assert.deepEqual(o4, { t: "not-advancing", refreshed: last });
	} finally {
		for (const e of es) await e.stop();
	}
});

test("retire: a device that joins after the retirement reads the retired checkpoint and drops the stream", async () => {
	const relay = new SimRelay();
	const es = await engines(relay, ["a", "b"]);
	try {
		const { pruned } = await pruneOne(es, es[0]!);
		const stream = md(pruned);
		await until(() => retiredOnRelay(relay, stream), 5_000, "retired");
		const diags: string[] = [];
		const c = (await startTestEngine({ relay, deviceId: "dev-c", tuning: TUNING, extra: { onDiag: (ev) => diags.push(ev.code) } })).engine;
		es.push(c);
		await converged(es);
		await until(async () => (await holds(c, stream)).length === 0 && c.c.retire.pending === 0, 5_000, "c dropped it");
		assert.ok(diags.includes("checkpoint-retired"), "the fresh device read the retired checkpoint");
		assert.equal(c.c.retire.stats.written, 0);
	} finally {
		for (const e of es) await e.stop();
	}
});

test("retire: a merged alias's junk rows are retired by their author and dropped", async () => {
	const relay = new SimRelay();
	const es = await engines(relay, ["a", "b"], { ...TUNING, nsPrune: { tombstoneCap: 1_000, pruneHysteresis: 10 } });
	const [a, b] = es as [LogEngine, LogEngine];
	try {
		// Two live creates of the same file in one relay group: both bodies commit, the second create folds merged and
		// its body rows are junk (DESIGN §d.4).
		relay.pauseCommits();
		const winner = await createDoc(a, "same.md", "identical", "markdown", true);
		await until(() => relay.pendingCount() >= 2, 3_000, "a's frames buffered");
		const loser = await createDoc(b, "same.md", "identical", "markdown", true);
		await until(() => relay.pendingCount() >= 4, 3_000, "b's frames buffered");
		relay.resumeCommits();
		await until(() => b.c.ns.entry(loser)?.state === "merged" && a.c.ns.entry(loser)?.state === "merged", 5_000, "merged");
		assert.equal(b.c.ns.entry(loser)!.aliasOf, winner);
		const stream = md(loser);
		await until(() => relay.rows(stream, { includeGc: true }).length > 0, 5_000, "junk rows");
		await until(() => retiredOnRelay(relay, stream), 5_000, "the loser's rows retired");
		// The loser has the duty (author of the rows, its create merged); a's 300 ms fallback may win under load.
		// The relay holds the put before its response reaches the writer: wait for the writer's own count.
		await until(() => b.c.retire.stats.written + a.c.retire.stats.written >= 1, 5_000, "the writer counted its put");
		assert.equal(await encodingOf(b, relay, stream), CheckpointEncoding.retired);
		await until(async () => (await holds(a, stream)).length === 0 && (await holds(b, stream)).length === 0, 5_000, "dropped");
		assert.ok((await holds(a, md(winner))).includes("stream"), "the winner keeps its stream");
		await converged(es);
	} finally {
		for (const e of es) await e.stop();
	}
});

test("pruned docs (§c.9): the delete's base outlives the entry on the stream record; own rows past it are a restore duty", async () => {
	const relay = new SimRelay();
	// Goal 0: every delete is pruned in its own frame, before a restore could commit. No maintenance tick: the
	// records stay (this harness has no synced records to keep them past the retirement).
	const es = await engines(relay, ["a", "b"], { ...TUNING, maintenanceMs: 1e9, nsPrune: { tombstoneCap: 0, pruneHysteresis: 0 } });
	const [a, b] = es as [LogEngine, LogEngine];
	try {
		const uncovered = await createDoc(a, "u.md", "u;");
		const covered = await createDoc(a, "c.md", "c;");
		await converged(es);
		await editDoc(b, uncovered, (t) => t.insert(t.length, "b's edit;"));
		await editDoc(b, covered, (t) => t.insert(t.length, "b's edit;"));
		await converged(es);
		const own = (id: DocId) => b.c.repo.stream(md(id))!.lastOwnSeq;
		assert.ok(own(uncovered) > 0 && own(covered) > 0);
		// a deletes one without having seen b's rows (base below them), the other covering them.
		await a.submitNs([{ t: "delete", docId: uncovered, baseBodySeq: own(uncovered) - 1 }, { t: "delete", docId: covered, baseBodySeq: own(covered) }]);
		await until(() => b.c.repo.stream(md(uncovered))?.prunedDeleteBase !== undefined && b.c.repo.stream(md(covered))?.prunedDeleteBase !== undefined, 5_000, "bases kept");
		assert.equal(b.c.ns.entry(uncovered), undefined);
		assert.equal(b.c.ns.entry(covered), undefined);
		assert.equal(b.c.repo.stream(md(uncovered))!.prunedDeleteBase, own(uncovered) - 1);
		const duty = new ComposedLog(b).view().restoreDuty;
		assert.equal(duty.has(uncovered), true, "b's edit beats the pruned delete");
		assert.equal(duty.has(covered), false, "the delete covered b's rows");
		// a wrote no row past the base, but b's row is there: §c.7's fallback duty (a re-creates the same text, which
		// folds merged into b's re-create, §c.5).
		assert.equal(new ComposedLog(a).view().restoreDuty.has(uncovered), true);
		assert.equal(new ComposedLog(a).view().restoreDuty.has(covered), false);
	} finally {
		for (const e of es) await e.stop();
	}
});

test("pruned docs (§c.9): a reader that adopts an ns checkpoint past a delete and its prune still knows the delete's base", async () => {
	// The reader b had the doc live, saw e's row, and was away while a (which had not seen e's row) deleted the doc and
	// the delete was pruned at once. b catches up from an ns checkpoint past both: no prune event, no deleted entry
	// before. e's row beats the delete (§c.7 fallback duty) and e may never come back (gone, or an earlier store of
	// b's own install): b must still tell that the row is past the base.
	const relay = new SimRelay();
	const ckpt = { ...NO_CKPT, nsRows: 1, nsBytes: 1, settleMs: 0, idleMs: 0, fallbackMs: 0 };
	const tuning: Partial<EngineTuning> = { ...TUNING, maintenanceMs: 25, checkpoint: ckpt, nsCandidateModulus: 1, nsPrune: { tombstoneCap: 0, pruneHysteresis: 0 } };
	const es = await engines(relay, ["a", "b", "e"], tuning);
	const [a, b, e] = es as [LogEngine, LogEngine, LogEngine];
	try {
		const id = await createDoc(a, "u.md", "u;");
		await converged(es);
		await editDoc(e, id, (t) => t.insert(t.length, "e's edit;"));
		await converged(es);
		const row = e.c.repo.stream(md(id))!.lastOwnSeq;
		assert.ok(row > 0 && b.c.repo.stream(md(id))!.remoteHeadSeq >= row);
		b.disconnect();
		await e.stop();
		await a.submitNs([{ t: "delete", docId: id, baseBodySeq: row - 1 }]);
		const later = await createDoc(a, "later.md", "l;");
		await until(() => a.c.ns.entry(id) === undefined && a.c.ns.entry(later) !== undefined, 5_000, "a folded the delete, its prune and a later create");
		const deleted = a.c.ns.state.coversSeq;
		await until(() => (relay.checkpoint(NS_STREAM)?.coversSeq ?? 0) >= deleted && relay.gcSeq(NS_STREAM) >= deleted, 10_000, "ns checkpoint past the prune, rows gone");
		await b.reconnect();
		await until(() => b.c.ns.state.coversSeq >= deleted, 10_000, "b caught up");
		assert.equal(b.c.ns.entry(id), undefined);
		assert.equal(b.c.ns.removedDeletes.has(id), false, "no prune event and no deleted entry before: the reload saw the doc live");
		assert.equal(new ComposedLog(b).view().restoreDuty.has(id), true, "e's row past the base beats the pruned delete");
	} finally {
		for (const x of [a, b]) await x.stop();
	}
});

test("pruned docs (§c.9, core/ns/pruned): removedDeletes takes prune events and, on a reload, deleted entries the adopted state lacks", () => {
	const entry = (id: string, state: NsEntry["state"], base = 0): NsEntry => ({
		docId: id as DocId, kind: "markdown", state, path: `${id}.md`, pathKey: `${id}.md` as NsEntry["pathKey"], createdSeq: 1,
		createdBy: "dev-x" as DeviceId, lastTouchSeq: 2, deletedSeq: state === "deleted" ? 2 : 0, deleteBaseBodySeq: base, createHash: "h" as NsEntry["createHash"],
		createSize: 1, blob: null, aliasOf: state === "merged" ? ("w" as DocId) : null,
	});
	const ev = (entries: NsEntry[]): NsFoldEvent => ({ seq: 9, index: -1, deviceId: "dev-x" as DeviceId, clientFrameId: "f" as NsFoldEvent["clientFrameId"], docId: null, outcome: { kind: "pruned", docIds: entries.map((e) => e.docId), entries } });
	// Events: deleted entries only (a merged alias has no delete base).
	assert.deepEqual(removedDeletes([ev([entry("m", "merged"), entry("d", "deleted", 5)])], null, new Map()).map((e) => [e.docId, e.deleteBaseBodySeq]), [["d", 5]]);
	// Reload: deleted before and absent after; a live one gone (deleted and pruned inside the checkpoint) has no base.
	const before = new Map([entry("gone", "deleted", 3), entry("stays", "deleted", 4), entry("live", "live")].map((e) => [e.docId, e]));
	const after = new Map([[("stays" as DocId), entry("stays", "deleted", 4)]]);
	assert.deepEqual(removedDeletes([], before, after).map((e) => e.docId), ["gone"]);
	// The duty: rows past the base (own, or anyone's: §c.7's fallback); a committed entry the optimistic view pruned
	// decides itself; then the kept base; then the committed state's stub; nothing known: any row (re-create).
	const rec = (lastOwnSeq: number, remoteHeadSeq: number) => ({ lastOwnSeq, remoteHeadSeq });
	const stub = (base: number) => ({ deleteBaseBodySeq: base, prunedSeq: 9 });
	assert.equal(prunedRestoreDuty(rec(5, 5), 5, undefined, undefined), false);
	assert.equal(prunedRestoreDuty(rec(6, 6), 5, undefined, undefined), true);
	assert.equal(prunedRestoreDuty(rec(0, 6), 5, undefined, undefined), true, "another device's (or an earlier store's) row past the base");
	assert.equal(prunedRestoreDuty(rec(6, 6), undefined, entry("d", "deleted", 6), undefined), false);
	assert.equal(prunedRestoreDuty(rec(0, 7), undefined, entry("d", "deleted", 6), undefined), true);
	assert.equal(prunedRestoreDuty(rec(7, 7), 3, entry("l", "live"), undefined), false);
	assert.equal(prunedRestoreDuty(rec(7, 7), 3, entry("m", "merged"), undefined), true);
	assert.equal(prunedRestoreDuty(rec(0, 7), 3, entry("m", "merged"), undefined), false);
	// a reader that adopted a checkpoint past the delete and its prune: the stub's base
	assert.equal(prunedRestoreDuty(rec(0, 7), undefined, undefined, stub(6)), true, "a row past the stub's base");
	assert.equal(prunedRestoreDuty(rec(0, 6), undefined, undefined, stub(6)), false, "the delete covered every row");
	// the stub aged out, or a merged alias was pruned: nothing known, any row re-creates (never a loss)
	assert.equal(prunedRestoreDuty(rec(0, 9), undefined, undefined, undefined), true);
	assert.equal(prunedRestoreDuty(rec(0, 0), undefined, undefined, undefined), false);
});

test("checkpoint duty runs for a deleted (not pruned) doc's stream: the settle rule checkpoints it like a live one", async () => {
	const relay = new SimRelay();
	const settle = { ...NO_CKPT, idleMs: 50, settleMs: 100, fallbackMs: 200 };
	const es = await engines(relay, ["a", "b"], { compactRows: 1e9, compactBytes: 1e12, checkpoint: settle });
	const [a] = es as [LogEngine, LogEngine];
	try {
		const id = await createDoc(a, "d.md", "d;");
		await converged(es);
		for (let i = 0; i < 3; i++) await editDoc(es[i % 2]!, id, (t) => t.insert(t.length, `${i};`));
		await deleteDoc(a, id);
		await converged(es);
		assert.equal(a.c.ns.entry(id)?.state, "deleted");
		const stream = md(id);
		await until(() => retiredOnRelay(relay, stream), 5_000, "checkpointed at lastSeq");
		assert.equal(await encodingOf(a, relay, stream), CheckpointEncoding.yjsStateV1, "a normal checkpoint: the body stays for a restore");
		for (const e of es) assert.ok((await holds(e, stream)).includes("stream"), "deleted docs keep their records");
	} finally {
		for (const e of es) await e.stop();
	}
});

test("a merged create's held frames stay in the outbox until its stream is dropped (I1), then go with it", async () => {
	// Sim suite-1 seed 1: an edit typed into the loser after its create is held with the create's frames, and they can
	// be its only copy (the editor's save lost with the app). Deleted at the merge fold, the edit was gone before the
	// disk side could write it to the file; kept, Repo.tDropStream deletes them once nothing tracks the doc.
	const relay = new SimRelay();
	const es = await engines(relay, ["a", "b"], { ...TUNING, checkpoint: { ...NO_CKPT, fallbackMs: 1e9 } });
	const [a, b] = es as [LogEngine, LogEngine];
	try {
		a.disconnect();
		const loser = await createDoc(a, "same.md", "same;");
		await editDoc(a, loser, (t) => t.insert(0, "typed;"));
		const stream = md(loser);
		const held = a.c.outbox.ofStream(stream);
		assert.ok(held.length >= 2 && held.every((r) => r.state === "held"), "the create's frames and the edit are held");
		await createDoc(b, "same.md", "same;", "markdown", true);
		await converged([b]);
		const rec0 = a.c.repo.stream(stream) ?? { remoteHeadSeq: 0, remoteCheckpointCoversSeq: 0 };
		assert.equal(await a.c.repo.tDropStream(stream, rec0), false, "held frames not named: refused");
		// The disk side still tracks the loser (its synced record: the planner writes its text to the file first).
		const tracked = { docId: loser, path: "same.md", pathKey: "same.md", kind: "markdown", contentHash: "0".repeat(64), fingerprint: "0".repeat(64), size: 5, mtimeMs: 0, bodyVersion: null, blobRev: 0, nsTouchSeq: 0, hasBase: false };
		await a.c.repo.db.tx([STORE.synced], "readwrite", async (tx) => { tx.put(STORE.synced, tracked as never); });
		await a.reconnect();
		await until(() => a.c.ns.entry(loser)?.state === "merged", 5_000, "merged");
		await maintenanceTicks(a, 3); // the retire finds the dead stream and may not drop it
		assert.deepEqual(a.c.outbox.ofStream(stream).map((r) => r.clientFrameId), held.map((r) => r.clientFrameId), "kept at the merge");
		await a.c.repo.db.tx([STORE.synced], "readwrite", async (tx) => { tx.delete(STORE.synced, loser); });
		await until(() => a.c.outbox.size === 0, 10_000, "dropped");
		assert.equal(a.c.outbox.size, 0, "dropped with the loser's stream once nothing tracks it");
		assert.equal((await a.c.repo.outboxAll()).length, 0);
		assert.deepEqual(await holds(a, stream), []);
		assert.deepEqual(relay.rows(stream, { includeGc: true }), [], "held frames are never sent");
	} finally {
		for (const e of es) await e.stop();
	}
});

test("Repo.tDropStream: one transaction drops the records; refused while an own frame is in the outbox or the record moved", async () => {
	const relay = new SimRelay();
	const es = await engines(relay, ["a"], { ...TUNING, checkpoint: { ...NO_CKPT, fallbackMs: 1e9 } });
	const [a] = es as [LogEngine];
	try {
		const id = await createDoc(a, "x.md", "x;");
		await converged(es);
		const stream = md(id);
		a.disconnect();
		await editDoc(a, id, (t) => t.insert(0, "pending;"));
		const rec = a.c.repo.stream(stream)!;
		assert.equal(await a.c.repo.tDropStream(stream, rec), false, "an own frame of the stream is in the outbox");
		await a.reconnect();
		await converged(es);
		const now = a.c.repo.stream(stream)!;
		assert.equal(await a.c.repo.tDropStream(stream, { ...now, remoteHeadSeq: now.remoteHeadSeq - 1 }), false, "the record moved since");
		assert.equal(await a.c.repo.tDropStream(stream, now), true);
		assert.equal(a.c.repo.stream(stream), undefined);
		assert.equal(await a.c.repo.getSnapshot(stream), undefined);
		assert.deepEqual(await a.c.repo.getTail(stream), []);
		assert.equal(a.c.repo.cursor.vaultSeq, relay.head(), "the vault cursor is untouched");
	} finally {
		for (const e of es) await e.stop();
	}
});

// ---- virtual clock: batched refresh, bounded drops, duty lost to a restart --------------------------------------

/** Every delete pruned in its own frame (goal 0); the shipped 10 min checkpoint fallback, so the retire grace is 60 s. */
const PROD_GRACE: Partial<EngineTuning> = { ...TUNING, checkpoint: { ...NO_CKPT, fallbackMs: CHECKPOINT_FALLBACK_MS }, nsPrune: { tombstoneCap: 0, pruneHysteresis: 0 } };

/** Counts a session's reads that name one of `streams`: readBatch requests and single reads. */
function countReads(session: RelaySession, streams: ReadonlySet<StreamName>): { batches: number; entries: number; singles: number } {
	const n = { batches: 0, entries: 0, singles: 0 };
	const readBatch = session.readBatch.bind(session);
	const read = session.read.bind(session);
	session.readBatch = (reqs: readonly ReadRequest[]) => {
		const hit = reqs.filter((r) => streams.has(r.stream)).length;
		if (hit > 0) {
			n.batches++;
			n.entries += hit;
		}
		return readBatch(reqs);
	};
	session.read = (stream, afterSeq, prefer) => {
		if (streams.has(stream)) n.singles++;
		return read(stream, afterSeq, prefer);
	};
	return n;
}

test("retire: a non-duty device learns 20 retirements in one batched read and drops them in one tick, long before its grace", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const relay = new SimRelay({ clock });
	const dropTicks: number[] = [];
	const a = (await startTestEngine({ relay, deviceId: "dev-a", clock, tuning: PROD_GRACE })).engine;
	let b: LogEngine | null = null;
	b = (await startTestEngine({ relay, deviceId: "dev-b", clock, tuning: PROD_GRACE, extra: { onDiag: (ev) => {
		if (ev.code === "retire-dropped") dropTicks.push(b!.maint.stats.ticks);
	} } })).engine;
	const es = [a, b];
	try {
		await until(() => es.every((e) => e.status().phase === "live"), 10_000, "live", clock);
		// More than the old 16 drops per tick.
		const ids: DocId[] = [];
		for (let i = 0; i < 20; i++) {
			ids.push(await drive(createDoc(a, `d${i}.md`, `d${i};`), clock));
			await drive(editDoc(a, ids[i]!, (t) => t.insert(t.length, "e;")), clock);
		}
		await converged(es, 30_000, clock);
		const dead = new Set(ids.map(md));
		const reads = countReads(b.c.session!, dead);
		// One frame deletes them all; goal 0 prunes them in it: a's fold pruned them, a has the duty, b has none.
		await drive(a.submitNs(ids.map((id) => ({ t: "delete" as const, docId: id, baseBodySeq: a.c.repo.stream(md(id))!.remoteHeadSeq }))), clock);
		await until(() => ids.every((id) => b.c.ns.entry(id) === undefined), 10_000, "b folded the prune", clock);
		const t0 = clock.monotonic();
		await until(() => ids.every((id) => retiredOnRelay(relay, md(id))), 10_000, "the duty device retired them", clock);
		assert.equal(b.c.retire.pending, 20, "b still holds them: relay checkpoints are not broadcast");
		await until(() => ids.every((id) => b.c.repo.stream(md(id)) === undefined), RETIRE_GRACE_MS, "b dropped them", clock);
		assert.ok(clock.monotonic() - t0 <= RETIRE_GRACE_MS / 4 + 1_000, `learnt at the first refresh (grace / 4), not after the grace: ${clock.monotonic() - t0} ms`);
		assert.deepEqual(reads, { batches: 1, entries: 20, singles: 0 }, "one readBatch for the 20 streams, no read each");
		assert.equal(b.c.retire.stats.written, 0, "no second put");
		assert.equal(b.c.retire.stats.refreshed, 20);
		assert.equal(new Set(dropTicks).size, 1, "the 20 drops went in one tick (one transaction)");
		assert.equal(b.c.retire.pending, 0);
		for (const id of ids) assert.deepEqual(await holds(b, md(id)), []);
	} finally {
		for (const e of es) await drive(e.stop(), clock);
	}
});

test("retire: a pruning device whose duty a restart lost retires within the short grace, not the 10 min checkpoint fallback", async () => {
	const clock = new VirtualClock(Date.UTC(2026, 0, 1, 12, 0));
	const relay = new SimRelay({ clock });
	const storage = testStorage(clock);
	// a runs no maintenance before the restart: its duty (in memory) is never acted on.
	let a = (await startTestEngine({ relay, deviceId: "dev-a", clock, storage, tuning: { ...PROD_GRACE, maintenanceMs: 1e9 } })).engine;
	const b = (await startTestEngine({ relay, deviceId: "dev-b", clock, tuning: PROD_GRACE })).engine;
	try {
		await until(() => a.status().phase === "live" && b.status().phase === "live", 10_000, "live", clock);
		const ids: DocId[] = [];
		for (let i = 0; i < 3; i++) ids.push(await drive(createDoc(a, `r${i}.md`, `r${i};`), clock));
		await converged([a, b], 30_000, clock);
		// b writes the newest rows: a is not the author duty either.
		for (const id of ids) await drive(editDoc(b, id, (t) => t.insert(t.length, "b;")), clock);
		await converged([a, b], 30_000, clock);
		await drive(b.stop(), clock);
		await drive(a.submitNs(ids.map((id) => ({ t: "delete" as const, docId: id, baseBodySeq: a.c.repo.stream(md(id))!.remoteHeadSeq }))), clock);
		await until(() => ids.every((id) => a.c.ns.entry(id) === undefined), 10_000, "a pruned them", clock);
		assert.equal(ids.filter((id) => a.c.retire.duty.has(id)).length, 3, "a's frame pruned them: a has the duty");
		// A reload refolds the ns tail (and so finds the duty again) until it is compacted past the pruning frame.
		assert.equal((await drive(compactFold(a.c.deps, a.c.ns), clock)).t, "ok");
		await drive(a.stop(), clock);
		assert.ok(ids.every((id) => !retiredOnRelay(relay, md(id))));
		a = (await startTestEngine({ relay, deviceId: "dev-a", clock, storage, tuning: PROD_GRACE })).engine;
		await until(() => a.status().phase === "live", 10_000, "a live again", clock);
		assert.equal(a.c.retire.duty.size, 0, "the duty did not survive the restart");
		for (const id of ids) assert.ok(a.c.repo.stream(md(id))!.lastOwnSeq < a.c.repo.stream(md(id))!.remoteHeadSeq, "not the author of the newest row");
		const t0 = clock.monotonic();
		await until(() => ids.every((id) => retiredOnRelay(relay, md(id))), 2 * RETIRE_GRACE_MS + 5_000, "retired after the grace", clock);
		const took = clock.monotonic() - t0;
		assert.ok(took >= RETIRE_GRACE_MS && took < CHECKPOINT_FALLBACK_MS, `grace + jitter: ${took} ms`);
		// The relay holds a put before its response reaches the writer.
		await until(() => a.c.retire.stats.written === 3, 5_000, "a counted its 3 puts", clock);
		await until(async () => (await Promise.all(ids.map((id) => holds(a, md(id))))).every((h) => h.length === 0), 10_000, "dropped", clock);
	} finally {
		await drive(a.stop(), clock);
	}
});
