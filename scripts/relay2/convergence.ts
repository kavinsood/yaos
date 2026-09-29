/**
 * §8.2 convergence suite summariser (+ §8.3 invariant #7 from CW).
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/convergence.ts [--dir <raw dir>] [--variant relay]
 *        [--out <json>] [--require-all]
 *
 * Reads the per-scenario JSON that bench.ts / reset/b5.ts wrote (runall.sh naming: `<ID>-<variant>.json`) and
 * reports, per §8.2 scenario — L2, quick trace replay (L4), stress trace (C2-stress), B2, B3, B5, B6, X1 sample —
 * pass/fail on: A/B/fresh-C text, A/B/fresh-C state vector, HTTP GET == client text, server-recorded hash ==
 * client canonical hash ("unknown" when the server recorded none), D6 invariant #7 (recorded hash describes the
 * stored merged state). CW (concurrent writers) adds the invariant #7 stress check. Missing files are reported
 * as "missing" (exit 1 with --require-all). Nothing is re-run here: runall.sh produces the inputs.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXP_ROOT, flagStr, parseArgs } from "./lib/common";

type Obj = Record<string, unknown>;
const SUITE: Array<{ id: string; label: string; file: string }> = [
	{ id: "L2", label: "L2 keystroke run", file: "L2" },
	{ id: "L4", label: "quick trace replay (L4)", file: "L4" },
	{ id: "C2-stress", label: "stress trace (C2 stress, 50k edits / 5 writers)", file: "C2-stress" },
	{ id: "B2", label: "B2 catch-up", file: "B2" },
	{ id: "B3", label: "B3 bootstrap", file: "B3" },
	{ id: "B5", label: "B5 epoch reset race", file: "B5" },
	{ id: "B6", label: "B6 retry/idempotence", file: "B6" },
	{ id: "X1", label: "X1 sample", file: "X1" },
	{ id: "CW", label: "CW concurrent writers (invariant #7)", file: "CW" },
];

/** All leaf convergence records (objects carrying freshC) under a convergence block. */
function leaves(v: unknown, path = "convergence"): Array<{ path: string; c: Obj }> {
	if (!v || typeof v !== "object") return [];
	const o = v as Obj;
	if (o.freshC) return [{ path, c: o }];
	const out: Array<{ path: string; c: Obj }> = [];
	for (const [k, x] of Object.entries(o)) {
		if (Array.isArray(x)) x.forEach((y, i) => out.push(...leaves(y, `${path}.${k}[${i}]`)));
		else if (x && typeof x === "object") out.push(...leaves(x, `${path}.${k}`));
	}
	return out;
}

const tri = (vals: Array<boolean | string | null | undefined>) =>
	vals.some((v) => v === false || v === "VIOLATED" || v === "mismatch") ? "FAIL"
		: vals.length > 0 && vals.every((v) => v === true || v === "holds" || v === "match") ? "pass"
		: vals.some((v) => v === "unknown") ? "unknown" : vals.length === 0 ? "n/a" : "pass";

function judge(leaf: Obj) {
	const fresh = leaf.freshC as Obj, get = leaf.httpGet as Obj, head = leaf.recordedHead as Obj;
	const inv = leaf.d6Invariant7 as Obj | undefined;
	const hashStatus = (leaf.hashStatus as string | undefined)
		?? (head?.contentHashEqual === true ? "match" : head?.contentHashEqual === false ? "mismatch" : "unknown");
	return {
		text: tri([leaf.liveClientsAgree as boolean, fresh?.textEqual as boolean]),
		stateVector: tri([leaf.liveClientsSvAgree as boolean, fresh?.svEqual as boolean]),
		httpGetEqualsClient: tri([get?.textEqual as boolean]),
		serverHashEqualsClient: hashStatus === "match" ? "pass" : hashStatus === "mismatch" ? "FAIL" : "unknown",
		invariant7: inv ? tri([inv.headVsStored as string, inv.getHeaderVsStored as string]) : "not recorded",
		pass: leaf.pass === true,
	};
}

function main() {
	const args = parseArgs();
	const dir = flagStr(args, "dir", join(EXP_ROOT, "results/relay2/raw"))!;
	const variant = flagStr(args, "variant", "relay")!;
	const files = existsSync(dir) ? readdirSync(dir) : [];
	const rows: Obj[] = [];
	for (const s of SUITE) {
		const name = files.find((f) => f === `${s.file}-${variant}.json`) ?? files.find((f) => f.startsWith(`${s.file}-${variant}`) && f.endsWith(".json"));
		if (!name) { rows.push({ id: s.id, label: s.label, status: "missing" }); continue; }
		const d = JSON.parse(readFileSync(join(dir, name), "utf8")) as Obj;
		if (s.id === "B5") {
			const races = (d.races as Obj[] | undefined) ?? [];
			const failed = races.filter((r) => r.pass !== true);
			rows.push({ id: s.id, label: s.label, file: name, status: races.length && !failed.length ? "pass" : races.length ? "FAIL" : "no races",
				races: races.length, failed: failed.length,
				checks: [...new Set(races.flatMap((r) => ((r.checks as Obj[] | undefined) ?? []).map((c) => `${c.name}: ${c.ok ? "ok" : "FAIL"}`)))],
				serverHashEqualsClient: "see checks (b5 compares the installed contentHash with the rebuilt client text)" });
			continue;
		}
		if (s.id === "CW") {
			const inv = d.invariant7 as Obj | undefined;
			const legs = leaves(d.convergence).map((l) => ({ path: l.path, ...judge(l.c) }));
			rows.push({ id: s.id, label: s.label, file: name, status: inv?.pass === true && legs.every((l) => l.pass) ? "pass" : "FAIL",
				invariant7: inv ?? null, legs });
			continue;
		}
		const legs = leaves(d.convergence).map((l) => ({ path: l.path, ...judge(l.c) }));
		const pass = legs.length > 0 && legs.every((l) => l.pass);
		rows.push({ id: s.id, label: s.label, file: name, status: legs.length === 0 ? (d.error ? "error" : "no convergence block") : pass ? "pass" : "FAIL",
			legs, error: d.error ? String(d.error).slice(0, 200) : undefined });
	}
	const result = { dir, variant, generatedAt: new Date().toISOString(), rows,
		allPass: rows.every((r) => r.status === "pass") };
	const out = flagStr(args, "out");
	if (out) writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
	for (const r of rows) {
		const legs = (r.legs as Obj[] | undefined) ?? [];
		const cols = legs.map((l) => `text=${l.text} sv=${l.stateVector} get=${l.httpGetEqualsClient} hash=${l.serverHashEqualsClient} inv7=${l.invariant7}`);
		console.log(`${String(r.status).padEnd(8)} ${String(r.id).padEnd(10)} ${r.file ?? ""} ${cols.join(" | ")}${r.id === "B5" ? ` races=${r.races} failed=${r.failed}` : ""}${r.id === "CW" && r.invariant7 ? ` inv7=${JSON.stringify(r.invariant7)}` : ""}`);
	}
	if (args.flags["require-all"] && !result.allPass) process.exit(1);
}

main();
