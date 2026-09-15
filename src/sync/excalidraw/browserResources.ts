import { validateExcalidrawManifest } from "@shared/excalidrawProtocol";
import { sha256BytesHex } from "../../utils/sha256";
import type { ExcalidrawResourcesPort } from "./host";
import type {
	ExcalidrawNativeFile,
	ExcalidrawResourceManifest,
	ExcalidrawResourceResolution,
} from "./types";
import type { BrowserFetch, PublicSharePermission } from "./browserTransport";
import type { ExcalidrawResourceStorePort, ExcalidrawVaultResourceResolver } from "./resources";

const defaultBrowserFetch: BrowserFetch = async (input, init) => await window.fetch(input, init);

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
	const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/u.exec(dataUrl);
	if (!match) throw new Error("unsupported Excalidraw resource data URL");
	const mime = match[1]!;
	const payload = match[3]!;
	if (!match[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime };
	const binary = atob(payload);
	return { bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)), mime };
}

function encodeDataUrl(bytes: Uint8Array, mime: string): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

function responseHeader(response: { headers?: Headers }, name: string): string | null {
	return response.headers?.get(name) ?? null;
}

/** Fetch-based member CAS port; wrap with `SameVaultExcalidrawResources`. */
export class BrowserMemberExcalidrawResourceStore implements ExcalidrawResourceStorePort {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly vaultResolver: ExcalidrawVaultResourceResolver,
		private readonly fetcher: BrowserFetch = defaultBrowserFetch) {
		this.base = host.replace(/\/$/, "");
	}
	async put(hash: string, bytes: Uint8Array, mime: string): Promise<void> {
		const body = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(body).set(bytes);
		const response = await this.fetcher(this.url(hash), { method: "PUT", credentials: "include", body,
			headers: { authorization: `Bearer ${this.token}`, "content-type": mime } });
		if (!response.ok) throw new Error(`member resource upload failed (${response.status})`);
	}
	async get(hash: string, size: number): Promise<Uint8Array | null> {
		const response = await this.fetcher(this.url(hash), { method: "GET", credentials: "include",
			headers: { authorization: `Bearer ${this.token}` } });
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`member resource download failed (${response.status})`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		return bytes.byteLength === size && await sha256BytesHex(bytes) === hash ? bytes : null;
	}
	resolveVaultResource: ExcalidrawVaultResourceResolver = (entry) => this.vaultResolver(entry);
	private url(hash: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/blobs/${encodeURIComponent(hash)}`;
	}
}

/** Cookie-authenticated, manifest-bound resource resolver/uploader for a public share session. */
export class PublicShareExcalidrawResources implements ExcalidrawResourcesPort {
	private readonly base: string;
	constructor(host: string, private readonly permission: () => PublicSharePermission,
		private readonly fetcher: BrowserFetch = defaultBrowserFetch) {
		this.base = `${host.replace(/\/$/, "")}/api/excalidraw/shares/session/resources`;
	}

	async publish(files: readonly ExcalidrawNativeFile[]): Promise<ExcalidrawResourceManifest> {
		if (this.permission() !== "read-write" && files.length > 0) throw new Error("public share is read-only");
		const entries: ExcalidrawResourceManifest["entries"] = [];
		for (const file of files) {
			const decoded = decodeDataUrl(file.dataURL);
			const contentHash = await sha256BytesHex(decoded.bytes);
			const body = new ArrayBuffer(decoded.bytes.byteLength);
			new Uint8Array(body).set(decoded.bytes);
			const response = await this.fetcher(this.base, {
				method: "POST", credentials: "include", referrerPolicy: "no-referrer", body,
				headers: { "content-type": decoded.mime, "x-yaos-content-sha256": contentHash,
					"x-yaos-public-resource-id": file.id },
			});
			if (!response.ok) throw new Error(`public resource upload failed (${response.status})`);
			entries.push({ kind: "embedded", resourceId: file.id, contentHash,
				size: decoded.bytes.byteLength, mime: decoded.mime, created: file.created,
				...(file.lastRetrieved === undefined ? {} : { lastRetrieved: file.lastRetrieved }) });
		}
		const manifest: ExcalidrawResourceManifest = { version: 1, entries };
		validateExcalidrawManifest(manifest);
		return manifest;
	}

	async resolve(manifest: ExcalidrawResourceManifest): Promise<ExcalidrawResourceResolution> {
		validateExcalidrawManifest(manifest);
		const files: ExcalidrawNativeFile[] = [];
		const unavailable: ExcalidrawResourceResolution["unavailable"] = [];
		for (const entry of manifest.entries) {
			if (entry.kind !== "embedded") {
				unavailable.push({ resourceId: entry.resourceId, reason: "vault resources are never public" });
				continue;
			}
			try {
				const response = await this.fetcher(`${this.base}/${encodeURIComponent(entry.resourceId)}`, {
					method: "GET", credentials: "include", referrerPolicy: "no-referrer",
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				const headerHash = responseHeader(response, "x-yaos-content-sha256");
				if (bytes.byteLength !== entry.size || await sha256BytesHex(bytes) !== entry.contentHash
					|| (headerHash !== null && headerHash !== entry.contentHash)) throw new Error("integrity mismatch");
				files.push({ id: entry.resourceId, dataURL: encodeDataUrl(bytes, entry.mime), mimeType: entry.mime,
					created: entry.created, ...(entry.lastRetrieved === undefined ? {} : { lastRetrieved: entry.lastRetrieved }) });
			} catch {
				unavailable.push({ resourceId: entry.resourceId, reason: "public resource is unavailable or corrupt" });
			}
		}
		return { files, unavailable };
	}
}
