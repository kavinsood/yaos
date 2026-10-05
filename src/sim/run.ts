/**
 * Seeded, reproducible simulation runner (DESIGN §l).
 *
 *   runSim(config)        world from the seed, plan from the seed, run, heal,
 *                         quiesce, check invariants -> SimReport (trace + digest)
 *   runSim(config, plan)  replay an explicit plan (the minimizer's input)
 *   minimizePlan(...)     delta-debugging (ddmin) over plan steps
 *
 * A plan is a pure function of (seed, config): actions carry picks resolved
 * against state at run time (actors.ts). Yjs clientIDs are seeded through
 * seededEntropy (imported first, before anything loads yjs), so the same seed
 * gives the same trace, the same converged bytes and the same digest.
 *
 * INTEGRATION: SimDevice switches to WP-C's engine over WP-A's SimRelay /
 * MemStoragePort; the hub-based convergence check becomes the relay fold check.
 */

import { entropyIsSeeded, seedEntropy } from "./__standins__/seededEntropy";
import * as Y from "yjs";
import { StandinHub } from "../engine/__standins__/hub";
import { generateUserAction, runUserAction, STANDIN_OPS, TokenLedger, type OpWeights, type UserAction } from "./actors";
import { DEFAULT_FAULTS, FaultState, generateFault, type FaultAction, type FaultWeights } from "./faults";
import { activity, checkClean, checkConvergence, checkNothingDestroyed, checkQuiet, checkTokens, type Violation } from "./invariants";
import { VirtualClock } from "./__standins__/clock";
import { SeededRandom } from "./__standins__/random";
import { SimDevice } from "./device";
import type { CaseProfile } from "./vault";

export interface SimConfig {
	readonly seed: number;
	/** 2..5 (DESIGN §l.1). */
	readonly devices?: number;
	readonly steps?: number;
	/** null: no faults. */
	readonly faults?: FaultWeights | null;
	/** Fraction of steps that are faults (when faults are on). */
	readonly faultRate?: number;
	readonly ops?: OpWeights;
	/** Default: chosen by the seed. */
	readonly profile?: CaseProfile;
	readonly initialFiles?: number;
	readonly maxGapMs?: number;
	readonly healHorizonMs?: number;
	/** Debug hook: called after every step ("<i>"), after heal ("heal") and before the checks ("end"). */
	readonly observe?: (label: string, devs: readonly SimDevice[], hub: StandinHub) => void;
}

export type Step =
	| { readonly i: number; readonly gapMs: number; readonly user: UserAction }
	| { readonly i: number; readonly gapMs: number; readonly fault: FaultAction };

export interface SimReport {
	readonly seed: number;
	readonly plan: readonly Step[];
	readonly trace: readonly string[];
	readonly violations: readonly Violation[];
	readonly digest: string;
	readonly seededEntropy: boolean;
	readonly profile: CaseProfile;
	readonly stats: {
		readonly steps: number;
		readonly skipped: number;
		readonly tokens: { readonly live: number; readonly deleted: number; readonly unacked: number };
		readonly files: number;
		readonly faults: Readonly<Record<string, number>>;
		readonly quiesceMs: number;
		readonly hubPublished: number;
		/** Editor saves that overwrote an unseen external write (Obsidian race, exempt). */
		readonly clobbers: number;
	};
}

const NAMES = ["A", "B", "C", "D", "E"];

function full(cfg: SimConfig) {
	return {
		devices: Math.max(2, Math.min(5, cfg.devices ?? 2)),
		steps: cfg.steps ?? 120,
		faults: cfg.faults === undefined ? null : cfg.faults,
		faultRate: cfg.faultRate ?? 0.15,
		ops: cfg.ops ?? STANDIN_OPS,
		initialFiles: cfg.initialFiles ?? 3,
		maxGapMs: cfg.maxGapMs ?? 1_500,
		healHorizonMs: cfg.healHorizonMs ?? 600_000,
	};
}

export function generatePlan(cfg: SimConfig): Step[] {
	const c = full(cfg);
	const rng = new SeededRandom(cfg.seed).fork("plan");
	const plan: Step[] = [];
	for (let i = 0; i < c.steps; i++) {
		const gapMs = rng.range(0, c.maxGapMs);
		if (c.faults && rng.chance(c.faultRate)) plan.push({ i, gapMs, fault: generateFault(rng, c.devices, c.faults) });
		else plan.push({ i, gapMs, user: generateUserAction(rng, c.devices, c.ops) });
	}
	return plan;
}

function fnv(s: string, h: number): number {
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
	return h;
}

function digestOf(parts: readonly string[]): string {
	const s = parts.join("\u0000");
	return fnv(s, 0x811c9dc5).toString(16).padStart(8, "0") + fnv(s, 0x01000193).toString(16).padStart(8, "0");
}

export async function runSim(cfg: SimConfig, explicitPlan?: readonly Step[]): Promise<SimReport> {
	const c = full(cfg);
	const plan = explicitPlan ?? generatePlan(cfg);
	seedEntropy(cfg.seed);
	try {
		const seeded = entropyIsSeeded(() => new Y.Doc().clientID);
		seedEntropy(cfg.seed);
		const world = new SeededRandom(cfg.seed).fork("world");
		const profile: CaseProfile = cfg.profile ?? (world.chance(0.5) ? "case-insensitive" : "case-sensitive");
		const clock = new VirtualClock();
		const errors: Violation[] = [];
		clock.onError = (e, label) => {
			if (errors.length < 5) errors.push({ inv: "clean", detail: `timer ${label} threw: ${e instanceof Error ? e.message : String(e)}` });
		};
		const net = world.fork("net");
		const hub = new StandinHub(clock, () => net.range(5, 150));
		const devs = NAMES.slice(0, c.devices).map((name) => {
			const dr = world.fork(`dev-${name}`);
			const watch = dr.fork("watch");
			return new SimDevice({
				name, clock, hub, profile,
				mobile: dr.chance(0.3),
				persistDelayMs: c.faults ? dr.pick([0, 0, 300, 2_000]) : 0,
				watcherDelayMs: c.faults ? () => watch.range(0, 400) : undefined,
			});
		});
		const ledger = new TokenLedger();
		const faults = new FaultState(clock, devs, hub, ledger);
		const trace: string[] = [`world ${profile} ${devs.map((d) => `${d.name}:${d.platform.info.os}/persist=${d.opts.persistDelayMs}`).join(" ")}`];

		// Onboarding: files on A; some also on B (identical, or a different version).
		const init = world.fork("init");
		for (let k = 0; k < c.initialFiles; k++) {
			const path = `notes/seed${k}.md`;
			const a = devs[0];
			const b = devs[1];
			if (!a || !b) break;
			a.vault.userWrite(path, `seed ${k} [Z.${k}]\n`);
			ledger.add(`[Z.${k}]`, "Z", -1, "seed");
			const r = init.float();
			if (r < 0.3) b.vault.userWrite(path, `seed ${k} [Z.${k}]\n`);
			else if (r < 0.4) {
				b.vault.userWrite(path, `seed ${k} variant [Y.${k}]\n`);
				ledger.add(`[Y.${k}]`, "Y", -1, "seed-variant");
			}
		}
		for (const d of devs) void d.start();
		await clock.advance(500);

		const actorWorld = { devs, ledger, isDown: (i: number) => faults.isDown(i) };
		let skipped = 0;
		for (const step of plan) {
			await clock.advance(step.gapMs);
			const line = "user" in step ? await runUserAction(actorWorld, step.user, step.i) : faults.run(step.fault);
			if (line.startsWith("skip")) skipped++;
			trace.push(`${step.i} ${line}`);
			cfg.observe?.(String(step.i), devs, hub);
		}

		faults.heal();
		trace.push("heal");
		cfg.observe?.("heal", devs, hub);
		const t0 = clock.monotonic();
		let stable = 0;
		let last = "";
		for (let t = 0; t < c.healHorizonMs && stable < 5; t += 1_000) {
			await clock.advance(1_000);
			const idle = hub.quiet() && devs.every((d, i) => !faults.isDown(i) && d.runtime.engine.isReady && d.vault.pendingEvents() === 0 && !d.workspace.views_().some((v) => v.isDirty()));
			const fp = `${activity(devs, hub)}|${devs.map((d) => [...d.vault.snapshot()].join(";")).join("|")}`;
			stable = idle && fp === last ? stable + 1 : 0;
			last = fp;
		}
		const quiesceMs = clock.monotonic() - t0;

		cfg.observe?.("end", devs, hub);
		const violations: Violation[] = [...errors];
		if (stable < 5) violations.push({ inv: "clean", detail: `no quiescence within ${c.healHorizonMs}ms` });
		violations.push(...checkConvergence(devs, hub), ...checkTokens(devs, ledger), ...checkNothingDestroyed(devs, ledger), ...checkClean(devs, hub, (i) => faults.isDown(i)));
		violations.push(...(await checkQuiet(clock, devs, hub)));

		const snap = [...(devs[0]?.vault.snapshot() ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const tokens = { live: 0, deleted: 0, unacked: 0 };
		for (const e of ledger.entries.values()) tokens[e.state]++;
		for (const d of devs) d.runtime.stop().catch(() => undefined);
		await clock.advance(5_000);
		return {
			seed: cfg.seed, plan, trace, violations, seededEntropy: seeded, profile,
			digest: digestOf([...trace, ...snap.map(([p, t]) => `${p}=${t}`)]),
			stats: { steps: plan.length, skipped, tokens, files: snap.length, faults: { ...faults.counts }, quiesceMs, hubPublished: hub.stats.published, clobbers: devs.reduce((n, d) => n + d.vault.clobbered.length, 0) },
		};
	} finally {
		seedEntropy(null);
	}
}

/** ddmin over plan steps: the smallest plan (within `maxRuns`) for which `fails(report)` still holds. */
export async function minimizePlan(cfg: SimConfig, plan: readonly Step[], fails: (r: SimReport) => boolean, maxRuns = 200): Promise<{ plan: Step[]; runs: number }> {
	let cur = [...plan];
	let runs = 0;
	let n = 2;
	const test = async (p: Step[]) => {
		runs++;
		return fails(await runSim(cfg, p));
	};
	while (cur.length >= 1 && runs < maxRuns) {
		const size = Math.ceil(cur.length / n);
		const chunks: Step[][] = [];
		for (let s = 0; s < cur.length; s += size) chunks.push(cur.slice(s, s + size));
		let reduced = false;
		for (const ch of chunks) {
			if (runs >= maxRuns) break;
			if (ch.length < cur.length && (await test(ch))) {
				cur = ch;
				n = 2;
				reduced = true;
				break;
			}
		}
		if (!reduced && chunks.length > 2) {
			for (let k = 0; k < chunks.length && runs < maxRuns; k++) {
				const rest = chunks.filter((_, j) => j !== k).flat();
				if (await test(rest)) {
					cur = rest;
					n = Math.max(n - 1, 2);
					reduced = true;
					break;
				}
			}
		}
		if (!reduced) {
			if (n >= cur.length) break;
			n = Math.min(cur.length, n * 2);
		}
	}
	return { plan: cur, runs };
}
