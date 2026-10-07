/**
 * SnapshotJob, local side (DESIGN §j.4): streaming multi-part export, retention, lookups, restore through the
 * conflict-copy + CAS flow, and fail-closed `content_corrupt` on a damaged local snapshot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { fingerprintRef } from "../../core/hash/testkit/hashRef";
import { parseSnapshotId, snapshotId, type SnapRecord, decodeSnapRecord } from "../../core/snap/record";
import type { SnapManifest } from "../../core/snap/bundle";
import { ProtocolFailure } from "../../protocol/errors";
import { SNAPSHOT_EVENT_KEEP } from "./snapshotJob";
import { DAY, P, device, noise } from "./testkit/snapKit";

const concat = (parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
};

test("export: multi-part zip (parts of partBytes) + descriptor; md/canvas/small blobs; big blobs and invalid files left out", async () => {
	const { w, side, job } = device({ partBytes: 16 * 1024 });
	w.vault.userWrite("a.md", "# A\n");
	w.vault.userWrite("d/b.canvas", "{\"nodes\":[],\"edges\":[]}");
	w.vault.userWrite("img/small.png", noise(40_000, 3));
	w.vault.userWrite("img/big.png", new Uint8Array(1024 * 1024 + 1));
	w.vault.userWrite("ünï/cödé.md", "x");
	w.vault.userWrite("bad.canvas", "{not json");
	const res = (await job.take("manual"))!;
	assert.equal(parseSnapshotId(res.id)?.reason, "manual");
	assert.equal(res.upload, null, "no blob store");
	const record = decodeSnapRecord(side.files.get(`snapshots/${res.id}.snap`)!) as SnapRecord;
	const parts = side.names(".part").map((n) => side.files.get(n)!);
	assert.ok(parts.length >= 3, `${parts.length} parts`);
	assert.deepEqual(parts.slice(0, -1).map((p) => p.length), parts.slice(0, -1).map(() => 16 * 1024), "every part but the last is exactly partBytes");
	assert.deepEqual(record.parts.map((p) => p.size), parts.map((p) => p.length));
	const zip = unzipSync(concat(parts));
	const m = JSON.parse(strFromU8(zip["manifest.json"]!)) as SnapManifest;
	assert.deepEqual(m.files.map((f) => f.path).sort(), ["a.md", "d/b.canvas", "img/small.png", "ünï/cödé.md"]);
	for (const f of m.files) {
		assert.deepEqual(zip[`files/${f.path}`], w.vault.bytesOf(f.path));
		assert.equal(f.hash, fingerprintRef(w.vault.bytesOf(f.path)!));
	}
	assert.deepEqual(m.skipped, [{ path: "bad.canvas", reason: "invalid" }]);
	assert.equal(zip["files/img/big.png"], undefined);
	assert.deepEqual((await job.list()).map((s) => [s.id, s.files, s.where]), [[res.id, 4, "local"]]);
	assert.deepEqual((await job.manifest(res.id)).files.map((f) => f.path), m.files.map((f) => f.path));
});

test("over 256 MiB is skipped with a notice; disabled skips all but manual and the pre-restore one", async () => {
	const big = device({ files: () => [{ path: P("huge.md"), kind: "markdown", size: 300 * 1024 * 1024 }] });
	assert.equal(await big.job.take("brake"), null);
	assert.deepEqual(big.notices.map((n) => n.code), ["snapshot-too-large"]);
	assert.equal(big.side.files.size, 0);
	const off = device({ enabled: false });
	off.w.vault.userWrite("a.md", "a");
	assert.equal(await off.job.take("daily"), null);
	assert.equal(await off.job.take("brake"), null);
	const manual = (await off.job.take("manual"))!;
	off.w.clock.advance(1000);
	await off.job.restore(manual.id, null);
	assert.deepEqual((await off.job.list()).map((s) => s.reason), ["manual", "restore"], "restore saves a safety snapshot even when snapshots are off");
});

test("remove and lookups: malformed or unknown ids are bad requests; remove deletes only that snapshot", async () => {
	const { w, side, job } = device();
	w.vault.userWrite("a.md", "a");
	const one = (await job.take("manual"))!;
	w.clock.advance(1000);
	const two = (await job.take("manual"))!;
	const badRequest = (re: RegExp) => (e: unknown) => (e as { error?: { code?: string } }).error?.code === "bad-request" && re.test(String(e));
	for (const id of ["../outbox-a.bin", "x", `${one.id}/../../y`, "", "dl", `dev-A-0000000000000/${one.id}`, `${one.id}@dev-A-0000000000000`]) {
		await assert.rejects(job.remove(id), badRequest(/not a snapshot id|not found/), id);
		await assert.rejects(job.restore(id, null), badRequest(/not a snapshot id|not found/), id);
		await assert.rejects(job.manifest(id), badRequest(/not a snapshot id|not found/), id);
	}
	const unknown = snapshotId(5, "daily");
	await assert.rejects(job.remove(unknown), badRequest(/not found/));
	await assert.rejects(job.manifest(unknown), badRequest(/not found/));
	await job.remove(one.id);
	assert.deepEqual([...side.files.keys()].filter((k) => !k.includes(two.id)), []);
	await assert.rejects(job.remove(one.id), badRequest(/not found/), "already removed");
});

test("retention: keepDaily newest dailies, a bounded number of event snapshots; daily at most once per 24 h; leftovers swept", async () => {
	const { w, side, job } = device({ keepDaily: 2 });
	w.vault.userWrite("a.md", "a");
	await side.write("snapshots/0000000ab-manual-p000.part", new Uint8Array(3));
	await side.write("snapshots/dl-p000.part", new Uint8Array(3));
	const ids: string[] = [];
	for (let d = 0; d < 4; d++) {
		ids.push((await job.maybeDaily())!);
		assert.equal(await job.maybeDaily(), null, "second call the same day");
		w.clock.advance(DAY);
	}
	for (let i = 0; i < SNAPSHOT_EVENT_KEEP + 2; i++) { await job.take("brake"); w.clock.advance(1000); }
	const left = side.names(".snap").map((k) => k.slice(10, -5));
	assert.deepEqual(left.filter((id) => id.endsWith("-daily")), ids.slice(2));
	assert.equal(left.filter((id) => id.endsWith("-brake")).length, SNAPSHOT_EVENT_KEEP);
	assert.deepEqual(side.names(".part").filter((n) => !left.some((id) => n.startsWith(`snapshots/${id}-p`))), [], "orphan and download parts swept");
});

test("restore: differing file conflict-copied then restored, deleted file recreated, unchanged skipped; changes sync", async () => {
	const { w, job } = device();
	w.vault.userWrite("a.md", "original a\n");
	w.vault.userWrite("b.md", "original b\n");
	w.vault.userWrite("c.md", "same c\n");
	await w.boot();
	await w.sync();
	const snap = (await job.take("manual"))!;
	w.vault.userWrite("a.md", "edited a\n");
	w.vault.userDelete("b.md");
	await w.sync();
	w.clock.advance(60_000);
	const r = await job.restore(snap.id, null);
	assert.deepEqual([...r.restored].sort(), ["a.md", "b.md"]);
	assert.deepEqual(r.unchanged, ["c.md"]);
	assert.equal(r.copies.length, 1);
	assert.match(r.copies[0]!, /^a \(conflict laptop \d{4}-\d\d-\d\d \d{4}\)\.md$/);
	assert.equal(w.vault.text(r.copies[0]!), "edited a\n");
	assert.equal(w.vault.text("a.md"), "original a\n");
	assert.equal(w.vault.text("b.md"), "original b\n");
	assert.ok((await job.list()).some((s) => s.reason === "restore"), "a restore snapshot is taken first");
	await w.sync();
	assert.equal(w.log.text(w.log.liveByPath(P("a.md"))!), "original a\n");
	assert.equal(w.log.text(w.log.liveByPath(P(r.copies[0]!))!), "edited a\n");
});

test("restore: subset of paths; a file edited between read and write is not clobbered", async () => {
	const { w, job } = device();
	w.vault.userWrite("a.md", "A0\n");
	w.vault.userWrite("b.md", "B0\n");
	const snap = (await job.take("manual"))!;
	w.vault.userWrite("a.md", "A1\n");
	w.vault.userWrite("b.md", "B1\n");
	w.gateway.beforeOp = (op) => {
		if (op.t === "write" && op.path === "a.md") w.vault.userWrite("a.md", "A2 racing edit\n");
	};
	const r = await job.restore(snap.id, [P("a.md")]);
	assert.deepEqual(r.failed, ["a.md"]);
	assert.equal(w.vault.text("a.md"), "A2 racing edit\n");
	assert.equal(w.vault.text(r.copies[0]!), "A1\n", "the copy still holds the pre-restore text");
	assert.equal(w.vault.text("b.md"), "B1\n", "not selected");
	w.gateway.beforeOp = null;
	assert.deepEqual((await job.restore(snap.id, [P("b.md")])).restored, ["b.md"]);
	assert.equal(w.vault.text("b.md"), "B0\n");
});

test("damaged local snapshot: content_corrupt (notice + diagnostic + failure naming the check), nothing written, no restore snapshot", async () => {
	for (const [damage, check] of [["flip", "part-hash"], ["cut", "part-size"], ["drop", "part-missing"], ["desc", "not found"]] as const) {
		const { w, side, job, notices, diags } = device({ partBytes: 4096 });
		w.vault.userWrite("a.md", "A0\n");
		w.vault.userWrite("b.png", noise(10_000, 9));
		const snap = (await job.take("manual"))!;
		w.vault.userWrite("a.md", "A1\n");
		const name = `snapshots/${snap.id}-p001.part`;
		const part = side.files.get(name)!;
		if (damage === "flip") part[100]! ^= 1;
		if (damage === "cut") side.files.set(name, part.subarray(0, 4000));
		if (damage === "drop") side.files.delete(name);
		if (damage === "desc") side.files.set(`snapshots/${snap.id}.snap`, side.files.get(`snapshots/${snap.id}.snap`)!.subarray(0, 10));
		const before = side.files.size;
		const err = await job.restore(snap.id, null).then(() => null, (e: unknown) => e);
		if (check === "not found") {
			assert.match(String(err), /not found/, "an undecodable descriptor is not a snapshot");
			continue;
		}
		assert.ok(err instanceof ProtocolFailure && err.error.code === "content_corrupt", `${damage}: ${String(err)}`);
		assert.match(err.error.message, new RegExp(`${snap.id}.*${check}`));
		assert.deepEqual(notices.map((n) => n.code), ["content_corrupt"]);
		assert.ok(diags.some((d) => d.startsWith(`content_corrupt snapshot=${snap.id} check=${check}`)), diags.join("\n"));
		assert.equal(w.vault.text("a.md"), "A1\n", "fail closed: nothing restored");
		assert.equal(side.files.size, before, "no restore snapshot was taken");
		await assert.rejects(job.manifest(snap.id), (e: unknown) => e instanceof ProtocolFailure && e.error.code === "content_corrupt");
	}
});
