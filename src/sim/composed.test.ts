/**
 * Composed full-client scenarios on the sim (host + protocol + engine + SimRelay):
 * attachments over x: chunk streams, settings sync, IndexedDB loss with mirror
 * recovery, and a relay epoch reset (§c.12) migrating both devices.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultEpoch } from "../core/types";
import type { EngineSettings } from "../protocol/messages";
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

test("attachments ride x: chunk streams: create, multi-chunk update, rename and delete converge byte-identical", async () => {
	const { clock, devs } = world({ settings: () => ATTACH });
	const [a, b] = pair(devs);
	const small = bytes(5_000, 1);
	a.vault.externalWrite("img/p.png", small);
	await boot(clock, devs);
	await clock.advance(10_000);
	await same(a, b, "img/p.png", small);

	// > 1 chunk (768 KiB chunks).
	const big = bytes(1_700_000, 2);
	a.vault.externalWrite("img/p.png", big);
	await clock.advance(20_000);
	await same(a, b, "img/p.png", big);

	assert.ok(b.vault.userRename("img/p.png", "img/q.png"));
	await clock.advance(10_000);
	assert.equal(a.vault.hasFile("img/p.png"), false, "rename reached A");
	await same(a, b, "img/q.png", big);

	assert.ok(a.vault.userDelete("img/q.png"));
	await clock.advance(10_000);
	assert.equal(b.vault.hasFile("img/q.png"), false, "delete reached B");
	assert.ok(b.vault.trashed.some((r) => r.path === "img/q.png"), "B trashed it (never a hard delete)");
	assert.equal(a.vault.snapshot().size + b.vault.snapshot().size, 0);
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

test("IndexedDB evicted while the app is down: restart recovers from the mirror, no duplicates, offline edits on both sides survive", async () => {
	const { clock, devs } = world();
	const [a, b] = pair(devs);
	a.vault.userWrite("x.md", "one\n");
	a.vault.userWrite("y.md", "why\n");
	await boot(clock, devs);
	await clock.advance(5_000);
	assert.equal(b.vault.textOf("x.md"), "one\n");
	await clock.advance(5_000); // mirrors written

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

	net.relay.resetEpoch("sim-epoch-2" as VaultEpoch);
	a.vault.externalWrite("x.md", "one\nduring reset\n");
	await clock.advance(30_000);
	b.vault.userWrite("w.md", "after\n");
	await clock.advance(10_000);

	const want = [["w.md", "after\n"], ["x.md", "one\nduring reset\n"], ["y.md", "two\n"]];
	for (const d of [a, b]) assert.deepEqual([...d.vault.snapshot().entries()].sort(), want, `${d.name}`);
	// A's re-create of x.md lost the race to B's and merged into it (3-way against the old epoch's base) instead of
	// a loser rename. B may have materialized the loser before A deleted it: that transient copy is in B's trash.
	assert.deepEqual(a.vault.trashed, []);
	for (const t of b.vault.trashed) assert.deepEqual([t.path, t.text], ["x (2).md", "one\nduring reset\n"]);
	const o = await net.oracle();
	assert.equal(o.error, null);
	assert.deepEqual(o.docs.map((x) => [x.path, x.text]).sort(), want, "the new epoch holds the whole vault");
});
