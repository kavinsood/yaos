import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { createAccessFetch, createAccessWebSocketImplementation } from "../../packages/cli/src/access";
import { ConfigError, resolveAccessServiceCredentials } from "../../packages/cli/src/config";
import { suite } from "../harness.ts";

const s = suite("cli-access-service");
const credentials = { clientId: "service-id.access", clientSecret: "private-service-secret" };

s.test("requires both halves of a service token", () => {
	assert.equal(resolveAccessServiceCredentials({}), null);
	assert.throws(
		() => resolveAccessServiceCredentials({ YAOS_CF_ACCESS_CLIENT_ID: credentials.clientId }),
		ConfigError,
	);
	assert.deepEqual(resolveAccessServiceCredentials({
		YAOS_CF_ACCESS_CLIENT_ID: ` ${credentials.clientId} `,
		YAOS_CF_ACCESS_CLIENT_SECRET: ` ${credentials.clientSecret} `,
	}), credentials);
});

s.test("adds service identity to HTTP without dropping caller headers", async () => {
	let observed: Headers | null = null;
	const fakeFetch: typeof fetch = async (_input, init) => {
		observed = new Headers(init?.headers);
		return new Response(null, { status: 204 });
	};
	await createAccessFetch(fakeFetch, credentials)("https://example.test/status", {
		headers: { authorization: "Bearer device" },
	});
	const captured = observed as Headers | null;
	assert.equal(captured?.get("authorization"), "Bearer device");
	assert.equal(captured?.get("cf-access-client-id"), credentials.clientId);
	assert.equal(captured?.get("cf-access-client-secret"), credentials.clientSecret);
});

s.test("adds service identity to the WebSocket upgrade handshake", async () => {
	const server = createServer();
	const sockets = new WebSocketServer({ noServer: true });
	let observed: Record<string, string | string[] | undefined> | null = null;
	server.on("upgrade", (request, socket, head) => {
		observed = request.headers;
		sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client, request));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const AccessWebSocket = createAccessWebSocketImplementation(credentials);
	const client = new AccessWebSocket(`ws://127.0.0.1:${address.port}`);
	await new Promise<void>((resolve, reject) => {
		client.addEventListener("open", () => resolve(), { once: true });
		client.addEventListener("error", () => reject(new Error("WebSocket failed to open")), { once: true });
	});
	assert.equal(observed?.["cf-access-client-id"], credentials.clientId);
	assert.equal(observed?.["cf-access-client-secret"], credentials.clientSecret);
	client.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	sockets.close();
});

await s.done();
