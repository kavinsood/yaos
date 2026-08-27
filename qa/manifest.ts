export type ManifestFileKind = "markdown" | "attachment" | "other";

export interface ManifestInput {
	path: string;
	bytes: Uint8Array;
}

export interface VaultManifestEntry {
	path: string;
	sha256: string;
	bytes: number;
	kind: ManifestFileKind;
}

export interface VaultManifest {
	generatedAt: string;
	/** Execution metadata only. Comparison ignores it. */
	vaultPath?: string;
	fileCount: number;
	files: VaultManifestEntry[];
}

export interface ManifestMetadata {
	generatedAt?: string;
	vaultPath?: string;
	hashPaths?: boolean;
}

export interface ManifestDiff {
	match: boolean;
	differ: Array<{ path: string; aSha: string; bSha: string; aBytes: number; bBytes: number }>;
	missingOnB: string[];
	extraOnB: string[];
}

const ATTACHMENT_EXTENSIONS: Record<string, true> = {
	png: true, jpg: true, jpeg: true, gif: true, webp: true, svg: true, bmp: true,
	pdf: true, doc: true, docx: true, xls: true, xlsx: true, ppt: true, pptx: true,
	mp3: true, mp4: true, wav: true, ogg: true, flac: true, m4a: true,
	zip: true, tar: true, gz: true,
};

const EXCLUDED_PREFIXES = [".obsidian/plugins/", ".obsidian/workspace", ".trash/"];

export function normalizeManifestPath(path: string): string {
	return path.normalize("NFC").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

export function classifyManifestPath(path: string): ManifestFileKind | null {
	const normalized = normalizeManifestPath(path);
	if (!normalized || EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return null;
	const extension = normalized.split(".").pop()?.toLowerCase() ?? "";
	if (extension === "md") return "markdown";
	return ATTACHMENT_EXTENSIONS[extension] ? "attachment" : "other";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildManifest(
	inputs: Iterable<ManifestInput>,
	metadata: ManifestMetadata = {},
): Promise<VaultManifest> {
	const files: VaultManifestEntry[] = [];
	for (const input of inputs) {
		const normalizedPath = normalizeManifestPath(input.path);
		const kind = classifyManifestPath(normalizedPath);
		if (!kind) continue;
		const path = metadata.hashPaths
			? `p:${(await sha256Hex(new TextEncoder().encode(normalizedPath))).slice(0, 16)}`
			: normalizedPath;
		files.push({ path, sha256: await sha256Hex(input.bytes), bytes: input.bytes.byteLength, kind });
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	return {
		generatedAt: metadata.generatedAt ?? new Date().toISOString(),
		...(metadata.vaultPath !== undefined
			? { vaultPath: metadata.hashPaths ? "<redacted>" : metadata.vaultPath }
			: {}),
		fileCount: files.length,
		files,
	};
}

export function compareManifests(
	a: VaultManifest,
	b: VaultManifest,
	filterPaths?: readonly string[],
): ManifestDiff {
	const normalizedFilters = filterPaths?.map(normalizeManifestPath);
	const selected = (path: string): boolean =>
		!normalizedFilters?.length || normalizedFilters.some((prefix) => path.startsWith(prefix));
	const aMap = new Map(a.files.map((entry) => [normalizeManifestPath(entry.path), entry]));
	const bMap = new Map(b.files.map((entry) => [normalizeManifestPath(entry.path), entry]));
	const differ: ManifestDiff["differ"] = [];
	const missingOnB: string[] = [];
	for (const path of [...aMap.keys()].filter(selected).sort()) {
		const aEntry = aMap.get(path)!;
		const bEntry = bMap.get(path);
		if (!bEntry) {
			missingOnB.push(path);
		} else if (aEntry.sha256 !== bEntry.sha256) {
			differ.push({ path, aSha: aEntry.sha256, bSha: bEntry.sha256, aBytes: aEntry.bytes, bBytes: bEntry.bytes });
		}
	}
	const extraOnB = [...bMap.keys()].filter((path) => selected(path) && !aMap.has(path)).sort();
	return {
		match: differ.length === 0 && missingOnB.length === 0 && extraOnB.length === 0,
		differ,
		missingOnB,
		extraOnB,
	};
}
