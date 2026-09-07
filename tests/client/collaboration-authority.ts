import { strict as assert } from "node:assert";
import {
	AuthorityCoordinator,
	AuthoritySupersededError,
	capabilitiesForRole,
	readVaultAuthoritySnapshot,
} from "../../src/collaboration/authority";
import { readVaultSyncSettings } from "../../src/settings/settingsStore";
import { suite } from "../harness.ts";

const s = suite("collaboration-authority");

function authority(role: "owner" | "member" = "member", membershipRevision = 3) {
	return readVaultAuthoritySnapshot({
		vaultId: "vault-one",
		vaultGeneration: "generation-one",
		principalId: "principal-alice",
		membershipRevision,
		deviceId: "device-laptop",
		deviceCredentialRevision: 2,
		role,
		policyVersion: 1,
		capabilityDigest: "digest-one",
		capabilities: capabilitiesForRole(role),
	});
}

s.test("owner and member are the only roles and capabilities are immutable", () => {
	assert.throws(() => readVaultAuthoritySnapshot({ ...authority(), role: "viewer" }), /invalid role/);
	const owner = authority("owner");
	assert.equal(owner.capabilities.includes("vault.members.invite"), true);
	assert.equal(authority("member").capabilities.includes("vault.members.invite"), false);
	assert.equal(Object.isFrozen(owner), true);
	assert.equal(Object.isFrozen(owner.capabilities), true);
});

s.test("authority epochs advance and stale work cannot cross a membership revision", () => {
	const coordinator = new AuthorityCoordinator(authority());
	const captured = coordinator.capture();
	const epochs: number[] = [];
	coordinator.subscribe((snapshot) => epochs.push(snapshot.epoch));
	coordinator.changing("ownership_transfer");
	coordinator.install(authority("member", 4));
	assert.deepEqual(epochs, [1, 2]);
	assert.throws(() => coordinator.assertCurrent(captured), AuthoritySupersededError);
	assert.equal(coordinator.has("vault.content.write"), true);
});

s.test("persisted enrollment requires the complete person and device authority tuple", () => {
	const complete = readVaultSyncSettings({
		host: "https://sync.example",
		deviceToken: "device-token",
		deviceName: "Laptop",
		principalDisplayName: "Alice",
		principalColorSeed: "alice-color",
		...authority(),
		vaultRole: "member",
		authorityCapabilities: [...capabilitiesForRole("member")],
	}).settings;
	assert.equal(complete.principalId, "principal-alice");
	const stale = readVaultSyncSettings({ ...complete, membershipRevision: 0 });
	assert.equal(stale.settings.deviceToken, "");
	assert.equal(stale.settings.principalId, "");
	assert.equal(stale.migrated, true);
});

await s.done();
