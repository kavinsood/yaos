/**
 * Full-client e2e scenarios 5-8 (fullClients.ts): .obsidian settings sync, offline edits + reconnect,
 * relay process restart (local hosts only), fresh device bootstrap and restart from IndexedDB.
 */
import { conflictCopies, converge, enc, randomBytes, sleep, waitFor } from "./fullCheck";
import type { FullClient, FullCtx } from "./fullKit";
import { pairDevice } from "./onboard";

const json = (v: unknown) => enc(JSON.stringify(v, null, 2));
const noConflicts = (x: FullCtx) => x.R.check("no conflict copies", x.clients.every((c) => conflictCopies(c).length === 0),
	Object.fromEntries(x.clients.map((c) => [c.name, conflictCopies(c)])));

async function settle(x: FullCtx, metric: string | null, timeoutMs = 60_000): Promise<number> {
	const ms = await converge(x.clients, timeoutMs);
	if (metric) x.R.record(metric, ms);
	x.R.check("converged: files, synced config and ns fold byte-identical; all clients clean", true, { ms: Math.round(ms) });
	return ms;
}

/** The same community plugin installed and enabled on a device (before it starts). */
export function installPlugin(c: FullClient): void {
	c.configDir.files.set("community-plugins.json", json(["e2e-plugin"]));
	c.configDir.files.set("plugins/e2e-plugin/manifest.json", json({ id: "e2e-plugin", name: "E2E", version: "1.0.0" }));
	c.configDir.files.set("plugins/e2e-plugin/main.js", enc("module.exports = {};\n"));
}

async function cfgReaches(x: FullCtx, from: FullClient, files: Record<string, Uint8Array | null>, metric: string): Promise<void> {
	for (const [p, b] of Object.entries(files)) {
		if (b) await from.configDir.writeBytes(p, b);
		else await from.configDir.remove(p);
	}
	const t0 = performance.now();
	await from.runtime.command({ t: "reconcileNow" });
	const peers = x.clients.filter((c) => c !== from);
	const same = (c: FullClient, p: string, b: Uint8Array | null) => {
		const have = c.configDir.files.get(p) ?? null;
		return b === null ? have === null : have !== null && Buffer.compare(have, b) === 0;
	};
	const ms = await Promise.all(peers.map((c) => waitFor(() => Object.entries(files).every(([p, b]) => same(c, p, b)), `settings on ${c.name}`, 60_000, t0, 20)));
	for (const v of ms) x.R.record(metric, v);
}

/** 5. Synced .obsidian files: json keys, snippets, plugin data.json; never-synced files stay local. */
export async function sSettings(x: FullCtx): Promise<void> {
	const [a, b] = x.clients as [FullClient, FullClient, FullClient];
	await cfgReaches(x, a, {
		"app.json": json({ alwaysUpdateLinks: true, e2eKey: "v1" }),
		"snippets/e2e.css": enc(".e2e { color: red; }\n"),
		"plugins/e2e-plugin/data.json": json({ count: 1, mode: "full" }),
	}, "settings_to_peer_ms");
	await a.configDir.writeBytes("workspace.json", json({ main: "local only" }));
	await a.configDir.writeBytes("plugins/yaos/data.json", json({ secretish: "never synced" }));
	await cfgReaches(x, a, { "app.json": json({ alwaysUpdateLinks: true, e2eKey: "v2" }) }, "settings_to_peer_ms");
	await cfgReaches(x, b, { "appearance.json": json({ accentColor: "#ff0000", baseFontSize: 16 }), "plugins/e2e-plugin/data.json": json({ count: 2, mode: "full" }) }, "settings_to_peer_ms");
	await cfgReaches(x, b, { "snippets/e2e.css": null }, "settings_to_peer_ms");
	await settle(x, null);
	x.R.check("workspace.json and plugins/yaos never synced", x.clients.slice(1).every((c) => !c.configDir.files.has("workspace.json") && !c.configDir.files.has("plugins/yaos/data.json")));
}

/** 6. A and B offline (connect fails, sessions drop); edits on all three; reconnect; converge and merge. */
export async function sOffline(x: FullCtx): Promise<void> {
	const [a, b, c] = x.clients as [FullClient, FullClient, FullClient];
	const one = "notes/one.md";
	await settle(x, null);
	a.setOnline(false);
	b.setOnline(false);
	await waitFor(() => [a, b].every((d) => d.vrt?.status().relay.connected === false), "a, b disconnected", 10_000);
	const base = (a.vault.textOf(one) ?? "").split("\n");
	const ea = [...base];
	ea[2] = `${ea[2]} (offline a)`;
	const eb = [...base];
	eb[6] = `${eb[6]} (offline b)`;
	a.vault.externalWrite(one, ea.join("\n"));
	a.vault.userWrite("offline/a-new.md", "made offline on a\n");
	a.vault.userRename("burst/n00.md", "offline/n00-renamed.md");
	b.vault.externalWrite(one, eb.join("\n"));
	b.vault.userWrite("offline/b-new.md", "made offline on b\n");
	b.vault.userDelete("burst/n01.md");
	c.vault.userWrite("offline/c-online.md", "made on c while a and b were offline\n");
	c.vault.userWrite("notes/two.md", `${c.vault.textOf("notes/two.md")}c online edit\n`);
	await sleep(3_000);
	x.R.check("offline devices received nothing", !a.vault.hasFile("offline/c-online.md") && !b.vault.hasFile("offline/a-new.md") && !c.vault.hasFile("offline/a-new.md"));
	const t0 = performance.now();
	a.setOnline(true);
	b.setOnline(true);
	await settle(x, null, 90_000);
	x.R.record("reconnect_converge_ms", performance.now() - t0);
	const m = a.vault.textOf(one) ?? "";
	x.R.check("offline edits to the same file merged", m.includes("(offline a)") && m.includes("(offline b)"), { text: m });
	x.R.check("offline creates, rename and delete applied everywhere", x.clients.every((d) => d.vault.hasFile("offline/a-new.md") && d.vault.hasFile("offline/b-new.md")
		&& d.vault.hasFile("offline/c-online.md") && d.vault.hasFile("offline/n00-renamed.md") && !d.vault.hasFile("burst/n00.md") && !d.vault.hasFile("burst/n01.md")));
	noConflicts(x);
}

/** 7. Relay process restart (state kept, same port): clients reconnect on their own; outage edits arrive. */
export async function sRelayRestart(x: FullCtx): Promise<void> {
	const [a, b] = x.clients as [FullClient, FullClient, FullClient];
	if (!x.relay) {
		x.R.check("relay restart skipped (host is not local)", true);
		return;
	}
	await settle(x, null);
	const tDown = performance.now();
	x.relay.stop();
	await waitFor(() => x.clients.every((d) => d.vrt?.status().relay.connected === false), "clients see the relay down", 30_000);
	a.vault.userWrite("notes/two.md", `${a.vault.textOf("notes/two.md")}edit during relay outage\n`);
	b.vault.userWrite("outage/b.md", "created during relay outage\n");
	a.vault.externalWrite("outage/blob.bin", randomBytes(64 * 1024, 77));
	await sleep(1_000);
	x.relay.start();
	const tUp = performance.now();
	x.R.record("relay_outage_ms", tUp - tDown);
	await waitFor(() => x.clients.every((d) => d.vrt?.status().relay.connected === true), "clients reconnected", 120_000);
	x.R.record("relay_restart_reconnect_ms", performance.now() - tUp);
	await settle(x, null, 120_000);
	x.R.record("relay_restart_converge_ms", performance.now() - tUp);
	x.R.check("outage edits reached every client", x.clients.every((d) => (d.vault.textOf("notes/two.md") ?? "").includes("edit during relay outage")
		&& d.vault.hasFile("outage/b.md") && d.vault.hasFile("outage/blob.bin")));
	noConflicts(x);
}

/** 8. A new device with an empty vault receives everything; a client restarts from its IndexedDB. */
export async function sBootstrapRestart(x: FullCtx): Promise<void> {
	const [a, b] = x.clients as [FullClient, FullClient, FullClient];
	await settle(x, null);
	const dev = await pairDevice(x.vault, "D3");
	const d = x.newClient("d", dev);
	const t0 = performance.now();
	await d.start();
	x.clients.push(d);
	await settle(x, null, 180_000);
	x.R.record("fresh_bootstrap_ms", performance.now() - t0);
	x.R.check("fresh device has every file and synced setting", d.vault.snapshot().size === a.vault.snapshot().size && d.configDir.files.has("app.json"),
		{ files: d.vault.snapshot().size, expected: a.vault.snapshot().size });

	// Restart b from its IndexedDB; a edits while b is down; b reopens a view and types after the restart.
	const vb0 = b.workspace.openFile("notes/one.md")!;
	await waitFor(() => vb0.isBound(), "b view bound", 15_000);
	const cursor = b.vrt?.log.c.repo.cursor.vaultSeq ?? 0;
	const writes = b.vault.calls.write;
	const starts = b.cursorAtStart.length;
	await b.stop();
	x.clients.splice(x.clients.indexOf(b), 1);
	a.vault.userWrite("restart/while-b-down.md", "written while b was down\n");
	a.vault.userWrite("notes/one.md", `${a.vault.textOf("notes/one.md")}edit while b was down\n`);
	await converge(x.clients, 60_000);
	const tr = performance.now();
	await b.restart();
	x.clients.splice(1, 0, b);
	await settle(x, null, 90_000);
	x.R.record("restart_from_idb_converge_ms", performance.now() - tr);
	const resumed = b.cursorAtStart[starts] ?? 0;
	x.R.check("restart resumed from IndexedDB (cursor kept)", resumed >= cursor && cursor > 0, { before: cursor, atRestart: resumed });
	x.R.check("restart rewrote only what changed while down", b.vault.calls.write - writes <= 2, { writes: b.vault.calls.write - writes });
	const vb = b.workspace.openFile("notes/one.md")!;
	await waitFor(() => vb.isBound(), "b view bound after restart", 15_000);
	const t1 = performance.now();
	vb.edit(vb.buffer.length, 0, "typed after restart");
	await Promise.all(x.clients.filter((c) => c !== b).map((c) => waitFor(() => (c.vault.textOf("notes/one.md") ?? "").includes("typed after restart"), `typing on ${c.name}`, 30_000, t1)));
	await b.workspace.closeView(vb.viewId);
	await settle(x, null);
	noConflicts(x);
}
