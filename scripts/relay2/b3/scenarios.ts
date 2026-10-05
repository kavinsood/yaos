/**
 * b3-m-typing deployed scenarios (registered in bench.ts as A1R and IDLE0).
 *
 *  A1R   autosave plugin: one `--bytes` (50 KB) Excalidraw-like note rewritten every `--interval-ms` (5000) for
 *        `--minutes` (10) over the open-note socket path. `--mode rewrite` (default: whole-text delete + insert, the
 *        write-budget A1-rewrite shape that went to hash state "unknown"), `diff` (src/sync/diff.ts applyDiffToYText).
 *        After every save: HEAD body/:id (`x-yaos-content-hash-state`, head sequence). Rows: exact vault counter
 *        timeline (debug/sql-rows). Settles `--settle-ms` (240 s) after the create before the first save.
 *  IDLE0 settled vault (context seed = 100 notes + r2-lat), `--settle-min` (4) then `--minutes` (22) with NO requests
 *        and no sockets: one counter read at each end only (a poll would itself read rows and keep the DO alive).
 *        GraphQL over the quiet span is the authority (every DO class); see b3/gqlclasses.ts.
 */
import { createHash } from "node:crypto";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders } from "../../../tests/live/liveIdentity";
import { applyDiffToYText } from "../../../legacy-src/sync/diff";
import { dist, log, now, r2, sleep } from "../lib/common";
import { bodyGet, convergence, diagnostics } from "../lib/checks";
import { freshNotes, openOrThrow, type RunCtx } from "../lib/run";
import { RowsTimeline } from "./rowsTimeline";

type Result = Record<string, unknown>;
const iso = () => new Date().toISOString();

/** write-budget A1 drawing (1a56c79 scripts/relay2/wb/scenarios.ts drawingText), verbatim. */
export function drawingText(seed: number, bytes: number, version: number, changes = 2) {
	const n = Math.max(1, Math.floor(bytes / 125));
	const touched = new Map<number, number>();
	for (let v = 1; v <= version; v++) for (let c = 0; c < changes; c++) touched.set((seed * 7919 + v * 104_729 + c * 1_299_709) % n, v);
	const els: string[] = [];
	let len = 80;
	for (let i = 0; len < bytes; i++) {
		const v = touched.get(i % n) ?? 0;
		const e = `    {"id":"el-${i}","type":"rectangle","x":${(seed * 31 + i * 17 + v * 13) % 2000},"y":${(seed * 17 + i * 29 + v * 7) % 2000},"width":${80 + (i % 50)},"height":${40 + (i % 30)},"version":${1 + v},"strokeColor":"#1e1e1e"}`;
		els.push(e); len += e.length + 2;
	}
	return `{\n  "type": "excalidraw",\n  "version": ${version},\n  "elements": [\n${els.join(",\n")}\n  ]\n}\n`;
}

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

async function headState(ctx: RunCtx, bodyId: string) {
	const id = ctx.context.devices.A!;
	try {
		const r = await fetch(vaultRoute(id, `body/${encodeURIComponent(bodyId)}`), { method: "HEAD", headers: deviceBearerHeaders(id) });
		return { at: iso(), status: r.status, hashState: r.headers.get("x-yaos-content-hash-state"), contentHash: r.headers.get("x-yaos-content-hash") || null,
			headSequence: Number(r.headers.get("x-yaos-head-sequence")) };
	} catch (error) { return { at: iso(), status: null, error: String(error).slice(0, 160) }; }
}

export async function A1R(ctx: RunCtx): Promise<Result> {
	const bytes = ctx.num("bytes", 50_000), interval = ctx.num("interval-ms", 5000), minutes = ctx.num("minutes", 10);
	const mode = ctx.str("mode", "rewrite")!, changes = ctx.num("changes", 2);
	const writes = Math.round((minutes * 60_000) / interval);
	const [bodyId] = await freshNotes(ctx, "a1r", 1, () => drawingText(7, bytes, 0));
	const settleMs = ctx.num("settle-ms", 240_000);
	log(`A1R: created ${bodyId}; settling ${settleMs / 1000} s`);
	await sleep(settleMs);
	const a = await openOrThrow(await ctx.client("A", bodyId!), 60_000);
	const b = await openOrThrow(await ctx.client("B", bodyId!), 60_000);
	await sleep(3000);
	const probes: Result[] = [{ w: 0, ...(await headState(ctx, bodyId!)) }];
	const tl = new RowsTimeline(ctx.context, ctx.num("rows-poll-ms", 5000));
	await tl.start(); await sleep(10_000);
	tl.mark("typingStart");
	const start = iso();
	const t0 = now();
	const per: Result[] = [];
	let lastText = a.doc.getText("body").toString();
	for (let w = 1; w <= writes; w++) {
		const wait = t0 + (w - 1) * interval - now();
		if (wait > 0) await sleep(wait);
		const next = drawingText(7, bytes, w, changes);
		const f = a.editTracked((t) => {
			if (mode === "rewrite") { t.delete(0, t.length); t.insert(0, next); }
			else { const before = t.toString(); applyDiffToYText(t, before, next, "b3-a1r"); }
		});
		lastText = next;
		const sent = a.sent.at(-1);
		per.push({ w, frameId: f.frameId, sentAt: f.sentAt, updateBytes: sent?.clientFrameId === f.frameId ? sent.bytes : null, expectedHash: sha(next) });
		// Probe mid-interval: the group commit (idle 300 ms, min interval 1 s, max 1.5 s) has landed by then.
		const probeWait = t0 + (w - 1) * interval + Math.min(3000, interval - 500) - now();
		if (probeWait > 0) await sleep(probeWait);
		const h = await headState(ctx, bodyId!);
		probes.push({ w, ...h, matchesThisSave: h.contentHash === sha(next) });
		if (w % 12 === 0) log(`A1R ${w}/${writes} hashState=${h.hashState}`);
	}
	tl.mark("typingEnd");
	const ackDeadline = now() + 30_000;
	while (a.unacked > 0 && now() < ackDeadline) await sleep(100);
	tl.mark("acked");
	const end = iso();
	for (const p of per) {
		const k = a.acks.find((x) => x.frameId === p.frameId);
		p.receiptMs = k ? r2(k.at - (p.sentAt as number)) : null;
	}
	const afterAck = await headState(ctx, bodyId!);
	const get = await bodyGet(ctx.context.devices.A!, bodyId!);
	const finalHash = sha(lastText);
	const conv = await convergence({ bodyId: bodyId!, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000 });
	a.terminate(); b.terminate(); a.doc.destroy(); b.doc.destroy();
	// Projection: the vault alarm pass is due ~60 s after the first mutation after the previous pass.
	await sleep(ctx.num("post-wait-ms", 120_000));
	const afterProjection = await headState(ctx, bodyId!);
	const sqlRows = await tl.stop();
	const diag = await diagnostics(ctx.context.devices.A!);
	const states = probes.slice(1).map((p) => p.hashState as string | null);
	const count = (s: string) => states.filter((x) => x === s).length;
	const firstNotKnown = probes.slice(1).find((p) => p.hashState !== "known") ?? null;
	const segs = sqlRows.segments as Record<string, { rowsWritten: number | null }>;
	const typingRows = segs["typingStart→typingEnd"]?.rowsWritten ?? null;
	const total = (sqlRows.total as { rowsWritten: number | null }).rowsWritten;
	const hashPass = count("known") === states.length && afterAck.hashState === "known" && afterProjection.hashState === "known";
	return { bodyId, mode, bytes, intervalMs: interval, minutes, writes, window: { start, end }, settleMs,
		hashStates: { known: count("known"), unknown: count("unknown"), materialised: count("materialised"), other: states.length - count("known") - count("unknown") - count("materialised"),
			matchesThisSave: probes.filter((p) => p.matchesThisSave === true).length, firstNotKnown, afterAck, afterProjection, pass: hashPass },
		getFinal: { status: get.status, contentHash: (get as Result).contentHash ?? null, expected: finalHash, textMatches: get.text === lastText },
		rows: { typingWindow: typingRows, totalInclPost: total, perSaveTyping: typingRows === null ? null : r2(typingRows / writes),
			perSaveInclPost: total === null ? null : r2(total / writes) },
		receiptMs: dist(per.map((p) => p.receiptMs as number | null)), updateBytes: dist(per.map((p) => p.updateBytes as number | null)),
		sqlRows, probes, perWrite: per, vault: { vaultId: diag.vaultId ?? null, vaultGeneration: diag.vaultGeneration ?? null },
		convergence: { ...conv, pass: (conv as { pass: boolean }).pass && hashPass } };
}

export async function IDLE0(ctx: RunCtx): Promise<Result> {
	const settleMin = ctx.num("settle-min", 4), minutes = ctx.num("minutes", 22);
	const tl = new RowsTimeline(ctx.context, 60_000);
	const s0 = await tl.readNow(); const settleStart = iso();
	log(`IDLE0: settle ${settleMin} min (no requests)`);
	await sleep(settleMin * 60_000);
	const r0 = await tl.readNow(); const quietStart = iso();
	log(`IDLE0: quiet ${minutes} min (no requests, no sockets)`);
	await sleep(minutes * 60_000);
	const quietEnd = iso();
	const r1 = await tl.readNow();
	const diag = await diagnostics(ctx.context.devices.A!);
	const settle = tl.delta(s0, r0), quiet = tl.delta(r0, r1);
	// GraphQL window: whole minutes strictly inside the quiet span (the boundary reads land in the edge minutes).
	const gStart = new Date((Math.floor(Date.parse(quietStart) / 60_000) + 2) * 60_000).toISOString();
	const gEnd = new Date((Math.floor(Date.parse(quietEnd) / 60_000) - 1) * 60_000).toISOString();
	return { settleMin, minutes, settle: { window: { start: settleStart, end: quietStart }, rows: settle },
		window: { start: quietStart, end: quietEnd }, gqlWindow: { start: gStart, end: gEnd }, quietCounter: quiet,
		note: "counter is in memory: a reset (eviction) between the two reads makes the delta null; GraphQL over gqlWindow (all DO classes) is the authority",
		vault: { vaultId: diag.vaultId ?? null, vaultGeneration: diag.vaultGeneration ?? null },
		convergence: { pass: quiet.counterReset ? null : quiet.rowsWritten === 0 } };
}
