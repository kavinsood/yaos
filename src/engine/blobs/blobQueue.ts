/**
 * Blob transfer queue (DESIGN §j.1). Implements the reconcile job's
 * BlobTransfer over either carrier:
 *
 *   store (BlobPort):  up   = sha256 check -> blobAddress -> has -> put(sealBlob(bytes))
 *                      down = get -> openBlob -> verify sha256
 *   log (no store):    up   = x:<hash> blobChunk frames, true once all are receipted
 *                      down = read x:<hash>, assemble by index, verify sha256
 *
 * The reconcile runner emits nsCreate / nsSetBlob only after upload() returned
 * true, so readers can always fetch what ns references. A failure persists a
 * BlobQueueRecord with exponential backoff; until it is due, the transfer is
 * not retried (returns false / null at once), and nextDueAtMs() tells the
 * scheduler when to run the next reconcile pass. Success deletes the record.
 */

import { sha256Hex } from "../../core/hash/sha256";
import { MAX_LOG_BLOB_BYTES } from "../../core/limits";
import type { ContentHash, DocId, VaultPath } from "../../core/types";
import type { BlobPort } from "../../ports/blob";
import type { ClockPort } from "../../ports/clock";
import type { CryptoPort } from "../../ports/crypto";
import type { StorageDb } from "../../ports/storage";
import type { BlobTransfer } from "../reconcile/context";
import type { DiskSchema } from "../reconcile/store";
import { STORE, type BlobQueueRecord } from "../store/schema";
import { assembleChunks, splitChunks, type BlobChunkLog } from "./chunks";

export const BLOB_RETRY_BASE_MS = 2_000;
export const BLOB_RETRY_MAX_MS = 10 * 60_000;

export function backoffMs(attempts: number): number {
	return Math.min(BLOB_RETRY_MAX_MS, BLOB_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export interface BlobQueueDeps {
	readonly db: StorageDb<DiskSchema>;
	readonly clock: ClockPort;
	readonly crypto: CryptoPort;
	/** null = no blob store: log-carried chunks (needs `chunkLog`). */
	readonly store: BlobPort | null;
	readonly chunkLog: BlobChunkLog | null;
	readonly notice?: (level: "info" | "warn" | "error", code: string, message: string) => void;
}

type Direction = BlobQueueRecord["direction"];
interface Req { readonly hash: string; readonly docId: DocId; readonly path: VaultPath }

export class BlobQueue implements BlobTransfer {
	private readonly records = new Map<string, BlobQueueRecord>();
	private readonly inflight = new Map<string, Promise<unknown>>();

	private constructor(private readonly deps: BlobQueueDeps) {}

	static async open(deps: BlobQueueDeps): Promise<BlobQueue> {
		const q = new BlobQueue(deps);
		const rows = await deps.db.tx([STORE.blobQueue], "readonly", (tx) => tx.getAll(STORE.blobQueue));
		// A record left "in flight" by a crash is simply queued again.
		for (const r of rows) q.records.set(`${r.direction}:${r.hash}`, { ...r, active: 0 });
		return q;
	}

	get via(): BlobQueueRecord["via"] {
		return this.deps.store ? "store" : "log";
	}

	get maxBlobBytes(): number {
		return this.deps.store ? this.deps.store.maxBlobBytes : MAX_LOG_BLOB_BYTES;
	}

	/** Queued transfers (diagnostics / status). */
	queued(): readonly BlobQueueRecord[] {
		return [...this.records.values()];
	}

	/** Earliest retry time, or null when nothing is queued. */
	nextDueAtMs(): number | null {
		let next: number | null = null;
		for (const r of this.records.values()) if (next === null || r.nextAttemptAtMs < next) next = r.nextAttemptAtMs;
		return next;
	}

	private backingOff(direction: Direction, hash: string): boolean {
		const r = this.records.get(`${direction}:${hash}`);
		return r !== undefined && r.nextAttemptAtMs > this.deps.clock.now();
	}

	private async failed(direction: Direction, req: Req, size: number): Promise<void> {
		const key = `${direction}:${req.hash}`;
		const attempts = (this.records.get(key)?.attempts ?? 0) + 1;
		const rec: BlobQueueRecord = {
			hash: req.hash as ContentHash, direction, docId: req.docId, path: req.path, size, via: this.via, attempts,
			nextAttemptAtMs: this.deps.clock.now() + backoffMs(attempts), active: 0,
		};
		// keyPath is the hash: an up and a down for one hash share the row (latest wins); the map keeps both.
		await this.deps.db.tx([STORE.blobQueue], "readwrite", async (tx) => tx.put(STORE.blobQueue, rec));
		this.records.set(key, rec);
	}

	private async succeeded(direction: Direction, hash: string): Promise<void> {
		const key = `${direction}:${hash}`;
		if (!this.records.has(key)) return;
		this.records.delete(key);
		const other = this.records.get(`${direction === "up" ? "down" : "up"}:${hash}`);
		await this.deps.db.tx([STORE.blobQueue], "readwrite", async (tx) => (other ? tx.put(STORE.blobQueue, other) : tx.delete(STORE.blobQueue, hash as ContentHash)));
	}

	private once<T>(key: string, run: () => Promise<T>): Promise<T> {
		const cur = this.inflight.get(key);
		if (cur) return cur as Promise<T>;
		const p = run().finally(() => this.inflight.delete(key));
		this.inflight.set(key, p);
		return p;
	}

	upload(req: Req & { readonly bytes: Uint8Array }): Promise<boolean> {
		return this.once(`up:${req.hash}`, async () => {
			if (req.bytes.length > this.maxBlobBytes) {
				this.deps.notice?.("warn", "blob-too-large", `attachment too large to sync: ${req.path}`);
				return false;
			}
			if (sha256Hex(req.bytes) !== req.hash) return false; // the file changed under us: re-plan
			if (this.backingOff("up", req.hash)) return false;
			let ok = false;
			try {
				ok = this.deps.store ? await this.putStore(req.hash as ContentHash, req.bytes) : await this.putLog(req.hash as ContentHash, req.bytes);
			} catch {
				ok = false;
			}
			if (ok) await this.succeeded("up", req.hash);
			else await this.failed("up", req, req.bytes.length);
			return ok;
		});
	}

	download(req: Req & { readonly size: number }): Promise<Uint8Array | null> {
		return this.once(`down:${req.hash}`, async () => {
			if (req.size > this.maxBlobBytes) return null;
			if (this.backingOff("down", req.hash)) return null;
			let bytes: Uint8Array | null = null;
			try {
				bytes = this.deps.store ? await this.getStore(req.hash as ContentHash) : await this.getLog(req.hash as ContentHash);
			} catch {
				bytes = null;
			}
			if (bytes && sha256Hex(bytes) !== req.hash) {
				this.deps.notice?.("warn", "blob-corrupt", `downloaded attachment failed verification: ${req.path}`);
				bytes = null;
			}
			if (bytes) await this.succeeded("down", req.hash);
			else await this.failed("down", req, req.size);
			return bytes;
		});
	}

	private async putStore(hash: ContentHash, bytes: Uint8Array): Promise<boolean> {
		const store = this.deps.store!;
		const addr = await this.deps.crypto.blobAddress(hash);
		const have = await store.has([addr]);
		if (have.has(addr)) return true;
		await store.put(addr, await this.deps.crypto.sealBlob(bytes));
		return true;
	}

	private async getStore(hash: ContentHash): Promise<Uint8Array | null> {
		const store = this.deps.store!;
		const sealed = await store.get(await this.deps.crypto.blobAddress(hash));
		return sealed ? this.deps.crypto.openBlob(sealed) : null;
	}

	private async putLog(hash: ContentHash, bytes: Uint8Array): Promise<boolean> {
		const log = this.deps.chunkLog;
		if (!log) return false;
		return log.appendChunks(hash, splitChunks(hash, bytes));
	}

	private async getLog(hash: ContentHash): Promise<Uint8Array | null> {
		const log = this.deps.chunkLog;
		if (!log) return null;
		const chunks = await log.readChunks(hash);
		if (!chunks) return null;
		const res = assembleChunks(hash, chunks);
		return res.ok ? res.bytes : null;
	}
}
