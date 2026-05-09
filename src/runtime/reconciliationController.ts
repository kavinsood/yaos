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
import { applyDiffToYText } from "../sync/diff";
import { decideExternalEditImport } from "../sync/externalEditPolicy";
import { yTextToString } from "../utils/format";

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
			}

			for (const path of result.createdOnDisk) {
				await diskMirror.flushWrite(path);
				flushedCreates++;
			}
			if (!safetyBrakeTriggered) {
				for (const path of result.updatedOnDisk) {
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

			this.untrackedFiles = result.untracked;
			this.reconciled = true;

			this.deps.setDiskIndex(updateIndex(this.deps.getDiskIndex(), allStats));
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

		const toImport = [...this.untrackedFiles];
		this.untrackedFiles = [];
		let imported = 0;

		for (const path of toImport) {
			if (vaultSync.getTextForPath(path)) {
				this.deps.log(`importUntracked: "${path}" now in CRDT, skipping`);
				continue;
			}

			const file = this.deps.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.deps.app.vault.read(file);
				vaultSync.ensureFile(path, content, this.deps.getSettings().deviceName);
				imported++;
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
				const handledBound = this.handleBoundFileSyncGap(
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
				applyDiffToYText(existingText, crdtContent, content, "disk-sync");
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

	private handleBoundFileSyncGap(
		file: TFile,
		content: string,
		existingText: ReturnType<VaultSync["getTextForPath"]>,
		openViews: MarkdownView[] = this.getOpenMarkdownViewsForPath(file.path),
		sourceReason: "create" | "modify" = "modify",
	): boolean {
		const editorBindings = this.deps.getEditorBindings();
		const vaultSync = this.deps.getVaultSync();
		const now = Date.now();
		const lockUntil = this.boundRecoveryLocks.get(file.path) ?? 0;
		if (lockUntil > now) {
			this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, recovery lock)`);
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
				applyDiffToYText(existingText, crdtContent ?? "", content, "disk-sync-recover-bound");
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
				vaultSync?.ensureFile(
					file.path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
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
				applyDiffToYText(existingText, crdtContent ?? "", content, "disk-sync-open-idle-recover");
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
				vaultSync?.ensureFile(
					file.path,
					content,
					this.deps.getSettings().deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
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
		this.deps.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, ambiguous divergence)`);
		this.deps.scheduleTraceStateSnapshot("bound-file-ambiguous");
		return true;
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
}
