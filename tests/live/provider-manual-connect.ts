import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { describeFatalFrame, onFatalFrame } from "./fatalFrame.ts";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";
import { socketPrefix } from "./schema4Live.ts";

const identity = requireLiveIdentity();
const doc = new Y.Doc({ guid: "root" });
const provider = new YSyncProvider(identity.host, "root", doc, {
	prefix: socketPrefix(identity, "root", "root"),
	params: async () => ({
		ticket: (await fetchSocketTicket(identity)).ticket,
		schemaVersion: String(SCHEMA_VERSION),
		protocolVersion: String(PROTOCOL_VERSION),
	}),
	WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
	connect: false,
	maxBackoffTime: 500,
});

let ready = false;
let synced = false;
let fatal: string | null = null;
provider.on("custom-message", (text: string) => {
	try {
		const frame = JSON.parse(text) as { type?: unknown; documentId?: unknown; vaultGeneration?: unknown; runtimeEpoch?: unknown };
		if (frame.type === "VAULT_READY" && frame.documentId === "root"
			&& typeof frame.vaultGeneration === "string" && typeof frame.runtimeEpoch === "string") ready = true;
	} catch {
		// Non-JSON control traffic is irrelevant to this contract.
	}
});
onFatalFrame(provider, (frame) => { fatal = describeFatalFrame(frame); });
provider.on("sync", (value: boolean) => { if (value) synced = true; });

void provider.connect();
const deadline = Date.now() + 10_000;
while (Date.now() < deadline && (!ready || !synced) && !fatal) {
	await new Promise((resolve) => setTimeout(resolve, 25));
}
try {
	if (fatal) throw new Error(`manual root connect rejected: ${fatal}`);
	if (!synced) throw new Error("manual root connect did not complete Yjs sync");
	if (!ready) throw new Error("manual root connect did not receive schema-4 VAULT_READY control payload");
	const url = new URL(provider.url);
	if (url.pathname !== socketPrefix(identity, "root", "root")) throw new Error(`provider used wrong root path: ${url.pathname}`);
	if (url.searchParams.get("schemaVersion") !== String(SCHEMA_VERSION)
		|| url.searchParams.get("protocolVersion") !== String(PROTOCOL_VERSION)) {
		throw new Error("provider omitted schema-4 wire pins");
	}
	console.log("Manual provider connect synced on /ws/root and received VAULT_READY.");
} finally {
	if (provider.ws instanceof WebSocket) provider.ws.terminate();
	provider.destroy();
	doc.destroy();
}
