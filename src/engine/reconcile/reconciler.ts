/**
 * The disk side's public face (DESIGN §f). The engine glue (WP-C/WP-D) feeds
 * it observations, vault events and own-fold events, and calls pass() when
 * something changed; the Reconciler plans from the three trees and runs the
 * plan through the jobs.
 *
 *   const rec = await Reconciler.open(deps);
 *   await rec.start();                         // resume intents
 *   await rec.onObservations(chunk, complete); // startup listing
 *   rec.onVaultEvents(events);                 // hints
 *   await rec.runUntilQuiet();                 // or pass() per trigger
 *   await rec.applyOwnFold(events);            // S1, from the ns runtime
 */

import type { BrakeReport, DocId, PathKey, PlanScope, PlannerInput, PlannerOp } from "../../core/types";
import { brakeId, rejectHeld } from "../../core/plan/brake";
import { planWith } from "../../core/plan/planner";
import type { VaultEvent } from "../../ports/vault";
import type { LocalObservation } from "../../protocol/messages";
import { Ctx, type ReconcilerDeps } from "./context";
import type { Env } from "./diskJobs";
import { resumeIntents } from "./intents";
import { applyOwnFold } from "./ownFold";
import type { OwnFoldEvent } from "./deps";
import { runPlan, type RunReport } from "./runner";
import { Scanner } from "./scan";
import { recoverTempNames } from "./tempRecovery";
import { ReconcileStore } from "./store";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding (16 random bytes -> 22 chars). */
export function base64url(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
		out += B64URL[b0 >> 2]! + B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
		if (b1 !== undefined) out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
		if (b2 !== undefined) out += B64URL[b2 & 63]!;
	}
	return out;
}

export interface PassReport extends RunReport {
	readonly planned: number;
	/** Ops other than wait / needHash in the plan. */
	readonly actionable: number;
	/** Files left unhashed (disk read failed, in scope or not); the scheduler retries them. */
	readonly unread: number;
	readonly brake: BrakeReport | null;
	readonly openIntents: number;
}

export class Reconciler {
	private lastJobBrake: { id: string; keys: string[] } | null = null;
	/** Ops the planner held for the current brake report (rejectBrake turns them into their opposites). */
	private lastHeld: { id: string; ops: readonly PlannerOp[] } | null = null;
	lastPlan: readonly PlannerOp[] = [];

	private constructor(readonly ctx: Ctx, readonly scan: Scanner, private readonly env: Env) {}

	static async open(deps: ReconcilerDeps): Promise<Reconciler> {
		const store = await ReconcileStore.open(deps.db);
		const ctx = new Ctx(deps, store);
		const scan = new Scanner(ctx);
		scan.load();
		return new Reconciler(ctx, scan, { ctx, scan, deferred: new Map(), heldOverwrites: [], approvedOverwrites: new Set() });
	}

	/** Resolve intents left by a previous session. */
	async start(): Promise<number> {
		return resumeIntents(this.env);
	}

	onObservations(chunk: readonly LocalObservation[], complete: boolean): Promise<void> {
		return this.scan.observe(chunk, complete);
	}

	onVaultEvents(events: readonly VaultEvent[]): void {
		this.scan.onEvents(events);
	}

	/** S1 (§c.13): move synced records forward when own ns ops fold. */
	applyOwnFold(events: readonly OwnFoldEvent[]): Promise<void> {
		return applyOwnFold(this.ctx, events);
	}

	/** Approve a brake report (planner-level or job-level overwrite brake). */
	approveBrake(id: string): void {
		if (this.lastJobBrake && this.lastJobBrake.id === id) {
			for (const k of this.lastJobBrake.keys) this.env.approvedOverwrites.add(k);
			this.lastJobBrake = null;
			return;
		}
		this.ctx.brakeApproval = id;
	}

	/**
	 * Reject a brake report (§f.5): held remote deletes keep the file (synced dropped, re-created as a new doc),
	 * held local deletes re-materialize the remote doc. A job-level overwrite brake is simply not approved.
	 */
	async rejectBrake(id: string): Promise<RunReport | null> {
		if (this.lastJobBrake && this.lastJobBrake.id === id) {
			this.lastJobBrake = null;
			return null;
		}
		const held = this.lastHeld;
		if (!held || held.id !== id) return null;
		this.lastHeld = null;
		this.ctx.brakeApproval = null;
		const view = this.ctx.log.view();
		const ops = rejectHeld(held.ops, (docId) => {
			const e = view.remote.get(docId as DocId);
			return e && e.state === "live" ? e.path : null;
		});
		return runPlan(this.env, ops);
	}

	private freshIds(n: number): DocId[] {
		const out: DocId[] = [];
		for (let i = 0; i < n; i++) out.push(base64url(this.ctx.deps.random.bytes(16)) as DocId);
		return out;
	}

	/** Upper bound of fresh docIds a plan can consume: local files not matching their synced state. */
	private freshNeed(): number {
		const syncedByKey = new Map<PathKey, string>();
		for (const s of this.ctx.store.synced.values()) syncedByKey.set(s.pathKey, s.contentHash);
		let n = 0;
		for (const l of this.ctx.local.values()) if (!l.excluded && syncedByKey.get(l.pathKey) !== l.hash) n++;
		return n;
	}

	/** One reconcile round: intents, hashes, plan, run. */
	async pass(scope: PlanScope = { t: "full" }): Promise<PassReport> {
		const { ctx } = this;
		const openIntents = await resumeIntents(this.env);
		await this.scan.hashPending();
		await recoverTempNames(this.env);
		// S1 for own ops that folded up to now, the awaits above included. Nothing may await between the last
		// drain and the view read: a plan that sees a folded own op before its S1 update writes S from the new
		// entry (a materialize at a suffixed restore path, a loser rename), and the late S1 then moves S back
		// onto the requested path, where another doc's file may be.
		for (let q = ctx.deps.takeOwnFold?.() ?? []; q.length > 0; q = ctx.deps.takeOwnFold?.() ?? []) await applyOwnFold(ctx, q);
		this.scan.dirty.clear();
		ctx.echo.sweep();
		const view = ctx.log.view();
		const freshDocIds = this.freshIds(this.freshNeed());
		// A snapshot: renames observed while this plan runs (its awaits) are for the next plan, not dropped with these.
		const renames = [...ctx.renames];
		const input: PlannerInput = {
			scope, remote: view.remote, remoteByPathKey: view.remoteByPathKey, local: ctx.local, localComplete: ctx.localComplete,
			synced: ctx.store.synced, renames, docsWithPendingBody: view.docsWithPendingBody, nsCoversSeq: view.nsCoversSeq,
			brake: ctx.brake, brakeApproval: ctx.brakeApproval, freshDocIds, deviceLabel: ctx.deps.deviceLabel, nowMs: ctx.now(),
		};
		const plan = planWith(input, {
			pathKey: ctx.pk, nsReady: view.nsReady, divergence: view.divergence, brakeWindow: ctx.window(),
			tzOffsetMinutes: ctx.deps.tzOffsetMinutes?.() ?? 0, remoteTextHash: view.textHash, bodyAppliedSeq: view.appliedSeq, restoreDuty: view.restoreDuty,
			...(ctx.deps.pathBaseKeys ? { pathBaseKeys: ctx.deps.pathBaseKeys } : {}),
		});
		this.lastPlan = plan.ops;
		if (plan.brake) {
			this.lastHeld = { id: plan.brake.id, ops: plan.held };
			ctx.deps.onBrake?.(plan.brake);
		} else {
			if (scope.t === "full") this.lastHeld = null;
			ctx.brakeApproval = null;
		}
		this.env.heldOverwrites.length = 0;
		const run = await runPlan(this.env, plan.ops);
		// Observed renames stay until inference could use them (it is off while ns is not ready).
		if (ctx.localComplete && view.nsReady) {
			const used = new Set(renames);
			ctx.renames = ctx.renames.filter((r) => !used.has(r));
		}
		let brake = plan.brake;
		if (this.env.heldOverwrites.length > 0) {
			const units = this.env.heldOverwrites.map((h) => ({ ops: [], destructive: "overwrite" as const, brakeKey: h.key, path: h.path }));
			const id = brakeId(units);
			this.lastJobBrake = { id, keys: units.map((u) => u.brakeKey) };
			const report: BrakeReport = {
				id, reason: "mass-overwrite", heldCount: units.length, syncedCount: ctx.store.synced.size,
				samplePaths: units.map((u) => u.path).sort().slice(0, 10),
			};
			ctx.deps.onBrake?.(report);
			brake ??= report;
		}
		const actionable = plan.ops.filter((o) => o.op !== "wait" && o.op !== "needHash").length - run.deferred;
		// Out-of-scope read failures count too: nothing else would re-plan them before the periodic full pass.
		const unread = Math.max(this.scan.lastUnread, plan.ops.filter((o) => o.op === "needHash").length);
		return { ...run, planned: plan.ops.length, actionable, unread, brake, openIntents };
	}

	/** Passes until a plan has nothing actionable left or nothing succeeds (bounded). */
	async runUntilQuiet(maxPasses = 12): Promise<{ passes: number; quiet: boolean; last: PassReport }> {
		let last = await this.pass();
		let passes = 1;
		while (passes < maxPasses && last.actionable > 0 && last.ok > 0) {
			last = await this.pass();
			passes++;
		}
		return { passes, quiet: last.actionable === 0 && last.unread === 0, last };
	}
}
