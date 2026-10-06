// D9 blobs through the real Router (server/src/router.ts) with the real vault host and an in-memory R2 bucket: the key
// `v/<vaultId>/<address>`, opaque addresses (no hash check), overwrite, the GET headers, the 10 MiB cap (declared and
// streamed), `exists` (≤ 50, filtering, errors), the bearer check in the vault DO (zero config calls), and the
// no-bucket answer (`503 attachments_unavailable`, `capabilities.attachments = false`).
import assert from "node:assert/strict";

import { MAX_BLOB_EXISTS_BODY_BYTES, MAX_BLOB_UPLOAD_BYTES, blobKey } from "../../server/src/router";
import { suite } from "../harness.ts";
import { newDevice, type DeviceSeed } from "./helpers/workerHarness.ts";
import { claim, deviceFetch, enrollVia, json, withWorld, type World } from "./helpers/operatorWorld.ts";

const s = suite("blobs");

const ADDRESS = "0123456789abcdef".repeat(4);

async function enrolled(world: World): Promise<{ vaultId: string; device: DeviceSeed; cookie: string }> {
	const claimed = await claim(world);
	const device = newDevice("laptop-device-0001");
	await enrollVia(world, claimed.pairingCode, device);
	return { vaultId: claimed.vaultId, device, cookie: claimed.cookie };
}

function put(world: World, vaultId: string, device: DeviceSeed, address: string, body: BodyInit | null,
	headers: Record<string, string> = {}): Promise<Response> {
	return deviceFetch(world, vaultId, device, `blobs/${address}`, { method: "PUT", body,
		headers: { "Content-Type": "application/octet-stream", ...headers },
		...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
}

function exists(world: World, vaultId: string, device: DeviceSeed, body: string): Promise<Response> {
	return deviceFetch(world, vaultId, device, "blobs/exists",
		{ method: "POST", body, headers: { "Content-Type": "application/json" } });
}

function chunked(total: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= total) return controller.close();
			const size = Math.min(chunk, total - sent);
			sent += size;
			controller.enqueue(new Uint8Array(size).fill(7));
		},
	});
}

s.test("T-BLOB-OPAQUE: R2 key v/<vaultId>/<address>, no hash check, PUT overwrites, GET is opaque bytes", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const first = new TextEncoder().encode("<html><script>alert(1)</script></html>");
		const stored = await put(world, vaultId, device, ADDRESS, first, { "Content-Type": "text/html" });
		assert.equal(stored.status, 204);
		assert.deepEqual([...world.bucket.objects.keys()], [`v/${vaultId}/${ADDRESS}`]);
		assert.equal(blobKey(vaultId, ADDRESS), `v/${vaultId}/${ADDRESS}`);

		const second = new Uint8Array([1, 2, 3, 4]);
		assert.equal((await put(world, vaultId, device, ADDRESS, second)).status, 204, "PUT overwrites");
		const read = await deviceFetch(world, vaultId, device, `blobs/${ADDRESS}`);
		assert.equal(read.status, 200);
		assert.deepEqual([...new Uint8Array(await read.arrayBuffer())], [1, 2, 3, 4]);
		assert.equal(read.headers.get("Content-Type"), "application/octet-stream", "never the uploader's type");
		assert.equal(read.headers.get("X-Content-Type-Options"), "nosniff");
		assert.equal(read.headers.get("Cache-Control"), "no-store");

		const missing = await deviceFetch(world, vaultId, device, `blobs/${"f".repeat(64)}`);
		assert.deepEqual([missing.status, await json(missing)], [404, { error: "not found" }]);

		const fetches = world.cluster.fetches.length;
		for (const address of [ADDRESS.toUpperCase(), "a".repeat(63), "a".repeat(65), `${"g".repeat(64)}`]) {
			const bad = await deviceFetch(world, vaultId, device, `blobs/${address}`);
			assert.deepEqual([bad.status, await json(bad)], [400, { error: "invalid_address" }], address);
			const badPut = await put(world, vaultId, device, address, new Uint8Array([1]));
			assert.equal(badPut.status, 400);
		}
		assert.equal(world.cluster.fetches.length, fetches, "a malformed address never reaches the vault DO");
	});
});

s.test("D9 PUT cap: 10 MiB accepted; a larger declared or streamed body is 413; an empty body is 400", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const exact = new Uint8Array(MAX_BLOB_UPLOAD_BYTES).fill(1);

		world.bucket.calls.length = 0;
		const declared = await put(world, vaultId, device, ADDRESS, exact, { "Content-Length": String(exact.byteLength) });
		assert.equal(declared.status, 204);
		assert.deepEqual(world.bucket.calls, [`put v/${vaultId}/${ADDRESS} stream`], "a declared length streams to R2");
		assert.equal(world.bucket.objects.get(blobKey(vaultId, ADDRESS))!.byteLength, MAX_BLOB_UPLOAD_BYTES);

		world.bucket.calls.length = 0;
		const undeclared = await put(world, vaultId, device, ADDRESS, chunked(MAX_BLOB_UPLOAD_BYTES));
		assert.equal(undeclared.status, 204);
		assert.deepEqual(world.bucket.calls, [`put v/${vaultId}/${ADDRESS} bytes`], "no length: read bounded, then put");

		const fetches = world.cluster.fetches.length;
		const tooLarge = await put(world, vaultId, device, ADDRESS, new Uint8Array(1),
			{ "Content-Length": String(MAX_BLOB_UPLOAD_BYTES + 1) });
		assert.deepEqual([tooLarge.status, await json(tooLarge)], [413, { error: "body_too_large" }]);
		const invalid = await put(world, vaultId, device, ADDRESS, new Uint8Array(1), { "Content-Length": "1e3" });
		assert.deepEqual([invalid.status, await json(invalid)], [400, { error: "invalid_content_length" }]);
		assert.equal(world.cluster.fetches.length, fetches, "a declared size refusal comes before the vault DO");

		world.bucket.calls.length = 0;
		const streamed = await put(world, vaultId, device, ADDRESS, chunked(MAX_BLOB_UPLOAD_BYTES + 1));
		assert.deepEqual([streamed.status, await json(streamed)], [413, { error: "body_too_large" }]);
		const empty = await put(world, vaultId, device, ADDRESS, null);
		assert.deepEqual([empty.status, await json(empty)], [400, { error: "missing_body" }]);
		const zero = await put(world, vaultId, device, ADDRESS, new Uint8Array(0), { "Content-Length": "0" });
		assert.deepEqual([zero.status, await json(zero)], [400, { error: "missing_body" }]);
		assert.deepEqual(world.bucket.calls, [], "no refused PUT reaches R2");
	});
});

s.test("D9 exists: the first 50 entries, well-formed only, in order; legacy errors; a 64 KiB body cap", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const addresses = Array.from({ length: 60 }, (_, index) => index.toString(16).padStart(64, "0"));
		for (const address of addresses) world.bucket.objects.set(blobKey(vaultId, address), new Uint8Array([1]));
		world.bucket.objects.set(blobKey("another-vault-id-000", ADDRESS), new Uint8Array([1]));
		world.bucket.objects.set(blobKey(vaultId, "e".repeat(64)), new Uint8Array([1]));

		const mixed = [addresses[3], "not-an-address", ADDRESS, 7, "E".repeat(64), addresses[0],
			...addresses.slice(10, 54), ...addresses.slice(54)];
		const response = await exists(world, vaultId, device, JSON.stringify({ hashes: mixed }));
		assert.equal(response.status, 200);
		const { present } = await json(response) as { present: string[] };
		assert.deepEqual(present, [addresses[3], addresses[0], ...addresses.slice(10, 54)],
			"only the first 50 entries; malformed and foreign-vault addresses are absent");
		assert.ok(!present.includes(ADDRESS), "another vault's blob is not visible");

		world.bucket.calls.length = 0;
		assert.deepEqual(await json(await exists(world, vaultId, device, JSON.stringify({ hashes: addresses }))),
			{ present: addresses.slice(0, 50) });
		assert.equal(world.bucket.calls.filter((call) => call.startsWith("head ")).length, 50, "≤ 50 R2 HEADs");

		for (const [body, error] of [["{", "invalid json"], ["", "invalid json"], ["{}", "missing hashes array"],
			['{"hashes":"x"}', "missing hashes array"], ["null", "missing hashes array"]] as const) {
			const refused = await exists(world, vaultId, device, body);
			assert.deepEqual([refused.status, await json(refused)], [400, { error }], body);
		}
		const huge = await exists(world, vaultId, device, JSON.stringify({ hashes: ["x".repeat(MAX_BLOB_EXISTS_BODY_BYTES)] }));
		assert.deepEqual([huge.status, await json(huge)], [413, { error: "body_too_large" }]);
	});
});

s.test("D9 bearer: the vault DO checks it (one /blobs/auth call, zero config calls); refusals touch no R2", async () => {
	await withWorld(async (world) => {
		const { vaultId, device, cookie } = await enrolled(world);
		world.bucket.objects.set(blobKey(vaultId, ADDRESS), new Uint8Array([1]));
		const stranger = newDevice("stranger-device-01");
		const other = (await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "B" } })))
			.vault as { vaultId: string };
		const accesses = world.accesses.length;
		world.bucket.calls.length = 0;
		for (const response of [
			await deviceFetch(world, vaultId, stranger, `blobs/${ADDRESS}`),
			await put(world, vaultId, stranger, ADDRESS, new Uint8Array([2])),
			await exists(world, vaultId, stranger, JSON.stringify({ hashes: [ADDRESS] })),
			await deviceFetch(world, other.vaultId, device, `blobs/${ADDRESS}`),
		]) {
			assert.deepEqual([response.status, await json(response)], [401, { error: "unauthorized" }]);
		}
		const noBearer = await world.router.fetch(new Request(`https://yaos.test/vault/${vaultId}/blobs/${ADDRESS}`), world.env);
		assert.equal(noBearer.status, 401);
		assert.deepEqual(world.bucket.calls, [], "no R2 call without a valid bearer");
		assert.equal(world.accesses.length, accesses, "zero config-DO accesses on blob routes");

		const before = world.cluster.fetches.length;
		assert.equal((await deviceFetch(world, vaultId, device, `blobs/${ADDRESS}`)).status, 200);
		assert.deepEqual(world.cluster.fetches.slice(before).map(({ method, url }) => `${method} ${url}`),
			["POST https://vault.internal/blobs/auth"]);

		const revoked = await world.fetch(`/operator/vaults/${vaultId}/devices/${device.deviceId}`, { method: "DELETE", cookie });
		assert.equal(revoked.status, 200);
		assert.equal((await deviceFetch(world, vaultId, device, `blobs/${ADDRESS}`)).status, 401, "D7: a revoked bearer is 401");
		assert.equal(world.bucket.objects.size, 1, "revoke keeps blobs");
	});
});

s.test("T-BLOB-UNAVAILABLE (WB): no bucket → 503 attachments_unavailable before auth; capabilities.attachments", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const fetches = world.cluster.fetches.length;
		for (const response of [
			await deviceFetch(world, vaultId, device, `blobs/${ADDRESS}`),
			await put(world, vaultId, device, ADDRESS, new Uint8Array([1])),
			await exists(world, vaultId, device, JSON.stringify({ hashes: [ADDRESS] })),
			await world.router.fetch(new Request(`https://yaos.test/vault/${vaultId}/blobs/${ADDRESS}`), world.env),
		]) {
			assert.deepEqual([response.status, await json(response)], [503, { error: "attachments_unavailable" }]);
		}
		assert.equal(world.cluster.fetches.length, fetches, "no vault-DO call without a bucket");
		const capabilities = await json(await world.fetch("/api/capabilities"));
		assert.equal(capabilities.attachments, false);
	}, { bucket: false });
	await withWorld(async (world) => {
		await claim(world);
		assert.equal((await json(await world.fetch("/api/capabilities"))).attachments, true);
	});
});

await s.done();
