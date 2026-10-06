import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContentHash, DiskFingerprint, DocId } from "../core/types";
import type { DiskOp, DiskOpResult, Lane } from "../protocol/messages";
import type { WritePrecondition } from "../ports/vault";
import { DiskExecutor } from "./diskExecutor";
import { createHasher, utf8 } from "./hashing";
import { VirtualClock } from "../sim/clock";
import { simHashPort } from "../sim/hash";
import { SimConfigDir, SimVault, type CaseProfile } from "../sim/vault";

function setup(profile: CaseProfile = "case-insensitive", bound: Set<string> = new Set()) {
	const clock = new VirtualClock();
	const hasher = createHasher(simHashPort());
	const vault = new SimVault({ clock, hasher, profile });
	const configDir = new SimConfigDir(clock);
	const exec = new DiskExecutor({ vault, configDir, clock, hasher, isBoundPath: (p) => bound.has(p), budgets: () => ({ mainSliceMs: 8 }) });
	return { clock, hasher, vault, configDir, exec, bound };
}

let opId = 1;
const w = (path: string, text: string, precondition: WritePrecondition, extra: Partial<{ docId: DocId | null; purpose: "materialize" | "merge" | "conflict-copy" | "restore" | "settings"; area: "vault" | "config" }> = {}): DiskOp => ({
	t: "write", opId: opId++, area: extra.area ?? "vault", path, data: { t: "text", text }, precondition, docId: extra.docId ?? null, purpose: extra.purpose ?? "materialize",
});
const ANY: WritePrecondition = { t: "any" };
const ABSENT: WritePrecondition = { t: "absent" };

function outcomeOk(r: DiskOpResult | undefined): boolean {
	assert.ok(r);
	if (r.t === "write" || r.t === "rename" || r.t === "trash") return r.outcome.ok;
	if (r.t === "removeEmptyFolder") return r.ok;
	return false;
}

test("diskExecutor: every WritePrecondition passes or fails without writing", async () => {
	const { vault, exec, hasher } = setup();
	vault.userWrite("a.md", "one\r\n");
	const fp = await hasher.fingerprint(utf8("one\r\n"));
	const lfHash = await hasher.contentHash("a.md", utf8("one\n"));
	const historyBefore = vault.history.length;

	// One batch each: inside a batch, ops on the same path after a failure are skipped.
	const res: DiskOpResult[] = [];
	for (const op of [
		w("a.md", "x", ABSENT),
		w("a.md", "x", { t: "fingerprint", fingerprint: "00".repeat(32) as DiskFingerprint }),
		w("a.md", "x", { t: "hash", hash: "11".repeat(32) as ContentHash }),
		w("new.md", "x", { t: "fingerprint", fingerprint: fp }),
	]) res.push(...(await exec.run(3, [op])));
	assert.deepEqual(res.map((r) => r.t === "write" && !r.outcome.ok && r.outcome.reason), ["precondition", "precondition", "precondition", "precondition"]);
	assert.equal(vault.history.length, historyBefore, "a failed precondition never writes");
	assert.equal(vault.textOf("a.md"), "one\r\n");
	assert.equal(vault.hasFile("new.md"), false);

	// hash = logical (markdown canonical): CRLF on disk matches the LF hash.
	const ok1 = await exec.run(3, [w("a.md", "two\n", { t: "hash", hash: lfHash })]);
	assert.ok(outcomeOk(ok1[0]));
	const fp2 = await hasher.fingerprint(utf8("two\n"));
	const r1 = ok1[0];
	assert.ok(r1 && r1.t === "write" && r1.outcome.ok && r1.outcome.fingerprint === fp2);
	const ok2 = await exec.run(3, [w("a.md", "three", { t: "fingerprint", fingerprint: fp2 }), w("b.md", "bee", ABSENT), w("b.md", "bee2", ANY)]);
	assert.deepEqual(ok2.map(outcomeOk), [true, true, true]);
	assert.equal(vault.textOf("a.md"), "three");
	assert.equal(vault.textOf("b.md"), "bee2");
});

test("diskExecutor: case-insensitive profile makes absent fail on a case variant; case-sensitive creates both", async () => {
	const ci = setup("case-insensitive");
	ci.vault.userWrite("Note.md", "a");
	const r = await ci.exec.run(3, [w("note.md", "b", ABSENT)]);
	assert.equal(outcomeOk(r[0]), false);
	assert.equal(ci.vault.textOf("Note.md"), "a");

	const cs = setup("case-sensitive");
	cs.vault.userWrite("Note.md", "a");
	const r2 = await cs.exec.run(3, [w("note.md", "b", ABSENT)]);
	assert.equal(outcomeOk(r2[0]), true);
	assert.equal(cs.vault.snapshot().size, 2);
});

test("diskExecutor: renames use VaultPort.rename, deletes use VaultPort.trash only (with mode + precondition)", async () => {
	const { vault, exec, hasher } = setup();
	vault.userWrite("x/a.md", "A");
	vault.userWrite("b.md", "B");
	const fpA = await hasher.fingerprint(utf8("A"));
	const res = await exec.run(2, [
		{ t: "rename", opId: opId++, from: "x/a.md", to: "y/z/a.md", precondition: { t: "fingerprint", fingerprint: fpA }, docId: "d1" as DocId, purpose: "remote-move" },
		{ t: "trash", opId: opId++, path: "b.md", mode: "obsidian-trash", precondition: { t: "fingerprint", fingerprint: "ff".repeat(32) as DiskFingerprint }, docId: "d2" as DocId, purpose: "remote-delete" },
		{ t: "trash", opId: opId++, path: "missing.md", mode: "system-trash", precondition: ANY, docId: null, purpose: "remote-delete" },
		{ t: "removeEmptyFolder", opId: opId++, path: "x" },
	]);
	assert.deepEqual(res.map((r) => r.t), ["rename", "trash", "trash", "removeEmptyFolder"]);
	assert.deepEqual(res.map(outcomeOk), [true, false, false, true]);
	const r2 = res[2];
	assert.ok(r2 && r2.t === "trash" && !r2.outcome.ok && r2.outcome.reason === "source-missing");
	assert.equal(vault.textOf("y/z/a.md"), "A");
	assert.equal(vault.hasFile("b.md"), true, "trash precondition failed -> file kept");
	assert.equal(vault.folderPaths().includes("x"), false, "empty folder removed");
	assert.equal(vault.calls.rename, 1);
	assert.equal(vault.calls.trash, 2);

	const fpB = await hasher.fingerprint(utf8("B"));
	const res2 = await exec.run(2, [{ t: "trash", opId: opId++, path: "b.md", mode: "system-trash", precondition: { t: "fingerprint", fingerprint: fpB }, docId: null, purpose: "remote-delete" }]);
	assert.equal(outcomeOk(res2[0]), true);
	assert.equal(vault.hasFile("b.md"), false);
	assert.deepEqual(vault.trashed.map((t) => [t.path, t.text, t.mode]), [["b.md", "B", "system-trash"]], "deletes are recoverable copies");
});

test("diskExecutor: dependency skip (shared path or docId) but independent ops proceed", async () => {
	const { vault, exec } = setup();
	vault.userWrite("a.md", "A");
	const d1 = "d1" as DocId;
	const res = await exec.run(3, [
		w("a.md", "A2", ABSENT, { docId: d1 }), // fails: exists
		{ t: "rename", opId: opId++, from: "a.md", to: "c.md", precondition: ANY, docId: null, purpose: "remote-move" }, // shares path -> skipped
		w("C.md", "C", ABSENT), // shares (case-folded) path with the skipped rename -> skipped
		w("other.md", "O", ABSENT, { docId: d1 }), // shares docId -> skipped
		w("free.md", "F", ABSENT), // independent -> runs
		{ t: "removeEmptyFolder", opId: opId++, path: "a.md" }, // never skipped
	]);
	assert.deepEqual(res.map((r) => r.t), ["write", "skipped", "skipped", "skipped", "write", "removeEmptyFolder"]);
	assert.equal(outcomeOk(res[4]), true);
	assert.equal(vault.textOf("a.md"), "A");
	assert.equal(vault.hasFile("c.md"), false);
	assert.equal(vault.textOf("free.md"), "F");
	assert.equal(exec.executed, 3);
});

test("diskExecutor: bound guard blocks content writes to an open note, not conflict copies", async () => {
	const bound = new Set(["open.md"]);
	const { vault, exec } = setup("case-insensitive", bound);
	vault.userWrite("open.md", "editor owns this");
	const res: DiskOpResult[] = [];
	for (const op of [
		w("open.md", "remote", ANY, { purpose: "materialize" }),
		w("open.md", "merged", ANY, { purpose: "merge" }),
		w("open.md", "restored", ANY, { purpose: "restore" }),
		w("open (conflict).md", "copy", ABSENT, { purpose: "conflict-copy" }),
	]) res.push(...(await exec.run(0, [op])));
	const reasons = res.map((r) => (r.t === "write" && !r.outcome.ok ? r.outcome.message : "ok"));
	assert.deepEqual(reasons, ["bound", "bound", "bound", "ok"]);
	assert.equal(vault.textOf("open.md"), "editor owns this");
	bound.clear();
	const res2 = await exec.run(0, [w("open.md", "remote", ANY)]);
	assert.equal(outcomeOk(res2[0]), true, "guard is live: unbound path is writable");
});

test("diskExecutor: trash of a bound note with unsent editor edits posts them and refuses once (§c.7)", async () => {
	const clock = new VirtualClock();
	const hasher = createHasher(simHashPort());
	const vault = new SimVault({ clock, hasher, profile: "case-insensitive" });
	const unsent = new Set(["open.md"]);
	const flushed: string[] = [];
	const exec = new DiskExecutor({
		vault, configDir: new SimConfigDir(clock), clock, hasher, isBoundPath: () => true, budgets: () => ({ mainSliceMs: 8 }),
		flushBoundPath: (p) => { flushed.push(p); return unsent.delete(p); },
	});
	vault.userWrite("open.md", "typed");
	const trash = (): DiskOp => ({ t: "trash", opId: opId++, path: "open.md", mode: "obsidian-trash", precondition: ANY, docId: "d1" as DocId, purpose: "remote-delete" });
	const r1 = (await exec.run(0, [trash()]))[0];
	assert.ok(r1 && r1.t === "trash" && !r1.outcome.ok && r1.outcome.reason === "precondition" && r1.outcome.message === "bound-unsent-edits");
	assert.equal(vault.hasFile("open.md"), true, "edits were unsent: the engine must replan before trashing");
	assert.equal(outcomeOk((await exec.run(0, [trash()]))[0]), true, "nothing left to post: bound notes are still trashable");
	assert.deepEqual(flushed, ["open.md", "open.md"]);
	assert.equal(vault.hasFile("open.md"), false);
});

test("diskExecutor: lanes execute open-note first; order within a batch is preserved", async () => {
	const { vault, exec } = setup();
	const order: string[] = [];
	vault.onEvent(() => {});
	const origWrite = vault.write.bind(vault);
	vault.write = async (path, data, pre) => {
		order.push(path);
		return origWrite(path, data, pre);
	};
	const batch = (lane: Lane, prefix: string, n: number) => exec.run(lane, Array.from({ length: n }, (_, i) => w(`${prefix}${i}.md`, "x", ANY)));
	const bulk = batch(4, "bulk", 4);
	const bg = batch(3, "bg", 2);
	const open = batch(0, "open", 2);
	await Promise.all([bulk, bg, open]);
	assert.deepEqual(order, ["bulk0.md", "open0.md", "open1.md", "bg0.md", "bg1.md", "bulk1.md", "bulk2.md", "bulk3.md"]);
});

test("diskExecutor: I/O exceptions map to io outcomes; config area writes are read-compare-write", async () => {
	const { vault, exec, configDir, hasher } = setup();
	vault.failNextOps = 1;
	const res = await exec.run(3, [w("a.md", "x", ANY), w("b.md", "y", ANY)]);
	const r0 = res[0];
	assert.ok(r0 && r0.t === "write" && !r0.outcome.ok && r0.outcome.reason === "io");
	assert.equal(outcomeOk(res[1]), true);

	await configDir.writeBytes("app.json", utf8("{}"));
	const fp = await hasher.fingerprint(utf8("{}"));
	const cfg = await exec.run(2, [
		w("app.json", '{"a":1}', { t: "fingerprint", fingerprint: "00".repeat(32) as DiskFingerprint }, { area: "config", purpose: "settings" }),
		w("app.json", '{"a":2}', { t: "fingerprint", fingerprint: fp }, { area: "config", purpose: "settings" }),
		w("hotkeys.json", "[]", ABSENT, { area: "config", purpose: "settings" }),
	]);
	assert.deepEqual(cfg.map(outcomeOk), [false, false, true], "second op shares the failed config path -> skipped");
	assert.equal(cfg[1]?.t, "skipped");
	assert.equal(new TextDecoder().decode(configDir.files.get("app.json")), "{}");
	assert.equal(vault.hasFile("hotkeys.json"), false, "config writes never land in the vault");
});

test("diskExecutor: reads honour maxBytes and report missing / too-large / io", async () => {
	const { vault, exec, configDir } = setup();
	vault.userWrite("a.md", "hello");
	vault.userWrite("big.bin", "0123456789");
	await configDir.writeBytes("app.json", utf8("{}"));
	const res = await exec.read([
		{ area: "vault", path: "a.md", maxBytes: 100 },
		{ area: "vault", path: "big.bin", maxBytes: 4 },
		{ area: "vault", path: "nope.md", maxBytes: 100 },
		{ area: "config", path: "app.json", maxBytes: 100 },
		{ area: "config", path: "nope.json", maxBytes: 100 },
	]);
	const r0 = res[0];
	assert.ok(r0 && r0.ok && new TextDecoder().decode(r0.bytes) === "hello" && r0.stat.size === 5);
	assert.equal(r0.bytes.byteOffset, 0);
	assert.equal(r0.bytes.byteLength, r0.bytes.buffer.byteLength, "transferable: exclusively owned buffer");
	assert.deepEqual(res.slice(1).map((r) => (r.ok ? "ok" : r.reason)), ["too-large", "missing", "ok", "missing"]);
	vault.failNextOps = 1;
	const io = await exec.read([{ area: "vault", path: "a.md", maxBytes: 100 }]);
	assert.equal(io[0]?.ok === false && io[0].reason, "io");
});
