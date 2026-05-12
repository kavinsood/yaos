import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { isUpdateBearingSyncMessage } from "../server/src/syncMessageClassifier";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL  ${msg}`);
		failed++;
	}
}

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

function frameSync(writeInner: (encoder: encoding.Encoder) => void): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_SYNC);
	writeInner(encoder);
	return encoding.toUint8Array(encoder);
}

function frameAwareness(update: Uint8Array): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
	encoding.writeVarUint8Array(encoder, update);
	return encoding.toUint8Array(encoder);
}

function frameOuterOnly(outerType: number): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, outerType);
	return encoding.toUint8Array(encoder);
}

function buildDocWithText(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText("note").insert(0, text);
	return doc;
}

console.log("\n--- Test 1: real y-protocol sync messages ---");
{
	const doc = buildDocWithText("hello");
	const syncStep1 = frameSync((encoder) => syncProtocol.writeSyncStep1(encoder, doc));
	const syncStep2 = frameSync((encoder) => syncProtocol.writeSyncStep2(encoder, doc, Y.encodeStateVector(new Y.Doc())));
	const update = Y.encodeStateAsUpdate(doc);
	const yjsUpdate = frameSync((encoder) => syncProtocol.writeUpdate(encoder, update));

	assert(!isUpdateBearingSyncMessage(syncStep1), "SyncStep1 => false");
	assert(isUpdateBearingSyncMessage(syncStep2), "SyncStep2 => true");
	assert(isUpdateBearingSyncMessage(yjsUpdate), "Update => true");

	doc.destroy();
}

console.log("\n--- Test 2: non-sync frames are ignored ---");
{
	const doc = new Y.Doc();
	const awareness = new awarenessProtocol.Awareness(doc);
	awareness.setLocalState({ user: { name: "tester" } });
	const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]);
	const message = frameAwareness(awarenessUpdate);

	assert(!isUpdateBearingSyncMessage(message), "Awareness => false");
	assert(!isUpdateBearingSyncMessage("__YPS:{\"type\":\"yaos/sv-echo\"}"), "String custom message => false");

	awareness.destroy();
	doc.destroy();
}

console.log("\n--- Test 3: malformed and unknown messages fail closed ---");
{
	const unknownOuter = frameOuterOnly(99);
	const unknownInner = frameSync((encoder) => encoding.writeVarUint(encoder, 99));

	assert(!isUpdateBearingSyncMessage(new Uint8Array()), "empty binary => false");
	assert(!isUpdateBearingSyncMessage(frameOuterOnly(MESSAGE_SYNC)), "malformed sync frame with no inner type => false");
	assert(!isUpdateBearingSyncMessage(new Uint8Array([255])), "malformed varuint => false");
	assert(!isUpdateBearingSyncMessage(unknownOuter), "unknown outer type => false");
	assert(!isUpdateBearingSyncMessage(unknownInner), "unknown sync inner type => false");
}

console.log("\n--- Test 4: supported binary container shapes ---");
{
	const doc = buildDocWithText("container");
	const updateFrame = frameSync((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc)));
	const copiedBuffer = updateFrame.buffer.slice(updateFrame.byteOffset, updateFrame.byteOffset + updateFrame.byteLength);
	const dataView = new DataView(copiedBuffer);

	assert(isUpdateBearingSyncMessage(copiedBuffer), "ArrayBuffer update frame => true");
	assert(isUpdateBearingSyncMessage(dataView), "ArrayBuffer view update frame => true");

	doc.destroy();
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
