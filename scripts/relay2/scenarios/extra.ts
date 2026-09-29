/**
 * Round-3 harness scenarios: C2 (CPU per update while streaming), C5 (DO requests per burst / catch-up),
 * C6 (bundle + startup from the deploy record), K1 (routine checkpoint cost vs tail size),
 * MB (micro-batch / write-amplification sweep) and CW (concurrent writers, D6 invariant #7).
 *
 * Cost windows are minute-aligned: Cloudflare's durableObjectsPeriodicGroups (rowsWritten, cpuTime, WS message
 * counts) are per-minute buckets, so each measured phase starts just after a minute boundary and the next phase
 * waits for the following boundary. A bucket is labelled by the minute in which the DO's reporting period began:
 * activity that starts before a boundary and continues past it lands wholly in the earlier bucket (seen: a burst
 * phase opened at :57 was billed to the idle minute), so every phase starts all of its traffic (socket opens
 * included) after its boundary and stops before the next one. Periodic inboundWebsocketMsgCount is 0 for
 * Hibernation-API sockets, so inbound messages come from the hibernation invocation count; an idle window (no edits; C2/C5 open no sockets during it) gives the per-minute baseline.
 * Analytics lag 1-3 min, so gql is queried after `--gql-settle-ms` (default 180 s); `--no-gql` skips it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queryWindow } from "../gql";
import { LOG_DIR, deployRecord, log, now, r2, series, sleep, workerName } from "../lib/common";
import { smallContent } from "../lib/context";
import { bodyGet, convergence, diagnostics } from "../lib/checks";
import { contentHashOf, RawClient } from "../lib/rawClient";
import { CoverageTracker, freshNotes, freshTraceBody, loadTrace, openOrThrow, operatorVaultPost, QUICK_TRACE_DIR,
	replayTrace, type RunCtx } from "../lib/run";

type Result = Record<string, unknown>;
type Counters = Record<string, number>;

export const STRESS_TRACE_DIR = join(LOG_DIR, "reset-fixtures/trace-stress");

// ---------------------------------------------------------------------------------------------------------------
// Minute-aligned windows + GraphQL
// ---------------------------------------------------------------------------------------------------------------

export interface Win { name: string; start: string; end: string; edits?: number; [k: string]: unknown }

/** Sleep until `padMs` after the next minute boundary; returns that ISO time (a window start). */
export async function alignToMinute(padMs = 1500): Promise<string> {
	await sleep(60_000 - (Date.now() % 60_000) + padMs);
	return new Date().toISOString();
}

/** Close a window: end = now, then wait for the next minute boundary so the next phase gets fresh buckets. */
export async function closeWindow(name: string, start: string, extra: Result = {}): Promise<Win> {
	const end = new Date().toISOString();
	return { name, start, end, minutes: Math.floor(Date.parse(end) / 60_000) - Math.floor(Date.parse(start) / 60_000) + 1, ...extra };
}

const floorMin = (iso: string) => Math.floor(Date.parse(iso) / 60_000) * 60_000;

/** Sum periodic minute rows whose bucket lies in [floor(start), floor(end)] (queryWindow's leq also pulls ceil(end)). */
function minuteTotals(q: Awaited<ReturnType<typeof queryWindow>>, w: Win) {
	const lo = floorMin(w.start), hi = floorMin(w.end);
	const rows = q.periodicMinutes.filter((r) => { const t = Date.parse(r.dimensions.datetimeMinute!); return t >= lo && t <= hi; });
	const totals: Counters = {};
	const byObject: Record<string, Counters> = {};
	for (const r of rows) {
		for (const [k, v] of Object.entries(r.sum)) totals[k] = (totals[k] ?? 0) + v;
		const o = (byObject[r.dimensions.objectId!] ??= {});
		for (const [k, v] of Object.entries(r.sum)) o[k] = (o[k] ?? 0) + v;
	}
	const bucketMinutes = new Set(rows.map((r) => r.dimensions.datetimeMinute)).size;
	const lastBucketPresent = rows.some((r) => Date.parse(r.dimensions.datetimeMinute!) === hi);
	return { totals, objects: Object.keys(byObject).length, bucketMinutes, lastBucketPresent,
		byObjectTop: Object.entries(byObject).sort((a, b) => (b[1].rowsWritten ?? 0) - (a[1].rowsWritten ?? 0)).slice(0, 3)
			.map(([id, s]) => ({ objectId: id.slice(0, 12), rowsWritten: s.rowsWritten, cpuTime: s.cpuTime, inboundWebsocketMsgCount: s.inboundWebsocketMsgCount })) };
}

function invocationSummary(inv: unknown) {
	return ((inv as Array<{ dimensions: Record<string, string>; sum: Counters; quantiles: Counters }>) ?? []).map((g) => ({
		type: g.dimensions.type, status: g.dimensions.status, requests: g.sum.requests, errors: g.sum.errors,
		cpuUs: { p50: g.quantiles.cpuTimeP50, p90: g.quantiles.cpuTimeP90, p99: g.quantiles.cpuTimeP99 },
		wallUs: { p50: g.quantiles.wallTimeP50, p90: g.quantiles.wallTimeP90, p99: g.quantiles.wallTimeP99 } }));
}

const invRequests = (inv: ReturnType<typeof invocationSummary>, type: string) =>
	inv.filter((g) => g.type === type).reduce((s, g) => s + (g.requests ?? 0), 0);

/** Wait for analytics to settle, then query every window. Never throws (errors are recorded per window). */
export async function gqlWindows(ctx: RunCtx, windows: Win[]): Promise<Result[] | { skipped: string }> {
	if (ctx.args.flags["no-gql"]) return { skipped: "--no-gql" };
	const settle = ctx.num("gql-settle-ms", 180_000);
	const lastEnd = Math.max(...windows.map((w) => Date.parse(w.end)));
	const wait = lastEnd + settle - Date.now();
	if (wait > 0) { log(`gql: waiting ${Math.round(wait / 1000)} s for analytics to settle`); await sleep(wait); }
	// Analytics lag varies (a freshly deployed worker lagged > 5 min). Wait until the latest non-idle window's last
	// minute bucket is present (up to --gql-attempts × 60 s), then query every window; an idle window with no DO
	// activity legitimately has no buckets.
	const attempts = ctx.num("gql-attempts", 8);
	const probe = [...windows].reverse().find((w) => w.name !== "idle") ?? windows[windows.length - 1]!;
	let probeReady = false;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const q = await queryWindow(ctx.host, probe.start, probe.end);
			if (minuteTotals(q, probe).lastBucketPresent) { probeReady = true; break; }
		} catch (error) { log(`gql probe error: ${String(error).slice(0, 200)}`); }
		if (attempt < attempts) { log(`gql ${probe.name}: last minute bucket not yet present (attempt ${attempt}); retry in 60 s`); await sleep(60_000); }
	}
	const out: Result[] = [];
	for (const w of windows) {
		let entry: Result = { ...w };
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const q = await queryWindow(ctx.host, w.start, w.end);
				const m = minuteTotals(q, w);
				const inv = invocationSummary(q.invocations);
				const t = m.totals;
				const httpRequests = invRequests(inv, "http");
				const wsInvocations = invRequests(inv, "hibernation") + invRequests(inv, "webSocket") + invRequests(inv, "websocket");
				const alarms = invRequests(inv, "alarm");
				// Periodic inboundWebsocketMsgCount reads 0 for Hibernation-API sockets (seen: 1003 hibernation
				// invocations, inbound 0), so inbound messages = max(periodic count, hibernation invocations).
				t.inboundWsEffective = Math.max(t.inboundWebsocketMsgCount ?? 0, wsInvocations);
				entry = { ...w, ...m, invocations: inv, httpRequests, wsInvocations, alarms,
					doRequestUnits: r2(httpRequests + alarms + t.inboundWsEffective / 20),
					doRequestUnitsNote: "HTTP invocations (incl. WS upgrades, tickets, debug routes) + alarms + inbound WS messages / 20 (Workers billing 20:1); inbound = max(periodic inboundWebsocketMsgCount, hibernation invocations)",
					probeReady, attempt };
				break;
			} catch (error) { entry = { ...w, error: String(error).slice(0, 300), attempt }; await sleep(15_000); }
		}
		out.push(entry);
	}
	return out;
}

/** Per-edit derivation against an idle baseline window (per-minute rate × minutes subtracted). */
function perEdit(win: Result | undefined, idle: Result | undefined, edits: number, key: string) {
	if (!win || win.error || !edits) return null;
	const total = Number((win.totals as Counters | undefined)?.[key] ?? 0);
	const idlePerMin = idle && !idle.error ? Number((idle.totals as Counters | undefined)?.[key] ?? 0) / Math.max(1, Number(idle.bucketMinutes ?? 1)) : 0;
	const net = total - idlePerMin * Number(win.bucketMinutes ?? 0);
	return { total, idlePerMinute: r2(idlePerMin), net: r2(net), perEdit: r2(net / edits) };
}

const relayCounters = (d: Result) => ((d.relay as { counters?: Counters } | undefined)?.counters ?? null);
function counterDelta(a: Result, b: Result): Counters | null {
	const x = relayCounters(a), y = relayCounters(b);
	if (!x || !y) return null;
	const d: Counters = Object.fromEntries(Object.keys(y).filter((k) => typeof y[k] === "number" && y[k] !== (x[k] ?? 0)).map((k) => [k, r2(y[k]! - (x[k] ?? 0))]));
	// Relay counters are in-memory: a negative delta means the DO was evicted/restarted inside the window, so the
	// deltas are not usable (gql periodic totals still are).
	if (Object.entries(d).some(([k, v]) => v < 0 && k !== "appendsPerSecond")) d.counterResetInWindow = 1;
	return d;
}
const relayBody = (d: Result, bodyId: string) =>
	((d.relay as { bodies?: Result[] } | undefined)?.bodies ?? []).find((b) => b.bodyId === bodyId) ?? null;

/** Type one char on `a` without waiting for ack; tracks propagation to `tracker`. Returns sentAt. */
function keystroke(a: RawClient, tracker: CoverageTracker | null, index: number, ch: string) {
	let update: Uint8Array | null = null;
	const capture = (u: Uint8Array, origin: unknown) => { if (origin !== a) update = u; };
	a.doc.on("update", capture);
	let sentAt = now();
	try { sentAt = a.editTracked((t) => t.insert(Math.floor(t.length / 2), ch)).sentAt; }
	finally { a.doc.off("update", capture); }
	if (tracker && update) tracker.sent(index, update, sentAt);
	return sentAt;
}

async function drain(tracker: CoverageTracker, timeoutMs = 60_000) {
	const t0 = now();
	while (tracker.outstanding > 0 && now() - t0 < timeoutMs) await sleep(50);
	return { outstanding: tracker.outstanding, drainMs: r2(now() - t0) };
}

// ---------------------------------------------------------------------------------------------------------------
// C2 — CPU per update while streaming (quick trace, or stress trace with 5 writers)
// ---------------------------------------------------------------------------------------------------------------

/** Per-frame writer index from a trace's semantic.jsonl (`client` field); all zeros if absent. */
function traceOwners(dir: string, frames: number, clients: number): number[] {
	try {
		const owners = readFileSync(join(dir, "semantic.jsonl"), "utf8").split("\n").filter(Boolean)
			.map((l) => Number((JSON.parse(l) as { client?: number }).client ?? 0) % clients);
		if (owners.length >= frames) return owners;
	} catch { /* fallthrough */ }
	return Array.from({ length: frames }, (_v, i) => i % clients);
}

/**
 * `--trace quick|stress` `--rate 25` `--n <frames>` (default: whole trace) `--clients 5` (stress).
 * Senders replay their own frames (stress: per semantic.jsonl client index) in trace order at `rate`; an observer
 * (device B) measures per-frame propagation. CPU: invocation cpu quantiles for WS messages (hibernation events)
 * and per-minute cpuTime / rowsWritten over the minute-aligned streaming window minus an idle window.
 * Run with --tail for per-event cpuTime sampling (analyze.py).
 */
export async function C2(ctx: RunCtx): Promise<Result> {
	const which = ctx.str("trace", "quick")!;
	const rate = ctx.num("rate", 25);
	const trace = loadTrace(which === "stress" ? STRESS_TRACE_DIR : QUICK_TRACE_DIR);
	const limit = Math.min(ctx.n(trace.frames.length), trace.frames.length);
	const clientsN = which === "stress" ? ctx.num("clients", 5) : 1;
	const owners = traceOwners(trace.dir, trace.frames.length, clientsN);
	const body = await freshTraceBody(ctx, trace, `c2-${which}`);
	// No socket may sit idle across a minute-alignment wait: a hibernated base DO that is evicted gets a new
	// runtime epoch and closes surviving non-relay sockets ("socket authority mismatch", the B1 behaviour). So the
	// idle baseline has no sockets open, and sockets are opened just after the stream window's minute boundary
	// (the opens are inside the stream window; `opens` records how many).
	const windows: Win[] = [];
	let start = await alignToMinute();
	await sleep(55_000);
	windows.push(await closeWindow("idle", start));
	start = await alignToMinute();
	const senders: RawClient[] = [];
	for (let k = 0; k < clientsN; k++) senders.push(await openOrThrow(await ctx.client(k === 0 ? "A" : `S${k}`, body), 120_000));
	const observer = await openOrThrow(await ctx.client("B", body), 120_000);
	const d0 = await diagnostics(ctx.context.devices.A!);
	const tracker = new CoverageTracker(observer.doc);
	const sendTimes: number[] = [];
	const t0 = now();
	let closedAt: number | null = null;
	for (let i = 0; i < limit; i++) {
		const wait = t0 + (i * 1000) / rate - now();
		if (wait > 1) await sleep(wait);
		const s = senders[owners[i]!]!;
		if (s.closed) { closedAt = i; log(`C2 sender ${owners[i]} closed at ${i}: ${JSON.stringify(s.closed)}`); break; }
		const at = now();
		s.applyAndSend(trace.frames[i]!);
		tracker.sent(i, trace.frames[i]!, at);
		sendTimes.push(at);
		if (i % 1000 === 0) log(`C2 ${which} ${i}/${limit} outstanding=${tracker.outstanding}`);
	}
	const sendMs = r2(now() - t0);
	const drained = await drain(tracker, 180_000);
	tracker.stop();
	windows.push(await closeWindow("stream", start, { edits: sendTimes.length, opens: clientsN + 1 }));
	const d1 = await diagnostics(ctx.context.devices.A!);
	const full = sendTimes.length === trace.frames.length;
	const conv = await convergence({ bodyId: body, clients: [...senders, observer], fresh: await ctx.dev("C"), adapter: ctx.adapter,
		settleMs: 120_000, expectedTextSha: full ? trace.finalSha : undefined });
	for (const c of [...senders, observer]) { c.terminate(); c.doc.destroy(); }
	const gql = await gqlWindows(ctx, windows);
	const g = Array.isArray(gql) ? gql : [];
	const stream = g.find((w) => w.name === "stream"), idle = g.find((w) => w.name === "idle");
	const wsInv = ((stream?.invocations as ReturnType<typeof invocationSummary> | undefined) ?? []).filter((x) => x.type === "hibernation");
	return { trace: which, traceDir: trace.dir, rate, frames: sendTimes.length, clients: clientsN, bodyId: body, sendMs, drained, closedAt,
		perFramePropagationMs: series(tracker.coveredMs, 0),
		cpu: { perUpdateUsFromMinutes: perEdit(stream, idle, sendTimes.length, "cpuTime"),
			wsMessageInvocationCpuUs: wsInv.map((x) => ({ status: x.status, requests: x.requests, ...x.cpuUs })),
			note: "perUpdateUs = (stream-window cpuTime − idle cpuTime/min × minutes) / frames (µs, exact periodic analytics); invocation quantiles are adaptive-sampled per WS message event" },
		rowsWritten: perEdit(stream, idle, sendTimes.length, "rowsWritten"),
		inboundWsMessages: perEdit(stream, idle, sendTimes.length, "inboundWsEffective"),
		relayCounterDelta: counterDelta(d0, d1), relayBody: relayBody(d1, body), windows, gql,
		diagnostics: { before: d0, after: d1 }, convergence: conv };
}

// ---------------------------------------------------------------------------------------------------------------
// C5 — DO requests per edit burst and per catch-up
// ---------------------------------------------------------------------------------------------------------------

/**
 * `--n 20` bursts of `--burst 8` keystrokes `--burst-interval 125` ms apart, `--burst-gap 3000` ms between bursts;
 * then `--catchups 10` reconnects of B after A made `--catchup-edits 10` edits while B was away. Each phase is a
 * minute-aligned gql window; the derived table divides HTTP invocations + inbound WS/20 by bursts / catch-ups.
 * The raw client has no HTTP candidate path: for the base candidate POST per burst use the L5 wire numbers
 * (`--l5 <L5 json>` embeds its wirePerSample summary). Client-side counts are included for cross-checking.
 */
export async function C5(ctx: RunCtx): Promise<Result> {
	const bursts = ctx.n(20);
	const burstSize = ctx.num("burst", 8);
	const interval = ctx.num("burst-interval", 125);
	const gap = ctx.num("burst-gap", 3000);
	const catchups = ctx.num("catchups", 10);
	const catchupEdits = ctx.num("catchup-edits", 10);
	const [body] = await freshNotes(ctx, "c5", 1, () => smallContent(5));
	// Sockets never idle across a minute-alignment wait (see C2: an evicted base DO closes surviving sockets).
	const windows: Win[] = [];
	let start = await alignToMinute();
	await sleep(55_000);
	windows.push(await closeWindow("idle", start));
	start = await alignToMinute();
	let a = await openOrThrow(await ctx.client("A", body!));
	let b = await openOrThrow(await ctx.client("B", body!));
	const aDoc = a.doc, bDoc = b.doc;
	const d0 = await diagnostics(ctx.context.devices.A!);
	const tracker = new CoverageTracker(b.doc);
	let idx = 0;
	for (let i = 0; i < bursts; i++) {
		for (let k = 0; k < burstSize; k++) { keystroke(a, tracker, idx++, "abcdefgh"[k % 8]!); if (k < burstSize - 1) await sleep(interval); }
		await sleep(gap);
	}
	await drain(tracker);
	tracker.stop();
	const burstProp = series(tracker.coveredMs, 0);
	windows.push(await closeWindow("bursts", start, { edits: bursts * burstSize, bursts, opens: 2 }));
	const d1 = await diagnostics(ctx.context.devices.A!);
	await a.close(); await b.close();
	start = await alignToMinute();
	a = await openOrThrow(await ctx.client("A", body!, aDoc));
	const catchupRows: Result[] = [];
	for (let i = 0; i < catchups; i++) {
		await b.close();
		for (let k = 0; k < catchupEdits; k++) { keystroke(a, null, 0, "z"); await sleep(100); }
		await sleep(500);
		b = await ctx.client("B", body!, bDoc);
		const t0 = now();
		const o = await b.open(30_000);
		catchupRows.push({ i, status: o.status, openMs: r2(now() - t0), bytesIn: b.bytesIn, phases: b.openPhases(), textEqual: b.text() === a.text() });
		await sleep(1000);
	}
	windows.push(await closeWindow("catchups", start, { catchups, editsWhileAway: catchupEdits, opens: catchups + 1 }));
	const d2 = await diagnostics(ctx.context.devices.A!);
	const conv = await convergence({ bodyId: body!, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter });
	await a.close(); await b.close();
	const gql = await gqlWindows(ctx, windows);
	const g = Array.isArray(gql) ? gql : [];
	const idle = g.find((w) => w.name === "idle"), bw = g.find((w) => w.name === "bursts"), cw = g.find((w) => w.name === "catchups");
	const idlePerMin = (key: "httpRequests" | "inbound") => {
		if (!idle || idle.error) return 0;
		const v = key === "httpRequests" ? Number(idle.httpRequests ?? 0) + Number(idle.alarms ?? 0) : Number((idle.totals as Counters).inboundWsEffective ?? 0);
		return v / Math.max(1, Number(idle.bucketMinutes ?? 1));
	};
	const derive = (w: Result | undefined, units: number, unitName: string) => {
		if (!w || w.error) return null;
		const minutes = Number(w.bucketMinutes ?? 0);
		const http = Number(w.httpRequests ?? 0) + Number(w.alarms ?? 0) - idlePerMin("httpRequests") * minutes;
		const inbound = Number((w.totals as Counters).inboundWsEffective ?? 0) - idlePerMin("inbound") * minutes;
		const outbound = Number((w.totals as Counters).outboundWebsocketMsgCount ?? 0);
		return { unit: unitName, units, httpPlusAlarmRequestsPerUnit: r2(http / units), inboundWsPerUnit: r2(inbound / units),
			outboundWsPerUnit: r2(outbound / units), doRequestUnitsPerUnit: r2((http + inbound / 20) / units),
			rowsWrittenPerUnit: r2(Number((w.totals as Counters).rowsWritten ?? 0) / units) };
	};
	const l5Path = ctx.str("l5");
	let l5: Result | null = null;
	if (l5Path) {
		try {
			const j = JSON.parse(readFileSync(l5Path, "utf8")) as { burst?: number; results: Record<string, { wirePerSample: Result }> };
			l5 = { path: l5Path, burst: j.burst, byMode: Object.fromEntries(Object.entries(j.results).map(([m, r]) => [m, r.wirePerSample])) };
		} catch (e) { l5 = { path: l5Path, error: String(e) }; }
	}
	return { bodyId: body, adapter: ctx.adapter.name, bursts, burstSize, burstIntervalMs: interval, burstGapMs: gap, catchups, catchupEdits,
		clientWsMessagesPerEdit: ctx.adapter.name === "base" ? 1 : 2,
		derived: { perBurst: derive(bw, bursts, "burst"), perCatchup: derive(cw, catchups, "catch-up (reconnect + step1/step2)") },
		burstPropagationMs: burstProp, catchups: catchupRows,
		catchupOpenMs: series(catchupRows.map((r) => r.openMs as number), 0),
		relayCounterDelta: { bursts: counterDelta(d0, d1), catchups: counterDelta(d1, d2) },
		l5Reference: l5, windows, gql, convergence: conv };
}

// ---------------------------------------------------------------------------------------------------------------
// C6 — bundle size and startup from the deploy record
// ---------------------------------------------------------------------------------------------------------------

/** `--compare <host>` adds a second deploy record (base vs relay). No traffic. */
export async function C6(ctx: RunCtx): Promise<Result> {
	const pick = (host: string) => {
		const d = deployRecord(host);
		if (!d) return { worker: workerName(host), error: "no deploy record (logs/relay2/deploy-<name>.json)" };
		const keys = ["workerName", "bundle", "startupMs", "spikeSha", "deploymentVersionId", "deployedAt", "relay", "vars", "dirtyServerFiles"];
		return { worker: workerName(host), ...Object.fromEntries(keys.filter((k) => d[k] !== undefined).map((k) => [k, d[k]])) };
	};
	const self = pick(ctx.host);
	const other = ctx.str("compare");
	return { self, compare: other ? pick(other.replace(/\/+$/, "")) : null, convergence: { pass: null, note: "no traffic" } };
}

// ---------------------------------------------------------------------------------------------------------------
// K1 — routine checkpoint cost vs tail size
// ---------------------------------------------------------------------------------------------------------------

/**
 * `--tails 50,500,5000` `--repeats 1` `--trigger compact|alarm` `--rate 200`.
 * compact (checkpoint-knob worker: CHECKPOINT_ENTRIES/BYTES/MAX_ROWS raised so tails accumulate): fresh quick-trace
 * body, replay T frames, confirm logRows≈T, then POST debug/compact (checkpoints every active body; earlier bodies
 * are already compacted, so the cost is this body's). Reports compact wall ms, relay lastCheckpointMs /
 * checkpointRowsWritten / checkpoints delta, logRows and ywasm memory before/after; `compactSentAtWall` joins the
 * tail event (cpu/wall) with --tail.
 * alarm (default-knob worker): replay T frames and let the alarm checkpoint at its thresholds; reports the
 * checkpoint counters the alarms produced and the per-checkpoint mean duration.
 */
export async function K1(ctx: RunCtx): Promise<Result> {
	const tails = ctx.str("tails", "50,500,5000")!.split(",").map(Number);
	const repeats = ctx.num("repeats", 1);
	const trigger = ctx.str("trigger", "compact")!;
	const rate = ctx.num("rate", 200);
	const trace = loadTrace();
	const rows: Result[] = [];
	let lastConv: Result | null = null;
	// debug/compact is vault-wide: the first call also checkpoints every seeded body (seen: 612 checkpoint rows
	// for a 50-entry tail). A warm-up compact makes each measured compact cover only the fresh tail body.
	let warmup: Result | null = null;
	if (trigger === "compact") {
		const t0 = now();
		const res = await operatorVaultPost(ctx, "debug/compact");
		warmup = { status: res.status, ms: r2(now() - t0), value: typeof res.value === "object" ? res.value : String(res.value).slice(0, 300) };
		await sleep(1500);
	}
	const d00 = await diagnostics(ctx.context.devices.A!);
	for (const [ti, tail] of tails.entries()) {
		for (let rep = 0; rep < repeats; rep++) {
			const body = await freshTraceBody(ctx, trace, `k1-${tail}-${ti}-${rep}`);
			const a = await openOrThrow(await ctx.client("A", body), 60_000);
			const n = Math.min(tail, trace.frames.length);
			const replay = await replayTrace(a, trace.frames, rate, { limit: n });
			const ackDeadline = now() + 60_000;
			while (a.acks.length < replay.sent && now() < ackDeadline) await sleep(50);
			await sleep(2000);
			const before = await diagnostics(ctx.context.devices.A!);
			const r: Result = { tail, rep, bodyId: body, framesSent: replay.sent, acks: a.acks.length, replayMs: replay.durationMs,
				bodyBefore: relayBody(before, body), ywasmBefore: (before.relay as Result | undefined)?.ywasmLinearMemoryBytes ?? null };
			let after: Result;
			if (trigger === "compact") {
				const sentWall = Date.now();
				const t0 = now();
				const res = await operatorVaultPost(ctx, "debug/compact");
				r.compact = { status: res.status, ms: r2(now() - t0), compactSentAtWall: sentWall,
					value: typeof res.value === "object" ? res.value : String(res.value).slice(0, 300) };
				await sleep(1500);
				after = await diagnostics(ctx.context.devices.A!);
			} else {
				const until = now() + ctx.num("alarm-wait-ms", 60_000);
				after = before;
				while (now() < until) {
					await sleep(3000);
					after = await diagnostics(ctx.context.devices.A!);
					const b = relayBody(after, body);
					if (b && Number(b.logRows) < Number(ctx.num("alarm-settle-rows", 60))) break;
				}
			}
			const delta = counterDelta(before, after);
			const c1 = relayCounters(after);
			r.bodyAfter = relayBody(after, body);
			r.ywasmAfter = (after.relay as Result | undefined)?.ywasmLinearMemoryBytes ?? null;
			r.relayCounterDelta = delta;
			r.lastCheckpointMs = c1?.lastCheckpointMs ?? null;
			r.checkpointsInWindow = delta?.checkpoints ?? 0;
			r.checkpointRowsWrittenInWindow = delta?.checkpointRowsWritten ?? 0;
			r.vaultJournalRows = { before: (before.relay as Result | undefined)?.vaultJournalRows ?? null, after: (after.relay as Result | undefined)?.vaultJournalRows ?? null };
			log(`K1 tail=${tail} rep=${rep}: ${JSON.stringify({ compact: r.compact, lastCheckpointMs: r.lastCheckpointMs, logRows: [(r.bodyBefore as Result | null)?.logRows, (r.bodyAfter as Result | null)?.logRows] })}`);
			if (rep === repeats - 1 && tail === tails.at(-1)) {
				lastConv = await convergence({ bodyId: body, clients: [a], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000,
					expectedTextSha: n === trace.frames.length ? trace.finalSha : undefined });
			}
			a.terminate(); a.doc.destroy();
			rows.push(r);
			await sleep(2000);
		}
	}
	const cfg = (d00.relay as { config?: Result } | undefined)?.config ?? null;
	return { trigger, tails, repeats, rate, relayConfig: cfg, warmupCompact: warmup,
		summary: tails.map((t) => {
			const mine = rows.filter((x) => x.tail === t);
			return { tail: t, compactMs: series(mine.map((x) => (x.compact as Result | undefined)?.ms as number | undefined), 0),
				lastCheckpointMs: series(mine.map((x) => x.lastCheckpointMs as number | null), 0),
				logRowsBefore: mine.map((x) => (x.bodyBefore as Result | null)?.logRows ?? null),
				logRowsAfter: mine.map((x) => (x.bodyAfter as Result | null)?.logRows ?? null),
				checkpointRowsWritten: mine.map((x) => x.checkpointRowsWrittenInWindow),
				ywasmBytes: mine.map((x) => [x.ywasmBefore, x.ywasmAfter]) };
		}),
		rows, convergence: lastConv };
}

// ---------------------------------------------------------------------------------------------------------------
// MB — micro-batch / write-amplification sweep
// ---------------------------------------------------------------------------------------------------------------

/**
 * `--patterns l2,burst,stream` `--pattern-seconds 110` `--rate 25` (stream). Per pattern: minute-aligned window,
 * A types (l2: 1 char / 500 ms; burst: 1 char / 125 ms ≈ 8 chars/s; stream: quick-trace frames at 25/s) without
 * waiting for acks, B measures propagation. Rows written per edit = gql rowsWritten over the window (plus the
 * minute after, where alarms/checkpoints land) minus the idle baseline, and relay diagnostics counters.rowsWritten
 * delta. `clamped` = requested YAOS_RELAY_MICROBATCH_MS (deploy vars) ≠ effective relay.config.microbatchMs.
 */
export async function MB(ctx: RunCtx): Promise<Result> {
	const patterns = ctx.str("patterns", "l2,burst,stream")!.split(",");
	const seconds = ctx.num("pattern-seconds", 110);
	const rate = ctx.num("rate", 25);
	const deploy = deployRecord(ctx.host);
	const requested = ((deploy?.vars as Record<string, string> | undefined) ?? {}).YAOS_RELAY_MICROBATCH_MS ?? null;
	const d00 = await diagnostics(ctx.context.devices.A!);
	const effective = (d00.relay as { config?: Result } | undefined)?.config?.microbatchMs ?? null;
	const windows: Win[] = [];
	const parts: Result[] = [];
	let start = await alignToMinute();
	await sleep(55_000);
	windows.push(await closeWindow("idle", start));
	const trace = loadTrace();
	const convs: Result[] = [];
	for (const p of patterns) {
		const body = p === "stream" ? await freshTraceBody(ctx, trace, "mb-stream") : (await freshNotes(ctx, `mb-${p}`, 1, () => smallContent(9)))[0]!;
		start = await alignToMinute();   // before opening: base closes sockets left idle across an eviction
		const a = await openOrThrow(await ctx.client("A", body), 60_000);
		const b = await openOrThrow(await ctx.client("B", body), 60_000);
		const d0 = await diagnostics(ctx.context.devices.A!);
		const tracker = new CoverageTracker(b.doc);
		let edits = 0;
		if (p === "stream") {
			const r = await replayTrace(a, trace.frames, rate, { tracker, limit: Math.min(trace.frames.length, Math.floor(seconds * rate)) });
			edits = r.sent;
		} else {
			const spacing = p === "l2" ? 500 : 125;
			const t0 = now();
			for (let i = 0; now() - t0 < seconds * 1000; i++) {
				const wait = t0 + i * spacing - now();
				if (wait > 1) await sleep(wait);
				keystroke(a, tracker, i, String.fromCharCode(97 + (i % 26)));
				edits++;
			}
		}
		const drained = await drain(tracker);
		tracker.stop();
		const d1 = await diagnostics(ctx.context.devices.A!);
		// Include the following minute (alarm checkpoints triggered by this pattern land there).
		await sleep(60_000 - (Date.now() % 60_000) + 1500);
		await sleep(55_000);
		const d2 = await diagnostics(ctx.context.devices.A!);
		windows.push(await closeWindow(p, start, { edits }));
		const delta = counterDelta(d0, d2);
		parts.push({ pattern: p, bodyId: body, edits, drained, propagationMs: series(tracker.coveredMs, 0),
			propagationSamplesMs: tracker.coveredMs.map((x) => (x == null ? null : r2(x))),
			sequenceDelta: Number(d1.sequence) - Number(d0.sequence),
			relayRowsWrittenPerEdit: delta?.rowsWritten !== undefined ? r2(delta.rowsWritten / edits) : null,
			relayAppendsPerEdit: delta?.appends !== undefined ? r2(delta.appends / edits) : null,
			relayCounterDelta: delta, relayBodyAfter: relayBody(d2, body) });
		convs.push(await convergence({ bodyId: body, clients: [a, b], fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000 }));
		a.terminate(); b.terminate(); a.doc.destroy(); b.doc.destroy();
		log(`MB ${p}: edits=${edits} ${JSON.stringify(parts.at(-1)!.propagationMs)}`);
	}
	const gql = await gqlWindows(ctx, windows);
	const g = Array.isArray(gql) ? gql : [];
	const idle = g.find((w) => w.name === "idle");
	for (const part of parts) {
		const w = g.find((x) => x.name === part.pattern);
		part.gqlRowsWritten = perEdit(w, idle, Number(part.edits), "rowsWritten");
		part.gqlCpuUs = perEdit(w, idle, Number(part.edits), "cpuTime");
	}
	return { adapter: ctx.adapter.name, microbatch: { requested, effective,
		clamped: requested !== null && effective !== null && Number(requested) !== Number(effective) },
		relayConfig: (d00.relay as { config?: Result } | undefined)?.config ?? null,
		table: parts.map((x) => ({ pattern: x.pattern, edits: x.edits, rowsPerEditGql: (x.gqlRowsWritten as Result | null)?.perEdit ?? null,
			rowsPerEditRelayCounter: x.relayRowsWrittenPerEdit, propagationP50: (x.propagationMs as { summary: Result | null }).summary?.p50 ?? null,
			propagationP90: (x.propagationMs as { summary: Result | null }).summary?.p90 ?? null })),
		parts, windows, gql,
		convergence: { pass: convs.every((c) => c.pass === true), parts: convs } };
}

// ---------------------------------------------------------------------------------------------------------------
// CW — concurrent writers, D6 invariant #7
// ---------------------------------------------------------------------------------------------------------------

/**
 * `--writers 4` `--seconds 60` `--edit-ms 200` `--get-ms 1000`. Writers type into one body concurrently (so client
 * SVs rarely equal the merged SV); a checker GETs the body every `get-ms`: the response's recorded hash header
 * (x-yaos-content-hash, state x-yaos-content-hash-state) must equal contentHashOf(response text) whenever present
 * (the GET is one atomic server response). Also HEAD vs GET at the end, and hashAccepted/hashUnknown deltas.
 */
export async function CW(ctx: RunCtx): Promise<Result> {
	const writersN = ctx.num("writers", 4);
	const seconds = ctx.num("seconds", 60);
	const editMs = ctx.num("edit-ms", 200);
	const getMs = ctx.num("get-ms", 1000);
	const [body] = await freshNotes(ctx, "cw", 1, () => smallContent(11));
	const names = ["A", "B", "D", "E", "S1", "S2", "S3", "S4"].slice(0, writersN);
	const writers: RawClient[] = [];
	for (const n of names) writers.push(await openOrThrow(await ctx.client(n, body!)));
	await sleep(1000);
	const d0 = await diagnostics(ctx.context.devices.A!);
	const checks: Result[] = [];
	let stop = false;
	const checker = (async () => {
		while (!stop) {
			const t0 = now();
			const g = await bodyGet(ctx.context.devices.C!, body!).catch((e) => ({ status: 0, error: String(e) } as Result));
			const header = (g as Result).contentHash as string | null | undefined;
			const state = ((g as Result).yaosHeaders as Record<string, string> | undefined)?.["x-yaos-content-hash-state"] ?? null;
			const stored = (g as Result).storedHash as string | undefined;
			checks.push({ at: r2(t0), status: g.status, state, headerPresent: Boolean(header),
				holds: header ? header === stored : null, bytes: (g as Result).bytes });
			await sleep(Math.max(0, getMs - (now() - t0)));
		}
	})();
	const t0 = now();
	let edits = 0;
	const loops = writers.map(async (w, k) => {
		await sleep(k * (editMs / writersN));
		for (let i = 0; now() - t0 < seconds * 1000; i++) {
			if (!w.isOpen) break;
			w.edit((t) => t.insert(Math.floor(Math.random() * (t.length + 1)), String.fromCharCode(65 + k)));
			edits++;
			await sleep(editMs);
		}
	});
	await Promise.all(loops);
	stop = true;
	await checker;
	await sleep(3000);
	const d1 = await diagnostics(ctx.context.devices.A!);
	const conv = await convergence({ bodyId: body!, clients: writers, fresh: await ctx.dev("C"), adapter: ctx.adapter, settleMs: 30_000 });
	const final = await bodyGet(ctx.context.devices.C!, body!);
	for (const w of writers) await w.close();
	const known = checks.filter((c) => c.holds !== null);
	const violations = checks.filter((c) => c.holds === false);
	const delta = counterDelta(d0, d1);
	return { bodyId: body, writers: writersN, seconds, editMs, edits, checks: checks.length,
		invariant7: { checksWithRecordedHash: known.length, holds: known.length - violations.length, violations: violations.length,
			unknownOrAbsent: checks.length - known.length, states: checks.reduce<Record<string, number>>((m, c) => {
				const k = String(c.state); m[k] = (m[k] ?? 0) + 1; return m; }, {}),
			pass: violations.length === 0, finalGetHolds: final.contentHash ? final.contentHash === final.storedHash : "unknown",
			finalClientHash: contentHashOf(writers[0]!.text()).contentHash === final.storedHash },
		hashAccepted: delta?.hashAccepted ?? null, hashUnknown: delta?.hashUnknown ?? null, relayCounterDelta: delta,
		violationSamples: violations.slice(0, 10), convergence: conv };
}
