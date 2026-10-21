/**
 * Streams wire v1 codec (docs/client-remake/relay-wire.md §4, §15).
 *
 * Binary frames use the lib0 primitives (u8 kind, varuint, varstring,
 * varbytes). Control messages are text frames: "__YPS:" + one JSON object.
 *
 * Decoders never throw: a malformed or unknown frame decodes to null and the
 * caller ignores it (the relay is trusted to be well-formed; unknown control
 * types are forward-compatible additions).
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { RekeySignal } from "../../ports/relay";

export const FRAME_APPEND = 0x01;
export const FRAME_PROVISIONAL = 0x10;
export const FRAME_COMMITTED = 0x11;
export const FRAME_COMMIT_NOTICE = 0x12;
export const FRAME_SKIPPED = 0x13;

export const CONTROL_PREFIX = "__YPS:";
export const STREAMS_VERSION = 1;

export interface WireAppend {
	readonly stream: string;
	readonly clientFrameId: string;
	readonly payload: Uint8Array;
}

export type WireServerFrame =
	| { readonly kind: "provisional"; readonly stream: string; readonly deviceId: string; readonly clientFrameId: string; readonly payload: Uint8Array }
	| { readonly kind: "committed"; readonly seq: number; readonly stream: string; readonly deviceId: string; readonly clientFrameId: string; readonly payload: Uint8Array }
	| { readonly kind: "notice"; readonly seq: number; readonly stream: string; readonly deviceId: string; readonly clientFrameId: string }
	/** STREAM_SKIPPED (relay-wire §5.6): the rows of one frame merged into seq order. */
	| { readonly kind: "skipped"; readonly rows: readonly WireSkippedRow[] };

export interface WireSkippedRow {
	readonly stream: string;
	readonly seq: number;
}

export function encodeAppend(frame: WireAppend): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeUint8(encoder, FRAME_APPEND);
	encoding.writeVarString(encoder, frame.stream);
	encoding.writeVarString(encoder, frame.clientFrameId);
	encoding.writeVarUint8Array(encoder, frame.payload);
	return encoding.toUint8Array(encoder);
}

/** Inverse of encodeAppend (tests and fakes). null when malformed or trailing bytes remain. */
export function decodeAppend(bytes: Uint8Array): WireAppend | null {
	if (bytes.byteLength === 0 || bytes[0] !== FRAME_APPEND) return null;
	try {
		const decoder = decoding.createDecoder(bytes);
		decoding.readUint8(decoder);
		const stream = decoding.readVarString(decoder);
		const clientFrameId = decoding.readVarString(decoder);
		const payload = decoding.readVarUint8Array(decoder).slice();
		if (decoder.pos !== bytes.byteLength) return null;
		return { stream, clientFrameId, payload };
	} catch {
		return null;
	}
}

/**
 * 0x13 STREAM_SKIPPED body from rows in seq order: one run per stream, the streams in order of their first seq
 * (server encodeSkipped; tests and fakes).
 */
function writeSkipped(encoder: encoding.Encoder, rows: readonly WireSkippedRow[]): void {
	const runs = new Map<string, number[]>();
	for (const r of rows) {
		const run = runs.get(r.stream);
		if (run) run.push(r.seq);
		else runs.set(r.stream, [r.seq]);
	}
	encoding.writeVarUint(encoder, runs.size);
	for (const [stream, seqs] of runs) {
		encoding.writeVarString(encoder, stream);
		encoding.writeVarUint(encoder, seqs.length);
		encoding.writeVarUint(encoder, seqs[0]!);
		for (let i = 1; i < seqs.length; i++) encoding.writeVarUint(encoder, seqs[i]! - seqs[i - 1]!);
	}
}

/**
 * Strict 0x13 body: at least one stream, each named once with n >= 1 seqs, every delta > 0, first seqs ascending
 * across streams (the order the relay writes them), every seq a positive safe integer. Rows come back merged into
 * seq order (the order the relay skipped them in). Throws on anything else.
 */
function readSkipped(decoder: decoding.Decoder): WireSkippedRow[] {
	const streamCount = decoding.readVarUint(decoder);
	if (streamCount < 1) throw new RangeError("empty STREAM_SKIPPED");
	const rows: WireSkippedRow[] = [];
	const seen = new Set<string>();
	let prevFirst = 0;
	for (let i = 0; i < streamCount; i++) {
		const stream = decoding.readVarString(decoder);
		const n = decoding.readVarUint(decoder);
		if (stream.length === 0 || seen.has(stream) || n < 1) throw new RangeError("bad STREAM_SKIPPED run");
		seen.add(stream);
		let seq = decoding.readVarUint(decoder);
		if (seq <= prevFirst || !Number.isSafeInteger(seq)) throw new RangeError("bad STREAM_SKIPPED first seq");
		prevFirst = seq;
		rows.push({ stream, seq });
		for (let k = 1; k < n; k++) {
			const delta = decoding.readVarUint(decoder);
			seq += delta;
			if (delta < 1 || !Number.isSafeInteger(seq)) throw new RangeError("bad STREAM_SKIPPED delta");
			rows.push({ stream, seq });
		}
	}
	rows.sort((a, b) => a.seq - b.seq);
	for (let i = 1; i < rows.length; i++) if (rows[i]!.seq === rows[i - 1]!.seq) throw new RangeError("duplicate STREAM_SKIPPED seq");
	return rows;
}

/** Server-side encoder (tests and fakes). */
export function encodeServerFrame(frame: WireServerFrame): Uint8Array {
	const encoder = encoding.createEncoder();
	if (frame.kind === "skipped") {
		encoding.writeUint8(encoder, FRAME_SKIPPED);
		writeSkipped(encoder, frame.rows);
		return encoding.toUint8Array(encoder);
	}
	if (frame.kind === "provisional") {
		encoding.writeUint8(encoder, FRAME_PROVISIONAL);
	} else {
		encoding.writeUint8(encoder, frame.kind === "committed" ? FRAME_COMMITTED : FRAME_COMMIT_NOTICE);
		encoding.writeVarUint(encoder, frame.seq);
	}
	encoding.writeVarString(encoder, frame.stream);
	encoding.writeVarString(encoder, frame.deviceId);
	encoding.writeVarString(encoder, frame.clientFrameId);
	if (frame.kind !== "notice") encoding.writeVarUint8Array(encoder, frame.payload);
	return encoding.toUint8Array(encoder);
}

/**
 * Decodes one server -> client binary message. Payloads are copied out of the
 * message buffer so they can be stored or transferred independently.
 */
export function decodeServerFrame(bytes: Uint8Array): WireServerFrame | null {
	if (bytes.byteLength === 0) return null;
	try {
		const decoder = decoding.createDecoder(bytes);
		const kind = decoding.readUint8(decoder);
		if (kind === FRAME_PROVISIONAL) {
			const stream = decoding.readVarString(decoder);
			const deviceId = decoding.readVarString(decoder);
			const clientFrameId = decoding.readVarString(decoder);
			const payload = decoding.readVarUint8Array(decoder).slice();
			if (decoder.pos !== bytes.byteLength) return null;
			return { kind: "provisional", stream, deviceId, clientFrameId, payload };
		}
		if (kind === FRAME_COMMITTED || kind === FRAME_COMMIT_NOTICE) {
			const seq = decoding.readVarUint(decoder);
			const stream = decoding.readVarString(decoder);
			const deviceId = decoding.readVarString(decoder);
			const clientFrameId = decoding.readVarString(decoder);
			if (kind === FRAME_COMMIT_NOTICE) {
				if (decoder.pos !== bytes.byteLength) return null;
				return { kind: "notice", seq, stream, deviceId, clientFrameId };
			}
			const payload = decoding.readVarUint8Array(decoder).slice();
			if (decoder.pos !== bytes.byteLength) return null;
			return { kind: "committed", seq, stream, deviceId, clientFrameId, payload };
		}
		if (kind === FRAME_SKIPPED) {
			const rows = readSkipped(decoder);
			if (decoder.pos !== bytes.byteLength) return null;
			return { kind: "skipped", rows };
		}
		return null;
	} catch {
		return null;
	}
}

// ---- control ---------------------------------------------------------------

/** Subset of VAULT_READY.limits the client uses. Every field is required and positive. */
export interface WireLimits {
	readonly maxPayloadBytes: number;
	readonly maxCheckpointBytes: number;
	readonly rateBytesPerSec: number;
	readonly burstBytes: number;
	readonly feedDefaultLimit: number;
	readonly readDefaultBytes: number;
	readonly readBatchMaxStreams: number;
	readonly maxSubscriptions: number;
}

export interface WireReceipt {
	readonly stream: string;
	readonly clientFrameId: string;
	readonly seq: number;
	readonly deduped: boolean;
}

export type WireControl =
	| {
		readonly type: "VAULT_READY";
		/** null when absent or malformed: the connect fails closed (update-required), as for `limits`. */
		readonly rekey: RekeySignal | null;
		readonly vaultEpoch: string;
		readonly head: number;
		readonly canWrite: boolean;
		readonly deviceId: string | null;
		readonly runtimeEpoch: string | null;
		/** keepalive: the relay answers VAULT_KEEPALIVE (encodeKeepalive), which does not wake it. */
		readonly liveness: { readonly idleMs: number; readonly timeoutMs: number; readonly keepalive: boolean } | null;
		/** null when any required limit is absent or not positive: the connect fails closed. */
		readonly limits: WireLimits | null;
	}
	| { readonly type: "STREAM_RECEIPTS"; readonly head: number; readonly receipts: readonly WireReceipt[] }
	| { readonly type: "STREAM_APPEND_REJECTED"; readonly stream: string; readonly clientFrameId: string; readonly code: string; readonly seq: number | null }
	| { readonly type: "STREAM_PROVISIONAL_DROPPED"; readonly stream: string; readonly deviceId: string; readonly clientFrameId: string; readonly reason: string | null }
	| { readonly type: "STREAM_RESEND"; readonly head: number; readonly runtimeEpoch: string | null }
	| { readonly type: "VAULT_PONG"; readonly probeId: string | null; readonly head: number }
	| { readonly type: "VAULT_BACKPRESSURE"; readonly reason: string | null }
	| ({ readonly type: "VAULT_REKEY" } & RekeySignal)
	| {
		readonly type: "VAULT_ERROR";
		readonly code: string;
		readonly stream: string | null;
		readonly clientFrameIds: readonly string[];
		readonly resetAt: number | null;
		readonly kind: string | null;
	}
	| { readonly type: "error"; readonly code: string; readonly reason: string | null };

export function encodeControl(message: Readonly<Record<string, unknown>>): string {
	return CONTROL_PREFIX + JSON.stringify(message);
}

/** STREAM_SUBSCRIBE (relay-wire §5.6): the full replacement set. */
export function encodeSubscribe(streams: readonly string[]): string {
	return encodeControl({ type: "STREAM_SUBSCRIBE", streams });
}

/** VAULT_REKEYED (relay-wire §4.2): this device rolled the vault key after seeing `removals` blocking removals. */
export function encodeRekeyed(removals: number): string {
	return encodeControl({ type: "VAULT_REKEYED", removals });
}

export function encodePing(probeId: string): string {
	return encodeControl({ type: "VAULT_PING", probeId });
}

/**
 * Idle keepalive (relay-wire §4): a fixed text the relay's runtime answers with `VAULT_ALIVE` without waking the
 * Durable Object. Exactly the server's SOCKET_KEEPALIVE_REQUEST (server/src/shared/socketLiveness.ts).
 */
export const KEEPALIVE_REQUEST = `__YPS:{"type":"VAULT_KEEPALIVE"}`;

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(o: Json, key: string): string | null {
	const v = o[key];
	return typeof v === "string" ? v : null;
}

function seqOf(o: Json, key: string): number | null {
	const v = o[key];
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function positive(o: Json, key: string): number | null {
	const v = o[key];
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

const LIMIT_KEYS = [
	"maxPayloadBytes", "maxCheckpointBytes", "rateBytesPerSec", "burstBytes",
	"feedDefaultLimit", "readDefaultBytes", "readBatchMaxStreams", "maxSubscriptions",
] as const satisfies readonly (keyof WireLimits)[];

/** null when any required limit is absent or not positive. */
function parseLimits(value: unknown): WireLimits | null {
	if (!isRecord(value)) return null;
	const out: Partial<Record<keyof WireLimits, number>> = {};
	for (const key of LIMIT_KEYS) {
		const v = positive(value, key);
		if (v === null) return null;
		out[key] = v;
	}
	return out as WireLimits;
}

/** `{removals, rekeyed}`, two safe integers ≥ 0 with rekeyed ≤ removals; null otherwise. */
function parseRekey(value: unknown): RekeySignal | null {
	if (!isRecord(value)) return null;
	const removals = seqOf(value, "removals");
	const rekeyed = seqOf(value, "rekeyed");
	if (removals === null || rekeyed === null || rekeyed > removals) return null;
	return { removals, rekeyed };
}

function parseReceipts(value: unknown): WireReceipt[] | null {
	if (!Array.isArray(value)) return null;
	const out: WireReceipt[] = [];
	for (const item of value) {
		if (!isRecord(item)) return null;
		const stream = str(item, "stream");
		const clientFrameId = str(item, "clientFrameId");
		const seq = seqOf(item, "seq");
		if (stream === null || clientFrameId === null || seq === null) return null;
		out.push({ stream, clientFrameId, seq, deduped: item["deduped"] === true });
	}
	return out;
}

/**
 * Parses one text frame. null for frames without the prefix, invalid JSON,
 * unknown types and messages missing required fields.
 */
export function parseControl(text: string): WireControl | null {
	if (!text.startsWith(CONTROL_PREFIX)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(CONTROL_PREFIX.length));
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const o = parsed;
	switch (o["type"]) {
		case "VAULT_READY": {
			const vaultEpoch = str(o, "vaultEpoch");
			const head = seqOf(o, "head");
			if (vaultEpoch === null || head === null) return null;
			const live = o["liveness"];
			let liveness: { idleMs: number; timeoutMs: number; keepalive: boolean } | null = null;
			if (isRecord(live)) {
				const idleMs = positive(live, "idleMs");
				const timeoutMs = positive(live, "timeoutMs");
				if (idleMs !== null && timeoutMs !== null) liveness = { idleMs, timeoutMs, keepalive: live["keepalive"] === true };
			}
			return {
				type: "VAULT_READY",
				vaultEpoch,
				head,
				canWrite: o["canWrite"] === true,
				deviceId: str(o, "deviceId"),
				runtimeEpoch: str(o, "runtimeEpoch"),
				liveness,
				limits: parseLimits(o["limits"]),
				rekey: parseRekey(o["rekey"]),
			};
		}
		case "VAULT_REKEY": {
			const rekey = parseRekey(o);
			return rekey === null ? null : { type: "VAULT_REKEY", ...rekey };
		}
		case "STREAM_RECEIPTS": {
			const head = seqOf(o, "head");
			const receipts = parseReceipts(o["receipts"]);
			if (head === null || receipts === null) return null;
			return { type: "STREAM_RECEIPTS", head, receipts };
		}
		case "STREAM_APPEND_REJECTED": {
			const stream = str(o, "stream");
			const clientFrameId = str(o, "clientFrameId");
			const code = str(o, "code");
			if (stream === null || clientFrameId === null || code === null) return null;
			return { type: "STREAM_APPEND_REJECTED", stream, clientFrameId, code, seq: seqOf(o, "seq") };
		}
		case "STREAM_PROVISIONAL_DROPPED": {
			const stream = str(o, "stream");
			const deviceId = str(o, "deviceId");
			const clientFrameId = str(o, "clientFrameId");
			if (stream === null || deviceId === null || clientFrameId === null) return null;
			return { type: "STREAM_PROVISIONAL_DROPPED", stream, deviceId, clientFrameId, reason: str(o, "reason") };
		}
		case "STREAM_RESEND": {
			const head = seqOf(o, "head");
			if (head === null) return null;
			return { type: "STREAM_RESEND", head, runtimeEpoch: str(o, "runtimeEpoch") };
		}
		case "VAULT_PONG": {
			const head = seqOf(o, "head");
			if (head === null) return null;
			return { type: "VAULT_PONG", probeId: str(o, "probeId"), head };
		}
		case "VAULT_BACKPRESSURE":
			return { type: "VAULT_BACKPRESSURE", reason: str(o, "reason") };
		case "VAULT_ERROR": {
			const code = str(o, "code");
			if (code === null) return null;
			const ids = o["clientFrameIds"];
			const clientFrameIds = Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string") : [];
			const resetAt = o["resetAt"];
			return {
				type: "VAULT_ERROR",
				code,
				stream: str(o, "stream"),
				clientFrameIds,
				resetAt: typeof resetAt === "number" && Number.isFinite(resetAt) ? resetAt : null,
				kind: str(o, "kind"),
			};
		}
		case "error": {
			const code = str(o, "code");
			if (code === null) return null;
			return { type: "error", code, reason: str(o, "reason") };
		}
		default:
			return null;
	}
}

// ---- binary catch-up reads (relay-wire §7.2) ----------------------------------

/** Content-Type of every 200 read reply (the client does not check it; tests and fakes set it). */
export const READ_BINARY_TYPE = "application/vnd.yaos.streams-read.v1+binary";
const READ_BINARY_VERSION = 1;

export interface WireReadPage {
	readonly stream: string;
	readonly lastSeq: number;
	readonly checkpointSeq: number;
	readonly gcSeq: number;
	readonly checkpoint: { readonly coversSeq: number; readonly bytes: Uint8Array } | null;
	readonly rows: readonly { readonly seq: number; readonly deviceId: string; readonly clientFrameId: string; readonly payload: Uint8Array }[];
	readonly nextAfter: number | null;
}

export interface WireReadReply {
	readonly vaultEpoch: string;
	readonly head: number;
	readonly pages: readonly WireReadPage[];
}

/**
 * `u8 1 | varstring vaultEpoch | varuint head | varuint pageCount`, then per page `varstring stream | varuint
 * lastSeq | varuint checkpointSeq | varuint gcSeq | varuint nextAfter+1 (0: none) | u8 hasCheckpoint [varuint
 * coversSeq | varbytes] | varuint rowCount | (varuint seq | varstring deviceId | varstring clientFrameId |
 * varbytes payload)×rowCount`. Encoder for tests and fakes.
 */
export function encodeReadReply(reply: WireReadReply): Uint8Array {
	const e = encoding.createEncoder();
	encoding.writeUint8(e, READ_BINARY_VERSION);
	encoding.writeVarString(e, reply.vaultEpoch);
	encoding.writeVarUint(e, reply.head);
	encoding.writeVarUint(e, reply.pages.length);
	for (const p of reply.pages) {
		encoding.writeVarString(e, p.stream);
		encoding.writeVarUint(e, p.lastSeq);
		encoding.writeVarUint(e, p.checkpointSeq);
		encoding.writeVarUint(e, p.gcSeq);
		encoding.writeVarUint(e, p.nextAfter === null ? 0 : p.nextAfter + 1);
		encoding.writeUint8(e, p.checkpoint ? 1 : 0);
		if (p.checkpoint) {
			encoding.writeVarUint(e, p.checkpoint.coversSeq);
			encoding.writeVarUint8Array(e, p.checkpoint.bytes);
		}
		encoding.writeVarUint(e, p.rows.length);
		for (const r of p.rows) {
			encoding.writeVarUint(e, r.seq);
			encoding.writeVarString(e, r.deviceId);
			encoding.writeVarString(e, r.clientFrameId);
			encoding.writeVarUint8Array(e, r.payload);
		}
	}
	return encoding.toUint8Array(e);
}

/** The binary read reply, or null when malformed (unknown version, a short field, trailing bytes). Payloads are views into `bytes`. */
export function decodeReadReply(bytes: Uint8Array): WireReadReply | null {
	try {
		const d = decoding.createDecoder(bytes);
		if (decoding.readUint8(d) !== READ_BINARY_VERSION) return null;
		const vaultEpoch = decoding.readVarString(d);
		const head = decoding.readVarUint(d);
		const pages: WireReadPage[] = [];
		for (let n = decoding.readVarUint(d); n > 0; n--) {
			const stream = decoding.readVarString(d);
			const lastSeq = decoding.readVarUint(d);
			const checkpointSeq = decoding.readVarUint(d);
			const gcSeq = decoding.readVarUint(d);
			const nextAfterRaw = decoding.readVarUint(d);
			const flag = decoding.readUint8(d);
			if (flag > 1) return null;
			const checkpoint = flag === 1 ? { coversSeq: decoding.readVarUint(d), bytes: decoding.readVarUint8Array(d) } : null;
			const rows: { seq: number; deviceId: string; clientFrameId: string; payload: Uint8Array }[] = [];
			for (let k = decoding.readVarUint(d); k > 0; k--) {
				if (d.pos >= bytes.byteLength) return null;
				rows.push({ seq: decoding.readVarUint(d), deviceId: decoding.readVarString(d), clientFrameId: decoding.readVarString(d), payload: decoding.readVarUint8Array(d) });
			}
			pages.push({ stream, lastSeq, checkpointSeq, gcSeq, checkpoint, rows, nextAfter: nextAfterRaw === 0 ? null : nextAfterRaw - 1 });
		}
		return d.pos === bytes.byteLength ? { vaultEpoch, head, pages } : null;
	} catch {
		return null;
	}
}
