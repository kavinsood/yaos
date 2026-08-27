#!/usr/bin/env bun
/**
 * qa:manifest — walk a vault directory and produce a JSON manifest.
 *
 * Usage:
 *   bun run qa:manifest /path/to/vault [--out manifest.json] [--hash-paths]
 *
 * --hash-paths  replace real paths with sha256 prefixes (for safe sharing)
 */

import { readdir, readFile } from "fs/promises";
import { join, relative } from "path";
import { writeFileSync } from "fs";
import {
	buildManifest as buildManifestCore,
	classifyManifestPath,
	type ManifestInput,
	type VaultManifest,
} from "../manifest";
export type { VaultManifest, VaultManifestEntry } from "../manifest";


/** Recursively collect regular files; the shared core owns path exclusion. */
async function collectFiles(dir: string, vaultRoot: string): Promise<ManifestInput[]> {
	const results: ManifestInput[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...await collectFiles(full, vaultRoot));
		} else if (entry.isFile()) {
			const path = relative(vaultRoot, full);
			if (classifyManifestPath(path) === null) continue;
			try {
				results.push({ path, bytes: new Uint8Array(await readFile(full)) });
			} catch {
				// A file removed during enumeration is absent from this point-in-time manifest.
			}
		}
	}
	return results;
}

export async function buildManifest(
	vaultPath: string,
	opts: { hashPaths?: boolean } = {},
): Promise<VaultManifest> {
	const inputs = await collectFiles(vaultPath, vaultPath);
	return buildManifestCore(inputs, {
		vaultPath,
		hashPaths: opts.hashPaths,
	});
}

// -----------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------

const manifestModuleMeta = import.meta as ImportMeta & { readonly main?: boolean };
if (manifestModuleMeta.main === true) {
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
