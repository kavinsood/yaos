import { test } from "node:test";
import assert from "node:assert/strict";
import type { LocalEntry, ObservedRename, PathKey, PlannerOp, SyncedEntry } from "../types";
import { ancestorsOf, isValidVaultPath, pathInvalidReason, splitExt, standInPathKey } from "./pathRules";
import { conflictName, formatLocalMinute, sanitizeLabel } from "./conflictName";
import { inferRenames } from "./renames";
import { orderOps, parseTempPath, sortRenames, tempPathFor } from "./order";
import { applyBrake, brakeId, DEFAULT_BRAKE, EMPTY_WINDOW, rejectHeld, type PlanUnit } from "./brake";
import { L, S, h, id } from "./planFixtures";
import { prng } from "../merge/prng";

const pk = standInPathKey;

test("pathRules: §c.2 validity", () => {
	for (const ok of ["a.md", "Notes/a b.md", "x/y/z.canvas", "日本語/ノート.md", "emoji 😀.md", "conman.md", "a.b.c"]) assert.equal(pathInvalidReason(ok), null, ok);
	const bad: [string, string][] = [
		["", "empty"], ["/a.md", "slash"], ["a/", "slash"], ["a//b.md", "empty-segment"], [".obsidian/x.json", "dot-segment"],
		["a/../b.md", "dot-segment"], ["a:b.md", "forbidden-char"], ["a?.md", "forbidden-char"], ["a\u0001.md", "control-char"],
		["a.md ", "trailing-dot-or-space"], ["dir./a.md", "trailing-dot-or-space"], ["CON.md", "reserved-stem"], ["aux", "reserved-stem"],
		["x/nul.tar.gz", "reserved-stem"], ["é.md", "not-nfc"], ["a\ud800.md", "lone-surrogate"], ["a\udc00b.md", "lone-surrogate"],
		[`${"a".repeat(256)}.md`, "segment-too-long"], [`${"abcdefgh/".repeat(120)}x.md`, "path-too-long"],
	];
	for (const [p, reason] of bad) assert.equal(pathInvalidReason(p), reason, JSON.stringify(p));
	assert.equal(pathInvalidReason("a͸.md", (c) => c !== 0x378), "forbidden-char");
	assert.deepEqual(splitExt(".hidden"), { stem: ".hidden", ext: "" });
	assert.deepEqual(splitExt("a.tar.gz"), { stem: "a.tar", ext: ".gz" });
	assert.deepEqual(ancestorsOf("a/b/c.md"), ["a", "a/b"]);
});

test("conflictName: §f.7 pattern, suffixes, fallbacks", () => {
	const base = { docId: id("abcdefghijk"), deviceLabel: "B", nowMs: 1_791_209_520_000, tzOffsetMinutes: 0, pathKey: pk, isTaken: () => false };
	assert.equal(conflictName({ ...base, path: "img.png" }), "img (conflict B 2026-10-05 1412).png");
	assert.equal(conflictName({ ...base, path: "d/n.md", tzOffsetMinutes: 330 }), "d/n (conflict B 2026-10-05 1942).md");
	const taken = new Set<PathKey>([pk("n (conflict B 2026-10-05 1412).md"), pk("n (conflict B 2026-10-05 1412 2).md")]);
	assert.equal(conflictName({ ...base, path: "n.md", isTaken: (k) => taken.has(k) }), "n (conflict B 2026-10-05 1412 3).md");
	assert.equal(conflictName({ ...base, path: "n.md", deviceLabel: "  My: Phone? \u0007 " }), "n (conflict My Phone 2026-10-05 1412).md");
	assert.equal(conflictName({ ...base, path: "n.md", deviceLabel: "" }), "n (conflict 2026-10-05 1412).md");
	// overlong stem: fallback with docId8, truncated
	const long = `${"x".repeat(250)}.md`;
	const name = conflictName({ ...base, path: long });
	assert.ok(isValidVaultPath(name), name);
	assert.ok(name.includes("(conflict abcdefgh)"), name);
	assert.equal(sanitizeLabel("a/b\\c*d"), "abcd");
	assert.equal([...sanitizeLabel("x".repeat(100))].length, 32);
	assert.equal(formatLocalMinute(0, 0), "1970-01-01 0000");
	assert.equal(formatLocalMinute(951_782_400_000, 0), "2000-02-29 0000");
	assert.equal(formatLocalMinute(-60_000, 0), "1969-12-31 2359");
});

test("conflictName: always a valid path (fuzz, 3000 cases)", () => {
	const rnd = prng(42);
	const alphabet = ["a", "Z", " ", ".", "é", "😀", "́", "-", "(", ")", "日", "con", "x".repeat(60), "ü"];
	const labels = ["B", "", "  ", "Phone: 1?", "😀".repeat(40), "a/b", "\u0000\u001f", "con", "Kavin's MacBook Pro (2)", "x".repeat(300)];
	for (let i = 0; i < 3000; i++) {
		const segs: string[] = [];
		const nSeg = 1 + Math.floor(rnd() * 4);
		for (let s = 0; s < nSeg; s++) {
			let seg = "";
			const len = 1 + Math.floor(rnd() * 6);
			for (let c = 0; c < len; c++) seg += alphabet[Math.floor(rnd() * alphabet.length)]!;
			segs.push(seg);
		}
		const ext = [".md", ".png", ".canvas", "", ".tar.gz"][Math.floor(rnd() * 5)]!;
		const path = (segs.join("/") + ext).normalize("NFC");
		if (!isValidVaultPath(path)) continue; // the source is always a valid vault path
		const taken = new Set<PathKey>();
		const takenCount = Math.floor(rnd() * 4);
		let name = "";
		for (let t = 0; t <= takenCount; t++) {
			name = conflictName({ path, docId: rnd() < 0.2 ? null : id("d0123456789"), deviceLabel: labels[Math.floor(rnd() * labels.length)]!, nowMs: Math.floor(rnd() * 4e12), tzOffsetMinutes: Math.floor(rnd() * 1680) - 840, pathKey: pk, isTaken: (k) => taken.has(k) || k === pk(path) });
			assert.equal(pathInvalidReason(name), null, `${JSON.stringify(path)} -> ${JSON.stringify(name)}`);
			assert.ok(!taken.has(pk(name)) && pk(name) !== pk(path), "must not collide");
			taken.add(pk(name));
		}
	}
});

function shuffled<T>(xs: readonly T[], rnd: () => number): T[] {
	const a = [...xs];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[a[i], a[j]] = [a[j]!, a[i]!];
	}
	return a;
}

test("rename inference: unique pair, score tie-breaks, observed wins, completeness gate", () => {
	const miss = [S("d1", "a/x.md", { contentHash: h("X") })];
	assert.deepEqual(inferRenames(miss, [L("b/x.md", h("X"))], [], true, pk).map((r) => [r.docId, r.to.path, r.via]), [["d1", "b/x.md", "hash"]]);
	assert.deepEqual(inferRenames(miss, [L("b/x.md", h("X"))], [], false, pk), []);
	// kind must match
	assert.deepEqual(inferRenames([S("d1", "a/x.png", { contentHash: h("X") })], [L("b/x.md", h("X"))], [], true, pk), []);
	// equal hashes: same leaf beats same parent beats path order
	const two = [S("d1", "a/x.md", { contentHash: h("E") }), S("d2", "b/y.md", { contentHash: h("E") })];
	const r = inferRenames(two, [L("c/y.md", h("E")), L("a/z.md", h("E"))], [], true, pk);
	assert.deepEqual(r.map((x) => [x.docId, x.to.path]), [["d1", "a/z.md"], ["d2", "c/y.md"]]);
	// observed renames win (even with a content change) and chains resolve
	const obs: ObservedRename[] = [{ from: "a/x.md", to: "t1.md", atMs: 1 }, { from: "t1.md", to: "t2.md", atMs: 2 }];
	const o = inferRenames(miss, [L("t2.md", h("other")), L("b/x.md", h("X"))], obs, false, pk);
	assert.deepEqual(o.map((x) => [x.docId, x.to.path, x.via]), [["d1", "t2.md", "observed"]]);
});

test("rename inference is deterministic and shuffle-invariant (1000 random cases)", () => {
	for (let seed = 1; seed <= 1000; seed++) {
		const rnd = prng(seed);
		const dirs = ["", "a/", "b/", "a/b/"];
		const leaves = ["x.md", "y.md", "z.md", "i.png"];
		const hashes = ["1", "2", "3"].map(h);
		const missing: SyncedEntry[] = [];
		const fresh: LocalEntry[] = [];
		const usedS = new Set<string>();
		const usedL = new Set<string>();
		for (let i = 0; i < 6; i++) {
			const p = dirs[Math.floor(rnd() * 4)]! + leaves[Math.floor(rnd() * 4)]!;
			if (!usedS.has(p)) {
				usedS.add(p);
				missing.push(S(`d${i}`, p, { contentHash: hashes[Math.floor(rnd() * 3)]! }));
			}
			const q = "n/" + dirs[Math.floor(rnd() * 4)]! + leaves[Math.floor(rnd() * 4)]!;
			if (!usedL.has(q)) {
				usedL.add(q);
				fresh.push(L(q, hashes[Math.floor(rnd() * 3)]!));
			}
		}
		const observed: ObservedRename[] = rnd() < 0.5 && missing[0] && fresh[0] ? [{ from: missing[0].path, to: fresh[0].path, atMs: 3 }] : [];
		const a = inferRenames(missing, fresh, observed, true, pk);
		const b = inferRenames(shuffled(missing, rnd), shuffled(fresh, rnd), shuffled(observed, rnd), true, pk);
		assert.deepEqual(b, a, `seed ${seed}`);
		// a doc and a target are used at most once; kinds and hashes match for hash pairs
		assert.equal(new Set(a.map((x) => x.docId)).size, a.length);
		assert.equal(new Set(a.map((x) => x.to.pathKey)).size, a.length);
		for (const x of a) {
			const s = missing.find((m) => m.docId === x.docId)!;
			assert.equal(s.kind, x.to.kind);
			if (x.via === "hash") assert.equal(s.contentHash, x.to.hash);
		}
	}
});

test("order: categories and rename chains/cycles", () => {
	const ops: PlannerOp[] = [
		{ op: "syncedDrop", docId: id("a") },
		{ op: "reconcileContent", docId: id("a"), path: "a.md", kind: "markdown", hasBase: true },
		{ op: "diskTrash", docId: id("t"), path: "t.md", expect: { t: "any" } },
		{ op: "conflictCopy", docId: id("c"), from: "c.md", to: "c2.md", reason: "both-edited", expect: { t: "any" } },
		{ op: "diskMaterialize", docId: id("m"), path: "m.md", expect: { t: "absent" } },
		{ op: "diskRename", docId: id("r"), from: "r.md", to: "s.md", expect: { t: "any" } },
		{ op: "nsCreate", docId: id("n"), kind: "markdown", path: "n.md", contentHash: h("n"), size: 1 },
		{ op: "nsDelete", docId: id("d"), baseBodySeq: 1 },
		{ op: "rebind", fromDocId: id("x"), toDocId: id("y"), path: "y.md" },
	];
	assert.deepEqual(orderOps(ops, pk).map((o) => o.op), ["rebind", "nsDelete", "nsCreate", "diskRename", "diskMaterialize", "conflictCopy", "diskTrash", "reconcileContent", "syncedDrop"]);
	const rn = (d: string, from: string, to: string) => ({ op: "diskRename" as const, docId: id(d), from, to, expect: { t: "any" as const } });
	// chain: a->b requires b->c first
	assert.deepEqual(sortRenames([rn("1", "a", "b"), rn("2", "b", "c")], pk).map((r) => `${r.from}>${r.to}`), ["b>c", "a>b"]);
	// 3-cycle
	const cyc = sortRenames([rn("1", "a.md", "b.md"), rn("2", "b.md", "c.md"), rn("3", "c.md", "a.md")], pk);
	const disk = new Set(["a.md", "b.md", "c.md"]);
	for (const r of cyc) {
		assert.ok(disk.has(r.from) && !disk.has(r.to), `${r.from}>${r.to}`);
		disk.delete(r.from);
		disk.add(r.to);
	}
	assert.equal(cyc.length, 4);
	// case-only rename is not a cycle with itself
	assert.deepEqual(sortRenames([rn("1", "a.md", "A.md")], pk).map((r) => r.to), ["A.md"]);
	assert.equal(tempPathFor("d/x.md", id("abcdefghij")), "d/x (yaos-tmp abcdefgh).md");
	assert.equal(parseTempPath("d/x (yaos-tmp abcdefgh).md"), "abcdefgh");
	assert.equal(parseTempPath("d/x.md"), null);
});

test("order: random rename permutations are always executable", () => {
	for (let seed = 1; seed <= 300; seed++) {
		const rnd = prng(seed);
		const n = 2 + Math.floor(rnd() * 7);
		const names = Array.from({ length: n }, (_, i) => `f${i}.md`);
		const extra = ["g0.md", "g1.md"];
		const targets = shuffled([...names, ...extra], rnd).slice(0, n);
		const renames = names.map((from, i) => ({ op: "diskRename" as const, docId: id(`d${i}`), from, to: targets[i]!, expect: { t: "any" as const } })).filter((r) => r.from !== r.to);
		const sorted = sortRenames(shuffled(renames, rnd), pk);
		const disk = new Map(names.map((p) => [p, p]));
		for (const r of sorted) {
			assert.ok(disk.has(r.from) && !disk.has(r.to), `seed ${seed}: ${r.from}>${r.to}`);
			disk.set(r.to, disk.get(r.from)!);
			disk.delete(r.from);
		}
		for (const r of renames) assert.equal(disk.get(r.to), r.from, `seed ${seed}`);
	}
});

test("brake unit: approval id, rejectHeld", () => {
	const unit = (k: string): PlanUnit => ({ ops: [{ op: "nsDelete", docId: id(k), baseBodySeq: 0 }], destructive: "nsDelete", brakeKey: `nsDelete|${k}`, path: `${k}.md` });
	const units = Array.from({ length: 60 }, (_, i) => unit(`u${i}`));
	const base = { config: DEFAULT_BRAKE, syncedCount: 100, liveLocalCount: null, divergence: false, window: EMPTY_WINDOW, approval: null };
	const out = applyBrake(units, base);
	assert.equal(out.report?.id, brakeId([...units].reverse()));
	assert.equal(out.report?.samplePaths.length, 10);
	assert.equal(applyBrake(units, { ...base, approval: out.report!.id }).held.length, 0);
	assert.deepEqual(
		rejectHeld([{ op: "nsDelete", docId: id("a"), baseBodySeq: 1 }, { op: "diskTrash", docId: id("b"), path: "b.md", expect: { t: "any" } }, { op: "syncedDrop", docId: id("b") }], (d) => (d === "a" ? "a.md" : null)),
		[{ op: "diskMaterialize", docId: "a", path: "a.md", expect: { t: "absent" } }, { op: "syncedDrop", docId: "b" }],
	);
	// a held fileGone mark (a local delete waiting on ns / own frames) is re-created like a held nsDelete
	const S0 = { docId: id("c"), path: "c.md", pathKey: "c.md", kind: "markdown", contentHash: "h", fingerprint: "f", size: 1, mtimeMs: 1, bodyVersion: null, blobRev: 0, nsTouchSeq: 1, hasBase: false } as const;
	assert.deepEqual(
		rejectHeld([{ op: "syncedPut", entry: { ...S0, fileGone: true } as never }, { op: "syncedPut", entry: S0 as never }], () => "c2.md"),
		[{ op: "diskMaterialize", docId: "c", path: "c2.md", expect: { t: "absent" } }],
	);
});
