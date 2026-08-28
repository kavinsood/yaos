import { strict as assert } from "node:assert";
import { bearer, connectDocument, jsonRequest, pass, sha256Hex, vaultUrl, waitFor } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const socket = await connectDocument(target.deviceB, "root", "root");
let socketClosed = false;
socket.provider.on("connection-close", () => { socketClosed = true; });
const bytes = new TextEncoder().encode("must be purged before SQL deletion");
const hash = await sha256Hex(bytes);
const upload = await fetch(vaultUrl(target.deviceA, `blobs/${hash}`), { method: "PUT", headers: bearer(target.deviceA), body: bytes });
assert.equal(upload.status, 204);

async function destroy(): Promise<{ status: number; body: Record<string, unknown> | null }> {
	const result = await jsonRequest(`${target.baseUrl}/operator/vaults/${encodeURIComponent(target.deviceA.vaultId)}`, {
		method: "DELETE", headers: { cookie: target.operatorCookie },
	});
	return { status: result.response.status, body: result.body };
}
let result = await destroy();
assert.ok(result.status === 200 || result.status === 202, JSON.stringify(result.body));
await waitFor(async () => {
	if (result.status === 200 && result.body?.completed === true) return true;
	const pending = result.body?.pending as Record<string, unknown> | undefined;
	if (pending) assert.ok(!(pending.roomComplete === true && pending.r2Complete !== true), "SQL room deletion must never precede immutable-object purge");
	result = await destroy();
	return result.status === 200 && result.body?.completed === true;
}, "purge-first vault deletion", 60_000);
pass("vault deletion purges generation objects before deleting SQL state");
await waitFor(() => socketClosed, "vault socket closure");
socket.destroy();
pass("vault deletion closes active device sockets");
const status = await fetch(vaultUrl(target.deviceA, "status"), { headers: bearer(target.deviceA) });
assert.ok(status.status === 401 || status.status === 404);
const blob = await fetch(vaultUrl(target.deviceA, `blobs/${hash}`), { headers: bearer(target.deviceA) });
assert.ok(blob.status === 401 || blob.status === 404);
pass("deletion revokes membership and leaves no generation-scoped attachment readable");
