/**
 * Abandoned creates (DESIGN §i.5; identity-per-store §5.2): which foreign creators of body-less docs the server
 * reports retired. A live doc whose create committed and whose initial body never did waits for its creator
 * (planner `body-empty`): only the creator has the text. A retired creator never sends again (its sessions are closed
 * and its buffered frames dropped, relay-wire §2.4.1), so once one reads retired for `abandonedCreateGraceMs` its
 * empty docs are lost creates for every device (logPort `lostCreateBody`): dropped, and a file a device holds at the
 * path is created again as a new doc.
 *
 * Asked through `POST /auth/device/status` (IdentityPort.status) for the creators view() names: one request in
 * flight, at most 32 ids each, whatever the number of docs (one entry per creator). Timers (timer-audit.md, idle
 * cost): at most one, and none while no doc waits on a foreign creator.
 *  - A creator that read live is asked again after `creatorStatusRecheckMs`, doubling per live answer up to
 *    `creatorStatusRecheckMaxMs`, by this timer itself (an idle vault re-reads no view).
 *  - "unknown" (an id the server never registered: a store from before identities, or another server's) is never
 *    abandoned and is not asked about again in this runtime: a committed create's author was registered once, so it
 *    can only turn retired through a tombstone, which reads "retired", not "unknown".
 *  - A retired creator's grace ends on the same timer, which then re-plans (`onAbandoned`).
 * Without a status port (an older host) nothing is ever abandoned and nothing is armed.
 */

import type { DeviceId } from "../../core/types";
import type { TimerHandle } from "../../ports/clock";
import type { DeviceState } from "../../ports/identity";

const BATCH = 32;

export interface CreatorStatusDeps {
	readonly status: ((ids: readonly DeviceId[]) => Promise<ReadonlyMap<DeviceId, DeviceState> | null>) | null;
	readonly mono: () => number;
	readonly setTimer: (ms: number, fn: () => void) => TimerHandle;
	readonly clearTimer: (h: TimerHandle) => void;
	readonly graceMs: number;
	/** The first recheck of a creator that read live; doubles per live answer. */
	readonly recheckMs: number;
	/** The recheck's cap. */
	readonly recheckMaxMs: number;
	/** A creator turned abandoned (its grace ran out): re-plan. */
	readonly onAbandoned: () => void;
	readonly diag?: (line: string) => void;
}

export class CreatorStatus {
	/** Creator → when it first read retired (mono). */
	private readonly retiredAt = new Map<DeviceId, number>();
	/** Creator that read live → when it is due again (mono) and how many live answers it gave. */
	private readonly live = new Map<DeviceId, { readonly dueAt: number; readonly answers: number }>();
	/** Creators the server does not know: never asked again in this runtime. */
	private readonly unknown = new Set<DeviceId>();
	private readonly wanted = new Set<DeviceId>();
	/** The creators the latest view() named (body-less docs, creator not abandoned). */
	private named: ReadonlySet<DeviceId> = new Set();
	/** The one timer: the earliest recheck of a named creator or end of a grace. */
	private timer: TimerHandle | null = null;
	private timerAt = 0;
	/** Retired creators whose grace end was reported (onAbandoned). */
	private readonly reported = new Set<DeviceId>();
	private inFlight = false;
	/** The ids of the request in flight: not queued again meanwhile (a second answer would double the backoff). */
	private asking: ReadonlySet<DeviceId> = new Set();
	private stopped = false;

	constructor(private readonly d: CreatorStatusDeps) {}

	/** `createdBy` read retired at least the grace ago. */
	abandoned(createdBy: DeviceId): boolean {
		const at = this.retiredAt.get(createdBy);
		return at !== undefined && this.d.mono() - at >= this.d.graceMs;
	}

	/**
	 * A decision is pending: a request queued or in flight, a grace running, or a body-less doc whose creator is not
	 * abandoned (it is waited on: its creator sends the body, or reads retired at a recheck). The sim's quiescence.
	 */
	busy(): boolean {
		if (!this.d.status) return false;
		if (this.inFlight || this.wanted.size > 0) return true;
		for (const id of this.retiredAt.keys()) if (!this.abandoned(id)) return true;
		for (const id of this.named) if (!this.abandoned(id)) return true;
		return false;
	}

	/** Whether the timer is armed (tests: an idle vault without waiting docs arms none). */
	get armed(): boolean {
		return this.timer !== null;
	}

	/** view() found body-less docs of these creators (none: empty): ask the server about the ones not known or due. */
	seen(creators: ReadonlySet<DeviceId>): void {
		this.named = creators;
		if (this.stopped || !this.d.status) return;
		this.queueDue();
		void this.flush();
		this.arm();
	}

	stop(): void {
		this.stopped = true;
		this.disarm();
	}

	private queueDue(): void {
		const now = this.d.mono();
		for (const id of this.named) {
			if (this.retiredAt.has(id) || this.unknown.has(id) || this.asking.has(id)) continue;
			const l = this.live.get(id);
			if (l && l.dueAt > now) continue;
			this.wanted.add(id);
		}
	}

	private disarm(): void {
		if (this.timer !== null) this.d.clearTimer(this.timer);
		this.timer = null;
	}

	/** (Re)arm the one timer at the earliest due recheck of a named creator or grace end; none: disarmed. */
	private arm(): void {
		if (this.stopped) return;
		let at = Infinity;
		for (const id of this.named) {
			const l = this.live.get(id);
			if (l && !this.wanted.has(id) && !this.asking.has(id)) at = Math.min(at, l.dueAt);
		}
		for (const [id, t] of this.retiredAt) if (!this.reported.has(id)) at = Math.min(at, t + this.d.graceMs);
		if (at === Infinity) {
			this.disarm();
			return;
		}
		if (this.timer !== null && this.timerAt === at) return;
		this.disarm();
		this.timerAt = at;
		const h = this.d.setTimer(Math.max(0, at - this.d.mono()), () => {
			if (this.timer !== h) return;
			this.timer = null;
			if (this.stopped) return;
			let ended = false;
			for (const id of this.retiredAt.keys()) {
				if (this.reported.has(id) || !this.abandoned(id)) continue;
				this.reported.add(id);
				ended = true;
			}
			if (ended) this.d.onAbandoned();
			this.queueDue();
			void this.flush();
			this.arm();
		});
		this.timer = h;
	}

	private async flush(): Promise<void> {
		const status = this.d.status;
		if (this.inFlight || this.wanted.size === 0 || !status) return;
		this.inFlight = true;
		const ids = [...this.wanted].sort().slice(0, BATCH);
		for (const id of ids) this.wanted.delete(id);
		this.asking = new Set(ids);
		let states: ReadonlyMap<DeviceId, DeviceState> | null = null;
		try {
			states = await status(ids);
		} catch {
			states = null;
		}
		this.inFlight = false;
		this.asking = new Set();
		if (this.stopped) return;
		const now = this.d.mono();
		// Not answered (offline, not authenticated yet): the next view() asks again.
		if (states) {
			for (const id of ids) {
				const s = states.get(id) ?? "unknown";
				if (s === "unknown") {
					this.unknown.add(id);
				} else if (s === "live") {
					const answers = (this.live.get(id)?.answers ?? 0) + 1;
					const wait = Math.min(this.d.recheckMs * 2 ** Math.min(answers - 1, 30), this.d.recheckMaxMs);
					this.live.set(id, { dueAt: now + wait, answers });
				} else {
					this.live.delete(id);
					this.retiredAt.set(id, now);
					this.d.diag?.(`creator retired: ${id}; its body-less docs are abandoned in ${this.d.graceMs} ms`);
				}
			}
		}
		await this.flush();
		this.arm();
	}
}
