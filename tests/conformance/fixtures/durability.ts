import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { bearer, bodyText, createBody, hardRestart, pass, postLifecycle, publishLifecycle, sha256Hex, vaultUrl } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const created = await createBody(target.deviceA, "durable.md", "before-crash");
const current = await fetch(vaultUrl(target.deviceA, `body/${created.bodyId}`), { headers: bearer(target.deviceA) });
const doc = new Y.Doc({ guid: created.bodyId });
Y.applyUpdate(doc, new Uint8Array(await current.arrayBuffer()));
const vector = Y.encodeStateVector(doc);
doc.getText("body").insert(doc.getText("body").length, "-acknowledged");
const update = Y.encodeStateAsUpdate(doc, vector);
doc.destroy();
const candidateId = `edit_${crypto.randomUUID().replaceAll("-", "")}`;
const candidate = await fetch(vaultUrl(target.deviceA, `body/${created.bodyId}/candidate`), {
	method: "POST",
	headers: bearer(target.deviceA, { "content-type": "application/octet-stream", "x-yaos-candidate-id": candidateId, "x-yaos-candidate-digest": await sha256Hex(update) }),
	body: update,
});
assert.equal(candidate.status, 200, await candidate.clone().text());
const receipt = await candidate.json() as Record<string, unknown>;
assert.equal(receipt.candidateId, candidateId);
assert.ok(Number.isSafeInteger(receipt.durableGeneration));
pass("body candidate returns a durable acknowledgement");
await hardRestart(target);
assert.equal(await bodyText(target.deviceA, created.bodyId), "before-crash-acknowledged");
pass("acknowledged body candidate survives SIGKILL");

const deletion = { operationId: `delete_${crypto.randomUUID().replaceAll("-", "")}`, kind: "delete" as const, fileId: created.bodyId, bodyId: created.bodyId, path: "durable.md" };
const committed = await postLifecycle(target.deviceA, deletion);
assert.equal(committed.result.response.status, 200);
assert.ok(committed.receipt);
pass("lifecycle mutation returns a durable acknowledgement");
const unpublishedRootResponse = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
assert.equal(unpublishedRootResponse.status, 200);
const unpublishedRoot = new Y.Doc();
Y.applyUpdate(unpublishedRoot, new Uint8Array(await unpublishedRootResponse.arrayBuffer()));
assert.equal(unpublishedRoot.getMap<string>("pathToId").get("durable.md"), created.bodyId);
unpublishedRoot.destroy();
pass("durable lifecycle receipt does not bypass required root publication");
await hardRestart(target);
const replay = await postLifecycle(target.deviceA, deletion);
assert.equal(replay.result.response.status, 200);
assert.deepEqual(replay.receipt, committed.receipt);
const publication = await publishLifecycle(target.deviceA, deletion, replay.receipt!);
assert.equal(publication.response.status, 200);
const head = await fetch(vaultUrl(target.deviceA, `head/${created.bodyId}`), { headers: bearer(target.deviceA) });
assert.equal(head.status, 200);
assert.equal(await head.json(), null);
const deletedBody = await fetch(vaultUrl(target.deviceA, `body/${created.bodyId}`), { headers: bearer(target.deviceA) });
assert.equal(deletedBody.status, 404);
const publishedRootResponse = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
const publishedRoot = new Y.Doc();
Y.applyUpdate(publishedRoot, new Uint8Array(await publishedRootResponse.arrayBuffer()));
assert.equal(publishedRoot.getMap("pathToId").has("durable.md"), false);
publishedRoot.destroy();
pass("acknowledged lifecycle receipt survives SIGKILL and remains publishable");
