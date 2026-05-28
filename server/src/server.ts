import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { runSerialized, runSingleFlight } from "./asyncConcurrency";
import { ChunkedDocStore } from "./chunkedDocStore";
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

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
	}

	async onSave(): Promise<void> {
		await this.ensureDocumentLoaded();
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
			this.recordSvEchoResult(trySendSvEcho(connection, this.document, "postApply"));
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
			// Force document load so debug shows cold-loaded durable state.
			// This is critical for deployment validation of Issue #24.
			await this.ensureDocumentLoaded();
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
				documentSummary: this.getDocumentSummary(),
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

			const store = this.getChunkedDocStore();
			const state = await store.loadState();

			// First, load chunked state into a temporary doc to assess its richness
			const chunkedDoc = new Y.Doc();
			if (state.checkpoint) {
				Y.applyUpdate(chunkedDoc, state.checkpoint);
			}
			for (const update of state.journalUpdates) {
				Y.applyUpdate(chunkedDoc, update);
			}
			const chunkedPathCount = this.countActivePathsInDoc(chunkedDoc);

			// Legacy migration: check for pre-ChunkedDocStore "document" key.
			// Migrate if legacy has real content but chunked only has sentinel state.
			// The reporter's pathological shape was: legacy=full vault, chunked=2 tiny
			// sys/init entries. We must not let tiny chunked writes block migration.
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

			if (legacyBytes && legacyBytes.byteLength > 0) {
				const legacyDoc = new Y.Doc();
				Y.applyUpdate(legacyDoc, legacyBytes);
				const legacyPathCount = this.countActivePathsInDoc(legacyDoc);
				const chunkedHasFileState = this.hasAnyFileStateInDoc(chunkedDoc);

				// Migrate if:
				// - legacy has real files
				// - chunked has no active paths
				// - chunked has no semantic file state (tombstones, pathToId, meta)
				// This prevents resurrecting deleted files if chunked has tombstones.
				if (legacyPathCount > 0 && chunkedPathCount === 0 && !chunkedHasFileState) {
					// Merge: apply legacy first, then chunked on top (to preserve any
					// sys/schema updates that may have happened in chunked)
					Y.applyUpdate(this.document, legacyBytes);
					if (state.checkpoint) {
						Y.applyUpdate(this.document, state.checkpoint);
					}
					for (const update of state.journalUpdates) {
						Y.applyUpdate(this.document, update);
					}
					// Persist merged state into chunked format
					const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
					const checkpointSV = Y.encodeStateVector(this.document);
					await store.rewriteCheckpoint(checkpointUpdate, checkpointSV);

					// Delete legacy key after successful migration — best-effort
					// If deletion fails, the room should still load from chunked checkpoint.
					try {
						await this.ctx.storage.delete([LEGACY_DOCUMENT_KEY]);
					} catch (deleteErr) {
						await this.recordTrace("legacy-document-delete-failed", {
							errorMessage: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
							note: "migration completed, room will load from chunked checkpoint",
						});
					}

					this.getPersistenceCoordinator().setInitialStateVector(checkpointSV);
					this.legacyDocumentMigrated = true;
					this.loadedStateVectorHash = bytesToHex(checkpointSV.slice(0, 16));
					this.getPersistenceCoordinator().health.journalEntryCount = 0;
					this.getPersistenceCoordinator().health.journalBytes = 0;
					this.documentLoaded = true;
					await this.syncRoomMetaFromDocument();
					await this.recordTrace("legacy-document-migrated", {
						legacyBytes: legacyBytes.byteLength,
						legacyPathCount,
						chunkedPathCount,
						chunkedHasFileState,
						chunkedJournalEntries: state.journalStats.entryCount,
						checkpointBytes: checkpointUpdate.byteLength,
					});
					legacyDoc.destroy();
					chunkedDoc.destroy();
					return;
				}
				legacyDoc.destroy();
			}

			// Normal path: use chunked state
			// (chunkedDoc already has the state, just copy to this.document)
			if (state.checkpoint) {
				Y.applyUpdate(this.document, state.checkpoint);
			}
			for (const update of state.journalUpdates) {
				Y.applyUpdate(this.document, update);
			}
			chunkedDoc.destroy();

			const loadedSV = (
				state.checkpointStateVector && state.journalUpdates.length === 0
			)
				? state.checkpointStateVector.slice()
				: Y.encodeStateVector(this.document);
			this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
			this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
			this.getPersistenceCoordinator().health.journalEntryCount = state.journalStats.entryCount;
			this.getPersistenceCoordinator().health.journalBytes = state.journalStats.totalBytes;
			this.documentLoaded = true;
			await this.syncRoomMetaFromDocument();
			await this.recordTrace("checkpoint-load", {
				hasCheckpoint: state.checkpoint !== null,
				checkpointStateVectorBytes: state.checkpointStateVector?.byteLength ?? 0,
				journalEntryCount: state.journalStats.entryCount,
				journalBytes: state.journalStats.totalBytes,
				replayMode:
					state.checkpoint !== null && state.journalUpdates.length > 0
						? "checkpoint+journal"
						: state.checkpoint !== null
							? "checkpoint-only"
							: state.journalUpdates.length > 0
								? "journal-only"
								: "empty",
			});
		});
		this.loadPromise = gate.inFlight;
		try {
			await run;
		} finally {
			this.loadPromise = gate.inFlight;
		}
	}

	/** Count active (non-deleted) paths in a Y.Doc using the YAOS schema. */
	private countActivePathsInDoc(doc: Y.Doc): number {
		const meta = doc.getMap("meta");
		let count = 0;
		meta.forEach((value: unknown) => {
			if (
				typeof value === "object"
				&& value !== null
				&& "path" in value
				&& typeof (value as { path: unknown }).path === "string"
			) {
				const m = value as { deleted?: boolean; deletedAt?: number };
				const isDeleted = m.deleted === true
					|| (typeof m.deletedAt === "number" && Number.isFinite(m.deletedAt));
				if (!isDeleted) count++;
			}
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

	private getChunkedDocStore(): ChunkedDocStore {
		if (!this.chunkedDocStore) {
			this.chunkedDocStore = new ChunkedDocStore(this.ctx.storage);
		}
		return this.chunkedDocStore;
	}

	private getPersistenceCoordinator(): PersistenceCoordinator {
		if (!this.persistence) {
			this.persistence = new PersistenceCoordinator(
				this.document,
				this.getChunkedDocStore(),
				(event, data) => {
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
	} {
		const meta = this.document.getMap("meta");
		const pathToId = this.document.getMap<string>("pathToId");
		const idToText = this.document.getMap("idToText");

		let activePathCount = 0;
		let tombstonedPathCount = 0;
		let activePathsWithText = 0;
		let activePathsMissingFromPathToId = 0;
		let activePathsMissingText = 0;

		// Walk meta to count active/tombstoned and check consistency
		const activeMetaPaths = new Set<string>();
		meta.forEach((value: unknown) => {
			if (
				typeof value === "object"
				&& value !== null
				&& "path" in value
				&& typeof (value as { path: unknown }).path === "string"
			) {
				const path = (value as { path: string }).path;
				const m = value as { deleted?: boolean; deletedAt?: number };
				const isDeleted = m.deleted === true
					|| (typeof m.deletedAt === "number" && Number.isFinite(m.deletedAt));
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
