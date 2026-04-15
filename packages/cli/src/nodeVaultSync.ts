import WebSocket from "ws";

import type { VaultSyncSettings } from "../../../src/settings";
import {
	VaultSync,
	type ReconcileMode,
	type ReconcileResult,
	type VaultSyncOptions,
	type VaultSyncPersistence,
} from "../../../src/sync/vaultSync";
import { NodeDiskMirror } from "./nodeDiskMirror";
import type { ResolvedCliConfig, RuntimeCliConfig } from "./config";

const NOOP_INDEXEDDB_ERROR = new Error("IndexedDB is unavailable in the headless Node runtime");

export interface HeadlessStartupResult {
	localLoaded: boolean;
	providerSynced: boolean;
	mode: ReconcileMode;
	reconcileResult: ReconcileResult;
}

export function createNodeVaultSync(
	config: RuntimeCliConfig,
	options?: Omit<VaultSyncOptions, "persistenceFactory">,
): VaultSync {
	return new VaultSync(toVaultSyncSettings(config), {
		...options,
webSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
		persistenceFactory: () => createNoopPersistence(),
		logPersistenceOpenError: false,
	});
}

export class HeadlessYaosClient {
	readonly vaultSync: VaultSync;
	readonly diskMirror: NodeDiskMirror;
	private reconcileInFlight = false;
	private reconcilePending = false;
	private awaitingFirstProviderSyncAfterStartup = false;
	private startupInitialized = false;
	private lastReconciledGeneration = 0;
	private reconnectionHandlerInstalled = false;
	private stopped = false;

	constructor(private readonly config: RuntimeCliConfig) {
		this.vaultSync = createNodeVaultSync(config);
		this.diskMirror = new NodeDiskMirror(this.vaultSync, {
			rootDir: config.dir,
			deviceName: config.deviceName,
			debug: config.debug,
			excludePatterns: config.excludePatterns
				.split(",")
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
			maxFileSizeKB: config.maxFileSizeKB,
			externalEditPolicy: config.externalEditPolicy,
			frontmatterGuardEnabled: config.frontmatterGuardEnabled,
			configDir: config.configDir,
		});
	}

	async startup(options: { watch: boolean }): Promise<HeadlessStartupResult> {
		if (options.watch) {
			// Install reconnection handler before any async waits so that
			// late provider sync events are never missed between timeouts
			// and handler installation.
			this.installReconnectionHandler();
		}

		const localLoaded = await this.vaultSync.waitForLocalPersistence();
		const providerSynced = await this.vaultSync.waitForProviderSync();
		if (this.vaultSync.fatalAuthError) {
			throw new Error(formatFatalAuthError(this.vaultSync));
		}

		const mode = this.vaultSync.getSafeReconcileMode();

		// Start CRDT observers before reconciliation so that remote edits
		// arriving while we scan disk are immediately mirrored to disk.
		// Safe because observers filter out local origins (ORIGIN_SEED).
		if (options.watch) {
			this.diskMirror.startMapObservers();
		}

		this.reconcileInFlight = true;
		let reconcileResult: ReconcileResult;
		try {
			reconcileResult = await this.diskMirror.reconcileFromDisk(mode);
		} finally {
			this.reconcileInFlight = false;
		}
		this.lastReconciledGeneration = this.vaultSync.connectionGeneration;
		this.awaitingFirstProviderSyncAfterStartup = !providerSynced;
		this.startupInitialized = true;

		// Drain any deferred reconciliation that was requested during startup.
		if (this.reconcilePending && !this.stopped) {
			this.reconcilePending = false;
			if (this.vaultSync.connectionGeneration > this.lastReconciledGeneration) {
				void this.runReconnectReconciliation(this.vaultSync.connectionGeneration);
			}
		}

		if (options.watch) {
			await this.diskMirror.startWatching();
		}

		return {
			localLoaded,
			providerSynced,
			mode,
			reconcileResult,
		};
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.diskMirror.stop();
		this.vaultSync.destroy();
	}

	getStatus(): Record<string, unknown> {
		return {
			host: this.config.host,
			vaultId: this.config.vaultId,
			deviceName: this.config.deviceName,
			connected: this.vaultSync.connected,
			localReady: this.vaultSync.localReady,
			connectionGeneration: this.vaultSync.connectionGeneration,
			storedSchemaVersion: this.vaultSync.storedSchemaVersion,
			safeReconcileMode: this.vaultSync.getSafeReconcileMode(),
			fatalAuthError: this.vaultSync.fatalAuthError,
			fatalAuthCode: this.vaultSync.fatalAuthCode,
			diskMirror: this.diskMirror.getDebugSnapshot(),
		};
	}

	private installReconnectionHandler(): void {
		if (this.reconnectionHandlerInstalled) return;
		this.reconnectionHandlerInstalled = true;
		this.vaultSync.onProviderSync((generation) => {
			if (this.stopped) return;
			if (!this.startupInitialized) {
				// Defer until startup has initialized its state.
				this.reconcilePending = true;
				return;
			}
			if (this.awaitingFirstProviderSyncAfterStartup) {
				this.awaitingFirstProviderSyncAfterStartup = false;
				if (this.reconcileInFlight) {
					this.reconcilePending = true;
					return;
				}
				void this.runReconnectReconciliation(generation);
				return;
			}
			if (generation <= this.lastReconciledGeneration) {
				return;
			}
			if (this.reconcileInFlight) {
				this.reconcilePending = true;
				return;
			}
			void this.runReconnectReconciliation(generation);
		});
	}

	private async runReconnectReconciliation(generation: number): Promise<void> {
		if (this.stopped) return;
		this.reconcileInFlight = true;
		try {
			await this.diskMirror.reconcileFromDisk("authoritative");
			this.lastReconciledGeneration = generation;
			this.awaitingFirstProviderSyncAfterStartup = false;
		} finally {
			this.reconcileInFlight = false;
			if (!this.reconcilePending || this.stopped) return;
			this.reconcilePending = false;
			if (this.vaultSync.connectionGeneration > this.lastReconciledGeneration) {
				void this.runReconnectReconciliation(this.vaultSync.connectionGeneration);
			}
		}
	}
}

function toVaultSyncSettings(config: RuntimeCliConfig): VaultSyncSettings {
	return {
		host: config.host,
		token: config.token,
		vaultId: config.vaultId,
		deviceName: config.deviceName,
		debug: config.debug,
		frontmatterGuardEnabled: config.frontmatterGuardEnabled,
		excludePatterns: config.excludePatterns,
		maxFileSizeKB: config.maxFileSizeKB,
		externalEditPolicy: config.externalEditPolicy,
		enableAttachmentSync: false,
		attachmentSyncExplicitlyConfigured: true,
		maxAttachmentSizeKB: 0,
		attachmentConcurrency: 1,
		showRemoteCursors: false,
		updateRepoUrl: "",
		updateRepoBranch: "main",
	};
}

function createNoopPersistence(): VaultSyncPersistence {
	const db = Promise.reject(NOOP_INDEXEDDB_ERROR);
	db.catch(() => undefined);
	return {
		once() {
			// Headless v1 intentionally skips local CRDT persistence.
		},
		destroy() {
			return;
		},
		_db: db,
	};
}

function formatFatalAuthError(vaultSync: VaultSync): string {
	return `Provider rejected the connection (${vaultSync.fatalAuthCode ?? "unknown"})`;
}
