// Opaque streams (client-remake relay surface, docs/client-remake/relay-wire.md).
//
// The server sequences, stores and forwards opaque bytes. Nothing in
// server/src/streams/ decodes, validates, merges or hashes CRDT content, and
// nothing here imports the CRDT engine (no ywasm on this path).
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/** Capability version advertised as `streams` in /api/capabilities and VAULT_READY. */
export const STREAMS_CAPABILITY_VERSION = 1;

/** Ticket purpose and documentId of a streams socket. */
export const STREAMS_TICKET_PURPOSE = "streams";
export const STREAMS_DOCUMENT_ID = "streams";

export const MAX_STREAM_NAME_BYTES = 256;
export const MAX_CLIENT_FRAME_ID_BYTES = 128;
/** One appended payload (binary APPEND frame). */
export const MAX_STREAM_PAYLOAD_BYTES = 1024 * 1024;
/** Raw size cap of one received binary message: payload + header allowance. */
export const MAX_STREAM_BINARY_MESSAGE_BYTES = MAX_STREAM_PAYLOAD_BYTES + 1024;
/** Raw size cap of one received text (control) message. */
export const MAX_STREAM_TEXT_MESSAGE_BYTES = 64 * 1024;
/** One checkpoint (PUT body). Stored in row-safe chunks. */
export const MAX_STREAM_CHECKPOINT_BYTES = 4 * 1024 * 1024;
/** Feed page size: default and cap. */
export const STREAM_FEED_DEFAULT_LIMIT = 1000;
export const STREAM_FEED_MAX_LIMIT = 5000;
/** Catch-up page payload budget: default and cap (at least one row is always returned). */
export const STREAM_READ_DEFAULT_BYTES = 1024 * 1024;
export const STREAM_READ_MAX_BYTES = 4 * 1024 * 1024;
/** Concurrent streams sockets per vault. */
export const MAX_STREAM_SOCKETS = 1000;
/** H6: concurrent streams sockets per device; a 5th connect closes the device's oldest (1001 `device_socket_limit`). */
export const MAX_STREAM_SOCKETS_PER_DEVICE = 4;

/** Client -> server binary frame kinds (byte 0). */
export const STREAM_FRAME_APPEND = 0x01;
/** Server -> client binary frame kinds (byte 0). */
export const STREAM_FRAME_PROVISIONAL = 0x10;
export const STREAM_FRAME_COMMITTED = 0x11;
export const STREAM_FRAME_COMMIT_NOTICE = 0x12;

/** The vault's namespace stream; always delivered committed (with seq). */
export const NS_STREAM = "ns";

/**
 * Streams whose frames are broadcast before the commit (PROVISIONAL, then a
 * COMMIT_NOTICE with the seq). Every other stream (ns included) is broadcast
 * only after the commit (COMMITTED, with the seq).
 */
export function isProvisionalStream(stream: string): boolean {
	return stream.startsWith("b:") || stream.startsWith("c:");
}

const utf8 = new TextEncoder();

export function utf8Length(value: string): number {
	return utf8.encode(value).byteLength;
}

/** Opaque name: any non-empty string of at most MAX_STREAM_NAME_BYTES UTF-8 bytes. */
export function validStreamName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_STREAM_NAME_BYTES
		&& utf8Length(value) <= MAX_STREAM_NAME_BYTES;
}

export function validClientFrameId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_CLIENT_FRAME_ID_BYTES
		&& utf8Length(value) <= MAX_CLIENT_FRAME_ID_BYTES;
}

export interface AppendFrame {
	stream: string;
	clientFrameId: string;
	payload: Uint8Array;
}

export type AppendDecodeError = "malformed_frame" | "unknown_frame_kind" | "invalid_stream" | "invalid_client_frame_id"
	| "payload_too_large";

/**
 * H1 strict APPEND reader. lib0's `readVarString` turns invalid UTF-8 into U+FFFD and its `readVarUint` accepts
 * non-minimal encodings, so two byte strings could alias one stream name or frame id. Here strings are fatal UTF-8
 * (`ignoreBOM` keeps a leading U+FEFF as part of the name), varuints are minimal and at most 2^53, every length
 * must fit the remaining bytes, and the message must be fully consumed.
 */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** 8 groups of 7 bits hold 2^53 (the 8th group may carry at most 0b10000). */
const MAX_VARUINT_GROUPS = 8;
const VARUINT_TOP_SCALE = 2 ** 49;

class StrictReader {
	pos = 1;
	constructor(private readonly bytes: Uint8Array) {}

	/** A minimal little-endian base-128 varuint <= 2^53, or null. */
	varuint(): number | null {
		let low = 0;
		let scale = 1;
		for (let group = 0; group < MAX_VARUINT_GROUPS; group++) {
			if (this.pos >= this.bytes.byteLength) return null;
			const byte = this.bytes[this.pos++]!;
			const bits = byte & 0x7f;
			const last = byte < 0x80;
			if (last && bits === 0 && group > 0) return null;
			if (group === MAX_VARUINT_GROUPS - 1) {
				// value = low + bits * 2^49 with low < 2^49: <= 2^53 iff bits < 16, or bits == 16 and low == 0.
				if (!last || bits > 16 || (bits === 16 && low !== 0)) return null;
				return low + bits * VARUINT_TOP_SCALE;
			}
			low += bits * scale;
			if (last) return low;
			scale *= 128;
		}
		return null;
	}

	/** A length-prefixed byte range that fits the remaining bytes, as a view, or null. */
	bytesField(): Uint8Array | null {
		const length = this.varuint();
		if (length === null || length > this.bytes.byteLength - this.pos) return null;
		const view = this.bytes.subarray(this.pos, this.pos + length);
		this.pos += length;
		return view;
	}

	string(): string | null {
		const view = this.bytesField();
		if (view === null) return null;
		try { return strictUtf8.decode(view); } catch { return null; }
	}

	done(): boolean {
		return this.pos === this.bytes.byteLength;
	}
}

/** Decodes one client APPEND message (H1 strict codec). Never throws. */
export function decodeAppendFrame(bytes: Uint8Array): AppendFrame | { error: AppendDecodeError } {
	if (bytes.byteLength === 0) return { error: "malformed_frame" };
	if (bytes[0] !== STREAM_FRAME_APPEND) return { error: "unknown_frame_kind" };
	const reader = new StrictReader(bytes);
	const stream = reader.string();
	if (stream === null) return { error: "malformed_frame" };
	const clientFrameId = reader.string();
	if (clientFrameId === null) return { error: "malformed_frame" };
	const payload = reader.bytesField();
	if (payload === null || !reader.done()) return { error: "malformed_frame" };
	if (!validStreamName(stream)) return { error: "invalid_stream" };
	if (!validClientFrameId(clientFrameId)) return { error: "invalid_client_frame_id" };
	if (payload.byteLength > MAX_STREAM_PAYLOAD_BYTES) return { error: "payload_too_large" };
	return { stream, clientFrameId, payload };
}

export function encodeAppendFrame(frame: AppendFrame): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeUint8(encoder, STREAM_FRAME_APPEND);
	encoding.writeVarString(encoder, frame.stream);
	encoding.writeVarString(encoder, frame.clientFrameId);
	encoding.writeVarUint8Array(encoder, frame.payload);
	return encoding.toUint8Array(encoder);
}

export interface StreamFrameIdentity {
	stream: string;
	deviceId: string;
	clientFrameId: string;
}

export function encodeProvisional(frame: StreamFrameIdentity & { payload: Uint8Array }): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeUint8(encoder, STREAM_FRAME_PROVISIONAL);
	encoding.writeVarString(encoder, frame.stream);
	encoding.writeVarString(encoder, frame.deviceId);
	encoding.writeVarString(encoder, frame.clientFrameId);
	encoding.writeVarUint8Array(encoder, frame.payload);
	return encoding.toUint8Array(encoder);
}

export function encodeCommitted(frame: StreamFrameIdentity & { seq: number; payload: Uint8Array }): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeUint8(encoder, STREAM_FRAME_COMMITTED);
	encoding.writeVarUint(encoder, frame.seq);
	encoding.writeVarString(encoder, frame.stream);
	encoding.writeVarString(encoder, frame.deviceId);
	encoding.writeVarString(encoder, frame.clientFrameId);
	encoding.writeVarUint8Array(encoder, frame.payload);
	return encoding.toUint8Array(encoder);
}

export function encodeCommitNotice(frame: StreamFrameIdentity & { seq: number }): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeUint8(encoder, STREAM_FRAME_COMMIT_NOTICE);
	encoding.writeVarUint(encoder, frame.seq);
	encoding.writeVarString(encoder, frame.stream);
	encoding.writeVarString(encoder, frame.deviceId);
	encoding.writeVarString(encoder, frame.clientFrameId);
	return encoding.toUint8Array(encoder);
}

export type ServerStreamFrame =
	| ({ kind: "provisional"; payload: Uint8Array } & StreamFrameIdentity)
	| ({ kind: "committed"; seq: number; payload: Uint8Array } & StreamFrameIdentity)
	| ({ kind: "notice"; seq: number } & StreamFrameIdentity);

/** Decodes one server -> client binary message (tests and tooling). Throws on malformed input. */
export function decodeServerFrame(bytes: Uint8Array): ServerStreamFrame {
	const decoder = decoding.createDecoder(bytes);
	const kind = decoding.readUint8(decoder);
	if (kind === STREAM_FRAME_PROVISIONAL) {
		const stream = decoding.readVarString(decoder);
		const deviceId = decoding.readVarString(decoder);
		const clientFrameId = decoding.readVarString(decoder);
		return { kind: "provisional", stream, deviceId, clientFrameId, payload: decoding.readVarUint8Array(decoder) };
	}
	if (kind === STREAM_FRAME_COMMITTED || kind === STREAM_FRAME_COMMIT_NOTICE) {
		const seq = decoding.readVarUint(decoder);
		const stream = decoding.readVarString(decoder);
		const deviceId = decoding.readVarString(decoder);
		const clientFrameId = decoding.readVarString(decoder);
		return kind === STREAM_FRAME_COMMITTED
			? { kind: "committed", seq, stream, deviceId, clientFrameId, payload: decoding.readVarUint8Array(decoder) }
			: { kind: "notice", seq, stream, deviceId, clientFrameId };
	}
	throw new Error(`unknown server stream frame kind ${kind}`);
}

// ---- stored row records (segment blobs) -------------------------------------

export interface StreamRow {
	seq: number;
	deviceId: string;
	clientFrameId: string;
	payload: Uint8Array;
}

/** One stored row: varuint seq, varstring deviceId, varstring clientFrameId, varuint8array payload. */
export function encodeRow(row: StreamRow): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, row.seq);
	encoding.writeVarString(encoder, row.deviceId);
	encoding.writeVarString(encoder, row.clientFrameId);
	encoding.writeVarUint8Array(encoder, row.payload);
	return encoding.toUint8Array(encoder);
}

/** Decodes a segment blob (concatenated rows). Payloads are views into `bytes`. */
export function decodeRows(bytes: Uint8Array): StreamRow[] {
	const rows: StreamRow[] = [];
	const decoder = decoding.createDecoder(bytes);
	while (decoder.pos < bytes.byteLength) {
		const seq = decoding.readVarUint(decoder);
		const deviceId = decoding.readVarString(decoder);
		const clientFrameId = decoding.readVarString(decoder);
		const payload = decoding.readVarUint8Array(decoder);
		rows.push({ seq, deviceId, clientFrameId, payload });
	}
	return rows;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}
