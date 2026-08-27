import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const HOST = identity.host;
const ROOM_ID = identity.vaultId;

/**
 * The subset of the Worker's fatal rejection frame these assertions read.
 * Built by rejectSocket() in server/src/routes/syncSocket.ts.
 */
interface FatalFrame {
	readonly type?: string;
	readonly code?: string;
	readonly reason?: string;
	readonly clientSchemaVersion?: number | null;
	readonly serverSchemaVersion?: number;
}

/** Everything captureSocket() observes about one connection attempt. */
interface SocketOutcome {
	readonly opened: boolean;
	readonly upgradeStatus: number | null;
	readonly messages: string[];
	readonly closeCode: number | null;
	readonly closeReason: string | null;
}

function assert(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}


function socketUrl(vaultId: string, params: Record<string, string>): string {
	const url = new URL(HOST);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = `/vault/sync/${encodeURIComponent(vaultId)}`;
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function captureSocket(
	url: string,
	{ settleAfterOpenMs = null }: { settleAfterOpenMs?: number | null } = {},
): Promise<SocketOutcome> {
	return new Promise<SocketOutcome>((resolvePromise, rejectPromise) => {
		const socket = new WebSocket(url);
		const messages: string[] = [];
		let opened = false;
		let upgradeStatus: number | null = null;
		let settled = false;
		const timeout = setTimeout(() => {
			finish(new Error(`timed out waiting for socket outcome: ${url}`));
			socket.terminate();
		}, 10_000);

		function finish(value: SocketOutcome | Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (value instanceof Error) rejectPromise(value);
			else resolvePromise(value);
		}

		socket.once("upgrade", (response) => {
			upgradeStatus = response.statusCode ?? null;
		});
		socket.once("open", () => {
			opened = true;
			if (settleAfterOpenMs !== null) {
				setTimeout(() => {
					// A healthy PartyServer socket is intentionally long-lived. Verify
					// it stayed open without a fatal worker frame, then terminate only
					// the test client instead of waiting for a server close that should
					// never occur during normal sync.
					finish({ opened, upgradeStatus, messages, closeCode: null, closeReason: null });
					socket.terminate();
				}, settleAfterOpenMs);
			}
		});
		socket.on("message", (message) => messages.push(message.toString()));
		socket.once("unexpected-response", (_request, response) => {
			finish(new Error(`unexpected HTTP response ${response.statusCode} for ${url}`));
		});
		socket.once("error", (error) => finish(error));
		socket.once("close", (code, reason) => {
			finish({ opened, upgradeStatus, messages, closeCode: code, closeReason: reason.toString() });
		});
	});
}

function assertFatalUpdateResponse(
	result: SocketOutcome,
	expectedCode: string,
	expectedReason: string,
): FatalFrame {
	assert(result.upgradeStatus === 101, `rejection upgrades with HTTP 101 (got ${result.upgradeStatus})`);
	assert(result.opened, "rejection opens the WebSocket before sending fatal frames");
	assert(result.closeCode === 1008, `rejection closes with policy-violation 1008 (got ${result.closeCode})`);
	assert(result.closeReason === expectedReason, `rejection close reason is ${expectedReason}`);
	assert(result.messages.length === 2, `rejection sends exactly two fatal frames (got ${result.messages.length})`);
	// Non-null: the assertion directly above proves there are exactly two frames.
	const payload = JSON.parse(result.messages[0]!) as FatalFrame;
	assert(payload.type === "error", "first fatal frame is a generic error payload");
	assert(payload.code === expectedCode, `first fatal frame code is ${expectedCode}`);
	assert(result.messages[1] === `__YPS:${result.messages[0]}`, "second fatal frame is the y-partyserver control form");
	return payload;
}

console.log("\n--- WebSocket protocol: authenticated schema above the pin ---");
{
	const { ticket } = await fetchSocketTicket(identity);
	const clientSchemaVersion = SCHEMA_VERSION + 1;
	const result = await captureSocket(socketUrl(ROOM_ID, {
		ticket,
		schemaVersion: String(clientSchemaVersion),
	}));
	const payload = assertFatalUpdateResponse(result, "update_required", "update required");
	assert(payload.reason === "client_schema_unsupported", "schema rejection reports the explicit unsupported-client reason");
	assert(payload.clientSchemaVersion === clientSchemaVersion, "schema rejection echoes the client schema");
	assert(
		payload.serverSchemaVersion === SCHEMA_VERSION,
		`schema rejection publishes the pinned v${SCHEMA_VERSION} server schema`,
	);
}

console.log("\n--- WebSocket protocol: authenticated schema below the pin ---");
{
	// Previously admitted by the v1..v3 range. Admission is now an equality test,
	// so an older writer is refused at the edge instead of reaching the room.
	const { ticket } = await fetchSocketTicket(identity);
	const clientSchemaVersion = SCHEMA_VERSION - 1;
	const result = await captureSocket(socketUrl(ROOM_ID, {
		ticket,
		schemaVersion: String(clientSchemaVersion),
	}));
	const payload = assertFatalUpdateResponse(result, "update_required", "update required");
	assert(payload.reason === "client_schema_unsupported", "below-pin schema rejection reports the unsupported-client reason");
	assert(payload.clientSchemaVersion === clientSchemaVersion, "below-pin rejection echoes the client schema");
}

console.log("\n--- WebSocket protocol: undeclared schema is rejected, never defaulted ---");
{
	const { ticket } = await fetchSocketTicket(identity);
	const result = await captureSocket(socketUrl(ROOM_ID, { ticket }));
	const payload = assertFatalUpdateResponse(result, "update_required", "update required");
	assert(payload.reason === "invalid_client_schema", "a connection with no schemaVersion is rejected as invalid, not assumed legacy");
	assert(payload.clientSchemaVersion === null, "undeclared-schema rejection reports a null client schema");
}

console.log("\n--- WebSocket protocol: authentication precedes schema enforcement ---");
{
	const result = await captureSocket(socketUrl(ROOM_ID, { schemaVersion: String(SCHEMA_VERSION + 1) }));
	const payload = assertFatalUpdateResponse(result, "unauthorized", "unauthorized");
	assert(payload.reason === undefined, "auth rejection does not disclose schema details");
	assert(payload.serverSchemaVersion === undefined, "auth rejection omits the server schema version");
}

console.log("\n--- WebSocket protocol: pinned ticket-authenticated schema upgrades normally ---");
{
	const { ticket } = await fetchSocketTicket(identity);
	const result = await captureSocket(socketUrl(ROOM_ID, {
		ticket,
		schemaVersion: String(SCHEMA_VERSION),
	}), { settleAfterOpenMs: 250 });
	assert(result.upgradeStatus === 101, `supported connection upgrades with HTTP 101 (got ${result.upgradeStatus})`);
	assert(result.opened, "supported connection opens");
	assert(
		!result.messages.some((message) => {
			try {
				return JSON.parse(message)?.type === "error";
			} catch {
				return false;
			}
		}),
		"supported connection receives no worker fatal error payload",
	);
}

console.log("\n✓ WebSocket admission protocol tests passed");
