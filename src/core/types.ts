/**
 * Core domain types for the YAOS client remake.
 *
 * Owned by the architect. Builders may ADD types in their own files but must
 * not change the shapes here without a DESIGN.md change. See
 * docs/client-remake/DESIGN.md §c (fold), §f (three trees, planner).
 *
 * Everything in src/core is pure: no I/O, no timers, no Date/Math.random.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

declare const brandTag: unique symbol;
/** Nominal typing for string/number identifiers. Zero runtime cost. */
export type Brand<T, B extends string> = T & { readonly [brandTag]: B };

/** 16 random bytes, base64url without padding (22 chars). Stable for the life of a file. */
export type DocId = Brand<string, "DocId">;
/** 16 random bytes, base64url without padding (22 chars). Unique per appended frame, survives IDB loss. */
export type ClientFrameId = Brand<string, "ClientFrameId">;
/** Opaque id assigned at pairing; the relay authenticates it. */
export type DeviceId = Brand<string, "DeviceId">;
/** Opaque vault id from pairing. */
export type VaultId = Brand<string, "VaultId">;
/** Lowercase hex SHA-256 (64 chars). Logical content hash (markdown-lf-v1 canonical bytes for markdown). */
export type ContentHash = Brand<string, "ContentHash">;
/** Lowercase hex SHA-256 of the exact on-disk bytes. Echo suppression only. */
export type DiskFingerprint = Brand<string, "DiskFingerprint">;
/** NFC(lowerCase(NFC(path))). The only key used for path collision decisions. */
export type PathKey = Brand<string, "PathKey">;
/** Relay stream name: "ns" | "cfg" | "b:<docId>" | "c:<docId>" | "x:<hash>". */
export type StreamName = Brand<string, "StreamName">;

/** Vault-wide relay clock position within one vaultEpoch. 0 = before the first row. */
export type Seq = number;
/** Relay vault epoch. A change invalidates every cursor (close 4409). */
export type VaultEpoch = number;
/** NFC, "/"-separated, no leading or trailing "/", vault-relative. */
export type VaultPath = string;
/** Path relative to the Obsidian config dir (e.g. "app.json", "plugins/x/data.json"). */
export type ConfigRelPath = string;

export type DocKind = "markdown" | "canvas" | "blob";

// ---------------------------------------------------------------------------
// Streams (tiny pure helpers)
// ---------------------------------------------------------------------------

export const NS_STREAM = "ns" as StreamName;
export const CFG_STREAM = "cfg" as StreamName;

export type StreamClass = "ns" | "cfg" | "body" | "canvas" | "blobchunk" | "other";

export function bodyStream(docId: DocId): StreamName {
	return `b:${docId}` as StreamName;
}
export function canvasStream(docId: DocId): StreamName {
	return `c:${docId}` as StreamName;
}
export function blobChunkStream(hash: ContentHash): StreamName {
	return `x:${hash}` as StreamName;
}
export function docStream(kind: DocKind, docId: DocId): StreamName | null {
	if (kind === "markdown") return bodyStream(docId);
	if (kind === "canvas") return canvasStream(docId);
	return null;
}
export function streamClass(stream: StreamName): StreamClass {
	if (stream === NS_STREAM) return "ns";
	if (stream === CFG_STREAM) return "cfg";
	if (stream.startsWith("b:")) return "body";
	if (stream.startsWith("c:")) return "canvas";
	if (stream.startsWith("x:")) return "blobchunk";
	return "other";
}
/** DocId of a b:/c: stream, else null. */
export function streamDocId(stream: StreamName): DocId | null {
	const cls = streamClass(stream);
	return cls === "body" || cls === "canvas" ? (stream.slice(2) as DocId) : null;
}

/** The single path-key definition (DESIGN §c.2). Input must already be a valid VaultPath. */
export function pathKeyOf(path: VaultPath): PathKey {
	return path.normalize("NFC").toLowerCase().normalize("NFC") as PathKey;
}

/** Kind is a pure function of the extension (DESIGN §c.2). */
export function kindOfPath(path: VaultPath): DocKind {
	const leaf = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (leaf.endsWith(".md")) return "markdown";
	if (leaf.endsWith(".canvas")) return "canvas";
	return "blob";
}

// ---------------------------------------------------------------------------
// Namespace ops (ns stream) — DESIGN §b.3, §c
// ---------------------------------------------------------------------------

export type NsOp =
	| NsCreateOp
	| NsRenameOp
	| NsDeleteOp
	| NsRestoreOp
	| NsSetBlobOp
	| NsUpgradeRulesOp;

export interface NsCreateOp {
	readonly t: "create";
	readonly docId: DocId;
	readonly kind: DocKind;
	readonly path: VaultPath;
	/** Logical hash of the initial content (markdown: canonical text; canvas: canonical JSON; blob: bytes). */
	readonly contentHash: ContentHash;
	readonly size: number;
}
export interface NsRenameOp {
	readonly t: "rename";
	readonly docId: DocId;
	readonly path: VaultPath;
}
export interface NsDeleteOp {
	readonly t: "delete";
	readonly docId: DocId;
	/** Highest body/canvas row seq the deleting device had folded for this doc. */
	readonly baseBodySeq: Seq;
}
export interface NsRestoreOp {
	readonly t: "restore";
	readonly docId: DocId;
	readonly path: VaultPath;
	/** The deletedSeq of the delete this restore counters; stale restores are ignored. */
	readonly againstDeleteSeq: Seq;
}
export interface NsSetBlobOp {
	readonly t: "setBlob";
	readonly docId: DocId;
	readonly hash: ContentHash;
	readonly size: number;
	/** CAS: the entry's blob.rev the author based this on. */
	readonly baseRev: Seq;
}
export interface NsUpgradeRulesOp {
	readonly t: "upgradeRules";
	/** Fold rules version applying to every op with a greater (seq, index). */
	readonly version: number;
}

/** A committed ns row after envelope open + decode. Ops fold in (seq, index) order. */
export interface NsFrame {
	readonly seq: Seq;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** Author's committed ns coversSeq when it built the frame. */
	readonly authorNsSeq: Seq;
	readonly ops: readonly NsOp[];
}

// ---------------------------------------------------------------------------
// Namespace fold state — DESIGN §c.1
// ---------------------------------------------------------------------------

export type NsEntryState = "live" | "deleted" | "merged";

export interface NsBlobRef {
	readonly hash: ContentHash;
	readonly size: number;
	/** Seq of the op that set this blob value (create or setBlob). */
	readonly rev: Seq;
}

export interface NsEntry {
	readonly docId: DocId;
	readonly kind: DocKind;
	/** Current path (live), last path (deleted), winner's path at merge time (merged). */
	readonly path: VaultPath;
	/** Derived from path; not encoded in checkpoints. */
	readonly pathKey: PathKey;
	readonly state: NsEntryState;
	readonly createdSeq: Seq;
	readonly createdBy: DeviceId;
	/** Seq of the last effective op on this entry (create/rename/setBlob/restore/delete). */
	readonly lastTouchSeq: Seq;
	/** Seq of the effective delete; 0 unless state === "deleted". */
	readonly deletedSeq: Seq;
	/** baseBodySeq of the effective delete; 0 unless state === "deleted". */
	readonly deleteBaseBodySeq: Seq;
	readonly createHash: ContentHash;
	readonly createSize: number;
	/** kind === "blob" only. */
	readonly blob: NsBlobRef | null;
	/** state === "merged" only. Always points at an entry that is not itself merged. */
	readonly aliasOf: DocId | null;
}

/**
 * Canonical, deterministic fold state. Mutable maps are owned by the fold;
 * everything else must treat them as read-only.
 */
export interface NsFoldState {
	readonly formatVersion: 1;
	foldRulesVersion: number;
	/** All ns rows with seq <= coversSeq are folded. */
	coversSeq: Seq;
	readonly entries: Map<DocId, NsEntry>;
	/** Last NS_DEDUPE_RING clientFrameIds per device, oldest first. */
	readonly recentFrames: Map<DeviceId, ClientFrameId[]>;
}

/** Derived indexes; rebuilt from entries, never encoded. */
export interface NsFoldIndex {
	/** pathKey -> docId, live entries only. */
	readonly byPathKey: Map<PathKey, DocId>;
	/** Folder pathKey -> number of live entries strictly beneath it. */
	readonly folderRefs: Map<PathKey, number>;
	/** Count of deleted + merged entries (tombstone pool). */
	tombstones: number;
}

export type NsIgnoreReason =
	| "duplicate-frame"
	| "duplicate-docid"
	| "unknown-docid"
	| "invalid-path"
	| "kind-mismatch"
	| "stale-delete"
	| "already-deleted"
	| "not-deleted"
	| "restore-not-current"
	| "stale-revive"
	| "rev-mismatch"
	| "not-blob"
	| "noop"
	| "rules-version";

export type NsOpOutcome =
	| { readonly kind: "applied" }
	| { readonly kind: "suffixed"; readonly requestedPath: VaultPath; readonly finalPath: VaultPath }
	| { readonly kind: "merged"; readonly into: DocId }
	| { readonly kind: "revived"; readonly finalPath: VaultPath }
	| { readonly kind: "deleted" }
	| { readonly kind: "pruned"; readonly docIds: readonly DocId[] }
	| { readonly kind: "ignored"; readonly reason: NsIgnoreReason };

/** One event per op (plus prune events). Used by planners to detect "I lost" and by diagnostics. */
export interface NsFoldEvent {
	readonly seq: Seq;
	/** Op index within the frame; -1 for frame-level events (duplicate frame, prune). */
	readonly index: number;
	readonly deviceId: DeviceId;
	readonly clientFrameId: ClientFrameId;
	/** Target after alias redirect; null for upgradeRules / frame-level events. */
	readonly docId: DocId | null;
	readonly outcome: NsOpOutcome;
}

/** Signature WP-A implements in src/core/ns/fold.ts. Pure and total: never throws on valid NsFrame. */
export type FoldNsFrame = (state: NsFoldState, index: NsFoldIndex, frame: NsFrame) => readonly NsFoldEvent[];

// ---------------------------------------------------------------------------
// Settings (cfg stream) — DESIGN §j.3
// ---------------------------------------------------------------------------

export type CfgFileContent =
	| { readonly t: "inline"; readonly bytes: Uint8Array }
	| { readonly t: "blob"; readonly hash: ContentHash; readonly size: number };

export type CfgOp =
	| { readonly t: "jsonSet"; readonly file: ConfigRelPath; readonly key: string; readonly valueJson: string }
	| { readonly t: "jsonDel"; readonly file: ConfigRelPath; readonly key: string }
	| {
		readonly t: "filePut";
		readonly file: ConfigRelPath;
		readonly content: CfgFileContent;
		/** plugins/<id>/data.json only: manifest version of the writing plugin. */
		readonly pluginVersion: string | null;
	}
	| { readonly t: "fileDel"; readonly file: ConfigRelPath }
	| { readonly t: "pluginSet"; readonly pluginId: string; readonly enabled: boolean }
	| { readonly t: "pluginDel"; readonly pluginId: string };

/** LWW register version. Total order = (seq, index). */
export interface CfgVersion {
	readonly seq: Seq;
	readonly index: number;
	readonly deviceId: DeviceId;
}
export interface CfgRegister<T> {
	/** null = deleted (tombstone kept; key count is bounded by allowlist). */
	readonly value: T | null;
	readonly version: CfgVersion;
}
export interface CfgFoldState {
	readonly formatVersion: 1;
	coversSeq: Seq;
	/** Key = file + "\u0000" + topLevelKey. */
	readonly json: Map<string, CfgRegister<string>>;
	readonly files: Map<ConfigRelPath, CfgRegister<{ readonly content: CfgFileContent; readonly pluginVersion: string | null }>>;
	readonly plugins: Map<string, CfgRegister<boolean>>;
}

// ---------------------------------------------------------------------------
// Three trees — DESIGN §f.1
// ---------------------------------------------------------------------------

/**
 * Monotone body version. Changes iff the doc's content may have changed:
 * a row from another device was ingested, or this device produced a frame.
 * Receipts of own frames do NOT change it.
 */
export interface BodyVersion {
	/** Max seq of rows from other devices ingested for this stream (incl. applied checkpoints). */
	readonly remoteSeq: Seq;
	/** Max outbox order of own frames produced for this stream (0 = none). */
	readonly localOrder: number;
}

export interface RemoteBodyInfo {
	readonly stream: StreamName;
	readonly version: BodyVersion;
	/** appliedSeq >= remoteHeadSeq and no causal hole. */
	readonly caughtUp: boolean;
	/** Stream has at least one row/checkpoint (a create's body may arrive after the ns row). */
	readonly hasContent: boolean;
	/** Ingest gate froze this doc (quarantine / undecryptable row). */
	readonly frozen: boolean;
}

/** Remote tree = OptimisticRemote(committed ns fold + own pending ns ops) joined with body info. */
export interface RemoteEntry {
	readonly docId: DocId;
	readonly kind: DocKind;
	readonly path: VaultPath;
	readonly pathKey: PathKey;
	readonly state: NsEntryState;
	readonly lastTouchSeq: Seq;
	readonly deletedSeq: Seq;
	readonly deleteBaseBodySeq: Seq;
	readonly createHash: ContentHash;
	readonly blob: NsBlobRef | null;
	readonly aliasOf: DocId | null;
	/** Own ns ops for this doc are not yet folded as committed: local state is pinned. */
	readonly pendingLocal: boolean;
	/** markdown/canvas only. */
	readonly body: RemoteBodyInfo | null;
}

/** Local tree = git-index-style stat cache with hash confirmation. Keyed by pathKey. */
export interface LocalEntry {
	/** Exact on-disk path as the vault reports it (may differ from NFC). */
	readonly diskPath: string;
	/** NFC form used everywhere else. */
	readonly path: VaultPath;
	readonly pathKey: PathKey;
	readonly kind: DocKind;
	readonly size: number;
	readonly mtimeMs: number;
	/** null = stat changed since last hash, content unknown. */
	readonly hash: ContentHash | null;
	readonly fingerprint: DiskFingerprint | null;
	/** Monotonic-clock time the hash was taken (racy-git check). */
	readonly hashedAtMs: number;
	/** Matches an exclude rule or is not portable: never planned as create/delete. */
	readonly excluded: boolean;
	/** Bound to an editor view: disk is owned by the editor (DESIGN §d.2). */
	readonly bound: boolean;
}

/** Synced tree = merge base per doc: the last state known equal on disk and in the log. */
export interface SyncedEntry {
	readonly docId: DocId;
	readonly path: VaultPath;
	readonly pathKey: PathKey;
	readonly kind: DocKind;
	readonly contentHash: ContentHash;
	readonly fingerprint: DiskFingerprint;
	readonly size: number;
	readonly mtimeMs: number;
	/** markdown/canvas: body version at the sync point. */
	readonly bodyVersion: BodyVersion | null;
	/** blob: rev at the sync point. 0 otherwise. */
	readonly blobRev: Seq;
	/** NsEntry.lastTouchSeq at the sync point. */
	readonly nsTouchSeq: Seq;
	/** A base text is stored in baseText (markdown/canvas below MAX_BASE_TEXT_CHARS). */
	readonly hasBase: boolean;
}

/** Vault event hint: a rename observed live; verified by the next reconcile. */
export interface ObservedRename {
	readonly from: VaultPath;
	readonly to: VaultPath;
	readonly atMs: number;
}

// ---------------------------------------------------------------------------
// Planner — DESIGN §f.2
// ---------------------------------------------------------------------------

export type PlanScope =
	| { readonly t: "full" }
	| { readonly t: "docs"; readonly docIds: readonly DocId[]; readonly pathKeys: readonly PathKey[] };

export interface PlannerInput {
	readonly scope: PlanScope;
	readonly remote: ReadonlyMap<DocId, RemoteEntry>;
	/** Live remote entries by pathKey (OptimisticRemote index). */
	readonly remoteByPathKey: ReadonlyMap<PathKey, DocId>;
	readonly local: ReadonlyMap<PathKey, LocalEntry>;
	/** True iff local reflects a complete listing (full scan) rather than event hints. */
	readonly localComplete: boolean;
	readonly synced: ReadonlyMap<DocId, SyncedEntry>;
	readonly renames: readonly ObservedRename[];
	/** Docs with own unsent/unreceipted body frames (edit-beats-delete, restore duty). */
	readonly docsWithPendingBody: ReadonlySet<DocId>;
	/** Committed ns fold coversSeq (authorNsSeq of ops we would emit). */
	readonly nsCoversSeq: Seq;
	readonly brake: BrakeConfig;
	/** User approved the held destructive ops of this brake id. */
	readonly brakeApproval: string | null;
	/** Fresh ids for creates; the planner takes from the front, in order. Supplied by RandomPort. */
	readonly freshDocIds: readonly DocId[];
	readonly deviceLabel: string;
	/** Wall-clock for conflict copy names only (never for decisions). */
	readonly nowMs: number;
}

export type ConflictReason =
	| "both-edited"
	| "no-base"
	| "too-large"
	| "blob-concurrent"
	| "path-taken"
	| "recovered";

/** Disk ops are executed on the main thread by the host; ns ops become frames; content ops run the merge engine. */
export type PlannerOp =
	// --- namespace (become NsOps in one or more frames, in this order) ---
	| { readonly op: "nsCreate"; readonly docId: DocId; readonly kind: DocKind; readonly path: VaultPath; readonly contentHash: ContentHash; readonly size: number }
	| { readonly op: "nsRename"; readonly docId: DocId; readonly path: VaultPath }
	| { readonly op: "nsDelete"; readonly docId: DocId; readonly baseBodySeq: Seq }
	| { readonly op: "nsRestore"; readonly docId: DocId; readonly path: VaultPath; readonly againstDeleteSeq: Seq }
	| { readonly op: "nsSetBlob"; readonly docId: DocId; readonly hash: ContentHash; readonly size: number; readonly baseRev: Seq }
	// --- disk (host executes with CAS preconditions) ---
	| { readonly op: "diskMaterialize"; readonly docId: DocId; readonly path: VaultPath; readonly expect: DiskExpect }
	| { readonly op: "diskRename"; readonly docId: DocId | null; readonly from: VaultPath; readonly to: VaultPath; readonly expect: DiskExpect }
	| { readonly op: "diskTrash"; readonly docId: DocId | null; readonly path: VaultPath; readonly expect: DiskExpect }
	| { readonly op: "conflictCopy"; readonly docId: DocId | null; readonly from: VaultPath; readonly to: VaultPath; readonly reason: ConflictReason; readonly expect: DiskExpect }
	// --- content (engine runs the ONE merge engine, may emit body frames + disk writes) ---
	| { readonly op: "reconcileContent"; readonly docId: DocId; readonly path: VaultPath; readonly kind: "markdown" | "canvas"; readonly hasBase: boolean }
	| { readonly op: "pushBlob"; readonly docId: DocId; readonly path: VaultPath; readonly hash: ContentHash; readonly size: number }
	| { readonly op: "fetchBlob"; readonly docId: DocId; readonly path: VaultPath; readonly hash: ContentHash; readonly size: number }
	// --- bookkeeping ---
	| { readonly op: "rebind"; readonly fromDocId: DocId; readonly toDocId: DocId; readonly path: VaultPath }
	| { readonly op: "syncedPut"; readonly entry: SyncedEntry }
	| { readonly op: "syncedDrop"; readonly docId: DocId }
	| { readonly op: "needHash"; readonly path: VaultPath }
	| { readonly op: "wait"; readonly docId: DocId; readonly reason: "body-not-caught-up" | "body-empty" | "blob-unavailable" | "frozen" | "pending-ns" };

/** Precondition the host checks before a destructive disk op. */
export type DiskExpect =
	| { readonly t: "absent" }
	| { readonly t: "hash"; readonly hash: ContentHash }
	| { readonly t: "any" };

export interface BrakeConfig {
	/** Hold when destructive ops exceed max(minCount, ratio * syncedCount). */
	readonly minCount: number;
	readonly ratio: number;
	/** Hold when the listing shrank below this fraction of synced files (vault not mounted). */
	readonly listingFloorRatio: number;
	readonly maxConflictCopies: number;
}

export interface BrakeReport {
	/** Stable id: hash of the sorted held ops; approval references it. */
	readonly id: string;
	readonly reason: "mass-delete-local" | "mass-delete-remote" | "listing-shrank" | "conflict-flood";
	readonly heldCount: number;
	readonly syncedCount: number;
	readonly samplePaths: readonly VaultPath[];
}

export interface Plan {
	/** Executable now, in order. */
	readonly ops: readonly PlannerOp[];
	/** Destructive ops held by the safety brake (not executed until approved). */
	readonly held: readonly PlannerOp[];
	readonly brake: BrakeReport | null;
	/** Fresh docIds consumed from PlannerInput.freshDocIds. */
	readonly consumedDocIds: number;
}

/** Signature WP-B implements in src/core/plan/planner.ts. Pure. */
export type PlanFn = (input: PlannerInput) => Plan;

// ---------------------------------------------------------------------------
// Merge engine — DESIGN §f.3
// ---------------------------------------------------------------------------

export interface MergeLimits {
	readonly maxInputChars: number;
	readonly maxEditsPerSide: number;
}

export interface MergeInput {
	/** null = no base available (IDB loss, never synced). */
	readonly base: string | null;
	readonly disk: string;
	readonly crdt: string;
	readonly limits: MergeLimits;
}

export type MergeResult =
	/** disk === crdt. Only the synced base advances. */
	| { readonly kind: "identical" }
	/** crdt === base: apply disk -> crdt as a minimal diff. */
	| { readonly kind: "disk-only"; readonly text: string }
	/** disk === base: write crdt to disk. */
	| { readonly kind: "crdt-only"; readonly text: string }
	/** Both changed, no overlap: apply text to crdt (CAS on crdt) and write it to disk. */
	| { readonly kind: "clean"; readonly text: string }
	/** Overlap / no base / too large: crdt keeps its side (+ clean disk hunks if any); full disk text goes to a conflict copy. */
	| { readonly kind: "conflict"; readonly text: string; readonly conflictCopy: string; readonly reason: ConflictReason };

/** Signature WP-B implements in src/core/merge/merge.ts. Pure, bounded time. */
export type MergeFn = (input: MergeInput) => MergeResult;
