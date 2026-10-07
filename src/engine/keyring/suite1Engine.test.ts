/**
 * Suite 1 through a pinned engine, over SimRelay: the roll trigger (§4.2) and the re-publish after a reset (§11.5).
 * Main's part (store keys) is played by testkit/engines.ts. The creation path and joins run while the gate is shut,
 * in the KeyReader (compose/keyReader.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { keyMissing, live, rawAppend, start } from "./testkit/engines";
import { K, genesis } from "./testkit/world";


describe("suite 1 in the engine", () => {
	it("roll trigger: past the seq span the device rolls, hands K_2 to main before sealing under it, and keeps writing", async () => {
		const relay = new SimRelay();
		const g = await genesis(); // records carry random wraps: the stored record is the bytes k holds
		await rawAppend(relay, KEYRING_STREAM, g);
		const pin = { keys: [{ e: 1, k: K(1) }], records: [g] };
		const x = await start(relay, "dev-x", pin, { tuning: { rollSeqSpan: 6 } });
		try {
			await live(x);
			const id = await x.engine.createDoc("a.md" as VaultPath, "one");
			for (let i = 0; i < 8; i++) await x.engine.editDoc(id, (t) => t.insert(t.length, ` ${i}`));
			await until(() => x.engine.status().e2ee?.sealEpoch === 2, 8_000, "rolled to epoch 2");
			assert.equal(relay.rows(KEYRING_STREAM).length, 2);
			const e2 = x.changes.filter((c) => c.keys.some((k) => k.e === 2));
			assert.equal(e2.length, 1, "K_2 persisted once");
			assert.equal(e2[0]!.pending, 2, "persisted before its record won");
			await x.engine.editDoc(id, (t) => t.insert(t.length, " after"));
			await converged([x.engine]);
			assert.equal(keyMissing(x), null);
		} finally {
			await x.engine.stop();
		}
	});

	it("re-publish: stored winners missing from an empty k (a reset) are appended verbatim, then the device writes", async () => {
		const relay = new SimRelay();
		const g = await genesis();
		const x = await start(relay, "dev-x", { keys: [{ e: 1, k: K(1) }], records: [g] });
		try {
			await live(x);
			await until(() => relay.rows(KEYRING_STREAM).length > 0, 5_000, "re-published");
			const k = relay.rows(KEYRING_STREAM);
			assert.equal(k.length, 1);
			assert.deepEqual(k[0]!.payload, g, "byte-identical");
			await x.engine.createDoc("b.md" as VaultPath, "after the reset");
			await converged([x.engine]);
			assert.equal(relay.rows(KEYRING_STREAM).length, 1, "published once");
		} finally {
			await x.engine.stop();
		}
	});
});
