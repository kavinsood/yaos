import { MAX_BLOB_UPLOAD_BYTES } from "../contracts";
import { sha256Hex } from "../hex";
import { BoundedBodyError, readBoundedBytes } from "../readBoundedBytes";
import { blobKey } from "../vaultObjectStore";
import { mapWithConcurrency } from "../shared/concurrency";
import type { Env, JsonResponse } from "./types";
import { readVault } from "./vault";

const EXISTS_BATCH_LIMIT = 50;
const OBJECT_HEAD_CONCURRENCY = 4;

function isValidHash(hash: string): boolean {
	return /^[0-9a-f]{64}$/.test(hash);
}

export async function handleBlobRoute(
	env: Env,
	vaultId: string,
	req: Request,
	rest: string[],
	json: JsonResponse,
): Promise<Response> {
	let vault;
	try {
		vault = await readVault(env, vaultId);
	} catch {
		return json({ error: "vault_authority_unavailable" }, 503);
	}
	if (!vault || vault.state !== "active") return json({ error: vault ? `vault_${vault.state}` : "unknown_vault" }, vault ? 409 : 404);
	const vaultGeneration = vault.vaultGeneration;
	if (req.method === "POST" && rest[0] === "exists") {
		return await handleBlobExists(env, vaultId, vaultGeneration, req, json);
	}

	const hash = rest[0];
	if (!hash) {
		return json({ error: "not found" }, 404);
	}

	if (req.method === "PUT" && rest.length === 1) {
		return await handleBlobUpload(env, vaultId, vaultGeneration, hash, req, json);
	}

	if (req.method === "GET" && rest.length === 1) {
		return await handleBlobDownload(env, vaultId, vaultGeneration, hash, json);
	}

	return json({ error: "not found" }, 404);
}

async function handleBlobExists(
	env: Env,
	vaultId: string,
	vaultGeneration: string,
	req: Request,
	json: JsonResponse,
): Promise<Response> {
	const bucket = env.YAOS_BUCKET;
	if (!bucket) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	let body: { hashes?: string[] };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	if (!Array.isArray(body.hashes)) {
		return json({ error: "missing hashes array" }, 400);
	}

	const hashes = body.hashes
		.slice(0, EXISTS_BATCH_LIMIT)
		.filter((hash): hash is string => typeof hash === "string" && isValidHash(hash));

	const present = await mapWithConcurrency(
		hashes,
		OBJECT_HEAD_CONCURRENCY,
		async (hash) => {
			const object = await bucket.head(blobKey(vaultId, vaultGeneration, hash));
			return object ? hash : null;
		},
	);

	return json({
		present: present.filter((hash): hash is string => hash !== null),
	});
}

async function handleBlobUpload(
	env: Env,
	vaultId: string,
	vaultGeneration: string,
	hash: string,
	req: Request,
	json: JsonResponse,
): Promise<Response> {
	const bucket = env.YAOS_BUCKET;
	if (!bucket) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	if (!isValidHash(hash)) {
		return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
	}

	let body: Uint8Array;
	try {
		body = await readBoundedBytes(req, MAX_BLOB_UPLOAD_BYTES);
	} catch (error) {
		if (error instanceof BoundedBodyError) {
			if (error.kind === "invalid_content_length") {
				return json({ error: "invalid Content-Length" }, 400);
			}
			if (error.kind === "body_too_large") {
				return json({
					error: `contentLength exceeds max upload size (${MAX_BLOB_UPLOAD_BYTES} bytes)`,
				}, 413);
			}
			if (error.kind === "missing_body") {
				return json({ error: "missing request body" }, 400);
			}
			return json({ error: "failed to read request body" }, 400);
		}
		throw error;
	}
	const actualHash = await sha256Hex(body);
	if (actualHash !== hash) {
		return json({ error: "hash mismatch" }, 400);
	}

	await bucket.put(
		blobKey(vaultId, vaultGeneration, hash),
		body,
		{ contentType: req.headers.get("Content-Type") ?? "application/octet-stream" },
	);

	return new Response(null, { status: 204 });
}

async function handleBlobDownload(
	env: Env,
	vaultId: string,
	vaultGeneration: string,
	hash: string,
	json: JsonResponse,
): Promise<Response> {
	if (!env.YAOS_BUCKET) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	if (!isValidHash(hash)) {
		return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
	}

	const object = await env.YAOS_BUCKET.get(blobKey(vaultId, vaultGeneration, hash));
	if (!object) {
		return json({ error: "not found" }, 404);
	}

	const headers = new Headers({
		"Cache-Control": "no-store",
	});
	if (object.contentType) {
		headers.set("Content-Type", object.contentType);
	} else {
		headers.set("Content-Type", "application/octet-stream");
	}

	return new Response(object.bytes, { headers });
}
