/**
 * Pure UTF-8 encode/decode (no TextEncoder dependency in core). Lone
 * surrogates encode as U+FFFD, like TextEncoder.
 */

export function utf8Encode(text: string): Uint8Array {
	let size = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) size += 1;
		else if (c < 0x800) size += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const d = text.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) { size += 4; i++; } else size += 3;
		} else size += 3;
	}
	const out = new Uint8Array(size);
	let o = 0;
	for (let i = 0; i < text.length; i++) {
		let c = text.charCodeAt(i);
		if (c < 0x80) { out[o++] = c; continue; }
		if (c < 0x800) {
			out[o++] = 0xc0 | (c >> 6);
			out[o++] = 0x80 | (c & 63);
			continue;
		}
		if (c >= 0xd800 && c <= 0xdfff) {
			const d = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
			if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
				const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
				i++;
				out[o++] = 0xf0 | (cp >> 18);
				out[o++] = 0x80 | ((cp >> 12) & 63);
				out[o++] = 0x80 | ((cp >> 6) & 63);
				out[o++] = 0x80 | (cp & 63);
				continue;
			}
			c = 0xfffd;
		}
		out[o++] = 0xe0 | (c >> 12);
		out[o++] = 0x80 | ((c >> 6) & 63);
		out[o++] = 0x80 | (c & 63);
	}
	return out;
}

/** UTF-8 byte length without allocating. */
export function utf8Length(text: string): number {
	let size = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) size += 1;
		else if (c < 0x800) size += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const d = text.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) { size += 4; i++; } else size += 3;
		} else size += 3;
	}
	return size;
}

/**
 * Decode UTF-8. `fatal` = return null on any malformed sequence; otherwise
 * malformed sequences become U+FFFD (WHATWG "replacement" semantics, one
 * U+FFFD per maximal invalid subpart).
 */
export function utf8Decode(bytes: Uint8Array, fatal: true): string | null;
export function utf8Decode(bytes: Uint8Array, fatal?: false): string;
export function utf8Decode(bytes: Uint8Array, fatal = false): string | null {
	const parts: string[] = [];
	let chunk: number[] = [];
	const flush = () => {
		if (chunk.length > 0) {
			parts.push(String.fromCharCode.apply(null, chunk));
			chunk = [];
		}
	};
	const push = (code: number) => {
		if (code > 0xffff) {
			code -= 0x10000;
			chunk.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
		} else chunk.push(code);
		if (chunk.length >= 8192) flush();
	};
	let i = 0;
	const n = bytes.length;
	while (i < n) {
		const b0 = bytes[i]!;
		if (b0 < 0x80) { push(b0); i++; continue; }
		let need = 0;
		let cp = 0;
		let lower = 0x80;
		let upper = 0xbf;
		if (b0 >= 0xc2 && b0 <= 0xdf) { need = 1; cp = b0 & 0x1f; }
		else if (b0 >= 0xe0 && b0 <= 0xef) {
			need = 2; cp = b0 & 0x0f;
			if (b0 === 0xe0) lower = 0xa0;
			if (b0 === 0xed) upper = 0x9f;
		} else if (b0 >= 0xf0 && b0 <= 0xf4) {
			need = 3; cp = b0 & 0x07;
			if (b0 === 0xf0) lower = 0x90;
			if (b0 === 0xf4) upper = 0x8f;
		} else {
			if (fatal) return null;
			push(0xfffd); i++; continue;
		}
		let j = 1;
		let ok = true;
		for (; j <= need; j++) {
			const b = i + j < n ? bytes[i + j]! : -1;
			const lo = j === 1 ? lower : 0x80;
			const hi = j === 1 ? upper : 0xbf;
			if (b < lo || b > hi) { ok = false; break; }
			cp = (cp << 6) | (b & 0x3f);
		}
		if (!ok) {
			if (fatal) return null;
			push(0xfffd);
			i += j;
			continue;
		}
		push(cp);
		i += need + 1;
	}
	flush();
	return parts.join("");
}
