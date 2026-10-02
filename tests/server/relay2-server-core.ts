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
import { BootstrapService } from "../../server/src/bootstrap";
import { MAX_DURABLE_UPDATE_BYTES } from "../../server/src/contracts";
import { classifyWorkerRoute } from "../../server/src/index";
import {
	RelayBodyService, maxStateVector, parseRelayEnvelope, type RelaySocketHost,
} from "../../server/src/relayBodies";
import { RelayBodyStore } from "../../server/src/relayBodyStore";
import { handleCompactionLease, handleSemanticReset } from "../../server/src/relayRoutes";
import { DEFAULT_RELAY_CONFIG, RELAY_MIN_BURST_BYTES, readRelayConfig, relayBodiesEnabled, type RelayConfig } from "../../server/src/relayFlag";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { RelayMergeBudgetError, sha256HexSync } from "../../server/src/vaultDocumentStore";
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
	catalogHead(): NonNullable<ReturnType<VaultStore["getCatalogHeadAt"]>>;
	/** A second service over the same storage (a new runtime after eviction/hibernation). */
	freshRelay(): RelayBodyService;
	revoke(deviceId: string): void;
}

async function withRelay(check: (harness: Harness) => void | Promise<void>,
	config: Partial<RelayConfig> = {}, cache: VaultDocumentCache = { get: () => undefined } as unknown as VaultDocumentCache): Promise<void> {
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
		// Round 4: YAOS_RELAY_LEAN_ROWS=true reruns the whole suite in lean mode (§6.4).
		const effectiveConfig: RelayConfig = { ...DEFAULT_RELAY_CONFIG,
			leanRows: process.env.YAOS_RELAY_LEAN_ROWS === "true", ...config };
		if (effectiveConfig.leanRows) store.enableLeanRows();
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
		const makeRelay = () => new RelayBodyService({
			config: effectiveConfig,
			store: () => store,
			relayStore: () => relayStore,
			cache,
			runtimeEpoch: "runtime-test",
			armCheckpointAlarm: () => { alarms.value++; },
			now: () => clock.now,
		});
		const relay = makeRelay();
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
				events.push({ kind: "committed", bodyId, exclude: exclude ? [...exclude].sort().join(",") : undefined,
					headSequence: sequence });
			},
		};
		relay.bindHost(host);
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
			store, relayStore, relay, events, alarms, clock, seed,
			socket(actor = owner, epoch) {
				const socket = new FakeSocket({ ...actor, runtimeEpoch: "runtime-test", documentId: BODY, kind: "body",
					documentEpoch: epoch ?? store.documentHead(BODY)!.semanticEpoch, socketId: `socket-${++nextSocket}`,
					relay: true });
				sockets.push(socket);
				return socket;
			},
			update(socket, update) { binary(relay, socket, 2, update); },
			step1(socket, stateVector) { binary(relay, socket, 0, stateVector); },
			envelope(socket, update, extra = {}) {
				text(relay, socket, `__YPS:${JSON.stringify({
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
			freshRelay() {
				const fresh = makeRelay();
				fresh.bindHost(host);
				return fresh;
			},
			revoke(deviceId) {
				store.installAuthorityFence({ changeId: `relay2-revoke-${deviceId}-${Math.random()}`, vaultId: VAULT_ID,
					vaultGeneration: VAULT_GENERATION, subjectDigest: `relay2-revoke-${deviceId}`, subjects: [
						{ deviceId, principalId: owner.principalId, state: "revoked", credentialRevision: 2 },
					] });
			},
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
	assert.equal(config.microbatchMs, 250, "micro-batch window is clamped to 250 ms");
	assert.equal(readRelayConfig({ YAOS_RELAY_MICROBATCH_MS: "100" }).microbatchMs, 100);
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
		assert.deepEqual(delta, store.leanRows ? { vault_journal: 1 }
			: { vault_catalog_events: 1, vault_journal: 1, vault_mutation_attribution: 1 },
			"relay append inserts journal + attribution + catalog event only (head and clock are updates); lean: journal only");
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
		const attributions = relayStore.attributionCount();
		update(a, textUpdate(seed, (text) => text.insert(0, "1")));
		update(b, textUpdate(seed, (text) => text.insert(0, "2")));
		assert.equal(journalRows(), rows, "queued until flush");
		relay.flushBatch(BODY);
		assert.equal(journalRows(), rows + 1);
		assert.equal(relayStore.attributionCount(), attributions + 2);
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

s.test("lease CAS and semantic reset CAS; lineage-fresh snapshots are accepted (no SV coverage check)", async () => {
	await withRelay(({ store, relayStore, relay, socket, update, seed, catalogHead, clock }) => {
		const head = store.documentHead(BODY)!;
		assert.equal(relayStore.acquireLease(BODY, owner, head.semanticEpoch + 1, undefined, clock.now).granted, false);
		const lease = relay.acquireLease(BODY, owner, head.semanticEpoch, 10_000);
		assert.ok(lease.granted && typeof lease.stateVector === "string");
		assert.deepEqual(lease.granted && lease.policy, { lastResetAt: null, cooldownMs: 0, cooldownRemainingMs: 0,
			nextResetAllowedAt: null });
		const held = relayStore.acquireLease(BODY, peer, head.semanticEpoch, undefined, clock.now);
		assert.equal(held.granted, false);
		assert.equal(!held.granted && held.reason, "held");
		// A GC'd snapshot rebuilt on a fresh lineage (new client ids): it does not
		// cover the old head SV and must still be accepted structurally.
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, "!hello");
		const snapshot = Y.encodeStateAsUpdate(fresh);
		assert.equal(relay.snapshotStructurallyValid(snapshot, 6), true);
		assert.equal(relay.snapshotStructurallyValid(new Uint8Array([0, 0]), 6), false, "empty update for non-empty content");
		assert.equal(relay.snapshotStructurallyValid(new Uint8Array([0, 0]), 0), true);
		assert.equal(relay.snapshotStructurallyValid(new Uint8Array([7, 200, 1, 3]), 6), false, "unparseable");
		const content = contentHashOf("!hello");
		const common = { bodyId: BODY, actor: owner, leaseId: lease.granted ? lease.leaseId : "", snapshot,
			contentHash: content.hash, contentBytes: content.size, now: clock.now };
		assert.equal((relayStore.semanticReset({ ...common, leaseId: "wrong", expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence }) as { reason?: string }).reason, "lease_invalid");
		const origin = socket();
		update(origin, textUpdate(seed, (text) => text.insert(0, "!")));
		// Exact-head currency: one append after the lease makes the reset stale.
		assert.equal((relayStore.semanticReset({ ...common, expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence }) as { reason?: string }).reason, "head_advanced");
		const now = store.documentHead(BODY)!;
		const outcome = relayStore.semanticReset({ ...common, expectedEpoch: now.semanticEpoch,
			coveredSequence: now.latestSequence });
		assert.ok(outcome.ok);
		assert.equal(store.documentHead(BODY)!.semanticEpoch, now.semanticEpoch + 1);
		assert.equal(catalogHead().contentHash, content.hash);
		assert.equal(reconstructedText(store), "!hello");
		// The lease is consumed; the old-epoch socket is fenced on its next frame.
		relay.invalidate(BODY);
		update(origin, textUpdate(seed, (text) => text.insert(0, "?")));
		assert.equal(origin.closed?.code, 4409);
		assert.equal(relayStore.releaseLease(BODY, common.leaseId, owner), false);
		fresh.destroy();
	}, { resetCooldownMs: 0 });
});

function resetDeps(harness: Harness) {
	return { relay: harness.relay, relayStore: () => harness.relayStore, isActiveBody: () => true,
		discardResident: () => {}, fenceSockets: () => 0 };
}

function binaryReset(meta: Record<string, string | number>, snapshot: Uint8Array, query = ""): Request {
	const headers: Record<string, string> = { "content-type": "application/octet-stream" };
	const names: Record<string, string> = { leaseId: "x-yaos-lease-id", expectedEpoch: "x-yaos-expected-epoch",
		coveredSequence: "x-yaos-covered-sequence", contentHash: "x-yaos-content-hash", contentBytes: "x-yaos-content-bytes" };
	for (const [key, value] of Object.entries(meta)) headers[names[key]!] = String(value);
	return new Request(`http://runtime/body/${BODY}/semantic-reset${query}`, { method: "POST", headers, body: snapshot });
}

s.test("semantic-reset route: octet-stream body with header or query metadata, JSON still accepted", async () => {
	await withRelay(async (harness) => {
		const { store, relay } = harness;
		const deps = resetDeps(harness);
		const resetOnce = async (text: string, shape: "headers" | "query" | "json") => {
			const head = store.documentHead(BODY)!;
			const lease = relay.acquireLease(BODY, owner, head.semanticEpoch, 60_000);
			assert.ok(lease.granted);
			const fresh = new Y.Doc({ gc: true });
			fresh.getText("body").insert(0, text);
			const snapshot = Y.encodeStateAsUpdate(fresh);
			fresh.destroy();
			const content = contentHashOf(text);
			const meta = { leaseId: lease.leaseId, expectedEpoch: head.semanticEpoch, coveredSequence: head.latestSequence,
				contentHash: content.hash, contentBytes: content.size };
			const request = shape === "headers" ? binaryReset(meta, snapshot)
				: shape === "query" ? binaryReset({}, snapshot, `?${new URLSearchParams(Object.entries(meta)
					.map(([key, value]) => [key, String(value)])).toString()}`)
				: new Request(`http://runtime/body/${BODY}/semantic-reset`, { method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...meta, snapshot: bytesToBase64(snapshot) }) });
			const response = await handleSemanticReset(deps, BODY, request, owner);
			const body = await response.json() as Record<string, unknown>;
			assert.equal(response.status, 200, JSON.stringify(body));
			assert.equal(body.epoch, head.semanticEpoch + 1);
			assert.equal(reconstructedText(store), text);
			assert.equal((body.policy as { lastResetAt: number }).lastResetAt !== null, true);
		};
		await resetOnce("binary headers", "headers");
		await resetOnce("binary query", "query");
		await resetOnce("json base64", "json");
		// Structural rejection and malformed metadata.
		const head = store.documentHead(BODY)!;
		const lease = relay.acquireLease(BODY, owner, head.semanticEpoch, 60_000);
		assert.ok(lease.granted);
		const meta = { leaseId: lease.leaseId, expectedEpoch: head.semanticEpoch, coveredSequence: head.latestSequence,
			contentHash: "a".repeat(64), contentBytes: 5 };
		const bad = await handleSemanticReset(deps, BODY, binaryReset(meta, new Uint8Array([9, 9, 9])), owner);
		assert.equal(bad.status, 400);
		assert.equal(((await bad.json()) as { reason: string }).reason, "invalid_snapshot");
		const missing = await handleSemanticReset(deps, BODY, binaryReset({ ...meta, expectedEpoch: "x" },
			new Uint8Array([0, 0])), owner);
		assert.equal(missing.status, 400);
		assert.equal(((await missing.json()) as { reason: string }).reason, "invalid_request");
	}, { resetCooldownMs: 0 });
});

s.test("reset cooldown: lease denied (429 + policy state) until the cooldown elapses", async () => {
	await withRelay(async (harness) => {
		const { store, relay, relayStore, clock } = harness;
		const head = store.documentHead(BODY)!;
		const lease = relay.acquireLease(BODY, owner, head.semanticEpoch, 60_000);
		assert.ok(lease.granted);
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, "hello");
		const content = contentHashOf("hello");
		const outcome = relay.semanticReset(BODY, owner, { leaseId: lease.leaseId, expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence, snapshot: Y.encodeStateAsUpdate(fresh), contentHash: content.hash,
			contentBytes: content.size });
		fresh.destroy();
		assert.ok(outcome.ok);
		const epoch = store.documentHead(BODY)!.semanticEpoch;
		const denied = relay.acquireLease(BODY, owner, epoch, 60_000);
		assert.equal(denied.granted, false);
		assert.equal(!denied.granted && denied.reason, "cooldown");
		const policy = !denied.granted ? denied.policy! : null;
		assert.equal(policy?.cooldownMs, 60_000);
		assert.equal(policy!.cooldownRemainingMs > 0 && policy!.cooldownRemainingMs <= 60_000, true);
		assert.equal(policy?.lastResetAt, clock.now);
		const response = await handleCompactionLease(resetDeps(harness), BODY, new Request("http://runtime/lease",
			{ method: "POST", body: JSON.stringify({ expectedEpoch: epoch }) }), owner);
		assert.equal(response.status, 429);
		assert.equal(response.headers.get("retry-after"), "60");
		assert.equal(((await response.json()) as { reason: string }).reason, "cooldown");
		// The reset path enforces it too (defence in depth).
		assert.equal((relayStore.semanticReset({ bodyId: BODY, actor: owner, leaseId: "none", expectedEpoch: epoch,
			coveredSequence: 0, snapshot: new Uint8Array([0, 0]), contentHash: content.hash, contentBytes: 0,
			now: clock.now, cooldownMs: 60_000 }) as { reason: string }).reason, "lease_invalid");
		clock.now += 60_001;
		const granted = relay.acquireLease(BODY, owner, epoch, 60_000);
		assert.ok(granted.granted);
		assert.equal(granted.granted && granted.policy.cooldownRemainingMs, 0);
		// Default and env override.
		assert.equal(DEFAULT_RELAY_CONFIG.resetCooldownMs, 24 * 60 * 60_000);
		assert.equal(readRelayConfig({ YAOS_RELAY_RESET_COOLDOWN_MS: "1500" }).resetCooldownMs, 1500);
		assert.equal(readRelayConfig({ YAOS_RELAY_RESET_COOLDOWN_MS: "0" }).resetCooldownMs, 0);
	}, { resetCooldownMs: 60_000 });
});

s.test("rate-limit burst holds one max-size frame: a 1.5 MB frame is accepted", async () => {
	assert.equal(readRelayConfig({ YAOS_RELAY_BURST_BYTES: "1024" }).burstBytes, RELAY_MIN_BURST_BYTES);
	assert.equal(RELAY_MIN_BURST_BYTES >= MAX_DURABLE_UPDATE_BYTES + 64, true, "R12: a max raw frame fits the bucket");
	assert.equal(readRelayConfig({}).burstBytes >= MAX_DURABLE_UPDATE_BYTES, true);
	assert.equal(DEFAULT_RELAY_CONFIG.burstBytes >= MAX_DURABLE_UPDATE_BYTES, true);
	assert.equal(readRelayConfig({ YAOS_RELAY_BURST_BYTES: String(4 * 1024 * 1024) }).burstBytes, 4 * 1024 * 1024);
	await withRelay(({ store, socket, update, seed }) => {
		const origin = socket();
		const before = store.documentHead(BODY)!.latestSequence;
		const big = textUpdate(seed, (text) => text.insert(text.length, "x".repeat(1_500_000)));
		assert.equal(big.byteLength > 1024 * 1024 && big.byteLength < MAX_DURABLE_UPDATE_BYTES, true);
		update(origin, big);
		assert.equal(origin.closed, null, JSON.stringify(origin.closed));
		assert.equal(store.documentHead(BODY)!.latestSequence > before, true);
	}, { burstBytes: readRelayConfig({}).burstBytes });
});

s.test("HTTP reads: GET/HEAD state carries sequence + hash state; bootstrap body reads are byte merges", async () => {
	await withRelay(async ({ store, relay, relayStore, socket, update, step1, seed, claim, envelope }) => {
		const origin = socket();
		const counter = store.documentMaterialisations;
		const baseline = counter.nonRoot;
		// Append without a claim: catalog hash unknown.
		update(origin, textUpdate(seed, (text) => text.insert(5, " world")));
		const head = relay.bodyHttpHead(BODY)!;
		assert.equal(head.hashState, "unknown");
		assert.equal(head.contentHash, null);
		assert.equal(head.latestSequence, store.documentHead(BODY)!.latestSequence);
		assert.equal(counter.nonRoot, baseline, "HEAD never materialises");
		const lazy = relay.bodyHttpState(BODY)!;
		assert.equal(lazy.hashState, "materialised");
		assert.equal(lazy.latestSequence, head.latestSequence);
		assert.equal(counter.nonRoot, baseline + 1, "the lazy hash is the one counted read-side materialisation");
		assert.equal(relay.bodyHttpState(BODY)!.hashState, "known");
		assert.equal(relay.bodyHttpHead(BODY)!.hashState, "known");
		// Claimed appends, step1, checkpoints and bootstrap body reads: no documents.
		const next = textUpdate(seed, (text) => text.insert(0, ">"));
		envelope(origin, next, claim(seed));
		update(origin, next);
		step1(origin, new Uint8Array([0]));
		const bootstrap = new BootstrapService(store, Date.now, undefined, DEFAULT_RELAY_CONFIG.maxMergeInputBytes);
		const descriptor = await bootstrap.start();
		const boundaryText = seed.getText("body").toString();
		update(origin, textUpdate(seed, (text) => text.insert(0, "after-boundary ")));
		relay.checkpointBody(BODY);
		const before = counter.nonRoot;
		const state = bootstrap.bodyState(descriptor.bootstrapId, BODY);
		assert.equal(counter.nonRoot, before, "relay bootstrap body read uses byte merge");
		const doc = new Y.Doc();
		Y.applyUpdate(doc, state.encodedState);
		assert.equal(doc.getText("body").toString(), boundaryText);
		doc.destroy();
		const base = new BootstrapService(store, Date.now).bodyState(descriptor.bootstrapId, BODY);
		assert.equal(counter.nonRoot, before + 1, "base bootstrap path materialises (control)");
		assert.equal(base.generation, state.generation);
		assert.equal(base.bodyEpoch, state.bodyEpoch);
		// A reset after the boundary: the pinned boundary recipe still serves the old lineage.
		const now = store.documentHead(BODY)!;
		const lease = relay.acquireLease(BODY, owner, now.semanticEpoch, 60_000);
		assert.ok(lease.granted);
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, seed.getText("body").toString());
		const content = contentHashOf(seed.getText("body").toString());
		assert.ok(relay.semanticReset(BODY, owner, { leaseId: lease.leaseId, expectedEpoch: now.semanticEpoch,
			coveredSequence: now.latestSequence, snapshot: Y.encodeStateAsUpdate(fresh), contentHash: content.hash,
			contentBytes: content.size }).ok);
		fresh.destroy();
		const pinned = bootstrap.bodyState(descriptor.bootstrapId, BODY);
		const pinnedDoc = new Y.Doc();
		Y.applyUpdate(pinnedDoc, pinned.encodedState);
		assert.equal(pinnedDoc.getText("body").toString(), boundaryText);
		assert.equal(pinned.bodyEpoch, state.bodyEpoch);
		pinnedDoc.destroy();
		assert.equal(relay.bodyHttpState(BODY)!.semanticEpoch, now.semanticEpoch + 1);
		assert.equal(counter.nonRoot, before + 1);
		assert.equal(relayStore.journalRowCount() > 0, true);
	}, { resetCooldownMs: 0 });
});

s.test("merge budget: over-budget bodies never call a wasm merge; step1 sends parts, reads 413, checkpoint skips", async () => {
	await withRelay(async ({ store, relay, socket, update, step1, seed, claim, envelope, freshRelay }) => {
		const origin = socket();
		for (let index = 0; index < 4; index++) {
			update(origin, textUpdate(seed, (text) => text.insert(text.length, String(index).repeat(900))));
		}
		assert.throws(() => relay.bodyHttpState(BODY), RelayMergeBudgetError);
		assert.equal(relay.counters.mergeBudgetRejects > 0, true);
		// G20: the checkpoint advances in byte-bounded prefixes while checkpoint +
		// prefix fits the budget, then refuses; the marker is persisted per epoch.
		assert.equal(relay.needsCheckpoint(BODY), true);
		let passes = 0;
		while (relay.checkpointBody(BODY) !== null) { passes++; assert.ok(passes < 10); }
		assert.equal(passes >= 1 && relay.counters.partialCheckpoints >= 1, true, "big tails advance incrementally");
		assert.equal(relay.needsCheckpoint(BODY), false);
		assert.equal(relay.isOverBudget(BODY), true);
		assert.equal(freshRelay().isOverBudget(BODY), true, "over-budget marker survives a new runtime");
		assert.equal(relay.runCheckpointPass({ retainSequences: 1000, skip: (id) => id !== BODY }).checkpoints, 0,
			"the alarm pass skips it");
		// Appends still commit (incremental SV path, bytes stay unmerged).
		const peer = socket();
		const tail = textUpdate(seed, (text) => text.insert(0, "!"));
		envelope(origin, tail, claim(seed));
		update(origin, tail);
		assert.equal(origin.last("BODY_COMMITTED")?.noop, false);
		// Step1 on an over-budget body: raw parts, one SYNC_STEP_2 each; they converge.
		const before = peer.binary.length;
		step1(peer, new Uint8Array([0]));
		const frames = peer.binary.slice(before);
		assert.equal(frames.length > 1, true);
		assert.equal(relay.counters.unmergedStep2Replies, 1);
		const doc = new Y.Doc();
		for (const bytes of frames) {
			const decoder = decoding.createDecoder(bytes);
			assert.equal(decoding.readVarUint(decoder), 0);
			assert.equal(decoding.readVarUint(decoder), 1);
			Y.applyUpdate(doc, decoding.readVarUint8Array(decoder));
		}
		assert.equal(doc.getText("body").toString(), seed.getText("body").toString());
		doc.destroy();
		// Bootstrap refuses too.
		const bootstrap = new BootstrapService(store, Date.now, undefined, relay.config.maxMergeInputBytes);
		const descriptor = await bootstrap.start();
		assert.throws(() => bootstrap.bodyState(descriptor.bootstrapId, BODY), RelayMergeBudgetError);
		// The batch flags the body instead of throwing at the first one.
		assert.deepEqual(bootstrap.bodyStatesForBatch(descriptor.bootstrapId, [BODY]),
			{ bodies: [], overBudgetBodyIds: [BODY] });
		// A client reset shrinks the body below the budget and re-enables everything.
		const head = store.documentHead(BODY)!;
		const lease = relay.acquireLease(BODY, owner, head.semanticEpoch, 60_000);
		assert.ok(lease.granted);
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, "compact");
		const content = contentHashOf("compact");
		assert.ok(relay.semanticReset(BODY, owner, { leaseId: lease.leaseId, expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence, snapshot: Y.encodeStateAsUpdate(fresh), contentHash: content.hash,
			contentBytes: content.size }).ok);
		fresh.destroy();
		assert.equal(relay.bodyHttpState(BODY)!.hashState, "known");
		assert.equal(relay.isOverBudget(BODY), false);
		assert.equal(freshRelay().isOverBudget(BODY), false, "a reset clears the persisted marker");
	}, { maxMergeInputBytes: 2048, exactMergeBytes: 0, checkpointEntries: 1, resetCooldownMs: 0 });
});

s.test("lazy hash guard: bodies above lazyHashMaxBytes keep an unknown hash without materialising", async () => {
	await withRelay(({ store, relay, socket, update, seed }) => {
		const origin = socket();
		update(origin, textUpdate(seed, (text) => text.insert(5, " world")));
		const baseline = store.documentMaterialisations.nonRoot;
		const state = relay.bodyHttpState(BODY)!;
		assert.equal(state.hashState, "unknown");
		assert.equal(state.contentHash, null);
		assert.equal(state.size, null);
		assert.equal(relay.counters.lazyHashSkips, 1);
		assert.equal(store.documentMaterialisations.nonRoot, baseline);
		assert.equal(readRelayConfig({ YAOS_RELAY_LAZY_HASH_MAX_BYTES: "5" }).lazyHashMaxBytes, 5);
		assert.equal(readRelayConfig({}).maxMergeInputBytes, 9 * 1024 * 1024);
	}, { lazyHashMaxBytes: 8 });
});

// ---- round 3 (RFC §12 gaps) ------------------------------------------------

function cloneOf(doc: Y.Doc): Y.Doc {
	const clone = new Y.Doc();
	Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
	return clone;
}

s.test("G6/G7: a revoked device gets 4403 on step1 and before candidate dedupe (never a re-ack)", async () => {
	await withRelay(({ socket, update, step1, envelope, seed, revoke, relay }) => {
		const origin = socket();
		const bytes = textUpdate(seed, (text) => text.insert(0, "1"));
		envelope(origin, bytes, { candidateId: "cand-r", candidateDigest: "digest-r" });
		update(origin, bytes);
		assert.equal(origin.last("BODY_COMMITTED")!.deduped, false);
		revoke(owner.deviceId);
		const replay = socket();
		envelope(replay, bytes, { candidateId: "cand-r", candidateDigest: "digest-r" });
		update(replay, bytes);
		assert.equal(replay.closed?.code, 4403);
		assert.equal(replay.last("BODY_COMMITTED"), undefined, "no dedupe re-ack for a revoked device");
		assert.equal(relay.counters.dedupeHits, 0);
		const reader = socket();
		step1(reader, new Uint8Array([0]));
		assert.equal(reader.binary.length, 0, "no step2 bytes for a revoked device");
		assert.equal(reader.closed?.code, 4403);
	});
});

s.test("G2/G11/G16: micro-batch drops revoked frames, collapses duplicate candidates, excludes every origin", async () => {
	await withRelay(({ socket, update, envelope, seed, revoke, journalRows, relay, relayStore, store, events }) => {
		const a = socket();
		const b = socket(peer);
		const writerA = cloneOf(seed);
		const rows = journalRows();
		update(a, textUpdate(writerA, (text) => text.insert(0, "A")));
		update(b, textUpdate(seed, (text) => text.insert(0, "B")));
		revoke(owner.deviceId);
		relay.flushBatch(BODY);
		assert.equal(a.closed?.code, 4403, "queued frame of a device revoked before commit is dropped");
		assert.equal(b.closed, null);
		assert.equal(journalRows(), rows + 1);
		assert.equal(relay.counters.authorityDrops, 1);
		assert.equal(reconstructedText(store), "Bhello");
		writerA.destroy();
		// Duplicate candidate ids inside one batch.
		const c = socket(peer);
		const attributions = relayStore.attributionCount();
		const bytes = textUpdate(seed, (text) => text.insert(0, "C"));
		for (const digest of ["d1", "d1", "d2"]) {
			envelope(c, bytes, { candidateId: "dup", candidateDigest: digest });
			update(c, bytes);
		}
		// A second origin in the same batch.
		const d = socket(peer);
		const other = textUpdate(seed, (text) => text.insert(0, "D"));
		envelope(d, other);
		update(d, other);
		relay.flushBatch(BODY);
		assert.equal(journalRows(), rows + 2, "one row for the whole batch");
		assert.equal(relayStore.attributionCount(), attributions + 2, "duplicate not attributed");
		const acks = c.controls.filter((value) => value.type === "BODY_COMMITTED");
		assert.equal(acks.length, 2);
		assert.deepEqual(acks.map((ack) => ack.deduped).sort(), [false, true]);
		assert.equal(acks[0]!.vaultSequence, acks[1]!.vaultSequence);
		assert.equal(c.last("BODY_UPDATE_REJECTED")!.reason, "candidate_id_reused");
		assert.equal(relay.counters.batchDuplicateCandidates, 2);
		assert.equal(d.controls.filter((value) => value.type === "BODY_COMMITTED").length, 1);
		const notice = events.filter((event) => event.kind === "committed").at(-1)!;
		assert.equal(notice.exclude, [c.attachment.socketId, d.attachment.socketId].sort().join(","),
			"base notice excludes every origin (each gets exactly its own ack)");
		assert.equal(reconstructedText(store), "DCBhello");
	}, { microbatchMs: 250 });
});

s.test("G3: batches are keyed by (body, epoch); a reset flushes pending frames first", async () => {
	await withRelay(({ socket, update, seed, journalRows, relay, relayStore, store }) => {
		const stale = socket(owner, 99);
		const live = socket(peer);
		const rows = journalRows();
		update(stale, textUpdate(cloneOf(seed), (text) => text.insert(0, "S")));
		update(live, textUpdate(seed, (text) => text.insert(0, "L")));
		relay.flushBatch(BODY);
		assert.equal(stale.closed?.code, 4409);
		assert.equal(live.closed, null, "a stale-epoch frame no longer fences the whole batch");
		assert.equal(journalRows(), rows + 1);
		const head = store.documentHead(BODY)!;
		const lease = relay.acquireLease(BODY, peer, head.semanticEpoch, 60_000);
		assert.ok(lease.granted);
		update(live, textUpdate(seed, (text) => text.insert(0, "Q")));
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, "Lhello");
		const content = contentHashOf("Lhello");
		const outcome = relay.semanticReset(BODY, peer, { leaseId: lease.leaseId, expectedEpoch: head.semanticEpoch,
			coveredSequence: head.latestSequence, snapshot: Y.encodeStateAsUpdate(fresh), contentHash: content.hash,
			contentBytes: content.size });
		fresh.destroy();
		assert.equal(!outcome.ok && outcome.reason, "head_advanced", "the queued frame committed before the reset");
		assert.equal(reconstructedText(store), "QLhello");
		assert.equal(relayStore.tableCounts().vault_journal! >= rows + 2, true);
	}, { microbatchMs: 250, resetCooldownMs: 0 });
});

s.test("G8: claims are accepted only against an exact SV; over-budget rebuild SV is inexact", async () => {
	await withRelay(({ socket, update, envelope, seed, claim, catalogHead, relay }) => {
		const origin = socket();
		const bytes = textUpdate(seed, (text) => text.insert(0, "i"));
		envelope(origin, bytes, claim(seed));
		update(origin, bytes);
		assert.equal(origin.last("BODY_COMMITTED")!.contentHashAccepted, false, "incremental SV path never accepts");
		assert.equal(catalogHead().contentHash, null);
		for (let index = 0; index < 3; index++) {
			update(origin, textUpdate(seed, (text) => text.insert(0, String(index).repeat(900))));
		}
		relay.invalidate(BODY);
		const entry = relay.headState(BODY)!;
		assert.equal(entry.bytes, null);
		assert.equal(entry.stateVectorExact, false, "part-SV max can overstate: marked inexact");
	}, { exactMergeBytes: 0, maxMergeInputBytes: 2048, checkpointEntries: 1_000 });
});

s.test("G5: relay appends never apply to a resident document; clean ones are discarded, dirty ones evicted later", async () => {
	const resident = { loaded: null as null | { dirty: boolean; validationPending: boolean }, discards: 0, applies: 0 };
	const cache = {
		get: () => resident.loaded ?? undefined,
		pendingFor: () => [],
		discardResident: () => { resident.discards++; resident.loaded = null; },
		applyDurableUpdate: () => { resident.applies++; return true; },
	} as unknown as VaultDocumentCache;
	await withRelay(({ socket, update, seed, relay }) => {
		const origin = socket();
		resident.loaded = { dirty: false, validationPending: false };
		update(origin, textUpdate(seed, (text) => text.insert(0, "1")));
		assert.equal(resident.discards, 1);
		resident.loaded = { dirty: true, validationPending: false };
		update(origin, textUpdate(seed, (text) => text.insert(0, "2")));
		assert.equal(resident.discards, 1, "a dirty resident is not discarded");
		assert.equal(relay.residentIsStale(BODY), true);
		assert.equal(relay.counters.residentStaleSkips, 1);
		assert.equal(relay.evictStaleResidents(), 0, "still dirty");
		resident.loaded.dirty = false;
		assert.equal(relay.evictStaleResidents(), 1);
		assert.equal(relay.residentIsStale(BODY), false);
		assert.equal(resident.applies, 0, "ywasm never runs on a resident document from the relay hot path");
	}, {}, cache);
});

s.test("G19: lease and reset re-check authority at install; revocation releases leases", async () => {
	await withRelay(async (harness) => {
		const { store, relay, relayStore, revoke } = harness;
		const head = store.documentHead(BODY)!;
		const lease = relay.acquireLease(BODY, owner, head.semanticEpoch, 60_000);
		assert.ok(lease.granted);
		const fresh = new Y.Doc({ gc: true });
		fresh.getText("body").insert(0, "hello");
		const snapshot = Y.encodeStateAsUpdate(fresh);
		fresh.destroy();
		const content = contentHashOf("hello");
		revoke(owner.deviceId);
		const response = await handleSemanticReset(resetDeps(harness), BODY, binaryReset({ leaseId: lease.leaseId,
			expectedEpoch: head.semanticEpoch, coveredSequence: head.latestSequence, contentHash: content.hash,
			contentBytes: content.size }, snapshot), owner);
		assert.equal(response.status, 403);
		assert.equal(((await response.json()) as { reason: string }).reason, "authority_superseded");
		assert.equal(store.documentHead(BODY)!.semanticEpoch, head.semanticEpoch, "nothing installed");
		const denied = relay.acquireLease(BODY, owner, head.semanticEpoch, 60_000);
		assert.equal(!denied.granted && denied.reason, "authority_superseded");
		const other = relay.acquireLease(BODY, peer, head.semanticEpoch, 60_000);
		assert.ok(other.granted, "the revoked holder's lease was released");
		assert.equal(relayStore.releaseLeasesFor({ deviceIds: [peer.deviceId] }), 1);
		assert.equal(relayStore.releaseLeasesFor({ principalIds: [peer.principalId] }), 0);
	}, { resetCooldownMs: 0 });
});

s.test("G13/G14: a lost envelope leaves the frame envelope-less (no mis-pairing); candidate frames have outcomes", async () => {
	await withRelay(({ store, socket, update, envelope, seed, relay }) => {
		const origin = socket();
		const bytes = textUpdate(seed, (text) => text.insert(0, "1"));
		envelope(origin, bytes, { candidateId: "cand-o", candidateDigest: "digest-o" });
		update(origin, bytes);
		const ack = origin.last("BODY_COMMITTED")!;
		const outcome = store.committedOperationOutcome(owner, "cand-o", "digest-o");
		assert.equal(outcome?.vaultSequence, ack.vaultSequence, "exact operation outcome found via attribution");
		// Hibernation/close drops the in-memory envelope before its frame arrives.
		const next = textUpdate(seed, (text) => text.insert(0, "2"));
		envelope(origin, next, { candidateId: "cand-p", candidateDigest: "digest-p" });
		relay.socketClosed(origin.attachment.socketId);
		const acks = origin.controls.length;
		update(origin, next);
		assert.equal(origin.controls.length, acks, "committed without an ack (the client resends as a no-op)");
		assert.equal(relay.counters.envelopeMismatches, 0);
		assert.equal(store.committedOperationOutcome(owner, "cand-p", "digest-p"), null);
		assert.equal(reconstructedText(store), "21hello");
	});
});

s.test("round 4 lean rows: 1 journal row + head per append; overlay, coalesced catalog event, clock, outcomes", async () => {
	await withRelay(({ store, relayStore, socket, update, envelope, seed, relay, claim, catalogHead }) => {
		assert.equal(store.leanRows, true);
		const origin = socket();
		const start = store.currentSequence();
		const tablesBefore = relayStore.tableCounts();
		const catalogBefore = catalogHead();
		const rowsBefore = relay.counters.rowsWritten;
		const appends = 20;
		for (let index = 0; index < appends; index++) {
			const bytes = textUpdate(seed, (text) => text.insert(text.length, String(index % 10)));
			envelope(origin, bytes, { ...claim(seed), candidateId: `lean-${index}`, candidateDigest: `digest-${index}` });
			update(origin, bytes);
		}
		const tablesAfter = relayStore.tableCounts();
		const delta = Object.fromEntries(Object.keys(tablesAfter)
			.map((name) => [name, tablesAfter[name]! - (tablesBefore[name] ?? 0)]).filter(([, value]) => value !== 0));
		// Candidate frames also keep their receipt row (G13); nothing else is inserted.
		assert.deepEqual(delta, { vault_journal: appends, vault_candidate_receipts: appends });
		const perAppend = (relay.counters.rowsWritten - rowsBefore) / appends;
		console.log(`[relay2-core] lean rows/append (node sqlite, candidate frames) ${perAppend}; deltas ${JSON.stringify(delta)}`);
		assert.equal(perAppend, 3, "journal + head + receipt");
		const head = store.documentHead(BODY)!;
		assert.equal(store.currentSequence(), head.latestSequence, "lean clock = MAX(clock, journal head)");
		assert.equal(head.latestSequence, start + appends);
		// Overlay: the catalog head is the latest journal row, with its inline accepted hash.
		const overlaid = catalogHead();
		const expected = contentHashOf(seed.getText("body").toString());
		assert.equal(overlaid.sequence, head.latestSequence);
		assert.equal(overlaid.generation, head.generation);
		assert.equal(overlaid.contentHash, expected.hash);
		assert.equal(overlaid.size, expected.size);
		assert.equal(overlaid.path, catalogBefore.path);
		assert.equal(store.listActiveCatalogAt(store.currentSequence()).find((entry) => entry.bodyId === BODY)?.contentHash,
			expected.hash);
		const historical = store.getCatalogHeadAt(start + 5, BODY)!;
		assert.equal(historical.sequence, start + 5, "boundary-respecting overlay");
		// G14: exact outcomes come from the inline attribution.
		assert.equal(store.committedOperationOutcome(owner, "lean-7", "digest-7")?.vaultSequence, start + 8);
		assert.equal(store.committedOperationOutcome(owner, "lean-7", "wrong"), null);
		// The delta feed lags until the coalescing pass, then carries one body-hash event.
		const boundary = store.currentSequence();
		assert.equal(store.catalogDeltaAt(start, boundary, null, 100).length, 0, "no per-append catalog events");
		relay.runCheckpointPass({ retainSequences: 1000 });
		assert.equal(relay.counters.leanCatalogEvents, 1);
		const deltas = store.catalogDeltaAt(boundary, store.currentSequence(), null, 100);
		assert.equal(deltas.length, 1);
		assert.equal(deltas[0]!.contentHash, expected.hash);
		const coalesced = catalogHead();
		assert.equal(coalesced.sequence, boundary + 1);
		assert.equal(coalesced.generation, head.generation);
		assert.equal(coalesced.contentHash, expected.hash);
		relay.runCheckpointPass({ retainSequences: 1000 });
		assert.equal(relay.counters.leanCatalogEvents, 1, "idempotent: nothing pending");
		// Base allocators never collide with lean sequences.
		const beforeBase = store.currentSequence();
		store.commitUpdate({ documentId: BODY, kind: "body", update: textUpdate(seed, (text) => text.insert(0, "z")),
			actorAttributions: [{ actor: owner }] });
		assert.equal(store.documentHead(BODY)!.latestSequence, beforeBase + 1);
		// An unknown (stale-claim) hash is NULL inline and backfilled inline.
		const unknown = textUpdate(seed, (text) => text.insert(0, "q"));
		update(origin, unknown);
		assert.equal(catalogHead().contentHash, null);
		const state = relay.bodyHttpState(BODY)!;
		assert.equal(state.hashState, "materialised");
		assert.equal(catalogHead().contentHash, contentHashOf(seed.getText("body").toString()).hash, "inline backfill");
		assert.equal(reconstructedText(store), seed.getText("body").toString());
	}, { leanRows: true });
});

s.test("G1: relay-only workloads keep a bounded journal (checkpoint pass advances the feed floor, respecting pins)", async () => {
	await withRelay(async ({ socket, update, seed, relay, store, journalRows }) => {
		const origin = socket();
		const started = performance.now();
		for (let index = 0; index < 5_000; index++) {
			update(origin, textUpdate(seed, (text) => text.insert(text.length, "x")));
			if (index % 100 === 99) relay.runCheckpointPass({ retainSequences: 1000 });
		}
		const pass = relay.runCheckpointPass({ retainSequences: 1000 });
		const rows = journalRows();
		console.log(`[relay2-core] G1 5000 appends: journal rows ${rows}, floor ${pass.floor}, `
			+ `floor advances ${relay.counters.floorAdvances}, pruned ${relay.counters.floorRowsPruned}, `
			+ `${Math.round(performance.now() - started)} ms`);
		assert.equal(rows <= 1000 + relay.config.checkpointEntries + 10, true, `bounded journal (${rows} rows)`);
		assert.equal(pass.floor >= store.currentSequence() - 1000 - 1, true);
		assert.equal(reconstructedText(store).length, 5 + 5_000);
		// An active pin holds the floor below its boundary.
		const bootstrap = new BootstrapService(store, Date.now, undefined, relay.config.maxMergeInputBytes);
		await bootstrap.start();
		const boundary = store.currentSequence();
		for (let index = 0; index < 300; index++) update(origin, textUpdate(seed, (text) => text.insert(0, "y")));
		relay.runCheckpointPass({ retainSequences: 10 });
		assert.equal(store.journalFloor() < boundary, true, "floor stays below the active pin boundary");
	}, { rateBytesPerSec: 1 << 30 });
});

s.test("G4: the lazy hash is computed once per (body, head sequence) and never on the append path", async () => {
	await withRelay(({ store, socket, update, seed, relay, relayStore }) => {
		const origin = socket();
		const baseline = store.documentMaterialisations.nonRoot;
		for (let index = 0; index < 5; index++) update(origin, textUpdate(seed, (text) => text.insert(0, String(index))));
		assert.equal(store.documentMaterialisations.nonRoot, baseline, "appends never materialise");
		const catalog = store.getCatalogHeadAt(store.currentSequence(), BODY)!;
		// Simulate a refused backfill (the head catalog event moved): the cache still serves repeats.
		const original = relayStore.backfillCatalogHash.bind(relayStore);
		relayStore.backfillCatalogHash = () => false;
		assert.equal(relay.bodyHttpState(BODY)!.hashState, "materialised");
		assert.equal(relay.bodyHttpState(BODY)!.hashState, "known");
		assert.equal(relay.bodyHttpState(BODY)!.contentHash, contentHashOf("43210hello").hash);
		assert.equal(relay.counters.lazyHashCacheHits, 2);
		assert.equal(store.documentMaterialisations.nonRoot, baseline + 1, "one materialisation for repeated GETs");
		relayStore.backfillCatalogHash = original;
		assert.equal(catalog.contentHash, null);
	});
});

s.test("round 4 no silent drops: a pre-append throw closes 1011 with VAULT_ERROR (direct and micro-batch timer paths)", async () => {
	for (const microbatchMs of [0, 5]) {
		await withRelay(({ socket, update, seed, relay, journalRows }) => {
			const origin = socket();
			const other = socket(peer);
			const rowsBefore = journalRows();
			const original = relay.headState.bind(relay);
			relay.headState = () => { throw new Error("injected rebuild failure"); };
			update(origin, textUpdate(seed, (text) => text.insert(0, "x")));
			relay.flushAllBatches();
			relay.headState = original;
			assert.equal(origin.closed?.code, 1011, `mb${microbatchMs}: origin closed 1011`);
			assert.equal(origin.last("VAULT_ERROR")?.code, "relay_frame_error");
			assert.equal(relay.counters.frameErrors, 1);
			assert.equal(journalRows(), rowsBefore, "nothing was appended");
			assert.equal(other.binary.length, 0, "no fan-out of an uncommitted frame");
			const diagnostics = relay.diagnostics() as { lastFrameError: { message: string } | null };
			assert.equal(diagnostics.lastFrameError?.message, "injected rebuild failure");
			// The service keeps working for later frames (the merged cache was dropped and rebuilds).
			const later = socket();
			update(later, textUpdate(seed, (text) => text.insert(0, "y")));
			relay.flushAllBatches();
			assert.equal(journalRows(), rowsBefore + 1);
			assert.equal(other.binary.length, 1);
		}, { microbatchMs, rateBytesPerSec: 1 << 30 });
	}
});

s.test("round 4 no silent drops: a post-commit throw never costs a peer its fan-out frame", async () => {
	await withRelay(({ socket, update, envelope, seed, relay, journalRows, events }) => {
		const origin = socket();
		const other = socket(peer);
		const rowsBefore = journalRows();
		const internals = relay as unknown as { syncDocumentCache: (bodyId: string) => void };
		const original = internals.syncDocumentCache;
		internals.syncDocumentCache = () => { throw new Error("injected cache failure"); };
		origin.send = () => { throw new Error("origin socket gone"); };
		const change = textUpdate(seed, (text) => text.insert(0, "z"));
		envelope(origin, change);
		update(origin, change);
		internals.syncDocumentCache = original;
		assert.equal(journalRows(), rowsBefore + 1, "appended");
		assert.equal(other.binary.length, 1, "peer still got the update");
		assert.ok(events.some((event) => event.kind === "committed"), "base notice still sent");
		assert.equal(relay.counters.postCommitErrors >= 1, true);
		assert.equal(relay.counters.frameErrors, 0);
		assert.equal(origin.closed, null, "a post-commit failure is not reported as a lost frame");
	});
});

s.test("round 4 accounting: random interleavings (gaps, resends, empties) at mb0 and mb>0 lose nothing", async () => {
	for (const microbatchMs of [0, 10]) {
		await withRelay(({ store, socket, update, envelope, seed, relay }) => {
			let random = 0x9e3779b9 ^ microbatchMs;
			const next = () => { random = (Math.imul(random ^ (random >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return random / 2 ** 32; };
			const writers = [owner, peer].map((actor) => {
				const doc = new Y.Doc();
				Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
				return { actor, doc, socket: socket(actor), queue: [] as Uint8Array[] };
			});
			const observer = socket({ ...owner, deviceId: "device-observer" });
			const truth = new Y.Doc();
			Y.applyUpdate(truth, Y.encodeStateAsUpdate(seed));
			for (let step = 0; step < 400; step++) {
				const writer = writers[Math.floor(next() * writers.length)]!;
				const change = textUpdate(writer.doc, (text) => text.insert(Math.floor(next() * (text.length + 1)), "abc"[step % 3]!));
				Y.applyUpdate(truth, change);
				writer.queue.push(change);
				// Deliver out of causal order sometimes (a later frame first), resend sometimes, send empties.
				while (writer.queue.length > 0 && next() < 0.7) {
					const index = writer.queue.length > 1 && next() < 0.3 ? 1 : 0;
					const [frame] = writer.queue.splice(index, 1);
					if (next() < 0.5) envelope(writer.socket, frame!);
					update(writer.socket, frame!);
					if (next() < 0.1) update(writer.socket, frame!);
					if (next() < 0.05) update(writer.socket, new Uint8Array([0, 0]));
				}
				if (next() < 0.2) relay.flushAllBatches();
			}
			for (const writer of writers) for (const frame of writer.queue.splice(0)) update(writer.socket, frame);
			relay.flushAllBatches();
			const c = relay.counters;
			const outcomes = c.appendFrames + c.noopSkips + c.dedupeHits + c.dedupeConflicts + c.batchDuplicateCandidates
				+ c.authorityCloses + c.authorityDrops + c.rateLimitCloses + c.epochFences + c.bodyInactiveCloses
				+ c.tooLargeCloses + c.commitFailures + c.frameErrors;
			assert.equal(outcomes, c.updateFrames, `mb${microbatchMs}: every update frame has exactly one outcome`);
			assert.equal(c.frameErrors + c.commitFailures + c.rateLimitCloses, 0);
			for (const writer of writers) assert.equal(writer.socket.closed, null);
			assert.equal(reconstructedText(store), truth.getText("body").toString(), `mb${microbatchMs}: durable state equals the writers' union`);
			const peerView = new Y.Doc();
			Y.applyUpdate(peerView, Y.encodeStateAsUpdate(seed));
			for (const frame of observer.binary) {
				const decoder = decoding.createDecoder(frame);
				decoding.readVarUint(decoder);
				decoding.readVarUint(decoder);
				Y.applyUpdate(peerView, decoding.readVarUint8Array(decoder));
			}
			assert.equal(peerView.getText("body").toString(), truth.getText("body").toString(), `mb${microbatchMs}: a peer fed only fan-out converges`);
			for (const writer of writers) writer.doc.destroy();
			truth.destroy();
			peerView.destroy();
		}, { microbatchMs, rateBytesPerSec: 1 << 30 });
	}
});

await s.done();
