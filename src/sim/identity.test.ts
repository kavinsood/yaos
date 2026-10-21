/**
 * identity-per-store (phases 2 and 3) on the composed sim client (host + protocol + engine + SimRelay + the sim's
 * grant registry): one deviceId per store, ever.
 *  - the first start mints the store's identity, registers it under the pairing grant and creates
 *    `yaos3:<vaultId>:<epoch>:<installKey>` with it in meta.identity; the install record names it;
 *  - an IndexedDB loss is a new store: a new identity, the old one in the install record's lineage; the new store
 *    fences the old one, recovers from its mirror dir (the commit check drops what committed there; without the
 *    fence it waits out the relay's hold) and then removes the dir;
 *  - a store removed in the console is replaced by a successor under the same grant (recovering from its mirror);
 *    with the pairing revoked the store stays and the device asks for a re-pair;
 *  - a vault folder copied to another device (the clone of identity-per-store §4) runs as its own identity, never
 *    touches the source's mirror dir, and both converge with a third device;
 *  - the registration refusals read as statuses: a revoked pairing stops (revoked), the 20-a-day limit waits for
 *    00:00 UTC, the 50-device limit says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DeviceId } from "../core/types";
import { parseDbName } from "../engine/compose/knownEpoch";
import { DB_SCHEMA_VERSION, PENDING_DB_NAME_PREFIX, STORE, STORE_SPECS } from "../engine/store/schema";
import type { YS } from "../engine/store/repo";
import { sanitizeInstallRecord } from "../host/installRecord";
import { VirtualClock } from "./clock";
import { SimDevice } from "./device";
import { SIM_GRANT_DAILY_REGISTRATIONS, SIM_GRANT_LIVE_DEVICES, SimNet } from "./net";

const DAY_MS = 86_400_000;

function world(names = ["A", "B", "C"]): { clock: VirtualClock; net: SimNet; devs: SimDevice[] } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	return { clock, net, devs: names.map((name) => new SimDevice({ name, clock, net })) };
}

function three(devs: readonly SimDevice[]): [SimDevice, SimDevice, SimDevice] {
	const [a, b, c] = devs;
	if (!a || !b || !c) throw new Error("need three devices");
	return [a, b, c];
}

/** Every store DB of the device: name parts and its meta.identity deviceId. */
async function stores(d: SimDevice): Promise<{ name: string; epoch: string; storeKey: string; deviceId: DeviceId | null }[]> {
	const out: { name: string; epoch: string; storeKey: string; deviceId: DeviceId | null }[] = [];
	for (const name of await d.storage.listDatabases()) {
		const p = parseDbName(name);
		if (!p) continue;
		const db = await d.storage.open<YS>(name, DB_SCHEMA_VERSION, STORE_SPECS);
		try {
			const m = await db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, "identity"));
			out.push({ name, epoch: p.vaultEpoch, storeKey: p.storeKey, deviceId: m?.key === "identity" ? m.deviceId : null });
		} finally {
			db.close();
		}
	}
	return out;
}

function record(d: SimDevice) {
	const r = sanitizeInstallRecord(d.installRecord());
	assert.ok(r, `${d.name} has an install record`);
	return r;
}

function files(d: SimDevice): string {
	return [...d.vault.snapshot()].filter(([p]) => p.endsWith(".md")).map(([p, t]) => `${p}=${t}`).sort().join("\n");
}

function stateDirs(d: SimDevice): Set<string> {
	return new Set([...d.sideFiles.files.keys()].map((k) => k.slice(0, k.indexOf("/"))));
}

test("first start: the store's identity is minted, registered under the grant, kept in meta.identity of yaos3:<vault>:<epoch>:<installKey>", async () => {
	const { clock, net, devs } = world(["A"]);
	const [a] = devs as [SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	void a.start();
	await clock.advance(10_000);
	const s = await stores(a);
	assert.equal(s.length, 1, JSON.stringify(s));
	const rec = record(a);
	assert.equal(s[0]!.storeKey, rec.installKey, "the store is named by the install key");
	assert.equal(s[0]!.deviceId, a.deviceId, "the identity lives in the store");
	assert.equal(rec.current?.deviceId, a.deviceId, "the install record names the store");
	assert.ok((rec.current?.retireKey.length ?? 0) >= 32, "with its retire key");
	assert.deepEqual(net.identities.registered(), [a.deviceId], "one registration");
	assert.equal(net.identities.counts["ok"], 1);
	assert.ok(!(await a.storage.listDatabases()).some((n) => n.startsWith(PENDING_DB_NAME_PREFIX)), "the pending identity was consumed by the store");
	assert.deepEqual([...stateDirs(a)], [a.deviceId], "mirrors under state/<deviceId>/");

	// A restart finds the store: same identity, no new registration.
	a.crashApp();
	await clock.advance(1_000);
	void a.restartApp();
	await clock.advance(10_000);
	assert.equal(a.deviceId, s[0]!.deviceId);
	assert.equal(net.identities.counts["ok"], 1, "no registration on restart");
	assert.equal(a.identities.length, 1);
});

test("IndexedDB loss: the next store has a new identity; it fences the old one, recovers from its dir, then removes it", async () => {
	const { clock, net, devs } = world(["A", "B"]);
	const [a, b] = devs as [SimDevice, SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	const first = a.deviceId;
	a.crashApp({ wipe: true });
	await clock.advance(1_000);
	a.vault.userWrite("offline.md", "written while closed\n");
	void a.restartApp();
	await clock.advance(30_000);
	assert.notEqual(a.deviceId, first, "a new store, a new identity");
	const rec = record(a);
	assert.equal(rec.current?.deviceId, a.deviceId);
	assert.deepEqual(rec.predecessors, [first], "the old store is the lineage");
	assert.deepEqual(new Set(net.identities.registered()), new Set([first, a.deviceId, b.deviceId]));
	assert.equal(net.identities.state(first), "retired", "the successor fenced the old store (retire by key)");
	assert.equal(net.identities.counts["retire"], 1);
	assert.ok(!stateDirs(a).has(first), "the old store's dir is removed once the new store's mirrors are written");
	assert.ok(stateDirs(a).has(a.deviceId), "the new store mirrors to its own dir");
	assert.equal(files(a), files(b), "converged");
	assert.ok(b.vault.hasFile("offline.md"));
});

test("clone: a vault folder copied onto another device runs as its own identity, never touches the source's dir, and all converge", async () => {
	const { clock, devs } = world();
	const [a, b, c] = three(devs);
	a.vault.userWrite("note.md", "hello\n");
	a.vault.userWrite("keep.md", "keep\n");
	void a.start();
	void c.start();
	void b.start();
	await clock.advance(15_000);
	const bFirst = b.deviceId;
	b.crashApp();
	await clock.advance(500);
	b.cloneFrom(a);
	void b.restartApp();
	await clock.advance(20_000);
	const ids = [a.deviceId, b.deviceId, c.deviceId];
	assert.equal(new Set(ids).size, 3, `distinct identities ${ids.join(",")}`);
	assert.notEqual(b.deviceId, bFirst, "the copy is a new install: a new store");
	assert.notEqual(record(b).installKey, record(a).installKey);
	assert.deepEqual(record(b).predecessors, [], "no lineage across a clone");
	assert.ok(stateDirs(b).has(a.deviceId), "the copy carried A's dir");

	// Both twins edit at once; everyone converges, the clone never reads or writes A's dir.
	a.vault.userWrite("from-a.md", "A\n");
	b.vault.userWrite("from-b.md", "B\n");
	a.vault.userDelete("keep.md");
	b.vault.userRename("note.md", "note-b.md");
	await clock.advance(60_000);
	assert.equal(files(a), files(b), "A and B converge");
	assert.equal(files(a), files(c), "A and C converge");
	for (const p of ["from-a.md", "from-b.md", "note-b.md"]) assert.ok(c.vault.hasFile(p), `C has ${p}`);
	assert.ok(!c.vault.hasFile("keep.md"));
	for (const what of [b.sideFiles.readDirs, b.sideFiles.writtenDirs]) assert.ok(!what.has(a.deviceId), "B never used A's dir");
});

test("clone: the source creates a note and goes offline before its body commits; the clone does not take over its upload", async () => {
	const { clock, devs } = world();
	const [a, b, c] = three(devs);
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	b.crashApp();
	await clock.advance(500);
	b.cloneFrom(a);
	void b.restartApp();
	await clock.advance(20_000);
	a.setOnline(false);
	a.vault.userWrite("new.md", "important text\n");
	await clock.advance(20_000);
	a.setOnline(true);
	await clock.advance(60_000);
	for (const d of [b, c]) assert.equal(d.vault.textOf("new.md"), "important text\n", `${d.name} has A's note once`);
	assert.equal(files(a), files(b));
	assert.equal(files(a), files(c));
});

test("IndexedDB loss with an ns frame committed but not acked: the commit check drops the inherited copy, nothing twice", async () => {
	// identity-per-store §5.2 step 3: the mirror still lists the create as pending; its identity in the old store's
	// ring says it committed, so the successor does not send it again under its own.
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const lines: string[] = [];
	const a = new SimDevice({ name: "A", clock, net, log: (l) => lines.push(l) });
	const b = new SimDevice({ name: "B", clock, net });
	a.vault.userWrite("note.md", "hello\n");
	for (const d of [a, b]) void d.start();
	await clock.advance(15_000);
	const first = a.deviceId;
	a.vault.userWrite("new.md", "created\n");
	for (let i = 0; i < 20_000 && net.relay.pendingCount() === 0; i++) await clock.advance(1);
	assert.ok(net.relay.pendingCount() > 0, "A's frames are in the relay's buffer");
	a.setOnline(false); // the acks never reach A
	await clock.advance(10_000); // the relay commits them
	assert.equal(net.relay.pendingCount(), 0);
	a.crashApp({ wipe: true });
	await clock.advance(1_000);
	void a.restartApp();
	a.setOnline(true);
	await clock.advance(30_000);
	assert.notEqual(a.deviceId, first);
	const checked = lines.filter((l) => l.startsWith("diag inherited-checked"));
	assert.ok(checked.some((l) => /"dropped":[1-9]/.test(l)), checked.join("\n") || "no commit check ran");
	for (const d of [a, b]) {
		assert.deepEqual([...d.vault.snapshot().entries()].sort(), [["new.md", "created\n"], ["note.md", "hello\n"]], d.name);
		assert.equal(d.vault.trashed.length, 0, d.name);
	}
	const o = await net.oracle();
	assert.deepEqual(o.docs.map((x) => [x.path, x.text]).sort(), [["new.md", "created\n"], ["note.md", "hello\n"]]);
});

test("IndexedDB loss without the fence (the retire key is wrong): the commit check waits out the relay's hold, then recovers", async () => {
	// identity-per-store §5.2 "Without the fence": the predecessor stays registered; its inherited ns / cfg frames are
	// checked only inheritUnfencedWaitMs after the start, past the relay's hold cap for a frame still in its buffer.
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const lines: string[] = [];
	const a = new SimDevice({ name: "A", clock, net, log: (l) => lines.push(`${clock.monotonic()} ${l}`) });
	const b = new SimDevice({ name: "B", clock, net });
	a.vault.userWrite("note.md", "hello\n");
	for (const d of [a, b]) void d.start();
	await clock.advance(15_000);
	const first = a.deviceId;
	a.setOnline(false);
	a.vault.userWrite("new.md", "made offline\n");
	await clock.advance(10_000);
	a.crashApp({ wipe: true });
	for (const [k, v] of a.localStorage) {
		const r = v as { current: { deviceId: string; retireKey: string } | null };
		if (r.current) a.localStorage.set(k, { ...r, current: { ...r.current, retireKey: "x".repeat(43) } });
	}
	await clock.advance(1_000);
	a.setOnline(true);
	void a.restartApp();
	await clock.advance(60_000);
	assert.notEqual(a.deviceId, first);
	assert.equal(net.identities.state(first), "live", "not fenced: the predecessor is still registered");
	const inherited = lines.find((l) => l.includes("diag inherited "));
	const checked = lines.find((l) => l.includes("diag inherited-checked"));
	assert.ok(inherited?.includes('"fenced":false'), inherited);
	assert.ok(inherited && checked, checked);
	assert.ok(Number(checked.split(" ")[0]) - Number(inherited.split(" ")[0]) >= 10_000, `${inherited}\n${checked}`);
	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()].sort(), [["new.md", "made offline\n"], ["note.md", "hello\n"]], d.name);
});

test("store removed in the console: the install registers a successor, which recovers the unsent edits from the old store's mirror", async () => {
	// identity-per-store §4 "Store revoked by the server" with a valid grant: an orderly replacement, nothing lost.
	const { clock, net, devs } = world(["A", "B"]);
	const [a] = devs as [SimDevice, SimDevice];
	a.vault.userWrite("note.md", "hello\n");
	for (const d of devs) void d.start();
	await clock.advance(15_000);
	const first = a.deviceId;
	a.setOnline(false);
	a.vault.userWrite("note.md", "hello\nwritten offline\n");
	a.vault.userWrite("new.md", "made offline\n");
	await clock.advance(10_000); // planned, in the outbox and its mirror
	net.removeDevice(first);
	a.setOnline(true);
	await clock.advance(60_000);
	assert.notEqual(a.deviceId, first, "a successor store");
	assert.deepEqual(a.identities, [first, a.deviceId]);
	assert.equal(net.identities.state(first), "retired");
	assert.equal(net.identities.state(a.deviceId), "live");
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
	assert.deepEqual(record(a).predecessors, [first]);
	for (const d of devs) {
		assert.deepEqual([...d.vault.snapshot().entries()].sort(), [["new.md", "made offline\n"], ["note.md", "hello\nwritten offline\n"]], d.name);
		assert.equal(d.vault.trashed.length, 0, d.name);
	}
	assert.equal((await a.storage.listDatabases()).filter((n) => parseDbName(n)?.vaultEpoch).length, 1, "the revoked store's DB is gone");
	assert.ok(!stateDirs(a).has(first), "and its dir, once the successor's mirrors were written");
});

test("store removed in the console with its pairing revoked: no successor; the store stays and the device asks for a re-pair", async () => {
	const { clock, net, devs } = world(["A"]);
	const [a] = devs as [SimDevice];
	void a.start();
	await clock.advance(15_000);
	const first = a.deviceId;
	net.identities.revokeGrant(a.grantSecret!);
	net.removeDevice(first);
	await clock.advance(60_000);
	assert.equal(a.deviceId, first);
	assert.equal(a.ui.statuses.at(-1)?.phase, "revoked");
	assert.ok(a.ui.notices.some((n) => n.code === "pairing-revoked"), JSON.stringify(a.ui.notices));
	assert.equal((await a.storage.listDatabases()).filter((n) => parseDbName(n)?.vaultEpoch).length, 1, "the store is kept");
});

test("registration refused: a revoked pairing stops the start (revoked, pairing-revoked); a re-paired grant starts it", async () => {
	const { clock, net, devs } = world(["A"]);
	const [a] = devs as [SimDevice];
	net.identities.revokeGrant(a.grantSecret!);
	void a.start();
	await clock.advance(30_000);
	assert.ok(a.ui.notices.some((n) => n.code === "pairing-revoked"), JSON.stringify(a.ui.notices));
	assert.equal(a.ui.statuses.at(-1)?.phase, "revoked");
	assert.equal(net.identities.registered().length, 0);
	const tries = net.identities.counts["grant-revoked"];
	await clock.advance(10 * 60_000);
	assert.equal(net.identities.counts["grant-revoked"], tries, "no retry: only a re-pair helps");

	a.crashApp();
	a.grantSecret = net.identities.issueGrant("A-again");
	void a.restartApp();
	await clock.advance(20_000);
	assert.deepEqual(net.identities.registered(), [a.deviceId]);
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
});

test("registration refused: the 20-a-day limit waits for 00:00 UTC (Retry-After), then the store is created", async () => {
	const { clock, net, devs } = world(["A"]);
	const [a] = devs as [SimDevice];
	const grant = a.grantSecret!;
	for (let i = 0; i < SIM_GRANT_DAILY_REGISTRATIONS; i++) {
		const r = net.identities.register(grant, { deviceId: `dev-other-${String(i).padStart(12, "0")}` as DeviceId, deviceToken: `tok-other-${String(i).padStart(33, "0")}`, retireKeyHash: "0".repeat(64) });
		assert.ok(r.ok, JSON.stringify(r));
	}
	void a.start();
	await clock.advance(30_000);
	assert.ok(a.ui.notices.some((n) => n.code === "registration-limit"), JSON.stringify(a.ui.notices));
	assert.equal(a.ui.statuses.at(-1)?.phase, "offline");
	const refused = net.identities.counts["registration-limit"] ?? 0;
	// The network flapping does not end the server's wait.
	a.setOnline(false);
	await clock.advance(1_000);
	a.setOnline(true);
	await clock.advance(60_000);
	assert.equal(net.identities.counts["registration-limit"], refused, "no retry before Retry-After");
	const toMidnight = DAY_MS - (clock.now() % DAY_MS);
	await clock.advance(toMidnight + 30_000);
	assert.ok(net.identities.registered().includes(a.deviceId), "registered after 00:00 UTC");
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
});

test("registration refused: 50 live devices on the pairing reads device-limit; retiring one in the console lets the start through", async () => {
	const { clock, net, devs } = world(["A"]);
	const [a] = devs as [SimDevice];
	const grant = a.grantSecret!;
	const others: DeviceId[] = [];
	for (let i = 0; i < SIM_GRANT_LIVE_DEVICES; i++) {
		if (i > 0 && i % SIM_GRANT_DAILY_REGISTRATIONS === 0) await clock.advance(DAY_MS);
		const id = `dev-other-${String(i).padStart(12, "0")}` as DeviceId;
		assert.ok(net.identities.register(grant, { deviceId: id, deviceToken: `tok-other-${String(i).padStart(33, "0")}`, retireKeyHash: "0".repeat(64) }).ok);
		others.push(id);
	}
	await clock.advance(DAY_MS);
	void a.start();
	await clock.advance(30_000);
	assert.ok(a.ui.notices.some((n) => n.code === "device-limit"), JSON.stringify(a.ui.notices));
	assert.equal(a.ui.statuses.at(-1)?.phase, "error");
	net.identities.retire(others[0]!);
	await clock.advance(30 * 60_000);
	assert.ok(net.identities.registered().includes(a.deviceId), "registered once a slot freed (the start retries on its backoff)");
	assert.equal(a.ui.statuses.at(-1)?.phase, "live");
});
