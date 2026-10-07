/**
 * No network call waits forever (DESIGN §j.1 "Liveness"). One mechanism for every call to the relay that is not a
 * blob body (a blob, up to 100 MB, gets an idle window instead: adapters/httpBlob.ts): a deadline proportional to
 * the bytes the call can move, and the caller's signal (the session closed, the sweep or the engine stopped); the
 * first to trip ends the call. untilAborted makes both hold even when the transport ignores its signal (a fetch
 * that never settles, or Obsidian's requestUrl, which takes none). Used by the relay HTTP calls
 * (engine/adapters/relayHttp.ts), the blob GC routes (engine/adapters/httpBlob.ts) and pairing / operator calls
 * (host/ui/pairing.ts).
 */

import type { ClockPort } from "../ports/clock";

/**
 * `p`, or a rejection (the signal's reason) as soon as `signal` aborts. A deadline then holds even when the fetch
 * behind `p` ignores its signal: a request nobody answers is never awaited past it.
 */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) {
		p.catch(() => undefined);
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
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
 * The request itself, whatever its size: on the deployed relay one HTTP request costs about 9 edge RTTs (≈ 220 ms,
 * relay-wire §7.1); 15 s covers a cold Durable Object and a congested link many times over, and is connect's whole
 * budget for ticket + upgrade + VAULT_READY (wsRelay DEFAULT_READY_TIMEOUT_MS).
 */
export const RELAY_HTTP_BASE_MS = 15_000;
/**
 * The slowest link the deadlines allow for at their byte bound: 64 KiB/s (512 kbit/s, 3G-class). With the relay's
 * page bounds (relayHttp.ts), a default read (1 MiB budget, bound 16 MiB) gets 271 s: its real reply (at most
 * ~4 MiB of base64 and row fields for 1 MiB of payload) still arrives over a 16 KiB/s link, and a page carrying a
 * 4 MiB checkpoint (~5.3 MiB on the wire) over 20 KiB/s. A slower link is ended at the deadline and the call
 * retries after its backoff (sessionLoop.ts readBackoffMs).
 */
export const RELAY_HTTP_FLOOR_BYTES_PER_S = 64 * 1024;
/** A reply without rows (feed head, checkpoint result, error body, a pairing or operator reply). */
export const RELAY_REPLY_BYTES = 4096;

/**
 * The deadline of a call that moves at most `bytes` on the wire: RELAY_HTTP_BASE_MS for the request itself plus
 * the bytes at RELAY_HTTP_FLOOR_BYTES_PER_S. Proportional to the bound, so a large page on a slow link gets the
 * time it needs and a small request that nobody answers (a relay or edge that took it and went quiet while the
 * socket stays up) ends soon; the bound itself is generous, so most replies are far smaller and have far more time
 * than the floor gives.
 */
export function relayHttpDeadlineMs(bytes: number): number {
	return RELAY_HTTP_BASE_MS + Math.ceil((bytes * 1000) / RELAY_HTTP_FLOOR_BYTES_PER_S);
}

/** How a bounded call was ended from this side. */
export type BoundedEnd = "timeout" | "aborted";

/**
 * `run` with a signal that aborts after `ms` ("timeout") or when `signal` does ("aborted"); its result raced
 * against that signal (untilAborted), so the call ends then even when `run` ignores it. Rejects with `ended(why)`
 * when the call was ended from this side, whatever `run` settled with. One listener on `signal`, removed on exit:
 * no AbortSignal.any (WebKit has it only from Safari 17.4).
 */
export async function bounded<T>(
	ms: number,
	signal: AbortSignal | undefined,
	timers: Pick<ClockPort, "setTimer" | "clearTimer">,
	run: (s: AbortSignal) => Promise<T>,
	ended: (why: BoundedEnd) => Error,
): Promise<T> {
	if (signal?.aborted) throw ended("aborted");
	const ctl = new AbortController();
	let why: BoundedEnd | null = null;
	const end = (w: BoundedEnd): void => {
		if (why !== null) return;
		why = w;
		ctl.abort(ended(w));
	};
	const onAbort = (): void => end("aborted");
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = timers.setTimer(ms, () => end("timeout"));
	try {
		const out = await untilAborted(run(ctl.signal), ctl.signal);
		if (why !== null) throw ended(why);
		return out;
	} catch (e) {
		throw why !== null ? ended(why) : e;
	} finally {
		timers.clearTimer(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
