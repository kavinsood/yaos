import * as Y from "yjs";
import {
	makeSvEchoCustomMessage,
	makeSvEchoCustomMessageForDoc,
	trySendSvEcho,
	trySendSvEchoStateVector,
} from "../server/src/svEcho";
import { parseSvEchoMessage } from "../src/sync/svEchoMessage";
import { isStateVectorGe } from "../src/sync/stateVectorAck";
import * as clientProtocol from "../src/sync/svEchoProtocol";
import * as serverProtocol from "../server/src/svEchoProtocol";

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

function buildDocWithClients(count: number): Y.Doc {
	const merged = new Y.Doc();
	for (let i = 0; i < count; i++) {
		const client = new Y.Doc();
		client.getText(`note-${i}`).insert(0, `hello-${i}`);
		Y.applyUpdate(merged, Y.encodeStateAsUpdate(client));
		client.destroy();
	}
	return merged;
}

console.log("\n--- Test 1: payload shape and client parser round-trip ---");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "server receipt payload");
	const serverSv = Y.encodeStateVector(doc);
	const payload = makeSvEchoCustomMessage(serverSv);
	const parsedJson = JSON.parse(payload) as Record<string, unknown>;
	const parsedSv = parseSvEchoMessage(payload);

	assert(parsedJson.type === clientProtocol.SV_ECHO_TYPE, "payload type is namespaced");
	assert(parsedJson.schema === clientProtocol.SV_ECHO_SCHEMA, "payload schema is 1");
	assert(typeof parsedJson.sv === "string" && parsedJson.sv.length > 0, "payload has base64 sv");
	assert(parsedSv !== null, "client parser accepts server payload");
	assert(parsedSv !== null && isStateVectorGe(parsedSv, serverSv), "parsed SV dominates original server SV");
	assert(parsedSv !== null && isStateVectorGe(serverSv, parsedSv), "parsed SV equals original server SV");

	doc.destroy();
}

console.log("\n--- Test 2: client/server protocol constants stay aligned ---");
{
	assert(serverProtocol.SV_ECHO_TYPE === clientProtocol.SV_ECHO_TYPE, "type constant matches client");
	assert(serverProtocol.SV_ECHO_SCHEMA === clientProtocol.SV_ECHO_SCHEMA, "schema constant matches client");
	assert(
		serverProtocol.MAX_SV_ECHO_BASE64_BYTES === clientProtocol.MAX_SV_ECHO_BASE64_BYTES,
		"max base64 size matches client",
	);
}

console.log("\n--- Test 3: doc helper encodes current doc state vector ---");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "doc helper");
	const payload = makeSvEchoCustomMessageForDoc(doc);
	const parsedSv = parseSvEchoMessage(payload);
	const currentSv = Y.encodeStateVector(doc);

	assert(parsedSv !== null, "doc helper payload parses");
	assert(parsedSv !== null && isStateVectorGe(parsedSv, currentSv), "doc helper SV dominates current doc SV");
	assert(parsedSv !== null && isStateVectorGe(currentSv, parsedSv), "doc helper SV equals current doc SV");

	doc.destroy();
}

console.log("\n--- Test 4: large state vector uses byte-safe base64 ---");
{
	const doc = buildDocWithClients(1800);
	const payload = makeSvEchoCustomMessageForDoc(doc);
	const parsedSv = parseSvEchoMessage(payload);
	const currentSv = Y.encodeStateVector(doc);

	assert(payload.length > 8192, "large SV payload exceeds one base64 chunk");
	assert(parsedSv !== null, "large SV payload parses");
	assert(parsedSv !== null && isStateVectorGe(parsedSv, currentSv), "large parsed SV dominates current doc SV");
	assert(parsedSv !== null && isStateVectorGe(currentSv, parsedSv), "large parsed SV equals current doc SV");

	doc.destroy();
}

console.log("\n--- Test 5: trySendSvEcho frames custom message and reports bytes ---");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "send helper");
	const sent: string[] = [];
	const result = trySendSvEcho({
		readyState: 1,
		send(message: string) {
			sent.push(message);
		},
	}, doc, "baseline");

	assert(result.ok, "send helper returns ok=true on send success");
	assert(result.kind === "baseline", "send helper preserves kind");
	assert(result.bytes > 0, "send helper reports framed message bytes");
	assert(sent.length === 1, "send helper sends exactly one message");
	assert(sent[0]?.startsWith("__YPS:"), "send helper uses y-partyserver custom-message prefix");
	assert(parseSvEchoMessage(sent[0]?.slice("__YPS:".length) ?? "") !== null, "framed payload parses after prefix removal");

	doc.destroy();
}

console.log("\n--- Test 6: trySendSvEcho respects readyState before sending ---");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "ready state");
	const sent: string[] = [];
	const sendable = (readyState: number | undefined) => ({
		...(readyState === undefined ? {} : { readyState }),
		send(message: string) {
			sent.push(message);
		},
	});

	const connecting = trySendSvEcho(sendable(0), doc, "postApply");
	const open = trySendSvEcho(sendable(1), doc, "postApply");
	const closing = trySendSvEcho(sendable(2), doc, "postApply");
	const closed = trySendSvEcho(sendable(3), doc, "postApply");
	const unknown = trySendSvEcho(sendable(undefined), doc, "postApply");

	assert(!connecting.ok && connecting.failure === "not_open", "CONNECTING => no send, not_open");
	assert(open.ok, "OPEN => send attempted");
	assert(!closing.ok && closing.failure === "not_open", "CLOSING => no send, not_open");
	assert(!closed.ok && closed.failure === "not_open", "CLOSED => no send, not_open");
	assert(unknown.ok, "undefined readyState => send attempted");
	assert(sent.length === 2, "only OPEN and undefined readyState send");

	doc.destroy();
}

console.log("\n--- Test 7: trySendSvEcho reports send failures and oversize drops ---");
{
	const doc = new Y.Doc();
	doc.getText("note").insert(0, "send failure");
	const throwResult = trySendSvEcho({
		readyState: 1,
		send() {
			throw new Error("boom");
		},
	}, doc, "postApply");
	const oversizeResult = trySendSvEchoStateVector({
		readyState: 1,
		send() {
			throw new Error("should not send");
		},
	}, new Uint8Array(clientProtocol.MAX_SV_ECHO_BASE64_BYTES), "postApply");

	assert(!throwResult.ok && throwResult.failure === "send_failed", "send throw => send_failed");
	assert(throwResult.bytes > 0, "throw result reports attempted payload bytes");
	assert(!oversizeResult.ok && oversizeResult.failure === "oversize", "oversize payload => oversize failure");
	assert(oversizeResult.bytes > 0, "oversize result reports framed payload bytes");

	doc.destroy();
}

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
