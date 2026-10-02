// Batch 3 (b3-bulk): bulk-created bodies under relay v3 (YAOS_RELAY_GROUP_COMMIT).
// Real SQLite (NodeSqliteStorage) under VaultStore (lean rows + relay tail) +
// VaultBulkCreateService + RelayBodyStore + RelayBodyService with fake sockets.
//
//  * the bulk sequence is allocated past the relay tail head (group commits write
//    no journal row and no clock row, so MAX(clock, journal) alone would reuse it);
//  * a bulk body (checkpoint + manifest + head, no journal row) takes relay typing:
//    step1 serves the checkpoint, the first group commit writes one tail row,
//    reconstruct = checkpoint + tail, the catalog overlay follows the claim;
//  * catch-up feed, tail-cap checkpoint, wake re-sync and the HTTP candidate
//    relay path (commitHttpCandidate) all work on a bulk body;
//  * the post-commit hook sees the exact stored bytes once per batch, never on a
//    replay, and a throwing hook does not fail the receipt.
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
import { MAX_DURABLE_UPDATE_BYTES } from "../../server/src/contracts";
import { RelayBodyService, type RelaySocketHost } from "../../server/src/relayBodies";
import { RelayBodyStore } from "../../server/src/relayBodyStore";
import { DEFAULT_RELAY_CONFIG, type RelayConfig } from "../../server/src/relayFlag";
import { decodeBinaryEnvelope, encodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";
import { candidateDigestMaterial } from "../../server/src/shared/candidateDigest";
import { canonicalMarkdownBytes } from "../../server/src/shared/markdownCodec";
import { VaultBulkCreateService, type BulkCreateCommittedEvent, type BulkCreateOutcome } from "../../server/src/vaultBulkCreateService";
import { VaultCandidateService } from "../../server/src/vaultCandidateService";
import { VaultDocumentCache } from "../../server/src/vaultDocumentCache";
import { sha256HexSync } from "../../server/src/vaultDocumentStore";
import type { VaultSocketAttachment, VaultSocketPort, VaultSocketService } from "../../server/src/vaultSocketService";
import { VaultStore, type VaultStoragePort } from "../../server/src/vaultStore";
import { suite } from "../harness.ts";
import { CfRowModel } from "./helpers/cfRowModel.ts";

/** Raw SQL handle of a VaultStore (its `storage` is protected; tests read tables directly). */
const sqlOf = (store: VaultStore) => (store as unknown as { storage: VaultStoragePort }).storage.sql;

const s = suite("relay3-bulk-create");

const VAULT_ID = "relay3-bulk-vault";
const VAULT_GENERATION = "relay3-bulk-generation";
const RUNTIME = "runtime-r3-bulk";
const SEEDED = "relay3-seeded-body";

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
	all(type: string): Control[] { return this.controls.filter((value) => value.type === type); }
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

function contentHashOf(text: string): { hash: string; size: number } {
	const bytes = canonicalMarkdownBytes(text);
	return { hash: sha256HexSync(bytes), size: bytes.byteLength };
}

interface Envelope { outcomes: BulkCreateOutcome[]; vaultSequence: number; replayed: boolean }

interface Harness {
	store: VaultStore;
	relayStore: RelayBodyStore;
	relay: RelayBodyService;
	cache: VaultDocumentCache;
	hookEvents: BulkCreateCommittedEvent[];
	hook: { throws: boolean };
	/** Client docs of bulk-created bodies, keyed by body id (the same Yjs items the server stored). */
	docs: Map<string, Y.Doc>;
	bulk(batchId: string, notes: Array<{ bodyId: string; path: string; text: string }>): Promise<Envelope>;
	socket(bodyId: string, actor?: typeof owner, runtimeEpoch?: string): FakeSocket;
	update(socket: FakeSocket, update: Uint8Array, via?: RelayBodyService): void;
	step1(socket: FakeSocket, stateVector: Uint8Array, via?: RelayBodyService): void;
	step2(socket: FakeSocket, update: Uint8Array, via?: RelayBodyService): void;
	envelope(socket: FakeSocket, doc: Y.Doc, update: Uint8Array, candidateId: string, via?: RelayBodyService): void;
	freshRelay(runtimeEpoch: string): RelayBodyService;
	text(bodyId: string, through?: number): string;
	seed: Y.Doc;
}

async function withHarness(check: (harness: Harness) => Promise<void>, config: Partial<RelayConfig> = {}): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-relay3-bulk-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const storage = { sql: sqlite.sql, transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure) } as unknown as VaultStoragePort;
	const services: RelayBodyService[] = [];
	const docs = new Map<string, Y.Doc>();
	const seed = new Y.Doc({ guid: SEEDED });
	try {
		const store = new VaultStore(storage);
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", 8);
		root.getMap("sys").set("protocolVersion", 5);
		store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root), 1);
		root.destroy();
		const effective: RelayConfig = { ...DEFAULT_RELAY_CONFIG, leanRows: true, groupCommit: true,
			gcIdleMs: 60_000, gcMaxMs: 60_000, rateBytesPerSec: 1 << 30, ...config };
		store.enableLeanRows();
		store.enableRelayTail();
		store.installAuthorityFence({ changeId: "r3-bulk-bootstrap", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
			subjectDigest: "r3-bulk-bootstrap-digest", subjects: [
				{ principalId: owner.principalId, role: owner.role, state: "active", membershipRevision: 1,
					policyVersion: 1, capabilityDigest: owner.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
				{ deviceId: owner.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
				{ deviceId: peer.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
			] });
		// A pre-existing body created the old way (journal row), so relay typing on it can move the tail head past the journal head.
		const initial = contentHashOf("seed");
		store.commitUpdate({ documentId: SEEDED, kind: "body", update: textUpdate(seed, (text) => text.insert(0, "seed")),
			catalog: [{ bodyId: SEEDED, fileId: SEEDED, path: "seeded.md", previousPath: null, lifecycle: "active",
				bodyGeneration: 1, contentHash: initial.hash, size: initial.size }] });
		const relayStore = new RelayBodyStore(storage, store);
		const cache = new VaultDocumentCache(store, () => new Set<string>(), () => new Set<string>());
		const hookEvents: BulkCreateCommittedEvent[] = [];
		const hook = { throws: false };
		const bulkService = new VaultBulkCreateService({
			store, cache,
			sockets: () => ({ broadcastDocumentUpdate: () => {} }) as unknown as VaultSocketService,
			vaultGeneration: () => VAULT_GENERATION,
			runtimeEpoch: RUNTIME,
			hasBlob: async () => false,
			flush: async () => true,
			validateActor: (actor) => store.validateActor(actor) === "allowed",
			onBulkCreateCommitted: (event) => {
				hookEvents.push(event);
				if (hook.throws) throw new Error("mirror down");
			},
		});
		const sockets: FakeSocket[] = [];
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
				armCheckpointAlarm: () => {},
			});
			service.bindHost(host);
			services.push(service);
			return service;
		};
		const relay = makeRelay(RUNTIME);
		const raw = (kind: number, payload: Uint8Array): Uint8Array => {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, 0);
			encoding.writeVarUint(encoder, kind);
			encoding.writeVarUint8Array(encoder, payload);
			return encoding.toUint8Array(encoder);
		};
		const binary = (via: RelayBodyService, socket: FakeSocket, kind: number, payload: Uint8Array) => {
			const bytes = raw(kind, payload);
			if (via.admitRaw(socket, socket.attachment, bytes.slice().buffer, MAX_DURABLE_UPDATE_BYTES + 64)) {
				const decoder = decoding.createDecoder(bytes);
				decoding.readVarUint(decoder);
				via.handleSyncFrame(socket, socket.attachment, decoder);
			}
		};
		let nextSocket = 0;
		await check({
			store, relayStore, relay, cache, hookEvents, hook, docs, seed,
			async bulk(batchId, notes) {
				const files = notes.map((note, index) => {
					let doc = docs.get(note.bodyId);
					if (!doc) {
						doc = new Y.Doc({ guid: note.bodyId });
						doc.getText("body").insert(0, note.text);
						docs.set(note.bodyId, doc);
					}
					return { operationId: `op-${batchId}-${index}`, bodyId: note.bodyId, path: note.path,
						updates: [Y.encodeStateAsUpdate(doc)] };
				});
				const response = await bulkService.handle(new Request("https://internal/lifecycle/create-bulk", {
					method: "POST", body: encodeBinaryEnvelope({ batchId, rootEpoch: 1, files, attachments: [] }).slice().buffer,
				}), owner, () => null);
				if (response.status !== 200) throw new Error(`${batchId}: ${response.status} ${await response.text()}`);
				return decodeBinaryEnvelope(new Uint8Array(await response.arrayBuffer())) as Envelope;
			},
			socket(bodyId, actor = owner, runtimeEpoch = RUNTIME) {
				const socket = new FakeSocket({ ...actor, runtimeEpoch, documentId: bodyId, kind: "body",
					documentEpoch: store.documentHead(bodyId)!.semanticEpoch, socketId: `socket-${++nextSocket}`, relay: true });
				sockets.push(socket);
				return socket;
			},
			update(socket, update, via = relay) { binary(via, socket, 2, update); },
			step1(socket, stateVector, via = relay) { binary(via, socket, 0, stateVector); },
			step2(socket, update, via = relay) { binary(via, socket, 1, update); },
			envelope(socket, doc, update, candidateId, via = relay) {
				const content = contentHashOf(doc.getText("body").toString());
				const message = `__YPS:${JSON.stringify({
					type: "BODY_UPDATE_ENVELOPE", bodyId: socket.attachment.documentId, bodyEpoch: socket.attachment.documentEpoch,
					clientFrameId: candidateId, payloadDigest: sha256HexSync(update), candidateId,
					contentHash: content.hash, size: content.size, stateVector: bytesToBase64(Y.encodeStateVector(doc)),
				})}`;
				if (via.admitRaw(socket, socket.attachment, message, 64 * 1024)) via.handleControl(socket, socket.attachment, message);
			},
			freshRelay: (runtimeEpoch) => makeRelay(runtimeEpoch),
			text(bodyId, through) {
				const reconstructed = store.reconstructDocument(bodyId, through);
				try { return crdtEngine.readText(reconstructed.doc, "body"); }
				finally { crdtEngine.destroyDocument(reconstructed.doc); }
			},
		});
	} finally {
		for (const service of services) service.dropPendingGroupCommits();
		for (const doc of docs.values()) doc.destroy();
		seed.destroy();
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function ackedIds(socket: FakeSocket): string[] {
	return socket.all("BODY_COMMITTED").map((ack) => String(ack.clientFrameId));
}

s.test("the bulk sequence is allocated past the relay tail head (no reuse of a tail-only sequence)", async () => {
	await withHarness(async ({ store, relay, socket, update, seed, bulk, text }) => {
		const writer = socket(SEEDED);
		for (let index = 0; index < 3; index++) {
			update(writer, textUpdate(seed, (value) => value.insert(value.length, ` ${index}`)));
			relay.flushBatch(SEEDED);
		}
		const tail = store.relayTailRow(SEEDED)!;
		const journalHead = store.currentSequence();
		assert.equal(journalHead, tail.latestSequence, "currentSequence reads the tail head");
		const clock = sqlOf(store).exec<{ sequence: number }>("SELECT sequence FROM vault_clock WHERE id = 1").one().sequence;
		const journalMax = sqlOf(store).exec<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM vault_journal").one().sequence;
		assert.ok(Math.max(clock, journalMax) < tail.latestSequence, "precondition: the tail is ahead of clock and journal");
		const created = await bulk("after-tail", [{ bodyId: "b-1", path: "b/1.md", text: "one\n" }]);
		assert.equal(created.vaultSequence, tail.latestSequence + 1, "bulk takes MAX(clock, journal, tail) + 1");
		assert.equal(store.documentHead("b-1")!.latestSequence, created.vaultSequence);
		assert.equal(store.documentHead("root")!.latestSequence, created.vaultSequence);
		assert.equal(text("b-1"), "one\n");
		// And relay typing after the bulk keeps moving forward.
		update(writer, textUpdate(seed, (value) => value.insert(0, "x")));
		relay.flushBatch(SEEDED);
		assert.equal(store.relayTailRow(SEEDED)!.latestSequence, created.vaultSequence + 1);
		const next = await bulk("after-tail-2", [{ bodyId: "b-2", path: "b/2.md", text: "two\n" }]);
		assert.equal(next.vaultSequence, created.vaultSequence + 2);
	});
});

s.test("b3-int 4a: the legacy (non-group) relay append allocates past the tail head, with the tail flag on or off", async () => {
	await withHarness(async ({ store, relayStore, relay, socket, update, seed }) => {
		const writer = socket(SEEDED);
		for (let index = 0; index < 3; index++) {
			update(writer, textUpdate(seed, (value) => value.insert(value.length, ` g${index}`)));
			relay.flushBatch(SEEDED);
		}
		const tailHead = store.relayTailRow(SEEDED)!.latestSequence;
		const clock = sqlOf(store).exec<{ sequence: number }>("SELECT sequence FROM vault_clock WHERE id = 1").one().sequence;
		const journalMax = sqlOf(store).exec<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM vault_journal").one().sequence;
		assert.ok(Math.max(clock, journalMax) < tailHead, "precondition: the tail is ahead of clock and journal");
		const epoch = store.documentHead(SEEDED)!.semanticEpoch;
		const legacy = (bodyId: string, target: RelayBodyStore, insert: string) => target.appendRelayBodyUpdate({
			bodyId, expectedEpoch: epoch, update: textUpdate(seed, (value) => value.insert(value.length, insert)),
			attributions: [{ actor: owner }], catalogContent: null, receipts: [] });
		// Tail flag on: the non-group path (grouped=false) must not reissue a tail-only sequence.
		const first = legacy(SEEDED, relayStore, " legacy-on");
		assert.equal(first.vaultSequence, tailHead + 1, "legacy append takes MAX(clock, journal, tail) + 1");
		assert.equal(store.currentSequence(), first.vaultSequence);
		// Flag change: tail rows exist but this instance runs lean without the tail.
		const storage = (store as unknown as { storage: VaultStoragePort }).storage;
		const off = new VaultStore(storage);
		off.enableLeanRows();
		assert.ok(off.currentSequence() >= first.vaultSequence, "the flag-off store sees the newest sequence");
		const second = legacy(SEEDED, new RelayBodyStore(storage, off), " legacy-off");
		assert.equal(second.vaultSequence, first.vaultSequence + 1, "flag off: still above the tail and journal heads");
		const third = legacy(SEEDED, new RelayBodyStore(storage, off), " legacy-off-2");
		assert.equal(third.vaultSequence, second.vaultSequence + 1);
	});
});

s.test("first relay typing on a bulk body: step1 serves the checkpoint, one tail row, reconstruct = checkpoint + tail, overlay follows", async () => {
	await withHarness(async ({ store, relay, socket, update, step1, envelope, docs, bulk, text }) => {
		const cursor = store.currentSequence();
		const created = await bulk("first-typing", [
			{ bodyId: "t-1", path: "t/1.md", text: "alpha\n" }, { bodyId: "t-2", path: "t/2.md", text: "beta\n" }]);
		const doc = docs.get("t-1")!;
		// A reader joining the bulk body gets the stored checkpoint.
		const reader = socket("t-1", peer);
		step1(reader, Y.encodeStateVector(new Y.Doc()));
		const view = new Y.Doc();
		Y.applyUpdate(view, reader.frames()[0]!.payload);
		assert.equal(view.getText("body").toString(), "alpha\n");
		view.destroy();
		// The creating device types (the same Yjs client that produced the bulk frames).
		const writer = socket("t-1");
		const edit = textUpdate(doc, (value) => value.insert(value.length, "more\n"));
		envelope(writer, doc, edit, "first-edit");
		update(writer, edit);
		assert.equal(store.relayTailRow("t-1"), null, "buffered, not yet durable");
		relay.flushBatch("t-1");
		assert.deepEqual(ackedIds(writer), ["first-edit"]);
		const tail = store.relayTailRow("t-1")!;
		assert.equal(tail.frames, 1);
		assert.equal(tail.baseSequence, created.vaultSequence + 1);
		assert.equal(store.documentHead("t-1")!.latestSequence, created.vaultSequence + 1);
		assert.equal(text("t-1"), "alpha\nmore\n", "reconstruct = bulk checkpoint + tail");
		assert.equal(text("t-1", created.vaultSequence), "alpha\n", "the bulk boundary still reconstructs");
		const expected = contentHashOf("alpha\nmore\n");
		assert.equal(store.getCatalogHeadAt(store.currentSequence(), "t-1")!.contentHash, expected.hash, "lean overlay serves the claim");
		assert.equal(store.getCatalogHeadAt(created.vaultSequence, "t-1")!.contentHash, contentHashOf("alpha\n").hash);
		// Catch-up: from before the bulk, both bodies and root appear; t-1 at its tail head.
		const page = store.changesPageAfter(cursor, 100);
		const at = (id: string) => page.entries.find((entry) => entry.documentId === id);
		assert.equal(at("t-1")?.sequence, created.vaultSequence + 1);
		assert.equal(at("t-2"), undefined, "an untouched bulk body has no entry of its own (its head shares the root row's sequence)");
		assert.equal(at("root")?.sequence, created.vaultSequence);
		assert.equal(at("root")?.kind, "create");
		assert.deepEqual(at("root")!.catalogs.map((item) => item.bodyId).sort(), ["t-1", "t-2"],
			"the root create entry carries every created catalog row");
		assert.equal(page.highWater, store.currentSequence());
		const later = store.changesPageAfter(created.vaultSequence, 100);
		assert.deepEqual(later.entries.map((entry) => entry.documentId), ["t-1"], "only the typed body after the bulk");
	});
});

s.test("tail-cap checkpoint on a bulk body keeps text, overlay and the bulk boundary", async () => {
	await withHarness(async ({ store, relay, socket, update, envelope, docs, bulk, text }) => {
		const created = await bulk("cap", [{ bodyId: "c-1", path: "c/1.md", text: "cap\n" }]);
		const doc = docs.get("c-1")!;
		const writer = socket("c-1");
		let index = 0;
		while (relay.counters.tailCheckpoints === 0 && index < 200) {
			const edit = textUpdate(doc, (value) => value.insert(value.length, "y".repeat(40)));
			envelope(writer, doc, edit, `cap-${index++}`);
			update(writer, edit);
			relay.flushBatch("c-1");
		}
		assert.equal(relay.counters.tailCheckpoints, 1);
		assert.equal(text("c-1"), doc.getText("body").toString());
		assert.equal(store.getCatalogHeadAt(store.currentSequence(), "c-1")!.contentHash,
			contentHashOf(doc.getText("body").toString()).hash);
		assert.ok(store.documentHead("c-1")!.latestSequence > created.vaultSequence);
		const edit = textUpdate(doc, (value) => value.insert(0, "z"));
		envelope(writer, doc, edit, "after-cap");
		update(writer, edit);
		relay.flushBatch("c-1");
		assert.equal(text("c-1"), doc.getText("body").toString());
	}, { gcTailBytes: 400 });
});

s.test("wake re-sync on a bulk body: the new runtime's step1 carries the bulk state; a lost frame comes back from a peer", async () => {
	await withHarness(async ({ store, relay, socket, update, step2, envelope, docs, bulk, freshRelay, text }) => {
		await bulk("wake", [{ bodyId: "w-1", path: "w/1.md", text: "wake\n" }]);
		const doc = docs.get("w-1")!;
		const durable = Y.encodeStateVector(doc);
		const a = socket("w-1");
		const b = socket("w-1", peer);
		const lost = textUpdate(doc, (value) => value.insert(0, "lost "));
		envelope(a, doc, lost, "lost-1");
		update(a, lost);
		relay.dropPendingGroupCommits();
		const next = freshRelay("runtime-r3-bulk-wake");
		assert.equal(next.ensureWakeResync(), 2);
		for (const target of [a, b]) {
			const step1s = target.frames().filter((frame) => frame.kind === 0);
			assert.equal(step1s.length, 1);
			assert.deepEqual(Y.decodeStateVector(step1s[0]!.payload), Y.decodeStateVector(durable));
		}
		const head = store.documentHead("w-1")!.latestSequence;
		const peerDoc = new Y.Doc();
		Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc));
		step2(b, Y.encodeStateAsUpdate(peerDoc, durable), next);
		next.flushBatch("w-1");
		assert.equal(store.documentHead("w-1")!.latestSequence, head + 1);
		assert.equal(text("w-1"), "lost wake\n");
		peerDoc.destroy();
	});
});

s.test("HTTP candidate on a bulk body takes the relay path (tail + head + receipt ring), no journal row", async () => {
	await withHarness(async ({ store, relay, relayStore, cache, docs, bulk, text }) => {
		const created = await bulk("http", [{ bodyId: "h-1", path: "h/1.md", text: "http\n" }]);
		const doc = docs.get("h-1")!;
		const candidates = new VaultCandidateService({
			store, cache,
			sockets: () => ({ broadcastDocumentUpdate: () => {}, notifyBodyCommitted: () => {} }) as never,
			vaultId: () => VAULT_ID, vaultGeneration: () => VAULT_GENERATION, runtimeEpoch: RUNTIME,
			flush: async () => true,
			flushRelay: (bodyId: string) => { relay.flushForRead(bodyId); },
			relayCommit: (input: Parameters<RelayBodyService["commitHttpCandidate"]>[0]) => relay.commitHttpCandidate(input),
			validateActor: () => true,
			// lifecycle is unused on the candidate path exercised here.
		} as unknown as ConstructorParameters<typeof VaultCandidateService>[0]);
		const edit = textUpdate(doc, (value) => value.insert(value.length, "closed save\n"));
		const rows = relayStore.journalRowCount();
		const response = await candidates.handle("h-1", new Request("https://internal/body/h-1/candidate", {
			method: "POST", body: edit, headers: { "x-yaos-candidate-id": "http-1",
				"x-yaos-candidate-digest": sha256HexSync(candidateDigestMaterial([edit])),
				"x-yaos-body-epoch": "1" } }), owner);
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(relayStore.journalRowCount(), rows, "no journal row");
		assert.equal(store.relayTailRow("h-1")!.frames, 1);
		assert.equal(store.documentHead("h-1")!.latestSequence, created.vaultSequence + 1);
		assert.equal(text("h-1"), "http\nclosed save\n");
	});
});

s.test("post-commit hook: once per committed batch with the exact stored bytes; not on replay; a throwing hook does not fail the receipt", async () => {
	await withHarness(async ({ store, hookEvents, hook, bulk }) => {
		const first = await bulk("hook-1", [{ bodyId: "k-1", path: "k/1.md", text: "k one\n" }, { bodyId: "k-2", path: "k/2.md", text: "k two\n" }]);
		assert.equal(hookEvents.length, 1);
		const event = hookEvents[0]!;
		assert.equal(event.batchId, "hook-1");
		assert.equal(event.vaultSequence, first.vaultSequence);
		assert.deepEqual(event.bodies.map((body) => body.bodyId), ["k-1", "k-2"]);
		for (const body of event.bodies) {
			const stored = sqlOf(store).exec<{ data: ArrayBuffer }>(
				"SELECT data FROM vault_checkpoints WHERE document_id = ? AND checkpoint_sequence = ? ORDER BY chunk_index",
				body.bodyId, event.vaultSequence).toArray().map((row) => new Uint8Array(row.data));
			const joined = new Uint8Array(stored.reduce((sum, chunk) => sum + chunk.byteLength, 0));
			let offset = 0;
			for (const chunk of stored) { joined.set(chunk, offset); offset += chunk.byteLength; }
			assert.deepEqual(joined, body.state, "hook bytes = stored checkpoint bytes");
			assert.equal(sha256HexSync(body.state), body.stateSha256);
		}
		const replay = await bulk("hook-1", [{ bodyId: "k-1", path: "k/1.md", text: "k one\n" }, { bodyId: "k-2", path: "k/2.md", text: "k two\n" }]);
		assert.equal(replay.replayed, true);
		assert.equal(hookEvents.length, 1, "no hook call on a replay");
		hook.throws = true;
		const third = await bulk("hook-2", [{ bodyId: "k-3", path: "k/3.md", text: "k three\n" }]);
		assert.equal(third.outcomes[0]!.outcome, "created", "the receipt survives a failing hook");
		assert.equal(hookEvents.length, 2);
	});
});

s.test("exact Cloudflare rows on relay3 (lean + tail): 5 per note, 5 per batch", async () => {
	const measure = async (notes: number): Promise<{ cf: number; byTable: Record<string, number> }> => {
		const directory = await mkdtemp(join(tmpdir(), "yaos-relay3-bulk-rows-"));
		const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
		try {
			const model = new CfRowModel(sqlite);
			const storage = { sql: { exec: (query: string, ...bindings: unknown[]) => model.exec(query, ...bindings) },
				transactionSync: <T>(closure: () => T): T => sqlite.transactionSync(closure) } as unknown as VaultStoragePort;
			const store = new VaultStore(storage);
			store.enableLeanRows();
			store.enableRelayTail();
			const root = new Y.Doc({ guid: "root" });
			root.getMap("sys").set("schemaVersion", 8);
			root.getMap("sys").set("protocolVersion", 5);
			store.provisionVault(VAULT_ID, VAULT_GENERATION, Y.encodeStateAsUpdate(root), 1);
			root.destroy();
			store.installAuthorityFence({ changeId: "rows", vaultId: VAULT_ID, vaultGeneration: VAULT_GENERATION,
				subjectDigest: "rows-digest", subjects: [
					{ principalId: owner.principalId, role: owner.role, state: "active", membershipRevision: 1,
						policyVersion: 1, capabilityDigest: owner.capabilityDigest, displayName: "Owner", colorSeed: "owner" },
					{ deviceId: owner.deviceId, principalId: owner.principalId, state: "active", credentialRevision: 1 },
				] });
			const cache = new VaultDocumentCache(store, () => new Set<string>(), () => new Set<string>());
			const service = new VaultBulkCreateService({ store, cache,
				sockets: () => ({ broadcastDocumentUpdate: () => {} }) as unknown as VaultSocketService,
				vaultGeneration: () => VAULT_GENERATION, runtimeEpoch: RUNTIME, hasBlob: async () => false,
				flush: async () => true, validateActor: () => true });
			const post = async (batchId: string, count: number) => {
				const files = Array.from({ length: count }, (_v, i) => {
					const doc = new Y.Doc();
					doc.getText("body").insert(0, `# ${batchId} ${i}\n\n${"prose ".repeat(300)}\n`);
					const update = Y.encodeStateAsUpdate(doc);
					doc.destroy();
					return { operationId: `op-${batchId}-${i}`, bodyId: `body-${batchId}-${i}`, path: `${batchId}/${i}.md`, updates: [update] };
				});
				const response = await service.handle(new Request("https://internal/lifecycle/create-bulk", { method: "POST",
					body: encodeBinaryEnvelope({ batchId, rootEpoch: 1, files, attachments: [] }).slice().buffer }), owner, () => null);
				assert.equal(response.status, 200);
			};
			await post("warm", 1);
			model.reset();
			await post("m", notes);
			return { cf: model.totals.cf, byTable: Object.fromEntries(model.totals.byTable) };
		} finally {
			sqlite.close();
			await rm(directory, { recursive: true, force: true });
		}
	};
	const n100 = await measure(100);
	const n500 = await measure(500);
	const perNote = (n500.cf - n100.cf) / 400;
	const perBatch = n100.cf - 100 * perNote;
	console.log(`[relay3-bulk] rows: perNote ${perNote}, perBatch ${perBatch}; n100 by table ${JSON.stringify(n100.byTable)}`);
	assert.deepEqual({ perNote, perBatch }, { perNote: 5, perBatch: 5 });
});

await s.done();
