#!/usr/bin/env node

import assert from "node:assert/strict";
import * as Y from "yjs";
import { destroyWasm, loadYwasm, parsePositiveInteger } from "./raw-engine.mjs";

const engineName = process.argv[2];
if (engineName !== "yjs" && engineName !== "ywasm") {
	throw new Error("usage: memory-soak.mjs <yjs|ywasm> [cycles] [resident-shards] [fixture-kib]");
}
const cycles = parsePositiveInteger(process.argv[3], "cycles", 10_000);
const residentShards = parsePositiveInteger(process.argv[4], "resident-shards", 8);
const fixtureKib = parsePositiveInteger(process.argv[5], "fixture-kib", 256);
const W = engineName === "ywasm" ? await loadYwasm() : null;
const wasm = engineName === "ywasm";

const source = new Y.Doc({ guid: "memory-fixture" });
const paragraph = "Memory fixture 中文 👩🏾‍💻 with enough entropy 0123456789 abcdefghijklmnopqrstuvwxyz.\n";
source.getText("body").insert(0, paragraph.repeat(Math.ceil((fixtureKib * 1_024) / paragraph.length)));
const state = Y.encodeStateAsUpdate(source);
const expected = source.getText("body").toString();
source.destroy();

function makeDoc(index) {
	return wasm ? new W.YDoc({ guid: `memory-${index}` }) : new Y.Doc({ guid: `memory-${index}` });
}
function apply(doc) {
	if (wasm) W.applyUpdate(doc, state, "memory-soak");
	else Y.applyUpdate(doc, state, "memory-soak");
}
function encode(doc) {
	return wasm ? W.encodeStateAsUpdate(doc) : Y.encodeStateAsUpdate(doc);
}
function read(doc) {
	const text = doc.getText("body");
	try { return wasm ? text.toString(undefined) : text.toString(); }
	finally { if (wasm) text.free(); }
}
function destroy(doc) {
	if (wasm) destroyWasm(doc);
	else doc.destroy();
}
function memory() {
	const usage = process.memoryUsage();
	return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers };
}
function delta(after, before) {
	return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
}

global.gc?.();
const baseline = memory();
const checkpoints = [];
const interval = Math.max(1, Math.floor(cycles / 20));
for (let index = 0; index < cycles; index++) {
	const doc = makeDoc(index);
	try {
		apply(doc);
		if (index === 0) assert.equal(read(doc), expected);
		assert.ok(encode(doc).byteLength > 0);
	} finally {
		destroy(doc);
	}
	if ((index + 1) % interval === 0 || index + 1 === cycles) {
		global.gc?.();
		checkpoints.push({ cycle: index + 1, ...memory() });
	}
}
global.gc?.();
const afterChurn = memory();

const resident = [];
for (let index = 0; index < residentShards; index++) {
	const authoritative = makeDoc(`resident-${index}-authoritative`);
	const validation = makeDoc(`resident-${index}-validation`);
	apply(authoritative);
	apply(validation);
	resident.push(authoritative, validation);
}
const residentLoaded = memory();
for (const doc of resident) destroy(doc);
global.gc?.();
const afterResidentDestroy = memory();

// Ignore allocator warm-up by comparing the last quarter with the preceding
// quarter. This RSS assertion complements (but cannot replace) the adapter's
// exact WebAssembly.Memory page assertion.
const midpoint = Math.max(1, Math.floor(checkpoints.length * 0.5));
const warmRss = Math.min(...checkpoints.slice(midpoint, Math.max(midpoint + 1, Math.floor(checkpoints.length * 0.75))).map((item) => item.rss));
const finalRss = Math.max(...checkpoints.slice(Math.max(midpoint, Math.floor(checkpoints.length * 0.75))).map((item) => item.rss));
const postWarmupRssGrowth = Math.max(0, finalRss - warmRss);
const allowance = Number(process.env.YAOS_YWASM_MAX_POST_WARMUP_RSS_GROWTH_BYTES ?? 64 * 1_024 * 1_024);
assert.ok(postWarmupRssGrowth <= allowance,
	`post-warmup RSS grew ${postWarmupRssGrowth} bytes (allowance ${allowance})`);

console.log(JSON.stringify({
	passed: true,
	engine: engineName,
	cycles,
	residentShards,
	stateBytes: state.byteLength,
	baseline,
	afterChurnDelta: delta(afterChurn, baseline),
	postWarmupRssGrowth,
	residentDualDocumentDelta: delta(residentLoaded, afterChurn),
	afterResidentDestroyDelta: delta(afterResidentDestroy, afterChurn),
	checkpoints,
}, null, 2));
