import { test } from "node:test";
import assert from "node:assert/strict";
import { KEYRING_STREAM } from "../core/types";
import { connectPeer, frame } from "../sim/a-relay-testkit";
import { VirtualClock } from "../sim/clock";
import { SimNet } from "../sim/net";
import { SimDevice } from "../sim/device";
import type { HostUiSink } from "./hostRuntime";
import { secretIdFor, VaultKeyStore } from "./keys/secretStore";
import { fakeEpochKey, fakeGenesisRecord } from "./keys/testkit/kRecords";
import { withSuite0PinForTest } from "./keys/testkit/pinFixture";
import { BAD_VAULT_IDS, testVaultId } from "./keys/testkit/vaultIds";
import { advanceUntil, settleWith } from "../engine/keyring/testkit/simWait";
import { hostNotice, PinRefusedError, YaosController } from "./pluginController";
import { defaultPluginData, type PairedIdentity, type StoredPluginData, type YaosPluginData } from "./ui/api";
import type { StoreDirActivity } from "./cloneNotice";
import { LOCAL_SETTINGS_KEY, sanitizeLocalSettings, type LocalSettings } from "./localSettings";
import { prepareEnrollment } from "./ui/pairing";

const ID: PairedIdentity = { host: "https://relay.example", vaultId: testVaultId("v1"), grantId: "grant_AAAAAAAAAAAAAAAA", grantSecret: "gs_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS", grantName: "A", vaultGeneration: null };

interface SetupOptions {
	readonly secretsAvailable?: boolean;
	/** The state dirs the clone check finds (absent: no scan wired). */
	readonly stateDirs?: () => Promise<readonly StoreDirActivity[]>;
	readonly local?: Map<string, unknown>;
}

function setup(initial: YaosPluginData = defaultPluginData("A"), o: SetupOptions = {}) {
	const clock = new VirtualClock();
	const net = new SimNet(clock, { linkMs: 10 });
	const dev = new SimDevice({ name: "A", clock, net });
	dev.secrets.available = o.secretsAvailable ?? true;
	const saved: StoredPluginData[] = [];
	const notices: string[] = [];
	const logs: string[] = [];
	const sinks: HostUiSink[] = [];
	const local = o.local ?? new Map<string, unknown>();
	const stateDirs = o.stateDirs;
	const ctl = new YaosController(initial, {
		makeRuntime: (identity, settings, ui, keys) => {
			sinks.push(ui);
			return dev.runtimeFor(identity, settings, ui, keys);
		},
		saveData: async (d) => {
			saved.push(d);
		},
		notice: (level, m, timeoutMs) => notices.push(`${level}:${m}${timeoutMs ? `@${timeoutMs}` : ""}`),
		log: (l) => logs.push(l),
		clock,
		secrets: dev.secrets,
		localStorage: { load: (k) => local.get(k) ?? null, save: (k, v) => void local.set(k, structuredClone(v)) },
		...(stateDirs ? { stateDirs: { pluginDir: ".config/plugins/yaos", storeDirs: stateDirs } } : {}),
	});
	let changes = 0;
	ctl.onChange(() => changes++);
	/** The local settings record (identity-per-store §8) as stored. */
	const localRec = (): LocalSettings => sanitizeLocalSettings(local.get(LOCAL_SETTINGS_KEY), "?");
	return { clock, net, dev, ctl, saved, notices, logs, sinks, local, localRec, changes: () => changes };
}

const PAIRED: YaosPluginData = { ...defaultPluginData("A"), identity: ID };

async function started(initial: YaosPluginData, o: SetupOptions = {}) {
	const w = setup(initial, o);
	const s = w.ctl.start();
	await w.clock.advance(1_000);
	await s;
	return w;
}

/** The sender holds no key bytes: transferred (detached) or zero-filled. */
function noBytes(b: Uint8Array): boolean {
	return b.byteLength === 0 || b.every((x) => x === 0);
}

/**
 * Settles a promise driven by the virtual clock and the engine's real WebCrypto (unpinned and suite-1 engines get
 * the suite-1 adapter): advances in steps with a real wait between them until it settles.
 */
async function settle<T>(clock: VirtualClock, p: Promise<T>, horizonMs = 30_000): Promise<T> {
	return settleWith(clock, p, Math.max(horizonMs, 30_000));
}

test("unpaired: no runtime, commands refuse with a safe message", async () => {
	const { ctl } = setup();
	await ctl.start();
	assert.equal(ctl.runState().phase, "unpaired");
	assert.equal(ctl.activeRuntime, null);
	await assert.rejects(ctl.command({ t: "pause" }), /not running/);
});

test("pairing starts the engine; status, commands, settings and unpairing flow through", async () => {
	const { clock, dev, ctl, saved, changes, logs } = setup();
	dev.vault.userWrite("a.md", "hello");
	await ctl.start();
	const pair = ctl.updateData((d) => ({ ...d, identity: ID }));
	await clock.advance(1_000);
	await pair;
	assert.equal(saved.length, 1);
	assert.equal(saved[0]?.e2ee, undefined, "pairing sets no pin");
	assert.equal(ctl.runState().phase, "running");
	assert.equal(ctl.status()?.transport, "worker");
	assert.ok(ctl.status(), "status snapshot received");
	assert.equal(ctl.status()?.phase, "key-missing", "a key-less join is blocked");
	assert.equal(ctl.status()?.e2ee?.keyMissing, "no-pin");
	assert.ok(changes() >= 3);
	const ok = ctl.command({ t: "pause" });
	await clock.advance(10);
	assert.deepEqual(await ok, { t: "ok" });
	const engineBefore = dev.engine;
	const upd = ctl.updateData((d) => ({ ...d, engine: { ...d.engine, excludePatterns: ["private/**"] } }));
	await clock.advance(10);
	await upd;
	assert.equal(ctl.runState().phase, "running", "settings change does not restart");
	assert.equal(dev.engineStarts, 1);
	assert.equal(dev.engine, engineBefore, "same engine instance");
	const relabel = ctl.updateData((d) => ({ ...d, deviceLabel: "Laptop" }));
	await clock.advance(5_000);
	await relabel;
	assert.equal(dev.engineStarts, 2, "label change restarts with the new label");
	assert.equal(dev.engine?.config?.deviceLabel, "Laptop");
	const unpair = ctl.updateData((d) => ({ ...d, identity: null }));
	await clock.advance(5_000);
	await unpair;
	assert.equal(ctl.runState().phase, "unpaired");
	assert.equal(ctl.activeRuntime, null);
	assert.equal(logs.join("\n").includes("secret-token"), false, "credential never logged");
});

test("identical data is a no-op; restartEngine replaces the runtime", async () => {
	const { clock, dev, ctl, saved } = setup({ ...defaultPluginData("A"), identity: ID });
	const s = ctl.start();
	await clock.advance(1_000);
	await s;
	await ctl.updateData((d) => d);
	assert.equal(saved.length, 0);
	const first = ctl.activeRuntime;
	const r = ctl.restartEngine();
	await clock.advance(5_000);
	await r;
	assert.notEqual(ctl.activeRuntime, first);
	assert.equal(ctl.runState().phase, "running");
	assert.equal(dev.engineStarts, 2);
	const st = ctl.stop();
	await clock.advance(5_000);
	await st;
	assert.equal(ctl.runState().phase, "stopped");
});

test("hostNotice: settings-reload is surfaced with friendly text; other info stays in the status", () => {
	assert.deepEqual(hostNotice("info", "settings-reload", "app.json, hotkeys.json"), {
		text: "YAOS: synced settings changed (app.json, hotkeys.json). Reload Obsidian to apply them.",
		timeoutMs: 15_000,
	});
	assert.equal(hostNotice("info", "recovered-from-mirror", "recovered-from-mirror"), null);
	assert.deepEqual(hostNotice("warn", "daily-limit", "limit"), { text: "limit", timeoutMs: 20_000 });
	assert.deepEqual(hostNotice("error", "x", "boom"), { text: "boom" });
});

test("engine notices reach the env through hostNotice; a replaced runtime's notices are dropped", async () => {
	const { clock, ctl, notices, sinks } = setup({ ...defaultPluginData("A"), identity: ID });
	const s = ctl.start();
	await clock.advance(1_000);
	await s;
	const ui = sinks[0];
	assert.ok(ui);
	ui.onNotice("info", "settings-reload", "app.json");
	ui.onNotice("info", "something", "quiet");
	ui.onNotice("warn", "daily-limit", "limit reached");
	assert.deepEqual(notices, ["info:YAOS: synced settings changed (app.json). Reload Obsidian to apply them.@15000", "warn:limit reached@20000"]);
	const r = ctl.restartEngine();
	await clock.advance(5_000);
	await r;
	ui.onNotice("info", "settings-reload", "app.json");
	assert.equal(notices.length, 2, "stale runtime is ignored");
});

// --- the suite pin (e2ee-design §12.4, WP-E4) ---------------------------------------------------------------

test("a stored pairing without e2ee is unpinned and blocked: key-missing, zero frames, no pin saved", async () => {
	const w = setup(PAIRED);
	w.dev.vault.userWrite("a.md", "hello");
	const s = w.ctl.start();
	await w.clock.advance(5_000);
	await s;
	assert.equal(w.ctl.runState().phase, "running");
	assert.equal(w.ctl.status()?.phase, "key-missing");
	assert.deepEqual(w.ctl.status()?.e2ee, { suite: null, sealEpoch: 0, keyMissing: "no-pin", keyringSeen: false, creatable: false });
	assert.equal(w.dev.engine?.config?.crypto.suite, null);
	assert.equal(w.net.relay.counters().appendFrames, 0, "no frame on any stream");
	assert.equal(w.net.relay.head(), 0);
	// Only the pending store identity (identity-per-store §4): the key reader registered one device, and no store exists.
	const dbs = await w.dev.storage.listDatabases();
	assert.deepEqual(dbs.map((n) => n.split(":")[0]), ["yaos3-pending"], "no IndexedDB store opened");
	assert.equal(w.saved.length, 0, "nothing inferred, nothing saved");
	assert.equal(w.ctl.data().e2ee, undefined);
});

test("suite-0 fixture: the device syncs; the pin survives updates and the UI cannot write it", async () => {
	const w = setup(withSuite0PinForTest(PAIRED));
	w.dev.vault.userWrite("a.md", "hello");
	const s = w.ctl.start();
	await w.clock.advance(5_000);
	await s;
	assert.equal(w.dev.engine?.config?.crypto.suite, 0);
	assert.ok(w.net.relay.counters().appendFrames > 0, "a suite-0 device writes");
	assert.notEqual(w.ctl.status()?.phase, "key-missing");
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, engine: { ...d.engine, excludePatterns: ["x/**"] }, e2ee: { suite: 1 } })), 100);
	assert.deepEqual(w.saved.at(-1)?.e2ee, { suite: 0 }, "the UI cannot change the pin");
	// Unpinned: a UI-written pin is dropped.
	const u = await started(PAIRED);
	await settle(u.clock, u.ctl.updateData((d) => ({ ...d, deviceLabel: "B", e2ee: { suite: 0 } })), 5_000);
	assert.equal(u.saved.at(-1)?.e2ee, undefined);
	assert.equal(u.dev.engine?.config?.crypto.suite, null);
});

test("keyringSeen: a k record makes it sticky; pinSuite0 link is then refused", async () => {
	const w = await started(PAIRED);
	const z = await connectPeer(w.net.relay, w.clock, "dev-Z");
	z.session.append(frame(KEYRING_STREAM, "z-genesis", fakeGenesisRecord()));
	await w.clock.advance(5_000);
	assert.equal(w.ctl.status()?.e2ee?.keyMissing, "encrypted-vault");
	assert.deepEqual(w.ctl.data().e2ee, { suite: null, keyringSeen: true });
	assert.deepEqual(w.saved.at(-1)?.e2ee, { suite: null, keyringSeen: true }, "saved");
	await assert.rejects(w.ctl.command({ t: "pinSuite0", source: "link" }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "keyring-seen");
	// Sticky across restarts and data updates.
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, deviceLabel: "Laptop" })), 5_000);
	assert.deepEqual(w.saved.at(-1)?.e2ee, { suite: null, keyringSeen: true });
	assert.equal(w.dev.engine?.config?.crypto.suite, null);
	assert.equal(w.net.relay.rows(KEYRING_STREAM).length, 1, "the blocked device appended nothing to k");
});

test("a key-less join: create and enableE2ee need the creation marker; a QR key waits for its record; pinSuite0 {link} on an empty k pins suite 0", async () => {
	const w = await started(PAIRED);
	await assert.rejects(w.ctl.command({ t: "pinSuite0", source: "create" }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "not-creating");
	const rk = fakeEpochKey(3);
	await assert.rejects(w.ctl.command({ t: "enableE2ee", rk }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "not-creating");
	assert.ok(noBytes(rk), "a refused command's recovery key is zero-filled on main");
	await assert.rejects(w.ctl.command({ t: "revokeRekey", rk: fakeEpochKey(5) }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "not-encrypted");
	const k = fakeEpochKey(4);
	assert.deepEqual(await settle(w.clock, w.ctl.command({ t: "installKey", source: "qr", e: 1, k }), 100), { t: "ok" }, "pending: k shows no record for it");
	assert.ok(noBytes(k), "main keeps no key bytes (transferred)");
	assert.equal(w.dev.secrets.writes, 0, "an unverified key is not stored");
	assert.equal(w.saved.length, 0, "and pins nothing");
	assert.equal(w.dev.engineStarts, 1);
	// §12.4 (ii): k read to head on this session and empty, keyringSeen unset: the engine says ok, main pins and restarts.
	assert.deepEqual(await settle(w.clock, w.ctl.command({ t: "pinSuite0", source: "link" }), 100), { t: "ok" });
	assert.deepEqual(w.ctl.data().e2ee, { suite: 0 });
	assert.deepEqual(w.saved.at(-1)?.e2ee, { suite: 0 }, "saved");
	assert.ok(await advanceUntil(w.clock, () => w.dev.engineStarts === 2 && w.ctl.status()?.phase === "live", 30_000), "restarted pinned, live");
	assert.equal(w.dev.engine?.config?.crypto.suite, 0);
	await assert.rejects(w.ctl.command({ t: "pinSuite0", source: "link" }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "already-pinned");
	assert.equal(w.net.relay.rows(KEYRING_STREAM).length, 0);
});

test("a suite-0 device takes no key: installKey refused on main, keyringChanged refused unstored", async () => {
	const w = await started(withSuite0PinForTest(PAIRED));
	const k = fakeEpochKey(6);
	await assert.rejects(w.ctl.command({ t: "installKey", source: "qr", e: 1, k }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "suite-0-pinned");
	assert.ok(noBytes(k));
	const change = w.dev.engine!.link.keyringChanged({ keys: [{ e: 1, k: fakeEpochKey(7) }], records: [fakeGenesisRecord()], pending: null });
	await assert.rejects(settle(w.clock, change, 100), /unencrypted vault/);
	assert.equal(w.dev.secrets.writes, 0, "nothing stored");
	assert.deepEqual(w.ctl.data().e2ee, { suite: 0 });
});

test("keyringChanged: stored in SecretStorage and pinned suite 1 before the ack, then the engine restarts pinned", async () => {
	const w = await started(PAIRED);
	const id = secretIdFor(ID.vaultId);
	let atAck: { stored: boolean; pin: unknown; savedPin: unknown } | null = null;
	const key = fakeEpochKey(9);
	const sent = key.slice();
	const change = w.dev.engine!.link.keyringChanged({ keys: [{ e: 1, k: key }], records: [fakeGenesisRecord()], pending: null }).then(() => {
		atAck = { stored: (w.dev.secretBacking.get(id) ?? "") !== "", pin: w.ctl.data().e2ee, savedPin: w.saved.at(-1)?.e2ee };
	});
	await settle(w.clock, change, 100);
	assert.deepEqual(atAck, { stored: true, pin: { suite: 1 }, savedPin: { suite: 1 } }, "persist before use: stored and pinned when the engine hears back");
	const held = new VaultKeyStore(w.dev.secrets, ID.vaultId, w.clock).load();
	assert.equal(held?.keys.length, 1);
	assert.deepEqual(held?.keys[0]?.k, sent, "the stored key is the sent key");
	assert.ok(await advanceUntil(w.clock, () => w.dev.engineStarts === 2 && w.ctl.status()?.e2ee?.suite === 1, 30_000), "restarted with the pinned config");
	const crypto = w.dev.engine?.config?.crypto;
	assert.equal(crypto?.suite, 1);
	assert.equal(crypto?.suite === 1 ? crypto.keys.length : -1, 1);
	assert.equal(crypto?.suite === 1 ? crypto.records.length : -1, 1);
	// The stand-in key does not match the stand-in record's kcv: the gate stays shut (pinGate.ts).
	assert.equal(w.ctl.status()?.e2ee?.keyMissing, "no-key", "a key that fails its record is not used");
	assert.equal(w.ctl.status()?.phase, "key-missing");
	assert.equal(w.net.relay.counters().appendFrames, 0);
	// §6.1 Forget keys: leaving the vault blanks the secret and drops the pin.
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, identity: null })), 5_000);
	assert.equal(w.dev.secretBacking.get(id), "");
	assert.equal(w.saved.at(-1)?.e2ee, undefined);
	assert.equal(w.ctl.runState().phase, "unpaired");
});

test("keyringChanged with a pending record, or a store that cannot write, pins nothing", async () => {
	const w = await started(PAIRED);
	const pending = w.dev.engine!.link.keyringChanged({ keys: [{ e: 1, k: fakeEpochKey(11) }], records: [fakeGenesisRecord()], pending: 1 });
	await settle(w.clock, pending, 100);
	assert.equal(w.ctl.data().e2ee, undefined, "a proposed record is not settled: no pin yet");
	assert.notEqual(w.dev.secretBacking.get(secretIdFor(ID.vaultId)) ?? "", "", "but the key is stored first");
	const n = await started(PAIRED, { secretsAvailable: false });
	const key = fakeEpochKey(12);
	const failed = n.dev.engine!.link.keyringChanged({ keys: [{ e: 1, k: key }], records: [fakeGenesisRecord()], pending: null });
	await assert.rejects(settle(n.clock, failed, 100), /secure key storage is not available/);
	assert.ok(noBytes(key), "key bytes zero-filled on main even when not stored");
	assert.equal(n.ctl.data().e2ee, undefined);
	assert.equal(n.saved.length, 0);
});

test("creation marker (§15.1): written before enroll, kept across it; creatable reaches the status; main lets create through", async () => {
	const w = setup();
	await w.ctl.start();
	for (const bad of BAD_VAULT_IDS) await assert.rejects(w.ctl.markCreating(bad), TypeError, JSON.stringify(bad));
	assert.equal(w.saved.length, 0, "a non-vaultId never reaches data.json");
	assert.equal(w.localRec().creating, undefined, "nor the local record");
	await w.ctl.markCreating(ID.vaultId);
	assert.deepEqual(w.localRec().creating, { vaultId: ID.vaultId }, "per install: the local record (identity-per-store §8)");
	assert.equal(w.saved.length, 0, "data.json is not written for the marker");
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, identity: ID })), 5_000);
	assert.deepEqual(w.localRec().creating, { vaultId: ID.vaultId }, "the enroll keeps the marker");
	assert.ok(w.saved.length > 0 && w.saved.every((d) => !("creating" in d)), "never in data.json");
	assert.equal(w.dev.engine?.config?.crypto.suite, null);
	assert.equal(w.ctl.status()?.e2ee?.creatable, true, "empty relay, empty k");
	// Main lets the creation choices through; the engine's KeyReader decides (keyReader.ts). enableE2ee: the genesis.
	const rk = fakeEpochKey(13);
	assert.deepEqual(await settle(w.clock, w.ctl.command({ t: "enableE2ee", rk }), 100), { t: "ok" });
	assert.ok(noBytes(rk), "the recovery key left main");
	assert.deepEqual(w.ctl.data().e2ee, { suite: 1 }, "pinned after ok");
	assert.equal(w.ctl.data().creating, undefined, "the marker goes with the pin");
	assert.equal(w.localRec().creating, undefined, "and from the local record");
	assert.equal(w.net.relay.rows(KEYRING_STREAM).length, 1, "the genesis");
	assert.equal(w.net.relay.head(), 1, "and nothing else");
	assert.equal(new VaultKeyStore(w.dev.secrets, ID.vaultId, w.clock).load()?.keys.length, 1, "K_1 stored before the pin");
	assert.ok(await advanceUntil(w.clock, () => w.dev.engineStarts === 2 && w.ctl.status()?.phase === "live", 30_000), "restarted pinned suite 1: live");
	assert.equal(w.ctl.status()?.e2ee?.sealEpoch, 1);
	// pinSuite0 {create}: the other choice, on a second device that just created another vault.
	const c = setup();
	await c.ctl.start();
	await c.ctl.markCreating(ID.vaultId);
	await settle(c.clock, c.ctl.updateData((d) => ({ ...d, identity: ID })), 5_000);
	assert.ok(await advanceUntil(c.clock, () => c.ctl.status()?.e2ee?.creatable === true, 30_000));
	assert.deepEqual(await settle(c.clock, c.ctl.command({ t: "pinSuite0", source: "create" }), 100), { t: "ok" });
	assert.deepEqual(c.ctl.data().e2ee, { suite: 0 });
	assert.equal(c.net.relay.rows(KEYRING_STREAM).length, 0);
	// Enrolling in another vault drops the marker.
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, identity: { ...ID, vaultId: testVaultId("v2") } })), 5_000);
	assert.equal(w.ctl.data().creating, undefined);
	assert.equal(w.localRec().creating, undefined);
});

test("abandonCreating (§15.1 abort): the marker goes, no pin, the engine restarts off the creation path", async () => {
	const w = setup();
	await w.ctl.start();
	await w.ctl.markCreating(ID.vaultId);
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, identity: ID })), 5_000);
	assert.ok(await advanceUntil(w.clock, () => w.ctl.status()?.e2ee?.creatable === true, 30_000));
	const starts = w.dev.engineStarts;
	await w.ctl.abandonCreating(testVaultId("other"));
	assert.deepEqual(w.ctl.data().creating, { vaultId: ID.vaultId }, "another vault's abort leaves this marker");
	await w.ctl.abandonCreating(ID.vaultId);
	assert.equal(w.ctl.data().creating, undefined);
	assert.equal(w.localRec().creating, undefined, "saved");
	assert.equal(w.ctl.data().e2ee, undefined, "no pin: unpinned and blocked");
	assert.ok(await advanceUntil(w.clock, () => w.dev.engineStarts === starts + 1 && w.ctl.runState().phase === "running" && w.ctl.status() !== null, 30_000), "restarted");
	assert.equal(w.ctl.status()?.e2ee?.creatable, false);
	assert.equal(w.ctl.status()?.e2ee?.keyMissing, "no-pin");
	await assert.rejects(w.ctl.command({ t: "enableE2ee", rk: fakeEpochKey(21) }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "not-creating");
	await assert.rejects(w.ctl.command({ t: "pinSuite0", source: "create" }), (e: unknown) => e instanceof PinRefusedError && e.refusal === "not-creating");
	assert.equal(w.net.relay.rows(KEYRING_STREAM).length, 0);
});

test("rkChecksum: the engine hashes (main never does); the caller's secret is untouched; needs an engine", async () => {
	const { createHash } = await import("node:crypto");
	const idle = setup();
	await assert.rejects(idle.ctl.rkChecksum(new Uint8Array(32)), /not running/);
	const w = await started(PAIRED);
	const secret = new Uint8Array(32).map((_, i) => i * 7 + 1);
	const before = secret.slice();
	const sum = await settle(w.clock, w.ctl.rkChecksum(secret), 100);
	assert.deepEqual([...sum], [...createHash("sha256").update(before).digest().subarray(0, 3)]);
	assert.deepEqual(secret, before, "a copy was transferred");
	await assert.rejects(w.ctl.rkChecksum(new Uint8Array(31)), /not running/);
});

test("vaultKeyForQr: the stored key of the seal epoch, as a copy; null unless suite 1 with a usable key", async () => {
	const unpinned = await started(PAIRED);
	assert.equal(unpinned.ctl.vaultKeyForQr(), null, "unpinned");
	const s0 = await started(withSuite0PinForTest(PAIRED));
	assert.equal(s0.ctl.vaultKeyForQr(), null, "suite 0");
	const w = setup();
	await w.ctl.start();
	await w.ctl.markCreating(ID.vaultId);
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, identity: ID })), 5_000);
	assert.ok(await advanceUntil(w.clock, () => w.ctl.status()?.e2ee?.creatable === true, 30_000));
	assert.equal(w.ctl.vaultKeyForQr(), null, "creatable, not pinned yet");
	await settle(w.clock, w.ctl.command({ t: "enableE2ee", rk: fakeEpochKey(22) }), 100);
	assert.ok(await advanceUntil(w.clock, () => w.ctl.status()?.phase === "live", 30_000));
	const key = w.ctl.vaultKeyForQr();
	assert.ok(key, "suite 1, key usable");
	assert.equal(key.e, 1);
	const stored = new VaultKeyStore(w.dev.secrets, ID.vaultId, w.clock).load();
	assert.deepEqual(key.k, stored?.keys[0]?.k);
	key.k.fill(0);
	assert.ok(!noBytes(w.ctl.vaultKeyForQr()!.k), "zero-filling the copy leaves the store alone");
});

// --- per-install fields and the clone notice (identity-per-store §8) -------------------------------------------

test("per-install fields go to the local settings record, never to data.json", async () => {
	const w = await started(withSuite0PinForTest(PAIRED));
	const before = w.saved.length;
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, deviceLabel: "Laptop", showStatusBar: false })), 5_000);
	assert.equal(w.saved.length, before, "a label or a status bar toggle does not write data.json");
	assert.equal(w.localRec().deviceLabel, "Laptop");
	assert.equal(w.localRec().showStatusBar, false);
	assert.equal(w.dev.engine?.config?.deviceLabel, "Laptop", "the label still restarts the engine with it");
	const attempt = prepareEnrollment({ host: ID.host, pairingCode: "pc_ABCDEFGHIJKLMNOPQRSTUVWX", deviceName: "Laptop" });
	await w.ctl.updateData((d) => ({ ...d, pendingEnrollment: attempt }));
	assert.deepEqual(w.localRec().pendingEnrollment, attempt, "SECRET: in vault-local storage, not in the vault folder");
	assert.equal(w.saved.length, before, "a pending enrollment never writes data.json");
	await w.ctl.updateData((d) => { const { pendingEnrollment: _p, ...rest } = d; return rest; });
	assert.equal(w.localRec().pendingEnrollment, undefined, "dropped from the record");
	await settle(w.clock, w.ctl.updateData((d) => ({ ...d, engine: { ...d.engine, excludePatterns: ["x/**"] } })), 100);
	assert.equal(w.saved.length, before + 1, "a shared field does");
	assert.deepEqual(Object.keys(w.saved.at(-1) ?? {}).sort(), ["e2ee", "engine", "identity", "version"]);
	assert.equal(w.localRec().deviceLabel, "Laptop", "the record is kept across a data.json save");
	// The load-time rewrite of an older data.json (plugin.ts) writes the shared fields only.
	await w.ctl.rewriteStoredData();
	assert.deepEqual(Object.keys(w.saved.at(-1) ?? {}).sort(), ["e2ee", "engine", "identity", "version"]);
});

const STORE_B = "dev-B000000000000000";
const recent = (clock: VirtualClock, ageMs: number): StoreDirActivity => ({ deviceId: STORE_B, newestMirrorMs: clock.now() - ageMs });

test("clone notice (§8): a fresh install that finds another store's recent mirrors says so once", async () => {
	let scans = 0;
	const local = new Map<string, unknown>();
	const w = setup(withSuite0PinForTest(PAIRED), { local, stateDirs: async () => (scans++, [recent(w.clock, 60_000)]) });
	void w.ctl.start();
	assert.ok(await advanceUntil(w.clock, () => w.ctl.deviceId() !== null, 30_000), "the store identity arrived");
	await w.clock.advance(100);
	const shown = w.notices.filter((n) => n.includes("synced by another tool"));
	assert.equal(shown.length, 1);
	assert.equal(shown[0], "warn:YAOS: this vault folder looks synced by another tool as well. YAOS works, but two sync tools on one folder produce conflicting copies; exclude `.config/plugins/yaos/` from the other tool.@20000");
	assert.equal(w.localRec().cloneNoticeShown, true, "the flag is per install");
	// A restart has lineage: no scan.
	await settle(w.clock, w.ctl.restartEngine(), 5_000);
	assert.equal(scans, 1, "only the fresh install's first store looks");
	// A re-pair to another vault is a fresh install record again, but the flag holds.
	const again = setup(withSuite0PinForTest(PAIRED), { local: new Map([[LOCAL_SETTINGS_KEY, local.get(LOCAL_SETTINGS_KEY)]]), stateDirs: async () => (scans++, [recent(again.clock, 0)]) });
	void again.ctl.start();
	assert.ok(await advanceUntil(again.clock, () => again.ctl.deviceId() !== null, 30_000));
	await again.clock.advance(100);
	assert.equal(again.notices.filter((n) => n.includes("synced by another tool")).length, 0, "once per install");
});

test("clone notice (§8): nothing for old or own dirs, an install with lineage, or a failing scan", async () => {
	const cases: [string, (c: VirtualClock, own: () => string | null) => Promise<readonly StoreDirActivity[]>][] = [
		["older than a day", async (c) => [recent(c, 25 * 3_600_000)]],
		["no mirror", async () => [{ deviceId: STORE_B, newestMirrorMs: null }]],
		["own dir only", async (c, own) => [{ deviceId: own() ?? "", newestMirrorMs: c.now() }]],
		["scan fails", async () => { throw new Error("EACCES"); }],
	];
	for (const [name, scan] of cases) {
		const w = setup(withSuite0PinForTest(PAIRED), { stateDirs: () => scan(w.clock, () => w.ctl.deviceId()) });
		void w.ctl.start();
		assert.ok(await advanceUntil(w.clock, () => w.ctl.deviceId() !== null, 30_000), name);
		await w.clock.advance(100);
		assert.equal(w.notices.filter((n) => n.includes("synced by another tool")).length, 0, name);
		assert.equal(w.localRec().cloneNoticeShown, undefined, name);
	}
});
