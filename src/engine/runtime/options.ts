/**
 * LogEngine options and tuning (DESIGN §i). Tests shrink the timers; the
 * defaults are the DESIGN values.
 */

import { BLOB_QUARANTINE_MIN_MS, BUDGETS, TOMBSTONE_CAP, TOMBSTONE_PRUNE_HYSTERESIS, MAINTENANCE_IDLE_MAX_MS, LOCAL_COMPACT_BYTES, RECENT_UNBOUND_KEEP, RECENT_UNBOUND_MS, SKIP_DEFER, SUBSCRIBE_DEBOUNCE_MS, type SkipDefer, LOCAL_COMPACT_ROWS, OUTBOX_MIRROR_DEBOUNCE_MS, PROVISIONAL_ADOPT_MS, RECONNECT_BASE_MS, ROLL_OWN_SEALS, ROLL_SEQ_SPAN, type Budgets, type DeviceClass } from "../../core/limits";
import type { ContentHash, DeviceId, DocId, VaultEpoch, VaultId } from "../../core/types";
import type { EnginePorts } from "../../ports";
import type { BlobPort } from "../../ports/blob";
import type { SideFilePort } from "../../ports/vault";
import type { MetaDocDeletes, MetaInherit, MetaPathBase, MetaPathMove } from "../store/schema";
import type { DiagnosticsEvent, StatusSnapshot } from "../../protocol/status";
import { DEFAULT_CHECKPOINT_TUNING, type CheckpointTuning } from "../body/checkpoints";
import type { TextChanges } from "../body/textChanges";
import type { CfgFoldEvent } from "../../core/cfg/fold";
import { NS_CANDIDATE_MODULUS, type FoldedNsFrame } from "../sync/nsRuntime";
import { BLOB_RETRY_BASE_MS, BLOB_RETRY_MAX_MS } from "../blobs/blobQueue";
import type { EngineE2ee } from "../keyring/keyringRuntime";
import { KNOWN_RULES, type KnownRules } from "../ingest/gate";

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
	/** Idle maintenance: the tick interval doubles while nothing is pending, up to this (maintenance.ts). */
	readonly maintenanceIdleMaxMs: number;
	/** Backoff after a failed / aborted stream read. */
	readonly readBackoffMs: number;
	/** Streams per batched catch-up read (also capped by the relay's readBatchStreams); 1 = single reads only. */
	readonly readBatchStreams: number;
	readonly reconnectBaseMs: number;
	/** Multiplier on the open-frame idle / max timers (tests shrink it). */
	readonly frameStretch: number;
	readonly nsCandidateModulus: number;
	/**
	 * FOLD: the ns tombstone cap and prune hysteresis (DESIGN §c.9). Every device of a vault must fold with the same
	 * values, or their folds diverge at the first prune. Production never passes engine tuning (adapters/webEngine.ts
	 * builds the engine without it), so every device runs TOMBSTONE_CAP / TOMBSTONE_PRUNE_HYSTERESIS; the sim sets a
	 * small cap uniformly per run (run.ts pruneWorld: every device and the oracle), never per device.
	 */
	readonly nsPrune: NsPruneRules;
	/** Gate bound on checkpoint state bytes (the relay cap is on the sealed checkpoint). */
	readonly maxCheckpointStateBytes: number;
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
	/** Fold rules this reader implements (DESIGN §c.10); tests raise them to play an upgraded client. */
	readonly knownRules: KnownRules;
	/** Subscription set changes are debounced this long (DESIGN §d.7). */
	readonly subscribeDebounceMs: number;
	/** Recently unbound docs kept subscribed: how many, and for how long after the unbind. */
	readonly recentUnboundKeep: number;
	readonly recentUnboundMs: number;
	/**
	 * Deferred read of a stream made stale by skipped rows (core/limits SKIP_DEFER); null = the device class's value.
	 * 0 reads at once (tests that wait for quiescence).
	 */
	readonly skipSettleMs: number | null;
	readonly skipMaxDeferMs: number | null;
	/**
	 * Predecessor recovery without the fence (identity-per-store §5.2 "Without the fence"): the commit check of the
	 * inherited ns / cfg frames waits this long after the runtime started, past the relay's hold cap
	 * (STREAM_HOLD_MAX_MS, 5 s) for a frame of the dead store still in its buffer.
	 */
	readonly inheritUnfencedWaitMs: number;
	/**
	 * Abandoned creates (DESIGN §i.5): a live doc with no body whose creator the server reports retired is dropped
	 * (and its file, where one is held, re-created) once the creator has read retired this long. A successor store
	 * that fenced its predecessor re-issues the predecessor's mirrored frames as soon as it connects, so a body on
	 * its way still lands first.
	 */
	readonly abandonedCreateGraceMs: number;
	/** How long a creator that read live is not asked about again (doubling per live answer, compose/creatorStatus.ts). */
	readonly creatorStatusRecheckMs: number;
	/** The cap of that doubling. */
	readonly creatorStatusRecheckMaxMs: number;
}

/** FOLD tunables of the ns prune (core/ns/fold NsFoldRules). */
export interface NsPruneRules {
	readonly tombstoneCap: number;
	readonly pruneHysteresis: number;
	/** Pruned-entry stubs kept (PRUNED_STUB_CAP when absent). */
	readonly prunedCap?: number;
}

export const DEFAULT_NS_PRUNE: NsPruneRules = { tombstoneCap: TOMBSTONE_CAP, pruneHysteresis: TOMBSTONE_PRUNE_HYSTERESIS };

/**
 * DESIGN §d.6: the causal-hole re-read window (causalRetries x causalRetryMs) must be at least 2 x provisionalAdoptMs,
 * because the missing structs may be a provisional adoption still in flight. Returns why a tuning breaks it, or null.
 */
export function causalWindowProblem(t: Pick<EngineTuning, "causalRetryMs" | "causalRetries" | "provisionalAdoptMs">): string | null {
	const window = t.causalRetryMs * t.causalRetries;
	return window >= 2 * t.provisionalAdoptMs ? null : `causal re-read window ${t.causalRetries} x ${t.causalRetryMs} ms < 2 x provisionalAdoptMs ${t.provisionalAdoptMs} ms (DESIGN §d.6)`;
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
	maintenanceIdleMaxMs: MAINTENANCE_IDLE_MAX_MS,
	readBackoffMs: 5_000,
	readBatchStreams: 128,
	reconnectBaseMs: RECONNECT_BASE_MS,
	frameStretch: 1,
	nsCandidateModulus: NS_CANDIDATE_MODULUS,
	nsPrune: DEFAULT_NS_PRUNE,
	maxCheckpointStateBytes: 32 * 1024 * 1024,
	refRetryMs: BLOB_RETRY_BASE_MS,
	refRetryMaxMs: BLOB_RETRY_MAX_MS,
	blobQuarantineMinMs: BLOB_QUARANTINE_MIN_MS,
	rollSeqSpan: ROLL_SEQ_SPAN,
	rollOwnSeals: ROLL_OWN_SEALS,
	blobGcGraceMs: 7 * 24 * 60 * 60_000,
	inheritUnfencedWaitMs: 10_000,
	abandonedCreateGraceMs: 30_000,
	creatorStatusRecheckMs: 5 * 60_000,
	creatorStatusRecheckMaxMs: 60 * 60_000,
	knownRules: KNOWN_RULES,
	subscribeDebounceMs: SUBSCRIBE_DEBOUNCE_MS,
	recentUnboundKeep: RECENT_UNBOUND_KEEP,
	recentUnboundMs: RECENT_UNBOUND_MS,
	skipSettleMs: null,
	skipMaxDeferMs: null,
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
	 * The store (identity-per-store §2.4): the install key the DB is named by and the identity secrets a fresh DB
	 * records in meta.identity. `beforeCreate` runs right before a fresh DB is created (the composed engine consumes
	 * the pending identity there, storeIdentity.ts). Absent (engine tests): the DB is named by the deviceId.
	 */
	readonly store?: {
		readonly installKey: string;
		/** SECRET. */
		readonly deviceToken: string;
		/** SECRET. */
		readonly retireKey: string;
		readonly beforeCreate?: () => Promise<void>;
	};
	/**
	 * This install's earlier stores (identity-per-store §2.4 lineage, §5.2 `lostCreateBody`): a live doc one of them
	 * created whose initial body never reached the relay is this store's to upload, as its own create's would be. The
	 * earlier store is gone from this install (its DB was lost or reset), and nobody else has the file. Never a
	 * clone's twin: a clone has its own install record. Absent: none.
	 */
	readonly lineage?: ReadonlySet<DeviceId>;
	/**
	 * Predecessor recovery (identity-per-store §5.2), for a store this start creates: the lineage stores, newest first,
	 * whose mirrors the new store adopts (the newest dir with a valid outbox mirror), and whether the newest was fenced.
	 * Recorded with the new store's identity (MetaIdentity.inherit) and run at boot (again after a crash before the
	 * import committed); ignored for a store that already exists.
	 */
	readonly inherit?: MetaInherit | null;
	/** The stores a store this start creates replaces (MetaIdentity.supersedes); ignored for one that exists. */
	readonly supersedes?: readonly DeviceId[] | null;
	/** A lineage store's side files, `state/<deviceId>/` (recovery reads them; VaultRuntime removes them once replaced). */
	readonly lineageSideFiles?: (deviceId: DeviceId) => SideFilePort;
	/**
	 * The suite pin and keyring inputs (e2ee-design §12.4, §18.4). Required, with no default. Only a pinned device
	 * whose gate opened runs a LogEngine (compose/pinGate.ts); an unpinned one runs the KeyReader and has none.
	 */
	readonly e2ee: EngineE2ee;
	/** Known epoch: open the DB before connecting (offline start). Without it the first connect decides. */
	readonly vaultEpoch?: VaultEpoch;
	/** Outbox mirror (DESIGN §e.4); null/absent = no mirror. */
	readonly sideFiles?: SideFilePort | null;
	/** The abandoned epoch's bases by path (DESIGN §c.12 step 3); written to meta with the DB's identity. */
	readonly pathBases?: readonly MetaPathBase[] | null;
	/** The abandoned epoch's docs' deletes by docId (DESIGN §c.12 "Deletes"); written to meta with the identity. */
	readonly docDeletes?: readonly MetaDocDeletes[] | null;
	/** The abandoned epoch's unpublished renames (DESIGN §c.12 "Renames"); written to meta with the identity. */
	readonly pathMoves?: readonly MetaPathMove[] | null;
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
	/** A popup for the user (status notices stay in onStatus): the daily-limit warning, a vault-side upgrade. */
	onHostNotice?(level: "warn" | "error", code: string, message: string): void;
	/**
	 * Plaintext of a blob this device holds locally (an attachment, an own snapshot part), checked against `hash`;
	 * null = not here. Re-uploads before a stale reference is sent (e2ee-design §10.4 R3) and after a GC sweep (R4).
	 */
	blobBytes?(hash: ContentHash): Promise<Uint8Array | null>;
	/**
	 * Started without a blob store (ports.blob null) and EnginePorts.probeBlob found one on a later connect: the owner
	 * restarts the runtime on ports with that store (a BlobPort is fixed for a runtime's life).
	 */
	onBlobStore?(store: BlobPort): void;
}

export function resolveTuning(t: Partial<EngineTuning> | undefined): EngineTuning {
	return { ...DEFAULT_TUNING, ...(t ?? {}), checkpoint: { ...DEFAULT_CHECKPOINT_TUNING, ...(t?.checkpoint ?? {}) } };
}

/** The deferral window of skipped streams: the tuning's values, else the device class's (SKIP_DEFER). */
export function resolveSkipDefer(cls: DeviceClass, t: EngineTuning): SkipDefer {
	return { settleMs: t.skipSettleMs ?? SKIP_DEFER[cls].settleMs, maxDeferMs: t.skipMaxDeferMs ?? SKIP_DEFER[cls].maxDeferMs };
}

export function resolveBudgets(cls: DeviceClass, b: Partial<Budgets> | undefined): Budgets {
	return { ...BUDGETS[cls], ...(b ?? {}) };
}
