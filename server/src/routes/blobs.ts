import { MAX_BLOB_UPLOAD_BYTES } from "../contracts";
import { ObjectStreamValidationError } from "../verifiedObjectStream";
import { blobKey } from "../vaultObjectStore";
import { mapWithConcurrency } from "../shared/concurrency";
import type { Env, JsonResponse } from "./types";
import { readVault } from "./vault";
import { authorizeVaultActor, getHttpAuthToken } from "./auth";
import { authorizeVaultAction } from "../collaboration";
import { handleBlobRepairReport } from "../blobRepair";
import { actorHeaders } from "../vaultAuthority";
import type { VaultActorContext } from "../collaboration";

const EXISTS_BATCH_LIMIT = 50;
const OBJECT_HEAD_CONCURRENCY = 4;
class BlobSuspectAuthorityError extends Error {}

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
	const authorized = await authorizeVaultActor(env, getHttpAuthToken(req), vaultId);
	if (!authorized) return json({ error: "unauthorized" }, 401);
	const actor = authorized.actor;
	const required = req.method === "GET" || (req.method === "POST" && rest[0] === "exists")
		? "vault.attachments.read" as const
		: "vault.attachments.write" as const;
	const decision = authorizeVaultAction(actor, required);
	if (!decision.allowed) return json({ error: decision.reason }, 403);
	let vault;
	try {
		vault = await readVault(env, vaultId);
	} catch {
		return json({ error: "vault_authority_unavailable" }, 503);
	}
	if (!vault || vault.state !== "active") return json({ error: vault ? `vault_${vault.state}` : "unknown_vault" }, vault ? 409 : 404);
	const vaultGeneration = vault.vaultGeneration;
	if (actor.vaultGeneration !== vaultGeneration) return json({ error: "authority_superseded" }, 409);
	if (req.method === "POST" && rest[0] === "exists") {
		return await handleBlobExists(env, vaultId, vaultGeneration, actor, req, json);
	}

	const hash = rest[0];
	if (!hash) {
		return json({ error: "not found" }, 404);
	}

	if (req.method === "PUT" && rest.length === 1) {
		return await handleBlobUpload(env, vaultId, vaultGeneration, hash, actor, req, json);
	}

	if (req.method === "GET" && rest.length === 1) {
		return await handleBlobDownload(env, vaultId, vaultGeneration, hash, json);
	}

	if (req.method === "POST" && rest.length === 2 && rest[1] === "repair") {
		return await handleBlobRepairReport(env, vaultId, vaultGeneration, hash, actor, json);
	}

	return json({ error: "not found" }, 404);
}

async function blobSuspects(env: Env, vaultId: string, vaultGeneration: string, actor: VaultActorContext, keys: string[]): Promise<string[]> {
	const headers = actorHeaders(actor);
	headers.set("x-yaos-vault-id", vaultId);
	headers.set("x-yaos-vault-generation", vaultGeneration);
	try {
		const response = await env.YAOS_SYNC.call(vaultId, new Request("https://internal/blobs/suspects", {
			method: "POST", headers, body: JSON.stringify({ keys }),
		}));
		if (!response.ok) throw new Error(`blob suspect authority unavailable: ${response.status}`);
		return (await response.json() as { suspect: string[] }).suspect;
	} catch (error) { throw new BlobSuspectAuthorityError("blob suspect authority unavailable", { cause: error }); }
}

async function clearBlobSuspect(env: Env, vaultId: string, vaultGeneration: string, actor: VaultActorContext, key: string): Promise<void> {
	const headers = actorHeaders(actor);
	headers.set("x-yaos-vault-id", vaultId);
	headers.set("x-yaos-vault-generation", vaultGeneration);
	try {
		const response = await env.YAOS_SYNC.call(vaultId, new Request("https://internal/blobs/clear-suspect", {
			method: "POST", headers, body: JSON.stringify({ key }),
		}));
		if (!response.ok) throw new Error(`blob suspect authority unavailable: ${response.status}`);
	} catch (error) { throw new BlobSuspectAuthorityError("blob suspect authority unavailable", { cause: error }); }
}

async function handleBlobExists(
	env: Env,
	vaultId: string,
	vaultGeneration: string,
	actor: VaultActorContext,
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
			const key = blobKey(vaultId, vaultGeneration, hash);
			const object = await bucket.head(key);
			return object?.sha256 === hash ? hash : null;
		},
	);

	const candidates = present.filter((hash): hash is string => hash !== null);
	if (!candidates.length) return json({ present: [] });
	let suspect: string[];
	try { suspect = await blobSuspects(env, vaultId, vaultGeneration, actor,
		candidates.map((hash) => blobKey(vaultId, vaultGeneration, hash))); }
	catch { return json({ error: "blob_authority_unavailable" }, 503); }
	const suspectKeys = new Set(suspect);
	return json({ present: candidates.filter((hash) => !suspectKeys.has(blobKey(vaultId, vaultGeneration, hash))) });
}

async function handleBlobUpload(
	env: Env,
	vaultId: string,
	vaultGeneration: string,
	hash: string,
	actor: VaultActorContext,
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

	const declared = req.headers.get("Content-Length");
	if (declared === null || !/^\d+$/.test(declared.trim()) || !Number.isSafeInteger(Number(declared))) {
		return json({ error: "invalid Content-Length" }, 400);
	}
	const length = Number(declared);
	if (length > MAX_BLOB_UPLOAD_BYTES) {
		return json({ error: `contentLength exceeds max upload size (${MAX_BLOB_UPLOAD_BYTES} bytes)` }, 413);
	}
	if (length === 0) return json({ error: "missing request body" }, 400);
	const body = req.body as ReadableStream<Uint8Array> | null;
	if (!body) return json({ error: "missing request body" }, 400);
	if (!bucket.createOnlyVerifiedStream) return json({ error: "attachments_unavailable" }, 503);
	const key = blobKey(vaultId, vaultGeneration, hash);
	try {
		const existing = await bucket.head(key);
		const suspect = existing
			? (await blobSuspects(env, vaultId, vaultGeneration, actor, [key])).includes(key)
			: false;
		const result = await bucket.createOnlyVerifiedStream(key, body, {
			length,
			sha256: hash,
			replaceEtag: existing && (existing.sha256 !== hash || suspect) ? existing.etag : undefined,
			contentType: req.headers.get("Content-Type") ?? "application/octet-stream",
		});
		if (result === "exists") {
			const winner = await bucket.head(key);
			if (winner?.sha256 !== hash || (await blobSuspects(env, vaultId, vaultGeneration, actor, [key])).includes(key)) {
				return json({ error: "blob_replacement_conflict" }, 503);
			}
		}
		if (result === "created") await clearBlobSuspect(env, vaultId, vaultGeneration, actor, key);
	} catch (error) {
		if (error instanceof ObjectStreamValidationError) {
			if (error.kind === "hash_mismatch") {
				console.warn({
					event: "attachment.integrity.failed",
					operation: "blob.upload",
					deviceId: actor.deviceId,
					vaultId,
					vaultGeneration,
					hash,
				});
			}
			const messages = {
				hash_mismatch: "hash mismatch",
				length_mismatch: "Content-Length mismatch",
				missing_body: "missing request body",
				body_read_failed: "failed to read request body",
			};
			return json({ error: messages[error.kind] }, 400);
		}
		if (error instanceof BlobSuspectAuthorityError) return json({ error: "blob_authority_unavailable" }, 503);
		throw error;
	}

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

	const bucket = env.YAOS_BUCKET;
	const key = blobKey(vaultId, vaultGeneration, hash);
	const object = bucket.getStream ? await bucket.getStream(key) : await bucket.get(key);
	if (!object) {
		return json({ error: "not found" }, 404);
	}

	const headers = new Headers({
		"Cache-Control": "no-store",
		"ETag": `"${hash}"`,
		"Content-Length": String(object.size),
		"Last-Modified": new Date(object.uploadedAt).toUTCString(),
	});
	if (object.contentType) {
		headers.set("Content-Type", object.contentType);
	} else {
		headers.set("Content-Type", "application/octet-stream");
	}

	return new Response("body" in object ? object.body : object.bytes, { headers });
}
