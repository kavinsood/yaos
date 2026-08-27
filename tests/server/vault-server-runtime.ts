import { strict as assert } from "node:assert";
import { VaultSyncServer } from "../../server/src/server";
import { makeDurableObjectState, makeEnv } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("vault-server-runtime");
const VAULT_ID = "vault-runtime-0001";
const GENERATION = "generation-runtime-0001";

class RuntimeStore {
	metadata: { vaultId: string; vaultGeneration: string; schemaVersion: number; storageFormatVersion: number; provisionedAt: number } | null = null;
	deletion: { deletionId: string; vaultGeneration: string } | null = null;
	provisionVault(vaultId: string, vaultGeneration: string): object {
		if (this.metadata) {
			if (this.metadata.vaultId !== vaultId || this.metadata.vaultGeneration !== vaultGeneration) throw new Error("vault generation mismatch");
			return { ...this.metadata, created: false };
		}
		this.metadata = { vaultId, vaultGeneration, schemaVersion: 4, storageFormatVersion: 1, provisionedAt: 1 };
		return { ...this.metadata, created: true };
	}
	vaultMetadata() { return this.metadata; }
	vaultDeletionBegun(vaultGeneration: string): boolean { return this.deletion?.vaultGeneration === vaultGeneration; }
	beginVaultDeletion(deletionId: string, vaultGeneration: string): { captureJobIds: string[]; restoreIds: string[] } {
		if (this.metadata?.vaultGeneration !== vaultGeneration) throw new Error("vault generation mismatch");
		this.deletion = { deletionId, vaultGeneration };
		return { captureJobIds: [], restoreIds: [] };
	}
	currentSequence(): number { return 1; }
	journalFloor(): number { return 0; }
	activePins(): unknown[] { return []; }
}

function makeServer() {
	let deleteAllCalls = 0;
	const context = makeDurableObjectState({
		onDeleteAll: () => {
			deleteAllCalls++;
		},
	});
	const server = new VaultSyncServer(context, makeEnv());
	const store = new RuntimeStore();
	const accepted: Array<{ documentId: string; kind: "root" | "body"; deviceId: string }> = [];
	const closed: string[] = [];
	Object.defineProperties(server, {
		store: { value: store },
		lifecycle: { value: { activeBodyHead: (bodyId: string) => bodyId === "body-runtime-0001" ? {} : null } },
		sockets: {
			value: {
				accept: (documentId: string, kind: "root" | "body", deviceId: string) => {
					accepted.push({ documentId, kind, deviceId });
					return new Response(null, { status: 204 });
				},
				closeAll: (reason: string) => {
					closed.push(reason);
				},
			},
		},
	});
	return { server, store, accepted, closed, deleteAllCalls: () => deleteAllCalls };
}

function request(path: string, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
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
	const collision = await server.fetch(request("/__yaos/provision", {
		method: "POST",
		body: JSON.stringify({ vaultGeneration: "generation-runtime-0002" }),
	}));
	assert.equal(collision.status, 500, "one DO identity cannot be reprovisioned as another generation");
	const status = await server.fetch(request("/status"));
	assert.equal((await status.json() as { vaultGeneration: string }).vaultGeneration, GENERATION);
});

s.test("root/body socket runtime requires trusted device identity and exact body authority", async () => {
	const { server, accepted } = makeServer();
	await server.fetch(request("/__yaos/provision", { method: "POST", body: JSON.stringify({ vaultGeneration: GENERATION }) }));
	assert.equal((await server.fetch(request("/ws/root", { headers: { Upgrade: "websocket" } }))).status, 401);
	const headers = { Upgrade: "websocket", "x-yaos-device-id": "device-runtime-0001" };
	assert.equal((await server.fetch(request("/ws/root", { headers }))).status, 204);
	assert.equal((await server.fetch(request("/ws/body/body-runtime-0001", { headers }))).status, 204);
	assert.equal((await server.fetch(request("/ws/body/body-unknown-0001", { headers }))).status, 409);
	assert.deepEqual(accepted, [
		{ documentId: "root", kind: "root", deviceId: "device-runtime-0001" },
		{ documentId: "body-runtime-0001", kind: "body", deviceId: "device-runtime-0001" },
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
	const { server, store, closed, deleteAllCalls } = makeServer();
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
});

await s.done();
