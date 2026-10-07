/**
 * WP-E7 open question (c): two records proposed concurrently for one epoch (e2ee-design §11.3 "the first valid
 * one", §11.4 step 4, §14.2 step 2, §15.1).
 *
 * - Two geneses in `k`: the first in seq order wins. The other creator cannot judge it (another RK, evaluate.ts
 *   "a wrong or older RK cannot be told from a forged recoveryWrap"), so it must not adopt its own later record: it
 *   loses, keeps no K_1, main stores no record and sets no pin, and it joins the winner's key like any key-less
 *   device. A device that holds only the losing creator's RK waits too.
 * - Two revokes under the same RK: the first wins on both devices; the second device adopts its key.
 *
 * Keys are the testkit's fixed ranges or the devices' own; they are compared by kcv or bytesEqual, never printed.
 */
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { bytesEqual } from "../../core/codec/lib0";
import { KEYRING_STREAM } from "../../core/types";
import type { Seq } from "../../core/types";
import type { E2eeStatus, StatusSnapshot } from "../../protocol/status";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SIM_VAULT_ID, SimNet } from "../../sim/net";
import { VaultKeyStore } from "../../host/keys/secretStore";
import { KeyRecordKind } from "./record";
import { advanceUntil, settleWith } from "./testkit/simWait";
import { K, RK_A, RK_B, device, genesis, type Device } from "./testkit/world";

const kcvOf = async (d: Device, e: number): Promise<Uint8Array> => d.kc.kcv(e);
const GARBAGE = Uint8Array.of(0xff, 0x00, 0x13);

describe("concurrent geneses (§11.3, §15.1)", () => {
	for (const batches of ["one read", "two reads"] as const) {
		it(`${batches}: the first genesis in k wins; the second creator loses, drops its K_1 and hands main no record`, async () => {
			const w = await device({ mode: "unpinned" });
			const l = await device({ mode: "unpinned" });
			const ownW = await w.kr.propose(KeyRecordKind.genesis, RK_A.slice());
			const ownL = await l.kr.propose(KeyRecordKind.genesis, RK_B.slice());
			for (const d of [w, l]) {
				if (batches === "one read") await d.ingest([1 as Seq, ownW.bytes], [2 as Seq, ownL.bytes]);
				else {
					await d.ingest([1 as Seq, ownW.bytes]);
					await d.ingest([2 as Seq, ownL.bytes]);
				}
			}
			assert.equal(await w.kr.settleOwn(), "won");
			assert.equal(await l.kr.settleOwn(), "lost", "the earlier genesis cannot be judged without its RK: the own later one does not win");
			assert.equal(l.kc.keyState(1).held, false, "the own K_1 is out of the adapter");
			assert.equal(l.kc.sealEpoch(), 0);
			assert.deepEqual(l.kr.summary().epochs, [], "no winner on the loser");
			assert.ok(!l.codes().includes("keyring/adopted"));
			assert.ok(l.changes.every((c) => c.records.length === 0), "main never got a record from the loser, so it never pins (pin.ts pinsFromKeyring)");
			assert.equal(l.changes.at(-1)!.pending, null, "the pending K_1 is released");
			assert.equal(w.kc.sealEpoch(), 1);
			assert.equal(w.changes.at(-1)!.records.length, 1);
		});
	}

	it("a reader holding only the losing creator's RK waits; with the winner's RK it gets the winner's K_1", async () => {
		const w = await device({ mode: "unpinned" });
		const ownW = await w.kr.propose(KeyRecordKind.genesis, RK_A.slice());
		await w.ingest([1 as Seq, ownW.bytes]);
		assert.equal(await w.kr.settleOwn(), "won");
		const second = await genesis(RK_B, K(1));
		const r = await device({ mode: "unpinned" });
		await r.ingest([1 as Seq, ownW.bytes], [2 as Seq, second]);
		assert.equal(await r.kr.installRk(RK_B.slice()), "pending", "RK_B opens only the second genesis");
		assert.deepEqual(r.kr.summary().epochs, []);
		assert.equal(r.changes.length, 0, "nothing persisted");
		assert.equal(await r.kr.installRk(RK_A.slice()), "verified");
		assert.ok(bytesEqual(await kcvOf(r, 1), await kcvOf(w, 1)), "the winner's K_1");
	});
});

describe("concurrent revokes under the same RK (§14.2 step 2)", () => {
	it("the first revoke wins on both devices; the second device adopts its K_r, even with another k row read in between", async () => {
		const g = await genesis();
		const a = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		const b = await device({ keys: [{ e: 1, k: K(1) }], records: [g] });
		const ownA = await a.kr.propose(KeyRecordKind.revoke, RK_A.slice());
		const ownB = await b.kr.propose(KeyRecordKind.revoke, RK_A.slice());
		assert.equal(ownA.e, 2);
		assert.equal(ownB.e, 2);
		for (const d of [a, b]) {
			await d.ingest([9 as Seq, GARBAGE]);
			await d.ingest([10 as Seq, ownA.bytes], [11 as Seq, ownB.bytes]);
		}
		assert.equal(await a.kr.settleOwn(), "won");
		assert.equal(await b.kr.settleOwn(), "lost", "B judges A's revoke with the RK it proposed under");
		assert.equal(b.kc.sealEpoch(), 2);
		assert.ok(bytesEqual(await kcvOf(b, 2), await kcvOf(a, 2)), "both seal under A's K_2");
		assert.ok(bytesEqual(b.changes.at(-1)!.records[1]!, ownA.bytes), "main stores A's record on B");
		assert.equal(b.kr.minSendEpoch(), 2);
	});
});

// ---- over SimRelay -----------------------------------------------------------------------------

const last = (d: SimDevice): StatusSnapshot | null => d.ui.statuses.at(-1) ?? null;
const e2ee = (d: SimDevice): E2eeStatus | undefined => last(d)?.e2ee;
const isLive = (d: SimDevice): boolean => last(d)?.phase === "live";

async function wait(clock: VirtualClock, what: string, done: () => boolean, horizonMs = 60_000): Promise<void> {
	assert.ok(await advanceUntil(clock, done, horizonMs), what);
}
async function restart(clock: VirtualClock, d: SimDevice): Promise<void> {
	await settleWith(clock, d.runtime.stop());
	await settleWith(clock, d.restartApp());
}
const stored = (clock: VirtualClock, d: SimDevice) => new VaultKeyStore(d.secrets, SIM_VAULT_ID, clock).load();
const outcome = (p: Promise<unknown>): Promise<string> =>
	p.then((v) => JSON.stringify(v), (e: unknown) => ((e as { error?: { code?: string } }).error?.code === "refused" || /refused/.test(String(e)) ? "refused" : `error: ${String(e)}`));

test("two creators enable E2EE at once over SimRelay: the genesis at seq 1 wins, the other stays unpinned and writes nothing, then joins the same K_1 by QR", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const make = (name: string) => {
		const d = new SimDevice({ name, clock, net, pin: null });
		d.pinData = { creating: { vaultId: SIM_VAULT_ID } };
		void d.start();
		return d;
	};
	const p = make("P");
	const q = make("Q");
	await wait(clock, "both creatable", () => e2ee(p)?.creatable === true && e2ee(q)?.creatable === true);
	const outcomes = await settleWith(clock, Promise.all([
		outcome(p.runtime.command({ t: "enableE2ee", rk: RK_A.slice() })),
		outcome(q.runtime.command({ t: "enableE2ee", rk: RK_B.slice() })),
	]));
	const k = net.relay.rows(KEYRING_STREAM);
	assert.equal(k.length, 2, "both geneses committed");
	const [winner, loser] = k[0]!.deviceId === p.deviceId ? [p, q] : [q, p];
	const byName = new Map([[p.name, outcomes[0]], [q.name, outcomes[1]]]);
	assert.equal(byName.get(winner.name), JSON.stringify({ t: "ok" }), "the creator of seq 1 wins");
	assert.equal(byName.get(loser.name), "refused", "the other creator's enableE2ee is refused");

	await wait(clock, "main pinned the winner", () => winner.pinData.e2ee?.suite === 1);
	await clock.advance(10_000);
	assert.equal(loser.pinData.e2ee, undefined, "no pin on the loser");
	assert.equal(stored(clock, loser)?.records.length ?? 0, 0, "main stored no record for the loser");
	assert.equal(e2ee(loser)?.keyMissing, "encrypted-vault");
	const loserRows = net.relay.streams().flatMap((s) => net.relay.rows(s).filter((r) => r.deviceId === loser.deviceId));
	assert.deepEqual(loserRows.map((r) => r.stream), [KEYRING_STREAM], "the loser wrote its genesis and nothing else");

	await restart(clock, winner);
	await wait(clock, "winner live under K_1", () => isLive(winner) && e2ee(winner)?.sealEpoch === 1);
	const k1 = stored(clock, winner)!.keys.find((x) => x.e === 1)!.k;
	assert.deepEqual(await settleWith(clock, loser.runtime.command({ t: "installKey", source: "qr", e: 1, k: k1.slice() })), { t: "ok" });
	await wait(clock, "main pinned the loser after the QR", () => loser.pinData.e2ee?.suite === 1);
	await restart(clock, loser);
	await wait(clock, "loser live under K_1", () => isLive(loser) && e2ee(loser)?.sealEpoch === 1);
	const k1Loser = stored(clock, loser)!.keys.find((x) => x.e === 1)!.k;
	assert.ok(bytesEqual(k1, k1Loser), "both devices hold the winner's K_1");
	k1.fill(0);
	k1Loser.fill(0);
	winner.vault.userWrite("notes/w.md", "from the winner\n");
	loser.vault.userWrite("notes/l.md", "from the loser\n");
	await wait(clock, "each reads the other", () => loser.vault.textOf("notes/w.md") === "from the winner\n" && winner.vault.textOf("notes/l.md") === "from the loser\n");
});
