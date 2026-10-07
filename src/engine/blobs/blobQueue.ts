/**
 * Blob transfer queue (DESIGN §j.1). Implements the reconcile job's
 * BlobTransfer over either carrier:
 *
 *   store (BlobPort):  up   = sha256 check -> blobAddress -> has -> put(sealBlob(bytes))
 *                      down = get -> openBlob -> verify sha256
 *   log (no store):    up   = x:<address> blobChunk frames, true once all are receipted
 *                      down = read x:<address>, assemble by index, verify sha256
 *
 * maxBlobBytes is a plaintext cap: the store's transport cap under suite 0,
 * what still fits it once sealed under suite 1 (e2ee-design §7.3, ≤
 * MAX_BLOB_PLAINTEXT_BYTES_SUITE1), MAX_LOG_BLOB_BYTES on the log. Larger
 * files are not synced (reconcile excludes them; upload() refuses with a
 * notice).
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
 *
 * Download failures are all "unavailable" and retried with backoff
 * (e2ee-design §10.2). Deterministic ones (blobStore.ts: fetched, but it does
 * not open or verify under a verified key; or assembled log chunks that do not
 * verify) also notice "blob-corrupt". Once BlobFailureStreaks says the rule of
 * §10.2 is met (initial attempt + 3 retries, ≥ 3 min, all deterministic), the
 * download is quarantined: notice "blob-quarantined", no further retries
 * (download / prefetch return at once, no due time) until a restart or until
 * retain() drops the transfer. The referencing ns row itself cannot be
 * quarantined (the ns fold must not stop on a blob), so the quarantine is on
 * the transfer.
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
import { BlobFailureStreaks, getOpened, putSealed, storePlaintextCap, type BlobFetch, type PutPolicy } from "./blobStore";
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
	/** When a present blob may be re-used (e2ee-design §10.4 R2). */
	readonly touch: PutPolicy;
	readonly chunkLog: BlobChunkLog | null;
	readonly notice?: (level: "info" | "warn" | "error", code: string, message: string) => void;
	/** prefetch() bound: downloads held ahead of their job at once, and their total size. */
	readonly ahead?: { readonly count: number; readonly bytes: number };
}

type Direction = BlobQueueRecord["direction"];
interface Req { readonly hash: string; readonly docId: DocId; readonly path: VaultPath }

export class BlobQueue implements BlobTransfer {
	private readonly records = new Map<string, BlobQueueRecord>();
	/** Monotonic due time per record key. */
	private readonly due = new Map<string, number>();
	private readonly inflight = new Map<string, Promise<unknown>>();
	/** Downloads started by prefetch(), by hash, until a download() takes them. */
	private readonly ahead = new Map<string, { readonly size: number; readonly got: Promise<BlobFetch> }>();
	private aheadBytes = 0;
	private readonly streaks = new BlobFailureStreaks();
	/** Downloads quarantined by the §10.2 rule, by hash (in memory). */
	private readonly quarantinedDown = new Set<string>();

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

	/** Largest plaintext this carrier moves under the vault's suite (see the header). */
	get maxBlobBytes(): number {
		return this.deps.store ? storePlaintextCap(this.deps.crypto, this.deps.store) : MAX_LOG_BLOB_BYTES;
	}

	/** Hashes whose download is quarantined (diagnostics / tests). */
	quarantined(): readonly string[] {
		return [...this.quarantinedDown];
	}

	/** Queued transfers (diagnostics / status). */
	queued(): readonly BlobQueueRecord[] {
		return [...this.records.values()];
	}

	/** Hashes of queued and running transfers, both directions (live for a GC sweep, e2ee-design §10.4). */
	liveHashes(): Set<ContentHash> {
		const out = new Set<ContentHash>();
		for (const r of this.records.values()) out.add(r.hash);
		for (const key of this.inflight.keys()) out.add(key.slice(key.indexOf(":") + 1) as ContentHash);
		return out;
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
			if (r.direction === "down") {
				this.quarantinedDown.delete(r.hash);
				this.streaks.clear(r.hash);
			}
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
				if (this.deps.store) {
					await putSealed(this.deps.store, this.deps.crypto, req.hash as ContentHash, req.bytes, this.deps.touch);
					ok = true;
				} else ok = await this.putLog(req.hash as ContentHash, req.bytes);
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
			if (req.size > this.maxBlobBytes || this.quarantinedDown.has(req.hash)) return null;
			const ahead = this.take(req.hash);
			if (!ahead && this.backingOff("down", req.hash)) return null;
			const got = await (ahead ?? this.getVerified(req.hash as ContentHash));
			if (got.ok) {
				this.streaks.clear(req.hash);
				await this.succeeded("down", req.hash);
				return got.bytes;
			}
			if (got.deterministic) this.deps.notice?.("warn", "blob-corrupt", `downloaded attachment failed verification: ${req.path}`);
			await this.failed("down", req, req.size);
			if (this.streaks.note(req.hash, got.deterministic, this.deps.clock.monotonic())) {
				this.quarantinedDown.add(req.hash);
				this.due.delete(`down:${req.hash}`);
				this.deps.notice?.("error", "blob-quarantined", `attachment quarantined after repeated verification failures: ${req.path}`);
			}
			return null;
		});
	}

	/**
	 * Start downloading `req` for a job that runs soon. true = started, or nothing to start (already ahead or in
	 * flight, oversize, larger than the whole `ahead` budget, backing off: its download() decides); false = the
	 * `ahead` bound is full (try later).
	 */
	prefetch(req: Req & { readonly size: number }): boolean {
		if (this.ahead.has(req.hash) || this.inflight.has(`down:${req.hash}`)) return true;
		if (req.size > this.maxBlobBytes || this.quarantinedDown.has(req.hash) || this.backingOff("down", req.hash)) return true;
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

	private take(hash: string): Promise<BlobFetch> | null {
		const a = this.ahead.get(hash);
		if (!a) return null;
		this.ahead.delete(hash);
		this.aheadBytes -= a.size;
		return a.got;
	}

	/** Verified bytes, or why they are unavailable (blobStore.ts BlobFetch). Never throws. */
	private async getVerified(hash: ContentHash): Promise<BlobFetch> {
		try {
			return this.deps.store ? await getOpened(this.deps.store, this.deps.crypto, hash, sha256Hex) : await this.getLog(hash);
		} catch {
			return { ok: false, reason: "transport", deterministic: false };
		}
	}

	private async putLog(hash: ContentHash, bytes: Uint8Array): Promise<boolean> {
		const log = this.deps.chunkLog;
		if (!log) return false;
		return log.appendChunks(hash, splitChunks(hash, bytes));
	}

	/**
	 * Committed x:<address> chunks, assembled and verified. Missing chunks are "absent" (not yet, or withheld);
	 * chunks that assemble into other bytes, or disagree on the shape, are deterministic: they passed the gate
	 * (authentic), the first chunk per index wins, and appending more cannot change the result.
	 */
	private async getLog(hash: ContentHash): Promise<BlobFetch> {
		const log = this.deps.chunkLog;
		const chunks = log ? await log.readChunks(hash) : null;
		if (!chunks) return { ok: false, reason: "transport", deterministic: false };
		const res = assembleChunks(hash, chunks);
		if (res.ok) return { ok: true, bytes: res.bytes };
		if (res.reason === "incomplete") return { ok: false, reason: "absent", deterministic: false };
		return { ok: false, reason: res.reason, deterministic: true };
	}
}
