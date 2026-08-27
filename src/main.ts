import { MarkdownView, Notice, Platform, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VaultSyncSettingTab,
	type VaultRosterDevice,
	type VaultSyncSettings,
} from "./settings";
import { SettingsStore } from "./settings/settingsStore";
import { VaultSync, type ReconcileMode } from "./sync/vaultSync";
import { SCHEMA_VERSION } from "./sync/vaultSync";
import { computeFolderKey, folderKeySeedFromVault } from "./sync/vaultPersistence";
import { EditorBindingManager } from "./sync/editorBinding";
import { DiskMirror } from "./sync/diskMirror";
import { type BlobQueueSnapshot, type BlobSyncManager } from "./sync/blobSync";
import { isMarkdownSyncable, isBlobSyncable } from "./types";
import { planCategoryRenameAction } from "./sync/policy/renameAdmissionPolicy";
import { classifySyncPath } from "./paths/pathCategory";
import { isCanonicalPathFileIdCollision } from "./paths/pathCollision";
import { sha256TextHex } from "./utils/sha256";
import { defaultDeviceName } from "./utils/defaultDeviceName";
import type { TraceSink } from "./observability/traceSink";
import type { FlightEventInput, FlightPathEventInput } from "./observability/flightEnvelope";
import { NoopTraceSink } from "./observability/noopTraceSink";
import { PRODUCT_EVENT_KIND } from "./observability/productEventKinds";
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
import { createSocketTicketCache } from "./sync/socketTicket";
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
import type {
	TraceEventDetails,
	TraceHttpContext,
} from "./observability/traceContext";
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
	ConnectionStateLatch,
	type ConnectionState,
} from "./runtime/connectionController";
import {
	buildRuntimeConfig,
	type RuntimeConfig,
} from "./runtime/runtimeConfig";
import {
	ReconciliationController,
} from "./runtime/reconciliationController";
import { getFatalSyncNotice } from "./runtime/fatalSyncNotice";
import { AttachmentOrchestrator } from "./runtime/attachmentOrchestrator";
import {
	RuntimeTeardownCoordinator,
	runTeardownStages,
} from "./runtime/teardownLifecycle";
import { EditorWorkspaceOrchestrator } from "./runtime/editorWorkspaceOrchestrator";
import {
	SetupLinkController,
	startEnrollmentRuntime,
	type EnrollmentMembership,
} from "./runtime/setupLinkController";
import { registerCommands } from "./commands";
import {
	getLabelFromConnectionState,
	renderConnectionState,
} from "./status/statusBarController";
import { CoalescedStatusRefresh } from "./status/coalescedStatusRefresh";
import { formatUnknown, yTextToString } from "./utils/format";
import { randomId } from "./utils/randomId";
import { ConfirmModal } from "./ui/ConfirmModal";
import { obsidianRequest } from "./utils/http";
import { runSchemaMigrationToV2 } from "./migrations/schemaV2";
import { installTelemetryRuntime, type TelemetryRuntimeHandle } from "./telemetry/installTelemetryRuntime";
import { setupFlightTraceBestEffort } from "./telemetry/debug/flightTraceController";
import type { SyncReadPort, TelemetryRuntimeHost } from "./telemetry/telemetryRuntimeHost";
import type { EngineControlPort, DiskIngestPort } from "./runtime/engineControlPort";
import type { BindingPropagationGate } from "./sync/editorBinding";

// Build-time constant injected by esbuild.
//   production build (main.js):          define __YAOS_QA_HARNESS_ENABLED__ = false
//   QA product build (product-main.js):  define __YAOS_QA_HARNESS_ENABLED__ = true
// When false, esbuild dead-code-eliminates all blocks gated on this constant.
// The declare tells TypeScript the type; the actual value comes from the esbuild define.
declare const __YAOS_QA_HARNESS_ENABLED__: boolean;

type PersistedPluginState = Partial<VaultSyncSettings> & {
	_diskIndex?: DiskIndex;
	_blobHashCache?: BlobHashCache;
	/**
	 * Unix ms timestamp of the last successful saveDiskIndex() call.
	 * Semantically: "the last time YAOS durably persisted its disk-index
	 * baselines to data.json." Used by decideClosedFileConflict to detect
	 * "disk file was edited while YAOS was inactive" when baselineHash is
	 * missing. This is a heuristic timestamp — it is the last save, not
	 * necessarily the last time YAOS observed the specific file.
	 * See: src/sync/closedFileConflict.ts ClosedFileConflictInput.lastDiskIndexPersistedAt
	 */
	_lastDiskIndexPersistedAt?: number;
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
	private reconciliationController!: ReconciliationController;
	private setupLinkController: SetupLinkController | null = null;
	private folderKey: string | null = null;
	private pendingReceiptGeneration: number | undefined;
	private vaultRoster: VaultRosterDevice[] = [];
	private rosterVaultId = "";
	/** Debug runtime handle — null unless debug mode installed it at startup. */
	private lab: TelemetryRuntimeHandle | null = null;

	// ---------------------------------------------------------------------------
	// QA harness state — only populated when __YAOS_QA_HARNESS_ENABLED__ is true.
	//
	// In production (main.js), esbuild defines __YAOS_QA_HARNESS_ENABLED__=false
	// and dead-code-eliminates every block gated on it.  This field itself is
	// declared here so TypeScript is satisfied; the constructor initialises it to
	// null (one innocent assignment), and every meaningful access lives inside a
	// gated block that disappears from main.js entirely.
	//
	// In the QA product build (product-main.js), __YAOS_QA_HARNESS_ENABLED__=true
	// and the full state object is constructed in onload() before the first
	// createReconciliationController() call.
	// ---------------------------------------------------------------------------
	private _qaState: {
		diskIngestPort: DiskIngestPort | null;
		externalEditPolicyOverride: import("./settings").ExternalEditPolicy | null;
		pausedEditorPropagationPaths: Set<string>;
		bindingReconfigureHook: ((path: string, deviceName: string, action: "pause" | "resume") => void) | null;
		controlPort: EngineControlPort;
		/** QA offline hold: when true, all reconnect paths are blocked. */
		offlineHold: boolean;
	} | null = null;

	// ---------------------------------------------------------------------------
	// QA control seams. Attached as instance properties inside the
	// __YAOS_QA_HARNESS_ENABLED__ block in onload(), so the names never reach
	// the class prototype and vanish from main.js along with that block —
	// guard-production-bundles.mjs bans both names in the shipped bundle.
	//
	// `declare` is what keeps that true while still giving the assignments and
	// the (QA-only) callers a checked type: an ambient field emits no property
	// definition at all, so nothing is added to the production output. They are
	// optional because production builds never assign them.
	// ---------------------------------------------------------------------------
	declare getEngineControlPort?: () => EngineControlPort;
	declare setQaNetworkHold?: (mode: "offline" | "online") => void;

	/** Domain-level trace sink. Routes to the debug runtime when active, noop otherwise. */
	private traceSink: TraceSink = new NoopTraceSink();
	private statusBarEl: HTMLElement | null = null;
	private statusInterval: number | null = null;
	private readonly receiptStatusRefresh = new CoalescedStatusRefresh(() => {
		if (!this.teardownLifecycle.isClosing) this.refreshStatusBar();
	});
	private readonly connectionStateLatch = new ConnectionStateLatch();

	/** Parsed exclude patterns from settings. */
	private excludePatterns: string[] = [];

	/** Max file size in characters (derived from settings KB). */
	private maxFileSize = 0;

	/** Persisted disk index: {path -> {mtime, size}}. */
	private diskIndex: DiskIndex = {};
	/**
	 * Unix ms timestamp of the last saveDiskIndex() that completed successfully.
	 * Semantics: "last time YAOS durably persisted disk-index state."
	 * This is a global (not per-file) heuristic timestamp used only as a
	 * tie-breaker in the missing-baseline closed-file conflict path.
	 * Naming: lastDiskIndexPersistedAt, not lastPluginActiveAt — these are
	 * not the same thing, and conflating them creates false certainty.
	 */
	private lastDiskIndexPersistedAt = 0;

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
	private readonly teardownLifecycle = new RuntimeTeardownCoordinator();

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
			getLastSaveDiskIndexAt: () => this.lastDiskIndexPersistedAt,
			trace: (source, msg, details) => this.trace(source, msg, details),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			log: (message) => this.log(message),
			recordFlightEvent: (event) => this.recordFlightEvent(event),
			recordFlightPathEvent: (event) => this.recordFlightPathEvent(event),
			getEffectiveExternalEditPolicy: (runtimePolicy) => {
				if (__YAOS_QA_HARNESS_ENABLED__) {
					const override = this._qaState?.externalEditPolicyOverride;
					if (override != null) return override;
				}
				return runtimePolicy;
			},
			registerDiskIngestPort: (port) => {
				if (__YAOS_QA_HARNESS_ENABLED__ && this._qaState) {
					this._qaState.diskIngestPort = port;
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

		// Initialize QA harness state before any component construction so that
		// registerDiskIngestPort (called from createReconciliationController) and
		// BindingPropagationGate hooks can store into _qaState.
		// In production this block is dead code — esbuild eliminates it entirely.
		if (__YAOS_QA_HARNESS_ENABLED__) {
			this._qaState = {
				diskIngestPort: null,
				externalEditPolicyOverride: null,
				pausedEditorPropagationPaths: new Set(),
				bindingReconfigureHook: null,
				offlineHold: false,
				controlPort: {
					ingestDiskFileNow: async (path, reason = "modify") => {
						if (!this._qaState?.diskIngestPort) throw new Error("DiskIngestPort not registered (reconciliation controller not started?)");
						await this._qaState.diskIngestPort.ingestDiskFileNow(path, reason);
					},
					pauseEditorPropagation: (path) => {
						if (!this._qaState) return false;
						if (this._qaState.pausedEditorPropagationPaths.has(path)) return false;
						this._qaState.pausedEditorPropagationPaths.add(path);
						this._qaState.bindingReconfigureHook?.(path, this.settings.deviceName, "pause");
						return true;
					},
					resumeEditorPropagation: (path) => {
						if (!this._qaState) return false;
						if (!this._qaState.pausedEditorPropagationPaths.has(path)) return false;
						this._qaState.pausedEditorPropagationPaths.delete(path);
						this._qaState.bindingReconfigureHook?.(path, this.settings.deviceName, "resume");
						return true;
					},
					setExternalEditPolicyOverride: (policy) => {
						if (!this._qaState) throw new Error("QA state not initialised");
						const previous = this._qaState.externalEditPolicyOverride ?? this.getRuntimeConfig().externalEditPolicy;
						this._qaState.externalEditPolicyOverride = policy;
						return previous;
					},
				},
			};
			// Attach the accessor as an instance property so the method name
			// never appears on the class prototype in production bundles.
			this.getEngineControlPort = (): EngineControlPort => {
				if (!this._qaState) throw new Error("QA harness state not initialised");
				return this._qaState.controlPort;
			};
			// QA offline hold: blocks all reconnect paths in ConnectionController.
			// The harness calls this as product.setQaNetworkHold("offline"|"online"),
			// which is absent (undefined) in production builds.
			this.setQaNetworkHold = (mode: "offline" | "online"): void => {
				if (!this._qaState) return;
				this._qaState.offlineHold = mode === "offline";
				const sync = this.vaultSync;
				if (!sync) return;
				if (mode === "offline") {
					sync.provider.disconnect();
					this.log("QA offline hold activated — provider disconnected, reconnects blocked");
				} else {
					this.log("QA offline hold released — reconnects permitted, connecting…");
					void sync.provider.connect().catch((e: unknown) =>
						this.log(`QA connectProvider error: ${String(e)}`),
					);
				}
			};
		}

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
					void this.teardownSync().catch((error: unknown) => {
						console.error("[yaos] Compatibility teardown completed with errors:", error);
					});
				}
			},
			setStatusError: () => this.updateStatusBar({ kind: "error" }),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			updateSettings: (mutator, reason) => this.updateSettings(mutator, reason),
		});
		await this.loadSettings();
		if (!this.settings.deviceName.trim()) {
			this.settings.deviceName = defaultDeviceName(Platform);
			await this.persistPluginState();
		}
		this.applyRuntimeSettings("load-settings");
		this.frontmatterGuardCoordinator = new FrontmatterGuardCoordinator({
			isFrontmatterGuardEnabled: () => this.settings.frontmatterGuardEnabled,
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
		this.setupLinkController = new SetupLinkController({
			app: this.app,
			getSettings: () => this.settings,
			isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
			requestEnrollment: (request) => obsidianRequest(request),
			updateSettings: (mutator, reason) => this.updateSettings(mutator, reason),
			refreshServerCapabilities: (reason) => this.refreshServerCapabilities(reason),
			retireCurrentEnrollment: (membership) => this.retireCurrentEnrollment(membership),
			startSyncAfterEnrollment: async () => {
				if (!this.teardownLifecycle.isClosing && this.vaultSync) {
					await this.teardownSync();
				}
				await startEnrollmentRuntime(
					this.teardownLifecycle,
					() => this.initSync(),
				);
			},
		});
		this.registerObsidianProtocolHandler("yaos", (params) => {
			void this.setupLinkController?.handleSetupLink(params);
		});


		// Install the debug/Observer runtime when debug or qaDebugMode is enabled.
		//
		// This runs on mobile too: the runtime has no Node dependency. Recording,
		// retention and export all go through app.vault.adapter, which exists on
		// every platform. settings.debug is the only gate, and it is off by default.
		if (this.settings.debug || this.settings.qaDebugMode) {
			const host: TelemetryRuntimeHost = {
					app: this.app,
					getSettings: () => this.settings,
					getSyncState: (): SyncReadPort | null => {
						const vs = this.vaultSync;
						if (!vs) return null;
						return {
							get connected() { return vs.connected; },
							get fatalAuthError() { return vs.fatalAuthError; },
							get fatalAuthCode() { return vs.fatalAuthCode; },
							get fatalAuthDetails() { return vs.fatalAuthDetails; },
							get localReady() { return vs.localReady; },
							get providerSynced() { return vs.providerSynced; },
							get isInitialized() { return vs.isInitialized; },
							get connectionGeneration() { return vs.connectionGeneration; },
							get lastLocalUpdateAt() { return vs.lastLocalUpdateAt; },
							get lastLocalUpdateWhileConnectedAt() { return vs.lastLocalUpdateWhileConnectedAt; },
							get lastRemoteUpdateAt() { return vs.lastRemoteUpdateAt; },
							get serverReceipt() { return vs.getServerReceiptSnapshot(); },
							get svEchoCounters() { return vs.svEchoCounters; },
							get idbError() { return vs.idbError; },
							get idbErrorDetails() { return vs.idbErrorDetails; },
							get supportedSchemaVersion() { return vs.supportedSchemaVersion; },
							get storedSchemaVersion() { return vs.storedSchemaVersion; },
							get blobPathCount() { return vs.pathToBlob.size; },
							getPathContent: (path: string) => {
								const ytext = vs.getTextForPath(path);
								return ytext ? ytext.toJSON() : null;
							},
							getFileIdForPath: (path: string) => {
								const ytext = vs.getTextForPath(path);
								return ytext ? vs.getFileIdForText(ytext) : undefined;
							},
							isPathTombstoned: (path: string) => vs.isPathTombstoned(path),
							getActiveMarkdownPaths: () => vs.getActiveMarkdownPaths(),
							getRecentEvents: (limit?: number) => vs.getRecentEvents(limit),
							getSafeReconcileMode: () => vs.getSafeReconcileMode(),
						};  // satisfies SyncReadPort — narrower union types on VaultSync are compatible
					},
					getTraceSink: () => this.traceSink,
					getDiskMirrorSnapshot: () => {
						const diskMirror = this.diskMirror;
						return diskMirror ? { activeObserverCount: diskMirror.activeObserverCount } : null;
					},
					getBlobSyncSnapshot: () => {
						const blobSync = this.getBlobSync();
						return blobSync
							? {
								pendingUploads: blobSync.pendingUploads,
								pendingDownloads: blobSync.pendingDownloads,
							}
							: null;
					},
					getEventRing: () => this.eventRing,
					getFrontmatterQuarantineEntries: () => this.frontmatterQuarantineEntries,
					getRuntimeDiagnosticsState: () => ({
						...this.reconciliationController.getState(),
						awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
						openFileCount: this.editorWorkspace?.openFileCount ?? 0,
					}),
					collectOpenFileTraceState: () => this.collectOpenFileTraceState(),
					getPluginVersion: () => this.manifest.version,
					getServerVersion: () => this.getUpdateState().serverVersion,
					isMarkdownPathSyncable: (path) => this.isMarkdownPathSyncable(path),
					log: (msg) => this.log(msg),
			};
			try {
				this.lab = await installTelemetryRuntime(host);
				this.traceSink = this.lab.traceSink;
			} catch (err) {
				// Construction threw — sync continues with NoopTraceSink. this.lab stays
				// null and every this.lab?.method() call is already optional-chained.
				console.error("[yaos] Debug runtime failed to start:", err);
			}
		}

		await this.setupFlightTrace();
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

		this.addSettingTab(new VaultSyncSettingTab(this.app, this, this));

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar({ kind: "disconnected" });

		const finishOnload = (outcome: string): void => {
			const durationMs = Date.now() - onloadStartedAt;
			this.trace("trace", "startup-onload-complete", {
				durationMs,
				outcome,
				hostConfigured: !!this.settings.host,
				deviceTokenConfigured: !!this.settings.deviceToken,
			});
			this.log(`Startup onload complete (${outcome}) in ${durationMs}ms`);
		};

		if (this.settings.host) {
			void this.refreshServerCapabilities("startup-background");
			void this.refreshUpdateManifest("startup-background");
		}

		if (
			!this.settings.host.trim()
			|| !this.settings.deviceToken.trim()
			|| !this.settings.vaultId.trim()
			|| !this.settings.deviceId.trim()
		) {
			this.log("This folder is not enrolled — sync disabled");
			new Notice("Join this folder with a server URL and pairing code.", 10000);
			finishOnload("not-enrolled");
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
						this.log("WARNING: connecting over unencrypted HTTP to a remote host — device credential sent in plaintext");
						new Notice(
							"Connecting over unencrypted HTTP. Your device credential will be sent in plaintext. Use HTTPS for production.",
							8000,
						);
					}
			} catch { /* invalid URL, will fail at connect */ }
		}

		void this.initSync().then(() => {
			if (!this.teardownLifecycle.isClosing) this.mountQaDebugApi();
		}).catch((error: unknown) => {
			console.error("[yaos] Startup sync continuation failed:", error);
		});
		finishOnload("sync-started");
	}

	private async initSync(reopenAfterTeardown = false): Promise<void> {
		if (reopenAfterTeardown && !this.teardownLifecycle.reopenAfterTeardown()) {
			this.log("initSync: lifecycle remains closed; skipping restart");
			return;
		}
		const generation = this.teardownLifecycle.beginInitialization();
		if (generation === null) {
			this.log("initSync: lifecycle is closing; skipping initialization");
			return;
		}
		this.connectionStateLatch.beginInitialization();

		const initSyncStartedAt = Date.now();
		const abortIfStale = (boundary: string): boolean => {
			if (this.teardownLifecycle.isInitializationCurrent(generation)) return false;
			this.log(`initSync: shutdown began before ${boundary}; abandoning stale continuation`);
			return true;
		};
		try {
			// Destruction durably snapshots or clears the active queue before any
			// replacement runtime can attach a new BlobSyncManager.
			await this.attachmentOrchestrator?.destroy();
			if (abortIfStale("attachment teardown")) return;
			this.trace("trace", "startup-init-sync-start", {
				hostConfigured: !!this.settings.host,
				deviceTokenConfigured: !!this.settings.deviceToken,
				hasCachedCapabilities: this.capabilityUpdateService?.hasCachedCapabilities ?? false,
			});

			this.idbDegradedHandled = false;
			this.applyRuntimeSettings("init-sync");
			if (this.enforceCompatibilityGuard("init-sync-preflight")) {
				return;
			}

			// 1. Create VaultSync (Y.Doc + folder-scoped IndexedDB + provider in parallel)
			const folderKey = await this.ensureFolderKey();
			const receiptGenerationHint = this.pendingReceiptGeneration;
			this.pendingReceiptGeneration = undefined;
			this.vaultSync = new VaultSync(this.settings, {
				folderKey,
				receiptGenerationHint,
				trace: (source, msg, details) => this.trace(source, msg, details),
				onFlightEvent: (event) => this.recordFlightEvent(event as FlightEventInput),
				onFlightPathEvent: (event) => this.recordFlightPathEvent(event),
				onServerReceiptStatusChanged: () => this.queueReceiptStatusRefresh(),
				getSocketTicket: (() => {
				// Each VaultSync instance gets its own ticket cache.  The cache
				// is discarded when VaultSync is torn down and recreated.
				const ticketCache = createSocketTicketCache();

				return async (force = false): Promise<{
					value: string;
					expiresAt: number;
					localExpiresAt: number;
					ttlMs: number;
				}> => {
					if (force) ticketCache.invalidate();
					try {
						return await ticketCache.get(
							this.settings.host,
							this.settings.deviceToken,
							this.settings.vaultId,
						);
					} catch (err) {
						this.log(`socket ticket fetch failed: ${String(err)}`);
						throw err;
					}
				};
			})(),
			});

			// 2. EditorBindingManager
			const bindingPropagationGate: BindingPropagationGate = {
				isPaused: (path) => {
					if (__YAOS_QA_HARNESS_ENABLED__ && this._qaState) {
						return this._qaState.pausedEditorPropagationPaths.has(path);
					}
					return false;
				},
				registerReconfigureHook: (fn) => {
					if (__YAOS_QA_HARNESS_ENABLED__ && this._qaState) {
						this._qaState.bindingReconfigureHook = fn;
					}
				},
			};
			this.editorBindings = new EditorBindingManager(
				this.vaultSync,
				this.app.workspace,
				this.settings.debug,
				(source, msg, details) => this.trace(source, msg, details),
				(event) => this.recordFlightPathEvent(event),
				bindingPropagationGate,
			);

			// 3. Global CM6 extension.
			//
			// registerEditorExtension applies to editors that already exist:
			// Obsidian calls Workspace.updateOptions() internally, which
			// reconfigures every live EditorView in place. Verified on Obsidian
			// 1.13.4 — registering from an async onload on a warm workspace
			// constructed our ViewPlugin on all 6 open editors. So no explicit
			// updateOptions() call is needed here.
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
			this.diskMirror.setFlightEventHandler((event) => this.recordFlightPathEvent(event as FlightPathEventInput));
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
				updateOfflineStatus: () => this.updateStatusBar({
					kind: "offline",
					reason: "network_offline",
					generation: this.vaultSync?.connectionGeneration ?? 0,
				}),
				refreshStatusBar: () => this.refreshStatusBar(),
				scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
				log: (message) => this.log(message),
				trace: (source, msg, details) => this.trace(source, msg, details),
				registerCleanup: (cleanup) => this.register(cleanup),
				...__YAOS_QA_HARNESS_ENABLED__ && this._qaState ? {
					isReconnectBlocked: () => this._qaState!.offlineHold,
				} : {},
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
			this.statusInterval = window.setInterval(() => {
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
				if (this.statusInterval) window.clearInterval(this.statusInterval);
				this.receiptStatusRefresh.cancel();
			});

			// 6. Vault events (gated by reconciliation state)
			this.registerVaultEvents();

			// 7. Commands
			if (!this.commandsRegistered) {
				registerCommands(this, {
					getVaultSync: () => this.vaultSync,
					getConnectionController: () => this.connectionController,
					getSnapshotService: () => this.snapshotService,
					getUntrackedFileCount: () => this.reconciliationController.untrackedFileCount,
					runReconciliation: (mode) => this.runReconciliation(mode),
					runSchemaMigrationToV2: () => this.runSchemaMigrationToV2(),
					importUntrackedFiles: () => this.importUntrackedFiles(),
					clearLocalServerReceiptState: () => this.clearLocalServerReceiptState(),
					resetLocalCache: () => this.resetLocalCache(),
					nuclearReset: () => this.nuclearReset(),
				});
				// Debug-runtime commands are registered separately by the debug runtime.
				this.lab?.registerCommands(this);
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

				// Defensive assertion: after rename admission policy (enforced at
				// queue time), applyRenameBatch should never contain an excluded
				// markdown destination. If one slips through, fail loudly in QA mode
				// and tombstone as a production fallback.
				for (const [, newPath] of renames) {
					if (!this.isMarkdownPathSyncable(newPath) && newPath.endsWith(".md")) {
						const msg = `[BUG] onRenameBatchFlushed: excluded markdown destination reached applyRenameBatch: "${newPath}"`;
						if (this.settings.qaDebugMode) {
							throw new Error(msg);
						}
						this.log(`${msg} — tombstoning as fallback`);
						this.traceSink.recordPath({
							kind: "rename.admission.invariant-failed",
							scope: "file",
							severity: "error",
							path: newPath,
							data: { bug: "excluded-destination-reached-applyRenameBatch" },
						});
						this.reconciliationController.dropDirtyPath(newPath);
						if (this.vaultSync?.getFileId(newPath)) {
							this.vaultSync.handleDelete(newPath);
						}
					}
				}
			});

			// -----------------------------------------------------------
			// STARTUP SEQUENCE
			// -----------------------------------------------------------

			this.updateStatusBar({ kind: "loading_cache" });
			this.log("Waiting for IndexedDB persistence...");
			const localLoaded = await this.vaultSync.waitForLocalPersistence();
			if (abortIfStale("local persistence")) return;
			this.log(`IndexedDB: ${localLoaded ? "loaded" : "timed out"}`);
			await this.vaultSync.initializeServerAckTracking(this.settings, this.manifest.version, {
				localYjsPersistenceLoaded: localLoaded,
			});
			if (abortIfStale("server acknowledgement initialization")) return;

			// Schema version check — refuse to run if a newer plugin wrote this data.
			// This is terminal for this attempt, so provider/status refreshes must
			// not replace it with a transient connected/offline state.
			const schemaError = this.vaultSync.checkSchemaVersion();
			if (schemaError) {
				console.error(`[yaos] ${schemaError}`);
				new Notice(`YAOS: ${schemaError}`);
				this.connectionStateLatch.failInitialization({
					phase: "schema",
					message: schemaError,
				});
				this.refreshStatusBar();
				return;
			}

			// Mark schema v3 if room is still at v2 (lazy, no metadata migration).
			this.vaultSync.markSchemaV3(this.settings.deviceName);

			// Check for fatal auth error before waiting for provider
			if (this.vaultSync.fatalAuthError) {
				this.log("Fatal auth error during startup");
				if (this.vaultSync.fatalAuthCode === "update_required") {
					this.updateStatusBar(this.getCurrentConnectionState());
					this.showFatalSyncNotice();
					return;
				}
				this.updateStatusBar(this.getCurrentConnectionState());
				this.showFatalSyncNotice();
				// Still reconcile with whatever we have locally
				const mode = this.vaultSync.getSafeReconcileMode();
				await this.runReconciliation(mode);
				if (abortIfStale("fatal-auth reconciliation")) return;
				return;
			}

			this.updateStatusBar({ kind: "connecting" });
			this.log("Waiting for provider sync...");
			const providerSynced = await this.vaultSync.waitForProviderSync();
			if (abortIfStale("provider synchronization")) return;
			if (providerSynced) {
				await this.vaultSync.finalizeServerAckTrackingAfterProviderSync();
				if (abortIfStale("server receipt generation finalization")) return;
			}
			this.log(`Provider: ${providerSynced ? "synced" : "timed out (offline)"}`);
			this.awaitingFirstProviderSyncAfterStartup = !providerSynced;
			this.log(
				`Startup sync gate: awaitingFirstProviderSyncAfterStartup=${this.awaitingFirstProviderSyncAfterStartup} ` +
				`(gen=${this.vaultSync.connectionGeneration})`,
			);

			if (this.vaultSync.fatalAuthError) {
				this.updateStatusBar(this.getCurrentConnectionState());
				this.showFatalSyncNotice();
				return;
			}

			const mode = this.vaultSync.getSafeReconcileMode();
			this.log(`Reconciliation mode: ${mode}`);

			await this.runReconciliation(mode);
			if (abortIfStale("startup reconciliation")) return;
			this.reconciliationController.lastGeneration = this.vaultSync.connectionGeneration;
			if (providerSynced) {
				this.awaitingFirstProviderSyncAfterStartup = false;
			}

			this.connectionStateLatch.recover();
			this.refreshStatusBar();
			this.trace("trace", "startup-init-sync-complete", {
				durationMs: Date.now() - initSyncStartedAt,
			});
			this.log("Startup complete");
			this.scheduleTraceStateSnapshot("startup-complete");
			this.attachmentOrchestrator?.markStartupReady("startup-complete");
			void this.lab?.refreshServerTrace();

			// Trigger daily snapshot (noop if already taken today).
			// Fire-and-forget — don't block startup on snapshot creation.
			if (providerSynced && this.serverSupportsSnapshots) {
				void this.snapshotService?.triggerDailySnapshot();
			}
		} catch (err) {
			console.error("[yaos] Failed to initialize sync:", err);
			new Notice(`YAOS: failed to initialize — ${formatUnknown(err)}`);
			if (!this.teardownLifecycle.isInitializationCurrent(generation)) {
				this.log("initSync: stale initialization failed after shutdown; ignoring terminal status");
				return;
			}
			this.connectionStateLatch.failInitialization({
				phase: "initialization",
				message: formatUnknown(err),
			});
			this.refreshStatusBar();
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
		return `op-${randomId(14)}`;
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
					// Writer attribution for the disk modify event.
					// suppressWindowActive: did YAOS issue a write whose
					// suppression entry is still live at this moment?
					// lastDiskWriteOkAtMs: monotonic ms timestamp of our
					// last successful flushWrite for this path (null if
					// YAOS has never written it this session).
					// writerGuess: a coarse classification combining both.
					// "yaos-write" is high-confidence; "external" is
					// "no suppression active and our last write was either
					// long ago or never"; "unknown" is the fallback when
					// the diskMirror is not yet wired (early-startup race).
						const dm = this.diskMirror;
					const suppressWindowActive = !!dm?.isSuppressed(file.path);
					const lastDiskWriteOkAtMs = dm?.getLastDiskWriteOkAt(file.path) ?? null;
					const dtSinceWrite = lastDiskWriteOkAtMs === null
						? null
						: Date.now() - lastDiskWriteOkAtMs;
					let writerGuess: "yaos-write" | "external" | "unknown";
					if (!dm) {
						writerGuess = "unknown";
					} else if (suppressWindowActive) {
						writerGuess = "yaos-write";
					} else if (dtSinceWrite !== null && dtSinceWrite < 500) {
						// Suppression entry may have expired between vault.modify
						// dispatch and our handler. If our last write was very
						// recent, attribute the modify to YAOS conservatively.
						writerGuess = "yaos-write";
					} else {
						writerGuess = "external";
					}
					this.traceSink.recordPath({
						kind: "disk.modify.observed",
						scope: "file",
						severity: "info",
						opId,
						path: file.path,
						data: {
							size: file.stat?.size ?? null,
							writerGuess,
							suppressWindowActive,
							lastDiskWriteOkAtMs,
							msSinceLastDiskWriteOk: dtSinceWrite,
						},
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

		// Rename: apply admission policy BEFORE queueing to ensure
		// applyRenameBatch never receives an excluded markdown destination.
		// Blob renames still go through the batch (blob exclusion is separate).
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.reconciliationController.isReconciled) return;
				if (!(file instanceof TFile)) return;

				// Classify both paths using canonical path identity.
				const configDir = this.getRuntimeConfig().vaultConfigDir;
				const oldCategory = classifySyncPath({ path: oldPath, excludePatterns: this.excludePatterns, configDir });
				const newCategory = classifySyncPath({ path: file.path, excludePatterns: this.excludePatterns, configDir });

				// Skip entirely if both are excluded.
				if (oldCategory.kind === "excluded" && newCategory.kind === "excluded") return;

				const renameOpId = this.newOpId();
				// DiskMirror marks a passive receiver's filesystem rename so it is
				// observed and traced without re-enqueuing an already-applied CRDT rename.
				const isRemoteRename = this.diskMirror?.consumeRemoteRename(file.path) ?? false;

				// Emit trace events for lineage via TraceSink (both sides).
				if (oldCategory.kind === "markdown" || newCategory.kind === "markdown") {
					this.traceSink.recordPath({
						kind: "rename.observed",
						scope: "file",
						severity: "info",
						opId: renameOpId,
						path: oldPath,
						data: { renameRole: "source", category: oldCategory.kind, opId: renameOpId },
					});
					this.traceSink.recordPath({
						kind: "rename.observed",
						scope: "file",
						severity: "info",
						opId: renameOpId,
						path: file.path,
						data: {
							renameRole: "target",
							category: newCategory.kind,
							opId: renameOpId,
							remoteOrigin: isRemoteRename,
						},
					});
				}

				if (isRemoteRename) {
					this.log(`Remote-origin rename observed, skipping CRDT rename: "${oldPath}" -> "${file.path}"`);
					return;
				}

				// Plan the action using the category-aware planner.
				const action = planCategoryRenameAction({ oldCategory, newCategory });

				// Execute the planned action.
				// All paths in actions are displayPath (original runtime paths).
				switch (action.kind) {
					case "queue-markdown-rename":
						this.vaultSync?.queueRename(action.oldPath, action.newPath);
						this.log(`Rename queued (markdown): "${oldPath}" -> "${file.path}"`);
						break;

					case "queue-blob-rename":
						this.vaultSync?.queueRename(action.oldPath, action.newPath);
						this.log(`Rename queued (blob): "${oldPath}" -> "${file.path}"`);
						break;

					case "tombstone-markdown":
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						this.vaultSync?.handleDelete(action.oldPath, this.settings.deviceName, renameOpId);
						this.log(`Rename admission: tombstoning markdown "${oldPath}"`);
						break;

					case "admit-markdown":
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						this.reconciliationController.markMarkdownDirty(file, "create", renameOpId);
						this.log(`Rename admission: admitting markdown "${file.path}"`);
						break;

					case "admit-blob-via-event":
						// Blob admission: Obsidian will fire a create event for the new
						// path, handled by blobSync.handleFileChange. No explicit action.
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						this.log(`Rename admission: blob "${file.path}" will be admitted via create event`);
						break;

					case "defer-blob-to-events":
						// Blob leaves sync scope. Obsidian delete event for old path
						// will be handled by blobSync. Just clean dirty state.
						for (const p of action.dropDirty) this.reconciliationController.dropDirtyPath(p);
						this.log(`Rename admission: blob "${oldPath}" leaving scope, deferred to events`);
						break;

					case "same-identity": {
						// NFC/NFD or separator variant rename. Same sync identity.
						// No CRDT mutation needed — not a real rename from sync perspective.
						this.log(`Rename admission: same identity (canonical equivalent): "${oldPath}" -> "${file.path}"`);

						// Diagnostic: if BOTH the old path AND new path already have distinct
						// CRDT entries, the vault has a pre-existing NFC/NFD collision.
						// That collision cannot be resolved via rename (this case no-ops it).
						// Emit a trace event so the state is visible in flight logs.
						// This does NOT resolve the collision — resolution is future work.
						if (this.vaultSync) {
							const vs = this.vaultSync;
							const oldFileId = vs.getFileId(oldPath);
							const newFileId = vs.getFileId(file.path);
							if (isCanonicalPathFileIdCollision({
								oldCanonicalKey: oldCategory.path.canonicalKey,
								newCanonicalKey: newCategory.path.canonicalKey,
								oldFileId,
								newFileId,
							})) {
								this.recordFlightPathEvent({
									priority: "important",
									kind: PRODUCT_EVENT_KIND.renameAdmissionCanonicalCollision,
									severity: "warn",
									scope: "file",
									source: "vaultEvents",
									layer: "policy",
									path: file.path,
									data: {
										oldPath,
										newPath: file.path,
										oldCanonicalKey: oldCategory.path.canonicalKey,
										newCanonicalKey: newCategory.path.canonicalKey,
										note: "Both NFC/NFD forms exist as separate CRDT entries. " +
											"Collision cannot be resolved via rename. " +
											"Delete one entry to resolve.",
									},
								});
								console.warn(
									`[yaos] Canonical collision detected: "${oldPath}" and "${file.path}" ` +
									`share a canonical key but both exist in CRDT. ` +
									`Same-identity rename is a no-op; collision unresolved.`,
								);
							}
						}
						break;
					}

					case "ignore":
						break;
				}
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
						this.traceSink.recordPath({
							kind: "disk.event.suppressed",
							scope: "file",
							severity: "debug",
							priority: "important",
							opId,
							path: file.path,
							data: {
								reason: "suppressed-remote-writeback",
								decision: "suppress",
							},
						});
						return;
					}
					this.traceSink.recordPath({
						kind: "disk.delete.observed",
						scope: "file",
						severity: "info",
						priority: "critical",
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
					this.traceSink.recordPath({
						kind: "disk.create.observed",
						scope: "file",
						severity: "info",
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
	//
	// There is deliberately no scheduled rebuild.  It ran on the status tick,
	// gated on being disconnected, to shed accumulated V8 rope.  A soak of a
	// live 12.5MB vault through Obsidian — full save path, real GC — reclaimed
	// 0.02 MiB of rope after 20,602 updates, because y-indexeddb's periodic
	// encodeStateAsUpdate trim already flattens the strings.  And on a
	// fragmented document a rebuild left struct count unchanged while making
	// heap 15% worse.  The rebuild is gone entirely rather than kept as a manual
	// command, because the case that would tempt someone into running it -- a
	// vault near the memory limit -- is the fragmented case, where it spikes
	// rather than saves.  See scripts/bench-interventions.mjs.

	// -------------------------------------------------------------------


	/**
	 * Begin one orderly runtime teardown. The returned promise remains shared by
	 * every concurrent disable/reset path until an intentional reset reopens the
	 * lifecycle, so resources cannot be double-destroyed.
	 */
	private teardownSync(): Promise<void> {
		return this.teardownLifecycle.beginTeardown(() => this.runTeardownSync());
	}

	private async runTeardownSync(): Promise<void> {
		this.log("teardownSync: tearing down all sync state");

		await runTeardownStages([
			// Safe baseline order: flush callbacks update memory, then persist the
			// resulting disk index before DiskMirror clears its write state.
			{
				name: "disk-pending-writes",
				run: () => this.diskMirror?.flushAllPendingWrites(),
			},
			{
				name: "disk-index-persistence",
				run: () => this.saveDiskIndex(),
			},
			{
				name: "editor-bindings",
				run: () => this.editorBindings?.unbindAll(),
			},
			{
				name: "disk-mirror",
				run: () => this.diskMirror?.destroy(),
			},
			{
				// Await terminal queue persist/clear before destroying its manager.
				name: "attachments",
				run: () => this.attachmentOrchestrator?.destroy(),
			},
			{
				name: "status-interval",
				run: () => {
					if (this.statusInterval) window.clearInterval(this.statusInterval);
					this.statusInterval = null;
					this.receiptStatusRefresh.cancel();
				},
			},
			{
				name: "reconciliation-controller",
				run: () => this.reconciliationController?.reset(),
			},
			{
				name: "connection-controller",
				run: () => this.connectionController?.stop(),
			},
			{
				name: "vault-sync",
				run: () => this.vaultSync?.destroy(),
			},
			{
				name: "runtime-references",
				run: () => {
					this.vaultSync = null;
					this.connectionController = null;
					this.editorBindings = null;
					this.diskMirror = null;
					this.awaitingFirstProviderSyncAfterStartup = false;
					this.editorWorkspace?.reset();
					this.idbDegradedHandled = false;
				},
			},
			{
				name: "status-ui",
				run: () => this.updateStatusBar({ kind: "disconnected" }),
			},
		], ({ stage, error }) => {
			const details = formatUnknown(error);
			console.error(`[yaos] teardown stage failed (${stage}):`, error);
			this.log(`teardown stage failed (${stage}): ${details}`);
			this.trace("trace", "teardown-stage-failed", { stage, error: details });
		});
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

				try {
					await this.teardownSync();
				} catch (err) {
					console.error("[yaos] Reset teardown completed with errors:", err);
					new Notice("Sync cleanup completed with errors; local cache was not reset.");
					return;
				}

				try {
					await VaultSync.deleteIdb(vaultId, await this.ensureFolderKey());
					this.log("Reset cache: IDB deleted");
				} catch (err) {
					console.error("[yaos] Failed to delete IDB:", err);
				}

				this.log("Reset cache: reinitializing");
				await this.initSync(true);
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
				this.pendingReceiptGeneration = this.vaultSync!.roomGeneration;
				this.log(
					`Nuclear reset: cleared ${counts.pathCount} paths, ` +
					`${counts.idCount} texts, ${counts.metaCount} meta, ` +
					`${counts.blobCount} blob paths, generation=${this.pendingReceiptGeneration}`,
				);

				await new Promise((r) => window.setTimeout(r, 500));

				const vaultId = this.settings.vaultId;
				try {
					await this.teardownSync();
				} catch (err) {
					console.error("[yaos] Reset teardown completed with errors:", err);
					new Notice("Sync cleanup completed with errors; local cache was not reset.");
					return;
				}

				try {
					await VaultSync.deleteIdb(vaultId, await this.ensureFolderKey());
					this.log("Nuclear reset: IDB deleted");
				} catch (err) {
					console.error("[yaos] Failed to delete IDB:", err);
				}

				this.log("Nuclear reset: reinitializing (will re-seed from disk)");
				await this.initSync(true);
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

	private getCurrentConnectionState(): ConnectionState {
		const liveState: ConnectionState = this.vaultSync?.idbError
			? {
				kind: "local_persistence_failed",
				details: this.vaultSync.idbErrorDetails,
			}
			: this.connectionController?.getState() ?? { kind: "disconnected" };
		return this.connectionStateLatch.resolve(liveState);
	}

	private refreshStatusBar(): void {
		const state = this.getCurrentConnectionState();
		if (state.kind === "local_persistence_failed") {
			this.handleIndexedDbDegraded("status-check");
		}
		this.updateStatusBar(state);
	}

	/**
	 * Batch receipt echoes delivered in the same provider turn into one redraw.
	 * The accepted-echo callback runs after ServerAckTracker updates its facts,
	 * so this always renders the current receipt state rather than stale data.
	 */
	private queueReceiptStatusRefresh(): void {
		this.receiptStatusRefresh.request();
	}

	getSettingsStatusSummary(): { label: string } {
		return {
			label: getLabelFromConnectionState(this.getCurrentConnectionState()).replace(/^YAOS:\s*/, ""),
		};
	}

	private updateStatusBar(connectionState: ConnectionState = this.getCurrentConnectionState()): void {
		if (!this.statusBarEl) return;
		const visibleState = this.connectionStateLatch.resolve(connectionState);
		const transferStatus = this.getBlobSync()?.transferStatus;
		const diskAttention =
			(this.diskMirror?.getDebugSnapshot().preservedUnresolved.totalCount ?? 0);
		const blobAttention =
			(this.getBlobSync()?.getDebugSnapshot().preservedUnresolved.totalCount ?? 0);
		const attentionCount = diskAttention + blobAttention;
		const serverReceipt = this.vaultSync?.getServerReceiptSnapshot() ?? null;
		this.noticeServerPersistenceHealth(serverReceipt?.serverPersistenceDegraded ?? false);
		renderConnectionState(this.statusBarEl, visibleState, transferStatus, serverReceipt, attentionCount);
	}

	/**
	 * Server durability is the one failure the user cannot otherwise see: the
	 * socket stays green, edits appear on other devices, and the writes are only
	 * missing after the room is evicted from memory.  The status bar carries the
	 * standing indicator; this fires once per transition so a persistent fault
	 * does not become wallpaper.
	 */
	private serverPersistenceDegradedNotified = false;

	private noticeServerPersistenceHealth(degraded: boolean): void {
		if (degraded === this.serverPersistenceDegradedNotified) return;
		this.serverPersistenceDegradedNotified = degraded;
		const notice = degraded
			? "YAOS: The server is not saving changes. Edits still sync between open devices, but anything made now may be lost. Avoid bulk edits or deletions until this clears."
			: "YAOS: The server is saving changes again.";
		new Notice(notice, degraded ? 15000 : 6000);
	}

	private async setupFlightTrace(): Promise<void> {
		await setupFlightTraceBestEffort(
			async () => {
				this.lab?.setupFlightTrace({
					getDocSchemaVersion: () => this.vaultSync?.storedSchemaVersion ?? null,
					buildCheckpoint: () => this.buildFlightCheckpoint(),
					isIndexedDbRelatedError: (error) => this.isIndexedDbRelatedError(error),
					isObsidianFileMetadataRaceError: (error) => this.isObsidianFileMetadataRaceError(error),
					handleIndexedDbDegraded: (source, error) => this.handleIndexedDbDegraded(source, error),
				});
				await this.refreshFlightTraceState("startup");
			},
			(error) => {
				console.error("[yaos] Debug flight trace failed to start:", error);
				this.log("Debug flight trace failed to start; product initialization is continuing");
			},
		);
	}

	private getTraceHttpContext(): TraceHttpContext | undefined {
		return this.lab?.getTraceHttpContext();
	}

	private trace(
		source: string,
		msg: string,
		details?: TraceEventDetails,
	): void {
		this.lab?.recordTrace(source, msg, details);
	}

	private recordFlightEvent(event: FlightEventInput): void {
		this.lab?.recordFlightEvent(event);
	}

	private recordFlightPathEvent(event: FlightPathEventInput): void {
		this.lab?.recordFlightPathEvent(event);
	}

	private scheduleTraceStateSnapshot(reason: string): void {
		this.lab?.scheduleTraceCheckpoint(reason);
	}


	private async buildFlightCheckpoint(): Promise<Record<string, unknown>> {
		const vaultSync = this.vaultSync;
		const blobSync = this.getBlobSync();
		return {
			connected: vaultSync?.connected ?? false,
			providerSynced: vaultSync?.providerSynced ?? false,
			serverReceipt: vaultSync?.getServerReceiptSnapshot().serverAppliedLocalState ?? null,
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
		await setupFlightTraceBestEffort(
			() => this.lab?.refreshFlightTraceState(reason) ?? Promise.resolve(),
			(error) => {
				console.error(`[yaos] Debug flight trace refresh failed (${reason}):`, error);
				this.log("Debug flight trace refresh failed; product runtime is continuing");
			},
		);
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
				leafId: binding?.leafId ?? view.leaf.id ?? path,
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
		return sha256TextHex(text);
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
		// Obsidian invokes unload synchronously. Set this gate before any cleanup
		// so a late init continuation cannot attach a replacement runtime.
		this.teardownLifecycle.requestPermanentShutdown();
		this.log("Unloading plugin");
		this.lab?.dispose();   // dispose stops the flight trace and QA API
		document.body.removeClass("vault-crdt-show-cursors");
		// Remove plugin-owned debug global to prevent stale API references
		// from confusing test harnesses after plugin reload.
		//
		// Reached reflectively on purpose: the global belongs to the QA harness
		// plugin (qa/, never shipped), which src/ may not import, so the product
		// has no type for its shape and must not declare one on Window — that
		// declaration lives in qa/types/yaos-window-globals.d.ts, where the
		// harness's own callers get the precise API type. `unknown` is the whole
		// truth available here, and truthiness is all this check needs.
		const staleDebugApi: unknown = Reflect.get(window, "__YAOS_DEBUG__");
		if (staleDebugApi) {
			Reflect.deleteProperty(window, "__YAOS_DEBUG__");
		}

		// This starts and retains the shared teardown promise, but synchronous
		// onunload is not an async completion barrier: a host shutdown/cold kill
		// can still end the process before pending durable writes settle.
		const teardown = this.teardownSync();
		void teardown.catch((error: unknown) => {
			console.error("[yaos] Teardown during unload completed with errors:", error);
			this.log(`Teardown during unload completed with errors: ${formatUnknown(error)}`);
		});
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
		// Load lastDiskIndexPersistedAt for missing-baseline conflict tie-breaking
		if (data && typeof data._lastDiskIndexPersistedAt === "number" && data._lastDiskIndexPersistedAt > 0) {
			this.lastDiskIndexPersistedAt = data._lastDiskIndexPersistedAt;
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
					typeof (entry).path === "string" &&
					((entry).kind === "markdown" ||
						(entry).kind === "blob") &&
					typeof (entry).reason === "string" &&
					typeof (entry).firstSeenAt === "number" &&
					typeof (entry).lastSeenAt === "number",
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


	get serverSupportsAttachments(): boolean {
		return this.capabilityUpdateService?.supportsAttachments ?? true;
	}

	get serverSupportsSnapshots(): boolean {
		return this.capabilityUpdateService?.supportsSnapshots ?? true;
	}

	get serverMaxBlobUploadBytes(): number | null {
		return this.capabilityUpdateService?.capabilities?.maxBlobUploadBytes ?? null;
	}

	async mintDevicePairing(): Promise<{ deepLink: string; mobileUrl: string } | null> {
		const host = this.settings.host.trim().replace(/\/$/, "");
		const deviceToken = this.settings.deviceToken.trim();
		const vaultId = this.settings.vaultId.trim();
		if (!host || !deviceToken || !vaultId || !this.settings.deviceId.trim()) return null;
		try {
			const res = await obsidianRequest({
				url: `${host}/vault/${encodeURIComponent(vaultId)}/auth/pairing-code`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${deviceToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ purpose: "device" }),
			});
			const body: unknown = res.json;
			const deepLink = body && typeof body === "object" && "obsidianUrl" in body && typeof body.obsidianUrl === "string"
				? body.obsidianUrl
				: "";
			const mobileUrl = body && typeof body === "object" && "mobileSetupUrl" in body && typeof body.mobileSetupUrl === "string"
				? body.mobileSetupUrl
				: "";
			const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
				? body.message
				: "";
			if (res.status !== 200 || !deepLink || !mobileUrl) {
				new Notice(message || "Could not mint a pairing code.", 7000);
				return null;
			}
			return { deepLink, mobileUrl };
		} catch (err) {
			new Notice(err instanceof Error ? err.message : "Could not mint a pairing code.", 7000);
			return null;
		}
	}

	async renameThisDevice(name: string): Promise<void> {
		const host = this.settings.host.trim().replace(/\/$/, "");
		const deviceToken = this.settings.deviceToken.trim();
		const vaultId = this.settings.vaultId.trim();
		if (!host || !deviceToken || !vaultId || !name) return;
		try {
			const res = await obsidianRequest({
				url: `${host}/vault/${encodeURIComponent(vaultId)}/auth/device`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${deviceToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ name }),
			});
			if (res.status === 200) return;
			const body: unknown = res.json;
			const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
				? body.message
				: "Could not rename this device.";
			new Notice(message, 7000);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : "Could not rename this device.", 7000);
		}
	}

	getFolderName(): string {
		return this.app.vault.getName();
	}

	async enrollByPaste(host: string, pairingCode: string): Promise<boolean> {
		return await this.setupLinkController?.enrollWithCode(host, pairingCode) ?? false;
	}

	private async retireCurrentEnrollment(membership: EnrollmentMembership): Promise<void> {
		if (
			membership.host &&
			membership.deviceToken &&
			membership.vaultId &&
			membership.deviceId
		) {
			try {
				const res = await obsidianRequest({
					url: `${membership.host}/vault/${encodeURIComponent(membership.vaultId)}/auth/device`,
					method: "DELETE",
					headers: { Authorization: `Bearer ${membership.deviceToken}` },
				});
				if (res.status !== 200 && res.status !== 401) {
					new Notice(
						"Could not remove the old server membership. Remove it from the old server console.",
						9000,
					);
				}
			} catch {
				new Notice(
					"Could not remove the old server membership. Remove it from the old server console.",
					9000,
				);
			}
		}

		await this.clearServerReceiptCandidate(membership);
		try {
			await this.teardownSync();
		} catch (err) {
			console.error("[yaos] Re-enrollment teardown completed with errors:", err);
		}
		if (membership.vaultId) {
			try {
				await VaultSync.deleteIdb(membership.vaultId, await this.ensureFolderKey());
			} catch (err) {
				console.error("[yaos] Failed to delete old enrollment IDB:", err);
			}
		}
	}

	private async clearServerReceiptCandidate(membership: EnrollmentMembership): Promise<void> {
		try {
			await this.vaultSync?.clearLocalServerReceiptState();
			if (membership.host && membership.vaultId && membership.deviceId) {
				await VaultSync.clearServerReceiptCandidate(
					membership.host,
					membership.vaultId,
					await this.ensureFolderKey(),
				);
			}
		} catch (err) {
			console.error("[yaos] Failed to clear server receipt candidate:", err);
		}
	}

	openServerConsole(): void {
		const host = this.settings.host.trim().replace(/\/$/, "");
		if (!host) {
			new Notice("Configure a server URL first.");
			return;
		}
		window.open(host, "_blank", "noopener");
	}

	getVaultRoster(): VaultRosterDevice[] {
		return this.vaultRoster;
	}

	isDeviceOnline(deviceId: string): boolean {
		if (!deviceId) return false;
		const awareness = this.vaultSync?.provider.awareness;
		if (!awareness) return false;
		for (const state of awareness.getStates().values() as IterableIterator<unknown>) {
			if (!state || typeof state !== "object" || !("user" in state)) continue;
			const user = state.user;
			if (user && typeof user === "object" && "id" in user && user.id === deviceId) return true;
		}
		return false;
	}

	async refreshVaultRoster(): Promise<void> {
		const host = this.settings.host.trim().replace(/\/$/, "");
		const deviceToken = this.settings.deviceToken.trim();
		const vaultId = this.settings.vaultId.trim();
		if (this.rosterVaultId !== vaultId) {
			this.vaultRoster = [];
			this.rosterVaultId = vaultId;
		}
		if (!host || !deviceToken || !vaultId) {
			this.vaultRoster = [];
			return;
		}
		try {
			const res = await obsidianRequest({
				url: `${host}/vault/${encodeURIComponent(vaultId)}/devices`,
				method: "GET",
				headers: { Authorization: `Bearer ${deviceToken}` },
			});
			if (this.settings.vaultId.trim() !== vaultId) return;
			if (res.status !== 200) {
				this.vaultRoster = [];
				new Notice("Could not load the device roster.", 7000);
				return;
			}
			const raw: unknown = res.json;
			if (!raw || typeof raw !== "object" || !("devices" in raw) || !Array.isArray(raw.devices)) {
				this.vaultRoster = [];
				return;
			}
			this.vaultRoster = raw.devices.flatMap((item: unknown): VaultRosterDevice[] => {
				if (!item || typeof item !== "object") return [];
				if (!("deviceId" in item) || typeof item.deviceId !== "string") return [];
				if (!("name" in item) || typeof item.name !== "string") return [];
				return [{
					deviceId: item.deviceId,
					name: item.name,
					enrolledAt: "enrolledAt" in item && typeof item.enrolledAt === "number" ? item.enrolledAt : undefined,
					lastSeenAt: "lastSeenAt" in item && typeof item.lastSeenAt === "number" ? item.lastSeenAt : undefined,
				}];
			});
		} catch (err) {
			if (this.settings.vaultId.trim() === vaultId) this.vaultRoster = [];
			new Notice(err instanceof Error ? err.message : "Could not load the device roster.", 7000);
		}
	}

	async leaveThisVault(): Promise<void> {
		new ConfirmModal(
			this.app,
			"Leave this vault",
			"This device stops syncing; notes stay on disk.",
			() => { void this.completeLeaveThisVault(); },
			"Leave",
		).open();
	}

	private async completeLeaveThisVault(): Promise<void> {
		const host = this.settings.host.trim().replace(/\/$/, "");
		const deviceToken = this.settings.deviceToken.trim();
		const vaultId = this.settings.vaultId.trim();
		const deviceId = this.settings.deviceId.trim();
		if (host && deviceToken && vaultId) {
			try {
				const res = await obsidianRequest({
					url: `${host}/vault/${encodeURIComponent(vaultId)}/auth/device`,
					method: "DELETE",
					headers: { Authorization: `Bearer ${deviceToken}` },
				});
				if (res.status !== 200 && res.status !== 401) {
					new Notice("Could not revoke this device on the server. Leaving locally.", 7000);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : "Could not revoke this device on the server.";
				new Notice(`${message} Leaving locally.`, 7000);
			}
		}

		await this.clearServerReceiptCandidate({
			host,
			deviceToken,
			vaultId,
			deviceId,
		});

		try {
			await this.teardownSync();
		} catch (err) {
			console.error("[yaos] Leave teardown completed with errors:", err);
		}
		if (vaultId) {
			try {
				await VaultSync.deleteIdb(vaultId, await this.ensureFolderKey());
			} catch (err) {
				console.error("[yaos] Failed to delete IDB on leave:", err);
			}
		}
		this.vaultRoster = [];
		this.rosterVaultId = "";
		await this.updateSettings((settings) => {
			settings.host = "";
			settings.deviceToken = "";
			settings.vaultId = "";
			settings.deviceId = "";
		}, "leave-vault");
		new Notice("Left this vault. Notes are still on disk.", 7000);
	}

	private async ensureFolderKey(): Promise<string> {
		if (this.folderKey) return this.folderKey;
		this.folderKey = await computeFolderKey(folderKeySeedFromVault(this.app.vault));
		return this.folderKey;
	}

	buildDeviceCredentialsText(): string | null {
		const host = this.settings.host.trim().replace(/\/$/, "");
		const deviceToken = this.settings.deviceToken.trim();
		const vaultId = this.settings.vaultId.trim();
		const deviceId = this.settings.deviceId.trim();
		if (!host || !deviceToken || !vaultId || !deviceId) return null;
		return [
			"YAOS Device Credentials",
			`Host: ${host}`,
			`Vault ID: ${vaultId}`,
			`Device ID: ${deviceId}`,
			`Device token: ${deviceToken}`,
		].join("\n");
	}

	async refreshAttachmentSyncRuntime(reason = "settings-change"): Promise<void> {
		if (this.teardownLifecycle.isClosing) return;
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
			updateProvider: "unknown",
			pluginUpdateRecommended: false,
			updateRepoUrl: null,
			updateActionUrl: null,
			updateBootstrapUrl: null,
			updateActionLabel: "YAOS settings",
			pluginCompatibilityWarning: null,
		};
	}

	buildServerUpdateUrl(): string | null {
		return this.capabilityUpdateService?.buildServerUpdateUrl() ?? null;
	}

	buildGithubUpdaterBootstrapUrl(): string | null {
		return this.capabilityUpdateService?.buildGithubUpdaterBootstrapUrl() ?? null;
	}


	private showFatalSyncNotice(): void {
		const notice = getFatalSyncNotice(
			this.vaultSync?.fatalAuthCode ?? null,
			this.vaultSync?.fatalAuthDetails ?? null,
		);
		new Notice(notice.message, notice.timeout);
	}

	private async saveDiskIndex(): Promise<void> {
		const persistedAt = Date.now();
		await this.persistPluginState((state) => {
			state._lastDiskIndexPersistedAt = persistedAt;
		});
		this.lastDiskIndexPersistedAt = persistedAt;
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
			...(this.lastDiskIndexPersistedAt > 0 && { _lastDiskIndexPersistedAt: this.lastDiskIndexPersistedAt }),
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


	private runSchemaMigrationToV2(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized.");
			return;
		}
		runSchemaMigrationToV2({
			app: this.app,
			vaultSync: this.vaultSync,
			settings: this.settings,
			log: (msg) => this.log(msg),
			runReconciliation: async () => {
				const mode = this.vaultSync?.getSafeReconcileMode();
				if (!mode) return;
				await this.runReconciliation(mode);
			},
		});
	}

	// -------------------------------------------------------------------
	// QA debug API surface
	// -------------------------------------------------------------------

	private mountQaDebugApi(): void {
		if (!this.settings.qaDebugMode) return;
		// window.__YAOS_DEBUG__ is the Puppeteer harness API.
		// It is NOT part of the product debug runtime shipped in main.js.
		// The QA harness plugin (qa/obsidian-harness/main.ts) mounts it when
		// installed alongside this plugin for QA scenarios.
		// In this product build, no mutation API is available — log explicitly
		// so developers know what happened instead of silently finding no API.
		this.log("qaDebugMode enabled, but window.__YAOS_DEBUG__ is not mounted by this build. Install the QA harness plugin (qa/obsidian-harness/main.ts) to get the QA debug API.");
		new Notice("Yaos: Debug mode active — debug API unavailable in this build.", 8000);
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
