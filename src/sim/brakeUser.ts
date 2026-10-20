/**
 * The user answering safety brakes (DESIGN §f.5), as the plugin's brake UI lets them: the engine's report reaches
 * the host (status `brake` / the brake event, pluginController pendingBrake), the user looks at it for a while and
 * runs "Approve" or "Reject" (UserCommand approveBrake / rejectBrake with the report's id) on the device's runtime.
 *
 *   approve   the held destructive ops run (a recovery snapshot first, runtimeOps.ts)
 *   reject    held local deletes re-materialize the remote doc, held remote deletes keep the file (re-created as a
 *             new doc); a rejected job-level mass-overwrite is simply not approved, so the next pass holds it again:
 *             the same report coming back after a reject is approved (the user gives in), or the run would never
 *             quiesce while the 10-minute window still holds it
 *
 * Every decision is drawn from its own seeded stream, in the order brakes are seen (poll() runs after every plan
 * step and heal tick), so a run is still a pure function of its seed. Tokens need no extra accounting: the deletes a
 * user approves were user deletes on the deleting device already (actors.ts marks what that user saw), and what a
 * receiving device trashes lands in its trash (invariant 3 counts trash).
 */

import type { BrakeReport } from "../core/types";
import type { VirtualClock } from "./clock";
import type { SimDevice } from "./device";
import type { SeededRandom } from "./random";

export interface BrakeUserStats {
	readonly seen: Record<string, number>;
	approved: number;
	rejected: number;
}

export class BrakeUser {
	/** Per device: the brake ("<engineStarts>|<id>") the user is looking at or answering now (until the command settles). */
	private readonly busy: (string | null)[];
	/** Brake ids this user rejected, per device (a job-level overwrite brake comes back with the same id). */
	private readonly rejectedIds: Set<string>[];
	readonly stats: BrakeUserStats = { seen: {}, approved: 0, rejected: 0 };

	constructor(
		private readonly clock: VirtualClock,
		private readonly devs: readonly SimDevice[],
		private readonly rng: SeededRandom,
		private readonly isDown: (i: number) => boolean,
		private readonly trace: (line: string) => void,
		private readonly o: { readonly approve: number; readonly thinkMs: readonly [number, number] } = { approve: 0.6, thinkMs: [200, 8_000] },
	) {
		this.busy = devs.map(() => null);
		this.rejectedIds = devs.map(() => new Set());
	}

	/** The brake the device's host shows now (the engine's current report; null once approved, rejected or cleared). */
	private shown(d: SimDevice): BrakeReport | null {
		return d.vrt?.brake ?? null;
	}

	/** Brakes outstanding on any up device (run.ts does not call the run quiescent while one is). */
	pending(): boolean {
		return this.devs.some((d, i) => !this.isDown(i) && (this.shown(d) !== null || this.busy[i] !== null));
	}

	poll(): void {
		this.devs.forEach((d, i) => {
			if (this.isDown(i) || this.busy[i] !== null) return;
			const b = this.shown(d);
			if (!b) return;
			const starts = d.engineStarts;
			this.busy[i] = `${starts}|${b.id}`;
			this.stats.seen[b.reason] = (this.stats.seen[b.reason] ?? 0) + 1;
			const again = this.rejectedIds[i]!.has(b.id);
			const approve = again || this.rng.chance(this.o.approve);
			const think = this.rng.range(this.o.thinkMs[0], this.o.thinkMs[1]);
			this.trace(`brake ${d.name} ${b.reason} held ${b.heldCount}/${b.syncedCount} -> ${approve ? "approve" : "reject"}${again ? " (again)" : ""} in ${think}ms`);
			this.clock.setTimer(think, () => {
				// Gone meanwhile (app crash, engine restart, cleared by a later pass): a report shown again is a new decision.
				if (this.isDown(i) || this.shown(d)?.id !== b.id || d.engineStarts !== starts) {
					this.busy[i] = null;
					return;
				}
				if (approve) this.stats.approved++;
				else {
					this.stats.rejected++;
					this.rejectedIds[i]!.add(b.id);
				}
				const done = () => (this.busy[i] = null);
				d.runtime.command({ t: approve ? "approveBrake" : "rejectBrake", brakeId: b.id }).then(done, done);
			}, "sim-brake-user");
		});
	}
}
