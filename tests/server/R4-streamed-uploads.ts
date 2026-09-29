import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemObjectStore } from "../../packages/server-node/src/objectStore";
import { handleBlobRoute } from "../../server/src/routes/blobs";
import { blobKey } from "../../server/src/vaultObjectStore";
import { routeEnv, json, VAULT_ID, GENERATION } from "../r4/routeEnv";
import { suite } from "../harness";

const suiteR4 = suite("R4-streamed-uploads");

function request(body: ReadableStream<Uint8Array> | null, length: string | null): Request {
	const headers = new Headers({ Authorization: "Bearer r4-token" });
	if (length !== null) headers.set("Content-Length", length);
	return { method: "PUT", headers, body } as Request;
}

function stream(bytes: Uint8Array, onChunk: () => void = () => undefined): ReadableStream<Uint8Array> {
	let offset = 0;
	return new ReadableStream({ pull(controller) {
		if (offset === bytes.byteLength) return controller.close();
		controller.enqueue(bytes.slice(offset, offset + 2));
		offset = Math.min(offset + 2, bytes.byteLength);
		onChunk();
	} });
}

suiteR4.test("Node route creates exactly once and rejects wrong bytes even on an existing key", async () => {
	const directory = await mkdtemp(join(tmpdir(), "r4-route-"));
	try {
		const store = new FilesystemObjectStore(directory);
		const env = await routeEnv(store);
		const bytes = new TextEncoder().encode("correct R4 upload");
		const hash = createHash("sha256").update(bytes).digest("hex");
		const upload = (body: Uint8Array) => handleBlobRoute(env, VAULT_ID, request(stream(body), String(body.byteLength)), [hash], json);
		assert.equal((await upload(bytes)).status, 204);
		const key = blobKey(VAULT_ID, GENERATION, hash);
		const before = await stat(join(directory, key));
		const downloadRequest = request(null, null);
		Object.defineProperty(downloadRequest, "method", { value: "GET" });
		const downloaded = await handleBlobRoute(env, VAULT_ID, downloadRequest, [hash], json);
		assert.equal(downloaded.headers.get("ETag"), `"${hash}"`);
		assert.equal(downloaded.headers.get("Last-Modified"), new Date((await store.head(key))!.uploadedAt).toUTCString());
		assert.equal(await downloaded.text(), new TextDecoder().decode(bytes));
		assert.equal((await upload(bytes)).status, 204);
		const wrong = bytes.slice(); wrong[wrong.length - 1] = wrong[wrong.length - 1]! ^ 1;
		let chunks = 0;
		const response = await handleBlobRoute(env, VAULT_ID, request(stream(wrong, () => chunks++), String(wrong.length)), [hash], json);
		assert.equal(response.status, 400);
		assert.equal((await response.json() as { error: string }).error, "hash mismatch");
		assert.equal(chunks, Math.ceil(wrong.length / 2));
		assert.equal((await stat(join(directory, key))).mtimeMs, before.mtimeMs);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

suiteR4.test("Node route rejects missing/invalid/over length before body access", async () => {
	const directory = await mkdtemp(join(tmpdir(), "r4-length-"));
	try {
		const env = await routeEnv(new FilesystemObjectStore(directory));
		for (const [length, status] of [[null, 400], ["bad", 400], ["1.0", 400], ["-1", 400], ["9007199254740992", 400], ["10485761", 413], ["0", 400]] as const) {
			const req = request(null, length);
			Object.defineProperty(req, "body", { get() { throw new Error("body accessed before length validation"); } });
			assert.equal((await handleBlobRoute(env, VAULT_ID, req, ["0".repeat(64)], json)).status, status);
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});

suiteR4.test("Node route wrong hash and declared/actual length mismatch create no final object", async () => {
	const directory = await mkdtemp(join(tmpdir(), "r4-mismatch-"));
	try {
		const store = new FilesystemObjectStore(directory);
		const env = await routeEnv(store);
		const bytes = new TextEncoder().encode("must not publish");
		const hash = createHash("sha256").update(bytes).digest("hex");
		for (const length of [bytes.length - 1, bytes.length + 1]) {
			assert.equal((await handleBlobRoute(env, VAULT_ID, request(stream(bytes), String(length)), [hash], json)).status, 400);
			assert.equal(await store.head(blobKey(VAULT_ID, GENERATION, hash)), null);
		}
		assert.equal((await handleBlobRoute(env, VAULT_ID, request(stream(bytes), String(bytes.length)), ["0".repeat(64)], json)).status, 400);
		assert.equal(await store.head(blobKey(VAULT_ID, GENERATION, "0".repeat(64))), null);
		assert.equal((await handleBlobRoute(env, VAULT_ID, request(null, "1"), [hash], json)).status, 400);
		assert.equal((await handleBlobRoute(env, VAULT_ID, request(stream(new Uint8Array()), "1"), [hash], json)).status, 400);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

suiteR4.test("Node route length failure does not await a never-settling source cancellation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "r4-cancel-"));
	try {
		const env = await routeEnv(new FilesystemObjectStore(directory));
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) { controller.enqueue(new Uint8Array([1, 2])); },
			cancel() { cancelled = true; return new Promise<void>(() => undefined); },
		});
		const response = await handleBlobRoute(env, VAULT_ID, request(body, "1"), ["0".repeat(64)], json);
		assert.equal(response.status, 400);
		assert.equal(cancelled, true);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

await suiteR4.done();
