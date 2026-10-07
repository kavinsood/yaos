import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64ToBytes, bytesToBase64, createRelayHttp, dailyResetDelayMs, parseRetryAfter, RelayHttpError } from "./relayHttp";
import { fakeFetch, jsonResponse, ManualClock, type FakeRequest } from "./relayTestFakes";

const TOKEN = "device-token-SECRET-abc123";
const BASE = "https://relay.example/";

function client(route: (req: FakeRequest) => Response | "network") {
	const f = fakeFetch(route);
	const clock = new ManualClock();
	return { http: createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: f.fetch, clock }), requests: f.requests, clock };
}

async function rejection(p: Promise<unknown>): Promise<RelayHttpError> {
	try {
		await p;
	} catch (error) {
		assert.ok(error instanceof RelayHttpError, `expected RelayHttpError, got ${String(error)}`);
		assert.ok(!error.message.includes(TOKEN), "token leaked into the message");
		assert.ok(!JSON.stringify(error).includes(TOKEN), "token leaked into the error fields");
		return error;
	}
	assert.fail("expected a rejection");
}

describe("relayHttp helpers", () => {
	it("parseRetryAfter: seconds, HTTP-date, junk", () => {
		assert.equal(parseRetryAfter(null, 0), null);
		assert.equal(parseRetryAfter("", 0), null);
		assert.equal(parseRetryAfter("120", 0), 120_000);
		const now = Date.parse("2026-10-05T00:00:00Z");
		assert.equal(parseRetryAfter("Mon, 05 Oct 2026 00:00:30 GMT", now), 30_000);
		assert.equal(parseRetryAfter("Mon, 04 Oct 2026 00:00:30 GMT", now), 0);
		assert.equal(parseRetryAfter("soon", now), null);
	});

	it("dailyResetDelayMs: at most a day whatever the device clock says; null when already past", () => {
		const reset = Date.parse("2026-10-06T00:00:00Z");
		assert.equal(dailyResetDelayMs(reset, reset - 60_000), 60_000);
		assert.equal(dailyResetDelayMs(reset, reset - 3 * 86_400_000), 86_400_000, "slow clock");
		assert.equal(dailyResetDelayMs(reset, reset + 5_000), null, "fast clock");
	});

	it("base64 round-trips binary and large inputs", () => {
		const small = new Uint8Array([0, 255, 1, 128, 64]);
		assert.deepEqual(base64ToBytes(bytesToBase64(small)), small);
		const big = new Uint8Array(200_000).map((_v, i) => (i * 7) & 0xff);
		assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
		assert.equal(bytesToBase64(new Uint8Array([104, 105])), "aGk=");
	});
});

describe("relayHttp ticket", () => {
	it("POSTs {purpose:streams} with the bearer token", async () => {
		const { http, requests } = client(() => jsonResponse({ ticket: "T1", expiresAt: 1, ttlMs: 300000 }));
		assert.deepEqual(await http.ticket("v/1"), { ok: true, ticket: "T1" });
		const req = requests[0]!;
		assert.equal(req.method, "POST");
		assert.equal(req.url.href, "https://relay.example/vault/v%2F1/auth/ticket");
		assert.equal(req.headers.get("authorization"), `Bearer ${TOKEN}`);
		assert.deepEqual(JSON.parse(String(req.body)), { purpose: "streams" });
		assert.ok(!req.url.href.includes(TOKEN));
	});

	it("maps every failure", async () => {
		const cases: [Response | "network", string, number | null][] = [
			[jsonResponse({ error: "unauthorized" }, 401), "unauthorized", null],
			[jsonResponse({ error: "forbidden" }, 403), "unauthorized", null],
			[jsonResponse({ error: "not found" }, 404), "not-found", null],
			[jsonResponse({ error: "unclaimed" }, 503), "unclaimed", null],
			[jsonResponse({ error: "authority_superseded" }, 409), "superseded", null],
			[jsonResponse({ error: "vault_deleting" }, 409), "unavailable", null],
			[jsonResponse({ error: "cf_daily_limit", resetAt: 0 }, 503, { "retry-after": "90" }), "daily-limit", 90_000],
			[jsonResponse({ error: "invalid_ticket_scope" }, 400), "update-required", null],
			[jsonResponse({ error: "upgrade" }, 426), "update-required", null],
			[jsonResponse({ error: "busy" }, 429, { "retry-after": "1" }), "unavailable", 1000],
			[jsonResponse({ error: "boom" }, 500), "unavailable", null],
			[jsonResponse({ error: "draining" }, 503), "unavailable", null],
			[new Response("<html>bad gateway</html>", { status: 502 }), "unavailable", null],
			[jsonResponse({ nope: 1 }, 200), "unavailable", null],
			["network", "unavailable", null],
		];
		for (const [response, reason, retryAfterMs] of cases) {
			const { http } = client(() => response);
			assert.deepEqual(await http.ticket("v1"), { ok: false, reason, retryAfterMs }, `case ${reason}`);
		}
	});

	it("its signal aborting ends a ticket stalled on headers or body -> unavailable, even when the fetch ignores the signal", async () => {
		const stalledBody = () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
		for (const stage of ["headers", "body"] as const) {
			const signals: (AbortSignal | null)[] = [];
			const fetchImpl: typeof fetch = async (_input, init) => {
				signals.push(init?.signal ?? null);
				return stage === "headers" ? new Promise<Response>(() => undefined) : stalledBody();
			};
			const http = createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: fetchImpl });
			const abort = new AbortController();
			const p = http.ticket("v1", abort.signal);
			await new Promise((r) => setImmediate(r));
			abort.abort();
			assert.deepEqual(await p, { ok: false, reason: "unavailable", retryAfterMs: null }, stage);
			assert.equal(signals[0], abort.signal, `${stage}: the signal reaches the fetch`);
		}
		const { http } = client(() => jsonResponse({ ticket: "T1" }));
		assert.deepEqual(await http.ticket("v1", new AbortController().signal), { ok: true, ticket: "T1" });
	});

	it("daily-limit without Retry-After falls back to resetAt", async () => {
		let clock: ManualClock | null = null;
		const c = client(() => jsonResponse({ error: "cf_daily_limit", resetAt: clock!.now() + 5000 }, 503));
		clock = c.clock;
		assert.deepEqual(await c.http.ticket("v1"), { ok: false, reason: "daily-limit", retryAfterMs: 5000 });
	});
});

describe("relayHttp feed", () => {
	it("maps a middle page and a last page", async () => {
		const pages = [
			{ vaultEpoch: "E", head: 57, changes: [{ stream: "ns", lastSeq: 41 }, { stream: "b:x", lastSeq: 50 }], nextAfter: 50 },
			{ vaultEpoch: "E", head: 57, changes: [{ stream: "b:y", lastSeq: 57 }], nextAfter: null },
		];
		const { http, requests } = client(() => jsonResponse(pages.shift()));
		assert.deepEqual(await http.feed("v1", 0, 2), {
			entries: [{ stream: "ns", lastSeq: 41 }, { stream: "b:x", lastSeq: 50 }], throughSeq: 50, headSeq: 57, more: true,
		});
		assert.deepEqual(await http.feed("v1", 50, null), { entries: [{ stream: "b:y", lastSeq: 57 }], throughSeq: 57, headSeq: 57, more: false });
		assert.equal(requests[0]!.url.pathname, "/vault/v1/streams/feed");
		assert.equal(requests[0]!.url.search, "?after=0&limit=2");
		assert.equal(requests[1]!.url.search, "?after=50");
		assert.equal(requests[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
	});

	it("throws typed errors without secrets", async () => {
		let e = await rejection(client(() => jsonResponse({ error: "invalid_cursor" }, 400)).http.feed("v1", -1, null));
		assert.deepEqual([e.status, e.code, e.retryAfterMs], [400, "invalid_cursor", null]);
		e = await rejection(client(() => jsonResponse({ error: "cf_daily_limit", resetAt: 0 }, 503, { "retry-after": "7" })).http.feed("v1", 0, null));
		assert.deepEqual([e.status, e.code, e.retryAfterMs], [503, "cf_daily_limit", 7000]);
		e = await rejection(client(() => "network").http.feed("v1", 0, null));
		assert.deepEqual([e.status, e.code], [0, "network_error"]);
		e = await rejection(client(() => jsonResponse({ head: 1, changes: "x", nextAfter: null })).http.feed("v1", 0, null));
		assert.deepEqual([e.status, e.code], [200, "malformed_response"]);
		e = await rejection(client(() => jsonResponse({ error: "unauthorized" }, 401)).http.feed("v1", 0, null));
		assert.match(e.message, /feed failed: HTTP 401 unauthorized/);
	});
});

describe("relayHttp read", () => {
	const b64 = (...v: number[]) => bytesToBase64(new Uint8Array(v));

	it("decodes rows and the checkpoint; passes maxBytes and checkpoint=1", async () => {
		const { http, requests } = client(() => jsonResponse({
			vaultEpoch: "E", head: 57, stream: "b:x", lastSeq: 57, checkpointSeq: 50, gcSeq: 44,
			checkpoint: { coversSeq: 50, bytes: b64(1, 2, 3) },
			rows: [{ seq: 53, deviceId: "d1", clientFrameId: "c1", payload: b64(9) }],
			nextAfter: 53,
		}));
		const page = await http.read("v1", "b:x y", 0, true, 4096);
		assert.deepEqual(page, {
			checkpoint: { coversSeq: 50, bytes: new Uint8Array([1, 2, 3]) },
			rows: [{ seq: 53, deviceId: "d1", clientFrameId: "c1", payload: new Uint8Array([9]) }],
			lastSeq: 57, checkpointSeq: 50, gcSeq: 44, nextAfterSeq: 53, more: true,
		});
		const q = requests[0]!.url.searchParams;
		assert.equal(requests[0]!.url.pathname, "/vault/v1/streams/read");
		assert.deepEqual([q.get("stream"), q.get("after"), q.get("maxBytes"), q.get("checkpoint")], ["b:x y", "0", "4096", "1"]);
	});

	it("nextAfterSeq on the last page: last row, else checkpoint, else afterSeq", async () => {
		const page = (body: Record<string, unknown>) => client(() => jsonResponse({
			vaultEpoch: "E", head: 9, stream: "s", lastSeq: 9, checkpointSeq: 0, gcSeq: 0, checkpoint: null, rows: [], nextAfter: null, ...body,
		})).http;
		const rows = await (page({ rows: [{ seq: 8, deviceId: "d", clientFrameId: "a", payload: "" }, { seq: 9, deviceId: "d", clientFrameId: "b", payload: "" }] }))
			.read("v1", "s", 3, false, null);
		assert.equal(rows.nextAfterSeq, 9);
		assert.equal(rows.more, false);
		const cp = await page({ checkpointSeq: 6, checkpoint: { coversSeq: 6, bytes: "" } }).read("v1", "s", 0, true, null);
		assert.equal(cp.nextAfterSeq, 6);
		assert.deepEqual(cp.checkpoint, { coversSeq: 6, bytes: new Uint8Array(0) });
		const empty = await page({ lastSeq: 0 }).read("v1", "unknown", 4, false, null);
		assert.deepEqual(empty, { checkpoint: null, rows: [], lastSeq: 0, checkpointSeq: 0, gcSeq: 0, nextAfterSeq: 4, more: false });
	});

	it("omits optional query params and throws typed errors", async () => {
		const c = client(() => jsonResponse({ error: "invalid_stream" }, 400));
		const e = await rejection(c.http.read("v1", "", 0, false, null));
		assert.deepEqual([e.status, e.code], [400, "invalid_stream"]);
		assert.equal(c.requests[0]!.url.search, "?stream=&after=0");
		const bad = await rejection(client(() => jsonResponse({ lastSeq: 1, rows: [{ seq: 1, deviceId: "d", clientFrameId: "c", payload: "!!" }], nextAfter: null }))
			.http.read("v1", "s", 0, false, null));
		assert.equal(bad.code, "malformed_response");
	});
});

describe("relayHttp putCheckpoint", () => {
	it("PUTs raw bytes with the CAS query", async () => {
		const { http, requests } = client(() => jsonResponse({ stream: "b:x", coversSeq: 9, gcSeq: 0, deletedSegments: 0 }));
		assert.deepEqual(await http.putCheckpoint("v1", "b:x", 9, 4, new Uint8Array([5, 6])), { t: "ok" });
		const req = requests[0]!;
		assert.equal(req.method, "PUT");
		assert.equal(req.url.pathname, "/vault/v1/streams/checkpoint");
		assert.equal(req.url.search, "?stream=b%3Ax&coversSeq=9&expectedCoversSeq=4");
		assert.equal(req.headers.get("content-type"), "application/octet-stream");
		assert.deepEqual(req.body, new Uint8Array([5, 6]));
	});

	it("maps every result", async () => {
		const cases: [Response, unknown][] = [
			[jsonResponse({ error: "checkpoint_conflict", current: { coversSeq: 12 } }, 409), { t: "conflict", currentCoversSeq: 12 }],
			[jsonResponse({ error: "checkpoint_ahead_of_stream", lastSeq: 3, current: { coversSeq: 0 } }, 409), { t: "refused", reason: "ahead-of-stream", retryAfterMs: null }],
			[jsonResponse({ error: "checkpoint_not_advancing", current: { coversSeq: 5 } }, 400), { t: "refused", reason: "not-advancing", retryAfterMs: null }],
			[jsonResponse({ error: "stream_not_found" }, 404), { t: "refused", reason: "stream-not-found", retryAfterMs: null }],
			[jsonResponse({ error: "body_too_large" }, 413), { t: "refused", reason: "too-large", retryAfterMs: null }],
			[jsonResponse({ error: "cf_daily_limit", kind: "rows-written", resetAt: 0 }, 503, { "retry-after": "60" }), { t: "refused", reason: "daily-limit", retryAfterMs: 60_000 }],
			[jsonResponse({ error: "forbidden" }, 403), { t: "refused", reason: "forbidden", retryAfterMs: null }],
		];
		for (const [response, expected] of cases) {
			assert.deepEqual(await client(() => response).http.putCheckpoint("v1", "s", 2, 1, new Uint8Array(1)), expected);
		}
	});

	it("throws for other errors", async () => {
		let e = await rejection(client(() => jsonResponse({ error: "invalid_covers_seq" }, 400)).http.putCheckpoint("v1", "s", 0, 0, new Uint8Array(0)));
		assert.deepEqual([e.status, e.code], [400, "invalid_covers_seq"]);
		e = await rejection(client(() => jsonResponse({ error: "boom" }, 500)).http.putCheckpoint("v1", "s", 2, 1, new Uint8Array(0)));
		assert.equal(e.status, 500);
		e = await rejection(client(() => "network").http.putCheckpoint("v1", "s", 2, 1, new Uint8Array(0)));
		assert.equal(e.code, "network_error");
		e = await rejection(client(() => jsonResponse({ error: "checkpoint_conflict" }, 409)).http.putCheckpoint("v1", "s", 2, 1, new Uint8Array(0)));
		assert.equal(e.code, "malformed_response");
	});
});
