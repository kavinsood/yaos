/**
 * §7.2 server-cost scenarios: C1 (isolated keystroke CPU, joined with tail), C3 (memory ramp), C4 (rows per edit/reconnect).
 */
import { log, now, r2, series, sleep } from "../lib/common";
import { saveContext, seedNotes, smallId, wordsContent } from "../lib/context";
import { convergence, diagnostics } from "../lib/checks";
import { RawClient } from "../lib/rawClient";
import { freshSmallNote, freshTraceBody, keystrokes, loadTrace, openOrThrow, replayTrace, type RunCtx } from "../lib/run";

type Result = Record<string, unknown>;

async function isolated(ctx: RunCtx, body: string, n: number, spacing: number) {
	const a = await openOrThrow(await ctx.client("A", body), 60_000);
	const b = await openOrThrow(await ctx.client("B", body), 60_000);
	await sleep(3000);
	const windowStart = new Date().toISOString();
	const samples = await keystrokes(a, b, n, spacing, { position: "middle",
		onSample: (s) => { if (s.i % 10 === 0) log(`C1 ${body} ${s.i}/${n} prop=${s.propagationMs}`); } });
	const windowEnd = new Date().toISOString();
	const conv = await convergence({ bodyId: body, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 20_000 });
	const textLength = a.text().length;
	await a.close(); await b.close();
	return { bodyId: body, n, spacingMs: spacing, textLength, windowStart, windowEnd,
		propagationMs: series(samples.map((s) => s.propagationMs), 0), originAckMs: series(samples.map((s) => s.ackMs), 0),
		samples, convergence: conv };
}

/**
 * Isolated keystrokes ≥2 s apart so each maps to one tail event. Run with --tail (or scripts/relay2/tail.sh)
 * and join with scripts/relay2/analyze.py. `--which small|heavy|both`; heavy = quick-trace body after replay.
 */
export async function C1(ctx: RunCtx): Promise<Result> {
	const n = ctx.n(40);
	const spacing = Math.max(2000, ctx.num("spacing", 2300));
	const which = ctx.str("which", "both")!;
	const result: Result = { n, spacingMs: spacing };
	const convs: Result[] = [];
	if (which !== "heavy") {
		const small = await isolated(ctx, await freshSmallNote(ctx), n, spacing);
		result.small = small; convs.push(small.convergence);
	}
	if (which !== "small") {
		let heavy = ctx.str("heavy-body");
		if (!heavy) {
			const trace = loadTrace();
			heavy = await freshTraceBody(ctx, trace, "heavy");
			const a = await openOrThrow(await ctx.client("A", heavy), 60_000);
			const rate = ctx.num("replay-rate", 100);
			log(`C1 building heavy body: replaying ${trace.frames.length} frames at ${rate}/s`);
			const replay = await replayTrace(a, trace.frames, rate);
			await sleep(5000);
			await a.close();
			result.heavyBuild = { frames: replay.sent, rate, durationMs: replay.durationMs };
		}
		await sleep(5000);
		const h = await isolated(ctx, heavy, n, spacing);
		result.heavy = h; convs.push(h.convergence);
	}
	result.convergence = { pass: convs.every((c) => (c as { pass: boolean }).pass), parts: convs };
	return result;
}

const BIG_BYTES = 512 * 1024;
const bigId = (i: number) => `r2-big-${String(i).padStart(2, "0")}`;

async function ensureBig(ctx: RunCtx, count: number) {
	const seeded = (ctx.context.seeded?.big as number | undefined) ?? 0;
	if (seeded >= count) return;
	const inputs = Array.from({ length: count - seeded }, (_v, k) => {
		const i = seeded + k;
		return { bodyId: bigId(i), path: `R2/big-${String(i).padStart(2, "0")}.md`, content: wordsContent(i, BIG_BYTES) };
	});
	await seedNotes(ctx.context, inputs, 3 * 1024 * 1024);
	ctx.context.seeded = { ...(ctx.context.seeded ?? {}), big: count };
	saveContext(ctx.context);
}

/**
 * Wasm memory / resident docs after holding 1, 8, 32, 100 × 4 KiB body sockets, then 32 × 512 KiB.
 * Needs a freshly deployed worker for a clean isolate (Wasm memory never shrinks). `--seed-only` seeds the big notes.
 */
export async function C3(ctx: RunCtx): Promise<Result> {
	const bigCount = ctx.num("big", 32);
	const steps = (ctx.str("steps", "1,8,32,100")!).split(",").map(Number);
	if (!ctx.args.flags["skip-big"]) await ensureBig(ctx, bigCount);
	if (ctx.args.flags["seed-only"]) return { seeded: bigCount };
	const snapshots: Result[] = [{ step: "start", ...(await diagnostics(ctx.context.devices.A!)) }];
	const clients: RawClient[] = [];
	const failures: Result[] = [];
	for (const target of steps) {
		while (clients.length < target) {
			const i = clients.length + failures.length;
			if (i >= 100) break;
			const c = await ctx.client(i % 2 ? "B" : "A", smallId(i % 100));
			const t0 = now();
			const outcome = await c.open(30_000);
			if (outcome.status === "ok") clients.push(c);
			else { failures.push({ index: i, ...outcome, ms: r2(now() - t0) }); if (failures.length > 5) break; }
		}
		await sleep(1000);
		snapshots.push({ step: `small-${target}`, open: clients.filter((c) => c.isOpen).length, failures: failures.length,
			...(await diagnostics(ctx.context.devices.A!)) });
		log(`C3 small step ${target}: open=${clients.filter((c) => c.isOpen).length} failures=${failures.length}`);
	}
	for (const c of clients) await c.close();
	await sleep(3000);
	snapshots.push({ step: "small-closed", ...(await diagnostics(ctx.context.devices.A!)) });
	const bigClients: RawClient[] = [];
	const bigResults: Result[] = [];
	if (!ctx.args.flags["skip-big"]) {
		for (let i = 0; i < bigCount; i++) {
			const c = await ctx.client(i % 2 ? "B" : "A", bigId(i));
			const outcome = await c.open(60_000);
			bigResults.push({ index: i, ...outcome, totalMs: r2(now() - c.startedAt), phases: c.openPhases(), bytesIn: c.bytesIn,
				correct: outcome.status === "ok" ? c.text() === wordsContent(i, BIG_BYTES) : null });
			if (outcome.status === "ok") bigClients.push(c);
			if ([1, 8, 16, 32].includes(i + 1)) snapshots.push({ step: `big-${i + 1}`, open: bigClients.length, ...(await diagnostics(ctx.context.devices.A!)) });
		}
	}
	const conv = bigClients[0]
		? await convergence({ bodyId: bigClients[0].body, clients: [bigClients[0]], fresh: await ctx.dev("C"), adapter: ctx.adapter })
		: clients[0] ? { pass: null, note: "no big clients" } : null;
	for (const c of bigClients) { c.terminate(); c.doc.destroy(); }
	return { steps, smallFailures: failures, big: { count: bigCount, bytes: BIG_BYTES,
		openTotalMs: series(bigResults.map((r) => (r.status === "ok" ? r.totalMs as number : null)), 0),
		step1ToStep2Ms: series(bigResults.map((r) => (r.status === "ok" ? (r.phases as Result).step1ToStep2Ms as number : null)), 0),
		ticketMs: series(bigResults.map((r) => (r.phases as Result).ticketMs as number | null), 0), results: bigResults },
		snapshots, convergence: conv };
}

/**
 * Rows/sequence consumed per edit and per reconnect. Windows are recorded for gql.ts (rowsWritten) because
 * base diagnostics don't count rows; relay stats fields are passed through when present.
 */
export async function C4(ctx: RunCtx): Promise<Result> {
	const edits = ctx.n(50);
	const reconnects = ctx.num("reconnects", 20);
	const spacing = ctx.num("spacing", 1500);
	const body = await freshSmallNote(ctx);
	const a = await openOrThrow(await ctx.client("A", body));
	await sleep(3000);
	const d0 = await diagnostics(ctx.context.devices.A!);
	const editWindow = { start: new Date().toISOString(), end: "" };
	const samples = await keystrokes(a, null, edits, spacing);
	await sleep(3000);
	editWindow.end = new Date().toISOString();
	const d1 = await diagnostics(ctx.context.devices.A!);
	await sleep(5000);
	const reconnectWindow = { start: new Date().toISOString(), end: "" };
	for (let i = 0; i < reconnects; i++) {
		const b = await openOrThrow(await ctx.client("B", body));
		await sleep(300);
		await b.close();
		await sleep(spacing);
	}
	await sleep(3000);
	reconnectWindow.end = new Date().toISOString();
	const d2 = await diagnostics(ctx.context.devices.A!);
	const conv = await convergence({ bodyId: body, clients: [a], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close();
	const seq = (d: Result) => Number(d.sequence);
	return { bodyId: body, edits, reconnects, spacingMs: spacing, editWindow, reconnectWindow,
		sequencePerEdit: r2((seq(d1) - seq(d0)) / edits), sequencePerReconnect: r2((seq(d2) - seq(d1)) / reconnects),
		ackMs: series(samples.map((s) => s.ackMs)),
		relayStats: { before: d0.relay ?? null, afterEdits: d1.relay ?? null, afterReconnects: d2.relay ?? null },
		diagnostics: { before: d0, afterEdits: d1, afterReconnects: d2 },
		gqlHint: `scripts/relay2/gql.ts --worker ${ctx.host} --start <window.start> --end <window.end>`, convergence: conv };
}

export async function diag(ctx: RunCtx): Promise<Result> {
	return { diagnostics: await diagnostics(ctx.context.devices.A!, true) };
}
