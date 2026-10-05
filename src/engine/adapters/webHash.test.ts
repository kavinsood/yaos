import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWebHash } from "./webHash";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("webHash", () => {
	it("computes SHA-256", async () => {
		const hash = createWebHash();
		assert.equal(hex(await hash.sha256(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		assert.equal(hex(await hash.sha256(new Uint8Array(0))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("hashes a view, not its whole buffer", async () => {
		const hash = createWebHash();
		const whole = new TextEncoder().encode("xxabcxx");
		assert.equal(hex(await hash.sha256(whole.subarray(2, 5))), hex(await hash.sha256(new TextEncoder().encode("abc"))));
	});
});
