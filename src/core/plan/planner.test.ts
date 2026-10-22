import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId, LocalEntry, Plan, PlannerInput, PlannerOp, RemoteEntry, SyncedEntry } from "../types";
import { EMPTY_CONTENT_HASH, freshIdBudget, plan, planWith } from "./planner";
import { brakeId, DEFAULT_BRAKE } from "./brake";
import { refHashPort } from "../hash/testkit/hashRef";
import { L, R, S, V, fp, h, id, input, pk, type Scenario } from "./testkit/planFixtures";
import { prng } from "../merge/testkit/prng";

const opsOf = (p: Plan): string[] => p.ops.map((o) => o.op);
const find = <K extends PlannerOp["op"]>(p: Plan, k: K): Extract<PlannerOp, { op: K }> => {
	const op = p.ops.find((o) => o.op === k);
	assert.ok(op, `expected op ${k} in ${JSON.stringify(opsOf(p))}`);
	return op as Extract<PlannerOp, { op: K }>;
};
/**
 * Every plan here also checks the reconciler's fresh-docId budget: a row taking more ids than freshIdBudget counts is
 * starved in the engine (takeFresh returns null), however many ids the fixture hands it (d1f8a750's pruned re-create).
 */
const run = (sc: Scenario, ctx: Parameters<typeof planWith>[1] = {}): Plan => {
	const inp = input(sc);
	const p = planWith(inp, ctx);
	const budget = freshIdBudget(inp.synced, inp.local, inp.remote, (d) => inp.docsWithPendingBody.has(d) || (ctx?.restoreDuty?.has(d) ?? false));
	assert.ok(p.consumedDocIds <= budget, `plan took ${p.consumedDocIds} fresh docIds, freshIdBudget allows ${budget}: ${JSON.stringify(p.ops)}`);
	return p;
};

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

test("row live/present/present: S behind a move (stale mirror), the doc's bytes at R.path and other bytes at S.path -> the doc is at R.path", () => {
	// Sim seed 630 F DEV3 (production checkpoints): after an IDB loss B's S for its attachment came back from a mirror
	// older than the fold's suffix move a2 -> "a2 (2)"; C's attachment had taken a2. The planner trashed B's own
	// file at "a2 (2)" as a copy, moved C's file there and pushed C's bytes as an edit of B's attachment.
	const base = { remote: [R("d9", "a (2).png")], synced: [S("d9", "a.png")] };
	const p = run({ ...base, local: [L("a.png", h("b9")), L("a (2).png", h("b0"))] });
	assert.deepEqual(p.ops, [{ op: "syncedPut", entry: { ...S("d9", "a (2).png"), fingerprint: fp("b0") } }]);
	// next pass, S moved: the other file is new
	const next = run({ ...base, synced: [S("d9", "a (2).png", { fingerprint: fp("b0") })], local: [L("a.png", h("b9")), L("a (2).png", h("b0"))] });
	assert.deepEqual(opsOf(next), ["nsCreate", "pushBlob"]);
	assert.equal(find(next, "nsCreate").path, "a.png");
	// the remote changed the doc since S: no claim from bytes (the file at S.path stays the doc's, as before)
	const changed = run({ remote: [R("d9", "a (2).png", { blob: { hash: h("b5"), size: 10, rev: 51 } })], synced: [S("d9", "a.png")], local: [L("a.png", h("b9")), L("a (2).png", h("b0"))] });
	assert.equal(find(changed, "conflictCopy").from, "a.png");
	assert.ok(!changed.ops.some((o) => o.op === "syncedPut" && o.entry.docId === "d9" && o.entry.path === "a (2).png"));
	// markdown: the same rule, through the remote text hash
	const md = planWith(input({ remote: [R("d1", "b.md")], synced: [S("d1", "a.md")], local: [L("a.md", h("c9")), L("b.md", h("c0"))] }), { remoteTextHash: new Map([[id("d1"), h("c0")]]) });
	assert.deepEqual(opsOf(md), ["syncedPut"]);
	assert.equal(find(md, "syncedPut").entry.path, "b.md");
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
	// the file left a.md either way; the mark keeps the observed rename (test below)
	assert.deepEqual(run(renamed, { nsReady: false }).ops, [{ op: "syncedPut", entry: { ...S("d1", "a.md"), fileGone: true, renamedTo: { to: "b.md", atMs: 1 } } }]);
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

test("an untracked file of a remote doc renamed away (observed): the doc moves with it and merges it against the base the old path kept", () => {
	// Sim suite-1 wipe/revoke/roll seed 40: after an epoch restore (synced records dropped, bases kept by path) a canvas
	// edited while key-missing was renamed. The renamed file became a new doc, and the doc came back at the old path
	// with the record the user had deleted.
	const sc = { remote: [R("d1", "a.md")], local: [L("b.md", h("c9"))], over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } };
	const p = run(sc);
	assert.deepEqual(p.ops, [
		{ op: "nsRename", docId: "d1", path: "b.md" },
		{ op: "reconcileContent", docId: "d1", path: "b.md", kind: "markdown", hasBase: false, basePath: "a.md" },
	]);
	// not while ns is not ready (no inference), and never without the observed rename
	assert.deepEqual(run(sc, { nsReady: false }).ops, []);
	const byHash = run({ ...sc, over: {} });
	assert.deepEqual(opsOf(byHash).sort(), ["diskMaterialize", "nsCreate", "reconcileContent"].sort());
	// a file back at the source path is the doc's, merged there; the renamed file is new
	const back = run({ ...sc, local: [L("a.md", h("c7")), L("b.md", h("c9"))] });
	assert.ok(!opsOf(back).includes("nsRename"), JSON.stringify(back.ops));
	// a target at another remote doc's path is that rule's (observed onto), not this one
	const onto = run({ ...sc, remote: [R("d1", "a.md"), R("d2", "b.md")] });
	assert.ok(!onto.ops.some((o) => o.op === "nsRename" && o.docId === "d1"), JSON.stringify(onto.ops));
	// body not caught up: the doc waits, the file is not created meanwhile
	const behind = run({ ...sc, remote: [R("d1", "a.md", { body: { ...R("d1", "a.md").body!, caughtUp: false } })] });
	assert.deepEqual(behind.ops, [{ op: "wait", docId: "d1", reason: "body-not-caught-up" }]);
	// ... and only memory has the rename (no synced record to keep it on): the plan asks to keep it (sim suite-1
	// wipe/revoke/roll seed 40, 16 steps: dropped after this wait, the file became a new doc on the next pass)
	assert.deepEqual(behind.keepRenames, [{ from: "a.md", to: "b.md", atMs: 1 }]);
	assert.equal(p.keepRenames, undefined, "moved: nothing to keep");
});

test("a rename onto the same path key (case only, or the same path) does not hold the doc's edits while ns is not ready", () => {
	// Hot canvas seed 208 (suite 1): B, offline after an IDB loss, saw canvas/c0.canvas renamed to itself. The path
	// counted as "left by a rename" (the file there may be new), so no pass merged the doc until ns was ready, and a
	// record delete made meanwhile never reached the CRDT. The file at a same-key target is the renamed file itself.
	const sc = { remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], local: [L("a.md", h("c9"))] };
	for (const from of ["a.md", "A.md"]) {
		const p = run({ ...sc, over: { renames: [{ from, to: "a.md", atMs: 1 }] } }, { nsReady: false });
		assert.deepEqual(opsOf(p), ["reconcileContent"], from);
	}
	// a rename off the path to another key still holds it (the file at a.md may be new)
	assert.deepEqual(run({ ...sc, over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } }, { nsReady: false }).ops, []);
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

test("observed rename off a source path re-occupied by S's own bytes: the moved file merges with no base", () => {
	// Sim hot canvas seed 0: A's user renamed boards/c2 -> boards/c1 while the engine recovered from an IDB wipe.
	// The engine found boards/c2 gone before the rename event arrived and re-materialized the doc there (S = the
	// projection, base included). The late event then moved S onto boards/c1, whose older bytes merged against the
	// projection as the base: every record a peer had added since read as a local delete (B's node and its
	// later edits were lost). S describes the file at the source, not the moved one.
	const sc = { remote: [R("d1", "a.md")], synced: [S("d1", "a.md")], over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } };
	const p = run({ ...sc, local: [L("a.md", h("c0")), L("b.md", h("c3"))] });
	assert.deepEqual(find(p, "nsRename"), { op: "nsRename", docId: "d1", path: "b.md" });
	assert.deepEqual(find(p, "reconcileContent"), { op: "reconcileContent", docId: "d1", path: "b.md", kind: "markdown", hasBase: false, noBase: true });
	// a new file of other bytes at the source: S still describes the moved file, its base stands
	const other = run({ ...sc, local: [L("a.md", h("c7")), L("b.md", h("c3"))] });
	assert.deepEqual(find(other, "reconcileContent"), { op: "reconcileContent", docId: "d1", path: "b.md", kind: "markdown", hasBase: true });
	// canvas alike
	const cv = { remote: [R("d1", "a.canvas")], synced: [S("d1", "a.canvas")], over: { renames: [{ from: "a.canvas", to: "b.canvas", atMs: 1 }] } };
	const pc = run({ ...cv, local: [L("a.canvas", h("c0")), L("b.canvas", h("c3"))] });
	assert.equal(find(pc, "reconcileContent").noBase, true);
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

test("row live/present/absent: an observed rename that waits on ns survives an engine restart in the fileGone mark", () => {
	// Sim hot canvas seed 705: B, offline after a crash (ns not ready), renamed c0 -> boards/c2, edited it and created
	// a new c0. The pass marked the doc's file gone; the observed rename lived only in memory and a second crash
	// dropped it. Online, the doc's file was gone and its path held a new file: edit beats delete merged the new
	// canvas into the doc, deleting every record of the old one (A's concurrent text edit went with its node), and
	// boards/c2 became a new doc.
	const base = { remote: [R("d1", "a.canvas")], synced: [S("d1", "a.canvas")] };
	const renames = [{ from: "a.canvas", to: "b.canvas", atMs: 7 }];
	const waiting = run({ ...base, local: [L("b.canvas", h("c3"))], over: { renames } }, { nsReady: false });
	const gone = { ...S("d1", "a.canvas"), fileGone: true as const, renamedTo: { to: "b.canvas", atMs: 7 } };
	assert.deepEqual(waiting.ops, [{ op: "syncedPut", entry: gone }]);
	// restarted (no observed renames), ns ready, a peer edited the doc, a new file at its old path
	const edited = R("d1", "a.canvas", { body: { ...R("d1", "a.canvas").body!, version: V(11) } });
	const after = run({ remote: [edited], synced: [gone], local: [L("a.canvas", h("c7")), L("b.canvas", h("c3"))] });
	assert.deepEqual(find(after, "nsRename"), { op: "nsRename", docId: "d1", path: "b.canvas" });
	assert.deepEqual(opsOf(after), ["nsRename", "reconcileContent"]);
	assert.equal(find(after, "reconcileContent").path, "b.canvas");
	// the new file at the old path is created once the doc's record has left it
	const next = run({ remote: [R("d1", "b.canvas")], synced: [S("d1", "b.canvas", { contentHash: h("c3") })], local: [L("a.canvas", h("c7")), L("b.canvas", h("c3"))] });
	assert.equal(find(next, "nsCreate").path, "a.canvas");
	// the doc's record at the new path carries neither mark
	const moved = run({ remote: [R("d1", "a.canvas")], synced: [gone], local: [L("b.canvas", h("c0"))] });
	const put = find(moved, "syncedPut").entry;
	assert.equal(put.path, "b.canvas");
	assert.equal(put.fileGone, undefined);
	assert.equal(put.renamedTo, undefined);
});

test("a file another doc's observed rename brought onto a fileGone path is that doc's, not a save of the gone doc", () => {
	// Sim seed 703 F DEV3: offline, A renamed seed0 -> r6 and deleted r6 (the delete waited: fileGone), then renamed
	// seed2 -> r6; a peer deleted seed2's doc and edited seed0's. The kept rename could not pair seed2's doc with r6
	// (r6 was the gone doc's synced path), so seed2's doc was restored at seed2 and r6 merged into seed0's doc as
	// edit beats delete: a conflict copy every pass, and the disk never converged.
	const edited = R("d1", "r6.md", { body: { ...R("d1", "r6.md").body!, version: V(11) } });
	const del = R("d2", "seed2.md", { state: "deleted", deletedSeq: 57 });
	const gone1 = { ...S("d1", "r6.md"), fileGone: true as const };
	const gone2 = { ...S("d2", "seed2.md", { contentHash: h("c2") }), fileGone: true as const, renamedTo: { to: "r6.md", atMs: 9 } };
	const sc = { remote: [edited, del], synced: [gone1, gone2], local: [L("r6.md", h("c5"))] };
	const p = planWith(input(sc), { restoreDuty: new Set([id("d2")]) });
	assert.deepEqual(find(p, "nsRestore"), { op: "nsRestore", docId: "d2", path: "r6.md", againstDeleteSeq: 57 });
	assert.equal(find(p, "reconcileContent").docId, "d2");
	// the gone doc does not take the file (no merge-after-all put, no materialize into the occupied path)
	assert.ok(!p.ops.some((o) => "docId" in o && o.docId === "d1" && o.op !== "wait"), JSON.stringify(p.ops));
	// next pass, d2's record at r6: still not d1's file
	const next = planWith(input({ remote: [edited, R("d2", "r6.md")], synced: [gone1, S("d2", "r6.md", { contentHash: h("c5") })], local: [L("r6.md", h("c5"))] }));
	assert.ok(!next.ops.some((o) => "docId" in o && o.docId === "d1" && o.op !== "wait"), JSON.stringify(next.ops));
});

test("a doc whose file the user renamed away does not take a new file at the path a peer moved it to", () => {
	// Soak 1307815726 #30: offline, C renamed boards/c5 -> canvas/c5 (kept on S: fileGone, renamedTo) while a peer moved
	// the doc to canvas/c0, then C created a new canvas/c0. The file at the remote path was read as the doc's own (the
	// doc moved there): the new canvas was merged into the doc over a peer's records, and canvas/c5 became a new doc.
	const gone = { ...S("d1", "b.canvas"), fileGone: true as const, renamedTo: { to: "c.canvas", atMs: 7 } };
	const sc = { remote: [R("d1", "a.canvas")], synced: [gone], local: [L("a.canvas", h("c9")), L("c.canvas", h("c0"))] };
	for (const nsReady of [false, true]) {
		const p = run(sc, { nsReady });
		assert.ok(!p.ops.some((o) => o.op === "reconcileContent" && o.path === "a.canvas"), JSON.stringify(p.ops));
		assert.ok(!p.ops.some((o) => o.op === "syncedPut" && o.entry.docId === "d1" && o.entry.path === "a.canvas"), JSON.stringify(p.ops));
	}
	// ns ready: the kept rename moves the doc to the renamed file; the new file at the doc's remote path is not the doc's
	const ready = run(sc);
	assert.deepEqual(find(ready, "nsRename"), { op: "nsRename", docId: "d1", path: "c.canvas" });
	// no rename known (a decided delete only): the file at the remote path is the doc's, as an offline rename onto it
	// the planner could not see (sim heavy seed 22)
	const plain = run({ ...sc, synced: [{ ...S("d1", "b.canvas"), fileGone: true as const }], local: [L("a.canvas", h("c0"))] });
	assert.ok(!opsOf(plain).includes("nsCreate"), JSON.stringify(plain.ops));
});

test("a file renamed onto a fileGone path with the gone doc's bytes is a new file, and the fresh-id budget counts it", () => {
	// The file is new (goneHere -> planNewLocal takes a fresh docId) although it matches the synced record at its path
	// by hash. A budget that counted only files differing from their record by hash handed this plan no id: the file
	// was never created and never synced (the guard in run() checks consumedDocIds <= freshIdBudget).
	const gone = { ...S("d1", "a.md"), fileGone: true as const };
	const p = run({ remote: [R("d1", "a.md", { state: "deleted", deletedSeq: 9 })], synced: [gone], local: [L("a.md", h("c0"))], over: { renames: [{ from: "b.md", to: "a.md", atMs: 5 }] } });
	assert.deepEqual(opsOf(p), ["nsCreate", "reconcileContent", "syncedDrop"]);
	assert.equal(find(p, "nsCreate").path, "a.md");
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

test("row deleted/present/absent with restore duty -> nsRestore keeping S (the local delete then covers the own rows)", () => {
	// Sim blob seed 5: C deleted the doc while B, offline, edited it and then deleted the file. B dropped S, and
	// the next pass (deleted, no S, restore duty for B's uncovered row) restored the doc at its path: both users'
	// deletes undone. Kept, S makes the pass after the restore see live/present/absent: an nsDelete whose base
	// covers B's rows, or edit-beats-delete if a peer changed the doc since.
	const del = R("d1", "a.md", { state: "deleted", deletedSeq: 41 });
	const duty = planWith(input({ remote: [del], synced: [S("d1", "a.md")] }), { restoreDuty: new Set([id("d1")]) });
	assert.deepEqual(duty.ops, [{ op: "nsRestore", docId: "d1", path: "a.md", againstDeleteSeq: 41 }]);
	const body = run({ remote: [del], synced: [S("d1", "a.md")], over: { docsWithPendingBody: new Set([id("d1")]) } });
	assert.deepEqual(body.ops, [{ op: "nsRestore", docId: "d1", path: "a.md", againstDeleteSeq: 41 }]);
	// an own ns op in flight: wait, S kept
	const pend = planWith(input({ remote: [{ ...del, pendingLocal: true }], synced: [S("d1", "a.md")] }), { restoreDuty: new Set([id("d1")]) });
	assert.deepEqual(pend.ops, [{ op: "wait", docId: "d1", reason: "pending-ns" }]);
	// the pass after the restore: live/present/absent, nothing changed remotely -> the delete goes out again
	const after = planWith(input({ remote: [R("d1", "a.md")], synced: [S("d1", "a.md")] }), { bodyAppliedSeq: new Map([[id("d1"), 52]]) });
	assert.deepEqual(after.ops, [{ op: "nsDelete", docId: "d1", baseBodySeq: 52 }, { op: "syncedDrop", docId: "d1" }]);
});

test("row deleted/present/absent, the file renamed here (observed) -> nsRestore at the new path; the source path's new doc is not paired", () => {
	// Sim DEV5 F seed 157: offline, A edited and renamed n2 -> r6 while a peer deleted the doc and re-created n2.
	// The doc was dropped and the observed rename then paired with the new n2 doc: A's text merged into its body.
	const del = R("d1", "a.md", { state: "deleted", deletedSeq: 41 });
	const recreated = R("d2", "a.md");
	const gone: SyncedEntry = { ...S("d1", "a.md"), fileGone: true };
	const renames = [{ from: "a.md", to: "b.md", atMs: 1 }];
	const edited = run({ remote: [del, recreated], synced: [gone], local: [L("b.md", h("c1"))], over: { renames } });
	assert.deepEqual(edited.ops.filter((o) => o.op !== "diskMaterialize"), [
		{ op: "nsRestore", docId: "d1", path: "b.md", againstDeleteSeq: 41 },
		{ op: "reconcileContent", docId: "d1", path: "b.md", kind: "markdown", hasBase: true },
	]);
	assert.deepEqual(find(edited, "diskMaterialize"), { op: "diskMaterialize", docId: "d2", path: "a.md", expect: { t: "absent" } });
	// unedited: the rename alone still wins over the unseen delete (E6); the synced record follows the file
	const { fileGone: _g, ...live } = gone;
	const same = run({ remote: [del], synced: [gone], local: [L("b.md", h("c0"))], over: { renames } });
	assert.deepEqual(same.ops, [
		{ op: "nsRestore", docId: "d1", path: "b.md", againstDeleteSeq: 41 },
		{ op: "syncedPut", entry: { ...live, path: "b.md", pathKey: "b.md" } },
	]);
	// before ns is ready (no inference) the record is kept, not dropped
	assert.deepEqual(planWith(input({ remote: [del], synced: [gone], local: [L("b.md", h("c1"))], over: { renames } }), { nsReady: false }).ops, []);
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

test("row merged, loser replica past its sync point: its text goes to its file first, the rebind follows (I1)", () => {
	// Sim suite-1 seed 1: own edits typed into the loser after its create, the editor's save lost with the app. Its
	// kept frames are the only copy; a rebind now restarts S at the winner's create and the disk never gets them.
	const sc = (over: Partial<SyncedEntry>, local = L("x.md", h("X"))): Scenario => ({
		remote: [R("d4", "x.md", { state: "merged", aliasOf: id("d3"), body: { ...R("d4", "x.md").body!, version: V(12) } }), R("d3", "x.md", { createHash: h("X") })],
		synced: [S("d4", "x.md", { contentHash: h("X"), bodyVersion: V(10), ...over })],
		local: [local],
	});
	assert.deepEqual(run(sc({})).ops, [{ op: "reconcileContent", docId: "d4", path: "x.md", kind: "markdown", hasBase: true }]);
	// Unhashed file: hash it first, still no rebind.
	assert.deepEqual(run(sc({}, L("x.md", null))).ops, [{ op: "needHash", path: "x.md" }]);
	// Once the file holds the replica (S at its version), the rebind as before.
	assert.deepEqual(opsOf(run(sc({ bodyVersion: V(12) }))), ["rebind", "reconcileContent"]);
	assert.equal(find(run(sc({ bodyVersion: V(12) })), "reconcileContent").docId, "d3");
	// Renamed before the app died (the file moved, S still at x.md or already fileGone): its text goes to the moved file.
	const moved = (over: Partial<SyncedEntry>) => run(sc(over, L("y.md", h("X")))).ops.find((o) => o.op === "reconcileContent");
	assert.deepEqual(moved({}), { op: "reconcileContent", docId: "d4", path: "y.md", kind: "markdown", hasBase: true });
	assert.deepEqual(moved({ fileGone: true }), { op: "reconcileContent", docId: "d4", path: "y.md", kind: "markdown", hasBase: true });
});

test("row merged, winner renamed and another identical doc live at the path: rebind and follow the rename, no collapse", () => {
	// Soak seed 1394654959: S of an own create merged before it folded has nsTouchSeq 0. Rebound to the winner it is
	// the winner's record: a rename of the winner is a remote move, not the fold suffixing an own create.
	const blob = (path: string, over = {}) => R("d0", path, { kind: "blob", createHash: h("b0"), blob: { hash: h("b0"), size: 3, rev: 7 }, ...over } as never);
	const p = run({
		remote: [{ ...blob("att/y.png"), docId: id("d3"), lastTouchSeq: 9 }, { ...blob("att/x.png"), docId: id("d4"), state: "merged", aliasOf: id("d3") }, { ...blob("att/x.png"), docId: id("d5"), lastTouchSeq: 11 }],
		synced: [S("d4", "att/x.png", { kind: "blob", contentHash: h("b0"), nsTouchSeq: 0, blobRev: 7 })],
		local: [L("att/x.png", h("b0"))],
	});
	assert.ok(!opsOf(p).includes("nsDelete"), JSON.stringify(p.ops));
	assert.deepEqual(opsOf(p).slice(0, 2), ["rebind", "diskRename"]);
	assert.equal(find(p, "rebind").toDocId, "d3");
	assert.equal(find(p, "diskRename").to, "att/y.png");
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

test("row pruned: an own create the fold never committed (nsTouchSeq 0) is created anew, never trashed", () => {
	// Sim seed 222 (frameNo fix reverted): the own nsCreate folded as replay-duplicate. Absent, it read as pruned and
	// the unchanged file went to the trash. A prune removes only an entry the fold held; this device never saw one.
	const blob = run({ synced: [S("d1", "a.png", { nsTouchSeq: 0, blobRev: 0 })], local: [L("a.png", h("b0"), { size: 3188 })] });
	assert.deepEqual(blob.ops, [
		{ op: "nsCreate", docId: "fresh1", kind: "blob", path: "a.png", contentHash: h("b0"), size: 3188 },
		{ op: "pushBlob", docId: "fresh1", path: "a.png", hash: h("b0"), size: 3188 },
		{ op: "syncedDrop", docId: "d1" },
	]);
	assert.equal(blob.brake, null);
	const md = run({ synced: [S("d1", "a.md", { nsTouchSeq: 0 })], local: [L("a.md", h("c0"))] });
	assert.deepEqual(opsOf(md), ["nsCreate", "reconcileContent", "syncedDrop"]);
	// seen committed (nsTouchSeq > 0): a real prune, the trash stands
	assert.deepEqual(opsOf(run({ synced: [S("d1", "a.png")], local: [L("a.png", h("b0"))] })), ["diskTrash", "syncedDrop"]);
});

test("row pruned: own body frames still in the outbox -> the file is created anew with them, never trashed", () => {
	// Sim smallPrune seed 104: A edited the bound note offline (S tracks the bound doc's edits: L reads unchanged), C
	// deleted it, later deletes pruned it. Back online, A's pass ran before its outbox flushed and trashed the file
	// with the edits no delete covered (edit beats delete, §c.7), which a restore could no longer name.
	const pending = { synced: [S("d1", "a.md")], local: [L("a.md", h("c0"), { size: 9 })], over: { docsWithPendingBody: new Set([id("d1")]) } };
	const p = run(pending);
	assert.deepEqual(p.ops, [
		{ op: "nsCreate", docId: "fresh1", kind: "markdown", path: "a.md", contentHash: h("c0"), size: 9 },
		{ op: "reconcileContent", docId: "fresh1", path: "a.md", kind: "markdown", hasBase: false },
		{ op: "syncedDrop", docId: "d1" },
	]);
	assert.equal(p.brake, null);
	const inp = input(pending);
	assert.equal(freshIdBudget(inp.synced, inp.local, inp.remote, (d) => inp.docsWithPendingBody.has(d)), 1);
	assert.equal(freshIdBudget(inp.synced, inp.local, inp.remote), 0);
	// a live doc with pending body is not counted (its own row waits on the frames)
	const live = input({ ...pending, remote: [R("d1", "a.md")] });
	assert.equal(freshIdBudget(live.synced, live.local, live.remote, (d) => live.docsWithPendingBody.has(d)), 0);
});

test("row pruned: a restore duty (own sent rows the pruned delete did not cover) -> the file is created anew, never trashed", () => {
	// Open-repro prune-storm-mass-delete: B overwrote imported notes (its rows sent and committed, so S tracks them and
	// L reads unchanged, nothing pending) while A's mass delete, which had not seen them, folded with its prune in one
	// batch: the pruned row trashed the overwrite. The view hands the duty in restoreDuty (§c.9 "Pruned docs").
	const sc = { synced: [S("d1", "a.md")], local: [L("a.md", h("c0"), { size: 9 })] };
	const duty = { restoreDuty: new Set([id("d1")]) };
	const p = run(sc, duty);
	assert.deepEqual(p.ops, [
		{ op: "nsCreate", docId: "fresh1", kind: "markdown", path: "a.md", contentHash: h("c0"), size: 9 },
		{ op: "reconcileContent", docId: "fresh1", path: "a.md", kind: "markdown", hasBase: false },
		{ op: "syncedDrop", docId: "d1" },
	]);
	assert.equal(p.brake, null);
	const inp = input(sc);
	assert.equal(freshIdBudget(inp.synced, inp.local, inp.remote, (d) => duty.restoreDuty.has(d)), 1);
	// no duty: the delete covered every own row, the trash stands
	assert.deepEqual(opsOf(run(sc)), ["diskTrash", "syncedDrop"]);
	// the duty never overrides a live owner of the file (its S at the path): S is dropped, the file stays the owner's
	const owned = run({ synced: [S("d1", "a.md"), S("d2", "a.md")], local: [L("a.md", h("c0"))], remote: [R("d2", "a.md")] }, duty);
	assert.deepEqual(opsOf(owned).filter((o) => o !== "reconcileContent" && o !== "syncedPut"), ["syncedDrop"]);
});

test("row pruned: a restore duty with the replica ahead of S -> the replica is merged into the file first, under the old id", () => {
	// Sim smallPrune storm seed 200: an edit typed into a bound note was never saved (app crash), so it lived in the
	// replica only; the doc was deleted elsewhere and pruned. A re-create from the file lost the edit.
	const sc = { synced: [S("d1", "a.md", { bodyVersion: V(10) })], local: [L("a.md", h("c0"), { size: 9 })] };
	const ahead = { restoreDuty: new Set([id("d1")]), prunedBody: new Map([[id("d1"), V(10, 3)]]) };
	assert.deepEqual(run(sc, ahead).ops, [{ op: "reconcileContent", docId: "d1", path: "a.md", kind: "markdown", hasBase: true }]);
	// a changed file merges too: the re-create takes the merged bytes
	const changed = { ...sc, local: [L("a.md", h("c1"), { size: 9 })] };
	assert.deepEqual(opsOf(run(changed, ahead)), ["reconcileContent"]);
	// the replica at S: nothing to merge, the re-create runs
	const level = { restoreDuty: ahead.restoreDuty, prunedBody: new Map([[id("d1"), V(10)]]) };
	assert.deepEqual(opsOf(run(sc, level)), ["nsCreate", "reconcileContent", "syncedDrop"]);
	// no duty: the trash stands whatever the replica holds (the delete covered every row)
	assert.deepEqual(opsOf(run(sc, { prunedBody: ahead.prunedBody })), ["diskTrash", "syncedDrop"]);
});

test("row pruned: the file is a live doc's (its S at the path, or its bytes) -> syncedDrop only, no trash, no create", () => {
	// Sim seed 222: the create from before the IDB wipe did fold (d2, synced here through S1) at the same path, with
	// the same bytes. Trashing the file for d1 made d2's row read it as deleted by the user: nsDelete everywhere.
	const twin = { remote: [R("d2", "a.png", { blob: { hash: h("b0"), size: 3188, rev: 8 }, createHash: h("b0") })] };
	const drop = [{ op: "syncedDrop", docId: "d1" }];
	const both = run({ ...twin, synced: [S("d1", "a.png", { nsTouchSeq: 0, blobRev: 0 }), S("d2", "a.png", { blobRev: 8, nsTouchSeq: 8, fingerprint: fp("b0") })], local: [L("a.png", h("b0"))] });
	assert.deepEqual(both.ops, drop);
	// also for a doc seen committed (a real prune): the file still belongs to the live doc at its path
	assert.deepEqual(run({ ...twin, synced: [S("d1", "a.png"), S("d2", "a.png", { blobRev: 8, nsTouchSeq: 8, fingerprint: fp("b0") })], local: [L("a.png", h("b0"))] }).ops, drop);
	// d2 not synced here: its bytes are the file's, d2 adopts it next pass
	assert.deepEqual(run({ ...twin, synced: [S("d1", "a.png", { nsTouchSeq: 0, blobRev: 0 })], local: [L("a.png", h("b0"))] }).ops, drop);
	// synced at the path with other bytes on disk: still d2's file (its own row pushes the edit)
	const edited = run({ ...twin, synced: [S("d1", "a.png", { contentHash: h("b7") }), S("d2", "a.png", { blobRev: 8, nsTouchSeq: 8, fingerprint: fp("b0") })], local: [L("a.png", h("b7"))] });
	assert.ok(!opsOf(edited).includes("diskTrash") && !edited.ops.some((o) => o.op === "nsCreate" && o.path === "a.png"), JSON.stringify(edited.ops));
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
	assert.equal(adopt.ops[0]!.op === "syncedPut" && adopt.ops[0].entry.blobRev, 50);
	const keep = run({ remote: [R("d9", "i.png")], local: [L("i.png", h("b8"))] });
	assert.deepEqual(opsOf(keep), ["nsCreate", "conflictCopy", "fetchBlob", "pushBlob"]);
	assert.equal(find(keep, "conflictCopy").reason, "no-base");
	// body not caught up / empty body that is not an empty create -> wait
	const body = R("d1", "a.md").body!;
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md", { body: { ...body, caughtUp: false } })], local: [L("a.md", h("c3"))] })), ["wait"]);
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md", { body: { ...body, hasContent: false } })], local: [L("a.md", h("c3"))] })), ["wait"]);
});

test("lost create body (no rows, nothing pending, no synced record): drop the empty doc; a file there is re-created after", () => {
	// Sim heavy seeds 17, 90, 194: the creator's store (and mirrors) went before its initial frames were acked;
	// every device then waited "body-empty" forever, with the text only on the creator's disk.
	const empty = { ...R("d1", "a.md").body!, hasContent: false, version: V(0) };
	const lost = { lostCreateBody: new Set([id("d1")]) };
	const present = { remote: [R("d1", "a.md", { body: empty })], local: [L("a.md", h("c3"))] };
	assert.deepEqual(run(present).ops, [{ op: "wait", docId: "d1", reason: "body-empty" }]);
	// The file stays (claimed: no create at its path while the empty doc holds it) and is not braked: nothing of the user's goes.
	const drop = run(present, lost);
	assert.deepEqual(drop.ops, [{ op: "nsDelete", docId: "d1", baseBodySeq: 0 }]);
	assert.equal(drop.brake, null);
	assert.deepEqual(run(present, { ...lost, nsReady: false }).ops, []);
	assert.deepEqual(run({ ...present, remote: [R("d1", "a.md", { body: empty, pendingLocal: true })] }, lost).ops, [{ op: "wait", docId: "d1", reason: "pending-ns" }]);
	// Once the delete folded, the file is a new local file: a new doc with its text.
	assert.deepEqual(opsOf(run({ remote: [R("d1", "a.md", { body: empty, state: "deleted" })], local: [L("a.md", h("c3"))] }, lost)), ["nsCreate", "reconcileContent"]);
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

test("lost create body with a synced record and the file just what S says: drop the empty doc and S (soak 1313609040 run 108)", () => {
	// The creator's born-empty S (runner) and a file that is empty again by the time the initial merge would run: a
	// canvas created from a broken save (createHash of those bytes), then fixed to the empty canvas. L = S, so no merge
	// ever frames anything, and the other devices waited on "body-empty" for good, their creator live.
	const empty = { ...R("d1", "c.canvas").body!, hasContent: false, version: V(0) };
	const lost = { lostCreateBody: new Set([id("d1")]) };
	const bornEmpty = S("d1", "c.canvas", { contentHash: EMPTY_CONTENT_HASH, bodyVersion: V(0), hasBase: false });
	const sc = { remote: [R("d1", "c.canvas", { body: empty })], synced: [bornEmpty], local: [L("c.canvas", EMPTY_CONTENT_HASH, { fingerprint: fp("c0") })] };
	assert.deepEqual(run(sc).ops, [], "not lost (a foreign creator, or own frames still to come): nothing to do");
	const p = run(sc, lost);
	assert.deepEqual(p.ops, [{ op: "nsDelete", docId: "d1", baseBodySeq: 0 }, { op: "syncedDrop", docId: "d1" }]);
	assert.equal(p.brake, null, "nothing of the user's goes: the file stays");
	// Once the delete folded, the file is a new local file: a new doc with what it holds.
	assert.deepEqual(opsOf(run({ remote: [R("d1", "c.canvas", { body: empty, state: "deleted" })], local: [L("c.canvas", EMPTY_CONTENT_HASH)] }, lost)), ["nsCreate", "reconcileContent"]);
	// S with text (a mirror restored it after the store went, frames never acked) and the same file: dropped too.
	const withText = { ...sc, synced: [S("d1", "c.canvas", { bodyVersion: V(0) })], local: [L("c.canvas", h("c0"))] };
	assert.deepEqual(opsOf(run(withText, lost)), ["nsDelete", "syncedDrop"]);
	// Not yet: ns not ready, the doc's own ns op pending, or a remote move to apply first.
	assert.deepEqual(run(sc, { ...lost, nsReady: false }).ops, []);
	assert.equal(opsOf(run({ ...sc, remote: [R("d1", "c.canvas", { body: empty, pendingLocal: true })] }, lost)).includes("nsDelete"), false);
	assert.deepEqual(opsOf(run({ ...sc, remote: [R("d1", "d.canvas", { body: empty })] }, lost)), ["diskRename", "syncedPut"]);
	// The file changed: the merge pushes its text into the doc (the runner's re-push of an own create), as before.
	assert.deepEqual(opsOf(run({ ...sc, local: [L("c.canvas", h("c5"))] }, lost)), ["reconcileContent"]);
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

test("row frozen body, file renamed and edited: the renamed file is still the doc's, and S keeps the rename", () => {
	// Sim suite-1 wipe/revoke/roll seed 40: a doc frozen key-missing, its file renamed and edited. The renamed file was
	// created as a new doc, and the pass that dropped the observed rename left the thawed doc reading as deleted.
	const body = { ...R("d1", "a.md").body!, frozen: true, version: V(99) };
	const sc = { remote: [R("d1", "a.md", { body })], synced: [S("d1", "a.md")], local: [L("b.md", h("c9"))] };
	const p = run({ ...sc, over: { renames: [{ from: "a.md", to: "b.md", atMs: 1 }] } });
	assert.ok(!opsOf(p).includes("nsCreate"), JSON.stringify(p.ops));
	assert.deepEqual(p.ops[0], { op: "wait", docId: "d1", reason: "frozen" });
	const put = find(p, "syncedPut").entry;
	assert.equal(put.fileGone, true);
	assert.deepEqual(put.renamedTo, { to: "b.md", atMs: 1 });
	// The next pass, the observed rename gone from memory: the one S kept still claims the file.
	const next = run({ ...sc, synced: [{ ...S("d1", "a.md"), fileGone: true, renamedTo: { to: "b.md" as SyncedEntry["path"], atMs: 1 } }] });
	assert.deepEqual(next.ops, [{ op: "wait", docId: "d1", reason: "frozen" }]);
	// No rename observed and the file gone from a complete listing: recorded as gone, never a create.
	const gone = run({ ...sc, local: [] });
	assert.equal(find(gone, "syncedPut").entry.fileGone, true);
	assert.equal(find(gone, "syncedPut").entry.renamedTo, undefined);
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

test("E2: the loser's move pinned by its own pending ns op -> the winner waits for the path (no doomed materialize)", () => {
	// Sim real skip deferral seed 20: the loser rename was this device's own op, not folded yet, so the loser's file
	// stayed at the path. The winner's materialize (expect absent) failed against it every pass, each failure threw
	// the downloaded bytes away, and both blobs were re-downloaded and re-planned at once, forever.
	const blob = (hash: string, rev: number) => ({ kind: "blob" as const, blob: { hash: h(hash), size: 3, rev }, body: null });
	const sc = {
		remote: [R("d1", "att/b.png", blob("w", 67)), R("d2", "att/b (2).png", { ...blob("n", 50), pendingLocal: true })],
		synced: [S("d2", "att/b.png", { kind: "blob", contentHash: h("o"), bodyVersion: null, blobRev: 26 })],
		local: [L("att/b.png", h("o"), { kind: "blob" })],
	};
	const p = run(sc);
	assert.ok(!opsOf(p).includes("diskMaterialize"), JSON.stringify(p.ops));
	assert.deepEqual(p.ops, [{ op: "fetchBlob", docId: "d2", path: "att/b.png", hash: h("n"), size: 3 }]);
	// Folded: the loser moves away, and the winner materializes behind it in the same plan.
	const folded = run({ ...sc, remote: [sc.remote[0]!, { ...sc.remote[1]!, pendingLocal: false }] });
	assert.deepEqual(opsOf(folded).slice(0, 2), ["diskRename", "diskMaterialize"]);
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
	}), { remoteTextHash: new Map([[id("d3"), h("X")], [id("d4"), h("X")]]) });
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
	const ctx = { remoteTextHash: new Map([[id("d3"), h("W")], [id("d4"), h("L")]]) };
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
	// The loser must be caught up (its text is checked to be just what this device synced) ...
	const behind = { ...sc, remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md", { body: { ...R("d4", "Inbox/x (2).md").body!, caughtUp: false } })] };
	assert.deepEqual(planWith(input(behind), { ...ctx, pathBaseKeys: new Set([pk("Inbox/x.md")]) }).ops, [{ op: "wait", docId: "d4", reason: "body-not-caught-up" }]);
	// ... and its text known here. Not resident (a restart since): load it first, not a loser rename that leaves a
	// duplicate behind (sim suite-1 seed 65).
	assert.deepEqual(planWith(input(sc), { remoteTextHash: new Map([[id("d3"), h("W")]]), pathBaseKeys: new Set([pk("Inbox/x.md")]) }).ops, [{ op: "wait", docId: "d4", reason: "text-hash" }]);
});

test("re-create collapse loads a winner whose text is not resident before it decides identical or not", () => {
	// No path base: only an identical loser collapses, and that needs the winner's text hash.
	const sc = {
		remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md")],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("X"), nsTouchSeq: 0 })],
		local: [L("Inbox/x.md", h("X"))],
	};
	assert.deepEqual(planWith(input(sc), { remoteTextHash: new Map([[id("d4"), h("X")]]) }).ops, [{ op: "wait", docId: "d3", reason: "text-hash" }]);
	// Known and different: the loser rename.
	assert.deepEqual(opsOf(planWith(input(sc), { remoteTextHash: new Map([[id("d3"), h("W")], [id("d4"), h("X")]]) })), ["diskRename", "diskMaterialize", "syncedPut"]);
	// A winner with no content yet has its create hash: nothing to load.
	const empty = { ...sc, remote: [R("d3", "Inbox/x.md", { body: { ...R("d3", "Inbox/x.md").body!, hasContent: false } }), R("d4", "Inbox/x (2).md")] };
	assert.notDeepEqual(planWith(input(empty), { remoteTextHash: new Map([[id("d4"), h("X")]]) }).ops, [{ op: "wait", docId: "d3", reason: "text-hash" }]);
});

test("re-create collapse leaves a loser another device wrote to: its nsDelete would drop that edit (sim seed 581)", () => {
	// Another device materialized the loser as "x (2)" and edited it there: the loser's text is no longer the
	// synced one. It keeps the loser rename, migrated or identical.
	const edited = (local: string) => ({
		remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md")],
		synced: [S("d4", "Inbox/x.md", { contentHash: h(local), nsTouchSeq: 0 })],
		local: [L("Inbox/x.md", h(local))],
	});
	const other = (winner: string) => ({ remoteTextHash: new Map([[id("d3"), h(winner)], [id("d4"), h("E")]]) });
	assert.deepEqual(opsOf(planWith(input(edited("L")), { ...other("W"), pathBaseKeys: new Set([pk("Inbox/x.md")]) })), ["diskRename", "diskMaterialize", "syncedPut"]);
	assert.deepEqual(opsOf(planWith(input(edited("X")), other("X"))), ["diskRename", "diskMaterialize", "syncedPut"]);
});

test("§c.12 migrated-loser merge applies to canvases too", () => {
	const sc = {
		remote: [R("d3", "b/x.canvas", { kind: "canvas" }), R("d4", "b/x (2).canvas", { kind: "canvas" })],
		synced: [S("d4", "b/x.canvas", { kind: "canvas", contentHash: h("L"), nsTouchSeq: 0 })],
		local: [L("b/x.canvas", h("L"), { kind: "canvas" })],
	};
	const ctx = { remoteTextHash: new Map([[id("d3"), h("W")], [id("d4"), h("L")]]) };
	assert.deepEqual(planWith(input(sc), { ...ctx, pathBaseKeys: new Set([pk("b/x.canvas")]) }).ops, [
		{ op: "rebind", fromDocId: "d4", toDocId: "d3", path: "b/x.canvas", adopt: true },
		{ op: "nsDelete", docId: "d4", baseBodySeq: 10 },
		{ op: "reconcileContent", docId: "d3", path: "b/x.canvas", kind: "canvas", hasBase: false, pathBase: true },
	]);
});

test("re-create collapse waits for the loser's own create frames: an nsDelete below them is a restore duty (§c.7)", () => {
	const pending = { docsWithPendingBody: new Set([id("d4")]) };
	// Migrated (differing) loser and identical loser alike: the delete waits as a user delete does.
	const migrated = run({
		remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md")],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("L"), nsTouchSeq: 0 })],
		local: [L("Inbox/x.md", h("L"))], over: pending,
	}, { remoteTextHash: new Map([[id("d3"), h("W")], [id("d4"), h("L")]]), pathBaseKeys: new Set([pk("Inbox/x.md")]) });
	assert.deepEqual(migrated.ops, [{ op: "wait", docId: "d4", reason: "pending-body" }]);
	const identical = run({
		remote: [R("d3", "Inbox/x.md"), R("d4", "Inbox/x (2).md")],
		synced: [S("d4", "Inbox/x.md", { contentHash: h("X"), nsTouchSeq: 0 })],
		local: [L("Inbox/x.md", h("X"))], over: pending,
	}, { remoteTextHash: new Map([[id("d3"), h("X")], [id("d4"), h("X")]]) });
	assert.deepEqual(identical.ops, [{ op: "wait", docId: "d4", reason: "pending-body" }]);
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

test("brake: mass-delete-remote, listing-shrank, conflict-flood", () => {
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
		const snapshot = JSON.stringify(inp, (_k, v: unknown) => (v instanceof Map ? [...(v as Map<unknown, unknown>).entries()] : v instanceof Set ? [...(v as Set<unknown>)] : v));
		const p1 = plan(inp);
		assert.equal(JSON.stringify(inp, (_k, v: unknown) => (v instanceof Map ? [...(v as Map<unknown, unknown>).entries()] : v instanceof Set ? [...(v as Set<unknown>)] : v)), snapshot, `mutated input seed ${seed}`);
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
