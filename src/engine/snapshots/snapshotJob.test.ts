import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { exactFingerprint } from "../../core/hash/markdownLf";
import { kindOfPath, type ContentHash, type VaultPath } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { BlobAddress, CryptoPort } from "../../ports/crypto";
import type { SideFileName, SideFilePort } from "../../ports/vault";
import { World } from "../reconcile/testkit/world";
import { SNAPSHOT_EVENT_KEEP, SnapshotJob, parseSnapshotId, snapshotId, type SnapshotDeps, type SnapshotManifest } from "./snapshotJob";

class MemSide implements SideFilePort {
	readonly files = new Map<string, Uint8Array>();
	async read(n: SideFileName) { return this.files.get(n) ?? null; }
	async write(n: SideFileName, b: Uint8Array) { this.files.set(n, b.slice()); }
	async remove(n: SideFileName) { this.files.delete(n); }
	async list(prefix: "snapshots/") { return [...this.files.keys()].filter((k) => k.startsWith(prefix)) as SideFileName[]; }
}

const P = (s: string): VaultPath => s as VaultPath;
const DAY = 24 * 60 * 60 * 1000;

async function setup(opts: { keepDaily?: number; enabled?: boolean; upload?: SnapshotDeps["upload"]; files?: SnapshotDeps["files"] } = {}) {
	const w = new World();
	const side = new MemSide();
	const notices: string[] = [];
	const settings = { enabled: opts.enabled ?? true, keepDaily: opts.keepDaily ?? 7, uploadToBlobStore: opts.upload !== undefined };
	const job = new SnapshotJob({
		disk: w.gateway, side, clock: w.clock, settings: () => settings, upload: opts.upload ?? null, deviceLabel: "laptop",
		files: opts.files ?? (() => w.vault.paths().filter((p) => !p.startsWith(".")).map((p) => ({ path: P(p), kind: kindOfPath(P(p)), size: w.vault.bytesOf(p)!.length }))),
		notice: (_l, c) => notices.push(c),
	});
	return { w, side, job, notices, settings };
}

test("snapshot: zip of md/canvas + small blobs with a manifest; big blobs left out", async () => {
	const { w, side, job } = await setup();
	w.vault.userWrite("a.md", "# A\n");
	w.vault.userWrite("d/b.canvas", "{\"nodes\":[],\"edges\":[]}");
	w.vault.userWrite("img/small.png", new Uint8Array(1000).fill(7));
	w.vault.userWrite("img/big.png", new Uint8Array(1024 * 1024 + 1));
	w.vault.userWrite("ünï/cödé.md", "x");
	const res = await job.take("manual");
	assert.ok(res);
	assert.equal(parseSnapshotId(res.id)?.reason, "manual");
	const zip = unzipSync(side.files.get(`snapshots/${res.id}.zip`)!);
	const m = JSON.parse(strFromU8(zip["manifest.json"]!)) as SnapshotManifest;
	assert.deepEqual(m.files.map((f) => f.path).sort(), ["a.md", "d/b.canvas", "img/small.png", "ünï/cödé.md"]);
	for (const f of m.files) {
		assert.deepEqual(zip[`files/${f.path}`], w.vault.bytesOf(f.path));
		assert.equal(f.hash, exactFingerprint(w.vault.bytesOf(f.path)!));
	}
	assert.equal(zip["files/img/big.png"], undefined);
	assert.deepEqual((await job.list()).map((s) => [s.id, s.files]), [[res.id, 4]]);
});

test("snapshot: over 256 MiB is skipped with a notice; disabled skips all but manual and the pre-restore one", async () => {
	const big = await setup({ files: () => [{ path: P("huge.md"), kind: "markdown", size: 300 * 1024 * 1024 }] });
	assert.equal(await big.job.take("brake"), null);
	assert.deepEqual(big.notices, ["snapshot-too-large"]);
	assert.equal(big.side.files.size, 0);
	const off = await setup({ enabled: false });
	off.w.vault.userWrite("a.md", "a");
	assert.equal(await off.job.take("daily"), null);
	assert.equal(await off.job.take("brake"), null);
	const manual = (await off.job.take("manual"))!;
	assert.ok(manual);
	off.w.clock.advance(1000);
	await off.job.restore(manual.id, null);
	assert.deepEqual((await off.job.list()).map((s) => s.reason), ["manual", "restore"], "restore saves a safety snapshot even when snapshots are off");
});

test("remove and lookups: malformed or unknown ids are bad requests; remove deletes only that snapshot", async () => {
	const { w, side, job } = await setup();
	w.vault.userWrite("a.md", "a");
	const one = (await job.take("manual"))!;
	w.clock.advance(1000);
	const two = (await job.take("manual"))!;
	const badRequest = (re: RegExp) => (e: unknown) => (e as { error?: { code?: string } }).error?.code === "bad-request" && re.test(String(e));
	for (const id of ["../outbox-a.bin", "x", `${one.id}/../../y`, ""]) {
		await assert.rejects(job.remove(id), badRequest(/not a snapshot id/), id);
		await assert.rejects(job.restore(id, null), badRequest(/not a snapshot id/), id);
		await assert.rejects(job.manifest(id), badRequest(/not a snapshot id/), id);
	}
	const unknown = snapshotId(5, "daily");
	await assert.rejects(job.remove(unknown), badRequest(/not found/));
	await assert.rejects(job.restore(unknown, null), badRequest(/not found/));
	assert.equal(await job.manifest(unknown), null);
	await job.remove(one.id);
	assert.deepEqual([...side.files.keys()], [`snapshots/${two.id}.zip`]);
	await assert.rejects(job.remove(one.id), badRequest(/not found/), "already removed");
});

test("retention: keepDaily newest dailies, a bounded number of event snapshots; daily at most once per 24 h", async () => {
	const { w, side, job } = await setup({ keepDaily: 2 });
	w.vault.userWrite("a.md", "a");
	const ids: string[] = [];
	for (let d = 0; d < 4; d++) {
		ids.push((await job.maybeDaily())!);
		assert.equal(await job.maybeDaily(), null, "second call the same day");
		w.clock.advance(DAY);
	}
	for (let i = 0; i < SNAPSHOT_EVENT_KEEP + 2; i++) { await job.take("brake"); w.clock.advance(1000); }
	const left = [...side.files.keys()].map((k) => k.slice(10, -4));
	assert.deepEqual(left.filter((id) => id.endsWith("-daily")).sort(), ids.slice(2));
	assert.equal(left.filter((id) => id.endsWith("-brake")).length, SNAPSHOT_EVENT_KEEP);
	assert.equal(snapshotId(1, "epoch") < snapshotId(36 ** 8, "epoch"), true, "ids sort by time");
	assert.deepEqual(parseSnapshotId(snapshotId(1767225602224.57, "daily")), { createdAtMs: 1767225602224, reason: "daily" }, "fractional clock reading");
});

test("restore: differing file conflict-copied then restored, deleted file recreated, unchanged skipped; changes sync", async () => {
	const { w, job } = await setup();
	w.vault.userWrite("a.md", "original a\n");
	w.vault.userWrite("b.md", "original b\n");
	w.vault.userWrite("c.md", "same c\n");
	await w.boot();
	await w.sync();
	const snap = (await job.take("manual"))!;
	w.vault.userWrite("a.md", "edited a\n");
	w.vault.userDelete("b.md");
	await w.sync();
	assert.equal(w.log.liveByPath(P("b.md")), undefined);
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
	assert.equal(w.log.text(w.log.liveByPath(P("b.md"))!), "original b\n");
	assert.equal(w.log.text(w.log.liveByPath(P(r.copies[0]!))!), "edited a\n");
});

test("restore: subset of paths; a file edited between read and write is not clobbered", async () => {
	const { w, job } = await setup();
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
	const r2 = await job.restore(snap.id, [P("b.md")]);
	assert.deepEqual(r2.restored, ["b.md"]);
	assert.equal(w.vault.text("b.md"), "B0\n");
});

test("optional upload: sealed zip put under its hash address", async () => {
	const puts = new Map<string, Uint8Array>();
	const store: BlobPort = { maxBlobBytes: 1 << 30, has: async () => new Set(), put: async (a, b) => { puts.set(a, b); }, get: async () => null };
	const crypto = { suite: 0, sealEpoch: () => 0, seal: async () => new Uint8Array(), open: async () => ({ ok: false }), sealBlob: async (i: { plaintext: Uint8Array }) => i.plaintext.map((x) => x ^ 1), openBlob: async (i: { sealed: Uint8Array }) => ({ ok: true, plaintext: i.sealed }), blobAddress: async (h: ContentHash) => `addr:${h}` as BlobAddress } as unknown as CryptoPort;
	const { w, side, job } = await setup({ upload: { store, crypto } });
	w.vault.userWrite("a.md", "a");
	const res = (await job.take("manual"))!;
	const zip = side.files.get(`snapshots/${res.id}.zip`)!;
	assert.equal(res.address, `addr:${exactFingerprint(zip)}`);
	assert.deepEqual(puts.get(res.address!), zip.map((x) => x ^ 1));
});
