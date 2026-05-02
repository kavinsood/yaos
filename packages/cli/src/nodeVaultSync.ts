import WebSocket from "ws";

import * as Y from "yjs";
import type { VaultSyncSettings } from "../../../src/settings";
import {
	VaultSync,
	type ReconcileMode,
	type ReconcileResult,
	type VaultSyncOptions,
	type VaultSyncPersistence,
} from "../../../src/sync/vaultSync";
import { HeadlessCliError } from "./errors";
import { NodeDiskMirror } from "./nodeDiskMirror";
import type { RuntimeCliConfig } from "./config";
import {
	loadStateUpdate,
	persistStateUpdate,
	type LoadedStateUpdate,
	type StatePersistenceMetadata,
} from "./statePersistence";

interface CreateNodeVaultSyncOptions extends Omit<VaultSyncOptions, "persistenceFactory"> {
	initialStateUpdate?: Uint8Array | null;
}

export interface HeadlessStartupResult {
	localLoaded: boolean;
	providerSynced: boolean;
	mode: ReconcileMode;
	reconcileResult: ReconcileResult;
}

export function createNodeVaultSync(
	config: RuntimeCliConfig,
	options?: CreateNodeVaultSyncOptions,
): VaultSync {
	const { initialStateUpdate, ...vaultSyncOptions } = options ?? {};
	return new VaultSync(toVaultSyncSettings(config), {
		...vaultSyncOptions,
		webSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
		persistenceFactory: (_name, doc) => createHeadlessPersistence(doc, initialStateUpdate),
		logPersistenceOpenError: false,
	});
}

export class HeadlessYaosClient {
	readonly vaultSync: VaultSync;
	readonly diskMirror: NodeDiskMirror;
	private readonly loadedState: LoadedStateUpdate;
	private lastPersistedState: StatePersistenceMetadata | null = null;
	private reconcileInFlight = false;
	private reconcilePending = false;
	private awaitingFirstProviderSyncAfterStartup = false;
	private startupInitialized = false;
	private lastReconciledGeneration = 0;
	private reconnectionHandlerInstalled = false;
	private stopped = false;

	constructor(private readonly config: RuntimeCliConfig) {
		this.loadedState = loadStateUpdate(config.dir, { host: config.host, vaultId: config.vaultId });
		this.vaultSync = createNodeVaultSync(config, {
			initialStateUpdate: this.loadedState.update,
		});
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
			throw new HeadlessCliError(formatFatalAuthError(this.vaultSync), this.vaultSync.fatalAuthCode);
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
		try {
			await this.diskMirror.stop();
			if (this.startupInitialized) {
				await this.persistState();
			}
		} finally {
			this.vaultSync.destroy();
		}
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
			statePersistence: this.getStatePersistenceStatus(),
		};
	}

	getStatePersistenceStatus(): Record<string, unknown> {
		return {
			loaded: this.loadedState.loaded,
			path: this.loadedState.updatePath,
			byteLength: this.loadedState.byteLength,
			stateVectorHash: this.loadedState.stateVectorHash,
			lastPersisted: this.lastPersistedState,
		};
	}

	private async persistState(): Promise<void> {
		if (!this.canPersistState()) return;
		this.lastPersistedState = await persistStateUpdate(this.config.dir, this.vaultSync.ydoc, {
			host: this.config.host,
			vaultId: this.config.vaultId,
			schemaVersion: this.vaultSync.storedSchemaVersion,
			activePathCount: this.vaultSync.getActiveMarkdownPaths().length,
		});
	}

	private canPersistState(): boolean {
		if (this.vaultSync.providerSynced) return true;
		return this.loadedState.loaded && this.vaultSync.isInitialized;
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
			await this.persistState();
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

function createHeadlessPersistence(
	doc: Y.Doc,
	initialStateUpdate: Uint8Array | null | undefined,
): VaultSyncPersistence {
	const loaded = initialStateUpdate != null && initialStateUpdate.byteLength > 0;
	if (loaded) {
		Y.applyUpdate(doc, initialStateUpdate);
	}
	return {
		once(_event, listener) {
			queueMicrotask(listener);
		},
		destroy() {
			return;
		},
		_db: Promise.resolve({
			addEventListener() {
				return;
			},
		}),
	};
}

function formatFatalAuthError(vaultSync: VaultSync): string {
	return `Provider rejected the connection (${vaultSync.fatalAuthCode ?? "unknown"})`;
}
