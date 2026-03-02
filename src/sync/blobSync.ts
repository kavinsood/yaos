/**
 * BlobSyncManager — handles upload/download of non-markdown attachments
 * via content-addressed R2 blob storage.
 *
 * Architecture:
 *   - Client hashes file bytes (SHA-256) and requests presigned URLs from server
 *   - Uploads/downloads go directly to R2 (no bytes through the DO)
 *   - CRDT maps (pathToBlob, blobMeta, blobTombstones) track which blobs belong where
 *   - Two-phase commit: CRDT is only updated AFTER successful upload
 *   - Content-addressing provides automatic dedup across the vault
 *
 * Flow:
 *   Upload: detect change → hash → check exists → presign PUT → upload → set CRDT
 *   Download: CRDT observer fires → check disk → presign GET → download → write disk
 */
import { type App, TFile, normalizePath, requestUrl, arrayBufferToHex } from "obsidian";
import type { VaultSync } from "./vaultSync";
import type { BlobRef } from "../types";
import { ORIGIN_SEED } from "../types";
import {
	appendTraceParams,
	type TraceHttpContext,
	type TraceRecord,
} from "../debug/trace";
import {
	type BlobHashCache,
	getCachedHash,
	setCachedHash,
	removeCachedHash,
} from "./blobHashCache";

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------

const DEBOUNCE_MS = 500;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const SUPPRESS_MS = 1000;

// -------------------------------------------------------------------
// Presign HTTP client
// -------------------------------------------------------------------

interface PresignPutResult {
	url: string;
	expiresIn: number;
}

interface PresignGetResult {
	url: string;
	expiresIn: number;
}

interface ExistsResult {
	present: string[];
}

class BlobPresignClient {
	constructor(
		private host: string,
		private token: string,
		private roomId: string,
		private trace?: TraceHttpContext,
	) {}

	/**
	 * Build the HTTP URL for a blob endpoint on the PartyKit room.
	 * PartyKit exposes rooms at: /parties/main/<roomId>
	 */
	private url(endpoint: string): string {
		// Do not URL-encode roomId here: websocket sync uses raw room IDs,
		// and encoding would route HTTP requests to a different DO room.
		return appendTraceParams(
			`${this.host}/parties/main/${this.roomId}${endpoint}`,
			this.trace,
		);
	}

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
		};
	}

	async presignPut(
		hash: string,
		contentType: string,
		contentLength: number,
	): Promise<PresignPutResult> {
		const res = await requestUrl({
			url: this.url("/blob/presign-put"),
			method: "POST",
			contentType: "application/json",
			headers: this.authHeaders(),
			body: JSON.stringify({ hash, contentType, contentLength }),
		});
		if (res.status !== 200) {
			throw new Error(`presign-put failed: ${res.status} ${res.text}`);
		}
		return res.json as PresignPutResult;
	}

	async presignGet(hash: string): Promise<PresignGetResult> {
		const res = await requestUrl({
			url: this.url("/blob/presign-get"),
			method: "POST",
			contentType: "application/json",
			headers: this.authHeaders(),
			body: JSON.stringify({ hash }),
		});
		if (res.status !== 200) {
			throw new Error(`presign-get failed: ${res.status} ${res.text}`);
		}
		return res.json as PresignGetResult;
	}

	async exists(hashes: string[]): Promise<string[]> {
		const res = await requestUrl({
			url: this.url("/blob/exists"),
			method: "POST",
			contentType: "application/json",
			headers: this.authHeaders(),
			body: JSON.stringify({ hashes }),
		});
		if (res.status !== 200) {
			throw new Error(`exists failed: ${res.status} ${res.text}`);
		}
		return (res.json as ExistsResult).present;
	}
}

// -------------------------------------------------------------------
// Hashing
// -------------------------------------------------------------------

async function hashArrayBuffer(data: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	return arrayBufferToHex(hashBuffer);
}

/**
 * Guess MIME type from file extension.
 * Covers the common attachment types in Obsidian vaults.
 */
function guessMime(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	const mimes: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		svg: "image/svg+xml",
		webp: "image/webp",
		bmp: "image/bmp",
		ico: "image/x-icon",
		pdf: "application/pdf",
		mp3: "audio/mpeg",
		wav: "audio/wav",
		ogg: "audio/ogg",
		mp4: "video/mp4",
		webm: "video/webm",
		mov: "video/quicktime",
		zip: "application/zip",
		json: "application/json",
		csv: "text/csv",
		txt: "text/plain",
		canvas: "application/json",
	};
	return mimes[ext] ?? "application/octet-stream";
}

// -------------------------------------------------------------------
// Queue item types
// -------------------------------------------------------------------

interface UploadItem {
	path: string;
	retries: number;
}

interface DownloadItem {
	path: string;
	hash: string;
	retries: number;
}

/**
 * Serializable snapshot of pending queues.
 * Persisted to plugin data.json so in-flight transfers survive reloads.
 */
export interface BlobQueueSnapshot {
	uploads: { path: string }[];
	downloads: { path: string; hash: string }[];
}

// -------------------------------------------------------------------
// BlobSyncManager
// -------------------------------------------------------------------

export class BlobSyncManager {
	private presignClient: BlobPresignClient;

	/** Pending uploads keyed by path (deduped). */
	private uploadQueue = new Map<string, UploadItem>();
	/** Pending downloads keyed by path (deduped). */
	private downloadQueue = new Map<string, DownloadItem>();

	/** Debounce timers for upload scheduling (keyed by path). */
	private uploadDebounce = new Map<string, ReturnType<typeof setTimeout>>();

	/** Current in-flight upload count. */
	private inflightUploads = 0;
	/** Current in-flight download count. */
	private inflightDownloads = 0;
	/** True while upload drain is running. */
	private uploadDraining = false;
	/** True while download drain is running. */
	private downloadDraining = false;

	/** Path suppression to prevent upload-on-own-download loops. */
	private suppressedPaths = new Map<string, number>();

	/** Completed transfer counts (reset each reconcile cycle). */
	private _completedUploads = 0;
	private _completedDownloads = 0;
	/** Total transfers queued in the current batch (for N/M display). */
	private _totalUploadsThisCycle = 0;
	private _totalDownloadsThisCycle = 0;

	/** CRDT map observer cleanup functions. */
	private observerCleanups: (() => void)[] = [];

	private readonly maxConcurrency: number;
	private readonly maxSize: number;
	private readonly debug: boolean;

	/** External blob hash cache (owned by main.ts, persisted to data.json). */
	private hashCache: BlobHashCache;

	constructor(
		private app: App,
		private vaultSync: VaultSync,
		settings: {
			host: string;
			token: string;
			vaultId: string;
			maxAttachmentSizeKB: number;
			attachmentConcurrency: number;
			debug: boolean;
			trace?: TraceHttpContext;
		},
		hashCache: BlobHashCache,
		private trace?: TraceRecord,
	) {
		const roomId = "v1:" + settings.vaultId;
		this.presignClient = new BlobPresignClient(
			settings.host,
			settings.token,
			roomId,
			settings.trace,
		);
		this.maxConcurrency = settings.attachmentConcurrency;
		this.maxSize = settings.maxAttachmentSizeKB * 1024;
		this.debug = settings.debug;
		this.hashCache = hashCache;
	}

	// -------------------------------------------------------------------
	// CRDT observers (remote changes → download queue)
	// -------------------------------------------------------------------

	/**
	 * Start observing pathToBlob and blobTombstones for remote changes.
	 * Remote blob additions → schedule download.
	 * Remote tombstones → delete from disk.
	 */
	startObservers(): void {
		// pathToBlob observer: remote add/update → download if missing
		const blobObserver = (event: import("yjs").YMapEvent<BlobRef>) => {
			event.changes.keys.forEach((change, path) => {
				if (change.action === "add" || change.action === "update") {
					if (event.transaction.origin === ORIGIN_SEED) return;
					const ref = this.vaultSync.pathToBlob.get(path);
					if (!ref) return;
					this.log(`observer: remote blob ref for "${path}" hash=${ref.hash.slice(0, 12)}…`);
					this.scheduleDownload(path, ref.hash);
				}
				if (change.action === "delete") {
					if (event.transaction.origin === ORIGIN_SEED) return;
					void this.handleRemoteDelete(path);
				}
			});
		};
		this.vaultSync.pathToBlob.observe(blobObserver);
		this.observerCleanups.push(() =>
			this.vaultSync.pathToBlob.unobserve(blobObserver),
		);

		// blobTombstones observer: remote tombstone → delete from disk
		const tombObserver = (event: import("yjs").YMapEvent<import("../types").BlobTombstone>) => {
			event.changes.keys.forEach((change, path) => {
				if (change.action === "add" || change.action === "update") {
					if (event.transaction.origin === ORIGIN_SEED) return;
					void this.handleRemoteDelete(path);
				}
			});
		};
		this.vaultSync.blobTombstones.observe(tombObserver);
		this.observerCleanups.push(() =>
			this.vaultSync.blobTombstones.unobserve(tombObserver),
		);

		this.log("Blob observers started");
	}

	// -------------------------------------------------------------------
	// Public event handlers (called from main.ts vault events)
	// -------------------------------------------------------------------

	/**
	 * Handle a local file create/modify for a blob-syncable file.
	 * Debounces and queues upload.
	 */
	handleFileChange(file: TFile): void {
		if (this.isSuppressed(file.path)) {
			this.log(`handleFileChange: suppressed "${file.path}"`);
			return;
		}

		// Clear existing debounce
		const existing = this.uploadDebounce.get(file.path);
		if (existing) clearTimeout(existing);

		this.uploadDebounce.set(
			file.path,
			setTimeout(() => {
				this.uploadDebounce.delete(file.path);
				this.uploadQueue.set(file.path, { path: file.path, retries: 0 });
				this.kickUploadDrain();
			}, DEBOUNCE_MS),
		);
	}

	/**
	 * Handle a local file delete for a blob-syncable file.
	 */
	handleFileDelete(path: string, device?: string): void {
		// Cancel any pending upload
		this.uploadDebounce.get(path) && clearTimeout(this.uploadDebounce.get(path));
		this.uploadDebounce.delete(path);
		this.uploadQueue.delete(path);

		// Remove from hash cache
		removeCachedHash(this.hashCache, path);

		this.vaultSync.deleteBlobRef(path, device);
	}

	/**
	 * Reconcile blob files: compare disk blobs vs CRDT pathToBlob.
	 * Called during authoritative reconciliation.
	 *
	 * Returns: { uploadQueued, downloadQueued, skipped }
	 */
	async reconcile(
		mode: "conservative" | "authoritative",
		excludePatterns: string[],
	): Promise<{ uploadQueued: number; downloadQueued: number; skipped: number }> {
		let uploadQueued = 0;
		let downloadQueued = 0;
		let skipped = 0;

		// Collect non-md, non-excluded disk files
		const diskBlobs = new Map<string, TFile>();
		for (const file of this.app.vault.getFiles()) {
			if (file.path.endsWith(".md")) continue;
			if (file.path.startsWith(".obsidian/") || file.path.startsWith(".trash/")) continue;
			// Check user exclude patterns
			let excluded = false;
			for (const prefix of excludePatterns) {
				if (file.path.startsWith(prefix)) {
					excluded = true;
					break;
				}
			}
			if (excluded) continue;

			// Size check
			if (this.maxSize > 0 && file.stat.size > this.maxSize) continue;

			diskBlobs.set(file.path, file);
		}

		// Collect CRDT blob paths (non-tombstoned)
		const crdtBlobPaths = new Set<string>();
		this.vaultSync.pathToBlob.forEach((_ref, path) => {
			if (!this.vaultSync.isBlobTombstoned(path)) {
				crdtBlobPaths.add(path);
			}
		});

		// CRDT blobs not on disk → schedule download
		for (const path of crdtBlobPaths) {
			if (!diskBlobs.has(path)) {
				const ref = this.vaultSync.pathToBlob.get(path);
				if (ref) {
					this.scheduleDownload(path, ref.hash);
					downloadQueued++;
				}
			}
		}

		// Disk blobs not in CRDT → schedule upload (authoritative only)
		// Disk blobs IN CRDT but with different hash → schedule upload (content changed offline)
		for (const [path, file] of diskBlobs) {
			// Check tombstone
			if (this.vaultSync.isBlobTombstoned(path)) {
				skipped++;
				continue;
			}

			if (crdtBlobPaths.has(path)) {
				// Both sides have this path — check for hash mismatch
				// (file was modified while offline, e.g. image edited externally)
				if (mode === "authoritative") {
					const ref = this.vaultSync.pathToBlob.get(path);
					if (ref) {
						const fileStat = { mtime: file.stat.mtime, size: file.stat.size };
						const cachedHash = getCachedHash(this.hashCache, path, fileStat);

						if (cachedHash) {
							// Cache hit: compare hashes directly (no read needed)
							if (cachedHash !== ref.hash) {
								this.uploadQueue.set(path, { path, retries: 0 });
								uploadQueued++;
							}
						} else if (ref.size !== file.stat.size) {
							// No cache, but size differs — definitely changed
							this.uploadQueue.set(path, { path, retries: 0 });
							uploadQueued++;
						}
						// If sizes match and no cache, skip — processUpload will
						// do a full hash check if triggered by a future modify event
					}
				}
				continue;
			}

			if (mode === "authoritative") {
				this.uploadQueue.set(path, { path, retries: 0 });
				uploadQueued++;
			} else {
				skipped++;
			}
		}

		// Kick drains if anything was queued
		if (uploadQueued > 0 || downloadQueued > 0) {
			// Reset cycle counters for fresh progress tracking
			this._completedUploads = 0;
			this._completedDownloads = 0;
			this._totalUploadsThisCycle = uploadQueued;
			this._totalDownloadsThisCycle = downloadQueued;
		}
		if (uploadQueued > 0) this.kickUploadDrain();
		if (downloadQueued > 0) this.kickDownloadDrain();

		this.log(
			`reconcile: ${uploadQueued} uploads queued, ` +
			`${downloadQueued} downloads queued, ${skipped} skipped`,
		);

		return { uploadQueued, downloadQueued, skipped };
	}

	// -------------------------------------------------------------------
	// Upload drain
	// -------------------------------------------------------------------

	private kickUploadDrain(): void {
		if (this.uploadDraining) return;
		void this.drainUploads();
	}

	private async drainUploads(): Promise<void> {
		this.uploadDraining = true;
		try {
			while (this.uploadQueue.size > 0) {
				// Intentionally coarse batching:
				// we prefer predictable, bounded progress over a custom worker-pool
				// state machine with extra retry/persistence edge cases. One slow
				// item can delay the next batch, but this shape is easier to reason
				// about and much harder to deadlock or leak slots.
				// Take up to maxConcurrency items
				const batch: UploadItem[] = [];
				for (const [, item] of this.uploadQueue) {
					batch.push(item);
					if (batch.length >= this.maxConcurrency) break;
				}
				for (const item of batch) {
					this.uploadQueue.delete(item.path);
				}

				await Promise.all(batch.map((item) => this.processUpload(item)));
			}
		} finally {
			this.uploadDraining = false;
		}
	}

	private async processUpload(item: UploadItem): Promise<void> {
		this.inflightUploads++;
		try {
			const normalized = normalizePath(item.path);
			const file = this.app.vault.getAbstractFileByPath(normalized);
			if (!(file instanceof TFile)) {
				this.log(`upload: "${item.path}" no longer exists, skipping`);
				removeCachedHash(this.hashCache, item.path);
				return;
			}

			// Size guard
			if (this.maxSize > 0 && file.stat.size > this.maxSize) {
				this.log(`upload: "${item.path}" too large (${file.stat.size} bytes), skipping`);
				return;
			}

			// Try hash cache first: if mtime+size match, skip read+hash
			const fileStat = { mtime: file.stat.mtime, size: file.stat.size };
			let hash = getCachedHash(this.hashCache, item.path, fileStat);
			let data: ArrayBuffer | null = null;

			if (!hash) {
				// Cache miss — read and hash the file
				data = await this.app.vault.readBinary(file);
				hash = await hashArrayBuffer(data);
				setCachedHash(this.hashCache, item.path, fileStat, hash);
			}

			// Check if CRDT already has this exact hash for this path
			const existingRef = this.vaultSync.getBlobRef(item.path);
			if (existingRef && existingRef.hash === hash) {
				this.log(`upload: "${item.path}" unchanged (hash match), skipping`);
				return;
			}

			// Check if R2 already has this blob (content-addressed dedup)
			const present = await this.presignClient.exists([hash]);
			if (!present.includes(hash)) {
				// Need actual bytes for upload — read if we used cache
				if (!data) {
					data = await this.app.vault.readBinary(file);
				}

				// Upload to R2
				const mime = guessMime(item.path);
				const { url } = await this.presignClient.presignPut(hash, mime, data.byteLength);

				const uploadRes = await requestUrl({
					url,
					method: "PUT",
					body: data,
					headers: {
						"Content-Type": mime,
					},
				});

				if (uploadRes.status < 200 || uploadRes.status >= 300) {
					throw new Error(`R2 PUT failed: ${uploadRes.status}`);
				}

				this.log(`upload: "${item.path}" uploaded to R2 (${data.byteLength} bytes)`);
			} else {
				this.log(`upload: "${item.path}" already in R2 (dedup), updating CRDT only`);
			}

			// Two-phase commit: update CRDT only after successful upload
			const mime = guessMime(item.path);
			this.vaultSync.setBlobRef(item.path, hash, file.stat.size, mime);
			this._completedUploads++;
		} catch (err) {
			if (item.retries < MAX_RETRIES) {
				const delay = RETRY_BASE_MS * Math.pow(4, item.retries);
				this.log(`upload: "${item.path}" failed (attempt ${item.retries + 1}), retrying in ${delay}ms`);
				item.retries++;
				setTimeout(() => {
					this.uploadQueue.set(item.path, item);
					this.kickUploadDrain();
				}, delay);
			} else {
				console.error(
					`[vault-crdt-sync:blob] Upload failed permanently for "${item.path}":`,
					err,
				);
			}
		} finally {
			this.inflightUploads--;
		}
	}

	// -------------------------------------------------------------------
	// Download drain
	// -------------------------------------------------------------------

	private scheduleDownload(path: string, hash: string): void {
		this.downloadQueue.set(path, { path, hash, retries: 0 });
		this.kickDownloadDrain();
	}

	/**
	 * Schedule high-priority downloads for paths that are needed now
	 * (e.g. attachments embedded in the currently-open note).
	 * Skips paths already on disk or already queued.
	 */
	prioritizeDownloads(paths: string[]): number {
		let queued = 0;
		for (const path of paths) {
			// Already queued
			if (this.downloadQueue.has(path)) continue;

			// Check if file exists on disk already
			const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
			if (existing instanceof TFile) continue;

			// Look up the blob ref in the CRDT
			const ref = this.vaultSync.pathToBlob.get(path);
			if (!ref) continue;
			if (this.vaultSync.isBlobTombstoned(path)) continue;

			this.downloadQueue.set(path, { path, hash: ref.hash, retries: 0 });
			queued++;
		}

		if (queued > 0) {
			this.log(`prioritizeDownloads: queued ${queued} prefetch downloads`);
			this.kickDownloadDrain();
		}
		return queued;
	}

	private kickDownloadDrain(): void {
		if (this.downloadDraining) return;
		void this.drainDownloads();
	}

	private async drainDownloads(): Promise<void> {
		this.downloadDraining = true;
		try {
			while (this.downloadQueue.size > 0) {
				// Same tradeoff as uploads: keep the scheduler boring and
				// deterministic. We can revisit this only if real-world attachment
				// throughput becomes a user-visible problem.
				const batch: DownloadItem[] = [];
				for (const [, item] of this.downloadQueue) {
					batch.push(item);
					if (batch.length >= this.maxConcurrency) break;
				}
				for (const item of batch) {
					this.downloadQueue.delete(item.path);
				}

				await Promise.all(batch.map((item) => this.processDownload(item)));
			}
		} finally {
			this.downloadDraining = false;
		}
	}

	private async processDownload(item: DownloadItem): Promise<void> {
		this.inflightDownloads++;
		try {
			const normalized = normalizePath(item.path);

			// Check if file already exists with matching hash
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing instanceof TFile) {
				// Try hash cache first
				const fileStat = { mtime: existing.stat.mtime, size: existing.stat.size };
				let diskHash = getCachedHash(this.hashCache, item.path, fileStat);

				if (!diskHash) {
					try {
						const data = await this.app.vault.readBinary(existing);
						diskHash = await hashArrayBuffer(data);
						setCachedHash(this.hashCache, item.path, fileStat, diskHash);
					} catch {
						// Can't read — download anyway
					}
				}

				if (diskHash === item.hash) {
					this.log(`download: "${item.path}" already matches, skipping`);
					return;
				}
			}

			// Presign GET
			const { url } = await this.presignClient.presignGet(item.hash);

			// Download
			const res = await requestUrl({ url, method: "GET" });
			if (res.status < 200 || res.status >= 300) {
				throw new Error(`R2 GET failed: ${res.status}`);
			}

			const data = res.arrayBuffer;

			// Verify hash of downloaded data
			const downloadHash = await hashArrayBuffer(data);
			if (downloadHash !== item.hash) {
				throw new Error(
					`Hash mismatch: expected ${item.hash.slice(0, 12)}… got ${downloadHash.slice(0, 12)}…`,
				);
			}

			// Suppress path to prevent re-upload from vault event
			this.suppress(item.path);

			// Write to disk
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, data);
				this.log(`download: updated "${item.path}" (${data.byteLength} bytes)`);
			} else {
				// Ensure parent directory exists
				const dir = normalized.substring(0, normalized.lastIndexOf("/"));
				if (dir) {
					const dirExists = this.app.vault.getAbstractFileByPath(normalizePath(dir));
					if (!dirExists) {
						await this.app.vault.createFolder(dir);
					}
				}
				await this.app.vault.createBinary(normalized, data);
				this.log(`download: created "${item.path}" (${data.byteLength} bytes)`);
			}

			// Update hash cache with the freshly-written file's hash.
			// Use stat from disk to get the actual mtime the OS assigned.
			try {
				const freshStat = await this.app.vault.adapter.stat(normalized);
				if (freshStat) {
					setCachedHash(
						this.hashCache,
						item.path,
						{ mtime: freshStat.mtime, size: freshStat.size },
						item.hash,
					);
				}
			} catch { /* stat failed, cache will miss next time — fine */ }

			this._completedDownloads++;
		} catch (err) {
			if (item.retries < MAX_RETRIES) {
				const delay = RETRY_BASE_MS * Math.pow(4, item.retries);
				this.log(`download: "${item.path}" failed (attempt ${item.retries + 1}), retrying in ${delay}ms`);
				item.retries++;
				setTimeout(() => {
					this.downloadQueue.set(item.path, item);
					this.kickDownloadDrain();
				}, delay);
			} else {
				console.error(
					`[vault-crdt-sync:blob] Download failed permanently for "${item.path}":`,
					err,
				);
			}
		} finally {
			this.inflightDownloads--;
		}
	}

	// -------------------------------------------------------------------
	// Remote delete handler
	// -------------------------------------------------------------------

	private async handleRemoteDelete(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			try {
				this.suppress(path);
				await this.app.vault.delete(file);
				this.log(`handleRemoteDelete: deleted "${path}" from disk`);
			} catch (err) {
				console.error(
					`[vault-crdt-sync:blob] handleRemoteDelete failed for "${path}":`,
					err,
				);
			}
		}
	}

	// -------------------------------------------------------------------
	// Suppression (prevent upload loops from own downloads)
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		const until = this.suppressedPaths.get(path);
		if (!until) return false;
		if (Date.now() < until) return true;
		this.suppressedPaths.delete(path);
		return false;
	}

	private suppress(path: string): void {
		this.suppressedPaths.set(path, Date.now() + SUPPRESS_MS);
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get pendingUploads(): number {
		return this.uploadQueue.size + this.uploadDebounce.size;
	}

	get pendingDownloads(): number {
		return this.downloadQueue.size;
	}

	/**
	 * Get a human-readable transfer status string, or null if idle.
	 * Examples: "↑2/5", "↓1/3", "↑2/5 ↓1/3"
	 */
	get transferStatus(): string | null {
		const parts: string[] = [];

		const upPending = this.uploadQueue.size + this.uploadDebounce.size + this.inflightUploads;
		if (upPending > 0 || this._completedUploads < this._totalUploadsThisCycle) {
			parts.push(`↑${this._completedUploads}/${this._totalUploadsThisCycle}`);
		}

		const downPending = this.downloadQueue.size + this.inflightDownloads;
		if (downPending > 0 || this._completedDownloads < this._totalDownloadsThisCycle) {
			parts.push(`↓${this._completedDownloads}/${this._totalDownloadsThisCycle}`);
		}

		return parts.length > 0 ? parts.join(" ") : null;
	}

	// -------------------------------------------------------------------
	// Queue persistence
	// -------------------------------------------------------------------

	/**
	 * Export a snapshot of pending queues for persistence.
	 * Retries are reset to 0 on restore (fresh attempt after reload).
	 */
	exportQueue(): BlobQueueSnapshot {
		const uploads: { path: string }[] = [];
		for (const [, item] of this.uploadQueue) {
			uploads.push({ path: item.path });
		}
		// Also include items in debounce (not yet in queue but pending)
		for (const [path] of this.uploadDebounce) {
			if (!this.uploadQueue.has(path)) {
				uploads.push({ path });
			}
		}

		const downloads: { path: string; hash: string }[] = [];
		for (const [, item] of this.downloadQueue) {
			downloads.push({ path: item.path, hash: item.hash });
		}

		return { uploads, downloads };
	}

	/**
	 * Restore queues from a persisted snapshot. Resets retries to 0.
	 * Skips items that are already queued or in-flight.
	 */
	importQueue(snapshot: BlobQueueSnapshot): void {
		let restored = 0;

		if (snapshot.uploads) {
			for (const item of snapshot.uploads) {
				if (!this.uploadQueue.has(item.path) && !this.uploadDebounce.has(item.path)) {
					this.uploadQueue.set(item.path, { path: item.path, retries: 0 });
					restored++;
				}
			}
		}

		if (snapshot.downloads) {
			for (const item of snapshot.downloads) {
				if (!this.downloadQueue.has(item.path)) {
					this.downloadQueue.set(item.path, { path: item.path, hash: item.hash, retries: 0 });
					restored++;
				}
			}
		}

		if (restored > 0) {
			this.log(`importQueue: restored ${restored} pending transfers`);
			if (this.uploadQueue.size > 0) this.kickUploadDrain();
			if (this.downloadQueue.size > 0) this.kickDownloadDrain();
		}
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

	destroy(): void {
		for (const cleanup of this.observerCleanups) {
			cleanup();
		}
		this.observerCleanups = [];

		for (const timer of this.uploadDebounce.values()) {
			clearTimeout(timer);
		}
		this.uploadDebounce.clear();

		this.uploadQueue.clear();
		this.downloadQueue.clear();
		this.suppressedPaths.clear();
		this.log("BlobSyncManager destroyed");
	}

	getDebugSnapshot(): {
		pendingUploads: number;
		pendingDownloads: number;
		suppressedCount: number;
		uploadQueue: string[];
		downloadQueue: string[];
	} {
		return {
			pendingUploads: this.uploadQueue.size,
			pendingDownloads: this.downloadQueue.size,
			suppressedCount: this.suppressedPaths.size,
			uploadQueue: Array.from(this.uploadQueue.values()).map((item) => item.path),
			downloadQueue: Array.from(this.downloadQueue.values()).map((item) => item.path),
		};
	}

	private log(msg: string): void {
		this.trace?.("blob", msg);
		if (this.debug) {
			console.log(`[vault-crdt-sync:blob] ${msg}`);
		}
	}
}
