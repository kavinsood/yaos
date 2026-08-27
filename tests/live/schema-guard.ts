import WebSocket from "ws";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";
import { socketPrefix } from "./schema4Live.ts";

const identity = requireLiveIdentity();

function socketUrl(params: Record<string, string>): string {
	const url = new URL(identity.host);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = socketPrefix(identity, "root", "root");
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

async function rejected(params: Record<string, string>, label: string): Promise<FatalFrame> {
	return new Promise<FatalFrame>((resolve, reject) => {
		const socket = new WebSocket(socketUrl(params));
		let captured: FatalFrame | null = null;
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error(`${label}: timed out waiting for schema-4 rejection`));
		}, 5_000);
		socket.on("message", (data) => {
			const text = data.toString();
			captured = parseFatalFrame(text.startsWith("__YPS:") ? text.slice(6) : text) ?? captured;
		});
		socket.on("close", () => {
			clearTimeout(timeout);
			captured ? resolve(captured) : reject(new Error(`${label}: closed without fatal control payload`));
		});
		socket.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

const ticket = (await fetchSocketTicket(identity)).ticket;
for (const clientSchemaVersion of [SCHEMA_VERSION - 1, SCHEMA_VERSION + 1]) {
	const frame = await rejected({
		ticket,
		schemaVersion: String(clientSchemaVersion),
		protocolVersion: String(PROTOCOL_VERSION),
	}, `schema ${clientSchemaVersion}`);
	if (frame.code !== "update_required" || frame.reason !== "schema_mismatch"
		|| frame.clientSchemaVersion !== clientSchemaVersion || frame.serverSchemaVersion !== SCHEMA_VERSION) {
		throw new Error(`wrong schema rejection: ${JSON.stringify(frame)}`);
	}
	console.log(`Rejected schema ${clientSchemaVersion} on /ws/root with schema_mismatch.`);
}

const protocolFrame = await rejected({
	ticket: (await fetchSocketTicket(identity)).ticket,
	schemaVersion: String(SCHEMA_VERSION),
	protocolVersion: String(PROTOCOL_VERSION + 1),
}, "wrong protocol");
if (protocolFrame.code !== "update_required" || protocolFrame.reason !== "protocol_mismatch"
	|| protocolFrame.clientProtocolVersion !== PROTOCOL_VERSION + 1
	|| protocolFrame.serverProtocolVersion !== PROTOCOL_VERSION) {
	throw new Error(`wrong protocol rejection: ${JSON.stringify(protocolFrame)}`);
}
console.log("Rejected wrong protocol on /ws/root with protocol_mismatch.");

const missing = await rejected({ ticket: (await fetchSocketTicket(identity)).ticket }, "missing versions");
if (missing.reason !== "schema_mismatch" || missing.clientSchemaVersion !== null) {
	throw new Error(`missing pins were not rejected: ${JSON.stringify(missing)}`);
}
console.log("Schema-4 guard rejects undeclared wire pins without a legacy default.");
