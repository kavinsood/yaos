import { type App } from "obsidian";
import {
	appendTraceParams,
	PersistentTraceLogger,
	type TraceEventDetails,
	type TraceHttpContext,
} from "../debug/trace";
import type { VaultSyncSettings } from "../settings";
import { obsidianRequest } from "../utils/http";

interface TraceRuntimeDeps {
	app: App;
	getSettings(): VaultSyncSettings;
	buildSnapshot(reason: string, recentServerTrace: unknown[]): Promise<Record<string, unknown>>;
	isIndexedDbRelatedError(err: unknown): boolean;
	isObsidianFileMetadataRaceError(err: unknown): boolean;
	handleIndexedDbDegraded(source: string, err?: unknown): void;
	registerCleanup(cleanup: () => void): void;
}

export class TraceRuntimeController {
	private logger: PersistentTraceLogger | null = null;
	private stateInterval: ReturnType<typeof setInterval> | null = null;
	private stateTimer: ReturnType<typeof setTimeout> | null = null;
	private serverInterval: ReturnType<typeof setInterval> | null = null;
	private serverInFlight = false;
	private recentServerTrace: unknown[] = [];
	private lastMetadataRaceRejectionAt = 0;

	constructor(private readonly deps: TraceRuntimeDeps) {}

	get httpContext(): TraceHttpContext | undefined {
		return this.logger?.httpContext;
	}

	getRecentServerTrace(): unknown[] {
		return this.recentServerTrace;
	}

	start(): void {
		const settings = this.deps.getSettings();
		if (!settings.debug) return;

		this.logger = new PersistentTraceLogger(this.deps.app, {
			enabled: settings.debug,
			deviceName: settings.deviceName || "unknown-device",
			vaultId: settings.vaultId || "unknown-vault",
		});
		this.record("trace", "trace-session-start", {
			host: settings.host,
			enableAttachmentSync: settings.enableAttachmentSync,
			externalEditPolicy: settings.externalEditPolicy,
		});

		this.stateInterval = setInterval(() => {
			this.scheduleSnapshot("interval");
		}, 5000);
		this.serverInterval = setInterval(() => {
			void this.fetchServerTrace();
		}, 15000);

		const errorHandler = (event: ErrorEvent): void => {
			if (this.deps.isIndexedDbRelatedError(event.error ?? event.message)) {
				this.record("trace", "window-error-indexeddb", {
					message: event.message,
					filename: event.filename,
					lineno: event.lineno,
					colno: event.colno,
				});
				this.deps.handleIndexedDbDegraded("window-error", event.error ?? event.message);
				this.scheduleSnapshot("window-error-indexeddb");
				event.preventDefault();
				return;
			}
			this.record("trace", "window-error", {
				message: event.message,
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			});
			this.logger?.captureCrash("window-error", event.error ?? event.message, {
				filename: event.filename,
				lineno: event.lineno,
				colno: event.colno,
			});
			this.scheduleSnapshot("window-error");
		};

		const rejectionHandler = (event: PromiseRejectionEvent): void => {
			if (this.deps.isIndexedDbRelatedError(event.reason)) {
				this.record("trace", "unhandled-rejection-indexeddb", {
					reason: String(event.reason),
				});
				this.deps.handleIndexedDbDegraded("unhandled-rejection", event.reason);
				this.scheduleSnapshot("unhandled-rejection-indexeddb");
				event.preventDefault();
				return;
			}
			if (this.deps.isObsidianFileMetadataRaceError(event.reason)) {
				const now = Date.now();
				if (now - this.lastMetadataRaceRejectionAt >= 5000) {
					this.lastMetadataRaceRejectionAt = now;
					this.record("trace", "unhandled-rejection-file-metadata-race", {
						reason: String(event.reason),
					});
					this.scheduleSnapshot("unhandled-rejection-file-metadata-race");
				}
				event.preventDefault();
				return;
			}
			this.record("trace", "unhandled-rejection", {
				reason: String(event.reason),
			});
			this.logger?.captureCrash("unhandled-rejection", event.reason);
			this.scheduleSnapshot("unhandled-rejection");
		};

		window.addEventListener("error", errorHandler);
		window.addEventListener("unhandledrejection", rejectionHandler);
		this.deps.registerCleanup(() => {
			window.removeEventListener("error", errorHandler);
			window.removeEventListener("unhandledrejection", rejectionHandler);
			void this.shutdown();
		});
		this.scheduleSnapshot("plugin-load");
	}

	record(source: string, msg: string, details?: TraceEventDetails): void {
		this.logger?.record(source, msg, details);
	}

	scheduleSnapshot(reason: string): void {
		if (!this.logger?.isEnabled) return;
		if (this.stateTimer) clearTimeout(this.stateTimer);
		this.stateTimer = setTimeout(() => {
			this.stateTimer = null;
			void this.writeSnapshot(reason);
		}, 250);
	}

	async refreshServerTrace(): Promise<void> {
		await this.fetchServerTrace();
	}

	async shutdown(): Promise<void> {
		if (this.stateTimer) {
			clearTimeout(this.stateTimer);
			this.stateTimer = null;
		}
		if (this.stateInterval) {
			clearInterval(this.stateInterval);
			this.stateInterval = null;
		}
		if (this.serverInterval) {
			clearInterval(this.serverInterval);
			this.serverInterval = null;
		}
		await this.logger?.shutdown();
		this.logger = null;
	}

	private async writeSnapshot(reason: string): Promise<void> {
		if (!this.logger?.isEnabled) return;
		const snapshot = await this.deps.buildSnapshot(reason, this.recentServerTrace);
		this.logger.updateCurrentState(snapshot);
	}

	private async fetchServerTrace(): Promise<void> {
		if (!this.logger?.isEnabled) return;
		const settings = this.deps.getSettings();
		if (!settings.host || !settings.token || !settings.vaultId) return;
		if (this.serverInFlight) return;

		this.serverInFlight = true;
		try {
			const host = settings.host.replace(/\/$/, "");
			const roomId = settings.vaultId;
			const url = appendTraceParams(
				`${host}/vault/${encodeURIComponent(roomId)}/debug/recent`,
				this.httpContext,
			);
			const res = await obsidianRequest({
				url,
				method: "GET",
				headers: {
					Authorization: `Bearer ${settings.token}`,
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
			this.scheduleSnapshot("server-trace-refresh");
		} catch (err) {
			this.record("trace", "server-trace-fetch-failed", {
				error: String(err),
			});
		} finally {
			this.serverInFlight = false;
		}
	}
}
