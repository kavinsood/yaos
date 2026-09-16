#!/usr/bin/env node

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { destroyWasm, loadYwasm, parsePositiveInteger } from "./raw-engine.mjs";

const engineName = process.argv[2];
if (engineName !== "yjs" && engineName !== "ywasm") {
	throw new Error("usage: lifecycle-benchmark.mjs <yjs|ywasm> [updates] [repetitions]");
}
const updateCount = parsePositiveInteger(process.argv[3], "updates", 2_000);
const repetitions = parsePositiveInteger(process.argv[4], "repetitions", 3);
const W = engineName === "ywasm" ? await loadYwasm() : null;
const wasm = engineName === "ywasm";

function makeDoc(suffix) {
	return wasm ? new W.YDoc({ guid: `lifecycle-${suffix}` }) : new Y.Doc({ guid: `lifecycle-${suffix}` });
}
function apply(doc, update) {
	if (wasm) W.applyUpdate(doc, update, "lifecycle-qa");
	else Y.applyUpdate(doc, update, "lifecycle-qa");
}
function encode(doc, vector) {
	return wasm ? W.encodeStateAsUpdate(doc, vector) : Y.encodeStateAsUpdate(doc, vector);
}
function vector(doc) {
	return wasm ? W.encodeStateVector(doc) : Y.encodeStateVector(doc);
}
function readText(doc) {
	const text = doc.getText("body");
	try { return wasm ? text.toString(undefined) : text.toString(); }
	finally { if (wasm) text.free(); }
}
function writeText(doc, value) {
	const text = doc.getText("body");
	try {
		if (wasm) text.insert(0, value, undefined, undefined);
		else text.insert(0, value);
	} finally { if (wasm) text.free(); }
}
function destroy(doc) {
	if (wasm) destroyWasm(doc);
	else doc.destroy();
}
function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}
function timed(body) {
	const cpuStarted = process.cpuUsage();
	const started = performance.now();
	const value = body();
	const cpu = process.cpuUsage(cpuStarted);
	return { value, elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1_000 };
}
function median(samples, field) {
	const ordered = samples.map((sample) => sample[field]).sort((left, right) => left - right);
	return ordered[Math.floor(ordered.length / 2)];
}

function fixture() {
	const doc = new Y.Doc({ guid: "lifecycle-fixture" });
	const text = doc.getText("body");
	text.insert(0, "A representative YAOS note with 中文, emoji 🌍, links [[note]], and prose.\n".repeat(1_024));
	const base = Y.encodeStateAsUpdate(doc);
	const frames = [];
	for (let index = 0; index < updateCount; index++) {
		const before = Y.encodeStateVector(doc);
		if (index % 11 === 10) {
			const current = text.toString();
			const removed = Array.from(current).slice(-8).join("");
			text.delete(current.length - removed.length, removed.length);
		} else {
			text.insert(text.length, `edit-${index}-中文-😀\n`);
		}
		frames.push(Y.encodeStateAsUpdate(doc, before));
	}
	const finalText = text.toString();
	const finalState = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return { base, frames, finalText, finalState, warmWindow: Math.min(50, updateCount) };
}

const input = fixture();
const warmSource = new Y.Doc();
Y.applyUpdate(warmSource, input.base);
for (const frame of input.frames.slice(0, -input.warmWindow)) Y.applyUpdate(warmSource, frame);
const warmBase = Y.encodeStateAsUpdate(warmSource);
warmSource.destroy();
const warmFrames = input.frames.slice(-input.warmWindow);
const expectedDigest = digest(input.finalText);
const samples = Object.fromEntries([
	"coldReconstruction", "dualDocumentLoad", "applyResidentTail", "catchup", "checkpointEncode", "semanticRebuild",
].map((name) => [name, []]));
let catchupBytes = 0;
let checkpointBytes = 0;
let semanticBytes = 0;

for (let repetition = 0; repetition < repetitions; repetition++) {
	{
		const result = timed(() => {
			const doc = makeDoc(`cold-${repetition}`);
			apply(doc, input.base);
			for (const frame of input.frames) apply(doc, frame);
			return doc;
		});
		if (digest(readText(result.value)) !== expectedDigest) throw new Error("cold reconstruction mismatch");
		destroy(result.value);
		samples.coldReconstruction.push(result);
	}
	{
		const result = timed(() => {
			const left = makeDoc(`dual-left-${repetition}`);
			const right = makeDoc(`dual-right-${repetition}`);
			apply(left, warmBase);
			apply(right, warmBase);
			return [left, right];
		});
		for (const doc of result.value) destroy(doc);
		samples.dualDocumentLoad.push(result);
	}
	{
		const doc = makeDoc(`warm-${repetition}`);
		apply(doc, warmBase);
		const result = timed(() => { for (const frame of warmFrames) apply(doc, frame); });
		if (digest(readText(doc)) !== expectedDigest) throw new Error("resident tail mismatch");
		destroy(doc);
		samples.applyResidentTail.push(result);
	}
	{
		const authoritative = makeDoc(`catchup-a-${repetition}`);
		const peer = makeDoc(`catchup-b-${repetition}`);
		apply(authoritative, input.finalState);
		apply(peer, warmBase);
		const result = timed(() => {
			const update = encode(authoritative, vector(peer));
			apply(peer, update);
			return update.byteLength;
		});
		catchupBytes = result.value;
		if (digest(readText(peer)) !== expectedDigest) throw new Error("catchup mismatch");
		destroy(authoritative); destroy(peer);
		samples.catchup.push(result);
	}
	{
		const doc = makeDoc(`checkpoint-${repetition}`);
		apply(doc, input.finalState);
		const result = timed(() => encode(doc));
		checkpointBytes = result.value.byteLength;
		destroy(doc);
		samples.checkpointEncode.push(result);
	}
	{
		const oldDoc = makeDoc(`semantic-old-${repetition}`);
		apply(oldDoc, input.finalState);
		let fresh;
		const result = timed(() => {
			fresh = makeDoc(`semantic-fresh-${repetition}`);
			writeText(fresh, readText(oldDoc));
			return encode(fresh);
		});
		semanticBytes = result.value.byteLength;
		if (digest(readText(fresh)) !== expectedDigest) throw new Error("semantic rebuild mismatch");
		destroy(oldDoc); destroy(fresh);
		samples.semanticRebuild.push(result);
	}
}

console.log(JSON.stringify({
	passed: true,
	engine: engineName,
	repetitions,
	fixture: {
		updates: updateCount,
		baseBytes: input.base.byteLength,
		journalBytes: input.frames.reduce((sum, frame) => sum + frame.byteLength, 0),
		finalStateBytes: input.finalState.byteLength,
		finalTextBytes: new TextEncoder().encode(input.finalText).byteLength,
		finalTextSha256: expectedDigest,
	},
	stages: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
		elapsedMs: median(values, "elapsedMs"),
		cpuMs: median(values, "cpuMs"),
	}])),
	outputs: { catchupBytes, checkpointBytes, semanticBytes },
}, null, 2));
