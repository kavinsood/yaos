/**
 * Local tree helpers (DESIGN §f.1, §f.6): classification (kind, exclusion),
 * hashing of read bytes, and LocalEntry <-> LocalTreeRecord.
 *
 * Hashing is pure JS (core/hash) instead of HashPort: the engine runs in a
 * worker and core/hash is the single implementation of markdown-lf-v1 and the
 * canonical canvas hash. Recorded as a deviation in wp-b-notes.md.
 */

import type { ContentHash, DiskFingerprint, DocKind, LocalEntry, PathKey, PathKeyFn, VaultPath } from "../../core/types";
import { kindOfPath } from "../../core/types";
import { MAX_DOC_TEXT_CHARS } from "../../core/limits";
import { exactFingerprint, markdownContentHash } from "../../core/hash/markdownLf";
import { canvasContentHash } from "../../core/hash/canvasCanonical";
import { utf8Decode } from "../../core/hash/utf8";
import { isValidVaultPath, standInPathKey } from "../../core/plan/pathRules";
import type { LocalTreeRecord } from "../store/schema";

export interface ClassifySettings {
	readonly excludePatterns: readonly string[];
	readonly syncAttachments: boolean;
	readonly maxAttachmentBytes: number;
	/** Largest blob the active carrier accepts (BlobPort.maxBlobBytes or MAX_LOG_BLOB_BYTES). */
	readonly maxBlobBytes: number;
}

/** Bytes a markdown/canvas read may return (UTF-8 is at most 3 bytes per UTF-16 unit). */
export const MAX_TEXT_FILE_BYTES = MAX_DOC_TEXT_CHARS * 3;

/**
 * Exclude patterns: "folder/" (prefix), or a glob where `**` matches across
 * "/", `*` and `?` within one segment. A pattern also matches everything below
 * a folder it matches. Decision (the legacy client had several pattern
 * dialects): one small glob dialect, case-sensitive.
 */
export function compileExcludes(patterns: readonly string[]): (path: VaultPath) => boolean {
	const res: RegExp[] = [];
	for (const raw of patterns) {
		const p = raw.trim().replace(/^\/+/, "");
		if (p === "") continue;
		if (p.endsWith("/")) {
			const prefix = p;
			res.push(new RegExp(`^${escapeRe(prefix)}`));
			continue;
		}
		let re = "";
		for (let i = 0; i < p.length; i++) {
			const c = p[i]!;
			if (c === "*" && p[i + 1] === "*") {
				re += ".*";
				i++;
			} else if (c === "*") re += "[^/]*";
			else if (c === "?") re += "[^/]";
			else re += escapeRe(c);
		}
		res.push(new RegExp(`^${re}(?:/.*)?$`));
	}
	return (path) => res.some((r) => r.test(path));
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Classified {
	readonly path: VaultPath;
	readonly pathKey: PathKey;
	readonly kind: DocKind;
	readonly excluded: boolean;
	readonly reason: "invalid-path" | "pattern" | "attachments-off" | "too-large" | null;
	/** maxBytes for the content read. */
	readonly maxBytes: number;
}

export function classify(diskPath: string, size: number, settings: ClassifySettings, excludes: (p: VaultPath) => boolean, pathKey: PathKeyFn): Classified {
	const path = diskPath.normalize("NFC");
	const kind = kindOfPath(path);
	const valid = isValidVaultPath(path);
	// The real pathKey (WP-A) requires a valid path; invalid ones never reach the planner as live files.
	const key = valid ? pathKey(path) : standInPathKey(path);
	const maxBytes = kind === "blob" ? Math.min(settings.maxAttachmentBytes, settings.maxBlobBytes) : MAX_TEXT_FILE_BYTES;
	let reason: Classified["reason"] = null;
	if (!valid) reason = "invalid-path";
	else if (excludes(path)) reason = "pattern";
	else if (kind === "blob" && !settings.syncAttachments) reason = "attachments-off";
	else if (size > maxBytes) reason = "too-large";
	return { path, pathKey: key, kind, excluded: reason !== null, reason, maxBytes };
}

export interface Hashed {
	readonly hash: ContentHash;
	readonly fingerprint: DiskFingerprint;
}

/** Logical hash + exact fingerprint of file bytes. */
export function hashBytes(kind: DocKind, bytes: Uint8Array): Hashed {
	const fingerprint = exactFingerprint(bytes);
	if (kind === "markdown") return { hash: markdownContentHash(utf8Decode(bytes)), fingerprint };
	if (kind === "canvas") return { hash: canvasContentHash(bytes), fingerprint };
	return { hash: fingerprint as string as ContentHash, fingerprint };
}

export function toRecord(e: LocalEntry): LocalTreeRecord {
	return {
		pathKey: e.pathKey, diskPath: e.diskPath, path: e.path, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs,
		hash: e.hash, fingerprint: e.fingerprint, hashedAtMs: e.hashedAtMs,
	};
}

export function fromRecord(r: LocalTreeRecord, excluded: boolean): LocalEntry {
	return {
		diskPath: r.diskPath, path: r.path, pathKey: r.pathKey, kind: r.kind, size: r.size, mtimeMs: r.mtimeMs,
		hash: excluded ? null : r.hash, fingerprint: excluded ? null : r.fingerprint, hashedAtMs: r.hashedAtMs, excluded, bound: false,
	};
}
