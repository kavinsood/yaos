import * as Y from "yjs";
import YSyncProvider from "y-partyserver/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { normalizePath } from "obsidian";
import { type FileMeta, type BlobRef, type BlobMeta, type BlobTombstone } from "../types";
import {
	decodeFileMeta,
	getMetaPath,
	getMetaMtime,
	isFileMetaDeletedValue,
	ensureNestedMetaEntry,
	createNestedActiveMeta,
	createNestedDeletedMeta,
	buildMetaSnapshot,
	computeMetaSemanticChanges,
	computeMetaShapeStats,
	extractAffectedFileIds,
	computeIncrementalMetaChanges,
	type DecodedFileMeta,
	type MetaSemanticChange,
	type MetaChangeBatch,
	type MetaShapeStats,
} from "./fileMeta";
import { ORIGIN_SEED, isLocalOrigin } from "./origins";
import type { VaultSyncSettings } from "../settings";
import type { TraceHttpContext, TraceRecord } from "../observability/traceContext";
import { randomBase64Url } from "../utils/base64url";
import { formatUnknown } from "../utils/format";
import { UpdateTracker } from "./updateTracker";
import { ServerAckTracker } from "./serverAckTracker";
import { IndexedDbCandidateStore, getOrCreateLocalDeviceId, sha256Hex } from "./indexedDbCandidateStore";
import {
	createSvEchoCounters,
	handleSvEchoCustomMessage,
	type SvEchoCounters,
} from "./svEchoMessage";
import type { CandidateStore, ScopeKey, ScopeMetadata } from "./candidateStore";
import { FLIGHT_KIND } from "../telemetry/debug/flightEvents";
import type { FlightPathEventInput } from "../telemetry/debug/flightEvents";
import { TICKET_REFRESH_BUFFER_MS, patchTicketInUrl } from "./socketTicket";

/** Current schema version. Stored in sys.schemaVersion. */
export { SCHEMA_VERSION } from "./schema";
import { SCHEMA_VERSION } from "./schema";

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

type ServerReceiptStartupValidation =
	| "not_started"
	| "validated"
	| "skipped_local_yjs_timeout"
	| "unavailable";

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
	readonly persistence: IndexeddbPersistence;
	readonly updateTracker: UpdateTracker;
	readonly serverAckTracker: ServerAckTracker;

	readonly pathToId: Y.Map<string>;
	readonly idToText: Y.Map<Y.Text>;
	readonly meta: Y.Map<unknown>;
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

	/**
	 * Snapshot of decoded metadata used by the semantic observer.
	 * Maintained by `_metaDeepObserver` and used to compute semantic diffs.
	 */
	private _metaSnapshot = new Map<string, DecodedFileMeta>();

	/**
	 * Counts how many times the `_metaDeepObserver` fell back to a full snapshot diff
	 * because event paths were ambiguous. Should be zero in normal operation.
	 * Exposed in debug stats so operators can confirm the incremental path is taken.
	 */
	private _metaObserverFallbackCount = 0;
	private _metaSemanticListeners = new Set<(batch: MetaChangeBatch) => void>();

	/**
	 * The single shared `observeDeep` handler on the meta map.
	 *
	 * Uses incremental diffing: reads event paths to determine which fileIds
	 * changed, then decodes only those entries. Falls back to a full snapshot
	 * diff only if event paths are ambiguous.
	 *
	 * Preserves transaction origin so consumers can distinguish local from remote.
	 */
	private _metaDeepObserver = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
		const origin = events[0]?.transaction.origin;
		const isLocal = isLocalOrigin(origin, this.provider);

		let changes: MetaSemanticChange[];

		// Try incremental diff first (O(k) where k = affected entries).
		const affected = extractAffectedFileIds(events, this.meta);
		if (affected !== null) {
			changes = computeIncrementalMetaChanges(this._metaSnapshot, this.meta, affected);
		} else {
			// Fallback: full snapshot diff (O(N)). Increment counter for observability.
			this._metaObserverFallbackCount++;
			const nextSnapshot = buildMetaSnapshot(this.meta);
			changes = computeMetaSemanticChanges(this._metaSnapshot, nextSnapshot);
			this._metaSnapshot = nextSnapshot;
		}

		if (changes.length === 0) return;

		// Invalidate path indexes for structural changes only.
		for (const change of changes) {
			if (change.kind !== "mtime-changed" && change.kind !== "device-changed") {
				this._pathIndexesDirty = true;
				break;
			}
		}

		// Dispatch to all registered listeners.
		if (this._metaSemanticListeners.size > 0) {
			const batch: MetaChangeBatch = { origin, isLocal, changes };
			for (const listener of this._metaSemanticListeners) {
				listener(batch);
			}
		}
	};

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
	private _serverAckStore: CandidateStore | null = null;
	private _serverAckScope: (ScopeKey & ScopeMetadata) | null = null;
	private _serverAckPersistenceUnavailable = false;
	private _serverReceiptStartupValidation: ServerReceiptStartupValidation = "not_started";
	private readonly _svEchoCounters = createSvEchoCounters();

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
	private readonly onFlightEvent?: (event: Record<string, unknown>) => void;
	private readonly onFlightPathEvent?: (event: FlightPathEventInput) => void;

	/**
	 * Stored callback for obtaining (and force-refreshing) short-lived tickets.
	 * Kept on the instance so the proactive refresh timer can call it after
	 * the constructor's params() closure is no longer in scope.
	 */
	private _getSocketTicket: ((force?: boolean) => Promise<{
		value: string;
		expiresAt: number;
		localExpiresAt: number;
		ttlMs: number;
	} | null>) | null = null;

	/** Timer handle for the proactive provider URL ticket refresh. */
	private _socketTicketRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		settings: VaultSyncSettings,
		options?: {
			traceContext?: TraceHttpContext;
			trace?: TraceRecord;
			onFlightEvent?: (event: Record<string, unknown>) => void;
			onFlightPathEvent?: (event: FlightPathEventInput) => void;
			/**
			 * Optional callback returning a short-lived WebSocket ticket.
			 * Called once during initial connection via async params().
			 * After that, VaultSync proactively refreshes provider.url via a
			 * timer so reconnects always find a live ticket — y-partyserver's
			 * internal reconnect loop reuses provider.url directly without
			 * re-calling params().
			 *
			 * Pass force=true to bypass the ticket cache and always fetch fresh.
			 * If the callback returns null the provider falls back to ?token=.
			 */
				getSocketTicket?: (force?: boolean) => Promise<{
					value: string;
					expiresAt: number;
					localExpiresAt: number;
					ttlMs: number;
				} | null>;
		},
	) {
		this.debug = settings.debug;
		this._device = settings.deviceName || undefined;
		this.trace = options?.trace;
		this.onFlightEvent = options?.onFlightEvent;
		this.onFlightPathEvent = options?.onFlightPathEvent;

		this.ydoc = new Y.Doc();
		this.pathToId = this.ydoc.getMap<string>("pathToId");
		this.idToText = this.ydoc.getMap<Y.Text>("idToText");
		this.meta = this.ydoc.getMap("meta");
		this.sys = this.ydoc.getMap("sys");

		this.pathToBlob = this.ydoc.getMap<BlobRef>("pathToBlob");
		this.blobMeta = this.ydoc.getMap<BlobMeta>("blobMeta");
		this.blobTombstones = this.ydoc.getMap<BlobTombstone>("blobTombstones");

		// Single shared observeDeep handler. Computes semantic diffs and dispatches
		// to listeners. Also drives path index invalidation so we only dirty it
		// for structurally relevant changes (not mtime/device churn).
		this._metaSnapshot = buildMetaSnapshot(this.meta);
		this.meta.observeDeep(this._metaDeepObserver);

		const roomId = settings.vaultId;
		const idbName = `yaos:${settings.vaultId}`;

		this.log(`Connecting to ${settings.host} room=${roomId}`);
		this.log(`IndexedDB database: ${idbName}`);

		// Start both persistence and provider in parallel.
		this.persistence = new IndexeddbPersistence(idbName, this.ydoc);

		// Catch IndexedDB open/write failures (unavailable, quota, permissions).
		// y-indexeddb's internal _db promise rejects if IDB can't open.
		// We also listen for unhandled IDB transaction errors.
		(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
			.catch((err: unknown) => {
				this.captureIndexedDbError(err, "open");
				console.error("[yaos] IndexedDB failed to open:", err);
			});

		(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
			.then((db: IDBDatabase) => {
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

		this._getSocketTicket = options?.getSocketTicket ?? null;
		const longLivedToken = settings.token;
		const syncPrefix = `/vault/sync/${encodeURIComponent(roomId)}`;

		this.provider = new YSyncProvider(settings.host, roomId, this.ydoc, {
			prefix: syncPrefix,
			params: async () => {
				// Build base params (schema version + optional trace context).
				const p: Record<string, string> = {
					schemaVersion: String(SCHEMA_VERSION),
				};
				if (options?.traceContext) {
					p.device = options.traceContext.deviceName;
					p.trace = options.traceContext.traceId;
					p.boot = options.traceContext.bootId;
				}
				// Prefer a short-lived ticket when available; fall back to the
				// long-lived token for servers that do not yet support tickets.
				//
				// NOTE: this callback is invoked once by YProvider.connect() on
				// initial connection.  y-partyserver's internal reconnect loop
				// (setupWS) reuses provider.url directly without re-calling
				// params().  VaultSync keeps provider.url fresh via
				// scheduleSocketTicketRefresh so reconnects always carry a live
				// ticket.  See engineering/zero-config-auth.md § "Reconnect
				// behavior" and engineering/warts-and-limits.md § "Pragmatic
				// compromises".
				const ticketResult = this._getSocketTicket ? await this._getSocketTicket() : null;
				if (ticketResult) {
					p.ticket = ticketResult.value;
					// Schedule proactive URL refresh before this ticket expires.
					this.scheduleSocketTicketRefresh(ticketResult);
				} else {
					p.token = longLivedToken;
				}
				return p;
			},
			connect: false,
			maxBackoffTime: MAX_BACKOFF_TIME_MS,
		});

		// Wire update tracker before any Y.Doc events so timestamps are captured.
		this.updateTracker = new UpdateTracker();
		this.updateTracker.attach(
			this.ydoc,
			() => this.connected,
			this.provider,
			this.persistence,
		);
		this.serverAckTracker = new ServerAckTracker(this.trace, this.onFlightEvent);

		// Track connection generations for reconnect detection
		this.provider.on("status", (event: { status: string }) => {
			this.log(
				`Provider status=${event.status} ` +
				`(wsconnected=${this.provider.wsconnected}, synced=${this.provider.synced})`,
			);
			if (event.status === "connected") {
				this._connectionGeneration++;
				this.log(`Connection generation: ${this._connectionGeneration}`);
			} else if (event.status === "disconnected" && this._getSocketTicket) {
				// Best-effort: refresh provider.url before the reconnect timer fires.
				// The proactive timer (scheduleSocketTicketRefresh) is the primary
				// mechanism; this handles edge cases like laptop sleep where the
				// disconnect happens without the timer having had a chance to fire.
				void this.refreshProviderTicketUrl(true);
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
		(this.provider as unknown as { on: (event: string, cb: (payload: string) => void) => void })
			.on("custom-message", (payload: string) => {
				// SV echoes are Level 3 receipt signals only. They are not durable;
				// ServerAckTracker's state-vector dominance check remains the truth gate.
				handleSvEchoCustomMessage(payload, this._svEchoCounters, (sv) => {
					this.serverAckTracker.recordServerSvEcho(sv);
				});
			});
		// Fallback for servers that still send plain text JSON frames.
		this.provider.on("message", (event: MessageEvent) => {
			if (typeof event.data === "string") {
				handleFatalAuthPayload(event.data);
			}
		});
		void this.provider.connect().catch((err: unknown) => {
			this.log(`Provider connect failed: ${formatUnknown(err)}`);
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
			(this.persistence as unknown as { _db: Promise<IDBDatabase> })._db
				.catch(() => {
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

	async initializeServerAckTracking(
		settings: VaultSyncSettings,
		pluginVersion: string,
		options: { localYjsPersistenceLoaded: boolean },
	): Promise<void> {
		if (this._serverAckScope) return;
		try {
			const [vaultIdHash, serverHostHash, localDeviceId] = await Promise.all([
				sha256Hex(settings.vaultId),
				sha256Hex(settings.host),
				getOrCreateLocalDeviceId(),
			]);
			const scope: ScopeKey & ScopeMetadata = {
				vaultIdHash,
				serverHostHash,
				localDeviceId,
				// Phase A uses the current y-partyserver room key. Since this is
				// derived from vaultId, it does not detect server reset/reclaim by
				// itself; the manual clear command remains the escape hatch until a
				// server generation/claim ID exists.
				roomName: settings.vaultId,
				docSchemaVersion: SCHEMA_VERSION,
				pluginVersion,
				ackStoreVersion: 1,
			};
			const store = new IndexedDbCandidateStore(scope);
			this._serverAckStore = store;
			this._serverAckScope = scope;
			this.serverAckTracker.attach(
				this.ydoc,
				() => Y.encodeStateVector(this.ydoc),
				this.provider,
				this.persistence,
			);
			if (options.localYjsPersistenceLoaded) {
				await this.serverAckTracker.onStartup(store, scope);
				this._serverReceiptStartupValidation = "validated";
				this.log("Server receipt tracker initialized");
			} else {
				this._serverReceiptStartupValidation = "skipped_local_yjs_timeout";
				this.log("Server receipt startup validation skipped: local Yjs persistence timed out");
			}
		} catch (err) {
			this._serverAckPersistenceUnavailable = true;
			this._serverReceiptStartupValidation = "unavailable";
			this.log(`Server receipt tracker unavailable: ${formatUnknown(err)}`);
		}
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

	/**
	 * Write the schema v3 marker if not already at v3+.
	 * This does NOT convert metadata — it only signals that this room
	 * may contain nested metadata and must only be accessed by v3-aware clients.
	 * Safe to call concurrently from multiple v3 clients (idempotent small write).
	 */
	markSchemaV3(device?: string): void {
		const current = this.currentSchemaVersion();
		if (current >= 3) return;

		this.ydoc.transact(() => {
			this.sys.set("schemaVersion", 3);
			this.sys.set("schemaUpdatedAt", Date.now());
			if (device) this.sys.set("schemaUpdatedBy", device);
		}, ORIGIN_SEED);

		this.log(`schema: marked v3 (was ${current})`);
	}

	/**
	 * Compute metadata shape statistics for debug/diagnostics.
	 * Returns counts of flat vs nested entries, active vs tombstones, etc.
	 */
	getMetaShapeStats(): MetaShapeStats & { metaObserverFallbackCount: number } {
		return {
			...computeMetaShapeStats(this.meta, this.storedSchemaVersion),
			metaObserverFallbackCount: this._metaObserverFallbackCount,
		};
	}

	/**
	 * Subscribe to semantic metadata change events.
	 *
	 * The callback receives a `MetaChangeBatch` for each Yjs transaction
	 * that changes metadata. The batch includes:
	 *   - `origin`: the Yjs transaction origin
	 *   - `isLocal`: true for locally-originated changes (DiskMirror must skip these)
	 *   - `changes`: pre-classified MetaSemanticChange[] for this transaction
	 *
	 * Works correctly for both flat (v2) and nested (v3) metadata entries.
	 * Powered by `observeDeep` with incremental diffing internally.
	 *
	 * Returns an unsubscribe function.
	 */
	observeMetaChanges(callback: (batch: MetaChangeBatch) => void): () => void {
		this._metaSemanticListeners.add(callback);
		return () => { this._metaSemanticListeners.delete(callback); };
	}

	// -------------------------------------------------------------------
	// Path normalization
	// -------------------------------------------------------------------

	/** Normalize a vault-relative path for consistent CRDT keys. */
	private normPath(path: string): string {
		return normalizePath(path);
	}

	isFileMetaDeleted(meta: unknown): boolean {
		if (!meta) return false;
		return isFileMetaDeletedValue(meta);
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

		this.meta.forEach((value: unknown, fileId: string) => {
			const path = getMetaPath(value);
			if (!path) return;
			const normalizedPath = this.normPath(path);

			if (isFileMetaDeletedValue(value)) {
				if (!this._pathIndex.has(normalizedPath)) {
					this._deletedPathIndex.add(normalizedPath);
				}
				return;
			}

			const existingId = this._pathIndex.get(normalizedPath);
			if (!existingId) {
				this._pathIndex.set(normalizedPath, fileId);
				this._deletedPathIndex.delete(normalizedPath);
				return;
			}

			const existingValue = this.meta.get(existingId);
			const existingMtime = getMetaMtime(existingValue) ?? 0;
			const candidateMtime = getMetaMtime(value) ?? 0;

			// If we see active path collisions, deterministically choose one winner.
			if (candidateMtime > existingMtime || (candidateMtime === existingMtime && fileId > existingId)) {
				this._pathIndex.set(normalizedPath, fileId);
			}
			this._deletedPathIndex.delete(normalizedPath);
		});

		this._pathIndexesDirty = false;
	}

	private setMetaActive(fileId: string, path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const now = Date.now();

		const entry = ensureNestedMetaEntry(this.meta, fileId, {
			shape: "flat",
			path: normalizedPath,
			mtime: now,
			...(device ? { device } : {}),
		});

		if (!entry) {
			// Should not happen since we always provide a fallback
			this.log(`setMetaActive: failed to ensure nested entry for ${fileId}`);
			return;
		}

		entry.set("path", normalizedPath);
		entry.delete("deleted");
		entry.delete("deletedAt");
		entry.set("mtime", now);

		if (device) {
			entry.set("device", device);
		} else {
			entry.delete("device");
		}
	}

	private setMetaDeleted(fileId: string, path: string, device?: string): void {
		const normalizedPath = this.normPath(path);
		const deletedAt = Date.now();

		const entry = ensureNestedMetaEntry(this.meta, fileId, {
			shape: "flat",
			path: normalizedPath,
			deletedAt,
		});

		if (!entry) {
			this.log(`setMetaDeleted: failed to ensure nested entry for ${fileId}`);
			return;
		}

		entry.set("path", normalizedPath);
		entry.set("deletedAt", deletedAt);
		entry.delete("deleted");
		entry.delete("mtime");
		entry.delete("device");
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
				const metaValue = this.meta.get(fileId);
				const preferred = getMetaPath(metaValue) ? this.normPath(getMetaPath(metaValue)!) : "";
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
				const currentMeta = decodeFileMeta(this.meta.get(fileId));
				if (!currentMeta) {
					// Write flat v2 object — this is a v1→v2 migration, not a v3 upgrade.
					// The lazy v3 conversion will upgrade this entry when it is next touched.
					this.meta.set(fileId, {
						path: normalizedPath,
						deletedAt: undefined,
						deleted: undefined,
						mtime: now,
						device,
					} as unknown);
					metaCreated++;
					return;
				}

				const isDeleted = currentMeta.deleted === true || typeof currentMeta.deletedAt === "number";
				if (!isDeleted && currentMeta.path !== normalizedPath) {
					// Update path in-place on nested map; write flat if still flat.
					const existing = this.meta.get(fileId);
					if (existing instanceof Y.Map) {
						existing.set("path", normalizedPath);
					} else {
						this.meta.set(fileId, {
							...(currentMeta as object),
							path: normalizedPath,
							deleted: undefined,
							deletedAt: undefined,
							mtime: currentMeta.mtime ?? now,
							device: currentMeta.device ?? device,
						} as unknown);
					}
					metaUpdated++;
				}
			}

			this.meta.forEach((value: unknown, fileId: string) => {
				const decoded = decodeFileMeta(value);
				if (!decoded) return;
				if (decoded.deleted && decoded.deletedAt === undefined) {
					// Convert legacy deleted:true to v2 flat tombstone.
					this.meta.set(fileId, {
						path: this.normPath(decoded.path),
						deletedAt: typeof decoded.mtime === "number" ? decoded.mtime : now,
					} as unknown);
					tombstonesConverted++;
					return;
				}
				const isDel = decoded.deleted === true || typeof decoded.deletedAt === "number";
				if (isDel && (decoded.deleted !== undefined || decoded.mtime !== undefined || decoded.device !== undefined)) {
					// Strip extra fields from tombstone, keep as flat v2.
					this.meta.set(fileId, {
						path: this.normPath(decoded.path),
						deletedAt: typeof decoded.deletedAt === "number" ? decoded.deletedAt : now,
					} as unknown);
					metaUpdated++;
				}
			});

			// Explicit tombstones for dropped alias paths — write flat v2.
			const existingActivePaths = new Set<string>();
			this.meta.forEach((value: unknown) => {
				if (isFileMetaDeletedValue(value)) return;
				const path = getMetaPath(value);
				if (path) existingActivePaths.add(this.normPath(path));
			});
			for (const loserPath of loserPaths) {
				if (existingActivePaths.has(loserPath)) continue;
				const tombstoneId = this.generateFileId();
				this.meta.set(tombstoneId, { path: loserPath, deletedAt: now } as unknown);
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
					const dupMeta = createNestedActiveMeta(dupPath, Date.now(), this._device);
					this.meta.set(newId, dupMeta);
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
		this.meta.forEach((value: unknown, fileId: string) => {
			if (isFileMetaDeletedValue(value)) {
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
		/**
		 * Optional admission-opId factory invoked at each authoritative-lane
		 * `seed-to-crdt` decision point BEFORE the CRDT mutation runs.
		 *
		 * Spec: .kiro/specs/no-event-reconcile-admission/requirements.md R2 (Option b).
		 *
		 * ## Contract
		 *
		 * 1. **Optionality.** When the parameter is omitted, `reconcileVault`
		 *    behaves EXACTLY as it did before this hook existed: no opId,
		 *    no decision emission from inside the seed loop, and the seed
		 *    mutation runs unchanged. Callers that do not care about
		 *    decision-before-mutation ordering MUST NOT pass it.
		 *
		 * 2. **Frequency.** When supplied, the callback is invoked EXACTLY
		 *    ONCE per `seed-to-crdt` admission decision per call to
		 *    `reconcileVault`. It is NOT invoked for `skip-in-crdt`,
		 *    `tombstone-conflict`, or `untracked` classifications. It is
		 *    NOT invoked for `createdOnDisk` or `updatedOnDisk` paths
		 *    (those are post-result loops in the controller).
		 *
		 * 3. **Ordering.** Within a single seed-to-crdt branch, the seed
		 *    loop calls `mintAdmissionOpId(path)` first, then invokes the
		 *    returned `emitDecision()` thunk, then calls `ensureFile`
		 *    with `{ opId }`. The decision emission therefore precedes the
		 *    `crdt.file.created` envelope, and both events carry the same
		 *    `opId` value — the load-bearing causality property the spec
		 *    asserts in Scenario A.
		 *
		 * 4. **Side-effect surface.** The factory and `emitDecision()` are
		 *    free to read state and emit flight events. They MUST NOT
		 *    mutate any field on this `VaultSync` instance, MUST NOT call
		 *    back into `ensureFile`, and MUST NOT call back into
		 *    `reconcileVault` (recursion is undefined).
		 *
		 * 5. **Failure semantics.** If `mintAdmissionOpId(path)` throws OR
		 *    if `emitDecision()` throws, the exception propagates UP out
		 *    of `reconcileVault` synchronously. The current path's
		 *    `ensureFile` SHALL NOT run, the path SHALL NOT be appended
		 *    to `seededToCrdt`, AND any subsequent paths in `diskPresentPaths`
		 *    are NOT classified or seeded. Recovery is the caller's
		 *    responsibility — `runReconciliation` runs inside a single
		 *    `try { ... } finally { reconcileInFlight = false; ... }`
		 *    block, so a throw here will mark the reconcile as failed
		 *    rather than half-applied.
		 *
		 *    Rationale: the seed mutation and the decision emission are
		 *    paired. If the controller cannot record the decision, we
		 *    refuse to perform the mutation. Letting the mutation through
		 *    would create a `crdt.file.created` event with no preceding
		 *    `reconcile.file.decision` — exactly the silent admission the
		 *    spec was written to prevent.
		 *
		 * 6. **No new origins / suppression / UI.** The callback is a
		 *    causality-tracking hook only. It MUST NOT introduce a new
		 *    Yjs transaction origin, a new disk-event suppression rule,
		 *    or any user-visible surface.
		 */
		mintAdmissionOpId?: (path: string) => { opId: string; emitDecision: () => void },
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

		const tombstonedDiskConflicts: TombstonedDiskConflict[] = [];

		// Disk files not in CRDT
		for (const path of diskPresentPaths) {
			const classification = classifyDiskPathForReconcile(
				path,
				crdtPaths.has(path),
				this._deletedPathIndex.has(path),
				mode,
			);

			switch (classification.action) {
				case "skip-in-crdt":
					// Already in CRDT, handled above
					continue;

				case "tombstone-conflict":
					// Disk file exists at a tombstoned path — zombie prevention
					this.log(`reconcile: "${path}" exists on disk but is tombstoned in CRDT — conflict preserved`);
					tombstonedDiskConflicts.push(classification.conflict!);
					skipped++;
					continue;

				case "seed-to-crdt": {
					const content = diskFiles.get(path);
					if (content === undefined) {
						// Presence is known, but content wasn't read this pass. Skip seeding
						// to avoid accidentally creating empty/incorrect files.
						this.log(`reconcile: "${path}" present on disk but content not loaded, skipping seed`);
						continue;
					}
					// Spec R2 / Option (b): when an admission-opId factory is
					// supplied, emit `reconcile.file.decision` BEFORE the CRDT
					// mutation and thread the shared opId into ensureFile so
					// the resulting `crdt.file.created` carries it.
					//
					// Failure semantics (see callback contract on this method):
					// if `mintAdmissionOpId` or `emitDecision` throws, the
					// exception propagates and the path's `ensureFile` is
					// NOT called, so we never emit a `crdt.file.created`
					// without a preceding `reconcile.file.decision`. The
					// path is also NOT appended to `seededToCrdt`.
					const minted = mintAdmissionOpId?.(path);
					if (minted) {
						minted.emitDecision();
						this.ensureFile(path, content, device, { opId: minted.opId });
					} else {
						this.ensureFile(path, content, device);
					}
					seededToCrdt.push(path);
					continue;
				}

				case "untracked":
					untracked.push(path);
					continue;
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
			`${tombstonedDiskConflicts.length} tombstoned-disk conflicts`,
		);

		return { mode, createdOnDisk, updatedOnDisk, seededToCrdt, untracked, tombstonedDiskConflicts, skipped };
	}

	// -------------------------------------------------------------------
	// File operations
	// -------------------------------------------------------------------

	private generateFileId(): string {
		return randomBase64Url(12);
	}

	ensureFile(
		path: string,
		currentContent: string,
		device?: string,
		options?: { reviveTombstone?: boolean; reviveReason?: string; opId?: string },
	): Y.Text | null {
		path = this.normPath(path);
		const reviveTombstone = options?.reviveTombstone === true;
		const reviveReason = options?.reviveReason ?? "unknown";
		const opId = options?.opId;

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
			if (reviveTombstone) {
				this.ydoc.transact(() => {
					for (const tombstoneId of tombstoneIds) {
						this.meta.delete(tombstoneId);
					}
				}, ORIGIN_SEED);
			this._pathIndexesDirty = true;
			this.trace?.("sync", "ensureFile-tombstone-revived", {
				path,
				tombstoneIds,
				device: device ?? null,
				reason: reviveReason,
			});
			this.onFlightPathEvent?.({
				priority: "critical",
				kind: FLIGHT_KIND.crdtFileRevived,
				severity: "info",
				scope: "file",
				source: "vaultSync",
				layer: "crdt",
				path,
				opId,
				data: { reason: reviveReason },
			});
			this.log(
				`ensureFile: "${path}" revived from tombstone (${tombstoneIds.length}) due to ${reviveReason}`,
			);
			} else {
				this.trace?.("sync", "ensureFile-tombstone-blocked", {
					path,
					tombstoneIds,
					device: device ?? null,
				});
				this.log(`ensureFile: "${path}" is tombstoned, refusing to create`);
				return null;
			}
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
		this.onFlightPathEvent?.({
			priority: "important",
			kind: FLIGHT_KIND.crdtFileCreated,
			severity: "info",
			scope: "file",
			source: "vaultSync",
			layer: "crdt",
			path,
			fileId,
			opId,
		});
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

		// Collect file IDs before the transaction for flight events.
		const renamedIds: Array<{ oldPath: string; newPath: string; fileId: string }> = [];

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
					renamedIds.push({ oldPath, newPath, fileId });
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

		// Emit crdt.file.renamed for each markdown file that was renamed.
		for (const { newPath, fileId } of renamedIds) {
			this.onFlightPathEvent?.({
				priority: "important",
				kind: FLIGHT_KIND.crdtFileRenamed,
				severity: "info",
				scope: "file",
				source: "vaultSync",
				layer: "crdt",
				path: newPath,
				fileId,
				data: { batchSize: batch.size },
			});
		}

		this._onRenameBatchFlushed?.(batch);
	}

	private clearMarkdownTombstonesForPath(path: string, keepFileId?: string): number {
		const tombstonedIds: string[] = [];
		this.meta.forEach((value: unknown, fileId: string) => {
			if (
				fileId !== keepFileId
				&& getMetaPath(value) === path
				&& isFileMetaDeletedValue(value)
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
		this.meta.forEach((value: unknown, fileId: string) => {
			if (getMetaPath(value) === normalizedPath && isFileMetaDeletedValue(value)) {
				tombstonedIds.push(fileId);
			}
		});
		return tombstonedIds;
	}

	handleDelete(path: string, device?: string, opId?: string): void {
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
		this.onFlightPathEvent?.({
			priority: "critical",
			kind: FLIGHT_KIND.crdtFileTombstoned,
			severity: "info",
			scope: "file",
			source: "vaultSync",
			layer: "crdt",
			path: resolvedPath,
			fileId,
			opId,
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

	// Update-tracking getters (delegated to UpdateTracker — INV-ACK-01)
	get lastLocalUpdateAt(): number | null { return this.updateTracker.lastLocalUpdateAt; }
	get lastLocalUpdateWhileConnectedAt(): number | null { return this.updateTracker.lastLocalUpdateWhileConnectedAt; }
	get lastRemoteUpdateAt(): number | null { return this.updateTracker.lastRemoteUpdateAt; }
	get serverAppliedLocalState(): boolean | null { return this.serverAckTracker.serverAppliedLocalState; }
	get lastServerReceiptEchoAt(): number | null { return this.serverAckTracker.lastServerReceiptEchoAt; }
	get lastKnownServerReceiptEchoAt(): number | null { return this.serverAckTracker.lastKnownServerReceiptEchoAt; }
	get serverReceiptCandidateId(): string | null { return this.serverAckTracker.lastCandidateId; }
	get lastConfirmedReceiptCandidateId(): string | null { return this.serverAckTracker.lastConfirmedCandidateId; }
	get candidatePersistenceHealthy(): boolean | null {
		if (!this._serverAckScope && !this._serverAckPersistenceUnavailable) return null;
		if (this._serverAckPersistenceUnavailable) return false;
		return this.serverAckTracker.candidatePersistenceHealthy;
	}
	get candidatePersistenceFailureCount(): number {
		return this.serverAckTracker.candidatePersistenceFailureCount + (this._serverAckPersistenceUnavailable ? 1 : 0);
	}
	get hasUnconfirmedServerReceiptCandidate(): boolean { return this.serverAckTracker.hasUnconfirmedCandidate; }
	get serverReceiptCandidateCapturedAt(): number | null { return this.serverAckTracker.candidateCapturedAt; }

	async flushReceiptPersistence(): Promise<void> {
		await this.serverAckTracker.flushReceiptPersistence();
	}
	get serverReceiptStartupValidation(): ServerReceiptStartupValidation { return this._serverReceiptStartupValidation; }
	get svEchoCounters(): SvEchoCounters { return { ...this._svEchoCounters }; }

	async clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed"> {
		if (!this._serverAckStore) {
			await this.serverAckTracker.clearLocalReceiptState(false);
			return "cleared_memory_only";
		}
		const beforeFailures = this.serverAckTracker.candidatePersistenceFailureCount;
		await this.serverAckTracker.clearLocalReceiptState(true);
		if (this.serverAckTracker.candidatePersistenceFailureCount > beforeFailures) return "failed";
		return "cleared_persistent";
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

	// -------------------------------------------------------------------
	// Socket ticket proactive refresh
	// -------------------------------------------------------------------

	/**
	 * Schedule a timer to refresh provider.url with a fresh ticket before the
	 * current one expires.  Fires at expiresAt - TICKET_REFRESH_BUFFER_MS,
	 * which is the same threshold the cache uses to decide a ticket is stale.
	 *
	 * This is the primary mechanism ensuring reconnects use a live ticket.
	 * y-partyserver's setupWS loop reads provider.url directly without
	 * re-calling the async params() callback.
	 */
	private scheduleSocketTicketRefresh(ticket: {
		value: string;
		expiresAt: number;
		localExpiresAt: number;
		ttlMs: number;
	}): void {
		this.clearSocketTicketRefreshTimer();
		const ttlRemaining = ticket.localExpiresAt - Date.now();
		const buffer = Math.min(TICKET_REFRESH_BUFFER_MS, Math.floor(ttlRemaining / 2));
		const msUntilRefresh = Math.max(250, ttlRemaining - buffer);
		this._socketTicketRefreshTimer = setTimeout(() => {
			this._socketTicketRefreshTimer = null;
			void this.refreshProviderTicketUrl(true);
		}, msUntilRefresh);
	}

	private clearSocketTicketRefreshTimer(): void {
		if (this._socketTicketRefreshTimer !== null) {
			clearTimeout(this._socketTicketRefreshTimer);
			this._socketTicketRefreshTimer = null;
		}
	}

	/**
	 * Replace the ticket value in provider.url, removing any legacy ?token=.
	 * Preserves all other query params (schemaVersion, _pk, device, trace, boot).
	 */
	private patchProviderTicket(value: string): void {
		try {
			this.provider.url = patchTicketInUrl(this.provider.url, value);
			this.log("socket ticket refreshed in provider URL");
		} catch (err) {
			this.log(`patchProviderTicket: failed to update provider URL: ${formatUnknown(err)}`);
		}
	}

	/**
	 * Fetch a fresh ticket (optionally bypassing the cache) and patch
	 * provider.url.  Reschedules the refresh timer on success.
	 * On transient failure, retries after TICKET_REFRESH_BUFFER_MS so the
	 * proactive refresh cycle survives intermittent network errors.
	 */
	private async refreshProviderTicketUrl(force = false): Promise<void> {
		if (!this._getSocketTicket) return;
		try {
			const ticket = await this._getSocketTicket(force);
			if (ticket) {
				this.patchProviderTicket(ticket.value);
				this.scheduleSocketTicketRefresh(ticket);
			}
		} catch (err) {
			this.log(`socket ticket refresh failed: ${formatUnknown(err)}`);
			// Clear any existing timer before scheduling the retry so we never
			// lose a handle and fire duplicate refreshes.  This matters when the
			// disconnected best-effort path calls here while the proactive timer
			// is already scheduled: without the clear, the proactive timer
			// handle is overwritten but the timer still fires.
			this.clearSocketTicketRefreshTimer();
			this._socketTicketRefreshTimer = setTimeout(() => {
				this._socketTicketRefreshTimer = null;
				void this.refreshProviderTicketUrl(true);
			}, TICKET_REFRESH_BUFFER_MS);
		}
	}

	async destroy(): Promise<void> {
		this.log("Destroying VaultSync");
		if (this._renameTimer) clearTimeout(this._renameTimer);
		this.clearSocketTicketRefreshTimer();
		this.clearPendingRenames();
		await this.flushReceiptPersistence();

		const provider = this.provider as any;
		const ws = provider.ws;

		// Force terminate the WebSocket to skip the 30s close handshake timeout in "ws" library (Node/Electron).
		// Safe because it's a targeted call on our own instance.
		if (ws && typeof ws.terminate === "function") {
			ws.terminate();
		}

		// Ensure Awareness interval is cleared (using public API).
		// This is defensive; awareness-protocol already binds to doc destroy.
		if (this.provider.awareness) {
			this.provider.awareness.destroy();
		}

		this.provider.destroy();
		await this.persistence.destroy();
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
		serverReceipt: ReturnType<ServerAckTracker["getState"]> & { persistenceUnavailable: boolean };
		serverReceiptStartupValidation: ServerReceiptStartupValidation;
		svEcho: SvEchoCounters;
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
			serverReceipt: {
				...this.serverAckTracker.getState(),
				persistenceUnavailable: this._serverAckPersistenceUnavailable,
			},
			serverReceiptStartupValidation: this._serverReceiptStartupValidation,
			svEcho: this.svEchoCounters,
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

export interface TombstonedDiskConflict {
	path: string;
	action: "preserved-local-only";
	reason: "disk-present-at-tombstoned-path";
}

export interface ReconcileResult {
	mode: ReconcileMode;
	createdOnDisk: string[];
	updatedOnDisk: string[];
	seededToCrdt: string[];
	untracked: string[];
	/**
	 * Disk files that exist at tombstoned paths.
	 * These are preserved locally but not synced.
	 * User should resolve manually or via explicit create action.
	 */
	tombstonedDiskConflicts: TombstonedDiskConflict[];
	skipped: number;
}

/**
 * Pure function to classify a disk path during reconciliation.
 * Exported for testing.
 *
 * @param path - The disk file path to classify
 * @param crdtHasPath - Whether the CRDT has an active (non-deleted) entry for this path
 * @param isTombstoned - Whether the path is tombstoned in the CRDT
 * @param mode - The reconciliation mode
 * @returns The classification decision
 */
export function classifyDiskPathForReconcile(
	path: string,
	crdtHasPath: boolean,
	isTombstoned: boolean,
	mode: ReconcileMode,
): {
	action: "skip-in-crdt" | "tombstone-conflict" | "seed-to-crdt" | "untracked";
	conflict?: TombstonedDiskConflict;
} {
	// Already in CRDT — skip
	if (crdtHasPath) {
		return { action: "skip-in-crdt" };
	}

	// Tombstoned in CRDT — do NOT revive (zombie prevention)
	if (isTombstoned) {
		return {
			action: "tombstone-conflict",
			conflict: {
				path,
				action: "preserved-local-only",
				reason: "disk-present-at-tombstoned-path",
			},
		};
	}

	// Not in CRDT — seed if authoritative, otherwise untracked
	if (mode === "authoritative") {
		return { action: "seed-to-crdt" };
	}

	return { action: "untracked" };
}
