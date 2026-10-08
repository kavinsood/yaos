import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import type { ClockPort } from "../../ports/clock";
import { MAX_BLOB_UPLOAD_BYTES } from "../../core/limits";
import { BlobTooLargeError } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { RELAY_HTTP_BASE_MS, relayHttpDeadlineMs } from "../../core/deadline";
import {
	BLOB_DELETE_CALL_BYTES, BLOB_EXISTS_BATCH, BLOB_LIST_REPLY_BYTES, CAPABILITIES_TIMEOUT_MS, createHttpBlob, GC_RETRY_ATTEMPTS, probeHttpBlob,
	startupBlob,
} from "./httpBlob";
import { RelayHttpError } from "./relayHttp";
import { fakeFetch, fakeXhrs, jsonResponse, ManualClock, routedXhr, type FakeRequest, type FakeXhr } from "./relayTestFakes";

const TOKEN = "device-token-SECRET";
const addr = (i: number) => i.toString(16).padStart(64, "0") as BlobAddress;
/** The idle window of the tests that drive it on a ManualClock. */
const IDLE = 1_000;
/** The idle window of the tests on instantClock, which never fires it. */
const NEVER = Number.MAX_SAFE_INTEGER;

/**
 * A clock whose timers fire at once, recording their delays; the NEVER idle window and the GC calls' deadlines
 * (RELAY_HTTP_BASE_MS and more; the Retry-After waits here are shorter) are neither fired nor recorded.
 */
function instantClock(waits: number[]): ClockPort {
	return {
		now: () => 0, monotonic: () => 0, yieldNow: async () => undefined, clearTimer: () => undefined,
		setTimer: (ms, fn) => {
			if (ms === NEVER || ms >= RELAY_HTTP_BASE_MS) return 0;
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
		port: createHttpBlob({
			baseUrl: "https://r.example/", vaultId: "v1", credential: TOKEN, fetch: f.fetch, xhr: routedXhr(route, f.requests),
			clock: instantClock(waits), idleMs: NEVER,
		}),
		requests: f.requests,
		waits,
	};
}

/** Lets pending promise callbacks run (a fetch fake's async body, a probe's continuation). */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setImmediate(r));
}

async function rejection(p: Promise<unknown>): Promise<RelayHttpError> {
	try {
		await p;
	} catch (error) {
		assert.ok(error instanceof RelayHttpError, String(error));
		assert.ok(!error.message.includes(TOKEN));
		return error;
	}
	assert.fail("expected a rejection");
}

/** Lets pending I/O callbacks and promise jobs run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/** Tracks whether `p` settled, without leaving its rejection unhandled. */
function track<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
	let settled = false;
	p.then(() => { settled = true; }, () => { settled = true; });
	return { p, settled: () => settled };
}

/** A body stream the test feeds; `cancels` counts cancellations. */
function feed(): { stream: ReadableStream<Uint8Array>; push: (b: number[]) => void; end: () => void; cancels: () => number } {
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; }, cancel() { cancels++; } });
	return { stream, push: (b) => ctrl.enqueue(new Uint8Array(b)), end: () => ctrl.close(), cancels: () => cancels };
}

/** A fetch that answers only when the test says so, and rejects when its signal aborts (as fetch does). */
function hangingFetch(): typeof fetch {
	return (_input, init) => new Promise((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
	});
}

function xhrPort(Ctor: typeof XMLHttpRequest, clock: ClockPort) {
	return createHttpBlob({ baseUrl: "https://r.example/", vaultId: "v1", credential: TOKEN, xhr: Ctor, clock, idleMs: IDLE });
}

function getPort(f: typeof fetch, clock: ClockPort, maxBlobBytes?: number) {
	return createHttpBlob({ baseUrl: "https://r.example/", vaultId: "v1", credential: TOKEN, fetch: f, clock, idleMs: IDLE, maxBlobBytes });
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

	it("put sends the parts as one Blob body over XMLHttpRequest (no BufferSource to copy again), bytes in order", async () => {
		const { xhrs, Ctor } = fakeXhrs((x) => queueMicrotask(() => {
			x.sent(x.body!.size);
			x.uploaded();
			x.respond(204);
		}));
		const clock = new ManualClock();
		const port = xhrPort(Ctor, clock);
		const parts = [new Uint8Array([1, 2, 3]), new Uint8Array(new ArrayBuffer(8), 2, 4).fill(9), new Uint8Array(0)];
		await port.put(addr(1), parts);
		await port.put(addr(1), parts); // a retry re-reads the same parts
		assert.equal(xhrs.length, 2);
		for (const x of xhrs) {
			assert.equal(x.method, "PUT");
			assert.equal(x.url, `https://r.example/vault/v1/blobs/${addr(1)}`);
			assert.equal(x.headers.get("authorization"), `Bearer ${TOKEN}`);
			assert.equal(x.headers.get("content-type"), "application/octet-stream");
			assert.ok(x.body instanceof Blob);
			assert.equal(x.body.size, 7);
			assert.deepEqual(new Uint8Array(await x.body.arrayBuffer()), new Uint8Array([1, 2, 3, 9, 9, 9, 9]));
			assert.equal(x.aborts, 0);
			assert.equal(x.onload, null, "handlers are dropped once the put settles");
		}
		assert.equal(clock.pendingTimers, 0, "the idle timer is cleared");
	});

	it("put: any other status carries the JSON error code; a lost connection is network_error; no XMLHttpRequest is unsupported", async () => {
		const internal = await rejection(blob(() => jsonResponse({ error: "internal" }, 500)).port.put(addr(1), [new Uint8Array(1)]));
		assert.deepEqual([internal.status, internal.code], [500, "internal"]);
		const html = await rejection(blob(() => new Response("<html>bad gateway</html>", { status: 502 })).port.put(addr(1), [new Uint8Array(1)]));
		assert.deepEqual([html.status, html.code], [502, null]);
		const lost = await rejection(blob(() => "network").port.put(addr(1), [new Uint8Array(1)]));
		assert.deepEqual([lost.status, lost.code], [0, "network_error"]);

		assert.equal((globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest, undefined, "node has none");
		const f = fakeFetch(() => new Response(null, { status: 204 }));
		const bare = createHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: f.fetch });
		const unsupported = await rejection(bare.put(addr(1), [new Uint8Array(1)]));
		assert.deepEqual([unsupported.status, unsupported.code], [0, "unsupported"]);
		assert.equal(f.requests.length, 0, "no fetch fallback");
	});

	it("put: the caller's signal aborts the request at once, before or during the upload", async () => {
		const { xhrs, Ctor } = fakeXhrs();
		const clock = new ManualClock();
		const port = xhrPort(Ctor, clock);
		const before = new AbortController();
		before.abort();
		assert.equal((await rejection(port.put(addr(1), [new Uint8Array(10)], before.signal))).code, "aborted");
		assert.equal(xhrs.length, 0, "nothing sent");

		const ctl = new AbortController();
		const p = port.put(addr(1), [new Uint8Array(10)], ctl.signal);
		const x = xhrs[0]!;
		assert.equal(getEventListeners(ctl.signal, "abort").length, 1);
		x.sent(5);
		ctl.abort();
		const e = await rejection(p);
		assert.deepEqual([e.status, e.code], [0, "aborted"]);
		assert.equal(x.aborts, 1, "the request is aborted");
		assert.equal(clock.pendingTimers, 0);
		assert.equal(getEventListeners(ctl.signal, "abort").length, 0, "the listener is removed");
	});

	it("put: an upload that moves no byte for the idle window is aborted as stalled", async () => {
		const { xhrs, Ctor } = fakeXhrs();
		const clock = new ManualClock();
		const ctl = new AbortController();
		const p = track(xhrPort(Ctor, clock).put(addr(1), [new Uint8Array(10)], ctl.signal));
		const x = xhrs[0]!;
		clock.advance(IDLE - 1);
		x.sent(4); // progress restarts the window
		clock.advance(IDLE - 1);
		await flush();
		assert.equal(x.aborts, 0);
		assert.equal(p.settled(), false);
		clock.advance(1);
		assert.equal(x.aborts, 1);
		const e = await rejection(p.p);
		assert.deepEqual([e.status, e.code], [0, "stalled"]);
		assert.equal(clock.pendingTimers, 0);
		assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
		x.respond(204); // a late event changes nothing
	});

	it("put: an upload that keeps moving is never cut, however long it takes", async () => {
		const { xhrs, Ctor } = fakeXhrs();
		const clock = new ManualClock();
		const p = track(xhrPort(Ctor, clock).put(addr(1), [new Uint8Array(100)]));
		const x = xhrs[0]!;
		for (let i = 1; i <= 100; i++) {
			clock.advance(IDLE - 1);
			x.sent(i); // 100 progress events, ~100 idle windows in all
		}
		clock.advance(IDLE - 1);
		x.uploaded();
		clock.advance(IDLE - 1); // the relay writes the object
		x.respond(204);
		await p.p;
		assert.equal(x.aborts, 0);
		assert.equal(clock.pendingTimers, 0);
	});

	it("put / get hand the caller's observer each upload progress event and each body chunk (the device check counts them)", async () => {
		const { xhrs, Ctor } = fakeXhrs();
		const clock = new ManualClock();
		const sent: number[] = [];
		const put = xhrPort(Ctor, clock).put(addr(1), [new Uint8Array(10)], undefined, (n) => sent.push(n));
		const x = xhrs[0]!;
		x.sent(4);
		x.sent(10);
		x.uploaded();
		x.respond(204);
		await put;
		assert.deepEqual(sent, [4, 10], "upload progress events only, not the upload's end or readyState changes");
		const body = feed();
		const chunks: number[] = [];
		const get = getPort(fakeFetch(() => new Response(body.stream, { status: 200, headers: { "Content-Length": "5" } })).fetch, clock).get(addr(1), undefined, (n) => chunks.push(n));
		await flush();
		body.push([1, 2]);
		await flush();
		body.push([3, 4, 5]);
		body.end();
		assert.deepEqual(await get, new Uint8Array([1, 2, 3, 4, 5]));
		assert.deepEqual(chunks, [2, 3]);
		assert.equal(clock.pendingTimers, 0);
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
		// No usable length, or an encoded body: the chunks, joined once, their total held to the cap.
		assert.deepEqual(await get(() => body([[7], [8, 9]], {})), new Uint8Array([7, 8, 9]));
		assert.deepEqual(await get(() => body([[7], [8, 9]], { "Content-Length": "2", "Content-Encoding": "gzip" })), new Uint8Array([7, 8, 9]));
		assert.deepEqual(await get(() => body([], {})), new Uint8Array(0));
		assert.deepEqual(await get(() => body([[1, 2], [3]], {}), 3), new Uint8Array([1, 2, 3]), "exactly the cap");
		for (const headers of [{}, { "Content-Length": "x" }, { "Content-Length": "2", "Content-Encoding": "gzip" }] as Record<string, string>[]) {
			const over = { n: 0 };
			const e = await rejection(get(() => body([[1, 2], [3, 4], [5]], headers, over), 3));
			assert.deepEqual([e.status, e.code], [200, "malformed_response"]);
			assert.equal(over.n, 1, "the rest of the stream is cancelled");
		}
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

	it("get: a body that stops for the idle window is stalled; one that keeps moving is read whole", async () => {
		const clock = new ManualClock();
		const stopped = feed();
		const stall = track(getPort(fakeFetch(() => new Response(stopped.stream, { status: 200, headers: { "Content-Length": "10" } })).fetch, clock).get(addr(1)));
		await flush();
		stopped.push([1, 2, 3, 4]);
		await flush();
		clock.advance(IDLE - 1);
		await flush();
		assert.equal(stall.settled(), false);
		clock.advance(1);
		const e = await rejection(stall.p);
		assert.deepEqual([e.status, e.code], [0, "stalled"]);
		assert.equal(stopped.cancels(), 1, "the body is cancelled");
		assert.equal(clock.pendingTimers, 0);

		// Time to headers counts too.
		const headers = track(getPort(hangingFetch(), clock).get(addr(1)));
		clock.advance(IDLE - 1);
		await flush();
		assert.equal(headers.settled(), false);
		clock.advance(1);
		assert.equal((await rejection(headers.p)).code, "stalled");

		for (const lengthHeader of [{ "Content-Length": "30" }, {}] as Record<string, string>[]) {
			const moving = feed();
			const ctl = new AbortController();
			const p = getPort(fakeFetch(() => new Response(moving.stream, { status: 200, headers: lengthHeader })).fetch, clock).get(addr(1), ctl.signal);
			await flush();
			for (let i = 0; i < 30; i++) {
				moving.push([i]);
				await flush();
				clock.advance(IDLE - 1); // 30 chunks, ~30 idle windows
			}
			moving.end();
			assert.deepEqual(await p, Uint8Array.from({ length: 30 }, (_v, i) => i));
			assert.equal(clock.pendingTimers, 0);
			assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
		}
	});

	it("get: the caller's signal aborts it at once, before the request, waiting for headers, or mid-body", async () => {
		const clock = new ManualClock();
		const before = new AbortController();
		before.abort();
		const unsent = fakeFetch(() => new Response(new Uint8Array(1)));
		assert.equal((await rejection(getPort(unsent.fetch, clock).get(addr(1), before.signal))).code, "aborted");
		assert.equal(unsent.requests.length, 0);

		const waiting = new AbortController();
		const p = getPort(hangingFetch(), clock).get(addr(1), waiting.signal);
		waiting.abort();
		assert.deepEqual([(await rejection(p)).code, clock.pendingTimers], ["aborted", 0]);

		const body = feed();
		const ctl = new AbortController();
		const mid = getPort(fakeFetch(() => new Response(body.stream, { status: 200, headers: { "Content-Length": "10" } })).fetch, clock).get(addr(1), ctl.signal);
		await flush();
		body.push([1, 2]);
		await flush();
		ctl.abort();
		const e = await rejection(mid);
		assert.deepEqual([e.status, e.code], [0, "aborted"]);
		assert.equal(body.cancels(), 1);
		assert.equal(clock.pendingTimers, 0);
		assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
	});

	it("has(): a batch that stalls (headers or body) is stalled; the caller's signal aborts it", async () => {
		const clock = new ManualClock();
		const headers = track(getPort(hangingFetch(), clock).has([addr(1)]));
		clock.advance(IDLE - 1);
		await flush();
		assert.equal(headers.settled(), false);
		clock.advance(1);
		assert.deepEqual([(await rejection(headers.p)).code, clock.pendingTimers], ["stalled", 0]);

		// The body never ends; aborting the fetch errors it, as fetch does.
		const stalledBody: typeof fetch = async (_input, init) => {
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode('{"present":['));
					init?.signal?.addEventListener("abort", () => c.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
				},
			});
			return new Response(stream, { status: 200 });
		};
		const body = track(getPort(stalledBody, clock).has([addr(1)]));
		await flush();
		clock.advance(IDLE - 1);
		await flush();
		assert.equal(body.settled(), false);
		clock.advance(1);
		assert.deepEqual([(await rejection(body.p)).code, clock.pendingTimers], ["stalled", 0]);

		const ctl = new AbortController();
		const aborted = getPort(hangingFetch(), clock).has([addr(1)], ctl.signal);
		ctl.abort();
		assert.deepEqual([(await rejection(aborted)).code, clock.pendingTimers], ["aborted", 0]);
		assert.equal(getEventListeners(ctl.signal, "abort").length, 0);

		const notJson = await rejection(getPort(fakeFetch(() => new Response("<html>", { status: 200 })).fetch, clock).has([addr(1)]));
		assert.deepEqual([notJson.status, notJson.code], [200, "malformed_response"]);
	});

	it("a fetch or body that ignores its abort still ends at the idle window (untilAborted)", async () => {
		const clock = new ManualClock();
		const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
		// A reply whose body neither ends nor honours cancel / abort.
		const deafBody = { getReader: () => ({ read: () => never(), cancel: async () => undefined }) };
		const deafReply = (headers: Record<string, string>) =>
			({ status: 200, headers: new Headers(headers), body: deafBody, json: () => never(), text: () => never() }) as unknown as Response;
		const cases: [string, typeof fetch, (port: ReturnType<typeof getPort>, signal?: AbortSignal) => Promise<unknown>][] = [
			["get, headers", () => never(), (port, s) => port.get(addr(1), s)],
			["get, body", async () => deafReply({ "Content-Length": "10" }), (port, s) => port.get(addr(1), s)],
			["has, headers", () => never(), (port, s) => port.has([addr(1)], s)],
			["has, body", async () => deafReply({}), (port, s) => port.has([addr(1)], s)],
		];
		for (const [name, f, call] of cases) {
			const stalled = track(call(getPort(f, clock)));
			await flush();
			clock.advance(IDLE - 1);
			await flush();
			assert.equal(stalled.settled(), false, name);
			clock.advance(1);
			assert.deepEqual([(await rejection(stalled.p)).code, clock.pendingTimers], ["stalled", 0], name);

			const ctl = new AbortController();
			const aborted = call(getPort(f, clock), ctl.signal);
			await flush();
			ctl.abort();
			assert.deepEqual([(await rejection(aborted)).code, clock.pendingTimers], ["aborted", 0], name);
		}
	});

	it("an error reply's body is read within the transfer: a 404 whose body stalls is stalled, never \"absent\"", async () => {
		const clock = new ManualClock();
		const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
		const deafError = (status: number) => async () => ({ status, headers: new Headers(), body: null, json: () => never() }) as unknown as Response;
		const cases: [string, typeof fetch, (port: ReturnType<typeof getPort>) => Promise<unknown>][] = [
			["get 404", deafError(404), (port) => port.get(addr(1))],
			["get 500", deafError(500), (port) => port.get(addr(1))],
			["has 500", deafError(500), (port) => port.has([addr(1)])],
		];
		for (const [name, f, call] of cases) {
			const stalled = track(call(getPort(f, clock)));
			await flush();
			clock.advance(IDLE - 1);
			await flush();
			assert.equal(stalled.settled(), false, name);
			clock.advance(1);
			assert.deepEqual([(await rejection(stalled.p)).code, clock.pendingTimers], ["stalled", 0], name);
		}
		// A 404 whose body is whole: "not found" (or not JSON) is absent; another code is the error it names.
		assert.equal(await getPort(fakeFetch(() => jsonResponse({ error: "not found" }, 404)).fetch, clock).get(addr(1)), null);
		assert.equal(await getPort(fakeFetch(() => new Response("<html>", { status: 404 })).fetch, clock).get(addr(1)), null);
		assert.equal((await rejection(getPort(fakeFetch(() => jsonResponse({ error: "unknown_vault" }, 404)).fetch, clock).get(addr(1)))).code, "unknown_vault");
		// A body cut off mid-way is a transport error, not a missing code.
		const cut: typeof fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"err')); c.error(new TypeError("terminated")); } }), { status: 404 });
		assert.equal((await rejection(getPort(cut, clock).get(addr(1)))).code, "network_error");
	});

	it("GC calls (list, delete) end at their deadline, headers or body, even when the fetch ignores its abort; the caller's signal ends them at once", async () => {
		// Sized from what each call moves (httpBlob.ts BLOB_GC_ITEM_WIRE_BYTES): a 1000-item page; 100 addresses and results.
		assert.equal(relayHttpDeadlineMs(BLOB_LIST_REPLY_BYTES), 17_016);
		assert.equal(relayHttpDeadlineMs(BLOB_DELETE_CALL_BYTES), 15_454);
		const clock = new ManualClock();
		const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
		const deafBody = async () => ({ status: 200, headers: new Headers(), body: null, json: () => never() }) as unknown as Response;
		const gcPort = (f: typeof fetch) => createHttpBlob({ baseUrl: "https://r.example/", vaultId: "v1", credential: TOKEN, fetch: f, clock });
		const cases: [string, typeof fetch, number, (port: ReturnType<typeof gcPort>, signal?: AbortSignal) => Promise<unknown>][] = [
			["list, headers", () => never(), relayHttpDeadlineMs(BLOB_LIST_REPLY_BYTES), (port, s) => port.list(null, s)],
			["list, body", deafBody, relayHttpDeadlineMs(BLOB_LIST_REPLY_BYTES), (port, s) => port.list(null, s)],
			["delete, headers", () => never(), relayHttpDeadlineMs(BLOB_DELETE_CALL_BYTES), (port, s) => port.deleteIfUploadedBefore([addr(1)], 5, s)],
			["delete, body", deafBody, relayHttpDeadlineMs(BLOB_DELETE_CALL_BYTES), (port, s) => port.deleteIfUploadedBefore([addr(1)], 5, s)],
		];
		for (const [name, f, deadline, call] of cases) {
			const hung = track(call(gcPort(f)));
			await flush();
			clock.advance(deadline - 1);
			await flush();
			assert.equal(hung.settled(), false, name);
			clock.advance(1);
			const e = await rejection(hung.p);
			assert.deepEqual([e.status, e.code, clock.pendingTimers], [0, "timeout", 0], name);

			const ctl = new AbortController();
			const aborted = call(gcPort(f), ctl.signal);
			await flush();
			ctl.abort();
			assert.deepEqual([(await rejection(aborted)).code, clock.pendingTimers], ["aborted", 0], name);
			assert.equal(getEventListeners(ctl.signal, "abort").length, 0, name);
		}
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

	it("probeHttpBlob gives up at CAPABILITIES_TIMEOUT_MS on a reply that never comes (headers or body), signal aborted", async () => {
		// The fetches ignore their signal: the deadline must hold anyway. Engine init awaits this probe.
		const never = new Promise<Response>(() => undefined);
		const stalledBody = () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
		for (const stage of ["headers", "body"] as const) {
			const clock = new ManualClock();
			let signal: AbortSignal | null = null;
			const fetchImpl: typeof fetch = async (_input, init) => {
				signal = init?.signal ?? null;
				return stage === "headers" ? never : stalledBody();
			};
			let settled = false;
			const p = probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: fetchImpl, clock });
			void p.then(() => { settled = true; }, () => { settled = true; });
			await settle();
			clock.advance(CAPABILITIES_TIMEOUT_MS - 1);
			await settle();
			assert.equal(settled, false, `${stage}: still waiting just before the deadline`);
			clock.advance(1);
			const e = await rejection(p);
			assert.deepEqual([e.status, e.code], [0, "timeout"], stage);
			assert.equal((signal as AbortSignal | null)?.aborted, true, `${stage}: the request is aborted`);
			assert.equal(clock.pendingTimers, 0, stage);
		}
		const clock = new ManualClock();
		await probeHttpBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, clock,
			fetch: fakeFetch(() => jsonResponse({ attachments: true })).fetch });
		assert.equal(clock.pendingTimers, 0, "an answered probe clears its deadline");
	});

	it("startupBlob: capabilities never answer -> the store is assumed after the deadline (init goes on), logged without secrets", async () => {
		const clock = new ManualClock();
		const lines: string[] = [];
		const requests: string[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			requests.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
			return new Promise<Response>(() => undefined);
		};
		const p = startupBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, fetch: fetchImpl, clock }, (l) => lines.push(l));
		await settle();
		clock.advance(CAPABILITIES_TIMEOUT_MS);
		const port = await p;
		assert.ok(port, "a store is assumed (the blob queue retries), as on an offline start");
		assert.deepEqual(requests, ["GET /api/capabilities"]);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /capabilities.*timeout/);
		assert.ok(!lines[0]!.includes(TOKEN));
		const off = await startupBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, clock,
			fetch: fakeFetch(() => jsonResponse({ attachments: false })).fetch });
		assert.equal(off, null, "a relay without attachments still means no store");
		assert.ok(await startupBlob({ baseUrl: "https://r.example", vaultId: "v1", credential: TOKEN, clock, fetch: fakeFetch(() => "network").fetch }),
			"offline start: the store is assumed");
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
