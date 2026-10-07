#!/usr/bin/env node
// Suite-1 sim matrix (e2ee-design §20.3, "E7 as built"): the src/sim/run.test.ts matrix unchanged under
// crypto "suite1" at the same seed counts, plus the E2EE fault matrix (src/sim/e2eeFaults.ts), sharded over worker
// processes so it does not add to `npm run test:client`.
//
// Usage: npm run test:sim-suite1 [-- <substring> ...]   (run only the matrices whose name contains a substring)
// Env:   YAOS_SIM_SEEDS     seeds of the full-count matrices (default 200, as run.test.ts; the others scale with it)
//        YAOS_SIM_JOBS      worker processes (default: cores - 1)
//        YAOS_SIM_MINIMIZE  1: ddmin the first failing seed of each matrix (as run.test.ts does; slow)
// Exit 1 on any violation, crash, RealWork stray, a matrix whose actors did no real work, or a blob-fault matrix
// whose stalls and slow periods hit no transfer (as run.test.ts blobHits). Counts only: no keys.
import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function matrices(seeds) {
	const quarter = Math.max(1, Math.ceil(seeds / 4));
	const half = Math.max(1, Math.ceil(seeds / 2));
	const tenth = Math.max(1, Math.ceil(seeds / 10));
	return [
		// src/sim/run.test.ts, unchanged but for the crypto.
		{ name: "2 devices, no faults", base: { devices: 2, faults: null }, seeds },
		{ name: "3 devices, seeded faults", base: { devices: 3, faults: "DEFAULT_FAULTS" }, seeds },
		{ name: "5 devices, seeded faults", base: { devices: 5, faults: "DEFAULT_FAULTS" }, seeds: quarter },
		{ name: "2 devices, fault-heavy", base: { devices: 2, faults: "DEFAULT_FAULTS", faultRate: 0.35 }, seeds: quarter },
		{ name: "3 devices, blob stall/slow faults", base: { devices: 3, faults: "BLOB_FAULTS", faultRate: 0.3 }, seeds: tenth, blobHits: true },
		// The suite-1 faults on top of the suite-0 ones (faults.ts E2EE_FAULTS).
		{ name: "3 devices, E2EE faults", base: { devices: 3, faults: "E2EE_FAULTS", faultRate: 0.3 }, seeds: half },
		{ name: "4 devices, E2EE faults", base: { devices: 4, faults: "E2EE_FAULTS", faultRate: 0.3 }, seeds: quarter },
		{ name: "2 devices, E2EE fault-heavy", base: { devices: 2, faults: "E2EE_FAULTS", faultRate: 0.45 }, seeds: quarter },
	];
}

if (process.argv.includes("--worker")) await worker();
else await main();

/** jiti/register exposes a TS module's named exports under `default` when imported from an .mjs. */
async function load(rel) {
	const m = await import(new URL(rel, import.meta.url).href);
	return m.default && typeof m.default === "object" ? { ...m.default, ...m } : m;
}

async function worker() {
	const { runSim, minimizePlan } = await load("../src/sim/run.ts");
	const weights = await load("../src/sim/faults.ts");
	const cfgOf = (job) => ({ ...job.base, faults: job.base.faults ? weights[job.base.faults] : null, crypto: "suite1", seed: job.seed });
	process.on("message", async (job) => {
		if (job.t === "exit") process.exit(0);
		const t0 = Date.now();
		try {
			const cfg = cfgOf(job);
			if (job.t === "run") {
				const r = await runSim(cfg);
				process.send({ id: job.id, ok: true, ms: Date.now() - t0, violations: r.violations, tokens: r.stats.tokens.live, e2ee: r.stats.e2ee ?? null, realWork: r.stats.realWork ?? null, faults: r.stats.faults, blobs: r.stats.blobs });
			} else {
				const r0 = await runSim(cfg);
				const needle = r0.violations[0]?.detail ?? "";
				const m = await minimizePlan(cfg, r0.plan, (r) => r.violations.some((v) => v.detail === needle), 150);
				process.send({ id: job.id, ok: true, ms: Date.now() - t0, plan: m.plan, runs: m.runs });
			}
		} catch (e) {
			process.send({ id: job.id, ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e) });
		}
	});
	process.send({ ready: true });
}

function pool(n) {
	const workers = [];
	const idle = [];
	const waiting = new Map();
	let nextId = 0;
	let queue = [];
	const pump = () => {
		while (idle.length > 0 && queue.length > 0) {
			const w = idle.pop();
			const { job, resolve } = queue.shift();
			const id = ++nextId;
			waiting.set(id, { resolve, w, job });
			w.send({ ...job, id });
		}
	};
	for (let i = 0; i < n; i++) {
		const w = fork(SELF, ["--worker"], { cwd: ROOT, execArgv: ["--import", "jiti/register"], env: { ...process.env, YAOS_CLIENT_TEST: "1", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
		w.on("message", (m) => {
			if (m.ready) idle.push(w);
			else {
				const p = waiting.get(m.id);
				waiting.delete(m.id);
				idle.push(w);
				p.resolve(m);
			}
			pump();
		});
		w.on("exit", (code) => {
			for (const [id, p] of waiting) if (p.w === w) {
				waiting.delete(id);
				p.resolve({ id, ok: false, ms: 0, error: `worker exited with ${code}` });
			}
		});
		workers.push(w);
	}
	return {
		run: (job) => new Promise((resolve) => {
			queue.push({ job, resolve });
			pump();
		}),
		close: () => {
			for (const w of workers) if (w.connected) w.send({ t: "exit" });
		},
	};
}

function addInto(sum, x) {
	for (const [k, v] of Object.entries(x)) {
		if (typeof v === "number") sum[k] = k.endsWith("MaxMs") ? Math.max(sum[k] ?? 0, v) : (sum[k] ?? 0) + v;
		else if (v && typeof v === "object") addInto((sum[k] ??= {}), v);
	}
	return sum;
}

async function main() {
	const seeds = Math.max(1, Number(process.env.YAOS_SIM_SEEDS ?? 200) || 200);
	const filters = process.argv.slice(2);
	const ms = matrices(seeds).filter((m) => filters.length === 0 || filters.some((f) => m.name.includes(f)));
	const jobsN = Math.max(1, Number(process.env.YAOS_SIM_JOBS ?? 0) || Math.max(1, availableParallelism() - 1));
	const t0 = Date.now();
	const p = pool(jobsN);
	const results = new Map(ms.map((m) => [m.name, []]));
	// Costlier matrices first (more devices, more faults): the pool drains evenly.
	const order = [...ms].sort((a, b) => (b.base.devices + (b.base.faults ? 2 : 0)) - (a.base.devices + (a.base.faults ? 2 : 0)));
	let done = 0;
	const total = ms.reduce((n, m) => n + m.seeds, 0);
	console.log(`sim-suite1: ${total} runs in ${ms.length} matrices over ${jobsN} workers`);
	await Promise.all(order.flatMap((m) => Array.from({ length: m.seeds }, (_, i) => p.run({ t: "run", base: m.base, seed: i + 1 }).then((r) => {
		results.get(m.name).push({ seed: i + 1, ...r });
		if (++done % 50 === 0) console.log(`  ${done}/${total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
	}))));
	let failedAny = false;
	const minimize = [];
	for (const m of ms) {
		const rs = results.get(m.name).sort((a, b) => a.seed - b.seed);
		const failed = rs.filter((r) => !r.ok || r.violations.length > 0);
		const tokens = rs.reduce((n, r) => n + (r.tokens ?? 0), 0);
		const strays = rs.reduce((n, r) => n + (r.realWork?.strays ?? 0), 0);
		const runMs = rs.map((r) => r.ms).sort((a, b) => a - b);
		const sumFaults = rs.reduce((s, r) => addInto(s, r.faults ?? {}), {});
		const e2ee = rs.reduce((s, r) => (r.e2ee ? addInto(s, r.e2ee) : s), {});
		const rw = rs.reduce((s, r) => (r.realWork ? addInto(s, r.realWork) : s), {});
		const blobs = rs.reduce((s, r) => (r.blobs ? addInto(s, r.blobs) : s), {});
		const stalled = (blobs.stalled?.has ?? 0) + (blobs.stalled?.put ?? 0) + (blobs.stalled?.get ?? 0);
		const blobsHit = !m.blobHits || (stalled > 0 && blobs.stalled.put > 0 && blobs.watchdog > 0 && blobs.aborted > 0 && blobs.slowDone > 0 && blobs.slowCut === 0);
		const ok = failed.length === 0 && strays === 0 && tokens > m.seeds * 10 && blobsHit;
		failedAny ||= !ok;
		console.log(`${ok ? "ok" : "FAIL"} ${m.name}: ${m.seeds - failed.length}/${m.seeds} seeds clean, ${tokens} live tokens, run p50 ${(runMs[Math.floor(runMs.length / 2)] / 1000).toFixed(1)} s, max ${(runMs[runMs.length - 1] / 1000).toFixed(1)} s`);
		console.log(`   faults ${JSON.stringify(sumFaults)}`);
		console.log(`   realWork ${JSON.stringify(rw)}`);
		if (Object.keys(e2ee).length > 0) console.log(`   e2ee ${JSON.stringify(e2ee)}`);
		if (m.blobHits) console.log(`   blobs ${JSON.stringify(blobs)}`);
		if (!blobsHit) console.log("   the blob faults hit no transfer (stalled, stalled PUT, watchdog, aborted, slow done; slowCut 0)");
		if (strays > 0) console.log(`   RealWork strays: ${strays} (a crypto await bypassed RealWork)`);
		if (tokens <= m.seeds * 10) console.log(`   the actors did no real work (${tokens} live tokens)`);
		for (const r of failed.slice(0, 5)) {
			console.log(`   seed ${r.seed}: ${r.ok ? r.violations.slice(0, 6).map((v) => `${v.inv}: ${v.detail}`).join("\n             ") : r.error}`);
		}
		if (failed.length > 0) {
			console.log(`   failed seeds: ${failed.map((r) => r.seed).join(",")}`);
			console.log(`   replay one: runSim({ ...${JSON.stringify(m.base)}, faults: ${m.base.faults ?? "null"}, crypto: "suite1", seed })`);
			if (process.env.YAOS_SIM_MINIMIZE === "1" && failed[0].ok) minimize.push({ m, seed: failed[0].seed });
		}
	}
	for (const { m, seed } of minimize) {
		const r = await p.run({ t: "minimize", base: m.base, seed });
		console.log(`minimized ${m.name} seed ${seed} (${r.runs} runs): ${r.ok ? JSON.stringify(r.plan) : r.error}`);
	}
	p.close();
	console.log(`sim-suite1: ${failedAny ? "FAILED" : "all clean"}, wall ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	process.exit(failedAny ? 1 : 0);
}
