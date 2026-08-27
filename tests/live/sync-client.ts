/**
 * Test client: connects to the same sync room as the Obsidian plugin
 * and appends a line to a file's Y.Text to verify real-time sync.
 *
 * Usage: bun run test-client.ts [path] [message]
 */
import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";
import { SCHEMA_VERSION } from "../../src/sync/schema";
import { fetchSocketTicket, requireLiveIdentity } from "./liveIdentity.ts";

const identity = requireLiveIdentity();
const HOST = identity.host;
const VAULT_ID = identity.vaultId;
const ROOM_ID = VAULT_ID;

const targetPath = process.argv[2] || "hi.md";
const message = process.argv[3] || "\n\nhello from the test client — if you see this, sync works";

console.log(`Connecting to ${HOST} room=${ROOM_ID}`);
console.log(`Target file: "${targetPath}"`);

const ydoc = new Y.Doc();
const pathToId = ydoc.getMap<string>("pathToId");
const idToText = ydoc.getMap<Y.Text>("idToText");
const meta = ydoc.getMap("meta");
const syncPrefix = `/vault/sync/${encodeURIComponent(ROOM_ID)}`;
let finished = false;
const { ticket } = await fetchSocketTicket(identity);

const provider = new YSyncProvider(HOST, ROOM_ID, ydoc, {
	prefix: syncPrefix,
	params: {
		ticket,
		schemaVersion: String(SCHEMA_VERSION),
	},
	WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
	connect: true,
});

provider.on("status", (event: { status: string }) => {
	console.log(`Provider status: ${event.status}`);
});

// Wait for sync, then inject text
provider.on("sync", (synced: boolean) => {
	if (!synced) return;

	console.log(`Synced. pathToId has ${pathToId.size} entries.`);

	let fileId = pathToId.get(targetPath);
	if (!fileId) {
		fileId = `test-${Date.now().toString(36)}`;
		const ytext = new Y.Text();
		pathToId.set(targetPath, fileId);
		idToText.set(fileId, ytext);
		meta.set(fileId, { path: targetPath, mtime: Date.now() });
		console.log(`Created "${targetPath}" (id=${fileId}) in CRDT`);
	}

	const ytext = idToText.get(fileId);
	if (!ytext) {
		console.error(`Y.Text not found for fileId=${fileId}`);
		cleanup(1);
		return;
	}

	console.log(`Found "${targetPath}" (id=${fileId}), current length: ${ytext.length}`);
	console.log(`Appending: "${message}"`);

	ytext.insert(ytext.length, message);

	console.log("Done. New length:", ytext.length);
	finished = true;

	// Give it a moment to propagate, then exit
	setTimeout(() => cleanup(0), 1000);
});

function cleanup(exitCode: number) {
	if (finished && exitCode !== 0) {
		exitCode = 0;
	}
	provider.destroy();
	ydoc.destroy();
	process.exit(exitCode);
}

// Timeout safety
setTimeout(() => {
	console.error("Timed out after 10s");
	cleanup(1);
}, 10_000);
