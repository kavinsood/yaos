// D9 blobs through the real Router (server/src/router.ts) with the real vault host and an in-memory R2 bucket: the key
// `v/<vaultId>/<address>`, opaque addresses (no hash check), overwrite, the GET headers, the 10 MiB cap (declared and
// streamed), `exists` (≤ 50, A4: a malformed entry is 400, errors), the bearer check in the vault DO (zero config
// calls), and the no-bucket answer (`503 attachments_unavailable`, `capabilities.attachments = false`). The blob GC
// routes (E2EE design §19 A3, relay-wire §11.3): list paging, the conditional delete, their limit and refusals.
import assert from "node:assert/strict";

import {
	BLOB_LIST_PAGE_SIZE,
	MAX_BLOB_EXISTS_BODY_BYTES,
	MAX_BLOB_UPLOAD_BYTES,
	blobKey,
	type BlobListPage,
} from "../../server/src/router";
import { BLOB_GC_REQUEST_LIMIT, BLOB_GC_WINDOW_MS } from "../../server/src/vault/host";
import { suite } from "../harness.ts";
import { newDevice, type DeviceSeed, type VaultObject } from "./helpers/workerHarness.ts";
import { claim, deviceFetch, enrollVia, json, withWorld, type World } from "./helpers/operatorWorld.ts";

const s = suite("blobs");

const ADDRESS = "0123456789abcdef".repeat(4);

async function enrolled(world: World): Promise<{ vaultId: string; device: DeviceSeed; cookie: string; vault: VaultObject }> {
	const claimed = await claim(world);
	const device = newDevice("laptop-device-0001");
	await enrollVia(world, claimed.pairingCode, device);
	return { vaultId: claimed.vaultId, device, cookie: claimed.cookie, vault: claimed.vault };
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

function listBlobs(world: World, vaultId: string, device: DeviceSeed, cursor?: string): Promise<Response> {
	return deviceFetch(world, vaultId, device, cursor === undefined ? "blobs" : `blobs?cursor=${cursor}`);
}

function deleteBlob(world: World, vaultId: string, device: DeviceSeed, address: string, before: number | string):
	Promise<Response> {
	return deviceFetch(world, vaultId, device, `blobs/${address}?ifUploadedBefore=${before}`, { method: "DELETE" });
}

async function page(response: Response): Promise<BlobListPage> {
	return await response.json() as BlobListPage;
}

/** The 64-hex address of `index`, so the key order is the index order. */
function addressOf(index: number): string {
	return index.toString(16).padStart(64, "0");
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

s.test("D9 exists: the first 50 entries, in order; legacy errors; a 64 KiB body cap", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const addresses = Array.from({ length: 60 }, (_, index) => index.toString(16).padStart(64, "0"));
		for (const address of addresses) world.bucket.objects.set(blobKey(vaultId, address), new Uint8Array([1]));
		world.bucket.objects.set(blobKey("another-vault-id-000", ADDRESS), new Uint8Array([1]));

		const listed = [addresses[3], ADDRESS, addresses[0], ...addresses.slice(10, 54), ...addresses.slice(54)];
		const response = await exists(world, vaultId, device, JSON.stringify({ hashes: listed }));
		assert.equal(response.status, 200);
		const { present } = await json(response) as { present: string[] };
		assert.deepEqual(present, [addresses[3], addresses[0], ...addresses.slice(10, 57)],
			"only the first 50 entries; a foreign-vault address is absent");
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

s.test("A4 exists: any malformed entry, even past the first 50, is 400 invalid_address with no R2 HEAD", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		world.bucket.objects.set(blobKey(vaultId, ADDRESS), new Uint8Array([1]));
		const valid = Array.from({ length: 50 }, (_, index) => index.toString(16).padStart(64, "0"));
		for (const bad of ["not-an-address", "E".repeat(64), "e".repeat(63), "e".repeat(65), "", 7, null,
			{ address: ADDRESS }, [ADDRESS]]) {
			for (const hashes of [[ADDRESS, bad], [bad], [...valid, bad]]) {
				world.bucket.calls.length = 0;
				const refused = await exists(world, vaultId, device, JSON.stringify({ hashes }));
				assert.deepEqual([refused.status, await json(refused)], [400, { error: "invalid_address" }],
					`${JSON.stringify(bad)} at ${hashes.length - 1}`);
				assert.deepEqual(world.bucket.calls, [], "a refused probe makes no R2 call");
			}
		}
		assert.deepEqual(await json(await exists(world, vaultId, device, JSON.stringify({ hashes: [] }))), { present: [] });
		assert.deepEqual(await json(await exists(world, vaultId, device, JSON.stringify({ hashes: [ADDRESS, "e".repeat(64)] }))),
			{ present: [ADDRESS] }, "a well-formed absent address is still just absent");
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

s.test("A3 list: pages of 1000 in address order, cursor = last address, uploadedAt from R2; only this vault", async () => {
	assert.equal(BLOB_LIST_PAGE_SIZE, 1000, "R2's list maximum");
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const empty = await listBlobs(world, vaultId, device);
		assert.equal(empty.status, 200);
		assert.equal(empty.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(await json(empty), { items: [], next: null });

		const total = 2 * BLOB_LIST_PAGE_SIZE + 500;
		for (let index = total - 1; index >= 0; index--) {
			world.bucket.objects.set(blobKey(vaultId, addressOf(index)), new Uint8Array([1]));
			world.bucket.uploadedAt.set(blobKey(vaultId, addressOf(index)), 10_000 + index);
		}
		world.bucket.objects.set(blobKey("another-vault-id-000", addressOf(0)), new Uint8Array([1]));
		world.bucket.objects.set(blobKey("zzzzzzzzzzzzzzzzzzzzzz", addressOf(1)), new Uint8Array([1]));

		world.bucket.calls.length = 0;
		const pages: BlobListPage[] = [];
		let cursor: string | undefined;
		do {
			const response = await listBlobs(world, vaultId, device, cursor);
			assert.equal(response.status, 200);
			const listed = await page(response);
			pages.push(listed);
			cursor = listed.next ?? undefined;
		} while (cursor !== undefined);
		assert.deepEqual(pages.map((listed) => listed.items.length), [1000, 1000, 500]);
		assert.deepEqual(pages.map((listed) => listed.next), [addressOf(999), addressOf(1999), null]);
		assert.deepEqual(pages.flatMap((listed) => listed.items),
			Array.from({ length: total }, (_, index) => ({ address: addressOf(index), uploadedAt: 10_000 + index })),
			"every address once, in order, with R2's upload time");
		assert.deepEqual(world.bucket.calls, [`list v/${vaultId}/`, `list v/${vaultId}/ after v/${vaultId}/${addressOf(999)}`,
			`list v/${vaultId}/ after v/${vaultId}/${addressOf(1999)}`], "one R2 list per page, startAfter = the cursor");

		// Deleting while paging (the sweep does) skips nothing: the cursor is a key, not a position.
		const first = await page(await listBlobs(world, vaultId, device));
		for (const item of first.items) world.bucket.objects.delete(blobKey(vaultId, item.address));
		const second = await page(await listBlobs(world, vaultId, device, first.next!));
		assert.equal(second.items[0]!.address, addressOf(1000), "the page after a deleted cursor starts right after it");

		// Exactly one full page left: R2 says the listing is complete, so `next` is null.
		for (let index = 1000; index < total; index++) {
			if (index >= 2000) world.bucket.objects.delete(blobKey(vaultId, addressOf(index)));
		}
		const exact = await page(await listBlobs(world, vaultId, device));
		assert.deepEqual([exact.items.length, exact.next], [1000, null]);
	});
});

s.test("A3 list: a PUT stamps uploadedAt; an overwrite refreshes it", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		world.bucket.now = 5_000;
		assert.equal((await put(world, vaultId, device, ADDRESS, new Uint8Array([1]))).status, 204);
		assert.deepEqual(await json(await listBlobs(world, vaultId, device)),
			{ items: [{ address: ADDRESS, uploadedAt: 5_000 }], next: null });
		world.bucket.now = 9_000;
		assert.equal((await put(world, vaultId, device, ADDRESS, new Uint8Array([2]))).status, 204);
		assert.deepEqual(await json(await listBlobs(world, vaultId, device)),
			{ items: [{ address: ADDRESS, uploadedAt: 9_000 }], next: null });
	});
});

s.test("A3 delete: older → deleted; at or after the cutoff → newer (kept); missing → absent", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const older = addressOf(1);
		const same = addressOf(2);
		const newer = addressOf(3);
		for (const [address, at] of [[older, 999], [same, 1_000], [newer, 1_001]] as const) {
			world.bucket.now = at;
			assert.equal((await put(world, vaultId, device, address, new Uint8Array([7]))).status, 204);
		}
		world.bucket.calls.length = 0;
		const deleted = await deleteBlob(world, vaultId, device, older, 1_000);
		assert.equal(deleted.status, 200);
		assert.equal(deleted.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(await json(deleted), { result: "deleted", uploadedAt: 999 });
		assert.deepEqual(world.bucket.calls, [`head ${blobKey(vaultId, older)}`, "delete 1"], "one HEAD, then one delete");
		assert.equal(world.bucket.objects.has(blobKey(vaultId, older)), false);

		world.bucket.calls.length = 0;
		assert.deepEqual(await json(await deleteBlob(world, vaultId, device, same, 1_000)),
			{ result: "newer", uploadedAt: 1_000 }, "strictly before: an upload at the cutoff stays");
		assert.deepEqual(await json(await deleteBlob(world, vaultId, device, newer, 1_000)),
			{ result: "newer", uploadedAt: 1_001 });
		assert.deepEqual(await json(await deleteBlob(world, vaultId, device, older, 1_000)), { result: "absent" });
		assert.deepEqual(await json(await deleteBlob(world, vaultId, device, addressOf(9), 0)), { result: "absent" });
		assert.ok(world.bucket.calls.every((call) => call.startsWith("head ")), "a kept or absent blob is never deleted");
		assert.deepEqual([...world.bucket.objects.keys()].sort(), [blobKey(vaultId, same), blobKey(vaultId, newer)]);

		const other = blobKey("another-vault-id-000", newer);
		world.bucket.objects.set(other, new Uint8Array([1]));
		assert.deepEqual(await json(await deleteBlob(world, vaultId, device, newer, 2_000)),
			{ result: "deleted", uploadedAt: 1_001 });
		assert.equal(world.bucket.objects.has(other), true, "another vault's object under the same address stays");
	});
});

s.test("A3 sweep race: a blob re-uploaded after the sweep listed it survives the delete", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		world.bucket.now = 1_000;
		await put(world, vaultId, device, ADDRESS, new Uint8Array([1]));
		const listed = await page(await listBlobs(world, vaultId, device));
		assert.deepEqual(listed.items, [{ address: ADDRESS, uploadedAt: 1_000 }]);
		const cutoff = 2_000;
		// Another device references the bytes again and re-uploads them after the cutoff the sweep chose.
		world.bucket.now = 3_000;
		await put(world, vaultId, device, ADDRESS, new Uint8Array([2]));
		assert.deepEqual(await json(await deleteBlob(world, vaultId, device, ADDRESS, cutoff)),
			{ result: "newer", uploadedAt: 3_000 });
		const read = await deviceFetch(world, vaultId, device, `blobs/${ADDRESS}`);
		assert.deepEqual([read.status, [...new Uint8Array(await read.arrayBuffer())]], [200, [2]]);
	});
});

s.test("A3 refusals: bad cursor, address or ifUploadedBefore → 400 before the vault DO and R2", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		world.bucket.objects.set(blobKey(vaultId, ADDRESS), new Uint8Array([1]));
		const cases: Array<[string, string, string]> = [
			...["A".repeat(64), "a".repeat(63), "a".repeat(65), "x", "%20", `${ADDRESS}%2F`].map(
				(cursor): [string, string, string] => ["GET", `blobs?cursor=${cursor}`, "invalid_cursor"]),
			...["A".repeat(64), "a".repeat(63), "exists"].map(
				(bad): [string, string, string] => ["DELETE", `blobs/${bad}?ifUploadedBefore=1`, "invalid_address"]),
			...["", "?ifUploadedBefore", "?ifUploadedBefore=", "?ifUploadedBefore=-1", "?ifUploadedBefore=1.5",
				"?ifUploadedBefore=1e3", "?ifUploadedBefore=%201", "?ifUploadedBefore=0x10", "?ifUploadedBefore=+1",
				"?ifUploadedBefore=9007199254740992", "?ifUploadedBefore=99999999999999999", "?before=1"].map(
				(query): [string, string, string] => ["DELETE", `blobs/${ADDRESS}${query}`, "invalid_if_uploaded_before"]),
		];
		const fetches = world.cluster.fetches.length;
		world.bucket.calls.length = 0;
		for (const [method, path, error] of cases) {
			const response = await deviceFetch(world, vaultId, device, path, { method });
			assert.deepEqual([response.status, await json(response)], [400, { error }], `${method} ${path}`);
		}
		assert.equal(world.cluster.fetches.length, fetches, "no vault-DO call for a malformed request");
		assert.deepEqual(world.bucket.calls, [], "no R2 call for a malformed request");
		assert.deepEqual(await json(await listBlobs(world, vaultId, device, "")), { items: [{ address: ADDRESS, uploadedAt: 0 }],
			next: null }, "an empty cursor is the first page");
		for (const cutoff of ["0", "00", "9007199254740991"]) {
			assert.equal((await deleteBlob(world, vaultId, device, addressOf(5), cutoff)).status, 200, cutoff);
		}
		assert.equal(world.bucket.objects.has(blobKey(vaultId, ADDRESS)), true);
	});
});

s.test("A3 bearer: one /blobs/gc-auth call, zero config calls; a stranger, another vault, no bearer or a revoked device → 401, no R2", async () => {
	await withWorld(async (world) => {
		const { vaultId, device, cookie } = await enrolled(world);
		world.bucket.objects.set(blobKey(vaultId, ADDRESS), new Uint8Array([1]));
		const stranger = newDevice("stranger-device-01");
		const other = (await json(await world.fetch("/operator/vaults", { method: "POST", cookie, json: { name: "B" } })))
			.vault as { vaultId: string };
		const accesses = world.accesses.length;
		world.bucket.calls.length = 0;
		for (const response of [
			await listBlobs(world, vaultId, stranger),
			await deleteBlob(world, vaultId, stranger, ADDRESS, Number.MAX_SAFE_INTEGER),
			await listBlobs(world, other.vaultId, device),
			await deleteBlob(world, other.vaultId, device, ADDRESS, Number.MAX_SAFE_INTEGER),
			await world.router.fetch(new Request(`https://yaos.test/vault/${vaultId}/blobs`), world.env),
			await world.router.fetch(new Request(`https://yaos.test/vault/${vaultId}/blobs/${ADDRESS}?ifUploadedBefore=1`,
				{ method: "DELETE", headers: { Authorization: "Bearer not-a-token" } }), world.env),
		]) {
			assert.deepEqual([response.status, await json(response)], [401, { error: "unauthorized" }]);
		}
		assert.deepEqual(world.bucket.calls, [], "no R2 call without a valid bearer");

		const before = world.cluster.fetches.length;
		assert.equal((await listBlobs(world, vaultId, device)).status, 200);
		assert.equal((await deleteBlob(world, vaultId, device, addressOf(5), 1)).status, 200);
		assert.deepEqual(world.cluster.fetches.slice(before).map(({ method, url }) => `${method} ${url}`),
			["POST https://vault.internal/blobs/gc-auth", "POST https://vault.internal/blobs/gc-auth"]);
		assert.equal(world.accesses.length, accesses, "zero config-DO accesses on the GC routes");

		const revoked = await world.fetch(`/operator/vaults/${vaultId}/devices/${device.deviceId}`, { method: "DELETE", cookie });
		assert.equal(revoked.status, 200);
		world.bucket.calls.length = 0;
		assert.equal((await listBlobs(world, vaultId, device)).status, 401, "D7: a revoked bearer is 401");
		assert.equal((await deleteBlob(world, vaultId, device, ADDRESS, Number.MAX_SAFE_INTEGER)).status, 401);
		assert.deepEqual(world.bucket.calls, []);
		assert.equal(world.bucket.objects.size, 1);
	});
});

s.test("A3 limit: 60 authenticated GC requests a minute per vault → 429 + Retry-After; strangers do not count; blob I/O is not limited", async () => {
	assert.deepEqual([BLOB_GC_REQUEST_LIMIT, BLOB_GC_WINDOW_MS], [60, 60_000]);
	await withWorld(async (world) => {
		const { vaultId, device, vault } = await enrolled(world);
		const stranger = newDevice("stranger-device-01");
		for (let index = 0; index < 100; index++) {
			assert.equal((await listBlobs(world, vaultId, stranger)).status, 401);
		}
		for (let index = 0; index < BLOB_GC_REQUEST_LIMIT; index++) {
			const response = index % 2 === 0
				? await listBlobs(world, vaultId, device)
				: await deleteBlob(world, vaultId, device, addressOf(index), 1);
			assert.equal(response.status, 200, `request ${index + 1}`);
		}
		vault.timers.now += 15_000;
		world.bucket.calls.length = 0;
		for (const response of [await listBlobs(world, vaultId, device), await deleteBlob(world, vaultId, device, ADDRESS, 1)]) {
			assert.equal(response.status, 429);
			assert.deepEqual(await json(response), { error: "too_many_attempts" });
			assert.equal(response.headers.get("Retry-After"), "45");
		}
		assert.deepEqual(world.bucket.calls, [], "a limited request makes no R2 call");
		assert.equal((await listBlobs(world, vaultId, stranger)).status, 401, "auth comes before the limit");
		assert.equal((await put(world, vaultId, device, ADDRESS, new Uint8Array([1]))).status, 204, "blob PUT is not limited");
		assert.equal((await deviceFetch(world, vaultId, device, `blobs/${ADDRESS}`)).status, 200, "blob GET is not limited");
		vault.timers.now += 45_000;
		assert.equal((await listBlobs(world, vaultId, device)).status, 200, "the window resets");
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
			await listBlobs(world, vaultId, device),
			await listBlobs(world, vaultId, device, "not-a-cursor"),
			await deleteBlob(world, vaultId, device, ADDRESS, 1),
			await deleteBlob(world, vaultId, device, "bad", "bad"),
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
