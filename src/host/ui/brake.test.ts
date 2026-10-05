import { test } from "node:test";
import assert from "node:assert/strict";
import { brakeCopy, brakeHeadline, brakeReasonShort, brakeReasonText, BrakeTracker, MAX_SAMPLE_PATHS_SHOWN } from "./brake";
import type { BrakeReport } from "../../core/types";

const REASONS: BrakeReport["reason"][] = ["mass-delete-local", "mass-delete-remote", "mass-overwrite", "listing-shrank", "conflict-flood", "ns-divergence"];

function report(over: Partial<BrakeReport> = {}): BrakeReport {
	return { id: "b1", reason: "mass-delete-local", heldCount: 3, syncedCount: 10, samplePaths: ["a.md", "b.md", "c.md"], ...over };
}

test("every brake reason has distinct short and long copy", () => {
	const shorts = new Set(REASONS.map(brakeReasonShort));
	const longs = new Set(REASONS.map(brakeReasonText));
	assert.equal(shorts.size, REASONS.length);
	assert.equal(longs.size, REASONS.length);
	for (const r of REASONS) assert.ok(brakeReasonText(r).length > 20, r);
});

test("brakeHeadline and brakeCopy", () => {
	assert.equal(brakeHeadline(report({ heldCount: 1 })), "YAOS is holding 1 change for your approval (many files deleted on this device).");
	const many = Array.from({ length: 25 }, (_, i) => `n${i}.md`);
	const copy = brakeCopy(report({ heldCount: 40, syncedCount: 1, samplePaths: many }));
	assert.equal(copy.samplePaths.length, MAX_SAMPLE_PATHS_SHOWN);
	assert.equal(copy.moreCount, 30);
	assert.equal(copy.counts, "40 changes held; 1 file currently in sync.");
	assert.match(copy.approveHint, /recovery snapshot/);
	assert.match(copy.rejectHint, /restored/);
	assert.equal(brakeCopy(report()).moreCount, 0);
});

test("BrakeTracker opens each id once", () => {
	const t = new BrakeTracker();
	assert.equal(t.shouldOpen(null), false);
	assert.equal(t.shouldOpen(report({ id: "x" })), true);
	assert.equal(t.shouldOpen(report({ id: "x", heldCount: 99 })), false);
	assert.equal(t.shouldOpen(report({ id: "y" })), true);
	assert.equal(t.shouldOpen(report({ id: "x" })), false);
	for (let i = 0; i < 100; i++) t.shouldOpen(report({ id: `z${i}` }));
	assert.equal(t.shouldOpen(report({ id: "z99" })), false);
});
