import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeDatabaseSet } from "../../packages/server-node/src/storage";
import { NodeSocketHub, NodeSocketRegistry } from "../../packages/server-node/src/socketHost";
import { ywasmCrdtEngine as engine } from "../../packages/server-node/src/ywasmNodeCrdtEngine";
import { ControlPlaneRuntime } from "../../server/src/config";
import { VaultRuntime } from "../../server/src/server";
import { VaultStore } from "../../server/src/vaultStore";
import { actorHeaders } from "../../server/src/vaultAuthority";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext } from "../../server/src/collaboration";
import type { VaultAuthoritySubjectChange } from "../../server/src/vaultDocumentStore";
import type { ActorCallPort, VaultRuntimeStoragePort } from "../../server/src/platformPorts";
import type { AuthState } from "../../server/src/routes/types";
import { handleVaultSocketRoute } from "../../server/src/routes/vault";
import { createTicket } from "../../server/src/routes/ticket";
import { settleAuthorizationChange } from "../../server/src/routes/enroll";
import type { AuthorizationChangeRecord } from "../../server/src/collaborationIdentity";
import { SERVER_PROTOCOL_VERSION, SERVER_SCHEMA_VERSION } from "../../server/src/version";
import { makeEnv } from "../mocks/workerEnv";
import { suite } from "../harness";

const tests = suite("R2-socket-authority-node");
const vaultId = "r2-authority-vault";
const generation = "r2-authority-generation";
const auth: AuthState = { mode: "claim", claimed: true, operatorRecoveryHash: "operator-r2", ticketSigningKey: "signing-key-r2" };

function post(path: string, body: unknown, vaultGeneration = generation): Request {
	return new Request(`https://internal${path}`, { method: "POST", headers: {
		"content-type": "application/json", "x-yaos-vault-id": vaultId, "x-yaos-vault-generation": vaultGeneration,
	}, body: JSON.stringify(body) });
}

async function fixture(mirror = true, provisioned = true, activated = true) {
	const directory = await mkdtemp(join(tmpdir(), "yaos-r2-authority-"));
	const databases = new NodeDatabaseSet(directory);
	const storage = databases.vault(vaultId);
	const controlStorage = databases.controlPlane("global-config");
	const actor: VaultActorContext = { vaultId, vaultGeneration: generation, principalId: "r2-member", membershipRevision: 1,
		deviceId: "r2-device", deviceCredentialRevision: 1, role: "member", policyVersion: COLLABORATION_POLICY_VERSION,
		capabilityDigest: await capabilityDigestForRole("member") };
	const owner: VaultActorContext = { ...actor, principalId: "r2-owner", deviceId: "r2-owner-device", role: "owner",
		capabilityDigest: await capabilityDigestForRole("owner") };
	const subjects: VaultAuthoritySubjectChange[] = [owner, actor].flatMap((entry) => [
		{ principalId: entry.principalId, role: entry.role, state: "active", membershipRevision: 1,
			policyVersion: entry.policyVersion, capabilityDigest: entry.capabilityDigest, displayName: entry.principalId, colorSeed: entry.principalId },
		{ deviceId: entry.deviceId, principalId: entry.principalId, state: "active", credentialRevision: 1 },
	]);
	const vault = { vaultId, name: "R2 authority", state: "active", vaultGeneration: generation, createdAt: 1, provisionedAt: 1, ownerPrincipalId: owner.principalId };
	await controlStorage.put("vaults", [vault]);
	await controlStorage.put("principals", [owner, actor].map((entry) => ({ principalId: entry.principalId, vaultId,
		displayName: entry.principalId, colorSeed: entry.principalId, createdAt: 1, updatedAt: 1 })));
	await controlStorage.put("vaultMemberships", [owner, actor].map((entry) => ({ principalId: entry.principalId, vaultId,
		role: entry.role, state: "active", revision: 1, invitedByPrincipalId: null, joinedAt: 1, updatedAt: 1, revokedAt: null })));
	await controlStorage.put("devices", [owner, actor].map((entry) => ({ deviceId: entry.deviceId, vaultId, principalId: entry.principalId,
		tokenHash: (entry.role === "owner" ? "a" : "b").repeat(64), credentialRevision: 1, state: "active", name: entry.deviceId, enrolledAt: 1, revokedAt: null })));
	await controlStorage.put("vaultGovernanceRequests", [{ governanceRequestId: "r2-delete-request", requestId: "r2-governance-request",
		requestDigest: "c".repeat(64), vaultId, vaultGeneration: generation,
		kind: "vault-destroy", state: "confirmed", requestedByPrincipalId: owner.principalId, requestedByDeviceId: owner.deviceId,
		requestedByMembershipRevision: 1, requestedName: null, emergencyReason: null, createdAt: 1, confirmedAt: 1, completedAt: null, lastError: null }]);
	const hub = new NodeSocketHub();
	let runtime: VaultRuntime;
	const sockets = new NodeSocketRegistry(hub, { message: (socket, message) => { void runtime.webSocketMessage(socket, message); },
		close: (socket) => runtime.webSocketClose(socket), error: () => {} });
	const configCalls: string[] = [];
	const vaultCalls: string[] = [];
	let beforeConfigCall: ((path: string) => Promise<void>) | null = null;
	const vaultPort: ActorCallPort = { call: async (_name, request) => { vaultCalls.push(new URL(request.url).pathname); return runtime.fetch(request); } };
	const config = new ControlPlaneRuntime(controlStorage, undefined, vaultPort);
	const controlPlane: ActorCallPort = { call: async (_name, request) => {
		const path = new URL(request.url).pathname;
		configCalls.push(path);
		await beforeConfigCall?.(path);
		return config.fetch(request);
	} };
	const options = { storage: storage as unknown as VaultRuntimeStoragePort, sockets,
		alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} }, execution: { waitUntil: () => {} }, controlPlane };
	runtime = new VaultRuntime(options);
	const store = new VaultStore(storage);
	if (provisioned) {
		assert.equal((await runtime.fetch(post("/__yaos/provision", { vaultGeneration: generation }))).status, 201);
		const body = engine.createDocument("r2-body");
		engine.insertText(body, "body", 0, "R2 body", "test");
		const bodyCommit = store.commitUpdate({ documentId: "r2-body", update: engine.encodeStateAsUpdate(body), kind: "body" });
		engine.destroyDocument(body);
		const root = store.reconstructDocument("root").doc;
		const vector = engine.encodeStateVector(root);
		engine.applyRootOperations(root, [{ kind: "map-set", root: "pathToId", key: "R2.md", value: { shared: "value", value: "r2-body" } }], "test");
		store.commitRootLifecycle({ rootUpdate: engine.encodeStateAsUpdate(root, vector), kind: "create",
			catalog: { bodyId: "r2-body", fileId: "r2-body", path: "R2.md", previousPath: null, lifecycle: "active", bodyGeneration: bodyCommit.generation } });
		engine.destroyDocument(root);
		if (mirror) {
			store.installAuthorityFence({ changeId: "r2-initial", vaultId, vaultGeneration: generation, subjectDigest: "r2-initial-digest", subjects });
			if (activated) store.activateVaultAdmission(vaultId, generation);
		}
	}
	const env = makeEnv({ YAOS_SYNC: vaultPort, YAOS_CONFIG: controlPlane, socketUpgrades: hub });
	const prepareConnect = async (currentActor = actor, path = "/ws/root", extraHeaders: Record<string, string> = {}) => {
		const scope = path === "/ws/root" ? { purpose: "root" as const, documentId: "root" as const, rootEpoch: 1 }
			: { purpose: "body" as const, documentId: "r2-body", bodyEpoch: 1 };
		const ticket = (await createTicket(auth, currentActor, scope)).ticket;
		return () => handleVaultSocketRoute(new Request(`https://example.test/vault/${vaultId}${path}?ticket=${encodeURIComponent(ticket)}&schemaVersion=${SERVER_SCHEMA_VERSION}&protocolVersion=${SERVER_PROTOCOL_VERSION}`,
			{ headers: { upgrade: "websocket", ...extraHeaders } }), env, auth, vaultId, path);
	};
	const connect = async (currentActor = actor, path = "/ws/root", extraHeaders: Record<string, string> = {}) => (await prepareConnect(currentActor, path, extraHeaders))();
	const exchange = (response: Response) => {
		const messages: unknown[] = [];
		const closes: unknown[][] = [];
		const upgrade = hub.takeUpgrade(response);
		assert.ok(upgrade, "Node host receives an accepted upgrade response");
		upgrade.connected({ readyState: 1, send: (message: unknown) => messages.push(message),
			close: (...values: unknown[]) => closes.push(values), addEventListener: () => {} } as never);
		return { messages, closes };
	};
	return { directory, databases, storage, store, controlStorage, config, env, runtime: () => runtime, restart: () => { runtime = new VaultRuntime(options); },
		actor, owner, subjects, sockets, configCalls, vaultCalls, connect, prepareConnect, exchange,
		setBeforeConfigCall: (callback: ((path: string) => Promise<void>) | null) => { beforeConfigCall = callback; },
		close: async () => { hub.clear(); databases.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function rejection(fixtureValue: Awaited<ReturnType<typeof fixture>>, response: Response, reason: string) {
	const exchange = fixtureValue.exchange(response);
	assert.deepEqual(exchange.closes, [[1008, "unauthorized"]]);
	assert.deepEqual(JSON.parse((exchange.messages[0] as string).slice(6)), { type: "error", code: "unauthorized", reason });
}

tests.test("valid root/body tickets use the current mirror without control-plane calls on the Node host", async () => {
	const current = await fixture();
	try {
		for (const path of ["/ws/root", "/ws/body/r2-body"]) {
			const exchange = current.exchange(await current.connect(current.actor, path));
			assert.equal(exchange.closes.length, 0);
			assert.ok(exchange.messages.some((message) => message instanceof Uint8Array));
		}
		assert.equal(current.sockets.sockets().length, 2);
		assert.deepEqual(current.configCalls, []);
	} finally { await current.close(); }
});

for (const field of ["membershipRevision", "deviceCredentialRevision", "principalId", "deviceId", "role", "policyVersion", "capabilityDigest"] as const) {
	tests.test(`current ${field} is checked strictly at admission`, async () => {
		const current = await fixture();
		try {
			const stale = { ...current.actor, [field]: field.endsWith("Revision") || field === "policyVersion" ? 2 : field === "role" ? "owner" : "not-current" } as VaultActorContext;
			await rejection(current, await current.connect(stale), "authority_superseded");
			assert.equal(current.sockets.sockets().length, 0);
			assert.deepEqual(current.configCalls, []);
		} finally { await current.close(); }
	});
}

for (const mutation of ["revoked", "rotated", "member-removed", "device-removed", "legacy-revoked"] as const) {
		tests.test(`ticket issued before ${mutation} cannot connect after the fence`, async () => {
		const current = await fixture();
		try {
			const connectOldTicket = await current.prepareConnect();
			if (mutation === "legacy-revoked") current.store.revokeDevice(current.actor.deviceId);
			else if (mutation === "device-removed") current.storage.sql.exec("DELETE FROM vault_device_authority WHERE device_id = ?", current.actor.deviceId).toArray();
			else {
				if (mutation === "revoked") current.store.installAuthorityFence({ changeId: "r2-second-device", vaultId, vaultGeneration: generation,
					subjectDigest: "r2-second-device", subjects: [{ deviceId: "r2-second-device", principalId: current.actor.principalId,
						state: "active", credentialRevision: 1 }] });
				const subjects: VaultAuthoritySubjectChange[] = mutation === "member-removed" ? [
					{ principalId: current.actor.principalId, role: "member", state: "revoked", membershipRevision: 2, policyVersion: current.actor.policyVersion,
						capabilityDigest: current.actor.capabilityDigest, displayName: "Removed", colorSeed: "removed" },
					{ deviceId: current.actor.deviceId, principalId: current.actor.principalId, state: "revoked", credentialRevision: 2 },
				] : [{ deviceId: current.actor.deviceId, principalId: current.actor.principalId, state: mutation === "rotated" ? "active" : "revoked", credentialRevision: 2 }];
				current.store.installAuthorityFence({ changeId: `r2-${mutation}`, vaultId, vaultGeneration: generation, subjectDigest: mutation, subjects });
			}
			await rejection(current, await connectOldTicket(), "authority_superseded");
			assert.equal(current.sockets.sockets().length, 0);
			assert.deepEqual(current.configCalls, []);
		} finally { await current.close(); }
	});
}

tests.test("ticket generation mismatch is a typed unauthorized socket outcome", async () => {
	const current = await fixture();
	try { await rejection(current, await current.connect({ ...current.actor, vaultGeneration: "old-generation" }), "vault_generation_mismatch"); }
	finally { await current.close(); }
});

tests.test("caller actor, outcome, generation and semantic-epoch headers cannot spoof ticket authority", async () => {
	const current = await fixture();
	try {
		const headers: Record<string, string> = {};
		actorHeaders(current.owner).forEach((value, name) => {
			headers[name] = value;
		});
		Object.assign(headers, { "x-yaos-vault-id": "spoof-vault", "x-yaos-vault-generation": "spoof-generation", "x-yaos-outcome-claim": "1",
			"x-yaos-root-epoch": "999", "x-yaos-body-epoch": "999", authorization: "Bearer spoof" });
		current.exchange(await current.connect(current.actor, "/ws/root", headers));
		const attachment = current.sockets.sockets()[0]!.deserializeAttachment() as VaultActorContext & { documentEpoch: number };
		assert.equal(attachment.principalId, current.actor.principalId);
		assert.equal(attachment.role, "member");
		assert.equal(attachment.vaultGeneration, generation);
		assert.equal(attachment.documentEpoch, 1);
	} finally { await current.close(); }
});

tests.test("missing mirror falls back to old checks plus a current actor snapshot, installs once, then uses zero hops", async () => {
	const current = await fixture(false);
	try {
		current.exchange(await current.connect());
		assert.deepEqual(current.configCalls, ["/__yaos/verify-device", "/__yaos/vault", "/__yaos/collaboration/socket-authority"]);
		assert.equal(current.store.validateActor(current.actor), "allowed");
		assert.equal(current.store.hasAuthorityMirror(), true);
		current.configCalls.length = 0;
		current.restart();
		current.exchange(await current.connect(current.actor, "/ws/body/r2-body"));
		assert.deepEqual(current.configCalls, []);
	} finally { await current.close(); }
});

tests.test("fallback refuses stale credentials, unavailable authority and partial mirrors rather than opening", async () => {
	for (const mode of ["stale", "deleted", "pending", "partial"] as const) {
		const current = await fixture(mode === "partial");
		try {
			if (mode === "stale") {
				const records = await current.controlStorage.get<Array<Record<string, unknown>>>("devices");
				records!.find((entry) => entry.deviceId === current.actor.deviceId)!.credentialRevision = 2;
				await current.controlStorage.put("devices", records);
			} else if (mode === "deleted") await current.controlStorage.put("vaults", []);
			else if (mode === "pending") {
				const records = await current.controlStorage.get<Array<Record<string, unknown>>>("vaultMemberships");
				records!.find((entry) => entry.principalId === current.owner.principalId)!.state = "changing";
				await current.controlStorage.put("vaultMemberships", records);
			} else current.storage.sql.exec("DELETE FROM vault_principal_authority WHERE principal_id = ?", current.actor.principalId).toArray();
			await rejection(current, await current.connect(), mode === "partial" ? "authority_superseded" : "authority_unavailable");
			assert.equal(current.sockets.sockets().length, 0);
			if (mode === "partial") assert.deepEqual(current.configCalls, []);
		} finally { await current.close(); }
	}
});

tests.test("unprovisioned vaults reject without fallback or automatic provisioning", async () => {
	const current = await fixture(false, false);
	try { await rejection(current, await current.connect(), "vault_not_provisioned"); assert.deepEqual(current.configCalls, []); }
	finally { await current.close(); }
});

tests.test("deletion closes admissions before the registry reports success and survives purge/restart", async () => {
	const current = await fixture();
	try {
		const response = await current.config.fetch(post("/__yaos/destroy-vault", { vaultId, governanceRequestId: "r2-delete-request" }));
		assert.equal(response.status, 200);
		assert.deepEqual(current.vaultCalls, ["/__yaos/fence-vault-admission"]);
		assert.equal(current.store.vaultAdmissionFence(generation)?.deletionId, "r2-delete-request");
		await rejection(current, await current.connect(), "vault_deleting");
		assert.equal((await current.runtime().fetch(post("/__yaos/begin-vault-deletion", { deletionId: "r2-delete-request", vaultGeneration: generation }))).status, 200);
		assert.equal((await current.runtime().fetch(post("/__yaos/delete-all", {}))).status, 200);
		current.restart();
		await rejection(current, await current.connect(), "vault_not_provisioned");
		assert.equal((await current.runtime().fetch(post("/__yaos/provision", { vaultGeneration: generation }))).status, 410);
	} finally { await current.close(); }
});

tests.test("failed deletion-fence RPC leaves the registry active and reports failure, never success", async () => {
	const current = await fixture();
	try {
		for (const port of [undefined, { call: async () => Response.json({ error: "failed" }, { status: 503 }) },
			{ call: async () => Response.json({ fenced: true, vaultId, vaultGeneration: "wrong", deletionId: "r2-delete-request" }) }]) {
			const config = new ControlPlaneRuntime(current.controlStorage, undefined, port);
			const response = await config.fetch(post("/__yaos/destroy-vault", { vaultId, governanceRequestId: "r2-delete-request" }));
			assert.equal(response.status, 503);
			assert.deepEqual(await response.json(), { error: "vault_deletion_fence_unavailable" });
			assert.equal((await current.controlStorage.get<Array<{ state: string }>>("vaults"))![0]!.state, "active");
			assert.equal(await current.controlStorage.get("pendingVaultDestroys"), undefined);
		}
	} finally { await current.close(); }
});

tests.test("fence persisted before a lost RPC response remains fail-closed and retries with the same identity", async () => {
	const current = await fixture();
	try {
		const config = new ControlPlaneRuntime(current.controlStorage, undefined, { call: async (_name, request) => {
			await current.runtime().fetch(request);
			throw new Error("response lost after durable fence");
		} });
		assert.equal((await config.fetch(post("/__yaos/destroy-vault", { vaultId, governanceRequestId: "r2-delete-request" }))).status, 503);
		assert.equal((await current.controlStorage.get<Array<{ state: string }>>("vaults"))![0]!.state, "active");
		await rejection(current, await current.connect(), "vault_deleting");
		assert.equal((await current.config.fetch(post("/__yaos/destroy-vault", { vaultId, governanceRequestId: "r2-delete-request" }))).status, 200);
	} finally { await current.close(); }
});

tests.test("unprovisioned deletion tombstone rejects delayed provisioning", async () => {
	const current = await fixture(false, false);
	try {
		const response = await current.config.fetch(post("/__yaos/destroy-vault", { vaultId, governanceRequestId: "r2-delete-request" }));
		assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
		current.restart();
		assert.equal((await current.runtime().fetch(post("/__yaos/provision", { vaultGeneration: generation }))).status, 410);
	} finally { await current.close(); }
});

tests.test("durable admission fence denies sockets while the registry is still active awaiting its receipt", async () => {
	const current = await fixture();
	let resume!: () => void;
	let signal!: () => void;
	const blocked = new Promise<void>((resolve) => { resume = resolve; });
	const reached = new Promise<void>((resolve) => { signal = resolve; });
	try {
		const config = new ControlPlaneRuntime(current.controlStorage, undefined, { call: async (_name, request) => {
			const response = await current.runtime().fetch(request);
			signal();
			await blocked;
			return response;
		} });
		const destroy = config.fetch(post("/__yaos/destroy-vault", { vaultId, governanceRequestId: "r2-delete-request" }));
		await reached;
		assert.equal((await current.controlStorage.get<Array<{ state: string }>>("vaults"))![0]!.state, "active");
		await rejection(current, await current.connect(), "vault_deleting");
		resume();
		assert.equal((await destroy).status, 200);
		assert.equal((await current.controlStorage.get<Array<{ state: string }>>("vaults"))![0]!.state, "deleting");
	} finally { resume(); await current.close(); }
});

tests.test("fallback admission and deletion serialize without holding a control-plane transaction over the vault RPC", async () => {
	const current = await fixture(false);
	let resume!: () => void;
	let signal!: () => void;
	const blocked = new Promise<void>((resolve) => { resume = resolve; });
	const reached = new Promise<void>((resolve) => { signal = resolve; });
	try {
		current.setBeforeConfigCall(async (path) => {
			if (path === "/__yaos/collaboration/socket-authority") { signal(); await blocked; }
		});
		const connect = current.connect();
		await reached;
		const destroy = current.config.fetch(post("/__yaos/destroy-vault", { vaultId, governanceRequestId: "r2-delete-request" }));
		resume();
		current.exchange(await connect);
		assert.equal((await destroy).status, 200);
		await rejection(current, await current.connect(), "vault_deleting");
	} finally { resume(); await current.close(); }
});

tests.test("pending membership removal uses installed authority until the fence; settled success rejects the old ticket", async () => {
	const current = await fixture();
	try {
		const oldTicket = await current.prepareConnect();
		const prepared = await current.config.fetch(post("/__yaos/collaboration/revoke-member", {
			vaultId, principalId: current.owner.principalId, deviceId: current.owner.deviceId,
			targetPrincipalId: current.actor.principalId, requestId: "r2-remove-member",
		}));
		assert.equal(prepared.status, 202);
		const payload = await prepared.json() as { change: AuthorizationChangeRecord };
		const oldWorkerCheck = await current.config.fetch(post("/__yaos/verify-device", { vaultId, deviceId: current.actor.deviceId }));
		assert.equal(oldWorkerCheck.status, 200, "old Worker presence check does NOT reject a revoking collaboration device");
		current.exchange(await oldTicket());
		assert.equal(await settleAuthorizationChange(current.env, payload.change), true);
		await rejection(current, await oldTicket(), "authority_superseded");
	} finally { await current.close(); }
});

tests.test("ownership transfer fences old roles and accepts only the current owner membership revision", async () => {
	const current = await fixture();
	try {
		const oldOwnerTicket = await current.prepareConnect(current.owner);
		const oldMemberTicket = await current.prepareConnect();
		const subjects: VaultAuthoritySubjectChange[] = [
			{ principalId: current.owner.principalId, role: "member", state: "active", membershipRevision: 2,
				policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest: current.actor.capabilityDigest, displayName: "Former owner", colorSeed: "former-owner" },
			{ principalId: current.actor.principalId, role: "owner", state: "active", membershipRevision: 2,
				policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest: current.owner.capabilityDigest, displayName: "New owner", colorSeed: "new-owner" },
		];
		assert.equal((await current.runtime().fetch(post("/__yaos/authority-fence", { changeId: "r2-transfer", vaultId,
			vaultGeneration: generation, subjects }))).status, 200);
		await rejection(current, await oldOwnerTicket(), "authority_superseded");
		await rejection(current, await oldMemberTicket(), "authority_superseded");
		current.exchange(await current.connect({ ...current.actor, role: "owner", membershipRevision: 2, capabilityDigest: current.owner.capabilityDigest }));
		await rejection(current, await current.connect({ ...current.actor, role: "owner", membershipRevision: 3, capabilityDigest: current.owner.capabilityDigest }), "authority_superseded");
		assert.deepEqual(current.configCalls, []);
	} finally { await current.close(); }
});

tests.test("fallback control-plane exceptions reject closed without installing a partial mirror", async () => {
	const current = await fixture(false);
	try {
		current.setBeforeConfigCall(async () => { throw new Error("control plane unavailable"); });
		await rejection(current, await current.connect(), "authority_unavailable");
		assert.equal(current.store.hasAuthorityMirror(), false);
		assert.equal(current.sockets.sockets().length, 0);
	} finally { await current.close(); }
});

tests.test("local HMAC, scope, expiry and version failures never reach either authority actor", async () => {
	const current = await fixture();
	try {
		const issued = await createTicket(auth, current.actor, { purpose: "root", documentId: "root", rootEpoch: 1 });
		const expired = await createTicket(auth, current.actor, { purpose: "root", documentId: "root", rootEpoch: 1 }, -1);
		const body = await createTicket(auth, current.actor, { purpose: "body", documentId: "r2-body", bodyEpoch: 1 });
		for (const ticket of ["bad-signature", expired.ticket, body.ticket]) {
			const response = await handleVaultSocketRoute(new Request(`https://example.test/vault/${vaultId}/ws/root?ticket=${encodeURIComponent(ticket)}&schemaVersion=${SERVER_SCHEMA_VERSION}&protocolVersion=${SERVER_PROTOCOL_VERSION}`,
				{ headers: { upgrade: "websocket" } }), current.env, auth, vaultId, "/ws/root");
			const exchange = current.exchange(response);
			assert.deepEqual(exchange.closes, [[1008, "unauthorized"]]);
			assert.equal(JSON.parse((exchange.messages[0] as string).slice(6)).code, "unauthorized");
		}
		for (const parameter of ["schemaVersion", "protocolVersion"]) {
			const params = new URLSearchParams({ ticket: issued.ticket, schemaVersion: String(SERVER_SCHEMA_VERSION), protocolVersion: String(SERVER_PROTOCOL_VERSION) });
			params.set(parameter, "999");
			const response = await handleVaultSocketRoute(new Request(`https://example.test/vault/${vaultId}/ws/root?${params}`, { headers: { upgrade: "websocket" } }),
				current.env, auth, vaultId, "/ws/root");
			const exchange = current.exchange(response);
			assert.deepEqual(exchange.closes, [[1008, "update required"]]);
			assert.equal(JSON.parse((exchange.messages[0] as string).slice(6)).code, "update_required");
		}
		assert.deepEqual(current.configCalls, []);
		assert.deepEqual(current.vaultCalls, []);
	} finally { await current.close(); }
});

tests.test("pre-R2 authority mirrors attest active registry state once before becoming a zero-hop mirror", async () => {
	const current = await fixture(true, true, false);
	try {
		current.exchange(await current.connect());
		assert.deepEqual(current.configCalls, ["/__yaos/vault"]);
		assert.equal(current.store.vaultAdmissionActive(vaultId, generation), true);
		current.configCalls.length = 0;
		current.restart();
		current.exchange(await current.connect());
		assert.deepEqual(current.configCalls, []);
	} finally { await current.close(); }
});

tests.test("pre-R2 registry deletion with no local fence cannot activate a stale authority mirror", async () => {
	const current = await fixture(true, true, false);
	try {
		const vaults = await current.controlStorage.get<Array<Record<string, unknown>>>("vaults");
		vaults![0]!.state = "deleting";
		await current.controlStorage.put("vaults", vaults);
		await rejection(current, await current.connect(), "vault_deleting");
		assert.deepEqual(current.configCalls, ["/__yaos/vault"]);
		assert.equal(current.store.vaultAdmissionActive(vaultId, generation), false);
		assert.equal(current.sockets.sockets().length, 0);
	} finally { await current.close(); }
});

await tests.done();
