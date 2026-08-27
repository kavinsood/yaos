import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/sync/schema.ts";
import { describeFatalFrame, onFatalFrame } from "./fatalFrame.ts";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";
import { socketPrefix } from "./schema4Live.ts";

const identity = requireLiveIdentity();
const first = await fetchSocketTicket(identity);
const doc = new Y.Doc({ guid: "root" });

function createProvider(target: Y.Doc, ticket: string): YSyncProvider {
	return new YSyncProvider(identity.host, "root", target, {
		prefix: socketPrefix(identity, "root", "root"),
		params: {
			ticket,
			schemaVersion: String(SCHEMA_VERSION),
			protocolVersion: String(PROTOCOL_VERSION),
		},
		WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
		connect: false,
		maxBackoffTime: 100,
	});
}

async function waitForSync(provider: YSyncProvider, label: string, readFatal: () => string | null): Promise<void> {
	if (provider.synced) return;
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			const fatal = readFatal();
			reject(new Error(`${label}: timed out${fatal ? ` (${fatal})` : ""}`));
		}, 8_000);
		provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			clearTimeout(timeout);
			resolve();
		});
	});
}

const provider = createProvider(doc, first.ticket);
let firstFatal: string | null = null;
onFatalFrame(provider, (frame) => { firstFatal = describeFatalFrame(frame); });
let reconnectProvider: YSyncProvider | null = null;
let reconnectDoc: Y.Doc | null = null;
try {
	const initial = waitForSync(provider, "initial root sync", () => firstFatal);
	void provider.connect();
	await initial;
	const initialUrl = new URL(provider.url);
	if (initialUrl.pathname !== socketPrefix(identity, "root", "root")
		|| initialUrl.searchParams.get("ticket") !== first.ticket
		|| initialUrl.searchParams.get("schemaVersion") !== String(SCHEMA_VERSION)
		|| initialUrl.searchParams.get("protocolVersion") !== String(PROTOCOL_VERSION)) {
		throw new Error(`initial socket URL is not schema-4 root: ${provider.url}`);
	}

	const refreshed = await fetchSocketTicket(identity);
	if (refreshed.ticket === first.ticket) throw new Error("ticket refresh returned the original nonce");
	provider.disconnect();
	reconnectDoc = new Y.Doc({ guid: "root" });
	reconnectProvider = createProvider(reconnectDoc, refreshed.ticket);
	let reconnectFatal: string | null = null;
	onFatalFrame(reconnectProvider, (frame) => { reconnectFatal = describeFatalFrame(frame); });
	const reconnected = waitForSync(reconnectProvider, "rapid reconnect", () => reconnectFatal);
	void reconnectProvider.connect();
	await reconnected;
	if (new URL(reconnectProvider.url).searchParams.get("ticket") !== refreshed.ticket) {
		throw new Error("reconnect discarded the refreshed ticket");
	}
	if (reconnectFatal) throw new Error(`refreshed reconnect was rejected: ${reconnectFatal}`);
	console.log("Rapid /ws/root reconnect succeeded with a distinct refreshed device ticket.");
} finally {
	if (provider.ws instanceof WebSocket) provider.ws.terminate();
	if (reconnectProvider?.ws instanceof WebSocket) reconnectProvider.ws.terminate();
	reconnectProvider?.destroy();
	reconnectDoc?.destroy();
	provider.destroy();
	doc.destroy();
}
