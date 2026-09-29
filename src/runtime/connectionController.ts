import type { VaultSync } from "../sync/vaultSync";
import type { TraceRecord } from "../observability/traceContext";
import { deriveSyncFacts, type SyncFacts } from "./connectionFacts";
import type { FatalAuthCode } from "../sync/fatalAuth";
import { isDetachedProviderRepairReason } from "../sync/vaultWorkScheduler";

export type OfflineReason =
	| "provider_disconnected"
	| "network_offline"
	| "local_cache_not_ready";

export interface ConnectionStartupFailure {
	phase: "schema" | "initialization";
	message: string;
}

export type ConnectionState =
	| { kind: "disconnected" }
	| { kind: "loading_cache" }
	| { kind: "connecting" }
	| { kind: "online"; generation: number }
	| { kind: "offline"; reason: OfflineReason; generation: number }
	| { kind: "auth_failed"; code: Exclude<FatalAuthCode, "update_required"> }
	| { kind: "server_update_required"; details: VaultSync["fatalAuthDetails"] }
	| { kind: "local_persistence_failed"; details: VaultSync["idbErrorDetails"] }
	| { kind: "error"; details?: ConnectionStartupFailure };

/**
 * Holds startup failures outside the live provider-derived state. Status ticks
 * can continue to derive current facts without erasing a terminal startup
 * result; only a fresh attempt or explicit recovery clears the latch.
 */
export class ConnectionStateLatch {
	private terminalState: Extract<ConnectionState, { kind: "error" }> | null = null;

	beginInitialization(): void {
		this.terminalState = null;
	}

	failInitialization(details: ConnectionStartupFailure): void {
		this.terminalState = { kind: "error", details };
	}

	recover(): void {
		this.terminalState = null;
	}

	resolve(liveState: ConnectionState): ConnectionState {
		return this.terminalState ?? liveState;
	}
}

const FAST_RECONNECT_DEBOUNCE_MS = 1_000;

interface ConnectionControllerDeps {
	getVaultSync(): VaultSync | null;
	getAttachmentStatus?(): {
		pendingPublications: number;
		reconciliationPending: boolean;
		permanentTransferFailures: number;
		fatalPublications: number;
	};
	isReconciled(): boolean;
	getAwaitingFirstProviderSyncAfterStartup(): boolean;
	setAwaitingFirstProviderSyncAfterStartup(value: boolean): void;
	getLastReconciledGeneration(): number;
	setReconnectPending(): void;
	isReconcileInFlight(): boolean;
	runReconnectReconciliation(generation: number): void;
	/**
	 * Every root (re)sync after startup: durable commits made while this
	 * device was disconnected (or whose notices it never received) are only
	 * discoverable through the change feed, independent of the reconciled
	 * generation, which feed catch-up itself advances.
	 */
	onRootResync?(generation: number): void;
	refreshServerCapabilities(reason: string): void;
	flushOpenWrites(reason: string): void;
	updateOfflineStatus(): void;
	refreshStatusBar(): void;
	scheduleTraceStateSnapshot(reason: string): void;
	log(message: string): void;
	trace: TraceRecord;
	registerCleanup(cleanup: () => void): void;
	setResidencyVisibility?(visibility: "foreground" | "background"): void;
	/**
	 * Optional QA reconnect blocker. When provided and returns true, all
	 * reconnect paths (manual, visibility, network-online) are blocked.
	 * Only wired in QA product builds (__YAOS_QA_HARNESS_ENABLED__=true in main.ts).
	 * Production builds never provide this callback — it does not exist in main.js.
	 */
	isReconnectBlocked?(): boolean;
}

export class ConnectionController {
	private visibilityHandler: (() => void) | null = null;
	private onlineHandler: (() => void) | null = null;
	private offlineHandler: (() => void) | null = null;

	constructor(private readonly deps: ConnectionControllerDeps) {}

	start(): void {
		this.deps.getVaultSync()?.setReconnectRequester((reason, delayMs) => this.requestFastReconnect(reason, delayMs));
		this.deps.getVaultSync()?.setReconnectBlocked(() => this.deps.isReconnectBlocked?.() ?? false);
		this.setupProviderStatusHandler();
		this.setupReconnectionHandler();
		this.setupVisibilityHandler();
		this.setupNetworkHandlers();
	}

	stop(): void {
		this.deps.getVaultSync()?.setReconnectRequester(null);
		this.deps.getVaultSync()?.setReconnectBlocked(null);
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			this.visibilityHandler = null;
		}
		if (this.onlineHandler) {
			window.removeEventListener("online", this.onlineHandler);
			this.onlineHandler = null;
		}
		if (this.offlineHandler) {
			window.removeEventListener("offline", this.offlineHandler);
			this.offlineHandler = null;
		}
	}

	reconnect(reason: string): void {
		const sync = this.deps.getVaultSync();
		if (!sync) return;
		if (sync.fatalAuthError) {
			this.deps.log(`Reconnect skipped (${reason}): fatal auth (${sync.fatalAuthCode ?? "unknown"})`);
			return;
		}
		if (this.deps.isReconnectBlocked?.()) {
			this.deps.log(`Reconnect blocked (${reason}): QA offline hold is active`);
			return;
		}
		void sync.reconnect(reason);
	}

	getSyncFacts(blobPendingUploads = 0): SyncFacts {
		const sync = this.deps.getVaultSync();
		const state = this.getState();
		const attachmentStatus = this.deps.getAttachmentStatus?.() ?? {
			pendingPublications: Math.max(
				0,
				(sync?.pendingAttachmentOperations ?? 0) - (sync?.fatalAttachmentPublications ?? 0),
			),
			reconciliationPending: false,
			permanentTransferFailures: 0,
			fatalPublications: sync?.fatalAttachmentPublications ?? 0,
		};
		return deriveSyncFacts(
			{
				connected: sync?.connected ?? false,
				websocketOpen: sync?.websocketOpen ?? false,
				applicationResponsive: sync?.applicationResponsive ?? null,
				lastLivenessAckAt: sync?.lastLivenessAckAt ?? null,
				fatalAuthError: sync?.fatalAuthError ?? false,
				fatalAuthCode: sync?.fatalAuthCode ?? null,
				lastLocalUpdateAt: sync?.lastLocalUpdateAt ?? null,
				lastLocalUpdateWhileConnectedAt: sync?.lastLocalUpdateWhileConnectedAt ?? null,
				lastRemoteUpdateAt: sync?.lastRemoteUpdateAt ?? null,
				pendingBlobUploads: blobPendingUploads,
				pendingAttachmentPublications: attachmentStatus.pendingPublications,
				attachmentReconciliationPending: attachmentStatus.reconciliationPending,
				permanentAttachmentTransferFailures: attachmentStatus.permanentTransferFailures,
				fatalAttachmentPublications: attachmentStatus.fatalPublications,
				serverReceipt: sync?.getServerReceiptSnapshot() ?? null,
			},
			state.kind,
		);
	}

	getState(): ConnectionState {
		const sync = this.deps.getVaultSync();
		if (!sync) {
			return { kind: "disconnected" };
		}

		if (sync.idbError) {
			return {
				kind: "local_persistence_failed",
				details: sync.idbErrorDetails,
			};
		}

		if (sync.fatalAuthError) {
			const fatalAuthCode = sync.fatalAuthCode;
			if (fatalAuthCode === "update_required") {
				return {
					kind: "server_update_required",
					details: sync.fatalAuthDetails,
				};
			}
			return {
				kind: "auth_failed",
				code: fatalAuthCode ?? "unauthorized",
			};
		}

		if (!sync.localReady) {
			return { kind: "loading_cache" };
		}

		const transportConnecting = sync.provider.wsconnecting
			|| (sync.websocketOpen && sync.applicationResponsive === null);

		if (!this.deps.isReconciled()) {
			return sync.connected || transportConnecting
				? { kind: "connecting" }
				: {
					kind: "offline",
					reason: "provider_disconnected",
					generation: sync.connectionGeneration,
				};
		}

		if (sync.connected) {
			return {
				kind: "online",
				generation: sync.connectionGeneration,
			};
		}

		if (transportConnecting) {
			return { kind: "connecting" };
		}

		return {
			kind: "offline",
			reason: "provider_disconnected",
			generation: sync.connectionGeneration,
		};
	}

	private setupProviderStatusHandler(): void {
		const sync = this.deps.getVaultSync();
		if (!sync) return;
		sync.provider.on("status", () => this.deps.refreshStatusBar());
	}

	/**
	 * Listen for provider sync events after initial startup.
	 * When the provider syncs at a new generation, trigger an authoritative
	 * re-reconciliation to catch drift.
	 */
	private setupReconnectionHandler(): void {
		const sync = this.deps.getVaultSync();
		if (!sync) return;

		sync.onProviderSync((generation) => {
			if (!this.deps.isReconciled()) {
				this.deps.log(`Provider sync ignored: initial startup still running (gen ${generation})`);
				return;
			}
			this.deps.onRootResync?.(generation);

			if (this.deps.getAwaitingFirstProviderSyncAfterStartup()) {
				this.deps.setAwaitingFirstProviderSyncAfterStartup(false);
				this.deps.log(`Late first provider sync (gen ${generation}) — scheduling catch-up reconciliation`);
				if (this.deps.isReconcileInFlight()) {
					this.deps.log("Late first sync arrived during reconcile — marked pending");
					this.deps.setReconnectPending();
					return;
				}
				this.deps.runReconnectReconciliation(generation);
				return;
			}

			if (generation <= this.deps.getLastReconciledGeneration()) {
				this.deps.log(
					`Provider sync ignored: generation ${generation} <= lastReconciledGeneration ${this.deps.getLastReconciledGeneration()}`,
				);
				return;
			}

			this.deps.log(`Reconnect detected (gen ${generation}) — scheduling re-reconciliation`);

			if (this.deps.isReconcileInFlight()) {
				this.deps.log("Reconnect sync arrived during reconcile — marked pending");
				this.deps.setReconnectPending();
				return;
			}

			this.deps.runReconnectReconciliation(generation);
		});
	}

	private setupVisibilityHandler(): void {
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
		}

		this.visibilityHandler = () => {
			if (document.visibilityState === "hidden") {
				this.deps.setResidencyVisibility?.("background");
				this.deps.getVaultSync()?.setSocketLivenessForeground(false);
				this.deps.flushOpenWrites("app-backgrounded");
				return;
			}
			if (document.visibilityState !== "visible") return;
			this.deps.setResidencyVisibility?.("foreground");
			const sync = this.deps.getVaultSync();
			if (!sync) return;
			if (sync.fatalAuthError) return;
			sync.setSocketLivenessForeground(true);
			sync.probeSocketLiveness("app-foregrounded");

			this.deps.refreshServerCapabilities("app-foregrounded");
			this.requestFastReconnect("app-foregrounded");
		};

		document.addEventListener("visibilitychange", this.visibilityHandler);
		this.deps.setResidencyVisibility?.(
			document.visibilityState === "hidden" ? "background" : "foreground",
		);
		this.deps.getVaultSync()?.setSocketLivenessForeground(document.visibilityState !== "hidden");
		this.deps.registerCleanup(() => {
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
			this.deps.log("Network online event — requesting fast reconnect");
			this.deps.scheduleTraceStateSnapshot("network-online");
			this.deps.refreshServerCapabilities("network-online");
			this.deps.getVaultSync()?.probeSocketLiveness("network-online");
			this.requestFastReconnect("network-online");
		};

		this.offlineHandler = () => {
			this.deps.log("Network offline event — marking status offline");
			this.deps.scheduleTraceStateSnapshot("network-offline");
			if (this.deps.getVaultSync()?.fatalAuthError) {
				this.deps.refreshStatusBar();
				return;
			}
			this.deps.updateOfflineStatus();
		};

		window.addEventListener("online", this.onlineHandler);
		window.addEventListener("offline", this.offlineHandler);
		this.deps.registerCleanup(() => {
			if (this.onlineHandler) {
				window.removeEventListener("online", this.onlineHandler);
			}
			if (this.offlineHandler) {
				window.removeEventListener("offline", this.offlineHandler);
			}
		});
	}

	private requestFastReconnect(reason: string, delayMs = FAST_RECONNECT_DEBOUNCE_MS): void {
		const sync = this.deps.getVaultSync();
		if (!sync) return;
		if (sync.fatalAuthError) {
			this.deps.log(`Fast reconnect skipped (${reason}): fatal auth (${sync.fatalAuthCode ?? "unknown"})`);
			return;
		}
		if (this.deps.isReconnectBlocked?.()) {
			this.deps.log(`Fast reconnect blocked (${reason}): QA offline hold is active`);
			return;
		}
		sync.pokeOverdueWork(reason);
		// A connected root only makes root-level reconnects redundant. Retries
		// and body repairs must still be queued: VaultSync repairs only the
		// detached providers for them and leaves an open root alone.
		const passesConnectedRoot = reason.startsWith("retry:") || isDetachedProviderRepairReason(reason);
		if (!passesConnectedRoot && (sync.connected || sync.provider.wsconnecting)) {
			return;
		}

		this.deps.log(`Fast reconnect queued (${reason}${delayMs === FAST_RECONNECT_DEBOUNCE_MS ? "" : `, ${delayMs} ms`})`);
		void sync.queueReconnect(
			reason,
			delayMs,
		).catch((error) => this.deps.log(`Fast reconnect scheduling failed (${reason}): ${String(error)}`));
	}
}
