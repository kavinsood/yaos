// Prints only the non-secret `runtime` block of debug/sql-rows (DO instance epoch,
// start time, wasm linear memory, relay checkpoint counters) for a host's saved context.
// usage: runtime.ts --host https://<worker>.workers.dev
import { flagStr, parseArgs } from "../relay2/lib/common";
import { loadContext } from "../relay2/lib/context";
import { RowsCounter } from "../relay2/wb/adapters";

const args = parseArgs(process.argv.slice(2));
const host = flagStr(args, "host")!;
const counter = new RowsCounter(loadContext(host), undefined, "debug-route");
const reading = await counter.read();
const runtime = (reading.extra as { runtime?: Record<string, unknown> } | undefined)?.runtime ?? null;
const startedAt = runtime && typeof runtime.startedAt === "number" ? new Date(runtime.startedAt).toISOString() : null;
console.log(JSON.stringify({ host: host.replace(/^https:\/\//, "").split(".")[0], at: new Date().toISOString(), rowsWritten: reading.rowsWritten,
	runtime: runtime && { ...runtime, startedAt } }));
