// H2 dedupe window (DECISIONS §4 H2): a resend is deduplicated exactly when its original is among the newest W
// stored-row bytes of its stream. Memory only (0 rows written); built lazily per stream by one bounded scan.
//
// One index per stream: hash53(UTF-8 deviceId, 0x00, UTF-8 clientFrameId) → newest seq, plus a ring of
// (hash, seq, rowBytes), oldest first, trimmed to the newest W bytes. A hit is only a candidate: the store loads the
// row and compares keys (a collision on another key is not a hit) and bytes. The DO-wide entry cap evicts whole
// streams, least recently used first; an evicted stream rescans (≤ 65 rows).

/** W ≥ burst + maxPayload + gcMaxBytes = 2 MiB + 1 MiB + 64 KiB. */
export const STREAM_DEDUPE_WINDOW_BYTES = 4 * 1024 * 1024;
/** Newest sealed segments the cold scan may read (every sealed segment is ≥ 64 KiB, so 64 cover W). */
export const STREAM_DEDUPE_SCAN_SEGMENTS = 64;
/** DO-wide cap on index entries (about 16 MB at about 60 B/entry). */
export const STREAM_DEDUPE_MAX_ENTRIES = 262_144;

const utf8 = new TextEncoder();

/**
 * cyrb53 (public domain, bryc) over `a`, one 0x00 byte, then `b`: a 53-bit hash, exact in a double. The middle step
 * is the 0x00 byte (`h ^ 0 === h`). Both the frame path (strings, UTF-8 encoded) and the scan path (raw stored key
 * bytes, never decoded) hash the same bytes.
 */
export function keyHash(a: Uint8Array, aStart: number, aEnd: number, b: Uint8Array, bStart: number, bEnd: number): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = aStart; i < aEnd; i++) {
		const ch = a[i]!;
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1, 2654435761);
	h2 = Math.imul(h2, 1597334677);
	for (let i = bStart; i < bEnd; i++) {
		const ch = b[i]!;
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** `keyHash` of a frame's (deviceId, clientFrameId). */
export function frameKeyHash(deviceId: string, clientFrameId: string): number {
	const device = utf8.encode(deviceId);
	const id = utf8.encode(clientFrameId);
	return keyHash(device, 0, device.byteLength, id, 0, id.byteLength);
}

/** One stream's window: map hash → newest seq, ring of (hash, seq, rowBytes) oldest first. */
export class StreamDedupeIndex {
	private readonly map = new Map<number, number>();
	private hashes = new Float64Array(16);
	private seqs = new Float64Array(16);
	private sizes = new Uint32Array(16);
	private start = 0;
	private count = 0;
	private bytes = 0;

	constructor(private readonly windowBytes: number = STREAM_DEDUPE_WINDOW_BYTES) {}

	/** Ring entries (the memory measure of the DO-wide cap). */
	get entries(): number {
		return this.count;
	}

	get windowedBytes(): number {
		return this.bytes;
	}

	get(hash: number): number | undefined {
		return this.map.get(hash);
	}

	/** Appends the newest row and trims to W. Returns the change in entries. */
	add(hash: number, seq: number, rowBytes: number): number {
		if (this.count === this.hashes.length) this.grow();
		const slot = (this.start + this.count) & (this.hashes.length - 1);
		this.hashes[slot] = hash;
		this.seqs[slot] = seq;
		this.sizes[slot] = rowBytes;
		this.count++;
		this.bytes += rowBytes;
		this.map.set(hash, seq);
		return 1 - this.trim();
	}

	/**
	 * Parses one stored blob (concatenated rows: varuint seq, varstring deviceId, varstring clientFrameId,
	 * varuint8array payload) for keys only, skipping payloads by length, and adds every row oldest first. Returns
	 * the change in entries. A malformed tail stops the parse (the rows before it stay indexed).
	 */
	scan(blob: Uint8Array): number {
		let delta = 0;
		const end = blob.byteLength;
		let pos = 0;
		while (pos < end) {
			const rowStart = pos;
			// Inline lib0 varuint reads (little-endian base-128); written by encodeRow, so well formed.
			let seq = 0;
			let scale = 1;
			let byte: number;
			do { byte = blob[pos++]!; seq += (byte & 0x7f) * scale; scale *= 128; } while (byte >= 0x80 && pos < end);
			let length = 0;
			scale = 1;
			do { byte = blob[pos++]!; length += (byte & 0x7f) * scale; scale *= 128; } while (byte >= 0x80 && pos < end);
			const deviceStart = pos;
			pos += length;
			const deviceEnd = pos;
			length = 0;
			scale = 1;
			do { byte = blob[pos++]!; length += (byte & 0x7f) * scale; scale *= 128; } while (byte >= 0x80 && pos < end);
			const idStart = pos;
			pos += length;
			const idEnd = pos;
			length = 0;
			scale = 1;
			do { byte = blob[pos++]!; length += (byte & 0x7f) * scale; scale *= 128; } while (byte >= 0x80 && pos < end);
			pos += length;
			if (pos > end || idEnd > end) break;
			delta += this.add(keyHash(blob, deviceStart, deviceEnd, blob, idStart, idEnd), seq, pos - rowStart);
		}
		return delta;
	}

	/** Drops the oldest rows while the rest still hold ≥ W bytes. Returns the number dropped. */
	private trim(): number {
		let dropped = 0;
		const mask = this.hashes.length - 1;
		while (this.count > 1 && this.bytes - this.sizes[this.start]! >= this.windowBytes) {
			const hash = this.hashes[this.start]!;
			if (this.map.get(hash) === this.seqs[this.start]) this.map.delete(hash);
			this.bytes -= this.sizes[this.start]!;
			this.start = (this.start + 1) & mask;
			this.count--;
			dropped++;
		}
		return dropped;
	}

	private grow(): void {
		const capacity = this.hashes.length * 2;
		const hashes = new Float64Array(capacity);
		const seqs = new Float64Array(capacity);
		const sizes = new Uint32Array(capacity);
		const mask = this.hashes.length - 1;
		for (let i = 0; i < this.count; i++) {
			const slot = (this.start + i) & mask;
			hashes[i] = this.hashes[slot]!;
			seqs[i] = this.seqs[slot]!;
			sizes[i] = this.sizes[slot]!;
		}
		this.hashes = hashes;
		this.seqs = seqs;
		this.sizes = sizes;
		this.start = 0;
	}
}

/** Every stream's index in one runtime, with the DO-wide entry cap (LRU over whole streams). */
export class DedupeIndexes {
	/** Insertion order = recency: `touch` re-inserts. */
	private readonly streams = new Map<string, StreamDedupeIndex>();
	private total = 0;

	constructor(private readonly maxEntries: number = STREAM_DEDUPE_MAX_ENTRIES) {}

	get entries(): number {
		return this.total;
	}

	get size(): number {
		return this.streams.size;
	}

	/** The stream's index, marked most recently used; undefined when not built (or evicted). */
	touch(stream: string): StreamDedupeIndex | undefined {
		const index = this.streams.get(stream);
		if (index) { this.streams.delete(stream); this.streams.set(stream, index); }
		return index;
	}

	has(stream: string): boolean {
		return this.streams.has(stream);
	}

	/** Installs a freshly built index as most recently used, then enforces the cap (never evicting `stream`). */
	install(stream: string, index: StreamDedupeIndex): void {
		const previous = this.streams.get(stream);
		if (previous) { this.total -= previous.entries; this.streams.delete(stream); }
		this.streams.set(stream, index);
		this.total += index.entries;
		this.enforce(stream);
	}

	/** Records rows a commit added to `stream`'s index (`delta` from `add`), then enforces the cap. */
	grew(stream: string, delta: number): void {
		this.total += delta;
		this.enforce(stream);
	}

	clear(): void {
		this.streams.clear();
		this.total = 0;
	}

	private enforce(keep: string): void {
		for (const [stream, index] of this.streams) {
			if (this.total <= this.maxEntries) return;
			if (stream === keep) continue;
			this.streams.delete(stream);
			this.total -= index.entries;
		}
	}
}
