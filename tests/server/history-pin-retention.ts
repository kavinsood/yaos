import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import {
	assertHistoryPinAdmission,
	MAX_ACTIVE_HISTORY_PINS,
	MAX_HISTORY_PIN_HARD_TTL_MS,
	VaultStore,
} from "../../server/src/vaultStore";
import { suite } from "../harness.ts";

const s = suite("history-pin-retention");

class LimitedPinVaultStore extends VaultStore {
	constructor(sqlite: NodeSqliteStorage, private readonly retainedCheckpointLimit: number) {
		super(sqlite);
	}

	protected override historyPinRetainedCheckpointByteLimit(): number {
		return this.retainedCheckpointLimit;
	}
}

async function withStore(check: (store: VaultStore, sqlite: NodeSqliteStorage) => void | Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-history-pins-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	try {
		await check(new VaultStore(sqlite), sqlite);
	} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
}

function update(doc: Y.Doc, mutation: () => void): Uint8Array {
	const vector = Y.encodeStateVector(doc);
	mutation();
	return Y.encodeStateAsUpdate(doc, vector);
}

function freshTextDocument(documentId: string, text: string): Y.Doc {
	const doc = new Y.Doc({ guid: documentId });
	doc.getText("body").insert(0, text);
	return doc;
}

function semanticReset(store: VaultStore, documentId: string, doc: Y.Doc, now: number): number {
	const head = store.documentHead(documentId)!;
	return store.semanticResetFromEncodedState(documentId, Y.encodeStateAsUpdate(doc), {
		throughSequence: head.latestSequence,
		generation: head.generation,
		semanticEpoch: head.semanticEpoch,
	}, now).vaultSequence;
}

function retainedSequences(sqlite: NodeSqliteStorage, table: "vault_journal" | "vault_checkpoints", documentId: string): number[] {
	const column = table === "vault_journal" ? "sequence" : "checkpoint_sequence";
	return sqlite.sql.exec<{ sequence: number }>(
		`SELECT DISTINCT ${column} AS sequence FROM ${table} WHERE document_id = ? ORDER BY ${column}`,
		documentId,
	).toArray().map((row) => row.sequence);
}

s.test("admission limits count, maximum lifetime, and retained bytes independently", () => {
	const limits = { maxActivePins: 2, maxHardTtlMs: 100, maxRetainedCheckpointBytes: 1_000 };
	assert.doesNotThrow(() => assertHistoryPinAdmission({
		activePins: 1, retainedCheckpointBytes: 1_000, requestedHardTtlMs: 100,
	}, limits));
	assert.throws(() => assertHistoryPinAdmission({
		activePins: 2, retainedCheckpointBytes: 0, requestedHardTtlMs: 1,
	}, limits), /history_pin_count_limit/);
	assert.throws(() => assertHistoryPinAdmission({
		activePins: 0, retainedCheckpointBytes: 1_001, requestedHardTtlMs: 1,
	}, limits), /history_pin_retained_checkpoint_bytes_limit/);
	assert.throws(() => assertHistoryPinAdmission({
		activePins: 0, retainedCheckpointBytes: 0, requestedHardTtlMs: 101,
	}, limits), /history_pin_hard_ttl_limit/);
});

s.test("pins have durable typed owners and active count is bounded", async () => {
	await withStore((store) => {
		const now = 1_000;
		for (let index = 0; index < MAX_ACTIVE_HISTORY_PINS; index++) {
			const pin = store.createPin({
				kind: index % 2 === 0 ? "capture" : "bootstrap",
				pinId: `owner-${index}`,
				now,
			});
			assert.deepEqual(pin.owner, { kind: pin.kind, id: pin.pinId });
		}
		assert.throws(() => store.createPin({ kind: "capture", pinId: "one-too-many", now }), /history_pin_count_limit/);
		assert.throws(() => store.createPin({
			kind: "capture", pinId: "too-old", now, softTtlMs: 1, hardTtlMs: MAX_HISTORY_PIN_HARD_TTL_MS + 1,
		}), /history_pin_hard_ttl_limit/);
	});
});

s.test("soft expiry reaps crash-stale pins and fails their operation", async () => {
	await withStore((store) => {
		store.beginPinnedOperation({
			operationId: "stale-bootstrap", kind: "bootstrap", now: 100, softTtlMs: 10, hardTtlMs: 20,
		});
		assert.equal(store.activePins(109).length, 1);
		assert.throws(() => store.renewPin("stale-bootstrap", 1, 10, 110), /pin expired/);
		const cleanup = store.cleanupStuckPins(110);
		assert.deepEqual(cleanup, { released: 1, failedOperations: 1, failedCaptures: 0 });
		assert.equal(store.getPin("stale-bootstrap"), null);
		assert.equal(store.getOperation("stale-bootstrap")?.state, "failed");
	});
});

s.test("crash-stale capture expiry also revokes capture authority", async () => {
	await withStore((store) => {
		const root = new Y.Doc({ guid: "root" });
		try {
			root.getMap("sys").set("schemaVersion", 7);
			store.provisionVault("pin-test-vault", "pin-test-generation", Y.encodeStateAsUpdate(root), 50);
			store.createRecoveryCapture({
				captureId: "stale-capture",
				requestId: "stale-capture-request",
				vaultId: "pin-test-vault",
				vaultGeneration: "pin-test-generation",
				boundarySequence: store.currentSequence(),
				rootGeneration: store.documentHead("root")!.generation,
				runtimeEpoch: "runtime-1",
				reason: "manual",
				jobId: "capture:pin-test-vault:pin-test-generation:stale-capture",
				capabilityHash: "a".repeat(64),
				capabilityExpiresAt: 120,
				softExpiresAt: 110,
				hardExpiresAt: 120,
				now: 100,
			});
			const cleanup = store.cleanupStuckPins(110);
			assert.equal(cleanup.failedCaptures, 1);
			assert.equal(store.getPin("stale-capture"), null);
			assert.equal(store.recoveryCapture("stale-capture")?.state, "failed");
		} finally {
			root.destroy();
		}
	});
});

s.test("health attributes checkpoint retention and release prunes immediately", async () => {
	await withStore((store, sqlite) => {
		const doc = new Y.Doc({ guid: "retention-body" });
		try {
			const sequences: number[] = [];
			for (let index = 0; index < 5; index++) {
				store.commitUpdate({
					documentId: "retention-body",
					kind: "body",
					update: update(doc, () => doc.getText("body").insert(doc.getText("body").length, "x".repeat(100 + index))),
				});
				sequences.push(store.currentSequence());
				if (index === 0) store.createPin({ kind: "capture", pinId: "diagnostic-capture", boundarySequence: sequences[0] });
				store.writeCheckpoint("retention-body", sequences[index]!);
			}

			const health = store.historyPinHealth();
			assert.equal(health.active, 1);
			assert.equal(health.pins[0]?.ownerId, "diagnostic-capture");
			assert.ok(health.pins[0]!.retainedCheckpointBytes > 0);
			assert.equal(health.retainedCheckpointBytes, health.pins[0]!.retainedCheckpointBytes);
			let retained = sqlite.sql.exec<{ checkpoint_sequence: number }>(
				"SELECT DISTINCT checkpoint_sequence FROM vault_checkpoints WHERE document_id = ? ORDER BY checkpoint_sequence",
				"retention-body",
			).toArray().map((row) => row.checkpoint_sequence);
			assert.deepEqual(retained, [sequences[0], ...sequences.slice(-3)]);

			assert.equal(store.releasePin("diagnostic-capture"), true);
			retained = sqlite.sql.exec<{ checkpoint_sequence: number }>(
				"SELECT DISTINCT checkpoint_sequence FROM vault_checkpoints WHERE document_id = ? ORDER BY checkpoint_sequence",
				"retention-body",
			).toArray().map((row) => row.checkpoint_sequence);
			assert.deepEqual(retained, sequences.slice(-3));
		} finally {
			doc.destroy();
		}
	});
});

s.test("repeated semantic resets retain exact pinned recipes, then release retires each lineage", async () => {
	await withStore((store, sqlite) => {
		const documentId = "reset-retention-body";
		let live = freshTextDocument(documentId, "a");
		try {
			store.commitUpdate({ documentId, kind: "body", update: Y.encodeStateAsUpdate(live) });
			const first = store.currentSequence();
			store.writeCheckpoint(documentId, first);
			store.commitUpdate({
				documentId, kind: "body",
				update: update(live, () => live.getText("body").insert(live.getText("body").length, "b")),
			});
			const firstBoundary = store.currentSequence();
			store.createPin({ kind: "capture", pinId: "first-lineage", boundarySequence: firstBoundary,
				now: 100, softTtlMs: 1_000, hardTtlMs: 2_000 });
			store.commitUpdate({
				documentId, kind: "body",
				update: update(live, () => live.getText("body").insert(live.getText("body").length, "discarded")),
			});

			live.destroy();
			live = freshTextDocument(documentId, "ab-current");
			const firstReset = semanticReset(store, documentId, live, 110);
			assert.deepEqual(retainedSequences(sqlite, "vault_journal", documentId), [firstBoundary, firstReset],
				"only the old journal row needed by the first pin and the reset marker survive");
			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [first, firstReset]);
			const firstHistorical = store.reconstructDocument(documentId, firstBoundary);
			assert.equal(crdtEngine.readText(firstHistorical.doc, "body"), "ab");
			crdtEngine.destroyDocument(firstHistorical.doc);

			store.commitUpdate({
				documentId, kind: "body",
				update: update(live, () => live.getText("body").insert(live.getText("body").length, "+epoch-two")),
			});
			const secondBoundary = store.currentSequence();
			store.createPin({ kind: "bootstrap", pinId: "second-lineage", boundarySequence: secondBoundary,
				now: 120, softTtlMs: 1_000, hardTtlMs: 2_000 });
			live.destroy();
			live = freshTextDocument(documentId, "epoch-three");
			const secondReset = semanticReset(store, documentId, live, 130);

			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [first, firstReset, secondReset]);
			const secondHistorical = store.reconstructDocument(documentId, secondBoundary);
			assert.equal(crdtEngine.readText(secondHistorical.doc, "body"), "ab-current+epoch-two");
			crdtEngine.destroyDocument(secondHistorical.doc);

			assert.equal(store.releasePin("first-lineage", 140), true);
			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [firstReset, secondReset]);
			assert.equal(store.releasePin("second-lineage", 150), true);
			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [secondReset]);
			assert.deepEqual(retainedSequences(sqlite, "vault_journal", documentId), [secondReset]);
		} finally {
			live.destroy();
		}
	});
});

s.test("capture completion and expiry release reset history through the pruning path", async () => {
	await withStore((store, sqlite) => {
		const documentId = "capture-reset-retention";
		const root = new Y.Doc({ guid: "root" });
		let live = freshTextDocument(documentId, "old");
		try {
			root.getMap("sys").set("schemaVersion", 7);
			store.provisionVault("capture-retention-vault", "capture-retention-generation", Y.encodeStateAsUpdate(root), 190);
			store.commitUpdate({ documentId, kind: "body", update: Y.encodeStateAsUpdate(live) });
			const boundary = store.currentSequence();
			store.writeCheckpoint(documentId, boundary);
			store.createRecoveryCapture({
				captureId: "completed-capture", requestId: "completed-capture-request",
				vaultId: "capture-retention-vault", vaultGeneration: "capture-retention-generation",
				boundarySequence: boundary, rootGeneration: store.documentHead("root")!.generation,
				runtimeEpoch: "runtime-1", reason: "manual",
				jobId: "capture:capture-retention-vault:capture-retention-generation:completed-capture",
				capabilityHash: "b".repeat(64), capabilityExpiresAt: 400,
				softExpiresAt: 300, hardExpiresAt: 400, now: 200,
			});
			live.destroy();
			live = freshTextDocument(documentId, "new");
			const reset = semanticReset(store, documentId, live, 210);
			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [boundary, reset]);
			store.setRecoveryCaptureState("completed-capture", "complete", null, 220);
			assert.equal(store.getPin("completed-capture"), null,
				"capture completion atomically releases its owned history pin");
			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [reset]);

			store.createRecoveryCapture({
				captureId: "expired-capture", requestId: "expired-capture-request",
				vaultId: "capture-retention-vault", vaultGeneration: "capture-retention-generation",
				boundarySequence: reset, rootGeneration: store.documentHead("root")!.generation,
				runtimeEpoch: "runtime-1", reason: "manual",
				jobId: "capture:capture-retention-vault:capture-retention-generation:expired-capture",
				capabilityHash: "c".repeat(64), capabilityExpiresAt: 250,
				softExpiresAt: 240, hardExpiresAt: 250, now: 230,
			});
			live.destroy();
			live = freshTextDocument(documentId, "newer");
			const nextReset = semanticReset(store, documentId, live, 235);
			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [reset, nextReset]);
			assert.deepEqual(store.reapExpiredRecoveryCaptures(240), ["expired-capture"]);
			assert.equal(store.recoveryCapture("expired-capture")?.state, "failed");
			assert.deepEqual(retainedSequences(sqlite, "vault_checkpoints", documentId), [nextReset]);
		} finally {
			root.destroy();
			live.destroy();
		}
	});
});

s.test("post-admission checkpoint growth is transactionally capped across documents without breaking pinned recovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-history-pin-growth-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "vault.sqlite"));
	const retainedCheckpointLimit = 1_024;
	const store = new LimitedPinVaultStore(sqlite, retainedCheckpointLimit);
	const first = freshTextDocument("growth-first", "a".repeat(700));
	const second = freshTextDocument("growth-second", "b".repeat(700));
	const third = freshTextDocument("growth-third", "c".repeat(700));
	try {
		store.commitUpdate({ documentId: first.guid, kind: "body", update: Y.encodeStateAsUpdate(first) });
		store.commitUpdate({ documentId: second.guid, kind: "body", update: Y.encodeStateAsUpdate(second) });
		store.commitUpdate({ documentId: third.guid, kind: "body", update: Y.encodeStateAsUpdate(third) });
		const boundary = store.currentSequence();
		const pin = store.createPin({ kind: "capture", pinId: "post-admission-growth", boundarySequence: boundary });

		const firstCheckpoint = store.writeCheckpoint(first.guid, boundary);
		assert.ok(firstCheckpoint.totalBytes < retainedCheckpointLimit, "first checkpoint must fit the test cap");
		assert.ok(firstCheckpoint.totalBytes * 2 > retainedCheckpointLimit,
			"two comparable checkpoints must cross the test cap");

		assert.throws(() => store.writeCheckpoint(second.guid, boundary),
			/history_pin_retained_checkpoint_bytes_limit/,
			"normal reconstruction checkpoint must fail closed when it would grow pinned retention past the cap");
		const thirdHead = store.documentHead(third.guid)!;
		const liveThird = crdtEngine.openDocument(third.guid, Y.encodeStateAsUpdate(third));
		try {
			assert.throws(() => store.writeCheckpointFromDocument(third.guid, liveThird, {
				throughSequence: thirdHead.latestSequence,
				generation: thirdHead.generation,
				semanticEpoch: thirdHead.semanticEpoch,
			}), /history_pin_retained_checkpoint_bytes_limit/,
			"the live checkpoint path used by bulk /compact must enforce the same cap");
		} finally { crdtEngine.destroyDocument(liveThird); }

		for (const documentId of [second.guid, third.guid]) {
			assert.equal(sqlite.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_checkpoints WHERE document_id = ?", documentId,
			).one().count, 0, "rejected checkpoint chunks must roll back");
			assert.equal(sqlite.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_checkpoint_manifests WHERE document_id = ?", documentId,
			).one().count, 0, "rejected checkpoint manifest must roll back");
			assert.equal(sqlite.sql.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM vault_journal WHERE document_id = ?", documentId,
			).one().count, 1, "rejected checkpoint must preserve its reconstruction journal");
		}
		assert.equal(store.historyPinHealth().retainedCheckpointBytes, firstCheckpoint.totalBytes);
		assert.equal(store.historyPinHealth().limits.maxRetainedCheckpointBytes, retainedCheckpointLimit);

		const freshSecond = freshTextDocument(second.guid, "fresh-b");
		try {
			const resetSequence = semanticReset(store, second.guid, freshSecond, Date.now());
			assert.ok(resetSequence > boundary, "semantic reset checkpoint must be newer than the pinned boundary");
			assert.equal(store.historyPinHealth().retainedCheckpointBytes, firstCheckpoint.totalBytes,
				"a new-epoch checkpoint beyond the pin boundary must not consume pinned-retention capacity");
		} finally {
			freshSecond.destroy();
		}

		const pinnedSecond = store.reconstructDocument(second.guid, boundary);
		try {
			assert.equal(crdtEngine.readText(pinnedSecond.doc, "body"), "b".repeat(700),
				"failed checkpoint writes and later semantic reset must preserve the pinned recipe");
		} finally {
			crdtEngine.destroyDocument(pinnedSecond.doc);
		}
		const currentSecond = store.reconstructDocument(second.guid);
		try { assert.equal(crdtEngine.readText(currentSecond.doc, "body"), "fresh-b"); }
		finally { crdtEngine.destroyDocument(currentSecond.doc); }
		assert.equal(store.releasePin(pin.pinId), true);
	} finally {
		first.destroy();
		second.destroy();
		third.destroy();
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
