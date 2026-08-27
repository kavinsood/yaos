/** Controls how external disk edits (git, other editors) are imported into CRDT. */
export type ExternalEditPolicy = "always" | "closed-only" | "never";
export const MAX_ATTACHMENT_SIZE_KB = 10 * 1024;

export function attachmentSizeCapKB(serverMaxBlobUploadBytes?: number | null): number {
	if (
		typeof serverMaxBlobUploadBytes !== "number" ||
		!Number.isFinite(serverMaxBlobUploadBytes) ||
		serverMaxBlobUploadBytes <= 0
	) {
		return MAX_ATTACHMENT_SIZE_KB;
	}
	return Math.max(1, Math.min(MAX_ATTACHMENT_SIZE_KB, Math.floor(serverMaxBlobUploadBytes / 1024)));
}

export interface PendingEnrollment {
	host: string;
	pairingCode: string;
	enrollmentRequestId: string;
	deviceId: string;
	deviceToken: string;
	deviceName: string;
}

export interface VaultSyncSettings {
	/** Cloudflare Worker host, e.g. "https://sync.yourdomain.com" */
	host: string;
	/** Device bearer minted at enrollment. Never the operator recovery key. */
	deviceToken: string;
	/** Server-minted vault identifier. */
	vaultId: string;
	/** Server-minted device identifier for this enrollment. */
	deviceId: string;
	/** Exact provisioned storage incarnation for this enrollment. */
	vaultGeneration: string;
	/** One-use authority for this folder to seed the newly provisioned vault. */
	originImportPending: boolean;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Durable client-generated enrollment request, retained until credentials are saved. */
	pendingEnrollment?: PendingEnrollment | null;
	/**
	 * Debug mode: verbose console logging plus the flight recorder that backs
	 * the exportable bug-report trace. Single switch; off by default.
	 */
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
	/** Maximum attachment size in KB. Files larger are skipped. Capped at 10240 (10 MB). */
	maxAttachmentSizeKB: number;
	/** Number of parallel upload/download slots. */
	attachmentConcurrency: number;
	/** Show remote cursors and selections in the editor. */
	showRemoteCursors: boolean;
	/** Optional repo URL used to deep-link provider-native update pages. */
	updateRepoUrl: string;
	/** Optional default branch for provider-native update links. */
	updateRepoBranch: string;
	/** Expose window.__YAOS_DEBUG__ programmatic control surface for QA. Never ship enabled. */
	qaDebugMode: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	deviceToken: "",
	vaultId: "",
	deviceId: "",
	vaultGeneration: "",
	originImportPending: false,
	deviceName: "",
	pendingEnrollment: null,
	debug: false,
	frontmatterGuardEnabled: true,
	excludePatterns: "",
	maxFileSizeKB: 2048,
	externalEditPolicy: "always",
	enableAttachmentSync: true,
	attachmentSyncExplicitlyConfigured: false,
	maxAttachmentSizeKB: MAX_ATTACHMENT_SIZE_KB,
	// requestUrl cannot be hard-aborted; default to 1 to avoid stacked zombie transfers.
	attachmentConcurrency: 1,
	showRemoteCursors: true,
	updateRepoUrl: "",
	updateRepoBranch: "main",
	qaDebugMode: false,
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


function readPersistedState<TState extends Partial<VaultSyncSettings>>(value: unknown): TState {
	if (typeof value !== "object" || value === null) return {} as TState;
	const state: Record<string, unknown> = { ...value };
	Reflect.deleteProperty(state, "token");
	return state as TState;
}

function readPendingEnrollment(value: unknown): PendingEnrollment | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const keys = ["host", "pairingCode", "enrollmentRequestId", "deviceId", "deviceToken", "deviceName"];
	if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) return null;
	if (
		typeof record.host !== "string" || !record.host.trim() || record.host.trim() !== record.host || record.host.length > 2_048
		|| typeof record.pairingCode !== "string" || record.pairingCode.length < 8 || record.pairingCode.length > 512
		|| typeof record.enrollmentRequestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(record.enrollmentRequestId)
		|| typeof record.deviceId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(record.deviceId)
		|| typeof record.deviceToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(record.deviceToken)
		|| typeof record.deviceName !== "string" || record.deviceName.length > 80 || record.deviceName.trim() !== record.deviceName
	) {
		return null;
	}
	try {
		const host = new URL(record.host);
		if ((host.protocol !== "https:" && host.protocol !== "http:") || host.origin !== record.host) return null;
	} catch {
		return null;
	}
	return {
		host: record.host,
		pairingCode: record.pairingCode,
		enrollmentRequestId: record.enrollmentRequestId,
		deviceId: record.deviceId,
		deviceToken: record.deviceToken,
		deviceName: record.deviceName,
	};
}

export function readVaultSyncSettings(
	data: Partial<VaultSyncSettings> | Record<string, unknown> | null | undefined,
): { settings: VaultSyncSettings; migrated: boolean } {
	const record = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
	const settings = Object.assign({}, DEFAULT_SETTINGS, record);
	Reflect.deleteProperty(settings, "token");
	let migrated = "token" in record;
	const hasCompleteEnrollment = [
		settings.host,
		settings.deviceToken,
		settings.vaultId,
		settings.deviceId,
		settings.vaultGeneration,
	].every((value) => typeof value === "string" && value.trim().length > 0);
	if (!hasCompleteEnrollment) {
		if (settings.deviceToken || settings.vaultId || settings.deviceId || settings.vaultGeneration) migrated = true;
		settings.deviceToken = "";
		settings.vaultId = "";
		settings.deviceId = "";
		settings.vaultGeneration = "";
		settings.originImportPending = false;
	}
	if (typeof settings.originImportPending !== "boolean") {
		settings.originImportPending = false;
		migrated = true;
	}
	const pendingEnrollment = readPendingEnrollment(record.pendingEnrollment);
	if (record.pendingEnrollment !== null && record.pendingEnrollment !== undefined && pendingEnrollment === null) {
		migrated = true;
	}
	settings.pendingEnrollment = pendingEnrollment;
	if (typeof record.attachmentSyncExplicitlyConfigured !== "boolean") {
		settings.attachmentSyncExplicitlyConfigured = record.enableAttachmentSync === true;
		if (record.enableAttachmentSync !== true) {
			settings.enableAttachmentSync = true;
		}
		migrated = true;
	}
	if (
		typeof settings.maxAttachmentSizeKB !== "number" ||
		!Number.isFinite(settings.maxAttachmentSizeKB) ||
		settings.maxAttachmentSizeKB <= 0 ||
		settings.maxAttachmentSizeKB > attachmentSizeCapKB()
	) {
		settings.maxAttachmentSizeKB = Math.min(
			attachmentSizeCapKB(),
			Math.max(1, Math.floor(Number(settings.maxAttachmentSizeKB) || DEFAULT_SETTINGS.maxAttachmentSizeKB)),
		);
		migrated = true;
	}
	return { settings, migrated };
}

export class SettingsStore<TState extends Partial<VaultSyncSettings>> {
	constructor(private readonly persistence: SettingsPersistence) {}

	async load(): Promise<SettingsLoadResult<TState>> {
		const raw = await this.persistence.loadData();
		const { settings, migrated } = readVaultSyncSettings(
			typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined,
		);
		const persistedState = readPersistedState<TState>(raw);
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
		const next: TState & VaultSyncSettings = {
			...state,
			...settings,
		};
		Reflect.deleteProperty(next, "token");
		return next;
	}
}
