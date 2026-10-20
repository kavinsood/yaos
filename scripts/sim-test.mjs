#!/usr/bin/env node
// The slow sim runs `npm run test:client` skips: every src/**/*.sim.test.ts (the sim seed sweeps and the measured
// e2ee runs). Each file registers its units with simTest (src/sim/testkit/simTest.ts); every unit runs in its own
// node --test process, costliest first, over a pool of processes.
// Usage: npm run test:sim [-- <substring> ...]   (only units whose file or name contains a substring)
// Env:   YAOS_SIM_SEEDS  seeds of the full-count sim matrices (default 200; the others scale with it)
//        YAOS_SIM_JOBS   processes (default: cores - 1)
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PREFIX = "sim-unit ";
const filters = process.argv.slice(2);
const files = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (name.endsWith(".sim.test.ts")) files.push(relative(ROOT, p));
	}
})(join(ROOT, "src"));
files.sort();

const env = { ...process.env, YAOS_CLIENT_TEST: "1" };
const units = [];
for (const file of files) {
	const out = execFileSync(process.execPath, ["--import", "jiti/register", file], { cwd: ROOT, env: { ...env, YAOS_SIM_LIST: "1", NODE_NO_WARNINGS: "1" }, encoding: "utf8" });
	const listed = out.split("\n").filter((l) => l.startsWith(PREFIX)).map((l) => ({ file, ...JSON.parse(l.slice(PREFIX.length)) }));
	if (listed.length === 0) {
		console.error(`sim-test: ${file} registers no simTest units (a *.sim.test.ts file registers its tests with simTest)`);
		process.exit(1);
	}
	units.push(...listed);
}
const selected = units.filter((u) => filters.length === 0 || filters.some((f) => u.file.includes(f) || u.name.includes(f)));
if (selected.length === 0) {
	console.log("sim-test: no units matched");
	process.exit(0);
}
selected.sort((a, b) => b.cost - a.cost);
const jobs = Math.max(1, Number(process.env.YAOS_SIM_JOBS ?? 0) || Math.max(1, availableParallelism() - 1));
console.log(`sim-test: ${selected.length} units from ${files.length} files over ${jobs} processes`);

const t0 = Date.now();
const failed = [];
function run(u) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn(process.execPath, ["--import", "jiti/register", "--test", "--test-reporter=spec", u.file], {
			cwd: ROOT, env: { ...env, YAOS_SIM_UNIT: String(u.i) }, stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code, signal) => {
			const s = ((Date.now() - started) / 1000).toFixed(1);
			if (code === 0) console.log(`ok   ${u.name} (${s} s)`);
			else {
				failed.push(u);
				console.log(`FAIL ${u.name} (${s} s, ${signal ?? `exit ${code}`}; ${u.file} YAOS_SIM_UNIT=${u.i})\n${out.replace(/^/gm, "     ")}`);
			}
			resolve();
		});
	});
}
const queue = [...selected];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
	for (let u = queue.shift(); u; u = queue.shift()) await run(u);
}));
const wall = ((Date.now() - t0) / 1000).toFixed(1);
if (failed.length > 0) console.log(`sim-test: ${failed.length} of ${selected.length} failed, wall ${wall} s\n${failed.map((u) => `  ${u.name}`).join("\n")}`);
else console.log(`sim-test: all ${selected.length} passed, wall ${wall} s`);
process.exit(failed.length > 0 ? 1 : 0);
