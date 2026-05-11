import { App, MarkdownView, Notice, TFile } from "obsidian";
import type { BlobSyncManager } from "../sync/blobSync";
import type { DiskMirror } from "../sync/diskMirror";
import {
	type DiskIndex,
	collectFileStats,
	filterChangedFiles,
	updateIndex,
} from "../sync/diskIndex";
import type { ReconcileMode, VaultSync } from "../sync/vaultSync";
import type { VaultSyncSettings } from "../settings";
import type { RuntimeConfig } from "./runtimeConfig";
import type { EditorBindingManager } from "../sync/editorBinding";
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
	getAwaitingFirstProviderSyncAfterStartup(): boolean;
	setAwaitingFirstProviderSyncAfterStartup(value: boolean): void;
	saveDiskIndex(): Promise<void>;
	refreshStatusBar(): void;
	trace(source: string, msg: string, details?: Record<string, unknown>): void;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
}

const RECONCILE_COOLDOWN_MS = 10_000;
const MARKDOWN_DIRTY_SETTLE_MS = 350;
const OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200;
const BOUND_RECOVERY_LOCK_MS = 1500;
const TRACE_PATH_SAMPLE_LIMIT = 50;
const MAX_REPEATED_RECOVERY_FINGERPRINTS = 3;
const MAX_RECOVERY_FINGERPRINT_MAP_SIZE = 200;
/** Time-to-live for recovery fingerprint counts. If the same fingerprint
 *  recurs after this window, the count resets to 1 — preventing stale
 *  attempts from hours ago from poisoning future legitimate edits. */
const RECOVERY_FINGERPRINT_TTL_MS = 10 * 60_000; // 10 minutes

/**
 * Cheap FNV-1a-ish 32-bit hash for content fingerprinting.
 * NOT cryptographic — only for equality deduplication inside recovery
 * quarantine and conflict artifact dedupe. This is a cheap loop detector
 * and coalescing key, NOT a content identity or security primitive.
 * False collisions are possible but acceptable: the worst case is a
 * missed quarantine or an extra conflict artifact, not data corruption.
 * We deliberately avoid storing full note contents in the long-lived
 * map; only this fixed-size hash + content length is kept.
 */
function contentFingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16).padStart(8, "0") + ":" + text.length;
}

function tracePathList(prefix: string, paths: string[]): Record<string, unknown> {
	return {
		[`${prefix}PathCount`]: paths.length,
		[`${prefix}PathSample`]: paths.slice(0, TRACE_PATH_SAMPLE_LIMIT),
		[`${prefix}PathsTruncated`]: paths.length > TRACE_PATH_SAMPLE_LIMIT,
	};
}

function traceRecoveryPostcondition(
	trace: ReconciliationControllerDeps["trace"],
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
	private dirtyMarkdownPaths = new Map<string, "create" | "modify">();
	private closedOnlyDeferredImports = new Set<string>();
	private markdownDrainPromise: Promise<void> | null = null;
	private markdownDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMarkdownDirtyAt = 0;
	private boundRecoveryLocks = new Map<string, number>();
	private recoveryFingerprints = new Map<string, { fingerprint: string; count: number; lastAt: number }>();
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
		this.lastConflictFingerprints.clear();
		this.blockedDivergenceCount = 0;
		this.lastBlockedDivergenceAt = null;
		this.blockedDivergenceSample = [];
		this.lastConflictNoticeAt = 0;
		this.conflictNoticeSuppressionCount = 0;
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

			for (const path of result.createdOnDisk) {
				await diskMirror.flushWrite(path);
				flushedCreates++;
			}
			if (!safetyBrakeTriggered) {
				const updatesToFlush: string[] = [];
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
						const decision = decideClosedFileConflict({
							baselineHash: null,
							diskHash: contentFingerprint(diskContent),
							crdtHash: contentFingerprint(crdtContent),
						});
						if (decision.kind === "preserve-conflict") {
							try {
								const conflictPath = await this.createMarkdownConflictArtifact(
									path,
									crdtContent,
									`closed-file-${decision.reason}`,
									"crdt",
								);
								forceReplaceYText(ytext, diskContent, ORIGIN_DISK_SYNC_RECOVER_BOUND);
								this.deps.trace("conflict", "closed-file-conflict-preserved", {
									path,
									conflictPath,
									reason: decision.reason,
									winner: decision.winner,
									diskLength: diskContent.length,
									crdtLength: crdtContent.length,
								});
								flushedUpdates++;
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
					}
					updatesToFlush.push(path);
				}
				for (const path of updatesToFlush) {
					await diskMirror.flushWrite(path);
					flushedUpdates++;
				}
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

			const blockedIndexPaths = safetyBrakeTriggered ? result.updatedOnDisk : [];
			if (safetyBrakeTriggered) {
				this.blockedDivergenceCount = blockedIndexPaths.length;
				this.lastBlockedDivergenceAt = new Date().toISOString();
				// Keep a privacy-safer sample: extensions + session-salted
				// fingerprints (no raw filenames or stable cross-export IDs).
				this.blockedDivergenceSample = blockedIndexPaths.slice(0, 10).map((p) => {
					const dot = p.lastIndexOf(".");
					const ext = dot >= 0 ? p.slice(dot) : "(none)";
					return { ext, hash: contentFingerprint(`${this.diagnosticPathSalt}:${p}`) };
				});
			} else {
				this.blockedDivergenceCount = 0;
				// Do NOT clear lastBlockedDivergenceAt — it serves as "last seen"
				// historical marker. Do NOT clear sample — it remains
				// available as "last blocked sample" even when count resets.
			}
			this.deps.setDiskIndex(updateIndex(this.deps.getDiskIndex(), allStats, {
				excludePaths: blockedIndexPaths,
			}));
			if (blockedIndexPaths.length > 0) {
				this.deps.trace("reconcile", "reconcile-disk-index-advance-blocked", {
					mode,
					blockedCount: blockedIndexPaths.length,
					...tracePathList("blocked", blockedIndexPaths),
				});
			}
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

	markMarkdownDirty(file: TFile, reason: "create" | "modify"): void {
		const previous = this.dirtyMarkdownPaths.get(file.path);
		if (previous !== "create") {
			this.dirtyMarkdownPaths.set(file.path, reason);
		}
		this.lastMarkdownDirtyAt = Date.now();
		this.scheduleMarkdownDrain();
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

		void this.processDirtyMarkdownPath(path, "modify")
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

		for (const [path, reason] of batch) {
			await this.processDirtyMarkdownPath(path, reason);
		}
	}

	private async processDirtyMarkdownPath(
		path: string,
		reason: "create" | "modify",
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

		await this.syncFileFromDisk(abstractFile, reason);
	}

	private async syncFileFromDisk(
		file: TFile,
		sourceReason: "create" | "modify" = "modify",
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

		const policyDecision = decideExternalEditImport(runtimeConfig.externalEditPolicy, isOpenInEditor);
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
				if (crdtContent === content) return;
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent,
					content,
					"disk-to-crdt",
				)) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}

				this.deps.log(
					`syncFileFromDisk: applying diff to "${file.path}" (${crdtContent.length} -> ${content.length} chars)`,
				);
				applyDiffToYText(existingText, crdtContent, content, ORIGIN_DISK_SYNC);
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"disk-to-crdt-seed",
				)) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}
				vaultSync.ensureFile(
					file.path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
			}

			await this.updateDiskIndexForPath(file.path);
		} catch (err) {
			console.error(`[yaos] syncFileFromDisk failed for "${file.path}":`, err);
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
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-local-only-divergence",
				)) {
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
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-local-only-divergence",
					crdtContent ?? "",
					content,
				)) {
					return true;
				}
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_RECOVER_BOUND,
				);
				traceRecoveryPostcondition(
					this.deps.trace,
					file.path,
					"bound-file-local-only-divergence",
					ORIGIN_DISK_SYNC_RECOVER_BOUND,
					content.length,
					recoveryResult,
				);
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-local-only-seed",
				)) {
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound, missing CRDT text: seeding ${content.length} chars)`,
				);
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-local-only-seed",
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

			for (const state of localOnlyViews) {
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
				return true;
			}

			if (existingText) {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-open-idle-disk-recovery",
				)) {
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound external disk edit while idle: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
				if (this.shouldQuarantineRepeatedRecovery(
					file.path,
					"bound-file-open-idle-disk-recovery",
					crdtContent ?? "",
					content,
				)) {
					return true;
				}
				const recoveryResult = applyDiffToYTextWithPostcondition(
					existingText,
					crdtContent ?? "",
					content,
					ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
				);
				traceRecoveryPostcondition(
					this.deps.trace,
					file.path,
					"bound-file-open-idle-disk-recovery",
					ORIGIN_DISK_SYNC_OPEN_IDLE_RECOVER,
					content.length,
					recoveryResult,
				);
			} else {
				if (this.deps.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-open-idle-seed",
				)) {
					this.deps.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.deps.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound idle disk edit, missing CRDT text: seeding ${content.length} chars)`,
				);
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

	private shouldQuarantineRepeatedRecovery(
		path: string,
		reason: string,
		previousContent: string,
		nextContent: string,
	): boolean {
		const fingerprint = `${reason}\x00${contentFingerprint(previousContent)}\x00${contentFingerprint(nextContent)}`;
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
			previousLength: previousContent.length,
			nextLength: nextContent.length,
			previousHashPrefix: contentFingerprint(previousContent),
			nextHashPrefix: contentFingerprint(nextContent),
		});
		this.deps.log(
			`syncFileFromDisk: quarantined repeated recovery for "${path}" ` +
			`(${reason}, ${count} attempts)`,
		);
		this.deps.scheduleTraceStateSnapshot("recovery-quarantined");
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

	private async updateDiskIndexForPath(path: string): Promise<void> {
		try {
			const stat = await this.deps.app.vault.adapter.stat(path);
			if (stat) {
				const nextIndex = {
					...this.deps.getDiskIndex(),
					[path]: { mtime: stat.mtime, size: stat.size },
				};
				this.deps.setDiskIndex(nextIndex);
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
}
