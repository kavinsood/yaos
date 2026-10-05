import type { OperationOutcome } from "../../runtime/operationLifecycle";
import {
	OverdueWorkKernel,
	ReconstructibleOverdueWorkStore,
	type DurableWorkIntent,
	type OverdueWorkClock,
	type OverdueWorkDiagnostics,
	type OverdueWorkRandom,
} from "../../runtime/overdueWorkKernel";

export type SettingsWorkMetadata =
	| { readonly kind: "reconcile"; readonly scopeKey: string }
	| { readonly kind: "apply"; readonly scopeKey: string };

export interface SettingsWorkSchedulerDeps {
	readonly clock?: OverdueWorkClock;
	readonly random?: OverdueWorkRandom;
	runReconcile(): Promise<OperationOutcome>;
	runApply(): Promise<OperationOutcome>;
	onError(error: unknown): void;
}

const browserClock: OverdueWorkClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimer: (handle) => window.clearTimeout(handle as number),
};

/** Settings-shaped adapter over the shared overdue-work kernel. */
export class SettingsWorkScheduler {
	private readonly store = new ReconstructibleOverdueWorkStore<SettingsWorkMetadata>();
	private readonly kernel: OverdueWorkKernel<SettingsWorkMetadata>;
	private readonly clock: OverdueWorkClock;
	private accepting = true;

	constructor(private readonly deps: SettingsWorkSchedulerDeps) {
		this.clock = deps.clock ?? browserClock;
		this.kernel = new OverdueWorkKernel({
			store: this.store,
			worker: (intent) => this.run(intent),
			clock: this.clock,
			...(deps.random === undefined ? {} : { random: deps.random }),
			retryPolicies: {
				network: { baseMs: 2_000, maxMs: 60_000, jitterRatio: 0.2 },
				rate_limited: { baseMs: 5_000, maxMs: 120_000, jitterRatio: 0.1 },
				internal: { baseMs: 2_000, maxMs: 30_000, jitterRatio: 0.2 },
			},
			onError: (error) => deps.onError(error),
		});
	}

	queueReconcile(scopeKey: string, delayMs = 0): Promise<void> {
		return this.upsert("reconcile", scopeKey, "background", delayMs);
	}

	queueApply(scopeKey: string, delayMs = 0): Promise<void> {
		return this.upsert("apply", scopeKey, "interactive", delayMs);
	}

	poke(reason: string): void {
		this.kernel.poke(reason);
	}

	whenIdle(): Promise<void> {
		return this.kernel.whenIdle();
	}

	diagnostics(): OverdueWorkDiagnostics {
		return this.kernel.getDiagnostics();
	}

	stop(): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.kernel.stop();
	}

	private async upsert(
		kind: SettingsWorkMetadata["kind"],
		scopeKey: string,
		priority: "background" | "interactive",
		delayMs: number,
	): Promise<void> {
		if (!this.accepting) throw new Error("settings work scheduler is stopped");
		if (!scopeKey) throw new Error("settings work scope key must not be empty");
		if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("settings work delay must be non-negative");
		const metadata: SettingsWorkMetadata = { kind, scopeKey };
		await this.store.upsert({
			key: `settings-${kind}:${scopeKey}`,
			priority,
			dueAt: this.clock.now() + delayMs,
			metadata,
		});
		if (this.accepting) this.kernel.poke(`queued:${kind}`);
	}

	private run(intent: DurableWorkIntent<SettingsWorkMetadata>): Promise<OperationOutcome> {
		const metadata = intent.metadata;
		if (!metadata) return Promise.resolve({ kind: "permanently_blocked", failure: "malformed_response" });
		return metadata.kind === "reconcile" ? this.deps.runReconcile() : this.deps.runApply();
	}
}
