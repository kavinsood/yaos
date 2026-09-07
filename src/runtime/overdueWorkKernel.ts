import type { FailureClass, OperationOutcome } from "./operationLifecycle";

export type WorkPriority = "background" | "normal" | "interactive";
export type WorkOwner = "producer" | "kernel";
export type TerminalWorkOutcome = "completed" | "cancelled" | "superseded";
export type WorkBlockerKind = "decision_required" | "permanently_blocked";

export interface WorkBlocker {
	readonly kind: WorkBlockerKind;
	readonly failure: FailureClass;
}

/**
 * A durable queue record. `revision` is an opaque compare-and-swap token: a
 * store must reject mutations when the durable record no longer matches it.
 */
export interface DurableWorkIntent<Metadata = unknown> {
	readonly key: string;
	readonly revision: string | number;
	readonly priority: WorkPriority;
	/** Preferred debounce/not-before time. */
	readonly dueAt: number;
	/** Optional hard bound that prevents repeated producer upserts starving work. */
	readonly maxWaitAt?: number;
	readonly attempt: number;
	readonly owner: WorkOwner;
	readonly blocker?: WorkBlocker;
	readonly metadata?: Metadata;
}

export interface DurableWorkUpsert<Metadata = unknown> {
	readonly key: string;
	readonly priority: WorkPriority;
	readonly dueAt: number;
	readonly maxWaitAt?: number;
	readonly metadata?: Metadata;
}

export interface WorkRetry {
	readonly attempt: number;
	readonly dueAt: number;
	readonly failure: FailureClass;
}

export interface FailureRetryPolicy {
	readonly baseMs: number;
	readonly maxMs: number;
	readonly jitterRatio: number;
}

/**
 * Every mutation is conditional on the supplied intent's revision. Returning
 * `null` from `claimForKernel` means that another durable transition won.
 */
export interface OverdueWorkStore<Metadata = unknown> {
	/**
	 * Atomically inserts or coalesces producer-owned intent by explicit key.
	 * An implementation may update a kernel-owned record, but must retain its
	 * owner so the producer never takes retry scheduling back.
	 */
	upsert(request: DurableWorkUpsert<Metadata>): Promise<DurableWorkIntent<Metadata>>;
	list(): Promise<readonly DurableWorkIntent<Metadata>[]>;
	claimForKernel(intent: DurableWorkIntent<Metadata>): Promise<DurableWorkIntent<Metadata> | null>;
	settle(intent: DurableWorkIntent<Metadata>, outcome: TerminalWorkOutcome): Promise<boolean>;
	scheduleRetry(intent: DurableWorkIntent<Metadata>, retry: WorkRetry): Promise<boolean>;
	markBlocked(intent: DurableWorkIntent<Metadata>, blocker: WorkBlocker): Promise<boolean>;
	handoff(intent: DurableWorkIntent<Metadata>): Promise<boolean>;
}

let reconstructibleStoreSequence = 0;

/**
 * A CAS-safe store for work whose pending state is reconstructible from a
 * durable domain model. Callers seed it from that model at runtime startup;
 * queues that require durable retry timestamps should implement the interface
 * directly on their database instead.
 */
export class ReconstructibleOverdueWorkStore<Metadata = unknown> implements OverdueWorkStore<Metadata> {
	private readonly records = new Map<string, DurableWorkIntent<Metadata>>();
	private readonly storeId = ++reconstructibleStoreSequence;
	private revisionSequence = 0;

	constructor(initial: readonly DurableWorkIntent<Metadata>[] = []) {
		for (const intent of initial) {
			if (this.records.has(intent.key)) throw new Error(`duplicate overdue-work key: ${intent.key}`);
			this.records.set(intent.key, intent);
		}
	}

	async upsert(request: DurableWorkUpsert<Metadata>): Promise<DurableWorkIntent<Metadata>> {
		const current = this.records.get(request.key);
		const maxWaitAt = this.coalescedMaxWait(current?.maxWaitAt, request.maxWaitAt);
		const next: DurableWorkIntent<Metadata> = {
			key: request.key,
			revision: this.nextRevision(),
			priority: request.priority,
			dueAt: request.dueAt,
			...(maxWaitAt === undefined ? {} : { maxWaitAt }),
			attempt: current?.attempt ?? 0,
			owner: current?.owner ?? "producer",
			...(current?.blocker === undefined ? {} : { blocker: current.blocker }),
			...(request.metadata === undefined ? {} : { metadata: request.metadata }),
		};
		this.records.set(next.key, next);
		return next;
	}

	async list(): Promise<readonly DurableWorkIntent<Metadata>[]> {
		return [...this.records.values()];
	}

	async claimForKernel(intent: DurableWorkIntent<Metadata>): Promise<DurableWorkIntent<Metadata> | null> {
		const current = this.current(intent);
		if (current === null || current.blocker !== undefined) return null;
		if (current.owner === "kernel") return current;
		const claimed: DurableWorkIntent<Metadata> = {
			...current,
			revision: this.nextRevision(),
			owner: "kernel",
		};
		this.records.set(claimed.key, claimed);
		return claimed;
	}

	async settle(intent: DurableWorkIntent<Metadata>, _outcome: TerminalWorkOutcome): Promise<boolean> {
		if (this.current(intent) === null) return false;
		this.records.delete(intent.key);
		return true;
	}

	async scheduleRetry(intent: DurableWorkIntent<Metadata>, retry: WorkRetry): Promise<boolean> {
		const current = this.current(intent);
		if (current === null) return false;
		const next: DurableWorkIntent<Metadata> = {
			key: current.key,
			revision: this.nextRevision(),
			priority: current.priority,
			dueAt: retry.dueAt,
			attempt: retry.attempt,
			owner: "kernel",
			...(current.metadata === undefined ? {} : { metadata: current.metadata }),
		};
		this.records.set(next.key, next);
		return true;
	}

	async markBlocked(intent: DurableWorkIntent<Metadata>, blocker: WorkBlocker): Promise<boolean> {
		const current = this.current(intent);
		if (current === null) return false;
		const next: DurableWorkIntent<Metadata> = {
			...current,
			revision: this.nextRevision(),
			owner: "kernel",
			blocker,
		};
		this.records.set(next.key, next);
		return true;
	}

	async handoff(intent: DurableWorkIntent<Metadata>): Promise<boolean> {
		if (this.current(intent) === null) return false;
		this.records.delete(intent.key);
		return true;
	}

	private current(intent: DurableWorkIntent<Metadata>): DurableWorkIntent<Metadata> | null {
		const current = this.records.get(intent.key);
		return current?.revision === intent.revision ? current : null;
	}

	private nextRevision(): string {
		this.revisionSequence++;
		return `memory:${this.storeId}:${this.revisionSequence}`;
	}

	private coalescedMaxWait(current: number | undefined, requested: number | undefined): number | undefined {
		if (current === undefined) return requested;
		if (requested === undefined) return current;
		return Math.min(current, requested);
	}
}

export interface OverdueWorkClock {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface OverdueWorkRandom {
	next(): number;
}

export interface OverdueWorkKernelOptions<Metadata = unknown, Value = void> {
	readonly store: OverdueWorkStore<Metadata>;
	readonly worker: (
		intent: DurableWorkIntent<Metadata>,
	) => Promise<OperationOutcome<Value>> | OperationOutcome<Value>;
	readonly clock?: OverdueWorkClock;
	readonly random?: OverdueWorkRandom;
	readonly maxItemsPerDrain?: number;
	readonly maxDrainMs?: number;
	readonly agingIntervalMs?: number;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
	readonly retryJitterRatio?: number;
	readonly retryPolicies?: Partial<Record<FailureClass, FailureRetryPolicy>>;
	readonly storeErrorRetryMs?: number;
	readonly onError?: (error: unknown) => void;
}

export interface OverdueWorkItemDiagnostic {
	readonly key: string;
	readonly queueAgeMs: number;
	readonly priority: WorkPriority;
	readonly effectivePriority: WorkPriority;
	readonly blocker: WorkBlocker | null;
	readonly attempt: number;
	readonly owner: WorkOwner;
	readonly dueAt: number;
	readonly maxWaitAt: number | null;
	readonly readyAt: number;
	readonly inFlight: boolean;
}

export interface OverdueWorkDiagnostics {
	readonly stopped: boolean;
	readonly draining: boolean;
	readonly pokePending: boolean;
	readonly lastPokeReason: string | null;
	readonly nextWakeAt: number | null;
	readonly queue: readonly OverdueWorkItemDiagnostic[];
}

const PRIORITY_RANK: Record<WorkPriority, number> = {
	background: 0,
	normal: 1,
	interactive: 2,
};

const PRIORITIES: readonly WorkPriority[] = ["background", "normal", "interactive"];

const systemClock: OverdueWorkClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimer: (handle) => window.clearTimeout(handle as number),
};

const systemRandom: OverdueWorkRandom = {
	next: () => Math.random(),
};

/**
 * Re-reads durable intent whenever it is poked; pokes themselves never create
 * work. A drain is single-threaded and bounded, while per-key in-flight state
 * makes the single-flight invariant explicit for diagnostics and future
 * concurrency changes.
 */
export class OverdueWorkKernel<Metadata = unknown, Value = void> {
	private readonly store: OverdueWorkStore<Metadata>;
	private readonly worker: OverdueWorkKernelOptions<Metadata, Value>["worker"];
	private readonly clock: OverdueWorkClock;
	private readonly random: OverdueWorkRandom;
	private readonly maxItemsPerDrain: number;
	private readonly maxDrainMs: number;
	private readonly agingIntervalMs: number;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private readonly retryJitterRatio: number;
	private readonly retryPolicies: Partial<Record<FailureClass, FailureRetryPolicy>>;
	private readonly storeErrorRetryMs: number;
	private readonly onError: (error: unknown) => void;

	private stopped = false;
	private generation = 0;
	private draining = false;
	private pokePending = false;
	private lastPokeReason: string | null = null;
	private timer: { handle: unknown; dueAt: number } | null = null;
	private snapshot: readonly DurableWorkIntent<Metadata>[] = [];
	private readonly inFlightKeys = new Set<string>();
	private idleWaiters: Array<() => void> = [];

	constructor(options: OverdueWorkKernelOptions<Metadata, Value>) {
		this.store = options.store;
		this.worker = options.worker;
		this.clock = options.clock ?? systemClock;
		this.random = options.random ?? systemRandom;
		this.maxItemsPerDrain = options.maxItemsPerDrain ?? 25;
		this.maxDrainMs = options.maxDrainMs ?? 50;
		this.agingIntervalMs = options.agingIntervalMs ?? 30_000;
		this.retryBaseMs = options.retryBaseMs ?? 1_000;
		this.retryMaxMs = options.retryMaxMs ?? 60_000;
		this.retryJitterRatio = options.retryJitterRatio ?? 0.2;
		this.retryPolicies = options.retryPolicies ?? {};
		this.storeErrorRetryMs = options.storeErrorRetryMs ?? 1_000;
		this.onError = options.onError ?? (() => undefined);

		if (!Number.isInteger(this.maxItemsPerDrain) || this.maxItemsPerDrain < 1) {
			throw new Error("maxItemsPerDrain must be a positive integer");
		}
		if (!Number.isFinite(this.maxDrainMs) || this.maxDrainMs < 0) {
			throw new Error("maxDrainMs must be a non-negative finite number");
		}
		if (!Number.isFinite(this.agingIntervalMs) || this.agingIntervalMs <= 0) {
			throw new Error("agingIntervalMs must be a positive finite number");
		}
		if (!Number.isFinite(this.retryBaseMs) || this.retryBaseMs <= 0) {
			throw new Error("retryBaseMs must be a positive finite number");
		}
		if (!Number.isFinite(this.retryMaxMs) || this.retryMaxMs < this.retryBaseMs) {
			throw new Error("retryMaxMs must be finite and at least retryBaseMs");
		}
		if (!Number.isFinite(this.retryJitterRatio) || this.retryJitterRatio < 0 || this.retryJitterRatio > 1) {
			throw new Error("retryJitterRatio must be between zero and one");
		}
		for (const policy of Object.values(this.retryPolicies)) {
			if (policy === undefined
				|| !Number.isFinite(policy.baseMs)
				|| policy.baseMs <= 0
				|| !Number.isFinite(policy.maxMs)
				|| policy.maxMs < policy.baseMs
				|| !Number.isFinite(policy.jitterRatio)
				|| policy.jitterRatio < 0
				|| policy.jitterRatio > 1) {
				throw new Error("each failure retry policy needs positive baseMs, maxMs >= baseMs, and jitterRatio from zero to one");
			}
		}
		if (!Number.isFinite(this.storeErrorRetryMs) || this.storeErrorRetryMs < 0) {
			throw new Error("storeErrorRetryMs must be a non-negative finite number");
		}
	}

	/** Signals that durable state may now contain actionable work. */
	poke(reason: string): void {
		if (this.stopped) return;
		this.lastPokeReason = reason;
		this.pokePending = true;
		this.clearTimer();
		if (!this.draining) this.startDrain();
	}

	/** Resolves after active and immediately-due follow-up drains are quiescent. */
	whenIdle(): Promise<void> {
		if (this.isIdleNow()) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	/** Synchronously fences publication and refuses all later admission. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.generation++;
		this.pokePending = false;
		this.clearTimer();
		this.resolveIdleWaitersIfIdle();
	}

	getDiagnostics(): OverdueWorkDiagnostics {
		const now = this.clock.now();
		return {
			stopped: this.stopped,
			draining: this.draining,
			pokePending: this.pokePending,
			lastPokeReason: this.lastPokeReason,
			nextWakeAt: this.timer?.dueAt ?? null,
			queue: this.snapshot
				.map((intent) => ({
					key: intent.key,
					queueAgeMs: Math.max(0, now - this.readyAt(intent)),
					priority: intent.priority,
					effectivePriority: this.effectivePriority(intent, now),
					blocker: intent.blocker ?? null,
					attempt: intent.attempt,
					owner: intent.owner,
					dueAt: intent.dueAt,
					maxWaitAt: intent.maxWaitAt ?? null,
					readyAt: this.readyAt(intent),
					inFlight: this.inFlightKeys.has(intent.key),
				}))
				.sort((left, right) => left.key.localeCompare(right.key)),
		};
	}

	private startDrain(): void {
		if (this.stopped || this.draining || !this.pokePending) return;
		const generation = this.generation;
		this.draining = true;
		this.pokePending = false;
		void this.drainOnce(generation)
			.catch((error: unknown) => {
				this.onError(error);
				if (this.isCurrent(generation)) this.scheduleTimer(this.clock.now() + this.storeErrorRetryMs);
			})
			.finally(() => {
				this.draining = false;
				if (this.isCurrent(generation) && this.pokePending) {
					this.scheduleTimer(this.clock.now());
				}
				this.resolveIdleWaitersIfIdle();
			});
	}

	private async drainOnce(generation: number): Promise<void> {
		const startedAt = this.clock.now();
		const listed = await this.store.list();
		if (!this.isCurrent(generation)) return;
		this.snapshot = listed;

		const now = this.clock.now();
		const candidates = listed
			.filter((intent) => this.readyAt(intent) <= now && intent.blocker === undefined && !this.inFlightKeys.has(intent.key))
			.sort((left, right) => this.compareWork(left, right, now));

		let inspected = 0;
		for (const candidate of candidates) {
			if (inspected >= this.maxItemsPerDrain) break;
			if (inspected > 0 && this.clock.now() - startedAt >= this.maxDrainMs) break;
			inspected++;
			await this.runCandidate(candidate, generation);
			if (!this.isCurrent(generation)) return;
		}

		const boundedWithWorkRemaining = inspected < candidates.length;
		await this.refreshSchedule(generation, boundedWithWorkRemaining || this.pokePending);
	}

	private async runCandidate(candidate: DurableWorkIntent<Metadata>, generation: number): Promise<void> {
		if (this.inFlightKeys.has(candidate.key)) return;
		const claimed = await this.store.claimForKernel(candidate);
		if (!this.isCurrent(generation) || claimed === null) return;
		if (claimed.owner !== "kernel") {
			throw new Error(`claimForKernel returned non-kernel owner for ${claimed.key}`);
		}
		this.snapshot = this.snapshot.map((intent) => intent.key === claimed.key ? claimed : intent);

		this.inFlightKeys.add(claimed.key);
		try {
			let outcome: OperationOutcome<Value>;
			try {
				outcome = await this.worker(claimed);
			} catch (error) {
				this.onError(error);
				outcome = { kind: "retryable_failure", failure: "internal" };
			}
			if (!this.isCurrent(generation)) return;
			await this.publishOutcome(claimed, outcome);
		} finally {
			this.inFlightKeys.delete(claimed.key);
		}
	}

	private async publishOutcome(intent: DurableWorkIntent<Metadata>, outcome: OperationOutcome<Value>): Promise<void> {
		switch (outcome.kind) {
			case "completed":
			case "cancelled":
			case "superseded":
				await this.store.settle(intent, outcome.kind);
				return;
			case "durably_pending":
				await this.store.handoff(intent);
				return;
			case "retryable_failure": {
				const delayMs = this.retryDelay(intent.attempt, outcome.failure, outcome.retryAfterMs);
				await this.store.scheduleRetry(intent, {
					attempt: intent.attempt + 1,
					dueAt: this.clock.now() + delayMs,
					failure: outcome.failure,
				});
				return;
			}
			case "decision_required":
			case "permanently_blocked":
				await this.store.markBlocked(intent, { kind: outcome.kind, failure: outcome.failure });
		}
	}

	private async refreshSchedule(generation: number, forceImmediate: boolean): Promise<void> {
		const listed = await this.store.list();
		if (!this.isCurrent(generation)) return;
		this.snapshot = listed;

		if (forceImmediate) {
			this.scheduleTimer(this.clock.now());
			return;
		}
		let earliestDueAt = Number.POSITIVE_INFINITY;
		for (const intent of listed) {
			if (intent.blocker === undefined) earliestDueAt = Math.min(earliestDueAt, this.readyAt(intent));
		}
		if (Number.isFinite(earliestDueAt)) this.scheduleTimer(earliestDueAt);
		else this.clearTimer();
	}

	private retryDelay(attempt: number, failure: FailureClass, retryAfterMs: number | undefined): number {
		const policy = this.retryPolicies[failure] ?? {
			baseMs: this.retryBaseMs,
			maxMs: this.retryMaxMs,
			jitterRatio: this.retryJitterRatio,
		};
		const exponential = policy.baseMs * (2 ** Math.min(attempt, 52));
		const capped = Math.min(policy.maxMs, exponential);
		const sample = Math.min(1, Math.max(0, this.random.next()));
		const jitter = ((sample * 2) - 1) * capped * policy.jitterRatio;
		const jittered = Math.min(policy.maxMs, Math.max(0, Math.round(capped + jitter)));
		return Math.max(retryAfterMs ?? 0, jittered);
	}

	private compareWork(
		left: DurableWorkIntent<Metadata>,
		right: DurableWorkIntent<Metadata>,
		now: number,
	): number {
		const priorityDifference = this.effectiveRank(right, now) - this.effectiveRank(left, now);
		if (priorityDifference !== 0) return priorityDifference;
		const dueDifference = this.readyAt(left) - this.readyAt(right);
		if (dueDifference !== 0) return dueDifference;
		return left.key.localeCompare(right.key);
	}

	private effectivePriority(intent: DurableWorkIntent<Metadata>, now: number): WorkPriority {
		return PRIORITIES[this.effectiveRank(intent, now)] ?? "interactive";
	}

	private effectiveRank(intent: DurableWorkIntent<Metadata>, now: number): number {
		const age = Math.max(0, now - this.readyAt(intent));
		return Math.min(PRIORITY_RANK.interactive, PRIORITY_RANK[intent.priority] + Math.floor(age / this.agingIntervalMs));
	}

	private readyAt(intent: DurableWorkIntent<Metadata>): number {
		return Math.min(intent.dueAt, intent.maxWaitAt ?? Number.POSITIVE_INFINITY);
	}

	private scheduleTimer(dueAt: number): void {
		if (this.stopped) return;
		if (this.timer !== null && this.timer.dueAt <= dueAt) return;
		this.clearTimer();
		const delayMs = Math.max(0, dueAt - this.clock.now());
		const handle = this.clock.setTimer(() => {
			if (this.timer?.handle !== handle) return;
			this.timer = null;
			this.poke("timer");
		}, delayMs);
		this.timer = { handle, dueAt };
	}

	private clearTimer(): void {
		if (this.timer === null) return;
		this.clock.clearTimer(this.timer.handle);
		this.timer = null;
	}

	private isCurrent(generation: number): boolean {
		return !this.stopped && this.generation === generation;
	}

	private isIdleNow(): boolean {
		return !this.draining
			&& !this.pokePending
			&& (this.timer === null || this.timer.dueAt > this.clock.now());
	}

	private resolveIdleWaitersIfIdle(): void {
		if (!this.isIdleNow()) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
}
