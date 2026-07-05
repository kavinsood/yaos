import { getServerByName } from "partyserver";
import { mapWithConcurrency } from "./concurrency";
import { blobKey } from "./snapshot";
import type { Env } from "./routes/types";

const R2_HEAD_CONCURRENCY = 4;

export interface BlobBackend {
	upload(vaultId: string, hash: string, mime: string, body: ArrayBuffer): Promise<{ ok: true } | { error: "full" }>;
	download(vaultId: string, hash: string): Promise<{ mime: string; body: ArrayBuffer } | null>;
	exists(vaultId: string, hashes: string[]): Promise<string[]>;
	storageStatus(vaultId: string): Promise<{ usedBytes: number; blobCount: number }>;
}

export function selectBlobBackend(env: Env): BlobBackend | null {
	if (env.YAOS_BUCKET) return new R2BlobBackend(env);
	if (env.YAOS_BLOBS) return new DoBlobBackend(env);
	return null;
}

class R2BlobBackend implements BlobBackend {
	constructor(private env: Env) {}

	async upload(
		vaultId: string,
		hash: string,
		mime: string,
		body: ArrayBuffer,
	): Promise<{ ok: true } | { error: "full" }> {
		await this.env.YAOS_BUCKET!.put(blobKey(vaultId, hash), body, {
			httpMetadata: { contentType: mime },
		});
		return { ok: true };
	}

	async download(vaultId: string, hash: string): Promise<{ mime: string; body: ArrayBuffer } | null> {
		const object = await this.env.YAOS_BUCKET!.get(blobKey(vaultId, hash));
		if (!object) return null;
		return {
			mime: object.httpMetadata?.contentType ?? "application/octet-stream",
			body: await object.arrayBuffer(),
		};
	}

	async exists(vaultId: string, hashes: string[]): Promise<string[]> {
		const bucket = this.env.YAOS_BUCKET!;
		const present = await mapWithConcurrency(
			hashes,
			R2_HEAD_CONCURRENCY,
			async (hash) => {
				const object = await bucket.head(blobKey(vaultId, hash));
				return object ? hash : null;
			},
		);
		return present.filter((hash): hash is string => hash !== null);
	}

	async storageStatus(_vaultId: string): Promise<{ usedBytes: number; blobCount: number }> {
		return { usedBytes: 0, blobCount: 0 };
	}
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

class DoBlobBackend implements BlobBackend {
	constructor(private env: Env) {}

	private stub(vaultId: string) {
		return getServerByName(this.env.YAOS_BLOBS!, vaultId);
	}

	async upload(
		vaultId: string,
		hash: string,
		mime: string,
		body: ArrayBuffer,
	): Promise<{ ok: true } | { error: "full" }> {
		const stub = await this.stub(vaultId);
		const res = await stub.fetch("https://internal/put", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hash,
				mime,
				bytes: bytesToBase64(new Uint8Array(body)),
			}),
		});
		const result = (await res.json()) as { ok?: true; error?: string };
		if (result.error === "full") return { error: "full" };
		return { ok: true };
	}

	async download(vaultId: string, hash: string): Promise<{ mime: string; body: ArrayBuffer } | null> {
		const stub = await this.stub(vaultId);
		const res = await stub.fetch("https://internal/get", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hash }),
		});
		if (res.status === 404) return null;
		const data = (await res.json()) as { mime: string; bytes: string };
		const bytes = base64ToBytes(data.bytes);
		return { mime: data.mime, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
	}

	async exists(vaultId: string, hashes: string[]): Promise<string[]> {
		const stub = await this.stub(vaultId);
		const res = await stub.fetch("https://internal/exists", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hashes }),
		});
		const data = (await res.json()) as { present: string[] };
		return data.present;
	}

	async storageStatus(vaultId: string): Promise<{ usedBytes: number; blobCount: number }> {
		const stub = await this.stub(vaultId);
		const res = await stub.fetch("https://internal/status", { method: "GET" });
		return (await res.json()) as { usedBytes: number; blobCount: number };
	}
}
