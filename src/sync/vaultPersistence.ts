import { sha256TextHex } from "../utils/sha256";

/** First 16 hex characters of SHA-256, scoped to one local Obsidian folder. */
export const FOLDER_KEY_HEX_LENGTH = 16;

export function folderKeySeed(input: {
	basePath?: string | null;
	vaultName: string;
}): string {
	const basePath = typeof input.basePath === "string" ? input.basePath.trim() : "";
	return basePath || input.vaultName;
}

export function folderKeySeedFromVault(vault: {
	getName(): string;
	adapter: unknown;
}): string {
	const adapter = typeof vault.adapter === "object" && vault.adapter !== null
		? vault.adapter as { getBasePath?: () => string }
		: {};
	const getBasePath = adapter.getBasePath;
	const basePath = typeof getBasePath === "function" ? getBasePath.call(adapter) : "";
	return folderKeySeed({ basePath, vaultName: vault.getName() });
}

export async function computeFolderKey(seed: string): Promise<string> {
	const hex = await sha256TextHex(seed);
	return hex.slice(0, FOLDER_KEY_HEX_LENGTH);
}

export function vaultIdbName(vaultId: string, folderKey: string): string {
	return `yaos:${vaultId}:${folderKey}`;
}

export function readSysGeneration(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.floor(value);
}

export function nextSysGeneration(value: unknown): number {
	return readSysGeneration(value) + 1;
}

export function receiptRoomName(vaultId: string, generation: number): string {
	return `${vaultId}:${generation}`;
}
