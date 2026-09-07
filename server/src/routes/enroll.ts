import type { PendingDeviceRevocationRecord } from "../config";
import { PAIRING_CODE_BYTES, hashSecret, randomSecret } from "../identity";
import type { VaultRole, VaultCapability, VaultActorContext } from "../collaboration";
import type { AuthorizationChangeRecord, PrincipalRecord } from "../collaborationIdentity";
import { buildMobileSetupUrl } from "../setupQr";
import {
	authorizeDevice,
	authorizeVaultActor,
	buildObsidianPairingUrl,
	configFetch,
	getHttpAuthToken,
} from "./auth";
import { json } from "./http";
import type { Env } from "./types";
import { closeVaultDeviceSockets, readVault } from "./vault";

export async function handleEnrollRoute(req: Request, env: Env): Promise<Response> {
	let body: {
		pairingCode?: string;
		enrollmentRequestId?: string;
		deviceId?: string;
		deviceToken?: string;
		deviceName?: string;
	};
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const pairingCode = typeof body.pairingCode === "string" ? body.pairingCode.trim() : "";
	if (
		pairingCode.length < 8 || pairingCode.length > 512
		|| typeof body.enrollmentRequestId !== "string"
		|| !/^[A-Za-z0-9_-]{16,128}$/.test(body.enrollmentRequestId)
		|| typeof body.deviceId !== "string"
		|| !/^[A-Za-z0-9_-]{16,128}$/.test(body.deviceId)
		|| typeof body.deviceToken !== "string"
		|| !/^[A-Za-z0-9_-]{32,256}$/.test(body.deviceToken)
	) {
		return json({ error: "invalid enrollment request" }, 400);
	}
	const enrollmentRequestId = body.enrollmentRequestId;
	const deviceId = body.deviceId;
	const deviceToken = body.deviceToken;
	const response = await configFetch(env, "/__yaos/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			enrollmentRequestId,
			pairingCodeHash: await hashSecret(pairingCode),
			deviceId,
			deviceTokenHash: await hashSecret(deviceToken),
			deviceName: typeof body.deviceName === "string" ? body.deviceName : "",
		}),
	});
	const payload = await response.json().catch(() => null) as {
		error?: string;
		message?: string;
		vaultId?: string;
		vaultGeneration?: string;
		deviceId?: string;
		deviceName?: string;
		originImport?: boolean;
		principalId?: string;
		role?: VaultRole;
		membershipRevision?: number;
		deviceCredentialRevision?: number;
		capabilities?: VaultCapability[];
		change?: AuthorizationChangeRecord;
		principal?: PrincipalRecord;
		actor?: VaultActorContext;
	} | null;
	if (!response.ok) {
		return json({
			error: payload?.error ?? "enroll_failed",
			message: payload?.message ?? "Could not enroll this device.",
		}, response.status);
	}
	if (
		typeof payload?.vaultId !== "string" || !payload.vaultId.trim()
		|| typeof payload.vaultGeneration !== "string" || !payload.vaultGeneration.trim()
		|| payload.deviceId !== deviceId
		|| typeof payload.deviceName !== "string" || !payload.deviceName.trim()
		|| typeof payload.originImport !== "boolean"
		|| typeof payload.principalId !== "string" || !payload.principalId
		|| (payload.role !== "owner" && payload.role !== "member")
		|| !Number.isSafeInteger(payload.membershipRevision) || payload.membershipRevision! < 1
		|| !Number.isSafeInteger(payload.deviceCredentialRevision) || payload.deviceCredentialRevision! < 1
		|| !Array.isArray(payload.capabilities)
		|| !payload.principal || payload.principal.principalId !== payload.principalId
		|| !payload.actor || payload.actor.principalId !== payload.principalId || payload.actor.deviceId !== deviceId
	) {
		return json({ error: "enroll_response_invalid" }, 502);
	}
	if (!payload.change || !await settleAuthorizationChange(env, payload.change)) {
		return json({ error: "authorization_fence_pending", changeId: payload.change?.changeId ?? null }, 202);
	}
	const host = new URL(req.url).origin;
	return json({
		host,
		deviceToken,
		vaultId: payload.vaultId,
		deviceId,
		deviceName: payload.deviceName,
		vaultGeneration: payload.vaultGeneration,
		originImport: payload.originImport,
		principalId: payload.principalId,
		role: payload.role,
		membershipRevision: payload.membershipRevision,
		deviceCredentialRevision: payload.deviceCredentialRevision,
		capabilities: payload.capabilities,
		principal: payload.principal,
		actor: payload.actor,
	});
}

export async function settleAuthorizationChange(env: Env, change: AuthorizationChangeRecord): Promise<boolean> {
	try {
		const fenced = await env.YAOS_SYNC.call(change.vaultId, new Request("https://internal/__yaos/authority-fence", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-yaos-vault-id": change.vaultId,
				"x-yaos-vault-generation": change.vaultGeneration,
			},
			body: JSON.stringify({
				changeId: change.changeId,
				vaultId: change.vaultId,
				vaultGeneration: change.vaultGeneration,
				subjectDigest: change.subjectDigest,
				subjects: change.subjects,
			}),
		}));
		if (!fenced.ok) throw new Error(`vault authorization fence returned ${fenced.status}`);
		const receipt = await fenced.json().catch(() => null) as { changeId?: string; vaultGeneration?: string; subjectDigest?: string } | null;
		if (receipt?.changeId !== change.changeId || receipt.vaultGeneration !== change.vaultGeneration || receipt.subjectDigest !== change.subjectDigest) {
			throw new Error("vault authorization fence returned an invalid receipt");
		}
		const completed = await configFetch(env, "/__yaos/collaboration/complete-change", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ changeId: change.changeId, vaultId: change.vaultId, vaultGeneration: change.vaultGeneration }),
		});
		if (!completed.ok) throw new Error(`authorization change completion returned ${completed.status}`);
		return true;
	} catch (error) {
		await configFetch(env, "/__yaos/collaboration/fail-change", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ changeId: change.changeId, lastError: error instanceof Error ? error.message : "vault authorization fence failed" }),
		}).catch(() => undefined);
		return false;
	}
}

async function collaborationRequest(
	req: Request,
	env: Env,
	vaultId: string,
	path: string,
	body: Record<string, unknown> = {},
): Promise<Response> {
	const authorized = await authorizeVaultActor(env, getHttpAuthToken(req), vaultId);
	if (!authorized) return json({ error: "unauthorized" }, 401);
	const response = await configFetch(env, `/__yaos/collaboration/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			vaultId,
			principalId: authorized.principal.principalId,
			deviceId: authorized.device.deviceId,
			...body,
		}),
	});
	if (response.status !== 202) return response;
	const payload = await response.clone().json().catch(() => null) as { change?: AuthorizationChangeRecord } | null;
	if (!payload?.change) return response;
	return await settleAuthorizationChange(env, payload.change)
		? json({ ...payload, ok: true, pending: false })
		: json({ ...payload, error: "authorization_fence_pending", pending: true }, 202);
}

async function readObjectBody(req: Request): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await req.json();
		return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

export function handleVaultMeRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	return collaborationRequest(req, env, vaultId, "me");
}

export function handleVaultMembersRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	return collaborationRequest(req, env, vaultId, "members");
}

export function handleVaultCollaborationCodesListRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	return collaborationRequest(req, env, vaultId, "codes");
}

export function handleVaultPrincipalDevicesRoute(req: Request, env: Env, vaultId: string, targetPrincipalId: string): Promise<Response> {
	return collaborationRequest(req, env, vaultId, "devices", { targetPrincipalId });
}

export function handleVaultAuditRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	return collaborationRequest(req, env, vaultId, "audit");
}

export async function handleVaultGovernanceRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const body = await readObjectBody(req);
	if (!body) return json({ error: "invalid json" }, 400);
	if (req.method === "PATCH") {
		return collaborationRequest(req, env, vaultId, "rename-vault", { name: body.name, requestId: body.requestId });
	}
	return collaborationRequest(req, env, vaultId, "request-destroy", { requestId: body.requestId });
}

export async function handleVaultCollaborationCodeRoute(
	req: Request,
	env: Env,
	vaultId: string,
	purpose: "member-invitation" | "device-link",
): Promise<Response> {
	const secret = randomSecret(PAIRING_CODE_BYTES);
	const response = await collaborationRequest(req, env, vaultId, "create-code", {
		purpose,
		codeHash: await hashSecret(secret),
	});
	if (!response.ok) return response;
	const payload = await response.json().catch(() => null) as { code?: { codeId?: string; expiresAt?: number } } | null;
	if (!payload?.code?.codeId || !Number.isSafeInteger(payload.code.expiresAt)) return json({ error: "code_response_invalid" }, 502);
	const origin = new URL(req.url).origin;
	return json({
		codeId: payload.code.codeId,
		pairingCode: secret,
		expiresAt: payload.code.expiresAt,
		purpose,
		obsidianUrl: buildObsidianPairingUrl(origin, secret),
		mobileSetupUrl: buildMobileSetupUrl(origin, secret),
	});
}

export function handleRevokeCollaborationCodeRoute(req: Request, env: Env, vaultId: string, codeId: string): Promise<Response> {
	return collaborationRequest(req, env, vaultId, "revoke-code", { codeId });
}

export async function handleVaultPrincipalRoute(req: Request, env: Env, vaultId: string, targetPrincipalId: string): Promise<Response> {
	if (req.method === "DELETE") {
		const body = await readObjectBody(req) ?? {};
		return collaborationRequest(req, env, vaultId, "revoke-member", { targetPrincipalId, requestId: body.requestId });
	}
	const body = await readObjectBody(req);
	if (!body) return json({ error: "invalid json" }, 400);
	return collaborationRequest(req, env, vaultId, "rename-principal", { targetPrincipalId, displayName: body.displayName, requestId: typeof body.requestId === "string" ? body.requestId : randomSecret(16) });
}

export async function handleVaultCollaborationDeviceRoute(req: Request, env: Env, vaultId: string, targetDeviceId: string): Promise<Response> {
	const body = await readObjectBody(req) ?? {};
	if (req.method === "DELETE") return collaborationRequest(req, env, vaultId, "revoke-device", { targetDeviceId, requestId: body.requestId });
	return collaborationRequest(req, env, vaultId, "rename-device", { targetDeviceId, name: body.name });
}

export async function handleOwnershipTransferRoute(req: Request, env: Env, vaultId: string, transferId?: string): Promise<Response> {
	const body = await readObjectBody(req) ?? {};
	if (!transferId) return collaborationRequest(req, env, vaultId, "create-transfer", { targetPrincipalId: body.targetPrincipalId });
	if (req.method === "DELETE") return collaborationRequest(req, env, vaultId, "cancel-transfer", { transferId });
	return collaborationRequest(req, env, vaultId, "accept-transfer", { transferId, requestId: body.requestId });
}

export async function handleVaultLeaveRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const authorized = await authorizeVaultActor(env, getHttpAuthToken(req), vaultId);
	if (!authorized) return json({ error: "unauthorized" }, 401);
	const body = await readObjectBody(req) ?? {};
	return collaborationRequest(req, env, vaultId, "revoke-member", {
		targetPrincipalId: authorized.principal.principalId,
		requestId: body.requestId,
	});
}

export async function handleVaultPairingCodeRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	let body: { purpose?: string };
	try {
		body = await req.json();
	} catch {
		body = {};
	}
	return handleVaultCollaborationCodeRoute(
		req,
		env,
		vaultId,
		body.purpose === "invite" ? "member-invitation" : "device-link",
	);
}

export async function handleVaultDeviceRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const device = await authorizeDevice(env, getHttpAuthToken(req), vaultId);
	if (!device) return json({ error: "unauthorized" }, 401);
	let body: { name?: unknown };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (name.length < 1 || name.length > 50) return json({ error: "invalid name" }, 400);
	const response = await configFetch(env, "/__yaos/rename-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceId: device.deviceId, name }),
	});
	const payload = await response.json().catch(() => null) as { error?: string; device?: unknown } | null;
	return response.ok
		? json({ device: payload?.device ?? null })
		: json({ error: payload?.error ?? "rename_failed" }, response.status);
}

export async function handleVaultDevicesListRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const authorized = await authorizeVaultActor(env, getHttpAuthToken(req), vaultId);
	if (!authorized) return json({ error: "unauthorized" }, 401);
	return collaborationRequest(req, env, vaultId, "devices", { targetPrincipalId: authorized.principal.principalId });
}

export function isPendingDeviceRevocation(value: unknown): value is PendingDeviceRevocationRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.vaultId === "string"
		&& typeof record.vaultGeneration === "string"
		&& typeof record.deviceId === "string"
		&& Number.isSafeInteger(record.requestedAt)
		&& (record.lastError === null || typeof record.lastError === "string");
}

export async function attemptPendingDeviceRevocation(
	env: Env,
	revocation: PendingDeviceRevocationRecord,
): Promise<Response> {
	let closedSockets = 0;
	let socketsClosed = false;
	try {
		const vault = await readVault(env, revocation.vaultId);
		if (!vault || vault.vaultGeneration !== revocation.vaultGeneration) {
			throw new Error("vault generation is unavailable for the revocation fence");
		}
		closedSockets = await closeVaultDeviceSockets(env, revocation.vaultId, revocation.deviceId);
		socketsClosed = true;
		const completed = await configFetch(env, "/__yaos/complete-device-revocation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				vaultId: revocation.vaultId,
				vaultGeneration: revocation.vaultGeneration,
				deviceId: revocation.deviceId,
			}),
		});
		if (!completed.ok && completed.status !== 404) {
			throw new Error(`revocation acknowledgement failed (${completed.status})`);
		}
		return json({
			ok: true,
			membershipRevoked: true,
			revocationPending: false,
			socketsClosed: true,
			closedSockets,
		});
	} catch (error) {
		const lastError = error instanceof Error ? error.message : "vault runtime revocation fence failed";
		await configFetch(env, "/__yaos/fail-device-revocation", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				vaultId: revocation.vaultId,
				vaultGeneration: revocation.vaultGeneration,
				deviceId: revocation.deviceId,
				lastError,
			}),
		}).catch(() => undefined);
		return json({
			ok: false,
			membershipRevoked: true,
			revocationPending: true,
			socketsClosed,
			closedSockets,
			lastError,
		}, 202);
	}
}

export async function handleVaultDeviceLeaveRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const authorized = await authorizeVaultActor(env, getHttpAuthToken(req), vaultId);
	if (!authorized) return json({ error: "unauthorized" }, 401);
	const body = await readObjectBody(req) ?? {};
	return collaborationRequest(req, env, vaultId, "revoke-device", {
		targetDeviceId: authorized.device.deviceId,
		requestId: typeof body.requestId === "string" ? body.requestId : randomSecret(16),
	});
}
