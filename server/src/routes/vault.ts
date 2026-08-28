import {
	MAX_CANDIDATE_BYTES,
	MAX_CATCH_UP_BYTES,
	MAX_JSON_BYTES,
} from "../contracts";
import {
	MAX_SETTINGS_ITEM_REQUEST_BYTES,
	MAX_SETTINGS_SNAPSHOT_REQUEST_BYTES,
} from "../settingsSyncStore";
import { BoundedBodyError, readBoundedBytes } from "../readBoundedBytes";
import { SERVER_PROTOCOL_VERSION, SERVER_SCHEMA_VERSION } from "../version";
import type { VaultRecord } from "../identity";
import { inspectTicket } from "./ticket";
import { authorizeDevice, configFetch, getHttpAuthToken } from "./auth";
import type { AuthState, Env } from "./types";

export const TRUSTED_DEVICE_HEADER = "x-yaos-device-id";

export async function readVault(env: Env, vaultId: string): Promise<VaultRecord | null> {
	const url = new URL("https://internal/__yaos/vault");
	url.searchParams.set("vaultId", vaultId);
	const response = await configFetch(env, `${url.pathname}${url.search}`);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`vault authority failed (${response.status})`);
	const body = await response.json<{ vault?: VaultRecord }>();
	return body.vault ?? null;
}


function forwardedBodyLimit(request: Request, runtimePath: string): number | null {
	if (!request.body || request.method === "GET" || request.method === "HEAD") return null;
	if (/^\/body\/[^/]+\/candidate$/.test(runtimePath)) return MAX_CANDIDATE_BYTES;
	if (runtimePath === "/catch-up") return MAX_CATCH_UP_BYTES;
	if (runtimePath.startsWith("/settings-sync/") && request.method === "PUT") {
		const action = runtimePath.split("/")[3];
		return action === "seed" || action === "replace"
			? MAX_SETTINGS_SNAPSHOT_REQUEST_BYTES
			: MAX_SETTINGS_ITEM_REQUEST_BYTES;
	}
	return MAX_JSON_BYTES;
}

async function forward(env: Env, vault: VaultRecord, request: Request, runtimePath: string, deviceId?: string): Promise<Response> {
	const url = new URL(request.url);
	url.pathname = runtimePath;
	const headers = new Headers(request.headers);
	headers.set("x-yaos-vault-id", vault.vaultId);
	headers.set("x-yaos-vault-generation", vault.vaultGeneration);
	headers.delete("authorization");
	headers.delete("x-yaos-device-id");
	if (deviceId) headers.set(TRUSTED_DEVICE_HEADER, deviceId);
	const init: RequestInit = { method: request.method, headers };
	const maximumBodyBytes = forwardedBodyLimit(request, runtimePath);
	if (maximumBodyBytes !== null) {
		try {
			const bytes = await readBoundedBytes(request, maximumBodyBytes, { allowEmpty: true });
			if (bytes.byteLength > 0) {
				const owned = new Uint8Array(bytes.byteLength);
				owned.set(bytes);
				init.body = owned.buffer;
			}
		} catch (error) {
			const kind = error instanceof BoundedBodyError ? error.kind : "body_read_failed";
			return Response.json(
				{ error: kind },
				{ status: kind === "body_too_large" ? 413 : 400, headers: { "cache-control": "no-store" } },
			);
		}
	}
	return env.YAOS_SYNC.call(vault.vaultId, new Request(url, init));
}

export async function closeVaultDeviceSockets(
	env: Env,
	vaultId: string,
	deviceId: string,
): Promise<number> {
	const vault = await readVault(env, vaultId);
	if (!vault) return 0;
	const response = await env.YAOS_SYNC.call(vaultId, new Request("https://internal/__yaos/revoke-device-sockets", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-yaos-vault-id": vaultId,
			"x-yaos-vault-generation": vault.vaultGeneration,
		},
		body: JSON.stringify({ deviceId }),
	}));
	if (!response.ok) throw new Error(`device socket revocation failed (${response.status})`);
	const body = await response.json<{ closed?: unknown }>();
	return typeof body.closed === "number" && Number.isSafeInteger(body.closed) && body.closed >= 0
		? body.closed
		: 0;
}


function rejectSocket(request: Request, env: Env, code: "unclaimed" | "unauthorized" | "update_required", details: Record<string, unknown> = {}): Response {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return Response.json({ error: code, ...details }, { status: code === "unauthorized" ? 401 : code === "update_required" ? 426 : 503 });
	}
	const frame = `__YPS:${JSON.stringify({ type: "error", code, ...details })}`;
	return env.socketUpgrades.reject(frame, 1008, code === "update_required" ? "update required" : code);
}

function declaredVersion(url: URL, name: string): number | null {
	const raw = url.searchParams.get(name);
	if (raw === null || raw.trim() === "") return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function handleVaultSocketRoute(
	request: Request,
	env: Env,
	authState: AuthState,
	vaultId: string,
	runtimePath: string,
): Promise<Response> {
	if (!authState.claimed) return rejectSocket(request, env, "unclaimed");
	const url = new URL(request.url);
	const ticket = url.searchParams.get("ticket");
	const payload = ticket ? await inspectTicket(ticket, authState, vaultId) : null;
	if (!payload) return rejectSocket(request, env, "unauthorized");
	const membership = await configFetch(env, "/__yaos/verify-device", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vaultId, deviceId: payload.deviceId }),
	});
	if (!membership.ok) return rejectSocket(request, env, "unauthorized");
	const schemaVersion = declaredVersion(url, "schemaVersion");
	if (schemaVersion !== SERVER_SCHEMA_VERSION) return rejectSocket(request, env, "update_required", {
		reason: "schema_mismatch", clientSchemaVersion: schemaVersion, serverSchemaVersion: SERVER_SCHEMA_VERSION,
	});
	const protocolVersion = declaredVersion(url, "protocolVersion");
	if (protocolVersion !== SERVER_PROTOCOL_VERSION) return rejectSocket(request, env, "update_required", {
		reason: "protocol_mismatch", clientProtocolVersion: protocolVersion, serverProtocolVersion: SERVER_PROTOCOL_VERSION,
	});
	let vault: VaultRecord | null;
	try { vault = await readVault(env, vaultId); } catch { return rejectSocket(request, env, "unauthorized"); }
	if (!vault || vault.state !== "active") return rejectSocket(request, env, "unauthorized");
	return forward(env, vault, request, runtimePath, payload.deviceId);
}

export async function handleVaultRuntimeRoute(
	request: Request,
	env: Env,
	vaultId: string,
	runtimePath: string,
): Promise<Response> {
	let vault: VaultRecord | null;
	try { vault = await readVault(env, vaultId); }
	catch { return Response.json({ error: "vault_authority_unavailable" }, { status: 503 }); }
	if (!vault) return Response.json({ error: "unknown_vault" }, { status: 404 });
	if (vault.state !== "active") return Response.json({ error: `vault_${vault.state}` }, { status: 409 });
	const device = await authorizeDevice(env, getHttpAuthToken(request), vaultId);
	if (!device) return Response.json({ error: "unauthorized" }, { status: 401 });
	return forward(env, vault, request, runtimePath, device.deviceId);
}

export async function handleOperatorVaultRuntimeRoute(
	request: Request,
	env: Env,
	vaultId: string,
	runtimePath: string,
): Promise<Response> {
	let vault: VaultRecord | null;
	try {
		vault = await readVault(env, vaultId);
	} catch {
		return Response.json({ error: "vault_authority_unavailable" }, { status: 503 });
	}
	if (!vault) return Response.json({ error: "unknown_vault" }, { status: 404 });
	if (vault.state !== "active") return Response.json({ error: `vault_${vault.state}` }, { status: 409 });
	return forward(env, vault, request, runtimePath);
}
