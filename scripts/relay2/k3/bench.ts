// K3 (relay v2 spike, D4): byte-level update ops — CPU and memory for
//   (b) JS yjs byte API, (a) transient ywasm doc, (c) stateless ywasm (patch 0003).
//
// Usage (repo root; --expose-gc so JS-heap numbers are meaningful):
//   node --expose-gc tests/run-typescript.mjs --test-aliases scripts/relay2/k3/bench.ts prepare
//   node --expose-gc tests/run-typescript.mjs --test-aliases scripts/relay2/k3/bench.ts run [--only <input>]
// `run` spawns one child process per (input, backend) so every ywasm linear-memory
// reading starts from a fresh Wasm instance (Wasm memory never shrinks).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import {
	type ByteOps,
	stateVectorsEqual,
	ywasmLinearMemoryBytes,
	ywasmStatelessByteOps,
	ywasmTransientDocByteOps,
} from "../../../server/src/crdt/ywasmByteOps";
import { PATHOLOGY_PROFILES, generateFrozenTrace, readFrozenFrames, readTraceManifest } from "../../pathology-lab/trace";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const WORK = process.env.K3_WORK ?? "/tmp/k3ywasm/inputs";
const RESULTS = process.env.K3_RESULTS ?? "/Users/kavin/personal/obsidiansync/experiments/results/relay2";
const FROZEN_QUICK = "/Users/kavin/personal/obsidiansync/experiments/logs/A5-trace-quick";
const SEED = 0xa5;

const jsYjsByteOps: ByteOps = {
	name: "js-yjs",
	mergeUpdates: (updates) => Y.mergeUpdates([...updates]),
	stateVectorFromUpdate: (update) => Y.encodeStateVectorFromUpdate(update),
	diffUpdate: (update, sv) => Y.diffUpdate(update, sv),
};
const BACKENDS: Record<string, ByteOps> = {
	b: jsYjsByteOps,
	a: ywasmTransientDocByteOps,
	c: ywasmStatelessByteOps,
};

// ---------- input files: checkpoint.bin, tail.bin (u32le-length frames), meta.json ----------

function writeFrames(path: string, frames: readonly Uint8Array[]): void {
	const total = frames.reduce((sum, frame) => sum + 4 + frame.byteLength, 0);
	const out = Buffer.allocUnsafe(total);
	let offset = 0;
	for (const frame of frames) {
		out.writeUInt32LE(frame.byteLength, offset);
		out.set(frame, offset + 4);
		offset += 4 + frame.byteLength;
	}
	writeFileSync(path, out);
}

function readFrames(path: string): Uint8Array[] {
	const bytes = readFileSync(path);
	const frames: Uint8Array[] = [];
	for (let offset = 0; offset < bytes.byteLength;) {
		const length = bytes.readUInt32LE(offset);
		frames.push(new Uint8Array(bytes.buffer, bytes.byteOffset + offset + 4, length).slice());
		offset += 4 + length;
	}
	return frames;
}

function sha(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

interface InputMeta {
	name: string;
	kind: "trace" | "synthetic";
	description: string;
	checkpointBytes: number;
	tailFrames: number;
	tailBytes: number;
	mergedBytes: number;
	finalTextUtf8Bytes: number;
	checkpointSha: string;
}

function saveInput(name: string, kind: InputMeta["kind"], description: string, checkpoint: Uint8Array, tail: Uint8Array[]): void {
	const dir = join(WORK, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "checkpoint.bin"), checkpoint);
	writeFrames(join(dir, "tail.bin"), tail);
	const merged = Y.mergeUpdates([checkpoint, ...tail]);
	const doc = new Y.Doc();
	Y.applyUpdate(doc, merged);
	const meta: InputMeta = {
		name, kind, description,
		checkpointBytes: checkpoint.byteLength,
		tailFrames: tail.length,
		tailBytes: tail.reduce((sum, frame) => sum + frame.byteLength, 0),
		mergedBytes: merged.byteLength,
		finalTextUtf8Bytes: Buffer.byteLength(doc.getText("body").toString()),
		checkpointSha: sha(checkpoint),
	};
	doc.destroy();
	writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
	console.log(`[k3:prepare] ${name}: checkpoint ${meta.checkpointBytes} B, tail ${meta.tailFrames} frames / ${meta.tailBytes} B, merged ${meta.mergedBytes} B, text ${meta.finalTextUtf8Bytes} B`);
}

function traceInputs(label: string, directory: string): void {
	const manifest = readTraceManifest(directory);
	const base = new Uint8Array(readFileSync(join(directory, "base.update")));
	const frames = [...readFrozenFrames(join(directory, "updates.bin"))];
	// (1) full history: base snapshot + every per-edit frame (checkpoint writer worst case)
	saveInput(`${label}-full`, "trace",
		`${label} trace seed=0x${manifest.seed.toString(16)} (${manifest.profile.baseChars} chars, ${manifest.profile.edits} edits, ${manifest.profile.clients} clients): checkpoint = base update, tail = all ${frames.length} edit frames`,
		base, frames);
	// (2) steady state: checkpoint = merge(base + all but the last 50), tail = last 50 frames
	const cut = frames.length - 50;
	saveInput(`${label}-tail50`, "trace",
		`${label} trace: checkpoint = yjs merge(base + first ${cut} frames), tail = last 50 frames`,
		Y.mergeUpdates([base, ...frames.slice(0, cut)]), frames.slice(cut));
}

class Rng {
	constructor(private state: number) {}
	next(): number {
		let value = this.state;
		value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
		this.state = value >>> 0;
		return this.state / 0x1_0000_0000;
	}
	int(max: number): number { return Math.floor(this.next() * max); }
}

const WORDS = ["the", "note", "sync", "relay", "vault", "é", "中文", "item", "- [ ]", "**bold**", "[[link]]", "`code`", "#tag", "\n"];

function paragraph(rng: Rng, bytes: number): string {
	let out = "";
	while (Buffer.byteLength(out) < bytes) out += `${WORDS[rng.int(WORDS.length)]} `;
	return `${out}\n`;
}

/**
 * Synthetic note of ~`size` UTF-8 bytes whose history is ~1 KB paragraphs inserted at
 * random positions (so structs ≈ size/1KB, not one squashed run) with ~5% deleted,
 * then `tails` separate small edits from 3 clients.
 */
function syntheticInputs(label: string, size: number, tails: readonly number[]): void {
	const rng = new Rng(SEED ^ size);
	const author = new Y.Doc();
	author.clientID = 0x5e_0001;
	const text = author.getText("body");
	let written = 0;
	while (written < size) {
		const chunk = paragraph(rng, 1024);
		author.transact(() => text.insert(rng.int(text.length + 1), chunk));
		written += Buffer.byteLength(chunk);
		if (rng.next() < 0.05 && text.length > 200) {
			const at = rng.int(text.length - 100);
			author.transact(() => text.delete(at, 1 + rng.int(60)));
		}
	}
	const checkpoint = Y.encodeStateAsUpdate(author);
	const maxTail = Math.max(...tails);
	const clients = [0, 1, 2].map((index) => {
		const doc = new Y.Doc();
		doc.clientID = 0x5e_1000 + index;
		Y.applyUpdate(doc, checkpoint);
		return doc;
	});
	const tail: Uint8Array[] = [];
	for (let step = 0; step < maxTail; step++) {
		const index = Math.floor(step / 17) % clients.length;
		const doc = clients[index]!;
		const body = doc.getText("body");
		let update: Uint8Array | null = null;
		const capture = (u: Uint8Array) => { update = u; };
		doc.on("update", capture);
		if (rng.next() < 0.75 || body.length < 100) body.insert(rng.int(body.length + 1), WORDS[rng.int(WORDS.length)]!);
		else {
			const at = rng.int(body.length - 20);
			body.delete(at, 1 + rng.int(12));
		}
		doc.off("update", capture);
		tail.push(update!);
		for (let peer = 0; peer < clients.length; peer++) if (peer !== index) Y.applyUpdate(clients[peer]!, update!);
	}
	for (const count of tails) {
		saveInput(`${label}-tail${count}`, "synthetic",
			`synthetic ${label} note (1 KB paragraphs at random positions, ~5% deleted) + ${count} small edits from 3 clients`,
			checkpoint, tail.slice(0, count));
	}
	author.destroy();
	for (const doc of clients) doc.destroy();
}

function prepare(): void {
	mkdirSync(WORK, { recursive: true });
	// quick: frozen A5 frames (seed 0xa5), and verify the generator still reproduces them
	const regenerated = join(WORK, "trace-quick");
	if (!existsSync(join(regenerated, "manifest.json"))) {
		generateFrozenTrace({ outputDirectory: regenerated, profile: PATHOLOGY_PROFILES.quick!, seed: SEED });
	}
	const frozenSha = readTraceManifest(FROZEN_QUICK).updates.sha256;
	const regenSha = readTraceManifest(regenerated).updates.sha256;
	console.log(`[k3:prepare] quick trace frames sha frozen=${frozenSha.slice(0, 12)} regenerated=${regenSha.slice(0, 12)} ${frozenSha === regenSha ? "MATCH" : "DIFFER"}`);
	traceInputs("quick", FROZEN_QUICK);
	const stressDir = join(WORK, "trace-stress");
	if (!existsSync(join(stressDir, "manifest.json"))) {
		const started = performance.now();
		generateFrozenTrace({ outputDirectory: stressDir, profile: PATHOLOGY_PROFILES.stress!, seed: SEED });
		console.log(`[k3:prepare] generated stress trace in ${Math.round(performance.now() - started)} ms`);
	}
	traceInputs("stress", stressDir);
	for (const [label, size] of [["100KB", 100_000], ["1MB", 1_000_000], ["5MB", 5_000_000], ["10MB", 10_000_000]] as const) {
		syntheticInputs(label, size, [50, 500, 5_000]);
	}
}

// ---------- child: one input × one backend ----------

interface OpStats { runs: number; p50: number; mean: number; min: number; max: number; outputBytes: number }

function stats(samples: number[], outputBytes: number): OpStats {
	const sorted = [...samples].sort((x, y) => x - y);
	const round = (value: number) => Math.round(value * 1000) / 1000;
	return {
		runs: samples.length,
		p50: round(sorted[Math.floor(sorted.length / 2)]!),
		mean: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
		min: round(sorted[0]!),
		max: round(sorted[sorted.length - 1]!),
		outputBytes,
	};
}

const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const heap = () => process.memoryUsage();

function child(inputName: string, backendKey: string): void {
	const ops = BACKENDS[backendKey];
	if (!ops) throw new Error(`unknown backend ${backendKey}`);
	const dir = join(WORK, inputName);
	const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as InputMeta;
	const checkpoint = new Uint8Array(readFileSync(join(dir, "checkpoint.bin")));
	const tail = readFrames(join(dir, "tail.bin"));
	const updates = [checkpoint, ...tail];
	// Peer SV for the diff: a device holding exactly the checkpoint (catch-up case).
	const peerSv = Y.encodeStateVectorFromUpdate(checkpoint);
	// Reference SV computed once with JS yjs and cached (yjs merge of 50k frames takes ~11 s).
	const referencePath = join(dir, "reference-sv.bin");
	if (!existsSync(referencePath)) writeFileSync(referencePath, Y.encodeStateVectorFromUpdate(Y.mergeUpdates(updates)));
	const referenceSv = new Uint8Array(readFileSync(referencePath));

	// K3_MODE=svdiff: isolate SV/diff memory — merged state is the cached JS-yjs merge
	// read from disk, so the Wasm high-water reflects only SV-from-update + diff.
	const svdiffOnly = process.env.K3_MODE === "svdiff";
	let premerged: Uint8Array | null = null;
	if (svdiffOnly) {
		const mergedPath = join(dir, "merged-yjs.bin");
		if (!existsSync(mergedPath)) writeFileSync(mergedPath, Y.mergeUpdates(updates));
		premerged = new Uint8Array(readFileSync(mergedPath));
	}
	gc();
	const wasm0 = ywasmLinearMemoryBytes();
	const heap0 = heap();
	const cold: Record<string, { ms: number; wasmAfter: number; heapUsedAfter: number; externalAfter: number }> = {};
	let peakHeapUsed = heap0.heapUsed;
	let peakExternal = heap0.external + heap0.arrayBuffers;
	const sample = () => {
		const now = heap();
		peakHeapUsed = Math.max(peakHeapUsed, now.heapUsed);
		peakExternal = Math.max(peakExternal, now.external + now.arrayBuffers);
		return now;
	};
	const coldOp = <T extends Uint8Array>(name: string, body: () => T): T => {
		const started = performance.now();
		const result = body();
		const ms = performance.now() - started;
		const now = sample();
		cold[name] = { ms: Math.round(ms * 1000) / 1000, wasmAfter: ywasmLinearMemoryBytes(), heapUsedAfter: now.heapUsed, externalAfter: now.external + now.arrayBuffers };
		return result;
	};
	let merged: Uint8Array;
	try {
		merged = premerged ?? coldOp("merge", () => ops.mergeUpdates(updates));
		if (premerged) cold.merge = { ms: 0, wasmAfter: wasm0, heapUsedAfter: heap0.heapUsed, externalAfter: 0 };
	} catch (error) {
		console.log(JSON.stringify({ input: inputName, backend: backendKey, name: ops.name, error: String(error), wasmAfter: ywasmLinearMemoryBytes() }));
		return;
	}
	const sv = coldOp("stateVectorFromUpdate", () => ops.stateVectorFromUpdate(merged));
	const diff = coldOp("diffUpdate", () => ops.diffUpdate(merged, peerSv));
	const svOk = stateVectorsEqual(sv, referenceSv);
	const check = new Y.Doc();
	Y.applyUpdate(check, checkpoint);
	Y.applyUpdate(check, diff);
	const diffOk = stateVectorsEqual(Y.encodeStateVector(check), referenceSv);
	check.destroy();

	// Timed repetitions: at least 5 (3 when one cold call > 1 s, then the cold call is the
	// warm-up), at most 40, stop after ~3 s per op.
	const timed = (body: () => Uint8Array, coldMs: number): OpStats => {
		const slow = coldMs > 1_000;
		if (!slow) body(); // warm-up
		const samples: number[] = [];
		let bytes = 0;
		const minimumRuns = slow ? 3 : 5;
		const budgetStart = performance.now();
		while (samples.length < 40 && (samples.length < minimumRuns || performance.now() - budgetStart < 3_000)) {
			const started = performance.now();
			const out = body();
			samples.push(performance.now() - started);
			bytes = out.byteLength;
			sample();
		}
		return stats(samples, bytes);
	};
	const wasmBeforeReps = ywasmLinearMemoryBytes();
	const timing = {
		merge: svdiffOnly ? stats([0], merged.byteLength) : timed(() => ops.mergeUpdates(updates), cold.merge!.ms),
		stateVectorFromUpdate: timed(() => ops.stateVectorFromUpdate(merged), cold.stateVectorFromUpdate!.ms),
		diffUpdate: timed(() => ops.diffUpdate(merged, peerSv), cold.diffUpdate!.ms),
	};
	const wasmAfterReps = ywasmLinearMemoryBytes();
	// Soak: up to 20 more full cycles (bounded to ~10 s); wasm high-water must not keep
	// rising if frees are complete.
	const cycleMs = timing.merge.p50 + timing.stateVectorFromUpdate.p50 + timing.diffUpdate.p50;
	const soakCycles = Math.max(3, Math.min(20, Math.floor(10_000 / Math.max(cycleMs, 1))));
	for (let index = 0; index < soakCycles; index++) {
		const m = premerged ?? ops.mergeUpdates(updates);
		ops.stateVectorFromUpdate(m);
		ops.diffUpdate(m, peerSv);
	}
	const wasmAfterSoak = ywasmLinearMemoryBytes();
	gc();
	const heapEnd = heap();
	console.log(JSON.stringify({
		input: inputName, backend: backendKey, name: ops.name, mode: svdiffOnly ? "svdiff-only (merge skipped; merged = cached JS yjs merge)" : "full", meta,
		correctness: { svMatchesYjs: svOk, diffConverges: diffOk, mergedBytes: merged.byteLength, diffBytes: diff.byteLength },
		cold,
		timingMs: timing,
		wasmLinearMemory: {
			baselineAfterLoad: wasm0,
			afterColdMerge: cold.merge!.wasmAfter,
			afterColdSv: cold.stateVectorFromUpdate!.wasmAfter,
			afterColdDiff: cold.diffUpdate!.wasmAfter,
			beforeReps: wasmBeforeReps,
			afterReps: wasmAfterReps,
			soakCycles,
			afterSoak: wasmAfterSoak,
			highWaterGrowth: wasmAfterSoak - wasm0,
			grewDuringRepsOrSoak: wasmAfterSoak > wasmBeforeReps,
		},
		jsHeap: {
			heapUsedBaseline: heap0.heapUsed,
			heapUsedPeakSampled: peakHeapUsed,
			heapUsedAfterGc: heapEnd.heapUsed,
			externalPlusArrayBuffersBaseline: heap0.external + heap0.arrayBuffers,
			externalPlusArrayBuffersPeakSampled: peakExternal,
			rssEnd: heapEnd.rss,
		},
	}));
}

// ---------- parent ----------

function run(only: string[]): void {
	const inputs = ["quick-full", "quick-tail50", "stress-full", "stress-tail50",
		...["100KB", "1MB", "5MB", "10MB"].flatMap((size) => [50, 500, 5_000].map((tail) => `${size}-tail${tail}`))]
		.filter((name) => only.length === 0 || only.some((filter) => name.includes(filter)));
	const results: unknown[] = [];
	for (const input of inputs) {
		for (const backend of process.env.K3_MODE === "svdiff" ? ["a", "c"] : ["b", "a", "c"]) {
			const outcome = spawnSync(process.execPath, ["--expose-gc", join(REPO, "tests/run-typescript.mjs"), "--test-aliases",
				fileURLToPath(import.meta.url), "child", input, backend], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
			const line = outcome.stdout.split("\n").find((entry) => entry.startsWith("{"));
			if (!line) {
				console.error(`[k3] ${input}/${backend} failed (exit ${outcome.status}):\n${outcome.stderr.slice(-2000)}`);
				results.push({ input, backend, error: `exit ${outcome.status}`, stderr: outcome.stderr.slice(-2000) });
				continue;
			}
			const parsed = JSON.parse(line) as { timingMs?: Record<string, OpStats>; wasmLinearMemory?: Record<string, number>; error?: string };
			results.push(parsed);
			const t = parsed.timingMs;
			console.log(`[k3] ${input.padEnd(16)} ${backend} ${parsed.error ? `ERROR ${parsed.error}` : `merge p50 ${t!.merge!.p50} ms, sv p50 ${t!.stateVectorFromUpdate!.p50} ms, diff p50 ${t!.diffUpdate!.p50} ms, wasm ${parsed.wasmLinearMemory!.baselineAfterLoad}→${parsed.wasmLinearMemory!.afterSoak}`}`);
		}
	}
	const suffix = `${process.env.K3_MODE === "svdiff" ? "svdiff-" : ""}${only.length === 0 ? "all" : only.join("_")}`;
	const out = resolve(RESULTS, `K3-byteops-${suffix}.json`);
	writeFileSync(out, `${JSON.stringify({
		measuredAt: new Date().toISOString(),
		host: { node: process.version, platform: process.platform, arch: process.arch },
		note: "Node.js V8 on macOS dev machine, same patched ywasm bytes as the Worker; workerd not measured here.",
		results,
	}, null, 2)}\n`);
	console.log(`[k3] wrote ${out}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "prepare") prepare();
else if (mode === "child") child(rest[0]!, rest[1]!);
else if (mode === "run") {
	const only: string[] = [];
	for (let index = 0; index < rest.length; index++) if (rest[index] === "--only") only.push(rest[++index]!);
	run(only);
} else {
	console.error("usage: bench.ts prepare | run [--only <input>] | child <input> <a|b|c>");
	process.exit(2);
}
