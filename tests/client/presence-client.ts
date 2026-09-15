import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { EXCALIDRAW_PRESENCE_SURFACE, PRESENCE_PROTOCOL_VERSION, type PresenceClientUpdate,
	type PresenceServerFrame } from "../../server/src/shared/presenceProtocol";
import { PresenceClient } from "../../src/sync/presence/client";
import { suite } from "../harness.ts";

const s = suite("presence-client");

function remoteFrame(sessionId: string, expiresInMs: number): PresenceServerFrame {
	return { type: "presence.state", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION, surface: EXCALIDRAW_PRESENCE_SURFACE,
		presence: { sessionId, clientSequence: 1, expiresInMs,
			identity: { principalId: "principal-aaaaaaaa", deviceId: "device-bbbbbbbbbbbb",
				displayName: "Alice", color: "hsl(12, 72%, 52%)", colorLight: "hsla(12, 72%, 52%, 0.2)" },
			state: { pointer: { x: 1, y: 2, tool: "pointer", button: "up" }, idle: "active" } } };
}

s.test("publishes full latest state at most 20Hz and refreshes it before TTL", async () => {
	let now = 0;
	const published: PresenceClientUpdate[] = [];
	const client = new PresenceClient({ now: () => now, minimumPublishIntervalMs: 20,
		ambientPublishIntervalMs: 40, refreshIntervalMs: 30, remoteSweepIntervalMs: 1_000,
		onRemoteStates: () => {} });
	client.start();
	client.bindPublisher({ publishPresence: (update) => { published.push(update); } });
	client.updateLocal({ pointer: { x: 1, y: 1, tool: "pointer", button: "up" } });
	await Promise.resolve();
	client.updateLocal({ pointer: { x: 2, y: 2, tool: "pointer", button: "down" } });
	client.updateLocal({ pointer: { x: 3, y: 3, tool: "pointer", button: "down" } });
	now = 25;
	await delay(25);
	assert.deepEqual(published.map((update) => update.state && update.state.pointer?.x), [1, 3]);
	now = 60;
	await delay(35);
	assert.equal(published.at(-1)?.state?.pointer?.x, 3, "stationary presence is refreshed, not cleared after flush");
	assert.deepEqual(published.map((update) => update.clientSequence), published.map((_, index) => index + 1));
	client.stop();
	assert.equal(published.at(-1)?.state, null, "stop explicitly clears presence before socket close");
});

s.test("uses receipt-relative expiry and clears remote state on socket loss", async () => {
	let now = 100;
	const rosters: string[][] = [];
	const client = new PresenceClient({ now: () => now, remoteSweepIntervalMs: 5,
		onRemoteStates: (states) => rosters.push(states.map((state) => state.sessionId)) });
	client.start();
	client.bindPublisher({ publishPresence: () => {} });
	client.acceptFrame(remoteFrame("session-aaaaaaaa", 20));
	assert.deepEqual(rosters.at(-1), ["session-aaaaaaaa"]);
	now = 121;
	await delay(10);
	assert.deepEqual(rosters.at(-1), [], "wall-clock-independent local TTL removes a silent peer");
	client.acceptFrame(remoteFrame("session-bbbbbbbb", 20));
	client.bindPublisher(null);
	assert.deepEqual(rosters.at(-1), [], "room socket loss immediately removes stale collaborator rendering");
	client.stop();
});

s.test("snapshot is full replacement and leave is session-scoped", () => {
	const rosters: string[][] = [];
	const client = new PresenceClient({ now: () => 0, onRemoteStates: (states) => rosters.push(
		states.map((state) => state.sessionId).sort()) });
	client.start();
	const first = remoteFrame("session-aaaaaaaa", 10_000);
	const second = remoteFrame("session-bbbbbbbb", 10_000);
	client.acceptFrame({ type: "presence.snapshot", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE,
		presences: [first.type === "presence.state" ? first.presence : never(),
			second.type === "presence.state" ? second.presence : never()] });
	assert.deepEqual(rosters.at(-1), ["session-aaaaaaaa", "session-bbbbbbbb"]);
	client.acceptFrame({ type: "presence.leave", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, sessionId: "session-aaaaaaaa", reason: "closed" });
	assert.deepEqual(rosters.at(-1), ["session-bbbbbbbb"]);
	client.stop();
});

function never(): never { throw new Error("unreachable"); }

await s.done();
