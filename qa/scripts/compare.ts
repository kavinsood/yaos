#!/usr/bin/env bun
/**
 * qa:compare — diff two vault manifests.
 *
 * Usage:
 *   bun run qa:compare expected.json actual.json [--paths-only path1,path2,...]
 *
 * Exit code 0 = no differences. Exit code 1 = differences found.
 */

import { readFileSync } from "fs";
import type { VaultManifest, VaultManifestEntry } from "./manifest";

export interface ManifestDiff {
	match: boolean;
	differ: Array<{ path: string; aSha: string; bSha: string; aBytes: number; bBytes: number }>;
	missingOnB: string[];
	extraOnB: string[];
}

export function compareManifests(
	a: VaultManifest,
	b: VaultManifest,
	filterPaths?: string[],
): ManifestDiff {
	const aMap = new Map<string, VaultManifestEntry>(a.files.map((f) => [f.path, f]));
	const bMap = new Map<string, VaultManifestEntry>(b.files.map((f) => [f.path, f]));

	let aEntries = [...aMap.keys()];
	if (filterPaths && filterPaths.length > 0) {
		aEntries = aEntries.filter((p) => filterPaths.some((fp) => p.startsWith(fp)));
	}

	const differ: ManifestDiff["differ"] = [];
	const missingOnB: string[] = [];

	for (const path of aEntries) {
		const aEntry = aMap.get(path)!;
		const bEntry = bMap.get(path);
		if (!bEntry) {
			missingOnB.push(path);
			continue;
		}
		if (aEntry.sha256 !== bEntry.sha256) {
			differ.push({
				path,
				aSha: aEntry.sha256,
				bSha: bEntry.sha256,
				aBytes: aEntry.bytes,
				bBytes: bEntry.bytes,
			});
		}
	}

	const aPathSet = new Set(aEntries);
	const extraOnB = [...bMap.keys()].filter(
		(p) =>
			!aPathSet.has(p) &&
			(!filterPaths || filterPaths.length === 0 || filterPaths.some((fp) => p.startsWith(fp))),
	);

	return {
		match: differ.length === 0 && missingOnB.length === 0 && extraOnB.length === 0,
		differ,
		missingOnB,
		extraOnB,
	};
}

function formatDiff(diff: ManifestDiff): string {
	if (diff.match) {
		return "manifest compare: no differences";
	}
	const lines: string[] = [
		`manifest compare: ${diff.differ.length} files differ, ${diff.missingOnB.length} missing on B, ${diff.extraOnB.length} extra on B`,
		"",
	];
	if (diff.differ.length > 0) {
		lines.push("DIFFER:");
		for (const d of diff.differ) {
			if (d.aBytes !== d.bBytes) {
				lines.push(`  ${d.path}  sha256 mismatch + bytes differ (A: ${d.aBytes}  B: ${d.bBytes})`);
			} else {
				lines.push(`  ${d.path}  sha256 mismatch (A: ${d.aSha.slice(0, 12)}…  B: ${d.bSha.slice(0, 12)}…)`);
			}
		}
		lines.push("");
	}
	if (diff.missingOnB.length > 0) {
		lines.push("MISSING on B:");
		for (const p of diff.missingOnB) lines.push(`  ${p}`);
		lines.push("");
	}
	if (diff.extraOnB.length > 0) {
		lines.push("EXTRA on B:");
		for (const p of diff.extraOnB) lines.push(`  ${p}`);
	}
	return lines.join("\n").trimEnd();
}

// -----------------------------------------------------------------------
// CLI entry point
// -----------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);
	const positional = args.filter((a) => !a.startsWith("--"));
	const pathsOnlyFlag = args.findIndex((a) => a === "--paths-only");
	const filterPaths =
		pathsOnlyFlag >= 0 ? args[pathsOnlyFlag + 1]?.split(",").map((p) => p.trim()) : undefined;

	if (positional.length < 2) {
		console.error("Usage: bun run qa:compare expected.json actual.json [--paths-only path1,path2]");
		process.exit(1);
	}

	let a: VaultManifest;
	let b: VaultManifest;
	try {
		a = JSON.parse(readFileSync(positional[0]!, "utf-8")) as VaultManifest;
		b = JSON.parse(readFileSync(positional[1]!, "utf-8")) as VaultManifest;
	} catch (err) {
		console.error(`Failed to read manifests: ${String(err)}`);
		process.exit(1);
	}

	const diff = compareManifests(a, b, filterPaths);
	console.log(formatDiff(diff));
	process.exit(diff.match ? 0 : 1);
}
