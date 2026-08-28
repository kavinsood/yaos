import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { bearer, createBody, pass, vaultJson, vaultUrl } from "../client.ts";
import { SCHEMA_VERSION, STORAGE_FORMAT_VERSION, targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const before = await createBody(target.deviceA, "before.md", "fixed-boundary-before");
const started = await vaultJson(target.deviceA, "bootstrap/start", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attemptId: `bootstrap_${crypto.randomUUID().replaceAll("-", "")}` }),
});
assert.equal(started.response.status, 200);
assert.ok(started.body);
assert.equal(started.body.format, "yaos-bootstrap-v1");
assert.equal(started.body.schemaVersion, SCHEMA_VERSION);
assert.equal(started.body.storageFormatVersion, STORAGE_FORMAT_VERSION);
assert.equal(typeof started.body.bootstrapId, "string");
const bootstrapId = started.body.bootstrapId as string;
const descriptorCatalog = started.body.catalog;
assert.ok(descriptorCatalog && typeof descriptorCatalog === "object" && !Array.isArray(descriptorCatalog)
	&& "highWater" in descriptorCatalog && typeof descriptorCatalog.highWater === "number");
const after = await createBody(target.deviceA, "after.md", "feed-catch-up-after");

const catalog = await vaultJson(target.deviceA, `bootstrap/${bootstrapId}/catalog?limit=100`);
assert.equal(catalog.response.status, 200);
const entries = catalog.body?.entries as Array<{ bodyId?: unknown; path?: unknown }>;
assert.ok(Array.isArray(entries));
assert.ok(entries.some((entry) => entry.bodyId === before.bodyId && entry.path === "before.md"));
assert.ok(!entries.some((entry) => entry.bodyId === after.bodyId));
pass("bootstrap catalog is pinned to its fixed SQL boundary");
const pinnedRoot = await fetch(vaultUrl(target.deviceA, `bootstrap/${bootstrapId}/root`), { headers: bearer(target.deviceA) });
const root = new Y.Doc();
Y.applyUpdate(root, new Uint8Array(await pinnedRoot.arrayBuffer()));
assert.equal(root.getMap<string>("pathToId").get("before.md"), before.bodyId);
assert.equal(root.getMap<string>("pathToId").has("after.md"), false);
root.destroy();
pass("bootstrap root is pinned to the same boundary as the catalog");

const bodies = await vaultJson(target.deviceA, `bootstrap/${bootstrapId}/bodies`, {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bodyIds: [before.bodyId] }),
});
assert.equal(bodies.response.status, 200);
assert.equal((bodies.body?.bodies as Array<{ bodyId?: unknown }>)[0]?.bodyId, before.bodyId);
const complete = await vaultJson(target.deviceA, `bootstrap/${bootstrapId}/complete`, { method: "POST" });
assert.equal(complete.response.status, 200);
assert.ok(typeof complete.body?.currentHighWater === "number" && complete.body.currentHighWater > descriptorCatalog.highWater);

const catchUp = await vaultJson(target.deviceA, "catch-up", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bodies: [{ bodyId: after.bodyId }] }),
});
assert.equal(catchUp.response.status, 200);
const caught = (catchUp.body?.bodies as Array<{ bodyId?: unknown; status?: unknown; update?: unknown }>)[0];
assert.equal(caught?.bodyId, after.bodyId);
assert.equal(caught?.status, 200);
assert.equal(typeof caught?.update, "string");
const caughtDoc = new Y.Doc();
Y.applyUpdate(caughtDoc, Buffer.from(caught.update as string, "base64url"));
assert.equal(caughtDoc.getText("body").toString(), "feed-catch-up-after");
caughtDoc.destroy();
pass("feed catch-up supplies writes after the bootstrap boundary");
