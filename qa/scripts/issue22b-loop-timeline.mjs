#!/usr/bin/env node
// Timeline extractor for one pathId from a boot-*.ndjson flight trace.
// Usage: node issue22b-loop-timeline.mjs <ndjson> <pathId>
import fs from "node:fs";

const [, , file, pathId] = process.argv;
if (!file || !pathId) {
	console.error("usage: node issue22b-loop-timeline.mjs <ndjson> <pathId>");
	process.exit(2);
}

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const events = [];
for (const line of lines) {
	let ev;
	try { ev = JSON.parse(line); } catch { continue; }
	if (ev.pathId && ev.pathId !== pathId) continue;
	events.push(ev);
}

events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

const t0 = events[0]?.ts ?? 0;
const fmt = (ts) => `${((ts - t0) / 1000).toFixed(3)}s`;

const cols = [
	"+t",
	"seq",
	"kind",
	"reason",
	"diskLen",
	"crdtLen",
	"edEqDisk",
	"edEqCrdt",
	"action",
	"origin",
	"matches",
	"forceR",
	"diskMod",
	"size",
	"extra",
];

const rows = [];
for (const ev of events) {
	const d = ev.data ?? {};
	const row = {
		"+t": fmt(ev.ts),
		seq: ev.seq ?? "",
		kind: ev.kind ?? "",
		reason: d.reason ?? "",
		diskLen: d.diskLength ?? "",
		crdtLen: d.crdtLength ?? "",
		edEqDisk: d.editorEqualsDisk ?? "",
		edEqCrdt: d.editorEqualsCrdt ?? "",
		action: d.action ?? "",
		origin: d.origin ?? "",
		matches: d.matchesExpected ?? "",
		forceR: d.forceReplaceApplied ?? "",
		diskMod: ev.kind === "disk.modify.observed" ? "yes" : "",
		size: ev.kind === "disk.modify.observed" ? (d.size ?? "") : "",
		extra: "",
	};
	if (ev.kind === "device.witness.diverged") {
		row.extra = `crdt=${(d.crdtHash ?? "").slice(0, 12)} disk=${(d.diskHash ?? "").slice(0, 12)} originClass=${d.originClass ?? ""} fileOpen=${d.fileOpen ?? ""}`;
	}
	if (ev.kind === "editor.repair.applied") {
		row.extra = `leaf=${d.leafId?.slice(0, 8) ?? ""} cm=${d.cmId ?? ""} rapidSwitch=${d.rapidSwitch ?? ""}`;
	}
	if (ev.kind === "recovery.decision") {
		row.extra = `disk=${(d.diskFingerprintPrefix ?? "")} crdt=${(d.crdtFingerprintPrefix ?? "")} rsh=${(d.recoveryStateHash ?? "").slice(0, 12)}`;
	}
	if (ev.kind === "disk.modify.observed") {
		row.extra = `size=${d.size ?? ""}`;
	}
	rows.push(row);
}

const widths = {};
for (const c of cols) widths[c] = c.length;
for (const r of rows) for (const c of cols) {
	const v = String(r[c] ?? "");
	if (v.length > widths[c]) widths[c] = v.length;
}

const pad = (s, w) => String(s).padEnd(w);
console.log(cols.map((c) => pad(c, widths[c])).join("  "));
console.log(cols.map((c) => "-".repeat(widths[c])).join("  "));
for (const r of rows) {
	console.log(cols.map((c) => pad(r[c] ?? "", widths[c])).join("  "));
}

console.log(`\nTotal events for pathId ${pathId}: ${events.length}`);
