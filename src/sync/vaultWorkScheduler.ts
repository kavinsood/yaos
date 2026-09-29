import type { OperationOutcome } from "../runtime/operationLifecycle";
import {
	OverdueWorkKernel,
	ReconstructibleOverdueWorkStore,
	type DurableWorkIntent,
	type OverdueWorkClock,
	type OverdueWorkDiagnostics,
	type OverdueWorkRandom,
	type WorkPriority,
} from "../runtime/overdueWorkKernel";

export type VaultWorkMetadata =
	| { readonly kind: "reconnect"; readonly reason: string }
	| { readonly kind: "body-wake"; readonly bodyId: string; readonly minimumGeneration: number }
	| { readonly kind: "candidate"; readonly bodyId: string }
	| { readonly kind: "lifecycle-replay"; readonly groupKey: string }
	| { readonly kind: "attachment-publication" };

const TICKET_EXPIRY_WORK_KEY = "ticket-expiry";

/** Connection-maintenance slots; they are not pending local work. */
export const CONNECTION_WORK_KEYS: ReadonlySet<string> = new Set(["reconnect", TICKET_EXPIRY_WORK_KEY]);

/**
 * Reconnect reasons that only concern a non-root provider (a body socket).
 * While root is open they repair detached providers and never replace root;
 * they must also reach the scheduler while root is connected, or the body
 * never reconnects.
 */
export function isDetachedProviderRepairReason(reason: string): boolean {
	return reason.startsWith("body-disconnected:") || reason.startsWith("socket-liveness-fallback:");
}

export interface VaultWorkSchedulerDeps {
	readonly clock?: OverdueWorkClock;
	readonly random?: OverdueWorkRandom;
	readonly initialIntents?: readonly DurableWorkIntent<VaultWorkMetadata>[];
	reconnect(reason: string): Promise<OperationOutcome>;
	wakeBody(bodyId: string, minimumGeneration: number): Promise<OperationOutcome>;
	flushCandidate(bodyId: string): Promise<OperationOutcome>;
	retryLifecycle(groupKey: string): Promise<OperationOutcome>;
	retryAttachmentPublications(): Promise<OperationOutcome>;
	onError(error: unknown): void;
}

const browserClock: OverdueWorkClock = {
	now: () => Date.now(),
	setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
	clearTimer: (handle) => window.clearTimeout(handle as number),
};

const priorityRank: Record<WorkPriority, number> = {
	background: 0,
	normal: 1,
	interactive: 2,
};

/** Product adapter for the first four staged RFC 10 queue migrations. */
export class VaultWorkScheduler {
	private readonly store: ReconstructibleOverdueWorkStore<VaultWorkMetadata>;
	private readonly kernel: OverdueWorkKernel<VaultWorkMetadata>;
	private readonly clock: OverdueWorkClock;
	private readonly bodyWakeGenerations = new Map<string, number>();
	private readonly bodyWakePriorities = new Map<string, WorkPriority>();
	private accepting = true;
	/** Earliest dueAt queued for the ticket-expiry check that has not started. */
	private pendingTicketExpiryDueAt: number | null = null;

	constructor(private readonly deps: VaultWorkSchedulerDeps) {
		this.clock = deps.clock ?? browserClock;
		this.store = new ReconstructibleOverdueWorkStore(deps.initialIntents ?? []);
		for (const intent of deps.initialIntents ?? []) {
			if (intent.key === TICKET_EXPIRY_WORK_KEY && intent.blocker === undefined) {
				this.pendingTicketExpiryDueAt = intent.dueAt;
			}
			if (intent.metadata?.kind === "body-wake") {
				this.rememberBodyGeneration(intent.metadata.bodyId, intent.metadata.minimumGeneration);
				this.rememberBodyPriority(intent.metadata.bodyId, intent.priority);
			}
		}
		this.kernel = new OverdueWorkKernel({
			store: this.store,
			worker: (intent) => this.run(intent),
			clock: this.clock,
			...(deps.random === undefined ? {} : { random: deps.random }),
			retryPolicies: {
				network: { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0.2 },
				rate_limited: { baseMs: 2_000, maxMs: 120_000, jitterRatio: 0.1 },
				internal: { baseMs: 1_000, maxMs: 30_000, jitterRatio: 0.2 },
			},
			onError: (error) => deps.onError(error),
		});
		if ((deps.initialIntents?.length ?? 0) > 0) this.kernel.poke("startup-reconstruction");
	}

	queueReconnect(reason: string, dueAt = this.clock.now(), maxWaitAt?: number): Promise<void> {
		if (!this.accepting) return Promise.reject(new Error("vault work scheduler is stopped"));
		this.assertTimestamp(dueAt, "reconnect dueAt");
		if (maxWaitAt !== undefined) this.assertTimestamp(maxWaitAt, "reconnect maxWaitAt");
		return this.upsert("reconnect", "interactive", dueAt, maxWaitAt, {
			kind: "reconnect",
			reason,
		});
	}

	/**
	 * Reconnect-kind work in its own slot: a later-due check must not postpone
	 * a pending reconnect, and a reconnect must not erase the check.
	 */
	queueTicketExpiryCheck(reason: string, dueAt: number): Promise<void> {
		if (!this.accepting) return Promise.reject(new Error("vault work scheduler is stopped"));
		this.assertTimestamp(dueAt, "ticket expiry check dueAt");
		// One slot serves every ticket (root, body, canvas): the earliest
		// expiry wins. Last-write-wins let a later-expiring ticket postpone the
		// check an earlier one still needs.
		//
		// The minimum is kept synchronously, with no await between reading and
		// writing it, so two concurrent queues cannot both read a stale record
		// and let the later dueAt win. It only covers checks that have not
		// started: once a check runs, its (past) dueAt is spent. Folding a
		// running check's dueAt into the minimum re-armed the check in the
		// past, so it re-fired immediately, forever (the P0c admission storm).
		const effectiveDueAt = this.pendingTicketExpiryDueAt === null
			? dueAt
			: Math.min(this.pendingTicketExpiryDueAt, dueAt);
		this.pendingTicketExpiryDueAt = effectiveDueAt;
		return this.upsert(TICKET_EXPIRY_WORK_KEY, "normal", effectiveDueAt, undefined, {
			kind: "reconnect",
			reason,
		});
	}

	queueBodyWake(bodyId: string, minimumGeneration: number, priority: WorkPriority = "normal"): Promise<void> {
		if (!this.accepting) return Promise.reject(new Error("vault work scheduler is stopped"));
		this.assertKeyPart(bodyId, "bodyId");
		if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0) {
			throw new Error("minimumGeneration must be a non-negative safe integer");
		}
		const greatestGeneration = this.rememberBodyGeneration(bodyId, minimumGeneration);
		const greatestPriority = this.rememberBodyPriority(bodyId, priority);
		return this.upsert(`body-wake:${bodyId}`, greatestPriority, this.clock.now(), undefined, {
			kind: "body-wake",
			bodyId,
			minimumGeneration: greatestGeneration,
		});
	}

	queueCandidate(bodyId: string, debounceMs: number, maxWaitMs: number): Promise<void> {
		if (!this.accepting) return Promise.reject(new Error("vault work scheduler is stopped"));
		this.assertKeyPart(bodyId, "bodyId");
		this.assertDelay(debounceMs, "debounceMs");
		this.assertDelay(maxWaitMs, "maxWaitMs");
		const now = this.clock.now();
		return this.upsert(`candidate:${bodyId}`, "normal", now + debounceMs, now + maxWaitMs, {
			kind: "candidate",
			bodyId,
		});
	}

	queueCandidateNow(bodyId: string): Promise<void> {
		if (!this.accepting) return Promise.reject(new Error("vault work scheduler is stopped"));
		this.assertKeyPart(bodyId, "bodyId");
		return this.upsert(`candidate:${bodyId}`, "normal", this.clock.now(), undefined, {
			kind: "candidate",
			bodyId,
		});
	}

	queueLifecycleReplay(groupKey: string): Promise<void> {
		if (!this.accepting) return Promise.reject(new Error("vault work scheduler is stopped"));
		this.assertKeyPart(groupKey, "lifecycle groupKey");
		return this.upsert(`lifecycle:${groupKey}`, "normal", this.clock.now(), undefined, {
			kind: "lifecycle-replay",
			groupKey,
		});
	}

	queueAttachmentPublications(dueAt = this.clock.now()): Promise<void> {
		if (!this.accepting) return Promise.reject(new Error("vault work scheduler is stopped"));
		this.assertTimestamp(dueAt, "attachment publication dueAt");
		return this.upsert("attachment-publication", "background", dueAt, undefined, {
			kind: "attachment-publication",
		});
	}

	poke(reason: string): void {
		this.kernel.poke(reason);
	}

	whenIdle(): Promise<void> {
		return this.kernel.whenIdle();
	}

	stop(): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.kernel.stop();
	}

	diagnostics(): OverdueWorkDiagnostics {
		return this.kernel.getDiagnostics();
	}

	private async upsert(
		key: string,
		priority: WorkPriority,
		dueAt: number,
		maxWaitAt: number | undefined,
		metadata: VaultWorkMetadata,
	): Promise<void> {
		if (!this.accepting) throw new Error("vault work scheduler is stopped");
		await this.store.upsert({
			key,
			priority,
			dueAt,
			...(maxWaitAt === undefined ? {} : { maxWaitAt }),
			metadata,
		});
		if (!this.accepting) return;
		this.kernel.poke(`queued:${metadata.kind}`);
	}

	private run(intent: DurableWorkIntent<VaultWorkMetadata>): Promise<OperationOutcome> {
		const metadata = intent.metadata;
		if (!metadata) return Promise.resolve({ kind: "permanently_blocked", failure: "malformed_response" });
		if (intent.key === TICKET_EXPIRY_WORK_KEY) this.pendingTicketExpiryDueAt = null;
		switch (metadata.kind) {
			case "reconnect":
				return this.deps.reconnect(metadata.reason);
			case "body-wake":
				return this.deps.wakeBody(metadata.bodyId, metadata.minimumGeneration);
			case "candidate":
				return this.deps.flushCandidate(metadata.bodyId);
			case "lifecycle-replay":
				return this.deps.retryLifecycle(metadata.groupKey);
			case "attachment-publication":
				return this.deps.retryAttachmentPublications();
		}
	}

	private rememberBodyGeneration(bodyId: string, minimumGeneration: number): number {
		const greatestGeneration = Math.max(this.bodyWakeGenerations.get(bodyId) ?? 0, minimumGeneration);
		this.bodyWakeGenerations.set(bodyId, greatestGeneration);
		return greatestGeneration;
	}

	private rememberBodyPriority(bodyId: string, priority: WorkPriority): WorkPriority {
		const current = this.bodyWakePriorities.get(bodyId);
		const greatestPriority = current === undefined || priorityRank[priority] > priorityRank[current]
			? priority
			: current;
		this.bodyWakePriorities.set(bodyId, greatestPriority);
		return greatestPriority;
	}

	private assertDelay(value: number, label: string): void {
		if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
	}

	private assertTimestamp(value: number, label: string): void {
		if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
	}

	private assertKeyPart(value: string, label: string): void {
		if (value.length === 0) throw new Error(`${label} must not be empty`);
	}
}
