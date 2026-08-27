import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../../src/sync/schema.ts";
import { parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { deviceBearerHeaders, fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";
import { socketPrefix } from "./schema4Live.ts";

const identity = requireLiveIdentity();
const { ticket } = await fetchSocketTicket(identity);
const url = new URL(identity.host);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
url.pathname = socketPrefix(identity, "root", "root");
url.searchParams.set("ticket", ticket);
url.searchParams.set("schemaVersion", "x".repeat(20_000));
url.searchParams.set("protocolVersion", String(PROTOCOL_VERSION));
const frame = await new Promise<FatalFrame | null>((resolve, reject) => {
	const socket = new WebSocket(url);
	let fatal: FatalFrame | null = null;
	const timeout = setTimeout(() => { socket.terminate(); reject(new Error("oversized schema socket timed out")); }, 5_000);
	socket.on("message", (data) => {
		const text = data.toString();
		fatal = parseFatalFrame(text.startsWith("__YPS:") ? text.slice(6) : text) ?? fatal;
	});
	socket.on("close", () => { clearTimeout(timeout); resolve(fatal); });
	socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
});
if (frame?.code !== "update_required" || frame.reason !== "schema_mismatch") {
	throw new Error(`oversized schema pin was not rejected normally: ${JSON.stringify(frame)}`);
}
const diagnostics = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/diagnostics`, {
	headers: deviceBearerHeaders(identity),
});
if (!diagnostics.ok) throw new Error(`diagnostics failed after oversized schema rejection (${diagnostics.status})`);
const body = await diagnostics.json() as { schemaVersion?: unknown; protocolVersion?: unknown };
if (body.schemaVersion !== 4 || body.protocolVersion !== 1) throw new Error(`diagnostics lost schema-4 pins: ${JSON.stringify(body)}`);
console.log("Oversized /ws/root schema input is bounded and leaves schema-4 diagnostics healthy.");
