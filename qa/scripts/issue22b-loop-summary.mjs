#!/usr/bin/env node
// Summary timeline focused on the loop-relevant events for one pathId.
// Filters out server.receipt.candidate_captured noise.
import fs from "node:fs";

const [, , file, pathId] = process.argv;
if (!file || !pathId) {
	console.error("usage: node issue22b-loop-summary.mjs <ndjson> <pathId>");
	process.exit(2);
}

const KEEP = new Set([
	"qa.trace.started",
	"provider.connected",
	"provider.sync.complete",
	"reconcile.start",
	"reconcile.complete",
	"reconcile.file.decision",
	"recovery.decision",
	"recovery.apply.start",
	"recovery.apply.done",
	"recovery.skipped",
	"recovery.quarantined",
	"recovery.loop.detected",
	"editor.repair.applied",
	"editor.heal.applied",
	"editor.bind",
	"device.witness.diverged",
	"disk.modify.observed",
	"disk.create.observed",
	"disk.write.ok",
	"disk.write.failed",
	"crdt.file.created",
	"delete.remote.observed",
]);

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const events = [];
for (const line of lines) {
	let ev;
	try { ev = JSON.parse(line); } catch { continue; }
	if (ev.pathId && ev.pathId !== pathId) continue;
	if (!KEEP.has(ev.kind)) continue;
	events.push(ev);
}

events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

const t0 = events[0]?.ts ?? 0;
const fmt = (ts) => `${((ts - t0) / 1000).toFixed(3)}s`;

const fields = (ev) => {
	const d = ev.data ?? {};
	const parts = [];
	if (d.reason) parts.push(`reason=${d.reason}`);
	if (d.diskLength !== undefined) parts.push(`diskLen=${d.diskLength}`);
	if (d.crdtLength !== undefined) parts.push(`crdtLen=${d.crdtLength}`);
	if (d.editorEqualsDisk !== undefined) parts.push(`edEqDisk=${d.editorEqualsDisk}`);
	if (d.editorEqualsCrdt !== undefined) parts.push(`edEqCrdt=${d.editorEqualsCrdt}`);
	if (d.action) parts.push(`action=${d.action}`);
	if (d.origin) parts.push(`origin=${d.origin}`);
	if (d.matchesExpected !== undefined) parts.push(`matches=${d.matchesExpected}`);
	if (d.forceReplaceApplied !== undefined) parts.push(`forceR=${d.forceReplaceApplied}`);
	if (d.size !== undefined) parts.push(`size=${d.size}`);
	if (d.crdtHash) parts.push(`crdtH=${(d.crdtHash || "").slice(0, 14)}`);
	if (d.diskHash) parts.push(`diskH=${(d.diskHash || "").slice(0, 14)}`);
	if (d.originClass) parts.push(`originClass=${d.originClass}`);
	if (d.fileOpen !== undefined) parts.push(`fileOpen=${d.fileOpen}`);
	if (d.diskFingerprintPrefix) parts.push(`disk=${d.diskFingerprintPrefix}`);
	if (d.crdtFingerprintPrefix) parts.push(`crdt=${d.crdtFingerprintPrefix}`);
	if (d.recoveryStateHash) parts.push(`rsh=${(d.recoveryStateHash || "").slice(0, 14)}`);
	if (d.lockRemainingMs !== undefined) parts.push(`lock=${d.lockRemainingMs}ms`);
	if (d.idleMs !== undefined) parts.push(`idle=${d.idleMs}ms`);
	return parts.join(" ");
};

let prevDiskSize = null;
let prevCrdtLen = null;
for (const ev of events) {
	const seq = String(ev.seq ?? "").padStart(3);
	const t = fmt(ev.ts).padStart(10);
	const k = (ev.kind ?? "").padEnd(28);
	let extra = fields(ev);

	// Annotate deltas
	if (ev.kind === "disk.modify.observed") {
		const size = ev.data?.size ?? 0;
		if (prevDiskSize !== null) extra += `   Δdisk=+${size - prevDiskSize}`;
		prevDiskSize = size;
	}
	if (ev.kind === "recovery.decision") {
		const crdt = ev.data?.crdtLength ?? 0;
		if (prevCrdtLen !== null) extra += `   ΔcrdtBetweenCycles=+${crdt - prevCrdtLen}`;
		prevCrdtLen = crdt;
	}

	console.log(`${t}  seq=${seq}  ${k} ${extra}`);
}
console.log(`\nTotal filtered events: ${events.length}`);
