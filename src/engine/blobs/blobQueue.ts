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
 * not retried (returns false / null at once), and nextDueInMs() tells the
 * scheduler when to run the next reconcile pass. Success deletes the record.
 *
 * Backoff runs on the monotonic clock: a wall clock that jumps back (NTP, the
 * user, a skewed device) must not park a transfer for hours. The persisted
 * nextAttemptAtMs is wall time; on open the remaining wait is clamped to the
 * record's own backoff.
 *
 * prefetch() starts a download ahead of its job (the plan runner runs jobs one
 * by one, so N attachments would otherwise wait N round trips); the job's own
 * download() takes the result and does the bookkeeping as if it had fetched.
 * Bounded by `ahead` (results held at once, their total size); none by default.
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
	/** prefetch() bound: downloads held ahead of their job at once, and their total size. */
	readonly ahead?: { readonly count: number; readonly bytes: number };
}

type Direction = BlobQueueRecord["direction"];
interface Fetched { readonly bytes: Uint8Array | null; readonly corrupt: boolean }
interface Req { readonly hash: string; readonly docId: DocId; readonly path: VaultPath }

export class BlobQueue implements BlobTransfer {
	private readonly records = new Map<string, BlobQueueRecord>();
	/** Monotonic due time per record key. */
	private readonly due = new Map<string, number>();
	private readonly inflight = new Map<string, Promise<unknown>>();
	/** Downloads started by prefetch(), by hash, until a download() takes them. */
	private readonly ahead = new Map<string, { readonly size: number; readonly got: Promise<Fetched> }>();
	private aheadBytes = 0;

	private constructor(private readonly deps: BlobQueueDeps) {}

	static async open(deps: BlobQueueDeps): Promise<BlobQueue> {
		const q = new BlobQueue(deps);
		const rows = await deps.db.tx([STORE.blobQueue], "readonly", (tx) => tx.getAll(STORE.blobQueue));
		// A record left "in flight" by a crash is simply queued again.
		const now = deps.clock.now();
		const mono = deps.clock.monotonic();
		for (const r of rows) {
			const key = `${r.direction}:${r.hash}`;
			q.records.set(key, { ...r, active: 0 });
			q.due.set(key, mono + Math.min(Math.max(0, r.nextAttemptAtMs - now), backoffMs(r.attempts)));
		}
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

	/** Milliseconds until the earliest retry (0 = due now), or null when nothing is queued. */
	nextDueInMs(): number | null {
		let next: number | null = null;
		for (const at of this.due.values()) if (next === null || at < next) next = at;
		return next === null ? null : Math.max(0, next - this.deps.clock.monotonic());
	}

	private backingOff(direction: Direction, hash: string): boolean {
		const at = this.due.get(`${direction}:${hash}`);
		return at !== undefined && at > this.deps.clock.monotonic();
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
		this.due.set(key, this.deps.clock.monotonic() + backoffMs(attempts));
	}

	private async succeeded(direction: Direction, hash: string): Promise<void> {
		const key = `${direction}:${hash}`;
		if (!this.records.has(key)) return;
		this.records.delete(key);
		this.due.delete(key);
		const other = this.records.get(`${direction === "up" ? "down" : "up"}:${hash}`);
		await this.deps.db.tx([STORE.blobQueue], "readwrite", async (tx) => (other ? tx.put(STORE.blobQueue, other) : tx.delete(STORE.blobQueue, hash as ContentHash)));
	}

	/**
	 * Drop queued records `keep` rejects (a full pass no longer plans that transfer: the file changed, the doc
	 * went away). Without this a stale record stays due forever and keeps re-arming the blob retry. Records with
	 * a transfer in flight are kept. Returns the number dropped.
	 */
	async retain(keep: (r: BlobQueueRecord) => boolean): Promise<number> {
		const drop: string[] = [];
		for (const [key, r] of this.records) if (!this.inflight.has(key) && !keep(r)) drop.push(key);
		if (drop.length === 0) return 0;
		const rows = new Map<string, BlobQueueRecord | null>();
		for (const key of drop) {
			const r = this.records.get(key)!;
			this.records.delete(key);
			this.due.delete(key);
			rows.set(r.hash, this.records.get(`${r.direction === "up" ? "down" : "up"}:${r.hash}`) ?? null);
		}
		await this.deps.db.tx([STORE.blobQueue], "readwrite", async (tx) => {
			for (const [hash, other] of rows) await (other ? tx.put(STORE.blobQueue, other) : tx.delete(STORE.blobQueue, hash as ContentHash));
		});
		return drop.length;
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
			const ahead = this.take(req.hash);
			if (!ahead && this.backingOff("down", req.hash)) return null;
			const { bytes, corrupt } = await (ahead ?? this.getVerified(req.hash as ContentHash));
			if (corrupt) this.deps.notice?.("warn", "blob-corrupt", `downloaded attachment failed verification: ${req.path}`);
			if (bytes) await this.succeeded("down", req.hash);
			else await this.failed("down", req, req.size);
			return bytes;
		});
	}

	/**
	 * Start downloading `req` for a job that runs soon. true = started, or nothing to start (already ahead or in
	 * flight, oversize, larger than the whole `ahead` budget, backing off: its download() decides); false = the
	 * `ahead` bound is full (try later).
	 */
	prefetch(req: Req & { readonly size: number }): boolean {
		if (this.ahead.has(req.hash) || this.inflight.has(`down:${req.hash}`)) return true;
		if (req.size > this.maxBlobBytes || this.backingOff("down", req.hash)) return true;
		const bound = this.deps.ahead ?? { count: 0, bytes: 0 };
		if (bound.count > 0 && req.size > bound.bytes) return true; // never held ahead: its job downloads it
		if (this.ahead.size >= bound.count || this.aheadBytes + req.size > bound.bytes) return false;
		this.aheadBytes += req.size;
		this.ahead.set(req.hash, { size: req.size, got: this.getVerified(req.hash as ContentHash) });
		return true;
	}

	/** Forget prefetched results no job took (the run is over; their downloads finish unobserved). */
	dropPrefetched(): void {
		this.ahead.clear();
		this.aheadBytes = 0;
	}

	private take(hash: string): Promise<Fetched> | null {
		const a = this.ahead.get(hash);
		if (!a) return null;
		this.ahead.delete(hash);
		this.aheadBytes -= a.size;
		return a.got;
	}

	/** Verified bytes (null = unavailable; corrupt = fetched but not `hash`). Never throws. */
	private async getVerified(hash: ContentHash): Promise<Fetched> {
		let bytes: Uint8Array | null = null;
		try {
			bytes = this.deps.store ? await this.getStore(hash) : await this.getLog(hash);
		} catch {
			bytes = null;
		}
		if (bytes && sha256Hex(bytes) !== hash) return { bytes: null, corrupt: true };
		return { bytes, corrupt: false };
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
