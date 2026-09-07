import type { ExternalEditPolicy, VaultSyncSettings } from "../settings";
import { parseExcludePatterns } from "../sync/exclude";
import { MAX_CLIENT_MARKDOWN_BYTES, MAX_CLIENT_MARKDOWN_KB } from "@shared/durableLimits";

export interface RuntimeConfig {
	host: string;
	deviceToken: string;
	vaultId: string;
	deviceName: string;
	debug: boolean;
	frontmatterGuardEnabled: boolean;
	excludePatterns: string[];
	maxFileSizeBytes: number;
	maxFileSizeKB: number;
	externalEditPolicy: ExternalEditPolicy;
	enableAttachmentSync: boolean;
	attachmentSyncExplicitlyConfigured: boolean;
	maxAttachmentSizeKB: number;
	attachmentConcurrency: number;
	showRemoteCursors: boolean;
	updateRepoUrl: string;
	updateRepoBranch: string;
	vaultConfigDir: string;
}

export function buildRuntimeConfig(
	settings: VaultSyncSettings,
	vaultConfigDir: string,
): RuntimeConfig {
	const configuredMaxFileSizeKB = Number.isSafeInteger(settings.maxFileSizeKB)
		? Math.max(1, settings.maxFileSizeKB)
		: MAX_CLIENT_MARKDOWN_KB;
	const maxFileSizeBytes = Math.min(
		MAX_CLIENT_MARKDOWN_BYTES,
		configuredMaxFileSizeKB * 1024,
	);
	return {
		host: settings.host.trim(),
		deviceToken: settings.deviceToken.trim(),
		vaultId: settings.vaultId.trim(),
		deviceName: settings.deviceName.trim(),
		debug: settings.debug,
		frontmatterGuardEnabled: settings.frontmatterGuardEnabled,
		excludePatterns: parseExcludePatterns(settings.excludePatterns),
		maxFileSizeBytes,
		maxFileSizeKB: Math.ceil(maxFileSizeBytes / 1024),
		externalEditPolicy: settings.externalEditPolicy,
		enableAttachmentSync: settings.enableAttachmentSync,
		attachmentSyncExplicitlyConfigured: settings.attachmentSyncExplicitlyConfigured,
		maxAttachmentSizeKB: settings.maxAttachmentSizeKB,
		attachmentConcurrency: settings.attachmentConcurrency,
		showRemoteCursors: settings.showRemoteCursors,
		updateRepoUrl: settings.updateRepoUrl.trim(),
		updateRepoBranch: settings.updateRepoBranch.trim() || "main",
		vaultConfigDir,
	};
}
