import { randomBase64Url } from "../base64url";
import { PAIRING_CODE_BYTES, hashSecret, randomSecret } from "../identity";
import type { VaultRecord } from "../identity";
import type { PendingDestroyRecord } from "../config";
import { ActorRecoveryJobExecutor, type RecoveryJobStatus } from "../recoveryExecutor";
import { RECOVERY_RPC_HEADER, vaultGenerationPrefix } from "../recoveryProtocol";
import { buildMobileSetupUrl } from "../setupQr";
import {
	buildObsidianPairingUrl,
	clearOperatorCookieHeader,
	configFetch,
	createOperatorSession,
	readOperatorSessionToken,
	readConsoleState,
	verifyOperatorSession,
} from "./auth";
import { json } from "./http";
import { provisionReservedVault } from "./provisioning";
import type { Env } from "./types";
import { attemptPendingDeviceRevocation, isPendingDeviceRevocation, settleAuthorizationChange } from "./enroll";
import { readVault } from "./vault";

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
	if (!state) return json({ error: "config_unavailable" }, 500);
	const pending = state.pendingDeviceRevocations.find((record) => record.deviceId === deviceId);
	if (pending) return attemptPendingDeviceRevocation(env, pending);
	const target = state.devices.find((device) => device.deviceId === deviceId);
	if (!target) return json({ error: "unknown_device" }, 404);
	const response = await configFetch(env, "/__yaos/revoke-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceId }),
	});
	const payload = await response.json().catch(() => null) as { error?: string; revocation?: unknown } | null;
	if (!response.ok) return json({ error: payload?.error ?? "revoke_failed" }, response.status);
	if (!isPendingDeviceRevocation(payload?.revocation)) {
		return json({ error: "revoke_response_invalid" }, 502);
	}
	return attemptPendingDeviceRevocation(env, payload.revocation);
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
	return json({
		error: "collaboration_authority_required",
		message: "Invite people and link personal devices from an enrolled vault. Operators may only issue owner bootstrap or recovery codes.",
	}, 409);
}

export async function handleOperatorOwnerCode(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	let body: { purpose?: unknown };
	try { body = await req.json(); } catch { body = {}; }
	const purpose = body.purpose === "owner-recovery" ? "owner-recovery" : "owner-bootstrap";
	const pairingCode = randomSecret(PAIRING_CODE_BYTES);
	const response = await configFetch(env, "/__yaos/collaboration/operator-code", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId, purpose, codeHash: await hashSecret(pairingCode) }),
	});
	const payload = await response.json().catch(() => null) as { error?: string; code?: { codeId?: string; expiresAt?: number } } | null;
	if (!response.ok || !payload?.code?.codeId || !Number.isSafeInteger(payload.code.expiresAt)) {
		return json({ error: payload?.error ?? "owner_code_failed" }, response.ok ? 502 : response.status);
	}
	const origin = new URL(req.url).origin;
	return json({ ok: true, codeId: payload.code.codeId, pairingCode, expiresAt: payload.code.expiresAt, purpose, obsidianUrl: buildObsidianPairingUrl(origin, pairingCode), mobileSetupUrl: buildMobileSetupUrl(origin, pairingCode) });
}

export async function handleOperatorCollaborationMigration(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	let body: Record<string, unknown>;
	try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
	const migrationRequest = {
		vaultId,
		ownerDeviceIds: body.ownerDeviceIds,
		ownerDisplayName: body.ownerDisplayName,
	};
	const prepared = await configFetch(env, "/__yaos/collaboration/migrate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(migrationRequest),
	});
	const preparation = await prepared.json().catch(() => null) as {
		error?: string;
		ownerPrincipalId?: string;
		change?: {
			changeId?: string;
			vaultGeneration?: string;
			requestDigest?: string;
			subjectDigest?: string;
			subjects?: unknown[];
		};
	} | null;
	if (!prepared.ok || !preparation?.ownerPrincipalId || !preparation.change?.changeId
		|| !preparation.change.vaultGeneration || !preparation.change.requestDigest
		|| !preparation.change.subjectDigest || !Array.isArray(preparation.change.subjects)) {
		return json({ error: preparation?.error ?? "collaboration_migration_prepare_failed" }, prepared.ok ? 502 : prepared.status);
	}
	let migrated: Response;
	try {
		migrated = await env.YAOS_SYNC.call(vaultId, new Request("https://internal/__yaos/collaboration-migrate", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-yaos-vault-id": vaultId,
				"x-yaos-vault-generation": preparation.change.vaultGeneration,
			},
			body: JSON.stringify({
				migrationId: preparation.change.changeId,
				vaultGeneration: preparation.change.vaultGeneration,
				requestDigest: preparation.change.requestDigest,
				subjectDigest: preparation.change.subjectDigest,
				ownerPrincipalId: preparation.ownerPrincipalId,
				subjects: preparation.change.subjects,
			}),
		}));
	} catch (error) {
		const message = error instanceof Error ? error.message : "vault runtime unavailable";
		await configFetch(env, "/__yaos/collaboration/fail-change", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ changeId: preparation.change.changeId, lastError: message }),
		}).catch(() => null);
		return json({ error: "collaboration_migration_vault_unavailable", repairable: true,
			migrationId: preparation.change.changeId }, 503);
	}
	const receipt = await migrated.json().catch(() => null) as Record<string, unknown> | null;
	if (!migrated.ok || !receipt) {
		const error = typeof receipt?.error === "string" ? receipt.error : "collaboration_migration_vault_failed";
		await configFetch(env, "/__yaos/collaboration/fail-change", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ changeId: preparation.change.changeId, lastError: error }),
		}).catch(() => null);
		return json({ error,
			repairable: true, migrationId: preparation.change.changeId }, migrated.ok ? 502 : migrated.status);
	}
	let completed: Response;
	try {
		completed = await configFetch(env, "/__yaos/collaboration/migrate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...migrationRequest, receipt }),
		});
	} catch {
		return json({ error: "collaboration_migration_finalize_unavailable", repairable: true,
			migrationId: preparation.change.changeId }, 503);
	}
	const completion = await completed.json().catch(() => null) as Record<string, unknown> | null;
	if (!completed.ok) {
		const error = typeof completion?.error === "string" ? completion.error : "collaboration_migration_finalize_failed";
		await configFetch(env, "/__yaos/collaboration/fail-change", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ changeId: preparation.change.changeId, lastError: error }),
		}).catch(() => null);
		return json({ error, repairable: true, migrationId: preparation.change.changeId }, completed.status);
	}
	return json(completion);
}

export async function handleOperatorCanvasMigration(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const vault = await readVault(env, vaultId).catch(() => null);
	if (!vault) return json({ error: "unknown_vault" }, 404);
	try {
		const response = await env.YAOS_SYNC.call(vaultId, new Request("https://internal/__yaos/canvas-migrate", {
			method: "POST",
			headers: { "x-yaos-vault-id": vaultId, "x-yaos-vault-generation": vault.vaultGeneration },
		}));
		const body = await response.json().catch(() => null);
		return json(body ?? { error: "canvas_migration_invalid_response" }, response.status);
	} catch {
		return json({ error: "canvas_migration_vault_unavailable", repairable: true }, 503);
	}
}

export async function handleOperatorRenameVault(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const state = await readConsoleState(env);
	if (!state) return json({ error: "config_unavailable" }, 500);
	if (state.memberships.some((membership) => membership.vaultId === vaultId)) {
		return json({
			error: "collaboration_authority_required",
			message: "An enrolled vault owner must rename this vault.",
		}, 409);
	}
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
			const fenced = await env.YAOS_SYNC.call(vaultId, new Request("https://internal/__yaos/begin-vault-deletion", {
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
			}));
			if (!fenced.ok && fenced.status !== 410) throw new Error(`deletion fence returned HTTP ${fenced.status}`);
			if (!env.YAOS_BUCKET) {
				r2Complete = true;
				purgeState = "complete";
			} else if (!env.YAOS_RECOVERY_JOBS) {
				throw new Error("recovery job binding unavailable");
			} else {
				const recoveryJobs = env.YAOS_RECOVERY_JOBS;
				const executor = new ActorRecoveryJobExecutor(recoveryJobs);
				let status: RecoveryJobStatus | null;
				try {
					status = await executor.getStatus(pending.purgeJobId);
				} catch {
					status = null;
				}
				if (status?.state === "failed" || status?.state === "cancelled") {
					const reset = await recoveryJobs.call(pending.purgeJobId, new Request("https://internal/__yaos/recovery-job/delete-state", {
						method: "POST",
						headers: {
							[RECOVERY_RPC_HEADER]: "1",
							"x-yaos-vault-id": vaultId,
							"x-yaos-vault-generation": pending.vaultGeneration,
						},
					}));
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
				: await env.YAOS_SYNC.call(vaultId, new Request(
					"https://internal/__yaos/delete-all",
					{
						method: "POST",
						headers: {
							"x-yaos-vault-id": vaultId,
							"x-yaos-vault-generation": pending.vaultGeneration,
						},
					},
				));
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
	let body: { governanceRequestId?: unknown };
	try { body = await req.json(); } catch { body = {}; }
	if (typeof body.governanceRequestId !== "string" || !body.governanceRequestId) {
		return json({ error: "destroy_confirmation_required", message: "Confirm a durable owner destruction request." }, 409);
	}
	const confirmed = await configFetch(env, "/__yaos/collaboration/operator-confirm-destroy", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId, governanceRequestId: body.governanceRequestId }),
	});
	const confirmation = await confirmed.json().catch(() => null) as { error?: string; governanceRequest?: { state?: string } } | null;
	if (!confirmed.ok) return json({ error: confirmation?.error ?? "destroy_confirmation_failed" }, confirmed.status);
	if (confirmation?.governanceRequest?.state === "complete") return json({ ok: true, completed: true, replayed: true });
	return executeConfirmedVaultDestroy(env, vaultId, body.governanceRequestId);
}

async function executeConfirmedVaultDestroy(env: Env, vaultId: string, governanceRequestId: string): Promise<Response> {
	let registry: Response;
	try {
		registry = await configFetch(env, "/__yaos/destroy-vault", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ vaultId, governanceRequestId }),
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
		return env.YAOS_SYNC.call(vaultId, new Request("https://internal/__yaos/delete-all", {
			method: "POST",
			headers: {
				"x-yaos-vault-id": vaultId,
				"x-yaos-vault-generation": registryPayload.pending!.vaultGeneration,
			},
		}));
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

export async function handleOperatorEmergencyDestroyVault(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	let body: { requestId?: unknown; reason?: unknown };
	try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
	const prepared = await configFetch(env, "/__yaos/collaboration/operator-emergency-destroy", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId, requestId: body.requestId, reason: body.reason }),
	});
	const payload = await prepared.json().catch(() => null) as { error?: string; governanceRequest?: { governanceRequestId?: string; state?: string } } | null;
	if (!prepared.ok || !payload?.governanceRequest?.governanceRequestId) {
		return json({ error: payload?.error ?? "emergency_destroy_prepare_failed" }, prepared.ok ? 502 : prepared.status);
	}
	if (payload.governanceRequest.state === "complete") return json({ ok: true, completed: true, replayed: true });
	return executeConfirmedVaultDestroy(env, vaultId, payload.governanceRequest.governanceRequestId);
}

export async function handleOperatorRetryAuthorizationChange(req: Request, env: Env, vaultId: string, changeId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	const pending = await configFetch(env, "/__yaos/collaboration/pending-changes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ vaultId }),
	});
	const payload = await pending.json().catch(() => null) as { changes?: import("../collaborationIdentity").AuthorizationChangeRecord[]; error?: string } | null;
	if (!pending.ok) return json({ error: payload?.error ?? "authorization_changes_unavailable" }, pending.status);
	const change = payload?.changes?.find((record) => record.changeId === changeId && record.vaultId === vaultId);
	if (!change) return json({ error: "authorization_change_missing" }, 404);
	return await settleAuthorizationChange(env, change)
		? json({ ok: true, changeId })
		: json({ ok: false, error: "authorization_fence_pending", changeId }, 202);
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
