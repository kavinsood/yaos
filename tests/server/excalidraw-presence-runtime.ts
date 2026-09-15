import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import type { VaultActorContext } from "../../server/src/collaboration";
import {
	ExcalidrawRoomRuntime,
	type ExcalidrawRoomRuntimeOptions,
	type ExcalidrawRoomSocketPort,
	type ExcalidrawRoomSocketRegistryPort,
} from "../../server/src/excalidrawRoom";
import {
	EXCALIDRAW_PROTOCOL_VERSION,
	canonicalExcalidrawJson,
	excalidrawRequestDigestInput,
	type ExcalidrawBatchRequest,
	type ExcalidrawInitializeRequest,
} from "../../server/src/shared/excalidrawProtocol";
import {
	EXCALIDRAW_PRESENCE_SURFACE,
	MAX_PRESENCE_FRAME_BYTES,
	MAX_PRESENCE_INPUT_FRAMES_PER_SECOND,
	MAX_PRESENCE_SESSIONS,
	PRESENCE_MIN_BROADCAST_INTERVAL_MS,
	PRESENCE_TTL_MS,
	parsePresenceServerFrame,
} from "../../server/src/shared/presenceProtocol";
import { actorHeaders } from "../../server/src/vaultAuthority";
import { suite } from "../harness.ts";

const s = suite("excalidraw-presence-runtime");

const actor: VaultActorContext = {
	vaultId: "presence-vault", vaultGeneration: "presence-generation", principalId: "trusted-principal",
	membershipRevision: 1, deviceId: "trusted-device", deviceCredentialRevision: 1, role: "member",
	policyVersion: 1, capabilityDigest: "presence-capabilities",
};

class FakeSocket implements ExcalidrawRoomSocketPort {
	bufferedAmount = 0;
	readonly sent: string[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	attachment: unknown;
	closed = false;
	send(message: string | ArrayBuffer): void { this.sent.push(typeof message === "string" ? message : new TextDecoder().decode(message)); }
	close(code?: number, reason?: string): void { this.closes.push({ code, reason }); this.closed = true; }
	serializeAttachment(attachment: unknown): void { this.attachment = structuredClone(attachment); }
	deserializeAttachment(): unknown { return structuredClone(this.attachment); }
}

class FakeSockets implements ExcalidrawRoomSocketRegistryPort {
	readonly accepted: FakeSocket[] = [];
	sockets(): readonly FakeSocket[] { return this.accepted.filter((socket) => !socket.closed); }
	createPair(): { client: unknown; server: FakeSocket } { return { client: {}, server: new FakeSocket() }; }
	accept(socket: ExcalidrawRoomSocketPort): void { this.accepted.push(socket as FakeSocket); }
	upgradeResponse(): Response { return Response.json({ upgraded: true }); }
}

async function digest(value: unknown): Promise<string> {
	const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalExcalidrawJson(value)));
	return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signed<T extends { requestDigest: string }>(request: T): Promise<T> {
	request.requestDigest = await digest(excalidrawRequestDigestInput(request));
	return request;
}

function roomRequest(path: string, body?: unknown, extraHeaders?: Record<string, string>): Request {
	const headers = actorHeaders(actor);
	headers.set("x-yaos-vault-id", actor.vaultId);
	headers.set("x-yaos-vault-generation", actor.vaultGeneration);
	headers.set("x-yaos-drawing-id", "drawing-presence");
	for (const [name, value] of Object.entries(extraHeaders ?? {})) headers.set(name, value);
	if (body !== undefined) headers.set("content-type", "application/json");
	return new Request(`https://room.test${path}`, { method: body === undefined ? "GET" : "POST", headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

interface Fixture {
	runtime: ExcalidrawRoomRuntime;
	restart: () => ExcalidrawRoomRuntime;
	storage: NodeSqliteStorage;
	sockets: FakeSockets;
	directory: string;
	clock: { now: number };
	scheduled: Array<{ delayMs: number; callback: () => void }>;
}

async function fixture(): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "yaos-excalidraw-presence-"));
	const storage = NodeSqliteStorage.open(join(directory, "room.sqlite"), []);
	const sockets = new FakeSockets();
	const clock = { now: 1_000 };
	const scheduled: Array<{ delayMs: number; callback: () => void }> = [];
	const runtimeOptions: ExcalidrawRoomRuntimeOptions = {
		storage: storage as never, sockets, now: () => clock.now,
		schedule: (delayMs, callback) => scheduled.push({ delayMs, callback }),
		vaults: { call: async (_name, request) => {
			const reservation = await request.json<{ operationId: string; requestDigest: string; drawingId: string; drawingEpoch: number }>();
			return Response.json({ protocolVersion: 1, ...reservation, permitId: `permit-${reservation.operationId}`,
				principalId: actor.principalId, membershipRevision: 1, deviceId: actor.deviceId,
				deviceCredentialRevision: 1, displayName: "Trusted Member", colorSeed: "trusted-seed", replayed: false });
		} },
	};
	const restart = (): ExcalidrawRoomRuntime => new ExcalidrawRoomRuntime(runtimeOptions);
	const runtime = restart();
	const initialize = await signed<ExcalidrawInitializeRequest>({
		protocolVersion: EXCALIDRAW_PROTOCOL_VERSION, operationId: "initialize-presence", requestDigest: "",
		prepareOperationId: "prepare-presence", drawingEpoch: 1,
		elements: [{ id: "box", version: 1, versionNonce: 10, isDeleted: false, type: "rectangle", index: "a0" }],
		metadata: { resourceManifest: { version: 1, entries: [] } },
	});
	assert.equal((await runtime.fetch(roomRequest("/initialize", initialize))).status, 201);
	return { runtime, restart, storage, sockets, directory, clock, scheduled };
}

async function cleanup(value: Fixture): Promise<void> {
	value.storage.close();
	await rm(value.directory, { recursive: true, force: true });
}

async function connect(value: Fixture, sessionId: string): Promise<FakeSocket> {
	const response = await value.runtime.fetch(roomRequest(`/ws?sessionId=${sessionId}`, undefined,
		{ upgrade: "websocket", "x-yaos-drawing-epoch": "1" }));
	assert.equal(response.status, 200);
	return value.sockets.accepted.at(-1)!;
}

function update(clientSequence: number, x: number, assertedIdentity?: unknown): string {
	return JSON.stringify({
		type: "presence.update", presenceProtocolVersion: 2, surface: EXCALIDRAW_PRESENCE_SURFACE,
		clientSequence, state: { pointer: { x, y: 20, tool: "freedraw", button: "down" },
			selectedElementIds: ["box"], interaction: "drawing", idle: "active" },
		...(assertedIdentity === undefined ? {} : { identity: assertedIdentity, sessionId: "spoof-session" }),
	});
}

function serverFrames(socket: FakeSocket, type: string): Array<ReturnType<typeof parsePresenceServerFrame>> {
	return socket.sent.map((frame) => parsePresenceServerFrame(JSON.parse(frame)))
		.filter((frame) => frame?.type === type);
}

s.test("trusted session presence coalesces, snapshots after hibernation state, expires, and never reaches SQLite", async () => {
	const value = await fixture();
	try {
		const source = await connect(value, "session-a");
		const witness = await connect(value, "session-b");
		source.sent.length = 0;
		witness.sent.length = 0;
		await value.runtime.webSocketMessage(source, update(1, 1, { principalId: "attacker", displayName: "Spoof" }));
		const first = serverFrames(witness, "presence.state")[0];
		assert.equal(first?.type, "presence.state");
		if (first?.type === "presence.state") {
			assert.equal(first.presence.identity.principalId, actor.principalId);
			assert.equal(first.presence.identity.deviceId, actor.deviceId);
			assert.equal(first.presence.identity.displayName, "Trusted Member");
		}

		witness.sent.length = 0;
		await value.runtime.webSocketMessage(source, update(2, 2));
		await value.runtime.webSocketMessage(source, update(3, 3));
		assert.equal(serverFrames(witness, "presence.state").length, 0, "high-frequency frames wait in one coalescing slot");
		assert.equal(value.scheduled.length, 1);
		assert.equal(value.scheduled[0]?.delayMs, PRESENCE_MIN_BROADCAST_INTERVAL_MS);
		value.clock.now += PRESENCE_MIN_BROADCAST_INTERVAL_MS;
		value.scheduled.shift()!.callback();
		const coalesced = serverFrames(witness, "presence.state");
		assert.equal(coalesced.length, 1);
		assert.equal(coalesced[0]?.type === "presence.state" ? coalesced[0].presence.clientSequence : null, 3);
		assert.equal(coalesced[0]?.type === "presence.state" ? coalesced[0].presence.state.pointer?.x : null, 3);

		value.runtime = value.restart();
		const late = await connect(value, "session-c");
		const snapshot = serverFrames(late, "presence.snapshot")[0];
		assert.equal(snapshot?.type, "presence.snapshot");
		if (snapshot?.type === "presence.snapshot") {
			assert.equal(snapshot.presences.length, 1);
			assert(snapshot.presences[0]!.expiresInMs <= PRESENCE_TTL_MS);
		}

		value.clock.now += PRESENCE_TTL_MS + 1;
		witness.sent.length = 0;
		await value.runtime.webSocketMessage(witness, JSON.stringify({ type: "ping", nonce: "expiry-ping" }));
		const expired = serverFrames(witness, "presence.leave")[0];
		assert.equal(expired?.type === "presence.leave" ? expired.reason : null, "expired");

		const tables = value.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
		assert.equal(tables.some(({ name }) => name.includes("presence")), false, "presence is socket-attachment state, never durable room state");
	} finally { await cleanup(value); }
});

s.test("presence yields to durable scene traffic under backpressure and authority fences remove it", async () => {
	const value = await fixture();
	try {
		const source = await connect(value, "session-source");
		const slow = await connect(value, "session-slow");
		slow.sent.length = 0;
		slow.bufferedAmount = 128 * 1024;
		await value.runtime.webSocketMessage(source, update(1, 1));
		assert.equal(serverFrames(slow, "presence.state").length, 0, "best-effort presence is dropped for a backed-up peer");

		const batch = await signed<ExcalidrawBatchRequest>({
			protocolVersion: 1, operationId: "presence-scene-batch", requestDigest: "", drawingEpoch: 1,
			elements: [{ id: "box", version: 2, versionNonce: 9, isDeleted: false, type: "rectangle", index: "a0", x: 99 }],
		});
		assert.equal((await value.runtime.fetch(roomRequest("/batch", batch))).status, 200);
		assert(slow.sent.some((frame) => (JSON.parse(frame) as { type?: string }).type === "scene"),
			"durable scene traffic is still sent above the presence backpressure threshold");

		slow.bufferedAmount = 2 * 1024 * 1024;
		const second = await signed<ExcalidrawBatchRequest>({
			protocolVersion: 1, operationId: "presence-scene-batch-2", requestDigest: "", drawingEpoch: 1,
			elements: [{ id: "box", version: 3, versionNonce: 8, isDeleted: false, type: "rectangle", index: "a0", x: 100 }],
		});
		assert.equal((await value.runtime.fetch(roomRequest("/batch", second))).status, 200);
		assert.equal(slow.closes.at(-1)?.code, 1013, "extreme scene backlog reconnects into durable replay rather than dropping state");

		const witness = await connect(value, "session-witness");
		witness.sent.length = 0;
		const fence = await value.runtime.fetch(roomRequest("/__yaos/authority-fence", {
			principalIds: [actor.principalId], deviceIds: [],
		}));
		assert.equal(fence.status, 200);
		assert(value.sockets.accepted.filter((socket) => socket !== slow).every((socket) => socket.closed));
		assert(serverFrames(witness, "presence.leave").some((frame) => frame?.type === "presence.leave" && frame.reason === "fenced"));
	} finally { await cleanup(value); }
});

s.test("invalid, abusive, duplicate, and over-capacity sessions are bounded", async () => {
	const value = await fixture();
	try {
		const source = await connect(value, "session-rate");
		assert.equal((await value.runtime.fetch(roomRequest("/ws?sessionId=session-rate", undefined,
			{ upgrade: "websocket", "x-yaos-drawing-epoch": "1" }))).status, 409);
		for (let sequence = 1; sequence <= MAX_PRESENCE_INPUT_FRAMES_PER_SECOND + 1; sequence++) {
			await value.runtime.webSocketMessage(source, update(sequence, sequence));
		}
		assert.equal(source.closes.at(-1)?.code, 1008);
		assert.equal(source.closes.at(-1)?.reason, "presence rate exceeded");

		const oversized = await connect(value, "session-oversized");
		await value.runtime.webSocketMessage(oversized, "x".repeat(MAX_PRESENCE_FRAME_BYTES + 1));
		assert.equal(oversized.closes.at(-1)?.code, 1009);

		const invalid = await connect(value, "session-invalid");
		await value.runtime.webSocketMessage(invalid, JSON.stringify({
			type: "presence.update", presenceProtocolVersion: 2, surface: EXCALIDRAW_PRESENCE_SURFACE,
			clientSequence: 1, state: { pointer: { x: Number.MAX_VALUE, y: 0, tool: "freedraw", button: "down" } },
		}));
		assert.equal(invalid.closes.at(-1)?.code, 1008);

		for (let index = value.sockets.sockets().length; index < MAX_PRESENCE_SESSIONS; index++) {
			const socket = new FakeSocket();
			socket.attachment = { sessionId: `capacity-${index}`, vaultId: actor.vaultId,
				vaultGeneration: actor.vaultGeneration, drawingId: "drawing-presence", drawingEpoch: 1,
				principalId: actor.principalId, deviceId: actor.deviceId, displayName: "Trusted Member", colorSeed: "trusted-seed" };
			value.sockets.accepted.push(socket);
		}
		assert.equal((await value.runtime.fetch(roomRequest("/ws?sessionId=over-capacity", undefined,
			{ upgrade: "websocket", "x-yaos-drawing-epoch": "1" }))).status, 429);
	} finally { await cleanup(value); }
});

await s.done();
