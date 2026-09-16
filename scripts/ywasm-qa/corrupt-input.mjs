#!/usr/bin/env node

import assert from "node:assert/strict";
import * as Y from "yjs";
import { destroyWasm, loadYwasm } from "./raw-engine.mjs";

const W = await loadYwasm();
const source = new Y.Doc();
source.getText("body").insert(0, "durable valid state 🌍");
const valid = Y.encodeStateAsUpdate(source);
const corruptions = [
	new Uint8Array(),
	new Uint8Array([255]),
	valid.subarray(0, 1),
	valid.subarray(0, Math.max(1, valid.byteLength - 1)),
	Uint8Array.from(valid, (value, index) => index === Math.floor(valid.byteLength / 2) ? value ^ 0xff : value),
];
let trapped = 0;
for (let index = 0; index < corruptions.length; index++) {
	const doc = new W.YDoc({ guid: `corrupt-${index}` });
	try {
		try {
			W.applyUpdate(doc, corruptions[index], "untrusted");
		} catch {
			trapped++;
		}
	} finally {
		destroyWasm(doc);
	}
}

assert.ok(trapped >= 3, `expected malformed payloads to trap; only ${trapped} did`);

// A trap must not poison the module. Recovery creates a fresh document from
// durable bytes rather than continuing with a possibly partially-mutated doc.
const recovered = new W.YDoc({ guid: "recovered" });
let recoveredText;
try {
	W.applyUpdate(recovered, valid, "durable-reconstruction");
	recoveredText = recovered.getText("body");
	assert.equal(recoveredText.toString(undefined), "durable valid state 🌍");
	assert.ok(W.encodeStateAsUpdate(recovered).byteLength > 0);
} finally {
	destroyWasm(recovered, recoveredText);
	source.destroy();
}

console.log(JSON.stringify({
	passed: true,
	corruptions: corruptions.length,
	trapped,
	moduleRecovered: true,
}));
