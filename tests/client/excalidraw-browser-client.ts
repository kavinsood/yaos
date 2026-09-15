import { strict as assert } from "node:assert";
import { PublicShareBrowserClient } from "../../src/sync/excalidraw/browserClient";
import type { BrowserExcalidrawApi } from "../../src/sync/excalidraw/browserHost";
import { PublicShareExcalidrawTransport, type BrowserFetchResponse } from "../../src/sync/excalidraw/browserTransport";
import { MemoryExcalidrawPersistence } from "../../src/sync/excalidraw/persistence";
import type { ExcalidrawResourcesPort } from "../../src/sync/excalidraw/host";
import type { ExcalidrawElementRecord } from "../../src/sync/excalidraw/types";
import { suite } from "../harness.ts";

const s = suite("excalidraw-browser-client");

function response(status: number, value: unknown): BrowserFetchResponse {
	return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => value,
		arrayBuffer: async () => new ArrayBuffer(0) };
}

class Socket {
	readyState = 1;
	onopen: ((event: Event) => unknown) | null = null;
	onmessage: ((event: MessageEvent) => unknown) | null = null;
	onerror: ((event: Event) => unknown) | null = null;
	onclose: ((event: CloseEvent) => unknown) | null = null;
	constructor(_url: string | URL) {}
	send(_value: string) {}
	close() {}
}

class Api implements BrowserExcalidrawApi {
	elements: ExcalidrawElementRecord[] = [];
	getSceneElementsIncludingDeleted() { return this.elements; }
	getFiles() { return {}; }
	addFiles() {}
	updateScene(scene: { elements?: readonly ExcalidrawElementRecord[] }) {
		if (scene.elements) this.elements = structuredClone([...scene.elements]);
	}
}

const resources: ExcalidrawResourcesPort = {
	publish: async () => ({ version: 1, entries: [] }),
	resolve: async () => ({ files: [], unavailable: [] }),
};

s.test("existing RFC13 engine durably queues a browser edit then exports it after server downgrade rejection", async () => {
	const persistence = new MemoryExcalidrawPersistence();
	let batchRequests = 0;
	const transport = new PublicShareExcalidrawTransport("https://share.example", {
		publicDrawingId: "public1", drawingEpoch: 1, permission: "read-write", expiresAt: 10_000, grantRevision: 1,
	}, { WebSocketImpl: Socket as never, fetcher: async (url) => {
		if (url.endsWith("/batch")) { batchRequests++; return response(403, { error: "share_read_only" }); }
		return response(200, { drawingEpoch: 1, after: 0, through: 0, compactedThrough: 0,
			snapshotRequired: false, events: [], nextCursor: null });
	} });
	const client = new PublicShareBrowserClient({ session: { publicDrawingId: "public1", drawingEpoch: 1,
		permission: "read-write", expiresAt: 10_000, grantRevision: 1 }, persistence, transport, resources,
		now: () => 100 });
	const api = new Api();
	await client.start(api);
	const changed: ExcalidrawElementRecord = { id: "element1", version: 1, versionNonce: 10,
		isDeleted: false, index: "a0", type: "rectangle" };
	api.elements = [changed];
	client.handleSceneChange(api.elements, {}, {});
	await client.host.drainCallbacks();
	await client.drainAuthority();
	assert.equal(batchRequests, 1);
	assert.deepEqual(await persistence.listOutbox("public1"), []);
	const exported = await client.exportRejectedWork();
	assert.equal(exported.value.operations.length, 1);
	assert.equal(exported.value.operations[0]?.elements[0]?.id, "element1");
	assert.equal(client.host.isWritable(), false);
});

s.test("read-only startup treats browser canvas as projection, never as local scene authority", async () => {
	const persistence = new MemoryExcalidrawPersistence();
	const transport = new PublicShareExcalidrawTransport("https://share.example", {
		publicDrawingId: "public1", drawingEpoch: 1, permission: "read-only", expiresAt: 10_000, grantRevision: 1,
	}, { WebSocketImpl: Socket as never, fetcher: async () => response(200, { drawingEpoch: 1, after: 0, through: 0,
		compactedThrough: 0, snapshotRequired: false, events: [], nextCursor: null }) });
	const client = new PublicShareBrowserClient({ session: { publicDrawingId: "public1", drawingEpoch: 1,
		permission: "read-only", expiresAt: 10_000, grantRevision: 1 }, persistence, transport, resources });
	const api = new Api();
	api.elements = [{ id: "untrusted-cache", version: 99, versionNonce: 1, isDeleted: false }];
	await client.start(api);
	assert.deepEqual(await persistence.listOutbox("public1"), []);
	assert.deepEqual(api.elements, [], "canonical empty projection replaces untrusted browser-local scene");
	client.stop();
});

await s.done();
