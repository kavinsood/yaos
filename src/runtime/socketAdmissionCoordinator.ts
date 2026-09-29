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
	/**
	 * `providerId` names the single provider a provider admission opens next;
	 * it is undefined for a full admission, which reopens every owned provider.
	 */
	refreshCredential(epoch: OperationEpoch, force: boolean, providerId?: string): Promise<SocketAdmissionCredential>;
	providers(): readonly SocketAdmissionProvider[];
	afterAdmission(epoch: OperationEpoch): Promise<void>;
	classifyFailure(error: unknown): SocketAdmissionFailure;
	isBlocked(): boolean;
	log(message: string): void;
	/** Test seams for the coalesced re-request backoff. */
	delay?(ms: number): Promise<void>;
	random?(): number;
	/**
	 * Per-document admission rate limit. Checked before a credential is
	 * minted, so a refused admission costs neither a ticket nor a socket.
	 */
	readonly gate?: SocketAdmissionGate;
	now?(): number;
}

/**
 * A request that coalesces into an in-flight full admission (e.g. a root
 * close while that admission is still running) is re-requested this many
 * times, with backoff, when the admission completed but left a provider it
 * owns neither open nor opening. After that the caller gets a retryable
 * failure and its scheduler takes over the backoff.
 */
const MAX_COALESCED_REREQUESTS = 3;
const COALESCED_REREQUEST_BASE_MS = 250;
const COALESCED_REREQUEST_JITTER = 0.2;

/** Owns refresh-first admission for every root/body provider in one runtime. */
export class SocketAdmissionCoordinator {
	private attempt: Promise<OperationOutcome> | null = null;
	private readonly providerAttempts = new Map<string, Promise<OperationOutcome>>();
	private stopped = false;

	constructor(private readonly deps: SocketAdmissionCoordinatorDeps) {}

	request(reason: string): Promise<OperationOutcome> {
		return this.requestAttempt(reason, 0);
	}

	private requestAttempt(reason: string, rerequests: number): Promise<OperationOutcome> {
		if (this.stopped || !this.deps.scope.isAccepting) {
			return Promise.resolve({ kind: "cancelled" });
		}
		if (this.deps.isBlocked()) return Promise.resolve({ kind: "cancelled" });
		if (this.attempt) {
			this.deps.log(`socket admission coalesced (${reason})`);
			// The in-flight admission may already be past the point where it
			// (re)opened the provider whose close caused this request. Its
			// "completed" then says nothing about that close.
			return this.attempt.then((outcome) => this.afterCoalesced(outcome, reason, rerequests));
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
		if (this.attempt) {
			// A full admission only reconnects the providers it owns (root). A
			// provider it did not bring up is admitted once it settles, instead
			// of reporting the full admission's outcome for a socket never opened.
			return this.attempt.then((outcome) => outcome.kind === "completed"
				&& !provider.connected && !provider.connecting
				? this.admit(provider, reason)
				: outcome);
		}
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

	private async afterCoalesced(outcome: OperationOutcome, reason: string, rerequests: number): Promise<OperationOutcome> {
		if (outcome.kind !== "completed" || this.stopped || !this.deps.scope.isAccepting || this.deps.isBlocked()) {
			return outcome;
		}
		if (this.deps.providers().every((provider) => provider.connected || provider.connecting)) return outcome;
		if (rerequests >= MAX_COALESCED_REREQUESTS) {
			this.deps.log(`socket admission still detached after coalesced re-requests (${reason})`);
			return { kind: "retryable_failure", failure: "network" };
		}
		const exponential = COALESCED_REREQUEST_BASE_MS * (2 ** rerequests);
		const sample = Math.min(1, Math.max(0, this.deps.random?.() ?? Math.random()));
		const delayMs = Math.round(exponential * (1 + ((sample * 2) - 1) * COALESCED_REREQUEST_JITTER));
		this.deps.log(`socket admission re-requested after coalescing (${reason}, ${delayMs} ms)`);
		await (this.deps.delay?.(delayMs) ?? new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
		return this.requestAttempt(reason, rerequests + 1);
	}

	/**
	 * Returns the refusal for an admission the gate does not allow yet, or
	 * null (and records the attempt) when it may proceed.
	 */
	private gateRefusal(ids: readonly string[], reason: string): OperationOutcome | null {
		const gate = this.deps.gate;
		if (!gate || ids.length === 0) return null;
		const now = this.deps.now?.() ?? Date.now();
		let retryAfterMs = 0;
		for (const id of ids) retryAfterMs = Math.max(retryAfterMs, gate.blockedFor(id, now));
		if (retryAfterMs > 0) {
			this.deps.log(`socket admission deferred (${ids.join(",")}/${reason}): ${retryAfterMs} ms`);
			return { kind: "retryable_failure", failure: "rate_limited", retryAfterMs };
		}
		for (const id of ids) gate.record(id, now);
		return null;
	}

	private async run(reason: string, epoch: OperationEpoch): Promise<OperationOutcome> {
		const refused = this.gateRefusal(this.deps.providers().map((provider) => provider.id), reason);
		if (refused) return refused;
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
		const refused = this.gateRefusal([provider.id], reason);
		if (refused) return refused;
		try {
			await this.deps.refreshCredential(epoch, false, provider.id);
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

export interface ShortLivedConnectionBackoffOptions {
	/** A connection closed sooner than this after opening counts as a flap. */
	readonly shortLivedMs?: number;
	readonly baseMs?: number;
	readonly maxMs?: number;
	readonly jitterRatio?: number;
	readonly random?: () => number;
}

/**
 * Backoff for sockets that are admitted and then closed again almost at once
 * (e.g. a server that rejects the new socket after upgrade). Such a close is
 * not an admission failure, so neither the admission's nor the scheduler's
 * failure backoff applies, and the fixed fast-reconnect debounce alone turns
 * it into a reconnect every second. From the second consecutive short-lived
 * connection on, reconnects get an exponentially growing, jittered, capped
 * delay (base, 2×base, … up to max); a connection
 * that lives past {@link ShortLivedConnectionBackoffOptions.shortLivedMs}
 * resets the streak.
 */
export class ShortLivedConnectionBackoff {
	private readonly openedAt = new Map<string, number>();
	private readonly streaks = new Map<string, number>();
	private readonly shortLivedMs: number;
	private readonly baseMs: number;
	private readonly maxMs: number;
	private readonly jitterRatio: number;
	private readonly random: () => number;

	constructor(options: ShortLivedConnectionBackoffOptions = {}) {
		this.shortLivedMs = options.shortLivedMs ?? 10_000;
		this.baseMs = options.baseMs ?? 1_000;
		this.maxMs = options.maxMs ?? 60_000;
		this.jitterRatio = options.jitterRatio ?? 0.2;
		this.random = options.random ?? Math.random;
	}

	opened(id: string, now: number): void {
		this.openedAt.set(id, now);
	}

	/**
	 * Records a close. Returns the reconnect delay a flapping connection must
	 * wait, or null when the connection was not short-lived.
	 */
	closed(id: string, now: number): number | null {
		const openedAt = this.openedAt.get(id);
		this.openedAt.delete(id);
		if (openedAt === undefined) return null;
		if (now - openedAt >= this.shortLivedMs || now < openedAt) {
			this.streaks.delete(id);
			return null;
		}
		const streak = (this.streaks.get(id) ?? 0) + 1;
		this.streaks.set(id, streak);
		// A single short-lived connection is ordinary (e.g. a server runtime
		// wake right after open); only a repeat is a storm.
		if (streak < 2) return null;
		const capped = Math.min(this.maxMs, this.baseMs * (2 ** Math.min(streak - 2, 30)));
		const sample = Math.min(1, Math.max(0, this.random()));
		const jittered = capped * (1 + ((sample * 2) - 1) * this.jitterRatio);
		return Math.max(0, Math.round(Math.min(this.maxMs, jittered)));
	}

	forget(id: string): void {
		this.openedAt.delete(id);
		this.streaks.delete(id);
	}
}

export interface SocketAdmissionGateOptions {
	/** Sliding window for the per-document admission budget. */
	readonly windowMs?: number;
	/** Admissions allowed per document per window before the breaker trips. */
	readonly maxAdmissionsPerWindow?: number;
	/** First breaker delay; each trip without a quiet period doubles it. */
	readonly breakerBaseMs?: number;
	readonly breakerMaxMs?: number;
	/** A breaker that has not tripped for this long starts over at the base. */
	readonly breakerResetMs?: number;
	/** Consecutive admissions whose socket never opened that pass freely. */
	readonly freeUnopenedAttempts?: number;
	readonly unopenedBaseMs?: number;
	readonly unopenedMaxMs?: number;
	readonly jitterRatio?: number;
	readonly random?: () => number;
}

interface GateState {
	admissions: number[];
	unopened: number;
	lastAdmissionAt: number | null;
	unopenedDelayMs: number;
	trips: number;
	lastTripAt: number | null;
	blockedUntil: number;
}

/**
 * Rate limit for socket admissions, per document (root, each body).
 *
 * Two independent guards, both enforced before a ticket is minted:
 *
 * - Never-opened churn: an admission whose socket closes (or is torn down)
 *   before it ever opens emits no "disconnected" status, so the flap backoff
 *   never sees it. After {@link SocketAdmissionGateOptions.freeUnopenedAttempts}
 *   consecutive such admissions, the next one waits an exponentially growing,
 *   jittered delay (1 s … 60 s by default). An `opened()` resets the streak.
 * - Circuit breaker: more than `maxAdmissionsPerWindow` admissions that did
 *   not open a socket in the sliding window (10 per minute by default)
 *   blocks the document for 2 s.
 *   Until five minutes pass without a trip, each admission it lets through
 *   re-trips it at double the delay (4 s, 8 s, … up to 5 min). This bounds
 *   any storm, whatever loop causes it, to roughly log2 admissions.
 */
export class SocketAdmissionGate {
	private readonly states = new Map<string, GateState>();
	private readonly windowMs: number;
	private readonly maxAdmissions: number;
	private readonly breakerBaseMs: number;
	private readonly breakerMaxMs: number;
	private readonly breakerResetMs: number;
	private readonly freeUnopened: number;
	private readonly unopenedBaseMs: number;
	private readonly unopenedMaxMs: number;
	private readonly jitterRatio: number;
	private readonly random: () => number;

	constructor(options: SocketAdmissionGateOptions = {}) {
		this.windowMs = options.windowMs ?? 60_000;
		this.maxAdmissions = options.maxAdmissionsPerWindow ?? 10;
		this.breakerBaseMs = options.breakerBaseMs ?? 2_000;
		this.breakerMaxMs = options.breakerMaxMs ?? 5 * 60_000;
		this.breakerResetMs = options.breakerResetMs ?? 5 * 60_000;
		this.freeUnopened = options.freeUnopenedAttempts ?? 2;
		this.unopenedBaseMs = options.unopenedBaseMs ?? 1_000;
		this.unopenedMaxMs = options.unopenedMaxMs ?? 60_000;
		this.jitterRatio = options.jitterRatio ?? 0.2;
		this.random = options.random ?? Math.random;
	}

	/** Milliseconds the next admission of `id` must still wait; 0 when allowed. */
	blockedFor(id: string, now: number): number {
		const state = this.states.get(id);
		if (!state) return 0;
		let waitMs = Math.max(0, state.blockedUntil - now);
		if (state.lastAdmissionAt !== null && state.unopenedDelayMs > 0) {
			waitMs = Math.max(waitMs, state.lastAdmissionAt + state.unopenedDelayMs - now);
		}
		if (waitMs > 0) return Math.ceil(waitMs);
		// Breaker: evaluated at admission time, against the sliding window.
		this.prune(state, now);
		if (state.lastTripAt !== null && now - state.lastTripAt >= this.breakerResetMs) state.trips = 0;
		// Once tripped, the refilled window does not reopen the floodgate: until
		// a quiet period resets the breaker, each admission it lets through
		// re-trips it at the next, doubled, delay.
		const tripped = state.trips > 0 && state.lastTripAt !== null
			&& state.lastAdmissionAt !== null && state.lastAdmissionAt >= state.lastTripAt;
		if (state.admissions.length >= this.maxAdmissions || tripped) {
			state.trips++;
			state.lastTripAt = now;
			const delayMs = this.jitter(Math.min(this.breakerMaxMs, this.breakerBaseMs * (2 ** Math.min(state.trips - 1, 30))), this.breakerMaxMs);
			state.blockedUntil = now + delayMs;
			return delayMs;
		}
		return 0;
	}

	/** Records an admission that {@link blockedFor} allowed. */
	record(id: string, now: number): void {
		const state = this.state(id);
		this.prune(state, now);
		state.admissions.push(now);
		state.lastAdmissionAt = now;
		// This admission is the (unopened + 1)th in a row without an open; the
		// delay applies to the one after it.
		state.unopened++;
		state.unopenedDelayMs = state.unopened <= this.freeUnopened
			? 0
			: this.jitter(Math.min(this.unopenedMaxMs, this.unopenedBaseMs * (2 ** Math.min(state.unopened - this.freeUnopened - 1, 30))), this.unopenedMaxMs);
	}

	/**
	 * The document's socket opened: the never-opened streak ends, and the
	 * admission that opened it is refunded from the breaker window. Opening
	 * sockets quickly is legitimate (switching between notes whose warm
	 * sockets were evicted); a socket that opens and closes again at once is
	 * the flap backoff's job.
	 */
	opened(id: string): void {
		const state = this.states.get(id);
		if (!state) return;
		if (state.unopened > 0) state.admissions.pop();
		state.trips = 0;
		state.lastTripAt = null;
		state.unopened = 0;
		state.unopenedDelayMs = 0;
	}

	forget(id: string): void {
		this.states.delete(id);
	}

	private state(id: string): GateState {
		let state = this.states.get(id);
		if (!state) {
			state = { admissions: [], unopened: 0, lastAdmissionAt: null, unopenedDelayMs: 0, trips: 0, lastTripAt: null, blockedUntil: 0 };
			this.states.set(id, state);
		}
		return state;
	}

	private prune(state: GateState, now: number): void {
		const cutoff = now - this.windowMs;
		let drop = 0;
		while (drop < state.admissions.length && (state.admissions[drop]! <= cutoff || state.admissions[drop]! > now)) drop++;
		if (drop > 0) state.admissions.splice(0, drop);
	}

	private jitter(value: number, max: number): number {
		const sample = Math.min(1, Math.max(0, this.random()));
		return Math.max(1, Math.round(Math.min(max, value * (1 + ((sample * 2) - 1) * this.jitterRatio))));
	}
}
