import WebSocket from "ws";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";
import { createBody, socketPrefix } from "./schema4Live.ts";

const identity = requireLiveIdentity();
const bodyId = `body_admission_${crypto.randomUUID().replaceAll("-", "_")}`;
await createBody(identity, bodyId, "live/socket-admission.md", "socket admission");

interface Outcome {
	opened: boolean;
	control: Array<Record<string, unknown>>;
	fatal: FatalFrame | null;
}

function capture(kind: "root" | "body", documentId: string, params: Record<string, string>): Promise<Outcome> {
	return new Promise<Outcome>((resolve, reject) => {
		const url = new URL(identity.host);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.pathname = socketPrefix(identity, kind, documentId);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		const socket = new WebSocket(url);
		let opened = false;
		let fatal: FatalFrame | null = null;
		const control: Array<Record<string, unknown>> = [];
		let settled = false;
		const timeout = setTimeout(() => finish(new Error(`${kind} socket admission timed out`)), 5_000);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.terminate();
			error ? reject(error) : resolve({ opened, control, fatal });
		};
		socket.on("open", () => {
			opened = true;
			setTimeout(() => finish(), 150);
		});
		socket.on("message", (data, binary) => {
			if (binary) return;
			const text = data.toString();
			const payload = text.startsWith("__YPS:") ? text.slice(6) : text;
			fatal = parseFatalFrame(payload) ?? fatal;
			try { control.push(JSON.parse(payload) as Record<string, unknown>); } catch { /* not a JSON control frame */ }
		});
		socket.on("close", () => finish());
		socket.on("error", (error) => finish(error));
	});
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

for (const [kind, documentId] of [["root", "root"], ["body", bodyId]] as const) {
	const ticket = (await fetchSocketTicket(identity)).ticket;
	const allowed = await capture(kind, documentId, {
		ticket,
		schemaVersion: String(SCHEMA_VERSION),
		protocolVersion: String(PROTOCOL_VERSION),
	});
	assert(allowed.opened && !allowed.fatal, `${kind} socket accepts a device/vault-scoped ticket`);
	assert(allowed.control.some((frame) => frame.type === "VAULT_READY" && frame.documentId === documentId), `${kind} socket publishes VAULT_READY for the exact document`);

	const unauthenticated = await capture(kind, documentId, {
		schemaVersion: String(SCHEMA_VERSION),
		protocolVersion: String(PROTOCOL_VERSION),
	});
	assert(unauthenticated.fatal?.code === "unauthorized", `${kind} socket rejects a missing ticket`);
}

const wrongSchema = await capture("body", bodyId, {
	ticket: (await fetchSocketTicket(identity)).ticket,
	schemaVersion: String(SCHEMA_VERSION + 1),
	protocolVersion: String(PROTOCOL_VERSION),
});
assert(wrongSchema.fatal?.reason === "schema_mismatch", "body socket rejects the wrong schema pin");
const wrongProtocol = await capture("body", bodyId, {
	ticket: (await fetchSocketTicket(identity)).ticket,
	schemaVersion: String(SCHEMA_VERSION),
	protocolVersion: String(PROTOCOL_VERSION + 1),
});
assert(wrongProtocol.fatal?.reason === "protocol_mismatch", "body socket rejects the wrong wire protocol pin");
console.log("\n✓ Schema-4 root/body admission passed");
