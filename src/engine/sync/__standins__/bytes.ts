/**
 * STAND-IN for WP-A src/core/codec (lib0 helpers). Replace at integration.
 *
 * Writer: lib0 encoding. Reader: strict bounds-checked reader (lib0's decoder
 * does not bounds-check readUint8 / readUint8Array, and its string decoder is
 * not fatal on invalid UTF-8), so malformed input always throws CodecError.
 */

import * as encoding from "lib0/encoding";

export class CodecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodecError";
	}
}

const utf8Fatal = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
	return utf8Encoder.encode(text);
}
export function fromUtf8(bytes: Uint8Array): string {
	try {
		return utf8Fatal.decode(bytes);
	} catch {
		throw new CodecError("invalid utf-8");
	}
}

export class Writer {
	private readonly enc = encoding.createEncoder();
	u8(v: number): this {
		encoding.writeUint8(this.enc, v);
		return this;
	}
	varuint(v: number): this {
		if (!Number.isSafeInteger(v) || v < 0) throw new CodecError(`varuint out of range: ${v}`);
		encoding.writeVarUint(this.enc, v);
		return this;
	}
	varstring(s: string): this {
		this.varbytes(utf8Encoder.encode(s));
		return this;
	}
	varbytes(b: Uint8Array): this {
		encoding.writeVarUint8Array(this.enc, b);
		return this;
	}
	bytes(b: Uint8Array): this {
		encoding.writeUint8Array(this.enc, b);
		return this;
	}
	finish(): Uint8Array {
		return encoding.toUint8Array(this.enc);
	}
}

export class Reader {
	pos = 0;
	constructor(readonly buf: Uint8Array) {}
	get remaining(): number {
		return this.buf.length - this.pos;
	}
	done(): boolean {
		return this.pos >= this.buf.length;
	}
	u8(): number {
		if (this.pos >= this.buf.length) throw new CodecError("truncated");
		return this.buf[this.pos++] as number;
	}
	/** lib0 varuint; rejects values > 2^53-1 and non-minimal encodings. */
	varuint(): number {
		let num = 0;
		let mult = 1;
		let count = 0;
		for (;;) {
			const b = this.u8();
			count++;
			num += (b & 0x7f) * mult;
			if (num > Number.MAX_SAFE_INTEGER) throw new CodecError("varuint overflow");
			if (b < 0x80) {
				if (b === 0 && count > 1) throw new CodecError("non-minimal varuint");
				return num;
			}
			mult *= 128;
			if (count > 8) throw new CodecError("varuint too long");
		}
	}
	bytes(n: number): Uint8Array {
		if (n < 0 || this.pos + n > this.buf.length) throw new CodecError("truncated");
		const out = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return out;
	}
	varbytes(): Uint8Array {
		return this.bytes(this.varuint());
	}
	varstring(): string {
		return fromUtf8(this.varbytes());
	}
	rest(): Uint8Array {
		const out = this.buf.subarray(this.pos);
		this.pos = this.buf.length;
		return out;
	}
	end(): void {
		if (!this.done()) throw new CodecError("trailing bytes");
	}
}

const HEX = "0123456789abcdef";
export function toHex(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i] as number;
		s += (HEX[b >> 4] as string) + (HEX[b & 15] as string);
	}
	return s;
}
export function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new CodecError("bad hex");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
