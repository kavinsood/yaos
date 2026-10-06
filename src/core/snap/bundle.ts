/**
 * Snapshot bundle contents (format zip-v1, DESIGN §j.4): the manifest, the bundle digest, the per-entry checks
 * and the part cutter. Pure; the engine's SnapshotJob drives these through its ports.
 *
 * Bundle = zip entries `files/<path>` (manifest order), then `manifest.json`. The zip is cut into parts of
 * `partSize` bytes (the last may be shorter), each hashed with SHA-256 on its own (there is no incremental
 * SHA-256 in core). Every file is hashed in the manifest (exactFingerprint). The bundle digest binds them:
 *
 *   bundleDigest = SHA-256( "yaos/snap-bundle/1" || varstring snapshotId || varuint partCount
 *                           || for each part: varuint size || 32B sha256(part)
 *                           || 32B sha256(manifest.json bytes) )
 */

import type { ContentHash, DocKind, VaultPath } from "../types";
import { kindOfPath } from "../types";
import { Writer, hexToBytes, utf8DecodeStrict, utf8Encode } from "../codec/lib0";
import { sha256Hex } from "../hash/sha256";
import { parseCanvasBytes } from "../hash/canvasCanonical";
import { pathInvalidReason } from "../paths/validate";
import { SNAP_MAX_FILES, SNAP_REASONS, parseSnapshotId, type SnapReason } from "./record";

const MIB = 1024 * 1024;
export const SNAP_MANIFEST = "manifest.json";
export const SNAP_ENTRY_PREFIX = "files/";
export const SNAP_MAX_MANIFEST_BYTES = 16 * MIB;
export const SNAP_MAX_BLOB_BYTES = 1 * MIB;
/** Markdown / canvas files above this are skipped as too large (MAX_DOC_TEXT_CHARS x 4 UTF-8 bytes). */
export const SNAP_MAX_TEXT_BYTES = 32 * MIB;
export const SNAP_DEFAULT_PART_BYTES = 8 * MIB;

export type SnapSkipReason = "too-large" | "unreadable" | "invalid";
export interface SnapManifestFile { readonly path: VaultPath; readonly kind: DocKind; readonly hash: ContentHash; readonly size: number }
export interface SnapManifest {
	readonly formatVersion: 1;
	readonly id: string;
	readonly createdAtMs: number;
	readonly reason: SnapReason;
	readonly files: readonly SnapManifestFile[];
	readonly skipped: readonly { readonly path: string; readonly reason: SnapSkipReason }[];
}

/** The verification steps of DESIGN §j.4; any failure is `content_corrupt` for the whole snapshot. */
export type SnapCheck =
	| "part-missing" | "part-size" | "part-hash" | "truncated" | "zip-decode" | "manifest-invalid" | "manifest-mismatch"
	| "bundle-digest" | "path-invalid" | "content-invalid" | "file-hash";

export class SnapCorrupt extends Error {
	constructor(readonly check: SnapCheck, readonly detail: string) { super(`${check}: ${detail}`); }
}

export function maxEntryBytes(kind: DocKind): number {
	return kind === "blob" ? SNAP_MAX_BLOB_BYTES : SNAP_MAX_TEXT_BYTES;
}
/** Zip-level bound per entry name (unknown names may be at most 0 bytes; the entry check then rejects them). */
export function maxZipEntryBytes(name: string): number {
	if (name === SNAP_MANIFEST) return SNAP_MAX_MANIFEST_BYTES;
	return name.startsWith(SNAP_ENTRY_PREFIX) ? maxEntryBytes(kindOfPath(name.slice(SNAP_ENTRY_PREFIX.length) as VaultPath)) : 0;
}

export function bundleDigest(snapshotId: string, parts: readonly { readonly size: number; readonly sha256: string }[], manifestSha256: string): ContentHash {
	const w = new Writer(64 + parts.length * 40);
	w.raw(utf8Encode("yaos/snap-bundle/1")).varstring(snapshotId).varuint(parts.length);
	for (const p of parts) w.varuint(p.size).fixed(hexToBytes(p.sha256), 32);
	w.fixed(hexToBytes(manifestSha256), 32);
	return sha256Hex(w.finish()) as ContentHash;
}

/** Content check shared by export (skip as "invalid") and restore (corrupt): null = restorable. */
export function contentProblem(kind: DocKind, data: Uint8Array): string | null {
	if (data.length > maxEntryBytes(kind)) return "too large";
	if (kind === "canvas") {
		const p = parseCanvasBytes(data);
		if (p.kind === "invalid") return "canvas does not parse";
		if (p.kind === "oversized" && !isUtf8(data)) return "canvas is not UTF-8";
	} else if (kind === "markdown" && !isUtf8(data)) return "markdown is not UTF-8";
	return null;
}
function isUtf8(data: Uint8Array): boolean {
	try { utf8DecodeStrict(data); return true; } catch { return false; }
}

/** Entry check on restore: name -> vault path, validated with the ns path rules (DESIGN §c.2). */
export function entryPath(name: string): VaultPath {
	if (!name.startsWith(SNAP_ENTRY_PREFIX)) throw new SnapCorrupt("manifest-mismatch", `unexpected entry ${JSON.stringify(name.slice(0, 80))}`);
	const path = name.slice(SNAP_ENTRY_PREFIX.length);
	const why = pathInvalidReason(path);
	if (why) throw new SnapCorrupt("path-invalid", `${why}: ${JSON.stringify(path.slice(0, 80))}`);
	return path as VaultPath;
}

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const KINDS: readonly DocKind[] = ["markdown", "canvas", "blob"];
const SKIPS: readonly SnapSkipReason[] = ["too-large", "unreadable", "invalid"];

/** Strict manifest parse; throws SnapCorrupt("manifest-invalid"). File paths are checked by the caller (path-invalid). */
export function parseManifest(bytes: Uint8Array): SnapManifest {
	const fail = (m: string) => new SnapCorrupt("manifest-invalid", m);
	if (bytes.length > SNAP_MAX_MANIFEST_BYTES) throw fail("too large");
	let raw: unknown;
	try { raw = JSON.parse(utf8DecodeStrict(bytes)); } catch { throw fail("not UTF-8 JSON"); }
	if (!isObj(raw) || raw.formatVersion !== 1) throw fail("formatVersion");
	const id = typeof raw.id === "string" ? parseSnapshotId(raw.id) : null;
	if (!id || raw.createdAtMs !== id.createdAtMs || raw.reason !== id.reason || !SNAP_REASONS.includes(raw.reason as SnapReason)) throw fail("id");
	if (!Array.isArray(raw.files) || raw.files.length > SNAP_MAX_FILES) throw fail("files");
	if (!Array.isArray(raw.skipped) || raw.skipped.length > SNAP_MAX_FILES) throw fail("skipped");
	const files: SnapManifestFile[] = [];
	for (const f of raw.files as unknown[]) {
		if (!isObj(f) || typeof f.path !== "string" || !KINDS.includes(f.kind as DocKind) || typeof f.hash !== "string" || !HEX64.test(f.hash)
			|| !Number.isSafeInteger(f.size) || (f.size as number) < 0) throw fail("file entry");
		files.push({ path: f.path as VaultPath, kind: f.kind as DocKind, hash: f.hash as ContentHash, size: f.size as number });
	}
	const skipped: { path: string; reason: SnapSkipReason }[] = [];
	for (const s of raw.skipped as unknown[]) {
		if (!isObj(s) || typeof s.path !== "string" || s.path.length > 4096 || !SKIPS.includes(s.reason as SnapSkipReason)) throw fail("skipped entry");
		skipped.push({ path: s.path, reason: s.reason as SnapSkipReason });
	}
	return { formatVersion: 1, id: raw.id as string, createdAtMs: id.createdAtMs, reason: id.reason, files, skipped };
}

export function encodeManifest(m: SnapManifest): Uint8Array {
	return utf8Encode(JSON.stringify({ formatVersion: m.formatVersion, id: m.id, createdAtMs: m.createdAtMs, reason: m.reason, files: m.files, skipped: m.skipped }));
}

export interface CutPart { readonly index: number; readonly bytes: Uint8Array; readonly sha256: ContentHash }

/**
 * Cuts a byte stream into parts of exactly `partSize` (the last may be shorter) and hands each, hashed, to `sink`.
 * Holds at most one part buffer.
 */
export class PartCutter {
	private buf: Uint8Array;
	private fill = 0;
	private index = 0;
	readonly parts: { readonly size: number; readonly sha256: ContentHash }[] = [];

	constructor(private readonly partSize: number, private readonly sink: (part: CutPart) => Promise<void>) {
		if (!Number.isSafeInteger(partSize) || partSize < 1) throw new Error("bad part size");
		this.buf = new Uint8Array(partSize);
	}

	async push(chunk: Uint8Array): Promise<void> {
		let o = 0;
		while (o < chunk.length) {
			const k = Math.min(chunk.length - o, this.partSize - this.fill);
			this.buf.set(chunk.subarray(o, o + k), this.fill);
			this.fill += k; o += k;
			if (this.fill === this.partSize) await this.flush();
		}
	}

	/** Flushes the last (short) part. */
	async end(): Promise<void> {
		if (this.fill > 0) await this.flush();
		this.buf = new Uint8Array(0);
	}

	private async flush(): Promise<void> {
		const bytes = this.buf.slice(0, this.fill);
		this.fill = 0;
		const hash = sha256Hex(bytes) as ContentHash;
		this.parts.push({ size: bytes.length, sha256: hash });
		await this.sink({ index: this.index++, bytes, sha256: hash });
	}
}
