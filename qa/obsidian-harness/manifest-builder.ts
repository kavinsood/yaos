/**
 * In-process vault manifest builder for the QA harness.
 * Produces the same format as qa/scripts/manifest.ts but runs inside Obsidian.
 */

import { type App } from "obsidian";
import type { VaultManifest, VaultManifestEntry, ManifestDiff } from "./types";

async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const buf = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function fileKind(path: string): VaultManifestEntry["kind"] {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (ext === "md") return "markdown";
	const attachmentExts = new Set([
		"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp",
		"pdf", "mp3", "mp4", "wav",
	]);
	if (attachmentExts.has(ext)) return "attachment";
	return "other";
}

export async function buildVaultManifest(app: App): Promise<VaultManifest> {
	const files = app.vault.getFiles();
	const entries: VaultManifestEntry[] = [];

	for (const file of files) {
		let sha256 = "error";
		let bytes = 0;
		try {
			const content = await app.vault.readBinary(file);
			const buf = new Uint8Array(content);
			bytes = buf.byteLength;
			const hashBuf = await crypto.subtle.digest("SHA-256", buf);
			sha256 = Array.from(new Uint8Array(hashBuf))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		} catch { /* skip */ }
		entries.push({ path: file.path, sha256, bytes, kind: fileKind(file.path) });
	}

	entries.sort((a, b) => a.path.localeCompare(b.path));

	return {
		generatedAt: new Date().toISOString(),
		fileCount: entries.length,
		files: entries,
	};
}

export function diffManifests(
	a: VaultManifest,
	b: VaultManifest,
	filterPaths?: string[],
): ManifestDiff {
	const aMap = new Map(a.files.map((f) => [f.path, f]));
	const bMap = new Map(b.files.map((f) => [f.path, f]));

	let aKeys = [...aMap.keys()];
	if (filterPaths && filterPaths.length > 0) {
		aKeys = aKeys.filter((p) => filterPaths.some((fp) => p.startsWith(fp)));
	}

	const differ: ManifestDiff["differ"] = [];
	const missingOnB: string[] = [];

	for (const path of aKeys) {
		const aEntry = aMap.get(path)!;
		const bEntry = bMap.get(path);
		if (!bEntry) { missingOnB.push(path); continue; }
		if (aEntry.sha256 !== bEntry.sha256) {
			differ.push({ path, aSha: aEntry.sha256, bSha: bEntry.sha256 });
		}
	}

	const aSet = new Set(aKeys);
	const extraOnB = [...bMap.keys()].filter(
		(p) =>
			!aSet.has(p) &&
			(!filterPaths || filterPaths.length === 0 || filterPaths.some((fp) => p.startsWith(fp))),
	);

	return {
		match: differ.length === 0 && missingOnB.length === 0 && extraOnB.length === 0,
		differ,
		missingOnB,
		extraOnB,
	};
}
