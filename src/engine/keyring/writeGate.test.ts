/** The write gate's port wrappers (e2ee-design §9.3, §12.4): no seal and no blob upload while it is shut. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobAddress } from "../../ports/crypto";
import { SimBlobStore } from "../../sim/blobStore";
import { createNoopCrypto } from "../adapters/noopCrypto";
import { createWebHash } from "../adapters/webHash";
import type { KeyMissingReason } from "../../protocol/status";
import { KeyMissingError, assertWritable, gatedBlob, gatedCrypto, keyringCryptoOf } from "./writeGate";
import { device } from "./testkit/world";

const ADDR = "a".repeat(64) as BlobAddress;

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

	it("blob put and GC delete refuse while shut; has, get and list pass; no blob port stays null", async () => {
		let reason: KeyMissingReason | null = null;
		let t = 0;
		const inner = new SimBlobStore({ now: () => t });
		const b = gatedBlob(inner, () => reason)!;
		await b.put(ADDR, [new Uint8Array(1)]);
		t = 10;
		reason = "revoked-epoch";
		await assert.rejects(b.put(ADDR, [new Uint8Array(2)]), KeyMissingError);
		await assert.rejects(b.deleteIfUploadedBefore([ADDR], 5), KeyMissingError);
		assert.equal(inner.calls.put, 1);
		assert.equal(inner.calls.delete, 0);
		assert.deepEqual([...(await b.has([ADDR]))], [ADDR]);
		assert.deepEqual(await b.get(ADDR), new Uint8Array(1));
		assert.deepEqual((await b.list(null)).items.map((i) => i.address), [ADDR]);
		reason = null;
		assert.deepEqual(await b.deleteIfUploadedBefore([ADDR], 5), [{ address: ADDR, result: "deleted", uploadedAt: 0 }]);
		assert.equal(inner.objects.size, 0);
		assert.equal(gatedBlob(null, () => null), null);
	});

	it("assertWritable names the reason; keyringCryptoOf tells the suite-1 adapter from the noop one", async () => {
		assert.throws(() => assertWritable(() => "no-pin"), /key-missing: no-pin/);
		assert.doesNotThrow(() => assertWritable(() => null));
		assert.equal(keyringCryptoOf(createNoopCrypto(createWebHash())), null);
		assert.ok(keyringCryptoOf((await device()).kc));
	});
});
