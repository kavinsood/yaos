/**
 * Abandoned creates (DESIGN §i.5; identity-per-store §5.2): which foreign creators of body-less docs the server
 * reports retired. A live doc whose create committed and whose initial body never did waits for its creator
 * (planner `body-empty`): only the creator has the text. A retired creator never sends again (its sessions are closed
 * and its buffered frames dropped, relay-wire §2.4.1), so once one reads retired for `abandonedCreateGraceMs` its
 * empty docs are lost creates for every device (logPort `lostCreateBody`): dropped, and a file a device holds at the
 * path is created again as a new doc.
 *
 * Asked through `POST /auth/device/status` (IdentityPort.status) for the creators view() names, at most 32 per
 * request, one request in flight; a creator that read live or unknown is asked again after `creatorStatusRecheckMs`
 * (a timer re-reads the view, which asks again while the doc is still body-less).
 * "unknown" is never abandoned (an id the server never registered: a store from before identities, or another
 * server's). Without a status port (an older host) nothing is ever abandoned.
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
	readonly recheckMs: number;
	/** A creator turned abandoned (its grace ran out): re-plan. */
	readonly onAbandoned: () => void;
	/** A creator that read live / unknown is due again: re-read the view (it calls `seen`). */
	readonly onRecheck: () => void;
	readonly diag?: (line: string) => void;
}

export class CreatorStatus {
	/** Creator → when it first read retired (mono). */
	private readonly retiredAt = new Map<DeviceId, number>();
	/** Creator → when it last read live / unknown (mono). */
	private readonly checkedAt = new Map<DeviceId, number>();
	private readonly wanted = new Set<DeviceId>();
	/** The creators the latest view() named (body-less docs, creator not abandoned). */
	private named: ReadonlySet<DeviceId> = new Set();
	private recheck: TimerHandle | null = null;
	private inFlight = false;
	private readonly timers = new Set<TimerHandle>();
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
		if (this.inFlight || this.wanted.size > 0 || this.timers.size > 0) return true;
		for (const id of this.named) if (!this.abandoned(id)) return true;
		return false;
	}

	/** view() found body-less docs of these creators (none: empty): ask the server about the ones not known or due. */
	seen(creators: ReadonlySet<DeviceId>): void {
		this.named = creators;
		if (this.stopped || !this.d.status || creators.size === 0) return;
		const now = this.d.mono();
		for (const id of creators) {
			if (this.retiredAt.has(id)) continue;
			const at = this.checkedAt.get(id);
			if (at !== undefined && now - at < this.d.recheckMs) continue;
			this.wanted.add(id);
		}
		void this.flush();
	}

	stop(): void {
		this.stopped = true;
		for (const t of this.timers) this.d.clearTimer(t);
		this.timers.clear();
		if (this.recheck) this.d.clearTimer(this.recheck);
		this.recheck = null;
	}

	private async flush(): Promise<void> {
		const status = this.d.status;
		if (this.inFlight || this.wanted.size === 0 || !status) return;
		this.inFlight = true;
		const ids = [...this.wanted].sort().slice(0, BATCH);
		for (const id of ids) this.wanted.delete(id);
		let states: ReadonlyMap<DeviceId, DeviceState> | null = null;
		try {
			states = await status(ids);
		} catch {
			states = null;
		}
		this.inFlight = false;
		if (this.stopped) return;
		const now = this.d.mono();
		// Not answered (offline, not authenticated yet): the next view() asks again.
		if (!states) return;
		for (const id of ids) {
			const s = states.get(id) ?? "unknown";
			if (s !== "retired") {
				this.checkedAt.set(id, now);
				if (!this.recheck) {
					this.recheck = this.d.setTimer(this.d.recheckMs, () => {
						this.recheck = null;
						if (!this.stopped) this.d.onRecheck();
					});
				}
				continue;
			}
			this.retiredAt.set(id, now);
			this.d.diag?.(`creator retired: ${id}; its body-less docs are abandoned in ${this.d.graceMs} ms`);
			const t = this.d.setTimer(this.d.graceMs, () => {
				this.timers.delete(t);
				if (!this.stopped) this.d.onAbandoned();
			});
			this.timers.add(t);
		}
		void this.flush();
	}
}
