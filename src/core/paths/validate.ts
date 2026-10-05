/**
 * Path validity (DESIGN §c.2). Ported from server/src/shared/vaultPath.ts and
 * legacy canonicalPath.ts, reworked to the frozen rules: NFC, Unicode 15.1
 * assigned code points only, no dot segments, reserved stems, byte limits.
 * These are FOLD rules (version 1).
 */

import type { VaultPath } from "../types";
import { FORBIDDEN_PATH_CHARS, MAX_PATH_BYTES, MAX_SEGMENT_BYTES, RESERVED_STEMS } from "../limits";
import { ASSIGNED_15_1 } from "./assigned15_1";
import { asciiLower, utf8ByteLength } from "./segments";

export type PathInvalidReason =
	| "empty"
	| "not-nfc"
	| "unassigned"
	| "empty-segment"
	| "dot-segment"
	| "forbidden-char"
	| "control-char"
	| "segment-too-long"
	| "path-too-long"
	| "reserved-stem"
	| "trailing-dot-or-space";

/** True iff the code point is assigned in Unicode 15.1 (surrogates are never assigned here). */
export function isAssigned15_1(cp: number): boolean {
	const r = ASSIGNED_15_1;
	let lo = 0;
	let hi = r.length / 2 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const a = r[mid * 2]!;
		const b = r[mid * 2 + 1]!;
		if (cp < a) hi = mid - 1;
		else if (cp > b) lo = mid + 1;
		else return true;
	}
	return false;
}

const RESERVED = new Set(RESERVED_STEMS);

/** Segment-level problems (no NFC / assignment / total-length checks). */
export function segmentInvalidReason(seg: string): PathInvalidReason | null {
	if (seg.length === 0) return "empty-segment";
	if (seg.charCodeAt(0) === 0x2e) return "dot-segment";
	for (let i = 0; i < seg.length; i++) {
		const c = seg.charCodeAt(i);
		if (c <= 0x1f || c === 0x7f) return "control-char";
		if (FORBIDDEN_PATH_CHARS.indexOf(seg[i]!) >= 0) return "forbidden-char";
	}
	const last = seg.charCodeAt(seg.length - 1);
	if (last === 0x2e || last === 0x20) return "trailing-dot-or-space";
	if (utf8ByteLength(seg) > MAX_SEGMENT_BYTES) return "segment-too-long";
	const dot = seg.indexOf(".");
	const stem = dot < 0 ? seg : seg.slice(0, dot);
	if (stem.length <= 4 && RESERVED.has(asciiLower(stem))) return "reserved-stem";
	return null;
}

/** DESIGN §c.2. null = valid. */
export function pathInvalidReason(path: string): PathInvalidReason | null {
	if (path.length === 0) return "empty";
	for (let i = 0; i < path.length; i++) {
		const c = path.charCodeAt(i);
		if (c < 0x80) continue;
		let cp = c;
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < path.length) {
			const d = path.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) { cp = (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000; i++; }
		}
		if (!isAssigned15_1(cp)) return "unassigned";
	}
	if (path.normalize("NFC") !== path) return "not-nfc";
	if (utf8ByteLength(path) > MAX_PATH_BYTES) return "path-too-long";
	for (const seg of path.split("/")) {
		const reason = segmentInvalidReason(seg);
		if (reason) return reason;
	}
	return null;
}

export function isValidPath(path: string): path is VaultPath {
	return pathInvalidReason(path) === null;
}
