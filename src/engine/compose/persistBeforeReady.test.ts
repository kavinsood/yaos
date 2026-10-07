/**
 * WP-E7 open question (b): HostKeyring.persist (keyringChanged, e2ee-design §18.4) may run before the engine's
 * `ready` and before main finished its own start. Main must store it then, in arrival order, without dropping a key
 * or the newest record set; and a key whose store failed must never become the seal epoch, whichever keyring of the
 * init (gate, key reader, a restarted runtime) looks at the adapter next.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { EngineInitConfig } from "../../protocol/messages";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SIM_VAULT_ID, SimNet } from "../../sim/net";
import { SeededRandom } from "../../sim/random";
import { createHostKeys } from "../../host/keys/hostKeys";
import { VaultKeyStore } from "../../host/keys/secretStore";
import { FakeSecretStorage } from "../../host/keys/testkit/fakeSecretStorage";
import { fakeEpochKey, fakeGenesisRecord } from "../../host/keys/testkit/kRecords";
import { testVaultId } from "../../host/keys/testkit/vaultIds";
import { createWebCryptoSuite1, type Suite1Crypto } from "../adapters/webCryptoSuite1";
import { Keyring, type KeyringChange } from "../keyring/keyring";
import { settleWith } from "../keyring/testkit/simWait";
import { K, VAULT, genesis, roll } from "../keyring/testkit/world";
import { HostKeyring } from "./hostKeyring";
import type { HostLink } from "./hostLink";
import { PinGate } from "./pinGate";

/** Main's side of keyringChanged: records the epochs it stored and zero-fills its copies. */
function storingLink(): { link: HostLink; stored: number[][] } {
	const stored: number[][] = [];
	const link = {
		keyringChanged: async (c: KeyringChange) => {
			stored.push(c.keys.map((x) => x.e));
			for (const x of c.keys) x.k.fill(0);
		},
	} as unknown as HostLink;
	return { link, stored };
}
const failingLink = { keyringChanged: async () => Promise.reject(new Error("store failed")) } as unknown as HostLink;

const suite1 = (keys: readonly { readonly e: number; readonly k: Uint8Array }[]): Promise<Suite1Crypto> =>
	createWebCryptoSuite1({ vaultId: VAULT, random: new SeededRandom(7), keys: keys.map((x) => ({ e: x.e, k: x.k.slice() })) });

const rows = (...r: (readonly [number, Uint8Array])[]) => r.map(([seq, bytes]) => ({ seq: seq as Seq, bytes }));

test("main stores keyringChanged before the engine answered init, in arrival order: keys are unioned and an empty record set keeps the stored one", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const dev = new SimDevice({ name: "U", clock, net, pin: null });
	void dev.start();
	for (let i = 0; i < 200 && !dev.engine; i++) await Promise.resolve();
	for (let t = 0; t < 100 && !dev.engine; t++) await clock.advance(1);
	const engine = dev.engine;
	assert.ok(engine, "the engine exists");
	assert.equal(engine.config, null, "and has not taken init yet: main is still starting");
	// Two changes back to back, the second carrying no records (§18.4 KeyringChange).
	const first = engine.link.keyringChanged({ keys: [{ e: 1, k: fakeEpochKey(9) }], records: [fakeGenesisRecord()], pending: null });
	const second = engine.link.keyringChanged({ keys: [{ e: 2, k: fakeEpochKey(10) }], records: [], pending: null });
	await settleWith(clock, Promise.all([first, second]));
	const held = new VaultKeyStore(dev.secrets, SIM_VAULT_ID, clock).load();
	assert.ok(held, "stored");
	assert.deepEqual(held.keys.map((x) => x.e), [1, 2], "both keys, in epoch order");
	assert.equal(held.records.length, 1, "the first change's record set survives the second (empty) one");
	for (const x of held.keys) x.k.fill(0);
	assert.equal(dev.pinData.e2ee?.suite, 1, "main's pin decision ran before the ack");
});

test("a key the gate's store failed to persist is not sealed under when the gate re-checks on the same adapter (§18.4)", async () => {
	const g = await genesis();
	const r2 = await roll(2);
	const crypto: EngineInitConfig["crypto"] = { suite: 1, keys: [], records: [g, r2] };
	const kc = await suite1([{ e: 1, k: K(1) }]);
	const ports = { relay: null, clock: null, random: null, crypto: kc } as unknown as EnginePorts;
	const gate = await PinGate.open(crypto, ports, { vaultId: VAULT, keyring: new HostKeyring(failingLink, crypto) });
	assert.equal(gate.open, false, "K_2 (from the roll's nextWrap) was not stored: closed");
	const main = storingLink();
	const open = await gate.recheck(ports, { vaultId: VAULT, keyring: new HostKeyring(main.link, crypto) });
	assert.ok(!open || main.stored.flat().includes(2), `the gate opened at seal epoch ${kc.sealEpoch()} with main holding epochs [${main.stored.flat().join(",")}]`);
	assert.equal(open, true, "K_2 is derived again and stored, then the gate opens");
	assert.equal(kc.sealEpoch(), 2);
});

test("a runtime restarted after a failed store does not seal under the key main never stored (§18.4)", async () => {
	const g = await genesis();
	const r2 = await roll(2);
	const kc = await suite1([{ e: 1, k: K(1) }]);
	const main = storingLink();
	const a = await Keyring.open({ mode: "suite1", vaultId: VAULT, kc, records: [g], persist: (c) => failingLink.keyringChanged(c) });
	await a.ingest(rows([1, g], [2, r2]));
	assert.equal(kc.sealEpoch(), 1, "the failed store holds the seal epoch at 1");
	assert.equal(a.keyMissing(), "no-key");
	a.dispose();
	// The restarted runtime's keyring: same adapter, main's records (still [g]), the stored k tail re-ingested.
	const b = await Keyring.open({ mode: "suite1", vaultId: VAULT, kc, records: [g], persist: (c) => main.link.keyringChanged(c) });
	await b.ingest(rows([1, g], [2, r2]));
	assert.ok(kc.sealEpoch() < 2 || main.stored.flat().includes(2), `seal epoch ${kc.sealEpoch()} with main holding epochs [${main.stored.flat().join(",")}]`);
	assert.equal(kc.sealEpoch(), 2, "K_2 is derived again, stored, then sealed under");
	assert.equal(b.keyMissing(), null);
	b.dispose();
});

test("a store that fails after the keyring was disposed (stop while keyringChanged is in flight) does not leave the key to the next keyring", async () => {
	const g = await genesis();
	const r2 = await roll(2);
	const kc = await suite1([{ e: 1, k: K(1) }]);
	let fail: ((e: Error) => void) | null = null;
	const a = await Keyring.open({ mode: "suite1", vaultId: VAULT, kc, records: [g], persist: () => new Promise<void>((_, reject) => void (fail = reject)) });
	const ingested = a.ingest(rows([1, g], [2, r2]));
	for (let i = 0; i < 2_000 && !fail; i++) await new Promise((r) => setTimeout(r, 1));
	assert.ok(fail, "keyringChanged is in flight");
	a.dispose();
	(fail as (e: Error) => void)(new Error("store failed"));
	await ingested;
	const main = storingLink();
	const b = await Keyring.open({ mode: "suite1", vaultId: VAULT, kc, records: [g], persist: (c) => main.link.keyringChanged(c) });
	await b.ingest(rows([1, g], [2, r2]));
	assert.ok(kc.sealEpoch() < 2 || main.stored.flat().includes(2), `seal epoch ${kc.sealEpoch()} with main holding epochs [${main.stored.flat().join(",")}]`);
	assert.equal(kc.sealEpoch(), 2);
	b.dispose();
});

test("an unpinned device's keyringChanged that arrives before SecretStorage loaded keeps the keys already stored (§6.1 Startup)", async () => {
	const clock = new VirtualClock();
	const vaultId = testVaultId("v");
	const backing = new Map<string, string>();
	// data.json was lost (§6.2): the device is unpinned, but SecretStorage still holds K_1 and the genesis.
	new VaultKeyStore(new FakeSecretStorage(backing), vaultId, clock).merge({ keys: [{ e: 1, k: fakeEpochKey(1) }], records: [fakeGenesisRecord()] });
	const fake = new FakeSecretStorage(backing, { loaded: false });
	const hk = createHostKeys({ store: new VaultKeyStore(fake, vaultId, clock), pin: () => undefined, creating: () => false });
	const stored = hk.persist({ keys: [{ e: 2, k: fakeEpochKey(2) }], records: [fakeGenesisRecord(), fakeGenesisRecord(0x5b)], pending: null });
	const outcome = stored.then(() => "stored", (e: unknown) => String(e));
	await clock.advance(10);
	fake.load();
	assert.equal(await settleWith(clock, outcome), "stored");
	const held = new VaultKeyStore(fake, vaultId, clock).load();
	assert.ok(held);
	assert.deepEqual(held.keys.map((x) => x.e), [1, 2], "K_1 was not overwritten");
	assert.equal(held.records.length, 2);
	for (const x of held.keys) x.k.fill(0);
});
