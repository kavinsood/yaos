/**
 * b3-m-import: one-shot probe of a vault — projection status, diagnostics (inline projection, daily limit), sql-rows.
 *   node tests/run-typescript.mjs --test-aliases scripts/b3measure/probe.ts <host> [--wait-ready <pollMs>]
 * Each call is 3 DO requests (status, diagnostics, sql-rows).
 */
import { loadContext } from "../relay2/lib/context";
import { RowsCounter } from "../relay2/wb/adapters";
import { projectionStatus, diagnostics } from "../relay2/wb/mimport";
const host = process.argv[2]!.replace(/\/+$/, "");
const wait = process.argv.indexOf("--wait-ready");
const pollMs = wait > 0 ? Number(process.argv[wait + 1] ?? 30000) : 0;
const ctx = loadContext(host);
const id = ctx.devices.A!;
let polls = 0;
for (;;) {
	const s = await projectionStatus(id); polls++;
	const p = s.projection as Record<string, unknown> | null;
	const ready = p?.state === "ready";
	if (!pollMs || ready) {
		const d = await diagnostics(id);
		const r = await new RowsCounter(ctx, undefined, "debug-route").read();
		console.log(JSON.stringify({ at: new Date().toISOString(), polls, projection: p, recoveryInlineProjection: d.recoveryInlineProjection, dailyLimit: d.dailyLimit,
			rows: { rowsWritten: r.rowsWritten, rowsRead: r.rowsRead, extra: r.extra } }));
		break;
	}
	if (polls % 10 === 1) console.log(JSON.stringify({ at: new Date().toISOString(), remaining: p?.remainingEntries, lag: p?.lagSequences }));
	await new Promise((res) => setTimeout(res, pollMs));
}
process.exit(0);
