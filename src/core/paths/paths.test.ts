import { test } from "node:test";
import assert from "node:assert/strict";
import { caseFold15_1, foldKey, pathKey, prefixKeys } from "./pathKey";
import { isAssigned15_1, isValidPath, pathInvalidReason } from "./validate";
import { dropLastCodePoint, splitExt, stripTrailingDotsSpaces, utf8ByteLength } from "./segments";
import { CASE_FOLD_15_1 } from "./casefold15_1";
import { ASSIGNED_15_1 } from "./assigned15_1";

const k = (p: string) => pathKey(p);

test("pathKey: ß / ẞ / SS / ss fold together (full folding, status F)", () => {
	assert.equal(caseFold15_1("ß"), "ss");
	assert.equal(caseFold15_1("ẞ"), "ss");
	assert.equal(k("Maße.md"), "masse.md");
	assert.equal(k("MASSE.md"), k("Maße.md"));
	assert.equal(k("STRAẞE/x.md"), k("strasse/x.md"));
});

test("pathKey: Σ σ ς fold to σ", () => {
	assert.equal(caseFold15_1("Σ"), "σ");
	assert.equal(caseFold15_1("ς"), "σ");
	assert.equal(k("ΟΔΟΣ.md"), k("οδος.md"));
	assert.equal(k("οδος.md"), k("οδοσ.md"));
});

test("pathKey: İ folds to i + U+0307 (no Turkic T mappings); ı stays distinct", () => {
	assert.equal(caseFold15_1("İ"), "i̇");
	assert.equal(k("İ.md"), "i̇.md");
	assert.notEqual(k("İ.md"), k("i.md"));
	assert.notEqual(k("ı.md"), k("i.md"));
	assert.equal(k("I.md"), k("i.md"));
});

test("pathKey: NFC/NFD forms share a key (inner and outer NFC)", () => {
	const nfc = "notes/À.md";
	const nfd = "notes/À.md";
	assert.equal(k(nfc), k(nfd));
	assert.equal(k("b/é.md"), k("b/é.md"));
	// Fold output recomposes: ǰ (U+01F0) folds to j + U+030C, NFC recomposes it.
	assert.equal(k("ǰ"), "ǰ");
	assert.equal(k("J̌"), "ǰ");
	// Kelvin sign and Angstrom sign.
	assert.equal(k("K"), "k");
	assert.equal(k("Å"), "å");
	// Cherokee lowercase folds to uppercase.
	assert.equal(caseFold15_1("ꭰ"), "Ꭰ");
	assert.equal(k("ᏸ"), k("Ᏸ"));
});

test("pathKey: legacy collision fixtures (pathCollision.ts) under the new key", () => {
	const keys = (paths: string[]) => new Set(paths.map(k)).size;
	assert.equal(keys(["notes/À.md", "notes/À.md"]), 1, "NFC vs NFD collide");
	assert.equal(keys(["notes/a.md", "notes/a.md"]), 1, "exact duplicate is one key");
	assert.equal(keys(["notes/a.md", "notes/b.md", "other/c.md"]), 3, "different paths");
	assert.equal(keys(["notes/File.md", "notes/file.md"]), 1, "case-only variants collide now (case folding is on)");
	assert.equal(keys(["a/À.md", "a/À.md", "b/é.md", "b/é.md", "c/normal.md"]), 3);
	assert.equal(isValidPath("notes\\file.md"), false, "backslash separators are invalid, not normalized");
	assert.equal(isValidPath("./notes/file.md"), false, "leading ./ is invalid, not normalized");
});

test("pathKey is segment-wise and prefixKeys matches", () => {
	const samples = ["Notes/Sub/A.md", "Maße/ΟΔΟΣ/İ.png", "x", "J̌/ß", "K/Å/a"];
	for (const p of samples) {
		const segs = p.split("/");
		assert.equal(k(p), segs.map(foldKey).join("/"));
		const pk = prefixKeys(p);
		assert.equal(pk.length, segs.length);
		assert.equal(pk[pk.length - 1], k(p));
		for (let i = 0; i < segs.length; i++) assert.equal(pk[i], k(segs.slice(0, i + 1).join("/")));
	}
});

test("pathKey: ASCII fast path equals the table path", () => {
	let ascii = "";
	for (let c = 0x20; c < 0x7f; c++) ascii += String.fromCharCode(c);
	const slow = [...ascii].map((ch) => caseFold15_1(ch + "é").slice(0, -1)).join("");
	assert.equal(caseFold15_1(ascii), slow);
});

test("generated tables are well formed", () => {
	// casefold: ascending keys, counts 1..3
	let i = 0;
	let prev = -1;
	let n = 0;
	while (i < CASE_FOLD_15_1.length) {
		const cp = CASE_FOLD_15_1[i]!;
		const c = CASE_FOLD_15_1[i + 1]!;
		assert.ok(cp > prev);
		assert.ok(c >= 1 && c <= 3);
		prev = cp;
		i += 2 + c;
		n++;
	}
	assert.equal(n, 1530);
	for (let j = 0; j + 1 < ASSIGNED_15_1.length; j += 2) {
		assert.ok(ASSIGNED_15_1[j]! <= ASSIGNED_15_1[j + 1]!);
		if (j > 0) assert.ok(ASSIGNED_15_1[j]! > ASSIGNED_15_1[j - 1]! + 1, "disjoint, merged");
	}
});

test("assigned: Unicode 15.1 table, unassigned and post-15.1 code points rejected", () => {
	assert.equal(isAssigned15_1(0x41), true);
	assert.equal(isAssigned15_1(0x0378), false);
	assert.equal(isAssigned15_1(0xffff), false);
	assert.equal(isAssigned15_1(0x10ffff), false);
	assert.equal(isAssigned15_1(0xd800), false);
	assert.equal(isAssigned15_1(0xfdd0), false, "noncharacter");
	assert.equal(isAssigned15_1(0x1fffe), false, "noncharacter");
	assert.equal(isAssigned15_1(0xfffd), true);
	assert.equal(isAssigned15_1(0xe000), true, "private use is assigned");
	assert.equal(isAssigned15_1(0x2ffc), true, "new in 15.1");
	assert.equal(isAssigned15_1(0x31ef), true, "new in 15.1");
	assert.equal(isAssigned15_1(0x2ebf0), true, "new in 15.1");
	assert.equal(isAssigned15_1(0x1c89), false, "added in 16.0");
	assert.equal(isAssigned15_1(0x10d50), false, "Garay, added in 16.0");

	assert.equal(pathInvalidReason("a͸.md"), "unassigned");
	assert.equal(pathInvalidReason("a￿.md"), "unassigned");
	assert.equal(pathInvalidReason("Ᲊ.md"), "unassigned");
	assert.equal(pathInvalidReason("a\uD800.md"), "unassigned", "lone high surrogate");
	assert.equal(pathInvalidReason("a\uDC00.md"), "unassigned", "lone low surrogate");
	assert.equal(pathInvalidReason("\u{1F600}.md"), null, "astral emoji ok");
	assert.equal(pathInvalidReason("⿼.md"), null);
});

test("validate: §c.2 rules", () => {
	const ok = ["a.md", "Notes/a.md", "a/b/c/d.png", "con1.md", "console.md", "com0.md", "a b.md", " a.md", "x.tar.gz",
		"Maße.md", "Notes/İ.md", "éx".normalize("NFC") + ".md", "file", "a..b.md"];
	for (const p of ok) assert.equal(pathInvalidReason(p), null, p);
	const bad: Array<[string, string]> = [
		["", "empty"],
		["/a.md", "empty-segment"],
		["a.md/", "empty-segment"],
		["a//b.md", "empty-segment"],
		["./a.md", "dot-segment"],
		["a/../b.md", "dot-segment"],
		["a/./b.md", "dot-segment"],
		[".obsidian/app.json", "dot-segment"],
		["notes/.hidden.md", "dot-segment"],
		["a\\b.md", "forbidden-char"],
		["a*.md", "forbidden-char"],
		["a\".md", "forbidden-char"],
		["a<.md", "forbidden-char"],
		["a>.md", "forbidden-char"],
		["a:b.md", "forbidden-char"],
		["a|.md", "forbidden-char"],
		["a?.md", "forbidden-char"],
		["a\u0000.md", "control-char"],
		["a\u001f.md", "control-char"],
		["a\u007f.md", "control-char"],
		["con.md", "reserved-stem"],
		["CON", "reserved-stem"],
		["x/Aux.tar.gz", "reserved-stem"],
		["lpt9.png", "reserved-stem"],
		["COM1.md", "reserved-stem"],
		["nul", "reserved-stem"],
		["a./b.md", "trailing-dot-or-space"],
		["a /b.md", "trailing-dot-or-space"],
		["a.md.", "trailing-dot-or-space"],
		["a.md ", "trailing-dot-or-space"],
		["é.md", "not-nfc"],
	];
	for (const [p, reason] of bad) assert.equal(pathInvalidReason(p), reason, JSON.stringify(p));
});

test("validate: byte limits per segment (255) and path (1024)", () => {
	assert.equal(pathInvalidReason("a".repeat(252) + ".md"), null);
	assert.equal(pathInvalidReason("a".repeat(253) + ".md"), "segment-too-long");
	// 2-byte chars: 127 * 2 + 1 = 255
	assert.equal(pathInvalidReason("é".repeat(127) + "a"), null);
	assert.equal(pathInvalidReason("é".repeat(128)), "segment-too-long");
	// astral (4 bytes)
	assert.equal(utf8ByteLength("\u{1F600}"), 4);
	assert.equal(pathInvalidReason("\u{1F600}".repeat(63) + "abc"), null);
	assert.equal(pathInvalidReason("\u{1F600}".repeat(64)), "segment-too-long");
	const seg = "a".repeat(200);
	const p1024 = [seg, seg, seg, seg, "b".repeat(1024 - 4 * 201)].join("/");
	assert.equal(utf8ByteLength(p1024), 1024);
	assert.equal(pathInvalidReason(p1024), null);
	assert.equal(pathInvalidReason(p1024 + "c"), "path-too-long");
});

test("segments helpers", () => {
	assert.deepEqual(splitExt("a.tar.gz"), { stem: "a.tar", ext: ".gz" });
	assert.deepEqual(splitExt("noext"), { stem: "noext", ext: "" });
	assert.deepEqual(splitExt(".x"), { stem: ".x", ext: "" });
	assert.equal(dropLastCodePoint("a\u{1F600}"), "a");
	assert.equal(dropLastCodePoint("ab"), "a");
	assert.equal(stripTrailingDotsSpaces("a. . "), "a");
	assert.equal(utf8ByteLength("a\uD800"), 4, "lone surrogate counts as U+FFFD");
	assert.equal(utf8ByteLength("aé€\u{1F600}"), new TextEncoder().encode("aé€\u{1F600}").length);
});
