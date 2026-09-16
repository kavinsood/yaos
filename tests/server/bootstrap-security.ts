import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "../../packages/server-node/src/ywasmNodeCrdtEngine";
import type { YwasmCrdtDocument } from "../../server/src/crdt/ywasmCrdtEngine";
import { BootstrapService } from "../../server/src/bootstrap";
import { SCHEMA_VERSION } from "../../server/src/shared/productVersions";
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
			const source = new Y.Doc({ guid: "root" });
			source.getMap("sys").set("schemaVersion", SCHEMA_VERSION);
			const doc = crdtEngine.openDocument("root", Y.encodeStateAsUpdate(source));
			source.destroy();
			return { doc, generation: 3, semanticEpoch: 4 };
		},
		getPin: () => pin(),
		stageOperationArtifact: (id: string, key: string, hash: string) => {
			if (!operation || operation.operationId !== id) throw new Error("unknown operation");
			stages++;
			operation = { ...operation, artifactKey: key, artifactHash: hash };
			return operation;
		},
		countActiveCatalogAt: () => 0,
		countActiveSemanticAt: () => 0,
		journalFloor: () => 2,
	};
	return { store, begins: () => begins, stages: () => stages };
}

s.test("bootstrap root is captured in SQLite without an R2 dependency", async () => {
	const fixture = makeBootstrapStore();
	const service = new BootstrapService(fixture.store as never, () => NOW);
	const descriptor = await service.start("bootstrap-device-0001");
	assert.equal(descriptor.schemaVersion, SCHEMA_VERSION);
	assert.equal(descriptor.capture.vaultSequence, 7);
	assert.equal(descriptor.capture.rootGeneration, 3);
	assert.equal(descriptor.capture.rootEpoch, 4);
	assert.equal(descriptor.capture.rootCheckpointKey, "sql:root:7");
	assert.match(descriptor.capture.rootCheckpointHash, /^[a-f0-9]{64}$/);
	assert.equal(descriptor.capture.rootCheckpointHashFormat, "canonical-root-v1");
	assert.equal(fixture.stages(), 1);
	const rootState = service.rootState(descriptor.bootstrapId);
	assert.equal(await rootState.hash, descriptor.capture.rootCheckpointHash,
		"separate reconstructions retain one engine-independent root identity");
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

s.test("Canvas bootstrap state holds transient headroom through reconstruction and encoding", async () => {
	const fixture = makeBootstrapStore();
	let activeReservations = 0;
	let semanticDocument: YwasmCrdtDocument | null = null;
	const store = {
		...fixture.store,
		semanticHeadAt: () => ({ lifecycle: "active" }),
		reconstructDocument: (documentId: string) => {
			const source = new Y.Doc({ guid: documentId });
			source.getMap("rootFields").set("theme", "dark");
			const doc = crdtEngine.openDocument(documentId, Y.encodeStateAsUpdate(source));
			source.destroy();
			if (documentId === "canvas-bootstrap") semanticDocument = doc;
			return { doc, generation: 3, semanticEpoch: 4 };
		},
	};
	const service = new BootstrapService(store as never, () => NOW, (documentId, copies) => {
		if (documentId !== "canvas-bootstrap") return () => {};
		assert.equal(copies, 2);
		activeReservations++;
		return () => { activeReservations--; };
	});
	await service.start("bootstrap-device-0002");
	const state = service.semanticState("bootstrap-device-0002", "canvas-bootstrap");
	assert.ok(state.encodedState.byteLength > 0);
	assert.equal(state.bodyEpoch, 4);
	assert.equal(activeReservations, 0, "the semantic full-state reservation is released exactly once");
	assert.throws(() => crdtEngine.encodeStateAsUpdate(semanticDocument!), /destroyed/,
		"the reconstructed Canvas is destroyed after encoding");
});

await s.done();
