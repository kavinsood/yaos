import assert from "node:assert/strict";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
	readSyncMessage,
	writeSyncStep1,
	writeSyncStep2,
	writeSyncUpdate,
} from "../../server/src/crdt/syncFraming";
import { yjsCrdtEngine } from "../../server/src/crdt/yjsCrdtEngine";
import { createYwasmCrdtEngine, type YwasmBindings } from "../../server/src/crdt/ywasmCrdtEngine";
import { suite } from "../harness.ts";

const s = suite("crdt-sync-framing");
const ywasmSpecifier = process.env.YAOS_YWASM_MODULE ?? "ywasm";
const ywasm = createYwasmCrdtEngine(await import(ywasmSpecifier) as unknown as YwasmBindings);

function encoded(body: (encoder: encoding.Encoder) => void): Uint8Array {
	const encoder = encoding.createEncoder();
	body(encoder);
	return encoding.toUint8Array(encoder);
}

function outerSyncFrame(body: (encoder: encoding.Encoder) => void): Uint8Array {
	return encoded((encoder) => {
		encoding.writeVarUint(encoder, 0);
		body(encoder);
	});
}

function decodeOuterSyncFrame(frame: Uint8Array) {
	const decoder = decoding.createDecoder(frame);
	assert.equal(decoding.readVarUint(decoder), 0, "outer message is sync");
	return readSyncMessage(decoder);
}

s.test("Yjs adapter step 1 is byte-identical to y-protocols", () => {
	const oracle = new Y.Doc({ guid: "sync-step-1" });
	oracle.getText("body").insert(0, "中文 😀 step one");
	const engineDoc = yjsCrdtEngine.openDocument("sync-step-1", Y.encodeStateAsUpdate(oracle));
	try {
		const expected = outerSyncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, oracle));
		const actual = outerSyncFrame((encoder) => writeSyncStep1(encoder, yjsCrdtEngine, engineDoc));
		assert.deepEqual(actual, expected);
		assert.deepEqual(decodeOuterSyncFrame(actual), {
			kind: "step-1",
			stateVector: Y.encodeStateVector(oracle),
		});
	} finally {
		yjsCrdtEngine.destroyDocument(engineDoc);
		oracle.destroy();
	}
});

s.test("Yjs adapter step 2 is byte-identical to y-protocols", () => {
	const oracle = new Y.Doc({ guid: "sync-step-2" });
	const peer = new Y.Doc({ guid: "sync-step-2" });
	oracle.getText("body").insert(0, "full ");
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(oracle));
	oracle.getText("body").insert(oracle.getText("body").length, "中文 🌍 state");
	const vector = Y.encodeStateVector(peer);
	const engineDoc = yjsCrdtEngine.openDocument("sync-step-2", Y.encodeStateAsUpdate(oracle));
	try {
		const expected = outerSyncFrame((encoder) => syncProtocol.writeSyncStep2(encoder, oracle, vector));
		const actual = outerSyncFrame((encoder) => writeSyncStep2(encoder, yjsCrdtEngine, engineDoc, vector));
		assert.deepEqual(actual, expected);
		const decoded = decodeOuterSyncFrame(actual);
		assert.equal(decoded.kind, "step-2");
		if (decoded.kind !== "step-2") return;
		Y.applyUpdate(peer, decoded.update);
		assert.equal(peer.getText("body").toJSON(), oracle.getText("body").toJSON());
	} finally {
		yjsCrdtEngine.destroyDocument(engineDoc);
		oracle.destroy();
		peer.destroy();
	}
});

s.test("update notification is byte-identical to y-protocols", () => {
	const update = Uint8Array.from([1, 2, 3, 127, 128, 255]);
	assert.deepEqual(
		outerSyncFrame((encoder) => writeSyncUpdate(encoder, update)),
		outerSyncFrame((encoder) => syncProtocol.writeUpdate(encoder, update)),
	);
	assert.deepEqual(decodeOuterSyncFrame(outerSyncFrame((encoder) => writeSyncUpdate(encoder, update))), {
		kind: "update",
		update,
	});
});

s.test("ywasm and Yjs complete the same two-step handshake", () => {
	const source = ywasm.createDocument("cross-engine-sync");
	const peer = yjsCrdtEngine.createDocument("cross-engine-sync");
	try {
		ywasm.insertText(source, "body", 0, "CJK 中文, ZWJ 👩🏾‍💻, combining e\u0301");
		const step1 = encoded((encoder) => writeSyncStep1(encoder, yjsCrdtEngine, peer));
		const decodedStep1 = readSyncMessage(decoding.createDecoder(step1));
		assert.equal(decodedStep1.kind, "step-1");
		if (decodedStep1.kind !== "step-1") return;
		const step2 = encoded((encoder) => writeSyncStep2(encoder, ywasm, source, decodedStep1.stateVector));
		const decodedStep2 = readSyncMessage(decoding.createDecoder(step2));
		assert.equal(decodedStep2.kind, "step-2");
		if (decodedStep2.kind !== "step-2") return;
		yjsCrdtEngine.applyUpdate(peer, decodedStep2.update, "sync-step-2");
		assert.equal(yjsCrdtEngine.readText(peer, "body"), ywasm.readText(source, "body"));
	} finally {
		ywasm.destroyDocument(source);
		yjsCrdtEngine.destroyDocument(peer);
	}
});

s.test("unknown inner sync types fail closed", () => {
	const frame = encoded((encoder) => {
		encoding.writeVarUint(encoder, 99);
		encoding.writeVarUint8Array(encoder, new Uint8Array());
	});
	assert.throws(() => readSyncMessage(decoding.createDecoder(frame)), /unsupported sync message 99/);
});

await s.done();
