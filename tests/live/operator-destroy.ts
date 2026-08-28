import WebSocket from "ws";
import { parseFatalFrame, type FatalFrame } from "./fatalFrame.ts";
import { deviceBearerHeaders, fetchSocketTicket, requireLiveIdentityContext } from "./liveIdentity.ts";

const { deviceA, deviceB, operatorCookie, settingsConfigKey } = requireLiveIdentityContext();
const vaultPath = `/operator/vaults/${encodeURIComponent(deviceA.vaultId)}`;
const operatorHeaders = { Cookie: operatorCookie };
const staleTicket = (await fetchSocketTicket(deviceA)).ticket;
const settingsPath = `/vault/${encodeURIComponent(deviceA.vaultId)}/settings-sync/${encodeURIComponent(settingsConfigKey)}?settingsFormatVersion=1`;

async function jsonBody(response: Response): Promise<Record<string, unknown> | null> {
	const value: unknown = await response.clone().json().catch(() => null);
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

async function destroy(): Promise<{ response: Response; body: Record<string, unknown> | null }> {
	const response = await fetch(`${deviceA.host}${vaultPath}`, { method: "DELETE", headers: operatorHeaders });
	const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
	return { response, body };
}

const settingsBeforeDestroy = await fetch(`${deviceA.host}${settingsPath}`, {
	headers: deviceBearerHeaders(deviceA),
});
const settingsBeforeBody = await jsonBody(settingsBeforeDestroy);
assert(
	settingsBeforeDestroy.status === 200
		&& settingsBeforeBody?.seeded === true
		&& settingsBeforeBody.envRev === 2,
	"operator destroy starts with the exact seeded settings generation from the two-device suite",
);
console.log("\n--- Operator generation-scoped destroy smoke ---");
let result = await destroy();
assert(result.response.status === 202, `operator destroy enters bounded purge (${result.response.status})`);
let pending = result.body?.pending as Record<string, unknown> | undefined;
assert(typeof pending?.vaultGeneration === "string", "pending destroy exposes its vault generation fence");
assert(pending.purgeJobId === `purge:${deviceA.vaultId}:${pending.vaultGeneration}`, "purge job identity is scoped to the exact vault generation");
assert(["pending", "queued", "purging", "retrying", "complete"].includes(String(pending.purgeState)), `purge status is explicit (${String(pending.purgeState)})`);
const status = await fetch(`${deviceA.host}${vaultPath}/deletion`, { headers: operatorHeaders });
const statusBody = await status.json().catch(() => null) as { pending?: Record<string, unknown> } | null;
assert(status.status === 200 && statusBody?.pending?.purgeJobId === pending.purgeJobId, "operator deletion status preserves the generation-scoped retry obligation");
result = await destroy();
assert(result.response.status === 202 || result.response.status === 200, "repeating destroy retries idempotently instead of creating another purge generation");
if (result.response.status === 202) {
	pending = result.body?.pending as Record<string, unknown> | undefined;
	assert(pending?.purgeJobId === statusBody?.pending?.purgeJobId, "destroy retry retains the original purge job identity");
}

const deadline = Date.now() + 15_000;
while (result.response.status !== 200 && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 100));
	result = await destroy();
}
assert(result.response.status === 200 && result.body?.completed === true, `generation purge and SQL deletion complete (${result.response.status})`);

for (const [label, identity] of [["A", deviceA], ["B", deviceB]] as const) {
	const ticket = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/auth/ticket`, {
		method: "POST",
		headers: deviceBearerHeaders(identity),
	});
	assert(ticket.status === 401, `destroy revokes device ${label} membership`);
	const root = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/root`, {
		headers: deviceBearerHeaders(identity),
	});
	assert(root.status === 401 || root.status === 404 || root.status === 409, `device ${label} cannot read root storage after purge (${root.status})`);
	const body = await fetch(`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/heads`, {
		headers: deviceBearerHeaders(identity),
	});
	assert(body.status === 401 || body.status === 404 || body.status === 409, `device ${label} cannot read catalog storage after purge (${body.status})`);
	const settings = await fetch(`${identity.host}${settingsPath}`, {
		headers: deviceBearerHeaders(identity),
	});
	assert(settings.status === 401 || settings.status === 404 || settings.status === 409, `device ${label} cannot read settings storage after purge (${settings.status})`);
}

const staleSocketFrame = await new Promise<FatalFrame | null>((resolve, reject) => {
	const staleProbe = new URL(`${deviceA.host}/vault/${encodeURIComponent(deviceA.vaultId)}/ws/root`);
	staleProbe.protocol = staleProbe.protocol === "https:" ? "wss:" : "ws:";
	staleProbe.searchParams.set("ticket", staleTicket);
	staleProbe.searchParams.set("schemaVersion", "4");
	staleProbe.searchParams.set("protocolVersion", "1");
	const socket = new WebSocket(staleProbe);
	let frame: FatalFrame | null = null;
	const timeout = setTimeout(() => {
		socket.terminate();
		reject(new Error("post-destroy socket probe timed out"));
	}, 5_000);
	socket.on("message", (data) => {
		const text = data.toString();
		frame = parseFatalFrame(text.startsWith("__YPS:") ? text.slice(6) : text) ?? frame;
	});
	socket.on("close", () => {
		clearTimeout(timeout);
		resolve(frame);
	});
	socket.on("error", (error) => {
		clearTimeout(timeout);
		reject(error);
	});
});
assert(staleSocketFrame?.code === "unauthorized", "pre-destroy socket ticket is rejected after purge completion");

const freshVaultResponse = await fetch(`${deviceA.host}/operator/vaults`, {
	method: "POST",
	headers: { ...operatorHeaders, "Content-Type": "application/json" },
	body: JSON.stringify({ name: "Fresh settings generation" }),
});
const freshVaultBody = await jsonBody(freshVaultResponse);
const freshVault = freshVaultBody?.vault as Record<string, unknown> | undefined;
assert(
	freshVaultResponse.status === 200
		&& typeof freshVault?.vaultId === "string"
		&& typeof freshVault.vaultGeneration === "string",
	"operator provisions a fresh vault generation after destroy",
);
assert(freshVault.vaultGeneration !== pending?.vaultGeneration, "fresh vault uses a generation distinct from the destroyed settings state");
const freshPairingResponse = await fetch(`${deviceA.host}/operator/pairing-codes`, {
	method: "POST",
	headers: { ...operatorHeaders, "Content-Type": "application/json" },
	body: JSON.stringify({ vaultId: freshVault.vaultId, purpose: "device" }),
});
const freshPairing = await jsonBody(freshPairingResponse);
assert(freshPairingResponse.status === 200 && typeof freshPairing?.pairingCode === "string", "operator mints enrollment for the fresh generation");
const freshDeviceId = crypto.randomUUID().replaceAll("-", "");
const freshDeviceToken = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
const freshEnrollment = await fetch(`${deviceA.host}/enroll`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		pairingCode: freshPairing.pairingCode,
		enrollmentRequestId: crypto.randomUUID().replaceAll("-", ""),
		deviceId: freshDeviceId,
		deviceToken: freshDeviceToken,
		deviceName: "live-fresh-settings-generation",
	}),
});
const freshEnrollmentBody = await jsonBody(freshEnrollment);
assert(
	freshEnrollment.status === 200
		&& freshEnrollmentBody?.vaultId === freshVault.vaultId
		&& freshEnrollmentBody.vaultGeneration === freshVault.vaultGeneration,
	"fresh device enrollment is fenced to the new vault generation",
);
const freshSettings = await fetch(
	`${deviceA.host}/vault/${encodeURIComponent(String(freshVault.vaultId))}/settings-sync/${encodeURIComponent(settingsConfigKey)}?settingsFormatVersion=1`,
	{ headers: { Authorization: `Bearer ${freshDeviceToken}` } },
);
const freshSettingsBody = await jsonBody(freshSettings);
assert(
	freshSettings.status === 200
		&& JSON.stringify(freshSettingsBody) === JSON.stringify({ seeded: false }),
	"fresh vault generation starts with no inherited settings environment",
);
console.log("\n✓ Operator destroy revoked membership and completed generation-scoped purge");
