/**
 * Multivault plane: identity, unique names, lifecycle, cleanup, operator
 * sessions, and exact schema admission.
 */
import ServerConfig from "../../server/src/config";
import { hashSecret, OPERATOR_COOKIE, PAIRING_CODE_TTL_MS, uniqueDeviceName } from "../../server/src/identity";
import { verifyOperatorSession } from "../../server/src/routes/auth";
import { handleOperatorLogout } from "../../server/src/routes/operator";
import {
	operatorDestroyStatusMessage,
	operatorStateLoadFailureMessage,
	renderOperatorConsole,
} from "../../server/src/setupPage";
import { makeConfigNamespace, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("multivault-registry");
function makeMemoryConfig(initial: Readonly<Record<string, unknown>> = {}): ServerConfig {
	const data = new Map<string, unknown>(Object.entries(initial));
	const storage = {
		get: async (key: string) => data.get(key),
		put: async (key: string, value: unknown) => {
			data.set(key, value);
		},
		delete: async (key: string) => {
			data.delete(key);
		},
		transaction: async <T>(
			fn: (txn: {
				get: (key: string) => Promise<unknown>;
				put: (key: string, value: unknown) => Promise<void>;
				delete: (key: string) => Promise<void>;
			}) => Promise<T>,
		): Promise<T> => {
			return await fn({
				get: async (key: string) => data.get(key),
				put: async (key: string, value: unknown) => {
					data.set(key, value);
				},
				delete: async (key: string) => {
					data.delete(key);
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

async function activateClaim(
	config: ServerConfig,
	claim: Response,
	pairingCodeHash?: string,
	pairingPurpose: "origin" | "device" | "invite" = "device",
): Promise<Response> {
	const claimed = await claim.clone().json() as { vaultId?: string; vaultGeneration?: string };
	return config.fetch(jsonRequest("/__yaos/activate-vault", {
		vaultId: claimed.vaultId,
		vaultGeneration: claimed.vaultGeneration,
		...(pairingCodeHash ? { pairingCodeHash, pairingPurpose } : {}),
	}));
}

s.section("claim is one-shot and old claimed formats stay unsupported");
{
	const config = makeMemoryConfig();
	const claimBody = {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "signing-key",
		vaultId: "vault-claim-aa",
		vaultName: "Personal",
		pairingCodeHash: "p".repeat(64),
		pairingPurpose: "device",
	};
	const first = await config.fetch(jsonRequest("/__yaos/claim", claimBody));
	const activated = await activateClaim(config, first);
	s.check(activated.status === 200, "first claimed vault activates");
	const second = await config.fetch(jsonRequest("/__yaos/claim", claimBody));
	s.check(first.status === 200, "first claim succeeds");
	s.check(second.status === 403, "second claim is rejected");
	s.check((await second.json() as { error?: string }).error === "already_claimed", "duplicate claim reports already_claimed");

	const oldConfig = makeMemoryConfig({ claimed: true });
	const oldClaim = await oldConfig.fetch(jsonRequest("/__yaos/claim", claimBody));
	s.check(oldClaim.status === 409, "old claimed config cannot be reinterpreted");
	s.check((await oldClaim.json() as { error?: string }).error === "server_format_unsupported", "old format is explicit");
}

s.section("expired operator sessions fail authorization");
{
	const sessionToken = "expired-operator-session";
	const config = makeMemoryConfig({
		operatorSessions: [{
			sessionHash: await hashSecret(sessionToken),
			exp: Date.now() - 1,
			createdAt: Date.now() - 10_000,
		}],
	});
	const env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async (request) => await config.fetch(request)),
	});
	const request = new Request("https://example.test/operator/state", {
		headers: { Cookie: `${OPERATOR_COOKIE}=${sessionToken}` },
	});
	s.check(!(await verifyOperatorSession(env, request)), "expired operator cookie is rejected");
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
	const claimed = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-one-aa",
		vaultName: "Work",
		pairingCodeHash: "a".repeat(64),
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	s.check((await activateClaim(config, claimed, "a".repeat(64))).status === 200, "enrollment vault activates");
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
	const claimed = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-gone-1",
		vaultName: "Temp",
		pairingCodeHash: "c".repeat(64),
		pairingPurpose: "device",
	}));
	s.check((await activateClaim(config, claimed, "c".repeat(64))).status === 200, "destroy target activates before enrollment");
	await config.fetch(jsonRequest("/__yaos/enroll", {
		pairingCodeHash: "c".repeat(64),
		deviceId: "dev-gone",
		deviceTokenHash: "tg".repeat(32),
		deviceName: "Phone",
	}));
	const destroyed = await config.fetch(jsonRequest("/__yaos/destroy-vault", { vaultId: "vault-gone-1" }));
	const destroyedBody = await destroyed.json() as {
		pending: {
			requestedAt: number;
			roomComplete: boolean;
			r2Complete: boolean;
			purgeState: string;
			vaultGeneration: string;
			purgeJobId: string;
			deletionId: string;
		};
	};
	s.check(destroyed.status === 200, "registry destroy 200");
	s.check(
		!destroyedBody.pending.roomComplete
			&& !destroyedBody.pending.r2Complete
			&& destroyedBody.pending.purgeState === "pending",
		"physical cleanup starts pending",
	);
	const consoleRes = await config.fetch(new Request("https://internal/__yaos/console"));
	const consoleBody = await consoleRes.json() as {
		vaults: Array<{ vaultId: string; state: string }>;
		devices: unknown[];
		pairingCodes: unknown[];
		pendingDestroys: unknown[];
	};
	s.check(
		consoleBody.vaults.length === 1
			&& consoleBody.vaults[0]?.vaultId === "vault-gone-1"
			&& consoleBody.vaults[0]?.state === "deleting",
		"destroy revokes admission by retaining only generation-fenced deleting state",
	);
	s.check(consoleBody.devices.length === 0, "all memberships are revoked before purge admission");
	s.check(consoleBody.pairingCodes.length === 0, "all pairing capabilities are revoked before purge admission");
	s.check(consoleBody.pendingDestroys.length === 1, "physical cleanup obligation remains visible");
	s.check(
		destroyedBody.pending.purgeJobId
			=== `purge:vault-gone-1:${destroyedBody.pending.vaultGeneration}`,
		"purge actor identity is generation-scoped",
	);

	const retry = await config.fetch(jsonRequest("/__yaos/destroy-vault", { vaultId: "vault-gone-1" }));
	const retryBody = await retry.json() as { pending: { requestedAt: number } };
	s.check(retry.status === 200, "pending destroy is idempotent");
	s.check(retryBody.pending.requestedAt === destroyedBody.pending.requestedAt, "retry preserves original request time");
	const reused = await config.fetch(jsonRequest("/__yaos/create-vault", {
		vaultId: "vault-gone-1",
		name: "Replacement",
	}));
	s.check(reused.status === 409, "pending vault id cannot be reused before cleanup completes");

	const expiredCapability = "expired-purge-capability";
	await config.fetch(jsonRequest("/__yaos/update-destroy-vault", {
		vaultId: "vault-gone-1",
		roomComplete: false,
		r2Complete: false,
		purgeState: "queued",
		capabilityHash: await hashSecret(expiredCapability),
		capabilityExpiresAt: Date.now() - 1,
		deletedObjects: 0,
		deletedBytes: 0,
		lastError: null,
	}));
	const expiredProgress = await config.fetch(jsonRequest("/__yaos/deletion/progress", {
		deletionId: destroyedBody.pending.deletionId,
		vaultId: "vault-gone-1",
		vaultGeneration: destroyedBody.pending.vaultGeneration,
		jobId: destroyedBody.pending.purgeJobId,
		capability: expiredCapability,
		state: "purging",
		deletedObjects: 1,
		deletedBytes: 1,
		error: null,
	}));
	s.check(expiredProgress.status === 401, "expired purge capability fails closed");
	const wrongProgress = await config.fetch(jsonRequest("/__yaos/deletion/progress", {
		deletionId: destroyedBody.pending.deletionId,
		vaultId: "vault-gone-1",
		vaultGeneration: destroyedBody.pending.vaultGeneration,
		jobId: destroyedBody.pending.purgeJobId,
		capability: "wrong-purge-capability",
		state: "retrying",
		deletedObjects: 1,
		deletedBytes: 1,
		error: { code: "transient" },
	}));
	s.check(wrongProgress.status === 401, "purge retry with the wrong capability fails closed");

	const outOfOrder = await config.fetch(jsonRequest("/__yaos/update-destroy-vault", {
		vaultId: "vault-gone-1",
		roomComplete: true,
		r2Complete: false,
		purgeState: "pending",
		lastError: null,
	}));
	s.check(outOfOrder.status === 409, "SQL room deletion cannot complete before object purge");

	const purgeComplete = await config.fetch(jsonRequest("/__yaos/update-destroy-vault", {
		vaultId: "vault-gone-1",
		roomComplete: false,
		r2Complete: true,
		purgeState: "complete",
		deletedObjects: 7,
		deletedBytes: 99,
		lastError: null,
	}));
	s.check(purgeComplete.status === 202, "completed purge retains the SQL cleanup obligation");
	const completed = await config.fetch(jsonRequest("/__yaos/update-destroy-vault", {
		vaultId: "vault-gone-1",
		roomComplete: true,
		r2Complete: true,
		purgeState: "complete",
		deletedObjects: 7,
		deletedBytes: 99,
		lastError: null,
	}));
	s.check(completed.status === 200, "SQL cleanup completes only after generation purge");
	const finalConsole = await config.fetch(new Request("https://internal/__yaos/console"));
	const finalBody = await finalConsole.json() as { pendingDestroys: unknown[] };
	s.check(finalBody.pendingDestroys.length === 0, "completed cleanup record is removed");
	const missing = await config.fetch(jsonRequest("/__yaos/destroy-vault", { vaultId: "vault-gone-1" }));
	s.check(missing.status === 404, "completed destroy is no longer pending");
}
s.section("pairing expiry is authoritative in config despite a skewed caller timestamp");
{
	const config = makeMemoryConfig();
	const claimed = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-exp-aa",
		vaultName: "Expiry",
		pairingCodeHash: "x".repeat(64),
		pairingExp: Number.MAX_SAFE_INTEGER,
		pairingPurpose: "device",
	}));
	s.check(claimed.status === 200, "caller clock ahead no longer rejects claim");
	const activationStarted = Date.now();
	const activated = await activateClaim(config, claimed, "x".repeat(64));
	const activationFinished = Date.now();
	const activationBody = await activated.json() as { pairingExp: number };
	s.check(activated.status === 200, "claimed vault activates with its initial pairing code");
	s.check(
		activationBody.pairingExp >= activationStarted + PAIRING_CODE_TTL_MS
			&& activationBody.pairingExp <= activationFinished + PAIRING_CODE_TTL_MS,
		"activation expiry comes from config time and fixed TTL",
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
	s.check(page.includes("data-retry-provision"), "provisioning vault has an operator retry action");
	s.check(page.includes('"/provision"'), "provisioning retry uses the operator-only route");
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
	const claimed = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "h".repeat(64),
		ticketSigningKey: "key",
		vaultId: "vault-ren-aa",
		vaultName: "Personal",
		pairingCodeHash: "d".repeat(64),
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	s.check((await activateClaim(config, claimed, "d".repeat(64))).status === 200, "rename target activates");
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

s.section("corrupt identity references and destruction state fail closed");
{
	const vault = {
		vaultId: "vault-known-aa",
		name: "Known",
		state: "active" as const,
		vaultGeneration: "generation-known-aa",
		createdAt: 1_000,
		provisionedAt: 1_001,
	};
	const danglingDevice = makeMemoryConfig({
		vaults: [vault],
		devices: [{
			deviceId: "device-dangling",
			vaultId: "vault-missing-aa",
			tokenHash: "device-token-hash",
			name: "Lost phone",
			enrolledAt: 1_100,
		}],
	});
	const deviceResponse = await danglingDevice.fetch(new Request("https://internal/__yaos/console"));
	const deviceError = await deviceResponse.json() as { error?: string; collection?: string };
	s.check(
		deviceResponse.status === 500
			&& deviceError.error === "corrupt_identity_state"
			&& deviceError.collection === "devices",
		"dangling device membership is an explicit fail-closed error",
	);

	const danglingCode = makeMemoryConfig({
		vaults: [vault],
		pairingCodes: [{
			codeId: "code-dangling",
			codeHash: "pairing-code-hash",
			vaultId: "vault-missing-aa",
			exp: 2_000,
			maxUses: 1,
			uses: 0,
			purpose: "device",
			createdAt: 1_100,
		}],
	});
	const codeResponse = await danglingCode.fetch(new Request("https://internal/__yaos/console"));
	const codeError = await codeResponse.json() as { error?: string; collection?: string };
	s.check(
		codeResponse.status === 500
			&& codeError.error === "corrupt_identity_state"
			&& codeError.collection === "pairingCodes",
		"dangling pairing-code vault references fail closed",
	);

	const corruptPending = makeMemoryConfig({
		pendingVaultDestroys: [{
			vaultId: "vault-delete-aa",
			requestedAt: "yesterday",
			roomComplete: false,
			r2Complete: false,
			lastError: null,
		}],
	});
	const pendingResponse = await corruptPending.fetch(jsonRequest("/__yaos/update-destroy-vault", {
		vaultId: "vault-delete-aa",
		roomComplete: true,
		r2Complete: false,
		lastError: null,
	}));
	const pendingError = await pendingResponse.json() as { error?: string; collection?: string; message?: string };
	s.check(
		pendingResponse.status === 500
			&& pendingError.error === "corrupt_identity_state"
			&& pendingError.collection === "pendingVaultDestroys",
		"malformed pending destruction is not skipped or treated as missing",
	);
	s.check((pendingError.message?.length ?? 1_000) <= 192, "persisted corruption response is bounded");
}


await s.done();
