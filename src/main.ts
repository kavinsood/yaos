import { MarkdownView, Modal, Notice, Platform, Plugin, TFile, arrayBufferToHex } from "obsidian";
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
	type FrontmatterValidationResult,
} from "./sync/frontmatterGuard";
import {
	readPersistedFrontmatterQuarantine,
	type FrontmatterQuarantineEntry,
} from "./sync/frontmatterQuarantine";
import {
	FrontmatterGuardCoordinator,
} from "./sync/frontmatterGuardCoordinator";
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
import { FlightTraceController } from "./debug/flightTraceController";
import { FLIGHT_KIND } from "./debug/flightEvents";
import type { FlightMode } from "./debug/flightEvents";
import { registerCommands } from "./commands";
import {
	getSyncStatusLabel,
	renderConnectionState,
	renderSyncStatus,
	type SyncStatus,
} from "./status/statusBarController";
import { formatUnknown, yTextToString } from "./utils/format";
import { randomBase64Url } from "./utils/base64url";
import { ConfirmModal } from "./ui/ConfirmModal";
import { runVfsTortureTest } from "./dev/vfsTortureTest";
import { runSchemaMigrationToV2 } from "./migrations/schemaV2";
import { buildQaDebugApi } from "./qaDebugApi";
import { DeviceWitnessTracker } from "./diagnostics/deviceWitnessTracker";
import { isLocalOrigin } from "./sync/origins";

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
	private flightTrace: FlightTraceController | null = null;
	private deviceWitnessTracker: import("./diagnostics/deviceWitnessTracker").DeviceWitnessTracker | null = null;
	/** SHA-256 hash of the active qaTraceSecret for cross-device identity verification. */
	private _qaTraceSecretHash: string | null = null;
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
	private frontmatterGuardCoordinator!: FrontmatterGuardCoordinator;
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
			recordFlightEvent: (event) => this.recordFlightEvent(event as import("./debug/flightEvents").FlightEventInput),
			recordFlightPathEvent: (event) => this.recordFlightPathEvent(event),
			computeRecoveryStateHash: async (path, content) => {
				const tracker = this.deviceWitnessTracker;
				if (!tracker) return null;
				try {
					return await tracker.computeWitnessStateHash(content);
				} catch {
					return null;
				}
			},
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
		const self = this;
		this.frontmatterGuardCoordinator = new FrontmatterGuardCoordinator({
			get frontmatterGuardEnabled() { return self.settings.frontmatterGuardEnabled; },
			trace: (source, event, data) => this.trace(source, event, data),
			persistPluginState: () => this.persistPluginState(),
			getFrontmatterQuarantineEntries: () => this.frontmatterQuarantineEntries,
			setFrontmatterQuarantineEntries: (entries) => {
				this.frontmatterQuarantineEntries = entries;
			},
		});
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
		this.setupFlightTrace();
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

		void this.initSync().then(() => this.mountQaDebugApi());
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
				onFlightEvent: (event) => this.recordFlightEvent(event as import("./debug/flightEvents").FlightEventInput),
				onFlightPathEvent: (event) => this.recordFlightPathEvent(event),
			});

			// 2. EditorBindingManager
			this.editorBindings = new EditorBindingManager(
				this.vaultSync,
				this.settings.debug,
				(source, msg, details) => this.trace(source, msg, details),
				(event) => this.recordFlightPathEvent(event),
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
			this.diskMirror.setFlightEventHandler((event) => this.recordFlightPathEvent(event as import("./debug/flightEvents").FlightPathEventInput));
			// Track SHA-256 baseline hash after every successful flushWrite.
			// Used by decideClosedFileConflict on startup/re-enable to determine
			// which side actually changed from the last known stable state.
			this.diskMirror.setDiskWriteCallback((path, contentHash) => {
				const existing = this.diskIndex[path];
				if (existing) {
					existing.contentHash = contentHash;
				} else {
					this.diskIndex[path] = { mtime: 0, size: 0, contentHash };
				}
				// Req 17.2: mark dirty after post-readback verification succeeds.
				// contentHash is baselineHash-domain — NOT published as diskHash.
				this.deviceWitnessTracker?.markDirty(path, "disk-write");
			});

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

			// Wire provider flight events
			this.vaultSync.provider.on("status", (event: { status: string }) => {
				if (event.status === "connected") {
					this.recordFlightEvent({
						priority: "important",
						kind: "provider.connected",
						severity: "info",
						scope: "connection",
						source: "connectionController",
						layer: "provider",
						connectionGeneration: this.vaultSync?.connectionGeneration,
						data: { wsStatus: event.status },
					});
				} else if (event.status === "disconnected") {
					this.recordFlightEvent({
						priority: "important",
						kind: "provider.disconnected",
						severity: "info",
						scope: "connection",
						source: "connectionController",
						layer: "provider",
						connectionGeneration: this.vaultSync?.connectionGeneration,
						data: { wsStatus: event.status },
					});
				}
			});
			this.vaultSync.provider.on("sync", (synced: boolean) => {
				if (synced) {
					this.recordFlightEvent({
						priority: "important",
						kind: "provider.sync.complete",
						severity: "info",
						scope: "connection",
						source: "connectionController",
						layer: "provider",
						connectionGeneration: this.vaultSync?.connectionGeneration,
					});
				}
			});
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
					startQaFlightTrace: (mode?: string) => this.startQaFlightTrace(mode),
					stopQaFlightTrace: () => this.stopQaFlightTrace(),
					exportSafeFlightTrace: () => this.exportSafeFlightTrace(),
					exportFullFlightTrace: () => this.exportFullFlightTrace(),
					showTimelineForCurrentFile: () => this.showTimelineForCurrentFile(),
					clearFlightLogs: () => this.clearFlightLogs(),
					// Phase 3 QA commands (only wired when qaDebugMode is on)
					...(this.settings.qaDebugMode ? {
						qaExportWitnessBundle: () => this._qaExportWitnessBundle("safe"),
						qaExportWitnessBundleUnsafe: () => this._qaExportWitnessBundle("unsafe-local"),
						qaShowDeviceIdentity: () => this._qaShowDeviceIdentity(),
						qaSetScenarioRunId: () => this._qaSetScenarioRunId(),
						qaAdvanceScenarioStep: () => this._qaAdvanceScenarioStep(),
						qaRefreshWitnessCurrentFile: () => this._qaRefreshWitnessCurrentFile(),
					} : {}),
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

				// Redirect any pending dirty creates or modifies from oldPath → newPath.
				// Two race classes this handles:
				//   1. Pre-CRDT race: rename fires before create is processed →
				//      pending create at oldPath redirected to newPath (ensureFile runs there).
				//   2. Modify-then-rename race: modify queued, rename fires before drain →
				//      pending modify at oldPath redirected to newPath (syncFileFromDisk runs there).
				// Without this, both cases leave newPath with stale or missing CRDT content.
				for (const [oldPath, newPath] of renames) {
					this.reconciliationController.redirectPendingDirtyPath(oldPath, newPath);
				}

				// Tombstone any CRDT entries that applyRenameBatch moved to an excluded path,
				// and drop any dirty work redirected there.
				//
				// Contract: the caller must never leave an excluded path active in CRDT.
				// applyRenameBatch has no access to path exclusion rules, so the caller
				// enforces policy here after every flush.
				//
				// dropDirtyPath is unconditional — "excluded path" means "do not sync this
				// path", regardless of whether a CRDT identity exists there. The tombstone
				// only fires if applyRenameBatch actually promoted a fileId to newPath.
				for (const [, newPath] of renames) {
					if (!this.isMarkdownPathSyncable(newPath)) {
						this.reconciliationController.dropDirtyPath(newPath);
						if (this.vaultSync?.getFileId(newPath)) {
							this.log(`onRenameBatchFlushed: tombstoning excluded destination "${newPath}"`);
							this.vaultSync.handleDelete(newPath);
						}
					}
				}
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

	private newOpId(): string {
		return `op-${randomBase64Url(10)}`;
	}

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
					const opId = this.newOpId();
					this.recordFlightPathEvent({
						priority: "important",
						kind: FLIGHT_KIND.diskModifyObserved,
						severity: "info",
						scope: "file",
						source: "vaultEvents",
						layer: "disk",
						opId,
						path: file.path,
						data: { size: file.stat?.size ?? null },
					});
					this.reconciliationController.markMarkdownDirty(file, "modify", opId);
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
				const renameOpId = this.newOpId();
				if (this.isMarkdownPathSyncable(oldPath) || this.isMarkdownPathSyncable(file.path)) {
					// Emit two disk.rename.observed events sharing the same opId so the
					// analyzer can reconstruct full old→new lineage without raw paths.
					// Both are tracked by pendingPathPromises and flushed before export.
					this.recordFlightPathEvent({
						priority: "important",
						kind: FLIGHT_KIND.diskRenameObserved,
						severity: "info",
						scope: "file",
						source: "vaultEvents",
						layer: "disk",
						opId: renameOpId,
						path: oldPath,   // resolves to oldPathId
						data: { renameRole: "source", wasMarkdownSyncable: this.isMarkdownPathSyncable(oldPath) },
					});
					this.recordFlightPathEvent({
						priority: "important",
						kind: FLIGHT_KIND.diskRenameObserved,
						severity: "info",
						scope: "file",
						source: "vaultEvents",
						layer: "disk",
						opId: renameOpId,
						path: file.path, // resolves to newPathId
						data: { renameRole: "target", isBlobSyncable: this.isBlobPathSyncable(file.path) },
					});
				}
				this.vaultSync?.queueRename(oldPath, file.path);
				this.log(`Rename queued: "${oldPath}" -> "${file.path}"`);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					const opId = this.newOpId();
					if (this.diskMirror?.consumeDeleteSuppression(file.path)) {
						this.log(`Suppressed delete event for "${file.path}"`);
						this.recordFlightPathEvent({
							priority: "important",
							kind: FLIGHT_KIND.diskEventSuppressed,
							severity: "debug",
							scope: "file",
							source: "vaultEvents",
							layer: "policy",
							opId,
							path: file.path,
							reason: "suppressed-remote-writeback",
							decision: "suppress",
						});
						return;
					}
					this.recordFlightPathEvent({
						priority: "critical",
						kind: FLIGHT_KIND.diskDeleteObserved,
						severity: "info",
						scope: "file",
						source: "vaultEvents",
						layer: "disk",
						opId,
						path: file.path,
					});
					this.editorWorkspace?.onMarkdownDeleted(file.path);

					this.vaultSync?.handleDelete(
						file.path,
						this.settings.deviceName,
						opId,
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
					const createOpId = this.newOpId();
					this.recordFlightPathEvent({
						priority: "important",
						kind: FLIGHT_KIND.diskCreateObserved,
						severity: "info",
						scope: "file",
						source: "vaultEvents",
						layer: "disk",
						opId: createOpId,
						path: file.path,
						data: { size: file.stat?.size ?? null },
					});
					this.reconciliationController.markMarkdownDirty(file, "create", createOpId);
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

		// Safe teardown ordering for disk index baseline persistence:
		//   1. Flush all pending disk writes (callbacks fire, hashes recorded in memory)
		//   2. Save disk index to data.json (hashes now current for next startup)
		//   3. Destroy sync state (nothing pending left to flush)
		if (this.diskMirror) {
			await this.diskMirror.flushAllPendingWrites();
		}
		await this.saveDiskIndex();

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
		return this.frontmatterGuardCoordinator.shouldBlockFrontmatterIngest(
			path, previousContent, nextContent, reason,
		);
	}

	private handleFrontmatterValidation(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousContent: string | null,
		nextContent: string,
	): void {
		this.frontmatterGuardCoordinator.handleFrontmatterValidation(
			path, direction, reason, validation, previousContent, nextContent,
		);
	}

	private showFrontmatterGuardNotice(path: string): void {
		this.frontmatterGuardCoordinator.showFrontmatterGuardNotice(path);
	}

	private buildFrontmatterNoticeFingerprint(
		validation: FrontmatterValidationResult,
	): string {
		return this.frontmatterGuardCoordinator.buildFrontmatterNoticeFingerprint(validation);
	}

	private shouldNotifyFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		noticeFingerprint: string,
	): boolean {
		return this.frontmatterGuardCoordinator.shouldNotifyFrontmatterQuarantine(
			path, direction, noticeFingerprint,
		);
	}

	private clearFrontmatterNoticeFingerprint(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
	): void {
		this.frontmatterGuardCoordinator.clearFrontmatterNoticeFingerprint(path, direction);
	}

	private traceFrontmatterQuarantine(
		path: string,
		direction: "disk-to-crdt" | "crdt-to-disk",
		reason: string,
		validation: FrontmatterValidationResult,
		previousLength: number | null,
		nextLength: number,
	): void {
		this.frontmatterGuardCoordinator.traceFrontmatterQuarantine(
			path, direction, reason, validation, previousLength, nextLength,
		);
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
		await this.frontmatterGuardCoordinator.persistFrontmatterQuarantine(
			path, direction, validation, previousContent, nextContent,
			lastNotifiedFingerprint, lastNoticeAt,
		);
	}

	private async clearFrontmatterQuarantine(path: string, reason: string): Promise<void> {
		await this.frontmatterGuardCoordinator.clearFrontmatterQuarantine(path, reason);
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

	private setupFlightTrace(): void {
		this.flightTrace = new FlightTraceController({
			app: this.app,
			getSettings: () => this.settings,
			getPluginVersion: () => this.manifest.version,
			getDocSchemaVersion: () => this.vaultSync?.storedSchemaVersion ?? null,
			buildCheckpoint: () => this.buildFlightCheckpoint(),
			registerCleanup: (cleanup) => this.register(cleanup),
			log: (message) => this.log(message),
		});
		void this.refreshFlightTraceState("startup");
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

	private recordFlightEvent(event: import("./debug/flightEvents").FlightEventInput): void {
		this.flightTrace?.record(event);
	}

	private recordFlightPathEvent(event: import("./debug/flightEvents").FlightPathEventInput): void {
		// Augment CRDT admission events and rename target events with path policy metadata.
		// This allows the analyzer to detect active excluded paths in safe-mode traces
		// (where raw paths are redacted to pathIds) without duplicating exclusion logic.
		// The product already knows the policy decision at the event source — embed it here.
		const admissionKinds = new Set([
			"crdt.file.created",
			"crdt.file.renamed",
			"crdt.file.revived",
		]);
		const isAdmissionOrRenameTarget =
			admissionKinds.has(event.kind) ||
			(event.kind === "disk.rename.observed" &&
				(event.data as Record<string, unknown> | undefined)?.renameRole === "target");

		if (isAdmissionOrRenameTarget) {
			const excludedByPolicy = !this.isMarkdownPathSyncable(event.path);
			event = {
				...event,
				data: {
					...(event.data as Record<string, unknown> | undefined ?? {}),
					excludedByPolicy,
				},
			};
		}

		void this.flightTrace?.recordPath(event);

		// Req 17.3: mark dirty for recovery.decision and recovery.apply.done.
		if (
			(event.kind === "recovery.decision" || event.kind === "recovery.apply.done") &&
			event.path.endsWith(".md")
		) {
			this.deviceWitnessTracker?.markDirty(event.path, "recovery");
		}

		// Phase 2 Req 11 + Fix 4: precision path for recovery_emitted_old_hash.
		// reserveAndRecordPath reserves seq synchronously and returns it — no currentSeq inference.
		if (event.kind === "recovery.decision" && event.path.endsWith(".md")) {
			const data = event.data as Record<string, unknown> | undefined;
			const recoveryStateHash = data?.recoveryStateHash as string | undefined;
			if (this.flightTrace) {
				// Use reserveAndRecordPath to get the actual seq for this event
				const recoverySeq = this.flightTrace.reserveAndRecordPath(event);
				this.deviceWitnessTracker?.notifyPrecursorEvent(event.path, "recovery", recoverySeq);
				this.deviceWitnessTracker?.handleRecoveryDecision(event.path, recoveryStateHash);
			} else {
				this.deviceWitnessTracker?.handleRecoveryDecision(event.path, recoveryStateHash);
			}
			return; // already recorded above
		}
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

	private async buildFlightCheckpoint(): Promise<Record<string, unknown>> {
		const vaultSync = this.vaultSync;
		const blobSync = this.getBlobSync();
		return {
			connected: vaultSync?.connected ?? false,
			providerSynced: vaultSync?.providerSynced ?? false,
			serverReceipt: vaultSync?.serverAppliedLocalState ?? null,
			diskFileCount: this.app.vault.getMarkdownFiles().length,
			crdtPathCount: vaultSync?.getActiveMarkdownPaths().length ?? 0,
			missingOnDisk: 0,
			missingInCrdt: 0,
			hashMismatches: 0,
			pendingBlobUploads: blobSync?.pendingUploads ?? 0,
			pendingBlobDownloads: blobSync?.pendingDownloads ?? 0,
			reconcileInFlight: this.reconciliationController?.isReconcileInFlight ?? false,
			safetyBrakeActive: this.reconciliationController?.getState().lastReconcileStats?.safetyBrakeTriggered ?? false,
		};
	}

	private async refreshFlightTraceState(reason: string): Promise<void> {
		if (!this.flightTrace) return;
		await this.flightTrace.refreshFromSettings(reason);
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
		void this.flightTrace?.stop();
		void this.traceRuntime?.shutdown();
		document.body.removeClass("vault-crdt-show-cursors");
		// Remove plugin-owned debug global to prevent stale API references
		// from confusing test harnesses after plugin reload.
		const win = window as unknown as Record<string, unknown>;
		if (win.__YAOS_DEBUG__) {
			delete win.__YAOS_DEBUG__;
		}
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
		void this.refreshFlightTraceState(reason);
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

	private async startQaFlightTrace(mode?: string): Promise<void> {
		const resolved = (mode ?? this.settings.qaTraceMode) as FlightMode;
		await this.flightTrace?.start(resolved, this.settings.qaTraceSecret || null, {
			manualStart: true,
		});
		// Compute SHA-256 of qaTraceSecret for cross-device identity verification (Fix 3)
		const secret = this.settings.qaTraceSecret ?? "";
		try {
			const bytes = new TextEncoder().encode(`yaos-qa-trace-secret:${secret}`);
			const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
			const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
			this._qaTraceSecretHash = `sha256:${hex}`;
		} catch {
			this._qaTraceSecretHash = `len:${secret.length}`;
		}
		this._startDeviceWitnessTracker(resolved);
		new Notice(`QA flight trace started (mode: ${resolved}).`, 4000);
	}

	private async stopQaFlightTrace(): Promise<void> {
		// Phase 3: persist checkpoint segments to filesystem on trace stop (opt-in, fail-closed)
		await this._persistCheckpointSegmentsIfSafe();
		this._stopDeviceWitnessTracker();
		await this.flightTrace?.stop();
		new Notice("QA flight trace stopped.", 4000);
	}

	// -----------------------------------------------------------------------
	// Phase 3: witness bundle export + identity command + scenario commands
	// -----------------------------------------------------------------------

	private _buildBundleHeader(privacyMode: "safe" | "unsafe-local"): Record<string, unknown> {
		const ftc = this.flightTrace;
		const ctx = ftc?.context;
		const tracker = this.deviceWitnessTracker;
		const segments = tracker?.getCheckpointSegments() ?? [];
		const eventCount = segments.reduce((n, s) => {
			return n + s.content.split("\n").filter((l) => {
				if (!l.trim()) return false;
				try { const o = JSON.parse(l) as Record<string, unknown>; return o.kind !== "checkpoint.segment.header"; } catch { return false; }
			}).length;
		}, 0);
		const scenarioState = tracker?.getScenarioStepState();
		return {
			kind: "bundle.header",
			bundleSchemaVersion: 1,
			createdAt: new Date().toISOString(),
			pluginVersion: this.manifest.version,
			deviceId: ctx?.deviceId ?? "unknown",
			deviceLabel: this.settings.deviceName ?? "unknown",
			platform: Platform.isMobile ? (Platform.isIosApp ? "ios" : "android") : "desktop",
			runtimeState: tracker?.getRuntimeState() ?? "unknown",
			localTraceId: ctx?.traceId ?? "unknown",
			scenarioRunId: scenarioState?.scenarioRunId ?? null,
			scenarioId: scenarioState?.scenarioId ?? null,
			qaTraceSecretHash: this._qaTraceSecretHash ?? "(no qaTraceSecret configured)",
			flightMode: ftc?.currentRecorder?.mode ?? "safe",
			eventCount,
			containsRawPaths: privacyMode === "unsafe-local",
			hashDomain: "witness-state-v1",
			privacyMode,
		};
	}

	private _buildBundleString(privacyMode: "safe" | "unsafe-local"): string {
		const header = this._buildBundleHeader(privacyMode);
		const tracker = this.deviceWitnessTracker;
		const segments = tracker?.getCheckpointSegments() ?? [];
		const lines = [JSON.stringify(header)];
		for (const seg of segments) {
			lines.push(seg.content.trimEnd());
		}
		return lines.join("\n") + "\n";
	}

	private async _qaExportWitnessBundle(privacyMode: "safe" | "unsafe-local"): Promise<void> {
		if (!this.settings.qaDebugMode) return;
		const tracker = this.deviceWitnessTracker;
		const ftc = this.flightTrace;
		if (!tracker || !ftc?.context) {
			new Notice("No active flight trace; nothing to export", 5000);
			return;
		}
		const bundleStr = this._buildBundleString(privacyMode);

		// Primary: clipboard
		let clipboardOk = false;
		try {
			await navigator.clipboard.writeText(bundleStr);
			clipboardOk = true;
		} catch { /* fall through to modal */ }

		if (clipboardOk) {
			new Notice("Witness bundle copied to clipboard.", 5000);
			return;
		}

		// Fallback: modal with selectable text (reliable on mobile when clipboard is unavailable)
		this._showBundleModal(bundleStr);
	}

	private _showBundleModal(bundleStr: string): void {
		const tracker = this.deviceWitnessTracker;
		const scenarioState = tracker?.getScenarioStepState();
		const segments = tracker?.getCheckpointSegments() ?? [];
		const eventCount = segments.reduce((n, s) => n + s.content.split("\n").filter((l) => {
			if (!l.trim()) return false;
			try { return (JSON.parse(l) as Record<string, unknown>).kind !== "checkpoint.segment.header"; } catch { return false; }
		}).length, 0);
		const modal = new Modal(this.app);
		modal.titleEl.setText("YAOS QA: Witness Bundle");
		const info = modal.contentEl.createEl("div", { attr: { style: "font-size:11px;font-family:monospace;background:var(--background-secondary);padding:8px;border-radius:4px;margin-bottom:8px;" } });
		info.createEl("div", { text: `deviceId: ${this.flightTrace?.context?.deviceId ?? "unknown"}` });
		info.createEl("div", { text: `scenarioRunId: ${scenarioState?.scenarioRunId ?? "(not set)"}` });
		info.createEl("div", { text: `scenarioId: ${scenarioState?.scenarioId ?? "(not set)"}` });
		info.createEl("div", { text: `events: ${eventCount}  |  privacyMode: safe` });
		const ta = modal.contentEl.createEl("textarea", {
			attr: { rows: "18", style: "width:100%;font-size:9px;font-family:monospace;white-space:pre;" },
		});
		ta.value = bundleStr;
		modal.contentEl.createEl("p", { text: "Select all → copy → share to your analysis machine.", attr: { style: "font-size:11px;color:var(--text-muted);margin-top:6px;" } });
		modal.open();
		setTimeout(() => { ta.select(); }, 50);
	}

	private _qaShowDeviceIdentity(): void {
		if (!this.settings.qaDebugMode) return;
		const ftc = this.flightTrace;
		const ctx = ftc?.context;
		const tracker = this.deviceWitnessTracker;
		const scenarioState = tracker?.getScenarioStepState();
		const platform = Platform.isMobile ? (Platform.isIosApp ? "ios" : "android") : "desktop";

		// Use cached hash if trace is active, otherwise compute from settings secret
		const secretHash = this._qaTraceSecretHash ?? (() => {
			const secret = this.settings.qaTraceSecret;
			if (!secret) return null;
			// Synchronous fallback: show length only (async SHA-256 not available here)
			// The full hash is only available after startFlightTrace
			return `len:${secret.length} (start trace for full sha256)`;
		})();

		const truncatedHash = secretHash?.startsWith("sha256:")
			? `sha256:${secretHash.slice(7, 19)}…${secretHash.slice(-4)}`
			: secretHash ?? "(no qaTraceSecret configured)";

		const lines = [
			`deviceId: ${ctx?.deviceId ?? "unknown (start trace to get deviceId)"}`,
			`Device label (display-only — never used as a key): ${this.settings.deviceName ?? "unknown"}`,
			`pluginVersion: ${this.manifest.version}`,
			`platform: ${platform}`,
			`flightMode: ${ftc?.currentRecorder?.mode ?? "(no active trace)"}`,
			`traceActive: ${!!ctx}`,
			`localTraceId: ${ctx?.traceId ?? "(none)"}`,
			`scenarioRunId: ${scenarioState?.scenarioRunId ?? "(not set)"}`,
			`scenarioId: ${scenarioState?.scenarioId ?? "(not set)"}`,
			`qaTraceSecretHash: ${truncatedHash}`,
			`runtimeState: ${tracker?.getRuntimeState() ?? "unknown"}`,
			`bundleExportAvailable: ${!!(tracker && (tracker.getCheckpointSegments().length > 0))}`,
		].join("\n");

		new Notice(lines, 12000);
		console.debug("[yaos] Device identity for QA:\n" + lines);
		navigator.clipboard.writeText(lines).catch(() => { /* best-effort */ });
	}

	private _qaSetScenarioRunId(): void {
		if (!this.settings.qaDebugMode) return;
		const tracker = this.deviceWitnessTracker;
		if (!tracker) {
			new Notice("No active flight trace. Start a trace first.", 5000);
			return;
		}
		const modal = new Modal(this.app);
		modal.titleEl.setText("YAOS QA: Set Scenario Run ID");
		const addField = (label: string, placeholder: string): HTMLInputElement => {
			modal.contentEl.createEl("label", { text: label, attr: { style: "display:block;font-size:12px;margin-top:10px;margin-bottom:2px;" } });
			return modal.contentEl.createEl("input", { attr: { type: "text", placeholder, style: "width:100%;padding:4px;font-size:13px;" } });
		};
		const runIdInput = addField("scenarioRunId (shared across all devices)", "e.g. s12a-run-2026-05-19");
		const scenarioIdInput = addField("scenarioId", "e.g. s12a-three-device-passive-quorum");
		const btn = modal.contentEl.createEl("button", { text: "Set", attr: { style: "margin-top:14px;padding:6px 16px;" } });
		btn.addEventListener("click", () => {
			const runId = runIdInput.value.trim();
			const scenarioId = scenarioIdInput.value.trim();
			if (!runId || !scenarioId) { new Notice("Both fields are required.", 3000); return; }
			tracker.setScenarioRunId(runId, scenarioId);
			new Notice(`Scenario run ID set: ${runId} / ${scenarioId}`, 5000);
			modal.close();
		});
		modal.open();
		setTimeout(() => { runIdInput.focus(); }, 50);
	}

	private _qaAdvanceScenarioStep(): void {
		if (!this.settings.qaDebugMode) return;
		const api = (window as unknown as Record<string, unknown>).__YAOS_DEBUG__ as import("./qaDebugApi").YaosQaDebugApi | undefined;
		if (!api) {
			new Notice("QA debug API not mounted. Enable qaDebugMode and start a trace.", 5000);
			return;
		}
		const tracker = this.deviceWitnessTracker;
		const currentStep = tracker?.getScenarioStepState().stepIndex ?? null;
		const modal = new Modal(this.app);
		modal.titleEl.setText("YAOS QA: Advance Scenario Step");
		if (currentStep !== null) {
			modal.contentEl.createEl("p", { text: `Current step: ${currentStep}`, attr: { style: "font-size:12px;color:var(--text-muted);margin-bottom:8px;" } });
		}
		const addField = (label: string, placeholder: string): HTMLInputElement => {
			modal.contentEl.createEl("label", { text: label, attr: { style: "display:block;font-size:12px;margin-top:8px;margin-bottom:2px;" } });
			return modal.contentEl.createEl("input", { attr: { type: "text", placeholder, style: "width:100%;padding:4px;font-size:13px;" } });
		};
		const stepInput = addField("scenarioStepIndex (must be > current)", `e.g. ${(currentStep ?? 0) + 1}`);
		const labelInput = addField("stepLabel (optional)", "e.g. pre-action-baseline");
		const btn = modal.contentEl.createEl("button", { text: "Advance", attr: { style: "margin-top:14px;padding:6px 16px;" } });
		btn.addEventListener("click", () => {
			const stepIndex = parseInt(stepInput.value.trim(), 10);
			if (isNaN(stepIndex) || stepIndex < 0) { new Notice("Enter a non-negative integer.", 4000); return; }
			if (currentStep !== null && stepIndex <= currentStep) {
				new Notice(`Step must be greater than current step (${currentStep}).`, 4000);
				return;
			}
			const label = labelInput.value.trim() || undefined;
			api.__qaOnlyAdvanceScenarioStepUnsafe?.(stepIndex, label);
			new Notice(`Scenario step advanced to ${stepIndex}${label ? ` (${label})` : ""}`, 4000);
			modal.close();
		});
		modal.open();
		setTimeout(() => { stepInput.focus(); }, 50);
	}

	private async _persistCheckpointSegmentsIfSafe(): Promise<void> {
		// Filesystem persistence is always fail-closed on desktop: configDir (.obsidian) is
		// inside the vault root. In-memory segments are the canonical store; bundle export
		// via clipboard/modal is the primary export channel (Requirement 4.0).
		// No-op: segments remain in-memory until the tracker is disposed.
	}

	private _qaRefreshWitnessCurrentFile(): void {
		if (!this.settings.qaDebugMode) return;
		const tracker = this.deviceWitnessTracker;
		if (!tracker) {
			new Notice("No active flight trace. Start a trace first.", 5000);
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file || !file.path.endsWith(".md")) {
			new Notice("Open a Markdown file first.", 4000);
			return;
		}
		const path = file.path;
		tracker.clearSuppressionForPath(path);
		tracker.markDirty(path, "disk-write");
		const fileId = this.vaultSync?.getFileId(path);
		new Notice(`Witness refresh triggered: ${path}${fileId ? ` (fileId: ${fileId.slice(0, 8)}…)` : ""}`, 5000);
	}

	private _startDeviceWitnessTracker(mode: FlightMode): void {
		this._stopDeviceWitnessTracker();
		const sink = this.flightTrace;
		const ctx = this.flightTrace?.context;
		if (!sink || !ctx) return;

		this.deviceWitnessTracker = new DeviceWitnessTracker({
			stateSecret: randomBase64Url(16),
			qaTraceSecret: this.settings.qaTraceSecret || null,
			flightMode: mode,
			sink,
			traceContext: ctx,
			platform: Platform.isMobile ? "mobile" : "desktop",
			// Fix 2: provide pathId resolver so checkpoint lines include pathId
			getPathId: async (path) => {
				try {
					const result = await this.flightTrace?.getPathId(path);
					return result?.pathId ?? null;
				} catch {
					return null;
				}
			},
			readCrdtContent: (path) => {
				const vs = this.vaultSync;
				if (!vs) return null;
				const text = vs.getTextForPath(path);
				if (!text) return null;
				return yTextToString(text);
			},
			isCrdtTombstoned: (path) => {
				return this.vaultSync?.isMarkdownTombstoned(path) ?? false;
			},
			getFileId: (path) => {
				return this.vaultSync?.getFileId(path);
			},
			readDiskContent: async (path) => {
				const file = this.app.vault.getFileByPath(path);
				if (!file) return null;
				try {
					return await this.app.vault.read(file);
				} catch {
					return null;
				}
			},
			sampleEditor: (path) => {
				const editorBindings = this.editorBindings;
				if (!editorBindings) return { kind: "not_open", content: null };

				let targetView: MarkdownView | null = null;
				this.app.workspace.iterateAllLeaves((leaf) => {
					if (targetView) return;
					const view = leaf.view as unknown as { file?: { path?: string } };
					if (view?.file?.path === path) {
						targetView = leaf.view as unknown as MarkdownView;
					}
				});
				if (!targetView) return { kind: "not_open", content: null };

				const health = editorBindings.getBindingHealthForView(targetView);
				if (!health.bound) return { kind: "not_open", content: null };
				if (health.settling) return { kind: "settling", content: null };
				if (!health.healthy) return { kind: "unhealthy", content: null };

				let content: string | null = null;
				try {
					const view = targetView as unknown as { editor?: { getValue?: () => string } };
					content = view.editor?.getValue?.() ?? null;
				} catch {
					content = null;
				}
				return { kind: "healthy_sampled", content };
			},
		});

		// Wire Y.Text observers for any-origin transaction dirty triggers (Req 3.1).
		const vs = this.vaultSync;
		if (vs) {
			this._witnessTextObservers = new Map();
			const tracker = this.deviceWitnessTracker;

			const attachTextObserver = (fileId: string, ytext: import("yjs").Text) => {
				if (this._witnessTextObservers?.has(fileId)) return;
				const handler = (_event: unknown, txn: { origin: unknown }) => {
					// Find path for this fileId.
					let path: string | undefined;
					vs.meta.forEach((meta, id) => {
						if (id === fileId && typeof meta.path === "string") path = meta.path;
					});
					if (!path || !path.endsWith(".md")) return;
					const originClass = isLocalOrigin(txn.origin, vs.provider) ? "local-edit" : "remote-apply";
					tracker?.markDirty(path, originClass);
				};
				(ytext as unknown as { observe: (h: typeof handler) => void }).observe(handler);
				this._witnessTextObservers?.set(fileId, { ytext, handler });
			};

			// Attach to all existing texts.
			vs.idToText.forEach((ytext, fileId) => attachTextObserver(fileId, ytext));

			// Observe new texts added to idToText.
			const idToTextHandler = () => {
				vs.idToText.forEach((ytext, fileId) => attachTextObserver(fileId, ytext));
			};
			vs.idToText.observe(idToTextHandler);
			this._witnessIdToTextHandler = idToTextHandler;

			// Observe meta map for tombstone transitions (Req 3.4).
			const metaHandler = () => {
				vs.meta.forEach((meta, fileId) => {
					void fileId;
					const path = typeof meta.path === "string" ? meta.path : undefined;
					if (!path || !path.endsWith(".md")) return;
					if (vs.isFileMetaDeleted(meta)) {
						tracker?.markDirty(path, "tombstone");
					}
				});
			};
			vs.meta.observe(metaHandler);
			this._witnessMetaHandler = metaHandler;
		}
	}

	private _witnessTextObservers: Map<string, { ytext: import("yjs").Text; handler: (...args: unknown[]) => void }> | null = null;
	private _witnessIdToTextHandler: (() => void) | null = null;
	private _witnessMetaHandler: (() => void) | null = null;

	private _stopDeviceWitnessTracker(): void {
		if (this._witnessTextObservers) {
			for (const { ytext, handler } of this._witnessTextObservers.values()) {
				try { (ytext as unknown as { unobserve: (h: typeof handler) => void }).unobserve(handler); } catch { /* ignore */ }
			}
			this._witnessTextObservers = null;
		}
		if (this._witnessIdToTextHandler && this.vaultSync) {
			try { this.vaultSync.idToText.unobserve(this._witnessIdToTextHandler); } catch { /* ignore */ }
			this._witnessIdToTextHandler = null;
		}
		if (this._witnessMetaHandler && this.vaultSync) {
			try { this.vaultSync.meta.unobserve(this._witnessMetaHandler); } catch { /* ignore */ }
			this._witnessMetaHandler = null;
		}
		this.deviceWitnessTracker?.dispose();
		this.deviceWitnessTracker = null;
	}

	private async exportSafeFlightTrace(): Promise<void> {
		await this.exportFlightTrace("safe");
	}

	private async exportFullFlightTrace(): Promise<void> {
		await new Promise<void>((resolve) => {
			new ConfirmModal(
				this.app,
				"Export flight trace with filenames?",
				"This export includes vault file names. It never includes note contents or sync tokens. Review before sharing.",
				async () => {
					try {
						await this.exportFlightTrace("full");
					} catch (err) {
						this.log(`flight trace export failed: ${String(err)}`);
						new Notice("Flight trace export failed. Check console.", 10000);
					} finally {
						resolve();
					}
				},
				"Export with filenames",
				"Cancel",
				() => resolve(),
			).open();
		});
	}

	private async exportFlightTrace(requestedPrivacy: "safe" | "full"): Promise<void> {
		const controller = this.flightTrace;
		if (!controller?.isEnabled) {
			new Notice("QA flight trace is not active. Start it first.", 6000);
			return;
		}
		const diagDir = await this.diagnosticsService?.ensureDiagnosticsDir();
		if (!diagDir) {
			new Notice("Diagnostics directory unavailable.", 6000);
			return;
		}
		new Notice("Exporting QA flight trace…");
		const result = await controller.exportTrace({ requestedPrivacy, diagDir });
		if (!result.ok) {
			switch (result.reason) {
				case "trace-not-active":
					new Notice("QA flight trace is not active.", 6000);
					break;
				case "trace-unsafe-for-safe-export": {
					const mode = controller.currentRecorder?.mode ?? "unknown";
					new Notice(
						`This trace was recorded in "${mode}" mode and includes filenames. ` +
						`Export with filenames instead, or start a new safe trace.`,
						10000,
					);
					break;
				}
				case "trace-not-exportable":
					new Notice(
						"Local-private traces cannot be exported. Start a new trace in safe or qa-safe mode.",
						10000,
					);
					break;
				case "flush-failed":
					new Notice("Failed to flush trace buffer before export. Check console.", 10000);
					break;
				default:
					new Notice("Flight trace export failed. Check console.", 10000);
					break;
			}
			this.log(`flight trace export failed: ${result.reason}`);
			return;
		}
		const outName = result.path.split("/").pop() ?? result.path;
		new Notice(`Flight trace exported: ${outName}`, 8000);
		this.log(`Flight trace exported (${requestedPrivacy}) to: ${result.path}`);
	}

	private async clearFlightLogs(): Promise<void> {
		await this.flightTrace?.clearLogs();
	}

	private showTimelineForCurrentFile(): void {
		const controller = this.flightTrace;
		if (!controller?.isEnabled) {
			new Notice("QA flight trace is not active.", 5000);
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active file.", 4000);
			return;
		}
		void controller.getPathId(file.path).then(({ pathId }) => {
			const recorder = controller.currentRecorder;
			if (!recorder) {
				new Notice("Recorder not available.", 4000);
				return;
			}
			const events = recorder.getRecentEventsForPath(pathId, 100);
			if (events.length === 0) {
				new Notice(`No flight trace events for this file yet (${pathId}).`, 6000);
				console.debug(`[yaos] No flight events for pathId=${pathId} (${file.path})`);
				return;
			}
			const lines = events.map((e) => `${new Date(e.ts).toISOString()} [${e.severity}] ${e.kind}${e.reason ? ` reason=${e.reason}` : ""}${e.decision ? ` decision=${e.decision}` : ""}`);
			const summary = lines.join("\n");
			new Notice(`Timeline for ${file.path} (${events.length} events) printed to console.`, 6000);
			console.debug(`[yaos] Flight timeline for ${file.path} (pathId=${pathId}):\n${summary}`);
		});
	}

	// -------------------------------------------------------------------
	// QA debug API surface
	// -------------------------------------------------------------------

	private mountQaDebugApi(): void {
		if (!this.settings.qaDebugMode) return;
		const api = buildQaDebugApi({
			app: this.app,
			getVaultSync: () => this.vaultSync,
			getReconciliationController: () => this.reconciliationController,
			getConnectionController: () => this.connectionController,
			getFlightTraceController: () => this.flightTrace,
			getEditorBindings: () => this.editorBindings,
			getDiagnosticsDir: () => this.diagnosticsService?.ensureDiagnosticsDir(),
			sha256Hex: (text) => this.sha256Hex(text),
			startQaFlightTrace: (mode) => this.startQaFlightTrace(mode),
			stopQaFlightTrace: () => this.stopQaFlightTrace(),
			exportFlightTrace: (privacy) => this.exportFlightTraceForApi(privacy),
			runReconciliation: () => this.runReconciliation(this.vaultSync?.getSafeReconcileMode() ?? "conservative"),
			disconnectProvider: (reason) => {
				this.log(`QA: disconnectProvider(${reason ?? ""})`);
				this.vaultSync?.provider.disconnect();
			},
			connectProvider: (reason) => {
				this.log(`QA: connectProvider(${reason ?? ""})`);
				void this.vaultSync?.provider.connect().catch((e) =>
					this.log(`QA connectProvider error: ${String(e)}`),
				);
			},
			getDeviceWitnessTracker: () => this.deviceWitnessTracker,
			getQaTraceSecretHash: () => this._qaTraceSecretHash,
		});
		(window as unknown as Record<string, unknown>).__YAOS_DEBUG__ = api;
		this.log("QA debug API mounted at window.__YAOS_DEBUG__");
		new Notice("YAOS: QA debug mode active. window.__YAOS_DEBUG__ is available.", 6000);
	}

	private async exportFlightTraceForApi(privacy: "safe" | "full"): Promise<string | null> {
		const controller = this.flightTrace;
		if (!controller?.isEnabled) return null;
		const diagDir = await this.diagnosticsService?.ensureDiagnosticsDir();
		if (!diagDir) return null;
		const result = await controller.exportTrace({ requestedPrivacy: privacy, diagDir });
		return result.ok ? result.path : null;
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
