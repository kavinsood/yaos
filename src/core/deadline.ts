/**
 * No network call waits forever (DESIGN §j.1 "Liveness"). Two shapes, one mechanism (`watched`):
 *
 * - A call whose transport reports progress (a fetch whose response body is read chunk by chunk: the relay's feed,
 *   read and readBatch, engine/adapters/relayHttp.ts) is watched: RELAY_HTTP_BASE_MS for the response headers
 *   (time to first byte), then RELAY_HTTP_IDLE_MS without a body chunk ends it as "stalled", and a total backstop
 *   (relayHttpDeadlineMs of its byte bound) ends a reply that trickles. A dead or stalled connection is seen in
 *   seconds; a slow link that keeps moving is cut only by the backstop.
 * - A call whose transport reports nothing until it settles (a fetch PUT's upload, Obsidian's requestUrl, which
 *   buffers and takes no signal) gets `bounded`: one deadline proportional to the bytes it can move.
 *
 * A blob body (up to 100 MB) has no total at all, only its own idle window (adapters/httpBlob.ts). In every case the
 * caller's signal (the session closed, the sweep or the engine stopped) ends the call too, and untilAborted makes
 * the end hold even when the transport ignores its signal. Used by the relay HTTP calls (engine/adapters/relayHttp.ts),
 * the blob GC routes (engine/adapters/httpBlob.ts) and pairing / operator calls (host/ui/pairing.ts).
 */

import type { ClockPort } from "../ports/clock";

/** lib.dom types AbortSignal.reason as `any`; it is whatever abort() was given (a DOMException by default). */
const abortReason = (signal: AbortSignal): unknown => signal.reason;

/**
 * `p`, or a rejection (the signal's reason) as soon as `signal` aborts. A deadline then holds even when the fetch
 * behind `p` ignores its signal: a request nobody answers is never awaited past it.
 */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) {
		p.catch(() => undefined);
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

/**
 * Time to first byte: the request until its response headers, whatever its size. On the deployed relay one HTTP
 * request costs about 9 edge RTTs (≈ 220 ms, relay-wire §7.1); 15 s covers a cold Durable Object and a congested
 * link many times over, and is connect's whole budget for ticket + upgrade + VAULT_READY (wsRelay
 * DEFAULT_READY_TIMEOUT_MS). Also the base of every byte-proportional deadline.
 */
export const RELAY_HTTP_BASE_MS = 15_000;
/**
 * A watched reply body that delivers no chunk for this long is dead ("stalled"). 10 s outlasts three TCP
 * retransmissions in a row (RFC 6298 minimum RTO 1 s, doubling: 1 + 2 + 4 = 7 s) and a Wi-Fi roam; a link that
 * loses more than that has dropped the connection in all but name, and the read is cheaper to retry (its cursor is
 * unchanged) than to wait on. Shorter than the blob window (core/limits.ts BLOB_TRANSFER_IDLE_MS, 60 s): a relay
 * page is at most a few MiB and on the session's critical path, a blob is up to 100 MB in the background.
 */
export const RELAY_HTTP_IDLE_MS = 10_000;
/**
 * The slowest link a byte-proportional deadline allows for at its bound: 64 KiB/s (512 kbit/s, 3G-class). For a
 * watched call it is only the backstop (a dead connection ends at the idle window long before): the largest relay
 * read page (one 4 MiB checkpoint, relayHttp.ts readPageBound) gets 79 s. For a bounded call (a checkpoint PUT, a
 * pairing call) it is the whole deadline. A slower link is ended and the call retries after its backoff
 * (sessionLoop.ts readBackoffMs).
 */
export const RELAY_HTTP_FLOOR_BYTES_PER_S = 64 * 1024;
/** A reply without rows (feed head, checkpoint result, error body, a pairing or operator reply). */
export const RELAY_REPLY_BYTES = 4096;

/**
 * The deadline of a call that moves at most `bytes` on the wire: RELAY_HTTP_BASE_MS for the request itself plus
 * the bytes at RELAY_HTTP_FLOOR_BYTES_PER_S. The whole deadline of a bounded call, the backstop of a watched one.
 */
export function relayHttpDeadlineMs(bytes: number): number {
	return RELAY_HTTP_BASE_MS + Math.ceil((bytes * 1000) / RELAY_HTTP_FLOOR_BYTES_PER_S);
}

/** The windows of a watched call (all ms). */
export interface WatchLimits {
	/** Until the first sign of progress (the response headers). */
	readonly firstByteMs: number;
	/** Between two signs of progress after the first. */
	readonly idleMs: number;
	/** The whole call, progress or not. */
	readonly totalMs: number;
}

/** How a watched call was ended from this side: no first byte or past its total ("timeout"), no progress ("stalled"). */
export type WatchedEnd = "timeout" | "stalled" | "aborted";

/**
 * `run` with a signal that aborts when the call is ended from this side: no `progress()` within
 * `firstByteMs` ("timeout"), then none for `idleMs` ("stalled"), the whole call past `totalMs` ("timeout"), or
 * `signal` aborts ("aborted"). `run` calls `progress` on every sign of life (headers, each body chunk). Its result
 * is raced against that signal (untilAborted), so the call ends then even when `run` ignores it. Rejects with
 * `ended(why)` when the call was ended from this side, whatever `run` settled with. One listener on `signal`,
 * removed on exit: no AbortSignal.any (WebKit has it only from Safari 17.4).
 */
export async function watched<T>(
	limits: WatchLimits,
	signal: AbortSignal | undefined,
	timers: Pick<ClockPort, "setTimer" | "clearTimer">,
	run: (s: AbortSignal, progress: () => void) => Promise<T>,
	ended: (why: WatchedEnd) => Error,
): Promise<T> {
	if (signal?.aborted) throw ended("aborted");
	const ctl = new AbortController();
	let why: WatchedEnd | null = null;
	let idle: ReturnType<typeof timers.setTimer> | null = null;
	const total = timers.setTimer(limits.totalMs, () => end("timeout"));
	const clearIdle = (): void => {
		if (idle !== null) timers.clearTimer(idle);
		idle = null;
	};
	const end = (w: WatchedEnd): void => {
		if (why !== null) return;
		why = w;
		clearIdle();
		ctl.abort(ended(w));
	};
	let first = true;
	const progress = (): void => {
		if (why !== null) return;
		clearIdle();
		const w: WatchedEnd = first ? "timeout" : "stalled";
		idle = timers.setTimer(first ? limits.firstByteMs : limits.idleMs, () => end(w));
	};
	progress();
	first = false;
	const onAbort = (): void => end("aborted");
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const out = await untilAborted(run(ctl.signal, progress), ctl.signal);
		if (why !== null) throw ended(why);
		return out;
	} catch (e) {
		throw why !== null ? ended(why) : e;
	} finally {
		timers.clearTimer(total);
		clearIdle();
		signal?.removeEventListener("abort", onAbort);
	}
}

/** How a bounded call was ended from this side. */
export type BoundedEnd = "timeout" | "aborted";

/**
 * `run` ended after `ms` ("timeout") or when `signal` aborts ("aborted"): a watched call whose transport reports no
 * progress, so its one window is the whole deadline.
 */
export function bounded<T>(
	ms: number,
	signal: AbortSignal | undefined,
	timers: Pick<ClockPort, "setTimer" | "clearTimer">,
	run: (s: AbortSignal) => Promise<T>,
	ended: (why: BoundedEnd) => Error,
): Promise<T> {
	return watched({ firstByteMs: ms, idleMs: ms, totalMs: ms }, signal, timers, (s) => run(s), (why) => ended(why === "stalled" ? "timeout" : why));
}
