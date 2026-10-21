import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRelayHttp, dailyResetDelayMs, parseRetryAfter, readPageBound, RELAY_READ_CLIENT_MAX_BYTES, RelayHttpError } from "./relayHttp";
import { RELAY_HTTP_BASE_MS, RELAY_HTTP_FLOOR_BYTES_PER_S, RELAY_HTTP_IDLE_MS, relayHttpDeadlineMs } from "../../core/deadline";
import type { StreamName } from "../../core/types";
import { fakeFetch, jsonResponse, ManualClock, readResponse, type FakeRequest } from "./relayTestFakes";
import { encodeReadReply, READ_BINARY_TYPE, type WireReadPage } from "./relayFrames";

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
});

describe("relayHttp fetchGrant (identity-per-store §3.4)", () => {
	it("GETs /auth/grant with the bearer token and returns a well-formed secret", async () => {
		const secret = "S".repeat(43);
		const { http, requests } = client(() => jsonResponse({ grantId: "grant_AAAAAAAAAAAAAAAA", grantName: "Mac", grantSecret: secret }));
		assert.deepEqual(await http.fetchGrant("v/1"), { ok: true, grantSecret: secret });
		const req = requests[0]!;
		assert.equal(req.method, "GET");
		assert.equal(req.url.href, "https://relay.example/vault/v%2F1/auth/grant");
		assert.equal(req.headers.get("authorization"), `Bearer ${TOKEN}`);
	});

	it("maps the refusals: 404 nothing to fetch, 401/403 refused, the rest (and a malformed secret) retry later", async () => {
		const cases: [Response | "network", string][] = [
			[jsonResponse({ error: "grant_secret_unavailable" }, 404), "unavailable"],
			[jsonResponse({ error: "grant_revoked" }, 401), "refused"],
			[jsonResponse({ error: "unauthorized" }, 401), "refused"],
			[jsonResponse({ error: "grant_required" }, 403), "refused"],
			[jsonResponse({ error: "grant_rotating" }, 409), "network"],
			[jsonResponse({ error: "boom" }, 500), "network"],
			[jsonResponse({ grantSecret: "short" }), "network"],
			[jsonResponse({ grantSecret: 7 }), "network"],
			["network", "network"],
		];
		for (const [response, reason] of cases) {
			const { http } = client(() => response);
			assert.deepEqual(await http.fetchGrant("v"), { ok: false, reason }, String(reason));
		}
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
		assert.deepEqual(await http.feed("v1", "E", 0, 2), {
			entries: [{ stream: "ns", lastSeq: 41 }, { stream: "b:x", lastSeq: 50 }], throughSeq: 50, headSeq: 57, more: true,
		});
		assert.deepEqual(await http.feed("v1", "E", 50, null), { entries: [{ stream: "b:y", lastSeq: 57 }], throughSeq: 57, headSeq: 57, more: false });
		assert.equal(requests[0]!.url.pathname, "/vault/v1/streams/feed");
		assert.equal(requests[0]!.url.search, "?after=0&limit=2");
		assert.equal(requests[1]!.url.search, "?after=50");
		assert.equal(requests[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
	});

	it("a reply of another epoch (reset / restore in flight) rejects epoch_mismatch", async () => {
		const e = await rejection(client(() => jsonResponse({ vaultEpoch: "E2", head: 3, changes: [], nextAfter: null })).http.feed("v1", "E", 0, null));
		assert.deepEqual([e.status, e.code], [200, "epoch_mismatch"]);
	});

	it("throws typed errors without secrets", async () => {
		let e = await rejection(client(() => jsonResponse({ error: "invalid_cursor" }, 400)).http.feed("v1", "E", -1, null));
		assert.deepEqual([e.status, e.code, e.retryAfterMs], [400, "invalid_cursor", null]);
		e = await rejection(client(() => jsonResponse({ error: "cf_daily_limit", resetAt: 0 }, 503, { "retry-after": "7" })).http.feed("v1", "E", 0, null));
		assert.deepEqual([e.status, e.code, e.retryAfterMs], [503, "cf_daily_limit", 7000]);
		e = await rejection(client(() => "network").http.feed("v1", "E", 0, null));
		assert.deepEqual([e.status, e.code], [0, "network_error"]);
		e = await rejection(client(() => jsonResponse({ head: 1, changes: "x", nextAfter: null })).http.feed("v1", "E", 0, null));
		assert.deepEqual([e.status, e.code], [200, "malformed_response"]);
		e = await rejection(client(() => jsonResponse({ error: "unauthorized" }, 401)).http.feed("v1", "E", 0, null));
		assert.match(e.message, /feed failed: HTTP 401 unauthorized/);
	});
});

describe("relayHttp read (binary reply, relay-wire §7.2)", () => {
	const binary = (pages: WireReadPage[], status = 200) =>
		new Response(encodeReadReply({ vaultEpoch: "E", head: 57, pages }), { status, headers: { "content-type": READ_BINARY_TYPE } });
	const pageOf = (stream: string, extra: Partial<WireReadPage> = {}): WireReadPage => ({
		stream, lastSeq: 57, checkpointSeq: 50, gcSeq: 44, checkpoint: { coversSeq: 50, bytes: new Uint8Array([1, 2, 3]) },
		rows: [{ seq: 53, deviceId: "d1", clientFrameId: "c1", payload: new Uint8Array([9]) }], nextAfter: 53, ...extra,
	});

	it("decodes rows and the checkpoint; passes maxBytes and checkpoint=1; sends no Accept", async () => {
		const { http, requests } = client(() => binary([pageOf("b:x y")]));
		const page = await http.read("v1", "E", "b:x y", 0, true, 4096);
		assert.deepEqual(page, {
			checkpoint: { coversSeq: 50, bytes: new Uint8Array([1, 2, 3]) },
			rows: [{ seq: 53, deviceId: "d1", clientFrameId: "c1", payload: new Uint8Array([9]) }],
			lastSeq: 57, checkpointSeq: 50, gcSeq: 44, nextAfterSeq: 53, more: true,
		});
		const q = requests[0]!.url.searchParams;
		assert.equal(requests[0]!.url.pathname, "/vault/v1/streams/read");
		assert.deepEqual([q.get("stream"), q.get("after"), q.get("maxBytes"), q.get("checkpoint")], ["b:x y", "0", "4096", "1"]);
		assert.equal(requests[0]!.headers.get("accept"), null);
	});

	it("a reply of another epoch (reset / restore in flight) rejects epoch_mismatch: its rows never reach this epoch", async () => {
		const other = new Response(encodeReadReply({ vaultEpoch: "E2", head: 57, pages: [pageOf("s")] }), { status: 200, headers: { "content-type": READ_BINARY_TYPE } });
		const e = await rejection(client(() => other).http.read("v1", "E", "s", 0, false, null));
		assert.deepEqual([e.status, e.code], [200, "epoch_mismatch"]);
	});

	it("nextAfterSeq on the last page: last row, else checkpoint, else afterSeq", async () => {
		const page = (extra: Partial<WireReadPage>) => client(() => binary([pageOf("s", { lastSeq: 9, checkpointSeq: 0, gcSeq: 0, checkpoint: null,
			rows: [], nextAfter: null, ...extra })])).http;
		const empty = new Uint8Array(0);
		const rows = await page({ rows: [{ seq: 8, deviceId: "d", clientFrameId: "a", payload: empty }, { seq: 9, deviceId: "d", clientFrameId: "b", payload: empty }] })
			.read("v1", "E", "s", 3, false, null);
		assert.equal(rows.nextAfterSeq, 9);
		assert.equal(rows.more, false);
		const cp = await page({ checkpointSeq: 6, checkpoint: { coversSeq: 6, bytes: empty } }).read("v1", "E", "s", 0, true, null);
		assert.equal(cp.nextAfterSeq, 6);
		assert.deepEqual(cp.checkpoint, { coversSeq: 6, bytes: new Uint8Array(0) });
		const unknown = await client(() => binary([pageOf("unknown", { lastSeq: 0, checkpointSeq: 0, gcSeq: 0, checkpoint: null, rows: [], nextAfter: null })]))
			.http.read("v1", "E", "unknown", 4, false, null);
		assert.deepEqual(unknown, { checkpoint: null, rows: [], lastSeq: 0, checkpointSeq: 0, gcSeq: 0, nextAfterSeq: 4, more: false });
	});

	it("readBatch decodes the served prefix and checks each page's stream", async () => {
		const reqs = [{ stream: "a" as StreamName, afterSeq: 0, preferCheckpoint: true }, { stream: "b" as StreamName, afterSeq: 7, preferCheckpoint: false }];
		const { http } = client(() => binary([pageOf("a")]));
		const other = (await rejection(client(() => new Response(encodeReadReply({ vaultEpoch: "E2", head: 57, pages: [pageOf("a"), pageOf("b")] }), { status: 200, headers: { "content-type": READ_BINARY_TYPE } })).http.readBatch("v1", "E", reqs, null)));
		assert.equal(other.code, "epoch_mismatch", "a batch of another epoch is refused whole");
		const pages = await http.readBatch("v1", "E", reqs, null);
		assert.equal(pages.length, 1);
		assert.equal(pages[0]!.nextAfterSeq, 53);
		const wrong = await rejection(client(() => binary([pageOf("b")])).http.readBatch("v1", "E", reqs, null));
		assert.equal(wrong.code, "malformed_response");
		const many = await rejection(client(() => binary([pageOf("a"), pageOf("b"), pageOf("c")])).http.readBatch("v1", "E", reqs, null));
		assert.equal(many.code, "malformed_response");
		const none = await rejection(client(() => binary([])).http.readBatch("v1", "E", reqs, null));
		assert.equal(none.code, "malformed_response");
	});

	it("truncated, trailing, wrong-version, wrong-stream or JSON 200 replies are malformed; errors are JSON", async () => {
		const full = encodeReadReply({ vaultEpoch: "E", head: 57, pages: [pageOf("s")] });
		const raw = (bytes: Uint8Array) => () => new Response(bytes, { headers: { "content-type": READ_BINARY_TYPE } });
		for (const bytes of [full.subarray(0, full.byteLength - 1), new Uint8Array([...full, 0]), new Uint8Array([2, ...full.subarray(1)])]) {
			assert.equal((await rejection(client(raw(bytes)).http.read("v1", "E", "s", 0, false, null))).code, "malformed_response");
		}
		assert.equal((await rejection(client(() => binary([pageOf("t")])).http.read("v1", "E", "s", 0, false, null))).code, "malformed_response");
		const json = client(() => jsonResponse({ vaultEpoch: "E", head: 9, stream: "s", lastSeq: 9, checkpoint: null, rows: [], nextAfter: null }));
		assert.equal((await rejection(json.http.read("v1", "E", "s", 3, false, null))).code, "malformed_response");
		const c = client(() => jsonResponse({ error: "invalid_stream" }, 400));
		const e = await rejection(c.http.read("v1", "E", "", 0, false, null));
		assert.deepEqual([e.status, e.code], [400, "invalid_stream"]);
		assert.equal(c.requests[0]!.url.search, "?stream=&after=0&maxBytes=2097152");
	});
});

describe("relayHttp putCheckpoint", () => {
	it("PUTs raw bytes with the CAS query and the session's epoch", async () => {
		const { http, requests } = client(() => jsonResponse({ stream: "b:x", coversSeq: 9, gcSeq: 0, deletedSegments: 0 }));
		assert.deepEqual(await http.putCheckpoint("v1", "E 1", "b:x", 9, 4, new Uint8Array([5, 6])), { t: "ok" });
		const req = requests[0]!;
		assert.equal(req.method, "PUT");
		assert.equal(req.url.pathname, "/vault/v1/streams/checkpoint");
		assert.equal(req.url.search, "?stream=b%3Ax&coversSeq=9&expectedCoversSeq=4&vaultEpoch=E%201");
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
			[jsonResponse({ error: "epoch_mismatch", vaultEpoch: "E2" }, 409), { t: "refused", reason: "epoch-mismatch", retryAfterMs: null }],
		];
		for (const [response, expected] of cases) {
			assert.deepEqual(await client(() => response).http.putCheckpoint("v1", "E", "s", 2, 1, new Uint8Array(1)), expected);
		}
	});

	it("throws for other errors", async () => {
		let e = await rejection(client(() => jsonResponse({ error: "invalid_covers_seq" }, 400)).http.putCheckpoint("v1", "E", "s", 0, 0, new Uint8Array(0)));
		assert.deepEqual([e.status, e.code], [400, "invalid_covers_seq"]);
		e = await rejection(client(() => jsonResponse({ error: "boom" }, 500)).http.putCheckpoint("v1", "E", "s", 2, 1, new Uint8Array(0)));
		assert.equal(e.status, 500);
		e = await rejection(client(() => "network").http.putCheckpoint("v1", "E", "s", 2, 1, new Uint8Array(0)));
		assert.equal(e.code, "network_error");
		e = await rejection(client(() => jsonResponse({ error: "checkpoint_conflict" }, 409)).http.putCheckpoint("v1", "E", "s", 2, 1, new Uint8Array(0)));
		assert.equal(e.code, "malformed_response");
	});
});

describe("relayHttp liveness (feed, read, readBatch watched; putCheckpoint bounded)", () => {
	const MiB = 1024 * 1024;
	const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
	/** A fetch that never answers and ignores its signal: only untilAborted ends the wait. */
	const deaf = (): { fetch: typeof fetch; signals: (AbortSignal | null)[] } => {
		const signals: (AbortSignal | null)[] = [];
		return { signals, fetch: async (_input, init) => { signals.push(init?.signal ?? null); return new Promise<Response>(() => undefined); } };
	};
	/** A fetch that answers headers at once and then plays the body by hand; the body ignores the signal. */
	const streaming = (): { fetch: typeof fetch; push: (b: Uint8Array) => void; end: () => void; cancelled: () => boolean } => {
		let ctl!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; }, cancel() { cancelled = true; } });
		return {
			fetch: async () => new Response(body, { status: 200, headers: { "content-type": READ_BINARY_TYPE } }),
			push: (b) => ctl.enqueue(b), end: () => ctl.close(), cancelled: () => cancelled,
		};
	};
	const readCall = (h: ReturnType<typeof createRelayHttp>, s?: AbortSignal) => h.read("v1", "E1", "ns", 0, true, MiB, s);
	const watchedCalls: [string, (h: ReturnType<typeof createRelayHttp>, signal?: AbortSignal) => Promise<unknown>][] = [
		["feed", (h, s) => h.feed("v1", "E1", 0, 1000, s)],
		["read", readCall],
		["readBatch", (h, s) => h.readBatch("v1", "E1", [{ stream: "a" as StreamName, afterSeq: 0, preferCheckpoint: false }, { stream: "b" as StreamName, afterSeq: 0, preferCheckpoint: true }], MiB, s)],
	];
	const allCalls: [string, (h: ReturnType<typeof createRelayHttp>, signal?: AbortSignal) => Promise<unknown>][] = [
		...watchedCalls,
		["putCheckpoint", (h, s) => h.putCheckpoint("v1", "E", "ns", 2, 0, new Uint8Array(MiB), s)],
	];

	it("backstops: base + byte bound at the floor; every read page is bounded by one 4 MiB checkpoint (79 s, was 143 s)", () => {
		assert.equal(relayHttpDeadlineMs(0), RELAY_HTTP_BASE_MS);
		assert.equal(relayHttpDeadlineMs(RELAY_HTTP_FLOOR_BYTES_PER_S * 10), RELAY_HTTP_BASE_MS + 10_000);
		assert.equal(readPageBound(MiB), 4096 + 4 * MiB);
		assert.equal(readPageBound(RELAY_READ_CLIENT_MAX_BYTES), 4096 + 4 * MiB, "the client's largest budget adds nothing");
		assert.equal(relayHttpDeadlineMs(readPageBound(RELAY_READ_CLIENT_MAX_BYTES)), 79_063);
	});

	it("a read never asks for more than RELAY_READ_CLIENT_MAX_BYTES, and names a budget when the caller does not", async () => {
		const f = fakeFetch(() => readResponse([{ stream: "ns", checkpoint: null, rows: [], lastSeq: 0, checkpointSeq: 0, gcSeq: 0, nextAfter: null }]));
		const http = createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: f.fetch, clock: new ManualClock() });
		await http.read("v1", "E1", "ns", 0, false, 4 * MiB);
		await http.read("v1", "E1", "ns", 0, false, null);
		assert.deepEqual(f.requests.map((r) => r.url.searchParams.get("maxBytes")), [String(RELAY_READ_CLIENT_MAX_BYTES), String(RELAY_READ_CLIENT_MAX_BYTES)]);
	});

	for (const [name, call] of watchedCalls) {
		it(`${name}: a request nobody answers ends "timeout" after RELAY_HTTP_BASE_MS, whatever its size, even when the fetch ignores its signal`, async () => {
			const clock = new ManualClock();
			const f = deaf();
			const p = call(createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: f.fetch, clock }));
			let settled = false;
			p.then(() => (settled = true), () => (settled = true));
			await tick();
			clock.advance(RELAY_HTTP_BASE_MS - 1);
			await tick();
			assert.equal(settled, false);
			clock.advance(1);
			const e = await rejection(p);
			assert.deepEqual([e.status, e.code, clock.pendingTimers], [0, "timeout", 0]);
			assert.equal(f.signals[0]?.aborted, true, "the fetch's signal is aborted too");
		});
	}

	it("putCheckpoint (no upload progress): ends \"timeout\" at its size-proportional deadline", async () => {
		const clock = new ManualClock();
		const f = deaf();
		const p = createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: f.fetch, clock }).putCheckpoint("v1", "E", "ns", 2, 0, new Uint8Array(MiB));
		let settled = false;
		p.then(() => (settled = true), () => (settled = true));
		await tick();
		clock.advance(relayHttpDeadlineMs(4096 + MiB) - 1);
		await tick();
		assert.equal(settled, false);
		clock.advance(1);
		assert.deepEqual([(await rejection(p)).code, clock.pendingTimers], ["timeout", 0]);
	});

	for (const [name, call] of allCalls) {
		it(`${name}: the caller's signal ends it "aborted" at once (before or in flight); listeners and timers are released`, async () => {
			const clock = new ManualClock();
			const f = deaf();
			const http = createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: f.fetch, clock });
			const before = new AbortController();
			before.abort();
			assert.equal((await rejection(call(http, before.signal))).code, "aborted");
			assert.equal(f.signals.length, 0, "nothing is sent");
			const ctl = new AbortController();
			const p = call(http, ctl.signal);
			await tick();
			ctl.abort();
			assert.deepEqual([(await rejection(p)).code, clock.pendingTimers], ["aborted", 0]);
			assert.equal(getEventListeners(ctl.signal, "abort").length, 0);
		});
	}

	it("stalled after headers: no body byte for RELAY_HTTP_IDLE_MS ends it \"stalled\" and cancels the body", async () => {
		const clock = new ManualClock();
		const s = streaming();
		const p = readCall(createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: s.fetch, clock }));
		let settled = false;
		p.then(() => (settled = true), () => (settled = true));
		await tick();
		clock.advance(RELAY_HTTP_IDLE_MS - 1);
		await tick();
		assert.equal(settled, false);
		clock.advance(1);
		assert.deepEqual([(await rejection(p)).code, clock.pendingTimers], ["stalled", 0]);
		await tick();
		assert.equal(s.cancelled(), true);
	});

	it("stalled mid-body: bytes, then silence, ends \"stalled\" RELAY_HTTP_IDLE_MS after the last chunk", async () => {
		const clock = new ManualClock();
		const s = streaming();
		const p = readCall(createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: s.fetch, clock }));
		let settled = false;
		p.then(() => (settled = true), () => (settled = true));
		await tick();
		for (let i = 0; i < 5; i++) {
			clock.advance(RELAY_HTTP_IDLE_MS - 1);
			s.push(new Uint8Array(1024));
			await tick();
		}
		assert.equal(settled, false);
		clock.advance(RELAY_HTTP_IDLE_MS - 1);
		await tick();
		assert.equal(settled, false);
		clock.advance(1);
		assert.deepEqual([(await rejection(p)).code, clock.pendingTimers], ["stalled", 0]);
	});

	it("slow but progressing: a page trickling for longer than the idle window many times over is read whole", async () => {
		const clock = new ManualClock();
		const s = streaming();
		const p = readCall(createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: s.fetch, clock }));
		await tick();
		const reply = encodeReadReply({ vaultEpoch: "E1", head: 3, pages: [{ stream: "ns", checkpoint: null, rows: [{ seq: 3, deviceId: "d", clientFrameId: "f", payload: new Uint8Array(4000) }], lastSeq: 3, checkpointSeq: 0, gcSeq: 0, nextAfter: null }] });
		// Six gaps of 9 s, just under the idle window (54 s in all, five idle windows), then the rest.
		for (let i = 0; i < 6; i++) {
			clock.advance(RELAY_HTTP_IDLE_MS - 1000);
			s.push(reply.subarray(i, i + 1));
			await tick();
		}
		s.push(reply.subarray(6));
		s.end();
		const page = await p;
		assert.deepEqual([page.rows.length, page.lastSeq, clock.pendingTimers], [1, 3, 0]);
	});

	it("a reply that keeps trickling ends \"timeout\" at its backstop", async () => {
		const clock = new ManualClock();
		const s = streaming();
		const p = readCall(createRelayHttp({ baseUrl: BASE, credential: TOKEN, fetch: s.fetch, clock }));
		let settled = false;
		p.then(() => (settled = true), () => (settled = true));
		await tick();
		const backstop = relayHttpDeadlineMs(readPageBound(MiB));
		for (let t = 5000; t < backstop; t += 5000) {
			clock.advance(5000);
			s.push(new Uint8Array(1));
			await tick();
		}
		assert.equal(settled, false);
		clock.advance(backstop % 5000);
		assert.deepEqual([(await rejection(p)).code, clock.pendingTimers], ["timeout", 0]);
	});
});
