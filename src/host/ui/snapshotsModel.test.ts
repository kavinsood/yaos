import { test } from "node:test";
import assert from "node:assert/strict";
import type { VaultPath } from "../../core/types";
import type { SnapshotFileEntry, SnapshotReason, SnapshotSummary } from "../../protocol/messages";
import {
	deleteCopy, fileView, filterFiles, formatSnapshotTime, loadingText, MAX_FILE_ROWS, MAX_LISTED_PATHS, restoreAllCopy, restoreSelectedCopy,
	restoreSummary, selectedPaths, selectionText, skippedText, snapshotReasonLabel, snapshotRow, snapshotRows, withAll, withPath,
} from "./snapshotsModel";

const REASONS: SnapshotReason[] = ["daily", "brake", "epoch", "idb", "restore", "manual"];
const at = (y: number, mo: number, d: number, h: number, mi: number): number => new Date(y, mo - 1, d, h, mi).getTime();
const p = (s: string): VaultPath => s as VaultPath;
const file = (path: string, size = 10): SnapshotFileEntry => ({ path: p(path), kind: "markdown", size });

function summary(over: Partial<SnapshotSummary> = {}): SnapshotSummary {
	return { id: "000000001-daily", createdAtMs: at(2026, 10, 5, 14, 3), reason: "daily", files: 12, bytes: 3.4 * 1024 * 1024, ...over };
}

test("every snapshot reason has its own label", () => {
	assert.equal(new Set(REASONS.map(snapshotReasonLabel)).size, REASONS.length);
});

test("snapshot rows: local time, reason, file count and size; newest first", () => {
	assert.equal(formatSnapshotTime(at(2026, 1, 2, 3, 4)), "2026-01-02 03:04");
	assert.deepEqual(snapshotRow(summary()), { id: "000000001-daily", title: "2026-10-05 14:03 · Daily", detail: "12 files, 3.4 MiB", where: "local" });
	assert.equal(snapshotRow(summary({ files: 1, bytes: 900 })).detail, "1 file, 900 B");
	assert.equal(snapshotRow(summary({ where: "both" })).detail, "12 files, 3.4 MiB · uploaded");
	assert.equal(snapshotRow(summary({ where: "remote", device: "phone" })).detail, "12 files, 3.4 MiB · from phone");
	assert.equal(loadingText(snapshotRow(summary({ where: "remote", device: "phone" }))), "Downloading and checking the snapshot…");
	const rows = snapshotRows([
		summary({ id: "a-daily", createdAtMs: at(2026, 10, 1, 9, 0) }),
		summary({ id: "c-manual", createdAtMs: at(2026, 10, 3, 9, 0), reason: "manual" }),
		summary({ id: "b-restore", createdAtMs: at(2026, 10, 2, 9, 0), reason: "restore" }),
	]);
	assert.deepEqual(rows.map((r) => r.id), ["c-manual", "b-restore", "a-daily"]);
	assert.match(rows[0]!.title, /Created by you$/);
	assert.deepEqual(snapshotRows([]), []);
});

test("filter: every term must appear in the path, case-insensitive; results sorted by path", () => {
	const files = [file("Daily/2026-10-05.md"), file("b.md"), file("Projects/Plan.md"), file("daily/old.md")];
	assert.deepEqual(filterFiles(files, "").map((f) => f.path), ["Daily/2026-10-05.md", "Projects/Plan.md", "b.md", "daily/old.md"]);
	assert.deepEqual(filterFiles(files, "  DAILY ").map((f) => f.path), ["Daily/2026-10-05.md", "daily/old.md"]);
	assert.deepEqual(filterFiles(files, "daily 2026").map((f) => f.path), ["Daily/2026-10-05.md"]);
	assert.deepEqual(filterFiles(files, "nope"), []);
});

test("file view caps rendered rows and says how many are hidden; select all covers hidden matches", () => {
	const many = Array.from({ length: MAX_FILE_ROWS + 7 }, (_, i) => file(`n/${String(i).padStart(4, "0")}.md`));
	const view = fileView(many, "n/");
	assert.equal(view.matching.length, MAX_FILE_ROWS + 7);
	assert.equal(view.shown.length, MAX_FILE_ROWS);
	assert.match(view.moreText ?? "", new RegExp(`first ${MAX_FILE_ROWS} of ${MAX_FILE_ROWS + 7} matching files`));
	assert.equal(fileView(many.slice(0, 3), "").moreText, null);
	assert.equal(withAll(new Set(), view.matching).size, MAX_FILE_ROWS + 7);
});

test("selection helpers", () => {
	const files = [file("a.md"), file("b.md"), file("c.md")];
	const s0 = new Set<VaultPath>();
	const s1 = withPath(s0, p("c.md"), true);
	assert.equal(s0.size, 0, "inputs are not mutated");
	const s2 = withPath(withPath(s1, p("a.md"), true), p("c.md"), false);
	assert.deepEqual([...s2], ["a.md"]);
	const all = withAll(s2, files.slice(1));
	assert.deepEqual(selectedPaths(files, new Set([...all, p("gone.md")])), ["a.md", "b.md", "c.md"], "snapshot order; unknown paths dropped");
	assert.equal(selectionText(0, 3), "No files selected (3 files in this snapshot).");
	assert.equal(selectionText(2, 3), "2 of 3 files selected.");
});

test("confirm copy explains conflict copies and the safety snapshot", () => {
	const row = snapshotRow(summary());
	for (const c of [restoreAllCopy(row), restoreSelectedCopy(row, 2)]) {
		assert.match(c.message, /conflict copies/);
		assert.match(c.message, /safety snapshot/);
		assert.match(c.message, /2026-10-05 14:03/);
	}
	assert.equal(restoreSelectedCopy(row, 1).title, "Restore 1 file?");
	assert.equal(restoreAllCopy(row).confirmText, "Restore all");
	assert.match(deleteCopy(row).message, /removed from this device\. Your notes are not changed/);
	assert.match(deleteCopy(snapshotRow(summary({ where: "both" }))).message, /this device and from the list on all your devices/);
	assert.match(deleteCopy(snapshotRow(summary({ where: "remote", device: "phone" }))).message, /^Snapshot: .*\n\nThe snapshot is removed from the list on all your devices\./);
});

test("skipped warning lists entries with a readable reason and caps the list", () => {
	assert.equal(skippedText([]), null);
	const one = skippedText([{ path: p("big.png"), reason: "too-large" }, { path: p("x.md"), reason: "unreadable" }, { path: p("b.canvas"), reason: "invalid" }]);
	assert.equal(one?.heading, "3 files were not saved in this snapshot and cannot be restored from it:");
	assert.deepEqual(one?.lines, ["big.png (attachment over 1 MiB)", "x.md (could not be read)", "b.canvas (invalid name or content)"]);
	assert.equal(one?.moreText, null);
	const many = skippedText(Array.from({ length: MAX_LISTED_PATHS + 4 }, (_, i) => ({ path: p(`f${i}.png`), reason: "too-large" as const })));
	assert.equal(many?.lines.length, MAX_LISTED_PATHS);
	assert.equal(many?.moreText, "…and 4 more.");
	assert.match(skippedText([{ path: p("a"), reason: "too-large" }])?.heading ?? "", /^1 file was /);
});

test("restore summary", () => {
	assert.equal(restoreSummary({ t: "restored", restored: 1, unchanged: 0, copies: [], failed: [] }), "restored 1 file.");
	assert.equal(
		restoreSummary({ t: "restored", restored: 2, unchanged: 3, copies: [p("a (conflict).md")], failed: [p("x.md")] }),
		"restored 2 files; 3 files already matched. Your differing versions were kept as 1 conflict copy. 1 file could not be restored: x.md.",
	);
	const failed = Array.from({ length: MAX_LISTED_PATHS + 2 }, (_, i) => p(`f${i}.md`));
	assert.match(restoreSummary({ t: "restored", restored: 0, unchanged: 0, copies: [p("a"), p("b")], failed }), /2 conflict copies\. 12 files could not be restored: f0\.md, .* and 2 more\.$/);
});
