#!/usr/bin/env bun
/**
 * qa:manifest — walk a vault directory and produce a JSON manifest.
 *
 * Usage:
 *   bun run qa:manifest /path/to/vault [--out manifest.json] [--hash-paths]
 *
 * --hash-paths  replace real paths with sha256 prefixes (for safe sharing)
 */

import { createHash } from "crypto";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import { writeFileSync } from "fs";

export interface VaultManifestEntry {
	path: string;
	sha256: string;
	bytes: number;
	kind: "markdown" | "attachment" | "other";
}

export interface VaultManifest {
	generatedAt: string;
	vaultPath: string;
	fileCount: number;
	files: VaultManifestEntry[];
}

function fileKind(p: string): VaultManifestEntry["kind"] {
	const ext = p.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "md") return "markdown";
	const attachmentExts = new Set([
		"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
		"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
		"mp3", "mp4", "wav", "ogg", "flac", "m4a",
		"zip", "tar", "gz",
	]);
	if (attachmentExts.has(ext)) return "attachment";
	return "other";
}

async function sha256File(filePath: string): Promise<string> {
	const buf = await readFile(filePath);
	return createHash("sha256").update(buf).digest("hex");
}

/** Recursively collect all files under a directory, skipping .obsidian internals we don't care about. */
async function collectFiles(
	dir: string,
	vaultRoot: string,
	skipPrefixes: string[],
): Promise<string[]> {
	const results: string[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		const rel = relative(vaultRoot, full);
		if (skipPrefixes.some((p) => rel.startsWith(p))) continue;
		if (entry.isDirectory()) {
			const sub = await collectFiles(full, vaultRoot, skipPrefixes);
			results.push(...sub);
		} else if (entry.isFile()) {
			results.push(full);
		}
	}
	return results;
}

export async function buildManifest(
	vaultPath: string,
	opts: { hashPaths?: boolean } = {},
): Promise<VaultManifest> {
	const skipPrefixes = [".obsidian/plugins/", ".obsidian/workspace", ".trash/"];
	const allFiles = await collectFiles(vaultPath, vaultPath, skipPrefixes);
	allFiles.sort();

	const files: VaultManifestEntry[] = [];
	for (const full of allFiles) {
		const rel = relative(vaultPath, full);
		let displayPath = rel.replace(/\\/g, "/");
		if (opts.hashPaths) {
			displayPath = "p:" + createHash("sha256").update(displayPath).digest("hex").slice(0, 16);
		}
		let bytes = 0;
		try {
			const s = await stat(full);
			bytes = s.size;
		} catch { /* skip */ }
		const sha256 = await sha256File(full).catch(() => "error");
		files.push({ path: displayPath, sha256, bytes, kind: fileKind(rel) });
	}

	return {
		generatedAt: new Date().toISOString(),
		vaultPath: opts.hashPaths ? "<redacted>" : vaultPath,
		fileCount: files.length,
		files,
	};
}

// -----------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);
	const vaultPath = args.find((a) => !a.startsWith("--"));
	const outFlag = args.findIndex((a) => a === "--out");
	const outFile = outFlag >= 0 ? args[outFlag + 1] : undefined;
	const hashPaths = args.includes("--hash-paths");

	if (!vaultPath) {
		console.error("Usage: bun run qa:manifest /path/to/vault [--out manifest.json] [--hash-paths]");
		process.exit(1);
	}

	const manifest = await buildManifest(vaultPath, { hashPaths });
	const json = JSON.stringify(manifest, null, 2);

	if (outFile) {
		writeFileSync(outFile, json, "utf-8");
		console.log(`Manifest written to ${outFile} (${manifest.fileCount} files)`);
	} else {
		console.log(json);
	}
}
