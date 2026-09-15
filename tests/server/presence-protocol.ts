import { strict as assert } from "node:assert";
import {
	EXCALIDRAW_PRESENCE_SURFACE,
	MAX_PRESENCE_SELECTED_ELEMENT_IDS,
	PRESENCE_PROTOCOL_VERSION,
	PRESENCE_TTL_MS,
	parsePresenceClientUpdate,
	parsePresenceServerFrame,
	presenceColors,
} from "../../server/src/shared/presenceProtocol";
import { suite } from "../harness.ts";

const s = suite("presence-protocol");

const state = {
	pointer: { x: 42, y: -9, tool: "freedraw", button: "down" as const },
	laser: { x: 40, y: -8 },
	selectedElementIds: ["box-1", "arrow-2"],
	activeElementId: "box-1",
	editingElementId: null,
	interaction: "drawing" as const,
	viewport: { scrollX: 10, scrollY: 20, zoom: 1.25, width: 1440, height: 900 },
	followSessionId: null,
	idle: "active" as const,
};

s.test("client parser accepts bounded surface state and discards asserted identity", () => {
	const parsed = parsePresenceClientUpdate({
		type: "presence.update", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, clientSequence: 7, state,
		identity: { principalId: "attacker", displayName: "Spoof" }, sessionId: "spoof-session",
	});
	assert(parsed);
	assert.deepEqual(parsed.state, state);
	assert.equal("identity" in parsed, false);
	assert.equal("sessionId" in parsed, false);
});

s.test("client parser rejects oversized, duplicate, non-finite, and unsupported state", () => {
	const base = { type: "presence.update", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, clientSequence: 1 };
	assert.equal(parsePresenceClientUpdate({ ...base,
		state: { selectedElementIds: Array.from({ length: MAX_PRESENCE_SELECTED_ELEMENT_IDS + 1 }, (_, index) => `e-${index}`) } }), null);
	assert.equal(parsePresenceClientUpdate({ ...base, state: { selectedElementIds: ["same", "same"] } }), null);
	assert.equal(parsePresenceClientUpdate({ ...base,
		state: { pointer: { x: Number.NaN, y: 0, tool: "selection", button: "up" } } }), null);
	assert.equal(parsePresenceClientUpdate({ ...base, state: { interaction: "teleporting" } }), null);
	assert.equal(parsePresenceClientUpdate({ ...base, surface: { kind: "canvas", version: 1 }, state: {} }), null);
});

s.test("server parser accepts trusted frames with relative expiry and rejects clock-bearing or forged shapes", () => {
	const colors = presenceColors("alice-seed");
	const frame = {
		type: "presence.state", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION, surface: EXCALIDRAW_PRESENCE_SURFACE,
		presence: { sessionId: "session-1", clientSequence: 7, expiresInMs: PRESENCE_TTL_MS,
			identity: { principalId: "principal-1", deviceId: "device-1", displayName: "Alice", ...colors }, state },
	};
	assert.deepEqual(parsePresenceServerFrame(frame), frame);
	assert.equal(parsePresenceServerFrame({ ...frame,
		presence: { ...frame.presence, expiresInMs: PRESENCE_TTL_MS + 1 } }), null);
	assert.equal(parsePresenceServerFrame({ ...frame,
		presence: { ...frame.presence, expiresInMs: undefined, expiresAt: Date.now() + PRESENCE_TTL_MS } }), null);
	assert.equal(parsePresenceServerFrame({ ...frame,
		presence: { ...frame.presence, identity: { ...frame.presence.identity, color: "red" } } }), null);
});

s.test("snapshot validation rejects duplicate sessions", () => {
	const colors = presenceColors("alice-seed");
	const presence = { sessionId: "session-1", clientSequence: 1, expiresInMs: 100,
		identity: { principalId: "principal-1", deviceId: "device-1", displayName: "Alice", ...colors }, state: {} };
	assert.equal(parsePresenceServerFrame({ type: "presence.snapshot", presenceProtocolVersion: PRESENCE_PROTOCOL_VERSION,
		surface: EXCALIDRAW_PRESENCE_SURFACE, presences: [presence, presence] }), null);
});

await s.done();
