#!/usr/bin/env node
// Suspend-kill budget sweep (src/sim/faults.ts SuspendKillAction, run.ts SimConfig.suspend): how much work after the
// app is backgrounded (hidden / pagehide / freeze) our code needs before the OS kills it so that no typed text is lost.
//
// Every seed runs once per cell (budget B x save outcome) on the same plan: one forced suspend-kill right after (or up
// to 2.5 s after) a type / paste step. B counts storage commits on the device after the event (0: killed at the
// event, before any posted message, timer or commit runs; "never": not killed). The kill restarts the app from its
// crash copy. "landed": the host's saveViews reached the disk before death; "lost": no view save ran before death.
//
// Usage: node scripts/sim-suspend.mjs
// Env:   YAOS_SIM_SEEDS         seeds per cell (default 200; ~5 min on 11 workers)
//        YAOS_SUSPEND_BUDGETS   comma list (default "0,1,2,3,5,never")
//        YAOS_SUSPEND_DEVICES   devices (default 2)
//        YAOS_SUSPEND_STEPS     plan steps per run (default 60)
//        YAOS_SIM_JOBS          worker processes (default: cores - 1)
//        YAOS_SIM_MINIMIZE      1: ddmin the first seed with a genuine loss (a lost token that was durable)
// Exit 1 on a genuine loss, a violation other than an exempt crash loss, or a worker error.
import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DEVICES = Math.max(2, Number(process.env.YAOS_SUSPEND_DEVICES ?? 2) || 2);
const STEPS = Math.max(20, Number(process.env.YAOS_SUSPEND_STEPS ?? 60) || 60);

async function load(rel) {
	const m = await import(new URL(rel, import.meta.url).href);
	return m.default && typeof m.default === "object" ? { ...m.default, ...m } : m;
}

async function worker() {
	const { runSim, minimizePlan } = await load("../src/sim/run.ts");
	// Production open-frame windows (100 / 300 ms; FAST_TUNING shrinks them 50x) so the event can catch an open frame.
	const cfgOf = (job) => ({ seed: job.seed, devices: DEVICES, steps: STEPS, faults: null, tuning: { frameStretch: 1 }, suspend: { budget: job.budget, save: job.save } });
	process.on("message", async (job) => {
		if (job.t === "exit") process.exit(0);
		const t0 = Date.now();
		try {
			const cfg = cfgOf(job);
			if (job.t === "run") {
				const r = await runSim(cfg);
				process.send({ id: job.id, ok: true, ms: Date.now() - t0, violations: r.violations, suspend: r.stats.suspend, trace: r.trace.find((l) => l.includes("suspendKill")) ?? null });
			} else {
				const r0 = await runSim(cfg);
				const fails = (r) => r.stats.suspend.some((s) => s.genuine.length > 0);
				const m = fails(r0) ? await minimizePlan(cfg, r0.plan, fails, 150) : { plan: r0.plan, runs: 0 };
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
	const queue = [];
	const pump = () => {
		while (idle.length > 0 && queue.length > 0) {
			const w = idle.pop();
			const { job, resolve } = queue.shift();
			const id = ++nextId;
			waiting.set(id, { resolve, w });
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

/** How far the flush got before the kill. */
function stage(s) {
	const tEdit = s.commits.some((c) => c.split("+").includes("outbox"));
	if (tEdit && s.sideWrites > 0) return "tEdit+mirror";
	if (tEdit) return "tEdit";
	if (s.commits.length > 0) return s.sideWrites > 0 ? "other+mirror" : "other-commit";
	return s.sideWrites > 0 ? "mirror-only" : "none";
}

function inc(o, k, n = 1) {
	o[k] = (o[k] ?? 0) + n;
	return o;
}

function pct(a, b) {
	return b === 0 ? "-" : `${((100 * a) / b).toFixed(1)}%`;
}

async function main() {
	const seeds = Math.max(1, Number(process.env.YAOS_SIM_SEEDS ?? 200) || 200);
	const budgets = (process.env.YAOS_SUSPEND_BUDGETS ?? "0,1,2,3,5,never").split(",").map((b) => (b.trim() === "never" ? null : Number(b)));
	const saves = ["landed", "lost"];
	const jobsN = Math.max(1, Number(process.env.YAOS_SIM_JOBS ?? 0) || Math.max(1, availableParallelism() - 1));
	const cells = saves.flatMap((save) => budgets.map((budget) => ({ budget, save, key: `${save} B=${budget ?? "never"}` })));
	const total = cells.length * seeds;
	console.log(`sim-suspend: ${total} runs (${cells.length} cells x ${seeds} seeds, ${DEVICES} devices, ${STEPS} steps) over ${jobsN} workers`);
	const t0 = Date.now();
	const p = pool(jobsN);
	const results = new Map(cells.map((c) => [c.key, []]));
	let done = 0;
	await Promise.all(cells.flatMap((c) => Array.from({ length: seeds }, (_, i) => p.run({ t: "run", seed: i + 1, budget: c.budget, save: c.save }).then((r) => {
		results.get(c.key).push({ seed: i + 1, ...r });
		if (++done % 500 === 0) console.log(`  ${done}/${total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
	}))));

	let bad = false;
	const firstGenuine = [];
	// atRisk: typed on the device, on no disk at the event; memOnly: ... and not in committed storage either (only in
	// the editor, the binding's buffer, an open frame or a frame being sealed). Loss rates are over memOnly.
	console.log("\ncell                 runs  memOnly-runs  memOnly-tok (atRisk)  lost-tok  lost%memOnly  runs-w/loss  %of-memOnly-runs  genuine  stages-at-kill / killedBy");
	for (const c of cells) {
		const rs = results.get(c.key).sort((a, b) => a.seed - b.seed);
		const errs = rs.filter((r) => !r.ok);
		const ok = rs.filter((r) => r.ok);
		let memRuns = 0, mem = 0, atRisk = 0, lost = 0, lossRuns = 0, genuine = 0;
		const stages = {}, killed = {}, other = [], genuineSeeds = [];
		for (const r of ok) {
			const s = r.suspend[0];
			// Violations a suspend-kill can explain are the token checks; anything else is reported as is.
			for (const v of r.violations) if (v.inv !== "tokens") other.push(`seed ${r.seed}: ${v.inv}: ${v.detail}`);
			if (!s) {
				inc(stages, "not-run");
				continue;
			}
			const m = s.atRisk - s.committedAtEvent;
			if (m > 0) memRuns++;
			mem += m;
			atRisk += s.atRisk;
			lost += s.lost.length;
			if (s.lost.length > 0) lossRuns++;
			if (s.genuine.length > 0) {
				genuine += s.genuine.length;
				genuineSeeds.push(`${r.seed} (${s.genuine.slice(0, 3).join(" ")}; ${r.trace})`);
			}
			inc(stages, stage(s));
			inc(killed, s.killedBy ?? "pending");
		}
		console.log(
			`${c.key.padEnd(20)} ${String(ok.length).padStart(4)}  ${String(memRuns).padStart(12)}  ${`${mem} (${atRisk})`.padStart(20)}  ${String(lost).padStart(8)}  ${pct(lost, mem).padStart(12)}  ${String(lossRuns).padStart(11)}  ${pct(lossRuns, memRuns).padStart(16)}  ${String(genuine).padStart(7)}  ${JSON.stringify(stages)} ${JSON.stringify(killed)}`,
		);
		if (genuineSeeds.length > 0) {
			bad = true;
			console.log(`   GENUINE losses (durable token lost), seeds: ${genuineSeeds.slice(0, 5).join(" | ")}`);
			firstGenuine.push({ c, seed: Number(genuineSeeds[0].split(" ")[0]) });
		}
		if (other.length > 0) {
			bad = true;
			console.log(`   other violations (${other.length}): ${other.slice(0, 4).join(" | ")}`);
		}
		if (errs.length > 0) {
			bad = true;
			console.log(`   worker errors (${errs.length}): ${errs[0].error}`);
		}
	}

	// The never-killed control: how many commits the whole background flush takes (within the 5 s deadline).
	for (const save of saves) {
		const rs = results.get(`${save} B=never`);
		if (!rs) continue;
		const firstOutbox = {}, totalCommits = {};
		for (const r of rs) {
			const s = r.ok ? r.suspend[0] : null;
			if (!s || s.atRisk - s.committedAtEvent === 0) continue;
			const i = s.commits.findIndex((c) => c.split("+").includes("outbox"));
			inc(firstOutbox, i < 0 ? "none" : String(i + 1));
			inc(totalCommits, s.commits.length > 8 ? ">8" : String(s.commits.length));
		}
		console.log(`\nnever-killed control (${save}, runs with memory-only tokens): first tEdit (outbox) commit at #${JSON.stringify(firstOutbox)}; commits within ${5}s: ${JSON.stringify(totalCommits)}`);
	}

	if (process.env.YAOS_SIM_MINIMIZE === "1") {
		for (const { c, seed } of firstGenuine.slice(0, 2)) {
			const r = await p.run({ t: "minimize", seed, budget: c.budget, save: c.save });
			console.log(`minimized ${c.key} seed ${seed} (${r.runs} runs): ${r.ok ? JSON.stringify(r.plan) : r.error}`);
		}
	}
	p.close();
	console.log(`\nsim-suspend: ${bad ? "FAILED (see above)" : "no genuine loss"}, wall ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	process.exit(bad ? 1 : 0);
}

if (process.argv.includes("--worker")) await worker();
else await main();
