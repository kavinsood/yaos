import { strict as assert } from "node:assert";
import { ExcalidrawHttpTransport, ExcalidrawMemberSocketTickets } from "../../src/sync/excalidraw/transport";
import type { HttpRequest, HttpResponse } from "../../src/utils/http";
import { EXCALIDRAW_PRESENCE_SURFACE, PRESENCE_PROTOCOL_VERSION } from "../../server/src/shared/presenceProtocol";
import { suite } from "../harness.ts";

const s = suite("excalidraw-transport");

function response(status: number, json: unknown): HttpResponse {
	return { status, json, headers: {}, arrayBuffer: new ArrayBuffer(0), text: JSON.stringify(json) };
}

class Socket {
	static latest: Socket | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onopen: (() => void) | null = null;
	readyState = 0;
	bufferedAmount = 0;
	readonly sent: string[] = [];
	constructor(readonly url: string | URL, readonly protocols?: string | string[]) { Socket.latest = this; }
	close() { this.onclose?.(); }
	open() { this.readyState = 1; this.onopen?.(); }
	send(value: string) { this.sent.push(value); }
	emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

s.test("member ticket creates a scoped non-bearer WebSocket URL", async () => {
	const calls: HttpRequest[] = [];
	const tickets = new ExcalidrawMemberSocketTickets("https://sync.example", "vault1", "bearer1", async (request) => {
		calls.push(request); return response(200, { ticket: "short-ticket", expiresAt: Date.now() + 60_000, ttlMs: 60_000 });
	});
	const result = await tickets.get("drawing1", 2);
	assert.match(result.url, /^wss:\/\/sync\.example\/vault\/vault1\/ws\/excalidraw\/drawing1\?/);
	assert.equal(new URL(result.url).searchParams.get("ticket"), "short-ticket");
	assert.equal(new URL(result.url).searchParams.get("schemaVersion"), "10");
	assert.equal(new URL(result.url).searchParams.get("protocolVersion"), "8");
	assert.equal(new URL(result.url).searchParams.has("token"), false);
	assert.deepEqual(JSON.parse(calls[0]?.body as string), { purpose: "excalidraw", documentId: "drawing1", drawingEpoch: 2 });
});

s.test("promotion accepts idempotent create responses", async () => {
	const transport = new ExcalidrawHttpTransport("https://sync.example", "vault1", "bearer1",
		{ get: async () => ({ url: "wss://socket" }) }, async () => response(201, {
			protocolVersion: 1, operationId: "initialize1", requestDigest: "a".repeat(64), drawingId: "drawing1",
			drawingEpoch: 1, sequence: 1, acceptedElementIds: [], staleElementIds: [], metadataAccepted: true, replayed: false,
		}), Socket as never);
	const receipt = await transport.initializeDrawing("drawing1", { protocolVersion: 1,
		operationId: "initialize1", requestDigest: "a".repeat(64), prepareOperationId: "prepare1",
		drawingEpoch: 1, elements: [], metadata: { resourceManifest: { version: 1, entries: [] } } });
	assert.equal(receipt.sequence, 1);
});

s.test("recovery selects replay/current or snapshot at the compaction and epoch fence", async () => {
	const requests: HttpRequest[] = [];
	let replay = { protocolVersion: 1, drawingId: "drawing1", drawingEpoch: 1, after: 1, through: 2,
		compactedThrough: 0, snapshotRequired: false, events: [
			{ protocolVersion: 1, drawingEpoch: 1, sequence: 2, operationId: "operation1", elements: [] },
		], nextCursor: null };
	const transport = new ExcalidrawHttpTransport("https://sync.example", "vault1", "bearer1",
		{ get: async () => ({ url: "wss://socket" }) }, async (request) => {
			requests.push(request);
			if (request.url.endsWith("/snapshot")) return response(200, { protocolVersion: 1, drawingId: "drawing1",
				drawingEpoch: 2, sequence: 5, compactedThrough: 4, elements: [], metadata: { resourceManifest: { version: 1, entries: [] } } });
			return response(200, replay);
		}, Socket as never);
	assert.equal((await transport.recover("drawing1", 1, 1)).kind, "replay");
	replay = { ...replay, after: 2, through: 2, events: [] };
	assert.deepEqual(await transport.recover("drawing1", 1, 2), { kind: "current", drawingEpoch: 1, sequence: 2 });
	replay = { ...replay, drawingEpoch: 2, snapshotRequired: true };
	assert.equal((await transport.recover("drawing1", 1, 2)).kind, "snapshot");
	assert.equal(requests.some((request) => request.url.endsWith("/snapshot")), true);
});

s.test("submits durable batches and accepts only contiguous scene frames", async () => {
	const requestUrls: string[] = [];
	const transport = new ExcalidrawHttpTransport("https://sync.example", "vault1", "bearer1",
		{ get: async () => ({ url: "wss://socket.example/room" }) }, async (request) => {
			requestUrls.push(request.url);
			return response(200, { protocolVersion: 1, operationId: "operation1", requestDigest: "a".repeat(64),
				drawingId: "drawing1", drawingEpoch: 1, sequence: 2, acceptedElementIds: ["element1"],
				staleElementIds: [], metadataAccepted: false, replayed: false });
		}, Socket as never);
	await transport.submit("drawing1", { protocolVersion: 1, operationId: "operation1", requestDigest: "a".repeat(64),
		drawingEpoch: 1, elements: [{ id: "element1", version: 1, versionNonce: 1, isDeleted: false }] });
	assert.match(requestUrls[0] ?? "", /\/excalidraw\/drawing1\/batch$/);
	const events: number[] = [];
	const presences: string[] = [];
	let gaps = 0;
	const subscription = await transport.subscribe("drawing1", 1, 1, { onEvent: (event) => events.push(event.sequence),
		onGap: () => { gaps++; }, onClose: () => {},
		onPresence: (frame) => { if (frame.type === "presence.state") presences.push(frame.presence.sessionId); } });
	subscription.publishPresence?.({ type: "presence.update", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, clientSequence: 1,
		state: { pointer: { x: 1, y: 2, tool: "pointer", button: "up" } } });
	assert.equal(Socket.latest?.sent.length, 0, "latest transient state waits for the existing room socket to open");
	Socket.latest?.open();
	assert.equal(JSON.parse(Socket.latest?.sent[0] ?? "{}").type, "presence.update");
	Socket.latest?.emit({ type: "hello", protocolVersion: 1, drawingId: "drawing1", drawingEpoch: 1, sequence: 1, sessionId: "session1" });
	Socket.latest?.emit({ type: "pong", nonce: "heartbeat1" });
	Socket.latest?.emit({ type: "presence.state", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, presence: { sessionId: "session-aaaaaaaa", clientSequence: 1,
			expiresInMs: 15_000, identity: { principalId: "principal-aaaaaaaa", deviceId: "device-bbbbbbbbbbbb",
				displayName: "Alice", color: "hsl(12, 72%, 52%)", colorLight: "hsla(12, 72%, 52%, 0.2)" },
			state: { pointer: { x: 1, y: 2, tool: "pointer", button: "up" } } } });
	Socket.latest?.emit({ type: "scene", event: { protocolVersion: 1, drawingEpoch: 1, sequence: 2,
		operationId: "operation1", elements: [] } });
	Socket.latest?.emit({ type: "scene", event: { protocolVersion: 1, drawingEpoch: 1, sequence: 4,
		operationId: "operation2", elements: [] } });
	assert.deepEqual(events, [2]);
	assert.deepEqual(presences, ["session-aaaaaaaa"]);
	assert.equal(gaps, 1);
	subscription.close();
});

await s.done();
