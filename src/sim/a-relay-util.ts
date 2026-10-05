/**
 * SimRelay shared pieces: limits and defaults (server/src/streams values),
 * options, wire-level downlink messages, sizes, validation, a FIFO timed
 * queue for per-socket links, and a real-time ClockPort fallback.
 */

import type { ClientFrameId, DeviceId, Seq, StreamName, VaultEpoch } from "../core/types";
import type { ClockPort, TimerHandle } from "../ports/clock";
import type { RandomPort } from "../ports/random";
import type { AppendFrame, RelayConnectResult, RelayEvent, RelayLimits, RelayRow } from "../ports/relay";

export const DEFAULT_SIM_RELAY_LIMITS: RelayLimits = Object.freeze({
	maxFrameBytes: 1024 * 1024,
	maxCheckpointBytes: 4 * 1024 * 1024,
	appendBytesPerSec: 256 * 1024,
	burstBytes: 2 * 1024 * 1024,
	feedPageRows: 1000,
	readPageBytes: 1024 * 1024,
});

/** STREAM_DEDUPE_TAIL_ROWS: the newest sealed segment is searched while the open segment has fewer rows. */
export const DEFAULT_SIM_DEDUPE_WINDOW = 64;
export const SIM_SEGMENT_SEAL_BYTES = 64 * 1024;
export const SIM_SEGMENT_MAX_BYTES = 1_500_000;
/** Raw binary message cap = maxFrameBytes + this (MAX_STREAM_BINARY_MESSAGE_BYTES). */
export const SIM_MESSAGE_SLACK_BYTES = 1024;
export const SIM_FEED_MAX_LIMIT = 5000;
export const SIM_READ_MAX_BYTES = 4 * 1024 * 1024;
export const SIM_MAX_SOCKETS = 1000;

export interface GroupCommitSpec {
	readonly idleMs: number;
	readonly maxMs: number;
	readonly maxBytes: number;
	readonly minIntervalMs: number;
}
export const DEFAULT_SIM_GROUP_COMMIT: GroupCommitSpec = Object.freeze({ idleMs: 300, maxMs: 1500, maxBytes: 64 * 1024, minIntervalMs: 0 });

/** One socket's link. Delays are virtual ms; jitter adds uniform [0, jitterMs) per message (FIFO is kept). */
export interface LinkSpec {
	readonly uplinkMs?: number;
	readonly downlinkMs?: number;
	readonly jitterMs?: number;
	/** One-way HTTP latency (applied to the request and to the response). */
	readonly httpMs?: number;
	/** Ticket + upgrade latency of connect(). */
	readonly connectMs?: number;
	/** Uplink serialization rate; 0/undefined = unlimited. */
	readonly uplinkBytesPerSec?: number;
}

export interface SimRelayOptions {
	/** Default: a real-time clock (setTimeout). Simulations pass a VirtualClock. */
	readonly clock?: ClockPort;
	/** Jitter source. Default SeededRandom(seed ?? 1). */
	readonly random?: RandomPort;
	readonly seed?: number;
	readonly vaultEpoch?: VaultEpoch;
	readonly limits?: Partial<RelayLimits>;
	/** Extra cap on rows per read() page (tests: force paging). Default unlimited. */
	readonly readPageRows?: number;
	/** Dedupe tail rows (server STREAM_DEDUPE_TAIL_ROWS). Default 64. */
	readonly dedupeWindow?: number;
	/** Open segment seal threshold. Default 64 KiB; small values make window expiry and GC testable. */
	readonly sealBytes?: number;
	readonly maxSegmentBytes?: number;
	readonly groupCommit?: Partial<GroupCommitSpec>;
	/** false: only flush()/commitNow() commit. Default true. */
	readonly autoCommit?: boolean;
	/** false: putCheckpoint never deletes segments. Default true. */
	readonly gcOnCheckpoint?: boolean;
	readonly readOnlyDevices?: readonly DeviceId[];
	/** Default link for every socket (override per device with setLink). */
	readonly link?: LinkSpec;
	readonly maxSockets?: number;
}

export interface SimRow extends RelayRow {
	readonly stream: StreamName;
}

export interface SimSessionInfo {
	readonly id: number;
	readonly deviceId: DeviceId;
	readonly headSeq: Seq;
	readonly canWrite: boolean;
	readonly ordinal: number;
}

export type SimConnectFailureReason = Extract<RelayConnectResult, { ok: false }>["reason"];

/** Rejection of feed/read/putCheckpoint: an HTTP 400 code of relay-wire §6-§8, or "network_error". */
export class SimRelayError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`sim relay: ${code}`);
		this.name = "SimRelayError";
		this.code = code;
	}
}

/** Server -> client socket messages (relay-wire §4), before the adapter maps them to RelayEvents. */
export type DownMsg =
	| { readonly k: "provisional"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	| { readonly k: "committed"; readonly stream: StreamName; readonly seq: Seq; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly payload: Uint8Array }
	| { readonly k: "notice"; readonly stream: StreamName; readonly seq: Seq; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId }
	| { readonly k: "receipts"; readonly head: Seq; readonly receipts: readonly { readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly seq: Seq; readonly deduped: boolean }[] }
	| { readonly k: "rejected"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly code: "write_forbidden" | "client_frame_id_conflict"; readonly seq: Seq | null }
	| { readonly k: "vaultError"; readonly code: "durability_failed" | "cf_daily_limit"; readonly stream: StreamName; readonly clientFrameIds: readonly ClientFrameId[]; readonly resetAt: number | null }
	| { readonly k: "dropped"; readonly stream: StreamName; readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly reason: string }
	| { readonly k: "resend"; readonly head: Seq }
	| { readonly k: "backpressure" }
	| { readonly k: "pong"; readonly head: Seq }
	| { readonly k: "error"; readonly code: string }
	| { readonly k: "close"; readonly code: number; readonly wasClean: boolean }
	/** inject(): an arbitrary port event, delivered in order. */
	| { readonly k: "event"; readonly event: RelayEvent };

/** Client -> server socket traffic. */
export type UpMsg =
	| { readonly k: "append"; readonly frame: AppendFrame; readonly bytes: number }
	| { readonly k: "close"; readonly code: number };

export function frameKey(deviceId: string, clientFrameId: string): string {
	return `${deviceId}\u0000${clientFrameId}`;
}

export function heldKey(stream: string, deviceId: string, clientFrameId: string): string {
	return `${stream}\u0000${deviceId}\u0000${clientFrameId}`;
}

export function isProvisionalStream(stream: string): boolean {
	return stream.startsWith("b:") || stream.startsWith("c:");
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function utf8Length(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

export function validStreamName(stream: string): boolean {
	const n = utf8Length(stream);
	return n >= 1 && n <= 256;
}

export function validClientFrameId(id: string): boolean {
	const n = utf8Length(id);
	return n >= 1 && n <= 128;
}

export function validSeq(n: number): boolean {
	return Number.isSafeInteger(n) && n >= 0;
}

export function varUintLength(n: number): number {
	let len = 1;
	while (n >= 0x80) {
		n = Math.floor(n / 0x80);
		len++;
	}
	return len;
}

function varStringLength(s: string): number {
	const n = utf8Length(s);
	return varUintLength(n) + n;
}

/** Binary APPEND message size: kind byte + varstring stream + varstring clientFrameId + varbytes payload. */
export function appendMessageBytes(frame: AppendFrame): number {
	const n = frame.payload.byteLength;
	return 1 + varStringLength(frame.stream) + varStringLength(frame.clientFrameId) + varUintLength(n) + n;
}

/** Encoded row size in a segment (server encodeRow). */
export function rowBytes(row: RelayRow): number {
	const n = row.payload.byteLength;
	return varUintLength(row.seq) + varStringLength(row.deviceId) + varStringLength(row.clientFrameId) + varUintLength(n) + n;
}

export function nextUtcMidnight(now: number): number {
	return (Math.floor(now / 86_400_000) + 1) * 86_400_000;
}

/** Real-time ClockPort (non-simulated use of SimRelay, e.g. manual tests). */
export function realClock(): ClockPort {
	const start = Date.now();
	return {
		now: () => Date.now(),
		monotonic: () => (typeof performance !== "undefined" ? performance.now() : Date.now() - start),
		setTimer: (delayMs, fn) => setTimeout(fn, Math.max(0, delayMs)) as unknown as TimerHandle,
		clearTimer: (handle) => clearTimeout(handle),
		yieldNow: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
	};
}
