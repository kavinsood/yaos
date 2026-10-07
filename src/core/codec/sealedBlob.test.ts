/**
 * Sealed-blob size arithmetic (e2ee-design §7.3, §10; WP-E6a): the suite-1 plaintext cap of a store, the
 * snapshot part size against it. blobStore.test.ts and
 * frames.test.ts check the same numbers on real seals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SNAP_DEFAULT_PART_BYTES, snapPartBytes } from "../snap/bundle";
import { padmeLen } from "./padme";
import { decodeBlobHeader, encodeBlobHeader, maxSealedBlobPlaintext, sealedBlobBytes } from "./sealedBlob";

const MIB = 1024 * 1024;
const MAX_EPOCH = Number.MAX_SAFE_INTEGER;

test("sealedBlobBytes: header (varuint epoch) + nonce + Padmé(n + 1) + tag", () => {
	assert.equal(sealedBlobBytes(0, 1), 3 + 12 + 256 + 16, "256-byte floor");
	assert.equal(sealedBlobBytes(255, 1), 3 + 12 + 256 + 16);
	assert.equal(sealedBlobBytes(256, 1), 3 + 12 + padmeLen(257) + 16);
	assert.equal(sealedBlobBytes(0, 128), 4 + 12 + 256 + 16, "two-byte epoch");
	assert.equal(encodeBlobHeader(1, MAX_EPOCH).length, 10, "BLOB_HEADER_MAX_BYTES");
	const h = decodeBlobHeader(new Uint8Array([...encodeBlobHeader(1, MAX_EPOCH), ...new Uint8Array(28)]));
	assert.ok(h.ok && h.keyEpoch === MAX_EPOCH);
});

test("maxSealedBlobPlaintext: largest n that seals within the cap at any epoch; the relay's 100 MB gives 47 x 2 MiB - 1", () => {
	const cap = 100_000_000; // MAX_BLOB_UPLOAD_BYTES, Cloudflare's request body limit (DECISIONS D9)
	const n = maxSealedBlobPlaintext(cap);
	assert.equal(n, 98_566_143);
	assert.equal(padmeLen(n + 1), 47 * 2 * MIB, "n + 1 is exactly 47 x 2 MiB");
	assert.equal(sealedBlobBytes(n, 1), 3 + 12 + 47 * 2 * MIB + 16);
	assert.ok(sealedBlobBytes(n, MAX_EPOCH) <= cap);
	assert.ok(sealedBlobBytes(n + 1, 1) > cap, "one more byte jumps to the next Padmé bucket");
	// Suite 1 has no cap of its own: a larger store fits more.
	assert.equal(maxSealedBlobPlaintext(10 * MIB), 10_223_615, "39 x 256 KiB - 1");
	assert.equal(maxSealedBlobPlaintext(200_000_000), 47 * 4 * MIB - 1, "a Business zone's 200 MB: 47 x 4 MiB - 1");
	assert.equal(maxSealedBlobPlaintext(10 + 28 + 255), -1, "not even the 256-byte floor fits");
	assert.equal(maxSealedBlobPlaintext(10 + 28 + 256), 255);
	// Exhaustive below 70 KB, sampled above: the result fits, the next byte does not.
	for (let c = 294; c <= 128 * MIB; c += c < 70_000 ? 1 : c < 16 * MIB ? 4093 : 1_048_573) {
		const m = maxSealedBlobPlaintext(c);
		assert.ok(sealedBlobBytes(m, MAX_EPOCH) <= c, `cap ${c}`);
		assert.ok(sealedBlobBytes(m + 1, MAX_EPOCH) > c, `cap ${c}: ${m} is the largest`);
	}
});

test("snapshot parts: min(8 MiB, 7/8 cap); a full part sealed under suite 1 fits the cap for every cap >= 422 B", () => {
	assert.equal(snapPartBytes(null), SNAP_DEFAULT_PART_BYTES);
	assert.equal(snapPartBytes(10 * MIB), 8 * MIB);
	assert.equal(sealedBlobBytes(8 * MIB, 1), 8_650_783, "3 + 12 + 33 x 256 KiB + 16");
	assert.ok(sealedBlobBytes(8 * MIB, MAX_EPOCH) <= 10 * MIB);
	assert.ok(snapPartBytes(10 * MIB) <= maxSealedBlobPlaintext(10 * MIB));
	assert.equal(snapPartBytes(4 * MIB), 3.5 * MIB);
	for (let cap = 422; cap <= 64 * MIB; cap += cap < 70_000 ? 1 : 4093) {
		assert.ok(sealedBlobBytes(snapPartBytes(cap), MAX_EPOCH) <= cap, `cap ${cap}`);
	}
	assert.ok(sealedBlobBytes(snapPartBytes(421), MAX_EPOCH) > 421, "422 B is tight: below it the 1/8 slack does not cover the overhead");
});

