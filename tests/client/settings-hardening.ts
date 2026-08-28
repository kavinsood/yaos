import { isServerCapabilities } from "../../src/runtime/capabilityUpdateService";
import {
	attachmentSizeCapKB,
	MAX_ATTACHMENT_SIZE_KB,
	readVaultSyncSettings,
} from "../../src/settings/settingsStore";
import { suite } from "../harness.ts";

const s = suite("settings-hardening");

s.section("Test 1: attachment max is capped to the server upload contract");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: MAX_ATTACHMENT_SIZE_KB + 1,
	});
	s.check(settings.maxAttachmentSizeKB === MAX_ATTACHMENT_SIZE_KB, "oversized attachment setting is capped");
	s.check(migrated, "oversized attachment setting marks settings as migrated");
}

s.section("Test 2: invalid attachment max falls back inside the valid range");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: -10,
	});
	s.check(settings.maxAttachmentSizeKB >= 1, "invalid attachment setting is repaired to a positive value");
	s.check(settings.maxAttachmentSizeKB <= MAX_ATTACHMENT_SIZE_KB, "repaired attachment setting stays under cap");
	s.check(migrated, "invalid attachment setting marks settings as migrated");
}

s.section("Test 3: valid attachment max is preserved");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		maxAttachmentSizeKB: 4096,
	});
	s.check(settings.maxAttachmentSizeKB === 4096, "valid attachment setting is preserved");
	s.check(!migrated, "valid attachment setting does not force migration");
}

s.section("Test 4: server capability can lower the effective attachment cap");
{
	s.check(
		attachmentSizeCapKB(5 * 1024 * 1024) === 5 * 1024,
		"5 MB server capability lowers effective attachment cap to 5120 KB",
	);
	s.check(
		attachmentSizeCapKB(50 * 1024 * 1024) === MAX_ATTACHMENT_SIZE_KB,
		"larger server capability does not raise the client above the built-in ceiling",
	);
	s.check(
		attachmentSizeCapKB(null) === MAX_ATTACHMENT_SIZE_KB,
		"missing server capability falls back to built-in ceiling",
	);
}

s.section("Unsupported shared-token state is erased without inventing enrollment");
{
	const { settings, migrated } = readVaultSyncSettings({
		host: "https://legacy.example",
		token: "old-shared-secret",
		vaultId: "old-vault",
	});
	s.check(migrated, "unsupported credential is removed on persistence");
	s.check(settings.host === "https://legacy.example", "host remains available for explicit re-enrollment");
	s.check(settings.deviceToken === "", "shared token is never promoted to a device token");
	s.check(settings.vaultId === "", "unsupported vault membership is cleared");
	s.check(settings.deviceId === "", "unsupported state has no invented device id");
	s.check(settings.vaultGeneration === "", "unsupported state has no invented vault generation");
	s.check(!("token" in settings), "shared token property is absent from runtime settings");
}

s.section("Enrollment requires the complete generation-scoped identity");
{
	const complete = readVaultSyncSettings({
		host: "https://sync.example",
		deviceToken: "device-secret",
		vaultId: "vault-1",
		deviceId: "device-1",
		vaultGeneration: "generation-1",
	}).settings;
	s.check(complete.deviceToken === "device-secret", "complete enrollment is preserved");

	const incomplete = readVaultSyncSettings({
		host: "https://sync.example",
		deviceToken: "device-secret",
		vaultId: "vault-1",
	}).settings;
	s.check(incomplete.host === "https://sync.example", "host remains available for re-enrollment");
	s.check(incomplete.deviceToken === "", "incomplete credential is cleared");
	s.check(incomplete.vaultId === "", "incomplete vault id is cleared");
	s.check(incomplete.deviceId === "", "missing device id leaves the folder unenrolled");
}
s.section("Settings sync preferences default safely and reject invalid persisted values");
{
	s.check(readVaultSyncSettings({}).settings.settingsSyncEnabled, "settings sync is enabled for seed resolution by default");
	s.check(!readVaultSyncSettings({}).settings.settingsSyncAutoInstall, "automatic environment installs require consent");
	const repaired = readVaultSyncSettings({
		settingsSyncEnabled: "yes",
		settingsSyncAutoInstall: 1,
		settingsSyncDeferred: null,
	} as never);
	s.check(repaired.settings.settingsSyncEnabled, "invalid master switch resets to the enabled default");
	s.check(!repaired.settings.settingsSyncAutoInstall, "invalid install consent resets off");
	s.check(!repaired.settings.settingsSyncDeferred, "invalid deferral state resets");
	s.check(repaired.migrated, "invalid settings sync preferences are persisted after repair");
}


s.section("Settings capability is optional for note sync");
{
	const notesOnly = {
		claimed: true,
		attachments: false,
		snapshots: false,
		serverVersion: "1.0.0",
		schemaVersion: 4,
		storageFormatVersion: 1,
		protocolVersion: 1,
		snapshotFormatVersion: 2,
		recoveryJobs: false,
		updateProvider: null,
		updateRepoUrl: null,
	};
	s.check(isServerCapabilities(notesOnly), "missing settings capability does not invalidate note capabilities");
	s.check(
		isServerCapabilities({ ...notesOnly, settingsSync: true, settingsFormatVersion: 2 }),
		"unknown settings format remains a valid note capability envelope",
	);
}
await s.done();
