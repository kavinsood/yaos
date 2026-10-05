/**
 * lib0-compatible binary primitives (DESIGN conventions): u8, varuint
 * (minimal unsigned LEB128, <= 2^53-1), varstring (varuint UTF-8 length +
 * bytes, decoded with a FATAL decoder that keeps a leading BOM), varbytes,
 * raw fixed-width bytes.
 *
 * The writer is byte-identical to lib0's encoding module. The reader is
 * stricter than lib0's decoding module: it rejects non-minimal varuints,
 * values > 2^53-1, truncation and invalid UTF-8, by throwing CodecError.
 * Public decoders catch CodecError and report "malformed".
 */

export class CodecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodecError";
	}
}

const MAX_SAFE = 9007199254740991; // 2^53 - 1

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8Encode(s: string): Uint8Array {
	return encoder.encode(s);
}

/** Throws CodecError on invalid UTF-8. A leading BOM is kept. */
export function utf8DecodeStrict(bytes: Uint8Array): string {
	try {
		return fatalDecoder.decode(bytes);
	} catch {
		throw new CodecError("invalid utf-8");
	}
}

/** True iff s is not well-formed UTF-16 (String.prototype.isWellFormed is ES2024). */
export function hasLoneSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0xd800 || c > 0xdfff) continue;
		if (c >= 0xdc00) return true;
		const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
		if (d < 0xdc00 || d > 0xdfff) return true;
		i++;
	}
	return false;
}

export class Writer {
	private buf: Uint8Array;
	private pos = 0;

	constructor(initial = 256) {
		this.buf = new Uint8Array(initial);
	}

	private ensure(n: number): void {
		if (this.pos + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.pos + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(0, this.pos));
		this.buf = next;
	}

	get length(): number {
		return this.pos;
	}

	u8(v: number): this {
		if (!Number.isInteger(v) || v < 0 || v > 255) throw new CodecError(`u8 out of range: ${v}`);
		this.ensure(1);
		this.buf[this.pos++] = v;
		return this;
	}

	varuint(v: number): this {
		if (!Number.isSafeInteger(v) || v < 0) throw new CodecError(`varuint out of range: ${v}`);
		this.ensure(8);
		while (v > 0x7f) {
			this.buf[this.pos++] = 0x80 | (v % 0x80);
			v = Math.floor(v / 0x80);
		}
		this.buf[this.pos++] = v;
		return this;
	}

	raw(bytes: Uint8Array): this {
		this.ensure(bytes.length);
		this.buf.set(bytes, this.pos);
		this.pos += bytes.length;
		return this;
	}

	/** Exactly n raw bytes (e.g. 32B hashes). */
	fixed(bytes: Uint8Array, n: number): this {
		if (bytes.length !== n) throw new CodecError(`expected ${n} bytes, got ${bytes.length}`);
		return this.raw(bytes);
	}

	varbytes(bytes: Uint8Array): this {
		this.varuint(bytes.length);
		return this.raw(bytes);
	}

	/** Throws CodecError on a lone surrogate (TextEncoder would silently write U+FFFD). */
	varstring(s: string): this {
		if (hasLoneSurrogate(s)) throw new CodecError("string has a lone surrogate");
		return this.varbytes(encoder.encode(s));
	}

	finish(): Uint8Array {
		return this.buf.slice(0, this.pos);
	}
}

export class Reader {
	pos = 0;
	constructor(readonly bytes: Uint8Array) {}

	get remaining(): number {
		return this.bytes.length - this.pos;
	}

	done(): boolean {
		return this.pos === this.bytes.length;
	}

	/** Throws unless every byte was consumed. */
	end(): void {
		if (this.pos !== this.bytes.length) throw new CodecError("trailing bytes");
	}

	u8(): number {
		if (this.pos >= this.bytes.length) throw new CodecError("truncated u8");
		return this.bytes[this.pos++]!;
	}

	varuint(): number {
		let value = 0;
		let mul = 1;
		for (let i = 0; i < 8; i++) {
			if (this.pos >= this.bytes.length) throw new CodecError("truncated varuint");
			const b = this.bytes[this.pos++]!;
			value += (b & 0x7f) * mul;
			if (b < 0x80) {
				if (i > 0 && b === 0) throw new CodecError("non-minimal varuint");
				if (value > MAX_SAFE) throw new CodecError("varuint > 2^53-1");
				return value;
			}
			mul *= 0x80;
		}
		throw new CodecError("varuint > 2^53-1");
	}

	raw(n: number): Uint8Array {
		if (n < 0 || this.pos + n > this.bytes.length) throw new CodecError("truncated bytes");
		const out = this.bytes.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}

	/** Copy of n bytes (decoded values never alias the input buffer). */
	copy(n: number): Uint8Array {
		return this.raw(n).slice();
	}

	varbytes(): Uint8Array {
		return this.copy(this.varuint());
	}

	varstring(): string {
		return utf8DecodeStrict(this.raw(this.varuint()));
	}

	rest(): Uint8Array {
		return this.copy(this.bytes.length - this.pos);
	}
}

// ---- hex / equality -----------------------------------------------------------

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]!;
		s += HEX[b >> 4]! + HEX[b & 15]!;
	}
	return s;
}

/** Lowercase hex only; throws CodecError otherwise. */
export function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new CodecError("invalid lowercase hex");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}

/** UTF-16 code-unit order (the canonical sort of DESIGN §b.5). */
export function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
