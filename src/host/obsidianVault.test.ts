import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiskFingerprint, VaultPath } from "../core/types";
import type { VaultEvent } from "../ports/vault";
import { simHashPort } from "../sim/__standins__/sha256";
import { FakeObsidianVault } from "../sim/fakeObsidian";
import { createHasher, utf8 } from "./hashing";
import { ObsidianVault } from "./obsidianVault";

const hasher = createHasher(simHashPort());
const P = (p: string) => p as VaultPath;
const fp = (t: string) => hasher.fingerprint(utf8(t));

function setup(insensitive = false) {
	const fake = new FakeObsidianVault(insensitive);
	const vault = new ObsidianVault(fake, hasher, insensitive);
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
	assert.equal(good.ok && good.fingerprint, await fp("two"));
	assert.equal(fake.text("n/a.md"), "two");
	fake.put("n/a.md", "﻿two\r\n");
	const h = await hasher.contentHash("n/a.md", utf8("two\n"));
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
	const pre = { t: "fingerprint" as const, fingerprint: await hasher.fingerprint(new Uint8Array([1, 2, 3])) };
	const r = await vault.write(P("img.png"), new Uint8Array([7]), pre);
	assert.equal(r.ok === false && r.reason, "precondition");
	assert.deepEqual([...(fake.files.get("img.png")?.bytes ?? [])], [9, 9, 9, 9]);
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
