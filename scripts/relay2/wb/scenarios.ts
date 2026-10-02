/**
 * R1 (closed-file merge) and DL (D8 daily limit) harness scenarios, ported from the write-budget spike
 * (yaos-wb-int scripts/relay2/wb/scenarios.ts @ 91b1fac / 4f36c9e) and trimmed to R1 + DL. Registered in bench.ts:
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts <R1|R1LIVE|DL> --host <url> --adapter relay --out <json>
 *
 *   R1      merge fixture table (MERGE_CASES) through `--merge-module` (default src/sync/lineMerge.ts; `reference` = the
 *           harness diff3) + the EMULATED live part (`--no-live` = table only; `--live daemon` = same as R1LIVE).
 *   R1LIVE  merge fixture table + the real reconcile through the headless CLI daemon (realScenarios.R1live).
 *   DL      D8 simulated Cloudflare daily limit through a real VaultSync (realScenarios.DL).
 *
 * Rows come from adapters.RowsCounter (exact `debug/sql-rows` when present; on relay v3 it falls back to the relay
 * in-memory counter, labelled `relay-diagnostics`).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Y from "yjs";
import { bodyGet } from "../lib/checks";
import { sleep } from "../lib/common";
import { openOrThrow, type RunCtx } from "../lib/run";
import { legacyCreate, listHeads, mergeAdapter, RowsCounter, rowsDelta } from "./adapters";

type Result = Record<string, unknown>;

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
/** Product diff3 of this branch (closed-file reconcile). */
export const DEFAULT_MERGE_MODULE = "src/sync/lineMerge.ts";

// ------------------------------------------------------------------ shared helpers
/** Relay-off (base) runs only use the exact route: the relay-diagnostics fallback counts relay appends, meaningless there. */
export function rowsCounter(ctx: RunCtx) {
	const mode = ctx.str("rows-mode") ?? process.env.WB_ROWS_MODE ?? (ctx.adapter.name === "base" ? "debug-route" : "auto");
	return new RowsCounter(ctx.context, ctx.str("rows-route"), mode);
}

/**
 * Merge module path for R1: `--merge-module <path>` > WB_MERGE_MODULE > src/sync/lineMerge.ts; `reference` selects the
 * harness diff3. Relative paths resolve against the repo root.
 */
export function mergeModulePath(flag?: string): string | undefined {
	const p = flag ?? process.env.WB_MERGE_MODULE ?? DEFAULT_MERGE_MODULE;
	if (p === "reference" || p === "") return undefined;
	return resolve(REPO_ROOT, p);
}

/** Replace a Y.Text's content with `next` using one common-prefix/suffix splice (what a disk→CRDT diff does). */
export function applyMinimalDiff(t: Y.Text, next: string) {
	const cur = t.toString();
	let p = 0;
	while (p < cur.length && p < next.length && cur[p] === next[p]) p++;
	let s = 0;
	while (s < cur.length - p && s < next.length - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++;
	const del = cur.length - p - s;
	if (del > 0) t.delete(p, del);
	const ins = next.slice(p, next.length - s);
	if (ins) t.insert(p, ins);
	return { deleted: del, inserted: ins.length };
}

// ================================================================================================= R1
export interface MergeCase { id: string; base: string | null; ours: string; theirs: string; expect: "clean" | "conflict" | "skip" | "either"; merged?: string; note?: string }
const L = (...xs: string[]) => xs.map((x) => x + "\n").join("");
const BASE10 = L("# Title", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8", "line 9", "line 10");
const rep = (text: string, n: number, by: string) => text.split("\n").map((l, i) => (i === n - 1 ? by : l)).join("\n");
export const MERGE_CASES: MergeCase[] = [
	{ id: "nonoverlap-edits", base: BASE10, ours: rep(BASE10, 2, "line 2 OURS"), theirs: rep(BASE10, 8, "line 8 THEIRS"), expect: "clean",
		merged: rep(rep(BASE10, 2, "line 2 OURS"), 8, "line 8 THEIRS") },
	{ id: "overlap-differ", base: BASE10, ours: rep(BASE10, 5, "five OURS"), theirs: rep(BASE10, 5, "five THEIRS"), expect: "conflict" },
	{ id: "overlap-identical", base: BASE10, ours: rep(BASE10, 5, "five SAME"), theirs: rep(BASE10, 5, "five SAME"), expect: "clean", merged: rep(BASE10, 5, "five SAME") },
	{ id: "ours-only", base: BASE10, ours: BASE10 + "appended on disk\n", theirs: BASE10, expect: "clean", merged: BASE10 + "appended on disk\n" },
	{ id: "theirs-only", base: BASE10, ours: BASE10, theirs: "prepended on server\n" + BASE10, expect: "clean", merged: "prepended on server\n" + BASE10 },
	{ id: "insert-same-point-differ", base: BASE10, ours: BASE10.replace("line 4\n", "line 4\nOURS NEW\n"), theirs: BASE10.replace("line 4\n", "line 4\nTHEIRS NEW\n"), expect: "conflict" },
	{ id: "delete-vs-edit", base: BASE10, ours: BASE10.replace("line 6\n", ""), theirs: rep(BASE10, 6, "line 6 THEIRS"), expect: "conflict" },
	{ id: "delete-kept-deleted", base: BASE10, ours: BASE10.replace("line 3\n", ""), theirs: rep(BASE10, 9, "line 9 THEIRS"), expect: "clean",
		merged: rep(BASE10, 9, "line 9 THEIRS").replace("line 3\n", ""), note: "deletion must not be resurrected (no superset-wins)" },
	{ id: "adjacent-lines", base: BASE10, ours: rep(BASE10, 4, "line 4 OURS"), theirs: rep(BASE10, 5, "line 5 THEIRS"), expect: "either",
		note: "git conflicts on adjacent hunks; D4 only says non-overlapping merges — report which the module chose" },
	{ id: "no-final-newline", base: "a\nb\nc", ours: "A\nb\nc", theirs: "a\nb\nC", expect: "clean", merged: "A\nb\nC" },
	{ id: "both-append-differ", base: BASE10, ours: BASE10 + "ours tail\n", theirs: BASE10 + "theirs tail\n", expect: "conflict" },
	{ id: "empty-base-differ", base: "", ours: "ours\n", theirs: "theirs\n", expect: "conflict" },
	{ id: "nobase-identical", base: null, ours: BASE10, theirs: BASE10, expect: "skip" },
	{ id: "nobase-different", base: null, ours: BASE10, theirs: rep(BASE10, 3, "x"), expect: "conflict" },
	{ id: "nobase-superset", base: null, ours: BASE10, theirs: BASE10 + "extra\n", expect: "conflict", note: "superset-wins forbidden (D4)" },
];

/** The fixture table through `modulePath` (absolute, or undefined = harness reference diff3). */
export async function runMergeCases(modulePath?: string) {
	const m = await mergeAdapter(modulePath);
	const results = [];
	for (const c of MERGE_CASES) {
		const got = c.base === null ? await m.noBase(c.ours, c.theirs) : await m.merge(c.base, c.ours, c.theirs);
		const kindOk = c.expect === "either" ? true : got.kind === c.expect;
		const textOk = c.expect === "clean" && got.kind === "clean" ? got.text === c.merged : true;
		results.push({ id: c.id, expect: c.expect, got: got.kind, pass: kindOk && textOk, ...(got.kind === "clean" && !textOk ? { text: got.text } : {}), note: c.note });
	}
	return { adapter: m.name, source: m.source, results, passed: results.filter((r) => r.pass).length, total: results.length, pass: results.every((r) => r.pass) };
}

/**
 * R1 merge correctness. Part 1 (always): the fixture table through `--merge-module` (default src/sync/lineMerge.ts).
 * Part 2 (default; `--no-live` skips): EMULATED client reconcile — per base-present case the server note goes
 * base → theirs (device B), then device A "reconciles" with disk = ours via the merge module: clean → applied as a
 * CRDT edit on the existing note (GET must equal merged); conflict → original untouched + conflict copy created with
 * ours. No-base identical must write 0 rows. `--live daemon` runs the real CLI daemon instead (= R1LIVE).
 */
export async function R1(ctx: RunCtx): Promise<Result> {
	if (!ctx.args.flags["no-live"] && ctx.str("live", "emulated") === "daemon") return R1LIVE(ctx);
	const modulePath = mergeModulePath(ctx.str("merge-module"));
	const table = await runMergeCases(modulePath);
	const live: Result[] = [];
	if (!ctx.args.flags["no-live"]) {
		const rows = rowsCounter(ctx);
		const m = await mergeAdapter(modulePath);
		for (const [k, c] of MERGE_CASES.entries()) {
			const bodyId = `${ctx.tag}-r1-${k}`, path = `WB/${ctx.tag}/r1-${c.id}.md`;
			const conflictPath = path.replace(/\.md$/, " (conflict A).md");
			const ev: Result = { id: c.id };
			if (c.base === null) {
				await legacyCreate(ctx.context, [{ kind: "note", path, bodyId, content: c.theirs }]);
				await sleep(ctx.num("pre-settle-ms", 3000)); // the create's deferred (group-commit / catalog) rows land after its response
				const r0 = await rows.read();
				const got = await m.noBase(c.ours, c.theirs);
				if (got.kind === "conflict") await legacyCreate(ctx.context, [{ kind: "note", path: conflictPath, bodyId: `${bodyId}-conflict`, content: c.ours }]);
				await sleep(1500);
				ev.got = got.kind; ev.rows = rowsDelta(r0, await rows.read());
				ev.pass = got.kind === c.expect && (got.kind !== "skip" || ((ev.rows as Result).rowsWritten ?? 0) === 0);
				live.push(ev); continue;
			}
			await legacyCreate(ctx.context, [{ kind: "note", path, bodyId, content: c.base }]);
			const b = await openOrThrow(await ctx.client("B", bodyId), 60_000);
			b.edit((t) => applyMinimalDiff(t, c.theirs));
			await sleep(1500); await b.close();
			const got = await m.merge(c.base, c.ours, c.theirs);
			ev.got = got.kind;
			if (got.kind === "clean") {
				const a = await openOrThrow(await ctx.client("A", bodyId), 60_000);
				if (a.text() !== c.theirs) ev.preMergeServerTextOk = false;
				if (got.text !== a.text()) a.edit((t) => applyMinimalDiff(t, got.text));
				await sleep(1500); await a.close();
				const g = await bodyGet(await ctx.dev("C"), bodyId);
				ev.pass = g.text === got.text && (c.expect !== "clean" || got.text === c.merged);
			} else {
				await legacyCreate(ctx.context, [{ kind: "note", path: conflictPath, bodyId: `${bodyId}-conflict`, content: c.ours }]);
				const g = await bodyGet(await ctx.dev("C"), bodyId);
				const heads = await listHeads(await ctx.dev("C"));
				ev.pass = g.text === c.theirs && heads.entries.some((e) => e.path === conflictPath) && (c.expect === "conflict" || c.expect === "either");
			}
			live.push(ev);
		}
	}
	return { mergeTable: table, live, liveEmulated: ctx.args.flags["no-live"] ? "skipped (--no-live)" : "client reconcile emulated in harness (R1LIVE = real CLI daemon)",
		convergence: { pass: table.pass && live.every((e) => e.pass) } };
}

/** R1 with the real reconcile: fixture table + realScenarios.R1live (headless CLI daemon; cases `--live-cases`). */
export async function R1LIVE(ctx: RunCtx): Promise<Result> {
	const table = await runMergeCases(mergeModulePath(ctx.str("merge-module")));
	const daemon = await (await import("./realScenarios")).R1live(ctx);
	const live = daemon.live as Array<{ pass: boolean }>;
	return { mergeTable: table, ...daemon, liveEmulated: false, convergence: { pass: table.pass && live.length > 0 && live.every((e) => e.pass) } };
}

// ================================================================================================= DL (D8)
/** D8 simulated Cloudflare daily limit; see realScenarios.DL. */
export async function DL(ctx: RunCtx): Promise<Result> { return (await import("./realScenarios")).DL(ctx); }
