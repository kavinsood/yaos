/**
 * Side-file mirrors (DESIGN §e.4, recovery use in §i.5).
 *
 * Two A/B side-file pairs survive IndexedDB loss:
 *  - outbox mirror (`outbox-a.bin` / `outbox-b.bin`): frame identity of own
 *    unacknowledged frames, so a resent frame dedupes instead of duplicating;
 *  - synced mirror (`synced-a.bin` / `synced-b.bin`): the Synced tree without
 *    base texts, so recovery can tell "unchanged since sync" from "edited".
 *
 * The byte formats are core/codec/mirrors.ts. This module adds the engine-side
 * rules on top: duplicate ids / orders / docIds are refused on encode and
 * rejected on decode (recovery imports into stores keyed by them), slot choice,
 * and the size-limit frame selection.
 *
 * Error model:
 *  - encode* throws CodecError on input that cannot be encoded faithfully
 *    (non-integer / negative numbers, unknown state or kind, contentHash that
 *    is not 64 lowercase hex chars, duplicate frame ids / orders / docIds);
 *  - decode* never throws on malformed bytes, it returns null. A HashPort that
 *    rejects is an environment fault, not a bad file, and propagates.
 */

import { streamClass } from "../../core/types";
import type { StreamName } from "../../core/types";
import type { HashPort } from "../../ports/crypto";
import { CodecError, utf8Encode } from "../../core/codec/lib0";
import * as codec from "../../core/codec/mirrors";
import type { OutboxMirror, OutboxMirrorFrame, OutboxRecord, SyncedMirror, SyncedMirrorEntry } from "../store/schema";

export type MirrorIdentity = codec.MirrorIdentity;

// ---------------------------------------------------------------------------
// Uniqueness rules
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

function duplicateDoc(entries: readonly SyncedMirrorEntry[]): string | null {
	const ids = new Set<string>();
	for (const e of entries) {
		if (ids.has(e.docId)) return `duplicate docId ${e.docId}`;
		ids.add(e.docId);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

export function encodeOutboxMirror(m: OutboxMirror, hash: HashPort): Promise<Uint8Array> {
	const dup = duplicateFrame(m.frames);
	if (dup !== null) return Promise.reject(new CodecError(dup));
	try {
		return codec.encodeOutboxMirror(m, hash);
	} catch (e) {
		return Promise.reject(e);
	}
}

/** null on bad magic, version, checksum, truncation, trailing bytes, bad codes / flags, invalid UTF-8, duplicate clientFrameId / order. */
export async function decodeOutboxMirror(bytes: Uint8Array, hash: HashPort): Promise<OutboxMirror | null> {
	const r = await codec.decodeOutboxMirror(bytes, hash);
	if (!r.ok || duplicateFrame(r.mirror.frames) !== null) return null;
	// Copy sealed: a view would pin the whole side-file buffer, and IndexedDB's
	// structured clone of a view stores its entire underlying ArrayBuffer.
	return { ...r.mirror, frames: r.mirror.frames.map((f) => ({ ...f, sealed: f.sealed.slice() })) };
}

export function encodeSyncedMirror(m: SyncedMirror, hash: HashPort): Promise<Uint8Array> {
	const dup = duplicateDoc(m.entries);
	if (dup !== null) return Promise.reject(new CodecError(dup));
	try {
		return codec.encodeSyncedMirror(m, hash);
	} catch (e) {
		return Promise.reject(e);
	}
}

/** null on bad magic, version, checksum, truncation, trailing bytes, bad kind code, invalid UTF-8, duplicate docId. */
export async function decodeSyncedMirror(bytes: Uint8Array, hash: HashPort): Promise<SyncedMirror | null> {
	const r = await codec.decodeSyncedMirror(bytes, hash);
	if (!r.ok || duplicateDoc(r.mirror.entries) !== null) return null;
	return r.mirror;
}

// ---------------------------------------------------------------------------
// A/B slots
// ---------------------------------------------------------------------------

/** core pickMirror (valid, identity match, highest generation; first wins a tie) plus the slot index. */
async function pickSlot<M extends MirrorIdentity & { readonly generation: number }>(
	files: readonly (Uint8Array | null)[],
	identity: MirrorIdentity,
	decode: (bytes: Uint8Array) => Promise<M | null>,
): Promise<{ mirror: M; slot: number } | null> {
	const slots: codec.MirrorDecodeResult<M>[] = [];
	for (const bytes of files) {
		const mirror = bytes ? await decode(bytes) : null;
		slots.push(mirror ? { ok: true, mirror } : { ok: false, reason: "malformed" });
	}
	const best = codec.pickMirror(slots, identity);
	if (best === null) return null;
	return { mirror: best, slot: slots.findIndex((s) => s.ok && s.mirror === best) };
}

/** Reader rule: the valid file (magic, checksum, identity match) with the highest generation; null if none. `slot` = index into files. */
export function pickOutboxMirror(
	files: readonly (Uint8Array | null)[],
	identity: MirrorIdentity,
	hash: HashPort,
): Promise<{ mirror: OutboxMirror; slot: number } | null> {
	return pickSlot(files, identity, (b) => decodeOutboxMirror(b, hash));
}

/** Reader rule for the synced mirror; same as pickOutboxMirror. */
export function pickSyncedMirror(
	files: readonly (Uint8Array | null)[],
	identity: MirrorIdentity,
	hash: HashPort,
): Promise<{ mirror: SyncedMirror; slot: number } | null> {
	return pickSlot(files, identity, (b) => decodeSyncedMirror(b, hash));
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
	return varbytesSize(utf8Encode(s).length);
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
