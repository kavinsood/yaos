/**
 * Blob store calls tied to the relay link (DESIGN §j.1). The blob store is HTTP over the same network as the
 * relay socket; when the session loop declares that link dead (the socket closed abnormally, the liveness check
 * failed, or the user paused / the app parked / the engine stopped: runtime/sessionLoop.ts), abort() ends every
 * store call in flight instead of leaving it to its adapter's idle watchdog (BLOB_TRANSFER_IDLE_MS, has / put /
 * get) or deadline (list / deleteIfUploadedBefore, adapters/httpBlob.ts gcCall). The aborted calls reject; their
 * callers retry as after any transport error (the blob queue with its backoff; a GC sweep ends and reports it).
 *
 * Each call's signal combines the caller's own (the blob queue's stop) with the link's. Not AbortSignal.any:
 * WebKit (every iOS WebView) has it only from Safari 17.4; the listeners here are removed when the call settles.
 */

import type { BlobPort } from "../../ports/blob";

export class BlobLinkLostError extends Error {
	override readonly name = "BlobLinkLostError";
	constructor(readonly why: string) {
		super(`blob transfer aborted: link lost (${why})`);
	}
}

export class TransferLink {
	private ctl = new AbortController();
	private active = 0;

	/** Calls in flight through wrap(). */
	get inFlight(): number {
		return this.active;
	}

	/** Abort every call in flight; later calls get a fresh signal. Returns how many were in flight. */
	abort(why: string): number {
		const n = this.active;
		const old = this.ctl;
		this.ctl = new AbortController();
		old.abort(new BlobLinkLostError(why));
		return n;
	}

	/** `inner` with every call also aborted by abort(). */
	wrap(inner: BlobPort | null): BlobPort | null {
		if (!inner) return null;
		const run = async <T>(signal: AbortSignal | undefined, call: (s: AbortSignal) => Promise<T>): Promise<T> => {
			const s = linked(this.ctl.signal, signal);
			this.active++;
			try {
				return await call(s.signal);
			} finally {
				this.active--;
				s.done();
			}
		};
		return {
			get maxBlobBytes() {
				return inner.maxBlobBytes;
			},
			has: (a, signal) => run(signal, (s) => inner.has(a, s)),
			put: (address, parts, signal) => run(signal, (s) => inner.put(address, parts, s)),
			get: (a, signal) => run(signal, (s) => inner.get(a, s)),
			list: (cursor, signal) => run(signal, (s) => inner.list(cursor, s)),
			deleteIfUploadedBefore: (addresses, cutoffMs, signal) => run(signal, (s) => inner.deleteIfUploadedBefore(addresses, cutoffMs, s)),
		};
	}
}

/** A signal aborted by either input (with its reason); done() detaches it. */
function linked(a: AbortSignal, b: AbortSignal | undefined): { readonly signal: AbortSignal; done(): void } {
	if (!b || b.aborted) return { signal: b?.aborted ? b : a, done: () => undefined };
	if (a.aborted) return { signal: a, done: () => undefined };
	const ctl = new AbortController();
	const onA = (): void => ctl.abort(a.reason);
	const onB = (): void => ctl.abort(b.reason);
	a.addEventListener("abort", onA, { once: true });
	b.addEventListener("abort", onB, { once: true });
	return {
		signal: ctl.signal,
		done: () => {
			a.removeEventListener("abort", onA);
			b.removeEventListener("abort", onB);
		},
	};
}
