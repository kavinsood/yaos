import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { VerifiedObjectStreamOptions } from "../../server/src/platformPorts";
import { handleBlobRoute } from "../../server/src/routes/blobs";
import { ObjectStreamValidationError, verifyObjectStream } from "../../server/src/verifiedObjectStream";
import { blobKey } from "../../server/src/vaultObjectStore";
import { FakeObjectStore } from "../mocks/workerEnv";
import { routeEnv, json, VAULT_ID, GENERATION } from "../r4/routeEnv";
import { suite } from "../harness";

const upload = suite("blob-upload-integrity-log");
const bytes = new TextEncoder().encode("private-upload-body-do-not-log");
const hash = createHash("sha256").update(bytes).digest("hex");
const key = blobKey(VAULT_ID, GENERATION, hash);

class VerifiedStore extends FakeObjectStore {
	streamCalls = 0;
	async head(objectKey: string) {
		const object = await super.head(objectKey);
		return object ? { ...object, sha256: createHash("sha256").update(this.objects.get(objectKey)!).digest("hex") } : null;
	}
	async createOnlyVerifiedStream(objectKey: string, body: ReadableStream<Uint8Array>, options: VerifiedObjectStreamOptions): Promise<"created" | "exists"> {
		this.streamCalls++;
		const digest = createHash("sha256");
		const chunks: Uint8Array[] = [];
		await verifyObjectStream(body, options,
			async (chunk) => { digest.update(chunk); },
			async () => digest.digest("hex"),
			async (chunk) => { chunks.push(chunk.slice()); },
		);
		return this.createOnly(objectKey, new Uint8Array(Buffer.concat(chunks)), options);
	}
}

async function uploadEnv(store: VerifiedStore) {
	const env = await routeEnv(store);
	env.YAOS_SYNC = { async call(_actorName, incoming) {
		if (new URL(incoming.url).pathname === "/blobs/suspects") return json({ suspect: [] });
		if (new URL(incoming.url).pathname === "/blobs/clear-suspect") return json({ cleared: true });
		throw new Error("unexpected blob authority call");
	} };
	return env;
}

function request(body: Uint8Array, length = body.length, token: string | null = "private-upload-credential"): Request {
	return new Request(`https://example.test/vault/${VAULT_ID}/blobs/${hash}`, {
		method: "PUT",
		headers: {
			...(token === null ? {} : { Authorization: `Bearer ${token}` }),
			"Content-Length": String(length),
			"x-yaos-device-id": "forged-request-device",
		},
		body,
	});
}

async function captureWarnings(body: (warnings: unknown[][]) => Promise<void>): Promise<void> {
	const original = console.warn;
	const warnings: unknown[][] = [];
	console.warn = (...args: unknown[]) => { warnings.push(args); };
	try { await body(warnings); } finally { console.warn = original; }
}

function expectedEvent() {
	return { event: "attachment.integrity.failed", operation: "blob.upload",
		deviceId: "device-r4", vaultId: VAULT_ID, vaultGeneration: GENERATION, hash };
}

upload.test("hash mismatch emits exactly one structured event with authenticated identity and full hash", async () => {
	await captureWarnings(async (warnings) => {
		const store = new VerifiedStore();
		const wrong = bytes.slice();
		wrong[0] = wrong[0]! ^ 1;
		const response = await handleBlobRoute(await uploadEnv(store), VAULT_ID, request(wrong), [hash], json);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "hash mismatch" });
		assert.deepEqual(warnings, [[expectedEvent()]]);
		assert.equal(store.streamCalls, 1);
		assert.equal(store.objects.size, 0);
		const logged = JSON.stringify(warnings);
		for (const forbidden of ["private-upload-credential", "private-upload-body-do-not-log", "forged-request-device", "Authorization"]) {
			assert.equal(logged.includes(forbidden), false);
		}
	});
});

upload.test("wrong duplicate upload logs once without replacing the existing object", async () => {
	await captureWarnings(async (warnings) => {
		const store = new VerifiedStore({ objects: new Map([[key, bytes]]) });
		const wrong = bytes.slice();
		wrong[wrong.length - 1] = wrong[wrong.length - 1]! ^ 1;
		const response = await handleBlobRoute(await uploadEnv(store), VAULT_ID, request(wrong), [hash], json);
		assert.equal(response.status, 400);
		assert.deepEqual(warnings, [[expectedEvent()]]);
		assert.deepEqual(store.objects.get(key), bytes);
		assert.equal(store.puts.length, 0);
		assert.equal(store.streamCalls, 1);
	});
});

upload.test("valid new and duplicate uploads remain silent and immutable", async () => {
	await captureWarnings(async (warnings) => {
		const store = new VerifiedStore();
		const env = await uploadEnv(store);
		for (let attempt = 0; attempt < 2; attempt++) {
			assert.equal((await handleBlobRoute(env, VAULT_ID, request(bytes), [hash], json)).status, 204);
		}
		assert.deepEqual(warnings, []);
		assert.equal(store.puts.length, 1);
		assert.equal(store.streamCalls, 2);
		assert.deepEqual(store.objects.get(key), bytes);
	});
});

upload.test("exists excludes suspect and invalid objects; verified replacement clears suspect", async () => {
	const store = new VerifiedStore({ objects: new Map([[key, bytes]]) });
	const env = await uploadEnv(store);
	const suspects = new Set([key]);
	const calls: string[] = [];
	env.YAOS_SYNC = { async call(_actorName, incoming) {
		const path = new URL(incoming.url).pathname;
		calls.push(path);
		if (path === "/blobs/suspects") {
			const { keys } = await incoming.json() as { keys: string[] };
			return json({ suspect: keys.filter((objectKey) => suspects.has(objectKey)) });
		}
		if (path === "/blobs/clear-suspect") { suspects.delete(key); return json({ cleared: true }); }
		throw new Error("unexpected authority call");
	} };
	store.head = async (objectKey) => {
		const object = await FakeObjectStore.prototype.head.call(store, objectKey);
		return object ? { ...object, sha256: hash, etag: "test-etag" } : null;
	};
	store.createOnlyVerifiedStream = async (objectKey, body, options) => {
		assert.equal(options.replaceEtag, "test-etag");
		const chunks: Uint8Array[] = [];
		const digest = createHash("sha256");
		await verifyObjectStream(body, options, async (chunk) => { digest.update(chunk); },
			async () => digest.digest("hex"), async (chunk) => { chunks.push(chunk.slice()); });
		await store.put(objectKey, new Uint8Array(Buffer.concat(chunks)));
		return "created";
	};
	const exists = () => handleBlobRoute(env, VAULT_ID, new Request(`https://example.test/vault/${VAULT_ID}/blobs/exists`, {
		method: "POST", headers: { Authorization: "Bearer r4-token" }, body: JSON.stringify({ hashes: [hash] }),
	}), ["exists"], json);
	assert.deepEqual(await (await exists()).json(), { present: [] });
	assert.equal((await handleBlobRoute(env, VAULT_ID, request(bytes), [hash], json)).status, 204);
	assert.equal(suspects.size, 0);
	assert.deepEqual(await (await exists()).json(), { present: [hash] });
	assert.deepEqual(calls, ["/blobs/suspects", "/blobs/suspects", "/blobs/clear-suspect", "/blobs/suspects"]);
});

upload.test("non-hash stream validation failures preserve errors without integrity warnings", async () => {
	await captureWarnings(async (warnings) => {
		const store = new VerifiedStore();
		const env = await uploadEnv(store);
		for (const [kind, message] of [
			["length_mismatch", "Content-Length mismatch"],
			["missing_body", "missing request body"],
			["body_read_failed", "failed to read request body"],
		] as const) {
			store.createOnlyVerifiedStream = async () => { throw new ObjectStreamValidationError(kind); };
			const response = await handleBlobRoute(env, VAULT_ID, request(bytes), [hash], json);
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), { error: message });
		}
		assert.deepEqual(warnings, []);
	});
});

upload.test("unauthenticated and invalid uploads never publish or emit integrity warnings", async () => {
	await captureWarnings(async (warnings) => {
		const store = new VerifiedStore();
		const env = await uploadEnv(store);
		assert.equal((await handleBlobRoute(env, VAULT_ID, request(bytes, bytes.length, null), [hash], json)).status, 401);
		assert.equal((await handleBlobRoute(env, VAULT_ID, request(bytes), ["invalid"], json)).status, 400);
		assert.equal(store.streamCalls, 0);
		assert.deepEqual(warnings, []);
	});
});

upload.test("unexpected storage failures still propagate without being logged as hash mismatches", async () => {
	await captureWarnings(async (warnings) => {
		const store = new VerifiedStore();
		const failure = new Error("storage unavailable");
		store.createOnlyVerifiedStream = async () => { throw failure; };
		await assert.rejects(handleBlobRoute(await uploadEnv(store), VAULT_ID, request(bytes), [hash], json), failure);
		assert.deepEqual(warnings, []);
	});
});

await upload.done();
