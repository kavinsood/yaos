/**
 * b3-m-typing: GraphQL durableObjectsPeriodicGroups totals for EVERY DO class of a worker over named windows.
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/b3/gqlclasses.ts --worker <name> \
 *        --win name=<ISO>..<ISO> [--win ...] [--out file.json]
 *
 * Buckets whose minute lies in [floor(start), floor(end)] are summed (queryWindow pulls one extra trailing minute).
 * Prints a compact table; the full per-minute series goes to --out. The OAuth token is never printed.
 */
import { writeFileSync } from "node:fs";
import { queryWindow } from "../gql";
import { parseArgs, flagStr } from "../lib/common";

const CLASSES = ["VaultSyncServer", "RecoveryJob", "ServerConfig"];
const floorMin = (iso: string) => Math.floor(Date.parse(iso) / 60_000) * 60_000;

async function main() {
	const args = parseArgs();
	const worker = flagStr(args, "worker")!;
	const raw = process.argv.filter((_x, i, a) => a[i - 1] === "--win");
	const wins = raw.map((w) => { const [name, span] = w.split("="); const [start, end] = span!.split(".."); return { name: name!, start: start!, end: end! }; });
	const out: Record<string, unknown>[] = [];
	for (const w of wins) {
		const row: Record<string, unknown> = { window: w.name, start: w.start, end: w.end, minutes: (floorMin(w.end) - floorMin(w.start)) / 60_000 + 1 };
		for (const cls of CLASSES) {
			let q: Awaited<ReturnType<typeof queryWindow>> | null = null;
			for (let attempt = 1; attempt <= 4 && !q; attempt++) {
				try { q = await queryWindow(worker, w.start, w.end, cls); }
				catch (error) { if (attempt === 4) { row[cls] = { error: String(error).slice(0, 200) }; } else await new Promise((r) => setTimeout(r, 5000 * attempt)); }
			}
			if (!q) continue;
			const lo = floorMin(w.start), hi = floorMin(w.end);
			const mins = q.periodicMinutes.filter((m) => { const t = Date.parse(m.dimensions.datetimeMinute!); return t >= lo && t <= hi; });
			const sum = (k: string) => mins.reduce((s, m) => s + Number((m.sum as Record<string, number>)[k] ?? 0), 0);
			const byMinute: Record<string, { w: number; r: number }> = {};
			for (const m of mins) {
				const k = m.dimensions.datetimeMinute!.slice(11, 16);
				const s = m.sum as Record<string, number>;
				byMinute[k] = { w: (byMinute[k]?.w ?? 0) + Number(s.rowsWritten ?? 0), r: (byMinute[k]?.r ?? 0) + Number(s.rowsRead ?? 0) };
			}
			const requests = (q.invocations as Array<{ sum: Record<string, number> }>).reduce((s, i) => s + Number(i.sum.requests ?? 0), 0);
			row[cls] = { rowsWritten: sum("rowsWritten"), rowsRead: sum("rowsRead"), cpuTimeUs: sum("cpuTime"), objects: new Set(mins.map((m) => m.dimensions.objectId)).size,
				bucketMinutes: Object.keys(byMinute).length, invocationRequests: requests, byMinute };
		}
		out.push(row);
		const brief = CLASSES.map((c) => { const v = row[c] as Record<string, unknown> | undefined; return v && !("error" in v) ? `${c}: w=${v.rowsWritten} r=${v.rowsRead} req=${v.invocationRequests}` : `${c}: ${JSON.stringify(v)}`; }).join(" | ");
		console.log(`${w.name} [${w.start}..${w.end}] ${brief}`);
	}
	const file = flagStr(args, "out");
	if (file) writeFileSync(file, JSON.stringify({ worker, queriedAt: new Date().toISOString(), windows: out }, null, 1) + "\n");
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
