/**
 * The key-roll prompt after a device removal (e2ee-design §14.5), end to end on the composed sim client under suite 1
 * (real WebCrypto under the virtual clock): A, B and C share an encrypted vault; the operator revokes C's pairing
 * ("Revoke pairing": its store retired, its sockets closed 4403, + 1 blocking removal in the relay's key-roll signal).
 *  - A and B, online, hear VAULT_REKEY at once: their status carries the signal and main's rekeyDue asks;
 *  - A rolls the key with the recovery key (revokeRekey, §14.2): its won revoke record acks the removal
 *    (VAULT_REKEYED) and every device's signal goes quiet, so nothing asks again;
 *  - B follows the revoke (revoked-epoch, so it could not roll anyway) and takes the new key by QR;
 *  - C, removed, never gets the new epoch's key: it holds epoch 1 only, and the relay refuses it.
 * The second unit takes B offline across the removal and A's roll: at its next connect VAULT_READY says the removal
 * is covered, so B never asks; and a device offline across the removal alone learns it at its next connect.
 */
import assert from "node:assert/strict";
import { defaultPluginData, type YaosPluginData } from "../host/ui/api";
import { rekeyDue } from "../host/ui/rekeyPrompt";
import type { StatusSnapshot } from "../protocol/status";
import { VirtualClock } from "./clock";
import { SimDevice } from "./device";
import { e2eeOf, isLive, keyMissing, lastStatus, onboardSuite1, qrInstall, seededRk, settleOn, storedEpochs } from "./e2ee";
import { SimNet } from "./net";
import { SeededRandom } from "./random";
import { simTest } from "./testkit/simTest";

function world(seed: number): { clock: VirtualClock; net: SimNet; devs: [SimDevice, SimDevice, SimDevice]; rng: SeededRandom } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const devs = ["A", "B", "C"].map((name) => new SimDevice({ name, clock, net, pin: null })) as [SimDevice, SimDevice, SimDevice];
	return { clock, net, devs, rng: new SeededRandom(seed) };
}

/** Main's decision on `d` (rekeyPrompt.ts): what the plugin would ask, from its pin and its engine's last status. */
function asks(d: SimDevice): number | null {
	const data: YaosPluginData = { ...defaultPluginData(d.name), ...(d.pinData.e2ee ? { e2ee: d.pinData.e2ee } : {}) };
	return rekeyDue({ data: () => data, status: () => lastStatus(d) });
}

const signalOf = (d: SimDevice): StatusSnapshot["rekey"] => lastStatus(d)?.rekey;

/** The operator's "Revoke pairing" of `d` (server host.ts revokeGrant "operator"): grant, store, sockets, signal. */
function revokePairing(net: SimNet, d: SimDevice): void {
	net.identities.revokeGrant(d.grantSecret!);
	net.removeDevice(d.deviceId);
	net.relay.countRemoval();
}

async function onboard(clock: VirtualClock, devs: readonly SimDevice[], rng: SeededRandom): Promise<void> {
	const r = await onboardSuite1(clock, devs, rng.fork("e2ee"));
	assert.ok(r.ok, r.lines.join("\n"));
	for (const d of devs) assert.deepEqual(signalOf(d), { removals: 0, rekeyed: 0 }, `${d.name}: VAULT_READY carries the signal`);
	for (const d of devs) assert.equal(asks(d), null, `${d.name}: nothing is due before a removal`);
}

/** A rolls the vault key with a recovery key (§14.2 step 2, "Re-key after revoking a device"); resolves once it won. */
async function roll(clock: VirtualClock, a: SimDevice, rng: SeededRandom): Promise<number> {
	const before = e2eeOf(a)!.sealEpoch;
	const rk = seededRk(rng.fork("rk-roll"));
	const r = await settleOn(clock, a.runtime.command({ t: "revokeRekey", rk }));
	assert.ok(r.ok, `revokeRekey: ${r.ok ? "" : r.error}`);
	assert.ok(await clock.runUntil(() => (e2eeOf(a)?.sealEpoch ?? 0) > before, 60_000), "A seals under the new epoch");
	return e2eeOf(a)!.sealEpoch;
}

simTest("rekey after removal: the online devices ask, one roll quiets them all, the removed device lacks the new key", 20, async () => {
	const { clock, net, devs, rng } = world(0x2e4e1);
	const [a, b, c] = devs;
	await onboard(clock, devs, rng);

	revokePairing(net, c);
	assert.ok(await clock.runUntil(() => signalOf(a)?.removals === 1 && signalOf(b)?.removals === 1, 10_000), "VAULT_REKEY reaches the live sockets");
	assert.equal(asks(a), 1, "A asks for a new vault key");
	assert.equal(asks(b), 1, "B asks too: either may roll");
	assert.equal(lastStatus(c)?.phase, "revoked", "C is cut off at the relay");

	const e = await roll(clock, a, rng);
	assert.equal(e, 2);
	assert.ok(await clock.runUntil(() => signalOf(a)?.rekeyed === 1 && signalOf(b)?.rekeyed === 1, 10_000), "the ack reaches every socket");
	assert.equal(net.relay.rekey.rekeyed, 1);
	assert.equal(asks(a), null, "no nagging after the roll");
	assert.ok(await clock.runUntil(() => keyMissing(b) === "revoked-epoch", 30_000), "B follows the revoke record");
	assert.equal(asks(b), null, "a device without the current key does not ask (it could not roll)");

	const qr = await qrInstall(clock, a, b, e);
	assert.ok(qr.ok, qr.ok ? "" : qr.error);
	assert.ok(await clock.runUntil(() => isLive(b) && e2eeOf(b)?.sealEpoch === e && keyMissing(b) === null, 60_000), "B re-keyed by QR");
	assert.equal(asks(b), null, "and still does not ask: the removal is covered");

	assert.ok(storedEpochs(a).includes(e) && storedEpochs(b).includes(e), "the kept devices hold the new epoch");
	assert.ok(!storedEpochs(c).includes(e), `C holds only ${JSON.stringify(storedEpochs(c))}: it never gets epoch ${e}`);
	assert.equal(net.relay.rekey.removals, 1);
});

simTest("rekey after removal: a device offline across the removal learns it at its next connect; across the roll too, it never asks", 25, async () => {
	const { clock, net, devs, rng } = world(0x2e4e2);
	const [a, b, c] = devs;
	await onboard(clock, devs, rng);

	// B offline across the removal: VAULT_READY tells it at the next connect.
	net.setOnline(b.machineKey, false);
	await clock.advance(5_000);
	revokePairing(net, c);
	assert.ok(await clock.runUntil(() => signalOf(a)?.removals === 1, 10_000));
	assert.equal(signalOf(b)?.removals, 0, "B is offline: it has not heard yet");
	net.setOnline(b.machineKey, true);
	assert.ok(await clock.runUntil(() => signalOf(b)?.removals === 1 && isLive(b), 120_000), "B learns it from VAULT_READY");
	assert.equal(asks(b), 1);

	// B offline across A's roll: at its next connect the removal is covered, so it never asks again.
	net.setOnline(b.machineKey, false);
	await clock.advance(5_000);
	const e = await roll(clock, a, rng);
	assert.ok(await clock.runUntil(() => signalOf(a)?.rekeyed === 1, 10_000));
	assert.equal(signalOf(b)?.rekeyed, 0, "B is offline: still the old signal");
	net.setOnline(b.machineKey, true);
	assert.ok(await clock.runUntil(() => signalOf(b)?.rekeyed === 1, 120_000), "VAULT_READY: covered");
	assert.equal(asks(b), null);
	assert.ok(await clock.runUntil(() => keyMissing(b) === "revoked-epoch", 60_000), "B then follows the revoke record");
	assert.ok(!storedEpochs(c).includes(e));
});
