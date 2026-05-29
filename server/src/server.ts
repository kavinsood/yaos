import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { runSerialized, runSingleFlight } from "./asyncConcurrency";
import { ChunkedDocStore } from "./chunkedDocStore";
import { SqlDocStore } from "./sqlDocStore";
import { readRoomMeta, type RoomMeta, writeRoomMeta } from "./roomMeta";
import {
	createSnapshot,
	hasSnapshotForDay,
	getLatestSnapshotIndex,
	verifySnapshotExists,
	computeFullUpdateHash,
	applyRetention,
	type SnapshotResult,
} from "./snapshot";
import {
	appendTraceEntry,
	listRecentTraceEntries,
	prepareTraceEntryForStorage,
	TRACE_RATE_THROTTLE_EVENT,
	TraceRateLimiter,
	type TraceEntry as StoredTraceEntry,
} from "./traceStore";
import { trySendSvEcho, type SvEchoSendResult } from "./svEcho";
import { isUpdateBearingSyncMessage } from "./syncMessageClassifier";
import { bytesToHex } from "./hex";
import { sha256Hex } from "./hex";
import {
	PersistenceCoordinator,
	type PersistenceHealth,
} from "./persistenceCoordinator";
import type { LoadedDocState } from "./sqlDocStore";

const MAX_DEBUG_TRACE_EVENTS = 200;
const JOURNAL_COMPACT_MAX_ENTRIES = 50;
const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024;
const TRACE_DEBUG_LIMIT = 100;
const LOG_PREFIX = "[yaos-sync:server]";

/**
 * If a journal append fails, fall back to full checkpoint rewrite after this
 * many consecutive failures. Breaks the death spiral where the same large
 * delta fails repeatedly from a stale persisted state vector.
 */
const CHECKPOINT_FALLBACK_AFTER_FAILURES = 2;

/**
 * If the computed delta exceeds this byte threshold, skip the journal append
 * entirely and write a full checkpoint. A delta this large is effectively a
 * checkpoint anyway, and appending it risks hitting storage/memory constraints.
 */
const CHECKPOINT_FALLBACK_DELTA_BYTES = 2 * 1024 * 1024;

/** Legacy storage key used before ChunkedDocStore was introduced. */
const LEGACY_DOCUMENT_KEY = "document";

type ServerTraceEntry = StoredTraceEntry;

interface ServerEnv {
	YAOS_BUCKET?: R2Bucket;
}

type SvEchoCounters = {
	baselineSent: number;
	postApplySent: number;
	failed: number;
	bytesTotal: number;
	bytesMax: number;
	failureNotOpen: number;
	failureOversize: number;
	failureSendFailed: number;
};

/** Server-level persistence health extends coordinator health with load-time fields. */
type ServerPersistenceHealth = PersistenceHealth & {
	loadedStateVectorHash: string | null;
	legacyDocumentMigrated: boolean;
};

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export class VaultSyncServer extends YServer {
	static options = {
		hibernate: true,
	};

	private documentLoaded = false;
	private loadPromise: Promise<void> | null = null;
	private roomIdHint: string | null = null;
	private chunkedDocStore: ChunkedDocStore | null = null;
	private sqlDocStore: SqlDocStore | null = null;
	private persistence: PersistenceCoordinator | null = null;
	private snapshotMaybeChain: Promise<void> = Promise.resolve();
	private roomMeta: RoomMeta | null = null;
	private readonly traceRateLimiter = new TraceRateLimiter();
	private readonly svEchoCounters: SvEchoCounters = {
		baselineSent: 0,
		postApplySent: 0,
		failed: 0,
		bytesTotal: 0,
		bytesMax: 0,
		failureNotOpen: 0,
		failureOversize: 0,
		failureSendFailed: 0,
	};
	/** Load-time health fields not owned by PersistenceCoordinator. */
	private loadedStateVectorHash: string | null = null;
	private legacyDocumentMigrated = false;

	/** Storage migration observability fields. */
	private storageMode: "sql" | "kv-migrated" | "fresh" | "kv-fallback" | null = null;
	private migrationStatus: "not_started" | "migrated" | "already_sql" | "failed" | null = null;
	private migrationAt: string | null = null;
	private migrationDurationMs: number | null = null;
	private coldLoadDurationMs: number | null = null;
	private oversizedDeltaCount = 0;

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
	}

	async onSave(): Promise<void> {
		await this.ensureDocumentLoaded();

		// If SQL storage is broken and we're serving from KV fallback,
		// do NOT attempt persistence.  The coordinator would try to write
		// to the broken SQL store, fail, and log noise.  More importantly,
		// accepting writes into memory while persistence is unavailable
		// creates a data-loss waiting room.  Instead, skip silently —
		// the Y.Doc in memory is ephemeral and clients are the authority.
		if (this.storageMode === "kv-fallback") {
			return;
		}

		// Delegate to PersistenceCoordinator — the single source of truth
		// for save orchestration, fallback, and health tracking.
		//
		// onSave() intentionally does NOT throw on persistence failure.
		// Failure is represented by coordinator health state:
		//   status === "degraded"
		//   pendingPersistence === true
		//   lastSaveError set
		// These are surfaced via /__yaos/debug endpoint.
		// Throwing here would only produce unhandled rejection noise in the
		// y-partyserver framework without aiding recovery. The coordinator
		// handles retry via immediate checkpoint fallback on the next save.
		const coordinator = this.getPersistenceCoordinator();
		const result = await coordinator.enqueueSave();
		if (!result.success) {
			console.error(`${LOG_PREFIX} save failed (health: degraded, pendingPersistence: true):`, result.error);
		}
		await this.syncRoomMetaFromDocument();
	}

	async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
		await super.onConnect(connection, ctx);
		this.recordSvEchoResult(trySendSvEcho(connection, this.document, "baseline"));
	}

	handleMessage(connection: Connection, message: WSMessage): void {
		const shouldEcho = isUpdateBearingSyncMessage(message);
		const svBefore = shouldEcho ? Y.encodeStateVector(this.document) : null;
		super.handleMessage(connection, message);
		if (shouldEcho) {
			const svAfter = Y.encodeStateVector(this.document);
			const docChanged = svBefore !== null && !equalBytes(svBefore, svAfter);
			// Do NOT send SV echoes in kv-fallback mode.  SV echoes signal
			// "server durably received your state."  In fallback mode persistence
			// is broken — sending echoes would give clients false confidence.
			if (this.storageMode !== "kv-fallback") {
				this.recordSvEchoResult(trySendSvEcho(connection, this.document, "postApply"));
			}
			// Fire-and-forget trace: do not block message processing.
			void this.recordTrace("server.ydoc.update_observed", {
				updateBytes: typeof message === "string" ? message.length : (message as ArrayBuffer).byteLength,
				docChanged,
			});
		}
	}

	async fetch(request: Request): Promise<Response> {
		this.captureRoomIdHint(request);

		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__yaos/meta") {
			return json({
				roomId: this.getRoomId(),
				meta: await this.readRoomMetaCheap(),
			});
		}

		if (request.method === "GET" && url.pathname === "/__yaos/document") {
			await this.ensureDocumentLoaded();
			return new Response(Y.encodeStateAsUpdate(this.document), {
				headers: {
					"Content-Type": "application/octet-stream",
					"Cache-Control": "no-store",
				},
			});
		}

		if (request.method === "GET" && url.pathname === "/__yaos/debug") {
			// Do NOT call ensureDocumentLoaded() here (issue #40 fix).
			// Debug polling is periodic and must not trigger a checkpoint load
			// on every poll.  documentSummary is conditionally included only if
			// the document is already in memory.
			const recent = await listRecentTraceEntries(this.ctx.storage, TRACE_DEBUG_LIMIT);
			const coordinator = this.getPersistenceCoordinator();
			const serverHealth: ServerPersistenceHealth = {
				...coordinator.health,
				loadedStateVectorHash: this.loadedStateVectorHash,
				legacyDocumentMigrated: this.legacyDocumentMigrated,
			};
			return json({
				roomId: this.getRoomId(),
				documentLoaded: this.documentLoaded,
				recent,
				svEcho: { ...this.svEchoCounters },
				persistence: serverHealth,
				documentSummary: this.documentLoaded ? this.getDocumentSummary() : null,
				storage: {
					mode: this.storageMode,
					migrationStatus: this.migrationStatus,
					migrationAt: this.migrationAt,
					migrationDurationMs: this.migrationDurationMs,
					coldLoadDurationMs: this.coldLoadDurationMs,
					oversizedDeltaCount: this.oversizedDeltaCount,
					migrationMeta: this.documentLoaded ? this.getSqlDocStore().getMigrationMeta() : null,
				},
			});
		}

		if (request.method === "POST" && url.pathname === "/__yaos/trace") {
			let body: { event?: string; data?: Record<string, unknown> } = {};
			try {
				body = await request.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (!body.event || typeof body.event !== "string") {
				return json({ error: "missing event" }, 400);
			}

			await this.recordTrace(body.event, body.data ?? {});
			return json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/compact") {
			if (!(this.env as any).YAOS_ENABLE_ADMIN_ROUTES) {
				return json({ error: "not found" }, 404);
			}
			await this.ensureDocumentLoaded();
			return json(await this.executeEmergencyCompact());
		}

		if (request.method === "POST" && url.pathname === "/__yaos/cleanup-kv") {
			if (!(this.env as any).YAOS_ENABLE_ADMIN_ROUTES) {
				return json({ error: "not found" }, 404);
			}
			await this.ensureDocumentLoaded();
			return json(await this.cleanupLegacyKvKeys());
		}

		if (request.method === "POST" && url.pathname === "/__yaos/snapshot-maybe") {
			await this.ensureDocumentLoaded();
			let body: { device?: string } = {};
			try {
				body = await request.json();
			} catch {
				body = {};
			}
			return json(await this.createDailySnapshotMaybe(body.device));
		}

		// PartyServer internal management routes (e.g. /cdn-cgi/partyserver/set-name/)
		// must not hydrate the document (issue #40 fix).  These are framework
		// bookkeeping calls that do not need the Y.Doc in memory.  The observed
		// offender was /cdn-cgi/partyserver/set-name/ pairing with checkpoint-load
		// on every reconnect.  Non-WebSocket internal routes are safe to delegate
		// directly to the framework without document hydration.
		const isPartyServerInternal = url.pathname.startsWith("/cdn-cgi/partyserver/");
		const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
		if (isPartyServerInternal && !isWebSocketUpgrade) {
			return super.fetch(request);
		}

		await this.ensureDocumentLoaded();
		return super.fetch(request);
	}

	private recordSvEchoResult(result: SvEchoSendResult): void {
		if (result.ok) {
			if (result.kind === "baseline") this.svEchoCounters.baselineSent++;
			if (result.kind === "postApply") this.svEchoCounters.postApplySent++;
			this.svEchoCounters.bytesTotal += result.bytes;
			this.svEchoCounters.bytesMax = Math.max(this.svEchoCounters.bytesMax, result.bytes);
			return;
		}
		this.svEchoCounters.failed++;
		if (result.failure === "not_open") this.svEchoCounters.failureNotOpen++;
		if (result.failure === "oversize") this.svEchoCounters.failureOversize++;
		if (result.failure === "send_failed") this.svEchoCounters.failureSendFailed++;
	}

	private async ensureDocumentLoaded(): Promise<void> {
		if (this.documentLoaded) return;
		const gate = { inFlight: this.loadPromise };
		const run = runSingleFlight(gate, async () => {
			if (this.documentLoaded) return;

			const coldLoadStart = performance.now();

			const sqlStore = this.getSqlDocStore();
			let sqlState: LoadedDocState | null = null;
			try {
				sqlState = sqlStore.loadState();
			} catch (sqlErr) {
				// SQL load failed (corrupt table, missing column after bad migration, etc.)
				// Attempt KV fallback — do not rethrow here.
				await this.recordTrace("sql-load-failed", {
					error: sqlErr instanceof Error ? sqlErr.message : String(sqlErr),
					note: "attempting KV fallback",
				});
			}

			// Check if SQL has data (post-migration).
			// Evaluated AFTER the try/catch: a null sqlState (SQL failure) correctly
			// reports no SQL data and routes to the KV fallback below.
			const sqlHasData = sqlState !== null && (sqlState.snapshot !== null || sqlState.journalUpdates.length > 0);

			if (sqlHasData) {
				// ── Normal SQL path ──────────────────────────────────────────
				// sqlState is guaranteed non-null here (sqlHasData implies sqlState !== null)
				if (sqlState!.snapshot) {
					Y.applyUpdate(this.document, sqlState!.snapshot);
				}
				for (const update of sqlState!.journalUpdates) {
					Y.applyUpdate(this.document, update);
				}

				const loadedSV = Y.encodeStateVector(this.document);
				this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
				this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
				this.getPersistenceCoordinator().health.journalEntryCount = sqlState!.journalStats.entryCount;
				this.getPersistenceCoordinator().health.journalBytes = sqlState!.journalStats.totalBytes;
				this.documentLoaded = true;
				this.storageMode = "sql";
				this.migrationStatus = "already_sql";
				this.coldLoadDurationMs = performance.now() - coldLoadStart;
				await this.syncRoomMetaFromDocument();
				await this.recordTrace("checkpoint-load", {
					storage: "sql",
					hasSnapshot: sqlState!.snapshot !== null,
					journalEntryCount: sqlState!.journalStats.entryCount,
					journalBytes: sqlState!.journalStats.totalBytes,
				});
				return;
			}

			// ── SQL failed: attempt KV fallback (read-only, no SQL write-back) ──
			if (sqlState === null) {
				// SQL load threw — check if KV still has usable data.
				const kvStore = this.getChunkedDocStore();
				const kvState = await kvStore.loadState();
				const kvHasData = kvState.checkpoint !== null || kvState.journalUpdates.length > 0;

				if (kvHasData) {
					// Load from KV — this is a degraded but functional state.
					// Do NOT write back to SQL; leave that for a human operator.
					if (kvState.checkpoint) Y.applyUpdate(this.document, kvState.checkpoint);
					for (const update of kvState.journalUpdates) Y.applyUpdate(this.document, update);

					const loadedSV = Y.encodeStateVector(this.document);
					this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
					this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
					this.getPersistenceCoordinator().health.journalEntryCount = kvState.journalStats.entryCount;
					this.getPersistenceCoordinator().health.journalBytes = kvState.journalStats.totalBytes;
					this.getPersistenceCoordinator().health.status = "degraded";
					this.documentLoaded = true;
					this.storageMode = "kv-fallback";
					this.migrationStatus = "failed";
					this.coldLoadDurationMs = performance.now() - coldLoadStart;
					await this.syncRoomMetaFromDocument();
					await this.recordTrace("kv-fallback-activated", {
						kvCheckpointBytes: kvState.checkpoint?.byteLength ?? 0,
						kvJournalEntries: kvState.journalStats.entryCount,
						kvJournalBytes: kvState.journalStats.totalBytes,
						activePathCount: this.countActivePathsInDoc(this.document),
						note: "SQL load failed; serving from KV in degraded read-only mode",
					});
					return;
				}

				// Neither SQL nor KV has recoverable data — storage is unrecoverable.
				// Fail-open with an empty document so the DO doesn't brick entirely.
				const loadedSV = Y.encodeStateVector(this.document);
				this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
				this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
				this.getPersistenceCoordinator().health.journalEntryCount = 0;
				this.getPersistenceCoordinator().health.journalBytes = 0;
				this.getPersistenceCoordinator().health.status = "degraded";
				this.documentLoaded = true;
				this.storageMode = "kv-fallback";
				this.migrationStatus = "failed";
				this.coldLoadDurationMs = performance.now() - coldLoadStart;
				await this.syncRoomMetaFromDocument();
				await this.recordTrace("storage-unrecoverable", {
					note: "SQL load failed and KV has no data; starting with empty document",
				});
				return;
			}

			// ── Migration path: load from old KV storage, write to SQL ───────
			const kvStore = this.getChunkedDocStore();
			const kvState = await kvStore.loadState();
			const kvHasData = kvState.checkpoint !== null || kvState.journalUpdates.length > 0;

			// Also check legacy "document" key
			const legacyRaw = await this.ctx.storage.get<unknown>(LEGACY_DOCUMENT_KEY);
			let legacyBytes: Uint8Array | null = null;
			if (legacyRaw !== undefined) {
				if (legacyRaw instanceof Uint8Array) {
					legacyBytes = legacyRaw;
				} else if (legacyRaw instanceof ArrayBuffer) {
					legacyBytes = new Uint8Array(legacyRaw);
				} else if (ArrayBuffer.isView(legacyRaw)) {
					legacyBytes = new Uint8Array(
						(legacyRaw as ArrayBufferView).buffer,
						(legacyRaw as ArrayBufferView).byteOffset,
						(legacyRaw as ArrayBufferView).byteLength,
					);
				}
			}

			if (kvHasData || (legacyBytes && legacyBytes.byteLength > 0)) {
				const migrationStart = performance.now();

				// Load into document from KV (same logic as before)
				if (legacyBytes && legacyBytes.byteLength > 0) {
					const legacyDoc = new Y.Doc();
					Y.applyUpdate(legacyDoc, legacyBytes);
					const legacyPathCount = this.countActivePathsInDoc(legacyDoc);

					const chunkedDoc = new Y.Doc();
					if (kvState.checkpoint) Y.applyUpdate(chunkedDoc, kvState.checkpoint);
					for (const update of kvState.journalUpdates) Y.applyUpdate(chunkedDoc, update);
					const chunkedPathCount = this.countActivePathsInDoc(chunkedDoc);
					const chunkedHasFileState = this.hasAnyFileStateInDoc(chunkedDoc);

					if (legacyPathCount > 0 && chunkedPathCount === 0 && !chunkedHasFileState) {
						// Legacy wins: merge legacy + chunked
						Y.applyUpdate(this.document, legacyBytes);
						if (kvState.checkpoint) Y.applyUpdate(this.document, kvState.checkpoint);
						for (const update of kvState.journalUpdates) Y.applyUpdate(this.document, update);
					} else {
						// Chunked wins: use KV state
						if (kvState.checkpoint) Y.applyUpdate(this.document, kvState.checkpoint);
						for (const update of kvState.journalUpdates) Y.applyUpdate(this.document, update);
					}
					legacyDoc.destroy();
					chunkedDoc.destroy();
					this.legacyDocumentMigrated = true;
				} else {
					// Pure KV state
					if (kvState.checkpoint) Y.applyUpdate(this.document, kvState.checkpoint);
					for (const update of kvState.journalUpdates) Y.applyUpdate(this.document, update);
				}

				// Migrate to SQL: write full state as a clean snapshot
				const migratedUpdate = Y.encodeStateAsUpdate(this.document);
				sqlStore.rewriteCheckpoint(migratedUpdate);

				const loadedSV = Y.encodeStateVector(this.document);
				this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
				this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
				this.getPersistenceCoordinator().health.journalEntryCount = 0;
				this.getPersistenceCoordinator().health.journalBytes = 0;
				this.documentLoaded = true;
				this.storageMode = "kv-migrated";
				this.migrationStatus = "migrated";
				this.migrationAt = new Date().toISOString();
				this.migrationDurationMs = performance.now() - migrationStart;
				this.coldLoadDurationMs = performance.now() - coldLoadStart;

				// Record migration marker in SQL so future loads can distinguish
				// "migrated room" from "fresh room" from "interrupted migration."
				sqlStore.recordMigration({
					sourceFormat: legacyBytes ? "legacy+kv" : "kv",
					sourceEntries: kvState.journalStats.entryCount,
					sourceBytes: kvState.journalStats.totalBytes,
					snapshotBytes: migratedUpdate.byteLength,
					activePathCount: this.countActivePathsInDoc(this.document),
					migratedAt: this.migrationAt,
				});

				await this.syncRoomMetaFromDocument();
				await this.recordTrace("kv-to-sql-migration", {
					hadLegacyKey: legacyBytes !== null,
					kvJournalEntries: kvState.journalStats.entryCount,
					kvJournalBytes: kvState.journalStats.totalBytes,
					migratedBytes: migratedUpdate.byteLength,
					activePathCount: this.countActivePathsInDoc(this.document),
					migrationDurationMs: this.migrationDurationMs,
				});

				// Best-effort: delete legacy key (don't fail if this errors)
				if (legacyBytes) {
					try { await this.ctx.storage.delete([LEGACY_DOCUMENT_KEY]); } catch {}
				}
				return;
			}

			// ── Empty state: fresh DO ────────────────────────────────────────
			const loadedSV = Y.encodeStateVector(this.document);
			this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
			this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
			this.getPersistenceCoordinator().health.journalEntryCount = 0;
			this.getPersistenceCoordinator().health.journalBytes = 0;
			this.documentLoaded = true;
			this.storageMode = "fresh";
			this.migrationStatus = "not_started";
			this.coldLoadDurationMs = performance.now() - coldLoadStart;
			await this.syncRoomMetaFromDocument();
			await this.recordTrace("checkpoint-load", {
				storage: "sql",
				hasSnapshot: false,
				journalEntryCount: 0,
				journalBytes: 0,
				note: "fresh DO, no existing state",
			});
		});
		this.loadPromise = gate.inFlight;
		try {
			await run;
		} finally {
			this.loadPromise = gate.inFlight;
		}
	}

	/** Count active (non-deleted) paths in a Y.Doc using the YAOS schema. Dual-reads flat and nested metadata. */
	private countActivePathsInDoc(doc: Y.Doc): number {
		const meta = doc.getMap("meta");
		let count = 0;
		meta.forEach((value: unknown) => {
			const path = this.readMetaPath(value);
			if (!path) return;
			if (!this.isMetaDeleted(value)) count++;
		});
		return count;
	}

	/** Check if doc has any semantic file state: meta entries, pathToId, or idToText. */
	private hasAnyFileStateInDoc(doc: Y.Doc): boolean {
		const meta = doc.getMap("meta");
		if (meta.size > 0) return true;
		const pathToId = doc.getMap("pathToId");
		if (pathToId.size > 0) return true;
		const idToText = doc.getMap("idToText");
		if (idToText.size > 0) return true;
		return false;
	}

	/**
	 * Read the path from a metadata value. Handles both flat objects (v2) and nested Y.Map (v3).
	 * Server must dual-read because persisted rooms may contain either shape.
	 */
	private readMetaPath(value: unknown): string | null {
		if (value instanceof Y.Map) {
			const path = value.get("path");
			return typeof path === "string" && path.length > 0 ? path : null;
		}
		if (typeof value === "object" && value !== null && "path" in value) {
			const path = (value as { path: unknown }).path;
			return typeof path === "string" && path.length > 0 ? path : null;
		}
		return null;
	}

	/**
	 * Check if a metadata value represents a deleted/tombstoned entry.
	 * Handles both flat objects (v2) and nested Y.Map (v3).
	 */
	private isMetaDeleted(value: unknown): boolean {
		if (value instanceof Y.Map) {
			const deletedAt = value.get("deletedAt");
			if (typeof deletedAt === "number" && Number.isFinite(deletedAt)) return true;
			return value.get("deleted") === true;
		}
		if (typeof value === "object" && value !== null) {
			const m = value as { deleted?: boolean; deletedAt?: unknown };
			if (typeof m.deletedAt === "number" && Number.isFinite(m.deletedAt)) return true;
			return m.deleted === true;
		}
		return false;
	}

	private getChunkedDocStore(): ChunkedDocStore {
		if (!this.chunkedDocStore) {
			this.chunkedDocStore = new ChunkedDocStore(this.ctx.storage);
		}
		return this.chunkedDocStore;
	}

	private getSqlDocStore(): SqlDocStore {
		if (!this.sqlDocStore) {
			this.sqlDocStore = new SqlDocStore(this.ctx.storage as any);
		}
		return this.sqlDocStore;
	}

	private getPersistenceCoordinator(): PersistenceCoordinator {
		if (!this.persistence) {
			this.persistence = new PersistenceCoordinator(
				this.document,
				this.getSqlDocStore(),
				(event, data) => {
					if (event === "save.append_oversized") {
						this.oversizedDeltaCount++;
					}
					void this.recordTrace(`server.${event}`, data);
				},
				{
					checkpointFallbackDeltaBytes: CHECKPOINT_FALLBACK_DELTA_BYTES,
					checkpointFallbackAfterFailures: CHECKPOINT_FALLBACK_AFTER_FAILURES,
					journalCompactMaxEntries: JOURNAL_COMPACT_MAX_ENTRIES,
					journalCompactMaxBytes: JOURNAL_COMPACT_MAX_BYTES,
				},
			);
		}
		return this.persistence;
	}

	/** Decoded document summary for deployment validation and diagnostics. */
	private getDocumentSummary(): {
		activePathCount: number;
		tombstonedPathCount: number;
		metaCount: number;
		pathToIdCount: number;
		idToTextCount: number;
		/** Active meta entries that have a corresponding pathToId + idToText entry. */
		activePathsWithText: number;
		/** Active meta entries missing from pathToId. */
		activePathsMissingFromPathToId: number;
		/** Active meta entries with pathToId but missing idToText. */
		activePathsMissingText: number;
		/** pathToId entries that have no corresponding active meta entry. */
		pathToIdWithoutActiveMeta: number;
		schemaVersion: unknown;
		/** v3 observability: metadata entries stored as flat JSON objects. */
		flatMetaEntries: number;
		/** v3 observability: metadata entries stored as nested Y.Map. */
		nestedMetaEntries: number;
		/** v3 observability: metadata entries that could not be decoded. */
		invalidMetaEntries: number;
	} {
		const meta = this.document.getMap("meta");
		const pathToId = this.document.getMap<string>("pathToId");
		const idToText = this.document.getMap("idToText");

		let activePathCount = 0;
		let tombstonedPathCount = 0;
		let activePathsWithText = 0;
		let activePathsMissingFromPathToId = 0;
		let activePathsMissingText = 0;
		let flatMetaEntries = 0;
		let nestedMetaEntries = 0;
		let invalidMetaEntries = 0;

		// Walk meta to count active/tombstoned and check consistency
		const activeMetaPaths = new Set<string>();
		meta.forEach((value: unknown) => {
			const path = this.readMetaPath(value);
			if (!path) {
				invalidMetaEntries++;
				return;
			}

			// Classify shape
			if (value instanceof Y.Map) {
				nestedMetaEntries++;
			} else {
				flatMetaEntries++;
			}
			const isDeleted = this.isMetaDeleted(value);
			if (isDeleted) {
				tombstonedPathCount++;
			} else {
				activePathCount++;
				activeMetaPaths.add(path);
				const id = pathToId.get(path);
				if (!id) {
					activePathsMissingFromPathToId++;
				} else if (!idToText.has(id)) {
					activePathsMissingText++;
				} else {
					activePathsWithText++;
				}
			}
		});

		// Count pathToId entries without active meta
		let pathToIdWithoutActiveMeta = 0;
		pathToId.forEach((_id: string, path: string) => {
			if (!activeMetaPaths.has(path)) {
				pathToIdWithoutActiveMeta++;
			}
		});

		return {
			activePathCount,
			tombstonedPathCount,
			metaCount: meta.size,
			pathToIdCount: pathToId.size,
			idToTextCount: idToText.size,
			activePathsWithText,
			activePathsMissingFromPathToId,
			activePathsMissingText,
			pathToIdWithoutActiveMeta,
			schemaVersion: this.document.getMap("sys").get("schemaVersion") ?? null,
			flatMetaEntries,
			nestedMetaEntries,
			invalidMetaEntries,
		};
	}

	private async readRoomMetaCheap(): Promise<RoomMeta | null> {
		const stored = await readRoomMeta(this.ctx.storage);
		if (stored) {
			this.roomMeta = stored;
		}
		if (this.documentLoaded) {
			const liveSchemaVersion = this.currentSchemaVersion();
			if (!this.roomMeta || this.roomMeta.schemaVersion !== liveSchemaVersion) {
				const nextMeta: RoomMeta = {
					schemaVersion: liveSchemaVersion,
					updatedAt: new Date().toISOString(),
				};
				this.roomMeta = nextMeta;
				void this.syncRoomMetaFromDocument();
			}
		}
		return this.roomMeta;
	}

	private currentSchemaVersion(): number | null {
		const stored = this.document.getMap("sys").get("schemaVersion");
		if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
			return stored;
		}
		return null;
	}

	private async syncRoomMetaFromDocument(): Promise<void> {
		const nextSchemaVersion = this.currentSchemaVersion();
		if (this.roomMeta && this.roomMeta.schemaVersion === nextSchemaVersion) {
			return;
		}
		const nextMeta: RoomMeta = {
			schemaVersion: nextSchemaVersion,
			updatedAt: new Date().toISOString(),
		};
		try {
			await writeRoomMeta(this.ctx.storage, nextMeta);
			this.roomMeta = nextMeta;
		} catch (err) {
			console.error(`${LOG_PREFIX} room meta persist failed:`, err);
		}
	}

	private async createDailySnapshotMaybe(
		triggeredBy?: string,
	): Promise<SnapshotResult> {
		const serialized = { chain: this.snapshotMaybeChain };
		const run = runSerialized(
			serialized,
			async () => {
				const bucket = (this.env as ServerEnv).YAOS_BUCKET;
				if (!bucket) {
					return {
						status: "unavailable",
						reason: "R2 bucket not configured",
					} satisfies SnapshotResult;
				}

				const vaultId = this.getRoomId();

				// Dedup: skip if the full encoded CRDT (including delete set) is unchanged.
				// We use fullUpdateHash because Yjs state vectors do NOT track deletions.
				// A state-vector-only check would miss delete-only changes, which is
				// catastrophic for a recovery system.
				//
				// Cost: O(doc size) to encode + hash. Acceptable at daily frequency.
				const latest = await getLatestSnapshotIndex(vaultId, bucket);
				if (latest?.fullUpdateHash) {
					const rawUpdate = Y.encodeStateAsUpdate(this.document);
					const currentHash = await sha256Hex(rawUpdate);
					if (latest.fullUpdateHash === currentHash) {
						// Before skipping: verify the pointed snapshot actually exists.
						// A poisoned latest pointer (payload never written) would
						// otherwise cause us to skip forever.
						const exists = await verifySnapshotExists(vaultId, latest, bucket);
						if (exists) {
							return {
								status: "noop",
								reason: "No changes since last snapshot (full CRDT state identical)",
							} satisfies SnapshotResult;
						}
						// Pointer is poisoned — fall through to create a new snapshot.
						// The precomputed update is still valid, pass it along.
					}
					// Hash changed — create snapshot. Pass precomputed values to avoid re-encoding.
					const index = await createSnapshot(
						this.document,
						vaultId,
						bucket,
						{
							triggeredBy,
							reason: "daily",
							pinned: false,
							precomputedRawUpdate: rawUpdate,
							precomputedFullUpdateHash: currentHash,
						},
					);

					// Retention: await so failures are observable.
					try {
						const retentionResult = await applyRetention(vaultId, bucket);
						if (retentionResult.failed > 0) {
							console.error(
								`${LOG_PREFIX} retention: ${retentionResult.failed} delete(s) failed:`,
								retentionResult.errors.slice(0, 5),
							);
						}
					} catch (err) {
						console.error(`${LOG_PREFIX} retention failed:`, err);
					}

					return {
						status: "created",
						snapshotId: index.snapshotId,
						index,
					} satisfies SnapshotResult;
				} else if (latest?.stateVectorHash) {
					// Transitional: old snapshot has stateVectorHash but no fullUpdateHash.
					// Cannot safely skip — state vector misses deletes.
					// Fall through to create a new snapshot with fullUpdateHash.
				} else if (latest) {
					// Ancient legacy path: no hash fields at all. Day-based dedup.
					const currentDay = new Date().toISOString().slice(0, 10);
					if (await hasSnapshotForDay(vaultId, currentDay, bucket)) {
						return {
							status: "noop",
							reason: `Snapshot already taken today (${currentDay})`,
						} satisfies SnapshotResult;
					}
				}

				const index = await createSnapshot(
					this.document,
					vaultId,
					bucket,
					{ triggeredBy, reason: "daily", pinned: false },
				);

				// Retention: await so failures are observable.
				try {
					const retentionResult = await applyRetention(vaultId, bucket);
					if (retentionResult.failed > 0) {
						console.error(
							`${LOG_PREFIX} retention: ${retentionResult.failed} delete(s) failed:`,
							retentionResult.errors.slice(0, 5),
						);
					}
				} catch (err) {
					console.error(`${LOG_PREFIX} retention failed:`, err);
				}

				return {
					status: "created",
					snapshotId: index.snapshotId,
					index,
				} satisfies SnapshotResult;
			},
		);
		this.snapshotMaybeChain = serialized.chain;
		return await run;
	}

	private async executeEmergencyCompact(): Promise<{
		status: string;
		journalBefore: { entryCount: number; totalBytes: number };
		journalAfter?: { entryCount: number; totalBytes: number };
		error?: string;
	}> {
		const store = this.getSqlDocStore();
		const statsBefore = store.getJournalStats();

		if (statsBefore.entryCount === 0) {
			return {
				status: "noop",
				journalBefore: statsBefore,
				journalAfter: statsBefore,
			};
		}

		try {
			const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
			store.rewriteCheckpoint(checkpointUpdate);

			// Update coordinator state
			const coordinator = this.getPersistenceCoordinator();
			const checkpointStateVector = Y.encodeStateVector(this.document);
			coordinator.setInitialStateVector(checkpointStateVector);
			coordinator.resetCompactionCircuitBreaker();

			const statsAfter = store.getJournalStats();
			coordinator.health.journalEntryCount = statsAfter.entryCount;
			coordinator.health.journalBytes = statsAfter.totalBytes;
			coordinator.health.lastCompactionAt = new Date().toISOString();
			coordinator.health.lastCompactionReason = "emergency_compact";
			coordinator.health.lastCompactionError = null;

			await this.recordTrace("server.emergency_compact_succeeded", {
				journalEntriesBefore: statsBefore.entryCount,
				journalBytesBefore: statsBefore.totalBytes,
				journalEntriesAfter: statsAfter.entryCount,
				journalBytesAfter: statsAfter.totalBytes,
				checkpointBytes: checkpointUpdate.byteLength,
			});

			return {
				status: "compacted",
				journalBefore: statsBefore,
				journalAfter: statsAfter,
			};
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);

			await this.recordTrace("server.emergency_compact_failed", {
				error: errorMessage,
				journalEntryCount: statsBefore.entryCount,
				journalBytes: statsBefore.totalBytes,
			});

			return {
				status: "failed",
				journalBefore: statsBefore,
				error: errorMessage,
			};
		}
	}

	/**
	 * One-shot cleanup of legacy KV storage keys left from the pre-SQL era.
	 * Only safe to run AFTER confirming SQL storage is healthy (document loads,
	 * sync works, journal appends succeed).
	 *
	 * Deletes: document:checkpoint:*, document:journal:*, and the legacy "document" key.
	 */
	private async cleanupLegacyKvKeys(): Promise<{
		status: string;
		keysDeleted: number;
		error?: string;
	}> {
		// Safety: verify SQL has data before wiping KV
		const sqlStore = this.getSqlDocStore();
		const sqlState = sqlStore.loadState();
		if (sqlState.snapshot === null && sqlState.journalUpdates.length === 0) {
			return {
				status: "aborted",
				keysDeleted: 0,
				error: "SQL storage is empty — refusing to delete KV data (would cause data loss)",
			};
		}

		try {
			// List all KV keys matching the old storage patterns
			const allKeys = await this.ctx.storage.list();
			const kvKeysToDelete: string[] = [];

			for (const key of allKeys.keys()) {
				if (
					key === LEGACY_DOCUMENT_KEY ||
					key.startsWith("document:checkpoint:") ||
					key.startsWith("document:journal:")
				) {
					kvKeysToDelete.push(key);
				}
			}

			if (kvKeysToDelete.length === 0) {
				return { status: "noop", keysDeleted: 0 };
			}

			// Delete in batches of 128 (CF limit per delete call)
			let deleted = 0;
			for (let i = 0; i < kvKeysToDelete.length; i += 128) {
				const batch = kvKeysToDelete.slice(i, i + 128);
				deleted += await this.ctx.storage.delete(batch);
			}

			await this.recordTrace("server.kv_cleanup_succeeded", {
				keysFound: kvKeysToDelete.length,
				keysDeleted: deleted,
			});

			return { status: "cleaned", keysDeleted: deleted };
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			return { status: "failed", keysDeleted: 0, error: errorMessage };
		}
	}

	private async recordTrace(
		event: string,
		data: Record<string, unknown>,
	): Promise<void> {
		// INV-OBS-02: per-room budget. Drop over-budget events; surface the
		// drop count via a single throttled-summary entry the next time an
		// admit succeeds. Throttle-summary entries themselves bypass the
		// rate limiter (otherwise drops could become unobservable).
		const isThrottleSummary = event === TRACE_RATE_THROTTLE_EVENT;
		if (!isThrottleSummary && !this.traceRateLimiter.admit()) {
			return;
		}

		const entry: ServerTraceEntry = prepareTraceEntryForStorage({
			...data,
			ts: new Date().toISOString(),
			event,
			roomId: this.getRoomId(),
		});

		console.debug(JSON.stringify({
			source: "yaos-sync/server",
			...entry,
		}));

		try {
			await appendTraceEntry(this.ctx.storage, entry, MAX_DEBUG_TRACE_EVENTS);
		} catch (err) {
			console.error(`${LOG_PREFIX} trace persist failed:`, err);
		}

		// Drain accumulated drops as a single bounded summary.
		if (!isThrottleSummary) {
			const dropped = this.traceRateLimiter.drainDropped();
			if (dropped > 0) {
				await this.recordTrace(TRACE_RATE_THROTTLE_EVENT, { dropped });
			}
		}
	}

	private getRoomId(): string {
		try {
			const candidate = (this as unknown as { name?: unknown }).name;
			if (typeof candidate === "string" && candidate.length > 0) {
				return candidate;
			}
		} catch {
			// Some workerd runtimes can throw while accessing `.name` before set-name.
		}
		return this.roomIdHint ?? "unknown";
	}

	private captureRoomIdHint(request: Request): void {
		const headerRoom = request.headers.get("x-partykit-room");
		if (headerRoom && headerRoom.length > 0) {
			this.roomIdHint = headerRoom;
		}
	}
}

export default VaultSyncServer;
