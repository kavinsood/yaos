import { App, MarkdownView, Notice, TFile } from "obsidian";
import { canonicalMarkdownBytes, canonicalizeMarkdown } from "@shared/markdownCodec";
import { composeBodyOnlyProgress } from "../sync/frontmatterBoundary";
import type { BlobSyncManager } from "../sync/blobSync";
import type { DiskMirror } from "../sync/diskMirror";
import {
	type DiskIndex,
	contentBaselineHash,
	contentFingerprint,
	currentContentHash,
	filterChangedFiles,
	setCurrentContentHash,
	setPartialContentHashes,
	trustedContentHash,
} from "../sync/diskIndex";
import { mergeThreeWayText } from "../sync/threeWayMerge";
import {
	FreshAdmissionCancelledError,
	FreshAdmissionDurablyPendingError,
	type ReconcileMode,
	type VaultSync,
} from "../sync/vaultSync";
import type { VaultSyncSettings } from "../settings";
import type { RuntimeConfig } from "./runtimeConfig";
import type { EditorBindingManager } from "../sync/editorBinding";
import type {
	ProductFlightEventInput,
	ProductFlightPathEventInput,
} from "../observability/traceSink";
import { PRODUCT_EVENT_KIND } from "../observability/productEventKinds";
// PRODUCT_EVENT_KIND, not FLIGHT_KIND: the controller is product code and may
// only emit the product subset of the taxonomy (see productEventKinds.ts).
import type {
	FrontmatterIngestBlockBranch,
	RecoverySkippedFrontmatterData,
} from "../observability/recoveryEventTypes";
import {
	applyDiffToYTextWithPostcondition,
	forceReplaceYText,
	tryApplyDiffToYText,
	type DiffPostconditionResult,
} from "../sync/diff";
import { decideExternalEditImport } from "../sync/externalEditPolicy";
import { yTextToString } from "../utils/format";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
} from "../sync/origins";
import {
	computeRecoveryFingerprint,
	evaluateFingerprintQuarantine,
	findOldestFingerprintEntry,
	FINGERPRINT_MAP_MAX_SIZE,
	type FingerprintEntry,
} from "./reconcile/fingerprintQuarantinePolicy";
import {
	evaluateAmplificationQuarantine,
	findOldestAmplificationEntry,
	AMPLIFICATION_WINDOW_MS,
	type AmplificationEntry,
} from "./reconcile/amplificationQuarantinePolicy";
import {
	MarkdownAdmissionScheduler,
	type MarkdownAdmissionIntent,
} from "./markdownAdmissionScheduler";
import type { OperationOutcome } from "./operationLifecycle";

export interface ReconciliationStats {
	at: string;
	mode: ReconcileMode;
	plannedCreates: number;
	plannedUpdates: number;
	flushedCreates: number;
	flushedUpdates: number;
	safetyBrakeTriggered: boolean;
	safetyBrakeReason: string | null;
}

export interface ReconciliationState {
	reconciled: boolean;
	reconcileInFlight: boolean;
	reconcilePending: boolean;
	lastReconcileStats: ReconciliationStats | null;
	lastReconciledGeneration: number;
	untrackedFileCount: number;
	markdownAdmissionPending: number;
	markdownAdmissionOldestAgeMs: number;
	markdownAdmissionNextDeadlineAt: number | null;
	blockedDivergenceCount: number;
	lastBlockedDivergenceAt: string | null;
	/** Safe sample of blocked paths: extensions + fingerprint hashes (no raw filenames). */
	blockedDivergenceSample: Array<{ ext: string; hash: string }>;
}

import { type DiskIngestPort } from "./engineControlPort";

interface ReconciliationControllerDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	getRuntimeConfig(): RuntimeConfig;
	getVaultSync(): VaultSync | null;
	getDiskMirror(): DiskMirror | null;
	getBlobSync(): BlobSyncManager | null;
	getEditorBindings(): EditorBindingManager | null;
	getDiskIndex(): DiskIndex;
	setDiskIndex(index: DiskIndex): void;
	isMarkdownPathSyncable(path: string): boolean;
	shouldBlockFrontmatterIngest(
		path: string,
		previousContent: string | null,
		nextContent: string,
		reason: string,
	): boolean;
	refreshServerCapabilities(reason: string): Promise<void>;
	validateOpenEditorBindings(reason: string): void;
	onReconciled(reason: string): void;
	recordFlightEvent?(event: ProductFlightEventInput): void;
	recordFlightPathEvent?(event: ProductFlightPathEventInput): void;
	getAwaitingFirstProviderSyncAfterStartup(): boolean;
	setAwaitingFirstProviderSyncAfterStartup(value: boolean): void;
	saveDiskIndex(): Promise<void>;
	refreshStatusBar(): void;
	/**
	 * Returns the Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Used by planClosedFileReconcile to detect disk edits made while YAOS
	 * was inactive (missing-baseline tie-breaking). Returns 0 if never saved.
	 * Naming: getLastDiskIndexPersistedAt — this is the last save, not last
	 * plugin activity; conflating them creates false certainty.
	 */
	getLastSaveDiskIndexAt?(): number;
	/**
	 * Identity of the local state that disk-index baselines must have been
	 * established under to prove anything (see `DiskIndexEntry.baselineScope`).
	 * Absent: the host does not scope baselines and all are trusted (CLI).
	 * Returning null: the identity is unknown yet, so no baseline is trusted.
	 */
	getBaselineScope?(): string | null;
	/**
	 * A disk/body agreement was just persisted as the baseline of `path`:
	 * store its content as the body's common base, so a later divergence of
	 * both sides can three-way merge on it after a restart (best effort).
	 */
	persistCommonBase?(path: string, hash: string, content: string): void;
	trace(source: string, msg: string, details?: Record<string, unknown>): void;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
	/**
	 * Optional: override the external edit policy used inside syncFileFromDisk.
	 * Absent in production. Supplied by the QA harness to set a transient
	 * in-memory override without persisting or pushing settings metadata.
	 * When present, this callback is called with the runtime policy and may
	 * return a different value; returning null/undefined falls back to the
	 * runtime policy.
	 */
	getEffectiveExternalEditPolicy?(runtimePolicy: import("../settings").ExternalEditPolicy): import("../settings").ExternalEditPolicy | null | undefined;
	/**
	 * Optional: harness registration hook for disk-ingest control.
	 * Called once during reconciliation setup. The callback receives a
	 * control port that the QA harness can store and call to trigger
	 * syncFileFromDisk deterministically, bypassing the dirty-queue pipeline.
	 * Must not be wired in production main.ts.
	 */
	registerDiskIngestPort?(port: DiskIngestPort): void;
}

const OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200;
/**
 * Idle window for the bound-file-local-only-divergence branch.
 *
 * Distinct from OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS (1200ms, used only by
 * the crdtOnly branch). The localOnly branch is the typing-cadence amplifier
 * shape — Obsidian autosave landing keystrokes faster than the y-codemirror
 * plumbing propagates them into Y.Text. Quenching that loop requires a
 * window longer than a typical human typing burst; 3000ms is conservative.
 */
const OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS = 3000;
const BOUND_RECOVERY_LOCK_MS = 1500;
/** Coalesces a burst of remote keystrokes into one closed-note disk write. */
const REMOTE_BODY_MATERIALIZE_DEBOUNCE_MS = 300;
/** Bounded re-plans of one closed-note materialization (merge commit, disk moved). */
const REMOTE_BODY_MATERIALIZE_MAX_REPLANS = 3;
/** Session cache of baseline contents, so a three-way merge can name its base. */
const BASELINE_CONTENT_CACHE_MAX = 256;
/** Loads of an unloaded body before a disk import is planned against it. */
const SYNC_FROM_DISK_MAX_PLAN_ATTEMPTS = 2;
/** Consecutive superseded disk imports of one path before ingest gives up. */
const SYNC_FROM_DISK_MAX_REPLANS = 3;

/**
 * Closed-shape result of the binding-health predicate. `reasons` is empty
 * when `healthy === true`. The same shape is recorded in trace events so
 * future RCAs can read why the controller chose to repair (or not).
 */
interface BindingHealthResult {
	healthy: boolean;
	reasons: string[];
}

/**
 * Inspect captured binding/collab debug info and decide whether the
 * editor binding is actually broken. The localOnly recovery branch uses
 * this to skip `editorBindings.repair()` when the binding looks fine —
 * unconditional reconfigure on every recovery cycle was a contributor to
 * the typing-cadence amplifier loop.
 *
 * Healthy when ALL of:
 *   - `binding.cmMatches !== false` (the EditorView is the one we tracked)
 *   - `collab.hasSyncFacet !== false` (yCollab compartment is attached)
 *   - `collab.yTextMatchesExpected !== false` (facet points at our ytext)
 *   - `collab.awarenessMatchesProvider !== false` (awareness wired)
 *
 * Null values are treated as "not signal" — they neither confirm nor
 * deny health. They do not flip the verdict.
 *
 * If `binding` or `collab` themselves are null we fall back to "unhealthy"
 * because we have no evidence the binding is wired at all.
 */
function classifyBindingHealth(
	binding: { cmMatches: boolean | null; leafId?: string | null } | null | undefined,
	collab: {
		hasSyncFacet: boolean;
		yTextMatchesExpected: boolean | null;
		awarenessMatchesProvider: boolean | null;
	} | null | undefined,
): BindingHealthResult {
	const reasons: string[] = [];
	if (binding == null) reasons.push("missing-binding-info");
	if (collab == null) reasons.push("missing-collab-info");
	if (binding && binding.cmMatches === false) reasons.push("cm-mismatch");
	if (collab && collab.hasSyncFacet === false) reasons.push("missing-sync-facet");
	if (collab && collab.yTextMatchesExpected === false) reasons.push("ytext-mismatch");
	if (collab && collab.awarenessMatchesProvider === false) reasons.push("awareness-mismatch");
	return { healthy: reasons.length === 0, reasons };
}

function traceRecoveryPostcondition(
	trace: ReconciliationControllerDeps["trace"],
	recordFlightPathEvent: ReconciliationControllerDeps["recordFlightPathEvent"],
	path: string,
	reason: string,
	origin: string,
	expectedLength: number,
	result: DiffPostconditionResult,
): void {
	trace("recovery", "recovery-postcondition-observed", {
		path,
		reason,
		origin,
		expectedLength,
		actualLength: result.finalLength,
		matchesExpected: result.finalMatchesExpected,
		matchesAfterDiff: result.matchesAfterDiff,
		diffSkippedDueToStaleBase: result.diffSkippedDueToStaleBase,
		enforced: true,
		forceReplaceApplied: result.forceReplaceApplied,
	});
	if (result.forceReplaceApplied) {
		trace("recovery", "recovery-force-replace-applied", {
			path,
			reason,
			origin,
			expectedLength,
			actualLength: result.finalLength,
			finalMatchesExpected: result.finalMatchesExpected,
			diffSkippedDueToStaleBase: result.diffSkippedDueToStaleBase,
		});
	}
	if (!result.finalMatchesExpected) {
		trace("recovery", "recovery-postcondition-failed", {
			path,
			reason,
			origin,
			expectedLength,
			actualLength: result.finalLength,
		});
		// Also emit via typed FlightSink so the analyzer can detect it
		recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryPostconditionFailed,
			severity: "error",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				origin,
				expectedLength,
				actualLength: result.finalLength,
				forceReplaceApplied: result.forceReplaceApplied,
			},
		});
	}
}

export class ReconciliationController {
	private reconciled = false;
	private reconcileInFlight = false;
	private reconcilePending = false;
	private untrackedFiles: string[] = [];
	private lastReconciledGeneration = 0;
	private lastReconcileTime = 0;
	private reconcileCooldownTimer: number | null = null;
	private lastReconcileStats: ReconciliationStats | null = null;
	private closedOnlyDeferredImports = new Set<string>();
	private readonly markdownAdmission: MarkdownAdmissionScheduler;
	private boundRecoveryLocks = new Map<string, number>();
	private recoveryFingerprints = new Map<string, FingerprintEntry>();
	/**
	 * Per-path amplification history for the monotonic-growth quarantine.
	 * Independent of `recoveryFingerprints` — fingerprint quarantine catches
	 * "same diff repeating," this catches "growing diff repeating."
	 */
	private amplificationHistory = new Map<string, AmplificationEntry[]>();
	private lastConflictFingerprints = new Map<string, string>();
	/**
	 * Session-only content of recent baselines (hash -> content per path),
	 * so three-way decisions can name their base. Never persisted.
	 */
	private baselineContents = new Map<string, { hash: string; content: string }>();
	/**
	 * Agreements (disk == body) observed while the body still had local work
	 * that was not durably committed. They are not persisted as baselines:
	 * after IndexedDB loss the persisted index would claim disk carries no
	 * local edit when it holds the only copy of it. They still describe the
	 * last agreement for this session, and are persisted once the body's
	 * local work settles (`notifyLocalWorkSettled`).
	 */
	private deferredBaselines = new Map<string, { hash: string; content: string }>();
	/** Merges this controller committed for a closed note, awaiting projection to disk. */
	private closedMerges = new Map<string, { disk: string; merged: string }>();
	private materializeReplans = new Map<string, number>();
	private blockedDivergenceCount = 0;
	private lastBlockedDivergenceAt: string | null = null;
	private blockedDivergenceSample: Array<{ ext: string; hash: string }> = [];
	private readonly diagnosticPathSalt =
		Math.random().toString(36).slice(2) + Date.now().toString(36);
	/** Conflict notice throttle: suppress repeat notices within window. */
	private lastConflictNoticeAt = 0;
	private conflictNoticeSuppressionCount = 0;
	private static readonly CONFLICT_NOTICE_COOLDOWN_MS = 30_000;
	/** Amplification-quarantine notice throttle. Independent from conflict notices. */
	private lastAmplificationNoticeAt = 0;
	private amplificationNoticeSuppressionCount = 0;
	private static readonly AMPLIFICATION_NOTICE_COOLDOWN_MS = 60_000;

	constructor(private readonly deps: ReconciliationControllerDeps) {
		this.markdownAdmission = new MarkdownAdmissionScheduler({
			process: (intent, isCurrent) => this.processMarkdownAdmission(intent, isCurrent),
			onError: (error) => this.deps.log(`Markdown admission scheduler failed: ${String(error)}`),
		});
		// If a QA harness is attached, register the disk-ingest control port now.
		// In normal production, registerDiskIngestHarnessPort is absent.
		deps.registerDiskIngestPort?.({
			ingestDiskFileNow: async (path, reason) => {
				const abstractFile = this.deps.app.vault.getAbstractFileByPath(path);
				if (!(abstractFile instanceof TFile)) {
					throw new Error(`ingestDiskFileNow: not a file: ${path}`);
				}
				await this.syncFileFromDisk(abstractFile, reason);
			},
		});
	}

	get isReconciled(): boolean {
		return this.reconciled;
	}

	get isReconcileInFlight(): boolean {
		return this.reconcileInFlight;
	}

	get pending(): boolean {
		return this.reconcilePending;
	}

	get lastGeneration(): number {
		return this.lastReconciledGeneration;
	}

	set lastGeneration(value: number) {
		this.lastReconciledGeneration = value;
	}

	get untrackedFileCount(): number {
		return this.untrackedFiles.length;
	}

	getState(): ReconciliationState {
		const admission = this.markdownAdmission.diagnostics();
		return {
			reconciled: this.reconciled,
			reconcileInFlight: this.reconcileInFlight,
			reconcilePending: this.reconcilePending,
			lastReconcileStats: this.lastReconcileStats,
			lastReconciledGeneration: this.lastReconciledGeneration,
			untrackedFileCount: this.untrackedFiles.length,
			markdownAdmissionPending: admission.queue.length,
			markdownAdmissionOldestAgeMs: admission.queue.reduce(
				(oldest, item) => Math.max(oldest, item.queueAgeMs),
				0,
			),
			markdownAdmissionNextDeadlineAt: admission.nextWakeAt,
			blockedDivergenceCount: this.blockedDivergenceCount,
			lastBlockedDivergenceAt: this.lastBlockedDivergenceAt,
			blockedDivergenceSample: this.blockedDivergenceSample,
		};
	}

	markPending(): void {
		this.reconcilePending = true;
	}

	reset(): void {
		if (this.reconcileCooldownTimer) {
			window.clearTimeout(this.reconcileCooldownTimer);
			this.reconcileCooldownTimer = null;
		}
		this.reconciled = false;
		this.reconcileInFlight = false;
		this.reconcilePending = false;
		this.untrackedFiles = [];
		this.lastReconciledGeneration = 0;
		this.lastReconcileTime = 0;
		this.lastReconcileStats = null;
		this.markdownAdmission.reset();
		this.closedOnlyDeferredImports.clear();
		this.recoveryFingerprints.clear();
		this.amplificationHistory.clear();
		this.lastConflictFingerprints.clear();
		this.baselineContents.clear();
		this.deferredBaselines.clear();
		this.closedMerges.clear();
		this.materializeReplans.clear();
		for (const timer of this.remoteMaterializeTimers.values()) window.clearTimeout(timer);
		this.remoteMaterializeTimers.clear();
		this.blockedDivergenceCount = 0;
		this.lastBlockedDivergenceAt = null;
		this.blockedDivergenceSample = [];
		this.lastConflictNoticeAt = 0;
		this.conflictNoticeSuppressionCount = 0;
		this.lastAmplificationNoticeAt = 0;
		this.amplificationNoticeSuppressionCount = 0;
		this.boundRecoveryLocks.clear();
	}

	/**
	 * Lightweight authoritative reconcile after a reconnection.
	 * Fresh disk read catches drift during disconnect.
	 */
	async runReconnectReconciliation(generation: number): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;

		this.deps.log(`Running reconnect reconciliation (gen ${generation})`);
		await this.deps.refreshServerCapabilities("provider-sync");
		this.deps.validateOpenEditorBindings(`reconnect-pre:${generation}`);

		await this.runReconciliation("authoritative");
		this.lastReconciledGeneration = generation;
		this.deps.setAwaitingFirstProviderSyncAfterStartup(false);
		this.deps.onReconciled(`reconnect-post:${generation}`);

		if (this.reconcilePending) {
			this.reconcilePending = false;
			const nextVaultSync = this.deps.getVaultSync();
			if (nextVaultSync && nextVaultSync.connectionGeneration > this.lastReconciledGeneration) {
				void this.runReconnectReconciliation(nextVaultSync.connectionGeneration);
			}
		}
	}

	async runReconciliation(mode: ReconcileMode): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync || this.reconcileInFlight) {
			if (this.reconcileInFlight) this.reconcilePending = true;
			return;
		}

		this.reconcileInFlight = true;
		this.reconcilePending = false;
		try {
			const runtimeConfig = this.deps.getRuntimeConfig();
			const blobSync = this.deps.getBlobSync();
			if (blobSync) {
				const blobResult = blobSync.reconcile(mode, runtimeConfig.excludePatterns);
				this.deps.log(
					`Blob reconciliation [${mode}]: ${blobResult.uploadQueued} uploads, ` +
					`${blobResult.downloadQueued} downloads, ${blobResult.skipped} skipped`,
				);
			}
			await this.reconcileMarkdownInventory(`reconcile:${mode}`, {
				includeUntracked: this.deps.getSettings().originImportPending !== true,
			});
			this.reconciled = true;
			this.lastReconciledGeneration = vaultSync.connectionGeneration;
			this.lastReconcileStats = {
				at: new Date().toISOString(),
				mode,
				plannedCreates: 0,
				plannedUpdates: 0,
				flushedCreates: 0,
				flushedUpdates: 0,
				safetyBrakeTriggered: false,
				safetyBrakeReason: null,
			};
			this.deps.recordFlightEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.reconcileComplete,
				severity: "info",
				scope: "vault",
				source: "reconciliationController",
				layer: "reconcile",
				data: {
					mode,
					schema: 4,
					activeBodies: vaultSync.getActiveMarkdownPaths().length,
				},
			});
			this.deps.onReconciled(`schema4-${mode}`);
		} finally {
			this.reconcileInFlight = false;
			this.lastReconcileTime = Date.now();
			this.deps.scheduleTraceStateSnapshot(`schema4-${mode}`);
		}
	}

	/**
	 * Reconstructs volatile Markdown admission work from the filesystem.
	 * Missing catalog identities are always queued, even when their persisted
	 * disk-index stats look unchanged. Tracked files use the disk index to avoid
	 * unnecessary reads.
	 */
	async reconcileMarkdownInventory(
		reason: string,
		options: { includeUntracked?: boolean } = {},
	): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;
		this.flushDeferredBaselines();
		const files = this.deps.app.vault.getMarkdownFiles()
			.filter((file) => this.deps.isMarkdownPathSyncable(file.path));
		const { changed } = await filterChangedFiles(
			this.deps.app,
			files,
			this.deps.getDiskIndex(),
		);
		const changedPaths = new Set(changed.map((file) => file.path));
		const untracked = files.filter((file) => !vaultSync.getFileId(file.path));
		this.untrackedFiles = untracked.map((file) => file.path);

		for (const file of files) {
			const missing = !vaultSync.getFileId(file.path);
			if (missing && options.includeUntracked === false) continue;
			if (missing || changedPaths.has(file.path)) {
				this.markMarkdownDirty(file, missing ? "create" : "modify");
			}
		}
		this.deps.log(
			`Markdown inventory (${reason}): ${untracked.length} untracked, ${changedPaths.size} changed`,
		);
	}

	async importUntrackedFiles(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		const diskMirror = this.deps.getDiskMirror();
		if (!vaultSync) return;
		let imported = 0;
		for (const file of this.deps.app.vault.getMarkdownFiles()) {
			const path = file.path;
			if (!this.deps.isMarkdownPathSyncable(path) || vaultSync.getFileId(path)) continue;
			if (diskMirror?.isPreservedUnresolved(path)) {
				this.deps.log(`importUntracked: "${path}" remains preserved-unresolved`);
				continue;
			}
			try {
				let content = canonicalizeMarkdown(await this.deps.app.vault.read(file));
				if (this.deps.shouldBlockFrontmatterIngest(
					path,
					null,
					content,
					"disk-to-crdt-seed",
				)) {
					const partial = this.frontmatterBodyOnlyProgress(path, "", content, "disk-to-crdt-seed");
					if (partial === null) {
						this.recordFrontmatterIngestBlocked(path, false, "disk-to-crdt-seed");
						continue;
					}
					content = partial;
				}
				await vaultSync.commitDiskBody({
					bodyId: crypto.randomUUID(),
					path,
					content,
					reason: "external-edit",
					lifecycle: "create",
					candidateId: crypto.randomUUID(),
				});
				imported++;
			} catch (error) {
				console.error(`[yaos] importUntracked failed for "${path}":`, error);
			}
		}
		this.deps.refreshStatusBar();
		this.deps.log(`Imported ${imported} previously untracked files through schema-8 bodies`);
		if (imported > 0) new Notice(`YAOS: imported ${imported} files after server sync.`);
	}

	markMarkdownDirty(file: TFile, reason: "create" | "modify", opId?: string): void {
		this.markdownAdmission.queue({ path: file.path, reason, opId });
	}

	private remoteMaterializeTimers = new Map<string, number>();
	/** Consecutive superseded disk-import plans per path (see requeueAfterSupersede). */
	private ingestReplans = new Map<string, number>();

	/**
	 * A disk import found its plan superseded: queue a fresh plan, at most
	 * SYNC_FROM_DISK_MAX_REPLANS times in a row. Beyond that the path is left
	 * as is (a later disk change or inventory scan plans it again) instead
	 * of re-queuing forever.
	 */
	private requeueAfterSupersede(file: TFile, opId: string | undefined, reason: string): void {
		const replans = (this.ingestReplans.get(file.path) ?? 0) + 1;
		if (replans > SYNC_FROM_DISK_MAX_REPLANS) {
			this.ingestReplans.delete(file.path);
			this.deps.log(
				`syncFileFromDisk: giving up on "${file.path}" after ${replans - 1} superseded plans (${reason}); ` +
				`leaving it to the next disk change or scan`,
			);
			return;
		}
		this.ingestReplans.set(file.path, replans);
		this.deps.log(`syncFileFromDisk: ${reason} for "${file.path}"; replanning (${replans}/${SYNC_FROM_DISK_MAX_REPLANS})`);
		this.markMarkdownDirty(file, "modify", opId);
	}

	/**
	 * Project a remote change that reached the live body of a closed note to
	 * disk. Only disk still at its settled baseline is overwritten; disk that
	 * moved since is local input and goes through normal ingest; with no
	 * baseline nothing is decided here (reconciliation owns that case).
	 */
	scheduleRemoteBodyMaterialization(path: string): void {
		const existing = this.remoteMaterializeTimers.get(path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.remoteMaterializeTimers.set(path, window.setTimeout(() => {
			this.remoteMaterializeTimers.delete(path);
			void this.materializeRemoteBodyUpdate(path).catch((error: unknown) => {
				this.deps.log(`remote body materialization failed for "${path}": ${String(error)}`);
			});
		}, REMOTE_BODY_MATERIALIZE_DEBOUNCE_MS));
	}

	/**
	 * Closed-file divergence table (docs/sync-contract.md), with baseline B,
	 * disk D, body C:
	 *   D == C           nothing to do;
	 *   D == B, C != B   write the body to disk, conditional on D still on disk;
	 *   D != B, C == B   import disk (normal ingest);
	 *   D != B, C != B   three-way merge on B; overlap or no base: preserve both.
	 * With no trustworthy baseline nothing is decided here.
	 */
	private async materializeRemoteBodyUpdate(path: string): Promise<void> {
		if (!this.deps.isMarkdownPathSyncable(path)) return;
		const file = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		// An open note's editor binding projects remote changes itself.
		if (this.getOpenMarkdownViewsForPath(path).length > 0) return;
		// Preserved-unresolved (e.g. an overlap awaiting review): nothing is
		// projected, and no further conflict copy is made, until the user acts.
		if (this.deps.getDiskMirror()?.isPreservedUnresolved(path)) return;
		const vaultSync = this.deps.getVaultSync();
		const bodyId = vaultSync?.getFileId(path) ?? null;
		const existingText = vaultSync?.getTextForPath(path);
		if (!vaultSync || !bodyId || !existingText) return;
		this.flushDeferredBaselines(path);
		let content: string;
		try {
			content = canonicalizeMarkdown(await this.deps.app.vault.read(file));
		} catch (error) {
			// Read failure is uncertainty, never permission to overwrite.
			this.deps.log(`remote update to closed "${path}": disk unreadable (${String(error)}); not writing`);
			return;
		}
		const bodyContent = existingText.toJSON();
		if (bodyContent === content) {
			this.materializeReplans.delete(path);
			return;
		}
		if (await this.isUnchangedSinceSettlement(path, content)) {
			this.deps.log(`remote update to closed "${path}": writing body to unchanged disk`);
			this.deps.getDiskMirror()?.scheduleWrite(path, { expectedDiskHash: await contentBaselineHash(content) });
			return;
		}
		if (!this.hasBaseline(path)) {
			this.deps.log(`remote update to closed "${path}": disk has no trusted baseline; leaving to reconciliation`);
			return;
		}
		if (await this.matchesBaseline(path, bodyContent)) {
			// Only disk moved: it is local input for the normal ingest path.
			this.markMarkdownDirty(file, "modify");
			return;
		}
		await this.reconcileClosedDivergence(file, content, bodyContent, bodyId, "remote-materialization");
	}

	/**
	 * Disk and a loaded, closed body both moved away from their baseline. A
	 * two-way import here would delete the remote edit, a two-way write the
	 * local one. Merge on the baseline instead (DiskMirror.settleBody's
	 * common-base three-way merge); overlapping edits keep both (conflict
	 * artifact); with no base at all, disk is preserved as an artifact before
	 * the durable body is projected.
	 */
	private async reconcileClosedDivergence(
		file: TFile,
		diskContent: string,
		bodyContent: string,
		bodyId: string,
		source: "remote-materialization" | "disk-ingest",
	): Promise<void> {
		const path = file.path;
		const vaultSync = this.deps.getVaultSync();
		const diskMirror = this.deps.getDiskMirror();
		if (!vaultSync || !diskMirror) return;
		const ownMerge = this.closedMerges.get(path);
		if (ownMerge && ownMerge.disk === diskContent && ownMerge.merged === bodyContent) {
			// The body holds our own merge of exactly this disk: only the
			// projection is left, conditional on that disk still being there.
			this.closedMerges.delete(path);
			this.deps.log(`closed divergence "${path}": projecting committed merge to disk`);
			diskMirror.scheduleWrite(path, { expectedDiskHash: await contentBaselineHash(diskContent) });
			return;
		}
		this.closedMerges.delete(path);
		const baseline = this.effectiveBaselineHash(path);
		const baseContent = baseline === undefined ? null : await this.lookupBaselineContent(path, bodyId, baseline);
		this.deps.log(
			`closed divergence "${path}" (${source}): disk and body both changed since their baseline; ` +
			`three-way settle (${baseContent === null ? "stored common base" : "known baseline"})`,
		);
		this.deps.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.recoveryDecision,
			severity: "info",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason: "closed-file-both-changed",
				signature: computeRecoveryFingerprint("closed-file-both-changed", bodyContent, diskContent),
				action: "three-way-settle",
				diskLength: diskContent.length,
				crdtLength: bodyContent.length,
			},
		});
		const outcome = await diskMirror.settleBody({
			path,
			bodyId,
			generation: vaultSync.bodies.get(bodyId)?.generation ?? 0,
			content: bodyContent,
			...(baseContent !== null ? { baseContent } : {}),
			onMissingBase: "preserve-disk",
		});
		if (outcome !== "replan") {
			this.materializeReplans.delete(path);
			return;
		}
		const after = vaultSync.getTextForPath(path);
		const afterContent = after ? yTextToString(after) : null;
		if (afterContent !== null && afterContent !== bodyContent) {
			this.closedMerges.set(path, { disk: diskContent, merged: afterContent });
		}
		const replans = (this.materializeReplans.get(path) ?? 0) + 1;
		if (replans > REMOTE_BODY_MATERIALIZE_MAX_REPLANS) {
			this.materializeReplans.delete(path);
			this.deps.log(`closed divergence "${path}": still re-planning after ${replans - 1} attempts; leaving to reconciliation`);
			return;
		}
		this.materializeReplans.set(path, replans);
		this.scheduleRemoteBodyMaterialization(path);
	}

	/**
	 * Re-plan hook for a conditional disk write that found disk changed
	 * after it was planned (DiskMirror compare-and-swap). Nothing was written.
	 */
	handleDiskMovedBeforeWrite(path: string): void {
		this.deps.log(`disk moved before a planned write to "${path}"; re-planning`);
		this.scheduleRemoteBodyMaterialization(path);
	}

	/**
	 * Record a body projection DiskMirror just wrote (or found already on
	 * disk). It becomes the baseline only once the body holds no local work
	 * that is not durably committed; until then it is a session-only
	 * agreement (see `deferredBaselines`).
	 */
	recordProjectedDiskWrite(path: string, contentHash: string, content: string): void {
		this.rememberBaselineContent(path, contentHash, content);
		if (this.hasPendingLocalWorkForPath(path)) {
			this.deferredBaselines.set(path, { hash: contentHash, content });
			return;
		}
		this.deferredBaselines.delete(path);
		const index = this.deps.getDiskIndex();
		const entry = index[path] ?? { mtime: 0, size: 0 };
		if (this.persistAgreement(entry, path, contentHash, content)) index[path] = entry;
	}

	/**
	 * Write an agreement into a disk-index entry under the current local
	 * identity, and store its content as the body's common base. While the
	 * identity is not known yet (scope null) nothing is written: an unscoped
	 * write would strip the entry's scope, leaving a baseline that is never
	 * trusted again. The agreement is held back (session-only) and persisted
	 * by `flushDeferredBaselines` once the identity is bound.
	 */
	private persistAgreement(
		entry: import("../sync/diskIndex").DiskIndexEntry,
		path: string,
		hash: string,
		content: string,
	): boolean {
		const scope = this.baselineScope();
		if (scope === null) {
			this.deferredBaselines.set(path, { hash, content });
			return false;
		}
		setCurrentContentHash(entry, hash, scope);
		this.deps.persistCommonBase?.(path, hash, content);
		return true;
	}

	/** A partial (properties-held) write replaced any whole-content agreement. */
	forgetSessionBaseline(path: string): void {
		this.deferredBaselines.delete(path);
		this.baselineContents.delete(path);
	}

	/** Keep session baselines attached to their files across renames. */
	moveSessionBaselines(renames: ReadonlyMap<string, string>): void {
		for (const map of [this.deferredBaselines, this.baselineContents] as Map<string, { hash: string; content: string }>[]) {
			for (const [from, to] of renames) {
				const value = map.get(from);
				map.delete(from);
				if (value) map.set(to, value);
				else map.delete(to);
			}
		}
	}

	/** Local work settled somewhere: persist agreements that were held back. */
	notifyLocalWorkSettled(): void {
		this.flushDeferredBaselines();
	}

	/**
	 * The baseline content named by `hash`, if this session knows it: the
	 * latest deferred agreement, the session cache, or the body's stored
	 * common base when that is exactly this content.
	 */
	async lookupBaselineContent(path: string, bodyId: string | null, hash: string): Promise<string | null> {
		const deferred = this.deferredBaselines.get(path);
		if (deferred?.hash === hash) return deferred.content;
		const cached = this.baselineContents.get(path);
		if (cached?.hash === hash) return cached.content;
		if (!bodyId) return null;
		try {
			return await this.deps.getDiskMirror()?.readCommonBaseContent(bodyId, hash) ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * The hash of the latest disk/body agreement this controller may rely
	 * on: a session agreement held back from persistence, else a persisted
	 * baseline established under the current local identity.
	 */
	effectiveBaselineHash(path: string): string | undefined {
		// An unknown local identity trusts no agreement at all.
		if (this.baselineScope() === null) return undefined;
		return this.deferredBaselines.get(path)?.hash ?? this.trustedBaseline(path);
	}

	private baselineScope(): string | null | undefined {
		return this.deps.getBaselineScope ? this.deps.getBaselineScope() : undefined;
	}

	private trustedBaseline(path: string): string | undefined {
		return trustedContentHash(this.deps.getDiskIndex()[path], this.baselineScope());
	}

	private hasBaseline(path: string): boolean {
		return this.effectiveBaselineHash(path) !== undefined;
	}

	/** Whether `content` is one of the agreements the baseline rules may use. */
	private async matchesBaseline(path: string, content: string): Promise<boolean> {
		if (this.baselineScope() === null) return false;
		const deferred = this.deferredBaselines.get(path)?.hash;
		const persisted = this.trustedBaseline(path);
		if (deferred === undefined && persisted === undefined) return false;
		const hash = await contentBaselineHash(content);
		return hash === deferred || hash === persisted;
	}

	private rememberBaselineContent(path: string, hash: string, content: string): void {
		this.baselineContents.delete(path);
		this.baselineContents.set(path, { hash, content });
		for (const oldest of this.baselineContents.keys()) {
			if (this.baselineContents.size <= BASELINE_CONTENT_CACHE_MAX) break;
			this.baselineContents.delete(oldest);
		}
	}

	/**
	 * Per-path form of the CLI's persistence gate: a loaded body with local
	 * updates not yet durably committed cannot vouch for disk. A body that is
	 * not loaded holds no in-memory work; whatever it has pending lives in the
	 * local database, whose identity the baseline is bound to (baselineScope),
	 * so losing that database also discards the baseline. Unknown -> pending.
	 */
	private hasPendingLocalWorkForPath(path: string): boolean {
		try {
			const vaultSync = this.deps.getVaultSync();
			if (!vaultSync) return true;
			const bodyId = vaultSync.getFileId(path);
			const body = bodyId ? vaultSync.bodies.get(bodyId) : null;
			if (!body) return false;
			return body.dirty || body.unsettled > 0 || body.pendingLocalUpdates > 0;
		} catch {
			return true;
		}
	}

	private flushDeferredBaselines(onlyPath?: string): void {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;
		// Unknown local identity: nothing can be persisted under it yet.
		if (this.baselineScope() === null) return;
		for (const [path, agreement] of Array.from(this.deferredBaselines)) {
			if (onlyPath !== undefined && path !== onlyPath) continue;
			if (this.hasPendingLocalWorkForPath(path)) continue;
			this.deferredBaselines.delete(path);
			const text = vaultSync.getTextForPath(path);
			// The agreement is durable only if the body still holds it.
			if (!text || yTextToString(text) !== agreement.content) continue;
			// Hash only: the stat stays as last observed, so a disk change since
			// the agreement is still detected by the next scan.
			const index = this.deps.getDiskIndex();
			const entry = index[path] ?? { mtime: 0, size: 0 };
			if (this.persistAgreement(entry, path, agreement.hash, agreement.content)) index[path] = entry;
		}
	}

	/**
	 * Redirect any pending dirty entry (create or modify) from oldPath to newPath.
	 *
	 * Called by the rename batch flush callback for every rename in the batch,
	 * regardless of whether the CRDT rename succeeded.
	 *
	 * Two cases:
	 *
	 * Case A — pre-CRDT race (no fileId, rename dropped):
	 *   A pending create for oldPath is redirected to newPath. syncFileFromDisk
	 *   will run ensureFile at newPath, seeding the CRDT entry there.
	 *
	 * Case B — normal rename (fileId existed, CRDT rename succeeded):
	 *   A pending modify for oldPath is redirected to newPath. Without this,
	 *   processDirtyMarkdownPath(oldPath) would find the file gone and skip,
	 *   leaving the CRDT at the pre-modify content even though disk has the
	 *   updated content at newPath.
	 *
	 * Safety:
	 *   - For creates: only redirect if reason === "create" (pre-CRDT race path).
	 *   - For modifies: redirect regardless — a modify at a renamed-away path
	 *     always needs to be re-evaluated at the new path.
	 *   - If newPath is already dirty, merge (never overwrite), preserving
	 *     "create" priority and coalescing op IDs.
	 *   - If no entry exists for oldPath, this is a no-op.
	 */
	redirectPendingDirtyPath(oldPath: string, newPath: string): void {
		if (this.markdownAdmission.redirect(oldPath, newPath)) {
			this.deps.log(`redirectPendingDirtyPath: "${oldPath}" -> "${newPath}"`);
		}
	}


	/**
	 * Drop a pending dirty entry for path without redirecting.
	 *
	 * Called after an excluded-path tombstone is applied — the dirty entry was
	 * redirected to an excluded path by redirectPendingDirtyPath, but that path
	 * must not be synced. Dropping it prevents the drain from attempting
	 * syncFileFromDisk at an excluded path (which would be a no-op anyway,
	 * but is noisy and unnecessary).
	 */
	dropDirtyPath(path: string): void {
		if (this.markdownAdmission.drop(path)) {
			this.deps.log(`dropDirtyPath: dropped excluded dirty entry for "${path}"`);
		}
	}

	maybeImportDeferredClosedOnlyPath(path: string, reason: string): void {
		if (!this.reconciled) return;
		if (this.deps.getRuntimeConfig().externalEditPolicy !== "closed-only") return;
		if (!this.deps.isMarkdownPathSyncable(path)) return;
		if (this.closedOnlyDeferredImports.has(path)) return;
		if (this.getOpenMarkdownViewsForPath(path).length > 0) return;
		const file = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		this.closedOnlyDeferredImports.add(path);
		this.deps.trace("trace", "closed-only-deferred-import-queued", {
			path,
			reason,
		});

		const deferredOpId = `op-deferred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		void this.processDirtyMarkdownPath(path, "modify", deferredOpId)
			.catch((err) => {
				console.error(`[yaos] closed-only deferred import failed for "${path}" (${reason}):`, err);
			})
			.finally(() => {
				this.closedOnlyDeferredImports.delete(path);
			});
	}

	private async processMarkdownAdmission(
		intent: MarkdownAdmissionIntent,
		isCurrent: () => boolean,
	): Promise<OperationOutcome> {
		if (!isCurrent()) return { kind: "superseded" };
		try {
			await this.processDirtyMarkdownPath(
				intent.path,
				intent.reason,
				intent.primaryOpId,
				[...intent.coalescedOpIds],
				{ bodyId: intent.bodyId, candidateId: intent.candidateId, isCurrent },
			);
			if (!isCurrent()) return { kind: "superseded" };
			if (intent.reason === "create" && this.deps.getVaultSync()?.getFileId(intent.path)) {
				this.untrackedFiles = this.untrackedFiles.filter((candidate) => candidate !== intent.path);
			}
			return { kind: "completed", value: undefined };
		} catch (error) {
			if (error instanceof FreshAdmissionDurablyPendingError) return { kind: "durably_pending" };
			if (error instanceof FreshAdmissionCancelledError) return { kind: "superseded" };
			this.deps.log(`Markdown ${intent.reason} remains pending for "${intent.path}": ${String(error)}`);
			return { kind: "retryable_failure", failure: "local_persistence" };
		}
	}

	private async processDirtyMarkdownPath(
		path: string,
		reason: "create" | "modify",
		opId?: string,
		coalescedOpIds?: string[],
		admission?: { bodyId: string; candidateId: string; isCurrent: () => boolean },
	): Promise<void> {
		const abstractFile = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(abstractFile instanceof TFile)) {
			this.deps.log(`Markdown ${reason}: "${path}" no longer exists, skipping`);
			return;
		}

		const diskMirror = this.deps.getDiskMirror();
		const vaultSync = this.deps.getVaultSync();
		if (reason === "create") {
			if (await diskMirror?.shouldSuppressCreate(abstractFile)) {
				this.deps.log(`Suppressed create event for "${path}"`);
				return;
			}

			if (vaultSync?.isPendingRenameTarget(path)) {
				this.deps.log(`Create: "${path}" is a pending rename target, skipping import`);
				return;
			}
		} else {
			if (await diskMirror?.shouldSuppressModify(abstractFile)) {
				this.deps.log(`Suppressed modify event for "${path}"`);
				return;
			}
		}

		await this.syncFileFromDisk(abstractFile, reason, opId, coalescedOpIds, admission);
	}

	private async syncFileFromDisk(
		file: TFile,
		sourceReason: "create" | "modify" = "modify",
		opId?: string,
		coalescedOpIds?: string[],
		admission?: { bodyId: string; candidateId: string; isCurrent: () => boolean },
		planAttempt = 0,
	): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		const editorBindings = this.deps.getEditorBindings();
		const runtimeConfig = this.deps.getRuntimeConfig();
		if (!vaultSync) return;
		if (!this.deps.isMarkdownPathSyncable(file.path)) return;

		// If the user modifies or creates a file that was previously
		// preserved-unresolved, that is intentional user action. Clear the
		// guard so future reconcile/import treats it as a normal local file.
		const diskMirror = this.deps.getDiskMirror();
		if (diskMirror?.isPreservedUnresolved(file.path)) {
			diskMirror.clearPreservedUnresolved(file.path);
		}

		let wasBound = editorBindings?.isBound(file.path) ?? false;
		const openViews = this.getOpenMarkdownViewsForPath(file.path);
		const isOpenInEditor = openViews.length > 0;
		if (wasBound && !isOpenInEditor) {
			this.deps.trace("trace", "stale-bound-path-without-open-view", {
				path: file.path,
			});
			editorBindings?.unbindByPath(file.path);
			this.deps.log(`syncFileFromDisk: cleared stale bound state for "${file.path}" (no live view)`);
			wasBound = false;
		}

		const effectivePolicy =
			this.deps.getEffectiveExternalEditPolicy?.(runtimeConfig.externalEditPolicy)
			?? runtimeConfig.externalEditPolicy;
		const policyDecision = decideExternalEditImport(effectivePolicy, isOpenInEditor);
		if (!policyDecision.allowImport) {
			const reason = policyDecision.reason === "policy-never"
				? "external edit policy: never"
				: "external edit policy: closed-only (file is open; deferred)";
			this.deps.log(`syncFileFromDisk: skipping "${file.path}" (${reason})`);
			if (policyDecision.reason === "policy-never") {
				await this.updateDiskIndexForPath(file.path);
			}
			return;
		}

		try {
			let content = canonicalizeMarkdown(await this.deps.app.vault.read(file));

			const contentBytes = canonicalMarkdownBytes(content).byteLength;
			if (runtimeConfig.maxFileSizeBytes > 0 && contentBytes > runtimeConfig.maxFileSizeBytes) {
				this.deps.log(`syncFileFromDisk: skipping "${file.path}" (${Math.round(contentBytes / 1024)} KB exceeds limit)`);
				return;
			}
			const existingText = vaultSync.getTextForPath(file.path);
			this.flushDeferredBaselines(file.path);
			const baselineKnown = this.hasBaseline(file.path);
			const activeBodyId = baselineKnown ? vaultSync.getFileId(file.path) : null;

			// The unchanged-since-settlement proof is about a path that has an
			// active body (loaded or not). With no body at the path, disk equal
			// to a leftover baseline is a restore or recreate (trash restore,
			// undo, checkout, an empty "Untitled.md") and must be admitted.
			if (
				activeBodyId
				&& (!existingText || existingText.toJSON() !== content)
				&& await this.isUnchangedSinceSettlement(file.path, content)
			) {
				this.ingestReplans.delete(file.path);
				await this.skipUnchangedDisk(file, content, existingText, openViews, wasBound);
				await this.updateDiskIndexForPath(file.path);
				return;
			}

			// Every disk -> body import is planned against the body it would
			// change; an unloaded body is loaded first, then the plan is made.
			const pathBodyId = vaultSync.getFileId(file.path);
			if (pathBodyId && !existingText) {
				if (planAttempt >= SYNC_FROM_DISK_MAX_PLAN_ATTEMPTS) {
					throw new Error(`body of "${file.path}" could not be loaded to plan the disk import`);
				}
				await this.loadBodyForPlanning(vaultSync, file.path, pathBodyId, content);
				return this.syncFileFromDisk(file, sourceReason, opId, coalescedOpIds, admission, planAttempt + 1);
			}

			if (wasBound && isOpenInEditor) {
				const handledBound = await this.handleBoundFileSyncGap(
					file,
					content,
					existingText,
					openViews,
					sourceReason,
				);
				if (handledBound) {
					if (yTextToString(existingText) === content) this.ingestReplans.delete(file.path);
					// Disk and body agreeing is a clean settlement: advance the
					// baseline so it keeps describing what YAOS last saw agree.
					await this.updateDiskIndexForPath(
						file.path,
						yTextToString(existingText) === content ? content : undefined,
					);
					return;
				}
			}

			const previousContent = existingText?.toJSON() ?? null;
			if (previousContent === content) {
				this.ingestReplans.delete(file.path);
				await this.updateDiskIndexForPath(file.path, content);
				return;
			}
			const boundNow = editorBindings?.isBound(file.path) ?? false;
			if (isOpenInEditor && !boundNow && editorBindings?.isBindResolutionBlocked?.(file.path)) {
				// The open editor's bind is waiting on (or gave up) resolving its
				// divergence from the body; that resolution owns the disk content.
				this.deps.log(`syncFileFromDisk: deferring "${file.path}" (open editor bind resolution pending or abandoned)`);
				this.deps.recordFlightPathEvent?.({
					priority: "verbose",
					kind: PRODUCT_EVENT_KIND.recoverySkipped,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: { reason: "bind-resolution-blocked" },
				});
				return;
			}
			const diskContent = content;
			// The frontmatter ingest guard applies to disk-derived content
			// before any settle, merge or commit, whatever the baseline says.
			let frontmatterHeld = false;
			if (this.deps.shouldBlockFrontmatterIngest(
				file.path,
				previousContent,
				content,
				previousContent === null ? "disk-to-crdt-seed" : "disk-to-crdt",
			)) {
				const branch = previousContent === null ? "disk-to-crdt-seed" : "disk-to-crdt-existing";
				const partial = this.frontmatterBodyOnlyProgress(file.path, previousContent ?? "", content, branch);
				if (partial === null) {
					this.recordFrontmatterIngestBlocked(file.path, false, branch);
					this.ingestReplans.delete(file.path);
					await this.updateDiskIndexForPath(file.path);
					return;
				}
				content = partial;
				frontmatterHeld = true;
			}
			const bodyMovedSinceBaseline = existingText && pathBodyId && previousContent !== null
				&& !await this.matchesBaseline(file.path, previousContent);
			let merged = false;
			if (bodyMovedSinceBaseline && !isOpenInEditor && !frontmatterHeld) {
				// D != B (the guard above did not fire) and C != B, or no trusted
				// baseline at all: the body may hold changes disk never saw. A
				// two-way import would delete them; three-way or preserve both.
				this.ingestReplans.delete(file.path);
				await this.reconcileClosedDivergence(file, content, previousContent, pathBodyId, "disk-ingest");
				await this.updateDiskIndexForPath(file.path);
				return;
			}
			if (bodyMovedSinceBaseline && (frontmatterHeld || (isOpenInEditor && !boundNow))) {
				// Open but unbound (bind pending, reading view), or disk content
				// the frontmatter guard transformed (DiskMirror would settle the
				// raw file): the same three-way rule, merged in place, without
				// projecting to disk.
				const plan = await this.inPlaceThreeWay(file.path, pathBodyId, content, previousContent, diskContent);
				if (plan.kind === "preserved") {
					this.ingestReplans.delete(file.path);
					await this.updateDiskIndexForPath(file.path);
					return;
				}
				merged = plan.content !== content;
				content = plan.content;
			}
			// Only an import of exactly the disk content (or of its body with
			// held properties) makes disk and body agree on it.
			const settledContent = !merged && (content === diskContent || frontmatterHeld) ? content : undefined;
			if (previousContent !== null && content === previousContent) {
				// The body already holds everything disk contributes (properties
				// held back, or a merge equal to the body): nothing to commit.
				this.deps.log(`syncFileFromDisk: "${file.path}" contributes nothing new to its body; settling`);
				this.ingestReplans.delete(file.path);
				await this.updateDiskIndexForPath(file.path, settledContent);
				return;
			}

			const bodyId = vaultSync.getFileId(file.path);
			if (bodyId && bodyId !== pathBodyId) {
				// The path changed hands while planning.
				this.requeueAfterSupersede(file, opId, "the path changed hands while planning");
				return;
			}
			if (bodyId && existingText && previousContent !== null) {
				const outcome = await this.importDiskIfBodyCurrent(
					vaultSync,
					file.path,
					bodyId,
					existingText,
					previousContent,
					content,
					admission?.candidateId ?? opId ?? crypto.randomUUID(),
				);
				if (outcome === "superseded") {
					this.requeueAfterSupersede(file, opId, "the body moved since the plan");
					return;
				}
			} else if (bodyId) {
				this.requeueAfterSupersede(file, opId, "the body is not loaded");
				return;
			} else {
				const admittedBodyId = admission?.bodyId ?? crypto.randomUUID();
				await vaultSync.commitDiskBody({
					bodyId: admittedBodyId,
					path: file.path,
					content,
					reason: "external-edit",
					lifecycle: "create" as const,
					candidateId: admission?.candidateId ?? opId ?? crypto.randomUUID(),
					...(admission ? { admissionStillCurrent: admission.isCurrent } : {}),
				});
			}
			this.ingestReplans.delete(file.path);
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.crdtFileUpdated,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "crdt",
				path: file.path,
				opId,
				data: {
					fileId: bodyId ?? vaultSync.getFileId(file.path),
					originKind: bodyId ? "disk-sync" : "schema4-create",
					...(coalescedOpIds && coalescedOpIds.length > 1 ? { coalescedOpIds } : {}),
				},
			});

			await this.updateDiskIndexForPath(file.path, settledContent);
		} catch (err) {
			console.error(`[yaos] syncFileFromDisk failed for "${file.path}":`, err);
			throw err;
		}
	}

	/**
	 * Load (and catch up) the current body of `path` so a disk import can be
	 * planned against it. Never captures a candidate or changes the body.
	 */
	private async loadBodyForPlanning(
		vaultSync: VaultSync,
		_path: string,
		bodyId: string,
		_diskContent: string,
	): Promise<void> {
		await vaultSync.loadBodyForPlanning(bodyId);
	}

	/**
	 * Disk -> body import conditional on the body content it was planned
	 * against (`expectedBody`). The comparison and the Y transaction run in
	 * one synchronous section: a remote update that reached the body after
	 * the plan makes this "superseded" (nothing applied), never a two-way
	 * diff that deletes it (P0c N2).
	 */
	private async importDiskIfBodyCurrent(
		vaultSync: VaultSync,
		path: string,
		bodyId: string,
		text: NonNullable<ReturnType<VaultSync["getTextForPath"]>>,
		expectedBody: string,
		content: string,
		candidateId: string,
	): Promise<"applied" | "superseded"> {
		if (vaultSync.isBodyOpen(bodyId)) {
			const outcome = tryApplyDiffToYText(text, expectedBody, content, ORIGIN_DISK_SYNC);
			return outcome === "superseded" ? "superseded" : "applied";
		}
		const outcome = await vaultSync.commitBodyCandidateIfCurrent({
			bodyId,
			path,
			expectedContent: expectedBody,
			content,
			candidateId,
			reason: "external-edit",
		});
		return outcome.kind === "completed" ? "applied" : "superseded";
	}

	/**
	 * Disk and the body of an open but unbound editor both moved from their
	 * agreement (or no trusted agreement exists). Three-way on the baseline
	 * or the stored common base; if the body still equals that base, disk is
	 * a plain local edit. Overlap or no base: preserve disk as a conflict
	 * note and leave the body alone (the editor's bind shows the body).
	 */
	private async inPlaceThreeWay(
		path: string,
		bodyId: string,
		diskContent: string,
		bodyContent: string,
		/** What to preserve on overlap: the raw disk file, if `diskContent` was transformed. */
		preservedContent: string = diskContent,
	): Promise<{ kind: "import"; content: string } | { kind: "preserved" }> {
		let base: string | null = null;
		const baseline = this.effectiveBaselineHash(path);
		if (baseline !== undefined) base = await this.lookupBaselineContent(path, bodyId, baseline);
		if (base === null) {
			try {
				base = (await this.deps.getDiskMirror()?.readWholeCommonBase(bodyId))?.content ?? null;
			} catch {
				base = null;
			}
		}
		if (base !== null) {
			if (base === bodyContent) return { kind: "import", content: diskContent };
			const merge = mergeThreeWayText(base, diskContent, bodyContent);
			if (merge.kind === "clean") {
				this.deps.log(`syncFileFromDisk: "${path}": merged disk and body on their base in place`);
				return { kind: "import", content: merge.content };
			}
		}
		const fingerprint = `in-place\x00${contentFingerprint(bodyContent)}\x00${contentFingerprint(preservedContent)}`;
		if (this.lastConflictFingerprints.get(path) === fingerprint) return { kind: "preserved" };
		try {
			await this.createMarkdownConflictArtifact(path, preservedContent, "disk-body-both-changed", "disk");
			this.lastConflictFingerprints.set(path, fingerprint);
			this.showConflictNotice(
				`Conflict detected for "${path.split("/").pop()}" — ` +
				`the version on disk was preserved as a conflict note.`,
			);
		} catch (error) {
			this.deps.log(`syncFileFromDisk: could not preserve disk of "${path}" (${String(error)}); not importing`);
		}
		return { kind: "preserved" };
	}

	/**
	 * Whether disk still holds exactly the content YAOS last wrote or saw agree
	 * with the body at this path (the disk-index baseline). Such disk content
	 * carries no local edit, whatever the body now holds: the sync contract's
	 * `D == B` row. An unknown baseline proves nothing and returns false.
	 */
	private async isUnchangedSinceSettlement(path: string, content: string): Promise<boolean> {
		return this.matchesBaseline(path, content);
	}

	/**
	 * Unchanged disk is never local input. If the body moved on (a remote
	 * change not yet materialized, e.g. one merged into a warm body while the
	 * note was closed), turning this stale disk into Y.Text ops would delete
	 * committed remote content. The body wins instead (`D == B, C != B`: write
	 * body state to disk); open editors are kept current by their binding.
	 */
	private async skipUnchangedDisk(
		file: TFile,
		content: string,
		existingText: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[],
		wasBound: boolean,
	): Promise<void> {
		const isOpenInEditor = openViews.length > 0;
		const crdtContent = existingText ? yTextToString(existingText) : null;
		if (crdtContent === null || crdtContent === content) return;
		this.deps.log(
			`syncFileFromDisk: "${file.path}" is unchanged since its last settlement; ` +
			`the body is ahead (${content.length} -> ${crdtContent.length} chars), not importing stale disk`,
		);
		this.deps.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.recoverySkipped,
			severity: "info",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path: file.path,
			data: {
				reason: "disk-unchanged-since-settlement",
				diskLength: content.length,
				crdtLength: crdtContent.length,
				isOpenInEditor,
			},
		});
		if (!isOpenInEditor) {
			// Conditional: written only while disk still holds this content.
			this.deps.getDiskMirror()?.scheduleWrite(file.path, {
				expectedDiskHash: await contentBaselineHash(content),
			});
			return;
		}
		if (wasBound) this.repairDivergedBoundEditors(file, openViews, crdtContent);
	}

	/**
	 * A bound editor whose text differs from its Y.Text has a broken binding:
	 * yCollab maps later keystrokes by offset, and the next disk save would
	 * reach the local-only recovery as stale input. Rebind, which routes the
	 * divergence through bind-time resolution (baseline-aware, preserving).
	 */
	private repairDivergedBoundEditors(file: TFile, openViews: MarkdownView[], crdtContent: string): void {
		const editorBindings = this.deps.getEditorBindings();
		if (!editorBindings) return;
		for (const view of openViews) {
			const editorContent = view.editor.getValue();
			if (editorContent === crdtContent) continue;
			if (this.shouldQuarantineRepeatedRecovery(
				file.path,
				"bound-editor-diverged-from-body",
				crdtContent,
				editorContent,
			)) {
				// Rebinding keeps failing: a binding known to diverge must not stay
				// attached (yCollab would map keystrokes onto the wrong offsets).
				editorBindings.quarantineBinding(view, "bound-editor-diverged-from-body");
				this.deps.log(`syncFileFromDisk: unbound diverged editor of "${file.path}" after repeated rebinds`);
				new Notice(
					`YAOS stopped syncing the open editor of “${file.path.split("/").pop() ?? file.path}”: ` +
					`it keeps diverging from the synced version. Close and reopen the note to retry.`,
					15_000,
				);
				continue;
			}
			this.deps.log(
				`syncFileFromDisk: bound editor of "${file.path}" differs from its body ` +
				`(editor=${editorContent.length}, body=${crdtContent.length} chars); rebinding`,
			);
			this.deps.trace("recovery", "bound-editor-diverged-rebind", {
				path: file.path,
				editorLength: editorContent.length,
				crdtLength: crdtContent.length,
			});
			editorBindings.rebind(view, this.deps.getSettings().deviceName, "bound-editor-diverged-from-body");
		}
	}

	private getOpenMarkdownViewsForPath(path: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		this.deps.app.workspace.iterateAllLeaves((leaf) => {
			if (
				leaf.view instanceof MarkdownView
				&& leaf.view.file?.path === path
			) {
				views.push(leaf.view);
			}
		});
		return views;
	}

	private async handleBoundFileSyncGap(
		file: TFile,
		content: string,
		existingText: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[] = this.getOpenMarkdownViewsForPath(file.path),
		sourceReason: "create" | "modify" = "modify",
	): Promise<boolean> {
		const editorBindings = this.deps.getEditorBindings();
		const vaultSync = this.deps.getVaultSync();
		const now = Date.now();
		const lockUntil = this.boundRecoveryLocks.get(file.path) ?? 0;
		if (lockUntil > now) {
			this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, recovery lock)`);
			this.deps.trace("recovery", "recovery-postcondition-skipped", {
				path: file.path,
				reason: "recovery-lock-active",
				lockRemainingMs: lockUntil - now,
			});
			// recovery.skipped: bound recovery lock active.
			this.deps.recordFlightPathEvent?.({
				priority: "verbose",
				kind: PRODUCT_EVENT_KIND.recoverySkipped,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "recovery-lock-active",
					lockRemainingMs: lockUntil - now,
				},
			});
			// Pauses (or quenched cycles) reset the amplification detector.
			this.amplificationHistory.delete(file.path);
			return true;
		}
		if (lockUntil > 0) {
			this.boundRecoveryLocks.delete(file.path);
		}

		if (openViews.length === 0) {
			this.deps.trace("trace", "stale-bound-path-without-open-view", {
				path: file.path,
			});
			editorBindings?.unbindByPath(file.path);
			this.deps.log(`syncFileFromDisk: cleared stale bound state for "${file.path}" (no live view)`);
			return false;
		}

		const crdtContent = yTextToString(existingText);
		if (crdtContent === content) {
			this.boundRecoveryLocks.delete(file.path);
			this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, crdt-current)`);
			// recovery.skipped: CRDT and disk already agree (bound second-pass no-op).
			this.deps.recordFlightPathEvent?.({
				priority: "verbose",
				kind: PRODUCT_EVENT_KIND.recoverySkipped,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "crdt-current-no-op",
					wasBound: true,
				},
			});
			// Convergence reached: amplification detector is reset.
			this.amplificationHistory.delete(file.path);
			return true;
		}

		const viewStates = openViews.map((view) => {
			const editorContent = view.editor.getValue();
			const binding = editorBindings?.getBindingDebugInfoForView(view) ?? null;
			const collab = editorBindings?.getCollabDebugInfoForView(view) ?? null;
			return {
				view,
				editorContent,
				editorMatchesDisk: editorContent === content,
				editorMatchesCrdt: crdtContent != null && editorContent === crdtContent,
				binding,
				collab,
			};
		});

		const localOnlyViews = viewStates.filter(
			(state) => state.editorMatchesDisk && !state.editorMatchesCrdt,
		);
		if (localOnlyViews.length > 0) {
			let editorsNeedBodyAdoption = false;
			this.deps.trace("trace", "bound-file-local-only-divergence", {
				path: file.path,
				diskLength: content.length,
				crdtLength: crdtContent?.length ?? null,
				viewCount: localOnlyViews.length,
				views: localOnlyViews.map((state) => ({
					leafId: state.binding?.leafId ?? null,
					storedCmId: state.binding?.storedCmId ?? null,
					liveCmId: state.binding?.liveCmId ?? null,
					cmMatches: state.binding?.cmMatches ?? null,
					hasSyncFacet: state.collab?.hasSyncFacet ?? null,
					awarenessMatchesProvider: state.collab?.awarenessMatchesProvider ?? null,
					yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
					undoManagerMatchesFacet: state.collab?.undoManagerMatchesFacet ?? null,
					facetFileId: state.collab?.facetFileId ?? null,
					expectedFileId: state.collab?.expectedFileId ?? null,
				})),
			});

			if (existingText) {
				// Localized idle guard: defer recovery if the user just typed.
				// The localOnly branch is the typing-cadence amplifier shape:
				// editor matches disk but CRDT trails, repeatedly, because
				// Obsidian autosave lands keystrokes faster than the
				// y-codemirror.next plumbing propagates them into Y.Text.
				// Quenching that loop requires a window longer than a typical
				// human typing burst.
				const lastEditorActivityLocalOnly =
					editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
				if (
					lastEditorActivityLocalOnly !== null
					&& (Date.now() - lastEditorActivityLocalOnly) < OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS
				) {
					const idleMs = Date.now() - lastEditorActivityLocalOnly;
					this.deps.log(
						`syncFileFromDisk: deferring "${file.path}" ` +
						`(editor-bound local-only, recent typing ${idleMs}ms ago)`,
					);
					this.deps.recordFlightPathEvent?.({
						priority: "verbose",
						kind: PRODUCT_EVENT_KIND.recoverySkipped,
						severity: "info",
						scope: "file",
						source: "reconciliationController",
						layer: "recovery",
						path: file.path,
						data: {
							reason: "recent-editor-activity-local-only",
							idleMs,
						},
					});
					// Pauses reset the amplification detector. See spec R3.8.
					this.amplificationHistory.delete(file.path);
					return true;
				}

				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-local-only-divergence",
				)) {
					const partial = this.frontmatterBodyOnlyProgress(
						file.path, crdtContent ?? "", content, "bound-file-local-only-divergence",
					);
					if (partial === null) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-local-only-divergence");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return true;
					}
					content = partial;
				}
				const threeWay = await this.boundLocalOnlyThreeWay(file.path, content, crdtContent ?? "");
				if (threeWay.kind === "preservation-failed") return true;
				if (threeWay.kind === "merged") {
					editorsNeedBodyAdoption = threeWay.content !== content;
					content = threeWay.content;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound local-only divergence, ${threeWay.kind}: ` +
					`${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
				this.deps.trace("trace", "bound-file-recovery-source-selected", {
					path: file.path,
					reason: "bound-file-local-only-divergence",
					chosenSource: "disk",
					action: "applied-repair-only",
					editorLengths: localOnlyViews.map((state) => state.editorContent.length),
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
				});
			// recovery.decision: emit before quarantine check so even quarantined cases are visible
			// Snapshot binding health across all localOnly views. Surfaces in
			// the trace why we may or may not also call repair() on the views
			// after the diff applies. See spec R7.
			const _localOnlyHealth = localOnlyViews.map((state) => ({
				leafId: state.binding?.leafId ?? null,
				...classifyBindingHealth(state.binding, state.collab),
			}));
			const _localOnlyAnyUnhealthy = _localOnlyHealth.some((h) => !h.healthy);
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.recoveryDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "bound-file-local-only-divergence",
					signature: computeRecoveryFingerprint("bound-file-local-only-divergence", crdtContent ?? "", content),
					action: "apply-diff",
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
					// Branch predicates — makes traces self-documenting
					editorEqualsDisk: localOnlyViews.length > 0,
					editorEqualsCrdt: false,
					diskFingerprintPrefix: contentFingerprint(content).slice(0, 8),
					crdtFingerprintPrefix: crdtContent ? contentFingerprint(crdtContent).slice(0, 8) : null,
					// Binding-health diagnostic surface (Reviewer item 2/3): lets
					// future RCAs see why repair was or wasn't called per view
					// without grepping the source.
					bindingHealth: _localOnlyHealth,
					anyBindingUnhealthy: _localOnlyAnyUnhealthy,
				},
			});
				// Monotonic-growth amplification quarantine: independent of
				// fingerprint identity. Catches typing-cadence loops where every
				// cycle has a different (prevLen, nextLen) but the lengths grow
				// along the same axis.
				if (this.shouldQuarantineAmplification(
					file.path,
					"bound-file-local-only-divergence",
					crdtContent?.length ?? 0,
					content.length,
				)) {
					return true;
				}
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-local-only-divergence",
					crdtContent ?? "",
					content,
				)) {
					return true;
				}
				// recovery.apply.start: before the actual diff application
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyStart,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-local-only-divergence",
						origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
						diskLength: content.length,
						crdtLength: crdtContent?.length ?? null,
					},
				});
				// The plan above awaited: apply only to the body it was made on.
				if (yTextToString(existingText) !== (crdtContent ?? "")) {
					this.requeueAfterSupersede(file, undefined, "the body moved during bound recovery");
					return true;
				}
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_RECOVER_BOUND,
				);
			traceRecoveryPostcondition(
				(source, message, details) => this.deps.trace(source, message, details),
				this.deps.recordFlightPathEvent
					? (event) => this.deps.recordFlightPathEvent?.(event)
					: undefined,
				file.path,
				"bound-file-local-only-divergence",
				ORIGIN_DISK_SYNC_RECOVER_BOUND,
				content.length,
				recoveryResult,
			);
				this.deps.recordFlightPathEvent?.({
					priority: recoveryResult.forceReplaceApplied ? "critical" : "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyDone,
					severity: recoveryResult.finalMatchesExpected ? "info" : "warn",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-local-only-divergence",
						origin: ORIGIN_DISK_SYNC_RECOVER_BOUND,
						expectedLength: content.length,
						actualLength: recoveryResult.finalLength,
						matchesExpected: recoveryResult.finalMatchesExpected,
						forceReplaceApplied: recoveryResult.forceReplaceApplied,
					},
				});
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-local-only-seed",
				)) {
					const partial = this.frontmatterBodyOnlyProgress(
						file.path, "", content, "bound-file-local-only-seed",
					);
					if (partial === null) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-local-only-seed");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return true;
					}
					content = partial;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound, missing CRDT text: seeding ${content.length} chars)`,
				);
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-local-only-seed",
						signature: computeRecoveryFingerprint("bound-file-local-only-seed", "", content),
						action: "seed-crdt-from-disk",
						diskLength: content.length,
					},
				});
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-local-only-seed",
					"",
					content,
				)) {
					return true;
				}
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyStart,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: { reason: "bound-file-local-only-seed", action: "seed-crdt-from-disk", diskLength: content.length },
				});
				if (vaultSync?.getFileId(file.path)) {
					// A body exists but is not loaded: never import blind. The
					// unbound path loads it and plans against it.
					this.requeueAfterSupersede(file, undefined, "the body is not loaded");
					return true;
				}
				if (vaultSync) {
					await vaultSync.commitDiskBody({
						bodyId: crypto.randomUUID(),
						path: file.path,
						content,
						reason: "external-edit",
						lifecycle: "create" as const,
						candidateId: crypto.randomUUID(),
					});
				}
				const recoveredContent = vaultSync ? content : null;
				this.deps.trace("recovery", "recovery-postcondition-observed", {
					path: file.path,
					reason: "bound-file-local-only-seed",
					origin: "ensureFile",
					expectedLength: content.length,
					actualLength: recoveredContent?.length ?? null,
					matchesExpected: recoveredContent === content,
					matchesAfterDiff: recoveredContent === content,
					enforced: false,
					forceReplaceApplied: false,
				});
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);

			// Binding-health-conditional repair.
			//
			// The original code reconfigured the CodeMirror compartment via
			// editorBindings.repair() on EVERY localOnly recovery cycle, even
			// when the binding was healthy. Each reconfigure adds jitter to
			// the editor↔ytext propagation and contributed to the typing-
			// cadence amplifier loop captured in the 2026-05-27 iPad trace.
			//
			// New rule: only repair when the captured binding/collab debug
			// info shows actual unhealth. A healthy binding does NOT need
			// to be reconfigured just because content recovery happened.
			//
			// Two operations are now distinct:
			//   - content recovery (always run when the predicate is met)
			//   - editor binding repair (run only when health markers fail)
			for (const state of localOnlyViews) {
				const health = classifyBindingHealth(state.binding, state.collab);
				if (health.healthy) {
					this.deps.trace("recovery", "binding-healthy-skipped-repair", {
						path: file.path,
						leafId: state.binding?.leafId ?? null,
						cmMatches: state.binding?.cmMatches ?? null,
						hasSyncFacet: state.collab?.hasSyncFacet ?? null,
						yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
					});
					continue;
				}
				this.deps.trace("recovery", "binding-unhealthy-repairing", {
					path: file.path,
					leafId: state.binding?.leafId ?? null,
					reasons: health.reasons,
				});
				const repaired = editorBindings?.repair(
					state.view,
					this.deps.getSettings().deviceName,
					"bound-file-local-only-divergence",
				) ?? false;
				if (!repaired) {
					editorBindings?.rebind(
						state.view,
						this.deps.getSettings().deviceName,
						"bound-file-local-only-divergence",
					);
				}
			}
			if (editorsNeedBodyAdoption) {
				// The body now holds the merge, which the editors lack; bind-time
				// resolution shows it (the editor's edits are part of it).
				for (const state of localOnlyViews) {
					editorBindings?.rebind(
						state.view,
						this.deps.getSettings().deviceName,
						"bound-file-local-only-three-way",
					);
				}
			}

			this.deps.scheduleTraceStateSnapshot("bound-file-desync-recovery");
			return true;
		}

		const crdtOnlyViews = viewStates.filter(
			(state) => state.editorMatchesCrdt && !state.editorMatchesDisk,
		);
		if (crdtOnlyViews.length > 0) {
			const lastEditorActivity = editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
			const hasRecentEditorActivity = lastEditorActivity != null
				&& (Date.now() - lastEditorActivity) < OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS;
			if (hasRecentEditorActivity) {
				this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, disk lag)`);
				// recovery.skipped: crdtOnly branch idle-grace bail.
				this.deps.recordFlightPathEvent?.({
					priority: "verbose",
					kind: PRODUCT_EVENT_KIND.recoverySkipped,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "recent-editor-activity",
						idleMs: Date.now() - lastEditorActivity,
					},
				});
				return true;
			}

			if (existingText) {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-open-idle-disk-recovery",
				)) {
					const partial = this.frontmatterBodyOnlyProgress(
						file.path, crdtContent ?? "", content, "bound-file-open-idle-disk-recovery",
					);
					if (partial === null) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-open-idle-disk-recovery");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return true;
					}
					content = partial;
				}
				// Disk moved and so may the body (a remote edit disk never saw):
				// three-way on their agreement rather than a two-way import.
				const threeWay = await this.boundLocalOnlyThreeWay(file.path, content, crdtContent ?? "");
				if (threeWay.kind === "preservation-failed") return true;
				if (threeWay.kind === "merged") content = threeWay.content;
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound external disk edit while idle, ${threeWay.kind}: ` +
					`${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: PRODUCT_EVENT_KIND.recoveryDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "bound-file-open-idle-disk-recovery",
					signature: computeRecoveryFingerprint("bound-file-open-idle-disk-recovery", crdtContent ?? "", content),
					action: "apply-diff",
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
					// Branch predicates
					editorEqualsDisk: false,
					editorEqualsCrdt: crdtOnlyViews.length > 0,
					diskFingerprintPrefix: contentFingerprint(content).slice(0, 8),
					crdtFingerprintPrefix: crdtContent ? contentFingerprint(crdtContent).slice(0, 8) : null,
				},
			});
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-open-idle-disk-recovery",
					crdtContent ?? "",
					content,
				)) {
					return true;
				}
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyStart,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-open-idle-disk-recovery",
						origin: ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
						diskLength: content.length,
						crdtLength: crdtContent?.length ?? null,
					},
				});
				// The plan above awaited: apply only to the body it was made on.
				if (yTextToString(existingText) !== (crdtContent ?? "")) {
					this.requeueAfterSupersede(file, undefined, "the body moved during idle disk recovery");
					return true;
				}
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
				);
			traceRecoveryPostcondition(
				(source, message, details) => this.deps.trace(source, message, details),
				this.deps.recordFlightPathEvent
					? (event) => this.deps.recordFlightPathEvent?.(event)
					: undefined,
				file.path,
				"bound-file-open-idle-disk-recovery",
				ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
				content.length,
				recoveryResult,
			);
				this.deps.recordFlightPathEvent?.({
					priority: recoveryResult.forceReplaceApplied ? "critical" : "important",
					kind: PRODUCT_EVENT_KIND.recoveryApplyDone,
					severity: recoveryResult.finalMatchesExpected ? "info" : "warn",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-open-idle-disk-recovery",
						origin: ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
						expectedLength: content.length,
						actualLength: recoveryResult.finalLength,
						matchesExpected: recoveryResult.finalMatchesExpected,
						forceReplaceApplied: recoveryResult.forceReplaceApplied,
					},
				});
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-open-idle-seed",
				)) {
					const partial = this.frontmatterBodyOnlyProgress(
						file.path, "", content, "bound-file-open-idle-seed",
					);
					if (partial === null) {
						this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-open-idle-seed");
						this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
						return true;
					}
					content = partial;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound idle disk edit, missing CRDT text: seeding ${content.length} chars)`,
				);
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: PRODUCT_EVENT_KIND.recoveryDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-open-idle-seed",
						signature: computeRecoveryFingerprint("bound-file-open-idle-seed", "", content),
						action: "seed-crdt-from-disk",
						diskLength: content.length,
					},
				});
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-open-idle-seed",
					"",
					content,
				)) {
					return true;
				}
				if (vaultSync?.getFileId(file.path)) {
					// A body exists but is not loaded: never import blind. The
					// unbound path loads it and plans against it.
					this.requeueAfterSupersede(file, undefined, "the body is not loaded");
					return true;
				}
				if (vaultSync) {
					await vaultSync.commitDiskBody({
						bodyId: crypto.randomUUID(),
						path: file.path,
						content,
						reason: "external-edit",
						lifecycle: "create" as const,
						candidateId: crypto.randomUUID(),
					});
				}
				const recoveredContent = vaultSync ? content : null;
				this.deps.trace("recovery", "recovery-postcondition-observed", {
					path: file.path,
					reason: "bound-file-open-idle-seed",
					origin: "ensureFile",
					expectedLength: content.length,
					actualLength: recoveredContent?.length ?? null,
					matchesExpected: recoveredContent === content,
					matchesAfterDiff: recoveredContent === content,
					enforced: false,
					forceReplaceApplied: false,
				});
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);
			this.deps.scheduleTraceStateSnapshot("bound-file-open-idle-disk-recovery");
			return true;
		}

		this.deps.trace("trace", "bound-file-ambiguous-divergence", {
			path: file.path,
			diskLength: content.length,
			crdtLength: crdtContent?.length ?? null,
			views: viewStates.map((state) => ({
				leafId: state.binding?.leafId ?? null,
				storedCmId: state.binding?.storedCmId ?? null,
				liveCmId: state.binding?.liveCmId ?? null,
				cmMatches: state.binding?.cmMatches ?? null,
				editorMatchesDisk: state.editorMatchesDisk,
				editorMatchesCrdt: state.editorMatchesCrdt,
				hasSyncFacet: state.collab?.hasSyncFacet ?? null,
				awarenessMatchesProvider: state.collab?.awarenessMatchesProvider ?? null,
				yTextMatchesExpected: state.collab?.yTextMatchesExpected ?? null,
				undoManagerMatchesFacet: state.collab?.undoManagerMatchesFacet ?? null,
				facetFileId: state.collab?.facetFileId ?? null,
				expectedFileId: state.collab?.expectedFileId ?? null,
			})),
		});
		const distinctEditorContents = [...new Set(viewStates.map((state) => state.editorContent))];
		const editorAuthority: string | null = distinctEditorContents.length === 1
			? distinctEditorContents[0]!
			: null;
		if (editorAuthority === null) {
			this.deps.getDiskMirror()?.recordPreservedUnresolved(
				file.path,
				"multiple-editor-authorities",
			);
		}
		let conflictPath: string | null = null;
		let diskConflictPath: string | null = null;
		let conflictError: string | null = null;
		let conflictSkippedDedupe = false;
		if (crdtContent != null) {
			// Dedupe: if the same ambiguous fingerprint was already turned into
			// a conflict artifact, do not create another one. This prevents
			// infinite conflict artifact spam when convergence fails.
			// Include editor hash to catch cases where editor content differs
			// from disk between attempts (editor is the local authority being
			// applied during convergence). Use sorted distinct hashes of ALL
			// open views, not just the first — multiple panes may have different
			// unsaved content.
			const editorHashes = [...new Set(
				viewStates.map((s) => contentFingerprint(s.editorContent)),
			)].sort();
			const editorFp = editorHashes.length > 0
				? editorHashes.join("+")
				: "no-editor";
			const conflictFingerprint = `${contentFingerprint(crdtContent)}\x00${contentFingerprint(content)}\x00${editorFp}`;
			const previousConflictFingerprint = this.lastConflictFingerprints.get(file.path);
			if (previousConflictFingerprint === conflictFingerprint) {
				conflictSkippedDedupe = true;
			} else {
				try {
					conflictPath = await this.createMarkdownConflictArtifact(
						file.path,
						crdtContent,
						"bound-file-ambiguous-divergence",
						"crdt",
					);
					if (
						editorAuthority !== null &&
						content !== editorAuthority &&
						content !== crdtContent
					) {
						diskConflictPath = await this.createMarkdownConflictArtifact(
							file.path,
							content,
							"bound-file-ambiguous-divergence",
							"disk",
						);
					}
					this.lastConflictFingerprints.set(file.path, conflictFingerprint);
					// Notify the user — conflict artifacts can be surprising.
					// Throttled: only one Notice per 30s window; suppressed
					// conflicts are counted and reported in the next notice.
					this.showConflictNotice(
						`Conflict detected for "${file.path.split("/").pop()}" — ` +
						`competing version preserved as conflict note.`,
					);
				} catch (err) {
					conflictError = err instanceof Error ? err.message : String(err);
				}
			}
		}

		// After preserving competing versions as conflict artifacts, converge
		// the original path's CRDT to the visible editor content. This
		// prevents the same ambiguity from re-triggering on the next reconcile
		// and creating infinite conflict copies.
		//
		// Also attempt convergence when dedupe skipped artifact creation —
		// the earlier artifact already preserved the losing side; retry
		// convergence so the path can become stable.
		let convergenceApplied = false;
		if ((conflictPath !== null || conflictSkippedDedupe) && editorAuthority !== null) {
			const existingText = vaultSync?.getTextForPath(file.path);
			if (existingText) {
				forceReplaceYText(existingText, editorAuthority, ORIGIN_DISK_SYNC_RECOVER_BOUND);
				convergenceApplied = yTextToString(existingText) === editorAuthority;
				if (convergenceApplied) {
					// Convergence succeeded — the original path now matches disk.
					// Clear the conflict fingerprint so a genuinely new divergence
					// (different content) can still create a fresh artifact.
					this.lastConflictFingerprints.delete(file.path);
				}
			}
		}

		this.deps.trace("conflict", "conflict-artifact-needed", {
			path: file.path,
			conflictPath,
			diskConflictPath,
			reason: "bound-file-ambiguous-divergence",
			diskLength: content.length,
			crdtLength: crdtContent?.length ?? null,
			editorViewCount: viewStates.length,
			distinctEditorContentCount: distinctEditorContents.length,
			chosenSource: editorAuthority === null ? "none-multiple-editor-contents" : "editor",
			conflictArtifactCreated: conflictPath !== null,
			conflictSkippedDedupe,
			convergenceApplied,
			error: conflictError,
		});
		this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, ambiguous divergence)`);
		this.deps.scheduleTraceStateSnapshot("bound-file-ambiguous");
		return true;
	}

	/**
	 * Bound local-only divergence: editor == disk (D), body C lags. When the
	 * body also moved since the baseline B (C != B, e.g. a remote edit the
	 * broken binding never showed), diffing C toward D would delete it.
	 * Apply the B -> D delta onto C instead (three-way). Overlapping edits:
	 * the editor stays the selected authority, but C is preserved first as a
	 * conflict note. Without a known baseline or its content: two-way, as
	 * before (C == B makes two-way exactly the B -> D delta).
	 */
	private async boundLocalOnlyThreeWay(
		path: string,
		diskContent: string,
		crdtContent: string,
	): Promise<
		| { kind: "two-way" }
		| { kind: "merged"; content: string }
		| { kind: "conflict-preserved" }
		| { kind: "preservation-failed" }
	> {
		const baseline = this.effectiveBaselineHash(path);
		if (baseline === undefined) return { kind: "two-way" };
		const [diskHash, crdtHash] = await Promise.all([
			contentBaselineHash(diskContent),
			contentBaselineHash(crdtContent),
		]);
		if (crdtHash === baseline || diskHash === baseline) return { kind: "two-way" };
		const base = await this.lookupBaselineContent(path, this.deps.getVaultSync()?.getFileId(path) ?? null, baseline);
		if (base === null) return { kind: "two-way" };
		const merge = mergeThreeWayText(base, diskContent, crdtContent);
		if (merge.kind === "clean") return { kind: "merged", content: merge.content };
		const fingerprint = `local-only\x00${contentFingerprint(crdtContent)}\x00${contentFingerprint(diskContent)}`;
		if (this.lastConflictFingerprints.get(path) === fingerprint) return { kind: "conflict-preserved" };
		try {
			await this.createMarkdownConflictArtifact(path, crdtContent, "bound-file-local-only-overlap", "crdt");
			this.lastConflictFingerprints.set(path, fingerprint);
			this.showConflictNotice(
				`Conflict detected for "${path.split("/").pop()}" — ` +
				`competing version preserved as conflict note.`,
			);
			return { kind: "conflict-preserved" };
		} catch (error) {
			this.deps.log(`bound local-only: could not preserve body of "${path}" (${String(error)}); not converging`);
			return { kind: "preservation-failed" };
		}
	}

	private frontmatterBodyOnlyProgress(
		path: string,
		currentContent: string,
		incomingContent: string,
		reason: string,
	): string | null {
		const partial = composeBodyOnlyProgress(currentContent, incomingContent);
		if (partial.kind === "ambiguous") return null;
		if (partial.heldPropertiesRegion === "" && partial.incomingPropertiesRegion === "") return null;
		this.deps.trace("quarantine", "frontmatter-body-only-progress", {
			path,
			reason,
			heldPropertiesLength: partial.heldPropertiesRegion.length,
			incomingPropertiesLength: partial.incomingPropertiesRegion.length,
			bodyLength: partial.body.length,
		});
		this.deps.scheduleTraceStateSnapshot("frontmatter-body-only-progress");
		return partial.content;
	}

	/**
	 * Single private helper that owns every `recovery.skipped` emission
	 * with `data.reason === "frontmatter-ingest-blocked"`.
	 *
	 * Invoked from each of the six `shouldBlockFrontmatterIngest` block
	 * branches (two in `syncFileFromDisk` for the unbound disk→CRDT
	 * branches, four in `handleBoundFileSyncGap` for the bound recovery
	 * branches). The `branch` parameter is a closed-enum literal covering
	 * the six call sites; new emission sites are not permitted without
	 * extending the `FrontmatterIngestBlockBranch` union.
	 *
	 * The pre-existing `scheduleTraceStateSnapshot("frontmatter-ingest-blocked")`
	 * calls in the four bound branches are intentionally retained as a
	 * legacy diagnostic channel; this helper is additive.
	 */
	private recordFrontmatterIngestBlocked(
		path: string,
		wasBound: boolean,
		branch: FrontmatterIngestBlockBranch,
	): void {
		const data: RecoverySkippedFrontmatterData = {
			reason: "frontmatter-ingest-blocked",
			wasBound,
			branch,
		};
		this.deps.recordFlightPathEvent?.({
			priority: "important",
			kind: PRODUCT_EVENT_KIND.recoverySkipped,
			severity: "info",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data,
		});
	}

	private shouldQuarantineRepeatedRecovery(
		path: string,
		reason: string,
		previousContent: string,
		nextContent: string,
	): boolean {
		const fingerprint = computeRecoveryFingerprint(reason, previousContent, nextContent);
		const now = Date.now();
		const previous = this.recoveryFingerprints.get(path);

		// Evaluate using pure policy function.
		const decision = evaluateFingerprintQuarantine({
			fingerprint,
			now,
			previous,
		});

		// Update state (side effect kept in controller).
		this.recoveryFingerprints.set(path, decision.newEntry);

		// Cap map size: evict oldest entries when exceeded.
		if (this.recoveryFingerprints.size > FINGERPRINT_MAP_MAX_SIZE) {
			const oldestPath = findOldestFingerprintEntry(this.recoveryFingerprints);
			if (oldestPath) this.recoveryFingerprints.delete(oldestPath);
		}

		if (!decision.quarantined) return false;

		const count = decision.newEntry.count;
		this.deps.trace("recovery", "recovery-quarantined", {
			path,
			reason,
			repeatCount: count,
			signature: fingerprint,
			previousLength: previousContent.length,
			nextLength: nextContent.length,
			previousHashPrefix: contentFingerprint(previousContent),
			nextHashPrefix: contentFingerprint(nextContent),
		});
		this.deps.log(
			`syncFileFromDisk: quarantined repeated recovery for "${path}" ` +
			`(${reason}, ${count} attempts)`,
		);
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryQuarantined,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				repeatCount: count,
				signature: fingerprint,
				reason,
				previousLength: previousContent.length,
				nextLength: nextContent.length,
			},
		});
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryLoopDetected,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				repeatCount: count,
				signature: fingerprint,
				reason,
			},
		});
		this.deps.scheduleTraceStateSnapshot("recovery-quarantined");
		return true;
	}

	/**
	 * Monotonic-growth amplification quarantine.
	 *
	 * Independent of fingerprint identity. Catches loops where every cycle
	 * has a different `(prevLen, nextLen)` fingerprint but the lengths grow
	 * along the same axis — the typing-cadence amplifier shape captured in
	 * the 2026-05-27 iPad trace at pathId p:476818d2ecba90d4e95e2a0c4f3ad1eb.
	 */
	private shouldQuarantineAmplification(
		path: string,
		reason: string,
		prevLen: number,
		nextLen: number,
	): boolean {
		const now = Date.now();
		const existing = this.amplificationHistory.get(path) ?? [];

		// Evaluate using pure policy function.
		const decision = evaluateAmplificationQuarantine({
			prevLen,
			nextLen,
			now,
			history: existing,
		});

		if (!decision.quarantined) {
			// Update state (side effect kept in controller).
			this.amplificationHistory.set(path, decision.newHistory);

			// Cap global map size — share the same limit as recoveryFingerprints
			// so a single tunable governs both detectors' memory footprint.
			if (this.amplificationHistory.size > FINGERPRINT_MAP_MAX_SIZE) {
				const oldestPath = findOldestAmplificationEntry(
					this.amplificationHistory,
					path, // exclude current path from eviction
				);
				if (oldestPath) {
					this.amplificationHistory.delete(oldestPath);
				}
			}

			return false;
		}

		// Quarantine triggered — emit side effects.
		const { triggerSlice, consistentDelta, firstPrevLen, lastNextLen } = decision;

		this.deps.trace("recovery", "recovery-amplification-quarantined", {
			path,
			reason,
			entries: triggerSlice.length,
			windowMs: AMPLIFICATION_WINDOW_MS,
			firstPrevLen,
			lastNextLen,
			consistentDelta,
		});
		this.deps.log(
			`syncFileFromDisk: amplification-quarantined "${path}" ` +
			`(${reason}, ${triggerSlice.length} cycles, ${firstPrevLen} -> ${lastNextLen}, ` +
			`consistentDelta=${consistentDelta})`,
		);
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryAmplificationQuarantined,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				entries: triggerSlice.length,
				windowMs: AMPLIFICATION_WINDOW_MS,
				firstPrevLen,
				lastNextLen,
				consistentDelta,
			},
		});
		// Also emit recovery.loop.detected so existing loop-detection consumers
		// see this case. See spec R3.5.
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: PRODUCT_EVENT_KIND.recoveryLoopDetected,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				detector: "amplification",
				entries: triggerSlice.length,
			},
		});
		this.deps.scheduleTraceStateSnapshot("recovery-amplification-quarantined");
		// User-visible notice. Throttled and silent on every cycle in
		// production, but the user gets at least one warning per minute
		// when amplification quarantine is firing — better than a silent
		// quarantine.
		const fileName = path.split("/").pop() ?? path;
		this.showAmplificationNotice(
			`Recovery loop detected for "${fileName}" — paused content recovery. ` +
			`Try closing and reopening the note, or wait for sync to settle.`,
		);
		// Drop the path's history so subsequent recoveries are evaluated
		// against a fresh window (the path has been quarantined; analyzer
		// or user intervention will resolve the divergence).
		this.amplificationHistory.delete(path);
		return true;
	}

	private async createMarkdownConflictArtifact(
		path: string,
		content: string,
		reason: string,
		source?: "crdt" | "disk" | "editor",
	): Promise<string> {
		const basePath = this.conflictArtifactPath(path, source);
		for (let i = 0; i < 100; i++) {
			const candidate = i === 0
				? basePath
				: basePath.replace(/(\.md)?$/, ` ${i + 1}$1`);
			if (this.deps.app.vault.getAbstractFileByPath(candidate)) continue;
			await this.deps.app.vault.create(candidate, content);
			this.deps.trace("conflict", "conflict-artifact-created", {
				path,
				conflictPath: candidate,
				reason,
				source: source ?? null,
				contentLength: content.length,
			});
			return candidate;
		}
		throw new Error(`could not create conflict artifact for ${path}`);
	}

	private conflictArtifactPath(path: string, source?: "crdt" | "disk" | "editor"): string {
		const slash = path.lastIndexOf("/");
		const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
		const name = slash >= 0 ? path.slice(slash + 1) : path;
		const dot = name.toLowerCase().endsWith(".md") ? name.length - 3 : -1;
		const base = dot >= 0 ? name.slice(0, dot) : name;
		const ext = dot >= 0 ? name.slice(dot) : ".md";
		// Cap device name to 50 chars to prevent overly long paths
		const device = (this.deps.getSettings().deviceName
			.replace(/[\\/:*?"<>|]/g, "-")
			.trim() || "unknown-device").slice(0, 50);
		const stamp = new Date().toISOString()
			.replace(/\.\d{3}Z$/, "Z")
			.replace(/[:]/g, "-");
		// Cap base name to 100 chars to prevent filesystem path length issues
		const cappedBase = base.slice(0, 100);
		const sourcePart = source ? ` - ${source}` : "";
		const suffix = ` (YAOS conflict${sourcePart} from ${device} ${stamp})`;
		// Guard total filename length: suffix + ext + base + margin for
		// counter suffix (" 99") ≈ suffix.length + ext.length + 4.
		// Most filesystems cap at 255 bytes per component.
		const maxBase = Math.max(20, 255 - suffix.length - ext.length - 4);
		const finalBase = cappedBase.length > maxBase
			? cappedBase.slice(0, maxBase)
			: cappedBase;
		return `${dir}${finalBase}${suffix}${ext}`;
	}

	/**
	 * Refresh the stat of `path`. With `settledContent` (disk and body agree
	 * on it), also advance the baseline - unless the body still holds local
	 * work that is not durably committed, in which case the agreement is kept
	 * for this session only and persisted once that work settles.
	 */
	private async updateDiskIndexForPath(path: string, settledContent?: string): Promise<void> {
		try {
			const stat = await this.deps.app.vault.adapter.stat(path);
			if (stat) {
				const existing = this.deps.getDiskIndex()[path];
				const nextEntry: import("../sync/diskIndex").DiskIndexEntry = {
					mtime: stat.mtime,
					size: stat.size,
				};
				const contentHash = currentContentHash(existing);
				// Carry the previous agreement (and its scope) forward.
				if (contentHash !== undefined) setCurrentContentHash(nextEntry, contentHash, existing?.baselineScope);
				else if (
					existing?.settlementKind === "body-only"
					&& existing.bodyContentHash !== undefined
					&& existing.propertiesContentHash !== undefined
				) {
					setPartialContentHashes(
						nextEntry,
						existing.bodyContentHash,
						existing.propertiesContentHash,
						existing.baselineScope,
					);
				}
				if (settledContent !== undefined) {
					const settledHash = await contentBaselineHash(settledContent);
					this.rememberBaselineContent(path, settledHash, settledContent);
					if (this.hasPendingLocalWorkForPath(path)) {
						this.deferredBaselines.set(path, { hash: settledHash, content: settledContent });
					} else {
						this.deferredBaselines.delete(path);
						this.persistAgreement(nextEntry, path, settledHash, settledContent);
					}
				}
				this.deps.setDiskIndex({
					...this.deps.getDiskIndex(),
					[path]: nextEntry,
				});
			}
		} catch {
			// Stat failed, index will be stale for this path.
		}
	}

	/**
	 * Show a conflict notice with rate-limiting. Only one notice per
	 * CONFLICT_NOTICE_COOLDOWN_MS window; suppressed conflicts are
	 * counted and mentioned in the next notice.
	 */
	private showConflictNotice(message: string): void {
		const now = Date.now();
		if (now - this.lastConflictNoticeAt < ReconciliationController.CONFLICT_NOTICE_COOLDOWN_MS) {
			this.conflictNoticeSuppressionCount++;
			return;
		}
		const suppressed = this.conflictNoticeSuppressionCount;
		this.conflictNoticeSuppressionCount = 0;
		this.lastConflictNoticeAt = now;
		const suffix = suppressed > 0
			? ` (and ${suppressed} other conflict${suppressed > 1 ? "s" : ""} in the last 30s)`
			: "";
		new Notice(`YAOS: ${message}${suffix}`, 10000);
	}

	/**
	 * Show an amplification-quarantine notice with rate-limiting. Independent
	 * from showConflictNotice — these two surfaces are different: a conflict
	 * preserved a competing version, an amplification quarantine paused
	 * content recovery on a file that looked like it was looping.
	 *
	 * One notice per AMPLIFICATION_NOTICE_COOLDOWN_MS window; suppressed
	 * fires are counted and reported in the next notice.
	 */
	private showAmplificationNotice(message: string): void {
		const now = Date.now();
		if (now - this.lastAmplificationNoticeAt < ReconciliationController.AMPLIFICATION_NOTICE_COOLDOWN_MS) {
			this.amplificationNoticeSuppressionCount++;
			return;
		}
		const suppressed = this.amplificationNoticeSuppressionCount;
		this.amplificationNoticeSuppressionCount = 0;
		this.lastAmplificationNoticeAt = now;
		const suffix = suppressed > 0
			? ` (and ${suppressed} other quarantine${suppressed > 1 ? "s" : ""} in the last 60s)`
			: "";
		new Notice(`YAOS: ${message}${suffix}`, 12000);
	}
}
