import { randomBase64Url } from "../base64url";
import { hashSecret } from "../identity";
import type { VaultRecord } from "../identity";
import type { PendingDestroyRecord } from "../config";
import { CloudflareRecoveryJobExecutor, type RecoveryJobStatus } from "../recoveryExecutor";
import { RECOVERY_RPC_HEADER, vaultGenerationPrefix } from "../recoveryProtocol";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../setupQr";
import {
	buildObsidianPairingUrl,
	clearOperatorCookieHeader,
	configFetch,
	createOperatorSession,
	mintPairingCode,
	readOperatorSessionToken,
	readConsoleState,
	verifyOperatorSession,
} from "./auth";
import { json } from "./http";
import { provisionReservedVault } from "./provisioning";
import type { Env } from "./types";
import { closeVaultDeviceSockets, readVault } from "./vault";

async function requireOperator(req: Request, env: Env): Promise<Response | null> {
	return await verifyOperatorSession(env, req)
		? null
		: json({ error: "unauthorized", message: "Operator session required." }, 401);
}

export async function handleOperatorLogin(req: Request, env: Env): Promise<Response> {
	let body: { operatorRecoveryKey?: string };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const operatorRecoveryKey = typeof body.operatorRecoveryKey === "string" ? body.operatorRecoveryKey.trim() : "";
	if (operatorRecoveryKey.length < 32) return json({ error: "invalid operatorRecoveryKey" }, 400);
	const verified = await configFetch(env, "/__yaos/verify-operator", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ operatorRecoveryHash: await hashSecret(operatorRecoveryKey) }),
	});
	if (!verified.ok) {
		return json({ error: "unauthorized", message: "That recovery key does not match this server." }, 401);
	}
	const session = await createOperatorSession(env, req.url);
	const response = json({ ok: true });
	const headers = new Headers(response.headers);
	headers.append("Set-Cookie", session.header);
	return new Response(response.body, { status: response.status, headers });
}

export async function handleOperatorLogout(req: Request, env: Env): Promise<Response> {
	const token = readOperatorSessionToken(req);
	let response: Response;
	if (!token) {
		response = json({ ok: true });
	} else {
		try {
			const revoked = await configFetch(env, "/__yaos/revoke-session", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionHash: await hashSecret(token) }),
			});
			if (revoked.ok) {
				response = json({ ok: true });
			} else {
				const payload = await revoked.json().catch(() => null) as { error?: string } | null;
				response = json(
					{ error: payload?.error ?? "session_revoke_failed" },
					revoked.status,
				);
			}
		} catch {
			response = json({ error: "session_revoke_failed" }, 503);
		}
	}
	const headers = new Headers(response.headers);
	headers.append("Set-Cookie", clearOperatorCookieHeader(req.url));
	return new Response(response.body, { status: response.status, headers });
}

export async function handleOperatorState(req: Request, env: Env): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const state = await readConsoleState(env);
	return state ? json({ ok: true, ...state }) : json({ error: "config_unavailable" }, 500);
}

export async function handleOperatorRevokeDevice(req: Request, env: Env, deviceId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const state = await readConsoleState(env);
	const target = state?.devices.find((device) => device.deviceId === deviceId);
	if (!target) return json({ error: "unknown_device" }, 404);
	const response = await configFetch(env, "/__yaos/revoke-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceId }),
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null) as { error?: string } | null;
		return json({ error: payload?.error ?? "revoke_failed" }, response.status);
	}
	try {
		const closedSockets = await closeVaultDeviceSockets(env, target.vaultId, target.deviceId);
		return json({ ok: true, membershipRevoked: true, socketsClosed: true, closedSockets });
	} catch {
		return json({ ok: false, membershipRevoked: true, socketsClosed: false, closedSockets: 0 }, 202);
	}
}

export async function handleOperatorCreateVault(req: Request, env: Env): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	let body: { name?: string };
	try {
		body = await req.json();
	} catch {
		body = {};
	}
	const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Vault";
	const response = await configFetch(env, "/__yaos/create-vault", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId: randomBase64Url(16), name }),
	});
	const payload = await response.json().catch(() => null) as { error?: string; vault?: VaultRecord } | null;
	if (!response.ok || !payload?.vault) {
		return json({ error: payload?.error ?? "create_failed" }, response.status);
	}
	const provisioned = await provisionReservedVault(env, payload.vault);
	if (!provisioned.ok) return provisioned;
	const activation = await provisioned.json().catch(() => null) as { vault?: unknown } | null;
	return json({ ok: true, vault: activation?.vault ?? null });
}

export async function handleOperatorProvisionVault(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const vault = await readVault(env, vaultId);
	if (!vault) return json({ error: "unknown_vault" }, 404);
	if (vault.state === "active") return json({ ok: true, vault });
	return provisionReservedVault(env, vault);
}

export async function handleOperatorPairingCode(req: Request, env: Env): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	let body: { vaultId?: string; purpose?: string };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const vaultId = typeof body.vaultId === "string" ? body.vaultId.trim() : "";
	if (!vaultId) return json({ error: "invalid vaultId" }, 400);
	const purpose = body.purpose === "invite" ? "invite" : "device";
	const minted = await mintPairingCode(env, vaultId, purpose);
	if ("error" in minted) return json({ error: minted.error }, minted.status);
	const origin = new URL(req.url).origin;
	let mobileSetupQrDataUrl: string | null = null;
	try {
		mobileSetupQrDataUrl = await renderSetupQrDataUrl(buildMobileSetupUrl(origin, minted.pairingCode));
	} catch {
		// The plain URL remains usable.
	}
	return json({
		ok: true,
		pairingCode: minted.pairingCode,
		expiresAt: minted.exp,
		purpose,
		obsidianUrl: buildObsidianPairingUrl(origin, minted.pairingCode),
		mobileSetupUrl: buildMobileSetupUrl(origin, minted.pairingCode),
		mobileSetupQrDataUrl,
	});
}

export async function handleOperatorRenameVault(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	let body: { name?: unknown };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (name.length < 1 || name.length > 80) return json({ error: "invalid name" }, 400);
	const response = await configFetch(env, "/__yaos/rename-vault", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId, name }),
	});
	const payload = await response.json().catch(() => null) as { error?: string; vault?: unknown } | null;
	return response.ok
		? json({ ok: true, vault: payload?.vault ?? null })
		: json({ error: payload?.error ?? "rename_failed" }, response.status);
}

function cleanupError(scope: "room" | "purge", error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `${scope}: ${message}`.slice(0, 256);
}

export async function attemptVaultCleanup(
	env: Env,
	vaultId: string,
	pending: PendingDestroyRecord,
	fetchRoom?: () => Promise<Response>,
): Promise<PendingDestroyRecord> {
	let roomComplete = pending.roomComplete;
	let r2Complete = pending.r2Complete;
	let purgeState = pending.purgeState;
	let capabilityHash = pending.capabilityHash;
	let capabilityExpiresAt = pending.capabilityExpiresAt;
	let deletedObjects = pending.deletedObjects;
	let deletedBytes = pending.deletedBytes;
	const errors: string[] = [];

	if (!r2Complete) {
		try {
			const room = env.YAOS_SYNC.get(env.YAOS_SYNC.idFromName(vaultId));
			const fenced = await room.fetch("https://internal/__yaos/begin-vault-deletion", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-yaos-vault-id": vaultId,
					"x-yaos-vault-generation": pending.vaultGeneration,
				},
				body: JSON.stringify({
					deletionId: pending.deletionId,
					vaultGeneration: pending.vaultGeneration,
				}),
			});
			if (!fenced.ok && fenced.status !== 410) throw new Error(`deletion fence returned HTTP ${fenced.status}`);
			if (!env.YAOS_BUCKET) {
				r2Complete = true;
				purgeState = "complete";
			} else if (!env.YAOS_RECOVERY_JOBS) {
				throw new Error("recovery job binding unavailable");
			} else {
				const executor = new CloudflareRecoveryJobExecutor(env.YAOS_RECOVERY_JOBS);
				let status: RecoveryJobStatus | null;
				try {
					status = await executor.getStatus(pending.purgeJobId);
				} catch {
					status = null;
				}
				if (status?.state === "failed" || status?.state === "cancelled") {
					const jobs = env.YAOS_RECOVERY_JOBS;
					const job = jobs.get(jobs.idFromName(pending.purgeJobId));
					const reset = await job.fetch("https://internal/__yaos/recovery-job/delete-state", {
						method: "POST",
						headers: {
							[RECOVERY_RPC_HEADER]: "1",
							"x-yaos-vault-id": vaultId,
							"x-yaos-vault-generation": pending.vaultGeneration,
						},
					});
					if (!reset.ok) throw new Error(`purge reset returned HTTP ${reset.status}`);
					status = null;
				}
				if (!status) {
					const capability = randomBase64Url(32);
					capabilityHash = await hashSecret(capability);
					capabilityExpiresAt = Date.now() + 7 * 24 * 60 * 60_000;
					const admitted = await configFetch(env, "/__yaos/update-destroy-vault", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							vaultId,
							roomComplete,
							r2Complete,
							purgeState: "queued",
							capabilityHash,
							capabilityExpiresAt,
							deletedObjects,
							deletedBytes,
							lastError: null,
						}),
					});
					if (!admitted.ok) throw new Error(`purge admission persistence returned HTTP ${admitted.status}`);
					const prefix = vaultGenerationPrefix(vaultId, pending.vaultGeneration);
					await executor.startPurge({
						vaultId,
						vaultGeneration: pending.vaultGeneration,
						createdAt: pending.requestedAt,
						capability,
						capabilityExpiresAt,
						allowedPrefixes: [`${prefix}/recovery-v2/`, `${prefix}/blobs/`],
						deletionId: pending.deletionId,
					});
					status = await executor.getStatus(pending.purgeJobId);
				}
				purgeState = status.state === "complete" ? "complete"
					: status.state === "failed" || status.state === "cancelled" ? "failed"
						: status.state === "retrying" ? "retrying"
							: status.state === "queued" ? "queued" : "purging";
				deletedObjects = Math.max(deletedObjects, status.deletedObjects);
				deletedBytes = Math.max(deletedBytes, status.deletedBytes);
				r2Complete = status.state === "complete";
				if (status.state === "failed" || status.state === "cancelled") {
					errors.push(`purge: ${status.error?.code ?? status.state}`);
				}
			}
		} catch (error) {
			errors.push(cleanupError("purge", error));
		}
	}

	if (r2Complete && !roomComplete) {
		try {
			const response = fetchRoom
				? await fetchRoom()
				: await env.YAOS_SYNC.get(env.YAOS_SYNC.idFromName(vaultId)).fetch(
					"https://internal/__yaos/delete-all",
					{
						method: "POST",
						headers: {
							"x-yaos-vault-id": vaultId,
							"x-yaos-vault-generation": pending.vaultGeneration,
						},
					},
				);
			if (response.ok) roomComplete = true;
			else errors.push(`room: delete-all returned HTTP ${response.status}`);
		} catch (error) {
			errors.push(cleanupError("room", error));
		}
	}

	return {
		...pending,
		roomComplete,
		r2Complete,
		purgeState,
		capabilityHash,
		capabilityExpiresAt,
		deletedObjects,
		deletedBytes,
		lastError: errors.length > 0 ? errors.join("; ").slice(0, 512) : null,
	};
}

export async function handleOperatorDestroyVault(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	let registry: Response;
	try {
		registry = await configFetch(env, "/__yaos/destroy-vault", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ vaultId }),
		});
	} catch {
		return json({ error: "destroy_registry_unavailable" }, 503);
	}
	if (!registry.ok) {
		const payload = await registry.json().catch(() => null) as { error?: string } | null;
		return json({ error: payload?.error ?? "destroy_failed" }, registry.status);
	}
	const registryPayload = await registry.json().catch(() => null) as {
		pending?: PendingDestroyRecord;
	} | null;
	if (!registryPayload?.pending) return json({ error: "destroy_state_unavailable" }, 502);
	const cleanup = await attemptVaultCleanup(env, vaultId, registryPayload.pending, async () => {
		const room = env.YAOS_SYNC.get(env.YAOS_SYNC.idFromName(vaultId));
		return room.fetch("https://internal/__yaos/delete-all", {
			method: "POST",
			headers: {
				"x-yaos-vault-id": vaultId,
				"x-yaos-vault-generation": registryPayload.pending!.vaultGeneration,
			},
		});
	});
	let updated: Response;
	try {
		updated = await configFetch(env, "/__yaos/update-destroy-vault", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				vaultId,
				roomComplete: cleanup.roomComplete,
				r2Complete: cleanup.r2Complete,
				purgeState: cleanup.purgeState,
				capabilityHash: cleanup.capabilityHash,
				capabilityExpiresAt: cleanup.capabilityExpiresAt,
				deletedObjects: cleanup.deletedObjects,
				deletedBytes: cleanup.deletedBytes,
				lastError: cleanup.lastError,
			}),
		});
	} catch {
		return json({ ok: false, pending: cleanup, error: "cleanup_state_update_failed" }, 202);
	}
	if (cleanup.roomComplete && cleanup.r2Complete && updated.status === 200) {
		return json({ ok: true, completed: true });
	}
	const updatePayload = await updated.json().catch(() => null) as {
		error?: string;
		pending?: PendingDestroyRecord;
	} | null;
	return json({
		ok: false,
		pending: updatePayload?.pending ?? cleanup,
		error: updatePayload?.error ?? cleanup.lastError ?? "destroy_pending",
	}, 202);
}

export async function handleOperatorVaultDeletionStatus(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const state = await readConsoleState(env);
	if (!state) return json({ error: "config_unavailable" }, 503);
	const pending = state.pendingDestroys.find((record) => record.vaultId === vaultId);
	if (!pending) return json({ error: "deletion_not_found" }, 404);
	return json({ pending });
}

export async function handleOperatorRevokePairing(req: Request, env: Env, codeId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const response = await configFetch(env, "/__yaos/revoke-pairing", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ codeId }),
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null) as { error?: string } | null;
		return json({ error: payload?.error ?? "revoke_failed" }, response.status);
	}
	return json({ ok: true });
}
