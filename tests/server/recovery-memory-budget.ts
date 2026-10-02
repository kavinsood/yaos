import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { encodeHashedRecoveryObject } from "../../server/src/recoveryCanonicalJson";
import { RecoveryJobRuntime } from "../../server/src/recoveryJob";
import { encodeRecoveryStateObject, MAX_RECOVERY_STATE_OBJECT_BYTES, RECOVERY_STATE_CONTENT_TYPE } from "../../server/src/shared/recoveryStateObject";
import { RecoveryJobStateStore } from "../../server/src/recoveryJobState";
import { recoveryContentObjectKey, recoveryV2Prefix } from "../../server/src/recoveryManifestTree";
import {
	RecoveryMemoryBudget,
	RecoveryMemoryOperationTooLargeError,
	RecoveryMemoryPressureError,
	reconstructionReservationBytes,
} from "../../server/src/recoveryMemoryBudget";
import { vaultGenerationPrefix } from "../../server/src/recoveryProtocol";
import { sha256Hex } from "../../server/src/hex";
import { FakeObjectStore } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("recovery-memory-budget");

s.test("memory leases enforce aggregate and single-operation ceilings", () => {
	const budget = new RecoveryMemoryBudget(100);
	const first = budget.reserve("capture:a", 60);
	assert.throws(() => budget.reserve("capture:b", 41), RecoveryMemoryPressureError);
	assert.throws(() => budget.reserve("capture:c", 101), RecoveryMemoryOperationTooLargeError);
	const second = budget.reserve("capture:b", 40);
	assert.deepEqual(budget.snapshot(), {
		ceilingBytes: 100,
		reservedBytes: 100,
		highWaterBytes: 100,
		denials: 2,
		owners: [{ owner: "capture:a", bytes: 60 }, { owner: "capture:b", bytes: 40 }],
	});
	first.release();
	first.release();
	second.release();
	assert.equal(budget.snapshot().reservedBytes, 0);
});

s.test("reconstruction reservation accounts for complete-state allocations", () => {
	assert.equal(reconstructionReservationBytes({
		expectedHistoryBytes: 10,
		stagingBytes: 0,
		bufferedPartBytes: 0,
		nextChunkBytes: 10,
		expectedContentBytes: 10,
	}), 8 * 1024 * 1024);
	assert.ok(reconstructionReservationBytes({
		expectedHistoryBytes: 20 * 1024 * 1024,
		stagingBytes: 10 * 1024 * 1024,
		bufferedPartBytes: 2 * 1024 * 1024,
		nextChunkBytes: 4 * 1024 * 1024,
		expectedContentBytes: 1024 * 1024,
	}) > 48 * 1024 * 1024);
	const saturated = reconstructionReservationBytes({
		expectedHistoryBytes: Number.MAX_SAFE_INTEGER,
		stagingBytes: Number.MAX_SAFE_INTEGER,
		bufferedPartBytes: Number.MAX_SAFE_INTEGER,
		nextChunkBytes: Number.MAX_SAFE_INTEGER,
		expectedContentBytes: Number.MAX_SAFE_INTEGER,
	});
	assert.equal(saturated, Number.MAX_SAFE_INTEGER);
	assert.throws(() => new RecoveryMemoryBudget().reserve("saturated", saturated), RecoveryMemoryOperationTooLargeError);
});

s.test("canonical recovery objects reject oversized output before publication", async () => {
	await assert.rejects(
		encodeHashedRecoveryObject(["x".repeat(1024)], { canonicalBytes: 100, compressedBytes: 100 }),
		/canonical byte bound/u,
	);
});

s.test("SQLite reconstruction stats do not materialize BLOB payloads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-recovery-stats-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	try {
		const store = new RecoveryJobStateStore(storage);
		store.putReconstructionParts([
			{ ordinal: 0, kind: "journal", sequence: 1, fragmentIndex: 0, fragmentCount: 1, bytes: new Uint8Array(17) },
			{ ordinal: 1, kind: "journal", sequence: 2, fragmentIndex: 0, fragmentCount: 1, bytes: new Uint8Array(23) },
		]);
		assert.deepEqual(store.reconstructionPartsStats(), { count: 2, bytes: 40 });
		assert.equal(store.reconstructionPartMetadata()[0]?.byteLength, 17);
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("Canvas restore serves the opaque state object bounded, with head-before-get", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-recovery-canvas-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	const bucket = new FakeObjectStore();
	const runtime = new RecoveryJobRuntime({
		storage,
		alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} },
		objectStore: bucket,
		recoveryAuthority: { call: async () => { throw new Error("unused"); } },
		controlPlane: { call: async () => { throw new Error("unused"); } },
	});
	type Harness = { store: RecoveryJobStateStore };
	try {
		const now = Date.now();
		await runtime.initializeRestore({
			vaultId: "vault-canvas-aa",
			vaultGeneration: "generation-canvas-aa",
			restoreId: "restore_canvas",
			snapshotId: "snapshot_canvas",
			selection: { kind: "all" },
			createdAt: now,
			capability: "capability",
			capabilityExpiresAt: now + 60_000,
		});
		const bytes = new TextEncoder().encode('{"edges":[],"nodes":[]}');
		const hash = await sha256Hex(bytes);
		const key = recoveryContentObjectKey(recoveryV2Prefix(vaultGenerationPrefix("vault-canvas-aa", "generation-canvas-aa")), hash);
		const object = encodeRecoveryStateObject({ kind: "canvas", contentHash: hash, size: bytes.byteLength, updates: [new Uint8Array([1, 2, 3])] });
		bucket.objects.set(key, object);
		(runtime as unknown as Harness).store.putRestoreItems([{
			itemId: "canvas-item",
			cursorOrder: 1,
			kind: "canvas",
			path: "Board.canvas",
			contentHash: hash,
			size: bytes.byteLength,
			outcome: null,
			errorCode: null,
			metadata: {},
		}]);
		const response = await runtime.getItemContent({ itemId: "canvas-item" });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), RECOVERY_STATE_CONTENT_TYPE);
		assert.equal(response.headers.get("x-yaos-content-sha256"), hash);
		assert.equal(response.headers.get("x-yaos-content-size"), String(bytes.byteLength));
		assert.deepEqual(new Uint8Array(await response.arrayBuffer()), object, "the server must serve the stored bytes without decoding");
		assert.deepEqual(bucket.heads, [key]);
		assert.deepEqual(bucket.gets, [key]);
		bucket.objects.set(key, new Uint8Array(MAX_RECOVERY_STATE_OBJECT_BYTES + 1));
		assert.equal((await runtime.getItemContent({ itemId: "canvas-item" })).status, 409);
		assert.equal(bucket.heads.length, 2, "oversized immutable object was not preflighted");
		assert.equal(bucket.gets.length, 1, "oversized immutable object was materialized before rejection");
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
