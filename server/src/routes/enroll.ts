import type { PendingDeviceRevocationRecord } from "../config";
import { hashSecret } from "../identity";
import { buildMobileSetupUrl, renderSetupQrDataUrl } from "../setupQr";
import {
	authorizeDevice,
	buildObsidianPairingUrl,
	configFetch,
	getHttpAuthToken,
	mintPairingCode,
	readConsoleState,
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
	) {
		return json({ error: "enroll_response_invalid" }, 502);
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
	});
}

export async function handleVaultPairingCodeRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	if (!(await authorizeDevice(env, getHttpAuthToken(req), vaultId))) return json({ error: "unauthorized" }, 401);
	let body: { purpose?: string };
	try {
		body = await req.json();
	} catch {
		body = {};
	}
	const purpose = body.purpose === "invite" ? "invite" : "device";
	const minted = await mintPairingCode(env, vaultId, purpose);
	if ("error" in minted) return json({ error: minted.error }, minted.status);
	const origin = new URL(req.url).origin;
	let mobileSetupQrDataUrl: string | null = null;
	try {
		mobileSetupQrDataUrl = await renderSetupQrDataUrl(buildMobileSetupUrl(origin, minted.pairingCode));
	} catch {
		// The plain pairing code and URL remain usable.
	}
	return json({
		pairingCode: minted.pairingCode,
		expiresAt: minted.exp,
		purpose,
		obsidianUrl: buildObsidianPairingUrl(origin, minted.pairingCode),
		mobileSetupUrl: buildMobileSetupUrl(origin, minted.pairingCode),
		mobileSetupQrDataUrl,
	});
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
	if (!(await authorizeDevice(env, getHttpAuthToken(req), vaultId))) return json({ error: "unauthorized" }, 401);
	const state = await readConsoleState(env);
	return json({ devices: (state?.devices ?? []).filter((device) => device.vaultId === vaultId) });
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
	const device = await authorizeDevice(env, getHttpAuthToken(req), vaultId);
	if (!device) return json({ error: "unauthorized" }, 401);
	const response = await configFetch(env, "/__yaos/revoke-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceId: device.deviceId }),
	});
	const payload = await response.json().catch(() => null) as { error?: string; revocation?: unknown } | null;
	if (!response.ok) return json({ error: payload?.error ?? "leave_failed" }, response.status);
	if (!isPendingDeviceRevocation(payload?.revocation)) {
		return json({ error: "leave_response_invalid" }, 502);
	}
	return attemptPendingDeviceRevocation(env, payload.revocation);
}
