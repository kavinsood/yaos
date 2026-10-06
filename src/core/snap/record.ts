/**
 * Snapshot index stream `snap` (DESIGN §j.4): one small record per uploaded snapshot bundle, and the
 * `snapOps` content codec. Everything read from the relay is untrusted: decoding enforces every bound below,
 * and any violation makes the frame malformed (folded as empty, like nsOps / cfgOps). A put whose record
 * version is unknown is kept as `putUnknown` so the fold can report it and ignore it (forward compatibility).
 *
 *   varuint opCount (1..SNAP_MAX_OPS), then per op: u8 tag, varuint bodyLen, body
 *   put(1):   u8 recordVersion; version 1:
 *               varstring snapshotId, varuint createdAtMs, varstring deviceLabel, varstring reason, u8 format,
 *               varuint fileCount, varuint totalBytes, 32B bundleDigest,
 *               varuint partCount (1..SNAP_MAX_PARTS), partCount x {32B address, varuint size, 32B sha256}
 *   del(2):   varstring deviceId, varstring snapshotId
 *   floor(3): varuint createdAtMs   (the author's own snapshots created before it are deleted)
 *
 * Bytes after the known fields of an op body are ignored (DESIGN §b.3 forward-compatible fields).
 */

import type { ContentHash, DeviceId } from "../types";
import { CodecError, Reader, Writer, bytesToHex, hasLoneSurrogate, hexToBytes } from "../codec/lib0";
import { decodeTaggedOps } from "../codec/nsOps";

const MIB = 1024 * 1024;

export const SNAP_RECORD_VERSION = 1;
/** Bundle format 1: a zip with sizes in every local header, `files/<path>` entries, then `manifest.json`. */
export const SNAP_FORMAT_ZIP1 = 1;
/** Max file bytes in one snapshot (SNAPSHOT_MAX_BYTES). */
export const SNAP_MAX_TOTAL_BYTES = 256 * MIB;
export const SNAP_MAX_FILES = 65_000;
export const SNAP_MAX_PARTS = 512;
export const SNAP_MAX_PART_BYTES = 16 * MIB;
/** Bound on the zip itself (file bytes plus headers, central directory and manifest). */
export const SNAP_MAX_BUNDLE_BYTES = 320 * MIB;
export const SNAP_MAX_LABEL_BYTES = 256;
/** Max ops per snapOps frame (one upload is put + floor). */
export const SNAP_MAX_OPS = 16;
/** Live records listed per device (the view's cap; keepDaily is at most 90). */
export const SNAP_VIEW_PER_DEVICE = 100;

export const SNAP_REASONS = ["daily", "brake", "epoch", "idb", "restore", "manual"] as const;
export type SnapReason = (typeof SNAP_REASONS)[number];

export const SnapOpTag = { put: 1, del: 2, floor: 3 } as const;

export interface SnapPart {
	/** Blob address (CryptoPort.blobAddress(sha256)), 64 lowercase hex. */
	readonly address: string;
	readonly size: number;
	/** sha256 of the part's plaintext bytes. */
	readonly sha256: ContentHash;
}

export interface SnapRecord {
	readonly version: 1;
	readonly snapshotId: string;
	readonly createdAtMs: number;
	readonly deviceLabel: string;
	readonly reason: SnapReason;
	readonly format: number;
	readonly fileCount: number;
	readonly totalBytes: number;
	readonly bundleDigest: ContentHash;
	readonly parts: readonly SnapPart[];
}

export type SnapOp =
	| { readonly t: "put"; readonly record: SnapRecord }
	/** A put with a record version this client does not know: ignored by the fold, reported. */
	| { readonly t: "putUnknown"; readonly version: number }
	| { readonly t: "del"; readonly deviceId: DeviceId; readonly snapshotId: string }
	| { readonly t: "floor"; readonly createdAtMs: number };

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const ID_RE = /^([0-9a-z]{9})-(daily|brake|epoch|idb|restore|manual)$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** `<createdAtMs base36, 9 chars>-<reason>`: sorts by time. */
export function snapshotId(createdAtMs: number, reason: SnapReason): string {
	return `${Math.max(0, Math.floor(createdAtMs)).toString(36).padStart(9, "0")}-${reason}`;
}
export function parseSnapshotId(id: string): { readonly createdAtMs: number; readonly reason: SnapReason } | null {
	const m = typeof id === "string" ? ID_RE.exec(id) : null;
	return m ? { createdAtMs: parseInt(m[1]!, 36), reason: m[2] as SnapReason } : null;
}
export function isDeviceId(s: string): s is DeviceId {
	return typeof s === "string" && DEVICE_RE.test(s);
}
/** Fold key of a snapshot: deviceId + "/" + snapshotId. */
export function snapKey(deviceId: DeviceId, id: string): string {
	return `${deviceId}/${id}`;
}
/** Id the host sees for a snapshot listed from the index: `<snapshotId>@<deviceId>`. */
export function remoteSnapshotId(deviceId: DeviceId, id: string): string {
	return `${id}@${deviceId}`;
}
export function parseRemoteSnapshotId(s: string): { readonly deviceId: DeviceId; readonly snapshotId: string } | null {
	const at = typeof s === "string" ? s.indexOf("@") : -1;
	if (at < 0) return null;
	const id = s.slice(0, at);
	const dev = s.slice(at + 1);
	return parseSnapshotId(id) && isDeviceId(dev) ? { deviceId: dev, snapshotId: id } : null;
}

/** Device label cut to SNAP_MAX_LABEL_BYTES on a code point boundary, lone surrogates replaced. */
export function clampSnapLabel(label: string): string {
	let out = "";
	let n = 0;
	for (const ch of label) {
		const c = hasLoneSurrogate(ch) ? "\ufffd" : ch;
		const b = utf8Bytes(c);
		if (n + b > SNAP_MAX_LABEL_BYTES) break;
		out += c;
		n += b;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Validation (also applied to own records before they are sent)
// ---------------------------------------------------------------------------

function utf8Bytes(s: string): number {
	return new TextEncoder().encode(s).length;
}
const isCount = (n: number, max: number, min = 0) => Number.isSafeInteger(n) && n >= min && n <= max;

/** null = valid; else the first problem. */
export function snapRecordProblem(r: SnapRecord): string | null {
	const id = parseSnapshotId(r.snapshotId);
	if (!id) return "snapshotId";
	if (r.createdAtMs !== id.createdAtMs) return "createdAtMs does not match the id";
	if (r.reason !== id.reason) return "reason does not match the id";
	if (typeof r.deviceLabel !== "string" || hasLoneSurrogate(r.deviceLabel) || utf8Bytes(r.deviceLabel) > SNAP_MAX_LABEL_BYTES) return "deviceLabel";
	if (!isCount(r.format, 255)) return "format";
	if (!isCount(r.fileCount, SNAP_MAX_FILES)) return "fileCount";
	if (!isCount(r.totalBytes, SNAP_MAX_TOTAL_BYTES)) return "totalBytes";
	if (!HEX64_RE.test(r.bundleDigest)) return "bundleDigest";
	if (!Array.isArray(r.parts) || r.parts.length < 1 || r.parts.length > SNAP_MAX_PARTS) return "partCount";
	let sum = 0;
	for (const p of r.parts) {
		if (!HEX64_RE.test(p.address) || !HEX64_RE.test(p.sha256)) return "part address/sha256";
		if (!isCount(p.size, SNAP_MAX_PART_BYTES, 1)) return "part size";
		sum += p.size;
	}
	if (sum > SNAP_MAX_BUNDLE_BYTES) return "bundle size";
	return null;
}

export function isValidSnapOp(op: SnapOp): boolean {
	switch (op.t) {
		case "put": return snapRecordProblem(op.record) === null;
		case "putUnknown": return Number.isInteger(op.version) && op.version !== SNAP_RECORD_VERSION;
		case "del": return isDeviceId(op.deviceId) && parseSnapshotId(op.snapshotId) !== null;
		case "floor": return Number.isSafeInteger(op.createdAtMs) && op.createdAtMs >= 0;
		default: return false;
	}
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** Canonical put body of a version-1 record (also the local descriptor `snapshots/<id>.snap`). */
export function encodeSnapRecord(r: SnapRecord): Uint8Array {
	const problem = snapRecordProblem(r);
	if (problem) throw new CodecError(`snap record: ${problem}`);
	const w = new Writer(128 + r.parts.length * 72);
	w.u8(SNAP_RECORD_VERSION).varstring(r.snapshotId).varuint(r.createdAtMs).varstring(r.deviceLabel).varstring(r.reason)
		.u8(r.format).varuint(r.fileCount).varuint(r.totalBytes).fixed(hexToBytes(r.bundleDigest), 32).varuint(r.parts.length);
	for (const p of r.parts) w.fixed(hexToBytes(p.address), 32).varuint(p.size).fixed(hexToBytes(p.sha256), 32);
	return w.finish();
}

/** Reads a put body; throws CodecError on truncation or any bound. Unknown versions -> putUnknown. */
function readPut(r: Reader): SnapOp {
	const version = r.u8();
	if (version !== SNAP_RECORD_VERSION) return { t: "putUnknown", version };
	const snapshotId = r.varstring();
	const createdAtMs = r.varuint();
	const deviceLabel = r.varstring();
	const reason = r.varstring() as SnapReason;
	const format = r.u8();
	const fileCount = r.varuint();
	const totalBytes = r.varuint();
	const bundleDigest = bytesToHex(r.raw(32)) as ContentHash;
	const n = r.varuint();
	if (n < 1 || n > SNAP_MAX_PARTS) throw new CodecError(`snap partCount ${n}`);
	const parts: SnapPart[] = [];
	for (let i = 0; i < n; i++) {
		const address = bytesToHex(r.raw(32));
		const size = r.varuint();
		parts.push({ address, size, sha256: bytesToHex(r.raw(32)) as ContentHash });
	}
	const record: SnapRecord = { version: 1, snapshotId, createdAtMs, deviceLabel, reason, format, fileCount, totalBytes, bundleDigest, parts };
	const problem = snapRecordProblem(record);
	if (problem) throw new CodecError(`snap record: ${problem}`);
	return { t: "put", record };
}

/** Decodes a descriptor / put body; null when malformed or of an unknown version. */
export function decodeSnapRecord(bytes: Uint8Array): SnapRecord | null {
	if (bytes.length > SNAP_MAX_RECORD_BYTES) return null;
	try {
		const op = readPut(new Reader(bytes));
		return op.t === "put" ? op.record : null;
	} catch (e) {
		if (e instanceof CodecError) return null;
		throw e;
	}
}

/** Max bytes of one op body (a put with SNAP_MAX_PARTS parts and the longest label is ~37 KiB). */
export const SNAP_MAX_RECORD_BYTES = 48 * 1024;

export function encodeSnapOps(ops: readonly SnapOp[]): Uint8Array {
	if (ops.length < 1 || ops.length > SNAP_MAX_OPS) throw new CodecError(`snap opCount ${ops.length} out of range`);
	const w = new Writer(256);
	w.varuint(ops.length);
	for (const op of ops) {
		if (!isValidSnapOp(op)) throw new CodecError(`invalid snap op ${op.t}`);
		switch (op.t) {
			case "put": w.u8(SnapOpTag.put).varbytes(encodeSnapRecord(op.record)); break;
			case "putUnknown": throw new CodecError("putUnknown is decode-only");
			case "del": w.u8(SnapOpTag.del).varbytes(new Writer(64).varstring(op.deviceId).varstring(op.snapshotId).finish()); break;
			case "floor": w.u8(SnapOpTag.floor).varbytes(new Writer(8).varuint(op.createdAtMs).finish()); break;
		}
	}
	return w.finish();
}

function decodeOpBody(tag: number, r: Reader): SnapOp {
	if (r.remaining > SNAP_MAX_RECORD_BYTES) throw new CodecError("snap op body too large");
	switch (tag) {
		case SnapOpTag.put:
			return readPut(r);
		case SnapOpTag.del: {
			const deviceId = r.varstring();
			const id = r.varstring();
			if (!isDeviceId(deviceId) || !parseSnapshotId(id)) throw new CodecError("snap del: bad id");
			return { t: "del", deviceId, snapshotId: id };
		}
		case SnapOpTag.floor:
			return { t: "floor", createdAtMs: r.varuint() };
		default:
			throw new CodecError(`unknown snap op tag ${tag}`);
	}
}

/** null = malformed frame (folded as an empty frame). */
export function decodeSnapOps(content: Uint8Array): SnapOp[] | null {
	const ops = decodeTaggedOps(content, decodeOpBody);
	return ops && ops.length <= SNAP_MAX_OPS ? ops : null;
}
