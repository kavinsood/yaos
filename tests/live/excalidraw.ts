import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema.ts";
import {
	EXCALIDRAW_PROTOCOL_VERSION,
	canonicalExcalidrawJson,
	excalidrawRequestDigestInput,
	type ExcalidrawBatchRequest,
	type ExcalidrawElementRecord,
	type ExcalidrawInitializeRequest,
	type ExcalidrawPromotionFinalizeRequest,
	type ExcalidrawPromotionPrepareRequest,
} from "../../server/src/shared/excalidrawProtocol.ts";
import {
	EXCALIDRAW_PRESENCE_SURFACE,
	PRESENCE_PROTOCOL_VERSION,
} from "../../server/src/shared/presenceProtocol.ts";
import { canonicalExcalidrawShareJson, excalidrawShareDigestInput,
	type ExcalidrawShareCreateRequest, type ExcalidrawShareRevokeRequest,
	type ExcalidrawShareUpdateRequest } from "../../server/src/shared/excalidrawShareProtocol.ts";
import {
	LiveWebSocket,
	deviceBearerHeaders,
	requireLiveIdentityContext,
	type LiveIdentity,
} from "./liveIdentity.ts";
import { sha256Hex, vaultRoute } from "./schema4Live.ts";

const { deviceA, deviceB } = requireLiveIdentityContext();
const drawingId = `drawing-${crypto.randomUUID()}`;
const drawingPath = `live/${drawingId}.excalidraw`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

async function digest(value: unknown): Promise<string> {
	return sha256Hex(new TextEncoder().encode(canonicalExcalidrawJson(value)));
}

async function signed<T extends { requestDigest: string }>(request: T): Promise<T> {
	request.requestDigest = await digest(excalidrawRequestDigestInput(request));
	return request;
}

async function signedShare<T extends { requestDigest: string }>(request: T): Promise<T> {
	request.requestDigest = await digest(excalidrawShareDigestInput(request));
	return request;
}

function publicShareFragment(routeEnvelope: string, linkSecret: string): string {
	const bytes = new TextEncoder().encode(JSON.stringify({ routeEnvelope, linkSecret }));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `yaos-share-v1.${btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")}`;
}

function shape(id: string, type: "rectangle" | "ellipse", index: string, x: number, y: number): ExcalidrawElementRecord {
	return {
		id, type, index, x, y, width: 160, height: 100, angle: 0,
		strokeColor: "#1e1e1e", backgroundColor: type === "rectangle" ? "#e5dbff" : "#d3f9d8",
		fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100,
		groupIds: [], frameId: null, roundness: type === "rectangle" ? { type: 3 } : null,
		seed: id === "box" ? 101 : 202, version: 1, versionNonce: 300, isDeleted: false,
		boundElements: null, updated: 1, link: null, locked: false,
	};
}

async function openRealShareBrowser(url: string, minimumElements: number): Promise<{
	waitForElements(count: number): Promise<void>;
	close(): Promise<void>;
} | null> {
	const executablePath = process.env.YAOS_TEST_BROWSER_EXECUTABLE?.trim();
	if (!executablePath) return null;
	const puppeteer = await import("puppeteer-core");
	const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") console.error(`[share browser] ${message.text()}`);
	});
	page.on("pageerror", (error) => console.error(`[share browser page] ${error instanceof Error ? error.message : String(error)}`));
	page.on("requestfailed", (request) => console.error(`[share browser request] ${request.url()} ${request.failure()?.errorText ?? "failed"}`));
	page.on("response", (response) => {
		if (response.status() >= 400) console.error(`[share browser response] ${response.status()} ${response.url()}`);
	});
	await page.goto(url, { waitUntil: "networkidle0", timeout: 45_000 });
	const waitForElements = async (count: number): Promise<void> => {
		await page.waitForFunction((expected) => {
			const shell = document.querySelector("[data-yaos-element-count]");
			const status = document.querySelector("[data-yaos-share-status]");
			return Number(shell?.getAttribute("data-yaos-element-count")) >= expected
				&& status?.textContent?.startsWith("Live");
		}, { timeout: 20_000 }, count);
	};
	try {
		await waitForElements(minimumElements);
	} catch (error) {
		const body = await page.$eval("body", (element) => (element as HTMLElement).innerText).catch(() => "<body unavailable>");
		console.error(`[share browser state] url=${page.url()} body=${body.slice(0, 1000)}`);
		await browser.close();
		throw error;
	}
	return { waitForElements, close: async () => { await browser.close(); } };
}

async function requestJson(identity: LiveIdentity, suffix: string, body?: unknown): Promise<{
	response: Response;
	body: Record<string, unknown>;
}> {
	const response = await fetch(vaultRoute(identity, suffix), {
		method: body === undefined ? "GET" : "POST",
		headers: deviceBearerHeaders(identity, body === undefined ? {} : { "Content-Type": "application/json" }),
		...(body === undefined ? {} : { body: canonicalExcalidrawJson(body) }),
	});
	const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
	return { response, body: parsed };
}

async function openRoomSocket(identity: LiveIdentity): Promise<{
	socket: LiveWebSocket;
	sessionId: string;
	frames: Array<Record<string, unknown>>;
	waitForSequence(sequence: number): Promise<Record<string, unknown>>;
	waitForFrame(type: string, predicate?: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}> {
	const ticketResponse = await requestJson(identity, "auth/ticket", {
		purpose: "excalidraw",
		documentId: drawingId,
		drawingEpoch: 1,
	});
	assert(ticketResponse.response.status === 200 && typeof ticketResponse.body.ticket === "string",
		"device obtains an epoch-scoped Excalidraw socket ticket");
	const url = new URL(identity.host);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `/vault/${encodeURIComponent(identity.vaultId)}/ws/excalidraw/${encodeURIComponent(drawingId)}`;
	url.searchParams.set("ticket", ticketResponse.body.ticket);
	const sessionId = `session-${crypto.randomUUID()}`;
	url.searchParams.set("sessionId", sessionId);
	url.searchParams.set("schemaVersion", String(SCHEMA_VERSION));
	url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
	const socket = new LiveWebSocket(url);
	const frames: Array<Record<string, unknown>> = [];
	const waiters: Array<{ sequence: number; resolve(value: Record<string, unknown>): void; reject(error: Error): void }> = [];
	socket.on("message", (data, binary) => {
		if (binary) return;
		try {
			const frame = JSON.parse(data.toString()) as Record<string, unknown>;
			frames.push(frame);
			const event = frame.type === "scene" && frame.event && typeof frame.event === "object"
				? frame.event as Record<string, unknown> : frame;
			if (!Number.isSafeInteger(event.sequence)) return;
			for (const waiter of [...waiters]) if (event.sequence === waiter.sequence) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(event);
			}
		} catch { /* invalid frames are asserted through timeout */ }
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Excalidraw socket open timed out")), 5_000);
		socket.once("open", () => { clearTimeout(timeout); resolve(); });
		socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
	});
	return {
		socket,
		sessionId,
		frames,
		waitForSequence: (sequence) => new Promise<Record<string, unknown>>((resolve, reject) => {
			const existing = frames.map((frame) => frame.type === "scene" ? frame.event : frame)
				.find((frame) => frame && typeof frame === "object"
					&& (frame as Record<string, unknown>).sequence === sequence) as Record<string, unknown> | undefined;
			if (existing) { resolve(existing); return; }
			const waiter = { sequence, resolve, reject };
			waiters.push(waiter);
			setTimeout(() => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				reject(new Error(`Excalidraw socket sequence ${sequence} timed out`));
			}, 5_000);
		}),
		waitForFrame: async (type, predicate = () => true) => {
			const deadline = Date.now() + 5_000;
			for (;;) {
				const frame = frames.find((candidate) => candidate.type === type && predicate(candidate));
				if (frame) return frame;
				if (Date.now() >= deadline) throw new Error(`Excalidraw socket frame ${type} timed out`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
	};
}

console.log("\n--- RFC 13 two-device Excalidraw room journey ---");
const sourceBytes = new TextEncoder().encode(canonicalExcalidrawJson({
	type: "excalidraw",
	version: 2,
	source: "https://excalidraw.com",
	elements: [],
	appState: {},
	files: {},
}));
const sourceHash = await sha256Hex(sourceBytes);
const upload = await fetch(vaultRoute(deviceA, `blobs/${sourceHash}`), {
	method: "PUT",
	headers: deviceBearerHeaders(deviceA, { "Content-Type": "application/json" }),
	body: sourceBytes,
});
assert(upload.status === 204, "device A uploads the promotion source object");
const attachmentOperationId = `attachment-${crypto.randomUUID()}`;
const publication = await requestJson(deviceA, "attachments/publish", {
	rootEpoch: 1,
	operationId: attachmentOperationId,
	kind: "upsert",
	path: drawingPath,
	expectedRevision: null,
	hash: sourceHash,
	size: sourceBytes.byteLength,
	mime: "application/json",
});
assert(publication.response.status === 200, "source attachment becomes durable vault authority");

const prepareOperationId = `prepare-${crypto.randomUUID()}`;
const initializeOperationId = `initialize-${crypto.randomUUID()}`;
const initialElements = [
	shape("box", "rectangle", "a0", 0, 0),
	shape("dot", "ellipse", "a1", 220, 80),
];
const initialize = await signed<ExcalidrawInitializeRequest>({
	protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
	operationId: initializeOperationId,
	requestDigest: "",
	prepareOperationId,
	drawingEpoch: 1,
	elements: initialElements,
	metadata: { resourceManifest: { version: 1, entries: [] } },
});
const prepare = await signed<ExcalidrawPromotionPrepareRequest>({
	protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
	operationId: prepareOperationId,
	requestDigest: "",
	drawingId,
	path: drawingPath,
	source: { kind: "attachment", revision: attachmentOperationId, contentHash: sourceHash, size: sourceBytes.byteLength },
	initializationRequestDigest: initialize.requestDigest,
});
const prepared = await requestJson(deviceA, `excalidraw/${drawingId}/authority/prepare`, prepare);
assert(prepared.response.status === 201, "Vault DO durably prepares the exact promotion");
const initialized = await requestJson(deviceA, `excalidraw/${drawingId}/initialize`, initialize);
assert(initialized.response.status === 201 && initialized.body.sequence === 1,
	"Drawing DO initializes the complete native scene atomically");
const finalize = await signed<ExcalidrawPromotionFinalizeRequest>({
	protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
	operationId: `finalize-${crypto.randomUUID()}`,
	requestDigest: "",
	prepareOperationId,
	initializationOperationId: initializeOperationId,
	initializationRequestDigest: initialize.requestDigest,
});
const finalized = await requestJson(deviceA, `excalidraw/${drawingId}/authority/finalize`, finalize);
assert(finalized.response.status === 200, "Vault DO atomically switches the path to semantic authority");

const roomA = await openRoomSocket(deviceA);
const room = await openRoomSocket(deviceB);
try {
	const initialSnapshotA = await roomA.waitForFrame("presence.snapshot");
	const initialSnapshotB = await room.waitForFrame("presence.snapshot");
	assert(Array.isArray(initialSnapshotA.presences) && initialSnapshotA.presences.length === 0
		&& Array.isArray(initialSnapshotB.presences) && initialSnapshotB.presences.length === 0,
	"both devices begin with an empty transient roster");

	roomA.socket.send(JSON.stringify({
		type: "presence.update",
		presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE,
		clientSequence: 1,
		state: { pointer: { x: 10, y: 20, tool: "pointer", button: "down" },
			selectedElementIds: ["box"], interaction: "dragging", idle: "active" },
		identity: { principalId: "attacker", deviceId: "forged-device", displayName: "Spoof" },
		sessionId: "forged-session",
	}));
	const presenceFromA = await room.waitForFrame("presence.state", (frame) =>
		(frame.presence as Record<string, unknown> | undefined)?.sessionId === roomA.sessionId);
	const trustedA = (presenceFromA.presence as Record<string, unknown>).identity as Record<string, unknown>;
	assert(trustedA.deviceId === deviceA.deviceId && trustedA.principalId !== "attacker"
		&& trustedA.displayName !== "Spoof",
	"device B receives device A presence with server-owned identity");
	const beforePresenceSnapshot = await requestJson(deviceA, `excalidraw/${drawingId}/snapshot`);
	assert(beforePresenceSnapshot.response.status === 200 && beforePresenceSnapshot.body.sequence === 1,
		"presence updates do not advance durable drawing sequence");

	room.socket.send(JSON.stringify({
		type: "presence.update",
		presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE,
		clientSequence: 1,
		state: { pointer: { x: -5, y: 4, tool: "laser", button: "down" },
			selectedElementIds: ["dot"], interaction: "pointing", idle: "active" },
	}));
	await roomA.waitForFrame("presence.state", (frame) =>
		(frame.presence as Record<string, unknown> | undefined)?.sessionId === room.sessionId);
	assert(true, "device A receives device B presence over the same room socket");

	const first = await signed<ExcalidrawBatchRequest>({
		protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
		operationId: `batch-a-${crypto.randomUUID()}`,
		requestDigest: "",
		drawingEpoch: 1,
		elements: [
			{ ...initialElements[0]!, version: 2, versionNonce: 200, x: 1 },
			{ ...initialElements[1]!, version: 2, versionNonce: 200, y: 1 },
		],
	});
	const firstCommit = await requestJson(deviceA, `excalidraw/${drawingId}/batch`, first);
	assert(firstCommit.response.status === 200 && firstCommit.body.sequence === 2,
		"one logical multi-element edit produces one room sequence");
	const socketEvent = await room.waitForSequence(2);
	assert(Array.isArray(socketEvent.elements) && socketEvent.elements.length === 2,
		"the second device receives an atomic scene commit while presence is active");

	const lowerNonce = await signed<ExcalidrawBatchRequest>({
		protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
		operationId: `batch-b-${crypto.randomUUID()}`,
		requestDigest: "",
		drawingEpoch: 1,
		elements: [{ ...initialElements[0]!, version: 2, versionNonce: 100, x: 2 }],
	});
	const lowerCommit = await requestJson(deviceB, `excalidraw/${drawingId}/batch`, lowerNonce);
	assert(lowerCommit.response.status === 200 && lowerCommit.body.sequence === 3,
		"equal-version lower nonce wins through the real Worker route");
	const replayed = await requestJson(deviceB, `excalidraw/${drawingId}/batch`, lowerNonce);
	assert(replayed.response.status === 200 && replayed.body.replayed === true && replayed.body.sequence === 3,
		"response-loss retry replays the exact durable receipt without another commit");

	for (const [identity, label] of [[deviceA, "A"], [deviceB, "B"]] as const) {
		const snapshot = await requestJson(identity, `excalidraw/${drawingId}/snapshot`);
		const elements = Array.isArray(snapshot.body.elements) ? snapshot.body.elements as Array<Record<string, unknown>> : [];
		assert(snapshot.response.status === 200 && snapshot.body.sequence === 3
			&& elements.find((element) => element.id === "box")?.x === 2,
		`device ${label} reads the same lower-nonce canonical snapshot`);
	}
	const replay = await requestJson(deviceA, `excalidraw/${drawingId}/replay?after=1`);
	assert(replay.response.status === 200 && Array.isArray(replay.body.events) && replay.body.events.length === 2,
		"late recovery observes monotonic atomic replay events");

	room.socket.send(JSON.stringify({
		type: "presence.update",
		presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE,
		clientSequence: 2,
		state: null,
	}));
	const leave = await roomA.waitForFrame("presence.leave", (frame) => frame.sessionId === room.sessionId);
	assert(leave.reason === "client", "explicit withdrawal removes device B without touching scene state");
	room.socket.send(JSON.stringify({
		type: "presence.update",
		presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE,
		clientSequence: 3,
		state: { pointer: { x: 1, y: 1, tool: "pointer", button: "up" }, idle: "active" },
	}));
	await roomA.waitForFrame("presence.state", (frame) => {
		const presence = frame.presence as Record<string, unknown> | undefined;
		return presence?.sessionId === room.sessionId && presence.clientSequence === 3;
	});
	room.socket.terminate();
	const closedLeave = await roomA.waitForFrame("presence.leave", (frame) =>
		frame.sessionId === room.sessionId && frame.reason === "closed");
	assert(closedLeave.reason === "closed", "abrupt socket loss removes the republished device B presence");
} finally {
	room.socket.terminate();
	roomA.socket.terminate();
}

console.log("\n--- RFC 15 public browser publication and collaboration journey ---");
const publicResourceBytes = new TextEncoder().encode("explicitly published raster");
const publicResourceHash = await sha256Hex(publicResourceBytes);
assert((await fetch(vaultRoute(deviceA, `blobs/${publicResourceHash}`), { method: "PUT",
	headers: deviceBearerHeaders(deviceA, { "Content-Type": "image/png" }), body: publicResourceBytes })).status === 204,
"owner uploads an explicit public resource source");
const linkSecret = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const shareId = `share-${crypto.randomUUID()}`;
const publicDrawingId = `public-${crypto.randomUUID()}`;
const createShare = await signedShare<ExcalidrawShareCreateRequest>({ protocolVersion: 1,
	operationId: `share-create-${crypto.randomUUID()}`, requestDigest: "", shareId, publicDrawingId,
	linkSecretHash: await sha256Hex(new TextEncoder().encode(linkSecret)), permission: "read-only",
	expiresAt: Date.now() + 2 * 60 * 60_000, resources: [{ publicResourceId: "published-raster",
		sourceResourceId: "private-raster-id", contentHash: publicResourceHash,
		size: publicResourceBytes.byteLength, mime: "image/png" }] });
const createdShare = await requestJson(deviceA, `excalidraw/${drawingId}/shares`, createShare);
assert(createdShare.response.status === 201 && typeof createdShare.body.routeEnvelope === "string",
	"owner creates an opaque public read-only grant");

async function exchangePublicSession(): Promise<{ cookie: string; body: Record<string, unknown> }> {
	const response = await fetch(`${deviceA.host}/api/excalidraw/shares/session`, { method: "POST",
		headers: { "content-type": "application/json", origin: deviceA.host },
		body: JSON.stringify({ routeEnvelope: createdShare.body.routeEnvelope, linkSecret, displayName: "Browser guest" }) });
	const body = await response.json() as Record<string, unknown>;
	const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
	assert(response.status === 201 && cookie.startsWith("yaos_excalidraw_share=")
		&& body.publicDrawingId === publicDrawingId && body.drawingEpoch === 1
		&& JSON.stringify(body).includes(drawingId) === false,
	"fragment secret exchanges once for a redacted HttpOnly browser session");
	return { cookie, body };
}
const publicSession = await exchangePublicSession();
const publicHeaders = { cookie: publicSession.cookie, origin: deviceA.host };
const publicSnapshotResponse = await fetch(`${deviceA.host}/api/excalidraw/shares/session/snapshot`, { headers: publicHeaders });
const publicSnapshotText = await publicSnapshotResponse.text();
assert(publicSnapshotResponse.status === 200 && !publicSnapshotText.includes(drawingId)
	&& publicSnapshotText.includes(publicDrawingId), "public snapshot exposes only the public drawing identity");
const publicReplayResponse = await fetch(`${deviceA.host}/api/excalidraw/shares/session/replay?after=0`, { headers: publicHeaders });
const publicReplay = await publicReplayResponse.json() as Record<string, unknown>;
assert(publicReplayResponse.status === 200 && publicReplay.drawingEpoch === 1,
	"public replay carries the drawing epoch required by the browser transport");
const shareFragment = publicShareFragment(String(createdShare.body.routeEnvelope), linkSecret);
const realBrowser = await openRealShareBrowser(`${deviceA.host}/share#${shareFragment}`, 2);
if (realBrowser) {
	const browserUpdate = await signed<ExcalidrawBatchRequest>({
		protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
		operationId: `browser-demo-${crypto.randomUUID()}`,
		requestDigest: "",
		drawingEpoch: 1,
		elements: [shape("browser-live", "rectangle", "a2", 440, 160)],
	});
	const browserCommit = await requestJson(deviceA, `excalidraw/${drawingId}/batch`, browserUpdate);
	assert(browserCommit.response.status === 200, "Obsidian-side scene update commits while a real browser is connected");
	await realBrowser.waitForElements(3);
	assert(true, "real React Excalidraw browser renders the live scene update");
	await realBrowser.close();
}
const publicResource = await fetch(`${deviceA.host}/api/excalidraw/shares/session/resources/published-raster`,
	{ headers: publicHeaders });
assert(publicResource.status === 200 && new TextDecoder().decode(await publicResource.arrayBuffer()) === "explicitly published raster",
	"public session reads only its explicitly materialized resource");
const publicBatch = await signed<ExcalidrawBatchRequest>({ protocolVersion: EXCALIDRAW_PROTOCOL_VERSION,
	operationId: `share-batch-${crypto.randomUUID()}`, requestDigest: "", drawingEpoch: 1,
	elements: [{ id: "public-box", version: 1, versionNonce: 1, isDeleted: false, type: "rectangle", x: 10 }] });
assert((await fetch(`${deviceA.host}/api/excalidraw/shares/session/batch`, { method: "POST",
	headers: { ...publicHeaders, "content-type": "application/json" }, body: canonicalExcalidrawJson(publicBatch) })).status === 403,
"read-only public session cannot commit durable scene state");

const editGrant = await signedShare<ExcalidrawShareUpdateRequest>({ protocolVersion: 1,
	operationId: `share-edit-${crypto.randomUUID()}`, requestDigest: "", shareId, expectedGrantRevision: 1,
	permission: "read-write", expiresAt: Date.now() + 2 * 60 * 60_000, resources: createShare.resources });
const upgraded = await fetch(vaultRoute(deviceA, `excalidraw/${drawingId}/shares/${shareId}`), { method: "PATCH",
	headers: deviceBearerHeaders(deviceA, { "content-type": "application/json" }), body: canonicalExcalidrawShareJson(editGrant) });
assert(upgraded.status === 200, "owner upgrades the exact grant revision to read-write");
assert((await fetch(`${deviceA.host}/api/excalidraw/shares/session/snapshot`, { headers: publicHeaders })).status === 401,
	"permission change immediately fences the stale browser session");
const editSession = await exchangePublicSession();
assert((await fetch(`${deviceA.host}/api/excalidraw/shares/session/batch`, { method: "POST",
	headers: { cookie: editSession.cookie, origin: deviceA.host, "content-type": "application/json" },
	body: canonicalExcalidrawJson(publicBatch) })).status === 200,
"read-write public session commits through the canonical Drawing DO");

const revoke = await signedShare<ExcalidrawShareRevokeRequest>({ protocolVersion: 1,
	operationId: `share-revoke-${crypto.randomUUID()}`, requestDigest: "", shareId, expectedGrantRevision: 2 });
const revoked = await fetch(vaultRoute(deviceA, `excalidraw/${drawingId}/shares/${shareId}`), { method: "DELETE",
	headers: deviceBearerHeaders(deviceA, { "content-type": "application/json" }), body: canonicalExcalidrawShareJson(revoke) });
assert(revoked.status === 200, "owner revokes the public grant");
assert((await fetch(`${deviceA.host}/api/excalidraw/shares/session/snapshot`,
	{ headers: { cookie: editSession.cookie, origin: deviceA.host } })).status === 401,
"revocation rejects stale and offline browser authority");

console.log("\n✓ RFC 13 scene sync, RFC 14 presence, and RFC 15 public sharing live journey passed");
