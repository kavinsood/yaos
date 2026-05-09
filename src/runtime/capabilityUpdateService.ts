import { Notice } from "obsidian";
import {
	fetchServerCapabilities,
	type ServerCapabilities,
} from "../sync/serverCapabilities";
import {
	fetchUpdateManifest,
	isUpdateManifest,
	type UpdateManifest,
} from "../update/updateManifest";
import type { VaultSyncSettings } from "../settings";
import { obsidianRequest } from "../utils/http";
import { formatUnknown } from "../utils/format";
import { compareSemver } from "../utils/semver";

export type PersistedServerCapabilitiesCache = {
	host: string;
	capabilities: ServerCapabilities;
};

export type PersistedUpdateManifestCache = {
	fetchedAt: number;
	manifest: UpdateManifest;
};

export type UpdateState = {
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
};

const UPDATE_MANIFEST_URLS = [
	"https://github.com/kavinsood/yaos/releases/latest/download/update-manifest.json",
] as const;
const UPDATE_MANIFEST_CACHE_MS = 24 * 60 * 60 * 1000;
export const CAPABILITY_REFRESH_INTERVAL_MS = 30_000;
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

export function isServerCapabilities(value: unknown): value is ServerCapabilities {
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

export function readPersistedServerCapabilitiesCache(value: unknown): PersistedServerCapabilitiesCache | null {
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

export function readPersistedUpdateManifestCache(value: unknown): PersistedUpdateManifestCache | null {
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

interface CapabilityUpdateServiceDeps {
	getSettings(): VaultSyncSettings;
	pluginVersion: string;
	schemaVersion: number;
	trace(source: string, msg: string, details?: Record<string, unknown>): void;
	log(message: string): void;
	persistPluginState(): Promise<void>;
	hasSyncRuntime(): boolean;
	isSyncConnectedAndProviderSynced(): boolean;
	refreshAttachmentSyncRuntime(reason: string): Promise<void>;
	triggerDailySnapshot(): void;
	stopSyncRuntimeForCompatibility(): void;
	setStatusError(): void;
	scheduleTraceStateSnapshot(reason: string): void;
	updateSettings(mutator: (settings: VaultSyncSettings) => void, reason: string): Promise<void>;
}

export class CapabilityUpdateService {
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

	constructor(private readonly deps: CapabilityUpdateServiceDeps) {}

	get capabilities(): ServerCapabilities | null {
		return this.serverCapabilities;
	}

	get authMode(): ServerCapabilities["authMode"] | "unknown" {
		return this.serverCapabilities?.authMode ?? "unknown";
	}

	get supportsAttachments(): boolean {
		if (!this.deps.getSettings().host) return true;
		return this.serverCapabilities?.attachments ?? false;
	}

	get supportsSnapshots(): boolean {
		if (!this.deps.getSettings().host) return true;
		return this.serverCapabilities?.snapshots ?? false;
	}

	get hasCachedCapabilities(): boolean {
		return this.serverCapabilities !== null;
	}

	shouldRefreshCapabilities(now = Date.now()): boolean {
		return now - this.lastCapabilityRefreshAt >= CAPABILITY_REFRESH_INTERVAL_MS;
	}

	hydratePersistedCaches(
		cachedCapabilities: PersistedServerCapabilitiesCache | null,
		cachedUpdateManifest: PersistedUpdateManifestCache | null,
	): void {
		const settings = this.deps.getSettings();
		if (settings.host && cachedCapabilities?.host === settings.host) {
			this.serverCapabilities = cachedCapabilities.capabilities;
		} else {
			this.serverCapabilities = null;
		}

		if (cachedUpdateManifest) {
			this.updateManifest = cachedUpdateManifest.manifest;
			this.updateManifestFetchedAt = cachedUpdateManifest.fetchedAt;
		} else {
			this.updateManifest = null;
			this.updateManifestFetchedAt = 0;
		}
	}

	getPersistedServerCapabilitiesCache(): PersistedServerCapabilitiesCache | undefined {
		const settings = this.deps.getSettings();
		if (!settings.host || !this.serverCapabilities) return undefined;
		return {
			host: settings.host,
			capabilities: this.serverCapabilities,
		};
	}

	getPersistedUpdateManifestCache(): PersistedUpdateManifestCache | undefined {
		if (!this.updateManifest || this.updateManifestFetchedAt <= 0) return undefined;
		return {
			fetchedAt: this.updateManifestFetchedAt,
			manifest: this.updateManifest,
		};
	}

	enforceCompatibilityGuard(reason: string): boolean {
		const blockReason = this.getHardCompatibilityBlockReason();
		if (!blockReason) {
			if (this.compatibilityBlockReason) {
				this.deps.log(`Compatibility guard cleared (${reason})`);
				this.compatibilityBlockReason = null;
			}
			return false;
		}

		const firstBlock = this.compatibilityBlockReason !== blockReason;
		this.compatibilityBlockReason = blockReason;
		this.deps.log(`Compatibility guard (${reason}): ${blockReason}`);
		if (firstBlock) {
			new Notice(`YAOS: ${blockReason}`, 12000);
		}

		this.deps.stopSyncRuntimeForCompatibility();
		this.deps.setStatusError();
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

	getUpdateState(): UpdateState {
		const settings = this.deps.getSettings();
		const serverVersion = this.serverCapabilities?.serverVersion ?? null;
		const latestServerVersion = this.updateManifest?.latestServerVersion ?? null;
		const serverUpdateAvailable =
			serverVersion !== null &&
			latestServerVersion !== null &&
			compareSemver(serverVersion, latestServerVersion) === -1;

		const latestPluginVersion = this.updateManifest?.latestPluginVersion ?? null;
		const pluginUpdateRecommended =
			latestPluginVersion !== null &&
			compareSemver(this.deps.pluginVersion, latestPluginVersion) === -1;

		const effectiveRepoUrl = settings.updateRepoUrl.trim() ||
			this.serverCapabilities?.updateRepoUrl ||
			null;
		const effectiveProvider = this.inferUpdateProvider(effectiveRepoUrl) ||
			this.serverCapabilities?.updateProvider ||
			"unknown";

		let pluginCompatibilityWarning: string | null = null;
		const minPluginVersion = this.serverCapabilities?.minPluginVersion ?? null;
		if (minPluginVersion && compareSemver(this.deps.pluginVersion, minPluginVersion) === -1) {
			pluginCompatibilityWarning =
				`This server requires YAOS plugin ${minPluginVersion} or newer.`;
		} else {
			const minSchemaVersion = this.serverCapabilities?.minSchemaVersion ?? null;
			const maxSchemaVersion = this.serverCapabilities?.maxSchemaVersion ?? null;
			if (minSchemaVersion !== null && this.deps.schemaVersion < minSchemaVersion) {
				pluginCompatibilityWarning =
					`This server requires schema version ${minSchemaVersion} or newer.`;
			} else if (maxSchemaVersion !== null && this.deps.schemaVersion > maxSchemaVersion) {
				pluginCompatibilityWarning =
					`This plugin uses schema version ${this.deps.schemaVersion}, but the server currently supports up to ${maxSchemaVersion}.`;
			}
		}

		return {
			serverVersion,
			latestServerVersion,
			serverUpdateAvailable,
			pluginVersion: this.deps.pluginVersion,
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
		const settings = this.deps.getSettings();
		const repoUrl = settings.updateRepoUrl.trim() || this.serverCapabilities?.updateRepoUrl;
		const provider = this.inferUpdateProvider(repoUrl) || this.serverCapabilities?.updateProvider;
		if (!repoUrl || !provider) return null;
		const normalizedRepoUrl = repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
		const branch = settings.updateRepoBranch.trim() || this.serverCapabilities?.updateRepoBranch || "main";
		if (provider === "github") {
			return `${normalizedRepoUrl}/actions/workflows/yaos-ops.yml`;
		}
		if (provider === "gitlab") {
			return `${normalizedRepoUrl}/-/pipelines/new?ref=${encodeURIComponent(branch)}`;
		}
		return null;
	}

	buildGithubUpdaterBootstrapUrl(): string | null {
		const settings = this.deps.getSettings();
		const repoUrl = settings.updateRepoUrl.trim() || this.serverCapabilities?.updateRepoUrl;
		const provider = this.inferUpdateProvider(repoUrl) || this.serverCapabilities?.updateProvider;
		if (!repoUrl || provider !== "github") return null;
		const normalizedRepoUrl = repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
		const branch = encodeURIComponent(
			settings.updateRepoBranch.trim() || this.serverCapabilities?.updateRepoBranch || "main",
		);
		const filename = encodeURIComponent(GITHUB_OPS_WORKFLOW_PATH);
		const workflowValue = encodeURIComponent(buildGithubOpsBootstrapWorkflowYaml());
		return `${normalizedRepoUrl}/new/${branch}?filename=${filename}&value=${workflowValue}`;
	}

	async syncUpdateMetadataToServer(reason: string): Promise<void> {
		const settings = this.deps.getSettings();
		const host = settings.host.trim().replace(/\/$/, "");
		const token = settings.token.trim();
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
				this.deps.log(`Update metadata push (${reason}) failed (${res.status})`);
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
			this.deps.log(`Update metadata push (${reason}) failed: ${formatUnknown(err)}`);
		}
	}

	private getHardCompatibilityBlockReason(): string | null {
		if (!this.serverCapabilities) return null;

		const minPluginVersion = this.serverCapabilities.minPluginVersion;
		if (minPluginVersion && compareSemver(this.deps.pluginVersion, minPluginVersion) === -1) {
			return `This server requires YAOS plugin ${minPluginVersion} or newer. Update this plugin before syncing.`;
		}

		const minSchemaVersion = this.serverCapabilities.minSchemaVersion;
		if (minSchemaVersion !== null && this.deps.schemaVersion < minSchemaVersion) {
			return `This server requires schema version ${minSchemaVersion} or newer. Update this plugin before syncing.`;
		}

		const maxSchemaVersion = this.serverCapabilities.maxSchemaVersion;
		if (maxSchemaVersion !== null && this.deps.schemaVersion > maxSchemaVersion) {
			return `This plugin uses schema version ${this.deps.schemaVersion}, but this server supports up to ${maxSchemaVersion}. Update server first.`;
		}

		const minCompatibleServer = this.updateManifest?.minCompatibleServerVersionForPlugin ?? null;
		const latestPluginVersion = this.updateManifest?.latestPluginVersion ?? null;
		const serverVersion = this.serverCapabilities.serverVersion;
		if (!minCompatibleServer || !latestPluginVersion || !serverVersion) {
			return null;
		}

		const pluginVsLatest = compareSemver(this.deps.pluginVersion, latestPluginVersion);
		const serverVsRequired = compareSemver(serverVersion, minCompatibleServer);
		if (pluginVsLatest !== null && serverVsRequired !== null && pluginVsLatest >= 0 && serverVsRequired === -1) {
			return `This plugin requires YAOS server ${minCompatibleServer} or newer. Update server first.`;
		}
		return null;
	}

	private async refreshServerCapabilitiesInner(reason: string): Promise<void> {
		const settings = this.deps.getSettings();
		const startedAt = Date.now();
		this.lastCapabilityRefreshAt = startedAt;
		const previous = this.serverCapabilities;
		this.deps.trace("trace", "capability-refresh-start", {
			reason,
			host: settings.host || null,
		});

		if (!settings.host) {
			this.legacyServerDetected = false;
			this.serverCapabilities = null;
			await this.handleCapabilityChange(previous, null, reason);
			this.deps.trace("trace", "capability-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "no-host",
			});
			return;
		}

		try {
			this.serverCapabilities = await fetchServerCapabilities(settings.host);
			const serverVersion = (this.serverCapabilities as { serverVersion?: unknown } | null)?.serverVersion;
			if (typeof serverVersion === "string" && serverVersion.trim()) {
				this.legacyServerDetected = false;
			} else {
				this.legacyServerDetected = true;
				this.maybeShowLegacyServerNotice();
			}
		} catch (err) {
			const errorText = formatUnknown(err);
			this.deps.log(`Server capability probe failed: ${errorText}`);
			if (errorText.includes("capabilities request failed (404)")) {
				this.legacyServerDetected = true;
				this.maybeShowLegacyServerNotice();
			}
			this.deps.trace("trace", "capability-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "error",
				error: errorText,
			});
			return;
		}

		await this.handleCapabilityChange(previous, this.serverCapabilities, reason);
		this.deps.trace("trace", "capability-refresh-end", {
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

		this.deps.log(
			`Server capabilities updated (${reason}): ` +
			`claimed=${next?.claimed ?? "unknown"} auth=${next?.authMode ?? "unknown"} ` +
			`attachments=${nextAttachments ?? "unknown"} snapshots=${nextSnapshots ?? "unknown"} ` +
			`serverVersion=${next?.serverVersion ?? "unknown"} migrationRequired=${next?.migrationRequired ?? "unknown"} ` +
			`updateProvider=${next?.updateProvider ?? "unknown"} updateBranch=${next?.updateRepoBranch ?? "unknown"}`,
		);
		void this.deps.persistPluginState();
		this.deps.scheduleTraceStateSnapshot(`capabilities:${reason}`);

		if (this.deps.hasSyncRuntime()) {
			await this.deps.refreshAttachmentSyncRuntime(`capability-change:${reason}`);
		}

		const gainedR2 = prevAttachments === false && nextAttachments === true;
		const lostR2 = prevAttachments === true && nextAttachments === false;
		if (gainedR2) {
			new Notice(
				this.deps.getSettings().enableAttachmentSync
					? "YAOS: R2 backend detected. Attachments and snapshots are now available."
					: "YAOS: R2 backend detected. Attachments and snapshots are available if you enable them in settings.",
				7000,
			);
			if (this.deps.isSyncConnectedAndProviderSynced() && this.supportsSnapshots) {
				this.deps.triggerDailySnapshot();
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

		const settings = this.deps.getSettings();
		let changed = false;
		const nextRepoUrl = !settings.updateRepoUrl.trim()
			? capabilities.updateRepoUrl
			: null;
		if (nextRepoUrl) {
			changed = true;
		}
		const localBranch = settings.updateRepoBranch.trim();
		const nextBranch = (!localBranch || localBranch === "main")
			&& capabilities.updateRepoBranch
			&& capabilities.updateRepoBranch.trim()
			&& capabilities.updateRepoBranch !== localBranch
			? capabilities.updateRepoBranch
			: null;
		if ((!localBranch || localBranch === "main")
			&& capabilities.updateRepoBranch
			&& capabilities.updateRepoBranch.trim()
			&& capabilities.updateRepoBranch !== localBranch) {
			changed = true;
		}
		if (!changed) return;

		this.deps.log(`Hydrated update metadata from server (${reason})`);
		await this.deps.updateSettings((nextSettings) => {
			if (nextRepoUrl) {
				nextSettings.updateRepoUrl = nextRepoUrl;
			}
			if (nextBranch) {
				nextSettings.updateRepoBranch = nextBranch;
			}
		}, reason);
	}

	private async refreshUpdateManifestInner(reason: string, force: boolean): Promise<void> {
		const startedAt = Date.now();
		const cacheAgeMs = startedAt - this.updateManifestFetchedAt;
		if (!force && this.updateManifest && cacheAgeMs >= 0 && cacheAgeMs < UPDATE_MANIFEST_CACHE_MS) {
			this.deps.trace("trace", "update-manifest-refresh-end", {
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

		this.deps.trace("trace", "update-manifest-refresh-start", {
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
					this.deps.log(`Update manifest fetch failed from ${url}: ${formatUnknown(err)}`);
				}
			}
			if (!nextManifest) {
				throw lastError instanceof Error
					? lastError
					: new Error("all update manifest sources failed");
			}
			this.updateManifest = nextManifest;
			this.updateManifestFetchedAt = Date.now();
			await this.deps.persistPluginState();
			this.deps.trace("trace", "update-manifest-refresh-end", {
				reason,
				durationMs: Date.now() - startedAt,
				outcome: "ok",
				sourceUrl: fetchedFrom,
				latestServerVersion: this.updateManifest.latestServerVersion,
				latestPluginVersion: this.updateManifest.latestPluginVersion,
			});
		} catch (err) {
			this.deps.log(`Update manifest fetch failed: ${formatUnknown(err)}`);
			this.deps.trace("trace", "update-manifest-refresh-end", {
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
				this.deps.log(
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
				this.deps.log(
					`Update notice (${reason}): plugin ${this.deps.pluginVersion} -> ${updateState.latestPluginVersion}`,
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

	private buildUpdateMetadataPayload(): {
		updateProvider: "github" | "gitlab" | "unknown";
		updateRepoUrl: string;
		updateRepoBranch: string | null;
	} | null {
		const settings = this.deps.getSettings();
		let updateRepoUrl: string | null = null;
		const rawRepoUrl = settings.updateRepoUrl.trim();
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

		const branch = settings.updateRepoBranch.trim();
		const updateRepoBranch = branch.length > 0 ? branch : (this.serverCapabilities?.updateRepoBranch ?? null);
		return {
			updateProvider,
			updateRepoUrl,
			updateRepoBranch,
		};
	}
}
