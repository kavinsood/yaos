import { MarkdownView, Notice, Plugin, TFile, arrayBufferToHex } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VaultSyncSettingTab,
	generateVaultId,
	type VaultSyncSettings,
} from "./settings";
import { SettingsStore } from "./settings/settingsStore";
import { VaultSync, type ReconcileMode } from "./sync/vaultSync";
import { SCHEMA_VERSION } from "./sync/vaultSync";
import { EditorBindingManager } from "./sync/editorBinding";
import { DiskMirror } from "./sync/diskMirror";
import { type BlobQueueSnapshot, type BlobSyncManager } from "./sync/blobSync";
import {
	type ServerCapabilities,
} from "./sync/serverCapabilities";
import { isMarkdownSyncable, isBlobSyncable } from "./types";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	extractFrontmatter,
	type FrontmatterValidationResult,
} from "./sync/frontmatterGuard";
import {
	clearFrontmatterQuarantinePath,
	readPersistedFrontmatterQuarantine,
	upsertFrontmatterQuarantineEntry,
	type FrontmatterQuarantineEntry,
} from "./sync/frontmatterQuarantine";
import {
	type DiskIndex,
	moveIndexEntries,
	waitForDiskQuiet,
} from "./sync/diskIndex";
import {
	type BlobHashCache,
	moveCachedHashes,
} from "./sync/blobHashCache";
import type { PreservedUnresolvedEntry } from "./sync/preservedUnresolved";
import {
	SnapshotService,
} from "./snapshots/snapshotService";
import {
	type TraceEventDetails,
	type TraceHttpContext,
} from "./debug/trace";
import { DiagnosticsService } from "./diagnostics/diagnosticsService";
import {
	CapabilityUpdateService,
	readPersistedServerCapabilitiesCache,
	readPersistedUpdateManifestCache,
	type PersistedServerCapabilitiesCache,
	type PersistedUpdateManifestCache,
	type UpdateState,
} from "./runtime/capabilityUpdateService";
import {
	ConnectionController,
	type ConnectionState,
} from "./runtime/connectionController";
import {
	buildRuntimeConfig,
	type RuntimeConfig,
} from "./runtime/runtimeConfig";
import {
	ReconciliationController,
} from "./runtime/reconciliationController";
import { AttachmentOrchestrator } from "./runtime/attachmentOrchestrator";
import { EditorWorkspaceOrchestrator } from "./runtime/editorWorkspaceOrchestrator";
import { SetupLinkController } from "./runtime/setupLinkController";
import { TraceRuntimeController } from "./runtime/traceRuntimeController";
import { registerCommands } from "./commands";
import {
	getSyncStatusLabel,
	renderConnectionState,
	renderSyncStatus,
	type SyncStatus,
} from "./status/statusBarController";
import { formatUnknown, yTextToString } from "./utils/format";
import { ConfirmModal } from "./ui/ConfirmModal";
import { runVfsTortureTest } from "./dev/vfsTortureTest";
import { runSchemaMigrationToV2 } from "./migrations/schemaV2";

type PersistedPluginState = Partial<VaultSyncSettings> & {
	_diskIndex?: DiskIndex;
	_blobHashCache?: BlobHashCache;
	_blobQueue?: BlobQueueSnapshot;
	_serverCapabilitiesCache?: PersistedServerCapabilitiesCache;
	_updateManifestCache?: PersistedUpdateManifestCache;
	_frontmatterQuarantine?: FrontmatterQuarantineEntry[];
	_preservedUnresolved?: PreservedUnresolvedEntry[];
};

export default class VaultCrdtSyncPlugin extends Plugin {
	settings: VaultSyncSettings = DEFAULT_SETTINGS;
	private readonly settingsStore = new SettingsStore<PersistedPluginState>({
		loadData: () => this.loadData(),
		saveData: (data) => this.saveData(data),
	});
	private runtimeConfig: RuntimeConfig | null = null;

	private vaultSync: VaultSync | null = null;
	private connectionController: ConnectionController | null = null;
	private editorBindings: EditorBindingManager | null = null;
	private diskMirror: DiskMirror | null = null;
	private attachmentOrchestrator: AttachmentOrchestrator | null = null;
	private editorWorkspace: EditorWorkspaceOrchestrator | null = null;
	private snapshotService: SnapshotService | null = null;
	private diagnosticsService: DiagnosticsService | null = null;
	private reconciliationController!: ReconciliationController;
	private setupLinkController: SetupLinkController | null = null;
	private traceRuntime: TraceRuntimeController | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;

	/** Parsed exclude patterns from settings. */
	private excludePatterns: string[] = [];

	/** Max file size in characters (derived from settings KB). */
	private maxFileSize = 0;

	/** Persisted disk index: {path -> {mtime, size}}. */
	private diskIndex: DiskIndex = {};

	/** Persisted blob hash cache: {path -> {mtime, size, hash}}. */
	private blobHashCache: BlobHashCache = {};

	/** Persisted blob queue snapshot for crash resilience. */
	private savedBlobQueue: BlobQueueSnapshot | null = null;
	private preservedUnresolvedEntries: PreservedUnresolvedEntry[] = [];
	private persistedState: PersistedPluginState = {};
	private persistWriteChain: Promise<void> = Promise.resolve();

	/** Pending stability checks for newly created/dropped files. */
	private pendingStabilityChecks = new Set<string>();

	/** In-memory ring of recent high-level plugin events. */
	private eventRing: Array<{ ts: string; msg: string }> = [];

	private capabilityUpdateService: CapabilityUpdateService | null = null;
	private commandsRegistered = false;
	private idbDegradedHandled = false;
	private frontmatterGuardNoticeFingerprints = new Map<string, string>();
	private frontmatterQuarantineEntries: FrontmatterQuarantineEntry[] = [];

	/**
	 * True when startup timed out waiting for provider sync.
	 * We use this to force one authoritative reconcile on the first late
	 * provider sync event, even if connection generation did not change.
	 */
	private awaitingFirstProviderSyncAfterStartup = false;
	private createReconciliationController(): ReconciliationController {
		this.reconciliationController = new ReconciliationController({
			app: this.app,
			getSettings: () => this.settings,
			getRuntimeConfig: () => this.getRuntimeConfig(),
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.getBlobSync(),
			getEditorBindings: () => this.editorBindings,
			getDiskIndex: () => this.diskIndex,
			setDiskIndex: (index) => {
				this.diskIndex = index;
			},
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			shouldBlockFrontmatterIngest: (path, previousContent, nextContent, reason) =>
				this.shouldBlockFrontmatterIngest(path, previousContent, nextContent, reason),
			refreshServerCapabilities: (reason) => this.refreshServerCapabilities(reason),
			validateOpenEditorBindings: (reason) => this.editorWorkspace?.validateOpenBindings(reason),
			onReconciled: (reason) => this.editorWorkspace?.onReconciled(reason),
			getAwaitingFirstProviderSyncAfterStartup: () => this.awaitingFirstProviderSyncAfterStartup,
			setAwaitingFirstProviderSyncAfterStartup: (value) => {
				this.awaitingFirstProviderSyncAfterStartup = value;
			},
			saveDiskIndex: () => this.saveDiskIndex(),
			refreshStatusBar: () => this.refreshStatusBar(),
			trace: (source, msg, details) => this.trace(source, msg, details),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			log: (message) => this.log(message),
		});
		return this.reconciliationController;
	}

	private isMarkdownPathSyncable(path: string): boolean {
		return isMarkdownSyncable(path, this.excludePatterns, this.getRuntimeConfig().vaultConfigDir);
	}

	private isBlobPathSyncable(path: string): boolean {
		return isBlobSyncable(path, this.excludePatterns, this.getRuntimeConfig().vaultConfigDir);
	}

	private getRuntimeConfig(): RuntimeConfig {
		if (!this.runtimeConfig) {
			this.runtimeConfig = buildRuntimeConfig(this.settings, this.app.vault.configDir);
		}
		return this.runtimeConfig;
	}

	private getBlobSync(): BlobSyncManager | null {
		return this.attachmentOrchestrator?.manager ?? null;
	}

	async onload() {
		const onloadStartedAt = Date.now();
		this.capabilityUpdateService = new CapabilityUpdateService({
			getSettings: () => this.settings,
			pluginVersion: this.manifest.version,
			schemaVersion: SCHEMA_VERSION,
			trace: (source, msg, details) => this.trace(source, msg, details),
			log: (message) => this.log(message),
			persistPluginState: () => this.persistPluginState(),
			hasSyncRuntime: () => this.vaultSync !== null,
			isSyncConnectedAndProviderSynced: () => !!this.vaultSync?.connected && !!this.vaultSync?.providerSynced,
			refreshAttachmentSyncRuntime: (reason) => this.refreshAttachmentSyncRuntime(reason),
			triggerDailySnapshot: () => { void this.snapshotService?.triggerDailySnapshot(); },
			stopSyncRuntimeForCompatibility: () => {
				if (this.vaultSync) {
					void this.teardownSync();
				}
			},
			setStatusError: () => this.updateStatusBar("error"),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			updateSettings: (mutator, reason) => this.updateSettings(mutator, reason),
		});
		await this.loadSettings();
		this.applyRuntimeSettings("load-settings");
		this.createReconciliationController();
		this.editorWorkspace = new EditorWorkspaceOrchestrator({
			app: this.app,
			getSettings: () => this.settings,
			getEditorBindings: () => this.editorBindings,
			getDiskMirror: () => this.diskMirror,
			maybeImportDeferredClosedOnlyPath: (path, reason) =>
				this.reconciliationController.maybeImportDeferredClosedOnlyPath(path, reason),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			log: (message) => this.log(message),
		});
		this.snapshotService = new SnapshotService({
			app: this.app,
			getSettings: () => this.settings,
			getTraceHttpContext: () => this.getTraceHttpContext(),
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.getBlobSync(),
			getServerSupportsSnapshots: () => this.serverSupportsSnapshots,
			log: (message) => this.log(message),
			onEditorsNeedReconcile: (reason) => this.editorWorkspace?.onReconciled(reason),
		});
		this.diagnosticsService = new DiagnosticsService({
			app: this.app,
			getSettings: () => this.settings,
			getTraceHttpContext: () => this.getTraceHttpContext(),
			getVaultSync: () => this.vaultSync,
			getDiskMirror: () => this.diskMirror,
			getBlobSync: () => this.getBlobSync(),
			getEventRing: () => this.eventRing,
			getRecentServerTrace: () => this.traceRuntime?.getRecentServerTrace() ?? [],
			getFrontmatterQuarantineEntries: () => this.frontmatterQuarantineEntries,
			getState: () => ({
				reconciled: this.reconciliationController.getState().reconciled,
				reconcileInFlight: this.reconciliationController.getState().reconcileInFlight,
				reconcilePending: this.reconciliationController.getState().reconcilePending,
				lastReconcileStats: this.reconciliationController.getState().lastReconcileStats,
				awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: this.reconciliationController.getState().lastReconciledGeneration,
				untrackedFileCount: this.reconciliationController.getState().untrackedFileCount,
				blockedDivergenceCount: this.reconciliationController.getState().blockedDivergenceCount,
				lastBlockedDivergenceAt: this.reconciliationController.getState().lastBlockedDivergenceAt,
				openFileCount: this.editorWorkspace?.openFileCount ?? 0,
			}),
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			collectOpenFileTraceState: () => this.collectOpenFileTraceState(),
			sha256Hex: (text) => this.sha256Hex(text),
			log: (message) => this.log(message),
		});
		this.setupLinkController = new SetupLinkController({
			app: this.app,
			getSettings: () => this.settings,
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			updateSettings: (mutator, reason) => this.updateSettings(mutator, reason),
			refreshServerCapabilities: (reason) => this.refreshServerCapabilities(reason),
			hasSyncRuntime: () => this.vaultSync !== null,
			initSync: () => {
				void this.initSync();
			},
		});
		this.registerObsidianProtocolHandler("yaos", (params) => {
			void this.setupLinkController?.handleSetupLink(params);
		});

		let generatedVaultId = false;
		if (!this.settings.vaultId) {
			await this.updateSettings((settings) => {
				settings.vaultId = generateVaultId();
			}, "startup-generate-vault-id");
			generatedVaultId = true;
		}

		if (!this.settings.deviceName) {
			await this.updateSettings((settings) => {
				settings.deviceName = `device-${Date.now().toString(36)}`;
			}, "startup-generate-device-name");
		}

		this.setupTraceRuntime();
		this.attachmentOrchestrator = new AttachmentOrchestrator({
			app: this.app,
			getVaultSync: () => this.vaultSync,
			getRuntimeConfig: () => this.getRuntimeConfig(),
			getServerSupportsAttachments: () => this.serverSupportsAttachments,
			getTraceHttpContext: () => this.getTraceHttpContext(),
			getBlobHashCache: () => this.blobHashCache,
			getExcludePatterns: () => this.excludePatterns,
			persistBlobQueue: (snapshot) => this.persistBlobQueueSnapshot(snapshot),
			clearPersistedBlobQueue: () => this.clearSavedBlobQueue(),
			getPreservedUnresolvedEntries: () => this.preservedUnresolvedEntries,
			onPreservedUnresolvedChanged: () => this.persistPreservedUnresolvedState(),
			trace: (source, msg, details) => this.trace(source, msg, details),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			refreshStatusBar: () => this.refreshStatusBar(),
			log: (message) => this.log(message),
		});
		this.attachmentOrchestrator.hydrateSavedQueue(this.savedBlobQueue);
		this.savedBlobQueue = null;
		if (generatedVaultId) {
			this.log(`Generated vault ID: ${this.settings.vaultId}`);
		}

		this.addSettingTab(new VaultSyncSettingTab(this.app, this, this));

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("disconnected");

		const finishOnload = (outcome: string): void => {
			const durationMs = Date.now() - onloadStartedAt;
			this.trace("trace", "startup-onload-complete", {
				durationMs,
				outcome,
				hostConfigured: !!this.settings.host,
				tokenConfigured: !!this.settings.token,
			});
			this.log(`Startup onload complete (${outcome}) in ${durationMs}ms`);
		};

		if (this.settings.host) {
			void this.refreshServerCapabilities("startup-background");
			void this.refreshUpdateManifest("startup-background");
			void this.syncUpdateMetadataToServer("startup-background");
		}

		if (!this.settings.host) {
			this.log("Host not configured — sync disabled");
			new Notice("Configure the server host in settings to enable sync.");
			finishOnload("missing-host");
			return;
		}

		if (!this.settings.token) {
			this.log("Token not configured — sync disabled");
			const message = this.serverAuthMode === "env"
				? "YAOS: configure the server token in settings to enable sync."
				: this.serverAuthMode === "claim" || this.serverAuthMode === "unclaimed"
						? "YAOS: claim the server in a browser, then use the YAOS setup link to fill in the token."
						: "YAOS: configure a token in settings, or claim the server in a browser first.";
			new Notice(message, 10000);
			finishOnload("missing-token");
			return;
		}

		// Parse exclude patterns and file size limit from settings
		this.applyRuntimeSettings("onload-pre-sync");

		// Warn about insecure connections to non-localhost hosts
		if (this.settings.host) {
			try {
				const url = new URL(this.settings.host);
				const h = url.hostname;
				if (url.protocol === "http:" && h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]") {
						this.log("WARNING: connecting over unencrypted HTTP to a remote host — token sent in plaintext");
						new Notice(
							"Connecting over unencrypted HTTP. Your token will be sent in plaintext. Use HTTPS for production.",
							8000,
						);
					}
			} catch { /* invalid URL, will fail at connect */ }
		}

		void this.initSync();
		finishOnload("sync-started");
	}

	private async initSync(): Promise<void> {
		const initSyncStartedAt = Date.now();
		this.attachmentOrchestrator?.destroy();
		this.trace("trace", "startup-init-sync-start", {
			hostConfigured: !!this.settings.host,
			tokenConfigured: !!this.settings.token,
			hasCachedCapabilities: this.capabilityUpdateService?.hasCachedCapabilities ?? false,
		});
		try {
			this.idbDegradedHandled = false;
			this.applyRuntimeSettings("init-sync");
			if (this.enforceCompatibilityGuard("init-sync-preflight")) {
				return;
			}

			// 1. Create VaultSync (Y.Doc + IndexedDB + provider in parallel)
			this.vaultSync = new VaultSync(this.settings, {
				traceContext: this.getTraceHttpContext(),
				trace: (source, msg, details) => this.trace(source, msg, details),
			});

			// 2. EditorBindingManager
			this.editorBindings = new EditorBindingManager(
				this.vaultSync,
				this.settings.debug,
				(source, msg, details) => this.trace(source, msg, details),
			);

			// 3. Global CM6 extension
			this.registerEditorExtension(
				this.editorBindings.getBaseExtension(),
			);

			// 4. DiskMirror
			this.diskMirror = new DiskMirror(
				this.app,
				this.vaultSync,
				this.editorBindings,
				this.settings.debug,
				(source, msg, details) => this.trace(source, msg, details),
				() => this.settings.frontmatterGuardEnabled,
				(path, direction, reason, validation, previousContent, nextContent) =>
					this.handleFrontmatterValidation(
						path,
						direction,
						reason,
						validation,
						previousContent,
						nextContent,
					),
				() => this.settings.deviceName,
				this.preservedUnresolvedEntries,
				() => this.persistPreservedUnresolvedState(),
			);
			this.diskMirror.startMapObservers();

			// 4b. BlobSyncManager (if attachment sync is enabled)
			this.attachmentOrchestrator?.start("startup", false);

			// 5. Status tracking
			this.connectionController = new ConnectionController({
				getVaultSync: () => this.vaultSync,
				isReconciled: () => this.reconciliationController.isReconciled,
				getAwaitingFirstProviderSyncAfterStartup: () => this.awaitingFirstProviderSyncAfterStartup,
				setAwaitingFirstProviderSyncAfterStartup: (value) => {
					this.awaitingFirstProviderSyncAfterStartup = value;
				},
				getLastReconciledGeneration: () => this.reconciliationController.lastGeneration,
				setReconnectPending: () => {
					this.reconciliationController.markPending();
				},
				isReconcileInFlight: () => this.reconciliationController.isReconcileInFlight,
				runReconnectReconciliation: (generation) => {
					void this.reconciliationController.runReconnectReconciliation(generation);
				},
				refreshServerCapabilities: (reason) => {
					void this.refreshServerCapabilities(reason);
				},
				flushOpenWrites: (reason) => {
					void this.diskMirror?.flushOpenWrites(reason);
				},
				updateOfflineStatus: () => this.updateStatusBar("offline"),
				refreshStatusBar: () => this.refreshStatusBar(),
				scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
				log: (message) => this.log(message),
				trace: (source, msg, details) => this.trace(source, msg, details),
				registerCleanup: (cleanup) => this.register(cleanup),
			});
			this.connectionController.start();
			this.statusInterval = setInterval(() => {
				this.refreshStatusBar();
				if (this.reconciliationController.isReconciled && this.editorBindings) {
					const touched = this.editorWorkspace?.auditBindings("status-tick") ?? 0;
					if (touched > 0) {
						this.log(`Binding health audit (status-tick) — touched ${touched}`);
					}
				}
				// Periodically persist blob queue if transfers are active,
				// or clear persisted queue if transfers completed
				this.attachmentOrchestrator?.handleStatusTick();
				const capabilityState = this.capabilityUpdateService?.capabilities ?? null;
				const waitingForR2 =
					!!this.settings.host &&
					(!capabilityState || !capabilityState.attachments || !capabilityState.snapshots);
				if (waitingForR2 && (this.capabilityUpdateService?.shouldRefreshCapabilities() ?? false)) {
					void this.refreshServerCapabilities("background-poll");
				}
			}, 3000);
			this.register(() => {
				if (this.statusInterval) clearInterval(this.statusInterval);
			});

			// 6. Vault events (gated by reconciliation state)
			this.registerVaultEvents();

			// 7. Commands
			if (!this.commandsRegistered) {
				registerCommands(this, {
					getVaultSync: () => this.vaultSync,
					getConnectionController: () => this.connectionController,
					getDiagnosticsService: () => this.diagnosticsService,
					getSnapshotService: () => this.snapshotService,
					getFilesNeedingAttentionText: () => this.buildFilesNeedingAttentionText(),
					getUntrackedFileCount: () => this.reconciliationController.untrackedFileCount,
					isDebugEnabled: () => this.settings.debug,
					runReconciliation: (mode) => this.runReconciliation(mode),
					runSchemaMigrationToV2: () => this.runSchemaMigrationToV2(),
					runVfsTortureTest: () => this.runVfsTortureTest(),
					importUntrackedFiles: () => this.importUntrackedFiles(),
					clearLocalServerReceiptState: () => this.clearLocalServerReceiptState(),
					resetLocalCache: () => this.resetLocalCache(),
					nuclearReset: () => this.nuclearReset(),
				});
				this.commandsRegistered = true;
			}

			// 8. Rename batch callback → update editor bindings + disk mirror observers + disk index + blob hash cache
			this.vaultSync.onRenameBatchFlushed((renames) => {
				this.editorWorkspace?.onRenameBatchFlushed(renames);

				// Move disk index entries
				moveIndexEntries(this.diskIndex, renames);

				// Move blob hash cache entries
				moveCachedHashes(this.blobHashCache, renames);
			});

			// -----------------------------------------------------------
			// STARTUP SEQUENCE
			// -----------------------------------------------------------

			this.updateStatusBar("loading");
			this.log("Waiting for IndexedDB persistence...");
			const localLoaded = await this.vaultSync.waitForLocalPersistence();
			this.log(`IndexedDB: ${localLoaded ? "loaded" : "timed out"}`);
			await this.vaultSync.initializeServerAckTracking(this.settings, this.manifest.version, {
				localYjsPersistenceLoaded: localLoaded,
			});

			// Schema version check — refuse to run if a newer plugin wrote this data
			const schemaError = this.vaultSync.checkSchemaVersion();
			if (schemaError) {
				console.error(`[yaos] ${schemaError}`);
				new Notice(`YAOS: ${schemaError}`);
				this.updateStatusBar("error");
				return;
			}

			// Check for fatal auth error before waiting for provider
			if (this.vaultSync.fatalAuthError) {
				this.log("Fatal auth error during startup");
				if (this.vaultSync.fatalAuthCode === "update_required") {
					this.updateStatusBar("error");
					this.showFatalSyncNotice();
					return;
				}
				this.updateStatusBar("unauthorized");
				this.showFatalSyncNotice();
				// Still reconcile with whatever we have locally
				const mode = this.vaultSync.getSafeReconcileMode();
				await this.runReconciliation(mode);
				return;
			}

			this.updateStatusBar("syncing");
			this.log("Waiting for provider sync...");
			const providerSynced = await this.vaultSync.waitForProviderSync();
			this.log(`Provider: ${providerSynced ? "synced" : "timed out (offline)"}`);
			this.awaitingFirstProviderSyncAfterStartup = !providerSynced;
			this.log(
				`Startup sync gate: awaitingFirstProviderSyncAfterStartup=${this.awaitingFirstProviderSyncAfterStartup} ` +
				`(gen=${this.vaultSync.connectionGeneration})`,
			);

			if (this.vaultSync.fatalAuthError) {
				this.updateStatusBar(this.vaultSync.fatalAuthCode === "update_required" ? "error" : "unauthorized");
				this.showFatalSyncNotice();
				return;
			}

			const mode = this.vaultSync.getSafeReconcileMode();
			this.log(`Reconciliation mode: ${mode}`);

			await this.runReconciliation(mode);
			this.reconciliationController.lastGeneration = this.vaultSync.connectionGeneration;
			if (providerSynced) {
				this.awaitingFirstProviderSyncAfterStartup = false;
			}

			this.refreshStatusBar();
			this.trace("trace", "startup-init-sync-complete", {
				durationMs: Date.now() - initSyncStartedAt,
			});
			this.log("Startup complete");
			this.scheduleTraceStateSnapshot("startup-complete");
			this.attachmentOrchestrator?.markStartupReady("startup-complete");
			void this.traceRuntime?.refreshServerTrace();

			// Trigger daily snapshot (noop if already taken today).
			// Fire-and-forget — don't block startup on snapshot creation.
			if (providerSynced && this.serverSupportsSnapshots) {
				void this.snapshotService?.triggerDailySnapshot();
			}
		} catch (err) {
			console.error("[yaos] Failed to initialize sync:", err);
			new Notice(`YAOS: failed to initialize — ${formatUnknown(err)}`);
			this.updateStatusBar("error");
		}
	}

	private async runReconciliation(mode: ReconcileMode): Promise<void> {
		await this.reconciliationController.runReconciliation(mode);
	}

	private async importUntrackedFiles(): Promise<void> {
		await this.reconciliationController.importUntrackedFiles();
	}

	private async clearLocalServerReceiptState(): Promise<"cleared_persistent" | "cleared_memory_only" | "failed" | undefined> {
		if (!this.vaultSync) return;
		const result = await this.vaultSync.clearLocalServerReceiptState();
		this.log(`Cleared local server-receipt state: ${result}`);
		this.scheduleTraceStateSnapshot("clear-local-server-receipt-state");
		this.refreshStatusBar();
		return result;
	}

	// -------------------------------------------------------------------
	// Vault event handlers
	// -------------------------------------------------------------------

	private registerVaultEvents(): void {
		// Layout change: clean up observers for closed files
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onLayoutChange();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onActiveLeafChange(leaf);
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onFileOpen(file?.path ?? null);
				if (!file) return;

				// Prefetch embedded attachments for the opened note
				if (file.path.endsWith(".md") && this.getBlobSync()) {
					this.prefetchEmbeddedAttachments(file);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					this.reconciliationController.markMarkdownDirty(file, "modify");
				} else {
					const blobSync = this.getBlobSync();
					if (blobSync && this.isBlobPathSyncable(file.path) && !blobSync.isSuppressed(file.path)) {
						blobSync.handleFileChange(file);
					}
				}
			}),
		);

		// Rename: use batched queueRename for atomic folder renames.
		// Both markdown and blob files go through the same rename batch
		// since folder renames affect both types atomically.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;
				// Rename is relevant if either the old or new path is syncable
				const newSyncable = this.isMarkdownPathSyncable(file.path)
					|| this.isBlobPathSyncable(file.path);
				const oldSyncable = this.isMarkdownPathSyncable(oldPath)
					|| this.isBlobPathSyncable(oldPath);
				if (!newSyncable && !oldSyncable) return;
				this.vaultSync?.queueRename(oldPath, file.path);
				this.log(`Rename queued: "${oldPath}" -> "${file.path}"`);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					if (this.diskMirror?.consumeDeleteSuppression(file.path)) {
						this.log(`Suppressed delete event for "${file.path}"`);
						return;
					}
					this.editorWorkspace?.onMarkdownDeleted(file.path);

					this.vaultSync?.handleDelete(
						file.path,
						this.settings.deviceName,
					);
					this.log(`Delete: "${file.path}"`);
					} else {
						const blobSync = this.getBlobSync();
						if (blobSync && this.isBlobPathSyncable(file.path) && !blobSync.isSuppressed(file.path)) {
							blobSync.handleFileDelete(file.path, this.settings.deviceName);
							this.log(`Delete (blob): "${file.path}"`);
						}
					}
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					this.reconciliationController.markMarkdownDirty(file, "create");
				} else if (this.isBlobPathSyncable(file.path)) {
					const blobSync = this.getBlobSync();
					if (blobSync && !blobSync.isSuppressed(file.path)) {
						// For blob files, use the same stability check before uploading
						if (this.pendingStabilityChecks.has(file.path)) return;
						this.pendingStabilityChecks.add(file.path);

						void waitForDiskQuiet(this.app, file.path).then((stable) => {
							this.pendingStabilityChecks.delete(file.path);
							if (stable) {
								this.getBlobSync()?.handleFileChange(file);
							} else {
								this.log(`Create (blob): "${file.path}" unstable after timeout, skipping`);
							}
						});
					} else if (!this.serverSupportsAttachments) {
						this.attachmentOrchestrator?.notifyUnsupportedAttachmentCreate();
					}
				}
			}),
		);
	}

	// -------------------------------------------------------------------
	// Teardown + reinit (for reset commands)
	// -------------------------------------------------------------------

	/**
	 * Cleanly tear down all sync state: unbind editors, stop disk mirror,
	 * destroy provider + persistence + ydoc, reset all flags.
	 * After this, the plugin is in the same state as before initSync().
	 */
	private async teardownSync(): Promise<void> {
		this.log("teardownSync: tearing down all sync state");

		this.editorBindings?.unbindAll();
		this.diskMirror?.destroy();

		this.attachmentOrchestrator?.destroy();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		this.reconciliationController.reset();
		this.connectionController?.stop();

		await this.vaultSync?.destroy();

		this.vaultSync = null;
		this.connectionController = null;
		this.editorBindings = null;
		this.diskMirror = null;
		this.awaitingFirstProviderSyncAfterStartup = false;
		this.editorWorkspace?.reset();
		this.idbDegradedHandled = false;

		this.updateStatusBar("disconnected");
	}

	private resetLocalCache(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const vaultId = this.settings.vaultId;
		new ConfirmModal(
			this.app,
			"Reset local cache",
			"This will clear the local IndexedDB cache and re-sync from the server. " +
			"Your disk files and server state are not affected. Continue?",
			async () => {
				this.log("Reset cache: starting");
				new Notice("Clearing cache and syncing again...");

				await this.teardownSync();

				try {
					await VaultSync.deleteIdb(vaultId);
					this.log("Reset cache: IDB deleted");
				} catch (err) {
					console.error("[yaos] Failed to delete IDB:", err);
				}

				this.log("Reset cache: reinitializing");
				await this.initSync();
				new Notice("Cache reset complete.");
			},
		).open();
	}

	private nuclearReset(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const pathCount = this.vaultSync.getActiveMarkdownPaths().length;
		new ConfirmModal(
			this.app,
			"Nuclear reset",
			`This will wipe all CRDT state (${pathCount} files) on both this device and the server, ` +
			`clear the local cache, then re-seed everything from your current disk files. ` +
			`Other connected devices will also see the reset. This cannot be undone. Continue?`,
			async () => {
				this.log("Nuclear reset: starting");
				new Notice("Nuclear reset in progress...");

				// Clear CRDT maps before teardown so deletions propagate while connected.
				const counts = this.vaultSync!.clearAllMaps();
				this.log(
					`Nuclear reset: cleared ${counts.pathCount} paths, ` +
					`${counts.idCount} texts, ${counts.metaCount} meta, ` +
					`${counts.blobCount} blob paths`,
				);

				await new Promise((r) => setTimeout(r, 500));

				const vaultId = this.settings.vaultId;
				await this.teardownSync();

				try {
					await VaultSync.deleteIdb(vaultId);
					this.log("Nuclear reset: IDB deleted");
				} catch (err) {
					console.error("[yaos] Failed to delete IDB:", err);
				}

				this.log("Nuclear reset: reinitializing (will re-seed from disk)");
				await this.initSync();
				new Notice(
					`YAOS: nuclear reset complete. ` +
					`Re-seeded ${this.vaultSync?.getActiveMarkdownPaths().length ?? 0} files from disk.`,
				);
			},
		).open();
	}

	// -------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------

	/**
	 * When a note opens, parse its embedded links (![[...]]) via Obsidian's
	 * metadata cache and prefetch any missing blob attachments from R2.
	 * This ensures images/PDFs render immediately rather than waiting for
	 * the next reconcile or CRDT observer to trigger the download.
	 */
	private prefetchEmbeddedAttachments(file: TFile): void {
		const blobSync = this.getBlobSync();
		if (!blobSync) return;

		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.embeds) return;

		const pathsToFetch: string[] = [];

		for (const embed of cache.embeds) {
			// Resolve the link to an actual vault path.
			// getFirstLinkpathDest handles relative paths, aliases, etc.
			const resolved = this.app.metadataCache.getFirstLinkpathDest(
				embed.link,
				file.path,
			);

			if (resolved) {
				// File already exists on disk — skip
				continue;
			}

			// File doesn't exist on disk. Try to find it in the CRDT blob map.
			// The link could be just a filename (e.g. "image.png") or a path.
			// Check both the raw link text and common attachment patterns.
			const linkPath = (embed.link.split("#")[0] ?? "").split("|")[0] ?? ""; // strip anchors/aliases

			// Search pathToBlob for a matching path
			let blobPath: string | null = null;
			this.vaultSync?.pathToBlob.forEach((_ref, candidatePath) => {
				if (blobPath) return; // already found
				// Exact match
				if (candidatePath === linkPath) {
					blobPath = candidatePath;
					return;
				}
				// Filename-only match (Obsidian's default "shortest path" mode)
				const candidateFilename = candidatePath.split("/").pop();
				if (candidateFilename === linkPath) {
					blobPath = candidatePath;
				}
			});

			if (blobPath) {
				pathsToFetch.push(blobPath);
			}
		}

		if (pathsToFetch.length > 0) {
			const queued = blobSync.prioritizeDownloads(pathsToFetch);
			if (queued > 0) {
				this.log(`prefetch: queued ${queued} attachments for "${file.path}"`);
			}
		}
	}

	private shouldBlockFrontmatterIngest(
		path: string,
		previousContent: string | null,
		nextContent: string,
		reason: string,
	): boolean {
		if (!this.settings.frontmatterGuardEnabled) return false;

		const validation = validateFrontmatterTransition(previousContent, nextContent);
		this.handleFrontmatterValidation(
			path,
			"disk-to-crdt",
			reason,
			validation,
			previousContent,
			nextContent,
		);
		if (!isFrontmatterBlocked(validation)) return false;
		this.log(
			`Frontmatter ingest blocked for "${path}" ` +
			`(${validation.reasons.join(", ") || validation.risk})`,
		);
		return true;
	}

	private handleFrontmatterValidation(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
	): void {
		if (validation.risk === "ok") {
			this.clearFrontmatterNoticeFingerprint(path, direction);
			void this.clearFrontmatterQuarantine(path, `${direction}:${reason}`);
			return;
		}

		if (!isFrontmatterBlocked(validation)) return;

		const noticeFingerprint = this.buildFrontmatterNoticeFingerprint(
			validation,
		);
		const shouldNotify = this.shouldNotifyFrontmatterQuarantine(
			path,
			direction,
			noticeFingerprint,
		);
		const notifiedAt = shouldNotify ? Date.now() : null;

		this.traceFrontmatterQuarantine(
			path,
			direction,
			reason,
			validation,
			previousContent?.length ?? null,
			nextContent.length,
		);
		if (shouldNotify) {
			this.showFrontmatterGuardNotice(path);
		}
		void this.persistFrontmatterQuarantine(
			path,
			direction,
			validation,
			previousContent,
			nextContent,
			noticeFingerprint,
			notifiedAt,
		);
	}

	private showFrontmatterGuardNotice(path: string): void {
		new Notice(
			`YAOS paused a properties update in "${path}" because the frontmatter looked unsafe. Check diagnostics before accepting the change.`,
			12_000,
		);
	}

	private buildFrontmatterNoticeFingerprint(
		validation: FrontmatterValidationResult,
	): string {
		const reasons = [...validation.reasons].sort().join("|");
		return [
			reasons,
			String(validation.previousFrontmatterLength ?? "none"),
			String(validation.frontmatterLength ?? "none"),
		].join("#");
	}

	private shouldNotifyFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		noticeFingerprint: string,
	): boolean {
		const key = `${direction}:${path}`;
		const previousFingerprint = this.frontmatterGuardNoticeFingerprints.get(key);
		if (previousFingerprint === noticeFingerprint) {
			return false;
		}
		this.frontmatterGuardNoticeFingerprints.set(key, noticeFingerprint);
		return true;
	}

	private clearFrontmatterNoticeFingerprint(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
	): void {
		const key = `${direction}:${path}`;
		this.frontmatterGuardNoticeFingerprints.delete(key);
	}

	private traceFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousLength: number | null,
		nextLength: number,
	): void {
		this.trace("quarantine", "frontmatter-quarantined", {
			path,
			direction,
			reason,
			risk: validation.risk,
			reasons: validation.reasons,
			previousLength,
			nextLength,
			previousFrontmatterLength: validation.previousFrontmatterLength ?? null,
			nextFrontmatterLength: validation.frontmatterLength,
		});
	}

	private async persistFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
		lastNotifiedFingerprint: string,
		lastNoticeAt: number | null,
	): Promise<void> {
		const now = Date.now();
		const prevHash = await this.hashFrontmatterContent(previousContent);
		const nextHash = await this.hashFrontmatterContent(nextContent);
		this.frontmatterQuarantineEntries = upsertFrontmatterQuarantineEntry(
			this.frontmatterQuarantineEntries,
			{
				path,
				firstSeenAt: now,
				lastSeenAt: now,
				direction,
				reasons: validation.reasons,
				prevHash,
				nextHash,
				lastNotifiedFingerprint,
				lastNoticeAt: lastNoticeAt ?? undefined,
				count: 1,
			},
		);
		await this.persistPluginState();
	}

	private async clearFrontmatterQuarantine(path: string, reason: string): Promise<void> {
		if (this.frontmatterQuarantineEntries.length === 0) return;
		const nextEntries = clearFrontmatterQuarantinePath(this.frontmatterQuarantineEntries, path);
		if (nextEntries.length === this.frontmatterQuarantineEntries.length) return;
		this.frontmatterQuarantineEntries = nextEntries;
		this.trace("quarantine", "frontmatter-quarantine-cleared", {
			path,
			reason,
		});
		await this.persistPluginState();
	}

	/**
	 * Toggle remote cursor visibility via a CSS class on the document body.
	 * The actual cursor styles from y-codemirror.next are hidden when the
	 * class is absent; we add it when showRemoteCursors is true.
	 */
	applyCursorVisibility(): void {
		document.body.toggleClass(
			"vault-crdt-show-cursors",
			this.settings.showRemoteCursors,
		);
	}

	private refreshStatusBar(): void {
		const state = this.computeSyncStatus();
		if (state === "error" && this.vaultSync?.idbError) {
			this.handleIndexedDbDegraded("status-check");
		}
		this.updateStatusBar(state);
	}

	private computeSyncStatus(): SyncStatus {
		if (this.vaultSync?.idbError) {
			return "error";
		}

		return this.syncStatusFromConnectionState(this.connectionController?.getState() ?? { kind: "disconnected" });
	}

	private syncStatusFromConnectionState(state: ConnectionState): SyncStatus {
		switch (state.kind) {
			case "disconnected":
				return "disconnected";
			case "loading_cache":
				return "loading";
			case "connecting":
				return "syncing";
			case "online":
				return "connected";
			case "offline":
				return "offline";
			case "auth_failed":
				return "unauthorized";
			case "server_update_required":
				return "error";
		}
	}

	getSettingsStatusSummary(): { state: SyncStatus; label: string } {
		const state = this.computeSyncStatus();
		return {
			state,
			label: getSyncStatusLabel(state).replace(/^CRDT:\s*/, ""),
		};
	}

	private updateStatusBar(_coarseState: SyncStatus): void {
		if (!this.statusBarEl) return;
		const connectionState = this.connectionController?.getState();
		const transferStatus = this.getBlobSync()?.transferStatus;
		const diskAttention =
			(this.diskMirror?.getDebugSnapshot().preservedUnresolved.totalCount ?? 0);
		const blobAttention =
			(this.getBlobSync()?.getDebugSnapshot().preservedUnresolved.totalCount ?? 0);
		const attentionCount = diskAttention + blobAttention;
		const vaultSync = this.vaultSync;
		const serverReceipt = vaultSync ? {
			serverAppliedLocalState: vaultSync.serverAppliedLocalState,
			lastServerReceiptEchoAt: vaultSync.lastServerReceiptEchoAt,
			lastKnownServerReceiptEchoAt: vaultSync.lastKnownServerReceiptEchoAt,
			candidatePersistenceHealthy: vaultSync.candidatePersistenceHealthy,
			serverReceiptStartupValidation: vaultSync.serverReceiptStartupValidation,
		} : null;
		if (connectionState) {
			renderConnectionState(this.statusBarEl, connectionState, transferStatus, serverReceipt, attentionCount);
		} else {
			renderSyncStatus(this.statusBarEl, _coarseState, transferStatus, attentionCount);
		}
	}

	private buildFilesNeedingAttentionText(): string {
		const entries = this.collectPreservedUnresolvedEntries()
			.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
		if (entries.length === 0) return "No files currently need attention.";
		return entries.map((entry) => [
			entry.path,
			`  kind: ${entry.kind}`,
			`  reason: ${entry.reason}`,
			`  first seen: ${new Date(entry.firstSeenAt).toLocaleString()}`,
			`  last seen: ${new Date(entry.lastSeenAt).toLocaleString()}`,
			"  suggested action: inspect the local file and conflict artifacts, then edit/save to keep local content or delete it to accept the remote delete.",
		].join("\n")).join("\n\n");
	}

	private setupTraceRuntime(): void {
		this.traceRuntime = new TraceRuntimeController({
			app: this.app,
			getSettings: () => this.settings,
			buildSnapshot: (reason, recentServerTrace) =>
				this.buildTraceStateSnapshot(reason, recentServerTrace),
			isIndexedDbRelatedError: (err) => this.isIndexedDbRelatedError(err),
			isObsidianFileMetadataRaceError: (err) => this.isObsidianFileMetadataRaceError(err),
			handleIndexedDbDegraded: (source, err) => this.handleIndexedDbDegraded(source, err),
			registerCleanup: (cleanup) => this.register(cleanup),
		});
		this.traceRuntime.start();
	}

	private getTraceHttpContext(): TraceHttpContext | undefined {
		return this.traceRuntime?.httpContext;
	}

	private trace(
		source: string,
		msg: string,
		details?: TraceEventDetails,
	): void {
		this.traceRuntime?.record(source, msg, details);
	}

	private scheduleTraceStateSnapshot(reason: string): void {
		this.traceRuntime?.scheduleSnapshot(reason);
	}

	private async buildTraceStateSnapshot(
		reason: string,
		recentServerTrace: unknown[],
	): Promise<Record<string, unknown>> {
		return {
			generatedAt: new Date().toISOString(),
			reason,
			trace: this.getTraceHttpContext() ?? null,
			settings: {
				host: this.settings.host,
				vaultId: this.settings.vaultId,
				deviceName: this.settings.deviceName,
				debug: this.settings.debug,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
			},
			state: {
				reconciled: this.reconciliationController.getState().reconciled,
				reconcileInFlight: this.reconciliationController.getState().reconcileInFlight,
				reconcilePending: this.reconciliationController.getState().reconcilePending,
				awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: this.reconciliationController.getState().lastReconciledGeneration,
				openFileCount: this.editorWorkspace?.openFileCount ?? 0,
			},
			sync: this.vaultSync?.getDebugSnapshot() ?? null,
			diskMirror: this.diskMirror?.getDebugSnapshot() ?? null,
			blobSync: this.getBlobSync()?.getDebugSnapshot() ?? null,
			openFiles: await this.collectOpenFileTraceState(),
			recentEvents: {
				plugin: this.eventRing.slice(-120),
				sync: this.vaultSync?.getRecentEvents(120) ?? [],
			},
			serverTrace: recentServerTrace,
		};
	}

	private async collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>> {
		if (!this.vaultSync) return [];

		const probes: Array<Record<string, unknown>> = [];
		const leaves: MarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				leaves.push(leaf.view);
			}
		});

		for (const view of leaves) {
			const file = view.file;
			if (!file) continue;

			const path = file.path;
			const editorContent = view.editor.getValue();
			const diskContent = await this.app.vault.read(file).catch(() => null);
			const crdtContent = yTextToString(this.vaultSync.getTextForPath(path));
			const binding = this.editorBindings?.getBindingDebugInfoForView(view) ?? null;
			const collab = this.editorBindings?.getCollabDebugInfoForView(view) ?? null;

			const [editorHash, diskHash, crdtHash] = await Promise.all([
				this.hashIfPresent(editorContent),
				this.hashIfPresent(diskContent),
				this.hashIfPresent(crdtContent),
			]);

			probes.push({
				path,
				leafId: binding?.leafId ?? ((view.leaf as unknown as { id?: string }).id ?? path),
				binding,
				collab,
				hashes: {
					editor: editorHash,
					disk: diskHash,
					crdt: crdtHash,
				},
				lengths: {
					editor: editorContent.length,
					disk: diskContent?.length ?? null,
					crdt: crdtContent?.length ?? null,
				},
				editorVsDisk: this.describeContentDiff(editorContent, diskContent),
				editorVsCrdt: this.describeContentDiff(editorContent, crdtContent),
				diskVsCrdt: this.describeContentDiff(diskContent, crdtContent),
			});
		}

		return probes;
	}

	private async hashIfPresent(text: string | null): Promise<string | null> {
		if (text == null) return null;
		return this.sha256Hex(text);
	}

	private describeContentDiff(
		left: string | null,
		right: string | null,
	): Record<string, unknown> {
		if (left == null || right == null) {
			return {
				comparable: false,
				leftLength: left?.length ?? null,
				rightLength: right?.length ?? null,
			};
		}

		const firstDiffIndex = this.findFirstDiffIndex(left, right);
		return {
			comparable: true,
			matches: firstDiffIndex === -1,
			firstDiffIndex: firstDiffIndex === -1 ? null : firstDiffIndex,
			leftLength: left.length,
			rightLength: right.length,
			leftSnippet: firstDiffIndex === -1 ? "" : left.slice(firstDiffIndex, firstDiffIndex + 160),
			rightSnippet: firstDiffIndex === -1 ? "" : right.slice(firstDiffIndex, firstDiffIndex + 160),
		};
	}

	private findFirstDiffIndex(left: string, right: string): number {
		const max = Math.min(left.length, right.length);
		for (let i = 0; i < max; i++) {
			if (left[i] !== right[i]) return i;
		}
		return left.length === right.length ? -1 : max;
	}

	onunload() {
		this.log("Unloading plugin");
		void this.traceRuntime?.shutdown();
		document.body.removeClass("vault-crdt-show-cursors");
		void this.teardownSync();
	}

	async loadSettings() {
		const { settings, persistedState, migrated } = await this.settingsStore.load();
		const data = persistedState;
		this.persistedState = persistedState;
		this.settings = settings;
		// Load disk index from plugin data (stored under _diskIndex key)
		if (data && typeof data._diskIndex === "object" && data._diskIndex !== null) {
			this.diskIndex = data._diskIndex;
		}
		// Load blob hash cache
		if (data && typeof data._blobHashCache === "object" && data._blobHashCache !== null) {
			this.blobHashCache = data._blobHashCache;
		}
		// Load persisted blob queue
		if (data && typeof data._blobQueue === "object" && data._blobQueue !== null) {
			this.savedBlobQueue = data._blobQueue;
		}
		if (Array.isArray(data?._preservedUnresolved)) {
			this.preservedUnresolvedEntries = data._preservedUnresolved.filter(
				(entry): entry is PreservedUnresolvedEntry =>
					typeof entry === "object" &&
					entry !== null &&
					typeof (entry as PreservedUnresolvedEntry).path === "string" &&
					((entry as PreservedUnresolvedEntry).kind === "markdown" ||
						(entry as PreservedUnresolvedEntry).kind === "blob") &&
					typeof (entry as PreservedUnresolvedEntry).reason === "string" &&
					typeof (entry as PreservedUnresolvedEntry).firstSeenAt === "number" &&
					typeof (entry as PreservedUnresolvedEntry).lastSeenAt === "number",
			);
		}
		const cachedCapabilities = readPersistedServerCapabilitiesCache(data?._serverCapabilitiesCache);
		const cachedUpdateManifest = readPersistedUpdateManifestCache(data?._updateManifestCache);
		this.capabilityUpdateService?.hydratePersistedCaches(cachedCapabilities, cachedUpdateManifest);
		this.frontmatterQuarantineEntries = readPersistedFrontmatterQuarantine(data?._frontmatterQuarantine);
		this.refreshPersistedState();
		if (migrated) {
			await this.persistPluginState();
		}
	}

	async saveSettings(reason = "settings-save") {
		await this.persistPluginState();
		this.applyRuntimeSettings(reason);
		this.refreshStatusBar();
		void this.syncUpdateMetadataToServer(reason);
	}

	async updateSettings(
		mutator: (settings: VaultSyncSettings) => void,
		reason = "settings-update",
	): Promise<void> {
		mutator(this.settings);
		await this.saveSettings(reason);
	}

	private applyRuntimeSettings(reason: string): void {
		this.runtimeConfig = buildRuntimeConfig(this.settings, this.app.vault.configDir);
		this.excludePatterns = this.runtimeConfig.excludePatterns;
		this.maxFileSize = this.runtimeConfig.maxFileSizeBytes;
		this.applyCursorVisibility();
		this.trace("trace", "runtime-settings-applied", {
			reason,
			hostConfigured: !!this.runtimeConfig.host,
			vaultIdConfigured: !!this.runtimeConfig.vaultId,
			enableAttachmentSync: this.runtimeConfig.enableAttachmentSync,
			externalEditPolicy: this.runtimeConfig.externalEditPolicy,
			maxFileSizeKB: this.runtimeConfig.maxFileSizeKB,
			excludePatternCount: this.runtimeConfig.excludePatterns.length,
		});
	}

	get serverAuthMode(): ServerCapabilities["authMode"] | "unknown" {
		return this.capabilityUpdateService?.authMode ?? "unknown";
	}

	get serverSupportsAttachments(): boolean {
		return this.capabilityUpdateService?.supportsAttachments ?? true;
	}

	get serverSupportsSnapshots(): boolean {
		return this.capabilityUpdateService?.supportsSnapshots ?? true;
	}

	get serverMaxBlobUploadBytes(): number | null {
		return this.capabilityUpdateService?.capabilities?.maxBlobUploadBytes ?? null;
	}

	buildSetupDeepLink(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		const params = new URLSearchParams({
			action: "setup",
			host,
			token,
			vaultId,
		});
		return `obsidian://yaos?${params.toString()}`;
	}

	buildMobileSetupUrl(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		const hash = new URLSearchParams({
			host,
			token,
			vaultId,
		});
		return `${host}/mobile-setup#${hash.toString()}`;
	}

	buildRecoveryKitText(): string | null {
		const host = this.settings.host?.trim().replace(/\/$/, "");
		const token = this.settings.token?.trim();
		const vaultId = this.settings.vaultId?.trim();
		if (!host || !token || !vaultId) return null;
		return [
			"YAOS Recovery Kit",
			`Created: ${new Date().toISOString()}`,
			"",
			`Host: ${host}`,
			`Token: ${token}`,
			`Vault ID: ${vaultId}`,
			"",
			"Keep this in a password manager. You need host + token + vault ID to recover this sync room on a new device.",
		].join("\n");
	}

	async refreshAttachmentSyncRuntime(reason = "settings-change"): Promise<void> {
		await this.attachmentOrchestrator?.refresh(reason);
	}

	private enforceCompatibilityGuard(reason: string): boolean {
		return this.capabilityUpdateService?.enforceCompatibilityGuard(reason) ?? false;
	}

	async refreshServerCapabilities(reason = "manual"): Promise<void> {
		await this.capabilityUpdateService?.refreshServerCapabilities(reason);
	}

	async refreshUpdateManifest(reason = "manual", force = false): Promise<void> {
		await this.capabilityUpdateService?.refreshUpdateManifest(reason, force);
	}

	getUpdateState(): UpdateState {
		return this.capabilityUpdateService?.getUpdateState() ?? {
			serverVersion: null,
			latestServerVersion: null,
			serverUpdateAvailable: false,
			pluginVersion: this.manifest.version,
			latestPluginVersion: null,
			pluginUpdateRecommended: false,
			migrationRequired: false,
			updateProvider: "unknown",
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			updateActionLabel: "YAOS settings",
			legacyServerDetected: false,
			pluginCompatibilityWarning: null,
		};
	}

	buildServerUpdateUrl(): string | null {
		return this.capabilityUpdateService?.buildServerUpdateUrl() ?? null;
	}

	buildGithubUpdaterBootstrapUrl(): string | null {
		return this.capabilityUpdateService?.buildGithubUpdaterBootstrapUrl() ?? null;
	}

	private async syncUpdateMetadataToServer(reason: string): Promise<void> {
		await this.capabilityUpdateService?.syncUpdateMetadataToServer(reason);
	}

		private showFatalSyncNotice(): void {
			const code = this.vaultSync?.fatalAuthCode;
			if (code === "unclaimed") {
				new Notice(
					"This server is unclaimed. Open the server URL in a browser, then use the setup link.",
					10000,
				);
				return;
			}

			if (code === "server_misconfigured") {
				new Notice("Server misconfigured.");
				return;
			}
		if (code === "update_required") {
			const details = this.vaultSync?.fatalAuthDetails;
			const detailText =
				details && (details.roomSchemaVersion !== null || details.clientSchemaVersion !== null)
					? ` (client=${details.clientSchemaVersion ?? "unknown"}, room=${details.roomSchemaVersion ?? "unknown"})`
					: "";
			new Notice(
				`YAOS: this vault was upgraded by a newer plugin schema${detailText}. ` +
				"Update YAOS on this device to continue syncing.",
				12000,
			);
			return;
		}

			new Notice("Unauthorized. Check your token in settings.");
		}

	private async saveDiskIndex(): Promise<void> {
		await this.persistPluginState();
	}

	private async persistBlobQueueSnapshot(snapshot: BlobQueueSnapshot): Promise<void> {
		// Only write if there's actually something to persist
		if (snapshot.uploads.length === 0 && snapshot.downloads.length === 0) return;
		await this.persistPluginState((state) => {
			state._blobQueue = snapshot;
		});
	}

	/**
	 * Clear the persisted blob queue once all transfers are done.
	 * Only writes if there was previously a saved queue.
	 */
	private async clearSavedBlobQueue(): Promise<void> {
		if (!this.persistedState._blobQueue) return;
		await this.persistPluginState((state) => {
			delete state._blobQueue;
		});
	}

	private refreshPersistedState(): void {
		const nextState: PersistedPluginState = {
			...this.settingsStore.withSettings(this.persistedState, this.settings),
			_diskIndex: this.diskIndex,
			_blobHashCache: this.blobHashCache,
		};
		const cachedCapabilities = this.capabilityUpdateService?.getPersistedServerCapabilitiesCache();
		if (cachedCapabilities) {
			nextState._serverCapabilitiesCache = cachedCapabilities;
		} else {
			delete nextState._serverCapabilitiesCache;
		}
		const cachedUpdateManifest = this.capabilityUpdateService?.getPersistedUpdateManifestCache();
		if (cachedUpdateManifest) {
			nextState._updateManifestCache = cachedUpdateManifest;
		} else {
			delete nextState._updateManifestCache;
		}
		if (this.frontmatterQuarantineEntries.length > 0) {
			nextState._frontmatterQuarantine = this.frontmatterQuarantineEntries;
		} else {
			delete nextState._frontmatterQuarantine;
		}
		const preserved = this.collectPreservedUnresolvedEntries();
		if (preserved.length > 0) {
			nextState._preservedUnresolved = preserved;
		} else {
			delete nextState._preservedUnresolved;
		}
		this.persistedState = nextState;
	}

	private collectPreservedUnresolvedEntries(): PreservedUnresolvedEntry[] {
		const entries = new Map<string, PreservedUnresolvedEntry>();
		const hasDiskRegistry = this.diskMirror !== null;
		const hasBlobRegistry = this.getBlobSync() !== null;
		for (const entry of this.preservedUnresolvedEntries) {
			if (entry.kind === "markdown" && hasDiskRegistry) continue;
			if (entry.kind === "blob" && hasBlobRegistry) continue;
			entries.set(`${entry.kind}:${entry.path}`, entry);
		}
		for (const entry of this.diskMirror?.getPreservedUnresolvedEntries() ?? []) {
			entries.set(`${entry.kind}:${entry.path}`, entry);
		}
		for (const entry of this.getBlobSync()?.getPreservedUnresolvedEntries() ?? []) {
			entries.set(`${entry.kind}:${entry.path}`, entry);
		}
		this.preservedUnresolvedEntries = Array.from(entries.values());
		return this.preservedUnresolvedEntries;
	}

	private persistPreservedUnresolvedState(): void {
		void this.persistPluginState();
		this.refreshStatusBar();
	}

	private async persistPluginState(
		mutate?: (state: PersistedPluginState) => void,
	): Promise<void> {
		// Serialize all plugin data writes so settings/index/blob queue updates
		// cannot clobber each other with interleaved load/merge/save cycles.
		const write = async () => {
			this.refreshPersistedState();
			mutate?.(this.persistedState);
			await this.settingsStore.save(this.persistedState);
		};

		this.persistWriteChain = this.persistWriteChain
			.catch(() => undefined)
			.then(write);
		await this.persistWriteChain;
	}

	private async sha256Hex(text: string): Promise<string> {
		const data = new TextEncoder().encode(text);
		const digest = await crypto.subtle.digest("SHA-256", data);
		return arrayBufferToHex(digest);
	}

	private async hashFrontmatterContent(content: string | null): Promise<string | undefined> {
		if (content == null) return undefined;
		const block = extractFrontmatter(content);
		if (block.kind !== "present") return undefined;
		return await this.sha256Hex(block.frontmatterText);
	}

	private runSchemaMigrationToV2(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized.");
			return;
		}
		runSchemaMigrationToV2({
			app: this.app,
			vaultSync: this.vaultSync,
			settings: this.settings,
			diagnosticsService: this.diagnosticsService,
			log: (msg) => this.log(msg),
			runReconciliation: async () => {
				const mode = this.vaultSync?.getSafeReconcileMode();
				if (!mode) return;
				await this.runReconciliation(mode);
			},
		});
	}

	private async runVfsTortureTest(): Promise<void> {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}
		await runVfsTortureTest({
			app: this.app,
			vaultSync: this.vaultSync,
			settings: this.settings,
			reconciliationController: this.reconciliationController,
			editorWorkspace: this.editorWorkspace,
			diagnosticsService: this.diagnosticsService,
			getBlobSync: () => this.getBlobSync(),
			getTraceHttpContext: () => this.getTraceHttpContext(),
			eventRing: this.eventRing,
			log: (msg) => this.log(msg),
		});
	}

	private log(msg: string): void {
		this.eventRing.push({ ts: new Date().toISOString(), msg });
		if (this.eventRing.length > 600) {
			this.eventRing.splice(0, this.eventRing.length - 600);
		}
		this.trace("plugin", msg);
		if (this.settings.debug) {
				console.debug(`[yaos] ${msg}`);
		}
	}

	private isIndexedDbRelatedError(err: unknown): boolean {
		if (!err) return false;
		const name =
			typeof (err as { name?: unknown })?.name === "string"
				? (err as { name: string }).name
				: "";
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: formatUnknown(err);
		const haystack = `${name} ${message}`.toLowerCase();
		return haystack.includes("quotaexceeded")
			|| haystack.includes("quota exceeded")
			|| haystack.includes("indexeddb")
			|| haystack.includes("idb");
	}

	private isObsidianFileMetadataRaceError(err: unknown): boolean {
		if (!err) return false;
		const message =
			typeof (err as { message?: unknown })?.message === "string"
				? (err as { message: string }).message
				: formatUnknown(err);
		const haystack = message.toLowerCase();
		return haystack.includes("cannot index file, since it has no obsidian file metadata")
			|| (haystack.includes("failed to index file") && haystack.includes("no obsidian file metadata"));
	}

	private handleIndexedDbDegraded(source: string, err?: unknown): void {
		if (!this.vaultSync) return;
		if (err) {
			this.vaultSync.reportIndexedDbError(err, "runtime");
		}
		if (!this.vaultSync.idbError || this.idbDegradedHandled) return;

		this.idbDegradedHandled = true;
		const kind = this.vaultSync.idbErrorDetails?.kind ?? "unknown";
		this.log(`IndexedDB degraded (${source}): kind=${kind}`);
		this.scheduleTraceStateSnapshot("idb-degraded");

		void this.attachmentOrchestrator?.stop("idb-degraded");

		const notice = kind === "quota_exceeded"
			? "YAOS: Device storage is full. Sync durability is degraded and attachment transfers are paused. Free up storage, then restart Obsidian."
			: "YAOS: IndexedDB persistence failed. Sync durability is degraded and attachment transfers are paused.";
		new Notice(notice, 12000);
	}
}
