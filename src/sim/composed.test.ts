/**
 * Composed full-client scenarios on the sim (host + protocol + engine + SimRelay):
 * attachments through the blob store (never the relay log; without a store they
 * stay local until a later connect finds one; a store that stalls or crawls:
 * the idle window, the link abort, retries), settings sync, IndexedDB loss
 * with mirror recovery, and a relay epoch reset (§c.12) migrating both devices.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultEpoch } from "../core/types";
import { BLOB_TRANSFER_IDLE_MS } from "../core/limits";
import { pathKey } from "../core/paths/pathKey";
import type { EngineResultValue, EngineSettings } from "../protocol/messages";
import { VirtualClock } from "./clock";
import { SIM_SETTINGS, SimDevice, type SimDeviceOptions } from "./device";
import { SimNet } from "./net";

function world(opts: Partial<SimDeviceOptions> = {}, names = ["A", "B"]): { clock: VirtualClock; net: SimNet; devs: SimDevice[] } {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const devs = names.map((name) => new SimDevice({ name, clock, net, ...opts }));
	return { clock, net, devs };
}

async function boot(clock: VirtualClock, devs: readonly SimDevice[]): Promise<void> {
	for (const d of devs) void d.start();
	await clock.advance(500);
}

function pair(devs: readonly SimDevice[]): [SimDevice, SimDevice] {
	const [a, b] = devs;
	if (!a || !b) throw new Error("need two devices");
	return [a, b];
}

/** Deterministic pseudo-random bytes (not valid UTF-8 in general). */
function bytes(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < n; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		out[i] = x & 0xff;
	}
	return out;
}

async function same(a: SimDevice, b: SimDevice, path: string, want: Uint8Array): Promise<void> {
	assert.ok(a.vault.hasFile(path), `${a.name} has ${path}`);
	assert.ok(b.vault.hasFile(path), `${b.name} has ${path}`);
	assert.deepEqual(await a.vault.readBytes(path), want, `${a.name} bytes of ${path}`);
	assert.deepEqual(await b.vault.readBytes(path), want, `${b.name} bytes of ${path}`);
}

const ATTACH: EngineSettings = { ...SIM_SETTINGS, syncAttachments: true, maxAttachmentBytes: 8 * 1024 * 1024 };

/** The relay log carried only small records: no foreign stream, no ns/cfg/snap/k row near a blob's size. */
function logCarriesNoBlobs(net: SimNet, blobBytes: number): void {
	const audit = net.logAudit();
	assert.deepEqual(audit.foreign, [], "no stream outside ns/cfg/snap/k/b:/c:");
	assert.ok(audit.largestRecordRow < 4096, `largest ns/cfg/snap/k row ${audit.largestRecordRow} B`);
	assert.ok(audit.bytes * 20 < blobBytes, `the log carried ${audit.bytes} B in ${audit.rows} rows for ${blobBytes} B of attachments`);
}

test("attachments go to the blob store, only small ns records ride the log: create, multi-MB update, rename and delete converge byte-identical", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	const small = bytes(5_000, 1);
	a.vault.externalWrite("img/p.png", small);
	await boot(clock, devs);
	await clock.advance(10_000);
	await same(a, b, "img/p.png", small);

	const big = bytes(1_700_000, 2);
	a.vault.externalWrite("img/p.png", big);
	await clock.advance(20_000);
	await same(a, b, "img/p.png", big);
	assert.equal(net.blobs.objects.size, 2, "both versions in the store");
	logCarriesNoBlobs(net, small.length + big.length);

	assert.ok(b.vault.userRename("img/p.png", "img/q.png"));
	await clock.advance(10_000);
	assert.equal(a.vault.hasFile("img/p.png"), false, "rename reached A");
	await same(a, b, "img/q.png", big);

	assert.ok(a.vault.userDelete("img/q.png"));
	await clock.advance(10_000);
	assert.equal(b.vault.hasFile("img/q.png"), false, "delete reached B");
	assert.ok(b.vault.trashed.some((r) => r.path === "img/q.png"), "B trashed it (never a hard delete)");
	assert.equal(a.vault.snapshot().size + b.vault.snapshot().size, 0);
	logCarriesNoBlobs(net, small.length + big.length);
});

/** No ns entry names `path` on `d` (nothing about it reached the relay). */
function noEntry(d: SimDevice, path: string): void {
	assert.ok(!d.vrt!.log.listDocs().some((x) => x.path === path), `${d.name}: no ns entry for ${path}`);
}

test("no blob store: attachments stay local (no ns entry, no transfer queued, no notice), notes sync, status maxBlobBytes 0", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	net.blobsAvailable = false;
	const [a, b] = pair(devs);
	const pic = bytes(5_000, 4);
	a.vault.externalWrite("img/p.png", pic);
	a.vault.userWrite("n.md", "note");
	await boot(clock, devs);
	await clock.advance(20_000);
	assert.equal(b.vault.textOf("n.md"), "note");
	assert.equal(b.vault.hasFile("img/p.png"), false);
	assert.deepEqual(await a.vault.readBytes("img/p.png"), pic, "the local file stays");
	noEntry(a, "img/p.png");
	noEntry(b, "img/p.png");
	for (const d of devs) {
		assert.deepEqual(d.vrt!.blobs.queued(), [], `${d.name}: nothing queued (no retry timer)`);
		assert.equal(d.ui.statuses[d.ui.statuses.length - 1]?.maxBlobBytes, 0, `${d.name}: status maxBlobBytes`);
		assert.deepEqual(d.ui.notices.filter((n) => /blob|attach/i.test(n.code)), [], `${d.name}: no notice about server blob storage`);
	}
	assert.equal(net.blobs.calls.put + net.blobs.calls.has + net.blobs.calls.get, 0);
	assert.deepEqual(net.logAudit().foreign, []);
	// Only the note's records: nothing blob-sized, nothing for the attachment.
	assert.ok(net.logAudit().bytes < 4096, `${net.logAudit().bytes} B on the log`);
});

test("a blob store found on a later connect: the runtime restarts with it, pending attachments upload, the ns record follows", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	net.blobsAvailable = false;
	const [a, b] = pair(devs);
	const pic = bytes(900_000, 5);
	a.vault.externalWrite("img/p.png", pic);
	await boot(clock, devs);
	await clock.advance(20_000);
	assert.equal(b.vault.hasFile("img/p.png"), false);
	noEntry(a, "img/p.png");
	const starts = a.engineStarts;

	// The operator binds R2 and redeploys: every socket drops, the next connect's probe finds the store.
	net.blobsAvailable = true;
	for (const d of devs) net.setOnline(d.machineKey, false);
	await clock.advance(1_000);
	for (const d of devs) net.setOnline(d.machineKey, true);
	await clock.advance(30_000);
	await same(a, b, "img/p.png", pic);
	assert.equal(net.blobs.objects.size, 1);
	assert.equal(a.engineStarts, starts, "the same engine: only its vault runtime restarted");
	for (const d of devs) assert.ok((d.ui.statuses[d.ui.statuses.length - 1]?.maxBlobBytes ?? 0) > 0, `${d.name}: status maxBlobBytes`);
	logCarriesNoBlobs(net, pic.length);
});

test("attachments off: a binary file stays local", async () => {
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.externalWrite("img/p.png", bytes(1_000, 3));
	a.vault.userWrite("n.md", "note");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("n.md"), "note");
	assert.equal(b.vault.hasFile("img/p.png"), false);
});

// --- blob store stalls and slow periods (sim/blobStore.ts: the adapter's idle window and the link abort) -------

/** Diagnostics `code` events on d's engine so far. */
function diags(d: SimDevice, code: string): readonly Readonly<Record<string, unknown>>[] {
	return d.vrt!.log.diagnostics().filter((e) => e.code === code).map((e) => e.fields);
}

function queuedOf(d: SimDevice): string[] {
	return d.vrt!.blobs.queued().map((q) => `${q.direction}:${q.path}:${q.state}#${q.attempts}`);
}

test("blob store stall on the PUT body: a socket drop (1006) aborts the stalled upload through the link, a note edited meanwhile syncs, after the heal the retry converges", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	a.vault.userWrite("n.md", "note\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("n.md"), "note\n");

	net.blobs.setStall("put"); // the server stops reading upload bodies (httpBlob.ts:39-41); exists answers
	const pic = bytes(300_000, 7);
	a.vault.externalWrite("img/p.png", pic);
	assert.ok(await clock.runUntil(() => net.blobs.transfers().length > 0, 20_000), "the upload's PUT stalls");
	assert.deepEqual(net.blobs.transfers().map((c) => c.route), ["put"]);
	assert.equal(net.blobs.calls.has, 1, "exists answered");
	assert.deepEqual(queuedOf(a), ["up:img/p.png:running#0"]);
	a.vault.externalWrite("n.md", "note\nedited during the stall\n");
	await clock.advance(5_000);
	assert.equal(b.vault.textOf("n.md"), "note\nedited during the stall\n", "the stalled upload holds up no other doc");
	assert.equal(b.vault.hasFile("img/p.png"), false);

	net.relay.dropSession(a.deviceId); // 1006: the session loop declares the link dead
	await clock.advance(100);
	assert.equal(net.blobs.liveness.aborted, 1, "the link abort ended the stalled call");
	assert.equal(net.blobs.liveness.watchdog, 0, "not the idle window");
	assert.deepEqual(diags(a, "blob-transfers-aborted"), [{ n: 1, why: "close 1006" }]);
	assert.deepEqual(net.blobs.transfers(), []);
	assert.deepEqual(queuedOf(a), ["up:img/p.png:backoff#1"], "a backoff record, not a lost transfer");

	await clock.advance(20_000); // the retry (after the 2 s backoff) stalls again
	assert.deepEqual(net.blobs.transfers().map((c) => c.route), ["put"]);
	assert.deepEqual(queuedOf(a), ["up:img/p.png:running#1"]);
	net.blobs.setStall(null);
	// The retry's call stays dead (a black-holed stream does not resume): its idle window ends it, the next retry lands.
	await clock.advance(2 * 60_000);
	await same(a, b, "img/p.png", pic);
	assert.deepEqual([net.blobs.liveness.aborted, net.blobs.liveness.watchdog, net.blobs.liveness.stalled.put], [1, 1, 2]);
	assert.deepEqual([net.blobs.calls.has, net.blobs.calls.put], [3, 3], "three attempts: aborted, cut by the window, stored");
	for (const d of devs) assert.deepEqual(d.vrt!.blobs.queued(), [], `${d.name}: queue empty`);
	assert.deepEqual(net.blobs.transfers(), []);
	assert.equal(b.vault.textOf("n.md"), "note\nedited during the stall\n");
	logCarriesNoBlobs(net, pic.length);
});

test("blob store stall, no link loss: the idle window ends the call at BLOB_TRANSFER_IDLE_MS, not before; it backs off, retries and converges after the heal", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	await boot(clock, devs);
	await clock.advance(5_000);
	net.blobs.setStall("path");
	const pic = bytes(200_000, 8);
	a.vault.externalWrite("img/p.png", pic);
	assert.ok(await clock.runUntil(() => net.blobs.transfers().length > 0, 20_000));
	const [call] = net.blobs.transfers();
	assert.equal(call?.route, "has", "the upload asks exists first");
	const t0 = call.startedAt;
	await clock.advance(t0 + BLOB_TRANSFER_IDLE_MS - 1 - clock.monotonic());
	assert.equal(net.blobs.liveness.watchdog, 0, "nothing ended at idle - 1 ms");
	assert.equal(net.blobs.transfers().length, 1);
	assert.deepEqual(queuedOf(a), ["up:img/p.png:running#0"]);
	await clock.advance(1);
	assert.equal(net.blobs.liveness.watchdog, 1, "ended at the idle window");
	assert.equal(net.blobs.liveness.aborted, 0);
	await clock.advance(100);
	assert.deepEqual(queuedOf(a), ["up:img/p.png:backoff#1"]);
	assert.equal(b.vault.hasFile("img/p.png"), false);

	net.blobs.setStall(null);
	await clock.advance(60_000);
	await same(a, b, "img/p.png", pic);
	for (const d of devs) assert.deepEqual(d.vrt!.blobs.queued(), [], `${d.name}: queue empty`);
	assert.deepEqual(net.blobs.transfers(), []);
});

test("slow blob store: an upload and a download each taking longer than the idle window complete, never cut, with no retry", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	await boot(clock, devs);
	await clock.advance(5_000);
	const rate = 8 * 1024;
	net.blobs.setSlow(rate);
	const pic = bytes(600_000, 9);
	assert.ok(pic.length / rate > 1.2 * (BLOB_TRANSFER_IDLE_MS / 1000), "each transfer outlasts the idle window");
	a.vault.externalWrite("img/p.png", pic);
	await clock.advance(4 * 60_000);
	await same(a, b, "img/p.png", pic);
	const s = net.blobs.liveness;
	assert.deepEqual([s.watchdog, s.slowCut, s.aborted], [0, 0, 0], "nothing cut, nothing aborted");
	assert.ok(s.slowOverIdle >= 2, `the PUT and the GET outlasted the window (${s.slowOverIdle}, max ${s.slowMaxMs} ms)`);
	assert.ok(s.slowMaxMs > BLOB_TRANSFER_IDLE_MS);
	assert.deepEqual([net.blobs.calls.put, net.blobs.calls.get], [1, 1], "one PUT, one GET: no retry");
	for (const d of devs) assert.deepEqual(d.vrt!.blobs.queued(), [], `${d.name}: queue empty`);
});

test("blob store stall on the receiver's download: the idle window ends it, then a socket drop ends the retry; after the heal the attachment arrives", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	await boot(clock, devs);
	await clock.advance(5_000);
	const pic = bytes(150_000, 10);
	a.vault.externalWrite("img/p.png", pic);
	assert.ok(await clock.runUntil(() => net.blobs.objects.size > 0, 20_000), "A's PUT landed");
	net.blobs.setStall("path");
	assert.ok(await clock.runUntil(() => net.blobs.transfers().length > 0, 20_000), "B's download stalls");
	assert.deepEqual(net.blobs.transfers().map((c) => c.route), ["get"]);
	assert.deepEqual(queuedOf(b), ["down:img/p.png:running#0"]);
	assert.deepEqual(a.vrt!.blobs.queued(), [], "the upload finished");

	await clock.advance(BLOB_TRANSFER_IDLE_MS);
	assert.deepEqual([net.blobs.liveness.watchdog, net.blobs.liveness.stalled.get], [1, 1], "the idle window ended the GET");
	assert.ok(await clock.runUntil(() => net.blobs.transfers().length > 0, 10_000), "the retry stalls too");
	assert.deepEqual(queuedOf(b), ["down:img/p.png:running#1"]);
	net.relay.dropSession(b.deviceId);
	await clock.advance(100);
	assert.equal(net.blobs.liveness.aborted, 1, "the link abort ended the retry");
	assert.deepEqual(diags(b, "blob-transfers-aborted"), [{ n: 1, why: "close 1006" }]);
	assert.deepEqual(queuedOf(b), ["down:img/p.png:backoff#2"]);
	assert.equal(b.vault.hasFile("img/p.png"), false);

	net.blobs.setStall(null);
	await clock.advance(60_000);
	await same(a, b, "img/p.png", pic);
	for (const d of devs) assert.deepEqual(d.vrt!.blobs.queued(), [], `${d.name}: queue empty`);
	assert.deepEqual(net.blobs.transfers(), []);
});

const SETTINGS_ON: EngineSettings = { ...SIM_SETTINGS, syncSettings: true };
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);

test("settings sync: app.json keys and a snippet reach the other device; the yaos plugin folder never syncs", async () => {
	const { clock, devs } = world({ settings: () => SETTINGS_ON });
	const [a, b] = pair(devs);
	await a.configDir.writeBytes("app.json", enc(JSON.stringify({ vimMode: true, spellcheck: false })));
	await a.configDir.writeBytes("snippets/wide.css", enc(".a{width:100%}"));
	await a.configDir.writeBytes("plugins/yaos/data.json", enc(JSON.stringify({ secret: "x" })));
	await boot(clock, devs);
	await clock.advance(20_000);
	assert.deepEqual(JSON.parse(dec(await b.configDir.readBytes("app.json")) ?? "null"), { vimMode: true, spellcheck: false });
	assert.equal(dec(await b.configDir.readBytes("snippets/wide.css")), ".a{width:100%}");
	assert.equal(await b.configDir.readBytes("plugins/yaos/data.json"), null);

	// A change on B is picked up by B's next full pass (periodic, 5 min on desktop).
	await b.configDir.writeBytes("app.json", enc(JSON.stringify({ vimMode: false, spellcheck: false })));
	await clock.advance(6 * 60_000);
	assert.deepEqual(JSON.parse(dec(await a.configDir.readBytes("app.json")) ?? "null"), { vimMode: false, spellcheck: false });
});

/**
 * A (desktop) syncs app.json and two enabled plugins; then mobile P joins with its own app.json. P's first cfg pass
 * waits for the cfg catch-up, so the seed decides: "vault" takes A's values, "device" keeps P's. P never enables
 * the desktop-only plugin, and A keeps it enabled.
 */
async function firstContact(seed: "device" | "vault"): Promise<{ a: string | null; p: string | null; pPlugins: string | null; aPlugins: string | null }> {
	const clock = new VirtualClock();
	clock.onError = (e) => {
		throw e;
	};
	const net = new SimNet(clock);
	const a = new SimDevice({ name: "A", clock, net, settings: () => SETTINGS_ON });
	const p = new SimDevice({ name: "P", clock, net, mobile: true, settings: () => ({ ...SETTINGS_ON, syncSettingsSeed: seed }) });
	const manifest = (d: SimDevice, id: string, desktopOnly: boolean): Promise<void> =>
		d.configDir.writeBytes(`plugins/${id}/manifest.json`, enc(JSON.stringify({ id, version: "1.0.0", ...(desktopOnly ? { isDesktopOnly: true } : {}) })));
	for (const d of [a, p]) {
		await manifest(d, "draw", true);
		await manifest(d, "dv", false);
	}
	await a.configDir.writeBytes("app.json", enc(JSON.stringify({ vimMode: true })));
	await a.configDir.writeBytes("community-plugins.json", enc(JSON.stringify(["draw", "dv"])));
	await boot(clock, [a]);
	await clock.advance(20_000);
	await p.configDir.writeBytes("app.json", enc(JSON.stringify({ vimMode: false })));
	await p.configDir.writeBytes("community-plugins.json", enc(JSON.stringify([])));
	await boot(clock, [p]);
	await clock.advance(20_000);
	await clock.advance(6 * 60_000); // A's next periodic full pass sees P's first-contact ops
	const json = async (d: SimDevice, f: string): Promise<string | null> => {
		const t = dec(await d.configDir.readBytes(f));
		return t === null ? null : JSON.stringify(JSON.parse(t));
	};
	return { a: await json(a, "app.json"), p: await json(p, "app.json"), pPlugins: await json(p, "community-plugins.json"), aPlugins: await json(a, "community-plugins.json") };
}

test("settings sync first contact, seed \"vault\": the joining device waits for the cfg catch-up and takes the vault's values", async () => {
	assert.deepEqual(await firstContact("vault"), { a: '{"vimMode":true}', p: '{"vimMode":true}', pPlugins: '["dv"]', aPlugins: '["draw","dv"]' });
});

test("settings sync first contact, seed \"device\": the joining device's values win; a mobile device leaves a desktop-only plugin off", async () => {
	assert.deepEqual(await firstContact("device"), { a: '{"vimMode":false}', p: '{"vimMode":false}', pPlugins: '["dv"]', aPlugins: '["draw","dv"]' });
});

// identity-per-store: a store lost with IndexedDB takes its identity with it; the next store (a new deviceId) recovers
// from the old one's mirrors (state/<old>/, §5.2 predecessor recovery). Without the mirrors the restart is DESIGN §i.5
// "without mirrors".

test("IndexedDB and mirrors lost while the app is down: a new identity, the offline edits survive as a conflict copy", async () => {
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	a.vault.userWrite("y.md", "why\n");
	await boot(clock, devs);
	await clock.advance(10_000); // synced, mirrors written
	const before = a.deviceId;
	a.crashApp({ wipe: true, dropMirrors: true });
	a.vault.externalWrite("x.md", "one\nA offline\n");
	b.vault.userWrite("z.md", "zed\n");
	await clock.advance(5_000);
	void a.restartApp();
	await clock.advance(20_000);
	assert.notEqual(a.deviceId, before, "the new store has a new identity");
	assert.deepEqual(a.identities, [before, a.deviceId]);
	const copy = "x (conflict A 2026-01-01 0000).md";
	for (const d of [a, b]) {
		assert.deepEqual([...d.vault.snapshot().entries()].sort(), [["x.md", "one\n"], [copy, "one\nA offline\n"], ["y.md", "why\n"], ["z.md", "zed\n"]].sort(), `${d.name}`);
		assert.equal(d.vault.trashed.length, 0, `${d.name}: nothing trashed`);
	}
});

test("IndexedDB evicted while the app is down: restart recovers from the mirror, no duplicates, offline edits on both sides survive", async () => {
	const { clock, net, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	a.vault.userWrite("y.md", "why\n");
	await boot(clock, devs);
	await clock.advance(5_000);
	assert.equal(b.vault.textOf("x.md"), "one\n");
	await clock.advance(5_000); // mirrors written
	const before = a.deviceId;

	a.crashApp({ wipe: true });
	a.vault.externalWrite("x.md", "one\nA offline\n");
	b.vault.externalWrite("y.md", "why\nB meanwhile\n");
	b.vault.userWrite("z.md", "zed\n");
	await clock.advance(5_000);
	void a.restartApp();
	await clock.advance(20_000);

	for (const d of [a, b]) {
		assert.equal(d.vault.textOf("x.md"), "one\nA offline\n", `${d.name} x.md`);
		assert.equal(d.vault.textOf("y.md"), "why\nB meanwhile\n", `${d.name} y.md`);
		assert.equal(d.vault.textOf("z.md"), "zed\n", `${d.name} z.md`);
		assert.deepEqual([...d.vault.snapshot().keys()].sort(), ["x.md", "y.md", "z.md"], `${d.name}: no conflict copies or duplicates`);
		assert.equal(d.vault.trashed.length, 0, `${d.name}: nothing trashed`);
	}
	assert.notEqual(a.deviceId, before, "the successor store has a new identity");
	assert.deepEqual(a.identities, [before, a.deviceId]);
	// The predecessor was fenced (retired by key) and its dir removed once the successor's mirrors were written.
	assert.equal(net.identities.state(before), "retired");
	assert.ok(![...a.sideFiles.files.keys()].some((k) => k.startsWith(`${before}/outbox`) || k.startsWith(`${before}/synced`)), "the predecessor's mirrors are gone");
	assert.ok([...a.sideFiles.files.keys()].some((k) => k.startsWith(`${a.deviceId}/outbox`)), "the successor's mirror is written");
});

test("IndexedDB and mirrors both lost: the device re-bootstraps; same-content files merge without copies", async () => {
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	a.crashApp({ wipe: true, dropMirrors: true });
	await clock.advance(1_000);
	void a.restartApp();
	await clock.advance(20_000);
	b.vault.externalWrite("x.md", "one\nafter\n");
	await clock.advance(10_000);
	for (const d of [a, b]) {
		assert.deepEqual([...d.vault.snapshot().entries()], [["x.md", "one\nafter\n"]], `${d.name}`);
		assert.equal(d.vault.trashed.length, 0);
	}
});

test("relay epoch reset (§c.12): both devices migrate, re-upload, and keep syncing with nothing lost", async () => {
	const { clock, net, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	b.vault.userWrite("y.md", "two\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(a.vault.textOf("y.md"), "two\n");
	const before = devs.map((d) => d.vrt!.log.c.self);

	net.relay.resetEpoch("sim-epoch-2" as VaultEpoch);
	a.vault.externalWrite("x.md", "one\nduring reset\n");
	await clock.advance(30_000);
	b.vault.userWrite("w.md", "after\n");
	await clock.advance(10_000);

	const want = [["w.md", "after\n"], ["x.md", "one\nduring reset\n"], ["y.md", "two\n"]];
	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()].sort(), want, `${d.name}`);
	// One device's re-create of x.md lost the race to the other's and merged into it (3-way against the old epoch's
	// base) instead of a loser rename. Either may have materialized the loser before it was deleted: that transient
	// copy (the old base, or A's edit) is in its trash, and nothing else is.
	for (const d of [a, b]) for (const t of d.vault.trashed) assert.ok(t.path === "x (2).md" && (t.text === "one\n" || t.text === "one\nduring reset\n"), `${d.name} trashed ${t.path}`);
	const o = await net.oracle();
	assert.equal(o.error, null);
	assert.deepEqual(o.docs.map((x) => [x.path, x.text]).sort(), want, "the new epoch holds the whole vault");
	// identity-per-store §4 (decision 2): the new epoch's store is a new device, and the old one retired itself once
	// the new one was live (its DB deleted with it).
	devs.forEach((d, i) => {
		const now = d.vrt!.log.c.self;
		assert.notEqual(now, before[i], `${d.name}: a new identity for the new epoch`);
		assert.equal(net.identities.state(now), "live");
		assert.equal(net.identities.state(before[i]!), "retired", `${d.name}: the old epoch's store retired`);
		assert.deepEqual(d.vrt!.log.c.repo.identity.supersedes, [before[i]], `${d.name}: the new store names the one it replaces`);
	});
	for (const d of devs) assert.deepEqual((await d.storage.listDatabases()).filter((n) => n.startsWith("yaos3:")).map((n) => n.split(":")[2]), ["sim-epoch-2"], `${d.name}: only the new epoch's store`);
});

test("epoch reset with local snapshots on: the new epoch's store (a new device) lists the migration's snapshot", async () => {
	// The "epoch" snapshot is taken by the old store, in its dir; the new store takes the old dir's local snapshots over
	// (identity-per-store §5.2 step 6) and removes the old dir's files once its own mirrors are written.
	const settings = { ...SIM_SETTINGS, snapshots: { enabled: true, keepDaily: 7, uploadToBlobStore: false } };
	const { clock, net, devs } = world({ settings: () => settings }, ["A"]);
	const a = devs[0]!;
	a.vault.userWrite("x.md", "one\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	const old = a.vrt!.log.c.self;
	net.relay.resetEpoch("sim-epoch-2" as VaultEpoch);
	await clock.advance(30_000);
	assert.equal(a.vrt?.vaultEpoch, "sim-epoch-2");
	assert.notEqual(a.vrt.log.c.self, old);
	let listed: EngineResultValue | null = null;
	void a.runtime.command({ t: "listSnapshots" }).then((v) => (listed = v));
	for (let i = 0; i < 200 && listed === null; i++) await clock.advance(50);
	const got = listed as EngineResultValue | null;
	assert.equal(got?.t, "snapshots");
	const snaps = got?.t === "snapshots" ? got.snapshots : [];
	assert.ok(snaps.some((x) => x.reason === "epoch"), `the epoch snapshot is listed: ${JSON.stringify(snaps.map((x) => x.reason))}`);
});

test("epoch reset, app crash after the migration and before its merges: the old epoch's base survives the restart", async () => {
	// Sim suite-1 seed 65. The bases a migration carries (the old DB's synced text by path) lived in memory only: A
	// crashed after opening the new epoch's DB and before merging x.md with B's re-create, came back with no base,
	// and its unchanged file read as a conflicting side of B's edit: a conflict copy (for a canvas re-create that lost
	// the path race: a suffixed duplicate) instead of B's text.
	const { clock, net, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "one\n");

	a.setOnline(false);
	net.relay.resetEpoch("sim-epoch-2" as VaultEpoch);
	await clock.advance(20_000); // B migrated and re-created x.md
	b.vault.userWrite("x.md", "one\nfrom B\n");
	await clock.advance(5_000);
	a.setOnline(true);
	for (let i = 0; i < 30_000 && a.vrt?.vaultEpoch !== "sim-epoch-2"; i++) await clock.advance(1);
	assert.equal(a.vrt?.vaultEpoch, "sim-epoch-2", "A migrated");
	assert.equal(a.vrt?.rec.ctx.store.synced.size, 0, "nothing merged in the new epoch yet");
	a.crashApp();
	await clock.advance(1_000);
	void a.restartApp();
	await clock.advance(30_000);

	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()], [["x.md", "one\nfrom B\n"]], `${d.name}`);
	assert.equal(a.vrt?.bases.keys.size, 0, "the base is retired once x.md is settled");
	// The crash also came before the old DB's retirement. Two DBs make every later start wait for the relay to name
	// the epoch (knownEpoch.ts: no offline start), and the old one was never deleted: it is, once the new one is live.
	assert.deepEqual((await a.storage.listDatabases()).map((n) => n.split(":")[2]), ["sim-epoch-2"]);
	const o = await net.oracle();
	assert.deepEqual(o.docs.map((x) => [x.path, x.text]), [["x.md", "one\nfrom B\n"]]);
});

test("epoch restore to a point before a text delete: the migration deletes the restored text again", async () => {
	// DESIGN §c.12 "Deletes". The restored relay state predates the delete of " two", the devices' bases and files
	// lack it, so the merge against the old epoch's base read the restored text as added in the new epoch and put
	// it back. A restore keeps the doc and its item ids: the old doc's delete set names the characters.
	const { clock, net, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "a\none two three\nb\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "a\none two three\nb\n");
	const snap = net.relay.snapshot();
	a.vault.userWrite("x.md", "a\none three\nb\n");
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "a\none three\nb\n");

	net.relay.restoreEpoch(snap, "sim-epoch-2" as VaultEpoch);
	await clock.advance(60_000);
	for (const d of [a, b]) {
		assert.equal(d.vrt?.vaultEpoch, "sim-epoch-2", `${d.name} migrated`);
		assert.deepEqual([...d.vault.snapshot().entries()], [["x.md", "a\none three\nb\n"]], `${d.name}`);
	}
	const o = await net.oracle();
	assert.deepEqual(o.docs.map((x) => [x.path, x.text]), [["x.md", "a\none three\nb\n"]]);
});

test("IndexedDB and mirrors lost after an own edit reached the relay but not the disk: both texts survive", async () => {
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	const v = a.workspace.openFile("x.md");
	assert.ok(v);
	await clock.advance(1_000);
	v.edit(3, 0, " typed");
	await clock.advance(1_000); // frame acked; the editor's 2 s save has not run
	a.crashApp({ wipe: true, dropMirrors: true });
	await clock.advance(1_000);
	void a.restartApp();
	await clock.advance(30_000);
	for (const d of [a, b]) {
		assert.deepEqual([...d.vault.snapshot().entries()].sort(), [["x (conflict A 2026-01-01 0000).md", "one\n"], ["x.md", "one typed\n"]], `${d.name}`);
		assert.equal(d.vault.trashed.length, 0);
	}
});

test("IndexedDB evicted after an own edit reached the relay but not the disk: recovery writes it to disk", async () => {
	// Sim seed 690 F DEV3. Every row of x.md is A's own, so reading the stream back after the wipe does not move
	// bodyVersion.remoteSeq. A mirror-imported sync point that kept remoteSeq read as "remote unchanged" (Rc false),
	// and the disk, equal to S, never got the typed text the relay and B hold (§i.5: import with bodyVersion null).
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	await boot(clock, devs);
	await clock.advance(10_000); // synced, mirrors written
	const v = a.workspace.openFile("x.md");
	assert.ok(v);
	await clock.advance(1_000);
	assert.ok(v.isBound(), "bound");
	v.edit(3, 0, " typed");
	await clock.advance(1_000); // frame acked; the editor's 2 s save has not run
	assert.equal(a.vault.textOf("x.md"), "one\n");
	assert.equal(b.vault.textOf("x.md"), "one typed\n");
	a.crashApp({ wipe: true });
	await clock.advance(1_000);
	void a.restartApp();
	await clock.advance(30_000);
	for (const d of [a, b]) {
		assert.deepEqual([...d.vault.snapshot().entries()], [["x.md", "one typed\n"]], `${d.name}`);
		assert.equal(d.vault.trashed.length, 0);
	}
});

test("epoch reset with the note open: the view re-binds once the re-create holds the text, no conflict copy", async () => {
	// The restart re-opens bound views at once. openDoc bound the own re-create (or the winner, whose frames were
	// in flight) while its body was still empty: the bind-time merge, with no base, took "" as the other side of a
	// conflict, emptied the editor and wrote the editor's text out as a conflict copy.
	const { clock, net, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "one\n");
	const views = [a.workspace.openFile("x.md"), b.workspace.openFile("x.md")];
	await clock.advance(1_000);
	for (const v of views) assert.ok(v?.isBound(), "bound");

	net.relay.resetEpoch("sim-epoch-2" as VaultEpoch);
	await clock.advance(30_000);
	for (const v of views) assert.ok(v?.isBound(), "bound again after the migration");
	views[0]?.edit(3, 0, " typed");
	await clock.advance(10_000);
	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()], [["x.md", "one typed\n"]], `${d.name}`);
	for (const v of views) assert.equal(v?.getText(), "one typed\n");
	const o = await net.oracle();
	assert.deepEqual(o.docs.map((x) => [x.path, x.text]), [["x.md", "one typed\n"]]);
});

test("epoch reset after an offline edit on a stale stream whose editor died unsaved: the edit survives the migration", async () => {
	// Sim seed 383 (randomized tuning). A's edit reached B as a skip (B had x.md unsubscribed) and B deferred the read;
	// B went offline, typed into x.md and the app died before the editor's save. The edit was in B's storage only, and
	// the planner held x.md for the read (body-not-caught-up). The relay's epoch reset then made the read impossible,
	// and the migration dropped the outbox on the premise that its edits were on disk (§c.12 step 5): gone.
	const { clock, net } = world({}, []);
	const a = new SimDevice({ name: "A", clock, net });
	const b = new SimDevice({ name: "B", clock, net, tuning: { skipSettleMs: 60_000, skipMaxDeferMs: 60_000 } });
	a.vault.userWrite("x.md", "one\ntwo\n");
	await boot(clock, [a, b]);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "one\ntwo\n");
	a.vault.userWrite("x.md", "zero\none\ntwo\n");
	await clock.advance(3_000); // B: a skip of x.md, the read deferred
	assert.equal(b.vault.textOf("x.md"), "one\ntwo\n");
	b.setOnline(false);
	const v = b.workspace.openFile("x.md");
	assert.ok(v);
	await clock.advance(1_000);
	assert.ok(v.isBound(), "bound offline");
	v.edit(4, 0, "typed\n");
	await clock.advance(500); // committed to storage; the editor's 2 s save has not run
	assert.equal(b.vault.textOf("x.md"), "one\ntwo\n");
	b.crashApp();
	net.relay.resetEpoch("sim-epoch-2" as VaultEpoch);
	await clock.advance(1_000);
	void b.restartApp();
	await clock.advance(5_000); // offline: x.md still waits for its read
	b.setOnline(true);
	await clock.advance(60_000);
	assert.equal(b.vrt?.vaultEpoch, "sim-epoch-2", "B migrated");
	for (const d of [a, b]) {
		const texts = [...d.vault.snapshot().values()].join("");
		assert.ok(texts.includes("typed"), `${d.name} keeps B's edit: ${JSON.stringify([...d.vault.snapshot()])}`);
	}
});

test("epoch reset after an offline edit and rename of the open note, the app dead before the save: the edit survives the migration", async () => {
	// Sim relay seed 134. B typed into x.md offline and renamed it; the app died before the editor's save, so the edit
	// was in B's storage only, and the observed rename in its memory. The restart's first pass (ns not ready: no
	// rename inference) marked x.md's file gone. The migration merged the docs with own unsent edits into their
	// files at their synced paths only (§c.12 step 5), found none for x.md, and dropped the outbox: gone.
	const { clock, net, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\ntwo\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "one\ntwo\n");
	b.setOnline(false);
	const v = b.workspace.openFile("x.md");
	assert.ok(v);
	await clock.advance(1_000);
	assert.ok(v.isBound(), "bound offline");
	v.edit(4, 0, "typed\n");
	await clock.advance(500); // committed to storage; the editor's 2 s save has not run
	assert.ok(b.vault.userRename("x.md", "y.md"));
	assert.equal(b.vault.textOf("y.md"), "one\ntwo\n");
	b.crashApp(); // before a pass recorded the rename
	net.relay.resetEpoch("sim-epoch-2" as VaultEpoch);
	await clock.advance(1_000);
	void b.restartApp();
	await clock.advance(5_000);
	b.setOnline(true);
	await clock.advance(60_000);
	assert.equal(b.vrt?.vaultEpoch, "sim-epoch-2", "B migrated");
	for (const d of [a, b]) assert.equal(d.vault.textOf("y.md"), "one\ntyped\ntwo\n", `${d.name} keeps B's edit at the renamed path`);
});

test("an identical duplicate create merged away while its note was typed into and the app died before the save: the edit survives", async () => {
	// Sim suite-1 seed 1 (after an epoch reset every device re-creates its files: identical creates merge, §c.5). B's
	// create of x.md held its body frames (onboarding) and B typed into the open note; the app died before the
	// editor's save. The create then folded merged into A's, and the held frames of a merged doc were deleted: the
	// rebind moved B's record to A's doc at its create, the disk still held the create text, and the edit was gone
	// with its only copy (I1).
	const { clock, net, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\ntwo\n");
	b.vault.userWrite("x.md", "one\ntwo\n");
	net.relay.pauseCommits(); // both creates in flight: A's commits first, B's folds merged into it
	await boot(clock, [a]);
	await clock.advance(2_000);
	await boot(clock, [b]);
	await clock.advance(5_000);
	const v = b.workspace.openFile("x.md");
	assert.ok(v);
	await clock.advance(1_000);
	assert.ok(v.isBound(), "bound");
	v.edit(4, 0, "typed\n");
	await clock.advance(300); // committed to storage (held behind the create); the editor's 2 s save has not run
	assert.equal(b.vault.textOf("x.md"), "one\ntwo\n");
	assert.ok(b.vrt!.log.c.outbox.all().some((r) => r.state === "held"), "the edit is held behind B's create");
	net.relay.resumeCommits();
	await clock.advance(1_000); // both creates folded, B's merged
	b.crashApp();
	await clock.advance(1_000);
	void b.restartApp();
	await clock.advance(60_000);
	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()], [["x.md", "one\ntyped\ntwo\n"]], `${d.name}`);
	for (const d of [a, b]) assert.equal(d.vrt?.log.c.outbox.size, 0, `${d.name}: the merged doc's frames went with its stream`);
});

test("offline delete, then a new note at the same path: a new doc, not a save over the old one", async () => {
	// Sim heavy seed 92. A's delete waited (own frames unacked, offline), and the new file at the path merged into
	// the old doc as a save: it followed the peer's rename of the old note, and the peer's edits to the old text
	// took parts of the new one. Online the delete goes out first and the new file is a doc of its own.
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "old note\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "old note\n");
	a.setOnline(false);
	a.vault.userWrite("x.md", "old note\nedited offline\n");
	await clock.advance(5_000); // merged: own frames in the outbox
	assert.ok(a.vault.userDelete("x.md"));
	await clock.advance(5_000); // the delete waits on the frames: decided (fileGone)
	a.vault.userWrite("x.md", "new note\n");
	assert.ok(b.vault.userRename("x.md", "y.md"));
	await clock.advance(5_000);
	a.setOnline(true);
	await clock.advance(30_000);
	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()], [["x.md", "new note\n"]], `${d.name}`);
	assert.equal(b.vault.trashed.length, 1, "B trashed the old note (moved to y.md)");
});

test("a rename of the open note that loses to a concurrent remote move: the views re-open on the file's new doc", async () => {
	// Sim DEV3 F seed 452. A renamed the open note offline while B moved it elsewhere, onto a path where A had a
	// file of its own. The doc took B's path (the file there merged into it as a conflict), A's renamed file became a
	// new doc, and the views stayed bound to the old doc: its merge never wrote the doc's file, waiting for an editor
	// save that could only ever reach the views' file.
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "body\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "body\n");
	const view = a.workspace.openFile("x.md");
	await clock.advance(1_000);
	assert.ok(view?.isBound(), "bound");
	a.setOnline(false);
	assert.ok(b.vault.userRename("x.md", "r2.md"));
	await clock.advance(5_000);
	b.vault.userWrite("r2.md", "body\nB edit\n");
	await clock.advance(5_000);
	assert.ok(a.vault.userRename("x.md", "r4.md"));
	a.vault.userWrite("r2.md", "other\n");
	a.crashEngine(); // the observed rename goes with it: no rename inference, x.md is just missing
	await clock.advance(5_000);
	a.setOnline(true);
	await clock.advance(30_000);
	const want = [...b.vault.snapshot().entries()].sort();
	assert.deepEqual([...a.vault.snapshot().entries()].sort(), want);
	assert.equal(a.vault.textOf("r2.md"), "body\nB edit\n");
	assert.ok(want.some(([, t]) => t === "other\n"), "A's own file at r2 is kept");
	assert.ok(view?.isBound(), "the view is bound again");
	assert.equal(view?.getText(), a.vault.textOf("r4.md"));
});

test("a bound doc whose views show another doc's file: the views re-open on that file, the doc's own file gets its edits", async () => {
	// The state the clock-set-back rename chain left (SIM-BLOB-STALE-DISK), built directly: the views of doc X follow
	// z.md, a file of another doc Z with the same text (X's file moved there), while X stays synced at x.md. An
	// editor save only ever reaches z.md, so X's merges waited for a save that never came (x.md stale for good) and
	// went into Z's file through the editor instead.
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "body\n");
	a.vault.userWrite("z.md", "body\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("x.md"), "body\n");
	const view = a.workspace.openFile("x.md");
	await clock.advance(1_000);
	assert.ok(view?.isBound(), "bound");
	const engine = a.vrt?.engine;
	assert.ok(view && engine);
	const x = [...engine.bound.byId.keys()];
	view.path = "z.md";
	engine.bound.followRename(pathKey("x.md"), "z.md", pathKey);
	a.vault.userWrite("w.md", "w\n"); // a pass ends with the state
	await clock.advance(5_000);
	b.vault.userWrite("x.md", "body\nB edit\n");
	await clock.advance(30_000);
	assert.equal(a.vault.textOf("x.md"), "body\nB edit\n", "X's file gets B's edit");
	assert.equal(a.vault.textOf("z.md"), "body\n", "Z's file is untouched");
	assert.ok(view.isBound(), "the view is bound again");
	assert.equal(x.length, 1);
	assert.deepEqual([...engine.bound.byId.values()].map((d) => [d.docId === x[0], d.path]), [[false, "z.md"]], "the view is on Z's doc");
	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()].sort(), [["w.md", "w\n"], ["x.md", "body\nB edit\n"], ["z.md", "body\n"]], d.name);
});

test("a stray bound editor with unsaved edits over another doc's file: neither the file nor the edits are lost", async () => {
	// As above, but the views moved onto z.md show other text than z.md holds, with an edit neither pushed nor saved.
	// Before: the bind of Z read the editor as an edit replacing Z's text (boundBody attachNow merged against Z's
	// own base) and Obsidian's autosave wrote it over z.md.
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "x body\n");
	a.vault.userWrite("z.md", "z body\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.textOf("z.md"), "z body\n");
	const view = a.workspace.openFile("x.md");
	await clock.advance(1_000);
	const engine = a.vrt?.engine;
	assert.ok(view && engine && view.isBound(), "bound");
	view.edit(view.getText().length, 0, "unsaved\n"); // not pushed yet, not saved (2 s debounce)
	assert.ok(view.isDirty());
	view.path = "z.md";
	engine.bound.followRename(pathKey("x.md"), "z.md", pathKey);
	a.vrt?.viewsMoved();
	await clock.advance(30_000);
	// The edit never reached X's replica (pushed after the retarget dropped the binding): the bind merges the editor
	// against X's text, and the edit, conflicting with Z's text, goes to a conflict copy of z.md.
	const files = [...a.vault.snapshot().entries()].sort();
	assert.deepEqual(files.filter(([p]) => !p.includes("conflict")), [["x.md", "x body\n"], ["z.md", "z body\n"]], "Z's file is kept");
	assert.deepEqual(files.filter(([p]) => p.includes("conflict")).map(([, t]) => t), ["x body\nunsaved\n"], "the unsaved edit is kept");
	assert.ok(view.isBound(), "the view is bound again");
	assert.equal(view.getText(), "z body\n");
	assert.deepEqual([...b.vault.snapshot().entries()].sort(), [...a.vault.snapshot().entries()].sort());
});

test("bound views on a file no doc is synced at re-open only when two pass ends saw it; a rename of the open note never does", async () => {
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "x body\n");
	await boot(clock, devs);
	await clock.advance(10_000);
	const view = a.workspace.openFile("x.md");
	await clock.advance(1_000);
	const rt = a.vrt;
	assert.ok(view && rt && view.isBound(), "bound");
	// A user rename of the open note: the views move one pass before the doc. Not re-opened.
	assert.ok(a.vault.userRename("x.md", "y.md"));
	await clock.advance(10_000);
	assert.equal(rt.stats.retargets, 0, "a rename of the open note keeps the binding");
	assert.ok(view.isBound());
	assert.equal(b.vault.textOf("y.md"), "x body\n");
	// Built directly: the views follow q.md, a path no doc is synced at, while the doc stays at y.md.
	view.path = "q.md";
	rt.engine.bound.followRename(pathKey("y.md"), "q.md", pathKey);
	rt.viewsMoved();
	assert.equal(rt.stats.retargets, 0, "no owner: not at once");
	const ends: number[] = []; // retargets made by each pass end's check
	const check = rt["retargetStrayViews"].bind(rt);
	rt["retargetStrayViews"] = (passEnd: boolean) => {
		const r0 = rt.stats.retargets;
		check(passEnd);
		if (passEnd) ends.push(rt.stats.retargets - r0);
	};
	a.vault.userWrite("w.md", "w\n"); // passes run
	await clock.advance(10_000);
	assert.deepEqual(ends.slice(0, 2), [0, 1], `re-opened at the second pass end, not the first (${ends.join(",")})`);
	assert.equal(rt.stats.retargets, 1);
	b.vault.userWrite("y.md", "x body\nB edit\n");
	await clock.advance(30_000);
	assert.equal(a.vault.textOf("y.md"), "x body\nB edit\n", "the doc's own file gets B's edit");
});

/** B's writes of `path` fail (EIO) while `broken()`; `heal()` ends it. */
function brokenWrites(dev: SimDevice, path: string): { heal(): void } {
	let broken = true;
	const write = dev.vault.write.bind(dev.vault);
	dev.vault.write = async (p, data, pre) => (broken && p === path ? { ok: false, reason: "io", current: null, message: "EIO (test)" } : write(p, data, pre));
	return { heal: () => void (broken = false) };
}

const BIG_ATTACH: EngineSettings = { ...SIM_SETTINGS, syncAttachments: true, maxAttachmentBytes: 16 * 1024 * 1024 };

test("a downloaded attachment whose disk write always fails: re-downloads back off per (doc, hash), bounded by its size over an hour", async () => {
	// Each failed write throws its bytes away (kept, they would pin the byte budget). Before: the pass retry's 60 s
	// cap was the only bound, ~1 GET a minute forever (6 GB an hour for a 100 MB attachment).
	const { clock, net, devs } = world({ settings: () => BIG_ATTACH });
	const [a, b] = pair(devs);
	brokenWrites(b, "img/p.png");
	const size = 6_000_000;
	a.vault.externalWrite("img/p.png", bytes(size, 1));
	await boot(clock, devs);
	await clock.advance(10_000);
	assert.equal(b.vault.hasFile("img/p.png"), false);
	const g0 = net.blobs.calls.get;
	await clock.advance(60 * 60_000);
	const gets = net.blobs.calls.get - g0;
	assert.ok(gets >= 3 && gets <= 8, `GETs in 1 h of failing writes: ${gets} (${((gets * size) / 1e6).toFixed(0)} MB)`);
	const g1 = net.blobs.calls.get;
	await clock.advance(60 * 60_000);
	const steady = net.blobs.calls.get - g1;
	assert.ok(steady <= 4, `GETs in the second hour: ${steady} (at the size-scaled cap)`);
	const q = b.vrt?.blobs.queued() ?? [];
	assert.deepEqual(q.map((t) => [t.direction, t.path, t.state]), [["down", "img/p.png", "write-failed"]], "the failing write stays visible as a pending blob");
	assert.ok(b.ui.notices.some((n) => n.code === "blob-write-failed"), "one notice names the failing write");
});

test("a downloaded attachment whose write kept failing lands within seconds of a vault change once the disk heals (a delete frees space)", async () => {
	const { clock, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	const disk = brokenWrites(b, "img/p.png");
	const want = bytes(5_000, 1);
	a.vault.externalWrite("img/p.png", want);
	a.vault.externalWrite("junk.md", "junk\n");
	await boot(clock, devs);
	await clock.advance(30 * 60_000);
	assert.equal(b.vault.hasFile("img/p.png"), false);
	disk.heal();
	b.vault.userDelete("junk.md");
	await clock.advance(5_000);
	await same(a, b, "img/p.png", want);
	assert.deepEqual(b.vrt?.blobs.queued() ?? [], [], "nothing left queued");
});

test("a downloaded attachment whose write kept failing lands within its backoff once the disk heals with no vault event", async () => {
	const { clock, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	const disk = brokenWrites(b, "img/p.png");
	const want = bytes(5_000, 1);
	a.vault.externalWrite("img/p.png", want);
	await boot(clock, devs);
	await clock.advance(30 * 60_000);
	disk.heal();
	await clock.advance(10 * 60_000 + 5_000);
	await same(a, b, "img/p.png", want);
});

test("a transient write failure of a downloaded attachment retries at once (no added latency)", async () => {
	const { clock, net, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	let fails = 1;
	const write = b.vault.write.bind(b.vault);
	b.vault.write = async (p, data, pre) => (p === "img/p.png" && fails-- > 0 ? { ok: false, reason: "io", current: null, message: "EIO (test)" } : write(p, data, pre));
	const want = bytes(5_000, 1);
	a.vault.externalWrite("img/p.png", want);
	await boot(clock, devs);
	await clock.advance(10_000);
	await same(a, b, "img/p.png", want);
	assert.equal(net.blobs.calls.get, 2, "the failed write's download, and one more");
});

test("a live row lost on an open socket (nothing follows it): the first idle probe is a VAULT_PING and the gap feed reads the row within ~idleMs + gapMs", async () => {
	// Soak seed 935329097. Keepalive mode checks the head every 10th idle probe (~10 min); the first probe after
	// stream data is a VAULT_PING (wsRelay IdleProbes). Production maintenance and gap timers.
	const { clock, net, devs } = world({ tuning: { maintenanceMs: 1_000, maintenanceIdleMaxMs: 30_000, gapMs: 5_000 } });
	const [a, b] = pair(devs);
	a.vault.userWrite("notes/x.md", "one\n");
	await boot(clock, devs);
	await clock.advance(20_000);
	assert.equal(b.vault.textOf("notes/x.md"), "one\n");
	await clock.advance(5 * 60_000); // idle: maintenance backed off, keepalives only
	const cursor = () => b.vrt?.log.c.repo.cursor.vaultSeq ?? -1;
	const commit = async (what: () => void, label: string) => {
		const head0 = net.relay.head();
		what();
		assert.ok(await clock.runUntil(() => net.relay.head() > head0 && (a.vrt?.log.isIdle() ?? false), 60_000), label);
	};
	// ns rows only: COMMITTED to B, no PROVISIONAL that would settle by other means.
	await commit(() => a.vault.userRename("notes/x.md", "notes/y.md"), "A's first rename committed");
	assert.ok(await clock.runUntil(() => cursor() >= net.relay.head(), 10_000), "B read it live");
	net.relay.loseSends(b.deviceId, 1_000); // every later COMMITTED / COMMIT_NOTICE to B
	await commit(() => a.vault.userRename("notes/y.md", "notes/z.md"), "A's second rename committed");
	const t0 = clock.monotonic();
	await clock.advance(5_000);
	assert.ok(cursor() < net.relay.head(), `B's cursor ${cursor()} behind head ${net.relay.head()}: nothing showed the lost row`);
	assert.equal(net.relay.headCheckOwed(b.deviceId), true, "a row arrived since the last pong: the next idle probe is a VAULT_PING");
	await clock.runUntil(() => cursor() >= net.relay.head(), 15 * 60_000);
	const took = clock.monotonic() - t0;
	assert.equal(cursor(), net.relay.head(), "B caught up");
	assert.ok(await clock.runUntil(() => b.vault.textOf("notes/z.md") === "one\n", 10_000), "B renamed the file");
	assert.ok(took <= 60_000 + 5_000 + 5_000, `caught up ${took} ms after A's last row (idle probe 60 s after B's last message, gap 5 s)`);
});
