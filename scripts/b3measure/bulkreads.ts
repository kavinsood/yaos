/**
 * b3-n2: exact rows READ per create-bulk batch as the vault grows, attributed to statements.
 * Runs against a live worker (local `wrangler dev` = workerd, the same rows-read counter Cloudflare bills)
 * with YAOS_TEST_ONLY_DEBUG_ROUTES=true; reads `debug/sql-rows?statements=N` (test-only per-statement tally).
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/b3measure/bulkreads.ts --host <url> --n 10000 [--batch 350]
 *        [--settle-ms 400] [--top 12] [--out <json>] [--tag t]
 * [--assert-ratio 1.5] exits 2 unless batch 20 / batch 1 rows read <= the limit.
 * Needs a context (scripts/relay2/context.ts --host <url> --devices A --seed none).
 */
import { writeFileSync } from "node:fs";
import { vaultRoute } from "../../tests/live/schema4Live";
import { deviceBearerHeaders } from "../../tests/live/liveIdentity";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../server/src/shared/binaryEnvelope";
import { flagNum, flagStr, log, parseArgs } from "../relay2/lib/common";
import { loadContext, refreshOperatorCookie } from "../relay2/lib/context";
import { bodyFrames, currentRootEpoch } from "../relay2/wb/adapters";

interface Statement { statement: string; execs: number; rowsRead: number; rowsWritten: number }
interface Snapshot { rowsRead: number; rowsWritten: number; execs: number; statements?: Statement[] }

function noteText(i: number, bytes = 2048): string {
	const line = `Line of note ${i} with some ordinary prose for sizing purposes.\n`;
	return `# Note ${i}\n\n${line.repeat(Math.ceil(bytes / line.length))}`.slice(0, bytes).trimEnd() + "\n";
}

async function main() {
	const args = parseArgs();
	const host = flagStr(args, "host")!.replace(/\/+$/, "");
	const n = flagNum(args, "n", 2000);
	const batch = flagNum(args, "batch", 350);
	const settleMs = flagNum(args, "settle-ms", 400);
	const top = flagNum(args, "top", 12);
	const tag = flagStr(args, "tag") ?? `br${Date.now().toString(36)}`;
	const context = loadContext(host);
	const identity = context.devices.A!;
	const counter = async (path: string, init: RequestInit = {}): Promise<Snapshot> => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const r = await fetch(vaultRoute(identity, path), { ...init, headers: { cookie: context.operatorCookie } });
			if (r.status === 401 && attempt === 0) { await r.arrayBuffer(); await refreshOperatorCookie(context); continue; }
			if (!r.ok) throw new Error(`${path} ${r.status}`);
			const value = await r.json() as Snapshot & { previous?: Snapshot };
			return value.previous ?? value;
		}
		throw new Error("unreachable");
	};
	const batches = [];
	for (let start = 0, b = 0; start < n; start += batch, b++) {
		const ids = Array.from({ length: Math.min(batch, n - start) }, (_v, k) => start + k);
		const files = ids.map((i) => ({ operationId: `${tag}-op-${i}`, bodyId: `${tag}-${i}`, path: `${tag}/f${i % 40}/n-${i}.md`,
			updates: bodyFrames(noteText(i)) }));
		const rootEpoch = await currentRootEpoch(identity);
		const body = encodeBinaryEnvelope({ batchId: `${tag}-b${b}`, rootEpoch, files, attachments: [] });
		await counter("debug/sql-rows/reset", { method: "POST" });
		const started = performance.now();
		const r = await fetch(vaultRoute(identity, "lifecycle/create-bulk"), { method: "POST",
			headers: deviceBearerHeaders(identity, { "Content-Type": YAOS_BINARY_CONTENT_TYPE }), body });
		const wallMs = Math.round(performance.now() - started);
		const decoded = r.headers.get("content-type")?.includes(YAOS_BINARY_CONTENT_TYPE)
			? decodeBinaryEnvelope(new Uint8Array(await r.arrayBuffer())) as { outcomes: Array<{ outcome: string }> }
			: await r.json() as Record<string, unknown>;
		const created = Array.isArray((decoded as { outcomes?: unknown }).outcomes)
			? (decoded as { outcomes: Array<{ outcome: string }> }).outcomes.filter((o) => o.outcome === "created").length : 0;
		if (!r.ok || created !== files.length) throw new Error(`batch ${b}: ${r.status} created=${created} ${JSON.stringify(decoded).slice(0, 300)}`);
		await new Promise((resolve) => setTimeout(resolve, settleMs));
		const snap = await counter(`debug/sql-rows?statements=${top}`);
		batches.push({ batch: b, vaultBefore: start, notes: ids.length, rowsRead: snap.rowsRead, rowsWritten: snap.rowsWritten,
			execs: snap.execs, wallMs, statements: snap.statements });
		log(`batch ${b} vaultBefore=${start} read=${snap.rowsRead} written=${snap.rowsWritten} execs=${snap.execs} wall=${wallMs}ms`
			+ ` top=${(snap.statements ?? []).slice(0, 3).map((s) => `${s.rowsRead}:${s.statement.slice(0, 60)}`).join(" | ")}`);
	}
	const total = batches.reduce((sum, item) => sum + item.rowsRead, 0);
	const first = batches[1] ?? batches[0]!;
	const last = batches.at(-1)!;
	const summary = { n, batch, batches: batches.length, totalRowsRead: total,
		totalRowsWritten: batches.reduce((sum, item) => sum + item.rowsWritten, 0),
		readsPerBatch: batches.map((item) => item.rowsRead), ratioLastToSecond: last.rowsRead / Math.max(1, first.rowsRead) };
	log(`summary ${JSON.stringify({ ...summary, readsPerBatch: undefined })}`);
	const out = flagStr(args, "out");
	if (out) writeFileSync(out, JSON.stringify({ host, tag, summary, batches }, null, 2));
	// --assert-ratio R: batch 20 / batch 1 (1-based) rows read must be <= R (needs >= 20 batches).
	const limit = flagStr(args, "assert-ratio");
	if (limit !== undefined) {
		if (batches.length < 20) throw new Error("--assert-ratio needs at least 20 batches");
		const ratio = batches[19]!.rowsRead / Math.max(1, batches[0]!.rowsRead);
		log(`batch20/batch1 = ${batches[19]!.rowsRead}/${batches[0]!.rowsRead} = ${ratio.toFixed(3)} (limit ${limit})`);
		if (!(ratio <= Number(limit))) { console.error("FAIL: reads per batch grow with the vault"); process.exit(2); }
		log("PASS: reads per batch flat");
	}
}

main().catch((error) => { console.error(error); process.exit(1); });
