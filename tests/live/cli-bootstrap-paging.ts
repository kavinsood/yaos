import * as Y from "yjs";
import { BootstrapHttpPort } from "../../src/sync/bootstrapClient.ts";
import { createFetchRequester } from "../../src/utils/http.ts";
import { encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../server/src/shared/binaryEnvelope.ts";
import { deviceBearerHeaders, requireLiveIdentity } from "./liveIdentity.ts";
import { requestJson, vaultRoute } from "./schema4Live.ts";

/**
 * P6: the CLI bootstrap reads catalog pages of up to 1000 entries but the
 * server caps body batches at MAX_CATCH_UP_BODIES (100). A vault with more
 * than 100 notes must still bootstrap through the real HTTP port.
 */
const identity = requireLiveIdentity();
const NOTES = 260;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

console.log("\n--- CLI bootstrap paging above the server body cap ---");
const prefix = `paging-${crypto.randomUUID().slice(0, 8)}`;
const created = new Map<string, string>();
for (let start = 0; start < NOTES; start += 100) {
	const root = await fetch(vaultRoute(identity, "root"), { headers: deviceBearerHeaders(identity) });
	const rootEpoch = Number(root.headers.get("x-yaos-root-epoch"));
	await root.arrayBuffer();
	const files = [];
	for (let index = start; index < Math.min(NOTES, start + 100); index++) {
		const bodyId = `${prefix}-${index}`;
		const doc = new Y.Doc({ guid: bodyId });
		doc.getText("body").insert(0, `note ${index}\n`);
		files.push({ operationId: `op-${bodyId}`, bodyId, path: `${prefix}/n${index}.md`, updates: [Y.encodeStateAsUpdate(doc)] });
		doc.destroy();
		created.set(bodyId, `note ${index}\n`);
	}
	const { response, body } = await requestJson(identity, "lifecycle/create-bulk", {
		method: "POST",
		headers: { "Content-Type": YAOS_BINARY_CONTENT_TYPE },
		body: encodeBinaryEnvelope({ batchId: `batch-${prefix}-${start}`, rootEpoch, files, attachments: [] }),
	});
	const outcomes = Array.isArray(body?.outcomes) ? body.outcomes as Array<{ outcome?: string }> : [];
	if (response.status !== 200 || outcomes.length !== files.length || outcomes.some((item) => item.outcome !== "created")) {
		throw new Error(`seed bulk create failed (${response.status})`);
	}
}
assert(created.size === NOTES, `seeded ${NOTES} notes`);

const port = new BootstrapHttpPort(identity.host, identity.vaultId, identity.deviceToken, {} as never,
	createFetchRequester((input, init) => fetch(input, init)));
const descriptor = await port.start(`live-paging-${crypto.randomUUID()}`);
const ids: string[] = [];
let cursor: string | null = null;
do {
	const page = await port.catalog(descriptor.bootstrapId, cursor, 1000);
	for (const entry of page.entries) if (created.has(entry.bodyId)) ids.push(entry.bodyId);
	cursor = page.nextCursor;
} while (cursor !== null);
assert(ids.length === NOTES, `catalog lists all ${NOTES} seeded notes`);

const states = await port.bodies(descriptor.bootstrapId, ids);
let exact = 0;
for (const [bodyId, state] of states) {
	const doc = new Y.Doc({ guid: bodyId });
	Y.applyUpdate(doc, state.encodedState);
	if (doc.getText("body").toString() === created.get(bodyId)) exact++;
	doc.destroy();
}
assert(states.size === NOTES && exact === NOTES, `bootstrap body fetch returns all ${NOTES} bodies exactly (no 400)`);

const caught = await port.catchUpBodies(ids.map((bodyId) => ({ bodyId, bodyEpoch: 1, generation: 0 })));
assert(caught.size === NOTES, `catch-up of ${NOTES} bodies succeeds (no 400)`);

await port.renew(descriptor.bootstrapId, NOTES);
await port.complete(descriptor.bootstrapId);
console.log("CLI bootstrap pages body fetches within the server cap.");
