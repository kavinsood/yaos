import { strict as assert } from "node:assert";
import type { VaultActorContext } from "../../server/src/collaboration";
import { classifyWorkerRoute, handleWorkerRequest } from "../../server/src/index";
import { createTicket, inspectTicket } from "../../server/src/routes/ticket";
import type { AuthState, Env } from "../../server/src/routes/types";
import { suite } from "../harness.ts";

const s = suite("excalidraw-route-contract");

const actor: VaultActorContext = {
	vaultId: "excalidraw-route-vault",
	vaultGeneration: "excalidraw-route-generation",
	principalId: "excalidraw-route-principal",
	membershipRevision: 1,
	deviceId: "excalidraw-route-device",
	deviceCredentialRevision: 1,
	role: "member",
	policyVersion: 1,
	capabilityDigest: "excalidraw-route-capabilities",
};

s.test("worker admits only the RFC 13 Excalidraw route surface", () => {
	const accepted = [
		["POST", "/vault/excalidraw-route-vault/excalidraw/drawing-1/authority/prepare"],
		["POST", "/vault/excalidraw-route-vault/excalidraw/drawing-1/initialize"],
		["POST", "/vault/excalidraw-route-vault/excalidraw/drawing-1/authority/finalize"],
		["POST", "/vault/excalidraw-route-vault/excalidraw/drawing-1/authority/lifecycle"],
		["POST", "/vault/excalidraw-route-vault/excalidraw/drawing-1/batch"],
		["POST", "/vault/excalidraw-route-vault/excalidraw/drawing-1/reset"],
		["GET", "/vault/excalidraw-route-vault/excalidraw/drawing-1/snapshot"],
		["GET", "/vault/excalidraw-route-vault/excalidraw/drawing-1/replay"],
		["GET", "/vault/excalidraw-route-vault/ws/excalidraw/drawing-1"],
	] as const;
	for (const [method, path] of accepted) {
		assert.equal(classifyWorkerRoute(new Request(`https://yaos.test${path}`, { method })).kind, "vault", path);
	}
	assert.equal(classifyWorkerRoute(new Request(
		"https://yaos.test/vault/excalidraw-route-vault/excalidraw/drawing-1/purge", { method: "DELETE" },
	)).kind, "not-found");
});

s.test("Excalidraw socket tickets bind drawing identity and epoch", async () => {
	const auth: AuthState = { mode: "claim", claimed: true, operatorRecoveryHash: "recovery",
		ticketSigningKey: "ticket-signing-key-with-sufficient-entropy" };
	const issued = await createTicket(auth, actor, { purpose: "excalidraw", documentId: "drawing-1", drawingEpoch: 7 });
	const valid = await inspectTicket(issued.ticket, auth, { vaultId: actor.vaultId,
		vaultGeneration: actor.vaultGeneration, purpose: "excalidraw", documentId: "drawing-1", drawingEpoch: 7 });
	assert.equal(valid?.purpose, "excalidraw");
	assert.equal(valid?.drawingEpoch, 7);
	assert.equal(await inspectTicket(issued.ticket, auth, { vaultId: actor.vaultId,
		purpose: "excalidraw", documentId: "drawing-1", drawingEpoch: 8 }), null);
	assert.equal(await inspectTicket(issued.ticket, auth, { vaultId: actor.vaultId,
		purpose: "excalidraw", documentId: "drawing-2", drawingEpoch: 7 }), null);
});

s.test("read-only share application is same-origin, flag-gated, and hardened", async () => {
	assert.equal(classifyWorkerRoute(new Request("https://yaos.test/share")).kind, "excalidraw-share-app");
	assert.equal(classifyWorkerRoute(new Request("https://yaos.test/share/app.js")).kind, "excalidraw-share-app");
	let requestedPath = "";
	const env = {
		YAOS_EXCALIDRAW_PUBLIC_READ: "true",
		YAOS_SHARE_ASSETS: {
			fetch: async (request: Request) => {
				requestedPath = new URL(request.url).pathname;
				return new Response("<!doctype html><title>Shared</title>", {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		},
	} as unknown as Env;
	const response = await handleWorkerRequest(new Request("https://yaos.test/share"), env);
	assert.equal(response.status, 200);
	assert.equal(requestedPath, "/share");
	assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/u);
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	assert.equal(response.headers.get("cache-control"), "no-store");
	const disabled = await handleWorkerRequest(new Request("https://yaos.test/share"), {
		YAOS_EXCALIDRAW_PUBLIC_READ: "false",
	} as unknown as Env);
	assert.equal(disabled.status, 404);
});

await s.done();
