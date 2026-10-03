/**
 * Cloudflare GraphQL analytics for a relay2 worker's VaultSyncServer DO namespace over a time window.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/gql.ts --worker <name|url> \
 *        --start <ISO> --end <ISO> [--class VaultSyncServer] [--out file.json] [--run run.json --window editWindow]
 *
 * Datasets:
 *   durableObjectsInvocationsAdaptiveGroups: requests / wallTime / cpu quantiles per invocation type (sampled, adaptive)
 *   durableObjectsPeriodicGroups: cpuTime / rowsRead / rowsWritten / ws msg counts (exact, per-minute buckets)
 * Periodic groups are minute-granular: pad windows or use windows ≥ 2 min and subtract an idle baseline.
 * Analytics lag ~1-3 min behind real time; query after the window has settled.
 *
 * Auth: wrangler OAuth token from ~/Library/Preferences/.wrangler/config/default.toml (refreshed via
 * `wrangler whoami` if expired). The token is never printed or written.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { flagStr, parseArgs } from "./lib/common";

const ACCOUNT = "261336883158b276696d7181091ba1a6";
const CONFIG = `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`;
const WRANGLER = process.env.WRANGLER ?? "/Users/kavin/personal/obsidiansync/node_modules/.bin/wrangler";

export function token(): string {
	const read = () => {
		const cfg = readFileSync(CONFIG, "utf8");
		return { tok: cfg.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1], exp: cfg.match(/expiration_time\s*=\s*"([^"]+)"/)?.[1] };
	};
	let { tok, exp } = read();
	if (!tok || !exp || new Date(exp).getTime() < Date.now() + 60_000) {
		const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
		delete env.CLOUDFLARE_API_TOKEN;
		execFileSync(WRANGLER, ["whoami"], { env, stdio: "ignore" });
		({ tok } = read());
	}
	if (!tok) throw new Error("no wrangler oauth token");
	return tok;
}

async function api(tok: string, path: string, init?: RequestInit) {
	const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } });
	return await r.json() as Record<string, unknown>;
}

export async function namespaceId(tok: string, script: string, className: string): Promise<string> {
	for (let page = 1; page < 20; page++) {
		const r = await api(tok, `/accounts/${ACCOUNT}/workers/durable_objects/namespaces?per_page=100&page=${page}`);
		const list = (r.result as Array<{ id: string; script: string; class: string }> | undefined) ?? [];
		const hit = list.find((n) => n.script === script && n.class === className);
		if (hit) return hit.id;
		if (list.length < 100) break;
	}
	throw new Error(`namespace not found for ${script}/${className}`);
}

const floorMin = (iso: string) => new Date(Math.floor(Date.parse(iso) / 60_000) * 60_000).toISOString();
const ceilMin = (iso: string) => new Date(Math.ceil(Date.parse(iso) / 60_000) * 60_000).toISOString();

export async function queryWindow(worker: string, start: string, end: string, className = "VaultSyncServer") {
	const tok = token();
	const script = worker.startsWith("http") ? new URL(worker).hostname.split(".")[0]! : worker;
	const ns = await namespaceId(tok, script, className);
	const query = `query($acct: String!, $ns: String!, $script: String!, $start: Time!, $end: Time!, $pstart: Time!, $pend: Time!) {
	  viewer { accounts(filter: {accountTag: $acct}) {
	    inv: durableObjectsInvocationsAdaptiveGroups(limit: 100,
	        filter: {scriptName: $script, namespaceId: $ns, datetime_geq: $start, datetime_leq: $end}) {
	      dimensions { type status }
	      sum { requests errors wallTime responseBodySize }
	      quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 wallTimeP50 wallTimeP90 wallTimeP99 }
	    }
	    per: durableObjectsPeriodicGroups(limit: 1000, orderBy: [datetimeMinute_ASC],
	        filter: {namespaceId: $ns, datetimeMinute_geq: $pstart, datetimeMinute_leq: $pend}) {
	      dimensions { datetimeMinute objectId }
	      sum { cpuTime activeTime duration rowsRead rowsWritten storageReadUnits storageWriteUnits
	            inboundWebsocketMsgCount outboundWebsocketMsgCount subrequests exceededCpuErrors exceededMemoryErrors }
	    }
	  } }
	}`;
	const r = await api(tok, "/graphql", { method: "POST",
		body: JSON.stringify({ query, variables: { acct: ACCOUNT, ns, script, start, end, pstart: floorMin(start), pend: ceilMin(end) } }) });
	if (r.errors) throw new Error(`graphql: ${JSON.stringify(r.errors).slice(0, 500)}`);
	const acct = ((r.data as { viewer: { accounts: Array<Record<string, unknown>> } }).viewer.accounts[0]) ?? {};
	const per = (acct.per as Array<{ dimensions: Record<string, string>; sum: Record<string, number> }>) ?? [];
	const totals: Record<string, number> = {};
	for (const row of per) for (const [k, v] of Object.entries(row.sum)) totals[k] = (totals[k] ?? 0) + v;
	return { worker: script, namespaceId: ns, className, start, end, periodicWindow: [floorMin(start), ceilMin(end)],
		units: "cpuTime/wallTime/activeTime/duration in microseconds (GraphQL analytics)",
		invocations: acct.inv ?? [], periodicTotals: totals, periodicMinutes: per };
}

async function main() {
	const args = parseArgs();
	let start = flagStr(args, "start");
	let end = flagStr(args, "end");
	let worker = flagStr(args, "worker");
	const runPath = flagStr(args, "run");
	if (runPath) {
		const run = JSON.parse(readFileSync(runPath, "utf8")) as Record<string, unknown>;
		worker ??= run.workerName as string;
		const w = flagStr(args, "window");
		const win = (w ? run[w] : null) as { start?: string; end?: string } | null;
		start ??= win?.start ?? (run.startedAt as string);
		end ??= win?.end ?? (run.endedAt as string);
	}
	if (!worker || !start || !end) {
		console.error("usage: gql.ts --worker <name|url> --start <ISO> --end <ISO> | --run <run.json> [--window editWindow]");
		process.exit(2);
	}
	const result = await queryWindow(worker, start, end, flagStr(args, "class", "VaultSyncServer"));
	const out = flagStr(args, "out");
	if (out) writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
	console.log(JSON.stringify({ ...result, periodicMinutes: `${result.periodicMinutes.length} rows` }, null, 1));
}

if (process.argv[1]?.endsWith("relay2/gql.ts")) main().catch((e) => { console.error(String(e)); process.exit(1); });
