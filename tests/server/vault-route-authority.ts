import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { encodeRootPathPublicationUpdate } from "../../server/src/server";
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
	current.getMap("sys").set("schemaVersion", 4);
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
	root.getMap("pathToBlob").set("assets/image.png", { hash: "a".repeat(64), size: 1 });
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
