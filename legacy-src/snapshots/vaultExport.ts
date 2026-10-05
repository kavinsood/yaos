import { App, Notice } from "obsidian";
import { strToU8, zipSync } from "fflate";

export interface PortableVaultFile {
	path: string;
	bytes: Uint8Array;
}

export interface PortableVaultDirectory {
	path: string;
	directory: true;
}

export interface PortableVaultManifest {
	format: "yaos-portable-vault-v1";
	exportedAt: string;
	hashAlgorithm: "sha256";
	fileCount: number;
	totalBytes: number;
	contentSetHash: string;
	files: Array<{ path: string; size: number; sha256: string }>;
	directories: string[];
	excludedInternalPaths: readonly string[];
}

export interface PortableVaultArchive {
	bytes: Uint8Array;
	manifest: PortableVaultManifest;
	manifestPath: string;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	let output = "";
	for (const byte of digest) output += byte.toString(16).padStart(2, "0");
	return output;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function safeArchivePath(rawPath: string): string {
	if (!rawPath || rawPath.startsWith("/") || rawPath.includes("\\") || hasControlCharacter(rawPath)) {
		throw new Error(`unsafe vault export path: ${rawPath}`);
	}
	const segments = rawPath.split("/").filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0 || segments.some((segment) => segment === "..")) {
		throw new Error(`unsafe vault export path: ${rawPath}`);
	}
	return segments.join("/");
}

function isInternalPath(path: string, internalPaths: readonly string[]): boolean {
	return internalPaths.some((internal) => path === internal || path.startsWith(`${internal}/`));
}

function yaosInternalPaths(configDir: string): readonly string[] {
	const configRoot = safeArchivePath(configDir);
	return [
		`${configRoot}/plugins/yaos/data.json`,
		`${configRoot}/plugins/yaos/restore-backups`,
		`${configRoot}/plugins/yaos/diagnostics`,
	];
}

export async function buildPortableVaultArchive(
	items: readonly (PortableVaultFile | PortableVaultDirectory)[],
	exportedAt: string,
	configDir: string,
): Promise<PortableVaultArchive> {
	const internalPaths = yaosInternalPaths(configDir);
	const unique = new Map<string, Uint8Array>();
	const directories = new Set<string>();
	for (const item of items) {
		const path = safeArchivePath(item.path);
		if (isInternalPath(path, internalPaths)) continue;
		if ("directory" in item) {
			directories.add(path);
			continue;
		}
		if (unique.has(path)) throw new Error(`duplicate vault export path: ${path}`);
		unique.set(path, item.bytes.slice());
	}
	const entries: PortableVaultManifest["files"] = [];
	let totalBytes = 0;
	for (const [path, bytes] of [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		totalBytes += bytes.byteLength;
		if (!Number.isSafeInteger(totalBytes)) throw new Error("vault export size overflow");
		entries.push({ path, size: bytes.byteLength, sha256: await sha256Hex(bytes) });
	}
	const sortedDirectories = [...directories].sort();
	const contentSetHash = await sha256Hex(strToU8(JSON.stringify({ files: entries, directories: sortedDirectories })));
	const manifest: PortableVaultManifest = {
		format: "yaos-portable-vault-v1",
		exportedAt,
		hashAlgorithm: "sha256",
		fileCount: entries.length,
		totalBytes,
		contentSetHash,
		files: entries,
		directories: sortedDirectories,
		excludedInternalPaths: internalPaths,
	};
	const archiveEntries: Record<string, Uint8Array> = {};
	for (const entry of entries) archiveEntries[entry.path] = unique.get(entry.path)!;
	for (const directory of sortedDirectories) archiveEntries[`${directory}/`] = new Uint8Array();
	let manifestPath = "yaos-export-manifest.json";
	for (let suffix = 1; manifestPath in archiveEntries; suffix++) {
		manifestPath = `yaos-export-manifest.${suffix}.json`;
	}
	archiveEntries[manifestPath] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
	return {
		bytes: zipSync(archiveEntries, { level: 6 }),
		manifest,
		manifestPath,
	};
}

export class VaultExportService {
	constructor(private readonly app: App) {}

	async exportToDownload(): Promise<PortableVaultManifest> {
		const collected: Array<PortableVaultFile | PortableVaultDirectory> = [];
		const internalPaths = yaosInternalPaths(this.app.vault.configDir);
		await this.collectDirectory("", collected, internalPaths);
		const archive = await buildPortableVaultArchive(
			collected,
			new Date().toISOString(),
			this.app.vault.configDir,
		);
		const blob = new Blob([archive.bytes.slice().buffer], { type: "application/zip" });
		const url = URL.createObjectURL(blob);
		const anchor = this.app.workspace.containerEl.createEl("a");
		try {
			anchor.href = url;
			anchor.download = `yaos-vault-export-${archive.manifest.exportedAt.replace(/[:.]/g, "-")}.zip`;
			anchor.click();
			new Notice(`Exported ${archive.manifest.fileCount} files (${archive.manifest.totalBytes} bytes).`);
			return archive.manifest;
		} finally {
			anchor.remove();
			URL.revokeObjectURL(url);
		}
	}

	private async collectDirectory(
		path: string,
		output: Array<PortableVaultFile | PortableVaultDirectory>,
		internalPaths: readonly string[],
	): Promise<void> {
		const listing = await this.app.vault.adapter.list(path);
		for (const file of listing.files) {
			const normalized = safeArchivePath(file);
			if (isInternalPath(normalized, internalPaths)) continue;
			output.push({ path: normalized, bytes: new Uint8Array(await this.app.vault.adapter.readBinary(normalized)) });
		}
		for (const folder of listing.folders) {
			const normalized = safeArchivePath(folder);
			if (isInternalPath(normalized, internalPaths)) continue;
			output.push({ path: normalized, directory: true });
			await this.collectDirectory(normalized, output, internalPaths);
		}
	}
}
