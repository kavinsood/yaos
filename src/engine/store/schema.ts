/**
 * IndexedDB schema: one database per (vault, vaultEpoch, device).
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

export const DB_SCHEMA_VERSION = 1;
export const DB_NAME_PREFIX = "yaos2";

/** `yaos2:<vaultId>:<vaultEpoch>:<deviceId>`, each part URI-component encoded (the epoch is an opaque string). */
export function dbName(vaultId: VaultId, vaultEpoch: VaultEpoch, deviceId: DeviceId): string {
	return `${DB_NAME_PREFIX}:${encodeURIComponent(vaultId)}:${encodeURIComponent(vaultEpoch)}:${encodeURIComponent(deviceId)}`;
}

// ---------------------------------------------------------------------------
// meta — singleton records keyed by `key`
// ---------------------------------------------------------------------------

export interface MetaIdentity {
	readonly key: "identity";
	readonly vaultId: VaultId;
	readonly vaultEpoch: VaultEpoch;
	readonly deviceId: DeviceId;
	readonly schemaVersion: number;
	readonly clientVersion: string;
	readonly createdAtMs: number;
	/** Set when this DB was rebuilt from side-file mirrors after loss. */
	readonly recoveredFromMirror: boolean;
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
export interface MetaDaily {
	readonly key: "daily";
	/** Local calendar day (YYYY-MM-DD) per ClockPort.now(). */
	readonly day: string;
	readonly framesSent: number;
	readonly bytesSent: number;
}
/**
 * Highest own ns / cfg frameNo of the abandoned timeline, carried by epoch
 * migration (DESIGN §c.12 step 3, e2ee-design §8.2) so new frames never reuse
 * its numbers. Absent = 0.
 */
export interface MetaFrameNoFloor {
	readonly key: "frameNoFloor";
	readonly ns: number;
	readonly cfg: number;
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
export type MetaRecord = MetaIdentity | MetaCursor | MetaOutboxOrder | MetaDaily | MetaRelayCheckpointDuty | MetaFrameNoFloor | MetaKeyring | MetaBlobPut;
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
	/** 1 iff appliedSeq < remoteHeadSeq. Indexed (IDB cannot index booleans). */
	readonly stale: 0 | 1;
	/** Catch-up priority when stale: lower first (DESIGN §j.6). */
	readonly priority: number;
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
	readonly lastAccessMs: number;
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
	/** Persisted, not yet written to a session. */
	| "pending"
	/** Written to a session; awaiting receipt. */
	| "sent"
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
	 * held only: the frame this waits for (DESIGN §e.1): the doc's ns create
	 * (released when it folds), the newest adoptable of the same stream
	 * (released when that record is gone), or the last x: chunk of a
	 * bodyUpdateRef (released when no own frame of that x: stream remains).
	 */
	readonly dependsOn: ClientFrameId | null;
	/** adoptable only: identity of the provisional frame being shadowed. */
	readonly adoptOf: { readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId; readonly receivedAtMs: number } | null;
	readonly attempts: number;
	readonly createdAtMs: number;
	readonly lastSentAtMs: number;
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
	/** Truncated to QUARANTINE_ROW_BYTES; full hash kept. */
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
	readonly via: "store" | "log";
	readonly attempts: number;
	readonly nextAttemptAtMs: number;
	/** 0 = queued, 1 = in flight. Indexed with nextAttemptAtMs. */
	readonly active: 0 | 1;
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
	streamsByStale: "byStalePriority",
	streamsByAccess: "byAccess",
	outboxByOrder: "byOrder",
	outboxByStream: "byStreamOrder",
	outboxByState: "byStateOrder",
	quarantineByAt: "byAt",
	syncedByPathKey: "byPathKey",
	blobQueueByDue: "byActiveDue",
} as const;

/** Schema map for StoragePort typing. */
export interface YaosSchema {
	readonly [STORE.meta]: { readonly record: MetaRecord; readonly key: MetaKey; readonly indexes: never };
	readonly [STORE.streams]: { readonly record: StreamRecord; readonly key: StreamName; readonly indexes: typeof INDEX.streamsByStale | typeof INDEX.streamsByAccess };
	readonly [STORE.snapshots]: { readonly record: SnapshotRecord; readonly key: StreamName; readonly indexes: never };
	readonly [STORE.tail]: { readonly record: TailRecord; readonly key: TailKey; readonly indexes: never };
	readonly [STORE.outbox]: { readonly record: OutboxRecord; readonly key: ClientFrameId; readonly indexes: typeof INDEX.outboxByOrder | typeof INDEX.outboxByStream | typeof INDEX.outboxByState };
	readonly [STORE.quarantine]: { readonly record: QuarantineRecord; readonly key: TailKey; readonly indexes: typeof INDEX.quarantineByAt };
	readonly [STORE.synced]: { readonly record: SyncedRecord; readonly key: DocId; readonly indexes: typeof INDEX.syncedByPathKey };
	readonly [STORE.baseText]: { readonly record: BaseTextRecord; readonly key: DocId; readonly indexes: never };
	readonly [STORE.localTree]: { readonly record: LocalTreeRecord; readonly key: PathKey; readonly indexes: never };
	readonly [STORE.intents]: { readonly record: IntentRecord; readonly key: string; readonly indexes: never };
	readonly [STORE.cfgBase]: { readonly record: CfgBaseRecord; readonly key: ConfigRelPath; readonly indexes: never };
	readonly [STORE.blobQueue]: { readonly record: BlobQueueRecord; readonly key: ContentHash; readonly indexes: typeof INDEX.blobQueueByDue };
}

export const STORE_SPECS: Readonly<Record<keyof YaosSchema, StoreSpec>> = {
	meta: { keyPath: "key", indexes: {} },
	streams: {
		keyPath: "stream",
		indexes: {
			[INDEX.streamsByStale]: { keyPath: ["stale", "priority"], unique: false },
			[INDEX.streamsByAccess]: { keyPath: "lastAccessMs", unique: false },
		},
	},
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
	synced: { keyPath: "docId", indexes: { [INDEX.syncedByPathKey]: { keyPath: "pathKey", unique: false } } },
	baseText: { keyPath: "docId", indexes: {} },
	localTree: { keyPath: "pathKey", indexes: {} },
	intents: { keyPath: "id", indexes: {} },
	cfgBase: { keyPath: "file", indexes: {} },
	blobQueue: { keyPath: "hash", indexes: { [INDEX.blobQueueByDue]: { keyPath: ["active", "nextAttemptAtMs"], unique: false } } },
};

/** All tail rows of one stream: [stream, 0] .. [stream, +inf]. */
export function tailRange(stream: StreamName, afterSeq: Seq = 0, throughSeq: Seq = Number.MAX_SAFE_INTEGER): KeyRange {
	return { lower: [stream, afterSeq], upper: [stream, throughSeq], lowerOpen: true, upperOpen: false };
}

// ---------------------------------------------------------------------------
// Side-file mirrors (DESIGN §e.4). Written by the host on the engine's request.
// ---------------------------------------------------------------------------

/** Byte format: core/codec/mirrors.ts (the shapes below are assignable to its OutboxMirrorData / SyncedMirrorData). */
export { MIRROR_FORMAT_VERSION, OUTBOX_MIRROR_MAGIC, SYNCED_MIRROR_MAGIC } from "../../core/codec/mirrors";

export interface OutboxMirrorFrame {
	readonly clientFrameId: ClientFrameId;
	readonly stream: StreamName;
	readonly order: number;
	readonly state: OutboxState;
	readonly authorNsSeq: Seq;
	readonly dependsOn: ClientFrameId | null;
	readonly adoptOf: { readonly deviceId: DeviceId; readonly clientFrameId: ClientFrameId } | null;
	readonly sealed: Uint8Array;
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
