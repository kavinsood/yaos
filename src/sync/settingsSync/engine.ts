import type { App, PluginManifest } from "obsidian";
import { formatUnknown } from "../../utils/format";
import { obsidianRequest } from "../../utils/http";
import { persistAndRunApplyBatch, resumeApplyQueue } from "./apply";
import type { ApplyBatch, ApplyContext, ApplyStep, ApplyPluginManifest } from "./apply";
import {
	loadApplyQueue,
	loadEnvironmentAcceptance,
	markEnvironmentAccepted,
	retireApplyQueue,
	type ApplyQueueScope,
} from "./applyQueue";
import { isPluginDataRelPath, pluginIdFromDataPath } from "./allowlist";
import { isBlankConfigDir } from "./blank";
import { detectSettingsSyncClash } from "./clash";
import { sanitizeConfigDirKey } from "./configDirKey";
import { canApplyPluginData, canPutPluginData } from "./dataJsonGate";
import { sha256BytesHex, sha256TextHex } from "../../utils/sha256";
import {
	decideLwwBoth,
	decideLwwMissingLocal,
	decideLwwMissingRemote,
	mutationRev,
	shouldPutMissingRemotePluginData,
} from "./lwwReconcile";
import { COMMUNITY_PLUGINS_CATALOG_URL, lookupRepoManifest } from "./obsidianPluginInstall";
import { compareDottedVersion } from "./pluginIntent";
import {
	SettingsSyncClient,
	type SettingsSyncClientOptions,
} from "./protocol";
import { UnknownRootJsonLog, emptySettingsSyncStatus, withStatusPatch } from "./status";
import {
	SETTINGS_SYNC_FORMAT_VERSION,
	SETTINGS_SYNC_MAX_FILE_BYTES,
	SETTINGS_SYNC_MAX_INTENTS,
	SETTINGS_SYNC_MAX_THEMES,
	SETTINGS_SYNC_SKIP_PLUGIN_IDS,
	type SettingsSyncFile,
	type SettingsSyncSeeded,
	type SettingsSyncSnapshot,
	type SettingsSyncStatus,
	type SettingsVersionMismatch,
} from "./types";
import {
	SETTINGS_SYNC_POLL_MS,
	SettingsSyncWatcher,
	joinConfig,
	scanConfigDir,
	type LocalConfigFile,
	type SettingsDirAdapter,
	type WatchFileEvent,
} from "./watch";

const THEME_CATALOG_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-css-themes.json";

export type SettingsSyncSettingsSlice = {
	host?: string;
	deviceToken?: string;
	vaultId?: string;
	vaultGeneration?: string;
	deviceId?: string;
	debug?: boolean;
	settingsSyncEnabled?: boolean;
	settingsSyncAutoInstall?: boolean;
	settingsSyncDeferred?: boolean;
};

export type SettingsSyncCapabilities = {
	settingsSync?: boolean;
	settingsFormatVersion?: number;
};

export type SettingsSyncVisibilityPort = {
	isHidden(): boolean;
	subscribe(listener: () => void): () => void;
};

export type SettingsSyncEngineOptions = {
	app: App;
	adapter?: SettingsDirAdapter;
	getSettings: () => SettingsSyncSettingsSlice;
	getCapabilities: () => SettingsSyncCapabilities | null;
	folderKey: string;
	configDirBasename?: string;
	indexedDb?: Pick<IDBFactory, "open">;
	createClient?: (options: SettingsSyncClientOptions) => SettingsSyncClient;
	visibility?: SettingsSyncVisibilityPort;
	onStatus?: (status: SettingsSyncStatus) => void;
	onNeedsSeed?: (info: { key: string; blank: boolean }) => void;
	setDeferred?: (deferred: boolean) => void;
};

type Ack = { sha256: string; rev: number };

type CatalogMaps = {
	plugins: Map<string, string>;
	themes: Map<string, string>;
};

export class SettingsSyncEngine {
	private snapshot: SettingsSyncStatus = emptySettingsSyncStatus();
	private generation = 0;
	private stopped = true;
	private loopStarted = false;
	private operationTail: Promise<void> = Promise.resolve();
	private timer: number | null = null;
	private watcher: SettingsSyncWatcher | null = null;
	private seedUiShown = false;
	private lastAppliedEnvRev: number | null = null;
	private environmentAccepted = false;
	private lastRemote: SettingsSyncSeeded | null = null;
	private lastPluginBatch: ApplyBatch | null = null;
	private readonly acked = new Map<string, Ack>();
	private readonly unknown = new UnknownRootJsonLog();
	private originalInstallPlugin: ((
		repo: string,
		version: string,
		manifest: PluginManifest,
	) => Promise<void>) | null = null;
	private originalEnablePluginAndSave: ((id: string) => Promise<boolean>) | null = null;
	private removeVisibilitySubscription: (() => void) | null = null;

	constructor(private readonly opts: SettingsSyncEngineOptions) {}

	get status(): SettingsSyncStatus {
		return this.snapshot;
	}

	getStatus(): SettingsSyncStatus {
		return this.snapshot;
	}

	async start(): Promise<void> {
		await this.stop();
		this.seedUiShown = false;
		this.stopped = false;
		const gen = this.generation;
		await this.serialize(async () => {
			if (!this.isCurrent(gen)) return;
			const capabilities = this.opts.getCapabilities();
			if (!capabilities?.settingsSync || capabilities.settingsFormatVersion !== SETTINGS_SYNC_FORMAT_VERSION) {
				this.patch({
					running: false,
					reason: "unsupported",
					headline: capabilities?.settingsSync ? "settings_format_unsupported" : "settings_sync_unsupported",
					error: null,
				});
				return;
			}

			const key = this.configKey();
			this.patch({ configKey: key, deferred: this.isDeferred(), clashId: null, error: null });
			if (!key) {
				this.patch({ running: false, reason: "invalid-key", headline: "invalid_config_key" });
				return;
			}
			if (!this.hasCompleteIdentity()) {
				this.patch({ running: false, reason: "error", error: "incomplete_settings_sync_identity" });
				return;
			}

			const scope = await this.queueScope();
			if (!scope || !this.isCurrent(gen)) return;
			this.environmentAccepted = await loadEnvironmentAcceptance(scope);
			this.installVisibilityHandler(gen);
			const applyCtx = await this.applyCtx(key);
			await this.refreshApplyQueueStatus(scope);
			const resumeResult = await resumeApplyQueue(applyCtx);
			await this.refreshApplyQueueStatus(scope);
			if (!this.isCurrent(gen)) return;
			if (resumeResult === "invalid") {
				this.patch({ running: false, reason: "error", error: "invalid_settings_apply_queue" });
				return;
			}
			if (resumeResult === "complete" && !this.environmentAccepted) {
				await this.acceptEnvironment();
			}

			const clashId = await this.detectClash();
			if (!this.isCurrent(gen)) return;
			if (clashId) {
				this.patch({ running: false, reason: "clash", clashId, headline: null });
				return;
			}
			if (!this.isMasterEnabled()) {
				this.patch({ running: false, reason: "master-off", clashId: null });
				return;
			}
			if (this.isDeferred()) {
				this.patch({ running: false, reason: "deferred", deferred: true, needsSeed: false });
				return;
			}
			const remote = await this.client().getEnvironment(key);
			if (!this.isCurrent(gen)) return;
			if (!remote.seeded) {
				await this.markUnseeded(key);
				return;
			}
			this.rememberEnvironment(remote);
			if (!this.environmentAccepted) {
				await this.markDecisionRequired(key);
				return;
			}
			await this.beginLoop(gen, remote);
		});
	}

	async stop(retire = false): Promise<void> {
		this.generation += 1;
		this.stopped = true;
		this.loopStarted = false;
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		this.watcher?.stop();
		this.watcher = null;
		this.removeVisibilityHandler();

		await this.operationTail;
		if (retire) {
			const scope = await this.queueScope();
			if (scope) await retireApplyQueue(scope);
		}
		this.unhookInstallPlugin();
		this.lastRemote = null;
		this.lastPluginBatch = null;
		this.lastAppliedEnvRev = null;
		this.environmentAccepted = false;
		this.acked.clear();
		this.patch({
			running: false,
			...(this.snapshot.reason === "ok" ? { reason: "stopped" as const } : {}),
			environmentPlugins: [],
			environmentThemes: [],
		});
	}

	async retire(): Promise<void> {
		await this.stop(true);
	}

	async applySettings(): Promise<void> {
		await this.serialize(async () => {
			if (!this.canMutate()) return;
			const key = this.configKey();
			if (!key) return;
			const fetched = await this.client().getEnvironment(key);
			if (!this.canMutate() || !fetched.seeded) return;
			this.rememberEnvironment(fetched);
			const batch = await this.buildPluginBatch(key, fetched, true);
			if (!this.canMutate()) return;
			this.lastPluginBatch = batch;
			const completed = await this.runApplyBatch(key, batch);
			if (!this.stopped && completed) this.lastAppliedEnvRev = fetched.envRev;
		});
	}

	async replaceEnvironment(): Promise<void> {
		await this.serialize(async () => {
			if (!this.canSeed()) return;
			const key = this.requireKey();
			if (!key) return;
			const snapshot = await this.buildSnapshot();
			if (!this.canSeed()) return;
			await this.client().replace(key, snapshot);
			if (this.stopped) return;
			await this.acceptEnvironment();
			this.opts.setDeferred?.(false);
			await this.syncAfterSeed(key);
		});
	}

	async removeFromEnvironment(kind: "plugin" | "theme", id: string): Promise<void> {
		await this.serialize(async () => {
			if (!this.canMutate()) return;
			const key = this.requireKey();
			if (!key) return;
			await this.client().putTombstone(key, { kind, id });
			if (!this.canMutate()) return;
			const step: ApplyStep = kind === "plugin"
				? { kind: "uninstall-plugin", id }
				: { kind: "uninstall-theme", name: id };
			const completed = await this.runApplyBatch(key, { key, steps: [step] });
			if (!this.stopped && completed) {
				this.patch({
					environmentPlugins: kind === "plugin"
						? this.snapshot.environmentPlugins.filter((item) => item.id !== id)
						: this.snapshot.environmentPlugins,
					environmentThemes: kind === "theme"
						? this.snapshot.environmentThemes.filter((item) => item.name !== id)
						: this.snapshot.environmentThemes,
				});
			}
		});
	}

	async promotePin(pluginId: string): Promise<void> {
		await this.serialize(async () => {
			if (!this.canMutate()) return;
			const key = this.requireKey();
			if (!key) return;
			const local = await this.readPluginManifest(pluginId);
			if (!local || !this.canMutate()) return;
			const intent = this.lastRemote?.intents.find((row) => row.id === pluginId);
			const enabled = intent?.enabled ?? this.isCommunityEnabled(pluginId);
			const repo = intent?.repo ?? (await this.loadCatalogs()).plugins.get(pluginId);
			if (!repo || !this.canMutate()) return;
			await this.client().putIntent(key, { id: pluginId, repo, version: local.version, enabled });
		});
	}

	async updatePlugin(pluginId: string): Promise<void> {
		await this.serialize(async () => {
			if (!this.canMutate()) return;
			const key = this.requireKey();
			if (!key) return;
			const remote = await this.client().getEnvironment(key);
			if (!this.canMutate() || !remote.seeded) return;
			this.rememberEnvironment(remote);
			if (!remote.intents.some((row) => row.id === pluginId)) return;
			const steps = await this.pluginApplySteps(remote, pluginId, await this.localManifestMap());
			if (!this.canMutate()) return;
			await this.runApplyBatch(key, { key, steps });
		});
	}

	async seedThisDevice(): Promise<void> {
		await this.serialize(async () => {
			if (!this.canSeed()) return;
			const key = this.requireKey();
			if (!key) return;
			const snapshot = await this.buildSnapshot();
			if (!this.canSeed()) return;
			try {
				await this.client().seed(key, snapshot);
			} catch (error) {
				if (!this.stopped) this.patch({ reason: "error", error: formatUnknown(error) });
				return;
			}
			if (this.stopped) return;
			await this.acceptEnvironment();
			this.opts.setDeferred?.(false);
			await this.syncAfterSeed(key);
		});
	}

	async takeSeed(): Promise<void> {
		await this.serialize(async () => this.pourRemote(false));
	}

	async pourBlank(): Promise<void> {
		await this.serialize(async () => this.pourRemote(true));
	}

	async notifyCatalogInstall(intent: {
		id: string;
		repo: string;
		version: string;
		enabled: boolean;
	}): Promise<void> {
		await this.serialize(async () => {
			if (!this.canMutate()) return;
			const key = this.requireKey();
			if (!key || (!this.lastRemote?.seeded && this.snapshot.seeded !== true)) return;
			await this.client().putIntent(key, intent);
		});
	}

	private async pourRemote(_blank: boolean): Promise<void> {
		if (!this.canSeed()) return;
		const key = this.requireKey();
		if (!key) return;
		const remote = await this.client().getEnvironment(key);
		if (!remote.seeded) {
			await this.markUnseeded(key);
			return;
		}
		const batch = await this.buildPourBatch(key, remote);
		if (!await this.runApplyBatch(key, batch)) return;
		if (this.stopped) return;
		await this.acceptEnvironment();
		this.opts.setDeferred?.(false);
		this.rememberAcked(remote);
		this.patch({
			seeded: true,
			needsSeed: false,
			reason: "ok",
			deferred: false,
		});
		await this.beginLoop(this.generation, remote);
	}

	private async beginLoop(gen: number, initialRemote?: SettingsSyncSeeded): Promise<void> {
		if (!this.isCurrent(gen) || this.loopStarted) return;
		this.loopStarted = true;
		await this.tick(initialRemote);
		if (!this.isCurrent(gen) || this.snapshot.reason !== "ok") {
			this.loopStarted = false;
			return;
		}

		this.hookInstallPlugin();
		const adapter = this.adapter();
		const configDir = this.configDir();
		this.watcher = new SettingsSyncWatcher(adapter, configDir, {
			onFile: (event) => {
				void this.serialize(async () => this.handleLocalEvent(event));
			},
			onUnknownRootJson: (names) => {
				if (this.isCurrent(gen)) this.noteUnknown(names);
			},
		});
		this.watcher.start();
		this.timer = window.setInterval(() => {
			void this.serialize(async () => this.tick());
		}, SETTINGS_SYNC_POLL_MS);
	}

	private installVisibilityHandler(generation: number): void {
		this.removeVisibilityHandler();
		const listener = () => {
			if (this.isSettingsHidden() || !this.isCurrent(generation)) return;
			void this.serialize(async () => this.resumeForegroundQueue(generation));
		};
		if (this.opts.visibility) {
			this.removeVisibilitySubscription = this.opts.visibility.subscribe(listener);
			return;
		}
		if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
		document.addEventListener("visibilitychange", listener);
		this.removeVisibilitySubscription = () => document.removeEventListener("visibilitychange", listener);
	}

	private removeVisibilityHandler(): void {
		this.removeVisibilitySubscription?.();
		this.removeVisibilitySubscription = null;
	}

	private isSettingsHidden(): boolean {
		if (this.opts.visibility) return this.opts.visibility.isHidden();
		return typeof document !== "undefined" && document.visibilityState === "hidden";
	}

	private async resumeForegroundQueue(generation: number): Promise<void> {
		if (!this.isCurrent(generation)) return;
		const key = this.configKey();
		const scope = await this.queueScope();
		if (!key || !scope) return;
		const result = await resumeApplyQueue(await this.applyCtx(key));
		await this.refreshApplyQueueStatus(scope);
		if (!this.isCurrent(generation) || result === "none") return;
		if (result === "invalid") {
			this.patch({ running: false, reason: "error", error: "invalid_settings_apply_queue" });
			return;
		}
		if (result === "paused") return;
		if (!this.environmentAccepted) {
			await this.acceptEnvironment();
			this.opts.setDeferred?.(false);
		}
		const remote = await this.client().getEnvironment(key);
		if (!this.isCurrent(generation) || !remote.seeded) return;
		this.rememberAcked(remote);
		this.patch({
			running: true,
			reason: "ok",
			seeded: true,
			needsSeed: false,
			deferred: false,
		});
		if (this.loopStarted) await this.tick(remote);
		else await this.beginLoop(generation, remote);
	}

	private async tick(initialRemote?: SettingsSyncSeeded): Promise<void> {
		if (this.stopped) return;
		try {
			await this.tickInner(initialRemote);
		} catch (error) {
			if (!this.stopped) this.patch({ reason: "error", error: formatUnknown(error), running: false });
		}
	}

	private async tickInner(initialRemote?: SettingsSyncSeeded): Promise<void> {
		const capabilities = this.opts.getCapabilities();
		if (!capabilities?.settingsSync || capabilities.settingsFormatVersion !== SETTINGS_SYNC_FORMAT_VERSION) {
			this.patch({ running: false, reason: "unsupported", headline: "settings_sync_unsupported" });
			return;
		}
		if (!this.environmentAccepted) {
			this.patch({ running: false, reason: "decision-required", needsSeed: true });
			return;
		}
		if (!this.isMasterEnabled()) {
			this.patch({ running: false, reason: "master-off" });
			return;
		}
		const clashId = await this.detectClash();
		if (this.stopped) return;
		if (clashId) {
			this.patch({ running: false, reason: "clash", clashId });
			return;
		}
		const key = this.configKey();
		if (!key) {
			this.patch({ running: false, reason: "invalid-key", headline: "invalid_config_key" });
			return;
		}
		const conn = this.conn();
		if (!conn.host || !conn.vaultId) {
			this.patch({ running: false, reason: "error", error: "missing_host" });
			return;
		}

		const remote = initialRemote ?? await this.client().getEnvironment(key);
		if (this.stopped) return;
		if (!remote.seeded) {
			await this.markUnseeded(key);
			return;
		}

		this.patch({
			running: true,
			reason: "ok",
			seeded: true,
			needsSeed: false,
			deferred: false,
			clashId: null,
			error: null,
			configKey: key,
		});

		const scan = await scanConfigDir(this.adapter(), this.configDir());
		if (this.stopped) return;
		this.noteUnknown(scan.unknownRootJson);

		// Reconnect: apply remote live-set + tombstones BEFORE local add.
		const pluginBatch = await this.buildPluginBatch(key, remote, false);
		if (this.stopped) return;
		this.lastPluginBatch = pluginBatch;
		this.rememberEnvironment(remote);
		if (this.isAutoInstall() && remote.envRev !== this.lastAppliedEnvRev) {
			const completed = await this.runApplyBatch(key, pluginBatch);
			if (this.stopped) return;
			if (completed) this.lastAppliedEnvRev = remote.envRev;
		}

		await this.lwwFiles(key, scan.files, remote);
		if (this.stopped) return;
		await this.lwwPluginData(key, scan.files, remote);
		if (this.stopped) return;
		this.refreshMismatches(scan.files, remote);
	}

	private async handleLocalEvent(event: WatchFileEvent): Promise<void> {
		if (this.stopped || this.snapshot.seeded !== true) return;
		const key = this.configKey();
		if (!key || !this.canMutate()) return;
		try {
			if (event.type === "delete") {
				const ack = this.acked.get(event.path);
				if (!ack) return;
				if (isPluginDataRelPath(event.path)) return;
				await this.client().deleteFile(key, event.path);
				this.acked.delete(event.path);
				return;
			}
			const { file } = event;
			if (this.acked.get(file.path)?.sha256 === file.sha256) return;
			if (isPluginDataRelPath(file.path)) {
				await this.pushPluginData(key, file);
				return;
			}
			if (!jsonQuarantineOk(file.path, file.body)) return;
			const put = await this.client().putFile(key, {
				path: file.path,
				sha256: file.sha256,
				bodyBase64: bytesToBase64(file.body),
			});
			if (this.stopped) return;
			this.acked.set(file.path, {
				sha256: file.sha256,
				rev: mutationRev(put, this.acked.get(file.path)?.rev ?? 0),
			});
		} catch (error) {
			if (!this.stopped) this.patch({ error: formatUnknown(error) });
		}
	}

	private async lwwFiles(
		key: string,
		local: Map<string, LocalConfigFile>,
		remote: SettingsSyncSeeded,
	): Promise<void> {
		const remoteFiles = new Map<string, SettingsSyncFile>();
		for (const file of remote.files) remoteFiles.set(file.path, file);

		const toWriteRemote: SettingsSyncFile[] = [];
		const toDeleteRemote: string[] = [];
		const toPutLocal: LocalConfigFile[] = [];
		const toDeleteLocal: string[] = [];

		for (const remoteFile of remote.files) {
			if (isPluginDataRelPath(remoteFile.path)) continue;
			const loc = local.get(remoteFile.path);
			const ack = this.acked.get(remoteFile.path);
			if (!loc) {
				if (decideLwwMissingLocal(Boolean(ack)) === "delete-remote") toDeleteRemote.push(remoteFile.path);
				else toWriteRemote.push(remoteFile);
				continue;
			}
			const both = decideLwwBoth(loc.sha256, remoteFile.sha256, remoteFile.rev, ack);
			if (both === "nop") {
				this.acked.set(remoteFile.path, { sha256: remoteFile.sha256, rev: remoteFile.rev });
				continue;
			}
			if (both === "take-remote") toWriteRemote.push(remoteFile);
			else toPutLocal.push(loc);
		}

		const remotePluginDataPaths = new Set(
			remote.pluginData.map((entry) => `plugins/${entry.pluginId}/data.json`),
		);
		for (const [path, loc] of local) {
			if (this.stopped) return;
			if (isPluginDataRelPath(path)) {
				if (shouldPutMissingRemotePluginData(
					loc.sha256,
					remotePluginDataPaths.has(path),
					this.acked.get(path),
				)) {
					await this.pushPluginData(key, loc);
				}
				continue;
			}
			if (remoteFiles.has(path)) continue;
			if (decideLwwMissingRemote(this.acked.has(path)) === "delete-local") toDeleteLocal.push(path);
			else toPutLocal.push(loc);
		}

		for (const file of toWriteRemote) {
			if (this.stopped) return;
			await this.applyRemoteFile(file);
		}
		for (const path of toDeleteLocal) {
			if (this.stopped) return;
			await removeConfigFile(this.adapter(), this.configDir(), path);
			this.acked.delete(path);
			local.delete(path);
		}
		for (const loc of toPutLocal) {
			if (this.stopped) return;
			if (!jsonQuarantineOk(loc.path, loc.body)) continue;
			const put = await this.client().putFile(key, {
				path: loc.path,
				sha256: loc.sha256,
				bodyBase64: bytesToBase64(loc.body),
			});
			if (this.stopped) return;
			this.acked.set(loc.path, {
				sha256: loc.sha256,
				rev: mutationRev(put, remoteFiles.get(loc.path)?.rev ?? this.acked.get(loc.path)?.rev ?? 0),
			});
		}
		for (const path of toDeleteRemote) {
			if (this.stopped) return;
			await this.client().deleteFile(key, path);
			this.acked.delete(path);
		}
	}

	private async lwwPluginData(
		key: string,
		local: Map<string, LocalConfigFile>,
		remote: SettingsSyncSeeded,
	): Promise<void> {
		for (const entry of remote.pluginData) {
			if (this.stopped) return;
			const path = `plugins/${entry.pluginId}/data.json`;
			const intent = remote.intents.find((row) => row.id === entry.pluginId);
			const tombstoned = remote.tombstones.some(
				(row) => row.kind === "plugin" && row.id === entry.pluginId,
			);
			const localManifest = await this.readPluginManifest(entry.pluginId);
			if (this.stopped) return;
			const loc = local.get(path);
			if (!canApplyPluginData({
				pluginId: entry.pluginId,
				localManifestVersion: localManifest?.version,
				intentVersion: intent?.version,
				pluginVersion: entry.pluginVersion,
				tombstoned,
			})) {
				this.noteMismatch(entry.pluginId, localManifest?.version ?? "", intent?.version ?? entry.pluginVersion);
				continue;
			}
			const ack = this.acked.get(path);
			if (!loc) {
				await this.applyRemoteFile({
					path,
					sha256: entry.sha256,
					size: entry.size,
					rev: entry.rev,
					bodyBase64: entry.bodyBase64,
				});
				continue;
			}
			const both = decideLwwBoth(loc.sha256, entry.sha256, entry.rev, ack);
			if (both === "nop") {
				this.acked.set(path, { sha256: entry.sha256, rev: entry.rev });
				continue;
			}
			if (both === "put-local") {
				await this.pushPluginData(key, loc);
				continue;
			}
			await this.applyRemoteFile({
				path,
				sha256: entry.sha256,
				size: entry.size,
				rev: entry.rev,
				bodyBase64: entry.bodyBase64,
			});
		}
	}

	private async applyRemoteFile(file: SettingsSyncFile): Promise<void> {
		const bytes = base64ToBytes(file.bodyBase64);
		if (await sha256BytesHex(bytes) !== file.sha256) {
			if (!this.stopped) this.patch({ error: `invalid_hash:${file.path}` });
			return;
		}
		if (this.stopped) return;
		if (!jsonQuarantineOk(file.path, bytes)) {
			this.patch({ error: `invalid_json:${file.path}` });
			return;
		}
		await writeConfigFile(this.adapter(), this.configDir(), file.path, bytes);
		if (this.stopped) return;
		this.acked.set(file.path, { sha256: file.sha256, rev: file.rev });
		if (file.path === "app.json" || file.path === "hotkeys.json") this.patch({ needsRestart: true });
	}

	private async pushPluginData(key: string, file: LocalConfigFile): Promise<void> {
		const pluginId = pluginIdFromDataPath(file.path);
		if (!pluginId) return;
		const intent = this.lastRemote?.intents.find((row) => row.id === pluginId);
		const tombstoned = this.lastRemote?.tombstones.some(
			(row) => row.kind === "plugin" && row.id === pluginId,
		) === true;
		const local = await this.readPluginManifest(pluginId);
		const localVersion = local?.version ?? null;
		const pin = intent?.version ?? null;
		if (!canPutPluginData({
			pluginId,
			localManifestVersion: localVersion,
			intentVersion: pin,
			pluginVersion: localVersion,
			tombstoned,
		})) {
			this.noteMismatch(pluginId, localVersion ?? "", pin ?? "");
			return;
		}
		if (!localVersion) return;
		const put = await this.client().putPluginData(key, {
			pluginId,
			pluginVersion: localVersion,
			sha256: file.sha256,
			bodyBase64: bytesToBase64(file.body),
		});
		this.acked.set(file.path, {
			sha256: file.sha256,
			rev: mutationRev(put, this.acked.get(file.path)?.rev ?? 0),
		});
	}

	private async verifiedRemoteText(
		label: string,
		bodyBase64: string,
		expectedSha256: string,
	): Promise<string | null> {
		try {
			const bytes = base64ToBytes(bodyBase64);
			if (await sha256BytesHex(bytes) !== expectedSha256) {
				this.patch({ error: `invalid_hash:${label}` });
				return null;
			}
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			this.patch({ error: `invalid_body:${label}` });
			return null;
		}
	}

	private async buildPourBatch(key: string, remote: SettingsSyncSeeded): Promise<ApplyBatch> {
		const manifests = await this.localManifestMap();
		const steps: ApplyStep[] = [];
		const isSnippet = (path: string) => path.startsWith("snippets/") && path.endsWith(".css");
		const verifiedFiles = new Map<string, string>();
		for (const file of remote.files) {
			const body = await this.verifiedRemoteText(file.path, file.bodyBase64, file.sha256);
			if (body !== null) verifiedFiles.set(file.path, body);
		}

		for (const file of remote.files) {
			const body = verifiedFiles.get(file.path);
			if (body === undefined || isSnippet(file.path) || file.path === "appearance.json" || file.path === "workspaces.json") {
				continue;
			}
			steps.push({ kind: "file", path: file.path, body });
		}
		for (const file of remote.files) {
			const body = verifiedFiles.get(file.path);
			if (body === undefined || !isSnippet(file.path)) continue;
			steps.push({ kind: "file", path: file.path, body });
		}
		const appearance = remote.files.find((file) => file.path === "appearance.json");
		const appearanceBody = appearance ? verifiedFiles.get(appearance.path) : undefined;
		if (appearanceBody !== undefined) {
			steps.push({ kind: "file", path: "appearance.json", body: appearanceBody });
		}
		for (const theme of remote.themes) {
			steps.push({
				kind: "install-theme",
				name: theme.name,
				repo: theme.repo,
				version: theme.version,
			});
		}
		if (appearanceBody !== undefined && remote.themes.length > 0) {
			steps.push({ kind: "file", path: "appearance.json", body: appearanceBody });
		}
		steps.push(...await this.pluginApplySteps(remote, null, manifests));
		for (const tomb of remote.tombstones) {
			if (tomb.kind === "plugin") steps.push({ kind: "uninstall-plugin", id: tomb.id });
			else steps.push({ kind: "uninstall-theme", name: tomb.id });
		}
		const workspaces = remote.files.find((file) => file.path === "workspaces.json");
		const workspacesBody = workspaces ? verifiedFiles.get(workspaces.path) : undefined;
		if (workspacesBody !== undefined) {
			steps.push({ kind: "file", path: "workspaces.json", body: workspacesBody });
		}
		return { key, steps };
	}

	private async buildPluginBatch(
		key: string,
		remote: SettingsSyncSeeded,
		includeFiles: boolean,
	): Promise<ApplyBatch> {
		if (includeFiles) return this.buildPourBatch(key, remote);
		const manifests = await this.localManifestMap();
		const steps: ApplyStep[] = [];
		for (const theme of remote.themes) {
			steps.push({
				kind: "install-theme",
				name: theme.name,
				repo: theme.repo,
				version: theme.version,
			});
		}
		steps.push(...await this.pluginApplySteps(remote, null, manifests));
		for (const tomb of remote.tombstones) {
			if (tomb.kind === "plugin") steps.push({ kind: "uninstall-plugin", id: tomb.id });
			else steps.push({ kind: "uninstall-theme", name: tomb.id });
		}
		return { key, steps };
	}

	private async pluginApplySteps(
		remote: SettingsSyncSeeded,
		onlyId: string | null,
		manifests: Map<string, ApplyPluginManifest>,
	): Promise<ApplyStep[]> {
		const steps: ApplyStep[] = [];
		for (const intent of remote.intents) {
			if (onlyId && intent.id !== onlyId) continue;
			const fetched = await lookupRepoManifest(intent.repo);
			const local = manifests.get(intent.id);
			const manifest: ApplyPluginManifest = fetched
				? {
					id: fetched.id,
					name: fetched.name,
					version: intent.version,
					minAppVersion: fetched.minAppVersion,
					isDesktopOnly: fetched.isDesktopOnly,
					author: fetched.author,
					description: fetched.description,
				}
				: local ?? { id: intent.id, version: intent.version };
			steps.push({
				kind: "install-plugin",
				id: intent.id,
				repo: intent.repo,
				version: intent.version,
				manifest,
				isDesktopOnly: manifest.isDesktopOnly,
			});
		}
		for (const entry of remote.pluginData) {
			if (onlyId && entry.pluginId !== onlyId) continue;
			const intent = remote.intents.find((row) => row.id === entry.pluginId);
			const local = manifests.get(entry.pluginId);
			const body = await this.verifiedRemoteText(
				`plugins/${entry.pluginId}/data.json`,
				entry.bodyBase64,
				entry.sha256,
			);
			if (body === null) continue;
			steps.push({
				kind: "plugin-data",
				pluginId: entry.pluginId,
				pluginVersion: entry.pluginVersion,
				body,
				localManifestVersion: local?.version ?? "",
				intentVersion: intent?.version ?? "",
				tombstoned: remote.tombstones.some(
					(row) => row.kind === "plugin" && row.id === entry.pluginId,
				),
			});
		}
		for (const intent of remote.intents) {
			if (onlyId && intent.id !== onlyId) continue;
			steps.push({
				kind: "enable-plugin",
				id: intent.id,
				enabled: intent.enabled,
				isDesktopOnly: manifests.get(intent.id)?.isDesktopOnly,
			});
		}
		return steps;
	}

	private async buildSnapshot(): Promise<SettingsSyncSnapshot> {
		const scan = await scanConfigDir(this.adapter(), this.configDir());
		this.noteUnknown(scan.unknownRootJson);
		const catalogs = await this.loadCatalogs();
		const enabled = await this.communityEnabledIds();
		const files: SettingsSyncSnapshot["files"] = [];
		const pluginData: SettingsSyncSnapshot["pluginData"] = [];
		for (const file of scan.files.values()) {
			if (isPluginDataRelPath(file.path)) {
				const pluginId = pluginIdFromDataPath(file.path);
				if (!pluginId) continue;
				const manifest = await this.readPluginManifest(pluginId);
				if (!manifest) continue;
				if (!canPutPluginData({
					pluginId,
					localManifestVersion: manifest.version,
					intentVersion: manifest.version,
					pluginVersion: manifest.version,
					tombstoned: false,
				})) continue;
				pluginData.push({
					pluginId,
					pluginVersion: manifest.version,
					sha256: file.sha256,
					bodyBase64: bytesToBase64(file.body),
				});
				continue;
			}
			if (file.size > SETTINGS_SYNC_MAX_FILE_BYTES) continue;
			if (!jsonQuarantineOk(file.path, file.body)) continue;
			files.push({
				path: file.path,
				sha256: file.sha256,
				bodyBase64: bytesToBase64(file.body),
			});
		}

		const intents: SettingsSyncSnapshot["intents"] = [];
		const plugins = await listSafe(this.adapter(), joinConfig(this.configDir(), "plugins"));
		for (const folder of plugins.folders) {
			const id = folderBasename(folder);
			if (!id || (SETTINGS_SYNC_SKIP_PLUGIN_IDS as readonly string[]).includes(id)) continue;
			const repo = catalogs.plugins.get(id);
			const manifest = await this.readPluginManifest(id);
			if (!repo || !manifest) continue;
			intents.push({
				id,
				repo,
				version: manifest.version,
				enabled: enabled.has(id),
			});
		}

		const themes: SettingsSyncSnapshot["themes"] = [];
		const themeFolders = await listSafe(this.adapter(), joinConfig(this.configDir(), "themes"));
		for (const folder of themeFolders.folders) {
			const name = folderBasename(folder);
			if (!name) continue;
			const repo = catalogs.themes.get(name);
			if (!repo) continue;
			const manifest = await this.readThemeManifest(name);
			themes.push({
				name,
				repo,
				version: manifest?.version ?? "0.0.0",
			});
		}

		return { files, intents, themes, pluginData };
	}

	private async syncAfterSeed(key: string): Promise<void> {
		const remote = await this.client().getEnvironment(key);
		if (this.stopped || !remote.seeded) return;
		this.rememberAcked(remote);
		this.patch({
			seeded: true,
			needsSeed: false,
			reason: "ok",
			deferred: false,
			running: true,
		});
		await this.beginLoop(this.generation, remote);
	}

	private rememberAcked(remote: SettingsSyncSeeded): void {
		this.acked.clear();
		for (const file of remote.files) {
			this.acked.set(file.path, { sha256: file.sha256, rev: file.rev });
		}
		for (const entry of remote.pluginData) {
			this.acked.set(`plugins/${entry.pluginId}/data.json`, {
				sha256: entry.sha256,
				rev: entry.rev,
			});
		}
		this.rememberEnvironment(remote);
		this.lastAppliedEnvRev = remote.envRev;
	}

	private rememberEnvironment(remote: SettingsSyncSeeded): void {
		this.lastRemote = remote;
		this.patch({
			environmentPlugins: remote.intents
				.slice(0, SETTINGS_SYNC_MAX_INTENTS)
				.map(({ id, version, enabled }) => ({ id, version, enabled })),
			environmentThemes: remote.themes
				.slice(0, SETTINGS_SYNC_MAX_THEMES)
				.map(({ name, version }) => ({ name, version })),
		});
	}

	private async acceptEnvironment(): Promise<void> {
		const scope = await this.queueScope();
		if (!scope) throw new Error("cannot accept an incomplete settings identity");
		await markEnvironmentAccepted(scope);
		this.environmentAccepted = true;
	}

	private async markDecisionRequired(key: string): Promise<void> {
		const probe = await this.probeBlank();
		if (this.stopped) return;
		this.patch({
			running: false,
			reason: "decision-required",
			seeded: true,
			needsSeed: true,
			seedKind: probe.kind,
			deferred: false,
			error: null,
		});
		if (!this.seedUiShown) {
			this.seedUiShown = true;
			this.opts.onNeedsSeed?.({ key, blank: probe.blank });
		}
	}

	private async markUnseeded(key: string): Promise<void> {
		const probe = await this.probeBlank();
		const deferred = this.isDeferred();
		this.patch({
			running: false,
			reason: deferred ? "deferred" : "unseeded",
			seeded: false,
			needsSeed: !deferred,
			seedKind: probe.kind,
			deferred,
		});
		if (!deferred && !this.seedUiShown) {
			this.seedUiShown = true;
			this.opts.onNeedsSeed?.({ key, blank: probe.blank });
		}
	}

	private async probeBlank(): Promise<{ blank: boolean; kind: "blank" | "occupied" }> {
		const adapter = this.adapter();
		const configDir = this.configDir();
		let communityPluginIds: string[] | null = null;
		let snippetFiles: string[] | null = [];
		let unsure = false;
		try {
			const plugins = await adapter.list(joinConfig(configDir, "plugins"));
			communityPluginIds = plugins.folders.map(folderBasename).filter((id) => id.length > 0);
		} catch {
			unsure = true;
		}
		try {
			const snippets = await adapter.list(joinConfig(configDir, "snippets"));
			snippetFiles = snippets.files.map(folderBasename).filter((name) => name.endsWith(".css"));
		} catch {
			snippetFiles = [];
		}
		let hasHotkeys = false;
		try {
			const raw = await adapter.read(joinConfig(configDir, "hotkeys.json"));
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
				hasHotkeys = true;
			}
		} catch {
			hasHotkeys = false;
		}
		const blank = isBlankConfigDir({ communityPluginIds, snippetFiles, hasHotkeys, unsure });
		return { blank, kind: blank ? "blank" : "occupied" };
	}

	private async detectClash(): Promise<string | null> {
		const adapter = this.adapter();
		const configDir = this.configDir();
		const coreEnabled = await readEnabledCore(adapter, configDir);
		const communityEnabled = [...(await this.communityEnabledIds())];
		return detectSettingsSyncClash({ coreEnabled, communityEnabled });
	}

	private async communityEnabledIds(): Promise<Set<string>> {
		const fromApp = this.opts.app.plugins?.enabledPlugins;
		if (fromApp instanceof Set) {
			const ids = new Set<string>();
			for (const id of fromApp) {
				if (typeof id === "string") ids.add(id);
			}
			if (ids.size > 0) return ids;
		}
		const ids = new Set<string>();
		try {
			const raw = await this.adapter().read(joinConfig(this.configDir(), "community-plugins.json"));
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				for (const id of parsed) {
					if (typeof id === "string") ids.add(id);
				}
			}
		} catch {
			// missing list
		}
		return ids;
	}

	private isCommunityEnabled(id: string): boolean {
		const fromApp = this.opts.app.plugins?.enabledPlugins;
		if (fromApp instanceof Set) return fromApp.has(id);
		return false;
	}

	private async localManifestMap(): Promise<Map<string, ApplyPluginManifest>> {
		const map = new Map<string, ApplyPluginManifest>();
		const plugins = await listSafe(this.adapter(), joinConfig(this.configDir(), "plugins"));
		for (const folder of plugins.folders) {
			const id = folderBasename(folder);
			if (!id) continue;
			const manifest = await this.readPluginManifest(id);
			if (manifest) map.set(id, manifest);
		}
		return map;
	}

	private async readPluginManifest(pluginId: string): Promise<ApplyPluginManifest | null> {
		try {
			const raw = await this.adapter().read(
				joinConfig(this.configDir(), `plugins/${pluginId}/manifest.json`),
			);
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			const rec = parsed as Record<string, unknown>;
			const id = typeof rec.id === "string" ? rec.id : pluginId;
			const version = typeof rec.version === "string" ? rec.version : null;
			if (!version) return null;
			return {
				id,
				version,
				name: typeof rec.name === "string" ? rec.name : undefined,
				minAppVersion: typeof rec.minAppVersion === "string" ? rec.minAppVersion : undefined,
				isDesktopOnly: rec.isDesktopOnly === true,
				author: typeof rec.author === "string" ? rec.author : undefined,
				description: typeof rec.description === "string" ? rec.description : undefined,
			};
		} catch {
			return null;
		}
	}

	private async readThemeManifest(name: string): Promise<{ version: string } | null> {
		try {
			const raw = await this.adapter().read(
				joinConfig(this.configDir(), `themes/${name}/manifest.json`),
			);
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			const rec = parsed as Record<string, unknown>;
			return typeof rec.version === "string" ? { version: rec.version } : null;
		} catch {
			return null;
		}
	}

	private async loadCatalogs(): Promise<CatalogMaps> {
		const plugins = new Map<string, string>();
		const themes = new Map<string, string>();
		await Promise.all([
			fillCatalog(COMMUNITY_PLUGINS_CATALOG_URL, plugins, "id"),
			fillCatalog(THEME_CATALOG_URL, themes, "name"),
		]);
		return { plugins, themes };
	}

	private refreshMismatches(_local: Map<string, LocalConfigFile>, remote: SettingsSyncSeeded): void {
		void this.collectMismatches(remote).then((versionMismatches) => {
			if (!this.stopped) this.patch({ versionMismatches: versionMismatches.slice(0, SETTINGS_SYNC_MAX_INTENTS) });
		});
	}


	private async collectMismatches(remote: SettingsSyncSeeded): Promise<SettingsVersionMismatch[]> {
		const mismatches: SettingsVersionMismatch[] = [];
		const seen = new Set<string>();
		for (const intent of remote.intents) {
			const local = await this.readPluginManifest(intent.id);
			const localVersion = local?.version ?? "";
			if (!localVersion || localVersion === intent.version) continue;
			seen.add(intent.id);
			mismatches.push({
				pluginId: intent.id,
				localVersion,
				pin: intent.version,
				localAhead: compareDottedVersion(localVersion, intent.version) > 0,
			});
		}
		for (const entry of remote.pluginData) {
			if (seen.has(entry.pluginId)) continue;
			const local = await this.readPluginManifest(entry.pluginId);
			const localVersion = local?.version ?? "";
			const intent = remote.intents.find((row) => row.id === entry.pluginId);
			const pin = intent?.version ?? entry.pluginVersion;
			if (localVersion && localVersion === pin && pin === entry.pluginVersion) continue;
			mismatches.push({
				pluginId: entry.pluginId,
				localVersion,
				pin,
				localAhead: compareDottedVersion(localVersion, pin) > 0,
			});
		}
		return mismatches;
	}

	private noteMismatch(pluginId: string, localVersion: string, pin: string): void {
		const existing = this.snapshot.versionMismatches.filter((row) => row.pluginId !== pluginId);
		existing.push({
			pluginId,
			localVersion,
			pin,
			localAhead: compareDottedVersion(localVersion, pin) > 0,
		});
		this.patch({ versionMismatches: existing.slice(0, SETTINGS_SYNC_MAX_INTENTS) });
	}
	private noteUnknown(names: readonly string[]): void {
		const unknownFiles = this.unknown.note(names, this.isDebug()).slice(0, SETTINGS_SYNC_MAX_INTENTS);
		this.patch({ unknownFiles });
	}

	private hookInstallPlugin(): void {
		const plugins = this.opts.app.plugins;
		if (!plugins) return;
		// eslint-disable-next-line @typescript-eslint/unbound-method -- retain the exact host function for restoration; invocation below uses call(plugins).
		const originalInstall = plugins.installPlugin;
		if (typeof originalInstall === "function" && !this.originalInstallPlugin) {
			this.originalInstallPlugin = originalInstall;
			plugins.installPlugin = async (repo, version, manifest) => {
				const hooked = this.originalInstallPlugin;
				if (!hooked) return;
				await hooked.call(plugins, repo, version, manifest);
				const id = manifest?.id;
				if (typeof id !== "string") return;
				if ((SETTINGS_SYNC_SKIP_PLUGIN_IDS as readonly string[]).includes(id)) return;
				void this.notifyCatalogInstall({
					id,
					repo,
					version,
					enabled: this.isCommunityEnabled(id),
				});
			};
		}
		// eslint-disable-next-line @typescript-eslint/unbound-method -- retain the exact host function for restoration; invocation below uses call(plugins).
		const originalEnable = plugins.enablePluginAndSave;
		if (typeof originalEnable === "function" && !this.originalEnablePluginAndSave) {
			this.originalEnablePluginAndSave = originalEnable;
			plugins.enablePluginAndSave = async (id: string) => {
				const hooked = this.originalEnablePluginAndSave;
				const ok = hooked ? await hooked.call(plugins, id) : false;
				if (ok && !(SETTINGS_SYNC_SKIP_PLUGIN_IDS as readonly string[]).includes(id)) {
					const repo = this.lastRemote?.intents.find((row) => row.id === id)?.repo
						?? (await this.loadCatalogs()).plugins.get(id);
					const version = this.opts.app.plugins?.manifests?.[id]?.version;
					if (repo && version) void this.notifyCatalogInstall({ id, repo, version, enabled: true });
				}
				return ok;
			};
		}
	}

	private unhookInstallPlugin(): void {
		const plugins = this.opts.app.plugins;
		if (plugins && this.originalInstallPlugin) {
			plugins.installPlugin = this.originalInstallPlugin;
		}
		if (plugins && this.originalEnablePluginAndSave) {
			plugins.enablePluginAndSave = this.originalEnablePluginAndSave;
		}
		this.originalInstallPlugin = null;
		this.originalEnablePluginAndSave = null;
	}

	private async applyCtx(key: string): Promise<ApplyContext> {
		const conn = this.conn();
		const adapter = this.adapter();
		const generation = this.generation;
		return {
			app: this.opts.app,
			adapter: {
				write: (path, data) => adapter.write(path, data),
				remove: (path) => adapter.remove(path),
				mkdir: (path) => adapter.mkdir(path),
				exists: (path) => adapter.exists(path),
				rmdir: (path, recursive) => this.opts.app.vault.adapter.rmdir(path, recursive === true),
			},
			configDir: this.configDir(),
			hostHash: await sha256TextHex(conn.host),
			vaultId: conn.vaultId,
			vaultGeneration: conn.vaultGeneration,
			folderKey: this.opts.folderKey,
			deviceId: conn.deviceId,
			configDirKey: key,
			indexedDb: this.opts.indexedDb,
			isHidden: () => this.isSettingsHidden(),
			isActive: () => this.isCurrent(generation),
			beforeStep: (index) => {
				this.patch({
					pendingApplySteps: Math.max(0, this.snapshot.pendingApplyTotal - index),
				});
			},
			recordReason: (code, detail) => {
				if (this.stopped) return;
				this.patch({
					error: detail ? `${code}:${detail}` : code,
					...(code === "settings.plugin_removed_restart" ? { needsRestart: true } : {}),
				});
			},
		};
	}

	private async runApplyBatch(key: string, batch: ApplyBatch): Promise<boolean> {
		this.patch({
			pendingApplySteps: batch.steps.length,
			pendingApplyTotal: batch.steps.length,
		});
		try {
			return await persistAndRunApplyBatch(await this.applyCtx(key), batch) === "complete";
		} finally {
			await this.refreshApplyQueueStatus(await this.queueScope());
		}
	}


	private async refreshApplyQueueStatus(scope: ApplyQueueScope | null): Promise<void> {
		const record = scope ? await loadApplyQueue(scope) : null;
		const total = record?.steps.length ?? 0;
		const nextIndex = record?.nextIndex ?? 0;
		this.patch({
			pendingApplySteps: Math.max(0, total - nextIndex),
			pendingApplyTotal: total,
		});
	}

	private client(): SettingsSyncClient {
		const conn = this.conn();
		const options: SettingsSyncClientOptions = {
			host: conn.host,
			deviceToken: conn.deviceToken,
			vaultId: conn.vaultId,
		};
		return this.opts.createClient?.(options) ?? new SettingsSyncClient(options);
	}

	private conn(): {
		host: string;
		deviceToken: string;
		vaultId: string;
		vaultGeneration: string;
		deviceId: string;
	} {
		const settings = this.opts.getSettings();
		return {
			host: (settings.host ?? "").replace(/\/$/, ""),
			deviceToken: settings.deviceToken ?? "",
			vaultId: settings.vaultId ?? "",
			vaultGeneration: settings.vaultGeneration ?? "",
			deviceId: settings.deviceId ?? "",
		};
	}

	private adapter(): SettingsDirAdapter {
		return this.opts.adapter ?? this.opts.app.vault.adapter;
	}

	private configDir(): string {
		return this.opts.app.vault.configDir;
	}

	private configKey(): string | null {
		const raw = this.opts.configDirBasename ?? this.opts.app.vault.configDir;
		return sanitizeConfigDirKey(raw);
	}

	private requireKey(): string | null {
		const key = this.configKey();
		if (!key) {
			this.patch({ reason: "invalid-key", headline: "invalid_config_key", running: false });
		}
		return key;
	}

	private isMasterEnabled(): boolean {
		return this.opts.getSettings().settingsSyncEnabled !== false;
	}

	private isAutoInstall(): boolean {
		return this.opts.getSettings().settingsSyncAutoInstall === true;
	}

	private isDeferred(): boolean {
		return this.opts.getSettings().settingsSyncDeferred === true;
	}

	private isDebug(): boolean {
		return this.opts.getSettings().debug === true;
	}
	private isCurrent(generation: number): boolean {
		return !this.stopped && generation === this.generation;
	}

	private hasCompleteIdentity(): boolean {
		const conn = this.conn();
		return Boolean(
			conn.host
			&& conn.deviceToken
			&& conn.vaultId
			&& conn.vaultGeneration
			&& conn.deviceId
			&& this.opts.folderKey.trim(),
		);
	}

	private async queueScope(): Promise<ApplyQueueScope | null> {
		const configDirKey = this.configKey();
		if (!configDirKey || !this.hasCompleteIdentity()) return null;
		const conn = this.conn();
		return {
			hostHash: await sha256TextHex(conn.host),
			vaultId: conn.vaultId,
			vaultGeneration: conn.vaultGeneration,
			folderKey: this.opts.folderKey,
			deviceId: conn.deviceId,
			configDirKey,
			indexedDb: this.opts.indexedDb,
		};
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.operationTail.then(operation, operation);
		this.operationTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}


	private canMutate(): boolean {
		if (
			this.stopped
			|| !this.environmentAccepted
			|| !this.isMasterEnabled()
			|| !this.hasCompleteIdentity()
		) return false;
		const capabilities = this.opts.getCapabilities();
		if (!capabilities?.settingsSync || capabilities.settingsFormatVersion !== SETTINGS_SYNC_FORMAT_VERSION) return false;
		if (this.snapshot.reason === "clash" || this.snapshot.clashId) return false;
		return this.configKey() !== null;
	}

	private canSeed(): boolean {
		if (this.stopped || !this.isMasterEnabled() || !this.hasCompleteIdentity()) return false;
		const capabilities = this.opts.getCapabilities();
		if (!capabilities?.settingsSync || capabilities.settingsFormatVersion !== SETTINGS_SYNC_FORMAT_VERSION) return false;
		if (this.snapshot.clashId) return false;
		return this.configKey() !== null;
	}

	private patch(patch: Partial<SettingsSyncStatus>): void {
		this.snapshot = withStatusPatch(this.snapshot, patch);
		this.opts.onStatus?.(this.snapshot);
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
	}
	return btoa(chunks.join(""));
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function jsonQuarantineOk(rel: string, bytes: Uint8Array): boolean {
	if (!rel.endsWith(".json")) return true;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

async function writeConfigFile(
	adapter: SettingsDirAdapter,
	configDir: string,
	rel: string,
	bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
	const abs = joinConfig(configDir, rel);
	await ensureParent(adapter, abs);
	if (adapter.writeBinary) {
		await adapter.writeBinary(abs, bytes.buffer);
		return;
	}
	await adapter.write(abs, new TextDecoder("utf-8").decode(bytes));
}

async function removeConfigFile(
	adapter: SettingsDirAdapter,
	configDir: string,
	rel: string,
): Promise<void> {
	try {
		await adapter.remove(joinConfig(configDir, rel));
	} catch {
		// already gone
	}
}

async function ensureParent(adapter: SettingsDirAdapter, fullPath: string): Promise<void> {
	const n = fullPath.replace(/\\/g, "/");
	const slash = n.lastIndexOf("/");
	if (slash <= 0) return;
	const dir = n.slice(0, slash);
	if (adapter.exists && (await adapter.exists(dir))) return;
	await ensureParent(adapter, dir);
	try {
		await adapter.mkdir(dir);
	} catch {
		// exists
	}
}

async function readEnabledCore(adapter: SettingsDirAdapter, configDir: string): Promise<string[]> {
	try {
		const raw = await adapter.read(joinConfig(configDir, "core-plugins.json"));
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		const rec = parsed as Record<string, unknown>;
		const ids: string[] = [];
		for (const id of Object.keys(rec)) {
			if (rec[id] === true) ids.push(id);
		}
		return ids;
	} catch {
		return [];
	}
}

async function listSafe(
	adapter: SettingsDirAdapter,
	path: string,
): Promise<{ files: string[]; folders: string[] }> {
	try {
		if (adapter.exists && !(await adapter.exists(path))) return { files: [], folders: [] };
		return await adapter.list(path);
	} catch {
		return { files: [], folders: [] };
	}
}

function folderBasename(path: string): string {
	const n = path.replace(/\\/g, "/");
	const i = n.lastIndexOf("/");
	return i >= 0 ? n.slice(i + 1) : n;
}

async function fillCatalog(
	url: string,
	into: Map<string, string>,
	keyField: "id" | "name",
): Promise<void> {
	try {
		const res = await obsidianRequest({ url, method: "GET" });
		if (res.status !== 200) return;
		const json: unknown = res.json;
		if (!Array.isArray(json)) return;
		for (const row of json) {
			if (!row || typeof row !== "object") continue;
			const rec = row as Record<string, unknown>;
			const key = rec[keyField];
			const repo = rec.repo;
			if (typeof key === "string" && typeof repo === "string") into.set(key, repo);
		}
	} catch {
		// catalog optional for seed
	}
}
