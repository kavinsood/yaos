import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	CONTROL_PREFIX,
	decodeAppend,
	decodeServerFrame,
	encodeAppend,
	encodePing,
	encodeServerFrame,
	encodeSubscribe,
	FRAME_APPEND,
	FRAME_COMMIT_NOTICE,
	FRAME_COMMITTED,
	FRAME_PROVISIONAL,
	FRAME_SKIPPED,
	parseControl,
	type WireServerFrame,
} from "./relayFrames";

const bytes = (...v: number[]) => new Uint8Array(v);

describe("relayFrames binary codec", () => {
	it("APPEND round-trips and has the wire layout", () => {
		const frame = { stream: "b:x", clientFrameId: "id-1", payload: bytes(1, 2, 3) };
		const enc = encodeAppend(frame);
		assert.deepEqual(Array.from(enc), [FRAME_APPEND, 3, 98, 58, 120, 4, 105, 100, 45, 49, 3, 1, 2, 3]);
		assert.deepEqual(decodeAppend(enc), frame);
	});

	it("APPEND with unicode names and an empty payload round-trips", () => {
		const frame = { stream: "b:ü/日本", clientFrameId: "ç", payload: new Uint8Array(0) };
		assert.deepEqual(decodeAppend(encodeAppend(frame)), frame);
	});

	it("server frames round-trip (including seqs above 2^32)", () => {
		const frames: WireServerFrame[] = [
			{ kind: "provisional", stream: "b:a", deviceId: "dev", clientFrameId: "c1", payload: bytes(9, 8) },
			{ kind: "committed", seq: 2 ** 40 + 3, stream: "ns", deviceId: "dev", clientFrameId: "c2", payload: bytes(7) },
			{ kind: "notice", seq: 1, stream: "c:z", deviceId: "dev", clientFrameId: "c3" },
		];
		for (const frame of frames) assert.deepEqual(decodeServerFrame(encodeServerFrame(frame)), frame);
		assert.equal(encodeServerFrame(frames[0]!)[0], FRAME_PROVISIONAL);
		assert.equal(encodeServerFrame(frames[1]!)[0], FRAME_COMMITTED);
		assert.equal(encodeServerFrame(frames[2]!)[0], FRAME_COMMIT_NOTICE);
	});

	it("decoded payloads are copies, not views into the message", () => {
		const enc = encodeServerFrame({ kind: "committed", seq: 5, stream: "ns", deviceId: "d", clientFrameId: "c", payload: bytes(1, 2) });
		const frame = decodeServerFrame(enc);
		assert.ok(frame && frame.kind === "committed");
		assert.equal(frame.payload.byteOffset, 0);
		assert.equal(frame.payload.buffer.byteLength, 2);
	});

	it("malformed frames decode to null", () => {
		const good = encodeServerFrame({ kind: "committed", seq: 5, stream: "ns", deviceId: "d", clientFrameId: "c", payload: bytes(1, 2) });
		assert.equal(decodeServerFrame(new Uint8Array(0)), null);
		assert.equal(decodeServerFrame(bytes(0x7f, 1, 2)), null, "unknown kind");
		assert.equal(decodeServerFrame(good.subarray(0, good.length - 1)), null, "truncated");
		assert.equal(decodeServerFrame(new Uint8Array([...good, 0])), null, "trailing bytes");
		assert.equal(decodeServerFrame(bytes(FRAME_PROVISIONAL, 2, 0xff, 0xfe, 0, 0, 0)), null, "invalid utf-8");
		assert.equal(decodeAppend(bytes(FRAME_PROVISIONAL)), null);
		assert.equal(decodeAppend(new Uint8Array([...encodeAppend({ stream: "s", clientFrameId: "c", payload: bytes() }), 1])), null);
	});
});

describe("relayFrames STREAM_SKIPPED", () => {
	it("has the relay-wire §19 layout and decodes into seq order across streams", () => {
		const enc = encodeServerFrame({ kind: "skipped", rows: [{ stream: "b:x", seq: 5 }, { stream: "c:y", seq: 6 }, { stream: "b:x", seq: 9 }] });
		// kind, 2 streams, "b:x" n=2 first=5 delta=4, "c:y" n=1 first=6
		assert.deepEqual(Array.from(enc), [FRAME_SKIPPED, 2, 3, 98, 58, 120, 2, 5, 4, 3, 99, 58, 121, 1, 6]);
		assert.deepEqual(decodeServerFrame(enc), { kind: "skipped", rows: [{ stream: "b:x", seq: 5 }, { stream: "c:y", seq: 6 }, { stream: "b:x", seq: 9 }] });
	});

	it("round-trips seqs above 2^32", () => {
		const rows = [{ stream: "b:a", seq: 2 ** 40 }, { stream: "b:a", seq: 2 ** 40 + 300 }];
		assert.deepEqual(decodeServerFrame(encodeServerFrame({ kind: "skipped", rows })), { kind: "skipped", rows });
	});

	it("is strict: empty, zero-length runs, non-ascending seqs, repeated streams, seq 0 and trailing bytes decode to null", () => {
		const raw = (...v: number[]) => bytes(FRAME_SKIPPED, ...v);
		assert.equal(decodeServerFrame(raw(0)), null, "no streams");
		assert.equal(decodeServerFrame(raw(1, 1, 98, 0, 5)), null, "n = 0");
		assert.equal(decodeServerFrame(raw(1, 1, 98, 2, 5, 0)), null, "delta 0");
		assert.equal(decodeServerFrame(raw(1, 1, 98, 1, 0)), null, "seq 0");
		assert.equal(decodeServerFrame(raw(1, 0, 1, 5)), null, "empty stream name");
		assert.equal(decodeServerFrame(raw(2, 1, 98, 1, 5, 1, 98, 1, 6)), null, "a stream twice");
		assert.equal(decodeServerFrame(raw(2, 1, 98, 1, 6, 1, 99, 1, 5)), null, "first seqs not ascending");
		assert.equal(decodeServerFrame(raw(2, 1, 98, 2, 5, 2, 1, 99, 1, 7)), null, "a seq in two runs");
		assert.equal(decodeServerFrame(raw(1, 1, 98, 1, 5, 0)), null, "trailing bytes");
		assert.equal(decodeServerFrame(raw(1, 1, 98, 2, 5)), null, "truncated");
		assert.deepEqual(decodeServerFrame(raw(1, 1, 98, 1, 5)), { kind: "skipped", rows: [{ stream: "b", seq: 5 }] });
	});
});

describe("relayFrames control", () => {
	it("encodes STREAM_SUBSCRIBE", () => {
		assert.equal(encodeSubscribe(["b:x", "c:y"]), `${CONTROL_PREFIX}{"type":"STREAM_SUBSCRIBE","streams":["b:x","c:y"]}`);
		assert.equal(encodeSubscribe([]), `${CONTROL_PREFIX}{"type":"STREAM_SUBSCRIBE","streams":[]}`);
	});

	it("encodes VAULT_PING", () => {
		assert.equal(encodePing("p1"), `${CONTROL_PREFIX}{"type":"VAULT_PING","probeId":"p1"}`);
	});

	it("ignores text without the prefix, bad JSON, non-objects and unknown types", () => {
		assert.equal(parseControl('{"type":"VAULT_PONG","head":1}'), null);
		assert.equal(parseControl(`${CONTROL_PREFIX}{nope`), null);
		assert.equal(parseControl(`${CONTROL_PREFIX}[1]`), null);
		assert.equal(parseControl(`${CONTROL_PREFIX}{"type":"VAULT_FUTURE"}`), null);
	});

	it("parses VAULT_READY with limits and liveness; tolerates missing optional parts", () => {
		const full = parseControl(CONTROL_PREFIX + JSON.stringify({
			type: "VAULT_READY", vaultEpoch: "E1", head: 42, canWrite: true, deviceId: "dev", runtimeEpoch: "R",
			liveness: { version: 1, idleMs: 60000, timeoutMs: 15000 },
			capabilities: { streams: 1, subscriptions: 1 },
			limits: { maxPayloadBytes: 10, maxCheckpointBytes: 20, rateBytesPerSec: 30, burstBytes: 40, feedDefaultLimit: 50, readDefaultBytes: 60, readBatchMaxStreams: 70, maxSubscriptions: 128 },
		}));
		assert.deepEqual(full, {
			type: "VAULT_READY", vaultEpoch: "E1", head: 42, canWrite: true, deviceId: "dev", runtimeEpoch: "R",
			liveness: { idleMs: 60000, timeoutMs: 15000 },
			limits: { maxPayloadBytes: 10, maxCheckpointBytes: 20, rateBytesPerSec: 30, burstBytes: 40, feedDefaultLimit: 50, readDefaultBytes: 60, readBatchMaxStreams: 70, maxSubscriptions: 128 },
			subscriptions: 1,
		});
		const bare = parseControl(CONTROL_PREFIX + JSON.stringify({ type: "VAULT_READY", vaultEpoch: "E", head: 0, limits: { maxPayloadBytes: -1 } }));
		assert.ok(bare && bare.type === "VAULT_READY");
		assert.equal(bare.canWrite, false);
		assert.equal(bare.liveness, null);
		assert.equal(bare.limits.maxPayloadBytes, null);
		assert.equal(bare.limits.maxSubscriptions, null);
		assert.equal(bare.subscriptions, null, "no capabilities: no subscriptions");
		assert.equal(parseControl(CONTROL_PREFIX + JSON.stringify({ type: "VAULT_READY", head: 1 })), null, "vaultEpoch required");
	});

	it("parses receipts, rejects malformed receipt lists", () => {
		const r = parseControl(CONTROL_PREFIX + JSON.stringify({
			type: "STREAM_RECEIPTS", head: 9,
			receipts: [{ stream: "ns", clientFrameId: "a", seq: 8, deduped: false }, { stream: "b:x", clientFrameId: "b", seq: 3, deduped: true }],
		}));
		assert.deepEqual(r, {
			type: "STREAM_RECEIPTS", head: 9,
			receipts: [{ stream: "ns", clientFrameId: "a", seq: 8, deduped: false }, { stream: "b:x", clientFrameId: "b", seq: 3, deduped: true }],
		});
		assert.equal(parseControl(CONTROL_PREFIX + JSON.stringify({ type: "STREAM_RECEIPTS", head: 9, receipts: [{ stream: "ns" }] })), null);
	});

	it("parses the remaining server controls", () => {
		const p = (o: Record<string, unknown>) => parseControl(CONTROL_PREFIX + JSON.stringify(o));
		assert.deepEqual(p({ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "a", code: "client_frame_id_conflict", seq: 4 }),
			{ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "a", code: "client_frame_id_conflict", seq: 4 });
		assert.deepEqual(p({ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "a", code: "write_forbidden" }),
			{ type: "STREAM_APPEND_REJECTED", stream: "ns", clientFrameId: "a", code: "write_forbidden", seq: null });
		assert.deepEqual(p({ type: "STREAM_PROVISIONAL_DROPPED", stream: "b:x", deviceId: "d", clientFrameId: "c", reason: "commit_failed" }),
			{ type: "STREAM_PROVISIONAL_DROPPED", stream: "b:x", deviceId: "d", clientFrameId: "c", reason: "commit_failed" });
		assert.deepEqual(p({ type: "STREAM_RESEND", reason: "runtime_restarted", runtimeEpoch: "R2", head: 7 }),
			{ type: "STREAM_RESEND", head: 7, runtimeEpoch: "R2" });
		assert.deepEqual(p({ type: "VAULT_PONG", probeId: "x", head: 3 }), { type: "VAULT_PONG", probeId: "x", head: 3 });
		assert.deepEqual(p({ type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" }), { type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" });
		assert.deepEqual(p({ type: "VAULT_ERROR", code: "cf_daily_limit", kind: "rows-written", resetAt: 123, stream: "ns", clientFrameIds: ["a", 5, "b"] }),
			{ type: "VAULT_ERROR", code: "cf_daily_limit", stream: "ns", clientFrameIds: ["a", "b"], resetAt: 123, kind: "rows-written" });
		assert.deepEqual(p({ type: "error", code: "authority_superseded", reason: "revoked" }), { type: "error", code: "authority_superseded", reason: "revoked" });
		assert.equal(p({ type: "VAULT_PONG", head: -1 }), null);
		assert.equal(p({ type: "error" }), null);
	});
});
