/**
 * BlobPort over the relay's blob routes (relay-wire.md §11.3):
 *   PUT  /vault/:id/blobs/<addr>        204 (400 invalid_address, 413 over maxBlobUploadBytes)
 *   GET  /vault/:id/blobs/<addr>        200 bytes | 404 {"error":"not found"}
 *   POST /vault/:id/blobs/exists        {"hashes":[<addr>...]} -> {"present":[...]}; more than 50 is 400 too_many_addresses
 *   GET  /vault/:id/blobs?cursor=<addr> {"items":[{address,uploadedAt}],"next"} (§11.3.1; 503 list_incomplete)
 *   POST /vault/:id/blobs/delete        {"ifUploadedBefore":ms,"addresses":[1..100]} -> {"results":[...]} (§11.3.1)
 *
 * The two GC routes share a per-vault request limit (429 too_many_attempts + Retry-After, server/src/vault/host.ts:418-424)
 * and list may answer 503 list_incomplete + Retry-After (server/src/router.ts:651-655). Both are retried here after
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
 * and nothing else (no hash check, PUT overwrites; server/src/router.ts:549-552),
 * so it carries CryptoPort.blobAddress as is: the plaintext SHA-256 under
 * suite 0, the keyed address over sealed bytes under suite 1 (e2ee-design
 * §10.1). The exists body's field is named `hashes` on the wire; it carries
 * addresses. Never a plaintext hash under suite 1 (blobs/blobStore.ts).
 */

import { BLOB_DELETE_BATCH, type BlobDeleteResult, type BlobListItem, type BlobPort } from "../../ports/blob";
import type { ClockPort } from "../../ports/clock";
import type { BlobAddress } from "../../ports/crypto";
import { normalizeBaseUrl, parseRetryAfter, RelayHttpError } from "./relayHttp";
import { createWebClock } from "./webClock";

export const BLOB_EXISTS_BATCH = 50;
export const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;
/** Calls per GC request, the first included, while the relay answers 429/503 with Retry-After. */
export const GC_RETRY_ATTEMPTS = 5;
/** Longest Retry-After honoured; a longer one fails the call (the GC limit's window is 60 s). */
export const GC_RETRY_MAX_WAIT_MS = 65_000;
const ADDRESS = /^[0-9a-f]{64}$/;

export interface HttpBlobOptions {
	readonly baseUrl: string;
	readonly vaultId: string;
	/** Device token. Secret: Authorization header only. */
	readonly credential: string;
	readonly fetch?: typeof fetch;
	readonly maxBlobBytes?: number;
	/** Retry-After waits and the HTTP-date form's "now"; default a web clock. */
	readonly clock?: ClockPort;
}

function abortError(): Error {
	return new RelayHttpError("blobs/gc", 0, "aborted", null);
}

/** Waits `ms` on `clock`; rejects as soon as `signal` aborts. */
function sleepOn(clock: ClockPort, ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clock.clearTimer(timer);
			reject(abortError());
		};
		const timer = clock.setTimer(ms, () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		});
		signal?.addEventListener("abort", onAbort, { once: true });
	});
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

async function errorCode(res: Response): Promise<string | null> {
	try {
		const body: unknown = await res.json();
		if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
	} catch {
		// Not JSON.
	}
	return null;
}

export function createHttpBlob(opts: HttpBlobOptions): BlobPort {
	const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const root = `${normalizeBaseUrl(opts.baseUrl)}/vault/${encodeURIComponent(opts.vaultId)}/blobs`;
	const auth = { Authorization: `Bearer ${opts.credential}` };

	async function send(route: string, url: string, init: RequestInit): Promise<Response> {
		try {
			return await doFetch(url, init);
		} catch {
			if (init.signal?.aborted) throw abortError();
			throw new RelayHttpError(route, 0, "network_error", null);
		}
	}

	async function fail(route: string, res: Response): Promise<RelayHttpError> {
		return new RelayHttpError(route, res.status, await errorCode(res), null);
	}

	const clock = opts.clock ?? createWebClock();

	/** A GC route call; 429/503 with a usable Retry-After are retried (bounded), anything else is the caller's. */
	async function gcCall(route: string, url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
		for (let attempt = 1; ; attempt++) {
			if (signal?.aborted) throw abortError();
			const res = await send(route, url, signal ? { ...init, signal } : init);
			if (res.status !== 429 && res.status !== 503) return res;
			const wait = parseRetryAfter(res.headers.get("Retry-After"), clock.now());
			if (wait === null || wait > GC_RETRY_MAX_WAIT_MS || attempt >= GC_RETRY_ATTEMPTS) {
				throw new RelayHttpError(route, res.status, await errorCode(res), wait);
			}
			await res.body?.cancel().catch(() => undefined);
			await sleepOn(clock, wait, signal);
		}
	}

	return {
		maxBlobBytes: opts.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES,

		async has(addresses) {
			const present = new Set<BlobAddress>();
			for (let i = 0; i < addresses.length; i += BLOB_EXISTS_BATCH) {
				const batch = addresses.slice(i, i + BLOB_EXISTS_BATCH);
				const res = await send("blobs/exists", `${root}/exists`, {
					method: "POST",
					headers: { ...auth, "Content-Type": "application/json" },
					body: JSON.stringify({ hashes: batch }),
				});
				if (res.status !== 200) throw await fail("blobs/exists", res);
				const body: unknown = await res.json();
				const list = typeof body === "object" && body !== null && "present" in body ? body.present : null;
				if (!Array.isArray(list)) throw new RelayHttpError("blobs/exists", res.status, "malformed_response", null);
				const wanted = new Set<string>(batch);
				for (const item of list) if (typeof item === "string" && wanted.has(item)) present.add(item as BlobAddress);
			}
			return present;
		},

		async put(address, parts) {
			const res = await send("blobs/put", `${root}/${encodeURIComponent(address)}`, {
				method: "PUT",
				headers: { ...auth, "Content-Type": "application/octet-stream" },
				// One Blob joins the parts: the transport's one copy. fetch reads a Blob body as a stream, where a
				// BufferSource body would be copied again ([Fetch] "extract a body"). Parts are never SharedArrayBuffer views.
				body: new Blob(parts as Uint8Array<ArrayBuffer>[]),
			});
			if (res.status !== 204 && res.status !== 200) throw await fail("blobs/put", res);
		},

		async get(address) {
			const res = await send("blobs/get", `${root}/${encodeURIComponent(address)}`, { method: "GET", headers: auth });
			if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
			if (res.status === 404) {
				const code = await errorCode(res);
				// "not found" = no such blob; anything else (unknown_vault) is a real error.
				if (code === "not found" || code === null) return null;
				throw new RelayHttpError("blobs/get", 404, code, null);
			}
			throw await fail("blobs/get", res);
		},

		async list(cursor, signal) {
			const url = cursor === null ? root : `${root}?cursor=${encodeURIComponent(cursor)}`;
			const res = await gcCall("blobs/list", url, { method: "GET", headers: auth }, signal);
			if (res.status !== 200) throw await fail("blobs/list", res);
			const body: unknown = await res.json().catch(() => null);
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
			const res = await gcCall("blobs/delete", `${root}/delete`, {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: JSON.stringify({ ifUploadedBefore: cutoffMs, addresses }),
			}, signal);
			if (res.status !== 200) throw await fail("blobs/delete", res);
			const body: unknown = await res.json().catch(() => null);
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
 * Throws RelayHttpError when capabilities cannot be fetched.
 */
export async function probeHttpBlob(opts: HttpBlobOptions): Promise<BlobPort | null> {
	const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
	let res: Response;
	try {
		res = await doFetch(`${normalizeBaseUrl(opts.baseUrl)}/api/capabilities`, { method: "GET" });
	} catch {
		throw new RelayHttpError("capabilities", 0, "network_error", null);
	}
	if (res.status !== 200) throw new RelayHttpError("capabilities", res.status, await errorCode(res), null);
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null) throw new RelayHttpError("capabilities", 200, "malformed_response", null);
	if (!("attachments" in body) || body.attachments !== true) return null;
	const max = "maxBlobUploadBytes" in body && typeof body.maxBlobUploadBytes === "number" && body.maxBlobUploadBytes > 0
		? body.maxBlobUploadBytes : undefined;
	return createHttpBlob({ ...opts, maxBlobBytes: opts.maxBlobBytes ?? max });
}
