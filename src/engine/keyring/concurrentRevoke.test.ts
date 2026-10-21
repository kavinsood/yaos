/**
 * e2ee-design §11.3, §14.2: two kept devices re-key after a revoke at the same time, each under a recovery key it
 * generated. The first record in `k` wins epoch 2. The second revoker cannot open it (another RK), and it used to pass
 * over it as garbage and adopt its own K_2: the vault forked, each side's rows failing auth on the other, and the
 * second revoker's log never caught up (suite-1 sim E2EE faults seed 89423454, SIM-E2EE-LOG-BUSY). It now waits,
 * revoked-epoch, until an out-of-band key judges the first record; its own then loses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyRecordKind } from "./record";
import { FORGED, K, RK_A, RK_B, device, genesis, holds, revoke } from "./testkit/world";

test("a second revoke for an epoch, under another RK, does not win past the first it cannot open", async () => {
	const g = await genesis();
	const first = await revoke(2, RK_A, K(1), K(2)); // the other device's, under its new RK
	const second = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
	await second.ingest([1, g]);
	const own = await second.kr.propose(KeyRecordKind.revoke, RK_B.slice());
	assert.equal(own.e, 2);
	await second.ingest([5, first], [6, own.bytes]);
	assert.equal(await second.kr.settleOwn(), "pending", "its own record is behind one it cannot judge");
	assert.equal(second.kr.keyMissing(), "revoked-epoch", "nothing is sealed meanwhile");
	assert.notEqual(second.kc.sealEpoch(), 2);
	// The user scans the first revoker's re-key QR.
	assert.equal(await second.kr.installQr(2, K(2)), "verified");
	assert.equal(await second.kr.settleOwn(), "lost");
	assert.equal(second.kr.keyMissing(), null);
	assert.equal(second.kc.sealEpoch(), 2);
	assert.ok(await holds(second, 2, K(2)), "the first record's K_2");
});

test("a garbage revoke ahead of an own revoke: denial of service until a QR key, never a fork", async () => {
	const g = await genesis();
	const garbage = await revoke(2, RK_A, FORGED(1), FORGED(2)); // a hostile server's record: no device holds its keys
	const dev = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
	await dev.ingest([1, g]);
	const own = await dev.kr.propose(KeyRecordKind.revoke, RK_B.slice());
	await dev.ingest([5, garbage], [6, own.bytes]);
	assert.equal(await dev.kr.settleOwn(), "pending");
	assert.equal(dev.kr.keyMissing(), "revoked-epoch");
	// An out-of-band key for epoch 2 (the own record's, as its re-key QR carries it) judges the garbage invalid.
	const k2 = (dev.changes.flatMap((c) => c.keys).find((x) => x.e === 2)?.k ?? new Uint8Array()).slice();
	assert.equal(k2.length, 32, "the own K_2 was persisted before the append");
	assert.equal(await dev.kr.installQr(2, k2), "verified");
	assert.equal(await dev.kr.settleOwn(), "won");
	assert.equal(dev.kr.keyMissing(), null);
});
