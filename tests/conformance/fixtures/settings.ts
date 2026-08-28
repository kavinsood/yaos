import { strict as assert } from "node:assert";
import { pass, sha256Hex, vaultJson, vaultUrl, bearer } from "../client.ts";
import { SETTINGS_FORMAT_VERSION, targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const key = `conf-${crypto.randomUUID().slice(0, 24)}`;
const diagnosticsBefore = await vaultJson(target.deviceA, "diagnostics");
const loadedBefore = JSON.stringify(diagnosticsBefore.body?.loaded ?? []);
const mismatch = await fetch(`${vaultUrl(target.deviceA, `settings-sync/${key}/seed`)}?settingsFormatVersion=0`, {
	method: "PUT", headers: bearer(target.deviceA, { "content-type": "application/json" }), body: "{not-json",
});
assert.equal(mismatch.status, 426);
assert.deepEqual(await mismatch.json(), {
	error: "update_required", reason: "settings_format_mismatch", clientSettingsFormatVersion: "0", serverSettingsFormatVersion: SETTINGS_FORMAT_VERSION,
});
pass("settings format 1 is gated before request-body parsing");
const bytes = new TextEncoder().encode('{"conformance":true}');
const hash = await sha256Hex(bytes);
const query = `?settingsFormatVersion=${SETTINGS_FORMAT_VERSION}`;
const seeded = await vaultJson(target.deviceA, `settings-sync/${key}/seed${query}`, {
	method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
		files: [{ path: "app.json", sha256: hash, bodyBase64: Buffer.from(bytes).toString("base64") }], intents: [], themes: [], pluginData: [],
	}),
});
assert.equal(seeded.response.status, 200);
assert.deepEqual(seeded.body, { ok: true, envRev: 1, rev: 1 });
const read = await vaultJson(target.deviceB, `settings-sync/${key}${query}`);
assert.equal(read.response.status, 200);
assert.equal(read.body?.seeded, true);
assert.equal(read.body?.envRev, 1);
assert.equal((read.body?.files as Array<{ sha256?: unknown; rev?: unknown }>)[0]?.sha256, hash);
assert.equal((read.body?.files as Array<{ rev?: unknown }>)[0]?.rev, 1);
pass("a second device reads the exact format-1 settings revision");
const changed = new TextEncoder().encode('{"conformance":2}');
const changedHash = await sha256Hex(changed);
const mutation = await vaultJson(target.deviceB, `settings-sync/${key}/file${query}`, {
	method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "app.json", sha256: changedHash, bodyBase64: Buffer.from(changed).toString("base64") }),
});
assert.deepEqual(mutation.body, { ok: true, envRev: 2, rev: 2 });
const diagnosticsAfter = await vaultJson(target.deviceA, "diagnostics");
assert.equal(JSON.stringify(diagnosticsAfter.body?.loaded ?? []), loadedBefore);
pass("settings state is a revisioned sidecar and does not hydrate Yjs documents");
