import { DurableObject } from "cloudflare:workers";
import { initBlobStoreSchema } from "./blobStoreSql";

export class VaultBlobStore extends DurableObject {
	private schemaReady = false;

	private ensureSchema(): void {
		if (this.schemaReady) return;
		initBlobStoreSchema(this.ctx.storage.sql);
		this.schemaReady = true;
	}

	async fetch(request: Request): Promise<Response> {
		this.ensureSchema();
		return new Response(JSON.stringify({ error: "not implemented" }), { status: 501 });
	}
}
