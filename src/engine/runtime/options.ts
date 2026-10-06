/**
 * LogEngine options and tuning (DESIGN §i). Tests shrink the timers; the
 * defaults are the DESIGN values.
 */

import { BUDGETS, LOCAL_COMPACT_BYTES, LOCAL_COMPACT_ROWS, OUTBOX_MIRROR_DEBOUNCE_MS, PROVISIONAL_ADOPT_MS, RECONNECT_BASE_MS, type Budgets, type DeviceClass } from "../../core/limits";
import type { DeviceId, DocId, VaultEpoch, VaultId } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { SideFilePort } from "../../ports/vault";
import type { DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import { DEFAULT_CHECKPOINT_TUNING, type CheckpointTuning } from "../body/checkpoints";
import type { CfgFoldEvent } from "../../core/cfg/fold";
import { NS_CANDIDATE_MODULUS, type FoldedNsFrame } from "../sync/nsRuntime";

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
};

/** Where an update forwarded to the host came from. */
export type DocUpdateOrigin = "remote" | "provisional" | "local";

export interface EngineOptions {
	readonly ports: EnginePorts;
	readonly vaultId: VaultId;
	readonly deviceId: DeviceId;
	readonly deviceClass?: DeviceClass;
	readonly clientVersion: string;
	/** Known epoch: open the DB before connecting (offline start). Without it the first connect decides. */
	readonly vaultEpoch?: VaultEpoch;
	/** Outbox mirror (DESIGN §e.4); null/absent = no mirror. */
	readonly sideFiles?: SideFilePort | null;
	/** Apply + adopt other devices' provisional frames on bound docs (DESIGN §d.5). Default true. */
	readonly provisionalBroadcast?: boolean;
	readonly tuning?: Partial<EngineTuning>;
	readonly budgets?: Partial<Budgets>;
	/** Default true. false = connect once; reconnect() only. */
	readonly autoReconnect?: boolean;
	/** Updates applied to a bound doc that the host did not author. */
	onDocUpdate?(docId: DocId, update: Uint8Array, origin: DocUpdateOrigin): void;
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
	 * onDocUpdate still fires for bound docs.
	 */
	onBodyChange?(docIds: readonly DocId[]): void;
	/** The last own body / canvas record of these docs left the outbox (receipt): own edits are all sequenced. */
	onOwnBodySettled?(docIds: readonly DocId[]): void;
	onStatus?(status: StatusSnapshot): void;
	onDiag?(event: DiagnosticsEvent): void;
}

export function resolveTuning(t: Partial<EngineTuning> | undefined): EngineTuning {
	return { ...DEFAULT_TUNING, ...(t ?? {}), checkpoint: { ...DEFAULT_CHECKPOINT_TUNING, ...(t?.checkpoint ?? {}) } };
}

export function resolveBudgets(cls: DeviceClass, b: Partial<Budgets> | undefined): Budgets {
	return { ...BUDGETS[cls], ...(b ?? {}) };
}
