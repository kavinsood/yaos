import { App, TAbstractFile, TFile, TFolder } from "obsidian";
import { isMarkdownSyncable } from "../../types";
import { normalizeVaultPath } from "../../utils/normalizeVaultPath";
import {
	VaultFsError,
	type VaultFs,
	type VaultFsListOptions,
	type VaultFsListing,
	type VaultFsReadOptions,
	type VaultFsRenameOptions,
	type VaultFsStats,
} from "./types";

export class ObsidianVaultFs implements VaultFs {
	constructor(private readonly app: App) {}

	normalize(path: string): string {
		return normalizeVaultPath(path);
	}

	async readText(path: string, options?: VaultFsReadOptions): Promise<string | null> {
		const normalized = this.assertSafePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) return null;
		this.assertMaxBytes(normalized, file.stat.size, options?.maxBytes);
		const content = await this.app.vault.read(file);
		this.assertMaxBytes(normalized, new TextEncoder().encode(content).byteLength, options?.maxBytes);
		return content;
	}

	async writeText(path: string, content: string): Promise<void> {
		const normalized = this.assertSafePath(path);
		await this.ensureParentFolders(normalized);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return;
		}
		if (existing instanceof TFolder) {
			throw new VaultFsError(`Cannot write text over folder: ${normalized}`, "target_exists");
		}
		await this.app.vault.create(normalized, content);
	}

	async delete(path: string): Promise<void> {
		const normalized = this.assertSafePath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			await this.app.vault.delete(file);
		}
	}

	async rename(oldPath: string, newPath: string, options?: VaultFsRenameOptions): Promise<void> {
		const oldNormalized = this.assertSafePath(oldPath);
		const newNormalized = this.assertSafePath(newPath);
		if (oldNormalized === newNormalized) return;

		const source = this.app.vault.getAbstractFileByPath(oldNormalized);
		if (!(source instanceof TFile)) {
			throw new VaultFsError(`Cannot rename missing file: ${oldNormalized}`, "missing");
		}

		const target = this.app.vault.getAbstractFileByPath(newNormalized);
		if (target) {
			if (!options?.overwrite || !(target instanceof TFile)) {
				throw new VaultFsError(`Rename target already exists: ${newNormalized}`, "target_exists");
			}
			await this.app.vault.delete(target);
		}

		await this.ensureParentFolders(newNormalized);
		await this.app.fileManager.renameFile(source, newNormalized);
	}

	async stat(path: string): Promise<VaultFsStats | null> {
		const normalized = this.assertSafePath(path);
		const node = this.app.vault.getAbstractFileByPath(normalized);
		if (!node) return null;
		return this.toStats(node);
	}

	async *listMarkdown(options: VaultFsListOptions): AsyncIterable<VaultFsListing> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.path !== file.path.normalize("NFC")) {
				throw new VaultFsError(`Filesystem entry is not NFC: ${file.path}`, "non_nfc");
			}
			const path = this.normalize(file.path);
			if (!isMarkdownSyncable(path, options.excludePatterns, options.configDir)) continue;
			yield {
				path,
				stats: this.toStats(file),
			};
		}
	}

	private assertSafePath(path: string): string {
		const normalized = this.normalize(path);
		const parts = normalized.split("/");
		if (parts.some((part) => part === "." || part === "..")) {
			throw new VaultFsError(`Unsafe vault path: ${path}`, "traversal");
		}
		return normalized;
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const parentParts = path.split("/").slice(0, -1);
		let current = "";
		for (const part of parentParts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) {
				throw new VaultFsError(`Parent path is not a folder: ${current}`, "target_exists");
			}
			await this.app.vault.createFolder(current);
		}
	}

	private toStats(node: TAbstractFile): VaultFsStats {
		if (node instanceof TFile) {
			return {
				size: node.stat.size,
				mtime: node.stat.mtime,
				isFile: true,
				isDirectory: false,
			};
		}
		return {
			size: 0,
			mtime: 0,
			isFile: false,
			isDirectory: node instanceof TFolder,
		};
	}

	private assertMaxBytes(path: string, observedBytes: number, maxBytes: number | undefined): void {
		if (typeof maxBytes === "number" && observedBytes > maxBytes) {
			throw new VaultFsError(`Read rejected for oversized file: ${path}`, "too_large");
		}
	}
}
