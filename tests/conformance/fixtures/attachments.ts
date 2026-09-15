import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { bearer, createVaultAndEnroll, pass, sha256Hex, vaultJson, vaultUrl, type JsonResult } from "../client.ts";
import { targetFromEnv, type DeviceIdentity } from "../target.ts";

const target = targetFromEnv();
type AttachmentMutation =
	| { operationId: string; kind: "upsert"; path: string; expectedRevision: string | null; hash: string; size: number; mime: string }
	| { operationId: string; kind: "delete"; path: string; expectedRevision: string | null }
	| { operationId: string; kind: "rename"; fromPath: string; toPath: string; expectedFromRevision: string; expectedToRevision: string | null };
type AttachmentRef = { hash: string; size: number; revision: string };
type AttachmentTombstone = { previousHash: string | null; revision: string };

function operationId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function attachmentJson(mutation: AttachmentMutation): string {
	return JSON.stringify({ ...mutation, rootEpoch: 1 });
}

async function uploadBlob(identity: DeviceIdentity, content: string): Promise<{ bytes: Uint8Array; hash: string }> {
	const blobBytes = new TextEncoder().encode(content);
	const blobHash = await sha256Hex(blobBytes);
	const response = await fetch(vaultUrl(identity, `blobs/${blobHash}`), {
		method: "PUT", headers: bearer(identity, { "content-type": "application/octet-stream" }), body: blobBytes,
	});
	assert.equal(response.status, 204);
	return { bytes: blobBytes, hash: blobHash };
}

async function publishUntilSettled(identity: DeviceIdentity, mutation: AttachmentMutation): Promise<JsonResult> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const result = await vaultJson(identity, "attachments/publish", {
			method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson(mutation),
		});
		if (result.response.status !== 503 || result.body?.error !== "attachment_mutation_busy") return result;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`attachment mutation remained busy: ${mutation.operationId}`);
}

async function racePublications(
	left: { identity: DeviceIdentity; mutation: AttachmentMutation },
	right: { identity: DeviceIdentity; mutation: AttachmentMutation },
): Promise<readonly [JsonResult, JsonResult]> {
	const results = await Promise.all([
		publishUntilSettled(left.identity, left.mutation),
		publishUntilSettled(right.identity, right.mutation),
	]);
	assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
	assert.equal(results.find((result) => result.response.status === 409)?.body?.error, "attachment_revision_mismatch");
	return results;
}

async function attachmentState(path: string): Promise<{ ref: AttachmentRef | undefined; tombstone: AttachmentTombstone | undefined }> {
	const response = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
	assert.equal(response.status, 200);
	const root = new Y.Doc();
	try {
		Y.applyUpdate(root, new Uint8Array(await response.arrayBuffer()));
		return {
			ref: root.getMap<AttachmentRef>("pathToBlob").get(path),
			tombstone: root.getMap<AttachmentTombstone>("blobTombstones").get(path),
		};
	} finally {
		root.destroy();
	}
}

const bytes = new TextEncoder().encode("schema-10 attachment bytes");
const hash = await sha256Hex(bytes);
const upload = await fetch(vaultUrl(target.deviceA, `blobs/${hash}`), {
	method: "PUT", headers: bearer(target.deviceA, { "content-type": "text/plain" }), body: bytes,
});
assert.equal(upload.status, 204);
const exists = await vaultJson(target.deviceB, "blobs/exists", {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: [hash] }),
});
assert.deepEqual(exists.body, { present: [hash] });
const downloaded = await fetch(vaultUrl(target.deviceB, `blobs/${hash}`), { headers: bearer(target.deviceB) });
assert.equal(await downloaded.text(), "schema-10 attachment bytes");
pass("attachment bytes are content-addressed and visible to vault peers");

const path = "assets/conformance.txt";
const upsertOperationId = `attach_${crypto.randomUUID().replaceAll("-", "")}`;
const upsertBody: AttachmentMutation = {
	operationId: upsertOperationId, kind: "upsert", path, expectedRevision: null, hash, size: bytes.byteLength, mime: "text/plain",
};
const upsert = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		...upsertBody,
	}),
});
assert.equal(upsert.response.status, 200, JSON.stringify(upsert.body));
assert.equal(upsert.body?.vaultGeneration, target.deviceA.vaultGeneration);
const rootResponse = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
const root = new Y.Doc();
Y.applyUpdate(root, new Uint8Array(await rootResponse.arrayBuffer()));
assert.deepEqual(root.getMap("pathToBlob").get(path), { hash, size: bytes.byteLength, revision: upsertOperationId });
root.destroy();
pass("attachment publication durably updates the root catalog");

const replay = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson(upsertBody),
});
assert.equal(replay.response.status, 200);
const identityMismatch = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({ ...upsertBody, expectedRevision: upsertOperationId }),
});
assert.equal(identityMismatch.response.status, 409);
assert.equal(identityMismatch.body?.error, "attachment_operation_identity_mismatch");
pass("attachment operation replay requires the exact canonical request identity");

const renamed = "assets/renamed.txt";
const renameOperationId = `rename_${crypto.randomUUID().replaceAll("-", "")}`;
const rename = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: renameOperationId, kind: "rename", fromPath: path, toPath: renamed,
		expectedFromRevision: upsertOperationId, expectedToRevision: null,
	}),
});
assert.equal(rename.response.status, 200);
const stale = await vaultJson(target.deviceB, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: `stale_${crypto.randomUUID().replaceAll("-", "")}`, kind: "upsert", path,
		expectedRevision: upsertOperationId, hash, size: bytes.byteLength, mime: "text/plain",
	}),
});
assert.equal(stale.response.status, 409);
assert.equal(stale.body?.error, "attachment_revision_mismatch");
assert.equal(stale.body?.vaultGeneration, target.deviceA.vaultGeneration);
assert.equal(Array.isArray(stale.body?.currentHeads), true);

const staleDelete = await vaultJson(target.deviceB, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: `stale_delete_${crypto.randomUUID().replaceAll("-", "")}`, kind: "delete", path: renamed,
		expectedRevision: upsertOperationId,
	}),
});
assert.equal(staleDelete.response.status, 409);
assert.equal(staleDelete.body?.error, "attachment_revision_mismatch");

const collisionPath = "assets/collision.txt";
const collisionOperationId = `collision_${crypto.randomUUID().replaceAll("-", "")}`;
const collision = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: collisionOperationId, kind: "upsert", path: collisionPath,
		expectedRevision: null, hash, size: bytes.byteLength, mime: "text/plain",
	}),
});
assert.equal(collision.response.status, 200);
const rejectedRename = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: `rename_collision_${crypto.randomUUID().replaceAll("-", "")}`, kind: "rename",
		fromPath: renamed, toPath: collisionPath,
		expectedFromRevision: renameOperationId, expectedToRevision: null,
	}),
});
assert.equal(rejectedRename.response.status, 409);
assert.equal(rejectedRename.body?.error, "attachment_revision_mismatch");
assert.equal((rejectedRename.body?.currentHeads as unknown[]).length, 2);

const deleteOperationId = `delete_${crypto.randomUUID().replaceAll("-", "")}`;
const remove = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: deleteOperationId, kind: "delete", path: renamed,
		expectedRevision: renameOperationId,
	}),
});
assert.equal(remove.response.status, 200);
const revivalOperationId = `revive_${crypto.randomUUID().replaceAll("-", "")}`;
const revival = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: revivalOperationId, kind: "upsert", path: renamed,
		expectedRevision: deleteOperationId, hash, size: bytes.byteLength, mime: "text/plain",
	}),
});
assert.equal(revival.response.status, 200);
const finalDeleteOperationId = `delete_final_${crypto.randomUUID().replaceAll("-", "")}`;
const finalDelete = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: finalDeleteOperationId, kind: "delete", path: renamed,
		expectedRevision: revivalOperationId,
	}),
});
assert.equal(finalDelete.response.status, 200);
const collisionDelete = await vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId: `delete_collision_${crypto.randomUUID().replaceAll("-", "")}`, kind: "delete", path: collisionPath,
		expectedRevision: collisionOperationId,
	}),
});
assert.equal(collisionDelete.response.status, 200);
const finalRootResponse = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
const finalRoot = new Y.Doc();
Y.applyUpdate(finalRoot, new Uint8Array(await finalRootResponse.arrayBuffer()));
assert.equal(finalRoot.getMap("pathToBlob").has(path), false);
assert.equal(finalRoot.getMap("pathToBlob").has(renamed), false);
assert.ok(finalRoot.getMap("blobTombstones").has(path));
assert.ok(finalRoot.getMap("blobTombstones").has(renamed));
finalRoot.destroy();
pass("attachment CAS rejects stale mutation and rename collision while explicit revival remains causal");

const racePath = "assets/concurrent.txt";
const raceA = `race_a_${crypto.randomUUID().replaceAll("-", "")}`;
const raceB = `race_b_${crypto.randomUUID().replaceAll("-", "")}`;
const concurrent = await Promise.all([raceA, raceB].map((operationId) => vaultJson(target.deviceA, "attachments/publish", {
	method: "POST", headers: { "content-type": "application/json" }, body: attachmentJson({
		operationId, kind: "upsert", path: racePath, expectedRevision: null,
		hash, size: bytes.byteLength, mime: "text/plain",
	}),
})));
assert.deepEqual(concurrent.map((result) => result.response.status).sort(), [200, 409]);
assert.equal(concurrent.find((result) => result.response.status === 409)?.body?.error, "attachment_revision_mismatch");
pass("concurrent missing-head writers serialize and exactly one wins");

const uploadDeletePath = "assets/race-upload-delete.bin";
const uploadDeleteSeed = operationId("upload_delete_seed");
const uploadDeleteCandidate = await uploadBlob(target.deviceA, "upload/delete replacement");
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: uploadDeleteSeed, kind: "upsert", path: uploadDeletePath, expectedRevision: null,
	hash, size: bytes.byteLength, mime: "text/plain",
})).response.status, 200);
const uploadDeleteUpsert = {
	operationId: operationId("upload_delete_upsert"), kind: "upsert" as const, path: uploadDeletePath,
	expectedRevision: uploadDeleteSeed, hash: uploadDeleteCandidate.hash,
	size: uploadDeleteCandidate.bytes.byteLength, mime: "application/octet-stream",
};
const uploadDeleteRemoval = {
	operationId: operationId("upload_delete_delete"), kind: "delete" as const,
	path: uploadDeletePath, expectedRevision: uploadDeleteSeed,
};
const uploadDeleteResults = await racePublications(
	{ identity: target.deviceA, mutation: uploadDeleteUpsert },
	{ identity: target.deviceB, mutation: uploadDeleteRemoval },
);
const uploadWon = uploadDeleteResults[0].response.status === 200;
const uploadDeleteState = await attachmentState(uploadDeletePath);
if (uploadWon) {
	assert.deepEqual(uploadDeleteState.ref, {
		hash: uploadDeleteCandidate.hash,
		size: uploadDeleteCandidate.bytes.byteLength,
		revision: uploadDeleteUpsert.operationId,
	});
	assert.equal(uploadDeleteState.tombstone, undefined);
} else {
	assert.equal(uploadDeleteState.ref, undefined);
	assert.equal(uploadDeleteState.tombstone?.revision, uploadDeleteRemoval.operationId);
	assert.equal(uploadDeleteState.tombstone?.previousHash, hash);
}
pass("two-device upload/delete race leaves exactly the winning revision in the durable root");

const deleteRevivePath = "assets/race-delete-revive.bin";
const deleteReviveSeed = operationId("delete_revive_seed");
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: deleteReviveSeed, kind: "delete", path: deleteRevivePath, expectedRevision: null,
})).response.status, 200);
const deleteAgain = {
	operationId: operationId("delete_revive_delete"), kind: "delete" as const,
	path: deleteRevivePath, expectedRevision: deleteReviveSeed,
};
const revive = {
	operationId: operationId("delete_revive_upsert"), kind: "upsert" as const, path: deleteRevivePath,
	expectedRevision: deleteReviveSeed, hash, size: bytes.byteLength, mime: "text/plain",
};
const deleteReviveResults = await racePublications(
	{ identity: target.deviceA, mutation: deleteAgain },
	{ identity: target.deviceB, mutation: revive },
);
const deleteWon = deleteReviveResults[0].response.status === 200;
const deleteReviveState = await attachmentState(deleteRevivePath);
if (deleteWon) {
	assert.equal(deleteReviveState.ref, undefined);
	assert.equal(deleteReviveState.tombstone?.revision, deleteAgain.operationId);
} else {
	assert.deepEqual(deleteReviveState.ref, { hash, size: bytes.byteLength, revision: revive.operationId });
	assert.equal(deleteReviveState.tombstone, undefined);
}
pass("two-device delete/revive race preserves one causal successor of the tombstone");

const replacePath = "assets/race-replace-replace.bin";
const replaceSeed = operationId("replace_seed");
const replaceLeftBlob = await uploadBlob(target.deviceA, "replace candidate from device A");
const replaceRightBlob = await uploadBlob(target.deviceB, "replace candidate from device B");
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: replaceSeed, kind: "upsert", path: replacePath, expectedRevision: null,
	hash, size: bytes.byteLength, mime: "text/plain",
})).response.status, 200);
const replaceLeft = {
	operationId: operationId("replace_left"), kind: "upsert" as const, path: replacePath,
	expectedRevision: replaceSeed, hash: replaceLeftBlob.hash,
	size: replaceLeftBlob.bytes.byteLength, mime: "application/octet-stream",
};
const replaceRight = {
	operationId: operationId("replace_right"), kind: "upsert" as const, path: replacePath,
	expectedRevision: replaceSeed, hash: replaceRightBlob.hash,
	size: replaceRightBlob.bytes.byteLength, mime: "application/octet-stream",
};
const replaceResults = await racePublications(
	{ identity: target.deviceA, mutation: replaceLeft },
	{ identity: target.deviceB, mutation: replaceRight },
);
const replaceWinner = replaceResults[0].response.status === 200 ? replaceLeft : replaceRight;
assert.deepEqual((await attachmentState(replacePath)).ref, {
	hash: replaceWinner.hash, size: replaceWinner.size, revision: replaceWinner.operationId,
});
pass("two-device replace/replace race publishes the hash belonging to the winning revision");

const renameDeleteSource = "assets/race-rename-delete-source.bin";
const renameDeleteTarget = "assets/race-rename-delete-target.bin";
const renameDeleteSeed = operationId("rename_delete_seed");
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: renameDeleteSeed, kind: "upsert", path: renameDeleteSource, expectedRevision: null,
	hash, size: bytes.byteLength, mime: "text/plain",
})).response.status, 200);
const renameCandidate = {
	operationId: operationId("rename_delete_rename"), kind: "rename" as const,
	fromPath: renameDeleteSource, toPath: renameDeleteTarget,
	expectedFromRevision: renameDeleteSeed, expectedToRevision: null,
};
const deleteCandidate = {
	operationId: operationId("rename_delete_delete"), kind: "delete" as const,
	path: renameDeleteSource, expectedRevision: renameDeleteSeed,
};
const renameDeleteResults = await racePublications(
	{ identity: target.deviceA, mutation: renameCandidate },
	{ identity: target.deviceB, mutation: deleteCandidate },
);
const renameWon = renameDeleteResults[0].response.status === 200;
const renameSourceState = await attachmentState(renameDeleteSource);
const renameTargetState = await attachmentState(renameDeleteTarget);
assert.equal(renameSourceState.ref, undefined);
if (renameWon) {
	assert.equal(renameSourceState.tombstone?.revision, renameCandidate.operationId);
	assert.deepEqual(renameTargetState.ref, { hash, size: bytes.byteLength, revision: renameCandidate.operationId });
} else {
	assert.equal(renameSourceState.tombstone?.revision, deleteCandidate.operationId);
	assert.equal(renameTargetState.ref, undefined);
	assert.equal(renameTargetState.tombstone, undefined);
}
pass("two-device rename/delete race commits one atomic source and target outcome");

const suspendedPath = "assets/suspended-stale-transfer.bin";
const suspendedSeed = operationId("suspended_seed");
const suspendedBlob = await uploadBlob(target.deviceB, "bytes uploaded before client suspension");
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: suspendedSeed, kind: "upsert", path: suspendedPath, expectedRevision: null,
	hash, size: bytes.byteLength, mime: "text/plain",
})).response.status, 200);
const remoteReplacement = await uploadBlob(target.deviceA, "remote replacement while peer sleeps");
const remoteReplaceRevision = operationId("suspended_remote_replace");
const remoteDeleteRevision = operationId("suspended_remote_delete");
const remoteReviveRevision = operationId("suspended_remote_revive");
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: remoteReplaceRevision, kind: "upsert", path: suspendedPath, expectedRevision: suspendedSeed,
	hash: remoteReplacement.hash, size: remoteReplacement.bytes.byteLength, mime: "application/octet-stream",
})).response.status, 200);
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: remoteDeleteRevision, kind: "delete", path: suspendedPath, expectedRevision: remoteReplaceRevision,
})).response.status, 200);
assert.equal((await publishUntilSettled(target.deviceA, {
	operationId: remoteReviveRevision, kind: "upsert", path: suspendedPath, expectedRevision: remoteDeleteRevision,
	hash: remoteReplacement.hash, size: remoteReplacement.bytes.byteLength, mime: "application/octet-stream",
})).response.status, 200);
const resumedStale = await publishUntilSettled(target.deviceB, {
	operationId: operationId("suspended_stale_resume"), kind: "upsert", path: suspendedPath,
	expectedRevision: suspendedSeed, hash: suspendedBlob.hash,
	size: suspendedBlob.bytes.byteLength, mime: "application/octet-stream",
});
assert.equal(resumedStale.response.status, 409);
assert.equal(resumedStale.body?.error, "attachment_revision_mismatch");
assert.equal((resumedStale.body?.current as { revision?: unknown } | undefined)?.revision, remoteReviveRevision);
assert.deepEqual((await attachmentState(suspendedPath)).ref, {
	hash: remoteReplacement.hash, size: remoteReplacement.bytes.byteLength, revision: remoteReviveRevision,
});
const orphanedTransfer = await fetch(vaultUrl(target.deviceA, `blobs/${suspendedBlob.hash}`), { headers: bearer(target.deviceA) });
assert.equal(await orphanedTransfer.text(), "bytes uploaded before client suspension");
pass("a transfer resumed after several remote revisions is superseded without publishing its uploaded object");

const captureStart = await vaultJson(target.deviceA, "recovery/captures", {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ reason: "manual", requestId: operationId("attachment_winner_capture") }),
});
assert.equal(captureStart.response.status, 202, JSON.stringify(captureStart.body));
const captureId = captureStart.body?.captureId;
assert.equal(typeof captureId, "string");
const captureDeadline = Date.now() + 60_000;
let capture: Record<string, unknown> | null = null;
while (Date.now() < captureDeadline) {
	const status = await vaultJson(target.deviceA, `recovery/captures/${captureId}`);
	assert.equal(status.response.status, 200);
	capture = status.body;
	if (capture?.state === "complete" || capture?.state === "complete_with_gaps" || capture?.state === "failed") break;
	await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(capture?.state === "complete" || capture?.state === "complete_with_gaps", JSON.stringify(capture));
assert.equal(typeof capture.snapshotId, "string");
const winningSnapshotId = capture.snapshotId as string;
const winningEntry = await vaultJson(
	target.deviceB,
	`recovery/snapshots/${winningSnapshotId}/entry?path=${encodeURIComponent(replacePath)}`,
);
assert.equal(winningEntry.response.status, 200, JSON.stringify(winningEntry.body));
assert.deepEqual(winningEntry.body, {
	availability: "available",
	path: replacePath,
	hash: replaceWinner.hash,
	size: replaceWinner.size,
	mime: replaceWinner.mime,
});
const winningFile = await fetch(
	`${vaultUrl(target.deviceB, `recovery/snapshots/${winningSnapshotId}/file`)}?path=${encodeURIComponent(replacePath)}`,
	{ headers: bearer(target.deviceB) },
);
assert.equal(winningFile.status, 200);
assert.deepEqual(new Uint8Array(await winningFile.arrayBuffer()), replaceWinner === replaceLeft ? replaceLeftBlob.bytes : replaceRightBlob.bytes);
pass("the current recovery capture contains exactly the winning attachment head and bytes");

const other = await createVaultAndEnroll(target, "attachment-generation-isolation");
const isolated = await fetch(vaultUrl(other, `blobs/${hash}`), { headers: bearer(other) });
assert.equal(isolated.status, 404);
pass("immutable attachment objects are isolated by vault generation context");
