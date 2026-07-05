import { DurableObject } from "cloudflare:workers";
import {
	existsBlobHashes,
	getBlobRecord,
	initBlobStoreSchema,
	putBlobRecord,
	storageStatus,
	sweepOrphans,
} from "./blobStoreSql";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export class VaultBlobStore extends DurableObject {
	private schemaInit: Promise<void> | null = null;

	private ensureSchema(): Promise<void> {
		if (!this.schemaInit) {
			this.schemaInit = this.ctx.blockConcurrencyWhile(async () => {
				initBlobStoreSchema(this.ctx.storage.sql);
			});
		}
		return this.schemaInit;
	}

	async fetch(request: Request): Promise<Response> {
		await this.ensureSchema();
		const url = new URL(request.url);
		const sql = this.ctx.storage.sql;

		if (request.method === "POST" && url.pathname === "/put") {
			let body: { hash?: string; mime?: string; bytes?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			if (typeof body.hash !== "string" || typeof body.mime !== "string" || typeof body.bytes !== "string") {
				return json({ error: "invalid body" }, 400);
			}
			const bytes = base64ToBytes(body.bytes);
			const result = putBlobRecord(sql, body.hash, body.mime, bytes, Date.now());
			if ("error" in result) return json(result);
			return json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/get") {
			let body: { hash?: string } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			if (typeof body.hash !== "string") {
				return json({ error: "invalid body" }, 400);
			}
			const record = getBlobRecord(sql, body.hash);
			if (record === null) return json({ error: "not found" }, 404);
			return json({ mime: record.mime, bytes: bytesToBase64(record.bytes) });
		}

		if (request.method === "POST" && url.pathname === "/exists") {
			let body: { hashes?: string[] } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			if (!Array.isArray(body.hashes)) {
				return json({ error: "invalid body" }, 400);
			}
			const present = existsBlobHashes(sql, body.hashes);
			return json({ present });
		}

		if (request.method === "GET" && url.pathname === "/status") {
			return json(storageStatus(sql));
		}

		if (request.method === "POST" && url.pathname === "/sweep") {
			let body: { liveHashes?: string[]; graceMs?: number } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}
			if (!Array.isArray(body.liveHashes) || typeof body.graceMs !== "number") {
				return json({ error: "invalid body" }, 400);
			}
			return json(sweepOrphans(sql, body.liveHashes, body.graceMs, Date.now()));
		}

		return json({ error: "not found" }, 404);
	}
}
