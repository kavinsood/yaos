/**
 * Numeric limits and per-device-class budgets. DESIGN §c, §d, §i.
 * Constants only. Changing a fold-affecting constant (marked FOLD) requires a
 * new fold rules version (DESIGN §c.10): every device must agree on them.
 */

// --- Fold (FOLD: deterministic across devices) ------------------------------

/** FOLD. Rules version implemented by this client. */
export const FOLD_RULES_VERSION = 1;
/** FOLD. Max UTF-8 bytes per path segment. */
export const MAX_SEGMENT_BYTES = 255;
/** FOLD. Max UTF-8 bytes per full path. */
export const MAX_PATH_BYTES = 1024;
/** FOLD. Conflict suffix " (n)" tries n = 2..MAX_SUFFIX_N before the docId fallback. */
export const MAX_SUFFIX_N = 10_000;
/** FOLD. Characters of the docId used by the fallback suffix " (<docId8>)". */
export const SUFFIX_DOCID_CHARS = 8;
/** FOLD. Tombstone pool (deleted + merged) cap; prune to cap - hysteresis when exceeded. */
export const TOMBSTONE_CAP = 20_000;
export const TOMBSTONE_PRUNE_HYSTERESIS = 1_000;
/** FOLD. clientFrameIds remembered per device for duplicate-frame suppression (ns and cfg). */
export const NS_DEDUPE_RING = 64;
/**
 * Send window for ns/cfg frames, over frameNo (e2ee-design §8.2): own frame f
 * of a stream may be sent only when every own frame with frameNo <=
 * f - NS_SEND_WINDOW of that stream is receipted. With NS_SEND_WINDOW <=
 * NS_DEDUPE_RING / 2 a resend outside the relay's dedupe window is always
 * still in the fold's ring (DESIGN §c.3), and with REPLAY_WINDOW >=
 * 2 * NS_SEND_WINDOW no honest frame is ever stale.
 */
export const NS_SEND_WINDOW = 32;
/**
 * FOLD. Anti-replay window over frameNo per (device, stream), in frames
 * (e2ee-design §8.2). 64-bit bitmap; must stay >= 2 * NS_SEND_WINDOW so an
 * honest writer's frames are never stale (the exactness argument).
 */
export const REPLAY_WINDOW = 64;
/** FOLD. Windows reserved stems (case-insensitive, with or without extension). */
export const RESERVED_STEMS: readonly string[] = [
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
/** FOLD. Characters never allowed in a path segment (plus C0 controls and DEL). */
export const FORBIDDEN_PATH_CHARS = "\\*\"<>:|?";

// --- Frames -----------------------------------------------------------------

/** Max ns ops per frame. */
export const MAX_NS_OPS_PER_FRAME = 512;
/**
 * Max encoded inner content per frame (all kinds), under every suite. The
 * relay payload limit is 1 MiB for the whole sealed envelope (1009 close above
 * it). Suite 1 pads with Padmé, which for lengths in [2^19, 2^20) rounds up to
 * 16 KiB: the largest padded inner that still fits is 63 × 16 KiB, so content
 * stops 32 KiB short of 1 MiB, leaving >= 16 KiB for the inner header, the pad
 * marker, the outer header and the 28 B AEAD overhead (e2ee-design §7.3).
 */
export const MAX_FRAME_CONTENT_BYTES = 1024 * 1024 - 32 * 1024;
/** Initial content of a large new note is inserted in chunks of this many UTF-16 units, one frame each (DESIGN §b.6). */
export const INITIAL_INSERT_CHUNK_CHARS = 192 * 1024;
export const MAX_NS_FRAME_BYTES = 256 * 1024;
/** Body update larger than this goes through the blob store as BODY_UPDATE_REF (or freezes the doc without one). */
export const MAX_INLINE_UPDATE_BYTES = MAX_FRAME_CONTENT_BYTES;
/** Open-doc frame builder: close after idle / max age. */
export const OPEN_FRAME_IDLE_MS = 100;
export const OPEN_FRAME_MAX_MS = 300;
/** Background-doc (merge-produced) frames close immediately after the producing job. */
export const FRAME_MAX_UPDATES = 256;
export const FRAME_MAX_BYTES = 64 * 1024;
/** Main thread coalesces editor updates before posting to the worker. */
export const MAIN_UPDATE_COALESCE_MS = 16;
/** Blob chunk payload when the blob store is absent (x:<address> streams). */
export const BLOB_CHUNK_BYTES = 768 * 1024;
/** Largest attachment carried on the log without a blob store. */
export const MAX_LOG_BLOB_BYTES = 8 * 1024 * 1024;

// --- Crypto suite 1 (e2ee-design §7.3) ----------------------------------------

/** Padmé floor: every padded payload is at least this long (decision D3). */
export const PADME_FLOOR_BYTES = 256;
/**
 * Largest suite-1 blob plaintext, the 0x80 pad marker included: 39 × 256 KiB
 * padded plus header and AEAD overhead fits the 10 MiB upload cap (DECISIONS D9).
 */
export const MAX_BLOB_PLAINTEXT_BYTES_SUITE1 = 39 * 256 * 1024 - 1;
/**
 * Blob download quarantine (e2ee-design §10.2): after the initial attempt and this many retries all failed
 * deterministically (key verified), spanning at least BLOB_QUARANTINE_MIN_MS, the referencing row is quarantined.
 */
export const BLOB_QUARANTINE_RETRIES = 3;
export const BLOB_QUARANTINE_MIN_MS = 3 * 60_000;

// --- Content ----------------------------------------------------------------

export const MAX_DOC_TEXT_CHARS = 8 * 1024 * 1024;
export const MAX_BASE_TEXT_CHARS = 4 * 1024 * 1024;
export const MERGE_MAX_INPUT_CHARS = 2 * 1024 * 1024;
export const MERGE_MAX_EDITS_PER_SIDE = 10_000;
/** Provisional frame not committed within this window is re-appended by a device that holds it (adopt orphan). */
export const PROVISIONAL_ADOPT_MS = 60_000;

// --- Compaction -------------------------------------------------------------

export const LOCAL_COMPACT_ROWS = 200;
export const LOCAL_COMPACT_BYTES = 256 * 1024;
export const REMOTE_CHECKPOINT_ROWS = 512;
export const REMOTE_CHECKPOINT_BYTES = 1024 * 1024;
export const REMOTE_CHECKPOINT_IDLE_MS = 30_000;
export const NS_CHECKPOINT_ROWS = 1_000;
export const NS_CHECKPOINT_BYTES = 1024 * 1024;
/** Hard cap on tail rows per stream; beyond it compaction runs in the open-note lane. */
export const TAIL_HARD_ROWS = 2_000;

// --- Echo / reconcile -------------------------------------------------------

export const ECHO_TTL_MS = 10_000;
/** mtime within this window of the hash time is racily clean: re-hash next pass. */
export const RACY_WINDOW_MS = 2_000;
export const BOUND_BASE_PERSIST_MS = 60_000;

// --- Safety brake defaults --------------------------------------------------

export const BRAKE_MIN_COUNT = 50;
export const BRAKE_RATIO = 0.2;
export const BRAKE_LISTING_FLOOR_RATIO = 0.5;
export const BRAKE_MAX_CONFLICT_COPIES = 200;
export const BRAKE_OVERWRITE_MIN_BYTES = 4096;
export const BRAKE_OVERWRITE_SHRINK_RATIO = 0.5;

// --- Stores -----------------------------------------------------------------

export const QUARANTINE_MAX_RECORDS = 500;
export const QUARANTINE_MAX_BYTES = 32 * 1024 * 1024;
export const QUARANTINE_ROW_BYTES = 256 * 1024;
export const OUTBOX_SOFT_BYTES = 16 * 1024 * 1024;
export const OUTBOX_MIRROR_MAX_BYTES = 32 * 1024 * 1024;
export const OUTBOX_MIRROR_DEBOUNCE_MS = 1_000;
export const OUTBOX_MIRROR_TRIM_DEBOUNCE_MS = 5_000;
export const SYNCED_MIRROR_DEBOUNCE_MS = 30_000;

// --- Settings sync (DESIGN §j.3; legacy settingsSync/types.ts) ---------------

/** Largest config file settings sync sends or writes. */
export const CFG_MAX_FILE_BYTES = 1_000_000;
/** Synced config files, in path order, stop at the first one that would take the total past this. */
export const CFG_MAX_TOTAL_BYTES = 4_000_000;
/** ... or past this many files. */
export const CFG_MAX_FILES = 256;

// --- Host keys (e2ee-design §6.1) -------------------------------------------

/**
 * SecretStorage may answer null before it has loaded: wait this long for its `changed` event before deciding a
 * pinned device's key is missing (§6.1 Startup).
 */
export const KEY_STORE_WAIT_MS = 5_000;

// --- Relay ------------------------------------------------------------------

export const RELAY_CLOSE = {
	normal: 1000,
	goingAway: 1001,
	abnormal: 1006,
	/** Malformed APPEND or Worker upgrade rejection (error code precedes it). */
	policy: 1008,
	oversize: 1009,
	rate: 1013,
	superseded: 4403,
	/** Legacy semantic-epoch reset; never sent on streams sockets (epoch change = VAULT_READY mismatch). */
	epoch: 4409,
} as const;
/** Client-side token bucket; the relay limit is 256 KiB/s with a 2 MiB burst per socket. */
export const APPEND_BYTES_PER_SEC = 192 * 1024;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 5 * 60_000;
export const SUPERSEDED_RETRY_MS = 60_000;

// --- Device classes and budgets (DESIGN §i.2) -------------------------------

export type DeviceClass = "desktop" | "tablet" | "phone" | "constrained";

export interface Budgets {
	readonly maxResidentDocs: number;
	/** Estimated Y.Doc heap (3 x encoded state). */
	readonly maxResidentBytes: number;
	/** Worker cooperative slice before yielding to the message loop. */
	readonly sliceMs: number;
	/** Parallel stream reads for catch-up. */
	readonly catchUpConcurrency: number;
	readonly blobConcurrency: number;
	readonly maxInflightAppendBytes: number;
	/** Outstanding main-thread read/write payload bytes. */
	readonly maxDiskIoBytesInFlight: number;
	readonly diskOpsPerBatch: number;
	/** Main-thread executor slice. */
	readonly mainSliceMs: number;
	readonly fullReconcileIntervalMs: number;
	/** Soft daily frame budget; beyond it frame timers stretch (DESIGN §i.6). */
	readonly dailyFrameSoftBudget: number;
	readonly docUpdateWindowBytes: number;
}

export const BUDGETS: Readonly<Record<DeviceClass, Budgets>> = {
	desktop: {
		maxResidentDocs: 400, maxResidentBytes: 256 * 1024 * 1024, sliceMs: 10,
		catchUpConcurrency: 8, blobConcurrency: 4, maxInflightAppendBytes: 1024 * 1024,
		maxDiskIoBytesInFlight: 8 * 1024 * 1024, diskOpsPerBatch: 32, mainSliceMs: 8,
		fullReconcileIntervalMs: 5 * 60_000, dailyFrameSoftBudget: 20_000, docUpdateWindowBytes: 512 * 1024,
	},
	tablet: {
		maxResidentDocs: 120, maxResidentBytes: 96 * 1024 * 1024, sliceMs: 10,
		catchUpConcurrency: 4, blobConcurrency: 2, maxInflightAppendBytes: 512 * 1024,
		maxDiskIoBytesInFlight: 4 * 1024 * 1024, diskOpsPerBatch: 16, mainSliceMs: 6,
		fullReconcileIntervalMs: 10 * 60_000, dailyFrameSoftBudget: 10_000, docUpdateWindowBytes: 256 * 1024,
	},
	phone: {
		maxResidentDocs: 60, maxResidentBytes: 48 * 1024 * 1024, sliceMs: 8,
		catchUpConcurrency: 3, blobConcurrency: 2, maxInflightAppendBytes: 512 * 1024,
		maxDiskIoBytesInFlight: 2 * 1024 * 1024, diskOpsPerBatch: 16, mainSliceMs: 5,
		fullReconcileIntervalMs: 10 * 60_000, dailyFrameSoftBudget: 6_000, docUpdateWindowBytes: 256 * 1024,
	},
	constrained: {
		maxResidentDocs: 24, maxResidentBytes: 24 * 1024 * 1024, sliceMs: 6,
		catchUpConcurrency: 2, blobConcurrency: 1, maxInflightAppendBytes: 256 * 1024,
		maxDiskIoBytesInFlight: 1024 * 1024, diskOpsPerBatch: 8, mainSliceMs: 4,
		fullReconcileIntervalMs: 15 * 60_000, dailyFrameSoftBudget: 4_000, docUpdateWindowBytes: 128 * 1024,
	},
};
