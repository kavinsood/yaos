import { VaultRuntime } from "../../server/src/server";
import { VaultStore } from "../../server/src/vaultStore";
import { ControlPlaneRuntime } from "../../server/src/config";
import { SqlControlPlaneStorage, type ControlPlaneSqlHost } from "../../server/src/controlPlaneSql";
import { CloudflareAlarmPort, CloudflareExecutionPort, CloudflareSocketRegistry, CloudflareSocketUpgrades, reciprocateSocketClose } from "../../server/src/cloudflarePorts";
import type { ActorCallPort, VaultRuntimeStoragePort } from "../../server/src/platformPorts";
import type { AuthState, Env } from "../../server/src/routes/types";
import { handleVaultSocketRoute } from "../../server/src/routes/vault";
import { createTicket, inspectTicket } from "../../server/src/routes/ticket";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext } from "../../server/src/collaboration";
import { SERVER_PROTOCOL_VERSION, SERVER_SCHEMA_VERSION } from "../../server/src/version";

interface ProbeEnvironment {
	R2_PROBE_TOKEN: string;
	PROBE_VAULTS: DurableObjectNamespace;
	PROBE_CONFIG: DurableObjectNamespace;
}

const cases = ["valid", "rotation-active", "generation-mismatch", "mirror-absent", "mirror-absent-unavailable",
	"mirror-absent-stale", "partial-mirror", "rollout-deleting"] as const;
type ProbeCase = typeof cases[number];
const auth: AuthState = { mode: "claim", claimed: true, operatorRecoveryHash: "isolated-r2-probe-only",
	ticketSigningKey: "isolated-r2-probe-only-fixed-signing-key-not-a-production-secret" };

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function secretAvailable(env: ProbeEnvironment): boolean {
	return typeof env.R2_PROBE_TOKEN === "string" && /^[A-Za-z0-9_+/=-]{32,1024}$/.test(env.R2_PROBE_TOKEN);
}

function internalRequest(request: Request, env: ProbeEnvironment): Request {
	const headers = new Headers(request.headers);
	headers.set("x-r2-probe-secret", env.R2_PROBE_TOKEN);
	return new Request(request, { headers });
}

function internalAuthorized(request: Request, env: ProbeEnvironment): boolean {
	return secretAvailable(env) && request.headers.get("x-r2-probe-secret") === env.R2_PROBE_TOKEN;
}

function post(path: string, body: unknown, env: ProbeEnvironment, vaultId?: string, generation?: string): Request {
	const headers = new Headers({ "content-type": "application/json", "x-r2-probe-secret": env.R2_PROBE_TOKEN });
	if (vaultId) headers.set("x-yaos-vault-id", vaultId);
	if (generation) headers.set("x-yaos-vault-generation", generation);
	return new Request(`https://internal${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function actor(vaultId: string, generation: string, role: "owner" | "member"): Promise<VaultActorContext> {
	return { vaultId, vaultGeneration: generation, principalId: `${role}-principal`, deviceId: `${role}-device`,
		membershipRevision: 1, deviceCredentialRevision: 1, role, policyVersion: COLLABORATION_POLICY_VERSION,
		capabilityDigest: await capabilityDigestForRole(role) };
}

export class R2ProbeConfig {
	private readonly storage: SqlControlPlaneStorage;
	private readonly runtime: ControlPlaneRuntime;

	constructor(state: DurableObjectState, private readonly env: ProbeEnvironment) {
		this.storage = new SqlControlPlaneStorage(state.storage as unknown as ControlPlaneSqlHost, "global-config");
		this.runtime = new ControlPlaneRuntime(this.storage);
	}

	async fetch(request: Request): Promise<Response> {
		if (!internalAuthorized(request, this.env)) return json({ error: "unauthorized" }, 401);
		if (request.method === "POST" && new URL(request.url).pathname === "/__probe/seed") {
			const body = await request.json<{ vaultId: string; generation: string; scenario: ProbeCase }>();
			const principals = await Promise.all([actor(body.vaultId, body.generation, "owner"), actor(body.vaultId, body.generation, "member")]);
			await this.storage.put("vaults", [{ vaultId: body.vaultId, vaultGeneration: body.generation,
				name: "Isolated R2 probe", state: body.scenario === "rollout-deleting" ? "deleting" : "active",
				createdAt: 1, provisionedAt: 1, ownerPrincipalId: principals[0]!.principalId }]);
			await this.storage.put("principals", principals.map((entry) => ({ principalId: entry.principalId, vaultId: body.vaultId,
				displayName: entry.principalId, colorSeed: entry.principalId, createdAt: 1, updatedAt: 1 })));
			await this.storage.put("vaultMemberships", principals.map((entry) => ({ vaultId: body.vaultId, principalId: entry.principalId,
				role: entry.role, state: "active", revision: 1, invitedByPrincipalId: null, joinedAt: 1, updatedAt: 1, revokedAt: null })));
			await this.storage.put("devices", principals.map((entry) => ({ vaultId: body.vaultId, principalId: entry.principalId, deviceId: entry.deviceId,
				tokenHash: (entry.role === "owner" ? "a" : "b").repeat(64), name: entry.deviceId, enrolledAt: 1, revokedAt: null,
				credentialRevision: entry.role === "member" && ["rotation-active", "mirror-absent-stale"].includes(body.scenario) ? 2 : 1, state: "active" })));
			await this.storage.put("probe-unavailable", body.scenario === "mirror-absent-unavailable");
			return json({ seeded: true });
		}
		if (await this.storage.get("probe-unavailable")) return json({ error: "probe_authority_unavailable" }, 503);
		return this.runtime.fetch(request);
	}
}

export class R2ProbeVault {
	private readonly store: VaultStore;
	private readonly runtime: VaultRuntime;

	constructor(private readonly state: DurableObjectState, private readonly env: ProbeEnvironment) {
		this.store = new VaultStore(state.storage as unknown as VaultRuntimeStoragePort);
		const controlPlane: ActorCallPort = { call: async (_name, request) => {
			const metadata = this.store.vaultMetadata();
			if (!metadata) return json({ error: "probe_not_initialized" }, 503);
			const calls = await state.storage.get<string[]>("probe-calls") ?? [];
			if (calls.length >= 12) return json({ error: "probe_call_limit" }, 503);
			calls.push(new URL(request.url).pathname);
			await state.storage.put("probe-calls", calls);
			return env.PROBE_CONFIG.get(env.PROBE_CONFIG.idFromName(metadata.vaultId)).fetch(internalRequest(request, env));
		} };
		this.runtime = new VaultRuntime({ storage: state.storage as unknown as VaultRuntimeStoragePort,
			sockets: new CloudflareSocketRegistry(state), alarms: new CloudflareAlarmPort(state.storage),
			execution: new CloudflareExecutionPort(state), controlPlane });
	}

	async fetch(request: Request): Promise<Response> {
		if (!internalAuthorized(request, this.env)) return json({ error: "unauthorized" }, 401);
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path === "/__probe/init") return this.initialize(request);
		if (request.method === "GET" && path === "/__probe/stats") return this.stats();
		const response = await this.runtime.fetch(request);
		if (response.status === 101) {
			const accepted = await this.state.storage.get<number>("probe-accepted") ?? 0;
			await this.state.storage.put("probe-accepted", accepted + 1);
		}
		return response;
	}

	private async initialize(request: Request): Promise<Response> {
		if (this.store.vaultMetadata()) return json({ error: "probe_already_initialized" }, 409);
		const body = await request.json<{ vaultId: string; scenario: ProbeCase }>();
		if (!cases.includes(body.scenario) || !/^r2-probe-[a-f0-9-]{36}$/.test(body.vaultId)) return json({ error: "invalid_fixture" }, 400);
		const generation = `generation-${body.vaultId}`;
		const member = await actor(body.vaultId, generation, "member");
		const owner = await actor(body.vaultId, generation, "owner");
		const provisioned = await this.runtime.fetch(post("/__yaos/provision", { vaultGeneration: generation }, this.env, body.vaultId, generation));
		if (!provisioned.ok) return json({ error: "probe_provision_failed" }, 500);
		this.store.installAuthorityFence({ changeId: "probe-initial", vaultId: body.vaultId, vaultGeneration: generation,
			subjectDigest: "probe-initial-subjects", subjects: [owner, member].flatMap((entry) => [
				{ principalId: entry.principalId, role: entry.role, state: "active" as const, membershipRevision: 1,
					policyVersion: entry.policyVersion, capabilityDigest: entry.capabilityDigest, displayName: entry.principalId, colorSeed: entry.principalId },
				{ deviceId: entry.deviceId, principalId: entry.principalId, state: "active" as const, credentialRevision: 1 },
			]) });
		this.store.activateVaultAdmission(body.vaultId, generation);
		const issued = await createTicket(auth, member, { purpose: "root", documentId: "root", rootEpoch: 1 });
		let freshTicket: string | null = null;
		let currentGeneration = generation;
		if (body.scenario === "rotation-active") {
			this.state.storage.sql.exec("UPDATE vault_device_authority SET credential_revision = 2 WHERE device_id = ?", member.deviceId).toArray();
			freshTicket = (await createTicket(auth, { ...member, deviceCredentialRevision: 2 }, { purpose: "root", documentId: "root", rootEpoch: 1 })).ticket;
		}
		if (body.scenario === "generation-mismatch") {
			currentGeneration = `changed-${body.vaultId}`;
			this.state.storage.sql.exec("UPDATE vault_meta SET vault_generation = ? WHERE id = 1", currentGeneration).toArray();
		}
		if (body.scenario.startsWith("mirror-absent")) {
			for (const table of ["vault_principal_authority", "vault_device_authority", "vault_authorization_change_receipts", "vault_admission_activations"]) {
				this.state.storage.sql.exec(`DELETE FROM ${table}`).toArray();
			}
		}
		if (body.scenario === "partial-mirror") this.state.storage.sql.exec("DELETE FROM vault_principal_authority WHERE principal_id = ?", member.principalId).toArray();
		if (body.scenario === "rollout-deleting") this.state.storage.sql.exec("DELETE FROM vault_admission_activations").toArray();
		const seeded = await this.env.PROBE_CONFIG.get(this.env.PROBE_CONFIG.idFromName(body.vaultId)).fetch(
			post("/__probe/seed", { vaultId: body.vaultId, generation: currentGeneration, scenario: body.scenario }, this.env));
		if (!seeded.ok) return json({ error: "probe_config_seed_failed" }, 500);
		const signatureValid = await inspectTicket(issued.ticket, auth, { vaultId: body.vaultId, purpose: "root", documentId: "root" }) !== null;
		await this.state.storage.put("probe-case", body.scenario);
		await this.state.storage.put("probe-calls", []);
		await this.state.storage.put("probe-accepted", 0);
		return json({ ticket: issued.ticket, freshTicket, vaultId: body.vaultId, signatureValid,
			schemaVersion: SERVER_SCHEMA_VERSION, protocolVersion: SERVER_PROTOCOL_VERSION,
			before: await this.snapshot() });
	}

	private async snapshot() {
		const metadata = this.store.vaultMetadata();
		if (!metadata) return { provisioned: false };
		const device = this.store.deviceAuthority("member-device");
		return { provisioned: true, mirrorPresent: this.store.hasAuthorityMirror(),
			activeAttested: this.store.vaultAdmissionActive(metadata.vaultId, metadata.vaultGeneration),
			deviceActive: device?.state === "active", credentialRevision: device?.credentialRevision ?? null,
			generationChanged: metadata.vaultGeneration.startsWith("changed-") };
	}

	private async stats(): Promise<Response> {
		return json({ state: await this.snapshot(), calls: await this.state.storage.get<string[]>("probe-calls") ?? [],
			accepted: await this.state.storage.get<number>("probe-accepted") ?? 0 });
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.runtime.webSocketMessage(socket, message);
	}

	webSocketClose(socket: WebSocket, code: number, reason: string): void {
		this.runtime.webSocketClose(socket);
		reciprocateSocketClose(socket, code, reason);
	}

	webSocketError(socket: WebSocket): void { this.runtime.webSocketError(socket); }
	async alarm(): Promise<void> { await this.runtime.alarm(); }
}

export default {
	async fetch(request: Request, env: ProbeEnvironment): Promise<Response> {
		if (!secretAvailable(env) || request.headers.get("authorization") !== `Bearer ${env.R2_PROBE_TOKEN}`) return json({ error: "unauthorized" }, 401);
		let untrustedProbeHeader = false;
		request.headers.forEach((_value, name) => { if (name.startsWith("x-r2-probe-")) untrustedProbeHeader = true; });
		if (untrustedProbeHeader) return json({ error: "untrusted_probe_header" }, 400);
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/health") return json({ probe: "yaos-p0k-r2-probe", native: true });
		const fixture = /^\/fixtures\/([a-z-]+)\/([a-f0-9-]{36})$/.exec(url.pathname);
		if (request.method === "POST" && fixture && cases.includes(fixture[1] as ProbeCase)) {
			const vaultId = `r2-probe-${fixture[2]}`;
			return env.PROBE_VAULTS.get(env.PROBE_VAULTS.idFromName(vaultId)).fetch(post("/__probe/init", { vaultId, scenario: fixture[1] }, env));
		}
		const stats = /^\/stats\/(r2-probe-[a-f0-9-]{36})$/.exec(url.pathname);
		if (request.method === "GET" && stats) return env.PROBE_VAULTS.get(env.PROBE_VAULTS.idFromName(stats[1]!)).fetch(
			internalRequest(new Request("https://internal/__probe/stats"), env));
		const socket = /^\/vault\/(r2-probe-[a-f0-9-]{36})\/ws\/root$/.exec(url.pathname);
		if (request.method !== "GET" || !socket || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "not_found" }, 404);
		let workerConfigCalls = 0;
		const runtimeEnv: Env = { YAOS_SYNC: { call: async (name, forwarded) =>
			env.PROBE_VAULTS.get(env.PROBE_VAULTS.idFromName(name)).fetch(internalRequest(forwarded, env)) },
			YAOS_CONFIG: { call: async () => { workerConfigCalls++; return json({ error: "worker_control_plane_trap" }, 503); } },
			socketUpgrades: new CloudflareSocketUpgrades() };
		const response = await handleVaultSocketRoute(request, runtimeEnv, auth, socket[1]!, "/ws/root");
		const headers = new Headers(response.headers);
		headers.set("x-r2-probe-worker-config-calls", String(workerConfigCalls));
		return new Response(response.body, { status: response.status, headers, webSocket: response.webSocket });
	},
};
