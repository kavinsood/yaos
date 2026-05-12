/**
 * Unit tests for svEchoMessage.ts — parseSvEchoMessage, makeSvEchoMessage,
 * and the byte-safe base64 helpers.
 *
 * All tests are pure Node — no Obsidian.
 */

import * as Y from "yjs";
import {
	makeSvEchoMessage,
	parseSvEchoMessage,
	parseSvEchoMessageDetailed,
	createSvEchoCounters,
	recordSvEchoParseResult,
	encodeBytesBase64,
	decodeBytesBase64,
	MAX_SV_ECHO_BASE64_BYTES,
} from "../src/sync/svEchoMessage";

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

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function makeStateVector(text = "sv"): Uint8Array {
	const doc = new Y.Doc();
	doc.getText("t").insert(0, text);
	const sv = Y.encodeStateVector(doc);
	doc.destroy();
	return sv;
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

console.log("\n--- Test 1: base64 round-trip ---");
{
	const empty = new Uint8Array(0);
	const decoded = decodeBytesBase64(encodeBytesBase64(empty));
	assert(decoded !== null && decoded.length === 0, "empty bytes round-trip");

	const small = new Uint8Array([1, 2, 3, 255, 0, 127]);
	const decoded2 = decodeBytesBase64(encodeBytesBase64(small));
	assert(decoded2 !== null && arraysEqual(decoded2, small), "small bytes round-trip");

	// 256 bytes of arbitrary data
	const medium = new Uint8Array(256);
	for (let i = 0; i < 256; i++) medium[i] = i;
	const decoded3 = decodeBytesBase64(encodeBytesBase64(medium));
	assert(decoded3 !== null && arraysEqual(decoded3, medium), "256 bytes round-trip");
}

console.log("\n--- Test 2: base64 large payload (above spread limit) ---");
{
	// 70000 bytes — above the 65535 spread limit that would break naive encoding
	const large = new Uint8Array(70000);
	for (let i = 0; i < 70000; i++) large[i] = i & 0xff;
	const encoded = encodeBytesBase64(large);
	const decoded = decodeBytesBase64(encoded);
	assert(decoded !== null, "large payload encodes without error");
	assert(decoded !== null && arraysEqual(decoded, large), "large payload decodes correctly");
}

console.log("\n--- Test 3: decodeBytesBase64 invalid input ---");
{
	assert(decodeBytesBase64("not-valid-base64!!!") === null, "invalid base64 => null");
	assert(decodeBytesBase64("") !== null, "empty string => zero-length array (not null)");
}

// ── parseSvEchoMessage ────────────────────────────────────────────────────────

console.log("\n--- Test 4: valid message parses ---");
{
	const sv = makeStateVector("valid parse");
	const msg = makeSvEchoMessage(sv);
	const result = parseSvEchoMessage(msg);
	assert(result !== null, "valid message: result is not null");
	assert(result !== null && arraysEqual(result, sv), "valid message: bytes match");
}

console.log("\n--- Test 5: parseSvEchoMessage rejects invalid inputs ---");
{
	assert(parseSvEchoMessage("not json") === null, "non-JSON => null");
	assert(parseSvEchoMessage("null") === null, "JSON null => null");
	assert(parseSvEchoMessage("42") === null, "JSON number => null");
	assert(parseSvEchoMessage("[]") === null, "JSON array => null");
	assert(parseSvEchoMessage("{}") === null, "empty object => null");
}

console.log("\n--- Test 6: wrong type field ---");
{
	const validSv = makeStateVector("wrong type");
	const encoded = encodeBytesBase64(validSv);
	const wrong = JSON.stringify({ type: "other/sv-echo", schema: 1, sv: encoded });
	assert(parseSvEchoMessage(wrong) === null, "wrong type => null");
	const unnamespaced = JSON.stringify({ type: "sv-echo", schema: 1, sv: encoded });
	assert(parseSvEchoMessage(unnamespaced) === null, "unnamespaced type => null");
	const missing = JSON.stringify({ schema: 1, sv: encoded });
	assert(parseSvEchoMessage(missing) === null, "missing type field => null");
}

console.log("\n--- Test 7: wrong schema version ---");
{
	const encoded = encodeBytesBase64(makeStateVector("wrong schema"));
	const wrongSchema = JSON.stringify({ type: "yaos/sv-echo", schema: 2, sv: encoded });
	assert(parseSvEchoMessage(wrongSchema) === null, "schema 2 => null");
	const zeroSchema = JSON.stringify({ type: "yaos/sv-echo", schema: 0, sv: encoded });
	assert(parseSvEchoMessage(zeroSchema) === null, "schema 0 => null");
	const strSchema = JSON.stringify({ type: "yaos/sv-echo", schema: "1", sv: encoded });
	assert(parseSvEchoMessage(strSchema) === null, "schema as string => null");
}

console.log("\n--- Test 8: missing or non-string sv field ---");
{
	const base = { type: "yaos/sv-echo", schema: 1 };
	assert(parseSvEchoMessage(JSON.stringify(base)) === null, "missing sv => null");
	assert(parseSvEchoMessage(JSON.stringify({ ...base, sv: 42 })) === null, "numeric sv => null");
	assert(parseSvEchoMessage(JSON.stringify({ ...base, sv: null })) === null, "null sv => null");
	assert(parseSvEchoMessage(JSON.stringify({ ...base, sv: [] })) === null, "array sv => null");
}

console.log("\n--- Test 9: oversized payload rejected ---");
{
	// Build a base64 string longer than MAX_SV_ECHO_BASE64_BYTES
	const oversizedB64 = "A".repeat(MAX_SV_ECHO_BASE64_BYTES + 1);
	const oversized = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: oversizedB64 });
	assert(parseSvEchoMessage(oversized) === null, "oversized payload => null");

	// Exactly at the limit: handled without throwing. It may still be rejected
	// by base64 or state-vector validation.
	const atLimit = "A".repeat(MAX_SV_ECHO_BASE64_BYTES);
	const atLimitMsg = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: atLimit });
	// Might return null due to invalid base64 content, but NOT due to size rejection
	const result = parseSvEchoMessage(atLimitMsg);
	// We don't assert the value — just that it doesn't throw
	assert(true, `at-limit payload handled without throwing (result: ${result === null ? "null" : "bytes"})`);
}

console.log("\n--- Test 10: invalid base64 in sv field ---");
{
	const badB64 = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: "not-valid-base64!!!" });
	assert(parseSvEchoMessage(badB64) === null, "invalid base64 in sv => null");
}

console.log("\n--- Test 11: decoded-but-invalid state vectors are rejected ---");
{
	const zeroBytes = JSON.stringify({ type: "yaos/sv-echo", schema: 1, sv: encodeBytesBase64(new Uint8Array(0)) });
	assert(parseSvEchoMessage(zeroBytes) === null, "zero-byte decoded SV => null");

	const garbage = JSON.stringify({
		type: "yaos/sv-echo",
		schema: 1,
		sv: encodeBytesBase64(new TextEncoder().encode("garbage")),
	});
	assert(parseSvEchoMessage(garbage) === null, "base64 garbage decoded SV => null");
}

console.log("\n--- Test 12: makeSvEchoMessage + parseSvEchoMessage round-trip ---");
{
	const sv = makeStateVector("round trip");
	const msg = makeSvEchoMessage(sv);
	const result = parseSvEchoMessage(msg);
	assert(result !== null, "full round-trip: not null");
	assert(result !== null && arraysEqual(result, sv), "full round-trip: bytes match");

	// Valid empty Yjs state vector is encoded as [0], not zero bytes.
	const emptyDoc = new Y.Doc();
	const emptySv = Y.encodeStateVector(emptyDoc);
	emptyDoc.destroy();
	const emptyMsg = makeSvEchoMessage(emptySv);
	const emptyResult = parseSvEchoMessage(emptyMsg);
	assert(emptyResult !== null && arraysEqual(emptyResult, emptySv), "valid empty SV round-trip");
}

console.log("\n--- Test 13: detailed parser reports reasons and counters ---");
{
	const validSv = makeStateVector("detailed parser");
	const encoded = encodeBytesBase64(validSv);
	const valid = parseSvEchoMessageDetailed(makeSvEchoMessage(validSv));
	const wrongType = parseSvEchoMessageDetailed(JSON.stringify({ type: "other/sv-echo", schema: 1, sv: encoded }));
	const wrongSchema = parseSvEchoMessageDetailed(JSON.stringify({ type: "yaos/sv-echo", schema: 2, sv: encoded }));
	const oversized = parseSvEchoMessageDetailed(JSON.stringify({
		type: "yaos/sv-echo",
		schema: 1,
		sv: "A".repeat(MAX_SV_ECHO_BASE64_BYTES + 1),
	}));
	const invalidSv = parseSvEchoMessageDetailed(JSON.stringify({
		type: "yaos/sv-echo",
		schema: 1,
		sv: encodeBytesBase64(new TextEncoder().encode("garbage")),
	}));

	assert(valid.kind === "valid_sv_echo", "detailed valid echo => valid_sv_echo");
	assert(wrongType.kind === "not_sv_echo", "detailed wrong type => not_sv_echo");
	assert(wrongSchema.kind === "invalid_sv_echo" && wrongSchema.reason === "wrong_schema", "detailed wrong schema reason");
	assert(oversized.kind === "invalid_sv_echo" && oversized.reason === "oversize", "detailed oversize reason");
	assert(invalidSv.kind === "invalid_sv_echo" && invalidSv.reason === "invalid_state_vector", "detailed invalid SV reason");

	const counters = createSvEchoCounters();
	for (const result of [valid, wrongType, oversized, invalidSv]) {
		recordSvEchoParseResult(counters, result);
	}
	assert(counters.customMessageSeenCount === 4, "counters: custom messages seen count");
	assert(counters.svEchoSeenCount === 3, "counters: sv-echo seen count excludes wrong type");
	assert(counters.acceptedCount === 1, "counters: accepted count");
	assert(counters.rejectedCount === 2, "counters: rejected count excludes wrong type");
	assert(counters.rejectedOversizeCount === 1, "counters: oversize rejected count");
	assert(counters.rejectedInvalidCount === 1, "counters: invalid rejected count");
	assert(counters.bytesMax > 0, "counters: max bytes recorded");
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(55)}\n`);

process.exit(failed > 0 ? 1 : 0);
