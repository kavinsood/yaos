import { strict as assert } from "node:assert";
import { pass, sha256Hex, vaultJson, vaultUrl, bearer } from "../client.ts";
import { SETTINGS_FORMAT_VERSION, targetFromEnv } from "../target.ts";
import { decodeBinaryEnvelope, encodeBinaryEnvelope, YAOS_BINARY_CONTENT_TYPE } from "../../../server/src/shared/binaryEnvelope.ts";

async function envelope(response: Response): Promise<Record<string, unknown>> {
	return decodeBinaryEnvelope(new Uint8Array(await response.arrayBuffer())) as Record<string, unknown>;
}

const target = targetFromEnv();
const key = `conf-${crypto.randomUUID().slice(0, 24)}`;
const diagnosticsBefore = await vaultJson(target.deviceA, "diagnostics");
const loadedBefore = JSON.stringify(diagnosticsBefore.body?.loaded ?? []);
const mismatch = await fetch(`${vaultUrl(target.deviceA, `settings-sync/${key}/seed`)}?settingsFormatVersion=0`, {
	method: "PUT", headers: bearer(target.deviceA, { "content-type": YAOS_BINARY_CONTENT_TYPE }), body: "not-an-envelope",
});
assert.equal(mismatch.status, 426);
assert.deepEqual(await envelope(mismatch), {
	error: "update_required", reason: "settings_format_mismatch", clientSettingsFormatVersion: "0", serverSettingsFormatVersion: SETTINGS_FORMAT_VERSION,
});
pass("settings format 2 is gated before request-body parsing");
const bytes = new TextEncoder().encode('{"conformance":true}');
const hash = await sha256Hex(bytes);
const query = `?settingsFormatVersion=${SETTINGS_FORMAT_VERSION}`;
const seededResponse = await fetch(vaultUrl(target.deviceA, `settings-sync/${key}/seed${query}`), {
	method: "PUT", headers: bearer(target.deviceA, { "content-type": YAOS_BINARY_CONTENT_TYPE }), body: encodeBinaryEnvelope({
		files: [{ path: "app.json", sha256: hash, body: bytes }], intents: [], themes: [], pluginData: [],
	}),
});
assert.equal(seededResponse.status, 200);
assert.deepEqual(await envelope(seededResponse), { ok: true, envRev: 1, rev: 1 });
const readResponse = await fetch(vaultUrl(target.deviceB, `settings-sync/${key}${query}`), { headers: bearer(target.deviceB) });
const read = await envelope(readResponse);
assert.equal(readResponse.status, 200);
assert.equal(read.seeded, true);
assert.equal(read.envRev, 1);
assert.equal((read.files as Array<{ sha256?: unknown; rev?: unknown }>)[0]?.sha256, hash);
assert.equal((read.files as Array<{ rev?: unknown }>)[0]?.rev, 1);
pass("a second device reads the exact format-2 settings revision");
const changed = new TextEncoder().encode('{"conformance":2}');
const changedHash = await sha256Hex(changed);
const mutationResponse = await fetch(vaultUrl(target.deviceB, `settings-sync/${key}/file${query}`), {
	method: "PUT", headers: bearer(target.deviceB, { "content-type": YAOS_BINARY_CONTENT_TYPE }),
	body: encodeBinaryEnvelope({ path: "app.json", sha256: changedHash, body: changed }),
});
assert.deepEqual(await envelope(mutationResponse), { ok: true, envRev: 2, rev: 2 });
const diagnosticsAfter = await vaultJson(target.deviceA, "diagnostics");
assert.equal(JSON.stringify(diagnosticsAfter.body?.loaded ?? []), loadedBefore);
pass("settings state is a revisioned sidecar and does not hydrate Yjs documents");
