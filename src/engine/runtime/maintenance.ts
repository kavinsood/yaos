/**
 * Periodic engine work (one tick every maintenanceMs, never overlapping):
 * gap feed (DESIGN §d.7), local compaction (§d.8), remote
 * checkpoint duty (§d.9), retired streams of dead docs (§b.5, body/retire.ts), daily-limit release, residency budget, expiry of
 * recently unbound subscriptions, catch-up scheduling (which also starts the
 * reads whose skip deferral ran out, §d.7).
 *
 * Idle backoff: while nothing is pending (busy() false) and a tick did no work,
 * the interval doubles up to maintenanceIdleMaxMs; activity (ctx.onActivity:
 * every scheduleStatus outside the tick, i.e. phase, notice, outbox, ingest
 * and keyring changes) or a busy state snaps it back to maintenanceMs. An idle
 * engine then wakes about twice a minute instead of every second.
 */

import { TAIL_HARD_ROWS } from "../../core/limits";
import { NS_STREAM, SNAP_STREAM, type ClientFrameId, type DocId, type StreamName } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { RelaySession } from "../../ports/relay";
import { bodyCheckpointDue, foldCheckpointDue, refreshRemoteBatch, writeBodyCheckpoint, writeFoldCheckpoint } from "../body/checkpoints";
import { compactBody, compactFold, needsCompaction } from "../body/compaction";
import { deadReason, refreshRetiredBatch, retireGrace, retireRefreshEvery, writeRetired, DROP_TAIL_ROWS_PER_TICK, DROPS_PER_TICK, RETIRES_PER_TICK, type DeadReason, type FoldCompleteness, type PruneEvidence } from "../body/retire";
import type { StreamRecord } from "../store/schema";
import type { EngineCtx } from "./context";

const COMPACTIONS_PER_TICK = 4;
const CHECKPOINTS_PER_TICK = 2;
const COMPACT_SKIP_BACKOFF_MS = 30_000;
const CHECKPOINT_ERROR_BACKOFF_MS = 60_000;
/** A batched refresh stands in for a write's own refreshFirst read this long (the put is a CAS on it anyway). */
const REFRESH_FRESH_MS = 60_000;

export class Maintenance {
	private timer: TimerHandle | null = null;
	private running: Promise<void> | null = null;
	private readonly compactSkip = new Map<StreamName, number>();
	/** Fallback streams a batched refresh served, at (mono): not re-read for REFRESH_FRESH_MS. */
	private readonly refreshedAt = new Map<StreamName, number>();
	/** Idle ticks in a row (no pending work, no work done): the next interval is maintenanceMs * 2^idle, capped. */
	private idle = 0;
	stats = { ticks: 0, gapFeeds: 0, compactions: 0, checkpoints: 0, retires: 0, drops: 0, refreshBatches: 0, checkpointOutcomes: {} as Record<string, number> };

	constructor(private readonly c: EngineCtx) {
		c.onActivity = () => this.kick();
	}

	start(): void {
		this.arm();
	}
	stop(): void {
		if (this.timer !== null) this.c.ports.clock.clearTimer(this.timer);
		this.timer = null;
	}

	private arm(): void {
		if (this.c.stopped || this.timer !== null) return;
		const t = this.c.tuning;
		const delay = Math.min(t.maintenanceMs * 2 ** Math.min(this.idle, 20), Math.max(t.maintenanceMs, t.maintenanceIdleMaxMs));
		this.timer = this.c.ports.clock.setTimer(delay, () => {
			this.timer = null;
			void this.tick().finally(() => this.arm());
		});
	}

	/** Activity: back to maintenanceMs (re-armed at once when a longer idle wait is pending). */
	kick(): void {
		if (this.idle === 0) return;
		this.idle = 0;
		if (this.timer === null) return; // a tick is running: it re-arms with the base interval
		this.c.ports.clock.clearTimer(this.timer);
		this.timer = null;
		this.arm();
	}

	/** Work a 1 s tick exists for is pending: a frame open, an edit or read or feed in flight, rows to catch up. */
	private busy(): boolean {
		const c = this.c;
		if (!c.docs.editIdle || c.sess.readsInFlight > 0 || c.sess.isFeeding) return true;
		for (const h of c.handles.all()) if (!h.builder.empty) return true;
		if (!c.session) return false;
		const cur = c.repo.cursor;
		if (cur.headSeqSeen > cur.vaultSeq || cur.pendingAbove() > 0) return true;
		const onlyK = c.keyring.readsOnlyK();
		for (const r of c.repo.streams()) if (r.stale && !r.frozen && r.cls !== "other" && (!onlyK || r.cls === "keyring") && !c.sess.isHeld(r.stream)) return true;
		return false;
	}

	/** One pass (tests call it directly). */
	tick(): Promise<void> {
		if (this.running) return this.running;
		const p = this.run().finally(() => {
			this.running = null;
		});
		this.running = p;
		return p;
	}

	private async run(): Promise<void> {
		const c = this.c;
		if (c.stopped) return;
		this.stats.ticks++;
		const work = () => this.stats.gapFeeds + this.stats.compactions + this.stats.checkpoints + this.stats.retires + this.stats.drops + this.stats.refreshBatches;
		const work0 = work();
		const steps: [string, () => Promise<void> | void][] = [
			["gap", () => this.gap()],
			["compact", () => this.compact()],
			["checkpoint", () => this.checkpoints()],
			["retire", () => this.retire()],
			["daily", () => this.daily()],
			["keyring", () => c.keyring.tick()],
		];
		for (const [name, fn] of steps) {
			if (c.stopped) return;
			try {
				await fn();
			} catch (e) {
				c.diag("maintenance-failed", { step: name, error: String(e) });
			}
		}
		c.handles.enforceBudget();
		c.subs.tick();
		c.sess.scheduleCatchUp();
		c.scheduleStatus(false);
		const worked = work() !== work0;
		this.idle = worked || this.busy() ? 0 : this.idle + 1;
	}

	/** Missing V+1 for gapMs, or a head hint above V with nothing queued for gapMs: feed (DESIGN §d.7). */
	private async gap(): Promise<void> {
		const c = this.c;
		if (!c.session || !c.live.enabled || c.sess.isFeeding) return;
		const cur = c.repo.cursor;
		const now = c.mono();
		let due = cur.gapDue(now, c.tuning.gapMs);
		if (cur.headSeqSeen > cur.vaultSeq && c.live.idle) {
			if (c.headAheadSince === null) c.headAheadSince = now;
			else if (now - c.headAheadSince >= c.tuning.gapMs) due = true;
		} else c.headAheadSince = null;
		if (!due) return;
		cur.gapHandled(now);
		c.headAheadSince = null;
		this.stats.gapFeeds++;
		c.diag("gap-feed", { v: cur.vaultSeq, head: cur.headSeqSeen, above: cur.pendingAbove() });
		await c.sess.feedTo(c.gen, cur.headSeqSeen);
		c.sess.scheduleCatchUp();
	}

	private async compact(): Promise<void> {
		const c = this.c;
		const now = c.mono();
		let budget = COMPACTIONS_PER_TICK;
		for (const r of [...c.repo.streams()]) {
			if (budget <= 0 || c.stopped) return;
			if (r.cls !== "body" && r.cls !== "canvas" && r.cls !== "ns" && r.cls !== "cfg" && r.cls !== "snap") continue;
			if (r.stale || r.frozen || c.sess.isReading(r.stream)) continue;
			if ((this.compactSkip.get(r.stream) ?? 0) > now) continue;
			if (!needsCompaction(r, c.tuning.compactRows, c.tuning.compactBytes)) continue;
			if (c.background && r.tailRows <= TAIL_HARD_ROWS) continue; // waits while backgrounded; the hard cap does not
			budget--;
			const res = r.cls === "ns" ? await compactFold(c.deps, c.ns) : r.cls === "cfg" ? await compactFold(c.deps, c.cfg)
				: r.cls === "snap" ? await compactFold(c.deps, c.snap) : await compactBody(c.deps, r.stream);
			if (res.t === "ok") {
				this.stats.compactions++;
				this.compactSkip.delete(r.stream);
			} else this.compactSkip.set(r.stream, now + COMPACT_SKIP_BACKOFF_MS);
		}
	}

	private jitter(stream: StreamName): number {
		const st = this.c.ckpt;
		let j = st.jitter.get(stream);
		if (j === undefined) {
			j = Math.floor(this.c.ports.random.float() * this.c.tuning.checkpoint.fallbackMs);
			st.jitter.set(stream, j);
		}
		return j;
	}

	private count(t: string): void {
		this.stats.checkpointOutcomes[t] = (this.stats.checkpointOutcomes[t] ?? 0) + 1;
	}

	private async checkpoints(): Promise<void> {
		const c = this.c;
		const s = c.session;
		if (!s || !s.canWrite || c.readOnly || c.phase !== "live" || c.background || c.gate() !== null) return;
		const now = c.mono();
		c.ckpt.markLive(now);
		await this.refreshFallbacks(s, now);
		const fresh = (stream: StreamName) => now - (this.refreshedAt.get(stream) ?? -Infinity) < REFRESH_FRESH_MS;
		// Due streams in order of due time (the duty device's at once, a fallback's at condSince + fallbackMs + its
		// jitter): fallback devices sweep a backlog in their own jittered orders, not all in store order, where each
		// stream was put by every device, one ok and the others CAS conflicts (sim SOAK-FLOOD-RETIRE-BACKLOG: a 31 ms
		// fallback after a flood, thousands of settle puts at 2 per tick).
		const due: { r: StreamRecord; duty: boolean; at: number }[] = [];
		for (const r of c.repo.streams()) {
			if (r.cls !== "body" && r.cls !== "canvas") continue;
			if (c.sess.isReading(r.stream)) continue;
			const duty = c.repo.hasCkptDuty(r.stream);
			const j = this.jitter(r.stream);
			if (!bodyCheckpointDue(r, duty, c.ckpt, c.tuning.checkpoint, now, j)) continue;
			due.push({ r, duty, at: duty ? -Infinity : (c.ckpt.condSince.get(r.stream) ?? now) + j });
		}
		due.sort((x, y) => x.at - y.at);
		let budget = CHECKPOINTS_PER_TICK;
		for (const { r, duty } of due) {
			if (budget <= 0 || c.session !== s) break;
			budget--;
			try {
				const o = await writeBodyCheckpoint(c.deps, c.ckpt, s, r.stream, { refreshFirst: !duty && !fresh(r.stream) });
				this.count(o.t);
				if (o.t === "ok") this.stats.checkpoints++;
				else if (o.t === "skipped") c.ckpt.backoffUntil.set(r.stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
			} catch (e) {
				this.count("error");
				c.ckpt.backoffUntil.set(r.stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
				c.diag("checkpoint-failed", { cls: r.cls, error: String(e) });
			}
		}
		for (const fold of [c.ns, c.cfg, c.snap]) {
			const stream = fold.stream;
			const cls = stream === NS_STREAM ? "ns" : stream === SNAP_STREAM ? "snap" : "cfg";
			if (c.session !== s) return;
			if (c.sess.isReading(stream)) continue;
			if (!foldCheckpointDue(c.repo.stream(stream), fold, c.ckpt, c.tuning.checkpoint, now, this.jitter(stream))) continue;
			try {
				const o = await writeFoldCheckpoint(c.deps, c.ckpt, s, fold, { refreshFirst: !fold.candidate?.authoredBySelf });
				this.count(`${cls}-${o.t}`);
				if (o.t === "ok") {
					this.stats.checkpoints++;
					let pending = 0;
					for (const r of c.outbox.values()) if (r.stream === stream) pending++;
					c.diag("checkpoint-written", { cls, coversSeq: o.coversSeq, pendingOwn: pending });
				}
				else if (o.t === "skipped") c.ckpt.backoffUntil.set(stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
			} catch (e) {
				this.count(`${cls}-error`);
				c.ckpt.backoffUntil.set(stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
				c.diag("checkpoint-failed", { cls, error: String(e) });
			}
		}
	}

	/** What this device knows of the prune of the stream's doc (body/retire.ts PruneEvidence). */
	private pruneEvidence(rec: StreamRecord): PruneEvidence {
		const docId = rec.docId!;
		return { stub: this.c.ns.state.pruned.get(docId), keptBase: this.c.ns.removedDeletes.get(docId)?.deleteBaseBodySeq ?? rec.prunedDeleteBase };
	}

	/**
	 * The b: / c: streams whose doc is dead (body/retire.ts deadReason), with why. The ns fold's completeness is
	 * checked (FoldRuntime.gap reads the ns tail) only when some stream's doc has a record of a prune and no committed entry.
	 */
	async deadStreams(): Promise<{ readonly rec: StreamRecord; readonly why: DeadReason }[]> {
		const c = this.c;
		const cands: StreamRecord[] = [];
		let absent = false;
		for (const r of c.repo.streams()) {
			if ((r.cls !== "body" && r.cls !== "canvas") || !r.docId) continue;
			const e = c.ns.entry(r.docId);
			if (e && e.state !== "merged") continue;
			// No entry and no record of a prune: not provably dead (deadReason), kept.
			if (!e) {
				const ev = this.pruneEvidence(r);
				if (ev.stub === undefined && ev.keptBase === undefined) continue;
			}
			if (!e) absent = true;
			cands.push(r);
		}
		if (cands.length === 0) return [];
		let fold: FoldCompleteness = { complete: false, vaultSeq: c.repo.cursor.vaultSeq };
		if (absent) {
			const nsRec = c.repo.stream(NS_STREAM);
			// A row every reader's gate refused (a hostile or buggy member's) hides no create: not a gap here.
			const ok = nsRec !== undefined && !nsRec.stale && !nsRec.frozen && (await c.ns.gap({ rejectedComplete: true })) === null;
			fold = { complete: ok, vaultSeq: c.repo.cursor.vaultSeq };
		}
		const pending = (d: DocId) => c.createDependency(d) !== null;
		const out: { rec: StreamRecord; why: DeadReason }[] = [];
		for (const r of cands) {
			const rec = c.repo.stream(r.stream);
			if (!rec) continue;
			const why = deadReason(rec, c.ns.entry(r.docId!), this.pruneEvidence(rec), fold, pending);
			if (why) out.push({ rec, why });
		}
		return out;
	}

	/**
	 * Dead streams (DESIGN §b.5 "retired", §d.9): batched refreshes of the relay checkpoints of the ones to retire,
	 * then the local records of every one nothing lies beyond any more (one transaction), then a retired
	 * checkpoint where the relay still holds rows beyond its checkpoint (duty now, others after the grace).
	 */
	private async retire(): Promise<void> {
		const c = this.c;
		const dead = await this.deadStreams();
		const st = c.retire;
		// Not pending: a stream frozen on a disputed checkpoint (never read again, nothing here can finish it), and one
		// with nothing left to retire whose replica the host holds (a view still bound to it: dropped once released).
		st.pending = dead.filter(({ rec }) => {
			if (rec.frozen && rec.frozenReason === "checkpoint-disputed") return false;
			const h = c.handles.peek(rec.stream);
			return !(rec.remoteCheckpointCoversSeq >= rec.remoteHeadSeq && h && !c.handles.isClean(h));
		}).length;
		if (dead.length === 0) return;
		const s = c.session;
		const now = c.mono();
		const grace = retireGrace(c.tuning.checkpoint.fallbackMs);
		const every = retireRefreshEvery(grace);
		const duty = (rec: StreamRecord) => (rec.docId !== null && st.duty.has(rec.docId)) || rec.lastOwnSeq >= rec.remoteHeadSeq;
		for (const { rec } of dead) if (!rec.stale && rec.remoteCheckpointCoversSeq < rec.remoteHeadSeq && !st.since.has(rec.stream)) st.since.set(rec.stream, now);
		if (s && c.phase === "live" && !c.background) await this.refreshDead(s, dead.map((d) => d.rec), now, every);
		const cur: { rec: StreamRecord; why: DeadReason }[] = [];
		for (const { rec, why } of dead) {
			const r = c.repo.stream(rec.stream);
			if (r) cur.push({ rec: r, why });
		}
		const held = (rec: StreamRecord, why: DeadReason): ClientFrameId[] | null | undefined => {
			// Own frames on their way (a late edit of a pruned doc): their rows come first, then the stream is retired
			// (undefined: not now). A merged alias's held frames are never sent: they go with the drop (Repo.tDropStream).
			const own = c.outbox.ofStream(rec.stream);
			const h = why === "merged" && own.every((r) => r.state === "held") ? own.map((r) => r.clientFrameId) : null;
			if (c.sess.isReading(rec.stream) || rec.stale || (own.length > 0 && h === null)) return undefined;
			return h;
		};
		await this.dropDead(cur, held);
		if (c.stopped) return;
		const canWrite = s !== null && s.canWrite && !c.readOnly && c.phase === "live" && !c.background && c.gate() === null && now >= c.ckpt.holdUntilMono;
		if (!canWrite || !s) return;
		const fallbackMs = c.tuning.checkpoint.fallbackMs;
		// Due puts in order of due time (duty first), as for checkpoints: the non-duty devices' jittered orders differ.
		const due: { rec: StreamRecord; why: DeadReason; mine: boolean; at: number }[] = [];
		for (const { rec: r0, why } of cur) {
			const stream = r0.stream;
			const rec = c.repo.stream(stream);
			if (!rec || rec.remoteCheckpointCoversSeq >= rec.remoteHeadSeq || held(rec, why) === undefined) continue;
			if ((st.backoffUntil.get(stream) ?? 0) > now) continue;
			const mine = duty(rec);
			if (!st.since.has(stream)) st.since.set(stream, now);
			// The checkpoint jitter, scaled to the grace (one random draw per stream for both).
			const jitter = fallbackMs > 0 ? Math.floor((this.jitter(stream) / fallbackMs) * grace) : 0;
			const at = st.since.get(stream)! + grace + jitter;
			if (!mine && now < at) continue;
			due.push({ rec, why, mine, at: mine ? -Infinity : at });
		}
		due.sort((x, y) => x.at - y.at);
		let puts = RETIRES_PER_TICK;
		for (const { rec, why, mine } of due) {
			if (c.stopped || puts <= 0 || c.session !== s) return;
			const stream = rec.stream;
			puts--;
			// A batched refresh this recent stands in for the put's own read (the put is a CAS anyway).
			const fresh = now - (st.refreshedAt.get(stream) ?? -Infinity) <= every;
			try {
				const o = await writeRetired(c.deps, c.ckpt, s, stream, { refreshFirst: !mine && !fresh });
				this.count(`retire-${o.t}`);
				if (o.t === "ok") {
					st.stats.written++;
					this.stats.retires++;
					c.diag("retire-written", { cls: rec.cls, why, coversSeq: o.coversSeq, duty: mine });
				} else if (o.t === "not-advancing") st.stats.refreshed++;
				else if (o.t === "conflict") st.stats.conflicts++;
				// A refresh that found rows this device has not read: catch-up reads them, the next tick retires.
				else if (o.t === "refused" || (o.t === "skipped" && o.reason !== "not-caught-up")) st.backoffUntil.set(stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
			} catch (e) {
				this.count("retire-error");
				st.backoffUntil.set(stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
				c.diag("checkpoint-failed", { cls: rec.cls, error: String(e) });
			}
		}
	}

	/**
	 * Dead streams with rows beyond the known relay checkpoint re-read it in one readBatch per tick (as wide as
	 * catch-up batches), from `every` after first seen dead and then every `every`, least recently read first: other
	 * devices' retirements are learnt in about N / width requests, and those streams drop at once. The duty device's
	 * own streams too: it puts 4 a tick, and a flood's backlog past the first `every` is mostly retired by the others
	 * meanwhile (after their grace). Reads only: no write permission, gate or checkpoint hold needed (a read-only
	 * device learns them too). Width 1: none, the put's own refresh covers it.
	 */
	private async refreshDead(s: RelaySession, recs: readonly StreamRecord[], now: number, every: number): Promise<void> {
		const c = this.c;
		const st = c.retire;
		const width = Math.min(s.limits.readBatchStreams, c.tuning.readBatchStreams);
		if (width < 2) return;
		const at = (r: StreamRecord) => st.refreshedAt.get(r.stream) ?? -Infinity;
		const due = recs.filter((r) => !r.stale && !r.frozen && r.remoteCheckpointCoversSeq < r.remoteHeadSeq && !c.sess.isReading(r.stream)
			&& now - (st.since.get(r.stream) ?? now) >= every && now - at(r) >= every);
		if (due.length === 0) return;
		due.sort((x, y) => at(x) - at(y));
		try {
			const { served, retired } = await refreshRetiredBatch(c.deps, s, due.slice(0, width));
			for (const stream of served) st.refreshedAt.set(stream, now);
			st.stats.refreshed += retired;
			st.stats.batches++;
			this.stats.refreshBatches++;
		} catch (e) {
			this.count("retire-refresh-error");
			c.diag("checkpoint-failed", { cls: "body", error: String(e) });
		}
	}

	/** Dead streams nothing lies beyond on the relay any more: their records leave in one bounded transaction. */
	private async dropDead(cur: readonly { readonly rec: StreamRecord; readonly why: DeadReason }[], held: (rec: StreamRecord, why: DeadReason) => ClientFrameId[] | null | undefined): Promise<void> {
		const c = this.c;
		const st = c.retire;
		const batch: { rec: StreamRecord; why: DeadReason; held: ClientFrameId[] | null }[] = [];
		let rows = 0;
		for (const { rec, why } of cur) {
			if (batch.length >= DROPS_PER_TICK) break;
			if (rec.remoteCheckpointCoversSeq < rec.remoteHeadSeq) continue;
			const hf = held(rec, why);
			if (hf === undefined) continue;
			const h = c.handles.peek(rec.stream);
			if ((h && !c.handles.isClean(h)) || c.handles.loadingOf(rec.stream)) continue;
			if (batch.length > 0 && rows + rec.tailRows > DROP_TAIL_ROWS_PER_TICK) break;
			rows += rec.tailRows;
			batch.push({ rec, why, held: hf });
		}
		if (batch.length === 0) return;
		const ok = await c.repo.tDropStreams(batch.map(({ rec, held: hf }) => ({ stream: rec.stream, expect: rec, held: hf ?? [] })));
		batch.forEach(({ rec, why, held: hf }, i) => {
			if (!ok[i]) return;
			const stream = rec.stream;
			if (hf && hf.length > 0) c.applyOutboxResult({ removed: hf.flatMap((id) => c.outbox.get(id) ?? []), updated: [] });
			c.handles.drop(stream);
			for (const m of [c.ckpt.condSince, c.ckpt.jitter, c.ckpt.lastActivity, c.ckpt.backoffUntil, c.ckpt.tooLarge]) m.delete(stream);
			st.forget(stream, rec.docId);
			st.stats.dropped++;
			st.pending = Math.max(0, st.pending - 1);
			this.stats.drops++;
			c.diag("retire-dropped", { cls: rec.cls, why, seq: rec.remoteHeadSeq });
		});
	}

	/**
	 * Body / canvas streams due on the fallback (not this device's duty) re-read their remote checkpoint seq in one
	 * batched request per tick, as wide as catch-up batches (DESIGN §d.9): the ones someone else checkpointed meanwhile
	 * stop being due without a read each; the others are put at their jittered time without a second read (within
	 * REFRESH_FRESH_MS). Width 1 (single reads only): none, writeBodyCheckpoint refreshes per stream.
	 */
	private async refreshFallbacks(s: RelaySession, now: number): Promise<void> {
		const c = this.c;
		const width = Math.min(s.limits.readBatchStreams, c.tuning.readBatchStreams);
		if (width < 2) return;
		for (const [stream, at] of this.refreshedAt) if (now - at >= REFRESH_FRESH_MS) this.refreshedAt.delete(stream);
		const due: StreamRecord[] = [];
		for (const r of c.repo.streams()) {
			if (due.length >= width) break;
			if (r.cls !== "body" && r.cls !== "canvas") continue;
			if (r.stale || r.appliedSeq <= r.remoteCheckpointCoversSeq || this.refreshedAt.has(r.stream) || c.sess.isReading(r.stream) || c.repo.hasCkptDuty(r.stream)) continue;
			// From fallbackMs on, without the jitter: the jitter spreads the fallback devices' puts, and a read is no put;
			// streams whose condition started together then share a request instead of trickling in one by one.
			if (bodyCheckpointDue(r, false, c.ckpt, c.tuning.checkpoint, now, 0)) due.push(r);
		}
		if (due.length < 2) return;
		try {
			for (const stream of await refreshRemoteBatch(c.deps, c.ckpt, s, due)) this.refreshedAt.set(stream, now);
			this.stats.refreshBatches++;
		} catch (e) {
			this.count("refresh-batch-error");
			c.diag("checkpoint-failed", { cls: "body", error: String(e) });
		}
	}

	private daily(): void {
		const c = this.c;
		if (c.phase !== "daily-limit" || !c.session || c.mono() < c.dailyLimitUntilMono) return;
		c.sender.releaseDailyHold();
		c.clearNotice("daily-limit");
		c.setPhase(c.livePhase());
	}
}
