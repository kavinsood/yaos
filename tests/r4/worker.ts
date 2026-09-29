import { CloudflareObjectStore } from "../../server/src/cloudflarePorts";
import { handleBlobRoute } from "../../server/src/routes/blobs";
import { blobKey } from "../../server/src/vaultObjectStore";
import { routeEnv, json, VAULT_ID, GENERATION } from "./routeEnv";

export default {
	async fetch(request: Request, env: { BLOBS: R2Bucket }): Promise<Response> {
		const url = new URL(request.url);
		const hash = url.pathname.split("/").at(-1)!;
		const key = blobKey(VAULT_ID, GENERATION, hash);
		if (url.pathname.startsWith("/metadata/")) {
			const object = await env.BLOBS.head(key);
			return json(object ? { size: object.size, etag: object.etag, uploaded: object.uploaded, contentType: object.httpMetadata?.contentType } : null);
		}
		if (url.pathname.startsWith("/r2-checksum/")) {
			try {
				await env.BLOBS.put(key, request.body, { sha256: hash, onlyIf: { etagDoesNotMatch: "*" } });
				return json({ error: "checksum was accepted" }, 500);
			} catch (error) {
				return json({ error: String(error), exists: await env.BLOBS.head(key) !== null }, 400);
			}
		}
		let bytesRead = 0;
		let puts = 0;
		let created = 0;
		let produced = 0;
		let maxAhead = 0;
		const mode = url.pathname.startsWith("/bounded/") ? "bounded" : request.headers.get("X-R4-Mode");
		const headers = new Headers(request.headers);
		const declared = request.headers.get("X-R4-Length");
		if (declared === "missing") headers.delete("Content-Length");
		else if (declared !== null) headers.set("Content-Length", declared);
		const generated = mode === "bounded" ? new ReadableStream<Uint8Array>({ pull(controller) {
			if (produced === 10 * 1024 * 1024) return controller.close();
			produced += 64 * 1024;
			maxAhead = Math.max(maxAhead, produced - bytesRead);
			if (maxAhead > 4 * 64 * 1024) throw new Error("unbounded producer buffering");
			controller.enqueue(new Uint8Array(64 * 1024).fill(37));
		} }) : null;
		if (generated) headers.set("Content-Length", String(10 * 1024 * 1024));
		const routedRequest = { method: request.method, headers, body: generated ?? request.body } as Request;
		const bucket = mode ? {
			head: async () => null,
			put: async (_key: string, body: ReadableStream<Uint8Array>, options: R2PutOptions) => {
				puts++;
				if (options.sha256 !== hash || options.onlyIf instanceof Headers || options.onlyIf?.etagDoesNotMatch !== "*") throw new Error("missing defenses");
				if (mode === "race-unread") return null;
				if (mode === "storage-error") throw new Error("storage unavailable");
				const reader = body.getReader();
				try {
					if (mode === "race-partial" || mode === "race-partial-unread") {
						const chunk = await reader.read();
						bytesRead += chunk.value?.byteLength ?? 0;
						if (mode === "race-partial") await reader.cancel();
						return null;
					}
					for (;;) {
						const result = await reader.read();
						if (result.done) break;
						if (mode === "bounded" && result.value.byteLength > 64 * 1024) throw new Error("whole-body write");
						bytesRead += result.value.byteLength;
					}
					if (mode === "checksum-error") throw new Error("put: Provided checksum does not match the uploaded content. (10037)");
					return { key, size: bytesRead };
				} finally { reader.releaseLock(); }
			},
		} as unknown as R2Bucket : new Proxy(env.BLOBS, { get(target, property) {
			if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
				puts++;
				const result = await target.put(...args);
				if (result) created++;
				return result;
			};
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		} });
		try {
			const response = await handleBlobRoute(await routeEnv(new CloudflareObjectStore(bucket)), VAULT_ID, routedRequest, [hash], json);
			response.headers.set("X-R4-Puts", String(puts));
			response.headers.set("X-R4-Created", String(created));
			response.headers.set("X-R4-Produced", String(produced));
			response.headers.set("X-R4-Max-Ahead", String(maxAhead));
			response.headers.set("X-R4-Bytes-Read", String(bytesRead));
			return response;
		} catch (error) {
			return json({ error: String(error) }, 500);
		}
	},
};
