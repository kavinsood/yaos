/**
 * Relay v2 server-core smoke against a deployed relay worker (flag on).
 *   node tests/run-typescript.mjs --test-aliases scripts/relay2-core-smoke.ts <host>
 * claim + enroll (A, B) -> seed one note -> relay body sockets -> envelope + update
 * -> BODY_COMMITTED (relay, contentHashAccepted) -> peer fan-out -> HTTP GET body.
 * Secrets stay in logs/relay2/context-<worker>.json; nothing secret is printed.
 */
import { vaultRoute } from "../tests/live/schema4Live";
import { deviceBearerHeaders } from "../tests/live/liveIdentity";
import { bodyGet, diagnostics } from "./relay2/lib/checks";
import { claim, hasContext, loadContext, seedNotes } from "./relay2/lib/context";
import { contentHashOf, RawClient, relayAdapter } from "./relay2/lib/rawClient";

const host = process.argv[2] ?? "https://yaos-relay2-coresmoke-1.kavinsood.workers.dev";
const context = hasContext(host) ? loadContext(host) : await claim(host, ["A", "B"]);
const bodyId = `core-smoke-${Date.now().toString(36)}`;
await seedNotes(context, [{ bodyId, path: `R2/${bodyId}.md`, content: "hello relay" }]);
const adapter = relayAdapter();
const a = new RawClient(context.devices.A!, bodyId, undefined, adapter);
const b = new RawClient(context.devices.B!, bodyId, undefined, adapter);
const result: Record<string, unknown> = { host, bodyId };
for (const [name, client] of [["A", a], ["B", b]] as const) {
	const opened = await client.open(30_000);
	if (opened.status !== "ok") throw new Error(`${name} open failed: ${JSON.stringify(opened)}`);
	const ready = client.controls.find((c) => c.value.type === "VAULT_READY")?.value;
	result[`ready${name}`] = { capabilities: ready?.capabilities, text: client.text() };
}
const peerUpdate = b.waitUpdate(15_000);
const { frameId, sentAt } = a.editTracked((text) => text.insert(text.length, " + world"));
const ack = await a.waitAck(frameId, sentAt, 15_000);
result.ack = ack ? { ms: Math.round(ack.at - sentAt), relay: ack.value.relay, clientFrameId: ack.value.clientFrameId === frameId,
	contentHashAccepted: ack.value.contentHashAccepted, contentHashMatches: ack.value.contentHash === contentHashOf(a.text()).contentHash,
	vaultSequence: ack.value.vaultSequence, durableGeneration: ack.value.durableGeneration } : null;
const peerAt = await peerUpdate;
result.peer = { received: peerAt !== null, ms: peerAt === null ? null : Math.round(peerAt - sentAt), text: b.text() };
const get = await bodyGet(context.devices.A!, bodyId);
result.httpGet = { status: get.status, text: get.text, contentHashMatches: get.contentHash === contentHashOf(a.text()).contentHash };
// Round 4: deployed CF rowsWritten per append over SMOKE_APPENDS sequential acked edits (default 20).
type Counters = Record<string, number>;
const countersNow = async () => ((await diagnostics(context.devices.A!, true)).relay as { counters: Counters }).counters;
const appendsWanted = Number(process.env.SMOKE_APPENDS ?? 20);
const measure = async (client: RawClient) => {
	const before = await countersNow();
	for (let index = 0; index < appendsWanted; index++) {
		const edit = client.editTracked((text) => text.insert(text.length, String(index % 10)));
		await client.waitAck(edit.frameId, edit.sentAt, 15_000);
	}
	const after = await countersNow();
	const appended = after.appends - before.appends;
	return { appends: appended, rowsWritten: after.rowsWritten - before.rowsWritten,
		cfRowsPerAppend: appended > 0 ? +((after.rowsWritten - before.rowsWritten) / appended).toFixed(2) : null };
};
const nocand = new RawClient(context.devices.A!, bodyId, undefined, relayAdapter({ includeCandidate: false }));
if ((await nocand.open(30_000)).status !== "ok") throw new Error("nocand open failed");
result.rowsPerAppend = {
	leanRows: (((await diagnostics(context.devices.A!, true)).relay as { config?: { leanRows?: boolean } }).config?.leanRows) ?? false,
	candidateFrames: await measure(a),
	plainFrames: await measure(nocand),
};
await new Promise((resolve) => setTimeout(resolve, 1000));
result.nocandConverged = nocand.text() === a.text();
await nocand.close();
const diag = await diagnostics(context.devices.A!, true);
const relay = diag.relay as { counters?: Record<string, unknown> } | undefined;
result.relayCounters = relay?.counters;
const tables = await fetch(vaultRoute(context.devices.A!, "debug/relay-table-counts"), {
	headers: { Cookie: context.operatorCookie } }).catch(() => null);
result.tableCounts = tables ? { status: tables.status, body: tables.ok ? await tables.json() : await tables.text() } : null;
const deviceTables = await fetch(vaultRoute(context.devices.A!, "debug/relay-table-counts"), {
	headers: deviceBearerHeaders(context.devices.A!) });
result.tableCountsWithDeviceBearer = deviceTables.status;
await new Promise((resolve) => setTimeout(resolve, 1500));
result.peerConverged = b.text() === a.text();
await a.close();
await b.close();
const ok = !!ack && ack.value.relay === true && ack.value.contentHashAccepted === true && peerAt !== null
	&& get.status === 200 && get.text === "hello relay + world" && b.text() === a.text();
result.ok = ok;
console.log(JSON.stringify(result, null, 2));
process.exit(ok ? 0 : 1);
