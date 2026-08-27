/**
 * RFC multivault plane: unique names, destroy, rename, pairing revoke,
 * and schema admit (newer client / older room).
 */
import ServerConfig from "../../server/src/config";
import { hashSecret, OPERATOR_COOKIE, PAIRING_CODE_TTL_MS, uniqueDeviceName } from "../../server/src/identity";
import { verifyOperatorSession } from "../../server/src/routes/auth";
import {
	attemptVaultCleanup,
	handleOperatorDestroyVault,
	handleOperatorLogout,
} from "../../server/src/routes/operator";
import {
	operatorDestroyStatusMessage,
	operatorStateLoadFailureMessage,
	renderOperatorConsole,
} from "../../server/src/setupPage";
import { FakeR2Bucket, makeConfigNamespace, makeEnv } from "../mocks/workerEnv.ts";
import { readSource, suite } from "../harness.ts";

const s = suite("multivault-registry");
function makeMemoryConfig(): ServerConfig {
	const data = new Map<string, unknown>();
	const storage = {
		get: async (key: string) => data.get(key),
		put: async (key: string, value: unknown) => {
			data.set(key, value);
		},
		transaction: async <T>(
			fn: (txn: {
				get: (key: string) => Promise<unknown>;
				put: (key: string, value: unknown) => Promise<void>;
			}) => Promise<T>,
		): Promise<T> => {
			return await fn({
				get: async (key: string) => data.get(key),
				put: async (key: string, value: unknown) => {
					data.set(key, value);
				},
			});
		},
	};
	// @ts-expect-error focused fake supplies only the storage surface ServerConfig uses.
	return new ServerConfig({ storage });
}

function jsonRequest(path: string, body: unknown): Request {
	return new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

s.section("uniqueDeviceName suffixes on this vault");
{
	s.check(uniqueDeviceName("Mac", []) === "Mac", "first Mac is Mac");
	s.check(uniqueDeviceName("Mac", ["Mac"]) === "Mac 2", "second Mac is Mac 2");
	s.check(uniqueDeviceName("Mac", ["Mac", "Mac 2"]) === "Mac 3", "third Mac is Mac 3");
	s.check(uniqueDeviceName("Android", ["Mac"]) === "Android", "other names are independent");
}

s.section("enroll uniquifies names on one vault");
{
	const config = makeMemoryConfig();
	await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-one-aa",
		vaultName: "Work",
		pairingCodeHash: "a".repeat(64),
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	await config.fetch(jsonRequest("/__yaos/create-pairing-code", {
		vaultId: "vault-one-aa",
		codeHash: "b".repeat(64),
		exp: Date.now() + 60_000,
		purpose: "device",
	}));
	const first = await config.fetch(jsonRequest("/__yaos/enroll", {
		pairingCodeHash: "a".repeat(64),
		deviceId: "dev-1",
		deviceTokenHash: "t1".repeat(32),
		deviceName: "Mac",
	}));
	const firstBody = await first.json() as { deviceName?: string };
	s.check(first.ok, "first enroll ok");
	s.check(firstBody.deviceName === "Mac", "first enroll keeps Mac");

	const second = await config.fetch(jsonRequest("/__yaos/enroll", {
		pairingCodeHash: "b".repeat(64),
		deviceId: "dev-2",
		deviceTokenHash: "t2".repeat(32),
		deviceName: "Mac",
	}));
	const secondBody = await second.json() as { deviceName?: string };
	s.check(second.ok, "second enroll ok");
	s.check(secondBody.deviceName === "Mac 2", "second enroll becomes Mac 2");
}

s.section("destroy revokes first, persists bounded retry state, and completes only after both stores");
{
	const config = makeMemoryConfig();
	await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-gone-1",
		vaultName: "Temp",
		pairingCodeHash: "c".repeat(64),
		pairingPurpose: "device",
	}));
	await config.fetch(jsonRequest("/__yaos/enroll", {
		pairingCodeHash: "c".repeat(64),
		deviceId: "dev-gone",
		deviceTokenHash: "tg".repeat(32),
		deviceName: "Phone",
	}));
	const destroyed = await config.fetch(jsonRequest("/__yaos/destroy-vault", { vaultId: "vault-gone-1" }));
	const destroyedBody = await destroyed.json() as {
		pending: { requestedAt: number; roomComplete: boolean; r2Complete: boolean };
	};
	s.check(destroyed.status === 200, "registry destroy 200");
	s.check(!destroyedBody.pending.roomComplete && !destroyedBody.pending.r2Complete, "physical cleanup starts pending");
	const consoleRes = await config.fetch(new Request("https://internal/__yaos/console"));
	const consoleBody = await consoleRes.json() as {
		vaults: unknown[];
		devices: unknown[];
		pairingCodes: unknown[];
		pendingDestroys: unknown[];
	};
	s.check(consoleBody.vaults.length === 0, "vault membership revoked");
	s.check(consoleBody.devices.length === 0, "devices revoked");
	s.check(consoleBody.pairingCodes.length === 0, "codes revoked");
	s.check(consoleBody.pendingDestroys.length === 1, "physical cleanup obligation remains visible");

	const retry = await config.fetch(jsonRequest("/__yaos/destroy-vault", { vaultId: "vault-gone-1" }));
	const retryBody = await retry.json() as { pending: { requestedAt: number } };
	s.check(retry.status === 200, "pending destroy is idempotent");
	s.check(retryBody.pending.requestedAt === destroyedBody.pending.requestedAt, "retry preserves original request time");
	const reused = await config.fetch(jsonRequest("/__yaos/create-vault", {
		vaultId: "vault-gone-1",
		name: "Replacement",
	}));
	s.check(reused.status === 409, "pending vault id cannot be reused before cleanup completes");

	const partial = await config.fetch(jsonRequest("/__yaos/update-destroy-vault", {
		vaultId: "vault-gone-1",
		roomComplete: true,
		r2Complete: false,
		lastError: "r2: " + "sensitive".repeat(1_000),
	}));
	const partialBody = await partial.json() as { pending: { lastError: string } };
	s.check(partial.status === 202, "partial cleanup remains pending");
	s.check(partialBody.pending.lastError.length === 512, "persisted cleanup error is bounded");

	const completed = await config.fetch(jsonRequest("/__yaos/update-destroy-vault", {
		vaultId: "vault-gone-1",
		roomComplete: false,
		r2Complete: true,
		lastError: null,
	}));
	s.check(completed.status === 200, "both physical stores complete cleanup");
	const finalConsole = await config.fetch(new Request("https://internal/__yaos/console"));
	const finalBody = await finalConsole.json() as { pendingDestroys: unknown[] };
	s.check(finalBody.pendingDestroys.length === 0, "completed cleanup record is removed");
	const missing = await config.fetch(jsonRequest("/__yaos/destroy-vault", { vaultId: "vault-gone-1" }));
	s.check(missing.status === 404, "completed destroy is no longer pending");
}
s.section("pairing expiry is authoritative in config despite a skewed caller timestamp");
{
	const config = makeMemoryConfig();
	const claimStarted = Date.now();
	const claimed = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-exp-aa",
		vaultName: "Expiry",
		pairingCodeHash: "x".repeat(64),
		pairingExp: Number.MAX_SAFE_INTEGER,
		pairingPurpose: "device",
	}));
	const claimFinished = Date.now();
	const claimBody = await claimed.json() as { pairingExp: number };
	s.check(claimed.status === 200, "caller clock ahead no longer rejects claim");
	s.check(
		claimBody.pairingExp >= claimStarted + PAIRING_CODE_TTL_MS
			&& claimBody.pairingExp <= claimFinished + PAIRING_CODE_TTL_MS,
		"claim expiry comes from config time and fixed TTL",
	);

	const mintStarted = Date.now();
	const minted = await config.fetch(jsonRequest("/__yaos/create-pairing-code", {
		vaultId: "vault-exp-aa",
		codeHash: "y".repeat(64),
		exp: Number.MAX_SAFE_INTEGER,
		purpose: "invite",
	}));
	const mintFinished = Date.now();
	const mintBody = await minted.json() as { exp: number };
	s.check(minted.status === 200, "caller clock ahead no longer rejects pairing mint");
	s.check(
		mintBody.exp >= mintStarted + PAIRING_CODE_TTL_MS
			&& mintBody.exp <= mintFinished + PAIRING_CODE_TTL_MS,
		"mint expiry cannot be extended by the caller",
	);
}

s.section("operator destroy reports pending cleanup, checks room status, and skips completed R2");
{
	const statusFailure = await attemptVaultCleanup(
		makeEnv(),
		"vault-clean-aa",
		{
			vaultId: "vault-clean-aa",
			requestedAt: Date.now(),
			roomComplete: false,
			r2Complete: false,
			lastError: null,
		},
		async () => new Response(null, { status: 503 }),
	);
	s.check(!statusFailure.roomComplete, "non-2xx room response is not treated as complete");
	s.check(statusFailure.r2Complete, "missing R2 binding counts as complete");

	const config = makeMemoryConfig();
	await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-clean-aa",
		vaultName: "Cleanup",
		pairingCodeHash: "z".repeat(64),
		pairingPurpose: "device",
	}));
	const sessionToken = "operator-session-token-for-destroy";
	await config.fetch(jsonRequest("/__yaos/create-session", {
		sessionHash: await hashSecret(sessionToken),
		exp: Date.now() + 60_000,
	}));
	const bucket = new FakeR2Bucket({
		objects: new Map([["v1/vault-clean-aa/snapshots/one", new Uint8Array([1])]]),
	});
	const env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async (request) => await config.fetch(request)),
		YAOS_BUCKET: bucket,
	});
	const destroyRequest = () => new Request("https://example.test/operator/vaults/vault-clean-aa", {
		method: "DELETE",
		headers: { Cookie: `${OPERATOR_COOKIE}=${sessionToken}` },
	});
	const first = await handleOperatorDestroyVault(destroyRequest(), env, "vault-clean-aa");
	s.check(first.status === 202, "room failure returns truthful pending status");
	s.check(bucket.objects.size === 0, "R2 cleanup still completes");
	const firstListCalls = bucket.listCalls;
	const firstState = await config.fetch(new Request("https://internal/__yaos/console"));
	const firstStateBody = await firstState.json() as {
		pendingDestroys: Array<{ roomComplete: boolean; r2Complete: boolean }>;
	};
	s.check(
		firstStateBody.pendingDestroys[0]?.roomComplete === false
			&& firstStateBody.pendingDestroys[0]?.r2Complete === true,
		"pending state records each physical store independently",
	);
	const retry = await handleOperatorDestroyVault(destroyRequest(), env, "vault-clean-aa");
	s.check(retry.status === 202, "pending destroy remains retryable");
	s.check(bucket.listCalls === firstListCalls, "retry does not repeat completed R2 cleanup");
}

s.section("operator logout revokes copied cookies and clears cookies on failure");
{
	const config = makeMemoryConfig();
	const sessionToken = "copied-operator-session-token";
	await config.fetch(jsonRequest("/__yaos/create-session", {
		sessionHash: await hashSecret(sessionToken),
		exp: Date.now() + 60_000,
	}));
	const env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async (request) => await config.fetch(request)),
	});
	const copiedCookie = `${OPERATOR_COOKIE}=${sessionToken}`;
	const copiedRequest = () => new Request("https://example.test/operator/state", {
		headers: { Cookie: copiedCookie },
	});
	s.check(await verifyOperatorSession(env, copiedRequest()), "copied cookie works before logout");
	const logout = await handleOperatorLogout(new Request("https://example.test/operator/logout", {
		method: "POST",
		headers: { Cookie: copiedCookie },
	}), env);
	s.check(logout.status === 200, "logout reports successful revocation");
	s.check(logout.headers.get("Set-Cookie")?.includes("Max-Age=0") === true, "logout clears browser cookie");
	s.check(!(await verifyOperatorSession(env, copiedRequest())), "copied cookie fails after logout");

	const failedLogout = await handleOperatorLogout(new Request("https://example.test/operator/logout", {
		method: "POST",
		headers: { Cookie: copiedCookie },
	}), makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async () => new Response(
			JSON.stringify({ error: "storage_unavailable" }),
			{ status: 503, headers: { "Content-Type": "application/json" } },
		)),
	}));
	s.check(failedLogout.status === 503, "revoke failure status is truthful");
	s.check(failedLogout.headers.get("Set-Cookie")?.includes("Max-Age=0") === true, "revoke failure still clears cookie");
}

s.section("operator console keeps destroy outcomes distinct");
{
	const complete = operatorDestroyStatusMessage(200);
	const pending = operatorDestroyStatusMessage(202);
	const expired = operatorDestroyStatusMessage(401);
	const rejected = operatorDestroyStatusMessage(400);
	const missing = operatorDestroyStatusMessage(404);
	const serverFailure = operatorDestroyStatusMessage(503);
	s.check(complete.includes("complete") && !complete.includes("pending"), "HTTP 200 reports completed cleanup");
	s.check(pending.includes("pending") && pending.includes("revoked"), "only HTTP 202 reports revoked access with pending cleanup");
	s.check(expired.includes("Session expired"), "HTTP 401 reports session expiry");
	s.check(rejected.includes("rejected"), "HTTP 400 reports a rejected request");
	s.check(missing.includes("not found"), "HTTP 404 reports a missing vault or cleanup");
	s.check(serverFailure.includes("Server or configuration error"), "5xx reports a server or configuration failure");
	const distinctMessages = [complete, pending, expired, rejected, missing, serverFailure];
	s.check(
		distinctMessages.every((message, index) => distinctMessages.indexOf(message) === index),
		"destroy response classes have distinct messages",
	);
	for (const failedStatus of [400, 404, 500, 503]) {
		const message = operatorDestroyStatusMessage(failedStatus);
		s.check(!message.includes("pending") && !message.includes("revoked"), `HTTP ${failedStatus} does not claim revocation or pending cleanup`);
	}
	s.check(
		operatorStateLoadFailureMessage(401).includes("Session expired"),
		"operator-state 401 reports session expiry",
	);
	s.check(
		operatorStateLoadFailureMessage(500).includes("server configuration"),
		"other operator-state failures report server configuration load failure",
	);
}

s.section("operator console clears stale actions before loading state");
{
	const page = renderOperatorConsole({
		host: "https://example.test",
		attachments: true,
		snapshots: true,
	});
	const disable = page.indexOf("createVault.disabled = true");
	const clear = page.indexOf("root.replaceChildren();");
	const stateFetch = page.indexOf('fetch("/operator/state")');
	const validate = page.indexOf("if (!isOperatorState(data))");
	const commit = page.indexOf("root.replaceChildren(rendered)");
	const enable = page.indexOf("createVault.disabled = false");
	s.check(page.includes('id="create-vault" disabled'), "create starts disabled before the initial state response");
	s.check(disable >= 0 && disable < stateFetch, "every state load disables create before fetching");
	s.check(clear >= 0 && clear < stateFetch, "every state load removes stale vault actions before fetching");
	s.check(page.includes("document.createDocumentFragment()"), "new vault actions render off-DOM");
	s.check(validate >= 0 && validate < commit, "state shape is validated before cards are committed");
	s.check(commit >= 0 && commit < enable, "create is enabled only after valid cards are committed");
	s.check(page.includes("data-retry-destroy"), "pending cleanup has a retry action");
	s.check(page.includes("lastError.textContent = pending.lastError"), "pending error is rendered as text");
	s.check(page.includes("await requestVaultDestroy(retryDestroy)"), "retry uses the shared truthful destroy response handler");
	s.check(page.includes("await requestVaultDestroy(destroy)"), "initial destroy uses the shared truthful destroy response handler");
	s.check(page.includes("responseStatus >= 500"), "all 5xx destroy responses use the server failure status");
	s.check(!page.includes('res.status === 200 ? "" :'), "destroy errors are not conflated with pending cleanup");
	s.check(!page.includes("innerHTML"), "operator console does not inject pending values as HTML");
}


s.section("rename-vault and revoke-pairing");
{
	const config = makeMemoryConfig();
	await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-ren-aa",
		vaultName: "Personal",
		pairingCodeHash: "d".repeat(64),
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	const renamed = await config.fetch(jsonRequest("/__yaos/rename-vault", {
		vaultId: "vault-ren-aa",
		name: "Notes",
	}));
	s.check(renamed.status === 200, "rename 200");
	const minted = await config.fetch(jsonRequest("/__yaos/create-pairing-code", {
		vaultId: "vault-ren-aa",
		codeHash: "e".repeat(64),
		exp: Date.now() + 60_000,
		purpose: "invite",
	}));
	s.check(minted.ok, "pairing minted");
	const listed = await config.fetch(new Request("https://internal/__yaos/console"));
	const listedBody = await listed.json() as {
		vaults: Array<{ name: string }>;
		pairingCodes: Array<{ codeId: string }>;
	};
	s.check((listedBody.pairingCodes?.length ?? 0) >= 1, "codeId present");
	for (const code of listedBody.pairingCodes) {
		const revoked = await config.fetch(jsonRequest("/__yaos/revoke-pairing", { codeId: code.codeId }));
		s.check(revoked.status === 200, "revoke 200");
	}
	const after = await config.fetch(new Request("https://internal/__yaos/console"));
	const afterBody = await after.json() as { pairingCodes: unknown[] };
	s.check(afterBody.pairingCodes.length === 0, "code removed");
}

s.section("classifier: GET devices and DELETE auth/device");
{
	const src = readSource("server/src/index.ts");
	s.check(src.includes("devices"), "devices resource is classified");
	s.check(src.includes("handleVaultDeviceLeaveRoute"), "leave route is dispatched");
	s.check(src.includes("operator-vault-destroy"), "destroy route is classified");
}

s.section("schema admission requires room equality in both directions");
{
	const src = readSource("server/src/routes/syncSocket.ts");
	s.check(src.includes("client_schema_newer_than_room"), "newer client is rejected");
	s.check(src.includes("client_schema_older_than_room"), "older client is rejected");
}

s.section("self-leave uses authorized deviceId only");
{
	const src = readSource("server/src/routes/enroll.ts");
	s.check(src.includes("handleVaultDeviceLeaveRoute"), "leave handler exists");
	s.check(/revoke-device[\s\S]*device\.deviceId/.test(src), "leave revokes authorized deviceId");
}

s.section("delete-all closes the live room");
{
	const src = readSource("server/src/server.ts");
	s.check(src.includes("this.destroyed = true"), "delete-all marks the isolate destroyed");
	s.check(src.includes("getConnections()"), "delete-all closes live sockets");
	s.check(/if \(this\.destroyed\) return/.test(src), "onSave no-ops after destroy");
}

await s.done();
