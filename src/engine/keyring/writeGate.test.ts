/** The write gate's port wrappers (e2ee-design §9.3, §12.4): no seal and no blob upload while it is shut. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import type { KeyMissingReason } from "../../protocol/status";
import { KeyMissingError, assertWritable, gatedBlob, gatedCrypto, keyringCryptoOf } from "./writeGate";
import { device } from "./testkit/world";

const ADDR = "a".repeat(64) as BlobAddress;

function memBlob(): BlobPort & { puts: number } {
	const m = new Map<BlobAddress, Uint8Array>();
	const b = {
		maxBlobBytes: 1 << 20,
		puts: 0,
		has: async (as: readonly BlobAddress[]) => new Set(as.filter((a) => m.has(a))),
		put: async (a: BlobAddress, bytes: Uint8Array) => void (b.puts++, m.set(a, bytes)),
		get: async (a: BlobAddress) => m.get(a) ?? null,
	};
	return b;
}

describe("write gate", () => {
	it("seal and sealBlob refuse while shut (nothing reaches the inner port, no seal is counted); open still works", async () => {
		let reason: KeyMissingReason | null = "no-key";
		let seals = 0;
		const inner = createNoopCrypto(createWebHash());
		const c = gatedCrypto(inner, () => reason, () => seals++);
		const input = { purpose: "frame" as const, keyEpoch: 0, aad: new Uint8Array(1), plaintext: new Uint8Array([1, 2]) };
		await assert.rejects(c.seal(input), (e: unknown) => e instanceof KeyMissingError && e.reason === "no-key");
		await assert.rejects(c.sealBlob({ address: ADDR, plaintext: new Uint8Array(3) }), KeyMissingError);
		assert.equal(seals, 0);
		reason = null;
		const sealed = await c.seal(input);
		assert.equal(seals, 1);
		reason = "encrypted-vault";
		assert.equal((await c.open({ purpose: "frame", suite: 0, keyEpoch: 0, aad: input.aad, sealed })).ok, true, "reading is allowed");
	});

	it("blob put refuses while shut; has and get pass; no blob port stays null", async () => {
		let reason: KeyMissingReason | null = "revoked-epoch";
		const inner = memBlob();
		const b = gatedBlob(inner, () => reason)!;
		await assert.rejects(b.put(ADDR, new Uint8Array(1)), KeyMissingError);
		assert.equal(inner.puts, 0);
		assert.deepEqual([...(await b.has([ADDR]))], []);
		assert.equal(await b.get(ADDR), null);
		reason = null;
		await b.put(ADDR, new Uint8Array(1));
		assert.equal(inner.puts, 1);
		assert.equal(gatedBlob(null, () => null), null);
	});

	it("assertWritable names the reason; keyringCryptoOf tells the suite-1 adapter from the noop one", async () => {
		assert.throws(() => assertWritable(() => "no-pin"), /key-missing: no-pin/);
		assert.doesNotThrow(() => assertWritable(() => null));
		assert.equal(keyringCryptoOf(createNoopCrypto(createWebHash())), null);
		assert.ok(keyringCryptoOf((await device()).kc));
	});
});
