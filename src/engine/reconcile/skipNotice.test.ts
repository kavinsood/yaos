import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import { MAX_TEXT_FILE_BYTES } from "./localState";
import { SkipNoticeGate, sizeText, skipNotice, unexpectedSkips, type Skipped } from "./skipNotice";
import { World } from "./testkit/world";

const skip = (path: string, why: Skipped["why"] = "too-large"): Skipped => ({
	path: path as VaultPath, pathKey: path.toLowerCase() as Skipped["pathKey"], why, detail: why === "name" ? "the name is too long" : "larger than the 8 MiB limit",
});
const skipNotices = (w: World): string[] => w.notices.filter((n) => n.code === "scan-skipped").map((n) => `${n.level}:${n.message}`);

test("skipNotice: one file names it and the reason; several give tallies and the first path", () => {
	assert.equal(skipNotice([skip("v.mp4")]), "YAOS is not syncing “v.mp4”: larger than the 8 MiB limit.");
	assert.equal(
		skipNotice([skip("a.png"), skip("b:c.md", "name"), skip("d.png")]),
		"YAOS is not syncing 3 files (2 too large, 1 with an unsupported name); first: “a.png”, larger than the 8 MiB limit.",
	);
	assert.match(skipNotice([skip("x?.md", "name"), skip("y?.md", "name")]), /^YAOS is not syncing 2 files \(2 with an unsupported name\);/);
	assert.equal(sizeText(8 * 1024 * 1024), "8 MiB");
	assert.equal(sizeText(MAX_TEXT_FILE_BYTES), "24 MiB");
	assert.equal(sizeText(1536 * 1024), "1.5 MiB");
	assert.equal(sizeText(300), "300 B");
	assert.equal(sizeText(2048), "2 KiB");
	// Rounded down: the relay's cap, sealed under suite 1 (maxSealedBlobPlaintext(100e6)) and plain.
	assert.equal(sizeText(98_566_143), "93.9 MiB");
	assert.equal(sizeText(100_000_000), "95.3 MiB");
	assert.equal(sizeText(2047), "1 KiB");
});

test("SkipNoticeGate: a path joining the set notifies; unchanged or shrinking sets do not; a returning path does", () => {
	const g = new SkipNoticeGate();
	assert.equal(g.next([]), null);
	assert.notEqual(g.next([skip("a.png")]), null);
	assert.equal(g.next([skip("a.png")]), null, "unchanged");
	assert.match(g.next([skip("a.png"), skip("b.png")]) ?? "", /2 files/, "grew");
	assert.equal(g.next([skip("b.png")]), null, "shrank");
	assert.notEqual(g.next([skip("a.png"), skip("b.png")]), null, "a.png came back");
});

test("unexpectedSkips: too large and non-portable names count; patterns, attachments off, dot segments and synced files do not", async () => {
	const w = new World({ settings: { excludePatterns: ["private/**"], maxAttachmentBytes: 16 } });
	w.vault.userWrite("big.png", new Uint8Array(17));
	w.vault.userWrite("ok.png", new Uint8Array(16));
	w.vault.userWrite("a:b.md", "colon\n");
	w.vault.userWrite("docs/CON.md", "reserved\n");
	w.vault.userWrite("private/huge.png", new Uint8Array(64));
	w.vault.userWrite(".obsidian/app.json", "{}");
	w.vault.userWrite(".trash/old.png", new Uint8Array(64));
	w.vault.userWrite(".github/x?.yml", "hidden and invalid\n");
	w.vault.userWrite("notes/.hidden.md", "hidden\n");
	await w.boot();
	const got = unexpectedSkips(w.r.ctx.local.values(), (p, size) => w.r.ctx.classify(p, size)).map((s) => `${s.path}|${s.why}|${s.detail}`);
	assert.deepEqual(got, [
		"a:b.md|name|the name contains one of \\ * \" < > : | ?",
		"big.png|too-large|larger than the 16 B limit",
		"docs/CON.md|name|the name is reserved on Windows (CON, NUL, COM1, ...)",
	]);
});

test("reconciler: one warn per new skip set at the end of a pass; quiet passes and a pattern-excluded file stay silent", async () => {
	const w = new World({ settings: { excludePatterns: ["private/**"], maxAttachmentBytes: 16 } });
	w.vault.userWrite("ok.md", "ok\n");
	w.vault.userWrite("big.png", new Uint8Array(17));
	await w.boot();
	await w.sync();
	assert.deepEqual(skipNotices(w), ["warn:YAOS is not syncing “big.png”: larger than the 16 B limit."]);
	await w.sync();
	await w.r.pass();
	assert.equal(skipNotices(w).length, 1, "unchanged set: no repeat");
	w.vault.userWrite("private/huge.png", new Uint8Array(64));
	await w.sync();
	assert.equal(skipNotices(w).length, 1, "exclude patterns are deliberate");
	w.vault.userWrite("x|y.md", "pipe\n");
	await w.sync();
	assert.deepEqual(skipNotices(w).slice(1), [
		"warn:YAOS is not syncing 2 files (1 too large, 1 with an unsupported name); first: “big.png”, larger than the 16 B limit.",
	]);
	w.vault.userDelete("x|y.md");
	await w.sync();
	assert.equal(skipNotices(w).length, 2, "a shrinking set is not news");
	assert.ok(w.log.liveByPath("ok.md" as VaultPath), "the rest syncs");
});

test("reconciler: an attachment over the store's advertised cap gets the too-large notice and no upload, whatever the setting", async () => {
	// The setting at its default (1 GiB) never raises the store's cap: classify takes min(setting, store cap).
	const w = new World({ maxBlobBytes: 16, settings: { maxAttachmentBytes: 1024 * 1024 * 1024 } });
	w.vault.userWrite("ok.md", "ok\n");
	w.vault.userWrite("fits.png", new Uint8Array(16));
	w.vault.userWrite("big.png", new Uint8Array(17));
	await w.boot();
	await w.sync();
	assert.deepEqual(skipNotices(w), ["warn:YAOS is not syncing “big.png”: larger than the 16 B limit."]);
	assert.deepEqual(w.blobs?.uploads.map((u) => u.path), ["fits.png"], "the oversize file is never uploaded");
	assert.equal(w.log.liveByPath("big.png" as VaultPath), undefined, "and has no ns entry");
	assert.ok(w.log.liveByPath("fits.png" as VaultPath), "a file at the cap syncs");
	await w.r.pass();
	assert.equal(w.blobs?.uploads.length, 1, "a later pass does not try it either");
});
