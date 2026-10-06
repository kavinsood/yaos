/**
 * Snapshot bundle zip (format zip-v1, DESIGN §j.4): written incrementally, read as a stream, fail closed.
 *
 * Writer: per entry a local header that already carries crc32, compressed and uncompressed size (flags 0x0800
 * UTF-8 names, no data descriptor, no extra field), method 8 (deflate) when smaller else 0 (stored), DOS date
 * 1980-01-01; then the central directory and the end record. No zip64: at most ZIP_MAX_ENTRIES entries and
 * offsets < 4 GiB (the bundle is bounded far below that). Standard unzip tools read it.
 *
 * Reader: accepts only what the writer produces. It walks local headers in order (never scans for signatures),
 * bounds every entry, inflates with an output bound, checks size and crc32, then requires the central directory
 * and the end record to repeat the local entries exactly, with no trailing bytes. Any deviation throws ZipError:
 * "truncated" when the input ends early, else "zip-decode".
 */

import { deflateSync, Inflate } from "fflate";
import { utf8DecodeStrict, utf8Encode } from "../codec/lib0";

export const ZIP_MAX_ENTRIES = 65_001;
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800, DOS_DATE_1980 = 0x0021, VERSION = 20;
const MAX_NAME_BYTES = 2048;

export type ZipCheck = "zip-decode" | "truncated";
export class ZipError extends Error {
	constructor(readonly check: ZipCheck, message: string) { super(message); }
}

// ---- crc32 ------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
export function crc32(bytes: Uint8Array, crc = 0): number {
	let c = ~crc;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return ~c >>> 0;
}

// ---- writer -----------------------------------------------------------------------------------------------

interface CentralEntry { readonly name: Uint8Array; readonly method: number; readonly crc: number; readonly csize: number; readonly usize: number; readonly offset: number }

const u16 = (v: DataView, o: number, x: number) => v.setUint16(o, x, true);
const u32 = (v: DataView, o: number, x: number) => v.setUint32(o, x >>> 0, true);

export class ZipWriter {
	private offset = 0;
	private readonly central: CentralEntry[] = [];

	/** `sink` receives the zip bytes in order; chunks are not retained. */
	constructor(private readonly sink: (chunk: Uint8Array) => Promise<void>) {}

	get bytesWritten(): number { return this.offset; }

	/** Adds one entry; `compress` tries deflate and keeps it only when smaller. */
	async add(name: string, data: Uint8Array, compress: boolean): Promise<void> {
		if (this.central.length >= ZIP_MAX_ENTRIES) throw new Error("zip: too many entries");
		const nameBytes = utf8Encode(name);
		if (nameBytes.length > MAX_NAME_BYTES) throw new Error("zip: name too long");
		const z = compress && data.length > 0 ? deflateSync(data, { level: 6 }) : null;
		const body = z && z.length < data.length ? z : data;
		const e: CentralEntry = { name: nameBytes, method: body === data ? 0 : 8, crc: crc32(data), csize: body.length, usize: data.length, offset: this.offset };
		const h = new Uint8Array(30 + nameBytes.length);
		const v = new DataView(h.buffer);
		u32(v, 0, SIG_LOCAL); u16(v, 4, VERSION); u16(v, 6, FLAG_UTF8); u16(v, 8, e.method); u16(v, 10, 0); u16(v, 12, DOS_DATE_1980);
		u32(v, 14, e.crc); u32(v, 18, e.csize); u32(v, 22, e.usize); u16(v, 26, nameBytes.length); u16(v, 28, 0);
		h.set(nameBytes, 30);
		await this.emit(h);
		await this.emit(body);
		this.central.push(e);
	}

	/** Central directory + end record. */
	async finish(): Promise<void> {
		const cdOffset = this.offset;
		for (const e of this.central) {
			const h = new Uint8Array(46 + e.name.length);
			const v = new DataView(h.buffer);
			u32(v, 0, SIG_CENTRAL); u16(v, 4, VERSION); u16(v, 6, VERSION); u16(v, 8, FLAG_UTF8); u16(v, 10, e.method); u16(v, 12, 0); u16(v, 14, DOS_DATE_1980);
			u32(v, 16, e.crc); u32(v, 20, e.csize); u32(v, 24, e.usize); u16(v, 28, e.name.length); u16(v, 30, 0); u16(v, 32, 0);
			u16(v, 34, 0); u16(v, 36, 0); u32(v, 38, 0); u32(v, 42, e.offset);
			h.set(e.name, 46);
			await this.emit(h);
		}
		const end = new Uint8Array(22);
		const v = new DataView(end.buffer);
		u32(v, 0, SIG_END); u16(v, 4, 0); u16(v, 6, 0); u16(v, 8, this.central.length); u16(v, 10, this.central.length);
		u32(v, 12, this.offset - cdOffset); u32(v, 16, cdOffset); u16(v, 20, 0);
		await this.emit(end);
	}

	private async emit(b: Uint8Array): Promise<void> {
		if (this.offset + b.length > 0xffff_ffff) throw new Error("zip: over 4 GiB");
		this.offset += b.length;
		if (b.length > 0) await this.sink(b);
	}
}

// ---- reader -----------------------------------------------------------------------------------------------

/** Pulls the bundle in chunks (one part at a time); null = end of input. */
export type ChunkSource = () => Promise<Uint8Array | null>;

class ByteReader {
	private buf: Uint8Array = new Uint8Array(0);
	private pos = 0;
	offset = 0;
	constructor(private readonly src: ChunkSource) {}

	async exact(n: number): Promise<Uint8Array> {
		const out = new Uint8Array(n);
		let o = 0;
		while (o < n) {
			if (this.pos >= this.buf.length) {
				const next = await this.src();
				if (next === null) throw new ZipError("truncated", `zip: input ends at ${this.offset + o}`);
				this.buf = next; this.pos = 0;
				continue;
			}
			const k = Math.min(n - o, this.buf.length - this.pos);
			out.set(this.buf.subarray(this.pos, this.pos + k), o);
			o += k; this.pos += k;
		}
		this.offset += n;
		return out;
	}

	async atEnd(): Promise<boolean> {
		while (this.pos >= this.buf.length) {
			const next = await this.src();
			if (next === null) return true;
			this.buf = next; this.pos = 0;
		}
		return false;
	}
}

export interface ZipEntry { readonly name: string; readonly data: Uint8Array }
export interface ZipReadLimits {
	/** Max uncompressed bytes of one entry (may depend on the name). */
	readonly maxEntryBytes: (name: string) => number;
	readonly maxEntries?: number;
}

const bad = (m: string) => new ZipError("zip-decode", `zip: ${m}`);

function inflateBounded(z: Uint8Array, usize: number): Uint8Array {
	const out = new Uint8Array(usize);
	let o = 0;
	const s = new Inflate((chunk) => {
		if (o + chunk.length > usize) throw bad("entry inflates past its size");
		out.set(chunk, o);
		o += chunk.length;
	});
	const STEP = 64 * 1024;
	try {
		if (z.length === 0) s.push(z, true);
		for (let i = 0; i < z.length; i += STEP) s.push(z.subarray(i, i + STEP), i + STEP >= z.length);
	} catch (e) {
		if (e instanceof ZipError) throw e;
		throw bad(`invalid deflate data (${e instanceof Error ? e.message : String(e)})`);
	}
	if (o !== usize) throw bad("entry size mismatch");
	return out;
}

/** Yields every entry in order, verified; throws ZipError at the first deviation (see the module comment). */
export async function* readZip(src: ChunkSource, limits: ZipReadLimits): AsyncGenerator<ZipEntry, void, undefined> {
	const r = new ByteReader(src);
	const maxEntries = limits.maxEntries ?? ZIP_MAX_ENTRIES;
	const local: CentralEntry[] = [];
	let sig = new DataView((await r.exact(4)).buffer).getUint32(0, true);
	while (sig === SIG_LOCAL) {
		if (local.length >= maxEntries) throw bad("too many entries");
		const offset = r.offset - 4;
		const v = new DataView((await r.exact(26)).buffer);
		const [ver, flags, method, time, date] = [v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true), v.getUint16(6, true), v.getUint16(8, true)];
		const [crc, csize, usize, nameLen, extraLen] = [v.getUint32(10, true), v.getUint32(14, true), v.getUint32(18, true), v.getUint16(22, true), v.getUint16(24, true)];
		if (ver > VERSION || flags !== FLAG_UTF8 || time !== 0 || date !== DOS_DATE_1980 || extraLen !== 0) throw bad("unsupported local header");
		if (nameLen === 0 || nameLen > MAX_NAME_BYTES) throw bad("bad name length");
		const nameBytes = await r.exact(nameLen);
		let name: string;
		try { name = utf8DecodeStrict(nameBytes); } catch { throw bad("name is not UTF-8"); }
		if (usize > limits.maxEntryBytes(name)) throw bad(`entry too large: ${name}`);
		if (method === 0 ? csize !== usize : method !== 8 || csize >= usize) throw bad("bad method or sizes");
		const body = await r.exact(csize);
		const data = method === 0 ? body : inflateBounded(body, usize);
		if (crc32(data) !== crc) throw bad(`crc mismatch: ${name}`);
		local.push({ name: nameBytes, method, crc, csize, usize, offset });
		yield { name, data };
		sig = new DataView((await r.exact(4)).buffer).getUint32(0, true);
	}
	const cdOffset = r.offset - 4;
	for (const e of local) {
		if (sig !== SIG_CENTRAL) throw bad("central directory is shorter than the entries");
		const v = new DataView((await r.exact(42)).buffer);
		const same = v.getUint16(0, true) === VERSION && v.getUint16(2, true) === VERSION && v.getUint16(4, true) === FLAG_UTF8
			&& v.getUint16(6, true) === e.method && v.getUint16(8, true) === 0 && v.getUint16(10, true) === DOS_DATE_1980
			&& v.getUint32(12, true) === e.crc && v.getUint32(16, true) === e.csize && v.getUint32(20, true) === e.usize
			&& v.getUint16(24, true) === e.name.length && v.getUint16(26, true) === 0 && v.getUint16(28, true) === 0
			&& v.getUint16(30, true) === 0 && v.getUint16(32, true) === 0 && v.getUint32(34, true) === 0 && v.getUint32(38, true) === e.offset;
		if (!same) throw bad("central directory differs from the local headers");
		const name = await r.exact(e.name.length);
		if (name.some((b, i) => b !== e.name[i])) throw bad("central directory name differs");
		sig = new DataView((await r.exact(4)).buffer).getUint32(0, true);
	}
	if (sig !== SIG_END) throw bad("missing end record");
	const v = new DataView((await r.exact(18)).buffer);
	if (v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 0 || v.getUint16(4, true) !== local.length || v.getUint16(6, true) !== local.length
		|| v.getUint32(8, true) !== r.offset - 22 - cdOffset || v.getUint32(12, true) !== cdOffset || v.getUint16(16, true) !== 0) throw bad("bad end record");
	if (!(await r.atEnd())) throw bad("trailing bytes after the end record");
}
