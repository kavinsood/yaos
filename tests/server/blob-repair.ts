import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleBlobRoute } from "../../server/src/routes/blobs";
import { handleWorkerRequest } from "../../server/src/index";
import { invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import { blobKey } from "../../server/src/vaultObjectStore";
import { FakeObjectStore } from "../mocks/workerEnv";
import { routeEnv, json, VAULT_ID, GENERATION } from "../r4/routeEnv";
import { suite } from "../harness";

const repair = suite("blob-repair");
const bytes = new TextEncoder().encode("correct attachment bytes");
const hash = createHash("sha256").update(bytes).digest("hex");
const key = blobKey(VAULT_ID, GENERATION, hash);

function request(token: string | null = "r4-token"): Request {
	return new Request(`https://example.test/vault/${VAULT_ID}/blobs/${hash}/repair`, {
		method: "POST", headers: token === null ? {} : { Authorization: `Bearer ${token}` },
	});
}

repair.test("missing blob returns missing before contacting repair authority", async () => {
	const store = new FakeObjectStore();
	const env = await routeEnv(store);
	env.YAOS_SYNC = { async call() { throw new Error("missing blob must not reach authority"); } };
	const response = await handleBlobRoute(env, VAULT_ID, request(), [hash, "repair"], json);
	assert.deepEqual(await response.json(), { status: "missing" });
	assert.deepEqual(store.gets, []);
	assert.deepEqual(store.deletes, []);
});

repair.test("existing blob reports through authority without reading or deleting bytes", async () => {
	const store = new FakeObjectStore({ objects: new Map([[key, bytes]]) });
	const env = await routeEnv(store);
	const calls: Request[] = [];
	env.YAOS_SYNC = { async call(actorName, incoming) {
		assert.equal(actorName, VAULT_ID);
		calls.push(incoming);
		return json({ status: "suspect" });
	} };
	const response = await handleBlobRoute(env, VAULT_ID, request(), [hash, "repair"], json);
	assert.deepEqual(await response.json(), { status: "suspect" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, `https://internal/blobs/${hash}/repair`);
	assert.equal(calls[0]!.method, "POST");
	assert.equal(calls[0]!.headers.get("x-yaos-vault-generation"), GENERATION);
	assert.deepEqual(store.gets, []);
	assert.deepEqual(store.deletes, []);
	assert.deepEqual(store.objects.get(key), bytes);
});

repair.test("public router forwards the authenticated repair POST", async () => {
	invalidateStoredServerConfigCache();
	const store = new FakeObjectStore({ objects: new Map([[key, bytes]]) });
	const env = await routeEnv(store);
	const config = env.YAOS_CONFIG;
	env.YAOS_CONFIG = { call: async (actorName, incoming) => {
		const path = new URL(incoming.url).pathname;
		if (path === "/__yaos/config") return json({ claimed: true, configFormat: 3,
			operatorRecoveryHash: "operator-test-hash", ticketSigningKey: "ticket-test-key" });
		if (path === "/__yaos/authorize-device") return config.call(actorName,
			new Request("https://internal/__yaos/collaboration/authorize", { method: "POST" }));
		return config.call(actorName, incoming);
	} };
	let forwarded = 0;
	env.YAOS_SYNC = { call: async (_actorName, incoming) => {
		assert.equal(new URL(incoming.url).pathname, `/blobs/${hash}/repair`);
		forwarded++;
		return json({ status: "suspect" });
	} };
	const response = await handleWorkerRequest(request(), env);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "suspect" });
	assert.equal(forwarded, 1);
});

repair.test("invalid and unauthenticated reports do not access the object store", async () => {
	const store = new FakeObjectStore();
	const env = await routeEnv(store);
	assert.equal((await handleBlobRoute(env, VAULT_ID, request(null), [hash, "repair"], json)).status, 401);
	assert.equal((await handleBlobRoute(env, VAULT_ID, request(), ["invalid", "repair"], json)).status, 400);
	assert.deepEqual(store.gets, []);
	assert.deepEqual(store.deletes, []);
});

await repair.done();
