import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ClientFrameId, ContentHash, DeviceId, DocId, DocKind, StreamName, VaultId } from "../../core/types";
import { OUTBOX_MIRROR_MAX_BYTES } from "../../core/limits";
import type { HashPort } from "../../ports/crypto";
import {
	MIRROR_FORMAT_VERSION, OUTBOX_MIRROR_MAGIC, SYNCED_MIRROR_MAGIC,
	type OutboxMirror, type OutboxMirrorFrame, type OutboxRecord, type OutboxState, type SyncedMirror, type SyncedMirrorEntry,
} from "../store/schema";
import { CodecError, Writer, concatBytes, hexToBytes } from "../../core/codec/lib0";
import {
	decodeOutboxMirror, decodeSyncedMirror, encodeOutboxMirror, encodeSyncedMirror, mirrorFrameSize, nextMirrorSlot,
	pickOutboxMirror, pickSyncedMirror, selectMirrorFrames, toMirrorFrame,
} from "./mirrors";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sha: HashPort = {
	sha256: (bytes) => Promise.resolve(new Uint8Array(createHash("sha256").update(bytes).digest())),
};
function sha256Sync(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}
function withChecksum(body: Uint8Array): Uint8Array {
	return concatBytes([body, sha256Sync(body)]);
}

const F = (s: string): ClientFrameId => s as ClientFrameId;
const S = (s: string): StreamName => s as StreamName;
const D = (s: string): DocId => s as DocId;
const H = (s: string): ContentHash => s as ContentHash;

const ID = { vaultId: "vault-1" as VaultId, vaultEpoch: "epoch-7", deviceId: "dev-A" as DeviceId };

function bytesOf(n: number, seed: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) b[i] = (seed + i * 31) & 0xff;
	return b;
}

function frame(id: string, order: number, over: Partial<OutboxMirrorFrame> = {}): OutboxMirrorFrame {
	return {
		clientFrameId: F(id), stream: S("b:doc1"), order, state: "pending", authorNsSeq: 0,
		dependsOn: null, adoptOf: null, sealed: bytesOf(10, order), ...over,
	};
}

function record(id: string, order: number, stream: string, sealedLen: number, over: Partial<OutboxRecord> = {}): OutboxRecord {
	return {
		clientFrameId: F(id), order, stream: S(stream), kind: "bodyUpdate", state: "pending",
		sealed: bytesOf(sealedLen, order), content: bytesOf(3, 99), authorNsSeq: 5, flags: 0, frameNo: null,
		dependsOn: null, adoptOf: null, attempts: 0, createdAtMs: 1, lastSentAtMs: 0, ...over,
	};
}

const FULL_OUTBOX: OutboxMirror = {
	...ID,
	generation: 300,
	writtenAtMs: 1_759_600_000_123,
	frames: [
		frame("f-held", 1, { state: "held", stream: S("b:docX"), dependsOn: F("f-ns"), authorNsSeq: 2 ** 40 }),
		frame("f-ns", 2, { stream: S("ns"), state: "sent", sealed: bytesOf(200, 7) }),
		frame("f-adopt", 3, {
			state: "adoptable", stream: S("b:docY"),
			adoptOf: { deviceId: "dev-B" as DeviceId, clientFrameId: F("their-frame") },
		}),
		frame("f-poison", 130, { state: "poisoned", stream: S("cfg"), sealed: new Uint8Array(0) }),
		frame("f-both", 131, {
			state: "held", stream: S("x:abc"), dependsOn: F("f-adopt"),
			adoptOf: { deviceId: "dev-C" as DeviceId, clientFrameId: F("f-c") },
		}),
	],
};

const HASH_A = H("a".repeat(64));
const HASH_B = H("0123456789abcdef".repeat(4));

const FULL_SYNCED: SyncedMirror = {
	...ID,
	generation: 9,
	writtenAtMs: 1_759_600_000_999,
	nsCoversSeq: 123_456_789,
	entries: [
		{ docId: D("doc1"), path: "Notes/Über ünïcödé/日本語 🎉.md", kind: "markdown", contentHash: HASH_A, nsTouchSeq: 1, bodyRemoteSeq: 2 ** 33, blobRev: 0 },
		{ docId: D("doc2"), path: "Boards/plan.canvas", kind: "canvas", contentHash: HASH_B, nsTouchSeq: 0, bodyRemoteSeq: 0, blobRev: 0 },
		{ docId: D("doc3"), path: "attachments/ﬁle Ω.png", kind: "blob", contentHash: HASH_A, nsTouchSeq: 77, bodyRemoteSeq: 0, blobRev: 128 },
	],
};

// ---------------------------------------------------------------------------
// Independent layout builders (DESIGN §e.4), with hooks to forge bad files.
// ---------------------------------------------------------------------------

const STATE_CODES: Record<OutboxState, number> = { held: 1, pending: 2, sent: 3, poisoned: 4, adoptable: 5 };
const KIND_CODES: Record<DocKind, number> = { markdown: 1, canvas: 2, blob: 3 };

interface Forge {
	magic?: Uint8Array;
	version?: number;
	stateCode?: (i: number, real: number) => number;
	depFlag?: number;
	kindCode?: (i: number, real: number) => number;
	countDelta?: number;
	trailing?: Uint8Array;
}

function outboxBody(m: OutboxMirror, forge: Forge = {}): Uint8Array {
	const w = new Writer();
	w.raw(forge.magic ?? OUTBOX_MIRROR_MAGIC).u8(forge.version ?? MIRROR_FORMAT_VERSION);
	w.varstring(m.vaultId).varstring(m.vaultEpoch).varstring(m.deviceId).varuint(m.generation).varuint(m.writtenAtMs);
	w.varuint(m.frames.length + (forge.countDelta ?? 0));
	m.frames.forEach((f, i) => {
		const code = STATE_CODES[f.state];
		w.varstring(f.clientFrameId).varstring(f.stream).varuint(f.order).u8(forge.stateCode ? forge.stateCode(i, code) : code);
		w.varuint(f.authorNsSeq);
		if (f.dependsOn === null) w.u8(forge.depFlag ?? 0);
		else w.u8(1).varstring(f.dependsOn);
		if (f.adoptOf === null) w.u8(0);
		else w.u8(1).varstring(f.adoptOf.deviceId).varstring(f.adoptOf.clientFrameId);
		w.varbytes(f.sealed);
	});
	if (forge.trailing) w.raw(forge.trailing);
	return w.finish();
}

function syncedBody(m: SyncedMirror, forge: Forge = {}): Uint8Array {
	const w = new Writer();
	w.raw(forge.magic ?? SYNCED_MIRROR_MAGIC).u8(forge.version ?? MIRROR_FORMAT_VERSION);
	w.varstring(m.vaultId).varstring(m.vaultEpoch).varstring(m.deviceId).varuint(m.generation).varuint(m.writtenAtMs);
	w.varuint(m.nsCoversSeq).varuint(m.entries.length + (forge.countDelta ?? 0));
	m.entries.forEach((e, i) => {
		const code = KIND_CODES[e.kind];
		w.varstring(e.docId).varstring(e.path).u8(forge.kindCode ? forge.kindCode(i, code) : code).raw(hexToBytes(e.contentHash));
		w.varuint(e.nsTouchSeq).varuint(e.bodyRemoteSeq).varuint(e.blobRev);
	});
	if (forge.trailing) w.raw(forge.trailing);
	return w.finish();
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// Outbox mirror codec
// ---------------------------------------------------------------------------

describe("outbox mirror codec", () => {
	it("round-trips frames with dependsOn / adoptOf present and absent, every state, large varuints", async () => {
		const bytes = await encodeOutboxMirror(FULL_OUTBOX, sha);
		const back = await decodeOutboxMirror(bytes, sha);
		assert.deepEqual(back, FULL_OUTBOX);
	});

	it("round-trips an empty frame list and unicode identity strings", async () => {
		const m: OutboxMirror = { vaultId: "vä💾" as VaultId, vaultEpoch: "épöch", deviceId: "日本" as DeviceId, generation: 0, writtenAtMs: 0, frames: [] };
		const back = await decodeOutboxMirror(await encodeOutboxMirror(m, sha), sha);
		assert.deepEqual(back, m);
	});

	it("matches the DESIGN §e.4 byte layout exactly, with sha256 of all preceding bytes as trailer", async () => {
		const bytes = await encodeOutboxMirror(FULL_OUTBOX, sha);
		const body = outboxBody(FULL_OUTBOX);
		assert.deepEqual(bytes, withChecksum(body));
		assert.deepEqual(bytes.subarray(0, 8), new TextEncoder().encode("YAOSOBX1"));
		assert.equal(bytes[8], 1);
	});

	it("decoded sealed bytes do not alias the input buffer", async () => {
		const bytes = await encodeOutboxMirror(FULL_OUTBOX, sha);
		const back = await decodeOutboxMirror(bytes, sha);
		const sealed = back?.frames[1]?.sealed;
		assert.ok(sealed);
		assert.equal(sealed.byteOffset, 0);
		assert.equal(sealed.buffer.byteLength, sealed.length);
	});

	it("rejects bad magic (raw and re-checksummed), including a synced-mirror file", async () => {
		const good = await encodeOutboxMirror(FULL_OUTBOX, sha);
		const raw = good.slice();
		raw[0] = 0x58;
		assert.equal(await decodeOutboxMirror(raw, sha), null);
		const forged = withChecksum(outboxBody(FULL_OUTBOX, { magic: new TextEncoder().encode("YAOSOBX2") }));
		assert.equal(await decodeOutboxMirror(forged, sha), null);
		assert.equal(await decodeOutboxMirror(await encodeSyncedMirror(FULL_SYNCED, sha), sha), null);
	});

	it("rejects an unsupported format version even with a valid checksum", async () => {
		for (const version of [0, 2, 255]) {
			assert.equal(await decodeOutboxMirror(withChecksum(outboxBody(FULL_OUTBOX, { version })), sha), null, `version ${version}`);
		}
	});

	it("rejects any single flipped byte (checksum mismatch)", async () => {
		const good = await encodeOutboxMirror(FULL_OUTBOX, sha);
		for (let i = 0; i < good.length; i++) {
			const bad = good.slice();
			bad[i] = (bad[i] as number) ^ 0x01;
			assert.equal(await decodeOutboxMirror(bad, sha), null, `flip at ${i}`);
		}
	});

	it("rejects truncation at several points, raw and re-checksummed", async () => {
		const good = await encodeOutboxMirror(FULL_OUTBOX, sha);
		const body = outboxBody(FULL_OUTBOX);
		for (const cut of [0, 1, 7, 8, 9, 12, 20, 30, 41, 60, body.length - 1]) {
			assert.equal(await decodeOutboxMirror(good.subarray(0, cut), sha), null, `raw cut ${cut}`);
			assert.equal(await decodeOutboxMirror(withChecksum(body.subarray(0, cut)), sha), null, `resealed cut ${cut}`);
		}
		assert.equal(await decodeOutboxMirror(good.subarray(0, good.length - 1), sha), null, "checksum cut");
		// frameCount claims one more frame than present.
		assert.equal(await decodeOutboxMirror(withChecksum(outboxBody(FULL_OUTBOX, { countDelta: 1 })), sha), null);
	});

	it("rejects a trailing byte before the checksum, and an extra byte after it", async () => {
		const forged = withChecksum(outboxBody(FULL_OUTBOX, { trailing: new Uint8Array([0]) }));
		assert.equal(await decodeOutboxMirror(forged, sha), null);
		// frameCount claims one fewer frame: the last frame becomes trailing bytes.
		assert.equal(await decodeOutboxMirror(withChecksum(outboxBody(FULL_OUTBOX, { countDelta: -1 })), sha), null);
		const good = await encodeOutboxMirror(FULL_OUTBOX, sha);
		assert.equal(await decodeOutboxMirror(concatBytes([good, new Uint8Array([0])]), sha), null);
	});

	it("rejects unknown state codes", async () => {
		for (const code of [0, 6, 7, 255]) {
			const forged = withChecksum(outboxBody(FULL_OUTBOX, { stateCode: (i, real) => (i === 2 ? code : real) }));
			assert.equal(await decodeOutboxMirror(forged, sha), null, `state ${code}`);
		}
	});

	it("rejects a flag byte other than 0 / 1", async () => {
		const m: OutboxMirror = { ...ID, generation: 1, writtenAtMs: 1, frames: [frame("a", 1)] };
		assert.ok(await decodeOutboxMirror(withChecksum(outboxBody(m, { depFlag: 0 })), sha));
		assert.equal(await decodeOutboxMirror(withChecksum(outboxBody(m, { depFlag: 2 })), sha), null);
	});

	it("rejects duplicate clientFrameId or order on decode, and refuses to encode them", async () => {
		const dupId: OutboxMirror = { ...ID, generation: 1, writtenAtMs: 1, frames: [frame("a", 1), frame("a", 2)] };
		const dupOrder: OutboxMirror = { ...ID, generation: 1, writtenAtMs: 1, frames: [frame("a", 1), frame("b", 1)] };
		for (const m of [dupId, dupOrder]) {
			assert.equal(await decodeOutboxMirror(withChecksum(outboxBody(m)), sha), null);
			await assert.rejects(encodeOutboxMirror(m, sha), CodecError);
		}
	});

	it("floors a fractional writtenAtMs (ClockPort.now may be fractional); refuses bad counters and unknown states", async () => {
		const floored = await decodeOutboxMirror(await encodeOutboxMirror({ ...FULL_OUTBOX, writtenAtMs: 1.5 }, sha), sha);
		assert.deepEqual(floored, { ...FULL_OUTBOX, writtenAtMs: 1 });
		await assert.rejects(encodeOutboxMirror({ ...FULL_OUTBOX, generation: -1 }, sha), CodecError);
		const badState = { ...frame("a", 1), state: "bogus" as OutboxState };
		await assert.rejects(encodeOutboxMirror({ ...ID, generation: 1, writtenAtMs: 1, frames: [badState] }, sha), CodecError);
	});

	it("never throws on garbage or forged-but-checksummed mutations", async () => {
		const next = rng(42);
		const body = outboxBody(FULL_OUTBOX);
		for (let n = 0; n < 300; n++) {
			const len = Math.floor(next() * 120);
			const junk = new Uint8Array(len);
			for (let i = 0; i < len; i++) junk[i] = Math.floor(next() * 256);
			if (n % 2 === 0 && len >= 8) junk.set(OUTBOX_MIRROR_MAGIC);
			assert.equal(await decodeOutboxMirror(junk, sha), null);
			// Mutate one body byte (past magic+version) and re-checksum: null or a decoded mirror, never a throw.
			const mutated = body.slice();
			const at = 9 + Math.floor(next() * (mutated.length - 9));
			mutated[at] = Math.floor(next() * 256);
			const out = await decodeOutboxMirror(withChecksum(mutated), sha);
			assert.ok(out === null || typeof out.generation === "number");
		}
	});
});

// ---------------------------------------------------------------------------
// Synced mirror codec
// ---------------------------------------------------------------------------

describe("synced mirror codec", () => {
	it("round-trips all kinds, unicode paths and large seqs", async () => {
		const back = await decodeSyncedMirror(await encodeSyncedMirror(FULL_SYNCED, sha), sha);
		assert.deepEqual(back, FULL_SYNCED);
	});

	it("round-trips an empty entry list", async () => {
		const m: SyncedMirror = { ...ID, generation: 1, writtenAtMs: 5, nsCoversSeq: 0, entries: [] };
		assert.deepEqual(await decodeSyncedMirror(await encodeSyncedMirror(m, sha), sha), m);
	});

	it("matches the DESIGN §e.4 byte layout (contentHash as raw 32 bytes)", async () => {
		const bytes = await encodeSyncedMirror(FULL_SYNCED, sha);
		assert.deepEqual(bytes, withChecksum(syncedBody(FULL_SYNCED)));
		assert.deepEqual(bytes.subarray(0, 8), new TextEncoder().encode("YAOSSYN1"));
		const one: SyncedMirror = { ...ID, generation: 1, writtenAtMs: 1, nsCoversSeq: 1, entries: [] };
		const withEntry: SyncedMirror = {
			...one, entries: [{ docId: D("d"), path: "p", kind: "markdown", contentHash: HASH_B, nsTouchSeq: 0, bodyRemoteSeq: 0, blobRev: 0 }],
		};
		const delta = (await encodeSyncedMirror(withEntry, sha)).length - (await encodeSyncedMirror(one, sha)).length;
		assert.equal(delta, 2 + 2 + 1 + 32 + 3);
	});

	it("rejects bad magic, an outbox-mirror file, and unsupported versions", async () => {
		assert.equal(await decodeSyncedMirror(withChecksum(syncedBody(FULL_SYNCED, { magic: OUTBOX_MIRROR_MAGIC })), sha), null);
		assert.equal(await decodeSyncedMirror(await encodeOutboxMirror(FULL_OUTBOX, sha), sha), null);
		for (const version of [0, 2]) {
			assert.equal(await decodeSyncedMirror(withChecksum(syncedBody(FULL_SYNCED, { version })), sha), null);
		}
	});

	it("rejects any single flipped byte", async () => {
		const good = await encodeSyncedMirror(FULL_SYNCED, sha);
		for (let i = 0; i < good.length; i++) {
			const bad = good.slice();
			bad[i] = (bad[i] as number) ^ 0x80;
			assert.equal(await decodeSyncedMirror(bad, sha), null, `flip at ${i}`);
		}
	});

	it("rejects truncation and trailing bytes", async () => {
		const good = await encodeSyncedMirror(FULL_SYNCED, sha);
		const body = syncedBody(FULL_SYNCED);
		for (const cut of [0, 8, 9, 15, 33, 50, 80, body.length - 1]) {
			assert.equal(await decodeSyncedMirror(good.subarray(0, cut), sha), null, `raw cut ${cut}`);
			assert.equal(await decodeSyncedMirror(withChecksum(body.subarray(0, cut)), sha), null, `resealed cut ${cut}`);
		}
		assert.equal(await decodeSyncedMirror(withChecksum(syncedBody(FULL_SYNCED, { countDelta: 1 })), sha), null);
		assert.equal(await decodeSyncedMirror(withChecksum(syncedBody(FULL_SYNCED, { countDelta: -1 })), sha), null);
		assert.equal(await decodeSyncedMirror(withChecksum(syncedBody(FULL_SYNCED, { trailing: new Uint8Array([1]) })), sha), null);
	});

	it("rejects unknown kind codes", async () => {
		for (const code of [0, 4, 255]) {
			const forged = withChecksum(syncedBody(FULL_SYNCED, { kindCode: (i, real) => (i === 1 ? code : real) }));
			assert.equal(await decodeSyncedMirror(forged, sha), null, `kind ${code}`);
		}
	});

	it("rejects duplicate docIds on decode and refuses to encode them", async () => {
		const first = FULL_SYNCED.entries[0] as SyncedMirrorEntry;
		const m: SyncedMirror = { ...FULL_SYNCED, entries: [first, { ...first, path: "other.md" }] };
		assert.equal(await decodeSyncedMirror(withChecksum(syncedBody(m)), sha), null);
		await assert.rejects(encodeSyncedMirror(m, sha), CodecError);
	});

	it("refuses to encode a contentHash that is not 64 lowercase hex chars, or an unknown kind", async () => {
		const first = FULL_SYNCED.entries[0] as SyncedMirrorEntry;
		for (const contentHash of ["A".repeat(64), "ab", "a".repeat(66), "g".repeat(64)]) {
			await assert.rejects(encodeSyncedMirror({ ...FULL_SYNCED, entries: [{ ...first, contentHash: H(contentHash) }] }, sha), CodecError);
		}
		await assert.rejects(encodeSyncedMirror({ ...FULL_SYNCED, entries: [{ ...first, kind: "pdf" as DocKind }] }, sha), CodecError);
	});

	it("rejects invalid UTF-8 in a path", async () => {
		const w = new Writer();
		w.raw(SYNCED_MIRROR_MAGIC).u8(1).varstring("v").varstring("e").varstring("d").varuint(1).varuint(1).varuint(0).varuint(1);
		w.varstring("doc").varbytes(new Uint8Array([0xc3, 0x28])).u8(1).raw(hexToBytes(HASH_A)).varuint(0).varuint(0).varuint(0);
		assert.equal(await decodeSyncedMirror(withChecksum(w.finish()), sha), null);
	});
});

// ---------------------------------------------------------------------------
// Reader rule (pick)
// ---------------------------------------------------------------------------

describe("pick mirror (reader rule)", () => {
	const outboxAt = (generation: number, over: Partial<OutboxMirror> = {}): Promise<Uint8Array> =>
		encodeOutboxMirror({ ...ID, generation, writtenAtMs: generation * 10, frames: [frame(`g${generation}`, generation)], ...over }, sha);
	const syncedAt = (generation: number, over: Partial<SyncedMirror> = {}): Promise<Uint8Array> =>
		encodeSyncedMirror({ ...ID, generation, writtenAtMs: 1, nsCoversSeq: generation, entries: [], ...over }, sha);

	it("takes the highest valid generation, whichever slot it is in", async () => {
		const g4 = await outboxAt(4);
		const g5 = await outboxAt(5);
		const r1 = await pickOutboxMirror([g4, g5], ID, sha);
		assert.equal(r1?.slot, 1);
		assert.equal(r1?.mirror.generation, 5);
		const r2 = await pickOutboxMirror([g5, g4], ID, sha);
		assert.equal(r2?.slot, 0);
		assert.equal(r2?.mirror.frames[0]?.clientFrameId, "g5");
	});

	it("skips identity mismatches (vaultId, vaultEpoch, deviceId) and falls back to the other slot", async () => {
		const ok = await outboxAt(3);
		for (const over of [{ vaultId: "vault-2" as VaultId }, { vaultEpoch: "epoch-8" }, { deviceId: "dev-B" as DeviceId }]) {
			const foreign = await outboxAt(9, over);
			const r = await pickOutboxMirror([foreign, ok], ID, sha);
			assert.equal(r?.slot, 1);
			assert.equal(r?.mirror.generation, 3);
			assert.equal(await pickOutboxMirror([foreign], ID, sha), null);
		}
	});

	it("skips null, garbage and corrupted slots", async () => {
		const g2 = await outboxAt(2);
		const g7 = (await outboxAt(7)).slice();
		g7[g7.length - 40] = (g7[g7.length - 40] as number) ^ 0xff;
		assert.equal((await pickOutboxMirror([null, g2], ID, sha))?.slot, 1);
		assert.equal((await pickOutboxMirror([g7, g2], ID, sha))?.slot, 1);
		assert.equal((await pickOutboxMirror([new Uint8Array([1, 2, 3]), g2], ID, sha))?.slot, 1);
		assert.equal(await pickOutboxMirror([null, null], ID, sha), null);
		assert.equal(await pickOutboxMirror([], ID, sha), null);
		assert.equal(await pickOutboxMirror([g7, new Uint8Array(0)], ID, sha), null);
	});

	it("prefers the lower slot on a generation tie", async () => {
		const a = await outboxAt(6);
		const b = await outboxAt(6, { writtenAtMs: 999 });
		assert.equal((await pickOutboxMirror([a, b], ID, sha))?.slot, 0);
	});

	it("applies the same rule to the synced mirror and ignores outbox files there", async () => {
		const s3 = await syncedAt(3);
		const s8 = await syncedAt(8);
		const foreign = await syncedAt(20, { deviceId: "dev-Z" as DeviceId });
		const r = await pickSyncedMirror([s8, s3], ID, sha);
		assert.equal(r?.slot, 0);
		assert.equal(r?.mirror.nsCoversSeq, 8);
		assert.equal((await pickSyncedMirror([foreign, s3], ID, sha))?.slot, 1);
		assert.equal(await pickSyncedMirror([await outboxAt(50), null], ID, sha), null);
		assert.equal(await pickOutboxMirror([s8], ID, sha), null);
	});
});

// ---------------------------------------------------------------------------
// Writer rule (slot choice)
// ---------------------------------------------------------------------------

describe("nextMirrorSlot (writer rule)", () => {
	it("starts at slot a, generation 1, when nothing valid is on disk", () => {
		assert.deepEqual(nextMirrorSlot([null, null]), { slot: 0, generation: 1 });
	});

	it("targets the missing/invalid slot", () => {
		assert.deepEqual(nextMirrorSlot([3, null]), { slot: 1, generation: 4 });
		assert.deepEqual(nextMirrorSlot([null, 7]), { slot: 0, generation: 8 });
		assert.deepEqual(nextMirrorSlot([0, null]), { slot: 1, generation: 1 });
	});

	it("targets the lower generation (tie: slot a)", () => {
		assert.deepEqual(nextMirrorSlot([5, 6]), { slot: 0, generation: 7 });
		assert.deepEqual(nextMirrorSlot([6, 5]), { slot: 1, generation: 7 });
		assert.deepEqual(nextMirrorSlot([4, 4]), { slot: 0, generation: 5 });
	});

	it("treats negative, fractional and non-finite generations as invalid", () => {
		assert.deepEqual(nextMirrorSlot([-1, 2]), { slot: 0, generation: 3 });
		assert.deepEqual(nextMirrorSlot([2, 1.5]), { slot: 1, generation: 3 });
		assert.deepEqual(nextMirrorSlot([Number.NaN, Number.POSITIVE_INFINITY]), { slot: 0, generation: 1 });
	});

	it("alternates slots with monotone generations, and recovers after a torn write", async () => {
		const disk: [number | null, number | null] = [null, null];
		const seen: { slot: 0 | 1; generation: number }[] = [];
		for (let i = 0; i < 5; i++) {
			const next = nextMirrorSlot(disk);
			seen.push(next);
			disk[next.slot] = next.generation;
		}
		assert.deepEqual(seen.map((s) => s.slot), [0, 1, 0, 1, 0]);
		assert.deepEqual(seen.map((s) => s.generation), [1, 2, 3, 4, 5]);
		// Torn write of slot b (generation 6): the reader keeps slot a (5); the next write retargets b.
		const files = [await encodeOutboxMirror({ ...ID, generation: 5, writtenAtMs: 1, frames: [] }, sha), new Uint8Array([0x59, 0x41])];
		const picked = await pickOutboxMirror(files, ID, sha);
		assert.equal(picked?.slot, 0);
		assert.deepEqual(nextMirrorSlot([picked?.mirror.generation ?? null, null]), { slot: 1, generation: 6 });
	});
});

// ---------------------------------------------------------------------------
// Frame selection
// ---------------------------------------------------------------------------

describe("toMirrorFrame / selectMirrorFrames", () => {
	it("toMirrorFrame keeps identity fields and drops receivedAtMs, content, kind, flags, counters", () => {
		const r = record("f1", 4, "b:doc", 6, {
			state: "adoptable", dependsOn: F("dep"),
			adoptOf: { deviceId: "dev-B" as DeviceId, clientFrameId: F("theirs"), receivedAtMs: 12345 },
		});
		assert.deepEqual(toMirrorFrame(r), {
			clientFrameId: "f1", stream: "b:doc", order: 4, state: "adoptable", authorNsSeq: 5, dependsOn: "dep",
			adoptOf: { deviceId: "dev-B", clientFrameId: "theirs" }, sealed: r.sealed,
		});
		assert.equal(toMirrorFrame(record("f2", 1, "ns", 1)).adoptOf, null);
	});

	it("mirrorFrameSize equals the exact encoded size of a frame", async () => {
		const empty: OutboxMirror = { ...ID, generation: 1, writtenAtMs: 1, frames: [] };
		const base = (await encodeOutboxMirror(empty, sha)).length;
		for (const f of FULL_OUTBOX.frames.concat([frame("big", 9, { sealed: bytesOf(20_000, 1), order: 2 ** 20 })])) {
			const len = (await encodeOutboxMirror({ ...empty, frames: [f] }, sha)).length;
			assert.equal(len - base, mirrorFrameSize(f), f.clientFrameId);
		}
	});

	it("within the limit keeps everything (poisoned included) sorted by order", async () => {
		const records = [
			record("c", 30, "b:d1", 10),
			record("p", 5, "b:d2", 10, { state: "poisoned" }),
			record("n", 20, "ns", 10, { state: "sent" }),
			record("a", 10, "cfg", 10, { state: "held", dependsOn: F("n") }),
		];
		const out = selectMirrorFrames(records, OUTBOX_MIRROR_MAX_BYTES);
		assert.deepEqual(out.map((f) => f.clientFrameId), ["p", "a", "n", "c"]);
		assert.deepEqual(out.map((f) => f.order), [5, 10, 20, 30]);
		const back = await decodeOutboxMirror(await encodeOutboxMirror({ ...ID, generation: 1, writtenAtMs: 1, frames: out }, sha), sha);
		assert.equal(back?.frames[0]?.state, "poisoned");
		assert.deepEqual(selectMirrorFrames([], 0), []);
	});

	it("over the limit keeps all ns/cfg frames first, then an order prefix of the other frames", () => {
		const records = [
			record("b3", 3, "b:d1", 100),
			record("ns7", 7, "ns", 100),
			record("b1", 1, "b:d1", 100),
			record("x4", 4, "x:h", 100),
			record("cfg9", 9, "cfg", 100),
			record("c2", 2, "c:d2", 100),
			record("b8", 8, "b:d3", 100),
		];
		const sz = (id: string): number => mirrorFrameSize(toMirrorFrame(records.find((r) => r.clientFrameId === id) as OutboxRecord));
		const all = records.reduce((n, r) => n + mirrorFrameSize(toMirrorFrame(r)), 0);
		const ids = (max: number): string[] => selectMirrorFrames(records, max).map((f) => f.clientFrameId);

		assert.deepEqual(ids(all), ["b1", "c2", "b3", "x4", "ns7", "b8", "cfg9"]);
		assert.deepEqual(ids(all - 1), ["b1", "c2", "b3", "x4", "ns7", "cfg9"]);
		const prio = sz("ns7") + sz("cfg9");
		assert.deepEqual(ids(prio + sz("b1") + sz("c2")), ["b1", "c2", "ns7", "cfg9"]);
		assert.deepEqual(ids(prio + sz("b1") + sz("c2") + sz("b3") - 1), ["b1", "c2", "ns7", "cfg9"]);
		assert.deepEqual(ids(prio), ["ns7", "cfg9"]);
		// ns/cfg are kept even when they alone exceed the limit.
		assert.deepEqual(ids(0), ["ns7", "cfg9"]);
		assert.deepEqual(ids(sz("ns7")), ["ns7", "cfg9"]);
	});

	it("stops at the first frame that does not fit, even if a later smaller one would", () => {
		const records = [record("n", 1, "ns", 10), record("small1", 2, "b:d", 10), record("huge", 3, "b:d", 5_000), record("small2", 4, "b:d", 10)];
		const sizes = records.map((r) => mirrorFrameSize(toMirrorFrame(r)));
		const budget = (sizes[0] as number) + (sizes[1] as number) + (sizes[3] as number) + 100;
		assert.deepEqual(selectMirrorFrames(records, budget).map((f) => f.clientFrameId), ["n", "small1"]);
	});
});
