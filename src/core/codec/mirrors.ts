/**
 * Side-file mirror codecs (DESIGN §e.4): outbox mirror ("YAOSOBX1") and synced
 * mirror ("YAOSSYN1"), each followed by sha256(all preceding bytes).
 *
 * core/ cannot import engine/, so the shapes are declared structurally here;
 * they are identical to OutboxMirror / SyncedMirror in
 * src/engine/store/schema.ts (assignable both ways).
 */

import type { ClientFrameId, ContentHash, DeviceId, DocId, DocKind, Seq, StreamName, VaultEpoch, VaultId, VaultPath } from "../types";
import type { HashPort } from "../../ports/crypto";
import { CodecError, Reader, Writer, bytesEqual } from "./lib0";
import { bytesToHash, hashToBytes } from "./ids";
import { docKindCode, docKindFromCode } from "./nsOps";

/** "YAOSOBX1" */
export const OUTBOX_MIRROR_MAGIC = new Uint8Array([0x59, 0x41, 0x4f, 0x53, 0x4f, 0x42, 0x58, 0x31]);
/** "YAOSSYN1" */
export const SYNCED_MIRROR_MAGIC = new Uint8Array([0x59, 0x41, 0x4f, 0x53, 0x53, 0x59, 0x4e, 0x31]);
/**
 * The synced mirror's format: 2 adds each entry's decided delete (`fileGone`), the observed rename that took the
 * file away (`renamedTo`) and the disk content a refused commit left (`heldHash`): a store lost after a rename the
 * planner could not infer or carry out yet (ns not ready, write gate refused) would otherwise recover the record as a
 * plain sync point and read the moved file as new. Version 1 still decodes (none of them).
 */
export const MIRROR_FORMAT_VERSION = 2;
/**
 * The outbox mirror's format: 2 adds each frame's origins (identity-per-store §5.2: a frame inherited from a lost
 * predecessor store and re-issued under this one keeps the identity it had there, for the commit check); 3 adds the
 * docs with own outbox records the mirror does not carry (`unmirrored`). Versions 1 and 2 still decode (no list).
 */
export const OUTBOX_MIRROR_FORMAT_VERSION = 3;

/** A predecessor store's identity of a re-issued frame (identity-per-store §5.2 step 3): its deviceId, id and frameNo. */
export interface MirrorFrameOrigin {
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** ns / cfg frameNo (e2ee-design §8.2); 0 for none. */
	readonly frameNo: number;
}

/** "sent" (code 3) is no longer written (DB schema 2) but still decoded: older mirrors carry it; recovery imports it as pending. */
export type MirrorOutboxState = "held" | "pending" | "sent" | "poisoned" | "adoptable";
const OUTBOX_STATES: readonly MirrorOutboxState[] = ["held", "pending", "sent", "poisoned", "adoptable"];

export interface MirrorOutboxFrame {
	readonly clientFrameId: ClientFrameId;
	readonly stream: StreamName;
	readonly order: number;
	readonly state: MirrorOutboxState;
	readonly authorNsSeq: Seq;
	readonly dependsOn: ClientFrameId | null;
	readonly adoptOf: { readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId } | null;
	readonly sealed: Uint8Array;
	/** Inherited ns / cfg frames only (format 2): the identities it had in the predecessor stores, newest first. */
	readonly origins?: readonly MirrorFrameOrigin[];
}

export interface MirrorIdentity {
	readonly vaultId: VaultId;
	readonly vaultEpoch: VaultEpoch;
	readonly deviceId: DeviceId;
}

export interface OutboxMirrorData extends MirrorIdentity {
	readonly generation: number;
	readonly writtenAtMs: number;
	readonly frames: readonly MirrorOutboxFrame[];
	/**
	 * Format 3: docs with an own outbox record left out of `frames` (an unsealed stale copy, a frame over the size
	 * limit). Their edits live only in the store and on disk: a synced mirror's sync point for them may rest on those
	 * records, so recovery must not trust it (engine/runtime/mirrors.ts unmirroredDocs). Absent: none (or format < 3).
	 */
	readonly unmirrored?: readonly DocId[];
}

export interface SyncedMirrorEntryData {
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly kind: DocKind;
	readonly contentHash: ContentHash;
	readonly nsTouchSeq: Seq;
	readonly bodyRemoteSeq: Seq;
	readonly blobRev: Seq;
	/** Format 2: SyncedEntry.fileGone. */
	readonly fileGone?: true;
	/** Format 2: SyncedEntry.renamedTo (atMs floored to an integer). */
	readonly renamedTo?: { readonly to: VaultPath; readonly atMs: number };
	/** Format 2: SyncedEntry.heldHash. */
	readonly heldHash?: ContentHash;
}

export interface SyncedMirrorData extends MirrorIdentity {
	readonly generation: number;
	readonly writtenAtMs: number;
	readonly nsCoversSeq: Seq;
	readonly entries: readonly SyncedMirrorEntryData[];
	/**
	 * Format 2: the previous epoch's renames this store has not published yet (MetaPathMove, DESIGN §c.12
	 * "Renames"; atMs floored to an integer). Absent: none (or format 1).
	 */
	readonly moves?: readonly SyncedMirrorMoveData[];
}

export interface SyncedMirrorMoveData {
	readonly from: VaultPath;
	readonly to: VaultPath;
	readonly atMs: number;
}

export type MirrorDecodeResult<T> =
	| { readonly ok: true; readonly mirror: T }
	| { readonly ok: false; readonly reason: "bad-magic" | "bad-checksum" | "unsupported-version" | "malformed" };

type Sha = Pick<HashPort, "sha256">;

async function seal(w: Writer, hash: Sha): Promise<Uint8Array> {
	const body = w.finish();
	const digest = await hash.sha256(body);
	if (digest.length !== 32) throw new CodecError("sha256 must return 32 bytes");
	const out = new Uint8Array(body.length + 32);
	out.set(body);
	out.set(digest, body.length);
	return out;
}

async function open<T>(bytes: Uint8Array, magic: Uint8Array, hash: Sha, body: (r: Reader, version: number) => T, versions: readonly number[] = [MIRROR_FORMAT_VERSION]): Promise<MirrorDecodeResult<T>> {
	if (bytes.length < magic.length + 1 + 32 || !bytesEqual(bytes.subarray(0, magic.length), magic)) return { ok: false, reason: "bad-magic" };
	const payload = bytes.subarray(0, bytes.length - 32);
	const digest = await hash.sha256(payload);
	if (!bytesEqual(digest, bytes.subarray(bytes.length - 32))) return { ok: false, reason: "bad-checksum" };
	const r = new Reader(payload);
	r.raw(magic.length);
	const version = r.u8();
	if (!versions.includes(version)) return { ok: false, reason: "unsupported-version" };
	try {
		const mirror = body(r, version);
		r.end();
		return { ok: true, mirror };
	} catch (e) {
		if (e instanceof CodecError) return { ok: false, reason: "malformed" };
		throw e;
	}
}

function writeIdentity(w: Writer, m: MirrorIdentity & { generation: number; writtenAtMs: number }): void {
	w.varstring(m.vaultId).varstring(m.vaultEpoch).varstring(m.deviceId).varuint(m.generation).varuint(Math.max(0, Math.floor(m.writtenAtMs))); // ClockPort.now may be fractional
}
function readIdentity(r: Reader): MirrorIdentity & { generation: number; writtenAtMs: number } {
	const vaultId = r.varstring() as VaultId;
	const vaultEpoch = r.varstring();
	const deviceId = r.varstring() as DeviceId;
	const generation = r.varuint();
	return { vaultId, vaultEpoch, deviceId, generation, writtenAtMs: r.varuint() };
}

export function encodeOutboxMirror(m: OutboxMirrorData, hash: Sha): Promise<Uint8Array> {
	const w = new Writer(1024);
	w.raw(OUTBOX_MIRROR_MAGIC).u8(OUTBOX_MIRROR_FORMAT_VERSION);
	writeIdentity(w, m);
	w.varuint(m.frames.length);
	for (const f of m.frames) {
		const code = OUTBOX_STATES.indexOf(f.state) + 1;
		if (code === 0) throw new CodecError(`unknown outbox state ${String(f.state)}`);
		w.varstring(f.clientFrameId).varstring(f.stream).varuint(f.order).u8(code).varuint(f.authorNsSeq);
		if (f.dependsOn !== null) w.u8(1).varstring(f.dependsOn);
		else w.u8(0);
		if (f.adoptOf !== null) w.u8(1).varstring(f.adoptOf.deviceId).varstring(f.adoptOf.clientFrameId);
		else w.u8(0);
		const origins = f.origins ?? [];
		w.varuint(origins.length);
		for (const o of origins) w.varstring(o.deviceId).varstring(o.clientFrameId).varuint(o.frameNo);
		w.varbytes(f.sealed);
	}
	const unmirrored = m.unmirrored ?? [];
	w.varuint(unmirrored.length);
	for (const d of unmirrored) w.varstring(d);
	return seal(w, hash);
}

function readFlag(r: Reader): boolean {
	const b = r.u8();
	if (b > 1) throw new CodecError("flag must be 0 or 1");
	return b === 1;
}

export function decodeOutboxMirror(bytes: Uint8Array, hash: Sha): Promise<MirrorDecodeResult<OutboxMirrorData>> {
	return open(bytes, OUTBOX_MIRROR_MAGIC, hash, (r, version) => {
		const id = readIdentity(r);
		const n = r.varuint();
		const frames: MirrorOutboxFrame[] = [];
		for (let i = 0; i < n; i++) {
			const clientFrameId = r.varstring() as ClientFrameId;
			const stream = r.varstring() as StreamName;
			const order = r.varuint();
			const state = OUTBOX_STATES[r.u8() - 1];
			if (state === undefined) throw new CodecError("unknown outbox state");
			const authorNsSeq = r.varuint();
			const dependsOn = readFlag(r) ? (r.varstring() as ClientFrameId) : null;
			let adoptOf: MirrorOutboxFrame["adoptOf"] = null;
			if (readFlag(r)) {
				const deviceId = r.varstring() as DeviceId;
				adoptOf = { deviceId, clientFrameId: r.varstring() as ClientFrameId };
			}
			const origins: MirrorFrameOrigin[] = [];
			const no = version >= 2 ? r.varuint() : 0;
			for (let j = 0; j < no; j++) {
				const deviceId = r.varstring() as DeviceId;
				const clientFrameId = r.varstring() as ClientFrameId;
				origins.push({ deviceId, clientFrameId, frameNo: r.varuint() });
			}
			frames.push({ clientFrameId, stream, order, state, authorNsSeq, dependsOn, adoptOf, sealed: r.varbytes(), ...(origins.length > 0 ? { origins } : {}) });
		}
		const unmirrored: DocId[] = [];
		const nu = version >= 3 ? r.varuint() : 0;
		for (let j = 0; j < nu; j++) unmirrored.push(r.varstring() as DocId);
		return { ...id, frames, ...(unmirrored.length > 0 ? { unmirrored } : {}) };
	}, [1, 2, OUTBOX_MIRROR_FORMAT_VERSION]);
}

export function encodeSyncedMirror(m: SyncedMirrorData, hash: Sha): Promise<Uint8Array> {
	const w = new Writer(1024);
	w.raw(SYNCED_MIRROR_MAGIC).u8(MIRROR_FORMAT_VERSION);
	writeIdentity(w, m);
	w.varuint(m.nsCoversSeq).varuint(m.entries.length);
	for (const e of m.entries) {
		w.varstring(e.docId).varstring(e.path).u8(docKindCode(e.kind)).fixed(hashToBytes(e.contentHash), 32);
		w.varuint(e.nsTouchSeq).varuint(e.bodyRemoteSeq).varuint(e.blobRev);
		w.u8((e.fileGone ? 1 : 0) | (e.renamedTo ? 2 : 0) | (e.heldHash !== undefined ? 4 : 0));
		if (e.renamedTo) w.varstring(e.renamedTo.to).varuint(Math.max(0, Math.floor(e.renamedTo.atMs)));
		if (e.heldHash !== undefined) w.fixed(hashToBytes(e.heldHash), 32);
	}
	const moves = m.moves ?? [];
	w.varuint(moves.length);
	for (const mv of moves) w.varstring(mv.from).varstring(mv.to).varuint(Math.max(0, Math.floor(mv.atMs)));
	return seal(w, hash);
}

export function decodeSyncedMirror(bytes: Uint8Array, hash: Sha): Promise<MirrorDecodeResult<SyncedMirrorData>> {
	return open(bytes, SYNCED_MIRROR_MAGIC, hash, (r, version) => {
		const id = readIdentity(r);
		const nsCoversSeq = r.varuint();
		const n = r.varuint();
		const entries: SyncedMirrorEntryData[] = [];
		for (let i = 0; i < n; i++) {
			const docId = r.varstring() as DocId;
			const path = r.varstring();
			const kind = docKindFromCode(r.u8());
			const contentHash = bytesToHash(r.copy(32));
			const nsTouchSeq = r.varuint();
			const bodyRemoteSeq = r.varuint();
			const blobRev = r.varuint();
			const flags = version >= 2 ? r.u8() : 0;
			if (flags > 7) throw new CodecError("unknown synced entry flags");
			let renamedTo: SyncedMirrorEntryData["renamedTo"];
			if (flags & 2) {
				const to = r.varstring();
				renamedTo = { to, atMs: r.varuint() };
			}
			const heldHash = flags & 4 ? bytesToHash(r.copy(32)) : undefined;
			entries.push({
				docId, path, kind, contentHash, nsTouchSeq, bodyRemoteSeq, blobRev,
				...(flags & 1 ? { fileGone: true as const } : {}), ...(renamedTo ? { renamedTo } : {}), ...(heldHash !== undefined ? { heldHash } : {}),
			});
		}
		const moves: SyncedMirrorMoveData[] = [];
		const nm = version >= 2 ? r.varuint() : 0;
		for (let i = 0; i < nm; i++) {
			const from = r.varstring();
			const to = r.varstring();
			moves.push({ from, to, atMs: r.varuint() });
		}
		return { ...id, nsCoversSeq, entries, ...(moves.length > 0 ? { moves } : {}) };
	}, [1, MIRROR_FORMAT_VERSION]);
}

/**
 * Reader rule (DESIGN §e.4): among valid slots (decoded ok, identity equal to
 * the expected one), take the highest generation. null when none qualifies.
 */
export function pickMirror<T extends MirrorIdentity & { readonly generation: number }>(
	slots: readonly MirrorDecodeResult<T>[],
	identity: MirrorIdentity,
): T | null {
	let best: T | null = null;
	for (const s of slots) {
		if (!s.ok) continue;
		const m = s.mirror;
		if (m.vaultId !== identity.vaultId || m.vaultEpoch !== identity.vaultEpoch || m.deviceId !== identity.deviceId) continue;
		if (best === null || m.generation > best.generation) best = m;
	}
	return best;
}
