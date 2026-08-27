/**
 * BlobSyncManager — handles upload/download of non-markdown attachments
 * via content-addressed R2 blob storage.
 *
 * Architecture:
 *   - Client hashes file bytes (SHA-256) and talks to the Worker directly
 *   - The Worker proxies bytes to native R2 bindings (no presigned URLs)
 *   - CRDT maps (pathToBlob, blobMeta, blobTombstones) track which blobs belong where
 *   - Two-phase commit: CRDT is only updated AFTER successful upload
 *   - Content-addressing provides automatic dedup across the vault
 *
 * Flow:
 *   Upload: detect change → hash → check exists → PUT to Worker → set CRDT
 *   Download: CRDT observer fires → check disk → GET from Worker → write disk
 */
import {
	type App,
	TFile,
	normalizePath,
	requestUrl,
	arrayBufferToHex,
	Notice,
} from "obsidian";
import { type BlobRef } from "../types";
import {
	appendTraceParams,
	type TraceHttpContext,
	type TraceRecord,
} from "../observability/traceContext";
import { PRODUCT_EVENT_KIND, type ProductEventKind } from "../observability/productEventKinds";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import {
	type BlobHashCache,
	getCachedHash,
	setCachedHash,
	removeCachedHash,
} from "./blobHashCache";
import { PreservedUnresolvedRegistry, type PreservedUnresolvedEntry, type PreservedUnresolvedReason } from "./preservedUnresolved";
import { safeBlobPath } from "./pathPolicy";

export type AttachmentCatalogChange =
	| { kind: "upsert"; path: string; ref: BlobRef; local: boolean }
	| { kind: "tombstone"; path: string; previousHash: string | null; local: boolean };

/**
 * Durable attachment metadata surface implemented by the canonical VaultSync
 * root document. Blob bytes remain content-addressed and live behind /blobs.
 */
export interface AttachmentCatalogPort {
	listAttachmentRefs(): Iterable<[string, BlobRef]>;
	getAttachmentRef(path: string): BlobRef | undefined;
	isAttachmentTombstoned(path: string): boolean;
	setAttachmentRef(path: string, hash: string, size: number, mime: string): void | Promise<void>;
	deleteAttachmentRef(path: string, device?: string): void | Promise<void>;
	renameAttachmentRef(oldPath: string, newPath: string): void | Promise<void>;
	observeAttachmentChanges(callback: (change: AttachmentCatalogChange) => void): () => void;
}

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------

/**
 * Three-way decision for blob remote-delete handling.
 * Discriminated union — NOT a boolean dirty flag.
 */
export type BlobRemoteDeleteDecision =
	| { kind: "apply-delete" }
	| { kind: "preserve-revive" }
	| { kind: "preserve-unresolved" };

const DEBOUNCE_MS = 500;
const MAX_RETRIES = 3;
const MAX_RERUN_RESETS = 5;
const RETRY_BASE_MS = 1000;
const SUPPRESS_MS = 1000;
const EXISTS_TIMEOUT_MS = 30_000;
const MIN_TRANSFER_TIMEOUT_MS = 30_000;
const MAX_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TRANSFER_SETUP_BUDGET_MS = 15_000;
const MIN_TRANSFER_BYTES_PER_SEC = 64 * 1024;

class BlobHttpTimeoutError extends Error {
	constructor(
		public readonly operation: string,
		public readonly timeoutMs: number,
	) {
		super(`Timeout (${timeoutMs}ms) during ${operation}`);
		this.name = "BlobHttpTimeoutError";
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	operation: string,
): Promise<T> {
	let timeoutId: number | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = window.setTimeout(() => {
			reject(new BlobHttpTimeoutError(operation, ms));
		}, ms);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeoutId) window.clearTimeout(timeoutId);
	}
}

function transferTimeoutMs(sizeBytes?: number): number {
	if (!sizeBytes || sizeBytes <= 0) return MIN_TRANSFER_TIMEOUT_MS;
	const transferMs = Math.ceil(
		(sizeBytes / MIN_TRANSFER_BYTES_PER_SEC) * 1000,
	);
	return Math.min(
		MAX_TRANSFER_TIMEOUT_MS,
		Math.max(
			MIN_TRANSFER_TIMEOUT_MS,
			TRANSFER_SETUP_BUDGET_MS + transferMs,
		),
	);
}

// -------------------------------------------------------------------
// Blob HTTP client
// -------------------------------------------------------------------

interface ExistsResult {
	present: string[];
}

class BlobHttpClient {
	constructor(
		private host: string,
		private token: string,
		private vaultId: string,
		private trace?: TraceHttpContext,
	) {}

	/**
	 * Build the HTTP URL for a blob endpoint on the Worker.
	 */
	private url(endpoint: string): string {
		return appendTraceParams(
			`${this.host}/vault/${encodeURIComponent(this.vaultId)}/blobs${endpoint}`,
			this.trace,
		);
	}

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
		};
	}

	async upload(
		hash: string,
		contentType: string,
		data: ArrayBuffer,
		timeoutMs: number,
	): Promise<void> {
		const res = await withTimeout(
			requestUrl({
				url: this.url(`/${hash}`),
				method: "PUT",
				headers: this.authHeaders(),
				body: data,
				contentType,
			}),
			timeoutMs,
			`blob upload ${hash.slice(0, 12)}…`,
		);
		if (res.status !== 204) {
			throw new Error(`blob upload failed: ${res.status} ${res.text}`);
		}
	}

	async download(hash: string, timeoutMs: number): Promise<ArrayBuffer> {
		const res = await withTimeout(
			requestUrl({
				url: this.url(`/${hash}`),
				method: "GET",
				headers: this.authHeaders(),
			}),
			timeoutMs,
			`blob download ${hash.slice(0, 12)}…`,
		);
		if (res.status !== 200) {
			throw new Error(`blob download failed: ${res.status} ${res.text}`);
		}
		return res.arrayBuffer;
	}

	async exists(hashes: string[]): Promise<string[]> {
		const res = await withTimeout(
			requestUrl({
				url: this.url("/exists"),
				method: "POST",
				contentType: "application/json",
				headers: this.authHeaders(),
				body: JSON.stringify({ hashes }),
			}),
			EXISTS_TIMEOUT_MS,
			`blob exists (${hashes.length})`,
		);
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

function isAlreadyExistsError(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		if (code === "EEXIST") return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return message.toLowerCase().includes("exists");
}

function hashPrefix(hash: string | null | undefined): string | null {
	return typeof hash === "string" ? hash.slice(0, 12) : null;
}

function conflictPathFor(path: string, date = new Date()): string {
	const normalized = normalizePath(path);
	const slash = normalized.lastIndexOf("/");
	const dir = slash >= 0 ? normalized.slice(0, slash + 1) : "";
	const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
	const dot = name.lastIndexOf(".");
	const stamp = date
		.toISOString()
		.replace(/\.\d{3}Z$/, "Z")
		.replace(/[:]/g, "-");
	const suffix = ` (YAOS remote conflict ${stamp})`;
	const ext = dot > 0 ? name.slice(dot) : "";
	const base = dot > 0 ? name.slice(0, dot) : name;
	// Cap base name to prevent filesystem path length issues (255 byte limit)
	const maxBase = Math.max(20, 255 - suffix.length - ext.length - 4);
	const cappedBase = base.length > maxBase ? base.slice(0, maxBase) : base;
	return `${dir}${cappedBase}${suffix}${ext}`;
}

function isBlobConflictArtifactPath(path: string): boolean {
	const normalized = normalizePath(path);
	const name = normalized.split("/").pop() ?? normalized;
	return /^.+ \(YAOS remote conflict \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\)(?:\.[^/.]+)?$/.test(name);
}

// -------------------------------------------------------------------
// Queue item types
// -------------------------------------------------------------------

interface UploadItem {
	path: string;
	sizeBytes?: number;
	retries: number;
	status: "pending" | "processing";
	readyAt: number;
	needsRerun?: boolean;
	/** How many times this item has been reset via needsRerun. Capped at MAX_RERUN_RESETS. */
	rerunResets: number;
}

interface DownloadItem {
	path: string;
	hash: string;
	sizeBytes?: number;
	retries: number;
	status: "pending" | "processing";
	readyAt: number;
	needsRerun?: boolean;
	/** How many times this item has been reset via needsRerun. Capped at MAX_RERUN_RESETS. */
	rerunResets: number;
}

/**
 * Serializable snapshot of pending queues.
 * Persisted to plugin data.json so in-flight transfers survive reloads.
 */
export interface BlobQueueSnapshot {
	uploads: {
		path: string;
		sizeBytes?: number;
		retries?: number;
		status?: "pending" | "processing";
		readyAt?: number;
		needsRerun?: boolean;
		rerunResets?: number;
	}[];
	downloads: {
		path: string;
		hash: string;
		sizeBytes?: number;
		retries?: number;
		status?: "pending" | "processing";
		readyAt?: number;
		needsRerun?: boolean;
		rerunResets?: number;
	}[];
}

// -------------------------------------------------------------------
// BlobSyncManager
// -------------------------------------------------------------------

export class BlobSyncManager {
	private blobClient: BlobHttpClient;

	/** Pending uploads keyed by path (deduped). */
	private uploadQueue = new Map<string, UploadItem>();
	/** Pending downloads keyed by path (deduped). */
	private downloadQueue = new Map<string, DownloadItem>();
	private readonly forcedDownloadWaiters = new Map<string, Array<{
		hash: string;
		resolve: () => void;
		reject: (error: Error) => void;
	}>>();

	/** Debounce timers for upload scheduling (keyed by path). */
	private uploadDebounce = new Map<string, number>();

	/** Paths currently uploading. */
	private inflightUploads = new Set<string>();
	/** Paths currently downloading. */
	private inflightDownloads = new Set<string>();
	/** Retry timers for failed transfers. */
	private retryTimers = new Set<number>();
	/** True while upload drain is running. */
	private uploadDraining = false;
	/** True while download drain is running. */
	private downloadDraining = false;
	/** Blocks startup-time download execution until the local vault model is ready. */
	private downloadGateOpen = false;

	/** Path suppression to prevent upload-on-own-download loops. */
	private suppressedPaths = new Map<string, number>();

	/** Completed transfer counts (reset each reconcile cycle). */
	private _completedUploads = 0;
	private _completedDownloads = 0;
	/** Total transfers queued in the current batch (for N/M display). */
	private _totalUploadsThisCycle = 0;
	private _totalDownloadsThisCycle = 0;
	/** Permanent failure counters (never reset — lifetime of plugin session). */
	private _permanentUploadFailures = 0;
	private _permanentDownloadFailures = 0;
	/** Local-only conflict artifact counter (never reset — lifetime of plugin session). */
	private _blobConflictArtifacts = 0;
	private localOnlyBlobConflictPaths = new Set<string>();
	private remoteDeleteInFlight = new Set<string>();
	private readonly quarantinedInvalidPaths = new Map<string, string>();

	/** CRDT map observer cleanup functions. */
	private observerCleanups: (() => void)[] = [];

	/**
	 * Paths where a remote-delete was received but no known hash baseline was
	 * available to verify local state. These files were preserved on disk but
	 * must NOT be auto-uploaded or have their tombstones cleared by later
	 * scan/upload/import passes.
	 *
	 * Cleared when the user explicitly modifies the file (non-suppressed vault
	 * event), deletes the file locally, or a future remote-delete arrives with
	 * a real baseline hash.
	 */
	private preservedUnresolved: PreservedUnresolvedRegistry;
	readonly preservedUnresolvedPaths: ReadonlySet<string>;

	private readonly maxConcurrency: number;
	private readonly maxSize: number;
	private readonly debug: boolean;
	private readonly excludePatterns: readonly string[];

	/** External blob hash cache (owned by main.ts, persisted to data.json). */
	private hashCache: BlobHashCache;

	constructor(
		private app: App,
		private attachmentCatalog: AttachmentCatalogPort,
		settings: {
			host: string;
			deviceToken: string;
			vaultId: string;
			maxAttachmentSizeKB: number;
			attachmentConcurrency: number;
			debug: boolean;
			excludePatterns?: readonly string[];
			trace?: TraceHttpContext;
		},
		hashCache: BlobHashCache,
		private trace?: TraceRecord,
		initialPreservedUnresolved: PreservedUnresolvedEntry[] = [],
		private onPreservedUnresolvedChanged?: () => void,
		private recordFlightPathEvent?: (event: ProductFlightPathEventInput) => void,
	) {
		this.blobClient = new BlobHttpClient(
			settings.host,
			settings.deviceToken,
			settings.vaultId,
			settings.trace,
		);
		this.maxConcurrency = settings.attachmentConcurrency;
		this.maxSize = settings.maxAttachmentSizeKB * 1024;
		this.debug = settings.debug;
		this.excludePatterns = settings.excludePatterns ?? [];
		this.hashCache = hashCache;
		this.preservedUnresolved = new PreservedUnresolvedRegistry(
			initialPreservedUnresolved.filter((entry) => entry.kind === "blob"),
		);
		this.preservedUnresolvedPaths = this.preservedUnresolved.paths;
	}

	// -------------------------------------------------------------------
	// Durable catalog observer (remote changes → disk work)
	// -------------------------------------------------------------------

	startObservers(): void {
		const cleanup = this.attachmentCatalog.observeAttachmentChanges((change) => {
			if (change.local) return;
			if (change.kind === "upsert") {
				const path = this.validateBlobPath(change.path, "remote-catalog-upsert", change.ref);
				if (!path) return;
				this.log(
					`observer: remote blob ref for "${path}" hash=${change.ref.hash.slice(0, 12)}…`,
				);
				this.recordAttachmentEvent(
					PRODUCT_EVENT_KIND.attachmentDownloadDecision,
					path,
					"info",
					"important",
					{ decision: "queue-remote-upsert", hashPrefix: hashPrefix(change.ref.hash), sizeBytes: change.ref.size },
				);
				this.scheduleDownload(path, change.ref.hash, change.ref.size);
				return;
			}
			const path = this.validateBlobPath(change.path, "remote-catalog-tombstone");
			if (!path || (change.previousHash !== null && !/^[a-f0-9]{64}$/.test(change.previousHash))) {
				if (path) this.validateBlobPath(change.path, "remote-tombstone-hash", { hash: change.previousHash ?? "", size: 0 });
				return;
			}
			void this.handleRemoteDelete(path, change.previousHash);
			this.recordAttachmentEvent(
				PRODUCT_EVENT_KIND.deleteRemoteObserved,
				path,
				"info",
				"critical",
				{ subject: "attachment", previousHashPrefix: hashPrefix(change.previousHash) },
			);
		});
		this.observerCleanups.push(cleanup);
		this.log("Blob observers started");
	}

	private recordAttachmentEvent(
		kind: ProductEventKind,
		path: string,
		severity: ProductFlightPathEventInput["severity"],
		priority: ProductFlightPathEventInput["priority"],
		data: Record<string, unknown>,
	): void {
		this.recordFlightPathEvent?.({
			kind,
			path,
			severity,
			priority,
			scope: "file",
			source: "blobSync",
			layer: "blob",
			data,
		});
	}

	private validateBlobPath(
		path: string,
		context: string,
		ref?: BlobRef,
	): string | null {
		const canonical = safeBlobPath(path, this.excludePatterns, this.app.vault.configDir, ref);
		if (
			canonical &&
			(!ref || this.maxSize <= 0 || ref.size <= this.maxSize)
		) return canonical;
		if (this.quarantinedInvalidPaths.size >= 1_000 && !this.quarantinedInvalidPaths.has(path)) {
			const oldest = this.quarantinedInvalidPaths.keys().next().value as string | undefined;
			if (oldest !== undefined) this.quarantinedInvalidPaths.delete(oldest);
		}
		this.quarantinedInvalidPaths.set(path, context);
		this.trace?.("blob", "invalid-path-quarantined", {
			context,
			pathLength: path.length,
			hashPrefix: ref?.hash.slice(0, 12) ?? null,
			sizeBytes: ref?.size ?? null,
		});
		this.log(`Attachment catalog entry quarantined (${context})`);
		return null;
	}

	private enqueueUpload(path: string, retries = 0, sizeBytes?: number): void {
		const canonical = this.validateBlobPath(path, "upload-queue");
		if (!canonical) return;
		path = canonical;
		const existing = this.uploadQueue.get(path);
		if (existing) {
			if (sizeBytes && sizeBytes > 0) existing.sizeBytes = sizeBytes;
			existing.retries = Math.min(existing.retries, retries);
			existing.readyAt = 0;
			if (existing.status === "processing") {
				existing.needsRerun = true;
			} else {
				existing.status = "pending";
			}
			return;
		}

		this.uploadQueue.set(path, {
			path,
			sizeBytes,
			retries,
			status: "pending",
			readyAt: 0,
			rerunResets: 0,
		});
	}

	private enqueueDownload(
		path: string,
		hash: string,
		sizeBytes?: number,
		retries = 0,
	): void {
		const canonical = this.validateBlobPath(path, "download-queue", { hash, size: sizeBytes ?? 0 });
		if (!canonical) return;
		path = canonical;
		const existing = this.downloadQueue.get(path);
		if (existing) {
			existing.hash = hash;
			if (sizeBytes && sizeBytes > 0) existing.sizeBytes = sizeBytes;
			existing.retries = Math.min(existing.retries, retries);
			existing.readyAt = 0;
			if (existing.status === "processing") {
				existing.needsRerun = true;
			} else {
				existing.status = "pending";
			}
			return;
		}

		this.downloadQueue.set(path, {
			path,
			hash,
			sizeBytes,
			retries,
			status: "pending",
			readyAt: 0,
			rerunResets: 0,
		});
	}

	// -------------------------------------------------------------------
	// Public event handlers (called from main.ts vault events)
	// -------------------------------------------------------------------

	/**
	 * Handle a local file create/modify for a blob-syncable file.
	 * Debounces and queues upload.
	 */
	handleFileChange(file: TFile): void {
		if (!this.validateBlobPath(file.path, "local-file-change")) return;
		if (
			this.localOnlyBlobConflictPaths.has(file.path) ||
			isBlobConflictArtifactPath(file.path)
		) {
			this.log(`handleFileChange: local-only blob conflict "${file.path}"`);
			return;
		}

		if (this.isSuppressed(file.path)) {
			this.log(`handleFileChange: suppressed "${file.path}"`);
			return;
		}

		// If the user explicitly modifies a preserved-unresolved file, that
		// constitutes intentional user action. Clear the guard and allow upload.
		if (this.preservedUnresolvedPaths.has(file.path)) {
			if (this.preservedUnresolved.resolve(file.path)) {
				this.onPreservedUnresolvedChanged?.();
			}
			this.trace?.("blob", "preserved-unresolved-cleared", {
				path: file.path,
				reason: "user-modify-event",
			});
			this.log(
				`handleFileChange: cleared preserved-unresolved for "${file.path}" (user modify)`,
			);
		}

		// Clear existing debounce
		const existing = this.uploadDebounce.get(file.path);
		if (existing) window.clearTimeout(existing);

		this.uploadDebounce.set(
			file.path,
			window.setTimeout(() => {
				this.uploadDebounce.delete(file.path);
				this.enqueueUpload(file.path, 0, file.stat.size);
				this.kickUploadDrain();
			}, DEBOUNCE_MS),
		);
	}

	/**
	 * Handle a local file delete for a blob-syncable file.
	 */
	async handleFileDelete(path: string, device?: string): Promise<void> {
		const canonical = this.validateBlobPath(path, "local-file-delete");
		if (!canonical) return;
		path = canonical;
		// Cancel any pending upload
		const pendingUpload = this.uploadDebounce.get(path);
		if (pendingUpload) {
			window.clearTimeout(pendingUpload);
		}
		this.uploadDebounce.delete(path);
		this.uploadQueue.delete(path);

		// If user deletes a preserved-unresolved file, that resolves the conflict.
		if (this.preservedUnresolved.resolve(path)) {
			this.onPreservedUnresolvedChanged?.();
		}

		// Remove from hash cache
		removeCachedHash(this.hashCache, path);

		await this.attachmentCatalog.deleteAttachmentRef(path, device);
		this.recordAttachmentEvent(
			PRODUCT_EVENT_KIND.attachmentTombstoned,
			path,
			"info",
			"critical",
			{ device: device ?? null },
		);
	}

	async handleFileRename(oldPath: string, newPath: string): Promise<void> {
		const safeOldPath = this.validateBlobPath(oldPath, "local-file-rename-source");
		const safeNewPath = this.validateBlobPath(newPath, "local-file-rename-target");
		if (!safeOldPath || !safeNewPath) return;
		await this.attachmentCatalog.renameAttachmentRef(safeOldPath, safeNewPath);
		this.recordAttachmentEvent(
			PRODUCT_EVENT_KIND.attachmentRenamed,
			safeNewPath,
			"info",
			"important",
			{ fromPath: safeOldPath },
		);
	}
	/**
	 * Returns true if this path was preserved during a remote-delete because
	 * no hash baseline was available to verify local state.
	 */
	isPreservedUnresolved(path: string): boolean {
		return this.preservedUnresolvedPaths.has(path);
	}

	/**
	 * Clear the preserved-unresolved marker for a path.
	 * Called when a future remote-delete arrives with a real baseline hash.
	 */
	clearPreservedUnresolved(path: string): void {
		if (this.preservedUnresolved.resolve(path)) {
			this.onPreservedUnresolvedChanged?.();
			this.trace?.("blob", "preserved-unresolved-cleared", {
				path,
				reason: "baseline-now-available",
			});
		}
	}

	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[] {
		return this.preservedUnresolved.getEntries();
	}

	/**
	 * Reconcile blob files: compare disk blobs vs CRDT pathToBlob.
	 * Called during authoritative reconciliation.
	 *
	 * Returns: { uploadQueued, downloadQueued, skipped }
	 */
	reconcile(
		mode: "conservative" | "authoritative",
		excludePatterns: string[],
	): { uploadQueued: number; downloadQueued: number; skipped: number } {
		let uploadQueued = 0;
		let downloadQueued = 0;
		let skipped = 0;

		// Collect non-md, non-excluded disk files
		const diskBlobs = new Map<string, TFile>();
		for (const file of this.app.vault.getFiles()) {
			const canonical = safeBlobPath(file.path, excludePatterns, this.app.vault.configDir);
			if (!canonical || canonical !== file.path) continue;
			if (this.maxSize > 0 && file.stat.size > this.maxSize) continue;
			if (
				this.localOnlyBlobConflictPaths.has(file.path) ||
				isBlobConflictArtifactPath(file.path)
			) {
				skipped++;
				continue;
			}
			diskBlobs.set(canonical, file);
		}

		// Collect validated catalog blob paths (non-tombstoned).
		const crdtBlobPaths = new Set<string>();
		for (const [rawPath, ref] of this.attachmentCatalog.listAttachmentRefs()) {
			const path = this.validateBlobPath(rawPath, "reconcile-catalog", ref);
			if (!path) {
				skipped++;
				continue;
			}
			if (!this.attachmentCatalog.isAttachmentTombstoned(path)) crdtBlobPaths.add(path);
		}

		// CRDT blobs not on disk → schedule download
		for (const path of crdtBlobPaths) {
			if (diskBlobs.has(path)) continue;
			const ref = this.attachmentCatalog.getAttachmentRef(path);
			if (!ref || !this.validateBlobPath(path, "reconcile-download", ref)) {
				skipped++;
				continue;
			}
			this.scheduleDownload(path, ref.hash, ref.size);
			downloadQueued++;
		}

		// Disk blobs not in CRDT → schedule upload (authoritative only)
		// Disk blobs IN CRDT but with different hash → schedule upload (content changed offline)
		for (const [path, file] of diskBlobs) {
			// Check tombstone
			if (this.attachmentCatalog.isAttachmentTombstoned(path)) {
				skipped++;
				continue;
			}

			// Skip preserved-unresolved paths: these were preserved during a
			// remote-delete with unknown baseline and must not be auto-uploaded
			// until the user explicitly modifies them.
			if (this.preservedUnresolvedPaths.has(path)) {
				skipped++;
				continue;
			}

			if (crdtBlobPaths.has(path)) {
				// Both sides have this path — check for hash mismatch
				// (file was modified while offline, e.g. image edited externally)
				if (mode === "authoritative") {
					const ref = this.attachmentCatalog.getAttachmentRef(path);
					if (ref) {
						const fileStat = {
							mtime: file.stat.mtime,
							size: file.stat.size,
						};
						const cachedHash = getCachedHash(
							this.hashCache,
							path,
							fileStat,
						);

						if (cachedHash) {
							// Cache hit: compare hashes directly (no read needed)
							if (cachedHash !== ref.hash) {
								this.enqueueUpload(path, 0, file.stat.size);
								uploadQueued++;
							}
						} else if (ref.size !== file.stat.size) {
							// No cache, but size differs — definitely changed
							this.enqueueUpload(path, 0, file.stat.size);
							uploadQueued++;
						}
						// If sizes match and no cache, skip — processUpload will
						// do a full hash check if triggered by a future modify event
					}
				}
				continue;
			}

			if (mode === "authoritative") {
				this.enqueueUpload(path, 0, file.stat.size);
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
			const inFlight = new Set<Promise<void>>();
			while (true) {
				while (inFlight.size < this.maxConcurrency) {
					const item = this.nextPendingUpload();
					if (!item) break;
					item.status = "processing";
					this.inflightUploads.add(item.path);
					let p: Promise<void>;
					p = this.processUpload(item)
						.catch((err) => {
							console.error(
								`[yaos:blob] Unexpected upload failure for "${item.path}":`,
								err,
							);
						})
						.finally(() => {
							inFlight.delete(p);
							this.inflightUploads.delete(item.path);
						});
					inFlight.add(p);
				}

				if (inFlight.size === 0) {
					if (this.uploadQueue.size === 0) break;
					if (!this.hasPendingUploads()) return;
					// All items are waiting for retry timers to re-kick the drain.
					return;
				}

				await Promise.race(inFlight);
			}
		} finally {
			this.uploadDraining = false;
			if (this.hasPendingUploads()) this.kickUploadDrain();
		}
	}

	private async processUpload(item: UploadItem): Promise<void> {
		const start = Date.now();
		const normalized = this.validateBlobPath(item.path, "upload-before-disk-read");
		if (!normalized) {
			this.uploadQueue.delete(item.path);
			return;
		}
		this.log(
			`upload: started "${normalized}" (attempt ${item.retries + 1})`,
		);
		try {
			// Guard: do not upload preserved-unresolved paths or local-only
			// blob conflict artifacts. This can happen
			// if a queue snapshot was restored with a stale entry for a path
			// that was later guarded by conflict handling.
			if (
				this.localOnlyBlobConflictPaths.has(normalized) ||
				this.localOnlyBlobConflictPaths.has(item.path) ||
				isBlobConflictArtifactPath(normalized) ||
				isBlobConflictArtifactPath(item.path) ||
				this.preservedUnresolvedPaths.has(normalized) ||
				this.preservedUnresolvedPaths.has(item.path)
			) {
				this.uploadQueue.delete(item.path);
				const isLocalOnlyConflict =
					this.localOnlyBlobConflictPaths.has(normalized) ||
					this.localOnlyBlobConflictPaths.has(item.path) ||
					isBlobConflictArtifactPath(normalized) ||
					isBlobConflictArtifactPath(item.path);
				this.trace?.(
					"blob",
					isLocalOnlyConflict
						? "upload-skipped-local-guard"
						: "upload-skipped-preserved-unresolved",
					{
						path: normalized,
						reason: isLocalOnlyConflict
							? "local-only-conflict-artifact"
							: "preserved-unresolved",
					},
				);
				this.log(
					`upload: "${item.path}" is guarded local-only, skipping`,
				);
				return;
			}

			const file = this.app.vault.getAbstractFileByPath(normalized);
			if (!(file instanceof TFile)) {
				this.uploadQueue.delete(item.path);
				this.log(`upload: "${item.path}" no longer exists, skipping`);
				removeCachedHash(this.hashCache, item.path);
				return;
			}

			// Size guard
			if (this.maxSize > 0 && file.stat.size > this.maxSize) {
				this.uploadQueue.delete(item.path);
				this.log(
					`upload: "${item.path}" too large (${file.stat.size} bytes), skipping`,
				);
				return;
			}
			item.sizeBytes = file.stat.size;

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
			const existingRef = this.attachmentCatalog.getAttachmentRef(item.path);
			if (existingRef && existingRef.hash === hash) {
				if (item.needsRerun) {
					item.needsRerun = false;
					item.status = "pending";
					item.retries = 0;
					item.readyAt = 0;
					this.log(
						`upload: "${item.path}" unchanged on this pass; running queued rerun`,
					);
					this.kickUploadDrain();
				} else {
					this.uploadQueue.delete(item.path);
					this.log(
						`upload: "${item.path}" unchanged (hash match), skipping`,
					);
				}
				return;
			}

			// Check if R2 already has this blob (content-addressed dedup)
			const present = await this.blobClient.exists([hash]);
			if (!present.includes(hash)) {
				// Need actual bytes for upload — read if we used cache
				if (!data) {
					data = await this.app.vault.readBinary(file);
				}

				// Upload through the Worker
				const mime = guessMime(item.path);
				const uploadTimeoutMs = transferTimeoutMs(item.sizeBytes);
				await this.blobClient.upload(hash, mime, data, uploadTimeoutMs);

				this.log(
					`upload: "${item.path}" uploaded (${data.byteLength} bytes)`,
				);
			} else {
				this.log(
					`upload: "${item.path}" already in R2 (dedup), updating CRDT only`,
				);
				this.recordAttachmentEvent(
					PRODUCT_EVENT_KIND.attachmentUploadDecision,
					item.path,
					"info",
					"important",
					{ decision: "deduplicated", hashPrefix: hashPrefix(hash), sizeBytes: file.stat.size },
				);
			}

			// Two-phase commit: update CRDT only after successful upload
			const mime = guessMime(item.path);
			await this.attachmentCatalog.setAttachmentRef(item.path, hash, file.stat.size, mime);
			this.recordAttachmentEvent(
				PRODUCT_EVENT_KIND.attachmentUploadComplete,
				item.path,
				"info",
				"important",
				{ hashPrefix: hashPrefix(hash), sizeBytes: file.stat.size, deduplicated: present.includes(hash) },
			);
			this._completedUploads++;
			if (item.needsRerun) {
				item.needsRerun = false;
				item.status = "pending";
				item.retries = 0;
				item.readyAt = 0;
				this.log(
					`upload: success "${item.path}" in ${Date.now() - start}ms (queued rerun)`,
				);
				this.kickUploadDrain();
			} else {
				this.uploadQueue.delete(item.path);
				this.log(
					`upload: success "${item.path}" in ${Date.now() - start}ms`,
				);
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (item.retries < MAX_RETRIES) {
				const delay = RETRY_BASE_MS * Math.pow(4, item.retries);
				this.log(
					`upload: failed "${item.path}" in ${Date.now() - start}ms ` +
						`(attempt ${item.retries + 1}): ${reason}; retrying in ${delay}ms`,
				);
				item.retries++;
				item.status = "pending";
				item.readyAt = Date.now() + delay;
				this.scheduleRetryKick(delay, "upload");
			} else {
				if (item.needsRerun && item.rerunResets < MAX_RERUN_RESETS) {
					item.needsRerun = false;
					item.status = "pending";
					item.retries = 0;
					item.readyAt = 0;
					item.rerunResets++;
					this.log(
						`upload: "${item.path}" had pending rerun (reset ${item.rerunResets}/${MAX_RERUN_RESETS}); restarting fresh`,
					);
					this.kickUploadDrain();
					return;
				}
				this.uploadQueue.delete(item.path);
				this._permanentUploadFailures++;
				this.trace?.("blob", "upload-permanently-failed", {
					path: item.path,
					retries: item.retries,
					error: err instanceof Error ? err.message : String(err),
					totalPermanentFailures: this._permanentUploadFailures,
				});
				console.error(
					`[yaos:blob] Upload failed permanently for "${item.path}":`,
					err,
				);
			}
		}
	}

	private nextPendingUpload(): UploadItem | null {
		const now = Date.now();
		for (const item of this.uploadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return item;
		}
		return null;
	}

	private hasPendingUploads(): boolean {
		const now = Date.now();
		for (const item of this.uploadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return true;
		}
		return false;
	}

	// -------------------------------------------------------------------
	// Download drain
	// -------------------------------------------------------------------

	private scheduleDownload(
		path: string,
		hash: string,
		sizeBytes?: number,
	): void {
		this.enqueueDownload(path, hash, sizeBytes);
		this.kickDownloadDrain();
	}

	/**
	 * Schedule high-priority downloads for paths that are needed now
	 * (e.g. attachments embedded in the currently-open note).
	 * Skips paths already on disk or already queued.
	 */
	prioritizeDownloads(paths: string[]): number {
		let queued = 0;
		for (const rawPath of paths) {
			const ref = this.attachmentCatalog.getAttachmentRef(rawPath);
			const path = ref ? this.validateBlobPath(rawPath, "prioritized-download", ref) : null;
			if (!ref || !path || this.downloadQueue.has(path)) continue;
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) continue;
			if (this.attachmentCatalog.isAttachmentTombstoned(path)) continue;
			this.enqueueDownload(path, ref.hash, ref.size);
			queued++;
		}

		if (queued > 0) {
			this.log(
				`prioritizeDownloads: queued ${queued} prefetch downloads`,
			);
			this.kickDownloadDrain();
		}
		return queued;
	}

	/**
	 * Recovery-only download: ignores an existing disk replica, waits until the
	 * selected snapshot bytes are durably written, and fails on any conflict.
	 */
	async forceDownloads(paths: string[]): Promise<number> {
		const pending: Promise<void>[] = [];
		this.openDownloadGate("recovery-restore");
		let queued = 0;
		for (const rawPath of new Set(paths)) {
			const ref = this.attachmentCatalog.getAttachmentRef(rawPath);
			const path = ref ? this.validateBlobPath(rawPath, "forced-recovery-download", ref) : null;
			if (!path || !ref || this.attachmentCatalog.isAttachmentTombstoned(path)) {
				throw new Error(`attachment recovery target is unavailable: ${rawPath}`);
			}
			pending.push(new Promise<void>((resolve, reject) => {
				const waiters = this.forcedDownloadWaiters.get(path) ?? [];
				waiters.push({ hash: ref.hash, resolve, reject });
				this.forcedDownloadWaiters.set(path, waiters);
			}));
			this.enqueueDownload(path, ref.hash, ref.size);
			queued++;
		}
		if (queued === 0) return 0;
		this.kickDownloadDrain();
		await Promise.all(pending);
		return queued;
	}

	private settleForcedDownload(path: string, hash: string, error?: Error): void {
		const waiters = this.forcedDownloadWaiters.get(path);
		if (!waiters) return;
		const remaining = waiters.filter((waiter) => waiter.hash !== hash);
		for (const waiter of waiters) {
			if (waiter.hash !== hash) continue;
			if (error) waiter.reject(error);
			else waiter.resolve();
		}
		if (remaining.length > 0) this.forcedDownloadWaiters.set(path, remaining);
		else this.forcedDownloadWaiters.delete(path);
	}

	private kickDownloadDrain(): void {
		if (!this.downloadGateOpen) return;
		if (this.downloadDraining) return;
		void this.drainDownloads();
	}

	private async drainDownloads(): Promise<void> {
		this.downloadDraining = true;
		try {
			const inFlight = new Set<Promise<void>>();
			while (true) {
				while (inFlight.size < this.maxConcurrency) {
					const item = this.nextPendingDownload();
					if (!item) break;
					item.status = "processing";
					this.inflightDownloads.add(item.path);
					let p: Promise<void>;
					p = this.processDownload(item)
						.catch((err) => {
							console.error(
								`[yaos:blob] Unexpected download failure for "${item.path}":`,
								err,
							);
						})
						.finally(() => {
							inFlight.delete(p);
							this.inflightDownloads.delete(item.path);
						});
					inFlight.add(p);
				}

				if (inFlight.size === 0) {
					if (this.downloadQueue.size === 0) break;
					if (!this.hasPendingDownloads()) return;
					// All items are waiting for retry timers to re-kick the drain.
					return;
				}

				await Promise.race(inFlight);
			}
		} finally {
			this.downloadDraining = false;
			if (this.hasPendingDownloads()) this.kickDownloadDrain();
		}
	}

	private async processDownload(item: DownloadItem): Promise<void> {
		const start = Date.now();
		const catalogRef = this.attachmentCatalog.getAttachmentRef(item.path);
		const normalized = catalogRef
			? this.validateBlobPath(item.path, "download-before-read", catalogRef)
			: null;
		if (
			!catalogRef ||
			!normalized ||
			this.attachmentCatalog.isAttachmentTombstoned(normalized) ||
			catalogRef.hash !== item.hash
		) {
			this.downloadQueue.delete(item.path);
			this.settleForcedDownload(item.path, item.hash, new Error("attachment recovery target changed before download"));
			return;
		}
		item.sizeBytes = catalogRef.size;
		const forced = this.forcedDownloadWaiters.get(item.path)?.some((waiter) => waiter.hash === item.hash) === true;
		this.log(
			`download: started "${normalized}" (attempt ${item.retries + 1})`,
		);
		try {
			// Check if file already exists with matching hash
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			let diskHashBefore: string | null = null;
			if (existing instanceof TFile) {
				// Try hash cache first
				const fileStat = {
					mtime: existing.stat.mtime,
					size: existing.stat.size,
				};
				let diskHash = forced
					? null
					: getCachedHash(this.hashCache, item.path, fileStat);

				if (!diskHash) {
					try {
						const data = await this.app.vault.readBinary(existing);
						diskHash = await hashArrayBuffer(data);
						setCachedHash(
							this.hashCache,
							item.path,
							fileStat,
							diskHash,
						);
					} catch {
						// Can't read — download anyway
					}
				}
				diskHashBefore = diskHash ?? null;

				if (diskHash === item.hash) {
					this.downloadQueue.delete(item.path);
					this.settleForcedDownload(item.path, item.hash);
					this.log(
						`download: "${item.path}" already matches, skipping`,
					);
					this.trace?.("blob", "download-overwrite-decision", {
						path: item.path,
						hashPrefix: hashPrefix(item.hash),
						diskHashBeforePrefix: hashPrefix(diskHashBefore),
						action: "skip-existing-match",
						sizeBytes: item.sizeBytes ?? null,
					});
					return;
				}
			}

			const downloadTimeoutMs = transferTimeoutMs(item.sizeBytes);
			const data = await this.blobClient.download(
				item.hash,
				downloadTimeoutMs,
			);
			let targetHasRemoteBytes = false;

			// Verify hash of downloaded data
			const downloadHash = await hashArrayBuffer(data);
			if (downloadHash !== item.hash) {
				this.recordAttachmentEvent(
					PRODUCT_EVENT_KIND.attachmentIntegrityFailed,
					item.path,
					"error",
					"critical",
					{ expectedHashPrefix: hashPrefix(item.hash), actualHashPrefix: hashPrefix(downloadHash) },
				);
				throw new Error(
					`Hash mismatch: expected ${item.hash.slice(0, 12)}… got ${downloadHash.slice(0, 12)}…`,
				);
			}

			const currentRef = this.attachmentCatalog.getAttachmentRef(normalized);
			if (
				!currentRef ||
				!this.validateBlobPath(normalized, "download-before-disk-write", currentRef) ||
				this.attachmentCatalog.isAttachmentTombstoned(normalized) ||
				currentRef.hash !== item.hash ||
				currentRef.size !== data.byteLength
			) {
				this.downloadQueue.delete(item.path);
				this.settleForcedDownload(item.path, item.hash, new Error("attachment recovery target changed during download"));
				this.trace?.("blob", "download-target-changed-quarantined", {
					hashPrefix: hashPrefix(item.hash),
					sizeBytes: data.byteLength,
				});
				return;
			}

			// Suppress path to prevent re-upload from vault event
			this.suppress(item.path);

			// Write to disk
			if (existing instanceof TFile) {
				const diskHashAfterDownload = await this.hashExistingFile(
					existing,
					item.path,
				);
				if (
					diskHashBefore !== null &&
					diskHashAfterDownload !== null &&
					diskHashAfterDownload !== diskHashBefore
				) {
					const conflictPath =
						await this.writeDownloadConflictArtifact(
							normalized,
							data,
							"existing-changed-during-download",
						);
					this.trace?.("blob", "download-conflict-quarantined", {
						path: item.path,
						conflictPath,
						hashPrefix: hashPrefix(item.hash),
						diskHashBeforePrefix: hashPrefix(diskHashBefore),
						diskHashAfterPrefix: hashPrefix(diskHashAfterDownload),
						reason: "existing-changed-during-download",
						sizeBytes: data.byteLength,
					});
					this.log(
						`download: conflict artifact "${conflictPath}" for "${item.path}" ` +
							`(local file changed during download)`,
					);
				} else {
					this.trace?.("blob", "download-overwrite-decision", {
						path: item.path,
						hashPrefix: hashPrefix(item.hash),
						diskHashBeforePrefix: hashPrefix(diskHashBefore),
						diskHashAfterPrefix: hashPrefix(diskHashAfterDownload),
						action: "overwrite-existing",
						sizeBytes: data.byteLength,
					});
					if (!this.validateBlobPath(existing.path, "download-immediate-before-modify", currentRef)) {
						throw new Error("unsafe attachment modify path");
					}
					await this.app.vault.modifyBinary(existing, data);
					targetHasRemoteBytes = true;
					this.log(
						`download: updated "${item.path}" (${data.byteLength} bytes) in ${Date.now() - start}ms`,
					);
				}
			} else {
				this.trace?.("blob", "download-overwrite-decision", {
					path: item.path,
					hashPrefix: hashPrefix(item.hash),
					diskHashBeforePrefix: null,
					action: "create-missing",
					sizeBytes: data.byteLength,
				});
				// Ensure parent directory exists
				const dir = normalized.substring(
					0,
					normalized.lastIndexOf("/"),
				);
				if (dir) {
					const dirExists = this.app.vault.getAbstractFileByPath(
						normalizePath(dir),
					);
					if (!dirExists) {
						try {
							await this.app.vault.createFolder(dir);
						} catch (err) {
							if (!isAlreadyExistsError(err)) throw err;
						}
					}
				}
				try {
					if (!this.validateBlobPath(normalized, "download-immediate-before-create", currentRef)) {
						throw new Error("unsafe attachment create path");
					}
					await this.app.vault.createBinary(normalized, data);
					targetHasRemoteBytes = true;
					this.log(
						`download: created "${item.path}" (${data.byteLength} bytes) in ${Date.now() - start}ms`,
					);
				} catch (err) {
					if (!isAlreadyExistsError(err)) throw err;
					const resolved =
						this.app.vault.getAbstractFileByPath(normalized);
					if (!(resolved instanceof TFile)) throw err;

					const fileStat = {
						mtime: resolved.stat.mtime,
						size: resolved.stat.size,
					};
					let diskHash = getCachedHash(
						this.hashCache,
						item.path,
						fileStat,
					);
					if (!diskHash) {
						const existingData =
							await this.app.vault.readBinary(resolved);
						diskHash = await hashArrayBuffer(existingData);
						setCachedHash(
							this.hashCache,
							item.path,
							fileStat,
							diskHash,
						);
					}

					if (diskHash === item.hash) {
						this.trace?.("blob", "download-overwrite-decision", {
							path: item.path,
							hashPrefix: hashPrefix(item.hash),
							diskHashBeforePrefix: hashPrefix(diskHash),
							action: "skip-create-race-match",
							sizeBytes: data.byteLength,
						});
						this.log(
							`download: "${item.path}" already matches after create race, skipping ` +
								`in ${Date.now() - start}ms`,
						);
						targetHasRemoteBytes = true;
					} else {
						const conflictPath =
							await this.writeDownloadConflictArtifact(
								normalized,
								data,
								"create-race-mismatch",
							);
						this.trace?.("blob", "download-conflict-quarantined", {
							path: item.path,
							conflictPath,
							hashPrefix: hashPrefix(item.hash),
							diskHashBeforePrefix: hashPrefix(diskHash),
							reason: "create-race-mismatch",
							sizeBytes: data.byteLength,
						});
						this.log(
							`download: conflict artifact "${conflictPath}" after create race for "${item.path}" ` +
								`(${data.byteLength} bytes) in ${Date.now() - start}ms`,
						);
					}
				}
			}

			// Update hash cache with the freshly-written file's hash.
			// Use stat from disk to get the actual mtime the OS assigned.
			if (targetHasRemoteBytes) {
				try {
					const freshStat =
						await this.app.vault.adapter.stat(normalized);
					if (freshStat) {
						setCachedHash(
							this.hashCache,
							item.path,
							{ mtime: freshStat.mtime, size: freshStat.size },
							item.hash,
						);
					}
				} catch {
					/* stat failed, cache will miss next time — fine */
				}
			}

			const forcedAtCompletion = this.forcedDownloadWaiters.get(item.path)?.some((waiter) => waiter.hash === item.hash) === true;
			if (forcedAtCompletion && !targetHasRemoteBytes) {
				this.downloadQueue.delete(item.path);
				this.settleForcedDownload(item.path, item.hash, new Error("attachment recovery conflicted with a local disk change"));
				return;
			}
			if (forcedAtCompletion) this.settleForcedDownload(item.path, item.hash);
			this._completedDownloads++;
			this.recordAttachmentEvent(
				PRODUCT_EVENT_KIND.attachmentDownloadComplete,
				item.path,
				"info",
				"important",
				{ hashPrefix: hashPrefix(item.hash), sizeBytes: data.byteLength, wroteTarget: targetHasRemoteBytes },
			);
			if (item.needsRerun) {
				item.needsRerun = false;
				item.status = "pending";
				item.retries = 0;
				item.readyAt = 0;
				this.log(
					`download: success "${item.path}" in ${Date.now() - start}ms (queued rerun)`,
				);
				this.kickDownloadDrain();
			} else {
				this.downloadQueue.delete(item.path);
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (item.retries < MAX_RETRIES) {
				const delay = RETRY_BASE_MS * Math.pow(4, item.retries);
				this.log(
					`download: failed "${item.path}" in ${Date.now() - start}ms ` +
						`(attempt ${item.retries + 1}): ${reason}; retrying in ${delay}ms`,
				);
				item.retries++;
				item.status = "pending";
				item.readyAt = Date.now() + delay;
				this.scheduleRetryKick(delay, "download");
			} else {
				if (item.needsRerun && item.rerunResets < MAX_RERUN_RESETS) {
					item.needsRerun = false;
					item.status = "pending";
					item.retries = 0;
					item.readyAt = 0;
					item.rerunResets++;
					this.log(
						`download: "${item.path}" had pending rerun (reset ${item.rerunResets}/${MAX_RERUN_RESETS}); restarting fresh`,
					);
					this.kickDownloadDrain();
					return;
				}
				this.downloadQueue.delete(item.path);
				this._permanentDownloadFailures++;
				this.settleForcedDownload(item.path, item.hash, new Error(`attachment recovery download failed: ${reason}`));
				this.trace?.("blob", "download-permanently-failed", {
					path: item.path,
					retries: item.retries,
					error: err instanceof Error ? err.message : String(err),
					totalPermanentFailures: this._permanentDownloadFailures,
				});
				console.error(
					`[yaos:blob] Download failed permanently for "${item.path}":`,
					err,
				);
			}
		}
	}

	private async hashExistingFile(
		file: TFile,
		path: string,
	): Promise<string | null> {
		const fileStat = { mtime: file.stat.mtime, size: file.stat.size };
		const cachedHash = getCachedHash(this.hashCache, path, fileStat);
		if (cachedHash) return cachedHash;
		try {
			const data = await this.app.vault.readBinary(file);
			const hash = await hashArrayBuffer(data);
			setCachedHash(this.hashCache, path, fileStat, hash);
			return hash;
		} catch {
			return null;
		}
	}

	/**
	 * Write remote blob bytes to a conflict artifact instead of overwriting the
	 * target file.
	 *
	 * Policy: blob conflict artifacts are LOCAL-ONLY safety artifacts. They are
	 * suppressed from upload so they do not sync back to the server or other
	 * devices. This is intentional — the artifact exists only to preserve remote
	 * bytes that could not safely overwrite the local file. The user can inspect,
	 * rename, or delete the artifact. If they want the remote version to sync,
	 * they should replace the original file manually.
	 *
	 * Markdown conflicts are handled by the canonical document pipeline, while
	 * blob conflicts preserve raw binary bytes racing with a local file change.
	 */
	private async writeDownloadConflictArtifact(
		targetPath: string,
		data: ArrayBuffer,
		reason: "existing-changed-during-download" | "create-race-mismatch",
	): Promise<string> {
		const baseConflictPath = conflictPathFor(targetPath);
		for (let i = 0; i < 100; i++) {
			const conflictPath =
				i === 0
					? baseConflictPath
					: baseConflictPath.replace(/(\.[^/.]+)?$/, ` ${i + 1}$1`);
			if (this.app.vault.getAbstractFileByPath(conflictPath)) continue;
			try {
				this.suppress(conflictPath);
				if (!this.validateBlobPath(conflictPath, "conflict-immediate-before-create")) {
					throw new Error("unsafe attachment conflict path");
				}
				await this.app.vault.createBinary(conflictPath, data);
				this.localOnlyBlobConflictPaths.add(conflictPath);
				const freshStat =
					await this.app.vault.adapter.stat(conflictPath);
				if (freshStat) {
					const hash = await hashArrayBuffer(data);
					setCachedHash(
						this.hashCache,
						conflictPath,
						{ mtime: freshStat.mtime, size: freshStat.size },
						hash,
					);
				}
				this._blobConflictArtifacts++;
				// Notify the user — blob conflict artifacts are local-only
				// and will NOT sync to other devices.
				try {
					new Notice(
						`YAOS: Local-only attachment conflict preserved — "${conflictPath.split("/").pop()}" (this device only)`,
						8000,
					);
				} catch {
					// Notice may fail in testing or headless environments.
				}
				return conflictPath;
			} catch (err) {
				if (isAlreadyExistsError(err)) continue;
				throw err;
			}
		}
		throw new Error(
			`could not create blob conflict artifact for ${reason}`,
		);
	}

	private nextPendingDownload(): DownloadItem | null {
		const now = Date.now();
		for (const item of this.downloadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return item;
		}
		return null;
	}

	private hasPendingDownloads(): boolean {
		const now = Date.now();
		for (const item of this.downloadQueue.values()) {
			if (item.status === "pending" && item.readyAt <= now) return true;
		}
		return false;
	}

	// -------------------------------------------------------------------
	// Remote delete handler
	// -------------------------------------------------------------------

	private async handleRemoteDelete(
		path: string,
		knownHash: string | null,
	): Promise<void> {
		const normalized = this.validateBlobPath(path, "remote-delete-before-lookup");
		if (!normalized || (knownHash !== null && !/^[a-f0-9]{64}$/.test(knownHash))) return;
		if (this.remoteDeleteInFlight.has(normalized) && !knownHash) {
			this.trace?.("blob", "remote-delete-duplicate-ignored", {
				path: normalized,
				reason: "unknown-baseline-handler-already-in-flight",
			});
			return;
		}
		this.remoteDeleteInFlight.add(normalized);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) {
			this.remoteDeleteInFlight.delete(normalized);
			return;
		}
		if (file instanceof TFile) {
			try {
				// Remote delete decision: three-way typed decision avoids
				// conflating "known dirty" with "unknown baseline".
				let decision: BlobRemoteDeleteDecision = {
					kind: "apply-delete",
				};
				let unresolvedReason: PreservedUnresolvedReason | null = null;

				if (knownHash) {
					try {
						const fileStat =
							await this.app.vault.adapter.stat(normalized);
						if (fileStat) {
							let localHash = getCachedHash(
								this.hashCache,
								normalized,
								fileStat,
							);
							if (!localHash) {
								try {
									const data = await this.app.vault.readBinary(file);
									localHash = await hashArrayBuffer(data);
									setCachedHash(
										this.hashCache,
										normalized,
										{
											mtime: fileStat.mtime,
											size: fileStat.size,
										},
										localHash,
									);
								} catch {
									decision = { kind: "preserve-unresolved" };
									unresolvedReason = "remote-delete-hash-read-failed";
									this.trace?.(
										"blob",
										"remote-delete-conflict-preserved",
										{
											path: normalized,
											knownHash: knownHash?.slice(0, 12) ?? null,
											reason: "read-failed-cannot-verify",
										},
									);
									this.log(
										`handleRemoteDelete: preserved "${normalized}" (read failed — cannot verify local state)`,
									);
								}
							}
							if (localHash && localHash !== knownHash) {
								// Known baseline exists, local hash differs → known dirty.
								decision = { kind: "preserve-revive" };
							}
						}
					} catch {
						// Stat failed — file might be locked, busy, or inaccessible.
						// We have a baseline hash but cannot verify local state.
						// Treat as unresolved to avoid deleting potentially modified data.
						decision = { kind: "preserve-unresolved" };
						unresolvedReason = "remote-delete-stat-failed";
						this.trace?.(
							"blob",
							"remote-delete-conflict-preserved",
							{
								path: normalized,
								knownHash: knownHash?.slice(0, 12) ?? null,
								reason: "stat-failed-cannot-verify",
							},
						);
						this.log(
							`handleRemoteDelete: preserved "${normalized}" (stat failed — cannot verify local state)`,
						);
					}
				} else {
					// No known hash — cannot verify local file is unmodified.
					// Preserve but do NOT auto-clear tombstone. This prevents
					// phantom resurrection of legitimately deleted files when
					// hash state is transiently unavailable.
					decision = { kind: "preserve-unresolved" };
					unresolvedReason = "remote-delete-missing-baseline";
				}

				if (decision.kind === "apply-delete") {
					// Clear any prior unresolved marker — we now have a baseline.
					if (this.preservedUnresolved.resolve(normalized)) {
						this.onPreservedUnresolvedChanged?.();
					}
					this.suppress(normalized);
					const deleteMode = await this.deleteLocalReplica(file);
					this.trace?.("blob", "remote-delete-applied", {
						path: normalized,
						deleteMode,
						reason: "remote-delete",
					});
					this.log(
						`handleRemoteDelete: deleted "${normalized}" from disk`,
					);
					this.recordAttachmentEvent(
						PRODUCT_EVENT_KIND.deleteDiskApplied,
						normalized,
						"info",
						"critical",
						{ subject: "attachment" },
					);
				} else if (decision.kind === "preserve-revive") {
					// Clear any prior unresolved marker — we now have a baseline.
					if (this.preservedUnresolved.resolve(normalized)) {
						this.onPreservedUnresolvedChanged?.();
					}
					// Known dirty: local file intentionally differs from baseline.
					// Clear tombstone so it re-enters sync.
					this.trace?.("blob", "remote-delete-conflict-preserved", {
						path: normalized,
						knownHash: knownHash?.slice(0, 12) ?? null,
						reason: "local-file-modified-since-last-sync",
					});
					this.log(
						`handleRemoteDelete: preserved locally modified "${normalized}" (hash mismatch with known ${knownHash!.slice(0, 12)}…)`,
					);
					if (this.attachmentCatalog.isAttachmentTombstoned(normalized)) {
						this.enqueueUpload(normalized, 0, file.stat.size);
						this.kickUploadDrain();
						this.trace?.(
							"blob",
							"remote-delete-preserved-tombstone-cleared",
							{
								path: normalized,
								reason: "local-dirty-file-revived",
							},
						);
					}
				} else {
					// preserve-unresolved: file stays, tombstone stays.
					// DO NOT auto-clear tombstone. Later reconcile/import passes
					// keep it in limbo until explicit user action or a future
					// remote event provides a new decision point.
					this.preservedUnresolved.record({
						path: normalized,
						kind: "blob",
						reason: unresolvedReason ?? "unknown",
						knownRemoteHash: knownHash,
					});
					this.onPreservedUnresolvedChanged?.();
					this.trace?.("blob", "remote-delete-conflict-preserved", {
						path: normalized,
						knownHash: null,
						reason: "no-known-hash-baseline",
					});
					this.log(
						`handleRemoteDelete: preserved "${normalized}" (no known hash baseline — unresolved)`,
					);
				}
			} catch (err) {
				console.error(
					`[yaos:blob] handleRemoteDelete failed for "${path}":`,
					err,
				);
			} finally {
				this.remoteDeleteInFlight.delete(normalized);
			}
		}
	}

	private async deleteLocalReplica(file: TFile): Promise<"trash"> {
		if (!this.validateBlobPath(file.path, "remote-delete-before-disk-delete")) {
			throw new Error("unsafe attachment delete path");
		}
		await this.app.fileManager.trashFile(file);
		return "trash";
	}

	private scheduleRetryKick(
		delayMs: number,
		channel: "upload" | "download",
	): void {
		const timer = window.setTimeout(() => {
			this.retryTimers.delete(timer);
			if (channel === "upload") this.kickUploadDrain();
			else this.kickDownloadDrain();
		}, delayMs);
		this.retryTimers.add(timer);
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

		const upPending =
			this.pendingUploadCount() +
			this.uploadDebounce.size +
			this.inflightUploads.size;
		if (
			upPending > 0 ||
			this._completedUploads < this._totalUploadsThisCycle
		) {
			parts.push(
				`↑${this._completedUploads}/${this._totalUploadsThisCycle}`,
			);
		}

		const downPending =
			this.pendingDownloadCount() + this.inflightDownloads.size;
		if (
			downPending > 0 ||
			this._completedDownloads < this._totalDownloadsThisCycle
		) {
			parts.push(
				`↓${this._completedDownloads}/${this._totalDownloadsThisCycle}`,
			);
		}

		return parts.length > 0 ? parts.join(" ") : null;
	}

	private pendingUploadCount(): number {
		let count = 0;
		for (const item of this.uploadQueue.values()) {
			if (item.status === "pending") count++;
		}
		return count;
	}

	private pendingDownloadCount(): number {
		let count = 0;
		for (const item of this.downloadQueue.values()) {
			if (item.status === "pending") count++;
		}
		return count;
	}

	// -------------------------------------------------------------------
	// Queue persistence
	// -------------------------------------------------------------------

	/**
	 * Export a snapshot of pending/processing queues for persistence.
	 * Processing items are restored as pending on load.
	 */
	exportQueue(): BlobQueueSnapshot {
		const uploads: BlobQueueSnapshot["uploads"] = [];
		for (const [, item] of this.uploadQueue) {
			uploads.push({
				path: item.path,
				sizeBytes: item.sizeBytes,
				retries: item.retries,
				status: item.status,
				readyAt: item.readyAt,
				needsRerun: item.needsRerun,
				rerunResets: item.rerunResets,
			});
		}
		// Also include items in debounce (not yet in queue but pending)
		for (const [path] of this.uploadDebounce) {
			if (!this.uploadQueue.has(path)) {
				uploads.push({
					path,
					retries: 0,
					status: "pending",
					readyAt: 0,
					rerunResets: 0,
				});
			}
		}

		const downloads: BlobQueueSnapshot["downloads"] = [];
		for (const [, item] of this.downloadQueue) {
			downloads.push({
				path: item.path,
				hash: item.hash,
				sizeBytes: item.sizeBytes,
				retries: item.retries,
				status: item.status,
				readyAt: item.readyAt,
				needsRerun: item.needsRerun,
				rerunResets: item.rerunResets,
			});
		}

		return { uploads, downloads };
	}

	/**
	 * Restore queues from a persisted snapshot.
	 * Processing items are normalized to pending.
	 */
	importQueue(snapshot: BlobQueueSnapshot): void {
		let restored = 0;

		if (snapshot.uploads) {
			for (const item of snapshot.uploads) {
				const path = this.validateBlobPath(item.path, "restored-upload-queue");
				if (!path || this.uploadQueue.has(path) || this.uploadDebounce.has(path)) continue;
				this.uploadQueue.set(path, {
					path,
					sizeBytes: item.sizeBytes,
					retries: item.retries ?? 0,
					status: "pending",
					readyAt: 0,
					needsRerun: item.needsRerun ?? false,
					rerunResets: item.rerunResets ?? 0,
				});
				restored++;
			}
		}

		if (snapshot.downloads) {
			for (const item of snapshot.downloads) {
				const path = this.validateBlobPath(item.path, "restored-download-queue", {
					hash: item.hash,
					size: item.sizeBytes ?? 0,
				});
				if (!path || this.downloadQueue.has(path)) continue;
				this.downloadQueue.set(path, {
					path,
					hash: item.hash,
					sizeBytes: item.sizeBytes,
					retries: item.retries ?? 0,
					status: "pending",
					readyAt: 0,
					needsRerun: item.needsRerun ?? false,
					rerunResets: item.rerunResets ?? 0,
				});
				restored++;
			}
		}

		if (restored > 0) {
			this.log(`importQueue: restored ${restored} pending transfers`);
			if (this.uploadQueue.size > 0) this.kickUploadDrain();
			if (this.downloadQueue.size > 0) this.kickDownloadDrain();
		}
	}

	openDownloadGate(reason: string): void {
		if (this.downloadGateOpen) return;
		this.downloadGateOpen = true;
		this.log(`Download gate opened (${reason})`);
		const dropped = this.pruneSatisfiedQueuedDownloads();
		if (dropped > 0) {
			this.log(
				`Download gate: dropped ${dropped} stale queued downloads`,
			);
		}
		if (this.downloadQueue.size > 0) {
			this.log(
				`Download gate: draining ${this.downloadQueue.size} queued downloads`,
			);
		}
		this.kickDownloadDrain();
	}

	private pruneSatisfiedQueuedDownloads(): number {
		let dropped = 0;
		for (const [path, item] of this.downloadQueue) {
			if (item.status !== "pending") continue;
			const ref = this.attachmentCatalog.getAttachmentRef(path);
			const canonical = ref ? this.validateBlobPath(path, "download-gate-prune", ref) : null;
			if (!ref || !canonical || ref.hash !== item.hash) {
				this.downloadQueue.delete(path);
				dropped++;
				continue;
			}
			const existing = this.app.vault.getAbstractFileByPath(canonical);
			if (!(existing instanceof TFile)) continue;

			const fileStat = {
				mtime: existing.stat.mtime,
				size: existing.stat.size,
			};
			const cachedHash = getCachedHash(this.hashCache, path, fileStat);
			if (cachedHash !== item.hash) continue;

			this.downloadQueue.delete(path);
			dropped++;
		}
		return dropped;
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
			window.clearTimeout(timer);
		}
		this.uploadDebounce.clear();
		for (const timer of this.retryTimers.values()) {
			window.clearTimeout(timer);
		}
		this.retryTimers.clear();

		this.uploadQueue.clear();
		this.downloadQueue.clear();
		this.inflightUploads.clear();
		this.inflightDownloads.clear();
		this.suppressedPaths.clear();
		this.localOnlyBlobConflictPaths.clear();
		this.remoteDeleteInFlight.clear();
		this.quarantinedInvalidPaths.clear();
		this.preservedUnresolved.clear();
		this.log("BlobSyncManager destroyed");
		for (const waiters of this.forcedDownloadWaiters.values()) {
			for (const waiter of waiters) waiter.reject(new Error("attachment sync stopped during recovery download"));
		}
		this.forcedDownloadWaiters.clear();
	}

	getDebugSnapshot(): {
		pendingUploads: number;
		pendingDownloads: number;
		processingUploads: number;
		processingDownloads: number;
		uploadDraining: boolean;
		downloadDraining: boolean;
		downloadGateOpen: boolean;
		suppressedCount: number;
		permanentUploadFailures: number;
		permanentDownloadFailures: number;
		blobConflictArtifacts: number;
		localOnlyBlobConflictPaths: number;
		quarantinedInvalidPaths: number;
		preservedUnresolved: ReturnType<PreservedUnresolvedRegistry["getSummary"]>;
		uploadQueue: string[];
		downloadQueue: string[];
		inflightUploads: string[];
		inflightDownloads: string[];
	} {
		return {
			pendingUploads: this.pendingUploadCount(),
			pendingDownloads: this.pendingDownloadCount(),
			processingUploads: this.inflightUploads.size,
			processingDownloads: this.inflightDownloads.size,
			uploadDraining: this.uploadDraining,
			downloadDraining: this.downloadDraining,
			downloadGateOpen: this.downloadGateOpen,
			suppressedCount: this.suppressedPaths.size,
			permanentUploadFailures: this._permanentUploadFailures,
			permanentDownloadFailures: this._permanentDownloadFailures,
			blobConflictArtifacts: this._blobConflictArtifacts,
			localOnlyBlobConflictPaths: this.localOnlyBlobConflictPaths.size,
			quarantinedInvalidPaths: this.quarantinedInvalidPaths.size,
			preservedUnresolved: this.preservedUnresolved.getSummary(),
			uploadQueue: Array.from(this.uploadQueue.values())
				.filter((item) => item.status === "pending")
				.map((item) => item.path),
			downloadQueue: Array.from(this.downloadQueue.values())
				.filter((item) => item.status === "pending")
				.map((item) => item.path),
			inflightUploads: Array.from(this.inflightUploads),
			inflightDownloads: Array.from(this.inflightDownloads),
		};
	}

	private log(msg: string): void {
		this.trace?.("blob", msg);
		if (this.debug) {
			console.debug(`[yaos:blob] ${msg}`);
		}
	}

	get isDownloadGateOpen(): boolean {
		return this.downloadGateOpen;
	}
}
