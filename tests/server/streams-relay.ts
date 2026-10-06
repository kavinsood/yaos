// Client remake: opaque streams relay (YAOS_STREAMS, server/src/streams/).
// Real SQLite (NodeSqliteStorage) under StreamStore + StreamRelayService with
// fake sockets and virtual timers. Row accounting uses the Cloudflare billing
// model (helpers/cfRowModel.ts). Wire contract: docs/client-remake/relay-wire.md.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSqliteStorage } from "./helpers/nodeSqliteStorage";
import { base64ToBytes } from "../../server/src/base64url";
import { DailyLimitLatch } from "../../server/src/dailyLimit";
import { classifyWorkerRoute } from "../../server/src/index";
import { getCapabilities } from "../../server/src/routes/auth";
import { createTicket, handleTicketRoute, inspectTicket } from "../../server/src/routes/ticket";
import type { AuthState, Env } from "../../server/src/routes/types";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext } from "../../server/src/collaboration";
import {
	MAX_STREAM_BINARY_MESSAGE_BYTES,
	MAX_STREAM_PAYLOAD_BYTES,
	decodeAppendFrame,
	decodeRows,
	decodeServerFrame,
	encodeAppendFrame,
	encodeCommitNotice,
	encodeCommitted,
	encodeProvisional,
	encodeRow,
	streamsEnabled,
} from "../../server/src/streams/protocol";
import {
	DEFAULT_STREAM_RELAY_CONFIG,
	StreamRelayService,
	readStreamRelayConfig,
	type StreamRelayConfig,
	type StreamTimers,
} from "../../server/src/streams/relay";
import { STREAM_SEGMENT_SEAL_BYTES, StreamStore, type StreamStoragePort } from "../../server/src/streams/store";
import type { VaultSocketPort, VaultSocketRegistryPort } from "../../server/src/vaultSocketService";
import { CfRowModel } from "./helpers/cfRowModel.ts";
import { suite } from "../harness.ts";

const s = suite("streams-relay");

const VAULT_ID = "streams-vault-0001";
const GENERATION = "streams-generation-0001";

const ownerA: VaultActorContext = { vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "principal-a",
	membershipRevision: 1, deviceId: "device-a", deviceCredentialRevision: 1, role: "owner",
	policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest: "digest" };
const deviceB: VaultActorContext = { ...ownerA, deviceId: "device-b" };
const deviceC: VaultActorContext = { ...ownerA, deviceId: "device-c" };

type Control = Record<string, unknown> & { type: string };

class FakeSocket implements VaultSocketPort {
	readonly binary: Uint8Array[] = [];
	readonly controls: Control[] = [];
	closed: { code?: number; reason?: string } | null = null;
	attachment: unknown = null;
	close(code?: number, reason?: string): void { this.closed ??= { code, reason }; }
	deserializeAttachment(): unknown { return this.attachment; }
	serializeAttachment(value: unknown): void { this.attachment = structuredClone(value); }
	send(message: ArrayBuffer | ArrayBufferView | string): void {
		if (this.closed) throw new Error("socket closed");
		if (typeof message === "string") {
			assert.ok(message.startsWith("__YPS:"), "control frames carry the __YPS: prefix");
			this.controls.push(JSON.parse(message.slice(6)) as Control);
		} else {
			const view = message instanceof ArrayBuffer ? new Uint8Array(message)
				: new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
			this.binary.push(view.slice());
		}
	}
	all(type: string): Control[] { return this.controls.filter((value) => value.type === type); }
	last(type: string): Control | undefined { return this.all(type).at(-1); }
	frames() { return this.binary.map((bytes) => decodeServerFrame(bytes)); }
	receipts(): Array<{ stream: string; clientFrameId: string; seq: number; deduped: boolean }> {
		return this.all("STREAM_RECEIPTS").flatMap((value) => value.receipts as never[]);
	}
}

class FakeRegistry implements VaultSocketRegistryPort {
	readonly list: FakeSocket[] = [];
	lastClient: FakeSocket | null = null;
	sockets(): readonly VaultSocketPort[] { return this.list.filter((socket) => !socket.closed); }
	createPair() { const server = new FakeSocket(); return { client: server, server }; }
	accept(socket: VaultSocketPort): void { this.list.push(socket as FakeSocket); }
	upgradeResponse(client: unknown): Response { this.lastClient = client as FakeSocket; return new Response(null, { status: 200 }); }
}

class VirtualTimers implements StreamTimers {
	now = 1_000_000;
	private nextId = 0;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();
	set(callback: () => void, ms: number): unknown {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.now + ms, callback });
		return id;
	}
	clear(handle: unknown): void { this.timers.delete(handle as number); }
	pending(): number { return this.timers.size; }
	advance(ms: number): void {
		const end = this.now + ms;
		for (;;) {
			let due: [number, { at: number; callback: () => void }] | null = null;
			for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
			if (!due) break;
			this.timers.delete(due[0]);
			this.now = due[1].at;
			due[1].callback();
		}
		this.now = end;
	}
}

const DAILY_LIMIT_MESSAGE = "Exceeded allowed rows written in Durable Objects free tier.";

interface Harness {
	service: StreamRelayService;
	store: StreamStore;
	registry: FakeRegistry;
	timers: VirtualTimers;
	model: CfRowModel;
	latch: DailyLimitLatch;
	revoked: Set<string>;
	failWrites: { on: boolean };
	connect(actor?: VaultActorContext, canWrite?: boolean): FakeSocket;
	append(socket: FakeSocket, stream: string, clientFrameId: string, payload: Uint8Array | string): void;
	/** A new runtime over the same storage and sockets (hibernation wake / eviction). */
	fresh(runtimeEpoch: string): StreamRelayService;
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function text(value: Uint8Array): string { return new TextDecoder().decode(value); }
function arrayBuffer(value: Uint8Array): ArrayBuffer {
	return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function withStreams(check: (harness: Harness) => void | Promise<void>, config: Partial<StreamRelayConfig> = {}): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-streams-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const model = new CfRowModel(sqlite);
	const failWrites = { on: false };
	const storage: StreamStoragePort = {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => {
				if (failWrites.on && /^\s*(INSERT|UPDATE|DELETE)/i.test(query)) throw new Error(DAILY_LIMIT_MESSAGE);
				return model.exec(query, ...bindings) as never;
			},
		},
		transactionSync: (closure) => sqlite.transactionSync(closure),
	};
	const timers = new VirtualTimers();
	const latch = new DailyLimitLatch(() => timers.now);
	const registry = new FakeRegistry();
	const revoked = new Set<string>();
	const store = new StreamStore(storage);
	const resolved = { ...DEFAULT_STREAM_RELAY_CONFIG, ...config };
	const make = (runtimeEpoch: string) => new StreamRelayService({
		config: resolved,
		store: () => store,
		sockets: registry,
		sendControl: (socket, value) => { try { socket.send(`__YPS:${JSON.stringify(latch.decorateControl(value))}`); } catch { /* closed */ } },
		validateActor: (actor) => !revoked.has(actor.deviceId),
		dailyLimitActive: () => latch.active(),
		noteCommitError: (error) => { latch.note(error); },
		vaultId: () => VAULT_ID,
		vaultGeneration: () => GENERATION,
		runtimeEpoch,
		now: () => timers.now,
		timers,
	});
	const harness: Harness = {
		service: make("runtime-a"),
		store, registry, timers, model, latch, revoked, failWrites,
		connect(actor = ownerA, canWrite = true) {
			const response = harness.service.accept(actor, canWrite);
			assert.equal(response.status, 200, "accepted");
			const socket = registry.lastClient!;
			registry.lastClient = null;
			return socket;
		},
		append(socket, stream, clientFrameId, payload) {
			const frame = encodeAppendFrame({ stream, clientFrameId, payload: typeof payload === "string" ? bytes(payload) : payload });
			harness.service.message(socket, arrayBuffer(frame));
		},
		fresh(runtimeEpoch) { harness.service = make(runtimeEpoch); return harness.service; },
	};
	try {
		await check(harness);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

// ---- codec ------------------------------------------------------------------

s.test("codec: APPEND round-trips; malformed, trailing, invalid names and oversize payloads are typed errors", () => {
	const frame = { stream: "b:doc-1", clientFrameId: "cf-1", payload: bytes("hello") };
	const decoded = decodeAppendFrame(encodeAppendFrame(frame));
	assert.ok(!("error" in decoded));
	assert.equal(decoded.stream, "b:doc-1");
	assert.equal(decoded.clientFrameId, "cf-1");
	assert.equal(text(decoded.payload), "hello");
	const encoded = encodeAppendFrame(frame);
	const trailing = new Uint8Array(encoded.byteLength + 1);
	trailing.set(encoded);
	assert.deepEqual(decodeAppendFrame(trailing), { error: "malformed_frame" });
	assert.deepEqual(decodeAppendFrame(encoded.subarray(0, encoded.byteLength - 2)), { error: "malformed_frame" });
	assert.deepEqual(decodeAppendFrame(new Uint8Array(0)), { error: "malformed_frame" });
	assert.deepEqual(decodeAppendFrame(new Uint8Array([0x7f])), { error: "unknown_frame_kind" });
	assert.deepEqual(decodeAppendFrame(encodeAppendFrame({ ...frame, stream: "" })), { error: "invalid_stream" });
	assert.deepEqual(decodeAppendFrame(encodeAppendFrame({ ...frame, stream: "x".repeat(257) })), { error: "invalid_stream" });
	assert.deepEqual(decodeAppendFrame(encodeAppendFrame({ ...frame, clientFrameId: "" })), { error: "invalid_client_frame_id" });
	assert.deepEqual(decodeAppendFrame(encodeAppendFrame({ ...frame, payload: new Uint8Array(MAX_STREAM_PAYLOAD_BYTES + 1) })),
		{ error: "payload_too_large" });
	const identity = { stream: "ns", deviceId: "device-a", clientFrameId: "cf-2" };
	assert.deepEqual(decodeServerFrame(encodeProvisional({ ...identity, payload: bytes("p") })),
		{ kind: "provisional", ...identity, payload: bytes("p") });
	assert.deepEqual(decodeServerFrame(encodeCommitted({ ...identity, seq: 300, payload: bytes("c") })),
		{ kind: "committed", seq: 300, ...identity, payload: bytes("c") });
	assert.deepEqual(decodeServerFrame(encodeCommitNotice({ ...identity, seq: 301 })), { kind: "notice", seq: 301, ...identity });
	const rows = [{ seq: 1, deviceId: "d", clientFrameId: "a", payload: bytes("x") }, { seq: 9, deviceId: "e", clientFrameId: "b", payload: new Uint8Array(0) }];
	const blob = new Uint8Array([...encodeRow(rows[0]!), ...encodeRow(rows[1]!)]);
	assert.deepEqual(decodeRows(blob).map((row) => ({ ...row, payload: [...row.payload] })),
		rows.map((row) => ({ ...row, payload: [...row.payload] })));
});

s.test("flag, capabilities, routes and config: inert unless YAOS_STREAMS is exactly \"true\"", () => {
	assert.equal(streamsEnabled({ YAOS_STREAMS: "true" }), true);
	assert.equal(streamsEnabled({ YAOS_STREAMS: "1" }), false);
	assert.equal(streamsEnabled({}), false);
	const auth: AuthState = { mode: "unclaimed", claimed: false };
	const off = getCapabilities(auth, {} as Env);
	assert.equal("streams" in off, false, "flag-off capabilities unchanged");
	assert.equal(getCapabilities(auth, { YAOS_STREAMS: "true" } as Env).streams, 1);
	const base = "https://example.test/vault/vault-route-0001";
	for (const [method, path] of [["GET", "/ws/streams"], ["GET", "/streams/feed"], ["GET", "/streams/read"], ["PUT", "/streams/checkpoint"]] as const) {
		const request = new Request(`${base}${path}`, { method });
		assert.equal(classifyWorkerRoute(request, new URL(request.url), false, false).kind, "not-found", `${method} ${path} off`);
		assert.equal(classifyWorkerRoute(request, new URL(request.url), false, true).kind, "vault", `${method} ${path} on`);
	}
	for (const [method, path] of [["POST", "/streams/feed"], ["GET", "/streams/checkpoint"], ["GET", "/streams/other"], ["GET", "/ws/streams/x"]] as const) {
		const request = new Request(`${base}${path}`, { method });
		assert.equal(classifyWorkerRoute(request, new URL(request.url), false, true).kind, "not-found", `${method} ${path}`);
	}
	const config = readStreamRelayConfig({ YAOS_STREAMS: "true", YAOS_STREAMS_BURST_BYTES: "10" });
	assert.equal(config.burstBytes, MAX_STREAM_BINARY_MESSAGE_BYTES, "burst floored at one max message");
	assert.equal(config.gcIdleMs, 300);
	assert.equal(config.gcMaxMs, 1500);
	assert.equal(config.gcMaxBytes, 64 * 1024);
});

s.test("tickets: purpose streams signs and inspects; other scopes do not open a streams socket", async () => {
	const auth: AuthState = { mode: "claim", claimed: true, operatorRecoveryHash: "hash", ticketSigningKey: "streams-test-key" };
	const actor = { ...ownerA, capabilityDigest: await capabilityDigestForRole("owner") };
	const response = await handleTicketRoute(new Request("https://example.test/ticket", { method: "POST",
		body: JSON.stringify({ purpose: "streams" }) }), auth, actor, (body, status = 200) => Response.json(body, { status }));
	assert.equal(response.status, 200);
	const { ticket } = await response.json() as { ticket: string };
	const payload = await inspectTicket(ticket, auth, { vaultId: VAULT_ID, purpose: "streams", documentId: "streams" });
	assert.equal(payload?.purpose, "streams");
	assert.equal(payload?.deviceId, "device-a");
	assert.equal(await inspectTicket(ticket, auth, { vaultId: VAULT_ID, purpose: "root", documentId: "root" }), null);
	const root = await createTicket(auth, actor, { purpose: "root", documentId: "root", rootEpoch: 1 });
	assert.equal(await inspectTicket(root.ticket, auth, { vaultId: VAULT_ID, purpose: "streams", documentId: "streams" }), null);
	const bad = await handleTicketRoute(new Request("https://example.test/ticket", { method: "POST",
		body: JSON.stringify({ purpose: "streams", documentId: "root" }) }), auth, actor, (body, status = 200) => Response.json(body, { status }));
	assert.equal(bad.status, 400);
	const body = await createTicket(auth, actor, { purpose: "body", documentId: "streams", bodyEpoch: 1 });
	assert.equal((await inspectTicket(body.ticket, auth, { vaultId: VAULT_ID, purpose: "body", documentId: "streams", bodyEpoch: 1 }))?.purpose,
		"body", "a body named \"streams\" keeps working");
});

// ---- live path ------------------------------------------------------------------

s.test("append: VAULT_READY, provisional b:, committed ns, contiguous seqs, receipts only after the commit", async () => {
	await withStreams(({ connect, append, timers }) => {
		const a = connect(ownerA);
		const b = connect(deviceB);
		const ready = a.last("VAULT_READY")!;
		assert.equal(ready.documentId, "streams");
		assert.equal(ready.vaultEpoch, GENERATION);
		assert.equal(ready.head, 0);
		assert.equal(ready.canWrite, true);
		assert.deepEqual(ready.capabilities, { streams: 1 });
		assert.equal((ready.limits as Record<string, unknown>).maxPayloadBytes, MAX_STREAM_PAYLOAD_BYTES);
		append(a, "ns", "a-1", "ns-one");
		append(a, "b:doc-1", "a-2", "body-one");
		append(a, "ns", "a-3", "ns-two");
		assert.equal(a.all("STREAM_RECEIPTS").length, 0, "no receipt before the commit");
		assert.deepEqual(b.frames().map((frame) => frame.kind), ["provisional"], "only b:/c: frames go out before the commit");
		assert.equal(a.binary.length, 0, "the origin gets no echo");
		timers.advance(299);
		assert.equal(a.all("STREAM_RECEIPTS").length, 0, "idle window not over");
		timers.advance(1);
		const receipts = a.last("STREAM_RECEIPTS")!;
		assert.equal(receipts.head, 3);
		assert.deepEqual(receipts.receipts, [
			{ stream: "ns", clientFrameId: "a-1", seq: 1, deduped: false },
			{ stream: "b:doc-1", clientFrameId: "a-2", seq: 2, deduped: false },
			{ stream: "ns", clientFrameId: "a-3", seq: 3, deduped: false },
		]);
		const frames = b.frames();
		assert.deepEqual(frames.map((frame) => [frame.kind, "seq" in frame ? frame.seq : null, frame.stream]), [
			["provisional", null, "b:doc-1"], ["committed", 1, "ns"], ["notice", 2, "b:doc-1"], ["committed", 3, "ns"],
		]);
		const ns = frames[1]!;
		assert.ok(ns.kind === "committed" && text(ns.payload) === "ns-one" && ns.deviceId === "device-a" && ns.clientFrameId === "a-1");
		const c = connect(deviceC);
		assert.equal(c.last("VAULT_READY")!.head, 3, "late joiners learn the head");
	});
});

s.test("group commit: idle re-arms, max age caps a busy stream, 64 KiB flushes at once", async () => {
	await withStreams(({ connect, append, timers, service }) => {
		const a = connect();
		for (let index = 0; index < 8; index++) { append(a, "ns", `busy-${index}`, "x"); timers.advance(200); }
		// t=1500 since the first frame: the max timer fired once, with 8 frames pending.
		assert.equal(service.counters.flushMax, 1);
		assert.equal(service.counters.flushIdle, 0);
		assert.equal(a.receipts().length, 8);
		append(a, "ns", "big", new Uint8Array(64 * 1024));
		assert.equal(service.counters.flushBytes, 1, "bytes threshold commits in the same turn");
		assert.equal(a.receipts().length, 9);
		append(a, "ns", "tail", "y");
		timers.advance(300);
		assert.equal(service.counters.flushIdle, 1);
		assert.equal(service.pendingFrames(), 0);
	});
	await withStreams(({ connect, append, timers, service }) => {
		const a = connect();
		append(a, "ns", "m-1", "x");
		timers.advance(300);
		append(a, "ns", "m-2", "x");
		timers.advance(300);
		assert.equal(service.counters.flushIdle, 1, "min interval delays the next idle commit");
		timers.advance(700);
		assert.equal(service.counters.flushIdle, 2);
	}, { gcMinIntervalMs: 1000 });
});

s.test("dedupe: pending resend shares the receipt, reconnect resend is deduped from storage, conflicts are rejected", async () => {
	await withStreams(({ connect, append, timers, store, registry }) => {
		const a = connect(ownerA);
		const b = connect(deviceB);
		append(a, "b:doc", "f-1", "one");
		append(a, "b:doc", "f-1", "one");
		append(a, "b:doc", "f-1", "different");
		assert.deepEqual(a.last("STREAM_APPEND_REJECTED"), { type: "STREAM_APPEND_REJECTED", stream: "b:doc",
			clientFrameId: "f-1", code: "client_frame_id_conflict" });
		timers.advance(300);
		assert.deepEqual(a.receipts(), [
			{ stream: "b:doc", clientFrameId: "f-1", seq: 1, deduped: false },
			{ stream: "b:doc", clientFrameId: "f-1", seq: 1, deduped: true },
		]);
		assert.equal(store.head(), 1);
		append(a, "ns", "f-2", "ns-payload");
		timers.advance(300);
		// Reconnect (receipts lost in flight): resend both.
		a.close(1006);
		const a2 = connect(ownerA);
		const before = b.binary.length;
		append(a2, "b:doc", "f-1", "one");
		append(a2, "ns", "f-2", "ns-payload");
		append(a2, "ns", "f-3", "new");
		timers.advance(300);
		assert.deepEqual(a2.receipts(), [
			{ stream: "b:doc", clientFrameId: "f-1", seq: 1, deduped: true },
			{ stream: "ns", clientFrameId: "f-2", seq: 2, deduped: true },
			{ stream: "ns", clientFrameId: "f-3", seq: 3, deduped: false },
		]);
		assert.equal(store.head(), 3, "no new seq for deduped resends");
		const fresh = b.frames().slice(before).map((frame) => [frame.kind, "seq" in frame ? frame.seq : null, frame.clientFrameId]);
		assert.deepEqual(fresh, [["provisional", null, "f-1"], ["notice", 1, "f-1"], ["committed", 3, "f-3"]],
			"a deduped ns resend is not re-delivered; a re-broadcast provisional is settled with its old seq");
		append(a2, "ns", "f-2", "tampered");
		timers.advance(300);
		assert.deepEqual(a2.last("STREAM_APPEND_REJECTED"), { type: "STREAM_APPEND_REJECTED", stream: "ns",
			clientFrameId: "f-2", code: "client_frame_id_conflict", seq: 2 });
		assert.equal(store.head(), 3);
		// Different devices may reuse a clientFrameId.
		append(b, "ns", "f-2", "from-b");
		timers.advance(300);
		assert.deepEqual(b.receipts(), [{ stream: "ns", clientFrameId: "f-2", seq: 4, deduped: false }]);
		assert.equal(registry.sockets().length, 2);
	});
});

s.test("late joiner: a socket admitted after the provisional gets COMMITTED, earlier ones a notice", async () => {
	await withStreams(({ connect, append, timers }) => {
		const a = connect(ownerA);
		const b = connect(deviceB);
		append(a, "c:canvas", "late-1", "canvas-update");
		const c = connect(deviceC);
		timers.advance(300);
		assert.deepEqual(b.frames().map((frame) => frame.kind), ["provisional", "notice"]);
		const [only] = c.frames();
		assert.ok(only?.kind === "committed" && only.seq === 1 && text(only.payload) === "canvas-update");
	});
});

// ---- HTTP: feed, read, checkpoint -----------------------------------------------

s.test("feed: streams changed after S, ascending by lastSeq, paginated, with the head", async () => {
	await withStreams(async ({ connect, append, timers, service }) => {
		const a = connect();
		for (const [index, stream] of ["ns", "b:1", "b:2", "c:3", "b:1", "meta"].entries()) append(a, stream, `feed-${index}`, "x");
		timers.advance(300);
		const page = async (query: string) => await service.feed(new URL(`https://do/streams/feed?${query}`)).json() as Record<string, unknown>;
		const all = await page("after=0");
		assert.equal(all.head, 6);
		assert.equal(all.vaultEpoch, GENERATION);
		assert.deepEqual(all.changes, [{ stream: "ns", lastSeq: 1 }, { stream: "b:2", lastSeq: 3 }, { stream: "c:3", lastSeq: 4 },
			{ stream: "b:1", lastSeq: 5 }, { stream: "meta", lastSeq: 6 }]);
		assert.equal(all.nextAfter, null);
		const first = await page("after=0&limit=2");
		assert.deepEqual(first.changes, [{ stream: "ns", lastSeq: 1 }, { stream: "b:2", lastSeq: 3 }]);
		assert.equal(first.nextAfter, 3);
		const second = await page("after=3&limit=2");
		assert.deepEqual(second.changes, [{ stream: "c:3", lastSeq: 4 }, { stream: "b:1", lastSeq: 5 }]);
		assert.deepEqual((await page("after=6")).changes, []);
		assert.equal(service.feed(new URL("https://do/streams/feed?after=-1")).status, 400);
		assert.equal(service.feed(new URL("https://do/streams/feed?limit=0")).status, 400);
	});
});

s.test("read: rows after S oldest first, byte-bounded pages, at least one row, across sealed segments", async () => {
	await withStreams(async ({ connect, append, timers, service, store }) => {
		const a = connect();
		for (let index = 0; index < 10; index++) append(a, "b:paged", `r-${index}`, new Uint8Array(100).fill(index));
		append(a, "ns", "other", "x");
		timers.advance(300);
		const read = async (query: string) => await service.read(new URL(`https://do/streams/read?${query}`)).json() as {
			rows: Array<{ seq: number; deviceId: string; clientFrameId: string; payload: string }>; nextAfter: number | null;
			lastSeq: number; checkpoint: unknown; head: number };
		let after = 0;
		const seen: number[] = [];
		for (let pages = 0; pages < 10; pages++) {
			const page = await read(`stream=b:paged&after=${after}&maxBytes=250`);
			assert.ok(page.rows.length <= 2);
			for (const row of page.rows) {
				seen.push(row.seq);
				assert.equal(base64ToBytes(row.payload)[0], row.seq - 1);
				assert.equal(row.deviceId, "device-a");
			}
			if (page.nextAfter === null) break;
			after = page.nextAfter;
		}
		assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const tiny = await read("stream=b:paged&after=0&maxBytes=1");
		assert.equal(tiny.rows.length, 1, "one row even when it exceeds the budget");
		assert.equal(tiny.nextAfter, 1);
		const empty = await read("stream=unknown&after=0");
		assert.deepEqual([empty.rows, empty.lastSeq, empty.nextAfter], [[], 0, null]);
		assert.equal(service.read(new URL("https://do/streams/read?after=0")).status, 400, "stream required");
		// Seal several segments (64 KiB each), then read across them.
		for (let index = 0; index < 5; index++) append(a, "b:big", `big-${index}`, new Uint8Array(40 * 1024).fill(index + 1));
		timers.advance(300);
		for (let index = 0; index < 3; index++) { append(a, "b:big", `big2-${index}`, new Uint8Array(40 * 1024).fill(index + 10)); timers.advance(300); }
		assert.ok(store.tableCounts().segments >= 2, "segments sealed");
		const bigSeqs: number[] = [];
		let cursor = 0;
		for (;;) {
			const page = await read(`stream=b:big&after=${cursor}&maxBytes=100000`);
			bigSeqs.push(...page.rows.map((row) => row.seq));
			if (page.nextAfter === null) break;
			cursor = page.nextAfter;
		}
		assert.equal(bigSeqs.length, 8);
		assert.deepEqual(bigSeqs, [...bigSeqs].sort((x, y) => x - y));
		const middle = await read(`stream=b:big&after=${bigSeqs[3]}&maxBytes=4000000`);
		assert.deepEqual(middle.rows.map((row) => row.seq), bigSeqs.slice(4), "a cursor inside a sealed segment resumes there");
	});
});

s.test("checkpoint: CAS ok, conflict, not advancing, ahead of stream; GC of sealed segments; reads after GC carry the checkpoint", async () => {
	await withStreams(async ({ connect, append, timers, service, store }) => {
		const a = connect();
		for (let index = 0; index < 4; index++) { append(a, "b:gc", `g-${index}`, new Uint8Array(40 * 1024).fill(index + 1)); timers.advance(300); }
		append(a, "b:gc", "g-tail", "tail");
		timers.advance(300);
		const segmentsBefore = store.tableCounts().segments;
		assert.ok(segmentsBefore >= 1);
		const put = async (query: string, body: Uint8Array) => {
			const response = await service.putCheckpoint(new Request(`https://do/streams/checkpoint?${query}`, { method: "PUT", body }),
				new URL(`https://do/streams/checkpoint?${query}`));
			return { status: response.status, body: await response.json() as Record<string, unknown> };
		};
		const ok = await put("stream=b:gc&coversSeq=4&expectedCoversSeq=0", bytes("checkpoint-at-4"));
		assert.equal(ok.status, 200);
		assert.equal(ok.body.coversSeq, 4);
		assert.ok((ok.body.deletedSegments as number) >= 1, "sealed segments at or below coversSeq are deleted");
		assert.ok((ok.body.gcSeq as number) >= 2 && (ok.body.gcSeq as number) <= 4);
		assert.ok(store.tableCounts().segments < segmentsBefore);
		const conflict = await put("stream=b:gc&coversSeq=5&expectedCoversSeq=0", bytes("stale"));
		assert.deepEqual(conflict, { status: 409, body: { error: "checkpoint_conflict", current: { coversSeq: 4 } } });
		assert.equal((await put("stream=b:gc&coversSeq=4&expectedCoversSeq=4", bytes("same"))).body.error, "checkpoint_not_advancing");
		assert.equal((await put("stream=b:gc&coversSeq=99&expectedCoversSeq=4", bytes("ahead"))).body.error, "checkpoint_ahead_of_stream");
		assert.equal((await put("stream=missing&coversSeq=1&expectedCoversSeq=0", bytes("x"))).status, 404);
		assert.equal((await put("stream=b:gc&coversSeq=0&expectedCoversSeq=0", bytes("x"))).status, 400);
		const read = async (query: string) => await service.read(new URL(`https://do/streams/read?${query}`)).json() as {
			checkpoint: { coversSeq: number; bytes: string } | null; rows: Array<{ seq: number }>; gcSeq: number; checkpointSeq: number };
		const cold = await read("stream=b:gc&after=0");
		assert.equal(cold.checkpoint?.coversSeq, 4);
		assert.equal(text(base64ToBytes(cold.checkpoint!.bytes)), "checkpoint-at-4");
		assert.deepEqual(cold.rows.map((row) => row.seq), [5], "rows resume after the checkpoint");
		const warm = await read("stream=b:gc&after=4");
		assert.equal(warm.checkpoint, null, "a reader past gcSeq gets rows only");
		const next = await put("stream=b:gc&coversSeq=5&expectedCoversSeq=4", new Uint8Array(0));
		assert.equal(next.status, 200, "an empty checkpoint is allowed");
		assert.equal(next.body.deletedSegments, 0, "the open segment (retain window) is never collected");
		assert.equal(store.tableCounts().checkpointChunks, 1, "the previous checkpoint is replaced");
		const gcSeq = next.body.gcSeq as number;
		assert.ok(gcSeq < 5);
		assert.deepEqual((await read(`stream=b:gc&after=${gcSeq}`)).rows.map((row) => row.seq).at(-1), 5, "rows only past gcSeq");
		const preferred = await read(`stream=b:gc&after=${gcSeq}&checkpoint=1`);
		assert.equal(preferred.checkpoint?.coversSeq, 5, "checkpoint=1 asks for it when after < checkpointSeq");
		assert.deepEqual(preferred.rows, []);
	});
});

// ---- authority, admission, daily limit ------------------------------------------

s.test("authority: revoked actors get authority_superseded + 4403; read-only sockets get write_forbidden", async () => {
	await withStreams(({ connect, append, revoked, service, timers }) => {
		const a = connect(ownerA);
		const b = connect(deviceB);
		const reader = connect(deviceC, false);
		assert.equal(reader.last("VAULT_READY")!.canWrite, false);
		append(reader, "ns", "ro-1", "x");
		assert.deepEqual(reader.last("STREAM_APPEND_REJECTED"), { type: "STREAM_APPEND_REJECTED", stream: "ns",
			clientFrameId: "ro-1", code: "write_forbidden" });
		append(a, "ns", "before", "x");
		revoked.add("device-a");
		append(a, "ns", "after", "y");
		assert.equal(a.last("error")!.code, "authority_superseded");
		assert.equal(a.closed?.code, 4403);
		service.flushForAuthorityFence();
		assert.equal(a.receipts().length, 0, "the closed socket missed its receipt (resend dedupes)");
		assert.deepEqual(b.frames().map((frame) => frame.kind === "committed" ? frame.clientFrameId : frame.kind), ["before"],
			"frames admitted before the revoke commit; later ones never go out");
		assert.equal(service.accept(ownerA, true).status, 409, "a revoked device cannot reconnect");
		assert.equal(service.closeDevice("device-b"), 1);
		assert.equal(b.closed?.code, 4403);
		timers.advance(1000);
	});
});

s.test("admission: rate overdraft sends VAULT_BACKPRESSURE and closes 1013; oversize closes 1009; malformed 1008", async () => {
	await withStreams(({ connect, append, service }) => {
		const a = connect();
		append(a, "ns", "r-1", new Uint8Array(900));
		append(a, "ns", "r-2", new Uint8Array(900));
		append(a, "ns", "r-3", new Uint8Array(900));
		assert.equal(a.last("VAULT_BACKPRESSURE")?.reason, "relay_rate_limit");
		assert.equal(a.closed?.code, 1013);
		append(a, "ns", "r-4", "x");
		assert.equal(service.counters.rawDrops, 1, "later messages are dropped");
		assert.equal(service.pendingFrames(), 2, "frames admitted before the overdraft still commit");
	}, { burstBytes: 2000, rateBytesPerSec: 1000 });
	await withStreams(({ connect, service }) => {
		const a = connect();
		service.message(a, new ArrayBuffer(MAX_STREAM_BINARY_MESSAGE_BYTES + 1));
		assert.equal(a.closed?.code, 1009);
		const b = connect(deviceB);
		service.message(b, new Uint8Array([0x01, 0xff]).buffer);
		assert.equal(b.closed?.code, 1008);
		const c = connect(deviceC);
		service.message(c, `__YPS:${JSON.stringify({ type: "VAULT_PING", probeId: "probe-1" })}`);
		assert.deepEqual(c.last("VAULT_PONG"), { type: "VAULT_PONG", probeId: "probe-1", documentId: "streams",
			vaultGeneration: GENERATION, runtimeEpoch: "runtime-a", head: 0 });
		service.message(c, "not a control frame");
		assert.equal(c.closed, null, "unknown text is ignored");
	});
});

s.test("daily limit: a failed commit answers cf_daily_limit (cause durability_failed), drops provisionals, then rejects at once", async () => {
	await withStreams(({ connect, append, timers, failWrites, latch, store }) => {
		const a = connect(ownerA);
		const b = connect(deviceB);
		append(a, "b:doc", "d-1", "x");
		append(a, "ns", "d-2", "y");
		failWrites.on = true;
		timers.advance(300);
		const error = a.last("VAULT_ERROR")!;
		assert.equal(error.code, "cf_daily_limit");
		assert.equal(error.cause, "durability_failed");
		assert.equal(typeof error.resetAt, "number");
		assert.deepEqual(a.all("VAULT_ERROR").map((value) => [value.stream, value.clientFrameIds]), [["b:doc", ["d-1"]], ["ns", ["d-2"]]]);
		assert.deepEqual(b.last("STREAM_PROVISIONAL_DROPPED"), { type: "STREAM_PROVISIONAL_DROPPED", stream: "b:doc",
			deviceId: "device-a", clientFrameId: "d-1", reason: "commit_failed" });
		assert.equal(store.head(), 0, "nothing was written");
		append(a, "ns", "d-3", "z");
		assert.equal(a.last("VAULT_ERROR")!.code, "cf_daily_limit", "rejected before buffering while latched");
		failWrites.on = false;
		latch.clear();
		append(a, "b:doc", "d-1", "x");
		timers.advance(300);
		assert.deepEqual(a.receipts().map((receipt) => [receipt.clientFrameId, receipt.seq]), [["d-1", 1]]);
	});
});

s.test("restart: sockets from an earlier runtime get STREAM_RESEND; resends after an eviction dedupe", async () => {
	await withStreams((harness) => {
		const { connect, append, timers, fresh, store } = harness;
		const a = connect(ownerA);
		const b = connect(deviceB);
		append(a, "ns", "w-1", "committed");
		timers.advance(300);
		append(a, "ns", "w-2", "lost");
		assert.equal(timers.pending() > 0, true);
		// Eviction: the buffered frame (and its timers) are gone with the isolate; no receipt was sent.
		assert.equal(harness.service.dropPending(), 1);
		const service = fresh("runtime-b");
		service.ensureWakeNotice();
		for (const socket of [a, b]) {
			const resend = socket.last("STREAM_RESEND")!;
			assert.deepEqual(resend, { type: "STREAM_RESEND", reason: "runtime_restarted", runtimeEpoch: "runtime-b", head: 1 });
		}
		service.ensureWakeNotice();
		assert.equal(a.all("STREAM_RESEND").length, 1, "once per runtime");
		append(a, "ns", "w-1", "committed");
		append(a, "ns", "w-2", "lost");
		timers.advance(300);
		assert.deepEqual(a.receipts().slice(-2), [
			{ stream: "ns", clientFrameId: "w-1", seq: 1, deduped: true },
			{ stream: "ns", clientFrameId: "w-2", seq: 2, deduped: false },
		]);
		assert.equal(store.head(), 2);
	});
});

// ---- billing ----------------------------------------------------------------------

s.test("rows: a commit bills 2 rows per touched stream (+1 per sealed segment); no per-frame, receipt or clock rows", async () => {
	await withStreams(({ connect, append, timers, model, store }) => {
		const a = connect();
		store.head();
		model.reset();
		for (let index = 0; index < 20; index++) append(a, "b:rows", `x-${index}`, "small");
		timers.advance(300);
		assert.equal(model.totals.cf, 2, "new stream: head INSERT + last_seq index");
		model.reset();
		for (let index = 0; index < 20; index++) append(a, "b:rows", `y-${index}`, "small");
		timers.advance(300);
		assert.equal(model.totals.cf, 2, "existing stream: head UPDATE + last_seq index");
		model.reset();
		append(a, "b:rows", "z-1", "small");
		append(a, "ns", "z-2", "small");
		append(a, "c:canvas", "z-3", "small");
		timers.advance(300);
		assert.equal(model.totals.cf, 6, "3 streams: 2 rows each");
		model.reset();
		append(a, "b:rows", "seal", new Uint8Array(STREAM_SEGMENT_SEAL_BYTES));
		assert.equal(model.totals.cf, 3, "sealing adds one segment row");
		assert.deepEqual(Object.fromEntries(model.totals.byTable), { stream_segment: 1, stream_head: 1 });
	});
});

await s.done();
