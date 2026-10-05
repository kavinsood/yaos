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
export const MIRROR_FORMAT_VERSION = 1;

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
}

export interface SyncedMirrorEntryData {
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly kind: DocKind;
	readonly contentHash: ContentHash;
	readonly nsTouchSeq: Seq;
	readonly bodyRemoteSeq: Seq;
	readonly blobRev: Seq;
}

export interface SyncedMirrorData extends MirrorIdentity {
	readonly generation: number;
	readonly writtenAtMs: number;
	readonly nsCoversSeq: Seq;
	readonly entries: readonly SyncedMirrorEntryData[];
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

async function open<T>(bytes: Uint8Array, magic: Uint8Array, hash: Sha, body: (r: Reader) => T): Promise<MirrorDecodeResult<T>> {
	if (bytes.length < magic.length + 1 + 32 || !bytesEqual(bytes.subarray(0, magic.length), magic)) return { ok: false, reason: "bad-magic" };
	const payload = bytes.subarray(0, bytes.length - 32);
	const digest = await hash.sha256(payload);
	if (!bytesEqual(digest, bytes.subarray(bytes.length - 32))) return { ok: false, reason: "bad-checksum" };
	const r = new Reader(payload);
	r.raw(magic.length);
	if (r.u8() !== MIRROR_FORMAT_VERSION) return { ok: false, reason: "unsupported-version" };
	try {
		const mirror = body(r);
		r.end();
		return { ok: true, mirror };
	} catch (e) {
		if (e instanceof CodecError) return { ok: false, reason: "malformed" };
		throw e;
	}
}

function writeIdentity(w: Writer, m: MirrorIdentity & { generation: number; writtenAtMs: number }): void {
	w.varstring(m.vaultId).varstring(m.vaultEpoch).varstring(m.deviceId).varuint(m.generation).varuint(m.writtenAtMs);
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
	w.raw(OUTBOX_MIRROR_MAGIC).u8(MIRROR_FORMAT_VERSION);
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
		w.varbytes(f.sealed);
	}
	return seal(w, hash);
}

function readFlag(r: Reader): boolean {
	const b = r.u8();
	if (b > 1) throw new CodecError("flag must be 0 or 1");
	return b === 1;
}

export function decodeOutboxMirror(bytes: Uint8Array, hash: Sha): Promise<MirrorDecodeResult<OutboxMirrorData>> {
	return open(bytes, OUTBOX_MIRROR_MAGIC, hash, (r) => {
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
			frames.push({ clientFrameId, stream, order, state, authorNsSeq, dependsOn, adoptOf, sealed: r.varbytes() });
		}
		return { ...id, frames };
	});
}

export function encodeSyncedMirror(m: SyncedMirrorData, hash: Sha): Promise<Uint8Array> {
	const w = new Writer(1024);
	w.raw(SYNCED_MIRROR_MAGIC).u8(MIRROR_FORMAT_VERSION);
	writeIdentity(w, m);
	w.varuint(m.nsCoversSeq).varuint(m.entries.length);
	for (const e of m.entries) {
		w.varstring(e.docId).varstring(e.path).u8(docKindCode(e.kind)).fixed(hashToBytes(e.contentHash), 32);
		w.varuint(e.nsTouchSeq).varuint(e.bodyRemoteSeq).varuint(e.blobRev);
	}
	return seal(w, hash);
}

export function decodeSyncedMirror(bytes: Uint8Array, hash: Sha): Promise<MirrorDecodeResult<SyncedMirrorData>> {
	return open(bytes, SYNCED_MIRROR_MAGIC, hash, (r) => {
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
			entries.push({ docId, path, kind, contentHash, nsTouchSeq, bodyRemoteSeq, blobRev: r.varuint() });
		}
		return { ...id, nsCoversSeq, entries };
	});
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
