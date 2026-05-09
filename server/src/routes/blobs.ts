import { mapWithConcurrency } from "../concurrency";
import { blobKey } from "../snapshot";
import type { Env, JsonResponse } from "./types";

const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;
const EXISTS_BATCH_LIMIT = 50;
const R2_HEAD_CONCURRENCY = 4;

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
	if (req.method === "POST" && rest[0] === "exists") {
		return await handleBlobExists(env, vaultId, req, json);
	}

	const hash = rest[0];
	if (!hash) {
		return json({ error: "not found" }, 404);
	}

	if (req.method === "PUT" && rest.length === 1) {
		return await handleBlobUpload(env, vaultId, hash, req, json);
	}

	if (req.method === "GET" && rest.length === 1) {
		return await handleBlobDownload(env, vaultId, hash, json);
	}

	return json({ error: "not found" }, 404);
}

async function handleBlobExists(
	env: Env,
	vaultId: string,
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
		R2_HEAD_CONCURRENCY,
		async (hash) => {
			const object = await bucket.head(blobKey(vaultId, hash));
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
	hash: string,
	req: Request,
	json: JsonResponse,
): Promise<Response> {
	if (!env.YAOS_BUCKET) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	if (!isValidHash(hash)) {
		return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
	}

	const body = await req.arrayBuffer();
	if (!body.byteLength) {
		return json({ error: "missing request body" }, 400);
	}
	if (body.byteLength > MAX_BLOB_UPLOAD_BYTES) {
		return json({
			error: `contentLength exceeds max upload size (${MAX_BLOB_UPLOAD_BYTES} bytes)`,
		}, 413);
	}

	await env.YAOS_BUCKET.put(
		blobKey(vaultId, hash),
		body,
		{
			httpMetadata: {
				contentType: req.headers.get("Content-Type") ?? "application/octet-stream",
			},
		},
	);

	return new Response(null, { status: 204 });
}

async function handleBlobDownload(
	env: Env,
	vaultId: string,
	hash: string,
	json: JsonResponse,
): Promise<Response> {
	if (!env.YAOS_BUCKET) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	if (!isValidHash(hash)) {
		return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
	}

	const object = await env.YAOS_BUCKET.get(blobKey(vaultId, hash));
	if (!object) {
		return json({ error: "not found" }, 404);
	}

	const headers = new Headers({
		"Cache-Control": "no-store",
	});
	if (object.httpMetadata?.contentType) {
		headers.set("Content-Type", object.httpMetadata.contentType);
	} else {
		headers.set("Content-Type", "application/octet-stream");
	}

	return new Response(object.body, { headers });
}
