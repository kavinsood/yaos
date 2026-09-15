import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import type { VaultActorContext } from "../../server/src/collaboration";
import {
	EXCALIDRAW_PROTOCOL_VERSION,
	canonicalExcalidrawJson,
	excalidrawRequestDigestInput,
	type ExcalidrawPromotionFinalizeRequest,
	type ExcalidrawPromotionPrepareRequest,
	type ExcalidrawLifecycleRequest,
} from "../../server/src/shared/excalidrawProtocol";
import { VaultExcalidrawAuthorityService } from "../../server/src/vaultExcalidrawAuthority";
import { VaultStore } from "../../server/src/vaultStore";
import { actorHeaders } from "../../server/src/vaultAuthority";
import { suite } from "../harness.ts";

const s = suite("excalidraw-authority-saga");

const actor: VaultActorContext = {
	vaultId: "excalidraw-authority-vault",
	vaultGeneration: "excalidraw-authority-generation",
	principalId: "excalidraw-authority-owner",
	membershipRevision: 1,
	deviceId: "excalidraw-authority-device",
	deviceCredentialRevision: 1,
	role: "owner",
	policyVersion: 1,
	capabilityDigest: "excalidraw-authority-capabilities",
};

const member: VaultActorContext = {
	...actor,
	principalId: "excalidraw-authority-member",
	deviceId: "excalidraw-authority-member-device",
	role: "member",
	capabilityDigest: "excalidraw-authority-member-capabilities",
};

async function digest(value: unknown): Promise<string> {
	const data = new TextEncoder().encode(canonicalExcalidrawJson(value));
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signed<T extends { requestDigest: string }>(request: T): Promise<T> {
	request.requestDigest = await digest(excalidrawRequestDigestInput(request));
	return request;
}

s.test("prepare leaves source authoritative and finalize cuts over only after durable room proof", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-excalidraw-authority-"));
	const storage = NodeSqliteStorage.open(join(directory, "vault.sqlite"), []);
	try {
		const store = new VaultStore(storage as never);
		const root = new Y.Doc({ guid: "root" });
		root.getMap("sys").set("schemaVersion", 9);
		root.getMap("sys").set("protocolVersion", 7);
		store.provisionVault(actor.vaultId, actor.vaultGeneration, Y.encodeStateAsUpdate(root));
		root.destroy();
		store.installAuthorityFence({
			changeId: "excalidraw-authority-bootstrap",
			vaultId: actor.vaultId,
			vaultGeneration: actor.vaultGeneration,
			subjectDigest: "excalidraw-authority-bootstrap-digest",
			subjects: [
				{ principalId: actor.principalId, role: actor.role, state: "active",
					membershipRevision: 1, policyVersion: 1, capabilityDigest: actor.capabilityDigest,
					displayName: "Owner", colorSeed: "owner" },
				{ deviceId: actor.deviceId, principalId: actor.principalId, state: "active", credentialRevision: 1 },
				{ principalId: member.principalId, role: member.role, state: "active",
					membershipRevision: 1, policyVersion: 1, capabilityDigest: member.capabilityDigest,
					displayName: "Member", colorSeed: "member" },
				{ deviceId: member.deviceId, principalId: member.principalId, state: "active", credentialRevision: 1 },
			],
		});
		const sourceHash = "a".repeat(64);
		const sourceRevision = "excalidraw-source-revision";
		const sourceRoot = store.reconstructDocument("root");
		const sourceVector = Y.encodeStateVector(sourceRoot.doc);
		sourceRoot.doc.getMap("pathToBlob").set("Board.excalidraw", { hash: sourceHash, size: 100, revision: sourceRevision });
		const sourceUpdate = Y.encodeStateAsUpdate(sourceRoot.doc, sourceVector);
		sourceRoot.doc.destroy();
		store.commitRootAttachments(sourceUpdate, [{ operationId: sourceRevision, path: "Board.excalidraw",
			contentHash: sourceHash, size: 100, mime: "application/json", lifecycle: "active" }],
		{ operationId: sourceRevision, requestDigest: "b".repeat(64), rootEpoch: 1 }, store.documentHead("root")!);

		const initializationDigest = "c".repeat(64);
		let broadcasts = 0;
		let fullFences = 0;
		const service = new VaultExcalidrawAuthorityService({
			storage: storage as never,
			store: () => store,
			runtimeEpoch: "excalidraw-authority-runtime",
			drawings: {
				call: async (_name, request) => {
					if (new URL(request.url).pathname === "/__yaos/authority-fence") {
						const body = await request.json<{ all?: boolean }>();
						if (body.all) fullFences++;
						return Response.json({ closed: 2 });
					}
					return Response.json({ protocolVersion: 1, operationId: "initialize-drawing",
					requestDigest: initializationDigest, drawingId: "drawing-stable-id", drawingEpoch: 1,
					sequence: 1, acceptedElementIds: ["element-1"], staleElementIds: [],
					metadataAccepted: true, replayed: false });
				},
			},
			onRootCommitted: () => { broadcasts++; },
		});
		const prepare = await signed<ExcalidrawPromotionPrepareRequest>({
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: "prepare-drawing", requestDigest: "",
			drawingId: "drawing-stable-id", path: "Board.excalidraw",
			source: { kind: "attachment", revision: sourceRevision, contentHash: sourceHash, size: 100 },
			initializationRequestDigest: initializationDigest,
		});
		const prepared = await service.prepare(new Request("https://vault.test/excalidraw/drawing-stable-id/authority/prepare",
			{ method: "POST", body: JSON.stringify(prepare) }), actor);
		assert.equal(prepared.status, 201);
		const beforeFinalize = store.reconstructDocument("root");
		assert.equal(beforeFinalize.doc.getMap("pathToBlob").has("Board.excalidraw"), true,
			"prepare does not expose a semantic path before room durability");
		assert.equal(beforeFinalize.doc.getMap("pathToSemantic").has("Board.excalidraw"), false);
		beforeFinalize.doc.destroy();

		const finalize = await signed<ExcalidrawPromotionFinalizeRequest>({
			protocolVersion: 1, operationId: "finalize-drawing", requestDigest: "",
			prepareOperationId: "prepare-drawing", initializationOperationId: "initialize-drawing",
			initializationRequestDigest: initializationDigest,
		});
		const finalized = await service.finalize(new Request("https://vault.test/excalidraw/drawing-stable-id/authority/finalize",
			{ method: "POST", body: JSON.stringify(finalize) }), actor);
		assert.equal(finalized.status, 200);
		assert.equal(broadcasts, 1);
		const afterFinalize = store.reconstructDocument("root");
		assert.equal(afterFinalize.doc.getMap("pathToBlob").has("Board.excalidraw"), false);
		assert.deepEqual(afterFinalize.doc.getMap("pathToSemantic").get("Board.excalidraw"), {
			documentId: "drawing-stable-id", kind: "excalidraw", format: "excalidraw-native", formatVersion: 1,
		});
		afterFinalize.doc.destroy();
		assert.equal(store.attachmentHead("Board.excalidraw")?.lifecycle, "deleted");
		assert.equal(store.excalidrawHeadAt(store.currentSequence(), "drawing-stable-id")?.lifecycle, "active");

		const replay = await service.finalize(new Request("https://vault.test/excalidraw/drawing-stable-id/authority/finalize",
			{ method: "POST", body: JSON.stringify(finalize) }), actor);
		assert.equal((await replay.json<{ replayed: boolean }>()).replayed, true, "promotion finalize replays");
		assert.equal(broadcasts, 1, "response-loss retry replays receipt without another root mutation");

		const reservation = { protocolVersion: 1, operationId: "reserved-before-fence",
			requestDigest: "d".repeat(64), drawingId: "drawing-stable-id", drawingEpoch: 1, kind: "mutate" };
		const reservationHeaders = actorHeaders(member);
		reservationHeaders.set("x-yaos-vault-id", member.vaultId);
		reservationHeaders.set("x-yaos-vault-generation", member.vaultGeneration);
		const reserveRequest = () => new Request("https://internal/__yaos/excalidraw/reserve", {
			method: "POST", headers: reservationHeaders, body: JSON.stringify(reservation),
		});
		assert.equal((await service.reserve(reserveRequest())).status, 201);
		store.installAuthorityFence({ changeId: "revoke-excalidraw-member", vaultId: actor.vaultId,
			vaultGeneration: actor.vaultGeneration, subjectDigest: "revoke-excalidraw-member-digest", subjects: [
				{ principalId: member.principalId, role: "member", state: "revoked", membershipRevision: 2,
					policyVersion: 1, capabilityDigest: member.capabilityDigest, displayName: "Member", colorSeed: "member" },
				{ deviceId: member.deviceId, principalId: member.principalId, state: "revoked", credentialRevision: 2 },
			] });
		const reservedReplay = await service.reserve(reserveRequest());
		assert.equal(reservedReplay.status, 200, "pre-fence reservation remains immutable and replayable");
		assert.equal((await reservedReplay.json<{ replayed: boolean }>()).replayed, true, "reservation replays");
		const afterFence = { ...reservation, operationId: "operation-after-fence", requestDigest: "e".repeat(64) };
		const denied = await service.reserve(new Request("https://internal/__yaos/excalidraw/reserve", {
			method: "POST", headers: reservationHeaders, body: JSON.stringify(afterFence),
		}));
		assert.equal(denied.status, 409, "post-fence operation cannot obtain authority");

		const rename = await signed<ExcalidrawLifecycleRequest>({ protocolVersion: 1,
			operationId: "rename-drawing", requestDigest: "", drawingId: "drawing-stable-id", drawingEpoch: 1,
			kind: "rename", fromPath: "Board.excalidraw", toPath: "Moved.excalidraw" });
		const renamed = await service.lifecycle(new Request("https://vault.test/excalidraw/drawing-stable-id/authority/lifecycle",
			{ method: "POST", body: JSON.stringify(rename) }), actor);
		assert.equal(renamed.status, 200);
		const afterRename = store.reconstructDocument("root");
		assert.equal(afterRename.doc.getMap("pathToSemantic").has("Board.excalidraw"), false);
		assert.deepEqual(afterRename.doc.getMap("pathToSemantic").get("Moved.excalidraw"), {
			documentId: "drawing-stable-id", kind: "excalidraw", format: "excalidraw-native", formatVersion: 1,
		});
		afterRename.doc.destroy();
		assert.equal(store.excalidrawHeadAt(store.currentSequence(), "drawing-stable-id")?.path, "Moved.excalidraw");
		assert.equal(fullFences, 0, "rename preserves room sockets and operation authority");

		const deletedRequest = await signed<ExcalidrawLifecycleRequest>({ protocolVersion: 1,
			operationId: "delete-drawing", requestDigest: "", drawingId: "drawing-stable-id", drawingEpoch: 1,
			kind: "delete", path: "Moved.excalidraw" });
		const deleted = await service.lifecycle(new Request("https://vault.test/excalidraw/drawing-stable-id/authority/lifecycle",
			{ method: "POST", body: JSON.stringify(deletedRequest) }), actor);
		assert.equal(deleted.status, 200);
		const afterDelete = store.reconstructDocument("root");
		assert.equal(afterDelete.doc.getMap("pathToSemantic").has("Moved.excalidraw"), false);
		afterDelete.doc.destroy();
		assert.equal(store.excalidrawHeadAt(store.currentSequence(), "drawing-stable-id")?.lifecycle, "tombstoned");
		assert.equal(fullFences, 1, "delete closes every room socket after authority is tombstoned");

		const replayedDelete = await service.lifecycle(new Request("https://vault.test/excalidraw/drawing-stable-id/authority/lifecycle",
			{ method: "POST", body: JSON.stringify(deletedRequest) }), actor);
		assert.equal((await replayedDelete.json<{ replayed: boolean }>()).replayed, true, "delete lifecycle replays");
		assert.equal(fullFences, 2, "delete replay repairs response-loss during socket fencing");
		const ownerHeaders = actorHeaders(actor);
		ownerHeaders.set("x-yaos-vault-id", actor.vaultId);
		ownerHeaders.set("x-yaos-vault-generation", actor.vaultGeneration);
		const deniedAfterDelete = await service.reserve(new Request("https://internal/__yaos/excalidraw/reserve", {
			method: "POST", headers: ownerHeaders, body: JSON.stringify({ protocolVersion: 1,
				operationId: "mutation-after-delete", requestDigest: "f".repeat(64), drawingId: "drawing-stable-id",
				drawingEpoch: 1, kind: "mutate" }),
		}));
		assert.equal(deniedAfterDelete.status, 409, "tombstoned catalog authority denies new room reservations");
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
