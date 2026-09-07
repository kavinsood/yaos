import { strict as assert } from "node:assert";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { encodeRootPathPublicationUpdate } from "../../server/src/server";
import { VaultDocumentCachePressureError } from "../../server/src/vaultDocumentCache";
import {
	parseVaultSocketAttachment,
	rootUpdateChangesProtectedAttachmentMaps,
	rootUpdateHasSafeAttachmentSemantics,
	rootUpdateChangesDocument,
	type VaultSocketPort,
	type VaultSocketRegistryPort,
	VaultSocketService,
} from "../../server/src/vaultSocketService";
import { suite } from "../harness.ts";

const s = suite("vault-route-authority");

const attachment = {
	vaultId: "vault-authority-0001",
	vaultGeneration: "generation-authority-0001",
	runtimeEpoch: "epoch-authority-0001",
	documentId: "root",
	kind: "root" as const,
	deviceId: "device-authority-0001",
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
	const current = new Y.Doc({ guid: "root" });
	current.getMap("sys").set("schemaVersion", 6);
	const duplicate = Y.encodeStateAsUpdate(current);
	assert.equal(rootUpdateChangesDocument(current, duplicate), false);
	const changed = new Y.Doc({ guid: "root" });
	Y.applyUpdate(changed, duplicate);
	const vector = Y.encodeStateVector(changed);
	changed.getMap("pathToId").set("ghost.md", "ghost-body");
	assert.equal(rootUpdateChangesDocument(current, Y.encodeStateAsUpdate(changed, vector)), true);
	current.destroy();
	changed.destroy();
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
			? { bodyId, lifecycle: "active", generation: 7, contentHash: "a".repeat(64), size: 12, sequence: 19 }
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
		const response = service.accept("body-pressure", "body", "device-pressure");
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
	const countResponse = countService.accept("body-count", "body", "device-pressure");
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
		() => service.accept("body-unknown", "body", "device-pressure"),
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
	const empty = new Y.Doc({ guid: "empty-root" });
	assert.equal(rootUpdateChangesProtectedAttachmentMaps(empty, safeUpdate), true);
	assert.equal(rootUpdateHasSafeAttachmentSemantics(empty, safeUpdate), true);
	const unsafe = new Y.Doc({ guid: "unsafe-root" });
	Y.applyUpdate(unsafe, Y.encodeStateAsUpdate(root));
	const unsafeVector = Y.encodeStateVector(unsafe);
	unsafe.getMap("pathToBlob").set("../escape", { hash: "b".repeat(64), size: 1 });
	assert.equal(rootUpdateHasSafeAttachmentSemantics(root, Y.encodeStateAsUpdate(unsafe, unsafeVector)), false);
	root.destroy();
	empty.destroy();
	unsafe.destroy();
});

s.test("body sockets reject invalid semantic roots before queue, apply, broadcast, or flush", async () => {
	const bodyId = "body-semantic-authority-0001";
	const loaded = new Y.Doc({ guid: bodyId });
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
			load: () => ({ doc: loaded, generation: 1 }),
			queue: () => { queued++; return { ok: true }; },
		},
		vaultId: () => attachment.vaultId,
		vaultGeneration: () => attachment.vaultGeneration,
		runtimeEpoch: attachment.runtimeEpoch,
		isActiveBody: () => true,
		isDeviceRevoked: () => false,
		scheduleFlush: () => { flushes++; },
	} as never);
	await service.message(bodySocket, frame.slice().buffer);
	assert.deepEqual(close, { code: 1008, reason: "invalid semantic frontmatter" });
	assert.equal(queued, 0);
	assert.equal(flushes, 0);
	assert.equal(loaded.share.has("frontmatter:future-root"), false);
	assert.equal(sent.length, 1, "only the typed rejection is sent; no document update is broadcast");
	assert.equal(JSON.parse((sent[0] as string).slice(6)).code, "frontmatter_semantic_root_invalid");
	loaded.destroy();
	malicious.destroy();
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
		close: (_code: number, reason: string) => { closed.push(`${deviceId}:${documentId}:${reason}`); },
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
		"device-revoked:root:device membership revoked",
		"device-revoked:body-revoked:device membership revoked",
	]);
});

await s.done();
