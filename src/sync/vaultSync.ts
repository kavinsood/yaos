import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { type FileMeta, type BlobRef, type BlobMeta, type BlobTombstone, ORIGIN_SEED } from "../types";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext, TraceRecord } from "../debug/trace";
import { randomBase64Url } from "../utils/base64url";
import { formatUnknown } from "../utils/format";
import { normalizeVaultPath } from "../utils/normalizeVaultPath";

/** Current schema version. Stored in sys.schemaVersion. */
export const SCHEMA_VERSION = 2;

/** Timeouts for the startup sequence. */
const LOCAL_PERSISTENCE_TIMEOUT_MS = 3_000;
const PROVIDER_SYNC_TIMEOUT_MS = 10_000;

/**
 * Reconnection config.
 * y-partyserver uses `2^n * 100ms` capped at `maxBackoffTime`.
 * Default is 2500ms which is aggressive for mobile. We raise it to 30s
 * and the natural jitter from network latency + varying reconnect
 * timing provides sufficient de-correlation.
 */
const MAX_BACKOFF_TIME_MS = 30_000;

/** Debounce window for batching rename events (folder renames). */
const RENAME_BATCH_MS = 50;

/** Persistence adapter contract shared by browser and headless clients. */
export interface VaultSyncPersistenceDatabase {
	addEventListener(
		type: "error",
		listener: (event: { target: { error?: unknown } | null }) => void,
	): void;
}

export interface VaultSyncPersistence {
	once(event: "synced", listener: () => void): void;
	destroy(): Promise<void> | void;
	_db: Promise<VaultSyncPersistenceDatabase>;
}

export type VaultSyncPersistenceFactory = (name: string, doc: Y.Doc) => VaultSyncPersistence;

export interface VaultSyncOptions {
	traceContext?: TraceHttpContext;
	trace?: TraceRecord;
	persistenceFactory?: VaultSyncPersistenceFactory;
	logPersistenceOpenError?: boolean;
	webSocketPolyfill?: typeof WebSocket;
}

function createIndexedDbPersistence(name: string, doc: Y.Doc): VaultSyncPersistence {
	return new IndexeddbPersistence(name, doc) as unknown as VaultSyncPersistence;
}

/** Reconciliation mode determines what operations are safe. */
export type ReconcileMode = "conservative" | "authoritative";
type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";

interface FatalAuthMessage {
	code: FatalAuthCode;
	clientSchemaVersion: number | null;
	roomSchemaVersion: number | null;
	reason: string | null;
}
const FATAL_AUTH_CODES = new Set<FatalAuthCode>([
	"unauthorized",
	"server_misconfigured",
	"unclaimed",
	"update_required",
]);

function parseFatalAuthMessage(payload: string): FatalAuthMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "error") return null;
	if (typeof record.code !== "string" || !FATAL_AUTH_CODES.has(record.code as FatalAuthCode)) {
		return null;
	}
	return {
		code: record.code as FatalAuthCode,
		clientSchemaVersion:
			typeof record.clientSchemaVersion === "number" && Number.isInteger(record.clientSchemaVersion)
				? record.clientSchemaVersion
				: null,
		roomSchemaVersion:
			typeof record.roomSchemaVersion === "number" && Number.isInteger(record.roomSchemaVersion)
				? record.roomSchemaVersion
				: null,
		reason: typeof record.reason === "string" ? record.reason : null,
	};
}

type IndexedDbErrorKind =
	| "quota_exceeded"
	| "blocked"
	| "permission"
	| "unknown";

interface IndexedDbErrorDetails {
	kind: IndexedDbErrorKind;
	name: string | null;
	message: string | null;
	phase: "open" | "wait" | "runtime";
	at: string;
}

/**
 * Manages the vault-wide Y.Doc, the Worker sync provider, IndexedDB
 * persistence, and the shared Yjs maps.
 *
 * Schema:
 *   pathToId:        Y.Map<string>         — vault-relative path -> stable fileId (markdown)
 *   idToText:        Y.Map<Y.Text>         — fileId -> Y.Text (markdown content)
 *   meta:            Y.Map<FileMeta>       — fileId -> metadata { path, deleted?, mtime? }
 *   sys:             Y.Map<any>            — sentinel/bookkeeping { initialized, lastSync }
 *   pathToBlob:      Y.Map<BlobRef>        — vault-relative path -> { hash, size }
 *   blobMeta:        Y.Map<BlobMeta>       — sha256 hex -> { size, mime, createdAt }
 *   blobTombstones:  Y.Map<BlobTombstone>  — vault-relative path -> { deletedAt, device? }
 */
export class VaultSync {
	readonly ydoc: Y.Doc;
	readonly provider: YSyncProvider;
	readonly persistence: VaultSyncPersistence;

	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<FileMeta>;
	readonly sys: Y.Map<unknown>;

	// Blob / attachment maps (additive — schema version stays at 1)
	readonly pathToBlob: Y.Map<BlobRef>;
	readonly blobMeta: Y.Map<BlobMeta>;
	readonly blobTombstones: Y.Map<BlobTombstone>;

	/**
	 * In-memory reverse map: Y.Text instance -> fileId.
	 * Populated when texts are created/resolved. WeakMap so GC'd
	 * Y.Text instances don't leak. Used by DiskMirror for O(1)
	 * reverse lookups instead of scanning idToText.
	 */
	private _textToFileId = new WeakMap<Y.Text, string>();
	private _pathIndex = new Map<string, string>(); // path -> fileId (active only)
	private _deletedPathIndex = new Set<string>(); // tombstoned paths
	private _pathIndexesDirty = true;

	private _localReady = false;
	private _providerSynced = false;

	/**
	 * Increments each time the provider connects. Used to distinguish
	 * first connect (gen 0) from reconnects (gen > 0).
	 */
	private _connectionGeneration = 0;
	private _providerSyncWaiters = new Set<(value: boolean) => void>();

	/**
	 * True if the server sent an explicit auth error message.
	 * When set, the plugin should stop reconnecting.
	 */
	private _fatalAuthError = false;
	private _fatalAuthCode: "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required" | null = null;
	private _fatalAuthDetails: {
		clientSchemaVersion: number | null;
		roomSchemaVersion: number | null;
		reason: string | null;
	} | null = null;

	/** True if IndexedDB encountered an error (unavailable, quota, etc). */
	private _idbError = false;
	private _idbErrorDetails: IndexedDbErrorDetails | null = null;

	/** Buffered renames for batch flush. */
	private _renameBatch: Map<string, string> = new Map(); // oldPath -> newPath
	private _renameBatchNewToOld: Map<string, string> = new Map(); // newPath -> oldPath
	private _renameTimer: ReturnType<typeof setTimeout> | null = null;
	/** Callback invoked after a rename batch is flushed. */
	private _onRenameBatchFlushed: ((renames: Map<string, string>) => void) | null = null;

	private readonly _device: string | undefined;
	private readonly debug: boolean;
	private _eventRing: Array<{ ts: string; msg: string }> = [];
	private readonly trace?: TraceRecord;

	constructor(
		settings: VaultSyncSettings,
		options?: VaultSyncOptions,
	) {
		this.debug = settings.debug;
		this._device = settings.deviceName || undefined;
		this.trace = options?.trace;

		this.ydoc = new Y.Doc();
		this.pathToId = this.ydoc.getMap<string>("pathToId");
		this.idToText = this.ydoc.getMap<Y.Text>("idToText");
		this.meta = this.ydoc.getMap<FileMeta>("meta");
		this.sys = this.ydoc.getMap("sys");

		this.pathToBlob = this.ydoc.getMap<BlobRef>("pathToBlob");
		this.blobMeta = this.ydoc.getMap<BlobMeta>("blobMeta");
		this.blobTombstones = this.ydoc.getMap<BlobTombstone>("blobTombstones");
		this.meta.observe(() => {
			this._pathIndexesDirty = true;
		});

		const roomId = settings.vaultId;
		const idbName = `yaos:${settings.vaultId}`;

		this.log(`Connecting to ${settings.host} room=${roomId}`);
		this.log(`IndexedDB database: ${idbName}`);

		// Start both persistence and provider in parallel.
		const persistenceFactory = options?.persistenceFactory ?? createIndexedDbPersistence;
		this.persistence = persistenceFactory(idbName, this.ydoc);
		const persistenceDb = this.persistence._db;

		// Catch IndexedDB open/write failures (unavailable, quota, permissions).
		// y-indexeddb's internal _db promise rejects if IDB can't open.
		// We also listen for unhandled IDB transaction errors.
		persistenceDb.catch((err: unknown) => {
			this.captureIndexedDbError(err, "open");
			if (options?.logPersistenceOpenError !== false) {
				console.error("[yaos] IndexedDB failed to open:", err);
			}
		});

		persistenceDb
			.then((db) => {
				db.addEventListener("error", (event) => {
					const target = event.target as { error?: unknown } | null;
					this.captureIndexedDbError(
						target?.error ?? new Error("IndexedDB runtime error"),
						"runtime",
					);
				});
			})
			.catch(() => {
				// Open failure is already captured above.
			});

		const params: Record<string, string> = {
			token: settings.token,
			schemaVersion: String(SCHEMA_VERSION),
		};
		if (options?.traceContext) {
			params.device = options.traceContext.deviceName;
			params.trace = options.traceContext.traceId;
			params.boot = options.traceContext.bootId;
		}
		const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;

		this.provider = new YSyncProvider(settings.host, roomId, this.ydoc, {
			prefix: syncPrefix,
			params,
			connect: true,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
			WebSocketPolyfill: options?.webSocketPolyfill,
		});

		// Track connection generations for reconnect detection
		this.provider.on("status", (event: { status: string }) => {
			this.log(
				`Provider status=${event.status} ` +
				`(wsconnected=${this.provider.wsconnected}, synced=${this.provider.synced})`,
			);
			if (event.status === "connected") {
				this._connectionGeneration++;
				this.log(`Connection generation: ${this._connectionGeneration}`);
			}
		});

		const handleFatalAuthPayload = (payload: string) => {
			const msg = parseFatalAuthMessage(payload);
			if (!msg) {
				return;
			}
			const firstFatal = !this._fatalAuthError;
			this._fatalAuthError = true;
			this._fatalAuthCode = msg.code;
			this._fatalAuthDetails = {
				clientSchemaVersion: msg.clientSchemaVersion,
				roomSchemaVersion: msg.roomSchemaVersion,
				reason: msg.reason,
			};
			if (firstFatal) {
				this.log(`Fatal auth error: ${msg.code} — stopping reconnection`);
			}
			this.provider.disconnect();
			this.resolvePendingProviderSyncWaiters(false);
		};

		// y-partyserver emits "__YPS:" control payloads via "custom-message".
		(this.provider as unknown as { on: (event: string, cb: (payload: string) => void) => void })
			.on("custom-message", handleFatalAuthPayload);
		// Fallback for servers that still send plain text JSON frames.
		this.provider.on("message", (event: MessageEvent) => {
			if (typeof event.data === "string") {
				handleFatalAuthPayload(event.data);
			}
		});
	}

	// -------------------------------------------------------------------
	// Startup gates
	// -------------------------------------------------------------------

	waitForLocalPersistence(): Promise<boolean> {
		if (this._localReady) return Promise.resolve(true);
		if (this._idbError) return Promise.resolve(false);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				this.log("IndexedDB persistence timed out — proceeding without cache");
				resolve(false);
			}, LOCAL_PERSISTENCE_TIMEOUT_MS);

			// Resolve on successful sync
			this.persistence.once("synced", () => {
				clearTimeout(timeout);
				this._localReady = true;
				this._pathIndexesDirty = true;
				this.log(
					`IndexedDB loaded (pathToId: ${this.pathToId.size}, ` +
					`initialized: ${this.isInitialized})`,
				);
				resolve(true);
			});

			// Also resolve (false) if IDB errors out after we started waiting
			this.persistence._db.catch(() => {
				clearTimeout(timeout);
				this.captureIndexedDbError(new Error("IndexedDB failed during waitForLocalPersistence"), "wait");
				this.log("IndexedDB errored during wait — proceeding without cache");
				resolve(false);
			});
		});
	}

	waitForProviderSync(): Promise<boolean> {
		if (this._providerSynced) return Promise.resolve(true);
		if (this._fatalAuthError) return Promise.resolve(false);

		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.provider.off("sync", check);
				this._providerSyncWaiters.delete(finish);
				resolve(value);
			};

			const timeout = setTimeout(() => {
				this.log("Provider sync timed out — entering offline mode");
				finish(false);
			}, PROVIDER_SYNC_TIMEOUT_MS);

			const check = (synced: boolean) => {
				this.log(`Provider sync event: synced=${synced} (gen=${this._connectionGeneration})`);
				if (!synced) return;
				this._providerSynced = true;
				this.log("Provider synced — room state received");
				finish(true);
			};
			this.provider.on("sync", check);
			this._providerSyncWaiters.add(finish);
			if (this._fatalAuthError) {
				finish(false);
			}
		});
	}

	/**
	 * Register a callback for when the provider syncs AFTER the initial
	 * startup sequence. Fires on both late first-sync and reconnections.
	 * The callback receives the connection generation number.
	 */
	onProviderSync(callback: (generation: number) => void): void {
		this.provider.on("sync", (synced: boolean) => {
			if (!synced) return;
			this._providerSynced = true;
			this.log(`onProviderSync callback firing (gen=${this._connectionGeneration})`);
			callback(this._connectionGeneration);
		});
	}

	// -------------------------------------------------------------------
	// Sentinel
	// -------------------------------------------------------------------

	get isInitialized(): boolean {
		return this.sys.get("initialized") === true;
	}

	markInitialized(): void {
		const alreadyInitialized = this.isInitialized;
		this.sys.set("initialized", true);
		if (this.storedSchemaVersion === null) {
			this.sys.set("schemaVersion", SCHEMA_VERSION);
		}
		if (!alreadyInitialized) {
			this.sys.set("lastSync", Date.now());
			this.log("Marked Y.Doc as initialized (sentinel set)");
		}
	}

	/**
	 * Check if the persisted schema version is compatible with this code.
	 * Returns null if OK, or an error string if incompatible.
	 *
	 * Rules:
	 *   - No version stored (first run or pre-versioning): OK, we'll set it
	 *   - Version <= SCHEMA_VERSION: OK (same or older, we can read it)
	 *   - Version > SCHEMA_VERSION: INCOMPATIBLE (newer plugin wrote this)
	 */
	checkSchemaVersion(): string | null {
		const stored = this.sys.get("schemaVersion");
		if (stored === undefined || stored === null) return null; // first run
		if (typeof stored !== "number") return null; // corrupt, treat as first run
		if (stored > SCHEMA_VERSION) {
			return (
				`CRDT schema version ${stored} is newer than this plugin supports (v${SCHEMA_VERSION}). ` +
				`Update the plugin or risk data corruption.`
			);
		}
		return null; // same or older version, OK
	}

	get supportedSchemaVersion(): number {
		return SCHEMA_VERSION;
	}

	get storedSchemaVersion(): number | null {
		const stored = this.sys.get("schemaVersion");
		if (typeof stored !== "number" || !Number.isInteger(stored) || stored < 0) {
			return null;
		}
		return stored;
	}

	// -------------------------------------------------------------------
	// Path normalization
	// -------------------------------------------------------------------

	/** Normalize a vault-relative path for consistent CRDT keys. */
	private normPath(path: string): string {
		return normalizeVaultPath(path);
	}

	isFileMetaDeleted(meta: FileMeta | undefined): boolean {
		if (!meta) return false;
		return meta.deleted === true || (typeof meta.deletedAt === "number" && Number.isFinite(meta.deletedAt));
	}

	private currentSchemaVersion(): number {
		return this.storedSchemaVersion ?? 1;
	}

	private usesV2PathModel(): boolean {
		return this.currentSchemaVersion() >= 2;
	}

	private shouldWriteLegacyPathMap(): boolean {
		return !this.usesV2PathModel();
	}

	private ensurePathIndexes(): void {
		if (!this._pathIndexesDirty) return;

		this._pathIndex.clear();
		this._deletedPathIndex.clear();

		this.meta.forEach((meta, fileId) => {
			const path = typeof meta.path === "string" ? this.normPath(meta.path) : "";
			if (!path) return;

			if (this.isFileMetaDeleted(meta)) {
				if (!this._pathIndex.has(path)) {
					this._deletedPathIndex.add(path);
				}
				return;
			}

			const existingId = this._pathIndex.get(path);
			if (!existingId) {
				this._pathIndex.set(path, fileId);
				this._deletedPathIndex.delete(path);
				return;
			}

			const existingMeta = this.meta.get(existingId);
			const existingMtime = typeof existingMeta?.mtime === "number" ? existingMeta.mtime : 0;
			const candidateMtime = typeof meta.mtime === "number" ? meta.mtime : 0;

			// If we see active path collisions, deterministically choose one winner.
			if (candidateMtime > existingMtime || (candidateMtime === existingMtime && fileId > existingId)) {
				this._pathIndex.set(path, fileId);
			}
			this._deletedPathIndex.delete(path);
		});

		this._pathIndexesDirty = false;
	}

	private setMetaActive(fileId: string, path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		this.meta.set(fileId, {
			path: normalizedPath,
			deleted: undefined,
			deletedAt: undefined,
			mtime: Date.now(),
			device,
		});
	}

	private setMetaDeleted(fileId: string, path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const deletedAt = Date.now();
		const useLegacyFlag = this.currentSchemaVersion() < 2;
		if (useLegacyFlag) {
			this.meta.set(fileId, {
				path: normalizedPath,
				deleted: true,
				deletedAt,
				mtime: deletedAt,
				device,
			});
			return;
		}

		// v2 tombstone payload is intentionally minimal for long-term size control.
		this.meta.set(fileId, {
			path: normalizedPath,
			deletedAt,
		});
	}

	migrateSchemaToV2(device?: string): {
		from: number | null;
		to: number;
		metaUpdated: number;
		metaCreated: number;
		tombstonesConverted: number;
		loserPaths: string[];
	} {
		const from = this.storedSchemaVersion;
		let metaUpdated = 0;
		let metaCreated = 0;
		let tombstonesConverted = 0;
		const loserPaths: string[] = [];

		this.ydoc.transact(() => {
			const now = Date.now();
			const canonicalPathById = new Map<string, string>();
			const pathsById = new Map<string, string[]>();

			this.pathToId.forEach((fileId, rawPath) => {
				const path = this.normPath(rawPath);
				const list = pathsById.get(fileId);
				if (list) {
					list.push(path);
				} else {
					pathsById.set(fileId, [path]);
				}
			});

			for (const [fileId, paths] of pathsById) {
				const meta = this.meta.get(fileId);
				const preferred = typeof meta?.path === "string" ? this.normPath(meta.path) : "";
				const canonical = preferred && paths.includes(preferred)
					? preferred
					: paths.slice().sort()[0]!;
				canonicalPathById.set(fileId, canonical);
				for (const path of paths) {
					if (path !== canonical) {
						loserPaths.push(path);
					}
				}
			}

			for (const [fileId, normalizedPath] of canonicalPathById) {
				const currentMeta = this.meta.get(fileId);
				if (!currentMeta) {
					this.meta.set(fileId, {
						path: normalizedPath,
						deletedAt: undefined,
						deleted: undefined,
						mtime: now,
						device,
					});
					metaCreated++;
					return;
				}

				const isDeleted = this.isFileMetaDeleted(currentMeta);
				if (!isDeleted && currentMeta.path !== normalizedPath) {
					this.meta.set(fileId, {
						...currentMeta,
						path: normalizedPath,
						deleted: undefined,
						deletedAt: undefined,
						mtime: currentMeta.mtime ?? now,
						device: currentMeta.device ?? device,
					});
					metaUpdated++;
				}
			}

			this.meta.forEach((meta, fileId) => {
				if (meta.deleted && meta.deletedAt === undefined) {
					this.meta.set(fileId, {
						path: this.normPath(meta.path),
						deletedAt: typeof meta.mtime === "number" ? meta.mtime : now,
					});
					tombstonesConverted++;
					return;
				}
				if (this.isFileMetaDeleted(meta) && (meta.deleted !== undefined || meta.mtime !== undefined || meta.device !== undefined)) {
					this.meta.set(fileId, {
						path: this.normPath(meta.path),
						deletedAt: typeof meta.deletedAt === "number" ? meta.deletedAt : now,
					});
					metaUpdated++;
				}
			});

			// Explicit tombstones for dropped alias paths.
			const existingActivePaths = new Set<string>();
			this.meta.forEach((meta) => {
				if (this.isFileMetaDeleted(meta)) return;
				existingActivePaths.add(this.normPath(meta.path));
			});
			for (const loserPath of loserPaths) {
				if (existingActivePaths.has(loserPath)) continue;
				const tombstoneId = this.generateFileId();
				this.meta.set(tombstoneId, {
					path: loserPath,
					deletedAt: now,
				});
			}

			this.sys.set("schemaVersion", 2);
			this.sys.set("migratedAt", now);
			this.sys.set("migratedBy", device ?? this._device ?? "unknown");
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this.log(
			`schema migration: ${from ?? "none"} -> 2 ` +
			`(metaUpdated=${metaUpdated}, metaCreated=${metaCreated}, tombstonesConverted=${tombstonesConverted})`,
		);
		return {
			from,
			to: 2,
			metaUpdated,
			metaCreated,
			tombstonesConverted,
			loserPaths,
		};
	}

	// -------------------------------------------------------------------
	// Integrity checks
	// -------------------------------------------------------------------

	/**
	 * Run integrity checks on the CRDT maps. Call after reconciliation.
	 *
	 * Checks:
	 *   1. Two paths pointing to the same fileId → keep first, remap second
	 *   2. idToText/meta entries with no pathToId reference → orphan garbage
	 *
	 * Returns counts for logging.
	 */
	runIntegrityChecks(): { duplicateIds: number; orphansCleaned: number } {
		let duplicateIds = 0;
		let orphansCleaned = 0;

		// 1. Legacy duplicate-id repair for schema v1 only.
		// In schema v2, id->meta.path is authoritative and this clone behavior
		// is intentionally disabled.
		if (!this.usesV2PathModel()) {
			const idToPaths = new Map<string, string[]>();
			this.pathToId.forEach((fileId, path) => {
				const paths = idToPaths.get(fileId);
				if (paths) {
					paths.push(path);
				} else {
					idToPaths.set(fileId, [path]);
				}
			});

			for (const [fileId, paths] of idToPaths) {
				if (paths.length <= 1) continue;

				duplicateIds++;
				this.log(
					`integrity: fileId ${fileId} shared by ${paths.length} paths: ${paths.join(", ")}`,
				);

				const keepPath = paths[0]!;
				const sourceText = this.idToText.get(fileId);

				for (let i = 1; i < paths.length; i++) {
					const dupPath = paths[i]!;
					const newId = this.generateFileId();
					const newText = new Y.Text();

					this.ydoc.transact(() => {
						if (sourceText) {
							newText.insert(0, sourceText.toJSON());
						}
						this.pathToId.set(dupPath, newId);
						this.idToText.set(newId, newText);
						this.meta.set(newId, {
							path: dupPath,
							mtime: Date.now(),
							device: this._device,
						});
					}, ORIGIN_SEED);

					this.log(
						`integrity: gave "${dupPath}" new id=${newId} (was sharing ${fileId} with "${keepPath}")`,
					);
				}
			}
		}

		// 2. Orphan GC: find idToText/meta entries with no pathToId reference
		const referencedIds = new Set<string>();
		this.ensurePathIndexes();
		for (const fileId of this._pathIndex.values()) {
			referencedIds.add(fileId);
		}

		// Also keep tombstoned IDs (they're intentionally orphaned from pathToId)
		const tombstonedIds = new Set<string>();
		this.meta.forEach((meta, fileId) => {
			if (this.isFileMetaDeleted(meta)) {
				tombstonedIds.add(fileId);
			}
		});

		// Clean orphans from idToText
		const orphanTextIds: string[] = [];
		this.idToText.forEach((_text, fileId) => {
			if (!referencedIds.has(fileId) && !tombstonedIds.has(fileId)) {
				orphanTextIds.push(fileId);
			}
		});

		// Clean orphans from meta (non-tombstoned only)
		const orphanMetaIds: string[] = [];
		this.meta.forEach((meta, fileId) => {
			if (!referencedIds.has(fileId) && !tombstonedIds.has(fileId)) {
				orphanMetaIds.push(fileId);
			}
		});

		const allOrphanIds = new Set([...orphanTextIds, ...orphanMetaIds]);
		if (allOrphanIds.size > 0) {
			this.ydoc.transact(() => {
				for (const fileId of allOrphanIds) {
					this.idToText.delete(fileId);
					this.meta.delete(fileId);
				}
			}, ORIGIN_SEED);

			orphansCleaned = allOrphanIds.size;
			this.log(
				`integrity: cleaned ${orphansCleaned} orphaned entries ` +
				`(${orphanTextIds.length} from idToText, ${orphanMetaIds.length} from meta)`,
			);
		}

		return { duplicateIds, orphansCleaned };
	}

	// -------------------------------------------------------------------
	// Reconciliation
	// -------------------------------------------------------------------

	/**
	 * Determine which reconciliation mode is safe given current state.
	 *
	 * Authoritative when:
	 *   - Provider synced (we have the full server state), OR
	 *   - Local cache loaded AND sentinel says initialized AND
	 *     pathToId is non-empty (protects against partial IndexedDB persistence)
	 *
	 * Conservative otherwise.
	 */
	getSafeReconcileMode(): ReconcileMode {
		if (this._providerSynced) return "authoritative";
		// Use schemaVersion presence (set atomically with initialized) as
		// proof that IDB loaded real data. Unlike pathToId.size > 0 this
		// correctly handles legitimately-empty-but-initialized vaults.
		if (this._localReady && this.isInitialized && this.sys.get("schemaVersion") !== undefined) {
			return "authoritative";
		}
		return "conservative";
	}

	reconcileVault(
		diskFiles: Map<string, string>,
		diskPresentPaths: Set<string>,
		mode: ReconcileMode,
		device?: string,
	): ReconcileResult {
		const createdOnDisk: string[] = [];
		const updatedOnDisk: string[] = [];
		const seededToCrdt: string[] = [];
		const untracked: string[] = [];
		let skipped = 0;

		this.ensurePathIndexes();
		const crdtPaths = new Set<string>(this._pathIndex.keys());

		// CRDT files not on disk → create on disk
		// IMPORTANT: use diskPresentPaths (all known disk paths), not
		// diskFiles (only the subset whose content was read this run).
		for (const path of crdtPaths) {
			if (!diskPresentPaths.has(path)) {
				createdOnDisk.push(path);
			}
		}

		// Files present in both disk and CRDT whose content differs.
		// In authoritative mode, CRDT is source of truth and should be
		// flushed to disk so reopened clients converge reliably.
		if (mode === "authoritative") {
			for (const [path, diskContent] of diskFiles) {
				if (!crdtPaths.has(path)) continue;
				const ytext = this.getTextForPath(path);
				if (!ytext) continue;
				const crdtContent = ytext.toJSON();
				if (crdtContent !== diskContent) {
					updatedOnDisk.push(path);
				}
			}
		}

		// Disk files not in CRDT
		for (const path of diskPresentPaths) {
			if (crdtPaths.has(path)) continue;

			if (this._deletedPathIndex.has(path)) {
				this.log(`reconcile: "${path}" was tombstoned, skipping`);
				skipped++;
				continue;
			}

			if (mode === "authoritative") {
				const content = diskFiles.get(path);
				if (content === undefined) {
					// Presence is known, but content wasn't read this pass. Skip seeding
					// to avoid accidentally creating empty/incorrect files.
					this.log(`reconcile: "${path}" present on disk but content not loaded, skipping seed`);
					continue;
				}
				this.ensureFile(path, content, device);
				seededToCrdt.push(path);
			} else {
				untracked.push(path);
			}
		}

		if (mode === "authoritative") {
			this.markInitialized();
		}

		this.log(
			`reconcile [${mode}]: ` +
			`${seededToCrdt.length} seeded, ` +
			`${createdOnDisk.length} need disk creation, ` +
			`${updatedOnDisk.length} need disk update, ` +
			`${untracked.length} untracked, ` +
			`${skipped} tombstoned`,
		);

		return { mode, createdOnDisk, updatedOnDisk, seededToCrdt, untracked, skipped };
	}

	// -------------------------------------------------------------------
	// File operations
	// -------------------------------------------------------------------

	private generateFileId(): string {
		return randomBase64Url(12);
	}

	ensureFile(path: string, currentContent: string, device?: string): Y.Text | null {
		path = this.normPath(path);

		const existingId = this.getFileId(path);
		if (!existingId) {
			this.promotePendingRenameTarget(path, device);
		}
		const resolvedId = this.getFileId(path);
		if (resolvedId) {
			const existingText = this.idToText.get(resolvedId);
			if (existingText) {
				const cleared = this.clearMarkdownTombstonesForPath(path, resolvedId);
				if (cleared > 0) {
					this.log(`ensureFile: cleared ${cleared} stale tombstone(s) for "${path}"`);
				}
				this.log(`ensureFile: "${path}" already exists (id=${resolvedId})`);
				this._textToFileId.set(existingText, resolvedId);
				return existingText;
			}
			// Orphaned mapping — clean up old entries before recreating
			this.log(
				`ensureFile: "${path}" has id=${resolvedId} but no Y.Text — cleaning up orphan`,
			);
			this.ydoc.transact(() => {
				if (this.shouldWriteLegacyPathMap()) {
					this.pathToId.delete(path);
				}
				this.idToText.delete(resolvedId);
				this.meta.delete(resolvedId);
			}, ORIGIN_SEED);
		}

		// Check tombstones — never resurrect a deleted path unless it is already
		// backed by a live pathToId entry handled above.
		const tombstoneIds = this.getMarkdownTombstoneIds(path);
		if (tombstoneIds.length > 0) {
			this.trace?.("sync", "ensureFile-tombstone-blocked", {
				path,
				tombstoneIds,
				device: device ?? null,
			});
			this.log(`ensureFile: "${path}" is tombstoned, refusing to create`);
			return null;
		}

		const fileId = this.generateFileId();
		const ytext = new Y.Text();

		this.ydoc.transact(() => {
			ytext.insert(0, currentContent);
			if (this.shouldWriteLegacyPathMap()) {
				this.pathToId.set(path, fileId);
			}
			this.idToText.set(fileId, ytext);
			this.setMetaActive(fileId, path, device);
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this.log(`ensureFile: created "${path}" (id=${fileId})`);
		this._textToFileId.set(ytext, fileId);
		return ytext;
	}

	isMarkdownTombstoned(path: string): boolean {
		return this.isPathTombstoned(path) || this.getMarkdownTombstoneIds(path).length > 0;
	}

	getTextForPath(path: string): Y.Text | null {
		path = this.normPath(path);
		const fileId = this.getFileId(path);
		if (!fileId) return null;
		const text = this.idToText.get(fileId) ?? null;
		if (text) this._textToFileId.set(text, fileId);
		return text;
	}

	getFileId(path: string): string | undefined {
		path = this.normPath(path);
		if (this.usesV2PathModel()) {
			this.ensurePathIndexes();
			return this._pathIndex.get(path);
		}
		const legacy = this.pathToId.get(path);
		if (legacy) return legacy;
		this.ensurePathIndexes();
		return this._pathIndex.get(path);
	}

	/**
	 * O(1) reverse lookup: given a Y.Text, get its fileId.
	 * Returns undefined if the text isn't tracked (shouldn't happen
	 * for texts created via ensureFile/getTextForPath).
	 */
	getFileIdForText(ytext: Y.Text): string | undefined {
		return this._textToFileId.get(ytext);
	}

	getActiveMarkdownPaths(): string[] {
		this.ensurePathIndexes();
		return Array.from(this._pathIndex.keys());
	}

	isPathTombstoned(path: string): boolean {
		this.ensurePathIndexes();
		return this._deletedPathIndex.has(this.normPath(path));
	}

	// -------------------------------------------------------------------
	// Blob operations
	// -------------------------------------------------------------------

	/**
	 * Record a blob reference for a vault path. Called after a successful
	 * R2 upload. Sets pathToBlob + blobMeta in a single transaction.
	 * Only sets blobMeta if the hash isn't already tracked (dedup).
	 */
	setBlobRef(
		path: string,
		hash: string,
		size: number,
		mime: string,
		device?: string,
	): void {
		path = this.normPath(path);

		this.ydoc.transact(() => {
			this.pathToBlob.set(path, { hash, size });
			// Only set blobMeta if this content hash is new
			if (!this.blobMeta.has(hash)) {
				this.blobMeta.set(hash, {
					size,
					mime,
					createdAt: Date.now(),
					device,
				});
			}
			// Clear any existing tombstone for this path
			if (this.blobTombstones.has(path)) {
				this.blobTombstones.delete(path);
			}
		}, ORIGIN_SEED);

		this.log(`setBlobRef: "${path}" hash=${hash.slice(0, 12)}… (${size} bytes)`);
	}

	/**
	 * Get the blob reference for a vault path, if any.
	 */
	getBlobRef(path: string): BlobRef | undefined {
		return this.pathToBlob.get(this.normPath(path));
	}

	/**
	 * Get blob metadata for a content hash.
	 */
	getBlobMeta(hash: string): BlobMeta | undefined {
		return this.blobMeta.get(hash);
	}

	/**
	 * Tombstone-delete a blob path. Removes from pathToBlob and records
	 * a tombstone to prevent resurrection from stale disk scans.
	 * Does NOT delete the R2 blob (content-addressed = may be shared).
	 */
	deleteBlobRef(path: string, device?: string): void {
		path = this.normPath(path);

		if (!this.pathToBlob.has(path)) {
			this.log(`deleteBlobRef: "${path}" not in CRDT, ignoring`);
			return;
		}

		this.ydoc.transact(() => {
			this.pathToBlob.delete(path);
			this.blobTombstones.set(path, {
				deletedAt: Date.now(),
				device,
			});
		}, ORIGIN_SEED);

		this.log(`deleteBlobRef: "${path}" tombstoned`);
	}

	/**
	 * Check if a path is blob-tombstoned (deleted).
	 */
	isBlobTombstoned(path: string): boolean {
		return this.blobTombstones.has(this.normPath(path));
	}

	/**
	 * Rename a blob path. Moves the entry in pathToBlob.
	 * Called from the rename batch flush for non-markdown files.
	 */
	renameBlobRef(oldPath: string, newPath: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const ref = this.pathToBlob.get(oldPath);
		if (!ref) return;

		this.ydoc.transact(() => {
			this.pathToBlob.delete(oldPath);
			this.pathToBlob.set(newPath, ref);
			// Clear any tombstone at the new path
			if (this.blobTombstones.has(newPath)) {
				this.blobTombstones.delete(newPath);
			}
		}, ORIGIN_SEED);

		this.log(`renameBlobRef: "${oldPath}" -> "${newPath}"`);
	}

	// -------------------------------------------------------------------
	// Rename batching
	// -------------------------------------------------------------------

	/**
	 * Queue a rename for batched application. Multiple renames arriving
	 * within RENAME_BATCH_MS (e.g. folder rename) are collected and
	 * applied in a single ydoc.transact().
	 *
	 * Transitive chains are resolved: if A→B and B→C arrive in the same
	 * batch, they collapse to A→C.
	 */
	queueRename(oldPath: string, newPath: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const rootOldPath = this._renameBatchNewToOld.get(oldPath) ?? oldPath;
		if (rootOldPath === newPath) {
			this.deletePendingRenameByOldPath(rootOldPath);
		} else {
			this.setPendingRename(rootOldPath, newPath);
		}
		if (rootOldPath !== oldPath) {
			this.deletePendingRenameByOldPath(oldPath);
		}

		// Reset the debounce timer
		if (this._renameTimer) clearTimeout(this._renameTimer);
		this._renameTimer = setTimeout(() => this.flushRenameBatch(), RENAME_BATCH_MS);
	}

	isPendingRenameTarget(path: string): boolean {
		path = this.normPath(path);
		return this._renameBatchNewToOld.has(path);
	}

	/**
	 * Register a callback invoked after each rename batch flush.
	 * Receives the map of old→new paths that were applied.
	 */
	onRenameBatchFlushed(callback: (renames: Map<string, string>) => void): void {
		this._onRenameBatchFlushed = callback;
	}

	private flushRenameBatch(): void {
		this._renameTimer = null;
		if (this._renameBatch.size === 0) return;

		const batch = new Map(this._renameBatch);
		this.clearPendingRenames();

		this.log(`Flushing rename batch: ${batch.size} renames`);
		this.applyRenameBatch(batch, this._device);
	}

	/** Direct single rename (kept for programmatic use). */
	handleRename(oldPath: string, newPath: string, device?: string): void {
		oldPath = this.normPath(oldPath);
		newPath = this.normPath(newPath);

		const fileId = this.getFileId(oldPath);
		if (!fileId) {
			this.log(`handleRename: "${oldPath}" not in CRDT, ignoring`);
			return;
		}

		this.ydoc.transact(() => {
			if (this.shouldWriteLegacyPathMap()) {
				this.pathToId.delete(oldPath);
				this.pathToId.set(newPath, fileId);
			}
			this.clearMarkdownTombstonesForPath(newPath, fileId);
			this.setMetaActive(fileId, newPath, device);
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this.log(`handleRename: "${oldPath}" -> "${newPath}" (id=${fileId})`);
	}

	private promotePendingRenameTarget(path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const pendingOldPath = this._renameBatchNewToOld.get(normalizedPath);
		if (!pendingOldPath) return;

		this.deletePendingRenameByOldPath(pendingOldPath);
		if (this._renameBatch.size === 0 && this._renameTimer) {
			clearTimeout(this._renameTimer);
			this._renameTimer = null;
		}

		const batch = new Map([[pendingOldPath, normalizedPath]]);
		this.log(`Promoting pending rename target: "${pendingOldPath}" -> "${normalizedPath}"`);
		this.applyRenameBatch(batch, device ?? this._device);
	}

	private applyRenameBatch(batch: Map<string, string>, device?: string): void {
		if (batch.size === 0) return;

		this.ydoc.transact(() => {
			for (const [oldPath, newPath] of batch) {
				const fileId = this.getFileId(oldPath);
				if (fileId) {
					if (this.shouldWriteLegacyPathMap()) {
						this.pathToId.delete(oldPath);
						this.pathToId.set(newPath, fileId);
					}
					this.clearMarkdownTombstonesForPath(newPath, fileId);
					this.setMetaActive(fileId, newPath, device);
					this.log(`renameBatch: "${oldPath}" -> "${newPath}" (id=${fileId})`);
				}

				const blobRef = this.pathToBlob.get(oldPath);
				if (blobRef) {
					this.pathToBlob.delete(oldPath);
					this.pathToBlob.set(newPath, blobRef);
					if (this.blobTombstones.has(newPath)) {
						this.blobTombstones.delete(newPath);
					}
					this.log(`renameBatch: blob "${oldPath}" -> "${newPath}"`);
				}
			}
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this._onRenameBatchFlushed?.(batch);
	}

	private clearMarkdownTombstonesForPath(path: string, keepFileId?: string): number {
		const tombstonedIds: string[] = [];
		this.meta.forEach((meta, fileId) => {
			if (
				fileId !== keepFileId
				&& meta.path === path
				&& this.isFileMetaDeleted(meta)
			) {
				tombstonedIds.push(fileId);
			}
		});

		for (const tombstonedId of tombstonedIds) {
			this.meta.delete(tombstonedId);
		}

		return tombstonedIds.length;
	}

	private getMarkdownTombstoneIds(path: string): string[] {
		const normalizedPath = this.normPath(path);
		const tombstonedIds: string[] = [];
		this.meta.forEach((meta, fileId) => {
			if (meta.path === normalizedPath && this.isFileMetaDeleted(meta)) {
				tombstonedIds.push(fileId);
			}
		});
		return tombstonedIds;
	}

	handleDelete(path: string, device?: string): void {
		path = this.normPath(path);

		// Check pending rename batch for races:
		// 1. If a pending rename maps X → path (our delete target is the
		//    NEW name), cancel the rename and delete from the old path.
		// 2. If a pending rename maps path → Y (our delete target is the
		//    OLD name, rename hasn't flushed), cancel the rename and
		//    delete from path (it's still in pathToId).
		let resolvedPath = path;
		const pendingOldPath = this._renameBatchNewToOld.get(path);
		if (pendingOldPath) {
			const pendingNewPath = this._renameBatch.get(pendingOldPath) ?? path;
			this.trace?.("sync", "delete-cancelled-pending-rename", {
				requestedPath: path,
				pendingOldPath,
				pendingNewPath,
				case: "rename-target",
			});
			this.log(`handleDelete: "${path}" is a pending rename target from "${pendingOldPath}" — cancelling rename`);
			this.deletePendingRenameByOldPath(pendingOldPath);
			resolvedPath = pendingOldPath;
		} else if (this._renameBatch.has(path)) {
			const pendingNewPath = this._renameBatch.get(path)!;
			this.trace?.("sync", "delete-cancelled-pending-rename", {
				requestedPath: path,
				pendingOldPath: path,
				pendingNewPath,
				case: "rename-source",
			});
			this.log(`handleDelete: "${path}" has pending rename to "${pendingNewPath}" — cancelling rename`);
			this.deletePendingRenameByOldPath(path);
			resolvedPath = path;
		}

		const fileId = this.getFileId(resolvedPath);
		if (!fileId) {
			// Not a markdown file — might be a blob
			if (this.pathToBlob.has(resolvedPath)) {
				this.deleteBlobRef(resolvedPath, device);
			} else {
				this.log(`handleDelete: "${resolvedPath}" not in CRDT, ignoring`);
			}
			return;
		}

		this.ydoc.transact(() => {
			if (this.shouldWriteLegacyPathMap()) {
				this.pathToId.delete(resolvedPath);
			}
			this.setMetaDeleted(fileId, resolvedPath, device);
		}, ORIGIN_SEED);

		this._pathIndexesDirty = true;
		this.trace?.("sync", "markdown-tombstoned", {
			requestedPath: path,
			resolvedPath,
			fileId,
			device: device ?? null,
		});

		this.log(`handleDelete: "${resolvedPath}" marked deleted (id=${fileId})`);
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get localReady(): boolean {
		return this._localReady;
	}

	get providerSynced(): boolean {
		return this._providerSynced;
	}

	get connected(): boolean {
		return this.provider.wsconnected;
	}

	get connectionGeneration(): number {
		return this._connectionGeneration;
	}

	get fatalAuthError(): boolean {
		return this._fatalAuthError;
	}

	get fatalAuthCode(): "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required" | null {
		return this._fatalAuthCode;
	}

	get fatalAuthDetails(): {
		clientSchemaVersion: number | null;
		roomSchemaVersion: number | null;
		reason: string | null;
	} | null {
		return this._fatalAuthDetails;
	}

	get idbError(): boolean {
		return this._idbError;
	}

	get idbErrorDetails(): IndexedDbErrorDetails | null {
		return this._idbErrorDetails;
	}

	reportIndexedDbError(
		err: unknown,
		phase: IndexedDbErrorDetails["phase"] = "runtime",
	): void {
		this.captureIndexedDbError(err, phase);
	}

	/** The IndexedDB database name for this vault. */
	get idbName(): string {
		const vaultId = this.sys.get("vaultId");
		return `yaos:${typeof vaultId === "string" ? vaultId : "unknown"}`;
	}

	/**
	 * Wipe all CRDT maps (pathToId, idToText, meta, sys) in a single
	 * transaction. Collects keys first to avoid mutating during iteration.
	 * This propagates to the server via the provider (intentional for nuclear reset).
	 */
	clearAllMaps(): { pathCount: number; idCount: number; metaCount: number; blobCount: number } {
		const pathKeys = Array.from(this.pathToId.keys());
		const idKeys = Array.from(this.idToText.keys());
		const metaKeys = Array.from(this.meta.keys());
		const sysKeys = Array.from(this.sys.keys());
		const blobPathKeys = Array.from(this.pathToBlob.keys());
		const blobMetaKeys = Array.from(this.blobMeta.keys());
		const blobTombKeys = Array.from(this.blobTombstones.keys());

		this.ydoc.transact(() => {
			for (const k of pathKeys) this.pathToId.delete(k);
			for (const k of idKeys) this.idToText.delete(k);
			for (const k of metaKeys) this.meta.delete(k);
			for (const k of sysKeys) this.sys.delete(k);
			for (const k of blobPathKeys) this.pathToBlob.delete(k);
			for (const k of blobMetaKeys) this.blobMeta.delete(k);
			for (const k of blobTombKeys) this.blobTombstones.delete(k);
		}, ORIGIN_SEED);
		this._pathIndexesDirty = true;

		this.log(
			`clearAllMaps: removed ${pathKeys.length} paths, ` +
			`${idKeys.length} texts, ${metaKeys.length} meta entries, ` +
			`${blobPathKeys.length} blob paths`,
		);

		return {
			pathCount: pathKeys.length,
			idCount: idKeys.length,
			metaCount: metaKeys.length,
			blobCount: blobPathKeys.length,
		};
	}

	/**
	 * Delete the IndexedDB database for this vault.
	 * Safe to call after destroy() — uses the raw IDB deleteDatabase API.
	 */
	static deleteIdb(vaultId: string): Promise<void> {
		const name = `yaos:${vaultId}`;
		return new Promise((resolve, reject) => {
			const req = indexedDB.deleteDatabase(name);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error ?? new Error(`Failed to delete IndexedDB database "${name}"`));
			req.onblocked = () => {
				console.warn(`[yaos] IDB delete blocked for "${name}"`);
				// Resolve anyway — it'll be deleted when connections close
				resolve();
			};
		});
	}

	destroy(): void {
		this.log("Destroying VaultSync");
		if (this._renameTimer) clearTimeout(this._renameTimer);
		this.clearPendingRenames();
		this.provider.destroy();
		void this.persistence.destroy();
		this.ydoc.destroy();
	}

	private setPendingRename(oldPath: string, newPath: string): void {
		if (oldPath === newPath) {
			this.deletePendingRenameByOldPath(oldPath);
			return;
		}

		const existingOldForTarget = this._renameBatchNewToOld.get(newPath);
		if (existingOldForTarget && existingOldForTarget !== oldPath) {
			this.deletePendingRenameByOldPath(existingOldForTarget);
		}

		const previousTarget = this._renameBatch.get(oldPath);
		if (previousTarget) {
			this._renameBatchNewToOld.delete(previousTarget);
		}

		this._renameBatch.set(oldPath, newPath);
		this._renameBatchNewToOld.set(newPath, oldPath);
	}

	private deletePendingRenameByOldPath(oldPath: string): void {
		const existingTarget = this._renameBatch.get(oldPath);
		if (!existingTarget) return;
		this._renameBatch.delete(oldPath);
		this._renameBatchNewToOld.delete(existingTarget);
	}

	private clearPendingRenames(): void {
		this._renameBatch.clear();
		this._renameBatchNewToOld.clear();
	}

	getRecentEvents(limit = 120): Array<{ ts: string; msg: string }> {
		if (limit <= 0) return [];
		return this._eventRing.slice(-limit);
	}

	getDebugSnapshot(): {
		connected: boolean;
		providerSynced: boolean;
		localReady: boolean;
		connectionGeneration: number;
		fatalAuthError: boolean;
		idbError: boolean;
		idbErrorDetails: IndexedDbErrorDetails | null;
		pathToIdCount: number;
		activePathCount: number;
		tombstonedPathCount: number;
		storedSchemaVersion: number | null;
		blobPathCount: number;
	} {
		this.ensurePathIndexes();
		return {
			connected: this.connected,
			providerSynced: this.providerSynced,
			localReady: this.localReady,
			connectionGeneration: this.connectionGeneration,
			fatalAuthError: this.fatalAuthError,
			idbError: this.idbError,
			idbErrorDetails: this.idbErrorDetails,
			pathToIdCount: this.pathToId.size,
			activePathCount: this._pathIndex.size,
			tombstonedPathCount: this._deletedPathIndex.size,
			storedSchemaVersion: this.storedSchemaVersion,
			blobPathCount: this.pathToBlob.size,
		};
	}

	private resolvePendingProviderSyncWaiters(value: boolean): void {
		if (this._providerSyncWaiters.size === 0) return;
		const waiters = Array.from(this._providerSyncWaiters);
		this._providerSyncWaiters.clear();
		for (const waiter of waiters) {
			try {
				waiter(value);
			} catch {
				// Ignore waiter errors; each promise handles its own lifecycle.
			}
		}
	}

	private classifyIndexedDbError(err: unknown): {
		kind: IndexedDbErrorKind;
		name: string | null;
		message: string | null;
	} {
		const name =
			typeof (err as { name?: unknown })?.name === "string"
				? (err as { name: string }).name
				: null;
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: err
					? formatUnknown(err)
					: null;

		const haystack = `${name ?? ""} ${message ?? ""}`.toLowerCase();
		if (haystack.includes("quotaexceeded") || haystack.includes("quota exceeded")) {
			return { kind: "quota_exceeded", name, message };
		}
		if (haystack.includes("blocked")) {
			return { kind: "blocked", name, message };
		}
		if (haystack.includes("security") || haystack.includes("permission") || haystack.includes("denied")) {
			return { kind: "permission", name, message };
		}
		return { kind: "unknown", name, message };
	}

	private captureIndexedDbError(err: unknown, phase: IndexedDbErrorDetails["phase"]): void {
		const classified = this.classifyIndexedDbError(err);
		this._idbError = true;
		if (
			!this._idbErrorDetails
			|| (
				this._idbErrorDetails.kind !== "quota_exceeded"
				&& classified.kind === "quota_exceeded"
			)
		) {
			this._idbErrorDetails = {
				...classified,
				phase,
				at: new Date().toISOString(),
			};
		}
		this.log(
			`IndexedDB error (${phase}): kind=${classified.kind}` +
			`${classified.name ? ` name=${classified.name}` : ""}` +
			`${classified.message ? ` msg=${classified.message}` : ""}`,
		);
	}

	private log(msg: string): void {
		this._eventRing.push({ ts: new Date().toISOString(), msg });
		if (this._eventRing.length > 600) {
			this._eventRing.splice(0, this._eventRing.length - 600);
		}
		this.trace?.("sync", msg);
		if (this.debug) {
			console.debug(`[yaos] ${msg}`);
		}
	}
}

export interface ReconcileResult {
	mode: ReconcileMode;
	createdOnDisk: string[];
	updatedOnDisk: string[];
	seededToCrdt: string[];
	untracked: string[];
	skipped: number;
}
