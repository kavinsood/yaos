import { App, MarkdownView, Notice, TFile } from "obsidian";
import type { BlobSyncManager } from "../sync/blobSync";
import type { DiskMirror } from "../sync/diskMirror";
import {
	type DiskIndex,
	collectFileStats,
	contentBaselineHash,
	contentFingerprint,
	filterChangedFiles,
	updateIndex,
} from "../sync/diskIndex";
import type { ReconcileMode, VaultSync } from "../sync/vaultSync";
import type { VaultSyncSettings } from "../settings";
import type { RuntimeConfig } from "./runtimeConfig";
import type { EditorBindingManager } from "../sync/editorBinding";
import { FLIGHT_KIND } from "../debug/flightEvents";
import type {
	FlightEventInput,
	FlightPathEventInput,
	FrontmatterIngestBlockBranch,
	RecoverySkippedFrontmatterData,
} from "../debug/flightEvents";
import {
	applyDiffToYText,
	applyDiffToYTextWithPostcondition,
	forceReplaceYText,
	type DiffPostconditionResult,
} from "../sync/diff";
import { decideExternalEditImport } from "../sync/externalEditPolicy";
import { yTextToString } from "../utils/format";
import {
	ORIGIN_DISK_SYNC,
	ORIGIN_DISK_SYNC_RECOVER_BOUND,
	ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
} from "../sync/origins";
import { decideClosedFileConflict } from "../sync/closedFileConflict";

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
	blockedDivergenceCount: number;
	lastBlockedDivergenceAt: string | null;
	/** Safe sample of blocked paths: extensions + fingerprint hashes (no raw filenames). */
	blockedDivergenceSample: Array<{ ext: string; hash: string }>;
}

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
	recordFlightEvent?(event: FlightEventInput): void;
	recordFlightPathEvent?(event: FlightPathEventInput): void;
	getAwaitingFirstProviderSyncAfterStartup(): boolean;
	setAwaitingFirstProviderSyncAfterStartup(value: boolean): void;
	saveDiskIndex(): Promise<void>;
	refreshStatusBar(): void;
	/**
	 * Returns the Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Used by decideClosedFileConflict to detect disk edits made while YAOS
	 * was inactive (missing-baseline tie-breaking). Returns 0 if never saved.
	 * Naming: getLastDiskIndexPersistedAt — this is the last save, not last
	 * plugin activity; conflating them creates false certainty.
	 */
	getLastSaveDiskIndexAt?(): number;
	trace(source: string, msg: string, details?: Record<string, unknown>): void;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
	/**
	 * Phase 2 (Requirement 10): Compute a witness-domain recoveryStateHash for content.
	 * Called when emitting recovery.decision events while a flight trace is active.
	 * Returns null if no trace is active or hash computation fails.
	 */
	computeRecoveryStateHash?(path: string, content: string): Promise<string | null>;
}

const RECONCILE_COOLDOWN_MS = 10_000;
const MARKDOWN_DIRTY_SETTLE_MS = 350;
const OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200;
/**
 * Idle window for the bound-file-local-only-divergence branch.
 *
 * Distinct from OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS (1200ms, used only by
 * the crdtOnly branch). The localOnly branch is the typing-cadence amplifier
 * shape — Obsidian autosave landing keystrokes faster than the y-codemirror
 * plumbing propagates them into Y.Text. Quenching that loop requires a
 * window longer than a typical human typing burst; 3000ms is conservative.
 *
 * See spec: .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R2.
 */
const OPEN_FILE_LOCAL_ONLY_RECOVERY_IDLE_MS = 3000;
const BOUND_RECOVERY_LOCK_MS = 1500;
const TRACE_PATH_SAMPLE_LIMIT = 50;
const MAX_REPEATED_RECOVERY_FINGERPRINTS = 3;
const MAX_RECOVERY_FINGERPRINT_MAP_SIZE = 200;
/** Time-to-live for recovery fingerprint counts. If the same fingerprint
 *  recurs after this window, the count resets to 1 — preventing stale
 *  attempts from hours ago from poisoning future legitimate edits. */
const RECOVERY_FINGERPRINT_TTL_MS = 10 * 60_000; // 10 minutes

/**
 * Monotonic-growth amplification quarantine.
 *
 * Independent of fingerprint identity. Catches recovery loops where every
 * cycle has a different fingerprint but lengths and prefixes grow along the
 * same axis (typing-cadence amplifier). See spec:
 * .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
 */
const MAX_AMPLIFICATION_HISTORY_ENTRIES = 5;
const AMPLIFICATION_QUARANTINE_THRESHOLD = 3;
const AMPLIFICATION_WINDOW_MS = 15_000;

interface AmplificationEntry {
	prevLen: number;
	nextLen: number;
	at: number;
}

/**
 * Cheap FNV-1a-ish 32-bit hash for content fingerprinting.
 * @see diskIndex.contentFingerprint — exported from there, imported above.
 */
function recoverySignature(reason: string, previousContent: string, nextContent: string): string {
	return `${reason}\x00${contentFingerprint(previousContent)}\x00${contentFingerprint(nextContent)}`;
}

function tracePathList(prefix: string, paths: string[]): Record<string, unknown> {
	return {
		[`${prefix}PathCount`]: paths.length,
		[`${prefix}PathSample`]: paths.slice(0, TRACE_PATH_SAMPLE_LIMIT),
		[`${prefix}PathsTruncated`]: paths.length > TRACE_PATH_SAMPLE_LIMIT,
	};
}

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
 *
 * See spec:
 * .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R7.
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
			kind: FLIGHT_KIND.recoveryPostconditionFailed,
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
	private reconcileCooldownTimer: ReturnType<typeof setTimeout> | null = null;
	private lastReconcileStats: ReconciliationStats | null = null;
	private dirtyMarkdownPaths = new Map<string, { reason: "create" | "modify"; primaryOpId?: string; coalescedOpIds: string[] }>();
	private closedOnlyDeferredImports = new Set<string>();
	private markdownDrainPromise: Promise<void> | null = null;
	private markdownDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMarkdownDirtyAt = 0;
	private boundRecoveryLocks = new Map<string, number>();
	private recoveryFingerprints = new Map<string, { fingerprint: string; count: number; lastAt: number }>();
	/**
	 * Per-path amplification history for the monotonic-growth quarantine.
	 * Independent of `recoveryFingerprints` — fingerprint quarantine catches
	 * "same diff repeating," this catches "growing diff repeating." See spec:
	 * .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
	 */
	private amplificationHistory = new Map<string, AmplificationEntry[]>();
	/** QA-ONLY: in-memory external edit policy override. Never persisted. */
	private __qaExternalEditPolicyOverride: import("../settings").ExternalEditPolicy | null = null;
	private lastConflictFingerprints = new Map<string, string>();
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

	constructor(private readonly deps: ReconciliationControllerDeps) {}

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
		return {
			reconciled: this.reconciled,
			reconcileInFlight: this.reconcileInFlight,
			reconcilePending: this.reconcilePending,
			lastReconcileStats: this.lastReconcileStats,
			lastReconciledGeneration: this.lastReconciledGeneration,
			untrackedFileCount: this.untrackedFiles.length,
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
			clearTimeout(this.reconcileCooldownTimer);
			this.reconcileCooldownTimer = null;
		}
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
			this.markdownDrainTimer = null;
		}
		this.reconciled = false;
		this.reconcileInFlight = false;
		this.reconcilePending = false;
		this.untrackedFiles = [];
		this.lastReconciledGeneration = 0;
		this.lastReconcileTime = 0;
		this.lastReconcileStats = null;
		this.dirtyMarkdownPaths.clear();
		this.closedOnlyDeferredImports.clear();
		this.markdownDrainPromise = null;
		this.lastMarkdownDirtyAt = 0;
		this.recoveryFingerprints.clear();
		this.amplificationHistory.clear();
		this.lastConflictFingerprints.clear();
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

		if (this.untrackedFiles.length > 0) {
			await this.importUntrackedFiles();
		}

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
		const diskMirror = this.deps.getDiskMirror();
		if (!vaultSync || !diskMirror) return;
		if (this.reconcileInFlight) {
			this.reconcilePending = true;
			this.deps.log("Reconciliation already in flight — queued");
			return;
		}

		const now = Date.now();
		const elapsed = now - this.lastReconcileTime;
		if (this.lastReconcileTime > 0 && elapsed < RECONCILE_COOLDOWN_MS) {
			const delay = RECONCILE_COOLDOWN_MS - elapsed;
			this.deps.log(`Reconcile cooldown: ${delay}ms remaining, scheduling delayed run`);
			this.reconcilePending = true;
			if (!this.reconcileCooldownTimer) {
				this.reconcileCooldownTimer = setTimeout(() => {
					this.reconcileCooldownTimer = null;
					if (this.reconcilePending) {
						this.reconcilePending = false;
						const nextMode = this.deps.getVaultSync()?.getSafeReconcileMode() ?? mode;
						void this.runReconciliation(nextMode);
					}
				}, delay);
			}
			return;
		}

		this.reconcileInFlight = true;

		try {
			this.deps.recordFlightEvent?.({
				priority: "important",
				kind: "reconcile.start",
				severity: "info",
				scope: "vault",
				source: "reconciliationController",
				layer: "reconcile",
				data: {
					mode,
					crdtPathCount: vaultSync.getActiveMarkdownPaths().length,
					connected: vaultSync.connected,
					providerSynced: vaultSync.providerSynced,
				},
			});
			const runtimeConfig = this.deps.getRuntimeConfig();
			const diskFiles = new Map<string, string>();
			const diskPresentPaths = new Set<string>();
			const allMdFiles = this.deps.app.vault.getMarkdownFiles();
			let excludedCount = 0;
			let oversizedCount = 0;
			let skippedByIndex = 0;

			const eligibleFiles: TFile[] = [];
			for (const file of allMdFiles) {
				if (!this.deps.isMarkdownPathSyncable(file.path)) {
					excludedCount++;
					continue;
				}
				eligibleFiles.push(file);
				diskPresentPaths.add(file.path);
			}

			let changed: TFile[] = [];
			let unchanged: TFile[] = [];
			let allStats: Map<string, { mtime: number; size: number }> = new Map();
			if (mode === "authoritative") {
				changed = eligibleFiles;
				allStats = await collectFileStats(this.deps.app, eligibleFiles);
				skippedByIndex = 0;
			} else {
				const indexResult = await filterChangedFiles(
					this.deps.app,
					eligibleFiles,
					this.deps.getDiskIndex(),
				);
				changed = indexResult.changed;
				unchanged = indexResult.unchanged;
				allStats = indexResult.allStats;
				skippedByIndex = unchanged.length;
			}

			for (const file of unchanged) {
				const existingText = vaultSync.getTextForPath(file.path);
				if (existingText) {
					continue;
				}
				try {
					const content = await this.deps.app.vault.read(file);
					if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
						oversizedCount++;
						continue;
					}
					diskFiles.set(file.path, content);
				} catch (err) {
					console.error(`[yaos] Failed to read "${file.path}":`, err);
				}
			}

			for (const file of changed) {
				try {
					const content = await this.deps.app.vault.read(file);
					if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
						oversizedCount++;
						this.deps.log(`reconcile: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
						continue;
					}
					diskFiles.set(file.path, content);
				} catch (err) {
					console.error(`[yaos] Failed to read "${file.path}" during reconciliation:`, err);
				}
			}

			if (excludedCount > 0) {
				this.deps.log(`reconcile: excluded ${excludedCount} files by pattern`);
			}
			if (oversizedCount > 0) {
				this.deps.log(`reconcile: skipped ${oversizedCount} oversized files`);
				new Notice(`YAOS: skipped ${oversizedCount} files exceeding ${runtimeConfig.maxFileSizeKB} KB size limit.`);
			}
			if (skippedByIndex > 0) {
				this.deps.log(`reconcile: ${skippedByIndex} files unchanged (stat match), ${changed.length} changed`);
			}

			this.deps.log(
				`Reconciling [${mode}]: diskPresent=${diskPresentPaths.size}, ` +
				`diskLoaded=${diskFiles.size} (${changed.length} read) vs ` +
				`${vaultSync.getActiveMarkdownPaths().length} CRDT paths`,
			);
			this.deps.trace("reconcile", "reconcile-scan-complete", {
				mode,
				diskPresentCount: diskPresentPaths.size,
				diskLoadedCount: diskFiles.size,
				changedCount: changed.length,
				unchangedCount: unchanged.length,
				skippedByIndex,
				excludedCount,
				oversizedCount,
				crdtPathCount: vaultSync.getActiveMarkdownPaths().length,
			});

			const result = vaultSync.reconcileVault(
				diskFiles,
				diskPresentPaths,
				mode,
				this.deps.getSettings().deviceName,
				/**
				 * Spec: .kiro/specs/no-event-reconcile-admission/requirements.md R2.
				 *
				 * Architectural decision: Option (b) — opId-factory callback.
				 * For every authoritative-lane `seed-to-crdt` decision, mint a
				 * shared `opId` and fire `reconcile.file.decision` BEFORE the
				 * CRDT mutation. `vaultSync.reconcileVault` then threads the
				 * same opId into `ensureFile`, so the resulting
				 * `crdt.file.created` envelope carries it. The post-loop
				 * `seededToCrdt` iterator below performs only the
				 * `settledHashes` baseline bookkeeping for these paths — the
				 * decision emission has already happened here.
				 */
				(path) => {
					const opId = `op-reconcile-seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
					return {
						opId,
						emitDecision: () => {
							this.deps.recordFlightPathEvent?.({
								priority: "important",
								kind: FLIGHT_KIND.reconcileFileDecision,
								severity: "info",
								scope: "file",
								source: "reconciliationController",
								layer: "reconcile",
								path,
								opId,
								data: {
									decision: "seed-disk-to-crdt",
									reason: "disk-file-not-in-crdt",
									conflictRisk: "none",
								},
							});
						},
					};
				},
			);

			let flushedCreates = 0;
			let flushedUpdates = 0;
			let safetyBrakeTriggered = false;
			let safetyBrakeReason: string | null = null;

			const localFileCount = diskPresentPaths.size;
			const destructiveCount = result.updatedOnDisk.length;
			const destructiveRatio = localFileCount > 0
				? destructiveCount / localFileCount
				: 0;
			if (destructiveCount > 20 && destructiveRatio > 0.25) {
				safetyBrakeTriggered = true;
				safetyBrakeReason =
					`refusing to overwrite ${destructiveCount} local files ` +
					`(${Math.round(destructiveRatio * 100)}% of disk files)`;
				this.deps.log(`Reconcile safety brake: ${safetyBrakeReason}.`);
				console.error(`[yaos] Reconcile safety brake: ${safetyBrakeReason}.`);
				new Notice(
					`YAOS: Reconcile safety brake — ${safetyBrakeReason}. ` +
					`Additive creates will continue. Export diagnostics and inspect logs.`,
				);
				this.deps.trace("reconcile", "reconcile-safety-brake-blocked", {
					mode,
					destructiveCount,
					destructiveRatio,
					localFileCount,
					reason: safetyBrakeReason,
					...tracePathList("affected", result.updatedOnDisk),
				});
			}

			// Emit reconcile.file.decision for tombstoned and untracked paths
			// (diagnostic only — no side effects, safe outside safetyBrake guard).
			for (const conflict of result.tombstonedDiskConflicts ?? []) {
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: FLIGHT_KIND.reconcileFileDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "reconcile",
					path: conflict.path,
					data: {
						decision: "skip-tombstoned",
						reason: conflict.reason,
						action: conflict.action,
						conflictRisk: "tombstone-disk-conflict",
					},
				});
			}
			for (const path of result.untracked) {
				this.deps.recordFlightPathEvent?.({
					priority: "verbose",
					kind: FLIGHT_KIND.reconcileFileDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "reconcile",
					path,
					data: {
						decision: "skip-untracked",
						reason: "conservative-mode-no-auto-seed",
						conflictRisk: "none",
					},
				});
			}
			if (!safetyBrakeTriggered) {
				// Content hashes for files settled cleanly this reconcile.
				// Stored in the disk index as the three-way baseline for the
				// next startup reconcile (after plugin disable/re-enable).
				const settledHashes = new Map<string, string>();

				const updatesToFlush: string[] = [];
				for (const path of result.createdOnDisk) {
					this.deps.recordFlightPathEvent?.({
						priority: "important",
						kind: FLIGHT_KIND.reconcileFileDecision,
						severity: "info",
						scope: "file",
						source: "reconciliationController",
						layer: "reconcile",
						path,
						data: {
							decision: "write-crdt-to-disk",
							reason: "crdt-file-missing-on-disk",
							conflictRisk: "none",
						},
					});
					await diskMirror.flushWrite(path);
					flushedCreates++;
					// Record settled baseline hash: CRDT content was written to disk
					const ytext = vaultSync.getTextForPath(path);
					if (ytext) {
						const crdtContent = yTextToString(ytext) ?? "";
						settledHashes.set(path, await contentBaselineHash(crdtContent));
					}
				}
				for (const path of result.seededToCrdt) {
					// Spec R2 / Option (b): the `reconcile.file.decision`
					// emission for seeded paths is now produced by the
					// admission-opId factory passed into `reconcileVault`
					// above (BEFORE the `ensureFile` call) so the decision
					// envelope shares an `opId` with the resulting
					// `crdt.file.created`. This loop handles only the
					// settled-baseline bookkeeping.
					// Record settled baseline hash: disk content was the authority
					const diskContent = diskFiles.get(path);
					if (diskContent !== undefined) {
						settledHashes.set(path, await contentBaselineHash(diskContent));
					}
				}
				for (const path of result.updatedOnDisk) {
					const diskContent = diskFiles.get(path);
					const ytext = vaultSync.getTextForPath(path);
					const isOpenOrBound =
						(this.deps.getEditorBindings()?.isBound(path) ?? false) ||
						this.getOpenMarkdownViewsForPath(path).length > 0;
					if (
						mode === "authoritative" &&
						!isOpenOrBound &&
						diskContent !== undefined &&
						ytext
					) {
						const crdtContent = yTextToString(ytext) ?? "";
						// SHA-256 hashes for three-way authority decision.
						// Must be collision-resistant — a false equality means
						// "unchanged" which could silently overwrite a local edit.
						const diskHash = await contentBaselineHash(diskContent);
						const crdtHash = await contentBaselineHash(crdtContent);
						// Use persisted baseline hash to determine what actually changed:
						//   disk == baseline → CRDT changed only → apply-remote-to-disk
						//   crdt == baseline → disk changed only → import-disk-to-crdt (clean win)
						//   both != baseline → both changed      → preserve-conflict/both-changed
						//   baseline null    → unknown           → preserve-conflict/missing-baseline
						const baselineHash = this.deps.getDiskIndex()[path]?.contentHash ?? null;
						const diskMtimeRaw = allStats.get(path)?.mtime;
						const lastDiskIndexPersistedAt = this.deps.getLastSaveDiskIndexAt?.() ?? undefined;
						const decision = decideClosedFileConflict({
							baselineHash,
							diskHash,
							crdtHash,
							diskMtime: diskMtimeRaw,
							lastDiskIndexPersistedAt,
						});
					this.deps.recordFlightPathEvent?.({
						priority: decision.kind === "preserve-conflict" ? "critical" : "important",
						kind: FLIGHT_KIND.reconcileFileDecision,
						severity: "info",
						scope: "file",
						source: "reconciliationController",
						layer: "reconcile",
						path,
						data: {
							decision: decision.kind,
							reason: "reason" in decision ? decision.reason : null,
							winner: "winner" in decision ? decision.winner : null,
							diskLength: diskContent.length,
							crdtLength: crdtContent.length,
							diskHash,
							crdtHash,
							baselineHash,
							diskChangedSinceBaseline: baselineHash !== null ? diskHash !== baselineHash : null,
							conflictRisk:
								decision.kind === "preserve-conflict"
									? "reason" in decision && decision.reason === "both-changed"
										? "high"
										: "ambiguous"
									: "none",
							// Missing-baseline diagnostic fields — only present when
							// reason === "missing-baseline". Explains exactly why disk or
							// CRDT was chosen so future trace readers don't have to guess.
							...(decision.kind === "preserve-conflict" && decision.reason === "missing-baseline" && {
								missingBaselinePolicy: (decision as { _missingBaselinePolicy?: string })._missingBaselinePolicy ?? null,
								diskMtime: diskMtimeRaw ?? null,
								lastDiskIndexPersistedAt: lastDiskIndexPersistedAt ?? null,
								mtimeEvidence: diskMtimeRaw !== undefined && lastDiskIndexPersistedAt !== undefined,
							}),
						},
					});
						if (decision.kind === "preserve-conflict") {
							try {
								const preservedContent = decision.preserveDisk ? diskContent : crdtContent;
								const preservedSide = decision.preserveDisk ? "disk" : "crdt";
								const conflictPath = await this.createMarkdownConflictArtifact(
									path,
									preservedContent,
									`closed-file-${decision.reason}`,
									preservedSide,
								);
								if (decision.winner === "disk") {
									forceReplaceYText(ytext, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
									// Disk wins main file; record disk content as new settled baseline
									settledHashes.set(path, diskHash);
								} else {
									updatesToFlush.push(path);
									// CRDT wins main file; flushed below, record hash after flush
								}
								this.deps.trace("conflict", "closed-file-conflict-preserved", {
									path,
									conflictPath,
									reason: decision.reason,
									winner: decision.winner,
									preservedSide,
									diskLength: diskContent.length,
									crdtLength: crdtContent.length,
								});
								if (decision.winner === "disk") {
									flushedUpdates++;
								}
								continue;
							} catch (err) {
								diskMirror.recordPreservedUnresolved(
									path,
									"conflict-artifact-write-failed",
								);
								this.deps.trace("conflict", "closed-file-conflict-preserve-failed", {
									path,
									reason: decision.reason,
									error: err instanceof Error ? err.message : String(err),
								});
								continue;
							}
						}
						if (decision.kind === "import-disk-to-crdt") {
							// Disk changed, CRDT is still at baseline. Disk wins cleanly.
							// Import disk content into CRDT — no conflict artifact needed.
							forceReplaceYText(ytext, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
							settledHashes.set(path, diskHash);
							this.deps.trace("reconcile", "closed-file-disk-wins-clean", {
								path,
								reason: decision.reason,
								diskLength: diskContent.length,
								crdtLength: crdtContent.length,
							});
							flushedUpdates++;
							continue;
						}
						// decision.kind === "apply-remote-to-disk" or "no-op":
						// CRDT wins or nothing to do. Fall through to flush.
					}
					updatesToFlush.push(path);
				}
				for (const path of updatesToFlush) {
					await diskMirror.flushWrite(path);
					flushedUpdates++;
					// Record settled baseline hash: CRDT content was written to disk
					const ytext = vaultSync.getTextForPath(path);
					if (ytext) {
						settledHashes.set(path, await contentBaselineHash(yTextToString(ytext) ?? ""));
					}
				}

				// Pass settled hashes to disk index so they survive plugin reload
				// and serve as the three-way baseline next startup reconcile.
				const blockedIndexPathsInner: string[] = [];
				this.blockedDivergenceCount = 0;
				// Do NOT clear lastBlockedDivergenceAt — it serves as "last seen"
				// historical marker. Do NOT clear sample — remains available as
				// "last blocked sample" even when count resets.
				this.deps.setDiskIndex(updateIndex(this.deps.getDiskIndex(), allStats, {
					excludePaths: blockedIndexPathsInner,
					settledHashes,
				}));
			} else {
				// Safety brake triggered: exclude all planned updates from index.
				const blockedIndexPaths = result.updatedOnDisk;
				this.blockedDivergenceCount = blockedIndexPaths.length;
				this.lastBlockedDivergenceAt = new Date().toISOString();
				this.blockedDivergenceSample = blockedIndexPaths.slice(0, 10).map((p) => {
					const dot = p.lastIndexOf(".");
					const ext = dot >= 0 ? p.slice(dot) : "(none)";
					return { ext, hash: contentFingerprint(`${this.diagnosticPathSalt}:${p}`) };
				});
				this.deps.setDiskIndex(updateIndex(this.deps.getDiskIndex(), allStats, {
					excludePaths: blockedIndexPaths,
				}));
				this.deps.trace("reconcile", "reconcile-disk-index-advance-blocked", {
					mode,
					blockedCount: blockedIndexPaths.length,
					...tracePathList("blocked", blockedIndexPaths),
				});
			}

			this.lastReconcileStats = {
				at: new Date().toISOString(),
				mode,
				plannedCreates: result.createdOnDisk.length,
				plannedUpdates: result.updatedOnDisk.length,
				flushedCreates,
				flushedUpdates,
				safetyBrakeTriggered,
				safetyBrakeReason,
			};
			this.deps.trace("reconcile", "reconcile-authority-summary", {
				mode,
				seededToCrdtCount: result.seededToCrdt.length,
				createdOnDiskCount: result.createdOnDisk.length,
				updatedOnDiskCount: result.updatedOnDisk.length,
				flushedCreates,
				flushedUpdates,
				untrackedCount: result.untracked.length,
				tombstoneSkippedCount: result.skipped,
				safetyBrakeTriggered,
				safetyBrakeReason,
				...tracePathList("created", result.createdOnDisk),
				...tracePathList("blockedUpdate", safetyBrakeTriggered ? result.updatedOnDisk : []),
			});

			this.untrackedFiles = result.untracked;
			this.reconciled = true;
			void this.deps.saveDiskIndex();

			const integrity = vaultSync.runIntegrityChecks();
			if (integrity.duplicateIds > 0 || integrity.orphansCleaned > 0) {
				this.deps.log(
					`Integrity: ${integrity.duplicateIds} duplicate IDs fixed, ` +
					`${integrity.orphansCleaned} orphans cleaned`,
				);
			}

			this.deps.log(
				`Reconciliation [${mode}] complete: ` +
				`${result.seededToCrdt.length} seeded, ` +
				`creates planned/flushed=${result.createdOnDisk.length}/${flushedCreates}, ` +
				`updates planned/flushed=${result.updatedOnDisk.length}/${flushedUpdates}, ` +
				`${result.untracked.length} untracked, ` +
				`${result.skipped} tombstoned` +
				(safetyBrakeTriggered ? ", safety-brake=on" : ", safety-brake=off"),
			);

			this.deps.recordFlightEvent?.({
				priority: safetyBrakeTriggered ? "critical" : "important",
				kind: safetyBrakeTriggered ? "reconcile.safety_brake.triggered" : "reconcile.complete",
				severity: safetyBrakeTriggered ? "warn" : "info",
				scope: "vault",
				source: "reconciliationController",
				layer: "reconcile",
				data: {
					mode,
					seededToCrdt: result.seededToCrdt.length,
					createdOnDisk: result.createdOnDisk.length,
					updatedOnDisk: result.updatedOnDisk.length,
					flushedCreates,
					flushedUpdates,
					untracked: result.untracked.length,
					tombstonedSkipped: result.skipped,
					safetyBrakeTriggered,
					safetyBrakeReason,
				},
			});

			const blobSync = this.deps.getBlobSync();
			if (blobSync) {
				const blobResult = blobSync.reconcile(
					mode,
					runtimeConfig.excludePatterns,
				);
				this.deps.log(
					`Blob reconciliation [${mode}]: ` +
					`${blobResult.uploadQueued} uploads, ` +
					`${blobResult.downloadQueued} downloads, ` +
					`${blobResult.skipped} skipped`,
				);
			}
			this.deps.onReconciled(`reconcile-${mode}`);
		} finally {
			this.reconcileInFlight = false;
			this.lastReconcileTime = Date.now();
			this.deps.scheduleTraceStateSnapshot(`reconcile-${mode}`);
		}
	}

	async importUntrackedFiles(): Promise<void> {
		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;

		const diskMirror = this.deps.getDiskMirror();
		const toImport = [...this.untrackedFiles];
		this.untrackedFiles = [];
		let imported = 0;

		for (const path of toImport) {
			if (vaultSync.getTextForPath(path)) {
				this.deps.log(`importUntracked: "${path}" now in CRDT, skipping`);
				continue;
			}

			// Guard: do NOT auto-revive paths that were preserved during a
			// remote-delete with unknown baseline. These files sit on disk to
			// avoid data loss, but auto-importing them would resurrect the
			// tombstoned entry — exactly the zombie-file bug we fixed.
			if (diskMirror?.isPreservedUnresolved(path)) {
				this.deps.log(`importUntracked: "${path}" is preserved-unresolved remote delete, skipping auto-revive`);
				this.deps.trace("reconcile", "import-untracked-skipped-preserved-unresolved", {
					path,
				});
				continue;
			}

			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.deps.app.vault.read(file);
				// Spec: .kiro/specs/no-event-reconcile-admission/requirements.md R2.7.
				// Mint a per-path `op-import-untracked-*` opId BEFORE the CRDT
				// mutation so the resulting `crdt.file.created` envelope is
				// causally linkable to this admission attempt.
				const opId = `op-import-untracked-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				// Untracked files exist on disk but have no CRDT entry. If the
				// path is tombstoned, the user explicitly placed the file after
				// deletion — that is a deliberate revive, not a stale ghost.
				const result = vaultSync.ensureFile(
					path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: true,
						reviveReason: "import-untracked-local-file",
						opId,
					},
				);
				if (result) {
					imported++;
				} else {
					this.deps.log(`importUntracked: "${path}" could not be imported (ensureFile returned null)`);
				}
			} catch (err) {
				console.error(`[yaos] importUntracked failed for "${path}":`, err);
			}
		}

		if (!vaultSync.isInitialized) {
			vaultSync.markInitialized();
		}

		this.deps.refreshStatusBar();
		this.deps.log(`Imported ${imported} previously untracked files`);

		if (imported > 0) {
			new Notice(`YAOS: imported ${imported} files after server sync.`);
		}
	}

	markMarkdownDirty(file: TFile, reason: "create" | "modify", opId?: string): void {
		const previous = this.dirtyMarkdownPaths.get(file.path);
		if (!previous) {
			this.dirtyMarkdownPaths.set(file.path, {
				reason,
				primaryOpId: opId,
				coalescedOpIds: opId ? [opId] : [],
			});
		} else {
			// Keep "create" if either is "create" (higher priority)
			const mergedReason = previous.reason === "create" || reason === "create" ? "create" : "modify";
			// Append new opId to coalesced list
			const coalescedOpIds = [...previous.coalescedOpIds];
			if (opId && !coalescedOpIds.includes(opId)) {
				coalescedOpIds.push(opId);
			}
			this.dirtyMarkdownPaths.set(file.path, {
				reason: mergedReason,
				primaryOpId: previous.primaryOpId ?? opId,
				coalescedOpIds,
			});
		}
		this.lastMarkdownDirtyAt = Date.now();
		this.scheduleMarkdownDrain();
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
		const entry = this.dirtyMarkdownPaths.get(oldPath);
		if (!entry) return;

		this.dirtyMarkdownPaths.delete(oldPath);

		const existing = this.dirtyMarkdownPaths.get(newPath);
		if (existing) {
			// Merge — preserve create priority, coalesce op IDs.
			this.dirtyMarkdownPaths.set(newPath, {
				reason: existing.reason === "create" || entry.reason === "create" ? "create" : "modify",
				primaryOpId: existing.primaryOpId ?? entry.primaryOpId,
				coalescedOpIds: Array.from(new Set([
					...existing.coalescedOpIds,
					...entry.coalescedOpIds,
				])),
			});
		} else {
			this.dirtyMarkdownPaths.set(newPath, entry);
		}

		const label = entry.reason === "create" ? "race recovery" : "modify redirect";
		this.deps.log(`redirectPendingDirtyPath(${entry.reason}): "${oldPath}" -> "${newPath}" (${label})`);
		this.scheduleMarkdownDrain();
	}

	/** @deprecated Use redirectPendingDirtyPath. Kept for compatibility during transition. */
	redirectPendingCreate(oldPath: string, newPath: string): void {
		this.redirectPendingDirtyPath(oldPath, newPath);
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
		if (this.dirtyMarkdownPaths.delete(path)) {
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

	private scheduleMarkdownDrain(): void {
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
		}
		const elapsed = Date.now() - this.lastMarkdownDirtyAt;
		const delay = Math.max(0, MARKDOWN_DIRTY_SETTLE_MS - elapsed);
		this.markdownDrainTimer = setTimeout(() => {
			this.markdownDrainTimer = null;
			const sinceLastDirty = Date.now() - this.lastMarkdownDirtyAt;
			if (sinceLastDirty < MARKDOWN_DIRTY_SETTLE_MS) {
				this.scheduleMarkdownDrain();
				return;
			}
			this.kickMarkdownDrain();
		}, delay);
	}

	private kickMarkdownDrain(): void {
		if (this.markdownDrainPromise) return;
		this.markdownDrainPromise = this.drainDirtyMarkdownPaths()
			.catch((err) => {
				console.error("[yaos] markdown drain failed:", err);
			})
			.finally(() => {
				this.markdownDrainPromise = null;
				if (this.dirtyMarkdownPaths.size > 0) {
					this.scheduleMarkdownDrain();
				}
			});
	}

	private async drainDirtyMarkdownPaths(): Promise<void> {
		if (this.dirtyMarkdownPaths.size === 0) return;
		const batch = Array.from(this.dirtyMarkdownPaths.entries());
		this.dirtyMarkdownPaths.clear();

		for (const [path, { reason, primaryOpId, coalescedOpIds }] of batch) {
			await this.processDirtyMarkdownPath(path, reason, primaryOpId, coalescedOpIds);
		}
	}

	private async processDirtyMarkdownPath(
		path: string,
		reason: "create" | "modify",
		opId?: string,
		coalescedOpIds?: string[],
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

		await this.syncFileFromDisk(abstractFile, reason, opId, coalescedOpIds);
	}

	private async syncFileFromDisk(
		file: TFile,
		sourceReason: "create" | "modify" = "modify",
		opId?: string,
		coalescedOpIds?: string[],
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

		const effectivePolicy = this.__qaExternalEditPolicyOverride ?? runtimeConfig.externalEditPolicy;
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
			const content = await this.deps.app.vault.read(file);

			if (runtimeConfig.maxFileSizeBytes > 0 && content.length > runtimeConfig.maxFileSizeBytes) {
				this.deps.log(`syncFileFromDisk: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
				return;
			}
			const existingText = vaultSync.getTextForPath(file.path);

			if (wasBound && isOpenInEditor) {
				const handledBound = await this.handleBoundFileSyncGap(
					file,
					content,
					existingText,
					openViews,
					sourceReason,
				);
				if (handledBound) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}
			}

			if (existingText) {
				const crdtContent = existingText.toJSON();
				if (crdtContent === content) {
					// recovery.skipped: CRDT and disk already agree (unbound second-pass no-op).
					// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.1
					this.deps.recordFlightPathEvent?.({
						priority: "verbose",
						kind: FLIGHT_KIND.recoverySkipped,
						severity: "info",
						scope: "file",
						source: "reconciliationController",
						layer: "recovery",
						path: file.path,
						data: {
							reason: "crdt-current-no-op",
							wasBound: false,
						},
					});
					return;
				}
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent,
					content,
					"disk-to-crdt",
				)) {
					this.recordFrontmatterIngestBlocked(file.path, false, "disk-to-crdt-existing");
					await this.updateDiskIndexForPath(file.path);
					return;
				}

				this.deps.log(
					`syncFileFromDisk: applying diff to "${file.path}" (${crdtContent.length} -> ${content.length} chars)`,
				);
				vaultSync.serverAckTracker.withActiveOpId(opId, () => {
					applyDiffToYText(existingText, crdtContent, content, ORIGIN_DISK_SYNC);
				});
				// Emit crdt.file.updated with the same opId that triggered this disk→CRDT write.
				const fileId = vaultSync.getFileIdForText(existingText) ?? undefined;
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: FLIGHT_KIND.crdtFileUpdated,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "crdt",
					path: file.path,
					opId,
					fileId,
					data: {
						originKind: "disk-sync",
						...(coalescedOpIds && coalescedOpIds.length > 1 ? { coalescedOpIds } : {}),
					},
				});
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"disk-to-crdt-seed",
				)) {
					this.recordFrontmatterIngestBlocked(file.path, false, "disk-to-crdt-seed");
					await this.updateDiskIndexForPath(file.path);
					return;
				}
				vaultSync.serverAckTracker.withActiveOpId(opId, () => {
					vaultSync.ensureFile(
						file.path,
						content,
						this.deps.getSettings().deviceName,
						{
							reviveTombstone: sourceReason === "create",
							reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
							opId,
						},
					);
				});
			}

			await this.updateDiskIndexForPath(file.path, content);
		} catch (err) {
			console.error(`[yaos] syncFileFromDisk failed for "${file.path}":`, err);
		}
	}

	/**
	 * QA-ONLY. Unsafe. Do not call from production code.
	 *
	 * Forces a disk→CRDT sync pass for a single path, deterministically
	 * exercising editor-bound recovery paths without waiting for a real
	 * filesystem event. Used only in forced-recovery regression scenarios.
	 */
	async __qaOnlyForceSyncFileFromDiskUnsafe(path: string, reason: "create" | "modify" = "modify"): Promise<void> {
		const abstractFile = this.deps.app.vault.getAbstractFileByPath(path);
		if (!(abstractFile instanceof TFile)) {
			throw new Error(`__qaOnlyForceSyncFileFromDiskUnsafe: not a file: ${path}`);
		}
		await this.syncFileFromDisk(abstractFile, reason);
	}

	/** QA-ONLY. Unsafe. Pause editor->CRDT propagation while keeping bound state. */
	__qaOnlyPauseEditorBindingPropagationUnsafe(path: string): boolean {
		return this.deps.getEditorBindings()?.__qaOnlyPauseBindingPropagationUnsafe(path) ?? false;
	}

	/** QA-ONLY. Unsafe. Resume editor->CRDT propagation after a pause. */
	__qaOnlyResumeEditorBindingPropagationUnsafe(path: string): boolean {
		return this.deps.getEditorBindings()?.__qaOnlyResumeBindingPropagationUnsafe(
			path,
			this.deps.getSettings().deviceName,
		) ?? false;
	}

	/**
	 * QA-ONLY. Unsafe. Sets an in-memory-only override for the external edit policy.
	 * Does NOT persist, does NOT push update metadata, does NOT dirty settings.
	 * Returns the previous effective policy (override or real setting).
	 * Pass null to clear the override.
	 */
	__qaOnlySetExternalEditPolicyOverrideUnsafe(
		policy: import("../settings").ExternalEditPolicy | null,
	): import("../settings").ExternalEditPolicy {
		const previous = this.__qaExternalEditPolicyOverride
			?? this.deps.getRuntimeConfig().externalEditPolicy;
		this.__qaExternalEditPolicyOverride = policy;
		return previous;
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
			// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.2
			this.deps.recordFlightPathEvent?.({
				priority: "verbose",
				kind: FLIGHT_KIND.recoverySkipped,
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
			// See spec: .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.8.
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
			// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.1
			this.deps.recordFlightPathEvent?.({
				priority: "verbose",
				kind: FLIGHT_KIND.recoverySkipped,
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
			// See spec: .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.8.
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
				//
				// See spec:
				// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R2.
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
						kind: FLIGHT_KIND.recoverySkipped,
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
					this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-local-only-divergence");
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound local-only divergence: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
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
			const _rsh1 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
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
				kind: FLIGHT_KIND.recoveryDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "bound-file-local-only-divergence",
					signature: recoverySignature("bound-file-local-only-divergence", crdtContent ?? "", content),
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
					...(_rsh1 ? { recoveryStateHash: _rsh1 } : {}),
				},
			});
				// Monotonic-growth amplification quarantine: independent of
				// fingerprint identity. Catches typing-cadence loops where every
				// cycle has a different (prevLen, nextLen) but the lengths grow
				// along the same axis. See spec:
				// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
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
					kind: FLIGHT_KIND.recoveryApplyStart,
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
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_RECOVER_BOUND,
				);
			traceRecoveryPostcondition(
				this.deps.trace,
				this.deps.recordFlightPathEvent,
				file.path,
				"bound-file-local-only-divergence",
				ORIGIN_DISK_SYNC_RECOVER_BOUND,
				content.length,
				recoveryResult,
			);
				this.deps.recordFlightPathEvent?.({
					priority: recoveryResult.forceReplaceApplied ? "critical" : "important",
					kind: FLIGHT_KIND.recoveryApplyDone,
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
					this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-local-only-seed");
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound, missing CRDT text: seeding ${content.length} chars)`,
				);
				const _rsh2 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: FLIGHT_KIND.recoveryDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-local-only-seed",
						signature: recoverySignature("bound-file-local-only-seed", "", content),
						action: "seed-crdt-from-disk",
						diskLength: content.length,
						...(_rsh2 ? { recoveryStateHash: _rsh2 } : {}),
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
					kind: FLIGHT_KIND.recoveryApplyStart,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: { reason: "bound-file-local-only-seed", action: "seed-crdt-from-disk", diskLength: content.length },
				});
				vaultSync?.ensureFile(
					file.path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
				const recoveredContent = yTextToString(vaultSync?.getTextForPath(file.path));
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
			//
			// See spec:
			// .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R7.
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
				// See spec: .kiro/specs/controller-recovery-orchestration/requirements.md R2.3
				this.deps.recordFlightPathEvent?.({
					priority: "verbose",
					kind: FLIGHT_KIND.recoverySkipped,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "recent-editor-activity",
						idleMs: Date.now() - lastEditorActivity!,
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
					this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-open-idle-disk-recovery");
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound external disk edit while idle: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
			const _rsh3 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
			this.deps.recordFlightPathEvent?.({
				priority: "important",
				kind: FLIGHT_KIND.recoveryDecision,
				severity: "info",
				scope: "file",
				source: "reconciliationController",
				layer: "recovery",
				path: file.path,
				data: {
					reason: "bound-file-open-idle-disk-recovery",
					signature: recoverySignature("bound-file-open-idle-disk-recovery", crdtContent ?? "", content),
					action: "apply-diff",
					diskLength: content.length,
					crdtLength: crdtContent?.length ?? null,
					// Branch predicates
					editorEqualsDisk: false,
					editorEqualsCrdt: crdtOnlyViews.length > 0,
					diskFingerprintPrefix: contentFingerprint(content).slice(0, 8),
					crdtFingerprintPrefix: crdtContent ? contentFingerprint(crdtContent).slice(0, 8) : null,
					...(_rsh3 ? { recoveryStateHash: _rsh3 } : {}),
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
					kind: FLIGHT_KIND.recoveryApplyStart,
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
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
				);
			traceRecoveryPostcondition(
				this.deps.trace,
				this.deps.recordFlightPathEvent,
				file.path,
				"bound-file-open-idle-disk-recovery",
				ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
				content.length,
				recoveryResult,
			);
				this.deps.recordFlightPathEvent?.({
					priority: recoveryResult.forceReplaceApplied ? "critical" : "important",
					kind: FLIGHT_KIND.recoveryApplyDone,
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
					this.recordFrontmatterIngestBlocked(file.path, true, "bound-file-open-idle-seed");
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound idle disk edit, missing CRDT text: seeding ${content.length} chars)`,
				);
				const _rsh4 = await this.deps.computeRecoveryStateHash?.(file.path, content) ?? undefined;
				this.deps.recordFlightPathEvent?.({
					priority: "important",
					kind: FLIGHT_KIND.recoveryDecision,
					severity: "info",
					scope: "file",
					source: "reconciliationController",
					layer: "recovery",
					path: file.path,
					data: {
						reason: "bound-file-open-idle-seed",
						signature: recoverySignature("bound-file-open-idle-seed", "", content),
						action: "seed-crdt-from-disk",
						diskLength: content.length,
						...(_rsh4 ? { recoveryStateHash: _rsh4 } : {}),
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
				vaultSync?.ensureFile(
					file.path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
				const recoveredContent = yTextToString(vaultSync?.getTextForPath(file.path));
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
				convergenceApplied = existingText.toString() === editorAuthority;
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
	 *
	 * See spec: .kiro/specs/frontmatter-guard-orchestration/requirements.md R2.
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
			kind: FLIGHT_KIND.recoverySkipped,
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
		const fingerprint = recoverySignature(reason, previousContent, nextContent);
		const now = Date.now();
		const previous = this.recoveryFingerprints.get(path);
		// Same fingerprint within the TTL window → increment.
		// Same fingerprint beyond the TTL → treat as fresh (count = 1).
		// Different fingerprint → always reset.
		const sameFingerprint = previous?.fingerprint === fingerprint;
		const withinTtl = sameFingerprint && (now - (previous?.lastAt ?? 0)) < RECOVERY_FINGERPRINT_TTL_MS;
		const count = withinTtl ? previous!.count + 1 : 1;
		this.recoveryFingerprints.set(path, { fingerprint, count, lastAt: now });

		// Cap map size: evict oldest entries when exceeded
		if (this.recoveryFingerprints.size > MAX_RECOVERY_FINGERPRINT_MAP_SIZE) {
			let oldestPath: string | null = null;
			let oldestAt = Infinity;
			for (const [p, entry] of this.recoveryFingerprints) {
				if (entry.lastAt < oldestAt) {
					oldestAt = entry.lastAt;
					oldestPath = p;
				}
			}
			if (oldestPath) this.recoveryFingerprints.delete(oldestPath);
		}

		if (count < MAX_REPEATED_RECOVERY_FINGERPRINTS) return false;

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
			kind: FLIGHT_KIND.recoveryQuarantined,
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
			kind: FLIGHT_KIND.recoveryLoopDetected,
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
	 *
	 * Predicate: the most recent `AMPLIFICATION_QUARANTINE_THRESHOLD` history
	 * entries (including the just-appended entry) all fall within
	 * `AMPLIFICATION_WINDOW_MS` and exhibit non-decreasing prevLen, non-
	 * decreasing nextLen, and strictly positive (nextLen - prevLen) deltas.
	 *
	 * See spec:
	 *   .kiro/specs/editor-bound-localonly-amplifier-guard/requirements.md R3.
	 */
	private shouldQuarantineAmplification(
		path: string,
		reason: string,
		prevLen: number,
		nextLen: number,
	): boolean {
		const now = Date.now();
		const entry: AmplificationEntry = { prevLen, nextLen, at: now };

		const existing = this.amplificationHistory.get(path) ?? [];
		existing.push(entry);
		// Keep at most MAX_AMPLIFICATION_HISTORY_ENTRIES, evict oldest.
		while (existing.length > MAX_AMPLIFICATION_HISTORY_ENTRIES) {
			existing.shift();
		}
		this.amplificationHistory.set(path, existing);

		// Cap global map size — share the same limit as recoveryFingerprints
		// so a single tunable governs both detectors' memory footprint.
		if (this.amplificationHistory.size > MAX_RECOVERY_FINGERPRINT_MAP_SIZE) {
			let oldestPath: string | null = null;
			let oldestAt = Infinity;
			for (const [p, entries] of this.amplificationHistory) {
				const last = entries[entries.length - 1];
				if (last && last.at < oldestAt) {
					oldestAt = last.at;
					oldestPath = p;
				}
			}
			if (oldestPath && oldestPath !== path) {
				this.amplificationHistory.delete(oldestPath);
			}
		}

		if (existing.length < AMPLIFICATION_QUARANTINE_THRESHOLD) return false;

		const slice = existing.slice(-AMPLIFICATION_QUARANTINE_THRESHOLD);
		const last = slice[slice.length - 1]!;
		// All entries must be within the window of the most recent one.
		const inWindow = slice.every((e) => last.at - e.at <= AMPLIFICATION_WINDOW_MS);
		if (!inWindow) return false;

		// Strictly positive delta in every entry.
		let allPositiveDelta = true;
		for (const e of slice) {
			if (e.nextLen - e.prevLen <= 0) {
				allPositiveDelta = false;
				break;
			}
		}
		if (!allPositiveDelta) return false;

		// Non-decreasing prevLen and non-decreasing nextLen across the slice.
		let monotonicPrev = true;
		let monotonicNext = true;
		for (let i = 1; i < slice.length; i++) {
			if (slice[i]!.prevLen < slice[i - 1]!.prevLen) monotonicPrev = false;
			if (slice[i]!.nextLen < slice[i - 1]!.nextLen) monotonicNext = false;
		}
		if (!monotonicPrev || !monotonicNext) return false;

		// Distinguish growth from stationary. Stationary same-fingerprint
		// loops are the fingerprint quarantine's job. The amplification
		// detector requires genuine growth across the window: both prevLen
		// and nextLen must be STRICTLY larger at the end of the slice
		// than at the beginning.
		const grew = slice[slice.length - 1]!.prevLen > slice[0]!.prevLen
			&& slice[slice.length - 1]!.nextLen > slice[0]!.nextLen;
		if (!grew) return false;

		// Diagnostic: did every entry have the same delta?
		const firstDelta = slice[0]!.nextLen - slice[0]!.prevLen;
		const consistentDelta = slice.every((e) => (e.nextLen - e.prevLen) === firstDelta);

		this.deps.trace("recovery", "recovery-amplification-quarantined", {
			path,
			reason,
			entries: slice.length,
			windowMs: AMPLIFICATION_WINDOW_MS,
			firstPrevLen: slice[0]!.prevLen,
			lastNextLen: last.nextLen,
			consistentDelta,
		});
		this.deps.log(
			`syncFileFromDisk: amplification-quarantined "${path}" ` +
			`(${reason}, ${slice.length} cycles, ${slice[0]!.prevLen} -> ${last.nextLen}, ` +
			`consistentDelta=${consistentDelta})`,
		);
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: FLIGHT_KIND.recoveryAmplificationQuarantined,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				entries: slice.length,
				windowMs: AMPLIFICATION_WINDOW_MS,
				firstPrevLen: slice[0]!.prevLen,
				lastNextLen: last.nextLen,
				consistentDelta,
			},
		});
		// Also emit recovery.loop.detected so existing loop-detection consumers
		// see this case. See spec R3.5.
		this.deps.recordFlightPathEvent?.({
			priority: "critical",
			kind: FLIGHT_KIND.recoveryLoopDetected,
			severity: "warn",
			scope: "file",
			source: "reconciliationController",
			layer: "recovery",
			path,
			data: {
				reason,
				detector: "amplification",
				entries: slice.length,
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

	private async updateDiskIndexForPath(path: string, settledContent?: string): Promise<void> {
		try {
			const stat = await this.deps.app.vault.adapter.stat(path);
			if (stat) {
				const existing = this.deps.getDiskIndex()[path];
				const nextEntry: import("../sync/diskIndex").DiskIndexEntry = {
					mtime: stat.mtime,
					size: stat.size,
					// Advance the baseline hash if settled content is provided.
					// This covers disk→CRDT imports (external edits while YAOS is running).
					contentHash: settledContent !== undefined
						? await contentBaselineHash(settledContent)
						: existing?.contentHash,
				};
				if (nextEntry.contentHash === undefined) {
					delete nextEntry.contentHash;
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
