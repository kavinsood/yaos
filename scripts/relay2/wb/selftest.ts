/**
 * Offline self-test for the W4 harness (no server needed):
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/wb/selftest.ts [--manifests <dir>]
 * Checks: corpus determinism + shape, rows-payload parsing, batch splitting caps, the batch fit. `--manifests` writes 2k/10k/25k/drop manifests (never into git).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flagStr, parseArgs } from "../lib/common";
import { buildCorpus, corpusDigest, corpusStats, manifestJson, noteText, presetSpec, rng } from "./corpus";
import { parseRowsPayload, rowsDelta, splitBatches, type CreateInput } from "./adapters";
import { applyMinimalDiff, fitBatches } from "./scenarios";
import * as Y from "yjs";

let failures = 0, checks = 0;
function ok(cond: unknown, what: string) { checks++; if (!cond) { failures++; console.error(`FAIL ${what}`); } }

// ---------------------------------------------------------------- corpus
{
	const a = buildCorpus(presetSpec("2k", "wb1"), "p"), b = buildCorpus(presetSpec("2k", "wb1"), "p"), c = buildCorpus(presetSpec("2k", "wb2"), "p");
	ok(corpusDigest(a) === corpusDigest(b), "corpus: same seed → same manifest digest");
	ok(corpusDigest(a, true) === corpusDigest(b, true), "corpus: same seed → same content digest");
	ok(corpusDigest(a) !== corpusDigest(c), "corpus: different seed → different digest");
	const s = corpusStats(a) as Record<string, any>;
	ok(a.notes.length === 2000 && a.attachments.length === 100, "corpus: 2k counts");
	ok(a.notes.filter((n) => n.huge).length >= 2 && a.notes.some((n) => n.bytes > 1_750_000), "corpus: >1.75 MB notes present");
	ok(new Set(a.notes.map((n) => n.path)).size === a.notes.length, "corpus: unique note paths");
	ok(new Set(a.notes.map((n) => n.bodyId)).size === a.notes.length, "corpus: unique body ids");
	for (const n of a.notes.slice(0, 200)) ok(Buffer.byteLength(noteText(n, a)) === n.bytes, `corpus: exact byte length ${n.path}`);
	const sorted = a.notes.map((n) => n.bytes).sort((x, y) => x - y);
	const p50 = sorted[Math.floor(sorted.length / 2)]!;
	ok(p50 > 1500 && p50 < 2800, `corpus: median ~2 KB (got ${p50})`);
	ok(a.notes.filter((n) => !n.huge).every((n) => n.bytes <= 200 * 1024), "corpus: non-huge tail ≤ 200 KB");
	ok(a.folders.some((f) => f.split("/").length >= 3), "corpus: nested folders");
	const d = buildCorpus(presetSpec("drop", "wb1"), "p");
	ok(d.notes.length === 200 && d.attachments.length === 50 && d.attachments.every((x) => x.mime === "image/png"), "corpus: drop set 200 + 50 png");
	ok(!d.notes.some((n) => a.notes.some((m) => m.path === n.path)), "corpus: drop paths disjoint from 2k");
	const t = buildCorpus(presetSpec("10k", "wb1"), "p"), u = buildCorpus(presetSpec("25k", "wb1"), "p");
	ok(t.notes.length === 10000 && u.notes.length === 25000, "corpus: 10k/25k counts");
	console.log(`corpus 2k: ${JSON.stringify({ digest: corpusDigest(a).slice(0, 12), p50: s.noteBytes?.p50 ?? p50, folders: a.folders.length })}`);
	const dir = flagStr(parseArgs(), "manifests");
	if (dir) {
		mkdirSync(dir, { recursive: true });
		for (const [name, corpus] of [["2k", a], ["10k", t], ["25k", u], ["drop", d]] as const)
			writeFileSync(join(dir, `manifest-${name}.json`), JSON.stringify(manifestJson(corpus), null, 1));
		console.log(`manifests → ${dir}`);
	}
}

// ---------------------------------------------------------------- rows payloads
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
	const base = { rowsWritten: 100, rowsRead: 10, source: "debug-route", exact: true, at: 0, ms: 1 } as never;
	const d = rowsDelta(base, { rowsWritten: 130, rowsRead: 12, source: "debug-route", exact: true, at: 1, ms: 1 } as never);
	ok(d.rowsWritten === 30 && !d.counterReset, "rowsDelta simple");
	const reset = rowsDelta(base, { rowsWritten: 5, rowsRead: 1, source: "debug-route", exact: true, at: 1, ms: 1 } as never);
	ok(reset.counterReset, "rowsDelta flags counter reset (DO restart)");
}

// ---------------------------------------------------------------- batching + fit + minimal diff
{
	const items: CreateInput[] = Array.from({ length: 1203 }, (_v, i) => ({ kind: "note", path: `n${i}.md`, bodyId: `b${i}`, content: "x".repeat(i === 7 ? 5_000_000 : 3000) }));
	const batches = splitBatches(items, 500, 4 * 1024 * 1024);
	ok(batches.flat().length === items.length, "splitBatches keeps every item");
	ok(batches.every((b) => b.length <= 500), "splitBatches ≤ 500 files");
	const big = batches.find((b) => b.some((x) => x.kind === "note" && x.content.length === 5_000_000));
	ok(big?.length === 1, "splitBatches: oversize item travels alone");
	ok(batches.filter((b) => b !== big).every((b) => b.reduce((s, x) => s + (x.kind === "note" ? x.content.length : x.bytes.byteLength), 0) <= 4 * 1024 * 1024), "splitBatches ≤ 4 MB");
	const fit = fitBatches([{ notes: 500, attachments: 0, rows: 2005 }, { notes: 300, attachments: 0, rows: 1205 }, { notes: 100, attachments: 0, rows: 405 }]);
	ok(fit && Math.abs(fit.rowsPerNote - 4) < 0.01 && Math.abs(fit.rowsPerBatch - 5) < 0.01, `fitBatches ${JSON.stringify(fit)}`);
	const fit2 = fitBatches([{ notes: 500, attachments: 10, rows: 2005 + 30 }, { notes: 300, attachments: 0, rows: 1205 }, { notes: 100, attachments: 40, rows: 405 + 120 }, { notes: 50, attachments: 5, rows: 205 + 15 }]);
	ok(fit2 && Math.abs(fit2.rowsPerAttachment! - 3) < 0.01, `fitBatches with attachments ${JSON.stringify(fit2)}`);
	const doc = new Y.Doc(); const t = doc.getText("body"); t.insert(0, "hello brave new world");
	const r = applyMinimalDiff(t, "hello cruel new world");
	ok(t.toString() === "hello cruel new world" && r.deleted === 5 && r.inserted === 5, `applyMinimalDiff ${JSON.stringify(r)}`);
}

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
