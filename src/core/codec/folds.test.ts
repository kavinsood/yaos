import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CfgFoldState, ClientFrameId, ContentHash, DeviceId, DocId, NsEntry, NsFoldState, VaultId } from "../types";
import { pathKey } from "../paths/pathKey";
import { Writer, bytesEqual } from "./lib0";
import { decodeNsFoldV1, encodeNsFoldV1 } from "./nsFoldV1";
import { decodeCfgFoldV1, encodeCfgFoldV1 } from "./cfgFoldV1";
import {
	decodeOutboxMirror,
	decodeSyncedMirror,
	encodeOutboxMirror,
	encodeSyncedMirror,
	pickMirror,
	type OutboxMirrorData,
	type SyncedMirrorData,
} from "./mirrors";

const H1 = "11".repeat(32) as ContentHash;
const H2 = "22".repeat(32) as ContentHash;
const id = (c: string) => c.repeat(22) as DocId;
const fid = (c: string) => c.repeat(22) as ClientFrameId;
const A = "devA" as DeviceId;
const B = "devB" as DeviceId;
const sha = { sha256: async (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest()) };

function entry(p: Partial<NsEntry> & Pick<NsEntry, "docId" | "path">): NsEntry {
	return {
		kind: "markdown", state: "live", createdSeq: 1, createdBy: A, lastTouchSeq: 1, deletedSeq: 0, deleteBaseBodySeq: 0,
		createHash: H1, createSize: 3, blob: null, aliasOf: null, pathKey: pathKey(p.path), ...p,
	};
}

export function sampleNsState(): NsFoldState {
	const entries = new Map<DocId, NsEntry>();
	// Inserted out of order on purpose: encoding sorts.
	entries.set(id("z"), entry({ docId: id("z"), path: "Notes/a.md" }));
	entries.set(id("b"), entry({ docId: id("b"), path: "img.png", kind: "blob", blob: { hash: H2, size: 9, rev: 4 }, lastTouchSeq: 4 }));
	entries.set(id("a"), entry({ docId: id("a"), path: "Notes/a.md", state: "merged", aliasOf: id("z"), lastTouchSeq: 5, createdSeq: 5 }));
	entries.set(id("Q"), entry({ docId: id("Q"), path: "Maße.md", state: "deleted", deletedSeq: 6, deleteBaseBodySeq: 2, lastTouchSeq: 6 }));
	const recentFrames = new Map<DeviceId, ClientFrameId[]>([[B, [fid("x")]], [A, [fid("y"), fid("w")]]]);
	// B: frameNos 70, 69 and 7 (bit 63 = 70 - 63); A: frameNo 3 only.
	const replay = new Map([[B, { r: 70, bits: BigInt(3) | (BigInt(1) << BigInt(63)) }], [A, { r: 3, bits: BigInt(1) }]]);
	return { formatVersion: 1, foldRulesVersion: 1, coversSeq: 6, entries, recentFrames, replay };
}

test("nsFoldV1: canonical (insertion-order independent) and round trips", () => {
	const s = sampleNsState();
	const bytes = encodeNsFoldV1(s);
	const d = decodeNsFoldV1(bytes);
	assert.ok(d);
	assert.deepEqual(new Map([...d.entries].sort()), new Map([...s.entries].sort()));
	assert.deepEqual(d.recentFrames, s.recentFrames);
	assert.deepEqual(d.replay, s.replay);
	assert.equal(d.coversSeq, 6);
	assert.ok(bytesEqual(encodeNsFoldV1(d), bytes));
	const reordered: NsFoldState = { ...s, entries: new Map([...s.entries].reverse()), recentFrames: new Map([...s.recentFrames].reverse()), replay: new Map([...s.replay].reverse()) };
	assert.ok(bytesEqual(encodeNsFoldV1(reordered), bytes));
	// First entry after the header is the smallest docId ("QQQ..." < "aaa..." in code units).
	assert.equal(bytes[4], 22);
	assert.equal(String.fromCharCode(bytes[5]!), "Q");
});

test("nsFoldV1: malformed bytes are rejected", () => {
	const bytes = encodeNsFoldV1(sampleNsState());
	assert.equal(decodeNsFoldV1(bytes.subarray(0, bytes.length - 1)), null, "truncated");
	assert.equal(decodeNsFoldV1(new Uint8Array([...bytes, 0])), null, "trailing");
	assert.equal(decodeNsFoldV1(new Uint8Array([2, ...bytes.subarray(1)])), null, "formatVersion 2");
	assert.equal(decodeNsFoldV1(new Uint8Array([0x81, 0x00, ...bytes.subarray(1)])), null, "non-minimal formatVersion");
	const empty = new Writer().varuint(1).varuint(1).varuint(0).varuint(0).varuint(1).varstring("d").varuint(0).finish();
	assert.equal(decodeNsFoldV1(empty), null, "ring n = 0");
	const ok = new Writer().varuint(1).varuint(1).varuint(0).varuint(0).varuint(0).varuint(0).finish();
	assert.ok(decodeNsFoldV1(ok));
});

test("fold-state replay windows: byte layout and strict decode (e2ee-design §8.2)", () => {
	const head = () => new Writer().varuint(1).varuint(1).varuint(0).varuint(0).varuint(0);
	const win = (r: number | number[], bits: number[]) => {
		const w = head().varuint(1).varstring("d");
		if (Array.isArray(r)) w.raw(new Uint8Array(r)); else w.varuint(r);
		return decodeNsFoldV1(w.raw(new Uint8Array(bits)).finish());
	};
	assert.deepEqual(win(2, [0, 0, 0, 0, 0, 0, 0, 3])?.replay.get("d" as DeviceId), { r: 2, bits: BigInt(3) });
	assert.equal(win(0, [0, 0, 0, 0, 0, 0, 0, 1]), null, "r = 0");
	assert.equal(win(2, [0, 0, 0, 0, 0, 0, 0, 2]), null, "bit 0 (frameNo r) clear");
	assert.equal(win(2, [0, 0, 0, 0, 0, 0, 0, 7]), null, "a bit for frameNo 0");
	assert.equal(win([0x82, 0x00], [0, 0, 0, 0, 0, 0, 0, 1]), null, "non-minimal r");
	assert.equal(win(2, [0, 0, 0, 0, 0, 0, 1]), null, "short bitmap");
	assert.equal(win(100, [0x80, 0, 0, 0, 0, 0, 0, 1])?.replay.get("d" as DeviceId)?.bits, (BigInt(1) << BigInt(63)) | BigInt(1));
	const sB = sampleNsState();
	const bytes = encodeNsFoldV1(sB);
	// Tail: varuint 2, "devA" r=3 bits 1, "devB" r=70 bits 0x8000000000000003.
	assert.deepEqual([...bytes.subarray(bytes.length - 29)], [
		2, 4, ...Buffer.from("devA"), 3, 0, 0, 0, 0, 0, 0, 0, 1,
		4, ...Buffer.from("devB"), 70, 0x80, 0, 0, 0, 0, 0, 0, 3,
	]);
});

function sampleCfg(): CfgFoldState {
	return {
		formatVersion: 1,
		coversSeq: 42,
		recentFrames: new Map([[A, [fid("c")]]]),
		replay: new Map([[A, { r: 12, bits: BigInt(5) }]]),
		json: new Map([
			["app.json\u0000vimMode", { value: "true", version: { seq: 3, index: 0, deviceId: A } }],
			["app.json\u0000gone", { value: null, version: { seq: 4, index: 1, deviceId: B } }],
		]),
		files: new Map([
			["snippets/a.css", { value: { content: { t: "inline", bytes: new Uint8Array([1, 2]) }, pluginVersion: null }, version: { seq: 5, index: 0, deviceId: A } }],
			["plugins/x/data.json", { value: { content: { t: "blob", hash: H1, size: 99999 }, pluginVersion: "1.0.0" }, version: { seq: 6, index: 2, deviceId: B } }],
			["snippets/old.css", { value: null, version: { seq: 7, index: 0, deviceId: A } }],
		]),
		plugins: new Map([
			["dataview", { value: true, version: { seq: 8, index: 0, deviceId: A } }],
			["calendar", { value: false, version: { seq: 8, index: 1, deviceId: A } }],
			["old", { value: null, version: { seq: 9, index: 0, deviceId: B } }],
		]),
	};
}

test("cfgFoldV1: round trip and canonical order", () => {
	const s = sampleCfg();
	const bytes = encodeCfgFoldV1(s);
	const d = decodeCfgFoldV1(bytes);
	assert.ok(d);
	assert.deepEqual(new Map([...d.json].sort()), new Map([...s.json].sort()));
	assert.deepEqual(new Map([...d.files].sort()), new Map([...s.files].sort()));
	assert.deepEqual(new Map([...d.plugins].sort()), new Map([...s.plugins].sort()));
	assert.deepEqual(d.replay, s.replay);
	assert.ok(bytesEqual(encodeCfgFoldV1(d), bytes));
	const rev: CfgFoldState = { ...s, json: new Map([...s.json].reverse()), files: new Map([...s.files].reverse()), plugins: new Map([...s.plugins].reverse()) };
	assert.ok(bytesEqual(encodeCfgFoldV1(rev), bytes));
	assert.equal(decodeCfgFoldV1(bytes.subarray(0, bytes.length - 2)), null);
	assert.equal(decodeCfgFoldV1(new Uint8Array([...bytes, 1])), null);
});

const ident = { vaultId: "v" as VaultId, vaultEpoch: "e1", deviceId: A };

test("outbox mirror: round trip, checksum, magic, pick by generation and identity", async () => {
	const m: OutboxMirrorData = {
		...ident, generation: 7, writtenAtMs: 1_700_000_000_000,
		frames: [
			{ clientFrameId: fid("a"), stream: "ns" as never, order: 1, state: "sent", authorNsSeq: 3, dependsOn: null, adoptOf: null, sealed: new Uint8Array([1, 0, 0, 1]) },
			{ clientFrameId: fid("b"), stream: "b:x" as never, order: 2, state: "held", authorNsSeq: 3, dependsOn: fid("a"), adoptOf: null, sealed: new Uint8Array([]) },
			{ clientFrameId: fid("c"), stream: "b:x" as never, order: 3, state: "adoptable", authorNsSeq: 0, dependsOn: null, adoptOf: { deviceId: B, clientFrameId: fid("d") }, sealed: new Uint8Array([9]) },
		],
	};
	const bytes = await encodeOutboxMirror(m, sha);
	assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "YAOSOBX1");
	const d = await decodeOutboxMirror(bytes, sha);
	assert.ok(d.ok);
	if (d.ok) assert.deepEqual(d.mirror, m);
	const flipped = bytes.slice();
	flipped[20]! ^= 1;
	assert.deepEqual(await decodeOutboxMirror(flipped, sha), { ok: false, reason: "bad-checksum" });
	assert.deepEqual(await decodeOutboxMirror(new Uint8Array(50), sha), { ok: false, reason: "bad-magic" });
	const older = await decodeOutboxMirror(await encodeOutboxMirror({ ...m, generation: 6 }, sha), sha);
	const other = await decodeOutboxMirror(await encodeOutboxMirror({ ...m, generation: 9, vaultEpoch: "e0" }, sha), sha);
	assert.equal(pickMirror([older, d, other, { ok: false, reason: "bad-checksum" }], ident)?.generation, 7);
	assert.equal(pickMirror([other], ident), null);
});

test("synced mirror: round trip", async () => {
	const m: SyncedMirrorData = {
		...ident, generation: 2, writtenAtMs: 5, nsCoversSeq: 900,
		entries: [
			{ docId: id("a"), path: "Notes/a.md", kind: "markdown", contentHash: H1, nsTouchSeq: 5, bodyRemoteSeq: 12, blobRev: 0 },
			{ docId: id("b"), path: "x.png", kind: "blob", contentHash: H2, nsTouchSeq: 6, bodyRemoteSeq: 0, blobRev: 6 },
		],
	};
	const bytes = await encodeSyncedMirror(m, sha);
	assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "YAOSSYN1");
	const d = await decodeSyncedMirror(bytes, sha);
	assert.ok(d.ok);
	if (d.ok) assert.deepEqual(d.mirror, m);
	assert.deepEqual(await decodeSyncedMirror(await encodeOutboxMirror({ ...ident, generation: 1, writtenAtMs: 0, frames: [] }, sha), sha), { ok: false, reason: "bad-magic" });
});

test("mirrors: a fractional clock reading encodes (floored), never throws", async () => {
	const m: SyncedMirrorData = { ...ident, generation: 3, writtenAtMs: 1767225602224.5696, nsCoversSeq: 1, entries: [] };
	const d = await decodeSyncedMirror(await encodeSyncedMirror(m, sha), sha);
	assert.ok(d.ok);
	if (d.ok) assert.equal(d.mirror.writtenAtMs, 1767225602224);
	const o = await decodeOutboxMirror(await encodeOutboxMirror({ ...ident, generation: 1, writtenAtMs: 0.5, frames: [] }, sha), sha);
	assert.ok(o.ok);
});
