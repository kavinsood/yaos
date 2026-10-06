// D9 blobs through the real Router (server/src/router.ts) with the real vault host and an in-memory R2 bucket: the key
// `v/<vaultId>/<address>`, opaque addresses (no hash check), overwrite, the GET headers, the 10 MiB cap (declared and
// streamed), `exists` (≤ 50, more or a malformed entry is 400 (A4), errors), the bearer check in the vault DO (zero
// config calls), and the no-bucket answer (`503 attachments_unavailable`, `capabilities.attachments = false`). The blob
// GC routes (E2EE design §19 A3, relay-wire §11.3.1): list paging (empty truncated R2 pages too), the batch
// conditional delete, their limit and refusals.
import assert from "node:assert/strict";

import {
	BLOB_GC_HEAD_CONCURRENCY,
	BLOB_LIST_MAX_CALLS,
	BLOB_LIST_PAGE_SIZE,
	BLOB_LIST_RETRY_AFTER_S,
	MAX_BLOB_DELETE_ADDRESSES,
	MAX_BLOB_DELETE_BODY_BYTES,
	MAX_BLOB_EXISTS_ADDRESSES,
	MAX_BLOB_EXISTS_BODY_BYTES,
	MAX_BLOB_UPLOAD_BYTES,
	blobKey,
	type BlobDeleteResult,
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

function deleteBody(world: World, vaultId: string, device: DeviceSeed, body: string): Promise<Response> {
	return deviceFetch(world, vaultId, device, "blobs/delete",
		{ method: "POST", body, headers: { "Content-Type": "application/json" } });
}

function deleteBlobs(world: World, vaultId: string, device: DeviceSeed, addresses: readonly string[], ifUploadedBefore: number):
	Promise<Response> {
	return deleteBody(world, vaultId, device, JSON.stringify({ ifUploadedBefore, addresses }));
}

async function page(response: Response): Promise<BlobListPage> {
	return await response.json() as BlobListPage;
}

async function results(response: Response): Promise<BlobDeleteResult[]> {
	assert.equal(response.status, 200);
	return (await response.json() as { results: BlobDeleteResult[] }).results;
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

s.test("D9 exists: up to 50 entries, answered in order; more → 400 too_many_addresses; legacy errors; a 64 KiB body cap", async () => {
	assert.equal(MAX_BLOB_EXISTS_ADDRESSES, 50);
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const addresses = Array.from({ length: 60 }, (_, index) => addressOf(index));
		for (const address of addresses) world.bucket.objects.set(blobKey(vaultId, address), new Uint8Array([1]));
		world.bucket.objects.set(blobKey("another-vault-id-000", ADDRESS), new Uint8Array([1]));

		const listed = [addresses[3]!, ADDRESS, addresses[0]!, ...addresses.slice(10, 57)];
		assert.equal(listed.length, 50);
		world.bucket.calls.length = 0;
		const response = await exists(world, vaultId, device, JSON.stringify({ hashes: listed }));
		assert.equal(response.status, 200);
		const { present } = await json(response) as { present: string[] };
		assert.deepEqual(present, [addresses[3], addresses[0], ...addresses.slice(10, 57)],
			"every entry, in request order; a foreign-vault address is absent");
		assert.ok(!present.includes(ADDRESS), "another vault's blob is not visible");
		assert.equal(world.bucket.calls.filter((call) => call.startsWith("head ")).length, 50, "one R2 HEAD per entry");

		world.bucket.calls.length = 0;
		for (const hashes of [addresses.slice(0, 51), addresses, [...addresses.slice(0, 50), "not-an-address"]]) {
			const refused = await exists(world, vaultId, device, JSON.stringify({ hashes }));
			assert.deepEqual([refused.status, await json(refused)], [400, { error: "too_many_addresses" }],
				`${hashes.length} entries`);
		}
		assert.deepEqual(world.bucket.calls, [], "never a silent answer for the first 50; no R2 call");

		for (const [body, error] of [["{", "invalid json"], ["", "invalid json"], ["{}", "missing hashes array"],
			['{"hashes":"x"}', "missing hashes array"], ["null", "missing hashes array"]] as const) {
			const refused = await exists(world, vaultId, device, body);
			assert.deepEqual([refused.status, await json(refused)], [400, { error }], body);
		}
		const huge = await exists(world, vaultId, device, JSON.stringify({ hashes: ["x".repeat(MAX_BLOB_EXISTS_BODY_BYTES)] }));
		assert.deepEqual([huge.status, await json(huge)], [413, { error: "body_too_large" }]);
	});
});

s.test("T-BLOB-EXISTS-STRICT (A4): any malformed entry, the 50th too, is 400 invalid_address with no R2 HEAD", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		world.bucket.objects.set(blobKey(vaultId, ADDRESS), new Uint8Array([1]));
		const valid = Array.from({ length: MAX_BLOB_EXISTS_ADDRESSES - 1 }, (_, index) => addressOf(index));
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

s.test("T-BLOB-GC-LIST: pages of 1000 in address order, cursor = last address, uploadedAt from R2; only this vault", async () => {
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

s.test("T-BLOB-GC-LIST: a PUT stamps uploadedAt; an overwrite refreshes it", async () => {
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

s.test("T-BLOB-GC-LIST: an empty truncated R2 page is followed with R2's cursor (≤ 10 calls), else 503 list_incomplete", async () => {
	assert.deepEqual([BLOB_LIST_MAX_CALLS, BLOB_LIST_RETRY_AFTER_S], [10, 5]);
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const prefix = `v/${vaultId}/`;
		for (let index = 0; index < 1005; index++) world.bucket.objects.set(blobKey(vaultId, addressOf(index)), new Uint8Array([1]));

		// First page: 3 empty truncated answers, then objects; one request.
		world.bucket.emptyTruncatedLists = 3;
		world.bucket.calls.length = 0;
		const first = await page(await listBlobs(world, vaultId, device));
		assert.deepEqual([first.items.length, first.items[0]!.address, first.next], [1000, addressOf(0), addressOf(999)]);
		assert.deepEqual(world.bucket.calls, [`list ${prefix}`, `list ${prefix} cursor `, `list ${prefix} cursor `,
			`list ${prefix} cursor `], "after an empty truncated answer: prefix + R2's own cursor, no startAfter");

		// A later page: the client's cursor is startAfter, then R2's cursor carries the position.
		world.bucket.emptyTruncatedLists = 2;
		world.bucket.calls.length = 0;
		const second = await page(await listBlobs(world, vaultId, device, first.next!));
		assert.deepEqual(second, { items: Array.from({ length: 5 }, (_, index) => ({ address: addressOf(1000 + index),
			uploadedAt: 0 })), next: null });
		const after = blobKey(vaultId, addressOf(999));
		assert.deepEqual(world.bucket.calls, [`list ${prefix} after ${after}`, `list ${prefix} cursor ${after}`,
			`list ${prefix} cursor ${after}`]);

		// Truncated and empty, then the listing completes with nothing more: an empty last page, next null.
		world.bucket.emptyTruncatedLists = 1;
		assert.deepEqual(await json(await listBlobs(world, vaultId, device, addressOf(1004))), { items: [], next: null });

		// Ten empty truncated answers: 503, never `next: null` while R2 says truncated.
		world.bucket.emptyTruncatedLists = BLOB_LIST_MAX_CALLS;
		world.bucket.calls.length = 0;
		const incomplete = await listBlobs(world, vaultId, device, first.next!);
		assert.deepEqual([incomplete.status, await json(incomplete)], [503, { error: "list_incomplete" }]);
		assert.equal(incomplete.headers.get("Retry-After"), "5");
		assert.equal(incomplete.headers.get("Access-Control-Allow-Origin"), "*", "CORS like every vault route");
		assert.equal(world.bucket.calls.length, BLOB_LIST_MAX_CALLS, "bounded: 10 list calls");
		assert.deepEqual(await page(await listBlobs(world, vaultId, device, first.next!)), second, "the retry lists");

		// Nine empty answers still end in a page.
		world.bucket.emptyTruncatedLists = BLOB_LIST_MAX_CALLS - 1;
		assert.equal((await page(await listBlobs(world, vaultId, device))).items.length, 1000);
	});
});

s.test("T-BLOB-GC-DELETE: one batch; older → deleted, at or after the cutoff → newer, missing → absent; request order", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const older = addressOf(1);
		const same = addressOf(2);
		const newer = addressOf(3);
		const oldest = addressOf(4);
		const missing = addressOf(9);
		for (const [address, at] of [[older, 999], [same, 1_000], [newer, 1_001], [oldest, 10]] as const) {
			world.bucket.now = at;
			assert.equal((await put(world, vaultId, device, address, new Uint8Array([7]))).status, 204);
		}
		const other = blobKey("another-vault-id-000", older);
		world.bucket.objects.set(other, new Uint8Array([1]));
		world.bucket.calls.length = 0;
		const response = await deleteBlobs(world, vaultId, device, [newer, older, missing, same, oldest], 1_000);
		assert.equal(response.headers.get("Cache-Control"), "no-store");
		assert.deepEqual(await results(response), [
			{ address: newer, result: "newer", uploadedAt: 1_001 },
			{ address: older, result: "deleted", uploadedAt: 999 },
			{ address: missing, result: "absent" },
			{ address: same, result: "newer", uploadedAt: 1_000 },
			{ address: oldest, result: "deleted", uploadedAt: 10 },
		], "in request order; strictly before: an upload at the cutoff stays");
		assert.deepEqual(world.bucket.calls, [...[newer, older, missing, same, oldest].map((a) => `head ${blobKey(vaultId, a)}`),
			"delete 2"], "a HEAD per address, then ONE delete of the old keys");
		assert.deepEqual([...world.bucket.objects.keys()].sort(), [blobKey(vaultId, same), blobKey(vaultId, newer), other].sort(),
			"kept: the newer ones, and another vault's object under a deleted address");

		world.bucket.calls.length = 0;
		assert.deepEqual(await results(await deleteBlobs(world, vaultId, device, [older, same], 1_000)),
			[{ address: older, result: "absent" }, { address: same, result: "newer", uploadedAt: 1_000 }]);
		assert.deepEqual(world.bucket.calls, [`head ${blobKey(vaultId, older)}`, `head ${blobKey(vaultId, same)}`],
			"nothing old → no delete call");
	});
});

s.test("T-BLOB-GC-DELETE: 100 addresses, 6 HEADs in flight, one delete; 101 → 400 too_many_addresses", async () => {
	assert.deepEqual([MAX_BLOB_DELETE_ADDRESSES, BLOB_GC_HEAD_CONCURRENCY], [100, 6]);
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const addresses = Array.from({ length: MAX_BLOB_DELETE_ADDRESSES }, (_, index) => addressOf(index));
		addresses.forEach((address, index) => {
			if (index % 4 === 3) return;
			world.bucket.objects.set(blobKey(vaultId, address), new Uint8Array([1]));
			world.bucket.uploadedAt.set(blobKey(vaultId, address), index % 4 === 2 ? 5_000 : 1_000);
		});
		world.bucket.calls.length = 0;
		world.bucket.maxHeadsInFlight = 0;
		assert.deepEqual(await results(await deleteBlobs(world, vaultId, device, addresses, 2_000)),
			addresses.map((address, index): BlobDeleteResult => index % 4 === 3
				? { address, result: "absent" }
				: index % 4 === 2
					? { address, result: "newer", uploadedAt: 5_000 }
					: { address, result: "deleted", uploadedAt: 1_000 }));
		assert.equal(world.bucket.maxHeadsInFlight, BLOB_GC_HEAD_CONCURRENCY, "6 HEADs in flight, never 7");
		assert.deepEqual(world.bucket.calls.slice(0, 100), addresses.map((address) => `head ${blobKey(vaultId, address)}`));
		assert.deepEqual(world.bucket.calls.slice(100), ["delete 50"], "one R2 delete for the 50 old keys");
		assert.equal(world.bucket.objects.size, 25);

		const fetches = world.cluster.fetches.length;
		world.bucket.calls.length = 0;
		const tooMany = await deleteBlobs(world, vaultId, device, [...addresses, addressOf(100)], 2_000);
		assert.deepEqual([tooMany.status, await json(tooMany)], [400, { error: "too_many_addresses" }]);
		assert.equal(world.cluster.fetches.length, fetches, "refused before the vault DO");
		assert.deepEqual(world.bucket.calls, [], "and before R2");
	});
});

s.test("T-BLOB-GC-RACE: a re-upload after the sweep's cutoff survives; a PUT between the HEAD and the delete does not", async () => {
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		const kept = addressOf(1);
		const orphan = addressOf(2);
		world.bucket.now = 1_000;
		await put(world, vaultId, device, kept, new Uint8Array([1]));
		await put(world, vaultId, device, orphan, new Uint8Array([1]));
		const listed = await page(await listBlobs(world, vaultId, device));
		assert.deepEqual(listed.items, [{ address: kept, uploadedAt: 1_000 }, { address: orphan, uploadedAt: 1_000 }]);
		const cutoff = 2_000;
		// Another device references `kept` again and re-uploads it after the cutoff the sweep chose.
		world.bucket.now = 3_000;
		await put(world, vaultId, device, kept, new Uint8Array([2]));
		assert.deepEqual(await results(await deleteBlobs(world, vaultId, device, [kept, orphan], cutoff)),
			[{ address: kept, result: "newer", uploadedAt: 3_000 }, { address: orphan, result: "deleted", uploadedAt: 1_000 }]);
		const read = await deviceFetch(world, vaultId, device, `blobs/${kept}`);
		assert.deepEqual([read.status, [...new Uint8Array(await read.arrayBuffer())]], [200, [2]]);

		// The documented window (relay-wire §11.3.1): R2 has no conditional delete, so a PUT that lands after the
		// address's HEAD and before the batch delete is deleted with it; the client re-checks and re-uploads.
		world.bucket.now = 1_000;
		await put(world, vaultId, device, orphan, new Uint8Array([3]));
		world.bucket.afterHead = (key) => {
			if (key !== blobKey(vaultId, orphan)) return;
			world.bucket.objects.set(key, new Uint8Array([4]));
			world.bucket.uploadedAt.set(key, 3_000);
		};
		assert.deepEqual(await results(await deleteBlobs(world, vaultId, device, [orphan], cutoff)),
			[{ address: orphan, result: "deleted", uploadedAt: 1_000 }]);
		world.bucket.afterHead = null;
		assert.equal(world.bucket.objects.has(blobKey(vaultId, orphan)), false, "the late PUT is gone too");
	});
});

s.test("T-BLOB-GC-LIMIT (refusals): a bad cursor or delete body → 400/413 before the vault DO and R2", async () => {
	assert.equal(MAX_BLOB_DELETE_BODY_BYTES, 16 * 1024);
	await withWorld(async (world) => {
		const { vaultId, device } = await enrolled(world);
		world.bucket.objects.set(blobKey(vaultId, ADDRESS), new Uint8Array([1]));
		const body = (fields: Record<string, unknown>) => JSON.stringify({ ifUploadedBefore: 1, addresses: [ADDRESS], ...fields });
		const hundred = Array.from({ length: MAX_BLOB_DELETE_ADDRESSES }, (_, index) => addressOf(index));
		const deletes: Array<[string, string]> = [
			...["{", "", "null", "[]", "1", '"x"', `${body({})}x`].map((raw): [string, string] => [raw, "invalid_json"]),
			['{"ifUploadedBefore":1}', "invalid_addresses"],
			...[null, "x", ADDRESS, {}, []].map((addresses): [string, string] => [body({ addresses }), "invalid_addresses"]),
			[body({ addresses: [...hundred, addressOf(100)] }), "too_many_addresses"],
			[body({ addresses: [...hundred, "x"] }), "too_many_addresses"],
			...["A".repeat(64), "a".repeat(63), "a".repeat(65), "", 7, null, [ADDRESS], { address: ADDRESS }].map(
				(bad): [string, string] => [body({ addresses: [ADDRESS, bad] }), "invalid_address"]),
			[body({ addresses: [ADDRESS, addressOf(1), ADDRESS] }), "duplicate_address"],
			[JSON.stringify({ addresses: [ADDRESS] }), "invalid_if_uploaded_before"],
			...[null, -1, 1.5, "1", "0", true, [1], 2 ** 53, 1e300].map(
				(ifUploadedBefore): [string, string] => [body({ ifUploadedBefore }), "invalid_if_uploaded_before"]),
		];
		const fetches = world.cluster.fetches.length;
		world.bucket.calls.length = 0;
		for (const cursor of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "x", "%20", `${ADDRESS}%2F`]) {
			const response = await listBlobs(world, vaultId, device, cursor);
			assert.deepEqual([response.status, await json(response)], [400, { error: "invalid_cursor" }], cursor);
		}
		for (const [raw, error] of deletes) {
			const response = await deleteBody(world, vaultId, device, raw);
			assert.deepEqual([response.status, await json(response)], [400, { error }], raw.slice(0, 120));
		}
		const huge = await deleteBody(world, vaultId, device, body({ pad: "x".repeat(MAX_BLOB_DELETE_BODY_BYTES) }));
		assert.deepEqual([huge.status, await json(huge)], [413, { error: "body_too_large" }]);
		assert.equal(world.cluster.fetches.length, fetches, "no vault-DO call for a malformed request");
		assert.deepEqual(world.bucket.calls, [], "no R2 call for a malformed request");

		assert.deepEqual(await json(await listBlobs(world, vaultId, device, "")), { items: [{ address: ADDRESS, uploadedAt: 0 }],
			next: null }, "an empty cursor is the first page");
		for (const cutoff of [0, Number.MAX_SAFE_INTEGER]) {
			assert.equal((await deleteBlobs(world, vaultId, device, [addressOf(5)], cutoff)).status, 200, String(cutoff));
		}
		assert.equal((await deleteBody(world, vaultId, device, body({ extra: true, addresses: [addressOf(5)] }))).status, 200,
			"unknown fields are ignored");
		assert.equal(world.bucket.objects.has(blobKey(vaultId, ADDRESS)), true);
		const single = await deviceFetch(world, vaultId, device, `blobs/${ADDRESS}?ifUploadedBefore=1`, { method: "DELETE" });
		assert.deepEqual([single.status, await json(single)], [404, { error: "not_found" }], "the single-address DELETE is gone");
		assert.equal(world.bucket.objects.has(blobKey(vaultId, ADDRESS)), true);
	});
});

s.test("T-BLOB-GC-LIMIT (bearer): one /blobs/gc-auth call, zero config calls; a stranger, another vault, no bearer or a revoked device → 401, no R2", async () => {
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
			await deleteBlobs(world, vaultId, stranger, [ADDRESS], Number.MAX_SAFE_INTEGER),
			await listBlobs(world, other.vaultId, device),
			await deleteBlobs(world, other.vaultId, device, [ADDRESS], Number.MAX_SAFE_INTEGER),
			await world.router.fetch(new Request(`https://yaos.test/vault/${vaultId}/blobs`), world.env),
			await world.router.fetch(new Request(`https://yaos.test/vault/${vaultId}/blobs/delete`, { method: "POST",
				headers: { Authorization: "Bearer not-a-token", "Content-Type": "application/json" },
				body: JSON.stringify({ ifUploadedBefore: Number.MAX_SAFE_INTEGER, addresses: [ADDRESS] }) }), world.env),
		]) {
			assert.deepEqual([response.status, await json(response)], [401, { error: "unauthorized" }]);
		}
		assert.deepEqual(world.bucket.calls, [], "no R2 call without a valid bearer");

		const before = world.cluster.fetches.length;
		assert.equal((await listBlobs(world, vaultId, device)).status, 200);
		const hundred = Array.from({ length: MAX_BLOB_DELETE_ADDRESSES }, (_, index) => addressOf(index));
		assert.equal((await deleteBlobs(world, vaultId, device, hundred, 1)).status, 200);
		assert.deepEqual(world.cluster.fetches.slice(before).map(({ method, url }) => `${method} ${url}`),
			["POST https://vault.internal/blobs/gc-auth", "POST https://vault.internal/blobs/gc-auth"],
			"one auth call per request; a 100-address batch too");
		assert.equal(world.accesses.length, accesses, "zero config-DO accesses on the GC routes");

		const revoked = await world.fetch(`/operator/vaults/${vaultId}/devices/${device.deviceId}`, { method: "DELETE", cookie });
		assert.equal(revoked.status, 200);
		world.bucket.calls.length = 0;
		assert.equal((await listBlobs(world, vaultId, device)).status, 401, "D7: a revoked bearer is 401");
		assert.equal((await deleteBlobs(world, vaultId, device, [ADDRESS], Number.MAX_SAFE_INTEGER)).status, 401);
		assert.deepEqual(world.bucket.calls, []);
		assert.equal(world.bucket.objects.size, 1);
	});
});

s.test("T-BLOB-GC-LIMIT: 60 authenticated GC requests a minute per vault (a 100-address batch is one) → 429 + Retry-After; strangers do not count; blob I/O is not limited", async () => {
	assert.deepEqual([BLOB_GC_REQUEST_LIMIT, BLOB_GC_WINDOW_MS], [60, 60_000]);
	await withWorld(async (world) => {
		const { vaultId, device, vault } = await enrolled(world);
		const stranger = newDevice("stranger-device-01");
		for (let index = 0; index < 100; index++) {
			assert.equal((await listBlobs(world, vaultId, stranger)).status, 401);
		}
		const batch = Array.from({ length: MAX_BLOB_DELETE_ADDRESSES }, (_, index) => addressOf(index));
		for (let index = 0; index < BLOB_GC_REQUEST_LIMIT; index++) {
			const response = index % 2 === 0
				? await listBlobs(world, vaultId, device)
				: await deleteBlobs(world, vaultId, device, batch, 1);
			assert.equal(response.status, 200, `request ${index + 1}`);
		}
		vault.timers.now += 15_000;
		world.bucket.calls.length = 0;
		for (const response of [await listBlobs(world, vaultId, device), await deleteBlobs(world, vaultId, device, [ADDRESS], 1)]) {
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
			await deleteBlobs(world, vaultId, device, [ADDRESS], 1),
			await deleteBody(world, vaultId, device, "not json"),
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
