/**
 * Multivault auth gates: reserved vault ids, device rename, and operator-only
 * metadata.
 */
import {
	ControlPlaneRuntime,
	MAX_ENROLLMENT_REPLAY_RECORDS,
	MAX_PENDING_DESTROYS,
	MAX_PENDING_DEVICE_REVOCATIONS,
	parseEnrollmentReplayRecords,
	parsePendingDestroyRecords,
	parsePendingDeviceRevocationRecords,
} from "../../server/src/config";
import type { ControlPlaneStoragePort, ControlPlaneTransactionPort } from "../../server/src/platformPorts";
import {
	CorruptIdentityStateError,
	MAX_DEVICE_RECORDS,
	MAX_OPERATOR_SESSION_RECORDS,
	MAX_PAIRING_CODE_RECORDS,
	MAX_VAULT_RECORDS,
	hashSecret,
	isUsableVaultId,
	OPERATOR_COOKIE,
	parseDeviceRecords,
	parseOperatorSessionRecords,
	parsePairingCodeRecords,
	parseVaultRecords,
} from "../../server/src/identity";
import { handleUpdateMetadataRoute, invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import { handleEnrollRoute, handleVaultDeviceRoute } from "../../server/src/routes/enroll";
import type { AuthState } from "../../server/src/routes/types";
import { handleWorkerRequest } from "../../server/src/index";
import { makeConfigNamespace, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("identity-control-plane");

const CLAIM_AUTH: AuthState = {
	mode: "claim",
	claimed: true,
	operatorRecoveryHash: "a".repeat(64),
	ticketSigningKey: "ticket-signing-key-for-tests",
};

function makeMemoryConfig(): ControlPlaneRuntime {
	const data = new Map<string, unknown>();
	const transaction: ControlPlaneTransactionPort = {
		get: async <T = unknown>(key: string) => data.get(key) as T | undefined,
		put: async (key: string, value: unknown) => {
			data.set(key, value);
		},
		delete: async (key: string) => data.delete(key),
	};
	const storage: ControlPlaneStoragePort = {
		...transaction,
		transaction: async <T>(fn: (txn: ControlPlaneTransactionPort) => Promise<T>): Promise<T> =>
			await fn(transaction),
	};
	return new ControlPlaneRuntime(storage);
}

function jsonRequest(path: string, body: unknown): Request {
	return new Request(`https://internal${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function activateClaim(
	config: ControlPlaneRuntime,
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

function captureCorruptState(read: () => unknown): CorruptIdentityStateError | null {
	try {
		read();
		return null;
	} catch (error) {
		return error instanceof CorruptIdentityStateError ? error : null;
	}
}

s.section("isUsableVaultId: length, slashes, reserved sync");
{
	s.check(isUsableVaultId("abcdefgh"), "8-char id is usable");
	s.check(isUsableVaultId("  vault-id-ok  "), "trim is applied");
	s.check(!isUsableVaultId("short"), "shorter than 8 is rejected");
	s.check(!isUsableVaultId("sync"), "reserved sync is rejected");
	s.check(!isUsableVaultId("SYNC"), "reserved SYNC is rejected");
	s.check(!isUsableVaultId("  sync  "), "padded sync is rejected");
	s.check(!isUsableVaultId("vault/id-ok"), "slash is rejected");
	s.check(!isUsableVaultId("vault\\id-ok"), "backslash is rejected");
	s.check(isUsableVaultId("syncsync"), "sync prefix that is not exactly sync is usable");
}

s.section("claim persist and create-vault reject unusable vault ids");
{
	const config = makeMemoryConfig();
	const pairing = {
		operatorRecoveryHash: "op-hash",
		ticketSigningKey: "sign-key",
		vaultName: "Personal",
		pairingCodeHash: "pair-hash",
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device" as const,
	};

	const slashClaim = await config.fetch(jsonRequest("/__yaos/claim", {
		...pairing,
		vaultId: "abcdefgh/",
	}));
	s.check(slashClaim.status === 400, "claim rejects slash vaultId");

	const reservedClaim = await config.fetch(jsonRequest("/__yaos/claim", {
		...pairing,
		vaultId: "sync",
	}));
	s.check(reservedClaim.status === 400, "claim rejects reserved sync");

	const slashCreate = await config.fetch(jsonRequest("/__yaos/create-vault", {
		vaultId: "team\\vault",
		name: "Team",
	}));
	s.check(slashCreate.status === 400, "create-vault rejects backslash vaultId");

	const okCreate = await config.fetch(jsonRequest("/__yaos/create-vault", {
		vaultId: "team-vault",
		name: "Team",
	}));
	s.check(okCreate.status === 200, "create-vault accepts a usable id");
}

s.section("rename-device updates the authorized device record");
{
	const config = makeMemoryConfig();
	const vaultId = "vault-one";
	const claim = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "op-hash",
		ticketSigningKey: "sign-key",
		vaultId,
		vaultName: "Personal",
		pairingCodeHash: "a".repeat(64),
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	s.check(claim.status === 200, "claim succeeds with usable vaultId");
	const activated = await activateClaim(config, claim, "a".repeat(64));
	s.check(activated.status === 200, "claimed vault activates before enrollment");

	const enrolled = await config.fetch(jsonRequest("/__yaos/enroll", {
		enrollmentRequestId: "request-rename-aa",
		pairingCodeHash: "a".repeat(64),
		deviceId: "dev-1",
		deviceTokenHash: "b".repeat(64),
		deviceName: "phone",
	}));
	s.check(enrolled.status === 200, "enroll succeeds");

	const renamed = await config.fetch(jsonRequest("/__yaos/rename-device", {
		deviceId: "dev-1",
		name: "  iPhone  ",
	}));
	s.check(renamed.status === 200, "rename-device returns 200");
	const renamedBody = await renamed.json() as { ok?: boolean; device?: { name?: string; deviceId?: string } };
	s.check(renamedBody.ok === true && renamedBody.device?.name === "iPhone", "device name is trimmed and stored");
	s.check(renamedBody.device?.deviceId === "dev-1", "rename keeps the authorized deviceId");

	const empty = await config.fetch(jsonRequest("/__yaos/rename-device", {
		deviceId: "dev-1",
		name: "   ",
	}));
	s.check(empty.status === 400, "empty rename name is 400");

	const tooLong = await config.fetch(jsonRequest("/__yaos/rename-device", {
		deviceId: "dev-1",
		name: "n".repeat(51),
	}));
	s.check(tooLong.status === 400, "overlong rename name is 400");

	const missing = await config.fetch(jsonRequest("/__yaos/rename-device", {
		deviceId: "no-such-device",
		name: "Ghost",
	}));
	s.check(missing.status === 404, "unknown device rename is 404");
}

s.section("verify-device requires a live enrollment on that vault");
{
	const config = makeMemoryConfig();
	const vaultId = "vault-live";
	const claim = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "op-hash",
		ticketSigningKey: "sign-key",
		vaultId,
		vaultName: "Personal",
		pairingCodeHash: "c".repeat(64),
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	const activated = await activateClaim(config, claim, "c".repeat(64));
	s.check(activated.status === 200, "verification vault activates before enrollment");
	await config.fetch(jsonRequest("/__yaos/enroll", {
		enrollmentRequestId: "request-verify-aa",
		pairingCodeHash: "c".repeat(64),
		deviceId: "dev-live",
		deviceTokenHash: "d".repeat(64),
		deviceName: "phone",
	}));

	const live = await config.fetch(jsonRequest("/__yaos/verify-device", {
		deviceId: "dev-live",
		vaultId,
	}));
	s.check(live.status === 200, "enrolled device verifies");

	const wrongVault = await config.fetch(jsonRequest("/__yaos/verify-device", {
		deviceId: "dev-live",
		vaultId: "other-vault",
	}));
	s.check(wrongVault.status === 401, "device on another vault is 401");

	const revokeResponse = await config.fetch(jsonRequest("/__yaos/revoke-device", { deviceId: "dev-live" }));
	const revoked = await config.fetch(jsonRequest("/__yaos/verify-device", {
		deviceId: "dev-live",
		vaultId,
	}));
	s.check(revoked.status === 401, "revoked device is 401");
	const revokeBody = await revokeResponse.json() as { revocation?: {
		vaultId: string;
		vaultGeneration: string;
		deviceId: string;
	} };
	s.check(revokeResponse.status === 200 && revokeBody.revocation?.deviceId === "dev-live", "membership removal creates a revocation obligation");
	const revocation = revokeBody.revocation;
	if (!revocation) throw new Error("revocation obligation missing");
	const pendingConsole = await config.fetch(new Request("https://internal/__yaos/console"));
	const pendingState = await pendingConsole.json() as { pendingDeviceRevocations: Array<{ deviceId: string; lastError: string | null }> };
	s.check(pendingState.pendingDeviceRevocations.length === 1, "revocation obligation remains visible after membership removal");
	const failedFence = await config.fetch(jsonRequest("/__yaos/fail-device-revocation", {
		...revocation,
		lastError: "runtime unavailable",
	}));
	s.check(failedFence.status === 202, "failed runtime fence remains pending");
	const failedState = await (await config.fetch(new Request("https://internal/__yaos/console"))).json() as {
		pendingDeviceRevocations: Array<{ lastError: string | null }>;
	};
	s.check(failedState.pendingDeviceRevocations[0]?.lastError === "runtime unavailable", "operator state exposes the durable fence failure");
	const completedFence = await config.fetch(jsonRequest("/__yaos/complete-device-revocation", revocation));
	s.check(completedFence.status === 200, "successful runtime fence acknowledges the obligation");
	const completedState = await (await config.fetch(new Request("https://internal/__yaos/console"))).json() as {
		pendingDeviceRevocations: unknown[];
	};
	s.check(completedState.pendingDeviceRevocations.length === 0, "successful fence removes the revocation obligation");
}

s.section("device token cannot rename without auth or on another vault");
{
	const deviceToken = "device-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const deviceTokenHash = await hashSecret(deviceToken);
	const vaultId = "vault-alpha";
	const otherVault = "vault-beta";
	const renameBodies: Array<{ deviceId?: string; name?: string }> = [];

	const env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async (req) => {
			const pathname = new URL(req.url).pathname;
			if (pathname === "/__yaos/authorize-device") {
				const body = await req.json() as { tokenHash?: string; vaultId?: string };
				if (body.tokenHash === deviceTokenHash && body.vaultId === vaultId) {
					return new Response(JSON.stringify({
						ok: true,
						device: { deviceId: "dev-auth", vaultId, name: "old", enrolledAt: 1 },
					}), { status: 200, headers: { "Content-Type": "application/json" } });
				}
				return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
			}
			if (pathname === "/__yaos/rename-device") {
				const renameBody = await req.json() as { deviceId?: string; name?: string };
				renameBodies.push(renameBody);
				return new Response(JSON.stringify({
					ok: true,
					device: { deviceId: renameBody.deviceId, vaultId, name: renameBody.name, enrolledAt: 1 },
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			throw new Error(`unexpected config request: ${pathname}`);
		}),
	});

	const unauth = await handleVaultDeviceRoute(
		new Request(`https://example.test/vault/${vaultId}/auth/device`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Nope" }),
		}),
		env,
		vaultId,
	);
	s.check(unauth.status === 401, "rename without bearer is 401");
	s.check(renameBodies.length === 0, "rename-device is not called without auth");

	const foreign = await handleVaultDeviceRoute(
		new Request(`https://example.test/vault/${otherVault}/auth/device`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${deviceToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "Hijack", deviceId: "someone-else" }),
		}),
		env,
		otherVault,
	);
	s.check(foreign.status === 401, "device token cannot rename on another vault");
	s.check(renameBodies.length === 0, "rename-device is not called for a foreign vault");

	const ok = await handleVaultDeviceRoute(
		new Request(`https://example.test/vault/${vaultId}/auth/device`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${deviceToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: "iPhone", deviceId: "forged-id" }),
		}),
		env,
		vaultId,
	);
	s.check(ok.status === 200, "authorized device can rename");
	s.check(renameBodies[0]?.deviceId === "dev-auth", "rename uses authorized deviceId, not the client body");
	s.check(renameBodies[0]?.name === "iPhone", "rename forwards the trimmed name");
}

s.section("update-metadata: device bearer 401, operator session 200");
{
	invalidateStoredServerConfigCache();
	const deviceToken = "device-meta-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const sessionToken = "op-session-cccccccccccccccccccccccccccccccc";
	const sessionHash = await hashSecret(sessionToken);
	let metadataWrites = 0;
	const stored = {
		claimed: true,
		configFormat: 2,
		operatorRecoveryHash: CLAIM_AUTH.operatorRecoveryHash,
		ticketSigningKey: CLAIM_AUTH.ticketSigningKey,
		updateProvider: "github" as const,
		updateRepoUrl: "https://github.com/private/fork",
		updateRepoBranch: "main",
	};
	const env = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async (req) => {
			const pathname = new URL(req.url).pathname;
			if (pathname === "/__yaos/config") {
				return new Response(JSON.stringify(stored), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (pathname === "/__yaos/authorize-device") {
				return new Response(JSON.stringify({
					ok: true,
					device: { deviceId: "dev-1", vaultId: "v1", name: "phone", enrolledAt: 1 },
				}), { status: 200, headers: { "Content-Type": "application/json" } });
			}
			if (pathname === "/__yaos/verify-session") {
				const body = await req.json() as { sessionHash?: string };
				if (body.sessionHash === sessionHash) {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ ok: false }), { status: 401 });
			}
			if (pathname === "/__yaos/update-metadata") {
				metadataWrites++;
				return new Response(JSON.stringify({ ok: true, config: stored }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected config request: ${pathname}`);
		}),
	});

	const deviceRes = await handleUpdateMetadataRoute(
		new Request("https://example.test/api/update-metadata", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${deviceToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ updateProvider: "github" }),
		}),
		env,
		CLAIM_AUTH,
	);
	s.check(deviceRes.status === 401, "device bearer cannot POST update-metadata");
	s.check(metadataWrites === 0, "device bearer does not write metadata");

	const operatorRes = await handleUpdateMetadataRoute(
		new Request("https://example.test/api/update-metadata", {
			method: "POST",
			headers: {
				Cookie: `${OPERATOR_COOKIE}=${sessionToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ updateProvider: "github" }),
		}),
		env,
		CLAIM_AUTH,
	);
	s.check(operatorRes.status === 200, "operator session can POST update-metadata");
	s.check(metadataWrites === 1, "operator session writes metadata once");

	const workerDevice = await handleWorkerRequest(new Request("https://example.test/api/update-metadata", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${deviceToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ updateProvider: "github" }),
	}), env);

	s.check(workerDevice.status === 401, "worker device bearer is 401");
	invalidateStoredServerConfigCache();
}

s.section("public enrollment response is exact and fails closed");
{
	const enrollmentRequestId = "public-enroll-request";
	const deviceId = "device-enroll-0001";
	const deviceToken = "A".repeat(43);
	const validEnv = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async () => new Response(JSON.stringify({
			vaultId: "vault-enroll",
			deviceId,
			deviceName: "Mac",
			vaultGeneration: "generation-enroll",
			originImport: true,
		}), { status: 200, headers: { "Content-Type": "application/json" } })),
	});
	const request = () => new Request("https://sync.example/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingCode: "pairing-code", enrollmentRequestId, deviceId, deviceToken, deviceName: "Mac" }),
	});
	const valid = await handleEnrollRoute(request(), validEnv);
	const validBody = await valid.json() as Record<string, unknown>;
	s.check(valid.status === 200, "valid internal enrollment becomes a public success");
	s.check(
		JSON.stringify(Object.keys(validBody).sort()) ===
			JSON.stringify(["deviceId", "deviceName", "deviceToken", "host", "originImport", "vaultGeneration", "vaultId"]),
		"public enrollment returns the exact credential contract",
	);
	s.check(validBody.host === "https://sync.example" && validBody.deviceName === "Mac", "public enrollment returns canonical host and name");
	s.check(validBody.deviceId === deviceId && validBody.deviceToken === deviceToken, "public enrollment returns the client-generated credentials");

	const invalidEnv = makeEnv({
		YAOS_CONFIG: makeConfigNamespace(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
	});
	const invalid = await handleEnrollRoute(request(), invalidEnv);
	const invalidBody = await invalid.json() as Record<string, unknown>;
	s.check(invalid.status === 502, "malformed internal enrollment fails closed");
	s.check(!("deviceToken" in invalidBody), "malformed enrollment never releases a device token");
}

s.section("compact requires both the admin flag and an operator session");
{
	invalidateStoredServerConfigCache();
	const sessionToken = "operator-session-for-compact";
	const stored = {
		configFormat: 2,
		claimed: true,
		operatorRecoveryHash: CLAIM_AUTH.operatorRecoveryHash,
		ticketSigningKey: CLAIM_AUTH.ticketSigningKey,
		updateProvider: null,
		updateRepoUrl: null,
		updateRepoBranch: null,
	};
	let vaultReads = 0;
	const config = makeConfigNamespace(async (request) => {
		const pathname = new URL(request.url).pathname;
		if (pathname === "/__yaos/config") {
			return new Response(JSON.stringify(stored), { status: 200 });
		}
		if (pathname === "/__yaos/verify-session") {
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}
		if (pathname === "/__yaos/vault") {
			vaultReads++;
			return Response.json({
				vault: {
					vaultId: "vault-compact",
					name: "Compact",
					state: "active",
					vaultGeneration: "generation-compact",
					createdAt: 1,
					provisionedAt: 2,
				},
			});
		}
		throw new Error(`unexpected config request: ${pathname}`);
	});
	const forwarded: Array<{ path: string; deviceId: string | null }> = [];
	const sync = makeVaultSyncNamespace(async (request) => {
		forwarded.push({
			path: new URL(request.url).pathname,
			deviceId: request.headers.get("x-yaos-device-id"),
		});
		return Response.json({ compacted: true });
	});
	const env = makeEnv({
		YAOS_CONFIG: config,
		YAOS_SYNC: sync,
		YAOS_ENABLE_ADMIN_ROUTES: "true",
	});
	const path = "https://example.test/vault/vault-compact/debug/compact";
	const device = await handleWorkerRequest(new Request(path, {
		method: "POST",
		headers: { Authorization: "Bearer device-token" },
	}), env);
	s.check(device.status === 401, "device bearer cannot compact");
	s.check(sync.actorSelections === 0 && sync.calls === 0 && forwarded.length === 0, "device rejection does not allocate the vault runtime");
	const operator = await handleWorkerRequest(new Request(path, {
		method: "POST",
		headers: { Cookie: `${OPERATOR_COOKIE}=${sessionToken}` },
	}), env);
	s.check(operator.status === 200, "operator session reaches schema-4 compact runtime");
	s.check(vaultReads === 1, "active vault authority is read once after operator auth");
	s.check(sync.actorSelections === 1 && sync.calls === 1 && forwarded.length === 1, "authorized compact allocates and fetches one vault runtime");
	s.check(forwarded[0]?.path === "/compact" && forwarded[0]?.deviceId === null, "operator compact forwards only the canonical internal route");
	invalidateStoredServerConfigCache();
}

s.section("persisted identity parsers reject malformed, duplicate, and oversized state");
{
	const vault = {
		vaultId: "vault-parse-aa",
		name: "Personal",
		state: "active" as const,
		vaultGeneration: "generation-parse-aa",
		createdAt: 1_000,
		provisionedAt: 1_001,
	};
	const device = {
		deviceId: "device-parse",
		vaultId: vault.vaultId,
		tokenHash: "device-hash",
		name: "Phone",
		enrolledAt: 1_100,
	};
	const code = {
		codeId: "code-parse",
		codeHash: "code-hash",
		vaultId: vault.vaultId,
		exp: 2_000,
		maxUses: 1,
		uses: 0,
		purpose: "device" as const,
		createdAt: 1_100,
	};
	const session = { sessionHash: "session-hash", exp: 2_000, createdAt: 1_100 };
	const pending = {
		vaultId: "vault-pending-aa",
		vaultGeneration: "generation-pending-aa",
		deletionId: "deletion-pending-aa",
		purgeJobId: "purge:vault-pending-aa:generation-pending-aa",
		requestedAt: 1_200,
		roomComplete: false,
		r2Complete: false,
		purgeState: "pending" as const,
		capabilityHash: null,
		capabilityExpiresAt: null,
		deletedObjects: 0,
		deletedBytes: 0,
		lastError: null,
	};
	const revocation = {
		vaultId: vault.vaultId,
		vaultGeneration: vault.vaultGeneration,
		deviceId: device.deviceId,
		requestedAt: 1_200,
		lastError: null,
	};
	const enrollmentReplay = {
		enrollmentRequestId: "request-parser-aa",
		pairingCodeHash: "a".repeat(64),
		deviceId: device.deviceId,
		deviceTokenHash: "b".repeat(64),
		vaultId: vault.vaultId,
		vaultGeneration: vault.vaultGeneration,
		deviceName: device.name,
		originImport: false,
		createdAt: 1_100,
		expiresAt: 2_100,
	};
	const knownVaultIds = new Set([vault.vaultId]);

	const malformed = [
		captureCorruptState(() => parseVaultRecords([{ ...vault, unexpected: true }])),
		captureCorruptState(() => parseDeviceRecords([{ ...device, enrolledAt: -1 }])),
		captureCorruptState(() => parsePairingCodeRecords([{ ...code, purpose: "recovery" }])),
		captureCorruptState(() => parseOperatorSessionRecords([{ ...session, exp: Number.NaN }])),
		captureCorruptState(() => parsePendingDestroyRecords([{ ...pending, roomComplete: "yes" }])),
		captureCorruptState(() => parsePendingDeviceRevocationRecords([{ ...revocation, lastError: " ".repeat(2) }])),
		captureCorruptState(() => parseEnrollmentReplayRecords([{ ...enrollmentReplay, deviceTokenHash: "plaintext" }])),
	];
	s.check(
		malformed.every((error) => error?.code === "corrupt_identity_state" && error.message.length <= 192),
		"all malformed record shapes and fields fail with the bounded corruption error",
	);

	const duplicates = [
		captureCorruptState(() => parseVaultRecords([vault, { ...vault }])),
		captureCorruptState(() => parseDeviceRecords([device, { ...device }], knownVaultIds)),
		captureCorruptState(() => parsePairingCodeRecords([code, { ...code }], knownVaultIds)),
		captureCorruptState(() => parseOperatorSessionRecords([session, { ...session }])),
		captureCorruptState(() => parsePendingDestroyRecords([pending, { ...pending }])),
		captureCorruptState(() => parsePendingDeviceRevocationRecords([revocation, { ...revocation }])),
		captureCorruptState(() => parseEnrollmentReplayRecords([enrollmentReplay, { ...enrollmentReplay }])),
	];
	s.check(
		duplicates.every((error) => error?.message.includes("duplicate")),
		"duplicate identifiers fail closed in every persisted collection",
	);

	const oversized = [
		captureCorruptState(() => parseVaultRecords(new Array(MAX_VAULT_RECORDS + 1))),
		captureCorruptState(() => parseDeviceRecords(new Array(MAX_DEVICE_RECORDS + 1))),
		captureCorruptState(() => parsePairingCodeRecords(new Array(MAX_PAIRING_CODE_RECORDS + 1))),
		captureCorruptState(() => parseOperatorSessionRecords(new Array(MAX_OPERATOR_SESSION_RECORDS + 1))),
		captureCorruptState(() => parsePendingDestroyRecords(new Array(MAX_PENDING_DESTROYS + 1))),
		captureCorruptState(() => parsePendingDeviceRevocationRecords(new Array(MAX_PENDING_DEVICE_REVOCATIONS + 1))),
		captureCorruptState(() => parseEnrollmentReplayRecords(new Array(MAX_ENROLLMENT_REPLAY_RECORDS + 1))),
	];
	s.check(
		oversized.every((error) => error?.message.includes("exceeds capacity")),
		"every persisted collection rejects oversized state before reading records",
	);

	s.check(parseVaultRecords([vault])[0]?.vaultId === vault.vaultId, "valid vault records are preserved");
	s.check(parseDeviceRecords([device], knownVaultIds)[0]?.name === device.name, "valid device records are preserved");
	s.check(parsePairingCodeRecords([code], knownVaultIds)[0]?.codeId === code.codeId, "valid pairing records are preserved");
	s.check(parseOperatorSessionRecords([session])[0]?.sessionHash === session.sessionHash, "valid sessions are preserved");
	s.check(parsePendingDestroyRecords([pending])[0]?.vaultId === pending.vaultId, "valid pending destroys are preserved");
	s.check(parsePendingDeviceRevocationRecords([revocation])[0]?.deviceId === revocation.deviceId, "valid pending revocations are preserved");
	s.check(parseEnrollmentReplayRecords([enrollmentReplay])[0]?.enrollmentRequestId === enrollmentReplay.enrollmentRequestId, "valid enrollment replays are preserved");
}

s.section("origin pairing grants one enrollment the initial-import authority");
{
	const config = makeMemoryConfig();
	const claim = await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "origin-operator-hash",
		ticketSigningKey: "origin-ticket-key",
		vaultId: "vault-origin-aa",
		vaultName: "Personal",
		pairingCodeHash: "e".repeat(64),
		pairingPurpose: "origin",
	}));
	s.check(claim.status === 200, "origin vault reservation succeeds");
	s.check((await activateClaim(config, claim, "e".repeat(64), "origin")).status === 200, "origin pairing activates with the vault");
	const enrolled = await config.fetch(jsonRequest("/__yaos/enroll", {
		enrollmentRequestId: "request-origin-aa",
		pairingCodeHash: "e".repeat(64),
		deviceId: "device-origin-aa",
		deviceTokenHash: "f".repeat(64),
		deviceName: "Origin device",
	}));
	const body = await enrolled.json() as Record<string, unknown>;
	s.check(enrolled.status === 200 && body.originImport === true, "origin pairing grants initial import once");
	s.check(body.vaultGeneration === "generation" || typeof body.vaultGeneration === "string", "enrollment returns the vault generation");
	const recovered = await config.fetch(jsonRequest("/__yaos/enroll", {
		enrollmentRequestId: "request-origin-aa",
		pairingCodeHash: "e".repeat(64),
		deviceId: "device-origin-aa",
		deviceTokenHash: "f".repeat(64),
		deviceName: "Changed name is ignored on replay",
	}));
	const recoveredBody = await recovered.json() as Record<string, unknown>;
	s.check(recovered.status === 200 && recoveredBody.originImport === true, "lost origin enrollment response replays its original grant");
	s.check(recoveredBody.deviceId === body.deviceId, "enrollment replay returns the same device");
	const replay = await config.fetch(jsonRequest("/__yaos/enroll", {
		enrollmentRequestId: "different-origin-request",
		pairingCodeHash: "e".repeat(64),
		deviceId: "device-origin-replay",
		deviceTokenHash: "a".repeat(64),
		deviceName: "Replay",
	}));
	s.check(replay.status !== 200, "consumed origin pairing cannot grant another importer");
}

await s.done();
