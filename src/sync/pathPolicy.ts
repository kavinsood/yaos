import {
	safeBlobPath as safeSharedBlobPath,
	safeMarkdownPath as safeSharedMarkdownPath,
} from "@shared/vaultPath";
import { canonicalizeVaultPath } from "../paths/canonicalPath";
import { isBlobSyncable, isMarkdownSyncable } from "../types";

type BlobPathRef = { hash: string; size: number };

/** Shared fail-closed path contract plus client-specific Markdown exclusions. */
export function safeMarkdownPath(
	path: string,
	excludePatterns: readonly string[] = [],
	configDir = "",
): string | null {
	const canonical = safeSharedMarkdownPath(path, configDir);
	const canonicalKey = canonicalizeVaultPath(path).canonicalKey;
	return canonical !== null
		&& canonical === canonicalKey
		&& isMarkdownSyncable(canonical, [...excludePatterns], configDir)
		? canonical
		: null;
}

/** Shared fail-closed path/reference contract plus client-specific blob exclusions. */
export function safeBlobPath(
	path: string,
	excludePatterns: readonly string[] = [],
	configDir = "",
	ref?: BlobPathRef,
): string | null {
	const canonical = safeSharedBlobPath(path, configDir, ref);
	const canonicalKey = canonicalizeVaultPath(path).canonicalKey;
	return canonical !== null
		&& canonical === canonicalKey
		&& isBlobSyncable(canonical, [...excludePatterns], configDir)
		? canonical
		: null;
}
