/**
 * Periodic engine work (one tick every maintenanceMs, never overlapping):
 * gap feed (DESIGN §d.7), lazy T_sent, local compaction (§d.8), remote
 * checkpoint duty (§d.9), daily-limit release, residency budget, catch-up
 * scheduling.
 */

import { TAIL_HARD_ROWS } from "../../core/limits";
import { NS_STREAM, type StreamName } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import { bodyCheckpointDue, foldCheckpointDue, writeBodyCheckpoint, writeFoldCheckpoint } from "../body/checkpoints";
import { compactBody, compactFold, needsCompaction } from "../body/compaction";
import type { EngineCtx } from "./context";

const COMPACTIONS_PER_TICK = 4;
const CHECKPOINTS_PER_TICK = 2;
const COMPACT_SKIP_BACKOFF_MS = 30_000;
const CHECKPOINT_ERROR_BACKOFF_MS = 60_000;

export class Maintenance {
	private timer: TimerHandle | null = null;
	private running: Promise<void> | null = null;
	private readonly compactSkip = new Map<StreamName, number>();
	stats = { ticks: 0, gapFeeds: 0, compactions: 0, checkpoints: 0, checkpointOutcomes: {} as Record<string, number> };

	constructor(private readonly c: EngineCtx) {}

	start(): void {
		this.arm();
	}
	stop(): void {
		if (this.timer !== null) this.c.ports.clock.clearTimer(this.timer);
		this.timer = null;
	}

	private arm(): void {
		if (this.c.stopped || this.timer !== null) return;
		this.timer = this.c.ports.clock.setTimer(this.c.tuning.maintenanceMs, () => {
			this.timer = null;
			void this.tick().finally(() => this.arm());
		});
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
		const steps: [string, () => Promise<void> | void][] = [
			["gap", () => this.gap()],
			["sent", () => this.flushSent()],
			["compact", () => this.compact()],
			["checkpoint", () => this.checkpoints()],
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
		c.sess.scheduleCatchUp();
		c.scheduleStatus();
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

	async flushSent(): Promise<void> {
		const c = this.c;
		if (c.sentPending.size === 0) return;
		const ups = [...c.sentPending].map(([clientFrameId, v]) => ({ clientFrameId, attempts: v.attempts, lastSentAtMs: v.atMs }));
		c.sentPending.clear();
		await c.repo.tSent(ups);
	}

	private async compact(): Promise<void> {
		const c = this.c;
		const now = c.mono();
		let budget = COMPACTIONS_PER_TICK;
		for (const r of [...c.repo.streams()]) {
			if (budget <= 0 || c.stopped) return;
			if (r.cls !== "body" && r.cls !== "canvas" && r.cls !== "ns" && r.cls !== "cfg") continue;
			if (r.stale || r.frozen || c.sess.isReading(r.stream)) continue;
			if ((this.compactSkip.get(r.stream) ?? 0) > now) continue;
			if (!needsCompaction(r, c.tuning.compactRows, c.tuning.compactBytes)) continue;
			if (c.background && r.tailRows <= TAIL_HARD_ROWS) continue; // lane 4 waits; the hard cap is lane 1
			budget--;
			const res = r.cls === "ns" ? await compactFold(c.deps, c.ns) : r.cls === "cfg" ? await compactFold(c.deps, c.cfg) : await compactBody(c.deps, r.stream);
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
		let budget = CHECKPOINTS_PER_TICK;
		for (const r of [...c.repo.streams()]) {
			if (budget <= 0 || c.session !== s) return;
			if (r.cls !== "body" && r.cls !== "canvas") continue;
			if (c.sess.isReading(r.stream)) continue;
			if (!bodyCheckpointDue(r, c.repo.hasCkptDuty(r.stream), c.ckpt, c.tuning.checkpoint, now, this.jitter(r.stream))) continue;
			budget--;
			try {
				const o = await writeBodyCheckpoint(c.deps, c.ckpt, s, r.stream);
				this.count(o.t);
				if (o.t === "ok") this.stats.checkpoints++;
				else if (o.t === "skipped") c.ckpt.backoffUntil.set(r.stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
			} catch (e) {
				this.count("error");
				c.ckpt.backoffUntil.set(r.stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
				c.diag("checkpoint-failed", { cls: r.cls, error: String(e) });
			}
		}
		for (const fold of [c.ns, c.cfg]) {
			const stream = fold.stream;
			const cls = stream === NS_STREAM ? "ns" : "cfg";
			if (c.session !== s) return;
			if (c.sess.isReading(stream)) continue;
			if (!foldCheckpointDue(c.repo.stream(stream), fold, c.ckpt, c.tuning.checkpoint, now, this.jitter(stream))) continue;
			try {
				const o = await writeFoldCheckpoint(c.deps, c.ckpt, s, fold);
				this.count(`${cls}-${o.t}`);
				if (o.t === "ok") this.stats.checkpoints++;
				else if (o.t === "skipped") c.ckpt.backoffUntil.set(stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
			} catch (e) {
				this.count(`${cls}-error`);
				c.ckpt.backoffUntil.set(stream, now + CHECKPOINT_ERROR_BACKOFF_MS);
				c.diag("checkpoint-failed", { cls, error: String(e) });
			}
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
