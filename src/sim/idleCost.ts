/**
 * Idle cost: the work devices do while nothing changes (no edit, no remote row). Battery per wakeup needs a phone;
 * the number of wakeups does not. Counted over a stretch of virtual time on a quiescent world:
 *
 *   timers      every timer fired on the run's clock (all devices; the wakeup count)
 *   ticks       engine maintenance ticks
 *   statuses    status snapshots the engine posted to main
 *   commits     IndexedDB readwrite commits
 *   lists       vault listings (a full reconcile pass lists the vault)
 *   appends     frames appended to the relay
 *   sideWrites  side-file (mirror) writes
 *
 * Relay liveness pings are not here: the sim's relay port has none (they live in the real wsRelay adapter).
 */

import { DEFAULT_TUNING, type EngineTuning } from "../engine/runtime/options";
import { FAST_TUNING } from "../engine/runtime/testHarness";
import type { VirtualClock } from "./clock";
import type { SimDevice } from "./device";
import type { SimNet } from "./net";

export interface IdleCost {
	readonly timers: number;
	readonly ticks: number;
	readonly statuses: number;
	readonly commits: number;
	readonly lists: number;
	readonly appends: number;
	readonly sideWrites: number;
}

/** The DESIGN values for every timer FAST_TUNING shrinks: SimDevice applies FAST_TUNING first, this over it. */
export function productionTuning(): Partial<EngineTuning> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(FAST_TUNING) as (keyof EngineTuning)[]) out[k] = DEFAULT_TUNING[k];
	return out as Partial<EngineTuning>;
}

function snapshot(clock: VirtualClock, devs: readonly SimDevice[], net: SimNet): IdleCost {
	let ticks = 0;
	let statuses = 0;
	let commits = 0;
	let lists = 0;
	let sideWrites = 0;
	for (const d of devs) {
		ticks += d.vrt?.log.maint.stats.ticks ?? 0;
		statuses += d.ui.statuses.length;
		commits += d.storage.commitCount;
		lists += d.vault.calls.list;
		sideWrites += d.sideFiles.writes;
	}
	return { timers: clock.fired, ticks, statuses, commits, lists, appends: net.relay.counters().appendFrames, sideWrites };
}

/** Advance `ms` of virtual time and return what the devices did meanwhile. */
export async function measureIdle(clock: VirtualClock, devs: readonly SimDevice[], net: SimNet, ms: number): Promise<IdleCost> {
	const a = snapshot(clock, devs, net);
	await clock.advance(ms);
	const b = snapshot(clock, devs, net);
	return {
		timers: b.timers - a.timers, ticks: b.ticks - a.ticks, statuses: b.statuses - a.statuses, commits: b.commits - a.commits,
		lists: b.lists - a.lists, appends: b.appends - a.appends, sideWrites: b.sideWrites - a.sideWrites,
	};
}
