import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintRef, markdownHashRef } from "../core/hash/testkit/hashRef";
import { utf8Encode } from "../core/hash/utf8";
import type { DiskFingerprint, VaultPath } from "../core/types";
import type { VaultEvent } from "../ports/vault";
import { simHashOracle } from "../sim/hash";
import { FakeObsidianVault } from "../sim/fakeObsidian";
import type { HashOracle } from "./hashOracle";
import { followObsidianSystemTrash, ObsidianVault } from "./obsidianVault";

const P = (p: string) => p as VaultPath;
const utf8 = utf8Encode;
/** Test-side reference hashing (core, in-process); the vault itself only asks its HashOracle. */
const fp = (t: string) => fingerprintRef(utf8(t));

function setup(insensitive = false) {
	const fake = new FakeObsidianVault(insensitive);
	const vault = new ObsidianVault(fake, simHashOracle(), insensitive);
	return { fake, vault };
}

test("write honours absent / fingerprint / hash / any and never writes on a failed precondition", async () => {
	const { fake, vault } = setup();
	assert.equal((await vault.write(P("n/a.md"), "one", { t: "absent" })).ok, true);
	assert.equal(fake.text("n/a.md"), "one");
	assert.ok(fake.calls.includes("createFolder n"));
	const again = await vault.write(P("n/a.md"), "two", { t: "absent" });
	assert.equal(again.ok === false && again.reason, "precondition");
	const stale = await vault.write(P("n/a.md"), "two", { t: "fingerprint", fingerprint: (await fp("nope")) as DiskFingerprint });
	assert.equal(stale.ok === false && stale.reason, "precondition");
	assert.equal(fake.text("n/a.md"), "one");
	const good = await vault.write(P("n/a.md"), "two", { t: "fingerprint", fingerprint: await fp("one") });
	assert.equal(good.ok, true);
	assert.equal(fake.text("n/a.md"), "two");
	fake.put("n/a.md", "\uFEFFtwo\r\n");
	const h = markdownHashRef("two\n");
	const viaHash = await vault.write(P("n/a.md"), "three", { t: "hash", hash: h });
	assert.equal(viaHash.ok, true, "logical hash ignores BOM and CRLF");
	assert.equal((await vault.write(P("n/a.md"), "four", { t: "any" })).ok, true);
	assert.equal(fake.text("n/a.md"), "four");
	const missing = await vault.write(P("n/b.md"), "x", { t: "fingerprint", fingerprint: await fp("") });
	assert.equal(missing.ok === false && missing.reason, "precondition");
	assert.equal(fake.text("n/b.md"), null);
});

test("text CAS aborts when the file changes between the check and the commit", async () => {
	const { fake, vault } = setup();
	fake.put("a.md", "base");
	fake.afterReadBinary = (p) => {
		fake.afterReadBinary = null;
		fake.put(p, "user typed meanwhile");
	};
	const r = await vault.write(P("a.md"), "sync", { t: "fingerprint", fingerprint: await fp("base") });
	assert.equal(r.ok === false && r.reason, "precondition");
	assert.equal(fake.text("a.md"), "user typed meanwhile");
});

test("binary CAS rechecks the stat before modifyBinary", async () => {
	const { fake, vault } = setup();
	fake.put("img.png", new Uint8Array([1, 2, 3]));
	fake.afterReadBinary = (p) => {
		fake.afterReadBinary = null;
		fake.put(p, new Uint8Array([9, 9, 9, 9]));
	};
	const pre = { t: "fingerprint" as const, fingerprint: fingerprintRef(new Uint8Array([1, 2, 3])) };
	const r = await vault.write(P("img.png"), new Uint8Array([7]), pre);
	assert.equal(r.ok === false && r.reason, "precondition");
	assert.deepEqual([...(fake.files.get("img.png")?.bytes ?? [])], [9, 9, 9, 9]);
});

/** simHashOracle that runs `after` once the engine has answered (between the oracle read and the write). */
function oracleThen(after: () => void): HashOracle {
	const inner = simHashOracle();
	return { hash: async (items) => { const v = await inner.hash(items); after(); return v; } };
}
const bytesOf = (fake: FakeObsidianVault, p: string) => fake.files.get(p)!.bytes;
/** An external write Obsidian has not reflected in TFile.stat yet (watcher lag, same size and mtime). */
const silently = (fake: FakeObsidianVault, p: string, t: string) => { fake.files.get(p)!.bytes = utf8(t); };

test("race (i): a stat-visible change after the engine answered fails the precondition, text and binary", async () => {
	const fake = new FakeObsidianVault();
	fake.put("a.md", "base");
	fake.put("b.png", new Uint8Array([1, 2]));
	let change = () => fake.put("a.md", "BASE"); // same length: only the stat recheck can see it
	const vault = new ObsidianVault(fake, oracleThen(() => change()), false);
	const r = await vault.write(P("a.md"), "sync", { t: "fingerprint", fingerprint: fp("base") });
	assert.equal(r.ok === false && r.reason, "precondition");
	assert.equal(fake.text("a.md"), "BASE");
	assert.ok(!fake.calls.includes("process a.md"), "never reaches vault.process");
	change = () => fake.put("b.png", new Uint8Array([3, 4]));
	const b = await vault.write(P("b.png"), new Uint8Array([7]), { t: "fingerprint", fingerprint: fingerprintRef(new Uint8Array([1, 2])) });
	assert.equal(b.ok === false && b.reason, "precondition");
	assert.deepEqual([...bytesOf(fake, "b.png")], [3, 4]);
	change = () => fake.put("a.md", "BASE!");
	const t = await vault.trash("a.md", "system-trash", { t: "fingerprint", fingerprint: fp("BASE") });
	assert.equal(t.ok === false && t.reason, "precondition");
	change = () => fake.put("a.md", "base");
	const m = await vault.rename("a.md", P("moved.md"), { t: "fingerprint", fingerprint: fp("BASE!") });
	assert.equal(m.ok === false && m.reason, "precondition");
	assert.equal(fake.text("a.md"), "base");
});

test("race (ii): a length-changing change after the stat recheck is caught by the process length guard", async () => {
	const { fake, vault } = setup();
	fake.put("a.md", "\uFEFFbase\r\n"); // BOM kept on both sides: textLength 7 = what process hands the callback
	fake.beforeProcess = (p) => silently(fake, p, "\uFEFFbase\r\nuser line\r\n");
	const r = await vault.write(P("a.md"), "sync", { t: "hash", hash: markdownHashRef("base\n") });
	assert.equal(r.ok === false && r.reason, "precondition");
	assert.equal(fake.text("a.md"), "\uFEFFbase\r\nuser line\r\n");
	fake.beforeProcess = null;
	fake.put("a.md", "\uFEFFbase\r\n");
	assert.equal((await vault.write(P("a.md"), "sync", { t: "hash", hash: markdownHashRef("base\n") })).ok, true, "unchanged BOM file passes the guard");
});

test("race (iii), the accepted gap: a same-length change not visible in stat is overwritten", async () => {
	// DESIGN §f.2 trade-off (obsidianVault.ts header): main never compares full contents, so an external
	// edit that keeps the UTF-16 length and is not yet in TFile.stat when we recheck is lost. Text: it
	// lands between the recheck and process's read; binary: anywhere after the read before modifyBinary.
	const { fake, vault } = setup();
	fake.put("a.md", "base");
	fake.beforeProcess = (p) => silently(fake, p, "BASE");
	assert.equal((await vault.write(P("a.md"), "sync", { t: "fingerprint", fingerprint: fp("base") })).ok, true);
	assert.equal(fake.text("a.md"), "sync");
	fake.put("b.png", new Uint8Array([1, 2]));
	const bin = new ObsidianVault(fake, oracleThen(() => { bytesOf(fake, "b.png").set([3, 4]); }), false);
	assert.equal((await bin.write(P("b.png"), new Uint8Array([7]), { t: "fingerprint", fingerprint: fingerprintRef(new Uint8Array([1, 2])) })).ok, true);
	assert.deepEqual([...bytesOf(fake, "b.png")], [7]);
});

test("no engine: checked ops report io and write nothing; reads skip Obsidian's main-thread md decode", async () => {
	const fake = new FakeObsidianVault();
	fake.put("a.md", "base");
	fake.readBinary = () => Promise.reject(new Error("vault.readBinary decodes .md on main: not used"));
	const down: HashOracle = { hash: () => Promise.reject(new Error("engine not running")) };
	const vault = new ObsidianVault(fake, down, false);
	const pre = { t: "fingerprint" as const, fingerprint: fp("base") };
	const w = await vault.write(P("a.md"), "sync", pre);
	assert.equal(w.ok === false && w.reason, "io");
	assert.equal((await vault.rename("a.md", P("b.md"), pre)).ok === false, true);
	assert.equal((await vault.trash("a.md", "system-trash", pre)).ok === false, true);
	assert.equal(fake.text("a.md"), "base");
	assert.deepEqual([...(await vault.readBytes("a.md"))], [...utf8("base")]);
	const live = new ObsidianVault(fake, simHashOracle(), false);
	assert.equal((await live.write(P("a.md"), "sync", pre)).ok, true);
});

test("parent-is-file, invalid path, folder target", async () => {
	const { fake, vault } = setup();
	fake.put("x", "file named x");
	const r = await vault.write(P("x/y.md"), "z", { t: "any" });
	assert.equal(r.ok === false && r.reason, "parent-is-file");
	const bad = await vault.write(P("../evil.md"), "z", { t: "any" });
	assert.equal(bad.ok === false && bad.reason, "invalid-path");
	await fake.createFolder("dir");
	const dir = await vault.write(P("dir"), "z", { t: "any" });
	assert.equal(dir.ok === false && dir.reason, "io");
});

test("rename goes through vault.rename only, checks target and precondition; case-only rename is two-step", async () => {
	const { fake, vault } = setup(true);
	fake.put("a.md", "A");
	fake.put("b.md", "B");
	const taken = await vault.rename("a.md", P("B.md"), { t: "any" });
	assert.equal(taken.ok === false && taken.reason, "target-exists");
	const stale = await vault.rename("a.md", P("c/d.md"), { t: "fingerprint", fingerprint: await fp("not A") });
	assert.equal(stale.ok === false && stale.reason, "precondition");
	const ok = await vault.rename("a.md", P("c/d.md"), { t: "fingerprint", fingerprint: await fp("A") });
	assert.equal(ok.ok && ok.stat.path, "c/d.md");
	const caseOnly = await vault.rename("b.md", P("B.md"), { t: "any" });
	assert.equal(caseOnly.ok && caseOnly.stat.path, "B.md");
	const missing = await vault.rename("zzz.md", P("q.md"), { t: "any" });
	assert.equal(missing.ok === false && missing.reason, "source-missing");
	const renames = fake.calls.filter((c) => c.startsWith("rename "));
	assert.deepEqual(renames, ["rename a.md c/d.md", "rename b.md b.md.yaos-case-1", "rename b.md.yaos-case-1 B.md"]);
	assert.equal(fake.calls.some((c) => c.startsWith("delete") || c.startsWith("adapter.")), false);
});

test("trash only, with precondition; removeEmptyFolder only removes empty folders", async () => {
	const { fake, vault } = setup();
	fake.put("t/a.md", "A");
	await fake.createFolder("t");
	const stale = await vault.trash("t/a.md", "obsidian-trash", { t: "fingerprint", fingerprint: await fp("other") });
	assert.equal(stale.ok === false && stale.reason, "precondition");
	await vault.removeEmptyFolder(P("t"));
	assert.ok(fake.folders.has("t"), "non-empty folder kept");
	const ok = await vault.trash("t/a.md", "system-trash", { t: "fingerprint", fingerprint: await fp("A") });
	assert.equal(ok.ok, true);
	assert.deepEqual(fake.trashed, [{ path: "t/a.md", system: true }]);
	await vault.removeEmptyFolder(P("t"));
	assert.equal(fake.folders.has("t"), false);
	assert.deepEqual(fake.calls.filter((c) => c.startsWith("delete")), ["delete t force=false"]);
});

test("follow-obsidian reads trashOption from <configDir>/app.json at each delete; none is never a permanent delete", async () => {
	assert.equal(followObsidianSystemTrash(null), true, "absent: Obsidian's default (system)");
	assert.equal(followObsidianSystemTrash(`{"trashOption":"system"}`), true);
	assert.equal(followObsidianSystemTrash(`{"trashOption":"local"}`), false);
	assert.equal(followObsidianSystemTrash(`{"trashOption":"none"}`), false, "permanently delete: .trash folder");
	for (const bad of ["{not json", "null", "[]", `"local"`, `{"trashOption":42}`, `{"trashOption":"later"}`]) assert.equal(followObsidianSystemTrash(bad), true, bad);

	const { fake, vault } = setup();
	const del = async (name: string, appJson: string | null, mode: "follow-obsidian" | "obsidian-trash" = "follow-obsidian") => {
		if (appJson === null) fake.raw.delete(".obsidian/app.json");
		else fake.raw.set(".obsidian/app.json", utf8(appJson));
		fake.put(name, name);
		assert.equal((await vault.trash(name, mode, { t: "any" })).ok, true, name);
	};
	await del("absent.md", null);
	await del("system.md", `{"trashOption":"system"}`);
	await del("local.md", `{"promptDelete":false,"trashOption":"local"}`);
	await del("none.md", `{"trashOption":"none"}`);
	await del("bad.md", "{not json");
	await del("explicit.md", `{"trashOption":"system"}`, "obsidian-trash");
	assert.deepEqual(fake.trashed, [
		{ path: "absent.md", system: true }, { path: "system.md", system: true }, { path: "local.md", system: false },
		{ path: "none.md", system: false }, { path: "bad.md", system: true }, { path: "explicit.md", system: false },
	]);
	assert.equal(fake.calls.some((c) => c.startsWith("delete")), false, "never vault.delete");
});

test("events map files only and unsubscribe cleanly", async () => {
	const { fake, vault } = setup();
	const seen: VaultEvent[] = [];
	const off = vault.onEvent((e) => seen.push(e));
	fake.put("a.md", "1");
	fake.put("a.md", "2");
	await fake.rename(fake.getAbstractFileByPath("a.md") as never, "b.md");
	await fake.trash(fake.getAbstractFileByPath("b.md") as never, false);
	await fake.createFolder("folder");
	off();
	fake.put("c.md", "3");
	assert.deepEqual(seen.map((e) => e.t), ["create", "modify", "rename", "delete"]);
	assert.deepEqual((await vault.list()).map((s) => s.path), ["c.md"]);
	assert.equal(seen[2]?.t === "rename" && seen[2].from, "a.md");
});
