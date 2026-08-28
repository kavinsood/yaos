import { strict as assert } from "node:assert";
import * as Y from "yjs";
import { bearer, connectDocument, createBody, pass, vaultUrl, waitFor } from "../client.ts";
import { targetFromEnv } from "../target.ts";

const target = targetFromEnv();
const created = await createBody(target.deviceA, "root-body.md", "candidate/lifecycle/publication");
expectReceipt(created.receipt);
pass("body creation fences the lifecycle, durably accepts its candidate, then returns a replay-safe receipt");

const rootResponse = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
assert.equal(rootResponse.status, 200);
const root = new Y.Doc({ guid: "root-check" });
Y.applyUpdate(root, new Uint8Array(await rootResponse.arrayBuffer()));
assert.equal(root.getMap<string>("pathToId").get("root-body.md"), created.bodyId);
root.destroy();
pass("root publication follows the durable lifecycle receipt");

const rootSocket = await connectDocument(target.deviceB, "root", "root");
try {
	let closed = false;
	rootSocket.provider.on("connection-close", () => { closed = true; });
	rootSocket.doc.getMap<string>("pathToId").set("forbidden.md", "body_forbidden");
	await waitFor(() => closed, "root socket rejection");
	const durable = await fetch(vaultUrl(target.deviceA, "root"), { headers: bearer(target.deviceA) });
	const check = new Y.Doc();
	Y.applyUpdate(check, new Uint8Array(await durable.arrayBuffer()));
	assert.equal(check.getMap("pathToId").has("forbidden.md"), false);
	check.destroy();
	pass("root WebSocket is replication-only and cannot publish client mutations");
} finally { rootSocket.destroy(); }

function expectReceipt(receipt: typeof created.receipt): void {
	assert.equal(receipt.vaultId, target.deviceA.vaultId);
	assert.equal(receipt.vaultGeneration, target.deviceA.vaultGeneration);
	assert.equal(receipt.kind, "create");
	assert.equal(receipt.lifecycle, "active");
	assert.ok(receipt.durableGeneration >= 1 && receipt.vaultSequence >= 1 && receipt.runtimeEpoch.length > 0);
}
