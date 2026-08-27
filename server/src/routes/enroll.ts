import { randomBase64Url } from "../base64url";
import { DEVICE_TOKEN_BYTES, hashSecret, randomSecret } from "../identity";
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

export async function handleEnrollRoute(req: Request, env: Env): Promise<Response> {
	let body: { pairingCode?: string; deviceName?: string };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}
	const pairingCode = typeof body.pairingCode === "string" ? body.pairingCode.trim() : "";
	if (pairingCode.length < 8) return json({ error: "invalid pairing code" }, 400);
	const deviceId = randomBase64Url(16);
	const deviceToken = randomSecret(DEVICE_TOKEN_BYTES);
	const response = await configFetch(env, "/__yaos/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
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
		deviceId?: string;
		deviceName?: string;
	} | null;
	if (!response.ok) {
		return json({
			error: payload?.error ?? "enroll_failed",
			message: payload?.message ?? "Could not enroll this device.",
		}, response.status);
	}
	if (
		typeof payload?.vaultId !== "string" || !payload.vaultId.trim()
		|| typeof payload.deviceId !== "string" || !payload.deviceId.trim()
		|| typeof payload.deviceName !== "string" || !payload.deviceName.trim()
	) {
		return json({ error: "enroll_response_invalid" }, 502);
	}
	const host = new URL(req.url).origin;
	return json({
		host,
		deviceToken,
		vaultId: payload.vaultId,
		deviceId: payload.deviceId,
		deviceName: payload.deviceName,
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

export async function handleVaultDeviceLeaveRoute(req: Request, env: Env, vaultId: string): Promise<Response> {
	const device = await authorizeDevice(env, getHttpAuthToken(req), vaultId);
	if (!device) return json({ error: "unauthorized" }, 401);
	const response = await configFetch(env, "/__yaos/revoke-device", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ deviceId: device.deviceId }),
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null) as { error?: string } | null;
		return json({ error: payload?.error ?? "leave_failed" }, response.status);
	}
	return json({ ok: true });
}
