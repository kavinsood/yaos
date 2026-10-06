/**
 * BlobPort over the relay's content-addressed blob routes (relay-wire.md §11.3):
 *   PUT  /vault/:id/blobs/<addr>        204 (400 "hash mismatch", 413 over maxBlobUploadBytes)
 *   GET  /vault/:id/blobs/<addr>        200 bytes | 404 {"error":"not found"}
 *   POST /vault/:id/blobs/exists        {"hashes":[...]} -> {"present":[...]}; the relay looks at 50 per call
 *
 * Without an R2 bucket every route answers 503 attachments_unavailable (local
 * dev, the client-e2e deploy, any Free-plan server). That surfaces here as a
 * thrown RelayHttpError with code "attachments_unavailable"; callers should
 * use probeHttpBlob(), which returns null when capabilities.attachments is
 * false, and fall back to log-carried blobs (DESIGN §j.1).
 *
 * Suite 0 only: the relay checks sha256(body) == address, so the address must
 * be the plaintext SHA-256 (noopCrypto.blobAddress). An E2EE address/ciphertext
 * would be refused with 400 hash mismatch until the relay grows opaque blobs.
 */

import type { BlobPort } from "../../ports/blob";
import type { BlobAddress } from "../../ports/crypto";
import { normalizeBaseUrl, RelayHttpError } from "./relayHttp";

export const BLOB_EXISTS_BATCH = 50;
export const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;

export interface HttpBlobOptions {
	readonly baseUrl: string;
	readonly vaultId: string;
	/** Device token. Secret: Authorization header only. */
	readonly credential: string;
	readonly fetch?: typeof fetch;
	readonly maxBlobBytes?: number;
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
			throw new RelayHttpError(route, 0, "network_error", null);
		}
	}

	async function fail(route: string, res: Response): Promise<RelayHttpError> {
		return new RelayHttpError(route, res.status, await errorCode(res), null);
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

		async put(address, bytes) {
			const res = await send("blobs/put", `${root}/${encodeURIComponent(address)}`, {
				method: "PUT",
				headers: { ...auth, "Content-Type": "application/octet-stream" },
				body: bytes.slice(),
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
