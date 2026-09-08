import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { canonicalCanvasBytes, parseCanvasBytes } from "../../../server/src/shared/canvasCodec.ts";
import { applyCanvasSnapshot, createCanvasDocument, materializeCanvasDocument } from "../../../server/src/shared/canvasSemanticDocument.ts";
import { bearer, connectDocument, pass, sha256Hex, vaultJson, vaultUrl, waitFor } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const encoder = new TextEncoder();
const path = "Conformance.canvas";
const renamedPath = "Conformance Renamed.canvas";
const documentId = `canvas_${crypto.randomUUID().replaceAll("-", "")}`;

function semantic(text: string) {
	const parsed = parseCanvasBytes(encoder.encode(JSON.stringify({ nodes: [
		{ id: "node", type: "text", text, x: 0, y: 0, width: 200, height: 80 },
	], edges: [], futureRoot: { preserved: true } })));
	assert.equal(parsed.kind, "valid");
	if (parsed.kind !== "valid") throw new Error("Canvas fixture is invalid");
	return parsed.data;
}

async function submit(identity: typeof target.deviceA, update: Uint8Array, candidateId: string,
	creation?: { path: string; operationId: string }): Promise<Record<string, unknown>> {
	const candidateDigest = await sha256Hex(update);
	const headers: Record<string, string> = {
		"content-type": "application/octet-stream",
		"x-yaos-candidate-id": candidateId,
		"x-yaos-candidate-digest": candidateDigest,
		"x-yaos-body-epoch": "1",
	};
	if (creation) {
		headers["x-yaos-semantic-create-path"] = creation.path;
		headers["x-yaos-semantic-operation-id"] = creation.operationId;
		headers["x-yaos-operation-digest"] = "a".repeat(64);
	}
	const result = await vaultJson(identity, `semantic/${encodeURIComponent(documentId)}/candidate`, {
		method: "POST", headers, body: update,
	});
	assert.equal(result.response.status, 200, JSON.stringify(result.body));
	assert.ok(result.body);
	return result.body;
}

const document = createCanvasDocument(semantic("created"));
const creation = await submit(target.deviceA, Y.encodeStateAsUpdate(document),
	`candidate_${crypto.randomUUID().replaceAll("-", "")}`,
	{ path, operationId: `create_${crypto.randomUUID().replaceAll("-", "")}` });
assert.equal(creation.kind, "canvas");
assert.equal(creation.format, "json-canvas");
assert.equal(creation.durableGeneration, 1);
pass("semantic Canvas creation commits candidate, catalog, root, and exact receipt");

const stateResponse = await fetch(vaultUrl(target.deviceB, `semantic/${encodeURIComponent(documentId)}/state`),
	{ headers: bearer(target.deviceB) });
assert.equal(stateResponse.status, 200);
assert.equal(stateResponse.headers.get("x-yaos-document-id"), documentId);
const stateBytes = new Uint8Array(await stateResponse.arrayBuffer());
assert.ok(stateBytes.byteLength > 0);
Y.applyUpdate(document, stateBytes);
assert.equal((await materializeCanvasDocument(document)).nodes.get("node")?.text, "created");
pass("a second runtime peer reads the exact validated semantic Canvas state");

const liveA = await connectDocument(target.deviceA, "semantic", documentId);
const liveB = await connectDocument(target.deviceB, "semantic", documentId);
try {
	const liveVector = Y.encodeStateVector(liveA.doc);
	const liveNode = liveA.doc.getMap<Y.Map<unknown>>("nodes").get("node");
	const liveText = liveNode?.get("text") as { length: number; delete(index: number, length: number): void;
		insert(index: number, value: string): void } | undefined;
	assert.ok(liveText);
	liveA.doc.transact(() => {
		liveText.delete(0, liveText.length);
		liveText.insert(0, "live pending update");
	}, "live-peer-update");
	const liveUpdate = Y.encodeStateAsUpdate(liveA.doc, liveVector);
	assert.ok(liveUpdate.byteLength > 0);
	await waitFor(() => {
		const node = liveB.doc.getMap<Y.Map<unknown>>("nodes").get("node");
		return node?.get("text")?.toString() === "live pending update";
	},
		"semantic Canvas socket peer update");
	await waitFor(async () => {
		const response = await fetch(vaultUrl(target.deviceA, `semantic/${encodeURIComponent(documentId)}/head`),
			{ headers: bearer(target.deviceA) });
		const head = await response.json() as { generation?: unknown };
		return head.generation === 2;
	}, "semantic Canvas socket durability");
	Y.applyUpdate(document, liveUpdate);
	pass("semantic sockets relay pending Canvas updates and flush them durably");
} finally {
	liveB.destroy();
	liveA.destroy();
}

const vector = Y.encodeStateVector(document);
await applyCanvasSnapshot(document, semantic("updated by peer"), "peer-update");
const update = Y.encodeStateAsUpdate(document, vector);
const updated = await submit(target.deviceB, update, `candidate_${crypto.randomUUID().replaceAll("-", "")}`);
assert.equal(updated.durableGeneration, 3);
const canonical = canonicalCanvasBytes(await materializeCanvasDocument(document));
assert.equal(updated.contentHash, await sha256Hex(canonical));
assert.equal(updated.size, canonical.byteLength);
pass("peer semantic update advances durable generation and canonical content proof");

const renameOperationId = `rename_${crypto.randomUUID().replaceAll("-", "")}`;
const renamed = await vaultJson(target.deviceA, "semantic/lifecycle", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
		operationId: renameOperationId, requestDigest: "b".repeat(64), documentId,
		kind: "rename", bodyEpoch: 1, rootEpoch: 1, fromPath: path, toPath: renamedPath,
	}),
});
assert.equal(renamed.response.status, 200, JSON.stringify(renamed.body));
assert.equal(renamed.body?.resultPath, renamedPath);
const rootResponse = await fetch(vaultUrl(target.deviceB, "root"), { headers: bearer(target.deviceB) });
const root = new Y.Doc();
Y.applyUpdate(root, new Uint8Array(await rootResponse.arrayBuffer()));
assert.equal(root.getMap("pathToSemantic").get(path), undefined);
assert.deepEqual(root.getMap("pathToSemantic").get(renamedPath), {
	 documentId, kind: "canvas", format: "json-canvas", formatVersion: 1,
});
assert.equal(root.getMap("pathToBlob").has(renamedPath), false);
assert.equal(root.getMap("pathToId").has(renamedPath), false);
root.destroy();
pass("semantic Canvas rename retains identity and one exclusive root authority");

const deleted = await vaultJson(target.deviceB, "semantic/lifecycle", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
		operationId: `delete_${crypto.randomUUID().replaceAll("-", "")}`,
		requestDigest: "c".repeat(64), documentId, kind: "delete", bodyEpoch: 1, rootEpoch: 1,
	}),
});
assert.equal(deleted.response.status, 200, JSON.stringify(deleted.body));
assert.equal(deleted.body?.resultLifecycle, "tombstoned");
const inactive = await fetch(vaultUrl(target.deviceA, `semantic/${encodeURIComponent(documentId)}/state`),
	{ headers: bearer(target.deviceA) });
assert.equal(inactive.status, 404);
pass("semantic Canvas deletion tombstones catalog authority and closes state admission");

document.destroy();
