import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ClientFrameId, ContentHash, DeviceId, DocId, DocKind, NsFoldEvent, NsFoldState, NsOp, NsOpOutcome, VaultPath } from "../types";
import { CheckpointEncoding } from "../envelope";
import { Writer, bytesEqual } from "../codec/lib0";
import { decodeNsFoldV1, encodeNsFoldV1 } from "../codec/nsFoldV1";
import { decodeNsOps, encodeNsOps } from "../codec/nsOps";
import { hashToBytes } from "../codec/ids";
import { DEFAULT_NS_FOLD_RULES, foldNsFrame, foldNsFrameWith, newNsFoldIndex, newNsFoldState, nsFoldHalted, type NsFoldRules } from "./fold";
import { buildIndex } from "./index";
import { checkNsInvariants, verifyNsCheckpoint, verifyNsFoldBytes, verifyNsFoldState } from "./verify";
import { checkDigest, isCandidateSeq, nsFoldDigest, recordDigest } from "./candidate";
import { overlayPending } from "./overlay";
import { replayBitsToBytes } from "../replayWindow";

const H = (n: number) => n.toString(16).padStart(2, "0").repeat(32) as ContentHash;
const D = (s: string) => (s + "_".repeat(22)).slice(0, 22) as DocId;
const A = "devA" as DeviceId;
const B = "devB" as DeviceId;
const C = "devC" as DeviceId;
let fidCounter = 0;
const F = () => `f${(fidCounter++).toString().padStart(21, "0")}` as ClientFrameId;

const create = (docId: DocId, path: string, hash = H(1), kind?: DocKind, size = 3): NsOp => ({
	t: "create", docId, path, contentHash: hash, size,
	kind: kind ?? (path.endsWith(".md") ? "markdown" : path.endsWith(".canvas") ? "canvas" : "blob"),
});
const rename = (docId: DocId, path: string): NsOp => ({ t: "rename", docId, path });
const del = (docId: DocId, baseBodySeq = 0): NsOp => ({ t: "delete", docId, baseBodySeq });
const restore = (docId: DocId, path: string, againstDeleteSeq: number): NsOp => ({ t: "restore", docId, path, againstDeleteSeq });
const setBlob = (docId: DocId, hash: ContentHash, baseRev: number, size = 5): NsOp => ({ t: "setBlob", docId, hash, size, baseRev });

function world(rules: NsFoldRules = DEFAULT_NS_FOLD_RULES) {
	const state = newNsFoldState();
	const index = newNsFoldIndex();
	// frameNo 0 skips the replay window (a gate-failed row); the window has its own test.
	const fold = (seq: number, deviceId: DeviceId, authorNsSeq: number, ops: NsOp[], clientFrameId: ClientFrameId = F(), frameNo = 0): NsFoldEvent[] => {
		const frame = { seq, deviceId, clientFrameId, frameNo, authorNsSeq, ops };
		const ev = rules === DEFAULT_NS_FOLD_RULES ? [...foldNsFrame(state, index, frame)] : foldNsFrameWith(rules, state, index, frame);
		assert.equal(checkNsInvariants(state, index, { tombstoneCap: rules.tombstoneCap }), null);
		return ev;
	};
	return { state, index, fold, e: (id: DocId) => state.entries.get(id)! };
}
const out = (ev: NsFoldEvent[], i = 0): NsOpOutcome => ev[i]!.outcome;
const prunedIds = (ev: NsFoldEvent | undefined): readonly DocId[] => (ev && ev.outcome.kind === "pruned" ? ev.outcome.docIds : []);
const ignored = (reason: string) => ({ kind: "ignored", reason });

const d1 = D("d1"), d2 = D("d2"), d3 = D("d3"), d4 = D("d4"), d5 = D("d5"), d6 = D("d6"), d7 = D("d7"), d8 = D("d8"), d9 = D("d9");
const d10 = D("d10"), d11 = D("d11"), d12 = D("d12");

test("E1 simple create", () => {
	const w = world();
	const ev = w.fold(5, A, 4, [create(d1, "Notes/a.md", H(1))]);
	assert.deepEqual(ev, [{ seq: 5, index: 0, deviceId: A, clientFrameId: ev[0]!.clientFrameId, docId: d1, outcome: { kind: "applied" } }]);
	const e = w.e(d1);
	assert.equal(e.state, "live");
	assert.equal(e.path, "Notes/a.md");
	assert.equal(e.createdSeq, 5);
	assert.equal(e.lastTouchSeq, 5);
	assert.equal(e.createdBy, A);
	assert.equal(e.blob, null);
	assert.deepEqual(w.index.folderRefs.get("notes" as never), { path: "Notes", count: 1 });
	assert.equal(w.state.coversSeq, 5);
});

test("E2 collision suffix and folder casing", () => {
	const w = world();
	w.fold(5, A, 4, [create(d1, "Notes/a.md", H(1))]);
	const ev = w.fold(7, B, 4, [create(d2, "notes/A.md", H(2))]);
	assert.deepEqual(out(ev), { kind: "suffixed", requestedPath: "notes/A.md", finalPath: "Notes/A (2).md" });
	assert.deepEqual(w.index.folderRefs.get("notes" as never), { path: "Notes", count: 2 });
});

test("E3 identical onboarding merges; different content suffixes", () => {
	const w = world();
	w.fold(10, A, 0, [create(d3, "Inbox/x.md", H(0xa))]);
	const ev = w.fold(11, B, 0, [create(d4, "Inbox/x.md", H(0xa))]);
	assert.deepEqual(out(ev), { kind: "merged", into: d3 });
	const m = w.e(d4);
	assert.equal(m.state, "merged");
	assert.equal(m.aliasOf, d3);
	assert.equal(m.path, "Inbox/x.md");
	assert.equal(m.lastTouchSeq, 11);
	assert.equal(w.index.tombstones, 1);
	assert.equal(w.index.byPathKey.get("inbox/x.md" as never), d3);
	// Ops on the alias redirect to the winner.
	const r = w.fold(12, B, 11, [rename(d4, "Inbox/y.md")]);
	assert.equal(r[0]!.docId, d3);
	assert.equal(w.e(d3).path, "Inbox/y.md");
	// Different content: suffix.
	const s = w.fold(13, C, 0, [create(D("dY"), "Inbox/y.md", H(0xb))]);
	assert.deepEqual(out(s), { kind: "suffixed", requestedPath: "Inbox/y.md", finalPath: "Inbox/y (2).md" });
	// Many identical files: all merge, no suffixes.
	const v = world();
	const ops = (pre: string) => Array.from({ length: 500 }, (_, i) => create(D(`${pre}${i}`), `Vault/n${i}.md`, H(i % 256)));
	v.fold(1, A, 0, ops("a"));
	const merged = v.fold(2, B, 0, ops("b"));
	assert.ok(merged.every((e) => e.outcome.kind === "merged"));
	// A blob whose current blob hash matches merges too.
	const b = world();
	b.fold(1, A, 0, [create(d9, "img.png", H(1))]);
	b.fold(2, A, 1, [setBlob(d9, H(2), 1)]);
	assert.deepEqual(out(b.fold(3, B, 0, [create(d1, "img.png", H(2))])), { kind: "merged", into: d9 });
	assert.deepEqual(out(b.fold(4, B, 0, [create(d2, "img.png", H(1))])), { kind: "merged", into: d9 });
	assert.equal(out(b.fold(5, B, 0, [create(d3, "img.png", H(3))])).kind, "suffixed");
	// Kind must match. U+017F folds to "s", so "x.canvaſ" (blob) shares the key of "x.canvas" (canvas).
	const k = world();
	k.fold(1, A, 0, [create(d1, "x.canvas", H(1))]);
	assert.deepEqual(out(k.fold(2, B, 0, [create(d2, "x.canva\u017f", H(1))])), { kind: "suffixed", requestedPath: "x.canva\u017f", finalPath: "x (2).canva\u017f" });
	assert.equal(out(k.fold(3, B, 0, [create(d3, "X.CANVAS", H(1), "canvas")])).kind, "merged");
});

test("E4 ancestor is a live file", () => {
	const w = world();
	w.fold(19, A, 0, [create(d5, "Projects", H(5), "blob")]);
	const ev = w.fold(20, C, 19, [create(d6, "Projects/plan.md")]);
	assert.deepEqual(out(ev), { kind: "suffixed", requestedPath: "Projects/plan.md", finalPath: "Projects (2)/plan.md" });
	// The folder now exists; a differently cased request adopts its casing.
	const ev2 = w.fold(21, A, 20, [create(d7, "projects (2)/b.md")]);
	assert.deepEqual(out(ev2), { kind: "suffixed", requestedPath: "projects (2)/b.md", finalPath: "Projects (2)/b.md" });
	// A file named like an existing folder is suffixed (file key == folder key is a collision).
	const ev3 = w.fold(22, A, 21, [create(d8, "projects (2)", H(8), "blob")]);
	assert.deepEqual(out(ev3), { kind: "suffixed", requestedPath: "projects (2)", finalPath: "projects (2) (2)" });
});

test("E5 rename vs rename (LWW) and two docs to one target", () => {
	const w = world();
	w.fold(19, A, 0, [create(d1, "a.md"), create(d2, "q.md", H(2))]);
	assert.deepEqual(out(w.fold(20, A, 19, [rename(d1, "b.md")])), { kind: "applied" });
	assert.deepEqual(out(w.fold(21, B, 19, [rename(d1, "c.md")])), { kind: "applied" });
	assert.equal(w.e(d1).path, "c.md");
	assert.equal(w.e(d1).lastTouchSeq, 21);
	assert.deepEqual(out(w.fold(22, A, 21, [rename(d1, "z.md")])), { kind: "applied" });
	assert.deepEqual(out(w.fold(23, B, 21, [rename(d2, "Z.md")])), { kind: "suffixed", requestedPath: "Z.md", finalPath: "Z (2).md" });
	assert.deepEqual(out(w.fold(24, B, 23, [rename(d2, "Z (2).md")])), ignored("noop"));
});

test("E6 rename vs delete, both orders: the rename wins", () => {
	const w = world();
	w.fold(30, A, 0, [create(d7, "r.md")]);
	assert.deepEqual(out(w.fold(31, A, 30, [rename(d7, "s.md")])), { kind: "applied" });
	assert.deepEqual(out(w.fold(32, B, 30, [del(d7, 28)])), ignored("stale-delete"));
	assert.equal(w.e(d7).state, "live");
	assert.equal(w.e(d7).path, "s.md");

	const v = world();
	v.fold(30, A, 0, [create(d7, "r.md")]);
	assert.deepEqual(out(v.fold(31, B, 30, [del(d7, 28)])), { kind: "deleted" });
	assert.equal(v.e(d7).deletedSeq, 31);
	assert.equal(v.e(d7).deleteBaseBodySeq, 28);
	assert.equal(v.index.tombstones, 1);
	assert.equal(v.index.byPathKey.size, 0);
	assert.deepEqual(out(v.fold(32, A, 30, [rename(d7, "s.md")])), { kind: "revived", finalPath: "s.md" });
	const e = v.e(d7);
	assert.equal(e.state, "live");
	assert.equal(e.deletedSeq, 0);
	assert.equal(e.deleteBaseBodySeq, 0);
	assert.equal(e.lastTouchSeq, 32);
	assert.equal(v.index.tombstones, 0);
	// An author who saw the delete cannot revive by renaming.
	v.fold(33, B, 32, [del(d7, 0)]);
	assert.deepEqual(out(v.fold(34, A, 33, [rename(d7, "t.md")])), ignored("stale-revive"));
	assert.deepEqual(out(v.fold(35, A, 34, [del(d7)])), ignored("already-deleted"));
});

test("E7 edit vs delete: restore revives; stale and late restores are ignored", () => {
	const w = world();
	w.fold(10, A, 0, [create(d8, "Notes/e.md")]);
	assert.deepEqual(out(w.fold(41, B, 40, [del(d8, 40)])), { kind: "deleted" });
	assert.deepEqual(out(w.fold(42, C, 41, [restore(d8, "Notes/e.md", 40)])), ignored("restore-not-current"));
	assert.deepEqual(out(w.fold(43, A, 41, [restore(d8, "Notes/e.md", 41)])), { kind: "revived", finalPath: "Notes/e.md" });
	assert.equal(w.e(d8).lastTouchSeq, 43);
	assert.deepEqual(out(w.fold(44, C, 41, [restore(d8, "Notes/e.md", 41)])), ignored("not-deleted"));
	// Restore whose path is now taken gets suffixed but reported as revived.
	w.fold(45, B, 44, [del(d8, 50)]);
	w.fold(46, B, 45, [create(d9, "Notes/e.md", H(9))]);
	assert.deepEqual(out(w.fold(47, A, 45, [restore(d8, "Notes/e.md", 45)])), { kind: "revived", finalPath: "Notes/e (2).md" });
	// Restore checks path validity and kind.
	w.fold(48, B, 47, [del(d8)]);
	assert.deepEqual(out(w.fold(49, A, 48, [restore(d8, "bad/", 48)])), ignored("invalid-path"));
	assert.deepEqual(out(w.fold(50, A, 49, [restore(d8, "Notes/e.png", 48)])), ignored("kind-mismatch"));
});

test("E8 setBlob keep-both: second CAS loses with rev-mismatch", () => {
	const w = world();
	w.fold(50, A, 0, [create(d9, "img.png", H(0))]);
	assert.deepEqual(w.e(d9).blob, { hash: H(0), size: 3, rev: 50 });
	assert.deepEqual(out(w.fold(51, A, 50, [setBlob(d9, H(1), 50)])), { kind: "applied" });
	assert.deepEqual(w.e(d9).blob, { hash: H(1), size: 5, rev: 51 });
	assert.equal(w.e(d9).lastTouchSeq, 51);
	assert.deepEqual(out(w.fold(52, B, 50, [setBlob(d9, H(2), 50)])), ignored("rev-mismatch"));
	assert.deepEqual(out(w.fold(53, B, 52, [setBlob(d9, H(1), 0)])), ignored("noop"));
	w.fold(54, A, 0, [create(d1, "n.md")]);
	assert.deepEqual(out(w.fold(55, A, 54, [setBlob(d1, H(1), 54)])), ignored("not-blob"));
	// setBlob on a deleted blob: revive when the author had not seen the delete.
	w.fold(56, B, 55, [del(d9)]);
	assert.deepEqual(out(w.fold(57, A, 55, [setBlob(d9, H(7), 51)])), { kind: "revived", finalPath: "img.png" });
	assert.deepEqual(w.e(d9).blob, { hash: H(7), size: 5, rev: 57 });
	w.fold(58, B, 57, [del(d9)]);
	assert.deepEqual(out(w.fold(59, A, 58, [setBlob(d9, H(8), 57)])), ignored("stale-revive"));
});

test("E9 dedupe ring: resend inside the ring is a duplicate frame; outside it folds again", () => {
	const w = world();
	const f1 = F();
	w.fold(60, A, 0, [create(d1, "a.md")], f1);
	const before = encodeNsFoldV1(w.state);
	const ev = w.fold(75, A, 60, [create(d1, "a.md")], f1);
	assert.deepEqual(ev, [{ seq: 75, index: -1, deviceId: A, clientFrameId: f1, docId: null, outcome: ignored("duplicate-frame") }]);
	assert.equal(w.state.coversSeq, 75);
	const after = decodeNsFoldV1(encodeNsFoldV1(w.state))!;
	after.coversSeq = 60;
	assert.ok(bytesEqual(encodeNsFoldV1(after), before), "only coversSeq changed");
	// The same id from another device is not a duplicate.
	assert.deepEqual(out(w.fold(76, B, 75, [create(d2, "b.md")], f1)), { kind: "applied" });
	// 64 more frames from A push f1 out of the ring.
	for (let i = 0; i < 64; i++) w.fold(100 + i, A, 76, []);
	assert.equal(w.state.recentFrames.get(A)!.length, 64);
	assert.ok(!w.state.recentFrames.get(A)!.includes(f1));
	assert.deepEqual(out(w.fold(200, A, 76, [create(d1, "a.md")], f1)), ignored("duplicate-docid"));
});

test("E10 case-only renames: leaf, folder recase, concurrent create adopts the new casing", () => {
	const w = world();
	w.fold(70, A, 0, [create(d10, "Notes/todo.md"), create(d11, "Notes/x.md", H(2))]);
	assert.deepEqual(out(w.fold(80, A, 70, [rename(d10, "Notes/TODO.md")])), { kind: "applied" });
	assert.equal(w.e(d10).path, "Notes/TODO.md");
	const ev = w.fold(81, A, 80, [rename(d10, "notes/TODO.md"), rename(d11, "notes/x.md")]);
	assert.deepEqual(out(ev, 0), { kind: "applied" });
	assert.deepEqual(out(ev, 1), ignored("noop"));
	assert.equal(w.e(d11).path, "notes/x.md");
	assert.equal(w.e(d11).lastTouchSeq, 70, "recase does not touch");
	assert.deepEqual(w.index.folderRefs.get("notes" as never), { path: "notes", count: 2 });
	assert.deepEqual(out(w.fold(82, B, 79, [create(d12, "Notes/new.md")])), { kind: "suffixed", requestedPath: "Notes/new.md", finalPath: "notes/new.md" });
	// A plain rename into a differently-cased folder adopts the casing (no recase).
	assert.deepEqual(out(w.fold(83, B, 82, [rename(d12, "NOTES/n2.md")])), { kind: "suffixed", requestedPath: "NOTES/n2.md", finalPath: "notes/n2.md" });
	// Nested recase rewrites the deeper prefix too.
	const v = world();
	v.fold(1, A, 0, [create(d1, "A/B/one.md"), create(d2, "A/B/C/two.md", H(2)), create(d3, "A/other.md", H(3))]);
	v.fold(2, A, 1, [rename(d1, "a/b/one.md")]);
	assert.deepEqual([v.e(d1).path, v.e(d2).path, v.e(d3).path], ["a/b/one.md", "a/b/C/two.md", "a/other.md"]);
});

test("E10b recase is skipped when it would push another entry over 1024 bytes", () => {
	const w = world();
	const seg = "s".repeat(200);
	const leaf = "l".repeat(209) + ".md";
	const long = `Straße/${seg}/${seg}/${seg}/${seg}/${leaf}`;
	assert.equal(new TextEncoder().encode(long).length, 1024);
	w.fold(1, A, 0, [create(d1, long), create(d2, "Straße/y.md", H(2))]);
	const ev = w.fold(2, A, 1, [rename(d2, "STRAẞE/y.md")]);
	assert.deepEqual(out(ev), { kind: "suffixed", requestedPath: "STRAẞE/y.md", finalPath: "Straße/y.md" });
	assert.equal(w.e(d1).path, long);
	// Without the long entry the recase happens.
	w.fold(3, A, 2, [del(d1)]);
	assert.deepEqual(out(w.fold(4, A, 3, [rename(d2, "STRAẞE/y.md")])), { kind: "applied" });
	assert.deepEqual(w.index.folderRefs.get("strasse" as never), { path: "STRAẞE", count: 1 });
});

test("E11 prune at 20001 tombstones down to 19000; later ops on pruned ids are unknown-docid", () => {
	const w = world();
	let seq = 1;
	const N = 20001;
	let pruned: NsFoldEvent | undefined;
	for (let base = 0; base < N; base += 500) {
		const ids = Array.from({ length: Math.min(500, N - base) }, (_, i) => D(`p${base + i}`));
		w.fold(seq, A, 0, ids.map((id, i) => create(id, `t/${base + i}.md`)));
		const ev = w.fold(seq + 1, A, seq, ids.map((id) => del(id)));
		seq += 2;
		assert.ok(ev.slice(0, ids.length).every((e) => e.outcome.kind === "deleted"));
		const p = ev.find((e) => e.outcome.kind === "pruned");
		if (p) {
			assert.equal(base, 20000, "first prune when tombstones reach 20001");
			pruned = p;
		}
	}
	assert.equal(w.index.tombstones, 19000);
	assert.equal(w.state.entries.size, 19000);
	assert.ok(pruned);
	assert.equal(pruned.index, -1);
	assert.equal(pruned.docId, null);
	const docIds = prunedIds(pruned);
	assert.equal(docIds.length, 1001);
	// Oldest by (lastTouchSeq, docId): the first delete frame (seq 2), then the second (seq 4), then one of the third.
	const batch = (from: number) => Array.from({ length: 500 }, (_, i) => D(`p${from + i}`)).sort();
	assert.deepEqual(docIds, [...batch(0), ...batch(500), batch(1000)[0]]);
	const last = w.state.coversSeq;
	assert.deepEqual(out(w.fold(last + 1, A, last, [rename(D("p0"), "x.md")])), ignored("unknown-docid"));
	assert.deepEqual(out(w.fold(last + 2, A, last, [create(D("p0"), "p0.md")])), { kind: "applied" }, "pruned id is free again");
});

test("E11b prune removes aliases of a deleted entry first", () => {
	const rules: NsFoldRules = { ...DEFAULT_NS_FOLD_RULES, tombstoneCap: 3, pruneHysteresis: 1 };
	const w = world(rules);
	w.fold(1, A, 0, [create(d1, "w.md", H(1))]);
	w.fold(2, B, 0, [create(d2, "w.md", H(1)), create(d3, "W.md", H(1))]); // 2 aliases of d1
	w.fold(3, A, 2, [create(d4, "z.md", H(4))]);
	w.fold(4, A, 3, [del(d4)]); // tombstones 3 (d2, d3, d4)
	const ev = w.fold(5, A, 4, [del(d1)]); // 4 > 3 -> prune to 2
	const p = ev.find((e) => e.outcome.kind === "pruned")!;
	// Oldest by lastTouchSeq: d2/d3 (2), d4 (4), d1 (5). Removing d2 brings us to 3, d3 to 2.
	assert.deepEqual(prunedIds(p), [d2, d3]);
	assert.equal(w.index.tombstones, 2);
	const v = world({ ...DEFAULT_NS_FOLD_RULES, tombstoneCap: 2, pruneHysteresis: 1 });
	v.fold(1, A, 0, [create(d1, "w.md", H(1))]);
	v.fold(2, A, 1, [del(d1)]); // d1 deleted at 2
	v.fold(3, A, 2, [create(d5, "w.md", H(5))]);
	v.fold(4, B, 0, [create(d2, "w.md", H(5))]); // alias of d5 (live)
	v.fold(5, A, 4, [del(d5)]); // tombstones: d1, d2, d5 = 3 > 2 -> to 1
	// Order: d1 (2), d2 (4), d5 (5): d1 removed (2 left), d2 removed (1 left). d5 kept.
	assert.deepEqual([...v.state.entries.keys()], [d5]);
	const x = world({ ...DEFAULT_NS_FOLD_RULES, tombstoneCap: 1, pruneHysteresis: 1 });
	x.fold(1, A, 0, [create(d5, "w.md", H(5))]);
	x.fold(2, B, 0, [create(d2, "w.md", H(5))]); // alias of d5, lastTouch 2
	x.fold(3, A, 2, [del(d5)]); // d5 lastTouch 3, tombstones 2 > 1 -> goal 0
	assert.equal(x.state.entries.size, 0);
	// An alias is always older than its target's delete, so (lastTouchSeq, docId) order already removes it first.
	const y = world({ ...DEFAULT_NS_FOLD_RULES, tombstoneCap: 2, pruneHysteresis: 2 });
	y.fold(1, A, 0, [create(d5, "w.md", H(5))]);
	y.fold(2, A, 1, [del(d5)]);
	y.fold(3, A, 2, [restore(d5, "w.md", 2)]);
	y.fold(4, B, 0, [create(d2, "w.md", H(5))]); // alias, lastTouch 4
	y.fold(5, A, 4, [del(d5)]);
	y.fold(6, A, 5, [create(d6, "q.md", H(6))]);
	const ev2 = y.fold(7, A, 6, [del(d6)]);
	assert.deepEqual(prunedIds(ev2.find((e) => e.outcome.kind === "pruned")), [d2, d5, d6]);
});

test("E12 upgradeRules halt: frame folds whole or not at all", () => {
	const w = world();
	w.fold(9099, A, 0, [create(d1, "a.md")]);
	const before = encodeNsFoldV1(w.state);
	const ev = foldNsFrame(w.state, w.index, { seq: 9100, deviceId: A, clientFrameId: F(), frameNo: 5, authorNsSeq: 9099, ops: [create(d2, "b.md"), { t: "upgradeRules", version: 2 }] });
	assert.ok(nsFoldHalted(ev));
	assert.deepEqual(ev.map((e) => [e.index, e.docId, e.outcome]), [[1, null, ignored("rules-version")]]);
	assert.equal(w.state.coversSeq, 9099);
	assert.ok(bytesEqual(encodeNsFoldV1(w.state), before), "state unchanged (the halted frame's frameNo is not in the window)");
	assert.ok(!nsFoldHalted(w.fold(9101, A, 0, [create(d3, "c.md")])));
	// A reader that knows v2 applies it once; repeats are noops.
	const v = world({ ...DEFAULT_NS_FOLD_RULES, knownRulesVersion: 2 });
	assert.deepEqual(v.fold(1, A, 0, [{ t: "upgradeRules", version: 2 }])[0]!, { seq: 1, index: 0, deviceId: A, clientFrameId: v.state.recentFrames.get(A)![0]!, docId: null, outcome: { kind: "applied" } });
	assert.equal(v.state.foldRulesVersion, 2);
	assert.deepEqual(out(v.fold(2, A, 0, [{ t: "upgradeRules", version: 1 }])), ignored("noop"));
	assert.deepEqual(out(v.fold(3, A, 0, [{ t: "upgradeRules", version: 2 }])), ignored("noop"));
});

test("replay window (e2ee-design §8.2): pre-scan, ring, window, ops; a rejected frame changes nothing but coversSeq", () => {
	const w = world();
	assert.equal(out(w.fold(1, A, 0, [create(d1, "a.md")], F(), 80)).kind, "applied");
	// Halted frames never reach the window: the same frameNo folds later.
	const before = encodeNsFoldV1(w.state);
	assert.ok(nsFoldHalted(foldNsFrame(w.state, w.index, { seq: 2, deviceId: A, clientFrameId: F(), frameNo: 81, authorNsSeq: 1, ops: [{ t: "upgradeRules", version: 9 }] })));
	assert.ok(bytesEqual(encodeNsFoldV1(w.state), before));
	assert.equal(out(w.fold(3, A, 1, [create(d2, "b.md")], F(), 81)).kind, "applied");
	// Duplicate frameNo under a fresh clientFrameId, then stale (<= r - 64): frame-level, index -1, no ops.
	const snap = encodeNsFoldV1(w.state);
	for (const [seq, no, reason] of [[4, 80, "replay-duplicate"], [5, 17, "replay-stale"]] as const) {
		const fresh = F();
		const ev = w.fold(seq, A, 1, [create(d3, "c.md")], fresh, no);
		assert.deepEqual(ev.map((e) => [e.index, e.docId, e.outcome]), [[-1, null, ignored(reason)]]);
		assert.ok(!w.state.recentFrames.get(A)!.includes(fresh));
	}
	assert.equal(w.state.coversSeq, 5);
	const after = decodeNsFoldV1(encodeNsFoldV1(w.state))!;
	assert.deepEqual([after.replay, after.recentFrames, after.entries.size], [decodeNsFoldV1(snap)!.replay, decodeNsFoldV1(snap)!.recentFrames, 2]);
	// Ring first: a replayed clientFrameId reports duplicate-frame whatever its frameNo.
	assert.deepEqual(out(w.fold(6, A, 1, [], w.state.recentFrames.get(A)![0]!, 18)), ignored("duplicate-frame"));
	// Inside the window, out of order, accepted once.
	assert.equal(out(w.fold(7, A, 1, [create(d3, "c.md")], F(), 18)).kind, "applied");
	assert.deepEqual(out(w.fold(8, A, 1, [create(d4, "d.md")], F(), 18)), ignored("replay-duplicate"));
	// Overlay: own pending frameNos fold through the same window on the clone.
	const o = overlayPending(w.state, w.index, A, [{ clientFrameId: F(), frameNo: 82, authorNsSeq: 8, ops: [create(d4, "d.md")] }]);
	assert.equal(o.state.replay.get(A)!.r, 82);
	assert.equal(w.state.replay.get(A)!.r, 81);
});

test("malformed frames fold as empty (ring + coversSeq only); seq <= coversSeq is ignored", () => {
	assert.equal(decodeNsOps(new Uint8Array([1, 9, 0])), null);
	const w = world();
	const f = F();
	assert.deepEqual(w.fold(1, A, 0, [], f), []);
	assert.equal(w.state.coversSeq, 1);
	assert.deepEqual(w.state.recentFrames.get(A), [f]);
	assert.equal(out(w.fold(2, A, 0, [create(d1, "a.md")], f)).kind, "ignored");
	assert.deepEqual(foldNsFrame(w.state, w.index, { seq: 2, deviceId: B, clientFrameId: F(), frameNo: 1, authorNsSeq: 0, ops: [create(d2, "b.md")] }), []);
	assert.equal(w.state.entries.size, 0);
});

test("create checks: duplicate-docid, invalid-path, kind-mismatch; unknown-docid for others", () => {
	const w = world();
	w.fold(1, A, 0, [create(d1, "a.md")]);
	const ev = w.fold(2, A, 1, [
		create(d1, "b.md"),
		create(d2, "bad//x.md"),
		create(d3, ".hidden.md"),
		create(d4, "CON.md"),
		create(d5, "é.md"),
		create(d6, "x.png", H(1), "markdown"),
		create(d7, "trail.md "),
		rename(d9, "q.md"),
		del(d9),
		restore(d9, "q.md", 1),
		setBlob(d9, H(1), 0),
		rename(d1, "a.png"),
	]);
	assert.deepEqual(ev.map((e) => e.outcome), [
		ignored("duplicate-docid"), ignored("invalid-path"), ignored("invalid-path"), ignored("invalid-path"), ignored("invalid-path"),
		ignored("kind-mismatch"), ignored("invalid-path"), ignored("unknown-docid"), ignored("unknown-docid"), ignored("unknown-docid"),
		ignored("unknown-docid"), ignored("kind-mismatch"),
	]);
	assert.equal(ev[7]!.docId, d9);
});

test("leaf suffix trims the stem to the segment byte limit; docId forms after n is exhausted", () => {
	const w = world();
	const leaf = "x".repeat(252) + ".md";
	w.fold(1, A, 0, [create(d1, leaf, H(1)), create(d2, leaf, H(2))]);
	assert.equal(w.e(d2).path, "x".repeat(248) + " (2).md");
	// Multi-byte stem: trimming never splits a code point; trailing spaces are stripped after trimming.
	const emoji = "😀".repeat(62) + " .md";
	w.fold(2, A, 1, [create(d3, emoji, H(3)), create(d4, emoji, H(4))]);
	assert.equal(w.e(d4).path, "😀".repeat(62) + " (2).md");
	// Exhausting n = 2..10000 falls back to the docId8 form, then the full docId.
	const v = world();
	const id1 = D("AAAAAAAAzz");
	v.fold(1, A, 0, [create(D("w0"), "f.md", H(1))]);
	const ops: NsOp[] = [];
	for (let n = 2; n <= 10000; n++) ops.push(create(D(`w${n}`), `f (${n}).md`, H(n % 250)));
	v.fold(2, A, 1, ops);
	assert.deepEqual(out(v.fold(3, B, 2, [create(id1, "f.md", H(255))])), { kind: "suffixed", requestedPath: "f.md", finalPath: "f (AAAAAAAA).md" });
	assert.deepEqual(out(v.fold(4, B, 3, [create(D("AAAAAAAAyy"), "f.md", H(254))])), { kind: "suffixed", requestedPath: "f.md", finalPath: `f (AAAAAAAAyy____________).md` });
});

test("verify V1: canonical bytes pass; unsorted, duplicate, trailing and non-minimal are rejected", () => {
	const w = world();
	w.fold(1, A, 0, [create(d2, "Notes/b.md", H(2)), create(d1, "Notes/a.md", H(1))]);
	w.fold(2, B, 0, [create(d3, "Notes/a.md", H(1))]);
	const bytes = encodeNsFoldV1(w.state);
	const ok = verifyNsFoldBytes(bytes, 2);
	assert.ok(ok.ok);
	assert.equal(verifyNsFoldBytes(bytes, 3).ok, false);
	assert.deepEqual(verifyNsCheckpoint({ encoding: CheckpointEncoding.nsFoldV1, coversSeq: 2, foldRulesVersion: 1, state: bytes }, 2).ok, true);
	assert.equal(verifyNsCheckpoint({ encoding: CheckpointEncoding.nsFoldV1, coversSeq: 2, foldRulesVersion: 2, state: bytes }, 2).ok, false);
	assert.equal(verifyNsCheckpoint({ encoding: CheckpointEncoding.cfgFoldV1, coversSeq: 2, foldRulesVersion: 1, state: bytes }, 2).ok, false);

	const raw = (s: NsFoldState, ids: DocId[], devices: DeviceId[]) => {
		const wr = new Writer();
		wr.varuint(1).varuint(s.foldRulesVersion).varuint(s.coversSeq).varuint(ids.length);
		for (const id of ids) {
			const e = s.entries.get(id)!;
			wr.varstring(e.docId).u8(e.kind === "markdown" ? 1 : e.kind === "canvas" ? 2 : 3).u8(e.state === "live" ? 1 : e.state === "deleted" ? 2 : 3).varstring(e.path);
			wr.varuint(e.createdSeq).varstring(e.createdBy).varuint(e.lastTouchSeq).varuint(e.deletedSeq).varuint(e.deleteBaseBodySeq);
			wr.raw(hashToBytes(e.createHash)).varuint(e.createSize).u8(0);
			if (e.aliasOf) wr.u8(1).varstring(e.aliasOf);
			else wr.u8(0);
		}
		wr.varuint(devices.length);
		for (const d of devices) {
			const ring = s.recentFrames.get(d)!;
			wr.varstring(d).varuint(ring.length);
			for (const f of ring) wr.varstring(f);
		}
		const replayDevices = [...s.replay.keys()].sort();
		wr.varuint(replayDevices.length);
		for (const d of replayDevices) wr.varstring(d).varuint(s.replay.get(d)!.r).raw(replayBitsToBytes(s.replay.get(d)!.bits));
		return wr.finish();
	};
	assert.ok(bytesEqual(raw(w.state, [d1, d2, d3], [A, B]), bytes), "raw helper matches the encoder");
	const unsorted = verifyNsFoldBytes(raw(w.state, [d2, d1, d3], [A, B]), 2);
	assert.equal(!unsorted.ok && unsorted.reason, "non-canonical");
	const dup = verifyNsFoldBytes(raw(w.state, [d1, d1, d2, d3], [A, B]), 2);
	assert.equal(!dup.ok && dup.reason, "non-canonical");
	const rings = verifyNsFoldBytes(raw(w.state, [d1, d2, d3], [B, A]), 2);
	assert.equal(!rings.ok && rings.reason, "non-canonical");
	const trailing = verifyNsFoldBytes(new Uint8Array([...bytes, 0]), 2);
	assert.equal(!trailing.ok && trailing.reason, "malformed");
	const nonMinimal = verifyNsFoldBytes(new Uint8Array([0x81, 0x00, ...bytes.subarray(1)]), 2);
	assert.equal(!nonMinimal.ok && nonMinimal.reason, "malformed");
});

test("verify V2: invariant violations and upgrade-required", () => {
	const w = world();
	w.fold(1, A, 0, [create(d1, "Notes/a.md", H(1)), create(d2, "img.png", H(2))]);
	const base = () => decodeNsFoldV1(encodeNsFoldV1(w.state))!;
	const bad = (mut: (s: NsFoldState) => void, expect: string | RegExp) => {
		const s = base();
		mut(s);
		const r = verifyNsFoldBytes(encodeNsFoldV1(s), s.coversSeq);
		assert.equal(r.ok, false);
		if (!r.ok) {
			if (typeof expect === "string") assert.equal(r.reason, expect);
			else assert.match(r.detail, expect);
		}
	};
	const patch = (s: NsFoldState, id: DocId, p: object) => s.entries.set(id, { ...s.entries.get(id)!, ...p });
	bad((s) => patch(s, d2, { path: "Notes/a.md", kind: "markdown", blob: null }), /live pathKey notes\/a.md/);
	bad((s) => patch(s, d2, { path: "notes" }), /also a folder key/);
	bad((s) => patch(s, d1, { path: "bad/" }), /invalid path/);
	bad((s) => patch(s, d1, { path: "Notes/a.png" }), /kindOfPath/);
	bad((s) => patch(s, d1, { lastTouchSeq: 5 }), /> coversSeq/);
	bad((s) => patch(s, d1, { state: "deleted" }), /deleted fields/);
	bad((s) => patch(s, d1, { state: "merged", aliasOf: D("zz") }), /missing/);
	bad((s) => patch(s, d2, { blob: null }), /blob presence/);
	bad((s) => { s.foldRulesVersion = 2; }, "upgrade-required");
	bad((s) => { s.foldRulesVersion = 0; }, /foldRulesVersion/);
	bad((s) => { s.recentFrames.set(B, ["short" as ClientFrameId]); }, /invalid id/);
	bad((s) => {
		patch(s, d2, { path: "notes/b.md", kind: "markdown", blob: null });
	}, /casing/);
	assert.equal(verifyNsFoldState(base()).ok, true);
});

test("V3 candidates and digest ring", async () => {
	assert.equal(isCandidateSeq(999, 1000), true);
	assert.equal(isCandidateSeq(1000, 1001), false);
	assert.equal(isCandidateSeq(998, 2500), true);
	assert.equal(isCandidateSeq(0, 999), false);
	assert.equal(isCandidateSeq(1999, 2000), true);
	let ring = recordDigest([], 1000, "aa");
	for (let i = 2; i <= 20; i++) ring = recordDigest(ring, i * 1000, `d${i}`);
	assert.equal(ring.length, 16);
	assert.equal(ring[0]!.seq, 5000);
	assert.equal(checkDigest(ring, 1000, "aa"), "unknown");
	assert.equal(checkDigest(ring, 20000, "d20"), "match");
	assert.equal(checkDigest(ring, 20000, "zz"), "mismatch");
	const sha = { sha256: async (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest()) };
	const w = world();
	w.fold(1, A, 0, [create(d1, "a.md")]);
	const dg = await nsFoldDigest(w.state, sha);
	assert.equal(dg, createHash("sha256").update(encodeNsFoldV1(w.state)).digest("hex"));
});

test("overlay folds pending frames on a clone; committed state untouched", () => {
	const w = world();
	w.fold(5, A, 0, [create(d1, "Notes/a.md"), create(d2, "Notes/b.md", H(2))]);
	const before = encodeNsFoldV1(w.state);
	const o = overlayPending(w.state, w.index, B, [
		{ clientFrameId: F(), frameNo: 1, authorNsSeq: 5, ops: [create(d3, "Notes/a.md", H(3))] },
		{ clientFrameId: F(), frameNo: 2, authorNsSeq: 5, ops: [rename(d1, "notes/a.md")] },
	]);
	assert.ok(bytesEqual(encodeNsFoldV1(w.state), before));
	assert.equal(checkNsInvariants(w.state, w.index), null);
	assert.equal(checkNsInvariants(o.state, o.index), null);
	assert.deepEqual(o.events.map((e) => e.outcome.kind), ["suffixed", "applied"]);
	assert.deepEqual(o.touched, [d1, d2, d3], "recased d2 counts as touched");
	assert.equal(o.state.entries.get(d2)!.path, "notes/b.md");
	assert.equal(o.halted, false);
	assert.equal(o.events[0]!.seq, 6);
});

test("index rebuilt from decoded state equals the incrementally maintained one", () => {
	const w = world();
	w.fold(1, A, 0, [create(d1, "X/y/z.md"), create(d2, "X/Y/w.md", H(2)), create(d3, "x/q.md", H(3))]);
	w.fold(2, A, 1, [del(d3), rename(d2, "x/y/w.md")]);
	const s = decodeNsFoldV1(encodeNsFoldV1(w.state))!;
	assert.equal(checkNsInvariants(s, buildIndex(s)), null);
	assert.equal(checkNsInvariants(s, w.index), null);
	assert.ok(bytesEqual(encodeNsOps([create(d1, "a.md")]), encodeNsOps([create(d1, "a.md")])));
});

export type { VaultPath };
