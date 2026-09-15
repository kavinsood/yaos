import { strict as assert } from "node:assert";
import {
	BrowserExcalidrawTransportError,
	BrowserMemberExcalidrawTransport,
	BrowserMemberSocketTickets,
	PublicShareExcalidrawTransport,
	PublicShareSessionClient,
	decodePublicShareFragment,
	encodePublicShareFragment,
	parseAudienceSafePresenceFrame,
	type BrowserFetch,
	type BrowserFetchResponse,
} from "../../src/sync/excalidraw/browserTransport";
import { ExcalidrawShareManagementClient } from "../../src/sync/excalidraw/shareManagement";
import type { ExcalidrawBatchRequest } from "../../src/sync/excalidraw/types";
import { suite } from "../harness.ts";

const s = suite("excalidraw-browser-transport");

function response(status: number, value: unknown): BrowserFetchResponse {
	return { ok: status >= 200 && status < 300, status, json: async () => value,
		arrayBuffer: async () => new ArrayBuffer(0), headers: new Headers() };
}

class Socket {
	static last: Socket;
	readyState = 1;
	onopen: ((event: Event) => unknown) | null = null;
	onmessage: ((event: MessageEvent) => unknown) | null = null;
	onerror: ((event: Event) => unknown) | null = null;
	onclose: ((event: CloseEvent) => unknown) | null = null;
	sent: string[] = [];
	constructor(readonly url: string | URL) { Socket.last = this; }
	send(value: string) { this.sent.push(value); }
	close() {}
	emit(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
}

const batch: ExcalidrawBatchRequest = { protocolVersion: 1, operationId: "operation1",
	requestDigest: "a".repeat(64), drawingEpoch: 1, elements: [] };

s.test("fragment codec clears URL material before cookie session exchange", async () => {
	const secret = { routeEnvelope: "sealed-route", linkSecret: "raw-secret" };
	const fragment = encodePublicShareFragment(secret);
	assert.deepEqual(decodePublicShareFragment(fragment), secret);
	let replaced = "";
	const consumed = PublicShareSessionClient.consumeFragment({ hash: `#${fragment}` },
		{ replaceState: (_data, _unused, url) => { replaced = String(url); } }, "/share", "?ignored=no");
	assert.deepEqual(consumed, secret);
	assert.equal(replaced, "/share?ignored=no");
	let request: RequestInit | undefined;
	const client = new PublicShareSessionClient("https://share.example", async (_url, init) => {
		request = init;
		return response(200, { publicDrawingId: "public1", drawingEpoch: 1, permission: "read-only",
			expiresAt: 1000, grantRevision: 1 });
	});
	await client.exchange(consumed, "Guest");
	assert.equal(request?.credentials, "include");
	assert.equal(request?.referrerPolicy, "no-referrer");
	assert.deepEqual(JSON.parse(String(request?.body)), { ...secret, displayName: "Guest" });
});

s.test("read-only authority refuses durable writes before network I/O", async () => {
	let requests = 0;
	let authority = "";
	const transport = new PublicShareExcalidrawTransport("https://share.example", {
		publicDrawingId: "public1", drawingEpoch: 1, permission: "read-only", expiresAt: 1000, grantRevision: 1,
	}, { fetcher: async () => { requests++; return response(500, {}); }, WebSocketImpl: Socket as never,
		onAuthority: (event) => { authority = `${event.state}:${event.permission}`; } });
	await assert.rejects(transport.submit("public1", batch), (error) =>
		error instanceof BrowserExcalidrawTransportError && error.code === "share_read_only" && !error.retryable);
	assert.equal(requests, 0);
	assert.equal(authority, "active:read-only");
});

s.test("owner management sends only a secret hash and returns the raw secret in the fragment", async () => {
	let requestBody: Record<string, unknown> = {};
	let requestCredentials: RequestCredentials | undefined;
	const manager = new ExcalidrawShareManagementClient("https://core.example", "vault1", "token1", async (_url, init) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requestCredentials = init?.credentials;
		return response(201, { routeEnvelope: "sealed-route", grantRevision: 1 });
	});
	const link = await manager.create("drawing1", { permission: "read-only", expiresAt: 1000, resources: [] });
	assert.equal(typeof requestBody.linkSecretHash, "string");
	assert.equal("linkSecret" in requestBody, false);
	assert.equal(requestCredentials, "omit");
	const fragment = decodePublicShareFragment(link.url.split("#")[1]!);
	assert.equal(fragment.routeEnvelope, "sealed-route");
	assert.equal(fragment.linkSecret.length, 64);
});

s.test("public responses inject only the local public identity and cookie-scoped routes", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetcher: BrowserFetch = async (url, init) => {
		calls.push({ url, init });
		return response(200, { drawingEpoch: 1, after: 0, through: 1, compactedThrough: 0,
			snapshotRequired: false, events: [{ drawingEpoch: 1, sequence: 1, operationId: "op1", elements: [] }],
			nextCursor: null });
	};
	const transport = new PublicShareExcalidrawTransport("https://share.example", {
		publicDrawingId: "public1", drawingEpoch: 1, permission: "read-write", expiresAt: 1000, grantRevision: 1,
	}, { fetcher, WebSocketImpl: Socket as never });
	const recovered = await transport.recover("public1", null, 0);
	assert.equal(recovered.kind, "replay");
	if (recovered.kind === "replay") assert.equal(recovered.page.drawingId, "public1");
	assert.equal(calls[0]?.url, "https://share.example/api/excalidraw/shares/session/replay?after=0");
	assert.equal(calls[0]?.init?.credentials, "include");
});

s.test("member browser mints ordinary document ticket without Obsidian request APIs", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetcher: BrowserFetch = async (url, init) => { calls.push({ url, init }); return response(200, { ticket: "signed" }); };
	const tickets = new BrowserMemberSocketTickets("https://core.example", "vault1", "device-token", fetcher);
	const ticket = await tickets.get("drawing1", 2);
	assert.match(ticket.url, /^wss:\/\/core\.example\/vault\/vault1\/ws\/excalidraw\/drawing1\?/u);
	assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).authorization,
		"Bearer device-token");
	const member = new BrowserMemberExcalidrawTransport("https://core.example", "vault1", "device-token", tickets,
		async () => response(200, { drawingEpoch: 2, after: 0, through: 0, compactedThrough: 0,
			snapshotRequired: false, events: [], nextCursor: null }), Socket as never);
	assert.deepEqual(await member.recover("drawing1", null, 0), { kind: "current", drawingEpoch: 2, sequence: 0 });
});

s.test("audience-safe presence parser rejects member authority identifiers as a substitute", () => {
	const valid = parseAudienceSafePresenceFrame({ type: "presence.state", presence: { sessionId: "session1",
		clientSequence: 1, expiresInMs: 1000, identity: { participantId: "participant1", kind: "guest",
			displayName: "Guest", color: "hsl(1, 72%, 52%)", colorLight: "hsla(1, 72%, 52%, 0.2)" }, state: {} } });
	assert.equal(valid?.type, "presence.state");
	assert.equal(parseAudienceSafePresenceFrame({ type: "presence.state", presence: { sessionId: "session1",
		clientSequence: 1, expiresInMs: 1000, identity: { principalId: "private", deviceId: "private",
			displayName: "Guest", color: "x", colorLight: "x" }, state: {} } }), null);
});

s.test("cookie-authenticated public socket carries no secret and reports live downgrade", async () => {
	let authority = "";
	const transport = new PublicShareExcalidrawTransport("https://share.example", {
		publicDrawingId: "public1", drawingEpoch: 1, permission: "read-write", expiresAt: 1000, grantRevision: 1,
	}, { fetcher: async () => response(500, {}), WebSocketImpl: Socket as never,
		onAuthority: (event) => { authority = `${event.state}:${event.permission}:${event.grantRevision}`; } });
	const subscription = await transport.subscribe("public1", 1, 0, { onEvent: () => {}, onGap: () => {}, onClose: () => {} });
	assert.equal(String(Socket.last.url), "wss://share.example/api/excalidraw/shares/session/ws");
	Socket.last.emit({ type: "share.authority", state: "active", permission: "read-only", grantRevision: 2, expiresAt: 2000 });
	assert.equal(authority, "active:read-only:2");
	await assert.rejects(transport.submit("public1", batch), /share_read_only/u);
	subscription.close();
});

await s.done();
