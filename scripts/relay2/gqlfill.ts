/**
 * Late gql backfill for C2 / C5 / MB raw outputs.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/gqlfill.ts [--dir <raw dir>] [--force] [--gql-attempts 30]
 *
 * A DO reporting period is emitted only when it ends (often when the DO is evicted) and is labelled with its start
 * minute, so the last window of a scenario can take > 20 min to appear. Scenarios query gql inline. This pass
 * re-queries any window that has no probeReady/totalsStable, is attributionSuspect, or has an error (or every
 * window with --force), then recomputes the gql-derived fields with the scenario's derive function. It rewrites
 * the file in place (the old gql block is kept under gqlInline) and records gqlBackfilledAt. runall.sh runs it in
 * the final phase.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXP_ROOT, flagNum, flagStr, log, parseArgs } from "./lib/common";
import type { RunCtx } from "./lib/run";
import { deriveC2, deriveC5, deriveMB, gqlWindows, type Win } from "./scenarios/extra";

type Obj = Record<string, unknown>;
const DERIVE: Record<string, (o: Obj) => Obj> = { C2: deriveC2, C5: deriveC5, MB: deriveMB };

function needsFill(d: Obj): boolean {
	const g = d.gql;
	if (!Array.isArray(g)) return true;
	return (g as Obj[]).some((w) => w.error || (w.name !== "idle" && (w.probeReady !== true || w.totalsStable !== true || w.attributionSuspect === true)));
}

async function main() {
	const args = parseArgs();
	const dir = flagStr(args, "dir", join(EXP_ROOT, "results/relay2/raw"))!;
	const force = Boolean(args.flags.force);
	const files = readdirSync(dir).filter((f) => /^(C2|C5|MB)-.*\.json$/.test(f)).sort();
	let filled = 0, still = 0;
	for (const f of files) {
		const path = join(dir, f);
		const d = JSON.parse(readFileSync(path, "utf8")) as Obj;
		const scenario = String(d.scenario ?? f.split("-")[0]);
		const derive = DERIVE[scenario];
		if (!derive || !Array.isArray(d.windows) || typeof d.host !== "string") continue;
		if (!force && !needsFill(d)) { log(`${f}: gql complete`); continue; }
		log(`${f}: backfilling gql for ${(d.windows as Win[]).length} windows`);
		// gqlWindows only reads host, args.flags and num(); the settle wait is 0 (the windows are in the past).
		const ctx = { host: d.host, args: { ...args, flags: { ...args.flags, "gql-settle-ms": "0" } },
			num: (name: string, fallback: number) => name === "gql-settle-ms" ? 0 : flagNum(args, name, fallback) } as unknown as RunCtx;
		const gql = await gqlWindows(ctx, d.windows as Win[]);
		if (Array.isArray(d.gql)) d.gqlInline = d.gql;
		d.gql = gql;
		d.gqlBackfilledAt = new Date().toISOString();
		derive(d);
		writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
		const complete = !needsFill(d);
		complete ? filled++ : still++;
		log(`${f}: ${complete ? "complete" : "STILL INCOMPLETE"}`);
	}
	log(`gqlfill: ${filled} filled, ${still} still incomplete (${files.length} candidate files)`);
	if (still) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
