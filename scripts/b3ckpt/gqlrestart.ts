// b3-ckpt: isolate-level evidence for DO restarts. Per-minute invocation status breakdown
// (durableObjectsInvocationsAdaptiveGroups) + periodic exceededCpu/Memory errors for one worker/window.
// usage: gqlrestart.ts --worker <name> --start <ISO> --end <ISO> [--class VaultSyncServer] [--out f.json]
import { writeFileSync } from "node:fs";
import { flagStr, parseArgs } from "../relay2/lib/common";
import { namespaceId, token } from "../relay2/gql";

const ACCOUNT = "261336883158b276696d7181091ba1a6";
const args = parseArgs();
const worker = flagStr(args, "worker")!, start = flagStr(args, "start")!, end = flagStr(args, "end")!;
const className = flagStr(args, "class", "VaultSyncServer")!;
const tok = token();
const ns = await namespaceId(tok, worker, className);
const query = `query($acct: String!, $ns: String!, $script: String!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $acct}) {
    inv: durableObjectsInvocationsAdaptiveGroups(limit: 2000, orderBy: [datetimeMinute_ASC],
        filter: {scriptName: $script, namespaceId: $ns, datetime_geq: $start, datetime_leq: $end}) {
      dimensions { datetimeMinute type status }
      sum { requests errors wallTime }
      quantiles { cpuTimeP99 wallTimeP99 }
    }
    per: durableObjectsPeriodicGroups(limit: 2000, orderBy: [datetimeMinute_ASC],
        filter: {namespaceId: $ns, datetimeMinute_geq: $start, datetimeMinute_leq: $end}) {
      dimensions { datetimeMinute }
      sum { cpuTime activeTime rowsRead rowsWritten exceededCpuErrors exceededMemoryErrors }
      max { activeWebsocketConnections }
    }
  } } }`;
const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST",
	headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
	body: JSON.stringify({ query, variables: { acct: ACCOUNT, ns, script: worker, start, end } }) });
const j = await r.json() as { data?: { viewer: { accounts: Array<{ inv: Array<{ dimensions: Record<string, string>; sum: Record<string, number> }>; per: Array<{ dimensions: Record<string, string>; sum: Record<string, number>; max?: Record<string, number> }> }> } }; errors?: unknown };
if (j.errors) { console.error(JSON.stringify(j.errors).slice(0, 600)); process.exit(1); }
const a = j.data!.viewer.accounts[0]!;
const out = flagStr(args, "out");
if (out) writeFileSync(out, JSON.stringify({ worker, start, end, ns: "(redacted)", ...a }, null, 1));
const statuses: Record<string, number> = {};
for (const row of a.inv) { const k = `${row.dimensions.type}/${row.dimensions.status}`; statuses[k] = (statuses[k] ?? 0) + row.sum.requests; }
const nonOk = a.inv.filter((x) => x.dimensions.status !== "success").map((x) => `${x.dimensions.datetimeMinute} ${x.dimensions.type}/${x.dimensions.status} n=${x.sum.requests}`);
const errMin = a.per.filter((x) => x.sum.exceededCpuErrors || x.sum.exceededMemoryErrors).map((x) => `${x.dimensions.datetimeMinute} cpuErr=${x.sum.exceededCpuErrors} memErr=${x.sum.exceededMemoryErrors}`);
console.log(JSON.stringify({ worker, statuses, nonOk: nonOk.slice(0, 30), errMinutes: errMin.slice(0, 30), minutes: a.per.length }, null, 1));
