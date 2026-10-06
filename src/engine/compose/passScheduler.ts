/**
 * Reconcile pass scheduler (DESIGN §f.2 scope, §i.1 lanes). One pass at a
 * time; triggers that arrive while a pass runs merge into the next one.
 *
 *  - gated: no pass before the first complete listing, while paused or
 *    stopped (requests are kept and run when the gate opens);
 *  - coalesced: a short debounce merges bursts (fold batches, vault events);
 *  - follow-up: while a pass was productive (actionable > 0 and ok > 0) the
 *    next one runs at once, up to `maxChained`;
 *  - backoff: actionable ops with nothing succeeding retry after a growing
 *    delay; queued blob transfers retry at the blob queue's next due time;
 *  - periodic: a full pass every `fullIntervalMs`.
 */

import type { DocId, PathKey, PlanScope } from "../../core/types";
import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { PassReport } from "../reconcile/reconciler";

export interface PassSchedulerDeps {
	readonly clock: ClockPort;
	run(scope: PlanScope): Promise<PassReport>;
	ready(): boolean;
	nextBlobDueAtMs(): number | null;
	readonly fullIntervalMs: number;
	readonly debounceMs?: number;
	readonly maxChained?: number;
	onReport?(report: PassReport, scope: PlanScope): void;
	onError?(e: unknown): void;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export class PassScheduler {
	private want: { full: boolean; docIds: Set<DocId>; pathKeys: Set<PathKey> } | null = null;
	private running: Promise<void> | null = null;
	private debounce: TimerHandle | null = null;
	private retry: TimerHandle | null = null;
	private periodic: TimerHandle | null = null;
	private failures = 0;
	private stopped = false;
	private idleWaiters: (() => void)[] = [];
	stats = { passes: 0, fullPasses: 0, errors: 0, lastFullAtMs: null as number | null };
	last: PassReport | null = null;

	constructor(private readonly deps: PassSchedulerDeps) {}

	request(scope: PlanScope = { t: "full" }, now = false): void {
		if (this.stopped) return;
		const w = (this.want ??= { full: false, docIds: new Set(), pathKeys: new Set() });
		if (scope.t === "full") w.full = true;
		else {
			for (const d of scope.docIds) w.docIds.add(d);
			for (const k of scope.pathKeys) w.pathKeys.add(k);
		}
		this.kick(now ? 0 : this.deps.debounceMs ?? 30);
	}

	/** Re-check the gate (listing complete, resume). */
	poke(): void {
		if (this.want) this.kick(0);
	}

	get idle(): boolean {
		return this.running === null && this.debounce === null && (this.want === null || !this.deps.ready());
	}

	/** Resolves when no pass runs or is due (gated requests count as idle). */
	whenIdle(): Promise<void> {
		if (this.idle) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	stop(): void {
		this.stopped = true;
		for (const t of [this.debounce, this.retry, this.periodic]) if (t !== null) this.deps.clock.clearTimer(t);
		this.debounce = this.retry = this.periodic = null;
		this.want = null;
		this.settleIdle();
	}

	/** Wait for the running pass (stop path). */
	async drain(): Promise<void> {
		while (this.running) await this.running;
	}

	private kick(delayMs: number): void {
		if (this.stopped || this.running) return;
		if (this.debounce !== null) {
			if (delayMs > 0) return;
			this.deps.clock.clearTimer(this.debounce);
		}
		this.debounce = this.deps.clock.setTimer(delayMs, () => {
			this.debounce = null;
			this.loop();
		});
	}

	private settleIdle(): void {
		if (!this.idle) return;
		const w = this.idleWaiters;
		this.idleWaiters = [];
		for (const r of w) r();
	}

	private take(): PlanScope | null {
		const w = this.want;
		if (!w) return null;
		this.want = null;
		if (w.full) return { t: "full" };
		return { t: "docs", docIds: [...w.docIds], pathKeys: [...w.pathKeys] };
	}

	private loop(): void {
		if (this.stopped || this.running) return;
		if (!this.deps.ready() || !this.want) {
			this.settleIdle();
			return;
		}
		this.running = this.chain().finally(() => {
			this.running = null;
			if (this.want && this.deps.ready()) this.kick(0);
			this.settleIdle();
		});
	}

	private async chain(): Promise<void> {
		const max = this.deps.maxChained ?? 12;
		let chained = 0;
		let scope = this.take();
		while (scope && !this.stopped && this.deps.ready()) {
			let report: PassReport;
			try {
				report = await this.deps.run(scope);
			} catch (e) {
				this.stats.errors++;
				this.deps.onError?.(e);
				this.scheduleRetry();
				return;
			}
			this.stats.passes++;
			if (scope.t === "full") {
				this.stats.fullPasses++;
				this.stats.lastFullAtMs = this.deps.clock.now();
				this.armPeriodic();
			}
			this.last = report;
			this.deps.onReport?.(report, scope);
			const productive = report.actionable > 0 && report.ok > 0;
			// Unread files (disk read failed) are only re-planned by a later pass: retry with backoff.
			if ((report.actionable > 0 && report.ok === 0 && report.held < report.actionable) || report.unread > 0) this.scheduleRetry();
			else if (report.actionable === 0 || productive) this.failures = 0;
			this.armBlobRetry();
			if (productive && ++chained < max) {
				// Follow-up pass over everything the last one touched (cheap enough: plans are linear).
				const next = this.take();
				scope = next && next.t === "docs" && scope.t === "full" ? scope : next ?? scope;
				continue;
			}
			scope = this.take();
			chained = 0;
		}
	}

	private scheduleRetry(): void {
		if (this.stopped || this.retry !== null) return;
		this.failures++;
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(10, this.failures - 1));
		this.retry = this.deps.clock.setTimer(delay, () => {
			this.retry = null;
			this.request({ t: "full" }, true);
		});
	}

	private armBlobRetry(): void {
		const due = this.deps.nextBlobDueAtMs();
		if (due === null || this.retry !== null || this.stopped) return;
		const delay = Math.max(0, due - this.deps.clock.now()) + 5;
		this.retry = this.deps.clock.setTimer(delay, () => {
			this.retry = null;
			this.request({ t: "full" }, true);
		});
	}

	private armPeriodic(): void {
		if (this.stopped) return;
		if (this.periodic !== null) this.deps.clock.clearTimer(this.periodic);
		this.periodic = this.deps.clock.setTimer(this.deps.fullIntervalMs, () => {
			this.periodic = null;
			this.request({ t: "full" });
		});
	}
}
