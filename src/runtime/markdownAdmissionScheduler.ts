import type { OperationOutcome } from "./operationLifecycle";
import {
	OverdueWorkKernel,
	ReconstructibleOverdueWorkStore,
	type DurableWorkIntent,
	type OverdueWorkClock,
	type OverdueWorkDiagnostics,
	type OverdueWorkRandom,
} from "./overdueWorkKernel";

export interface MarkdownAdmissionIntent {
	readonly path: string;
	readonly revision: number;
	readonly reason: "create" | "modify";
	readonly bodyId: string;
	readonly candidateId: string;
	readonly primaryOpId?: string;
	readonly coalescedOpIds: readonly string[];
}

export interface MarkdownAdmissionSchedulerDeps {
	readonly clock?: OverdueWorkClock;
	readonly random?: OverdueWorkRandom;
	readonly settleMs?: number;
	readonly maxWaitMs?: number;
	process(
		intent: MarkdownAdmissionIntent,
		isCurrent: () => boolean,
	): Promise<OperationOutcome>;
	onError(error: unknown): void;
}

const browserClock: OverdueWorkClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimer: (handle) => window.clearTimeout(handle as number),
};

const DEFAULT_SETTLE_MS = 350;
const DEFAULT_MAX_WAIT_MS = 2_000;

/**
 * Revision-fenced, per-path ownership for Markdown work that has not reached
 * durable lifecycle persistence yet. The filesystem inventory reconstructs
 * this queue after restart, so the queue itself intentionally remains local.
 */
export class MarkdownAdmissionScheduler {
	private readonly clock: OverdueWorkClock;
	private readonly settleMs: number;
	private readonly maxWaitMs: number;
	private readonly store = new ReconstructibleOverdueWorkStore<MarkdownAdmissionIntent>();
	private readonly kernel: OverdueWorkKernel<MarkdownAdmissionIntent>;
	private readonly current = new Map<string, { intent: MarkdownAdmissionIntent; firstQueuedAt: number }>();
	private revisionSequence = 0;
	private accepting = true;

	constructor(private readonly deps: MarkdownAdmissionSchedulerDeps) {
		this.clock = deps.clock ?? browserClock;
		this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
		this.maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
		this.kernel = new OverdueWorkKernel({
			store: this.store,
			clock: this.clock,
			...(deps.random === undefined ? {} : { random: deps.random }),
			retryPolicies: {
				local_persistence: { baseMs: 500, maxMs: 30_000, jitterRatio: 0.2 },
				internal: { baseMs: 1_000, maxMs: 30_000, jitterRatio: 0.2 },
			},
			worker: (work) => this.run(work),
			onError: (error) => deps.onError(error),
		});
	}

	queue(input: {
		path: string;
		reason: "create" | "modify";
		bodyId?: string;
		candidateId?: string;
		opId?: string;
		coalescedOpIds?: readonly string[];
	}): void {
		if (!this.accepting) return;
		const now = this.clock.now();
		const previous = this.current.get(input.path);
		const coalescedOpIds = new Set([
			...(previous?.intent.coalescedOpIds ?? []),
			...(input.coalescedOpIds ?? []),
		]);
		if (input.opId) coalescedOpIds.add(input.opId);
		const intent: MarkdownAdmissionIntent = {
			path: input.path,
			revision: ++this.revisionSequence,
			reason: previous?.intent.reason === "create" || input.reason === "create" ? "create" : "modify",
			bodyId: previous?.intent.bodyId ?? input.bodyId ?? crypto.randomUUID(),
			candidateId: previous?.intent.candidateId ?? input.candidateId ?? input.opId ?? crypto.randomUUID(),
			primaryOpId: previous?.intent.primaryOpId ?? input.opId,
			coalescedOpIds: [...coalescedOpIds],
		};
		const firstQueuedAt = previous?.firstQueuedAt ?? now;
		this.current.set(input.path, { intent, firstQueuedAt });
		void this.store.upsert({
			key: this.key(input.path),
			priority: "normal",
			dueAt: now + this.settleMs,
			maxWaitAt: firstQueuedAt + this.maxWaitMs,
			metadata: intent,
		}).then(() => {
			if (this.accepting) this.kernel.poke(`markdown:${input.reason}`);
		}).catch((error) => this.deps.onError(error));
	}

	redirect(oldPath: string, newPath: string): boolean {
		const previous = this.current.get(oldPath);
		if (!previous || !this.accepting) return false;
		this.current.delete(oldPath);
		this.queue({
			path: newPath,
			reason: previous.intent.reason,
			bodyId: previous.intent.bodyId,
			candidateId: previous.intent.candidateId,
			opId: previous.intent.primaryOpId,
			coalescedOpIds: previous.intent.coalescedOpIds,
		});
		return true;
	}

	drop(path: string): boolean {
		return this.current.delete(path);
	}

	reset(): void {
		if (!this.accepting) return;
		this.current.clear();
		this.revisionSequence++;
		this.kernel.poke("markdown-reset");
	}

	isCurrent(path: string, revision: number): boolean {
		return this.accepting && this.current.get(path)?.intent.revision === revision;
	}

	stop(): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.current.clear();
		this.kernel.stop();
	}

	diagnostics(): OverdueWorkDiagnostics {
		return this.kernel.getDiagnostics();
	}

	whenIdle(): Promise<void> {
		return this.kernel.whenIdle();
	}

	private async run(work: DurableWorkIntent<MarkdownAdmissionIntent>): Promise<OperationOutcome> {
		const intent = work.metadata;
		if (!intent || !this.isCurrent(intent.path, intent.revision)) return { kind: "superseded" };
		const outcome = await this.deps.process(
			intent,
			() => this.isCurrent(intent.path, intent.revision),
		);
		if (
			outcome.kind === "completed"
			|| outcome.kind === "cancelled"
			|| outcome.kind === "superseded"
			|| outcome.kind === "durably_pending"
		) {
			if (this.isCurrent(intent.path, intent.revision)) this.current.delete(intent.path);
		}
		return outcome;
	}

	private key(path: string): string {
		return `markdown:${path}`;
	}
}
