import { MarkdownView, Modal, Notice, Plugin, TFile, arrayBufferToHex, normalizePath } from "obsidian";
import {
	DEFAULT_SETTINGS,
	VaultSyncSettingTab,
	generateVaultId,
	type VaultSyncSettings,
} from "./settings";
import { VaultSync, type ReconcileMode } from "./sync/vaultSync";
import { SCHEMA_VERSION } from "./sync/vaultSync";
import { EditorBindingManager } from "./sync/editorBinding";
import { DiskMirror } from "./sync/diskMirror";
import { BlobSyncManager, type BlobQueueSnapshot } from "./sync/blobSync";
import { parseExcludePatterns } from "./sync/exclude";
import {
	fetchServerCapabilities,
	type ServerCapabilities,
} from "./sync/serverCapabilities";
import {
	fetchUpdateManifest,
	isUpdateManifest,
	type UpdateManifest,
} from "./update/updateManifest";
import { isMarkdownSyncable, isBlobSyncable } from "./types";
import { applyDiffToYText } from "./sync/diff";
import { decideExternalEditImport } from "./sync/externalEditPolicy";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	extractFrontmatter,
	type FrontmatterValidationResult,
} from "./sync/frontmatterGuard";
import {
	buildFrontmatterQuarantineDebugLines,
	clearFrontmatterQuarantinePath,
	readPersistedFrontmatterQuarantine,
	upsertFrontmatterQuarantineEntry,
	type FrontmatterQuarantineEntry,
} from "./sync/frontmatterQuarantine";
import {
	type DiskIndex,
	collectFileStats,
	filterChangedFiles,
	updateIndex,
	moveIndexEntries,
	waitForDiskQuiet,
} from "./sync/diskIndex";
import {
	type BlobHashCache,
	moveCachedHashes,
} from "./sync/blobHashCache";
import {
	requestDailySnapshot,
	requestSnapshotNow,
	listSnapshots as fetchSnapshotList,
	downloadSnapshot,
	diffSnapshot,
	restoreFromSnapshot,
	type SnapshotIndex,
	type SnapshotDiff,
} from "./sync/snapshotClient";
import {
	appendTraceParams,
	PersistentTraceLogger,
	type TraceEventDetails,
	type TraceHttpContext,
} from "./debug/trace";
import { formatUnknown, yTextToString } from "./utils/format";
import { compareSemver } from "./utils/semver";
import { obsidianRequest } from "./utils/http";

type SyncStatus = "disconnected" | "loading" | "syncing" | "connected" | "offline" | "error" | "unauthorized";

type PersistedServerCapabilitiesCache = {
	host: string;
	capabilities: ServerCapabilities;
};

type PersistedUpdateManifestCache = {
	fetchedAt: number;
	manifest: UpdateManifest;
};

type PersistedPluginState = Partial<VaultSyncSettings> & {
	_diskIndex?: DiskIndex;
	_blobHashCache?: BlobHashCache;
	_blobQueue?: BlobQueueSnapshot;
	_serverCapabilitiesCache?: PersistedServerCapabilitiesCache;
	_updateManifestCache?: PersistedUpdateManifestCache;
	_frontmatterQuarantine?: FrontmatterQuarantineEntry[];
};

/** Minimum interval between reconcile runs (prevents rapid reconnect churn). */
const RECONCILE_COOLDOWN_MS = 10_000;
const FAST_RECONNECT_DEBOUNCE_MS = 1_000;
const FAST_RECONNECT_JITTER_MS = 500;
const FAST_RECONNECT_MIN_INTERVAL_MS = 2_000;
const MARKDOWN_DIRTY_SETTLE_MS = 350;
const OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS = 1200;
const BOUND_RECOVERY_LOCK_MS = 1500;
const CAPABILITY_REFRESH_INTERVAL_MS = 30_000;
const UPDATE_MANIFEST_URLS = [
	"https://github.com/kavinsood/yaos/releases/latest/download/update-manifest.json",
] as const;
const UPDATE_MANIFEST_CACHE_MS = 24 * 60 * 60 * 1000;
const GITHUB_OPS_WORKFLOW_PATH = ".github/workflows/yaos-ops.yml";

function buildGithubOpsBootstrapWorkflowYaml(): string {
	return [
		"name: YAOS Server Ops",
		"on:",
		"  workflow_dispatch:",
		"    inputs:",
		"      action: { type: choice, required: true, default: update, options: [update, revert] }",
		"      version: { type: string, required: false }",
		"      release_repo: { type: string, required: false, default: kavinsood/yaos }",
		"permissions:",
		"  contents: write",
		"jobs:",
		"  run:",
		"    uses: kavinsood/yaos/.github/workflows/yaos-ops-reusable.yml@main",
		"    with:",
		"      action: ${{ github.event.inputs.action }}",
		"      version: ${{ github.event.inputs.version }}",
		"      release_repo: ${{ github.event.inputs.release_repo }}",
		"",
	].join("\n");
}

function isServerCapabilities(value: unknown): value is ServerCapabilities {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ServerCapabilities>;
	return typeof candidate.claimed === "boolean" &&
		(candidate.authMode === "env" || candidate.authMode === "claim" || candidate.authMode === "unclaimed") &&
		typeof candidate.attachments === "boolean" &&
		typeof candidate.snapshots === "boolean" &&
		typeof candidate.serverVersion === "string" &&
		(candidate.minPluginVersion === null || typeof candidate.minPluginVersion === "string") &&
		(candidate.recommendedPluginVersion === null || typeof candidate.recommendedPluginVersion === "string") &&
		(candidate.minSchemaVersion === null || typeof candidate.minSchemaVersion === "number") &&
		(candidate.maxSchemaVersion === null || typeof candidate.maxSchemaVersion === "number") &&
		typeof candidate.migrationRequired === "boolean" &&
		(candidate.updateProvider === null ||
			candidate.updateProvider === "github" ||
			candidate.updateProvider === "gitlab" ||
			candidate.updateProvider === "unknown") &&
		(candidate.updateRepoUrl === null || typeof candidate.updateRepoUrl === "string") &&
		(candidate.updateRepoBranch === undefined ||
			candidate.updateRepoBranch === null ||
			typeof candidate.updateRepoBranch === "string");
}

function readPersistedServerCapabilitiesCache(value: unknown): PersistedServerCapabilitiesCache | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as {
		host?: unknown;
		capabilities?: unknown;
	};
	if (typeof candidate.host !== "string" || !isServerCapabilities(candidate.capabilities)) {
		return null;
	}
	return {
		host: candidate.host,
		capabilities: candidate.capabilities,
	};
}

function readPersistedUpdateManifestCache(value: unknown): PersistedUpdateManifestCache | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as {
		fetchedAt?: unknown;
		manifest?: unknown;
	};
	if (typeof candidate.fetchedAt !== "number" || !isUpdateManifest(candidate.manifest)) {
		return null;
	}
	return {
		fetchedAt: candidate.fetchedAt,
		manifest: candidate.manifest,
	};
}

export default class VaultCrdtSyncPlugin extends Plugin {
	settings: VaultSyncSettings = DEFAULT_SETTINGS;

	private vaultSync: VaultSync | null = null;
	private editorBindings: EditorBindingManager | null = null;
	private diskMirror: DiskMirror | null = null;
	private blobSync: BlobSyncManager | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;

	/**
	 * True after initial reconciliation is complete.
	 * Vault events are ignored before this.
	 */
	private reconciled = false;

	/** True while a reconciliation is running — prevents overlapping runs. */
	private reconcileInFlight = false;

	/** Set to true if a reconnect arrives while reconciliation is in-flight. */
	private reconcilePending = false;

	/**
	 * Files on disk that weren't imported during conservative reconciliation.
	 * Imported when the provider eventually syncs.
	 */
	private untrackedFiles: string[] = [];

	/**
	 * The connection generation at which we last reconciled.
	 * Used to detect reconnects that need re-reconciliation.
	 */
	private lastReconciledGeneration = 0;

	/** Visibility change handler reference for cleanup. */
	private visibilityHandler: (() => void) | null = null;
	private onlineHandler: (() => void) | null = null;
	private offlineHandler: (() => void) | null = null;
	private fastReconnectDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private fastReconnectConnectTimer: ReturnType<typeof setTimeout> | null = null;
	private lastFastReconnectAt = 0;

	/** Track the set of currently observed file paths for disk mirror cleanup. */
	private openFilePaths = new Set<string>();
	private activeMarkdownPath: string | null = null;

	/** Parsed exclude patterns from settings. */
	private excludePatterns: string[] = [];

	/** Max file size in characters (derived from settings KB). */
	private maxFileSize = 0;

	/** Persisted disk index: {path -> {mtime, size}}. */
	private diskIndex: DiskIndex = {};

	/** Persisted blob hash cache: {path -> {mtime, size, hash}}. */
	private blobHashCache: BlobHashCache = {};

	/** True once we've shown the R2 nudge notice this session. */
	private shownAttachmentNudge = false;

	/** Persisted blob queue snapshot for crash resilience. */
	private savedBlobQueue: BlobQueueSnapshot | null = null;
	private persistedState: PersistedPluginState = {};
	private persistWriteChain: Promise<void> = Promise.resolve();

	/** Pending stability checks for newly created/dropped files. */
	private pendingStabilityChecks = new Set<string>();
	/** Coalesced markdown disk events awaiting import into CRDT. */
	private dirtyMarkdownPaths = new Map<string, "create" | "modify">();
	private closedOnlyDeferredImports = new Set<string>();
	private markdownDrainPromise: Promise<void> | null = null;
	private markdownDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMarkdownDirtyAt = 0;
	private boundRecoveryLocks = new Map<string, number>();

	/** Last time a reconciliation completed (for cooldown). */
	private lastReconcileTime = 0;

	/** Timer for delayed reconcile after cooldown expires. */
	private reconcileCooldownTimer: ReturnType<typeof setTimeout> | null = null;

	/** In-memory ring of recent high-level plugin events. */
	private eventRing: Array<{ ts: string; msg: string }> = [];
	private lastReconcileStats: {
		at: string;
		mode: ReconcileMode;
		plannedCreates: number;
		plannedUpdates: number;
		flushedCreates: number;
		flushedUpdates: number;
		safetyBrakeTriggered: boolean;
		safetyBrakeReason: string | null;
	} | null = null;

	/** Persistent trace journal/state writer (active when debug is enabled). */
	private traceLogger: PersistentTraceLogger | null = null;
	private traceStateInterval: ReturnType<typeof setInterval> | null = null;
	private traceStateTimer: ReturnType<typeof setTimeout> | null = null;
	private traceServerInterval: ReturnType<typeof setInterval> | null = null;
	private traceServerInFlight = false;
	private recentServerTrace: unknown[] = [];
	private serverCapabilities: ServerCapabilities | null = null;
	private capabilityRefreshPromise: Promise<void> | null = null;
	private lastCapabilityRefreshAt = 0;
	private updateManifest: UpdateManifest | null = null;
	private updateManifestFetchedAt = 0;
	private updateManifestRefreshPromise: Promise<void> | null = null;
	private lastServerUpdateNoticeVersion: string | null = null;
	private lastPluginUpdateNoticeVersion: string | null = null;
	private compatibilityBlockReason: string | null = null;
	private lastPushedUpdateMetadataFingerprint: string | null = null;
	private legacyServerDetected = false;
	private legacyServerNoticeShown = false;
	private commandsRegistered = false;
	private idbDegradedHandled = false;
	private lastMetadataRaceRejectionAt = 0;
	private frontmatterGuardNoticeFingerprints = new Map<string, string>();
	private frontmatterQuarantineEntries: FrontmatterQuarantineEntry[] = [];

	/**
	 * True when startup timed out waiting for provider sync.
	 * We use this to force one authoritative reconcile on the first late
	 * provider sync event, even if connection generation did not change.
	 */
	private awaitingFirstProviderSyncAfterStartup = false;
	/** Host workspace/layout reached a usable post-boot state. */
	private blobDownloadGateLayoutReady = false;
	/** YAOS startup/reconciliation has completed enough to trust local attachment presence checks. */
	private blobDownloadGateStartupReady = false;

	private isMarkdownPathSyncable(path: string): boolean {
		return isMarkdownSyncable(path, this.excludePatterns, this.app.vault.configDir);
	}

	private isBlobPathSyncable(path: string): boolean {
		return isBlobSyncable(path, this.excludePatterns, this.app.vault.configDir);
	}

	async onload() {
		const onloadStartedAt = Date.now();
		await this.loadSettings();
		this.registerObsidianProtocolHandler("yaos", (params) => {
			void this.handleSetupLink(params);
		});

		let generatedVaultId = false;
		if (!this.settings.vaultId) {
			this.settings.vaultId = generateVaultId();
			await this.saveSettings();
			generatedVaultId = true;
		}

		if (!this.settings.deviceName) {
			this.settings.deviceName = `device-${Date.now().toString(36)}`;
			await this.saveSettings();
		}

		this.setupTraceLogger();
		this.blobDownloadGateLayoutReady = this.app.workspace.layoutReady;
		this.app.workspace.onLayoutReady(() => {
			const firstReady = !this.blobDownloadGateLayoutReady;
			this.blobDownloadGateLayoutReady = true;
			if (firstReady) {
				this.trace("trace", "blob-download-layout-ready", {});
				this.log("Blob download gate: workspace layout ready");
			}
			this.maybeOpenBlobDownloadGate("layout-ready");
		});
		if (generatedVaultId) {
			this.log(`Generated vault ID: ${this.settings.vaultId}`);
		}

		this.addSettingTab(new VaultSyncSettingTab(this.app, this));

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
		this.refreshRuntimeSettings();

		this.applyCursorVisibility();

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
		this.blobDownloadGateStartupReady = false;
		this.trace("trace", "startup-init-sync-start", {
			hostConfigured: !!this.settings.host,
			tokenConfigured: !!this.settings.token,
			hasCachedCapabilities: this.serverCapabilities !== null,
		});
		try {
			this.idbDegradedHandled = false;
			this.excludePatterns = parseExcludePatterns(this.settings.excludePatterns);
			this.maxFileSize = this.settings.maxFileSizeKB * 1024;
			this.applyCursorVisibility();
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
			);
			this.diskMirror.startMapObservers();

			// 4b. BlobSyncManager (if attachment sync is enabled)
			this.startBlobSyncEngine("startup", false);

			// 5. Status tracking
			this.vaultSync.provider.on("status", () => this.refreshStatusBar());
			this.statusInterval = setInterval(() => {
				this.refreshStatusBar();
				if (this.reconciled && this.editorBindings) {
					const touched = this.editorBindings.auditBindings("status-tick");
					if (touched > 0) {
						this.log(`Binding health audit (status-tick) — touched ${touched}`);
						this.scheduleTraceStateSnapshot("binding-audit:status-tick");
					}
				}
				// Periodically persist blob queue if transfers are active,
				// or clear persisted queue if transfers completed
				if (this.blobSync) {
					if (this.blobSync.pendingUploads > 0 || this.blobSync.pendingDownloads > 0) {
						void this.saveBlobQueue();
					} else {
						void this.clearSavedBlobQueue();
					}
				}
				const capabilityState = this.serverCapabilities;
				const waitingForR2 =
					!!this.settings.host &&
					(!capabilityState || !capabilityState.attachments || !capabilityState.snapshots);
				if (waitingForR2 && Date.now() - this.lastCapabilityRefreshAt >= CAPABILITY_REFRESH_INTERVAL_MS) {
					void this.refreshServerCapabilities("background-poll");
				}
			}, 3000);
			this.register(() => {
				if (this.statusInterval) clearInterval(this.statusInterval);
			});

			// 6. Vault events (gated by this.reconciled)
			this.registerVaultEvents();

			// 7. Commands
			if (!this.commandsRegistered) {
				this.registerCommands();
				this.commandsRegistered = true;
			}

			// 8. Rename batch callback → update editor bindings + disk mirror observers + disk index + blob hash cache
			this.vaultSync.onRenameBatchFlushed((renames) => {
				this.editorBindings?.updatePathsAfterRename(renames);

				// Move disk index entries
				moveIndexEntries(this.diskIndex, renames);

				// Move blob hash cache entries
				moveCachedHashes(this.blobHashCache, renames);

				// Move disk mirror observers and openFilePaths tracking
				// for any paths that were open before the rename.
				for (const [oldPath, newPath] of renames) {
					if (this.activeMarkdownPath === oldPath) {
						this.activeMarkdownPath = newPath;
					}
					if (this.openFilePaths.has(oldPath)) {
						this.diskMirror?.notifyFileClosed(oldPath);
						this.openFilePaths.delete(oldPath);
						this.diskMirror?.notifyFileOpened(newPath);
						this.openFilePaths.add(newPath);
						this.log(`Rename batch: moved observer "${oldPath}" -> "${newPath}"`);
					}
				}
			});

			// 9. Reconnection: re-reconcile when provider re-syncs
			this.setupReconnectionHandler();

			// 10. Visibility change: force reconnect on foreground
			this.setupVisibilityHandler();
			this.setupNetworkHandlers();

			// -----------------------------------------------------------
			// STARTUP SEQUENCE
			// -----------------------------------------------------------

			this.updateStatusBar("loading");
			this.log("Waiting for IndexedDB persistence...");
			const localLoaded = await this.vaultSync.waitForLocalPersistence();
			this.log(`IndexedDB: ${localLoaded ? "loaded" : "timed out"}`);

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
				this.bindAllOpenEditors();
				this.validateAllOpenBindings("startup-auth-fallback");
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
			this.lastReconciledGeneration = this.vaultSync.connectionGeneration;
			if (providerSynced) {
				this.awaitingFirstProviderSyncAfterStartup = false;
			}

			this.bindAllOpenEditors();
			this.validateAllOpenBindings("startup");

			this.refreshStatusBar();
			this.trace("trace", "startup-init-sync-complete", {
				durationMs: Date.now() - initSyncStartedAt,
			});
			this.log("Startup complete");
			this.scheduleTraceStateSnapshot("startup-complete");
			this.markBlobDownloadStartupReady("startup-complete");
			void this.refreshServerTrace();

			// Trigger daily snapshot (noop if already taken today).
			// Fire-and-forget — don't block startup on snapshot creation.
			if (providerSynced && this.serverSupportsSnapshots) {
				void this.triggerDailySnapshot();
			}
		} catch (err) {
			console.error("[yaos] Failed to initialize sync:", err);
			new Notice(`YAOS: failed to initialize — ${formatUnknown(err)}`);
			this.updateStatusBar("error");
		}
	}

	// -------------------------------------------------------------------
	// Reconnection
	// -------------------------------------------------------------------

	/**
	 * Listen for provider sync events after initial startup.
	 * When the provider syncs at a new generation (reconnect), trigger
	 * an authoritative re-reconciliation to catch any drift.
	 */
	private setupReconnectionHandler(): void {
		if (!this.vaultSync) return;

		this.vaultSync.onProviderSync((generation) => {
			// Skip the initial sync — that's handled by the startup sequence
			if (!this.reconciled) {
				this.log(`Provider sync ignored: initial startup still running (gen ${generation})`);
				return;
			}

			// If startup timed out waiting for provider sync, the first late
			// sync can arrive on the same connection generation. We still need
			// one authoritative reconcile to import any remote changes.
			if (this.awaitingFirstProviderSyncAfterStartup) {
				this.awaitingFirstProviderSyncAfterStartup = false;
				this.log(`Late first provider sync (gen ${generation}) — scheduling catch-up reconciliation`);
				if (this.reconcileInFlight) {
					this.log("Late first sync arrived during reconcile — marked pending");
					this.reconcilePending = true;
					return;
				}
				void this.runReconnectReconciliation(generation);
				return;
			}

			// Skip if we already reconciled at this generation
			if (generation <= this.lastReconciledGeneration) {
				this.log(
					`Provider sync ignored: generation ${generation} <= lastReconciledGeneration ${this.lastReconciledGeneration}`,
				);
				return;
			}

			this.log(`Reconnect detected (gen ${generation}) — scheduling re-reconciliation`);

			if (this.reconcileInFlight) {
				this.log("Reconnect sync arrived during reconcile — marked pending");
				this.reconcilePending = true;
				return;
			}

			void this.runReconnectReconciliation(generation);
		});
	}

	/**
	 * Lightweight authoritative reconcile after a reconnection.
	 * Fresh disk read to catch any drift during disconnect.
	 */
	private async runReconnectReconciliation(generation: number): Promise<void> {
		if (!this.vaultSync) return;

		this.log(`Running reconnect reconciliation (gen ${generation})`);
		await this.refreshServerCapabilities("provider-sync");
		this.validateAllOpenBindings(`reconnect-pre:${generation}`);

		// Also import any untracked files from a previous conservative run
		if (this.untrackedFiles.length > 0) {
			await this.importUntrackedFiles();
		}

		await this.runReconciliation("authoritative");
		this.lastReconciledGeneration = generation;
		this.awaitingFirstProviderSyncAfterStartup = false;
		this.bindAllOpenEditors();
		this.validateAllOpenBindings(`reconnect-post:${generation}`);

		// If another reconnect arrived during this reconcile, run again
		if (this.reconcilePending) {
			this.reconcilePending = false;
			if (this.vaultSync.connectionGeneration > this.lastReconciledGeneration) {
				void this.runReconnectReconciliation(this.vaultSync.connectionGeneration);
			}
		}
	}

	/**
	 * On visibility change (foreground): if the provider is disconnected,
	 * force a reconnect. Handles Android backgrounding and desktop
	 * sleep/wake where sockets silently die.
	 */
	private setupVisibilityHandler(): void {
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
		}

		this.visibilityHandler = () => {
			if (document.visibilityState === "hidden") {
				void this.diskMirror?.flushOpenWrites("app-backgrounded");
				return;
			}
			if (document.visibilityState !== "visible") return;
			if (!this.vaultSync) return;
			if (this.vaultSync.fatalAuthError) return;

			void this.refreshServerCapabilities("app-foregrounded");
			this.requestFastReconnect("app-foregrounded");
		};

		document.addEventListener("visibilitychange", this.visibilityHandler);
		this.register(() => {
			if (this.visibilityHandler) {
				document.removeEventListener("visibilitychange", this.visibilityHandler);
			}
			});
	}

	private setupNetworkHandlers(): void {
		if (this.onlineHandler) {
			window.removeEventListener("online", this.onlineHandler);
		}
		if (this.offlineHandler) {
			window.removeEventListener("offline", this.offlineHandler);
		}

		this.onlineHandler = () => {
			this.log("Network online event — requesting fast reconnect");
			this.scheduleTraceStateSnapshot("network-online");
			void this.refreshServerCapabilities("network-online");
			this.requestFastReconnect("network-online");
		};

		this.offlineHandler = () => {
			this.log("Network offline event — marking status offline");
			this.scheduleTraceStateSnapshot("network-offline");
			if (this.vaultSync?.fatalAuthError) {
				this.refreshStatusBar();
				return;
			}
			this.updateStatusBar("offline");
		};

		window.addEventListener("online", this.onlineHandler);
		window.addEventListener("offline", this.offlineHandler);
		this.register(() => {
			if (this.onlineHandler) {
				window.removeEventListener("online", this.onlineHandler);
			}
			if (this.offlineHandler) {
				window.removeEventListener("offline", this.offlineHandler);
			}
		});
	}

	private requestFastReconnect(reason: "app-foregrounded" | "network-online"): void {
		if (!this.vaultSync) return;
		if (this.vaultSync.fatalAuthError) {
			this.log(`Fast reconnect skipped (${reason}): fatal auth (${this.vaultSync.fatalAuthCode ?? "unknown"})`);
			return;
		}
		if (this.vaultSync.connected || this.vaultSync.provider.wsconnecting) {
			return;
		}

		const now = Date.now();
		if (now - this.lastFastReconnectAt < FAST_RECONNECT_MIN_INTERVAL_MS) {
			return;
		}

		if (this.fastReconnectDebounceTimer) {
			clearTimeout(this.fastReconnectDebounceTimer);
		}
		this.fastReconnectDebounceTimer = setTimeout(() => {
			this.fastReconnectDebounceTimer = null;

			const sync = this.vaultSync;
			if (!sync) return;
			if (sync.fatalAuthError) return;
			if (sync.connected || sync.provider.wsconnecting) return;

			this.lastFastReconnectAt = Date.now();
			this.log(`Fast reconnect triggered (${reason})`);
			sync.provider.disconnect();

			if (this.fastReconnectConnectTimer) {
				clearTimeout(this.fastReconnectConnectTimer);
			}
			this.fastReconnectConnectTimer = setTimeout(() => {
				this.fastReconnectConnectTimer = null;
				const live = this.vaultSync;
				if (!live || live !== sync) return;
				if (live.fatalAuthError) return;
				if (live.connected || live.provider.wsconnecting) return;
					void live.provider.connect();
			}, FAST_RECONNECT_JITTER_MS);
		}, FAST_RECONNECT_DEBOUNCE_MS);
	}

	// -------------------------------------------------------------------
	// Reconciliation
	// -------------------------------------------------------------------

	private async runReconciliation(mode: ReconcileMode): Promise<void> {
		if (!this.vaultSync || !this.diskMirror) return;
		if (this.reconcileInFlight) {
			this.reconcilePending = true;
			this.log("Reconciliation already in flight — queued");
			return;
		}

		// Cooldown: prevent rapid successive reconciliations (flaky Wi-Fi)
		const now = Date.now();
		const elapsed = now - this.lastReconcileTime;
		if (this.lastReconcileTime > 0 && elapsed < RECONCILE_COOLDOWN_MS) {
			const delay = RECONCILE_COOLDOWN_MS - elapsed;
			this.log(`Reconcile cooldown: ${delay}ms remaining, scheduling delayed run`);
			this.reconcilePending = true;
			if (!this.reconcileCooldownTimer) {
				this.reconcileCooldownTimer = setTimeout(() => {
					this.reconcileCooldownTimer = null;
					if (this.reconcilePending) {
						this.reconcilePending = false;
						const m = this.vaultSync?.getSafeReconcileMode() ?? mode;
						void this.runReconciliation(m);
					}
				}, delay);
			}
			return;
		}

		this.reconcileInFlight = true;

		try {
			const diskFiles = new Map<string, string>();
			const diskPresentPaths = new Set<string>();
			const allMdFiles = this.app.vault.getMarkdownFiles();
			let excludedCount = 0;
			let oversizedCount = 0;
			let skippedByIndex = 0;

			// Filter by exclude patterns first
			const eligibleFiles: TFile[] = [];
			for (const file of allMdFiles) {
				if (!this.isMarkdownPathSyncable(file.path)) {
					excludedCount++;
					continue;
				}
				eligibleFiles.push(file);
				diskPresentPaths.add(file.path);
			}

			// In conservative mode, use disk index optimization.
			// In authoritative mode, read all files for correctness so we can
			// detect and heal any disk<->CRDT drift after reconnect/startup.
			let changed: TFile[] = [];
			let unchanged: TFile[] = [];
			let allStats: Map<string, { mtime: number; size: number }> = new Map();
			if (mode === "authoritative") {
				changed = eligibleFiles;
				allStats = await collectFileStats(this.app, eligibleFiles);
				skippedByIndex = 0;
			} else {
				const indexResult = await filterChangedFiles(
					this.app,
					eligibleFiles,
					this.diskIndex,
				);
				changed = indexResult.changed;
				unchanged = indexResult.unchanged;
				allStats = indexResult.allStats;
				skippedByIndex = unchanged.length;
			}

			// For unchanged files, we still need them in the diskFiles map
			// so reconcileVault knows they exist on disk (for the "disk-only
			// vs CRDT-only" comparison). But we use a sentinel instead of
			// actual content to avoid reading them.
			// We mark them with a special marker and handle them in reconcileVault
			// by checking CRDT existence only (no content comparison needed).
			for (const file of unchanged) {
				// File exists on disk and hasn't changed — just mark presence
				// Use empty string as placeholder; reconcileVault only needs
				// to know the path exists for the "disk-only" check.
				// Content comparison isn't needed because nothing changed.
				const existingText = this.vaultSync.getTextForPath(file.path);
				if (existingText) {
					// Both exist and disk unchanged → skip read entirely
					continue;
				}
				// Disk-only (not in CRDT) but unchanged → need to read for seeding
				try {
					const content = await this.app.vault.read(file);
					if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
						oversizedCount++;
						continue;
					}
					diskFiles.set(file.path, content);
				} catch (err) {
					console.error(
						`[yaos] Failed to read "${file.path}":`,
						err,
					);
				}
			}

			// Read changed files
			for (const file of changed) {
				try {
					const content = await this.app.vault.read(file);
					if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
						oversizedCount++;
						this.log(`reconcile: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
						continue;
					}
					diskFiles.set(file.path, content);
				} catch (err) {
					console.error(
						`[yaos] Failed to read "${file.path}" during reconciliation:`,
						err,
					);
				}
			}

			if (excludedCount > 0) {
				this.log(`reconcile: excluded ${excludedCount} files by pattern`);
			}
			if (oversizedCount > 0) {
				this.log(`reconcile: skipped ${oversizedCount} oversized files`);
				new Notice(`YAOS: skipped ${oversizedCount} files exceeding ${this.settings.maxFileSizeKB} KB size limit.`);
			}
			if (skippedByIndex > 0) {
				this.log(`reconcile: ${skippedByIndex} files unchanged (stat match), ${changed.length} changed`);
			}

				this.log(
					`Reconciling [${mode}]: diskPresent=${diskPresentPaths.size}, ` +
					`diskLoaded=${diskFiles.size} (${changed.length} read) vs ` +
					`${this.vaultSync.getActiveMarkdownPaths().length} CRDT paths`,
				);

			const result = this.vaultSync.reconcileVault(
				diskFiles,
				diskPresentPaths,
				mode,
				this.settings.deviceName,
			);

				// Safety brake: evaluate only destructive disk operations.
				// Creating missing files from CRDT is additive and should not be blocked.
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
					this.log(`Reconcile safety brake: ${safetyBrakeReason}.`);
					console.error(`[yaos] Reconcile safety brake: ${safetyBrakeReason}.`);
					new Notice(
						`YAOS: Reconcile safety brake — ${safetyBrakeReason}. ` +
						`Additive creates will continue. Export diagnostics and inspect logs.`,
					);
				}

				for (const path of result.createdOnDisk) {
					await this.diskMirror.flushWrite(path);
					flushedCreates++;
				}
				if (!safetyBrakeTriggered) {
					for (const path of result.updatedOnDisk) {
						await this.diskMirror.flushWrite(path);
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

			// Update disk index with fresh stats
			this.diskIndex = updateIndex(this.diskIndex, allStats);
			void this.saveDiskIndex();

			// Run integrity checks after reconciliation (orphan GC + duplicate detection)
			const integrity = this.vaultSync.runIntegrityChecks();
			if (integrity.duplicateIds > 0 || integrity.orphansCleaned > 0) {
				this.log(
					`Integrity: ${integrity.duplicateIds} duplicate IDs fixed, ` +
					`${integrity.orphansCleaned} orphans cleaned`,
				);
			}

				this.log(
					`Reconciliation [${mode}] complete: ` +
					`${result.seededToCrdt.length} seeded, ` +
					`creates planned/flushed=${result.createdOnDisk.length}/${flushedCreates}, ` +
					`updates planned/flushed=${result.updatedOnDisk.length}/${flushedUpdates}, ` +
					`${result.untracked.length} untracked, ` +
					`${result.skipped} tombstoned` +
					(safetyBrakeTriggered ? ", safety-brake=on" : ", safety-brake=off"),
				);

			// Blob reconciliation (if enabled)
			if (this.blobSync) {
				const blobResult = this.blobSync.reconcile(
					mode,
					this.excludePatterns,
				);
				this.log(
					`Blob reconciliation [${mode}]: ` +
					`${blobResult.uploadQueued} uploads, ` +
					`${blobResult.downloadQueued} downloads, ` +
					`${blobResult.skipped} skipped`,
				);
			}
		} finally {
			this.reconcileInFlight = false;
			this.lastReconcileTime = Date.now();
			this.scheduleTraceStateSnapshot(`reconcile-${mode}`);
		}
	}

	private async importUntrackedFiles(): Promise<void> {
		if (!this.vaultSync) return;

		const toImport = [...this.untrackedFiles];
		this.untrackedFiles = [];
		let imported = 0;

		for (const path of toImport) {
			if (this.vaultSync.getTextForPath(path)) {
				this.log(`importUntracked: "${path}" now in CRDT, skipping`);
				continue;
			}

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.app.vault.read(file);
				this.vaultSync.ensureFile(path, content, this.settings.deviceName);
				imported++;
			} catch (err) {
				console.error(
					`[yaos] importUntracked failed for "${path}":`,
					err,
				);
			}
		}

		if (!this.vaultSync.isInitialized) {
			this.vaultSync.markInitialized();
		}

		this.refreshStatusBar();
		this.log(`Imported ${imported} previously untracked files`);

		if (imported > 0) {
			new Notice(`YAOS: imported ${imported} files after server sync.`);
		}
	}

	// -------------------------------------------------------------------
	// Editor binding
	// -------------------------------------------------------------------

	private bindAllOpenEditors(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.editorBindings?.bind(leaf.view, this.settings.deviceName);
				if (leaf.view.file) {
					this.trackOpenFile(leaf.view.file.path);
				}
			}
		});
		this.activeMarkdownPath = this.getActiveMarkdownPath();
	}

	private validateAllOpenBindings(reason: string): void {
		let touched = 0;

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) {
				return;
			}

			const binding = this.editorBindings?.getBindingDebugInfoForView(leaf.view) ?? null;
			const health = this.editorBindings?.getBindingHealthForView(leaf.view) ?? null;

			if (health?.bound && (health.healthy || health.settling)) {
				return;
			}

			touched += 1;
			if (!binding || !health?.bound) {
				this.editorBindings?.bind(leaf.view, this.settings.deviceName);
				return;
			}

			const repaired = this.editorBindings?.repair(
				leaf.view,
				this.settings.deviceName,
				`validate:${reason}`,
			) ?? false;
			if (!repaired) {
				this.editorBindings?.rebind(
					leaf.view,
					this.settings.deviceName,
					`validate:${reason}`,
				);
			}
		});

		if (touched > 0) {
			this.log(`Validated open bindings (${reason}) — touched ${touched}`);
			this.scheduleTraceStateSnapshot(`validate-open-bindings:${reason}`);
		}
	}

	/**
	 * Track that a file is open. Notifies diskMirror to start observing.
	 * Also cleans up observers for files that are no longer open in any leaf.
	 */
	private trackOpenFile(path: string): void {
		// Notify disk mirror for the newly opened file
		if (!this.openFilePaths.has(path)) {
			this.diskMirror?.notifyFileOpened(path);
			this.openFilePaths.add(path);
		}

		this.reconcileTrackedOpenFiles("track-open-file");
		this.scheduleTraceStateSnapshot("track-open-file");
	}

	private reconcileTrackedOpenFiles(reason: string): void {
		// Scan all leaves to find which files are actually still open
		const currentlyOpen = new Set<string>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				currentlyOpen.add(leaf.view.file.path);
			}
		});

		// Close observers for files no longer open in any leaf
		for (const tracked of this.openFilePaths) {
			if (!currentlyOpen.has(tracked)) {
				this.diskMirror?.notifyFileClosed(tracked);
				this.openFilePaths.delete(tracked);
				this.log(`${reason}: closed observer for "${tracked}"`);
				this.maybeImportDeferredClosedOnlyPath(tracked, reason);
			}
		}
	}

	private maybeImportDeferredClosedOnlyPath(path: string, reason: string): void {
		if (!this.reconciled) return;
		if (this.settings.externalEditPolicy !== "closed-only") return;
		if (!this.isMarkdownPathSyncable(path)) return;
		if (this.closedOnlyDeferredImports.has(path)) return;
		if (this.getOpenMarkdownViewsForPath(path).length > 0) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		this.closedOnlyDeferredImports.add(path);
		this.trace("trace", "closed-only-deferred-import-queued", {
			path,
			reason,
		});

		void this.processDirtyMarkdownPath(path, "modify")
			.catch((err) => {
				console.error(
					`[yaos] closed-only deferred import failed for "${path}" (${reason}):`,
					err,
				);
			})
			.finally(() => {
				this.closedOnlyDeferredImports.delete(path);
			});
	}

	private getActiveMarkdownPath(): string | null {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path ?? null;
	}

	private updateActiveMarkdownPath(nextPath: string | null, reason: string): void {
		const previousPath = this.activeMarkdownPath;
		this.activeMarkdownPath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		this.editorBindings?.clearLocalCursor(reason);
		void this.diskMirror?.flushOpenPath(previousPath, reason);
	}

	// -------------------------------------------------------------------
	// Vault event handlers
	// -------------------------------------------------------------------

	private registerVaultEvents(): void {
		// Layout change: clean up observers for closed files
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (!this.reconciled) return;
				this.editorBindings?.clearLocalCursor("layout-change");
				this.reconcileTrackedOpenFiles("layout-change");
				this.updateActiveMarkdownPath(
					this.getActiveMarkdownPath(),
					"layout-change-active-blur",
				);
				const touched = this.editorBindings?.auditBindings("layout-change") ?? 0;
				if (touched > 0) {
					this.log(`Binding health audit (layout-change) — touched ${touched}`);
					this.scheduleTraceStateSnapshot("binding-audit:layout-change");
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (!this.reconciled) return;
				const nextPath =
					leaf?.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;
				this.updateActiveMarkdownPath(nextPath, "active-leaf-change");
				this.reconcileTrackedOpenFiles("active-leaf-change");
				if (!leaf) return;
				const view = leaf.view;
				if (view instanceof MarkdownView) {
					this.editorBindings?.bind(view, this.settings.deviceName);
					if (view.file) {
						this.trackOpenFile(view.file.path);
					}
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!this.reconciled) return;
				this.updateActiveMarkdownPath(
					file?.path ?? null,
					"file-open-active-change",
				);
				if (!file) return;
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view && view.file?.path === file.path) {
					this.editorBindings?.bind(view, this.settings.deviceName);
					this.trackOpenFile(file.path);
				}

				// Prefetch embedded attachments for the opened note
				if (file.path.endsWith(".md") && this.blobSync) {
					this.prefetchEmbeddedAttachments(file);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					void this.markMarkdownDirty(file, "modify");
				} else if (this.blobSync && this.isBlobPathSyncable(file.path) && !this.blobSync.isSuppressed(file.path)) {
					this.blobSync.handleFileChange(file);
				}
			}),
		);

		// Rename: use batched queueRename for atomic folder renames.
		// Both markdown and blob files go through the same rename batch
		// since folder renames affect both types atomically.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.reconciled) return;
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
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					if (this.diskMirror?.consumeDeleteSuppression(file.path)) {
						this.log(`Suppressed delete event for "${file.path}"`);
						return;
					}
					this.editorBindings?.unbindByPath(file.path);
					this.diskMirror?.notifyFileClosed(file.path);
					this.openFilePaths.delete(file.path);

					this.vaultSync?.handleDelete(
						file.path,
						this.settings.deviceName,
					);
					this.log(`Delete: "${file.path}"`);
				} else if (this.blobSync && this.isBlobPathSyncable(file.path) && !this.blobSync.isSuppressed(file.path)) {
					this.blobSync.handleFileDelete(file.path, this.settings.deviceName);
					this.log(`Delete (blob): "${file.path}"`);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.reconciled) return;
				if (!(file instanceof TFile)) return;

				if (this.isMarkdownPathSyncable(file.path)) {
					void this.markMarkdownDirty(file, "create");
				} else if (this.isBlobPathSyncable(file.path)) {
					if (this.blobSync && !this.blobSync.isSuppressed(file.path)) {
						// For blob files, use the same stability check before uploading
						if (this.pendingStabilityChecks.has(file.path)) return;
						this.pendingStabilityChecks.add(file.path);

						void waitForDiskQuiet(this.app, file.path).then((stable) => {
							this.pendingStabilityChecks.delete(file.path);
							if (stable) {
								this.blobSync?.handleFileChange(file);
							} else {
								this.log(`Create (blob): "${file.path}" unstable after timeout, skipping`);
							}
						});
					} else if (!this.serverSupportsAttachments && !this.shownAttachmentNudge) {
						this.shownAttachmentNudge = true;
						new Notice(
							"YAOS: This file won't sync yet — attachment sync needs a Cloudflare R2 bucket. Open YAOS settings for a 1-minute setup guide.",
							10000,
						);
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
	private teardownSync(): void {
		this.log("teardownSync: tearing down all sync state");

		this.editorBindings?.unbindAll();
		this.diskMirror?.destroy();

		// Persist blob queue before destroying (crash resilience)
		if (this.blobSync) {
			const snapshot = this.blobSync.exportQueue();
			if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
				// Fire-and-forget — teardown can't be async
				void this.saveBlobQueue();
			}
		}
		this.blobSync?.destroy();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		if (this.reconcileCooldownTimer) {
			clearTimeout(this.reconcileCooldownTimer);
			this.reconcileCooldownTimer = null;
		}
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
			this.markdownDrainTimer = null;
		}
		if (this.fastReconnectDebounceTimer) {
			clearTimeout(this.fastReconnectDebounceTimer);
			this.fastReconnectDebounceTimer = null;
		}
		if (this.fastReconnectConnectTimer) {
			clearTimeout(this.fastReconnectConnectTimer);
			this.fastReconnectConnectTimer = null;
		}

		this.vaultSync?.destroy();

		this.vaultSync = null;
		this.editorBindings = null;
		this.diskMirror = null;
		this.blobSync = null;
		this.shownAttachmentNudge = false;
		this.reconciled = false;
		this.reconcileInFlight = false;
		this.reconcilePending = false;
		this.untrackedFiles = [];
		this.lastReconciledGeneration = 0;
		this.awaitingFirstProviderSyncAfterStartup = false;
		this.openFilePaths.clear();
		this.activeMarkdownPath = null;
		this.dirtyMarkdownPaths.clear();
		this.idbDegradedHandled = false;

		this.updateStatusBar("disconnected");
	}

	// -------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------

	private registerCommands(): void {
		this.addCommand({
			id: "reconnect",
			name: "Reconnect to sync server",
			callback: () => {
					if (this.vaultSync) {
						this.vaultSync.provider.disconnect();
						void this.vaultSync.provider.connect();
						new Notice("Reconnecting...");
					}
				},
			});

			this.addCommand({
				id: "force-reconcile",
				name: "Force reconcile vault with sync state",
				callback: () => {
					if (!this.vaultSync) return;
					const mode = this.vaultSync.getSafeReconcileMode();
				void this.runReconciliation(mode).then(() => {
					this.bindAllOpenEditors();
					this.validateAllOpenBindings("manual-reconcile");
				});
			},
		});

		this.addCommand({
			id: "debug-status",
			name: "Show sync debug info",
			callback: () => {
				const info = this.buildDebugInfo();
				new Notice(info, 10000);
				console.debug("[yaos] Debug status:\n" + info);
			},
		});

		this.addCommand({
			id: "copy-debug",
			name: "Copy debug info to clipboard",
			callback: () => {
				const info = this.buildDebugInfo();
				navigator.clipboard.writeText(info).then(
					() => new Notice("Debug info copied to clipboard."),
					() => new Notice("Failed to copy to clipboard. Check console.", 5000),
				);
				console.debug("[yaos] Debug info:\n" + info);
			},
		});

		this.addCommand({
			id: "show-recent-events",
			name: "Show recent sync events",
			callback: () => {
				const text = this.buildRecentEventsText(80);
				new Notice("Recent sync events printed to console.", 5000);
				console.debug("[yaos] Recent sync events:\n" + text);
			},
		});

		this.addCommand({
			id: "export-diagnostics",
			name: "Export sync diagnostics",
			callback: () => {
				void this.exportDiagnostics();
			},
		});

		this.addCommand({
			id: "migrate-schema-v2",
			name: "Migrate sync schema to v2",
			callback: () => {
				this.runSchemaMigrationToV2();
			},
		});

			this.addCommand({
				id: "debug-vfs-torture-test",
				name: "Run filesystem torture test (debug)",
				checkCallback: (checking: boolean) => {
					if (!this.settings.debug) return false;
					if (!checking) {
					void this.runVfsTortureTest();
				}
				return true;
			},
		});

		this.addCommand({
			id: "import-untracked",
			name: "Import untracked files now",
			callback: () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
				}
				if (this.untrackedFiles.length === 0) {
					new Notice("No untracked files to import.");
					return;
				}
				const count = this.untrackedFiles.length;
				void this.importUntrackedFiles().then(() => {
					new Notice(`Imported ${count} untracked file(s).`);
				});
			},
		});

		this.addCommand({
			id: "reset-cache",
			name: "Reset local cache (re-sync from server)",
			callback: () => {
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

						this.teardownSync();

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
				},
		});

		// --- Snapshot commands ---

		this.addCommand({
			id: "snapshot-now",
			name: "Take snapshot now",
			callback: async () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
					}
					if (!this.serverSupportsSnapshots) {
						new Notice("Snapshots are unavailable until object storage is configured on the server.");
						return;
					}
				if (!this.vaultSync.connected) {
					new Notice("Not connected to server — cannot create snapshot.");
					return;
				}

				new Notice("Creating snapshot...");
				try {
					const result = await requestSnapshotNow(
						this.settings,
						this.settings.deviceName,
						this.getTraceHttpContext(),
					);
					if (result.status === "created" && result.index) {
						new Notice(
							`Snapshot created: ${result.index.markdownFileCount} notes, ` +
							`${result.index.blobFileCount} attachments ` +
							`(${Math.round(result.index.crdtSizeBytes / 1024)} KB)`,
						);
					} else if (result.status === "unavailable") {
						new Notice(`Snapshot unavailable: ${result.reason ?? "R2 not configured"}`);
					} else {
						new Notice("Snapshot created.");
					}
				} catch (err) {
					console.error("[yaos] Snapshot failed:", err);
					new Notice(`Snapshot failed: ${formatUnknown(err)}`);
				}
			},
		});

		this.addCommand({
			id: "snapshot-list",
			name: "Browse and restore snapshots",
			callback: async () => {
				if (!this.vaultSync) {
					new Notice("Sync not initialized");
					return;
					}
					if (!this.serverSupportsSnapshots) {
						new Notice("Snapshots are unavailable until object storage is configured on the server.");
						return;
					}
				if (!this.vaultSync.connected) {
					new Notice("Not connected to server — cannot browse snapshots.");
					return;
				}
				await this.showSnapshotList();
			},
		});

		// --- Reset commands ---

			this.addCommand({
				id: "nuclear-reset",
				name: "Nuclear reset (wipe sync state and reseed from disk)",
				callback: () => {
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

						// Clear CRDT maps BEFORE teardown so the deletions propagate
						// to the server while the provider is still connected.
						const counts = this.vaultSync!.clearAllMaps();
						this.log(
							`Nuclear reset: cleared ${counts.pathCount} paths, ` +
							`${counts.idCount} texts, ${counts.metaCount} meta, ` +
							`${counts.blobCount} blob paths`,
						);

						// Give the provider a moment to sync the deletions to server
						await new Promise((r) => setTimeout(r, 500));

						const vaultId = this.settings.vaultId;
						this.teardownSync();

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
			},
		});
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
		if (!this.blobSync) return;

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
			const queued = this.blobSync.prioritizeDownloads(pathsToFetch);
			if (queued > 0) {
				this.log(`prefetch: queued ${queued} attachments for "${file.path}"`);
			}
		}
	}

	private markMarkdownDirty(file: TFile, reason: "create" | "modify"): void {
		// Coalesce local markdown filesystem bursts by path and only start the
		// drain once the path set has been quiet for a short settle window.
		const previous = this.dirtyMarkdownPaths.get(file.path);
		if (previous !== "create") {
			this.dirtyMarkdownPaths.set(file.path, reason);
		}
		this.lastMarkdownDirtyAt = Date.now();
		this.scheduleMarkdownDrain();
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
				// Enforce a strict trailing-edge quiet window before ingest.
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
		// Process one snapshot batch only. Any new events that arrive while this
		// batch is in flight are handled by the next trailing-edge timer window.
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
		const abstractFile = this.app.vault.getAbstractFileByPath(path);
		if (!(abstractFile instanceof TFile)) {
			this.log(`Markdown ${reason}: "${path}" no longer exists, skipping`);
			return;
		}

		if (reason === "create") {
			if (await this.diskMirror?.shouldSuppressCreate(abstractFile)) {
				this.log(`Suppressed create event for "${path}"`);
				return;
			}

			if (this.vaultSync?.isPendingRenameTarget(path)) {
				this.log(`Create: "${path}" is a pending rename target, skipping import`);
				return;
			}
		} else {
			if (await this.diskMirror?.shouldSuppressModify(abstractFile)) {
				this.log(`Suppressed modify event for "${path}"`);
				return;
			}
		}

		await this.syncFileFromDisk(abstractFile, reason);
	}

	private async syncFileFromDisk(
		file: TFile,
		sourceReason: "create" | "modify" = "modify",
	): Promise<void> {
		if (!this.vaultSync) return;
		if (!this.isMarkdownPathSyncable(file.path)) return;

		let wasBound = this.editorBindings?.isBound(file.path) ?? false;
		const openViews = this.getOpenMarkdownViewsForPath(file.path);
		const isOpenInEditor = openViews.length > 0;
		if (wasBound && !isOpenInEditor) {
			this.trace("trace", "stale-bound-path-without-open-view", {
				path: file.path,
			});
			this.editorBindings?.unbindByPath(file.path);
			this.log(`syncFileFromDisk: cleared stale bound state for "${file.path}" (no live view)`);
			wasBound = false;
		}

		// External edit policy gate: control whether disk changes are
		// imported into the CRDT.
		const policy = this.settings.externalEditPolicy;
		const policyDecision = decideExternalEditImport(policy, isOpenInEditor);
		if (!policyDecision.allowImport) {
			const reason = policyDecision.reason === "policy-never"
				? "external edit policy: never"
				: "external edit policy: closed-only (file is open; deferred)";
			this.log(`syncFileFromDisk: skipping "${file.path}" (${reason})`);
			if (policyDecision.reason === "policy-never") {
				await this.updateDiskIndexForPath(file.path);
			}
			return;
		}

		try {
			const content = await this.app.vault.read(file);

			// File size guard
			if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
				this.log(`syncFileFromDisk: skipping "${file.path}" (${Math.round(content.length / 1024)} KB exceeds limit)`);
				return;
			}
			const existingText = this.vaultSync.getTextForPath(file.path);

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
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent,
					content,
					"disk-to-crdt",
				)) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}

				// Apply a line-level diff to the Y.Text instead of delete-all + insert-all.
				// This preserves CRDT history, cursor positions, and awareness state.
				// Works for both editor-bound files (external edit merges into live editor)
				// and unbound files (background sync).
				this.log(
					`syncFileFromDisk: applying diff to "${file.path}" (${crdtContent.length} -> ${content.length} chars)`,
				);
				applyDiffToYText(existingText, crdtContent, content, "disk-sync");
			} else {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"disk-to-crdt-seed",
				)) {
					await this.updateDiskIndexForPath(file.path);
					return;
				}
				this.vaultSync.ensureFile(
					file.path,
					content,
					this.settings.deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
			}

			await this.updateDiskIndexForPath(file.path);
		} catch (err) {
			console.error(
				`[yaos] syncFileFromDisk failed for "${file.path}":`,
				err,
			);
		}
	}

	private getOpenMarkdownViewsForPath(path: string): MarkdownView[] {
		const views: MarkdownView[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
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
		const now = Date.now();
		const lockUntil = this.boundRecoveryLocks.get(file.path) ?? 0;
		if (lockUntil > now) {
			this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, recovery lock)`);
			return true;
		}
		if (lockUntil > 0) {
			this.boundRecoveryLocks.delete(file.path);
		}

		if (openViews.length === 0) {
			this.trace("trace", "stale-bound-path-without-open-view", {
				path: file.path,
			});
			this.editorBindings?.unbindByPath(file.path);
			this.log(`syncFileFromDisk: cleared stale bound state for "${file.path}" (no live view)`);
			return false;
		}

		const crdtContent = yTextToString(existingText);
		if (crdtContent === content) {
			this.boundRecoveryLocks.delete(file.path);
			this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, crdt-current)`);
			return true;
		}

		const viewStates = openViews.map((view) => {
			const editorContent = view.editor.getValue();
			const binding = this.editorBindings?.getBindingDebugInfoForView(view) ?? null;
			const collab = this.editorBindings?.getCollabDebugInfoForView(view) ?? null;
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
			this.trace("trace", "bound-file-local-only-divergence", {
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
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-local-only-divergence",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound local-only divergence: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
				this.trace("trace", "bound-file-recovery-source-selected", {
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
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-local-only-seed",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound, missing CRDT text: seeding ${content.length} chars)`,
				);
				this.vaultSync?.ensureFile(
					file.path,
					content,
					this.settings.deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);

			for (const state of localOnlyViews) {
				const repaired = this.editorBindings?.repair(
					state.view,
					this.settings.deviceName,
					"bound-file-local-only-divergence",
				) ?? false;
				if (!repaired) {
					this.editorBindings?.rebind(
						state.view,
						this.settings.deviceName,
						"bound-file-local-only-divergence",
					);
				}
			}

			this.scheduleTraceStateSnapshot("bound-file-desync-recovery");
			return true;
		}

		const crdtOnlyViews = viewStates.filter(
			(state) => state.editorMatchesCrdt && !state.editorMatchesDisk,
		);
		if (crdtOnlyViews.length > 0) {
			const lastEditorActivity = this.editorBindings?.getLastEditorActivityForPath(file.path) ?? null;
			const hasRecentEditorActivity = lastEditorActivity != null
				&& (Date.now() - lastEditorActivity) < OPEN_FILE_EXTERNAL_EDIT_IDLE_GRACE_MS;
			if (hasRecentEditorActivity) {
				this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, disk lag)`);
				return true;
			}

			// Active editor is open but idle; treat disk as an external edit
			// and ingest it into CRDT instead of deferring forever.
			if (existingText) {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					crdtContent ?? "",
					content,
					"bound-file-open-idle-disk-recovery",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound external disk edit while idle: ${crdtContent?.length ?? 0} -> ${content.length} chars)`,
				);
				applyDiffToYText(existingText, crdtContent ?? "", content, "disk-sync-open-idle-recover");
			} else {
				if (this.shouldBlockFrontmatterIngest(
					file.path,
					null,
					content,
					"bound-file-open-idle-seed",
				)) {
					this.scheduleTraceStateSnapshot("frontmatter-ingest-blocked");
					return true;
				}
				this.log(
					`syncFileFromDisk: recovering "${file.path}" ` +
					`(editor-bound idle disk edit, missing CRDT text: seeding ${content.length} chars)`,
				);
				this.vaultSync?.ensureFile(
					file.path,
					content,
					this.settings.deviceName,
					{
						reviveTombstone: sourceReason === "create",
						reviveReason: sourceReason === "create" ? "local-create-event" : undefined,
					},
				);
			}
			this.boundRecoveryLocks.set(file.path, Date.now() + BOUND_RECOVERY_LOCK_MS);
			this.scheduleTraceStateSnapshot("bound-file-open-idle-disk-recovery");
			return true;
		}

		this.trace("trace", "bound-file-ambiguous-divergence", {
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
		this.log(`syncFileFromDisk: skipping "${file.path}" (editor-bound, ambiguous divergence)`);
		this.scheduleTraceStateSnapshot("bound-file-ambiguous");
		return true;
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
		this.trace("trace", "frontmatter-quarantined", {
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
		this.trace("trace", "frontmatter-quarantine-cleared", {
			path,
			reason,
		});
		await this.persistPluginState();
	}

	private async updateDiskIndexForPath(path: string): Promise<void> {
		try {
			const stat = await this.app.vault.adapter.stat(path);
			if (stat) {
				this.diskIndex[path] = { mtime: stat.mtime, size: stat.size };
			}
		} catch {
			// Stat failed, index will be stale for this path.
		}
	}

	/**
	 * Toggle remote cursor visibility via a CSS class on the document body.
	 * The actual cursor styles from y-codemirror.next are hidden when the
	 * class is absent; we add it when showRemoteCursors is true.
	 */
	refreshRuntimeSettings(): void {
		this.excludePatterns = parseExcludePatterns(this.settings.excludePatterns);
		this.maxFileSize = this.settings.maxFileSizeKB * 1024;
	}
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

	private getSyncStatusLabel(state: SyncStatus): string {
		const labels: Record<SyncStatus, string> = {
			disconnected: "CRDT: Disconnected",
			loading: "CRDT: Loading cache...",
			syncing: "CRDT: Syncing...",
			connected: "CRDT: Connected",
			offline: "CRDT: Offline",
			error: "CRDT: Error",
			unauthorized: "CRDT: Unauthorized",
		};
		return labels[state];
	}

	private computeSyncStatus(): SyncStatus {
		if (!this.vaultSync) {
			return "disconnected";
		}

		if (this.vaultSync.fatalAuthError) {
			return "unauthorized";
		}

		if (this.vaultSync.idbError) {
			return "error";
		}

		if (!this.reconciled) {
			if (this.vaultSync.connected) {
				return "syncing";
			}
			if (this.vaultSync.localReady) {
				return "loading";
			}
			return "disconnected";
		}

		if (this.vaultSync.connected) {
			return "connected";
		}
		if (this.vaultSync.localReady) {
			return "offline";
		}
		return "disconnected";
	}

	getSettingsStatusSummary(): { state: SyncStatus; label: string } {
		const state = this.computeSyncStatus();
		return {
			state,
			label: this.getSyncStatusLabel(state).replace(/^CRDT:\s*/, ""),
		};
	}

	private updateStatusBar(state: SyncStatus): void {
		if (!this.statusBarEl) return;
		let text = this.getSyncStatusLabel(state);

		// Append blob transfer progress if active
		const transfer = this.blobSync?.transferStatus;
		if (transfer) {
			text += ` (${transfer})`;
		}

		this.statusBarEl.setText(text);
	}

	private setupTraceLogger(): void {
		if (!this.settings.debug) return;

		this.traceLogger = new PersistentTraceLogger(this.app, {
			enabled: this.settings.debug,
			deviceName: this.settings.deviceName || "unknown-device",
			vaultId: this.settings.vaultId || "unknown-vault",
		});
		this.trace(
			"trace",
			"trace-session-start",
			{
				host: this.settings.host,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
			},
		);

		this.traceStateInterval = setInterval(() => {
			this.scheduleTraceStateSnapshot("interval");
		}, 5000);
		this.traceServerInterval = setInterval(() => {
			void this.refreshServerTrace();
		}, 15000);

		const errorHandler = (event: ErrorEvent) => {
			if (this.isIndexedDbRelatedError(event.error ?? event.message)) {
				this.trace("trace", "window-error-indexeddb", {
					message: event.message,
					filename: event.filename,
					lineno: event.lineno,
					colno: event.colno,
				});
				this.handleIndexedDbDegraded("window-error", event.error ?? event.message);
				this.scheduleTraceStateSnapshot("window-error-indexeddb");
				event.preventDefault();
				return;
			}
			this.trace("trace", "window-error", {
				message: event.message,
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			});
			this.traceLogger?.captureCrash("window-error", event.error ?? event.message, {
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			});
			this.scheduleTraceStateSnapshot("window-error");
		};

		const rejectionHandler = (event: PromiseRejectionEvent) => {
			if (this.isIndexedDbRelatedError(event.reason)) {
				this.trace("trace", "unhandled-rejection-indexeddb", {
					reason: String(event.reason),
				});
				this.handleIndexedDbDegraded("unhandled-rejection", event.reason);
				this.scheduleTraceStateSnapshot("unhandled-rejection-indexeddb");
				event.preventDefault();
				return;
			}
			if (this.isObsidianFileMetadataRaceError(event.reason)) {
				const now = Date.now();
				if (now - this.lastMetadataRaceRejectionAt >= 5000) {
					this.lastMetadataRaceRejectionAt = now;
					this.trace("trace", "unhandled-rejection-file-metadata-race", {
						reason: String(event.reason),
					});
					this.scheduleTraceStateSnapshot("unhandled-rejection-file-metadata-race");
				}
				event.preventDefault();
				return;
			}
			this.trace("trace", "unhandled-rejection", {
				reason: String(event.reason),
			});
			this.traceLogger?.captureCrash("unhandled-rejection", event.reason);
			this.scheduleTraceStateSnapshot("unhandled-rejection");
		};

		window.addEventListener("error", errorHandler);
		window.addEventListener("unhandledrejection", rejectionHandler);
		this.register(() => {
			window.removeEventListener("error", errorHandler);
			window.removeEventListener("unhandledrejection", rejectionHandler);
		});

		this.register(() => {
			if (this.traceStateInterval) {
				clearInterval(this.traceStateInterval);
				this.traceStateInterval = null;
			}
			if (this.traceServerInterval) {
				clearInterval(this.traceServerInterval);
				this.traceServerInterval = null;
			}
		});
		this.scheduleTraceStateSnapshot("plugin-load");
	}

	private getTraceHttpContext(): TraceHttpContext | undefined {
		return this.traceLogger?.httpContext;
	}

	private trace(
		source: string,
		msg: string,
		details?: TraceEventDetails,
	): void {
		this.traceLogger?.record(source, msg, details);
	}

	private scheduleTraceStateSnapshot(reason: string): void {
		if (!this.traceLogger?.isEnabled) return;
		if (this.traceStateTimer) clearTimeout(this.traceStateTimer);
		this.traceStateTimer = setTimeout(() => {
			this.traceStateTimer = null;
			void this.writeTraceStateSnapshot(reason);
		}, 250);
	}

	private async writeTraceStateSnapshot(reason: string): Promise<void> {
		if (!this.traceLogger?.isEnabled) return;
		const snapshot = await this.buildTraceStateSnapshot(reason);
		this.traceLogger.updateCurrentState(snapshot);
	}

	private async refreshServerTrace(): Promise<void> {
		if (!this.traceLogger?.isEnabled) return;
		if (!this.settings.host || !this.settings.token || !this.settings.vaultId) return;
		if (this.traceServerInFlight) return;

		this.traceServerInFlight = true;
		try {
			const host = this.settings.host.replace(/\/$/, "");
			const roomId = this.settings.vaultId;
			const url = appendTraceParams(
				`${host}/vault/${encodeURIComponent(roomId)}/debug/recent`,
				this.getTraceHttpContext(),
			);
			const res = await obsidianRequest({
				url,
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.settings.token}`,
				},
			});
			if (res.status !== 200) {
				throw new Error(`server debug fetch failed (${res.status})`);
			}

			const payload = res.json as {
				recent?: unknown[];
				roomId?: unknown;
			};
			if (typeof payload.roomId === "string" && payload.roomId !== roomId) {
				throw new Error(
					`server debug fetch returned mismatched room (${payload.roomId})`,
				);
			}

			this.recentServerTrace = Array.isArray(payload.recent)
				? payload.recent.slice(-120)
				: [];
			this.scheduleTraceStateSnapshot("server-trace-refresh");
			return;
		} catch (err) {
			this.trace("trace", "server-trace-fetch-failed", {
				error: String(err),
			});
		} finally {
			this.traceServerInFlight = false;
		}
	}

	private async buildTraceStateSnapshot(reason: string): Promise<Record<string, unknown>> {
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
				reconciled: this.reconciled,
				reconcileInFlight: this.reconcileInFlight,
				reconcilePending: this.reconcilePending,
				awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: this.lastReconciledGeneration,
				openFileCount: this.openFilePaths.size,
			},
			sync: this.vaultSync?.getDebugSnapshot() ?? null,
			diskMirror: this.diskMirror?.getDebugSnapshot() ?? null,
			blobSync: this.blobSync?.getDebugSnapshot() ?? null,
			openFiles: await this.collectOpenFileTraceState(),
			recentEvents: {
				plugin: this.eventRing.slice(-120),
				sync: this.vaultSync?.getRecentEvents(120) ?? [],
			},
			serverTrace: this.recentServerTrace,
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
		if (this.traceStateTimer) {
			clearTimeout(this.traceStateTimer);
			this.traceStateTimer = null;
		}
		if (this.traceStateInterval) {
			clearInterval(this.traceStateInterval);
			this.traceStateInterval = null;
		}
		if (this.traceServerInterval) {
			clearInterval(this.traceServerInterval);
			this.traceServerInterval = null;
		}
		void this.traceLogger?.shutdown();
		document.body.removeClass("vault-crdt-show-cursors");
		this.teardownSync();
	}

	async loadSettings() {
		const data = (await this.loadData()) as PersistedPluginState | null;
		this.persistedState = { ...(data ?? {}) };
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data as Partial<VaultSyncSettings>,
		);
		let migratedSettings = false;
		if (typeof data?.attachmentSyncExplicitlyConfigured !== "boolean") {
			this.settings.attachmentSyncExplicitlyConfigured = data?.enableAttachmentSync === true;
			if (data?.enableAttachmentSync !== true) {
				this.settings.enableAttachmentSync = true;
			}
			migratedSettings = true;
		}
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
		const cachedCapabilities = readPersistedServerCapabilitiesCache(data?._serverCapabilitiesCache);
		if (this.settings.host && cachedCapabilities?.host === this.settings.host) {
			this.serverCapabilities = cachedCapabilities.capabilities;
		} else {
			this.serverCapabilities = null;
		}
		const cachedUpdateManifest = readPersistedUpdateManifestCache(data?._updateManifestCache);
		if (cachedUpdateManifest) {
			this.updateManifest = cachedUpdateManifest.manifest;
			this.updateManifestFetchedAt = cachedUpdateManifest.fetchedAt;
		} else {
			this.updateManifest = null;
			this.updateManifestFetchedAt = 0;
		}
		this.frontmatterQuarantineEntries = readPersistedFrontmatterQuarantine(data?._frontmatterQuarantine);
		this.refreshPersistedState();
		if (migratedSettings) {
			await this.persistPluginState();
		}
	}

	async saveSettings() {
		await this.persistPluginState();
		void this.syncUpdateMetadataToServer("settings-save");
	}

	get serverAuthMode(): ServerCapabilities["authMode"] | "unknown" {
		return this.serverCapabilities?.authMode ?? "unknown";
	}

	get serverSupportsAttachments(): boolean {
		if (!this.settings.host) return true;
		return this.serverCapabilities?.attachments ?? false;
	}

	get serverSupportsSnapshots(): boolean {
		if (!this.settings.host) return true;
		return this.serverCapabilities?.snapshots ?? false;
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

	private createBlobSyncManager(): BlobSyncManager | null {
		if (!this.vaultSync) return null;
		if (!this.settings.host || !this.settings.token) return null;
		return new BlobSyncManager(
			this.app,
			this.vaultSync,
			{
				host: this.settings.host,
				token: this.settings.token,
				vaultId: this.settings.vaultId,
				maxAttachmentSizeKB: this.settings.maxAttachmentSizeKB,
				attachmentConcurrency: this.settings.attachmentConcurrency,
				debug: this.settings.debug,
				trace: this.getTraceHttpContext(),
			},
			this.blobHashCache,
			(source, msg, details) => this.trace(source, msg, details),
		);
	}

	private startBlobSyncEngine(reason: string, runInitialReconcile: boolean): void {
		if (this.blobSync) return;
		if (!this.settings.enableAttachmentSync || !this.serverSupportsAttachments) return;

		const blobSync = this.createBlobSyncManager();
		if (!blobSync) return;

		this.blobSync = blobSync;
		this.blobSync.startObservers();
		this.log(`Attachment sync engine started (${reason})`);

		// Restore persisted queue from previous session
		if (this.savedBlobQueue) {
			this.blobSync.importQueue(this.savedBlobQueue);
			this.savedBlobQueue = null;
		}

		this.maybeOpenBlobDownloadGate(`engine-start:${reason}`);

		if (runInitialReconcile) {
			try {
				const result = this.blobSync.reconcile("authoritative", this.excludePatterns);
				this.log(
					`Attachment reconcile (${reason}): queued ` +
					`${result.uploadQueued} uploads, ${result.downloadQueued} downloads, ${result.skipped} skipped`,
				);
			} catch (err) {
				this.log(`Attachment reconcile (${reason}) failed: ${formatUnknown(err)}`);
			}
		}
	}

	private async stopBlobSyncEngine(reason: string): Promise<void> {
		if (!this.blobSync) return;
		const snapshot = this.blobSync.exportQueue();
		if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
			await this.saveBlobQueue();
		}
		this.blobSync.destroy();
		this.blobSync = null;
		this.log(`Attachment sync engine stopped (${reason})`);
	}

	private maybeOpenBlobDownloadGate(reason: string): void {
		if (!this.blobSync) return;
		if (this.blobSync.isDownloadGateOpen) return;
		if (!this.blobDownloadGateLayoutReady || !this.blobDownloadGateStartupReady) return;
		this.trace("trace", "blob-download-gate-open", {
			reason,
			pendingDownloads: this.blobSync.pendingDownloads,
		});
		this.blobSync.openDownloadGate(reason);
		this.scheduleTraceStateSnapshot(`blob-download-gate:${reason}`);
	}

	private markBlobDownloadStartupReady(reason: string): void {
		if (this.blobDownloadGateStartupReady) return;
		this.blobDownloadGateStartupReady = true;
		this.trace("trace", "blob-download-startup-ready", { reason });
		this.log(`Blob download gate: startup ready (${reason})`);
		this.maybeOpenBlobDownloadGate(`startup-ready:${reason}`);
	}

	async refreshAttachmentSyncRuntime(reason = "settings-change"): Promise<void> {
		if (!this.vaultSync) return;
		if (this.settings.enableAttachmentSync && this.serverSupportsAttachments) {
			this.startBlobSyncEngine(reason, true);
		} else {
			await this.stopBlobSyncEngine(reason);
		}
		this.refreshStatusBar();
	}

	private getHardCompatibilityBlockReason(): string | null {
		if (!this.serverCapabilities) return null;

		const minPluginVersion = this.serverCapabilities.minPluginVersion;
		if (minPluginVersion && compareSemver(this.manifest.version, minPluginVersion) === -1) {
			return `This server requires YAOS plugin ${minPluginVersion} or newer. Update this plugin before syncing.`;
		}

		const minSchemaVersion = this.serverCapabilities.minSchemaVersion;
		if (minSchemaVersion !== null && SCHEMA_VERSION < minSchemaVersion) {
			return `This server requires schema version ${minSchemaVersion} or newer. Update this plugin before syncing.`;
		}

		const maxSchemaVersion = this.serverCapabilities.maxSchemaVersion;
		if (maxSchemaVersion !== null && SCHEMA_VERSION > maxSchemaVersion) {
			return `This plugin uses schema version ${SCHEMA_VERSION}, but this server supports up to ${maxSchemaVersion}. Update server first.`;
		}

		const minCompatibleServer = this.updateManifest?.minCompatibleServerVersionForPlugin ?? null;
		const latestPluginVersion = this.updateManifest?.latestPluginVersion ?? null;
		const serverVersion = this.serverCapabilities.serverVersion;
		if (!minCompatibleServer || !latestPluginVersion || !serverVersion) {
			return null;
		}

		const pluginVsLatest = compareSemver(this.manifest.version, latestPluginVersion);
		const serverVsRequired = compareSemver(serverVersion, minCompatibleServer);
		if (pluginVsLatest !== null && serverVsRequired !== null && pluginVsLatest >= 0 && serverVsRequired === -1) {
			return `This plugin requires YAOS server ${minCompatibleServer} or newer. Update server first.`;
		}
		return null;
	}

	private enforceCompatibilityGuard(reason: string): boolean {
		const blockReason = this.getHardCompatibilityBlockReason();
		if (!blockReason) {
			if (this.compatibilityBlockReason) {
				this.log(`Compatibility guard cleared (${reason})`);
				this.compatibilityBlockReason = null;
			}
			return false;
		}

		const firstBlock = this.compatibilityBlockReason !== blockReason;
		this.compatibilityBlockReason = blockReason;
		this.log(`Compatibility guard (${reason}): ${blockReason}`);
		if (firstBlock) {
			new Notice(`YAOS: ${blockReason}`, 12000);
		}

		if (this.vaultSync) {
			this.teardownSync();
		}
		this.updateStatusBar("error");
		return true;
	}

	async refreshServerCapabilities(reason = "manual"): Promise<void> {
		if (this.capabilityRefreshPromise) {
			return await this.capabilityRefreshPromise;
		}

		this.capabilityRefreshPromise = this.refreshServerCapabilitiesInner(reason)
			.finally(() => {
				this.capabilityRefreshPromise = null;
			});
		return await this.capabilityRefreshPromise;
	}

	private async refreshServerCapabilitiesInner(reason: string): Promise<void> {
		const startedAt = Date.now();
		this.lastCapabilityRefreshAt = startedAt;
		const previous = this.serverCapabilities;
		this.trace("trace", "capability-refresh-start", {
			reason,
			host: this.settings.host || null,
		});

		if (!this.settings.host) {
			this.legacyServerDetected = false;
			this.serverCapabilities = null;
			await this.handleCapabilityChange(previous, null, reason);
			this.trace("trace", "capability-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "no-host",
			});
			return;
		}

		try {
			this.serverCapabilities = await fetchServerCapabilities(this.settings.host);
			const serverVersion = (this.serverCapabilities as { serverVersion?: unknown } | null)?.serverVersion;
			if (typeof serverVersion === "string" && serverVersion.trim()) {
				this.legacyServerDetected = false;
			} else {
				this.legacyServerDetected = true;
				this.maybeShowLegacyServerNotice();
			}
		} catch (err) {
			const errorText = formatUnknown(err);
			this.log(`Server capability probe failed: ${errorText}`);
			if (errorText.includes("capabilities request failed (404)")) {
				this.legacyServerDetected = true;
				this.maybeShowLegacyServerNotice();
			}
			this.trace("trace", "capability-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "error",
				error: errorText,
			});
			return;
		}

		await this.handleCapabilityChange(previous, this.serverCapabilities, reason);
		this.trace("trace", "capability-refresh-end", {
			reason,
			durationMs: Date.now() - startedAt,
			outcome: "ok",
			claimed: this.serverCapabilities?.claimed ?? null,
			authMode: this.serverCapabilities?.authMode ?? null,
			attachments: this.serverCapabilities?.attachments ?? null,
			snapshots: this.serverCapabilities?.snapshots ?? null,
			serverVersion: this.serverCapabilities?.serverVersion ?? null,
			migrationRequired: this.serverCapabilities?.migrationRequired ?? null,
			updateProvider: this.serverCapabilities?.updateProvider ?? null,
		});
	}

	private async handleCapabilityChange(
		previous: ServerCapabilities | null,
		next: ServerCapabilities | null,
		reason: string,
	): Promise<void> {
		const prevAttachments = previous?.attachments ?? null;
		const prevSnapshots = previous?.snapshots ?? null;
		const nextAttachments = next?.attachments ?? null;
		const nextSnapshots = next?.snapshots ?? null;
		const changed =
			prevAttachments !== nextAttachments ||
			prevSnapshots !== nextSnapshots ||
			previous?.authMode !== next?.authMode ||
			previous?.claimed !== next?.claimed ||
			previous?.serverVersion !== next?.serverVersion ||
			previous?.migrationRequired !== next?.migrationRequired ||
			previous?.updateProvider !== next?.updateProvider ||
				previous?.updateRepoUrl !== next?.updateRepoUrl ||
				previous?.updateRepoBranch !== next?.updateRepoBranch;
		await this.hydrateUpdateMetadataFromCapabilities(`capability-change:${reason}`);
		if (!changed) return;

		this.log(
			`Server capabilities updated (${reason}): ` +
			`claimed=${next?.claimed ?? "unknown"} auth=${next?.authMode ?? "unknown"} ` +
			`attachments=${nextAttachments ?? "unknown"} snapshots=${nextSnapshots ?? "unknown"} ` +
			`serverVersion=${next?.serverVersion ?? "unknown"} migrationRequired=${next?.migrationRequired ?? "unknown"} ` +
			`updateProvider=${next?.updateProvider ?? "unknown"} updateBranch=${next?.updateRepoBranch ?? "unknown"}`,
		);
		void this.persistPluginState();
		this.scheduleTraceStateSnapshot(`capabilities:${reason}`);

		if (this.vaultSync) {
			await this.refreshAttachmentSyncRuntime(`capability-change:${reason}`);
		}

		const gainedR2 = prevAttachments === false && nextAttachments === true;
		const lostR2 = prevAttachments === true && nextAttachments === false;
		if (gainedR2) {
			new Notice(
				this.settings.enableAttachmentSync
					? "YAOS: R2 backend detected. Attachments and snapshots are now available."
					: "YAOS: R2 backend detected. Attachments and snapshots are available if you enable them in settings.",
				7000,
			);
			if (this.vaultSync?.connected && this.vaultSync.providerSynced && this.serverSupportsSnapshots) {
				void this.triggerDailySnapshot();
			}
			} else if (lostR2) {
				new Notice(
					"Object storage is unavailable. Attachment transfers are paused and snapshots are unavailable.",
					7000,
				);
			}
		this.maybeShowUpdateNotices(reason);
		this.enforceCompatibilityGuard(`capability-change:${reason}`);
	}

	private async hydrateUpdateMetadataFromCapabilities(reason: string): Promise<void> {
		const capabilities = this.serverCapabilities;
		if (!capabilities?.updateRepoUrl) return;

		let changed = false;
		if (!this.settings.updateRepoUrl.trim()) {
			this.settings.updateRepoUrl = capabilities.updateRepoUrl;
			changed = true;
		}
		const localBranch = this.settings.updateRepoBranch.trim();
		if ((!localBranch || localBranch === "main")
			&& capabilities.updateRepoBranch
			&& capabilities.updateRepoBranch.trim()
			&& capabilities.updateRepoBranch !== localBranch) {
			this.settings.updateRepoBranch = capabilities.updateRepoBranch;
			changed = true;
		}
		if (!changed) return;

		this.log(`Hydrated update metadata from server (${reason})`);
		await this.persistPluginState();
	}

	async refreshUpdateManifest(reason = "manual", force = false): Promise<void> {
		if (this.updateManifestRefreshPromise) {
			return await this.updateManifestRefreshPromise;
		}

		this.updateManifestRefreshPromise = this.refreshUpdateManifestInner(reason, force)
			.finally(() => {
				this.updateManifestRefreshPromise = null;
			});
		return await this.updateManifestRefreshPromise;
	}

	private async refreshUpdateManifestInner(reason: string, force: boolean): Promise<void> {
		const startedAt = Date.now();
		const cacheAgeMs = startedAt - this.updateManifestFetchedAt;
		if (!force && this.updateManifest && cacheAgeMs >= 0 && cacheAgeMs < UPDATE_MANIFEST_CACHE_MS) {
			this.trace("trace", "update-manifest-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "cached",
				cacheAgeMs,
				latestServerVersion: this.updateManifest.latestServerVersion,
				latestPluginVersion: this.updateManifest.latestPluginVersion,
			});
			this.maybeShowUpdateNotices(`manifest-cache:${reason}`);
			return;
		}

		this.trace("trace", "update-manifest-refresh-start", {
			reason,
			urls: UPDATE_MANIFEST_URLS,
			cacheAgeMs: this.updateManifestFetchedAt > 0 ? cacheAgeMs : null,
		});

		let fetchedFrom: string | null = null;
		try {
			let nextManifest: UpdateManifest | null = null;
			let lastError: unknown = null;
			for (const url of UPDATE_MANIFEST_URLS) {
				try {
					nextManifest = await fetchUpdateManifest(url);
					fetchedFrom = url;
					break;
				} catch (err) {
					lastError = err;
					this.log(`Update manifest fetch failed from ${url}: ${formatUnknown(err)}`);
				}
				}
				if (!nextManifest) {
					throw lastError instanceof Error
						? lastError
						: new Error("all update manifest sources failed");
				}
			this.updateManifest = nextManifest;
			this.updateManifestFetchedAt = Date.now();
			await this.persistPluginState();
			this.trace("trace", "update-manifest-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "ok",
				sourceUrl: fetchedFrom,
				latestServerVersion: this.updateManifest.latestServerVersion,
				latestPluginVersion: this.updateManifest.latestPluginVersion,
			});
		} catch (err) {
			this.log(`Update manifest fetch failed: ${formatUnknown(err)}`);
			this.trace("trace", "update-manifest-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "error",
				error: formatUnknown(err),
			});
			return;
		}

		this.maybeShowUpdateNotices(reason);
		this.enforceCompatibilityGuard(`manifest-refresh:${reason}`);
	}

	private maybeShowUpdateNotices(reason: string): void {
		const updateState = this.getUpdateState();
		if (updateState.serverUpdateAvailable && updateState.latestServerVersion) {
			if (this.lastServerUpdateNoticeVersion !== updateState.latestServerVersion) {
				if (!updateState.updateActionUrl) {
					new Notice(
						`YAOS: server update ${updateState.latestServerVersion} is available. ` +
						"Set your deployment repo URL in YAOS settings to enable 1-click updates.",
						12000,
					);
				} else {
					const actionLabel = updateState.updateActionLabel;
					new Notice(
						updateState.migrationRequired
							? `YAOS: a server migration update (${updateState.latestServerVersion}) is available. Open ${actionLabel} before updating.`
							: `YAOS: a server update (${updateState.latestServerVersion}) is available. Open ${actionLabel} to update when ready.`,
						10000,
					);
				}
				this.lastServerUpdateNoticeVersion = updateState.latestServerVersion;
				this.log(
					`Update notice (${reason}): server ${updateState.serverVersion ?? "unknown"} -> ${updateState.latestServerVersion}`,
				);
			}
		}

		if (updateState.pluginUpdateRecommended && updateState.latestPluginVersion) {
			if (this.lastPluginUpdateNoticeVersion !== updateState.latestPluginVersion) {
				new Notice(
					`YAOS: plugin update recommended (${updateState.latestPluginVersion}). Update this device to stay current with server compatibility guidance.`,
					10000,
				);
				this.lastPluginUpdateNoticeVersion = updateState.latestPluginVersion;
				this.log(
					`Update notice (${reason}): plugin ${this.manifest.version} -> ${updateState.latestPluginVersion}`,
				);
			}
		}
	}

	private inferUpdateProvider(repoUrl: string | null | undefined): "github" | "gitlab" | "unknown" | null {
		if (!repoUrl) return null;
		try {
			const parsed = new URL(repoUrl);
			const host = parsed.hostname.toLowerCase();
			if (host.includes("github.")) return "github";
			if (host.includes("gitlab.")) return "gitlab";
			return "unknown";
		} catch {
			return null;
		}
	}

	private maybeShowLegacyServerNotice(): void {
		if (this.legacyServerNoticeShown) return;
		new Notice(
			"Legacy server detected. Sync continues, but update metadata and 1-click updater features need a newer server.",
			12000,
		);
		this.legacyServerNoticeShown = true;
	}

	getUpdateState(): {
		serverVersion: string | null;
		latestServerVersion: string | null;
		serverUpdateAvailable: boolean;
		pluginVersion: string;
		latestPluginVersion: string | null;
		pluginUpdateRecommended: boolean;
		migrationRequired: boolean;
		updateProvider: ServerCapabilities["updateProvider"] | "unknown";
		updateRepoUrl: string | null;
		updateActionUrl: string | null;
		updateBootstrapUrl: string | null;
		updateActionLabel: string;
		legacyServerDetected: boolean;
		pluginCompatibilityWarning: string | null;
	} {
		const serverVersion = this.serverCapabilities?.serverVersion ?? null;
		const latestServerVersion = this.updateManifest?.latestServerVersion ?? null;
		const serverUpdateAvailable =
			serverVersion !== null &&
			latestServerVersion !== null &&
			compareSemver(serverVersion, latestServerVersion) === -1;

		const latestPluginVersion = this.updateManifest?.latestPluginVersion ?? null;
		const pluginUpdateRecommended =
			latestPluginVersion !== null &&
			compareSemver(this.manifest.version, latestPluginVersion) === -1;

		const effectiveRepoUrl = this.settings.updateRepoUrl.trim() ||
			this.serverCapabilities?.updateRepoUrl ||
			null;
		const effectiveProvider = this.inferUpdateProvider(effectiveRepoUrl) ||
			this.serverCapabilities?.updateProvider ||
			"unknown";

		let pluginCompatibilityWarning: string | null = null;
		const minPluginVersion = this.serverCapabilities?.minPluginVersion ?? null;
		if (minPluginVersion && compareSemver(this.manifest.version, minPluginVersion) === -1) {
			pluginCompatibilityWarning =
				`This server requires YAOS plugin ${minPluginVersion} or newer.`;
		} else {
			const minSchemaVersion = this.serverCapabilities?.minSchemaVersion ?? null;
			const maxSchemaVersion = this.serverCapabilities?.maxSchemaVersion ?? null;
			if (minSchemaVersion !== null && SCHEMA_VERSION < minSchemaVersion) {
				pluginCompatibilityWarning =
					`This server requires schema version ${minSchemaVersion} or newer.`;
			} else if (maxSchemaVersion !== null && SCHEMA_VERSION > maxSchemaVersion) {
				pluginCompatibilityWarning =
					`This plugin uses schema version ${SCHEMA_VERSION}, but the server currently supports up to ${maxSchemaVersion}.`;
			}
		}

		return {
			serverVersion,
			latestServerVersion,
			serverUpdateAvailable,
			pluginVersion: this.manifest.version,
			latestPluginVersion,
			pluginUpdateRecommended,
			migrationRequired: this.updateManifest?.migrationRequired ?? this.serverCapabilities?.migrationRequired ?? false,
			updateProvider: effectiveProvider,
			updateRepoUrl: effectiveRepoUrl,
			updateActionUrl: this.buildServerUpdateUrl(),
			updateBootstrapUrl: this.buildGithubUpdaterBootstrapUrl(),
			updateActionLabel: effectiveRepoUrl
				? effectiveProvider === "gitlab"
					? "your GitLab pipeline"
					: "your GitHub workflow"
				: "YAOS settings",
			legacyServerDetected: this.legacyServerDetected,
			pluginCompatibilityWarning,
		};
	}

	buildServerUpdateUrl(): string | null {
		const repoUrl = this.settings.updateRepoUrl.trim() || this.serverCapabilities?.updateRepoUrl;
		const provider = this.inferUpdateProvider(repoUrl) || this.serverCapabilities?.updateProvider;
		if (!repoUrl || !provider) return null;
		const normalizedRepoUrl = repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
		const branch = this.settings.updateRepoBranch.trim() || this.serverCapabilities?.updateRepoBranch || "main";
		if (provider === "github") {
			return `${normalizedRepoUrl}/actions/workflows/yaos-ops.yml`;
		}
		if (provider === "gitlab") {
			return `${normalizedRepoUrl}/-/pipelines/new?ref=${encodeURIComponent(branch)}`;
		}
		return null;
	}

	buildGithubUpdaterBootstrapUrl(): string | null {
		const repoUrl = this.settings.updateRepoUrl.trim() || this.serverCapabilities?.updateRepoUrl;
		const provider = this.inferUpdateProvider(repoUrl) || this.serverCapabilities?.updateProvider;
		if (!repoUrl || provider !== "github") return null;
		const normalizedRepoUrl = repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
		const branch = encodeURIComponent(
			this.settings.updateRepoBranch.trim() || this.serverCapabilities?.updateRepoBranch || "main",
		);
		const filename = encodeURIComponent(GITHUB_OPS_WORKFLOW_PATH);
		const workflowValue = encodeURIComponent(buildGithubOpsBootstrapWorkflowYaml());
		return `${normalizedRepoUrl}/new/${branch}?filename=${filename}&value=${workflowValue}`;
	}

	private buildUpdateMetadataPayload(): {
		updateProvider: "github" | "gitlab" | "unknown";
		updateRepoUrl: string;
		updateRepoBranch: string | null;
	} | null {
		let updateRepoUrl: string | null = null;
		const rawRepoUrl = this.settings.updateRepoUrl.trim();
		if (rawRepoUrl) {
			try {
				const parsed = new URL(rawRepoUrl);
				if ((parsed.protocol === "https:" || parsed.protocol === "http:")
					&& parsed.pathname.split("/").filter(Boolean).length >= 2) {
					parsed.search = "";
					parsed.hash = "";
					updateRepoUrl = parsed.toString().replace(/\/+$/, "").replace(/\.git$/i, "");
				}
			} catch {
				updateRepoUrl = null;
			}
		}
		if (!updateRepoUrl) {
			return null;
		}
		const updateProvider = this.inferUpdateProvider(updateRepoUrl) ?? "unknown";

		const branch = this.settings.updateRepoBranch.trim();
		const updateRepoBranch = branch.length > 0 ? branch : (this.serverCapabilities?.updateRepoBranch ?? null);
		return {
			updateProvider,
			updateRepoUrl,
			updateRepoBranch,
		};
	}

	private async syncUpdateMetadataToServer(reason: string): Promise<void> {
		const host = this.settings.host.trim().replace(/\/$/, "");
		const token = this.settings.token.trim();
		if (!host || !token) return;

		const payload = this.buildUpdateMetadataPayload();
		if (!payload) {
			return;
		}
		const fingerprint = JSON.stringify(payload);
		if (fingerprint === this.lastPushedUpdateMetadataFingerprint) {
			return;
		}

		try {
			const res = await obsidianRequest({
				url: `${host}/api/update-metadata`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			});
			if (res.status !== 200) {
				this.log(`Update metadata push (${reason}) failed (${res.status})`);
				return;
			}

			const body = res.json as { capabilities?: unknown };
			const nextCapabilities = isServerCapabilities(body?.capabilities) ? body.capabilities : null;
			this.lastPushedUpdateMetadataFingerprint = fingerprint;
			if (!nextCapabilities) {
				return;
			}

			const previous = this.serverCapabilities;
			this.serverCapabilities = nextCapabilities;
			await this.handleCapabilityChange(previous, nextCapabilities, `metadata-sync:${reason}`);
		} catch (err) {
			this.log(`Update metadata push (${reason}) failed: ${formatUnknown(err)}`);
		}
	}

		private async confirmVaultIdSwitch(
			currentVaultId: string,
			incomingVaultId: string,
			localMarkdownCount: number,
		): Promise<boolean> {
			return await new Promise((resolve) => {
				new ConfirmModal(
					this.app,
					"Switch vault ID",
					`This pairing link points to a different vault ID. ` +
					`Current vault ID: ${currentVaultId}. Incoming vault ID: ${incomingVaultId}. ` +
					`This vault currently has ${localMarkdownCount} local markdown files. ` +
					`Switching rooms may pull a different remote state. Continue and switch to the incoming vault ID?`,
				() => resolve(true),
				"Switch vault ID",
				"Keep current vault ID",
				() => resolve(false),
			).open();
		});
	}

		private async handleSetupLink(params: Record<string, string>): Promise<void> {
			const host = typeof params.host === "string" ? params.host.trim() : "";
			const token = typeof params.token === "string" ? params.token.trim() : "";
			const incomingVaultId = typeof params.vaultId === "string" ? params.vaultId.trim() : "";
			if (!host || !token) {
				new Notice("Setup link is missing a host or token.");
				return;
			}
			if (!incomingVaultId) {
				new Notice(
					"Setup link is missing the vault ID. This may create a separate sync room on this device.",
					8000,
				);
			}

		const currentVaultId = this.settings.vaultId?.trim() ?? "";
		if (incomingVaultId && currentVaultId && incomingVaultId !== currentVaultId) {
			const localMarkdownCount = this.app.vault
				.getMarkdownFiles()
				.filter((file) => this.isMarkdownPathSyncable(file.path))
				.length;
			if (localMarkdownCount > 5) {
				const confirmed = await this.confirmVaultIdSwitch(
					currentVaultId,
					incomingVaultId,
					localMarkdownCount,
					);
					if (!confirmed) {
						new Notice("Pairing cancelled. Vault ID unchanged.", 6000);
						return;
					}
				}
		}

		this.settings.host = host.replace(/\/$/, "");
		this.settings.token = token;
		if (incomingVaultId) {
			this.settings.vaultId = incomingVaultId;
		}
		await this.refreshServerCapabilities();
			await this.saveSettings();
			this.excludePatterns = parseExcludePatterns(this.settings.excludePatterns);
			this.maxFileSize = this.settings.maxFileSizeKB * 1024;
			this.applyCursorVisibility();
			new Notice("Server linked. Starting sync...", 6000);

		if (!this.vaultSync) {
			void this.initSync();
			return;
		}

			new Notice("Settings saved. Reload the plugin to reconnect with the new server.", 8000);
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

	private async saveBlobQueue(): Promise<void> {
		if (!this.blobSync) return;
		const snapshot = this.blobSync.exportQueue();
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
			...this.persistedState,
			...this.settings,
			_diskIndex: this.diskIndex,
			_blobHashCache: this.blobHashCache,
		};
		if (this.settings.host && this.serverCapabilities) {
			nextState._serverCapabilitiesCache = {
				host: this.settings.host,
				capabilities: this.serverCapabilities,
			};
		} else {
			delete nextState._serverCapabilitiesCache;
		}
		if (this.updateManifest && this.updateManifestFetchedAt > 0) {
			nextState._updateManifestCache = {
				fetchedAt: this.updateManifestFetchedAt,
				manifest: this.updateManifest,
			};
		} else {
			delete nextState._updateManifestCache;
		}
		if (this.frontmatterQuarantineEntries.length > 0) {
			nextState._frontmatterQuarantine = this.frontmatterQuarantineEntries;
		} else {
			delete nextState._frontmatterQuarantine;
		}
		this.persistedState = nextState;
	}

	private async persistPluginState(
		mutate?: (state: PersistedPluginState) => void,
	): Promise<void> {
		// Serialize all plugin data writes so settings/index/blob queue updates
		// cannot clobber each other with interleaved load/merge/save cycles.
		const write = async () => {
			this.refreshPersistedState();
			mutate?.(this.persistedState);
			await this.saveData({ ...this.persistedState });
		};

		this.persistWriteChain = this.persistWriteChain
			.catch(() => undefined)
			.then(write);
		await this.persistWriteChain;
	}

	private buildDebugInfo(): string {
		if (!this.vaultSync) return "Sync not initialized";
		return [
			`Host: ${this.settings.host || "(not set)"}`,
			`Vault ID: ${this.settings.vaultId || "(not set)"}`,
			`Device: ${this.settings.deviceName || "(unnamed)"}`,
			`Trace ID: ${this.getTraceHttpContext()?.traceId ?? "(disabled)"}`,
			`Boot ID: ${this.getTraceHttpContext()?.bootId ?? "(disabled)"}`,
			`Connected: ${this.vaultSync.connected}`,
			`Local ready: ${this.vaultSync.localReady}`,
			`Provider synced: ${this.vaultSync.providerSynced}`,
			`Initialized (sentinel): ${this.vaultSync.isInitialized}`,
			`Reconcile mode: ${this.vaultSync.getSafeReconcileMode()}`,
			`Reconciled: ${this.reconciled}`,
			`Connection generation: ${this.vaultSync.connectionGeneration}`,
			`Last reconciled gen: ${this.lastReconciledGeneration}`,
				`Fatal auth error: ${this.vaultSync.fatalAuthError}`,
				`Fatal auth code: ${this.vaultSync.fatalAuthCode ?? "(none)"}`,
				`IndexedDB error: ${this.vaultSync.idbError}`,
				`IndexedDB error kind: ${this.vaultSync.idbErrorDetails?.kind ?? "(none)"}`,
				`IndexedDB error phase: ${this.vaultSync.idbErrorDetails?.phase ?? "(none)"}`,
				`IndexedDB error name: ${this.vaultSync.idbErrorDetails?.name ?? "(none)"}`,
				`IndexedDB error message: ${this.vaultSync.idbErrorDetails?.message ?? "(none)"}`,
				`Schema supported/local: ${this.vaultSync.supportedSchemaVersion}/${this.vaultSync.storedSchemaVersion ?? "(unset)"}`,
				`CRDT paths: ${this.vaultSync.getActiveMarkdownPaths().length}`,
				`Blob paths: ${this.vaultSync.pathToBlob.size}`,
			`Untracked files: ${this.untrackedFiles.length}`,
			`Active disk observers: ${this.diskMirror?.activeObserverCount ?? 0}`,
			`External edit policy: ${this.settings.externalEditPolicy}`,
			`Attachment sync: ${this.settings.enableAttachmentSync ? "enabled" : "disabled"}`,
			...(this.blobSync ? [
				`Pending uploads: ${this.blobSync.pendingUploads}`,
				`Pending downloads: ${this.blobSync.pendingDownloads}`,
			] : []),
			`Open files: ${this.openFilePaths.size}`,
			`Server trace events: ${this.recentServerTrace.length}`,
			`Remote cursors: ${this.settings.showRemoteCursors ? "shown" : "hidden"}`,
			...buildFrontmatterQuarantineDebugLines(this.frontmatterQuarantineEntries),
		].join("\n");
	}

	private buildRecentEventsText(limit = 80): string {
		const mainEvents = this.eventRing.slice(-limit).map((e) => `[plugin] ${e.ts} ${e.msg}`);
		const syncEvents = this.vaultSync?.getRecentEvents(limit).map((e) => `[sync]   ${e.ts} ${e.msg}`) ?? [];
		const serverEvents = this.recentServerTrace
			.slice(-limit)
			.map((e) => {
				const entry = e as { ts?: string; event?: string; deviceName?: string; traceId?: string };
				return `[server] ${entry.ts ?? ""} ${entry.event ?? "event"}${entry.deviceName ? ` device=${entry.deviceName}` : ""}${entry.traceId ? ` trace=${entry.traceId}` : ""}`;
			});
		const merged = [...mainEvents, ...syncEvents, ...serverEvents].sort();
		if (merged.length === 0) return "No events recorded yet.";
		return merged.slice(-limit).join("\n");
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

	private async exportDiagnostics(): Promise<void> {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		new Notice("Exporting sync diagnostics...");
		const startedAt = Date.now();

		const diskFiles = this.app.vault.getMarkdownFiles()
			.filter((f) => this.isMarkdownPathSyncable(f.path));

		const crdtPaths = new Set<string>(
			this.vaultSync.getActiveMarkdownPaths().filter((path) =>
				this.isMarkdownPathSyncable(path),
			),
		);

		const diskHashes = new Map<string, { hash: string; length: number }>();
		for (const file of diskFiles) {
			try {
				const content = await this.app.vault.read(file);
				diskHashes.set(file.path, {
					hash: await this.sha256Hex(content),
					length: content.length,
				});
			} catch (err) {
				this.log(`diagnostics: failed to read disk file "${file.path}": ${String(err)}`);
			}
		}

		const crdtHashes = new Map<string, { hash: string; length: number }>();
		for (const path of crdtPaths) {
			const ytext = this.vaultSync.getTextForPath(path);
			if (!ytext) continue;
			const content = ytext.toJSON();
			crdtHashes.set(path, {
				hash: await this.sha256Hex(content),
				length: content.length,
			});
		}

		const allPaths = new Set<string>([
			...Array.from(diskHashes.keys()),
			...Array.from(crdtHashes.keys()),
		]);

		const missingOnDisk: string[] = [];
		const missingInCrdt: string[] = [];
		const hashMismatches: Array<{ path: string; diskHash: string; crdtHash: string; diskLength: number; crdtLength: number }> = [];

		for (const path of allPaths) {
			const disk = diskHashes.get(path);
			const crdt = crdtHashes.get(path);
			if (!disk && crdt) {
				missingOnDisk.push(path);
				continue;
			}
			if (disk && !crdt) {
				missingInCrdt.push(path);
				continue;
			}
			if (disk && crdt && disk.hash !== crdt.hash) {
				hashMismatches.push({
					path,
					diskHash: disk.hash,
					crdtHash: crdt.hash,
					diskLength: disk.length,
					crdtLength: crdt.length,
				});
			}
		}

		const diagnostics = {
			generatedAt: new Date().toISOString(),
			generationMs: Date.now() - startedAt,
			trace: this.getTraceHttpContext() ?? null,
			settings: {
				host: this.settings.host,
				tokenPrefix: this.settings.token ? `${this.settings.token.slice(0, 8)}...` : "",
				vaultId: this.settings.vaultId,
				deviceName: this.settings.deviceName,
				debug: this.settings.debug,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
			},
			state: {
				reconciled: this.reconciled,
				reconcileInFlight: this.reconcileInFlight,
				reconcilePending: this.reconcilePending,
				lastReconcile: this.lastReconcileStats,
				awaitingFirstProviderSyncAfterStartup: this.awaitingFirstProviderSyncAfterStartup,
				lastReconciledGeneration: this.lastReconciledGeneration,
				connected: this.vaultSync.connected,
				providerSynced: this.vaultSync.providerSynced,
				localReady: this.vaultSync.localReady,
				connectionGeneration: this.vaultSync.connectionGeneration,
				fatalAuthError: this.vaultSync.fatalAuthError,
				fatalAuthCode: this.vaultSync.fatalAuthCode,
				fatalAuthDetails: this.vaultSync.fatalAuthDetails,
				idbError: this.vaultSync.idbError,
				idbErrorDetails: this.vaultSync.idbErrorDetails,
				pathToIdCount: this.vaultSync.pathToId.size,
				activePathCount: this.vaultSync.getActiveMarkdownPaths().length,
				blobPathCount: this.vaultSync.pathToBlob.size,
				diskFileCount: diskFiles.length,
				openFileCount: this.openFilePaths.size,
				schema: {
					supportedByClient: this.vaultSync.supportedSchemaVersion,
					storedInDoc: this.vaultSync.storedSchemaVersion,
				},
			},
			hashDiff: {
				missingOnDisk,
				missingInCrdt,
				hashMismatches,
				matchingCount: allPaths.size - missingOnDisk.length - missingInCrdt.length - hashMismatches.length,
				totalCompared: allPaths.size,
			},
			recentEvents: {
				plugin: this.eventRing.slice(-240),
				sync: this.vaultSync.getRecentEvents(240),
			},
			openFiles: await this.collectOpenFileTraceState(),
			diskMirror: this.diskMirror?.getDebugSnapshot() ?? null,
			blobSync: this.blobSync?.getDebugSnapshot() ?? null,
			serverTrace: this.recentServerTrace,
		};

		const diagDir = await this.ensureDiagnosticsDir();

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const fileName = `sync-diagnostics-${stamp}-${this.settings.deviceName || "device"}.json`;
		const outPath = normalizePath(`${diagDir}/${fileName}`);
		await this.app.vault.adapter.write(outPath, JSON.stringify(diagnostics, null, 2));

		this.log(
			`Diagnostics exported: ${outPath} ` +
			`(missingOnDisk=${missingOnDisk.length}, missingInCrdt=${missingInCrdt.length}, mismatches=${hashMismatches.length})`,
		);
		new Notice(`Sync diagnostics exported to ${outPath}`, 10000);
	}

	private runSchemaMigrationToV2(): void {
		if (!this.vaultSync) {
			new Notice("Sync not initialized.");
			return;
		}

			const fromVersion = this.vaultSync.storedSchemaVersion;
			if (fromVersion !== null && fromVersion >= 2) {
				new Notice("This vault is already on schema v2.");
				return;
			}

		new ConfirmModal(
			this.app,
			"Migrate sync schema to v2",
			"This will switch this vault to schema v2 and block older YAOS clients from syncing " +
			"until they are upgraded. YAOS will export diagnostics before and after migration. Continue?",
			async () => {
				if (!this.vaultSync) return;

					try {
						new Notice("Exporting pre-migration diagnostics...", 7000);
						await this.exportDiagnostics();
					} catch (err) {
						this.log(`schema migration: preflight diagnostics export failed: ${String(err)}`);
				}

				const result = this.vaultSync.migrateSchemaToV2(this.settings.deviceName);
				this.log(
					`schema migration result: ${JSON.stringify(result)}`,
				);
				const loserCleanupCount = await this.cleanupMigrationLoserPaths(result.loserPaths);
				if (loserCleanupCount > 0) {
					this.log(`schema migration: removed ${loserCleanupCount} loser-path file(s) from disk`);
				}

				const mode = this.vaultSync.getSafeReconcileMode();
				await this.runReconciliation(mode);
				this.bindAllOpenEditors();
				this.validateAllOpenBindings("schema-migration");

					try {
						new Notice("Exporting post-migration diagnostics...", 7000);
						await this.exportDiagnostics();
					} catch (err) {
						this.log(`schema migration: postflight diagnostics export failed: ${String(err)}`);
				}

				new Notice(
					`YAOS: schema v2 migration complete` +
					(loserCleanupCount > 0 ? ` (${loserCleanupCount} local alias file(s) cleaned).` : ".") +
					" Update YAOS on your other devices before reconnecting them.",
					12000,
				);
			},
		).open();
	}

	private async cleanupMigrationLoserPaths(paths: string[]): Promise<number> {
		if (paths.length === 0) return 0;
		let removed = 0;
		for (const path of paths) {
			const node = this.app.vault.getAbstractFileByPath(path);
			if (!(node instanceof TFile)) continue;
			try {
				await this.app.fileManager.trashFile(node);
				removed++;
			} catch (err) {
				this.log(`schema migration: failed to remove loser path "${path}": ${String(err)}`);
			}
		}
		return removed;
	}

	private async ensureDiagnosticsDir(): Promise<string> {
		const diagDir = normalizePath(`${this.app.vault.configDir}/plugins/yaos/diagnostics`);
		if (!(await this.app.vault.adapter.exists(diagDir))) {
			await this.app.vault.adapter.mkdir(diagDir);
		}
		return diagDir;
	}

	private async runVfsTortureTest(): Promise<void> {
		if (!this.vaultSync) {
			new Notice("Sync not initialized");
			return;
		}

		const startedAt = Date.now();
		const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
		const rootDir = normalizePath(`YAOS QA/vfs-torture-${runId}`);
		const steps: Array<{
			name: string;
			status: "ok" | "error" | "skipped";
			timestamp: string;
			durationMs: number;
			detail: string;
		}> = [];

		const ensureFolder = async (folderPath: string): Promise<void> => {
			const normalized = normalizePath(folderPath);
			if (!normalized) return;
			const segments = normalized.split("/").filter(Boolean);
			let current = "";
			for (const segment of segments) {
				current = current ? `${current}/${segment}` : segment;
				if (!this.app.vault.getAbstractFileByPath(current)) {
					await this.app.vault.createFolder(current);
				}
			}
		};

		const runStep = async (
			name: string,
			fn: () => Promise<string | void>,
		): Promise<void> => {
			const stepStartedAt = Date.now();
			try {
				const detail = (await fn()) ?? "";
				steps.push({
					name,
					status: "ok",
					timestamp: new Date().toISOString(),
					durationMs: Date.now() - stepStartedAt,
					detail,
				});
			} catch (err) {
				const detail = err instanceof Error ? err.stack ?? err.message : String(err);
				steps.push({
					name,
					status: "error",
					timestamp: new Date().toISOString(),
					durationMs: Date.now() - stepStartedAt,
					detail,
				});
				this.log(`VFS torture step failed [${name}]: ${detail}`);
			}
		};

			new Notice("Running filesystem torture test...");
		this.log(`VFS torture: starting run ${runId} in "${rootDir}"`);

		await runStep("Create sandbox folder structure", async () => {
			await ensureFolder(rootDir);
			await ensureFolder(`${rootDir}/rename-source/nested`);
			return `Created sandbox at ${rootDir}`;
		});

		await runStep("Burst edit markdown file", async () => {
			const burstPath = normalizePath(`${rootDir}/burst.md`);
			const burstFile = await this.app.vault.create(
				burstPath,
				"# YAOS burst test\n\nStart of burst edits.",
			);
			for (let i = 1; i <= 10; i++) {
				const current = await this.app.vault.read(burstFile);
				await this.app.vault.modify(
					burstFile,
					`${current}\n- burst edit ${i} @ ${new Date().toISOString()}`,
				);
			}
			return `Applied 10 rapid app-level writes to ${burstPath}`;
		});

		await runStep("Rapid create/rename/edit sequence", async () => {
			const untitledPath = normalizePath(`${rootDir}/Untitled.md`);
			const renamedPath = normalizePath(`${rootDir}/Meeting Notes.md`);
			const untitledFile = await this.app.vault.create(
				untitledPath,
				"# Quick rename flow\n\nseed",
			);
			await this.app.vault.modify(untitledFile, "# Quick rename flow\n\nseed\nline 1");
			await this.app.fileManager.renameFile(untitledFile, renamedPath);
			const renamedFile = this.app.vault.getAbstractFileByPath(renamedPath);
			if (!(renamedFile instanceof TFile)) {
				throw new Error(`Expected renamed file at "${renamedPath}"`);
			}
			const current = await this.app.vault.read(renamedFile);
			await this.app.vault.modify(renamedFile, `${current}\nline 2`);
			return `Renamed ${untitledPath} -> ${renamedPath} and appended a post-rename edit`;
		});

		await runStep("Folder rename cascade with post-rename edit", async () => {
			const sourceFolder = normalizePath(`${rootDir}/rename-source`);
			const destinationFolder = normalizePath(`${rootDir}/rename-destination`);
			const targetPath = normalizePath(`${sourceFolder}/nested/target.md`);
			await this.app.vault.create(targetPath, "# Rename target\n\nbefore rename");

			const sourceNode = this.app.vault.getAbstractFileByPath(sourceFolder);
			if (!sourceNode) {
				throw new Error(`Folder missing: ${sourceFolder}`);
			}
			await this.app.fileManager.renameFile(sourceNode, destinationFolder);

			const movedTargetPath = normalizePath(`${destinationFolder}/nested/target.md`);
			const movedTarget = this.app.vault.getAbstractFileByPath(movedTargetPath);
			if (!(movedTarget instanceof TFile)) {
				throw new Error(`Renamed target missing: ${movedTargetPath}`);
			}
			const current = await this.app.vault.read(movedTarget);
			await this.app.vault.modify(movedTarget, `${current}\npost-rename line`);
			return `Renamed folder ${sourceFolder} -> ${destinationFolder}`;
		});

		await runStep("Delete and recreate same path", async () => {
			const tombstonePath = normalizePath(`${rootDir}/tombstone.md`);
			const file = await this.app.vault.create(
				tombstonePath,
				"# Tombstone test\n\noriginal content",
			);
			await this.app.fileManager.trashFile(file);
			await this.app.vault.create(
				tombstonePath,
				"# Tombstone test\n\nrecreated content",
			);
			return `Deleted and recreated ${tombstonePath}`;
		});

		await runStep("Create 3 MB binary attachment", async () => {
			const blobPath = normalizePath(`${rootDir}/attachment-3mb.bin`);
			const bytes = new Uint8Array(3 * 1024 * 1024);
			for (let i = 0; i < bytes.length; i++) {
				bytes[i] = i % 251;
			}
			await this.app.vault.createBinary(blobPath, bytes.buffer);
			if (!this.settings.enableAttachmentSync) {
				return `Created ${blobPath} (${bytes.length} bytes). Attachment sync is disabled in settings.`;
			}
			return `Created ${blobPath} (${bytes.length} bytes) for attachment sync path`;
		});

		const failures = steps.filter((step) => step.status === "error");
		const report = {
			generatedAt: new Date().toISOString(),
			durationMs: Date.now() - startedAt,
			runId,
			rootDir,
			trace: this.getTraceHttpContext() ?? null,
			settings: {
				host: this.settings.host,
				vaultId: this.settings.vaultId,
				deviceName: this.settings.deviceName,
				enableAttachmentSync: this.settings.enableAttachmentSync,
				externalEditPolicy: this.settings.externalEditPolicy,
				debug: this.settings.debug,
			},
			syncState: {
				connected: this.vaultSync.connected,
				providerSynced: this.vaultSync.providerSynced,
				localReady: this.vaultSync.localReady,
				connectionGeneration: this.vaultSync.connectionGeneration,
				reconciled: this.reconciled,
				openFileCount: this.openFilePaths.size,
				pathToIdCount: this.vaultSync.pathToId.size,
				activePathCount: this.vaultSync.getActiveMarkdownPaths().length,
				pathToBlobCount: this.vaultSync.pathToBlob.size,
				pendingUploads: this.blobSync?.pendingUploads ?? 0,
				pendingDownloads: this.blobSync?.pendingDownloads ?? 0,
			},
			steps,
			recentEvents: {
				plugin: this.eventRing.slice(-120),
				sync: this.vaultSync.getRecentEvents(120),
			},
		};

		const diagDir = await this.ensureDiagnosticsDir();
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const outPath = normalizePath(
			`${diagDir}/vfs-torture-${stamp}-${this.settings.deviceName || "device"}.json`,
		);
		await this.app.vault.adapter.write(outPath, JSON.stringify(report, null, 2));

		if (failures.length > 0) {
			new Notice(
				`YAOS VFS torture run finished with ${failures.length} failed step(s). Report: ${outPath}`,
				12000,
			);
			this.log(
				`VFS torture: completed with ${failures.length} failures. Report=${outPath}`,
			);
			return;
		}

		new Notice(`YAOS VFS torture run completed. Report: ${outPath}`, 10000);
		this.log(`VFS torture: completed successfully. Report=${outPath}`);
	}

	// -------------------------------------------------------------------
	// Snapshot helpers
	// -------------------------------------------------------------------

	/**
	 * Request the daily snapshot from the server.
	 * Called after provider syncs during startup.
	 * Silent noop if R2 isn't configured or snapshot already taken today.
	 */
	private async triggerDailySnapshot(): Promise<void> {
		if (!this.serverSupportsSnapshots) {
			return;
		}

		try {
			const result = await requestDailySnapshot(
				this.settings,
				this.settings.deviceName,
				this.getTraceHttpContext(),
			);
			if (result.status === "created") {
				this.log(`Daily snapshot created: ${result.snapshotId}`);
			} else if (result.status === "noop") {
				this.log(`Daily snapshot: already taken today`);
			} else {
				this.log(`Daily snapshot: ${result.reason ?? "unavailable"}`);
			}
		} catch (err) {
			// Don't spam the user — snapshot failure is non-critical
			console.warn("[yaos] Daily snapshot failed:", err);
		}
	}

	/**
	 * Show a list of available snapshots and let the user pick one to diff/restore.
	 */
	private async showSnapshotList(): Promise<void> {
			if (!this.serverSupportsSnapshots) {
				new Notice("Snapshots are unavailable until object storage is configured on the server.");
				return;
			}

		new Notice("Loading snapshots...");

		try {
			const snapshots = await fetchSnapshotList(
				this.settings,
				this.getTraceHttpContext(),
			);

			if (snapshots.length === 0) {
				new Notice("No snapshots found. Take a snapshot first.");
				return;
			}

			new SnapshotListModal(this.app, snapshots, async (selected) => {
				await this.showSnapshotDiff(selected);
			}).open();
		} catch (err) {
			console.error("[yaos] Failed to list snapshots:", err);
			new Notice(`Failed to list snapshots: ${formatUnknown(err)}`);
		}
	}

	/**
	 * Download a snapshot, compute diff against current CRDT, and show the restore UI.
	 */
	private async showSnapshotDiff(snapshot: SnapshotIndex): Promise<void> {
		if (!this.vaultSync) return;

		new Notice("Downloading snapshot...");

		try {
			const snapshotDoc = await downloadSnapshot(
				this.settings,
				snapshot,
				this.getTraceHttpContext(),
			);
			const diff = diffSnapshot(snapshotDoc, this.vaultSync.ydoc);

			let destroyed = false;
			const cleanup = () => {
				if (!destroyed) {
					destroyed = true;
					snapshotDoc.destroy();
				}
			};

			new SnapshotDiffModal(
				this.app,
				snapshot,
				diff,
				async (markdownPaths, blobPaths) => {
					if (!this.vaultSync) return;

					// --- Pre-restore backup ---
					// Save current content of files we're about to overwrite
					// so the user can recover if the restore goes wrong.
					const backupDir = normalizePath(
						`${this.app.vault.configDir}/plugins/yaos/restore-backups/${new Date().toISOString().replace(/[:.]/g, "-")}`,
					);
					let backedUp = 0;
					for (const path of markdownPaths) {
						try {
							const file = this.app.vault.getAbstractFileByPath(path);
							if (file instanceof TFile) {
								const content = await this.app.vault.read(file);
								const backupPath = `${backupDir}/${path}`;
								// Ensure parent directories exist
								const parentDir = backupPath.substring(0, backupPath.lastIndexOf("/"));
								if (parentDir && !this.app.vault.getAbstractFileByPath(parentDir)) {
									await this.app.vault.createFolder(parentDir);
								}
								await this.app.vault.create(backupPath, content);
								backedUp++;
							}
						} catch (err) {
							// Non-fatal: file might not exist on disk (undelete case)
							this.log(`Backup skipped for "${path}": ${formatUnknown(err)}`);
						}
					}
					if (backedUp > 0) {
						this.log(`Pre-restore backup: ${backedUp} files saved to ${backupDir}`);
					}

					const result = restoreFromSnapshot(snapshotDoc, this.vaultSync.ydoc, {
						markdownPaths,
						blobPaths,
						device: this.settings.deviceName,
					});

					// Flush restored files to disk
					for (const path of markdownPaths) {
						await this.diskMirror?.flushWrite(path, true);
					}

					// Kick blob downloads for restored blob references
					if (blobPaths.length > 0 && this.blobSync) {
						const queued = this.blobSync.prioritizeDownloads(blobPaths);
						if (queued > 0) {
							this.log(`Restore: queued ${queued} blob downloads`);
						}
					}

					// Re-bind editors for restored files
					this.bindAllOpenEditors();
					this.validateAllOpenBindings("snapshot-restore");

					const parts: string[] = [];
					if (result.markdownRestored > 0) parts.push(`${result.markdownRestored} files restored`);
					if (result.markdownUndeleted > 0) parts.push(`${result.markdownUndeleted} files undeleted`);
					if (result.blobsRestored > 0) parts.push(`${result.blobsRestored} attachments restored`);
					if (backedUp > 0) parts.push(`backup in ${backupDir}`);

					const msg = parts.length > 0
						? `Restore complete: ${parts.join(", ")}.`
						: "No changes were applied.";
					new Notice(msg, 8000);
					this.log(`Restore from snapshot ${snapshot.snapshotId}: ${msg}`);

					cleanup();
				},
				cleanup,
			).open();
		} catch (err) {
			console.error("[yaos] Snapshot diff failed:", err);
			new Notice(`Failed to load snapshot: ${formatUnknown(err)}`);
		}
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

		if (this.blobSync) {
			void this.stopBlobSyncEngine("idb-degraded");
		}

		const notice = kind === "quota_exceeded"
			? "YAOS: Device storage is full. Sync durability is degraded and attachment transfers are paused. Free up storage, then restart Obsidian."
			: "YAOS: IndexedDB persistence failed. Sync durability is degraded and attachment transfers are paused.";
		new Notice(notice, 12000);
	}
}

/**
 * Simple confirmation modal with a message and confirm/cancel buttons.
 */
class ConfirmModal extends Modal {
	private title: string;
	private message: string;
	private onConfirm: () => void | Promise<void>;
	private confirmText: string;
	private cancelText: string;
	private onCancel?: () => void | Promise<void>;
	private confirmed = false;

	constructor(
		app: import("obsidian").App,
		title: string,
		message: string,
		onConfirm: () => void | Promise<void>,
		confirmText = "Confirm",
		cancelText = "Cancel",
		onCancel?: () => void | Promise<void>,
	) {
		super(app);
		this.title = title;
		this.message = message;
		this.onConfirm = onConfirm;
		this.confirmText = confirmText;
		this.cancelText = cancelText;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		buttonRow
			.createEl("button", { text: this.cancelText })
			.addEventListener("click", () => this.close());

		const confirmBtn = buttonRow.createEl("button", {
			text: this.confirmText,
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.confirmed = true;
			this.close();
			void this.onConfirm();
		});
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed && this.onCancel) {
			void this.onCancel();
		}
	}
}

/**
 * Modal that lists available snapshots and lets the user pick one.
 */
class SnapshotListModal extends Modal {
	constructor(
		app: import("obsidian").App,
		private snapshots: SnapshotIndex[],
		private onSelect: (snapshot: SnapshotIndex) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("snapshot-list-modal");

		contentEl.createEl("h3", { text: "Available snapshots" });
		contentEl.createEl("p", {
			text: `${this.snapshots.length} snapshot(s) found. Select one to see a diff and restore files.`,
			cls: "setting-item-description",
		});

		const list = contentEl.createDiv({ cls: "snapshot-list" });

		for (const snap of this.snapshots) {
			const item = list.createDiv({ cls: "snapshot-list-item" });

			const date = new Date(snap.createdAt);
			const dateStr = date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});

			const title = item.createEl("div");
			title.createEl("strong", { text: dateStr });
			if (snap.triggeredBy) {
				title.createEl("span", {
					text: ` (${snap.triggeredBy})`,
					cls: "setting-item-description",
				});
			}

			item.createEl("div", {
				text: `${snap.markdownFileCount} notes, ${snap.blobFileCount} attachments ` +
					`(${Math.round(snap.crdtSizeBytes / 1024)} KB)`,
				cls: "setting-item-description",
			});

			item.addEventListener("click", () => {
				this.close();
				void this.onSelect(snap);
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Modal that shows a diff between a snapshot and the current CRDT state.
 * Lets the user select files to restore.
 */
class SnapshotDiffModal extends Modal {
	private selectedMd = new Set<string>();
	private selectedBlobs = new Set<string>();
	/** Set to true when restore is initiated — prevents cleanup from running twice. */
	private didRestore = false;

	constructor(
		app: import("obsidian").App,
		private snapshot: SnapshotIndex,
		private diff: SnapshotDiff,
		private onRestore: (markdownPaths: string[], blobPaths: string[]) => void | Promise<void>,
		private cleanup: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("snapshot-diff-modal");

		const date = new Date(this.snapshot.createdAt);
		const dateStr = date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		contentEl.createEl("h3", { text: `Snapshot: ${dateStr}` });

		const { diff } = this;
		const totalChanges = diff.deletedSinceSnapshot.length +
			diff.contentChanged.length +
			diff.blobsDeletedSinceSnapshot.length +
			diff.blobsChanged.length;

		if (totalChanges === 0 && diff.createdSinceSnapshot.length === 0) {
			contentEl.createEl("p", { text: "No differences found between the snapshot and current state." });
			return;
		}

		contentEl.createEl("p", {
			text: "Select files to restore from the snapshot. " +
				"Created-since-snapshot files are shown for reference but cannot be \"restored\" (they didn't exist yet).",
			cls: "setting-item-description",
		});

		// --- Deleted since snapshot (can restore = undelete) ---
		if (diff.deletedSinceSnapshot.length > 0) {
			this.renderSection(
				contentEl,
				"Deleted since snapshot (can undelete)",
				diff.deletedSinceSnapshot.map((d) => d.path),
				this.selectedMd,
			);
		}

		// --- Content changed (can restore to snapshot version) ---
		if (diff.contentChanged.length > 0) {
			this.renderSection(
				contentEl,
				"Content changed since snapshot",
				diff.contentChanged.map((d) => d.path),
				this.selectedMd,
			);
		}

		// --- Created since snapshot (informational only) ---
		if (diff.createdSinceSnapshot.length > 0) {
			const section = contentEl.createDiv();
			section.createEl("h4", { text: `Created since snapshot (${diff.createdSinceSnapshot.length})` });
			const listEl = section.createEl("ul");
			for (const path of diff.createdSinceSnapshot) {
				listEl.createEl("li", { text: path, cls: "setting-item-description" });
			}
		}

		// --- Blob changes ---
		if (diff.blobsDeletedSinceSnapshot.length > 0) {
			this.renderSection(
				contentEl,
				"Attachments deleted since snapshot",
				diff.blobsDeletedSinceSnapshot.map((d) => d.path),
				this.selectedBlobs,
			);
		}

		if (diff.blobsChanged.length > 0) {
			this.renderSection(
				contentEl,
				"Attachments changed since snapshot",
				diff.blobsChanged.map((d) => d.path),
				this.selectedBlobs,
			);
		}

		// --- Unchanged summary ---
		if (diff.unchanged.length > 0) {
			contentEl.createEl("p", {
				text: `${diff.unchanged.length} file(s) unchanged.`,
				cls: "setting-item-description",
			});
		}

		// --- Restore button ---
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container snapshot-diff-actions" });

		buttonRow
			.createEl("button", { text: "Cancel" })
			.addEventListener("click", () => this.close());

		const restoreBtn = buttonRow.createEl("button", {
			text: "Restore selected",
			cls: "mod-cta",
		});
		restoreBtn.addEventListener("click", () => {
			const mdPaths = Array.from(this.selectedMd);
			const blobPaths = Array.from(this.selectedBlobs);

			if (mdPaths.length === 0 && blobPaths.length === 0) {
				new Notice("No files selected for restore.");
				return;
			}

			this.didRestore = true;
			this.close();
			void this.onRestore(mdPaths, blobPaths);
		});
	}

	private renderSection(
		container: HTMLElement,
		title: string,
		paths: string[],
		selectedSet: Set<string>,
	): void {
		const section = container.createDiv({ cls: "snapshot-diff-section" });
		section.createEl("h4", { text: `${title} (${paths.length})` });

		// Select all toggle
		const toggleRow = section.createDiv({ cls: "snapshot-diff-select-all-row" });
		const selectAll = toggleRow.createEl("a", { text: "Select all", href: "#" });
		selectAll.addEventListener("click", (e) => {
			e.preventDefault();
			for (const p of paths) selectedSet.add(p);
			// Re-check all checkboxes in this section
			section.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach(
				(cb) => { cb.checked = true; },
			);
		});

		for (const path of paths) {
			const row = section.createDiv({ cls: "snapshot-diff-path-row" });
			const label = row.createEl("label", { cls: "snapshot-diff-path-label" });
			const cb = label.createEl("input", {
				type: "checkbox",
				cls: "snapshot-diff-path-checkbox",
			});
			label.appendText(path);

			cb.addEventListener("change", () => {
				if (cb.checked) {
					selectedSet.add(path);
				} else {
					selectedSet.delete(path);
				}
			});
		}
	}

	onClose() {
		this.contentEl.empty();
		// Always clean up the snapshot doc unless restore already handled it.
		if (!this.didRestore) {
			this.cleanup();
		}
	}
}
