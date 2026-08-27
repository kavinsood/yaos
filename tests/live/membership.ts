import {
	deviceBearerHeaders,
	fetchSocketTicket,
	type LiveIdentity,
	requireLiveIdentity,
} from "./liveIdentity.ts";

const identity = requireLiveIdentity();

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
	console.log(`  PASS  ${message}`);
}

interface PairingResponse {
	readonly pairingCode?: unknown;
	readonly expiresAt?: unknown;
	readonly purpose?: unknown;
}

interface EnrollmentResponse {
	readonly host?: unknown;
	readonly deviceToken?: unknown;
	readonly vaultId?: unknown;
	readonly deviceId?: unknown;
	readonly deviceName?: unknown;
}

console.log("\n--- Live membership: one-use pairing code ---");

const pairingResponse = await fetch(
	`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/auth/pairing-code`,
	{
		method: "POST",
		headers: deviceBearerHeaders(identity, { "Content-Type": "application/json" }),
		body: JSON.stringify({ purpose: "device" }),
	},
);
assert(pairingResponse.status === 200, `enrolled device can mint a pairing code (got ${pairingResponse.status})`);
const pairing = (await pairingResponse.json()) as PairingResponse | null;
assert(typeof pairing?.pairingCode === "string" && pairing.pairingCode.length > 0, "pairing response contains a code");
assert(typeof pairing.expiresAt === "number" && pairing.expiresAt > Date.now(), "pairing response contains a future expiry");
assert(pairing.purpose === "device", "pairing response preserves the device purpose");

const enrollBody = JSON.stringify({ pairingCode: pairing.pairingCode, deviceName: "live-secondary" });
const firstEnrollment = await fetch(`${identity.host}/enroll`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: enrollBody,
});
assert(firstEnrollment.status === 200, `fresh pairing code enrolls one device (got ${firstEnrollment.status})`);
const enrolled = (await firstEnrollment.json()) as EnrollmentResponse | null;
const enrolledDeviceId = enrolled?.deviceId;
assert(enrolled?.host === identity.host, "enrollment returns the canonical server host");
assert(typeof enrolled.deviceToken === "string" && enrolled.deviceToken.length > 0, "enrollment returns a device bearer");
assert(enrolled.vaultId === identity.vaultId, "enrollment joins the pairing code's vault");
assert(typeof enrolledDeviceId === "string" && enrolledDeviceId.length > 0, "enrollment returns a deviceId");
assert(enrolledDeviceId !== identity.deviceId, "each enrollment receives a distinct deviceId");
assert(enrolled.deviceName === "live-secondary", "enrollment returns the requested unique name");
const secondary: LiveIdentity = {
	host: enrolled.host,
	deviceToken: enrolled.deviceToken,
	vaultId: enrolled.vaultId,
	deviceId: enrolledDeviceId,
};
const secondaryTicket = await fetchSocketTicket(secondary);
assert(secondaryTicket.expiresAt > Date.now(), "secondary device credential mints its own socket ticket");

const replay = await fetch(`${identity.host}/enroll`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: enrollBody,
});
assert(replay.status === 404, `consumed pairing code cannot enroll again (got ${replay.status})`);
const replayBody = (await replay.json()) as { error?: unknown } | null;
assert(replayBody?.error === "unknown_code", "pairing replay reports an unknown consumed code");

function hasDeviceId(value: unknown, deviceId: string): boolean {
	return value !== null
		&& typeof value === "object"
		&& "deviceId" in value
		&& value.deviceId === deviceId;
}

const rosterResponse = await fetch(
	`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/devices`,
	{ headers: deviceBearerHeaders(secondary) },
);
assert(rosterResponse.status === 200, `secondary device can read its vault roster (got ${rosterResponse.status})`);
const rosterBody = (await rosterResponse.json()) as { devices?: unknown } | null;
const devices = Array.isArray(rosterBody?.devices) ? rosterBody.devices : [];
assert(
	devices.some((device) => hasDeviceId(device, identity.deviceId)),
	"roster contains the primary device",
);
assert(
	devices.some((device) => hasDeviceId(device, enrolledDeviceId)),
	"roster contains the newly enrolled device",
);

const leaveResponse = await fetch(
	`${secondary.host}/vault/${encodeURIComponent(secondary.vaultId)}/auth/device`,
	{ method: "DELETE", headers: deviceBearerHeaders(secondary) },
);
assert(leaveResponse.status === 200, `secondary device can leave itself (got ${leaveResponse.status})`);
const ticketAfterLeave = await fetch(
	`${secondary.host}/vault/${encodeURIComponent(secondary.vaultId)}/auth/ticket`,
	{ method: "POST", headers: deviceBearerHeaders(secondary) },
);
assert(ticketAfterLeave.status === 401, "secondary credential is revoked after self-leave");
const rosterAfterLeaveResponse = await fetch(
	`${identity.host}/vault/${encodeURIComponent(identity.vaultId)}/devices`,
	{ headers: deviceBearerHeaders(identity) },
);
assert(rosterAfterLeaveResponse.status === 200, "primary device can read roster after secondary leave");
const rosterAfterLeaveBody = await rosterAfterLeaveResponse.json() as { devices?: unknown };
const devicesAfterLeave = Array.isArray(rosterAfterLeaveBody.devices) ? rosterAfterLeaveBody.devices : [];
assert(!devicesAfterLeave.some((device) => hasDeviceId(device, secondary.deviceId)), "secondary membership disappears after leave");

console.log("\n✓ Live one-use membership path passed");
