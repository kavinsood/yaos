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
 * Devices run the composed engine over one SimRelay (SimNet) on the run's
 * VirtualClock, each with its own MemStoragePort. Convergence is checked
 * against the relay fold: a fresh observer bootstrapped from the relay.
 */

import { entropyIsSeeded, seedEntropy } from "./seededEntropy";
import * as Y from "yjs";
import { generateUserAction, runUserAction, EXTRA_OPS, FULL_OPS, TokenLedger, type OpWeights, type UserAction } from "./actors";
import { DEFAULT_FAULTS, FaultState, generateFault, type FaultAction, type FaultWeights } from "./faults";
import { activity, checkBlobLiveness, checkClean, checkConvergence, checkLogCarriesNoBlobs, checkNothingDestroyed, checkQuiet, checkSettings, checkTokens, settingsPrint, type Violation } from "./invariants";
import { VirtualClock } from "./clock";
import { SeededRandom } from "./random";
import { SIM_SETTINGS, SimDevice } from "./device";
import type { EngineSettings } from "../protocol/messages";
import { SimNet } from "./net";
import type { CaseProfile } from "./vault";
import { checkE2eeLeaks, oracleKeys, onboardSuite1, seededRk } from "./e2ee";
import type { E2eeFaultStats } from "./e2eeFaults";
import { realWorkFor, type RealWork } from "./delayedCrypto";
import type { SimBlobLiveness } from "./blobStore";

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
	/** Chance per main step of an extra attachment/settings action (own RNG stream). 0 disables. Default 0.15. */
	readonly extras?: number;
	/** Default: chosen by the seed. */
	readonly profile?: CaseProfile;
	readonly initialFiles?: number;
	readonly maxGapMs?: number;
	readonly healHorizonMs?: number;
	/** Debug hook: called after every step ("<i>"), after heal ("heal") and before the checks ("end"). */
	readonly observe?: (label: string, devs: readonly SimDevice[], net: SimNet) => void;
	/** Debug hook: engine diagnostics lines per device. */
	readonly log?: (device: string, line: string) => void;
	/**
	 * "suite1": every device on the real suite-1 adapter over Node WebCrypto behind DelayedCrypto (delayedCrypto.ts):
	 * A creates the vault encrypted and the others join by QR (e2ee.ts), the oracle opens it with their keys, and
	 * the relay leak checks run. Default "none" (the suite-0 pin fixture).
	 */
	readonly crypto?: "none" | "suite1";
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
		/** The blob store's stall / slow models (blobStore.ts): calls caught, ended, completed. */
		readonly blobs: SimBlobLiveness;
		readonly quiesceMs: number;
		readonly relayHead: number;
		/** Tokens app crashes legitimately lost (in no disk, trash or committed storage). */
		readonly crashUnacked: number;
		/** Editor saves that overwrote an unseen external write (Obsidian race, exempt). */
		readonly clobbers: number;
		/** Suite-1 fault outcomes (e2eeFaults.ts), in a suite-1 run with faults. */
		readonly e2ee?: E2eeFaultStats;
		/** Suite 1: the run's DelayedCrypto counters (strays must be 0: every crypto await went through RealWork). */
		readonly realWork?: RealWork["stats"];
	};
}

const NAMES = ["A", "B", "C", "D", "E"];

/** Attachments (through the net's blob store, <= 8 MiB) and settings sync on. */
export const RUN_SETTINGS: EngineSettings = { ...SIM_SETTINGS, syncAttachments: true, maxAttachmentBytes: 8 * 1024 * 1024, syncSettings: true };

function full(cfg: SimConfig) {
	return {
		devices: Math.max(2, Math.min(5, cfg.devices ?? 2)),
		steps: cfg.steps ?? 120,
		faults: cfg.faults === undefined ? null : cfg.faults,
		faultRate: cfg.faultRate ?? 0.15,
		ops: cfg.ops ?? FULL_OPS,
		extras: cfg.extras ?? 0.15,
		initialFiles: cfg.initialFiles ?? 3,
		maxGapMs: cfg.maxGapMs ?? 1_500,
		healHorizonMs: cfg.healHorizonMs ?? 600_000,
		suite1: cfg.crypto === "suite1",
	};
}

export function generatePlan(cfg: SimConfig): Step[] {
	const c = full(cfg);
	const rng = new SeededRandom(cfg.seed).fork("plan");
	const xr = new SeededRandom(cfg.seed).fork("extra");
	const plan: Step[] = [];
	let extra = c.steps;
	for (let i = 0; i < c.steps; i++) {
		const gapMs = rng.range(0, c.maxGapMs);
		if (c.faults && rng.chance(c.faultRate)) plan.push({ i, gapMs, fault: generateFault(rng, c.devices, c.faults) });
		else plan.push({ i, gapMs, user: generateUserAction(rng, c.devices, c.ops) });
		if (c.extras > 0 && xr.chance(c.extras)) plan.push({ i: extra++, gapMs: 0, user: generateUserAction(xr, c.devices, EXTRA_OPS) });
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
		const nr = world.fork("net");
		const net = new SimNet(clock, { seed: nr.int(0x7fffffff), linkMs: nr.range(5, 60), jitterMs: nr.range(0, 90) });
		const devs = NAMES.slice(0, c.devices).map((name) => {
			const dr = world.fork(`dev-${name}`);
			const watch = dr.fork("watch");
			return new SimDevice({
				name, clock, net, profile,
				settings: () => RUN_SETTINGS,
				mobile: dr.chance(0.3),
				log: cfg.log ? (line) => cfg.log!(name, `${clock.monotonic()} ${line}`) : undefined,
				watcherDelayMs: c.faults ? () => watch.range(0, 400) : undefined,
				pin: c.suite1 ? null : undefined,
			});
		});
		const ledger = new TokenLedger();
		const faults = new FaultState(clock, devs, net, ledger, { suite1: c.suite1, weights: c.faults, initialRk: () => seededRk(world.fork("e2ee").fork("rk")) });
		const trace: string[] = [`world ${profile} ${devs.map((d) => `${d.name}:${d.platform.info.os}`).join(" ")}`];

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
		if (c.suite1) {
			const onboard = await onboardSuite1(clock, devs, world.fork("e2ee"));
			trace.push(...onboard.lines);
			if (!onboard.ok) errors.push({ inv: "e2ee", detail: onboard.lines[onboard.lines.length - 1] ?? "onboarding failed" });
		} else for (const d of devs) void d.start();
		await clock.advance(500);

		const actorWorld = { devs, ledger, isDown: (i: number) => faults.isDown(i), isBackground: (i: number) => faults.isBackground(i) };
		let skipped = 0;
		for (const step of plan) {
			await clock.advance(step.gapMs);
			const line = "user" in step ? await runUserAction(actorWorld, step.user, step.i) : faults.run(step.fault);
			if (line.startsWith("skip")) skipped++;
			trace.push(`${step.i} ${line}`);
			faults.afterStep();
			cfg.observe?.(String(step.i), devs, net);
		}

		faults.heal();
		trace.push("heal");
		cfg.observe?.("heal", devs, net);
		const t0 = clock.monotonic();
		let stable = 0;
		let last = "";
		let kicked = false;
		const print = () => `${activity(devs, net)}|${devs.map((d) => `${[...d.vault.snapshot()].join(";")}#${settingsPrint(d)}`).join("|")}`;
		for (let t = 0; t < c.healHorizonMs && stable < 5; t += 1_000) {
			await clock.advance(1_000);
			const idle = net.quiet() && devs.every((d, i) => !faults.isDown(i) && d.runtime.engine.isReady && (d.vrt?.log.isIdle() ?? false) && (d.vrt?.blobs.queued().length ?? 0) === 0 && d.vault.pendingEvents() === 0 && !d.workspace.views_().some((v) => v.isDirty()));
			const fp = print();
			stable = idle && fp === last ? stable + 1 : 0;
			last = fp;
			if (stable >= 5 && !kicked) {
				// Settings edits are detected by full passes (the 5-15 min periodic timer): run one everywhere now.
				kicked = true;
				stable = 0;
				for (const d of devs) d.vrt?.sched.request({ t: "full" }, true);
			}
		}
		const quiesceMs = clock.monotonic() - t0;

		cfg.observe?.("end", devs, net);
		const violations: Violation[] = [...errors];
		if (stable < 5) {
			const why: string[] = [];
			if (!net.relay.quiescent()) why.push("relay busy");
			if (net.relay.pendingCount() > 0) why.push(`relay pending ${net.relay.pendingCount()}`);
			devs.forEach((d, i) => {
				if (faults.isDown(i)) why.push(`${d.name} down`);
				else if (!d.runtime.engine.isReady) why.push(`${d.name} not ready`);
				else if (!(d.vrt?.log.isIdle() ?? false)) why.push(`${d.name} log busy`);
				else if ((d.vrt?.blobs.queued().length ?? 0) > 0) why.push(`${d.name} blob queue ${d.vrt?.blobs.queued().map((q) => `${q.direction}:${q.path}#${q.attempts}`).join(" ")}`);
				if (d.vault.pendingEvents() > 0) why.push(`${d.name} vault events`);
				if (d.workspace.views_().some((v) => v.isDirty())) why.push(`${d.name} dirty view`);
			});
			if (print() !== last) why.push(`activity ${activity(devs, net)}`);
			violations.push({ inv: "clean", detail: `no quiescence within ${c.healHorizonMs}ms: ${why.join(", ") || "flapping"}` });
		}
		if (!(await faults.settle())) violations.push({ inv: "clean", detail: "crash inspections did not finish" });
		const oracle = await net.oracle(120_000, c.suite1 ? oracleKeys(devs) : null);
		if (c.suite1) violations.push(...checkE2eeLeaks(devs, net, ledger).violations, ...(faults.e2ee?.check() ?? []));
		violations.push(...checkConvergence(devs, oracle), ...checkLogCarriesNoBlobs(net, oracle), ...checkSettings(devs), ...checkTokens(devs, ledger), ...checkNothingDestroyed(devs, ledger), ...checkClean(devs, net, (i) => faults.isDown(i)), ...checkBlobLiveness(net));
		violations.push(...(await checkQuiet(clock, devs, net)));

		const snap = [...(devs[0]?.vault.snapshot() ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const tokens = { live: 0, deleted: 0, unacked: 0 };
		for (const e of ledger.entries.values()) tokens[e.state]++;
		for (const d of devs) d.runtime.stop().catch(() => undefined);
		await clock.advance(5_000);
		return {
			seed: cfg.seed, plan, trace, violations, seededEntropy: seeded, profile,
			digest: digestOf([...trace, ...snap.map(([p, t]) => `${p}=${t}`)]),
			stats: { steps: plan.length, skipped, tokens, files: snap.length, faults: { ...faults.counts }, blobs: structuredClone(net.blobs.liveness), quiesceMs, relayHead: net.relay.head(), crashUnacked: faults.unacked, clobbers: devs.reduce((n, d) => n + d.vault.clobbered.length, 0), ...(faults.e2ee ? { e2ee: faults.e2ee.stats } : {}), ...(c.suite1 ? { realWork: { ...realWorkFor(clock).stats } } : {}) },
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
