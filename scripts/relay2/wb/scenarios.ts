/**
 * W4 write-budget scenarios (PHASE3-WRITE-BUDGET-SPIKE §3 W4). Registered in bench.ts; run like every relay2 scenario:
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts <I1|I2|I3|I4> --host <url>
 *        --adapter relay --out <json> [--create legacy|bulk] [--rows-route debug/sql-rows] [--rows-mode auto|debug-route|relay-diagnostics|none]
 *        [scenario flags]
 *
 * Rows come from adapters.RowsCounter (W1 exact counter; falls back to the relay in-memory counter, labelled). Every
 * scenario also records wall-clock windows so gql.ts can cross-check rowsWritten (§3 W4 "cross-check once").
 * `implemented`/`source` fields say which parts ran against real W1/W2/W3 code and which against fallbacks.
 *
 * Batch 3 (b3-bulk) port onto relay3: bulk-create scenarios I1–I4 only. C4W/XCRASH (W1 typing), R1 (W3 merge),
 * A1 and L5R stay on write-budget-spike. I4 defaults to the real VaultSync client (realScenarios.ts).
 */
import * as Y from "yjs";
import { connectDocument } from "../../../tests/live/schema4Live";
import { log, now, r2, sleep, dist } from "../lib/common";
import { convergence, bodyGet } from "../lib/checks";
import { contentHashOf } from "../lib/rawClient";
import { openOrThrow, type RunCtx } from "../lib/run";
import { attachmentBytes, buildCorpus, corpusDigest, corpusStats, noteText, presetSpec, type Corpus } from "./corpus";
import {
	createAdapterFor, listHeads, outcomeCounts, rootMaps, RowsCounter, rowsDelta,
	type CreateAdapter, type CreateBatch, type CreateInput, type CreateResult, type RowsReading,
} from "./adapters";

type Result = Record<string, unknown>;

// ------------------------------------------------------------------ shared helpers
/** Relay-off (base) runs only use the exact route: the relay-diagnostics fallback counts relay appends, meaningless there. */
export function rowsCounter(ctx: RunCtx) {
	const mode = ctx.str("rows-mode") ?? process.env.WB_ROWS_MODE ?? (ctx.adapter.name === "base" ? "debug-route" : "auto");
	return new RowsCounter(ctx.context, ctx.str("rows-route"), mode);
}
function creator(ctx: RunCtx): CreateAdapter { return createAdapterFor(ctx.str("create"), contentHashOf); }
const iso = () => new Date().toISOString();
const perUnit = (rows: number | null, units: number) => (rows === null || !units ? null : r2(rows / units));

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

/** Size of the changed middle between two texts (common prefix/suffix stripped) — for reporting only. */
export function changedSpan(a: string, b: string) {
	let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
	let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	return { deleted: a.length - p - s, inserted: b.length - p - s };
}

/** Least squares rows ≈ a·notes + c·attachments + b over batches (per-batch counter reads). */
export function fitBatches(batches: Array<{ notes: number; attachments: number; rows: number }>) {
	const pts = batches.filter((b) => Number.isFinite(b.rows));
	if (pts.length < 3) return null;
	const useAtt = pts.some((b) => b.attachments > 0) && pts.some((b) => b.attachments !== pts[0]!.attachments);
	const X = pts.map((b) => (useAtt ? [b.notes, b.attachments, 1] : [b.notes, 1]));
	const k = X[0]!.length;
	const A = Array.from({ length: k }, (_v, i) => Array.from({ length: k + 1 }, (_w, j) => 0));
	pts.forEach((b, n) => { for (let i = 0; i < k; i++) { for (let j = 0; j < k; j++) A[i]![j]! += X[n]![i]! * X[n]![j]!; A[i]![k]! += X[n]![i]! * b.rows; } });
	for (let i = 0; i < k; i++) {
		let piv = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r]![i]!) > Math.abs(A[piv]![i]!)) piv = r;
		[A[i], A[piv]] = [A[piv]!, A[i]!];
		if (Math.abs(A[i]![i]!) < 1e-9) return null;
		for (let r = 0; r < k; r++) if (r !== i) { const f = A[r]![i]! / A[i]![i]!; for (let j = i; j <= k; j++) A[r]![j]! -= f * A[i]![j]!; }
	}
	const sol = A.map((row, i) => row[k]! / row[i]!);
	return useAtt ? { rowsPerNote: r2(sol[0]!), rowsPerAttachment: r2(sol[1]!), rowsPerBatch: r2(sol[2]!), batches: pts.length }
		: { rowsPerNote: r2(sol[0]!), rowsPerAttachment: null, rowsPerBatch: r2(sol[1]!), batches: pts.length };
}

export function corpusInputs(corpus: Corpus, withAttachments: boolean): CreateInput[] {
	const items: CreateInput[] = corpus.notes.map((n) => ({ kind: "note" as const, path: n.path, bodyId: n.bodyId, content: noteText(n, corpus) }));
	if (withAttachments) for (const a of corpus.attachments) items.push({ kind: "attachment", path: a.path, bytes: attachmentBytes(a), mime: a.mime });
	// Folder order, like a vault walk / folder drop (attachments interleave with notes of the same folder).
	return items.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Create items through the adapter, reading the rows counter after every batch (exact per-batch rows). */
export async function measuredCreate(ctx: RunCtx, rows: RowsCounter, adapter: CreateAdapter, items: CreateInput[], device = "A") {
	const r0 = await rows.read();
	let prev: RowsReading = r0;
	const window = { start: iso(), end: "" };
	const t0 = now();
	const res = await adapter.create(ctx.context, items, {
		device, maxFiles: ctx.num("max-files", 500), maxBytes: ctx.num("max-bytes", 4 * 1024 * 1024),
		afterBatch: async (b: CreateBatch) => { const r = await rows.read(); b.rows = rowsDelta(prev, r); prev = r; },
		onProgress: (d, t) => { if (d % 250 < 1 || d === t) log(`${ctx.scenario} create ${d}/${t}`); },
	});
	const wallMs = r2(now() - t0);
	await sleep(ctx.num("settle-ms", 5000));
	const r1 = await rows.read();
	window.end = iso();
	return { res, wallMs, window, total: rowsDelta(r0, r1), settleRows: rowsDelta(prev, r1) };
}

export function createSummary(res: CreateResult, total: ReturnType<typeof rowsDelta>, files: { notes: number; attachments: number }, wallMs: number) {
	const fit = fitBatches(res.batches.filter((b) => b.rows?.rowsWritten != null && !b.error)
		.map((b) => ({ notes: b.notes, attachments: b.attachments, rows: b.rows!.rowsWritten! })));
	const totalFiles = files.notes + files.attachments;
	return {
		adapter: res.adapter, adapterImplemented: res.implemented, outcomes: outcomeCounts(res),
		totalRowsWritten: total.rowsWritten, totalRowsRead: total.rowsRead, rowsSource: total.source, rowsExact: total.exact,
		rowsPerFile: perUnit(total.rowsWritten, totalFiles), rowsPerNoteAllIn: perUnit(total.rowsWritten, files.notes),
		fit, requests: res.requests, blobUploads: res.blobUploads, batches: res.batches.length, oversizeSingles: res.oversizeSingles,
		wallMs, batchMs: dist(res.batches.map((b) => b.ms)),
		errors: res.outcomes.filter((o) => o.outcome === "error").slice(0, 20),
		errorKinds: Object.entries(res.outcomes.filter((o) => o.outcome === "error" || o.outcome === "rejected").reduce((m, o) => {
			const k = `${o.path.split(".").pop()}: ${String(o.detail ?? o.outcome).slice(0, 160)}`; m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>)),
	};
}

/** Verify every note via the active catalog (path → contentHash) and attachments via the root's pathToBlob. */
export async function verifyCorpus(ctx: RunCtx, corpus: Corpus, device = "B", withAttachments = true) {
	const id = await ctx.dev(device);
	const heads = await listHeads(id);
	const byPath = new Map(heads.entries.map((e) => [e.path, e]));
	let missing = 0, mismatched = 0;
	const examples: Result[] = [];
	for (const n of corpus.notes) {
		const e = byPath.get(n.path);
		if (!e) { missing++; if (examples.length < 10) examples.push({ path: n.path, problem: "missing" }); continue; }
		const want = contentHashOf(noteText(n, corpus)).contentHash;
		if (e.contentHash !== want) { mismatched++; if (examples.length < 10) examples.push({ path: n.path, problem: "hash", got: e.contentHash, want }); }
	}
	let attachmentsMissing: number | null = null;
	if (withAttachments && corpus.attachments.length) {
		const root = await rootMaps(id);
		attachmentsMissing = corpus.attachments.filter((a) => !root.pathToBlob.has(a.path)).length;
	}
	// Spot-check full bodies: every huge note (chunked) + a few others.
	const spot = [...corpus.notes.filter((n) => n.huge), ...corpus.notes.filter((_n, i) => i % Math.max(1, Math.floor(corpus.notes.length / 5)) === 0)];
	const bodyChecks: Result[] = [];
	for (const n of spot) {
		const e = byPath.get(n.path);
		if (!e) { bodyChecks.push({ path: n.path, ok: false, problem: "missing" }); continue; }
		const g = await bodyGet(id, e.bodyId);
		bodyChecks.push({ path: n.path, bytes: n.bytes, ok: g.text === noteText(n, corpus), status: g.status, ms: g.elapsedMs });
	}
	const pass = missing === 0 && mismatched === 0 && (attachmentsMissing ?? 0) === 0 && bodyChecks.every((b) => b.ok);
	return { pass, notes: corpus.notes.length, missing, mismatched, attachmentsMissing, headsRequests: heads.requests, headsMs: heads.ms,
		catalogEntries: heads.entries.length, bodyChecks, examples };
}

// ================================================================================================= I1 / I2
export async function firstOpen(ctx: RunCtx, rows: RowsCounter, corpus: Corpus, withAtt: boolean) {
	const items = corpusInputs(corpus, withAtt);
	log(`I1: ${corpus.notes.length} notes + ${withAtt ? corpus.attachments.length : 0} attachments via ${creator(ctx).name}`);
	const m = await measuredCreate(ctx, rows, creator(ctx), items, "A");
	const summary = createSummary(m.res, m.total, { notes: corpus.notes.length, attachments: withAtt ? corpus.attachments.length : 0 }, m.wallMs);
	const verification = await verifyCorpus(ctx, corpus, "B", withAtt);
	return { ...summary, window: m.window, settleRows: m.settleRows, verification,
		perBatch: m.res.batches.map((b) => ({ i: b.index, files: b.files, notes: b.notes, attachments: b.attachments, bytes: b.bytes, ms: b.ms,
			status: b.httpStatus, requests: b.requests, rows: b.rows?.rowsWritten ?? null, rowsRead: b.rows?.rowsRead ?? null,
			startedAtWall: b.startedAtWall, endedAtWall: b.endedAtWall, error: b.error })),
		cpuHint: "DO CPU per batch: run with --tail and join perBatch[].startedAtWall/endedAtWall with tail request events (wb/batchcpu.py)" };
}

/**
 * `--path-prefix <p>|auto`: put the corpus under a folder (auto = `WB-<tag>/`) so repeated runs can share one vault
 * (local dry-runs). runfast phases get a fresh vault each and use the corpus paths as generated. Links are by
 * basename, so the prefix does not change note content.
 */
export function corpusFor(ctx: RunCtx, preset = ctx.str("preset", "2k")!) {
	const corpus = buildCorpus(presetSpec(preset, ctx.str("seed", "wb1")), `${ctx.tag}-${preset}`); // bodyIds unique per preset (I3 prefill + drop)
	const flag = ctx.str("path-prefix");
	const prefix = !flag ? "" : flag === "auto" ? `WB-${ctx.tag}/` : flag.replace(/\/?$/, "/");
	if (prefix) {
		for (const n of corpus.notes) n.path = prefix + n.path;
		for (const a of corpus.attachments) a.path = prefix + a.path;
		corpus.folders = corpus.folders.map((f) => prefix + f);
	}
	return { corpus, info: { preset, seed: corpus.spec.seed, pathPrefix: prefix || null, digest: corpusDigest(corpus), stats: corpusStats(corpus) } };
}
const outcomeCountsOf = (r: CreateResult) => ({ outcomes: outcomeCounts(r) });
const createErrors = (r: { outcomes: Record<string, number> }) => Object.entries(r.outcomes).filter(([k]) => k === "error" || k === "rejected").reduce((s, [, v]) => s + v, 0);

/** I1 first open: `--preset 2k` corpus (+ attachments unless --no-attachments) from device A; verified from device B. */
export async function I1(ctx: RunCtx): Promise<Result> {
	const rows = rowsCounter(ctx);
	const { corpus, info } = corpusFor(ctx);
	const r = await firstOpen(ctx, rows, corpus, !ctx.args.flags["no-attachments"]);
	return { corpus: info, rowsCounter: { source: rows.source }, ...r,
		convergence: { pass: r.verification.pass && createErrors(r) === 0, createErrors: createErrors(r), verification: "catalog+root+bodies" } };
}

/**
 * I2 second device first open: seed with I1 (device A), then device B "opens" the same vault holding identical files.
 *  - catalog mode (works today): B lists the active catalog and compares content hashes locally (D4 no-base identical → skip).
 *  - bulk mode (W2 create-bulk): B sends every file with its own bodyIds; expect all `exists-identical` and 0 rows.
 * Expect ~0 rows written in both.
 */
export async function I2(ctx: RunCtx): Promise<Result> {
	const rows = rowsCounter(ctx);
	const { corpus, info } = corpusFor(ctx);
	const withAtt = !ctx.args.flags["no-attachments"];
	// --no-seed: the vault already holds this corpus (e.g. an I1P run on the same vault); bodyIds differ, content/paths match.
	const noSeed = Boolean(ctx.args.flags["no-seed"]);
	const seed = noSeed ? null : await firstOpen(ctx, rows, corpus, withAtt);
	if (seed) await sleep(ctx.num("settle-ms", 5000));
	const out: Result = { corpus: info, seedRun: seed ?? "skipped (--no-seed)" };
	// catalog mode
	{
		const r0 = await rows.read(); const start = iso();
		const t0 = now();
		const heads = await listHeads(await ctx.dev("B"));
		const byPath = new Map(heads.entries.map((e) => [e.path, e.contentHash]));
		let identical = 0, different = 0, absent = 0;
		for (const n of corpus.notes) {
			const h = byPath.get(n.path);
			if (h === undefined) absent++; else if (h === contentHashOf(noteText(n, corpus)).contentHash) identical++; else different++;
		}
		const ms = r2(now() - t0);
		await sleep(ctx.num("settle-ms", 5000));
		const r1 = await rows.read();
		out.catalog = { window: { start, end: iso() }, rows: rowsDelta(r0, r1), identical, different, absent, requests: heads.requests, ms,
			pass: different === 0 && absent === 0 && (rowsDelta(r0, r1).rowsWritten ?? 0) === 0 };
	}
	// bulk mode
	const adapter = creator(ctx);
	if (adapter.name === "bulk") {
		// B is a different device: it mints its own bodyIds (reusing A's would be an identity overlap, W2 → 409 partial_overlap).
		const items = corpusInputs(corpus, withAtt).map((i) => i.kind === "note" ? { ...i, bodyId: `${i.bodyId}-devB` } : i);
		const m = await measuredCreate(ctx, rows, adapter, items, "B");
		const counts = outcomeCounts(m.res);
		out.bulk = { ...createSummary(m.res, m.total, { notes: corpus.notes.length, attachments: withAtt ? corpus.attachments.length : 0 }, m.wallMs),
			window: m.window, pass: (counts["exists-identical"] ?? 0) === items.length && (m.total.rowsWritten ?? 1) <= ctx.num("max-rows", 10) };
	} else out.bulk = { skipped: "create adapter is legacy (run with --create bulk against a W2 server)" };
	const c = out.catalog as Result, bk = out.bulk as Result;
	out.convergence = { pass: (seed ? seed.verification.pass && createErrors(seed) === 0 : true) && c.pass === true && (bk.skipped ? true : bk.pass === true), seedCreateErrors: seed ? createErrors(seed) : null };
	return out;
}

// ================================================================================================= I3
/**
 * I3 folder drop: 200 notes + 50 png (`--preset drop`) created from device A while B and C hold root sockets.
 * Reports rows and per-item time to visible (path in the peer's root pathToId/pathToBlob), plus a body spot check from C.
 *   --prefill <preset>  seed a vault first (not measured), e.g. 2k, so the drop lands in a big live vault.
 */
export async function I3(ctx: RunCtx): Promise<Result> {
	const rows = rowsCounter(ctx);
	const prefill = ctx.str("prefill");
	let prefillInfo: Result | null = null;
	if (prefill) {
		const { corpus } = corpusFor(ctx, prefill);
		const r = await creator(ctx).create(ctx.context, corpusInputs(corpus, true));
		prefillInfo = { preset: prefill, outcomes: outcomeCounts(r), wallMs: r.wallMs };
	}
	const { corpus, info } = corpusFor(ctx, "drop");
	const want = new Set([...corpus.notes.map((n) => n.path), ...corpus.attachments.map((a) => a.path)]);
	const peers = ["B", "C"];
	const seen: Record<string, Map<string, number>> = {};
	const docs = [];
	let dropStart = 0;
	for (const p of peers) {
		const conn = await connectDocument(await ctx.dev(p), "root", "root");
		await sleep(500);
		const m = new Map<string, number>(); seen[p] = m;
		const scan = () => {
			if (!dropStart) return;
			const at = now();
			for (const key of [...conn.doc.getMap("pathToId").keys(), ...conn.doc.getMap("pathToBlob").keys()])
				if (want.has(key) && !m.has(key)) m.set(key, r2(at - dropStart));
		};
		conn.doc.on("update", scan);
		docs.push({ p, conn, scan });
	}
	await sleep(2000);
	const items = corpusInputs(corpus, true);
	const r0 = await rows.read(); const start = iso();
	dropStart = now();
	const res = await creator(ctx).create(ctx.context, items, { maxFiles: ctx.num("max-files", 500), maxBytes: ctx.num("max-bytes", 4 * 1024 * 1024) });
	const createMs = r2(now() - dropStart);
	const deadline = now() + ctx.num("visible-timeout-ms", 120_000);
	while (now() < deadline && peers.some((p) => seen[p]!.size < want.size)) { for (const d of docs) d.scan(); await sleep(200); }
	await sleep(ctx.num("settle-ms", 5000));
	const r1 = await rows.read();
	const total = rowsDelta(r0, r1);
	const visible: Result = {};
	for (const p of peers) {
		const m = seen[p]!;
		visible[p] = { visible: m.size, of: want.size, allVisibleMs: m.size === want.size ? Math.max(...m.values()) : null,
			perItemMs: dist([...m.values()]), notesMs: dist(corpus.notes.map((n) => m.get(n.path))), imagesMs: dist(corpus.attachments.map((a) => m.get(a.path))) };
	}
	for (const d of docs) d.conn.destroy();
	const verification = await verifyCorpus(ctx, corpus, "C", true);
	return { corpus: info, prefill: prefillInfo, window: { start, end: iso() }, createMs,
		...createSummary(res, total, { notes: corpus.notes.length, attachments: corpus.attachments.length }, createMs),
		peers: visible, verification, convergence: { pass: verification.pass && createErrors(outcomeCountsOf(res)) === 0 && peers.every((p) => (visible[p] as Result).allVisibleMs !== null) } };
}

// ================================================================================================= I4
/**
 * I4 create-then-paste (D5), emulating the client rule at the protocol level:
 *   fold  — paste lands before the create collector (`--collector-ms` 300) flushes → folded into the create snapshot
 *   hold  — paste lands after the create was sent but before its receipt → held, sent after the receipt
 *   after — paste lands `--late-ms` (3000) after the create → plain body edit
 * `--paste-at-ms` (100) is the fold paste time. Asserts no body frame precedes the create receipt; reports rows per case
 * and time until peer B sees the final text. Default is the REAL client (realScenarios.I4real: VaultSync's create
 * collector in Node); `--client emulated` keeps this protocol-level emulation.
 */
export async function I4(ctx: RunCtx): Promise<Result> {
	if (ctx.str("client", "real") !== "emulated") return (await import("./realScenarios")).I4real(ctx);
	const rows = rowsCounter(ctx);
	const adapter = creator(ctx);
	const collector = ctx.num("collector-ms", 300), pasteAt = ctx.num("paste-at-ms", 100), late = ctx.num("late-ms", 3000);
	const cases = (ctx.str("cases", "fold,hold,after")!).split(",");
	const reps = ctx.num("reps", 3);
	const paste = noteText({ kind: "note", index: 0, path: "paste.md", bodyId: "x", bytes: ctx.num("paste-bytes", 10_000), seed: 99, huge: false });
	const template = "# New note\n";
	const out: Result[] = [];
	for (const name of cases) for (let rep = 0; rep < reps; rep++) {
		const bodyId = `${ctx.tag}-i4-${name}-${rep}`;
		const path = `WB/${ctx.tag}/i4-${name}-${rep}.md`;
		const r0 = await rows.read();
		const t0 = now();
		const ev: Result = { case: name, rep, bodyId };
		let expected = template;
		let editBeforeReceipt = false;
		if (name === "fold") {
			await sleep(pasteAt); // paste arrives inside the collector window
			expected = template + paste;
			await sleep(Math.max(0, collector - pasteAt));
			const s = now();
			const r = await adapter.create(ctx.context, [{ kind: "note", path, bodyId, content: expected }]);
			ev.createSentMs = r2(s - t0); ev.createReceiptMs = r2(now() - t0); ev.outcome = r.outcomes[0]?.outcome;
		} else {
			await sleep(collector);
			const s = now();
			const pending = adapter.create(ctx.context, [{ kind: "note", path, bodyId, content: template }]).then((r) => ({ r, at: now() }));
			ev.createSentMs = r2(s - t0);
			if (name === "after") await sleep(late);
			else await sleep(Math.min(20, collector)); // paste while the create is in flight
			const pasteWanted = now();
			const created = await pending; // hold until the create receipt
			ev.createReceiptMs = r2(created.at - t0); ev.outcome = created.r.outcomes[0]?.outcome;
			ev.pasteHeldMs = r2(Math.max(0, created.at - pasteWanted));
			editBeforeReceipt = pasteWanted < created.at && name === "after"; // "after" must not need holding
			const a = await openOrThrow(await ctx.client("A", bodyId), 60_000);
			a.editTracked((t) => t.insert(t.length, paste));
			expected = template + paste;
			ev.pasteSentMs = r2(now() - t0);
			await sleep(200);
			await a.close();
		}
		const b = await openOrThrow(await ctx.client("B", bodyId), 60_000);
		const visibleAt = await b.waitText((t) => t === expected, 20_000);
		ev.peerVisibleMs = visibleAt === null ? null : r2(visibleAt - t0);
		await b.close();
		await sleep(ctx.num("settle-ms", 3000));
		const r1 = await rows.read();
		ev.rows = rowsDelta(r0, r1);
		const g = await bodyGet(await ctx.dev("C"), bodyId);
		ev.serverTextOk = g.text === expected;
		ev.editBeforeReceipt = editBeforeReceipt;
		out.push(ev);
		log(`I4 ${name}#${rep}: rows ${(ev.rows as Result).rowsWritten} visible ${ev.peerVisibleMs} ok ${ev.serverTextOk}`);
	}
	const byCase: Result = {};
	for (const name of cases) {
		const xs = out.filter((e) => e.case === name);
		byCase[name] = { rows: dist(xs.map((e) => (e.rows as Result).rowsWritten as number | null)), peerVisibleMs: dist(xs.map((e) => e.peerVisibleMs as number | null)),
			allTextOk: xs.every((e) => e.serverTextOk) };
	}
	return { adapter: adapter.name, adapterImplemented: adapter.implemented, emulated: "D5 rule emulated in the harness (--client emulated; default is the real VaultSync client)",
		byCase, cases: out, convergence: { pass: out.every((e) => e.serverTextOk && !e.editBeforeReceipt && e.peerVisibleMs !== null) } };
}
