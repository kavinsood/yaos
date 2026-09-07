import diff from "fast-diff";

export type TextDiffSegment = [-1 | 0 | 1, string];

/**
 * Myers diff is excellent for ordinary edits, but its worst case grows with
 * both the input length and edit distance. A wholesale rewrite of a large
 * note can therefore monopolise the event loop for minutes. Above this
 * irreducible-middle bound, preserve the exact common edges and replace the
 * middle as one edit. The result is deliberately coarser, but still exact and
 * linear-time; normal small edits retain character-level precision.
 */
// Keep this deliberately small. Myers is quadratic for unrelated strings: a
// 64 KiB + 64 KiB middle has taken tens of seconds in production-like tests.
// Common prefixes/suffixes are removed first, so ordinary edits in very large
// notes still take the exact path; only a genuinely wide changed region is
// coarsened.
export const MAX_EXACT_DIFF_TOTAL_CHARACTERS = 8 * 1024;
const LARGE_DIFF_ANCHOR_CHARACTERS = 256;
const LARGE_DIFF_MAX_DEPTH = 8;

function isHighSurrogate(value: number): boolean {
	return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
	return value >= 0xdc00 && value <= 0xdfff;
}

function isSafeBoundary(text: string, index: number): boolean {
	return index <= 0 || index >= text.length
		|| !isHighSurrogate(text.charCodeAt(index - 1))
		|| !isLowSurrogate(text.charCodeAt(index));
}

function commonPrefixLength(left: string, right: string): number {
	const limit = Math.min(left.length, right.length);
	let length = 0;
	while (length < limit && left.charCodeAt(length) === right.charCodeAt(length)) length++;
	// Never retain only the high half of a UTF-16 surrogate pair.
	if (length > 0 && length < limit
		&& isHighSurrogate(left.charCodeAt(length - 1))
		&& isLowSurrogate(left.charCodeAt(length))) length--;
	return length;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
	const limit = Math.min(left.length, right.length) - prefixLength;
	let length = 0;
	while (length < limit
		&& left.charCodeAt(left.length - length - 1) === right.charCodeAt(right.length - length - 1)) length++;
	const leftBoundary = left.length - length;
	const rightBoundary = right.length - length;
	// Never retain only the low half of a UTF-16 surrogate pair.
	if (length > 0 && (
		(isHighSurrogate(left.charCodeAt(leftBoundary - 1)) && isLowSurrogate(left.charCodeAt(leftBoundary)))
		|| (isHighSurrogate(right.charCodeAt(rightBoundary - 1)) && isLowSurrogate(right.charCodeAt(rightBoundary)))
	)) length--;
	return length;
}

function append(output: TextDiffSegment[], kind: -1 | 0 | 1, text: string): void {
	if (!text) return;
	const last = output[output.length - 1];
	if (last?.[0] === kind) last[1] += text;
	else output.push([kind, text]);
}

function commonAnchor(left: string, right: string): { left: number; right: number; text: string } | null {
	const sourceIsLeft = left.length <= right.length;
	const source = sourceIsLeft ? left : right;
	const target = sourceIsLeft ? right : left;
	if (source.length < LARGE_DIFF_ANCHOR_CHARACTERS) return null;
	const maximumStart = source.length - LARGE_DIFF_ANCHOR_CHARACTERS;
	const starts = [maximumStart >> 1, maximumStart >> 2, Math.floor(maximumStart * 3 / 4), 0, maximumStart];
	for (let start of starts) {
		while (start < maximumStart && !isSafeBoundary(source, start)) start++;
		let end = start + LARGE_DIFF_ANCHOR_CHARACTERS;
		while (end > start && !isSafeBoundary(source, end)) end--;
		const anchor = source.slice(start, end);
		if (anchor.length < LARGE_DIFF_ANCHOR_CHARACTERS - 2) continue;
		let match = target.indexOf(anchor);
		let attempts = 0;
		while (match !== -1 && attempts++ < 8) {
			if (isSafeBoundary(target, match) && isSafeBoundary(target, match + anchor.length)) {
				return sourceIsLeft
					? { left: start, right: match, text: anchor }
					: { left: match, right: start, text: anchor };
			}
			match = target.indexOf(anchor, match + 1);
		}
	}
	return null;
}

function appendBoundedDiff(left: string, right: string, output: TextDiffSegment[], depth: number): void {
	if (left === right) {
		append(output, 0, left);
		return;
	}
	const prefixLength = commonPrefixLength(left, right);
	const suffixLength = commonSuffixLength(left, right, prefixLength);
	append(output, 0, left.slice(0, prefixLength));
	const leftMiddle = left.slice(prefixLength, left.length - suffixLength);
	const rightMiddle = right.slice(prefixLength, right.length - suffixLength);
	const shorterMiddle = leftMiddle.length <= rightMiddle.length ? leftMiddle : rightMiddle;
	const longerMiddle = leftMiddle.length > rightMiddle.length ? leftMiddle : rightMiddle;

	const exactDiffIsBounded = leftMiddle.length + rightMiddle.length <= MAX_EXACT_DIFF_TOTAL_CHARACTERS
		// fast-diff handles containment without entering its Myers bisect path.
		|| longerMiddle.indexOf(shorterMiddle) !== -1;
	if (exactDiffIsBounded) {
		for (const [kind, text] of diff(leftMiddle, rightMiddle)) append(output, kind, text);
	} else {
		const anchor = depth < LARGE_DIFF_MAX_DEPTH ? commonAnchor(leftMiddle, rightMiddle) : null;
		if (anchor) {
			appendBoundedDiff(leftMiddle.slice(0, anchor.left), rightMiddle.slice(0, anchor.right), output, depth + 1);
			append(output, 0, anchor.text);
			appendBoundedDiff(
				leftMiddle.slice(anchor.left + anchor.text.length),
				rightMiddle.slice(anchor.right + anchor.text.length),
				output,
				depth + 1,
			);
		} else {
			append(output, -1, leftMiddle);
			append(output, 1, rightMiddle);
		}
	}
	append(output, 0, left.slice(left.length - suffixLength));
}

export function boundedTextDiff(left: string, right: string): TextDiffSegment[] {
	const output: TextDiffSegment[] = [];
	appendBoundedDiff(left, right, output, 0);
	return output;
}
