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

import { NS_STREAM, streamClass, streamDocId } from "../../core/types";
import type { ClientFrameId, DeviceId, Seq, StreamName, VaultEpoch, VaultId } from "../../core/types";
import { QUARANTINE_MAX_RECORDS } from "../../core/limits";
import type { KeyRange, StorageDb, StoragePort, StorageTx } from "../../ports/storage";
import { CursorTracker } from "../sync/cursor";
import { LOCAL_FLAG_UNOPENED } from "../sync/foldRuntime";
import {
	DB_SCHEMA_VERSION, INDEX, STORE, STORE_SPECS, dbName, tailRange,
	type MetaCursor, type MetaFrameNoFloor, type MetaIdentity, type MetaDocDeletes, type MetaKeyring, type MetaKeyringRecords, type MetaOutboxOrder, type MetaPathBase, type MetaDaily, type OutboxRecord, type OutboxState, type QuarantineRecord,
	type SnapshotRecord, type StreamRecord, type TailRecord, type YaosSchema,
} from "./schema";

export type Mut<T> = { -readonly [K in keyof T]: T[K] };
/**
 * schema.ts declares YaosSchema as an `interface`, which has no implicit index
 * signature and so does not satisfy `SchemaShape`. A mapped type alias does.
 */
export type YS = { readonly [K in keyof YaosSchema]: YaosSchema[K] };
type Tx = StorageTx<YS>;
type StoreKey = keyof YS;

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
		case "snap": return 2;
		case "body": case "canvas": return 100;
		default: return 5000;
	}
}

export function newStreamRecord(stream: StreamName): StreamRecord {
	return {
		stream, cls: streamClass(stream), docId: streamDocId(stream), appliedSeq: 0, remoteHeadSeq: 0, stale: 0,
		snapshotCoversSeq: 0, tailRows: 0, tailBytes: 0, remoteCheckpointCoversSeq: 0, rowsSinceRemoteCheckpoint: 0,
		bytesSinceRemoteCheckpoint: 0, lastOwnSeq: 0, bodyVersion: { remoteSeq: 0, localOrder: 0 }, quarantinedRows: 0, frozen: 0,
		frozenReason: null, disputedCheckpointCoversSeq: 0, textHash: null,
	};
}

/** Frame to append to the outbox; order is assigned by the tx. */
export type NewOutboxFrame = Omit<OutboxRecord, "order">;

/**
 * An own frame that committed under an epoch the §14.3 rule makes stale, or may ("hold"): its record is renamed
 * to `clientFrameId` with an empty `sealed`, which the sender seals under the current epoch (e2ee-design §14.2
 * step 4, runtime/reseal.ts). `row` is what is stored for the commit; null: the outbox record's (receiptRow).
 */
export interface OwnCommitCopy {
	readonly clientFrameId: ClientFrameId;
	readonly row: TailRecord | null;
}

/** An outbox record that took another id (or was sealed again under its own): `next` replaces `old`. */
export interface OutboxRename {
	readonly old: OutboxRecord;
	readonly next: OutboxRecord;
}

/**
 * One relay row (or live receipt), classified and gated (classifyRow, DESIGN §d.6 stages 1-2): what tLive stores, in
 * arrival (= seq) order; a read page partitions the same items into ReadPageInput. settleAdoptable: the own adoptable
 * the commit settles (§d.5), whatever the row gates to.
 */
export type LiveItem =
	/** Committed row from another device (or an own row without outbox record). */
	| { readonly t: "row"; readonly row: TailRecord; readonly settleAdoptable: ClientFrameId | null }
	| { readonly t: "quarantine"; readonly rec: QuarantineRecord; readonly settleAdoptable: ClientFrameId | null }
	/** Own frame receipt (or late receipt). Content comes from the outbox record. */
	| { readonly t: "receipt"; readonly stream: StreamName; readonly clientFrameId: ClientFrameId; readonly seq: Seq; readonly copy?: OwnCommitCopy }
	/**
	 * Overflow / null payload / skipped row: record stale, read later (T_stale). foreign: the row is known to be
	 * another device's (skipped rows always are): a seq past lastOwnSeq hands the checkpoint duty on, as a row does.
	 */
	| { readonly t: "stale"; readonly stream: StreamName; readonly seq: Seq; readonly foreign?: boolean }
	/** Accounted, nothing stored (unknown stream class, a stale-epoch body row, §14.3). */
	| { readonly t: "account"; readonly seq: Seq; readonly settleAdoptable: ClientFrameId | null };

export interface LiveResult {
	readonly vaultSeq: Seq;
	readonly streams: ReadonlyMap<StreamName, StreamRecord>;
	/** Outbox records deleted (receipted / settled adoptables). */
	readonly removed: readonly OutboxRecord[];
	/** Commit seqs of the receipted records among `removed`. */
	readonly receipts: ReadonlyMap<ClientFrameId, Seq>;
	/** Held records released to pending or re-pointed. */
	readonly updated: readonly OutboxRecord[];
	/** Own stale commits renamed to their copy (OwnCommitCopy). */
	readonly renamed: readonly OutboxRename[];
	/** Tail rows written (incl. receipts), for replica apply / fold. */
	readonly tailPut: readonly TailRecord[];
}

export interface ReadPageInput {
	readonly stream: StreamName;
	readonly rows: readonly TailRecord[];
	readonly quarantines: readonly QuarantineRecord[];
	readonly lateReceipts: readonly { readonly clientFrameId: ClientFrameId; readonly seq: Seq; readonly copy?: OwnCommitCopy }[];
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
	/**
	 * pending only, still sealed under `fromEpoch` with `fromLength` bytes: sealed again under the current epoch
	 * (e2ee-design §14.2 step 4), under `next.clientFrameId` (its own for ns/cfg, a fresh one otherwise). Also a
	 * renumbered ns/cfg frame (`next.frameNo`, FoldRuntime.renumberBlind), still numbered `fromFrameNo`.
	 */
	| { readonly t: "reseal"; readonly clientFrameId: ClientFrameId; readonly fromEpoch: number; readonly fromLength: number; readonly fromFrameNo: number | null; readonly next: { readonly clientFrameId: ClientFrameId; readonly sealed: Uint8Array; readonly keyEpoch: number; readonly frameNo?: number } };

export class Repo {
	readonly cursor: CursorTracker;
	private readonly cache = new Map<StreamName, StreamRecord>();
	private queue: Promise<unknown> = Promise.resolve();
	private ckptDuty = new Set<StreamName>();
	/** meta frameNoFloor (epoch migration, e2ee-design §8.2); read at open. */
	frameNoFloor: FrameNoFloor = { ns: 0, cfg: 0 };
	/** meta daily as read at open (the engine's live counter starts from it; T_live keeps the record). */
	dailyAtOpen: { readonly day: string; readonly frames: number } = { day: "", frames: 0 };
	/** Catch-up order of stale streams (sessionLoop, catchUp.ts staleOrder; DESIGN §j.6). Computed, never stored. */
	priorityFn: PriorityFn = defaultPriority;
	/** Streams a quarantine record just froze (tLive / tReadPage, after the commit): the engine retargets their views (§d.6). */
	onQuarantineFrozen: (recs: readonly StreamRecord[]) => void = () => undefined;
	/** The quarantine records and tail rows tLive / tReadPage just stored (after the commit): the engine re-checks held ones (§d.6). */
	onStored: (quarantined: readonly QuarantineRecord[], rows: readonly TailRecord[]) => void = () => undefined;
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
	static async open(
		storage: StoragePort, id: RepoIdentity, nowMs: number,
		opts: {
			recoveredFromMirror?: boolean; frameNoFloor?: FrameNoFloor | null;
			pathBases?: readonly MetaPathBase[] | null; docDeletes?: readonly MetaDocDeletes[] | null;
		} = {},
	): Promise<{ repo: Repo | null; outcome: OpenOutcome; db: StorageDb<YS> }> {
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
				if (opts.pathBases) await addPathBases(tx, opts.pathBases);
				if (opts.docDeletes) await addPathBases(tx, opts.docDeletes);
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
			if (opts.pathBases) await addPathBases(tx, opts.pathBases);
			if (opts.docDeletes) await addPathBases(tx, opts.docDeletes);
			return { outcome: { t: "fresh" } as OpenOutcome, ident: fresh, cursor, next: 1 };
		});
		if (res.outcome.t === "mismatch" || res.cursor === null) return { repo: null, outcome: res.outcome, db };
		const repo = new Repo(db, res.ident, res.cursor, res.next);
		await repo.loadCache();
		return { repo, outcome: res.outcome, db };
	}

	private async loadCache(): Promise<void> {
		const { streams, duty, floor, daily } = await this.db.tx([STORE.streams, STORE.meta], "readonly", async (tx) => {
			const streams = await tx.getAll(STORE.streams);
			const d = await tx.get(STORE.meta, "ckptDuty");
			const f = await tx.get(STORE.meta, "frameNoFloor");
			const y = await tx.get(STORE.meta, "daily");
			return {
				streams, duty: d && d.key === "ckptDuty" ? d.streams : [], floor: f && f.key === "frameNoFloor" ? { ns: f.ns, cfg: f.cfg } : { ns: 0, cfg: 0 },
				daily: y && y.key === "daily" ? { day: y.day, frames: y.framesSent } : { day: "", frames: 0 },
			};
		});
		for (const s of streams) this.cache.set(s.stream, s);
		this.ckptDuty = new Set(duty);
		this.frameNoFloor = floor;
		this.dailyAtOpen = daily;
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
	async quarantineOf(stream: StreamName): Promise<QuarantineRecord[]> {
		return this.db.tx([STORE.quarantine], "readonly", (tx) => tx.getAll(STORE.quarantine, tailRange(stream)));
	}
	async count(store: StoreKey): Promise<number> {
		return this.db.tx([store], "readonly", (tx) => tx.count(store));
	}
	async getMeta<K extends "cursor" | "outboxOrder" | "daily" | "identity" | "ckptDuty" | "frameNoFloor" | "keyring" | "keyringRecords">(key: K) {
		return this.db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, key));
	}
	/** MetaKeyring (e2ee-design §18.3): keyring diagnostics and the lazy own-seal count. No key bytes. */
	putKeyringMeta(m: MetaKeyring): Promise<void> {
		return this.serial("putKeyringMeta", () => this.db.tx([STORE.meta], "readwrite", async (tx) => {
			tx.put(STORE.meta, m);
		}));
	}

	/** MetaKeyringRecords (e2ee-design §6.1): the keyring's records, not secret. */
	putKeyringRecords(m: MetaKeyringRecords): Promise<void> {
		return this.serial("putKeyringRecords", () => this.db.tx([STORE.meta], "readwrite", async (tx) => {
			tx.put(STORE.meta, m);
		}));
	}

	// -------------------------------------------------------------------------
	// An old epoch's bases by path (MetaPathBase, DESIGN §c.12 step 3)
	// -------------------------------------------------------------------------

	/** Every stored path base. */
	pathBases(): Promise<MetaPathBase[]> {
		return this.db.tx([STORE.meta], "readonly", async (tx) => {
			const all = await tx.getAll(STORE.meta, { lower: "pathBase:", upper: "pathBase;", upperOpen: true });
			return all.filter((r): r is MetaPathBase => r.key.startsWith("pathBase:") && "deflated" in r);
		});
	}
	dropPathBases(keys: readonly (MetaPathBase["key"] | MetaDocDeletes["key"])[]): Promise<void> {
		return this.serial("dropPathBases", () => this.db.tx([STORE.meta], "readwrite", async (tx) => {
			for (const k of keys) tx.delete(STORE.meta, k);
		}));
	}
	/** Every stored old doc's deletes (MetaDocDeletes, DESIGN §c.12). Dropped with dropPathBases. */
	docDeletes(): Promise<MetaDocDeletes[]> {
		return this.db.tx([STORE.meta], "readonly", async (tx) => {
			const all = await tx.getAll(STORE.meta, { lower: "docDeletes:", upper: "docDeletes;", upperOpen: true });
			return all.filter((r): r is MetaDocDeletes => r.key.startsWith("docDeletes:") && "kind" in r);
		});
	}

	// -------------------------------------------------------------------------
	// Own blob PUT times (MetaBlobPut, e2ee-design §10.4 R2/R3)
	// -------------------------------------------------------------------------

	/** When this device last PUT `address` (device wall clock), or null. */
	async blobPutAt(address: string): Promise<number | null> {
		const r = await this.db.tx([STORE.meta], "readonly", (tx) => tx.get(STORE.meta, `blobPut:${address}`));
		return r && "atMs" in r ? r.atMs : null;
	}
	noteBlobPut(address: string, atMs: number): Promise<void> {
		return this.serial("noteBlobPut", () => this.db.tx([STORE.meta], "readwrite", async (tx) => {
			tx.put(STORE.meta, { key: `blobPut:${address}`, atMs });
		}));
	}
	/** Drops PUT times older than `beforeMs` or later than `nowMs` (the clock went back); returns how many. */
	pruneBlobPuts(beforeMs: number, nowMs: number): Promise<number> {
		return this.serial("pruneBlobPuts", () => this.db.tx([STORE.meta], "readwrite", async (tx) => {
			const all = await tx.getAll(STORE.meta, { lower: "blobPut:", upper: "blobPut;", upperOpen: true });
			let n = 0;
			for (const r of all) {
				if (!("atMs" in r) || (r.atMs >= beforeMs && r.atMs <= nowMs)) continue;
				tx.delete(STORE.meta, r.key);
				n++;
			}
			return n;
		}));
	}

	// -------------------------------------------------------------------------
	// T_edit / T_adopt: append own frames (or an adoptable)
	// -------------------------------------------------------------------------

	/** T_edit (touchStream=true) or T_adopt (touchStream=false). Commits BEFORE any append. */
	tEdit(frames: readonly NewOutboxFrame[], touchStream = true): Promise<OutboxRecord[]> {
		return this.serial("tEdit", async () => {
			const touched = new Map<StreamName, StreamRecord>();
			const out = await this.db.tx([STORE.outbox, STORE.meta, STORE.streams], "readwrite", async (tx) => {
				const meta = (await tx.get(STORE.meta, "outboxOrder") as MetaOutboxOrder | undefined) ?? { key: "outboxOrder", next: 1 };
				let next = Math.max(meta.next, this.outboxNext);
				const recs: OutboxRecord[] = [];
				for (const f of frames) {
					const rec: OutboxRecord = { ...f, order: next++ };
					tx.put(STORE.outbox, rec);
					recs.push(rec);
					if (touchStream) {
						const s = touched.get(f.stream) ?? (await tx.get(STORE.streams, f.stream)) ?? newStreamRecord(f.stream);
						const m: Mut<StreamRecord> = { ...s, bodyVersion: { remoteSeq: s.bodyVersion.remoteSeq, localOrder: rec.order } };
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
	// T_ingest + T_receipt + T_stale (one tx per live batch, arrival order)
	// -------------------------------------------------------------------------

	tLive(items: readonly LiveItem[], day: string): Promise<LiveResult> {
		return this.serial("tLive", async () => {
			const seqs = items.map((i) => (i.t === "row" ? i.row.seq : i.t === "quarantine" ? i.rec.seq : i.seq));
			const vAfter = this.cursor.preview(seqs);
			const self = this.deviceId;
			const recs = new Map<StreamName, Mut<StreamRecord>>();
			const removed: OutboxRecord[] = [];
			const receiptSeqs = new Map<ClientFrameId, Seq>();
			const updated: OutboxRecord[] = [];
			const renamed: OutboxRename[] = [];
			const tailPut: TailRecord[] = [];
			const duty = new Set(this.ckptDuty);
			let dutyChanged = false;
			const froze = new Set<StreamName>();
			const held: QuarantineRecord[] = [];
			const res = await this.db.tx([STORE.outbox, STORE.tail, STORE.quarantine, STORE.streams, STORE.meta], "readwrite", async (tx) => {
				const getRec = async (stream: StreamName): Promise<Mut<StreamRecord>> => {
					let r = recs.get(stream);
					if (!r) {
						r = { ...((await tx.get(STORE.streams, stream)) ?? newStreamRecord(stream)) };
						recs.set(stream, r);
					}
					return r;
				};
				let receipts = 0;
				for (const it of items) {
					if (it.t === "account") {
						if (it.settleAdoptable) await settleAdoptable(tx, it.settleAdoptable, removed);
						continue;
					}
					if (it.t === "stale") {
						const r = await getRec(it.stream);
						if (it.foreign === true && it.seq > r.lastOwnSeq && duty.delete(it.stream)) dutyChanged = true;
						r.remoteHeadSeq = Math.max(r.remoteHeadSeq, it.seq);
						r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
						continue;
					}
					if (it.t === "receipt") {
						const r = await getRec(it.stream);
						const ob = await tx.get(STORE.outbox, it.clientFrameId);
						if (ob && ob.stream === it.stream) {
							const row = it.copy?.row ?? receiptRow(ob, it.seq, self);
							if (await putTail(tx, r, row)) tailPut.push(row);
							await settleOwn(tx, ob, it.copy, removed, updated, renamed);
							if (!it.copy) receiptSeqs.set(ob.clientFrameId, it.seq);
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
							advance(r, it.seq, vAfter);
						} else {
							// Missing record: already settled (late receipt / duplicate). The seq is still accounted.
							r.remoteHeadSeq = Math.max(r.remoteHeadSeq, it.seq);
							r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
						}
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
						held.push(it.rec);
						if (await putQuarantine(tx, r, it.rec)) froze.add(stream);
					}
					// An own row this store never receipted (an earlier store, lost with IDB) is remote here: its text
					// is not known to be on disk.
					if (deviceId !== self || seq > r.lastOwnSeq) {
						r.bodyVersion = { remoteSeq: Math.max(r.bodyVersion.remoteSeq, seq), localOrder: r.bodyVersion.localOrder };
					}
					if (deviceId !== self && seq > r.lastOwnSeq && duty.delete(stream)) dutyChanged = true;
					advance(r, seq, vAfter);
					if (it.settleAdoptable) await settleAdoptable(tx, it.settleAdoptable, removed);
				}
				for (const r of recs.values()) tx.put(STORE.streams, r);
				const cur = (await tx.get(STORE.meta, "cursor") as MetaCursor | undefined) ?? { key: "cursor", vaultSeq: 0, headSeqSeen: 0 };
				const v = Math.max(cur.vaultSeq, vAfter);
				tx.put(STORE.meta, { key: "cursor", vaultSeq: v, headSeqSeen: Math.max(cur.headSeqSeen, this.cursor.headSeqSeen, v) });
				if (dutyChanged) tx.put(STORE.meta, { key: "ckptDuty", streams: [...duty] });
				if (receipts > 0) {
					const d = await tx.get(STORE.meta, "daily") as MetaDaily | undefined;
					tx.put(STORE.meta, { key: "daily", day, framesSent: (d && d.day === day ? d.framesSent : 0) + receipts });
				}
				if (await tx.count(STORE.quarantine) > QUARANTINE_MAX_RECORDS) await evictQuarantine(tx);
				return v;
			});
			this.cursor.commit(seqs, res, this.monotonic());
			for (const r of recs.values()) this.cache.set(r.stream, r);
			if (dutyChanged) this.ckptDuty = duty;
			if (froze.size > 0) this.onQuarantineFrozen([...froze].map((s) => recs.get(s)!));
			if (held.length > 0 || tailPut.length > 0) this.onStored(held, tailPut);
			return { vaultSeq: res, streams: recs, removed, receipts: receiptSeqs, updated, renamed, tailPut };
		});
	}

	// -------------------------------------------------------------------------
	// T_feed_page
	// -------------------------------------------------------------------------

	tFeedPage(entries: readonly { readonly stream: StreamName; readonly lastSeq: Seq }[], throughSeq: Seq, headSeq: Seq): Promise<{ vaultSeq: Seq; changed: StreamRecord[] }> {
		return this.serial("tFeedPage", async () => {
			const vAfter = this.cursor.preview([], throughSeq);
			const changed: Mut<StreamRecord>[] = [];
			const v = await this.db.tx([STORE.streams, STORE.meta], "readwrite", async (tx) => {
				for (const e of entries) {
					const ec = streamClass(e.stream);
					if (ec === "other") continue;
					const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, e.stream)) ?? newStreamRecord(e.stream)) };
					if (e.lastSeq <= r.remoteHeadSeq && this.cache.has(e.stream)) continue;
					r.remoteHeadSeq = Math.max(r.remoteHeadSeq, e.lastSeq);
					r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
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

	tReadPage(input: ReadPageInput): Promise<{ stream: StreamRecord; removed: OutboxRecord[]; receipts: Map<ClientFrameId, Seq>; updated: OutboxRecord[]; renamed: OutboxRename[]; tailPut: TailRecord[] }> {
		return this.serial("tReadPage", async () => {
			const self = this.deviceId;
			const removed: OutboxRecord[] = [];
			const receiptSeqs = new Map<ClientFrameId, Seq>();
			const updated: OutboxRecord[] = [];
			const renamed: OutboxRename[] = [];
			const tailPut: TailRecord[] = [];
			let froze = false;
			let dropDuty = false;
			const out = await this.db.tx([STORE.tail, STORE.quarantine, STORE.outbox, STORE.streams, STORE.snapshots, STORE.meta], "readwrite", async (tx) => {
				const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, input.stream)) ?? newStreamRecord(input.stream)) };
				// Another device's row past our last own one hands the checkpoint duty on (as in tLive): with
				// subscriptions such rows often arrive by a read, not live.
				const lastOwn = input.lateReceipts.reduce((m, lr) => Math.max(m, lr.seq), r.lastOwnSeq);
				dropDuty = this.ckptDuty.has(input.stream) && input.rows.some((row) => row.deviceId !== self && row.seq > lastOwn);
				if (dropDuty) {
					const duty = new Set(this.ckptDuty);
					duty.delete(input.stream);
					tx.put(STORE.meta, { key: "ckptDuty", streams: [...duty] });
				}
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
					if (await putQuarantine(tx, r, q)) froze = true;
					r.remoteHeadSeq = Math.max(r.remoteHeadSeq, q.seq);
				}
				for (const lr of input.lateReceipts) {
					const ob = await tx.get(STORE.outbox, lr.clientFrameId);
					if (!ob) continue;
					const row = lr.copy?.row ?? receiptRow(ob, lr.seq, self);
					if (await putTail(tx, r, row)) tailPut.push(row);
					await settleOwn(tx, ob, lr.copy, removed, updated, renamed);
					if (!lr.copy) receiptSeqs.set(ob.clientFrameId, lr.seq);
					r.lastOwnSeq = Math.max(r.lastOwnSeq, lr.seq);
					r.remoteHeadSeq = Math.max(r.remoteHeadSeq, lr.seq);
				}
				for (const cfid of input.settleAdoptables) await settleAdoptable(tx, cfid, removed);
				r.remoteHeadSeq = Math.max(r.remoteHeadSeq, input.lastSeq);
				if (input.checkpointSeq > r.remoteCheckpointCoversSeq) r.remoteCheckpointCoversSeq = input.checkpointSeq;
				if (input.completeThrough !== null) r.appliedSeq = Math.max(r.appliedSeq, Math.min(r.remoteHeadSeq, input.completeThrough));
				r.stale = r.appliedSeq < r.remoteHeadSeq ? 1 : 0;
				tx.put(STORE.streams, r);
				if (await tx.count(STORE.quarantine) > QUARANTINE_MAX_RECORDS) await evictQuarantine(tx);
				return r;
			});
			this.cache.set(out.stream, out);
			if (dropDuty) {
				const duty = new Set(this.ckptDuty);
				duty.delete(input.stream);
				this.ckptDuty = duty;
			}
			if (froze) this.onQuarantineFrozen([out]);
			if (input.quarantines.length > 0 || tailPut.length > 0) this.onStored(input.quarantines, tailPut);
			return { stream: out, removed, receipts: receiptSeqs, updated, renamed, tailPut };
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

	tOutbox(changes: readonly OutboxChange[]): Promise<{ removed: OutboxRecord[]; updated: OutboxRecord[]; renamed: OutboxRename[] }> {
		return this.serial("tOutbox", async () => {
			const removed: OutboxRecord[] = [];
			const updated: OutboxRecord[] = [];
			const renamed: OutboxRename[] = [];
			await this.db.tx([STORE.outbox], "readwrite", async (tx) => {
				for (const c of changes) {
					const r = await tx.get(STORE.outbox, c.clientFrameId);
					if (!r) continue;
					if (c.t === "delete") {
						tx.delete(STORE.outbox, r.clientFrameId);
						removed.push(r);
					} else if (c.t === "release") {
						if (r.state !== "held") continue;
						const n: OutboxRecord = { ...r, state: "pending", dependsOn: null };
						tx.put(STORE.outbox, n);
						updated.push(n);
					} else if (c.t === "reseal") {
						if (r.state !== "pending" || r.keyEpoch !== c.fromEpoch || r.sealed.length !== c.fromLength || r.frameNo !== c.fromFrameNo) continue;
						const n: OutboxRecord = { ...r, ...c.next };
						await rename(tx, r, n, updated);
						renamed.push({ old: r, next: n });
					} else {
						if (r.state === c.state) continue;
						const n: OutboxRecord = { ...r, state: c.state, dependsOn: c.state === "pending" ? null : r.dependsOn };
						tx.put(STORE.outbox, n);
						updated.push(n);
					}
				}
			});
			return { removed, updated, renamed };
		});
	}

	// -------------------------------------------------------------------------
	// Stream patches (checkpoint results, freeze, access time, textHash)
	// -------------------------------------------------------------------------

	tPatchStreams(patches: readonly { readonly stream: StreamName; readonly patch: (r: Mut<StreamRecord>) => void }[]): Promise<StreamRecord[]> {
		if (patches.length === 0) return Promise.resolve([]);
		return this.serial("tPatchStreams", async () => {
			const out = await this.db.tx([STORE.streams], "readwrite", async (tx) => {
				const res = new Map<StreamName, Mut<StreamRecord>>();
				for (const p of patches) {
					const r = res.get(p.stream) ?? { ...((await tx.get(STORE.streams, p.stream)) ?? newStreamRecord(p.stream)) };
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

	/**
	 * releaseQuarantine (DESIGN §d.6): rows that pass go to tail and move bodyVersion; the rest are marked dismissed;
	 * the doc unfreezes.
	 * The caller re-gated a snapshot: a record stored since (neither passed nor dismissed here) still counts and
	 * keeps the doc frozen.
	 */
	tReleaseQuarantine(stream: StreamName, pass: readonly TailRecord[], dismiss: readonly QuarantineRecord[]): Promise<StreamRecord> {
		return this.serial("tReleaseQuarantine", async () => {
			const out = await this.db.tx([STORE.quarantine, STORE.tail, STORE.streams], "readwrite", async (tx) => {
				const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, stream)) ?? newStreamRecord(stream)) };
				for (const row of pass) {
					tx.delete(STORE.quarantine, [stream, row.seq]);
					await putTail(tx, r, row);
					// Applied now: a remote change, as T_read_page counts its rows (it does not count a row it quarantines;
					// T_live does). Without this the planner saw no change and the disk kept the old text (E7 sim seed 88).
					if (row.deviceId !== this.deviceId || row.seq > r.lastOwnSeq) {
						r.bodyVersion = { remoteSeq: Math.max(r.bodyVersion.remoteSeq, row.seq), localOrder: r.bodyVersion.localOrder };
					}
				}
				for (const q of dismiss) {
					if (!q.detail.startsWith("dismissed:")) tx.put(STORE.quarantine, { ...q, detail: `dismissed: ${q.detail}` });
				}
				// Dismissed records stay for diagnostics (evicted by age) but no longer count.
				const left = (await tx.getAll(STORE.quarantine, tailRange(stream))).filter((q) => !q.detail.startsWith("dismissed:"));
				r.quarantinedRows = left.length;
				r.frozen = left.length > 0 ? 1 : 0;
				r.frozenReason = left[left.length - 1]?.reason ?? null;
				tx.put(STORE.streams, r);
				return r;
			});
			this.cache.set(stream, out);
			return out;
		});
	}

	/**
	 * Mirror recovery into a fresh DB (DESIGN §i.5): outboxOrder.next = max + 1. Imported body / canvas frames move their stream's bodyVersion.localOrder
	 * like T_edit: the imported synced records carry no localOrder, and nothing says the frames' text (editor
	 * keystrokes never saved, merges whose write died) is on disk, so Rc must hold until a merge settles it.
	 */
	tImportOutbox(records: readonly OutboxRecord[]): Promise<void> {
		return this.serial("tImportOutbox", async () => {
			const touched = new Map<StreamName, StreamRecord>();
			const next = await this.db.tx([STORE.outbox, STORE.meta, STORE.streams], "readwrite", async (tx) => {
				let max = 0;
				for (const r of records) {
					tx.put(STORE.outbox, r);
					max = Math.max(max, r.order);
					const cls = streamClass(r.stream);
					if (cls !== "body" && cls !== "canvas") continue;
					const st = touched.get(r.stream) ?? (await tx.get(STORE.streams, r.stream)) ?? newStreamRecord(r.stream);
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
	 * Re-gated fold rows (ns, cfg, snap) replace the unopened rows they stand for (quarantineRelease.regateUnopened);
	 * `drop`: unopened rows that re-gated as accounted only (a snap row found stale-epoch, an ignored frame) leave
	 * the tail, as a reader that gated them so at first never stored them. A row gone meanwhile (snapshot
	 * compaction) is skipped; byte accounting follows the new content.
	 */
	tReplaceTail(stream: StreamName, rows: readonly TailRecord[], drop: readonly Seq[] = []): Promise<number> {
		return this.serial("tReplaceTail", async () => {
			let n = 0;
			const out = await this.db.tx([STORE.tail, STORE.streams], "readwrite", async (tx) => {
				const r: Mut<StreamRecord> = { ...((await tx.get(STORE.streams, stream)) ?? newStreamRecord(stream)) };
				for (const row of rows) {
					const old = await tx.get(STORE.tail, [stream, row.seq]);
					if (!old) continue;
					tx.put(STORE.tail, row);
					r.tailBytes = Math.max(0, r.tailBytes - old.content.length + row.content.length);
					n++;
				}
				for (const seq of drop) {
					const old = await tx.get(STORE.tail, [stream, seq]);
					if (!old || !(old.flags & LOCAL_FLAG_UNOPENED)) continue;
					tx.delete(STORE.tail, [stream, seq]);
					r.tailRows = Math.max(0, r.tailRows - 1);
					r.tailBytes = Math.max(0, r.tailBytes - old.content.length);
					n++;
				}
				tx.put(STORE.streams, r);
				return r;
			});
			this.cache.set(stream, out);
			return n;
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
/**
 * The migration's path bases (MetaPathBase), each kept if one is already there: a migration repeated over an existing
 * new-epoch DB (the old DB not retired yet) neither replaces nor revives anything but a missing base.
 */
async function addPathBases(tx: Tx, bases: readonly (MetaPathBase | MetaDocDeletes)[]): Promise<void> {
	for (const b of bases) if (!(await tx.get(STORE.meta, b.key))) tx.put(STORE.meta, b);
}

async function raiseFrameNoFloor(tx: Tx, f: FrameNoFloor): Promise<void> {
	const cur = await tx.get(STORE.meta, "frameNoFloor") as MetaFrameNoFloor | undefined;
	tx.put(STORE.meta, { key: "frameNoFloor", ns: Math.max(cur?.ns ?? 0, f.ns), cfg: Math.max(cur?.cfg ?? 0, f.cfg) });
}

/** Own frame -> tail row. A bodyUpdateRef record keeps the resolved update as content (local cache). */
function receiptRow(ob: OutboxRecord, seq: Seq, self: DeviceId): TailRecord {
	const kind = ob.kind === "bodyUpdateRef" ? (streamClass(ob.stream) === "canvas" ? "canvasUpdate" : "bodyUpdate") : ob.kind;
	return { stream: ob.stream, seq, deviceId: self, clientFrameId: ob.clientFrameId, kind, authorNsSeq: ob.authorNsSeq, flags: ob.flags, frameNo: ob.frameNo ?? 0, content: ob.content };
}

/** A receipted own record: gone, or (an own stale commit) renamed to its unsealed copy. */
async function settleOwn(tx: Tx, ob: OutboxRecord, copy: OwnCommitCopy | undefined, removed: OutboxRecord[], updated: OutboxRecord[], renamed: OutboxRename[]): Promise<void> {
	if (!copy) {
		tx.delete(STORE.outbox, ob.clientFrameId);
		removed.push(ob);
		return;
	}
	const next: OutboxRecord = { ...ob, clientFrameId: copy.clientFrameId, sealed: new Uint8Array(0), state: "pending" };
	await rename(tx, ob, next, updated);
	renamed.push({ old: ob, next });
}

/**
 * `next` replaces `old` at the same order (the order indexes are unique: the old key goes first); held records
 * waiting for `old` (an onboarding ns create) wait for `next`, and so do the pending body frames of a live ns
 * create (DESIGN §e.1: they never go before it).
 */
async function rename(tx: Tx, old: OutboxRecord, next: OutboxRecord, updated: OutboxRecord[]): Promise<void> {
	if (next.clientFrameId !== old.clientFrameId) tx.delete(STORE.outbox, old.clientFrameId);
	tx.put(STORE.outbox, next);
	if (next.clientFrameId === old.clientFrameId) return;
	const states: OutboxState[] = old.stream === NS_STREAM ? ["held", "pending"] : ["held"];
	for (const st of states) for (const h of await tx.getAllByIndex(STORE.outbox, INDEX.outboxByState, stateOrderRange(st))) {
		if (h.dependsOn !== old.clientFrameId) continue;
		const n: OutboxRecord = { ...h, dependsOn: next.clientFrameId };
		tx.put(STORE.outbox, n);
		updated.push(n);
	}
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

/** Returns true when this record froze the stream (it was not frozen). */
async function putQuarantine(tx: Tx, r: Mut<StreamRecord>, q: QuarantineRecord): Promise<boolean> {
	// quarantinedRows counts undismissed records (a dismissed record re-quarantined by a re-read counts again).
	const existing = await tx.get(STORE.quarantine, [q.stream, q.seq]);
	tx.put(STORE.quarantine, q);
	if (existing === undefined || existing.detail.startsWith("dismissed:")) r.quarantinedRows++;
	const froze = r.frozen !== 1;
	r.frozen = 1;
	r.frozenReason = q.reason;
	return froze;
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

/** DESIGN §d.5: the commit it shadows was observed: delete the adoptable without re-applying it (it holds nothing). */
async function settleAdoptable(tx: Tx, cfid: ClientFrameId, removed: OutboxRecord[]): Promise<void> {
	const ob = await tx.get(STORE.outbox, cfid);
	if (!ob || ob.state !== "adoptable") return;
	tx.delete(STORE.outbox, cfid);
	removed.push(ob);
}
