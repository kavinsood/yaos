import { randomBase64Url } from "../utils/base64url";

/** Controls how external disk edits (git, other editors) are imported into CRDT. */
export type ExternalEditPolicy = "always" | "closed-only" | "never";

export interface VaultSyncSettings {
	/** Cloudflare Worker host, e.g. "https://sync.yourdomain.com" */
	host: string;
	/** Shared secret token for auth. */
	token: string;
	/** Unique vault identifier. Generated randomly if empty on first load. */
	vaultId: string;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Enable verbose console.log output for debugging. */
	debug: boolean;
	/** Pause propagation of suspicious YAML frontmatter transitions. */
	frontmatterGuardEnabled: boolean;
	/** Comma-separated path prefixes to exclude from sync. */
	excludePatterns: string;
	/** Maximum file size in KB to sync via CRDT. Files larger are skipped. */
	maxFileSizeKB: number;
	/**
	 * How to handle external disk modifications (git pull, other editors).
	 *   "always"      — always import into CRDT (default, current behavior)
	 *   "closed-only" — import only for files not open in an editor
	 *   "never"       — never import (CRDT is sole source of truth)
	 */
	externalEditPolicy: ExternalEditPolicy;
	/** Enable attachment (non-markdown) sync via R2 blob store. */
	enableAttachmentSync: boolean;
	/** True once the user has explicitly changed the attachment sync toggle. */
	attachmentSyncExplicitlyConfigured: boolean;
	/** Maximum attachment size in KB. Files larger are skipped. Default 10240 (10 MB). */
	maxAttachmentSizeKB: number;
	/** Number of parallel upload/download slots. */
	attachmentConcurrency: number;
	/** Show remote cursors and selections in the editor. */
	showRemoteCursors: boolean;
	/** Optional repo URL used to deep-link provider-native update pages. */
	updateRepoUrl: string;
	/** Optional default branch for provider-native update links. */
	updateRepoBranch: string;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	token: "",
	vaultId: "",
	deviceName: "",
	debug: false,
	frontmatterGuardEnabled: true,
	excludePatterns: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "always",
	enableAttachmentSync: true,
	attachmentSyncExplicitlyConfigured: false,
	maxAttachmentSizeKB: 10240,
	// requestUrl cannot be hard-aborted; default to 1 to avoid stacked zombie transfers.
	attachmentConcurrency: 1,
	showRemoteCursors: true,
	updateRepoUrl: "",
	updateRepoBranch: "main",
};

export interface SettingsPersistence {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

export interface SettingsLoadResult<TState extends Partial<VaultSyncSettings>> {
	settings: VaultSyncSettings;
	persistedState: TState;
	migrated: boolean;
}

/** Generate a random vault ID (16 bytes, base64url). */
export function generateVaultId(): string {
	return randomBase64Url(16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readPersistedState<TState extends Partial<VaultSyncSettings>>(value: unknown): TState {
	return isRecord(value) ? { ...value } as TState : {} as TState;
}

export function readVaultSyncSettings(
	data: Partial<VaultSyncSettings> | null | undefined,
): { settings: VaultSyncSettings; migrated: boolean } {
	const settings = Object.assign(
		{},
		DEFAULT_SETTINGS,
		data as Partial<VaultSyncSettings>,
	);
	let migrated = false;
	if (typeof data?.attachmentSyncExplicitlyConfigured !== "boolean") {
		settings.attachmentSyncExplicitlyConfigured = data?.enableAttachmentSync === true;
		if (data?.enableAttachmentSync !== true) {
			settings.enableAttachmentSync = true;
		}
		migrated = true;
	}
	return { settings, migrated };
}

export class SettingsStore<TState extends Partial<VaultSyncSettings>> {
	constructor(private readonly persistence: SettingsPersistence) {}

	async load(): Promise<SettingsLoadResult<TState>> {
		const persistedState = readPersistedState<TState>(await this.persistence.loadData());
		const { settings, migrated } = readVaultSyncSettings(persistedState);
		return {
			settings,
			persistedState,
			migrated,
		};
	}

	async save(state: TState): Promise<void> {
		await this.persistence.saveData({ ...state });
	}

	withSettings(state: TState, settings: VaultSyncSettings): TState {
		return {
			...state,
			...settings,
		};
	}
}
