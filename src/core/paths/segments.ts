/**
 * Small pure string helpers for vault paths (DESIGN §c.2, §c.4). UTF-8 byte
 * counts are computed by code point, so lone surrogates count as U+FFFD (3 B),
 * matching TextEncoder.
 */

/** UTF-8 byte length of a JS string (lone surrogates count as 3 bytes, like TextEncoder's U+FFFD). */
export function utf8ByteLength(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const d = s.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; }
			else n += 3;
		} else n += 3;
	}
	return n;
}

export function splitPath(path: string): string[] {
	return path.split("/");
}

/** "a/b/c.md" -> "c.md". */
export function leafOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** "a/b/c.md" -> "a/b"; "c.md" -> "". */
export function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

/**
 * Splits a leaf into stem and extension for conflict suffixes (DESIGN §c.4):
 * ext is the last ".xxx" when the dot is not at position 0.
 */
export function splitExt(leaf: string): { stem: string; ext: string } {
	const i = leaf.lastIndexOf(".");
	if (i <= 0) return { stem: leaf, ext: "" };
	return { stem: leaf.slice(0, i), ext: leaf.slice(i) };
}

/** Drops the last code point of s (a surrogate pair counts as one). */
export function dropLastCodePoint(s: string): string {
	if (s.length === 0) return s;
	const last = s.charCodeAt(s.length - 1);
	if (last >= 0xdc00 && last <= 0xdfff && s.length >= 2) {
		const prev = s.charCodeAt(s.length - 2);
		if (prev >= 0xd800 && prev <= 0xdbff) return s.slice(0, -2);
	}
	return s.slice(0, -1);
}

/** Strips trailing "." and " " characters. */
export function stripTrailingDotsSpaces(s: string): string {
	let end = s.length;
	while (end > 0) {
		const c = s.charCodeAt(end - 1);
		if (c === 0x2e || c === 0x20) end--;
		else break;
	}
	return s.slice(0, end);
}

/** True iff the string is pure ASCII. */
export function isAscii(s: string): boolean {
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
	return true;
}

/** ASCII-only lowercasing (A-Z). */
export function asciiLower(s: string): string {
	let out = "";
	let changed = false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c >= 0x41 && c <= 0x5a) { changed = true; out += String.fromCharCode(c + 32); }
		else out += s[i];
	}
	return changed ? out : s;
}
