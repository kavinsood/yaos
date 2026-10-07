/**
 * LogEngine options and tuning (DESIGN §i). Tests shrink the timers; the
 * defaults are the DESIGN values.
 */

import { BLOB_QUARANTINE_MIN_MS, BUDGETS, LOCAL_COMPACT_BYTES, LOCAL_COMPACT_ROWS, OUTBOX_MIRROR_DEBOUNCE_MS, PROVISIONAL_ADOPT_MS, RECONNECT_BASE_MS, ROLL_OWN_SEALS, ROLL_SEQ_SPAN, type Budgets, type DeviceClass } from "../../core/limits";
import type { ContentHash, DeviceId, DocId, VaultEpoch, VaultId } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { SideFilePort } from "../../ports/vault";
import type { FrameNoFloor } from "../store/repo";
import type { DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import { DEFAULT_CHECKPOINT_TUNING, type CheckpointTuning } from "../body/checkpoints";
import type { TextChanges } from "../body/textChanges";
import type { CfgFoldEvent } from "../../core/cfg/fold";
import { NS_CANDIDATE_MODULUS, type FoldedNsFrame } from "../sync/nsRuntime";
import { BLOB_RETRY_BASE_MS, BLOB_RETRY_MAX_MS } from "../blobs/blobQueue";
import type { EngineE2ee } from "../keyring/keyringRuntime";

export interface EngineTuning {
	/** Local compaction trigger (DESIGN §d.8). */
	readonly compactRows: number;
	readonly compactBytes: number;
	readonly checkpoint: CheckpointTuning;
	/** Adoptable -> pending after this long without commit / drop (DESIGN §d.5). */
	readonly provisionalAdoptMs: number;
	/** Causal hole: re-read every causalRetryMs, freeze after causalRetries re-reads (DESIGN §d.6). */
	readonly causalRetryMs: number;
	readonly causalRetries: number;
	/** Cursor gap / head-ahead threshold before a gap feed (DESIGN §d.7). */
	readonly gapMs: number;
	/** Live queue overflow: drop payloads of non-resident streams (they turn stale). */
	readonly liveQueueMaxBytes: number;
	readonly liveQueueMaxRows: number;
	/** Rows per tLive batch. */
	readonly liveBatchRows: number;
	readonly statusIntervalMs: number;
	readonly mirrorDebounceMs: number;
	readonly maintenanceMs: number;
	/** Backoff after a failed / aborted stream read. */
	readonly readBackoffMs: number;
	/** Streams per batched catch-up read (also capped by the relay's readBatchStreams); 1 = single reads only. */
	readonly readBatchStreams: number;
	readonly reconnectBaseMs: number;
	/** Multiplier on the open-frame idle / max timers (tests shrink it). */
	readonly frameStretch: number;
	readonly nsCandidateModulus: number;
	/** Gate bound on checkpoint state bytes (the relay cap is on the sealed checkpoint). */
	readonly maxCheckpointStateBytes: number;
	/** appendBlobChunks gives up (false) after this long without every receipt. */
	readonly blobAppendTimeoutMs: number;
	/** Unresolved bodyUpdateRef rows: retried after refRetryMs, doubling up to refRetryMaxMs (e2ee-design §10.2). */
	readonly refRetryMs: number;
	readonly refRetryMaxMs: number;
	/** §10.2 quarantine: a ref row's deterministic failures must span at least this long (BLOB_QUARANTINE_MIN_MS). */
	readonly blobQuarantineMinMs: number;
	/** Roll trigger (e2ee-design §4.2); tests shrink them. */
	readonly rollSeqSpan: number;
	readonly rollOwnSeals: number;
	/**
	 * Blob GC grace (e2ee-design §10.4): a sweep deletes an unreferenced blob only if it was uploaded more than this
	 * long before the cutoff; a device re-uses (R2) or references (R3) a stored blob without re-uploading it only
	 * while its own upload is younger than half of it.
	 */
	readonly blobGcGraceMs: number;
}

export const DEFAULT_TUNING: EngineTuning = {
	compactRows: LOCAL_COMPACT_ROWS,
	compactBytes: LOCAL_COMPACT_BYTES,
	checkpoint: DEFAULT_CHECKPOINT_TUNING,
	provisionalAdoptMs: PROVISIONAL_ADOPT_MS,
	causalRetryMs: 60_000,
	causalRetries: 3,
	gapMs: 5_000,
	liveQueueMaxBytes: 4 * 1024 * 1024,
	liveQueueMaxRows: 1_000,
	liveBatchRows: 256,
	statusIntervalMs: 250,
	mirrorDebounceMs: OUTBOX_MIRROR_DEBOUNCE_MS,
	maintenanceMs: 1_000,
	readBackoffMs: 5_000,
	readBatchStreams: 128,
	reconnectBaseMs: RECONNECT_BASE_MS,
	frameStretch: 1,
	nsCandidateModulus: NS_CANDIDATE_MODULUS,
	maxCheckpointStateBytes: 32 * 1024 * 1024,
	blobAppendTimeoutMs: 120_000,
	refRetryMs: BLOB_RETRY_BASE_MS,
	refRetryMaxMs: BLOB_RETRY_MAX_MS,
	blobQuarantineMinMs: BLOB_QUARANTINE_MIN_MS,
	rollSeqSpan: ROLL_SEQ_SPAN,
	rollOwnSeals: ROLL_OWN_SEALS,
	blobGcGraceMs: 7 * 24 * 60 * 60_000,
};

/** Why a bound body's text changed: "editor" = applyEditorChanges, "merge" = an engine merge (editDoc, mergeJob). */
export type BoundTextOrigin = "remote" | "provisional" | "merge" | "editor";

export interface EngineOptions {
	readonly ports: EnginePorts;
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
	readonly deviceClass?: DeviceClass;
	readonly clientVersion: string;
	/**
	 * The suite pin and keyring inputs (e2ee-design §12.4, §18.4). Required, with no default. Only a pinned device
	 * whose gate opened runs a LogEngine (compose/pinGate.ts); an unpinned one runs the KeyReader and has none.
	 */
	readonly e2ee: EngineE2ee;
	/** Known epoch: open the DB before connecting (offline start). Without it the first connect decides. */
	readonly vaultEpoch?: VaultEpoch;
	/** Outbox mirror (DESIGN §e.4); null/absent = no mirror. */
	readonly sideFiles?: SideFilePort | null;
	/** Highest own ns / cfg frameNo of the abandoned epoch (DESIGN §c.12 step 3, e2ee-design §8.2); written to meta. */
	readonly frameNoFloor?: FrameNoFloor | null;
	/** Apply + adopt other devices' provisional frames on bound docs (DESIGN §d.5). Default true. */
	readonly provisionalBroadcast?: boolean;
	readonly tuning?: Partial<EngineTuning>;
	readonly budgets?: Partial<Budgets>;
	/** Default true. false = connect once; reconnect() only. */
	readonly autoReconnect?: boolean;
	/**
	 * A bound body's text changed (any origin), as CodeMirror ChangeSet JSON over the text before (textChanges.ts);
	 * `length` = text length after. Synchronous, inside the Yjs transaction's observer phase (DESIGN §d.3).
	 */
	onBoundText?(docId: DocId, changes: TextChanges, length: number, origin: BoundTextOrigin): void;
	/**
	 * A bound doc's open frame was taken for T_edit (everything applied so far is in it or in earlier frames).
	 * The returned callback runs once that T_edit committed (true) or failed (false).
	 */
	onFrameTaken?(docId: DocId): ((ok: boolean) => void) | undefined;
	/** A doc stream was frozen (DESIGN §d.6; protocol docRetarget{frozen}): the host unbinds and re-opens read-only. */
	onDocFrozen?(docId: DocId, reason: string): void;
	/**
	 * Committed ns frames just folded, in seq order (called after the fold advanced and held records were
	 * reconciled). reloaded = the fold was rebuilt from a new snapshot (remote checkpoint adoption, boot):
	 * frames covered by the snapshot are not reported, re-read nsView().
	 */
	onNsFold?(folded: readonly FoldedNsFrame[], reloaded: boolean): void;
	/** Events of committed cfg frames just folded (reloaded: as onNsFold; re-read cfgView()). */
	onCfgFold?(events: readonly CfgFoldEvent[], reloaded: boolean): void;
	/**
	 * Docs whose body changed from outside this engine's own edits: committed
	 * rows of other devices stored (bodyVersion.remoteSeq moved, resident or
	 * not), a body checkpoint adopted by a read, a provisional update applied
	 * (and adopted), and a catch-up read that completed (the body became caught
	 * up, even from own rows only). Fires after the change is durable / applied;
	 * onBoundText still fires for bound docs.
	 */
	onBodyChange?(docIds: readonly DocId[]): void;
	/** The last own body / canvas record of these docs left the outbox (receipt): own edits are all sequenced. */
	onOwnBodySettled?(docIds: readonly DocId[]): void;
	onStatus?(status: StatusSnapshot): void;
	onDiag?(event: DiagnosticsEvent): void;
	/** A popup for the user (status notices stay in onStatus): the daily-limit warning. */
	onHostNotice?(level: "warn", code: string, message: string): void;
	/**
	 * Plaintext of a blob this device holds locally (an attachment, an own snapshot part), checked against `hash`;
	 * null = not here. Re-uploads before a stale reference is sent (e2ee-design §10.4 R3) and after a GC sweep (R4).
	 */
	blobBytes?(hash: ContentHash): Promise<Uint8Array | null>;
}

export function resolveTuning(t: Partial<EngineTuning> | undefined): EngineTuning {
	return { ...DEFAULT_TUNING, ...(t ?? {}), checkpoint: { ...DEFAULT_CHECKPOINT_TUNING, ...(t?.checkpoint ?? {}) } };
}

export function resolveBudgets(cls: DeviceClass, b: Partial<Budgets> | undefined): Budgets {
	return { ...BUDGETS[cls], ...(b ?? {}) };
}
