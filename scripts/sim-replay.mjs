#!/usr/bin/env node
// Replays sim failure artifacts (scripts/sim-soak.mjs output, or src/sim/regressions/*.json and slow/*.json):
// runSim(config, minimizedPlan). Usage: npm run sim:replay -- <file.json> [...] [--full] (--full: the unminimized plan)
// Exit 1 if any replay still has violations.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function load(rel) {
	const m = await import(new URL(rel, import.meta.url).href);
	return m.default && typeof m.default === "object" ? { ...m.default, ...m } : m;
}

const argv = process.argv.slice(2);
const full = argv.includes("--full");
const files = argv.filter((a) => a !== "--full");
if (files.length === 0) {
	console.error("usage: npm run sim:replay -- <artifact.json> [...] [--full]");
	process.exit(2);
}
const { runSim } = await load("../src/sim/run.ts");
let bad = 0;
for (const f of files) {
	const a = JSON.parse(readFileSync(resolve(f), "utf8"));
	const plan = full && a.plan ? a.plan : a.minimizedPlan;
	const r = await runSim(a.config, plan);
	if (r.violations.length === 0) console.log(`PASS ${f}: ${plan?.length ?? "generated"} steps, no violations`);
	else {
		bad++;
		console.log(`FAIL ${f}: ${r.violations.length} violations`);
		for (const v of r.violations.slice(0, 10)) console.log(`  ${v.inv}: ${v.detail}`);
	}
}
process.exit(bad > 0 ? 1 : 0);
