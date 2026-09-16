import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { ywasmCrdtEngine as crdtEngine } from "../../packages/server-node/src/ywasmNodeCrdtEngine";
import {
	materializeCanvasDocument as materializeProductionCanvas,
	validateCanvasDocument as validateProductionCanvas,
} from "../../server/src/crdt/canvasSemanticDocument";
import { applyCompleteRecoveryRecipeParts, applyStoredRecoveryRecipeParts, createRecoveryDocument } from "../../server/src/recoveryJob";
import {
	RecoveryJobStateStore,
	type RecoveryJobStoragePort,
	type ReconstructionPart,
	type ReconstructionProgress,
} from "../../server/src/recoveryJobState";
import { SQLITE_ROW_SAFE_BYTES } from "../../server/src/shared/durableLimits";
import { SQLITE_BLOB_CHUNK_BYTES } from "../../server/src/vaultDocumentStore";
import { canonicalCanvasBytes, parseCanvasBytes } from "../../server/src/shared/canvasCodec";
import { createCanvasDocument } from "../../server/src/shared/canvasSemanticDocument";
import { suite } from "../harness.ts";

const s = suite("recovery-fragmentation");

function splitCheckpoint(update: Uint8Array): ReconstructionPart[] {
	const parts: ReconstructionPart[] = [];
	const fragmentCount = Math.ceil(update.byteLength / SQLITE_BLOB_CHUNK_BYTES);
	for (let offset = 0; offset < update.byteLength; offset += SQLITE_BLOB_CHUNK_BYTES) {
		const fragmentIndex = parts.length;
		parts.push({
			ordinal: fragmentIndex,
			kind: "checkpoint",
			sequence: 42,
			fragmentIndex,
			fragmentCount,
			bytes: update.slice(offset, Math.min(update.byteLength, offset + SQLITE_BLOB_CHUNK_BYTES)),
		});
	}
	return parts;
}

function journalPart(ordinal: number, byte = ordinal % 251): ReconstructionPart {
	return {
		ordinal,
		kind: "journal",
		sequence: ordinal + 1,
		fragmentIndex: 0,
		fragmentCount: 1,
		bytes: Uint8Array.of(byte),
	};
}

s.test("reconstruction parts use bounded batch SQL and conflicting replay is atomic", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-recovery-part-batch-"));
	const sqlite = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	const queries = { value: 0 };
	const storage = {
		sql: {
			exec(query: string, ...bindings: unknown[]) {
				queries.value++;
				return sqlite.sql.exec(query, ...bindings);
			},
		},
		transactionSync<T>(closure: () => T): T {
			return sqlite.transactionSync(closure);
		},
	} as unknown as RecoveryJobStoragePort;
	try {
		const store = new RecoveryJobStateStore(storage);
		store.initializeSchema();
		const parts = Array.from({ length: 80 }, (_, ordinal) => journalPart(ordinal));

		queries.value = 0;
		store.putReconstructionParts(parts);
		assert.equal(queries.value, 86, "80 parts should use five inserts, one-row replay verification, and aggregate stats");

		queries.value = 0;
		store.putReconstructionParts(parts);
		assert.equal(queries.value, 86, "identical replay should retain bounded one-row verification");

		const newParts = Array.from({ length: 16 }, (_, index) => journalPart(80 + index));
		const changedReplay = journalPart(0, 252);
		queries.value = 0;
		assert.throws(
			() => store.putReconstructionParts([...newParts, changedReplay]),
			/reconstruction part replay changed/u,
		);
		assert.equal(queries.value, 19, "conflict detection should stop before aggregate stats and never read a batch of BLOB payloads");
		assert.deepEqual(
			store.reconstructionParts().map((part) => part.ordinal),
			parts.map((part) => part.ordinal),
			"a later replay conflict must roll back earlier batches",
		);

		assert.throws(
			() => store.putReconstructionParts([journalPart(100), journalPart(100)]),
			/duplicate reconstruction part ordinal/u,
		);
			assert.throws(
				() => store.putReconstructionParts(Array.from({ length: 257 }, (_, ordinal) => journalPart(ordinal + 1_000))),
				/too many reconstruction parts/u,
			);
			const oversized = {
				...journalPart(10_000),
				bytes: new Uint8Array(SQLITE_ROW_SAFE_BYTES + 1),
			};
			assert.throws(
				() => store.putReconstructionParts([journalPart(101), oversized]),
				/SQLite row safety limit/u,
			);
			assert.deepEqual(
				store.reconstructionParts().map((part) => part.ordinal),
				parts.map((part) => part.ordinal),
				"oversized input must fail validation before any partial row is written",
			);
		} finally {
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test(">4 MiB checkpoint fragments survive slices and apply only when complete", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-recovery-fragments-"));
	const storage = NodeSqliteStorage.open(join(directory, "state.sqlite"));
	const source = new Y.Doc({ guid: "large-checkpoint-source" });
	const target = createRecoveryDocument("large-checkpoint-target");
	try {
		source.getText("body").insert(0, "x".repeat(4 * 1024 * 1024 + 400_000));
		const update = Y.encodeStateAsUpdate(source);
		assert.ok(update.byteLength > 4 * 1024 * 1024, "fixture did not exceed the old recipe response boundary");
		const fragments = splitCheckpoint(update);
		assert.ok(fragments.length >= 3);
		assert.equal(fragments.reduce((total, part) => total + part.bytes.byteLength, 0), update.byteLength);
		assert.ok(fragments.every((part) => part.bytes.byteLength <= SQLITE_BLOB_CHUNK_BYTES));

		const progress: ReconstructionProgress = {
			bodyId: "large-body",
			generation: 7,
			recipeId: "large-recipe",
			expectedContentHash: "a".repeat(64),
			expectedSize: 4 * 1024 * 1024 + 400_000,
			cursor: "slice-2",
			stagingKey: null,
			stagingHash: null,
			stagingBytes: 0,
			expectedHistoryBytes: update.byteLength,
			encodedBytes: fragments[0]!.bytes.byteLength + fragments[1]!.bytes.byteLength,
			attempts: 0,
		};
		const firstSlice = new RecoveryJobStateStore(storage);
		firstSlice.setReconstruction(progress);
		firstSlice.putReconstructionParts(fragments.slice(0, 2));
		fragments[0]!.bytes.fill(0); // persisted BLOB must own its bytes across the slice boundary

		const resumedSlice = new RecoveryJobStateStore(storage);
		assert.deepEqual(resumedSlice.getReconstruction(), progress);
		const partial = resumedSlice.reconstructionParts();
		assert.equal(partial.length, 2);
		assert.notEqual(partial[0]!.bytes[0], 0, "reconstruction BLOB aliased the caller's buffer");
		const storedRows = storage.sql.exec<{ storage_type: string; stored_bytes: number }>(
			"SELECT typeof(data) AS storage_type, length(data) AS stored_bytes FROM reconstruction_parts ORDER BY ordinal",
		).toArray();
		assert.ok(storedRows.every((row) => row.storage_type === "blob" && row.stored_bytes <= SQLITE_BLOB_CHUNK_BYTES));

		assert.equal(applyCompleteRecoveryRecipeParts(target, partial), false);
		assert.equal(crdtEngine.readText(target, "body").length, 0, "partial checkpoint mutated the reconstruction document");

		resumedSlice.putReconstructionParts(partial); // retrying an identical slice is idempotent
		const changedReplay = { ...partial[0]!, bytes: partial[0]!.bytes.slice() };
		changedReplay.bytes[0] = changedReplay.bytes[0]! ^ 1;
		assert.throws(() => resumedSlice.putReconstructionParts([changedReplay]), /reconstruction part replay changed/u);
		resumedSlice.putReconstructionParts(fragments.slice(2));
		const complete = resumedSlice.reconstructionParts();
		assert.equal(applyStoredRecoveryRecipeParts(target, resumedSlice), true);
		assert.equal(crdtEngine.readText(target, "body"), source.getText("body").toString());

		resumedSlice.clearReconstruction();
		assert.equal(resumedSlice.getReconstruction(), null);
		assert.deepEqual(resumedSlice.reconstructionParts(), []);
	} finally {
		source.destroy();
		crdtEngine.destroyDocument(target);
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("recovery Canvas reader preserves canonical data across the ywasm boundary", async () => {
	const input = new TextEncoder().encode(JSON.stringify({
		nodes: [{ id: "node-中文-😀", type: "text", text: "hello 世界 👩🏽‍💻", x: 1, y: 2, width: 300, height: 120 }],
		edges: [],
		background: "#123456",
	}));
	const parsed = parseCanvasBytes(input);
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") return;
	const source = createCanvasDocument(parsed.data);
	const target = crdtEngine.openDocument("recovery-canvas", Y.encodeStateAsUpdate(source));
	try {
		const validation = await validateProductionCanvas(target);
		assert.equal(validation.error, null);
		if (validation.error !== null) return;
		assert.deepEqual(validation.canonicalBytes, parsed.canonicalBytes);
		const materialized = await materializeProductionCanvas(target, false);
		assert.deepEqual(canonicalCanvasBytes(materialized), parsed.canonicalBytes);
	} finally {
		crdtEngine.destroyDocument(target);
		source.destroy();
	}
});

await s.done();
