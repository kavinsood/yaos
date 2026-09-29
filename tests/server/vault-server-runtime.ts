import { strict as assert } from "node:assert";
import { VaultRuntime } from "../../server/src/server";
import { NodeSqliteStorage } from "../../packages/server-node/src/storage";
import { makeDurableObjectState } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";
import { actorHeaders } from "../../server/src/vaultAuthority";
import type { VaultActorContext } from "../../server/src/collaboration";
import { capabilityDigestForRole } from "../../server/src/collaboration";
import type { VaultPrincipalAuthority, VaultDeviceAuthority } from "../../server/src/vaultDocumentStore";
import { principalSettingsKey } from "../../server/src/settingsSyncStore";
import { decodeBinaryEnvelope } from "../../server/src/shared/binaryEnvelope";

const s = suite("vault-server-runtime");
const VAULT_ID = "vault-runtime-0001";
const GENERATION = "generation-runtime-0001";
const ACTOR: VaultActorContext = {
	vaultId: VAULT_ID,
	vaultGeneration: GENERATION,
	principalId: "principal-runtime-0001",
	membershipRevision: 1,
	deviceId: "device-runtime-0001",
	deviceCredentialRevision: 1,
	role: "member",
	policyVersion: 1,
	capabilityDigest: await capabilityDigestForRole("member"),
};

class RuntimeStore {
	metadata: { vaultId: string; vaultGeneration: string; schemaVersion: number; storageFormatVersion: number; provisionedAt: number } | null = null;
	deletion: { deletionId: string; vaultGeneration: string } | null = null;
	admissionFence: { vaultId: string; vaultGeneration: string; deletionId: string } | null = null;
	private activeGeneration: string | null = null;
	private readonly principal: VaultPrincipalAuthority = { principalId: ACTOR.principalId, role: ACTOR.role,
		state: "active", membershipRevision: ACTOR.membershipRevision, policyVersion: ACTOR.policyVersion,
		capabilityDigest: ACTOR.capabilityDigest, displayName: "Runtime member", colorSeed: "runtime-member", changeId: "runtime-initial" };
	private readonly device: VaultDeviceAuthority = { deviceId: ACTOR.deviceId, principalId: ACTOR.principalId,
		state: "active", credentialRevision: ACTOR.deviceCredentialRevision, changeId: "runtime-initial" };
	readonly revokedDevices = new Set<string>();
	provisionVault(vaultId: string, vaultGeneration: string): object {
		if (this.metadata) {
			if (this.metadata.vaultId !== vaultId || this.metadata.vaultGeneration !== vaultGeneration) throw new Error("vault generation mismatch");
			return { ...this.metadata, created: false };
		}
		this.metadata = { vaultId, vaultGeneration, schemaVersion: 8, storageFormatVersion: 4, provisionedAt: 1 };
		this.activateVaultAdmission(vaultId, vaultGeneration);
		return { ...this.metadata, created: true };
	}
	vaultMetadata() { return this.metadata; }
	principalAuthority(principalId: string) { return principalId === this.principal.principalId ? this.principal : null; }
	deviceAuthority(deviceId: string) { return deviceId === this.device.deviceId ? this.device : null; }
	hasAuthorityMirror(): boolean { return this.metadata !== null; }
	vaultAdmissionFence(vaultGeneration: string) { return this.admissionFence?.vaultGeneration === vaultGeneration ? this.admissionFence : null; }
	fenceVaultAdmission(vaultId: string, vaultGeneration: string, deletionId: string): void {
		const existing = this.vaultAdmissionFence(vaultGeneration);
		if (existing && (existing.vaultId !== vaultId || existing.deletionId !== deletionId)) throw new Error("vault deletion identity mismatch");
		this.admissionFence = { vaultId, vaultGeneration, deletionId };
	}
	vaultAdmissionActive(vaultId: string, vaultGeneration: string): boolean {
		return this.metadata?.vaultId === vaultId && this.activeGeneration === vaultGeneration;
	}
	activateVaultAdmission(vaultId: string, vaultGeneration: string): void {
		if (this.metadata?.vaultId !== vaultId || this.metadata.vaultGeneration !== vaultGeneration
			|| this.vaultAdmissionFence(vaultGeneration)) throw new Error("vault admission not active");
		this.activeGeneration = vaultGeneration;
	}
	vaultDeletionBegun(vaultGeneration: string): boolean { return this.deletion?.vaultGeneration === vaultGeneration; }
	beginVaultDeletion(deletionId: string, vaultGeneration: string): { captureJobIds: string[]; restoreIds: string[] } {
		if (this.metadata?.vaultGeneration !== vaultGeneration) throw new Error("vault generation mismatch");
		this.deletion = { deletionId, vaultGeneration };
		return { captureJobIds: [], restoreIds: [] };
	}
	isDeviceRevoked(deviceId: string): boolean { return this.revokedDevices.has(deviceId); }
	validateActor(actor: VaultActorContext): "allowed" | "authority_superseded" {
		const principal = this.principalAuthority(actor.principalId);
		const device = this.deviceAuthority(actor.deviceId);
		return this.metadata?.vaultId === actor.vaultId && this.metadata.vaultGeneration === actor.vaultGeneration
			&& !this.vaultAdmissionFence(actor.vaultGeneration) && !this.vaultDeletionBegun(actor.vaultGeneration)
			&& !this.isDeviceRevoked(actor.deviceId) && principal?.state === "active" && device?.state === "active"
			&& device.principalId === actor.principalId && principal.role === actor.role
			&& principal.membershipRevision === actor.membershipRevision && device.credentialRevision === actor.deviceCredentialRevision
			&& principal.policyVersion === actor.policyVersion && principal.capabilityDigest === actor.capabilityDigest
			? "allowed" : "authority_superseded";
	}
	currentSequence(): number { return 1; }
	journalFloor(): number { return 0; }
	activePins(): unknown[] { return []; }
}

function makeServer(sqlite?: NodeSqliteStorage) {
	let deleteAllCalls = 0;
	const context = makeDurableObjectState({
		onDeleteAll: async () => {
			deleteAllCalls++;
			await sqlite?.deleteAll();
		},
	});
	if (sqlite) Object.defineProperties(context.storage, {
		sql: { value: sqlite.sql },
		transactionSync: { value: sqlite.transactionSync.bind(sqlite) },
	});
	const server = new VaultRuntime({
		storage: context.storage as never,
		sockets: {
			sockets: () => [],
			createPair: () => { throw new Error("socket pair is replaced by test runtime"); },
			accept: () => {},
			upgradeResponse: () => { throw new Error("socket response is replaced by test runtime"); },
		},
		alarms: {
			setAlarm: async (scheduledTime) => { await context.storage.setAlarm(scheduledTime); },
			deleteAlarm: async () => { await context.storage.deleteAlarm(); },
		},
		execution: { waitUntil: (task) => { context.waitUntil(task); } },
	});
	const store = new RuntimeStore();
	const accepted: Array<{ documentId: string; kind: "root" | "body"; documentEpoch: number; deviceId: string }> = [];
	const closed: string[] = [];
	const settingsReads: string[] = [];
	Object.defineProperties(server, {
		bootstrap: {
			value: { forDevice: () => ({
				bodyState: (_bootstrapId: string, bodyId: string) => ({
					bodyId,
					bodyEpoch: bodyId.endsWith("1") ? 2 : 3,
					generation: bodyId.endsWith("1") ? 7 : 8,
					encodedState: new Uint8Array(bodyId.endsWith("1") ? [1, 2] : [3, 4]),
				}),
			}) },
		},
		settings: {
			value: {
				getEnvironment: (configKey: string) => {
					settingsReads.push(configKey);
					return { ok: true, value: { seeded: false } };
				},
			},
			writable: true,
		},
		store: { value: store, writable: true },
		lifecycle: { value: { activeBodyHead: (bodyId: string) => bodyId === "body-runtime-0001" ? {} : null } },
		sockets: {
			value: {
				accept: (documentId: string, kind: "root" | "body", documentEpoch: number, actor: VaultActorContext) => {
					accepted.push({ documentId, kind, documentEpoch, deviceId: actor.deviceId });
					return new Response(null, { status: 204 });
				},
				closeAll: (reason: string) => {
					closed.push(reason);
				},
			},
		},
	});
	return { server, store, accepted, closed, settingsReads, deleteAllCalls: () => deleteAllCalls };
}

function request(path: string, init: RequestInit = {}, trusted = true): Request {
	const headers = trusted ? actorHeaders(ACTOR) : new Headers();
	new Headers(init.headers).forEach((value, name) => headers.set(name, value));
	headers.set("x-yaos-vault-id", VAULT_ID);
	if (!headers.has("x-yaos-vault-generation")) {
		headers.set("x-yaos-vault-generation", GENERATION);
	}
	return new Request(`https://internal${path}`, { ...init, headers });
}

s.test("provisioning is explicit, idempotent, and generation-fenced", async () => {
	const { server } = makeServer();
	assert.equal((await server.fetch(request("/status"))).status, 409);
	const first = await server.fetch(request("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) }));
	assert.equal(first.status, 201);
	assert.equal((await first.json() as { created: boolean }).created, true);
	const replay = await server.fetch(request("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) }));
	assert.equal(replay.status, 200);
	assert.equal((await replay.json() as { created: boolean }).created, false);
	const status = await server.fetch(request("/status"));
	assert.equal((await status.json() as { vaultGeneration: string }).vaultGeneration, GENERATION);
});

s.test("a different generation cannot claim an already-provisioned DO identity", async () => {
	const { server } = makeServer();
	const first = await server.fetch(request("/__yaos/provision", {
		method: "POST",
		body: JSON.stringify({ vaultGeneration: GENERATION }),
	}));
	assert.equal(first.status, 201);
	await assert.rejects(server.fetch(request("/__yaos/provision", {
		method: "POST",
		body: JSON.stringify({ vaultGeneration: "generation-runtime-0002" }),
	})), /vault generation mismatch/, "one DO identity cannot be reprovisioned as another generation");
	const status = await server.fetch(request("/status"));
	assert.equal((await status.json() as { vaultGeneration: string }).vaultGeneration, GENERATION);
});

s.test("root/body socket runtime requires trusted device identity and exact body authority", async () => {
	const { server, store, accepted } = makeServer();
	await server.fetch(request("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) }));
	assert.equal(store.vaultAdmissionActive(VAULT_ID, GENERATION), true);
	assert.equal((await server.fetch(request("/ws/root", { headers: { Upgrade: "websocket" } }, false))).status, 401);
	const stale = await server.fetch(request("/ws/root", { headers: { Upgrade: "websocket", "x-yaos-device-credential-revision": "2" } }));
	assert.equal(stale.status, 401);
	assert.deepEqual(await stale.json(), { error: "unauthorized", reason: "authority_superseded" });
	const headers = { Upgrade: "websocket", "x-yaos-device-id": "device-runtime-0001" };
	assert.equal((await server.fetch(request("/ws/root", { headers: { ...headers, "x-yaos-root-epoch": "1" } }))).status, 204);
	assert.equal((await server.fetch(request("/ws/body/body-runtime-0001", { headers: { ...headers, "x-yaos-body-epoch": "1" } }))).status, 204);
	assert.equal((await server.fetch(request("/ws/body/body-unknown-0001", { headers: { ...headers, "x-yaos-body-epoch": "1" } }))).status, 409);
	assert.deepEqual(accepted, [
		{ documentId: "root", kind: "root", documentEpoch: 1, deviceId: "device-runtime-0001" },
		{ documentId: "body-runtime-0001", kind: "body", documentEpoch: 1, deviceId: "device-runtime-0001" },
	]);
});

s.test("ordinary runtime requests reject a stale forwarded vault generation", async () => {
	const { server } = makeServer();
	await server.fetch(request("/__yaos/provision", {
		method: "POST",
		body: JSON.stringify({ vaultGeneration: GENERATION }),
	}));
	const stale = await server.fetch(request("/status", {
		headers: { "x-yaos-vault-generation": "generation-runtime-stale" },
	}));
	assert.equal(stale.status, 409);
	assert.deepEqual(await stale.json(), { error: "vault_generation_mismatch" });
});

s.test("vault deletion is fenced by generation before destructive storage access", async () => {
	const sqlite = NodeSqliteStorage.open(":memory:");
	try {
		const { server, store, closed, deleteAllCalls } = makeServer(sqlite);
		await server.fetch(request("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) }));
		const stale = await server.fetch(request("/__yaos/begin-vault-deletion", {
			method: "POST",
			body: JSON.stringify({ deletionId: "delete-runtime-0001", vaultGeneration: "generation-runtime-stale" }),
		}));
		assert.equal(stale.status, 400);
		assert.equal(store.deletion, null);
		assert.equal(deleteAllCalls(), 0);
		const begun = await server.fetch(request("/__yaos/begin-vault-deletion", {
			method: "POST",
			body: JSON.stringify({ deletionId: "delete-runtime-0001", vaultGeneration: GENERATION }),
		}));
		assert.equal(begun.status, 200);
		assert.deepEqual(store.deletion, { deletionId: "delete-runtime-0001", vaultGeneration: GENERATION });
		assert.deepEqual(closed, ["vault deleting"]);
		assert.equal((await server.fetch(request("/status"))).status, 410);
		assert.equal((await server.fetch(request("/__yaos/delete-all", { method: "POST" }))).status, 200);
		assert.equal(deleteAllCalls(), 1);
		assert.equal((await server.fetch(request("/__yaos/provision", {
			method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }),
		}))).status, 410, "durable deletion tombstone blocks reprovisioning after storage purge");
	} finally { sqlite.close(); }
});



s.test("bootstrap body batch is bounded and returns every requested body", async () => {
	const { server } = makeServer();
	await server.fetch(request("/__yaos/provision", {
		method: "POST",
		body: JSON.stringify({ vaultGeneration: GENERATION }),
	}));
	const headers = {
		"x-yaos-device-id": "device-runtime-0001",
		"content-type": "application/json",
	};
	const response = await server.fetch(request("/bootstrap/bootstrap-runtime-0001/bodies", {
		method: "POST",
		headers,
		body: JSON.stringify({ bodyIds: ["body-runtime-0001", "body-runtime-0002"] }),
	}));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "application/vnd.yaos.binary-envelope");
	assert.deepEqual(decodeBinaryEnvelope(new Uint8Array(await response.arrayBuffer())), {
		bodies: [
			{ bodyId: "body-runtime-0001", bodyEpoch: 2, generation: 7, encodedState: new Uint8Array([1, 2]) },
			{ bodyId: "body-runtime-0002", bodyEpoch: 3, generation: 8, encodedState: new Uint8Array([3, 4]) },
		],
	});
	const duplicate = await server.fetch(request("/bootstrap/bootstrap-runtime-0001/bodies", {
		method: "POST",
		headers,
		body: JSON.stringify({ bodyIds: ["body-runtime-0001", "body-runtime-0001"] }),
	}));
	assert.equal(duplicate.status, 400);
	assert.deepEqual(await duplicate.json(), { error: "duplicate_body_id" });
});
s.test("settings sidecar requires generation and trusted device authority without hydrating documents", async () => {
	const { server, store, settingsReads } = makeServer();
	await server.fetch(request("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) }));
	Object.defineProperty(server, "cache", {
		value: new Proxy({}, {
			get: () => {
				throw new Error("settings route hydrated a root/body document");
			},
		}),
	});
	const stale = await server.fetch(request("/settings-sync/.obsidian", {
		headers: {
			"x-yaos-device-id": "device-runtime-0001",
			"x-yaos-vault-generation": "generation-runtime-stale",
		},
	}));
	assert.equal(stale.status, 409);
	assert.deepEqual(settingsReads, []);
	const missing = await server.fetch(request("/settings-sync/.obsidian", {}, false));
	assert.equal(missing.status, 401);
	assert.deepEqual(await missing.json(), { error: "missing_trusted_actor" });
	assert.deepEqual(settingsReads, []);
	store.revokedDevices.add("device-runtime-revoked");
	const revoked = await server.fetch(request("/settings-sync/.obsidian", {
		headers: { "x-yaos-device-id": "device-runtime-revoked" },
	}));
	assert.equal(revoked.status, 409);
	assert.deepEqual(await revoked.json(), { error: "authority_superseded" });
	assert.deepEqual(settingsReads, []);
	const undeclaredFormat = await server.fetch(request("/settings-sync/.obsidian", {
		headers: { "x-yaos-device-id": "device-runtime-0001" },
	}));
	assert.equal(undeclaredFormat.status, 426);
	assert.deepEqual(decodeBinaryEnvelope(new Uint8Array(await undeclaredFormat.arrayBuffer())), {
		error: "update_required",
		reason: "settings_format_mismatch",
		clientSettingsFormatVersion: null,
		serverSettingsFormatVersion: 2,
	});
	assert.deepEqual(settingsReads, []);
	const staleFormat = await server.fetch(request("/settings-sync/.obsidian?settingsFormatVersion=1", {
		headers: { "x-yaos-device-id": "device-runtime-0001" },
	}));
	assert.equal(staleFormat.status, 426);
	assert.deepEqual(settingsReads, []);
	const duplicateFormat = await server.fetch(request("/settings-sync/.obsidian?settingsFormatVersion=2&settingsFormatVersion=2", {
		headers: { "x-yaos-device-id": "device-runtime-0001" },
	}));
	assert.equal(duplicateFormat.status, 426);
	assert.deepEqual(settingsReads, []);
	const admitted = await server.fetch(request("/settings-sync/.obsidian?settingsFormatVersion=2", {
		headers: { "x-yaos-device-id": "device-runtime-0001" },
	}));
	assert.equal(admitted.status, 200);
	assert.deepEqual(decodeBinaryEnvelope(new Uint8Array(await admitted.arrayBuffer())), { seeded: false });
	assert.deepEqual(settingsReads, [principalSettingsKey(ACTOR.principalId, ".obsidian")]);
});
await s.done();
