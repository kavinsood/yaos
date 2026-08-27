import { getServerByName } from "partyserver";
import { randomBase64Url } from "../base64url";
import { hashSecret } from "../identity";
import type { PendingDestroyRecord } from "../config";
import { deleteVaultPrefix } from "../snapshot";
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
import type { Env } from "./types";

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
	const response = await configFetch(env, "/__yaos/revoke-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceId }),
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null) as { error?: string } | null;
		return json({ error: payload?.error ?? "revoke_failed" }, response.status);
	}
	return json({ ok: true });
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
	const payload = await response.json().catch(() => null) as { error?: string; vault?: unknown } | null;
	return response.ok
		? json({ ok: true, vault: payload?.vault ?? null })
		: json({ error: payload?.error ?? "create_failed" }, response.status);
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

function cleanupError(scope: "room" | "r2", error: unknown): string {
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
	const errors: string[] = [];

	if (!roomComplete) {
		try {
			const response = fetchRoom
				? await fetchRoom()
				: await (await getServerByName(env.YAOS_SYNC, vaultId))
					.fetch("https://internal/__yaos/delete-all", { method: "POST" });
			if (response.ok) {
				roomComplete = true;
			} else {
				errors.push(`room: delete-all returned HTTP ${response.status}`);
			}
		} catch (error) {
			errors.push(cleanupError("room", error));
		}
	}

	if (!r2Complete) {
		if (!env.YAOS_BUCKET) {
			r2Complete = true;
		} else {
			try {
				await deleteVaultPrefix(env.YAOS_BUCKET, vaultId);
				r2Complete = true;
			} catch (error) {
				errors.push(cleanupError("r2", error));
			}
		}
	}

	return {
		...pending,
		roomComplete,
		r2Complete,
		lastError: errors.length > 0 ? errors.join("; ").slice(0, 512) : null,
	};
}

export async function handleOperatorDestroyVault(req: Request, env: Env, vaultId: string): Promise<Response> {
	const denied = await requireOperator(req, env);
	if (denied) return denied;
	// Revoke registry membership and persist the cleanup obligation before
	// touching either physical store. Repeating this request resumes that record.
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
	if (!registryPayload?.pending) {
		return json({ error: "destroy_state_unavailable" }, 502);
	}

	const cleanup = await attemptVaultCleanup(env, vaultId, registryPayload.pending);
	let updated: Response;
	try {
		updated = await configFetch(env, "/__yaos/update-destroy-vault", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				vaultId,
				roomComplete: cleanup.roomComplete,
				r2Complete: cleanup.r2Complete,
				lastError: cleanup.lastError,
			}),
		});
	} catch {
		return json({
			ok: false,
			pending: cleanup,
			error: "cleanup_state_update_failed",
		}, 202);
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
