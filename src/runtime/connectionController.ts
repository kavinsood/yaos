import type { VaultSync } from "../sync/vaultSync";
import type { TraceRecord } from "../observability/traceContext";
import { deriveSyncFacts, type SyncFacts } from "./connectionFacts";
import type { FatalAuthCode } from "../sync/fatalAuth";

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
		this.deps.getVaultSync()?.setReconnectRequester((reason) => this.requestFastReconnect(reason));
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

		if (!this.deps.isReconciled()) {
			return sync.connected
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
				this.deps.flushOpenWrites("app-backgrounded");
				return;
			}
			if (document.visibilityState !== "visible") return;
			this.deps.setResidencyVisibility?.("foreground");
			const sync = this.deps.getVaultSync();
			if (!sync) return;
			if (sync.fatalAuthError) return;

			this.deps.refreshServerCapabilities("app-foregrounded");
			this.requestFastReconnect("app-foregrounded");
		};

		document.addEventListener("visibilitychange", this.visibilityHandler);
		this.deps.setResidencyVisibility?.(
			document.visibilityState === "hidden" ? "background" : "foreground",
		);
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

	private requestFastReconnect(reason: string): void {
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
		const credentialMaintenance = reason === "ticket-refresh-due" || reason.startsWith("retry:");
		if (!credentialMaintenance && (sync.connected || sync.provider.wsconnecting)) {
			return;
		}

		this.deps.log(`Fast reconnect queued (${reason})`);
		void sync.queueReconnect(
			reason,
			FAST_RECONNECT_DEBOUNCE_MS,
		).catch((error) => this.deps.log(`Fast reconnect scheduling failed (${reason}): ${String(error)}`));
	}
}
