import { strict as assert } from "node:assert";
import { classifyWorkerRoute } from "../../server/src/index";
import { openExcalidrawShareRoute, openExcalidrawShareSession, sealExcalidrawShareRoute,
	sealExcalidrawShareSession } from "../../server/src/excalidrawShareEnvelope";
import type { AuthState } from "../../server/src/routes/types";
import { suite } from "../harness.ts";

const s = suite("excalidraw-share-gateway");
const auth: AuthState = { mode: "claim", claimed: true, operatorRecoveryHash: "recovery",
	ticketSigningKey: "gateway-test-key-with-enough-entropy" };

s.test("opaque route and session envelopes bind exact drawing authority", async () => {
	const route = { v: 1 as const, vaultId: "gateway-vault", vaultGeneration: "gateway-generation",
		drawingId: "private-drawing", drawingEpoch: 3, shareId: "share-id", publicDrawingId: "public-drawing" };
	const sealedRoute = await sealExcalidrawShareRoute(auth, route);
	assert.equal(sealedRoute.includes(route.vaultId), false);
	assert.deepEqual(await openExcalidrawShareRoute(auth, sealedRoute), route);
	assert.equal(await openExcalidrawShareRoute(auth, `${sealedRoute.slice(0, -1)}x`), null);
	const session = { ...route, sessionId: "session-id", sessionToken: "s".repeat(43), expiresAt: Date.now() + 60_000 };
	const sealedSession = await sealExcalidrawShareSession(auth, session);
	assert.equal(sealedSession.includes(route.drawingId), false);
	assert.deepEqual(await openExcalidrawShareSession(auth, sealedSession), session);
});

s.test("worker admits only the bounded owner and cookie-auth public surface", () => {
	const accepted = [
		["POST", "/vault/gateway-vault/excalidraw/private-drawing/shares"],
		["GET", "/vault/gateway-vault/excalidraw/private-drawing/shares"],
		["PATCH", "/vault/gateway-vault/excalidraw/private-drawing/shares/share-id"],
		["DELETE", "/vault/gateway-vault/excalidraw/private-drawing/shares/share-id"],
		["POST", "/api/excalidraw/shares/session"],
		["GET", "/api/excalidraw/shares/session/snapshot"],
		["GET", "/api/excalidraw/shares/session/replay"],
		["POST", "/api/excalidraw/shares/session/batch"],
		["GET", "/api/excalidraw/shares/session/ws"],
		["POST", "/api/excalidraw/shares/session/resources"],
		["GET", "/api/excalidraw/shares/session/resources/public-resource"],
	] as const;
	for (const [method, path] of accepted) assert.notEqual(
		classifyWorkerRoute(new Request(`https://yaos.test${path}`, { method })).kind, "not-found", path);
	assert.equal(classifyWorkerRoute(new Request("https://yaos.test/api/excalidraw/shares/session/ws?token=raw",
		{ method: "POST" })).kind, "not-found");
});

await s.done();
