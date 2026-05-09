import * as Y from "yjs";
import { YServer } from "y-partyserver";
import { runSerialized, runSingleFlight } from "./asyncConcurrency";
import { ChunkedDocStore } from "./chunkedDocStore";
import { readRoomMeta, type RoomMeta, writeRoomMeta } from "./roomMeta";
import {
	createSnapshot,
	hasSnapshotForDay,
	type SnapshotResult,
} from "./snapshot";
import {
	appendTraceEntry,
	listRecentTraceEntries,
	prepareTraceEntryForStorage,
	type TraceEntry as StoredTraceEntry,
} from "./traceStore";

const MAX_DEBUG_TRACE_EVENTS = 200;
const JOURNAL_COMPACT_MAX_ENTRIES = 50;
const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024;
const TRACE_DEBUG_LIMIT = 100;
const LOG_PREFIX = "[yaos-sync:server]";

type ServerTraceEntry = StoredTraceEntry;

interface ServerEnv {
	YAOS_BUCKET?: R2Bucket;
}

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
	private saveChain: Promise<void> = Promise.resolve();
	private snapshotMaybeChain: Promise<void> = Promise.resolve();
	private lastSavedStateVector: Uint8Array | null = null;
	private roomMeta: RoomMeta | null = null;

	async onLoad(): Promise<void> {
		await this.ensureDocumentLoaded();
	}

	async onSave(): Promise<void> {
		await this.ensureDocumentLoaded();
		const baseStateVector = this.lastSavedStateVector;
		const persistedStateVector = Y.encodeStateVector(this.document);
		if (baseStateVector && equalBytes(baseStateVector, persistedStateVector)) {
			return;
		}
		const delta = baseStateVector
			? Y.encodeStateAsUpdate(this.document, baseStateVector)
			: Y.encodeStateAsUpdate(this.document);
		if (delta.byteLength === 0) {
			return;
		}
		await this.enqueueSave(delta, persistedStateVector);
		await this.syncRoomMetaFromDocument();
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
			const recent = await listRecentTraceEntries(this.ctx.storage, TRACE_DEBUG_LIMIT);
			return json({
				roomId: this.getRoomId(),
				recent,
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

	private async ensureDocumentLoaded(): Promise<void> {
		if (this.documentLoaded) return;
		const gate = { inFlight: this.loadPromise };
		const run = runSingleFlight(gate, async () => {
			if (this.documentLoaded) return;

			const state = await this.getChunkedDocStore().loadState();
			if (state.checkpoint) {
				Y.applyUpdate(this.document, state.checkpoint);
			}
			for (const update of state.journalUpdates) {
				Y.applyUpdate(this.document, update);
			}

			this.lastSavedStateVector = (
				state.checkpointStateVector && state.journalUpdates.length === 0
			)
				? state.checkpointStateVector.slice()
				: Y.encodeStateVector(this.document);
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

	private getChunkedDocStore(): ChunkedDocStore {
		if (!this.chunkedDocStore) {
			this.chunkedDocStore = new ChunkedDocStore(this.ctx.storage);
		}
		return this.chunkedDocStore;
	}

	private enqueueSave(delta: Uint8Array, persistedStateVector: Uint8Array): Promise<void> {
		const run = this.saveChain.then(async () => {
			const store = this.getChunkedDocStore();
			const journalStats = await store.appendUpdate(delta);
			if (
				journalStats.entryCount > JOURNAL_COMPACT_MAX_ENTRIES
				|| journalStats.totalBytes > JOURNAL_COMPACT_MAX_BYTES
			) {
				const checkpointUpdate = Y.encodeStateAsUpdate(this.document);
				const checkpointStateVector = Y.encodeStateVector(this.document);
				await store.rewriteCheckpoint(checkpointUpdate, checkpointStateVector);
				await this.recordTrace("checkpoint-fallback-triggered", {
					reason: "journal-compaction-threshold-exceeded",
					journalEntryCount: journalStats.entryCount,
					journalBytes: journalStats.totalBytes,
					maxJournalEntries: JOURNAL_COMPACT_MAX_ENTRIES,
					maxJournalBytes: JOURNAL_COMPACT_MAX_BYTES,
					note: "clients behind compaction boundary may require checkpoint-based catchup",
				});
				this.lastSavedStateVector = checkpointStateVector;
				return;
			}
			this.lastSavedStateVector = persistedStateVector;
		});
		this.saveChain = run.catch(() => undefined);
		return run;
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

				const currentDay = new Date().toISOString().slice(0, 10);
				if (await hasSnapshotForDay(this.getRoomId(), currentDay, bucket)) {
					return {
						status: "noop",
						reason: `Snapshot already taken today (${currentDay})`,
					} satisfies SnapshotResult;
				}

				const index = await createSnapshot(
					this.document,
					this.getRoomId(),
					bucket,
					triggeredBy,
				);
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
