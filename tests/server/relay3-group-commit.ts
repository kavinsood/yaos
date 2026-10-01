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
import { RelayBodyService, type RelaySocketHost } from "../../server/src/relayBodies";
import { RelayBodyStore } from "../../server/src/relayBodyStore";
import { DEFAULT_RELAY_CONFIG, groupCommitFlag, readRelayConfig, type RelayConfig } from "../../server/src/relayFlag";
import { RELAY_RECEIPT_RING, decodeTailRecords } from "../../server/src/relayTail";
import { RELAY_CRASH_RUNTIME_PATH, VaultSyncServer, type CloudflareVaultEnvironment } from "../../server/src/server";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { sha256HexSync } from "../../server/src/vaultDocumentStore";
import type { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import type { VaultSocketAttachment, VaultSocketPort } from "../../server/src/vaultSocketService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
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
}

async function withRelay(check: (harness: Harness) => void | Promise<void>, config: Partial<RelayConfig> = {}): Promise<void> {
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
	const storage = {
		sql: { exec: (query: string, ...bindings: unknown[]) => {
			const cursor = sqlite.sql.exec(query, ...bindings);
			if (meter.on && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(query)) account(query, cursor.rowsWritten);
			return cursor;
		} },
		transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure),
	} as unknown as VaultStoragePort;
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
		const sockets: FakeSocket[] = [];
		const alarmCalls = { value: 0 };
		let alarmArmed = false;
		const host: RelaySocketHost = {
			sockets: () => sockets,
			sendControl: (socket, value) => socket.send(`__YPS:${JSON.stringify(value)}`),
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
			});
			service.bindHost(host);
			services.push(service);
			return service;
		};
		const relay = makeRelay(RUNTIME);
		let nextSocket = 0;
		const frame = (kind: number, payload: Uint8Array): decoding.Decoder => {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, 0);
			encoding.writeVarUint(encoder, kind);
			encoding.writeVarUint8Array(encoder, payload);
			const decoder = decoding.createDecoder(encoding.toUint8Array(encoder));
			decoding.readVarUint(decoder);
			return decoder;
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
			update(socket, update, via = relay) { via.handleSyncFrame(socket, socket.attachment, frame(2, update)); },
			step1(socket, stateVector, via = relay) { via.handleSyncFrame(socket, socket.attachment, frame(0, stateVector)); },
			step2(socket, update, via = relay) { via.handleSyncFrame(socket, socket.attachment, frame(1, update)); },
			envelope(socket, update, extra = {}, via = relay) {
				via.handleControl(socket, socket.attachment, `__YPS:${JSON.stringify({
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
		+ c.tooLargeCloses + c.commitFailures + c.frameErrors + c.groupDropped;
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
		// The origin's resend afterwards is a CRDT no-op ack.
		envelope(a, lost, { candidateId: "lost-1" }, next);
		update(a, lost, next);
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

s.test("G2/epoch at flush: a device revoked while buffered is dropped (4403); an epoch change fences the buffer", async () => {
	await withRelay(({ store, relay, socket, update, seed, revoke, tail, envelope }) => {
		const a = socket();
		const b = socket(peer);
		const writerA = cloneOf(seed);
		const fromA = textUpdate(writerA, (text) => text.insert(0, "A"));
		envelope(a, fromA, { candidateId: "rev-a" });
		update(a, fromA);
		update(b, textUpdate(seed, (text) => text.insert(0, "B")));
		assert.equal(b.binary.length, 1, "documented: a revoked device's buffered frame has already reached peers");
		revoke(owner.deviceId);
		relay.flushBatch(BODY);
		assert.equal(a.closed?.code, 4403);
		assert.equal(a.all("BODY_COMMITTED").length, 0, "never acked");
		assert.equal(b.closed, null);
		assert.equal(relay.counters.authorityDrops, 1);
		assert.equal(tail()!.frames, 1);
		assert.equal(reconstructedText(store), "Bhello");
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

await s.done();
