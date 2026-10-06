/**
 * Offline self-test for the R1 / DL harness (no server needed):
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/wb/selftest.ts [--merge-module <path>|reference]
 * Checks: reference diff3 properties, the R1 fixture table through the reference AND the product module
 * (default src/sync/lineMerge.ts; must be 15/15), rows-payload parsing + deltas, the rows-read timeout retry,
 * the closed-file candidate request shape (DL probe), and bulk batch splitting.
 */
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import * as Y from "yjs";
import { candidateDigestMaterial } from "../../../../server/src/shared/candidateDigest";
import { flagStr, parseArgs } from "../../lib/common";
import { candidateRequest, fetchRows, parseRowsPayload, rowsDelta, splitBatches } from "./adapters";
import { merge3, mergeNoBase } from "./diff3";
import { applyMinimalDiff, MERGE_CASES, mergeModulePath, runMergeCases } from "./scenarios";

let failures = 0, checks = 0;
function ok(cond: unknown, what: string) { checks++; if (!cond) { failures++; console.error(`FAIL ${what}`); } }

/** Deterministic PRNG (mulberry32) for the diff3 property run. */
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
	return { int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

// ---------------------------------------------------------------- diff3 properties (harness reference)
{
	const r = rng(0xd1ff3);
	const words = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta"];
	const randText = () => Array.from({ length: r.int(0, 12) }, () => r.pick(words)).map((w) => w + "\n").join("");
	const mutate = (t: string) => {
		const lines = t.split(/(?<=\n)/).filter(Boolean);
		const ops = r.int(1, 3);
		for (let i = 0; i < ops; i++) {
			const at = r.int(0, lines.length);
			const op = r.int(0, 2);
			if (op === 0) lines.splice(at, 0, `new-${r.int(0, 999)}\n`);
			else if (op === 1 && lines.length) lines.splice(Math.min(at, lines.length - 1), 1);
			else if (lines.length) lines[Math.min(at, lines.length - 1)] = `chg-${r.int(0, 999)}\n`;
		}
		return lines.join("");
	};
	for (let i = 0; i < 2000; i++) {
		const base = randText(), x = mutate(base), y = mutate(base);
		const m1 = merge3(base, x, base), m2 = merge3(base, base, y), m3 = merge3(base, x, x);
		ok(m1.kind === "clean" && m1.text === x, `diff3: merge(b,x,b)=x #${i}`);
		ok(m2.kind === "clean" && m2.text === y, `diff3: merge(b,b,y)=y #${i}`);
		ok(m3.kind === "clean" && m3.text === x, `diff3: merge(b,x,x)=x #${i}`);
		const m4 = merge3(base, x, y);
		if (m4.kind === "clean") {
			const sym = merge3(base, y, x);
			ok(sym.kind === "clean" && sym.text === m4.text, `diff3: clean merge symmetric #${i}`);
		}
	}
	ok(merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n").kind === "conflict", "diff3: overlapping differing → conflict");
	ok(mergeNoBase("x", "x").kind === "skip" && mergeNoBase("x", "x\ny").kind === "conflict", "diff3: no-base rules");
}

// ---------------------------------------------------------------- R1 fixture table
{
	ok(MERGE_CASES.length === 15, `R1: 15 fixture cases (got ${MERGE_CASES.length})`);
	const ref = await runMergeCases(undefined);
	for (const c of ref.results) ok(c.pass, `R1 fixture ${c.id} (${ref.adapter}): expect ${c.expect} got ${c.got}`);
	console.log(`R1 fixtures via ${ref.adapter}: ${ref.passed}/${ref.total} pass; adjacent-lines → ${ref.results.find((c) => c.id === "adjacent-lines")?.got}`);
	const modulePath = mergeModulePath(flagStr(parseArgs(), "merge-module"));
	if (modulePath) {
		const fx = await runMergeCases(modulePath);
		ok(fx.source === "product-module", `R1: module ${modulePath} loaded (${fx.source})`);
		for (const c of fx.results) ok(c.pass, `R1 fixture ${c.id} (${fx.adapter}): expect ${c.expect} got ${c.got}`);
		console.log(`R1 merge cases via ${fx.adapter}: ${fx.passed}/${fx.total} pass; adjacent-lines → ${fx.results.find((c) => c.id === "adjacent-lines")?.got}`);
	}
}

// ---------------------------------------------------------------- rows payloads + deltas
{
	const cases: Array<[unknown, number | null, number | null]> = [
		[{ rowsWritten: 10, rowsRead: 4 }, 10, 4],
		[{ rows_written: "12", rows_read: "3" }, 12, 3],
		[{ cumulative: { rowsWritten: 7, rowsRead: 1 } }, 7, 1],
		[{ result: { sql: { written: 5, read: 2 } } }, 5, 2],
		[{ counters: { rowsWritten: 9 } }, 9, null],
		[{ nothing: true }, null, null],
	];
	for (const [v, w, rd] of cases) { const p = parseRowsPayload(v); ok(p.rowsWritten === w && p.rowsRead === rd, `rows payload ${JSON.stringify(v)} → ${JSON.stringify(p)}`); }
	const base = { rowsWritten: 100, rowsRead: 10, source: "debug-route", exact: true, at: 0, wall: 0 } as const;
	const d = rowsDelta(base, { ...base, rowsWritten: 130, rowsRead: 12, at: 1 });
	ok(d.rowsWritten === 30 && !d.counterReset, "rowsDelta simple");
	ok(rowsDelta(base, { ...base, rowsWritten: 5, rowsRead: 1, at: 1 }).counterReset, "rowsDelta flags counter reset (DO restart)");
}

// ---------------------------------------------------------------- rows read survives wrangler-dev proxy parking
{
	let parked: ServerResponse | null = null, served = 0;
	const srv = createServer((req, res) => {
		if (req.url === "/park" && served === 0 && !parked) { parked = res; return; }
		const prev = parked as ServerResponse | null; parked = null;
		if (prev && !prev.destroyed) prev.end(JSON.stringify({ released: true }));
		served++; res.end(JSON.stringify({ rowsWritten: 42 }));
	});
	await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
	const port = (srv.address() as { port: number }).port;
	let timeouts = 0;
	const t0 = Date.now();
	const r = await fetchRows(`http://127.0.0.1:${port}/park`, {}, () => timeouts++, 300);
	const body = await r.json() as { rowsWritten?: number };
	ok(r.ok && body.rowsWritten === 42, `fetchRows: retry answered after parking ${JSON.stringify(body)}`);
	ok(timeouts === 1, `fetchRows: one timeout counted (got ${timeouts})`);
	ok(Date.now() - t0 < 5000, `fetchRows: bounded by the timeout (${Date.now() - t0} ms)`);
	let hardFail = false;
	await fetchRows(`http://127.0.0.1:1/x`, {}, () => {}, 300).catch(() => { hardFail = true; });
	ok(hardFail, "fetchRows: non-timeout errors propagate");
	srv.closeAllConnections(); srv.close();
}

// ---------------------------------------------------------------- DL closed-file candidate probe shape + minimal diff
{
	const doc = new Y.Doc(); const t = doc.getText("body"); t.insert(0, "hello brave new world");
	const got: Uint8Array[] = []; doc.on("update", (u: Uint8Array) => { got.push(u); });
	const r = applyMinimalDiff(t, "hello cruel new world");
	ok(t.toString() === "hello cruel new world" && r.deleted === 5 && r.inserted === 5, `applyMinimalDiff ${JSON.stringify(r)}`);
	const update = got.length === 1 ? got[0]! : Y.mergeUpdates(got);
	const req = candidateRequest("b-1", 3, update, "cand-1");
	const serverDigest = createHash("sha256").update(candidateDigestMaterial([update])).digest("hex");
	ok(req.headers["x-yaos-candidate-digest"] === serverDigest, "DL probe: digest = server candidateDigestMaterial (single frame)");
	ok(req.path === "body/b-1/candidate" && req.headers["x-yaos-body-epoch"] === "3" && req.headers["content-type"] === "application/octet-stream",
		"DL probe: route + headers match VaultServerPort.submitCandidate");
	const batches = splitBatches(Array.from({ length: 25 }, (_v, i) => i), 10, 1_000_000, () => 1);
	ok(batches.length === 3 && batches.flat().length === 25 && batches.every((b) => b.length <= 10), "splitBatches ≤ maxFiles, keeps every item");
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
