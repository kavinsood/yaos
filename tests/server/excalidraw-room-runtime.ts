import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import type { VaultActorContext } from "../../server/src/collaboration";
import { ExcalidrawRoomRuntime } from "../../server/src/excalidrawRoom";
import {
	EXCALIDRAW_PROTOCOL_VERSION,
	canonicalExcalidrawJson,
	excalidrawRequestDigestInput,
	type ExcalidrawBatchRequest,
	type ExcalidrawInitializeRequest,
} from "../../server/src/shared/excalidrawProtocol";
import { actorHeaders } from "../../server/src/vaultAuthority";
import { suite } from "../harness.ts";

const s = suite("excalidraw-room-runtime");

const actor: VaultActorContext = {
	vaultId: "excalidraw-vault",
	vaultGeneration: "excalidraw-generation",
	principalId: "excalidraw-principal",
	membershipRevision: 1,
	deviceId: "excalidraw-device",
	deviceCredentialRevision: 1,
	role: "member",
	policyVersion: 1,
	capabilityDigest: "excalidraw-capabilities",
};

async function digest(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalExcalidrawJson(value));
	const result = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signed<T extends { requestDigest: string }>(request: T): Promise<T> {
	request.requestDigest = await digest(excalidrawRequestDigestInput(request));
	return request;
}

function roomRequest(path: string, body?: unknown): Request {
	const headers = actorHeaders(actor);
	headers.set("x-yaos-vault-id", actor.vaultId);
	headers.set("x-yaos-vault-generation", actor.vaultGeneration);
	headers.set("x-yaos-drawing-id", "drawing-1");
	if (body !== undefined) headers.set("content-type", "application/json");
	return new Request(`https://room.test${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

s.test("native room applies atomic batches, preserves tombstones, and rejects equal-tuple divergence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-excalidraw-room-"));
	const storage = NodeSqliteStorage.open(join(directory, "room.sqlite"), []);
	const sent: string[] = [];
	let socketClosed = false;
	const roomSockets = [{ send: () => {}, close: () => { socketClosed = true; }, serializeAttachment: () => {},
		deserializeAttachment: () => ({ sessionId: "session-1", vaultId: actor.vaultId,
			vaultGeneration: actor.vaultGeneration, drawingId: "drawing-1", drawingEpoch: 1,
			principalId: actor.principalId, deviceId: actor.deviceId, displayName: "Member", colorSeed: "member" }) }];
	const runtime = new ExcalidrawRoomRuntime({
		storage: storage as never,
		sockets: {
			sockets: () => roomSockets,
			createPair: () => { throw new Error("unused"); },
			accept: () => {},
			upgradeResponse: () => { throw new Error("unused"); },
		},
		vaults: {
			call: async (_name, request) => {
				if (new URL(request.url).pathname.endsWith("/read")) return Response.json({ drawingId: "drawing-1", drawingEpoch: 1 });
				const reservation = await request.json<{ operationId: string; requestDigest: string; drawingId: string; drawingEpoch: number }>();
				sent.push(reservation.operationId);
				return Response.json({ protocolVersion: 1, ...reservation, permitId: `permit-${reservation.operationId}`,
					principalId: actor.principalId, membershipRevision: 1, deviceId: actor.deviceId,
					deviceCredentialRevision: 1, displayName: "Member", colorSeed: "member", replayed: false });
			},
		},
	});
	try {
		const initialize = await signed<ExcalidrawInitializeRequest>({
			protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
			operationId: "initialize-1",
			requestDigest: "",
			prepareOperationId: "prepare-1",
			drawingEpoch: 1,
			elements: [
				{ id: "box", version: 1, versionNonce: 100, isDeleted: false, type: "rectangle", index: "a0" },
				{ id: "target", version: 1, versionNonce: 50, isDeleted: false, type: "rectangle", index: "a1",
					boundElements: [{ id: "arrow", type: "arrow" }] },
				{ id: "arrow", version: 2, versionNonce: 40, isDeleted: false, type: "arrow", index: "a2",
					startBinding: { elementId: "target", focus: 0, gap: 1 }, endBinding: null },
			],
			metadata: { resourceManifest: { version: 1, entries: [{ kind: "vault", resourceId: "image-1", fileId: "file-1" }] } },
		});
		const initialized = await runtime.fetch(roomRequest("/initialize", initialize));
		assert.equal(initialized.status, 201);

		const lowerNonce = await signed<ExcalidrawBatchRequest>({
			protocolVersion: 1, operationId: "batch-1", requestDigest: "", drawingEpoch: 1,
			elements: [
				{ id: "box", version: 1, versionNonce: 5, isDeleted: false, type: "rectangle", x: 42, index: "a0" },
				{ id: "deleted", version: 2, versionNonce: 9, isDeleted: true, type: "ellipse", index: "a1" },
			],
		});
		const first = await runtime.fetch(roomRequest("/batch", lowerNonce));
		assert.equal(first.status, 200);
		assert.deepEqual((await first.json<{ acceptedElementIds: string[]; sequence: number }>()).acceptedElementIds, ["box", "deleted"]);

		const replayed = await runtime.fetch(roomRequest("/batch", lowerNonce));
		assert.equal((await replayed.json<{ replayed: boolean; sequence: number }>()).replayed, true);
		assert.deepEqual(sent, ["initialize-1", "batch-1"], "receipt replay does not reserve twice");

		const divergent = await signed<ExcalidrawBatchRequest>({
			protocolVersion: 1, operationId: "batch-divergent", requestDigest: "", drawingEpoch: 1,
			elements: [{ id: "box", version: 1, versionNonce: 5, isDeleted: false, type: "rectangle", x: 99, index: "a0" }],
		});
		const rejected = await runtime.fetch(roomRequest("/batch", divergent));
		assert.equal(rejected.status, 409);
		assert.equal((await rejected.json<{ error: string }>()).error, "excalidraw_equal_revision_diverged");

		const torn = await signed<ExcalidrawBatchRequest>({
			protocolVersion: 1, operationId: "batch-torn", requestDigest: "", drawingEpoch: 1,
			elements: [
				{ id: "target", version: 2, versionNonce: 30, isDeleted: true, type: "rectangle", index: "a1" },
				{ id: "arrow", version: 1, versionNonce: 30, isDeleted: false, type: "arrow", index: "a2",
					startBinding: null, endBinding: null },
			],
		});
		const tornResponse = await runtime.fetch(roomRequest("/batch", torn));
		assert.equal(tornResponse.status, 409, "a stale coupled record cannot leak a partial winner");
		assert.match((await tornResponse.json<{ error: string }>()).error, /dependency_closure/);

		const snapshot = await runtime.fetch(roomRequest("/snapshot"));
		assert.equal(snapshot.status, 200);
		const state = await snapshot.json<{ sequence: number; elements: Array<{ id: string; x?: number; isDeleted: boolean }> }>();
		assert.equal(state.sequence, 2, "one multi-element logical batch advances one room sequence");
		assert.equal(state.elements.find((element) => element.id === "box")?.x, 42, "lower nonce wins at equal version");
		assert.equal(state.elements.find((element) => element.id === "deleted")?.isDeleted, true, "native tombstone remains durable");
		assert.equal(state.elements.find((element) => element.id === "target")?.isDeleted, false,
			"rejected closure leaves every coupled record unchanged");

		const replay = await runtime.fetch(roomRequest("/replay?after=1"));
		const page = await replay.json<{ events: Array<{ sequence: number; elements: unknown[] }> }>();
		assert.equal(page.events.length, 1);
		assert.equal(page.events[0]?.sequence, 2);
		assert.equal(page.events[0]?.elements.length, 2, "batch is not torn into per-element replay events");
		assert.equal((await runtime.fetch(roomRequest("/replay?after=999"))).status, 400,
			"a replay cursor beyond the durable room head is rejected");

		const fence = await runtime.fetch(roomRequest("/__yaos/authority-fence", {
			principalIds: [actor.principalId], deviceIds: [],
		}));
		assert.equal(fence.status, 200);
		assert.equal(socketClosed, true, "vault authority fences close matching Drawing DO sockets");
	} finally {
		storage.close();
		await rm(directory, { recursive: true, force: true });
	}
});

await s.done();
