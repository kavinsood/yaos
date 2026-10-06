/**
 * Relay v2 benchmark harness — one CLI for every §7 scenario, same client code for baseline and relay.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/bench.ts <scenario> --host <url> --out <json>
 *        [--n N] [--adapter base|relay|relay-sv] [--tail] [scenario flags...]
 *
 * Requires a context (scripts/relay2/context.ts) for the host. Writes JSON per brief §6.1: run metadata
 * (worker, deployment version, base/spike SHA, vars, edge colo, competing processes), raw samples and
 * summaries (first 10 samples of each latency series discarded), plus a convergence check.
 */
import { join } from "node:path";
import { LOG_DIR, flagStr, log, parseArgs, startMeta, writeResult, workerName } from "./lib/common";
import { loadContext } from "./lib/context";
import { adapterFor, ALL_CLIENTS } from "./lib/rawClient";
import { makeCtx, TailCapture, type RunCtx } from "./lib/run";
import * as latency from "./scenarios/latency";
import * as cost from "./scenarios/cost";
import * as behaviour from "./scenarios/behaviour";
import * as limits from "./scenarios/limits";
import * as extra from "./scenarios/extra";
import * as v3 from "./scenarios/v3";
import * as wb from "./wb/scenarios";
import * as r1dl from "./wb/r1dl/scenarios";
import * as mimport from "./wb/mimport";
import * as b3 from "./b3/scenarios";

type Scenario = (ctx: RunCtx) => Promise<Record<string, unknown>>;
const SCENARIOS: Record<string, Scenario> = {
	L1: latency.L1, L2: latency.L2, L3: latency.L3, L4: latency.L4, L6: latency.L6, L7: latency.L7,
	C1: cost.C1, C3: cost.C3, C4: cost.C4,
	B1: behaviour.B1, B2: behaviour.B2, B3: behaviour.B3, B4: behaviour.B4, B6: behaviour.B6, B7: behaviour.B7, B8: behaviour.B8,
	X1: limits.X1, X2: limits.X2, X3: limits.X3, X4: limits.X4,
	C2: extra.C2, C5: extra.C5, C6: extra.C6, K1: extra.K1, MB: extra.MB, CW: extra.CW,
	CRASH: v3.CRASH, FENCE: v3.FENCE, HTTPSAVE: v3.HTTPSAVE,
	// Closed-file merge (R1, emulated client reconcile); see wb/r1dl/scenarios.ts.
	R1: r1dl.R1,
	diag: cost.diag,
	// Write-budget spike (PHASE3-WRITE-BUDGET-SPIKE §3 W4); see wb/scenarios.ts.
	// b3-bulk: bulk-create scenarios only (C4W/XCRASH = W1 typing, R1 = W3 merge, A1/L5R not in scope).
	I1: wb.I1, I2: wb.I2, I3: wb.I3, I4: wb.I4,
	// b3-m-import: I1 + projection wait; see wb/mimport.ts.
	I1P: mimport.I1P,
	// b3-m-typing (scripts/relay2/b3/scenarios.ts): autosave rewrite with hash-state probes; request-free idle.
	A1R: b3.A1R, IDLE0: b3.IDLE0,
};

/** Every socket close / error / reconnect / drop across all raw clients of this run (round-3 robustness record). */
function connectionEvents() {
	const eventful = ALL_CLIENTS.filter((c) => c.closeLog.some((x) => !x.byClient) || c.errorLog.length > 0 || c.reconnects.length > 0
		|| c.droppedWhileClosed > 0 || (c.adapter.requireEcho === true && c.unacked > 0));
	const closes = ALL_CLIENTS.flatMap((c) => c.closeLog.filter((x) => !x.byClient));
	const byCode: Record<string, number> = {};
	for (const c of closes) byCode[`${c.code} ${c.reason || c.origin}`] = (byCode[`${c.code} ${c.reason || c.origin}`] ?? 0) + 1;
	return { clients: ALL_CLIENTS.length, unexpectedCloses: closes.length, unexpectedClosesByCode: byCode,
		reconnectsOk: ALL_CLIENTS.reduce((n, c) => n + c.reconnects.filter((r) => r.ok).length, 0),
		reconnectsFailed: ALL_CLIENTS.reduce((n, c) => n + c.reconnects.filter((r) => !r.ok).length, 0),
		resentFrames: ALL_CLIENTS.reduce((n, c) => n + c.resentFrames, 0),
		droppedWhileClosed: ALL_CLIENTS.reduce((n, c) => n + c.droppedWhileClosed, 0),
		errors: ALL_CLIENTS.reduce((n, c) => n + c.errorLog.length, 0),
		clientsWithEvents: eventful.slice(0, 200).map((c) => c.connectionReport()) };
}

async function main() {
	const args = parseArgs();
	const scenario = args.positional[0];
	const host = flagStr(args, "host")?.replace(/\/+$/, "");
	if (!scenario || !SCENARIOS[scenario] || !host) {
		console.error(`usage: bench.ts <${Object.keys(SCENARIOS).join("|")}> --host <url> [--out <json>] [--n N] [--adapter base|relay]`);
		process.exit(2);
	}
	const adapter = adapterFor(flagStr(args, "adapter"));
	const out = flagStr(args, "out") ?? join(LOG_DIR, "runs", `${workerName(host)}-${scenario}-${Date.now()}.json`);
	const context = loadContext(host);
	const meta = await startMeta(scenario, host, adapter.name);
	if (meta.competingProcesses.length > 0) log(`competing processes: ${meta.competingProcesses.join(" | ")}`);
	const ctx = makeCtx(host, context, args, adapter, scenario);
	const tail = args.flags.tail ? new TailCapture(host, scenario) : null;
	if (tail) await tail.start(host);
	let body: Record<string, unknown>;
	try {
		body = await SCENARIOS[scenario]!(ctx);
	} catch (error) {
		body = { error: String(error instanceof Error ? error.stack : error) };
		console.error(error);
	} finally {
		if (tail) await tail.stop();
	}
	const conv = body.convergence as { pass?: boolean } | undefined;
	writeResult(out, meta, { ...body, tailFile: tail?.path ?? null, notes: ctx.notes,
		convergencePass: conv?.pass ?? null, connectionEvents: connectionEvents() });
	log(`${scenario} done; convergence=${conv?.pass ?? "n/a"}${body.error ? " ERROR" : ""}`);
	process.exit(body.error ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
