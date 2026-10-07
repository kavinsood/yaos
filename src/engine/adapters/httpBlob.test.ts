import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClockPort } from "../../ports/clock";
import { MAX_BLOB_UPLOAD_BYTES } from "../../core/limits";
import { BlobTooLargeError } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { BLOB_EXISTS_BATCH, createHttpBlob, GC_RETRY_ATTEMPTS, probeHttpBlob } from "./httpBlob";
import { RelayHttpError } from "./relayHttp";
import { fakeFetch, jsonResponse, ManualClock, type FakeRequest } from "./relayTestFakes";

const TOKEN = "device-token-SECRET";
const addr = (i: number) => i.toString(16).padStart(64, "0") as BlobAddress;

/** A clock whose timers fire at once, recording their delays. */
function instantClock(waits: number[]): ClockPort {
	return {
		now: () => 0, monotonic: () => 0, yieldNow: async () => undefined, clearTimer: () => undefined,
		setTimer: (ms, fn) => {
			waits.push(ms);
			queueMicrotask(fn);
			return waits.length;
		},
	};
}

function blob(route: (req: FakeRequest) => Response | "network") {
	const f = fakeFetch(route);
	const waits: number[] = [];
	return {
		port: createHttpBlob({ baseUrl: "https://r.example/", vaultId: "v1", credential: TOKEN, fetch: f.fetch, clock: instantClock(waits) }),
		requests: f.requests,
		waits,
	};
}

async function rejection(p: Promise<unknown>): Promise<RelayHttpError> {
	try {
		await p;
	} catch (error) {
		assert.ok(error instanceof RelayHttpError);
		assert.ok(!error.message.includes(TOKEN));
		return error;
	}
	assert.fail("expected a rejection");
}

describe("httpBlob", () => {
	it("put/get round-trip over the blob routes", async () => {
		const store = new Map<string, Uint8Array>();
		const { port, requests } = blob((req) => {
			const key = req.url.pathname.split("/").pop() ?? "";
			if (req.method === "PUT" && req.body instanceof Uint8Array) {
				store.set(key, req.body);
				return new Response(null, { status: 204 });
			}
			const hit = store.get(key);
			return hit ? new Response(hit.slice()) : jsonResponse({ error: "not found" }, 404);
		});
		assert.equal(port.maxBlobBytes, MAX_BLOB_UPLOAD_BYTES, "no capabilities read: the relay's own cap");
		await port.put(addr(1), [new Uint8Array([1]), new Uint8Array([2])]);
		assert.deepEqual(await port.get(addr(1)), new Uint8Array([1, 2]));
		assert.equal(await port.get(addr(2)), null);
		assert.equal(requests[0]!.url.pathname, `/vault/v1/blobs/${addr(1)}`);
		assert.equal(requests[0]!.headers.get("content-type"), "application/octet-stream");
		for (const r of requests) assert.equal(r.headers.get("authorization"), `Bearer ${TOKEN}`);
	});

	it("put sends the parts as one Blob body (no BufferSource for fetch to copy again), bytes in order", async () => {
		const bodies: unknown[] = [];
		const port = createHttpBlob({
			baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN,
			fetch: async (_url, init) => { bodies.push(init?.body); return new Response(null, { status: 204 }); },
		});
		const parts = [new Uint8Array([1, 2, 3]), new Uint8Array(new ArrayBuffer(8), 2, 4).fill(9), new Uint8Array(0)];
		await port.put(addr(1), parts);
		await port.put(addr(1), parts); // a retry re-reads the same parts
		assert.equal(bodies.length, 2);
		for (const b of bodies) {
			assert.ok(b instanceof Blob);
			assert.equal(b.size, 7);
			assert.deepEqual(new Uint8Array(await b.arrayBuffer()), new Uint8Array([1, 2, 3, 9, 9, 9, 9]));
		}
	});

	it("put answered 413 throws BlobTooLargeError, whatever the body (the relay's JSON, the edge's HTML page)", async () => {
		for (const res of [
			() => jsonResponse({ error: "body_too_large" }, 413),
			() => new Response("<html><head><title>413 Request Entity Too Large</title></head><body>cloudflare</body></html>", { status: 413, headers: { "Content-Type": "text/html" } }),
		]) {
			const { port } = blob(res);
			const e = await port.put(addr(1), [new Uint8Array(5), new Uint8Array(3)]).then(() => null, (err: unknown) => err);
			assert.ok(e instanceof BlobTooLargeError, String(e));
			assert.equal(e.bytes, 8);
		}
		// Any other refusal stays a RelayHttpError (retried with backoff by the blob queue).
		assert.equal((await rejection(blob(() => jsonResponse({ error: "length_required" }, 411)).port.put(addr(1), [new Uint8Array(1)]))).status, 411);
	});

	it("get reads a Content-Length body into one buffer of that size; short, long or oversize bodies are errors", async () => {
		const body = (chunks: number[][], headers: Record<string, string>, cancelled?: { n: number }) => new Response(new ReadableStream<Uint8Array>({
			pull(c) {
				const next = chunks.shift();
				if (next) c.enqueue(new Uint8Array(next));
				else c.close();
			},
			cancel() { if (cancelled) cancelled.n++; },
		}), { status: 200, headers });
		const get = (res: () => Response, maxBlobBytes?: number) => createHttpBlob({
			baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, maxBlobBytes, fetch: fakeFetch(res).fetch,
		}).get(addr(1));
		assert.deepEqual(await get(() => body([[1, 2], [3], [4, 5, 6]], { "Content-Length": "6" })), new Uint8Array([1, 2, 3, 4, 5, 6]));
		assert.deepEqual(await get(() => body([], { "Content-Length": "0" })), new Uint8Array(0));
		// No usable length, or an encoded body: arrayBuffer().
		assert.deepEqual(await get(() => body([[7], [8, 9]], {})), new Uint8Array([7, 8, 9]));
		assert.deepEqual(await get(() => body([[7], [8, 9]], { "Content-Length": "2", "Content-Encoding": "gzip" })), new Uint8Array([7, 8, 9]));
		const short = await rejection(get(() => body([[1, 2]], { "Content-Length": "3" })));
		assert.deepEqual([short.status, short.code], [200, "malformed_response"]);
		const long = { n: 0 };
		assert.equal((await rejection(get(() => body([[1, 2], [3, 4], [5], [6]], { "Content-Length": "3" }, long)))).code, "malformed_response");
		assert.equal(long.n, 1, "the rest of the stream is cancelled");
		const oversize = { n: 0 };
		assert.equal((await rejection(get(() => body([[1, 2, 3, 4]], { "Content-Length": "4" }, oversize), 3))).code, "malformed_response");
		assert.equal(oversize.n, 1, "nothing read past the cap");
		const broken = new Response(new ReadableStream<Uint8Array>({
			start(c) { c.enqueue(new Uint8Array([1])); },
			pull(c) { c.error(new TypeError("connection reset")); },
		}), { status: 200, headers: { "Content-Length": "4" } });
		assert.equal((await rejection(get(() => broken))).code, "network_error");
	});

	it("has() batches by 50 and only reports requested addresses", async () => {
		const { port, requests } = blob((req) => {
			const hashes: string[] = JSON.parse(String(req.body)).hashes;
			return jsonResponse({ present: [...hashes.filter((_h, i) => i % 2 === 0), addr(9999)] });
		});
		const wanted = Array.from({ length: 120 }, (_v, i) => addr(i));
		const present = await port.has(wanted);
		assert.equal(requests.length, 3);
		assert.equal(JSON.parse(String(requests[0]!.body)).hashes.length, BLOB_EXISTS_BATCH);
		assert.equal(requests[0]!.url.pathname, "/vault/v1/blobs/exists");
		assert.equal(present.size, 60);
		assert.ok(present.has(addr(0)) && !present.has(addr(1)) && !present.has(addr(9999)));
		assert.equal((await port.has([])).size, 0);
	});

	it("503 attachments_unavailable and other failures throw RelayHttpError", async () => {
		const unavailable = blob(() => jsonResponse({ error: "attachments_unavailable" }, 503)).port;
		for (const p of [unavailable.get(addr(1)), unavailable.put(addr(1), [new Uint8Array(1)]), unavailable.has([addr(1)])]) {
			const e = await rejection(p);
			assert.deepEqual([e.status, e.code], [503, "attachments_unavailable"]);
		}
		const mismatch = await rejection(blob(() => jsonResponse({ error: "hash mismatch" }, 400)).port.put(addr(1), [new Uint8Array(1)]));
		assert.equal(mismatch.code, "hash mismatch");
		const unknownVault = await rejection(blob(() => jsonResponse({ error: "unknown_vault" }, 404)).port.get(addr(1)));
		assert.equal(unknownVault.code, "unknown_vault");
		assert.equal((await rejection(blob(() => "network").port.get(addr(1)))).code, "network_error");
	});

	it("probeHttpBlob follows capabilities.attachments", async () => {
		const off = fakeFetch(() => jsonResponse({ claimed: true, attachments: false, maxBlobUploadBytes: 10 }));
		assert.equal(await probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: off.fetch }), null);
		assert.equal(off.requests[0]!.url.pathname, "/api/capabilities");
		const on = fakeFetch(() => jsonResponse({ claimed: true, attachments: true, maxBlobUploadBytes: 1234 }));
		const port = await probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: on.fetch });
		assert.equal(port?.maxBlobBytes, 1234);
		await rejection(probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: fakeFetch(() => "network").fetch }));
	});

	it("list() walks pages by the last address and validates their order", async () => {
		const { port, requests } = blob((req) => {
			const cursor = req.url.searchParams.get("cursor");
			if (cursor === null) return jsonResponse({ items: [{ address: addr(1), uploadedAt: 10 }, { address: addr(2), uploadedAt: 20 }], next: addr(2) });
			return jsonResponse({ items: [{ address: addr(3), uploadedAt: 30 }], next: null });
		});
		const first = await port.list(null);
		assert.deepEqual(first, { items: [{ address: addr(1), uploadedAt: 10 }, { address: addr(2), uploadedAt: 20 }], next: addr(2) });
		assert.deepEqual(await port.list(first.next), { items: [{ address: addr(3), uploadedAt: 30 }], next: null });
		assert.equal(requests[0]!.url.pathname, "/vault/v1/blobs");
		assert.equal(requests[0]!.url.search, "");
		assert.equal(requests[1]!.url.searchParams.get("cursor"), addr(2));
		assert.equal(requests[1]!.headers.get("authorization"), `Bearer ${TOKEN}`);
		for (const bad of [
			{ items: [{ address: addr(2), uploadedAt: 1 }, { address: addr(1), uploadedAt: 1 }], next: null },
			{ items: [{ address: "nothex", uploadedAt: 1 }], next: null },
			{ items: [{ address: addr(1), uploadedAt: -1 }], next: null },
			{ items: [], next: addr(5) },
			{ items: [{ address: addr(1), uploadedAt: 1 }] },
		]) {
			const e = await rejection(blob(() => jsonResponse(bad)).port.list(addr(5)));
			assert.equal(e.code, "malformed_response");
		}
	});

	it("deleteIfUploadedBefore() posts one batch and returns results in request order", async () => {
		const { port, requests } = blob((req) => {
			const body = JSON.parse(String(req.body)) as { ifUploadedBefore: number; addresses: string[] };
			return jsonResponse({ results: body.addresses.map((address, i) =>
				i === 0 ? { address, result: "deleted", uploadedAt: 5 } : i === 1 ? { address, result: "newer", uploadedAt: 99 } : { address, result: "absent" }) });
		});
		const out = await port.deleteIfUploadedBefore([addr(1), addr(2), addr(3)], 50);
		assert.deepEqual(out, [
			{ address: addr(1), result: "deleted", uploadedAt: 5 },
			{ address: addr(2), result: "newer", uploadedAt: 99 },
			{ address: addr(3), result: "absent" },
		]);
		assert.equal(requests[0]!.method, "POST");
		assert.equal(requests[0]!.url.pathname, "/vault/v1/blobs/delete");
		assert.deepEqual(JSON.parse(String(requests[0]!.body)), { ifUploadedBefore: 50, addresses: [addr(1), addr(2), addr(3)] });
		// Local checks: nothing sent.
		for (const p of [
			port.deleteIfUploadedBefore([], 50),
			port.deleteIfUploadedBefore(Array.from({ length: 101 }, (_v, i) => addr(i)), 50),
			port.deleteIfUploadedBefore([addr(1), addr(1)], 50),
			port.deleteIfUploadedBefore([addr(1)], -1),
		]) await rejection(p);
		assert.equal(requests.length, 1);
		const swapped = blob((req) => {
			const body = JSON.parse(String(req.body)) as { addresses: string[] };
			return jsonResponse({ results: body.addresses.reverse().map((address) => ({ address, result: "absent" })) });
		});
		assert.equal((await rejection(swapped.port.deleteIfUploadedBefore([addr(1), addr(2)], 1))).code, "malformed_response");
	});

	it("GC routes retry 429/503 after Retry-After, bounded, and give up on a missing or long one", async () => {
		let calls = 0;
		const limited = blob(() => (++calls <= 2
			? jsonResponse({ error: calls === 1 ? "too_many_attempts" : "list_incomplete" }, calls === 1 ? 429 : 503, { "Retry-After": String(calls * 3) })
			: jsonResponse({ items: [], next: null })));
		assert.deepEqual(await limited.port.list(null), { items: [], next: null });
		assert.deepEqual(limited.waits, [3000, 6000]);
		assert.equal(limited.requests.length, 3);

		const forever = blob(() => jsonResponse({ error: "too_many_attempts" }, 429, { "Retry-After": "1" }));
		const exhausted = await rejection(forever.port.deleteIfUploadedBefore([addr(1)], 5));
		assert.deepEqual([exhausted.status, exhausted.code, exhausted.retryAfterMs], [429, "too_many_attempts", 1000]);
		assert.equal(forever.requests.length, GC_RETRY_ATTEMPTS);

		const bare = blob(() => jsonResponse({ error: "attachments_unavailable" }, 503));
		assert.equal((await rejection(bare.port.list(null))).code, "attachments_unavailable");
		assert.equal(bare.requests.length, 1);
		const long = blob(() => jsonResponse({ error: "too_many_attempts" }, 429, { "Retry-After": "3600" }));
		assert.equal((await rejection(long.port.list(null))).retryAfterMs, 3_600_000);
		assert.equal(long.requests.length, 1);
	});

	it("an aborted signal stops a GC call before it is sent and during a Retry-After wait", async () => {
		const ctl = new AbortController();
		ctl.abort();
		const idle = blob(() => jsonResponse({ items: [], next: null }));
		assert.equal((await rejection(idle.port.list(null, ctl.signal))).code, "aborted");
		assert.equal(idle.requests.length, 0);

		const waiting = new AbortController();
		const clock = new ManualClock();
		const f = fakeFetch(() => jsonResponse({ error: "too_many_attempts" }, 429, { "Retry-After": "30" }));
		const port = createHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: f.fetch, clock });
		const pending = port.deleteIfUploadedBefore([addr(1)], 5, waiting.signal);
		while (clock.pendingTimers === 0) await new Promise((r) => setImmediate(r));
		waiting.abort();
		assert.equal((await rejection(pending)).code, "aborted");
		assert.equal(clock.pendingTimers, 0, "the wait's timer is cleared");
		assert.equal(f.requests.length, 1);
	});
});
