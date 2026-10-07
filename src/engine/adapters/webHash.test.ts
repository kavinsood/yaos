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

	it("passes an ArrayBuffer-backed view to digest as is (no copy); copies only a SharedArrayBuffer-backed one", async () => {
		const seen: BufferSource[] = [];
		const real = globalThis.crypto.subtle;
		const subtle = { digest: (alg: AlgorithmIdentifier, data: BufferSource) => (seen.push(data), real.digest(alg, data)) } as SubtleCrypto;
		const hash = createWebHash(subtle);
		const view = new TextEncoder().encode("xxabcxx").subarray(2, 5);
		const abc = hex(await hash.sha256(view));
		assert.equal(seen[0], view);
		const shared = new Uint8Array(new SharedArrayBuffer(3));
		shared.set(view);
		assert.equal(hex(await hash.sha256(shared)), abc);
		assert.ok(seen[1] instanceof Uint8Array && seen[1].buffer instanceof ArrayBuffer && seen[1] !== shared);
	});
});
