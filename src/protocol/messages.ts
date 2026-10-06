/**
 * Main <-> engine messages. DESIGN §g.
 *
 * One protocol, three carriers: a Blob-URL dedicated worker (production), an
 * inline in-process pair on the main thread (fallback when the worker cannot
 * start), and the same inline pair in Node (simulation/tests).
 *
 * Conventions:
 *  - Requests carry `rid` (per-sender increasing u32). Exactly one `result` or
 *    `error` answers each rid. Events carry no rid.
 *  - Every Uint8Array field marked [T] is transferred: its .buffer must be an
 *    ArrayBuffer owned exclusively by the message (byteOffset 0, full length)
 *    and the sender must not touch it after post.
 *  - No functions, class instances, Maps or Sets cross the boundary.
 */

import type {
	ContentHash, DeviceId, DiskFingerprint, DocId, DocKind, VaultEpoch, VaultId, VaultPath, BrakeReport, ConflictReason,
} from "../core/types";
import type { DeviceClass } from "../core/limits";
import type { PlatformInfo, LifecycleEvent } from "../ports/platform";
import type { VaultEvent, VaultStat, WritePrecondition, WriteOutcome, RenameOutcome, TrashMode, SideFileName } from "../ports/vault";
import type { ProtocolError } from "./errors";
import type { StatusSnapshot, DiagnosticsBundle } from "./status";

export const PROTOCOL_VERSION = 1;

export type RequestId = number;

// ---------------------------------------------------------------------------
// Shared payloads
// ---------------------------------------------------------------------------

export interface EngineSettings {
	readonly excludePatterns: readonly string[];
	readonly syncAttachments: boolean;
	readonly maxAttachmentBytes: number;
	readonly syncSettings: boolean;
	readonly trashMode: TrashMode;
	/** Use the relay's early provisional broadcast for open notes. */
	readonly provisionalBroadcast: boolean;
	/** Local recovery snapshots (DESIGN §j.4). */
	readonly snapshots: { readonly enabled: boolean; readonly keepDaily: number; readonly uploadToBlobStore: boolean };
}

export interface EngineInitConfig {
	readonly protocolVersion: number;
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
	/** Human label for conflict copy names (sanitized by the engine). */
	readonly deviceLabel: string;
	readonly deviceClass: DeviceClass;
	readonly platform: PlatformInfo;
	readonly configDir: string;
	readonly caseInsensitiveFs: boolean;
	/** Relay endpoint + credential. SECRET: never logged, never echoed in status/diagnostics. */
	readonly relay: { readonly url: string; readonly credential: string };
	readonly settings: EngineSettings;
	/** Side files read by the host at startup (DESIGN §e.4). [T] */
	readonly sideState: {
		readonly outboxMirror: readonly (Uint8Array | null)[];
		readonly syncedMirror: readonly (Uint8Array | null)[];
	};
}

/** Raw listing entry; the engine classifies (kind, exclude, portability). */
export interface LocalObservation {
	readonly stat: VaultStat;
}

export interface DiskReadRequest {
	readonly area: "vault" | "config";
	readonly path: string;
	readonly maxBytes: number;
}

export type DiskReadResult =
	| { readonly path: string; readonly ok: true; readonly stat: VaultStat; readonly bytes: Uint8Array /* [T] */ }
	| { readonly path: string; readonly ok: false; readonly reason: "missing" | "too-large" | "io"; readonly stat: VaultStat | null };

export type DiskWriteData =
	| { readonly t: "text"; readonly text: string }
	| { readonly t: "bytes"; readonly bytes: Uint8Array /* [T] */ };

export type DiskOpPurpose = "materialize" | "merge" | "conflict-copy" | "restore" | "remote-move" | "remote-delete" | "loser-rename" | "settings" | "snapshot-restore";

export type DiskOp =
	| { readonly t: "write"; readonly opId: number; readonly area: "vault" | "config"; readonly path: string; readonly data: DiskWriteData; readonly precondition: WritePrecondition; readonly docId: DocId | null; readonly purpose: DiskOpPurpose }
	| { readonly t: "rename"; readonly opId: number; readonly from: string; readonly to: VaultPath; readonly precondition: WritePrecondition; readonly docId: DocId | null; readonly purpose: DiskOpPurpose }
	| { readonly t: "trash"; readonly opId: number; readonly path: string; readonly mode: TrashMode; readonly precondition: WritePrecondition; readonly docId: DocId | null; readonly purpose: DiskOpPurpose }
	| { readonly t: "removeEmptyFolder"; readonly opId: number; readonly path: VaultPath };

export type DiskOpResult =
	| { readonly opId: number; readonly t: "write"; readonly outcome: WriteOutcome }
	| { readonly opId: number; readonly t: "rename" | "trash"; readonly outcome: RenameOutcome }
	| { readonly opId: number; readonly t: "removeEmptyFolder"; readonly ok: boolean }
	/** Not attempted: an earlier op of the batch failed and this one depended on it. */
	| { readonly opId: number; readonly t: "skipped" };

export type DocUpdateOrigin = "remote" | "provisional" | "merge" | "restore" | "resync";

/**
 * Small host I/O calls the disk side needs besides reads and disk ops
 * (integration addition, DESIGN §j.3 / §j.4): config-dir listing and removal
 * (settings sync), side-file listing and removal (snapshot retention).
 */
export type HostIoOp =
	| { readonly t: "configList"; readonly dir: string }
	| { readonly t: "configRemove"; readonly path: string }
	| { readonly t: "sideFileList"; readonly prefix: "snapshots/" }
	| { readonly t: "sideFileRemove"; readonly name: SideFileName };

export type HostIoResult =
	| { readonly t: "configListing"; readonly entries: readonly { readonly path: string; readonly size: number; readonly mtimeMs: number; readonly isFolder: boolean }[] }
	| { readonly t: "sideFiles"; readonly names: readonly SideFileName[] }
	| { readonly t: "done" };

export interface BindInfo {
	readonly docId: DocId;
	readonly kind: DocKind;
	/** Y.encodeStateAsUpdate of the worker replica. [T] */
	readonly state: Uint8Array;
	/** Y.encodeStateVector of the worker replica. [T] */
	readonly stateVector: Uint8Array;
	/** Synced base text for the bind-time merge; null = no base. */
	readonly baseText: string | null;
	readonly baseHash: ContentHash | null;
	/** Doc is frozen by the ingest gate: bind read-only, show banner. */
	readonly frozen: boolean;
}

/** Why a local recovery snapshot was taken (DESIGN §j.4). */
export type SnapshotReason = "daily" | "brake" | "epoch" | "idb" | "restore" | "manual";

/** One local snapshot (listSnapshots). `bytes` = sum of the file sizes inside, not the zip size. */
export interface SnapshotSummary {
	readonly id: string;
	readonly createdAtMs: number;
	readonly reason: SnapshotReason;
	readonly files: number;
	readonly bytes: number;
}

/** A file inside a snapshot (snapshotFiles). */
export interface SnapshotFileEntry {
	readonly path: VaultPath;
	readonly kind: DocKind;
	readonly size: number;
}

/** A file the snapshot does not contain although it was in the vault when it was taken. */
export interface SnapshotSkippedEntry {
	readonly path: VaultPath;
	readonly reason: "too-large" | "unreadable";
}

/**
 * User commands. The snapshot commands, createSnapshot and exportDiagnostics fail with `not-ready`
 * while the engine has no running vault runtime (instead of answering an empty or `ok` result).
 */
export type UserCommand =
	| { readonly t: "pause" }
	| { readonly t: "resume" }
	| { readonly t: "reconcileNow" }
	| { readonly t: "approveBrake"; readonly brakeId: string }
	| { readonly t: "rejectBrake"; readonly brakeId: string }
	| { readonly t: "createSnapshot" }
	| { readonly t: "listSnapshots" }
	/** -> `snapshotFiles`. Unknown id: `bad-request`. */
	| { readonly t: "snapshotFiles"; readonly snapshotId: string }
	/** -> `restored`. paths null = every file in the snapshot. A "restore" snapshot is taken first. */
	| { readonly t: "restoreSnapshot"; readonly snapshotId: string; readonly paths: readonly VaultPath[] | null }
	/** -> `ok`. Unknown id: `bad-request`. */
	| { readonly t: "deleteSnapshot"; readonly snapshotId: string }
	/** -> `diagnostics`. includePaths: the user opted in to file names (DiagnosticsBundle.paths). */
	| { readonly t: "exportDiagnostics"; readonly includePaths: boolean }
	| { readonly t: "rebuildLocalCache" }
	| { readonly t: "updateSettings"; readonly settings: EngineSettings }
	| { readonly t: "releaseQuarantine"; readonly stream: string };

// ---------------------------------------------------------------------------
// Main -> Engine
// ---------------------------------------------------------------------------

export type MainToEngine =
	| { readonly t: "init"; readonly rid: RequestId; readonly config: EngineInitConfig }
	| { readonly t: "shutdown"; readonly rid: RequestId; readonly reason: "unload" | "restart" | "epoch-switch" }
	| { readonly t: "lifecycle"; readonly event: LifecycleEvent }
	| { readonly t: "ping"; readonly rid: RequestId }
	/** Full listing (complete=true on the last chunk) or incremental re-stats. */
	| { readonly t: "observations"; readonly rid: RequestId; readonly scanId: number; readonly chunk: readonly LocalObservation[]; readonly complete: boolean }
	/** Batched vault events (hints), <= 50 ms or 256 events per message. */
	| { readonly t: "vaultEvents"; readonly events: readonly VaultEvent[] }
	| { readonly t: "openDoc"; readonly rid: RequestId; readonly path: VaultPath; readonly viewId: number }
	| { readonly t: "closeDoc"; readonly docId: DocId; readonly viewId: number }
	/** Main replica update (editor or main-side merge), coalesced <= 16 ms. Never dropped. [T] */
	| { readonly t: "localUpdate"; readonly docId: DocId; readonly update: Uint8Array; readonly origin: "editor" | "merge" }
	/** Main replica delta after (re)bind: Y.encodeStateAsUpdate(mainDoc, BindInfo.stateVector). [T] */
	| { readonly t: "bindDelta"; readonly docId: DocId; readonly update: Uint8Array }
	/** Obsidian saved a bound view: new synced base (persisted lazily). */
	| { readonly t: "boundSaved"; readonly docId: DocId; readonly path: VaultPath; readonly text: string; readonly fingerprint: DiskFingerprint; readonly stat: VaultStat }
	/** Bound-view external change was merged on main; conflict copy (if any) already requested. */
	| { readonly t: "boundExternalMerged"; readonly docId: DocId; readonly result: "identical" | "disk-only" | "clean" | "conflict"; readonly conflictReason: ConflictReason | null }
	| { readonly t: "docCredit"; readonly bytes: number }
	| { readonly t: "result"; readonly re: RequestId; readonly value: MainResultValue }
	| { readonly t: "error"; readonly re: RequestId; readonly error: ProtocolError }
	| { readonly t: "command"; readonly rid: RequestId; readonly command: UserCommand };

/** Answers to engine->main requests. */
export type MainResultValue =
	| { readonly t: "reads"; readonly results: readonly DiskReadResult[] }
	| { readonly t: "diskOps"; readonly results: readonly DiskOpResult[] }
	| { readonly t: "sideFileWritten" }
	| { readonly t: "sideFile"; readonly bytes: Uint8Array | null /* [T] */ }
	| { readonly t: "viewSaved"; readonly saved: readonly DocId[] }
	| { readonly t: "hostIo"; readonly result: HostIoResult };

// ---------------------------------------------------------------------------
// Engine -> Main
// ---------------------------------------------------------------------------

export type EngineToMain =
	| { readonly t: "result"; readonly re: RequestId; readonly value: EngineResultValue }
	| { readonly t: "error"; readonly re: RequestId; readonly error: ProtocolError }
	/** Remote/merge/provisional update for a bound doc, FIFO per doc, within the docCredit window. [T] */
	| { readonly t: "docUpdate"; readonly docId: DocId; readonly update: Uint8Array; readonly origin: DocUpdateOrigin }
	/** Doc identity changed under a bound view (merged alias, remote rename, delete, freeze). */
	| { readonly t: "docRetarget"; readonly docId: DocId; readonly change: { readonly t: "renamed"; readonly path: VaultPath } | { readonly t: "merged"; readonly into: DocId } | { readonly t: "deleted" } | { readonly t: "frozen"; readonly reason: string } }
	/** A path became bindable (e.g. its create was planned): host retries openDoc for open views. */
	| { readonly t: "bindable"; readonly path: VaultPath }
	| { readonly t: "readRequest"; readonly rid: RequestId; readonly reads: readonly DiskReadRequest[] }
	/** Executed in order; an op whose precondition fails does not stop independent later ops. */
	| { readonly t: "diskOps"; readonly rid: RequestId; readonly lane: Lane; readonly ops: readonly DiskOp[] }
	/** Ask the host to save bound views now (after remote updates, before hidden). */
	| { readonly t: "saveViews"; readonly rid: RequestId; readonly docIds: readonly DocId[] }
	| { readonly t: "sideFileWrite"; readonly rid: RequestId; readonly name: SideFileName; readonly bytes: Uint8Array /* [T] */ }
	| { readonly t: "sideFileRead"; readonly rid: RequestId; readonly name: SideFileName }
	| { readonly t: "hostIo"; readonly rid: RequestId; readonly op: HostIoOp }
	| { readonly t: "status"; readonly status: StatusSnapshot }
	| { readonly t: "brake"; readonly report: BrakeReport }
	| { readonly t: "notice"; readonly level: "info" | "warn" | "error"; readonly code: string; readonly message: string }
	/** Engine cannot continue (version mismatch, storage unusable after retries). */
	| { readonly t: "fatal"; readonly error: ProtocolError };

export type EngineResultValue =
	| { readonly t: "ready"; readonly protocolVersion: number; readonly vaultEpoch: VaultEpoch | null; readonly recovered: boolean }
	| { readonly t: "ok" }
	| { readonly t: "pong" }
	| { readonly t: "bind"; readonly bind: BindInfo }
	/** openDoc on an untracked path (excluded, not yet created, oversize). */
	| { readonly t: "notBindable"; readonly reason: "excluded" | "untracked" | "oversize" | "not-markdown" }
	/** listSnapshots, oldest first (ids sort by time). */
	| { readonly t: "snapshots"; readonly snapshots: readonly SnapshotSummary[] }
	| { readonly t: "snapshotFiles"; readonly snapshotId: string; readonly files: readonly SnapshotFileEntry[]; readonly skipped: readonly SnapshotSkippedEntry[] }
	/**
	 * restoreSnapshot: counts of files written back and of files already identical, the conflict copies made of
	 * differing current files, and the paths that could not be restored (changed during the restore, unreadable,
	 * or damaged in the snapshot).
	 */
	| { readonly t: "restored"; readonly restored: number; readonly unchanged: number; readonly copies: readonly VaultPath[]; readonly failed: readonly VaultPath[] }
	| { readonly t: "diagnostics"; readonly bundle: DiagnosticsBundle };

/** Priority lanes (DESIGN §i.1); also tags disk batches so the host executes higher lanes first. */
export type Lane = 0 | 1 | 2 | 3 | 4;
export const LANE = {
	openNote: 0,
	openCatchUp: 1,
	namespace: 2,
	background: 3,
	bulk: 4,
} as const;
