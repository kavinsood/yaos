/**
 * Suite 1 through the engine, over SimRelay: the creation path (§15.1), a join by recovery key (§12.4 (i)), the
 * roll trigger (§4.2) and the re-publish after a reset (§11.5). Main's part (store keys, pin, restart) is played
 * by testkit/engines.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, NS_STREAM, type VaultPath } from "../../core/types";
import { SimRelay } from "../../sim/relay";
import { converged, until } from "../runtime/testHarness";
import { contains, keyMissing, live, ownRows, parked, rawAppend, start, stored } from "./testkit/engines";
import { K, RK_A, genesis } from "./testkit/world";
import { KeyringRefusedError } from "./writeGate";

const SECRET = new TextEncoder().encode("the plaintext body");

describe("suite 1 in the engine", () => {
	it("creation path: genesis at head 0, pin, restart, sealed writes; a second device joins by RK and converges", async () => {
		const relay = new SimRelay();
		let x = await start(relay, "dev-x", "creating");
		await parked(x, "no-pin");
		assert.equal(x.engine.status().e2ee?.creatable, true);
		x.engine.pinSuite0("create"); // allowed too: the user picks
		await x.engine.enableE2ee(RK_A.slice());
		assert.deepEqual(x.changes.flatMap((c) => c.keys.map((k) => k.e)), [1], "K_1 handed to main once");
		assert.equal(x.changes[x.changes.length - 1]!.pending, null);
		assert.equal(relay.rows(KEYRING_STREAM).length, 1);
		assert.equal(relay.head(), 1, "the genesis and nothing else");
		assert.equal(keyMissing(x), "encrypted-vault", "unpinned until main pins and restarts");
		assert.throws(() => x.engine.pinSuite0("link"), KeyringRefusedError);
		await assert.rejects(x.engine.enableE2ee(RK_A.slice()), KeyringRefusedError);
		await x.engine.stop();

		const xPin = stored(x);
		x = await start(relay, "dev-x", xPin, { storage: x.storage });
		const y0 = await start(relay, "dev-y", "unpinned");
		try {
			await live(x);
			assert.equal(x.engine.status().e2ee?.sealEpoch, 1);
			const id = await x.engine.createDoc("a.md" as VaultPath, new TextDecoder().decode(SECRET));
			await converged([x.engine]);
			for (const s of relay.streams()) for (const r of relay.rows(s)) assert.ok(!contains(r.payload, SECRET), `no plaintext in ${s}`);
			await parked(y0, "encrypted-vault");
			assert.equal(await y0.engine.installKeyRk(RK_A.slice()), "verified");
			assert.deepEqual(y0.changes.flatMap((c) => c.keys.map((k) => k.e)), [1]);
			assert.equal(ownRows(relay, "dev-y"), 0);
			await y0.engine.stop();
			const y = await start(relay, "dev-y", stored(y0), { storage: y0.storage });
			try {
				await converged([x.engine, y.engine]);
				assert.equal(await y.engine.docText(id), new TextDecoder().decode(SECRET));
			} finally {
				await y.engine.stop();
			}
		} finally {
			await y0.engine.stop();
			await x.engine.stop();
		}
	});

	it("enableE2ee and pinSuite0 {create} are refused off the creation path (head > 0, or not started creating)", async () => {
		const relay = new SimRelay();
		const plain = await start(relay, "dev-a", "unpinned");
		try {
			await parked(plain, "no-pin");
			await assert.rejects(plain.engine.enableE2ee(RK_A.slice()), KeyringRefusedError);
			assert.throws(() => plain.engine.pinSuite0("create"), KeyringRefusedError);
		} finally {
			await plain.engine.stop();
		}
		await rawAppend(relay, NS_STREAM, new Uint8Array([1])); // head > 0 (the row itself is never read: unpinned)
		const late = await start(relay, "dev-b", "creating");
		try {
			await parked(late, "no-pin");
			assert.equal(late.engine.status().e2ee?.creatable, false, "VAULT_READY.head > 0");
			await assert.rejects(late.engine.enableE2ee(RK_A.slice()), KeyringRefusedError);
			assert.equal(relay.rows(KEYRING_STREAM).length, 0);
		} finally {
			await late.engine.stop();
		}
	});

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
