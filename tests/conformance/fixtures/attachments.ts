import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { bearer, createVaultAndEnroll, pass, sha256Hex, vaultJson, vaultUrl } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const bytes = new TextEncoder().encode("schema-4 attachment bytes");
const hash = await sha256Hex(bytes);
const upload = await fetch(vaultUrl(target.deviceA, `blobs/${hash}`), {
	method: "PUT", headers: bearer(target.deviceA, { "content-type": "text/plain" }), body: bytes,
});
assert.equal(upload.status, 204);
const exists = await vaultJson(target.deviceB, "blobs/exists", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: [hash] }),
});
assert.deepEqual(exists.body, { present: [hash] });
const downloaded = await fetch(vaultUrl(target.deviceB, `blobs/${hash}`), { headers: bearer(target.deviceB) });
assert.equal(await downloaded.text(), "schema-4 attachment bytes");
pass("attachment bytes are content-addressed and visible to vault peers");

const path = "assets/conformance.txt";
const upsert = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
		operationId: `attach_${crypto.randomUUID().replaceAll("-", "")}`, kind: "upsert", path, hash, size: bytes.byteLength, mime: "text/plain",
	}),
});
assert.equal(upsert.response.status, 200, JSON.stringify(upsert.body));
assert.equal(upsert.body?.vaultGeneration, target.deviceA.vaultGeneration);
const rootResponse = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
const root = new Y.Doc();
Y.applyUpdate(root, new Uint8Array(await rootResponse.arrayBuffer()));
assert.deepEqual(root.getMap("pathToBlob").get(path), { hash, size: bytes.byteLength });
root.destroy();
pass("attachment publication durably updates the root catalog");

const renamed = "assets/renamed.txt";
const rename = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
		operationId: `rename_${crypto.randomUUID().replaceAll("-", "")}`, kind: "rename", fromPath: path, toPath: renamed,
	}),
});
assert.equal(rename.response.status, 200);
const remove = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
		operationId: `delete_${crypto.randomUUID().replaceAll("-", "")}`, kind: "delete", path: renamed,
	}),
});
assert.equal(remove.response.status, 200);
const finalRootResponse = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
const finalRoot = new Y.Doc();
Y.applyUpdate(finalRoot, new Uint8Array(await finalRootResponse.arrayBuffer()));
assert.equal(finalRoot.getMap("pathToBlob").has(path), false);
assert.equal(finalRoot.getMap("pathToBlob").has(renamed), false);
assert.ok(finalRoot.getMap("blobTombstones").has(path));
assert.ok(finalRoot.getMap("blobTombstones").has(renamed));
finalRoot.destroy();
pass("attachment rename and deletion publish tombstoned root state");

const other = await createVaultAndEnroll(target, "attachment-generation-isolation");
const isolated = await fetch(vaultUrl(other, `blobs/${hash}`), { headers: bearer(other) });
assert.equal(isolated.status, 404);
pass("immutable attachment objects are isolated by vault generation context");
