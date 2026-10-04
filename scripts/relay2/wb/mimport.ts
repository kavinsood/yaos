/**
 * b3-m-import (PHASE4-BATCH-ON-RELAY3 deployed import measurements). Registered in bench.ts:
 *   I1P  — I1 first open + wait for the P2 opaque recovery projection to finish (`recovery/status` ready).
 *   DLI  — 2k import with the D8 daily limit tripped part-way (`--split` items), held `--hold-ms`, cleared, finished.
 * I2 reuses an I1P vault with `--no-seed` (wb/scenarios.ts).
 */
import { randomUUID } from "node:crypto";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { log, now, r2, sleep } from "../lib/common";
import { refreshOperatorCookie } from "../lib/context";
import type { RunCtx } from "../lib/run";
import { createAdapterFor, listHeads, outcomeCounts, rowsDelta, type CreateInput } from "./adapters";
import { contentHashOf } from "../lib/rawClient";
import { corpusFor, corpusInputs, createSummary, firstOpen, measuredCreate, rowsCounter, verifyCorpus } from "./scenarios";
import { openRC } from "./realScenarios";

type Result = Record<string, unknown>;
const iso = () => new Date().toISOString();

async function getJson(url: string, headers: Record<string, string>) {
	// b3-n2b: bounded per request; a host sleep (lid close) otherwise hangs the poll for the whole sleep.
	const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) }) as unknown as Response);
	let v: Result | null = null; try { v = await r.json() as Result; } catch { /* non-json */ }
	return { status: r.status, v };
}
export async function projectionStatus(id: LiveIdentity) {
	const { status, v } = await getJson(vaultRoute(id, "recovery/status"), deviceBearerHeaders(id));
	const p = (v?.projection ?? null) as Result | null;
	return { status, recoveryReady: v?.recoveryReady ?? null, projection: p };
}
export async function diagnostics(id: LiveIdentity) {
	const { status, v } = await getJson(vaultRoute(id, "diagnostics"), deviceBearerHeaders(id));
	return { status, recoveryInlineProjection: v?.recoveryInlineProjection ?? null, dailyLimit: v?.dailyLimit ?? null };
}
/** Poll recovery/status until projection ready (remaining 0, lag 0). Every poll is one DO request (counted). */
export async function waitProjection(id: LiveIdentity, timeoutMs: number, pollMs: number) {
	const t0 = now(); const startedAt = iso();
	const samples: Result[] = [];
	let polls = 0, last: Awaited<ReturnType<typeof projectionStatus>> | null = null;
	// b3-n2b: wall gaps between polls well above pollMs mean the host slept (pmset 'Clamshell Sleep' killed
	// the n2 I1-10k poll and tail at 16:12Z); recorded so the run is flagged instead of read as "never ready".
	const gaps: Array<{ atS: number; gapS: number }> = [];
	let prev = now();
	while (now() - t0 < timeoutMs) {
		last = await projectionStatus(id); polls++;
		const p = last.projection;
		const gap = now() - prev; prev = now();
		if (gap > pollMs + 90_000) gaps.push({ atS: r2((now() - t0) / 1000), gapS: r2(gap / 1000) });
		samples.push({ s: r2((now() - t0) / 1000), st: last.status, state: p?.state, rem: p?.remainingEntries, lag: p?.lagSequences, lp: p?.lastProgressAt ?? null });
		if (p && p.state === "ready" && Number(p.remainingEntries) === 0 && Number(p.lagSequences) === 0) break;
		await sleep(pollMs);
	}
	const ready = last?.projection?.state === "ready";
	// Server-side ready moment: lastProgressAt is the save that emptied the projection (independent of poll cadence or host sleep).
	const lp = Number(last?.projection?.lastProgressAt ?? NaN);
	const serverReadyAfterMs = ready && Number.isFinite(lp) ? r2(Math.max(0, lp - Date.parse(startedAt))) : null;
	return { ready, readyAfterMs: ready ? r2(now() - t0) : null, serverReadyAfterMs, hostGaps: gaps, startedAt, endedAt: iso(), polls, last, samples: samples.length > 60 ? [...samples.slice(0, 30), ...samples.slice(-30)] : samples };
}

/** I1 + projection wait. Rows split: create (bulk incl. inline projection) vs projection tail (after verification). */
export async function I1P(ctx: RunCtx): Promise<Result> {
	const rows = rowsCounter(ctx);
	const { corpus, info } = corpusFor(ctx);
	const withAtt = !ctx.args.flags["no-attachments"];
	const rStart = await rows.read();
	const tStart = now();
	const r = await firstOpen(ctx, rows, corpus, withAtt);
	const rAfterVerify = await rows.read();
	const A = await ctx.dev("A");
	const diagBefore = await diagnostics(A);
	const proj = await waitProjection(A, ctx.num("projection-timeout-ms", 45 * 60_000), ctx.num("poll-ms", 30_000));
	const rEnd = await rows.read();
	const diagAfter = await diagnostics(A);
	const errs = Object.entries(r.outcomes).filter(([k]) => k === "error" || k === "rejected").reduce((s, [, v]) => s + v, 0);
	return { corpus: info, rowsCounter: { source: rows.source }, ...r,
		phases: { createAndVerify: rowsDelta(rStart, rAfterVerify), projectionTail: rowsDelta(rAfterVerify, rEnd), wholeFirstOpen: rowsDelta(rStart, rEnd),
			rawStart: rStart, rawEnd: rEnd },
		projection: proj, timeToProjectionReadyMs: proj.ready ? r2(now() - tStart) : null,
		diagnostics: { beforeWait: diagBefore, afterWait: diagAfter },
		convergence: { pass: r.verification.pass && errs === 0 && proj.ready, createErrors: errs, projectionReady: proj.ready } };
}

async function simulateDailyLimit(ctx: RunCtx, enabled: boolean) {
	const url = vaultRoute(ctx.context.devices.A!, "debug/simulate-daily-limit");
	const go = () => fetch(url, { method: "POST", headers: { cookie: ctx.context.operatorCookie, "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
	let r = await go();
	if (r.status === 401) { await refreshOperatorCookie(ctx.context); r = await go(); }
	const text = await r.text();
	let value: unknown = text; try { value = JSON.parse(text); } catch { /* text */ }
	return { status: r.status, value, at: now(), iso: iso() };
}

/**
 * DLI: 2k bulk import; after `--split` (800) items the limit is enabled, a probe batch of `--probe` (20) items must get a
 * 503, the real client (device RC) creates a note and must surface D8 (onDailyLimit / getDailyLimitState). Hold
 * `--hold-ms` (300000) sampling rows/diagnostics; clear; create every not-yet-created item; verify no loss/duplicates;
 * wait for projection.
 */
export async function DLI(ctx: RunCtx): Promise<Result> {
	const rows = rowsCounter(ctx);
	const { corpus, info } = corpusFor(ctx);
	const items = corpusInputs(corpus, true);
	const split = ctx.num("split", 800), probeN = ctx.num("probe", 20), holdMs = ctx.num("hold-ms", 300_000);
	const adapter = createAdapterFor("bulk", contentHashOf);
	const A = await ctx.dev("A");
	const out: Result = { corpus: info, items: items.length, split, probeN, holdMs };
	out.initialDisable = (await simulateDailyLimit(ctx, false)).status;
	const t0 = now();
	// phase 1
	log(`DLI: phase1 ${split} items`);
	const p1 = await measuredCreate(ctx, rows, adapter, items.slice(0, split), "A");
	out.phase1 = { ...createSummary(p1.res, p1.total, { notes: items.slice(0, split).filter((i) => i.kind === "note").length, attachments: items.slice(0, split).filter((i) => i.kind === "attachment").length }, p1.wallMs), window: p1.window };
	const rc = await openRC(ctx, "dli");
	await sleep(3000);
	const reads: Result[] = [];
	const snap = async (label: string) => { const r = await rows.read(); const d = await diagnostics(A); reads.push({ label, at: iso(), rowsWritten: r.rowsWritten, rowsRead: r.rowsRead, setAlarms: typeof r.extra?.setAlarms === "number" ? r.extra.setAlarms : null, source: r.source, dailyLimit: d.dailyLimit }); return r; };
	await snap("before-enable");
	const en = await simulateDailyLimit(ctx, true);
	out.enable = { status: en.status, at: en.iso };
	log(`DLI: limit on ${en.status}`);
	// probe batch while limited
	const probe = await adapter.create(ctx.context, items.slice(split, split + probeN), { device: "A" });
	out.probe = { outcomes: outcomeCounts(probe), statuses: probe.batches.map((b) => b.httpStatus), errors: probe.batches.map((b) => b.error ?? null) };
	// real-client create while limited → D8 notice
	const bodyId = `${ctx.tag}-dli-rc`, path = `DLI/${ctx.tag}/rc-note.md`;
	const rcCreate = await Promise.race([
		rc.vs.commitFreshBody({ bodyId, path, content: "# limited\n", reason: "dli", candidateId: randomUUID() } as never).then(() => "resolved", (e: unknown) => `rejected: ${String((e as Error)?.message ?? e).slice(0, 160)}`),
		sleep(20_000).then(() => "pending after 20s"),
	]);
	await sleep(3000);
	out.realClientWhileLimited = { commitFreshBody: rcCreate, onDailyLimit: rc.dailyLimits.map((x) => ({ atMsAfterEnable: r2(x.at - en.at), info: x.info })),
		getDailyLimitState: rc.vs.getDailyLimitState(), http503: rc.http.filter((h) => h.status === 503).length };
	// hold
	const holdStart = iso();
	const sampleEvery = 60_000;
	for (let s = 0; now() - en.at < holdMs; s++) { await sleep(Math.min(sampleEvery, Math.max(0, en.at + holdMs - now()))); await snap(`limited+${Math.round((now() - en.at) / 1000)}s`); }
	const holdEnd = iso();
	const dis = await simulateDailyLimit(ctx, false);
	out.disable = { status: dis.status, at: dis.iso };
	out.holdWindow = { start: holdStart, end: holdEnd, enabledAt: en.iso, disabledAt: dis.iso };
	log(`DLI: limit off ${dis.status}`);
	await sleep(3000);
	await snap("after-disable+3s");
	// phase 2: every item not created
	const done = new Set(p1.res.outcomes.filter((o) => o.outcome === "created").map((o) => o.path));
	const rest = items.filter((i) => !done.has(i.path));
	log(`DLI: phase2 ${rest.length} items`);
	const p2 = await measuredCreate(ctx, rows, adapter, rest, "A");
	out.phase2 = { ...createSummary(p2.res, p2.total, { notes: rest.filter((i) => i.kind === "note").length, attachments: rest.filter((i) => i.kind === "attachment").length }, p2.wallMs), window: p2.window };
	out.realClientAfter = { getDailyLimitState: rc.vs.getDailyLimitState(), rcNoteOnServer: null as unknown };
	// no loss / no duplicates
	const verification = await verifyCorpus(ctx, corpus, "B", true);
	const heads = await listHeads(await ctx.dev("B"));
	const paths = heads.entries.map((e) => e.path);
	const dupPaths = paths.length - new Set(paths).size;
	const corpusPaths = new Set(corpus.notes.map((n) => n.path));
	const extra = paths.filter((p) => !corpusPaths.has(p) && !p.startsWith(`DLI/${ctx.tag}/`));
	(out.realClientAfter as Result).rcNoteOnServer = paths.includes(path);
	// b3-clientblob A4: the RC replays its parked create at its next D8 probe (2 min doubling) or on its
	// next successful write; poll the catalog (one heads listing per 15 s) up to --rc-wait-ms for it.
	{
		const rcWait = ctx.num("rc-wait-ms", 15 * 60_000);
		const t = now();
		let found = paths.filter((p) => p === path).length;
		while (found === 0 && now() - t < rcWait) {
			await sleep(15_000);
			found = (await listHeads(await ctx.dev("B"))).entries.filter((e) => e.path === path).length;
		}
		Object.assign(out.realClientAfter as Result, { rcNoteOnServerEventually: found > 0, rcNoteCopies: found,
			rcNoteMsAfterDisable: found > 0 ? r2(now() - dis.at) : null, rcStateAfter: rc.vs.getDailyLimitState() });
	}
	out.noLoss = { verification, catalogEntries: paths.length, duplicatePaths: dupPaths, unexpectedPaths: extra.slice(0, 10), unexpectedCount: extra.length };
	await snap("after-phase2");
	const proj = await waitProjection(A, ctx.num("projection-timeout-ms", 30 * 60_000), ctx.num("poll-ms", 30_000));
	out.projection = proj;
	await snap("after-projection");
	await rc.close({ timeoutMs: 5000 }).catch(() => undefined);
	out.reads = reads;
	out.wallMs = r2(now() - t0);
	const limitedReads = reads.filter((x) => String(x.label).startsWith("limited+") || x.label === "before-enable");
	const firstL = limitedReads[0] as Result | undefined, lastL = limitedReads[limitedReads.length - 1] as Result | undefined;
	const holdRows = firstL && lastL ? Number(lastL.rowsWritten) - Number(firstL.rowsWritten) : null;
	const probe503 = probe.batches.every((b) => b.httpStatus === 503);
	const d8 = rc.dailyLimits.length > 0 || Boolean((out.realClientWhileLimited as Result).getDailyLimitState && ((out.realClientWhileLimited as Result).getDailyLimitState as Result)?.active);
	out.checks = { probe503, d8Notice: d8, holdRowsWrittenCounted: holdRows, noLoss: verification.pass, noDuplicates: dupPaths === 0, projectionReady: proj.ready,
		phase2Errors: (p2.res.outcomes.filter((o) => o.outcome === "error" || o.outcome === "rejected")).length,
		note: "rows/setAlarms rejected while simulated are NOT seen by sql-rows; alarm loop judged from GraphQL alarm invocations over holdWindow + dailyLimit.alarmHolds" };
	const rcOk = (out.realClientAfter as Result).rcNoteCopies === 1;
	(out.checks as Result).rcNoteCreatedOnce = rcOk;
	out.convergence = { pass: probe503 && d8 && verification.pass && dupPaths === 0 && proj.ready && rcOk };
	return out;
}
