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

interface FakeFileEntry {
	content: string;
	mtime: number;
}

export class FakeVaultFs implements VaultFs {
	readonly writes: Array<{ path: string; content: string }> = [];
	readonly deletes: string[] = [];
	readonly renames: Array<{ oldPath: string; newPath: string; overwrite: boolean }> = [];

	private readonly files = new Map<string, FakeFileEntry>();
	private now = 1;

	constructor(initialFiles: Record<string, string> = {}) {
		for (const [path, content] of Object.entries(initialFiles)) {
			this.setFile(path, content);
		}
	}

	normalize(path: string): string {
		return normalizeVaultPath(path);
	}

	async readText(path: string, options?: VaultFsReadOptions): Promise<string | null> {
		const normalized = this.assertSafePath(path);
		const entry = this.files.get(normalized);
		if (!entry) return null;
		this.assertMaxBytes(normalized, this.byteSize(entry.content), options?.maxBytes);
		return entry.content;
	}

	async writeText(path: string, content: string): Promise<void> {
		const normalized = this.assertSafePath(path);
		this.assertWritableFilePath(normalized);
		this.files.set(normalized, {
			content,
			mtime: this.nextMtime(),
		});
		this.writes.push({ path: normalized, content });
	}

	async delete(path: string): Promise<void> {
		const normalized = this.assertSafePath(path);
		this.files.delete(normalized);
		this.deletes.push(normalized);
	}

	async rename(oldPath: string, newPath: string, options?: VaultFsRenameOptions): Promise<void> {
		const oldNormalized = this.assertSafePath(oldPath);
		const newNormalized = this.assertSafePath(newPath);
		if (oldNormalized === newNormalized) return;
		const source = this.files.get(oldNormalized);
		if (!source) {
			throw new VaultFsError(`Cannot rename missing file: ${oldNormalized}`, "missing");
		}
		this.assertWritableFilePath(newNormalized, options?.overwrite === true);
		this.files.delete(oldNormalized);
		this.files.set(newNormalized, {
			content: source.content,
			mtime: this.nextMtime(),
		});
		this.renames.push({
			oldPath: oldNormalized,
			newPath: newNormalized,
			overwrite: options?.overwrite === true,
		});
	}

	async stat(path: string): Promise<VaultFsStats | null> {
		const normalized = this.assertSafePath(path);
		const entry = this.files.get(normalized);
		if (entry) {
			return this.fileStats(entry);
		}
		const prefix = normalized ? `${normalized}/` : "";
		if ([...this.files.keys()].some((filePath) => filePath.startsWith(prefix))) {
			return {
				size: 0,
				mtime: 0,
				isFile: false,
				isDirectory: true,
			};
		}
		return null;
	}

	async *listMarkdown(options: VaultFsListOptions): AsyncIterable<VaultFsListing> {
		const paths = [...this.files.keys()].sort();
		for (const path of paths) {
			if (path !== path.normalize("NFC")) {
				throw new VaultFsError(`Filesystem entry is not NFC: ${path}`, "non_nfc");
			}
			if (!isMarkdownSyncable(path, options.excludePatterns, options.configDir)) continue;
			const entry = this.files.get(path);
			if (!entry) continue;
			yield {
				path,
				stats: this.fileStats(entry),
			};
		}
	}

	setFile(path: string, content: string): void {
		const normalized = this.assertSafePath(path);
		this.assertWritableFilePath(normalized);
		this.files.set(normalized, {
			content,
			mtime: this.nextMtime(),
		});
	}

	hasFile(path: string): boolean {
		return this.files.has(this.assertSafePath(path));
	}

	getFile(path: string): string | null {
		return this.files.get(this.assertSafePath(path))?.content ?? null;
	}

	snapshot(): Record<string, string> {
		return Object.fromEntries(
			[...this.files.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([path, entry]) => [path, entry.content]),
		);
	}

	private assertSafePath(path: string): string {
		const normalized = this.normalize(path);
		const parts = normalized.split("/");
		if (parts.some((part) => part === "." || part === "..")) {
			throw new VaultFsError(`Unsafe vault path: ${path}`, "traversal");
		}
		return normalized;
	}

	private assertWritableFilePath(path: string, overwrite = true): void {
		this.assertParentFoldersAvailable(path);
		if (this.hasDescendant(path)) {
			throw new VaultFsError(`Target path is a folder: ${path}`, "target_exists");
		}
		if (!overwrite && this.files.has(path)) {
			throw new VaultFsError(`Target file already exists: ${path}`, "target_exists");
		}
	}

	private assertParentFoldersAvailable(path: string): void {
		const parts = path.split("/");
		let current = "";
		for (const part of parts.slice(0, -1)) {
			current = current ? `${current}/${part}` : part;
			if (this.files.has(current)) {
				throw new VaultFsError(`Parent path is not a folder: ${current}`, "target_exists");
			}
		}
	}

	private hasDescendant(path: string): boolean {
		const prefix = path ? `${path}/` : "";
		return [...this.files.keys()].some((filePath) => filePath.startsWith(prefix));
	}

	private fileStats(entry: FakeFileEntry): VaultFsStats {
		return {
			size: this.byteSize(entry.content),
			mtime: entry.mtime,
			isFile: true,
			isDirectory: false,
		};
	}

	private byteSize(content: string): number {
		return new TextEncoder().encode(content).byteLength;
	}

	private nextMtime(): number {
		return this.now++;
	}

	private assertMaxBytes(path: string, observedBytes: number, maxBytes: number | undefined): void {
		if (typeof maxBytes === "number" && observedBytes > maxBytes) {
			throw new VaultFsError(`Read rejected for oversized file: ${path}`, "too_large");
		}
	}
}
