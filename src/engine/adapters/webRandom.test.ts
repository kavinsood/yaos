import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWebRandom } from "./webRandom";

describe("webRandom", () => {
	it("returns the requested number of bytes, beyond the 64 KiB getRandomValues cap", () => {
		const random = createWebRandom();
		assert.equal(random.bytes(0).byteLength, 0);
		assert.equal(random.bytes(16).byteLength, 16);
		const big = random.bytes(200_000);
		assert.equal(big.byteLength, 200_000);
		assert.ok(big.subarray(150_000).some((b) => b !== 0), "tail is filled");
	});

	it("float is in [0, 1)", () => {
		const random = createWebRandom();
		for (let i = 0; i < 1000; i++) {
			const f = random.float();
			assert.ok(f >= 0 && f < 1);
		}
		const max = createWebRandom({ getRandomValues: <T extends ArrayBufferView | null>(a: T): T => {
			if (a instanceof Uint32Array) a.fill(0xffffffff);
			return a;
		} });
		assert.ok(max.float() < 1);
	});
});
