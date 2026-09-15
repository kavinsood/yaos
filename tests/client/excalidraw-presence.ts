import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { EXCALIDRAW_PRESENCE_SURFACE, PRESENCE_PROTOCOL_VERSION,
	type PresenceClientUpdate } from "../../server/src/shared/presenceProtocol";
import type { ExcalidrawHostRemotePresence } from "../../src/host/obsidianExcalidrawHostAdapter";
import { ExcalidrawPresenceController } from "../../src/sync/excalidraw/presence";
import { suite } from "../harness.ts";

const s = suite("excalidraw-presence");

s.test("maps local laser/viewport state and trusted remote collaborators without durable storage", async () => {
	const applied: ExcalidrawHostRemotePresence[][] = [];
	const published: PresenceClientUpdate[] = [];
	const controller = new ExcalidrawPresenceController({ drawingId: "drawing1", drawingEpoch: 1,
		host: { applyPresence: (peers) => { applied.push([...peers]); return true; } }, idleAfterMs: 5 });
	controller.start();
	controller.bindPublisher({ publishPresence: (update) => { published.push(update); } });
	controller.capture({ pointer: { x: 10, y: 20, tool: "laser", button: "down" },
		selectedElementIds: ["element1"], activeElementId: "element1", interaction: "editing",
		viewport: { scrollX: 1, scrollY: 2, zoom: 1.5, width: 800, height: 600 },
		followSessionId: "session-bbbbbbbb", idle: false }, "pointer");
	await Promise.resolve();
	assert.deepEqual(published[0]?.state, { laser: { x: 10, y: 20 }, selectedElementIds: ["element1"],
		activeElementId: "element1", editingElementId: "element1", interaction: "editing",
		viewport: { scrollX: 1, scrollY: 2, zoom: 1.5, width: 800, height: 600 },
		followSessionId: "session-bbbbbbbb", idle: "active" });
	controller.acceptFrame({ type: "presence.state", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, presence: { sessionId: "session-aaaaaaaa",
			clientSequence: 1, expiresInMs: 15_000, identity: { principalId: "principal-aaaaaaaa",
				deviceId: "device-bbbbbbbbbbbb", displayName: "Alice", color: "hsl(12, 72%, 52%)",
				colorLight: "hsla(12, 72%, 52%, 0.2)" }, state: { pointer: { x: 3, y: 4,
					tool: "pointer", button: "up" }, selectedElementIds: ["element2"], idle: "active" } } });
	assert.equal(applied.at(-1)?.[0]?.displayName, "Alice");
	assert.equal(applied.at(-1)?.[0]?.presence.pointer?.x, 3);
	await delay(220);
	assert.equal(published.at(-1)?.state?.idle, "idle");
	assert.equal(published.at(-1)?.state?.pointer, undefined, "idle transition removes stale pointer state");
	controller.stop();
	assert.deepEqual(applied.at(-1), [], "detach clears native collaborator rendering");
});

await s.done();
