/**
 * Late gql backfill: per-window (C2 / C5 / MB) and whole-phase (every phase of a runfast.sh run).
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/gqlfill.ts [--dir <raw dir>] [--force]
 *        [--gql-attempts 30] [--progress <progress.jsonl>] [--jobs 8] [--stable-passes 3]
 *
 * Per-window: a DO reporting period is emitted only when it ends (often when the DO is evicted) and is labelled
 * with its start minute, so the last window of a scenario can take > 20 min to appear. This pass re-queries any
 * window that has no probeReady/totalsStable, is attributionSuspect, or has an error (or every window with
 * --force), then recomputes the gql-derived fields with the scenario's derive function. The old gql block is kept
 * under gqlInline; gqlBackfilledAt is recorded.
 *
 * Whole-phase (--progress, written by runfast.sh): every phase ran on its own freshly deployed worker, so the
 * worker's analytics over [phase start (deploy), phase end] are exactly that phase's traffic (deploy + claim +
 * standard seed + the scenario). Each phase JSON gets `gqlPhase` (periodic totals, invocation summary, minute
 * buckets; queried until two consecutive passes agree = totalsStable) and, for C2/C5/MB, `phaseLevel`:
 * (phase total − the SEED-<variant> phase total, i.e. deploy + claim + standard seed) / units. phaseLevel is the
 * attribution-proof number (no window spill possible); the per-window numbers remain alongside.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queryWindow } from "./gql";
import { EXP_ROOT, flagNum, flagStr, log, parseArgs, r2, sleep } from "./lib/common";
import type { RunCtx } from "./lib/run";
import { deriveC2, deriveC5, deriveMB, gqlWindows, type Win } from "./scenarios/extra";

type Obj = Record<string, unknown>;
const DERIVE: Record<string, (o: Obj) => Obj> = { C2: deriveC2, C5: deriveC5, MB: deriveMB };

function needsFill(d: Obj): boolean {
	const g = d.gql;
	if (!Array.isArray(g)) return true;
	return (g as Obj[]).some((w) => w.error || (w.name !== "idle" && (w.probeReady !== true || w.totalsStable !== true || w.attributionSuspect === true)));
}

async function pool<T>(items: T[], jobs: number, fn: (x: T) => Promise<void>) {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
		while (next < items.length) { const x = items[next++]!; await fn(x); }
	}));
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Obj;
const writeJson = (p: string, d: Obj) => writeFileSync(p, JSON.stringify(d, null, 2) + "\n");

async function windowPass(dir: string, args: ReturnType<typeof parseArgs>, jobs: number) {
	const force = Boolean(args.flags.force);
	const files = readdirSync(dir).filter((f) => /^(C2|C5|MB)-.*\.json$/.test(f) && !/\.(tail|gql)\.json$/.test(f)).sort();
	let filled = 0, still = 0;
	await pool(files, jobs, async (f) => {
		const path = join(dir, f);
		const d = readJson(path);
		const scenario = String(d.scenario ?? f.split("-")[0]);
		const derive = DERIVE[scenario];
		if (!derive || !Array.isArray(d.windows) || typeof d.host !== "string") return;
		if (!force && !needsFill(d)) { log(`${f}: gql complete`); return; }
		log(`${f}: backfilling gql for ${(d.windows as Win[]).length} windows`);
		// gqlWindows only reads host, args.flags and num(); the settle wait is 0 (the windows are in the past).
		const flags = { ...args.flags, "gql-settle-ms": "0" } as Record<string, string | boolean>;
		delete flags["no-gql"];
		const ctx = { host: d.host, args: { ...args, flags },
			num: (name: string, fallback: number) => name === "gql-settle-ms" ? 0 : flagNum(args, name, fallback) } as unknown as RunCtx;
		const gql = await gqlWindows(ctx, d.windows as Win[]);
		const fresh = readJson(path);   // phase pass may have written meanwhile (different keys)
		if (Array.isArray(fresh.gql) || (fresh.gql && typeof fresh.gql === "object")) fresh.gqlInline = fresh.gql;
		fresh.gql = gql;
		fresh.gqlBackfilledAt = new Date().toISOString();
		derive(fresh);
		writeJson(path, fresh);
		const complete = !needsFill(fresh);
		complete ? filled++ : still++;
		log(`${f}: ${complete ? "complete" : "STILL INCOMPLETE"}`);
	});
	log(`gqlfill windows: ${filled} filled, ${still} still incomplete (${files.length} candidate files)`);
	return still;
}

interface PhaseRec { phase: string; variant: string; worker: string; host: string; start: string; end: string }

/** Latest successful record per phase from runfast.sh's progress.jsonl. */
function phases(progress: string): PhaseRec[] {
	const by = new Map<string, PhaseRec>();
	for (const line of readFileSync(progress, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let j: Obj;
		try { j = JSON.parse(line) as Obj; } catch { continue; }
		if (j.status !== "done" || typeof j.worker !== "string" || !j.worker || !j.start || !j.end) continue;
		by.set(String(j.phase), { phase: String(j.phase), variant: String(j.variant ?? ""), worker: j.worker,
			host: `https://${j.worker}.kavinsood.workers.dev`, start: String(j.start), end: String(j.end) });
	}
	return [...by.values()];
}

function summarise(q: Awaited<ReturnType<typeof queryWindow>>) {
	const inv = ((q.invocations as Array<{ dimensions: Record<string, string>; sum: Record<string, number>; quantiles: Record<string, number> }>) ?? [])
		.map((g) => ({ type: g.dimensions.type, status: g.dimensions.status, requests: g.sum.requests, errors: g.sum.errors,
			cpuUs: { p50: g.quantiles.cpuTimeP50, p90: g.quantiles.cpuTimeP90, p99: g.quantiles.cpuTimeP99 } }));
	const req = (t: string[]) => inv.filter((g) => t.includes(String(g.type))).reduce((s, g) => s + (g.requests ?? 0), 0);
	const t = q.periodicTotals;
	const wsInvocations = req(["hibernation", "webSocket", "websocket"]);
	const inboundWsEffective = Math.max(t.inboundWebsocketMsgCount ?? 0, wsInvocations);
	const httpRequests = req(["http"]), alarms = req(["alarm"]);
	return { totals: { ...t, inboundWsEffective }, httpRequests, alarms, wsInvocations,
		doRequestUnits: r2(httpRequests + alarms + inboundWsEffective / 20),
		minuteBuckets: new Set(q.periodicMinutes.map((r) => r.dimensions.datetimeMinute)).size,
		objects: new Set(q.periodicMinutes.map((r) => r.dimensions.objectId)).size, invocations: inv };
}

/** Units for phase-level per-unit numbers (null: scenario has no per-unit cost). */
function units(d: Obj): { units: number; unit: string } | null {
	const s = String(d.scenario ?? "");
	if (s === "C2") return { units: Number(d.frames ?? 0), unit: "edit (trace frame)" };
	if (s === "MB") return { units: ((d.parts as Obj[] | undefined) ?? []).reduce((n, p) => n + Number(p.edits ?? 0), 0), unit: "edit" };
	if (s === "C5") {
		const parts = (d.parts as string[] | undefined) ?? ["bursts", "catchups"];
		if (parts.length === 1 && parts[0] === "bursts") return { units: Number(d.bursts ?? 0), unit: "burst" };
		if (parts.length === 1 && parts[0] === "catchups") return { units: Array.isArray(d.catchups) ? d.catchups.length : 0, unit: "catch-up" };
		return null;
	}
	return null;
}

const seedVariant = (v: string) => (v === "base" ? "base" : v === "strict" || v.startsWith("full") ? "strict" : "relay");

async function phasePass(dir: string, progress: string, jobs: number, passes: number) {
	const recs = phases(progress).filter((p) => existsSync(join(dir, `${p.phase}.json`)));
	log(`gqlfill phases: ${recs.length} phases with outputs`);
	const prev = new Map<string, string>();
	const stable = new Set<string>();
	const results = new Map<string, ReturnType<typeof summarise> & { window: [string, string] }>();
	for (let pass = 1; pass <= passes && stable.size < recs.length; pass++) {
		if (pass > 1) { log(`gqlfill phases: pass ${pass} in 120 s (${recs.length - stable.size} not yet stable)`); await sleep(120_000); }
		await pool(recs.filter((r) => !stable.has(r.phase)), jobs, async (r) => {
			// Pad the end by 3 min: alarms / checkpoints triggered by the phase land after its last request.
			const end = new Date(Date.parse(r.end) + 180_000).toISOString();
			try {
				const s = summarise(await queryWindow(r.worker, r.start, end));
				const sig = JSON.stringify([s.totals, s.invocations.map((g) => `${g.type}/${g.status}/${g.requests}`).sort()]);
				if (prev.get(r.phase) === sig) stable.add(r.phase);
				prev.set(r.phase, sig);
				results.set(r.phase, { ...s, window: [r.start, end] });
			} catch (error) { log(`${r.phase}: gql error ${String(error).slice(0, 200)}`); }
		});
	}
	const seeds: Record<string, Obj | undefined> = {};
	for (const v of ["base", "relay", "strict"]) {
		const s = results.get(`SEED-${v}`);
		seeds[v] = s ? { phase: `SEED-${v}`, totals: s.totals, httpRequests: s.httpRequests, alarms: s.alarms } : undefined;
	}
	for (const r of recs) {
		const s = results.get(r.phase);
		if (!s) continue;
		const path = join(dir, `${r.phase}.json`);
		const d = readJson(path);
		d.gqlPhase = { worker: r.worker, variant: r.variant, totalsStable: stable.has(r.phase), queriedAt: new Date().toISOString(),
			note: "whole-phase analytics of this phase's own worker: deploy + claim + standard seed + scenario (end padded 3 min)", ...s };
		const u = units(d);
		const seed = seeds[seedVariant(r.variant)];
		if (u && u.units > 0 && !r.phase.startsWith("SEED-")) {
			const st = (seed?.totals ?? {}) as Record<string, number>;
			const per = (key: string) => {
				const total = Number((s.totals as Record<string, number>)[key] ?? 0), base = Number(st[key] ?? 0);
				return { total, seed: seed ? base : null, net: r2(total - base), perUnit: r2((total - base) / u.units) };
			};
			const http = s.httpRequests + s.alarms - (seed ? Number(seed.httpRequests ?? 0) + Number(seed.alarms ?? 0) : 0);
			d.phaseLevel = { unit: u.unit, units: u.units, seedPhase: seed?.phase ?? null, totalsStable: stable.has(r.phase),
				rowsWritten: per("rowsWritten"), cpuTimeUs: per("cpuTime"), inboundWsEffective: per("inboundWsEffective"),
				outboundWs: per("outboundWebsocketMsgCount"),
				doRequestUnitsPerUnit: r2((http + (Number(s.totals.inboundWsEffective ?? 0) - Number((seed?.totals as Record<string, number> | undefined)?.inboundWsEffective ?? 0)) / 20) / u.units),
				note: "(whole-phase total − SEED-<variant> total) / units; includes the scenario's own body creation, idle window, convergence checks and diagnostics reads" };
		}
		writeJson(path, d);
	}
	const unstable = recs.filter((r) => !stable.has(r.phase)).map((r) => r.phase);
	log(`gqlfill phases: ${results.size}/${recs.length} queried, ${stable.size} stable${unstable.length ? `; unstable: ${unstable.join(",")}` : ""}`);
	return unstable.length;
}

async function main() {
	const args = parseArgs();
	const dir = flagStr(args, "dir", join(EXP_ROOT, "results/relay2/raw"))!;
	const jobs = flagNum(args, "jobs", 8);
	const progress = flagStr(args, "progress");
	let bad = 0;
	if (progress) bad += await phasePass(dir, progress, jobs, flagNum(args, "stable-passes", 3));
	bad += await windowPass(dir, args, jobs);
	if (bad) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
