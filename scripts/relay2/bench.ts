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
import { adapterFor } from "./lib/rawClient";
import { makeCtx, TailCapture, type RunCtx } from "./lib/run";
import * as latency from "./scenarios/latency";
import * as cost from "./scenarios/cost";
import * as behaviour from "./scenarios/behaviour";
import * as limits from "./scenarios/limits";

type Scenario = (ctx: RunCtx) => Promise<Record<string, unknown>>;
const SCENARIOS: Record<string, Scenario> = {
	L1: latency.L1, L2: latency.L2, L3: latency.L3, L4: latency.L4, L6: latency.L6, L7: latency.L7,
	C1: cost.C1, C3: cost.C3, C4: cost.C4,
	B1: behaviour.B1, B2: behaviour.B2, B3: behaviour.B3, B4: behaviour.B4, B6: behaviour.B6, B7: behaviour.B7, B8: behaviour.B8,
	X1: limits.X1, X2: limits.X2, X3: limits.X3, X4: limits.X4,
	diag: cost.diag,
};

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
		convergencePass: conv?.pass ?? null });
	log(`${scenario} done; convergence=${conv?.pass ?? "n/a"}${body.error ? " ERROR" : ""}`);
	process.exit(body.error ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
