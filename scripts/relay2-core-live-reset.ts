/**
 * Relay v2 server-core: live repeated-reset loop (round 2, item 4) + HEAD + cooldown.
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2-core-live-reset.ts [host] [--mb 5] [--n 5]
 * Creates one body of ~mb MB, then n times: HEAD -> lease -> binary semantic-reset of a
 * lineage-fresh snapshot -> immediate re-lease (expects 429 cooldown) -> GET. Needs a worker
 * with YAOS_RELAY_RESET_COOLDOWN_MS small (the core smoke worker uses 1000).
 * Secrets stay in logs/relay2/context-<worker>.json; nothing secret is printed.
 */
import * as Y from "yjs";
import { vaultRoute } from "../tests/live/schema4Live";
import { deviceBearerHeaders } from "../tests/live/liveIdentity";
import { claim, createBodyFromUpdate, hasContext, loadContext, wordsContent } from "./relay2/lib/context";
import { contentHashOf, RawClient, relayAdapter } from "./relay2/lib/rawClient";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? Number(args[index + 1]) : fallback;
};
const host = args.find((value) => value.startsWith("https://")) ?? "https://yaos-relay2-coresmoke-1.kavinsood.workers.dev";
const mb = flag("mb", 5);
const iterations = flag("n", 5);
const context = hasContext(host) ? loadContext(host) : await claim(host, ["A", "B"]);
const identity = context.devices.A!;
const bodyId = `core-reset-${Date.now().toString(36)}`;
// Candidates cap at 1.75 MB: create 1 MB, then grow with 1 MB relay appends (rate limit ~4 s each).
const chunk = 1024 * 1024;
const seed = new Y.Doc();
seed.getText("body").insert(0, wordsContent(7, chunk));
const seedUpdate = Y.encodeStateAsUpdate(seed);
seed.destroy();
let at = performance.now();
await createBodyFromUpdate(identity, bodyId, `R2/${bodyId}.md`, seedUpdate);
const grower = new RawClient(identity, bodyId, undefined, relayAdapter());
const opened = await grower.open(30_000);
if (opened.status !== "ok") throw new Error(`open failed: ${JSON.stringify(opened)}`);
for (let part = 1; part < Math.round(mb); part++) {
	const addition = wordsContent(7 + part, chunk);
	const { frameId, sentAt } = grower.editTracked((body) => body.insert(body.length, addition));
	const ack = await grower.waitAck(frameId, sentAt, 60_000);
	if (!ack) throw new Error(`grow append ${part} not acknowledged`);
	await new Promise((resolve) => setTimeout(resolve, 4_500));
}
const text = grower.text();
await grower.close();
const createMs = Math.round(performance.now() - at);

async function head(): Promise<Record<string, string | null> & { status: number; ms: number }> {
	const started = performance.now();
	const response = await fetch(vaultRoute(identity, `body/${bodyId}`), { method: "HEAD", headers: deviceBearerHeaders(identity) });
	const pick = (name: string) => response.headers.get(name);
	return { status: response.status, ms: Math.round(performance.now() - started), epoch: pick("x-yaos-body-epoch"),
		generation: pick("x-yaos-generation"), headSequence: pick("x-yaos-head-sequence"),
		hashState: pick("x-yaos-content-hash-state"), size: pick("x-yaos-size") };
}

async function lease(expectedEpoch: number) {
	const started = performance.now();
	const response = await fetch(vaultRoute(identity, `body/${bodyId}/compaction-lease`), { method: "POST",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify({ expectedEpoch, ttlMs: 120_000 }) });
	const body = await response.json() as Record<string, unknown>;
	return { status: response.status, ms: Math.round(performance.now() - started), retryAfter: response.headers.get("retry-after"), body };
}

const rows: Record<string, unknown>[] = [];
const contentHash = contentHashOf(text);
for (let index = 0; index < iterations; index++) {
	const before = await head();
	const granted = await lease(Number(before.epoch));
	if (granted.status !== 200) { rows.push({ index, before, lease: { status: granted.status, reason: granted.body.reason } }); break; }
	at = performance.now();
	const fresh = new Y.Doc({ gc: true });
	fresh.getText("body").insert(0, text);
	const snapshot = Y.encodeStateAsUpdate(fresh);
	fresh.destroy();
	const buildMs = Math.round(performance.now() - at);
	at = performance.now();
	const reset = await fetch(vaultRoute(identity, `body/${bodyId}/semantic-reset`), { method: "POST",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/octet-stream",
			"x-yaos-lease-id": String(granted.body.leaseId), "x-yaos-expected-epoch": String(granted.body.epoch),
			"x-yaos-covered-sequence": String(granted.body.headSequence), "x-yaos-content-hash": contentHash.contentHash,
			"x-yaos-content-bytes": String(contentHash.size) }), body: snapshot });
	const resetBody = await reset.json() as Record<string, unknown>;
	const resetMs = Math.round(performance.now() - at);
	const cooldown = await lease(Number(resetBody.epoch ?? before.epoch));
	const after = await head();
	at = performance.now();
	const get = await fetch(vaultRoute(identity, `body/${bodyId}`), { headers: deviceBearerHeaders(identity) });
	const getBytes = (await get.arrayBuffer()).byteLength;
	const getMs = Math.round(performance.now() - at);
	rows.push({ index, epochBefore: before.epoch, headMs: before.ms, leaseMs: granted.ms, snapshotBytes: snapshot.byteLength, buildMs,
		reset: { status: reset.status, ms: resetMs, ok: resetBody.ok, reason: resetBody.reason, epoch: resetBody.epoch,
			fencedSockets: resetBody.fencedSockets, policy: resetBody.policy },
		cooldownLease: { status: cooldown.status, reason: cooldown.body.reason, retryAfter: cooldown.retryAfter },
		after: { epoch: after.epoch, headSequence: after.headSequence, hashState: after.hashState, size: after.size },
		get: { status: get.status, ms: getMs, bytes: getBytes, hashState: get.headers.get("x-yaos-content-hash-state") } });
	console.error(`[live-reset] ${index}: reset ${reset.status} ${resetMs} ms, cooldown lease ${cooldown.status}, GET ${get.status} ${getMs} ms`);
	await new Promise((resolve) => setTimeout(resolve, 1_200));
}
const ok = rows.length === iterations && rows.every((row) => (row.reset as { status: number } | undefined)?.status === 200
	&& [200, 429].includes((row.cooldownLease as { status: number }).status));
// The immediate re-lease races the (small) cooldown against reset latency, so 200 or 429 are both valid.
console.log(JSON.stringify({ host, bodyId, mb, seedUpdateBytes: seedUpdate.byteLength, createMs, rows, ok }, null, 2));
process.exit(ok ? 0 : 1);
