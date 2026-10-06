/**
 * SnapshotJob, remote side (DESIGN §j.4): parts through the attachments' blob path, resumable idempotent upload
 * with one index record, per-device retention floor, list merge, and cross-device restore that fails closed on
 * every fault a store (or someone tampering with it) can produce. Suite 1 (e2ee-design §10): parts sealed at their
 * keyed address within the store cap; only a deterministic open failure is corruption (§9.2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealedBlobBytes } from "../../core/codec/sealedBlob";
import { sha256Hex } from "../../core/hash/sha256";
import { snapPartBytes } from "../../core/snap/bundle";
import { snapLive } from "../../core/snap/fold";
import { snapKey } from "../../core/snap/record";
import type { BlobAddress } from "../../ports/crypto";
import { ProtocolFailure } from "../../protocol/errors";
import { SeededRandom } from "../../sim/random";
import { createWebCryptoSuite1 } from "../adapters/webCryptoSuite1";
import { SnapshotPartUnavailable } from "./remote";
import { DAY, DEV_A, DEV_B, FaultyStore, MemIndex, addressOf, device, noise, sealingCrypto } from "./testkit/snapKit";

function pair(o: { partBytes?: number; keepDaily?: number } = {}) {
	const store = new FaultyStore();
	const index = new MemIndex();
	const a = device({ label: "laptop", self: DEV_A, index, store, partBytes: o.partBytes ?? 4096, keepDaily: o.keepDaily ?? 7 });
	const b = device({ label: "phone", self: DEV_B, index, store, partBytes: o.partBytes ?? 4096 });
	a.w.vault.userWrite("notes/a.md", "# A\n\nfrom the laptop\n");
	a.w.vault.userWrite("board.canvas", "{\"nodes\":[],\"edges\":[]}");
	a.w.vault.userWrite("img/p.png", noise(20_000, 5));
	return { store, index, a, b };
}

const corrupt = (check: string) => (e: unknown) => e instanceof ProtocolFailure && e.error.code === "content_corrupt" && e.error.message.includes(check);

test("upload: every part sealed under its blob address, then one index record; a retry resumes; no duplicate records", async () => {
	const { store, index, a } = pair();
	store.failPut = (_addr, nth) => nth === 2;
	const first = (await a.job.take("manual"))!;
	assert.equal(first.upload, null, "the third part failed");
	assert.deepEqual(a.notices.map((n) => n.code), ["snapshot-upload-failed"]);
	assert.equal(index.puts(), 0, "no record before every part is stored");
	assert.equal((await a.job.list())[0]!.where, "local");
	store.failPut = null;
	a.settings.enabled = false; // no daily: the background retry picks the failed manual one
	a.w.clock.advance(30 * 60 * 1000);
	await a.job.maybeDaily();
	assert.equal(store.calls.put, 3, "background retry waits out the 1 h backoff");
	a.w.clock.advance(31 * 60 * 1000);
	await a.job.maybeDaily();
	assert.equal(index.puts(), 1);
	const record = index.state.records.get(snapKey(DEV_A, first.id))!.record;
	assert.ok(record.parts.length >= 4, `${record.parts.length} parts`);
	assert.equal(store.calls.put, 3 + record.parts.length - 2, "the two stored parts were not sent again");
	for (const p of record.parts) {
		assert.equal(p.address, addressOf(p.sha256), "address = CryptoPort.blobAddress(sha256)");
		const sealed = store.objects.get(p.address as BlobAddress)!;
		assert.notEqual(sha256Hex(sealed), p.sha256);
		const opened = await sealingCrypto.openBlob({ address: p.address as BlobAddress, sealed });
		assert.ok(opened.ok);
		assert.equal(sha256Hex(opened.plaintext), p.sha256, "stored sealed (sealBlob); opens to the part");
	}
	const before = index.submitted.length;
	await a.job.maybeDaily();
	a.w.clock.advance(2 * 60 * 60 * 1000);
	await a.job.maybeDaily();
	assert.equal(index.submitted.length, before, "already in the index: nothing appended");
	assert.equal(a.notices.length, 1);
});

test("upload waits for the index to be caught up; retention floor keeps the newest keepDaily uploads of this device", async () => {
	const { index, a } = pair({ keepDaily: 2 });
	index.ready = false;
	assert.equal((await a.job.take("manual"))!.upload, "not-ready");
	index.ready = true;
	const ids: string[] = [];
	for (let i = 0; i < 4; i++) { a.w.clock.advance(DAY); ids.push((await a.job.take("manual"))!.id); }
	const live = snapLive(index.state).map((e) => e.record.snapshotId).sort();
	assert.deepEqual(live, ids.slice(2), "a floor op dropped the older uploads");
	assert.ok((index.state.floors.get(DEV_A) ?? 0) > 0);
});

test("list merges local and remote; delete removes the local copy and appends a del; any device can delete a remote one", async () => {
	const { index, a, b } = pair();
	const s1 = (await a.job.take("manual"))!;
	a.w.clock.advance(1000);
	const s2 = (await a.job.take("manual"))!;
	assert.deepEqual((await a.job.list()).map((s) => [s.id, s.where]), [[s1.id, "both"], [s2.id, "both"]]);
	const onB = await b.job.list();
	assert.deepEqual(onB.map((s) => [s.id, s.where, s.device]), [[`${s1.id}@${DEV_A}`, "remote", "laptop"], [`${s2.id}@${DEV_A}`, "remote", "laptop"]]);
	await a.job.remove(s1.id);
	assert.equal(index.state.records.has(snapKey(DEV_A, s1.id)), false);
	assert.equal(a.side.names(".snap").length, 1);
	await b.job.remove(`${s2.id}@${DEV_A}`);
	assert.deepEqual((await a.job.list()).map((s) => [s.id, s.where]), [[s2.id, "local"]], "the local copy stays");
	assert.equal((await a.job.take("manual"))!.upload, "uploaded", "a new snapshot still uploads");
});

test("cross-device restore: a fresh device lists, verifies (download cache), restores; files match; cache removed", async () => {
	const { a, b } = pair();
	const s = (await a.job.take("manual"))!;
	const id = `${s.id}@${DEV_A}`;
	const m = await b.job.manifest(id);
	assert.deepEqual(m.files.map((f) => f.path).sort(), ["board.canvas", "img/p.png", "notes/a.md"]);
	assert.ok(b.side.names(".part").some((n) => n.startsWith("snapshots/dl-p")), "verified parts cached for the restore");
	const r = await b.job.restore(id, null);
	assert.deepEqual([...r.restored].sort(), ["board.canvas", "img/p.png", "notes/a.md"]);
	for (const p of ["board.canvas", "img/p.png", "notes/a.md"]) assert.deepEqual(b.w.vault.bytesOf(p), a.w.vault.bytesOf(p), p);
	assert.deepEqual(b.side.names(".part").filter((n) => n.startsWith("snapshots/dl-")), [], "download cache removed");
	assert.deepEqual((await b.job.restore(id, null)).unchanged.length, 3, "restoring again changes nothing");
});

test("cross-device restore through a faulting store: every fault is content_corrupt, fails closed, cache removed", async () => {
	const cases: [string, (store: FaultyStore, addr: BlobAddress[]) => void][] = [
		["part-missing", (st, ad) => { st.objects.delete(ad[1]!); }],
		["part-hash", (st, ad) => { st.objects.get(ad[2]!)![50]! ^= 4; }],
		["part-size", (st, ad) => { st.objects.set(ad[0]!, st.objects.get(ad[0]!)!.subarray(0, 100)); }],
		["part-hash", (st, ad) => { st.onGet = (x, bytes) => (x === ad[1] ? bytes.reverse() : bytes); }],
		["part-missing", (st, ad) => { st.onGet = (x, bytes) => (x === ad.at(-1) ? null : bytes); }],
	];
	for (const [check, fault] of cases) {
		const { store, index, a, b } = pair();
		const s = (await a.job.take("manual"))!;
		const addr = index.state.records.get(snapKey(DEV_A, s.id))!.record.parts.map((p) => p.address as BlobAddress);
		assert.ok(addr.length >= 4, `${addr.length} parts`);
		b.w.vault.userWrite("notes/a.md", "B's own text\n");
		fault(store, addr);
		await assert.rejects(b.job.restore(`${s.id}@${DEV_A}`, null), corrupt(check), check);
		assert.equal(b.w.vault.text("notes/a.md"), "B's own text\n");
		assert.deepEqual(b.w.vault.paths().sort(), ["notes/a.md"], "nothing written, no conflict copy");
		assert.deepEqual(b.side.names(".part"), [], "no download parts left");
		assert.equal(b.side.names(".snap").length, 0, "no restore snapshot before verification passed");
		assert.deepEqual(b.notices.map((n) => n.code), ["content_corrupt"]);
		assert.ok(b.diags.some((d) => d.startsWith(`content_corrupt snapshot=${s.id}@${DEV_A} check=${check}`)));
	}
});

test("store transport errors are not corruption: the request fails with the store error, no notice, cache removed", async () => {
	const { store, a, b } = pair();
	const s = (await a.job.take("manual"))!;
	let n = 0;
	store.onGet = (_x, bytes) => { if (++n === 2) throw new Error("blob get: network_error"); return bytes; };
	await assert.rejects(b.job.manifest(`${s.id}@${DEV_A}`), /network_error/);
	assert.deepEqual(b.notices, []);
	assert.deepEqual(b.side.names(".part"), []);
	store.onGet = null;
	assert.equal((await b.job.restore(`${s.id}@${DEV_A}`, null)).restored.length, 3);
});

// ---- Suite 1 (e2ee-design §10, WP-E6a) ----

const VAULT1 = "AAAAAAAAAAAAAAAAAAAAAA";
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i);
const K2 = Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i);

async function suite1(seed: number, keys: readonly { e: number; k: Uint8Array }[], verified: readonly number[], sealEpoch = 1) {
	const c = await createWebCryptoSuite1({ vaultId: VAULT1, random: new SeededRandom(seed), keys: keys.map(({ e, k }) => ({ e, k: k.slice() })) });
	for (const e of verified) c.markVerified(e);
	c.setSealEpoch(sealEpoch);
	return c;
}

test("suite 1: parts sealed at blobAddress(sha256), every stored object within maxBlobBytes; restore opens them; tampered at rest -> content_corrupt; reader-dependent -> no corruption notice", async () => {
	const both = [{ e: 1, k: K1 }, { e: 2, k: K2 }];
	const writer = await suite1(51, both, [1, 2], 2);
	const store = new FaultyStore(64 * 1024);
	const index = new MemIndex();
	const a = device({ label: "laptop", self: DEV_A, index, store, crypto: writer }); // part size: snapPartBytes(64 KiB) = 56 KiB
	a.w.vault.userWrite("notes/a.md", "# A\n\nsealed\n");
	a.w.vault.userWrite("img/p.png", noise(150_000, 9));
	const s = (await a.job.take("manual"))!;
	assert.equal(s.upload, "uploaded");
	const id = `${s.id}@${DEV_A}`;
	const record = index.state.records.get(snapKey(DEV_A, s.id))!.record;
	assert.ok(record.parts.length >= 3, `${record.parts.length} parts`);
	assert.equal(record.parts[0]!.size, snapPartBytes(store.maxBlobBytes), "a full part");
	for (const p of record.parts) {
		assert.equal(p.address, await writer.blobAddress(p.sha256));
		assert.notEqual(p.address, p.sha256);
		const sealed = store.objects.get(p.address as BlobAddress)!;
		assert.deepEqual([...sealed.subarray(0, 3)], [1, 1, 2], "blobFormat 1, suite 1, keyEpoch 2");
		assert.equal(sealed.length, sealedBlobBytes(p.size, 2));
		assert.ok(sealed.length <= store.maxBlobBytes, `${sealed.length} <= ${store.maxBlobBytes}`);
	}
	assert.equal(store.calls.put, record.parts.length);

	const reader = (seed: number, keys: readonly { e: number; k: Uint8Array }[], verified: readonly number[]) =>
		suite1(seed, keys, verified).then((crypto) => device({ label: "phone", self: DEV_B, index, store, crypto }));
	const b = await reader(52, both, [1, 2]);
	const r = await b.job.restore(id, null);
	assert.deepEqual([...r.restored].sort(), ["img/p.png", "notes/a.md"]);
	for (const p of ["img/p.png", "notes/a.md"]) assert.deepEqual(b.w.vault.bytesOf(p), a.w.vault.bytesOf(p), p);

	// Tampered at rest, key verified: deterministic -> content_corrupt, nothing written.
	const addr = record.parts[1]!.address as BlobAddress;
	const good = store.objects.get(addr)!;
	const bad = good.slice();
	bad[60]! ^= 1;
	store.objects.set(addr, bad);
	const c = await reader(53, both, [1, 2]);
	await assert.rejects(c.job.restore(id, null), corrupt("part-missing"));
	assert.deepEqual(c.notices.map((n) => n.code), ["content_corrupt"]);
	assert.deepEqual(c.w.vault.paths(), []);
	assert.deepEqual(c.side.names(".part"), [], "download cache removed");
	// The same bytes under a K_2 not verified yet: maybe this device's key is wrong, so not corruption.
	const d = await reader(54, both, [1]);
	await assert.rejects(d.job.restore(id, null), (e: unknown) => e instanceof SnapshotPartUnavailable && /part 2\/\d+ .*\(auth-failed\)/.test(e.message));
	assert.deepEqual(d.notices, []);
	assert.deepEqual(d.side.names(".part"), []);
	// Intact again, but this device does not hold K_2 (a re-key it has not read yet).
	store.objects.set(addr, good);
	const e2 = await reader(55, [{ e: 1, k: K1 }], [1]);
	await assert.rejects(e2.job.restore(id, null), /\(unknown-key\)/);
	assert.deepEqual(e2.notices, []);
	assert.deepEqual(e2.w.vault.paths(), []);
	assert.ok(!JSON.stringify([c.diags, d.diags, e2.diags]).includes(record.parts[1]!.sha256), "diagnostics never name a part hash");
});
