/**
 * IndexedDB schema: one database per (vault, vaultEpoch, install): the store (identity-per-store §2.4).
 * DESIGN §e. IndexedDB is a rebuildable cache: every record here can be
 * reconstructed from the relay + disk, except the outbox, which is mirrored
 * to side files (OUTBOX_MIRROR_*).
 *
 * Store names, key paths, index names and record types only. The repository
 * that implements the transactions of DESIGN §e.2 lives in
 * src/engine/store/repo.ts (WP-C).
 */

import type { StoreSpec, KeyRange } from "../../ports/storage";
import type {
	BodyVersion, ClientFrameId, ConfigRelPath, ContentHash, DeviceId, DiskFingerprint, DocId, DocKind, PathKey, Seq, StreamClass,
	StreamName, SyncedEntry, VaultEpoch, VaultId, VaultPath,
} from "../../core/types";
import type { EnvelopeKind, CheckpointEncoding } from "../../core/envelope";

/**
 * Bumped on any change to stores, indexes or record shapes. An older DB fails Repo.open's identity check
 * (schemaVersion) and is deleted and rebuilt from relay + disk + side-file mirrors (DESIGN §i.5).
 * 2: dropped the unused streams byStalePriority / byAccess, synced byPathKey and blobQueue byActiveDue indexes
 * and the fields only they read; dropped the outbox "sent" state, attempts and lastSentAtMs (T_sent).
 * Not bumped for a new meta key family whose absence reads as before (blobPut:, pathBase:,
 * keyringRecords, docDeletes:): an older reader never looks the keys up, and a DB without them behaves as it did. A bump would
 * delete and rebuild every DB.
 */
export const DB_SCHEMA_VERSION = 2;
/**
 * `yaos3`: the store is named by the install key, and its device identity lives in it (identity-per-store §2.4).
 * The `yaos2:<vaultId>:<epoch>:<deviceId>` layout (identity in data.json) is deleted on start (§13).
 */
export const DB_NAME_PREFIX = "yaos3";
export const LEGACY_DB_NAME_PREFIX = "yaos2";
/** `yaos3-pending:<vaultId>:<installKey>`: an identity minted for this install's next store (storeIdentity.ts). */
export const PENDING_DB_NAME_PREFIX = "yaos3-pending";

/**
 * `yaos3:<vaultId>:<vaultEpoch>:<storeKey>`, each part URI-component encoded (the epoch is an opaque string).
 * `storeKey` is the install key (identity-per-store §2.4); engine tests without one use the deviceId.
 */
export function dbName(vaultId: VaultId, vaultEpoch: VaultEpoch, storeKey: string): string {
	return `${DB_NAME_PREFIX}:${encodeURIComponent(vaultId)}:${encodeURIComponent(vaultEpoch)}:${encodeURIComponent(storeKey)}`;
}

// ---------------------------------------------------------------------------
// meta — singleton records keyed by `key`
// ---------------------------------------------------------------------------

/**
 * The store's identity (identity-per-store §2.4): written in the transaction that creates the DB, so the device
 * identity and the store are created and lost together. A deviceId is used by exactly one store (§1.3).
 */
export interface MetaIdentity {
	readonly key: "identity";
	readonly vaultId: VaultId;
	readonly vaultEpoch: VaultEpoch;
	readonly deviceId: DeviceId;
	/** SECRET: the device token (relay tickets, reads, blobs). Absent only in engine tests that run without a grant. */
	readonly deviceToken?: string;
	/** SECRET: the key whose SHA-256 the server keeps as the device's retire hash (the successor fence, §5.2). */
	readonly retireKey?: string;
	readonly schemaVersion: number;
	readonly clientVersion: string;
	readonly createdAtMs: number;
	/** Set when this DB was rebuilt from side-file mirrors after loss. */
	readonly recoveredFromMirror: boolean;
	/**
	 * Predecessor recovery still to run (identity-per-store §5.2): written with the identity when a new store of an
	 * install with a lineage is created, cleared in the transaction that imports the predecessor's mirrors
	 * (Repo.tInherit). A crash between the two runs the import at the next start; a store created without it never
	 * imports anything (a late import would replay old intents over newer changes).
	 */
	readonly inherit?: MetaInherit | null;
	/**
	 * The stores this one replaces (identity-per-store §4 "vaultEpoch change"): an epoch change creates the new
	 * epoch's store under a new identity while the old epoch's store stays until the new one is live and retires it.
	 * A start that finds both opens the one no other names here (storeIdentity.resolveStoreIdentity), never by the
	 * wall clock (createdAtMs is diagnostics only, ports/clock.ts).
	 */
	readonly supersedes?: readonly DeviceId[];
}

/** The lineage stores to recover from, newest first (identity-per-store §5.2), and whether the newest was fenced. */
export interface MetaInherit {
	readonly dirs: readonly DeviceId[];
	readonly fenced: boolean;
}

/**
 * An inherited frame's identity in a predecessor store (identity-per-store §5.2 steps 3-4): the commit check drops
 * the re-issued frame when any of its origins committed (in that device's ring or covered by its replay window).
 */
export interface FrameOrigin {
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** ns / cfg frameNo there; 0 for none. */
	readonly frameNo: number;
}
export interface MetaCursor {
	readonly key: "cursor";
	/** Every commit <= vaultSeq is ingested, recorded stale, quarantined, or own-in-outbox (DESIGN §d.7). */
	readonly vaultSeq: Seq;
	readonly headSeqSeen: Seq;
}
export interface MetaOutboxOrder {
	readonly key: "outboxOrder";
	/** Next local order number; strictly increasing, never reused within this DB. */
	readonly next: number;
}
/**
 * Own frames receipted on `day` (EngineCtx.day(), YYYY-MM-DD per ClockPort.now()): the daily soft budget (DESIGN
 * §i.6). Written by T_live; read at open, so the budget survives a restart within the day.
 */
export interface MetaDaily {
	readonly key: "daily";
	readonly day: string;
	readonly framesSent: number;
}
export interface MetaRelayCheckpointDuty {
	readonly key: "ckptDuty";
	/** Streams this device authored the latest row of (candidate writer duty). */
	readonly streams: readonly StreamName[];
}
/**
 * Keyring diagnostics and the roll counter (e2ee-design §18.3). No key bytes: keys and records live in the
 * host's SecretStorage (§6.1); this is derived from them and from `k`.
 */
export interface MetaKeyring {
	readonly key: "keyring";
	readonly sealEpoch: number;
	readonly epochs: readonly { readonly e: number; readonly firstSeq: Seq | null; readonly kind: number; readonly verified: boolean }[];
	readonly revokeEpoch: number | null;
	readonly sRot: Seq | null;
	/** Own seals under sealEpoch (the §4.2 roll trigger). */
	readonly ownSeals: number;
}
/**
 * When this device last PUT a blob address (e2ee-design §10.4 R2/R3), one record per address. Device wall
 * clock; a lost record or a time in the future reads as "not recent" (one extra PUT, never a skipped one).
 */
export interface MetaBlobPut {
	readonly key: `blobPut:${string}`;
	readonly atMs: number;
}
/**
 * An old epoch's base at a path (DESIGN §c.12 step 3), one record per path key: the old DB's base text of the doc
 * synced there, as its `baseText` row held it (deflate-raw, chars, markdownContentHash; reconcile/store.ts readBase
 * checks it). Written with the new DB's identity by Repo.open, so a crash before the merges keeps them; dropped
 * once the path is settled in the new epoch (compose/epochBases.ts).
 */
export interface MetaPathBase {
	readonly key: `pathBase:${string}`;
	readonly contentHash: ContentHash;
	readonly deflated: Uint8Array;
	readonly chars: number;
	/**
	 * Canvas only: the record keys ("n:<id>" / "e:<id>") deleted in the old doc, so a new epoch whose canvas at the
	 * path holds them again (a peer's re-create after a reset) has them deleted again (canvasMerge.withEpochDeletes).
	 * Absent = none.
	 */
	readonly deleted?: readonly string[];
}
/**
 * What an old epoch's doc deleted (DESIGN §c.12 "Deletes"), by its docId: a restore keeps doc and item ids, so the
 * new epoch's doc of that id gets the deletes again before this device first merges or writes it, wherever it is
 * now (a rename may have been dropped with the old outbox, or another device's rename restored). Canvas: the record
 * keys; markdown: the delete set (a Yjs update with no structs). Stored with the new DB's identity; dropped once
 * applied, once the doc has a synced record, or when the new epoch has no live doc of that id.
 */
export interface MetaDocDeletes {
	readonly key: `docDeletes:${string}`;
	readonly kind: "markdown" | "canvas";
	readonly keys?: readonly string[];
	readonly update?: Uint8Array;
}
/**
 * The keyring's records as SecretStorage holds them (e2ee-design §6.1): the winners, then the revokes held open.
 * Not secret: every byte of them is in `k`. Kept here too so that a device whose SecretStorage was lost still has
 * them when a reset or restore emptied `k` before any device re-published (§11.5): the RK opens the newest genesis
 * or revoke among them (§13.3), and the device re-publishes them. Every DB writes its own copy when its keyring
 * opens (a key-missing device runs no VaultRuntime, so it never migrates; protocolEngine reads every epoch's DB).
 */
export interface MetaKeyringRecords {
	readonly key: "keyringRecords";
	readonly winners: readonly Uint8Array[];
	readonly open: readonly Uint8Array[];
}
/**
 * An identity minted and registered for this install's next store, before that store exists (the epoch it is
 * named by is learnt by connecting, which needs the identity). Only in the `yaos3-pending:` DB; consumed (the DB
 * deleted) before the store is created, so it serves at most one store (storeIdentity.ts).
 */
export interface MetaPendingIdentity {
	readonly key: "pendingIdentity";
	readonly deviceId: DeviceId;
	/** SECRET. */
	readonly deviceToken: string;
	/** SECRET. */
	readonly retireKey: string;
	/** The server answered the registration 200. */
	readonly registered: boolean;
}

export type MetaRecord = MetaPendingIdentity | MetaIdentity | MetaCursor | MetaOutboxOrder | MetaDaily | MetaRelayCheckpointDuty | MetaKeyring | MetaBlobPut | MetaPathBase | MetaKeyringRecords | MetaDocDeletes;
export type MetaKey = MetaRecord["key"];

// ---------------------------------------------------------------------------
// streams — per-stream bookkeeping, keyPath "stream"
// ---------------------------------------------------------------------------

export interface StreamRecord {
	readonly stream: StreamName;
	readonly cls: StreamClass;
	readonly docId: DocId | null;
	/** All rows from other devices with seq <= appliedSeq are in tail/snapshot. */
	readonly appliedSeq: Seq;
	/** Highest seq known to exist for this stream (feed, push, receipt). */
	readonly remoteHeadSeq: Seq;
	/** 1 iff appliedSeq < remoteHeadSeq. Catch-up order is computed in memory (catchUp.ts staleOrder), not stored. */
	readonly stale: 0 | 1;
	readonly snapshotCoversSeq: Seq;
	readonly tailRows: number;
	readonly tailBytes: number;
	/** coversSeq of the newest remote checkpoint we know of (CAS expectedPrev). */
	readonly remoteCheckpointCoversSeq: Seq;
	/** Rows since the remote checkpoint (writer duty trigger). */
	readonly rowsSinceRemoteCheckpoint: number;
	readonly bytesSinceRemoteCheckpoint: number;
	/** Seq of the newest row authored by this device. */
	readonly lastOwnSeq: Seq;
	readonly bodyVersion: BodyVersion;
	readonly quarantinedRows: number;
	/** 1 = ingest gate froze the doc. */
	readonly frozen: 0 | 1;
	readonly frozenReason: string | null;
	/** Remote checkpoint failed verification; do not adopt it. */
	readonly disputedCheckpointCoversSeq: Seq;
	/** Logical hash of the doc text at bodyVersion, if computed. */
	readonly textHash: ContentHash | null;
}

// ---------------------------------------------------------------------------
// snapshots — keyPath "stream"
// ---------------------------------------------------------------------------

export interface SnapshotRecord {
	readonly stream: StreamName;
	/** EXACT: state of committed rows <= coversSeq only (no outbox, no provisional, no quarantined rows). */
	readonly coversSeq: Seq;
	readonly encoding: CheckpointEncoding;
	readonly bytes: Uint8Array;
	readonly createdAtMs: number;
}

// ---------------------------------------------------------------------------
// tail — committed rows, keyPath ["stream", "seq"]
// ---------------------------------------------------------------------------

export interface TailRecord {
	readonly stream: StreamName;
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** "keyRecord": a `k` row; content is the raw record (no envelope, e2ee-design §11), empty if over 256 B. */
	readonly kind: EnvelopeKind | "keyRecord";
	readonly authorNsSeq: Seq;
	readonly flags: number;
	/** Inner frameNo (e2ee-design §8.2): ≥ 1 for ns / cfg frames, else 0 (also for gate-failed rows). */
	readonly frameNo: number;
	/** Opened inner content (post-crypto, pre-kind-decode). */
	readonly content: Uint8Array;
}
export type TailKey = readonly [StreamName, Seq];

// ---------------------------------------------------------------------------
// outbox — durable own frames, keyPath "clientFrameId"
// ---------------------------------------------------------------------------

export type OutboxState =
	/** Waiting for a dependency (initial body frame held until its ns create is folded, DESIGN §j.5). */
	| "held"
	/**
	 * Persisted, awaiting receipt: "maybe sent" (DESIGN §d.4). What is in flight on the current session is the
	 * sender's memory only (Sender.isInflight); every pending record is resent after a restart or STREAM_RESEND.
	 */
	| "pending"
	/** Refused as oversize/invalid; kept for recovery, never resent automatically. */
	| "poisoned"
	/**
	 * Another device's PROVISIONAL applied to a bound doc (DESIGN §d.5). Deleted
	 * when its commit arrives; re-appended under this record's clientFrameId with
	 * EnvelopeFlag.adopted if dropped or not committed within PROVISIONAL_ADOPT_MS.
	 */
	| "adoptable";

export interface OutboxRecord {
	readonly clientFrameId: ClientFrameId;
	readonly order: number;
	readonly stream: StreamName;
	readonly kind: EnvelopeKind;
	readonly state: OutboxState;
	/** Exact bytes to append (resent verbatim; idempotent by clientFrameId). */
	readonly sealed: Uint8Array;
	/** Inner content, for re-applying to the local doc at load without decrypting. */
	readonly content: Uint8Array;
	readonly authorNsSeq: Seq;
	readonly flags: number;
	/** ns / cfg only: the frameNo sealed inside `sealed` (e2ee-design §8.2). null for other kinds. */
	readonly frameNo: number | null;
	/**
	 * The key epoch in `sealed`'s header (0 under suite 0). The sender re-seals a record below the newest winning
	 * revoke epoch before sending it (e2ee-design §14.2 step 4, runtime/reseal.ts). An empty `sealed` is a copy of
	 * an own frame that committed stale: it is sealed under the current epoch before it is sent.
	 */
	readonly keyEpoch: number;
	/**
	 * pending: the live ns create this body frame goes after (DESIGN §e.1, Sender blockedBy).
	 * held: the onboarding ns create of the doc this frame waits for (DESIGN §e.1), released when it folds.
	 */
	readonly dependsOn: ClientFrameId | null;
	/** adoptable only: identity of the provisional frame being shadowed. */
	readonly adoptOf: { readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly receivedAtMs: number } | null;
	readonly createdAtMs: number;
	/**
	 * ns / cfg frames re-issued from a lost predecessor store (identity-per-store §5.2): the identities the frame had
	 * there, newest first. Absent or empty: this store's own frame.
	 */
	readonly origins?: readonly FrameOrigin[];
}

// ---------------------------------------------------------------------------
// quarantine — keyPath ["stream", "seq"]
// ---------------------------------------------------------------------------

export type QuarantineReason =
	| "envelope-malformed"
	| "envelope-version"
	| "crypto-unknown-key"
	| "crypto-auth"
	/** Suite-0 bytes on a suite-1 vault (e2ee-design §9.2). */
	| "crypto-downgrade"
	/** Valid tag over bad Padmé padding (e2ee-design §7.3). */
	| "envelope-padding"
	| "kind-not-allowed"
	| "decode-failed"
	| "yjs-structure"
	| "disallowed-type"
	| "oversize"
	| "post-apply-limit"
	| "canvas-invalid"
	| "checkpoint-mismatch"
	/** An ns / cfg checkpoint that decodes canonically but breaks a V2 structural invariant (DESIGN §b.5). */
	| "checkpoint-invariant"
	/** A checkpoint sealed under an epoch below the winning revoke, covering past S_rot (e2ee-design §14.3): absent. */
	| "stale-epoch"
	/**
	 * §14.3 undecided for this reader: a revoke it cannot settle yet, or `k` rows not judged yet. Reader-dependent:
	 * re-gated after the next keyring change.
	 */
	| "keyring-hold";

export interface QuarantineRecord {
	readonly stream: StreamName;
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	readonly reason: QuarantineReason;
	readonly detail: string;
	/** Deterministic failures: truncated to QUARANTINE_ROW_BYTES; reader-dependent ones: whole (re-gated). Full hash kept. */
	readonly bytes: Uint8Array;
	readonly bytesHash: ContentHash;
	readonly originalSize: number;
	readonly atMs: number;
}

// ---------------------------------------------------------------------------
// synced — Synced tree, keyPath "docId"
// ---------------------------------------------------------------------------

export type SyncedRecord = SyncedEntry & { readonly syncedAtMs: number };

// ---------------------------------------------------------------------------
// baseText — merge bases, keyPath "docId"
// ---------------------------------------------------------------------------

export interface BaseTextRecord {
	readonly docId: DocId;
	readonly contentHash: ContentHash;
	/** deflate-raw (fflate) of the UTF-8 text. */
	readonly deflated: Uint8Array;
	readonly chars: number;
}

// ---------------------------------------------------------------------------
// localTree — stat cache, keyPath "pathKey"
// ---------------------------------------------------------------------------

export interface LocalTreeRecord {
	readonly pathKey: PathKey;
	readonly diskPath: string;
	readonly path: VaultPath;
	readonly kind: DocKind;
	readonly size: number;
	readonly mtimeMs: number;
	readonly hash: ContentHash | null;
	readonly fingerprint: DiskFingerprint | null;
	/** ClockPort.now() at hashing (wall clock: compared with file mtimes). */
	readonly hashedAtMs: number;
}

// ---------------------------------------------------------------------------
// intents — multi-step disk op journal, keyPath "id"
// ---------------------------------------------------------------------------

export interface IntentRecord {
	readonly id: string;
	readonly docId: DocId | null;
	readonly kind: "conflict-copy" | "loser-rename" | "rebind" | "keep-both-blob" | "epoch-migration";
	/** Content hash being preserved / moved; used to dedupe after a crash. */
	readonly subjectHash: ContentHash | null;
	readonly fromPath: VaultPath | null;
	readonly toPath: VaultPath | null;
	readonly step: number;
	readonly createdAtMs: number;
}

// ---------------------------------------------------------------------------
// cfgBase — settings sync base per config file, keyPath "file" (DESIGN §j.3)
// ---------------------------------------------------------------------------

export interface CfgBaseRecord {
	readonly file: ConfigRelPath;
	/** Exact bytes hash at the sync point (local file == fold value). */
	readonly fingerprint: DiskFingerprint;
	readonly size: number;
	readonly mtimeMs: number;
	/** JSON files: top-level key -> sha256 of the canonical JSON value at the sync point. */
	readonly keyHashes: Readonly<Record<string, ContentHash>> | null;
}

// ---------------------------------------------------------------------------
// blobQueue — pending transfers, keyPath "hash"
// ---------------------------------------------------------------------------

export interface BlobQueueRecord {
	readonly hash: ContentHash;
	readonly direction: "up" | "down";
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly size: number;
	readonly attempts: number;
	readonly nextAttemptAtMs: number;
}

// ---------------------------------------------------------------------------
// Store table
// ---------------------------------------------------------------------------

export const STORE = {
	meta: "meta",
	streams: "streams",
	snapshots: "snapshots",
	tail: "tail",
	outbox: "outbox",
	quarantine: "quarantine",
	synced: "synced",
	baseText: "baseText",
	localTree: "localTree",
	intents: "intents",
	cfgBase: "cfgBase",
	blobQueue: "blobQueue",
} as const;

export const INDEX = {
	outboxByOrder: "byOrder",
	outboxByStream: "byStreamOrder",
	outboxByState: "byStateOrder",
	quarantineByAt: "byAt",
} as const;

/** Schema map for StoragePort typing. */
export interface YaosSchema {
	readonly [STORE.meta]: { readonly record: MetaRecord; readonly key: MetaKey; readonly indexes: never };
	readonly [STORE.streams]: { readonly record: StreamRecord; readonly key: StreamName; readonly indexes: never };
	readonly [STORE.snapshots]: { readonly record: SnapshotRecord; readonly key: StreamName; readonly indexes: never };
	readonly [STORE.tail]: { readonly record: TailRecord; readonly key: TailKey; readonly indexes: never };
	readonly [STORE.outbox]: { readonly record: OutboxRecord; readonly key: ClientFrameId; readonly indexes: typeof INDEX.outboxByOrder | typeof INDEX.outboxByStream | typeof INDEX.outboxByState };
	readonly [STORE.quarantine]: { readonly record: QuarantineRecord; readonly key: TailKey; readonly indexes: typeof INDEX.quarantineByAt };
	readonly [STORE.synced]: { readonly record: SyncedRecord; readonly key: DocId; readonly indexes: never };
	readonly [STORE.baseText]: { readonly record: BaseTextRecord; readonly key: DocId; readonly indexes: never };
	readonly [STORE.localTree]: { readonly record: LocalTreeRecord; readonly key: PathKey; readonly indexes: never };
	readonly [STORE.intents]: { readonly record: IntentRecord; readonly key: string; readonly indexes: never };
	readonly [STORE.cfgBase]: { readonly record: CfgBaseRecord; readonly key: ConfigRelPath; readonly indexes: never };
	readonly [STORE.blobQueue]: { readonly record: BlobQueueRecord; readonly key: ContentHash; readonly indexes: never };
}

export const STORE_SPECS: Readonly<Record<keyof YaosSchema, StoreSpec>> = {
	meta: { keyPath: "key", indexes: {} },
	streams: { keyPath: "stream", indexes: {} },
	snapshots: { keyPath: "stream", indexes: {} },
	tail: { keyPath: ["stream", "seq"], indexes: {} },
	outbox: {
		keyPath: "clientFrameId",
		indexes: {
			[INDEX.outboxByOrder]: { keyPath: "order", unique: true },
			[INDEX.outboxByStream]: { keyPath: ["stream", "order"], unique: true },
			[INDEX.outboxByState]: { keyPath: ["state", "order"], unique: true },
		},
	},
	quarantine: { keyPath: ["stream", "seq"], indexes: { [INDEX.quarantineByAt]: { keyPath: "atMs", unique: false } } },
	synced: { keyPath: "docId", indexes: {} },
	baseText: { keyPath: "docId", indexes: {} },
	localTree: { keyPath: "pathKey", indexes: {} },
	intents: { keyPath: "id", indexes: {} },
	cfgBase: { keyPath: "file", indexes: {} },
	blobQueue: { keyPath: "hash", indexes: {} },
};

/** All tail rows of one stream: [stream, 0] .. [stream, +inf]. */
export function tailRange(stream: StreamName, afterSeq: Seq = 0, throughSeq: Seq = Number.MAX_SAFE_INTEGER): KeyRange {
	return { lower: [stream, afterSeq], upper: [stream, throughSeq], lowerOpen: true, upperOpen: false };
}

// ---------------------------------------------------------------------------
// Side-file mirrors (DESIGN §e.4). Written by the host on the engine's request.
// ---------------------------------------------------------------------------

/** Byte format: core/codec/mirrors.ts (the shapes below are assignable to its OutboxMirrorData / SyncedMirrorData). */
export { MIRROR_FORMAT_VERSION, OUTBOX_MIRROR_FORMAT_VERSION, OUTBOX_MIRROR_MAGIC, SYNCED_MIRROR_MAGIC } from "../../core/codec/mirrors";

export interface OutboxMirrorFrame {
	readonly clientFrameId: ClientFrameId;
	readonly stream: StreamName;
	readonly order: number;
	/** Mirrors written before DB schema 2 may say "sent" (a pending record then in flight); recovery imports it as pending. */
	readonly state: OutboxState | "sent";
	readonly authorNsSeq: Seq;
	readonly dependsOn: ClientFrameId | null;
	readonly adoptOf: { readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId } | null;
	readonly sealed: Uint8Array;
	/** OutboxRecord.origins (outbox mirror format 2). */
	readonly origins?: readonly FrameOrigin[];
}

export interface OutboxMirror {
	readonly vaultId: VaultId;
	readonly vaultEpoch: VaultEpoch;
	readonly deviceId: DeviceId;
	/** Monotone; the reader takes the valid file (checksum ok) with the highest generation. */
	readonly generation: number;
	readonly writtenAtMs: number;
	readonly frames: readonly OutboxMirrorFrame[];
}

export interface SyncedMirrorEntry {
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly kind: DocKind;
	readonly contentHash: ContentHash;
	readonly nsTouchSeq: Seq;
	readonly bodyRemoteSeq: Seq;
	readonly blobRev: Seq;
}

export interface SyncedMirror {
	readonly vaultId: VaultId;
	readonly vaultEpoch: VaultEpoch;
	readonly deviceId: DeviceId;
	readonly generation: number;
	readonly writtenAtMs: number;
	readonly nsCoversSeq: Seq;
	readonly entries: readonly SyncedMirrorEntry[];
}
