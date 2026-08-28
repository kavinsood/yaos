import { strict as assert } from "node:assert";
import { expect, jsonRequest, pass } from "../client.ts";
import { PROTOCOL_VERSION, SCHEMA_VERSION, SETTINGS_FORMAT_VERSION, SNAPSHOT_FORMAT_VERSION, STORAGE_FORMAT_VERSION, targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const { response, body } = await jsonRequest(`${target.baseUrl}/api/capabilities`);
assert.equal(response.status, 200);
expect(body !== null, "capabilities endpoint returns JSON");
assert.deepEqual(Object.keys(body).sort(), [
	"attachments", "claimed", "maxBlobUploadBytes", "protocolVersion", "recoveryJobs", "schemaVersion",
	"serverVersion", "settingsFormatVersion", "settingsSync", "snapshotFormatVersion", "snapshots",
	"storageFormatVersion", "updateProvider", "updateRepoBranch", "updateRepoUrl",
].sort());
pass("capabilities document has the complete public key set");
assert.equal(body.claimed, true);
assert.equal(body.schemaVersion, SCHEMA_VERSION);
assert.equal(body.storageFormatVersion, STORAGE_FORMAT_VERSION);
assert.equal(body.protocolVersion, PROTOCOL_VERSION);
assert.equal(body.snapshotFormatVersion, SNAPSHOT_FORMAT_VERSION);
assert.equal(body.settingsFormatVersion, SETTINGS_FORMAT_VERSION);
assert.equal(body.attachments, true);
assert.equal(body.snapshots, true);
assert.equal(body.recoveryJobs, true);
assert.equal(body.settingsSync, true);
assert.ok(typeof body.maxBlobUploadBytes === "number" && body.maxBlobUploadBytes > 0);
assert.ok(typeof body.serverVersion === "string" && body.serverVersion.length > 0);
assert.equal(body.updateProvider, null);
assert.equal(body.updateRepoUrl, null);
assert.equal(body.updateRepoBranch, null);
assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
pass("capabilities freeze schema4/storage1/protocol1/snapshot2/settings1 and the complete feature surface");
