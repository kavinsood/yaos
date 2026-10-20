/**
 * The sim's seed matrices (DESIGN §l) over the composed engine and SimRelay, shared by sweeps.sim.test.ts (every
 * seed, `npm run test:sim`) and smoke.test.ts (the first seeds of each, `npm run test:client`). Seeds:
 * YAOS_SIM_SEEDS (default 200, the CI count). A failure prints the seed, its violations and a ddmin-minimized plan
 * to replay with runSim(cfg, plan).
 */
import assert from "node:assert/strict";
import { minimizePlan, runSim, type SimConfig, type SimReport } from "../run";
import { BLOB_FAULTS, DEFAULT_FAULTS, SUBS_FAULTS } from "../faults";
import type { SimBlobLiveness } from "../blobStore";

export const SEEDS = Math.max(1, Number(process.env.YAOS_SIM_SEEDS ?? 200) || 200);

/** Asserts the matrix's faults hit what they target, over its clean runs' stats. */
export type Hits = (name: string, stats: readonly SimReport["stats"][]) => void;

export async function sweep(name: string, base: Omit<SimConfig, "seed">, seeds: number, first = 1, hits?: Hits): Promise<void> {
	const failed: SimReport[] = [];
	const stats: SimReport["stats"][] = [];
	let tokens = 0;
	for (let seed = first; seed < first + seeds; seed++) {
		const r = await runSim({ ...base, seed });
		tokens += r.stats.tokens.live;
		stats.push(r.stats);
		if (r.violations.length > 0) failed.push(r);
	}
	if (failed.length === 0) {
		assert.ok(tokens > seeds * 10, `${name}: the actors did real work (${tokens} live tokens)`);
		hits?.(name, stats);
		return;
	}
	const r0 = failed[0] as SimReport;
	const cfg = { ...base, seed: r0.seed };
	const needle = r0.violations[0]?.detail ?? "";
	const m = await minimizePlan(cfg, r0.plan, (r) => r.violations.some((v) => v.detail === needle), 150);
	assert.fail(
		`${name}: ${failed.length}/${seeds} seeds failed: ${failed.map((r) => r.seed).join(",")}\n` +
			`seed ${r0.seed}:\n  ${r0.violations.slice(0, 6).map((v) => `${v.inv}: ${v.detail}`).join("\n  ")}\n` +
			`minimized (${m.plan.length} steps, cfg ${JSON.stringify({ ...cfg, faults: cfg.faults === BLOB_FAULTS ? "BLOB_FAULTS" : cfg.faults === SUBS_FAULTS ? "SUBS_FAULTS" : cfg.faults ? "DEFAULT_FAULTS" : null })}):\n${JSON.stringify(m.plan)}`,
	);
}

/** The blob store faults reached real transfers: stalls caught calls, both ends fired, slow calls completed. */
export const blobHits: Hits = (name, stats) => {
	const sum = (f: (b: SimBlobLiveness) => number) => stats.reduce((n, s) => n + f(s.blobs), 0);
	const got = {
		stalled: sum((b) => b.stalled.has + b.stalled.put + b.stalled.get), stalledPut: sum((b) => b.stalled.put),
		watchdog: sum((b) => b.watchdog), aborted: sum((b) => b.aborted), slowDone: sum((b) => b.slowDone), slowCut: sum((b) => b.slowCut),
	};
	const ok = got.stalled > 0 && got.stalledPut > 0 && got.watchdog > 0 && got.aborted > 0 && got.slowDone > 0 && got.slowCut === 0;
	assert.ok(ok, `${name}: the blob faults hit transfers ${JSON.stringify(got)}`);
};

/** Subscriptions filtered for real: rows were skipped and pushed, sets were sent, the subscription faults ran. */
export const subsHits: Hits = (name, stats) => {
	const sum = (f: (s: SimReport["stats"]) => number) => stats.reduce((n, s) => n + f(s), 0);
	const got = {
		skipped: sum((s) => s.subs.skippedRows), pushed: sum((s) => s.subs.pushedRows), subscribes: sum((s) => s.subs.subscribes),
		subsLost: sum((s) => s.faults.relaySubsLost ?? 0), restarts: sum((s) => s.faults.relayRestart ?? 0),
	};
	assert.ok(got.skipped > 0 && got.pushed > 0 && got.subscribes > 0 && got.subsLost > 0 && got.restarts > 0, `${name}: subscriptions at work ${JSON.stringify(got)}`);
};

export interface Matrix {
	readonly name: string;
	readonly base: Omit<SimConfig, "seed">;
	readonly seeds: number;
	/** Seeds 1..smoke run in `npm run test:client`. */
	readonly smoke: number;
	/** Rough seconds per seed on one core (test:sim schedules the costliest units first). */
	readonly cost: number;
	/** Checked over a whole sweep (one unit), not on the smoke seeds: a seed or two need not hit every fault. */
	readonly hits?: Hits;
}

const part = (d: number): number => Math.max(1, Math.ceil(SEEDS / d));

export const MATRICES: readonly Matrix[] = [
	{ name: "2 devices, no faults", base: { devices: 2, faults: null }, seeds: SEEDS, smoke: 2, cost: 1.4 },
	{ name: "3 devices, seeded faults", base: { devices: 3, faults: DEFAULT_FAULTS }, seeds: SEEDS, smoke: 2, cost: 1.9 },
	{ name: "5 devices, seeded faults", base: { devices: 5, faults: DEFAULT_FAULTS }, seeds: part(4), smoke: 1, cost: 3.1 },
	{ name: "2 devices, fault-heavy", base: { devices: 2, faults: DEFAULT_FAULTS, faultRate: 0.35 }, seeds: part(4), smoke: 2, cost: 1.4 },
	{ name: "3 devices, subscription churn faults", base: { devices: 3, faults: SUBS_FAULTS, faultRate: 0.3 }, seeds: part(10), smoke: 1, cost: 3.3, hits: subsHits },
	// The device classes' own deferral of skipped streams (desktop 5 s / 30 s, phone 150 s / 10 min): quiescence waits it out.
	{ name: "3 devices, real skip deferral", base: { devices: 3, faults: SUBS_FAULTS, faultRate: 0.2, tuning: { skipSettleMs: null, skipMaxDeferMs: null } }, seeds: part(20), smoke: 1, cost: 3.4, hits: subsHits },
	{ name: "3 devices, blob stall/slow faults", base: { devices: 3, faults: BLOB_FAULTS, faultRate: 0.3 }, seeds: part(10), smoke: 1, cost: 6.6, hits: blobHits },
];
