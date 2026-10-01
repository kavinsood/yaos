import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemObjectStore } from "../../packages/server-node/src/objectStore";
import { NodeDatabaseSet } from "../../packages/server-node/src/storage";
import { NodeSocketHub, NodeSocketRegistry } from "../../packages/server-node/src/socketHost";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, type VaultActorContext } from "../../server/src/collaboration";
import type { VaultRuntimeStoragePort } from "../../server/src/platformPorts";
import { VaultRuntime } from "../../server/src/server";
import { actorHeaders } from "../../server/src/vaultAuthority";
import type { VaultAuthoritySubjectChange } from "../../server/src/vaultDocumentStore";
import { blobKey } from "../../server/src/vaultObjectStore";
import { VaultStore } from "../../server/src/vaultStore";
import { suite } from "../harness";

const tests = suite("blob-repair-runtime");
const vaultId = "blob-repair-runtime-vault";
const generation = "blob-repair-runtime-generation";
const good = new TextEncoder().encode("runtime attachment bytes that must survive repair");
const hash = createHash("sha256").update(good).digest("hex");
const key = blobKey(vaultId, generation, hash);

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "blob-repair-runtime-"));
	const databases = new NodeDatabaseSet(directory);
	const hub = new NodeSocketHub();
	try {
		const storage = databases.vault(vaultId);
		const store = new VaultStore(storage);
		const objects = new FilesystemObjectStore(join(directory, "objects"));
		const actor: VaultActorContext = {
			vaultId, vaultGeneration: generation, principalId: "repair-member", membershipRevision: 1,
			deviceId: "repair-device", deviceCredentialRevision: 1, role: "member",
			policyVersion: COLLABORATION_POLICY_VERSION, capabilityDigest: await capabilityDigestForRole("member"),
		};
		const runtime = new VaultRuntime({
			storage: storage as unknown as VaultRuntimeStoragePort,
			sockets: new NodeSocketRegistry(hub, { message() {}, close() {}, error() {} }),
			alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} },
			execution: { waitUntil() {} }, objectStore: objects,
		});
		const provisioned = await runtime.fetch(new Request("https://internal/__yaos/provision", {
			method: "POST", headers: { "Content-Type": "application/json", "x-yaos-vault-id": vaultId },
			body: JSON.stringify({ vaultGeneration: generation }),
		}));
		assert.equal(provisioned.status, 201);
		const owner: VaultActorContext = { ...actor, principalId: "repair-owner", deviceId: "repair-owner-device",
			role: "owner", capabilityDigest: await capabilityDigestForRole("owner") };
		const subjects: VaultAuthoritySubjectChange[] = [owner, actor].flatMap((entry) => [
			{ principalId: entry.principalId, role: entry.role, state: "active", membershipRevision: 1,
				policyVersion: entry.policyVersion, capabilityDigest: entry.capabilityDigest,
				displayName: entry.principalId, colorSeed: entry.principalId },
			{ deviceId: entry.deviceId, principalId: entry.principalId, state: "active", credentialRevision: 1 },
		]);
		store.installAuthorityFence({ changeId: "repair-initial-authority", vaultId, vaultGeneration: generation,
			subjectDigest: "repair-initial-authority-digest", subjects });
		store.activateVaultAdmission(vaultId, generation);
		const request = (path: string, body?: unknown, currentActor: VaultActorContext | null = actor) => {
			const headers = currentActor ? actorHeaders(currentActor) : new Headers();
			headers.set("x-yaos-vault-id", vaultId);
			headers.set("x-yaos-vault-generation", generation);
			return new Request(`https://internal${path}`, { method: "POST", headers,
				body: body === undefined ? undefined : JSON.stringify(body) });
		};
		return { directory, store, objects, runtime, actor, request,
			close: async () => { hub.clear(); databases.close(); await rm(directory, { recursive: true, force: true }); } };
	} catch (error) {
		hub.clear(); databases.close(); await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

tests.test("repair validates actor and hash before object access", async () => {
	const current = await fixture();
	try {
		for (const [request, expected] of [
			[current.request(`/blobs/${hash}/repair`, undefined, null), 401],
			[current.request("/blobs/invalid/repair"), 400],
			[current.request(`/blobs/${hash}/repair`, undefined, { ...current.actor, deviceCredentialRevision: 2 }), 409],
		] as const) assert.equal((await current.runtime.fetch(request)).status, expected);
		assert.equal(current.store.isBlobSuspect(key), false);
	} finally { await current.close(); }
});

tests.test("repair coalesces reports without deletion; suspect reads and verified replacement clear it", async () => {
	const current = await fixture();
	try {
		assert.equal(await current.objects.createOnly(key, good), "created");
		const location = join(current.directory, "objects", key);
		const corrupted = await readFile(location);
		corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
		await writeFile(location, corrupted);
		const response = await current.runtime.fetch(current.request(`/blobs/${hash}/repair`));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { status: "suspect" });
		assert.equal(current.store.isBlobSuspect(key), true);
		assert.deepEqual(await readFile(location), corrupted);
		const repeated = await current.runtime.fetch(current.request(`/blobs/${hash}/repair`));
		assert.deepEqual(await repeated.json(), { status: "suspect" });
		const suspects = await current.runtime.fetch(current.request("/blobs/suspects", { keys: [key, key] }));
		assert.deepEqual(await suspects.json(), { suspect: [key, key] });
		const invalid = await current.objects.head(key);
		assert.equal(await current.objects.createOnlyVerifiedStream(key, new Blob([good]).stream(),
			{ length: good.length, sha256: hash, replaceEtag: invalid?.etag }), "created");
		const cleared = await current.runtime.fetch(current.request("/blobs/clear-suspect", { key }));
		assert.equal(cleared.status, 200);
		assert.equal(current.store.isBlobSuspect(key), false);
		const after = await current.runtime.fetch(current.request("/blobs/suspects", { keys: [key] }));
		assert.deepEqual(await after.json(), { suspect: [] });
		assert.equal((await current.objects.head(key))?.sha256, hash);
	} finally { await current.close(); }
});

await tests.done();
