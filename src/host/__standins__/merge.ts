/**
 * STAND-IN for WP-B's src/core/merge/{merge,minimalDiff}.ts.
 * INTEGRATION: replace imports of this file with
 *   import { merge } from "../core/merge/merge";
 *   import { minimalDiff, type TextEdit } from "../core/merge/minimalDiff";
 * Same exported names and shapes (TextEdit = {start, end, text} on UTF-16 offsets).
 *
 * Conservative: identical / no-base conflict / one-sided exact; anything
 * two-sided is a conflict (crdt keeps its text, disk goes to the copy), so no
 * line is ever lost. minimalDiff is a single prefix/suffix-trimmed hunk.
 */

import type { MergeFn, MergeLimits } from "../../core/types";
import { MERGE_MAX_EDITS_PER_SIDE, MERGE_MAX_INPUT_CHARS } from "../../core/limits";

export interface TextEdit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export const DEFAULT_MERGE_LIMITS: MergeLimits = {
	maxInputChars: MERGE_MAX_INPUT_CHARS,
	maxEditsPerSide: MERGE_MAX_EDITS_PER_SIDE,
};

export const merge: MergeFn = ({ base, disk, crdt, limits }) => {
	if (disk === crdt) return { kind: "identical" };
	if (base === null) return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "no-base" };
	if (crdt === base) return { kind: "disk-only", text: disk };
	if (disk === base) return { kind: "crdt-only", text: crdt };
	if (Math.max(base.length, disk.length, crdt.length) > limits.maxInputChars) {
		return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "too-large" };
	}
	return { kind: "conflict", text: crdt, conflictCopy: disk, reason: "both-edited" };
};

function isHigh(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}
function isLow(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** One hunk replacing the differing middle; never splits a surrogate pair. */
export function minimalDiff(from: string, to: string): TextEdit[] {
	if (from === to) return [];
	let start = 0;
	const max = Math.min(from.length, to.length);
	while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
	if (start > 0 && start < from.length && isLow(from.charCodeAt(start)) && isHigh(from.charCodeAt(start - 1))) start--;
	let endFrom = from.length;
	let endTo = to.length;
	while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
		endFrom--;
		endTo--;
	}
	if (endFrom < from.length && isLow(from.charCodeAt(endFrom)) && endFrom > start && isHigh(from.charCodeAt(endFrom - 1))) {
		endFrom++;
		endTo++;
	}
	return [{ start, end: endFrom, text: to.slice(start, endTo) }];
}

export function applyTextEdits(from: string, edits: readonly TextEdit[]): string {
	const parts: string[] = [];
	let cursor = 0;
	for (const edit of edits) {
		parts.push(from.slice(cursor, edit.start), edit.text);
		cursor = edit.end;
	}
	parts.push(from.slice(cursor));
	return parts.join("");
}
