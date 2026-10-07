/**
 * Repository: every IndexedDB transaction of DESIGN §e.2 over StorageDb<YS>.
 *
 * Rules (§e.2):
 *  - a transaction awaits only its own requests; rows are gated BEFORE the tx;
 *  - the cursor (meta.cursor) is persisted only by the transaction that makes
 *    the seq accounted: tLive (T_ingest + T_receipt + T_stale) and tFeedPage;
 *  - all read-write transactions run through one serial queue, so the cursor
 *    preview is exact and the in-memory stream cache equals the DB.
 *
 * The in-memory `streams` cache is updated only after a commit.
 */

import { CFG_STREAM, NS_STREAM, streamClass, streamDocId } from "../../core/types";
import type { ClientFrameId, DeviceId, Seq, StreamName, VaultEpoch, VaultId } from "../../core/types";
import { QUARANTINE_MAX_RECORDS } from "../../core/limits";
import type { KeyRange, StorageDb, StoragePort, StorageTx } from "../../ports/storage";
import { CursorTracker } from "../sync/cursor";
import {
	DB_SCHEMA_VERSION, INDEX, STORE, STORE_SPECS, dbName, tailRange,
	type MetaCursor, type MetaFrameNoFloor, type MetaIdentity, type MetaKeyring, type MetaOutboxOrder, type MetaDaily, type OutboxRecord, type OutboxState, type QuarantineRecord,
	type SnapshotRecord, type StreamRecord, type TailRecord, type YaosSchema,
} from "./schema";

export type Mut<T> = { -readonly [K in keyof T]: T[K] };
/**
 * schema.ts declares YaosSchema as an `interface`, which has no implicit index
 * signature and so does not satisfy `SchemaShape`. A mapped type alias does.
 */
export type YS = { readonly [K in keyof YaosSchema]: YaosSchema[K] };
type Tx = StorageTx<YS>;
type StoreKey = keyof YS & string;

const MAXK = Number.MAX_SAFE_INTEGER;

/** Highest own ns / cfg frameNo of an abandoned epoch timeline (MetaFrameNoFloor). */
export interface FrameNoFloor {
	readonly ns: number;
	readonly cfg: number;
}

export interface RepoIdentity {
	readonly vaultId: VaultId;
	readonly vaultEpoch: VaultEpoch;
	readonly deviceId: DeviceId;
	readonly clientVersion: string;
}

export type OpenOutcome =
	| { readonly t: "fresh" }
	| { readonly t: "existing"; readonly identity: MetaIdentity }
	| { readonly t: "mismatch"; readonly found: MetaIdentity };

export type PriorityFn = (rec: StreamRecord) => number;

export function defaultPriority(rec: Pick<StreamRecord, "cls">): number {
	switch (rec.cls) {
		case "keyring": return -100; // read first: keys are verified before anything is opened (e2ee-design §9.3)
		case "ns": return 0;
		case "cfg": return 1;
		case "body": case "canvas": return 100;
		case "blobchunk": return 1000;
		default: return 5000;
	}
}

export function newStreamRecord(stream: StreamName, nowMs: number): StreamRecord {
	const cls = streamClass(stream);
	return {
		stream, cls, docId: streamDocId(stream), appliedSeq: 0, remoteHeadSeq: 0, stale: 0, priority: defaultPriority({ cls }),
		snapshotCoversSeq: 0, tailRows: 0, tailBytes: 0, remoteCheckpointCoversSeq: 0, rowsSinceRemoteCheckpoint: 0,
		bytesSinceRemoteCheckpoint: 0, lastOwnSeq: 0, bodyVersion: { remoteSeq: 0, localOrder: 0 }, quarantinedRows: 0, frozen: 0,
		frozenReason: null, disputedCheckpointCoversSeq: 0, lastAccessMs: nowMs, textHash: null,
	};
}

/** Frame to append to the outbox; order is assigned by the tx. */
export type NewOutboxFrame = Omit<OutboxRecord, "order" | "attempts" | "lastSentAtMs">;

/** One live relay event, already gated (DESIGN §d.6 stages 1-2). Arrival (= seq) order. */
export type LiveItem =
	/** Committed row from another device (or an own row without outbox record). */
	| { readonly t: "row"; readonly row: TailRecord; readonly settleAdoptable: ClientFrameId | null }
	| { readonly t: "quarantine"; readonly rec: QuarantineRecord; readonly settleAdoptable: ClientFrameId | null }
	/** Own frame receipt (or late receipt). Content comes from the outbox record. */
	| { readonly t: "receipt"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly seq: Seq }
	/** Overflow / null payload: record stale, read later (T_stale). */
	| { readonly t: "stale"; readonly stream: StreamName; readonly seq: Seq }
	/** Unknown stream class: accounted, nothing stored. */
	| { readonly t: "account"; readonly seq: Seq };

export interface LiveResult {
	readonly vaultSeq: Seq;
	readonly streams: ReadonlyMap<StreamName, StreamRecord>;
	/** Outbox records deleted (receipted / settled adoptables). */
	readonly removed: readonly OutboxRecord[];
	/** Held records released to pending or re-pointed. */
	readonly updated: readonly OutboxRecord[];
	/** Tail rows written (incl. receipts), for replica apply / fold. */
	readonly tailPut: readonly TailRecord[];
}

export interface ReadPageInput {
	readonly stream: StreamName;
	readonly rows: readonly TailRecord[];
	readonly quarantines: readonly QuarantineRecord[];
	readonly lateReceipts: readonly { readonly clientFrameId: ClientFrameId; readonly seq: Seq }[];
	readonly settleAdoptables: readonly ClientFrameId[];
	/** Fresh-stream checkpoint: stored directly as the snapshot (exact-key tail deletes <= coversSeq). */
	readonly freshSnapshot: SnapshotRecord | null;
	/** Read finished (more=false): every row <= through is known. appliedSeq := min(remoteHeadSeq, through). */
	readonly completeThrough: Seq | null;
	/** Highest seq the relay reported for the stream. */
	readonly lastSeq: Seq;
	readonly checkpointSeq: Seq;
}

export interface SnapshotInput {
	readonly stream: StreamName;
	/** CAS: streams[stream].snapshotCoversSeq must still equal this. */
	readonly expectSnapshotCoversSeq: Seq;
	readonly snapshot: SnapshotRecord;
	/** Exact tail keys folded into the snapshot. */
	readonly deleteSeqs: readonly Seq[];
	/** Union with a remote checkpoint: bump appliedSeq / remoteSeq / remoteCheckpointCoversSeq to coversSeq. */
	readonly fromRemote: boolean;
}

export type OutboxChange =
	| { readonly t: "release"; readonly clientFrameId: ClientFrameId }
	| { readonly t: "delete"; readonly clientFrameId: ClientFrameId }
	| { readonly t: "state"; readonly clientFrameId: ClientFrameId; readonly state: OutboxState }
	/** held only: wait for another frame instead (a ref whose own x: chunks remain). */
	| { readonly t: "repoint"; readonly clientFrameId: ClientFrameId; readonly dependsOn: ClientFrameId };

export class Repo {
	readonly cursor: CursorTracker;
	private readonly cache = new Map<StreamName, StreamRecord>();
	private queue: Promise<unknown> = Promise.resolve();
	private ckptDuty = new Set<StreamName>();
	/** meta frameNoFloor (epoch migration, e2ee-design §8.2); read at open. */
	frameNoFloor: FrameNoFloor = { ns: 0, cfg: 0 };
	priorityFn: PriorityFn = defaultPriority;
	/** Monotonic clock for the cursor gap timer. */
	monotonic: () => number = () => 0;
	/** Name of the §e.2 transaction running on the serial queue (crash tests label commits with it). */
	txLabel: string | null = null;

	private constructor(
		readonly db: StorageDb<YS>,
		readonly identity: MetaIdentity,
		cursor: MetaCursor,
		private outboxNext: number,
	) {
		this.cursor = new CursorTracker(cursor.vaultSeq, cursor.headSeqSeen);
	}

	get deviceId(): DeviceId {
		return this.identity.deviceId;
	}

	/**
	 * Open (or create) the DB for this identity. `mismatch` closes nothing: the
	 * caller deletes the DB and recovers (DESIGN §i.5).
	 */
	static async open(storage: StoragePort, id: RepoIdentity, nowMs: number, opts: { recoveredFromMirror?: boolean; frameNoFloor?: FrameNoFloor | null } = {}): Promise<{ repo: Repo | null; outcome: OpenOutcome; db: StorageDb<YS> }> {
		const db = await storage.open<YS>(dbName(id.vaultId, id.vaultEpoch, id.deviceId), DB_SCHEMA_VERSION, STORE_SPECS);
		const res = await db.tx([STORE.meta], "readwrite", async (tx) => {
			const ident = await tx.get(STORE.meta, "identity") as MetaIdentity | undefined;
			if (ident) {
				if (ident.vaultId !== id.vaultId || ident.vaultEpoch !== id.vaultEpoch || ident.deviceId !== id.deviceId || ident.schemaVersion !== DB_SCHEMA_VERSION) {
					return { outcome: { t: "mismatch", found: ident } as OpenOutcome, ident, cursor: null, next: 0 };
				}
				const cursor = (await tx.get(STORE.meta, "cursor") as MetaCursor | undefined) ?? { key: "cursor", vaultSeq: 0, headSeqSeen: 0 };
				const order = (await tx.get(STORE.meta, "outboxOrder") as MetaOutboxOrder | undefined) ?? { key: "outboxOrder", next: 1 };
				if (opts.frameNoFloor) await raiseFrameNoFloor(tx, opts.frameNoFloor);
				return { outcome: { t: "existing", identity: ident } as OpenOutcome, ident, cursor, next: order.next };
			}
			const fresh: MetaIdentity = {
				key: "identity", vaultId: id.vaultId, vaultEpoch: id.vaultEpoch, deviceId: id.deviceId, schemaVersion: DB_SCHEMA_VERSION,
				clientVersion: id.clientVersion, createdAtMs: nowMs, recoveredFromMirror: opts.recoveredFromMirror ?? false,
			};
			const cursor: MetaCursor = { key: "cursor", vaultSeq: 0, headSeqSeen: 0 };
			tx.put(STORE.meta, fresh);
			tx.put(STORE.meta, cursor);
			tx.put(STORE.meta, { key: "outboxOrder", next: 1 });
			if (opts.frameNoFloor) await raiseFrameNoFloor(tx, opts.frameNoFloor);
			return { outcome: { t: "fresh" } as OpenOutcome, ident: fresh, cursor, next: 1 };
		});
		if (res.outcome.t === "mismatch" || res.cursor === null) return { repo: null, outcome: res.outcome, db };
		const repo = new Repo(db, res.ident, res.cursor, res.next);
		await repo.loadCache();
		return { repo, outcome: res.outcome, db };
	}

	private async loadCache(): Promise<void> {
		const { streams, duty, floor } = await this.db.tx([STORE.streams, STORE.meta], "readonly", async (tx) => {
			const streams = await tx.getAll(STORE.streams);
			const d = await tx.get(STORE.meta, "ckptDuty");
			const f = await tx.get(STORE.meta, "frameNoFloor");
			return { streams, duty: d && d.key === "ckptDuty" ? d.streams : [], floor: f && f.key === "frameNoFloor" ? { ns: f.ns, cfg: f.cfg } : { ns: 0, cfg: 0 } };
		});
		for (const s of streams) this.cache.set(s.stream, s);
		this.ckptDuty = new Set(duty);
		this.frameNoFloor = floor;
	}

	/** Serial queue for read-write transactions. */
	private serial<T>(label: string, fn: () => Promise<T>): Promise<T> {
		const run = async () => {
			this.txLabel = label;
			try {
				return await fn();
			} finally {
				this.txLabel = null;
			}
		};
		const p = this.queue.then(run, run);
		this.queue = p.then(() => undefined, () => undefined);
		return p;
	}

	// -------------------------------------------------------------------------
	// Synchronous cache reads
	// -------------------------------------------------------------------------

	stream(stream: StreamName): StreamRecord | undefined {
		return this.cache.get(stream);
	}
	streams(): IterableIterator<StreamRecord> {
		return this.cache.values();
	}
	hasCkptDuty(stream: StreamName): boolean {
		return this.ckptDuty.has(stream);
	}
	get nextOrder(): number {
		return this.outboxNext;
	}

	// -------------------------------------------------------------------------
	// Plain reads (readonly txs)
	// -------------------------------------------------------------------------

	async getSnapshot(stream: StreamName): Promise<SnapshotRecord | undefined> {
		return this.db.tx([STORE.snapshots], "readonly", (tx) => tx.get(STORE.snapshots, stream));
	}
	async getTail(stream: StreamName, afterSeq: Seq = 0, throughSeq: Seq = MAXK): Promise<TailRecord[]> {
		return this.db.tx([STORE.tail], "readonly", (tx) => tx.getAll(STORE.tail, tailRange(stream, afterSeq, throughSeq)));
	}
	/** Snapshot + tail + own outbox of one stream in one read tx (handle load, DESIGN §d.1). */
	async loadStream(stream: StreamName): Promise<{ snapshot: SnapshotRecord | undefined; tail: TailRecord[]; outbox: OutboxRecord[] }> {
		return this.db.tx([STORE.snapshots, STORE.tail, STORE.outbox], "readonly", async (tx) => {
			const snapshot = await tx.get(STORE.snapshots, stream);
			const tail = await tx.getAll(STORE.tail, tailRange(stream));
			const outbox = await tx.getAllByIndex(STORE.outbox, INDEX.outboxByStream, streamOrderRange(stream));
			return { snapshot, tail, outbox };
		});
	}
	async outboxAll(): Promise<OutboxRecord[]> {
		return this.db.tx([STORE.outbox], "readonly", (tx) => tx.getAllByIndex(STORE.outbox, INDEX.outboxByOrder));
	}
	async outboxOf(stream: StreamName): Promise<OutboxRecord[]> {
		return this.db.tx([STORE.outbox], "readonly", (tx) => tx.getAllByIndex(STORE.outbox, INDEX.outboxByStream, streamOrderRange(stream)));
	}
	async getOutbox(cfid: ClientFrameId): Promise<OutboxRecord | undefined> {
		return this.db.tx([STORE.outbox], "readonly", (tx) => tx.get(STORE.outbox, cfid));
	}
	async quarantineOf(stream: StreamName): Promise<QuarantineRecord[]> {
		return this.db.tx([STORE.quarantine], "readonly", (tx) => tx.getAll(STORE.quarantine, tailRange(stream)));
	}
	async count(store: StoreKey): Promise<number> {
		return this.db.tx([store], "readonly", (tx) => tx.count(store));
	}
	async staleStreams(limit: number): Promise<StreamRecord[]> {
		return this.db.tx([STORE.streams], "readonly", (tx) =>
			tx.getAllByIndex(STORE.streams, INDEX.streamsByStale, { lower: [1, -MAXK], upper: [1, MAXK] }, limit));
	}
	async getMeta<K extends "cursor" | "outboxOrder" | "daily" | "identity" | "ckptDuty" | "frameNoFloor" | "keyring">(key: K) {
		return this.db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, key));
	}
	/** MetaKeyring (e2ee-design §18.3): keyring diagnostics and the lazy own-seal count. No key bytes. */
	putKeyringMeta(m: MetaKeyring): Promise<void> {
		return this.serial("putKeyringMeta", () => this.db.tx([STORE.meta], "readwrite", async (tx) => {
			tx.put(STORE.meta, m);
		}));
	}

	// -------------------------------------------------------------------------
	// T_edit / T_adopt: append own frames (or an adoptable)
	// -------------------------------------------------------------------------

	/** T_edit (touchStream=true) or T_adopt (touchStream=false). Commits BEFORE any append. */
	tEdit(frames: readonly NewOutboxFrame[], nowMs: number, touchStream = true): Promise<OutboxRecord[]> {
		return this.serial("tEdit", async () => {
			const touched = new Map<StreamName, StreamRecord>();
			const out = await this.db.tx([STORE.outbox, STORE.meta, STORE.streams], "readwrite", async (tx) => {
				const meta = (await tx.get(STORE.meta, "outboxOrder") as MetaOutboxOrder | undefined) ?? { key: "outboxOrder", next: 1 };
				let next = Math.max(meta.next, this.outboxNext);
				const recs: OutboxRecord[] = [];
				for (const f of frames) {
					const rec: OutboxRecord = { ...f, order: next++, attempts: 0, lastSentAtMs: 0 };
					tx.put(STORE.outbox, rec);
					recs.push(rec);
					if (touchStream) {
						const s = touched.get(f.stream) ?? (await tx.get(STORE.streams, f.stream)) ?? newStreamRecord(f.stream, nowMs);
						const m: Mut<StreamRecord> = { ...s, bodyVersion: { remoteSeq: s.bodyVersion.remoteSeq, localOrder: rec.order }, lastAccessMs: nowMs };
						touched.set(f.stream, m);
					}
				}
				for (const s of touched.values()) tx.put(STORE.streams, s);
				tx.put(STORE.meta, { key: "outboxOrder", next });
				return { recs, next };
			});
			this.outboxNext = out.next;
			for (const s of touched.values()) this.cache.set(s.stream, s);
			return out.recs;
		});
	}

	// -------------------------------------------------------------------------
	// T_sent (lazy, diagnostics only)
	// -------------------------------------------------------------------------

	tSent(updates: readonly { readonly clientFrameId: ClientFrameId; readonly attempts: number; readonly lastSentAtMs: number }[]): Promise<void> {
		if (updates.length === 0) return Promise.resolve();
		return this.serial("tSent", () => this.db.tx([STORE.outbox], "readwrite", async (tx) => {
			for (const u of updates) {
				const r = await tx.get(STORE.outbox, u.clientFrameId);
				if (!r || (r.state !== "pending" && r.state !== "sent")) continue;
				tx.put(STORE.outbox, { ...r, state: "sent", attempts: u.attempts, lastSentAtMs: u.lastSentAtMs });
			}
		}));
	}

	// -------------------------------------------------------------------------
	// T_ingest + T_receipt + T_stale (one tx per live batch, arrival order)
	// -------------------------------------------------------------------------

	tLive(items: readonly LiveItem[], nowMs: number, day: string): Promise<LiveResult> {
		return this.serial("tLive", async () => {
			const seqs = items.map((i) => (i.t === "row" ? i.row.seq : i.t === "quarantine" ? i.rec.seq : i.seq));
			const vAfter = this.cursor.preview(seqs);
			const self = this.deviceId;
			const recs = new Map<StreamName, Mut<StreamRecord>>();
			const removed: OutboxRecord[] = [];
			const updated: OutboxRecord[] = [];
			const tailPut: TailRecord[] = [];
			const duty = new Set(this.ckptDuty);
			let dutyChanged = false;
			const res = await this.db.tx([STORE.outbox, STORE.tail, STORE.quarantine, STORE.streams, STORE.meta], "readwrite", async (tx) => {
				const getRec = async (stream: StreamName): Promise<Mut<StreamRecord>> => {
					let r = recs.get(stream);
					if (!r) {
						r = { ...((await tx.get(STORE.streams, stream)) ?? newStreamRecord(stream, nowMs)) };
						recs.set(stream, r);
					}
					return r;
				};
				let receipts = 0;
				let receiptBytes = 0;
				for (const it of items) {
					if (it.t === "account") continue;
					if (it.t === "stale") {
						const r = await getRec(it.stream);
						r.remoteHeadSeq = Math.max(r.remoteHeadSeq, it.seq);
						r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
						r.priority = this.priorityFn(r);
						continue;
					}
					if (it.t === "receipt") {
						const r = await getRec(it.stream);
						const ob = await tx.get(STORE.outbox, it.clientFrameId);
						if (ob && ob.stream === it.stream) {
							const row = receiptRow(ob, it.seq, self);
							if (await putTail(tx, r, row)) tailPut.push(row);
							tx.delete(STORE.outbox, ob.clientFrameId);
							removed.push(ob);
							updated.push(...(await releaseDependents(tx, ob)));
							r.lastOwnSeq = Math.max(r.lastOwnSeq, it.seq);
							if (it.seq > r.remoteCheckpointCoversSeq) {
								r.rowsSinceRemoteCheckpoint++;
								r.bytesSinceRemoteCheckpoint += row.content.length;
							}
							if (!duty.has(it.stream) && it.seq >= r.remoteHeadSeq) {
								duty.add(it.stream);
								dutyChanged = true;
							}
							receipts++;
							receiptBytes += ob.sealed.length;
							advance(r, it.seq, vAfter);
						} else {
							// Missing record: already settled (late receipt / duplicate). The seq is still accounted.
							r.remoteHeadSeq = Math.max(r.remoteHeadSeq, it.seq);
							r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
						}
						r.priority = this.priorityFn(r);
						continue;
					}
					const seq = it.t === "row" ? it.row.seq : it.rec.seq;
					const stream = it.t === "row" ? it.row.stream : it.rec.stream;
					const deviceId = it.t === "row" ? it.row.deviceId : it.rec.deviceId;
					const r = await getRec(stream);
					if (it.t === "row") {
						if (await putTail(tx, r, it.row)) tailPut.push(it.row);
						if (seq > r.remoteCheckpointCoversSeq && seq > r.appliedSeq) {
							r.rowsSinceRemoteCheckpoint++;
							r.bytesSinceRemoteCheckpoint += it.row.content.length;
						}
					} else {
						await putQuarantine(tx, r, it.rec);
					}
					// An own row this store never receipted (an earlier store, lost with IDB) is remote here: its text
					// is not known to be on disk.
					if (deviceId !== self || seq > r.lastOwnSeq) {
						r.bodyVersion = { remoteSeq: Math.max(r.bodyVersion.remoteSeq, seq), localOrder: r.bodyVersion.localOrder };
					}
					if (deviceId !== self && seq > r.lastOwnSeq && duty.delete(stream)) dutyChanged = true;
					advance(r, seq, vAfter);
					r.priority = this.priorityFn(r);
					if (it.settleAdoptable) {
						const ob = await tx.get(STORE.outbox, it.settleAdoptable);
						if (ob && ob.state === "adoptable") {
							tx.delete(STORE.outbox, ob.clientFrameId);
							removed.push(ob);
							updated.push(...(await releaseDependents(tx, ob)));
						}
					}
				}
				for (const r of recs.values()) tx.put(STORE.streams, r);
				const cur = (await tx.get(STORE.meta, "cursor") as MetaCursor | undefined) ?? { key: "cursor", vaultSeq: 0, headSeqSeen: 0 };
				const v = Math.max(cur.vaultSeq, vAfter);
				tx.put(STORE.meta, { key: "cursor", vaultSeq: v, headSeqSeen: Math.max(cur.headSeqSeen, this.cursor.headSeqSeen, v) });
				if (dutyChanged) tx.put(STORE.meta, { key: "ckptDuty", streams: [...duty] });
				if (receipts > 0) {
					const d = await tx.get(STORE.meta, "daily") as MetaDaily | undefined;
					const base = d && d.day === day ? d : { key: "daily" as const, day, framesSent: 0, bytesSent: 0 };
					tx.put(STORE.meta, { ...base, framesSent: base.framesSent + receipts, bytesSent: base.bytesSent + receiptBytes });
				}
				if (await tx.count(STORE.quarantine) > QUARANTINE_MAX_RECORDS) await evictQuarantine(tx);
				return v;
			});
			this.cursor.commit(seqs, res, this.monotonic());
			for (const r of recs.values()) this.cache.set(r.stream, r);
			if (dutyChanged) this.ckptDuty = duty;
			return { vaultSeq: res, streams: recs, removed, updated, tailPut };
		});
	}

	// -------------------------------------------------------------------------
	// T_feed_page
	// -------------------------------------------------------------------------

	tFeedPage(entries: readonly { readonly stream: StreamName; readonly lastSeq: Seq }[], throughSeq: Seq, headSeq: Seq, nowMs: number): Promise<{ vaultSeq: Seq; changed: StreamRecord[] }> {
		return this.serial("tFeedPage", async () => {
			const vAfter = this.cursor.preview([], throughSeq);
			const changed: Mut<StreamRecord>[] = [];
			const v = await this.db.tx([STORE.streams, STORE.meta], "readwrite", async (tx) => {
				for (const e of entries) {
					const ec = streamClass(e.stream);
					if (ec === "other") continue;
					const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, e.stream)) ?? newStreamRecord(e.stream, nowMs)) };
					if (e.lastSeq <= r.remoteHeadSeq && this.cache.has(e.stream)) continue;
					r.remoteHeadSeq = Math.max(r.remoteHeadSeq, e.lastSeq);
					r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
					r.priority = this.priorityFn(r);
					tx.put(STORE.streams, r);
					changed.push(r);
				}
				const cur = (await tx.get(STORE.meta, "cursor") as MetaCursor | undefined) ?? { key: "cursor", vaultSeq: 0, headSeqSeen: 0 };
				const v = Math.max(cur.vaultSeq, vAfter);
				tx.put(STORE.meta, { key: "cursor", vaultSeq: v, headSeqSeen: Math.max(cur.headSeqSeen, headSeq, v) });
				return v;
			});
			this.cursor.headSeqSeen = Math.max(this.cursor.headSeqSeen, headSeq);
			this.cursor.commit([], v, this.monotonic());
			for (const r of changed) this.cache.set(r.stream, r);
			return { vaultSeq: v, changed };
		});
	}

	// -------------------------------------------------------------------------
	// T_read_page
	// -------------------------------------------------------------------------

	tReadPage(input: ReadPageInput, nowMs: number): Promise<{ stream: StreamRecord; removed: OutboxRecord[]; updated: OutboxRecord[]; tailPut: TailRecord[] }> {
		return this.serial("tReadPage", async () => {
			const self = this.deviceId;
			const removed: OutboxRecord[] = [];
			const updated: OutboxRecord[] = [];
			const tailPut: TailRecord[] = [];
			const out = await this.db.tx([STORE.tail, STORE.quarantine, STORE.outbox, STORE.streams, STORE.snapshots, STORE.meta], "readwrite", async (tx) => {
				const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, input.stream)) ?? newStreamRecord(input.stream, nowMs)) };
				if (input.freshSnapshot && input.freshSnapshot.coversSeq > r.snapshotCoversSeq) {
					const c = input.freshSnapshot.coversSeq;
					await deleteTailThrough(tx, r, input.stream, c);
					tx.put(STORE.snapshots, input.freshSnapshot);
					r.snapshotCoversSeq = c;
					r.appliedSeq = Math.max(r.appliedSeq, c);
					r.remoteCheckpointCoversSeq = Math.max(r.remoteCheckpointCoversSeq, c);
					r.bodyVersion = { remoteSeq: Math.max(r.bodyVersion.remoteSeq, c), localOrder: r.bodyVersion.localOrder };
					r.rowsSinceRemoteCheckpoint = 0;
					r.bytesSinceRemoteCheckpoint = 0;
				}
				for (const row of input.rows) {
					if (await putTail(tx, r, row)) tailPut.push(row);
					// Own rows reach a page only without an outbox record; past lastOwnSeq they are an earlier store's (tLive).
					if (row.deviceId !== self || row.seq > r.lastOwnSeq) r.bodyVersion = { remoteSeq: Math.max(r.bodyVersion.remoteSeq, row.seq), localOrder: r.bodyVersion.localOrder };
					if (row.seq > r.remoteCheckpointCoversSeq && row.seq > r.appliedSeq) {
						r.rowsSinceRemoteCheckpoint++;
						r.bytesSinceRemoteCheckpoint += row.content.length;
					}
					r.remoteHeadSeq = Math.max(r.remoteHeadSeq, row.seq);
				}
				for (const q of input.quarantines) {
					await putQuarantine(tx, r, q);
					r.remoteHeadSeq = Math.max(r.remoteHeadSeq, q.seq);
				}
				for (const lr of input.lateReceipts) {
					const ob = await tx.get(STORE.outbox, lr.clientFrameId);
					if (!ob) continue;
					const row = receiptRow(ob, lr.seq, self);
					if (await putTail(tx, r, row)) tailPut.push(row);
					tx.delete(STORE.outbox, ob.clientFrameId);
					removed.push(ob);
					updated.push(...(await releaseDependents(tx, ob)));
					r.lastOwnSeq = Math.max(r.lastOwnSeq, lr.seq);
					r.remoteHeadSeq = Math.max(r.remoteHeadSeq, lr.seq);
				}
				for (const cfid of input.settleAdoptables) {
					const ob = await tx.get(STORE.outbox, cfid);
					if (ob && ob.state === "adoptable") {
						tx.delete(STORE.outbox, cfid);
						removed.push(ob);
						updated.push(...(await releaseDependents(tx, ob)));
					}
				}
				r.remoteHeadSeq = Math.max(r.remoteHeadSeq, input.lastSeq);
				if (input.checkpointSeq > r.remoteCheckpointCoversSeq) r.remoteCheckpointCoversSeq = input.checkpointSeq;
				if (input.completeThrough !== null) r.appliedSeq = Math.max(r.appliedSeq, Math.min(r.remoteHeadSeq, input.completeThrough));
				r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
				r.priority = this.priorityFn(r);
				tx.put(STORE.streams, r);
				if (await tx.count(STORE.quarantine) > QUARANTINE_MAX_RECORDS) await evictQuarantine(tx);
				return r;
			});
			this.cache.set(out.stream, out);
			return { stream: out, removed, updated, tailPut };
		});
	}

	// -------------------------------------------------------------------------
	// T_snapshot (checkpoint union) / T_compact
	// -------------------------------------------------------------------------

	/** null = CAS failed (snapshotCoversSeq moved). */
	tSnapshot(input: SnapshotInput): Promise<StreamRecord | null> {
		return this.serial("tSnapshot", async () => {
			const out = await this.db.tx([STORE.snapshots, STORE.tail, STORE.streams], "readwrite", async (tx) => {
				const cur = await tx.get(STORE.streams, input.stream);
				if (!cur || cur.snapshotCoversSeq !== input.expectSnapshotCoversSeq) return null;
				const r: Mut<StreamRecord> = { ...cur };
				const c = input.snapshot.coversSeq;
				for (const seq of input.deleteSeqs) {
					if (seq > c) continue;
					const row = await tx.get(STORE.tail, [input.stream, seq]);
					if (!row) continue;
					tx.delete(STORE.tail, [input.stream, seq]);
					r.tailRows = Math.max(0, r.tailRows - 1);
					r.tailBytes = Math.max(0, r.tailBytes - row.content.length);
				}
				tx.put(STORE.snapshots, input.snapshot);
				r.snapshotCoversSeq = c;
				if (input.fromRemote) {
					r.appliedSeq = Math.max(r.appliedSeq, c);
					r.remoteCheckpointCoversSeq = Math.max(r.remoteCheckpointCoversSeq, c);
					r.bodyVersion = { remoteSeq: Math.max(r.bodyVersion.remoteSeq, c), localOrder: r.bodyVersion.localOrder };
					r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
					r.priority = this.priorityFn(r);
				}
				tx.put(STORE.streams, r);
				return r;
			});
			if (out) this.cache.set(out.stream, out);
			return out;
		});
	}

	// -------------------------------------------------------------------------
	// Outbox transitions: held release (ns create folded), merged deletes,
	// adoptable -> pending (dropped / 60 s), poison.
	// -------------------------------------------------------------------------

	tOutbox(changes: readonly OutboxChange[]): Promise<{ removed: OutboxRecord[]; updated: OutboxRecord[] }> {
		return this.serial("tOutbox", async () => {
			const removed: OutboxRecord[] = [];
			const updated: OutboxRecord[] = [];
			await this.db.tx([STORE.outbox], "readwrite", async (tx) => {
				for (const c of changes) {
					const r = await tx.get(STORE.outbox, c.clientFrameId);
					if (!r) continue;
					if (c.t === "delete") {
						tx.delete(STORE.outbox, r.clientFrameId);
						removed.push(r);
						updated.push(...(await releaseDependents(tx, r)));
					} else if (c.t === "release") {
						if (r.state !== "held") continue;
						const n: OutboxRecord = { ...r, state: "pending", dependsOn: null };
						tx.put(STORE.outbox, n);
						updated.push(n);
					} else if (c.t === "repoint") {
						if (r.state !== "held" || r.dependsOn === c.dependsOn) continue;
						const n: OutboxRecord = { ...r, dependsOn: c.dependsOn };
						tx.put(STORE.outbox, n);
						updated.push(n);
					} else {
						if (r.state === c.state) continue;
						const n: OutboxRecord = { ...r, state: c.state, dependsOn: c.state === "pending" ? null : r.dependsOn };
						tx.put(STORE.outbox, n);
						updated.push(n);
						// adoptable -> pending keeps its dependents held until the adopted frame's receipt (causal
						// order on the relay); a poisoned dependency releases them.
						if (c.state === "poisoned") updated.push(...(await releaseDependents(tx, r)));
					}
				}
			});
			return { removed, updated };
		});
	}

	// -------------------------------------------------------------------------
	// Stream patches (checkpoint results, freeze, access time, textHash)
	// -------------------------------------------------------------------------

	tPatchStreams(patches: readonly { readonly stream: StreamName; readonly patch: (r: Mut<StreamRecord>) => void }[], nowMs: number): Promise<StreamRecord[]> {
		if (patches.length === 0) return Promise.resolve([]);
		return this.serial("tPatchStreams", async () => {
			const out = await this.db.tx([STORE.streams], "readwrite", async (tx) => {
				const res = new Map<StreamName, Mut<StreamRecord>>();
				for (const p of patches) {
					const r = res.get(p.stream) ?? { ...((await tx.get(STORE.streams, p.stream)) ?? newStreamRecord(p.stream, nowMs)) };
					p.patch(r);
					r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
					res.set(p.stream, r);
				}
				for (const r of res.values()) tx.put(STORE.streams, r);
				return [...res.values()];
			});
			for (const r of out) this.cache.set(r.stream, r);
			return out;
		});
	}

	/** releaseQuarantine (DESIGN §d.6): rows that pass go to tail; the rest are marked dismissed; the doc unfreezes. */
	tReleaseQuarantine(stream: StreamName, pass: readonly TailRecord[], dismiss: readonly QuarantineRecord[], nowMs: number): Promise<StreamRecord> {
		return this.serial("tReleaseQuarantine", async () => {
			const out = await this.db.tx([STORE.quarantine, STORE.tail, STORE.streams], "readwrite", async (tx) => {
				const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, stream)) ?? newStreamRecord(stream, nowMs)) };
				for (const row of pass) {
					tx.delete(STORE.quarantine, [stream, row.seq]);
					await putTail(tx, r, row);
				}
				for (const q of dismiss) {
					if (!q.detail.startsWith("dismissed:")) tx.put(STORE.quarantine, { ...q, detail: `dismissed: ${q.detail}` });
				}
				r.quarantinedRows = 0; // dismissed records stay for diagnostics (evicted by age) but no longer count
				r.frozen = 0;
				r.frozenReason = null;
				tx.put(STORE.streams, r);
				return r;
			});
			this.cache.set(stream, out);
			return out;
		});
	}

	/** Recovery (DESIGN §i.5): import mirrored outbox frames (sent -> pending), outboxOrder.next = max + 1. */
	/**
	 * Mirror recovery into a fresh DB. Imported body / canvas frames move their stream's bodyVersion.localOrder
	 * like T_edit: the imported synced records carry no localOrder, and nothing says the frames' text (editor
	 * keystrokes never saved, merges whose write died) is on disk, so Rc must hold until a merge settles it.
	 */
	tImportOutbox(records: readonly OutboxRecord[], nowMs: number): Promise<void> {
		return this.serial("tImportOutbox", async () => {
			const touched = new Map<StreamName, StreamRecord>();
			const next = await this.db.tx([STORE.outbox, STORE.meta, STORE.streams], "readwrite", async (tx) => {
				let max = 0;
				for (const r of records) {
					tx.put(STORE.outbox, r.state === "sent" ? { ...r, state: "pending" } : r);
					max = Math.max(max, r.order);
					const cls = streamClass(r.stream);
					if (cls !== "body" && cls !== "canvas") continue;
					const st = touched.get(r.stream) ?? (await tx.get(STORE.streams, r.stream)) ?? newStreamRecord(r.stream, nowMs);
					if (r.order <= st.bodyVersion.localOrder) continue;
					touched.set(r.stream, { ...st, bodyVersion: { remoteSeq: st.bodyVersion.remoteSeq, localOrder: r.order } });
				}
				for (const st of touched.values()) tx.put(STORE.streams, st);
				const meta = (await tx.get(STORE.meta, "outboxOrder") as MetaOutboxOrder | undefined) ?? { key: "outboxOrder", next: 1 };
				const next = Math.max(meta.next, max + 1);
				tx.put(STORE.meta, { key: "outboxOrder", next });
				const ident = await tx.get(STORE.meta, "identity") as MetaIdentity | undefined;
				if (ident) tx.put(STORE.meta, { ...ident, recoveredFromMirror: true });
				return next;
			});
			this.outboxNext = next;
			for (const st of touched.values()) this.cache.set(st.stream, st);
		});
	}

	/**
	 * Re-gated ns / cfg rows replace the unopened rows they stand for (quarantineRelease.regateUnopened). A row
	 * gone meanwhile (snapshot compaction) is skipped; byte accounting follows the new content.
	 */
	tReplaceTail(stream: StreamName, rows: readonly TailRecord[], nowMs: number): Promise<number> {
		return this.serial("tReplaceTail", async () => {
			let n = 0;
			const out = await this.db.tx([STORE.tail, STORE.streams], "readwrite", async (tx) => {
				const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, stream)) ?? newStreamRecord(stream, nowMs)) };
				for (const row of rows) {
					const old = await tx.get(STORE.tail, [stream, row.seq]);
					if (!old) continue;
					tx.put(STORE.tail, row);
					r.tailBytes = Math.max(0, r.tailBytes - old.content.length + row.content.length);
					n++;
				}
				tx.put(STORE.streams, r);
				return r;
			});
			this.cache.set(stream, out);
			return n;
		});
	}

	/** Delete every record of a stream (retired checkpoint ok, or prune without duty). */
	tDropStream(stream: StreamName): Promise<void> {
		return this.serial("tDropStream", async () => {
			await this.db.tx([STORE.streams, STORE.snapshots, STORE.tail, STORE.quarantine], "readwrite", async (tx) => {
				tx.delete(STORE.streams, stream);
				tx.delete(STORE.snapshots, stream);
				tx.deleteRange(STORE.tail, tailRange(stream));
				tx.deleteRange(STORE.quarantine, tailRange(stream));
			});
			this.cache.delete(stream);
		});
	}

	/** Wait for every queued write. */
	drain(): Promise<void> {
		return this.serial("drain", async () => undefined);
	}

	close(): void {
		this.db.close();
	}
}

// ---------------------------------------------------------------------------
// tx helpers
// ---------------------------------------------------------------------------

export function streamOrderRange(stream: StreamName): KeyRange {
	return { lower: [stream, 0], upper: [stream, MAXK] };
}
function stateOrderRange(state: OutboxState): KeyRange {
	return { lower: [state, 0], upper: [state, MAXK] };
}

/** Merge a carried frameNo floor into meta (max per stream; e2ee-design §8.2). */
async function raiseFrameNoFloor(tx: Tx, f: FrameNoFloor): Promise<void> {
	const cur = await tx.get(STORE.meta, "frameNoFloor") as MetaFrameNoFloor | undefined;
	tx.put(STORE.meta, { key: "frameNoFloor", ns: Math.max(cur?.ns ?? 0, f.ns), cfg: Math.max(cur?.cfg ?? 0, f.cfg) });
}

/** Own frame -> tail row. A bodyUpdateRef record keeps the resolved update as content (local cache). */
function receiptRow(ob: OutboxRecord, seq: Seq, self: DeviceId): TailRecord {
	const kind = ob.kind === "bodyUpdateRef" ? (streamClass(ob.stream) === "canvas" ? "canvasUpdate" : "bodyUpdate") : ob.kind;
	return { stream: ob.stream, seq, deviceId: self, clientFrameId: ob.clientFrameId, kind, authorNsSeq: ob.authorNsSeq, flags: ob.flags, frameNo: ob.frameNo ?? 0, content: ob.content };
}

/** Idempotent tail put; rows already covered by the snapshot are skipped. Returns true if written. */
async function putTail(tx: Tx, r: Mut<StreamRecord>, row: TailRecord): Promise<boolean> {
	if (row.seq <= r.snapshotCoversSeq) return false;
	const existing = await tx.count(STORE.tail, { lower: [row.stream, row.seq], upper: [row.stream, row.seq] });
	tx.put(STORE.tail, row);
	if (existing === 0) {
		r.tailRows++;
		r.tailBytes += row.content.length;
	}
	return true;
}

async function putQuarantine(tx: Tx, r: Mut<StreamRecord>, q: QuarantineRecord): Promise<void> {
	// quarantinedRows counts undismissed records (a dismissed record re-quarantined by a re-read counts again).
	const existing = await tx.get(STORE.quarantine, [q.stream, q.seq]);
	tx.put(STORE.quarantine, q);
	if (existing === undefined || existing.detail.startsWith("dismissed:")) r.quarantinedRows++;
	r.frozen = 1;
	r.frozenReason = q.reason;
}

async function evictQuarantine(tx: Tx): Promise<void> {
	const n = await tx.count(STORE.quarantine);
	const excess = n - QUARANTINE_MAX_RECORDS;
	if (excess <= 0) return;
	const oldest = await tx.getAllByIndex(STORE.quarantine, INDEX.quarantineByAt, undefined, excess);
	for (const q of oldest) tx.delete(STORE.quarantine, [q.stream, q.seq]);
}

async function deleteTailThrough(tx: Tx, r: Mut<StreamRecord>, stream: StreamName, c: Seq): Promise<void> {
	const rows = await tx.getAll(STORE.tail, tailRange(stream, 0, c));
	for (const row of rows) {
		tx.delete(STORE.tail, [stream, row.seq]);
		r.tailRows = Math.max(0, r.tailRows - 1);
		r.tailBytes = Math.max(0, r.tailBytes - row.content.length);
	}
}

/**
 * appliedSeq advances on a stored row only when the stream was caught up and
 * every seq <= seq is accounted after this tx (no unknown rows below it).
 * Otherwise the stream becomes stale and is read later.
 */
function advance(r: Mut<StreamRecord>, seq: Seq, vAfter: Seq): void {
	const caughtUp = r.appliedSeq >= r.remoteHeadSeq;
	if (caughtUp && seq > r.appliedSeq && seq <= vAfter) r.appliedSeq = seq;
	r.remoteHeadSeq = Math.max(r.remoteHeadSeq, seq);
	r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
}

/**
 * DESIGN §e.1 dependsOn rule. Only adoptables and x: chunks are dependencies
 * released by record removal; ns creates are released by the fold
 * (nsRuntime). A held record whose dependency is gone is re-pointed to the
 * next remaining dependency of the same kind, else released to pending.
 */
async function releaseDependents(tx: Tx, gone: OutboxRecord): Promise<OutboxRecord[]> {
	const isChunk = streamClass(gone.stream) === "blobchunk";
	// Adoption dependencies: an adoptable, or an adopted record re-appended as pending (dependents wait for its receipt).
	if (gone.adoptOf === null && !isChunk) return [];
	if (gone.stream === NS_STREAM || gone.stream === CFG_STREAM) return [];
	const held = await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, stateOrderRange("held"));
	const out: OutboxRecord[] = [];
	for (const h of held) {
		if (h.dependsOn !== gone.clientFrameId) continue;
		let best: OutboxRecord | null = null;
		// x: streams sort by (stream, order): the newest remaining own chunk is the max order, not the last iterated.
		const candidates = h.kind === "bodyUpdateRef"
			? await tx.getAllByIndex(STORE.outbox, INDEX.outboxByStream, { lower: ["x:", 0], upper: ["x;", 0], upperOpen: true })
			: (await tx.getAllByIndex(STORE.outbox, INDEX.outboxByStream, streamOrderRange(h.stream))).filter((c) => c.adoptOf !== null && c.state !== "poisoned");
		for (const c of candidates) {
			if (c.clientFrameId !== gone.clientFrameId && c.order < h.order && (!best || c.order > best.order)) best = c;
		}
		const dep: ClientFrameId | null = best ? best.clientFrameId : null;
		const n: OutboxRecord = dep ? { ...h, dependsOn: dep } : { ...h, state: "pending", dependsOn: null };
		tx.put(STORE.outbox, n);
		out.push(n);
	}
	return out;
}
