/**
 * Vault operations for the QA harness.
 *
 * THREE write modes — be explicit in scenarios:
 *
 *   obsidian-api    app.vault.create/modify — goes through Obsidian event pipeline
 *   adapter-write   app.vault.adapter.write — bypasses Obsidian metadata but still
 *                   routes through the adapter. NOT the same as a real external write.
 *                   Use for: iOS/Android simulation, adapter-layer tests.
 *   (external-fs)   Real Node fs.writeFile, used from the controller side
 *                   (qa/controllers/obsidian-client.ts). Not callable from harness.
 *
 * THREE delete modes:
 *
 *   vault-delete    app.vault.delete(file, true) — permanent, normal Obsidian behavior
 *   trash           app.vault.trash(file, true) — moves to system trash (user behavior)
 *   adapter-remove  app.vault.adapter.remove() — raw adapter delete (simulates fs rm)
 */

import { normalizePath, TFile, type App } from "obsidian";

export type DeleteMode = "vault-delete" | "trash" | "adapter-remove";

// -----------------------------------------------------------------------
// Obsidian-native operations
// -----------------------------------------------------------------------

export async function createFile(app: App, path: string, content: string): Promise<void> {
	const normalized = normalizePath(path);
	const parts = normalized.split("/");
	parts.pop();
	if (parts.length > 0) {
		const folder = parts.join("/");
		if (!app.vault.getAbstractFileByPath(folder)) {
			await app.vault.createFolder(folder).catch(() => { /* already exists */ });
		}
	}
	const existing = app.vault.getFileByPath(normalized);
	if (existing) {
		await app.vault.modify(existing, content);
	} else {
		await app.vault.create(normalized, content);
	}
}

export async function modifyFile(app: App, path: string, content: string): Promise<void> {
	const normalized = normalizePath(path);
	const file = app.vault.getFileByPath(normalized);
	if (!file) throw new Error(`modifyFile: file not found: ${normalized}`);
	await app.vault.modify(file, content);
}

export async function appendToFile(app: App, path: string, text: string): Promise<void> {
	const normalized = normalizePath(path);
	const file = app.vault.getFileByPath(normalized);
	if (!file) throw new Error(`appendToFile: file not found: ${normalized}`);
	const existing = await app.vault.read(file);
	await app.vault.modify(file, existing + text);
}

export async function deleteFile(
	app: App,
	path: string,
	mode: DeleteMode = "vault-delete",
): Promise<void> {
	const normalized = normalizePath(path);
	const file = app.vault.getAbstractFileByPath(normalized);
	if (!file) return; // already gone

	switch (mode) {
		case "vault-delete":
			await app.vault.delete(file, true);
			break;
		case "trash":
			await app.vault.trash(file, true);
			break;
		case "adapter-remove":
			if (file instanceof TFile) {
				await app.vault.adapter.remove(normalized);
			} else {
				await app.vault.delete(file, true);
			}
			break;
	}
}

export async function renameFile(app: App, oldPath: string, newPath: string): Promise<void> {
	const normalized = normalizePath(oldPath);
	const file = app.vault.getFileByPath(normalized);
	if (!file) throw new Error(`renameFile: file not found: ${normalized}`);
	await app.fileManager.renameFile(file, normalizePath(newPath));
}

// -----------------------------------------------------------------------
// Adapter write — goes through Obsidian's adapter layer but bypasses
// vault metadata/event pipeline. Used for iOS/adapter-layer testing.
// NOT a real external write; does not exercise the OS watcher path.
// -----------------------------------------------------------------------

export async function writeAdapterFile(app: App, path: string, content: string): Promise<void> {
	const normalized = normalizePath(path);
	const parts = normalized.split("/");
	parts.pop();
	if (parts.length > 0) {
		let cur = "";
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			try { await app.vault.adapter.mkdir(cur); } catch { /* ok */ }
		}
	}
	await app.vault.adapter.write(normalized, content);
}

export async function deleteAdapterFile(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	try { await app.vault.adapter.remove(normalized); } catch { /* already gone */ }
}

// -----------------------------------------------------------------------
// Bulk adapter write (for bulk-import scenarios)
// -----------------------------------------------------------------------

export async function writeAdapterFileBulk(
	app: App,
	files: Array<{ path: string; content: string }>,
	{ concurrent = false }: { concurrent?: boolean } = {},
): Promise<void> {
	if (concurrent) {
		await Promise.all(files.map(({ path, content }) => writeAdapterFile(app, path, content)));
	} else {
		for (const { path, content } of files) {
			await writeAdapterFile(app, path, content);
		}
	}
}
