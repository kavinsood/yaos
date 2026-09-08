import { ControlPlaneRuntime, ServerConfig } from "./config";
import { VaultRuntime, VaultSyncServer } from "./server";
import { ActorRecoveryRouteAuthority } from "./recoveryPublicAuthority";
import { handleRecoveryRoute, isPublicRecoveryRouteShape } from "./recoveryRoutes";
import type { VaultRecord } from "./identity";
import { RecoveryJob, RecoveryJobRuntime } from "./recoveryJob";
import { renderMobileSetupPage, renderOperatorConsole, renderOperatorLogin, renderSetupPage } from "./setupPage";
import {
	authorizeAnyDevice,
	authorizeDevice,
	authorizeVaultActor,
	getAuthStateCached,
	getCapabilities,
	getHttpAuthToken,
	handleClaimRoute,
	handleUpdateMetadataRoute,
	rejectUnauthorizedVaultRequest,
	supportsBuckets,
	verifyOperatorSession,
} from "./routes/auth";
import { handleBlobRoute } from "./routes/blobs";
import {
	handleEnrollRoute,
	handleOwnershipTransferRoute,
	handleRevokeCollaborationCodeRoute,
	handleVaultAuditRoute,
	handleVaultCollaborationCodeRoute,
	handleVaultCollaborationCodesListRoute,
	handleVaultCollaborationDeviceRoute,
	handleVaultDeviceLeaveRoute,
	handleVaultDeviceRoute,
	handleVaultDevicesListRoute,
	handleVaultGovernanceRoute,
	handleVaultLeaveRoute,
	handleVaultMeRoute,
	handleVaultMembersRoute,
	handleVaultPairingCodeRoute,
	handleVaultPrincipalDevicesRoute,
	handleVaultPrincipalRoute,
} from "./routes/enroll";
import { corsPreflight, html, json, safeDecodeUriComponent, withCors } from "./routes/http";
import {
	handleOperatorCreateVault,
	handleOperatorDestroyVault,
	handleOperatorEmergencyDestroyVault,
	handleOperatorLogin,
	handleOperatorLogout,
	handleOperatorOwnerCode,
	handleOperatorPairingCode,
	handleOperatorVaultDeletionStatus,
	handleOperatorProvisionVault,
	handleOperatorRenameVault,
	handleOperatorRetryAuthorizationChange,
	handleOperatorRevokeDevice,
	handleOperatorRevokePairing,
	handleOperatorState,
} from "./routes/operator";
import { handleTicketRoute } from "./routes/ticket";
import { handleOperatorVaultRuntimeRoute, handleVaultRuntimeRoute, handleVaultSocketRoute, readVault } from "./routes/vault";
import type { AuthState, AuthStateCached, Env } from "./routes/types";
import { decodeCanonicalVaultIdSegment } from "./vaultId";
import { CloudflareActorCalls, CloudflareObjectStore, CloudflareSocketUpgrades } from "./cloudflarePorts";
import { authorizeVaultAction } from "./collaboration";

interface CloudflareWorkerEnvironment {
	YAOS_SYNC: DurableObjectNamespace;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_RECOVERY_JOBS?: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
	YAOS_TICKET_TTL_MS?: string;
	YAOS_ENABLE_ADMIN_ROUTES?: string;
}

const LOG_PREFIX = "[yaos-sync:worker]";

type WorkerRoute =
	| { kind: "cors-preflight" }
	| { kind: "home" }
	| { kind: "mobile-setup" }
	| { kind: "capabilities" }
	| { kind: "claim" }
	| { kind: "enroll" }
	| { kind: "operator-login" | "operator-logout" | "operator-state" | "operator-pairing" | "operator-vaults" }
	| { kind: "operator-vault-patch" | "operator-vault-destroy" | "operator-vault-emergency-destroy" | "operator-vault-deletion" | "operator-vault-provision" | "operator-owner-code"; id: string }
	| { kind: "operator-authorization-retry"; id: string; changeId: string }
	| { kind: "operator-pairing-revoke" | "operator-revoke"; id: string }
	| { kind: "update-metadata" }
	| { kind: "vault"; vaultId: string; rest: string[] }
	| { kind: "not-found" };

function validVaultRest(method: string, rest: string[]): boolean {
	if (method === "GET" && rest.length === 1 && ["me", "members", "audit"].includes(rest[0]!)) return true;
	if ((method === "PATCH" || method === "DELETE") && rest.length === 1 && rest[0] === "governance") return true;
	if ((method === "POST" || method === "GET") && rest.length === 1 && rest[0] === "invitations") return true;
	if (method === "POST" && rest.length === 1 && ["device-links", "leave"].includes(rest[0]!)) return true;
	if (method === "DELETE" && rest.length === 2 && rest[0] === "invitations" && !!rest[1]) return true;
	if (method === "GET" && rest.length === 3 && rest[0] === "principals" && !!rest[1] && rest[2] === "devices") return true;
	if ((method === "PATCH" || method === "DELETE") && rest.length === 2 && ["principals", "devices"].includes(rest[0]!) && !!rest[1]) return true;
	if (method === "POST" && rest.length === 2 && rest[0] === "ownership" && rest[1] === "transfers") return true;
	if ((method === "POST" || method === "DELETE") && rest.length === 3 && rest[0] === "ownership" && rest[1] === "transfers" && !!rest[2]) return true;
	if (isPublicRecoveryRouteShape(method, rest)) return true;
	if (rest[0] === "settings-sync") {
		if (method === "GET") return rest.length === 2 && rest[1]!.length > 0;
		if (method === "PUT" && rest.length === 3 && rest[1]!.length > 0) {
			return ["seed", "replace", "file", "intent", "tombstone", "plugin-data"].includes(rest[2]!);
		}
		return method === "DELETE" && rest.length === 3 && rest[1]!.length > 0 && rest[2] === "file";
	}
	if (method === "POST" && rest.length === 2 && rest[0] === "auth") {
		return rest[1] === "ticket" || rest[1] === "pairing-code" || rest[1] === "device";
	}
	if (method === "DELETE" && rest.length === 2 && rest[0] === "auth" && rest[1] === "device") return true;
	if (method === "GET" && rest.length === 1 && rest[0] === "devices") return true;
	if (rest[0] === "blobs" && rest.length === 2) return method === "GET" || method === "PUT" || (method === "POST" && rest[1] === "exists");
	if (rest.length === 2 && rest[0] === "debug") {
		return (method === "GET" && rest[1] === "recent") || (method === "POST" && rest[1] === "compact");
	}
	if (method === "GET" && rest.length === 2 && rest[0] === "ws" && rest[1] === "root") return true;
	if (method === "GET" && rest.length === 3 && rest[0] === "ws" && rest[1] === "body" && !!rest[2]) return true;
	if (method === "GET" && rest.length === 3 && rest[0] === "ws" && rest[1] === "semantic" && !!rest[2]) return true;
	if (method === "POST" && rest.length === 3 && rest[0] === "body" && !!rest[1] && rest[2] === "candidate") return true;
	if (method === "POST" && rest.length === 3 && rest[0] === "semantic" && !!rest[1] && rest[2] === "candidate") return true;
	if (method === "POST" && rest.length === 2 && rest[0] === "semantic" && rest[1] === "lifecycle") return true;
	if (method === "POST" && rest.length === 3 && rest[0] === "semantic" && rest[1] === "authority"
		&& (rest[2] === "promote" || rest[2] === "demote")) return true;
	if (method === "GET" && rest.length === 3 && rest[0] === "semantic" && !!rest[1]
		&& (rest[2] === "head" || rest[2] === "state")) return true;
	if (method === "GET" && rest.length === 3 && rest[0] === "operations" && !!rest[1] && rest[2] === "outcome") return true;
	if (method === "GET" && rest.length === 2 && (rest[0] === "body" || rest[0] === "head") && !!rest[1]) return true;
	if (method === "POST" && rest.length === 1 && (rest[0] === "lifecycle" || rest[0] === "catch-up")) return true;
	if (method === "POST" && rest.length === 2 && rest[0] === "lifecycle") return rest[1] === "batch" || rest[1] === "publish";
	if (method === "POST" && rest.length === 2 && rest[0] === "attachments" && rest[1] === "publish") return true;
	if (method === "POST" && rest.length === 2 && rest[0] === "bootstrap" && rest[1] === "start") return true;
	if (rest.length === 3 && rest[0] === "bootstrap" && !!rest[1]) {
		return (method === "GET" && (rest[2] === "root" || rest[2] === "catalog" || rest[2] === "semantic-catalog"))
			|| (method === "POST" && (rest[2] === "bodies" || rest[2] === "renew" || rest[2] === "complete"));
	}
	if (method === "GET" && rest.length === 4 && rest[0] === "bootstrap" && !!rest[1] && rest[2] === "body" && !!rest[3]) return true;
	if (method === "GET" && rest.length === 4 && rest[0] === "bootstrap" && !!rest[1] && rest[2] === "semantic" && !!rest[3]) return true;
	return method === "GET" && rest.length === 1
		&& ["root", "changes", "heads", "status", "health", "diagnostics"].includes(rest[0]!);
}

function parseVault(pathname: string): { vaultId: string; rest: string[] } | null {
	const parts = pathname.split("/").filter(Boolean);
	if (parts.length < 3 || parts[0] !== "vault") return null;
	const vaultId = decodeCanonicalVaultIdSegment(parts[1]!);
	if (!vaultId) return null;
	const rest: string[] = [];
	for (const raw of parts.slice(2)) {
		const value = safeDecodeUriComponent(raw);
		if (value === null || encodeURIComponent(value) !== raw) return null;
		rest.push(value);
	}
	return { vaultId, rest };
}

export function classifyWorkerRoute(request: Request, url = new URL(request.url)): WorkerRoute {
	if (request.method === "OPTIONS" && (url.pathname.startsWith("/vault/") || url.pathname.startsWith("/api/") || url.pathname === "/enroll" || url.pathname.startsWith("/operator/"))) return { kind: "cors-preflight" };
	if (request.method === "GET" && url.pathname === "/") return { kind: "home" };
	if (request.method === "GET" && url.pathname === "/mobile-setup") return { kind: "mobile-setup" };
	if (request.method === "GET" && url.pathname === "/api/capabilities") return { kind: "capabilities" };
	if (request.method === "POST" && url.pathname === "/claim") return { kind: "claim" };
	if (request.method === "POST" && url.pathname === "/enroll") return { kind: "enroll" };
	if (request.method === "POST" && url.pathname === "/api/update-metadata") return { kind: "update-metadata" };
	const fixed: Record<string, WorkerRoute["kind"]> = {
		"POST /operator/login": "operator-login",
		"POST /operator/logout": "operator-logout",
		"GET /operator/state": "operator-state",
		"POST /operator/pairing-codes": "operator-pairing",
		"POST /operator/vaults": "operator-vaults",
	};
	const fixedKind = fixed[`${request.method} ${url.pathname}`];
	if (fixedKind) return { kind: fixedKind } as WorkerRoute;
	const operatorVaultProvision = url.pathname.match(/^\/operator\/vaults\/([^/]+)\/provision$/);
	if (operatorVaultProvision?.[1] && request.method === "POST") {
		const id = safeDecodeUriComponent(operatorVaultProvision[1]);
		return id ? { kind: "operator-vault-provision", id } : { kind: "not-found" };
	}
	const operatorOwnerCode = url.pathname.match(/^\/operator\/vaults\/([^/]+)\/owner-code$/);
	if (operatorOwnerCode?.[1] && request.method === "POST") {
		const id = safeDecodeUriComponent(operatorOwnerCode[1]);
		return id ? { kind: "operator-owner-code", id } : { kind: "not-found" };
	}
	const operatorVaultDeletion = url.pathname.match(/^\/operator\/vaults\/([^/]+)\/deletion$/);
	if (operatorVaultDeletion?.[1] && request.method === "GET") {
		const id = safeDecodeUriComponent(operatorVaultDeletion[1]);
		return id ? { kind: "operator-vault-deletion", id } : { kind: "not-found" };
	}
	const operatorEmergencyDestroy = url.pathname.match(/^\/operator\/vaults\/([^/]+)\/emergency-destroy$/);
	if (operatorEmergencyDestroy?.[1] && request.method === "POST") {
		const id = safeDecodeUriComponent(operatorEmergencyDestroy[1]);
		return id ? { kind: "operator-vault-emergency-destroy", id } : { kind: "not-found" };
	}
	const operatorAuthorizationRetry = url.pathname.match(/^\/operator\/vaults\/([^/]+)\/authorization-changes\/([^/]+)\/retry$/);
	if (operatorAuthorizationRetry?.[1] && operatorAuthorizationRetry[2] && request.method === "POST") {
		const id = safeDecodeUriComponent(operatorAuthorizationRetry[1]);
		const changeId = safeDecodeUriComponent(operatorAuthorizationRetry[2]);
		return id && changeId ? { kind: "operator-authorization-retry", id, changeId } : { kind: "not-found" };
	}
	const operatorVault = url.pathname.match(/^\/operator\/vaults\/([^/]+)$/);
	if (operatorVault?.[1] && (request.method === "PATCH" || request.method === "DELETE")) {
		const id = safeDecodeUriComponent(operatorVault[1]);
		return id ? { kind: request.method === "PATCH" ? "operator-vault-patch" : "operator-vault-destroy", id } : { kind: "not-found" };
	}
	const operatorDevice = url.pathname.match(/^\/operator\/devices\/([^/]+)$/);
	if (operatorDevice?.[1] && request.method === "DELETE") {
		const id = safeDecodeUriComponent(operatorDevice[1]);
		return id ? { kind: "operator-revoke", id } : { kind: "not-found" };
	}
	const operatorPairing = url.pathname.match(/^\/operator\/pairing-codes\/([^/]+)$/);
	if (operatorPairing?.[1] && request.method === "DELETE") {
		const id = safeDecodeUriComponent(operatorPairing[1]);
		return id ? { kind: "operator-pairing-revoke", id } : { kind: "not-found" };
	}
	const vault = parseVault(url.pathname);
	return vault && validVaultRest(request.method, vault.rest) ? { kind: "vault", ...vault } : { kind: "not-found" };
}

function logRequest(route: WorkerRoute, request: Request, response: Response, start: number, auth: string): void {
	if (route.kind === "not-found" && Math.random() >= 0.01) return;
	console.debug("[yaos-worker] request " + JSON.stringify({ route: route.kind, method: request.method, status: response.status,
		durationMs: Date.now() - start, auth, isWebSocket: request.headers.get("upgrade")?.toLowerCase() === "websocket",
		cfRay: request.headers.get("cf-ray") ?? undefined }));
}

async function capabilities(request: Request, env: Env, authState: AuthStateCached): Promise<Response> {
	const includePrivateUpdateMetadata = authState.mode === "claim" && (
		await verifyOperatorSession(env, request) || await authorizeAnyDevice(env, getHttpAuthToken(request))
	);
	return json(getCapabilities(authState, env, authState.config, { includePrivateUpdateMetadata }));
}

async function authorizedVaultControl(request: Request, env: Env, authState: AuthState, vaultId: string): Promise<Response | null> {
	const rejection = await rejectUnauthorizedVaultRequest(request, env, authState, vaultId);
	if (!rejection) return null;
	console.warn(`${LOG_PREFIX} vault rejected pre-auth: ` + JSON.stringify({ vaultIdHint: vaultId.slice(0, 8), reason: rejection.reason, method: request.method }));
	return rejection.response;
}

export async function handleWorkerRequest(request: Request, env: Env): Promise<Response> {
		const start = Date.now();
		const url = new URL(request.url);
		const route = classifyWorkerRoute(request, url);
		if (route.kind === "cors-preflight") return corsPreflight();
		if (route.kind === "not-found") {
			const response = withCors(json({ error: "not found" }, 404));
			logRequest(route, request, response, start, "skipped");
			return response;
		}
		if (route.kind === "operator-logout") return handleOperatorLogout(request, env);
		const authState = await getAuthStateCached(env);
		let response: Response;
		if (route.kind === "home") {
			response = authState.mode === "unsupported"
				? html("<!doctype html><title>YAOS server format unsupported</title><h1>Server format unsupported</h1>")
				: !authState.claimed
					? html(renderSetupPage({ host: url.origin }))
					: await verifyOperatorSession(env, request)
						? html(renderOperatorConsole({
							host: url.origin,
							attachments: supportsBuckets(env),
							snapshots: supportsBuckets(env) && Boolean(env.YAOS_RECOVERY_JOBS),
						}))
						: html(renderOperatorLogin({ host: url.origin }));
		} else if (route.kind === "mobile-setup") response = html(renderMobileSetupPage({ host: url.origin }));
		else if (route.kind === "capabilities") response = withCors(await capabilities(request, env, authState));
		else if (route.kind === "claim") response = await handleClaimRoute(request, env, authState);
		else if (route.kind === "operator-login") response = await handleOperatorLogin(request, env);
		else if (authState.mode === "unsupported") response = withCors(json({ error: "server_format_unsupported" }, 503));
		else if (route.kind === "enroll") response = withCors(await handleEnrollRoute(request, env));
		else if (route.kind === "operator-state") response = await handleOperatorState(request, env);
		else if (route.kind === "operator-pairing") response = await handleOperatorPairingCode(request, env);
		else if (route.kind === "operator-vaults") response = await handleOperatorCreateVault(request, env);
		else if (route.kind === "operator-vault-patch") response = withCors(await handleOperatorRenameVault(request, env, route.id));
		else if (route.kind === "operator-vault-destroy") response = withCors(await handleOperatorDestroyVault(request, env, route.id));
		else if (route.kind === "operator-vault-emergency-destroy") response = withCors(await handleOperatorEmergencyDestroyVault(request, env, route.id));
		else if (route.kind === "operator-authorization-retry") response = withCors(await handleOperatorRetryAuthorizationChange(request, env, route.id, route.changeId));
		else if (route.kind === "operator-vault-deletion") response = withCors(await handleOperatorVaultDeletionStatus(request, env, route.id));
		else if (route.kind === "operator-vault-provision") response = withCors(await handleOperatorProvisionVault(request, env, route.id));
		else if (route.kind === "operator-owner-code") response = withCors(await handleOperatorOwnerCode(request, env, route.id));
		else if (route.kind === "operator-pairing-revoke") response = withCors(await handleOperatorRevokePairing(request, env, route.id));
		else if (route.kind === "operator-revoke") response = withCors(await handleOperatorRevokeDevice(request, env, route.id));
		else if (route.kind === "update-metadata") response = withCors(await handleUpdateMetadataRoute(request, env, authState));
		else if (route.kind === "vault") {
			const runtimePath = `/${route.rest.map(encodeURIComponent).join("/")}`;
			const socket = request.headers.get("upgrade")?.toLowerCase() === "websocket" && route.rest[0] === "ws";
			if (socket) response = await handleVaultSocketRoute(request, env, authState, route.vaultId, runtimePath);
			else if (route.rest[0] === "auth" && route.rest[1] === "ticket") {
				const actor = await authorizeVaultActor(env, getHttpAuthToken(request), route.vaultId);
				response = actor
					? withCors(await handleTicketRoute(request, authState, { ...actor.actor, deviceName: actor.device.name }, json, env))
					: withCors(json({ error: "unauthorized" }, 401));
			} else if (route.rest[0] === "debug" && route.rest[1] === "compact") {
				if (!env.YAOS_ENABLE_ADMIN_ROUTES) response = withCors(json({ error: "not found" }, 404));
				else if (!await verifyOperatorSession(env, request)) response = withCors(json({ error: "unauthorized" }, 401));
				else response = withCors(await handleOperatorVaultRuntimeRoute(request, env, route.vaultId, "/compact"));
			} else {
				if (route.rest[0] === "me") response = withCors(await handleVaultMeRoute(request, env, route.vaultId));
				else if (route.rest[0] === "members") response = withCors(await handleVaultMembersRoute(request, env, route.vaultId));
				else if (route.rest[0] === "audit") response = withCors(await handleVaultAuditRoute(request, env, route.vaultId));
				else if (route.rest[0] === "governance") response = withCors(await handleVaultGovernanceRoute(request, env, route.vaultId));
				else if (route.rest[0] === "invitations" && request.method === "POST") response = withCors(await handleVaultCollaborationCodeRoute(request, env, route.vaultId, "member-invitation"));
				else if (route.rest[0] === "invitations" && request.method === "GET") response = withCors(await handleVaultCollaborationCodesListRoute(request, env, route.vaultId));
				else if (route.rest[0] === "invitations" && route.rest[1]) response = withCors(await handleRevokeCollaborationCodeRoute(request, env, route.vaultId, route.rest[1]));
				else if (route.rest[0] === "device-links") response = withCors(await handleVaultCollaborationCodeRoute(request, env, route.vaultId, "device-link"));
				else if (route.rest[0] === "principals" && route.rest[1] && route.rest[2] === "devices") response = withCors(await handleVaultPrincipalDevicesRoute(request, env, route.vaultId, route.rest[1]));
				else if (route.rest[0] === "principals" && route.rest[1]) response = withCors(await handleVaultPrincipalRoute(request, env, route.vaultId, route.rest[1]));
				else if (route.rest[0] === "devices" && route.rest[1]) response = withCors(await handleVaultCollaborationDeviceRoute(request, env, route.vaultId, route.rest[1]));
				else if (route.rest[0] === "leave") response = withCors(await handleVaultLeaveRoute(request, env, route.vaultId));
				else if (route.rest[0] === "ownership" && route.rest[1] === "transfers") response = withCors(await handleOwnershipTransferRoute(request, env, route.vaultId, route.rest[2]));
				else {
				const authFailure = await authorizedVaultControl(request, env, authState, route.vaultId);
				if (authFailure) response = withCors(authFailure);
				else if (route.rest[0] === "auth" && route.rest[1] === "pairing-code") response = withCors(await handleVaultPairingCodeRoute(request, env, route.vaultId));
				else if (route.rest[0] === "auth" && route.rest[1] === "device" && request.method === "POST") response = withCors(await handleVaultDeviceRoute(request, env, route.vaultId));
				else if (route.rest[0] === "auth" && route.rest[1] === "device") response = withCors(await handleVaultDeviceLeaveRoute(request, env, route.vaultId));
				else if (route.rest[0] === "devices") response = withCors(await handleVaultDevicesListRoute(request, env, route.vaultId));
				else if (route.rest[0] === "recovery") {
					const authorized = await authorizeVaultActor(env, getHttpAuthToken(request), route.vaultId);
					const recoveryDecision = authorized
						? authorizeVaultAction(authorized.actor, "vault.recovery.manage")
						: null;
					if (!authorized) {
						response = withCors(json({ error: "unauthorized" }, 401));
					} else if (!recoveryDecision?.allowed) {
						response = withCors(json({ error: recoveryDecision?.reason ?? "capability_missing" }, 403));
					} else if (!env.YAOS_BUCKET || !env.YAOS_RECOVERY_JOBS) {
						response = withCors(json({
							error: "recovery_unavailable",
							storageAvailable: Boolean(env.YAOS_BUCKET),
							jobsAvailable: Boolean(env.YAOS_RECOVERY_JOBS),
						}, 503));
					} else {
						let vault: VaultRecord | null;
						try {
							vault = await readVault(env, route.vaultId);
						} catch {
							vault = null;
						}
						if (!vault || vault.state !== "active") {
							response = withCors(json({ error: vault ? `vault_${vault.state}` : "vault_authority_unavailable" }, 503));
						} else {
							const authority = new ActorRecoveryRouteAuthority(
								env.YAOS_SYNC,
								vault.vaultId,
								vault.vaultId,
								vault.vaultGeneration,
								authorized.actor,
							);
							response = withCors(await handleRecoveryRoute(request, route.rest, {
								vaultId: vault.vaultId,
								authority,
								bucket: env.YAOS_BUCKET,
							}));
						}
					}
				}
				else if (route.rest[0] === "blobs") response = withCors(await handleBlobRoute(env, route.vaultId, request, route.rest.slice(1), json));
				else if (route.rest[0] === "debug" && route.rest[1] === "recent") response = withCors(await handleVaultRuntimeRoute(request, env, route.vaultId, "/diagnostics"));
				else response = withCors(await handleVaultRuntimeRoute(request, env, route.vaultId, runtimePath));
				}
			}
		}
		else response = withCors(json({ error: "not found" }, 404));
		logRequest(route, request, response, start, authState.mode);
		return response;
}

const worker = {
	fetch(request: Request, env: CloudflareWorkerEnvironment): Promise<Response> {
		return handleWorkerRequest(request, {
			...env,
			YAOS_SYNC: new CloudflareActorCalls(env.YAOS_SYNC),
			YAOS_CONFIG: new CloudflareActorCalls(env.YAOS_CONFIG),
			YAOS_RECOVERY_JOBS: env.YAOS_RECOVERY_JOBS ? new CloudflareActorCalls(env.YAOS_RECOVERY_JOBS) : undefined,
			YAOS_BUCKET: env.YAOS_BUCKET ? new CloudflareObjectStore(env.YAOS_BUCKET) : undefined,
			socketUpgrades: new CloudflareSocketUpgrades(),
		});
	},
};
export { ControlPlaneRuntime, RecoveryJob, RecoveryJobRuntime, ServerConfig, VaultRuntime, VaultSyncServer };
export type {
	ActorCallPort,
	AlarmPort,
	ControlPlaneStoragePort,
	DrainPort,
	ExecutionPort,
	ObjectStorePort,
	RecoveryRuntimeStoragePort,
	SocketUpgradePort,
	VaultRuntimeStoragePort,
} from "./platformPorts";
export type { VaultRuntimeOptions } from "./server";
export type { RecoveryJobRuntimeOptions } from "./recoveryJob";
export type { SocketServiceOptions, VaultSocketPort, VaultSocketRegistryPort } from "./vaultSocketService";
export type { Env as WorkerRuntimeEnvironment } from "./routes/types";
export default worker;
