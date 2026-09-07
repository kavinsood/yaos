import type { OperationEpoch, OperationOutcome, RuntimeScope } from "./operationLifecycle";

export interface SocketAdmissionProvider {
	readonly id: string;
	readonly connected: boolean;
	readonly connecting: boolean;
	disconnect(): void;
	connect(): void | Promise<void>;
}

export interface SocketAdmissionCredential {
	readonly expiresAt: number;
}

export interface SocketAdmissionFailure {
	readonly failure:
		| "network"
		| "rate_limited"
		| "unauthorized"
		| "revoked"
		| "incompatible_protocol"
		| "malformed_response"
		| "internal";
	readonly terminal: boolean;
	readonly retryAfterMs?: number;
}

export interface SocketAdmissionCoordinatorDeps {
	readonly scope: RuntimeScope;
	refreshCredential(epoch: OperationEpoch, force: boolean): Promise<SocketAdmissionCredential>;
	providers(): readonly SocketAdmissionProvider[];
	afterAdmission(epoch: OperationEpoch): Promise<void>;
	classifyFailure(error: unknown): SocketAdmissionFailure;
	isBlocked(): boolean;
	log(message: string): void;
}

/** Owns refresh-first admission for every root/body provider in one runtime. */
export class SocketAdmissionCoordinator {
	private attempt: Promise<OperationOutcome> | null = null;
	private readonly providerAttempts = new Map<string, Promise<OperationOutcome>>();
	private stopped = false;

	constructor(private readonly deps: SocketAdmissionCoordinatorDeps) {}

	get isAttempting(): boolean {
		return this.attempt !== null || this.providerAttempts.size > 0;
	}

	request(reason: string): Promise<OperationOutcome> {
		if (this.stopped || !this.deps.scope.isAccepting) {
			return Promise.resolve({ kind: "cancelled" });
		}
		if (this.deps.isBlocked()) return Promise.resolve({ kind: "cancelled" });
		if (this.attempt) {
			this.deps.log(`socket admission coalesced (${reason})`);
			return this.attempt;
		}
		const epoch = this.deps.scope.captureEpoch();
		if (!epoch) return Promise.resolve({ kind: "cancelled" });
		const priorAdmissions = [...this.providerAttempts.values()];
		const run = (async () => {
			if (priorAdmissions.length > 0) await Promise.all(priorAdmissions);
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" } as const;
			return this.run(reason, epoch);
		})();
		this.attempt = this.deps.scope.track(`socket-admission:${reason}`, run);
		void this.attempt.finally(() => {
			if (this.attempt === run) this.attempt = null;
		});
		return this.attempt;
	}

	admit(provider: SocketAdmissionProvider, reason: string): Promise<OperationOutcome> {
		if (this.stopped || !this.deps.scope.isAccepting || this.deps.isBlocked()) {
			return Promise.resolve({ kind: "cancelled" });
		}
		if (this.attempt) return this.attempt;
		const existing = this.providerAttempts.get(provider.id);
		if (existing) return existing;
		const epoch = this.deps.scope.captureEpoch();
		if (!epoch) return Promise.resolve({ kind: "cancelled" });
		const run = this.runProviderAdmission(provider, reason, epoch);
		const tracked = this.deps.scope.track(`socket-admission:${provider.id}:${reason}`, run);
		this.providerAttempts.set(provider.id, tracked);
		void tracked.finally(() => {
			if (this.providerAttempts.get(provider.id) === tracked) this.providerAttempts.delete(provider.id);
		});
		return tracked;
	}

	stop(): void {
		this.stopped = true;
	}

	private async run(reason: string, epoch: OperationEpoch): Promise<OperationOutcome> {
		this.deps.log(`socket admission started (${reason})`);
		try {
			await this.deps.refreshCredential(epoch, true);
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
			const providers = [...this.deps.providers()];
			for (const provider of providers) provider.disconnect();
			for (const provider of providers) {
				if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
				await provider.connect();
			}
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
			await this.deps.afterAdmission(epoch);
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
			this.deps.log(`socket admission completed (${reason})`);
			return { kind: "completed", value: undefined };
		} catch (error) {
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
			const failure = this.deps.classifyFailure(error);
			this.deps.log(`socket admission failed (${reason}): ${failure.failure}`);
			return failure.terminal
				? { kind: "permanently_blocked", failure: failure.failure }
				: {
					kind: "retryable_failure",
					failure: failure.failure,
					...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
				};
		}
	}

	private async runProviderAdmission(
		provider: SocketAdmissionProvider,
		reason: string,
		epoch: OperationEpoch,
	): Promise<OperationOutcome> {
		try {
			await this.deps.refreshCredential(epoch, false);
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
			provider.disconnect();
			await provider.connect();
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
			return { kind: "completed", value: undefined };
		} catch (error) {
			if (!epoch.isCurrent() || this.stopped) return { kind: "superseded" };
			const failure = this.deps.classifyFailure(error);
			this.deps.log(`socket provider admission failed (${provider.id}/${reason}): ${failure.failure}`);
			return failure.terminal
				? { kind: "permanently_blocked", failure: failure.failure }
				: {
					kind: "retryable_failure",
					failure: failure.failure,
					...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
				};
		}
	}
}
