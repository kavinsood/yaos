import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM, type DeviceId, type StreamName } from "../../core/types";
import type { BlobPort, EnginePorts } from "../../ports";
import { SeededRandom } from "../../sim/random";
import { connectPeer, frame, pump } from "../../sim/a-relay-testkit";
import { VirtualClock } from "../../sim/clock";
import { SimDevice } from "../../sim/device";
import { SIM_VAULT_ID, SimNet } from "../../sim/net";
import type { E2eeStatus, StatusSnapshot } from "../../protocol/status";
import { sameKeys, VaultKeyStore } from "../../host/keys/secretStore";
import { fakeEpochKey, fakeGenesisRecord } from "../../host/keys/testkit/kRecords";
import { PinGate, WriteRefused } from "./pinGate";

// --- the gate itself -----------------------------------------------------------------------------------------

test("PinGate: open only for suite 0; writerPorts throws while closed; suite-1 init keys are zero-filled", () => {
	const ports = { relay: null, clock: null, random: null } as unknown as EnginePorts;
	const unpinned = new PinGate({ suite: null, creating: true });
	assert.equal(unpinned.open, false);
	assert.equal(unpinned.creating, true);
	assert.throws(() => unpinned.writerPorts(ports), WriteRefused);
	const plain = new PinGate({ suite: 0 });
	assert.equal(plain.open, true);
	assert.equal(plain.creating, false);
	assert.equal(plain.writerPorts(ports), ports);
	const k = fakeEpochKey(1);
	const encrypted = new PinGate({ suite: 1, keys: [{ e: 1, k }], records: [] });
	assert.equal(encrypted.open, false, "closed until WP-E3's keyring runtime can seal");
	assert.throws(() => encrypted.writerPorts(ports), WriteRefused);
	assert.ok(k.every((b) => b === 0), "the unused init key is zero-filled at once");
});

test("PinGate.readerPorts: the session reads but cannot append or put a checkpoint", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const writer = await connectPeer(net.relay, clock, "dev-W");
	writer.session.append(frame("ns", "w-1", "entry"));
	await clock.advance(1_000);
	const gate = new PinGate({ suite: null, creating: false });
	const reader = gate.readerPorts({ relay: net.port("dev-R" as DeviceId), clock, random: new SeededRandom(1) } as unknown as EnginePorts);
	const r = await pump(clock, reader.relay.connect({ vaultId: SIM_VAULT_ID, deviceId: "dev-R" as DeviceId }));
	assert.ok(r.ok);
	const s = r.session;
	assert.equal(s.canWrite, false);
	assert.throws(() => s.append(frame("ns", "r-1", "x")), WriteRefused);
	await assert.rejects(s.putCheckpoint("ns" as StreamName, 1, 0, new Uint8Array(3)), WriteRefused);
	const page = await pump(clock, s.read("ns" as StreamName, 0, false));
	assert.equal(page.rows.length, 1, "reads pass through");
	await clock.advance(1_000);
	assert.equal(net.relay.counters().appendFrames, 1, "only the writer's frame");
	assert.equal(net.relay.checkpoint("ns" as StreamName), null);
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
	other.pinData = { creating: { vaultId: "another-vault" } };
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

test("unpinned engine refuses the WP-E3 key commands with `refused`, and no key bytes stay with the sender", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const u = new SimDevice({ name: "U", clock, net, pin: null });
	void u.start();
	await clock.advance(5_000);
	const rk = fakeEpochKey(21);
	const k = fakeEpochKey(22);
	for (const command of [
		{ t: "installKey", source: "rk", rk } as const,
		{ t: "installKey", source: "qr", e: 1, k } as const,
		{ t: "pinSuite0", source: "link" } as const,
		{ t: "enableE2ee", rk: fakeEpochKey(23) } as const,
		{ t: "revokeRekey", rk: fakeEpochKey(24) } as const,
	]) {
		await assert.rejects(pump(clock, u.runtime.command(command)), (e: unknown) => (e as { error?: { code?: string } }).error?.code === "refused" || /refused/.test(String(e)), command.t);
	}
	assert.ok(rk.byteLength === 0 || rk.every((b) => b === 0));
	assert.ok(k.byteLength === 0 || k.every((b) => b === 0));
	assert.equal(lastStatus(u).phase, "key-missing");
	assert.equal(net.relay.counters().appendFrames, 0);
});

// --- keys live in SecretStorage, not IndexedDB -----------------------------------------------------------------

test("IndexedDB wipe keeps the keys: SecretStorage is outside the engine store", async () => {
	const clock = new VirtualClock();
	const net = new SimNet(clock);
	const d = new SimDevice({ name: "E", clock, net, pin: { suite: 1 } });
	const key = fakeEpochKey(31);
	new VaultKeyStore(d.secrets, SIM_VAULT_ID, clock).merge({ keys: [{ e: 1, k: key.slice() }], records: [fakeGenesisRecord()] });
	void d.start();
	await clock.advance(5_000);
	const first = d.engine?.config?.crypto;
	assert.equal(first?.suite, 1);
	assert.equal(first?.suite === 1 ? first.keys.length : -1, 1, "the engine got the stored key");
	assert.equal(e2eeOf(d)?.keyMissing, "no-key", "suite 1 stays blocked until WP-E3");
	d.crashApp({ wipe: true });
	await clock.advance(1_000);
	assert.deepEqual(await d.storage.listDatabases(), [], "IndexedDB is gone");
	const restart = d.restartApp();
	await clock.advance(10_000);
	await restart;
	const held = new VaultKeyStore(d.secrets, SIM_VAULT_ID, clock).load();
	assert.ok(held && sameKeys(held.keys, [{ e: 1, k: key }]), "the key is still in SecretStorage");
	const second = d.engine?.config?.crypto;
	assert.equal(second?.suite, 1);
	assert.equal(second?.suite === 1 ? second.keys.length : -1, 1, "and reaches the restarted engine");
	assert.equal(d.engineStarts, 2);
});
