// Relay v3 (YAOS_RELAY_GROUP_COMMIT): group commit, one tail row per body, one
// receipt row per device, wake re-sync. Real SQLite (NodeSqliteStorage) under
// VaultStore + RelayBodyStore + RelayBodyService with fake sockets, plus the
// Durable Object relay-crash route. The row-accounting test counts written rows
// the way Cloudflare bills them (statement changes x (1 + index entries)).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { bytesToBase64 } from "../../server/src/base64url";
import { BootstrapService } from "../../server/src/bootstrap";
import { classifyWorkerRoute } from "../../server/src/index";
import { RelayBodyService, type RelaySocketHost, type RelayTimers } from "../../server/src/relayBodies";
import { MAX_DURABLE_UPDATE_BYTES } from "../../server/src/contracts";
import { RelayBodyStore } from "../../server/src/relayBodyStore";
import { DEFAULT_RELAY_CONFIG, groupCommitFlag, readRelayConfig, type RelayConfig } from "../../server/src/relayFlag";
import { RELAY_RECEIPT_RING, decodeTailRecords } from "../../server/src/relayTail";
import { RELAY_CRASH_RUNTIME_PATH, VaultSyncServer, type CloudflareVaultEnvironment } from "../../server/src/server";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { sha256HexSync } from "../../server/src/vaultDocumentStore";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import { VaultCandidateService } from "../../server/src/vaultCandidateService";
import { candidateDigestMaterial } from "../../server/src/shared/candidateDigest";
import type { VaultSocketAttachment, VaultSocketPort } from "../../server/src/vaultSocketService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { DAILY_LIMIT_ERROR_CODE, DailyLimitLatch, instrumentStorageForDailyLimit } from "../../server/src/dailyLimit";
import { makeDurableObjectState } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("relay3-group-commit");

const VAULT_ID = "relay3-gc-vault";
const VAULT_GENERATION = "relay3-gc-generation";
const BODY = "relay3-body-a";
const RUNTIME = "runtime-v3-a";

const owner = { vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION, principalId: "principal-owner",
	membershipRevision: 1, deviceId: "device-owner", deviceCredentialRevision: 1, role: "owner" as const,
	policyVersion: 1, capabilityDigest: "owner-digest" };
const peer = { ...owner, deviceId: "device-peer" };

type Control = Record<string, unknown>;

class FakeSocket implements VaultSocketPort {
	readonly binary: Uint8Array[] = [];
	readonly controls: Control[] = [];
	closed: { code?: number; reason?: string } | null = null;
	constructor(public attachment: VaultSocketAttachment) {}
	close(code?: number, reason?: string): void { this.closed ??= { code, reason }; }
	deserializeAttachment(): unknown { return this.attachment; }
	serializeAttachment(value: unknown): void { this.attachment = value as VaultSocketAttachment; }
	send(message: ArrayBuffer | ArrayBufferView | string): void {
		if (typeof message === "string") this.controls.push(JSON.parse(message.slice(6)) as Control);
		else this.binary.push(new Uint8Array(message instanceof ArrayBuffer ? message : message.buffer));
	}
	last(type: string): Control | undefined { return this.controls.filter((value) => value.type === type).at(-1); }
	all(type: string): Control[] { return this.controls.filter((value) => value.type === type); }
	/** Decoded MESSAGE_SYNC frames: [syncKind, payload]. */
	frames(): Array<{ kind: number; payload: Uint8Array }> {
		return this.binary.map((bytes) => {
			const decoder = decoding.createDecoder(bytes);
			assert.equal(decoding.readVarUint(decoder), 0, "MESSAGE_SYNC");
			const kind = decoding.readVarUint(decoder);
			return { kind, payload: decoding.readVarUint8Array(decoder) };
		});
	}
}

function textUpdate(doc: Y.Doc, mutate: (text: Y.Text) => void): Uint8Array {
	const before = Y.encodeStateVector(doc);
	mutate(doc.getText("body"));
	return Y.encodeStateAsUpdate(doc, before);
}

function cloneOf(doc: Y.Doc): Y.Doc {
	const clone = new Y.Doc();
	Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
	return clone;
}

function contentHashOf(text: string): { hash: string; size: number } {
	const bytes = canonicalMarkdownBytes(text);
	return { hash: sha256HexSync(bytes), size: bytes.byteLength };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cloudflare-style written-row meter (inferred from the CF docs + relay2
 * measurements): every row a statement changes costs 1, plus 1 per secondary
 * index entry it touches (autoindexes of rowid tables included; a WITHOUT
 * ROWID table's primary key is the table itself). INSERT/DELETE touch every
 * index; UPDATE only indexes on its SET columns; an UPSERT is billed as an
 * insert (upper bound; none of the v3 tables has an index). setAlarm is 1 row,
 * counted separately (host-deduped once per alarm window, as server.ts does).
 */
interface Meter {
	on: boolean;
	rows: number;
	statements: number;
	byTable: Record<string, number>;
	alarms: number;
	reset(): void;
}

interface Harness {
	store: VaultStore;
	relayStore: RelayBodyStore;
	relay: RelayBodyService;
	config: RelayConfig;
	meter: Meter;
	seed: Y.Doc;
	clock: { now: number };
	alarmCalls: { value: number };
	socket(actor?: typeof owner, options?: { epoch?: number; runtimeEpoch?: string }): FakeSocket;
	update(socket: FakeSocket, update: Uint8Array, via?: RelayBodyService): void;
	step1(socket: FakeSocket, stateVector: Uint8Array, via?: RelayBodyService): void;
	step2(socket: FakeSocket, update: Uint8Array, via?: RelayBodyService): void;
	envelope(socket: FakeSocket, update: Uint8Array, extra?: Record<string, unknown>, via?: RelayBodyService): void;
	claim(doc: Y.Doc): Record<string, unknown>;
	journalRows(): number;
	tail(): ReturnType<VaultStore["relayTailRow"]>;
	catalogHead(): NonNullable<ReturnType<VaultStore["getCatalogHeadAt"]>>;
	/** A new runtime (eviction/hibernation wake) over the same storage and sockets. */
	freshRelay(runtimeEpoch: string): RelayBodyService;
	revoke(deviceId: string): void;
	/** Virtual time (withRelay(..., { virtualTime: true })): moves clock.now, firing due group-commit timers in order. */
	advance(ms: number): void;
}

async function withRelay(check: (harness: Harness) => void | Promise<void>, config: Partial<RelayConfig> = {},
	options: { virtualTime?: boolean; dailyLimit?: { latch: DailyLimitLatch; simulate: () => boolean } } = {}): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-relay3-gc-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const indexes = new Map<string, Array<{ name: string; columns: string[] }>>();
	const indexesOf = (table: string) => {
		let found = indexes.get(table);
		if (!found) {
			found = sqlite.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", table)
				.toArray().map(({ name }) => ({ name, columns: sqlite.sql.exec<{ name: string }>(`PRAGMA index_info("${name}")`)
					.toArray().map((column) => column.name) }));
			indexes.set(table, found);
		}
		return found;
	};
	const meter: Meter = { on: false, rows: 0, statements: 0, byTable: {}, alarms: 0,
		reset() { this.rows = 0; this.statements = 0; this.byTable = {}; this.alarms = 0; } };
	const account = (query: string, changes: number) => {
		if (changes === 0) return;
		const sql = query.replace(/--[^\n]*\n/g, " ").trim();
		let table: string | null = null;
		let touched = 0;
		let match: RegExpMatchArray | null;
		if ((match = sql.match(/^(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+"?(\w+)"?/i))) {
			table = match[1]!;
			touched = indexesOf(table).length;
		} else if ((match = sql.match(/^DELETE\s+FROM\s+"?(\w+)"?/i))) {
			table = match[1]!;
			touched = indexesOf(table).length;
		} else if ((match = sql.match(/^UPDATE\s+(?:OR\s+\w+\s+)?"?(\w+)"?\s+SET\s+([\s\S]*?)(?:\sWHERE\s|$)/i))) {
			table = match[1]!;
			const set = new Set([...match[2]!.matchAll(/(\w+)\s*=/g)].map((value) => value[1]!));
			touched = indexesOf(table).filter((index) => index.columns.some((column) => set.has(column))).length;
		} else {
			table = "(other)";
		}
		const rows = changes * (1 + touched);
		meter.rows += rows;
		meter.statements++;
		meter.byTable[table] = (meter.byTable[table] ?? 0) + rows;
	};
	const rawStorage = {
		sql: { exec: (query: string, ...bindings: unknown[]) => {
			const cursor = sqlite.sql.exec(query, ...bindings);
			if (meter.on && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(query)) account(query, cursor.rowsWritten);
			return cursor;
		} },
		transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure),
	} as unknown as VaultStoragePort;
	// D8 (b3): the DO instruments storage the same way (server.ts createRuntime).
	const storage = options.dailyLimit
		? instrumentStorageForDailyLimit(rawStorage, options.dailyLimit.latch, options.dailyLimit.simulate)
		: rawStorage;
	const seed = new Y.Doc({ guid: BODY });
	const services: RelayBodyService[] = [];
	try {
		const store = new VaultStore(storage);
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", 8);
		root.getMap("sys").set("protocolVersion", 5);
		store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root), 1);
		root.destroy();
		// Long default timers: tests flush explicitly unless they exercise the timers.
		const effective: RelayConfig = { ...DEFAULT_RELAY_CONFIG, leanRows: true, groupCommit: true,
			gcIdleMs: 60_000, gcMaxMs: 60_000, rateBytesPerSec: 1 << 30, ...config };
		store.enableLeanRows();
		if (effective.groupCommit) store.enableRelayTail();
		store.installAuthorityFence({ changeId: "relay3-bootstrap", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
			subjectDigest: "relay3-bootstrap-digest", subjects: [
				{ principalId: owner.principalId, role: owner.role, state: "active", membershipRevision: 1,
					policyVersion: 1, capabilityDigest: owner.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
				{ deviceId: owner.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
				{ deviceId: peer.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
			] });
		const initial = contentHashOf("hello");
		store.commitUpdate({ documentId: BODY, kind: "body", update: textUpdate(seed, (text) => text.insert(0, "hello")),
			catalog: [{ bodyId: BODY, fileId: BODY, path: "a.md", previousPath: null, lifecycle: "active",
				bodyGeneration: 1, contentHash: initial.hash, size: initial.size }] });
		const relayStore = new RelayBodyStore(storage, store);
		const clock = { now: Date.now() };
		const due = new Map<number, { at: number; fn: () => void }>();
		let nextTimer = 0;
		const virtualTimers: RelayTimers = {
			set: (fn, ms) => { const id = ++nextTimer; due.set(id, { at: clock.now + ms, fn }); return id; },
			clear: (handle) => { due.delete(handle as number); },
		};
		const advance = (ms: number) => {
			const until = clock.now + ms;
			for (;;) {
				let nextId: number | null = null;
				for (const [id, timer] of due) {
					if (timer.at > until) continue;
					if (nextId === null || timer.at < due.get(nextId)!.at) nextId = id;
				}
				if (nextId === null) break;
				const timer = due.get(nextId)!;
				due.delete(nextId);
				clock.now = Math.max(clock.now, timer.at);
				timer.fn();
			}
			clock.now = until;
		};
		const sockets: FakeSocket[] = [];
		const alarmCalls = { value: 0 };
		let alarmArmed = false;
		const host: RelaySocketHost = {
			sockets: () => sockets,
			// Like VaultSocketService.sendControl with the DO's decorateControl (D8).
			sendControl: (socket, value) => socket.send(`__YPS:${JSON.stringify(
				options.dailyLimit ? options.dailyLimit.latch.decorateControl(value) : value)}`),
			fenceRelaySocket: (socket) => { socket.close(4409, "semantic epoch mismatch"); },
			broadcastRelayUpdate: (_bodyId, _epoch, frame, exclude) => {
				for (const socket of sockets) if (socket.attachment.socketId !== exclude && !socket.closed) socket.send(frame);
			},
			notifyBodyCommitted: () => {},
			relayBodySockets: () => sockets.filter((socket) => !socket.closed && socket.attachment.relay)
				.map((socket) => ({ socket, attachment: socket.attachment })),
		};
		const makeRelay = (runtimeEpoch: string) => {
			const service = new RelayBodyService({
				config: effective,
				store: () => store,
				relayStore: () => relayStore,
				cache: { get: () => undefined } as unknown as VaultDocumentCache,
				runtimeEpoch,
				armCheckpointAlarm: () => {
					alarmCalls.value++;
					if (alarmArmed) return;
					alarmArmed = true;
					if (meter.on) meter.alarms++;
				},
				now: () => clock.now,
				...(options.virtualTime ? { timers: virtualTimers } : {}),
			});
			service.bindHost(host);
			services.push(service);
			return service;
		};
		const relay = makeRelay(RUNTIME);
		let nextSocket = 0;
		// R12: like VaultSocketService.message, every message is charged raw before parsing.
		const frame = (kind: number, payload: Uint8Array): decoding.Decoder => {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, 0);
			encoding.writeVarUint(encoder, kind);
			encoding.writeVarUint8Array(encoder, payload);
			const decoder = decoding.createDecoder(encoding.toUint8Array(encoder));
			decoding.readVarUint(decoder);
			return decoder;
		};
		const raw = (kind: number, payload: Uint8Array): ArrayBuffer => {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, 0);
			encoding.writeVarUint(encoder, kind);
			encoding.writeVarUint8Array(encoder, payload);
			const bytes = encoding.toUint8Array(encoder);
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		};
		const binary = (via: RelayBodyService, socket: FakeSocket, kind: number, payload: Uint8Array) => {
			if (via.admitRaw(socket, socket.attachment, raw(kind, payload), MAX_DURABLE_UPDATE_BYTES + 64)) {
				via.handleSyncFrame(socket, socket.attachment, frame(kind, payload));
			}
		};
		const text = (via: RelayBodyService, socket: FakeSocket, message: string) => {
			if (via.admitRaw(socket, socket.attachment, message, 64 * 1024)) via.handleControl(socket, socket.attachment, message);
		};
		const harness: Harness = {
			store, relayStore, relay, config: effective, meter, seed, clock, alarmCalls,
			socket(actor = owner, options = {}) {
				const socket = new FakeSocket({ ...actor, runtimeEpoch: options.runtimeEpoch ?? RUNTIME, documentId: BODY,
					kind: "body", documentEpoch: options.epoch ?? store.documentHead(BODY)!.semanticEpoch,
					socketId: `socket-${++nextSocket}`, relay: true });
				sockets.push(socket);
				return socket;
			},
			update(socket, update, via = relay) { binary(via, socket, 2, update); },
			step1(socket, stateVector, via = relay) { binary(via, socket, 0, stateVector); },
			step2(socket, update, via = relay) { binary(via, socket, 1, update); },
			envelope(socket, update, extra = {}, via = relay) {
				text(via, socket, `__YPS:${JSON.stringify({
					type: "BODY_UPDATE_ENVELOPE", bodyId: BODY, bodyEpoch: socket.attachment.documentEpoch,
					clientFrameId: `frame-${Math.random().toString(36).slice(2)}`, payloadDigest: sha256HexSync(update),
					...extra,
				})}`);
			},
			claim(doc) {
				const content = contentHashOf(doc.getText("body").toString());
				return { contentHash: content.hash, size: content.size, stateVector: bytesToBase64(Y.encodeStateVector(doc)) };
			},
			journalRows: () => relayStore.journalRowCount(),
			tail: () => store.relayTailRow(BODY),
			catalogHead: () => store.getCatalogHeadAt(store.currentSequence(), BODY)!,
			freshRelay: (runtimeEpoch) => makeRelay(runtimeEpoch),
			advance,
			revoke(deviceId) {
				store.installAuthorityFence({ changeId: `relay3-revoke-${deviceId}-${Math.random()}`, vaultId: VAULT_ID,
					vaultGeneration: VAULT_GENERATION, subjectDigest: `relay3-revoke-${deviceId}`, subjects: [
						{ deviceId, principalId: owner.principalId, state: "revoked", credentialRevision: 2 },
					] });
			},
		};
		await check(harness);
	} finally {
		for (const service of services) service.dropPendingGroupCommits();
		seed.destroy();
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function reconstructedText(store: VaultStore, through?: number): string {
	const reconstructed = store.reconstructDocument(BODY, through);
	try { return crdtEngine.readText(reconstructed.doc, "body"); }
	finally { crdtEngine.destroyDocument(reconstructed.doc); }
}

function outcomes(relay: RelayBodyService): number {
	const c = relay.counters;
	return c.appendFrames + c.noopSkips + c.dedupeHits + c.dedupeConflicts + c.batchDuplicateCandidates
		+ c.authorityCloses + c.authorityDrops + c.rateLimitCloses + c.epochFences + c.bodyInactiveCloses
		+ c.tooLargeCloses + c.commitFailures + c.frameErrors + c.groupDropped + c.failedSocketDrops;
}

// ---------------------------------------------------------------------------

s.test("flag: '1' or 'true', requires lean rows; tunables parse and clamp; relay-crash route classifies with the relay flag", () => {
	assert.equal(groupCommitFlag("1"), true);
	assert.equal(groupCommitFlag("true"), true);
	assert.equal(groupCommitFlag("yes"), false);
	assert.equal(groupCommitFlag(undefined), false);
	assert.equal(readRelayConfig({ YAOS_RELAY_GROUP_COMMIT: "1" }).groupCommit, false, "requires YAOS_RELAY_LEAN_ROWS");
	const on = readRelayConfig({ YAOS_RELAY_GROUP_COMMIT: "1", YAOS_RELAY_LEAN_ROWS: "true" });
	assert.equal(on.groupCommit, true);
	assert.deepEqual([on.gcIdleMs, on.gcMaxMs, on.gcMaxBytes, on.gcTailBytes, on.gcCatalogDelayMs], [300, 1500, 65536, 65536, 30000]);
	const tuned = readRelayConfig({ YAOS_RELAY_GROUP_COMMIT: "true", YAOS_RELAY_LEAN_ROWS: "true", YAOS_RELAY_GC_IDLE_MS: "50",
		YAOS_RELAY_GC_MAX_MS: "400", YAOS_RELAY_GC_MAX_BYTES: "999999999", YAOS_RELAY_GC_TAIL_BYTES: "4096" });
	assert.deepEqual([tuned.gcIdleMs, tuned.gcMaxMs, tuned.gcTailBytes], [50, 400, 4096]);
	assert.equal(on.gcMinIntervalMs, 1000, "commit-rate cap default");
	assert.equal(readRelayConfig({ YAOS_RELAY_GC_MIN_INTERVAL_MS: "0" }).gcMinIntervalMs, 0);
	assert.equal(readRelayConfig({ YAOS_RELAY_GC_MIN_INTERVAL_MS: "2500" }).gcMinIntervalMs, 2500);
	assert.ok(tuned.gcMaxBytes <= 2 * 1024 * 1024, "gcMaxBytes is bounded by the durable update limit");
	const v2 = readRelayConfig({ YAOS_RELAY_LEAN_ROWS: "true", YAOS_RELAY_MICROBATCH_MS: "100" });
	assert.equal(v2.groupCommit, false);
	assert.equal(v2.microbatchMs, 100, "v2 flags unchanged");
	const request = new Request("https://example.test/vault/vault-route-0001/debug/relay-crash", { method: "POST" });
	assert.equal(classifyWorkerRoute(request, new URL(request.url), false).kind, "not-found");
	assert.equal(classifyWorkerRoute(request, new URL(request.url), true).kind, "vault");
	const get = new Request("https://example.test/vault/vault-route-0001/debug/relay-crash");
	assert.equal(classifyWorkerRoute(get, new URL(get.url), true).kind, "not-found");
});

s.test("B1: broadcast at receipt, receipt only after the group commit; one tail row, no journal row, no alarm per commit", async () => {
	await withRelay(({ store, relay, socket, update, envelope, seed, claim, journalRows, tail, alarmCalls }) => {
		const origin = socket();
		const other = socket(peer);
		const rows = journalRows();
		const head = store.documentHead(BODY)!.latestSequence;
		const updates: Uint8Array[] = [];
		for (let index = 0; index < 5; index++) {
			const bytes = textUpdate(seed, (text) => text.insert(text.length, String(index)));
			updates.push(bytes);
			envelope(origin, bytes, { ...claim(seed), candidateId: `b1-${index}`, candidateDigest: `d-${index}` });
			update(origin, bytes);
			assert.equal(other.binary.length, index + 1, "peer gets each frame at receipt");
		}
		assert.equal(origin.binary.length, 0, "origin never gets its own frame");
		assert.equal(origin.all("BODY_COMMITTED").length, 0, "no receipt before the commit");
		assert.equal(tail(), null, "nothing durable yet");
		assert.equal(store.documentHead(BODY)!.latestSequence, head);
		assert.deepEqual(relay.pendingGroups(), [{ bodyId: BODY, frames: 5, bytes: updates.reduce((sum, value) => sum + value.byteLength, 0) }]);
		relay.flushBatch(BODY);
		const acks = origin.all("BODY_COMMITTED");
		assert.equal(acks.length, 5, "every frame acked after the commit");
		const sequence = store.documentHead(BODY)!.latestSequence;
		assert.equal(sequence, head + 1, "one vault sequence per group commit");
		for (const ack of acks) {
			assert.equal(ack.vaultSequence, sequence);
			assert.equal(ack.relay, true);
			assert.equal(ack.deduped, false);
			assert.equal(ack.commitRuntimeEpoch, RUNTIME);
		}
		assert.deepEqual(acks.map((ack) => ack.contentHashAccepted), [false, false, false, false, true],
			"the newest exact claim is accepted");
		assert.equal(other.binary.length, 5, "no second fan-out after the commit");
		assert.equal(journalRows(), rows, "group commits write no journal row");
		const row = tail()!;
		assert.equal(row.frames, 1);
		assert.equal(row.latestSequence, sequence);
		assert.equal(row.contentHash, contentHashOf(seed.getText("body").toString()).hash);
		assert.equal(decodeTailRecords(row.data).length, 1);
		assert.equal(relay.counters.groupCommits, 1);
		assert.equal(relay.counters.groupFrames, 5);
		assert.equal(relay.counters.groupFlushForced, 1);
		assert.equal(alarmCalls.value, 1, "the catalog alarm is requested (host-deduped once per window)");
		assert.equal(reconstructedText(store), seed.getText("body").toString());
		assert.equal(catalogHashAt(store, sequence), row.contentHash, "catalog overlay serves the tail hash");
		assert.equal(store.committedOperationOutcome(owner, "b1-3", "d-3")?.vaultSequence, sequence, "G14 via the ring");
		assert.equal(store.committedOperationOutcome(owner, "b1-3", "wrong"), null);
		assert.equal(outcomes(relay), relay.counters.updateFrames);
	});
});

function catalogHashAt(store: VaultStore, sequence: number): string | null {
	return store.getCatalogHeadAt(sequence, BODY)!.contentHash;
}

s.test("B1 boundaries: idle, max and bytes flush the buffer (setTimeout, not setAlarm)", async () => {
	await withRelay(async ({ relay, socket, update, seed, envelope }) => {
		const origin = socket();
		for (let index = 0; index < 3; index++) {
			const bytes = textUpdate(seed, (text) => text.insert(0, "i"));
			envelope(origin, bytes, { candidateId: `idle-${index}` });
			update(origin, bytes);
			await sleep(10);
		}
		assert.equal(relay.counters.groupCommits, 0, "frames within the idle window keep buffering");
		await sleep(80);
		assert.equal(relay.counters.groupCommits, 1);
		assert.equal(relay.counters.groupFlushIdle, 1);
		assert.equal(origin.all("BODY_COMMITTED").length, 3);
	}, { gcIdleMs: 40, gcMaxMs: 10_000 });
	await withRelay(async ({ relay, socket, update, seed }) => {
		const origin = socket();
		const started = Date.now();
		while (relay.counters.groupCommits === 0 && Date.now() - started < 2_000) {
			update(origin, textUpdate(seed, (text) => text.insert(0, "m")));
			await sleep(15);
		}
		assert.equal(relay.counters.groupFlushMax, 1, "continuous typing flushes at the max window");
		assert.equal(relay.counters.groupFlushIdle, 0);
		assert.ok(Date.now() - started >= 100, "not before the max window");
	}, { gcIdleMs: 60, gcMaxMs: 120 });
	await withRelay(({ relay, socket, update, seed, envelope }) => {
		const origin = socket();
		const small = textUpdate(seed, (text) => text.insert(0, "s"));
		update(origin, small);
		assert.equal(relay.counters.groupCommits, 0);
		const large = textUpdate(seed, (text) => text.insert(0, "L".repeat(300)));
		envelope(origin, large, { candidateId: "bytes-1" });
		update(origin, large);
		assert.equal(relay.counters.groupFlushBytes, 1, "the byte cap flushes synchronously");
		assert.equal(relay.counters.groupFrames, 2);
		assert.equal(origin.all("BODY_COMMITTED").length, 1);
		assert.deepEqual(relay.pendingGroups(), []);
	}, { gcMaxBytes: 256 });
});

s.test("crash with a pending buffer: lost and unacked; the resend commits once and dedupes after", async () => {
	await withRelay(({ store, relay, socket, update, envelope, seed, freshRelay, tail, journalRows }) => {
		const origin = socket();
		const other = socket(peer);
		const before = seed.getText("body").toString();
		const head = store.documentHead(BODY)!.latestSequence;
		const bytes = textUpdate(seed, (text) => text.insert(0, "crash "));
		envelope(origin, bytes, { candidateId: "crash-1", candidateDigest: "crash-d" });
		update(origin, bytes);
		assert.equal(other.binary.length, 1, "the peer already has the frame");
		assert.equal(relay.dropPendingGroupCommits(), 1);
		assert.equal(relay.counters.groupDropped, 1);
		assert.equal(origin.all("BODY_COMMITTED").length, 0, "never acked");
		assert.equal(store.documentHead(BODY)!.latestSequence, head, "nothing durable");
		assert.equal(tail(), null);
		assert.equal(reconstructedText(store), before);
		assert.equal(outcomes(relay), relay.counters.updateFrames, "a dropped frame is an outcome");
		// New runtime; the client resends its unacked candidate (same id + digest).
		const next = freshRelay("runtime-v3-b");
		envelope(origin, bytes, { candidateId: "crash-1", candidateDigest: "crash-d" }, next);
		update(origin, bytes, next);
		next.flushBatch(BODY);
		const ack = origin.last("BODY_COMMITTED")!;
		assert.equal(ack.deduped, false);
		assert.equal(ack.vaultSequence, head + 1);
		assert.equal(ack.commitRuntimeEpoch, "runtime-v3-b");
		assert.equal(reconstructedText(store), seed.getText("body").toString());
		// A second resend (ack lost) is a ring dedupe: no rows.
		const rows = journalRows();
		const tailBefore = tail()!;
		envelope(origin, bytes, { candidateId: "crash-1", candidateDigest: "crash-d" }, next);
		update(origin, bytes, next);
		assert.equal(origin.last("BODY_COMMITTED")!.deduped, true);
		assert.equal(origin.last("BODY_COMMITTED")!.vaultSequence, head + 1);
		assert.deepEqual(next.pendingGroups(), [], "a pre-buffer dedupe never buffers");
		assert.equal(journalRows(), rows);
		assert.equal(tail()!.latestSequence, tailBefore.latestSequence);
		assert.equal(outcomes(next), next.counters.updateFrames);
	});
});

s.test("B6: a resend while the first copy is buffered dedupes at flush; reused id rejects; ring overflow falls back to a no-op ack", async () => {
	await withRelay(({ store, relay, socket, update, envelope, seed, tail }) => {
		const origin = socket();
		const bytes = textUpdate(seed, (text) => text.insert(0, "x"));
		for (let index = 0; index < 2; index++) {
			envelope(origin, bytes, { candidateId: "b6", candidateDigest: "b6-d" });
			update(origin, bytes);
		}
		relay.flushBatch(BODY);
		let acks = origin.all("BODY_COMMITTED");
		assert.equal(acks.length, 2);
		assert.deepEqual(acks.map((ack) => ack.deduped).sort(), [false, true]);
		assert.equal(acks[0]!.vaultSequence, acks[1]!.vaultSequence);
		assert.equal(tail()!.frames, 1);
		// Same id, other digest, buffered after the first commit: rejected at enqueue.
		envelope(origin, bytes, { candidateId: "b6", candidateDigest: "other" });
		update(origin, bytes);
		assert.equal(origin.last("BODY_UPDATE_REJECTED")!.reason, "candidate_id_reused");
		// A resend that was buffered before the first copy committed (two buffers:
		// first copy in runtime A's group, resend arrives after A committed).
		const second = textUpdate(seed, (text) => text.insert(0, "y"));
		envelope(origin, second, { candidateId: "b6-2", candidateDigest: "b6-2-d" });
		update(origin, second);
		const peerSocket = socket(peer);
		envelope(peerSocket, second, { candidateId: "b6-2", candidateDigest: "b6-2-d" });
		update(peerSocket, second);
		relay.flushBatch(BODY);
		assert.equal(peerSocket.all("BODY_COMMITTED").length, 1, "distinct device: its own receipt");
		// Flush-time ring check: buffer a resend, then commit the first copy through another runtime.
		const third = textUpdate(seed, (text) => text.insert(0, "z"));
		envelope(origin, third, { candidateId: "b6-3", candidateDigest: "b6-3-d" });
		update(origin, third);
		relay.flushBatch(BODY);
		envelope(origin, third, { candidateId: "b6-3", candidateDigest: "b6-3-d" });
		update(origin, third);
		assert.equal(origin.last("BODY_COMMITTED")!.deduped, true, "resend after commit: dedupe before buffering");
		acks = origin.all("BODY_COMMITTED");
		// Ring overflow: the oldest receipt ages out of the bounded ring; its resend
		// is a CRDT no-op (the bytes are durable) and gets a no-op ack, never a row.
		for (let index = 0; index < RELAY_RECEIPT_RING + 4; index++) {
			const change = textUpdate(seed, (text) => text.insert(0, "r"));
			envelope(origin, change, { candidateId: `ring-${index}`, candidateDigest: `ring-${index}` });
			update(origin, change);
			if (index % 50 === 49) relay.flushBatch(BODY);
		}
		relay.flushBatch(BODY);
		assert.equal(store.relayReceiptRing(owner.deviceId).length, RELAY_RECEIPT_RING);
		const sequence = store.documentHead(BODY)!.latestSequence;
		envelope(origin, bytes, { candidateId: "b6", candidateDigest: "b6-d" });
		update(origin, bytes);
		relay.flushBatch(BODY);
		const fallback = origin.last("BODY_COMMITTED")!;
		assert.equal(fallback.noop, true, "aged-out resend: no-op ack");
		assert.equal(store.documentHead(BODY)!.latestSequence, sequence, "no row");
		assert.equal(outcomes(relay), relay.counters.updateFrames);
		assert.equal(reconstructedText(store), seed.getText("body").toString());
	});
});

s.test("wake re-sync: a new runtime sends step1 once to earlier-runtime relay sockets; a covered step2 writes nothing", async () => {
	await withRelay(({ store, relay, socket, update, step2, seed, freshRelay, tail, envelope }) => {
		const a = socket();
		const b = socket(peer);
		const stale = socket(peer, { epoch: 99 });
		const lostDoc = cloneOf(seed);
		const lost = textUpdate(lostDoc, (text) => text.insert(0, "lost "));
		envelope(a, lost, { candidateId: "lost-1" });
		update(a, lost);
		assert.equal(b.binary.length, 1, "peer has the frame");
		relay.dropPendingGroupCommits();
		assert.equal(relay.ensureWakeResync(), 0, "the same runtime never re-syncs its own sockets");
		const next = freshRelay("runtime-v3-wake");
		const fresh = socket(peer, { runtimeEpoch: "runtime-v3-wake" });
		assert.equal(next.ensureWakeResync(), 2, "a and b (not the stale-epoch socket, not the new runtime's socket)");
		assert.equal(next.ensureWakeResync(), 0, "once per runtime");
		assert.equal(next.counters.wakeResyncs, 1);
		for (const target of [a, b]) {
			const step1s = target.frames().filter((value) => value.kind === 0);
			assert.equal(step1s.length, 1);
			assert.deepEqual(Y.decodeStateVector(step1s[0]!.payload), Y.decodeStateVector(Y.encodeStateVector(seed)),
				"the step1 carries the durable state vector");
		}
		assert.equal(stale.frames().filter((value) => value.kind === 0).length, 0, "stale epoch: no step1");
		assert.equal(fresh.frames().length, 0);
		// A client whose state equals the durable state answers with a covered step2: no row.
		const headBefore = store.documentHead(BODY)!.latestSequence;
		step2(fresh, Y.encodeStateAsUpdate(seed, Y.encodeStateVector(seed)), next);
		step2(fresh, Y.encodeStateAsUpdate(seed), next);
		next.flushBatch(BODY);
		assert.equal(store.documentHead(BODY)!.latestSequence, headBefore, "covered step2s are growth-cap no-ops");
		assert.equal(tail(), null);
		// Peer b answers with what the server lacks (the lost frame): committed once.
		const peerDoc = cloneOf(seed);
		Y.applyUpdate(peerDoc, lost);
		step2(b, Y.encodeStateAsUpdate(peerDoc, Y.encodeStateVector(seed)), next);
		next.flushBatch(BODY);
		assert.equal(store.documentHead(BODY)!.latestSequence, headBefore + 1);
		assert.equal(reconstructedText(store), peerDoc.getText("body").toString(), "the crash-lost frame is recovered from a peer");
		// The origin's resend afterwards is a CRDT no-op; its ack is held until a's
		// own wake step2 is durable (cumulative acks), then sent.
		envelope(a, lost, { candidateId: "lost-1" }, next);
		update(a, lost, next);
		next.flushBatch(BODY);
		assert.equal(a.all("BODY_COMMITTED").length, 0, "held: a has not answered the wake step1");
		step2(a, Y.encodeStateAsUpdate(lostDoc, Y.encodeStateVector(seed)), next);
		next.flushBatch(BODY);
		assert.equal(a.last("BODY_COMMITTED")!.noop, true);
		assert.equal(store.documentHead(BODY)!.latestSequence, headBefore + 1);
		lostDoc.destroy();
		peerDoc.destroy();
	});
});

s.test("a socket joining while frames are buffered gets them after its step2 (no gap until the commit)", async () => {
	await withRelay(({ relay, socket, update, step1, seed }) => {
		const origin = socket();
		const bytes = textUpdate(seed, (text) => text.insert(0, "pending "));
		update(origin, bytes);
		const joiner = socket(peer);
		step1(joiner, Y.encodeStateVector(new Y.Doc()));
		const frames = joiner.frames();
		assert.deepEqual(frames.map((value) => value.kind), [1, 2], "step2 of durable state, then the buffered frame");
		const view = new Y.Doc();
		for (const value of frames) Y.applyUpdate(view, value.payload);
		assert.equal(view.getText("body").toString(), seed.getText("body").toString());
		assert.equal(relay.counters.pendingReplayFrames, 1);
		view.destroy();
	});
});

/** What a peer socket holds: the durable base it synced plus every relayed frame it received. */
function peerView(base: Uint8Array, socket: FakeSocket): string {
	const view = new Y.Doc();
	try {
		Y.applyUpdate(view, base);
		for (const value of socket.frames()) Y.applyUpdate(view, value.payload);
		return view.getText("body").toString();
	} finally { view.destroy(); }
}

s.test("G2/epoch at flush (R11 safety net): a device revoked while buffered without a fence flush is still committed (it was broadcast), then 4403; an epoch change fences the buffer", async () => {
	await withRelay(({ store, relay, socket, update, seed, revoke, tail, envelope }) => {
		const base = Y.encodeStateAsUpdate(seed);
		const a = socket();
		const b = socket(peer);
		const writerA = cloneOf(seed);
		const fromA = textUpdate(writerA, (text) => text.insert(0, "A"));
		envelope(a, fromA, { candidateId: "rev-a" });
		update(a, fromA);
		update(b, textUpdate(seed, (text) => text.insert(0, "B")));
		assert.equal(b.binary.length, 1, "a's frame reached the peer at receipt");
		// An authority writer that skipped flushForAuthorityFence (R11 deployed shape).
		revoke(owner.deviceId);
		relay.flushBatch(BODY);
		assert.equal(a.closed?.code, 4403);
		assert.equal(b.closed, null);
		assert.equal(relay.counters.authorityDrops, 0, "v3 never drops a broadcast frame");
		assert.equal(relay.counters.revokedBroadcastCommits, 1);
		assert.equal(relay.counters.appendFrames, 2);
		assert.equal(peerView(base, b).includes("A"), true, "b holds a's frame");
		Y.applyUpdate(seed, fromA);
		assert.equal(reconstructedText(store), seed.getText("body").toString(), "durable == the merged peer state");
		assert.ok(reconstructedText(store).includes("A") && reconstructedText(store).includes("B"));
		// A later frame from the revoked socket never reaches peers or storage.
		const late = textUpdate(writerA, (text) => text.insert(0, "Z"));
		update(a, late);
		relay.flushBatch(BODY);
		assert.equal(b.binary.length, 1);
		assert.equal(relay.counters.appendFrames, 2);
		assert.equal(outcomes(relay), relay.counters.updateFrames);
		writerA.destroy();
	});
	await withRelay(({ store, relay, socket, update, seed, freshRelay, tail }) => {
		const a = socket(peer);
		update(a, textUpdate(cloneOf(seed), (text) => text.insert(0, "S")));
		// Another runtime resets the body while this one's buffer is pending.
		const other = freshRelay("runtime-v3-reset");
		const head = store.documentHead(BODY)!;
		const lease = other.acquireLease(BODY, peer, head.semanticEpoch, 60_000);
		assert.ok(lease.granted);
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, "reset");
		const content = contentHashOf("reset");
		const outcome = other.semanticReset(BODY, peer, { leaseId: lease.leaseId, expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence, snapshot: Y.encodeStateAsUpdate(fresh), contentHash: content.hash,
			contentBytes: content.size });
		fresh.destroy();
		assert.ok(outcome.ok, JSON.stringify(outcome));
		relay.flushBatch(BODY);
		assert.equal(a.closed?.code, 4409, "fenced at flush (in-transaction epoch check)");
		assert.equal(tail(), null);
		assert.equal(reconstructedText(store), "reset");
		assert.equal(outcomes(relay), relay.counters.updateFrames);
	}, { resetCooldownMs: 0 });
	await withRelay(({ store, relay, socket, update, seed, tail }) => {
		// A reset through the same runtime commits the buffer first (G3), then resets.
		const a = socket(peer);
		update(a, textUpdate(seed, (text) => text.insert(0, "Q")));
		const head = store.documentHead(BODY)!;
		const lease = relay.acquireLease(BODY, peer, head.semanticEpoch, 60_000);
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, "hello");
		const content = contentHashOf("hello");
		const outcome = relay.semanticReset(BODY, peer, { leaseId: lease.granted ? lease.leaseId : "", expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence, snapshot: Y.encodeStateAsUpdate(fresh), contentHash: content.hash,
			contentBytes: content.size });
		fresh.destroy();
		assert.equal(!outcome.ok && outcome.reason, "head_advanced", "the buffered frame committed before the reset");
		assert.equal(tail()!.frames, 1);
		assert.equal(reconstructedText(store), "Qhello");
	}, { resetCooldownMs: 0 });
});

s.test("R11: revocation while frames are buffered: the fence flush commits every broadcast frame first; peers and durable state converge", async () => {
	await withRelay(({ store, relay, socket, update, envelope, seed, revoke, tail, clock }) => {
		const base = Y.encodeStateAsUpdate(seed);
		const a = socket();
		const b = socket(peer);
		const writerA = cloneOf(seed);
		const ids: string[] = [];
		for (let index = 0; index < 10; index++) {
			const bytes = textUpdate(writerA, (text) => text.insert(text.length, `${index}`));
			const clientFrameId = `r11-${index}`;
			ids.push(clientFrameId);
			envelope(a, bytes, { clientFrameId, candidateId: `r11-c${index}` });
			update(a, bytes);
		}
		assert.equal(b.frames().length, 10, "10 frames broadcast while buffered (the B4 shape)");
		assert.equal(ackedIds(a).length, 0);
		// Server order (server.ts installAuthorityFence / revoke-device-sockets): fence flush, then the write, same turn.
		relay.flushForAuthorityFence();
		revoke(owner.deviceId);
		assert.equal(relay.counters.authorityFenceFlushes, 1);
		assert.deepEqual(ackedIds(a), ids, "all 10 committed under the authority that relayed them");
		assert.equal(relay.counters.appendFrames, 10);
		// The same socket sends again inside the actor-cache TTL (same clock): the bump makes the check fresh.
		const after = textUpdate(writerA, (text) => text.insert(0, "LATE"));
		envelope(a, after, { clientFrameId: "r11-late", candidateId: "r11-late" });
		update(a, after);
		assert.equal(a.closed?.code, 4403, "refused at receipt");
		assert.equal(b.frames().length, 10, "never broadcast");
		relay.flushBatch(BODY);
		clock.now += 60_000;
		relay.flushAllBatches();
		assert.equal(relay.counters.appendFrames, 10, "never appended");
		assert.equal(relay.counters.revokedBroadcastCommits, 0, "the safety net was not needed");
		assert.equal(relay.counters.authorityDrops, 0);
		assert.equal(reconstructedText(store), peerView(base, b), "peer == durable");
		assert.ok(!reconstructedText(store).includes("LATE"));
		assert.equal(outcomes(relay), relay.counters.updateFrames);
		writerA.destroy();
	});
});

s.test("R11: revocation racing broadcast: frames before the fence are broadcast and committed, frames after it neither; the other device keeps relaying", async () => {
	await withRelay(({ store, relay, socket, update, envelope, seed, revoke, tail }) => {
		const base = Y.encodeStateAsUpdate(seed);
		const a = socket();
		const b = socket(peer);
		const c = socket(peer);
		const writerA = cloneOf(seed);
		const writerB = cloneOf(seed);
		// Interleave: a, b, a | fence | a, b, a.
		const sendA = (label: string) => {
			const bytes = textUpdate(writerA, (text) => text.insert(text.length, label));
			envelope(a, bytes, { clientFrameId: label, candidateId: label });
			update(a, bytes);
		};
		const sendB = (label: string) => {
			const bytes = textUpdate(writerB, (text) => text.insert(0, label));
			envelope(b, bytes, { clientFrameId: label, candidateId: label });
			update(b, bytes);
		};
		sendA("a1"); sendB("b1"); sendA("a2");
		relay.flushForAuthorityFence();
		revoke(owner.deviceId);
		sendA("a3"); sendB("b2"); sendA("a4");
		relay.flushBatch(BODY);
		assert.equal(a.closed?.code, 4403);
		assert.equal(relay.counters.authorityCloses, 1, "a3 refused at receipt; a4 dropped after the refusal");
		assert.equal(relay.counters.failedSocketDrops, 1);
		assert.deepEqual(ackedIds(a), ["a1", "a2"]);
		assert.deepEqual(ackedIds(b), ["b1", "b2"]);
		assert.equal(relay.counters.appendFrames, 4, "a1 b1 a2 b2");
		const durable = reconstructedText(store);
		for (const label of ["a1", "a2", "b1", "b2"]) assert.ok(durable.includes(label), label);
		for (const label of ["a3", "a4"]) assert.ok(!durable.includes(label), label);
		assert.equal(peerView(base, c), durable, "an observer peer converges with durable state");
		// b's view: base + what it sent + what it received.
		const viewB = new Y.Doc();
		Y.applyUpdate(viewB, Y.encodeStateAsUpdate(writerB));
		for (const value of b.frames()) Y.applyUpdate(viewB, value.payload);
		assert.equal(viewB.getText("body").toString(), durable, "the writing peer converges too");
		viewB.destroy();
		assert.equal(outcomes(relay), relay.counters.updateFrames);
		writerA.destroy();
		writerB.destroy();
	});
});

s.test("B2: the tail cap checkpoints from the tail (snapshot overwritten, tail cleared, catalog coalesced, pins kept)", async () => {
	await withRelay(async ({ store, relay, socket, update, envelope, seed, claim, tail, journalRows }) => {
		const origin = socket();
		const commit = (text: string, index: number) => {
			const bytes = textUpdate(seed, (value) => value.insert(value.length, text));
			envelope(origin, bytes, { ...claim(seed), candidateId: `cap-${index}` });
			update(origin, bytes);
			relay.flushBatch(BODY);
		};
		commit("one", 0);
		commit("two", 1);
		const pinnedText = seed.getText("body").toString();
		const bootstrap = new BootstrapService(store, Date.now, undefined, relay.config.maxMergeInputBytes);
		await bootstrap.start();
		const boundary = store.currentSequence();
		assert.equal(tail()!.frames, 2);
		const rows = journalRows();
		let index = 2;
		while (relay.counters.tailCheckpoints === 0 && index < 200) commit("x".repeat(40), index++);
		assert.equal(relay.counters.tailCheckpoints, 1, "the cap triggered one checkpoint");
		assert.equal(tail(), null, "the checkpoint cleared the tail row");
		assert.equal(journalRows(), rows + 2, "the two records the active pin needs moved to journal rows");
		assert.equal(reconstructedText(store), seed.getText("body").toString());
		assert.equal(reconstructedText(store, boundary), pinnedText, "the pinned boundary still reconstructs");
		const expected = contentHashOf(seed.getText("body").toString());
		const head = store.getCatalogHeadAt(store.currentSequence(), BODY)!;
		assert.equal(head.contentHash, expected.hash, "the accepted hash survives the checkpoint (coalesced event)");
		assert.ok(relay.counters.leanCatalogEvents >= 1);
		// Writes continue on a fresh tail; HTTP/bootstrap byte reads see both parts.
		commit("tail", index++);
		assert.equal(tail()!.frames, 1);
		const state = relay.bodyHttpState(BODY)!;
		const view = new Y.Doc();
		Y.applyUpdate(view, state.bytes);
		assert.equal(view.getText("body").toString(), seed.getText("body").toString());
		view.destroy();
		// The alarm pass checkpoints only tails over the cap.
		relay.runCheckpointPass({ retainSequences: 1000 });
		assert.equal(tail()!.frames, 1, "a small tail is left alone by the alarm pass");
	}, { gcTailBytes: 400 });
});

s.test("catch-up: the feed reports tail commits at the head sequence, step1 serves tail bytes, the floor respects pins", async () => {
	await withRelay(({ store, relay, socket, update, step1, seed }) => {
		const origin = socket();
		const cursor = store.currentSequence();
		for (let index = 0; index < 3; index++) {
			update(origin, textUpdate(seed, (text) => text.insert(0, String(index))));
			relay.flushBatch(BODY);
		}
		const head = store.documentHead(BODY)!;
		assert.equal(head.latestSequence, cursor + 3);
		const page = store.changesPageAfter(cursor, 100);
		const body = page.entries.filter((entry) => entry.documentId === BODY);
		assert.equal(body.length, 1, "intermediate tail sequences collapse into the head");
		assert.equal(body[0]!.sequence, head.latestSequence);
		assert.equal(body[0]!.generation, head.generation);
		assert.equal(page.highWater, store.currentSequence());
		assert.equal(store.changesPageAfter(head.latestSequence, 100).entries.filter((entry) => entry.documentId === BODY).length, 0);
		const reader = socket(peer);
		step1(reader, Y.encodeStateVector(new Y.Doc()));
		const view = new Y.Doc();
		Y.applyUpdate(view, reader.frames()[0]!.payload);
		assert.equal(view.getText("body").toString(), seed.getText("body").toString(), "step2 = checkpoint + tail");
		view.destroy();
		// A partial step1 (reader already has the old state) gets only the diff.
		const partial = socket(peer);
		const old = new Y.Doc();
		Y.applyUpdate(old, reconstructedBytes(store, cursor));
		step1(partial, Y.encodeStateVector(old));
		Y.applyUpdate(old, partial.frames()[0]!.payload);
		assert.equal(old.getText("body").toString(), seed.getText("body").toString());
		old.destroy();
		const pass = relay.runCheckpointPass({ retainSequences: 0 });
		assert.ok(pass.floor <= store.currentSequence());
		assert.equal(reconstructedText(store), seed.getText("body").toString(), "floor advance never loses tail state");
	});
});

function reconstructedBytes(store: VaultStore, through: number): Uint8Array {
	const reconstructed = store.reconstructDocument(BODY, through);
	try { return crdtEngine.encodeStateAsUpdate(reconstructed.doc); }
	finally { crdtEngine.destroyDocument(reconstructed.doc); }
}

s.test("no silent drops: random interleavings with drops, resends and step2s keep the outcome identity and converge", async () => {
	await withRelay(({ store, relay, socket, update, envelope, step2, seed }) => {
		let random = 0x5eed;
		const next = () => { random = (Math.imul(random ^ (random >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return random / 2 ** 32; };
		const writers = [owner, peer].map((actor) => ({ actor, doc: cloneOf(seed), socket: socket(actor), id: 0 }));
		const truth = cloneOf(seed);
		for (let step = 0; step < 300; step++) {
			const writer = writers[Math.floor(next() * writers.length)]!;
			const change = textUpdate(writer.doc, (text) => text.insert(Math.floor(next() * (text.length + 1)), "abc"[step % 3]!));
			Y.applyUpdate(truth, change);
			const id = `w-${writer.actor.deviceId}-${writer.id++}`;
			envelope(writer.socket, change, { candidateId: id });
			update(writer.socket, change);
			if (next() < 0.1) { envelope(writer.socket, change, { candidateId: id }); update(writer.socket, change); }
			if (next() < 0.05) step2(writer.socket, Y.encodeStateAsUpdate(writer.doc));
			if (next() < 0.2) relay.flushAllBatches();
		}
		relay.flushAllBatches();
		assert.equal(outcomes(relay), relay.counters.updateFrames, "every update frame has exactly one outcome");
		assert.equal(relay.counters.frameErrors + relay.counters.commitFailures, 0);
		assert.equal(reconstructedText(store), truth.getText("body").toString());
		for (const writer of writers) writer.doc.destroy();
		truth.destroy();
	});
});

// ---------------------------------------------------------------------------
// Cumulative acks: the client treats an ack for frame N as confirming every
// earlier frame of that socket, so no frame may be refused while a later frame
// of the same socket is acked.
// ---------------------------------------------------------------------------

function ackedIds(socket: FakeSocket): string[] {
	return socket.all("BODY_COMMITTED").map((ack) => String(ack.clientFrameId));
}

s.test("cumulative acks: after a refused frame no later frame of the socket is acked (rate limit, commit failure, over-limit split)", async () => {
	// Rate limit (B7): frame 2 is refused with 1013; frame 3 arrives before the close completes.
	await withRelay(({ relay, socket, update, envelope, seed }) => {
		const origin = socket();
		const other = socket(peer);
		const small = textUpdate(seed, (text) => text.insert(0, "a"));
		envelope(origin, small, { clientFrameId: "rl-1" });
		update(origin, small);
		const big = textUpdate(seed, (text) => text.insert(0, "B".repeat(400)));
		envelope(origin, big, { clientFrameId: "rl-2" });
		update(origin, big);
		assert.equal(origin.closed?.code, 1013);
		const later = textUpdate(seed, (text) => text.insert(0, "c"));
		envelope(origin, later, { clientFrameId: "rl-3" });
		update(origin, later);
		assert.equal(relay.counters.rateLimitCloses, 1, "refused at the over-budget update frame");
		assert.equal(relay.counters.failedSocketDrops, 1);
		assert.equal(relay.counters.rawGateDrops, 2, "rl-3 envelope + update dropped at the raw gate");
		assert.equal(other.binary.length, 1, "a dropped frame is not broadcast either");
		relay.flushBatch(BODY);
		assert.deepEqual(ackedIds(origin), ["rl-1"], "only the frame before the refused one");
		assert.equal(outcomes(relay), relay.counters.updateFrames);
		// A new socket of the same device is unaffected (its own budget; a small resend).
		const reconnect = socket();
		const resend = later;
		envelope(reconnect, resend, { clientFrameId: "rl-resend" });
		update(reconnect, resend);
		relay.flushBatch(BODY);
		assert.deepEqual(ackedIds(reconnect), ["rl-resend"]);
	}, { burstBytes: 650, rateBytesPerSec: 1 }); // R12: envelopes (~200 chars) are charged too
	// Commit failure (VAULT_ERROR + 1011): a frame sent after it is dropped unacked.
	await withRelay(({ relay, relayStore, socket, update, envelope, seed }) => {
		const origin = socket();
		const original = relayStore.appendRelayGroupCommit.bind(relayStore);
		let fail = true;
		relayStore.appendRelayGroupCommit = (input) => {
			if (fail) { fail = false; throw new Error("injected SQLITE_FULL"); }
			return original(input);
		};
		const first = textUpdate(seed, (text) => text.insert(0, "x"));
		envelope(origin, first, { clientFrameId: "cf-1" });
		update(origin, first);
		relay.flushBatch(BODY);
		assert.equal(origin.closed?.code, 1011);
		assert.equal(relay.counters.commitFailures, 1);
		const second = textUpdate(seed, (text) => text.insert(0, "y"));
		envelope(origin, second, { clientFrameId: "cf-2" });
		update(origin, second);
		relay.flushBatch(BODY);
		assert.deepEqual(ackedIds(origin), []);
		assert.deepEqual(relay.pendingGroups(), []);
		assert.equal(relay.counters.failedSocketDrops, 1);
		assert.equal(outcomes(relay), relay.counters.updateFrames);
	});
	// Over-limit merge: committed frame by frame; frame 1 fails, so frame 2 of the
	// same socket must not commit/ack; another socket's frame still commits.
	await withRelay(({ relay, relayStore, socket, update, envelope, seed }) => {
		const origin = socket();
		const other = socket(peer);
		const otherDoc = cloneOf(seed);
		const original = relayStore.appendRelayGroupCommit.bind(relayStore);
		let calls = 0;
		relayStore.appendRelayGroupCommit = (input) => {
			if (++calls === 1) throw new Error("injected commit failure");
			return original(input);
		};
		const one = textUpdate(seed, (text) => text.insert(0, "1".repeat(1_000_000)));
		const two = textUpdate(seed, (text) => text.insert(0, "2".repeat(1_000_000)));
		const third = textUpdate(otherDoc, (text) => text.insert(0, "peer "));
		envelope(origin, one, { clientFrameId: "split-1" });
		update(origin, one);
		envelope(origin, two, { clientFrameId: "split-2" });
		update(origin, two);
		envelope(other, third, { clientFrameId: "split-peer" });
		update(other, third);
		relay.flushBatch(BODY);
		assert.equal(origin.closed?.code, 1011);
		assert.deepEqual(ackedIds(origin), [], "frame 2 is not acked over the failed frame 1");
		assert.deepEqual(ackedIds(other), ["split-peer"]);
		assert.equal(relay.counters.failedSocketDrops, 1);
		assert.equal(outcomes(relay), relay.counters.updateFrames);
		otherDoc.destroy();
	}, { gcMaxBytes: 4_000_000, burstBytes: 1 << 30 });
});

s.test("wake hold: after a wake, an earlier-runtime socket's acks wait until its re-sync step2 is durable", async () => {
	await withRelay(({ store, relay, socket, update, envelope, step2, seed, freshRelay }) => {
		const a = socket();
		const c = socket(peer);
		const docA = cloneOf(seed);
		const lost = textUpdate(docA, (text) => text.insert(0, "lost "));
		envelope(a, lost, { clientFrameId: "a-1" });
		update(a, lost);
		assert.equal(relay.dropPendingGroupCommits(), 1, "crash: a-1 is gone unacked");
		const next = freshRelay("runtime-v3-hold");
		const durableVector = Y.encodeStateVector(seed);
		assert.equal(next.ensureWakeResync(), 2);
		// a sends a later frame to the new runtime before it answered the step1.
		const after = textUpdate(docA, (text) => text.insert(text.length, " after"));
		envelope(a, after, { clientFrameId: "a-2" }, next);
		update(a, after, next);
		next.flushBatch(BODY);
		assert.equal(next.counters.groupCommits, 1, "a-2 is durable");
		assert.deepEqual(ackedIds(a), [], "but its ack would confirm the lost a-1: held");
		assert.equal(next.counters.wakeHeldAcks, 1);
		// a answers the wake step1 with what the server lacks (a-1): durable, then the held ack goes out.
		step2(a, Y.encodeStateAsUpdate(docA, durableVector), next);
		assert.deepEqual(ackedIds(a), [], "not before the step2 is durable");
		next.flushBatch(BODY);
		assert.deepEqual(ackedIds(a), ["a-2"]);
		assert.equal(reconstructedText(store), docA.getText("body").toString(), "a-1 recovered before any ack covered it");
		// Later frames ack normally.
		const more = textUpdate(docA, (text) => text.insert(0, "+"));
		envelope(a, more, { clientFrameId: "a-3" }, next);
		update(a, more, next);
		next.flushBatch(BODY);
		assert.deepEqual(ackedIds(a), ["a-2", "a-3"]);
		// c lost nothing: its empty step2 releases its held ack at once.
		const fromC = textUpdate(docA, (text) => text.insert(0, "c"));
		envelope(c, fromC, { clientFrameId: "c-1" }, next);
		update(c, fromC, next);
		next.flushBatch(BODY);
		assert.deepEqual(ackedIds(c), []);
		step2(c, new Uint8Array([0, 0]), next);
		assert.deepEqual(ackedIds(c), ["c-1"]);
		assert.equal(outcomes(next), next.counters.updateFrames);
		docA.destroy();
	});
});

s.test("HTTP reads: candidate and currentness flush the body's buffer first; an HTTP fallback of relayed bytes writes no body rows", async () => {
	await withRelay(async ({ store, relay, socket, update, envelope, seed, meter, tail, journalRows }) => {
		const origin = socket();
		assert.equal(relay.flushForRead(BODY), false, "nothing buffered");
		const cache = new VaultDocumentCache(store, () => new Set(), () => new Set());
		const candidates = new VaultCandidateService({
			store, cache,
			lifecycle: () => ({ finalizeCreation: () => "committed" }) as never,
			sockets: () => ({ broadcastDocumentUpdate: () => {}, notifyBodyCommitted: () => {} }) as never,
			vaultId: () => VAULT_ID, vaultGeneration: () => VAULT_GENERATION, runtimeEpoch: RUNTIME,
			flush: async () => true,
			flushRelay: (bodyId) => { relay.flushForRead(bodyId); },
			relayCommit: (input) => relay.commitHttpCandidate(input),
			validateActor: () => true,
		});
		const bytes = textUpdate(seed, (text) => text.insert(text.length, " relayed"));
		envelope(origin, bytes, { clientFrameId: "http-1" });
		update(origin, bytes);
		assert.equal(relay.pendingGroups().length, 1);
		const head = store.documentHead(BODY)!.latestSequence;
		const rowsBefore = journalRows();
		meter.reset();
		meter.on = true;
		const response = await candidates.handle(BODY, new Request("https://internal/body/x/candidate", {
			method: "POST", body: bytes, headers: { "x-yaos-candidate-id": "http-fallback-1",
				"x-yaos-candidate-digest": sha256HexSync(candidateDigestMaterial([bytes])),
				"x-yaos-body-epoch": String(store.documentHead(BODY)!.semanticEpoch) } }), owner);
		meter.on = false;
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(relay.counters.groupFlushReads, 1, "the HTTP candidate flushed the buffer");
		assert.deepEqual(ackedIds(origin), ["http-1"], "the relay ack goes out at once, not after the idle window");
		const receipt = await response.json() as Record<string, unknown>;
		assert.equal(store.documentHead(BODY)!.latestSequence, head + 1, "one commit: the group; the HTTP copy is a no-op");
		assert.equal(receipt.durableGeneration, store.documentHead(BODY)!.generation);
		assert.equal(journalRows(), rowsBefore, "no journal row for the HTTP copy");
		assert.equal(tail()!.frames, 1);
		console.log(`[relay3-gc] HTTP fallback of relayed bytes (incl. the flushed group commit): rows ${meter.rows}, by table ${JSON.stringify(meter.byTable)}`);
		// The flushed group commit: tail 1 + head 1. The HTTP copy (a no-op): its receipt
		// ring entry only (1 row; was outcome 2 + candidate receipt 2 before the HTTP relay path).
		assert.deepEqual(meter.byTable, { relay_body_tail: 1, vault_document_heads: 1, relay_device_receipts: 1 });
		assert.equal(relay.counters.httpRelayNoops, 1);
		assert.equal(reconstructedText(store), seed.getText("body").toString());
		// A replay of the same HTTP candidate is answered from its receipt.
		meter.reset();
		meter.on = true;
		const replay = await candidates.handle(BODY, new Request("https://internal/body/x/candidate", {
			method: "POST", body: bytes, headers: { "x-yaos-candidate-id": "http-fallback-1",
				"x-yaos-candidate-digest": sha256HexSync(candidateDigestMaterial([bytes])),
				"x-yaos-body-epoch": String(store.documentHead(BODY)!.semanticEpoch) } }), owner);
		meter.on = false;
		assert.equal(replay.status, 200);
		assert.equal(meter.rows, 0, "replay writes nothing");
		// Currentness: flushForRead commits a buffered frame before the head is read.
		const next = textUpdate(seed, (text) => text.insert(0, "q"));
		update(origin, next);
		assert.equal(relay.flushForRead(BODY), true);
		assert.equal(store.documentHead(BODY)!.latestSequence, head + 2);
		assert.equal(relay.counters.groupFlushReads, 2);
	});
});

s.test("HTTP save row accounting: a closed-note candidate POST, base path (before) vs relay group-commit path (after)", async () => {
	type Post = { status: number; rows: number; byTable: Record<string, number>; receipt: Record<string, unknown> };
	const run = async (relayPath: boolean, check?: (context: { store: VaultStore; relay: RelayBodyService; relayStore: RelayBodyStore;
		post: (bytes: Uint8Array, candidateId: string) => Promise<Post>; seed: Y.Doc; meter: Meter }) => Promise<void>) => {
		const posts: Post[] = [];
		await withRelay(async ({ store, relay, relayStore, seed, meter }) => {
			const cache = new VaultDocumentCache(store, () => new Set(), () => new Set());
			const candidates = new VaultCandidateService({
				store, cache,
				lifecycle: () => ({ finalizeCreation: () => "committed" }) as never,
				sockets: () => ({ broadcastDocumentUpdate: () => {}, notifyBodyCommitted: () => {} }) as never,
				vaultId: () => VAULT_ID, vaultGeneration: () => VAULT_GENERATION, runtimeEpoch: RUNTIME,
				flush: async () => true,
				flushRelay: (bodyId) => { relay.flushForRead(bodyId); },
				...(relayPath ? { relayCommit: (input: Parameters<RelayBodyService["commitHttpCandidate"]>[0]) => relay.commitHttpCandidate(input) } : {}),
				validateActor: () => true,
			});
			const post = async (bytes: Uint8Array, candidateId: string, digest = sha256HexSync(candidateDigestMaterial([bytes]))): Promise<Post> => {
				meter.reset();
				meter.on = true;
				const response = await candidates.handle(BODY, new Request("https://internal/body/x/candidate", {
					method: "POST", body: bytes, headers: { "x-yaos-candidate-id": candidateId, "x-yaos-candidate-digest": digest,
						"x-yaos-body-epoch": String(store.documentHead(BODY)!.semanticEpoch) } }), owner);
				meter.on = false;
				return { status: response.status, rows: meter.rows, byTable: { ...meter.byTable },
					receipt: await response.json() as Record<string, unknown> };
			};
			for (let index = 0; index < 6; index++) {
				posts.push(await post(textUpdate(seed, (text) => text.insert(text.length, ` save${index}`)), `save-${index}`));
			}
			await check?.({ store, relay, relayStore, post, seed, meter });
		});
		return posts;
	};
	const before = await run(false);
	for (const value of before) assert.equal(value.status, 200);
	console.log(`[relay3-gc] HTTP save, base path (before): rows ${before[1]!.rows}, by table ${JSON.stringify(before[1]!.byTable)}`);
	// b3-bulk: heads, catalog events and attribution are WITHOUT ROWID now (no PK autoindex to bill), so the base path
	// is 11 rows, not relay3's 14 (HTTPSAVE measured 13.82 on rowid tables): -1 each on those three tables.
	assert.deepEqual(before[1]!.byTable, { vault_clock: 1, vault_journal: 2, vault_mutation_attribution: 1, vault_document_heads: 1,
		vault_catalog_events: 2, vault_operation_outcomes: 2, vault_candidate_receipts: 2 }, "11 rows (14 on rowid tables, HTTPSAVE measured 13.82)");
	const after = await run(true, async ({ store, relay, relayStore, post, seed, meter }) => {
		assert.equal(relay.counters.httpRelayCommits, 6);
		assert.equal(relay.counters.appendFrames, 0, "not frame outcomes");
		assert.equal(reconstructedText(store), seed.getText("body").toString());
		// The catalog head (tail overlay) already names the exact saved content.
		assert.equal(store.getCatalogHeadAt(store.currentSequence(), BODY)!.contentHash,
			contentHashOf(seed.getText("body").toString()).hash);
		// Replay: same id and digest -> the same receipt, nothing written.
		const ring = store.relayReceiptRing(owner.deviceId);
		assert.equal(ring[0]!.c, "save-5");
		const saved = textUpdate(seed, (text) => text.insert(0, "R"));
		const first = await post(saved, "replay-1");
		assert.equal(first.status, 200);
		assert.equal(first.rows, 3);
		const replay = await post(saved, "replay-1");
		assert.equal(replay.status, 200);
		assert.equal(replay.rows, 0, "replay is answered from the ring");
		assert.deepEqual(replay.receipt, first.receipt);
		const reused = await post(textUpdate(seed, (text) => text.insert(0, "X")), "replay-1");
		assert.equal(reused.status, 409);
		assert.equal(reused.receipt.error, "candidate_id_reused_with_different_digest");
		// Outcome lookup (client recoverCandidateOutcome) from the ring.
		const outcome = store.committedOperationOutcome(owner, "replay-1", sha256HexSync(candidateDigestMaterial([saved])));
		assert.equal(outcome?.vaultSequence, store.relayReceiptRing(owner.deviceId).find((entry) => entry.c === "replay-1")!.s);
		assert.ok(outcome!.vaultSequence > 0);
		assert.equal(store.candidateReceipt(BODY, owner.deviceId, "replay-1")?.durableGeneration, first.receipt.durableGeneration);
		// An identical re-save under a new id (bytes already durable): ring row only.
		const copy = await post(saved, "copy-1");
		assert.equal(copy.status, 200);
		assert.deepEqual(copy.byTable, { relay_device_receipts: 1 });
		assert.equal(relay.counters.httpRelayNoops, 1);
		// Deferred catalog event (alarm, once per gcCatalogDelayMs window) for the six saves.
		meter.reset();
		meter.on = true;
		relayStore.coalesceLeanCatalog({ bodyId: BODY });
		meter.on = false;
		console.log(`[relay3-gc] HTTP save, deferred catalog coalesce per window: rows ${meter.rows}, by table ${JSON.stringify(meter.byTable)}`);
		assert.ok(meter.rows <= 5);
	});
	for (const value of after) assert.equal(value.status, 200);
	console.log(`[relay3-gc] HTTP save, relay path (after): rows ${after[1]!.rows}, by table ${JSON.stringify(after[1]!.byTable)}`);
	assert.deepEqual(after[1]!.byTable, { relay_body_tail: 1, vault_document_heads: 1, relay_device_receipts: 1 });
	for (const [index, value] of after.entries()) {
		assert.equal(value.receipt.durableGeneration, before[index]!.receipt.durableGeneration, "same receipt contract");
		assert.deepEqual(Object.keys(value.receipt).sort(), Object.keys(before[index]!.receipt).sort());
	}
});

// ---------------------------------------------------------------------------
// Row accounting (Cloudflare-style): v2 lean vs v3 for the same keystrokes.
// ---------------------------------------------------------------------------

interface Accounting { rows: number; statements: number; byTable: Record<string, number>; alarms: number; commits: number }

async function measure(config: Partial<RelayConfig>, keystrokes: number, perCommit: number): Promise<Accounting> {
	let result!: Accounting;
	await withRelay(({ relay, socket, update, envelope, seed, claim, meter }) => {
		const origin = socket();
		socket(peer);
		meter.reset();
		meter.on = true;
		for (let index = 0; index < keystrokes; index++) {
			const bytes = textUpdate(seed, (text) => text.insert(text.length, "k"));
			envelope(origin, bytes, { ...claim(seed), candidateId: `acct-${index}`, candidateDigest: `acct-${index}` });
			update(origin, bytes);
			if ((index + 1) % perCommit === 0) relay.flushBatch(BODY);
		}
		relay.flushBatch(BODY);
		meter.on = false;
		result = { rows: meter.rows, statements: meter.statements, byTable: { ...meter.byTable }, alarms: meter.alarms,
			commits: config.groupCommit === false ? relay.counters.appends : relay.counters.groupCommits };
	}, config);
	return result;
}

s.test("row accounting: v2 lean vs v3 (statements x index entries, CF-style)", async () => {
	const keystrokes = 120;
	const v2 = await measure({ groupCommit: false, microbatchMs: 0 }, keystrokes, 1);
	const v3single = await measure({}, keystrokes, 1);
	const v3 = await measure({}, keystrokes, 10);
	const line = (name: string, value: Accounting) => console.log(`[relay3-gc] ${name}: ${value.commits} commits, `
		+ `rows ${value.rows} (${(value.rows / keystrokes).toFixed(2)}/keystroke, ${(value.rows / value.commits).toFixed(2)}/commit), `
		+ `statements ${value.statements}, alarm windows ${value.alarms}, by table ${JSON.stringify(value.byTable)}`);
	line("v2 lean, 1 frame/commit", v2);
	line("v3, 1 frame/commit", v3single);
	line("v3, 10 frames/commit", v3);
	assert.equal(v2.commits, keystrokes);
	assert.equal(v3.commits, keystrokes / 10);
	assert.ok(v2.rows / keystrokes >= 4, `v2 lean is >= 4 rows/keystroke before its alarm (${v2.rows / keystrokes})`);
	assert.equal(v3single.rows / v3single.commits, 3, "v3 commit = tail UPSERT + head UPDATE + one receipt row");
	assert.deepEqual(Object.keys(v3.byTable).sort(), ["relay_body_tail", "relay_device_receipts", "vault_document_heads"]);
	assert.ok(v3.rows / keystrokes <= 0.31, `v3 at 10 frames/commit <= 0.31 rows/keystroke (${v3.rows / keystrokes})`);
	assert.ok(v3.alarms <= 1 && v2.alarms <= 1, "alarms are host-deduped per window in both");
	// Amortised checkpoint cost: one tail checkpoint per ~gcTailBytes of updates.
	await withRelay(({ relay, socket, update, seed, meter }) => {
		const origin = socket();
		for (let index = 0; index < 20; index++) {
			update(origin, textUpdate(seed, (text) => text.insert(text.length, "c".repeat(30))));
			relay.flushBatch(BODY);
		}
		meter.reset();
		meter.on = true;
		relay.checkpointTail(BODY);
		meter.on = false;
		console.log(`[relay3-gc] tail checkpoint: rows ${meter.rows}, statements ${meter.statements}, by table ${JSON.stringify(meter.byTable)}`);
		assert.ok(meter.rows > 0 && meter.rows < 40);
	});
});

// ---------------------------------------------------------------------------
// b3-ckpt: checkpoint hysteresis + memory bound for large whole-note rewrites.
// ---------------------------------------------------------------------------

function rewriteText(seed: number, bytes: number): string {
	const random = seeded(seed);
	let out = "";
	while (out.length < bytes) out += String.fromCharCode(97 + Math.floor(random() * 26));
	return out;
}

interface RewriteRun { rows: number; saves: number; checkpoints: number; deferred: number; hashUnknown: number;
	hashAccepted: number; compactions: number; mergedBytes: number | null; wasmGrowth: number }

async function rewrites(config: Partial<RelayConfig>, saves: number, noteBytes = 50_000): Promise<RewriteRun> {
	let result!: RewriteRun;
	await withRelay(({ store, relay, socket, update, envelope, seed, claim, meter, clock }) => {
		const origin = socket();
		socket(peer);
		const wasmBefore = (relay.diagnostics().ywasmLinearMemoryBytes as number | null) ?? 0;
		meter.reset();
		meter.on = true;
		for (let index = 0; index < saves; index++) {
			clock.now += 5_000; // A1 cadence; also refills the per-socket byte bucket
			const text = rewriteText(index + 1, noteBytes);
			const bytes = textUpdate(seed, (value) => { value.delete(0, value.length); value.insert(0, text); });
			envelope(origin, bytes, { ...claim(seed), candidateId: `rw-${index}`, candidateDigest: `rw-${index}` });
			update(origin, bytes);
			relay.flushBatch(BODY);
		}
		meter.on = false;
		const got = reconstructedText(store), want = seed.getText("body").toString();
		assert.ok(got === want, `rewrites reconstruct exactly (${JSON.stringify(config)}: ${got.length} vs ${want.length}, ${got.slice(0, 12)} vs ${want.slice(0, 12)})`);
		const body = (relay.diagnostics().bodies as Array<{ bodyId: string; mergedBytes: number | null }>).find((entry) => entry.bodyId === BODY);
		const wasmAfter = (relay.diagnostics().ywasmLinearMemoryBytes as number | null) ?? 0;
		result = { rows: meter.rows, saves, checkpoints: relay.counters.checkpoints, deferred: relay.counters.tailCheckpointsDeferred,
			hashUnknown: relay.counters.hashUnknown, hashAccepted: relay.counters.hashAccepted,
			compactions: relay.counters.mergedGcCompactions, mergedBytes: body?.mergedBytes ?? null, wasmGrowth: wasmAfter - wasmBefore };
	}, config);
	return result;
}

s.test("ckpt: 50 KB whole rewrites checkpoint every >= 10 saves (hysteresis) and stay hash-exact", async () => {
	const saves = 40;
	const old = await rewrites({ gcTailRatio: 0 }, saves);
	const tuned = await rewrites({}, saves);
	const line = (name: string, run: RewriteRun) => console.log(`[relay3-ckpt] ${name}: ${run.saves} saves, rows ${run.rows} `
		+ `(${(run.rows / run.saves).toFixed(2)}/save), checkpoints ${run.checkpoints}, deferred ${run.deferred}, hash `
		+ `${run.hashAccepted}/${run.hashAccepted + run.hashUnknown}, gc ${run.compactions}, merged ${run.mergedBytes} B, wasm +${run.wasmGrowth} B`);
	line("old trigger (64 KiB tail)", old);
	line("hysteresis (16x checkpoint, 768 KiB cap)", tuned);
	assert.ok(old.checkpoints >= saves / 3, `the old trigger checkpoints about every 2 saves (${old.checkpoints})`);
	assert.ok(tuned.checkpoints <= saves / 10, `hysteresis checkpoints at most every 10 saves (${tuned.checkpoints})`);
	assert.ok(tuned.checkpoints >= 1, "the cap still checkpoints");
	assert.ok(tuned.deferred > 0, "deferrals are counted");
	assert.ok(tuned.rows / saves < 4.5, `rows/save ${tuned.rows / saves} < 4.5`);
	assert.ok(tuned.rows < old.rows * 0.7, `hysteresis writes fewer rows (${tuned.rows} vs ${old.rows})`);
	assert.equal(tuned.hashUnknown, 0, "every content-hash claim stays accepted (exact merge window kept)");
	assert.ok(tuned.compactions > 0, "the in-memory GC compaction ran");
	assert.ok(tuned.mergedBytes !== null && tuned.mergedBytes <= DEFAULT_RELAY_CONFIG.exactMergeBytes,
		`merged bytes stay in the exact window (${tuned.mergedBytes})`);
	assert.ok(tuned.wasmGrowth < 16 * 1024 * 1024, `wasm linear memory growth bounded (${tuned.wasmGrowth})`);
});

s.test("ckpt: small-edit typing keeps the old checkpoint cadence (frame cap / 64 KiB), alarm pass defers big tails only", async () => {
	const typing = async (config: Partial<RelayConfig>) => {
		let checkpoints = 0, deferred = 0;
		await withRelay(({ store, relay, socket, update, seed }) => {
			const origin = socket();
			for (let index = 0; index < 1200; index++) {
				update(origin, textUpdate(seed, (text) => text.insert(text.length, "k")));
				relay.flushBatch(BODY);
			}
			assert.equal(reconstructedText(store), seed.getText("body").toString());
			checkpoints = relay.counters.checkpoints;
			deferred = relay.counters.tailCheckpointsDeferred;
		}, config);
		return { checkpoints, deferred };
	};
	const old = await typing({ gcTailRatio: 0 });
	const tuned = await typing({});
	console.log(`[relay3-ckpt] typing 1200 commits: old ${old.checkpoints} checkpoints, hysteresis ${tuned.checkpoints} (deferred ${tuned.deferred})`);
	assert.ok(old.checkpoints >= 2);
	assert.equal(tuned.checkpoints, old.checkpoints, "typing cadence unchanged");
	assert.equal(tuned.deferred, 0, "small tails never reach the deferral path");
	// The alarm pass leaves a big-but-under-threshold tail alone, and takes it with the old policy.
	for (const [config, expectTail] of [[{}, true], [{ gcTailRatio: 0 }, false]] as const) {
		await withRelay(({ relay, socket, update, seed, tail, clock }) => {
			const origin = socket();
			// Prime: one rewrite + checkpoint, so the checkpoint is ~30 KB (threshold 16x that).
			update(origin, textUpdate(seed, (value) => { value.delete(0, value.length); value.insert(0, rewriteText(99, 30_000)); }));
			relay.flushBatch(BODY);
			relay.checkpointTail(BODY);
			for (let index = 0; index < 3; index++) {
				clock.now += 5_000;
				const text = rewriteText(100 + index, 30_000);
				update(origin, textUpdate(seed, (value) => { value.delete(0, value.length); value.insert(0, text); }));
				relay.flushBatch(BODY);
			}
			const before = relay.counters.checkpoints;
			if (expectTail) assert.ok(tail() !== null && tail()!.byteLength > relay.config.gcTailBytes,
				`tail is over the soft cap (${tail()?.byteLength}, deferred ${relay.counters.tailCheckpointsDeferred})`);
			relay.runCheckpointPass({ retainSequences: 1000 });
			if (expectTail) {
				assert.ok(tail() !== null, "the alarm pass defers a tail under the hysteresis threshold");
				assert.equal(relay.counters.checkpoints, before);
			} else {
				assert.equal(tail(), null, "the old policy checkpoints it");
			}
		}, config);
	}
});

s.test("ckpt: a cold rebuild over a large rewrite tail compacts back into the exact window", async () => {
	await withRelay(({ store, relay, socket, update, envelope, seed, claim, freshRelay, clock }) => {
		const origin = socket();
		for (let index = 0; index < 8; index++) {
			clock.now += 5_000;
			const text = rewriteText(200 + index, 50_000);
			update(origin, textUpdate(seed, (value) => { value.delete(0, value.length); value.insert(0, text); }));
			relay.flushBatch(BODY);
		}
		clock.now += 5_000;
		const cold = freshRelay("runtime-cold");
		const bytes = textUpdate(seed, (value) => value.insert(0, "z"));
		envelope(origin, bytes, { ...claim(seed), candidateId: "cold-1", candidateDigest: "cold-1" }, cold);
		update(origin, bytes, cold);
		cold.flushBatch(BODY);
		assert.equal(cold.counters.hashUnknown, 0, "hash claim accepted after a cold rebuild");
		assert.ok(cold.counters.mergedGcCompactions >= 1, "the rebuild compacted the merged state");
		const body = (cold.diagnostics().bodies as Array<{ bodyId: string; mergedBytes: number | null }>).find((entry) => entry.bodyId === BODY);
		assert.ok(body?.mergedBytes != null && body.mergedBytes <= DEFAULT_RELAY_CONFIG.exactMergeBytes, `merged ${body?.mergedBytes}`);
		assert.equal(reconstructedText(store), seed.getText("body").toString());
	});
});


// ---------------------------------------------------------------------------
// Durable Object: the test-only relay-crash route.
// ---------------------------------------------------------------------------

const DO_VAULT = "vault-relay3-0001";
const DO_GENERATION = "generation-relay3-0001";

async function withVaultObject(env: CloudflareVaultEnvironment, check: (server: VaultSyncServer) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-relay3-do-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	let alarm: number | null = null;
	const base = makeDurableObjectState({ getWebSockets: () => [] });
	const storage = Object.assign(sqlite, {
		setAlarm: async (time: number) => { alarm = time; },
		getAlarm: async () => alarm,
		deleteAlarm: async () => { alarm = null; },
		deleteAll: async () => {},
	});
	try {
		await check(new VaultSyncServer({ ...base, storage: storage as never } as DurableObjectState, env));
	} finally {
		sqlite.database.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function internal(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set("x-yaos-vault-id", DO_VAULT);
	headers.set("x-yaos-vault-generation", DO_GENERATION);
	return new Request(`https://internal${path}`, { ...init, headers });
}

s.test("relay-crash route: 404 unless test routes + group commit; otherwise drops buffers and swaps the runtime", async () => {
	const relayEnv = { YAOS_RELAY_BODIES: "true", YAOS_RELAY_LEAN_ROWS: "true" };
	for (const env of [relayEnv, { ...relayEnv, YAOS_TEST_ONLY_DEBUG_ROUTES: "true" }, { ...relayEnv, YAOS_RELAY_GROUP_COMMIT: "1" }]) {
		await withVaultObject(env as CloudflareVaultEnvironment, async (server) => {
			const provision = await server.fetch(internal("/__yaos/provision", { method: "POST",
				headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: DO_GENERATION }) }));
			assert.ok(provision.ok);
			assert.equal((await server.fetch(internal(RELAY_CRASH_RUNTIME_PATH, { method: "POST" }))).status, 404, JSON.stringify(env));
		});
	}
	await withVaultObject({ ...relayEnv, YAOS_TEST_ONLY_DEBUG_ROUTES: "true", YAOS_RELAY_GROUP_COMMIT: "1" } as CloudflareVaultEnvironment,
		async (server) => {
			const provision = await server.fetch(internal("/__yaos/provision", { method: "POST",
				headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: DO_GENERATION }) }));
			assert.ok(provision.ok, `provision ${provision.status}`);
			const response = await server.fetch(internal(RELAY_CRASH_RUNTIME_PATH, { method: "POST" }));
			assert.equal(response.status, 200);
			const body = await response.json() as Record<string, unknown>;
			assert.equal(body.simulated, "relay-crash");
			assert.equal(body.droppedRelayFrames, 0);
			assert.notEqual(body.runtimeEpoch, body.previousRuntimeEpoch);
			const again = await server.fetch(internal("/__yaos/provision", { method: "POST",
				headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: DO_GENERATION }) }));
			assert.ok(again.ok, "the new runtime serves the same storage");
		});
});

s.test("R11 wiring: the DO flushes every group buffer in the same turn right before each authority write (fence, revoke-device-sockets)", async () => {
	await withVaultObject({ YAOS_RELAY_BODIES: "true", YAOS_RELAY_LEAN_ROWS: "true", YAOS_RELAY_GROUP_COMMIT: "1" } as CloudflareVaultEnvironment,
		async (server) => {
			const provision = await server.fetch(internal("/__yaos/provision", { method: "POST",
				headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: DO_GENERATION }) }));
			assert.ok(provision.ok, `provision ${provision.status}`);
			const inner = (server as unknown as { runtime: { relay: RelayBodyService; store: VaultStore } }).runtime;
			const order: string[] = [];
			const flush = inner.relay.flushForAuthorityFence.bind(inner.relay);
			inner.relay.flushForAuthorityFence = () => { order.push("flush"); flush(); };
			const install = inner.store.installAuthorityFence.bind(inner.store);
			inner.store.installAuthorityFence = (input) => { order.push("fence"); return install(input); };
			const revokeDevice = inner.store.revokeDevice.bind(inner.store);
			inner.store.revokeDevice = (deviceId, now) => { order.push("revoke"); revokeDevice(deviceId, now); };
			const fence = await server.fetch(internal("/__yaos/authority-fence", { method: "POST",
				headers: { "content-type": "application/json" }, body: JSON.stringify({ changeId: "r11-wiring",
					vaultId: DO_VAULT, vaultGeneration: DO_GENERATION, subjects: [
						{ principalId: "principal-r11", role: "owner", state: "active", membershipRevision: 1 },
						{ deviceId: "device-r11", principalId: "principal-r11", state: "active", credentialRevision: 1 },
					] }) }));
			assert.equal(fence.status, 200, await fence.clone().text());
			const revoked = await server.fetch(internal("/__yaos/revoke-device-sockets", { method: "POST",
				headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: "device-r11" }) }));
			assert.equal(revoked.status, 200);
			assert.deepEqual(order, ["flush", "fence", "flush", "revoke"]);
			assert.equal(inner.relay.counters.authorityFenceFlushes, 2);
			// HTTP save wiring (same flag): candidates commit through the relay group-commit store.
			const candidateOptions = (server as unknown as { runtime: { candidates: { options: Record<string, unknown> } } })
				.runtime.candidates.options;
			assert.equal(typeof candidateOptions.relayCommit, "function");
			assert.equal(typeof candidateOptions.flushRelay, "function");
		});
});

// ---------------------------------------------------------------------------
// Commit-rate cap (YAOS_RELAY_GC_MIN_INTERVAL_MS): cost must not depend on the
// typing rhythm. Virtual time; one origin, one observer, one body.
// ---------------------------------------------------------------------------

function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface TypingRun { keys: number; commits: number; rows: number; minGapMs: number; maxCommitsPerSecond: number;
	maxReceiptMs: number; p50ReceiptMs: number }

async function typing(gaps: number[], minIntervalMs: number): Promise<TypingRun> {
	let run: TypingRun | null = null;
	await withRelay(({ relay, relayStore, socket, update, envelope, seed, clock, meter, advance }) => {
		const origin = socket();
		socket(peer);
		const commitTimes: number[] = [];
		const original = relayStore.appendRelayGroupCommit.bind(relayStore);
		relayStore.appendRelayGroupCommit = (input) => { commitTimes.push(clock.now); return original(input); };
		const sentAt = new Map<string, number>();
		const ackAt = new Map<string, number>();
		const send = origin.send.bind(origin);
		origin.send = (message) => {
			send(message);
			const ack = origin.controls.at(-1);
			if (typeof message === "string" && ack?.type === "BODY_COMMITTED") ackAt.set(String(ack.clientFrameId), clock.now);
		};
		meter.reset();
		meter.on = true;
		gaps.forEach((gap, index) => {
			advance(gap);
			const frame = textUpdate(seed, (text) => text.insert(text.length, "k"));
			const id = `key-${index}`;
			envelope(origin, frame, { clientFrameId: id, candidateId: `cand-${index}`, candidateDigest: `cand-${index}` });
			update(origin, frame);
			sentAt.set(id, clock.now);
		});
		advance(5_000);
		meter.on = false;
		assert.equal(ackAt.size, gaps.length, "every keystroke is acked");
		const receipts = [...sentAt].map(([id, at]) => ackAt.get(id)! - at).sort((a, b) => a - b);
		let minGapMs = Infinity;
		for (let index = 1; index < commitTimes.length; index++) {
			minGapMs = Math.min(minGapMs, commitTimes[index]! - commitTimes[index - 1]!);
		}
		const perSecond = new Map<number, number>();
		for (const at of commitTimes) perSecond.set(Math.floor(at / 1000), (perSecond.get(Math.floor(at / 1000)) ?? 0) + 1);
		run = { keys: gaps.length, commits: commitTimes.length, rows: meter.rows, minGapMs,
			maxCommitsPerSecond: Math.max(...perSecond.values()), maxReceiptMs: receipts.at(-1)!,
			p50ReceiptMs: receipts[Math.floor(receipts.length / 2)]! };
	}, { gcIdleMs: 300, gcMaxMs: 1_500, gcMinIntervalMs: minIntervalMs }, { virtualTime: true });
	return run!;
}

s.test("D8: a group flush that hits the daily row limit sends no receipt, types the error, keeps the origin's frames resendable, and arms no alarm/timer loop", async () => {
	let limited = false;
	const latch = new DailyLimitLatch();
	await withRelay(({ store, relay, socket, update, envelope, seed, alarmCalls, advance, tail }) => {
		const origin = socket();
		const other = socket(peer);
		const before = seed.getText("body").toString();
		const head = store.documentHead(BODY)!.latestSequence;
		const bytes = textUpdate(seed, (text) => text.insert(0, "limited "));
		envelope(origin, bytes, { clientFrameId: "dl-1", candidateId: "dl-c1", candidateDigest: "dl-d1" });
		update(origin, bytes);
		assert.equal(other.binary.length, 1, "broadcast at receipt, as always");
		limited = true;
		const alarmsBefore = alarmCalls.value;
		advance(120_000); // idle/max timers fire; the flush fails on the limit
		assert.equal(origin.all("BODY_COMMITTED").length, 0, "no receipt for an uncommitted frame");
		assert.equal(origin.closed?.code, 1011, "the origin is closed so its client holds and resends later");
		const error = origin.last("VAULT_ERROR")!;
		assert.equal(error.code, DAILY_LIMIT_ERROR_CODE, JSON.stringify(error));
		assert.equal(error.cause, "durability_failed");
		assert.equal(typeof error.resetAt, "number");
		assert.equal(latch.active(), true);
		assert.equal(relay.counters.commitFailures, 1);
		assert.deepEqual(relay.pendingGroups(), [], "the failed buffer is not retried in a loop");
		assert.equal(store.documentHead(BODY)!.latestSequence, head, "nothing durable");
		assert.equal(tail(), null);
		assert.equal(reconstructedText(store), before);
		// Time passes while limited: no flush retries, no alarm re-arms.
		advance(600_000);
		assert.equal(relay.counters.commitFailures, 1, "no flush retry loop");
		assert.equal(alarmCalls.value, alarmsBefore, "no checkpoint alarm armed by failed commits");
		// After the reset (here: the simulation is switched off) the client's resend
		// of the same candidate on a new socket commits exactly once: nothing was lost.
		limited = false;
		const reconnect = socket();
		envelope(reconnect, bytes, { clientFrameId: "dl-1r", candidateId: "dl-c1", candidateDigest: "dl-d1" });
		update(reconnect, bytes);
		relay.flushBatch(BODY);
		const ack = reconnect.last("BODY_COMMITTED")!;
		assert.equal(ack.deduped, false);
		assert.equal(ack.vaultSequence, head + 1);
		assert.equal(reconstructedText(store), seed.getText("body").toString());
		assert.equal(latch.active(), false, "the first successful row write clears the latch");
		assert.equal(outcomes(relay), relay.counters.updateFrames);
	}, { gcIdleMs: 200, gcMaxMs: 1_000 }, { virtualTime: true, dailyLimit: { latch, simulate: () => limited } });
});

s.test("commit-rate cap: <= 1 commit/s per body at any typing rhythm; receipt <= gcMaxMs; rows/keystroke before vs after", async () => {
	const seconds = 30;
	const patterns: Array<[string, number[]]> = [1, 2, 3, 5, 8].map((rate) =>
		[`${rate} keys/s`, Array.from({ length: seconds * rate }, () => 1000 / rate)]);
	const random = seeded(12);
	const bursty: number[] = [];
	for (let total = 0; total < seconds * 1000;) {
		const gap = 100 + Math.floor(random() * 1900);
		bursty.push(gap);
		total += gap;
	}
	patterns.push(["bursty 100-2000 ms", bursty]);
	for (const [name, gaps] of patterns) {
		const before = await typing(gaps, 0);
		const after = await typing(gaps, 1_000);
		console.log(`[relay3-gc] typing ${name}: before ${before.commits} commits, ${(before.rows / before.keys).toFixed(2)} rows/key, `
			+ `max ${before.maxCommitsPerSecond} commits/s, receipt p50/max ${before.p50ReceiptMs}/${before.maxReceiptMs} ms | `
			+ `after ${after.commits} commits, ${(after.rows / after.keys).toFixed(2)} rows/key, max ${after.maxCommitsPerSecond} commits/s, `
			+ `min gap ${after.minGapMs} ms, receipt p50/max ${after.p50ReceiptMs}/${after.maxReceiptMs} ms`);
		assert.ok(after.minGapMs >= 1_000, `${name}: commits of one body are >= 1 s apart (${after.minGapMs})`);
		assert.ok(after.maxCommitsPerSecond <= 1, `${name}: <= 1 commit per wall-clock second`);
		assert.ok(after.maxReceiptMs <= 1_500, `${name}: receipt <= gcMaxMs (${after.maxReceiptMs})`);
		assert.ok(after.rows <= before.rows, `${name}: never more rows than without the cap`);
		assert.equal(after.rows, after.commits * 3, `${name}: 3 rows per commit (tail, head, ring)`);
	}
});

s.test("commit-rate cap: a deferred idle flush is scheduled (no waiting for the next frame); exempt flushes are immediate", async () => {
	await withRelay(({ relay, socket, update, envelope, seed, advance, tail }) => {
		const origin = socket();
		const first = textUpdate(seed, (text) => text.insert(0, "a"));
		envelope(origin, first, { clientFrameId: "d-1" });
		update(origin, first);
		advance(300);
		assert.equal(relay.counters.groupCommits, 1, "first idle commit (no previous commit)");
		advance(100);
		const second = textUpdate(seed, (text) => text.insert(0, "b"));
		envelope(origin, second, { clientFrameId: "d-2" });
		update(origin, second);
		advance(400);
		assert.equal(relay.counters.groupCommits, 1, "idle reached but the min interval has not");
		assert.equal(relay.counters.groupIdleDeferred, 1);
		advance(499);
		assert.equal(relay.counters.groupCommits, 1);
		advance(1);
		assert.equal(relay.counters.groupCommits, 2, "commits at previous commit + 1000 ms with no further frame");
		assert.deepEqual(ackedIds(origin), ["d-1", "d-2"]);
		// Exempt: a read flush (HTTP candidate / currentness), the authority fence and a semantic reset flush now.
		const third = textUpdate(seed, (text) => text.insert(0, "c"));
		update(origin, third);
		assert.equal(relay.flushForRead(BODY), true);
		assert.equal(relay.counters.groupCommits, 3);
		const fourth = textUpdate(seed, (text) => text.insert(0, "d"));
		update(origin, fourth);
		relay.flushForAuthorityFence();
		assert.equal(relay.counters.groupCommits, 4);
		const fifth = textUpdate(seed, (text) => text.insert(0, "e"));
		update(origin, fifth);
		relay.flushBatch(BODY);
		assert.equal(relay.counters.groupCommits, 5);
		void tail;
	}, { gcIdleMs: 300, gcMaxMs: 1_500, gcMinIntervalMs: 1_000 }, { virtualTime: true });
	// Bytes cap is exempt too.
	await withRelay(({ relay, socket, update, seed, advance }) => {
		const origin = socket();
		update(origin, textUpdate(seed, (text) => text.insert(0, "x".repeat(2_000))));
		update(origin, textUpdate(seed, (text) => text.insert(0, "y".repeat(2_000))));
		advance(1);
		assert.equal(relay.counters.groupFlushBytes, 2);
		assert.equal(relay.counters.groupCommits, 2);
	}, { gcMaxBytes: 1_000, gcMinIntervalMs: 1_000 }, { virtualTime: true });
});

// ---------------------------------------------------------------------------
// R12: rate limit charged on raw bytes before any work; refused socket = O(1) drops.
// ---------------------------------------------------------------------------

s.test("R12 flood: 5 MiB/s of 64 KiB frames closes the flooder 1013 within 2 s; bystander frames still commit and broadcast", async () => {
	await withRelay(({ relay, socket, update, envelope, seed, clock, advance, store }) => {
		const flooder = socket();
		const bystander = socket(peer);
		const observer = socket(peer);
		const bystanderDoc = cloneOf(seed);
		const base = Y.encodeStateAsUpdate(seed);
		const start = clock.now;
		let floodBytes = 0;
		let closedAt: number | null = null;
		let frames = 0;
		let sent = 0;
		for (let step = 0; step < 400; step++) {
			advance(12.5); // 80 frames/s x 64 KiB = 5 MiB/s
			const frame = textUpdate(seed, (text) => text.insert(0, "x".repeat(64 * 1024)));
			envelope(flooder, frame, { clientFrameId: `flood-${step}` });
			update(flooder, frame);
			floodBytes += frame.byteLength;
			frames++;
			if (flooder.closed && closedAt === null) closedAt = clock.now;
			if (step % 40 === 0) {
				const edit = textUpdate(bystanderDoc, (text) => text.insert(0, `b${step} `));
				envelope(bystander, edit, { clientFrameId: `by-${step}` });
				update(bystander, edit);
				sent++;
			}
		}
		advance(3_000);
		relay.flushBatch(BODY);
		assert.equal(flooder.closed?.code, 1013);
		assert.equal(flooder.closed?.reason, "relay rate limit");
		const elapsed = closedAt! - start;
		console.log(`[relay3-gc] R12 flood: closed after ${elapsed} ms (local, virtual time), `
			+ `${relay.counters.rawGateDrops} messages dropped O(1) after it, flood frames ${frames}`);
		assert.ok(elapsed <= 2_000, `closed within 2 s of over-rate input (${elapsed} ms)`);
		assert.equal(relay.counters.rateLimitCloses, 1);
		assert.ok(relay.counters.rawGateDrops >= 2 * (frames - 30), "every later message dropped at the gate");
		assert.equal(bystander.closed, null);
		assert.equal(ackedIds(bystander).length, sent, "every bystander frame acked");
		const view = peerView(base, observer);
		assert.equal(view, reconstructedText(store), "observer = durable (refused frames were never broadcast)");
		for (let step = 0; step < 400; step += 40) assert.ok(view.includes(`b${step} `));
		bystanderDoc.destroy();
		void floodBytes;
	}, { rateBytesPerSec: DEFAULT_RELAY_CONFIG.rateBytesPerSec, burstBytes: DEFAULT_RELAY_CONFIG.burstBytes },
	{ virtualTime: true });
});

s.test("R12 gate in VaultSocketService: charged before the attachment parse; a refused socket's messages cost O(1) (no parse, digest, authority, broadcast)", async () => {
	await withVaultObject({ YAOS_RELAY_BODIES: "true", YAOS_RELAY_LEAN_ROWS: "true", YAOS_RELAY_GROUP_COMMIT: "1",
		YAOS_RELAY_RATE_BYTES_PER_SEC: "1" } as CloudflareVaultEnvironment, async (server) => {
		const provision = await server.fetch(internal("/__yaos/provision", { method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ vaultGeneration: DO_GENERATION }) }));
		assert.ok(provision.ok, `provision ${provision.status}`);
		const inner = (server as unknown as { runtime: { relay: RelayBodyService;
			webSocketMessage(socket: VaultSocketPort, message: string | ArrayBuffer): Promise<void> } }).runtime;
		const calls = { parse: 0, sync: 0, control: 0, validate: 0 };
		const relay = inner.relay;
		const sync = relay.handleSyncFrame.bind(relay);
		relay.handleSyncFrame = (...args) => { calls.sync++; sync(...args); };
		const control = relay.handleControl.bind(relay);
		relay.handleControl = (...args) => { calls.control++; return control(...args); };
		const validate = relay.validateActor.bind(relay);
		relay.validateActor = (actor) => { calls.validate++; return validate(actor); };
		const socket = new FakeSocket({ ...owner, vaultId: DO_VAULT, vaultGeneration: DO_GENERATION, runtimeEpoch: "runtime-r12",
			documentId: "body-r12", kind: "body", documentEpoch: 1, socketId: "socket-r12", relay: true });
		const deserialize = socket.deserializeAttachment.bind(socket);
		socket.deserializeAttachment = () => { calls.parse++; return deserialize(); };
		const burst = relay.config.burstBytes;
		// 1: a non-sync binary message the size of most of the burst passes the gate (and is ignored).
		const filler = new Uint8Array(MAX_DURABLE_UPDATE_BYTES);
		assert.ok(burst - filler.byteLength < 100_000);
		filler[0] = 99;
		await inner.webSocketMessage(socket, filler.buffer);
		assert.equal(calls.parse, 1);
		assert.equal(socket.closed, null);
		// 2: a sync update over the remaining budget is refused before any parse/decode.
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, 0);
		encoding.writeVarUint(encoder, 2);
		encoding.writeVarUint8Array(encoder, new Uint8Array(100_000).fill(7));
		const over = encoding.toUint8Array(encoder);
		await inner.webSocketMessage(socket, over.slice().buffer);
		assert.equal((socket.closed as FakeSocket["closed"])?.code, 1013);
		assert.equal(relay.counters.rateLimitCloses, 1);
		const parsesAtRefusal = calls.parse;
		// 3..N: every later message (binary or text) is dropped with O(1) work.
		for (let index = 0; index < 500; index++) {
			await inner.webSocketMessage(socket, over.slice().buffer);
			await inner.webSocketMessage(socket, `__YPS:${JSON.stringify({ type: "BODY_UPDATE_ENVELOPE", bodyId: "body-r12" })}`);
		}
		assert.equal(calls.parse, parsesAtRefusal, "no attachment parse after the refusal");
		assert.ok(parsesAtRefusal <= 2, "one parse to register the socket, at most one to fence it");
		assert.deepEqual({ sync: calls.sync, control: calls.control, validate: calls.validate }, { sync: 0, control: 0, validate: 0 },
			"no decode, digest, envelope parse or authority check for any gated message");
		assert.equal(relay.counters.rawGateDrops, 1000);
		assert.equal(relay.counters.failedSocketDrops, 500, "dropped sync updates keep the outcome sum");
		assert.equal(relay.counters.updateFrames, 501);
		assert.equal(relay.counters.groupBroadcasts, 0);
		// Hard size cap first: an oversize message refuses the socket 1009 without parsing it.
		const big = new FakeSocket({ ...socket.attachment, socketId: "socket-r12-big" });
		await inner.webSocketMessage(big, new Uint8Array([99, 0, 0, 0]).buffer);
		assert.equal(big.closed, null);
		await inner.webSocketMessage(big, new Uint8Array(MAX_DURABLE_UPDATE_BYTES + 65).buffer);
		assert.equal((big.closed as FakeSocket["closed"])?.code, 1009);
		assert.equal(relay.counters.rateGateCloses, 2);
	});
});

await s.done();
