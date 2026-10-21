#!/usr/bin/env node
// Soak runner for the deterministic sim (src/sim/run.ts): runs random seeds under randomly drawn profiles until a
// time budget runs out (swarm testing: each run enables a random subset of fault kinds with scaled weights).
// The whole soak is reproducible from its master seed (logged at start): the same master seed draws the same
// sequence of (seed, config) pairs; how many of them run depends on the time budget.
//
// Usage: npm run sim:soak -- [--minutes N] [--master-seed S] [--out DIR] [--require-coverage] [--max-runs N]
//                             [--coverage-out FILE]
//        npm run sim:soak -- --check-coverage FILE...   (sum --coverage-out files of parallel soaks; exit 1 if a key
//                             outside COVERAGE_OPTIONAL summed to 0)
// Env:   YAOS_SOAK_MINUTES, YAOS_SOAK_MASTER_SEED (same as the flags)
// On a violation: ddmin-minimizes the plan and writes DIR/<seed>-<n>.json {seed, config, violations, minimizedPlan,
// plan, gitSha, masterSeed}; replay with `npm run sim:replay -- DIR/<file>.json`. Exit 1 if any run failed (or, with
// --require-coverage, if a stats.coverage counter outside COVERAGE_OPTIONAL summed to 0 over the soak).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Coverage keys a soak may leave at 0 (--require-coverage, --check-coverage): a conflict-copy name taken between pick
 * and write (only a third-party writer racing the device's label and minute), own frames the relay refuses for good,
 * and the upgrade halt (a newer build's upgradeRules: upgradeHalt.test.ts, it stops the run's quiescence by design).
 * ns pruning and retired streams (ns.pruned, diag.checkpoint-retired, diag.retire-*) are required: the small-cap draw
 * below makes them fire in every process.
 */
const COVERAGE_OPTIONAL = new Set(["conflict.path-taken", "diag.frame-poisoned", "diag.upgrade-required"]);

function args(argv) {
	const o = { minutes: Number(process.env.YAOS_SOAK_MINUTES ?? 2), masterSeed: process.env.YAOS_SOAK_MASTER_SEED, out: "sim-failures", requireCoverage: false, maxRuns: Infinity, coverageOut: null, checkCoverage: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--minutes") o.minutes = Number(argv[++i]);
		else if (a === "--master-seed") o.masterSeed = argv[++i];
		else if (a === "--out") o.out = argv[++i];
		else if (a === "--max-runs") o.maxRuns = Number(argv[++i]);
		else if (a === "--require-coverage") o.requireCoverage = true;
		else if (a === "--coverage-out") o.coverageOut = argv[++i];
		else if (a === "--check-coverage") o.checkCoverage = argv.slice(i + 1);
		else throw new Error(`sim-soak: unknown argument ${a}`);
		if (o.checkCoverage) break;
	}
	if (!(o.minutes > 0)) throw new Error("sim-soak: --minutes must be > 0");
	o.masterSeed = o.masterSeed === undefined || o.masterSeed === "" ? Math.floor(Math.random() * 2 ** 31) : Number(o.masterSeed);
	return o;
}

/** jiti/register exposes a TS module's named exports under `default` when imported from an .mjs. */
async function load(rel) {
	const m = await import(new URL(rel, import.meta.url).href);
	return m.default && typeof m.default === "object" ? { ...m.default, ...m } : m;
}

function gitSha() {
	try { return execSync("git rev-parse HEAD", { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

/** Log-uniform float in [lo, hi]. */
const logf = (r, lo, hi) => lo * (hi / lo) ** r.float();

/** One run's profile, drawn from the master stream. Only real SimConfig knobs; JSON-serializable. */
function drawConfig(r, F, C, A) {
	const seed = r.range(1, 2 ** 31 - 1);
	const bases = [
		["none", null, 2], ["DEFAULT_FAULTS", F.DEFAULT_FAULTS, 4], ["BLOB_FAULTS", F.BLOB_FAULTS, 2], ["SUBS_FAULTS", F.SUBS_FAULTS, 2],
		["E2EE_FAULTS", F.E2EE_FAULTS, 1], ["CANVAS_FAULTS", F.CANVAS_FAULTS, 1], ["SUSPEND_FAULTS", F.SUSPEND_FAULTS, 1],
		// identity-per-store: copied vault folders (clone) and a synced plugin folder (syncedConfig).
		["CLONE_FAULTS", F.CLONE_FAULTS, 1],
		// Targeted relay faults (drops between PROVISIONAL / COMMIT_NOTICE / receipts, lost live messages, failed group
		// commits); a hostile / buggy member device (suite 0 or 1); conflict copies (huge notes, a crash mid copy); the
		// conflict-flood brake (a store lost under a vault-wide rewrite, storms for a vault of hundreds of notes).
		["RELAY_FAULTS", F.RELAY_FAULTS, 1.5], ["HOSTILE_FAULTS", F.HOSTILE_FAULTS, 1.5], ["CONFLICT_FAULTS", F.CONFLICT_FAULTS, 1.5],
		["FLOOD_FAULTS", F.FLOOD_FAULTS, 0.8],
	];
	let x = r.float() * bases.reduce((s, b) => s + b[2], 0);
	let base = bases[0];
	for (const b of bases) { x -= b[2]; if (x < 0) { base = b; break; } }
	const [baseName, baseWeights] = base;
	const cfg = { seed, devices: r.range(2, 5) };
	if (baseName === "E2EE_FAULTS" || (baseName === "HOSTILE_FAULTS" && r.chance(0.5))) cfg.crypto = "suite1";
	const long = baseName !== "FLOOD_FAULTS" && r.chance(0.35);
	cfg.steps = long ? r.range(200, 400) : r.range(30, 120);
	let swarm = null;
	if (baseWeights) {
		// Swarm: keep each enabled kind with p = 0.6 (at least one), scale each kept weight log-uniformly 0.25x..4x.
		const kinds = Object.keys(baseWeights).filter((k) => baseWeights[k] > 0);
		const kept = kinds.filter(() => r.chance(0.6));
		if (kept.length === 0) kept.push(kinds[r.int(kinds.length)]);
		const faults = {};
		for (const k of Object.keys(baseWeights)) faults[k] = kept.includes(k) ? +(baseWeights[k] * logf(r, 0.25, 4)).toFixed(3) : 0;
		cfg.faults = faults;
		cfg.faultRate = +(long ? logf(r, 0.05, 0.25) : logf(r, 0.15, 0.45)).toFixed(3);
		swarm = kept;
	} else cfg.faults = null;
	// Drawn after everything above, so the earlier draws of a master seed keep their values.
	// Randomized engine tuning / budgets per device (run.ts tuningWorld) in half the runs.
	if (r.chance(0.5)) cfg.randomTuning = true;
	// Storms (bulk import, mass delete / rename / overwrite, folder move; brakes answered by the sim user) in a
	// quarter of the runs, short ones only (hundreds of files on every device).
	if (!long && r.chance(0.25)) cfg.storms = +logf(r, 0.02, 0.08).toFixed(3);
	// The flood needs a vault over BRAKE_MAX_CONFLICT_COPIES notes: heavy storms, enough steps to import them.
	if (baseName === "FLOOD_FAULTS") {
		cfg.storms = +logf(r, 0.1, 0.2).toFixed(3);
		cfg.steps = r.range(120, 200);
	}
	// Huge notes and same-labelled devices with the conflict faults; delete / restore races in a share of all runs;
	// the user's attachment clean-up mid-sync (a grace the run outlives) in another.
	if (baseName === "CONFLICT_FAULTS") {
		cfg.ops = A.BIG_OPS;
		if (r.chance(0.5)) cfg.sameLabels = true;
	} else if (r.chance(0.15)) cfg.ops = A.RACE_OPS;
	if (r.chance(0.15)) {
		cfg.cleanups = +logf(r, 0.02, 0.1).toFixed(3);
		cfg.tuning = { blobGcGraceMs: r.range(10_000, 120_000) };
	}
	// CANVAS_FAULTS (long offline periods): mostly concurrent edits of the same two canvases, as testkit/sweep.ts's hot
	// canvas matrix (every other run keeps run.ts's default canvas rate).
	if (baseName === "CANVAS_FAULTS") cfg.canvas = { rate: +logf(r, 1, 4).toFixed(2), ops: C.CANVAS_HOT_OPS, pool: 2, hot: true };
	// A small tombstone cap (run.ts pruneWorld: 3..8, one draw per run from its seed, the same on every device) in a
	// fifth of the runs: ns pruning, retired checkpoints of dead streams and their local drop.
	if (r.chance(0.2)) cfg.smallPrune = true;
	return { cfg, label: `${baseName}${swarm ? `[${swarm.length}]` : ""} ${long ? "long" : "short"} d${cfg.devices} s${cfg.steps}${cfg.crypto ? " suite1" : ""}${cfg.randomTuning ? " tuned" : ""}${cfg.storms ? ` storms${cfg.storms}` : ""}${cfg.canvas ? " hot-canvas" : ""}${cfg.ops === A.RACE_OPS ? " races" : cfg.ops === A.BIG_OPS ? " big" : ""}${cfg.sameLabels ? " same-labels" : ""}${cfg.cleanups ? ` cleanups${cfg.cleanups}` : ""}${cfg.smallPrune ? " small-cap" : ""}` };
}

/** Keys that summed to 0 and are not optional. */
function missing(coverage) {
	return [...coverage.keys()].sort().filter((k) => coverage.get(k) === 0 && !COVERAGE_OPTIONAL.has(k));
}

function checkCoverage(files) {
	const sum = new Map();
	let runs = 0;
	for (const f of files) {
		const c = JSON.parse(readFileSync(f, "utf8"));
		runs += c.runs;
		for (const [k, v] of Object.entries(c.coverage)) sum.set(k, (sum.get(k) ?? 0) + v);
	}
	const zero = missing(sum);
	console.log(`sim-soak coverage: ${files.length} soaks, ${runs} runs, ${sum.size} keys`);
	for (const k of [...sum.keys()].sort()) console.log(`  ${k}: ${sum.get(k)}${COVERAGE_OPTIONAL.has(k) ? " (optional)" : ""}`);
	if (zero.length > 0) console.log(`coverage keys never hit: ${zero.join(", ")}`);
	process.exit(sum.size === 0 || zero.length > 0 ? 1 : 0);
}

async function main() {
	const o = args(process.argv.slice(2));
	if (o.checkCoverage) return checkCoverage(o.checkCoverage);
	const { runSim, minimizePlan } = await load("../src/sim/run.ts");
	const F = await load("../src/sim/faults.ts");
	const C = await load("../src/sim/canvas.ts");
	const A = await load("../src/sim/actors.ts");
	const { SeededRandom } = await load("../src/sim/random.ts");
	const sha = gitSha();
	const out = resolve(ROOT, o.out);
	const master = new SeededRandom(o.masterSeed);
	const deadline = Date.now() + o.minutes * 60_000;
	console.log(`sim-soak: master seed ${o.masterSeed} (reproduce: --master-seed ${o.masterSeed}), ${o.minutes} min, git ${sha.slice(0, 12)}`);

	const coverage = new Map();
	let runs = 0, withCoverage = 0;
	const failures = [];
	const t0 = Date.now();
	while (Date.now() < deadline && runs < o.maxRuns) {
		const { cfg, label } = drawConfig(master, F, C, A);
		runs++;
		let r;
		try {
			r = await runSim(cfg);
		} catch (e) {
			r = { seed: cfg.seed, plan: [], violations: [{ inv: "crash", detail: String(e?.stack ?? e) }], stats: {} };
		}
		const cov = r.stats?.coverage;
		if (cov && typeof cov === "object") {
			withCoverage++;
			for (const [k, v] of Object.entries(cov)) coverage.set(k, (coverage.get(k) ?? 0) + (Number(v) || 0));
		}
		if (r.violations.length === 0) continue;
		console.log(`FAIL #${runs} seed ${cfg.seed} (${label}): ${r.violations.slice(0, 3).map((v) => `${v.inv}: ${v.detail.split("\n")[0]}`).join(" | ")}`);
		let minimizedPlan = r.plan;
		if (r.plan.length > 0) {
			const needle = r.violations[0].detail;
			try {
				minimizedPlan = (await minimizePlan(cfg, r.plan, (x) => x.violations.some((v) => v.detail === needle), 150)).plan;
			} catch (e) {
				console.log(`  minimize failed: ${e}`);
			}
		}
		mkdirSync(out, { recursive: true });
		const file = join(out, `${cfg.seed}-${runs}.json`);
		writeFileSync(file, JSON.stringify({ seed: cfg.seed, config: cfg, violations: r.violations, minimizedPlan, plan: r.plan, gitSha: sha, masterSeed: o.masterSeed, label }, null, "\t") + "\n");
		console.log(`  minimized ${r.plan.length} -> ${minimizedPlan.length} steps: ${file}`);
		failures.push(file);
	}

	const secs = ((Date.now() - t0) / 1000).toFixed(0);
	console.log(`\nsim-soak: ${runs} runs in ${secs}s, ${failures.length} failed (master seed ${o.masterSeed})`);
	for (const f of failures) console.log(`  ${f}`);
	let coverageBad = false;
	if (withCoverage === 0) console.log("coverage: no report carried stats.coverage");
	else {
		const keys = [...coverage.keys()].sort();
		console.log(`coverage (summed over ${withCoverage}/${runs} runs):`);
		for (const k of keys) console.log(`  ${k}: ${coverage.get(k)}`);
		const zero = keys.filter((k) => coverage.get(k) === 0);
		if (zero.length > 0) console.log(`coverage keys never hit: ${zero.join(", ")}`);
		if (missing(coverage).length > 0) coverageBad = o.requireCoverage;
	}
	if (o.requireCoverage && withCoverage === 0) coverageBad = true;
	if (o.coverageOut) writeFileSync(resolve(ROOT, o.coverageOut), JSON.stringify({ masterSeed: o.masterSeed, runs: withCoverage, coverage: Object.fromEntries(coverage) }) + "\n");
	process.exit(failures.length > 0 || coverageBad ? 1 : 0);
}

await main();
