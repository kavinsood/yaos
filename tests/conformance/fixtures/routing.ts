import { strict as assert } from "node:assert";
import { jsonRequest, pass } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
for (const path of [
	"/unknown", "/vault/short/status", `/vault/${encodeURIComponent(target.deviceA.vaultId)}/unknown`,
	`/vault/${encodeURIComponent(target.deviceA.vaultId)}/body/%2f`, `/vault/${encodeURIComponent(target.deviceA.vaultId)}/ws/root/extra`,
]) {
	const { response, body } = await jsonRequest(`${target.baseUrl}${path}`);
	assert.equal(response.status, 404, `${path}: ${JSON.stringify(body)}`);
}
pass("unknown and malformed routes fail in the public classifier");
const canonicalUnknown = await jsonRequest(`${target.baseUrl}/vault/not-a-canonical-vault/status`);
assert.equal(canonicalUnknown.response.status, 401);
assert.equal(canonicalUnknown.body?.error, "unauthorized");
pass("a syntactically canonical unknown vault reaches authentication before storage lookup");
const known = await jsonRequest(`${target.baseUrl}/vault/${encodeURIComponent(target.deviceA.vaultId)}/status`);
assert.equal(known.response.status, 401);
assert.equal(known.body?.error, "unauthorized");
pass("a classified vault route reaches authentication only after its shape is accepted");
