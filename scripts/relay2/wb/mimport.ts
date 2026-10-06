/**
 * b3-m-import (PHASE4-BATCH-ON-RELAY3 deployed import measurements). Registered in bench.ts:
 *   I1P  — I1 first open + wait for the P2 opaque recovery projection to finish (`recovery/status` ready).
 * I2 reuses an I1P vault with `--no-seed` (wb/scenarios.ts).
 */
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { now, r2, sleep } from "../lib/common";
import type { RunCtx } from "../lib/run";
import { rowsDelta } from "./adapters";
import { corpusFor, firstOpen, rowsCounter } from "./scenarios";

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
