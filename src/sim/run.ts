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
import { generateUserAction, runUserAction, tokensIn, EXTRA_OPS, FULL_OPS, SNAPSHOT_OPS, STORM_OPS, TokenLedger, type OpWeights, type UserAction } from "./actors";
import { DEFAULT_FAULTS, FaultState, generateFault, type FaultAction, type FaultWeights, type SuspendKillAction, type SuspendRecord } from "./faults";
import { activity, checkBlobLiveness, checkCanvas, checkIdentity, checkClean, checkConvergence, checkLogCarriesNoBlobs, checkNothingDestroyed, checkQuiet, checkSettings, checkTokens, checkCheckpoints, checkBounds, checkFoldDeterminism, checkOutboxAndCursor, checkRetired, clobberedTokens, settingsPrint, vaultTokens, type Violation } from "./invariants";
import { BrakeUser, type BrakeUserStats } from "./brakeUser";
import type { Budgets } from "../core/limits";
import { collectCoverage } from "./coverage";
import { VirtualClock } from "./clock";
import { SeededRandom } from "./random";
import { SIM_SETTINGS, SimDevice } from "./device";
import type { EngineSettings } from "../protocol/messages";
import type { EngineTuning, NsPruneRules } from "../engine/runtime/options";
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
	 * Engine tuning over the checkpoint world's for every device. { skipSettleMs: null, skipMaxDeferMs: null } runs
	 * the device classes' real deferral of skipped streams (FAST_TUNING reads them at once).
	 */
	readonly tuning?: Partial<EngineTuning>;
	/**
	 * Canvas actions (canvas.ts), drawn from their own RNG stream between main steps (the main plan of a seed does
	 * not depend on them): `rate` actions per main step on average (default 0.3), `ops` their mix, `pool` the canvas
	 * names, `hot` biases record picks to the first records (concurrent edits of the same nodes). null: none.
	 */
	readonly canvas?: CanvasConfig | null;
	/**
	 * One forced suspend-kill per run (faults.ts SuspendKillAction) with this budget and save outcome: generatePlan
	 * inserts it, from its own RNG stream ("suspend-kill"), right after (0..2.5 s after) a type / paste step of
	 * the main plan, on that step's device. The main plan is unchanged, so every (budget, save) cell of a seed runs
	 * the same plan (scripts/sim-suspend.mjs). Default: none.
	 */
	readonly suspend?: { readonly budget: number | null; readonly save: "landed" | "lost" };
	/**
	 * Chance per main step of a storm (STORM_OPS: bulk import, mass delete / rename / overwrite, folder move), drawn
	 * from its own stream (the main plan of a seed does not depend on it). Default 0. Brakes they trip are answered
	 * by the simulated user (brakeUser.ts) in every run.
	 */
	readonly storms?: number;
	/**
	 * Draw every device's engine tuning and budgets per seed (tuningWorld) over the checkpoint world's; `tuning`
	 * still overrides. Default false (the fixed FAST_TUNING matrices).
	 */
	readonly randomTuning?: boolean;
	/**
	 * A small ns tombstone cap and prune hysteresis drawn per seed (pruneWorld), set on every device and the oracle
	 * alike (FOLD: devices with different caps would fold differently), so runs prune often and the retired-stream
	 * path (DESIGN §b.5) runs end to end. Default false: production's TOMBSTONE_CAP, which no run reaches.
	 */
	readonly smallPrune?: boolean;
}

export interface CanvasConfig {
	readonly rate?: number;
	readonly ops?: CanvasWeights;
	readonly pool?: number;
	readonly hot?: boolean;
}

/** A suspend-kill event's outcome at the end of the run (SimReport.stats.suspend). */
export interface SuspendOutcome extends Omit<SuspendRecord, "atRisk" | "committedAtEvent"> {
	readonly atRisk: number;
	/** At-risk tokens in the device's committed storage at the event. */
	readonly committedAtEvent: number;
	/** At-risk tokens (not deleted by a later user action) missing from the converged vault. */
	readonly lost: readonly string[];
	/** Lost tokens that were in committed storage at the event, durable at the kill, or ever on a disk (a real violation). */
	readonly genuine: readonly string[];
}

/** One device's drawn tuning (tuningWorld). */
export interface DeviceTuning {
	readonly tuning: Partial<EngineTuning>;
	readonly budgets: Partial<Budgets>;
}

/**
 * Engine tuning and budgets drawn per seed and device (SimConfig.randomTuning), from a "tuning" fork of the seed so
 * no other draw shifts. Ranges stay sane (DESIGN §i: timers between the sim's FAST_TUNING scale and a few seconds,
 * queues from tiny to production) but reach the corners the fixed matrices never do: residency budgets of a few
 * docs (eviction on every switch), one-stream catch-up, live queues that overflow, frames closing at once or late,
 * slow maintenance, full passes every few seconds.
 */
export function tuningWorld(cfg: SimConfig, devices: number): readonly DeviceTuning[] | null {
	if (!cfg.randomTuning) return null;
	const root = new SeededRandom(cfg.seed).fork("tuning");
	return Array.from({ length: devices }, (_, i) => {
		const r = root.fork(`dev-${i}`);
		const skipSettleMs = r.chance(0.6) ? 0 : r.range(0, 2_000);
		// Above the sim relay's group commit (1.5 s max) plus the link, like production's 60 s (see device.ts SIM_TUNING).
		const provisionalAdoptMs = logRange(r, 2_500, 60_000);
		const causalRetries = r.range(1, 3);
		const tuning: Partial<EngineTuning> = {
			frameStretch: +(0.005 * 40 ** r.float()).toFixed(4),
			maintenanceMs: logRange(r, 10, 1_000),
			statusIntervalMs: logRange(r, 20, 500),
			mirrorDebounceMs: logRange(r, 2, 300),
			gapMs: logRange(r, 50, 3_000),
			provisionalAdoptMs,
			// DESIGN §d.6: the re-read window covers 2 x provisionalAdoptMs (causalWindowProblem; SimDevice refuses less).
			causalRetryMs: Math.max(logRange(r, 300, 30_000), Math.ceil((2 * provisionalAdoptMs) / causalRetries)),
			causalRetries,
			readBackoffMs: logRange(r, 20, 2_000),
			readBatchStreams: r.chance(0.25) ? 1 : logRange(r, 2, 128),
			liveBatchRows: logRange(r, 1, 256),
			liveQueueMaxRows: logRange(r, 4, 1_000),
			liveQueueMaxBytes: logRange(r, 4 * 1024, 4 * 1024 * 1024),
			subscribeDebounceMs: logRange(r, 5, 500),
			recentUnboundKeep: r.range(0, 16),
			recentUnboundMs: logRange(r, 1, 60_000),
			reconnectBaseMs: logRange(r, 10, 500),
			skipSettleMs,
			skipMaxDeferMs: skipSettleMs + (r.chance(0.5) ? 0 : r.range(0, 5_000)),
		};
		const budgets: Partial<Budgets> = {
			maxResidentDocs: r.chance(0.5) ? r.range(2, 8) : logRange(r, 8, 400),
			maxResidentBytes: logRange(r, 64 * 1024, 64 * 1024 * 1024),
			catchUpConcurrency: r.range(1, 8),
			maxInflightAppendBytes: logRange(r, 16 * 1024, 1024 * 1024),
			blobBytesInFlight: logRange(r, 256 * 1024, 64 * 1024 * 1024),
			fullReconcileIntervalMs: logRange(r, 3_000, 10 * 60_000),
		};
		return { tuning, budgets };
	});
}

/**
 * The run's ns prune rules (SimConfig.smallPrune), a pure function of the seed: a cap of 3..8 tombstones, pruned by
 * 1..cap-2, so the newest 2+ tombstones always stay (a 120-step run deletes or merges a dozen or so docs). As in
 * production (19000 kept), the newest deletes outlive the restore window: a delete pruned before an editor's
 * edit-beats-delete restore commits trashes that edit (planner "absent (pruned)", BACKLOG PRUNE-RESTORE; a cap that
 * prunes down to 0 loses tokens, seeds 10 and 20). One draw per run, never per device: the cap is a FOLD rule
 * (EngineTuning.nsPrune).
 */
export function pruneWorld(cfg: SimConfig): NsPruneRules | null {
	if (!cfg.smallPrune) return null;
	const r = new SeededRandom(cfg.seed).fork("prune");
	const tombstoneCap = r.range(3, 8);
	return { tombstoneCap, pruneHysteresis: r.range(1, tombstoneCap - 2) };
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
	const compactRows = r.range(3, 60);
	const compactBytes = logRange(r, 2 * 1024, 256 * 1024);
	const nsCandidateModulus = r.range(2, 40);
	const rows = r.range(3, 40);
	const bytes = logRange(r, 2 * 1024, 256 * 1024);
	// Own stream: drawing the hard cap does not shift the draws above or below (recorded seeds still reproduce).
	const hard = r.fork("hard");
	const tuning: Partial<EngineTuning> = {
		compactRows,
		compactBytes,
		nsCandidateModulus,
		checkpoint: {
			rows,
			bytes,
			// Hot puts mid-session, past the hard cap, while a stream is still written.
			hardRows: rows * hard.range(2, 6),
			hardBytes: bytes * hard.range(2, 6),
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
		/**
		 * Subscriptions over the run: b:/c: rows the relay pushed to and skipped for the devices (all sockets), and the
		 * STREAM_SUBSCRIBE sets it accepted.
		 */
		readonly subs: { readonly pushedRows: number; readonly skippedRows: number; readonly subscribes: number };
		/** Brakes the simulated user answered (brakeUser.ts): reports seen by reason, approved, rejected. */
		readonly brakes: BrakeUserStats;
		/** Suite-1 fault outcomes (e2eeFaults.ts), in a suite-1 run with faults. */
		readonly e2ee?: E2eeFaultStats;
		/** Every suspend-kill of the run (faults.ts SuspendKillAction) and what it lost. */
		readonly suspend: readonly SuspendOutcome[];
		/** Checkpoint coverage: relay puts / GC / served pages, and adoptions / gate disputes on the devices and the oracle. */
		readonly checkpoints: CheckpointStats;
		/** Suite 1: the run's DelayedCrypto counters (strays must be 0: every crypto await went through RealWork). */
		readonly realWork?: RealWork["stats"];
		/** Canvas coverage: actions, merges the engine ran, broken saves, notices, conflict copies. */
		readonly canvas: CanvasRunStats;
		/**
		 * Semantic coverage (coverage.ts): ns fold outcomes, planner ops, brakes, diagnostics and host counters the
		 * engines reported, summed over the devices. Every COVERAGE_KEYS key is present, 0 if it never fired.
		 */
		readonly coverage: Readonly<Record<string, number>>;
		/**
		 * Identity per store: stores the devices ran on (one deviceId each; more than the devices after an IDB wipe or a
		 * clone), and the relay registry's answers to registrations (ok, or the refusal).
		 */
		readonly identity: { readonly stores: number; readonly registrations: Readonly<Record<string, number>> };
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
	const stormRng = new SeededRandom(cfg.seed).fork("storms");
	const storms = cfg.storms ?? 0;
	const plan: Step[] = [];
	let extra = c.steps;
	for (let i = 0; i < c.steps; i++) {
		const gapMs = rng.range(0, c.maxGapMs);
		if (c.faults && rng.chance(c.faultRate)) plan.push({ i, gapMs, fault: generateFault(rng, c.devices, c.faults) });
		else plan.push({ i, gapMs, user: generateUserAction(rng, c.devices, c.ops) });
		if (c.extras > 0 && xr.chance(c.extras)) plan.push({ i: extra++, gapMs: 0, user: generateUserAction(xr, c.devices, EXTRA_OPS) });
		// Manual snapshots, from their own stream (the main and extra plans of a seed do not depend on them).
		if (snaps && sr.chance(0.04)) plan.push({ i: extra++, gapMs: 0, user: generateUserAction(sr, c.devices, SNAPSHOT_OPS) });
		if (storms > 0 && stormRng.chance(storms)) plan.push({ i: extra++, gapMs: 0, user: generateUserAction(stormRng, c.devices, STORM_OPS) });
		// Canvas actions, from their own stream too: floor(rate) per main step, one more with the fraction's chance.
		if (c.canvas) {
			const n = Math.floor(c.canvas.rate) + (cr.chance(c.canvas.rate % 1) ? 1 : 0);
			for (let k = 0; k < n; k++) plan.push({ i: extra++, gapMs: cr.range(0, Math.floor(c.maxGapMs / 3)), canvas: generateCanvasAction(cr, c.devices, c.canvas.ops, c.canvas.pool) });
		}
	}
	if (cfg.suspend) {
		const k = new SeededRandom(cfg.seed).fork("suspend-kill");
		const lo = Math.floor(c.steps * 0.2);
		const hi = Math.floor(c.steps * 0.9);
		const typed = plan.filter((s) => "user" in s && (s.user.t === "type" || s.user.t === "paste") && s.i >= lo && s.i < hi);
		const at = typed.length > 0 ? typed[k.int(typed.length)] : plan[k.int(Math.max(1, plan.length))];
		const dev = at && "user" in at ? at.user.dev : k.int(c.devices);
		const f: SuspendKillAction = {
			t: "suspendKill", dev, event: k.pick(["hidden", "pagehide", "freeze"] as const), budget: cfg.suspend.budget, save: cfg.suspend.save,
			downMs: k.range(200, 10_000), durationMs: k.range(100, 30_000),
		};
		// A third right after the keystrokes (still in the binding's 16 ms buffer), a third within 400 ms (an open frame
		// at production frame windows, 100 / 300 ms), a third later (sealed and committed; Obsidian's 2 s save may land).
		const r = k.float();
		const gapMs = r < 1 / 3 ? 0 : r < 2 / 3 ? k.range(1, 400) : k.range(401, 2_500);
		const pos = at ? plan.indexOf(at) + 1 : plan.length;
		plan.splice(pos, 0, { i: extra++, gapMs, fault: f });
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

/**
 * Adoptable outbox records (DESIGN §d.5): another device's provisional frames this one shadows until their commit is
 * seen, else sends after provisionalAdoptMs (60 s in production, drawn up to that by tuningWorld). LogEngine.isIdle
 * does not count them, but invariant 5 wants none, so the heal waits for them to settle. A commit never seen as a row
 * because the read started from a checkpoint over it (randomized-tuning seed 90) now settles through the checkpoint
 * (catchUp.ts); a frame that never commits under its own id and is not under a checkpoint (dropped with the notice
 * missed, refused) still ends only on the timer.
 */
function adoptables(d: SimDevice): number {
	let n = 0;
	for (const r of d.vrt?.log.c.outbox.values() ?? []) if (r.state === "adoptable") n++;
	return n;
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
		const tw = tuningWorld(cfg, c.devices);
		const pw = pruneWorld(cfg);
		const net = new SimNet(clock, { seed: nr.int(0x7fffffff), linkMs: nr.range(5, 60), jitterMs: nr.range(0, 90), ...(cw.sealBytes !== null ? { sealBytes: cw.sealBytes } : {}), nsPrune: pw });
		const devs = NAMES.slice(0, c.devices).map((name, di) => {
			const dr = world.fork(`dev-${name}`);
			const watch = dr.fork("watch");
			return new SimDevice({
				name, clock, net, profile,
				settings: cw.snapshots[di] ? () => SNAPSHOT_SETTINGS : () => RUN_SETTINGS,
				// The prune rules last: the same on every device whatever else is drawn per device (FOLD).
				tuning: { ...cw.tuning, ...(tw?.[di]?.tuning ?? {}), ...cfg.tuning, ...(pw ? { nsPrune: pw } : {}) },
				...(tw?.[di] ? { budgets: tw[di].budgets } : {}),
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
		tw?.forEach((x, i) => trace.push(`tuning ${devs[i]?.name} ${JSON.stringify({ ...x.tuning, ...x.budgets })}`));
		if (pw) trace.push(`prune ${JSON.stringify(pw)}`);

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

		// Invariant 6 is sampled throughout (after every step and heal tick); the first few distinct breaches are kept.
		const bounds = new Map<string, Violation>();
		const sampleBounds = () => {
			if (bounds.size >= 5) return;
			for (const v of checkBounds(devs)) if (bounds.size < 5 && !bounds.has(v.detail)) bounds.set(v.detail, v);
		};
		if (c.canvas) faults.canvasClone = { blocked: (src) => canvasWorld.midSave(src), copiedOver: (dst, others) => canvasWorld.copiedOver(dst, others) };
		const actorWorld = {
			devs, ledger, isDown: (i: number) => faults.isDown(i), isBackground: (i: number) => faults.isBackground(i),
			onUserRename: (i: number, from: string, to: string, step: number) => {
				const d = devs[i];
				if (d && c.canvas) canvasWorld.onUserRename(d, from, to, step);
			},
		};
		const brakeUser = new BrakeUser(clock, devs, new SeededRandom(cfg.seed).fork("brake-user"), (i) => faults.isDown(i), (line) => trace.push(line));
		let skipped = 0;
		for (const step of plan) {
			await clock.advance(step.gapMs);
			// Main steps only (extra steps are numbered from c.steps up); without one left the heal starts it.
			if (cw.lateJoin && step.i >= cw.lateJoin.atStep && step.i < c.steps && faults.join(cw.lateJoin.dev)) trace.push(`${step.i} join ${devs[cw.lateJoin.dev]?.name}`);
			const line = "user" in step ? await runUserAction(actorWorld, step.user, step.i) : "canvas" in step ? await canvasWorld.run(step.canvas, step.i) : faults.run(step.fault);
			if (line.startsWith("skip")) skipped++;
			// A lost store's unsent ops go with it unless its mirrors survive: the successor store re-issues them
			// (identity-per-store §5.2 predecessor recovery). idbLost keeps the mirrors (OS eviction of IndexedDB only).
			else if ("fault" in step && step.fault.t === "idbWipe" && !step.fault.mirrors) canvasWorld.oracle.wiped(devs[step.fault.dev]?.name ?? "", clock.now());
			trace.push(`${step.i} ${line}`);
			faults.afterStep();
			brakeUser.poll();
			sampleBounds();
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
			brakeUser.poll();
			sampleBounds();
			// Blob store calls outside the blob queue (a snapshot upload's) count too: a stalled one ends by its idle window.
			const idle = net.quiet() && net.blobs.transfers().length === 0 && devs.every((d, i) => !faults.isDown(i) && d.runtime.engine.isReady && (d.vrt?.log.isIdle() ?? false) && adoptables(d) === 0 && (d.vrt?.blobs.queued().length ?? 0) === 0 && (d.vrt?.snaps.idle ?? true) && !(d.vrt?.creators.busy() ?? false) && (d.vrt?.log.c.retire.pending ?? 0) === 0 && d.vault.pendingEvents() === 0 && !d.workspace.views_().some((v) => v.isDirty())) && !brakeUser.pending();
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
				else if (adoptables(d) > 0) why.push(`${d.name} ${adoptables(d)} adoptable`);
				else if (!(d.vrt?.snaps.idle ?? true)) why.push(`${d.name} snapshot job busy`);
				else if (d.vrt?.creators.busy()) why.push(`${d.name} waits on a body-less doc's creator`);
				else if ((d.vrt?.log.c.retire.pending ?? 0) > 0) why.push(`${d.name} ${d.vrt?.log.c.retire.pending} dead streams to retire / drop`);
				else if ((d.vrt?.blobs.queued().length ?? 0) > 0) why.push(`${d.name} blob queue ${d.vrt?.blobs.queued().map((q) => `${q.direction}:${q.path}#${q.attempts}`).join(" ")}`);
				if (d.vault.pendingEvents() > 0) why.push(`${d.name} vault events`);
				if (d.workspace.views_().some((v) => v.isDirty())) why.push(`${d.name} dirty view`);
				if (d.vrt?.brake) why.push(`${d.name} brake ${d.vrt.brake.reason} unanswered`);
			});
			if (print() !== last) why.push(`activity ${activity(devs, net)}`);
			violations.push({ inv: "clean", detail: `no quiescence within ${c.healHorizonMs}ms: ${why.join(", ") || "flapping"}` });
		}
		if (!(await faults.settle())) violations.push({ inv: "clean", detail: "crash inspections did not finish" });
		// Before the oracle (a further device on the relay) runs: the devices' own work only.
		let retired: Violation[] | null = null;
		void checkRetired(devs, net, (i) => faults.isDown(i)).then((v) => (retired = v), (e) => (retired = [{ inv: "retired", detail: `check threw: ${String(e)}` }]));
		await clock.runUntil(() => retired !== null, 60_000);
		violations.push(...(retired ?? [{ inv: "retired" as const, detail: "check did not finish" }]));
		const oracle = await net.oracle(120_000, c.suite1 ? oracleKeys(devs) : null);
		if (c.suite1) violations.push(...checkE2eeLeaks(devs, net, ledger).violations, ...(faults.e2ee?.check() ?? []));
		canvasWorld.finalize();
		violations.push(...checkConvergence(devs, oracle), ...checkLogCarriesNoBlobs(net, oracle), ...checkSettings(devs), ...checkTokens(devs, ledger), ...checkNothingDestroyed(devs, ledger), ...checkIdentity(devs), ...checkClean(devs, net, (i) => faults.isDown(i)), ...checkBlobLiveness(net), ...checkCheckpoints(devs, net), ...checkCanvas(devs, canvasWorld.oracle), ...checkOutboxAndCursor(devs, net), ...bounds.values());
		violations.push(...(await checkQuiet(clock, devs, net)));
		// Invariant 4: refold the relay's rows (gates may await crypto on the clock, so it runs).
		let fold: Violation[] | null = null;
		void checkFoldDeterminism(devs, net, new SeededRandom(cfg.seed).fork("fold-determinism")).then((v) => (fold = v), (e) => (fold = [{ inv: "fold", detail: `refold threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}` }]));
		await clock.runUntil(() => fold !== null, 120_000);
		violations.push(...(fold ?? [{ inv: "fold" as const, detail: "refold did not finish" }]));

		const present = vaultTokens(devs);
		for (const t of clobberedTokens(devs)) present.add(t);
		// A lost token that was ever written to a disk (a save that landed, then was overwritten) is a real loss too.
		const everOnDisk = new Set<string>();
		for (const d of devs) for (const v of d.vault.history) for (const t of tokensIn(v.text)) everOnDisk.add(t);
		const suspend: SuspendOutcome[] = faults.suspends.map((rec) => {
			const lost = rec.atRisk.filter((t) => ledger.entries.get(t)?.state !== "deleted" && !present.has(t));
			return {
				...rec, atRisk: rec.atRisk.length, committedAtEvent: rec.committedAtEvent?.size ?? 0, commits: [...rec.commits], lost,
				genuine: lost.filter((t) => (rec.committedAtEvent?.has(t) ?? false) || ledger.entries.get(t)?.state === "live" || everOnDisk.has(t)),
			};
		});
		const snap = [...(devs[0]?.vault.snapshot() ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const tokens = { live: 0, deleted: 0, unacked: 0 };
		for (const e of ledger.entries.values()) tokens[e.state]++;
		const canvasStats = canvasRunStats(canvasWorld, devs, merges0);
		for (const d of devs) d.runtime.stop().catch(() => undefined);
		await clock.advance(5_000);
		return {
			seed: cfg.seed, plan, trace, violations, seededEntropy: seeded, profile,
			digest: digestOf([...trace, ...snap.map(([p, t]) => `${p}=${t}`)]),
			stats: { steps: plan.length, skipped, tokens, subs: subsStats(net, devs), files: snap.length, faults: { ...faults.counts }, blobs: structuredClone(net.blobs.liveness), quiesceMs, relayHead: net.relay.head(), crashUnacked: faults.unacked, clobbers: devs.reduce((n, d) => n + d.vault.clobbered.length, 0), suspend, brakes: brakeUser.stats, checkpoints: checkpointStats(devs, net), coverage: collectCoverage(devs), identity: { stores: devs.reduce((n, d) => n + d.identities.length, 0), registrations: { ...net.identities.counts } }, ...(faults.e2ee ? { e2ee: faults.e2ee.stats } : {}), ...(c.suite1 ? { realWork: { ...realWorkFor(clock).stats } } : {}), canvas: canvasStats },
		};
	} finally {
		seedEntropy(null);
	}
}

function subsStats(net: SimNet, devs: readonly SimDevice[]): SimReport["stats"]["subs"] {
	let pushedRows = 0;
	let skippedRows = 0;
	for (const d of devs) {
		const f = net.relay.fanout(d.deviceId);
		pushedRows += f.pushedRows;
		skippedRows += f.skippedRows;
	}
	return { pushedRows, skippedRows, subscribes: net.relay.counters().subscribes };
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
