import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { BootstrapService } from "../../server/src/bootstrap";
import { suite } from "../harness.ts";

const s = suite("bootstrap-security");
const NOW = Date.parse("2026-08-27T00:00:00.000Z");

function makeBootstrapStore() {
	let operation: {
		operationId: string;
		kind: "bootstrap";
		boundarySequence: number;
		state: "running" | "complete" | "failed";
		artifactKey: string | null;
		artifactHash: string | null;
		createdAt: number;
		updatedAt: number;
		error: string | null;
		progressCursor: string | null;
	} | null = null;
	let begins = 0;
	let stages = 0;
	const pin = () => operation ? {
		pinId: operation.operationId,
		kind: "bootstrap" as const,
		boundarySequence: operation.boundarySequence,
		createdAt: NOW,
		softExpiresAt: NOW + 60_000,
		hardExpiresAt: NOW + 120_000,
		lastProgressAt: NOW,
		progress: 0,
	} : null;
	const store = {
		cleanupStuckPins: () => ({ released: 0, failedOperations: 0 }),
		getOperation: (id: string) => operation?.operationId === id ? operation : null,
		runningOperation: () => operation?.state === "running" ? operation : null,
		beginPinnedOperation: (input: { operationId?: string }) => {
			begins++;
			if (!operation) operation = {
				operationId: input.operationId ?? "generated-bootstrap",
				kind: "bootstrap",
				boundarySequence: 7,
				state: "running",
				artifactKey: null,
				artifactHash: null,
				createdAt: NOW,
				updatedAt: NOW,
				error: null,
				progressCursor: null,
			};
			return { operation, pin: pin()! };
		},
		reconstructDocument: () => {
			const doc = new Y.Doc({ guid: "root" });
			doc.getMap("sys").set("schemaVersion", 4);
			return { doc, generation: 3 };
		},
		getPin: () => pin(),
		stageOperationArtifact: (id: string, key: string, hash: string) => {
			if (!operation || operation.operationId !== id) throw new Error("unknown operation");
			stages++;
			operation = { ...operation, artifactKey: key, artifactHash: hash };
			return operation;
		},
		countActiveCatalogAt: () => 0,
		journalFloor: () => 2,
	};
	return { store, begins: () => begins, stages: () => stages };
}

s.test("bootstrap root is captured in SQLite without an R2 dependency", async () => {
	const fixture = makeBootstrapStore();
	const service = new BootstrapService(fixture.store as never, () => NOW);
	const descriptor = await service.start("bootstrap-device-0001");
	assert.equal(descriptor.schemaVersion, 4);
	assert.equal(descriptor.capture.vaultSequence, 7);
	assert.equal(descriptor.capture.rootGeneration, 3);
	assert.equal(descriptor.capture.rootCheckpointKey, "sql:root:7");
	assert.match(descriptor.capture.rootCheckpointHash, /^[a-f0-9]{64}$/);
	assert.equal(fixture.stages(), 1);
	const replay = await service.start("bootstrap-device-0001");
	assert.equal(replay.bootstrapId, descriptor.bootstrapId);
	assert.equal(replay.capture.rootCheckpointHash, descriptor.capture.rootCheckpointHash);
	assert.equal(replay.capture.rootCheckpointKey, "sql:root:7");
	assert.equal(fixture.stages(), 1, "idempotent start does not stage another root");
});

s.test("invalid and unknown bootstrap IDs allocate no SQL operation", async () => {
	const fixture = makeBootstrapStore();
	const service = new BootstrapService(fixture.store as never, () => NOW);
	await assert.rejects(() => service.start("../unsafe"), /invalid bootstrap attempt ID/);
	await assert.rejects(() => service.describe("unknown-bootstrap"), /bootstrap not found/);
	assert.equal(fixture.begins(), 0);
	assert.equal(fixture.stages(), 0);
});

await s.done();
