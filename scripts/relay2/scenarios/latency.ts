/**
 * §7.1 latency scenarios: L1, L2, L3, L4, L6, L7.
 */
import { createHash, randomBytes } from "node:crypto";
import { log, now, r2, series, sleep } from "../lib/common";
import { SMALL_COUNT } from "../context";
import { smallId } from "../lib/context";
import { bodyGet, bodyHead, convergence, diagnostics } from "../lib/checks";
import { contentHashOf } from "../lib/rawClient";
import { CoverageTracker, freshSmallNote, freshTraceBody, keystrokes, loadTrace, openOrThrow, operatorVaultPost,
	replayTrace, type RunCtx } from "../lib/run";

type Result = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function L1(ctx: RunCtx): Promise<Result> {
	const n = ctx.n(100);
	const spacing = ctx.num("spacing", 200);
	const body = await freshSmallNote(ctx);
	const a = await openOrThrow(await ctx.client("A", body));
	await sleep(1000);
	const samples: Array<{ i: number; rttMs: number | null; runtimeEpoch: unknown }> = [];
	for (let i = 0; i < n; i++) {
		const probeId = `p${i}-${randomBytes(4).toString("hex")}`;
		const got = a.waitControl((v) => v.type === "VAULT_PONG" && v.probeId === probeId, 5000);
		const t0 = now();
		a.send(`__YPS:${JSON.stringify({ type: "VAULT_PING", probeId })}`);
		const pong = await got;
		samples.push({ i, rttMs: pong ? r2(pong.at - t0) : null, runtimeEpoch: pong?.value.runtimeEpoch ?? null });
		await sleep(spacing);
	}
	const conv = await convergence({ bodyId: body, clients: [a], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close();
	return { n, spacingMs: spacing, bodyId: body, rttMs: series(samples.map((s) => s.rttMs)), samples, convergence: conv };
}

export async function L2(ctx: RunCtx): Promise<Result> {
	const n = ctx.n(300);
	const spacing = ctx.num("spacing", 500);
	const bytes = ctx.num("note-bytes", 4096);
	const body = await freshSmallNote(ctx, bytes);
	const a = await openOrThrow(await ctx.client("A", body));
	const b = await openOrThrow(await ctx.client("B", body));
	await sleep(1500);
	const before = await diagnostics(ctx.context.devices.A!);
	const windowStart = new Date().toISOString();
	const samples = await keystrokes(a, b, n, spacing, { onSample: (s) => { if (s.i % 50 === 0) log(`L2 ${s.i}/${n} prop=${s.propagationMs} ack=${s.ackMs}`); } });
	const windowEnd = new Date().toISOString();
	const after = await diagnostics(ctx.context.devices.A!);
	const conv = await convergence({ bodyId: body, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close(); await b.close();
	return { n, spacingMs: spacing, noteBytes: bytes, bodyId: body, windowStart, windowEnd,
		propagationMs: series(samples.map((s) => s.propagationMs)), originAckMs: series(samples.map((s) => s.ackMs)),
		sequenceDelta: Number(after.sequence) - Number(before.sequence), before, after, samples, convergence: conv };
}

export async function L3(ctx: RunCtx): Promise<Result> {
	const n = ctx.n(50);
	const spacing = ctx.num("spacing", 500);
	const rate = ctx.num("replay-rate", 25);
	const trace = loadTrace();
	const body = await freshTraceBody(ctx, trace);
	const a = await openOrThrow(await ctx.client("A", body), 60_000);
	const b = await openOrThrow(await ctx.client("B", body), 60_000);
	await sleep(1500);
	const initialChars = a.text().length;
	const pre = await keystrokes(a, b, n, spacing, { position: "middle" });
	log(`L3 pre done p50=${series(pre.map((s) => s.propagationMs)).summary?.p50}; replaying ${trace.frames.length} frames at ${rate}/s`);
	const tracker = new CoverageTracker(b.doc);
	const replay = await replayTrace(a, trace.frames, rate, { tracker, onProgress: (i) => log(`L3 replay ${i}`) });
	const deadline = now() + 120_000;
	while (tracker.outstanding > 0 && now() < deadline) await sleep(100);
	tracker.stop();
	await sleep(3000);
	const midDiag = await diagnostics(ctx.context.devices.A!);
	const post = await keystrokes(a, b, n, spacing, { position: "middle" });
	const conv = await convergence({ bodyId: body, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000 });
	await a.close(); await b.close();
	return { n, spacingMs: spacing, bodyId: body, initialChars, finalChars: a.text().length,
		pre: { propagationMs: series(pre.map((s) => s.propagationMs)), originAckMs: series(pre.map((s) => s.ackMs)), samples: pre },
		replay: { rate, frames: replay.sent, durationMs: replay.durationMs, perFramePropagationMs: series(tracker.coveredMs, 0) },
		post: { propagationMs: series(post.map((s) => s.propagationMs)), originAckMs: series(post.map((s) => s.ackMs)), samples: post },
		midDiag, convergence: conv };
}

export async function L4(ctx: RunCtx): Promise<Result> {
	const rate = ctx.num("rate", 25);
	const trace = loadTrace();
	const limit = ctx.n(trace.frames.length);
	const body = await freshTraceBody(ctx, trace);
	const a = await openOrThrow(await ctx.client("A", body), 60_000);
	const b = await openOrThrow(await ctx.client("B", body), 60_000);
	await sleep(1500);
	const before = await diagnostics(ctx.context.devices.A!);
	const acksBefore = a.acks.length;
	const tracker = new CoverageTracker(b.doc);
	const windowStart = new Date().toISOString();
	const replay = await replayTrace(a, trace.frames, rate, { tracker, limit, onProgress: (i) => log(`L4 ${i}/${limit} outstanding=${tracker.outstanding}`) });
	const sendEnd = now();
	const deadline = now() + 120_000;
	while (tracker.outstanding > 0 && now() < deadline) await sleep(50);
	const drainMs = r2(now() - sendEnd);
	tracker.stop();
	const windowEnd = new Date().toISOString();
	await sleep(3000);
	const after = await diagnostics(ctx.context.devices.A!);
	const full = replay.sent === trace.frames.length;
	const conv = await convergence({ bodyId: body, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000,
		expectedTextSha: full ? trace.finalSha : undefined });
	const result = { rate, frames: replay.sent, updateBytes: trace.frames.slice(0, replay.sent).reduce((s, f) => s + f.byteLength, 0),
		bodyId: body, windowStart, windowEnd, sendDurationMs: replay.durationMs, drainAfterLastSendMs: drainMs,
		perFramePropagationMs: series(tracker.coveredMs), acksReceived: a.acks.length - acksBefore, updatesReceivedByB: b.updatesIn,
		manifestMatch: full ? sha(a.text()) === trace.finalSha && sha(b.text()) === trace.finalSha : null,
		sequenceDelta: Number(after.sequence) - Number(before.sequence), before, after,
		perFrameSamples: tracker.coveredMs, convergence: conv };
	await a.close(); await b.close();
	return result;
}

/** Open→synced. Cold = first open of a non-resident body after simulate-restart (flushes/evicts); warm = reopen while another socket holds it. */
export async function L6(ctx: RunCtx): Promise<Result> {
	const n = ctx.n(100);
	const count = Math.min(n, SMALL_COUNT);
	const restart = await operatorVaultPost(ctx, "debug/simulate-restart");
	if (restart.status !== 200) ctx.notes.push(`simulate-restart unavailable (${restart.status}); cold = first open in this run`);
	await sleep(1000);
	const diagBefore = await diagnostics(ctx.context.devices.A!);
	const cold: Result[] = [];
	for (let i = 0; i < count; i++) {
		const c = await ctx.client(i % 2 ? "B" : "A", smallId(i));
		const outcome = await c.open(30_000);
		cold.push({ i, bodyId: smallId(i), status: outcome.status, totalMs: r2(now() - c.startedAt),
			ticketMs: r2(c.ticketAt - c.startedAt), upgradeMs: c.openAt ? r2(c.openAt - c.ticketAt) : null,
			syncMs: c.syncedAt ? r2(c.syncedAt - c.openAt) : null, readyMs: c.readyAt ? r2(c.readyAt - c.openAt) : null });
		await c.close();
		await sleep(100);
	}
	const warmBody = ctx.str("warm-body") ?? smallId(0);
	const holder = await openOrThrow(await ctx.client("A", warmBody));
	const warm: Result[] = [];
	for (let i = 0; i < n; i++) {
		const c = await ctx.client("B", warmBody);
		const outcome = await c.open(30_000);
		warm.push({ i, status: outcome.status, totalMs: r2(now() - c.startedAt), ticketMs: r2(c.ticketAt - c.startedAt),
			upgradeMs: c.openAt ? r2(c.openAt - c.ticketAt) : null, syncMs: c.syncedAt ? r2(c.syncedAt - c.openAt) : null });
		await c.close();
		await sleep(100);
	}
	const conv = await convergence({ bodyId: warmBody, clients: [holder], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await holder.close();
	const pick = (rows: Result[], k: string) => rows.map((r) => r[k] as number | null);
	return { n, restart, diagBefore,
		cold: { count: cold.length, totalMs: series(pick(cold, "totalMs"), 0), syncMs: series(pick(cold, "syncMs"), 0), upgradeMs: series(pick(cold, "upgradeMs"), 0), samples: cold },
		warm: { totalMs: series(pick(warm, "totalMs")), syncMs: series(pick(warm, "syncMs")), upgradeMs: series(pick(warm, "upgradeMs")), samples: warm },
		convergence: conv };
}

/** After each acked edit: GET /head and GET /body latency and whether both reflect the client's text. */
export async function L7(ctx: RunCtx): Promise<Result> {
	const n = ctx.n(100);
	const body = await freshSmallNote(ctx);
	const a = await openOrThrow(await ctx.client("A", body));
	const reader = ctx.context.devices.B!;
	await sleep(1000);
	const samples: Result[] = [];
	for (let i = 0; i < n; i++) {
		const tracked = a.editTracked((t) => t.insert(t.length, String.fromCharCode(97 + (i % 26))));
		const ack = await a.waitAck(tracked.frameId, tracked.sentAt, 10_000);
		const ackMs = ack ? r2(ack.at - tracked.sentAt) : null;
		const expected = contentHashOf(a.text());
		const h0 = now();
		const head = await bodyHead(reader, body);
		const headMs = r2(now() - h0);
		const get = await bodyGet(reader, body);
		// Time until the head reflects this edit (polling), bounded.
		let visibleMs: number | null = head.value?.contentHash === expected.contentHash ? r2(now() - tracked.sentAt) : null;
		if (visibleMs === null) {
			const deadline = now() + 5000;
			while (now() < deadline) {
				const h = await bodyHead(reader, body);
				if (h.value?.contentHash === expected.contentHash) { visibleMs = r2(now() - tracked.sentAt); break; }
				await sleep(25);
			}
		}
		samples.push({ i, ackMs, headMs, headStatus: head.status, headHashCorrect: head.value?.contentHash === expected.contentHash,
			getMs: get.elapsedMs, getStatus: get.status, getTextCorrect: get.text === a.text(), getHashCorrect: get.contentHash === expected.contentHash,
			headVisibleSinceSendMs: visibleMs });
		await sleep(ctx.num("spacing", 300));
	}
	const conv = await convergence({ bodyId: body, clients: [a], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close();
	const col = (k: string) => samples.map((s) => s[k] as number | null);
	const rate = (k: string) => samples.filter((s) => s[k] === true).length / samples.length;
	return { n, bodyId: body, headMs: series(col("headMs")), getMs: series(col("getMs")), ackMs: series(col("ackMs")),
		headVisibleSinceSendMs: series(col("headVisibleSinceSendMs")),
		correctness: { headHashAfterAck: rate("headHashCorrect"), getTextAfterAck: rate("getTextCorrect"), getHashAfterAck: rate("getHashCorrect") },
		samples, convergence: conv };
}

