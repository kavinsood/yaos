import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { runSerialized, runSingleFlight } from "./asyncConcurrency";
import {
	buildDocumentSummary,
	type DocumentSummary,
} from "./documentSummary";
import { reapTombstonedBodies, type ReapResult } from "./tombstoneReaper";
import { SqlDocStore } from "./sqlDocStore";
import { readRoomMeta, type RoomMeta, writeRoomMeta } from "./roomMeta";
import {
	createSnapshot,
	hasSnapshotForDay,
	getLatestSnapshotIndex,
	verifySnapshotExists,
	applyRetention,
	type SnapshotResult,
} from "./snapshot";
import {
	TraceRing,
	listRecentTraceEntries,
	prepareTraceEntryForStorage,
	TRACE_RATE_THROTTLE_EVENT,
	TraceRateLimiter,
	type TraceEntry as StoredTraceEntry,
} from "./traceStore";
import { trySendSvEcho, type SvEchoSendResult } from "./svEcho";
import { isUpdateBearingSyncMessage } from "./syncMessageClassifier";
import { bytesToHex, sha256Hex } from "./hex";
import {
	PersistenceCoordinator,
	type PersistenceHealth,
} from "./persistenceCoordinator";
import type { LoadedDocState } from "./sqlDocStore";
import type { Env } from "./routes/types";
import { json } from "./routes/http";

const MAX_DEBUG_TRACE_EVENTS = 200;
const TRACE_DEBUG_LIMIT = 100;

const LOG_PREFIX = "[yaos-sync:server]";

type ServerTraceEntry = StoredTraceEntry;

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
};

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function disabledAdminRouteResponse(
	env: Pick<Env, "YAOS_ENABLE_ADMIN_ROUTES">,
): Response | null {
	return env.YAOS_ENABLE_ADMIN_ROUTES
		? null
		: json({ error: "not found" }, 404);
}

export function shouldBypassDocumentLoadForPartyServerRequest(
	pathname: string,
	isWebSocketUpgrade: boolean,
): boolean {
	return pathname.startsWith("/cdn-cgi/partyserver/") && !isWebSocketUpgrade;
}

/**
 * The per-room Durable Object.
 *
 * Parameterised with the same `Env` the HTTP routes use, so `this.env` is the
 * real binding set. partyserver defaults that parameter to the empty
 * `Cloudflare.Env`, which is why every binding read used to need a cast: the
 * admin-route flag went through `as any`, and the R2 bucket through a second,
 * partial `ServerEnv` interface declared locally in this file. Both are gone —
 * a binding that is not in routes/types.ts is now a compile error here.
 */
export class VaultSyncServer extends YServer<Env> {
	static options = {
		hibernate: true,
	};

	private documentLoaded = false;
	private destroyed = false;
	private loadPromise: Promise<void> | null = null;
	private roomIdHint: string | null = null;
	private sqlDocStore: SqlDocStore | null = null;
	private persistence: PersistenceCoordinator | null = null;
	private snapshotMaybeChain: Promise<void> = Promise.resolve();
	private roomMeta: RoomMeta | null = null;
	private destroyPromise: Promise<void> | null = null;
	private readonly inFlightWork = new Set<Promise<unknown>>();
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
	/**
	 * Why this room refuses to serve, when it does.
	 *
	 * SQL is the only copy of the document, so a store that will not read
	 * leaves this room with no state at all.  Set from the failure that
	 * `SqlDocStore.loadState()` threw; while it is set `documentLoaded` stays
	 * false and every entry point refuses.  Surfaced on /__yaos/debug so the
	 * refusal is diagnosable without reading logs.
	 */
	private loadFailure: string | null = null;

	/** Tombstone-reap observability fields. */
	private tombstoneReapAttempted = false;
	private lastTombstoneReap: ReapResult | null = null;
	/**
	 * Cumulative reap history, persisted across instances.
	 *
	 * `lastTombstoneReap` alone is actively misleading.  Reaping runs once per
	 * instance, so every instance AFTER a successful reap reports
	 * `reaped: 0, alreadyReaped: N` — indistinguishable at a glance from a
	 * reaper that has never worked.  The durable trace holds the real event but
	 * is a 200-entry ring that a busy room evicts within minutes.
	 *
	 * These totals are the answer to "has reaping ever reclaimed anything, and
	 * how much".  One storage write per EFFECTIVE reap only — reaps that free
	 * nothing, which is almost all of them, cost nothing.
	 */
	private reapTotals: {
		effectiveRuns: number;
		bodiesReaped: number;
		charsFreed: number;
		lastEffectiveAt: string | null;
		lastEffective: ReapResult | null;
	} | null = null;
	private coldLoadDurationMs: number | null = null;
	private oversizedDeltaCount = 0;

	private throwIfDestroyed(): void {
		if (this.destroyed) {
			throw new Error(`${LOG_PREFIX} vault destroyed`);
		}
	}

	private trackInFlight<T>(work: Promise<T>): Promise<T> {
		this.inFlightWork.add(work);
		void work.then(
			() => { this.inFlightWork.delete(work); },
			() => { this.inFlightWork.delete(work); },
		);
		return work;
	}

	private async drainInFlightWork(): Promise<void> {
		while (this.inFlightWork.size > 0) {
			await Promise.allSettled([...this.inFlightWork]);
		}
	}

	private beginDestroy(): Promise<void> {
		if (this.destroyPromise) return this.destroyPromise;

		// This is a terminal fence, set before the first await. Every entry point
		// observes it before it can start more persistence work.
		this.destroyed = true;
		for (const connection of this.getConnections()) {
			try {
				connection.close(4000, "vault destroyed");
			} catch {
				// Storage deletion remains authoritative.
			}
		}

		const load = this.loadPromise;
		const coordinator = this.persistence;
		const snapshots = this.snapshotMaybeChain;
		this.destroyPromise = (async () => {
			// Explicitly drain each independent writer. The general work set also
			// catches room-meta and trace writes spawned by an operation already
			// in flight when the fence was raised.
			await Promise.allSettled([
				...(load ? [load] : []),
				...(coordinator ? [coordinator.drain()] : []),
				snapshots,
			]);
			await this.drainInFlightWork();

			coordinator?.dispose();
			this.documentLoaded = false;
			this.loadPromise = null;
			this.sqlDocStore = null;
			this.persistence = null;
			this.roomMeta = null;
			await this.ctx.storage.deleteAll();
		})();
		return this.destroyPromise;
	}

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
	}

	async onSave(): Promise<void> {
		if (this.destroyed) return;
		await this.trackInFlight((async () => {
			await this.ensureDocumentLoaded();
			if (this.destroyed) return;

			// Delegate to PersistenceCoordinator — the single source of truth
			// for save orchestration, fallback, and health tracking.
			//
			// onSave() intentionally does NOT throw on persistence failure.
			// Failure is represented by coordinator health state and surfaced via
			// /__yaos/debug. The coordinator retries through checkpoint fallback.
			const coordinator = this.getPersistenceCoordinator();
			const result = await coordinator.enqueueSave();
			if (this.destroyed) return;
			if (!result.success) {
				console.error(`${LOG_PREFIX} save failed (health: degraded, pendingPersistence: true):`, result.error);
			}
			await this.syncRoomMetaFromDocument();
		})());
	}

	/**
	 * There is no re-materialisation here, scheduled or manual, and no swap to
	 * reinstate one.  The save path already encodes on every debounced save,
	 * which flattens rope as a side effect; what remains is struct
	 * fragmentation, which a round trip cannot merge. Rationale and
	 * measurements: docs/architecture.md § Vault model.
	 */

	async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
		if (this.destroyed) {
			try {
				connection.close(4000, "vault destroyed");
			} catch {
				// The isolate is already shutting down.
			}
			return;
		}
		await super.onConnect(connection, ctx);
		this.recordSvEchoResult(trySendSvEcho(connection, this.document, "baseline", this.svEchoDurability()));
	}

	/**
	 * Monotonic count of Y.Doc "update" events.
	 *
	 * Used to tell whether applying a message actually changed the document.
	 * A state-vector diff cannot answer that: the SV tracks insert clocks only,
	 * so a delete-only update leaves it byte-identical and `docChanged` would
	 * report false for a 2KB deletion.  One long-lived listener avoids
	 * attaching and detaching per message, which would need a finally block and
	 * leak a listener whenever the parent handler throws.
	 */
	private docUpdateCount = 0;
	private docUpdateWatcherAttached = false;
	/**
	 * Aggregate for update-bearing WebSocket messages.
	 *
	 * Replaces a per-message trace: see the note in handleMessage.  Lives
	 * outside `recent` so it survives trace eviction, which is the entire point.
	 */
	private readonly updateStats = {
		messages: 0,
		changed: 0,
		unchanged: 0,
		bytesTotal: 0,
		bytesMax: 0,
	};
	/**
	 * One ring per instance so trimming needs no per-trace `list`.  See
	 * TraceRing: the naive form cost ~201 rows read per trace and was the whole
	 * of this room's read amplification.
	 */
	private readonly traceRing = new TraceRing(MAX_DEBUG_TRACE_EVENTS);

	private ensureDocUpdateWatcher(): void {
		if (this.docUpdateWatcherAttached) return;
		this.docUpdateWatcherAttached = true;
		this.document.on("update", () => { this.docUpdateCount++; });
	}

	handleMessage(connection: Connection, message: WSMessage): void {
		const shouldEcho = isUpdateBearingSyncMessage(message);
		this.ensureDocUpdateWatcher();
		const svBefore = shouldEcho ? Y.encodeStateVector(this.document) : null;
		const updatesBefore = this.docUpdateCount;
		super.handleMessage(connection, message);
		if (shouldEcho) {
			const svAfter = Y.encodeStateVector(this.document);
			// The counter is the signal that sees deletions; the state-vector
			// comparison is a second opinion for inserts.
			const docChanged =
				this.docUpdateCount !== updatesBefore
				|| (svBefore !== null && !equalBytes(svBefore, svAfter));
			this.recordSvEchoResult(trySendSvEcho(connection, this.document, "postApply", this.svEchoDurability()));
			// Counted, not traced.
			//
			// This is the only per-message trace site in the server, and it was
			// drowning everything else.  Each recordTrace costs a put, a
			// list(cap+1) and a delete inside appendTraceEntry — roughly 2 rows
			// written and 200 rows read EVERY time — so tracing per message both
			// evicted every rare event from the 100-entry read window (98 of 100
			// entries observed on a live vault) and produced ~100:1 read
			// amplification against a daily row budget shared with sync.
			//
			// The aggregate is what anyone actually reads, and it lives in
			// updateStats below, outside `recent`, where trace eviction cannot
			// hide it.  Per-message detail remains in the Workers log via
			// console.debug, matching how syncSocket.ts handles its own hot-path
			// admission events.
			const updateBytes = typeof message === "string"
				? message.length
				: (message as ArrayBuffer).byteLength;
			this.updateStats.messages++;
			if (docChanged) this.updateStats.changed++;
			else this.updateStats.unchanged++;
			this.updateStats.bytesTotal += updateBytes;
			if (updateBytes > this.updateStats.bytesMax) this.updateStats.bytesMax = updateBytes;
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
			//
			// crdtFootprint is opt-in (?census=1) for the same reason: it walks
			// every struct and re-encodes the whole document, which is far too
			// expensive to run on a poll.
			const wantCensus = url.searchParams.get("census") === "1";
			const recent = await listRecentTraceEntries(this.ctx.storage, TRACE_DEBUG_LIMIT);
			const coordinator = this.getPersistenceCoordinator();
			const serverHealth: ServerPersistenceHealth = {
				...coordinator.health,
				loadedStateVectorHash: this.loadedStateVectorHash,
			};
			return json({
				roomId: this.getRoomId(),
				documentLoaded: this.documentLoaded,
				recent,
				svEcho: { ...this.svEchoCounters },
				persistence: serverHealth,
				documentSummary: this.documentLoaded ? this.getDocumentSummary() : null,
				crdtFootprint: wantCensus && this.documentLoaded ? this.getCrdtFootprint() : null,
				storage: {
					coldLoadDurationMs: this.coldLoadDurationMs,
					oversizedDeltaCount: this.oversizedDeltaCount,
					// Non-null only when the SQL store would not read.  While it
					// is set the room is refusing to serve.
					loadFailure: this.loadFailure,
				},
				updateStats: { ...this.updateStats },
				// Cheap enough to poll; see getCheapFootprint.  This is the
				// series to watch for rope drift in production.
				footprint: this.documentLoaded ? this.getCheapFootprint() : null,
				tombstoneReap: this.lastTombstoneReap,
				// Cumulative, durable, and the only reap figure that is not
				// misleading after the work has already been done.
				tombstoneReapTotals: await this.loadReapTotals(),
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
			const rejection = disabledAdminRouteResponse(this.env);
			if (rejection) return rejection;
			await this.ensureDocumentLoaded();
			this.throwIfDestroyed();
			return json(await this.executeEmergencyCompact());
		}

		if (request.method === "POST" && url.pathname === "/__yaos/delete-all") {
			await this.beginDestroy();
			return json({ ok: true });
		}

		if (request.method === "POST" && url.pathname === "/__yaos/snapshot-maybe") {
			await this.ensureDocumentLoaded();
			this.throwIfDestroyed();
			let body: { device?: string } = {};
			try {
				body = await request.json();
			} catch {
				body = {};
			}
			this.throwIfDestroyed();
			return json(await this.createDailySnapshotMaybe(body.device));
		}

		// PartyServer internal management routes do not need the Y.Doc. Keep
		// WebSocket upgrades on the ordinary hydrated path.
		const isWebSocketUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
		if (shouldBypassDocumentLoadForPartyServerRequest(url.pathname, isWebSocketUpgrade)) {
			return super.fetch(request);
		}

		await this.ensureDocumentLoaded();
		return super.fetch(request);
	}

	/**
	 * Durability marker for the sv-echo: how many times this coordinator has
	 * successfully persisted, and which instance is counting.  Lets a client
	 * distinguish "applied in memory" from "stored", which the state vector
	 * cannot express for deletions.
	 */
	private svEchoDurability(): { generation: number; epoch: string; degraded?: boolean } {
		const health = this.getPersistenceCoordinator().health;
		// "degraded" means echoes still flow while writes are failing.  A room
		// whose state would not load never reaches this path: it has no
		// connections to echo to.
		const degraded = health.status === "degraded";
		return {
			generation: health.persistedGeneration,
			epoch: health.generationEpoch,
			...(degraded ? { degraded: true } : {}),
		};
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
		this.throwIfDestroyed();
		if (this.documentLoaded) return;
		const gate = { inFlight: this.loadPromise };
		const run = runSingleFlight(gate, async () => {
			this.throwIfDestroyed();
			if (this.documentLoaded) return;

			const coldLoadStart = performance.now();

			const sqlStore = this.getSqlDocStore();
			let sqlState: LoadedDocState;
			try {
				sqlState = sqlStore.loadState();
			} catch (sqlErr) {
				// Fail closed.  SQL is the only copy of the document: there is
				// no second store to consult, and an unreadable checkpoint is
				// indistinguishable from an absent one.  Serving an empty Y.Doc
				// would be strictly worse than serving nothing — the first
				// client to sync against it sees the vault as emptied, and the
				// next save writes that emptiness over the state we could not
				// read.
				//
				// `documentLoaded` is left false and this rejects, so no
				// WebSocket upgrade, save, or document read can proceed.  The
				// single-flight gate clears on rejection, so the next entry
				// point retries the load and a transient failure recovers
				// without operator action.
				const message = sqlErr instanceof Error ? sqlErr.message : String(sqlErr);
				this.loadFailure = message;
				this.getPersistenceCoordinator().health.status = "degraded";
				this.coldLoadDurationMs = performance.now() - coldLoadStart;
				await this.recordTrace("storage-unreadable-refusing-service", {
					error: message,
					note: "SQL is the only copy of the document; serving an empty room would propagate data loss",
				});
				throw new Error(
					`${LOG_PREFIX} refusing to serve room: document storage is unreadable: ${message}`,
				);
			}
			this.loadFailure = null;

			const sqlHasData = sqlState.snapshot !== null || sqlState.journalUpdates.length > 0;

			if (sqlHasData) {
				if (sqlState.snapshot) {
					Y.applyUpdate(this.document, sqlState.snapshot);
				}
				for (const update of sqlState.journalUpdates) {
					Y.applyUpdate(this.document, update);
				}

				const loadedSV = Y.encodeStateVector(this.document);
				this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
				this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
				this.getPersistenceCoordinator().health.journalEntryCount = sqlState.journalStats.entryCount;
				this.getPersistenceCoordinator().health.journalBytes = sqlState.journalStats.totalBytes;
				this.documentLoaded = true;
				this.coldLoadDurationMs = performance.now() - coldLoadStart;
				await this.syncRoomMetaFromDocument();
				this.throwIfDestroyed();
				await this.recordTrace("checkpoint-load", {
					storage: "sql",
					hasSnapshot: sqlState.snapshot !== null,
					journalEntryCount: sqlState.journalStats.entryCount,
					journalBytes: sqlState.journalStats.totalBytes,
				});
				this.throwIfDestroyed();
				return;
			}

			// ── Empty state: fresh DO ────────────────────────────────────────
			const loadedSV = Y.encodeStateVector(this.document);
			this.getPersistenceCoordinator().setInitialStateVector(loadedSV);
			this.loadedStateVectorHash = bytesToHex(loadedSV.slice(0, 16));
			this.getPersistenceCoordinator().health.journalEntryCount = 0;
			this.getPersistenceCoordinator().health.journalBytes = 0;
			this.documentLoaded = true;
			this.coldLoadDurationMs = performance.now() - coldLoadStart;
			await this.syncRoomMetaFromDocument();
			this.throwIfDestroyed();
			await this.recordTrace("checkpoint-load", {
				storage: "sql",
				hasSnapshot: false,
				journalEntryCount: 0,
				journalBytes: 0,
				note: "fresh DO, no existing state",
			});
			this.throwIfDestroyed();
		});
		this.loadPromise = gate.inFlight;
		try {
			await this.trackInFlight(run);
		} finally {
			this.loadPromise = gate.inFlight;
		}
		this.throwIfDestroyed();

		// Both load paths funnel through here, so this is the one place the
		// reaper can run exactly once per instance without duplicating the call
		// across the loaded and fresh branches.  A room that refused to load
		// never gets here: ensureDocumentLoaded rejects before this point.
		await this.maybeReapTombstonedBodies();
		this.throwIfDestroyed();
	}

	/**
	 * Reclaim the Y.Text bodies of long-tombstoned files, once per instance.
	 *
	 * Deleting a file leaves its body in `idToText` forever — see
	 * tombstoneReaper.ts for why that happens and why removing it is safe.  The
	 * resulting update is an ordinary document change, so the framework's
	 * debounced save picks it up like any edit; the persistence coordinator's
	 * dirty flag is what guarantees a deletion-only change is actually written.
	 *
	 * Cold load is the trigger rather than an alarm: hibernation makes cold
	 * loads frequent enough to be effectively periodic, and every setAlarm()
	 * costs a row written against a daily free-tier budget shared with sync.
	 */
	private async maybeReapTombstonedBodies(): Promise<void> {
		if (this.destroyed) return;
		if (this.tombstoneReapAttempted) return;
		this.tombstoneReapAttempted = true;
		if (!this.documentLoaded) return;

		try {
			const result = reapTombstonedBodies(this.document);
			this.lastTombstoneReap = result;
			if (result.tombstones > 0) {
				await this.recordTrace("tombstone-reap", { ...result });
				if (this.destroyed) return;
			}

			// Persist explicitly rather than relying on the framework's
			// debounced save.  y-partyserver registers its document "update"
			// listener AFTER awaiting onLoad(), and this runs inside onLoad, so
			// the reap's update predates that listener and would otherwise wait
			// for an unrelated edit to flush it — or be discarded on eviction and
			// redone on the next load.
			if (result.reaped > 0) {
				// A forced checkpoint, not an append.  Appending the removal
				// leaves the entries that INSERTED the reaped bodies in the
				// journal, and a journal is replayed verbatim on every cold
				// load — so each subsequent load would re-materialise exactly
				// the content the reap just removed.  Measured: ~6.3MiB
				// resident replaying [insert, reap] versus ~0.4MiB loading the
				// equivalent checkpoint.  Without this the reaper reclaims
				// memory only for the instance that ran it.
				const save = await this.getPersistenceCoordinator()
					.forceCheckpoint("tombstone-reap");
				if (this.destroyed) return;
				if (!save.success) {
					console.error(
						`${LOG_PREFIX} tombstone reap could not be persisted; ` +
						`bodies remain until the next attempt:`, save.error,
					);
				}

				// Only an effective reap updates the durable totals, and only
				// after the bodies are actually gone from storage — recording a
				// reclaim that failed to persist would overstate what the next
				// instance will find.
				if (save.success) await this.recordEffectiveReap(result);
			}
		} catch (err) {
			// Maintenance must never break a room load.
			console.error(`${LOG_PREFIX} tombstone reap failed:`, err);
		}
	}

	/** Storage key for the durable reap totals. */
	private static readonly REAP_TOTALS_KEY = "tombstone:reap:totals";

	/**
	 * Load the cumulative reap history, once per instance.
	 *
	 * Falls back to zeros on a read failure rather than throwing: these are
	 * observability counters, and losing them must never fail a debug response
	 * or, worse, a room load.
	 */
	private async loadReapTotals(): Promise<NonNullable<VaultSyncServer["reapTotals"]>> {
		if (this.reapTotals) return this.reapTotals;
		const empty = {
			effectiveRuns: 0,
			bodiesReaped: 0,
			charsFreed: 0,
			lastEffectiveAt: null as string | null,
			lastEffective: null as ReapResult | null,
		};
		try {
			const stored = await this.ctx.storage.get(VaultSyncServer.REAP_TOTALS_KEY);
			if (stored && typeof stored === "object") {
				this.reapTotals = { ...empty, ...(stored as Partial<typeof empty>) };
				return this.reapTotals;
			}
		} catch {
			// Unreadable — report zeros rather than failing the caller.
		}
		this.reapTotals = empty;
		return this.reapTotals;
	}

	/** Fold an effective reap into the durable totals. */
	private async recordEffectiveReap(result: ReapResult): Promise<void> {
		try {
			const totals = await this.loadReapTotals();
			if (this.destroyed) return;
			totals.effectiveRuns++;
			totals.bodiesReaped += result.reaped;
			totals.charsFreed += result.charsFreed;
			totals.lastEffectiveAt = new Date().toISOString();
			totals.lastEffective = result;
			await this.ctx.storage.put(VaultSyncServer.REAP_TOTALS_KEY, totals);
		} catch (err) {
			console.error(`${LOG_PREFIX} could not record reap totals:`, err);
		}
	}

	private getSqlDocStore(): SqlDocStore {
		this.throwIfDestroyed();
		if (!this.sqlDocStore) {
			this.sqlDocStore = new SqlDocStore(this.ctx.storage);
		}
		return this.sqlDocStore;
	}

	private getPersistenceCoordinator(): PersistenceCoordinator {
		this.throwIfDestroyed();
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
			);
		}
		return this.persistence;
	}

	/**
	 * In-memory CRDT footprint census.
	 *
	 * Two very different things can make a Y.Doc expensive in RAM, and they
	 * need opposite remedies:
	 *
	 *   - Cons-string accumulation.  Yjs merges adjacent ContentString items
	 *     with `str += str`.  Under fine-grained editing that runs millions of
	 *     times and V8 keeps a deep rope it will not flatten.  Struct count
	 *     stays low, memory climbs.  A re-encode would flatten it — which is
	 *     exactly what the save path already does on every debounced save.
	 *   - Item fragmentation.  Non-adjacent or multi-client edits produce
	 *     structs Yjs cannot merge.  Struct count climbs and stays climbed.
	 *     Nothing recovers it; this is the regime that actually binds.
	 *
	 * `bytesPerStruct` separates them: ~10^4 means few large items (rope
	 * regime), ~10^1 means many small items (fragmentation regime).  Benchmark
	 * for the same metrics on synthetic corpora: scripts/bench-memory.mjs.
	 *
	 * This walks every struct and fully re-encodes the document, so it is far
	 * too expensive for the periodic debug poll and is opt-in only.
	 */
	private getCrdtFootprint(): {
		clients: number;
		structs: number;
		items: number;
		gcs: number;
		deletedItems: number;
		liveChars: number;
		encodedBytes: number;
		bytesPerStruct: number;
		itemsPerKB: number;
		databaseSizeBytes: number | null;
	} {
		let structs = 0;
		let items = 0;
		let gcs = 0;
		let deletedItems = 0;
		let liveChars = 0;

		for (const structList of this.document.store.clients.values()) {
			structs += structList.length;
			for (const struct of structList) {
				// instanceof, not constructor.name: class names do not survive
				// minification in the released bundle.
				if (!(struct instanceof Y.Item)) {
					gcs++;
					continue;
				}
				items++;
				if (struct.deleted) deletedItems++;
				else liveChars += struct.length;
			}
		}

		const encodedBytes = Y.encodeStateAsUpdate(this.document).byteLength;

		let databaseSizeBytes: number | null = null;
		try {
			const size = this.ctx.storage.sql?.databaseSize;
			if (typeof size === "number") databaseSizeBytes = size;
		} catch {
			// KV-backed or unavailable — reported as null rather than failing
			// the whole debug response.
		}

		return {
			clients: this.document.store.clients.size,
			structs,
			items,
			gcs,
			deletedItems,
			liveChars,
			encodedBytes,
			bytesPerStruct: structs > 0 ? encodedBytes / structs : 0,
			itemsPerKB: liveChars > 0 ? items / (liveChars / 1024) : 0,
			databaseSizeBytes,
		};
	}

	/**
	 * Footprint numbers cheap enough to return on every debug poll.
	 *
	 * getCrdtFootprint() is the honest measurement but it re-encodes the whole
	 * document, so it can only ever be opt-in — which makes it useless for the
	 * thing we actually want, which is watching drift over time in production.
	 *
	 * Everything here is O(clients) or O(1):
	 *   - struct count sums the per-client array lengths without touching a
	 *     single struct, so it does not grow with document size.
	 *   - databaseSize is a SQLite property read.
	 *
	 * `structs` is the number that matters.  Memory scales with struct count at
	 * roughly 117 bytes each, not with characters: 12.5MB of freshly synced text
	 * costs ~3,300 structs, while 30,000 scattered edits to the same vault cost
	 * ~30,000 more.  Against a 128MB isolate that puts the ceiling near 850,000
	 * structs, and it is reached by fragmentation rather than by size.
	 *
	 * Deliberately no derived ratio.  An earlier version divided stored bytes by
	 * struct count and called it bytesPerStruct, which mixes two denominators --
	 * stored bytes include the journal, the snapshot and SQLite page overhead --
	 * and this whole line of work is a monument to what convenient proxies cost.
	 * Both raw numbers are here; divide them if you want to, knowing what you
	 * divided.
	 */
	private getCheapFootprint(): {
		clients: number;
		structs: number;
		databaseSizeBytes: number | null;
		updatesApplied: number;
	} {
		let structs = 0;
		for (const structList of this.document.store.clients.values()) {
			structs += structList.length;
		}

		let databaseSizeBytes: number | null = null;
		try {
			const size = this.ctx.storage.sql?.databaseSize;
			if (typeof size === "number") databaseSizeBytes = size;
		} catch {
			// KV-backed or unavailable — null rather than failing the response.
		}

		return {
			clients: this.document.store.clients.size,
			structs,
			databaseSizeBytes,
			updatesApplied: this.docUpdateCount,
		};
	}

	/**
	 * Decoded document summary for deployment validation and diagnostics.
	 *
	 * Delegated to documentSummary.ts so the counting rules are testable against
	 * a constructed document; they were not before, which is how a healthy
	 * 92-file vault came to report activePathsWithText: 0 unchallenged.
	 */
	private getDocumentSummary(): DocumentSummary {
		return buildDocumentSummary(this.document);
	}

	private async readRoomMetaCheap(): Promise<RoomMeta | null> {
		this.throwIfDestroyed();
		return await this.trackInFlight((async () => {
			const stored = await readRoomMeta(this.ctx.storage);
			this.throwIfDestroyed();
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
		})());
	}

	private currentSchemaVersion(): number | null {
		const stored = this.document.getMap("sys").get("schemaVersion");
		if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
			return stored;
		}
		return null;
	}

	private async syncRoomMetaFromDocument(): Promise<void> {
		if (this.destroyed) return;
		await this.trackInFlight((async () => {
			const nextSchemaVersion = this.currentSchemaVersion();
			if (this.roomMeta && this.roomMeta.schemaVersion === nextSchemaVersion) {
				return;
			}
			const nextMeta: RoomMeta = {
				schemaVersion: nextSchemaVersion,
				updatedAt: new Date().toISOString(),
			};
			try {
				if (this.destroyed) return;
				await writeRoomMeta(this.ctx.storage, nextMeta);
				if (this.destroyed) return;
				this.roomMeta = nextMeta;
			} catch (err) {
				console.error(`${LOG_PREFIX} room meta persist failed:`, err);
			}
		})());
	}

	private async createDailySnapshotMaybe(
		triggeredBy?: string,
	): Promise<SnapshotResult> {
		this.throwIfDestroyed();
		const serialized = { chain: this.snapshotMaybeChain };
		const run = runSerialized(
			serialized,
			async () => {
				this.throwIfDestroyed();
				const bucket = this.env.YAOS_BUCKET;
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
				this.throwIfDestroyed();
				if (latest?.fullUpdateHash) {
					const rawUpdate = Y.encodeStateAsUpdate(this.document);
					const currentHash = await sha256Hex(rawUpdate);
					this.throwIfDestroyed();
					if (latest.fullUpdateHash === currentHash) {
						// Before skipping: verify the pointed snapshot actually exists.
						// A poisoned latest pointer (payload never written) would
						// otherwise cause us to skip forever.
						const exists = await verifySnapshotExists(vaultId, latest, bucket);
						this.throwIfDestroyed();
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
					this.throwIfDestroyed();

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
					this.throwIfDestroyed();

					return {
						status: "created",
						snapshotId: index.snapshotId,
						index,
					} satisfies SnapshotResult;
				} else if (latest) {
					// Ancient legacy path: no hash fields at all. Day-based dedup.
					const currentDay = new Date().toISOString().slice(0, 10);
					const existsForDay = await hasSnapshotForDay(vaultId, currentDay, bucket);
					this.throwIfDestroyed();
					if (existsForDay) {
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
				this.throwIfDestroyed();

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
				this.throwIfDestroyed();

				return {
					status: "created",
					snapshotId: index.snapshotId,
					index,
				} satisfies SnapshotResult;
			},
		);
		this.snapshotMaybeChain = serialized.chain;
		return await this.trackInFlight(run);
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

	private recordTrace(
		event: string,
		data: Record<string, unknown>,
	): Promise<void> {
		if (this.destroyed) return Promise.resolve();
		return this.trackInFlight(this.persistTrace(event, data));
	}

	private async persistTrace(
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
			await this.traceRing.append(this.ctx.storage, entry);
		} catch (err) {
			console.error(`${LOG_PREFIX} trace persist failed:`, err);
		}
		if (this.destroyed) return;

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
			const candidate = this.name;
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
