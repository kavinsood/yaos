import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeVaultDatabase } from "../../packages/cli/src/nodeVaultDatabase";
import type {
	StoredCanvasCandidate,
	StoredCanvasLifecycle,
	StoredCanvasSettlement,
} from "../../src/sync/vaultIndexedDb";
import { suite } from "../harness.ts";

const s = suite("node-canvas-lifecycle");

function binary(value: ArrayBuffer): number[] {
	return [...new Uint8Array(value)];
}

s.test("SQLite stores Canvas lifecycle payloads as BLOBs without JSON or base64", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-canvas-lifecycle-"));
	const path = join(directory, "vault.sqlite");
	const database = new NodeVaultDatabase(path);
	const encodedUpdate = new Uint8Array([0, 1, 2, 253, 254, 255]).buffer;
	const sourceBytes = new Uint8Array([9, 8, 7]).buffer;
	const semanticBytes = new Uint8Array([6, 5, 4, 3]).buffer;
	const promotion: StoredCanvasLifecycle = {
		operationId: "promote",
		requestDigest: "promote-digest",
		documentId: "canvas",
		bodyEpoch: 1,
		rootEpoch: 2,
		kind: "promote",
		path: "Board.canvas",
		sourceRevision: "revision",
		sourceHash: "a".repeat(64),
		sourceSize: sourceBytes.byteLength,
		contentHash: "b".repeat(64),
		contentSize: 10,
		candidateDigest: "c".repeat(64),
		encodedUpdate,
		sourceBytes,
		createdAt: 1,
		attempts: 0,
		lastAttemptAt: null,
	};
	const demotion: StoredCanvasLifecycle = {
		operationId: "demote",
		requestDigest: "demote-digest",
		documentId: "canvas",
		bodyEpoch: 3,
		rootEpoch: 4,
		kind: "demote",
		path: "Board.canvas",
		expectedGeneration: 4,
		expectedContentHash: "d".repeat(64),
		expectedSize: semanticBytes.byteLength,
		blobHash: "e".repeat(64),
		blobSize: semanticBytes.byteLength,
		mime: "application/json",
		semanticBytes,
		createdAt: 2,
		attempts: 0,
		lastAttemptAt: null,
	};
	try {
		await database.putCanvasLifecycle(promotion);
		await database.putCanvasLifecycle(demotion);
		new Uint8Array(encodedUpdate).fill(42);
		new Uint8Array(sourceBytes).fill(42);
		new Uint8Array(semanticBytes).fill(42);

		const stored = await database.listCanvasLifecycle();
		const restoredPromotion = stored.find((value) => value.kind === "promote");
		const restoredDemotion = stored.find((value) => value.kind === "demote");
		assert.equal(restoredPromotion?.kind, "promote");
		assert.equal(restoredDemotion?.kind, "demote");
		if (!restoredPromotion || restoredPromotion.kind !== "promote"
			|| !restoredDemotion || restoredDemotion.kind !== "demote") return;
		assert.deepEqual([restoredPromotion.bodyEpoch, restoredPromotion.rootEpoch], [1, 2]);
		assert.deepEqual([restoredDemotion.bodyEpoch, restoredDemotion.rootEpoch], [3, 4]);
		assert.deepEqual(binary(restoredPromotion.encodedUpdate), [0, 1, 2, 253, 254, 255]);
		assert.deepEqual(binary(restoredPromotion.sourceBytes), [9, 8, 7]);
		assert.deepEqual(binary(restoredDemotion.semanticBytes), [6, 5, 4, 3]);
		await database.close();

		const sqlite = new DatabaseSync(path);
		try {
			const rows = sqlite.prepare(`SELECT operation_id,
				typeof(encoded_update) AS encoded_type,
				typeof(source_bytes) AS source_type,
				typeof(semantic_bytes) AS semantic_type,
				value_json FROM canvas_lifecycle ORDER BY operation_id`).all() as Array<Record<string, unknown>>;
			assert.deepEqual(rows.map((row) => [row.operation_id, row.encoded_type, row.source_type, row.semantic_type]), [
				["demote", "null", "null", "blob"],
				["promote", "blob", "blob", "null"],
			]);
			for (const row of rows) {
				assert.equal(String(row.value_json).includes("Base64"), false);
				assert.equal(String(row.value_json).includes("encodedUpdate"), false);
				assert.equal(String(row.value_json).includes("sourceBytes"), false);
				assert.equal(String(row.value_json).includes("semanticBytes"), false);
			}
		} finally {
			sqlite.close();
		}

		const restarted = new NodeVaultDatabase(path);
		try {
			const afterRestart = await restarted.listCanvasLifecycle();
			assert.equal(afterRestart.length, 2);
		} finally {
			await restarted.close();
		}
	} finally {
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

s.test("SQLite replaces a Canvas semantic epoch, settlement, candidates, and lifecycle atomically", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-canvas-epoch-"));
	const path = join(directory, "vault.sqlite");
	const database = new NodeVaultDatabase(path);
	const candidate = (candidateId: string, documentId: string, bodyEpoch: number): StoredCanvasCandidate => ({
		candidateId,
		documentId,
		bodyEpoch,
		candidateDigest: candidateId.padEnd(64, "d"),
		encodedUpdate: new Uint8Array([bodyEpoch, candidateId.length]).buffer,
		capturedAt: bodyEpoch,
		attempts: 0,
		lastAttemptAt: null,
	});
	const settlement = (bodyEpoch: number): StoredCanvasSettlement => ({
		format: 1,
		documentId: "canvas-reset",
		bodyEpoch,
		vaultGeneration: "generation",
		canonicalContent: new Uint8Array([bodyEpoch, 10, 20]).buffer,
		contentHash: "a".repeat(64),
		durableGeneration: 4,
		serverContentHash: "a".repeat(64),
		diskFingerprint: { bytes: 3, hash: "b".repeat(64) },
		pathAtSettlement: "Reset.canvas",
		localSettlementRevision: bodyEpoch,
		settledAt: bodyEpoch,
	});
	try {
		await database.putDocument({
			kind: "semantic",
			documentId: "canvas-reset",
			bodyEpoch: 1,
			generation: 3,
			encodedState: new Uint8Array([1]).buffer,
			dirty: true,
			updatedAt: 1,
		});
		await database.putCanvasSettlement(settlement(1), null);
		await database.putCanvasCandidate(candidate("old-a", "canvas-reset", 1));
		await database.putCanvasCandidate(candidate("old-b", "canvas-reset", 1));
		await database.putCanvasCandidate(candidate("other", "other-canvas", 1));
		const carriedLifecycle: StoredCanvasLifecycle = {
			operationId: "carried-delete", requestDigest: "digest", documentId: "canvas-reset",
			bodyEpoch: 2, rootEpoch: 1, kind: "delete", createdAt: 3, attempts: 1, lastAttemptAt: 2,
		};
		await database.putCanvasLifecycle(carriedLifecycle);
		await database.putCanvasLifecycle({
			...carriedLifecycle, operationId: "discarded-old", kind: "revive", path: "Reset.canvas",
		});
		await database.putCanvasLifecycle({
			...carriedLifecycle, operationId: "other-lifecycle", documentId: "other-canvas",
		});

		const freshCandidate = candidate("fresh", "canvas-reset", 2);
		await database.replaceCanvasSemanticEpoch({
			document: {
				kind: "semantic",
				documentId: "canvas-reset",
				bodyEpoch: 2,
				generation: 4,
				encodedState: new Uint8Array([2, 2, 2]).buffer,
				dirty: true,
				pendingLocalUpdates: 1,
				updatedAt: 2,
			},
			settlement: settlement(2),
			candidate: freshCandidate,
			lifecycle: [carriedLifecycle],
		});

		const document = await database.getDocument("canvas-reset");
		assert.equal(document?.kind, "semantic");
		if (!document || document.kind !== "semantic") return;
		assert.equal(document.bodyEpoch, 2);
		assert.deepEqual(binary(document.encodedState), [2, 2, 2]);
		assert.equal((await database.getCanvasSettlement("canvas-reset"))?.bodyEpoch, 2);
		assert.deepEqual((await database.listCanvasCandidates()).map((value) => value.candidateId), ["other", "fresh"],
			"old-lineage candidates are retired while another Canvas remains untouched");
		assert.deepEqual((await database.listCanvasLifecycle()).map((value) => value.operationId),
			["carried-delete", "other-lifecycle"],
			"selected lifecycle intent survives while superseded target rows are replaced atomically");

		await assert.rejects(database.replaceCanvasSemanticEpoch({
			document,
			settlement: { ...settlement(2), bodyEpoch: 3 },
			candidate: null,
			lifecycle: [],
		}), /identity mismatch/);
		assert.equal((await database.getDocument("canvas-reset"))?.kind, "semantic",
			"rejected replacement leaves the installed lineage intact");
		await database.close();

		const restarted = new NodeVaultDatabase(path);
		try {
			const restored = await restarted.getDocument("canvas-reset");
			assert.equal(restored?.kind, "semantic");
			if (restored?.kind === "semantic") assert.equal(restored.bodyEpoch, 2);
			assert.equal((await restarted.getCanvasSettlement("canvas-reset"))?.bodyEpoch, 2);
			assert.deepEqual((await restarted.listCanvasCandidates()).map((value) => value.candidateId), ["other", "fresh"]);
			assert.deepEqual((await restarted.listCanvasLifecycle()).map((value) => value.operationId),
				["carried-delete", "other-lifecycle"]);
		} finally {
			await restarted.close();
		}
	} finally {
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
