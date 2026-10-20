/**
 * §11.3 validity and winner selection, §12.4 (i) QR / RK keys, and the §20.2 keyring-forgery cases
 * (garbage, a roll for r forged with K_{r−1} after a revoke, duplicate records), over the real adapter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { utf8Encode } from "../../core/codec/lib0";
import { Keyring } from "./keyring";
import { FORGED, K, RK_A, RK_B, VAULT, device, genesis, holds, persistedEpochs, revoke, roll } from "./testkit/world";

describe("keyring: winners (§11.3)", () => {
	it("RK path: unwraps the genesis, walks nextWrap forward, persists keys and records once, then seals", async () => {
		const [g, r2, r3] = [await genesis(), await roll(2), await roll(3)];
		const d = await device({ mode: "unpinned" });
		await d.ingest([1, g], [5, r2], [9, r3]);
		assert.equal(d.kr.keyMissing(), "encrypted-vault");
		assert.equal(d.seenCalls, 1);
		assert.equal(d.changes.length, 0, "nothing is persisted before a key verifies");
		const rk = RK_A.slice();
		assert.equal(await d.kr.installRk(rk), "verified");
		assert.deepEqual(rk, new Uint8Array(35), "the caller's RK buffer is zero-filled");
		assert.deepEqual(persistedEpochs(d), [1, 2, 3]);
		assert.deepEqual(d.changes.at(-1)!.records, [g, r2, r3]);
		assert.equal(d.changes.at(-1)!.pending, null);
		assert.equal(d.kc.sealEpoch(), 3);
		for (const e of [1, 2, 3]) assert.ok(await holds(d, e, K(e)), `K_${e}`);
	});

	it("QR at the newest epoch walks prevWrap back through a revoke and the rolls before it", async () => {
		const rows = [await genesis(), await roll(2), await revoke(3)];
		const d = await device({ mode: "unpinned" });
		await d.ingest(...rows.map((b, i) => [i + 1, b] as const));
		assert.equal(await d.kr.installQr(3, K(3)), "verified");
		assert.deepEqual(persistedEpochs(d), [1, 2, 3]);
		assert.deepEqual(d.changes.at(-1)!.records, rows);
		assert.ok(await holds(d, 1, K(1)));
	});

	it("a pinned device adopts a roll through nextWrap, persisting before it seals under it", async () => {
		const g = await genesis();
		const d = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		assert.equal(d.kc.sealEpoch(), 1);
		assert.equal(d.changes.length, 0, "stored keys and records are not persisted again");
		await d.ingest([1, g], [7, await roll(2)]);
		assert.deepEqual(d.sealAtPersist, [1], "persist ran while the seal epoch was still 1");
		assert.equal(d.kc.sealEpoch(), 2);
		assert.equal(d.kr.keyMissing(), null);
	});

	it("persist failure: the new epoch is not used, the device is key-missing, and the keys are retried", async () => {
		const d = await device({ keys: [{ e: 1, k: K(1) }], records: [await genesis()] });
		d.failPersist = true;
		await d.ingest([2, await roll(2)]);
		assert.equal(d.kc.sealEpoch(), 1);
		assert.equal(d.kr.keyMissing(), "no-key");
		assert.deepEqual(d.codes(), ["keyring/adopted", "keyring/persist-failed"]);
		d.failPersist = false;
		await d.ingest([3, utf8Encode("junk")]);
		assert.deepEqual(persistedEpochs(d), [2]);
		assert.equal(d.kc.sealEpoch(), 2);
		assert.equal(d.kr.keyMissing(), null);
	});

	it("garbage rows are ignored and reported; they make k non-empty but do not set keyringSeen", async () => {
		const d = await device({ mode: "unpinned" });
		await d.ingest([1, utf8Encode("garbage")], [2, new Uint8Array(300)]);
		assert.deepEqual(d.codes(), ["keyring/garbage", "keyring/garbage"]);
		assert.equal(d.kr.rowCount, 2);
		assert.equal(d.kr.keyringSeen, false);
		assert.equal(d.kr.keyMissing(), "no-pin");
	});

	it("duplicates: a byte-identical re-publish is a no-op; a different record for a decided epoch is ignored", async () => {
		const g = await genesis();
		const other = await genesis(RK_A, FORGED(1));
		const d = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		await d.ingest([4, g], [6, g], [8, other]);
		assert.deepEqual(d.codes(), ["keyring/duplicate"]);
		assert.deepEqual(d.kr.summary().epochs.map((x) => [x.e, x.firstSeq]), [[1, 4]]);
		assert.ok(await holds(d, 1, K(1)));
		const r2 = await roll(2);
		const r2b = await roll(2, K(1), FORGED(2)); // a concurrent roll from another device, committed later
		await d.ingest([10, r2], [11, r2b], [12, r2]);
		assert.deepEqual(d.codes(), ["keyring/duplicate", "keyring/adopted", "keyring/duplicate"]);
		assert.ok(await holds(d, 2, K(2)));
	});

	it("conflict: a QR key whose kcv differs from k's record rejects the record and persists nothing", async () => {
		const d = await device({ mode: "unpinned" });
		await d.ingest([1, await genesis()]);
		assert.equal(await d.kr.installQr(1, FORGED(1)), "pending");
		assert.deepEqual(d.codes(), ["keyring/conflict", "keyring/invalid"]);
		assert.equal(d.changes.length, 0);
		const pinned = await device({ keys: [{ e: 1, k: K(1) }], records: [await genesis()] });
		assert.equal(await pinned.kr.installQr(1, FORGED(1)), "conflict", "a verified key is never replaced (re-key by restart)");
		assert.equal(await pinned.kr.installQr(1, K(1)), "same");
	});

	it("an unverified QR key persists nothing; it is kept and verified once k shows its record (§12.4 (i))", async () => {
		const d = await device({ mode: "unpinned" });
		assert.equal(await d.kr.installQr(1, K(1)), "pending");
		await d.ingest([1, utf8Encode("x")]);
		assert.equal(d.changes.length, 0);
		assert.equal(d.kc.exportForHost().length, 0);
		await d.ingest([2, await genesis()]);
		assert.deepEqual(persistedEpochs(d), [1]);
	});

	it("an older RK opens only its own record: rolls below a revoke it cannot open stay pending (§11.3, §13.3)", async () => {
		const rows = [await genesis(RK_A), await roll(2), await revoke(3, RK_B), await roll(4)];
		const d = await device(); // pinned suite 1, keys not yet entered (§13.3 step 2)
		await d.ingest(...rows.map((b, i) => [i + 1, b] as const));
		assert.equal(await d.kr.installRk(RK_A.slice()), "verified");
		assert.deepEqual(persistedEpochs(d), [1]);
		assert.equal(d.kr.keyMissing(), "revoked-epoch");
		assert.equal(await d.kr.installRk(RK_B.slice()), "verified");
		assert.deepEqual(persistedEpochs(d).sort(), [1, 2, 3, 4]);
		assert.equal(d.kr.keyMissing(), null);
		assert.equal(d.kc.sealEpoch(), 4);
	});
});

describe("keyring: forged roll after a revoke (§11.3, §20.2)", () => {
	// The revoked device holds K_2 and forges a roll for 3 under it; the user revoked with K_3 and the RK.
	const setup = async () => {
		const g = await genesis();
		const kept = await device({ keys: [{ e: 1, k: K(1) }, { e: 2, k: K(2) }], records: [g, await roll(2)] });
		return { kept, rev: await revoke(3), forged: await roll(3, K(2), FORGED(3)) };
	};

	for (const order of ["revoke first", "forged first"] as const) {
		it(`one catch-up batch, ${order}: the roll is blocked, the device waits in key-missing, a QR settles it`, async () => {
			const { kept, rev, forged } = await setup();
			await kept.ingest(...(order === "revoke first" ? [[10, rev], [11, forged]] as const : [[10, forged], [11, rev]] as const));
			assert.equal(kept.kr.keyMissing(), "revoked-epoch");
			assert.equal(kept.kc.sealEpoch(), 2);
			assert.equal(kept.kc.keyState(3).held, false, "no key for 3 from the forged nextWrap");
			assert.equal(await kept.kr.installQr(3, K(3)), "verified");
			assert.equal(kept.kc.sealEpoch(), 3);
			assert.ok(await holds(kept, 3, K(3)));
			assert.ok(kept.codes().includes(order === "revoke first" ? "keyring/duplicate" : "keyring/conflict"));
		});
	}

	it("live, revoke then forged roll in separate deliveries: still blocked; after the revoke wins the roll is a duplicate", async () => {
		const { kept, rev, forged } = await setup();
		await kept.ingest([10, rev]);
		await kept.ingest([11, forged]);
		assert.equal(kept.kc.keyState(3).held, false);
		assert.equal(await kept.kr.installRk(RK_A.slice()), "verified");
		assert.ok(await holds(kept, 3, K(3)));
		await kept.ingest([12, await roll(3, K(2), FORGED(4))]);
		assert.equal(kept.kr.keyMissing(), null);
		assert.ok(await holds(kept, 3, K(3)));
	});

	it("live, forged roll delivered alone before the revoke: adopted, then the revoke stops the device (race safe-stop)", async () => {
		const { kept, rev, forged } = await setup();
		await kept.ingest([10, forged]);
		assert.equal(kept.kc.sealEpoch(), 3, "nothing in k outranks the roll yet: a fork (§14.3), closed by re-keying");
		await kept.ingest([11, rev]);
		assert.equal(kept.kr.keyMissing(), "revoked-epoch");
		assert.equal(await kept.kr.installQr(3, K(3)), "conflict", "out-of-band key reported; the host re-keys by restart");
		const fresh = await device({ mode: "unpinned" });
		await fresh.ingest([1, await genesis()], [2, await roll(2)], [10, forged], [11, rev]);
		assert.equal(await fresh.kr.installQr(3, K(3)), "verified");
		assert.ok(await holds(fresh, 3, K(3)));
	});
});

describe("keyring: a key reached by prevWrap but not verified yet (suite-1 seeds 74, 184)", () => {
	// Re-keyed by RK above an open revoke 3 whose roll 2 is still undecided (the revoke blocks it): the revoke's
	// prevWrap installs K_2, held but unverified, so it is not stored. A Keyring opened again on the same adapter (the
	// engine restarted) took the held K_2 for an own key, which never unblocks a roll: roll 2 stayed pending, K_1
	// (behind its prevWrap) was never reached, and every blob address (K_1's subkey) failed for good.
	it("a Keyring opened again re-derives K_2 from the revoke's prevWrap and walks down to K_1", async () => {
		const [g, r2, r3] = [await genesis(), await roll(2), await revoke(3, RK_B)];
		const d1 = await device({ records: [r3] });
		assert.equal(await d1.kr.installRk(RK_B.slice()), "verified");
		assert.ok(d1.kc.keyState(2).held && !d1.kc.keyState(2).verified, "K_2 held, not verified");
		const records = d1.changes.at(-1)?.records ?? [r3];
		d1.kr.dispose();
		const kr = await Keyring.open({ mode: "suite1", vaultId: VAULT, kc: d1.kc, records, persist: async () => undefined, diag: () => undefined, onKeyringSeen: () => undefined });
		await kr.ingest([{ seq: 1, bytes: g }, { seq: 5, bytes: r2 }, { seq: 9, bytes: r3 }]);
		assert.ok(d1.kc.keyState(1).verified, "K_1 verified");
		assert.ok(d1.kc.keyState(2).verified, "K_2 verified");
		assert.equal(kr.keyMissing(), null);
	});
});

describe("keyring: the DB copy of the records (§6.1, §11.5, §13.3)", () => {
	it("SecretStorage lost after a reset emptied k: the RK opens the genesis the DB kept, and the records are re-publishable", async () => {
		// Suite-1 seeds 115, 148, 149, 167: both devices lost their SecretStorage, and a reset or restore emptied k
		// before either re-published. With nothing in k and no stored record, the RK had nothing to open.
		const [g, r2] = [await genesis(), await roll(2)];
		const bare = await device({ records: [] });
		assert.equal(await bare.kr.installRk(RK_A.slice()), "pending");
		assert.equal(bare.kr.keyMissing(), "no-key");

		const d = await device({ records: [], mirror: { winners: [g, r2], open: [] } });
		assert.deepEqual(d.codes(), ["keyring/records-from-db"]);
		assert.equal(d.kr.keyMissing(), "no-key");
		assert.deepEqual(d.mirrored, [], "the copy is not rewritten unchanged");
		assert.equal(await d.kr.installRk(RK_A.slice()), "verified");
		assert.deepEqual(persistedEpochs(d), [1, 2]);
		assert.deepEqual(d.changes.at(-1)!.records, [g, r2], "main gets the records back with the keys");
		assert.equal(d.kr.keyMissing(), null);
		assert.deepEqual(d.kr.republishable(), [g, r2]);
	});

	it("a copy whose newest winner is a revoke: the RK opens it and walks back to the genesis", async () => {
		const [g, v2] = [await genesis(), await revoke(2)];
		const d = await device({ records: [], mirror: { winners: [g, v2], open: [] } });
		assert.equal(d.kr.keyMissing(), "revoked-epoch");
		assert.equal(await d.kr.installRk(RK_A.slice()), "verified");
		assert.deepEqual(persistedEpochs(d).sort(), [1, 2]);
		assert.equal(d.kr.keyMissing(), null);
		assert.deepEqual(d.kr.republishable(), [g, v2]);
	});

	it("main's records win over the copy; the copy follows every change of the record set", async () => {
		const [g, r2] = [await genesis(), await roll(2)];
		const d = await device({ keys: [{ e: 1, k: K(1) }], records: [g], mirror: { winners: [g, r2], open: [] } });
		assert.deepEqual(d.kr.summary().epochs.map((x) => x.e), [1], "the copy is not read while main holds records");
		assert.deepEqual(d.mirrored, [{ winners: [g], open: [] }], "and is rewritten to main's set");
		const fresh = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		assert.deepEqual(fresh.mirrored, [{ winners: [g], open: [] }], "a device without a copy writes one at open");
		await fresh.ingest([1, g], [7, r2]);
		assert.deepEqual(fresh.mirrored.at(-1), { winners: [g, r2], open: [] });
		assert.equal(fresh.mirrored.length, 2);
	});
});
