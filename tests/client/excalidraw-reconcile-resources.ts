import { strict as assert } from "node:assert";
import { ExcalidrawRevisionEquivocationError, reconcileExcalidrawElements,
	expandExcalidrawDependencyClosure, selectExcalidrawWinner } from "../../src/sync/excalidraw/reconcile";
import { SameVaultExcalidrawResources, type ExcalidrawResourceStorePort } from "../../src/sync/excalidraw/resources";
import type { ExcalidrawElementRecord, ExcalidrawNativeFile } from "../../src/sync/excalidraw/types";
import { suite } from "../harness.ts";

const s = suite("excalidraw-reconcile-resources");

function element(version: number, nonce: number, text: string, isDeleted = false): ExcalidrawElementRecord {
	return { id: "element1", version, versionNonce: nonce, isDeleted, index: "a0", text };
}

s.test("uses upstream lower-nonce ties, retains tombstones, and rejects equivocation", () => {
	assert.equal(selectExcalidrawWinner(element(7, 200, "high"), element(7, 100, "low")), "candidate");
	assert.equal(reconcileExcalidrawElements([element(1, 9, "live")], [element(2, 8, "deleted", true)])[0]?.isDeleted, true);
	assert.throws(() => selectExcalidrawWinner(element(7, 100, "left"), element(7, 100, "right")),
		ExcalidrawRevisionEquivocationError);
});

s.test("expands changed records through reciprocal binding, container, frame, and group closure", () => {
	const scene: ExcalidrawElementRecord[] = [
		{ ...element(2, 10, "rectangle"), boundElements: [{ id: "arrow1", type: "arrow" }] },
		{ id: "arrow1", version: 1, versionNonce: 20, isDeleted: false, index: "b0",
			startBinding: { elementId: "element1" }, groupIds: ["group1"] },
		{ id: "label1", version: 1, versionNonce: 30, isDeleted: false, index: "c0",
			containerId: "element1", frameId: "frame1" },
		{ id: "frame1", version: 1, versionNonce: 40, isDeleted: false, index: "d0", groupIds: ["group1"] },
	];
	assert.deepEqual(expandExcalidrawDependencyClosure(scene, [scene[0]!]).map((value) => value.id),
		["element1", "arrow1", "label1", "frame1"]);
});

class Store implements ExcalidrawResourceStorePort {
	objects = new Map<string, Uint8Array>();
	async put(hash: string, bytes: Uint8Array, _mime: string): Promise<void> { this.objects.set(hash, bytes.slice()); }
	async get(hash: string, _size: number, _mime: string): Promise<Uint8Array | null> {
		return this.objects.get(hash)?.slice() ?? null;
	}
	async resolveVaultResource(_entry: import("@shared/excalidrawProtocol").ExcalidrawVaultResource): Promise<ExcalidrawNativeFile | null> {
		return null;
	}
}

s.test("publishes immutable embedded resources and degrades missing attachments without blocking scene data", async () => {
	const store = new Store();
	const resources = new SameVaultExcalidrawResources(store);
	const file: ExcalidrawNativeFile = { id: "resource1", dataURL: "data:image/png;base64,aGVsbG8=",
		mimeType: "image/png", created: 10 };
	const manifest = await resources.publish([file]);
	assert.equal(manifest.entries[0]?.kind, "embedded");
	const available = await resources.resolve(manifest);
	assert.equal(available.files[0]?.dataURL, file.dataURL);
	store.objects.clear();
	const missing = await resources.resolve(manifest);
	assert.deepEqual(missing.files, []);
	assert.deepEqual(missing.unavailable.map((entry) => entry.resourceId), ["resource1"]);
});

s.test("vault references resolve only through the same-vault resolver and never recurse", async () => {
	const resolved: string[] = [];
	const store = new Store();
	store.resolveVaultResource = async (entry) => {
		resolved.push(entry.fileId);
		return { id: entry.resourceId, dataURL: "data:image/png;base64,YQ==", mimeType: "image/png", created: 1 };
	};
	const resources = new SameVaultExcalidrawResources(store);
	const result = await resources.resolve({ version: 1, entries: [
		{ kind: "vault", resourceId: "resource1", fileId: "file1" },
	] });
	assert.deepEqual(resolved, ["file1"]);
	assert.equal(result.files.length, 1);
});

await s.done();
