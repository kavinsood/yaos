/** The sender's re-seal (e2ee-design §14.2 step 4): which records keep their clientFrameId. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CFG_STREAM, NS_STREAM, type ClientFrameId, type DeviceId, type StreamName, type VaultId } from "../../core/types";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import type { OutboxRecord } from "../store/schema";
import { SeededRandom } from "../../sim/random";
import type { EngineCtx } from "./context";
import { Resealer } from "./reseal";

const hash = createWebHash();

async function reseal(stream: StreamName, sealed: Uint8Array): Promise<{ readonly from: ClientFrameId; readonly to: ClientFrameId }> {
	const ops: { clientFrameId: ClientFrameId; next: { clientFrameId: ClientFrameId } }[] = [];
	let done!: () => void;
	const settled = new Promise<void>((r) => (done = r));
	const c = {
		gate: () => null,
		stopped: false,
		self: "dev-x" as DeviceId,
		ports: { random: new SeededRandom(7), hash },
		deps: { crypto: createNoopCrypto(hash) },
		opts: { vaultId: "v1" as VaultId },
		keyring: { minSendEpoch: () => 0 },
		repo: { tOutbox: async (o: typeof ops) => (ops.push(...o), { renamed: [] }) },
		applyOutboxResult: () => done(),
		diag: () => undefined,
	} as unknown as EngineCtx;
	const rec: OutboxRecord = {
		clientFrameId: "cf-old" as ClientFrameId, order: 1, stream, kind: stream === NS_STREAM ? "nsOps" : "cfgOps", state: "pending", sealed, content: new Uint8Array([1, 2]),
		authorNsSeq: 0, flags: 0, frameNo: 4, keyEpoch: 1, dependsOn: null, adoptOf: null, createdAtMs: 0,
	} as OutboxRecord;
	new Resealer(c).request(rec);
	await settled;
	assert.equal(ops.length, 1);
	return { from: ops[0]!.clientFrameId, to: ops[0]!.next.clientFrameId };
}

test("a sent ns / cfg record re-sealed takes a fresh clientFrameId: its old bytes may still commit (sim suite 1 seed 264)", async () => {
	for (const stream of [NS_STREAM, CFG_STREAM]) {
		const r = await reseal(stream, new Uint8Array(40).fill(3));
		assert.equal(r.from, "cf-old");
		assert.notEqual(r.to, "cf-old", `${stream}: a resend under the old id would be refused frame-id-conflict`);
	}
});

test("an unsealed copy keeps its clientFrameId: it was never sent", async () => {
	const r = await reseal(NS_STREAM, new Uint8Array(0));
	assert.equal(r.to, "cf-old");
});
