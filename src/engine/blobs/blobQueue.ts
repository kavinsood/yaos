/**
 * Blob transfer queue (DESIGN §j.1). Implements the reconcile job's
 * BlobTransfer over the blob store (BlobPort, R2 over HTTP), the only carrier
 * of blob bytes; the relay's sequence log never carries them:
 *
 *   up   = read the file -> sha256 check -> blobAddress -> has -> put(sealBlob(bytes))
 *   down = get -> openBlob -> verify sha256
 *
 * Both sha256 checks are one HashPort digest (WebCrypto): a 95 MB attachment
 * hashes in ~35 ms instead of ~280 ms of pure JS on the engine thread.
 *
 * Background transfers. A plan job never waits on a transfer: it claims one
 * (claimUpload / claimDownload), which starts it or joins the one running for
 * that hash, and the plan runner skips the doc's later ops for this pass. When
 * the transfer settles, `wake` asks for a pass over its docs; their jobs claim
 * again and get the outcome at once: "stored" (pushBlob then submits the
 * deferred nsCreate / nsSetBlob), the verified bytes (single use: the disk
 * write transfers them), or "unavailable" (backing off). So a 100 MB upload
 * holds up no other doc's disk edits, remote writes or settings change.
 *
 * Readers can always fetch what ns references: the ns op that references a
 * hash is submitted only by a pass that sees this queue's confirmation (an
 * in-memory memo, CONFIRMED_TTL_MS, far inside the GC grace; the sender's R3
 * gate, blobs/touch.ts, checks the PUT time again before the frame leaves).
 * Crash safety needs no new state: until that ns op is submitted the doc's
 * synced record is untouched (L ≠ S), so a crash anywhere in a transfer leaves
 * the next start's full pass planning the same upload again; the PUT is
 * idempotent and has() skips a stored blob (R2 policy). A download is written
 * by a later pass's job, planned from that pass's facts (doc, hash, path, the
 * write's CAS precondition), so bytes for a hash the doc no longer wants are
 * never taken; endPass drops them once a pass over the doc that began after
 * they arrived took none.
 *
 * Byte budget (Budgets.blobBytesInFlight). Transfers start in claim order
 * while the running ones plus the downloaded bytes no job took yet stay
 * within the budget, each counting its size, at least BLOB_TRANSFER_MIN_COST.
 * One transfer larger than the budget starts once nothing else is in flight,
 * and runs alone. So the bytes held are bounded by max(budget, one blob)
 * (plus the seal / open copies of those bytes), small files still move many
 * at a time, and a large one cannot be starved by a stream of small ones.
 * `admit` gates new starts (paused, backgrounded); pump() re-checks it.
 *
 * Liveness. Every store call carries the queue's signal (aborted by stop()),
 * linked by the engine to the relay link (blobs/transferLink.ts: aborted when
 * the session loop declares the link dead). The adapter ends a transfer that
 * moves no byte for BLOB_TRANSFER_IDLE_MS. Either way the transfer fails like
 * any transport error: a backoff record, then a retry.
 *
 * maxBlobBytes is a plaintext cap: the store's transport cap under suite 0,
 * what still fits it once sealed under suite 1 (e2ee-design §7.3,
 * maxSealedBlobPlaintext). Larger files are not synced (reconcile excludes
 * them; upload() refuses with a notice).
 *
 * A store that refuses a put by size (BlobTooLargeError: HTTP 413, e.g. the
 * edge's request limit on a plan below the advertised cap) refuses those
 * bytes for good: notice "blob-too-large", no record, no backoff, and later
 * claims of that hash answer "refused" at once without a request (the
 * reconcile job holds instead of failing, so no retry is armed). In memory: a
 * restart tries once more. Changed bytes are a new hash and are tried.
 *
 * No store (the relay has no R2 binding): maxBlobBytes is 0, reconcile
 * excludes every blob, and every call answers at once (unavailable / false /
 * null) without a record, so nothing is queued and no retry is armed. A store
 * found on a later connect restarts the runtime with it
 * (EnginePorts.probeBlob), whose full pass then uploads what is pending.
 *
 * A failure persists a BlobQueueRecord with exponential backoff; until it is
 * due, the transfer is not retried (claims answer "unavailable", upload() /
 * download() false / null at once), and nextDueInMs() tells the scheduler when
 * to run the next reconcile pass. Success deletes the record.
 *
 * Backoff runs on the monotonic clock: a wall clock that jumps back (NTP, the
 * user, a skewed device) must not park a transfer for hours. The persisted
 * nextAttemptAtMs is wall time; on open the remaining wait is clamped to the
 * record's own backoff.
 *
 * Download failures are all "unavailable" and retried with backoff
 * (e2ee-design §10.2). Deterministic ones (blobStore.ts: fetched, but it does
 * not open or verify under a verified key) also notice "blob-corrupt". Once
 * BlobFailureStreaks says the rule of §10.2 is met (initial attempt + 3
 * retries, ≥ 3 min, all deterministic), the download is quarantined: notice
 * "blob-quarantined", no further retries (claims answer at once, no due time)
 * until a restart or until retain() drops the transfer. The referencing ns
 * row itself cannot be quarantined (the ns fold must not stop on a blob), so
 * the quarantine is on the transfer.
 */

import { bytesToHex } from "../../core/codec/lib0";
import { BLOB_TRANSFER_MIN_COST } from "../../core/limits";
import type { ContentHash, DocId, VaultPath } from "../../core/types";
import { BlobTooLargeError, type BlobPort } from "../../ports/blob";
import type { ClockPort } from "../../ports/clock";
import type { CryptoPort, HashPort } from "../../ports/crypto";
import type { StorageDb } from "../../ports/storage";
import type { BlobReq, BlobTransfer, DownloadClaim, UploadClaim, UploadSource } from "../reconcile/context";
import type { DiskSchema } from "../reconcile/store";
import { STORE, type BlobQueueRecord } from "../store/schema";
import { BlobFailureStreaks, getOpened, putSealed, storePlaintextCap, type BlobFetch, type PutPolicy } from "./blobStore";

export const BLOB_RETRY_BASE_MS = 2_000;
export const BLOB_RETRY_MAX_MS = 10 * 60_000;
/** How long a confirmed upload answers "stored" without a request: far inside the GC grace (blobGcGraceMs, 7 days). */
export const CONFIRMED_TTL_MS = 10 * 60_000;
/** Budgets.blobBytesInFlight of a desktop (core/limits.ts), when the caller gives none. */
export const DEFAULT_BLOB_BYTES_IN_FLIGHT = 64 * 1024 * 1024;

export function backoffMs(attempts: number): number {
	return Math.min(BLOB_RETRY_MAX_MS, BLOB_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** A doc whose job claimed a transfer. */
export interface BlobClaimant {
	readonly docId: DocId;
	readonly path: VaultPath;
}

export interface BlobQueueDeps {
	readonly db: StorageDb<DiskSchema>;
	readonly clock: ClockPort;
	readonly crypto: CryptoPort;
	/** The upload and download sha256 checks. */
	readonly hash: HashPort;
	/** null = no blob store: no transfer runs (see the header). */
	readonly store: BlobPort | null;
	/** When a present blob may be re-used (e2ee-design §10.4 R2). */
	readonly touch: PutPolicy;
	readonly notice?: (level: "info" | "warn" | "error", code: string, message: string) => void;
	readonly diag?: (line: string) => void;
	/** Budgets.blobBytesInFlight (see the header); DEFAULT_BLOB_BYTES_IN_FLIGHT when absent. */
	readonly budgetBytes?: number;
	/** false = start nothing new now (paused, backgrounded); pump() re-checks. */
	readonly admit?: () => boolean;
	/** Transfers these docs' jobs claimed settled: plan them again. */
	readonly wake?: (who: readonly BlobClaimant[]) => void;
}

type Direction = BlobQueueRecord["direction"];
interface Req { readonly hash: string; readonly docId: DocId; readonly path: VaultPath }

/** A transfer the queue knows of (status, diagnostics, the sim's idle check). */
export interface QueuedTransfer {
	readonly direction: Direction;
	readonly hash: string;
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly size: number;
	/** Failed attempts so far (its backoff record's). */
	readonly attempts: number;
	/** backoff = waiting for its retry; pending = waiting for the budget; ready = downloaded, no job took it yet. */
	readonly state: "backoff" | "pending" | "running" | "ready";
}

/** How a transfer ended. All but "stopped" wake its claimants. */
type Ended = "ok" | "failed" | "refused" | "changed" | "stopped";

interface Transfer {
	readonly key: string;
	readonly direction: Direction;
	/** The first claim: the record's and the notices' doc and path. */
	readonly req: Req;
	readonly size: number;
	readonly cost: number;
	/** Docs whose jobs claimed it: woken when it settles. */
	readonly who: Map<DocId, VaultPath>;
	/** upload() / download() callers waiting on it. */
	readonly waiters: ((ended: Ended, bytes: Uint8Array | null) => void)[];
	/** Upload only: where the bytes come from. */
	readonly source: UploadSource | null;
	running: Promise<void> | null;
}

interface Ready {
	readonly bytes: Uint8Array;
	readonly cost: number;
	readonly who: ReadonlyMap<DocId, VaultPath>;
	/** The pass count when they arrived (endPass). */
	readonly pass: number;
}

export class BlobQueue implements BlobTransfer {
	private readonly records = new Map<string, BlobQueueRecord>();
	/** Monotonic due time per record key. */
	private readonly due = new Map<string, number>();
	/** Pending and running transfers by key ("up:" / "down:" + hash). */
	private readonly transfers = new Map<string, Transfer>();
	/** Transfers waiting for the budget, in claim order. */
	private readonly pending: Transfer[] = [];
	/** Downloaded, verified bytes no job took yet, by hash. */
	private readonly ready = new Map<string, Ready>();
	/** Uploads the store confirmed: hash -> monotonic time (CONFIRMED_TTL_MS). */
	private readonly confirmed = new Map<string, number>();
	/** Bytes of running transfers plus ready downloads, each at least BLOB_TRANSFER_MIN_COST. */
	private inUse = 0;
	private passes = 0;
	private stopped = false;
	private readonly ctl = new AbortController();
	private readonly streaks = new BlobFailureStreaks();
	/** Downloads quarantined by the §10.2 rule, by hash (in memory). */
	private readonly quarantinedDown = new Set<string>();
	/** Uploads the store refused by size, by hash (in memory; see the header). */
	private readonly refusedUp = new Set<string>();

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

	/** Largest plaintext the store moves under the vault's suite (see the header); 0 without a store. */
	get maxBlobBytes(): number {
		return this.deps.store ? storePlaintextCap(this.deps.crypto, this.deps.store) : 0;
	}

	private get budget(): number {
		return this.deps.budgetBytes ?? DEFAULT_BLOB_BYTES_IN_FLIGHT;
	}

	/** Bytes counted against the budget now (diagnostics / tests). */
	get bytesInFlight(): number {
		return this.inUse;
	}

	/** Hashes whose download is quarantined (diagnostics / tests). */
	quarantined(): readonly string[] {
		return [...this.quarantinedDown];
	}

	/** Every transfer not finished: backing off, pending, running, or downloaded and not taken. */
	queued(): readonly QueuedTransfer[] {
		const out: QueuedTransfer[] = [];
		for (const [key, r] of this.records) {
			if (!this.transfers.has(key)) out.push({ direction: r.direction, hash: r.hash, docId: r.docId, path: r.path, size: r.size, attempts: r.attempts, state: "backoff" });
		}
		for (const [key, t] of this.transfers) {
			out.push({ ...t.req, direction: t.direction, size: t.size, attempts: this.records.get(key)?.attempts ?? 0, state: t.running ? "running" : "pending" });
		}
		for (const [hash, r] of this.ready) {
			const [docId, path] = r.who.entries().next().value!;
			out.push({ direction: "down", hash, docId, path, size: r.bytes.length, attempts: 0, state: "ready" });
		}
		return out;
	}

	/** Hashes of queued, running, confirmed and downloaded transfers, both directions (live for a GC sweep, e2ee-design §10.4). */
	liveHashes(): Set<ContentHash> {
		const out = new Set<ContentHash>();
		for (const r of this.records.values()) out.add(r.hash);
		for (const t of this.transfers.values()) out.add(t.req.hash as ContentHash);
		for (const h of this.ready.keys()) out.add(h as ContentHash);
		const now = this.deps.clock.monotonic();
		for (const [h, at] of this.confirmed) {
			if (now - at < CONFIRMED_TTL_MS) out.add(h as ContentHash);
			else this.confirmed.delete(h);
		}
		return out;
	}

	/**
	 * Milliseconds until the earliest retry (0 = due now), or null when nothing is queued. A retry already pending or
	 * running is not due: its past time stays until it ends (failed() sets the next one, settled() drops it), and a
	 * pass started for it would only re-arm the retry timer at once (a full-pass hot loop for the whole transfer).
	 * Its end wakes its docs, and the pass that follows arms whatever is due then.
	 */
	nextDueInMs(): number | null {
		let next: number | null = null;
		for (const [key, at] of this.due) if (!this.transfers.has(key) && (next === null || at < next)) next = at;
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
			hash: req.hash as ContentHash, direction, docId: req.docId, path: req.path, size, attempts,
			nextAttemptAtMs: this.deps.clock.now() + backoffMs(attempts), active: 0,
		};
		// In memory first: a failing database must not turn the backoff into a hot retry.
		this.records.set(key, rec);
		this.due.set(key, this.deps.clock.monotonic() + backoffMs(attempts));
		// keyPath is the hash: an up and a down for one hash share the row (latest wins); the map keeps both.
		await this.deps.db.tx([STORE.blobQueue], "readwrite", async (tx) => tx.put(STORE.blobQueue, rec));
	}

	/** Forget the transfer's record, if any (it succeeded, or it can never succeed). */
	private async settled(direction: Direction, hash: string): Promise<void> {
		const key = `${direction}:${hash}`;
		if (!this.records.has(key)) return;
		this.records.delete(key);
		this.due.delete(key);
		const other = this.records.get(`${direction === "up" ? "down" : "up"}:${hash}`);
		await this.deps.db.tx([STORE.blobQueue], "readwrite", async (tx) => (other ? tx.put(STORE.blobQueue, other) : tx.delete(STORE.blobQueue, hash as ContentHash)));
	}

	/**
	 * Drop what `keep` rejects (a full pass no longer plans that transfer: the file changed, the doc went away):
	 * queued records, and the claims on transfers not started yet. Without this a stale record stays due forever
	 * and keeps re-arming the blob retry. Records with a transfer pending or running are kept. Returns the number
	 * of records dropped.
	 */
	async retain(keep: (r: Pick<BlobQueueRecord, "direction" | "hash" | "docId">) => boolean): Promise<number> {
		for (const t of [...this.pending]) {
			for (const docId of [...t.who.keys()]) if (!keep({ direction: t.direction, hash: t.req.hash as ContentHash, docId })) t.who.delete(docId);
			if (t.who.size === 0 && t.waiters.length === 0) this.unqueue(t);
		}
		const drop: string[] = [];
		for (const [key, r] of this.records) if (!this.transfers.has(key) && !keep(r)) drop.push(key);
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

	// ---- claims (plan jobs) -----------------------------------------------------------------

	claimUpload(req: BlobReq, source: UploadSource): UploadClaim {
		if (!this.deps.store || this.stopped) return "unavailable";
		if (this.refusedUp.has(req.hash)) return "refused";
		if (this.isConfirmed(req.hash)) return "stored";
		const key = `up:${req.hash}`;
		this.forget("up", req.docId, key);
		const cur = this.transfers.get(key);
		if (cur) {
			cur.who.set(req.docId, req.path);
			return "busy";
		}
		if (this.backingOff("up", req.hash)) return "unavailable";
		this.enqueue(this.transfer("up", req, req.size, source), req);
		return "busy";
	}

	claimDownload(req: BlobReq): DownloadClaim {
		if (!this.deps.store || this.stopped) return { t: "unavailable" };
		if (req.size > this.maxBlobBytes || this.quarantinedDown.has(req.hash)) return { t: "unavailable" };
		const got = this.take(req.hash);
		if (got) return { t: "bytes", bytes: got };
		const key = `down:${req.hash}`;
		this.forget("down", req.docId, key);
		const cur = this.transfers.get(key);
		if (cur) {
			cur.who.set(req.docId, req.path);
			return { t: "busy" };
		}
		if (this.backingOff("down", req.hash)) return { t: "unavailable" };
		this.enqueue(this.transfer("down", req, req.size, null), req);
		return { t: "busy" };
	}

	beginPass(): number {
		return ++this.passes;
	}

	endPass(token: number, covers: (docId: DocId, path: VaultPath) => boolean): void {
		let freed = 0;
		for (const [hash, r] of this.ready) {
			if (r.pass >= token || ![...r.who].some(([d, p]) => covers(d, p))) continue;
			this.ready.delete(hash);
			freed += r.cost;
		}
		if (freed > 0) this.release(freed);
	}

	// ---- awaited calls (settings sync) ------------------------------------------------------

	upload(req: Req & { readonly bytes: Uint8Array }): Promise<boolean> {
		if (!this.deps.store || this.stopped || this.refusedUp.has(req.hash)) return Promise.resolve(false);
		if (req.bytes.length > this.maxBlobBytes) {
			this.deps.notice?.("warn", "blob-too-large", `attachment too large to sync: ${req.path}`);
			return Promise.resolve(false);
		}
		let t = this.transfers.get(`up:${req.hash}`);
		if (!t) {
			if (this.backingOff("up", req.hash)) return Promise.resolve(false);
			t = this.enqueue(this.transfer("up", req, req.bytes.length, { read: async () => req.bytes, changed: () => undefined }), null);
		}
		const waiting = t;
		return new Promise((resolve) => waiting.waiters.push((ended) => resolve(ended === "ok")));
	}

	download(req: BlobReq): Promise<Uint8Array | null> {
		if (!this.deps.store || this.stopped) return Promise.resolve(null);
		if (req.size > this.maxBlobBytes || this.quarantinedDown.has(req.hash)) return Promise.resolve(null);
		const got = this.take(req.hash);
		if (got) return Promise.resolve(got);
		let t = this.transfers.get(`down:${req.hash}`);
		if (!t) {
			if (this.backingOff("down", req.hash)) return Promise.resolve(null);
			t = this.enqueue(this.transfer("down", req, req.size, null), null);
		}
		const waiting = t;
		return new Promise((resolve) => waiting.waiters.push((_ended, bytes) => resolve(bytes)));
	}

	// ---- running ----------------------------------------------------------------------------

	/** Start what the budget admits now (also call it when `admit` turns true: resume, unpause). */
	pump(): void {
		if (this.stopped || !(this.deps.admit?.() ?? true)) return;
		while (this.pending.length > 0) {
			const t = this.pending[0]!;
			if (this.inUse > 0 && this.inUse + t.cost > this.budget) return;
			this.pending.shift();
			this.inUse += t.cost;
			t.running = this.run(t);
		}
	}

	/** Abort every transfer, answer every waiter, start nothing more. Resolves once the running ones ended. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.ctl.abort(new Error("blob queue stopped"));
		for (const t of this.pending.splice(0)) {
			this.transfers.delete(t.key);
			for (const w of t.waiters) w("stopped", null);
		}
		this.ready.clear();
		await Promise.all([...this.transfers.values()].map((t) => t.running));
	}

	private transfer(direction: Direction, req: Req, size: number, source: UploadSource | null): Transfer {
		return {
			key: `${direction}:${req.hash}`, direction, req: { hash: req.hash, docId: req.docId, path: req.path }, size,
			cost: Math.max(size, BLOB_TRANSFER_MIN_COST), who: new Map(), waiters: [], source, running: null,
		};
	}

	private enqueue(t: Transfer, claimant: BlobClaimant | null): Transfer {
		if (claimant) t.who.set(claimant.docId, claimant.path);
		this.transfers.set(t.key, t);
		this.pending.push(t);
		this.pump();
		return t;
	}

	private unqueue(t: Transfer): void {
		const i = this.pending.indexOf(t);
		if (i >= 0) this.pending.splice(i, 1);
		this.transfers.delete(t.key);
	}

	/** Downloaded bytes for `hash`, taken (single use: the disk write transfers them). */
	private take(hash: string): Uint8Array | null {
		const got = this.ready.get(hash);
		if (!got) return null;
		this.ready.delete(hash);
		this.release(got.cost);
		return got.bytes;
	}

	/** The doc claimed `except`: its claims on other transfers not started yet are stale (its file or blob moved on). */
	private forget(direction: Direction, docId: DocId, except: string): void {
		for (const t of [...this.pending]) {
			if (t.direction !== direction || t.key === except || !t.who.delete(docId)) continue;
			if (t.who.size === 0 && t.waiters.length === 0) this.unqueue(t);
		}
	}

	private release(bytes: number): void {
		this.inUse -= bytes;
		this.pump();
	}

	private isConfirmed(hash: string): boolean {
		const at = this.confirmed.get(hash);
		if (at === undefined) return false;
		if (this.deps.clock.monotonic() - at < CONFIRMED_TTL_MS) return true;
		this.confirmed.delete(hash);
		return false;
	}

	private async run(t: Transfer): Promise<void> {
		let ended: Ended = "failed";
		let bytes: Uint8Array | null = null;
		try {
			if (t.direction === "up") ended = await this.runUpload(t);
			else [ended, bytes] = await this.runDownload(t);
		} catch (e) {
			// The disk read, the digest or the database failed: a failed attempt with its backoff (in memory first), never a stuck or spinning one.
			if (this.stopped) ended = "stopped";
			else {
				ended = "failed";
				this.deps.diag?.(`blob ${t.direction} ${t.req.path} failed: ${e instanceof Error ? e.message : String(e)}`);
				await this.failed(t.direction, t.req, t.size).catch(() => undefined);
			}
		} finally {
			this.transfers.delete(t.key);
			this.inUse -= t.cost;
		}
		// Every consumer of the bytes but one gets a copy: a disk write transfers (detaches) them.
		const owners = t.waiters.length + (bytes && this.ready.has(t.req.hash) ? 1 : 0);
		t.waiters.forEach((w, i) => w(ended, bytes && i < owners - 1 ? bytes.slice() : bytes));
		if (ended !== "stopped" && t.who.size > 0) this.deps.wake?.([...t.who].map(([docId, path]) => ({ docId, path })));
		this.pump();
	}

	private async runUpload(t: Transfer): Promise<Ended> {
		const store = this.deps.store!;
		const source = t.source!;
		const hash = t.req.hash;
		const bytes = await source.read();
		if (this.stopped) return "stopped";
		if (!bytes) {
			// Unreadable or gone; the source marked the path for a re-hash. Backed off, so re-plans cannot spin on it.
			await this.failed("up", t.req, t.size);
			return "failed";
		}
		if (bytesToHex(await this.deps.hash.sha256(bytes)) !== hash) {
			source.changed(); // the file changed under us: re-plan
			return "changed";
		}
		try {
			await putSealed(store, this.deps.crypto, hash as ContentHash, bytes, this.deps.touch, this.ctl.signal);
		} catch (e) {
			if (this.stopped) return "stopped";
			if (e instanceof BlobTooLargeError) {
				this.refusedUp.add(hash);
				await this.settled("up", hash);
				this.deps.notice?.("warn", "blob-too-large", `attachment too large to sync: ${t.req.path} (refused by the server)`);
				return "refused";
			}
			await this.failed("up", t.req, bytes.length);
			return "failed";
		}
		this.confirmed.set(hash, this.deps.clock.monotonic());
		if (!this.stopped) await this.settled("up", hash); // stopped: the record stays; the next start re-puts (idempotent)
		return "ok";
	}

	private async runDownload(t: Transfer): Promise<[Ended, Uint8Array | null]> {
		const hash = t.req.hash;
		const got = await this.getVerified(hash as ContentHash);
		if (this.stopped) return ["stopped", null];
		if (got.ok) {
			this.streaks.clear(hash);
			if (t.who.size > 0) {
				this.ready.set(hash, { bytes: got.bytes, cost: t.cost, who: t.who, pass: this.passes });
				this.inUse += t.cost;
			}
			await this.settled("down", hash);
			return ["ok", got.bytes];
		}
		if (got.deterministic) this.deps.notice?.("warn", "blob-corrupt", `downloaded attachment failed verification: ${t.req.path}`);
		await this.failed("down", t.req, t.size);
		if (this.streaks.note(hash, got.deterministic, this.deps.clock.monotonic())) {
			this.quarantinedDown.add(hash);
			this.due.delete(`down:${hash}`);
			this.deps.notice?.("error", "blob-quarantined", `attachment quarantined after repeated verification failures: ${t.req.path}`);
		}
		return ["failed", null];
	}

	/** Verified bytes, or why they are unavailable (blobStore.ts BlobFetch). Never throws. */
	private async getVerified(hash: ContentHash): Promise<BlobFetch> {
		const store = this.deps.store;
		if (!store) return { ok: false, reason: "transport", deterministic: false };
		try {
			return await getOpened(store, this.deps.crypto, hash, async (b) => bytesToHex(await this.deps.hash.sha256(b)), this.ctl.signal);
		} catch {
			return { ok: false, reason: "transport", deterministic: false };
		}
	}
}
