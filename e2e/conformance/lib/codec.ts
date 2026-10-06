/**
 * lib0-compatible binary codec for the streams wire (docs/client-remake/relay-wire.md §4), plus a raw-bytes
 * builder for deliberately malformed APPEND frames. Standalone: no lib0 import.
 */
const utf8 = new TextEncoder();
/** Strict decoder: server frames that carry invalid UTF-8 are reported, not silently repaired. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const APPEND = 0x01;
export const PROVISIONAL = 0x10;
export const COMMITTED = 0x11;
export const NOTICE = 0x12;

export class Writer {
	bytes: number[] = [];
	u8(value: number) { this.bytes.push(value & 0xff); return this; }
	varUint(value: number) {
		let n = value;
		while (n > 0x7f) { this.bytes.push(0x80 | (n & 0x7f)); n = Math.floor(n / 128); }
		this.bytes.push(n);
		return this;
	}
	raw(value: ArrayLike<number>) { for (let i = 0; i < value.length; i++) this.bytes.push(value[i]! & 0xff); return this; }
	varBytes(value: ArrayLike<number>) { this.varUint(value.length); return this.raw(value); }
	varString(value: string) { return this.varBytes(utf8.encode(value)); }
	done() { return new Uint8Array(this.bytes); }
}

export class Reader {
	pos = 0;
	buf: Uint8Array;
	constructor(buf: Uint8Array) { this.buf = buf; }
	u8() { if (this.pos >= this.buf.byteLength) throw new Error("eof"); return this.buf[this.pos++]!; }
	varUint() {
		let result = 0;
		let mult = 1;
		for (;;) {
			const b = this.u8();
			result += (b & 0x7f) * mult;
			if (b < 0x80) return result;
			mult *= 128;
			if (mult > 2 ** 53) throw new Error("varuint overflow");
		}
	}
	varBytes() {
		const length = this.varUint();
		if (this.pos + length > this.buf.byteLength) throw new Error("eof");
		const out = this.buf.slice(this.pos, this.pos + length);
		this.pos += length;
		return out;
	}
	varString() { return strictUtf8.decode(this.varBytes()); }
}

/** Fast path for large payloads (Writer uses a number[] and would be slow for 600 KiB frames). */
export function encodeAppend(stream: string, clientFrameId: string, payload: Uint8Array): Uint8Array {
	const head = new Writer().u8(APPEND).varString(stream).varString(clientFrameId).varUint(payload.byteLength).done();
	const out = new Uint8Array(head.byteLength + payload.byteLength);
	out.set(head);
	out.set(payload, head.byteLength);
	return out;
}

export function varUintBytes(value: number): number[] { return new Writer().varUint(value).bytes; }

export function concatBytes(...parts: ArrayLike<number>[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) { out.set(part, offset); offset += part.length; }
	return out;
}

/**
 * Raw APPEND builder: kind byte, then each field given as explicit length-prefix bytes + content bytes, so a
 * test can inject invalid UTF-8, non-minimal varuints or trailing bytes.
 */
export function rawAppend(fields: { streamLen?: number[]; stream: ArrayLike<number>; idLen?: number[]; id: ArrayLike<number>;
	payloadLen?: number[]; payload: ArrayLike<number>; trailing?: number[] }): Uint8Array {
	return concatBytes([APPEND],
		fields.streamLen ?? varUintBytes(fields.stream.length), fields.stream,
		fields.idLen ?? varUintBytes(fields.id.length), fields.id,
		fields.payloadLen ?? varUintBytes(fields.payload.length), fields.payload,
		fields.trailing ?? []);
}

export function utf8Bytes(value: string): Uint8Array { return utf8.encode(value); }

export interface ServerFrame {
	kind: "provisional" | "committed" | "notice";
	seq: number | null;
	stream: string;
	deviceId: string;
	clientFrameId: string;
	payload: Uint8Array | null;
}

/** Decodes one server -> client binary message. Throws on malformed input (incl. invalid UTF-8 / trailing bytes). */
export function decodeServerFrame(bytes: Uint8Array): ServerFrame {
	const r = new Reader(bytes);
	const kind = r.u8();
	let frame: ServerFrame;
	if (kind === PROVISIONAL) {
		frame = { kind: "provisional", seq: null, stream: r.varString(), deviceId: r.varString(), clientFrameId: r.varString(),
			payload: r.varBytes() };
	} else if (kind === COMMITTED || kind === NOTICE) {
		const seq = r.varUint();
		const stream = r.varString();
		const deviceId = r.varString();
		const clientFrameId = r.varString();
		frame = kind === COMMITTED
			? { kind: "committed", seq, stream, deviceId, clientFrameId, payload: r.varBytes() }
			: { kind: "notice", seq, stream, deviceId, clientFrameId, payload: null };
	} else {
		throw new Error(`unknown server frame kind ${kind}`);
	}
	if (r.pos !== bytes.byteLength) throw new Error(`server frame has ${bytes.byteLength - r.pos} trailing bytes`);
	return frame;
}
