import {
	CHUNK_BYTES,
	splitBytes,
	concatChunks,
	chunkCountForSize,
} from "../server/src/blobChunk";

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

function assertEqual<T>(actual: T, expected: T, msg: string) {
	assert(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}

// --- small payload (< 1 MiB) ---
{
	const bytes = new Uint8Array([1, 2, 3, 4, 5]);
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 1, "small payload is one chunk");
	assertEqual(chunks[0]!.byteLength, 5, "small chunk length");
	const roundTrip = concatChunks(chunks);
	assert(roundTrip.every((b, i) => b === bytes[i]!), "small round-trip");
}

// --- exactly 1 MiB ---
{
	const bytes = new Uint8Array(CHUNK_BYTES);
	bytes[0] = 7;
	bytes[CHUNK_BYTES - 1] = 9;
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 1, "exactly 1 MiB is one chunk");
	assertEqual(concatChunks(chunks).byteLength, CHUNK_BYTES, "1 MiB round-trip length");
}

// --- 1 MiB + 1 byte ---
{
	const bytes = new Uint8Array(CHUNK_BYTES + 1);
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 2, "1 MiB + 1 splits into two chunks");
	assertEqual(chunks[0]!.byteLength, CHUNK_BYTES, "first chunk is full MiB");
	assertEqual(chunks[1]!.byteLength, 1, "second chunk is 1 byte");
}

// --- 10 MiB (max upload) ---
{
	const size = 10 * 1024 * 1024;
	assertEqual(chunkCountForSize(size), 10, "10 MiB needs 10 chunks");
	const bytes = new Uint8Array(size);
	bytes[0] = 42;
	bytes[size - 1] = 99;
	const chunks = splitBytes(bytes);
	assertEqual(chunks.length, 10, "10 MiB splits into 10 chunks");
	const rt = concatChunks(chunks);
	assertEqual(rt[0], 42, "10 MiB round-trip first byte");
	assertEqual(rt[size - 1], 99, "10 MiB round-trip last byte");
}

console.log(`\nblob-chunk: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
