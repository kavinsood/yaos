/**
 * Side-file mirror codecs (DESIGN §e.4, recovery use in §i.5).
 *
 * Two A/B side-file pairs survive IndexedDB loss:
 *  - outbox mirror (`outbox-a.bin` / `outbox-b.bin`): frame identity of own
 *    unacknowledged frames, so a resent frame dedupes instead of duplicating;
 *  - synced mirror (`synced-a.bin` / `synced-b.bin`): the Synced tree without
 *    base texts, so recovery can tell "unchanged since sync" from "edited".
 *
 * Both formats end with sha256(all preceding bytes), computed via HashPort.
 * The writer alternates slots by generation; the reader takes the valid file
 * (magic, checksum, identity) with the highest generation.
 *
 * Error model:
 *  - encode* throws CodecError on input that cannot be encoded faithfully
 *    (non-integer / negative numbers, unknown state or kind, contentHash that
 *    is not 64 lowercase hex chars, duplicate frame ids / orders / docIds);
 *  - decode* never throws on malformed bytes, it returns null. A HashPort that
 *    rejects is an environment fault, not a bad file, and propagates.
 */

import { streamClass } from "../../core/types";
import type { ClientFrameId, ContentHash, DeviceId, DocId, DocKind, StreamName, VaultEpoch, VaultId, VaultPath } from "../../core/types";
import { DocKindCode } from "../../core/envelope";
import type { HashPort } from "../../ports/crypto";
import { MIRROR_FORMAT_VERSION, OUTBOX_MIRROR_MAGIC, SYNCED_MIRROR_MAGIC } from "../store/schema";
import type { OutboxMirror, OutboxMirrorFrame, OutboxRecord, OutboxState, SyncedMirror, SyncedMirrorEntry } from "../store/schema";
import { CodecError, Reader, Writer, bytesEqual, concatBytes, fromHex, toHex, utf8 } from "../sync/__standins__/bytes";

const MAGIC_BYTES = 8;
const CHECKSUM_BYTES = 32;
const CONTENT_HASH_BYTES = 32;

export interface MirrorIdentity {
	readonly vaultId: VaultId;
	readonly vaultEpoch: VaultEpoch;
	readonly deviceId: DeviceId;
}

// ---------------------------------------------------------------------------
// Code tables
// ---------------------------------------------------------------------------

const STATE_CODE: Readonly<Record<OutboxState, number>> = { held: 1, pending: 2, sent: 3, poisoned: 4, adoptable: 5 };
const STATE_BY_CODE: ReadonlyMap<number, OutboxState> = new Map(
	(Object.keys(STATE_CODE) as OutboxState[]).map((s) => [STATE_CODE[s], s] as const),
);
const KIND_BY_CODE: ReadonlyMap<number, DocKind> = new Map(
	(Object.keys(DocKindCode) as DocKind[]).map((k) => [DocKindCode[k], k] as const),
);

function stateCode(state: OutboxState): number {
	if (!Object.prototype.hasOwnProperty.call(STATE_CODE, state)) throw new CodecError(`unknown outbox state: ${String(state)}`);
	return STATE_CODE[state];
}
function kindCode(kind: DocKind): number {
	if (!Object.prototype.hasOwnProperty.call(DocKindCode, kind)) throw new CodecError(`unknown doc kind: ${String(kind)}`);
	return DocKindCode[kind];
}

// ---------------------------------------------------------------------------
// Checksum framing
// ---------------------------------------------------------------------------

async function appendChecksum(body: Uint8Array, hash: HashPort): Promise<Uint8Array> {
	const digest = await hash.sha256(body);
	if (digest.length !== CHECKSUM_BYTES) throw new CodecError("HashPort.sha256 must return 32 bytes");
	return concatBytes([body, digest]);
}

/** The checksummed body (magic included, checksum excluded), or null if the magic or checksum is wrong. */
async function verifiedBody(bytes: Uint8Array, magic: Uint8Array, hash: HashPort): Promise<Uint8Array | null> {
	// Smallest possible body is magic + version byte; anything shorter cannot be a mirror.
	if (bytes.length < MAGIC_BYTES + 1 + CHECKSUM_BYTES) return null;
	if (!bytesEqual(bytes.subarray(0, MAGIC_BYTES), magic)) return null;
	const body = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
	const digest = await hash.sha256(body);
	if (!bytesEqual(digest, bytes.subarray(bytes.length - CHECKSUM_BYTES))) return null;
	return body;
}

function readFlag(r: Reader): boolean {
	const b = r.u8();
	if (b > 1) throw new CodecError(`bad flag byte: ${b}`);
	return b === 1;
}

function readHeader(r: Reader, magic: Uint8Array): MirrorIdentity & { readonly generation: number; readonly writtenAtMs: number } {
	if (!bytesEqual(r.bytes(MAGIC_BYTES), magic)) throw new CodecError("bad magic");
	const version = r.u8();
	if (version !== MIRROR_FORMAT_VERSION) throw new CodecError(`unsupported mirror version: ${version}`);
	const vaultId = r.varstring() as VaultId;
	const vaultEpoch: VaultEpoch = r.varstring();
	const deviceId = r.varstring() as DeviceId;
	const generation = r.varuint();
	const writtenAtMs = r.varuint();
	return { vaultId, vaultEpoch, deviceId, generation, writtenAtMs };
}

function writeHeader(w: Writer, magic: Uint8Array, m: MirrorIdentity & { readonly generation: number; readonly writtenAtMs: number }): void {
	w.bytes(magic).u8(MIRROR_FORMAT_VERSION).varstring(m.vaultId).varstring(m.vaultEpoch).varstring(m.deviceId);
	w.varuint(m.generation).varuint(m.writtenAtMs);
}

// ---------------------------------------------------------------------------
// Outbox mirror
// ---------------------------------------------------------------------------

/** Recovery imports frames into a store keyed by clientFrameId with a unique order index (§i.5 step 2). */
function duplicateFrame(frames: readonly OutboxMirrorFrame[]): string | null {
	const ids = new Set<string>();
	const orders = new Set<number>();
	for (const f of frames) {
		if (ids.has(f.clientFrameId)) return `duplicate clientFrameId ${f.clientFrameId}`;
		if (orders.has(f.order)) return `duplicate order ${f.order}`;
		ids.add(f.clientFrameId);
		orders.add(f.order);
	}
	return null;
}

function writeFrame(w: Writer, f: OutboxMirrorFrame): void {
	w.varstring(f.clientFrameId).varstring(f.stream).varuint(f.order).u8(stateCode(f.state)).varuint(f.authorNsSeq);
	if (f.dependsOn === null) w.u8(0);
	else w.u8(1).varstring(f.dependsOn);
	if (f.adoptOf === null) w.u8(0);
	else w.u8(1).varstring(f.adoptOf.deviceId).varstring(f.adoptOf.clientFrameId);
	w.varbytes(f.sealed);
}

function readFrame(r: Reader): OutboxMirrorFrame {
	const clientFrameId = r.varstring() as ClientFrameId;
	const stream = r.varstring() as StreamName;
	const order = r.varuint();
	const code = r.u8();
	const state = STATE_BY_CODE.get(code);
	if (state === undefined) throw new CodecError(`bad state code: ${code}`);
	const authorNsSeq = r.varuint();
	const dependsOn = readFlag(r) ? (r.varstring() as ClientFrameId) : null;
	let adoptOf: OutboxMirrorFrame["adoptOf"] = null;
	if (readFlag(r)) {
		const deviceId = r.varstring() as DeviceId;
		adoptOf = { deviceId, clientFrameId: r.varstring() as ClientFrameId };
	}
	// Copy: a view would pin the whole side-file buffer, and IndexedDB's
	// structured clone of a view stores its entire underlying ArrayBuffer.
	const sealed = r.varbytes().slice();
	return { clientFrameId, stream, order, state, authorNsSeq, dependsOn, adoptOf, sealed };
}

export async function encodeOutboxMirror(m: OutboxMirror, hash: HashPort): Promise<Uint8Array> {
	const dup = duplicateFrame(m.frames);
	if (dup !== null) throw new CodecError(dup);
	const w = new Writer();
	writeHeader(w, OUTBOX_MIRROR_MAGIC, m);
	w.varuint(m.frames.length);
	for (const f of m.frames) writeFrame(w, f);
	return appendChecksum(w.finish(), hash);
}

/**
 * null on bad magic, version, truncation, trailing bytes, bad state code, bad
 * flag byte, invalid UTF-8, duplicate clientFrameId / order, or checksum
 * mismatch. Never throws on malformed input.
 */
export async function decodeOutboxMirror(bytes: Uint8Array, hash: HashPort): Promise<OutboxMirror | null> {
	const body = await verifiedBody(bytes, OUTBOX_MIRROR_MAGIC, hash);
	if (body === null) return null;
	try {
		const r = new Reader(body);
		const header = readHeader(r, OUTBOX_MIRROR_MAGIC);
		const count = r.varuint();
		const frames: OutboxMirrorFrame[] = [];
		// Each frame reads at least one byte, so a bogus count fails on truncation.
		for (let i = 0; i < count; i++) frames.push(readFrame(r));
		r.end();
		if (duplicateFrame(frames) !== null) return null;
		return { ...header, frames };
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Synced mirror
// ---------------------------------------------------------------------------

function writeEntry(w: Writer, e: SyncedMirrorEntry): void {
	const hashBytes = fromHex(e.contentHash);
	if (hashBytes.length !== CONTENT_HASH_BYTES) throw new CodecError(`contentHash must be 32 bytes: ${e.contentHash}`);
	w.varstring(e.docId).varstring(e.path).u8(kindCode(e.kind)).bytes(hashBytes);
	w.varuint(e.nsTouchSeq).varuint(e.bodyRemoteSeq).varuint(e.blobRev);
}

function readEntry(r: Reader): SyncedMirrorEntry {
	const docId = r.varstring() as DocId;
	const path: VaultPath = r.varstring();
	const code = r.u8();
	const kind = KIND_BY_CODE.get(code);
	if (kind === undefined) throw new CodecError(`bad kind code: ${code}`);
	const contentHash = toHex(r.bytes(CONTENT_HASH_BYTES)) as ContentHash;
	const nsTouchSeq = r.varuint();
	const bodyRemoteSeq = r.varuint();
	const blobRev = r.varuint();
	return { docId, path, kind, contentHash, nsTouchSeq, bodyRemoteSeq, blobRev };
}

function duplicateDoc(entries: readonly SyncedMirrorEntry[]): string | null {
	const ids = new Set<string>();
	for (const e of entries) {
		if (ids.has(e.docId)) return `duplicate docId ${e.docId}`;
		ids.add(e.docId);
	}
	return null;
}

export async function encodeSyncedMirror(m: SyncedMirror, hash: HashPort): Promise<Uint8Array> {
	const dup = duplicateDoc(m.entries);
	if (dup !== null) throw new CodecError(dup);
	const w = new Writer();
	writeHeader(w, SYNCED_MIRROR_MAGIC, m);
	w.varuint(m.nsCoversSeq).varuint(m.entries.length);
	for (const e of m.entries) writeEntry(w, e);
	return appendChecksum(w.finish(), hash);
}

/** null on bad magic, version, truncation, trailing bytes, bad kind code, invalid UTF-8, duplicate docId, or checksum mismatch. */
export async function decodeSyncedMirror(bytes: Uint8Array, hash: HashPort): Promise<SyncedMirror | null> {
	const body = await verifiedBody(bytes, SYNCED_MIRROR_MAGIC, hash);
	if (body === null) return null;
	try {
		const r = new Reader(body);
		const header = readHeader(r, SYNCED_MIRROR_MAGIC);
		const nsCoversSeq = r.varuint();
		const count = r.varuint();
		const entries: SyncedMirrorEntry[] = [];
		for (let i = 0; i < count; i++) entries.push(readEntry(r));
		r.end();
		if (duplicateDoc(entries) !== null) return null;
		return { ...header, nsCoversSeq, entries };
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}

// ---------------------------------------------------------------------------
// A/B slots
// ---------------------------------------------------------------------------

function sameIdentity(a: MirrorIdentity, b: MirrorIdentity): boolean {
	return a.vaultId === b.vaultId && a.vaultEpoch === b.vaultEpoch && a.deviceId === b.deviceId;
}

async function pickMirror<M extends MirrorIdentity & { readonly generation: number }>(
	files: readonly (Uint8Array | null)[],
	identity: MirrorIdentity,
	decode: (bytes: Uint8Array) => Promise<M | null>,
): Promise<{ mirror: M; slot: number } | null> {
	let best: { mirror: M; slot: number } | null = null;
	for (let slot = 0; slot < files.length; slot++) {
		const bytes = files[slot];
		if (bytes === null || bytes === undefined) continue;
		const mirror = await decode(bytes);
		if (mirror === null || !sameIdentity(mirror, identity)) continue;
		// Strict >: on an (unexpected) generation tie the lower slot wins.
		if (best === null || mirror.generation > best.mirror.generation) best = { mirror, slot };
	}
	return best;
}

/** Reader rule: the valid file (magic, checksum, identity match) with the highest generation; null if none. `slot` = index into files. */
export function pickOutboxMirror(
	files: readonly (Uint8Array | null)[],
	identity: MirrorIdentity,
	hash: HashPort,
): Promise<{ mirror: OutboxMirror; slot: number } | null> {
	return pickMirror(files, identity, (b) => decodeOutboxMirror(b, hash));
}

/** Reader rule for the synced mirror; same as pickOutboxMirror. */
export function pickSyncedMirror(
	files: readonly (Uint8Array | null)[],
	identity: MirrorIdentity,
	hash: HashPort,
): Promise<{ mirror: SyncedMirror; slot: number } | null> {
	return pickMirror(files, identity, (b) => decodeSyncedMirror(b, hash));
}

function validGeneration(g: number | null): number | null {
	return g !== null && Number.isSafeInteger(g) && g >= 0 ? g : null;
}

/**
 * Writer rule: target slot = the slot (0 = a, 1 = b) with the lower or invalid
 * generation (both invalid, or a tie: slot 0). `current` are the generations
 * on disk per slot (null = missing/invalid; a negative or non-integer value is
 * treated as invalid). generation = max(valid) + 1, or 1 if none is valid.
 */
export function nextMirrorSlot(current: readonly [number | null, number | null]): { slot: 0 | 1; generation: number } {
	const a = validGeneration(current[0]);
	const b = validGeneration(current[1]);
	if (a === null) return { slot: 0, generation: b === null ? 1 : b + 1 };
	if (b === null) return { slot: 1, generation: a + 1 };
	return { slot: a <= b ? 0 : 1, generation: Math.max(a, b) + 1 };
}

// ---------------------------------------------------------------------------
// Frame selection (size limit)
// ---------------------------------------------------------------------------

/** OutboxRecord -> OutboxMirrorFrame (adoptOf drops receivedAtMs; content, kind, flags, counters are not mirrored). */
export function toMirrorFrame(r: OutboxRecord): OutboxMirrorFrame {
	return {
		clientFrameId: r.clientFrameId,
		stream: r.stream,
		order: r.order,
		state: r.state,
		authorNsSeq: r.authorNsSeq,
		dependsOn: r.dependsOn,
		adoptOf: r.adoptOf === null ? null : { deviceId: r.adoptOf.deviceId, clientFrameId: r.adoptOf.clientFrameId },
		sealed: r.sealed,
	};
}

/** Bytes of a lib0 varuint. */
function varuintSize(n: number): number {
	let size = 1;
	while (n > 0x7f) {
		n = Math.floor(n / 128);
		size++;
	}
	return size;
}
function varbytesSize(length: number): number {
	return varuintSize(length) + length;
}
function varstringSize(s: string): number {
	return varbytesSize(utf8(s).length);
}

/** Exact encoded size of one frame in the outbox mirror (excludes header, frame count and checksum). */
export function mirrorFrameSize(f: OutboxMirrorFrame): number {
	let n = varstringSize(f.clientFrameId) + varstringSize(f.stream) + varuintSize(f.order) + 1 + varuintSize(f.authorNsSeq);
	n += 1 + (f.dependsOn === null ? 0 : varstringSize(f.dependsOn));
	n += 1 + (f.adoptOf === null ? 0 : varstringSize(f.adoptOf.deviceId) + varstringSize(f.adoptOf.clientFrameId));
	return n + varbytesSize(f.sealed.length);
}

function isNsOrCfg(stream: StreamName): boolean {
	const cls = streamClass(stream);
	return cls === "ns" || cls === "cfg";
}

/**
 * Size limit rule (§e.4). `maxBytes` bounds the sum of exact encoded frame
 * sizes (mirrorFrameSize); the fixed header, frame count and checksum (about
 * 100 bytes for typical ids) are not counted.
 *
 * Within the limit every record is kept. Over it, every ns/cfg frame is kept
 * (even if they alone exceed the limit: their identity is what the mirror
 * exists for), then the other frames in `order` while they fit, stopping at
 * the first that does not. Keeping an order prefix means a kept frame's
 * dependency (lower order: an earlier body update, the adoptable it waits
 * for, the x: chunks of a bodyUpdateRef) is kept too. Dropped body edits are
 * still on disk and are re-derived by reconcile.
 *
 * Input order is arbitrary; output is sorted by order. Poisoned records are
 * included (state code 4).
 */
export function selectMirrorFrames(records: readonly OutboxRecord[], maxBytes: number): OutboxMirrorFrame[] {
	const items = records.map((r) => {
		const frame = toMirrorFrame(r);
		return { frame, size: mirrorFrameSize(frame), priority: isNsOrCfg(r.stream) };
	});
	items.sort((x, y) => x.frame.order - y.frame.order);
	let total = 0;
	for (const it of items) total += it.size;
	if (total <= maxBytes) return items.map((it) => it.frame);

	let used = 0;
	for (const it of items) if (it.priority) used += it.size;
	const kept = new Set<(typeof items)[number]>(items.filter((it) => it.priority));
	for (const it of items) {
		if (it.priority) continue;
		if (used + it.size > maxBytes) break;
		used += it.size;
		kept.add(it);
	}
	return items.filter((it) => kept.has(it)).map((it) => it.frame);
}
