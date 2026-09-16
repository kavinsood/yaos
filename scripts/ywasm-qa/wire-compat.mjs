#!/usr/bin/env node

import assert from "node:assert/strict";
import * as Y from "yjs";
import { destroyWasm, loadYwasm } from "./raw-engine.mjs";

const W = await loadYwasm();
const source = new Y.Doc({ guid: "wire-source" });
source.getText("body").insert(0, "hello 中文 👨‍👩‍👧‍👦 e\u0301");
source.getMap("meta").set("schemaVersion", 10);
const nested = new Y.Map();
nested.set("kind", "node");
source.getMap("nodes").set("n1", nested);
source.getArray("order").insert(0, ["n1", 42, true]);

const wasm = new W.YDoc({ guid: "wire-source" });
let wasmBody;
let wasmMeta;
let wasmNodes;
let wasmOrder;
let wasmNested;
const roundTrip = new Y.Doc({ guid: "wire-roundtrip" });
const wasmOrigin = new W.YDoc({ guid: "wire-wasm-origin" });
let wasmOriginText;
const yjsFromWasm = new Y.Doc({ guid: "wire-wasm-origin" });
try {
	const sourceUpdate = Y.encodeStateAsUpdate(source);
	W.applyUpdate(wasm, sourceUpdate, "wire-compat");
	wasmBody = wasm.getText("body");
	wasmMeta = wasm.getMap("meta");
	wasmNodes = wasm.getMap("nodes");
	wasmOrder = wasm.getArray("order");
	assert.equal(wasmBody.toString(undefined), source.getText("body").toString());
	assert.equal(wasmMeta.get("schemaVersion", undefined), 10);
	wasmNested = wasmNodes.get("n1", undefined);
	assert.ok(wasmNested instanceof W.YMap);
	assert.equal(wasmNested.get("kind", undefined), "node");
	assert.deepEqual(wasmOrder.toJson(undefined), ["n1", 42, true]);

	const wasmUpdate = W.encodeStateAsUpdate(wasm);
	Y.applyUpdate(roundTrip, wasmUpdate);
	assert.equal(roundTrip.getText("body").toString(), source.getText("body").toString());
	assert.deepEqual(roundTrip.getArray("order").toJSON(), ["n1", 42, true]);
	assert.ok(roundTrip.getMap("nodes").get("n1") instanceof Y.Map);

	wasmOriginText = wasmOrigin.getText("body");
	wasmOriginText.insert(0, "A🌍B中文", undefined, undefined);
	const wasmOriginUpdate = W.encodeStateAsUpdate(wasmOrigin);
	Y.applyUpdate(yjsFromWasm, wasmOriginUpdate);
	assert.equal(yjsFromWasm.getText("body").toString(), "A🌍B中文");

	const yVector = Y.encodeStateVector(roundTrip);
	source.getText("body").insert(source.getText("body").length, " tail");
	const missing = Y.encodeStateAsUpdate(source, yVector);
	W.applyUpdate(wasm, missing, "catchup");
	assert.equal(wasmBody.toString(undefined), source.getText("body").toString());

	const merged = W.mergeUpdatesV1([sourceUpdate, missing]);
	const mergedDoc = new Y.Doc();
	try {
		Y.applyUpdate(mergedDoc, merged);
		assert.equal(mergedDoc.getText("body").toString(), source.getText("body").toString());
	} finally {
		mergedDoc.destroy();
	}

	console.log(JSON.stringify({
		passed: true,
		yjsToYwasm: true,
		ywasmToYjs: true,
		nestedTypes: true,
		stateVectorCatchup: true,
		mergeUpdates: true,
	}));
} finally {
	source.destroy();
	roundTrip.destroy();
	yjsFromWasm.destroy();
	wasmNested?.free?.();
	destroyWasm(wasm, wasmBody, wasmMeta, wasmNodes, wasmOrder);
	destroyWasm(wasmOrigin, wasmOriginText);
}
