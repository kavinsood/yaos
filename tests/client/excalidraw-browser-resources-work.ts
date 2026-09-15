import { strict as assert } from "node:assert";
import { PublicShareExcalidrawResources } from "../../src/sync/excalidraw/browserResources";
import { PublicShareWorkPreserver } from "../../src/sync/excalidraw/browserWork";
import { MemoryExcalidrawPersistence } from "../../src/sync/excalidraw/persistence";
import type { BrowserFetchResponse } from "../../src/sync/excalidraw/browserTransport";
import type { ExcalidrawBatchRequest } from "../../src/sync/excalidraw/types";
import { sha256BytesHex } from "../../src/utils/sha256";
import { suite } from "../harness.ts";

const s = suite("excalidraw-browser-resources-work");

function response(status: number, bytes: Uint8Array, headers = new Headers()): BrowserFetchResponse {
	const body = bytes.slice().buffer;
	return { ok: status >= 200 && status < 300, status, headers, json: async () => ({}), arrayBuffer: async () => body };
}

s.test("public resources upload with digest and resolve only through manifest-bound public IDs", async () => {
	const bytes = new TextEncoder().encode("png-bytes");
	const hash = await sha256BytesHex(bytes);
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const resources = new PublicShareExcalidrawResources("https://share.example", () => "read-write", async (url, init) => {
		calls.push({ url, init });
		return init?.method === "POST" ? response(204, new Uint8Array())
			: response(200, bytes, new Headers({ "x-yaos-content-sha256": hash }));
	});
	const dataURL = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
	const manifest = await resources.publish([{ id: "public-resource-1", dataURL, mimeType: "image/png", created: 1 }]);
	assert.equal((calls[0]?.init?.headers as Record<string, string>)["x-yaos-content-sha256"], hash);
	assert.equal(calls[0]?.url, "https://share.example/api/excalidraw/shares/session/resources");
	const resolved = await resources.resolve(manifest);
	assert.equal(resolved.files[0]?.id, "public-resource-1");
	assert.deepEqual(resolved.unavailable, []);
});

s.test("resource substitution degrades explicitly and vault locators are never resolved publicly", async () => {
	const resources = new PublicShareExcalidrawResources("https://share.example", () => "read-only",
		async () => response(200, new TextEncoder().encode("wrong")));
	const resolved = await resources.resolve({ version: 1, entries: [
		{ kind: "embedded", resourceId: "public-resource-1", contentHash: "a".repeat(64), size: 5,
			mime: "image/png", created: 1 },
		{ kind: "vault", resourceId: "private-resource", fileId: "private-file" },
	] });
	assert.equal(resolved.files.length, 0);
	assert.equal(resolved.unavailable.length, 2);
});

s.test("downgrade preserves exact durable outbox operations and exports no authority secret", async () => {
	const persistence = new MemoryExcalidrawPersistence();
	const operation: ExcalidrawBatchRequest = { protocolVersion: 1, operationId: "operation1",
		requestDigest: "a".repeat(64), drawingEpoch: 1, elements: [] };
	await persistence.putOutbox({ drawingId: "public1", operation, createdAt: 1, attempts: 2, lastAttemptAt: 2 });
	const preserver = new PublicShareWorkPreserver(persistence, "public1", () => 10);
	let stopped = false;
	const preserved = await preserver.handleAuthority({ state: "active", permission: "read-only",
		grantRevision: 2, expiresAt: 100 }, () => { stopped = true; }, 1);
	assert.equal(stopped, true);
	assert.equal(preserved[0]?.operation.operationId, "operation1");
	assert.deepEqual(await persistence.listOutbox("public1"), []);
	const exported = await preserver.exportPreserved();
	assert.equal(exported.value.operations[0]?.operationId, "operation1");
	assert.equal(exported.text.includes("routeEnvelope"), false);
	assert.equal(exported.text.includes("linkSecret"), false);
});

await s.done();
