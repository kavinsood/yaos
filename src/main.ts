import { MarkdownView, Notice, Platform, Plugin, TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VaultSyncSettingTab,
	type VaultRosterDevice,
	type VaultSecurityAuditEvent,
	type VaultSyncSettings,
} from "./settings";
import { SettingsStore } from "./settings/settingsStore";
import { VaultSync, type ReconcileMode } from "./sync/vaultSync";
import { SCHEMA_VERSION } from "./sync/schema";
import { computeFolderKey, folderKeySeedFromVault } from "./sync/vaultPersistence";
import { EditorBindingManager } from "./sync/editorBinding";
import { DiskMirror } from "./sync/diskMirror";
import { VaultIndexedDb } from "./sync/vaultIndexedDb";
import {
	BootstrapClient,
	BootstrapHttpPort,
	prepareBootstrapRoot,
	type BootstrapProgressEvent,
} from "./sync/bootstrapClient";
import {
	LocalVaultImporter,
	summarizeLocalVaultImport,
	type LocalVaultImportSummary,
} from "./onboarding/localVaultImport";
import { IndexedDbLocalVaultImportStateStore } from "./onboarding/localVaultImportStore";
import {
	FreshBodyAdmissionLocalVaultImportSink,
	ObsidianLocalVaultImportSource,
} from "./onboarding/obsidianLocalVaultImport";
import {
	fetchVaultProvisioningProof,
	type VaultProvisioningProof,
} from "./onboarding/provisioningClient";
import { SettingsSyncEngine } from "./sync/settingsSync/engine";
import {
	emptySettingsSyncStatus,
	SETTINGS_SYNC_FORMAT_VERSION,
	type SettingsSyncStatus,
} from "./sync/settingsSync/types";
import {
	confirmAndSmokeInstallCalendar,
	noticeForInstallResult,
} from "./sync/settingsSync/obsidianPluginInstall";
import { type BlobQueueSnapshot, type BlobSyncManager } from "./sync/blobSync";
import { isMarkdownSyncable, isBlobSyncable, isCanvasSyncable } from "./types";
import { ObsidianCanvasDiskMirror } from "./sync/canvas/canvasDiskMirror";
import { CanvasProjectionRouter } from "./sync/canvas/canvasProjectionRouter";
import { planCategoryRenameAction } from "./sync/policy/renameAdmissionPolicy";
import { classifySyncPath } from "./paths/pathCategory";
import { isCanonicalPathFileIdCollision } from "./paths/pathCollision";
import {
	canonicalMarkdownBytes,
	canonicalMarkdownHash,
	canonicalizeMarkdown,
} from "@shared/markdownCodec";
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
	type FrontmatterQuarantineEvidence,
} from "./sync/frontmatterQuarantine";
import {
	FrontmatterGuardCoordinator,
} from "./sync/frontmatterGuardCoordinator";
import { createSocketTicketCache } from "./sync/socketTicket";
import { BodySettlementRepository } from "./sync/bodySettlement";
import { reviewThreeWayConflict } from "./ui/ThreeWayConflictModal";
import {
	type DiskIndex,
	currentContentHash,
	moveIndexEntries,
	readDiskIndex,
	setCurrentContentHash,
	setPartialContentHashes,
	waitForDiskQuiet,
} from "./sync/diskIndex";
import {
	type BlobHashCache,
	moveCachedHashes,
} from "./sync/blobHashCache";
import type { PreservedUnresolvedEntry } from "./sync/preservedUnresolved";
import { SnapshotService } from "./snapshots/snapshotService";
import {
	EMPTY_PENDING_RECOVERY_STATE,
	getRecoveryReadiness,
	parsePendingRecoveryState,
	type PendingRecoveryState,
} from "./snapshots/recoveryState";
import {
	createRecoveryRuntimePort,
	type RecoveryRuntimePort,
} from "./snapshots/recoveryClient";
import { VaultExportService } from "./snapshots/vaultExport";
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
import { createMarkdownConflictArtifact } from "./runtime/reconcile/markdownConflictArtifact";
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
import { installTelemetryRuntime, type TelemetryRuntimeHandle } from "./telemetry/installTelemetryRuntime";
import { setupFlightTraceBestEffort } from "./telemetry/debug/flightTraceController";
import type { SyncReadPort, TelemetryRuntimeHost } from "./telemetry/telemetryRuntimeHost";
import type { EngineControlPort, DiskIngestPort } from "./runtime/engineControlPort";
import type { BindingPropagationGate } from "./sync/editorBinding";
import { leafIdentity } from "./host/obsidianHostAdapter";
import {
	YaosPublicApiService,
	type YaosPublicApi,
	type YaosPublicSettlementSummary,
	type YaosPublicSnapshotInput,
} from "./publicApi";
import {
	OperationalResourceSnapshotTracker,
	type OperationalResourceSnapshot,
} from "./runtime/operationalResourceSnapshot";
import { AuthorityCoordinator, readVaultAuthoritySnapshot } from "./collaboration/authority";
import {
	CollaborationClient,
	type CollaborationOwnershipTransfer,
	type SecurityAuditEvent,
} from "./collaboration/client";

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
	_provisioningProof?: VaultProvisioningProof;
	_authoritySupersededWork?: AuthoritySupersededWork[];
};

interface AuthoritySupersededWork {
	kind: "candidate" | "lifecycle" | "attachment";
	identity: string;
	principalId: string | null;
	membershipRevision: number | null;
	deviceId: string | null;
	deviceCredentialRevision: number | null;
	preservedAt: number;
}

export default class VaultCrdtSyncPlugin extends Plugin {
	/** Data-only API for other plugins; consumers reacquire it after `yaos:api-ready`. */
	api: YaosPublicApi | null = null;
	settings: VaultSyncSettings = DEFAULT_SETTINGS;
	private readonly settingsStore = new SettingsStore<PersistedPluginState>({
		loadData: () => this.loadData(),
		saveData: (data) => this.saveData(data),
	});
	private runtimeConfig: RuntimeConfig | null = null;

	private vaultSync: VaultSync | null = null;
	private vaultDatabase: VaultIndexedDb | null = null;
	private bootstrapClient: BootstrapClient | null = null;
	private bootstrapProgress: BootstrapProgressEvent | null = null;
	private bootstrapCatchUp: Promise<void> | null = null;
	private initialVaultImporter: LocalVaultImporter | null = null;
	private initialImportSummary: LocalVaultImportSummary | null = null;
	private bootstrapCatchUpPending = false;
	private attachmentReconciliationPending = false;
	private connectionController: ConnectionController | null = null;
	private editorBindings: EditorBindingManager | null = null;
	private diskMirror: DiskMirror | null = null;
	private canvasProjection: CanvasProjectionRouter | null = null;
	private attachmentOrchestrator: AttachmentOrchestrator | null = null;
	private editorWorkspace: EditorWorkspaceOrchestrator | null = null;
	private snapshotService: SnapshotService | null = null;
	private settingsSyncEngine: SettingsSyncEngine | null = null;
	private settingsSyncStatus: SettingsSyncStatus = emptySettingsSyncStatus();
	private settingsSyncTab: VaultSyncSettingTab | null = null;
	private settingsSyncLifecycleTail: Promise<void> = Promise.resolve();
	private settingsSyncSeedNoticeIdentity: string | null = null;
	private settingsSyncCapabilityActive = false;
	private pendingRecoveryState: PendingRecoveryState = { ...EMPTY_PENDING_RECOVERY_STATE };
	private reconciliationController!: ReconciliationController;
	private setupLinkController: SetupLinkController | null = null;
	private folderKey: string | null = null;
	private vaultRoster: VaultRosterDevice[] = [];
	private readonly vaultDevicesByPrincipal = new Map<string, readonly VaultRosterDevice[]>();
	private securityAudit: readonly SecurityAuditEvent[] = [];
	private rosterVaultId = "";
	private readonly authorityCoordinator = new AuthorityCoordinator();
	private authoritySupersededWork: AuthoritySupersededWork[] = [];
	private ownershipTransfers: readonly CollaborationOwnershipTransfer[] = [];
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
	private readonly operationalResources = new OperationalResourceSnapshotTracker();

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
	private bodySettlementRepository: BodySettlementRepository | null = null;
	private publicApiService: YaosPublicApiService | null = null;
	private readonly publicSettlementSummaries = new Map<string, YaosPublicSettlementSummary>();
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
		return !this.vaultSync?.canvases?.isSemanticPath(path)
			&& isBlobSyncable(path, this.excludePatterns, this.getRuntimeConfig().vaultConfigDir);
	}

	private isCanvasPathSyncable(path: string): boolean {
		return isCanvasSyncable(path, this.excludePatterns, this.getRuntimeConfig().vaultConfigDir);
	}

	private async promoteActiveCanvas(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const runtime = this.vaultSync;
		if (!file || !this.isCanvasPathSyncable(file.path) || !runtime?.canvases) throw new Error("Open a synchronized Canvas first");
		if (runtime.canvases.isSemanticPath(file.path)) throw new Error("This Canvas already uses semantic sync");
		const ref = runtime.getAttachmentRef(file.path);
		if (!ref) throw new Error("The attachment must finish syncing before promotion");
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		await runtime.canvases.promote(file.path, bytes, ref);
		new Notice("Canvas promoted to semantic sync");
		this.queueReceiptStatusRefresh();
	}

	private async demoteActiveCanvas(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const runtime = this.vaultSync;
		if (!file || !this.isCanvasPathSyncable(file.path) || !runtime?.canvases?.isSemanticPath(file.path)) {
			throw new Error("Open a semantic Canvas first");
		}
		await runtime.canvases.demote(file.path);
		new Notice("Canvas returned to attachment sync");
		this.queueReceiptStatusRefresh();
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

	private getRecoveryRuntime(): RecoveryRuntimePort | null {
		const runtime = this.vaultSync;
		const diskMirror = this.diskMirror;
		if (!runtime || !diskMirror) return null;
		return createRecoveryRuntimePort({
			runtime,
			getLive: (path) => runtime.getRecoveryLive(path),
			settleDisk: async (input) => {
				const outcome = await diskMirror.settleBody({
					path: input.path,
					bodyId: input.bodyId,
					generation: input.generation,
					content: input.content,
				});
				if (outcome !== "settled") {
					throw new Error(`recovery disk settlement preserved unresolved target: ${input.path}`);
				}
				const file = this.app.vault.getAbstractFileByPath(input.path);
				if (!(file instanceof TFile)) {
					throw new Error(`recovery disk settlement did not materialize target: ${input.path}`);
				}
				const content = canonicalizeMarkdown(await this.app.vault.read(file));
				return {
					contentHash: await canonicalMarkdownHash(content),
					size: canonicalMarkdownBytes(content).byteLength,
				};
			},
		});
	}

	async onload() {
		const onloadStartedAt = Date.now();
		this.installPublicApi();

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
					void Promise.resolve(this.connectionController?.reconnect("qa-network-hold-online")).catch((e: unknown) =>
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
			getFrontmatterQuarantineEvidence: (path) => this.getFrontmatterQuarantineEvidence(path),
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
			getRecoveryRuntime: () => this.getRecoveryRuntime(),
			getAttachmentCatalog: () => this.vaultSync,
			getBlobSync: () => this.getBlobSync(),
			getPendingRecoveryState: () => this.pendingRecoveryState,
			persistPendingRecoveryState: async (state) => {
				const database = this.vaultDatabase;
				if (!database) throw new Error("folder-scoped recovery persistence is unavailable");
				await database.putRecoveryState(state);
				this.pendingRecoveryState = state;
				this.refreshStatusBar();
			},
			getServerSupportsSnapshots: () => this.serverSupportsSnapshots,
			log: (message) => this.log(message),
			onEditorsNeedReconcile: (reason) => this.editorWorkspace?.onReconciled(reason),
			recordFlightEvent: (event) => this.recordFlightEvent(event),
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
							get websocketOpen() { return vs.websocketOpen; },
							get applicationResponsive() { return vs.applicationResponsive; },
							get lastLivenessAckAt() { return vs.lastLivenessAckAt; },
							get fatalAuthError() { return vs.fatalAuthError; },
							get fatalAuthCode() { return vs.fatalAuthCode; },
							get fatalAuthDetails() { return vs.fatalAuthDetails; },
							get localReady() { return vs.localReady; },
							get providerSynced() { return vs.providerSynced; },
							get isInitialized() { return vs.isInitialized; },
							get connectionGeneration() { return vs.connectionGeneration; },
							get pendingAttachmentOperations() { return vs.pendingAttachmentOperations; },
							get fatalAttachmentPublications() { return vs.fatalAttachmentPublications; },
							getSocketLivenessSnapshot: () => vs.getSocketLivenessSnapshot(),
							get lastLocalUpdateAt() { return vs.lastLocalUpdateAt; },
							get lastLocalUpdateWhileConnectedAt() { return vs.lastLocalUpdateWhileConnectedAt; },
							get lastRemoteUpdateAt() { return vs.lastRemoteUpdateAt; },
							get serverReceipt() { return vs.getServerReceiptSnapshot(); },
							get idbError() { return vs.idbError; },
							get idbErrorDetails() { return vs.idbErrorDetails; },
							get supportedSchemaVersion() { return vs.supportedSchemaVersion; },
							get storedSchemaVersion() { return vs.storedSchemaVersion; },
							get blobPathCount() { return vs.pathToBlob.size; },
							getPathContent: (path: string) => {
								const ytext = vs.getTextForPath(path);
								return ytext ? ytext.toJSON() : null;
							},
							getFileIdForPath: (path: string) => vs.getFileId(path),
							isPathTombstoned: (path: string) => vs.isMarkdownTombstoned(path),
							getActiveMarkdownPaths: () => vs.getActiveMarkdownPaths(),
							getRecentEvents: (limit?: number) => vs.getRecentEvents(limit),
							getSafeReconcileMode: () => vs.getSafeReconcileMode(),
							getBodyResidencySnapshot: () => vs.getBodyResidencySnapshot(),
							getResidencyAdmissionSnapshot: () => vs.getResidencyAdmissionSnapshot(),
							getOverdueWorkDiagnostics: () => vs.getOverdueWorkDiagnostics(),
							getOperationalResourceSnapshot: () => this.getOperationalResourceSnapshot(),
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
								permanentUploadFailures: blobSync.getDebugSnapshot().permanentUploadFailures,
								permanentDownloadFailures: blobSync.getDebugSnapshot().permanentDownloadFailures,
							}
							: null;
					},
					getEventRing: () => this.eventRing,
					getFrontmatterQuarantineEntries: () => this.frontmatterQuarantineEntries,
					getRuntimeDiagnosticsState: () => ({
						...this.reconciliationController.getState(),
						attachmentReconciliationPending: this.attachmentReconciliationPending,
						awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
						openFileCount: this.editorWorkspace?.openFileCount ?? 0,
						recovery: {
							readiness: getRecoveryReadiness(this.pendingRecoveryState),
							storageAvailable: this.pendingRecoveryState.lastRecoveryStatus?.storageAvailable ?? null,
							projectionState: this.pendingRecoveryState.lastRecoveryStatus?.projectionState ?? null,
							projectionLag: this.pendingRecoveryState.lastRecoveryStatus?.projectionLag ?? null,
							activeCaptureId: this.pendingRecoveryState.activeCaptureId,
							captureState: this.pendingRecoveryState.lastCaptureStatus?.state ?? null,
							activeRestoreId: this.pendingRecoveryState.activeRestore?.restoreId ?? null,
							restoreState: this.pendingRecoveryState.lastRestoreStatus?.state ?? null,
						},
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
			getBlobQueueScope: () => ({
				host: this.settings.host.trim().replace(/\/$/, ""),
				vaultId: this.settings.vaultId.trim(),
				vaultGeneration: this.settings.vaultGeneration.trim(),
				deviceId: this.settings.deviceId.trim(),
				folderKey: this.folderKey ?? "",
			}),
			getExcludePatterns: () => this.excludePatterns,
			persistBlobQueue: (snapshot) => this.persistBlobQueueSnapshot(snapshot),
			clearPersistedBlobQueue: () => this.clearSavedBlobQueue(),
			getPreservedUnresolvedEntries: () => this.preservedUnresolvedEntries,
			onPreservedUnresolvedChanged: () => this.persistPreservedUnresolvedState(),
			trace: (source, msg, details) => this.trace(source, msg, details),
			recordFlightPathEvent: (event) => this.recordFlightPathEvent(event as FlightPathEventInput),
			scheduleTraceStateSnapshot: (reason) => this.scheduleTraceStateSnapshot(reason),
			refreshStatusBar: () => this.refreshStatusBar(),
			log: (message) => this.log(message),
		});
		this.attachmentOrchestrator.hydrateSavedQueue(this.savedBlobQueue);
		this.savedBlobQueue = null;

		this.settingsSyncTab = new VaultSyncSettingTab(this.app, this, this);
		this.addSettingTab(this.settingsSyncTab);

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
			|| !this.settings.vaultGeneration.trim()
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
			await this.refreshCollaborationAuthority("init-sync");
			if (abortIfStale("collaboration authority")) return;

			// Schema 7 always starts from a fresh vault-generation+folder database. The
			// bootstrap root is validated before the live root provider opens.
			const folderKey = await this.ensureFolderKey();
			const importer = new LocalVaultImporter(
				new ObsidianLocalVaultImportSource(this.app),
				new FreshBodyAdmissionLocalVaultImportSink(
					() => this.vaultSync,
					(_paths, work) => work(),
				),
				new IndexedDbLocalVaultImportStateStore(this.settings.vaultId, folderKey),
				{
					vaultId: this.settings.vaultId,
					maxFileSizeBytes: this.getRuntimeConfig().maxFileSizeBytes,
					excludePatterns: this.excludePatterns,
					configDir: this.app.vault.configDir,
					onProgress: (summary) => {
						this.initialImportSummary = summary;
					},
				},
			);
			this.initialVaultImporter = importer;
			await importer.capture();
			const provisioning = await fetchVaultProvisioningProof({
				host: this.settings.host,
				deviceToken: this.settings.deviceToken,
				vaultId: this.settings.vaultId,
			});
			if (provisioning.vaultGeneration !== this.settings.vaultGeneration) {
				throw new Error("enrollment vault generation does not match the active server vault");
			}
			if (abortIfStale("vault provisioning proof")) return;
			await this.persistPluginState((state) => {
				state._provisioningProof = provisioning;
			});
			await this.installSettingsSyncEngine(folderKey, provisioning);
			if (abortIfStale("settings sync initialization")) return;
			const database = new VaultIndexedDb(
				this.settings.vaultId,
				this.settings.vaultGeneration,
				folderKey,
			);
			this.vaultDatabase = database;
			this.pendingRecoveryState = parsePendingRecoveryState(await database.getRecoveryState());
			const bootstrapServer = new BootstrapHttpPort(
				this.settings.host,
				this.settings.vaultId,
				this.settings.deviceToken,
				database,
				async (request) => {
					const response = await obsidianRequest({
						url: request.url,
						method: request.method,
						headers: request.headers,
						...(request.contentType ? { contentType: request.contentType } : {}),
						...(request.body !== undefined ? { body: request.body } : {}),
					});
					const responseContentType = response.headers["content-type"]
						?? response.headers["Content-Type"]
						?? "";
					return {
						status: response.status,
						headers: response.headers,
						arrayBuffer: response.arrayBuffer,
						...(responseContentType.includes("application/json") ? { json: response.json } : {}),
					};
				},
			);
			await prepareBootstrapRoot(bootstrapServer, database);
			const ticketCache = createSocketTicketCache();
			const canvasProjection = new CanvasProjectionRouter(new ObsidianCanvasDiskMirror(this.app));
			this.canvasProjection = canvasProjection;
			const runtime = await VaultSync.create({
				vaultId: this.settings.vaultId,
				vaultGeneration: this.settings.vaultGeneration,
				deviceId: this.settings.deviceId,
				getAuthority: () => this.authorityCoordinator.capture(),
				onAuthoritySuperseded: (kind, identity, authority) => {
					if (this.authoritySupersededWork.some((item) => item.kind === kind && item.identity === identity)) return;
					this.authoritySupersededWork.push({
						kind,
						identity,
						principalId: authority?.principalId ?? null,
						membershipRevision: authority?.membershipRevision ?? null,
						deviceId: authority?.deviceId ?? null,
						deviceCredentialRevision: authority?.deviceCredentialRevision ?? null,
						preservedAt: Date.now(),
					});
					void this.persistPluginState();
					this.refreshStatusBar();
				},
				host: this.settings.host,
				token: this.settings.deviceToken,
				database,
				canvasProjection,
				getSocketTicket: async (scope, force = false) => {
					if (force) ticketCache.invalidate();
					return ticketCache.get(
						this.settings.host,
						this.settings.deviceToken,
						this.settings.vaultId,
						scope,
					);
				},
				log: (message) => this.log(`[sync] ${message}`),
				onRemoteRootStructuralUpdate: () => this.scheduleSchema4CatchUp("remote-root"),
				onAttachmentReconciliationRequired: () => {
					this.attachmentReconciliationPending = true;
					this.reconciliationController.markPending();
					this.scheduleSchema4CatchUp("attachment-revision-mismatch");
				},
				onDurableBodyCommitted: () => this.scheduleSchema4CatchUp("body-committed"),
				onProductEvent: (event) => this.recordFlightPathEvent(event),
				onControlFrame: () => this.queueReceiptStatusRefresh(),
				onSemanticEpochReset: ({ purpose, documentId }) => {
					// Detach first: validation/rebinding is allowed to fail or retry, but
					// no editor may remain connected to the Y.Doc retired by the reset.
					if (purpose === "body") this.editorBindings?.unbindByFileId(documentId);
					else this.editorBindings?.unbindAll();
					this.editorWorkspace?.validateOpenBindings(`semantic-epoch-reset:${purpose}:${documentId}`);
					this.scheduleSchema4CatchUp(`semantic-epoch-reset:${purpose}`);
				},
				onSemanticEpochRebaseConflict: async ({ path, pendingMarkdown, kind }) => {
					const conflictPath = await createMarkdownConflictArtifact(this.app, path, pendingMarkdown, {
						deviceName: this.settings.deviceName,
						reason: `semantic-epoch-${kind}`,
						source: "editor",
						trace: (message, details) => this.trace("recovery", message, details),
					});
					new Notice(`YAOS preserved an offline edit as “${conflictPath}” before refreshing its sync history.`, 10_000);
				},
			});
			this.vaultSync = runtime;
			if (runtime.canvases) canvasProjection.attachManager(runtime.canvases);
			this.syncCanvasLeaves();

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
				() => ({
					displayName: this.settings.principalDisplayName,
					principalId: this.settings.principalId,
					colorSeed: this.settings.principalColorSeed,
				}),
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
			const bodySettlements = new BodySettlementRepository(
				database,
				BodySettlementRepository.markdownScope(this.settings.vaultGeneration),
				canonicalMarkdownHash,
			);
			this.bodySettlementRepository = bodySettlements;
			this.diskMirror.configureSettlement({
				getBaseline: (path) => ({
					contentHash: currentContentHash(this.diskIndex[path]) ?? null,
					lastDiskIndexPersistedAt: this.lastDiskIndexPersistedAt,
				}),
				commitLocalBody: async (input) => {
					await runtime.commitDiskBody({
						...input,
						...(input.reason === "delete-revive"
							? { lifecycle: "revive" as const }
							: {}),
					});
				},
				getCommonBase: (bodyId) => bodySettlements.read(bodyId),
				commitMergedBody: async (input) => {
					const outcome = await runtime.commitBodyCandidateIfCurrent({
						bodyId: input.bodyId,
						path: input.path,
						expectedContent: input.expectedBodyContent,
						content: input.mergedContent,
						candidateId: crypto.randomUUID(),
						reason: "three-way-merge",
					});
					return outcome.kind;
				},
				markDivergence: (bodyId, state) => runtime.bodies.coordinator.setDivergence(bodyId, state),
				reviewConflict: ({ path, conflict, stillCurrent }) =>
					reviewThreeWayConflict(this.app, path, conflict, stillCurrent),
				settleClosedBody: async (path) => {
					const bodyId = runtime.getFileId(path);
					if (!bodyId || !this.bootstrapClient) return;
					await runtime.settleBodyOnClose(bodyId);
					await this.bootstrapClient.settleBodyNow(bodyId);
					this.diskMirror?.notifyBodyAvailable(path);
				},
				isPathAllowed: (path) => this.isMarkdownPathSyncable(path),
				isBodyLive: (bodyId) => runtime.isBodyOpen(bodyId),
			});
			this.diskMirror.setFlightEventHandler(
				(event) => this.recordFlightPathEvent(event as FlightPathEventInput),
			);
			this.bootstrapClient = new BootstrapClient(
				bootstrapServer,
				database,
				runtime.bodies,
				this.diskMirror,
				(progress) => {
					this.bootstrapProgress = progress;
					this.refreshStatusBar();
				},
			);
			this.bootstrapClient.configureSettlements(bodySettlements);
			if (runtime.canvases) this.bootstrapClient.configureCanvases(runtime.canvases);
			// Track SHA-256 baseline hash after every successful flushWrite.
			// Used by decideClosedFileConflict on startup/re-enable to determine
			// which side actually changed from the last known stable state.
			this.diskMirror.setDiskWriteCallback((path, contentHash) => {
				const existing = this.diskIndex[path];
				if (existing) {
					setCurrentContentHash(existing, contentHash);
				} else {
					const entry = { mtime: 0, size: 0 };
					setCurrentContentHash(entry, contentHash);
					this.diskIndex[path] = entry;
				}
			});
			this.diskMirror.setPartialDiskWriteCallback((path, bodyHash, propertiesHash) => {
				const entry = this.diskIndex[path] ?? { mtime: 0, size: 0 };
				setPartialContentHashes(entry, bodyHash, propertiesHash);
				this.diskIndex[path] = entry;
			});

			// 4b. BlobSyncManager (if attachment sync is enabled)
			this.attachmentOrchestrator?.start("startup", false);

			// 5. Status tracking
			this.connectionController = new ConnectionController({
				getVaultSync: () => this.vaultSync,
				setResidencyVisibility: (visibility) => {
					this.vaultSync?.setResidencyRuntimeContext(
						Platform.isMobile ? "mobile" : "desktop",
						visibility,
					);
				},
				getAttachmentStatus: () => {
					const blobSnapshot = this.getBlobSync()?.getDebugSnapshot();
					return {
						pendingPublications: Math.max(
							0,
							(this.vaultSync?.pendingAttachmentOperations ?? 0)
								- (this.vaultSync?.fatalAttachmentPublications ?? 0),
						),
						reconciliationPending: this.attachmentReconciliationPending,
						permanentTransferFailures:
							(blobSnapshot?.permanentUploadFailures ?? 0)
							+ (blobSnapshot?.permanentDownloadFailures ?? 0),
						fatalPublications: this.vaultSync?.fatalAttachmentPublications ?? 0,
					};
				},
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
					void this.reconciliationController.runReconnectReconciliation(generation).then(() => {
						if (!this.reconciliationController.isReconcileInFlight && !this.reconciliationController.pending) {
							this.attachmentReconciliationPending = false;
						}
					});
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
					importUntrackedFiles: () => this.importUntrackedFiles(),
					resetLocalCache: () => this.resetLocalCache(),
					nuclearReset: () => this.nuclearReset(),
					restartPendingRestore: () => this.snapshotService?.restartPendingRestore() ?? Promise.resolve(),
					exportVault: async () => {
						await new VaultExportService(this.app).exportToDownload();
					},
					applySettingsSync: () => this.applySettingsSync(),
					replaceSettingsSyncEnvironment: () => this.replaceSettingsSyncEnvironment(),
					seedSettingsSyncFromThisDevice: () => this.seedSettingsSyncFromThisDevice(),
					takeSettingsSyncSeed: () => this.takeSettingsSyncSeed(),
					deferSettingsSyncSeed: () => this.deferSettingsSyncSeed(),
					isSettingsSyncDebugEnabled: () => this.settings.debug || this.settings.qaDebugMode,
					runSettingsSyncInstallSmoke: async () => {
						noticeForInstallResult(await confirmAndSmokeInstallCalendar(this.app));
					},
					runSettingsSyncCommand: (action) => this.runSettingsSyncCommand(action),
					promoteActiveCanvas: () => this.promoteActiveCanvas(),
					demoteActiveCanvas: () => this.demoteActiveCanvas(),
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

			// Materialize the validated schema-8 root and every active body before
			// admitting editor/disk events. Bootstrap progress and outstanding
			// safety settlements are durable in the folder-scoped database.
			this.updateStatusBar({ kind: "loading_cache" });
			const bootstrap = this.bootstrapClient;
			if (!bootstrap) throw new Error("schema-8 bootstrap client is unavailable");
			const bootstrapState = await bootstrap.run();
			if (abortIfStale("schema-8 bootstrap")) return;
			const outstanding = await database.listOutstanding();
			this.bootstrapProgress = {
				stage: bootstrapState.stage,
				settledBodies: bootstrapState.settledBodies,
				totalBodies: bootstrapState.totalBodies,
				outstandingBodies: outstanding.length,
			};

			this.updateStatusBar({ kind: "connecting" });
			const providerSynced = await runtime.waitForProviderSync();
			if (abortIfStale("root provider synchronization")) return;
			this.awaitingFirstProviderSyncAfterStartup = !providerSynced;
			if (runtime.fatalAuthError) {
				this.updateStatusBar(this.getCurrentConnectionState());
				this.showFatalSyncNotice();
				return;
			}

			await this.runReconciliation("authoritative");
			if (abortIfStale("schema-8 admission")) return;
			this.reconciliationController.lastGeneration = runtime.connectionGeneration;
			if (providerSynced) this.awaitingFirstProviderSyncAfterStartup = false;
			if (this.settings.originImportPending) {
				this.initialImportSummary = summarizeLocalVaultImport(await importer.run());
				if (this.initialImportSummary.stage === "complete") {
					await this.updateSettings((settings) => {
						settings.originImportPending = false;
					}, "origin-import-complete");
					await this.reconciliationController.reconcileMarkdownInventory("origin-import-post");
				}
			}

			this.connectionStateLatch.recover();
			this.refreshStatusBar();
			void this.refreshPublicSettlementEvidence();
			this.trace("trace", "startup-init-sync-complete", {
				durationMs: Date.now() - initSyncStartedAt,
			});
			this.log("Startup complete");
			this.scheduleTraceStateSnapshot("startup-complete");
			this.attachmentOrchestrator?.markStartupReady("startup-complete");
			void this.lab?.refreshServerTrace();
			this.snapshotService?.resumePersistedOperations();

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

	private scheduleSchema4CatchUp(reason: string): void {
		if (!this.bootstrapClient || this.teardownLifecycle.isClosing) return;
		this.bootstrapCatchUpPending = true;
		if (this.bootstrapCatchUp) return;
		const bootstrap = this.bootstrapClient;
		const run = async () => {
			while (this.bootstrapCatchUpPending && !this.teardownLifecycle.isClosing) {
				this.bootstrapCatchUpPending = false;
				try {
					const progress = await bootstrap.run();
					const outstanding = await this.vaultDatabase?.listOutstanding() ?? [];
					this.bootstrapProgress = {
						stage: progress.stage,
						settledBodies: progress.settledBodies,
						totalBodies: progress.totalBodies,
						outstandingBodies: outstanding.length,
					};
					this.reconciliationController.lastGeneration =
						this.vaultSync?.connectionGeneration
						?? this.reconciliationController.lastGeneration;
					this.editorWorkspace?.onReconciled(`schema4-catch-up:${reason}`);
				} catch (error) {
					this.log(`Schema-6 catch-up failed (${reason}): ${formatUnknown(error)}`);
				} finally {
					this.refreshStatusBar();
				}
			}
		};
		let tracked: Promise<void>;
		tracked = run().finally(() => {
			if (this.bootstrapCatchUp === tracked) {
				this.bootstrapCatchUp = null;
				if (this.bootstrapCatchUpPending) this.scheduleSchema4CatchUp(`${reason}:pending`);
			}
		});
		this.bootstrapCatchUp = tracked;
	}

	private async runReconciliation(mode: ReconcileMode): Promise<void> {
		await this.reconciliationController.runReconciliation(mode);
		if (!this.reconciliationController.isReconcileInFlight && !this.reconciliationController.pending) {
			this.attachmentReconciliationPending = false;
		}
	}

	private async importUntrackedFiles(): Promise<void> {
		await this.reconciliationController.importUntrackedFiles();
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
				this.syncCanvasLeaves();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onActiveLeafChange(leaf);
				this.syncCanvasLeaves();
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.reconciliationController.isReconciled) return;
				this.editorWorkspace?.onFileOpen(file?.path ?? null);
				this.syncCanvasLeaves();
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
				} else if (this.isCanvasPathSyncable(file.path) && this.vaultSync?.canvases?.isSemanticPath(file.path)) {
					void this.app.vault.readBinary(file)
						.then((bytes) => this.vaultSync?.canvases?.ingest(file.path, new Uint8Array(bytes)))
						.catch((error) => this.log(`Canvas ingest failed for "${file.path}": ${formatUnknown(error)}`));
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
				const canvasDocumentId = this.vaultSync?.canvases?.documentIdForPath(oldPath);
				if (canvasDocumentId && this.isCanvasPathSyncable(file.path)) {
					void this.vaultSync?.canvases?.rename(canvasDocumentId, oldPath, file.path)
						.catch((error) => this.log(`Canvas rename failed: ${formatUnknown(error)}`));
					return;
				}

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
						void this.attachmentOrchestrator?.manager
							?.handleFileRename(action.oldPath, action.newPath)
							.catch((error) => this.log(`Blob rename failed: ${formatUnknown(error)}`));
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
					} else if (this.vaultSync?.canvases?.isSemanticPath(file.path)) {
						const documentId = this.vaultSync.canvases.documentIdForPath(file.path);
						if (documentId) void this.vaultSync.canvases.delete(documentId)
							.catch((error) => this.log(`Canvas delete failed for "${file.path}": ${formatUnknown(error)}`));
					} else {
						const blobSync = this.getBlobSync();
						if (blobSync && this.isBlobPathSyncable(file.path) && !blobSync.isSuppressed(file.path)) {
							void blobSync.handleFileDelete(file.path, this.settings.deviceName)
								.catch((error) => this.log(`Blob delete publication failed: ${formatUnknown(error)}`));
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
				} else if (this.isCanvasPathSyncable(file.path) && this.vaultSync?.canvases?.isSemanticPath(file.path)) {
					void this.app.vault.readBinary(file)
						.then((bytes) => this.vaultSync?.canvases?.ingest(file.path, new Uint8Array(bytes)))
						.catch((error) => this.log(`Canvas create failed for "${file.path}": ${formatUnknown(error)}`));
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

	private syncCanvasLeaves(): void {
		this.canvasProjection?.syncLeaves(this.app.workspace.getLeavesOfType("canvas"));
	}

	// -------------------------------------------------------------------
	// Teardown + reinit (for reset commands)
	// Schema-6 bodies are independently bounded and clean-only eviction replaces
	// the old whole-document rebuild path.

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
			{
				name: "settings-sync",
				run: () => this.stopSettingsSyncEngine(),
			},
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
				name: "schema4-catch-up",
				run: () => this.bootstrapCatchUp ?? undefined,
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
				name: "canvas-projection",
				run: () => this.canvasProjection?.destroy(),
			},
			{
				name: "vault-sync",
				run: () => this.vaultSync?.destroy(),
			},
			{
				name: "runtime-references",
				run: () => {
					this.settingsSyncEngine = null;
					this.vaultSync = null;
					this.connectionController = null;
					this.editorBindings = null;
					this.diskMirror = null;
					this.canvasProjection = null;
					this.vaultDatabase = null;
					this.bootstrapClient = null;
					this.bodySettlementRepository = null;
					this.bootstrapProgress = null;
					this.bootstrapCatchUp = null;
					this.bootstrapCatchUpPending = false;
					this.attachmentReconciliationPending = false;
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
		if (!this.vaultSync || !this.vaultDatabase) {
			new Notice("Sync not initialized");
			return;
		}
		new ConfirmModal(
			this.app,
			"Reset local cache",
			"This clears this folder’s schema-8 cache and downloads the vault again. Pending local work must settle first. Continue?",
			async () => {
				const database = this.vaultDatabase;
				if (!database) return;
				try {
					const preflight = await database.getPendingWorkSummary();
					await this.teardownSync();
					await database.deleteDatabaseAfterClose(preflight);
					await this.initSync(true);
					new Notice("Cache reset complete.");
				} catch (error) {
					console.error("[yaos] Failed to reset schema-8 cache:", error);
					new Notice(`Cache reset refused: ${formatUnknown(error)}`, 8000);
				}
			},
		).open();
	}

	private nuclearReset(): void {
		const runtime = this.vaultSync;
		const database = this.vaultDatabase;
		if (!runtime || !database) {
			new Notice("Sync not initialized");
			return;
		}
		const pathCount = runtime.getActiveMarkdownPaths().length;
		new ConfirmModal(
			this.app,
			"Nuclear reset",
			`This durably deletes ${pathCount} synced notes from the server, clears this folder’s schema-8 cache, then imports the current disk files. Continue?`,
			async () => {
				try {
					const requests = await Promise.all([...runtime.pathToId].map(async ([path, bodyId]) => ({
						operationId: crypto.randomUUID(),
						kind: "delete" as const,
						fileId: bodyId,
						bodyId,
						bodyEpoch: await runtime.currentBodyEpoch(bodyId),
						path,
					})));
					if (requests.length > 0) await runtime.commitStructuralBatch(requests);
					for (const [path] of runtime.listAttachmentRefs()) {
						await runtime.deleteAttachmentRef(path, this.settings.deviceName);
					}
					const preflight = await database.getPendingWorkSummary();
					await this.teardownSync();
					await database.deleteDatabaseAfterClose(preflight, { discardPendingWork: true });
					await this.initSync(true);
					await this.importUntrackedFiles();
					new Notice(
						`YAOS: nuclear reset complete. Re-imported ${this.vaultSync?.getActiveMarkdownPaths().length ?? 0} files.`,
					);
				} catch (error) {
					console.error("[yaos] Nuclear reset failed:", error);
					new Notice(`Nuclear reset failed: ${formatUnknown(error)}`, 10000);
				}
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

	private async getFrontmatterQuarantineEvidence(path: string): Promise<FrontmatterQuarantineEvidence> {
		const bodyId = this.vaultSync?.getFileId(path) ?? null;
		if (!bodyId) return {};
		const result = await this.bodySettlementRepository?.read(bodyId);
		if (!result || result.kind !== "available") return { bodyId };
		const settlement = result.settlement;
		if (settlement.format === 1) {
			return {
				bodyId,
				settlementRevision: settlement.localSettlementRevision,
				settlementAgreement: "whole",
			};
		}
		return {
			bodyId,
			settlementRevision: settlement.localSettlementRevision,
			settlementAgreement: settlement.agreement,
			settlementBodyHashPrefix: settlement.observation.serverBodyHash.slice(0, 12),
			settlementServerPropertiesHashPrefix: settlement.observation.serverPropertiesHash.slice(0, 12),
			settlementDiskPropertiesHashPrefix: settlement.observation.diskPropertiesHash.slice(0, 12),
		};
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
		const fatalAuthority = this.vaultSync?.fatalAuthCode;
		if ((fatalAuthority === "membership_revoked" || fatalAuthority === "device_revoked")
			&& this.authorityCoordinator.current.state !== "revoked") {
			this.authorityCoordinator.revoked(fatalAuthority);
		} else if (fatalAuthority === "authority_superseded"
			&& this.authorityCoordinator.current.state !== "changing") {
			this.authorityCoordinator.changing(fatalAuthority);
		}
		const state = this.getCurrentConnectionState();
		if (state.kind === "local_persistence_failed") {
			this.handleIndexedDbDegraded("status-check");
		}
		this.updateStatusBar(state);
		this.publishPublicApiSnapshot();
	}

	private installPublicApi(): void {
		const service = new YaosPublicApiService(this.publicApiSnapshotInput());
		this.publicApiService = service;
		this.api = service.api;
		this.app.workspace.trigger("yaos:api-ready");
	}

	private publishPublicApiSnapshot(): void {
		if (!this.publicApiService || this.teardownLifecycle.isClosing) return;
		this.publicApiService.publish(this.publicApiSnapshotInput());
	}

	private publicApiSnapshotInput(): YaosPublicSnapshotInput {
		const runtime = this.vaultSync;
		const preserved = this.collectPreservedUnresolvedEntries();
		const frontmatter = this.frontmatterQuarantineEntries;
		if (!runtime) {
			return {
				availability: "starting",
				collaboration: this.publicCollaborationSnapshot(),
				files: [],
				counts: {
					files: 0,
					residentBodies: 0,
					pendingSettlements: 0,
					preservedUnresolved: preserved.length,
					frontmatterQuarantined: frontmatter.length,
					semanticCanvases: 0,
					residentCanvases: 0,
					pendingCanvasOperations: 0,
					invalidCanvases: 0,
					oversizedCanvases: 0,
					conflictCanvases: 0,
					degradedCanvases: 0,
				},
			};
		}
		let residentBodies = 0;
		let pendingSettlements = 0;
		const files = runtime.getActiveMarkdownPaths().sort().flatMap((path) => {
			const bodyId = runtime.getFileId(path);
			if (!bodyId) return [];
			const body = runtime.bodies.coordinator.snapshot(bodyId);
			if (!body) return [];
			if (body.residency !== "absent") residentBodies++;
			const settlement = this.publicSettlementSummaries.get(bodyId)
				?? this.unknownPublicSettlement(body.synchronization);
			if (settlement.state === "pending") pendingSettlements++;
			return [{
				path,
				bodyId,
				body: {
					contentRevision: body.contentRevision,
					lifecycleRevision: body.lifecycleRevision,
					ownershipRevision: body.ownershipRevision,
					residency: body.residency,
					projectionOwner: body.projectionOwner,
					synchronization: body.synchronization,
					divergence: body.divergence,
					lifetime: body.lifetime,
					leaseCount: body.leaseCount,
				},
				settlement,
				conflicts: {
					preservedUnresolved: preserved.filter((entry) => entry.path === path).length,
					frontmatterQuarantined: frontmatter.filter((entry) => entry.path === path).length,
				},
			}];
		});
		return {
			availability: "ready",
			collaboration: this.publicCollaborationSnapshot(),
			files,
			counts: {
				files: files.length,
				residentBodies,
				pendingSettlements,
				preservedUnresolved: preserved.length,
				frontmatterQuarantined: frontmatter.length,
				semanticCanvases: runtime.getCanvasStats()?.semanticDocuments ?? 0,
				residentCanvases: runtime.getCanvasStats()?.residentDocuments ?? 0,
				pendingCanvasOperations: (runtime.getCanvasStats()?.pendingSubmissions ?? 0)
					+ (runtime.getCanvasStats()?.pendingDocuments ?? 0),
				invalidCanvases: runtime.getCanvasStats()?.invalidDocuments ?? 0,
				oversizedCanvases: runtime.getCanvasStats()?.oversizedDocuments ?? 0,
				conflictCanvases: runtime.getCanvasStats()?.conflictDocuments ?? 0,
				degradedCanvases: runtime.getCanvasStats()?.degradedDocuments ?? 0,
			},
		};
	}

	private publicCollaborationSnapshot(): NonNullable<YaosPublicSnapshotInput["collaboration"]> {
		const authoritySnapshot = this.authorityCoordinator.current;
		const authority = authoritySnapshot.authority;
		const presence: NonNullable<YaosPublicSnapshotInput["collaboration"]>["presence"][number][] = [];
		const states = this.vaultSync?.provider.awareness.getStates().values() ?? [];
		for (const state of states as Iterable<unknown>) {
			if (!state || typeof state !== "object" || !("user" in state)) continue;
			const user = state.user;
			if (!user || typeof user !== "object") continue;
			const value = user as Record<string, unknown>;
			if (typeof value.principalId !== "string" || typeof value.deviceId !== "string") continue;
			presence.push({
				principalId: value.principalId,
				deviceId: value.deviceId,
				displayName: typeof value.name === "string" ? value.name : "Vault member",
				deviceName: typeof value.deviceName === "string" ? value.deviceName : "Device",
			});
		}
		return {
			authorityState: authoritySnapshot.state,
			principalId: authority?.principalId ?? null,
			displayName: this.settings.principalDisplayName || null,
			deviceId: authority?.deviceId ?? null,
			deviceName: this.settings.deviceName || null,
			role: authority?.role ?? null,
			membershipRevision: authority?.membershipRevision ?? null,
			deviceCredentialRevision: authority?.deviceCredentialRevision ?? null,
			policyVersion: authority?.policyVersion ?? null,
			capabilities: authority?.capabilities ?? [],
			members: this.vaultRoster.map((member) => ({
				principalId: member.principalId ?? member.deviceId,
				displayName: member.displayName ?? member.name,
				role: member.role ?? "member",
				state: member.state ?? "active",
				deviceCount: member.deviceCount ?? 1,
				lastSeenAt: member.lastSeenAt ?? null,
			})),
			presence,
			ownershipTransfers: this.ownershipTransfers,
			preservedUnpublishedWork: this.authoritySupersededWork.length,
		};
	}

	private unknownPublicSettlement(synchronization: YaosPublicSnapshotInput["files"][number]["body"]["synchronization"]): YaosPublicSettlementSummary {
		return {
			state: synchronization === "locally-pending" || synchronization === "durably-pending" ? "pending" : "unknown",
			durableGeneration: null,
			localSettlementRevision: null,
			agreement: "unknown",
			settledAt: null,
		};
	}

	private async refreshPublicSettlementEvidence(): Promise<void> {
		const runtime = this.vaultSync;
		const repository = this.bodySettlementRepository;
		if (!runtime || !repository || this.teardownLifecycle.isClosing) return;
		const records = await Promise.all(runtime.getActiveMarkdownPaths().map(async (path) => {
			const bodyId = runtime.getFileId(path);
			if (!bodyId) return null;
			const result = await repository.read(bodyId);
			if (result.kind !== "available") return [bodyId, null] as const;
			return [bodyId, {
				state: "settled" as const,
				durableGeneration: result.settlement.durableGeneration,
				localSettlementRevision: result.settlement.localSettlementRevision,
				agreement: result.settlement.format === 1 || result.settlement.agreement === "whole" ? "agreed" as const : "disagreed" as const,
				settledAt: result.settlement.settledAt,
			}] as const;
		}));
		if (runtime !== this.vaultSync || this.teardownLifecycle.isClosing) return;
		for (const record of records) {
			if (!record) continue;
			const [bodyId, settlement] = record;
			if (settlement) this.publicSettlementSummaries.set(bodyId, settlement);
			else this.publicSettlementSummaries.delete(bodyId);
		}
		this.publishPublicApiSnapshot();
	}

	/** Coalesce durable body-candidate receipt updates into one status redraw. */
	private queueReceiptStatusRefresh(): void {
		this.receiptStatusRefresh.request();
	}

	private serializeSettingsSyncLifecycle(operation: () => Promise<void>): Promise<void> {
		const run = this.settingsSyncLifecycleTail.then(operation, operation);
		this.settingsSyncLifecycleTail = run.catch(() => undefined);
		return run;
	}

	private publishSettingsSyncStatus(status: SettingsSyncStatus): void {
		this.settingsSyncStatus = status;
		this.settingsSyncTab?.update();
	}

	private hasExactSettingsSyncCapability(): boolean {
		const capabilities = this.capabilityUpdateService?.capabilities;
		return this.authorityCoordinator.has("vault.settings.personal.sync")
			&& capabilities?.settingsSync === true
			&& capabilities.settingsFormatVersion === SETTINGS_SYNC_FORMAT_VERSION;
	}

	private async installSettingsSyncEngine(
		folderKey: string,
		provisioning: VaultProvisioningProof,
	): Promise<void> {
		if (
			provisioning.vaultId !== this.settings.vaultId
			|| provisioning.vaultGeneration !== this.settings.vaultGeneration
		) {
			throw new Error("settings sync provisioning identity mismatch");
		}
		await this.serializeSettingsSyncLifecycle(async () => {
			if (this.teardownLifecycle.isClosing) return;
			await this.settingsSyncEngine?.stop();
			this.settingsSyncCapabilityActive = false;
			let engine!: SettingsSyncEngine;
			const noticeIdentity = [
				this.settings.host.trim().replace(/\/$/, ""),
				this.settings.vaultId,
				this.settings.vaultGeneration,
				folderKey,
				this.settings.deviceId,
				this.app.vault.configDir,
			].join("\n");
			engine = new SettingsSyncEngine({
				app: this.app,
				getSettings: () => this.settings,
				getCapabilities: () => this.capabilityUpdateService?.capabilities ?? null,
				folderKey,
				onStatus: (status) => {
					if (this.settingsSyncEngine === engine) this.publishSettingsSyncStatus(status);
				},
				onNeedsSeed: ({ blank }) => {
					if (this.settingsSyncEngine !== engine || this.settingsSyncSeedNoticeIdentity === noticeIdentity) {
						return;
					}
					this.settingsSyncSeedNoticeIdentity = noticeIdentity;
					new Notice(
						blank
							? "YAOS settings sync is ready, but this settings environment has not been seeded. Open Yaos settings to take the remote environment or seed this device."
							: "YAOS settings sync found local configuration, but this settings environment has not been seeded. Open Yaos settings to choose which environment wins.",
						10000,
					);
				},
				setDeferred: (deferred) => {
					if (this.settings.settingsSyncDeferred === deferred) return;
					void this.updateSettings((settings) => {
						settings.settingsSyncDeferred = deferred;
					}, "settings-sync-deferred").catch((error: unknown) => {
						new Notice(`Could not save settings sync choice: ${formatUnknown(error)}`, 8000);
					});
				},
			});
			this.settingsSyncEngine = engine;
			await this.reconcileSettingsSyncEngineInner();
		});
	}

	private async reconcileSettingsSyncEngineInner(force = false): Promise<void> {
		const engine = this.settingsSyncEngine;
		if (!engine) return;
		try {
			if (this.teardownLifecycle.isClosing) {
				this.settingsSyncCapabilityActive = false;
				await engine.stop();
				return;
			}
			if (this.hasExactSettingsSyncCapability()) {
				if (this.settingsSyncCapabilityActive && !force) return;
				await engine.start();
				this.settingsSyncCapabilityActive = true;
				return;
			}
			this.settingsSyncCapabilityActive = false;
			await engine.stop();
			const capabilities = this.capabilityUpdateService?.capabilities;
			this.publishSettingsSyncStatus({
				...engine.getStatus(),
				running: false,
				reason: "unsupported",
				headline: capabilities?.settingsSync
					? "settings_format_unsupported"
					: "settings_sync_unsupported",
				error: null,
			});
		} catch (error) {
			this.settingsSyncCapabilityActive = false;
			await engine.stop().catch(() => undefined);
			const details = formatUnknown(error);
			this.publishSettingsSyncStatus({
				...engine.getStatus(),
				running: false,
				reason: "error",
				error: details,
			});
			this.log(`Settings sync unavailable; note sync is continuing: ${details}`);
			this.trace("settings", "settings-sync-start-failed", { error: details });
		}
	}

	async refreshSettingsSyncRuntime(): Promise<void> {
		await this.serializeSettingsSyncLifecycle(() => this.reconcileSettingsSyncEngineInner(true));
	}

	private async stopSettingsSyncEngine(): Promise<void> {
		await this.serializeSettingsSyncLifecycle(async () => {
			await this.settingsSyncEngine?.stop();
			this.settingsSyncCapabilityActive = false;
		});
	}

	getSettingsSyncStatus(): SettingsSyncStatus {
		return this.settingsSyncStatus;
	}

	canManageRecovery(): boolean {
		return this.authorityCoordinator.has("vault.recovery.manage");
	}

	private async runSettingsSyncAction(
		action: (engine: SettingsSyncEngine) => Promise<void>,
	): Promise<void> {
		const engine = this.settingsSyncEngine;
		if (!engine) {
			new Notice("Settings sync is not available until enrollment and provisioning complete.", 7000);
			return;
		}
		try {
			await action(engine);
			this.publishSettingsSyncStatus(engine.getStatus());
		} catch (error) {
			new Notice(`Settings sync action failed: ${formatUnknown(error)}`, 9000);
		}
	}

	async applySettingsSync(): Promise<void> {
		await this.runSettingsSyncAction((engine) => engine.applySettings());
	}

	async replaceSettingsSyncEnvironment(): Promise<void> {
		await this.runSettingsSyncAction((engine) => engine.replaceEnvironment());
	}

	async seedSettingsSyncFromThisDevice(): Promise<void> {
		await this.runSettingsSyncAction((engine) => engine.seedThisDevice());
	}

	async takeSettingsSyncSeed(): Promise<void> {
		await this.runSettingsSyncAction((engine) => engine.takeSeed());
	}

	async deferSettingsSyncSeed(): Promise<void> {
		await this.updateSettings((settings) => {
			settings.settingsSyncDeferred = true;
		}, "settings-sync-defer");
		await this.refreshSettingsSyncRuntime();
	}

	async updateSettingsSyncPlugin(pluginId: string): Promise<void> {
		await this.runSettingsSyncAction((engine) => engine.updatePlugin(pluginId));
	}

	async promoteSettingsSyncPlugin(pluginId: string): Promise<void> {
		await this.runSettingsSyncAction((engine) => engine.promotePin(pluginId));
	}

	async removeSettingsSyncEnvironmentItem(kind: "plugin" | "theme", id: string): Promise<void> {
		await this.runSettingsSyncAction((engine) => engine.removeFromEnvironment(kind, id));
	}

	private async confirmSettingsSyncCommand(
		title: string,
		message: string,
		confirmText: string,
	): Promise<boolean> {
		return await new Promise<boolean>((resolve) => {
			new ConfirmModal(
				this.app,
				title,
				message,
				() => resolve(true),
				confirmText,
				"Cancel",
				() => resolve(false),
			).open();
		});
	}

	async runSettingsSyncCommand(
		action: "apply" | "replace" | "seed" | "take" | "defer",
	): Promise<void> {
		const status = this.getSettingsSyncStatus();
		const decisionRequired = status.reason === "decision-required";
		if (action === "defer") {
			await this.deferSettingsSyncSeed();
			return;
		}
		if (action === "replace" || (action === "seed" && decisionRequired)) {
			const confirmed = await this.confirmSettingsSyncCommand(
				"Replace the remote settings environment?",
				"This overwrites your personal remote settings environment with this device's current managed configuration.",
				"Replace remote",
			);
			if (confirmed) await this.replaceSettingsSyncEnvironment();
			return;
		}
		if ((action === "take" || action === "apply") && decisionRequired) {
			const confirmed = await this.confirmSettingsSyncCommand(
				"Take the remote settings environment?",
				status.seedKind === "occupied"
					? "This applies the remote plugin, theme, and settings environment over this device's existing managed configuration."
					: "This applies the remote plugin, theme, and settings environment to this device.",
				"Take remote",
			);
			if (confirmed) await this.takeSettingsSyncSeed();
			return;
		}
		if (action === "apply") {
			await this.applySettingsSync();
			return;
		}
		if (action === "seed") {
			await this.seedSettingsSyncFromThisDevice();
			return;
		}
		await this.takeSettingsSyncSeed();
	}

	getSettingsStatusSummary(): { label: string } {
		return {
			label: getLabelFromConnectionState(
				this.getCurrentConnectionState(),
				null,
				null,
				0,
				getRecoveryReadiness(this.pendingRecoveryState),
			).replace(/^YAOS:\s*/, ""),
		};
	}

	getOperationalResourceSnapshot(): OperationalResourceSnapshot | null {
		const vaultSync = this.vaultSync;
		if (!vaultSync) return null;
		const overdue = [vaultSync.getOverdueWorkDiagnostics()];
		const recovery = this.snapshotService?.getOverdueWorkDiagnostics();
		if (recovery) overdue.push(recovery);
		const settings = this.settingsSyncEngine?.getOverdueWorkDiagnostics();
		if (settings) overdue.push(settings);
		return this.operationalResources.capture({
			residency: vaultSync.getBodyResidencySnapshot(),
			admission: vaultSync.getResidencyAdmissionSnapshot(),
			overdue,
		}, Date.now(), `${this.settings.vaultGeneration}\0${this.folderKey ?? ""}`);
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
		const resourcePressure = this.getOperationalResourceSnapshot()?.currentPressure ?? null;
		this.noticeServerPersistenceHealth(serverReceipt?.serverPersistenceDegraded ?? false);
		renderConnectionState(
			this.statusBarEl,
			visibleState,
			transferStatus,
			serverReceipt,
			attentionCount,
			getRecoveryReadiness(this.pendingRecoveryState),
			resourcePressure,
		);
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
			pendingAttachmentPublications: Math.max(
				0,
				(vaultSync?.pendingAttachmentOperations ?? 0)
					- (vaultSync?.fatalAttachmentPublications ?? 0),
			),
			attachmentReconciliationPending: this.attachmentReconciliationPending,
			permanentAttachmentTransferFailures: blobSync
				? blobSync.getDebugSnapshot().permanentUploadFailures
					+ blobSync.getDebugSnapshot().permanentDownloadFailures
				: 0,
			fatalAttachmentPublications: vaultSync?.fatalAttachmentPublications ?? 0,
			reconcileInFlight: this.reconciliationController?.isReconcileInFlight ?? false,
			safetyBrakeActive: this.reconciliationController?.getState().lastReconcileStats?.safetyBrakeTriggered ?? false,
			recovery: {
				readiness: getRecoveryReadiness(this.pendingRecoveryState),
				captureState: this.pendingRecoveryState.lastCaptureStatus?.state ?? null,
				restoreState: this.pendingRecoveryState.lastRestoreStatus?.state ?? null,
				projectionState: this.pendingRecoveryState.lastRecoveryStatus?.projectionState ?? null,
			},
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
				leafId: binding?.leafId ?? leafIdentity(view.leaf, path),
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
		return canonicalMarkdownHash(text);
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
		this.publicApiService?.dispose();
		this.publicApiService = null;
		this.api = null;
		this.snapshotService?.destroy();
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
		if (settings.principalId) {
			this.authorityCoordinator.install(readVaultAuthoritySnapshot({
				vaultId: settings.vaultId,
				vaultGeneration: settings.vaultGeneration,
				principalId: settings.principalId,
				membershipRevision: settings.membershipRevision,
				deviceId: settings.deviceId,
				deviceCredentialRevision: settings.deviceCredentialRevision,
				role: settings.vaultRole,
				policyVersion: settings.policyVersion,
				capabilityDigest: settings.capabilityDigest,
				capabilities: settings.authorityCapabilities,
			}));
		}
		// Load disk index from plugin data (stored under _diskIndex key)
		if (data && typeof data._diskIndex === "object" && data._diskIndex !== null) {
			this.diskIndex = readDiskIndex(data._diskIndex);
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
		if (Array.isArray(data?._authoritySupersededWork)) {
			this.authoritySupersededWork = data._authoritySupersededWork.filter((item): item is AuthoritySupersededWork =>
				!!item && typeof item === "object"
				&& (item.kind === "candidate" || item.kind === "lifecycle" || item.kind === "attachment")
				&& typeof item.identity === "string"
				&& typeof item.preservedAt === "number");
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
			const code = await new CollaborationClient(host, vaultId, deviceToken).createDeviceLink();
			return { deepLink: code.obsidianUrl, mobileUrl: code.mobileSetupUrl };
		} catch (err) {
			new Notice(err instanceof Error ? err.message : "Could not mint a pairing code.", 7000);
			return null;
		}
	}

	async mintPersonInvitation(): Promise<{ deepLink: string; mobileUrl: string } | null> {
		if (!this.authorityCoordinator.has("vault.members.invite")) {
			new Notice("Only the vault owner can invite another person.", 7000);
			return null;
		}
		try {
			const code = await this.collaborationClient().createInvitation("New member");
			return { deepLink: code.obsidianUrl, mobileUrl: code.mobileSetupUrl };
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Could not create an invitation.", 7000);
			return null;
		}
	}

	getOwnershipTransfers(): readonly CollaborationOwnershipTransfer[] {
		return this.ownershipTransfers;
	}

	async offerOwnershipTransfer(principalId: string): Promise<void> {
		if (!this.authorityCoordinator.has("vault.ownership.transfer")) {
			new Notice("Only the vault owner can transfer ownership.", 7000);
			return;
		}
		const transfer = await this.collaborationClient().createOwnershipTransfer(principalId);
		this.ownershipTransfers = Object.freeze([...this.ownershipTransfers, transfer]);
		this.settingsSyncTab?.update();
		this.publishPublicApiSnapshot();
		new Notice("Ownership transfer offer created. The member must explicitly accept it.", 8000);
	}

	async renameSharedVault(name: string): Promise<void> {
		if (!this.authorityCoordinator.has("vault.metadata.rename")) throw new Error("Only the vault owner can rename shared vault metadata.");
		await this.collaborationClient().renameVault(name, randomId(22));
		await this.refreshSecurityAudit().catch(() => undefined);
		new Notice(`Shared vault renamed to ${name}.`, 7000);
	}

	async requestVaultDestruction(): Promise<void> {
		if (!this.authorityCoordinator.has("vault.destroy.request")) throw new Error("Only the vault owner can request vault destruction.");
		const request = await this.collaborationClient().requestVaultDestruction(randomId(22));
		await this.refreshSecurityAudit().catch(() => undefined);
		new Notice(`Destruction request created (${request.governanceRequestId}). The deployment operator must confirm it.`, 10000);
	}

	async acceptOwnershipTransfer(transferId: string): Promise<void> {
		this.authorityCoordinator.changing("ownership_transfer");
		try {
			const outcome = await this.collaborationClient().acceptOwnershipTransfer(transferId, randomId(22));
			await this.teardownSync();
			if (outcome.pending) {
				new Notice("Ownership transfer is waiting for the durable vault fence. Sync remains stopped until retry.", 9000);
				return;
			}
			this.ownershipTransfers = [];
			await startEnrollmentRuntime(this.teardownLifecycle, () => this.initSync());
			new Notice("Ownership transfer completed.", 7000);
		} catch (error) {
			await this.refreshCollaborationAuthority("ownership-transfer-failed").catch(() => undefined);
			throw error;
		}
	}

	async cancelOwnershipTransfer(transferId: string): Promise<void> {
		await this.collaborationClient().cancelOwnershipTransfer(transferId);
		this.ownershipTransfers = this.ownershipTransfers.filter((transfer) => transfer.transferId !== transferId);
		this.settingsSyncTab?.update();
		this.publishPublicApiSnapshot();
		new Notice("Ownership transfer offer cancelled.", 6000);
	}

	getVaultDevices(principalId: string): readonly VaultRosterDevice[] {
		return this.vaultDevicesByPrincipal.get(principalId) ?? [];
	}

	getSecurityAudit(): readonly VaultSecurityAuditEvent[] {
		return this.securityAudit;
	}

	async revokeVaultDevice(deviceId: string): Promise<void> {
		if (deviceId === this.settings.deviceId) throw new Error("Use Leave this vault instead of revoking the active device.");
		await this.collaborationClient().revokeDevice(deviceId, randomId(22));
		await this.refreshVaultRoster();
		this.settingsSyncTab?.update();
		this.publishPublicApiSnapshot();
		new Notice("Device revocation started. The device is fenced before removal completes.", 7000);
	}

	async removeVaultMember(principalId: string): Promise<void> {
		if (!this.authorityCoordinator.has("vault.members.manage")) throw new Error("Only the vault owner can remove a person.");
		if (principalId === this.settings.principalId) throw new Error("The vault owner cannot remove themselves.");
		await this.collaborationClient().removeMember(principalId, randomId(22));
		await this.refreshVaultRoster();
		this.settingsSyncTab?.update();
		this.publishPublicApiSnapshot();
		new Notice("Member removal started. Their devices are fenced before removal completes.", 7000);
	}

	async renameThisPerson(displayName: string): Promise<void> {
		if (!this.authorityCoordinator.has("vault.profile.manage_self")) throw new Error("This membership cannot rename its profile.");
		const principalId = this.settings.principalId.trim();
		if (!principalId) throw new Error("Person identity is unavailable.");
		this.authorityCoordinator.changing("profile_update");
		await this.teardownSync();
		try {
			const outcome = await this.collaborationClient().renamePrincipal(principalId, displayName.trim(), randomId(22));
			await this.refreshCollaborationAuthority("profile-update");
			await startEnrollmentRuntime(this.teardownLifecycle, () => this.initSync());
			await this.refreshVaultRoster();
			this.settingsSyncTab?.update();
			this.publishPublicApiSnapshot();
			new Notice(outcome.pending ? "Name changed. The authority fence is settling across the vault." : "Name changed.", 7000);
		} catch (error) {
			await this.refreshCollaborationAuthority("profile-update-failed").catch(() => undefined);
			if (this.authorityCoordinator.current.state === "active") {
				await startEnrollmentRuntime(this.teardownLifecycle, () => this.initSync()).catch(() => undefined);
			}
			throw error;
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

	private async retireSettingsSyncLocalState(membership: EnrollmentMembership): Promise<void> {
		const folderKey = await this.ensureFolderKey();
		await this.serializeSettingsSyncLifecycle(async () => {
			const activeEngine = this.settingsSyncEngine;
			const engine = activeEngine ?? new SettingsSyncEngine({
				app: this.app,
				getSettings: () => ({
					host: membership.host,
					deviceToken: membership.deviceToken,
					vaultId: membership.vaultId,
					vaultGeneration: membership.vaultGeneration,
					deviceId: membership.deviceId,
					principalId: this.settings.principalId,
					membershipRevision: this.settings.membershipRevision,
					deviceCredentialRevision: this.settings.deviceCredentialRevision,
					settingsSyncEnabled: this.settings.settingsSyncEnabled,
					settingsSyncAutoInstall: this.settings.settingsSyncAutoInstall,
					settingsSyncDeferred: this.settings.settingsSyncDeferred,
				}),
				getCapabilities: () => null,
				folderKey,
			});
			await engine.retire();
			if (this.settingsSyncEngine === activeEngine) this.settingsSyncEngine = null;
			this.settingsSyncCapabilityActive = false;
		});
		this.settings.settingsSyncDeferred = false;
		await this.persistPluginState((state) => {
			delete state._provisioningProof;
		});
		this.publishSettingsSyncStatus(emptySettingsSyncStatus());
	}

	private async retireCurrentEnrollment(membership: EnrollmentMembership): Promise<void> {
		await this.retireSettingsSyncLocalState(membership);
		const database = this.vaultDatabase;
		const preflight = await database?.getPendingWorkSummary() ?? null;
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

		await this.teardownSync();
		if (database && preflight) {
			await database.deleteDatabaseAfterClose(preflight);
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

	getPreservedUnpublishedWorkCount(): number {
		return this.authoritySupersededWork.length;
	}

	isDeviceOnline(deviceId: string): boolean {
		if (!deviceId) return false;
		const awareness = this.vaultSync?.provider.awareness;
		if (!awareness) return false;
		for (const state of awareness.getStates().values() as IterableIterator<unknown>) {
			if (!state || typeof state !== "object" || !("user" in state)) continue;
			const user = state.user;
			if (user && typeof user === "object" && (
				("id" in user && user.id === deviceId)
				|| ("deviceId" in user && user.deviceId === deviceId)
				|| ("principalId" in user && user.principalId === deviceId)
			)) return true;
		}
		return false;
	}

	async refreshVaultRoster(): Promise<void> {
		const host = this.settings.host.trim().replace(/\/$/, "");
		const deviceToken = this.settings.deviceToken.trim();
		const vaultId = this.settings.vaultId.trim();
		if (this.rosterVaultId !== vaultId) {
			this.vaultRoster = [];
			this.vaultDevicesByPrincipal.clear();
			this.securityAudit = [];
			this.rosterVaultId = vaultId;
		}
		if (!host || !deviceToken || !vaultId) {
			this.vaultRoster = [];
			this.vaultDevicesByPrincipal.clear();
			this.securityAudit = [];
			return;
		}
		try {
			const client = new CollaborationClient(host, vaultId, deviceToken);
			const members = await client.listMembers();
			const visibleDevicePrincipals = members.filter((member) => member.state !== "revoked" && (
				this.settings.vaultRole === "owner" || member.principalId === this.settings.principalId
			));
			const devices = await Promise.all(visibleDevicePrincipals.map(async (member) => ({
				principalId: member.principalId,
				devices: await client.listDevices(member.principalId),
			})));
			if (this.settings.vaultId.trim() !== vaultId) return;
			this.vaultRoster = members.map((member) => ({
				deviceId: member.principalId,
				principalId: member.principalId,
				name: member.displayName,
				displayName: member.displayName,
				role: member.role,
				state: member.state,
				deviceCount: member.deviceCount,
				enrolledAt: member.joinedAt,
				lastSeenAt: member.lastSeenAt ?? undefined,
			}));
			this.vaultDevicesByPrincipal.clear();
			for (const entry of devices) {
				this.vaultDevicesByPrincipal.set(entry.principalId, Object.freeze(entry.devices.map((device) => ({
					deviceId: device.deviceId,
					principalId: device.principalId,
					name: device.name,
					state: device.state,
					enrolledAt: device.enrolledAt,
					lastSeenAt: device.lastSeenAt ?? undefined,
				}))));
			}
			if (this.settings.vaultRole === "owner") {
				try {
					this.securityAudit = await client.listSecurityAudit();
				} catch (error) {
					this.securityAudit = [];
					console.warn("[yaos] Could not refresh the collaboration security audit:", error);
				}
			} else {
				this.securityAudit = [];
			}
			this.publishPublicApiSnapshot();
		} catch (err) {
			if (this.settings.vaultId.trim() === vaultId) this.vaultRoster = [];
			new Notice(err instanceof Error ? err.message : "Could not load the device roster.", 7000);
		}
	}

	async refreshSecurityAudit(): Promise<void> {
		if (!this.authorityCoordinator.has("vault.audit.read")) {
			this.securityAudit = [];
			return;
		}
		this.securityAudit = await this.collaborationClient().listSecurityAudit();
		this.settingsSyncTab?.update();
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
		const membership: EnrollmentMembership = {
			host,
			deviceToken,
			vaultId,
			deviceId: this.settings.deviceId.trim(),
			vaultGeneration: this.settings.vaultGeneration.trim(),
		};
		if (host && deviceToken && vaultId) {
			try {
				this.authorityCoordinator.changing("leave");
				const outcome = await this.collaborationClient().leave(randomId(22));
				if (outcome.pending) {
					await this.teardownSync();
					new Notice("Leaving is waiting for the server's durable authority fence. Credentials are retained for retry.", 9000);
					return;
				}
				this.authorityCoordinator.revoked("left_vault");
			} catch (err) {
				const message = err instanceof Error ? err.message : "Could not revoke this device on the server.";
				this.authorityCoordinator.install(readVaultAuthoritySnapshot({
					vaultId: this.settings.vaultId,
					vaultGeneration: this.settings.vaultGeneration,
					principalId: this.settings.principalId,
					membershipRevision: this.settings.membershipRevision,
					deviceId: this.settings.deviceId,
					deviceCredentialRevision: this.settings.deviceCredentialRevision,
					role: this.settings.vaultRole,
					policyVersion: this.settings.policyVersion,
					capabilityDigest: this.settings.capabilityDigest,
					capabilities: this.settings.authorityCapabilities,
				}));
				new Notice(`${message} Nothing was removed locally.`, 7000);
				return;
			}
		}
		try {
			await this.retireSettingsSyncLocalState(membership);
		} catch (error) {
			new Notice(`Vault membership ended, but local settings queue cleanup failed: ${formatUnknown(error)}`, 9000);
		}


		const database = this.vaultDatabase;
		const preflight = await database?.getPendingWorkSummary() ?? null;
		try {
			await this.teardownSync();
			if (database && preflight) {
				const hasPendingWork = Object.values(preflight).some((count) => count > 0);
				if (!hasPendingWork) await database.deleteDatabaseAfterClose(preflight);
				else new Notice("Pending unpublished work was preserved in this folder's local YAOS cache.", 9000);
			}
		} catch (err) {
			console.error("[yaos] Leave teardown or cache deletion completed with errors:", err);
		}
		this.vaultRoster = [];
		this.vaultDevicesByPrincipal.clear();
		this.securityAudit = [];
		this.rosterVaultId = "";
		await this.updateSettings((settings) => {
			settings.host = "";
			settings.deviceToken = "";
			settings.vaultId = "";
			settings.deviceId = "";
			settings.vaultGeneration = "";
			settings.principalId = "";
			settings.principalDisplayName = "";
			settings.principalColorSeed = "";
			settings.vaultRole = "";
			settings.membershipRevision = 0;
			settings.deviceCredentialRevision = 0;
			settings.policyVersion = 0;
			settings.capabilityDigest = "";
			settings.authorityCapabilities = [];
			settings.originImportPending = false;
			settings.settingsSyncDeferred = false;
		}, "leave-vault");
		new Notice("Left this vault. Notes are still on disk.", 7000);
	}

	private collaborationClient(): CollaborationClient {
		return new CollaborationClient(
			this.settings.host,
			this.settings.vaultId,
			this.settings.deviceToken,
		);
	}

	private async refreshCollaborationAuthority(reason: string): Promise<void> {
		this.authorityCoordinator.refreshing(reason);
		try {
			const me = await this.collaborationClient().getMe();
			this.authorityCoordinator.install(me.authority);
			this.ownershipTransfers = me.ownershipTransfers;
			await this.updateSettings((settings) => {
				settings.principalId = me.authority.principalId;
				settings.principalDisplayName = me.displayName;
				settings.principalColorSeed = me.colorSeed;
				settings.vaultRole = me.authority.role;
				settings.membershipRevision = me.authority.membershipRevision;
				settings.deviceCredentialRevision = me.authority.deviceCredentialRevision;
				settings.policyVersion = me.authority.policyVersion;
				settings.capabilityDigest = me.authority.capabilityDigest;
				settings.authorityCapabilities = [...me.authority.capabilities];
				settings.deviceName = me.deviceName;
			}, `authority:${reason}`);
		} catch (error) {
			this.authorityCoordinator.revoked(error instanceof Error ? error.message : "authority_refresh_failed");
			throw error;
		}
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
		await this.serializeSettingsSyncLifecycle(() => this.reconcileSettingsSyncEngineInner());
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
		if (this.authoritySupersededWork.length > 0) {
			nextState._authoritySupersededWork = this.authoritySupersededWork.map((item) => ({ ...item }));
		} else {
			delete nextState._authoritySupersededWork;
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
		if (this.idbDegradedHandled) return;
		this.idbDegradedHandled = true;
		const details = err ? formatUnknown(err) : "unknown IndexedDB failure";
		const kind = details.toLowerCase().includes("quota") ? "quota_exceeded" : "unknown";
		this.log(`IndexedDB degraded (${source}): kind=${kind}`);
		this.scheduleTraceStateSnapshot("idb-degraded");
		void this.attachmentOrchestrator?.stop("idb-degraded");
		const notice = kind === "quota_exceeded"
			? "YAOS: Device storage is full. Sync durability is degraded and attachment transfers are paused. Free up storage, then restart Obsidian."
			: "YAOS: IndexedDB persistence failed. Sync durability is degraded and attachment transfers are paused.";
		new Notice(notice, 12000);
	}
}
