import {
	attachmentSizeCapKB,
	MAX_ATTACHMENT_SIZE_KB,
	readVaultSyncSettings,
} from "../src/settings/settingsStore";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

console.log("\n--- Test 1: attachment max is capped to the server upload contract ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: MAX_ATTACHMENT_SIZE_KB + 1,
	});
	assert(settings.maxAttachmentSizeKB === MAX_ATTACHMENT_SIZE_KB, "oversized attachment setting is capped");
	assert(migrated, "oversized attachment setting marks settings as migrated");
}

console.log("\n--- Test 2: invalid attachment max falls back inside the valid range ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		maxAttachmentSizeKB: -10,
	});
	assert(settings.maxAttachmentSizeKB >= 1, "invalid attachment setting is repaired to a positive value");
	assert(settings.maxAttachmentSizeKB <= MAX_ATTACHMENT_SIZE_KB, "repaired attachment setting stays under cap");
	assert(migrated, "invalid attachment setting marks settings as migrated");
}

console.log("\n--- Test 3: valid attachment max is preserved ---");
{
	const { settings, migrated } = readVaultSyncSettings({
		attachmentSyncExplicitlyConfigured: true,
		maxAttachmentSizeKB: 4096,
	});
	assert(settings.maxAttachmentSizeKB === 4096, "valid attachment setting is preserved");
	assert(!migrated, "valid attachment setting does not force migration");
}

console.log("\n--- Test 4: server capability can lower the effective attachment cap ---");
{
	assert(
		attachmentSizeCapKB(5 * 1024 * 1024) === 5 * 1024,
		"5 MB server capability lowers effective attachment cap to 5120 KB",
	);
	assert(
		attachmentSizeCapKB(50 * 1024 * 1024) === MAX_ATTACHMENT_SIZE_KB,
		"larger server capability does not raise the client above the built-in ceiling",
	);
	assert(
		attachmentSizeCapKB(null) === MAX_ATTACHMENT_SIZE_KB,
		"missing server capability falls back to built-in ceiling",
	);
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
