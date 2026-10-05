import type { OperationOutcome } from "../runtime/operationLifecycle";
import {
	OverdueWorkKernel,
	ReconstructibleOverdueWorkStore,
	type DurableWorkIntent,
	type OverdueWorkClock,
	type OverdueWorkDiagnostics,
	type OverdueWorkRandom,
} from "../runtime/overdueWorkKernel";

export type RecoveryWorkMetadata =
	| { readonly kind: "capture"; readonly captureId: string }
	| { readonly kind: "restore"; readonly restoreId: string; readonly snapshotId: string };

export interface RecoveryWorkSchedulerDeps {
	readonly clock?: OverdueWorkClock;
	readonly random?: OverdueWorkRandom;
	runCapture(captureId: string): Promise<OperationOutcome>;
	runRestore(restoreId: string, snapshotId: string): Promise<OperationOutcome>;
	onError(error: unknown): void;
}

const browserClock: OverdueWorkClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimer: (handle) => window.clearTimeout(handle as number),
};

/** Drives reconstructible recovery operations without owning their durable state. */
export class RecoveryWorkScheduler {
	private readonly store = new ReconstructibleOverdueWorkStore<RecoveryWorkMetadata>();
	private readonly kernel: OverdueWorkKernel<RecoveryWorkMetadata>;
	private readonly clock: OverdueWorkClock;
	private accepting = true;

	constructor(private readonly deps: RecoveryWorkSchedulerDeps) {
		this.clock = deps.clock ?? browserClock;
		this.kernel = new OverdueWorkKernel({
			store: this.store,
			worker: (intent) => this.run(intent),
			clock: this.clock,
			...(deps.random === undefined ? {} : { random: deps.random }),
			retryPolicies: {
				network: { baseMs: 5_000, maxMs: 60_000, jitterRatio: 0.2 },
				rate_limited: { baseMs: 5_000, maxMs: 120_000, jitterRatio: 0.1 },
				internal: { baseMs: 5_000, maxMs: 60_000, jitterRatio: 0.2 },
			},
			onError: (error) => deps.onError(error),
		});
	}

	queueCapture(captureId: string, delayMs = 0): Promise<void> {
		this.assertAccepting();
		this.assertIdentity(captureId, "captureId");
		return this.upsert(`recovery-capture:${captureId}`, "normal", delayMs, {
			kind: "capture",
			captureId,
		});
	}

	queueRestore(restoreId: string, snapshotId: string, delayMs = 0): Promise<void> {
		this.assertAccepting();
		this.assertIdentity(restoreId, "restoreId");
		this.assertIdentity(snapshotId, "snapshotId");
		return this.upsert(`recovery-restore:${restoreId}`, "interactive", delayMs, {
			kind: "restore",
			restoreId,
			snapshotId,
		});
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
		key: string,
		priority: "normal" | "interactive",
		delayMs: number,
		metadata: RecoveryWorkMetadata,
	): Promise<void> {
		if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("recovery work delay must be non-negative");
		await this.store.upsert({
			key,
			priority,
			dueAt: this.clock.now() + delayMs,
			metadata,
		});
		if (this.accepting) this.kernel.poke(`queued:${metadata.kind}`);
	}

	private run(intent: DurableWorkIntent<RecoveryWorkMetadata>): Promise<OperationOutcome> {
		const metadata = intent.metadata;
		if (!metadata) return Promise.resolve({ kind: "permanently_blocked", failure: "malformed_response" });
		return metadata.kind === "capture"
			? this.deps.runCapture(metadata.captureId)
			: this.deps.runRestore(metadata.restoreId, metadata.snapshotId);
	}

	private assertAccepting(): void {
		if (!this.accepting) throw new Error("recovery work scheduler is stopped");
	}

	private assertIdentity(value: string, label: string): void {
		if (!value) throw new Error(`${label} must not be empty`);
	}
}
