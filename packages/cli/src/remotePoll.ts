/**
 * When the daemon's periodic reconcile should also poll the server's change
 * feed (`bootstrap.run()` → `GET /changes`).
 *
 * The periodic reconcile itself is local: a disk scan, delete inference and
 * a controller pass. Only the feed poll touches the server, and every poll
 * wakes the vault's Durable Object. While the root socket is live the daemon
 * already hears about remote change through it — structural root updates,
 * `BODY_COMMITTED` (or, on a socket that outlived a server runtime wake, the
 * receipt-free `BODY_CHANGED_HINT`) and attachment notifications each
 * schedule a catch-up, and a reconnect schedules one on provider sync — so
 * polling on every period
 * mostly wakes an idle vault to learn nothing.
 *
 * The poll therefore runs every period only while the live path cannot be
 * trusted (root socket not healthy, the last catch-up failed, or bodies are
 * still outstanding and need retrying). Otherwise it is a safety net against
 * a lost notification, due once per {@link REMOTE_SAFETY_POLL_PERIODS}
 * reconcile periods with jitter, and pushed back by any successful catch-up,
 * whatever triggered it.
 */

/** Safety-net poll spacing, in reconcile periods: 15 min on the 60 s default. */
export const REMOTE_SAFETY_POLL_PERIODS = 15;
/** ± fraction applied to each safety deadline so daemons do not poll in step. */
const REMOTE_SAFETY_POLL_JITTER = 0.2;

export type RemotePollReason =
	| "root-socket-unhealthy"
	| "catch-up-failed"
	| "outstanding-bodies"
	| "safety-interval";

export interface RemotePollInput {
	/** Root socket open, liveness-acknowledged and synced. */
	readonly rootHealthy: boolean;
	/** Bodies whose settlement failed and waits for a feed retry. */
	readonly outstandingBodies: number;
}

export class RemoteCatchUpSchedule {
	private nextSafetyPollAt: number;
	private lastCatchUpFailed = false;

	constructor(
		private readonly safetyIntervalMs: number,
		private readonly now: () => number = Date.now,
		private readonly random: () => number = Math.random,
	) {
		this.nextSafetyPollAt = this.safetyDeadline();
	}

	/** A catch-up completed; the feed is as fresh as a poll would make it. */
	recordSuccess(): void {
		this.lastCatchUpFailed = false;
		this.nextSafetyPollAt = this.safetyDeadline();
	}

	recordFailure(): void {
		this.lastCatchUpFailed = true;
	}

	/** Why this period should poll, or null when the live socket suffices. */
	due(input: RemotePollInput): RemotePollReason | null {
		if (!input.rootHealthy) return "root-socket-unhealthy";
		if (this.lastCatchUpFailed) return "catch-up-failed";
		if (input.outstandingBodies > 0) return "outstanding-bodies";
		if (this.now() >= this.nextSafetyPollAt) return "safety-interval";
		return null;
	}

	private safetyDeadline(): number {
		const jitter = 1 + (this.random() * 2 - 1) * REMOTE_SAFETY_POLL_JITTER;
		return this.now() + Math.round(this.safetyIntervalMs * jitter);
	}
}
