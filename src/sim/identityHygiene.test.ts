/**
 * identity-per-store phase 5 (hygiene) on the composed sim client:
 *  - inactivity retirement resolves an abandoned create with no console action: a store lost with its lineage (no
 *    fence) leaves its registration live; its body-less create waits until the server's lazy sweep retires it, then
 *    every device drops the empty doc and the holder re-creates the file;
 *  - grant rotation: the old secret stops registering; a device with a live store fetches the new one (GET
 *    /auth/grant) when a registration says unauthorized, and main writes it to data.json; a clone without a live
 *    store has nothing to fetch with and asks for a re-pair;
 *  - the orphan sweep: at live, the store DBs of this vault under another install key (a clone's leftover) are
 *    deleted once the server reads them retired; a live one is kept; no side-file dir is touched;
 *  - rebuildLocalCache is a store reset: a new identity under the grant, the old store fenced and inherited from,
 *    nothing unsent lost; offline it fails and keeps the store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId } from "../core/types";
import { parseDbName } from "../engine/compose/knownEpoch";
import { sanitizeInstallRecord } from "../host/installRecord";
import type { EngineResultValue, UserCommand } from "../protocol/messages";
import { VirtualClock } from "./clock";
import { SimDevice } from "./device";
import { SimNet } from "./net";

function world(names: readonly string[], log?: (name: string, line: string) => void): { clock: VirtualClock; net: SimNet; devs: SimDevice[] } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	return { clock, net, devs: names.map((name) => new SimDevice({ name, clock, net, log: log ? (l) => log(name, l) : undefined })) };
}

function files(d: SimDevice): string {
	return [...d.vault.snapshot()].filter(([p]) => p.endsWith(".md")).map(([p, t]) => `${p}=${t}`).sort().join("\n");
}

function stateDirs(d: SimDevice): Set<string> {
	return new Set([...d.sideFiles.files.keys()].map((k) => k.slice(0, k.indexOf("/"))));
}

async function storeDbs(d: SimDevice): Promise<string[]> {
	return (await d.storage.listDatabases()).filter((n) => parseDbName(n)?.vaultEpoch).sort();
}

/** A user command, with virtual time running while it settles. */
async function command(clock: VirtualClock, d: SimDevice, c: UserCommand, ms = 10_000): Promise<EngineResultValue> {
	const r = d.runtime.command(c);
	r.catch(() => undefined);
	await clock.advance(ms);
	return r;
}

function record(d: SimDevice) {
	const r = sanitizeInstallRecord(d.installRecord());
	assert.ok(r, `${d.name} has an install record`);
	return r;
}

test("rebuildLocalCache: a new store under the grant; the old one is fenced and inherited from, nothing unsent lost", async () => {
	const { clock, net, devs } = world(["A", "B"]);
	const [a, b] = devs as [SimDevice, SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	const first = a.deviceId;
	// An edit and a create the relay has not committed yet: the reset must carry them.
	net.relay.pauseCommits();
	a.vault.userWrite("note.md", "hello\nunsent\n");
	a.vault.userWrite("new.md", "made just now\n");
	await clock.advance(3_000);
	assert.deepEqual(await command(clock, a, { t: "rebuildLocalCache" }, 5_000), { t: "ok" });
	net.relay.resumeCommits();
	await clock.advance(60_000);
	assert.notEqual(a.deviceId, first, "a new store identity");
	assert.deepEqual(a.identities, [first, a.deviceId]);
	assert.equal(net.identities.state(first), "retired", "the new store fenced the old one");
	assert.equal(net.identities.state(a.deviceId), "live");
	assert.deepEqual(record(a).predecessors, [first]);
	assert.equal(record(a).current?.deviceId, a.deviceId);
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
	assert.equal((await storeDbs(a)).length, 1, "one store DB");
	assert.ok(!stateDirs(a).has(first), "the old store's dir goes once the new store's mirrors are written");
	for (const d of devs) {
		assert.deepEqual([...d.vault.snapshot().entries()].sort(), [["new.md", "made just now\n"], ["note.md", "hello\nunsent\n"]], d.name);
		assert.equal(d.vault.trashed.length, 0, d.name);
	}
	assert.equal(files(a), files(b));
});

test("rebuildLocalCache offline (the registration has no answer): the command fails and the store keeps running", async () => {
	const { clock, net, devs } = world(["A"]);
	const [a] = devs as [SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	void a.start();
	await clock.advance(15_000);
	const first = a.deviceId;
	const dbs = await storeDbs(a);
	a.setOnline(false);
	await clock.advance(1_000);
	const reset = assert.rejects(a.runtime.command({ t: "rebuildLocalCache" }), /not rebuilt: YAOS could not reach the server to register this device's local store\.$/);
	await clock.advance(30_000);
	await reset;
	assert.equal(a.deviceId, first);
	assert.deepEqual(await storeDbs(a), dbs, "the store is kept");
	assert.equal(net.identities.registered().length, 1, "nothing registered");
	a.setOnline(true);
	a.vault.userWrite("note.md", "hello\nlater\n");
	await clock.advance(30_000);
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
	assert.equal(a.deviceId, first);
});

test("grant rotation: the old secret stops registering; a device with a live store fetches the new one and data.json keeps it", async () => {
	const { clock, net, devs } = world(["A", "B"]);
	const [a, b] = devs as [SimDevice, SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	const old = a.grantSecret!;
	const rotated = net.identities.rotateGrant(old);
	assert.ok(rotated && rotated !== old);
	const probe = { deviceId: "dev-probe-0000000000000" as DeviceId, deviceToken: "tok-probe".padEnd(43, "0"), retireKeyHash: "0".repeat(64) };
	assert.equal(net.identities.register(old, probe).ok, false, "the old secret is unknown from now on");
	assert.deepEqual(net.identities.fetchGrant("not-a-token"), { ok: false, reason: "refused" });
	// Running stores are not affected (they authenticate with their own tokens).
	a.vault.userWrite("note.md", "hello\nafter the rotation\n");
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("note.md"), "hello\nafter the rotation\n");
	// The next registration (here a local cache rebuild) says unauthorized; the store fetches the secret and retries.
	const first = a.deviceId;
	assert.deepEqual(await command(clock, a, { t: "rebuildLocalCache" }), { t: "ok" });
	await clock.advance(30_000);
	assert.notEqual(a.deviceId, first);
	assert.equal(net.identities.state(a.deviceId), "live");
	assert.equal(a.grantSecret, rotated, "main wrote the fetched secret to data.json");
	assert.equal(net.identities.counts["grant-fetch"], 1);
	assert.equal(net.identities.counts["unauthorized"], 2, "the probe and the one refused try");
	// A restart starts with the new secret.
	a.crashApp();
	await clock.advance(1_000);
	void a.restartApp();
	await clock.advance(15_000);
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
});

test("grant rotation: a never-rotated grant has nothing to fetch; a clone without a live store asks for a re-pair", async () => {
	const { clock, net, devs } = world(["A", "B"]);
	const [a, b] = devs as [SimDevice, SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	const before = a.grantSecret;
	assert.deepEqual(await command(clock, a, { t: "refreshGrant" }), { t: "ok" });
	assert.equal(net.identities.counts["grant-fetch"], 1);
	assert.equal(a.grantSecret, before, "404 grant_secret_unavailable: the secret is kept");
	// The folder is copied onto B (data.json with the grant), then the grant is rotated: B's copy has a new install and
	// no store, so no token to fetch with.
	b.crashApp();
	await clock.advance(500);
	b.cloneFrom(a);
	const rotated = net.identities.rotateGrant(before!);
	assert.ok(rotated);
	void b.restartApp();
	await clock.advance(60_000);
	assert.ok(b.ui.notices.some((n) => n.code === "pairing-unknown"), JSON.stringify(b.ui.notices));
	assert.equal(b.grantSecret, before, "nothing fetched");
	assert.equal(net.identities.counts["grant-fetch"], 1, "no store, no fetch");
	// The source fetches it at its next registration.
	assert.deepEqual(await command(clock, a, { t: "refreshGrant" }), { t: "ok" });
	assert.equal(a.grantSecret, rotated);
});

test("orphan sweep: a store this vault left under another install key is deleted at live once the server reads it retired; never a dir", async () => {
	const lines: string[] = [];
	const { clock, net, devs } = world(["A", "B"], (n, l) => lines.push(`${n} ${l}`));
	const [a, b] = devs as [SimDevice, SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	const bFirst = b.deviceId;
	// B's vault registration is lost (the folder is replaced by a copy of A's): its old store stays in IndexedDB under
	// the old install key, still registered.
	b.crashApp();
	await clock.advance(500);
	b.cloneFrom(a);
	void b.restartApp();
	await clock.advance(20_000);
	assert.notEqual(b.deviceId, bFirst);
	const dbs = await storeDbs(b);
	assert.equal(dbs.length, 2, "the new store and the orphan");
	assert.equal(net.identities.state(bFirst), "live");
	assert.ok(lines.some((l) => l.startsWith("B ") && l.includes("orphan sweep: 1 orphan store(s), 0 deleted")), lines.filter((l) => l.includes("orphan")).join("\n"));
	// Retired (here in the console; unattended, inactivity retirement): the next live deletes it.
	net.removeDevice(bFirst);
	b.crashApp();
	await clock.advance(500);
	void b.restartApp();
	await clock.advance(20_000);
	const left = await storeDbs(b);
	assert.equal(left.length, 1, left.join(","));
	assert.equal(parseDbName(left[0]!)?.storeKey, record(b).installKey, "the live store is kept");
	assert.ok(lines.some((l) => l.includes("orphan sweep: 1 orphan store(s), 1 deleted")));
	assert.ok(stateDirs(b).has(a.deviceId), "the dir the copy carried is not touched");
	for (const what of [b.sideFiles.readDirs, b.sideFiles.writtenDirs]) assert.ok(!what.has(a.deviceId), "B never used A's dir");
	// Nothing left to sweep: no status call at the next live.
	const statuses = net.identities.counts["status"] ?? 0;
	b.crashApp();
	await clock.advance(500);
	void b.restartApp();
	await clock.advance(20_000);
	assert.equal(net.identities.counts["status"] ?? 0, statuses);
	assert.equal(files(a), files(b));
});
