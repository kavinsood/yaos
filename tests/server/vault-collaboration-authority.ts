import { strict as assert } from "node:assert";
import { capabilityDigestForRole, COLLABORATION_POLICY_VERSION, authorizeVaultAction, type VaultActorContext } from "../../server/src/collaboration";
import { principalSettingsKey } from "../../server/src/settingsSyncStore";
import { actorHeaders, parseVaultActor, stripActorHeaders } from "../../server/src/vaultAuthority";
import { handleVaultRuntimeRoute } from "../../server/src/routes/vault";
import { makeConfigNamespace, makeEnv, makeVaultSyncNamespace } from "../mocks/workerEnv.ts";
import { suite } from "../harness.ts";

const s = suite("vault-collaboration-authority");
const VAULT_ID = "vault-collaboration-0001";
const GENERATION = "generation-collaboration-0001";

async function actor(role: "owner" | "member" = "member"): Promise<VaultActorContext> {
	return {
		vaultId: VAULT_ID,
		vaultGeneration: GENERATION,
		principalId: "principal-member-0001",
		membershipRevision: 3,
		deviceId: "device-member-0001",
		deviceName: "Member laptop",
		deviceCredentialRevision: 2,
		role,
		policyVersion: COLLABORATION_POLICY_VERSION,
		capabilityDigest: await capabilityDigestForRole(role),
	};
}

s.test("trusted actor headers round-trip every authority revision", async () => {
	const expected = await actor();
	const headers = actorHeaders(expected);
	const request = new Request("https://internal/body/example", { headers });
	assert.deepEqual(parseVaultActor(request, VAULT_ID, GENERATION), expected);
	headers.set("x-yaos-membership-revision", "4");
	assert.equal(parseVaultActor(new Request("https://internal", { headers }), VAULT_ID, GENERATION)?.membershipRevision, 4);
	headers.set("x-yaos-membership-revision", "0");
	assert.equal(parseVaultActor(new Request("https://internal", { headers }), VAULT_ID, GENERATION), null);
});

s.test("untrusted actor headers are removed before the worker installs its context", async () => {
	const headers = actorHeaders(await actor("owner"));
	stripActorHeaders(headers);
	let count = 0;
	headers.forEach(() => { count++; });
	assert.equal(count, 0);
});

s.test("owner and member share content authority but governance stays owner-only", async () => {
	const member = await actor("member");
	const owner = await actor("owner");
	assert.deepEqual(authorizeVaultAction(member, "vault.content.write"), { allowed: true });
	assert.deepEqual(authorizeVaultAction(owner, "vault.content.write"), { allowed: true });
	assert.deepEqual(authorizeVaultAction(member, "vault.members.manage"), { allowed: false, reason: "capability_missing" });
	assert.deepEqual(authorizeVaultAction(owner, "vault.members.manage"), { allowed: true });
});

s.test("personal settings namespaces cannot collide across principals", () => {
	const alice = principalSettingsKey("principal-alice-0001", "obsidian");
	const bob = principalSettingsKey("principal-bob-0001", "obsidian");
	assert.notEqual(alice, bob);
	assert.equal(alice.endsWith("\0obsidian"), true);
	assert.throws(() => principalSettingsKey("", "obsidian"));
});

s.test("revoked outcome admission forwards only a trusted bounded claim", async () => {
	const expected = await actor("member");
	const forwarded: Request[] = [];
	const config = makeConfigNamespace(async (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/__yaos/vault") return Response.json({ vault: { vaultId: VAULT_ID, vaultGeneration: GENERATION, state: "active" } });
		if (path === "/__yaos/collaboration/authorize-outcome") return Response.json({
			device: { deviceId: expected.deviceId, name: expected.deviceName, vaultId: VAULT_ID },
			principal: { principalId: expected.principalId, vaultId: VAULT_ID },
			membership: { principalId: expected.principalId, vaultId: VAULT_ID, role: "member", state: "revoked", revision: 4 },
			actor: { ...expected, membershipRevision: 4, deviceCredentialRevision: 3 },
		});
		throw new Error(`unexpected config route ${path}`);
	});
	const sync = makeVaultSyncNamespace(async (request) => {
		forwarded.push(request);
		return Response.json({ committed: true });
	});
	const response = await handleVaultRuntimeRoute(new Request(
		`https://example.test/vault/${VAULT_ID}/operations/op-1/outcome?requestDigest=${"a".repeat(64)}&membershipRevision=3&deviceCredentialRevision=2`,
		{ headers: { authorization: "Bearer retained-revoked-token", "x-yaos-outcome-claim": "spoofed" } },
	), makeEnv({ YAOS_CONFIG: config, YAOS_SYNC: sync }), VAULT_ID, "/operations/op-1/outcome");
	assert.equal(response.status, 200);
	assert.equal(forwarded[0]?.headers.get("authorization"), null);
	assert.equal(forwarded[0]?.headers.get("x-yaos-outcome-claim"), "1");
	assert.equal(forwarded[0]?.headers.get("x-yaos-device-id"), expected.deviceId);
});

await s.done();
