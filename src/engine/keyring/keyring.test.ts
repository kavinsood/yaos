/**
 * §11.3 validity and winner selection, §12.4 (i) QR / RK keys, and the §20.2 keyring-forgery cases
 * (garbage, a roll for r forged with K_{r−1} after a revoke, duplicate records), over the real adapter.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { utf8Encode } from "../../core/codec/lib0";
import { FORGED, K, RK_A, RK_B, device, genesis, holds, persistedEpochs, revoke, roll } from "./testkit/world";

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
