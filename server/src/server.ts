import * as Y from "yjs";
import { YServer } from "y-partyserver";
import { ChunkedDocStore } from "./chunkedDocStore";

const DEBUG_TRACE_RING_KEY = "debugTraceRing";
const MAX_DEBUG_TRACE_EVENTS = 200;
const JOURNAL_COMPACT_MAX_ENTRIES = 50;
const JOURNAL_COMPACT_MAX_BYTES = 1 * 1024 * 1024;

interface ServerTraceEntry {
	ts: string;
	event: string;
	roomId: string;
	[key: string]: unknown;
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
	private chunkedDocStore: ChunkedDocStore | null = null;
	private saveChain: Promise<void> = Promise.resolve();
	private lastSavedStateVector: Uint8Array | null = null;

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
	}

	async fetch(request: Request): Promise<Response> {
		await this.ensureDocumentLoaded();

		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__yaos/document") {
			return new Response(Y.encodeStateAsUpdate(this.document), {
				headers: {
					"Content-Type": "application/octet-stream",
					"Cache-Control": "no-store",
				},
			});
		}

		if (request.method === "GET" && url.pathname === "/__yaos/debug") {
			const recent =
				(await this.ctx.storage.get<ServerTraceEntry[]>(DEBUG_TRACE_RING_KEY))
				?? [];
			return json({
				roomId: this.getRoomId(),
				recent,
			});
		}

		if (request.method === "POST" && url.pathname === "/__yaos/trace") {
			let body: { event?: string; data?: Record<string, unknown> } = {};
			try {
				body = await request.json() as typeof body;
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (!body.event || typeof body.event !== "string") {
				return json({ error: "missing event" }, 400);
			}

			await this.recordTrace(body.event, body.data ?? {});
			return json({ ok: true });
		}

		return super.fetch(request);
	}

	private async ensureDocumentLoaded(): Promise<void> {
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
				this.lastSavedStateVector = checkpointStateVector;
				return;
			}
			this.lastSavedStateVector = persistedStateVector;
		});
		this.saveChain = run.catch(() => undefined);
		return run;
	}

	private async recordTrace(
		event: string,
		data: Record<string, unknown>,
	): Promise<void> {
		const entry: ServerTraceEntry = {
			ts: new Date().toISOString(),
			event,
			roomId: this.getRoomId(),
			...data,
		};

		console.log(JSON.stringify({
			source: "vault-sync",
			...entry,
		}));

		const existing =
			(await this.ctx.storage.get<ServerTraceEntry[]>(DEBUG_TRACE_RING_KEY))
			?? [];
		existing.push(entry);
		if (existing.length > MAX_DEBUG_TRACE_EVENTS) {
			existing.splice(0, existing.length - MAX_DEBUG_TRACE_EVENTS);
		}
		await this.ctx.storage.put(DEBUG_TRACE_RING_KEY, existing);
	}

	private getRoomId(): string {
		const candidate = (this as unknown as { name?: unknown }).name;
		return typeof candidate === "string" && candidate.length > 0
			? candidate
			: "unknown";
	}
}

export default VaultSyncServer;
