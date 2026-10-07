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
	DeviceId, DocId, DocKind, VaultEpoch, VaultId, VaultPath, BrakeReport,
} from "../core/types";
import type { DeviceClass } from "../core/limits";
import type { PlatformInfo, LifecycleEvent } from "../ports/platform";
import type { VaultEvent, VaultStat, WritePrecondition, WriteOutcome, RenameOutcome, TrashMode, SideFileName } from "../ports/vault";
import type { ProtocolError } from "./errors";
import type { StatusSnapshot, DiagnosticsBundle } from "./status";

export const PROTOCOL_VERSION = 3;

export type RequestId = number;

// ---------------------------------------------------------------------------
// Shared payloads
// ---------------------------------------------------------------------------

export interface EngineSettings {
	readonly excludePatterns: readonly string[];
	readonly syncAttachments: boolean;
	readonly maxAttachmentBytes: number;
	readonly syncSettings: boolean;
	/**
	 * The user's answer when turning syncSettings on (DESIGN §j.3): "device" = on this device's first settings pass
	 * (empty cfgBase), its own values win over the vault's. Absent = "vault".
	 */
	readonly syncSettingsSeed?: "device" | "vault";
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
	/** SECRET (keys): never logged or echoed. Buffers are transferred, and main keeps no copy (e2ee-design §6.3). */
	readonly crypto:
		| { readonly suite: null; readonly creating: boolean } // unpinned (§12.4): reads `k` only, writes nothing
		| { readonly suite: 0 }
		| { readonly suite: 1; readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; readonly records: readonly Uint8Array[] };
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

/** Why a bound doc's worker replica changed (not by the view's own push). */
export type DocUpdateOrigin = "remote" | "provisional" | "merge" | "editor";

/**
 * A change to a bound body, in CodeMirror ChangeSet JSON (ChangeSet.toJSON, @codemirror/state): a number keeps
 * that many UTF-16 units; [n] deletes n; [n, ...lines] replaces n units with the lines joined by "\n" (DESIGN §d.3).
 * Both sides split and join on "\n" only, so a "\r" is one ordinary unit and lengths match Y.Text exactly.
 */
export type BodyChanges = readonly (number | readonly [number, ...string[]])[];

/**
 * Per-doc body events, FIFO per doc, within the docCredit window (DESIGN §d.3). Versions count the worker
 * replica's changes since the doc was bound; every view of the doc sees every event in order.
 *  - entry: the replica went from version `from` to `to` = from + 1 by `changes`. `author` is the view whose
 *    bodyPush it is (that view confirms instead of applying); null for remote / provisional / merge changes.
 *    `length` = replica length after (UTF-16 units): an O(1) divergence check on main.
 *  - bound: the bodyAttach of view `viewId` whose editor upload is `attach` was merged at `version`: `changes`
 *    turn the uploaded editor text into the replica text (length `length`). Events before it are inside for that view.
 *  - reject: the bodyPush `seq` of `viewId` did not fit (an older base, or chained after a push that is not the
 *    newest change); every entry it missed is before it.
 *  - durable: every change up to `version` is in committed storage (the restart merge base, §d.3).
 *  - reloaded: the bodyReload `reload` of `viewId` is merged (its entry, if any, is before it); `save` = the
 *    replica differs from the reloaded text, so the view should save.
 */
export type BodyEvent =
	| { readonly t: "entry"; readonly from: number; readonly to: number; readonly changes: BodyChanges; readonly length: number; readonly origin: DocUpdateOrigin; readonly author: { readonly viewId: number; readonly seq: number } | null }
	| { readonly t: "bound"; readonly viewId: number; readonly attach: number; readonly version: number; readonly changes: BodyChanges; readonly length: number }
	| { readonly t: "reject"; readonly viewId: number; readonly seq: number; readonly version: number }
	| { readonly t: "durable"; readonly version: number }
	| { readonly t: "reloaded"; readonly viewId: number; readonly reload: number; readonly save: boolean };

/** A hash the host asks the engine for (main never hashes, DESIGN §d.2). */
export type HashWant = "fingerprint" | "contentHash";

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

/** openDoc answer. The host then uploads the editor text and sends bodyAttach (DESIGN §d.3). */
export interface BindInfo {
	readonly docId: DocId;
	readonly kind: DocKind;
	/** Doc is frozen by the ingest gate: bind read-only, show banner. */
	readonly frozen: boolean;
}

/** Why a local recovery snapshot was taken (DESIGN §j.4). */
export type SnapshotReason = "daily" | "brake" | "epoch" | "idb" | "restore" | "manual";

/** One snapshot (listSnapshots). `bytes` = sum of the file sizes inside, not the zip size. */
export interface SnapshotSummary {
	readonly id: string;
	readonly createdAtMs: number;
	readonly reason: SnapshotReason;
	readonly files: number;
	readonly bytes: number;
	/** On this device, in the blob store (uploaded by any device), or both. Absent = local. */
	readonly where?: "local" | "remote" | "both";
	/** Label of the device that took a remote snapshot. */
	readonly device?: string;
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
	/** invalid: would not pass restore verification (bad path, markdown not UTF-8, canvas that does not parse). */
	readonly reason: "too-large" | "unreadable" | "invalid";
}

/**
 * User commands. The snapshot commands, createSnapshot, exportDiagnostics and cleanUpAttachments fail with `not-ready`
 * while the engine has no running vault runtime (instead of answering an empty or `ok` result). While the encryption
 * gate is shut (e2ee-design §12.4) cleanUpAttachments answers `attachmentsCleaned` refused "keys-unverified".
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
	| { readonly t: "releaseQuarantine"; readonly stream: string }
	// e2ee-design §18.4 (all SECRET payloads, transferred):
	| { readonly t: "enableE2ee"; readonly rk: Uint8Array } // creation path only (§15.1): genesis at head = 0
	| { readonly t: "installKey"; readonly source: "qr"; readonly e: number; readonly k: Uint8Array } // §12.1, §14.2 step 3
	| { readonly t: "installKey"; readonly source: "rk"; readonly rk: Uint8Array } // §12.4, §13.3
	| { readonly t: "pinSuite0"; readonly source: "link" | "create" } // §12.4 (ii) / (iii): ok only if `k` is empty at head
	| { readonly t: "revokeRekey"; readonly rk: Uint8Array } // §14.2; a new RK is generated on main
	/** -> `attachmentsCleaned`: one sweep of the server's unreferenced attachments (e2ee-design §10.4). */
	| { readonly t: "cleanUpAttachments" };

/** Why a clean-up deleted nothing, or ("interrupted") stopped part-way (engine/blobs/gc.ts GcRefusal). */
export type AttachmentCleanupRefusal =
	| "no-store" | "keys-unverified" | "offline" | "read-only" | "not-caught-up" | "fold-incomplete" | "body-unreadable"
	| "addressing-mismatch" | "busy" | "interrupted";

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
	/**
	 * A piece of a text upload (editor text, merge base, reload): the UTF-16 code units (platform byte order, exact
	 * for any JS string, protocol/utf16.ts), split anywhere; `last` completes upload `uploadId`. Only a bind (first
	 * open, restart, resync) and a reload Obsidian pushes into a bound view upload whole texts, never typing (DESIGN §d.3). [T]
	 */
	| { readonly t: "textChunk"; readonly uploadId: number; readonly bytes: Uint8Array; readonly last: boolean }
	/**
	 * Bind view `viewId` (after openDoc answered `bind`): merge the uploaded editor text into the replica, answered
	 * by a `bound` body event. `base` = uploaded merge base (restart / resync: the last durable text the view saw),
	 * null = the engine's synced base. `saved` = uploaded TextFileView.lastSavedData when the editor had unsaved
	 * edits, null = the editor text is what Obsidian loaded (the reload merge base).
	 */
	| { readonly t: "bodyAttach"; readonly docId: DocId; readonly viewId: number; readonly editor: number; readonly base: number | null; readonly saved: number | null }
	/**
	 * Editor changes of view `viewId`, coalesced <= 16 ms; answered by an entry or a reject. `after` = null: against
	 * replica version `base`; else chained: against the replica right after this view's push `after`, applied only
	 * while that push is the replica's newest change (so a view need not wait for each confirmation).
	 */
	| { readonly t: "bodyPush"; readonly docId: DocId; readonly viewId: number; readonly seq: number; readonly base: number; readonly after: number | null; readonly changes: BodyChanges }
	/**
	 * Obsidian pushed text into bound view `viewId` without an editor transaction (an external reload of its
	 * file, a properties edit, an unbound view's quick preview; the view holds its saves until `reloaded`):
	 * upload `text` is merged into the replica (§d.3). `reload` = the view's counter.
	 */
	| { readonly t: "bodyReload"; readonly docId: DocId; readonly viewId: number; readonly reload: number; readonly text: number }
	/**
	 * Obsidian read view `viewId` for a save while its text was the replica at `version` (after its own push
	 * `seq`, null = no push pending): the engine keeps that text as one the disk may hold (absorbed, §d.3).
	 */
	| { readonly t: "bodySaveMark"; readonly docId: DocId; readonly viewId: number; readonly version: number; readonly seq: number | null }
	/** Body event weight applied on main (returns docCredit window). */
	| { readonly t: "docCredit"; readonly bytes: number }
	/** Hash raw bytes the host read (write preconditions, config writes); answered by `hashes`. [T] */
	| { readonly t: "hashRequest"; readonly rid: RequestId; readonly items: readonly { readonly path: string; readonly want: HashWant; readonly bytes: Uint8Array /* [T] */ }[] }
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
	| { readonly t: "hostIo"; readonly result: HostIoResult }
	/** keyringChanged is stored (e2ee-design §18.4 persist-before-use). */
	| { readonly t: "keyringStored" };

// ---------------------------------------------------------------------------
// Engine -> Main
// ---------------------------------------------------------------------------

export type EngineToMain =
	| { readonly t: "result"; readonly re: RequestId; readonly value: EngineResultValue }
	| { readonly t: "error"; readonly re: RequestId; readonly error: ProtocolError }
	/** A bound doc's body event (FIFO per doc); main returns `weight` as docCredit once applied. */
	| { readonly t: "body"; readonly docId: DocId; readonly event: BodyEvent; readonly weight: number }
	/**
	 * Doc identity changed under a bound view (merged alias, remote rename, delete, freeze), or (`resync`) the
	 * engine dropped body events past 4x the credit window: the host re-binds those views.
	 */
	| { readonly t: "docRetarget"; readonly docId: DocId; readonly change: { readonly t: "renamed"; readonly path: VaultPath } | { readonly t: "merged"; readonly into: DocId } | { readonly t: "deleted" } | { readonly t: "frozen"; readonly reason: string } | { readonly t: "resync" } }
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
	/**
	 * e2ee-design §18.4: the keys and winning records main must store (SECRET); main persists before replying
	 * (`keyringStored`), and the engine seals under no new epoch until then.
	 */
	| { readonly t: "keyringChanged"; readonly rid: RequestId; readonly keys: readonly { readonly e: number; readonly k: Uint8Array }[]; // SECRET
		readonly records: readonly Uint8Array[]; readonly pending: number | null }
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
	/** hashRequest: per item, the hash asked for and the UTF-16 length of the bytes decoded with any BOM kept. */
	| { readonly t: "hashes"; readonly values: readonly { readonly hash: string; readonly textLength: number }[] }
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
	| { readonly t: "diagnostics"; readonly bundle: DiagnosticsBundle }
	/** cleanUpAttachments. keptNewer: unreferenced but uploaded within the grace; repaired / lost: deleted, then found referenced. */
	| { readonly t: "attachmentsCleaned"; readonly deleted: number; readonly keptNewer: number; readonly repaired: number; readonly lost: number; readonly refused: AttachmentCleanupRefusal | null; readonly detail: string | null };

/** Priority lanes (DESIGN §i.1); also tags disk batches so the host executes higher lanes first. */
export type Lane = 0 | 1 | 2 | 3 | 4;
export const LANE = {
	openNote: 0,
	openCatchUp: 1,
	namespace: 2,
	background: 3,
	bulk: 4,
} as const;
