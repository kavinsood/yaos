import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocId, VaultPath } from "../../core/types";
import { sha256HexRef } from "../../core/hash/testkit/hashRef";
import { World } from "./testkit/world";

const P = (s: string): VaultPath => s;
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

/**
 * Approving a planner brake whose held units include attachment fetches (sim storms seed 17, fixed in 4624a57c).
 *
 * The pass that releases the approved units only *starts* the downloads (fetchBlob answers "inflight"); the bytes
 * are written by a later pass over the same docs, which plans the same shrinking overwrites again. The approval
 * must still stand for that pass: dropping it on the releasing (unbraked) pass re-held the fetches, the downloaded
 * bytes went stale (endPass) and the same report came back, to be approved again forever.
 */
test("brake approval: approved blob fetches still in flight are not re-held; a new mass change still brakes", async () => {
	const w = new World({ brake: { minCount: 2, ratio: 0, overwriteMinBytes: 10, overwriteShrinkRatio: 0.5 } });
	await w.boot();
	const names = ["a", "b", "c"].map((n) => `${n}.png`);
	const ids: DocId[] = names.map((p, i) => {
		const b = fill(32, i + 1);
		w.blobs!.put(b);
		return w.log.remoteCreate(P(p), b);
	});
	await w.sync();
	for (const [i, p] of names.entries()) assert.deepEqual(w.vault.bytesOf(p), fill(32, i + 1));

	const fetched = w.blobs!.downloads.length;
	// A mass shrinking overwrite from a remote device: every file becomes a few bytes.
	const small = ids.map((id, i) => {
		const b = fill(2, 0x10 + i);
		w.blobs!.put(b);
		w.log.remoteSetBlob(id, b);
		return b;
	});
	const braked = await w.r.pass();
	assert.equal(braked.brake?.reason, "mass-overwrite");
	assert.equal(braked.brake?.heldCount, 3);
	assert.equal(w.blobs!.downloads.length, fetched, "held: nothing fetched");
	const report = braked.brake;
	const brakesBefore = w.brakes.length;

	w.r.approveBrake(report.id);
	const released = await w.r.pass();
	assert.equal(released.brake, null, "approved units released");
	assert.equal(released.transferring, 3, "the fetches run in the background: still in flight after the releasing pass");
	assert.equal(w.blobs!.inFlight, 3);
	assert.deepEqual(w.vault.bytesOf("a.png"), fill(32, 1), "nothing written yet");

	// A pass while the downloads are still running: the same units are planned again and must not brake.
	const during = await w.r.pass();
	assert.equal(during.brake, null, "an in-flight approved fetch is not re-held");

	// The downloads land; the next passes take them and write the files.
	assert.equal(await w.blobs!.settle(), 3);
	const after = await w.r.pass();
	assert.equal(after.brake, null, "the same report does not come back once the bytes arrived");
	await w.sync();
	for (const [i, p] of names.entries()) assert.deepEqual(w.vault.bytesOf(p), small[i], `${p} written`);
	for (const [i, id] of ids.entries()) assert.equal(w.synced(id)!.contentHash, sha256HexRef(small[i]!));
	assert.equal(w.brakes.length, brakesBefore, "no second brake report: one approval was enough");
	assert.deepEqual(w.blobs!.dropped, [], "no downloaded bytes went stale");
	assert.equal(w.blobs!.downloads.length, fetched + 3, "each blob fetched once");

	// Keeping the approval approves nothing else: a different mass change (other docs, other hashes) still brakes.
	const more = ["d", "e", "f"].map((n) => `${n}.png`);
	const moreIds = more.map((p, i) => {
		const b = fill(40, 0x20 + i);
		w.blobs!.put(b);
		return w.log.remoteCreate(P(p), b);
	});
	await w.sync();
	assert.equal(w.brakes.length, brakesBefore, "plain creates do not brake");
	for (const [i, id] of moreIds.entries()) {
		const b = fill(1, 0x30 + i);
		w.blobs!.put(b);
		w.log.remoteSetBlob(id, b);
	}
	await w.sync();
	const second = w.brakes.at(-1)!;
	assert.equal(w.brakes.length, brakesBefore + 1, "the new mass change trips the brake");
	assert.equal(second.reason, "mass-overwrite");
	assert.notEqual(second.id, report.id);
	assert.deepEqual(second.samplePaths, more);
	for (const [i, p] of more.entries()) assert.deepEqual(w.vault.bytesOf(p), fill(40, 0x20 + i), `${p} held`);
});
