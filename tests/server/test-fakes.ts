// The Node fakes behave like the Cloudflare runtime where the server depends on it, and the conformance suite's
// standalone wire codec (e2e/conformance/lib/codec.ts) agrees with the server's (server/src/streams/protocol.ts).
// A fake that is laxer than the runtime, or a codec copy that drifted, lets a suite pass on behaviour Cloudflare or a
// real client would refuse.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";

import * as spec from "../../e2e/conformance/lib/codec.ts";
import {
	MAX_STREAM_SUBSCRIPTIONS,
	STREAM_FRAME_APPEND,
	STREAM_FRAME_COMMITTED,
	STREAM_FRAME_COMMIT_NOTICE,
	STREAM_FRAME_PROVISIONAL,
	STREAM_FRAME_SKIPPED,
	STREAM_READ_BINARY_TYPE,
	SUBSCRIPTION_ATTACHMENT_BYTES,
	decodeAppendFrame,
	decodeServerFrame,
	encodeCommitNotice,
	encodeCommitted,
	encodeProvisional,
	encodeReadReply,
	encodeSkipped,
	type StreamReadReplyPage,
} from "../../server/src/streams/protocol";
import { suite } from "../harness.ts";
import { FakeRegistry, FakeSocket, MAX_SOCKET_ATTACHMENT_BYTES, RecordingUpgrades } from "./helpers/fakePorts.ts";
import { DO_SQL_MAX_BINDINGS, NodeSqliteStorage } from "./helpers/nodeSqliteStorage.ts";
import { VaultCluster, newDevice, newVaultId } from "./helpers/workerHarness.ts";

const s = suite("test-fakes");

const bytes = (value: string) => new TextEncoder().encode(value);

// ---- sockets ------------------------------------------------------------------------------------------------------

s.test("FakeSocket: send after close throws; close codes and reasons are checked as WebSocket.close() does", () => {
	const socket = new FakeSocket();
	assert.throws(() => socket.close(1006, "reserved"), /close code 1006/);
	assert.throws(() => socket.close(1005), /close code 1005/);
	assert.throws(() => socket.close(2000), /close code 2000/);
	assert.throws(() => socket.close(1000, "x".repeat(124)), /reason/);
	socket.close(4403, "x".repeat(123));
	assert.throws(() => socket.send("__YPS:{}"), /after close/);
	assert.throws(() => new RecordingUpgrades().reject("__YPS:{\"type\":\"error\"}", 1015, "tls"), /close code 1015/);
});

s.test("FakeSocket: attachments over the hibernation limit throw; each deserialize is a fresh copy", () => {
	const socket = new FakeSocket();
	assert.throws(() => socket.serializeAttachment({ blob: "x".repeat(MAX_SOCKET_ATTACHMENT_BYTES) }), /limit/);
	socket.serializeAttachment({ list: [1] });
	const first = socket.deserializeAttachment() as { list: number[] };
	first.list.push(2);
	assert.deepEqual(socket.deserializeAttachment(), { list: [1] }, "a caller's edit does not reach the stored attachment");
});

s.test("FakeRegistry: like getWebSockets(), a closed socket stays listed until its close completes", () => {
	const registry = new FakeRegistry();
	const { server } = registry.createPair();
	registry.accept(server);
	assert.throws(() => registry.accept(server), /already accepted/);
	server.close(1000, "bye");
	assert.deepEqual(registry.sockets(), [server]);
	registry.completeCloses();
	assert.deepEqual(registry.sockets(), []);
});

s.test("relay: the largest subscription it persists keeps the socket attachment under the Cloudflare limit", async () => {
	const cluster = new VaultCluster();
	try {
		const vaultId = newVaultId();
		const device = newDevice("device-sub");
		const object = await cluster.seed(vaultId, [device]);
		assert.equal(object.host.acceptStreams(device.deviceId).status, 200);
		const socket = object.registry.lastClient!;
		// Distinct b: names until the JSON is just at the persisted cap.
		const streams: string[] = [];
		for (let i = 0; i < MAX_STREAM_SUBSCRIPTIONS; i++) {
			const next = [...streams, `b:${String(i).padStart(4, "0")}-${"n".repeat(40)}`];
			if (Buffer.byteLength(JSON.stringify(next)) > SUBSCRIPTION_ATTACHMENT_BYTES) break;
			streams.push(next.at(-1)!);
		}
		object.host.webSocketMessage(socket, `__YPS:${JSON.stringify({ type: "STREAM_SUBSCRIBE", streams })}`);
		assert.equal(socket.closed, null, "the subscribe was accepted");
		const attachment = socket.deserializeAttachment() as { subs?: string[] };
		assert.deepEqual(attachment.subs, streams, "the set was persisted");
		assert.ok(serialize(attachment).byteLength <= MAX_SOCKET_ATTACHMENT_BYTES);
	} finally {
		cluster.close();
	}
});

// ---- Durable Object SQL -------------------------------------------------------------------------------------------

s.test("NodeSqliteStorage: refuses what Durable Object SQL refuses (bindings > 100, BEGIN/SAVEPOINT, bigint)", () => {
	const directory = mkdtempSync(join(tmpdir(), "yaos-fakes-"));
	const storage = NodeSqliteStorage.open(join(directory, "db.sqlite"));
	try {
		storage.sql.exec("CREATE TABLE t (v)");
		const ok = Array.from({ length: DO_SQL_MAX_BINDINGS }, (_, i) => i);
		storage.sql.exec(`SELECT ${ok.map(() => "?").join(", ")}`, ...ok).toArray();
		const over = [...ok, 100];
		assert.throws(() => storage.sql.exec(`SELECT ${over.map(() => "?").join(", ")}`, ...over), /too many SQL variables/);
		for (const statement of ["BEGIN", "SAVEPOINT x", "COMMIT", "ROLLBACK", "RELEASE x"]) {
			assert.throws(() => storage.sql.exec(statement), /transactionSync/, statement);
		}
		assert.throws(() => storage.sql.exec("INSERT INTO t VALUES (?)", 1n), /unsupported SQLite binding/);
		assert.throws(() => storage.sql.exec("INSERT INTO t VALUES (?)", true), /unsupported SQLite binding/);
		storage.transactionSync(() => storage.transactionSync(() => storage.sql.exec("INSERT INTO t VALUES (1)")));
		assert.equal(storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM t").one().n, 1, "transactionSync still nests");
	} finally {
		storage.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

// ---- conformance codec vs server codec ----------------------------------------------------------------------------

const BIG = 2 ** 40 + 7;

s.test("codec: the conformance decoder reads every server frame kind as the server's decoder does", () => {
	const identity = { stream: "b:é-doc", deviceId: "device-ü", clientFrameId: "cf-1" };
	const payload = new Uint8Array([0, 1, 255]);
	const frames = [
		encodeProvisional({ ...identity, payload }),
		encodeProvisional({ ...identity, payload: new Uint8Array(0) }),
		encodeCommitted({ ...identity, seq: BIG, payload }),
		encodeCommitNotice({ ...identity, seq: 1 }),
		encodeSkipped([{ stream: "b:a", seqs: [1, 2, 300] }, { stream: "c:z", seqs: [BIG] }]),
	];
	for (const frame of frames) {
		const server = decodeServerFrame(frame);
		const conformance = spec.decodeServerFrame(frame);
		assert.equal(conformance.kind, server.kind);
		if (server.kind === "skipped") {
			assert.deepEqual(conformance.runs, server.runs);
			continue;
		}
		assert.deepEqual(
			{ stream: conformance.stream, deviceId: conformance.deviceId, clientFrameId: conformance.clientFrameId },
			{ stream: server.stream, deviceId: server.deviceId, clientFrameId: server.clientFrameId });
		assert.equal(conformance.seq, "seq" in server ? server.seq : null);
		assert.deepEqual(conformance.payload, "payload" in server ? server.payload : null);
	}
	assert.deepEqual([spec.APPEND, spec.PROVISIONAL, spec.COMMITTED, spec.NOTICE, spec.SKIPPED],
		[STREAM_FRAME_APPEND, STREAM_FRAME_PROVISIONAL, STREAM_FRAME_COMMITTED, STREAM_FRAME_COMMIT_NOTICE, STREAM_FRAME_SKIPPED]);
	// The conformance decoder is the strict one: a trailing byte is a malformed frame.
	const trailing = new Uint8Array([...frames[3]!, 0]);
	assert.throws(() => spec.decodeServerFrame(trailing), /trailing/);
});

s.test("codec: the conformance APPEND encoder (and its raw builder) produce frames the server decodes", () => {
	const payload = new Uint8Array(70_000).fill(7);
	const decoded = decodeAppendFrame(spec.encodeAppend("b:é-doc", "cf-ü", payload));
	assert.ok(!("error" in decoded), JSON.stringify(decoded));
	assert.equal(decoded.stream, "b:é-doc");
	assert.equal(decoded.clientFrameId, "cf-ü");
	assert.deepEqual(decoded.payload, payload);
	const raw = spec.rawAppend({ stream: spec.utf8Bytes("ns"), id: spec.utf8Bytes("f"), payload: [1, 2] });
	assert.ok(!("error" in decodeAppendFrame(raw)));
	assert.deepEqual(decodeAppendFrame(spec.rawAppend({ stream: spec.utf8Bytes("ns"), id: spec.utf8Bytes("f"), payload: [1],
		trailing: [0] })), { error: "malformed_frame" });
});

s.test("codec: the conformance decoder reads server read replies (checkpoint, nextAfter null and set, big seqs)", () => {
	const pages: StreamReadReplyPage[] = [
		{ stream: "ns", lastSeq: BIG, checkpointSeq: 5, gcSeq: 3, nextAfter: null,
			checkpoint: { coversSeq: 5, bytes: new Uint8Array([9, 9]) },
			rows: [{ seq: 6, deviceId: "d", clientFrameId: "c", payload: bytes("row") }] },
		{ stream: "b:é", lastSeq: 0, checkpointSeq: 0, gcSeq: 0, nextAfter: 0, checkpoint: null, rows: [] },
		{ stream: "c:x", lastSeq: 9, checkpointSeq: 0, gcSeq: 0, nextAfter: BIG, checkpoint: null,
			rows: [{ seq: 1, deviceId: "", clientFrameId: "", payload: new Uint8Array(0) }] },
	];
	const encoded = encodeReadReply("epoch-ü", BIG, pages);
	assert.deepEqual(spec.decodeReadReply(encoded), { vaultEpoch: "epoch-ü", head: BIG, pages });
	assert.equal(spec.READ_BINARY_TYPE, STREAM_READ_BINARY_TYPE);
	assert.throws(() => spec.decodeReadReply(new Uint8Array([...encoded, 0])), /trailing/);
});

await s.done();
