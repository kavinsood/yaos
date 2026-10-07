/**
 * Snapshot bundle: zip writer/reader, part cutting, and one test per verification failure (DESIGN §j.4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import type { ContentHash, DocKind, VaultPath } from "../types";
import { kindOfPath } from "../types";
import { utf8Encode } from "../codec/lib0";
import { refHashPort, sha256HexRef } from "../hash/testkit/hashRef";
import { snapshotId, type SnapRecord } from "./record";
import { SnapCorrupt, bundleDigest, encodeManifest, type SnapCheck } from "./bundle";
import { BundleBuilder, bundleRecord } from "./export";
import { verifyBundle, type VerifiedEntry } from "./verify";
import { ZipError, ZipWriter, crc32, readZip } from "./zip";

const T0 = Date.UTC(2026, 9, 7);
const ID = snapshotId(T0, "manual");
const enc = (s: string) => utf8Encode(s);

function rand(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 0xff; }
	return b;
}

const FILES: [string, Uint8Array][] = [
	["Notes/a.md", enc("# A\n\nhello ".repeat(400))],
	["b.canvas", enc(JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "x", x: 0, y: 0, width: 10, height: 10 }], edges: [] }))],
	["img/c.png", rand(70_000, 7)],
	["empty.md", new Uint8Array(0)],
];

async function build(files: readonly [string, Uint8Array][] = FILES, partSize = 16 * 1024) {
	const parts: Uint8Array[] = [];
	const b = new BundleBuilder(refHashPort, ID, T0, "manual", partSize, async (p) => { assert.equal(p.index, parts.length); parts.push(p.bytes); });
	for (const [path, data] of files) await b.addFile(path as VaultPath, kindOfPath(path as VaultPath), data);
	b.skip("huge.bin", "too-large");
	const built = await b.finish();
	const record = bundleRecord(built, "laptop", built.parts.map((p) => p.sha256));
	return { built, record, parts };
}

async function verify(record: SnapRecord, parts: readonly (Uint8Array | null)[]) {
	const got: VerifiedEntry[] = [];
	const m = await verifyBundle({ hash: refHashPort, record, part: async (i) => parts[i] ?? null, onEntry: async (e) => { got.push(e); } });
	return { m, got };
}

async function expectCorrupt(check: SnapCheck, record: SnapRecord, parts: readonly (Uint8Array | null)[]) {
	await assert.rejects(verify(record, parts), (e: unknown) => {
		assert.ok(e instanceof SnapCorrupt, String(e));
		assert.equal(e.check, check, e.message);
		return true;
	});
}

/** Re-cut `zip` into parts and make a record that is consistent with them (a tamperer who rewrote the index too). */
async function consistentRecord(zip: Uint8Array, partSize: number, base: SnapRecord, manifestBytes: Uint8Array, over: Partial<SnapRecord> = {}) {
	const parts: Uint8Array[] = [];
	for (let o = 0; o < zip.length; o += partSize) parts.push(zip.slice(o, o + partSize));
	const ps = parts.map((p) => ({ address: sha256HexRef(p), size: p.length, sha256: sha256HexRef(p) as ContentHash }));
	const digest = await bundleDigest(refHashPort, base.snapshotId, ps, sha256HexRef(manifestBytes));
	return { record: { ...base, parts: ps, bundleDigest: digest, ...over } as SnapRecord, parts };
}

async function rawZip(entries: readonly [string, Uint8Array, boolean][]): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const w = new ZipWriter(async (c) => { chunks.push(c.slice()); });
	for (const [n, d, z] of entries) await w.add(n, d, z);
	await w.finish();
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let o = 0;
	for (const c of chunks) { out.set(c, o); o += c.length; }
	return out;
}
const join = (ps: readonly Uint8Array[]) => { const out = new Uint8Array(ps.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of ps) { out.set(p, o); o += p.length; } return out; };

test("crc32 check value", () => {
	assert.equal(crc32(enc("123456789")), 0xcbf43926);
	assert.equal(crc32(enc("56789"), crc32(enc("1234"))), 0xcbf43926);
});

test("bundle: parts of exactly partSize, standard unzip reads it, verify returns every file", async () => {
	const { built, record, parts } = await build();
	assert.ok(parts.length > 3);
	parts.slice(0, -1).forEach((p) => assert.equal(p.length, 16 * 1024));
	const zip = join(parts);
	assert.equal(zip.length, built.zipBytes);
	const std = unzipSync(zip);
	assert.deepEqual(Object.keys(std), [...FILES.map(([p]) => `files/${p}`), "manifest.json"]);
	FILES.forEach(([p, d]) => assert.deepEqual(std[`files/${p}`], d));
	assert.equal(JSON.parse(strFromU8(std["manifest.json"]!)).skipped[0].reason, "too-large");
	const { m, got } = await verify(record, parts);
	assert.equal(m.files.length, FILES.length);
	assert.deepEqual(got.map((e) => [e.path, e.data]), FILES);
	assert.equal(record.totalBytes, FILES.reduce((n, [, d]) => n + d.length, 0));
	// Single-part bundles too.
	const one = await build(FILES, 8 * 1024 * 1024);
	assert.equal(one.parts.length, 1);
	await verify(one.record, one.parts);
});

test("verify: wrong part size", async () => {
	const { record, parts } = await build();
	await expectCorrupt("part-size", record, parts.map((p, i) => (i === 1 ? p.subarray(0, p.length - 1) : p)));
});

test("verify: wrong part hash (bit flip in a stored part)", async () => {
	const { record, parts } = await build();
	const flipped = parts.map((p) => p.slice());
	flipped[2]![100]! ^= 0x01;
	await expectCorrupt("part-hash", record, flipped);
});

test("verify: missing part", async () => {
	const { record, parts } = await build();
	await expectCorrupt("part-missing", record, parts.map((p, i) => (i === 2 ? null : p)));
});

test("verify: truncated bundle under a consistent record", async () => {
	const { record, parts } = await build();
	const zip = join(parts);
	const cut = zip.subarray(0, zip.length - 30);
	const t = await consistentRecord(cut, 16 * 1024, record, new Uint8Array(0));
	await expectCorrupt("truncated", t.record, t.parts);
});

test("verify: bit flip under a consistent record fails the zip crc", async () => {
	const { record, parts } = await build();
	const zip = join(parts).slice();
	zip[30 + "files/Notes/a.md".length + 10]! ^= 0x40; // inside the first entry's (deflated) data
	const t = await consistentRecord(zip, 16 * 1024, record, new Uint8Array(0));
	await expectCorrupt("zip-decode", t.record, t.parts);
});

test("verify: corrupt zip (garbage) and zip-reader strictness", async () => {
	const { record } = await build();
	const t = await consistentRecord(rand(5000, 3), 16 * 1024, record, new Uint8Array(0));
	await expectCorrupt("zip-decode", t.record, t.parts);
	// Data-descriptor flag, trailing bytes and a short central directory are all rejected.
	const good = await rawZip([["files/x.md", enc("x"), false], ["manifest.json", enc("{}"), false]]);
	const dd = good.slice(); dd[6] = 0x08; dd[7] = 0x08;
	for (const [bytes, check] of [[dd, "zip-decode"], [join([good, new Uint8Array([0])]), "zip-decode"], [good.subarray(0, good.length - 1), "truncated"]] as const) {
		let yielded = 0;
		await assert.rejects((async () => { let done = false; for await (const _ of readZip(async () => (done ? null : (done = true, bytes)), { maxEntryBytes: () => 1 << 20 })) yielded++; })(),
			(e: unknown) => e instanceof ZipError && e.check === check);
		assert.ok(yielded <= 2);
	}
	// Entry bound: a 2 MiB "blob" entry is refused before it is inflated.
	const big = await rawZip([["files/x.bin", new Uint8Array(2 << 20), true]]);
	await assert.rejects((async () => { let d = false; for await (const _ of readZip(async () => (d ? null : (d = true, big)), { maxEntryBytes: () => 1 << 20 })) { /* drain */ } })(),
		(e: unknown) => e instanceof ZipError && /too large/.test(e.message));
});

test("verify: manifest mismatch (entry not listed, sizes or hashes differ)", async () => {
	const { built, record } = await build();
	const m = built.manifest;
	const lie = { ...m, files: m.files.map((f, i) => (i === 0 ? { ...f, hash: "00".repeat(32) as ContentHash } : f)) };
	const mb = encodeManifest(lie);
	const zip = await rawZip([...FILES.map(([p, d]): [string, Uint8Array, boolean] => [`files/${p}`, d, kindOfPath(p as VaultPath) !== "blob"]), ["manifest.json", mb, true]]);
	const t = await consistentRecord(zip, 16 * 1024, record, mb);
	await expectCorrupt("manifest-mismatch", t.record, t.parts);
	// Manifest that disagrees with the index record (fileCount).
	const ok = encodeManifest(m);
	const zip2 = await rawZip([...FILES.map(([p, d]): [string, Uint8Array, boolean] => [`files/${p}`, d, false]), ["manifest.json", ok, true]]);
	const t2 = await consistentRecord(zip2, 16 * 1024, record, ok, { fileCount: FILES.length + 1 });
	await expectCorrupt("manifest-mismatch", t2.record, t2.parts);
	// Bundle digest that does not bind the manifest.
	const t3 = await consistentRecord(zip2, 16 * 1024, record, enc("other"));
	await expectCorrupt("bundle-digest", t3.record, t3.parts);
});

test("verify: manifest that fails the strict schema (bad JSON, version, id, file or skipped entry)", async () => {
	const { built, record } = await build();
	const m = built.manifest;
	const json = (over: Record<string, unknown>) => enc(JSON.stringify({ ...m, ...over }));
	const bad: Uint8Array[] = [
		enc("{\"formatVersion\":1,"),
		new Uint8Array([0x7b, 0xff, 0x7d]),
		enc("[]"),
		json({ formatVersion: 2 }),
		json({ id: snapshotId(T0 + 1, "manual") }),
		json({ reason: "daily" }),
		json({ files: m.files.map((f, i) => (i === 0 ? { ...f, hash: "XY" } : f)) }),
		json({ files: m.files.map((f, i) => (i === 0 ? { ...f, size: -1 } : f)) }),
		json({ files: m.files.map((f, i) => (i === 0 ? { ...f, kind: "pdf" } : f)) }),
		json({ skipped: [{ path: "x", reason: "because" }] }),
		json({ files: m.files.map((_f, i) => m.files[i === 1 ? 0 : i]!) }), // duplicate path
	];
	for (const mb of bad) {
		const entries = (mb === bad.at(-1) ? [FILES[0]!, FILES[0]!, ...FILES.slice(2)] : FILES)
			.map(([p, d]): [string, Uint8Array, boolean] => [`files/${p}`, d, false]);
		const zip = await rawZip([...entries, ["manifest.json", mb, true]]);
		const t = await consistentRecord(zip, 16 * 1024, record, mb, mb === bad.at(-1) ? { totalBytes: record.totalBytes - FILES[1]![1].length + FILES[0]![1].length } : {});
		await expectCorrupt("manifest-invalid", t.record, t.parts);
	}
});

test("verify: path traversal and invalid paths are refused", async () => {
	for (const bad of ["../evil.md", "Notes/../../evil.md", ".obsidian/app.json", "a/./b.md", "/abs.md", "con.md"]) {
		const files: [string, Uint8Array][] = [["ok.md", enc("ok")], [bad, enc("evil")]];
		const { record, parts } = await build(files);
		await expectCorrupt("path-invalid", record, parts);
	}
});

test("verify: content that would not restore (invalid markdown UTF-8, canvas that does not parse)", async () => {
	for (const [path, data] of [["bad.md", new Uint8Array([0x61, 0xff, 0x62])], ["bad.canvas", enc("{nope")]] as [string, Uint8Array][]) {
		const { record, parts } = await build([["ok.md", enc("ok")], [path, data]]);
		await expectCorrupt("content-invalid", record, parts);
	}
});

test("verify: second pass checks entries against the verified manifest", async () => {
	const { record, parts } = await build();
	const { m } = await verify(record, parts);
	const lie = { ...m, files: m.files.map((f, i) => (i === 1 ? { ...f, size: f.size + 1 } : f)) };
	const seen: string[] = [];
	await assert.rejects(verifyBundle({ hash: refHashPort, record, part: async (i) => parts[i]!, expect: lie, onEntry: async (e) => { seen.push(e.path); } }),
		(e: unknown) => e instanceof SnapCorrupt && e.check === "file-hash");
	assert.deepEqual(seen, [FILES[0]![0]]);
});

test("kinds are taken from the path, not the manifest", async () => {
	const kinds: DocKind[] = FILES.map(([p]) => kindOfPath(p as VaultPath));
	const { built } = await build();
	assert.deepEqual(built.manifest.files.map((f) => f.kind), kinds);
});
