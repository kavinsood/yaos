/**
 * Write-budget spike (int-bulk): exact Cloudflare rows per bulk-create batch against a live worker (local
 * `wrangler dev` or deployed), read from the W1 exact counter (`GET debug/sql-rows`, billedRowsWritten).
 *
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2/wb/bulk-rows.ts --host <url> [--out <json>] [--tag t]
 *
 * Needs a context (scripts/relay2/context.ts --host <url> --seed none) and YAOS_TEST_ONLY_DEBUG_ROUTES=true.
 * Blobs are PUT before the counter is read, so attachment rows are the create-bulk rows only.
 * Cases: one warm batch (lazy tables), then 1 / 100 / 500 notes (~2 KiB) and 1 / 50 attachment-only batches.
 * Derived: per note = (r500 − r100) / 400, per batch = r100 − 100 × per note, per attachment = (a50 − a1) / 49.
 */
import { writeFileSync } from "node:fs";
import { vaultRoute } from "../../../tests/live/schema4Live";
import { deviceBearerHeaders, type LiveIdentity } from "../../../tests/live/liveIdentity";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../../server/src/shared/binaryEnvelope";
import { flagStr, log, parseArgs } from "../lib/common";
import { loadContext } from "../lib/context";
import { bodyFrames, currentRootEpoch, RowsCounter, rowsDelta } from "./adapters";
import { sha256 } from "./corpus";

function noteText(i: number, bytes = 2048): string {
	const line = `Line of note ${i} with some ordinary prose for sizing purposes.\n`;
	return `# Note ${i}\n\n${line.repeat(Math.ceil(bytes / line.length))}`.slice(0, bytes).trimEnd() + "\n";
}

async function putBlob(identity: LiveIdentity, bytes: Uint8Array): Promise<string> {
	const hash = sha256(bytes);
	const r = await fetch(vaultRoute(identity, `blobs/${hash}`), { method: "PUT",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/octet-stream" }), body: bytes });
	await r.arrayBuffer().catch(() => null);
	if (!r.ok) throw new Error(`blob PUT ${r.status}`);
	return hash;
}

async function main() {
	const args = parseArgs();
	const host = flagStr(args, "host")!.replace(/\/+$/, "");
	const tag = flagStr(args, "tag") ?? `br${Date.now().toString(36)}`;
	const context = loadContext(host);
	const identity = context.devices.A!;
	const rows = new RowsCounter(context);
	const send = async (label: string, files: unknown[], attachments: unknown[]) => {
		const rootEpoch = await currentRootEpoch(identity);
		const before = await rows.read();
		const started = performance.now();
		const r = await fetch(vaultRoute(identity, "lifecycle/create-bulk"), { method: "POST",
			headers: deviceBearerHeaders(identity, { "Content-Type": YAOS_BINARY_CONTENT_TYPE }),
			body: encodeBinaryEnvelope({ batchId: `${tag}-${label}`, rootEpoch, files, attachments }) });
		const ms = performance.now() - started;
		const body = r.headers.get("content-type")?.includes(YAOS_BINARY_CONTENT_TYPE)
			? decodeBinaryEnvelope(new Uint8Array(await r.arrayBuffer())) as { outcomes: Array<{ outcome: string }> }
			: await r.json() as Record<string, unknown>;
		const after = await rows.read();
		const delta = rowsDelta(before, after);
		const created = Array.isArray((body as { outcomes?: unknown }).outcomes)
			? (body as { outcomes: Array<{ outcome: string }> }).outcomes.filter((o) => o.outcome === "created").length : 0;
		if (!r.ok || created !== files.length + attachments.length) throw new Error(`${label}: ${r.status} created=${created} ${JSON.stringify(body).slice(0, 300)}`);
		log(`${label}: ${delta.rowsWritten} rows (${ms.toFixed(1)} ms wall)`);
		return { label, rowsWritten: delta.rowsWritten, rowsRead: delta.rowsRead, exact: delta.exact, wallMs: Math.round(ms * 10) / 10,
			extra: after.extra };
	};
	const files = (prefix: string, n: number) => Array.from({ length: n }, (_v, i) => ({ operationId: `${tag}-${prefix}-op-${i}`,
		bodyId: `${tag}-${prefix}-${i}`, path: `${tag}/${prefix}/n${i}.md`, updates: bodyFrames(noteText(i)) }));
	const attachments = async (prefix: string, n: number) => {
		const out = [];
		for (let i = 0; i < n; i++) {
			const bytes = new TextEncoder().encode(`${tag}-${prefix}-attachment-${i}-`.repeat(8));
			out.push({ operationId: `${tag}-${prefix}-att-${i}`, path: `${tag}/${prefix}/a${i}.png`, hash: await putBlob(identity, bytes),
				size: bytes.byteLength, mime: "image/png" });
		}
		return out;
	};
	const results = [];
	results.push(await send("warm", files("warm", 1), []));
	results.push(await send("b1", files("b1", 1), []));
	results.push(await send("b100", files("b100", 100), []));
	results.push(await send("b500", files("b500", 500), []));
	results.push(await send("a1", [], await attachments("a1", 1)));
	results.push(await send("a50", [], await attachments("a50", 50)));
	const by = Object.fromEntries(results.map((r) => [r.label, r.rowsWritten ?? NaN]));
	const perNote = (by.b500! - by.b100!) / 400;
	const perAttachment = (by.a50! - by.a1!) / 49;
	const summary = { perNote, perBatch: by.b100! - 100 * perNote, perAttachment, attachmentBatch: by.a1! - perAttachment,
		batch1: by.b1, batch100: by.b100, batch500: by.b500, perNoteAt: { 1: by.b1, 100: by.b100! / 100, 500: by.b500! / 500 } };
	log(`summary ${JSON.stringify(summary)}`);
	const out = flagStr(args, "out");
	if (out) writeFileSync(out, JSON.stringify({ host, tag, results, summary }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
