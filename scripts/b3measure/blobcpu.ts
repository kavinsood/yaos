/**
 * b3-m-import: front-Worker CPU for attachment (blob) uploads and `canceled` rate on streamed requests, against a deployed
 * yaos-relay2-* worker on the production path (no profiling modes).
 *   node tests/run-typescript.mjs --test-aliases scripts/b3measure/blobcpu.ts --host <url> --out <jsonl> [--only a,b] [--scale 1] [--tail]
 * Every request carries ?b3c=<cell>&b3i=<i>&b3t=<tag>; join with scripts/b3measure/analyze.py <tail.jsonl> <tag>.
 */
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { vaultRoute } from "../../tests/live/schema4Live";
import { deviceBearerHeaders } from "../../tests/live/liveIdentity";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../server/src/shared/binaryEnvelope";
import { flagStr, log, parseArgs } from "../relay2/lib/common";
import { loadContext } from "../relay2/lib/context";
import { TailCapture } from "../relay2/lib/run";
import { bodyFrames, currentRootEpoch } from "../relay2/wb/adapters";
import { sha256 } from "../relay2/wb/corpus";

const args = parseArgs();
const host = flagStr(args, "host")!.replace(/\/+$/, "");
const out = flagStr(args, "out")!;
const only = flagStr(args, "only")?.split(",");
const scale = Number(flagStr(args, "scale") ?? "1");
const tag = flagStr(args, "tag") ?? `m${Date.now().toString(36)}`;
const identity = loadContext(host).devices.A!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = (x: number) => Math.max(1, Math.round(x * scale));
function noteText(i: number, bytes: number): string {
	const line = `Line of note ${i} with some ordinary prose for sizing purposes ${tag}.\n`;
	return `# Note ${i}\n\n${line.repeat(Math.ceil(bytes / line.length))}`.slice(0, bytes).trimEnd() + "\n";
}
let rootEpoch = 0;
type Cell = { name: string; n: number; method: string; path: (i: number, body: Uint8Array | null) => string; body?: (i: number) => Uint8Array | null; ct?: string };
const bulk = (name: string, files: number, bytes: number, n: number): Cell => ({ name, n, method: "POST", path: () => "lifecycle/create-bulk", ct: YAOS_BINARY_CONTENT_TYPE,
	body: (i) => encodeBinaryEnvelope({ batchId: `${tag}-${name}-${i}`, rootEpoch, attachments: [],
		files: Array.from({ length: files }, (_v, k) => ({ operationId: `${tag}-${name}-${i}-op-${k}`, bodyId: `${tag}-${name}-${i}-${k}`,
			path: `${tag}/${name}/${i}/n${k}.md`, updates: bodyFrames(noteText(k, bytes)) })) }) });
const blob = (name: string, bytes: number, n: number): Cell => ({ name, n, method: "PUT", ct: "application/octet-stream",
	path: (_i, b) => `blobs/${sha256(b!)}`, body: () => new Uint8Array(randomBytes(bytes)) });
const MiB = 1024 * 1024;
const cells: Cell[] = [
	blob("blob-1m", 1 * MiB, N(12)),
	blob("blob-4m", 4 * MiB, N(12)),
	blob("blob-8m", 8 * MiB, N(12)),
	blob("blob-64k", 64 * 1024, N(12)),
	bulk("s-b5x2k", 5, 2048, N(60)),
	bulk("s-b500x2k", 500, 2048, N(30)),
	bulk("s-b500x8k", 500, 8000, N(20)),
	{ name: "s-cand-1m", n: N(30), method: "POST", path: (i) => `body/${tag}-c1m-${i}/candidate`, ct: "application/octet-stream", body: () => new Uint8Array(randomBytes(1_000_000)) },
];
const tail = args.flags.tail ? new TailCapture(host, `blobcpu-${tag}`) : null;
if (tail) await tail.start(host);
log(`tag ${tag} tail ${tail?.path ?? "none"}`);
rootEpoch = await currentRootEpoch(identity);
for (const cell of cells) {
	if (only && !only.includes(cell.name)) continue;
	for (let i = 0; i < cell.n; i++) {
		const body = cell.body?.(i) ?? null;
		const url = `${vaultRoute(identity, cell.path(i, body))}?b3c=${cell.name}&b3i=${i}&b3t=${tag}`;
		const t0 = performance.now();
		let status = 0, resBytes = 0, created: number | null = null, err: string | null = null;
		try {
			const r = await fetch(url, { method: cell.method, headers: deviceBearerHeaders(identity, cell.ct ? { "Content-Type": cell.ct } : {}), body });
			status = r.status;
			const resBuf = new Uint8Array(await r.arrayBuffer()); resBytes = resBuf.byteLength;
			if (r.headers.get("content-type")?.includes(YAOS_BINARY_CONTENT_TYPE)) {
				const d = decodeBinaryEnvelope(resBuf) as { outcomes?: Array<{ outcome: string }> };
				created = d.outcomes?.filter((o) => o.outcome === "created").length ?? null;
			}
		} catch (e) { err = String(e).slice(0, 200); }
		const rec = { t: new Date().toISOString(), tag, cell: cell.name, i, status, reqBytes: body?.byteLength ?? 0, resBytes, created, wallMs: Math.round(performance.now() - t0), err };
		appendFileSync(out, JSON.stringify(rec) + "\n");
		if (i % 10 === 0 || status >= 300) log(`${cell.name}#${i} ${status} req=${rec.reqBytes} ${rec.wallMs}ms${created !== null ? ` created=${created}` : ""}${err ? ` ${err}` : ""}`);
		await sleep(250);
	}
}
if (tail) await tail.stop(15_000);
log(`done tag ${tag} tail ${tail?.path ?? "none"}`);
process.exit(0);
