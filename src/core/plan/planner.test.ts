import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId, LocalEntry, Plan, PlannerInput, PlannerOp, RemoteEntry, SyncedEntry } from "../types";
import { EMPTY_CONTENT_HASH, plan, planWith } from "./planner";
import { brakeId, DEFAULT_BRAKE } from "./brake";
import { refHashPort } from "../hash/testkit/hashRef";
import { L, R, S, V, fp, h, id, input, pk, type Scenario } from "./planFixtures";
import { prng } from "../merge/prng";

const opsOf = (p: Plan): string[] => p.ops.map((o) => o.op);
const find = <K extends PlannerOp["op"]>(p: Plan, k: K): Extract<PlannerOp, { op: K }> => {
	const op = p.ops.find((o) => o.op === k);
	assert.ok(op, `expected op ${k} in ${JSON.stringify(opsOf(p))}`);
	return op as Extract<PlannerOp, { op: K }>;
};
const run = (sc: Scenario, ctx = {}): Plan => planWith(input(sc), ctx);

// ---------------------------------------------------------------------------
// Row: live | present | present
// ---------------------------------------------------------------------------

test("row live/present/present: unchanged = no ops; stat moved = syncedPut", () => {
	const base = { remote: [R("d1", "a.md")], synced: [S("d1", "a.md")] };
	assert.deepEqual(run({ ...base, local: [L("a.md", h("c0"))] }).ops, []);
	const p = run({ ...base, local: [L("a.md", h("c0"), { mtimeMs: 2000 })] });
	assert.deepEqual(opsOf(p), ["syncedPut"]);
	assert.equal(find(p, "syncedPut").entry.mtimeMs, 2000);
});

test("row live/present/present: remote move = plain diskRename (expect hash) + synced path", () => {
	const p = run({ remote: [R("d1", "b/x.md", { lastTouchSeq: 9 })], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] });
	assert.deepEqual(opsOf(p), ["diskRename", "syncedPut"]);
	assert.deepEqual(find(p, "diskRename"), { op: "diskRename", docId: "d1", from: "a.md", to: "b/x.md", expect: { t: "hash", hash: h("c0") } });
	const put = find(p, "syncedPut").entry;
	assert.equal(put.path, "b/x.md");
	assert.equal(put.pathKey, pk("b/x.md"));
	assert.equal(put.nsTouchSeq, 9);
	// pendingLocal pins the local file: no move.
	const pinned = run({ remote: [R("d1", "b/x.md", { pendingLocal: true })], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] });
	assert.deepEqual(pinned.ops, []);
	// remote move + remote edit: rename then reconcile at the new path (job writes synced).
	const both = run({ remote: [R("d1", "b.md", { body: { ...R("d1", "b.md").body!, version: V(11) } })], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] });
	assert.deepEqual(opsOf(both), ["diskRename", "reconcileContent"]);
	assert.equal(find(both, "reconcileContent").path, "b.md");
	// case-only leaf move goes through diskRename (VaultPort handles the temp name)
	const cased = run({ remote: [R("d1", "A.md")], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] });
	assert.deepEqual(opsOf(cased), ["diskRename", "syncedPut"]);
	// folder-casing-only difference is tolerated: no disk op
	const folder = run({ remote: [R("d1", "Notes/a.md")], synced: [S("d1", "notes/a.md")], local: [L("notes/a.md", h("c0"))] });
	assert.deepEqual(opsOf(folder), ["syncedPut"]);
	assert.equal(find(folder, "syncedPut").entry.path, "Notes/a.md");
});

test("row live/present/present: remote move onto an untracked copy of the doc's own bytes trashes the copy; the move follows", () => {
	// Sim heavy seed 79: after an IDB loss S came back at the old path (re-materialized with B's edit) while the
	// user's renamed file, still the create content, sat at R.path. That file is never created (mergesIntoOwner)
	// and the move waited for it forever.
	const base = { remote: [R("d1", "b.md", { createHash: h("c0") })], synced: [S("d1", "a.md", { contentHash: h("c1") })] };
	const p = run({ ...base, local: [L("a.md", h("c1")), L("b.md", h("c0"))] });
	assert.deepEqual(p.ops[0], { op: "diskTrash", docId: null, path: "b.md", expect: { t: "hash", hash: h("c0") } });
	assert.ok(!opsOf(p).includes("diskRename") && !opsOf(p).includes("nsCreate"), JSON.stringify(opsOf(p)));
	// next pass, the path free: the plain move
	assert.deepEqual(opsOf(run({ ...base, local: [L("a.md", h("c1"))] })), ["diskRename", "syncedPut"]);
	// a copy of the doc's current file: the same
	assert.equal(opsOf(run({ ...base, local: [L("a.md", h("c1")), L("b.md", h("c1"))] }))[0], "diskTrash");
	// unhashed occupant: hash it first
	assert.deepEqual(run({ ...base, local: [L("a.md", h("c1")), L("b.md", null)] }).ops, [{ op: "needHash", path: "b.md" }]);
	// other bytes: a new file (created; the move waits for the path)
	const other = run({ ...base, local: [L("a.md", h("c1")), L("b.md", h("c9"))] });
	assert.ok(!opsOf(other).includes("diskTrash") && !opsOf(other).includes("diskRename"), JSON.stringify(opsOf(other)));
	assert.equal(find(other, "nsCreate").path, "b.md");
});

test("row live/present/present: markdown content Rc / Lc / both -> reconcileContent", () => {
	const rc = run({ remote: [R("d1", "a.md", { body: { ...R("d1", "a.md").body!, version: V(12) } })], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] });
	assert.deepEqual(rc.ops, [{ op: "reconcileContent", docId: "d1", path: "a.md", kind: "markdown", hasBase: true }]);
	const lc = run({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], local: [L("a.md", h("c1"))] });
	assert.deepEqual(opsOf(lc), ["reconcileContent"]);
	const both = run({ remote: [R("d1", "a.md", { body: { ...R("d1", "a.md").body!, version: V(10, 3) } })], synced: [S("d1", "a.md", { hasBase: false })], local: [L("a.md", h("c1"))] });
	assert.deepEqual(both.ops, [{ op: "reconcileContent", docId: "d1", path: "a.md", kind: "markdown", hasBase: false }]);
	// content decisions need body.caughtUp
	const behind = run({ remote: [R("d1", "a.md", { body: { ...R("d1", "a.md").body!, caughtUp: false } })], synced: [S("d1", "a.md")], local: [L("a.md", h("c1"))] });
	assert.deepEqual(behind.ops, [{ op: "wait", docId: "d1", reason: "body-not-caught-up" }]);
	// canvas uses the same op with kind canvas
	const cv = run({ remote: [R("c1", "x.canvas")], synced: [S("c1", "x.canvas")], local: [L("x.canvas", h("c1"))] });
	assert.equal(find(cv, "reconcileContent").kind, "canvas");
});

test("row live/present/present: blob Rc -> fetchBlob, Lc -> nsSetBlob + pushBlob, converged -> syncedPut", () => {
	const blobR = (over: Partial<RemoteEntry> = {}) => R("d9", "img.png", over);
	const rc = run({ remote: [blobR({ blob: { hash: h("b1"), size: 9000, rev: 51 } })], synced: [S("d9", "img.png")], local: [L("img.png", h("b0"))] });
	assert.deepEqual(rc.ops, [{ op: "fetchBlob", docId: "d9", path: "img.png", hash: h("b1"), size: 9000 }]);
	const lc = run({ remote: [blobR()], synced: [S("d9", "img.png")], local: [L("img.png", h("b2"), { size: 7 })] });
	assert.deepEqual(lc.ops, [
		{ op: "nsSetBlob", docId: "d9", hash: h("b2"), size: 7, baseRev: 50 },
		{ op: "pushBlob", docId: "d9", path: "img.png", hash: h("b2"), size: 7 },
	]);
	// own setBlob pending: precondition op not re-emitted, synced not touched (pseudo rev)
	const pending = run({ remote: [blobR({ pendingLocal: true, blob: { hash: h("b2"), size: 7, rev: 1_000_001 } })], synced: [S("d9", "img.png")], local: [L("img.png", h("b2"))] });
	assert.deepEqual(pending.ops, []);
	const pendingOther = run({ remote: [blobR({ pendingLocal: true, blob: { hash: h("b2"), size: 7, rev: 1_000_001 } })], synced: [S("d9", "img.png")], local: [L("img.png", h("b3"))] });
	assert.deepEqual(pendingOther.ops, [{ op: "wait", docId: "d9", reason: "pending-ns" }]);
	const conv = run({ remote: [blobR({ blob: { hash: h("b5"), size: 1, rev: 60 } })], synced: [S("d9", "img.png")], local: [L("img.png", h("b5"))] });
	assert.deepEqual(opsOf(conv), ["syncedPut"]);
	assert.equal(find(conv, "syncedPut").entry.blobRev, 60);
	assert.equal(find(conv, "syncedPut").entry.contentHash, h("b5"));
});

test("E8: blob rev-mismatch keeps both", () => {
	const p = run({
		remote: [R("d9", "img.png", { blob: { hash: h("h1"), size: 900, rev: 51 } })],
		synced: [S("d9", "img.png", { contentHash: h("h0"), blobRev: 50 })],
		local: [L("img.png", h("h2"), { size: 800 })],
	});
	const copy = "img (conflict B 2026-10-05 1412).png";
	assert.deepEqual(p.ops, [
		{ op: "nsCreate", docId: "fresh1", kind: "blob", path: copy, contentHash: h("h2"), size: 800 },
		{ op: "conflictCopy", docId: "d9", from: "img.png", to: copy, reason: "blob-concurrent", expect: { t: "hash", hash: h("h2") } },
		{ op: "fetchBlob", docId: "d9", path: "img.png", hash: h("h1"), size: 900 },
		{ op: "pushBlob", docId: "fresh1", path: copy, hash: h("h2"), size: 800 },
	]);
	assert.equal(p.consumedDocIds, 1);
});

// ---------------------------------------------------------------------------
// Row: live | present | absent
// ---------------------------------------------------------------------------

test("row live/present/absent: inferred rename -> nsRename + synced path; observed rename + edit -> nsRename + reconcile", () => {
	const sc = { remote: [R("d1", "a.md")], synced: [S("d1", "a.md")] };
	const inferred = run({ ...sc, local: [L("dir/a.md", h("c0"))] });
	assert.deepEqual(opsOf(inferred), ["nsRename", "syncedPut"]);
	assert.deepEqual(find(inferred, "nsRename"), { op: "nsRename", docId: "d1", path: "dir/a.md" });
	assert.equal(find(inferred, "syncedPut").entry.path, "dir/a.md");
	const observed = run({ ...sc, local: [L("b.md", h("c9"))], over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } });
	assert.deepEqual(opsOf(observed), ["nsRename", "reconcileContent"]);
	assert.equal(find(observed, "reconcileContent").path, "b.md");
	// without a complete listing, hash inference is off (observed renames still count)
	const partial = run({ ...sc, local: [L("dir/a.md", h("c0"))], over: { localComplete: false } });
	assert.ok(!opsOf(partial).includes("nsRename"));
	assert.ok(!opsOf(partial).includes("nsDelete"));
});

test("row live/present/absent: edit-beats-delete waits for rename inference (ns not ready, listing partial, fresh unhashed)", () => {
	// Sim seed 21 (3 devices): a local rename of a remotely edited doc while ns was not ready was
	// re-materialized at the old path; the editor kept the renamed file bound to the old doc.
	const edited = { remote: [R("d1", "a.md", { body: { ...R("d1", "a.md").body!, version: V(11) } })], synced: [S("d1", "a.md")] };
	const renamed = { ...edited, local: [L("b.md", h("c0"))], over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } };
	const gone: PlannerOp = { op: "syncedPut", entry: { ...S("d1", "a.md"), fileGone: true } };
	assert.deepEqual(run(renamed, { nsReady: false }).ops, [gone]); // the file left a.md either way
	assert.deepEqual(run({ ...edited, over: { localComplete: false } }).ops, []);
	assert.deepEqual(run({ ...edited, local: [L("z.md", null)] }).ops, [gone, { op: "needHash", path: "z.md" }]);
	// once ns is ready the observed rename wins: nsRename + reconcile at the new path
	assert.deepEqual(opsOf(run(renamed)), ["nsRename", "reconcileContent"]);
});

test("observed rename wins over a new file at the source path; the new file is created once S has moved", () => {
	// Sim seed 21: rename n2 -> r5, then a new n2.md before ns was ready. The doc stayed at n2.md, r5.md became a
	// new doc, and the editor that followed the rename kept writing the old doc's text into r5.md.
	const sc = { remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } };
	const p = run({ ...sc, local: [L("a.md", h("c7")), L("b.md", h("c0"))] });
	assert.deepEqual(opsOf(p), ["nsRename", "syncedPut"]);
	assert.deepEqual(find(p, "nsRename"), { op: "nsRename", docId: "d1", path: "b.md" });
	assert.equal(find(p, "syncedPut").entry.path, "b.md");
	// not while ns is not ready, and never by hash alone
	assert.deepEqual(run({ ...sc, local: [L("a.md", h("c7")), L("b.md", h("c0"))] }, { nsReady: false }).ops, []);
	const byHash = run({ ...sc, over: {}, local: [L("a.md", h("c7")), L("b.md", h("c0"))] });
	assert.ok(!opsOf(byHash).includes("nsRename"));
	// next pass: S and R at b.md, the file at a.md is new
	const next = run({ remote: [R("d1", "b.md")], synced: [S("d1", "b.md")], local: [L("a.md", h("c7")), L("b.md", h("c0"))] });
	assert.deepEqual(opsOf(next), ["nsCreate", "reconcileContent"]);
	assert.equal(find(next, "nsCreate").path, "a.md");
});

test("a file at the remote-move target of a doc synced elsewhere is new: published, not orphaned", () => {
	// Sim seed 285 (2 devices, no faults): B moved seed0 -> r5 while A renamed r1 -> r5. The file at r5.md counted
	// as d1's (R key) though d1's file was still at seed0.md: d2's rename became an nsDelete, nothing ever planned
	// r5.md, and d1's diskRename into it failed on every pass.
	const moved = { remote: [R("d1", "r5.md"), R("d2", "r1.md")], synced: [S("d1", "seed0.md"), S("d2", "r1.md", { contentHash: h("c2") })] };
	const p = run({ ...moved, local: [L("seed0.md", h("c0")), L("r5.md", h("c2"))], over: { renames: [{ from: "r1.md", to: "r5.md", atMs: 1 }] } });
	assert.deepEqual(find(p, "nsRename"), { op: "nsRename", docId: "d2", path: "r5.md" });
	assert.ok(!opsOf(p).includes("nsDelete"), JSON.stringify(opsOf(p)));
	// d1's move waits for r5.md to be freed by d2's loser rename (no diskRename into an occupied path).
	assert.ok(!opsOf(p).includes("diskRename"), JSON.stringify(opsOf(p)));
	// A plain new file there gets its own doc (the fold suffixes it; the loser rename frees the path).
	const fresh = run({ remote: [R("d1", "r5.md")], synced: [S("d1", "seed0.md")], local: [L("seed0.md", h("c0")), L("r5.md", h("c7"))] });
	assert.equal(find(fresh, "nsCreate").path, "r5.md");
	// d1's file already moved (crash after the rename): the file at r5.md is d1's, adopted (test below).
});

test("observed rename onto the path of a remote doc never materialized here: the doc moves, the remote doc waits for the path", () => {
	// Sim heavy seed 222: B renamed seed1 -> r0 while A's doc at r0.md had not reached B's disk. The file was merged
	// into A's doc (no base: conflict copy), its write refused by the moved doc's bound editor, so every pass added a copy.
	const sc = {
		remote: [R("d1", "a.md"), R("d2", "b.md", { createHash: h("c5") })],
		synced: [S("d1", "a.md")],
		local: [L("b.md", h("c3"))],
		over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] },
	};
	const p = run(sc);
	assert.deepEqual(opsOf(p), ["nsRename", "reconcileContent"]);
	assert.deepEqual(find(p, "nsRename"), { op: "nsRename", docId: "d1", path: "b.md" });
	assert.equal(find(p, "reconcileContent").docId, "d1");
	assert.ok(!p.ops.some((o) => "docId" in o && o.docId === "d2"), "d2 waits for the path");
	// unchanged bytes: the move only
	assert.deepEqual(opsOf(run({ ...sc, local: [L("b.md", h("c0"))] })), ["nsRename", "syncedPut"]);
	// never by hash alone, nor onto a remote doc synced here
	const byHash = run({ ...sc, local: [L("b.md", h("c0"))], over: {} });
	assert.ok(!opsOf(byHash).includes("nsRename"));
	const held = run({ ...sc, synced: [S("d1", "a.md"), S("d2", "b.md")] });
	assert.ok(!opsOf(held).includes("nsRename"));
	// not while ns is not ready
	assert.ok(!opsOf(run(sc, { nsReady: false })).includes("reconcileContent"));
});

test("observed rename off a re-occupied source path wins over a concurrent remote move: the new file stays put", () => {
	// Sim DEV=3 F seed 21: the user renamed n2 -> r5 and created a new n2.md before ns was ready, while another
	// device moved the doc n2 -> r1. The plan carried the new n2.md to r1.md as the doc's file and made r5.md a
	// new doc; the editor that followed the rename kept the old doc, and r1.md never got the doc's text.
	const sc = { remote: [R("d1", "c.md")], synced: [S("d1", "a.md")], over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } };
	const p = run({ ...sc, local: [L("a.md", h("c7")), L("b.md", h("c0"))] });
	assert.deepEqual(opsOf(p), ["nsRename", "syncedPut"]);
	assert.deepEqual(find(p, "nsRename"), { op: "nsRename", docId: "d1", path: "b.md" });
	assert.equal(find(p, "syncedPut").entry.path, "b.md");
	// without the observed rename the remote move takes the file at a.md along, as before
	const byHash = run({ ...sc, over: {}, local: [L("a.md", h("c7")), L("b.md", h("c0"))] });
	assert.ok(opsOf(byHash).includes("diskRename"));
	assert.ok(!opsOf(byHash).includes("nsRename"));
});

test("row live/present/absent: remote edited -> diskMaterialize (edit beats delete); else nsDelete + syncedDrop", () => {
	const edited = run({ remote: [R("d1", "a.md", { body: { ...R("d1", "a.md").body!, version: V(11) } })], synced: [S("d1", "a.md")] });
	assert.deepEqual(edited.ops, [{ op: "diskMaterialize", docId: "d1", path: "a.md", expect: { t: "absent" } }]);
	const del = planWith(input({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")] }), { bodyAppliedSeq: new Map([[id("d1"), 33]]) });
	assert.deepEqual(del.ops, [{ op: "nsDelete", docId: "d1", baseBodySeq: 33 }, { op: "syncedDrop", docId: "d1" }]);
	// default baseBodySeq = body.version.remoteSeq; blobs use 0
	assert.deepEqual(find(run({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")] }), "nsDelete").baseBodySeq, 10);
	assert.deepEqual(find(run({ remote: [R("d9", "i.png")], synced: [S("d9", "i.png")] }), "nsDelete").baseBodySeq, 0);
	// the waits below record the decided delete (fileGone, next test)
	const gone: PlannerOp = { op: "syncedPut", entry: { ...S("d1", "a.md"), fileGone: true } };
	// precondition op with a pending own ns op -> wait
	const pend = run({ remote: [R("d1", "a.md", { pendingLocal: true })], synced: [S("d1", "a.md")] });
	assert.deepEqual(pend.ops, [{ op: "wait", docId: "d1", reason: "pending-ns" }, gone]);
	// own body frames still in the outbox -> wait, so the delete base covers them (§c.7)
	const body = run({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], over: { docsWithPendingBody: new Set([id("d1")]) } });
	assert.deepEqual(body.ops, [{ op: "wait", docId: "d1", reason: "pending-body" }, gone]);
	// needs localComplete (and no fileGone without it)
	assert.deepEqual(run({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], over: { localComplete: false } }).ops, []);
	// an unhashed new local file might be the renamed doc: no delete yet
	const unhashed = run({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], local: [L("z.md", null)] });
	assert.deepEqual(unhashed.ops, [gone, { op: "needHash", path: "z.md" }]);
});

test("row live/present/absent: a delete that waits marks fileGone; a file re-created at the path is new, not a save", () => {
	// Sim heavy seed 92: A deleted n0.md offline (ns not ready, own body frames unacked), then created a new n0.md.
	// The planner merged it into the doc as a save; the peer had deleted the old text, which took the brackets the
	// minimal diff kept of it, and the new note's token was lost. Online the delete would have gone out first.
	const base = { remote: [R("d1", "a.md")], synced: [S("d1", "a.md")] };
	const gone = { ...S("d1", "a.md"), fileGone: true as const };
	const waiting = run(base, { nsReady: false });
	assert.deepEqual(waiting.ops, [{ op: "syncedPut", entry: gone }]);
	// the mark passes the brake as the delete does: held with a mass delete
	assert.equal(waiting.held.length, 0);
	// next pass: the re-created file is not the doc's; it waits for the delete (no merge, no create yet)
	const sc = { ...base, synced: [gone], local: [L("a.md", h("c9"))] };
	assert.deepEqual(run(sc, { nsReady: false }).ops, []);
	assert.deepEqual(run({ ...sc, over: { docsWithPendingBody: new Set([id("d1")]) } }).ops, [{ op: "wait", docId: "d1", reason: "pending-body" }]);
	// ns ready, frames acked: the delete (decided, not braked again); then the file is created as a new doc
	const del = run(sc);
	assert.deepEqual(opsOf(del), ["nsDelete", "syncedDrop"]);
	const after = run({ remote: [R("d1", "a.md", { state: "deleted", deletedSeq: 41, pendingLocal: true })], local: [L("a.md", h("c9"))] });
	assert.deepEqual(opsOf(after), ["nsCreate", "reconcileContent"]);
	// edit beats delete while waiting: the doc comes back at its (free) remote path
	const edited = R("d1", "b.md", { body: { ...R("d1", "a.md").body!, version: V(11) } });
	assert.deepEqual(run({ ...sc, remote: [edited] }).ops, [{ op: "diskMaterialize", docId: "d1", path: "b.md", expect: { t: "absent" } }]);
	// ... and at the path the new file holds, the file merges into the doc after all (fileGone cleared)
	const editedHere = R("d1", "a.md", { body: { ...R("d1", "a.md").body!, version: V(11) } });
	assert.deepEqual(run({ ...sc, remote: [editedHere] }).ops, [{ op: "syncedPut", entry: S("d1", "a.md") }]);
	// an inferred rename of the doc clears it too
	const renamed = run({ ...base, synced: [gone], local: [L("c.md", h("c0"))], over: { renames: [{ from: "a.md", to: "c.md", atMs: 1 }] } });
	assert.deepEqual(opsOf(renamed), ["nsRename", "syncedPut"]);
	assert.equal(find(renamed, "syncedPut").entry.fileGone, undefined);
	// the doc's file at its remote path is its own (an own rename marked gone offline, sim heavy seed 22): recorded
	// there, mark cleared; with a remote edit it merges (the job records it)
	const moved = run({ remote: [R("d1", "b.md", { lastTouchSeq: 12 })], synced: [gone], local: [L("b.md", h("c0"))] });
	assert.deepEqual(moved.ops, [{ op: "syncedPut", entry: { ...S("d1", "b.md"), nsTouchSeq: 12 } }]);
	const movedEdited = run({ remote: [{ ...edited, lastTouchSeq: 12 }], synced: [gone], local: [L("b.md", h("c0"))] });
	assert.deepEqual(opsOf(movedEdited), ["reconcileContent"]);
	// ... unless the user renamed another file there: the doc's file is where its own rename took it (sim DEV3 F
	// seed 452). The doc follows the observed rename (merging there); the other file is a new doc, its create after
	// the rename that frees the path.
	const both = run({
		remote: [{ ...edited, lastTouchSeq: 12 }], synced: [gone], local: [L("c.md", h("c5")), L("b.md", h("c7"))],
		over: { renames: [{ from: "a.md", to: "c.md", atMs: 1 }, { from: "n.md", to: "b.md", atMs: 2 }] },
	});
	assert.deepEqual(opsOf(both), ["nsRename", "nsCreate", "reconcileContent", "reconcileContent"]);
	assert.equal(find(both, "nsRename").path, "c.md");
	assert.equal(find(both, "nsCreate").path, "b.md");
	assert.deepEqual(both.ops.filter((o) => o.op === "reconcileContent").map((o) => [o.docId === "d1", o.path]), [[true, "c.md"], [false, "b.md"]]);
});

// ---------------------------------------------------------------------------
// Rows: deleted | present | *
// ---------------------------------------------------------------------------

test("row deleted/present/absent -> syncedDrop", () => {
	const p = run({ remote: [R("d1", "a.md", { state: "deleted", deletedSeq: 41 })], synced: [S("d1", "a.md")] });
	assert.deepEqual(p.ops, [{ op: "syncedDrop", docId: "d1" }]);
});

test("row deleted/present/present unchanged -> diskTrash(expect S hash) + syncedDrop; restore duty -> nsRestore", () => {
	const sc = { remote: [R("d1", "a.md", { state: "deleted" as const, deletedSeq: 41 })], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] };
	assert.deepEqual(run(sc).ops, [
		{ op: "diskTrash", docId: "d1", path: "a.md", expect: { t: "hash", hash: h("c0") } },
		{ op: "syncedDrop", docId: "d1" },
	]);
	const duty = run({ ...sc, over: { docsWithPendingBody: new Set([id("d1")]) } });
	assert.deepEqual(duty.ops, [{ op: "nsRestore", docId: "d1", path: "a.md", againstDeleteSeq: 41 }]);
	const duty2 = planWith(input(sc), { restoreDuty: new Set([id("d1")]) });
	assert.deepEqual(opsOf(duty2), ["nsRestore"]);
	const pend = run({ ...sc, remote: [R("d1", "a.md", { state: "deleted", deletedSeq: 41, pendingLocal: true })], over: { docsWithPendingBody: new Set([id("d1")]) } });
	assert.deepEqual(pend.ops, [{ op: "wait", docId: "d1", reason: "pending-ns" }]);
});

test("row deleted/absent/*: restore duty without a synced record -> nsRestore (claims the path); else nothing", () => {
	const del = R("d1", "a.md", { state: "deleted", deletedSeq: 41 });
	assert.deepEqual(run({ remote: [del] }).ops, []);
	const duty = planWith(input({ remote: [del] }), { restoreDuty: new Set([id("d1")]) });
	assert.deepEqual(duty.ops, [{ op: "nsRestore", docId: "d1", path: "a.md", againstDeleteSeq: 41 }]);
	assert.deepEqual(run({ remote: [del], over: { docsWithPendingBody: new Set([id("d1")]) } }).ops, [{ op: "nsRestore", docId: "d1", path: "a.md", againstDeleteSeq: 41 }]);
	// a stray local file at the path is not nsCreated next to the restore: it merges once live
	const stray = planWith(input({ remote: [del], local: [L("a.md", h("c9"))] }), { restoreDuty: new Set([id("d1")]) });
	assert.deepEqual(opsOf(stray), ["nsRestore"]);
	// pending own ns op or ns not ready -> nothing
	assert.deepEqual(planWith(input({ remote: [{ ...del, pendingLocal: true }] }), { restoreDuty: new Set([id("d1")]) }).ops, []);
	assert.deepEqual(planWith(input({ remote: [del] }), { restoreDuty: new Set([id("d1")]), nsReady: false }).ops, []);
});

test("row deleted/present/present changed -> nsRestore + content", () => {
	const md = run({ remote: [R("d1", "a.md", { state: "deleted", deletedSeq: 41 })], synced: [S("d1", "a.md")], local: [L("a.md", h("c1"))] });
	assert.deepEqual(md.ops, [
		{ op: "nsRestore", docId: "d1", path: "a.md", againstDeleteSeq: 41 },
		{ op: "reconcileContent", docId: "d1", path: "a.md", kind: "markdown", hasBase: true },
	]);
	const blob = run({ remote: [R("d9", "i.png", { state: "deleted", deletedSeq: 41 })], synced: [S("d9", "i.png")], local: [L("i.png", h("b7"), { size: 3 })] });
	assert.deepEqual(blob.ops, [
		{ op: "nsRestore", docId: "d9", path: "i.png", againstDeleteSeq: 41 },
		{ op: "nsSetBlob", docId: "d9", hash: h("b7"), size: 3, baseRev: 50 },
		{ op: "pushBlob", docId: "d9", path: "i.png", hash: h("b7"), size: 3 },
	]);
});

// ---------------------------------------------------------------------------
// Row: merged -> W
// ---------------------------------------------------------------------------

test("row merged: rebind then plan as the winner (E3: zero disk ops)", () => {
	const p = run({
		remote: [R("d4", "Inbox/x.md", { state: "merged", aliasOf: id("d3") }), R("d3", "Inbox/x.md", { createHash: h("X"), body: { ...R("d3", "a.md").body!, version: V(11) } })],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("X") })],
		local: [L("Inbox/x.md", h("X"))],
	});
	assert.deepEqual(p.ops, [
		{ op: "rebind", fromDocId: "d4", toDocId: "d3", path: "Inbox/x.md" },
		{ op: "reconcileContent", docId: "d3", path: "Inbox/x.md", kind: "markdown", hasBase: true },
	]);
	// winner not caught up: rebind, then wait (no materialize over the file)
	const behind = run({
		remote: [R("d4", "Inbox/x.md", { state: "merged", aliasOf: id("d3") }), R("d3", "Inbox/x.md", { body: { ...R("d3", "a.md").body!, version: V(11), caughtUp: false } })],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("X") })],
		local: [L("Inbox/x.md", h("X"))],
	});
	assert.deepEqual(opsOf(behind), ["rebind", "wait"]);
});

test("row merged, loser edited after its create: the dropped edit is local, no base (§c.13)", () => {
	// S of the loser records an edit that only lived in its dropped held frames: W holds the create text.
	const sc = (body: Partial<NonNullable<RemoteEntry["body"]>>): Scenario => ({
		remote: [R("d4", "x.md", { state: "merged", aliasOf: id("d3") }), R("d3", "x.md", { createHash: h("X"), body: { ...R("d3", "a.md").body!, version: V(11), ...body } })],
		synced: [S("d4", "x.md", { contentHash: h("X+mine") })],
		local: [L("x.md", h("X+mine"))],
	});
	assert.deepEqual(run(sc({})).ops, [
		{ op: "rebind", fromDocId: "d4", toDocId: "d3", path: "x.md" },
		{ op: "reconcileContent", docId: "d3", path: "x.md", kind: "markdown", hasBase: false },
	]);
	// W's initial frames still in flight: never merge against the empty text.
	assert.deepEqual(run(sc({ hasContent: false, version: V(0) })).ops, [
		{ op: "rebind", fromDocId: "d4", toDocId: "d3", path: "x.md" },
		{ op: "wait", docId: "d3", reason: "body-empty" },
	]);
});

test("row live/present/present: body without content, create not empty = wait body-empty unless S is born empty", () => {
	const empty = { ...R("d1", "a.md").body!, hasContent: false, version: V(0) };
	const p = run({ remote: [R("d1", "a.md", { body: empty })], synced: [S("d1", "a.md", { bodyVersion: V(3) })], local: [L("a.md", h("c0"))] });
	assert.deepEqual(p.ops, [{ op: "wait", docId: "d1", reason: "body-empty" }]);
	// Own create whose initial frames were never written (crash): born-empty S re-merges the disk text.
	const born = run({
		remote: [R("d1", "a.md", { body: empty })], synced: [S("d1", "a.md", { contentHash: EMPTY_CONTENT_HASH, bodyVersion: V(0), hasBase: false })], local: [L("a.md", h("c0"))],
	});
	assert.deepEqual(born.ops, [{ op: "reconcileContent", docId: "d1", path: "a.md", kind: "markdown", hasBase: false }]);
});

// ---------------------------------------------------------------------------
// Rows: absent (pruned) | present | *
// ---------------------------------------------------------------------------

test("row pruned: absent -> syncedDrop; unchanged -> diskTrash + syncedDrop; changed -> nsCreate fresh + content + drop", () => {
	assert.deepEqual(run({ synced: [S("d1", "a.md")] }).ops, [{ op: "syncedDrop", docId: "d1" }]);
	assert.deepEqual(opsOf(run({ synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] })), ["diskTrash", "syncedDrop"]);
	const changed = run({ synced: [S("d1", "a.md")], local: [L("a.md", h("c5"), { size: 77 })] });
	assert.deepEqual(changed.ops, [
		{ op: "nsCreate", docId: "fresh1", kind: "markdown", path: "a.md", contentHash: h("c5"), size: 77 },
		{ op: "reconcileContent", docId: "fresh1", path: "a.md", kind: "markdown", hasBase: false },
		{ op: "syncedDrop", docId: "d1" },
	]);
	assert.equal(changed.consumedDocIds, 1);
	// not before ns is ready: the entry may just not be read yet
	assert.deepEqual(run({ synced: [S("d1", "a.md")] }, { nsReady: false }).ops, []);
});

test("row pruned before ns is ready keeps S: an observed rename still moves the doc once ns is read", () => {
	// Sim seed 179: IDB wiped (mirrors kept), the user renamed a.md -> b.md, the ns was not read yet. S was
	// dropped as "pruned", so b.md became a new doc and the old doc came back at a.md on every device.
	const sc = { synced: [S("d1", "a.md")], local: [L("b.md", h("c0"))], over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } };
	assert.deepEqual(run(sc, { nsReady: false }).ops, []);
	const p = run({ ...sc, remote: [R("d1", "a.md")] });
	assert.deepEqual(opsOf(p), ["nsRename", "syncedPut"]);
	assert.deepEqual(find(p, "nsRename"), { op: "nsRename", docId: "d1", path: "b.md" });
});

// ---------------------------------------------------------------------------
// Row: live | absent | absent
// ---------------------------------------------------------------------------

test("row live/absent/absent: materialize once caught up and (hasContent or empty create)", () => {
	const body = R("d1", "a.md").body!;
	assert.deepEqual(run({ remote: [R("d1", "a.md")] }).ops, [{ op: "diskMaterialize", docId: "d1", path: "a.md", expect: { t: "absent" } }]);
	assert.deepEqual(run({ remote: [R("d1", "a.md", { body: { ...body, caughtUp: false } })] }).ops, [{ op: "wait", docId: "d1", reason: "body-not-caught-up" }]);
	assert.deepEqual(run({ remote: [R("d1", "a.md", { body: { ...body, hasContent: false } })] }).ops, [{ op: "wait", docId: "d1", reason: "body-empty" }]);
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md", { createHash: EMPTY_CONTENT_HASH, body: { ...body, hasContent: false } })] })), ["diskMaterialize"]);
	assert.deepEqual(opsOf(run({ remote: [R("d9", "i.png")] })), ["diskMaterialize"]);
	// live only through an own pending op (restore duty, no S): wait for the fold to place it
	assert.deepEqual(run({ remote: [R("d1", "a (2).md", { pendingLocal: true })] }).ops, [{ op: "wait", docId: "d1", reason: "pending-ns" }]);
	assert.deepEqual(run({ remote: [R("d9", "i.png", { pendingLocal: true })] }).ops, [{ op: "wait", docId: "d9", reason: "pending-ns" }]);
});

// ---------------------------------------------------------------------------
// Row: live | absent | present
// ---------------------------------------------------------------------------

test("row live/absent/present: md -> reconcileContent(no base); blob equal -> adopt; blob differs -> keep both", () => {
	assert.deepEqual(run({ remote: [R("d1", "a.md")], local: [L("a.md", h("c3"))] }).ops, [
		{ op: "reconcileContent", docId: "d1", path: "a.md", kind: "markdown", hasBase: false },
	]);
	const adopt = run({ remote: [R("d9", "i.png")], local: [L("i.png", h("b0"))] });
	assert.deepEqual(opsOf(adopt), ["syncedPut"]);
	assert.equal(adopt.ops[0]!.op === "syncedPut" && adopt.ops[0]!.entry.blobRev, 50);
	const keep = run({ remote: [R("d9", "i.png")], local: [L("i.png", h("b8"))] });
	assert.deepEqual(opsOf(keep), ["nsCreate", "conflictCopy", "fetchBlob", "pushBlob"]);
	assert.equal(find(keep, "conflictCopy").reason, "no-base");
	// body not caught up / empty body that is not an empty create -> wait
	const body = R("d1", "a.md").body!;
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md", { body: { ...body, caughtUp: false } })], local: [L("a.md", h("c3"))] })), ["wait"]);
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md", { body: { ...body, hasContent: false } })], local: [L("a.md", h("c3"))] })), ["wait"]);
});

test("lost create body (own create, no rows, nothing pending, no synced record): push the file, or drop the empty doc", () => {
	// Sim heavy seeds 17, 90, 194: the creator's store (and mirrors) went before its initial frames were acked;
	// every device then waited "body-empty" forever, with the text only on the creator's disk.
	const empty = { ...R("d1", "a.md").body!, hasContent: false, version: V(0) };
	const lost = { lostCreateBody: new Set([id("d1")]) };
	const present = { remote: [R("d1", "a.md", { body: empty })], local: [L("a.md", h("c3"))] };
	assert.deepEqual(run(present).ops, [{ op: "wait", docId: "d1", reason: "body-empty" }]);
	const push = run(present, lost);
	assert.deepEqual(push.ops, [{ op: "reconcileContent", docId: "d1", path: "a.md", kind: "markdown", hasBase: false }]);
	assert.equal(push.brake, null);
	// The file is gone too (moved or deleted while the store was down): the empty doc is deleted.
	const absent = { remote: [R("d1", "a.md", { body: empty })] };
	assert.deepEqual(run(absent).ops, [{ op: "wait", docId: "d1", reason: "body-empty" }]);
	assert.deepEqual(run(absent, lost).ops, [{ op: "nsDelete", docId: "d1", baseBodySeq: 0 }]);
	assert.deepEqual(run({ ...absent, over: { localComplete: false } }, lost).ops, []);
	assert.deepEqual(run(absent, { ...lost, nsReady: false }).ops, []);
	assert.deepEqual(run({ remote: [R("d1", "a.md", { body: empty, pendingLocal: true })] }, lost).ops, [{ op: "wait", docId: "d1", reason: "pending-ns" }]);
	// A moved file is a new doc next to the delete.
	assert.deepEqual(opsOf(run({ ...absent, local: [L("b.md", h("c3"))] }, lost)), ["nsDelete", "nsCreate", "reconcileContent"]);
});

// ---------------------------------------------------------------------------
// Row: absent | absent | present ; frozen ; needHash
// ---------------------------------------------------------------------------

test("row absent/absent/present: portable -> nsCreate + initial content; not portable / excluded -> nothing", () => {
	assert.deepEqual(run({ local: [L("n.md", h("c1"), { size: 5 })] }).ops, [
		{ op: "nsCreate", docId: "fresh1", kind: "markdown", path: "n.md", contentHash: h("c1"), size: 5 },
		{ op: "reconcileContent", docId: "fresh1", path: "n.md", kind: "markdown", hasBase: false },
	]);
	assert.deepEqual(run({ local: [L("p.pdf", h("p1"), { size: 5 })] }).ops, [
		{ op: "nsCreate", docId: "fresh1", kind: "blob", path: "p.pdf", contentHash: h("p1"), size: 5 },
		{ op: "pushBlob", docId: "fresh1", path: "p.pdf", hash: h("p1"), size: 5 },
	]);
	assert.deepEqual(run({ local: [L("bad:name.md", h("c1"))] }).ops, []);
	assert.deepEqual(run({ local: [L("con.md", h("c1"))] }).ops, []);
	assert.deepEqual(run({ local: [L("x.md", h("c1"), { excluded: true })] }).ops, []);
	assert.deepEqual(run({ local: [L("x.md", null)] }).ops, [{ op: "needHash", path: "x.md" }]);
	// out of fresh ids: creates wait for the next pass
	const many = run({ local: ["1", "2", "3", "4", "5"].map((n) => L(`${n}.md`, h(n))), over: { freshDocIds: [id("only")] } });
	assert.equal(many.ops.filter((o) => o.op === "nsCreate").length, 1);
	assert.equal(many.consumedDocIds, 1);
});

test("row frozen body: wait(frozen), nothing else", () => {
	const body = { ...R("d1", "a.md").body!, frozen: true, version: V(99) };
	assert.deepEqual(run({ remote: [R("d1", "b.md", { body })], synced: [S("d1", "a.md")], local: [L("a.md", h("c1"))] }).ops, [{ op: "wait", docId: "d1", reason: "frozen" }]);
	assert.deepEqual(run({ remote: [R("d1", "a.md", { body })] }).ops, [{ op: "wait", docId: "d1", reason: "frozen" }]);
});

// ---------------------------------------------------------------------------
// Worked examples and fold duties
// ---------------------------------------------------------------------------

test("E2: collision suffix -> loser diskRename before the winner materializes", () => {
	const p = planWith(input({
		remote: [R("d1", "Notes/a.md"), R("d2", "Notes/A (2).md", { lastTouchSeq: 7 })],
		synced: [S("d2", "notes/A.md", { contentHash: h("h2"), nsTouchSeq: 0 })],
		local: [L("notes/A.md", h("h2"))],
	}), { remoteTextHash: new Map([[id("d1"), h("h1")]]) });
	assert.deepEqual(opsOf(p), ["diskRename", "diskMaterialize", "syncedPut"]);
	assert.deepEqual(p.ops[0], { op: "diskRename", docId: "d2", from: "notes/A.md", to: "Notes/A (2).md", expect: { t: "hash", hash: h("h2") } });
	assert.deepEqual(p.ops[1], { op: "diskMaterialize", docId: "d1", path: "Notes/a.md", expect: { t: "absent" } });
});

test("E4: ancestor is a file -> rename out of the folder, then materialize the blob at the folder path", () => {
	const p = run({
		remote: [R("d5", "Projects", { kind: "blob", blob: { hash: h("p"), size: 3, rev: 9 }, body: null }), R("d6", "Projects (2)/plan.md")],
		synced: [S("d6", "Projects/plan.md", { nsTouchSeq: 0 })],
		local: [L("Projects/plan.md", h("c0"))],
	});
	assert.deepEqual(opsOf(p), ["diskRename", "diskMaterialize", "syncedPut"]);
	assert.equal(find(p, "diskRename").to, "Projects (2)/plan.md");
	assert.equal(find(p, "diskMaterialize").path, "Projects");
});

test("S1 identical-loser collapse: rebind to the winner + nsDelete(loser), no disk op", () => {
	const p = planWith(input({
		remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md")],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("X"), nsTouchSeq: 0 })],
		local: [L("Inbox/x.md", h("X"))],
	}), { remoteTextHash: new Map([[id("d3"), h("X")]]) });
	assert.deepEqual(p.ops, [
		{ op: "rebind", fromDocId: "d4", toDocId: "d3", path: "Inbox/x.md" },
		{ op: "nsDelete", docId: "d4", baseBodySeq: 10 },
	]);
	// a non-create (nsTouchSeq > 0) never collapses: it is a plain remote move
	const moved = planWith(input({
		remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md")],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("X"), nsTouchSeq: 4 })],
		local: [L("Inbox/x.md", h("X"))],
	}), { remoteTextHash: new Map([[id("d3"), h("X")]]) });
	assert.deepEqual(opsOf(moved), ["diskRename", "diskMaterialize", "syncedPut"]);
});

test("§c.12 migrated-loser merge: a differing loser at a path with an old-epoch base merges into the winner", () => {
	const sc = {
		remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md")],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("L"), nsTouchSeq: 0 })],
		local: [L("Inbox/x.md", h("L"))],
	};
	const ctx = { remoteTextHash: new Map([[id("d3"), h("W")]]) };
	// No path base: a plain loser rename.
	assert.deepEqual(opsOf(planWith(input(sc), ctx)), ["diskRename", "diskMaterialize", "syncedPut"]);
	const p = planWith(input(sc), { ...ctx, pathBaseKeys: new Set([pk("Inbox/x.md")]) });
	assert.deepEqual(p.ops, [
		// adopt: the loser's sync point (its own text) is not the winner's (diskJobs.ts rebind).
		{ op: "rebind", fromDocId: "d4", toDocId: "d3", path: "Inbox/x.md", adopt: true },
		{ op: "nsDelete", docId: "d4", baseBodySeq: 10 },
		{ op: "reconcileContent", docId: "d3", path: "Inbox/x.md", kind: "markdown", hasBase: false, pathBase: true },
	]);
	// The winner's body must be readable first.
	const empty = { ...sc, remote: [R("d3", "Inbox/x.md", { body: { ...R("d3", "Inbox/x.md").body!, hasContent: false } }), R("d4", "Inbox/x (2).md")] };
	assert.deepEqual(planWith(input(empty), { ...ctx, pathBaseKeys: new Set([pk("Inbox/x.md")]) }).ops, [{ op: "wait", docId: "d4", reason: "body-empty" }]);
});

test("remote-move target already on disk (crash after rename): adopt the path, no disk op", () => {
	const p = run({ remote: [R("d1", "b.md", { lastTouchSeq: 8 })], synced: [S("d1", "a.md")], local: [L("b.md", h("c0"))] });
	assert.deepEqual(opsOf(p), ["syncedPut"]);
	assert.equal(find(p, "syncedPut").entry.path, "b.md");
});

test("remote move onto a new local file: the file is created (fold suffixes it), the move waits for the path", () => {
	// d1 synced at a.md (file still there); the remote moved it to b.md, where this device has a new file.
	const sc = { remote: [R("d1", "b.md", { lastTouchSeq: 9 })], synced: [S("d1", "a.md")], local: [L("a.md", h("c0")), L("b.md", h("n1"))] };
	const p = run(sc);
	assert.deepEqual(opsOf(p), ["nsCreate", "reconcileContent"]);
	assert.equal(find(p, "nsCreate").path, "b.md");
	// The move becomes possible once the new file's loser rename frees b.md.
	const later = run({ ...sc, remote: [...sc.remote, R("fresh1", "b (2).md")], synced: [...sc.synced, S("fresh1", "b.md", { contentHash: h("n1"), nsTouchSeq: 0 })] });
	assert.deepEqual(later.ops.filter((o) => o.op === "diskRename").map((o) => o.op === "diskRename" && `${o.from}>${o.to}`), ["b.md>b (2).md", "a.md>b.md"]);
	// A chain (the occupant moves away in the same plan) is not blocked.
	const chain = run({
		remote: [R("d1", "b.md"), R("d2", "c.md")],
		synced: [S("d1", "a.md", { contentHash: h("1") }), S("d2", "b.md", { contentHash: h("2") })],
		local: [L("a.md", h("1")), L("b.md", h("2"))],
	});
	assert.deepEqual(chain.ops.filter((o) => o.op === "diskRename").map((o) => o.op === "diskRename" && `${o.from}>${o.to}`), ["b.md>c.md", "a.md>b.md"]);
	assert.ok(!opsOf(chain).includes("nsCreate"));
});

test("rename cycle a<->b goes through a temp name", () => {
	const p = run({
		remote: [R("d1", "b.md"), R("d2", "a.md")],
		synced: [S("d1", "a.md", { contentHash: h("1") }), S("d2", "b.md", { contentHash: h("2") })],
		local: [L("a.md", h("1")), L("b.md", h("2"))],
	});
	const renames = p.ops.filter((o): o is Extract<PlannerOp, { op: "diskRename" }> => o.op === "diskRename").map((o) => `${o.from}>${o.to}`);
	assert.equal(renames.length, 3);
	// simulate on a set of paths: every rename's target must be free when it runs
	const disk = new Set(["a.md", "b.md"]);
	for (const r of renames) {
		const [from, to] = r.split(">") as [string, string];
		assert.ok(disk.has(from), r);
		assert.ok(!disk.has(to), `target taken: ${r}`);
		disk.delete(from);
		disk.add(to);
	}
	assert.deepEqual([...disk].sort(), ["a.md", "b.md"]);
});

test("gate: ns not ready -> no ns ops and no ns-derived moves/deletes", () => {
	const ctx = { nsReady: false };
	assert.deepEqual(run({ local: [L("n.md", h("c1"))] }, ctx).ops, []);
	// (a missing file only records the decided delete: fileGone)
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")] }, ctx)), ["syncedPut"]);
	assert.deepEqual(run({ remote: [R("d1", "b.md")], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] }, ctx).ops, []);
	assert.deepEqual(run({ remote: [R("d1", "a.md", { state: "deleted", deletedSeq: 3 })], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"))] }, ctx).ops, []);
	// body-driven materialization still runs
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md")] }, ctx)), ["diskMaterialize"]);
});

test("scope docs: only the touched docs and keys are planned", () => {
	const sc: Scenario = {
		remote: [R("d1", "a.md", { body: { ...R("d1", "a.md").body!, version: V(11) } }), R("d2", "b.md")],
		synced: [S("d1", "a.md"), S("d2", "b.md")],
		local: [L("a.md", h("c0")), L("new.md", h("n"))],
	};
	const p = run({ ...sc, over: { scope: { t: "docs", docIds: [id("d1")], pathKeys: [] } } });
	assert.deepEqual(opsOf(p), ["reconcileContent"]);
	const q = run({ ...sc, over: { scope: { t: "docs", docIds: [], pathKeys: [pk("new.md")] } } });
	assert.deepEqual(opsOf(q), ["nsCreate", "reconcileContent"]);
	assert.equal(find(q, "nsCreate").path, "new.md");
});

// ---------------------------------------------------------------------------
// Brake
// ---------------------------------------------------------------------------

function deletes(n: number, synced: number, extraLocal = 0): Scenario {
	const remote: RemoteEntry[] = [];
	const syncedE: SyncedEntry[] = [];
	const local: LocalEntry[] = [];
	for (let i = 0; i < synced; i++) {
		const p = `n${String(i).padStart(4, "0")}.md`;
		remote.push(R(`d${i}`, p));
		syncedE.push(S(`d${i}`, p));
		if (i >= n) local.push(L(p, h("c0")));
	}
	for (let i = 0; i < extraLocal; i++) local.push(L(`x${i}.png`, h(`x${i}`), { excluded: true }));
	return { remote, synced: syncedE, local };
}

test("brake: mass-delete-local holds above max(minCount, ratio*|S|)", () => {
	const at = run(deletes(50, 200));
	assert.equal(at.brake, null);
	assert.equal(at.ops.filter((o) => o.op === "nsDelete").length, 50);
	const over = run(deletes(51, 200));
	assert.equal(over.brake?.reason, "mass-delete-local");
	assert.equal(over.brake?.heldCount, 51);
	assert.equal(over.ops.filter((o) => o.op === "nsDelete").length, 0);
	assert.equal(over.held.filter((o) => o.op === "nsDelete").length, 51);
	assert.equal(over.held.filter((o) => o.op === "syncedDrop").length, 51, "syncedDrop is held with its delete");
	// ratio dominates for big vaults: 20% of 1000 = 200
	assert.equal(run(deletes(200, 1000)).brake, null);
	assert.equal(run(deletes(201, 1000)).brake?.reason, "mass-delete-local");
	// rolling window adds to the per-plan count
	assert.equal(run(deletes(10, 200), { brakeWindow: { nsDelete: 41, diskTrash: 0, overwrite: 0, conflict: 0 } }).brake?.reason, "mass-delete-local");
	assert.equal(run(deletes(10, 200), { brakeWindow: { nsDelete: 40, diskTrash: 0, overwrite: 0, conflict: 0 } }).brake, null);
	// deletes that wait (ns not ready) hold their fileGone marks the same way; the decided deletes are not braked again
	const marks = run(deletes(51, 200), { nsReady: false });
	assert.equal(marks.brake?.reason, "mass-delete-local");
	assert.equal(marks.ops.filter((o) => o.op === "syncedPut").length, 0);
	assert.equal(marks.held.filter((o) => o.op === "syncedPut" && o.entry.fileGone).length, 51);
	assert.equal(run(deletes(50, 200), { nsReady: false }).ops.filter((o) => o.op === "syncedPut").length, 50);
	const decided = deletes(51, 200);
	const goneAll = run({ ...decided, synced: decided.synced!.map((s, i) => (i < 51 ? { ...s, fileGone: true as const } : s)) });
	assert.equal(goneAll.brake, null);
	assert.equal(goneAll.ops.filter((o) => o.op === "nsDelete").length, 51);
});

test("brake: mass-delete-remote, listing-shrank, conflict-flood, ns-divergence", () => {
	const trash = (n: number) => {
		const sc = deletes(0, 100);
		return { ...sc, remote: sc.remote!.map((r, i) => (i < n ? { ...r, state: "deleted" as const, deletedSeq: 70 } : r)) };
	};
	assert.equal(run(trash(50)).brake, null);
	const t = run(trash(51));
	assert.equal(t.brake?.reason, "mass-delete-remote");
	assert.equal(t.held.filter((o) => o.op === "diskTrash").length, 51);

	// listing shrank: 49 of 100 present -> every destructive op held, even a single delete count
	const shrank = run(deletes(51, 100));
	assert.equal(shrank.brake?.reason, "listing-shrank");
	// listing-shrank needs a full, complete listing
	const scoped = run({ ...deletes(51, 100), over: { localComplete: false } });
	assert.equal(scoped.brake, null);

	// conflict flood: 201 certain no-base conflicts
	const remote: RemoteEntry[] = [];
	const local: LocalEntry[] = [];
	const hashes = new Map<DocId, ReturnType<typeof h>>();
	for (let i = 0; i < 201; i++) {
		remote.push(R(`r${i}`, `c${i}.md`));
		local.push(L(`c${i}.md`, h(`l${i}`)));
		hashes.set(id(`r${i}`), h(`r${i}`));
	}
	const flood = planWith(input({ remote, local }), { remoteTextHash: hashes });
	assert.equal(flood.brake?.reason, "conflict-flood");
	assert.equal(flood.held.length, 201);
	const under = planWith(input({ remote: remote.slice(1), local: local.slice(1) }), { remoteTextHash: hashes });
	assert.equal(under.brake, null);

	const div = run(deletes(1, 100), { divergence: true });
	assert.equal(div.brake?.reason, "ns-divergence");
	assert.equal(div.ops.filter((o) => o.op === "nsDelete").length, 0);
});

test("brake: id is stable across re-plans (fresh ids, time, map order) and approval releases exactly that set", async () => {
	const sc = deletes(60, 200);
	const a = run(sc);
	const b = run({ ...sc, remote: [...sc.remote!].reverse(), synced: [...sc.synced!].reverse(), over: { nowMs: 5, freshDocIds: [id("zz")] } });
	assert.ok(a.brake && b.brake);
	assert.equal(a.brake.identity, b.brake.identity);
	assert.match(await brakeId(refHashPort, a.brake.identity), /^[0-9a-f]{64}$/);
	const approved = run({ ...sc, over: { brakeApproval: a.brake.identity } });
	assert.equal(approved.brake, null);
	assert.equal(approved.ops.filter((o) => o.op === "nsDelete").length, 60);
	// one more delete changes the held set: the old approval no longer applies
	const grown = run({ ...deletes(61, 200), over: { brakeApproval: a.brake.identity } });
	assert.ok(grown.brake);
	assert.notEqual(grown.brake.identity, a.brake.identity);
	assert.equal(grown.ops.filter((o) => o.op === "nsDelete").length, 0);
	// non-destructive ops still run while the brake holds
	const mixed = run({ ...sc, local: [...sc.local!, L("brand-new.md", h("q"))] });
	assert.ok(mixed.brake);
	assert.ok(opsOf(mixed).includes("nsCreate"));
});

test("brake: shrinking blob overwrite counts as mass-overwrite", () => {
	const remote: RemoteEntry[] = [];
	const synced: SyncedEntry[] = [];
	const local: LocalEntry[] = [];
	for (let i = 0; i < 60; i++) {
		remote.push(R(`b${i}`, `i${i}.png`, { blob: { hash: h(`n${i}`), size: 10, rev: 51 } }));
		synced.push(S(`b${i}`, `i${i}.png`));
		local.push(L(`i${i}.png`, h("b0"), { size: 10_000 }));
	}
	const p = run({ remote, synced, local });
	assert.equal(p.brake?.reason, "mass-overwrite");
	assert.equal(p.held.length, 60);
	// growing overwrites are not destructive
	const grow = run({ remote: remote.map((r) => ({ ...r, blob: { ...r.blob!, size: 20_000 } })), synced, local });
	assert.equal(grow.brake, null);
});

// ---------------------------------------------------------------------------
// Purity and determinism
// ---------------------------------------------------------------------------

function shuffled<T>(xs: readonly T[], rnd: () => number): T[] {
	const a = [...xs];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

function randomScenario(seed: number): Scenario {
	const rnd = prng(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
	const remote: RemoteEntry[] = [];
	const synced: SyncedEntry[] = [];
	const local: LocalEntry[] = [];
	const names = ["a.md", "b.md", "A.md", "dir/a.md", "Dir/b.md", "i.png", "j.png", "x.canvas", "c.md", "dir/i.png"];
	const usedR = new Set<string>();
	const usedL = new Set<string>();
	for (let i = 0; i < 8; i++) {
		const docId = `d${i}`;
		const p = pick(names);
		const kind = p.endsWith(".png") ? "blob" : undefined;
		const hashes = [h("c0"), h("c1"), h("b0"), h("b1")];
		if (rnd() < 0.8 && !usedR.has(pk(p))) {
			usedR.add(pk(p));
			const state = pick(["live", "live", "live", "deleted"] as const);
			remote.push(R(docId, p, { state, deletedSeq: state === "deleted" ? 40 : 0, pendingLocal: rnd() < 0.15, ...(kind ? {} : { body: { ...R(docId, "q.md").body!, version: V(pick([10, 11])), caughtUp: rnd() < 0.9 } }) }));
		}
		if (rnd() < 0.6) synced.push(S(docId, rnd() < 0.7 ? p : pick(names), { nsTouchSeq: pick([0, 5]) }));
		const lp = pick(names);
		if (rnd() < 0.7 && !usedL.has(pk(lp))) {
			usedL.add(pk(lp));
			local.push(L(lp, rnd() < 0.1 ? null : pick(hashes)));
		}
	}
	// synced pathKeys must be unique (store invariant)
	const seen = new Set<string>();
	return { remote, synced: synced.filter((s) => (seen.has(s.pathKey) ? false : (seen.add(s.pathKey), true))), local };
}

test("planner is deterministic, shuffle-invariant and does not mutate its input (2000 random scenarios)", () => {
	for (let seed = 1; seed <= 2000; seed++) {
		const sc = randomScenario(seed);
		const rnd = prng(seed * 7919);
		const renames = rnd() < 0.3 && sc.local!.length > 0 && sc.synced!.length > 0 ? [{ from: sc.synced![0]!.path, to: sc.local![0]!.path, atMs: 1 }] : [];
		const inp = input({ ...sc, over: { renames } });
		const snapshot = JSON.stringify(inp, (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v));
		const p1 = plan(inp);
		assert.equal(JSON.stringify(inp, (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v)), snapshot, `mutated input seed ${seed}`);
		const p2 = plan(input({ remote: shuffled(sc.remote!, rnd), synced: shuffled(sc.synced!, rnd), local: shuffled(sc.local!, rnd), over: { renames } }));
		assert.deepEqual(p2, p1, `seed ${seed}`);
		// invariants: every destructive disk op carries a precondition; no op for an excluded file
		for (const op of [...p1.ops, ...p1.held]) {
			if (op.op === "diskTrash" || op.op === "diskRename" || op.op === "conflictCopy") assert.equal(op.expect.t, "hash", `seed ${seed}`);
			if (op.op === "diskMaterialize") assert.equal(op.expect.t, "absent");
		}
	}
});

test("plan() equals planWith() with default context; untouched fixtures give empty plan", () => {
	const inp = input({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], local: [L("a.md", h("c0"), { fingerprint: fp("c0") })] });
	assert.deepEqual(plan(inp), planWith(inp));
	assert.deepEqual(plan(inp), { ops: [], held: [], brake: null, consumedDocIds: 0 });
	assert.equal(DEFAULT_BRAKE.minCount, 50);
});

export type _Unused = PlannerInput;
