#!/usr/bin/env node
// Soak runner for the deterministic sim (src/sim/run.ts): runs random seeds under randomly drawn profiles until a
// time budget runs out (swarm testing: each run enables a random subset of fault kinds with scaled weights).
// The whole soak is reproducible from its master seed (logged at start): the same master seed draws the same
// sequence of (seed, config) pairs; how many of them run depends on the time budget.
//
// Usage: npm run sim:soak -- [--minutes N] [--master-seed S] [--out DIR] [--require-coverage] [--max-runs N]
// Env:   YAOS_SOAK_MINUTES, YAOS_SOAK_MASTER_SEED (same as the flags)
// On a violation: ddmin-minimizes the plan and writes DIR/<seed>-<n>.json {seed, config, violations, minimizedPlan,
// plan, gitSha, masterSeed}; replay with `npm run sim:replay -- DIR/<file>.json`. Exit 1 if any run failed (or, with
// --require-coverage, if any stats.coverage counter summed to 0 over the soak).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function args(argv) {
	const o = { minutes: Number(process.env.YAOS_SOAK_MINUTES ?? 2), masterSeed: process.env.YAOS_SOAK_MASTER_SEED, out: "sim-failures", requireCoverage: false, maxRuns: Infinity };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--minutes") o.minutes = Number(argv[++i]);
		else if (a === "--master-seed") o.masterSeed = argv[++i];
		else if (a === "--out") o.out = argv[++i];
		else if (a === "--max-runs") o.maxRuns = Number(argv[++i]);
		else if (a === "--require-coverage") o.requireCoverage = true;
		else throw new Error(`sim-soak: unknown argument ${a}`);
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
function drawConfig(r, F) {
	const seed = r.range(1, 2 ** 31 - 1);
	const bases = [["none", null, 2], ["DEFAULT_FAULTS", F.DEFAULT_FAULTS, 4], ["BLOB_FAULTS", F.BLOB_FAULTS, 2], ["SUBS_FAULTS", F.SUBS_FAULTS, 2], ["E2EE_FAULTS", F.E2EE_FAULTS, 1]];
	let x = r.float() * bases.reduce((s, b) => s + b[2], 0);
	let base = bases[0];
	for (const b of bases) { x -= b[2]; if (x < 0) { base = b; break; } }
	const [baseName, baseWeights] = base;
	const cfg = { seed, devices: r.range(2, 5) };
	if (baseName === "E2EE_FAULTS") cfg.crypto = "suite1";
	const long = r.chance(0.35);
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
	return { cfg, label: `${baseName}${swarm ? `[${swarm.length}]` : ""} ${long ? "long" : "short"} d${cfg.devices} s${cfg.steps}${cfg.crypto ? " suite1" : ""}` };
}

async function main() {
	const o = args(process.argv.slice(2));
	const { runSim, minimizePlan } = await load("../src/sim/run.ts");
	const F = await load("../src/sim/faults.ts");
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
		const { cfg, label } = drawConfig(master, F);
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
		if (zero.length > 0) {
			console.log(`coverage keys never hit: ${zero.join(", ")}`);
			coverageBad = o.requireCoverage;
		}
	}
	if (o.requireCoverage && withCoverage === 0) coverageBad = true;
	process.exit(failures.length > 0 || coverageBad ? 1 : 0);
}

await main();
