import type { DataAdapter } from "obsidian";
import { canonicalizeVaultPath } from "../paths/canonicalPath";

/** Ensure a vault-relative adapter directory and all of its parents exist. */
export async function ensureAdapterDirectory(adapter: DataAdapter, path: string): Promise<void> {
	const normalized = canonicalizeVaultPath(path).normalizedPath;
	if (!normalized) return;

	const parts = normalized.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (await adapter.exists(current)) continue;
		try {
			await adapter.mkdir(current);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.toLowerCase().includes("exists") || await adapter.exists(current)) continue;
			throw error;
		}
	}
}
