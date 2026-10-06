// P3a streams hardening (DECISIONS §4 H1–H8), white-box through the injected ports.
// Real SQLite (NodeSqliteStorage) under StreamStore + StreamRelayService, fake sockets, virtual timers.
// Row accounting: helpers/cfRowModel.ts (Cloudflare billing model). Rows read: rows each query returned, counted
// by a cursor wrapper (the stream tables are WITHOUT ROWID with the probed key as PRIMARY KEY, so a keyed range scan
// reads the rows it returns).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSqliteStorage } from "./helpers/nodeSqliteStorage";
import { CfRowModel } from "./helpers/cfRowModel.ts";
import { base64ToBytes } from "../../server/src/base64url";
import type { SocketPort, SocketRegistryPort, SqlCursor, StoragePort, TimerPort } from "../../server/src/ports";
import { MAX_STREAM_SOCKETS_PER_DEVICE, decodeAppendFrame, encodeAppendFrame, encodeRow } from "../../server/src/streams/protocol";
import {
	DEFAULT_STREAM_RELAY_CONFIG,
	StreamRelayService,
	type StreamActor,
	type StreamRelayConfig,
} from "../../server/src/streams/relay";
import { STREAM_DEDUPE_WINDOW_BYTES, StreamDedupeIndex, frameKeyHash } from "../../server/src/streams/dedupe";
import { StreamStore, type StreamAppendInput } from "../../server/src/streams/store";
import { suite } from "../harness.ts";

const s = suite("streams-hardening");

const VAULT_ID = "streams-vault-0001";
const GENERATION = "streams-generation-0001";
const DAILY_LIMIT_MESSAGE = "Exceeded allowed rows written in Durable Objects free tier.";

const ownerA: StreamActor = { vaultId: VAULT_ID, vaultGeneration: GENERATION, principalId: "principal-a",
	membershipRevision: 1, deviceId: "device-a", deviceCredentialRevision: 1, role: "owner",
	policyVersion: 1, capabilityDigest: "digest" };
const deviceB: StreamActor = { ...ownerA, deviceId: "device-b" };

type Control = Record<string, unknown> & { type: string };

class FakeSocket implements SocketPort {
	readonly binary: Uint8Array[] = [];
	readonly controls: Control[] = [];
	closed: { code?: number; reason?: string } | null = null;
	attachment: unknown = null;
	deserializations = 0;
	close(code?: number, reason?: string): void { this.closed ??= { code, reason }; }
	deserializeAttachment(): unknown { this.deserializations++; return this.attachment; }
	serializeAttachment(value: unknown): void { this.attachment = structuredClone(value); }
	send(message: ArrayBuffer | ArrayBufferView | string): void {
		if (this.closed) throw new Error("socket closed");
		if (typeof message === "string") this.controls.push(JSON.parse(message.slice(6)) as Control);
		else {
			const view = message instanceof ArrayBuffer ? new Uint8Array(message)
				: new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
			this.binary.push(view.slice());
		}
	}
	all(type: string): Control[] { return this.controls.filter((value) => value.type === type); }
	last(type: string): Control | undefined { return this.all(type).at(-1); }
	receipts(): Array<{ stream: string; clientFrameId: string; seq: number; deduped: boolean }> {
		return this.all("STREAM_RECEIPTS").flatMap((value) => value.receipts as never[]);
	}
}

class FakeRegistry implements SocketRegistryPort {
	readonly list: FakeSocket[] = [];
	lastClient: FakeSocket | null = null;
	walks = 0;
	/** Like `ctx.getWebSockets()`, which may still return a socket after `close()`: closed sockets are listed too. */
	sockets(): readonly SocketPort[] { this.walks++; return this.list; }
	createPair() { const server = new FakeSocket(); return { client: server, server }; }
	accept(socket: SocketPort): void { this.list.push(socket as FakeSocket); }
	upgradeResponse(client: unknown): Response { this.lastClient = client as FakeSocket; return new Response(null, { status: 200 }); }
}

class VirtualTimers implements TimerPort {
	now = 1_000_000;
	private nextId = 0;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();
	set(callback: () => void, ms: number): unknown {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.now + ms, callback });
		return id;
	}
	clear(handle: unknown): void { this.timers.delete(handle as number); }
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

/** Rows returned per query text (the rows-read measure of these tests). */
class ReadCounter {
	readonly byQuery = new Map<string, number>();
	reset(): void { this.byQuery.clear(); }
	total(): number { let sum = 0; for (const value of this.byQuery.values()) sum += value; return sum; }
	matching(pattern: RegExp): number {
		let sum = 0;
		for (const [query, value] of this.byQuery) if (pattern.test(query)) sum += value;
		return sum;
	}
	wrap<T>(query: string, cursor: SqlCursor<T>): SqlCursor<T> {
		const bump = (count: number) => this.byQuery.set(query, (this.byQuery.get(query) ?? 0) + count);
		return {
			toArray: () => { const rows = cursor.toArray(); bump(rows.length); return rows; },
			one: () => { const row = cursor.one(); bump(1); return row; },
			[Symbol.iterator]: () => {
				const iterator = cursor[Symbol.iterator]();
				return {
					next: () => { const next = iterator.next(); if (!next.done) bump(1); return next; },
					return: (value?: unknown) => { iterator.return?.(value); return { done: true as const, value: undefined }; },
				};
			},
		};
	}
}

type FailMode = null | "daily" | "transient";

interface Harness {
	service: StreamRelayService;
	store: StreamStore;
	storage: StoragePort;
	registry: FakeRegistry;
	timers: VirtualTimers;
	model: CfRowModel;
	reads: ReadCounter;
	revoked: Set<string>;
	fail: { mode: FailMode };
	connect(actor?: StreamActor): FakeSocket;
	append(socket: FakeSocket, stream: string, clientFrameId: string, payload: Uint8Array | string): void;
	raw(socket: FakeSocket, bytes: Uint8Array | number[]): void;
	/** A new runtime over the same storage and sockets (hibernation wake / eviction): new relay and new store. */
	fresh(runtimeEpoch: string, random?: () => number): StreamRelayService;
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function text(value: Uint8Array): string { return new TextDecoder().decode(value); }
function buffer(value: Uint8Array): ArrayBuffer {
	return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function withStreams(check: (harness: Harness) => void | Promise<void>,
	options: { config?: Partial<StreamRelayConfig>; dedupeMaxEntries?: number; random?: () => number } = {}): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-hardening-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const model = new CfRowModel(sqlite);
	const reads = new ReadCounter();
	const fail = { mode: null as FailMode };
	const storage: StoragePort = {
		sql: {
			exec: (query: string, ...bindings: unknown[]) => {
				if (fail.mode && /^\s*(INSERT|UPDATE|DELETE)/i.test(query)) {
					throw new Error(fail.mode === "daily" ? DAILY_LIMIT_MESSAGE : "SQLITE_BUSY: database is locked");
				}
				return reads.wrap(query, model.exec(query, ...bindings) as never);
			},
		},
		transactionSync: (closure) => sqlite.transactionSync(closure),
	};
	const timers = new VirtualTimers();
	const registry = new FakeRegistry();
	const revoked = new Set<string>();
	const config = { ...DEFAULT_STREAM_RELAY_CONFIG, ...options.config };
	const makeStore = () => new StreamStore(storage, { dedupeMaxEntries: options.dedupeMaxEntries });
	const make = (runtimeEpoch: string, store: StreamStore, random?: () => number) => new StreamRelayService({
		config,
		store: () => store,
		sockets: registry,
		sendControl: (socket, value) => { try { socket.send(`__YPS:${JSON.stringify(value)}`); } catch { /* closed */ } },
		validateActor: (actor) => !revoked.has(actor.deviceId),
		// H3: the relay types its own errors; no latch is consulted.
		dailyLimitActive: () => false,
		noteCommitError: () => {},
		vaultId: () => VAULT_ID,
		vaultGeneration: () => GENERATION,
		runtimeEpoch,
		clock: { now: () => timers.now },
		timers,
		...(random ? { random } : {}),
	});
	const initialStore = makeStore();
	const harness: Harness = {
		service: make("runtime-a", initialStore, options.random),
		store: initialStore,
		storage, registry, timers, model, reads, revoked, fail,
		connect(actor = ownerA) {
			const response = harness.service.accept(actor, true);
			assert.equal(response.status, 200, "accepted");
			const socket = registry.lastClient!;
			registry.lastClient = null;
			return socket;
		},
		append(socket, stream, clientFrameId, payload) {
			const frame = encodeAppendFrame({ stream, clientFrameId, payload: typeof payload === "string" ? bytes(payload) : payload });
			harness.service.message(socket, buffer(frame));
		},
		raw(socket, value) {
			harness.service.message(socket, buffer(value instanceof Uint8Array ? value : new Uint8Array(value)));
		},
		fresh(runtimeEpoch, random) {
			harness.store = makeStore();
			harness.service = make(runtimeEpoch, harness.store, random);
			return harness.service;
		},
	};
	try {
		await check(harness);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function varuint(value: number): number[] {
	const out: number[] = [];
	while (value >= 0x80) { out.push((value % 128) | 0x80); value = Math.floor(value / 128); }
	out.push(value);
	return out;
}

/** An APPEND message from raw field bytes (lengths minimal unless overridden). */
function appendBytes(stream: number[], clientFrameId: number[], payload: number[] = [0x61]): number[] {
	return [0x01, ...varuint(stream.length), ...stream, ...varuint(clientFrameId.length), ...clientFrameId,
		...varuint(payload.length), ...payload];
}

const ascii = (value: string) => [...bytes(value)];

// ---- H1 strict codec ------------------------------------------------------------

s.test("H1 codec: invalid UTF-8, surrogates, overlongs, non-minimal varuints and trailing bytes are malformed_frame", () => {
	const malformed = { error: "malformed_frame" };
	const decode = (value: number[]) => decodeAppendFrame(new Uint8Array(value));
	// T-CODEC-UTF8: 0xff is never valid UTF-8 (lib0 would yield U+FFFD and alias every other bad name).
	assert.deepEqual(decode(appendBytes([0x62, 0x3a, 0xff], ascii("cf"))), malformed);
	assert.deepEqual(decode(appendBytes(ascii("b:x"), [0x63, 0xfe])), malformed, "clientFrameId too");
	// T-CODEC-SURROGATE: ED A0 80 encodes U+D800.
	assert.deepEqual(decode(appendBytes([0x62, 0x3a, 0xed, 0xa0, 0x80], ascii("cf"))), malformed);
	// T-CODEC-OVERLONG: C0 AF is an overlong "/".
	assert.deepEqual(decode(appendBytes([0x62, 0x3a, 0xc0, 0xaf], ascii("cf"))), malformed);
	// Truncated multi-byte sequence at the end of a field.
	assert.deepEqual(decode(appendBytes([0x62, 0x3a, 0xe2, 0x9c], ascii("cf"))), malformed);
	// T-CODEC-NONMINIMAL: 0x82 0x00 is a 2-group encoding of 2.
	assert.deepEqual(decode([0x01, 0x82, 0x00, ...ascii("ns"), 0x02, ...ascii("cf"), 0x01, 0x61]), malformed);
	assert.deepEqual(decode([0x01, 0x02, ...ascii("ns"), 0x02, ...ascii("cf"), 0x81, 0x00, 0x61]), malformed, "payload length too");
	assert.deepEqual(decode([0x01, 0x80, 0x00]), malformed, "non-minimal zero");
	// Above 2^53 and longer than 8 groups.
	assert.deepEqual(decode([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]), malformed);
	assert.deepEqual(decode([0x01, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), malformed);
	// T-CODEC-TRAILING and lengths past the end.
	assert.deepEqual(decode([...appendBytes(ascii("ns"), ascii("cf")), 0x00]), malformed);
	assert.deepEqual(decode([0x01, 0x05, ...ascii("ns")]), malformed);
	assert.deepEqual(decode([0x01, 0x02, ...ascii("ns"), 0x02, ...ascii("cf"), 0x09, 0x61]), malformed);
	assert.deepEqual(decode([0x01, 0x02, ...ascii("ns"), 0x02, ...ascii("cf")]), malformed, "missing payload");
	assert.deepEqual(decode([0x01, 0x02, ...ascii("ns"), 0x02, ...ascii("cf"), 0x80]), malformed, "unterminated varuint");
	// The typed errors after a well-formed parse are unchanged.
	assert.deepEqual(decode([0x02]), { error: "unknown_frame_kind" });
	assert.deepEqual(decode(appendBytes([], ascii("cf"))), { error: "invalid_stream" });
});

s.test("H1 codec: valid UTF-8 round-trips exactly, a leading U+FEFF is kept", () => {
	// T-CODEC-VALID
	const frame = decodeAppendFrame(new Uint8Array(appendBytes(ascii("b:é✓😀"), ascii("cf-✓"), [0x00, 0xff])));
	assert.ok(!("error" in frame));
	assert.equal(frame.stream, "b:é✓😀");
	assert.equal(frame.clientFrameId, "cf-✓");
	assert.deepEqual([...frame.payload], [0x00, 0xff], "payload bytes are opaque");
	const bom = decodeAppendFrame(new Uint8Array(appendBytes([0xef, 0xbb, 0xbf, ...ascii("ns")], ascii("cf"))));
	assert.ok(!("error" in bom));
	assert.equal(bom.stream, "﻿ns", "ignoreBOM: U+FEFF is part of the name, not stripped");
	assert.notEqual(bom.stream, "ns");
	// Empty payload, maximal minimal varuint group count stays legal for small values.
	const empty = decodeAppendFrame(new Uint8Array(appendBytes(ascii("ns"), ascii("cf"), [])));
	assert.ok(!("error" in empty) && empty.payload.byteLength === 0);
});

s.test("H1 relay: a codec violation closes 1008 with the bare reason malformed_frame and commits nothing", async () => {
	await withStreams(({ connect, raw, timers, store }) => {
		const a = connect();
		raw(a, appendBytes([0x62, 0x3a, 0xff], ascii("cf")));
		assert.deepEqual(a.closed, { code: 1008, reason: "malformed_frame" });
		const b = connect(deviceB);
		raw(b, [0x01, 0x82, 0x00, ...ascii("ns"), 0x02, ...ascii("cf"), 0x01, 0x61]);
		assert.deepEqual(b.closed, { code: 1008, reason: "malformed_frame" });
		timers.advance(5_000);
		assert.equal(store.head(), 0);
	});
});

// ---- H2 dedupe window --------------------------------------------------------------

s.test("H2 index: frame keys and raw stored keys hash alike; trim keeps the newest W bytes; a re-used hash keeps its newest seq", () => {
	const rows = [1, 2, 3, 4].map((seq) => ({ seq, deviceId: "device-a", clientFrameId: `cf-${seq}`, payload: new Uint8Array(20) }));
	const blob = new Uint8Array(rows.flatMap((row) => [...encodeRow(row)]));
	const size = encodeRow(rows[0]!).byteLength;
	const scanned = new StreamDedupeIndex(1000);
	assert.equal(scanned.scan(blob), 4);
	assert.equal(scanned.windowedBytes, blob.byteLength, "rowBytes = the encoded row length");
	for (const row of rows) assert.equal(scanned.get(frameKeyHash(row.deviceId, row.clientFrameId)), row.seq);
	assert.equal(scanned.scan(blob.subarray(0, blob.byteLength - 3)), 3, "a malformed tail stops the parse");
	// Rows of `size` bytes, W = 100: a row stays while the rows newer than it hold < W bytes.
	const index = new StreamDedupeIndex(100);
	assert.equal(index.scan(blob), Math.floor((100 - 1) / size) + 1, "the scan trims too");
	const keep = Math.floor((100 - 1) / size) + 1;
	for (let seq = 5; seq <= 12; seq++) index.add(frameKeyHash("device-a", `cf-${seq}`), seq, size);
	assert.equal(index.entries, keep);
	assert.ok(index.windowedBytes - size < 100 && index.windowedBytes >= 100);
	assert.equal(index.get(frameKeyHash("device-a", "cf-1")), undefined, "trimmed");
	assert.equal(index.get(frameKeyHash("device-a", "cf-12")), 12);
	// The same key appended again (a re-append after the window): trimming the old entry keeps the newer seq.
	const reused = frameKeyHash("device-a", "cf-12");
	index.add(reused, 13, size);
	for (let seq = 14; seq <= 30; seq++) index.add(frameKeyHash("device-a", `cf-${seq}`), seq, size);
	assert.equal(index.get(reused), undefined);
	index.add(reused, 31, size);
	for (let seq = 32; seq < 32 + keep - 1; seq++) index.add(frameKeyHash("device-a", `cf-${seq}`), seq, size);
	assert.equal(index.get(reused), 31);
	// Separator: ("ab", "c") and ("a", "bc") are different keys.
	assert.notEqual(frameKeyHash("ab", "c"), frameKeyHash("a", "bc"));
	assert.ok(Number.isSafeInteger(frameKeyHash("device-a", "cf-1")));
});

s.test("H2 T-DEDUPE-LARGE: 3×600 KiB frames, each sealed, all dedupe on a reconnect resend (new runtime)", async () => {
	await withStreams(({ connect, append, timers, store, fresh, registry }) => {
		const a = connect();
		const payloads = [1, 2, 3].map((fill) => new Uint8Array(600 * 1024).fill(fill));
		payloads.forEach((payload, index) => { append(a, "b:large", `big-${index}`, payload); timers.advance(5_000); });
		assert.deepEqual(a.receipts().map((receipt) => receipt.seq), [1, 2, 3]);
		assert.equal(store.tableCounts().segments, 3, "each > 64 KiB commit sealed its own segment");
		const service = fresh("runtime-b");
		const a2 = (() => { const response = service.accept(ownerA, true); assert.equal(response.status, 200); return registry.lastClient!; })();
		payloads.forEach((payload, index) => append(a2, "b:large", `big-${index}`, payload));
		timers.advance(5_000);
		assert.deepEqual(a2.receipts(), [0, 1, 2].map((index) => ({ stream: "b:large", clientFrameId: `big-${index}`, seq: index + 1, deduped: true })));
		assert.equal(service.head(), 3, "nothing re-appended");
	}, { config: { burstBytes: 8 * 1024 * 1024 } });
});

s.test("H2 T-DEDUPE-SMALL: 400×4 KiB frames all dedupe after a restart; a resend beyond W is re-appended", async () => {
	await withStreams(({ store, fresh, storage }) => {
		const frame = (index: number, size = 4 * 1024): StreamAppendInput => ({ stream: "b:small", deviceId: "device-a",
			clientFrameId: `small-${index}`, payload: new Uint8Array(size).fill(index % 251) });
		for (let index = 0; index < 400; index += 20) {
			store.commit(Array.from({ length: 20 }, (_, offset) => frame(index + offset)));
		}
		assert.equal(store.head(), 400);
		fresh("runtime-b");
		const cold = new StreamStore(storage);
		const outcomes = cold.commit(Array.from({ length: 400 }, (_, index) => frame(index))).outcomes;
		assert.ok(outcomes.every((outcome, index) => outcome.kind === "deduped" && outcome.seq === index + 1));
		// Push 5 MiB more: the first frame is now outside the newest W bytes and a resend appends a new row.
		for (let index = 0; index < 5; index++) cold.commit([{ ...frame(1000 + index), payload: new Uint8Array(1024 * 1024 - 64) }]);
		const late = cold.commit([frame(0), frame(399)]).outcomes;
		assert.equal(late[0]!.kind, "appended", "outside the window: re-appended (the accepted H2 bound)");
		assert.equal(late[1]!.kind, "appended", "399 is also > W back now");
		const inside = cold.commit([{ ...frame(1004), payload: new Uint8Array(1024 * 1024 - 64) }]).outcomes;
		assert.deepEqual(inside, [{ kind: "deduped", seq: 405 }]);
	});
});

s.test("H2 T-DEDUPE-CONFLICT: same key, other bytes, sealed original (cold) → client_frame_id_conflict with the seq", async () => {
	await withStreams(({ connect, append, timers, fresh, registry, store }) => {
		const a = connect();
		append(a, "b:c", "same", new Uint8Array(70 * 1024).fill(1));
		timers.advance(5_000);
		append(a, "b:c", "open", "open-row");
		timers.advance(5_000);
		assert.equal(store.tableCounts().segments, 1);
		const service = fresh("runtime-b");
		service.accept(ownerA, true);
		const a2 = registry.lastClient!;
		append(a2, "b:c", "same", new Uint8Array(70 * 1024).fill(2));
		append(a2, "b:c", "open", "other-bytes");
		timers.advance(5_000);
		const rejected = a2.all("STREAM_APPEND_REJECTED");
		assert.deepEqual(rejected, [
			{ type: "STREAM_APPEND_REJECTED", stream: "b:c", clientFrameId: "same", code: "client_frame_id_conflict", seq: 1 },
			{ type: "STREAM_APPEND_REJECTED", stream: "b:c", clientFrameId: "open", code: "client_frame_id_conflict", seq: 2 },
		]);
		assert.equal(service.head(), 2);
	});
});

s.test("H2 T-DEDUPE-COLD-WB: the cold scan reads the head + at most 64 segments (≤ 65 rows), once per stream per runtime", async () => {
	await withStreams(({ store, storage, reads }) => {
		const payload = (index: number) => new Uint8Array(64 * 1024).fill(index % 251);
		for (let index = 0; index < 80; index++) {
			store.commit([{ stream: "b:cold", deviceId: "device-a", clientFrameId: `seg-${index}`, payload: payload(index) }]);
		}
		assert.equal(store.tableCounts().segments, 80);
		const cold = new StreamStore(storage);
		cold.head();
		reads.reset();
		const resend = cold.commit([{ stream: "b:cold", deviceId: "device-a", clientFrameId: "seg-79", payload: payload(79) }]);
		assert.deepEqual(resend.outcomes, [{ kind: "deduped", seq: 80 }]);
		const head = reads.matching(/FROM stream_head WHERE stream = \?/);
		const scan = reads.matching(/ORDER BY first_seq DESC LIMIT \?/);
		const load = reads.matching(/first_seq <= \? ORDER BY first_seq DESC LIMIT 1/);
		assert.equal(head, 1, "the stream head row");
		assert.equal(scan, 64, "64 × (64 KiB + row header) ≥ W: the scan stops at its LIMIT");
		assert.ok(head + scan <= 65, "≤ 65 rows read by the index build");
		assert.equal(load, 1, "the hit's sealed segment: 1 row");
		assert.equal(reads.total(), head + scan + load, "nothing else is read");
		assert.equal(cold.dedupeStats().streams, 1);
		// Warm: the next resend reads the head and the hit's segment only.
		reads.reset();
		assert.deepEqual(cold.commit([{ stream: "b:cold", deviceId: "device-a", clientFrameId: "seg-20", payload: payload(20) }]).outcomes,
			[{ kind: "deduped", seq: 21 }]);
		assert.equal(reads.matching(/ORDER BY first_seq DESC LIMIT \?/), 0, "no rescan in the same runtime");
		assert.equal(reads.total(), 2);
		// seg-10 is outside the newest W bytes (and was never indexed): a resend re-appends it.
		assert.equal(cold.commit([{ stream: "b:cold", deviceId: "device-a", clientFrameId: "seg-10", payload: payload(10) }]).outcomes[0]!.kind,
			"appended");
	});
});

s.test("H2 GC'd originals: a windowed original at or below gcSeq answers deduped with its seq (no compare)", async () => {
	await withStreams(async ({ store, service, storage }) => {
		const frame = (index: number): StreamAppendInput => ({ stream: "b:gc", deviceId: "device-a", clientFrameId: `gc-${index}`,
			payload: new Uint8Array(70 * 1024).fill(index) });
		for (let index = 1; index <= 3; index++) store.commit([frame(index)]);
		const response = await service.putCheckpoint(new Request("https://do/streams/checkpoint?stream=b:gc&coversSeq=2&expectedCoversSeq=0",
			{ method: "PUT", body: bytes("ckpt") }), new URL("https://do/streams/checkpoint?stream=b:gc&coversSeq=2&expectedCoversSeq=0"));
		assert.equal(response.status, 200);
		assert.equal(((await response.json()) as { gcSeq: number }).gcSeq, 2);
		assert.equal(store.commit([frame(1)]).outcomes[0]!.kind, "deduped", "warm index");
		const cold = new StreamStore(storage);
		// Cold: the segments ≤ 2 are gone, so the rebuilt index does not hold gc-1; only the warm index does.
		assert.equal(cold.commit([frame(3)]).outcomes[0]!.kind, "deduped");
		assert.deepEqual(store.commit([{ ...frame(2), payload: bytes("other bytes") }]).outcomes, [{ kind: "deduped", seq: 2 }],
			"collected originals cannot be compared: the checkpoint covers them");
	});
});

s.test("H2 memory cap: whole streams are evicted LRU at the DO-wide entry cap; an evicted stream rescans and still dedupes", async () => {
	await withStreams(({ store, reads }) => {
		const frame = (stream: string, index: number): StreamAppendInput => ({ stream, deviceId: "device-a",
			clientFrameId: `${stream}-${index}`, payload: bytes(`p-${index}`) });
		for (const stream of ["s1", "s2", "s3"]) {
			store.commit(Array.from({ length: 4 }, (_, index) => frame(stream, index)));
			// The first commit to a stream builds its (empty) index; rows join after the commit.
		}
		// Every stream has 4 entries: 12 > 10, so the least recently used (s1) went.
		assert.deepEqual(store.dedupeStats(), { streams: 2, entries: 8 });
		reads.reset();
		assert.deepEqual(store.commit([frame("s1", 0)]).outcomes, [{ kind: "deduped", seq: 1 }]);
		assert.equal(reads.matching(/FROM stream_head WHERE stream = \?/), 1, "rescan of s1 (open segment only)");
		assert.deepEqual(store.dedupeStats(), { streams: 2, entries: 8 }, "s1 back, s2 (now LRU) evicted");
		assert.deepEqual(store.commit([frame("s2", 3)]).outcomes, [{ kind: "deduped", seq: 8 }]);
	}, { dedupeMaxEntries: 10 });
});

s.test("H2: rows join the index only after their commit is durable (a failed commit leaves no false hit)", async () => {
	await withStreams(({ store, fail }) => {
		const frame: StreamAppendInput = { stream: "ns", deviceId: "device-a", clientFrameId: "x", payload: bytes("x") };
		store.commit([{ ...frame, clientFrameId: "first" }]);
		fail.mode = "transient";
		assert.throws(() => store.commit([frame]));
		fail.mode = null;
		assert.deepEqual(store.commit([frame]).outcomes, [{ kind: "appended", seq: 2 }]);
		assert.deepEqual(store.commit([frame]).outcomes, [{ kind: "deduped", seq: 2 }]);
	});
});

// ---- H3 commit-failure typing ------------------------------------------------------------

s.test("H3 T-COMMIT-DAILY-WB: a daily-limit commit error is typed at the source (no latch): cf_daily_limit, no retryAfterMs", async () => {
	await withStreams(({ connect, append, timers, fail }) => {
		const a = connect();
		const b = connect(deviceB);
		fail.mode = "daily";
		append(a, "b:d", "d-1", "x");
		append(a, "b:d", "d-2", "y");
		timers.advance(5_000);
		const error = a.last("VAULT_ERROR")!;
		assert.equal(error.code, "cf_daily_limit");
		assert.equal(error.cause, "durability_failed");
		assert.equal(error.kind, "rows-written");
		assert.equal(typeof error.resetAt, "number", "Unix ms, next 00:00 UTC");
		assert.deepEqual(error.clientFrameIds, ["d-1", "d-2"]);
		assert.equal(error.stream, "b:d");
		assert.equal("retryAfterMs" in error, false);
		assert.equal(b.all("STREAM_PROVISIONAL_DROPPED").length, 2, "PROVISIONAL holders drop them");
		// With no latch at all (dailyLimitActive false), the next failed commit is typed again from its own error;
		// the host's latch-driven up-front refusal is covered in streams-relay.
		append(a, "b:d", "d-3", "z");
		timers.advance(5_000);
		assert.equal(a.all("VAULT_ERROR").length, 2);
		assert.equal(a.last("VAULT_ERROR")!.code, "cf_daily_limit");
		assert.deepEqual(a.last("VAULT_ERROR")!.clientFrameIds, ["d-3"]);
	});
});

s.test("H3 T-COMMIT-RETRY-WB: durability_failed carries retryAfterMs = round(min(30000, 1000·2^(n−1))·(0.5+0.5·rand)); success resets n", async () => {
	let draw = 1;
	await withStreams(({ connect, append, timers, fail }) => {
		const a = connect();
		const b = connect(deviceB);
		fail.mode = "transient";
		const seen: number[] = [];
		for (let attempt = 0; attempt < 7; attempt++) {
			append(a, "ns", `r-${attempt}`, "x");
			timers.advance(5_000);
			const error = a.last("VAULT_ERROR")!;
			assert.equal(error.code, "durability_failed");
			seen.push(error.retryAfterMs as number);
		}
		assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
		draw = 0;
		append(a, "ns", "half", "x");
		timers.advance(5_000);
		assert.equal(a.last("VAULT_ERROR")!.retryAfterMs, 15000, "jitter floor: half the cap");
		fail.mode = null;
		append(a, "ns", "ok", "x");
		timers.advance(5_000);
		assert.equal(a.receipts().at(-1)!.clientFrameId, "ok");
		fail.mode = "transient";
		draw = 0.5;
		append(a, "ns", "again", "x");
		append(b, "ns", "again-b", "x");
		timers.advance(5_000);
		assert.equal(a.last("VAULT_ERROR")!.retryAfterMs, 750, "n reset by the success: 1000 · 0.75");
		assert.equal(b.last("VAULT_ERROR")!.retryAfterMs, 750, "per message, same n");
	}, { random: () => draw });
});

// ---- H5 socket cache -------------------------------------------------------------------

s.test("H5 T-SOCKET-CACHE-WB: each attachment is parsed once per socket per runtime; fanout never walks getWebSockets", async () => {
	await withStreams(({ connect, append, timers, registry, fresh, revoked }) => {
		const sockets = [connect(ownerA), connect(deviceB), connect({ ...ownerA, deviceId: "device-c" })];
		const walks = registry.walks;
		for (let index = 0; index < 20; index++) { append(sockets[index % 3]!, "b:fan", `f-${index}`, "x"); timers.advance(400); }
		assert.equal(registry.walks, walks, "no getWebSockets() walk per message or broadcast");
		assert.ok(sockets.every((socket) => socket.deserializations === 0), "accepted in this runtime: never deserialized");
		// Wake: new runtime; device-c left the map while hibernated.
		revoked.add("device-c");
		const service = fresh("runtime-b");
		const before = registry.walks;
		for (let index = 0; index < 20; index++) { append(sockets[index % 2]!, "b:fan", `g-${index}`, "x"); timers.advance(400); }
		assert.equal(registry.walks, before + 1, "one rebuild per runtime");
		assert.ok(sockets.every((socket) => socket.deserializations === 1), "parsed once per socket per runtime");
		assert.equal(sockets[2]!.closed?.code, 4403, "the rebuild skips and supersedes a revoked device (D7, O3)");
		assert.equal(sockets[2]!.last("error")!.code, "authority_superseded");
		assert.equal(sockets[0]!.all("STREAM_RESEND").length, 1);
		assert.equal(sockets[2]!.all("STREAM_RESEND").length, 0);
		assert.equal(service.diagnostics().sockets, 2);
		// A close leaves the set at once.
		service.socketClosed(sockets[1]!);
		sockets[1]!.close(1000, "bye");
		assert.equal(service.diagnostics().sockets, 1);
		const provisional = sockets[0]!.binary.length;
		append(sockets[0]!, "b:fan", "solo", "x");
		assert.equal(sockets[0]!.binary.length, provisional, "an origin gets no echo");
		timers.advance(1_000);
		assert.equal(sockets[0]!.receipts().at(-1)!.clientFrameId, "solo");
	});
});

s.test("H5 + D7: revokeDevice removes the device's sockets from the cache and deletes its bucket in the same turn", async () => {
	await withStreams(({ connect, append, timers, service, revoked, store }) => {
		const a1 = connect(ownerA);
		const a2 = connect(ownerA);
		const b = connect(deviceB);
		append(a1, "b:r", "r-1", new Uint8Array(1500).fill(1));
		append(a1, "b:r", "r-2", new Uint8Array(400).fill(1));
		assert.equal(b.binary.length, 2, "b holds two PROVISIONALs");
		revoked.add("device-a");
		assert.deepEqual(service.revokeDevice("device-a"), { droppedFrames: 2, closedSockets: 2 });
		assert.equal(service.diagnostics().sockets, 1);
		assert.equal(a1.closed?.code, 4403);
		assert.equal(a2.closed?.code, 4403);
		assert.equal(b.all("STREAM_PROVISIONAL_DROPPED").length, 2);
		append(a2, "b:r", "late", "x");
		timers.advance(5_000);
		assert.equal(store.head(), 0, "nothing of the revoked device commits");
		// A re-admitted device id (test only) starts with a full bucket: the revoke deleted it.
		revoked.delete("device-a");
		const again = connect(ownerA);
		append(again, "b:r", "full-1", new Uint8Array(1500).fill(2));
		append(again, "b:r", "full-2", new Uint8Array(400).fill(2));
		assert.equal(again.closed, null, "1900 B fits the 2000 B burst: the old bucket (100 B left) is gone");
	}, { config: { burstBytes: 2000, rateBytesPerSec: 1024 } });
});

// ---- H6 per-device limits ----------------------------------------------------------------

s.test("H6 T-SOCKET-CAP-DEVICE: a 5th socket of a device closes its oldest (1001 device_socket_limit), before the vault-wide cap", async () => {
	assert.equal(MAX_STREAM_SOCKETS_PER_DEVICE, 4);
	await withStreams(({ connect, service }) => {
		const own = [connect(ownerA), connect(ownerA), connect(ownerA), connect(ownerA)];
		const fifth = connect(ownerA);
		assert.deepEqual(own[0]!.closed, { code: 1001, reason: "device_socket_limit" });
		assert.ok(own.slice(1).every((socket) => socket.closed === null));
		assert.equal(fifth.closed, null);
		assert.equal(service.diagnostics().counters.deviceSocketEvictions, 1);
		assert.equal(service.diagnostics().sockets, 4);
		// The vault is at maxSockets 4: another device is refused, but device-a at its cap still reconnects.
		const refused = service.accept(deviceB, true);
		assert.equal(refused.status, 429);
		assert.equal(refused.headers.get("Retry-After"), "1");
		const sixth = connect(ownerA);
		assert.deepEqual(own[1]!.closed, { code: 1001, reason: "device_socket_limit" }, "oldest remaining goes next");
		assert.equal(sixth.closed, null);
		assert.equal(service.diagnostics().sockets, 4);
		// The evicted socket's later messages are dropped.
		const drops = service.diagnostics().counters.rawDrops;
		service.message(own[0]!, "__YPS:{}");
		assert.equal(service.diagnostics().counters.rawDrops, drops + 1);
	}, { config: { maxSockets: 4 } });
});

s.test("H6 T-RATE-DEVICE / T-RATE-SOCKET: one bucket per device shared by its sockets; the overdrawing socket alone closes 1013", async () => {
	await withStreams(({ connect, append, timers, service, fresh, registry }) => {
		const a1 = connect(ownerA);
		const a2 = connect(ownerA);
		const b = connect(deviceB);
		append(a1, "ns", "a-1", new Uint8Array(900));
		append(a2, "ns", "a-2", new Uint8Array(900));
		append(b, "ns", "b-1", new Uint8Array(900));
		append(b, "ns", "b-2", new Uint8Array(900));
		assert.equal(b.closed, null, "device-b has its own bucket");
		append(a2, "ns", "a-3", new Uint8Array(900));
		assert.deepEqual(a2.last("VAULT_BACKPRESSURE"), { type: "VAULT_BACKPRESSURE", reason: "relay_rate_limit" });
		assert.deepEqual(a2.closed, { code: 1013, reason: "relay rate limit" });
		assert.equal(a1.closed, null, "the sibling socket stays open (T-RATE-SOCKET)");
		assert.equal(service.diagnostics().counters.rateCloses, 1);
		// A reconnect does not refill the device's bucket in this runtime.
		const a3 = connect(ownerA);
		append(a3, "ns", "a-4", new Uint8Array(900));
		assert.equal(a3.closed?.code, 1013);
		// Refill at the rate (1000 B/s): after 1 s the sibling sends again.
		timers.advance(1_000);
		append(a1, "ns", "a-5", new Uint8Array(900));
		assert.equal(a1.closed, null);
		timers.advance(5_000);
		assert.deepEqual(a1.receipts().map((receipt) => receipt.clientFrameId), ["a-1", "a-5"]);
		// A new runtime starts every bucket full.
		const next = fresh("runtime-b");
		next.accept(ownerA, true);
		const a4 = registry.lastClient!;
		append(a4, "ns", "a-6", new Uint8Array(900));
		append(a4, "ns", "a-7", new Uint8Array(900));
		assert.equal(a4.closed, null);
	}, { config: { burstBytes: 2000, rateBytesPerSec: 1000 } });
});

// ---- H7 retired-stream GC ----------------------------------------------------------------

s.test("H7 T-RETIRED-GC / T-PARTIAL-GC: a checkpoint at lastSeq drops the open segment too (gcSeq = lastSeq, 1 head row billed)", async () => {
	await withStreams(async ({ store, service, model }) => {
		const put = async (stream: string, coversSeq: number, expected: number, body: Uint8Array) => {
			const url = `https://do/streams/checkpoint?stream=${stream}&coversSeq=${coversSeq}&expectedCoversSeq=${expected}`;
			const response = await service.putCheckpoint(new Request(url, { method: "PUT", body }), new URL(url));
			return { status: response.status, body: await response.json() as Record<string, unknown> };
		};
		const read = async (query: string) => await service.read(new URL(`https://do/streams/read?${query}`)).json() as {
			checkpoint: { coversSeq: number; bytes: string } | null; rows: Array<{ seq: number }>; gcSeq: number; lastSeq: number };
		const frame = (stream: string, index: number, size: number): StreamAppendInput => ({ stream, deviceId: "device-a",
			clientFrameId: `${stream}-${index}`, payload: new Uint8Array(size).fill(index) });
		// T-PARTIAL-GC: sealed [1..2], open [3]; a checkpoint below lastSeq keeps the open segment.
		store.commit([frame("b:p", 1, 40 * 1024)]);
		store.commit([frame("b:p", 2, 40 * 1024)]);
		store.commit([frame("b:p", 3, 10)]);
		const partial = await put("b:p", 2, 0, bytes("p2"));
		assert.deepEqual(partial.body, { stream: "b:p", coversSeq: 2, gcSeq: 2, deletedSegments: 1 });
		assert.deepEqual((await read("stream=b:p&after=2")).rows.map((row) => row.seq), [3], "open rows stay");
		// T-RETIRED-GC: sealed [4..5] and open [6] of b:r; a checkpoint at lastSeq retires the stream.
		store.commit([frame("b:r", 4, 40 * 1024)]);
		store.commit([frame("b:r", 5, 40 * 1024)]);
		store.commit([frame("b:r", 6, 10)]);
		const segments = store.tableCounts().segments;
		model.reset();
		const retired = await put("b:r", 6, 0, bytes("final"));
		assert.deepEqual(retired.body, { stream: "b:r", coversSeq: 6, gcSeq: 6, deletedSegments: 1 });
		assert.equal(store.tableCounts().segments, segments - 1);
		const billed = Object.fromEntries(model.totals.byObject);
		assert.equal(billed.stream_head, 1, "the head UPDATE: 1 row, no indexed column in SET");
		assert.equal(billed["stream_head:stream_head_last_seq"], undefined);
		const cold = await read("stream=b:r&after=0");
		assert.equal(cold.checkpoint?.coversSeq, 6);
		assert.equal(text(base64ToBytes(cold.checkpoint!.bytes)), "final");
		assert.deepEqual(cold.rows, [], "the checkpoint only");
		assert.equal(cold.gcSeq, 6);
		// The stream lives on: the next append is readable after the checkpoint; a resend of a retired row dedupes.
		assert.deepEqual(store.commit([frame("b:r", 7, 10), frame("b:r", 6, 10)]).outcomes,
			[{ kind: "appended", seq: 7 }, { kind: "deduped", seq: 6 }]);
		assert.deepEqual((await read("stream=b:r&after=0")).rows.map((row) => row.seq), [7]);
		assert.deepEqual((await read("stream=b:r&after=6")).rows.map((row) => row.seq), [7]);
	});
});

// ---- H8 minIntervalMs ----------------------------------------------------------------------

s.test("H8 T-MININTERVAL-READY / -TIMING: minIntervalMs 1000 in VAULT_READY; idle commits wait lastCommitAt + 1000; 64 KiB does not", async () => {
	await withStreams(({ connect, append, timers, service }) => {
		const a = connect();
		assert.deepEqual((a.last("VAULT_READY")!.limits as Record<string, unknown>).groupCommit,
			{ idleMs: 300, maxMs: 1500, maxBytes: 64 * 1024, minIntervalMs: 1000 });
		const committedAt: number[] = [];
		const watch = () => { const count = a.receipts().length; return count; };
		append(a, "ns", "t-1", "x");
		timers.advance(299);
		assert.equal(watch(), 0);
		timers.advance(1);
		assert.equal(watch(), 1, "first idle commit at idleMs (no earlier commit)");
		committedAt.push(timers.now);
		append(a, "ns", "t-2", "x");
		timers.advance(300);
		assert.equal(watch(), 1, "idle passed, but the min interval holds the commit");
		timers.advance(699);
		assert.equal(watch(), 1);
		timers.advance(1);
		assert.equal(watch(), 2, "commit at lastCommitAt + 1000");
		committedAt.push(timers.now);
		assert.equal(committedAt[1]! - committedAt[0]!, 1000);
		// Typing: a frame every 200 ms. Commits are ≥ 1000 ms apart (the max trigger, 1500 ms, still bounds latency).
		const before = service.diagnostics().counters;
		for (let index = 0; index < 20; index++) { append(a, "ns", `k-${index}`, "x"); timers.advance(200); }
		timers.advance(2_000);
		const commits = service.diagnostics().counters;
		assert.ok(commits.commits - before.commits <= 5, `≤ 1 commit/s: ${commits.commits - before.commits} commits in 6 s`);
		// The 64 KiB trigger commits back to back.
		const bytesBefore = service.diagnostics().counters.flushBytes;
		append(a, "ns", "big-1", new Uint8Array(64 * 1024));
		append(a, "ns", "big-2", new Uint8Array(64 * 1024));
		assert.equal(service.diagnostics().counters.flushBytes - bytesBefore, 2, "not deferred");
	}, { config: { burstBytes: 8 * 1024 * 1024 } });
});

await s.done();
