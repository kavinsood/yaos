import { VaultSync } from "../sync/vaultSync";
import type { TraceRecord } from "../debug/trace";

export type OfflineReason =
	| "provider_disconnected"
	| "network_offline"
	| "local_cache_not_ready";

export type ConnectionState =
	| { kind: "disconnected" }
	| { kind: "loading_cache" }
	| { kind: "connecting" }
	| { kind: "online"; generation: number }
	| { kind: "offline"; reason: OfflineReason; generation: number }
	| { kind: "auth_failed"; code: "unauthorized" | "server_misconfigured" | "unclaimed" }
	| { kind: "server_update_required"; details: VaultSync["fatalAuthDetails"] };

type FastReconnectReason = "app-foregrounded" | "network-online";

const FAST_RECONNECT_DEBOUNCE_MS = 1_000;
const FAST_RECONNECT_JITTER_MS = 500;
const FAST_RECONNECT_MIN_INTERVAL_MS = 2_000;

interface ConnectionControllerDeps {
	getVaultSync(): VaultSync | null;
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
}

export class ConnectionController {
	private visibilityHandler: (() => void) | null = null;
	private onlineHandler: (() => void) | null = null;
	private offlineHandler: (() => void) | null = null;
	private fastReconnectDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private fastReconnectConnectTimer: ReturnType<typeof setTimeout> | null = null;
	private lastFastReconnectAt = 0;

	constructor(private readonly deps: ConnectionControllerDeps) {}

	start(): void {
		this.setupProviderStatusHandler();
		this.setupReconnectionHandler();
		this.setupVisibilityHandler();
		this.setupNetworkHandlers();
	}

	stop(): void {
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
		if (this.fastReconnectDebounceTimer) {
			clearTimeout(this.fastReconnectDebounceTimer);
			this.fastReconnectDebounceTimer = null;
		}
		if (this.fastReconnectConnectTimer) {
			clearTimeout(this.fastReconnectConnectTimer);
			this.fastReconnectConnectTimer = null;
		}
	}

	reconnect(reason: string): void {
		const sync = this.deps.getVaultSync();
		if (!sync) return;
		if (sync.fatalAuthError) {
			this.deps.log(`Reconnect skipped (${reason}): fatal auth (${sync.fatalAuthCode ?? "unknown"})`);
			return;
		}
		sync.provider.disconnect();
		void sync.provider.connect();
	}

	getState(): ConnectionState {
		const sync = this.deps.getVaultSync();
		if (!sync) {
			return { kind: "disconnected" };
		}

		if (sync.fatalAuthError) {
			if (sync.fatalAuthCode === "update_required") {
				return {
					kind: "server_update_required",
					details: sync.fatalAuthDetails,
				};
			}
			return {
				kind: "auth_failed",
				code: sync.fatalAuthCode ?? "unauthorized",
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
				this.deps.flushOpenWrites("app-backgrounded");
				return;
			}
			if (document.visibilityState !== "visible") return;
			const sync = this.deps.getVaultSync();
			if (!sync) return;
			if (sync.fatalAuthError) return;

			this.deps.refreshServerCapabilities("app-foregrounded");
			this.requestFastReconnect("app-foregrounded");
		};

		document.addEventListener("visibilitychange", this.visibilityHandler);
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

	private requestFastReconnect(reason: FastReconnectReason): void {
		const sync = this.deps.getVaultSync();
		if (!sync) return;
		if (sync.fatalAuthError) {
			this.deps.log(`Fast reconnect skipped (${reason}): fatal auth (${sync.fatalAuthCode ?? "unknown"})`);
			return;
		}
		if (sync.connected || sync.provider.wsconnecting) {
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

			const liveSync = this.deps.getVaultSync();
			if (!liveSync || liveSync !== sync) return;
			if (liveSync.fatalAuthError) return;
			if (liveSync.connected || liveSync.provider.wsconnecting) return;

			this.lastFastReconnectAt = Date.now();
			this.deps.log(`Fast reconnect triggered (${reason})`);
			liveSync.provider.disconnect();

			if (this.fastReconnectConnectTimer) {
				clearTimeout(this.fastReconnectConnectTimer);
			}
			this.fastReconnectConnectTimer = setTimeout(() => {
				this.fastReconnectConnectTimer = null;
				const currentSync = this.deps.getVaultSync();
				if (!currentSync || currentSync !== sync) return;
				if (currentSync.fatalAuthError) return;
				if (currentSync.connected || currentSync.provider.wsconnecting) return;
				void currentSync.provider.connect();
			}, FAST_RECONNECT_JITTER_MS);
		}, FAST_RECONNECT_DEBOUNCE_MS);
	}
}
