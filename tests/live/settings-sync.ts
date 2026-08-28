import { strict as nodeAssert } from "node:assert";
import { deviceBearerHeaders, type LiveIdentity, requireLiveIdentityContext } from "./liveIdentity.ts";
import { connectDocument, sha256Hex } from "./schema4Live.ts";

const { deviceA, deviceB, settingsConfigKey } = requireLiveIdentityContext();
const SETTINGS_FORMAT_VERSION = "1";
const DURABLE_BODY_ID = "body_redeploy_durability_0001";
const DURABLE_BODY_PATH = "redeploy-test.md";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
	nodeAssert.deepEqual(actual, expected, message);
	console.log(`  PASS  ${message}`);
}

function settingsUrl(
	identity: LiveIdentity,
	configKey: string,
	action?: string,
	formatDeclarations: readonly string[] = [SETTINGS_FORMAT_VERSION],
	vaultId = identity.vaultId,
): string {
	const url = new URL(`${identity.host}/vault/${encodeURIComponent(vaultId)}/settings-sync/${encodeURIComponent(configKey)}${action ? `/${action}` : ""}`);
	for (const value of formatDeclarations) url.searchParams.append("settingsFormatVersion", value);
	return url.toString();
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
	const value: unknown = await response.clone().json().catch(() => null);
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

async function getEnvironment(identity: LiveIdentity, configKey = settingsConfigKey): Promise<Record<string, unknown>> {
	const response = await fetch(settingsUrl(identity, configKey), { headers: deviceBearerHeaders(identity) });
	const body = await responseJson(response);
	assert(response.status === 200 && body !== null, `settings environment read succeeds for device ${identity.deviceId}`);
	return body;
}

async function put(
	identity: LiveIdentity,
	configKey: string,
	action: string,
	body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> | null }> {
	const response = await fetch(settingsUrl(identity, configKey, action), {
		method: "PUT",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify(body),
	});
	return { response, body: await responseJson(response) };
}

async function loadedDocuments(identity: LiveIdentity): Promise<string[]> {
	const response = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/diagnostics`, {
		headers: deviceBearerHeaders(identity),
	});
	const body = await responseJson(response);
	assert(response.status === 200 && Array.isArray(body?.loaded), "vault diagnostics are available around settings-only traffic");
	return (body.loaded as Array<{ documentId?: unknown }>).map((entry) => String(entry.documentId)).sort();
}

console.log("\n--- Two-device generation-scoped settings sidecar ---");
const loadedBefore = await loadedDocuments(deviceA);

const gateKey = `${settingsConfigKey}-format`;
assert(gateKey.length <= 64, "format-gate probe uses a bounded configuration key");
for (const probe of [
	{ label: "missing", declarations: [] as string[], client: null },
	{ label: "stale", declarations: ["0"], client: "0" },
	{ label: "duplicate", declarations: ["1", "1"], client: null },
]) {
	const response = await fetch(settingsUrl(deviceA, gateKey, "seed", probe.declarations), {
		method: "PUT",
		headers: deviceBearerHeaders(deviceA, { "Content-Type": "application/json" }),
		body: "{malformed-json-that-must-not-be-read",
	});
	assert(response.status === 426, `${probe.label} settings format is rejected before malformed body/store access`);
	assertDeepEqual(await responseJson(response), {
		error: "update_required",
		reason: "settings_format_mismatch",
		clientSettingsFormatVersion: probe.client,
		serverSettingsFormatVersion: 1,
	}, `${probe.label} settings format returns the exact upgrade contract`);
}
assertDeepEqual(await getEnvironment(deviceB, gateKey), { seeded: false }, "format failures leave their settings environment unseeded");

const appText = JSON.stringify({ liveSettingsSmoke: true, bounded: 1 });
const snippetV1 = "/* YAOS live settings seed */\n.yaos-live-settings { opacity: 0.91; }\n";
const snippetV2 = "/* YAOS live settings mutation from device B */\n.yaos-live-settings { opacity: 0.73; }\n";
const appBytes = new TextEncoder().encode(appText);
const snippetV1Bytes = new TextEncoder().encode(snippetV1);
const snippetV2Bytes = new TextEncoder().encode(snippetV2);
const appBodyBase64 = Buffer.from(appBytes).toString("base64");
const snippetV1BodyBase64 = Buffer.from(snippetV1Bytes).toString("base64");
const snippetV2BodyBase64 = Buffer.from(snippetV2Bytes).toString("base64");
const appHash = await sha256Hex(appBytes);
const snippetV1Hash = await sha256Hex(snippetV1Bytes);
const snippetV2Hash = await sha256Hex(snippetV2Bytes);
const calendarIntent = {
	id: "calendar",
	repo: "liamcain/obsidian-calendar-plugin",
	version: "1.5.10",
	enabled: true,
};

const seeded = await put(deviceA, settingsConfigKey, "seed", {
	files: [
		{ path: "app.json", sha256: appHash, bodyBase64: appBodyBase64 },
		{ path: "snippets/yaos-live-settings.css", sha256: snippetV1Hash, bodyBase64: snippetV1BodyBase64 },
	],
	intents: [calendarIntent],
	themes: [],
	pluginData: [],
});
assert(seeded.response.status === 200, `device A seeds the settings environment (${seeded.response.status})`);
assertDeepEqual(seeded.body, { ok: true, envRev: 1, rev: 1 }, "initial settings seed returns exact revision 1");

const expectedSeed = {
	seeded: true,
	envRev: 1,
	files: [
		{ path: "app.json", sha256: appHash, size: appBytes.byteLength, rev: 1, bodyBase64: appBodyBase64 },
		{ path: "snippets/yaos-live-settings.css", sha256: snippetV1Hash, size: snippetV1Bytes.byteLength, rev: 1, bodyBase64: snippetV1BodyBase64 },
	],
	intents: [{ ...calendarIntent, rev: 1 }],
	themes: [],
	tombstones: [],
	pluginData: [],
};
assertDeepEqual(await getEnvironment(deviceB), expectedSeed, "device B reads A's exact JSON, snippet, and plugin intent state");

const mutation = await put(deviceB, settingsConfigKey, "file", {
	path: "snippets/yaos-live-settings.css",
	sha256: snippetV2Hash,
	bodyBase64: snippetV2BodyBase64,
});
assert(mutation.response.status === 200, `device B mutates an allowlisted settings file (${mutation.response.status})`);
assertDeepEqual(mutation.body, { ok: true, envRev: 2, rev: 2 }, "device B mutation advances the exact environment and row revision");
const expectedMutation = {
	...expectedSeed,
	envRev: 2,
	files: [
		expectedSeed.files[0],
		{ path: "snippets/yaos-live-settings.css", sha256: snippetV2Hash, size: snippetV2Bytes.byteLength, rev: 2, bodyBase64: snippetV2BodyBase64 },
	],
};
assertDeepEqual(await getEnvironment(deviceA), expectedMutation, "device A observes device B's exact revision and body");

const wrongVault = await fetch(settingsUrl(deviceA, settingsConfigKey, undefined, [SETTINGS_FORMAT_VERSION], `${deviceA.vaultId}-wrong`), {
	headers: deviceBearerHeaders(deviceA),
});
assert(wrongVault.status === 401 && (await responseJson(wrongVault))?.error === "unauthorized", "device bearer cannot access settings under a different vault ID");

const pairingResponse = await fetch(`${deviceA.host}/vault/${encodeURIComponent(deviceA.vaultId)}/auth/pairing-code`, {
	method: "POST",
	headers: deviceBearerHeaders(deviceA, { "Content-Type": "application/json" }),
	body: JSON.stringify({ purpose: "device" }),
});
const pairing = await responseJson(pairingResponse);
assert(pairingResponse.status === 200 && typeof pairing?.pairingCode === "string", "device A mints a settings revocation probe enrollment");
const revokedDevice: LiveIdentity = {
	host: deviceA.host,
	vaultId: deviceA.vaultId,
	deviceId: crypto.randomUUID().replaceAll("-", ""),
	deviceToken: `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`,
};
const enrollment = await fetch(`${deviceA.host}/enroll`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		pairingCode: pairing.pairingCode,
		enrollmentRequestId: crypto.randomUUID().replaceAll("-", ""),
		deviceId: revokedDevice.deviceId,
		deviceToken: revokedDevice.deviceToken,
		deviceName: "live-settings-revoked",
	}),
});
const enrollmentBody = await responseJson(enrollment);
assert(enrollment.status === 200 && enrollmentBody?.deviceId === revokedDevice.deviceId, "settings revocation probe enrolls with its own device identity");
assertDeepEqual(await getEnvironment(revokedDevice), expectedMutation, "newly enrolled device can read the current settings generation");
const revoke = await fetch(`${revokedDevice.host}/vault/${encodeURIComponent(revokedDevice.vaultId)}/auth/device`, {
	method: "DELETE",
	headers: deviceBearerHeaders(revokedDevice),
});
assert(revoke.status === 200, "settings revocation probe revokes its membership");
const revokedRead = await fetch(settingsUrl(revokedDevice, settingsConfigKey), { headers: deviceBearerHeaders(revokedDevice) });
assert(revokedRead.status === 401 && (await responseJson(revokedRead))?.error === "unauthorized", "revoked device cannot access settings sidecar state");

const loadedAfter = await loadedDocuments(deviceA);
assertDeepEqual(loadedAfter, loadedBefore, "settings routes do not hydrate the root/body document cache");

const root = await connectDocument(deviceA, "root", "root");
const body = await connectDocument(deviceB, "body", DURABLE_BODY_ID);
try {
	assert(root.doc.getMap<string>("pathToId").get(DURABLE_BODY_PATH) === DURABLE_BODY_ID, "root socket remains healthy after settings traffic");
	assert(body.doc.getText("body").toString().startsWith("YAOS schema-4 SQL redeploy durability"), "body socket remains healthy after settings traffic");
} finally {
	body.destroy();
	root.destroy();
}

console.log("\n✓ Live two-device settings sidecar passed");
