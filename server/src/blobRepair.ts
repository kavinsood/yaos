import type { VaultActorContext } from "./collaboration";
import type { Env, JsonResponse } from "./routes/types";
import { actorHeaders } from "./vaultAuthority";
import { blobKey } from "./vaultObjectStore";

export async function handleBlobRepairReport(
	env: Env,
	vaultId: string,
	vaultGeneration: string,
	hash: string,
	actor: VaultActorContext,
	json: JsonResponse,
): Promise<Response> {
	if (!/^[a-f0-9]{64}$/.test(hash)) return json({ error: "invalid hash" }, 400);
	const key = blobKey(vaultId, vaultGeneration, hash);
	let object;
	try { object = await env.YAOS_BUCKET?.head(key); }
	catch { return json({ error: "attachments_unavailable" }, 503); }
	if (!env.YAOS_BUCKET) return json({ error: "attachments_unavailable" }, 503);
	if (!object) return json({ status: "missing" });
	const headers = actorHeaders(actor);
	headers.set("x-yaos-vault-id", vaultId);
	headers.set("x-yaos-vault-generation", vaultGeneration);
	try {
		return await env.YAOS_SYNC.call(vaultId, new Request(`https://internal/blobs/${hash}/repair`, {
			method: "POST", headers,
		}));
	} catch {
		return json({ error: "blob_repair_authority_unavailable" }, 503);
	}
}
