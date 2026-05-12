import { normalizePath } from "obsidian";

export type PreservedUnresolvedKind = "markdown" | "blob";

export type PreservedUnresolvedReason =
	| "remote-delete-missing-baseline"
	| "remote-delete-read-failed"
	| "remote-delete-hash-read-failed"
	| "remote-delete-stat-failed"
	| "conflict-artifact-write-failed"
	| "three-way-preserve-failed"
	| "multiple-editor-authorities"
	| "path-collision"
	| "unknown";

export interface PreservedUnresolvedEntry {
	path: string;
	kind: PreservedUnresolvedKind;
	reason: PreservedUnresolvedReason;
	firstSeenAt: number;
	lastSeenAt: number;
	localHash?: string | null;
	knownRemoteHash?: string | null;
}

export interface PreservedUnresolvedSample {
	path: string;
	ext: string | null;
	kind: PreservedUnresolvedKind;
	reason: PreservedUnresolvedReason;
	firstSeenAt: string;
	lastSeenAt: string;
}

export interface PreservedUnresolvedSummary {
	markdownCount: number;
	blobCount: number;
	totalCount: number;
	lastAt: number | null;
	reasons: Record<string, number>;
	samples: PreservedUnresolvedSample[];
}

function extensionFor(path: string): string | null {
	const name = normalizePath(path).split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot) : null;
}

export class PreservedUnresolvedRegistry {
	private entries = new Map<string, PreservedUnresolvedEntry>();
	readonly paths = new Set<string>();

	constructor(entries: PreservedUnresolvedEntry[] = []) {
		for (const entry of entries) {
			this.record({ ...entry, at: entry.lastSeenAt });
			const stored = this.entries.get(normalizePath(entry.path));
			if (stored) {
				stored.firstSeenAt = entry.firstSeenAt;
				stored.lastSeenAt = entry.lastSeenAt;
			}
		}
	}

	record(
		entry: Omit<PreservedUnresolvedEntry, "path" | "firstSeenAt" | "lastSeenAt"> & {
			path: string;
			at?: number;
		},
	): void {
		const path = normalizePath(entry.path);
		const at = entry.at ?? Date.now();
		const previous = this.entries.get(path);
		this.entries.set(path, {
			...previous,
			path,
			kind: entry.kind,
			reason: entry.reason,
			firstSeenAt: previous?.firstSeenAt ?? at,
			lastSeenAt: at,
			localHash: entry.localHash ?? previous?.localHash ?? null,
			knownRemoteHash: entry.knownRemoteHash ?? previous?.knownRemoteHash ?? null,
		});
		this.paths.add(path);
	}

	resolve(path: string): boolean {
		const normalized = normalizePath(path);
		this.paths.delete(normalized);
		return this.entries.delete(normalized);
	}

	has(path: string): boolean {
		return this.entries.has(normalizePath(path));
	}

	get(path: string): PreservedUnresolvedEntry | null {
		return this.entries.get(normalizePath(path)) ?? null;
	}

	clear(): void {
		this.entries.clear();
		this.paths.clear();
	}

	getEntries(): PreservedUnresolvedEntry[] {
		return Array.from(this.entries.values()).sort(
			(a, b) => b.lastSeenAt - a.lastSeenAt,
		);
	}

	getSummary(limit = 10): PreservedUnresolvedSummary {
		const entries = this.getEntries();
		const reasons: Record<string, number> = {};
		let markdownCount = 0;
		let blobCount = 0;
		let lastAt: number | null = null;
		for (const entry of entries) {
			if (entry.kind === "markdown") markdownCount++;
			else blobCount++;
			reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
			lastAt = Math.max(lastAt ?? 0, entry.lastSeenAt);
		}
		return {
			markdownCount,
			blobCount,
			totalCount: entries.length,
			lastAt,
			reasons,
			samples: entries.slice(0, limit).map((entry) => ({
				path: entry.path,
				ext: extensionFor(entry.path),
				kind: entry.kind,
				reason: entry.reason,
				firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
				lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
			})),
		};
	}
}
