#!/usr/bin/env node

import assert from "node:assert/strict";
import * as Y from "yjs";
import {
	destroyWasm,
	loadYwasm,
	modelBoundaries,
	parsePositiveInteger,
	seededRandom,
} from "./raw-engine.mjs";

const W = await loadYwasm();
const seeds = parsePositiveInteger(process.argv[2], "seeds", 100);
const operations = parsePositiveInteger(process.argv[3], "operations", 500);
const tokens = [
	"a", "Z", " ", "\n", "汉", "中文", "日本語", "क", "עברית", "العربية",
	"🌍", "😀", "🫠", "👍🏽", "🇮🇳", "👨‍👩‍👧‍👦", "👩🏾‍💻",
	"e\u0301", "n\u0303", "Z\u0351\u036b\u0343\u031a", "❤️", "☕️",
];

function nextOperation(random, value) {
	const points = modelBoundaries(value);
	if (points.length === 1 || random() % 100 < 62) {
		return { kind: "insert", index: points[random() % points.length], value: tokens[random() % tokens.length] };
	}
	let left = random() % points.length;
	let right = random() % points.length;
	if (left === right) right = (right + 1) % points.length;
	if (left > right) [left, right] = [right, left];
	return { kind: "delete", index: points[left], length: points[right] - points[left] };
}

function applyModel(value, operation) {
	return operation.kind === "insert"
		? value.slice(0, operation.index) + operation.value + value.slice(operation.index)
		: value.slice(0, operation.index) + value.slice(operation.index + operation.length);
}

function fuzzYjsToWasm(seed) {
	const random = seededRandom(seed ^ 0xa5a5_a5a5);
	const ydoc = new Y.Doc({ guid: `unicode-yjs-${seed}` });
	const ytext = ydoc.getText("body");
	const wdoc = new W.YDoc({ guid: `unicode-yjs-${seed}` });
	const wtext = wdoc.getText("body");
	let expected = "";
	try {
		for (let index = 0; index < operations; index++) {
			const operation = nextOperation(random, expected);
			const vector = Y.encodeStateVector(ydoc);
			if (operation.kind === "insert") ytext.insert(operation.index, operation.value);
			else ytext.delete(operation.index, operation.length);
			expected = applyModel(expected, operation);
			W.applyUpdate(wdoc, Y.encodeStateAsUpdate(ydoc, vector), "unicode-fuzz");
			assert.equal(ytext.toString(), expected, `Yjs model seed=${seed} operation=${index}`);
			assert.equal(wtext.toString(undefined), expected, `Yjs→ywasm seed=${seed} operation=${index}`);
			if (index % 47 === 0) {
				const roundTrip = new Y.Doc();
				try {
					Y.applyUpdate(roundTrip, W.encodeStateAsUpdate(wdoc));
					assert.equal(roundTrip.getText("body").toString(), expected);
				} finally {
					roundTrip.destroy();
				}
			}
		}
	} finally {
		ydoc.destroy();
		destroyWasm(wdoc, wtext);
	}
}

function fuzzWasmToYjs(seed) {
	const random = seededRandom(seed ^ 0x5a5a_5a5a);
	const wdoc = new W.YDoc({ guid: `unicode-wasm-${seed}` });
	const wtext = wdoc.getText("body");
	const ydoc = new Y.Doc({ guid: `unicode-wasm-${seed}` });
	const ytext = ydoc.getText("body");
	let expected = "";
	try {
		for (let index = 0; index < operations; index++) {
			const operation = nextOperation(random, expected);
			const vector = W.encodeStateVector(wdoc);
			// ywasm's JavaScript surface is specified in UTF-16 code units, the
			// same indexing model used by String.slice and Yjs.
			if (operation.kind === "insert") {
				wtext.insert(operation.index, operation.value, undefined, undefined);
			} else {
				wtext.delete(operation.index, operation.length, undefined);
			}
			expected = applyModel(expected, operation);
			Y.applyUpdate(ydoc, W.encodeStateAsUpdate(wdoc, vector), "unicode-fuzz");
			assert.equal(wtext.toString(undefined), expected, `ywasm model seed=${seed} operation=${index}`);
			assert.equal(ytext.toString(), expected, `ywasm→Yjs seed=${seed} operation=${index}`);
			if (index % 47 === 0) {
				const roundTrip = new W.YDoc({ guid: `unicode-roundtrip-${seed}-${index}` });
				const text = roundTrip.getText("body");
				try {
					W.applyUpdate(roundTrip, Y.encodeStateAsUpdate(ydoc), "unicode-roundtrip");
					assert.equal(text.toString(undefined), expected);
				} finally {
					destroyWasm(roundTrip, text);
				}
			}
		}
	} finally {
		ydoc.destroy();
		destroyWasm(wdoc, wtext);
	}
}

for (let seed = 1; seed <= seeds; seed++) {
	fuzzYjsToWasm(seed);
	fuzzWasmToYjs(seed);
}

console.log(JSON.stringify({
	passed: true,
	seeds,
	operationsPerDirection: operations,
	totalOperations: seeds * operations * 2,
	directions: ["Yjs→ywasm→Yjs", "ywasm→Yjs→ywasm"],
	offsetModel: "UTF-16 code units",
}));
