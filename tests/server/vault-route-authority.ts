import { strict as assert } from "node:assert";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { ywasmCrdtEngine as testCrdtEngine } from "../../packages/server-node/src/ywasmNodeCrdtEngine";
import { encodeRootPathPublicationUpdate, VaultSyncServer } from "../../server/src/server";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "../../server/src/shared/socketCloseCodes";
import { MAX_CLIENT_MARKDOWN_BYTES } from "../../server/src/shared/durableLimits";
import { SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE } from "../../server/src/shared/semanticEpoch";
import {
	parseBodyChangedHintFrame,
	parseBodyCurrentnessResultFrame,
	parseSocketClientCapabilities,
} from "../../server/src/shared/socketLiveness";
import { VaultDocumentCachePressureError, VaultDocumentValidationError } from "../../server/src/vaultDocumentCache";
import {
	parseVaultSocketAttachment,
	rootUpdateChangesProtectedAttachmentMaps,
	rootUpdateHasSafeAttachmentSemantics,
	isStructurallyEmptyYjsUpdate,
	type VaultSocketAttachment,
	rootUpdateChangesDocument,
	type VaultSocketPort,
	type VaultSocketRegistryPort,
	VaultSocketService,
	bodyUpdateAdmissionError,
} from "../../server/src/vaultSocketService";
import { suite } from "../harness.ts";

const s = suite("vault-route-authority");

const attachment = {
	vaultId: "vault-authority-0001",
	vaultGeneration: "generation-authority-0001",
	runtimeEpoch: "epoch-authority-0001",
	documentId: "root",
	kind: "root" as const,
	documentEpoch: 1,
	deviceId: "device-authority-0001",
	deviceName: "Authority laptop",
	principalId: "principal-authority-0001",
	membershipRevision: 1,
	deviceCredentialRevision: 1,
	role: "member" as const,
	policyVersion: 1,
	capabilityDigest: "capability-digest-authority-0001",
	socketId: "socket-authority-0001",
};

function registry(sockets: readonly VaultSocketPort[]): VaultSocketRegistryPort {
	return {
		sockets: () => sockets,
		createPair: () => { throw new Error("socket creation is outside this test"); },
		accept: () => { throw new Error("socket acceptance is outside this test"); },
		upgradeResponse: () => { throw new Error("socket upgrade is outside this test"); },
	};
}
class StaleGenerationSocket implements VaultSocketPort {
	constructor(private readonly onClose: (code: number, reason: string) => void) {}

	send(_message: ArrayBuffer | ArrayBufferView | string): never {
		throw new Error("stale socket must not send");
	}
	close(code = 1000, reason = ""): void {
		this.onClose(code, reason);
	}
	deserializeAttachment() {
		return attachment;
	}
	serializeAttachment(): never {
		throw new Error("stale socket must not change attachment");
	}
}


s.test("hibernated attachments preserve exact vault, generation, device, and document identity", () => {
	assert.deepEqual(parseVaultSocketAttachment(attachment), attachment);
	assert.equal(parseVaultSocketAttachment({ ...attachment, kind: "body" }), null, "root cannot restart as a body socket");
	assert.equal(parseVaultSocketAttachment({ ...attachment, kind: "body", documentId: "root" }), null);
	assert.equal(parseVaultSocketAttachment({ ...attachment, vaultGeneration: "../generation" }), null);
	assert.equal(parseVaultSocketAttachment({ ...attachment, deviceId: "device\npoison" }), null);
	const body = { ...attachment, kind: "body" as const, documentId: "body-authority-0001" };
	assert.deepEqual(parseVaultSocketAttachment(body), body);
});

s.test("durable root publication reaches a hibernated socket before cache residency", () => {
	const sent: Array<ArrayBuffer | ArrayBufferView | string> = [];
	const socket: VaultSocketPort = {
		deserializeAttachment: () => attachment,
		serializeAttachment: () => {},
		send: (value) => { sent.push(value); },
		close: () => {},
	};
	const service = new VaultSocketService({
		sockets: registry([socket]),
		cache: { get: () => undefined },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		currentRootEpoch: () => attachment.documentEpoch,
	} as never);
	const update = new Uint8Array([1, 2, 3]);
	assert.doesNotThrow(() => service.broadcastDocumentUpdate("root", update, null));
	assert.equal(sent.length, 1, "the durable delta is fanned out without hydrating root state");
});

s.test("socket admission rejects a signed but retired semantic lineage before allocation", async () => {
	const service = new VaultSocketService({
		sockets: registry([]),
		cache: { admitBody: () => true, load: () => ({ semanticEpoch: 4, generation: 1, doc: new Y.Doc() }) },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		validateActor: () => true,
	} as never);
	const response = service.accept("body-retired-lineage", "body", 3, "device-authority-0001");
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "semantic_epoch_mismatch", purpose: "body", documentId: "body-retired-lineage",
		expectedEpoch: 4, receivedEpoch: 3, reset: "fetch_fresh_baseline",
	});
});

s.test("hibernated stale-epoch sockets are fenced before frame decoding or document access", async () => {
	let cacheLoads = 0;
	let close: { code: number; reason: string } | null = null;
	const sent: string[] = [];
	const stale = { ...attachment, kind: "body" as const, documentId: "body-retired-lineage", documentEpoch: 3 };
	const socket: VaultSocketPort = {
		deserializeAttachment: () => stale,
		serializeAttachment: () => {},
		send: (value) => { if (typeof value === "string") sent.push(value); },
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const service = new VaultSocketService({
		sockets: registry([socket]),
		cache: { load: () => { cacheLoads++; throw new Error("stale frame must not load"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		currentBodyHead: (bodyId: string) => ({ bodyId, bodyEpoch: 4, lifecycle: "active",
			generation: 2, contentHash: null, size: null, sequence: 2 }),
		validateActor: () => true,
	} as never);
	await service.message(socket, new Uint8Array([255, 255, 255]).buffer);
	assert.equal(cacheLoads, 0);
	assert.deepEqual(close, { code: SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE, reason: "semantic epoch reset" });
	assert.equal(JSON.parse(sent[0]!.slice(6)).type, "SEMANTIC_EPOCH_RESET_REQUIRED");
});

s.test("stale-generation sockets are fenced before decoding or document access", async () => {
	let close: { code: number; reason: string } | null = null;
	let cacheLoads = 0;
	const service = new VaultSocketService({
		sockets: registry([]),
		cache: { load: () => { cacheLoads++; throw new Error("must not load"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => "generation-authority-current",
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		scheduleFlush: () => {},
	} as never);
	const socket = new StaleGenerationSocket((code, reason) => {
		close = { code, reason };
	});
	await service.message(socket, new Uint8Array([0]).buffer);
	assert.deepEqual(close, { code: 1008, reason: "socket authority mismatch" });
	assert.equal(cacheLoads, 0);
});

s.test("root socket validation rejects structural changes and accepts duplicate state", () => {
	const oracle = new Y.Doc({ guid: "root" });
	oracle.getMap("sys").set("schemaVersion", 6);
	const duplicate = Y.encodeStateAsUpdate(oracle);
	const current = testCrdtEngine.openDocument("root", duplicate);
	assert.equal(rootUpdateChangesDocument(current, duplicate, testCrdtEngine), false);
	const changed = new Y.Doc({ guid: "root" });
	Y.applyUpdate(changed, duplicate);
	const vector = Y.encodeStateVector(changed);
	changed.getMap("pathToId").set("ghost.md", "ghost-body");
	assert.equal(rootUpdateChangesDocument(current, Y.encodeStateAsUpdate(changed, vector), testCrdtEngine), true);
	const deleted = new Y.Doc({ guid: "root" });
	Y.applyUpdate(deleted, duplicate);
	const deletionVector = Y.encodeStateVector(deleted);
	deleted.getMap("sys").delete("schemaVersion");
	assert.equal(rootUpdateChangesDocument(
		current, Y.encodeStateAsUpdate(deleted, deletionVector), testCrdtEngine,
	), true, "delete-only updates change full state even when their state vector does not advance");
	testCrdtEngine.destroyDocument(current);
	oracle.destroy();
	changed.destroy();
	deleted.destroy();
});

s.test("download-only root sockets accept the empty Yjs handshake but reject client structs", async () => {
	let close: { code: number; reason: string } | null = null;
	const socket: VaultSocketPort = {
		deserializeAttachment: () => attachment,
		serializeAttachment: () => {},
		send: () => {},
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const service = new VaultSocketService({
		crdtEngine: testCrdtEngine,
		sockets: registry([socket]),
		cache: {
			load: () => ({ semanticEpoch: attachment.documentEpoch }),
			validateRootSyncNoop: () => false,
		},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		currentRootEpoch: () => attachment.documentEpoch,
		validateActor: () => true,
	} as never);
	const frame = (update: Uint8Array): ArrayBuffer => {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, 0);
		syncProtocol.writeUpdate(encoder, update);
		return encoding.toUint8Array(encoder).slice().buffer;
	};
	const empty = new Y.Doc({ guid: "empty-root-peer" });
	const emptyUpdate = Y.encodeStateAsUpdate(empty);
	empty.destroy();
	assert.equal(isStructurallyEmptyYjsUpdate(emptyUpdate, testCrdtEngine), true);
	await service.message(socket, frame(emptyUpdate));
	assert.equal(close, null, "protocol-required empty sync step does not disconnect the root");

	const changed = new Y.Doc({ guid: "malicious-root-peer" });
	changed.getMap("pathToId").set("ghost.md", "ghost-body");
	const changedUpdate = Y.encodeStateAsUpdate(changed);
	changed.destroy();
	assert.equal(isStructurallyEmptyYjsUpdate(changedUpdate, testCrdtEngine), false);
	await service.message(socket, frame(changedUpdate));
	assert.deepEqual(close, { code: 1008, reason: "root updates require durable publication" });
});

s.test("body socket admission rejects a bounded update that grows Markdown beyond recovery limits", () => {
	const current = testCrdtEngine.createDocument("body-size-admission");
	const candidate = new Y.Doc({ guid: "body-size-admission-source" });
	const prefixBytes = MAX_CLIENT_MARKDOWN_BYTES - (1024 * 1024);
	candidate.getText("body").insert(0, "x".repeat(prefixBytes));
	testCrdtEngine.applyUpdate(current, Y.encodeStateAsUpdate(candidate), "body-size-fixture");
	const vector = Y.encodeStateVector(candidate);
	candidate.getText("body").insert(candidate.getText("body").length, "y".repeat((1024 * 1024) + 1));
	const update = Y.encodeStateAsUpdate(candidate, vector);
	assert.ok(update.byteLength < 1_750_000, "fixture must pass the per-frame durable update gate");
	assert.equal(bodyUpdateAdmissionError(current, update, testCrdtEngine), "markdown_size_limit");
	testCrdtEngine.destroyDocument(current);
	candidate.destroy();
});

s.test("hibernated sockets from an old runtime epoch are fenced", async () => {
	let close: { code: number; reason: string } | null = null;
	const service = new VaultSocketService({
		sockets: registry([]),
		cache: { load: () => { throw new Error("must not load"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: "epoch-authority-current",
		isActiveBody: () => true,
		scheduleFlush: () => {},
	} as never);
	await service.message(new StaleGenerationSocket((code, reason) => {
		close = { code, reason };
	}), new Uint8Array([0]).buffer);
	assert.deepEqual(close, { code: 1008, reason: "socket authority mismatch" });
});

s.test("application liveness is acknowledged on the exact socket without loading a document", async () => {
	const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	let cacheLoads = 0;
	const liveSocket: VaultSocketPort = {
		deserializeAttachment: () => attachment,
		serializeAttachment: () => {},
		send: (message) => { sent.push(message); },
		close: () => {},
	};
	const service = new VaultSocketService({
		sockets: registry([liveSocket]),
		cache: { load: () => { cacheLoads++; throw new Error("liveness must not load"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		isDeviceRevoked: () => false,
		scheduleFlush: () => {},
	} as never);
	await service.message(liveSocket, '__YPS:{"type":"VAULT_PING","probeId":"probe-1"}');
	assert.equal(cacheLoads, 0);
	assert.equal(sent.length, 1);
	assert.deepEqual(JSON.parse((sent[0] as string).slice(6)), {
		type: "VAULT_PONG",
		probeId: "probe-1",
		documentId: "root",
		documentEpoch: 1,
		vaultGeneration: attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
	});
	await service.message(liveSocket, '__YPS:__YPS:{"type":"VAULT_PING","probeId":"probe-2"}');
	assert.equal(sent.length, 1, "the custom-message prefix is consumed exactly once");
});

s.test("root currentness queries return bounded exact heads without loading documents", async () => {
	const sent: string[] = [];
	let cacheLoads = 0;
	const liveSocket: VaultSocketPort = {
		deserializeAttachment: () => attachment,
		serializeAttachment: () => {},
		send: (message) => { if (typeof message === "string") sent.push(message); },
		close: () => {},
	};
	const service = new VaultSocketService({
		sockets: registry([liveSocket]),
		cache: { load: () => { cacheLoads++; throw new Error("query must not load"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		currentBodyHead: (bodyId: string) => bodyId === "body-current"
			? { bodyId, bodyEpoch: 1, lifecycle: "active", generation: 7, contentHash: "a".repeat(64), size: 12, sequence: 19 }
			: null,
		currentSequence: () => 21,
		isDeviceRevoked: () => false,
		scheduleFlush: () => {},
	} as never);
	await service.message(liveSocket, `__YPS:${JSON.stringify({
		type: "BODY_CURRENTNESS_QUERY",
		queryId: "query-1",
		bodyIds: ["body-current", "body-missing"],
	})}`);
	assert.equal(cacheLoads, 0);
	assert.equal(sent.length, 1);
	assert.deepEqual(JSON.parse(sent[0]!.slice(6)), {
		type: "BODY_CURRENTNESS_RESULT",
		queryId: "query-1",
		socketSessionId: attachment.socketId,
		vaultSequence: 21,
		heads: [{
			bodyId: "body-current",
			bodyEpoch: 1,
			lifecycle: "active",
			generation: 7,
			contentHash: "a".repeat(64),
			size: 12,
		}],
		missingBodyIds: ["body-missing"],
	});
});

s.test("an inactive body cannot renew liveness", async () => {
	let close: { code: number; reason: string } | null = null;
	const bodySocket: VaultSocketPort = {
		deserializeAttachment: () => ({ ...attachment, kind: "body", documentId: "inactive-body" }),
		serializeAttachment: () => {},
		send: () => { throw new Error("inactive body must not receive a pong"); },
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const service = new VaultSocketService({
		sockets: registry([bodySocket]),
		cache: { load: () => { throw new Error("inactive body must not load"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => false,
		isDeviceRevoked: () => false,
		scheduleFlush: () => {},
	} as never);
	await service.message(bodySocket, '__YPS:{"type":"VAULT_PING","probeId":"probe-inactive"}');
	assert.deepEqual(close, { code: 1008, reason: "body is not active" });
});

s.test("body socket cache pressure is bounded to explicit 429 responses", async () => {
	const compactionService = new VaultSocketService({
		sockets: registry([]),
		cache: { admitBody: () => { throw new Error("paused admission must not touch cache"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		shouldPauseAdmission: () => true,
	} as never);
	const compactionResponse = compactionService.accept("body-compaction-pressure", "body", 1, "device-pressure");
	assert.equal(compactionResponse.status, 429);
	assert.equal(compactionResponse.headers.get("retry-after"), "1");
	assert.deepEqual(await compactionResponse.json(), { error: "semantic_compaction_backpressure" });
	let frameClose: { code: number; reason: string } | null = null;
	const frameControl: string[] = [];
	const frameSocket: VaultSocketPort = {
		deserializeAttachment: () => ({ ...attachment, kind: "body", documentId: "body-compaction-pressure" }),
		serializeAttachment: () => {},
		send: (value) => { if (typeof value === "string") frameControl.push(value); },
		close: (code = 1000, reason = "") => { frameClose = { code, reason }; },
	};
	const frameService = new VaultSocketService({
		sockets: registry([frameSocket]),
		cache: { load: () => { throw new Error("paused frame must not reconstruct"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		currentBodyHead: (bodyId: string) => ({ bodyId, bodyEpoch: 1, lifecycle: "active", generation: 1,
			contentHash: null, size: null, sequence: 1 }),
		validateActor: () => true,
		shouldPauseAdmission: () => true,
	} as never);
	await frameService.message(frameSocket, new Uint8Array([0]).buffer);
	assert.deepEqual(frameClose, { code: 1013, reason: "semantic compaction pressure" });
	assert.equal(JSON.parse(frameControl[0]!.slice(6)).reason, "semantic_compaction_backpressure");

	for (const reason of ["body_cache_encoded_state_bytes", "vault_transient_bytes"] as const) {
		const service = new VaultSocketService({
			sockets: registry([]),
			cache: {
				admitBody: () => true,
				load: () => { throw new VaultDocumentCachePressureError(reason); },
			},
			vaultId: () => attachment.vaultId,
			vaultGeneration: () => attachment.vaultGeneration,
			runtimeEpoch: attachment.runtimeEpoch,
			isActiveBody: () => true,
			isDeviceRevoked: () => false,
			scheduleFlush: () => {},
		} as never);
		const response = service.accept("body-pressure", "body", 1, "device-pressure");
		assert.equal(response.status, 429);
		assert.equal(response.headers.get("retry-after"), "1");
		assert.deepEqual(await response.json(), { error: reason });
	}

	const countService = new VaultSocketService({
		sockets: registry([]),
		cache: { admitBody: () => false },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		isDeviceRevoked: () => false,
		scheduleFlush: () => {},
	} as never);
	const countResponse = countService.accept("body-count", "body", 1, "device-pressure");
	assert.equal(countResponse.status, 429);
	assert.equal(countResponse.headers.get("retry-after"), "1");
	assert.deepEqual(await countResponse.json(), { error: "body_cache_count" });
});

s.test("body socket admission preserves unknown cache failures", () => {
	const failure = new Error("storage reconstruction failed");
	const service = new VaultSocketService({
		sockets: registry([]),
		cache: {
			admitBody: () => true,
			load: () => { throw failure; },
		},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		isDeviceRevoked: () => false,
		scheduleFlush: () => {},
	} as never);
	assert.throws(
		() => service.accept("body-unknown", "body", 1, "device-pressure"),
		(error: unknown) => error === failure,
	);
});

s.test("lifecycle publication is the exact root path authority", () => {
	const root = new Y.Doc({ guid: "root" });
	root.getMap("pathToId").set("old.md", "body-old-0001");
	const baseline = Y.encodeStateAsUpdate(root);
	const update = encodeRootPathPublicationUpdate(baseline, [
		{ sourcePath: "old.md", resultPath: "new.md", fileId: "body-old-0001", lifecycle: "active" },
		{ sourcePath: null, resultPath: "created.md", fileId: "body-created-0001", lifecycle: "active" },
	]);
	const published = new Y.Doc({ guid: "published-root" });
	Y.applyUpdate(published, baseline);
	Y.applyUpdate(published, update);
	assert.equal(published.getMap("pathToId").has("old.md"), false);
	assert.equal(published.getMap("pathToId").get("new.md"), "body-old-0001");
	assert.equal(published.getMap("pathToId").get("created.md"), "body-created-0001");
	root.destroy();
	published.destroy();
});

s.test("direct protected attachment-map mutations are detected and validated", () => {
	const root = new Y.Doc({ guid: "root" });
	const vector = Y.encodeStateVector(root);
	root.getMap("pathToBlob").set("assets/image.png", { hash: "a".repeat(64), size: 1, revision: "operation-valid" });
	const safeUpdate = Y.encodeStateAsUpdate(root, vector);
	const empty = testCrdtEngine.createDocument("empty-root");
	assert.equal(rootUpdateChangesProtectedAttachmentMaps(empty, safeUpdate, testCrdtEngine), true);
	assert.equal(rootUpdateHasSafeAttachmentSemantics(empty, safeUpdate, testCrdtEngine), true);
	const unsafe = new Y.Doc({ guid: "unsafe-root" });
	Y.applyUpdate(unsafe, Y.encodeStateAsUpdate(root));
	const unsafeVector = Y.encodeStateVector(unsafe);
	unsafe.getMap("pathToBlob").set("../escape", { hash: "b".repeat(64), size: 1 });
	const current = testCrdtEngine.openDocument("root-current", Y.encodeStateAsUpdate(root));
	assert.equal(rootUpdateHasSafeAttachmentSemantics(
		current, Y.encodeStateAsUpdate(unsafe, unsafeVector), testCrdtEngine,
	), false);
	const sharedValue = new Y.Doc({ guid: "shared-attachment-root" });
	const sharedVector = Y.encodeStateVector(sharedValue);
	const nested = new Y.Map<unknown>();
	nested.set("hash", "c".repeat(64));
	nested.set("size", 1);
	nested.set("revision", "shared-value-is-not-a-plain-record");
	sharedValue.getMap("pathToBlob").set("assets/shared.png", nested);
	assert.equal(rootUpdateHasSafeAttachmentSemantics(
		empty, Y.encodeStateAsUpdate(sharedValue, sharedVector), testCrdtEngine,
	), false, "engine-owned nested shared types cannot masquerade as plain attachment records");
	root.destroy();
	testCrdtEngine.destroyDocument(empty);
	testCrdtEngine.destroyDocument(current);
	unsafe.destroy();
	sharedValue.destroy();
});

s.test("body sockets reject invalid semantic roots before queue, apply, broadcast, or flush", async () => {
	const bodyId = "body-semantic-authority-0001";
	const loaded = testCrdtEngine.createDocument(bodyId);
	const malicious = new Y.Doc({ guid: bodyId });
	malicious.getMap<number>("frontmatter:meta").set("format", 1);
	malicious.getMap("frontmatter:future-root").set("payload", "not admitted");
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0);
	syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(malicious));
	const frame = encoding.toUint8Array(encoder);
	let queued = 0;
	let flushes = 0;
	let close: { code: number; reason: string } | null = null;
	const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	const bodySocket: VaultSocketPort = {
		deserializeAttachment: () => ({ ...attachment, kind: "body", documentId: bodyId }),
		serializeAttachment: () => {},
		send: (message) => { sent.push(message); },
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const service = new VaultSocketService({
		sockets: registry([bodySocket]),
		cache: {
			load: () => ({ doc: loaded, generation: 1, semanticEpoch: 1 }),
			serializeDocument: async (_documentId: string, operation: () => Promise<unknown>) => operation(),
			validateBodyUpdate: (_documentId: string, update: Uint8Array) => {
				const reason = bodyUpdateAdmissionError(loaded, update, testCrdtEngine);
				if (reason) throw new VaultDocumentValidationError(reason);
				throw new Error("fixture expected an invalid update");
			},
			queue: () => { queued++; return { ok: true }; },
		},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		currentBodyHead: (bodyId: string) => ({ bodyId, bodyEpoch: 1, lifecycle: "active", generation: 1,
			contentHash: null, size: null, sequence: 1 }),
		isDeviceRevoked: () => false,
		scheduleFlush: () => { flushes++; },
	} as never);
	await service.message(bodySocket, frame.slice().buffer);
	assert.deepEqual(close, { code: 1008, reason: "invalid body update" });
	assert.equal(queued, 0);
	assert.equal(flushes, 0);
	assert.equal(testCrdtEngine.snapshotRoots(loaded).some((root) => root.name === "frontmatter:future-root"), false);
	assert.equal(sent.length, 1, "only the typed rejection is sent; no document update is broadcast");
	assert.equal(JSON.parse((sent[0] as string).slice(6)).code, "frontmatter_semantic_root_invalid");
	testCrdtEngine.destroyDocument(loaded);
	malicious.destroy();
});

s.test("valid socket frames remain speculative until the durable flush publishes them", async () => {
	const bodyId = "body-durable-order-0001";
	const live = new Y.Doc({ guid: bodyId });
	live.getText("body").insert(0, "before");
	const validation = new Y.Doc({ guid: `${bodyId}-validation` });
	Y.applyUpdate(validation, Y.encodeStateAsUpdate(live));
	const producer = new Y.Doc({ guid: bodyId });
	Y.applyUpdate(producer, Y.encodeStateAsUpdate(live));
	const vector = Y.encodeStateVector(producer);
	producer.getText("body").insert(producer.getText("body").length, "-after");
	const update = Y.encodeStateAsUpdate(producer, vector);
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 0);
	syncProtocol.writeUpdate(encoder, update);
	const frame = encoding.toUint8Array(encoder);
	const originAttachment = { ...attachment, kind: "body" as const, documentId: bodyId };
	const peerAttachment = { ...originAttachment, socketId: "socket-durable-peer" };
	const originSent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	const peerSent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	const origin: VaultSocketPort = {
		deserializeAttachment: () => originAttachment,
		serializeAttachment: () => {},
		send: (message) => { originSent.push(message); },
		close: () => {},
	};
	const peer: VaultSocketPort = {
		deserializeAttachment: () => peerAttachment,
		serializeAttachment: () => {},
		send: (message) => { peerSent.push(message); },
		close: () => {},
	};
	let validationPending = false;
	let queued = 0;
	let flushes = 0;
	const loaded = { doc: live, validationDoc: validation, generation: 1, semanticEpoch: 1 };
	const service = new VaultSocketService({
		sockets: registry([origin, peer]),
		cache: {
			load: () => loaded,
			serializeDocument: async (_documentId: string, operation: () => Promise<unknown>) => operation(),
			validateBodyUpdate: (_documentId: string, candidate: Uint8Array) => {
				let changed = false;
				const observer = () => { changed = true; };
				validation.on("update", observer);
				try { Y.applyUpdate(validation, candidate); }
				finally { validation.off("update", observer); }
				validationPending = true;
				return {
					changesState: changed,
					requiresDurableCommit: changed || queued > 0,
					contentBytes: new TextEncoder().encode(validation.getText("body").toString()),
					encodedStateBytes: Y.encodeStateAsUpdate(validation).byteLength,
					exactEncodedStateBytes: true,
				};
			},
			stageValidatedBodyUpdate: (_documentId: string, validated: { changesState: boolean }) => {
				assert.equal(validationPending, true);
				validationPending = false;
				return validated.changesState;
			},
			queue: () => { queued++; return { ok: true }; },
		},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		currentBodyHead: (id: string) => ({ bodyId: id, bodyEpoch: 1, lifecycle: "active",
			generation: 1, contentHash: null, size: null, sequence: 1 }),
		validateActor: () => true,
		principalPresence: () => null,
		scheduleFlush: () => { flushes++; },
	} as never);

	await service.message(origin, frame.slice().buffer);
	assert.equal(live.getText("body").toString(), "before", "validated socket state is not authoritative yet");
	assert.equal(validation.getText("body").toString(), "before-after");
	assert.equal(queued, 1);
	assert.equal(flushes, 1);
	assert.equal(peerSent.length, 0, "no peer observes a frame before SQLite commits it");
	assert.equal(originSent.length, 0);

	await service.message(origin, frame.slice().buffer);
	assert.equal(queued, 2, "a speculative duplicate remains attached to the durability outcome");
	assert.equal(flushes, 2, "the scheduler coalesces the repeated document key in production");
	assert.equal(validationPending, false);
	live.destroy();
	validation.destroy();
	producer.destroy();
});

s.test("device revocation closes every active root and body socket for that device", () => {
	const closed: string[] = [];
	const socket = (deviceId: string, documentId: string): VaultSocketPort => ({
		deserializeAttachment: () => ({
			...attachment,
			deviceId,
			documentId,
			kind: documentId === "root" ? "root" as const : "body" as const,
		}),
		serializeAttachment: () => {},
		send: () => {},
		close: (code: number, reason: string) => { closed.push(`${code}:${deviceId}:${documentId}:${reason}`); },
	});
	const sockets = [
		socket("device-revoked", "root"),
		socket("device-revoked", "body-revoked"),
		socket("device-active", "root"),
	];
	const service = new VaultSocketService({
		sockets: registry(sockets),
		cache: {},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		scheduleFlush: () => {},
	} as never);
	assert.equal(service.closeDevice("device-revoked"), 2);
	assert.deepEqual(closed, [
		`${AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE}:device-revoked:root:device authority changed`,
		`${AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE}:device-revoked:body-revoked:device authority changed`,
	]);
	closed.length = 0;
	assert.equal(service.closePrincipal(attachment.principalId), 3);
	assert.ok(closed.every((entry) => entry.startsWith(`${AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE}:`)
		&& entry.endsWith(":membership revoked")), "membership revocation uses the same durable terminal close code");
});

s.test("body awareness is principal-rewritten and confined to the exact body room", async () => {
	const bodyId = "body-presence-authority-0001";
	const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	const makeSocket = (overrides: Partial<typeof attachment>): VaultSocketPort => ({
		deserializeAttachment: () => ({ ...attachment, kind: "body" as const, documentId: bodyId, ...overrides }),
		serializeAttachment: () => {},
		send: (message) => { sent.push(message); },
		close: () => {},
	});
	const source = makeSocket({ socketId: "source-presence-socket" });
	const peer = makeSocket({ deviceId: "peer-device", deviceName: "Peer laptop", socketId: "peer-presence-socket" });
	const otherBody = makeSocket({ documentId: "body-other-room", socketId: "other-body-socket" });
	const root = makeSocket({ kind: "root", documentId: "root", socketId: "root-presence-socket" });
	const service = new VaultSocketService({
		sockets: registry([source, peer, otherBody, root]),
		cache: {},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		validateActor: () => true,
		principalPresence: () => ({ displayName: "Alice", colorSeed: "alice-color-seed" }),
		scheduleFlush: () => {},
	} as never);
	const sourceDoc = new Y.Doc();
	const sourceAwareness = new Awareness(sourceDoc);
	sourceAwareness.setLocalState({ user: { name: "Mallory", principalId: "spoofed", deviceName: "Spoofed" } });
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 1);
	encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(sourceAwareness, [sourceDoc.clientID]));
	await service.message(source, encoding.toUint8Array(encoder).buffer);
	assert.equal(sent.length, 1, "only the peer in the same body room receives presence");
	const trustedDecoder = decoding.createDecoder(sent[0] as Uint8Array);
	assert.equal(decoding.readVarUint(trustedDecoder), 1);
	const targetDoc = new Y.Doc();
	const targetAwareness = new Awareness(targetDoc);
	applyAwarenessUpdate(targetAwareness, decoding.readVarUint8Array(trustedDecoder), "test");
	const state = [...targetAwareness.getStates().values()].find((candidate) => "user" in candidate) as { user?: Record<string, unknown> };
	assert.deepEqual(state.user, {
		name: "Alice",
		id: attachment.deviceId,
		principalId: attachment.principalId,
		deviceId: attachment.deviceId,
		deviceName: attachment.deviceName,
		colorSeed: "alice-color-seed",
		color: "hsl(73, 72%, 52%)",
		colorLight: "hsla(73, 72%, 52%, 0.2)",
	});
	sourceAwareness.destroy();
	targetAwareness.destroy();
	sourceDoc.destroy();
	targetDoc.destroy();
});

function awarenessFrame(entries: Array<{ clientId: number; clock?: number; state?: unknown }>): ArrayBuffer {
	const payload = encoding.createEncoder();
	encoding.writeVarUint(payload, entries.length);
	for (const entry of entries) {
		encoding.writeVarUint(payload, entry.clientId);
		encoding.writeVarUint(payload, entry.clock ?? 1);
		encoding.writeVarString(payload, JSON.stringify(entry.state === undefined ? { cursor: null } : entry.state));
	}
	const frame = encoding.createEncoder();
	encoding.writeVarUint(frame, 1);
	encoding.writeVarUint8Array(frame, encoding.toUint8Array(payload));
	const bytes = encoding.toUint8Array(frame);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function presenceSocket(documentId: string, overrides: Partial<VaultSocketAttachment> = {}): {
	socket: VaultSocketPort;
	sent: Array<string | ArrayBuffer | ArrayBufferView>;
	closes: Array<{ code: number; reason: string }>;
	current: () => VaultSocketAttachment;
} {
	let current: VaultSocketAttachment = { ...attachment, kind: "body", documentId, ...overrides };
	const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
	const closes: Array<{ code: number; reason: string }> = [];
	return {
		socket: {
			deserializeAttachment: () => current,
			serializeAttachment: (value) => { current = value as VaultSocketAttachment; },
			send: (message) => { sent.push(message); },
			close: (code = 1000, reason = "") => { closes.push({ code, reason }); },
		},
		sent,
		closes,
		current: () => current,
	};
}

function relayedAwareness(sent: ReadonlyArray<string | ArrayBuffer | ArrayBufferView>): Array<{ clientId: number; state: unknown }> {
	const entries: Array<{ clientId: number; state: unknown }> = [];
	for (const message of sent) {
		if (typeof message === "string") continue;
		const bytes = message instanceof ArrayBuffer ? new Uint8Array(message)
			: new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
		const frame = decoding.createDecoder(bytes);
		assert.equal(decoding.readVarUint(frame), 1);
		const payload = decoding.createDecoder(decoding.readVarUint8Array(frame));
		const count = decoding.readVarUint(payload);
		for (let index = 0; index < count; index++) {
			const clientId = decoding.readVarUint(payload);
			decoding.readVarUint(payload);
			entries.push({ clientId, state: JSON.parse(decoding.readVarString(payload)) });
		}
	}
	return entries;
}

function presenceService(sockets: VaultSocketPort[]): VaultSocketService {
	return new VaultSocketService({
		sockets: registry(sockets),
		cache: {},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		validateActor: () => true,
		principalPresence: () => ({ displayName: "Alice", colorSeed: "alice-color-seed" }),
		scheduleFlush: () => {},
	} as never);
}

s.test("an unbound socket cannot bind its awareness identity from an ambiguous frame", async () => {
	let current: VaultSocketAttachment = { ...attachment, kind: "body" as const, documentId: "body-presence-multi-id" };
	let close: { code: number; reason: string } | null = null;
	const socket: VaultSocketPort = {
		deserializeAttachment: () => current,
		serializeAttachment: (value) => { current = value as VaultSocketAttachment; },
		send: () => {},
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const peer = presenceSocket("body-presence-multi-id", { deviceId: "peer-device", socketId: "multi-id-peer" });
	const service = presenceService([socket, peer.socket]);
	await service.message(socket, awarenessFrame([{ clientId: 101 }, { clientId: 102 }]));
	await service.message(socket, awarenessFrame([{ clientId: 103, state: null }]));
	assert.equal(close, null, "ambiguous presence is ignored, not fatal");
	assert.equal(current.awarenessClientId, undefined, "neither a multi-entry frame nor a removal binds an identity");
	assert.equal(peer.sent.length, 0);
	await service.message(socket, awarenessFrame([{ clientId: 104 }]));
	assert.equal(current.awarenessClientId, 104, "the first single live entry binds the socket");
	assert.deepEqual(relayedAwareness(peer.sent).map(({ clientId }) => clientId), [104]);
});

s.test("awareness identity is immutable and foreign entries are dropped without closing", async () => {
	let current: VaultSocketAttachment = { ...attachment, kind: "body" as const, documentId: "body-presence-stable-id" };
	let close: { code: number; reason: string } | null = null;
	const socket: VaultSocketPort = {
		deserializeAttachment: () => current,
		serializeAttachment: (value) => { current = value as VaultSocketAttachment; },
		send: () => {},
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const peer = presenceSocket("body-presence-stable-id", { deviceId: "peer-device", socketId: "stable-id-peer" });
	const service = presenceService([socket, peer.socket]);
	await service.message(socket, awarenessFrame([{ clientId: 201 }]));
	assert.equal(current.awarenessClientId, 201);
	peer.sent.length = 0;
	await service.message(socket, awarenessFrame([{ clientId: 202, state: { user: { name: "Echoed peer" } } }]));
	assert.equal(close, null, "a re-broadcast peer state must not disconnect the socket");
	assert.equal(current.awarenessClientId, 201);
	assert.equal(peer.sent.length, 0, "a foreign-only frame is ignored, never relayed");
});

s.test("an older admission cannot take an awareness identity a newer socket holds", async () => {
	const documentId = "body-presence-collision";
	const newer = presenceSocket(documentId, { awarenessClientId: 301, socketId: "collision-newer", admittedAt: 2_000 });
	const older = presenceSocket(documentId, { socketId: "collision-older", admittedAt: 1_000 });
	await presenceService([newer.socket, older.socket]).message(older.socket, awarenessFrame([{ clientId: 301 }]));
	assert.deepEqual(older.closes, [{ code: 1008, reason: "awareness identity already in use" }]);
	assert.deepEqual(newer.closes, []);
	assert.equal(newer.current().awarenessClientId, 301);
});

s.test("a same-device reconnect evicts the ghost socket holding its awareness identity (newest wins)", async () => {
	const documentId = "body-presence-ghost";
	// The server never saw the abnormal close of the device's previous socket.
	const ghost = presenceSocket(documentId, { awarenessClientId: 311, socketId: "ghost-old", admittedAt: 1_000 });
	const fresh = presenceSocket(documentId, { socketId: "ghost-new", admittedAt: 5_000 });
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "ghost-peer", awarenessClientId: 312 });
	const service = presenceService([ghost.socket, fresh.socket, peer.socket]);
	await service.message(fresh.socket, awarenessFrame([{ clientId: 311, clock: 9 }]));
	assert.deepEqual(fresh.closes, [], "the new socket is not closed (that looped every ~1 s)");
	assert.equal(fresh.current().awarenessClientId, 311);
	assert.deepEqual(ghost.closes, [{ code: 1008, reason: "awareness identity superseded" }]);
	assert.equal(ghost.current().awarenessClientId, undefined, "the ghost releases the identity before it closes");
	assert.deepEqual(relayedAwareness(peer.sent).map(({ clientId }) => clientId), [311]);
	// The ghost's close later must not remove the identity the new socket now holds.
	peer.sent.length = 0;
	service.socketClosed(ghost.socket);
	assert.equal(peer.sent.length, 0);
});

s.test("a socket from another device cannot evict an identity it merely echoes", async () => {
	const documentId = "body-presence-foreign-ghost";
	const holder = presenceSocket(documentId, { awarenessClientId: 321, socketId: "foreign-holder", admittedAt: 1_000 });
	const other = presenceSocket(documentId, { deviceId: "other-device", socketId: "foreign-other", admittedAt: 9_000 });
	await presenceService([holder.socket, other.socket]).message(other.socket, awarenessFrame([{ clientId: 321 }]));
	assert.deepEqual(holder.closes, []);
	assert.equal(holder.current().awarenessClientId, 321);
	assert.equal(other.current().awarenessClientId, undefined);
});

s.test("a closed socket's awareness identity is removed for peers at the last relayed clock", async () => {
	const documentId = "body-presence-close";
	const source = presenceSocket(documentId, { socketId: "close-source", admittedAt: 1_000 });
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "close-peer", awarenessClientId: 332 });
	const elsewhere = presenceSocket("body-presence-other-room", { deviceId: "peer-device", socketId: "close-elsewhere" });
	const service = presenceService([source.socket, peer.socket, elsewhere.socket]);
	await service.message(source.socket, awarenessFrame([{ clientId: 331, clock: 4, state: { cursor: { anchor: 1 } } }]));
	const peerDoc = new Y.Doc();
	const peerAwareness = new Awareness(peerDoc);
	for (const message of peer.sent) {
		const bytes = new Uint8Array(message as ArrayBuffer);
		const frame = decoding.createDecoder(bytes);
		decoding.readVarUint(frame);
		applyAwarenessUpdate(peerAwareness, decoding.readVarUint8Array(frame), "server");
	}
	assert.ok(peerAwareness.getStates().has(331));
	peer.sent.length = 0;
	service.socketClosed(source.socket);
	assert.deepEqual(relayedAwareness(peer.sent), [{ clientId: 331, state: null }]);
	assert.equal(elsewhere.sent.length, 0, "other rooms are untouched");
	const removal = decoding.createDecoder(new Uint8Array(peer.sent[0] as ArrayBuffer));
	decoding.readVarUint(removal);
	applyAwarenessUpdate(peerAwareness, decoding.readVarUint8Array(removal), "server");
	assert.equal(peerAwareness.getStates().has(331), false, "a Yjs peer accepts the removal");
	service.socketClosed(source.socket);
	assert.equal(peer.sent.length, 1, "error followed by close removes once");
	peerAwareness.destroy();
	peerDoc.destroy();
});

s.test("a close after a hibernation wake still removes the identity at a clock peers accept (N5)", async () => {
	const documentId = "body-presence-wake";
	const source = presenceSocket(documentId, { socketId: "wake-source", admittedAt: 1_000 });
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "wake-peer", awarenessClientId: 352 });
	await presenceService([source.socket, peer.socket]).message(source.socket, awarenessFrame([
		{ clientId: 351, clock: 7, state: { cursor: { anchor: 2 } } },
	]));
	assert.equal(source.current().awarenessClock, 7, "the relayed clock is persisted with the socket");
	const peerAwareness = new Awareness(new Y.Doc());
	const apply = (message: string | ArrayBuffer | ArrayBufferView) => {
		const frame = decoding.createDecoder(new Uint8Array(message as ArrayBuffer));
		decoding.readVarUint(frame);
		applyAwarenessUpdate(peerAwareness, decoding.readVarUint8Array(frame), "server");
	};
	for (const message of peer.sent) apply(message);
	assert.ok(peerAwareness.getStates().has(351));
	peer.sent.length = 0;
	// Hibernation: attachments survive (serialized), service memory does not.
	const woken = presenceService([source.socket, peer.socket]);
	assert.ok(parseVaultSocketAttachment(JSON.parse(JSON.stringify(source.current()))), "the clock survives serialization");
	woken.socketClosed(source.socket);
	assert.deepEqual(relayedAwareness(peer.sent), [{ clientId: 351, state: null }]);
	apply(peer.sent[0]!);
	assert.equal(peerAwareness.getStates().has(351), false,
		"a removal at clock 0 (the in-memory map lost on wake) was ignored by a peer at clock 7");
	assert.equal(source.current().awarenessClock, undefined, "released with the identity");
	peerAwareness.destroy();
});

s.test("a closed socket keeps its identity for peers while the same device still holds it", async () => {
	const documentId = "body-presence-close-held";
	const closing = presenceSocket(documentId, { socketId: "held-closing", awarenessClientId: 341 });
	const holder = presenceSocket(documentId, { socketId: "held-holder", awarenessClientId: 341 });
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "held-peer" });
	const unbound = presenceSocket(documentId, { socketId: "held-unbound" });
	const service = presenceService([closing.socket, holder.socket, peer.socket, unbound.socket]);
	service.socketClosed(closing.socket);
	assert.equal(peer.sent.length, 0);
	service.socketClosed(unbound.socket);
	assert.equal(peer.sent.length, 0, "a socket that never bound an identity removes nothing");
});

s.test("foreign awareness entries are filtered and the own entry is relayed with the server-authored user", async () => {
	const documentId = "body-presence-filter";
	const source = presenceSocket(documentId, { awarenessClientId: 401, socketId: "filter-source" });
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "filter-peer", awarenessClientId: 402 });
	await presenceService([source.socket, peer.socket]).message(source.socket, awarenessFrame([
		{ clientId: 402, state: { user: { name: "Echoed peer" } } },
		{ clientId: 401, state: { user: { name: "Mallory", deviceId: "spoofed" }, cursor: { anchor: 3 } } },
		{ clientId: 403, state: null },
	]));
	assert.deepEqual(source.closes, [], "a frame mixing peer echoes must not disconnect the socket");
	assert.equal(peer.sent.length, 1);
	const [relayed] = relayedAwareness(peer.sent);
	assert.deepEqual(relayedAwareness(peer.sent).map(({ clientId }) => clientId), [401], "only the socket's own entry is relayed");
	const state = relayed!.state as { user: Record<string, unknown>; cursor: unknown };
	assert.deepEqual(state.cursor, { anchor: 3 });
	assert.equal(state.user.name, "Alice");
	assert.equal(state.user.deviceId, attachment.deviceId);
	assert.equal(state.user.principalId, attachment.principalId);
});

s.test("an own awareness removal is relayed while a foreign-only removal is dropped", async () => {
	const documentId = "body-presence-removal";
	const source = presenceSocket(documentId, { awarenessClientId: 501, socketId: "removal-source" });
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "removal-peer" });
	const service = presenceService([source.socket, peer.socket]);
	await service.message(source.socket, awarenessFrame([{ clientId: 502, state: null }]));
	assert.equal(peer.sent.length, 0, "a removal of another client can neither be relayed nor spoofed");
	await service.message(source.socket, awarenessFrame([{ clientId: 501, state: null }]));
	assert.deepEqual(source.closes, []);
	assert.deepEqual(relayedAwareness(peer.sent), [{ clientId: 501, state: null }]);
});

s.test("an unbound socket echoing another device's live identity is ignored, not closed", async () => {
	const documentId = "body-presence-echo";
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "echo-peer", awarenessClientId: 601 });
	const source = presenceSocket(documentId, { socketId: "echo-source" });
	const service = presenceService([peer.socket, source.socket]);
	await service.message(source.socket, awarenessFrame([{ clientId: 601 }]));
	assert.deepEqual(source.closes, []);
	assert.equal(source.current().awarenessClientId, undefined);
	assert.equal(peer.sent.length, 0);
	await service.message(source.socket, awarenessFrame([{ clientId: 602 }]));
	assert.equal(source.current().awarenessClientId, 602);
	assert.deepEqual(relayedAwareness(peer.sent).map(({ clientId }) => clientId), [602]);
});

function staleRuntimeService(sockets: VaultSocketPort[], overrides: Record<string, unknown> = {}): VaultSocketService {
	return new VaultSocketService({
		sockets: registry(sockets),
		cache: { load: () => { throw new Error("runtime-independent frames must not load documents"); } },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: "epoch-authority-after-wake",
		isActiveBody: () => true,
		currentRootEpoch: () => attachment.documentEpoch,
		currentBodyHead: () => null,
		validateActor: () => true,
		principalPresence: () => ({ displayName: "Alice", colorSeed: "alice-color-seed" }),
		scheduleFlush: () => {},
		...overrides,
	} as never);
}

s.test("a socket admitted by an earlier runtime keeps liveness but stays fenced for document frames", async () => {
	const root = presenceSocket("root", { kind: "root", socketId: "stale-runtime-root" });
	const service = staleRuntimeService([root.socket]);
	await service.message(root.socket, '__YPS:{"type":"VAULT_PING","probeId":"probe-after-wake"}');
	assert.deepEqual(root.closes, []);
	assert.deepEqual(JSON.parse((root.sent[0] as string).slice(6)), {
		type: "VAULT_PONG",
		probeId: "probe-after-wake",
		documentId: "root",
		documentEpoch: 1,
		vaultGeneration: attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
	}, "the pong reports the socket's admission runtime, not the new one");
	const sync = encoding.createEncoder();
	encoding.writeVarUint(sync, 0);
	syncProtocol.writeSyncStep1(sync, new Y.Doc());
	await service.message(root.socket, encoding.toUint8Array(sync).slice().buffer);
	assert.deepEqual(root.closes, [{ code: 1008, reason: "socket authority mismatch" }]);
	assert.equal(root.sent.length, 1, "fenced frames receive no reply");
});

s.test("a socket admitted by an earlier runtime is answered a durable body currentness query", async () => {
	const root = presenceSocket("root", { kind: "root", socketId: "stale-runtime-currentness" });
	const validated: string[] = [];
	const service = staleRuntimeService([root.socket], {
		validateActor: (actor: { deviceId: string }) => { validated.push(actor.deviceId); return true; },
		currentBodyHead: (bodyId: string) => bodyId === "body-current"
			? { bodyId, bodyEpoch: 1, lifecycle: "active", generation: 7, contentHash: "c".repeat(64), size: 5, sequence: 11 }
			: null,
		currentSequence: () => 12,
	});
	// 100 maximal body ids exceed any small liveness-only frame budget.
	const bodyIds = ["body-current", ...Array.from({ length: 99 }, (_, index) => `${"m".repeat(240)}${index}`)];
	await service.message(root.socket, `__YPS:${JSON.stringify({
		type: "BODY_CURRENTNESS_QUERY", queryId: "query-after-wake", bodyIds,
	})}`);
	assert.deepEqual(root.closes, [], "a read-only durable query must not close a stale-runtime socket");
	assert.deepEqual(validated, [attachment.deviceId], "the actor is still validated before answering");
	const result = parseBodyCurrentnessResultFrame(JSON.parse((root.sent[0] as string).slice(6)));
	assert.ok(result);
	assert.equal(result.queryId, "query-after-wake");
	assert.equal(result.socketSessionId, "stale-runtime-currentness", "bound to the socket's own session");
	assert.equal(result.vaultSequence, 12);
	assert.deepEqual(result.heads.map((head) => [head.bodyId, head.generation]), [["body-current", 7]]);
	assert.equal(result.missingBodyIds.length, 99);
});

s.test("a stale-runtime currentness query keeps actor, body-activity and body-scope fences", async () => {
	const revoked = presenceSocket("root", { kind: "root", socketId: "stale-currentness-revoked" });
	await staleRuntimeService([revoked.socket], { validateActor: () => false }).message(revoked.socket,
		'__YPS:{"type":"BODY_CURRENTNESS_QUERY","queryId":"q-revoked","bodyIds":["body-a"]}');
	assert.deepEqual(revoked.closes, [{ code: AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, reason: "socket authority superseded" }]);
	const inactive = presenceSocket("body-inactive-currentness", { socketId: "stale-currentness-inactive" });
	await staleRuntimeService([inactive.socket], { isActiveBody: () => false }).message(inactive.socket,
		'__YPS:{"type":"BODY_CURRENTNESS_QUERY","queryId":"q-inactive","bodyIds":["body-inactive-currentness"]}');
	assert.deepEqual(inactive.closes, [{ code: 1008, reason: "body is not active" }]);
	const foreign = presenceSocket("body-own-currentness", { socketId: "stale-currentness-foreign" });
	await staleRuntimeService([foreign.socket]).message(foreign.socket,
		'__YPS:{"type":"BODY_CURRENTNESS_QUERY","queryId":"q-foreign","bodyIds":["body-other"]}');
	assert.deepEqual(foreign.closes, [{ code: 1008, reason: "body currentness query authority mismatch" }]);
	const malformed = presenceSocket("root", { kind: "root", socketId: "stale-currentness-malformed" });
	await staleRuntimeService([malformed.socket]).message(malformed.socket,
		'__YPS:{"type":"BODY_CURRENTNESS_QUERY","queryId":"q-bad","bodyIds":["bad id!"]}');
	assert.deepEqual(malformed.closes, [{ code: 1008, reason: "socket authority mismatch" }],
		"an unparseable query is not runtime independent");
});

s.test("a socket admitted by an earlier runtime still relays its own awareness", async () => {
	const documentId = "body-presence-after-wake";
	const source = presenceSocket(documentId, { awarenessClientId: 701, socketId: "wake-source" });
	const peer = presenceSocket(documentId, { deviceId: "peer-device", socketId: "wake-peer" });
	await staleRuntimeService([source.socket, peer.socket]).message(source.socket, awarenessFrame([{ clientId: 701, state: null }]));
	assert.deepEqual(source.closes, []);
	assert.deepEqual(relayedAwareness(peer.sent), [{ clientId: 701, state: null }]);
});

s.test("runtime-independent liveness keeps body activity and semantic epoch fences", async () => {
	const inactive = presenceSocket("body-inactive-after-wake", { socketId: "wake-inactive" });
	await staleRuntimeService([inactive.socket], { isActiveBody: () => false })
		.message(inactive.socket, '__YPS:{"type":"VAULT_PING","probeId":"probe-inactive-after-wake"}');
	assert.deepEqual(inactive.closes, [{ code: 1008, reason: "body is not active" }]);
	assert.equal(inactive.sent.length, 0);
	const retired = presenceSocket("body-retired-after-wake", { socketId: "wake-retired" });
	await staleRuntimeService([retired.socket], {
		currentBodyHead: (bodyId: string) => ({ bodyId, bodyEpoch: 2, lifecycle: "active",
			generation: 2, contentHash: null, size: null, sequence: 2 }),
	}).message(retired.socket, '__YPS:{"type":"VAULT_PING","probeId":"probe-retired-after-wake"}');
	assert.deepEqual(retired.closes, [{ code: SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE, reason: "semantic epoch reset" }]);
	assert.equal(JSON.parse((retired.sent[0] as string).slice(6)).type, "SEMANTIC_EPOCH_RESET_REQUIRED");
});

s.test("a revoked device's ping is answered with authority_superseded, not a pong", async () => {
	for (const runtimeEpoch of [attachment.runtimeEpoch, "epoch-authority-after-wake"]) {
		const root = presenceSocket("root", { kind: "root", socketId: `revoked-${runtimeEpoch}` });
		const validated: string[] = [];
		await staleRuntimeService([root.socket], {
			runtimeEpoch,
			validateActor: (actor: { deviceId: string }) => { validated.push(actor.deviceId); return false; },
		}).message(root.socket, '__YPS:{"type":"VAULT_PING","probeId":"probe-revoked"}');
		assert.deepEqual(validated, [attachment.deviceId]);
		assert.equal(root.sent.length, 1);
		assert.deepEqual(JSON.parse((root.sent[0] as string).slice(6)), {
			type: "error", code: "authority_superseded", reason: "socket authority superseded",
		});
		assert.deepEqual(root.closes, [{ code: AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE, reason: "socket authority superseded" }]);
	}
});

s.test("commit notices close sockets admitted by an earlier runtime that cannot take a catch-up hint", () => {
	const bodyId = "body-committed-after-wake";
	const current = presenceSocket("root", { kind: "root", socketId: "commit-current", runtimeEpoch: "epoch-authority-after-wake" });
	const stale = presenceSocket("root", { kind: "root", socketId: "commit-stale" });
	staleRuntimeService([current.socket, stale.socket], {
		cache: { get: () => undefined },
		currentBodyHead: (id: string) => ({ bodyId: id, bodyEpoch: 1, lifecycle: "active",
			generation: 4, contentHash: "b".repeat(64), size: 3, sequence: 9 }),
	}).notifyBodyCommitted(bodyId, 4, 9);
	const notice = JSON.parse((current.sent[0] as string).slice(6));
	assert.equal(notice.type, "BODY_COMMITTED");
	assert.equal(notice.runtimeEpoch, "epoch-authority-after-wake");
	assert.deepEqual(current.closes, []);
	assert.equal(stale.sent.length, 0, "an old client would discard both the notice and an unknown hint");
	assert.deepEqual(stale.closes, [{ code: 1008, reason: "socket authority mismatch" }]);
});

s.test("a capable stale-runtime socket gets a receipt-free catch-up hint and stays open", () => {
	const bodyId = "body-hinted-after-wake";
	const current = presenceSocket("root", { kind: "root", socketId: "hint-current", runtimeEpoch: "epoch-authority-after-wake",
		catchUpHint: true });
	const staleRoot = presenceSocket("root", { kind: "root", socketId: "hint-stale-root", catchUpHint: true });
	const staleBody = presenceSocket(bodyId, { socketId: "hint-stale-body", catchUpHint: true });
	const otherBody = presenceSocket("body-unrelated", { socketId: "hint-other-body", catchUpHint: true });
	staleRuntimeService([current.socket, staleRoot.socket, staleBody.socket, otherBody.socket], {
		cache: { get: () => undefined },
		currentBodyHead: (id: string) => ({ bodyId: id, bodyEpoch: 1, lifecycle: "active",
			generation: 4, contentHash: "b".repeat(64), size: 3, sequence: 9 }),
	}).notifyBodyCommitted(bodyId, 4, 9);
	assert.equal(JSON.parse((current.sent[0] as string).slice(6)).type, "BODY_COMMITTED",
		"a current-runtime socket keeps receiving the receipt-bearing notice");
	for (const stale of [staleRoot, staleBody]) {
		assert.deepEqual(stale.closes, [], "no reconnect wave per wake");
		assert.equal(stale.sent.length, 1);
		const hint = JSON.parse((stale.sent[0] as string).slice(6));
		assert.deepEqual(hint, {
			type: "BODY_CHANGED_HINT", bodyId, bodyEpoch: 1, vaultGeneration: attachment.vaultGeneration,
			durableGeneration: 4, vaultSequence: 9,
		}, "no runtime epoch, content hash or size: never a receipt or promotion proof");
		assert.deepEqual(parseBodyChangedHintFrame(hint), hint);
	}
	assert.equal(otherBody.sent.length, 0);
});

s.test("client socket capabilities are parsed from the upgrade query and recorded at admission", async () => {
	assert.deepEqual([...parseSocketClientCapabilities("catchupHint, future_cap,bad cap,")], ["catchupHint", "future_cap"]);
	assert.equal(parseSocketClientCapabilities(null).size, 0);
	assert.equal(parseSocketClientCapabilities("x".repeat(600)).size, 0);
	const admitted: VaultSocketAttachment[] = [];
	const service = (): VaultSocketService => new VaultSocketService({
		crdtEngine: testCrdtEngine,
		sockets: {
			sockets: () => [],
			createPair: () => ({ client: {}, server: {
				serializeAttachment: (value: unknown) => { admitted.push(value as VaultSocketAttachment); },
				deserializeAttachment: () => admitted.at(-1),
				send: () => {},
				close: () => {},
			} }),
			accept: () => {},
			upgradeResponse: () => new Response(null, { status: 200 }),
		},
		cache: { admitBody: () => true, load: () => ({ semanticEpoch: 1, generation: 1,
			doc: testCrdtEngine.createDocument("capability-admission") }) },
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		validateActor: () => true,
		now: () => 1_234,
	} as never);
	service().accept("body-capable", "body", 1, "device-capable", { capabilities: parseSocketClientCapabilities("catchupHint") });
	service().accept("body-legacy", "body", 1, "device-legacy");
	assert.equal(admitted[0]!.catchUpHint, true);
	assert.equal(admitted[0]!.admittedAt, 1_234);
	assert.equal(admitted[1]!.catchUpHint, undefined, "an old client that advertised nothing keeps the close fallback");
	assert.deepEqual(parseVaultSocketAttachment(admitted[0]), admitted[0]);
	assert.equal(parseVaultSocketAttachment({ ...admitted[0], catchUpHint: "yes" }), null);
});

s.test("root liveness refreshes the device's lastSeenAt at most once per resolution window", async () => {
	let now = 10 * 60_000;
	const touched: string[] = [];
	const root = presenceSocket("root", { kind: "root", socketId: "touch-root", lastSeenTouchedAt: 0 });
	const body = presenceSocket("body-touch", { socketId: "touch-body", lastSeenTouchedAt: 0 });
	const service = staleRuntimeService([root.socket, body.socket], {
		runtimeEpoch: attachment.runtimeEpoch,
		touchDevice: (deviceId: string) => { touched.push(deviceId); },
		now: () => now,
	});
	const ping = '__YPS:{"type":"VAULT_PING","probeId":"probe-touch"}';
	await service.message(root.socket, ping);
	assert.deepEqual(touched, [attachment.deviceId]);
	assert.equal(root.current().lastSeenTouchedAt, now, "recorded on the socket, so it survives hibernation");
	now += 60_000;
	await service.message(root.socket, ping);
	await service.message(body.socket, ping);
	assert.deepEqual(touched, [attachment.deviceId], "coalesced; body sockets never touch");
	now += 5 * 60_000;
	await service.message(root.socket, ping);
	assert.equal(touched.length, 2);
	assert.equal(root.sent.filter((message) => typeof message === "string" && message.includes("VAULT_PONG")).length, 3);
});

s.test("the Durable Object reciprocates a peer-initiated close", () => {
	const closes: unknown[][] = [];
	let runtimeCloses = 0;
	const server = Object.create(VaultSyncServer.prototype) as VaultSyncServer;
	const closedSockets: unknown[] = [];
	Object.defineProperty(server, "runtime", { value: { webSocketClose: (closed: unknown) => {
		runtimeCloses++;
		closedSockets.push(closed);
	} } });
	const socket = { close: (...args: unknown[]) => { closes.push(args); } };
	server.webSocketClose(socket as never, 1000, "client done");
	server.webSocketClose(socket as never, 4403, "device authority changed");
	server.webSocketClose(socket as never, 1005, "");
	server.webSocketClose(socket as never, 1006, "");
	assert.deepEqual(closes, [[1000, "client done"], [4403, "device authority changed"], [], []],
		"reserved codes are answered with a code-less close frame");
	const closed = { close: () => { throw new Error("WebSocket already closed"); } };
	assert.doesNotThrow(() => server.webSocketClose(closed as never, 1000, ""));
	assert.equal(runtimeCloses, 5);
	assert.equal(closedSockets[0], socket, "the runtime learns which socket closed (presence removal)");
	const refused: unknown[][] = [];
	const picky = { close: (...args: unknown[]) => {
		refused.push(args);
		if (args.length > 0) throw new Error("invalid close reason");
	} };
	assert.doesNotThrow(() => server.webSocketClose(picky as never, 1000, "r".repeat(200)));
	assert.deepEqual(refused, [[1000, "r".repeat(200)], []], "a refused echo falls back to a code-less close");
});

await s.done();
