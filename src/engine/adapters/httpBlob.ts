/**
 * BlobPort over the relay's blob routes (relay-wire.md §11.3):
 *   PUT  /vault/:id/blobs/<addr>        204 (400 invalid_address, 411 length_required, 413 over maxBlobUploadBytes)
 *   GET  /vault/:id/blobs/<addr>        200 bytes | 404 {"error":"not found"}
 *   POST /vault/:id/blobs/exists        {"hashes":[<addr>...]} -> {"present":[...]}; more than 50 is 400 too_many_addresses
 *   GET  /vault/:id/blobs?cursor=<addr> {"items":[{address,uploadedAt}],"next"} (§11.3.1; 503 list_incomplete)
 *   POST /vault/:id/blobs/delete        {"ifUploadedBefore":ms,"addresses":[1..100]} -> {"results":[...]} (§11.3.1)
 *
 * The two GC routes share a per-vault request limit (429 too_many_attempts + Retry-After, server/src/vault/host.ts:418-424)
 * and list may answer 503 list_incomplete + Retry-After (server/src/router.ts:652-656). Both are retried here after
 * Retry-After, at most GC_RETRY_ATTEMPTS calls and GC_RETRY_MAX_WAIT_MS per wait; the wait rejects as soon as the
 * caller's signal aborts (engine stop).
 *
 * Without an R2 bucket every route answers 503 attachments_unavailable (a
 * relay deployed without the YAOS_BUCKET binding). That surfaces here as a
 * thrown RelayHttpError with code "attachments_unavailable"; callers should
 * use probeHttpBlob(), which returns null when capabilities.attachments is
 * false. No store = attachments are not synced (fail closed, DESIGN §j.1);
 * blob bytes never ride the relay's sequence log.
 *
 * The address is opaque to the relay (DECISIONS D9): it checks ^[0-9a-f]{64}$
 * and nothing else (no hash check, PUT overwrites; server/src/router.ts:591-594),
 * so it carries CryptoPort.blobAddress as is: the plaintext SHA-256 under
 * suite 0, the keyed address over sealed bytes under suite 1 (e2ee-design
 * §10.1). The exists body's field is named `hashes` on the wire; it carries
 * addresses. Never a plaintext hash under suite 1 (blobs/blobStore.ts).
 *
 * No deadline on put / get / has: a 100 MB body on a 1 MB/s uplink takes 100 s, and a deadline scaled to the size
 * either kills an upload that is still moving on a slow link (EDGE or congested cellular, 12-25 KiB/s, below any
 * useful floor) or waits far too long on a fast one. An idle window instead (BLOB_TRANSFER_IDLE_MS, core/limits.ts):
 * a transfer that moves no byte for that long is aborted as "stalled", every sign of progress restarts the window,
 * and the caller's signal ends a call as "aborted" (both RelayHttpError status 0, a transport error the blob queue
 * retries with its backoff).
 *
 * PUT runs over XMLHttpRequest: fetch exposes no upload progress (a streaming request body needs duplex "half" and
 * HTTP/2, and the relay requires a Content-Length), so an idle check on a fetch PUT is impossible. Evidence: Chromium
 * 149 headless (the Electron desktop / Android WebView engine), a Blob-URL dedicated worker like the plugin's engine
 * worker, a cross-origin PUT with Authorization (a CORS preflight; the relay allows "Authorization, Content-Type"),
 * a 32 MiB Blob: XMLHttpRequest and .upload exist in the worker; upload.onprogress fired 55 times at ~2 MB/s, the
 * first at 112 ms, the largest gap 328 ms; with the server reading 2 MiB and then never again, one progress event
 * (loaded 4.4 MB, ~2.3 MB sitting in socket buffers) and then none, and the idle abort ended it (status 0). Open:
 * WebKit (iOS) was not testable there; the XHR standard exposes it to workers (Exposed=(Window,DedicatedWorker,
 * SharedWorker)) and WebKit forwards upload progress to them. GET and exists stay on fetch: their progress is the
 * response body, read chunk by chunk.
 *
 * A put answered 413 (the relay's JSON or Cloudflare's own HTML page, whatever the body) throws
 * BlobTooLargeError; the blob queue refuses that blob from then on (blobs/blobQueue.ts upload).
 */

import { BLOB_TRANSFER_IDLE_MS, MAX_BLOB_UPLOAD_BYTES } from "../../core/limits";
import { BLOB_DELETE_BATCH, BlobTooLargeError, type BlobDeleteResult, type BlobListItem, type BlobPort, type BlobProgress } from "../../ports/blob";
import type { ClockPort, TimerHandle } from "../../ports/clock";
import type { BlobAddress } from "../../ports/crypto";
import { bounded, relayHttpDeadlineMs, RELAY_REPLY_BYTES, untilAborted } from "../../core/deadline";
import { normalizeBaseUrl, parseRetryAfter, RelayHttpError } from "./relayHttp";
import { createWebClock } from "./webClock";

export const BLOB_EXISTS_BATCH = 50;
/** Calls per GC request, the first included, while the relay answers 429/503 with Retry-After. */
export const GC_RETRY_ATTEMPTS = 5;
/** Longest Retry-After honoured; a longer one fails the call (the GC limit's window is 60 s). */
export const GC_RETRY_MAX_WAIT_MS = 65_000;
/** A list page's items at most (relay-wire §11.3.1: "at most 1000 items"). */
export const BLOB_LIST_PAGE_MAX = 1000;
/**
 * One list item, delete result or delete request address on the wire, at most: {"address":"<64 hex>","uploadedAt":<ms>},
 * is 106 B; a delete result at most 126 B ("newer" with a 16-digit time; server/src/router.ts:810-813); a delete
 * request carries 67 B per address.
 */
export const BLOB_GC_ITEM_WIRE_BYTES = 128;
/** A list call moves at most this much (17 s at relayHttpDeadlineMs). */
export const BLOB_LIST_REPLY_BYTES = RELAY_REPLY_BYTES + BLOB_LIST_PAGE_MAX * BLOB_GC_ITEM_WIRE_BYTES;
/** A delete call, its request and reply, moves at most this much (15.5 s). */
export const BLOB_DELETE_CALL_BYTES = RELAY_REPLY_BYTES + 2 * BLOB_DELETE_BATCH * BLOB_GC_ITEM_WIRE_BYTES;
/** probeHttpBlob's budget for the whole capabilities reply (a small JSON body). */
export const CAPABILITIES_TIMEOUT_MS = 10_000;
const ADDRESS = /^[0-9a-f]{64}$/;

export interface HttpBlobOptions {
	readonly baseUrl: string;
	readonly vaultId: string;
	/** Device token. Secret: Authorization header only. */
	readonly credential: string;
	readonly fetch?: typeof fetch;
	/** The PUT transport (see the header); default globalThis.XMLHttpRequest. Without one every put rejects "unsupported". */
	readonly xhr?: typeof XMLHttpRequest;
	readonly maxBlobBytes?: number;
	/** Retry-After waits, the HTTP-date form's "now" and the idle window's timer; default a web clock. */
	readonly clock?: ClockPort;
	/** A put / get / has that moves no byte for this long is ended as "stalled"; default BLOB_TRANSFER_IDLE_MS. */
	readonly idleMs?: number;
}

function abortError(route: string): RelayHttpError {
	return new RelayHttpError(route, 0, "aborted", null);
}

/** Waits `ms` on `clock`; rejects as soon as `signal` aborts. */
function sleepOn(clock: ClockPort, ms: number, signal: AbortSignal | undefined, route: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(route));
			return;
		}
		const onAbort = () => {
			clock.clearTimer(timer);
			reject(abortError(route));
		};
		const timer = clock.setTimer(ms, () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		});
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** One put / get / has request's end from this side: the caller's signal, or the idle window ran out. */
interface Transfer {
	/** Set once the caller's signal or the idle window ended the transfer. */
	readonly ended: "aborted" | "stalled" | null;
	/**
	 * Aborts when the transfer ends: the fetch's signal, and untilAborted's (core/deadline.ts) around every await on the
	 * fetch or its body, so the end holds even when a fetch ignores its signal.
	 */
	readonly signal: AbortSignal;
	/** Restarts the idle window: a byte moved. */
	kick(): void;
	/** A transport failure as the caller sees it: why the transfer was ended, else network_error. */
	fail(): RelayHttpError;
	/** Clears the timer and the signal's listener; every exit calls it (idempotent). */
	close(): void;
}

/**
 * Starts a transfer's idle window on `clock` and listens to `signal` (one listener; the signal is not combined
 * with another, so no AbortSignal.any, absent before iOS 17.4). The first to trip aborts the transfer's own signal
 * and calls `onEnd` once, with the error the call rejects with; the caller then stops the request.
 */
function transfer(route: string, clock: ClockPort, idleMs: number, signal: AbortSignal | undefined, onEnd?: (error: RelayHttpError) => void): Transfer {
	const ctl = new AbortController();
	let ended: "aborted" | "stalled" | null = null;
	let timer: TimerHandle | null = null;
	let closed = false;
	const fail = () => new RelayHttpError(route, 0, ended ?? "network_error", null);
	const close = () => {
		closed = true;
		if (timer !== null) clock.clearTimer(timer);
		timer = null;
		signal?.removeEventListener("abort", onAbort);
	};
	const end = (why: "aborted" | "stalled") => {
		if (closed) return;
		ended = why;
		close();
		ctl.abort(fail());
		onEnd?.(fail());
	};
	const onAbort = () => end("aborted");
	const kick = () => {
		if (closed) return;
		if (timer !== null) clock.clearTimer(timer);
		timer = clock.setTimer(idleMs, () => {
			timer = null;
			end("stalled");
		});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	kick();
	return { get ended() { return ended; }, signal: ctl.signal, kick, fail, close };
}

function isAddress(v: unknown): v is BlobAddress {
	return typeof v === "string" && ADDRESS.test(v);
}

function isTime(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function parseListItem(v: unknown): BlobListItem | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v as Record<string, unknown>;
	return isAddress(o.address) && isTime(o.uploadedAt) ? { address: o.address, uploadedAt: o.uploadedAt } : null;
}

function parseDeleteResult(v: unknown, address: BlobAddress): BlobDeleteResult | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v as Record<string, unknown>;
	if (o.address !== address) return null;
	if (o.result === "absent") return { address, result: "absent" };
	if ((o.result === "deleted" || o.result === "newer") && isTime(o.uploadedAt)) return { address, result: o.result, uploadedAt: o.uploadedAt };
	return null;
}

/**
 * A 200 GET body, read chunk by chunk; every chunk restarts the idle window. With a usable Content-Length the
 * bytes go into one buffer of that size: each chunk is copied in as it arrives and dropped, where collecting them
 * would hold every chunk until a join (one more blob-sized copy). A body that ends early or runs past its length
 * is a transport error, as is a length above `max` (the relay never stores more; no attacker-sized allocation).
 * Without one, or with a Content-Encoding (the length is of the encoded bytes; fetch hands over decoded ones): the
 * chunks are collected, their running total held to `max`, and joined once.
 */
async function readBody(res: Response, reader: ReadableStreamDefaultReader<Uint8Array> | null, max: number, t: Transfer, progress: BlobProgress | undefined): Promise<Uint8Array> {
	const declared = res.headers.get("Content-Length");
	const encoding = res.headers.get("Content-Encoding");
	const length = declared !== null && /^\d+$/.test(declared) && (encoding === null || encoding === "identity") ? Number(declared) : null;
	const bad = async (): Promise<never> => {
		await reader?.cancel().catch(() => undefined);
		throw new RelayHttpError("blobs/get", res.status, "malformed_response", null);
	};
	const next = async (): Promise<Uint8Array | null> => {
		if (reader === null) return null;
		if (t.ended === null) {
			try {
				const r = await untilAborted(reader.read(), t.signal);
				// Ending the transfer cancels the reader, which resolves a pending read as done: not the body's end.
				if (t.ended === null) return r.done ? null : r.value;
			} catch {
				// The transfer's reason, else network_error.
			}
		}
		throw t.fail();
	};
	if (length !== null && length > max) return bad();
	const out = length === null ? null : new Uint8Array(length);
	const chunks: Uint8Array[] = [];
	let n = 0;
	for (let chunk = await next(); chunk !== null; chunk = await next()) {
		t.kick();
		progress?.(chunk.length);
		if (chunk.length > (out === null ? max : out.length) - n) return bad();
		if (out === null) chunks.push(chunk);
		else out.set(chunk, n);
		n += chunk.length;
	}
	if (out !== null) {
		if (n !== out.length) throw new RelayHttpError("blobs/get", res.status, "malformed_response", null);
		return out;
	}
	const joined = new Uint8Array(n);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}
	return joined;
}

/** The wire `error` code of a JSON error body. */
function codeOf(body: unknown): string | null {
	return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : null;
}

/**
 * The wire code of a non-200 reply's JSON body, read within the transfer: null when the body is not JSON. A body
 * that stalls or is cut off is the transfer's failure ("stalled", "aborted", network_error), never a missing code: a
 * 404 whose body never arrived is not "absent".
 */
async function errorCode(res: Response, t: Transfer): Promise<string | null> {
	try {
		return codeOf(await untilAborted(res.json(), t.signal));
	} catch (e) {
		if (t.ended === null && e instanceof SyntaxError) return null; // Not JSON.
		throw t.fail();
	}
}

function textErrorCode(text: string): string | null {
	try {
		return codeOf(JSON.parse(text));
	} catch {
		return null; // Not JSON.
	}
}

export function createHttpBlob(opts: HttpBlobOptions): BlobPort {
	const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const Xhr = opts.xhr ?? (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
	const root = `${normalizeBaseUrl(opts.baseUrl)}/vault/${encodeURIComponent(opts.vaultId)}/blobs`;
	const auth = { Authorization: `Bearer ${opts.credential}` };
	const clock = opts.clock ?? createWebClock();
	const idleMs = opts.idleMs ?? BLOB_TRANSFER_IDLE_MS;

	/**
	 * fetch, ended by `init.signal` even when the fetch ignores it (untilAborted); a rejection is the transfer's end
	 * reason when it has one, else "aborted" (signal) or network_error.
	 */
	async function send(route: string, url: string, init: RequestInit, t: Transfer | null): Promise<Response> {
		try {
			return await untilAborted(doFetch(url, init), init.signal ?? undefined);
		} catch {
			throw t !== null ? t.fail() : new RelayHttpError(route, 0, init.signal?.aborted ? "aborted" : "network_error", null);
		}
	}

	async function fail(route: string, res: Response, t: Transfer): Promise<RelayHttpError> {
		return new RelayHttpError(route, res.status, await errorCode(res, t), null);
	}

	/**
	 * A GC route call whose request and reply move at most `bytes`: each attempt, its whole reply included, ends at
	 * relayHttpDeadlineMs(`bytes`) ("timeout") or when `signal` aborts ("aborted": the sweep stopped, or the relay
	 * link was declared dead, blobs/transferLink.ts). 429/503 with a usable Retry-After are retried (bounded); any
	 * other reply is the caller's. The body is the parsed JSON, null when it is not JSON.
	 */
	async function gcCall(route: string, url: string, init: RequestInit, bytes: number, signal: AbortSignal | undefined): Promise<{ readonly status: number; readonly body: unknown }> {
		for (let attempt = 1; ; attempt++) {
			const reply = await bounded(relayHttpDeadlineMs(bytes), signal, clock, async (s) => {
				const res = await send(route, url, { ...init, signal: s }, null);
				let body: unknown = null;
				try {
					body = await untilAborted(res.json(), s);
				} catch (e) {
					if (!(e instanceof SyntaxError)) throw new RelayHttpError(route, res.status, "network_error", null);
				}
				return { status: res.status, body, retryAfter: res.headers.get("Retry-After") };
			}, (why) => new RelayHttpError(route, 0, why, null));
			if (reply.status !== 429 && reply.status !== 503) return reply;
			const wait = parseRetryAfter(reply.retryAfter, clock.now());
			if (wait === null || wait > GC_RETRY_MAX_WAIT_MS || attempt >= GC_RETRY_ATTEMPTS) {
				throw new RelayHttpError(route, reply.status, codeOf(reply.body), wait);
			}
			await sleepOn(clock, wait, signal, route);
		}
	}

	// Without the capabilities: the relay's own cap. A relay that takes less answers 413 (see the header).
	const maxBlobBytes = opts.maxBlobBytes ?? MAX_BLOB_UPLOAD_BYTES;

	/**
	 * One PUT over XMLHttpRequest. The idle window restarts on every upload progress event, the end of the upload,
	 * every response progress event and every readyState change. `progress` sees the upload progress events.
	 */
	function putBody(url: string, body: Blob, signal: AbortSignal | undefined, progress: BlobProgress | undefined): Promise<void> {
		const route = "blobs/put";
		return new Promise((resolve, reject) => {
			if (Xhr === undefined) {
				reject(new RelayHttpError(route, 0, "unsupported", null));
				return;
			}
			if (signal?.aborted) {
				reject(abortError(route));
				return;
			}
			const x = new Xhr();
			let settled = false;
			const settle = (error: Error | null) => {
				if (settled) return;
				settled = true;
				t.close();
				x.onreadystatechange = x.onprogress = x.onload = x.onerror = x.ontimeout = x.onabort = null;
				x.upload.onprogress = x.upload.onload = null;
				if (error === null) resolve();
				else reject(error);
			};
			const t = transfer(route, clock, idleMs, signal, (error) => {
				settle(error);
				x.abort();
			});
			const kick = () => t.kick();
			const lost = () => settle(new RelayHttpError(route, 0, "network_error", null));
			try {
				x.open("PUT", url);
				x.setRequestHeader("Authorization", auth.Authorization);
				x.setRequestHeader("Content-Type", "application/octet-stream");
				x.upload.onload = x.onprogress = x.onreadystatechange = kick;
				x.upload.onprogress = progress === undefined ? kick : (ev: ProgressEvent) => {
					kick();
					progress(ev.loaded);
				};
				x.onerror = x.ontimeout = x.onabort = lost;
				x.onload = () => {
					if (x.status === 413) settle(new BlobTooLargeError(body.size));
					else if (x.status === 204 || x.status === 200) settle(null);
					else settle(new RelayHttpError(route, x.status, textErrorCode(x.responseText), null));
				};
				x.send(body);
			} catch {
				lost();
			}
		});
	}

	return {
		maxBlobBytes,

		async has(addresses, signal) {
			const route = "blobs/exists";
			const present = new Set<BlobAddress>();
			for (let i = 0; i < addresses.length; i += BLOB_EXISTS_BATCH) {
				if (signal?.aborted) throw abortError(route);
				const batch = addresses.slice(i, i + BLOB_EXISTS_BATCH);
				const t = transfer(route, clock, idleMs, signal);
				let body: unknown;
				try {
					const res = await send(route, `${root}/exists`, {
						method: "POST",
						headers: { ...auth, "Content-Type": "application/json" },
						body: JSON.stringify({ hashes: batch }),
						signal: t.signal,
					}, t);
					t.kick();
					if (res.status !== 200) throw await fail(route, res, t);
					try {
						body = await untilAborted(res.json(), t.signal);
					} catch (e) {
						throw t.ended !== null ? t.fail() : new RelayHttpError(route, 200, e instanceof SyntaxError ? "malformed_response" : "network_error", null);
					}
				} finally {
					t.close();
				}
				const list = typeof body === "object" && body !== null && "present" in body ? body.present : null;
				if (!Array.isArray(list)) throw new RelayHttpError(route, 200, "malformed_response", null);
				const wanted = new Set<string>(batch);
				for (const item of list) if (typeof item === "string" && wanted.has(item)) present.add(item as BlobAddress);
			}
			return present;
		},

		// One Blob joins the parts: the transport's one copy. XMLHttpRequest.send reads a Blob body as a stream, where
		// a BufferSource body would be copied again ([Fetch] "extract a body", which send() runs); it sends a Blob's
		// size as its Content-Length, which the relay requires (411 length_required). Not async: only the Blob
		// outlives this call, so the parts (the sealed bytes) are garbage for the whole upload, not held by a
		// suspended frame. Parts are never SharedArrayBuffer views.
		put(address, parts, signal, progress) {
			return putBody(`${root}/${encodeURIComponent(address)}`, new Blob(parts as Uint8Array<ArrayBuffer>[]), signal, progress);
		},

		async get(address, signal, progress) {
			const route = "blobs/get";
			if (signal?.aborted) throw abortError(route);
			let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
			// Aborting the fetch errors its body; the reader is cancelled too, which releases a body that ignores the
			// abort (readBody stops waiting on it either way: untilAborted).
			const t = transfer(route, clock, idleMs, signal, () => {
				reader?.cancel().catch(() => undefined);
			});
			try {
				const res = await send(route, `${root}/${encodeURIComponent(address)}`, { method: "GET", headers: auth, signal: t.signal }, t);
				t.kick();
				if (res.status === 200) {
					reader = res.body?.getReader() ?? null;
					return await readBody(res, reader, maxBlobBytes, t, progress);
				}
				if (res.status === 404) {
					const code = await errorCode(res, t);
					// "not found" = no such blob; anything else (unknown_vault) is a real error.
					if (code === "not found" || code === null) return null;
					throw new RelayHttpError(route, 404, code, null);
				}
				throw await fail(route, res, t);
			} finally {
				t.close();
			}
		},

		async list(cursor, signal) {
			const url = cursor === null ? root : `${root}?cursor=${encodeURIComponent(cursor)}`;
			const { status, body } = await gcCall("blobs/list", url, { method: "GET", headers: auth }, BLOB_LIST_REPLY_BYTES, signal);
			if (status !== 200) throw new RelayHttpError("blobs/list", status, codeOf(body), null);
			const malformed = () => new RelayHttpError("blobs/list", 200, "malformed_response", null);
			if (typeof body !== "object" || body === null) throw malformed();
			const { items: rawItems, next } = body as Record<string, unknown>;
			if (!Array.isArray(rawItems) || !(next === null || isAddress(next))) throw malformed();
			const items: BlobListItem[] = [];
			for (const raw of rawItems) {
				const item = parseListItem(raw);
				// Address order after the cursor: anything else would let the walk skip or loop.
				const prev = items.length > 0 ? items[items.length - 1]!.address : cursor;
				if (item === null || (prev !== null && item.address <= prev)) throw malformed();
				items.push(item);
			}
			const last = items.length > 0 ? items[items.length - 1]!.address : cursor;
			if (next !== null && last !== null && next < last) throw malformed();
			if (next !== null && next === cursor) throw malformed();
			return { items, next };
		},

		async deleteIfUploadedBefore(addresses, cutoffMs, signal) {
			if (addresses.length === 0 || addresses.length > BLOB_DELETE_BATCH || new Set(addresses).size !== addresses.length) {
				throw new RelayHttpError("blobs/delete", 0, "invalid_addresses", null);
			}
			if (!isTime(cutoffMs)) throw new RelayHttpError("blobs/delete", 0, "invalid_if_uploaded_before", null);
			const { status, body } = await gcCall("blobs/delete", `${root}/delete`, {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({ ifUploadedBefore: cutoffMs, addresses }),
			}, BLOB_DELETE_CALL_BYTES, signal);
			if (status !== 200) throw new RelayHttpError("blobs/delete", status, codeOf(body), null);
			const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>).results : null;
			if (!Array.isArray(raw) || raw.length !== addresses.length) throw new RelayHttpError("blobs/delete", 200, "malformed_response", null);
			return addresses.map((address, i) => {
				const r = parseDeleteResult(raw[i], address);
				if (r === null) throw new RelayHttpError("blobs/delete", 200, "malformed_response", null);
				return r;
			});
		},
	};
}

/**
 * GET /api/capabilities; a BlobPort when attachments are available, else null.
 * Throws RelayHttpError when capabilities cannot be fetched: code "timeout" when
 * no whole reply arrived within `timeoutMs` (on `opts.clock`). Engine init awaits
 * this probe, so it is bounded: a request nobody answers fails it, never holds it.
 */
export async function probeHttpBlob(opts: HttpBlobOptions, timeoutMs = CAPABILITIES_TIMEOUT_MS): Promise<BlobPort | null> {
	const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const url = `${normalizeBaseUrl(opts.baseUrl)}/api/capabilities`;
	const body = await bounded(timeoutMs, undefined, opts.clock ?? createWebClock(), (s) => capabilities(doFetch, url, s), (why) => new RelayHttpError("capabilities", 0, why, null));
	if (typeof body !== "object" || body === null) throw new RelayHttpError("capabilities", 200, "malformed_response", null);
	if (!("attachments" in body) || body.attachments !== true) return null;
	const max = "maxBlobUploadBytes" in body && typeof body.maxBlobUploadBytes === "number" && body.maxBlobUploadBytes > 0
		? body.maxBlobUploadBytes : undefined;
	return createHttpBlob({ ...opts, maxBlobBytes: opts.maxBlobBytes ?? max });
}

/**
 * Engine start (makePorts): the probed store, or, when capabilities cannot be had (offline start, or a relay that does
 * not answer within CAPABILITIES_TIMEOUT_MS), the store assumed: the blob queue retries, so refs never depend on
 * whether the device happened to be online at startup. Never rejects.
 */
export async function startupBlob(opts: HttpBlobOptions, log?: (line: string) => void): Promise<BlobPort | null> {
	try {
		return await probeHttpBlob(opts);
	} catch (e) {
		log?.(`capabilities probe failed (${e instanceof RelayHttpError ? e.message : "malformed reply"}); assuming the blob store`);
		return createHttpBlob(opts);
	}
}

async function capabilities(doFetch: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
	let res: Response;
	try {
		res = await doFetch(url, { method: "GET", signal });
	} catch {
		throw new RelayHttpError("capabilities", 0, "network_error", null);
	}
	// The whole call, this body included, is raced against probeHttpBlob's deadline (bounded).
	if (res.status !== 200) throw new RelayHttpError("capabilities", res.status, codeOf(await res.json().catch(() => null)), null);
	return await res.json();
}
