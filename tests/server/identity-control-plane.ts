/**
 * Multivault auth gates: reserved vault ids, device rename, operator-only
 * metadata, and snapshot-maybe room header.
 */
import ServerConfig from "../../server/src/config";
import { hashSecret, isUsableVaultId, OPERATOR_COOKIE } from "../../server/src/identity";
import { handleUpdateMetadataRoute, invalidateStoredServerConfigCache } from "../../server/src/routes/auth";
import { handleVaultDeviceRoute } from "../../server/src/routes/enroll";
import type { AuthState } from "../../server/src/routes/types";
import worker from "../../server/src/index";
import { makeConfigNamespace, makeEnv } from "../mocks/workerEnv.ts";
import { readSource, suite } from "../harness.ts";

const s = suite("identity-control-plane");

const CLAIM_AUTH: AuthState = {
	mode: "claim",
	claimed: true,
	operatorRecoveryHash: "a".repeat(64),
	ticketSigningKey: "ticket-signing-key-for-tests",
};

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
		pairingCodeHash: "pair-hash",
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	s.check(claim.status === 200, "claim succeeds with usable vaultId");

	const enrolled = await config.fetch(jsonRequest("/__yaos/enroll", {
		pairingCodeHash: "pair-hash",
		deviceId: "dev-1",
		deviceTokenHash: "tok-hash",
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
	await config.fetch(jsonRequest("/__yaos/claim", {
		operatorRecoveryHash: "op-hash",
		ticketSigningKey: "sign-key",
		vaultId,
		vaultName: "Personal",
		pairingCodeHash: "pair-hash",
		pairingExp: Date.now() + 60_000,
		pairingPurpose: "device",
	}));
	await config.fetch(jsonRequest("/__yaos/enroll", {
		pairingCodeHash: "pair-hash",
		deviceId: "dev-live",
		deviceTokenHash: "tok-hash",
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

	await config.fetch(jsonRequest("/__yaos/revoke-device", { deviceId: "dev-live" }));
	const revoked = await config.fetch(jsonRequest("/__yaos/verify-device", {
		deviceId: "dev-live",
		vaultId,
	}));
	s.check(revoked.status === 401, "revoked device is 401");
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
		configFormat: 1,
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

	const workerDevice = await worker.fetch(new Request("https://example.test/api/update-metadata", {
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

await s.done();
