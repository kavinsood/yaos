import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import type { VaultActorContext } from "../../server/src/collaboration";
import { ExcalidrawRoomRuntime } from "../../server/src/excalidrawRoom";
import type { ObjectBody, ObjectMetadata, ObjectStorePort, ObjectWriteOptions } from "../../server/src/platformPorts";
import { actorHeaders } from "../../server/src/vaultAuthority";
import { blobKey } from "../../server/src/vaultObjectStore";
import { canonicalExcalidrawJson, excalidrawRequestDigestInput, type ExcalidrawBatchRequest,
	type ExcalidrawInitializeRequest } from "../../server/src/shared/excalidrawProtocol";
import { canonicalExcalidrawShareJson, excalidrawShareDigestInput, type ExcalidrawShareCreateRequest,
	PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1, PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1_HASH,
	type ExcalidrawShareUpdateRequest } from "../../server/src/shared/excalidrawShareProtocol";
import { suite } from "../harness.ts";

const s = suite("excalidraw-share-runtime");
const actor: VaultActorContext = { vaultId: "share-vault", vaultGeneration: "share-generation",
	principalId: "share-owner", membershipRevision: 1, deviceId: "share-device", deviceCredentialRevision: 1,
	role: "owner", policyVersion: 2, capabilityDigest: "share-capabilities" };

class MemoryObjects implements ObjectStorePort {
	readonly values = new Map<string, ObjectBody>();
	async head(key: string): Promise<ObjectMetadata | null> { return this.values.get(key) ?? null; }
	async get(key: string): Promise<ObjectBody | null> { return this.values.get(key) ?? null; }
	async put(key: string, bytes: Uint8Array, options?: ObjectWriteOptions): Promise<void> { this.write(key, bytes, options); }
	async createOnly(key: string, bytes: Uint8Array, options?: ObjectWriteOptions): Promise<"created" | "exists"> {
		if (this.values.has(key)) return "exists";
		this.write(key, bytes, options); return "created";
	}
	async delete(key: string): Promise<void> { this.values.delete(key); }
	async list(): Promise<{ objects: ObjectMetadata[]; cursor: null; truncated: false }> {
		return { objects: [...this.values.values()], cursor: null, truncated: false };
	}
	private write(key: string, bytes: Uint8Array, options?: ObjectWriteOptions): void {
		this.values.set(key, { key, bytes: bytes.slice(), size: bytes.byteLength, uploadedAt: Date.now(),
			contentType: options?.contentType ?? null, customMetadata: options?.customMetadata ?? {} });
	}
}

async function hash(bytes: Uint8Array | string): Promise<string> {
	const value = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
		.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedScene<T extends { requestDigest: string }>(input: T): Promise<T> {
	input.requestDigest = await hash(canonicalExcalidrawJson(excalidrawRequestDigestInput(input)));
	return input;
}

async function signedShare<T extends { requestDigest: string }>(input: T): Promise<T> {
	input.requestDigest = await hash(canonicalExcalidrawShareJson(excalidrawShareDigestInput(input)));
	return input;
}

function memberRequest(path: string, method: string, body?: unknown): Request {
	const headers = actorHeaders(actor);
	headers.set("x-yaos-vault-id", actor.vaultId); headers.set("x-yaos-vault-generation", actor.vaultGeneration);
	headers.set("x-yaos-drawing-id", "drawing-private");
	if (body !== undefined) headers.set("content-type", "application/json");
	return new Request(`https://room.test${path}`, { method, headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

function publicRequest(path: string, method: string, session?: { sessionId: string; tokenHash: string }, body?: BodyInit): Request {
	const headers = new Headers({ "x-yaos-vault-id": actor.vaultId, "x-yaos-vault-generation": actor.vaultGeneration,
		"x-yaos-drawing-id": "drawing-private", "x-yaos-drawing-epoch": "1", "x-yaos-share-id": "share-one" });
	if (session) { headers.set("x-yaos-share-session-id", session.sessionId); headers.set("x-yaos-share-session-token-hash", session.tokenHash); }
	if (typeof body === "string") headers.set("content-type", "application/json");
	return new Request(`https://room.test${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

s.test("public projection field contract has the pinned canonical hash", async () => {
	assert.equal(await hash(canonicalExcalidrawJson(PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1)),
		PUBLIC_EXCALIDRAW_ELEMENT_FIELDS_V1_HASH);
});

s.test("public grants redact private metadata, fence writes, and bind explicit resources", async () => {
	const directory = await mkdtemp(join(tmpdir(), "yaos-excalidraw-share-"));
	const storage = NodeSqliteStorage.open(join(directory, "room.sqlite"), []);
	const objects = new MemoryObjects();
	type TestSocket = { send(message: string): void; close(): void; serializeAttachment(value: unknown): void; deserializeAttachment(): unknown };
	const publicFrames: string[] = [];
	const clock = { now: Date.now() };
	const scheduledAlarms: number[] = [];
	let publicClosed = false;
	let publicAttachment: unknown;
	const publicSocket: TestSocket = { send: (message) => publicFrames.push(message), close: () => { publicClosed = true; },
		serializeAttachment: (value) => { publicAttachment = value; }, deserializeAttachment: () => publicAttachment };
	const memberAttachment = { authorityKind: "vault", sessionId: "member-session", vaultId: actor.vaultId,
		vaultGeneration: actor.vaultGeneration, drawingId: "drawing-private", drawingEpoch: 1,
		principalId: actor.principalId, deviceId: actor.deviceId, displayName: "Owner Private Name", colorSeed: "owner",
		presenceClientSequence: 1, presenceUpdatedAt: Date.now(), presence: { pointer: { x: 1, y: 2, tool: "pointer", button: "up" } } };
	const memberSocket: TestSocket = { send: () => {}, close: () => {}, serializeAttachment: () => {},
		deserializeAttachment: () => memberAttachment };
	const sockets: TestSocket[] = [memberSocket];
	const runtime = new ExcalidrawRoomRuntime({ storage: storage as never, objectStore: objects,
		now: () => clock.now,
		alarms: { setAlarm: async (scheduledTime) => { scheduledAlarms.push(scheduledTime); }, deleteAlarm: async () => {} },
		sockets: { sockets: () => sockets, createPair: () => ({ client: {}, server: publicSocket }),
			accept: (socket) => sockets.push(socket as TestSocket), upgradeResponse: () => new Response(null, { status: 200 }) },
		vaults: { call: async (_name, request) => {
			const body: Record<string, unknown> = await request.json<Record<string, unknown>>().catch(() => ({}));
			return Response.json({ ...body, drawingId: "drawing-private", drawingEpoch: 1,
				permitId: `permit-${String(body.operationId)}`, principalId: actor.principalId,
				membershipRevision: 1, deviceId: actor.deviceId, deviceCredentialRevision: 1,
				displayName: "Owner", colorSeed: "owner", replayed: false });
		} } });
	try {
		const image = new TextEncoder().encode("approved image");
		const imageHash = await hash(image);
		await objects.put(blobKey(actor.vaultId, actor.vaultGeneration, imageHash), image, { contentType: "image/png" });
		const initialize = await signedScene<ExcalidrawInitializeRequest>({ protocolVersion: 1,
			operationId: "initialize-share-room", requestDigest: "", prepareOperationId: "prepare-share-room", drawingEpoch: 1,
			elements: [{ id: "image-element", version: 1, versionNonce: 1, isDeleted: false, type: "image",
				fileId: "private-file-id", link: "obsidian://open?vault=secret", customData: { privatePath: "Private.md" } }],
			metadata: { plugin: { backOfCard: "PRIVATE" }, resourceManifest: { version: 1, entries: [
				{ kind: "embedded", resourceId: "private-file-id", contentHash: imageHash, size: image.byteLength,
					mime: "image/png", created: 1 },
			] } } });
		assert.equal((await runtime.fetch(memberRequest("/initialize", "POST", initialize))).status, 201);

		const linkSecret = "link-secret-with-at-least-thirty-two-bytes";
		const create = await signedShare<ExcalidrawShareCreateRequest>({ protocolVersion: 1,
			operationId: "create-share", requestDigest: "", shareId: "share-one", publicDrawingId: "public-drawing-one",
			linkSecretHash: await hash(linkSecret), permission: "read-only", expiresAt: Date.now() + 2 * 60 * 60_000,
			resources: [{ publicResourceId: "public-image", sourceResourceId: "private-file-id",
				contentHash: imageHash, size: image.byteLength, mime: "image/png" }] });
		assert.equal((await runtime.fetch(memberRequest("/shares", "POST", create))).status, 201);
		const sessionResponse = await runtime.fetch(publicRequest("/__yaos/public/session", "POST", undefined,
			JSON.stringify({ linkSecretHash: await hash(linkSecret), displayName: "Guest" })));
		assert.equal(sessionResponse.status, 200);
		const issued = await sessionResponse.json<{ sessionId: string; sessionToken: string }>();
		const session = { sessionId: issued.sessionId, tokenHash: await hash(issued.sessionToken) };
		const snapshotResponse = await runtime.fetch(publicRequest("/__yaos/public/snapshot", "GET", session));
		const snapshotText = await snapshotResponse.text();
		assert.equal(snapshotResponse.status, 200);
		assert.equal(snapshotText.includes("drawing-private"), false);
		assert.equal(snapshotText.includes("Private.md"), false);
		assert.equal(snapshotText.includes("obsidian://"), false);
		assert.equal(snapshotText.includes("private-file-id"), false);
		assert.equal(snapshotText.includes("public-image"), true);
		const replayResponse = await runtime.fetch(publicRequest("/__yaos/public/replay?after=0", "GET", session));
		const replay = await replayResponse.json<{ drawingEpoch?: unknown }>();
		assert.equal(replayResponse.status, 200);
		assert.equal(replay.drawingEpoch, 1, "public replay carries the epoch required by the browser transport");

		const readOnlyBatch = await signedScene<ExcalidrawBatchRequest>({ protocolVersion: 1,
			operationId: "public-write-readonly", requestDigest: "", drawingEpoch: 1,
			elements: [{ id: "guest-box", version: 1, versionNonce: 1, isDeleted: false, type: "rectangle" }] });
		assert.equal((await runtime.fetch(publicRequest("/__yaos/public/batch", "POST", session,
			JSON.stringify(readOnlyBatch)))).status, 403);

		const update = await signedShare<ExcalidrawShareUpdateRequest>({ protocolVersion: 1,
			operationId: "upgrade-share", requestDigest: "", shareId: "share-one", expectedGrantRevision: 1,
			permission: "read-write", expiresAt: Date.now() + 2 * 60 * 60_000, resources: create.resources });
		assert.equal((await runtime.fetch(memberRequest("/shares/share-one", "PATCH", update))).status, 200);
		assert.equal((await runtime.fetch(publicRequest("/__yaos/public/snapshot", "GET", session))).status, 401,
			"grant revision change invalidates the old session");
		const secondResponse = await runtime.fetch(publicRequest("/__yaos/public/session", "POST", undefined,
			JSON.stringify({ linkSecretHash: await hash(linkSecret), displayName: "Guest" })));
		const second = await secondResponse.json<{ sessionId: string; sessionToken: string }>();
		const editSession = { sessionId: second.sessionId, tokenHash: await hash(second.sessionToken) };
		const wsRequest = publicRequest("/__yaos/public/ws", "GET", editSession);
		wsRequest.headers.set("upgrade", "websocket");
		assert.equal((await runtime.fetch(wsRequest)).status, 200);
		const publicPresence = publicFrames.find((frame) => frame.includes("presence.snapshot")) ?? "";
		const parsedPublicPresence = JSON.parse(publicPresence) as { type?: unknown; presences?: Array<{ identity?: {
			kind?: unknown; participantId?: unknown } }> };
		assert.equal(parsedPublicPresence.type, "presence.snapshot");
		assert.equal(parsedPublicPresence.presences?.[0]?.identity?.kind, "member");
		assert.match(String(parsedPublicPresence.presences?.[0]?.identity?.participantId ?? ""), /^participant_/);
		assert.equal(publicPresence.includes(actor.principalId), false);
		assert.equal(publicPresence.includes(actor.deviceId), false);
		assert.equal(publicPresence.includes("Owner Private Name"), false,
			"public presence projects vault identities and names to an audience-safe pseudonym");
		assert.equal((await runtime.fetch(publicRequest("/__yaos/public/batch", "POST", editSession,
			JSON.stringify(readOnlyBatch)))).status, 200);
		const injected = await signedScene<ExcalidrawBatchRequest>({ protocolVersion: 1,
			operationId: "public-private-field", requestDigest: "", drawingEpoch: 1,
			elements: [{ id: "image-element", version: 2, versionNonce: 2, isDeleted: false,
				type: "image", fileId: "public-image", customData: { steal: true } }] });
		assert.equal((await runtime.fetch(publicRequest("/__yaos/public/batch", "POST", editSession,
			JSON.stringify(injected)))).status, 400, "public writes fail closed on non-allowlisted fields");

		const upload = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const uploadHash = await hash(upload);
		const uploadRequest = publicRequest("/__yaos/public/resources/guest-raster", "POST", editSession, upload);
		uploadRequest.headers.set("x-yaos-content-sha256", uploadHash);
		uploadRequest.headers.set("content-type", "image/png");
		assert.equal((await runtime.fetch(uploadRequest)).status, 202);
		assert.equal(objects.values.has(blobKey(actor.vaultId, actor.vaultGeneration, uploadHash)), false,
			"untrusted browser media never enters vault CAS implicitly");
		assert.equal((await runtime.fetch(publicRequest("/__yaos/public/resources/guest-raster", "GET", editSession))).status, 404,
			"validated quarantine is not readable before an explicit finalization path");
		const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
		const htmlRequest = publicRequest("/__yaos/public/resources/evil", "POST", editSession, html);
		htmlRequest.headers.set("x-yaos-content-sha256", await hash(html)); htmlRequest.headers.set("content-type", "text/html");
		assert.equal((await runtime.fetch(htmlRequest)).status, 415, "active writers cannot bypass raster media validation");
		assert.ok(scheduledAlarms.length > 0 && scheduledAlarms.every((value) => value > clock.now));
		clock.now += 3 * 60 * 60_000;
		await runtime.alarm();
		assert.equal(publicClosed, true, "idle public sockets close at authority expiry without client traffic");
		assert.equal((await runtime.fetch(publicRequest("/__yaos/public/snapshot", "GET", editSession))).status, 401);
	} finally { storage.close(); await rm(directory, { recursive: true, force: true }); }
});

await s.done();
