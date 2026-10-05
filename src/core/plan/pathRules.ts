/**
 * §c.2 path validity and a pathKey stand-in.
 *
 * WP-A owns the real pathKey (frozen Unicode 15.1 case folding) and the
 * assigned-code-point table in src/core/paths/. Until integration everything
 * here takes a PathKeyFn; `standInPathKey` (NFC + toLowerCase) is ONLY a test
 * and default stand-in and must be replaced by WP-A's pathKey at integration.
 */

import type { PathKey, PathKeyFn, VaultPath } from "../types";
import { FORBIDDEN_PATH_CHARS, MAX_PATH_BYTES, MAX_SEGMENT_BYTES, RESERVED_STEMS } from "../limits";
import { utf8Length } from "../hash/utf8";

/** REPLACE AT INTEGRATION with WP-A's pathKey (src/core/paths/pathKey.ts). */
export const standInPathKey: PathKeyFn = (path: VaultPath): PathKey => path.normalize("NFC").toLowerCase().normalize("NFC") as PathKey;

const RESERVED = new Set(RESERVED_STEMS);

export type PathInvalidReason =
	| "empty" | "not-nfc" | "slash" | "empty-segment" | "dot-segment" | "forbidden-char" | "control-char"
	| "segment-too-long" | "path-too-long" | "reserved-stem" | "trailing-dot-or-space" | "lone-surrogate";

/**
 * §c.2 validity, minus the "assigned in Unicode 15.1" rule (needs WP-A's
 * frozen range table; `assigned` hook lets integration plug it in).
 */
export function pathInvalidReason(path: string, assigned?: (codePoint: number) => boolean): PathInvalidReason | null {
	if (path.length === 0) return "empty";
	if (path !== path.normalize("NFC")) return "not-nfc";
	if (path.startsWith("/") || path.endsWith("/")) return "slash";
	if (utf8Length(path) > MAX_PATH_BYTES) return "path-too-long";
	for (let i = 0; i < path.length; i++) {
		const c = path.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return "control-char";
		if (FORBIDDEN_PATH_CHARS.includes(path[i]!)) return "forbidden-char";
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = path.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return "lone-surrogate";
			if (assigned && !assigned(((c - 0xd800) << 10) + (next - 0xdc00) + 0x10000)) return "forbidden-char";
			i++;
			continue;
		}
		if (c >= 0xdc00 && c <= 0xdfff) return "lone-surrogate";
		if (assigned && !assigned(c)) return "forbidden-char";
	}
	for (const segment of path.split("/")) {
		if (segment.length === 0) return "empty-segment";
		if (segment.startsWith(".")) return "dot-segment"; // includes "." and ".."
		if (utf8Length(segment) > MAX_SEGMENT_BYTES) return "segment-too-long";
		if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing-dot-or-space";
		const dot = segment.indexOf(".");
		const stem = (dot < 0 ? segment : segment.slice(0, dot)).replace(/[A-Z]/g, (ch) => ch.toLowerCase());
		if (RESERVED.has(stem)) return "reserved-stem";
	}
	return null;
}

export function isValidVaultPath(path: string): boolean {
	return pathInvalidReason(path) === null;
}

export function parentOf(path: VaultPath): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

export function leafOf(path: VaultPath): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Split a leaf into stem and extension (last dot, not a leading dot). */
export function splitExt(leaf: string): { stem: string; ext: string } {
	const dot = leaf.lastIndexOf(".");
	if (dot <= 0) return { stem: leaf, ext: "" };
	return { stem: leaf.slice(0, dot), ext: leaf.slice(dot) };
}

export function joinPath(parent: string, leaf: string): VaultPath {
	return parent === "" ? leaf : `${parent}/${leaf}`;
}

/** Every proper ancestor folder of a path, shallowest first: "a/b/c.md" -> ["a", "a/b"]. */
export function ancestorsOf(path: VaultPath): string[] {
	const out: string[] = [];
	let i = path.indexOf("/");
	while (i >= 0) {
		out.push(path.slice(0, i));
		i = path.indexOf("/", i + 1);
	}
	return out;
}
