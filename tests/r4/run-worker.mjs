import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const { Miniflare } = require("miniflare");
const bundle = await build({
	entryPoints: [new URL("./worker.ts", import.meta.url).pathname], bundle: true,
	format: "esm", platform: "browser", target: "es2022", write: false,
});
const runtime = new Miniflare({
	modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-03-05", r2Buckets: ["BLOBS"],
});
const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
let passed = 0;
async function test(name, body) {
	await body();
	passed++;
	console.log(`PASS ${name}`);
}
async function upload(hash, bytes, headers = {}) {
	return await runtime.dispatchFetch(`https://r4.test/blobs/${hash}`, {
		method: "PUT", headers: { Authorization: "Bearer r4-token", "Content-Length": String(bytes.byteLength), ...headers }, body: bytes,
	});
}
async function metadata(hash) {
	return await (await runtime.dispatchFetch(`https://r4.test/metadata/${hash}`)).json();
}
try {
	const bytes = new TextEncoder().encode(`R4-${randomUUID()}`);
	const hash = hashOf(bytes);
	await test("correct hash creates; duplicate preserves metadata; existing wrong bytes return 400", async () => {
		const created = await upload(hash, bytes, { "Content-Type": "text/plain" });
		assert.equal(created.status, 204, await created.text());
		assert.equal(created.headers.get("X-R4-Created"), "1");
		const before = await metadata(hash);
		assert.equal(before.size, bytes.byteLength);
		const download = await runtime.dispatchFetch(`https://r4.test/blobs/${hash}`, { headers: { Authorization: "Bearer r4-token" } });
		assert.equal(download.headers.get("ETag"), `"${hash}"`);
		assert.equal(download.headers.get("Last-Modified"), new Date(before.uploaded).toUTCString());
		assert.equal(hashOf(new Uint8Array(await download.arrayBuffer())), hash);
		const duplicate = await upload(hash, bytes, { "Content-Type": "image/png" });
		assert.equal(duplicate.status, 204);
		assert.equal(duplicate.headers.get("X-R4-Puts"), "0");
		assert.deepEqual(await metadata(hash), before);
		const wrong = bytes.slice(); wrong[0] ^= 1;
		const response = await upload(hash, wrong);
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, "hash mismatch");
		assert.deepEqual(await metadata(hash), before);
	});
	await test("wrong hash creates no R2 object", async () => {
		const absent = "0".repeat(64);
		const response = await upload(absent, bytes);
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, "hash mismatch");
		assert.equal(await metadata(absent), null);
	});
	await test("R2 independently rejects a bad sha256 and leaves no object", async () => {
		const response = await runtime.dispatchFetch(`https://r4.test/r2-checksum/${"2".repeat(64)}`, {
			method: "PUT", body: bytes, headers: { "Content-Length": String(bytes.byteLength) },
		});
		assert.equal(response.status, 400);
		const result = await response.json();
		assert.match(result.error, /\(10037\)/);
		assert.equal(result.exists, false);
		console.log(`R2 checksum error: ${result.error}`);
	});
	await test("R2 BadDigest maps to 400 hash mismatch after independent Worker verification", async () => {
		const response = await upload(hash, bytes, { "X-R4-Mode": "checksum-error" });
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, "hash mismatch");
	});
	await test("missing, invalid, oversized and zero lengths rejected before publication", async () => {
		for (const [length, status] of [["missing", 400], ["no", 400], ["10485761", 413], ["0", 400]]) {
			const response = await upload("1".repeat(64), bytes, { "X-R4-Length": length });
			assert.equal(response.status, status, `length ${length}: ${await response.text()}`);
		}
		assert.equal(await metadata("1".repeat(64)), null);
	});
	await test("incorrect lengths create no final object", async () => {
		const content = new TextEncoder().encode(`length-${randomUUID()}`);
		const addressed = hashOf(content);
		for (const length of [content.byteLength - 1, content.byteLength + 1]) {
			const response = await upload(addressed, content, { "X-R4-Length": String(length) });
			assert.equal(response.status, 400, await response.text());
			assert.equal(await metadata(addressed), null);
		}
	});
	await test("concurrent identical native R2 uploads preserve one immutable object", async () => {
		const content = new Uint8Array(256 * 1024).fill(18);
		const addressed = hashOf(content);
		const responses = await Promise.all(Array.from({ length: 8 }, () => upload(addressed, content)));
		assert.deepEqual(responses.map((response) => response.status), Array(8).fill(204));
		assert.equal(responses.reduce((count, response) => count + Number(response.headers.get("X-R4-Created")), 0), 1);
		const before = await metadata(addressed);
		assert.equal(before.size, content.byteLength);
		assert.equal((await upload(addressed, content)).status, 204);
		assert.deepEqual(await metadata(addressed), before);
	});
	for (const mode of ["race-unread", "race-partial", "race-partial-unread", "storage-error"]) {
		await test(`${mode} drains and verifies all incoming bytes without hanging`, async () => {
			const content = new Uint8Array(256 * 1024).fill(24);
			const addressed = hashOf(content);
			const valid = await upload(addressed, content, { "X-R4-Mode": mode });
			assert.equal(valid.status, mode === "storage-error" ? 500 : 204, await valid.text());
			const wrong = content.slice(); wrong[wrong.length - 1] ^= 1;
			const invalid = await upload(addressed, wrong, { "X-R4-Mode": mode });
			assert.equal(invalid.status, 400, await invalid.text());
			assert.equal(invalid.headers.get("X-R4-Puts"), "1");
			for (const length of [content.length - 1, content.length + 1]) {
				const incorrect = await upload(addressed, content, { "X-R4-Mode": mode, "X-R4-Length": String(length) });
				assert.equal(incorrect.status, 400, await incorrect.text());
			}
		});
	}
	await test("10 MiB generated stream has bounded Worker backpressure and chunk-sized writes", async () => {
		const chunk = new Uint8Array(64 * 1024).fill(37);
		const digest = createHash("sha256");
		for (let offset = 0; offset < 10 * 1024 * 1024; offset += chunk.byteLength) digest.update(chunk);
		const response = await runtime.dispatchFetch(`https://r4.test/bounded/${digest.digest("hex")}`, {
			method: "PUT", headers: { Authorization: "Bearer r4-token" },
		});
		assert.equal(response.status, 204, await response.text());
		assert.equal(Number(response.headers.get("X-R4-Bytes-Read")), 10 * 1024 * 1024);
		assert.equal(Number(response.headers.get("X-R4-Produced")), 10 * 1024 * 1024);
		assert.ok(Number(response.headers.get("X-R4-Max-Ahead")) <= 4 * 64 * 1024);
		console.log(`Worker maximum source lead: ${response.headers.get("X-R4-Max-Ahead")} bytes`);
	});
	await test("10 MiB native Workers DigestStream + FixedLengthStream upload", async () => {
		const content = new Uint8Array(10 * 1024 * 1024).fill(71);
		const addressed = hashOf(content);
		const response = await upload(addressed, content);
		assert.equal(response.status, 204, await response.text());
		assert.equal((await metadata(addressed)).size, content.byteLength);
	});
	console.log(`R4 Workers: ${passed} tests passed`);
} finally {
	await runtime.dispose();
}
