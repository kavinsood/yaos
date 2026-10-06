/**
 * Production RelayPort over the streams wire v1 (docs/client-remake/relay-wire.md).
 *
 * connect(): fresh ticket (POST /vault/:id/auth/ticket {purpose:"streams"}),
 * then wss://host/vault/:id/ws/streams?ticket=...&streamsVersion=1, then
 * VAULT_READY. Every failure resolves to {ok:false}; connect never rejects.
 *
 * Session semantics beyond the port contract:
 * - Events that arrive before the first onEvent listener are buffered and
 *   flushed (synchronously, in order) to that listener.
 * - PROVISIONAL payloads are held in a bounded join map keyed by
 *   (stream, deviceId, clientFrameId) so a COMMIT_NOTICE can be emitted as
 *   "committed" with the payload; evicted entries yield payload:null.
 * - Liveness: after VAULT_READY.liveness.idleMs without any received frame a
 *   VAULT_PING is sent; with nothing received within timeoutMs the socket is
 *   closed with LIVENESS_CLOSE_CODE and "closed" is emitted.
 * - Exactly one "closed" event ends every session. close() emits it
 *   synchronously; later socket callbacks are ignored.
 *
 * Secrets: the device token stays inside relayHttp (Authorization header);
 * the ticket only appears in the socket URL, which is never logged or put in
 * an error message.
 */

import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { RandomPort } from "../../ports/random";
import type {
	AppendFrame,
	RelayConnectParams,
	RelayConnectResult,
	RelayEvent,
	RelayLimits,
	RelayPort,
	RelaySession,
} from "../../ports/relay";
import type { Unsubscribe } from "../../ports/common";
import type { ClientFrameId, DeviceId, StreamName } from "../../core/types";
import { createRelayHttp, normalizeBaseUrl, type ConnectFailureReason, type RelayHttp } from "./relayHttp";
import {
	decodeServerFrame,
	encodeAppend,
	encodePing,
	parseControl,
	STREAMS_VERSION,
	type WireControl,
	type WireLimits,
	type WireServerFrame,
} from "./relayFrames";

/** The subset of the DOM WebSocket this adapter uses (the DOM class is assignable to it). */
export interface WebSocketLike {
	binaryType: string;
	readonly bufferedAmount: number;
	readonly readyState: number;
	onopen: ((ev: Event) => void) | null;
	onmessage: ((ev: MessageEvent) => void) | null;
	onerror: ((ev: Event) => void) | null;
	onclose: ((ev: CloseEvent) => void) | null;
	send(data: string | ArrayBufferLike | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface WsRelayOptions {
	readonly baseUrl: string;
	/** Device token. Secret: never logged, never in errors. */
	readonly credential: string;
	readonly fetch?: typeof fetch;
	readonly WebSocketImpl?: WebSocketCtor;
	readonly clock: ClockPort;
	/** Ping probe ids; a counter is used when absent. */
	readonly random?: RandomPort;
	/** Ticket fetch + socket open + VAULT_READY budget. Default 15 s. */
	readonly readyTimeoutMs?: number;
	/** Join-map budget for held PROVISIONAL payloads. Default 16 MiB. */
	readonly provisionalCacheBytes?: number;
	/** Join-map entry cap. Default 4096. */
	readonly provisionalCacheEntries?: number;
	/** A listener threw. Default: rethrow asynchronously (queueMicrotask) so the frame loop keeps going. */
	readonly onListenerError?: (error: unknown) => void;
	/** Overrides VAULT_READY.liveness (power tuning, e2e). */
	readonly liveness?: { readonly idleMs?: number; readonly timeoutMs?: number };
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
	maxFrameBytes: 1024 * 1024,
	maxCheckpointBytes: 4 * 1024 * 1024,
	appendBytesPerSec: 256 * 1024,
	burstBytes: 2 * 1024 * 1024,
	feedPageRows: 1000,
	readPageBytes: 1024 * 1024,
};

export const DEFAULT_LIVENESS = { idleMs: 60_000, timeoutMs: 15_000 } as const;
export const DEFAULT_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_PROVISIONAL_CACHE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PROVISIONAL_CACHE_ENTRIES = 4096;
/** Client-initiated close after a liveness timeout (no pong). */
export const LIVENESS_CLOSE_CODE = 4000;
export const LIVENESS_TIMEOUT_ERROR = "liveness_timeout";

const WS_OPEN = 1;

export function mapLimits(wire: WireLimits): RelayLimits {
	return {
		maxFrameBytes: wire.maxPayloadBytes ?? DEFAULT_RELAY_LIMITS.maxFrameBytes,
		maxCheckpointBytes: wire.maxCheckpointBytes ?? DEFAULT_RELAY_LIMITS.maxCheckpointBytes,
		appendBytesPerSec: wire.rateBytesPerSec ?? DEFAULT_RELAY_LIMITS.appendBytesPerSec,
		burstBytes: wire.burstBytes ?? DEFAULT_RELAY_LIMITS.burstBytes,
		feedPageRows: wire.feedDefaultLimit ?? DEFAULT_RELAY_LIMITS.feedPageRows,
		readPageBytes: wire.readDefaultBytes ?? DEFAULT_RELAY_LIMITS.readPageBytes,
	};
}

/** Upgrade `error` control code (before VAULT_READY) -> connect failure. */
export function mapUpgradeError(code: string): ConnectFailureReason {
	switch (code) {
		case "unauthorized": return "unauthorized";
		case "update_required": return "update-required";
		case "unclaimed": return "unclaimed";
		case "authority_superseded": return "superseded";
		default: return "unavailable";
	}
}

/** http(s)://host[/prefix] -> ws(s)://host[/prefix]/vault/:id/ws/streams?ticket=..&streamsVersion=1 */
export function streamsSocketUrl(baseUrl: string, vaultId: string, ticket: string): string {
	const base = normalizeBaseUrl(baseUrl).replace(/^http(s?):/i, (_m, s: string) => `ws${s}:`);
	return `${base}/vault/${encodeURIComponent(vaultId)}/ws/streams?ticket=${encodeURIComponent(ticket)}&streamsVersion=${STREAMS_VERSION}`;
}

/** Bounded FIFO join map for PROVISIONAL payloads (entries are consumed once, so FIFO = LRU). */
export class ProvisionalJoin {
	private readonly entries = new Map<string, Uint8Array>();
	private bytes = 0;
	constructor(private readonly maxBytes: number, private readonly maxEntries: number) {}

	static key(stream: string, deviceId: string, clientFrameId: string): string {
		return JSON.stringify([stream, deviceId, clientFrameId]);
	}

	get size(): number { return this.entries.size; }
	get heldBytes(): number { return this.bytes; }

	put(key: string, payload: Uint8Array): void {
		this.delete(key);
		if (payload.byteLength > this.maxBytes || this.maxEntries <= 0) return;
		this.entries.set(key, payload);
		this.bytes += payload.byteLength;
		while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) break;
			this.delete(oldest.value);
		}
	}

	/** Removes and returns the payload (null when not held). */
	take(key: string): Uint8Array | null {
		const payload = this.entries.get(key);
		if (payload === undefined) return null;
		this.delete(key);
		return payload;
	}

	delete(key: string): void {
		const payload = this.entries.get(key);
		if (payload === undefined) return;
		this.entries.delete(key);
		this.bytes -= payload.byteLength;
	}

	clear(): void {
		this.entries.clear();
		this.bytes = 0;
	}
}

function closeQuietly(ws: WebSocketLike, code: number, reason: string): void {
	// The DOM only accepts 1000 or 3000-4999 from clients, and a reason of <= 123 UTF-8 bytes.
	const wireCode = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
	let wireReason = reason;
	while (new TextEncoder().encode(wireReason).byteLength > 123) wireReason = wireReason.slice(0, -1);
	try {
		ws.close(wireCode, wireReason);
	} catch {
		// Already closing or closed.
	}
}

function detach(ws: WebSocketLike): void {
	ws.onopen = null;
	ws.onmessage = null;
	ws.onerror = null;
	ws.onclose = null;
}

function messageBytes(data: unknown): Uint8Array | null {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return null;
}

interface SessionInit {
	readonly ws: WebSocketLike;
	readonly http: RelayHttp;
	readonly vaultId: string;
	readonly clock: ClockPort;
	readonly nextProbeId: () => string;
	readonly ready: Extract<WireControl, { type: "VAULT_READY" }>;
	readonly join: ProvisionalJoin;
	readonly onListenerError: (error: unknown) => void;
	readonly liveness: { readonly idleMs?: number; readonly timeoutMs?: number } | undefined;
}

class WsRelaySession implements RelaySession {
	readonly vaultEpoch: string;
	readonly headSeq: number;
	readonly canWrite: boolean;
	readonly limits: RelayLimits;

	private readonly ws: WebSocketLike;
	private readonly http: RelayHttp;
	private readonly vaultId: string;
	private readonly clock: ClockPort;
	private readonly nextProbeId: () => string;
	private readonly join: ProvisionalJoin;
	private readonly onListenerError: (error: unknown) => void;
	private readonly idleMs: number;
	private readonly timeoutMs: number;

	private readonly listeners = new Set<(event: RelayEvent) => void>();
	private pending: RelayEvent[] | null = [];
	private closed = false;
	private errorCode: string | null = null;

	private lastRx: number;
	private idleTimer: TimerHandle | null = null;
	private timeoutTimer: TimerHandle | null = null;

	constructor(init: SessionInit) {
		this.ws = init.ws;
		this.http = init.http;
		this.vaultId = init.vaultId;
		this.clock = init.clock;
		this.nextProbeId = init.nextProbeId;
		this.join = init.join;
		this.onListenerError = init.onListenerError;
		this.vaultEpoch = init.ready.vaultEpoch;
		this.headSeq = init.ready.head;
		this.canWrite = init.ready.canWrite;
		this.limits = mapLimits(init.ready.limits);
		this.idleMs = init.liveness?.idleMs ?? init.ready.liveness?.idleMs ?? DEFAULT_LIVENESS.idleMs;
		this.timeoutMs = init.liveness?.timeoutMs ?? init.ready.liveness?.timeoutMs ?? DEFAULT_LIVENESS.timeoutMs;
		this.lastRx = this.clock.monotonic();

		this.ws.onmessage = (ev) => this.onMessage(ev.data);
		this.ws.onclose = (ev) => this.finish(ev.code, this.errorCode, ev.wasClean);
		this.ws.onerror = null;
		this.scheduleIdle(this.idleMs);
	}

	append(frame: AppendFrame): void {
		if (frame.payload.byteLength > this.limits.maxFrameBytes) {
			throw new RangeError(`relay append: payload ${frame.payload.byteLength} B exceeds maxFrameBytes ${this.limits.maxFrameBytes}`);
		}
		if (this.closed || this.ws.readyState !== WS_OPEN) return;
		try {
			this.ws.send(encodeAppend(frame));
		} catch {
			// The close event follows; the frame stays unreceipted and is resent.
		}
	}

	bufferedBytes(): number {
		return this.closed ? 0 : this.ws.bufferedAmount;
	}

	feed(afterSeq: number) {
		return this.http.feed(this.vaultId, afterSeq, this.limits.feedPageRows);
	}

	read(stream: StreamName, afterSeq: number, preferCheckpoint: boolean) {
		return this.http.read(this.vaultId, stream, afterSeq, preferCheckpoint, this.limits.readPageBytes);
	}

	putCheckpoint(stream: StreamName, coversSeq: number, expectedPrevCoversSeq: number, bytes: Uint8Array) {
		return this.http.putCheckpoint(this.vaultId, stream, coversSeq, expectedPrevCoversSeq, bytes);
	}

	onEvent(listener: (event: RelayEvent) => void): Unsubscribe {
		this.listeners.add(listener);
		const buffered = this.pending;
		if (buffered !== null) {
			this.pending = null;
			for (const event of buffered) this.deliver(listener, event);
		}
		return () => {
			this.listeners.delete(listener);
		};
	}

	close(code: number, reason: string): void {
		if (this.closed) return;
		closeQuietly(this.ws, code, reason);
		this.finish(code, null, true);
	}

	// ---- internals -----------------------------------------------------------

	private deliver(listener: (event: RelayEvent) => void, event: RelayEvent): void {
		try {
			listener(event);
		} catch (error) {
			// A throwing listener must not tear the frame loop or starve the other listeners.
			this.onListenerError(error);
		}
	}

	private emit(event: RelayEvent): void {
		if (this.pending !== null) {
			this.pending.push(event);
			return;
		}
		for (const listener of Array.from(this.listeners)) this.deliver(listener, event);
	}

	private finish(code: number, errorCode: string | null, wasClean: boolean): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimers();
		detach(this.ws);
		this.join.clear();
		this.emit({ t: "closed", code, errorCode, wasClean });
	}

	private clearTimers(): void {
		if (this.idleTimer !== null) this.clock.clearTimer(this.idleTimer);
		if (this.timeoutTimer !== null) this.clock.clearTimer(this.timeoutTimer);
		this.idleTimer = null;
		this.timeoutTimer = null;
	}

	private scheduleIdle(delayMs: number): void {
		if (this.idleTimer !== null) this.clock.clearTimer(this.idleTimer);
		this.idleTimer = this.clock.setTimer(Math.max(0, delayMs), () => {
			this.idleTimer = null;
			if (this.closed || this.timeoutTimer !== null) return;
			const silent = this.clock.monotonic() - this.lastRx;
			if (silent < this.idleMs) {
				this.scheduleIdle(this.idleMs - silent);
				return;
			}
			this.ping();
		});
	}

	private ping(): void {
		try {
			this.ws.send(encodePing(this.nextProbeId()));
		} catch {
			// The timeout below closes the socket if it is dead.
		}
		this.timeoutTimer = this.clock.setTimer(this.timeoutMs, () => {
			this.timeoutTimer = null;
			if (this.closed) return;
			closeQuietly(this.ws, LIVENESS_CLOSE_CODE, LIVENESS_TIMEOUT_ERROR);
			this.finish(LIVENESS_CLOSE_CODE, LIVENESS_TIMEOUT_ERROR, false);
		});
	}

	private noteReceived(): void {
		this.lastRx = this.clock.monotonic();
		if (this.timeoutTimer !== null) {
			this.clock.clearTimer(this.timeoutTimer);
			this.timeoutTimer = null;
			this.scheduleIdle(this.idleMs);
		}
	}

	private onMessage(data: unknown): void {
		if (this.closed) return;
		this.noteReceived();
		if (typeof data === "string") {
			const control = parseControl(data);
			if (control !== null) this.onControl(control);
			return;
		}
		const bytes = messageBytes(data);
		if (bytes === null) return;
		const frame = decodeServerFrame(bytes);
		if (frame !== null) this.onFrame(frame);
	}

	private onFrame(frame: WireServerFrame): void {
		const stream = frame.stream as StreamName;
		const deviceId = frame.deviceId as DeviceId;
		const clientFrameId = frame.clientFrameId as ClientFrameId;
		switch (frame.kind) {
			case "provisional":
				this.join.put(ProvisionalJoin.key(frame.stream, frame.deviceId, frame.clientFrameId), frame.payload);
				this.emit({ t: "provisional", stream, deviceId, clientFrameId, payload: frame.payload });
				return;
			case "committed":
				this.emit({ t: "committed", frame: { stream, seq: frame.seq, deviceId, clientFrameId, payload: frame.payload } });
				return;
			case "notice": {
				const payload = this.join.take(ProvisionalJoin.key(frame.stream, frame.deviceId, frame.clientFrameId));
				this.emit({ t: "committed", frame: { stream, seq: frame.seq, deviceId, clientFrameId, payload } });
				return;
			}
		}
	}

	private onControl(control: WireControl): void {
		switch (control.type) {
			case "STREAM_RECEIPTS":
				for (const r of control.receipts) {
					this.emit({
						t: "receipt",
						stream: r.stream as StreamName,
						clientFrameId: r.clientFrameId as ClientFrameId,
						seq: r.seq,
						deduped: r.deduped,
					});
				}
				this.emit({ t: "head", headSeq: control.head });
				return;
			case "STREAM_APPEND_REJECTED": {
				// Unknown codes are ignored (forward-compatible); the frame stays unreceipted.
				const reason = control.code === "client_frame_id_conflict" ? "frame-id-conflict"
					: control.code === "write_forbidden" ? "forbidden" : null;
				if (reason === null) return;
				this.emit({
					t: "refused",
					stream: control.stream as StreamName,
					clientFrameId: control.clientFrameId as ClientFrameId,
					reason,
					retryAfterMs: null,
					conflictSeq: reason === "frame-id-conflict" ? control.seq : null,
				});
				return;
			}
			case "STREAM_PROVISIONAL_DROPPED":
				this.join.delete(ProvisionalJoin.key(control.stream, control.deviceId, control.clientFrameId));
				this.emit({
					t: "provisionalDropped",
					stream: control.stream as StreamName,
					deviceId: control.deviceId as DeviceId,
					clientFrameId: control.clientFrameId as ClientFrameId,
				});
				return;
			case "STREAM_RESEND":
				this.join.clear();
				this.emit({ t: "resendUnreceipted", headSeq: control.head });
				return;
			case "VAULT_PONG":
				this.emit({ t: "head", headSeq: control.head });
				return;
			case "VAULT_BACKPRESSURE":
				this.emit({ t: "backpressure" });
				return;
			case "VAULT_ERROR": {
				const reason = control.code === "durability_failed" ? "durability"
					: control.code === "cf_daily_limit" ? "daily-limit" : null;
				if (reason === null || control.stream === null) return;
				const retryAfterMs = reason === "daily-limit" && control.resetAt !== null
					? Math.max(0, control.resetAt - this.clock.now()) : null;
				for (const id of control.clientFrameIds) {
					this.emit({
						t: "refused",
						stream: control.stream as StreamName,
						clientFrameId: id as ClientFrameId,
						reason,
						retryAfterMs,
						conflictSeq: null,
					});
				}
				return;
			}
			case "error":
				this.errorCode = control.code;
				return;
			case "VAULT_READY":
				return;
		}
	}
}

function resolveWebSocket(impl: WebSocketCtor | undefined): WebSocketCtor | null {
	if (impl) return impl;
	if (typeof WebSocket === "undefined") return null;
	return WebSocket;
}

export function createWsRelayPort(opts: WsRelayOptions): RelayPort {
	const http = createRelayHttp({ baseUrl: opts.baseUrl, credential: opts.credential, fetch: opts.fetch, clock: opts.clock });
	const clock = opts.clock;
	const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const cacheBytes = opts.provisionalCacheBytes ?? DEFAULT_PROVISIONAL_CACHE_BYTES;
	const cacheEntries = opts.provisionalCacheEntries ?? DEFAULT_PROVISIONAL_CACHE_ENTRIES;
	const onListenerError = opts.onListenerError ?? ((error: unknown) => {
		queueMicrotask(() => {
			throw error;
		});
	});
	let probeCounter = 0;
	const nextProbeId = (): string => {
		probeCounter += 1;
		if (!opts.random) return `p${probeCounter}`;
		let hex = "";
		for (const b of opts.random.bytes(8)) hex += b.toString(16).padStart(2, "0");
		return `p${probeCounter}-${hex}`;
	};

	async function connect(params: RelayConnectParams): Promise<RelayConnectResult> {
		const Impl = resolveWebSocket(opts.WebSocketImpl);
		if (Impl === null) return { ok: false, reason: "unavailable", retryAfterMs: null };
		const started = clock.monotonic();
		const ticket = await http.ticket(params.vaultId);
		if (!ticket.ok) return { ok: false, reason: ticket.reason, retryAfterMs: ticket.retryAfterMs };
		const remaining = readyTimeoutMs - (clock.monotonic() - started);
		if (remaining <= 0) return { ok: false, reason: "unavailable", retryAfterMs: null };

		let ws: WebSocketLike;
		try {
			ws = new Impl(streamsSocketUrl(opts.baseUrl, params.vaultId, ticket.ticket));
			ws.binaryType = "arraybuffer";
		} catch {
			// The constructor message may echo the URL (which carries the ticket): drop it.
			return { ok: false, reason: "unavailable", retryAfterMs: null };
		}

		return new Promise<RelayConnectResult>((resolve) => {
			let settled = false;
			const settle = (result: RelayConnectResult): void => {
				if (settled) return;
				settled = true;
				clock.clearTimer(timer);
				resolve(result);
			};
			const fail = (reason: ConnectFailureReason): void => {
				detach(ws);
				closeQuietly(ws, 1000, "connect_failed");
				settle({ ok: false, reason, retryAfterMs: null });
			};
			const timer = clock.setTimer(remaining, () => fail("unavailable"));

			ws.onopen = null;
			ws.onerror = null;
			ws.onclose = () => {
				detach(ws);
				settle({ ok: false, reason: "unavailable", retryAfterMs: null });
			};
			ws.onmessage = (ev) => {
				if (typeof ev.data !== "string") return;
				const control = parseControl(ev.data);
				if (control === null) return;
				if (control.type === "error") {
					fail(mapUpgradeError(control.code));
					return;
				}
				if (control.type !== "VAULT_READY") return;
				const session = new WsRelaySession({
					ws,
					http,
					vaultId: params.vaultId,
					clock,
					nextProbeId,
					ready: control,
					join: new ProvisionalJoin(cacheBytes, cacheEntries),
					onListenerError,
					liveness: opts.liveness,
				});
				settle({ ok: true, session });
			};
		});
	}

	return { connect };
}
