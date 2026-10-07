import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId, VaultPath } from "../../core/types";
import { World } from "./testkit/world";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const P = (s: string): VaultPath => s as VaultPath;

async function booted(opts?: ConstructorParameters<typeof World>[0]): Promise<World> {
	const w = new World(opts);
	await w.boot();
	return w;
}

test("initial import: local md and blob become docs; S matches disk", async () => {
	const w = new World();
	w.vault.userWrite("notes/a.md", "# A\nhello\n");
	w.vault.userWrite("img/p.png", new Uint8Array([1, 2, 3, 4]));
	await w.boot();
	const res = await w.sync();
	assert.equal(res.quiet, true);
	const a = w.log.liveByPath(P("notes/a.md"));
	const p = w.log.liveByPath(P("img/p.png"));
	assert.ok(a && p);
	assert.equal(w.log.text(a), "# A\nhello\n");
	assert.equal(w.blobs!.uploads.length, 1);
	assert.equal(w.syncedByPath("notes/a.md")?.docId, a);
	assert.equal(w.syncedByPath("img/p.png")?.docId, p);
	assert.equal(w.syncedByPath("img/p.png")?.blobRev, w.log.entry(p)!.blob!.rev);
	assert.equal(w.vault.text("notes/a.md"), "# A\nhello\n", "import never rewrites the file");
	// Steady state: another sync does nothing.
	const before = w.gateway.mutations;
	await w.sync();
	assert.equal(w.gateway.mutations, before);
	assert.equal(w.log.submitted.length, 2);
});

test("remote create materializes md and blob", async () => {
	const w = await booted();
	const a = w.log.remoteCreate(P("deep/x/a.md"), "remote text\n");
	const bytes = new Uint8Array([9, 8, 7]);
	w.blobs!.put(bytes);
	const b = w.log.remoteCreate(P("b.bin"), bytes);
	await w.sync();
	assert.equal(w.vault.text("deep/x/a.md"), "remote text\n");
	assert.deepEqual(w.vault.bytesOf("b.bin"), bytes);
	assert.equal(w.synced(a)?.path, "deep/x/a.md");
	assert.equal(w.synced(b)?.blobRev, w.log.entry(b)!.blob!.rev);
	assert.equal(w.r.scan.dirty.size, 0, "own writes are echoes");
	assert.equal(w.log.submitted.length, 0);
});

test("two-way clean merge: disk edit + remote edit on different lines", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("m.md"), "one\ntwo\nthree\n");
	await w.sync();
	w.log.remoteEdit(id, (t) => t.insert(0, "zero\n"));
	w.vault.userWrite("m.md", "one\ntwo\nthree\nfour\n");
	await w.sync();
	assert.equal(w.vault.text("m.md"), "zero\none\ntwo\nthree\nfour\n");
	assert.equal(w.log.text(id), "zero\none\ntwo\nthree\nfour\n");
	assert.deepEqual(w.conflictCopies(), []);
	assert.equal(w.synced(id)?.contentHash !== undefined, true);
	assert.equal(w.intents(), 0);
});

test("same-line conflict: CRDT keeps remote, disk keeps a copy with the original bytes, copy syncs as a new doc", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("c.md"), "title\nshared line\nend\n");
	await w.sync();
	w.log.remoteEdit(id, (t) => {
		const s = t.toString();
		const at = s.indexOf("shared line");
		t.delete(at, "shared line".length);
		t.insert(at, "remote version");
	});
	w.vault.userWrite("c.md", "title\nlocal version\nend\n");
	await w.sync();
	const copies = w.conflictCopies();
	assert.equal(copies.length, 1);
	const copy = copies[0]!;
	assert.match(copy, /^c \(conflict laptop \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
	assert.equal(w.vault.text(copy), "title\nlocal version\nend\n");
	assert.equal(w.vault.text("c.md"), w.log.text(id));
	assert.ok(w.log.text(id).includes("remote version"));
	const copyId = w.log.liveByPath(P(copy));
	assert.ok(copyId, "conflict copy imported as a doc");
	assert.equal(w.log.text(copyId!), "title\nlocal version\nend\n");
	assert.equal(w.intents(), 0);
	await w.sync();
	assert.equal(w.conflictCopies().length, 1);
	assert.deepEqual(w.notices.filter((n) => n.code === "conflict-copy"), [
		{ level: "warn", code: "conflict-copy", message: `YAOS could not merge two versions of “c.md”; the other version is saved as “${copy}”.` },
	]);
});

test("conflict copies of one pass make one notice with the count and the first path", async () => {
	const w = await booted();
	const ids = ["x.md", "y.md", "z.md"].map((p) => w.log.remoteCreate(P(p), "head\nshared\ntail\n"));
	await w.sync();
	for (const id of ids) w.log.remoteEdit(id, (t) => {
		const at = t.toString().indexOf("shared");
		t.delete(at, "shared".length);
		t.insert(at, "remote");
	});
	for (const p of ["x.md", "y.md", "z.md"]) w.vault.userWrite(p, "head\nlocal\ntail\n");
	await w.sync();
	const copies = w.conflictCopies();
	assert.equal(copies.length, 3);
	const notes = w.notices.filter((n) => n.code === "conflict-copy");
	assert.equal(notes.length, 1, JSON.stringify(notes));
	assert.match(notes[0]!.message, /^YAOS could not merge 3 files; the other versions are saved as conflict copies \(first: “. \(conflict laptop .*\)\.md”\)\.$/);
	assert.ok(copies.some((c) => notes[0]!.message.includes(c)));
	assert.deepEqual(w.conflictCopyEvents.map(([, to]) => to).sort(), [...copies].sort(), "each copy reaches onConflictCopy (status conflictCopiesToday)");
	await w.sync();
	assert.equal(w.notices.filter((n) => n.code === "conflict-copy").length, 1, "quiet passes add nothing");
	assert.equal(w.conflictCopyEvents.length, 3);
});

test("CRLF file: merge keeps the file's bytes when content is unchanged", async () => {
	const w = new World();
	w.vault.userWrite("crlf.md", "a\r\nb\r\n");
	await w.boot();
	await w.sync();
	const id = w.log.liveByPath(P("crlf.md"))!;
	assert.equal(w.vault.text("crlf.md"), "a\r\nb\r\n", "import does not rewrite CRLF");
	assert.equal(w.log.text(id), "a\nb\n");
	// A local edit that is still CRLF syncs without the disk file being rewritten to LF.
	w.vault.userWrite("crlf.md", "a\r\nb\r\nc\r\n");
	const writes = w.gateway.executed.filter((o) => o.t === "write").length;
	await w.sync();
	assert.equal(w.log.text(id), "a\nb\nc\n");
	assert.equal(w.vault.text("crlf.md"), "a\r\nb\r\nc\r\n");
	assert.equal(w.gateway.executed.filter((o) => o.t === "write").length, writes);
});

test("emoji edits on both sides never produce U+FFFD", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("e.md"), "😀 one\n👩‍👩‍👧 two\n");
	await w.sync();
	w.log.remoteEdit(id, (t) => t.insert(t.length, "🎉 three\n"));
	w.vault.userWrite("e.md", "😀 one 🙂\n👩‍👩‍👧 two\n");
	await w.sync();
	const text = w.log.text(id);
	assert.ok(!text.includes("�"));
	assert.equal(text, "😀 one 🙂\n👩‍👩‍👧 two\n🎉 three\n");
	assert.equal(w.vault.text("e.md"), text);
});

test("non-UTF-8 markdown is left alone with a notice", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("bad.md"), "fine\n");
	await w.sync();
	const bad = new Uint8Array([0x66, 0xff, 0xfe, 0x0a]);
	w.vault.userWrite("bad.md", bad);
	await w.sync();
	assert.deepEqual(w.vault.bytesOf("bad.md"), bad);
	assert.equal(w.log.text(id), "fine\n");
	assert.ok(w.notices.some((n) => /utf/i.test(n.code)), JSON.stringify(w.notices));
});

test("remote edit while the file is unchanged locally: plain overwrite", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("o.md"), "v1\n");
	await w.sync();
	w.log.remoteEdit(id, (t) => {
		t.delete(0, t.length);
		t.insert(0, "v2 longer\n");
	});
	await w.sync();
	assert.equal(w.vault.text("o.md"), "v2 longer\n");
	assert.deepEqual(w.conflictCopies(), []);
});

test("bound doc: disk edit merges into the CRDT, the disk file is never written", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("b.md"), "x\n");
	await w.sync();
	w.log.setBound(id as DocId, true);
	w.vault.userWrite("b.md", "x\ny\n");
	const writes = w.gateway.executed.filter((o) => o.t === "write").length;
	await w.sync();
	assert.equal(w.log.text(id), "x\ny\n");
	assert.equal(w.gateway.executed.filter((o) => o.t === "write").length, writes);
});

/**
 * Bound doc, remote and external edits merge to M ≠ D: the file stays at D until the editor saves.
 * Sim seeds 56 (view closed before its save), 28 and 21 (app crash before the save) left the
 * disk at D for good because S already claimed the CRDT version.
 */
async function boundMergedAwaitingSave(): Promise<{ w: World; id: DocId }> {
	const w = await booted();
	const id = w.log.remoteCreate(P("b.md"), "a\nb\nc\n") as DocId;
	await w.sync();
	w.log.setBound(id, true);
	w.log.remoteEdit(id, (t) => t.insert(0, "A"));
	w.vault.userWrite("b.md", "a\nb\nc\nd\n");
	const res = await w.sync();
	assert.equal(w.log.text(id), "Aa\nb\nc\nd\n");
	assert.equal(w.vault.text("b.md"), "a\nb\nc\nd\n", "bound: never written");
	assert.deepEqual(res, { passes: 1, quiet: true }, "deferred to the editor: no chained passes");
	assert.equal(w.synced(id)?.bodyVersion, null, "no CRDT sync point before the save");
	return { w, id };
}

test("bound doc merged, then closed before the editor saved: the next pass writes the merge", async () => {
	const { w, id } = await boundMergedAwaitingSave();
	w.log.setBound(id, false);
	await w.sync();
	assert.equal(w.vault.text("b.md"), "Aa\nb\nc\nd\n");
	assert.deepEqual(w.conflictCopies(), []);
});

test("bound doc merged, then the app crashed before the editor saved: reboot writes the merge", async () => {
	const { w, id } = await boundMergedAwaitingSave();
	await w.crashAndReboot();
	w.log.setBound(id, false); // the new app has no editor open
	await w.sync();
	assert.equal(w.vault.text("b.md"), "Aa\nb\nc\nd\n");
	assert.deepEqual(w.conflictCopies(), []);
});

/**
 * Sim heavy seed 119: the editor typed while a merge of its doc was closing its frame. The keystrokes rode
 * that frame, so S claimed their version with the disk text; the app then died before the editor's save
 * and the disk never got them (Rc and Lc both false).
 */
test("bound doc: keystrokes landing in the merge's frame are not claimed by S; the next unbound pass writes them", async () => {
	const w = await booted();
	const id = w.log.remoteCreate(P("b.md"), "x\n") as DocId;
	await w.sync();
	w.log.setBound(id, true);
	w.vault.userWrite("b.md", "x\ny\n");
	let typed = false;
	w.log.onCommitEdits = (d) => {
		if (d !== id || typed) return;
		typed = true;
		w.log.editorType(id, (t) => t.insert(t.length, "z\n"));
	};
	await w.sync();
	assert.ok(typed);
	assert.equal(w.log.text(id), "x\ny\nz\n");
	assert.equal(w.vault.text("b.md"), "x\ny\n");
	w.log.setBound(id, false); // closed before its save
	await w.sync();
	assert.equal(w.vault.text("b.md"), "x\ny\nz\n");
	assert.deepEqual(w.conflictCopies(), []);
});

test("bound doc merged, then the editor saved: S gets its sync point, closing writes nothing", async () => {
	const { w, id } = await boundMergedAwaitingSave();
	w.vault.userWrite("b.md", "Aa\nb\nc\nd\n"); // the editor's save
	await w.sync();
	assert.notEqual(w.synced(id)?.bodyVersion, null);
	w.log.setBound(id, false);
	const writes = w.gateway.executed.filter((o) => o.t === "write").length;
	const res = await w.sync();
	assert.equal(res.quiet, true);
	assert.equal(w.gateway.executed.filter((o) => o.t === "write").length, writes);
	assert.equal(w.vault.text("b.md"), "Aa\nb\nc\nd\n");
});

test("live creates (DESIGN §d.4): the first full pass after boot holds its creates' bodies; later creates are live, corked until their initial content is framed", async () => {
	const w = new World();
	w.vault.userWrite("a.md", "A\n");
	await w.boot();
	await w.sync();
	const a = w.log.liveByPath(P("a.md"))!;
	assert.deepEqual(w.log.trace, ["ns held", `frame ${a}`], "onboarding pass: held, no cork");
	w.log.trace.length = 0;

	w.vault.userWrite("b.md", "B\n");
	w.vault.userWrite("c.md", "C\n");
	w.vault.userWrite("empty.md", "");
	await w.sync();
	const b = w.log.liveByPath(P("b.md"))!;
	const c = w.log.liveByPath(P("c.md"))!;
	assert.ok(w.log.liveByPath(P("empty.md")));
	assert.equal(w.log.trace.length, 5);
	assert.deepEqual(w.log.trace.slice(0, 2), ["cork", "ns live"]);
	assert.deepEqual(w.log.trace.slice(2, 4).sort(), [`frame ${b}`, `frame ${c}`].sort(), "both initial bodies framed inside the cork");
	assert.equal(w.log.trace[4], "uncork");
	w.log.trace.length = 0;

	w.vault.userWrite("only-empty.md", "");
	await w.sync();
	assert.deepEqual(w.log.trace, ["ns live"], "an empty create has no body to wait for: no cork");
	w.log.trace.length = 0;

	await w.crashAndReboot();
	w.vault.userWrite("d.md", "D\n");
	await w.sync();
	const d = w.log.liveByPath(P("d.md"))!;
	assert.deepEqual(w.log.trace, ["ns held", `frame ${d}`], "the first pass after a restart holds again");
});
