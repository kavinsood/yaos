import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type DeviceId, type StreamName } from "../../core/types";
import type { BlobPort, EnginePorts } from "../../ports";
import type { EngineInitConfig } from "../../protocol/messages";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { advanceUntil, settleWith } from "../keyring/testkit/simWait";
import { K, VAULT, genesis, genesisFor, revoke, roll } from "../keyring/testkit/world";
import { simHashPort } from "../../sim/hash";
import { SeededRandom } from "../../sim/random";
import { connectPeer, frame, pump } from "../../sim/a-relay-testkit";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SIM_VAULT_ID, SimNet } from "../../sim/net";
import type { E2eeStatus, StatusSnapshot } from "../../protocol/status";
import { sameKeys, VaultKeyStore } from "../../host/keys/secretStore";
import { fakeEpochKey, fakeGenesisRecord } from "../../host/keys/testkit/kRecords";
import { testVaultId } from "../../host/keys/testkit/vaultIds";
import { HostKeyring } from "./hostKeyring";
import type { HostLink } from "./hostLink";
import { PinGate, WriteRefused } from "./pinGate";

// --- the gate itself -----------------------------------------------------------------------------------------

/** Main's side of keyringChanged: stores (here: counts) and answers. */
function fakeLink(): { link: HostLink; changes: number[][] } {
	const changes: number[][] = [];
	const link = {
		keyringChanged: async (c: { readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[] }) => {
			changes.push(c.keys.map((x) => x.e));
			for (const x of c.keys) x.k.fill(0);
		},
	} as unknown as HostLink;
	return { link, changes };
}

async function suite1Ports(vaultId: string, keys: readonly { readonly e: number; readonly k: Uint8Array }[]): Promise<EnginePorts> {
	const crypto = await createWebCryptoSuite1({ vaultId, random: new SeededRandom(7), keys: keys.map((x) => ({ e: x.e, k: x.k.slice() })) });
	return { relay: null, clock: null, random: null, crypto } as unknown as EnginePorts;
}

async function gateFor(crypto: EngineInitConfig["crypto"], ports: EnginePorts, link = fakeLink().link): Promise<PinGate> {
	return PinGate.open(crypto, ports, { vaultId: VAULT, keyring: new HostKeyring(link, crypto) });
}

test("PinGate: suite 0 open; unpinned closed; suite 1 open only with the newest stored winner's key, verified", async () => {
	const plainPorts = { relay: null, clock: null, random: null, crypto: createNoopCrypto(simHashPort()) } as unknown as EnginePorts;
	const plain = await gateFor({ suite: 0 }, plainPorts);
	assert.equal(plain.open, true);
	assert.equal(plain.creating, false);
	assert.equal(plain.writerPorts(plainPorts), plainPorts);
	const unpinned = await gateFor({ suite: null, creating: true }, await suite1Ports(VAULT, []));
	assert.equal(unpinned.open, false);
	assert.equal(unpinned.creating, true);
	assert.throws(() => unpinned.writerPorts(plainPorts), WriteRefused);
	const g = await genesis();
	const ports = await suite1Ports(VAULT, [{ e: 1, k: K(1) }]);
	const keyed = await gateFor({ suite: 1, keys: [], records: [g] }, ports);
	assert.equal(keyed.open, true, "K_1 verifies against the stored genesis");
	assert.equal(keyed.writerPorts(ports), ports);
	const noKey = await gateFor({ suite: 1, keys: [], records: [g] }, await suite1Ports(VAULT, []));
	assert.equal(noKey.open, false, "no key");
	assert.throws(() => noKey.writerPorts(plainPorts), WriteRefused);
	const noRecord = await gateFor({ suite: 1, keys: [], records: [] }, await suite1Ports(VAULT, [{ e: 1, k: K(1) }]));
	assert.equal(noRecord.open, false, "a key without a stored record is not verified");
	const wrong = await gateFor({ suite: 1, keys: [], records: [g] }, await suite1Ports(VAULT, [{ e: 1, k: K(2) }]));
	assert.equal(wrong.open, false, "a key that fails the record's kcv");
	const main = fakeLink();
	const older = await gateFor({ suite: 1, keys: [], records: [g, await roll(2)] }, await suite1Ports(VAULT, [{ e: 1, k: K(1) }]), main.link);
	assert.equal(older.open, true, "K_2 is reached through the roll's nextWrap");
	assert.deepEqual(main.changes, [[2]], "and stored by main before the gate opens (persist-before-use)");
	const failing = { keyringChanged: async () => Promise.reject(new Error("store failed")) } as unknown as HostLink;
	const unstored = await gateFor({ suite: 1, keys: [], records: [g, await roll(2)] }, await suite1Ports(VAULT, [{ e: 1, k: K(1) }]), failing);
	assert.equal(unstored.open, false, "a key main could not store is not used");
	const stale = await gateFor({ suite: 1, keys: [], records: [g, await revoke(2)] }, await suite1Ports(VAULT, [{ e: 1, k: K(1) }]));
	assert.equal(stale.open, false, "a revoke above the held key: revoked-epoch");
});

test("PinGate.readerPorts: the session reads but cannot append or put a checkpoint; the creation path appends on k only", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const writer = await connectPeer(net.relay, clock, "dev-W");
	writer.session.append(frame("ns", "w-1", "entry"));
	await clock.advance(1_000);
	const base = { relay: net.port("dev-R" as DeviceId), clock, random: new SeededRandom(1), crypto: createNoopCrypto(simHashPort()) } as unknown as EnginePorts;
	const gate = await gateFor({ suite: null, creating: false }, base);
	const reader = gate.readerPorts(base);
	assert.equal(reader.keys, null, "a suite-0 adapter has no key operations");
	const r = await pump(clock, reader.relay.connect({ vaultId: SIM_VAULT_ID, deviceId: "dev-R" as DeviceId }));
	assert.ok(r.ok);
	const s = r.session;
	assert.equal(s.canWrite, false);
	assert.throws(() => s.append(frame("ns", "r-1", "x")), WriteRefused);
	assert.throws(() => s.append(frame(KEYRING_STREAM, "r-2", "x")), WriteRefused, "not on the creation path: not even k");
	await assert.rejects(s.putCheckpoint("ns" as StreamName, 1, 0, new Uint8Array(3)), WriteRefused);
	const page = await pump(clock, s.read("ns" as StreamName, 0, false));
	assert.equal(page.rows.length, 1, "reads pass through");
	await clock.advance(1_000);
	assert.equal(net.relay.counters().appendFrames, 1, "only the writer's frame");
	assert.equal(net.relay.checkpoint("ns" as StreamName), null);
	const creating = await gateFor({ suite: null, creating: true }, base);
	const c = await pump(clock, creating.readerPorts({ ...base, relay: net.port("dev-C" as DeviceId) }).relay.connect({ vaultId: SIM_VAULT_ID, deviceId: "dev-C" as DeviceId }));
	assert.ok(c.ok);
	assert.equal(c.session.canWrite, true);
	assert.throws(() => c.session.append(frame("ns", "c-1", "x")), WriteRefused, "only k");
	await assert.rejects(c.session.putCheckpoint(KEYRING_STREAM, 1, 0, new Uint8Array(3)), WriteRefused);
	c.session.append(frame(KEYRING_STREAM, "c-2", "x"));
	await clock.advance(1_000);
	assert.equal(net.relay.rows(KEYRING_STREAM).length, 1, "the one write: on k");
});

// --- an unpinned device in the sim ---------------------------------------------------------------------------

/** A BlobPort that counts every call (the relay-side blob store is not in the sim). */
function countingBlob(): { port: BlobPort; puts: number; calls: number } {
	const c = {
		puts: 0,
		calls: 0,
		port: {
			maxBlobBytes: 1 << 20,
			has: async () => {
				c.calls++;
				return new Set();
			},
			put: async () => {
				c.calls++;
				c.puts++;
			},
			get: async () => {
				c.calls++;
				return null;
			},
			list: async () => {
				c.calls++;
				return { items: [], next: null };
			},
			deleteIfUploadedBefore: async () => {
				c.calls++;
				return [];
			},
		} as BlobPort,
	};
	return c;
}

function relayState(net: SimNet): { head: number; appendFrames: number; checkpoints: string } {
	const checkpoints = net.relay.streams().map((s) => `${s}:${net.relay.checkpoint(s)?.coversSeq ?? "-"}`).join(",");
	return { head: net.relay.head(), appendFrames: net.relay.counters().appendFrames, checkpoints };
}

function rowsBy(net: SimNet, deviceId: DeviceId): number {
	let n = 0;
	for (const s of net.relay.streams()) n += net.relay.rows(s, { includeGc: true }).filter((r) => r.deviceId === deviceId).length;
	return n;
}

function lastStatusOrNull(d: SimDevice): StatusSnapshot | null {
	return d.ui.statuses.at(-1) ?? null;
}

function lastStatus(d: SimDevice): StatusSnapshot {
	const s = d.ui.statuses.at(-1);
	if (!s) throw new Error("no status");
	return s;
}

function e2eeOf(d: SimDevice): E2eeStatus | undefined {
	return lastStatus(d).e2ee;
}

/** B (suite 0) syncs a few notes to the relay, then goes away. */
async function seeded(): Promise<{ clock: VirtualClock; net: SimNet }> {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const b = new SimDevice({ name: "B", clock, net });
	b.vault.userWrite("notes/b.md", "from b\n");
	b.vault.userWrite("notes/c.md", "more\n");
	b.vault.externalWrite("img.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
	void b.start();
	await clock.advance(10_000);
	assert.ok(net.relay.head() > 0, "B wrote");
	b.crashApp();
	await clock.advance(1_000);
	return { clock, net };
}

test("unpinned device: connects and reads, writes nothing anywhere (frames, checkpoints, blobs, IndexedDB, side files, disk)", async () => {
	const { clock, net } = await seeded();
	const blob = countingBlob();
	const u = new SimDevice({ name: "U", clock, net, pin: null, blob: () => blob.port });
	u.vault.userWrite("mine.md", "local only\n");
	const diskBefore = [...u.vault.snapshot()];
	const before = relayState(net);
	void u.start();
	await clock.advance(30_000);
	u.vault.userWrite("mine2.md", "typed while blocked\n");
	u.platform.emit("visible");
	await clock.advance(30_000);
	assert.equal(lastStatus(u).phase, "key-missing");
	assert.deepEqual(e2eeOf(u), { suite: null, sealEpoch: 0, keyMissing: "no-pin", keyringSeen: false, creatable: false });
	assert.equal(lastStatus(u).relay.connected, true, "it does connect (to read k)");
	assert.deepEqual(relayState(net), before, "relay: head, frames appended and checkpoints all unchanged");
	assert.equal(rowsBy(net, u.deviceId), 0, "no row from U on any stream");
	assert.equal(blob.puts, 0, "no blob put");
	assert.equal(blob.calls, 0, "the blob store is never touched");
	assert.deepEqual(await u.storage.listDatabases(), [], "no IndexedDB database");
	assert.equal(u.sideFiles.writes, 0, "no side-file write (outbox / synced mirrors, snapshots)");
	assert.equal(u.vault.hasFile("notes/b.md"), false, "nothing materialized from the relay");
	assert.deepEqual([...u.vault.snapshot()], [...diskBefore, ["mine2.md", "typed while blocked\n"]], "disk holds only the user's own writes");
	// A k genesis from an encrypted device: keyringSeen, still blocked, still silent.
	const z = await connectPeer(net.relay, clock, "dev-Z");
	z.session.append(frame(KEYRING_STREAM, "z-genesis", fakeGenesisRecord()));
	await clock.advance(10_000);
	assert.deepEqual(e2eeOf(u), { suite: null, sealEpoch: 0, keyMissing: "encrypted-vault", keyringSeen: true, creatable: false });
	assert.equal(lastStatus(u).phase, "key-missing");
	assert.equal(relayState(net).appendFrames, before.appendFrames + 1, "only Z's genesis");
	assert.equal(rowsBy(net, u.deviceId), 0);
	assert.equal(blob.puts, 0);
	assert.deepEqual(await u.storage.listDatabases(), []);
	assert.equal(u.sideFiles.writes, 0);
});

test("unpinned device: keyringSeen is read from k history and survives a reconnect", async () => {
	const { clock, net } = await seeded();
	const z = await connectPeer(net.relay, clock, "dev-Z");
	z.session.append(frame(KEYRING_STREAM, "z-genesis", fakeGenesisRecord()));
	await clock.advance(2_000);
	const u = new SimDevice({ name: "U", clock, net, pin: null });
	void u.start();
	await clock.advance(10_000);
	assert.equal(e2eeOf(u)?.keyringSeen, true, "read from history at connect");
	net.relay.dropSession(u.deviceId);
	await clock.advance(30_000);
	assert.equal(lastStatus(u).relay.connected, true, "reconnected");
	assert.equal(e2eeOf(u)?.keyMissing, "encrypted-vault");
	assert.equal(rowsBy(net, u.deviceId), 0);
});

test("creatable: only with the creation marker, on an empty relay with an empty k", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const c = new SimDevice({ name: "C", clock, net, pin: null });
	c.pinData = { creating: { vaultId: SIM_VAULT_ID } };
	void c.start();
	await clock.advance(5_000);
	assert.equal(c.engine?.config?.crypto.suite, null);
	assert.deepEqual(e2eeOf(c), { suite: null, sealEpoch: 0, keyMissing: "no-pin", keyringSeen: false, creatable: true });
	assert.equal(net.relay.counters().appendFrames, 0, "creatable still writes nothing until a pin");
	// Not creatable: a marker for another vault, or a relay that already holds data.
	const other = new SimDevice({ name: "O", clock, net, pin: null });
	other.pinData = { creating: { vaultId: testVaultId("another") } };
	void other.start();
	await clock.advance(5_000);
	assert.equal(e2eeOf(other)?.creatable, false);
	const s = await seeded();
	const late = new SimDevice({ name: "L", clock: s.clock, net: s.net, pin: null });
	late.pinData = { creating: { vaultId: SIM_VAULT_ID } };
	void late.start();
	await s.clock.advance(5_000);
	assert.equal(e2eeOf(late)?.creatable, false, "VAULT_READY.head > 0");
});

test("unpinned engine: key commands go to the key reader; refusals are `refused`, and no key bytes stay with the sender", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const u = new SimDevice({ name: "U", clock, net, pin: null });
	void u.start();
	await clock.advance(5_000);
	const refused = (e: unknown) => (e as { error?: { code?: string } }).error?.code === "refused" || /refused/.test(String(e));
	const sent: Uint8Array[] = [];
	const run = (command: Parameters<SimDevice["runtime"]["command"]>[0]) => pump(clock, u.runtime.command(command));
	const rk = fakeEpochKey(21);
	const k = fakeEpochKey(22);
	sent.push(rk, k);
	assert.deepEqual(await run({ t: "installKey", source: "rk", rk }), { t: "ok" }, "held until k shows a record");
	assert.deepEqual(await run({ t: "installKey", source: "qr", e: 1, k }), { t: "ok" }, "pending until k shows its record");
	assert.deepEqual(await run({ t: "pinSuite0", source: "link" }), { t: "ok" }, "k read to head and empty: main may pin suite 0");
	await assert.rejects(run({ t: "pinSuite0", source: "create" }), refused, "not started on the creation path");
	const e1 = fakeEpochKey(23);
	const r1 = fakeEpochKey(24);
	sent.push(e1, r1);
	await assert.rejects(run({ t: "enableE2ee", rk: e1 }), refused, "not on the creation path");
	await assert.rejects(run({ t: "revokeRekey", rk: r1 }), refused, "nothing to revoke");
	for (const b of sent) assert.ok(b.byteLength === 0 || b.every((x) => x === 0), "zero-filled or transferred");
	assert.equal(lastStatus(u).phase, "key-missing");
	assert.equal(net.relay.counters().appendFrames, 0);
	assert.equal(u.secrets.writes, 0, "no unverified key reached SecretStorage");
});

// --- keys live in SecretStorage, not IndexedDB -----------------------------------------------------------------

test("IndexedDB wipe keeps the keys: SecretStorage is outside the engine store", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const d = new SimDevice({ name: "E", clock, net, pin: { suite: 1 } });
	const key = K(1);
	new VaultKeyStore(d.secrets, SIM_VAULT_ID, clock).merge({ keys: [{ e: 1, k: key.slice() }], records: [await genesisFor(SIM_VAULT_ID)] });
	void d.start();
	const keyedLive = (): boolean => { const s = lastStatusOrNull(d); return s?.phase === "live" && s.e2ee?.keyringSeen === true; };
	assert.ok(await advanceUntil(clock, keyedLive, 30_000), "suite 1 with the stored key and record: live, k read");
	const first = d.engine?.config?.crypto;
	assert.equal(first?.suite, 1);
	assert.equal(first?.suite === 1 ? first.keys.length : -1, 1, "the engine got the stored key");
	assert.ok(first?.suite === 1 && first.keys.every((x) => x.k.byteLength === 0 || x.k.every((b) => b === 0)), "and keeps no copy in the config");
	assert.deepEqual(e2eeOf(d), { suite: 1, sealEpoch: 1, keyMissing: null, keyringSeen: true, creatable: false });
	assert.equal(net.relay.rows(KEYRING_STREAM).length, 1, "the stored genesis was re-published into the empty k (§11.5)");
	d.crashApp({ wipe: true });
	await clock.advance(1_000);
	assert.deepEqual(await d.storage.listDatabases(), [], "IndexedDB is gone");
	const before = d.ui.statuses.length;
	await settleWith(clock, d.restartApp());
	assert.ok(await advanceUntil(clock, () => d.engineStarts === 2 && d.ui.statuses.length > before && keyedLive(), 30_000), "live again after the wipe");
	const held = new VaultKeyStore(d.secrets, SIM_VAULT_ID, clock).load();
	assert.ok(held && sameKeys(held.keys, [{ e: 1, k: key }]), "the key is still in SecretStorage");
	const second = d.engine?.config?.crypto;
	assert.equal(second?.suite, 1);
	assert.equal(second?.suite === 1 ? second.keys.length : -1, 1, "and reaches the restarted engine");
	assert.equal(d.engineStarts, 2);
});
