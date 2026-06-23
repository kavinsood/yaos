import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import WebSocket from "ws";

const host = process.env.YAOS_TEST_HOST;
const token = process.env.SYNC_TOKEN;
const room = process.env.YAOS_TEST_VAULT_ID;
const mode = process.env.YAOS_TEST_MODE ?? "seed";

if (!host || !token || !room) {
	throw new Error("YAOS_TEST_HOST, SYNC_TOKEN, and YAOS_TEST_VAULT_ID are required");
}

const ydoc = new Y.Doc();
const provider = new YSyncProvider(host, room, ydoc, {
	prefix: `/vault/sync/${encodeURIComponent(room)}`,
	params: { token, schemaVersion: "2" },
	WebSocketPolyfill: globalThis.WebSocket ?? WebSocket,
	connect: true,
});

const timeout = setTimeout(() => {
	console.error("Timed out waiting for sync");
	provider.destroy();
	ydoc.destroy();
	process.exit(1);
}, 15_000);

function fail(msg, details) {
	console.error(msg, details ?? "");
	clearTimeout(timeout);
	provider.destroy();
	ydoc.destroy();
	process.exit(1);
}

provider.on("message", (event) => {
	if (typeof event.data !== "string") return;
	try {
		const msg = JSON.parse(event.data);
		if (msg?.type === "error") {
			fail("Server returned error", msg);
		}
	} catch {
		// Ignore non-JSON frames.
	}
});

provider.on("sync", (synced) => {
	if (!synced) return;

	const sys = ydoc.getMap("sys");
	const pathToId = ydoc.getMap("pathToId");
	const idToText = ydoc.getMap("idToText");
	const meta = ydoc.getMap("meta");

	if (mode === "seed") {
		ydoc.transact(() => {
			sys.set("initialized", true);
			sys.set("schemaVersion", 2);
			let fileId = pathToId.get("redeploy-test.md");
			if (!fileId) {
				fileId = "redeploy-test-file";
				pathToId.set("redeploy-test.md", fileId);
				idToText.set(fileId, new Y.Text());
			}
			const ytext = idToText.get(fileId);
			if (!ytext) {
				throw new Error("Missing Y.Text for redeploy-test.md");
			}
			ytext.delete(0, ytext.length);
			ytext.insert(
				0,
				`KAOS redeploy durability test\nts=${new Date().toISOString()}\nvault=${room}\nmode=${mode}`,
			);
			meta.set(fileId, { path: "redeploy-test.md", mtime: Date.now() });
		});
	}

	setTimeout(() => {
		const files = [...pathToId.keys()];
		const fileId = pathToId.get("redeploy-test.md");
		const ytext = fileId ? idToText.get(fileId) : null;
		const payload = {
			mode,
			room,
			schemaVersion: sys.get("schemaVersion"),
			initialized: sys.get("initialized"),
			files,
			text: ytext?.toString() ?? null,
		};
		console.log(JSON.stringify(payload, null, 2));
		clearTimeout(timeout);
		provider.destroy();
		ydoc.destroy();
		process.exit(0);
	}, mode === "seed" ? 1500 : 500);
});
