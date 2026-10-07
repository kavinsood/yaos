import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BlobAddress } from "../ports/crypto";
import { SimBlobStore } from "./blobStore";

const addr = (i: number) => i.toString(16).padStart(64, "0") as BlobAddress;

describe("SimBlobStore", () => {
	it("lists in address order by the last address; deletes between pages do not move the walk", async () => {
		let t = 1000;
		const s = new SimBlobStore({ now: () => t, pageSize: 2 });
		for (const i of [5, 1, 4, 2, 3]) await s.put(addr(i), [new Uint8Array([i])]);
		const p1 = await s.list(null);
		assert.deepEqual(p1.items.map((x) => x.address), [addr(1), addr(2)]);
		assert.equal(p1.next, addr(2));
		await s.deleteIfUploadedBefore([addr(2), addr(3)], ++t);
		const p2 = await s.list(p1.next);
		assert.deepEqual(p2.items.map((x) => x.address), [addr(4), addr(5)]);
		assert.equal(p2.next, null);
	});

	it("a PUT refreshes uploadedAt (newer); a PUT in the HEAD -> delete window is deleted anyway", async () => {
		let t = 1000;
		const s = new SimBlobStore({ now: () => t });
		await s.put(addr(1), [new Uint8Array([1])]);
		await s.put(addr(2), [new Uint8Array([2])]);
		t = 2000;
		await s.put(addr(1), [new Uint8Array([1])]);
		assert.equal(s.uploadedAt(addr(1)), 2000);
		s.hooks.beforeDelete = async () => { await s.put(addr(2), [new Uint8Array([2])]); };
		const r = await s.deleteIfUploadedBefore([addr(1), addr(2), addr(3)], 1500);
		assert.deepEqual(r, [
			{ address: addr(1), result: "newer", uploadedAt: 2000 },
			{ address: addr(2), result: "deleted", uploadedAt: 1000 },
			{ address: addr(3), result: "absent" },
		]);
		assert.equal(s.objects.has(addr(2)), false, "re-PUT inside the window lost");
		assert.deepEqual(s.deleted, [addr(2)]);
	});
});
