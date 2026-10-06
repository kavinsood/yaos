/**
 * Keyring operations: own roll / revoke against concurrent records (§11.4, §14.2), keyMissing reasons (§12.4),
 * the stale-epoch rule (§14.3), re-publish (§11.5), the roll trigger (§4.2) and keys handed in at load (§18.4).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { utf8Encode } from "../../core/codec/lib0";
import { KeyRecordKind } from "./record";
import { FORGED, K, RK_A, device, genesis, holds, persistedEpochs, revoke, roll } from "./testkit/world";

const pinned = async (n: number) => {
	const records = [await genesis()];
	for (let e = 2; e <= n; e++) records.push(await roll(e));
	return { d: await device({ keys: records.map((_, i) => ({ e: i + 1, k: K(i + 1) })), records }), records };
};

describe("keyring: own records (§11.4, §14.2)", () => {
	it("own roll: the pending key is persisted before the append; it is adopted once k shows the record first", async () => {
		const { d } = await pinned(1);
		const own = await d.kr.propose(KeyRecordKind.roll);
		assert.equal(own.e, 2);
		assert.deepEqual(d.changes.map((c) => [c.keys.map((x) => x.e), c.pending]), [[[2], 2]]);
		assert.equal(d.kc.sealEpoch(), 1, "still sealing under 1 until the record wins");
		assert.equal(d.kr.keyMissing(), null);
		assert.equal(await d.kr.settleOwn(), "pending");
		await d.ingest([3, own.bytes]);
		assert.equal(await d.kr.settleOwn(), "won");
		assert.equal(d.kc.sealEpoch(), 2);
		assert.equal(d.changes.at(-1)!.pending, null);
		assert.equal(d.changes.at(-1)!.records.length, 2);
	});

	it("own roll loses to a concurrent roll: the own key is replaced by the winner's, the own record is a duplicate", async () => {
		const { d } = await pinned(1);
		const own = await d.kr.propose(KeyRecordKind.roll);
		const other = await roll(2, K(1), FORGED(2));
		await d.ingest([3, other], [4, own.bytes]);
		assert.equal(await d.kr.settleOwn(), "lost");
		assert.ok(await holds(d, 2, FORGED(2)));
		assert.equal(d.kc.sealEpoch(), 2);
		assert.deepEqual(d.codes(), ["keyring/adopted", "keyring/duplicate"]);
		assert.deepEqual(persistedEpochs(d), [2, 2], "the own pending key, then the winner's");
	});

	it("own revoke against a concurrent roll for the same epoch: the revoke wins whatever the seq order", async () => {
		const { d } = await pinned(2);
		const rk = RK_A.slice();
		const own = await d.kr.propose(KeyRecordKind.revoke, rk);
		assert.equal(own.e, 3);
		await d.ingest([10, await roll(3, K(2), FORGED(3))], [11, own.bytes]);
		assert.equal(await d.kr.settleOwn(), "won");
		assert.equal(d.kc.sealEpoch(), 3);
		assert.equal(d.kr.minSendEpoch(), 3);
		assert.deepEqual(d.codes(), ["keyring/adopted", "keyring/duplicate"]);
	});

	it("propose refuses: a genesis over a non-empty k, a revoke without the RK, a second record in flight", async () => {
		const { d } = await pinned(1);
		await assert.rejects(d.kr.propose(KeyRecordKind.genesis, RK_A.slice()), /empty k/);
		await assert.rejects(d.kr.propose(KeyRecordKind.revoke), /recovery key/);
		await d.kr.propose(KeyRecordKind.roll);
		await assert.rejects(d.kr.propose(KeyRecordKind.roll), /in flight/);
		await d.kr.abandonOwn();
		assert.equal(d.kc.keyState(2).held, false);
		assert.equal(d.changes.at(-1)!.pending, null);
	});

	it("genesis on the creation path: e 1, persisted pending, adopted from its own receipt", async () => {
		const d = await device();
		assert.equal(d.kr.keyMissing(), "no-key");
		const own = await d.kr.propose(KeyRecordKind.genesis, RK_A.slice());
		assert.equal(own.e, 1);
		await d.ingest([1, own.bytes]);
		assert.equal(await d.kr.settleOwn(), "won");
		assert.equal(d.kr.keyMissing(), null);
		assert.equal(d.kc.sealEpoch(), 1);
	});
});

describe("keyring: keyMissing (§12.4)", () => {
	it("suite 0: a genesis stops the device (encrypted-vault); garbage does not", async () => {
		const d = await device({ mode: "suite0" });
		await d.ingest([1, utf8Encode("x")]);
		assert.equal(d.kr.keyMissing(), null);
		await d.ingest([2, await genesis()]);
		assert.equal(d.kr.keyMissing(), "encrypted-vault");
		assert.equal(d.kr.sealEpoch(), 0);
		assert.equal(d.seenCalls, 0, "only an unpinned device stores keyringSeen");
	});

	it("unpinned: no-pin with an empty k, encrypted-vault once a record is seen or keyringSeen is stored", async () => {
		const d = await device({ mode: "unpinned" });
		assert.equal(d.kr.keyMissing(), "no-pin");
		await d.ingest([1, await genesis()]);
		assert.equal(d.kr.keyMissing(), "encrypted-vault");
		assert.equal((await device({ mode: "unpinned", keyringSeen: true })).kr.keyMissing(), "encrypted-vault");
	});

	it("suite 1: no-key without a usable key, revoked-epoch above the keys held, null when sealing", async () => {
		assert.equal((await device()).kr.keyMissing(), "no-key");
		const { d } = await pinned(2);
		assert.equal(d.kr.keyMissing(), null);
		await d.ingest([9, await revoke(3)]);
		assert.equal(d.kr.keyMissing(), "revoked-epoch");
		assert.equal(d.kr.rollDue(1e9, 1e9, 1, 1), false);
	});
});

describe("keyring: stale-epoch rule and re-publish (§14.3, §11.5)", () => {
	it("stale past S_rot below r; hold past an open revoke until it is settled", async () => {
		const { d } = await pinned(2);
		await d.ingest([50, await revoke(3)]);
		assert.equal(d.kr.staleCheck(2, 51), "hold");
		assert.equal(d.kr.staleCheck(2, 50), null);
		assert.equal(await d.kr.installQr(3, K(3)), "verified");
		assert.equal(d.kr.staleCheck(2, 51), "stale");
		assert.equal(d.kr.staleCheck(1, 99), "stale");
		assert.equal(d.kr.staleCheck(2, 49), null);
		assert.equal(d.kr.staleCheck(3, 99), null);
		assert.deepEqual(d.kr.summary().sRot, 50);
	});

	it("after a reset: every stored winner is republishable; S_rot is the re-published revoke's seq", async () => {
		const records = [await genesis(), await roll(2), await revoke(3)];
		const d = await device({ keys: [1, 2, 3].map((e) => ({ e, k: K(e) })), records });
		assert.deepEqual(d.kr.republishable(), records);
		assert.equal(d.kr.staleCheck(2, 3), null, "S_rot unknown before the re-publish");
		await d.ingest([4, records[0]!], [5, records[1]!], [6, records[2]!]);
		assert.deepEqual(d.kr.republishable(), []);
		assert.deepEqual(d.codes(), [], "byte-identical re-publishes are no-ops");
		assert.equal(d.kr.staleCheck(2, 7), "stale");
		assert.equal(d.kr.staleCheck(2, 5), null);
	});

	it("rollDue: span from firstSeq(e), or own seals; never without a seen record, while key-missing or in flight", async () => {
		const { d, records } = await pinned(1);
		assert.equal(d.kr.rollDue(1e9, 0, 100, 10), false, "firstSeq unknown");
		assert.equal(d.kr.rollDue(0, 10, 100, 10), true);
		await d.ingest([7, records[0]!]);
		assert.equal(d.kr.rollDue(106, 0, 100, 10), false);
		assert.equal(d.kr.rollDue(107, 0, 100, 10), true);
		await d.kr.propose(KeyRecordKind.roll);
		assert.equal(d.kr.rollDue(107, 0, 100, 10), false);
		assert.equal((await device({ mode: "unpinned" })).kr.rollDue(1e9, 1e9, 1, 1), false);
	});
});

describe("keyring: keys handed in at load (§18.4)", () => {
	it("stored keys and records: nothing is persisted again and the seal epoch is the newest key", async () => {
		const { d } = await pinned(3);
		assert.equal(d.changes.length, 0);
		assert.equal(d.kc.sealEpoch(), 3);
	});

	it("a stored key that does not match its record is dropped; a QR key then pins the epoch", async () => {
		const d = await device({ keys: [{ e: 1, k: FORGED(1) }], records: [await genesis()] });
		assert.equal(d.kc.keyState(1).held, false);
		assert.equal(d.kr.keyMissing(), "no-key");
		assert.equal(await d.kr.installQr(1, K(1)), "verified");
		assert.equal(d.kr.keyMissing(), null);
	});

	it("crash after persisting an own roll key: the record in k is adopted; a concurrent winner replaces the key", async () => {
		const g = await genesis();
		const a = await device({ keys: [{ e: 1, k: K(1) }, { e: 2, k: K(2) }], records: [g] });
		await a.ingest([1, g], [2, await roll(2)]);
		assert.equal(a.kc.sealEpoch(), 2);
		assert.deepEqual(persistedEpochs(a), [], "the host already holds K_2");
		assert.equal(a.changes.at(-1)!.records.length, 2);
		const b = await device({ keys: [{ e: 1, k: K(1) }, { e: 2, k: FORGED(2) }], records: [g] });
		await b.ingest([1, g], [2, await roll(2)]);
		assert.ok(await holds(b, 2, K(2)));
		assert.deepEqual(persistedEpochs(b), [2]);
	});
});
