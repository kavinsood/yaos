/**
 * Conflict copy names (DESIGN §f.7):
 *   `${stem} (conflict ${label} ${YYYY-MM-DD HHmm})${ext}` in the same folder,
 *   ` 2`, ` 3`, ... inside the parentheses when taken,
 *   `${stem} (conflict ${docId8})${ext}` when that is not a valid path.
 *
 * Decisions:
 * - Local time without Date: the caller passes `tzOffsetMinutes` (minutes
 *   east of UTC, i.e. -Date#getTimezoneOffset()). 0 = UTC.
 * - The result is ALWAYS a valid path: if even the fallback is invalid
 *   (overlong stem or folder), the stem is truncated on code points, and as a
 *   last resort the copy goes to the vault root as `conflict ${docId8}${ext}`.
 * - An empty label (after stripping) is omitted.
 */

import type { DocId, PathKey, PathKeyFn, VaultPath } from "../types";
import { FORBIDDEN_PATH_CHARS, SUFFIX_DOCID_CHARS } from "../limits";
import { isValidVaultPath, joinPath, leafOf, parentOf, splitExt } from "./pathRules";

export const MAX_LABEL_CHARS = 32;
const MAX_TAKEN_TRIES = 10_000;

export interface ConflictNameInput {
	readonly path: VaultPath;
	readonly docId: DocId | null;
	readonly deviceLabel: string;
	readonly nowMs: number;
	readonly tzOffsetMinutes: number;
	readonly pathKey: PathKeyFn;
	readonly isTaken: (key: PathKey) => boolean;
}

/** Strip forbidden / control chars and "/", collapse whitespace, cap at 32 code points. */
export function sanitizeLabel(label: string): string {
	let out = "";
	for (const ch of label.normalize("NFC")) {
		const c = ch.codePointAt(0)!;
		if (c < 0x20 || c === 0x7f || ch === "/" || FORBIDDEN_PATH_CHARS.includes(ch)) continue;
		if (c >= 0xd800 && c <= 0xdfff) continue; // lone surrogate
		out += ch;
	}
	out = out.replace(/\s+/g, " ").trim();
	return Array.from(out).slice(0, MAX_LABEL_CHARS).join("").trim();
}

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0");
}

/** "YYYY-MM-DD HHmm" of ms-since-epoch shifted by the offset (proleptic Gregorian, pure). */
export function formatLocalMinute(nowMs: number, tzOffsetMinutes: number): string {
	const ms = nowMs + tzOffsetMinutes * 60_000;
	const days = Math.floor(ms / 86_400_000);
	const minuteOfDay = Math.floor((ms - days * 86_400_000) / 60_000);
	// Howard Hinnant's civil_from_days.
	const z = days + 719_468;
	const era = Math.floor(z / 146_097);
	const doe = z - era * 146_097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp < 10 ? mp + 3 : mp - 9;
	const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} ${pad(Math.floor(minuteOfDay / 60), 2)}${pad(minuteOfDay % 60, 2)}`;
}

function trimStem(stem: string, maxCodePoints: number): string {
	return Array.from(stem).slice(0, maxCodePoints).join("").replace(/[. ]+$/, "");
}

function firstFree(make: (n: number) => VaultPath, input: ConflictNameInput): VaultPath | null {
	for (let n = 1; n <= MAX_TAKEN_TRIES; n++) {
		const candidate = make(n);
		if (!isValidVaultPath(candidate)) return null;
		if (!input.isTaken(input.pathKey(candidate))) return candidate;
	}
	return null;
}

export function conflictName(input: ConflictNameInput): VaultPath {
	const parent = parentOf(input.path);
	const { stem, ext } = splitExt(leafOf(input.path));
	const label = sanitizeLabel(input.deviceLabel);
	const time = formatLocalMinute(input.nowMs, input.tzOffsetMinutes);
	const tag = label === "" ? time : `${label} ${time}`;
	const primary = firstFree((n) => joinPath(parent, `${stem} (conflict ${tag}${n > 1 ? ` ${n}` : ""})${ext}`), input);
	if (primary) return primary;

	const id8 = (input.docId ?? "nodocid0").slice(0, SUFFIX_DOCID_CHARS);
	const fallback = (s: string, dir: string) => (n: number) => joinPath(dir, `${s}${s === "" ? "" : " "}(conflict ${id8}${n > 1 ? ` ${n}` : ""})${ext}`);
	const plain = firstFree(fallback(stem, parent), input);
	if (plain) return plain;
	// Overlong: shrink the stem until it fits.
	for (let keep = Math.min(Array.from(stem).length, 200); keep >= 0; keep = keep > 16 ? Math.floor(keep / 2) : keep - 1) {
		const s = trimStem(stem, keep);
		const found = firstFree(fallback(s, parent), input);
		if (found) return found;
	}
	// Folder itself too deep: vault root.
	const root = firstFree((n) => `conflict ${id8}${n > 1 ? ` ${n}` : ""}${isValidVaultPath(`x${ext}`) ? ext : ""}`, input);
	if (root) return root;
	return `conflict ${id8} ${input.nowMs}`;
}

/** The popup for conflict copies written in one burst: the first copy, and how many there were. */
export function conflictCopyNotice(first: { readonly from: string; readonly to: string }, count: number): string {
	return count <= 1
		? `YAOS could not merge two versions of “${first.from}”; the other version is saved as “${first.to}”.`
		: `YAOS could not merge ${count} files; the other versions are saved as conflict copies (first: “${first.to}”).`;
}
