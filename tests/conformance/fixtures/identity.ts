import { strict as assert } from "node:assert";
import { createVaultAndEnroll, enroll, jsonRequest, pass, vaultJson } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const secondClaim = await jsonRequest(`${target.baseUrl}/claim`, {
	method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operatorRecoveryKey: target.operatorRecoveryKey }),
});
assert.equal(secondClaim.response.status, 403);
assert.equal(secondClaim.body?.error, "already_claimed");
pass("claim is single-use after the fixture server is provisioned");

const replay = await enroll(target.baseUrl, target.originEnrollment.pairingCode, target.originEnrollment.deviceName, target.originEnrollment);
assert.equal(replay.result.response.status, 200);
assert.equal(replay.identity?.deviceId, target.deviceA.deviceId);
assert.equal(replay.identity?.vaultId, target.deviceA.vaultId);
pass("an identical enrollment request is replay-safe after its pairing code is consumed");
const mismatch = await enroll(target.baseUrl, target.originEnrollment.pairingCode, target.originEnrollment.deviceName, {
	enrollmentRequestId: target.originEnrollment.enrollmentRequestId,
	deviceId: target.originEnrollment.deviceId,
	deviceToken: `${target.originEnrollment.deviceToken}x`,
});
assert.equal(mismatch.result.response.status, 409);
pass("an enrollment request identity cannot be replayed with changed credentials");

const devices = await vaultJson(target.deviceA, "devices");
assert.equal(devices.response.status, 200);
assert.ok(devices.body && Array.isArray(devices.body.devices));
assert.ok((devices.body.devices as Array<{ deviceId?: unknown }>).some((entry) => entry.deviceId === target.deviceB.deviceId));
pass("pairing enrolled a distinct peer into the provisioned vault");

const other = await createVaultAndEnroll(target, "conformance-isolation");
const denied = await fetch(`${target.baseUrl}/vault/${encodeURIComponent(other.vaultId)}/status`, {
	headers: { authorization: `Bearer ${target.deviceA.deviceToken}` },
});
assert.equal(denied.status, 401);
const reverse = await fetch(`${target.baseUrl}/vault/${encodeURIComponent(target.deviceA.vaultId)}/status`, {
	headers: { authorization: `Bearer ${other.deviceToken}` },
});
assert.equal(reverse.status, 401);
pass("device bearers are isolated across provisioned vaults");
