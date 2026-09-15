import type { ExcalidrawEmbeddedResource, ExcalidrawResourceManifest,
	ExcalidrawResourceManifestEntry, ExcalidrawVaultResource } from "@shared/excalidrawProtocol";
import { sha256BytesHex } from "../../utils/sha256";
import type { ExcalidrawNativeFile, ExcalidrawResourceResolution } from "./types";
import type { HttpRequester } from "../../utils/http";
import { obsidianRequest } from "../../utils/http";

export interface ExcalidrawResourceStorePort {
	put(hash: string, bytes: Uint8Array, mime: string): Promise<void>;
	get(hash: string, size: number, mime: string): Promise<Uint8Array | null>;
	resolveVaultResource(entry: ExcalidrawVaultResource): Promise<ExcalidrawNativeFile | null>;
}

export interface ExcalidrawResourceClassifier {
	classify(file: ExcalidrawNativeFile): Promise<ExcalidrawVaultResource | null>;
}

export type ExcalidrawVaultResourceResolver = (entry: ExcalidrawVaultResource) => Promise<ExcalidrawNativeFile | null>;

export class HttpExcalidrawResourceStore implements ExcalidrawResourceStorePort {
	private readonly base: string;
	constructor(host: string, private readonly vaultId: string, private readonly token: string,
		private readonly vaultResolver: ExcalidrawVaultResourceResolver,
		private readonly request: HttpRequester = obsidianRequest) { this.base = host.replace(/\/$/, ""); }
	async put(hash: string, bytes: Uint8Array, mime: string): Promise<void> {
		const body = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(body).set(bytes);
		const response = await this.request({ url: this.url(hash), method: "PUT", contentType: mime,
			body, headers: this.headers() });
		if (response.status !== 204) throw new Error(`Excalidraw resource upload failed (${response.status})`);
	}
	async get(hash: string, _size: number, _mime: string): Promise<Uint8Array | null> {
		const response = await this.request({ url: this.url(hash), method: "GET", headers: this.headers() });
		if (response.status === 404) return null;
		if (response.status !== 200) throw new Error(`Excalidraw resource download failed (${response.status})`);
		return new Uint8Array(response.arrayBuffer);
	}
	resolveVaultResource(entry: ExcalidrawVaultResource): Promise<ExcalidrawNativeFile | null> {
		return this.vaultResolver(entry);
	}
	private url(hash: string): string {
		return `${this.base}/vault/${encodeURIComponent(this.vaultId)}/blobs/${encodeURIComponent(hash)}`;
	}
	private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token}` }; }
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
	const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
	if (!match) throw new Error("unsupported Excalidraw binary data URL");
	const mime = match[1]!;
	const encoded = match[3]!;
	if (match[2]) {
		const text = atob(encoded);
		const bytes = new Uint8Array(text.length);
		for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
		return { bytes, mime };
	}
	return { bytes: new TextEncoder().encode(decodeURIComponent(encoded)), mime };
}

function encodeDataUrl(bytes: Uint8Array, mime: string): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

/** Same-vault resources remain typed references or immutable CAS objects; no dependency recursion occurs here. */
export class SameVaultExcalidrawResources {
	constructor(private readonly store: ExcalidrawResourceStorePort,
		private readonly classifier?: ExcalidrawResourceClassifier) {}

	async publish(files: readonly ExcalidrawNativeFile[]): Promise<ExcalidrawResourceManifest> {
		const entries: ExcalidrawResourceManifestEntry[] = [];
		for (const file of files) {
			const vaultResource = await this.classifier?.classify(file) ?? null;
			if (vaultResource) { entries.push(vaultResource); continue; }
			const decoded = decodeDataUrl(file.dataURL);
			const contentHash = await sha256BytesHex(decoded.bytes);
			try { await this.store.put(contentHash, decoded.bytes, decoded.mime); }
			catch { /* Scene durability is independent; a later capture retries immutable publication. */ }
			const entry: ExcalidrawEmbeddedResource = { kind: "embedded", resourceId: file.id,
				contentHash, size: decoded.bytes.byteLength, mime: decoded.mime, created: file.created,
				...(file.lastRetrieved === undefined ? {} : { lastRetrieved: file.lastRetrieved }) };
			entries.push(entry);
		}
		return { version: 1, entries };
	}

	async resolve(manifest: ExcalidrawResourceManifest): Promise<ExcalidrawResourceResolution> {
		const files: ExcalidrawNativeFile[] = [];
		const unavailable: Array<{ resourceId: string; reason: string }> = [];
		for (const entry of manifest.entries) {
			try {
				if (entry.kind === "vault") {
					const resolved = await this.store.resolveVaultResource(entry);
					if (resolved) files.push(resolved);
					else unavailable.push({ resourceId: entry.resourceId, reason: "vault resource is unavailable locally" });
					continue;
				}
				const bytes = await this.store.get(entry.contentHash, entry.size, entry.mime);
				if (!bytes || bytes.byteLength !== entry.size || await sha256BytesHex(bytes) !== entry.contentHash) {
					unavailable.push({ resourceId: entry.resourceId, reason: "embedded resource is missing or corrupt" });
					continue;
				}
				files.push({ id: entry.resourceId, dataURL: encodeDataUrl(bytes, entry.mime), mimeType: entry.mime,
					created: entry.created, ...(entry.lastRetrieved === undefined ? {} : { lastRetrieved: entry.lastRetrieved }) });
			} catch {
				unavailable.push({ resourceId: entry.resourceId, reason: "resource resolution failed" });
			}
		}
		return { files, unavailable };
	}
}
