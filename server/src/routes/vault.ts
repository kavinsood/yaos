import { SERVER_PROTOCOL_VERSION, SERVER_SCHEMA_VERSION } from "../version";
import type { VaultRecord } from "../identity";
import { inspectTicket } from "./ticket";
import { authorizeDevice, configFetch, getHttpAuthToken } from "./auth";
import type { AuthState, Env, VaultRuntimeStubPort } from "./types";

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

function stub(env: Env, vaultId: string): VaultRuntimeStubPort {
	return env.YAOS_SYNC.get(env.YAOS_SYNC.idFromName(vaultId));
}

function forward(env: Env, vault: VaultRecord, request: Request, runtimePath: string, deviceId?: string): Promise<Response> {
	const url = new URL(request.url);
	url.pathname = runtimePath;
	const headers = new Headers(request.headers);
	headers.set("x-yaos-vault-id", vault.vaultId);
	headers.set("x-yaos-vault-generation", vault.vaultGeneration);
	headers.delete("authorization");
	headers.delete("x-yaos-device-id");
	if (deviceId) headers.set(TRUSTED_DEVICE_HEADER, deviceId);
	const init: RequestInit = { method: request.method, headers };
	if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
	return stub(env, vault.vaultId).fetch(new Request(url, init));
}

export async function closeVaultDeviceSockets(
	env: Env,
	vaultId: string,
	deviceId: string,
): Promise<number> {
	const vault = await readVault(env, vaultId);
	if (!vault) return 0;
	const response = await stub(env, vaultId).fetch("https://internal/__yaos/revoke-device-sockets", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-yaos-vault-id": vaultId,
			"x-yaos-vault-generation": vault.vaultGeneration,
		},
		body: JSON.stringify({ deviceId }),
	});
	if (!response.ok) throw new Error(`device socket revocation failed (${response.status})`);
	const body = await response.json<{ closed?: unknown }>();
	return typeof body.closed === "number" && Number.isSafeInteger(body.closed) && body.closed >= 0
		? body.closed
		: 0;
}


function rejectSocket(request: Request, code: "unclaimed" | "unauthorized" | "update_required", details: Record<string, unknown> = {}): Response {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return Response.json({ error: code, ...details }, { status: code === "unauthorized" ? 401 : code === "update_required" ? 426 : 503 });
	}
	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	server.accept();
	server.send(`__YPS:${JSON.stringify({ type: "error", code, ...details })}`);
	server.close(1008, code === "update_required" ? "update required" : code);
	return new Response(null, { status: 101, webSocket: client });
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
	if (!authState.claimed) return rejectSocket(request, "unclaimed");
	const url = new URL(request.url);
	const ticket = url.searchParams.get("ticket");
	const payload = ticket ? await inspectTicket(ticket, authState, vaultId) : null;
	if (!payload) return rejectSocket(request, "unauthorized");
	const membership = await configFetch(env, "/__yaos/verify-device", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ vaultId, deviceId: payload.deviceId }),
	});
	if (!membership.ok) return rejectSocket(request, "unauthorized");
	const schemaVersion = declaredVersion(url, "schemaVersion");
	if (schemaVersion !== SERVER_SCHEMA_VERSION) return rejectSocket(request, "update_required", {
		reason: "schema_mismatch", clientSchemaVersion: schemaVersion, serverSchemaVersion: SERVER_SCHEMA_VERSION,
	});
	const protocolVersion = declaredVersion(url, "protocolVersion");
	if (protocolVersion !== SERVER_PROTOCOL_VERSION) return rejectSocket(request, "update_required", {
		reason: "protocol_mismatch", clientProtocolVersion: protocolVersion, serverProtocolVersion: SERVER_PROTOCOL_VERSION,
	});
	let vault: VaultRecord | null;
	try { vault = await readVault(env, vaultId); } catch { return rejectSocket(request, "unauthorized"); }
	if (!vault || vault.state !== "active") return rejectSocket(request, "unauthorized");
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
