/**
 * e2ee-design §11.5 / §14.3: a revoke survives a reset or restore that drops it from `k`.
 *
 * Found by the E7 suite-1 sim (E2EE_FAULTS, 4 devices, seed 13): C revoked B (epoch 2); A and D, not re-keyed yet,
 * held it open (revoked-epoch). An epochReset emptied `k` while C was away. A and D kept only their winners, so they
 * forgot the revoke, wrote under K_1 again and D rolled into epoch 2. C came back with its revoke for 2 and did not
 * re-publish it (`k` had "a record" for 2): a fork no QR could close, and B (holding K_1) could open D's roll.
 *
 * - A kept device stores the revoke it holds open with its winners, so after a reset it stays revoked-epoch (writes
 *   nothing, rolls nothing) until it is re-keyed, and then re-publishes the revoke.
 * - A revoke winner is re-published over another record for its epoch (revoke outranks roll whatever the seq
 *   order, §11.3): devices that took the roll stop (revoked-epoch) instead of forking silently.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KeyRecordKind } from "./record";
import { FORGED, K, RK_A, RK_B, device, genesis, revoke, roll } from "./testkit/world";

describe("an open revoke across a reset (§11.5, §14.3)", () => {
	it("is stored with the winners; after a reset the device stays revoked-epoch until re-keyed, then re-publishes it", async () => {
		const [g, r2] = [await genesis(), await revoke(2)];
		const kept = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		await kept.ingest([1, g], [6, r2]);
		assert.equal(kept.kr.keyMissing(), "revoked-epoch");
		const stored = kept.changes.at(-1)?.records ?? [];
		assert.deepEqual(stored, [g, r2], "the open revoke is stored after the winners");

		// A new vaultEpoch: `k` holds only a re-published genesis.
		const after = await device({ keys: [{ e: 1, k: K(1) }], records: stored });
		await after.ingest([1, g]);
		assert.equal(after.kr.keyMissing(), "revoked-epoch", "the write gate stays shut");
		assert.equal(after.kr.rollDue(1_000_000, 1_000_000, 1, 1), false, "no roll into the revoked epoch");
		assert.equal(after.kr.staleCheck(1, 2), "hold", "K_1 rows past the reset are held, not opened");
		assert.equal(after.kr.rowCount, 1, "a stored record is not a `k` row");
		assert.equal(await after.kr.installQr(2, K(2)), "verified");
		assert.equal(after.kr.keyMissing(), null);
		assert.equal(after.kc.sealEpoch(), 2);
		assert.deepEqual(after.kr.republishable(), [r2]);
		assert.deepEqual(after.changes.at(-1)?.records, [g, r2]);
	});

	it("after a restart in the same vaultEpoch the stored revoke takes its `k` seq: rows below it still open", async () => {
		const [g, r2] = [await genesis(), await revoke(2)];
		const kept = await device({ keys: [{ e: 1, k: K(1) }], records: [g, r2] });
		await kept.ingest([1, g], [6, r2]);
		assert.equal(kept.kr.keyMissing(), "revoked-epoch");
		assert.equal(kept.kr.staleCheck(1, 3), null);
		assert.equal(kept.kr.staleCheck(1, 7), "hold");
		assert.equal(kept.kr.rowCount, 2);
		assert.equal(await kept.kr.installQr(2, K(2)), "verified");
		assert.equal(kept.kr.staleCheck(1, 7), "stale");
		assert.deepEqual(kept.kr.republishable(), []);
	});

	it("a revoke winner is re-published over a roll that took its epoch; a device that took the roll then stops", async () => {
		const [g, r2, other] = [await genesis(), await revoke(2), await roll(2, K(1), FORGED(2))];
		const revoker = await device({ keys: [{ e: 1, k: K(1) }, { e: 2, k: K(2) }], records: [g, r2] });
		await revoker.ingest([1, g], [2, other]);
		assert.equal(revoker.kc.sealEpoch(), 2);
		assert.deepEqual(revoker.kr.republishable(), [r2]);
		await revoker.ingest([3, r2]);
		assert.deepEqual(revoker.kr.republishable(), [], "once `k` shows it, nothing more");

		const took = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		await took.ingest([1, g], [2, other]);
		assert.equal(took.kc.sealEpoch(), 2, "nothing in `k` outranks the roll yet");
		await took.ingest([3, r2]);
		assert.equal(took.kr.keyMissing(), "revoked-epoch");
	});

	it("a forged revoke it cannot judge also survives the reset (fail closed); a re-key revoke under the RK ends it", async () => {
		const [g, forged] = [await genesis(), await revoke(2, RK_B, FORGED(1), FORGED(2))];
		const kept = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		await kept.ingest([1, g], [6, forged]);
		assert.equal(kept.kr.keyMissing(), "revoked-epoch");
		const after = await device({ keys: [{ e: 1, k: K(1) }], records: kept.changes.at(-1)!.records });
		await after.ingest([1, g]);
		assert.equal(after.kr.keyMissing(), "revoked-epoch", "a reset is no way around a revoke the device saw");
		assert.deepEqual(after.kr.republishable(), [], "an unjudged record is never re-published");
		const own = await after.kr.propose(KeyRecordKind.revoke, RK_A.slice());
		assert.equal(own.e, 2);
		await after.ingest([2, own.bytes]);
		assert.equal(await after.kr.settleOwn(), "won");
		assert.equal(after.kr.keyMissing(), null);
		assert.equal(after.kc.sealEpoch(), 2);
		assert.deepEqual(after.changes.at(-1)?.records, [g, own.bytes], "the forged record is no longer stored");
	});
});
