import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RelayConnectResult, RelayEvent, RelaySession } from "../../ports/relay";
import type { ClientFrameId, DeviceId, StreamName, VaultId } from "../../core/types";
import {
	createWsRelayPort,
	DEFAULT_RELAY_LIMITS,
	LIVENESS_CLOSE_CODE,
	ProvisionalJoin,
	streamsSocketUrl,
	type WsRelayOptions,
} from "./wsRelay";
import { CONTROL_PREFIX } from "./relayFrames";
import { bytesToBase64 } from "./relayHttp";
import { FakeSocket, fakeFetch, fakeSockets, jsonResponse, ManualClock, type FakeRequest } from "./relayTestFakes";

const TOKEN = "device-token-SECRET-xyz";
const TICKET = "ticket.SECRET";
const VAULT = "vault1" as VaultId;
const DEVICE = "devA" as DeviceId;
const S = (s: string) => s as StreamName;
const C = (s: string) => s as ClientFrameId;
const D = (s: string) => s as DeviceId;
const bytes = (...v: number[]) => new Uint8Array(v);

const READY = {
	type: "VAULT_READY", documentId: "streams", socketSessionId: "sock", vaultId: "vault1", vaultGeneration: "E1",
	vaultEpoch: "E1", runtimeEpoch: "R1", head: 42,
	liveness: { version: 1, idleMs: 60000, timeoutMs: 15000 },
	capabilities: { streams: 1 },
	limits: {
		maxStreamNameBytes: 256, maxClientFrameIdBytes: 128, maxPayloadBytes: 1048576, maxBinaryMessageBytes: 1049600,
		maxTextMessageBytes: 65536, maxCheckpointBytes: 4194304, feedDefaultLimit: 1000, feedMaxLimit: 5000,
		readDefaultBytes: 1048576, readMaxBytes: 4194304, rateBytesPerSec: 262144, burstBytes: 2097152,
		groupCommit: { idleMs: 300, maxMs: 1500, maxBytes: 65536, minIntervalMs: 0 },
	},
	canWrite: true, principalId: "p", deviceId: "devA", role: "owner",
};

interface Harness {
	clock: ManualClock;
	sockets: FakeSocket[];
	requests: FakeRequest[];
	connect(): Promise<RelayConnectResult>;
}

function harness(opts: {
	ticket?: (req: FakeRequest) => Response | "network";
	http?: (req: FakeRequest) => Response | "network";
	onSocket?: (socket: FakeSocket) => void;
	extra?: Partial<WsRelayOptions>;
} = {}): Harness {
	const clock = new ManualClock();
	const f = fakeFetch((req) => {
		if (req.url.pathname.endsWith("/auth/ticket")) return opts.ticket ? opts.ticket(req) : jsonResponse({ ticket: TICKET, expiresAt: 0, ttlMs: 300000 });
		return opts.http ? opts.http(req) : jsonResponse({ error: "unexpected" }, 500);
	});
	const ws = fakeSockets(opts.onSocket);
	const port = createWsRelayPort({ baseUrl: "https://relay.example", credential: TOKEN, fetch: f.fetch, WebSocketImpl: ws.Ctor, clock, ...opts.extra });
	return { clock, sockets: ws.sockets, requests: f.requests, connect: () => port.connect({ vaultId: VAULT, deviceId: DEVICE }) };
}

/** Lets the ticket fetch settle so the socket exists. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setImmediate(r));
}

async function open(extra: Partial<WsRelayOptions> = {}, ready: Record<string, unknown> = READY, http?: (req: FakeRequest) => Response | "network") {
	const h = harness({ extra, http });
	const pending = h.connect();
	await flush();
	const socket = h.sockets[0]!;
	socket.accept();
	socket.control(ready);
	const result = await pending;
	assert.ok(result.ok, "connect failed");
	return { ...h, socket, session: result.session };
}

function collect(session: RelaySession): RelayEvent[] {
	const events: RelayEvent[] = [];
	session.onEvent((e) => events.push(e));
	return events;
}

describe("wsRelay connect", () => {
	it("fetches a ticket, opens the streams socket and maps VAULT_READY", async () => {
		const { socket, session, requests } = await open();
		assert.equal(requests.length, 1);
		assert.equal(requests[0]!.url.pathname, "/vault/vault1/auth/ticket");
		assert.equal(requests[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
		assert.equal(socket.url, `wss://relay.example/vault/vault1/ws/streams?ticket=ticket.SECRET&streamsVersion=1`);
		assert.ok(!socket.url.includes(TOKEN));
		assert.equal(socket.binaryType, "arraybuffer");
		assert.equal(session.vaultEpoch, "E1");
		assert.equal(session.headSeq, 42);
		assert.equal(session.canWrite, true);
		assert.deepEqual(session.limits, {
			maxFrameBytes: 1048576, maxCheckpointBytes: 4194304, appendBytesPerSec: 262144, burstBytes: 2097152,
			feedPageRows: 1000, readPageBytes: 1048576,
		});
	});

	it("uses default limits when VAULT_READY omits them", async () => {
		const { session } = await open({}, { type: "VAULT_READY", vaultEpoch: "E9", head: 0, canWrite: false });
		assert.deepEqual(session.limits, DEFAULT_RELAY_LIMITS);
		assert.equal(session.canWrite, false);
		assert.equal(session.headSeq, 0);
	});

	it("fetches a fresh ticket on every connect", async () => {
		let n = 0;
		const h = harness({ ticket: () => jsonResponse({ ticket: `t${++n}` }) });
		for (let i = 0; i < 2; i++) {
			const p = h.connect();
			await flush();
			h.sockets[i]!.accept();
			h.sockets[i]!.control(READY);
			assert.ok((await p).ok);
		}
		assert.match(h.sockets[0]!.url, /ticket=t1&/);
		assert.match(h.sockets[1]!.url, /ticket=t2&/);
	});

	it("maps ticket failures without opening a socket", async () => {
		const cases: [Response | "network", string, number | null][] = [
			[jsonResponse({ error: "unauthorized" }, 401), "unauthorized", null],
			[jsonResponse({ error: "not found" }, 404), "not-found", null],
			[jsonResponse({ error: "unclaimed" }, 503), "unclaimed", null],
			[jsonResponse({ error: "authority_superseded" }, 409), "superseded", null],
			[jsonResponse({ error: "cf_daily_limit", resetAt: 0 }, 503, { "retry-after": "30" }), "daily-limit", 30_000],
			[jsonResponse({ error: "x" }, 500), "unavailable", null],
			[jsonResponse({ error: "x" }, 429, { "retry-after": "2" }), "unavailable", 2000],
			[jsonResponse({ error: "draining" }, 503), "unavailable", null],
			["network", "unavailable", null],
		];
		for (const [response, reason, retryAfterMs] of cases) {
			const h = harness({ ticket: () => response });
			assert.deepEqual(await h.connect(), { ok: false, reason, retryAfterMs }, reason);
			assert.equal(h.sockets.length, 0);
		}
	});

	it("maps upgrade error frames before VAULT_READY", async () => {
		const cases: [string, string][] = [
			["unauthorized", "unauthorized"],
			["update_required", "update-required"],
			["unclaimed", "unclaimed"],
			["authority_superseded", "superseded"],
			["something_new", "unavailable"],
		];
		for (const [code, reason] of cases) {
			const h = harness();
			const p = h.connect();
			await flush();
			const socket = h.sockets[0]!;
			socket.accept();
			socket.control({ type: "error", code, reason: "streams_version_mismatch" });
			socket.serverClose(1008);
			assert.deepEqual(await p, { ok: false, reason, retryAfterMs: null }, code);
			assert.ok(socket.clientClose, "adapter closes the rejected socket");
		}
	});

	it("close before ready -> unavailable", async () => {
		const h = harness();
		const p = h.connect();
		await flush();
		h.sockets[0]!.serverClose(1006, false);
		assert.deepEqual(await p, { ok: false, reason: "unavailable", retryAfterMs: null });
	});

	it("ready timeout -> unavailable and the socket is closed", async () => {
		const h = harness({ extra: { readyTimeoutMs: 5000 } });
		const p = h.connect();
		await flush();
		const socket = h.sockets[0]!;
		socket.accept();
		h.clock.advance(4999);
		socket.text("not a control frame");
		h.clock.advance(1);
		assert.deepEqual(await p, { ok: false, reason: "unavailable", retryAfterMs: null });
		assert.ok(socket.clientClose);
		assert.equal(h.clock.pendingTimers, 0);
		socket.control(READY); // late ready is ignored
	});

	it("a throwing WebSocket constructor -> unavailable, nothing leaks", async () => {
		const clock = new ManualClock();
		const f = fakeFetch(() => jsonResponse({ ticket: TICKET }));
		class Exploding extends FakeSocket {
			constructor(url: string) {
				super(url);
				throw new Error(`cannot open ${url}`);
			}
		}
		const port = createWsRelayPort({ baseUrl: "https://relay.example", credential: TOKEN, fetch: f.fetch, clock, WebSocketImpl: Exploding });
		assert.deepEqual(await port.connect({ vaultId: VAULT, deviceId: DEVICE }), { ok: false, reason: "unavailable", retryAfterMs: null });
	});

	it("builds ws:// for http:// and keeps a path prefix", () => {
		assert.equal(streamsSocketUrl("http://127.0.0.1:8787/", "v 1", "a+b"), "ws://127.0.0.1:8787/vault/v%201/ws/streams?ticket=a%2Bb&streamsVersion=1");
		assert.equal(streamsSocketUrl("https://h/prefix", "v", "t"), "wss://h/prefix/vault/v/ws/streams?ticket=t&streamsVersion=1");
	});
});

describe("wsRelay session events", () => {
	it("buffers events until the first listener, then delivers live", async () => {
		const { socket, session } = await open();
		socket.binary({ kind: "committed", seq: 43, stream: "ns", deviceId: "devB", clientFrameId: "f1", payload: bytes(1) });
		socket.control({ type: "STREAM_RECEIPTS", head: 44, receipts: [{ stream: "ns", clientFrameId: "mine", seq: 44, deduped: false }] });
		const first = collect(session);
		assert.deepEqual(first.map((e) => e.t), ["committed", "receipt", "head"]);
		const second = collect(session);
		socket.control({ type: "VAULT_PONG", probeId: "x", head: 44 });
		assert.deepEqual(first.map((e) => e.t), ["committed", "receipt", "head", "head"]);
		assert.deepEqual(second, [{ t: "head", headSeq: 44 }]);
	});

	it("a throwing listener does not stop delivery to others", async () => {
		const errors: unknown[] = [];
		const { socket, session } = await open({ onListenerError: (e) => errors.push(e) });
		session.onEvent(() => {
			throw new Error("listener bug");
		});
		const events = collect(session);
		socket.control({ type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" });
		assert.deepEqual(events, [{ t: "backpressure" }]);
		assert.match(String(errors[0]), /listener bug/);
	});

	it("unsubscribe stops delivery", async () => {
		const { socket, session } = await open();
		const events: RelayEvent[] = [];
		const off = session.onEvent((e) => events.push(e));
		off();
		socket.control({ type: "VAULT_BACKPRESSURE" });
		assert.deepEqual(events, []);
	});

	it("committed frames map to committed events", async () => {
		const { socket, session } = await open();
		const events = collect(session);
		socket.binary({ kind: "committed", seq: 43, stream: "ns", deviceId: "devB", clientFrameId: "f1", payload: bytes(7, 8) });
		assert.deepEqual(events, [{ t: "committed", frame: { stream: "ns", seq: 43, deviceId: "devB", clientFrameId: "f1", payload: bytes(7, 8) } }]);
	});

	it("joins PROVISIONAL + COMMIT_NOTICE; a notice without a held payload yields null", async () => {
		const { socket, session } = await open();
		const events = collect(session);
		socket.binary({ kind: "provisional", stream: "b:x", deviceId: "devB", clientFrameId: "p1", payload: bytes(1, 2, 3) });
		socket.binary({ kind: "notice", seq: 43, stream: "b:x", deviceId: "devB", clientFrameId: "p1" });
		socket.binary({ kind: "notice", seq: 43, stream: "b:x", deviceId: "devB", clientFrameId: "p1" });
		socket.binary({ kind: "notice", seq: 44, stream: "b:x", deviceId: "devC", clientFrameId: "p1" });
		assert.deepEqual(events, [
			{ t: "provisional", stream: S("b:x"), deviceId: D("devB"), clientFrameId: C("p1"), payload: bytes(1, 2, 3) },
			{ t: "committed", frame: { stream: "b:x", seq: 43, deviceId: "devB", clientFrameId: "p1", payload: bytes(1, 2, 3) } },
			{ t: "committed", frame: { stream: "b:x", seq: 43, deviceId: "devB", clientFrameId: "p1", payload: null } },
			{ t: "committed", frame: { stream: "b:x", seq: 44, deviceId: "devC", clientFrameId: "p1", payload: null } },
		]);
	});

	it("evicts held provisionals by bytes and by count (oldest first)", async () => {
		const byBytes = await open({ provisionalCacheBytes: 10 });
		const e1 = collect(byBytes.session);
		byBytes.socket.binary({ kind: "provisional", stream: "b:x", deviceId: "d", clientFrameId: "a", payload: new Uint8Array(6) });
		byBytes.socket.binary({ kind: "provisional", stream: "b:x", deviceId: "d", clientFrameId: "b", payload: new Uint8Array(6) });
		byBytes.socket.binary({ kind: "provisional", stream: "b:x", deviceId: "d", clientFrameId: "huge", payload: new Uint8Array(11) });
		for (const id of ["a", "b", "huge"]) byBytes.socket.binary({ kind: "notice", seq: 50, stream: "b:x", deviceId: "d", clientFrameId: id });
		const joined = e1.flatMap((e) => (e.t === "committed" ? [e.frame.payload?.byteLength ?? null] : []));
		assert.deepEqual(joined, [null, 6, null]);

		const byCount = await open({ provisionalCacheEntries: 1 });
		const e2 = collect(byCount.session);
		byCount.socket.binary({ kind: "provisional", stream: "b:x", deviceId: "d", clientFrameId: "a", payload: bytes(1) });
		byCount.socket.binary({ kind: "provisional", stream: "c:y", deviceId: "d", clientFrameId: "b", payload: bytes(2) });
		byCount.socket.binary({ kind: "notice", seq: 50, stream: "b:x", deviceId: "d", clientFrameId: "a" });
		byCount.socket.binary({ kind: "notice", seq: 51, stream: "c:y", deviceId: "d", clientFrameId: "b" });
		assert.deepEqual(e2.flatMap((e) => (e.t === "committed" ? [e.frame.payload] : [])), [null, bytes(2)]);
	});

	it("ProvisionalJoin keeps byte accounting exact", () => {
		const join = new ProvisionalJoin(100, 10);
		join.put("a", new Uint8Array(40));
		join.put("a", new Uint8Array(30));
		join.put("b", new Uint8Array(50));
		assert.deepEqual([join.size, join.heldBytes], [2, 80]);
		join.put("c", new Uint8Array(30));
		assert.deepEqual([join.size, join.heldBytes], [2, 80]);
		assert.equal(join.take("a"), null);
		assert.equal(join.take("b")?.byteLength, 50);
		join.clear();
		assert.deepEqual([join.size, join.heldBytes], [0, 0]);
	});

	it("STREAM_PROVISIONAL_DROPPED emits provisionalDropped and forgets the payload", async () => {
		const { socket, session } = await open();
		const events = collect(session);
		socket.binary({ kind: "provisional", stream: "b:x", deviceId: "devB", clientFrameId: "p1", payload: bytes(1) });
		socket.control({ type: "STREAM_PROVISIONAL_DROPPED", stream: "b:x", deviceId: "devB", clientFrameId: "p1", reason: "commit_failed" });
		socket.binary({ kind: "notice", seq: 43, stream: "b:x", deviceId: "devB", clientFrameId: "p1" });
		assert.deepEqual(events.slice(1), [
			{ t: "provisionalDropped", stream: "b:x", deviceId: "devB", clientFrameId: "p1" },
			{ t: "committed", frame: { stream: "b:x", seq: 43, deviceId: "devB", clientFrameId: "p1", payload: null } },
		]);
	});

	it("STREAM_RESEND clears held provisionals and emits resendUnreceipted", async () => {
		const { socket, session } = await open();
		const events = collect(session);
		socket.binary({ kind: "provisional", stream: "b:x", deviceId: "devB", clientFrameId: "p1", payload: bytes(1) });
		socket.control({ type: "STREAM_RESEND", reason: "runtime_restarted", runtimeEpoch: "R2", head: 50 });
		socket.binary({ kind: "notice", seq: 51, stream: "b:x", deviceId: "devB", clientFrameId: "p1" });
		assert.deepEqual(events.slice(1), [
			{ t: "resendUnreceipted", headSeq: 50 },
			{ t: "committed", frame: { stream: "b:x", seq: 51, deviceId: "devB", clientFrameId: "p1", payload: null } },
		]);
	});

	it("STREAM_RECEIPTS -> one receipt per entry in order, then head", async () => {
		const { socket, session } = await open();
		const events = collect(session);
		socket.control({
			type: "STREAM_RECEIPTS", head: 47,
			receipts: [
				{ stream: "ns", clientFrameId: "a", seq: 45, deduped: false },
				{ stream: "b:x", clientFrameId: "b", seq: 46, deduped: false },
				{ stream: "b:x", clientFrameId: "old", seq: 12, deduped: true },
			],
		});
		assert.deepEqual(events, [
			{ t: "receipt", stream: "ns", clientFrameId: "a", seq: 45, deduped: false },
			{ t: "receipt", stream: "b:x", clientFrameId: "b", seq: 46, deduped: false },
			{ t: "receipt", stream: "b:x", clientFrameId: "old", seq: 12, deduped: true },
			{ t: "head", headSeq: 47 },
		]);
	});

	it("maps pong, backpressure and every refusal", async () => {
		const { socket, session, clock } = await open();
		const events = collect(session);
		socket.control({ type: "VAULT_PONG", probeId: "p", documentId: "streams", vaultGeneration: "E1", runtimeEpoch: "R1", head: 60 });
		socket.control({ type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" });
		socket.control({ type: "VAULT_ERROR", code: "durability_failed", message: "x", stream: "ns", clientFrameIds: ["a", "b"] });
		socket.control({
			type: "VAULT_ERROR", code: "cf_daily_limit", cause: "durability_failed", kind: "rows-written",
			resetAt: clock.now() + 3_600_000, message: "x", stream: "b:x", clientFrameIds: ["c"],
		});
		socket.control({ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "d", code: "client_frame_id_conflict", seq: 17 });
		socket.control({ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "e", code: "client_frame_id_conflict" });
		socket.control({ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "f", code: "write_forbidden" });
		socket.control({ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "g", code: "future_code" });
		socket.control({ type: "VAULT_ERROR", code: "future_error", stream: "ns", clientFrameIds: ["h"] });
		const refusal = (stream: string, clientFrameId: string, reason: string, retryAfterMs: number | null, conflictSeq: number | null) =>
			({ t: "refused", stream, clientFrameId, reason, retryAfterMs, conflictSeq });
		assert.deepEqual(events, [
			{ t: "head", headSeq: 60 },
			{ t: "backpressure" },
			refusal("ns", "a", "durability", null, null),
			refusal("ns", "b", "durability", null, null),
			refusal("b:x", "c", "daily-limit", 3_600_000, null),
			refusal("ns", "d", "frame-id-conflict", null, 17),
			refusal("ns", "e", "frame-id-conflict", null, null),
			refusal("ns", "f", "forbidden", null, null),
		]);
	});

	it("an error control before the close lands in closed.errorCode", async () => {
		const { socket, session, clock } = await open();
		const events = collect(session);
		socket.control({ type: "error", code: "authority_superseded", reason: "credential_rotated" });
		socket.serverClose(4403, true);
		socket.serverClose(4403, true);
		assert.deepEqual(events, [{ t: "closed", code: 4403, errorCode: "authority_superseded", wasClean: true }]);
		assert.equal(clock.pendingTimers, 0);
	});

	it("a plain close has errorCode null; frames after close are ignored", async () => {
		const { socket, session } = await open();
		const events = collect(session);
		socket.binary({ kind: "provisional", stream: "b:x", deviceId: "devB", clientFrameId: "p1", payload: bytes(1) });
		const onmessage = socket.onmessage;
		socket.serverClose(1006, false);
		onmessage?.({ data: `${CONTROL_PREFIX}{"type":"VAULT_BACKPRESSURE"}` } as MessageEvent);
		assert.deepEqual(events.slice(1), [{ t: "closed", code: 1006, errorCode: null, wasClean: false }]);
		assert.equal(session.bufferedBytes(), 0);
	});
});

describe("wsRelay session sending", () => {
	it("append writes APPEND frames in call order; bufferedBytes follows the socket", async () => {
		const { socket, session } = await open();
		session.append({ stream: S("ns"), clientFrameId: C("a"), payload: bytes(1) });
		session.append({ stream: S("b:x"), clientFrameId: C("b"), payload: bytes(2, 3) });
		assert.deepEqual(socket.sentAppends(), [
			{ stream: "ns", clientFrameId: "a", payload: bytes(1) },
			{ stream: "b:x", clientFrameId: "b", payload: bytes(2, 3) },
		]);
		socket.bufferedAmount = 1234;
		assert.equal(session.bufferedBytes(), 1234);
	});

	it("append over maxFrameBytes throws; append after close is dropped", async () => {
		const { socket, session } = await open({}, { ...READY, limits: { ...READY.limits, maxPayloadBytes: 4 } });
		assert.throws(() => session.append({ stream: S("ns"), clientFrameId: C("a"), payload: new Uint8Array(5) }), RangeError);
		session.close(1000, "bye");
		session.append({ stream: S("ns"), clientFrameId: C("b"), payload: bytes(1) });
		assert.equal(socket.sent.length, 0);
	});

	it("close() closes the socket, emits closed once and clears every timer", async () => {
		const { socket, session, clock } = await open();
		const events = collect(session);
		assert.ok(clock.pendingTimers > 0);
		session.close(1000, "x".repeat(200));
		session.close(1000, "again");
		socket.serverClose(1000);
		assert.equal(socket.clientClose?.code, 1000);
		assert.ok(new TextEncoder().encode(socket.clientClose?.reason ?? "").byteLength <= 123);
		assert.deepEqual(events, [{ t: "closed", code: 1000, errorCode: null, wasClean: true }]);
		assert.equal(clock.pendingTimers, 0);
	});

	it("close() with a code the DOM refuses still closes (as 1000) and reports the caller's code", async () => {
		const { socket, session } = await open();
		const events = collect(session);
		session.close(1001, "going away");
		assert.equal(socket.clientClose?.code, 1000);
		assert.deepEqual(events, [{ t: "closed", code: 1001, errorCode: null, wasClean: true }]);
	});

	it("feed/read/putCheckpoint go over HTTP with the session's vault and limits", async () => {
		const seen: FakeRequest[] = [];
		const { session } = await open({}, READY, (req) => {
			seen.push(req);
			if (req.url.pathname.endsWith("/feed")) return jsonResponse({ vaultEpoch: "E1", head: 42, changes: [], nextAfter: null });
			if (req.url.pathname.endsWith("/read")) {
				return jsonResponse({ vaultEpoch: "E1", head: 42, stream: "ns", lastSeq: 1, checkpointSeq: 0, gcSeq: 0, checkpoint: null,
					rows: [{ seq: 1, deviceId: "d", clientFrameId: "c", payload: bytesToBase64(bytes(5)) }], nextAfter: null });
			}
			return jsonResponse({ stream: "ns", coversSeq: 1, gcSeq: 0, deletedSegments: 0 });
		});
		assert.deepEqual(await session.feed(7), { entries: [], throughSeq: 42, headSeq: 42, more: false });
		const page = await session.read(S("ns"), 0, true);
		assert.deepEqual(page.rows, [{ seq: 1, deviceId: "d", clientFrameId: "c", payload: bytes(5) }]);
		assert.deepEqual(await session.putCheckpoint(S("ns"), 1, 0, bytes(1)), { t: "ok" });
		assert.equal(seen[0]!.url.search, "?after=7&limit=1000");
		assert.equal(seen[1]!.url.search, "?stream=ns&after=0&maxBytes=1048576&checkpoint=1");
		assert.equal(seen[2]!.url.pathname, "/vault/vault1/streams/checkpoint");
		for (const req of seen) assert.equal(req.headers.get("authorization"), `Bearer ${TOKEN}`);
	});
});

describe("wsRelay liveness", () => {
	const pings = (socket: FakeSocket) => socket.sentControls().filter((c) => c["type"] === "VAULT_PING");

	it("pings after idleMs of silence; a pong keeps the session", async () => {
		const { socket, session, clock } = await open({ random: { bytes: (n) => new Uint8Array(n).fill(0xab), float: () => 0 } });
		const events = collect(session);
		clock.advance(59_999);
		assert.equal(pings(socket).length, 0);
		clock.advance(1);
		const sent = pings(socket);
		assert.equal(sent.length, 1);
		const probeId = String(sent[0]!["probeId"]);
		assert.match(probeId, /^[\x21-\x7e]{1,128}$/);
		clock.advance(10_000);
		socket.control({ type: "VAULT_PONG", probeId, head: 42 });
		clock.advance(15_000);
		assert.deepEqual(events, [{ t: "head", headSeq: 42 }]);
		clock.advance(60_000);
		assert.equal(pings(socket).length, 2, "next ping after another idle window");
	});

	it("traffic postpones the ping", async () => {
		const { socket, clock } = await open();
		clock.advance(30_000);
		socket.control({ type: "VAULT_BACKPRESSURE" });
		clock.advance(30_000);
		assert.equal(pings(socket).length, 0);
		clock.advance(30_000);
		assert.equal(pings(socket).length, 1);
	});

	it("no reply within timeoutMs closes with the liveness code", async () => {
		const { socket, session, clock } = await open({}, { ...READY, liveness: { version: 1, idleMs: 1000, timeoutMs: 500 } });
		const events = collect(session);
		clock.advance(1000);
		assert.equal(pings(socket).length, 1);
		clock.advance(499);
		assert.deepEqual(events, []);
		clock.advance(1);
		assert.deepEqual(events, [{ t: "closed", code: LIVENESS_CLOSE_CODE, errorCode: "liveness_timeout", wasClean: false }]);
		assert.equal(socket.clientClose?.code, LIVENESS_CLOSE_CODE);
		assert.equal(clock.pendingTimers, 0);
		socket.serverClose(1006, false);
		assert.equal(events.length, 1);
	});
});
