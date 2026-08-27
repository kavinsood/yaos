import * as Y from "yjs";
import type { ConnectedDocument } from "./schema4Live.ts";
import { requireLiveIdentityContext } from "./liveIdentity.ts";
import {
	bootstrapFromSql,
	connectDocument,
	createBody,
	mutateLifecycle,
	requestJson,
	sha256Hex,
	submitBodyUpdate,
	waitFor,
	vaultRoute,
} from "./schema4Live.ts";

const { deviceA, deviceB } = requireLiveIdentityContext();
const bodyId = `body_live_${crypto.randomUUID().replaceAll("-", "_")}`;
const originalPath = "live/schema4-smoke.md";
const renamedPath = "live/schema4-renamed.md";
const initialContent = "schema 4 from device A";
const editFromB = "\nedit from device B";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

console.log("\n--- Schema-4 two-device durable root/body handoff ---");
const rootA = await connectDocument(deviceA, "root", "root");
let bodyA: ConnectedDocument | null = null;
let rootB: ConnectedDocument | null = null;
let bodyB: ConnectedDocument | null = null;
try {
	const created = await createBody(deviceA, bodyId, originalPath, initialContent);
	assert(created.lifecycle === "active" && created.path === originalPath, "device A admits a body candidate before publishing its root path");
	await waitFor(() => rootA.doc.getMap<string>("pathToId").get(originalPath) === bodyId, "device A root publication");
	assert(rootA.doc.getMap<string>("pathToId").get(originalPath) === bodyId, "root socket receives the published file identity");

	bodyA = await connectDocument(deviceA, "body", bodyId);
	assert(bodyA.doc.getText("body").toString() === initialContent, "device A body socket reads the durable candidate");

	const cold = await bootstrapFromSql(deviceB);
	try {
		const entry = cold.entries.find((candidate) => candidate.bodyId === bodyId);
		assert(entry?.path === originalPath && entry.lifecycle === "active", "device B cold bootstraps the active SQL catalog");
		assert(cold.root.getMap<string>("pathToId").get(originalPath) === bodyId, "device B cold bootstraps the SQL root document");
		assert(cold.bodies.get(bodyId)?.getText("body").toString() === initialContent, "device B cold bootstraps the SQL body document");

		rootB = await connectDocument(deviceB, "root", "root", cold.root);
		const bootstrappedBody = cold.bodies.get(bodyId);
		if (!bootstrappedBody) throw new Error("bootstrap omitted smoke body");
		bodyB = await connectDocument(deviceB, "body", bodyId, bootstrappedBody);
		cold.bodies.delete(bodyId);
	} finally {
		for (const body of cold.bodies.values()) body.destroy();
		if (!rootB) cold.root.destroy();
	}
	if (!rootB || !bodyB) throw new Error("device B bootstrap sockets were not established");

	bodyB.provider.disconnect();
	const beforeEdit = Y.encodeStateVector(bodyB.doc);
	bodyB.doc.getText("body").insert(bodyB.doc.getText("body").length, editFromB);
	const editUpdate = Y.encodeStateAsUpdate(bodyB.doc, beforeEdit);
	const editResponse = await submitBodyUpdate(deviceB, bodyId, editUpdate);
	assert(editResponse.status === 200, `device B durably submits an edit (${editResponse.status})`);
	await waitFor(
		() => bodyA!.doc.getText("body").toString() === initialContent + editFromB,
		"device A body catch-up",
	);
	assert(bodyA.doc.getText("body").toString() === initialContent + editFromB, "device A catches up through its body socket");

	const rename = await mutateLifecycle(deviceB, {
		operationId: `rename-${crypto.randomUUID()}`,
		kind: "rename",
		fileId: bodyId,
		bodyId,
		fromPath: originalPath,
		toPath: renamedPath,
	});
	assert(rename.path === renamedPath, "rename commits against the durable catalog");
	await waitFor(
		() => rootA.doc.getMap<string>("pathToId").get(renamedPath) === bodyId
			&& !rootA.doc.getMap<string>("pathToId").has(originalPath),
		"renamed root publication",
	);
	assert(rootB.doc.getMap<string>("pathToId").get(renamedPath) === bodyId, "both root sockets observe the rename");

	const attachmentPath = "live/schema4-attachment.bin";
	const attachmentBytes = new TextEncoder().encode("schema-4 attachment");
	const attachmentHash = await sha256Hex(attachmentBytes);
	const upload = await fetch(vaultRoute(deviceA, `blobs/${attachmentHash}`), {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${deviceA.deviceToken}`,
			"Content-Type": "application/octet-stream",
		},
		body: attachmentBytes,
	});
	assert(upload.status === 204, "device A uploads generation-scoped attachment bytes");
	const attachmentPublication = await requestJson(deviceA, "attachments/publish", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			operationId: `attachment-${crypto.randomUUID()}`,
			kind: "upsert",
			path: attachmentPath,
			hash: attachmentHash,
			size: attachmentBytes.byteLength,
			mime: "application/octet-stream",
		}),
	});
	assert(attachmentPublication.response.status === 200, "attachment catalog publishes through the durable root command");
	await waitFor(() => rootA.doc.getMap("pathToBlob").has(attachmentPath)
		&& rootB!.doc.getMap("pathToBlob").has(attachmentPath), "attachment root publication");
	const attachmentDelete = await requestJson(deviceA, "attachments/publish", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			operationId: `attachment-delete-${crypto.randomUUID()}`,
			kind: "delete",
			path: attachmentPath,
		}),
	});
	assert(attachmentDelete.response.status === 200, "attachment deletion publishes through the durable root command");
	await waitFor(() => !rootA.doc.getMap("pathToBlob").has(attachmentPath)
		&& rootA.doc.getMap("blobTombstones").has(attachmentPath), "attachment tombstone publication");

	const staleVector = Y.encodeStateVector(bodyB.doc);
	bodyB.doc.getText("body").insert(bodyB.doc.getText("body").length, "\nstale-after-delete");
	const staleUpdate = Y.encodeStateAsUpdate(bodyB.doc, staleVector);
	const deleted = await mutateLifecycle(deviceA, {
		operationId: `delete-${crypto.randomUUID()}`,
		kind: "delete",
		fileId: bodyId,
		bodyId,
	});
	assert(deleted.lifecycle === "tombstoned", "delete tombstones the catalog identity");
	await waitFor(() => !rootA.doc.getMap<string>("pathToId").has(renamedPath), "deleted root publication");
	const staleResponse = await submitBodyUpdate(deviceB, bodyId, staleUpdate);
	assert(staleResponse.status === 409, `a stale body candidate is rejected after delete (${staleResponse.status})`);
	const staleBody = await fetch(`${deviceB.host}/vault/${encodeURIComponent(deviceB.vaultId)}/body/${encodeURIComponent(bodyId)}`, {
		headers: { Authorization: `Bearer ${deviceB.deviceToken}` },
	});
	assert(staleBody.status === 404, "deleted body is no longer readable from durable storage");
	const attackerRoot = rootA.doc.getMap<string>("pathToId");
	attackerRoot.set("live/ghost.md", "ghost-body");
	await new Promise((resolve) => setTimeout(resolve, 250));
	const durableRootResponse = await fetch(vaultRoute(deviceA, "root"), {
		headers: { Authorization: `Bearer ${deviceA.deviceToken}` },
	});
	const durableRoot = new Y.Doc({ guid: "durable-root-check" });
	Y.applyUpdate(durableRoot, new Uint8Array(await durableRootResponse.arrayBuffer()));
	assert(!durableRoot.getMap("pathToId").has("live/ghost.md"), "root socket cannot bypass durable lifecycle publication");
	durableRoot.destroy();
} finally {
	bodyB?.destroy();
	rootB?.destroy();
	bodyA?.destroy();
	rootA.destroy();
}

console.log("\n✓ Schema-4 two-device durable smoke passed");
