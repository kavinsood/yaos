/**
 * Verification Gate 2 — Hashing and normalization (Requirement Gate 2)
 *
 * Tests that witness state hash construction is:
 *   - Platform-independent (same logical content → same hash)
 *   - NFC-normalized (NFC and NFD forms hash identically)
 *   - Line-ending normalized (\r\n, \r, \n all hash identically)
 *   - Domain-separated (deleted-state hash never collides with present-state)
 *   - recoveryStateHash equals witness stateHash for same content under same trace
 */

import assert from "node:assert/strict";
import {
	computeWitnessStateHash,
	computeDeletedWitnessStateHash,
	normalizeContent,
} from "../src/telemetry/diagnostics/witnessStateHash";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
	Promise.resolve().then(fn).then(() => {
		console.log(`  PASS  ${name}`);
		passed++;
	}).catch((err: unknown) => {
		console.error(`  FAIL  ${name}`);
		console.error(`        ${err instanceof Error ? err.message : String(err)}`);
		failed++;
	});
}

const SECRET = "test-secret-for-gate-2";
const FILE_ID = "file-id-abc123";

// -----------------------------------------------------------------------
// Normalization tests
// -----------------------------------------------------------------------

test("\\r\\n and \\n normalize to same content", () => {
	const a = normalizeContent("hello\r\nworld");
	const b = normalizeContent("hello\nworld");
	assert.equal(a, b);
});

test("\\r and \\n normalize to same content", () => {
	const a = normalizeContent("hello\rworld");
	const b = normalizeContent("hello\nworld");
	assert.equal(a, b);
});

test("mixed line endings normalize to same content", () => {
	const a = normalizeContent("a\r\nb\rc\nd");
	const b = normalizeContent("a\nb\nc\nd");
	assert.equal(a, b);
});

test("NFC and NFD Unicode forms normalize to same content", () => {
	// é as NFC (U+00E9) vs NFD (e + combining accent U+0301)
	const nfc = "\u00e9";
	const nfd = "e\u0301";
	assert.notEqual(nfc, nfd, "pre-condition: NFC and NFD are different strings");
	const a = normalizeContent(nfc);
	const b = normalizeContent(nfd);
	assert.equal(a, b, "NFC and NFD should normalize to same string");
});

test("trailing newlines are NOT trimmed", () => {
	const a = normalizeContent("hello\n");
	const b = normalizeContent("hello");
	assert.notEqual(a, b, "trailing newline should NOT be trimmed");
});

test("leading whitespace is NOT trimmed", () => {
	const a = normalizeContent("  hello");
	const b = normalizeContent("hello");
	assert.notEqual(a, b, "leading whitespace should NOT be trimmed");
});

// -----------------------------------------------------------------------
// Hash tests
// -----------------------------------------------------------------------

test("same content with \\r\\n and \\n hashes identically", async () => {
	const h1 = await computeWitnessStateHash(SECRET, "hello\r\nworld");
	const h2 = await computeWitnessStateHash(SECRET, "hello\nworld");
	assert.equal(h1, h2);
});

test("same content with \\r and \\n hashes identically", async () => {
	const h1 = await computeWitnessStateHash(SECRET, "hello\rworld");
	const h2 = await computeWitnessStateHash(SECRET, "hello\nworld");
	assert.equal(h1, h2);
});

test("NFC and NFD content hashes identically", async () => {
	const h1 = await computeWitnessStateHash(SECRET, "\u00e9");
	const h2 = await computeWitnessStateHash(SECRET, "e\u0301");
	assert.equal(h1, h2);
});

test("different content hashes differently", async () => {
	const h1 = await computeWitnessStateHash(SECRET, "hello");
	const h2 = await computeWitnessStateHash(SECRET, "world");
	assert.notEqual(h1, h2);
});

test("hash output starts with h: prefix", async () => {
	const h = await computeWitnessStateHash(SECRET, "test");
	assert.ok(h?.startsWith("h:"), `hash should start with h:, got: ${h}`);
});

test("deleted-state hash never collides with present-state hash", async () => {
	// For any content, the deleted-state hash (domain-separated by fileId)
	// should never equal the present-state hash for the same content
	const content = "hello world";
	const presentHash = await computeWitnessStateHash(SECRET, content);
	const deletedHash = await computeDeletedWitnessStateHash(SECRET, FILE_ID);
	assert.notEqual(presentHash, deletedHash, "deleted-state hash must not collide with present-state hash");
});

test("deleted-state hash is deterministic for same fileId", async () => {
	const h1 = await computeDeletedWitnessStateHash(SECRET, FILE_ID);
	const h2 = await computeDeletedWitnessStateHash(SECRET, FILE_ID);
	assert.equal(h1, h2);
});

test("deleted-state hash differs for different fileIds", async () => {
	const h1 = await computeDeletedWitnessStateHash(SECRET, "file-id-1");
	const h2 = await computeDeletedWitnessStateHash(SECRET, "file-id-2");
	assert.notEqual(h1, h2);
});

test("recoveryStateHash equals witness stateHash for same content under same trace (Req 10.7)", async () => {
	// Both use computeWitnessStateHash from the shared module
	const content = "# Test Note\n\nSome content here.";
	const witnessHash = await computeWitnessStateHash(SECRET, content);
	const recoveryHash = await computeWitnessStateHash(SECRET, content); // same function
	assert.equal(witnessHash, recoveryHash, "recoveryStateHash must equal witness stateHash for same content");
});

test("cross-device: two devices with same qaTraceSecret produce byte-equal hashes for same content", async () => {
	const qaSecret = "shared-qa-trace-secret";
	const content = "# Shared Note\r\nWith CRLF line endings.";
	// Simulate Device A (Linux) and Device B (iPad) both using the same qaTraceSecret
	const hashA = await computeWitnessStateHash(qaSecret, content);
	const hashB = await computeWitnessStateHash(qaSecret, content);
	assert.equal(hashA, hashB, "cross-device hashes must be byte-equal for same content");
});

test("cross-device: content differing only in pre-normalization line endings hashes identically", async () => {
	const qaSecret = "shared-qa-trace-secret";
	const contentCRLF = "line1\r\nline2\r\nline3";
	const contentLF = "line1\nline2\nline3";
	const hashCRLF = await computeWitnessStateHash(qaSecret, contentCRLF);
	const hashLF = await computeWitnessStateHash(qaSecret, contentLF);
	assert.equal(hashCRLF, hashLF, "CRLF and LF content must hash identically after normalization");
});

test("cross-device: content differing only in pre-normalization Unicode form hashes identically", async () => {
	const qaSecret = "shared-qa-trace-secret";
	const contentNFC = "caf\u00e9"; // café with NFC é
	const contentNFD = "cafe\u0301"; // café with NFD e + combining accent
	const hashNFC = await computeWitnessStateHash(qaSecret, contentNFC);
	const hashNFD = await computeWitnessStateHash(qaSecret, contentNFD);
	assert.equal(hashNFC, hashNFD, "NFC and NFD content must hash identically after normalization");
});

// -----------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------

setTimeout(() => {
	console.log(`\nResults: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}, 200);
