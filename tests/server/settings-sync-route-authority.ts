import { strict as assert } from "node:assert";
import { handleWorkerRequest } from "../../server/src/index";
import { hashSecret } from "../../server/src/identity";
import { invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import { handleOperatorVaultRuntimeRoute } from "../../server/src/routes/vault";
import { makeConfigNamespace, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("settings-sync-route-authority");
const VAULT_ID = "vault-settings-route-0001";
const OTHER_VAULT_ID = "vault-settings-route-0002";
const VAULT_GENERATION = "generation-settings-route-0001";
const DEVICE_TOKEN = "settings-device-token-00000000000000000001";
const DEVICE_ID = "settings-device-0001";

s.test("settings route requires current vault membership and forwards only trusted authority", async () => {
	invalidateStoredServerConfigCache();
	const tokenHash = await hashSecret(DEVICE_TOKEN);
	let revoked = false;
	let authorizationCalls = 0;
	const config = makeConfigNamespace(async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/__yaos/config") {
			return Response.json({
				claimed: true,
				configFormat: 2,
				operatorRecoveryHash: "operator-settings-route-hash",
				ticketSigningKey: "ticket-settings-route-key",
				updateProvider: null,
				updateRepoUrl: null,
				updateRepoBranch: null,
			});
		}
		if (url.pathname === "/__yaos/authorize-device") {
			authorizationCalls++;
			const body = await request.json() as { tokenHash?: string; vaultId?: string };
			if (!revoked && body.tokenHash === tokenHash && body.vaultId === VAULT_ID) {
				return Response.json({
					device: { deviceId: DEVICE_ID, vaultId: VAULT_ID, name: "Laptop", enrolledAt: 1 },
				});
			}
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}
		if (url.pathname === "/__yaos/vault") {
			assert.equal(url.searchParams.get("vaultId"), VAULT_ID);
			return Response.json({
				vault: {
					vaultId: VAULT_ID,
					vaultGeneration: VAULT_GENERATION,
					name: "Settings",
					state: "active",
					createdAt: 1,
					provisionedAt: 2,
				},
			});
		}
		throw new Error(`unexpected config request: ${url.pathname}`);
	});
	const forwarded: Request[] = [];
	const sync = makeVaultSyncNamespace(async (request) => {
		forwarded.push(request);
		return Response.json({ seeded: false });
	});
	const env = makeEnv({ YAOS_CONFIG: config, YAOS_SYNC: sync });
	const endpoint = `https://example.test/vault/${VAULT_ID}/settings-sync/.obsidian?settingsFormatVersion=1`;

	const missing = await handleWorkerRequest(new Request(endpoint), env);
	assert.equal(missing.status, 401);
	assert.equal(sync.calls, 0, "missing bearer does not allocate the vault runtime");

	const foreign = await handleWorkerRequest(new Request(
		`https://example.test/vault/${OTHER_VAULT_ID}/settings-sync/.obsidian?settingsFormatVersion=1`,
		{ headers: { authorization: `Bearer ${DEVICE_TOKEN}` } },
	), env);
	assert.equal(foreign.status, 401);
	assert.equal(sync.calls, 0, "wrong-vault bearer does not allocate the vault runtime");

	revoked = true;
	const denied = await handleWorkerRequest(new Request(endpoint, {
		headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
	}), env);
	assert.equal(denied.status, 401);
	assert.equal(sync.calls, 0, "revoked device does not allocate the vault runtime");

	revoked = false;
	const admitted = await handleWorkerRequest(new Request(endpoint, {
		headers: { authorization: `Bearer ${DEVICE_TOKEN}` },
	}), env);
	assert.equal(admitted.status, 200);
	assert.deepEqual(await admitted.json(), { seeded: false });
	assert.equal(authorizationCalls, 4, "pre-auth and runtime authority both verify the admitted bearer");
	assert.equal(sync.actorSelections, 1);
	assert.equal(sync.calls, 1);
	assert.equal(forwarded.length, 1);
	assert.equal(new URL(forwarded[0]!.url).pathname, "/settings-sync/.obsidian");
	assert.equal(new URL(forwarded[0]!.url).searchParams.get("settingsFormatVersion"), "1");
	assert.equal(forwarded[0]!.headers.get("x-yaos-vault-id"), VAULT_ID);
	assert.equal(forwarded[0]!.headers.get("x-yaos-vault-generation"), VAULT_GENERATION);
	assert.equal(forwarded[0]!.headers.get("x-yaos-device-id"), DEVICE_ID);
	assert.equal(forwarded[0]!.headers.get("authorization"), null, "bearer secret is not forwarded to the runtime");
	invalidateStoredServerConfigCache();
});

s.test("actor forwarding owns request bytes before the public response lifetime ends", async () => {
	let sourceClosed = false;
	let publicResponseSent = false;
	let pullCount = 0;
	const expected = new TextEncoder().encode("{\"kind\":\"delete\"}");
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pullCount++ === 0) {
				controller.enqueue(expected);
				return;
			}
			if (publicResponseSent) {
				controller.error(new Error("request stream outlived public response"));
				return;
			}
			sourceClosed = true;
			controller.close();
		},
	});
	const forwarded: Request[] = [];
	const env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async () => Response.json({
			vault: {
				vaultId: VAULT_ID,
				vaultGeneration: VAULT_GENERATION,
				name: "Settings",
				state: "active",
				createdAt: 1,
				provisionedAt: 2,
			},
		})),
		YAOS_SYNC: makeVaultSyncNamespace(async (request) => {
			forwarded.push(request);
			assert.equal(sourceClosed, true, "source stream must close before the actor is called");
			return new Response(null, { status: 204 });
		}),
	});
	const request = new Request(`https://example.test/vault/${VAULT_ID}/lifecycle`, {
		method: "POST",
		body: source,
		duplex: "half",
	} as RequestInit & { duplex: "half" });
	const response = await handleOperatorVaultRuntimeRoute(request, env, VAULT_ID, "/lifecycle");
	publicResponseSent = true;
	assert.equal(response.status, 204);
	assert.equal(forwarded.length, 1);
	assert.deepEqual(new Uint8Array(await forwarded[0]!.arrayBuffer()), expected);
});

await s.done();
