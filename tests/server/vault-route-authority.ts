import { strict as assert } from "node:assert";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { ywasmCrdtEngine as testCrdtEngine } from "../../packages/server-node/src/ywasmNodeCrdtEngine";
import { encodeRootPathPublicationUpdate } from "../../server/src/server";
import { AUTHORITY_SUPERSEDED_SOCKET_CLOSE_CODE } from "../../server/src/shared/socketCloseCodes";
import { MAX_CLIENT_MARKDOWN_BYTES } from "../../server/src/shared/durableLimits";
import { SEMANTIC_EPOCH_RESET_SOCKET_CLOSE_CODE } from "../../server/src/shared/semanticEpoch";
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
		encoding.writeVarString(payload, JSON.stringify(entry.state ?? { cursor: null }));
	}
	const frame = encoding.createEncoder();
	encoding.writeVarUint(frame, 1);
	encoding.writeVarUint8Array(frame, encoding.toUint8Array(payload));
	const bytes = encoding.toUint8Array(frame);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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

s.test("awareness rejects frames that claim multiple client identities", async () => {
	let close: { code: number; reason: string } | null = null;
	const socket: VaultSocketPort = {
		deserializeAttachment: () => ({ ...attachment, kind: "body" as const, documentId: "body-presence-multi-id" }),
		serializeAttachment: () => {},
		send: () => {},
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	await presenceService([socket]).message(socket, awarenessFrame([
		{ clientId: 101 },
		{ clientId: 102 },
	]));
	assert.deepEqual(close, { code: 1008, reason: "invalid awareness identity" });
});

s.test("awareness identity is immutable for the lifetime of a socket", async () => {
	let current: VaultSocketAttachment = { ...attachment, kind: "body" as const, documentId: "body-presence-stable-id" };
	let close: { code: number; reason: string } | null = null;
	const socket: VaultSocketPort = {
		deserializeAttachment: () => current,
		serializeAttachment: (value) => { current = value as VaultSocketAttachment; },
		send: () => {},
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	const service = presenceService([socket]);
	await service.message(socket, awarenessFrame([{ clientId: 201 }]));
	assert.equal(current.awarenessClientId, 201);
	await service.message(socket, awarenessFrame([{ clientId: 202 }]));
	assert.deepEqual(close, { code: 1008, reason: "awareness identity changed" });
});

s.test("awareness identity cannot be reused by another socket in the same room", async () => {
	const documentId = "body-presence-collision";
	const first: VaultSocketPort = {
		deserializeAttachment: () => ({ ...attachment, kind: "body" as const, documentId, awarenessClientId: 301 }),
		serializeAttachment: () => {},
		send: () => {},
		close: () => {},
	};
	let close: { code: number; reason: string } | null = null;
	const second: VaultSocketPort = {
		deserializeAttachment: () => ({ ...attachment, kind: "body" as const, documentId, socketId: "presence-collision-second" }),
		serializeAttachment: () => {},
		send: () => {},
		close: (code = 1000, reason = "") => { close = { code, reason }; },
	};
	await presenceService([first, second]).message(second, awarenessFrame([{ clientId: 301 }]));
	assert.deepEqual(close, { code: 1008, reason: "awareness identity already in use" });
});

await s.done();
