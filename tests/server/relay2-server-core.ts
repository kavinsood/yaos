// Relay v2 spike: server-core unit tests (brief §8.1). Real SQLite
// (NodeSqliteStorage) under VaultStore + RelayBodyStore + RelayBodyService,
// with fake sockets and a recording socket host.
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
import { classifyWorkerRoute } from "../../server/src/index";
import {
	RelayBodyService, maxStateVector, parseRelayEnvelope, type RelaySocketHost,
} from "../../server/src/relayBodies";
import { RelayBodyStore } from "../../server/src/relayBodyStore";
import { DEFAULT_RELAY_CONFIG, readRelayConfig, relayBodiesEnabled, type RelayConfig } from "../../server/src/relayFlag";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { sha256HexSync } from "../../server/src/vaultDocumentStore";
import type { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import type { VaultSocketAttachment, VaultSocketPort } from "../../server/src/vaultSocketService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { suite } from "../harness.ts";

const s = suite("relay2-server-core");

const VAULT_ID = "relay2-core-vault";
const VAULT_GENERATION = "relay2-core-generation";
const BODY = "relay2-body-a";

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
}

interface HostEvent { kind: string; bodyId?: string; exclude?: string; headSequence?: number; epoch?: number }

function textUpdate(doc: Y.Doc, mutate: (text: Y.Text) => void): Uint8Array {
	const before = Y.encodeStateVector(doc);
	mutate(doc.getText("body"));
	return Y.encodeStateAsUpdate(doc, before);
}

function contentHashOf(text: string): { hash: string; size: number } {
	const bytes = canonicalMarkdownBytes(text);
	return { hash: sha256HexSync(bytes), size: bytes.byteLength };
}

interface Harness {
	store: VaultStore;
	relayStore: RelayBodyStore;
	relay: RelayBodyService;
	events: HostEvent[];
	alarms: { value: number };
	clock: { now: number };
	seed: Y.Doc;
	socket(actor?: typeof owner, epoch?: number): FakeSocket;
	update(socket: FakeSocket, update: Uint8Array): void;
	step1(socket: FakeSocket, stateVector: Uint8Array): void;
	envelope(socket: FakeSocket, update: Uint8Array, extra?: Record<string, unknown>): void;
	claim(doc: Y.Doc): Record<string, unknown>;
	journalRows(): number;
	catalogHead(): { contentHash: string | null; size: number | null; sequence: number };
}

async function withRelay(check: (harness: Harness) => void | Promise<void>,
	config: Partial<RelayConfig> = {}): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-relay2-core-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const storage = {
		sql: { exec: (query: string, ...bindings: unknown[]) => sqlite.sql.exec(query, ...bindings) },
		transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure),
	} as unknown as VaultStoragePort;
	const seed = new Y.Doc({ guid: BODY });
	try {
		const store = new VaultStore(storage);
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", 8);
		root.getMap("sys").set("protocolVersion", 5);
		store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root), 1);
		root.destroy();
		store.installAuthorityFence({ changeId: "relay2-bootstrap", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
			subjectDigest: "relay2-bootstrap-digest", subjects: [
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
		const events: HostEvent[] = [];
		const alarms = { value: 0 };
		const clock = { now: Date.now() };
		const sockets: FakeSocket[] = [];
		const relay = new RelayBodyService({
			config: { ...DEFAULT_RELAY_CONFIG, ...config },
			store: () => store,
			relayStore: () => relayStore,
			cache: { get: () => undefined } as unknown as VaultDocumentCache,
			runtimeEpoch: "runtime-test",
			armCheckpointAlarm: () => { alarms.value++; },
			now: () => clock.now,
		});
		const host: RelaySocketHost = {
			sockets: () => sockets,
			sendControl: (socket, value) => socket.send(`__YPS:${JSON.stringify(value)}`),
			fenceRelaySocket: (socket, _attachment, epoch) => {
				events.push({ kind: "fence", epoch });
				socket.close(4409, "semantic epoch mismatch");
			},
			broadcastRelayUpdate: (bodyId, _epoch, frame, exclude) => {
				events.push({ kind: "broadcast", bodyId, exclude, headSequence: store.documentHead(bodyId)!.latestSequence });
				for (const socket of sockets) if (socket.attachment.socketId !== exclude) socket.send(frame);
			},
			notifyBodyCommitted: (bodyId, _generation, sequence, exclude) => {
				events.push({ kind: "committed", bodyId, exclude, headSequence: sequence });
			},
		};
		relay.bindHost(host);
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
			store, relayStore, relay, events, alarms, clock, seed,
			socket(actor = owner, epoch) {
				const socket = new FakeSocket({ ...actor, runtimeEpoch: "runtime-test", documentId: BODY, kind: "body",
					documentEpoch: epoch ?? store.documentHead(BODY)!.semanticEpoch, socketId: `socket-${++nextSocket}`,
					relay: true });
				sockets.push(socket);
				return socket;
			},
			update(socket, update) { relay.handleSyncFrame(socket, socket.attachment, frame(2, update)); },
			step1(socket, stateVector) { relay.handleSyncFrame(socket, socket.attachment, frame(0, stateVector)); },
			envelope(socket, update, extra = {}) {
				relay.handleControl(socket, socket.attachment, `__YPS:${JSON.stringify({
					type: "BODY_UPDATE_ENVELOPE", bodyId: BODY, bodyEpoch: socket.attachment.documentEpoch,
					clientFrameId: `frame-${Math.random().toString(36).slice(2)}`, payloadDigest: sha256HexSync(update),
					...extra,
				})}`);
			},
			claim(doc) {
				const content = contentHashOf(doc.getText("body").toString());
				return { contentHash: content.hash, size: content.size,
					stateVector: bytesToBase64(Y.encodeStateVector(doc)) };
			},
			journalRows: () => relayStore.journalRowCount(),
			catalogHead: () => store.getCatalogHeadAt(store.currentSequence(), BODY)!,
		};
		await check(harness);
	} finally {
		seed.destroy();
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function reconstructedText(store: VaultStore): string {
	const reconstructed = store.reconstructDocument(BODY);
	try { return crdtEngine.readText(reconstructed.doc, "body"); }
	finally { crdtEngine.destroyDocument(reconstructed.doc); }
}

s.test("flag gating: env, config parsing, and relay routes only classify with the flag on", () => {
	assert.equal(relayBodiesEnabled({ YAOS_RELAY_BODIES: "true" }), true);
	assert.equal(relayBodiesEnabled({ YAOS_RELAY_BODIES: "false" }), false);
	assert.equal(relayBodiesEnabled({ YAOS_RELAY_BODIES: "1" }), false);
	const config = readRelayConfig({ YAOS_RELAY_MICROBATCH_MS: "999", YAOS_RELAY_CHECKPOINT_MAX_ROWS: "7" });
	assert.equal(config.microbatchMs, 50, "micro-batch window is clamped");
	assert.equal(config.checkpointMaxRows, 7);
	for (const [method, path] of [
		["POST", "/vault/vault-route-0001/body/body-1/compaction-lease"],
		["POST", "/vault/vault-route-0001/body/body-1/semantic-reset"],
		["GET", "/vault/vault-route-0001/debug/relay-table-counts"],
	] as Array<[string, string]>) {
		const request = new Request(`https://example.test${path}`, { method });
		assert.equal(classifyWorkerRoute(request, new URL(request.url), false).kind, "not-found", `flag off ${path}`);
		assert.equal(classifyWorkerRoute(request, new URL(request.url), true).kind, "vault", `flag on ${path}`);
	}
});

s.test("parseRelayEnvelope validates shape and maxStateVector is a pointwise max", () => {
	const digest = "a".repeat(64);
	assert.ok(parseRelayEnvelope({ type: "BODY_UPDATE_ENVELOPE", bodyId: "b", bodyEpoch: 1, clientFrameId: "f", payloadDigest: digest }));
	assert.equal(parseRelayEnvelope({ type: "BODY_UPDATE_ENVELOPE", bodyId: "b", bodyEpoch: 0, clientFrameId: "f", payloadDigest: digest }), null);
	assert.equal(parseRelayEnvelope({ type: "BODY_UPDATE_ENVELOPE", bodyId: "b", bodyEpoch: 1, clientFrameId: "f", payloadDigest: "x" }), null);
	assert.equal(parseRelayEnvelope({ type: "BODY_UPDATE_ENVELOPE", bodyId: "b", bodyEpoch: 1, clientFrameId: "f", payloadDigest: digest,
		contentHash: "nothex" }), null);
	assert.equal(parseRelayEnvelope({ type: "BODY_UPDATE_ENVELOPE", bodyId: "b", bodyEpoch: 1, clientFrameId: "f", payloadDigest: digest,
		stateVector: "!!!" }), null);
	const left = new Y.Doc();
	const right = new Y.Doc();
	left.getText("body").insert(0, "abc");
	right.getText("body").insert(0, "xy");
	Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
	left.getText("body").insert(0, "more");
	const merged = new Y.Doc();
	Y.applyUpdate(merged, Y.encodeStateAsUpdate(left));
	Y.applyUpdate(merged, Y.encodeStateAsUpdate(right));
	const expected = Y.decodeStateVector(Y.encodeStateVector(merged));
	const actual = Y.decodeStateVector(maxStateVector(Y.encodeStateVector(left), Y.encodeStateVector(right)));
	assert.deepEqual(new Map([...actual].sort()), new Map([...expected].sort()));
	for (const doc of [left, right, merged]) doc.destroy();
});

s.test("append: one journal row per frame, lean row count, ack + broadcast strictly after commit", async () => {
	await withRelay(({ store, relay, events, socket, update, envelope, journalRows, relayStore, seed, claim }) => {
		const origin = socket();
		const other = socket(peer);
		const rowsBefore = journalRows();
		const tablesBefore = relayStore.tableCounts();
		const bytes = textUpdate(seed, (text) => text.insert(5, " world"));
		envelope(origin, bytes, claim(seed));
		update(origin, bytes);
		assert.equal(journalRows(), rowsBefore + 1);
		const tablesAfter = relayStore.tableCounts();
		const delta = Object.fromEntries(Object.keys(tablesAfter)
			.map((name) => [name, tablesAfter[name]! - (tablesBefore[name] ?? 0)])
			.filter(([, value]) => value !== 0));
		assert.deepEqual(delta, { vault_catalog_events: 1, vault_journal: 1, vault_mutation_attribution: 1 },
			"relay append inserts journal + attribution + catalog event only (head and clock are updates)");
		console.log(`[relay2-core] relay append table deltas ${JSON.stringify(delta)} sqlite rowsWritten=${relay.counters.rowsWritten}`);
		const ack = origin.last("BODY_COMMITTED")!;
		assert.equal(ack.relay, true);
		assert.equal(ack.contentHashAccepted, true);
		assert.equal(ack.contentHash, contentHashOf("hello world").hash);
		assert.equal(ack.vaultSequence, store.documentHead(BODY)!.latestSequence);
		assert.equal(ack.commitRuntimeEpoch, "runtime-test");
		const broadcast = events.find((event) => event.kind === "broadcast")!;
		assert.equal(broadcast.exclude, origin.attachment.socketId);
		assert.equal(broadcast.headSequence, ack.vaultSequence, "fan-out happens after the durable commit");
		assert.equal(other.binary.length, 1, "peer receives the update frame");
		assert.equal(origin.binary.length, 0, "origin never gets its own frame back");
		assert.equal(events.find((event) => event.kind === "committed")!.exclude, origin.attachment.socketId);
		assert.equal(reconstructedText(store), "hello world");
	});
});

s.test("base path row comparison (flag-off commitUpdate for the same body update)", async () => {
	await withRelay(({ store, relayStore, seed }) => {
		const before = relayStore.tableCounts();
		store.commitUpdate({ documentId: BODY, kind: "body", update: textUpdate(seed, (text) => text.insert(0, "x")),
			actorAttributions: [{ actor: owner }] });
		const after = relayStore.tableCounts();
		const delta = Object.fromEntries(Object.keys(after).map((name) => [name, after[name]! - (before[name] ?? 0)])
			.filter(([, value]) => value !== 0));
		console.log(`[relay2-core] base commitUpdate table deltas ${JSON.stringify(delta)}`);
		assert.equal(delta.vault_journal, 1);
	});
});

s.test("D6: stale/concurrent claims are not accepted; unknown hash is materialised and backfilled", async () => {
	await withRelay(({ store, socket, update, envelope, seed, claim, catalogHead, relay }) => {
		const a = socket();
		const b = socket(peer);
		const writerB = new Y.Doc();
		Y.applyUpdate(writerB, Y.encodeStateAsUpdate(seed));
		const fromA = textUpdate(seed, (text) => text.insert(5, "A"));
		const fromB = textUpdate(writerB, (text) => text.insert(0, "B"));
		envelope(a, fromA, claim(seed));
		update(a, fromA);
		assert.equal(a.last("BODY_COMMITTED")!.contentHashAccepted, true);
		// B never saw A's update: its SV does not equal the merged SV.
		envelope(b, fromB, claim(writerB));
		update(b, fromB);
		const ackB = b.last("BODY_COMMITTED")!;
		assert.equal(ackB.contentHashAccepted, false);
		assert.equal(ackB.contentHash, null);
		assert.equal(catalogHead().contentHash, null, "unknown hash is recorded as NULL, never the stale claim");
		const state = relay.bodyHttpState(BODY)!;
		assert.equal(state.materialised, true);
		const text = reconstructedText(store);
		assert.equal(state.contentHash, contentHashOf(text).hash);
		assert.equal(catalogHead().contentHash, state.contentHash, "backfilled in place");
		assert.equal(relay.bodyHttpState(BODY)!.materialised, false);
		writerB.destroy();
	});
});

s.test("dedupe by candidate id, digest mismatch rejects, envelope digest mismatch falls back to unknown", async () => {
	await withRelay(({ socket, update, envelope, seed, journalRows, relay }) => {
		const origin = socket();
		const bytes = textUpdate(seed, (text) => text.insert(0, "1"));
		envelope(origin, bytes, { candidateId: "cand-1", candidateDigest: "digest-1" });
		update(origin, bytes);
		const rows = journalRows();
		envelope(origin, bytes, { candidateId: "cand-1", candidateDigest: "digest-1" });
		update(origin, bytes);
		assert.equal(journalRows(), rows, "dedupe hit writes nothing");
		assert.equal(origin.last("BODY_COMMITTED")!.deduped, true);
		envelope(origin, bytes, { candidateId: "cand-1", candidateDigest: "digest-2" });
		update(origin, bytes);
		assert.equal(origin.last("BODY_UPDATE_REJECTED")!.reason, "candidate_id_reused");
		const second = textUpdate(seed, (text) => text.insert(0, "2"));
		envelope(origin, textUpdate(new Y.Doc(), (text) => text.insert(0, "other")), { ...{ candidateId: "cand-2" } });
		update(origin, second);
		assert.equal(relay.counters.envelopeMismatches, 1);
		assert.equal(journalRows(), rows + 1, "an unpaired frame still commits");
	});
});

s.test("empty step2 and resends are no-ops (growth cap) on exact and incremental paths", async () => {
	for (const exactMergeBytes of [DEFAULT_RELAY_CONFIG.exactMergeBytes, 0]) {
		await withRelay(({ socket, update, envelope, seed, journalRows, relay, store }) => {
			const origin = socket();
			const rows = journalRows();
			envelope(origin, new Uint8Array([0, 0]));
			update(origin, new Uint8Array([0, 0]));
			assert.equal(journalRows(), rows);
			assert.equal(origin.last("BODY_COMMITTED")!.noop, true);
			const bytes = textUpdate(seed, (text) => text.insert(0, "z"));
			update(origin, bytes);
			update(origin, bytes);
			assert.equal(journalRows(), rows + 1, `resend is not appended (exactMergeBytes=${exactMergeBytes})`);
			assert.equal(relay.counters.noopSkips, 1);
			update(origin, textUpdate(seed, (text) => text.insert(0, "y")));
			assert.equal(journalRows(), rows + 2);
			if (exactMergeBytes === 0) assert.ok(relay.counters.incrementalAppends >= 2);
			relay.invalidate(BODY);
			relay.fullState(BODY);
			assert.equal(relay.counters.stateVectorDrift, 0);
			assert.equal(reconstructedText(store), "yzhello");
		}, { exactMergeBytes });
	}
});

s.test("step1 gets a step2 diff of the merged bytes; epoch mismatch fences without writing", async () => {
	await withRelay(({ socket, step1, update, seed, journalRows, events }) => {
		const fresh = socket();
		step1(fresh, Y.encodeStateVector(new Y.Doc()));
		const reply = decoding.createDecoder(fresh.binary[0]!);
		assert.equal(decoding.readVarUint(reply), 0);
		assert.equal(decoding.readVarUint(reply), 1);
		const doc = new Y.Doc();
		Y.applyUpdate(doc, decoding.readVarUint8Array(reply));
		assert.equal(doc.getText("body").toString(), "hello");
		doc.destroy();
		const stale = socket(owner, 99);
		const rows = journalRows();
		update(stale, textUpdate(seed, (text) => text.insert(0, "q")));
		assert.equal(journalRows(), rows);
		assert.equal(stale.closed?.code, 4409);
		assert.equal(events.at(-1)!.kind, "fence");
	});
});

s.test("revocation invalidates the cached authority; rate limit closes 1013", async () => {
	await withRelay(({ store, socket, update, seed, journalRows }) => {
		const origin = socket();
		update(origin, textUpdate(seed, (text) => text.insert(0, "1")));
		const rows = journalRows();
		store.installAuthorityFence({ changeId: "relay2-revoke", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
			subjectDigest: "relay2-revoke-digest", subjects: [
				{ deviceId: owner.deviceId, principalId: owner.principalId, state: "revoked", credentialRevision: 2 },
			] });
		update(origin, textUpdate(seed, (text) => text.insert(0, "2")));
		assert.equal(journalRows(), rows);
		assert.equal(origin.closed?.code, 4403);
	});
	await withRelay(({ socket, update, seed, journalRows }) => {
		const origin = socket();
		const rows = journalRows();
		update(origin, textUpdate(seed, (text) => text.insert(0, "x".repeat(200))));
		assert.equal(origin.closed?.code, 1013);
		assert.equal(journalRows(), rows);
	}, { burstBytes: 64, rateBytesPerSec: 1 });
});

s.test("micro-batch: frames merge into one journal row with per-frame attribution", async () => {
	await withRelay(({ socket, update, seed, journalRows, relay, relayStore, store }) => {
		const a = socket();
		const b = socket(peer);
		const rows = journalRows();
		const attributions = relayStore.tableCounts().vault_mutation_attribution ?? 0;
		update(a, textUpdate(seed, (text) => text.insert(0, "1")));
		update(b, textUpdate(seed, (text) => text.insert(0, "2")));
		assert.equal(journalRows(), rows, "queued until flush");
		relay.flushBatch(BODY);
		assert.equal(journalRows(), rows + 1);
		assert.equal(relayStore.tableCounts().vault_mutation_attribution, attributions + 2);
		assert.equal(reconstructedText(store), "21hello");
	}, { microbatchMs: 50 });
});

s.test("checkpoint: full and bounded partial byte-merge checkpoints preserve content; alarm arms at threshold", async () => {
	await withRelay(({ socket, update, seed, relay, store, alarms }) => {
		const origin = socket();
		for (let index = 0; index < 10; index++) update(origin, textUpdate(seed, (text) => text.insert(text.length, String(index))));
		assert.ok(alarms.value >= 1, "tail over checkpointEntries arms the alarm");
		assert.equal(relay.needsCheckpoint(BODY), true);
		const first = relay.checkpointBody(BODY)!;
		assert.equal(first.partial, true);
		assert.equal(first.tailEntries, 3);
		assert.equal(reconstructedText(store), "hello0123456789");
		// Appends between passes (crash/restart between passes is the same state).
		update(origin, textUpdate(seed, (text) => text.insert(0, ">")));
		let passes = 1;
		while (store.documentJournalTailStats(BODY).entries > 0) {
			relay.checkpointBody(BODY);
			passes++;
			assert.ok(passes < 10);
		}
		assert.equal(relay.counters.partialCheckpoints >= 3, true);
		assert.equal(reconstructedText(store), ">hello0123456789");
		assert.equal(relay.checkpointBody(BODY), null);
		relay.invalidate(BODY);
		assert.equal(relay.counters.stateVectorDrift, 0);
		assert.throws(() => store.writeRelayCheckpointThrough(BODY, new Uint8Array([0, 0]), {
			throughSequence: 1, generation: 1, semanticEpoch: 42 as never }), /checkpoint head mismatch/);
	}, { checkpointEntries: 5, checkpointMaxRows: 3 });
});

s.test("lease CAS and semantic reset CAS; snapshots must cover the head", async () => {
	await withRelay(({ store, relayStore, relay, socket, update, seed, catalogHead, clock }) => {
		const head = store.documentHead(BODY)!;
		assert.equal(relayStore.acquireLease(BODY, owner, head.semanticEpoch + 1, undefined, clock.now).granted, false);
		const lease = relay.acquireLease(BODY, owner, head.semanticEpoch, 10_000);
		assert.ok(lease.granted && typeof lease.stateVector === "string");
		const held = relayStore.acquireLease(BODY, peer, head.semanticEpoch, undefined, clock.now);
		assert.equal(held.granted, false);
		assert.equal(!held.granted && held.reason, "held");
		// A GC'd snapshot rebuilt on a fresh lineage (new client ids).
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, seed.getText("body").toString());
		const snapshot = Y.encodeStateAsUpdate(fresh);
		assert.equal(relay.snapshotCoversHead(BODY, snapshot), false, "fresh lineage does not cover the old head SV");
		const covering = Y.encodeStateAsUpdate(seed);
		assert.equal(relay.snapshotCoversHead(BODY, covering), true);
		const content = contentHashOf("hello");
		const common = { bodyId: BODY, actor: owner, leaseId: lease.granted ? lease.leaseId : "", snapshot: covering,
			contentHash: content.hash, contentBytes: content.size, now: clock.now };
		assert.equal((relayStore.semanticReset({ ...common, leaseId: "wrong", expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence }) as { reason?: string }).reason, "lease_invalid");
		const origin = socket();
		update(origin, textUpdate(seed, (text) => text.insert(0, "!")));
		assert.equal((relayStore.semanticReset({ ...common, expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence }) as { reason?: string }).reason, "head_advanced");
		const now = store.documentHead(BODY)!;
		const resetContent = contentHashOf("!hello");
		const outcome = relayStore.semanticReset({ ...common, snapshot: Y.encodeStateAsUpdate(seed),
			contentHash: resetContent.hash, contentBytes: resetContent.size,
			expectedEpoch: now.semanticEpoch, coveredSequence: now.latestSequence });
		assert.ok(outcome.ok);
		assert.equal(store.documentHead(BODY)!.semanticEpoch, now.semanticEpoch + 1);
		assert.equal(catalogHead().contentHash, resetContent.hash);
		assert.equal(reconstructedText(store), "!hello");
		// The lease is consumed; the old-epoch socket is fenced on its next frame.
		relay.invalidate(BODY);
		update(origin, textUpdate(seed, (text) => text.insert(0, "?")));
		assert.equal(origin.closed?.code, 4409);
		assert.equal(relayStore.releaseLease(BODY, common.leaseId, owner), false);
		fresh.destroy();
	});
});

await s.done();
