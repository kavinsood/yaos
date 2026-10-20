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
import { generateUserAction, runUserAction, EXTRA_OPS, FULL_OPS, SNAPSHOT_OPS, TokenLedger, type OpWeights, type UserAction } from "./actors";
import { DEFAULT_FAULTS, FaultState, generateFault, type FaultAction, type FaultWeights } from "./faults";
import { activity, checkBlobLiveness, checkCanvas, checkClean, checkConvergence, checkLogCarriesNoBlobs, checkNothingDestroyed, checkQuiet, checkSettings, checkTokens, checkCheckpoints, settingsPrint, type Violation } from "./invariants";
import { VirtualClock } from "./clock";
import { SeededRandom } from "./random";
import { SIM_SETTINGS, SimDevice } from "./device";
import type { EngineSettings } from "../protocol/messages";
import type { EngineTuning } from "../engine/runtime/options";
import { SimNet } from "./net";
import type { SimCheckpointStats } from "./relay";
import type { CaseProfile } from "./vault";
import { checkE2eeLeaks, oracleKeys, onboardSuite1, seededRk } from "./e2ee";
import type { E2eeFaultStats } from "./e2eeFaults";
import { realWorkFor, type RealWork } from "./delayedCrypto";
import type { SimBlobLiveness } from "./blobStore";
import { CANVAS_NAME_POOL, CANVAS_OPS, CanvasWorld, generateCanvasAction, type CanvasAction, type CanvasStats, type CanvasWeights } from "./canvas";
import { canvasMergeStats } from "../engine/reconcile/canvasMerge";

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
	/**
	 * "scaled" (default): the checkpoint world of the seed (checkpointWorld): checkpoint, compaction and candidate
	 * thresholds and timers scaled down and drawn per seed, the relay's segment seal size drawn per seed, a late
	 * joining device in some suite-0 seeds, snapshot uploads in some seeds. "production": DESIGN's thresholds, the
	 * server's 64 KiB seal, no late join, no snapshots (what the sim ran before; it wrote almost no checkpoint).
	 */
	readonly checkpoints?: "scaled" | "production";
	/**
	 * Canvas actions (canvas.ts), drawn from their own RNG stream between main steps (the main plan of a seed does
	 * not depend on them): `rate` actions per main step on average (default 0.3), `ops` their mix, `pool` the canvas
	 * names, `hot` biases record picks to the first records (concurrent edits of the same nodes). null: none.
	 */
	readonly canvas?: CanvasConfig | null;
}

export interface CanvasConfig {
	readonly rate?: number;
	readonly ops?: CanvasWeights;
	readonly pool?: number;
	readonly hot?: boolean;
}

/** The checkpoint side of a run's world (DESIGN §b.5, §d.8, §d.9), a pure function of the seed. */
export interface CheckpointWorld {
	/** Over SIM_TUNING for every device. */
	readonly tuning: Partial<EngineTuning>;
	/** The relay's segment seal threshold (server: 64 KiB); null = the default. */
	readonly sealBytes: number | null;
	/** Device index that joins late (its app starts at plan step `atStep`), suite 0 only. */
	readonly lateJoin: { readonly dev: number; readonly atStep: number } | null;
	/** Per device: recovery snapshots on and uploaded (snap rows), else off. */
	readonly snapshots: readonly boolean[];
}

const PRODUCTION_WORLD = (devices: number): CheckpointWorld => ({ tuning: {}, sealBytes: null, lateJoin: null, snapshots: Array.from({ length: devices }, () => false) });

/** Log-uniform integer in [lo, hi]. */
function logRange(r: SeededRandom, lo: number, hi: number): number {
	return Math.round(lo * (hi / lo) ** r.float());
}

/**
 * With DESIGN's thresholds (256 rows / 1 MiB behind, 30 s idle, 2 min settle, candidates every 1000 vault seqs,
 * 10 min fallback) a 120-step run never writes an ns, cfg or snap checkpoint, and the server's 64 KiB segments never
 * seal, so nothing is collected. Here every threshold is scaled down to a few rows / KiB / seconds and drawn per
 * seed, so runs checkpoint every class often and at different points of the interleaving: hot puts while frames
 * are pending, settle puts after short pauses, fallback devices racing the duty device (CAS conflicts), segments
 * sealed and collected, the stream retired by a checkpoint at lastSeq (server H7).
 */
export function checkpointWorld(cfg: SimConfig): CheckpointWorld {
	const c = full(cfg);
	if (cfg.checkpoints === "production") return PRODUCTION_WORLD(c.devices);
	const r = new SeededRandom(cfg.seed).fork("checkpoints");
	const tuning: Partial<EngineTuning> = {
		compactRows: r.range(3, 60),
		compactBytes: logRange(r, 2 * 1024, 256 * 1024),
		nsCandidateModulus: r.range(2, 40),
		checkpoint: {
			rows: r.range(3, 40),
			bytes: logRange(r, 2 * 1024, 256 * 1024),
			idleMs: r.range(100, 3_000),
			settleMs: r.range(300, 8_000),
			// A third of the seeds: the other devices take over almost at once and race the duty device.
			fallbackMs: r.chance(0.3) ? r.range(0, 400) : r.range(1_000, 30_000),
			nsRows: r.range(2, 24),
			nsBytes: logRange(r, 1024, 64 * 1024),
		},
	};
	const sealBytes = r.chance(0.4) ? null : logRange(r, 256, 16 * 1024);
	const join = r.fork("join");
	const lateJoin = !c.suite1 && join.chance(0.35) ? { dev: c.devices - 1, atStep: join.range(Math.floor(c.steps * 0.25), Math.floor(c.steps * 0.85)) } : null;
	const sr = r.fork("snapshots");
	const on = sr.chance(0.4);
	const snapshots = Array.from({ length: c.devices }, (_, i) => on && (i === 0 || sr.chance(0.7)));
	return { tuning, sealBytes, lateJoin, snapshots };
}

export type Step =
	| { readonly i: number; readonly gapMs: number; readonly user: UserAction }
	| { readonly i: number; readonly gapMs: number; readonly canvas: CanvasAction }
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
		/** Checkpoint coverage: relay puts / GC / served pages, and adoptions / gate disputes on the devices and the oracle. */
		readonly checkpoints: CheckpointStats;
		/** Suite 1: the run's DelayedCrypto counters (strays must be 0: every crypto await went through RealWork). */
		readonly realWork?: RealWork["stats"];
		/** Canvas coverage: actions, merges the engine ran, broken saves, notices, conflict copies. */
		readonly canvas: CanvasRunStats;
	};
}

/** Canvas coverage of a run (stats.canvas). */
export interface CanvasRunStats extends CanvasStats {
	/** canvasMerge.mergeCanvasSides calls in the run, by outcome; `divergent`: base, disk and CRDT all differ (a real 3-way merge). */
	readonly merges: { readonly total: number; readonly divergent: number; readonly clean: number; readonly oneSided: number; readonly conflict: number; readonly identical: number; readonly rejected: number };
	/** canvas-invalid notices on the devices (a broken file or CRDT seen by a merge job). */
	readonly invalidNotices: number;
	/** Canvas conflict copies in the converged vault. */
	readonly conflictCopies: number;
	readonly files: number;
	readonly nodes: number;
}

/** Checkpoint traffic of a run, by stream class (ns, cfg, snap, body, canvas). */
export interface CheckpointStats extends SimCheckpointStats {
	/** Checkpoints the devices adopted in catch-up reads (checkpoint-adopted). */
	readonly adopted: Record<string, number>;
	/** ... of which by a device that already had the stream (union / fold replace: rows below it were collected). */
	readonly adoptedBehind: Record<string, number>;
	/** ... and the oracle (a fresh device at the end of the run). */
	readonly oracleAdopted: Record<string, number>;
	/** Gate disputes (checkpoint-disputed), devices and oracle. */
	readonly disputed: Record<string, number>;
	/** CAS conflicts the writers saw (checkpoint-conflict). */
	readonly conflicts: Record<string, number>;
	/** Fold checkpoints written while the writer had own frames of the stream in its outbox. */
	readonly writtenWithPending: Record<string, number>;
}

function byClass(counts: readonly Readonly<Record<string, number>>[], code: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const c of counts) for (const [k, n] of Object.entries(c)) if (k.startsWith(`${code}:`)) out[k.slice(code.length + 1)] = (out[k.slice(code.length + 1)] ?? 0) + n;
	return out;
}

function checkpointStats(devs: readonly SimDevice[], net: SimNet): CheckpointStats {
	const counts = devs.map((d) => d.diagCounts);
	return {
		...structuredClone(net.relay.ckpt),
		adopted: byClass(counts, "checkpoint-adopted"),
		adoptedBehind: byClass(counts, "checkpoint-adopted-behind"),
		oracleAdopted: byClass([net.oracleDiag], "checkpoint-adopted"),
		disputed: byClass([...counts, net.oracleDiag], "checkpoint-disputed"),
		conflicts: byClass(counts, "checkpoint-conflict"),
		writtenWithPending: byClass(counts, "checkpoint-written-pending"),
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
		canvas: cfg.canvas === null ? null : { rate: cfg.canvas?.rate ?? 0.3, ops: cfg.canvas?.ops ?? CANVAS_OPS, pool: cfg.canvas?.pool ?? CANVAS_NAME_POOL, hot: cfg.canvas?.hot ?? false },
	};
}

/** Settings of a device with recovery snapshots on and uploaded (checkpointWorld.snapshots). */
export const SNAPSHOT_SETTINGS: EngineSettings = { ...RUN_SETTINGS, snapshots: { enabled: true, keepDaily: 2, uploadToBlobStore: true } };

export function generatePlan(cfg: SimConfig): Step[] {
	const c = full(cfg);
	const rng = new SeededRandom(cfg.seed).fork("plan");
	const xr = new SeededRandom(cfg.seed).fork("extra");
	const sr = new SeededRandom(cfg.seed).fork("snapshot-ops");
	const cr = new SeededRandom(cfg.seed).fork("canvas-ops");
	const snaps = checkpointWorld(cfg).snapshots.some((x) => x);
	const plan: Step[] = [];
	let extra = c.steps;
	for (let i = 0; i < c.steps; i++) {
		const gapMs = rng.range(0, c.maxGapMs);
		if (c.faults && rng.chance(c.faultRate)) plan.push({ i, gapMs, fault: generateFault(rng, c.devices, c.faults) });
		else plan.push({ i, gapMs, user: generateUserAction(rng, c.devices, c.ops) });
		if (c.extras > 0 && xr.chance(c.extras)) plan.push({ i: extra++, gapMs: 0, user: generateUserAction(xr, c.devices, EXTRA_OPS) });
		// Manual snapshots, from their own stream (the main and extra plans of a seed do not depend on them).
		if (snaps && sr.chance(0.04)) plan.push({ i: extra++, gapMs: 0, user: generateUserAction(sr, c.devices, SNAPSHOT_OPS) });
		// Canvas actions, from their own stream too: floor(rate) per main step, one more with the fraction's chance.
		if (c.canvas) {
			const n = Math.floor(c.canvas.rate) + (cr.chance(c.canvas.rate % 1) ? 1 : 0);
			for (let k = 0; k < n; k++) plan.push({ i: extra++, gapMs: cr.range(0, Math.floor(c.maxGapMs / 3)), canvas: generateCanvasAction(cr, c.devices, c.canvas.ops, c.canvas.pool) });
		}
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
		const cw = checkpointWorld(cfg);
		const net = new SimNet(clock, { seed: nr.int(0x7fffffff), linkMs: nr.range(5, 60), jitterMs: nr.range(0, 90), ...(cw.sealBytes !== null ? { sealBytes: cw.sealBytes } : {}) });
		const devs = NAMES.slice(0, c.devices).map((name, di) => {
			const dr = world.fork(`dev-${name}`);
			const watch = dr.fork("watch");
			return new SimDevice({
				name, clock, net, profile,
				settings: cw.snapshots[di] ? () => SNAPSHOT_SETTINGS : () => RUN_SETTINGS,
				tuning: cw.tuning,
				mobile: dr.chance(0.3),
				log: cfg.log ? (line) => cfg.log!(name, `${clock.monotonic()} ${line}`) : undefined,
				watcherDelayMs: c.faults ? () => watch.range(0, 400) : undefined,
				pin: c.suite1 ? null : undefined,
			});
		});
		const ledger = new TokenLedger();
		const merges0 = { ...canvasMergeStats };
		const faults = new FaultState(clock, devs, net, ledger, { suite1: c.suite1, weights: c.faults, initialRk: () => seededRk(world.fork("e2ee").fork("rk")) });
		const trace: string[] = [`world ${profile} ${devs.map((d) => `${d.name}:${d.platform.info.os}`).join(" ")}`];
		if (cfg.checkpoints !== "production") {
			const t = cw.tuning;
			trace.push(`checkpoints ${JSON.stringify({ ...t.checkpoint, compactRows: t.compactRows, candidate: t.nsCandidateModulus, seal: cw.sealBytes, join: cw.lateJoin, snapshots: cw.snapshots.map((x) => (x ? 1 : 0)).join("") })}`);
		}

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
		const canvasWorld = new CanvasWorld({ devs, ledger, isDown: (i) => faults.isDown(i), isBackground: (i) => faults.isBackground(i) }, clock, { hot: c.canvas?.hot ?? false, trace: (line) => trace.push(`${clock.monotonic()} ${line}`) });
		// Onboarding canvases (own stream): one on A in half the seeds; B has it too (identical) or its own version.
		if (c.canvas) {
			const ci = new SeededRandom(cfg.seed).fork("canvas-init");
			const a = devs[0];
			const b = devs[1];
			if (a && b && ci.chance(0.5)) {
				const seed = ci.int(0x7fffffff);
				await canvasWorld.run({ t: "cCreate", dev: 0, name: 0, nodes: ci.range(2, 6), seed }, -1);
				const r = ci.float();
				const text = a.vault.textOf("canvas/c0.canvas");
				if (r < 0.3 && text !== null) b.vault.userWrite("canvas/c0.canvas", text);
				else if (r < 0.45) await canvasWorld.run({ t: "cCreate", dev: 1, name: 0, nodes: ci.range(1, 4), seed: ci.int(0x7fffffff) }, -2);
			}
		}
		if (c.suite1) {
			const onboard = await onboardSuite1(clock, devs, world.fork("e2ee"));
			trace.push(...onboard.lines);
			if (!onboard.ok) errors.push({ inv: "e2ee", detail: onboard.lines[onboard.lines.length - 1] ?? "onboarding failed" });
		} else {
			devs.forEach((d, i) => {
				// A late joiner's app has not started yet: down for the actors and faults until it joins.
				if (cw.lateJoin?.dev === i) faults.holdBack(i);
				else void d.start();
			});
		}
		await clock.advance(500);

		const actorWorld = {
			devs, ledger, isDown: (i: number) => faults.isDown(i), isBackground: (i: number) => faults.isBackground(i),
			onUserRename: (i: number, from: string, to: string, step: number) => {
				const d = devs[i];
				if (d && c.canvas) canvasWorld.onUserRename(d, from, to, step);
			},
		};
		let skipped = 0;
		for (const step of plan) {
			await clock.advance(step.gapMs);
			// Main steps only (extra steps are numbered from c.steps up); without one left the heal starts it.
			if (cw.lateJoin && step.i >= cw.lateJoin.atStep && step.i < c.steps && faults.join(cw.lateJoin.dev)) trace.push(`${step.i} join ${devs[cw.lateJoin.dev]?.name}`);
			const line = "user" in step ? await runUserAction(actorWorld, step.user, step.i) : "canvas" in step ? await canvasWorld.run(step.canvas, step.i) : faults.run(step.fault);
			if (line.startsWith("skip")) skipped++;
			else if ("fault" in step && step.fault.t === "idbWipe" && !step.fault.mirrors) canvasWorld.oracle.wiped(devs[step.fault.dev]?.name ?? "", clock.now());
			trace.push(`${step.i} ${line}`);
			faults.afterStep();
			cfg.observe?.(String(step.i), devs, net);
		}

		faults.heal();
		// Broken canvas saves still pending complete now (the app restarted and saved, the writer finished).
		canvasWorld.heal();
		trace.push("heal");
		cfg.observe?.("heal", devs, net);
		const t0 = clock.monotonic();
		let stable = 0;
		let last = "";
		let kicked = false;
		const print = () => `${activity(devs, net)}|${devs.map((d) => `${[...d.vault.snapshot()].join(";")}#${settingsPrint(d)}`).join("|")}`;
		for (let t = 0; t < c.healHorizonMs && stable < 5; t += 1_000) {
			await clock.advance(1_000);
			// Blob store calls outside the blob queue (a snapshot upload's) count too: a stalled one ends by its idle window.
			const idle = net.quiet() && net.blobs.transfers().length === 0 && devs.every((d, i) => !faults.isDown(i) && d.runtime.engine.isReady && (d.vrt?.log.isIdle() ?? false) && (d.vrt?.blobs.queued().length ?? 0) === 0 && (d.vrt?.snaps.idle ?? true) && d.vault.pendingEvents() === 0 && !d.workspace.views_().some((v) => v.isDirty()));
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
			if (net.blobs.transfers().length > 0) why.push(`blob calls in flight ${net.blobs.transfers().length}`);
			devs.forEach((d, i) => {
				if (faults.isDown(i)) why.push(`${d.name} down`);
				else if (!d.runtime.engine.isReady) why.push(`${d.name} not ready`);
				else if (!(d.vrt?.log.isIdle() ?? false)) why.push(`${d.name} log busy`);
				else if (!(d.vrt?.snaps.idle ?? true)) why.push(`${d.name} snapshot job busy`);
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
		canvasWorld.finalize();
		violations.push(...checkConvergence(devs, oracle), ...checkLogCarriesNoBlobs(net, oracle), ...checkSettings(devs), ...checkTokens(devs, ledger), ...checkNothingDestroyed(devs, ledger), ...checkClean(devs, net, (i) => faults.isDown(i)), ...checkBlobLiveness(net), ...checkCheckpoints(devs, net), ...checkCanvas(devs, canvasWorld.oracle));
		violations.push(...(await checkQuiet(clock, devs, net)));

		const snap = [...(devs[0]?.vault.snapshot() ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const tokens = { live: 0, deleted: 0, unacked: 0 };
		for (const e of ledger.entries.values()) tokens[e.state]++;
		const canvasStats = canvasRunStats(canvasWorld, devs, merges0);
		for (const d of devs) d.runtime.stop().catch(() => undefined);
		await clock.advance(5_000);
		return {
			seed: cfg.seed, plan, trace, violations, seededEntropy: seeded, profile,
			digest: digestOf([...trace, ...snap.map(([p, t]) => `${p}=${t}`)]),
			stats: { steps: plan.length, skipped, tokens, files: snap.length, faults: { ...faults.counts }, blobs: structuredClone(net.blobs.liveness), quiesceMs, relayHead: net.relay.head(), crashUnacked: faults.unacked, clobbers: devs.reduce((n, d) => n + d.vault.clobbered.length, 0), checkpoints: checkpointStats(devs, net), ...(faults.e2ee ? { e2ee: faults.e2ee.stats } : {}), ...(c.suite1 ? { realWork: { ...realWorkFor(clock).stats } } : {}), canvas: canvasStats },
		};
	} finally {
		seedEntropy(null);
	}
}

function canvasRunStats(w: CanvasWorld, devs: readonly SimDevice[], merges0: typeof canvasMergeStats): CanvasRunStats {
	const m = canvasMergeStats;
	const files = devs[0] ? [...devs[0].vault.snapshot()].filter(([p]) => p.endsWith(".canvas")) : [];
	let nodes = 0;
	for (const [, text] of files) nodes += (text.match(/"type"\s*:/g) ?? []).length;
	return {
		...structuredClone(w.oracle.stats),
		merges: {
			total: m.merges - merges0.merges, divergent: m.divergent - merges0.divergent, clean: m.clean - merges0.clean, oneSided: m.oneSided - merges0.oneSided,
			conflict: m.conflict - merges0.conflict, identical: m.identical - merges0.identical, rejected: m.rejected - merges0.rejected,
		},
		invalidNotices: devs.reduce((n, d) => n + d.ui.notices.filter((x) => x.code === "canvas-invalid").length, 0),
		conflictCopies: files.filter(([p]) => p.includes(" (conflict")).length,
		files: files.length,
		nodes,
	};
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
