import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CloudflareObjectStore } from "../../server/src/cloudflarePorts";
import { handleBlobRoute } from "../../server/src/routes/blobs";
import { blobKey } from "../../server/src/vaultObjectStore";
import { FakeObjectStore } from "../mocks/workerEnv";
import { routeEnv, json, VAULT_ID, GENERATION } from "../r4/routeEnv";
import { suite } from "../harness";

const download = suite("blob-download-streaming");
const bytes = new TextEncoder().encode("lazy attachment download\u0000\u00ff".repeat(100));
const hash = createHash("sha256").update(bytes).digest("hex");
const key = blobKey(VAULT_ID, GENERATION, hash);
const uploaded = new Date("2026-01-02T03:04:05Z");

function request(token: string | null = "r4-token"): Request {
	return new Request(`https://example.test/vault/${VAULT_ID}/blobs/${hash}`, {
		headers: token === null ? {} : { Authorization: `Bearer ${token}` },
	});
}

function streamingStore(missing = false, contentType: string | null = "image/png") {
	let pulls = 0;
	let offset = 0;
	let arrayBufferCalls = 0;
	let bufferedCalls = 0;
	const keys: string[] = [];
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls++;
			if (offset === bytes.length) return controller.close();
			const end = Math.min(offset + 17, bytes.length);
			controller.enqueue(bytes.subarray(offset, end));
			offset = end;
		},
	}, { highWaterMark: 0 });
	const customMetadata = { source: "attachment" };
	const nativeR2 = {
		async head(objectKey: string) { keys.push(objectKey); return null; },
		async get(objectKey: string) {
			keys.push(objectKey);
			return missing ? null : {
				key: objectKey, size: bytes.length, uploaded, body, customMetadata,
				httpMetadata: contentType ? { contentType } : {},
				async arrayBuffer(): Promise<ArrayBuffer> {
					arrayBufferCalls++;
					throw new Error("download must not buffer R2 bytes");
				},
			};
		},
	};
	const store = new CloudflareObjectStore(nativeR2 as unknown as R2Bucket);
	store.get = async () => {
		bufferedCalls++;
		throw new Error("download must prefer getStream");
	};
	return { store, body, keys, customMetadata, pulls: () => pulls,
		arrayBufferCalls: () => arrayBufferCalls, bufferedCalls: () => bufferedCalls };
}

download.test("Cloudflare stream port returns native body and metadata without consuming bytes", async () => {
	const storage = streamingStore();
	const object = await storage.store.getStream(key);
	assert.ok(object);
	assert.equal(object.body, storage.body);
	assert.equal(object.key, key);
	assert.equal(object.size, bytes.length);
	assert.equal(object.uploadedAt, uploaded.getTime());
	assert.equal(object.contentType, "image/png");
	assert.deepEqual(object.customMetadata, storage.customMetadata);
	assert.equal(storage.pulls(), 0);
	assert.equal(storage.arrayBufferCalls(), 0);
	await object.body.cancel();
});

download.test("GET stays lazy, streams exact bytes/hash, and preserves download headers", async () => {
	const storage = streamingStore();
	const response = await handleBlobRoute(await routeEnv(storage.store), VAULT_ID, request(), [hash], json);
	assert.equal(response.status, 200);
	assert.deepEqual(storage.keys, [key]);
	assert.equal(storage.pulls(), 0);
	assert.equal(response.headers.get("Content-Length"), String(bytes.length));
	assert.equal(response.headers.get("ETag"), `"${hash}"`);
	assert.equal(response.headers.get("Last-Modified"), uploaded.toUTCString());
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(response.headers.get("Content-Type"), "image/png");
	const received = new Uint8Array(await response.arrayBuffer());
	assert.deepEqual(received, bytes);
	assert.equal(createHash("sha256").update(received).digest("hex"), hash);
	assert.ok(storage.pulls() > 1);
	assert.equal(storage.arrayBufferCalls(), 0);
	assert.equal(storage.bufferedCalls(), 0);
});

download.test("stream metadata supplies Content-Length and default Content-Type", async () => {
	const storage = streamingStore(false, null);
	storage.store.getStream = async () => ({ key, size: 123, uploadedAt: uploaded.getTime(),
		contentType: null, customMetadata: {}, body: storage.body });
	const response = await handleBlobRoute(await routeEnv(storage.store), VAULT_ID, request(), [hash], json);
	assert.equal(response.headers.get("Content-Length"), "123");
	assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
	assert.equal(storage.pulls(), 0);
	await response.body!.cancel();
});

download.test("stores without getStream retain the buffered GET fallback", async () => {
	const store = new FakeObjectStore({ objects: new Map([[key, bytes]]) });
	const metadata = await store.head(key);
	const response = await handleBlobRoute(await routeEnv(store), VAULT_ID, request(), [hash], json);
	assert.equal(response.status, 200);
	assert.deepEqual(store.gets, [key]);
	assert.equal(response.headers.get("Content-Length"), String(metadata!.size));
	assert.equal(response.headers.get("ETag"), `"${hash}"`);
	assert.equal(response.headers.get("Last-Modified"), new Date(metadata!.uploadedAt).toUTCString());
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

download.test("missing streaming and buffered objects return 404 without cross-port retries", async () => {
	const storage = streamingStore(true);
	for (const store of [storage.store, new FakeObjectStore()]) {
		const response = await handleBlobRoute(await routeEnv(store), VAULT_ID, request(), [hash], json);
		assert.equal(response.status, 404);
		assert.deepEqual(await response.json(), { error: "not found" });
	}
	assert.deepEqual(storage.keys, [key]);
	assert.equal(storage.bufferedCalls(), 0);
	assert.equal(storage.arrayBufferCalls(), 0);
});

download.test("invalid hashes and paths do not access either download port", async () => {
	const storage = streamingStore();
	const env = await routeEnv(storage.store);
	for (const invalid of ["short", "A".repeat(64), "g".repeat(64)]) {
		const response = await handleBlobRoute(env, VAULT_ID, request(), [invalid], json);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "invalid hash: must be 64 hex chars (SHA-256)" });
	}
	for (const rest of [[], [hash, "extra"]]) {
		assert.equal((await handleBlobRoute(env, VAULT_ID, request(), rest, json)).status, 404);
	}
	assert.deepEqual(storage.keys, []);
	assert.equal(storage.bufferedCalls(), 0);
});

download.test("authentication, policy, generation, and vault errors still gate downloads", async () => {
	const cases = [
		{ mode: "no-token", status: 401, error: "unauthorized" },
		{ mode: "rejected-token", status: 401, error: "unauthorized" },
		{ mode: "policy", status: 403, error: "policy_version_stale" },
		{ mode: "generation", status: 409, error: "authority_superseded" },
		{ mode: "inactive", status: 409, error: "vault_destroyed" },
		{ mode: "unknown", status: 404, error: "unknown_vault" },
		{ mode: "unavailable", status: 503, error: "vault_authority_unavailable" },
	];
	for (const scenario of cases) {
		const storage = streamingStore();
		const env = await routeEnv(storage.store);
		const authority = env.YAOS_CONFIG;
		env.YAOS_CONFIG = { async call(actorName, incoming) {
			const path = new URL(incoming.url).pathname;
			if (path === "/__yaos/collaboration/authorize" && scenario.mode === "rejected-token") return json({}, 401);
			if (path === "/__yaos/vault") {
				if (scenario.mode === "unavailable") throw new Error("authority offline");
				if (scenario.mode === "unknown") return json({ error: "unknown_vault" }, 404);
			}
			const response = await authority.call(actorName, incoming);
			const payload = await response.json() as {
				actor?: { vaultGeneration: string; policyVersion: number };
				vault?: { state: string };
			};
			if (payload.actor && scenario.mode === "generation") payload.actor.vaultGeneration = "superseded";
			if (payload.actor && scenario.mode === "policy") payload.actor.policyVersion = -1;
			if (payload.vault && scenario.mode === "inactive") payload.vault.state = "destroyed";
			return json(payload);
		} };
		const response = await handleBlobRoute(env, VAULT_ID, request(scenario.mode === "no-token" ? null : "r4-token"), [hash], json);
		assert.equal(response.status, scenario.status, scenario.mode);
		assert.deepEqual(await response.json(), { error: scenario.error }, scenario.mode);
		assert.deepEqual(storage.keys, []);
		assert.equal(storage.bufferedCalls(), 0);
	}
});

download.test("unavailable attachment storage still returns 503", async () => {
	const env = await routeEnv(new FakeObjectStore());
	env.YAOS_BUCKET = undefined;
	const response = await handleBlobRoute(env, VAULT_ID, request(), [hash], json);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "attachments_unavailable" });
});

download.test("public repair reports missing after HEAD without reading the object", async () => {
	const storage = streamingStore(true);
	const env = await routeEnv(storage.store);
	env.YAOS_SYNC = { async call() { throw new Error("missing blob must not reach authority"); } };
	const response = await handleBlobRoute(env, VAULT_ID, new Request(
		`https://example.test/vault/${VAULT_ID}/blobs/${hash}/repair`,
		{ method: "POST", headers: { Authorization: "Bearer r4-token" } },
	), [hash, "repair"], json);
	assert.deepEqual(await response.json(), { status: "missing" });
	assert.deepEqual(storage.keys, [key]);
	assert.equal(storage.bufferedCalls(), 0);
	assert.equal(storage.arrayBufferCalls(), 0);
});

download.test("only the exact public repair POST forwards authenticated actor context", async () => {
	const storage = streamingStore();
	storage.store.head = async () => ({ key, sha256: hash, etag: "etag", size: bytes.length,
		uploadedAt: uploaded.getTime(), contentType: null, customMetadata: {} });
	const env = await routeEnv(storage.store);
	const calls: Request[] = [];
	const result = json({ status: "suspect" });
	env.YAOS_SYNC = { async call(actorName, incoming) {
		assert.equal(actorName, VAULT_ID);
		calls.push(incoming);
		return result;
	} };
	const repairRequest = (token: string | null = "r4-token") => new Request(
		`https://example.test/vault/${VAULT_ID}/blobs/${hash}/repair`, {
			method: "POST", headers: token === null ? {} : {
				Authorization: `Bearer ${token}`, "x-yaos-device-id": "forged-device",
			},
		},
	);
	assert.equal((await handleBlobRoute(env, VAULT_ID, repairRequest(null), [hash, "repair"], json)).status, 401);
	assert.equal((await handleBlobRoute(env, VAULT_ID, repairRequest(), ["invalid", "repair"], json)).status, 400);
	for (const rest of [[hash], [hash, "other"], [hash, "repair", "extra"]]) {
		assert.equal((await handleBlobRoute(env, VAULT_ID, repairRequest(), rest, json)).status, 404);
	}
	assert.equal(calls.length, 0);
	const originalWarn = console.warn;
	console.warn = () => undefined;
	try {
		assert.equal(await handleBlobRoute(env, VAULT_ID, repairRequest(), [hash, "repair"], json), result);
	} finally { console.warn = originalWarn; }
	assert.equal(calls.length, 1);
	const forwarded = calls[0]!;
	assert.equal(forwarded.url, `https://internal/blobs/${hash}/repair`);
	assert.equal(forwarded.method, "POST");
	assert.equal(forwarded.headers.get("x-yaos-vault-id"), VAULT_ID);
	assert.equal(forwarded.headers.get("x-yaos-vault-generation"), GENERATION);
	assert.equal(forwarded.headers.get("x-yaos-device-id"), "device-r4");
	assert.equal(forwarded.headers.get("Authorization"), null);
	assert.equal(forwarded.body, null);
	assert.deepEqual(storage.keys, []);
});

await download.done();
