export interface FrontmatterQuarantineEntry {
	path: string;
	firstSeenAt: number;
	lastSeenAt: number;
	direction: "disk-to-crdt" | "crdt-to-disk";
	reasons: string[];
	prevHash?: string;
	nextHash?: string;
	lastNoticeAt?: number;
	lastNotifiedFingerprint?: string;
	count: number;
}

export const MAX_FRONTMATTER_QUARANTINE_ENTRIES = 128;

export function readPersistedFrontmatterQuarantine(value: unknown): FrontmatterQuarantineEntry[] {
	if (!Array.isArray(value)) return [];

	return value
		.map((entry) => sanitizeEntry(entry))
		.filter((entry): entry is FrontmatterQuarantineEntry => entry !== null)
		.sort((left, right) => right.lastSeenAt - left.lastSeenAt)
		.slice(0, MAX_FRONTMATTER_QUARANTINE_ENTRIES);
}

export function upsertFrontmatterQuarantineEntry(
	entries: FrontmatterQuarantineEntry[],
	entry: FrontmatterQuarantineEntry,
	limit = MAX_FRONTMATTER_QUARANTINE_ENTRIES,
): FrontmatterQuarantineEntry[] {
	const normalized = {
		...entry,
		reasons: normalizeReasons(entry.reasons),
	};
	const existingIndex = entries.findIndex((candidate) => candidate.path === normalized.path);
	const nextEntries = [...entries];

	if (existingIndex >= 0) {
		const existing = nextEntries[existingIndex];
		if (!existing) {
			return nextEntries.slice(0, limit);
		}
		nextEntries[existingIndex] = {
			path: existing.path,
			firstSeenAt: existing.firstSeenAt,
			lastSeenAt: normalized.lastSeenAt,
			direction: normalized.direction,
			reasons: normalized.reasons,
			prevHash: normalized.prevHash,
			nextHash: normalized.nextHash,
			lastNoticeAt: normalized.lastNoticeAt ?? existing.lastNoticeAt,
			lastNotifiedFingerprint: normalized.lastNotifiedFingerprint ?? existing.lastNotifiedFingerprint,
			count: existing.count + 1,
		};
	} else {
		nextEntries.push(normalized);
	}

	nextEntries.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
	return nextEntries.slice(0, limit);
}

export function clearFrontmatterQuarantinePath(
	entries: FrontmatterQuarantineEntry[],
	path: string,
): FrontmatterQuarantineEntry[] {
	return entries.filter((entry) => entry.path !== path);
}

export function buildFrontmatterQuarantineDebugLines(
	entries: FrontmatterQuarantineEntry[],
	limit = 3,
): string[] {
	const visibleEntries = entries.slice(0, limit);
	const lines = [`Frontmatter quarantines: ${entries.length}`];
	for (const entry of visibleEntries) {
		const noticeAt = entry.lastNoticeAt
			? new Date(entry.lastNoticeAt).toISOString()
			: "never";
		const noticeFingerprint = entry.lastNotifiedFingerprint
			? entry.lastNotifiedFingerprint.slice(0, 24)
			: "none";
		lines.push(
			`Frontmatter quarantine: ${entry.path} [${entry.direction}] x${entry.count} ${entry.reasons.join(", ")} (lastNotice=${noticeAt}, noticeFingerprint=${noticeFingerprint})`,
		);
	}
	return lines;
}

function sanitizeEntry(value: unknown): FrontmatterQuarantineEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<FrontmatterQuarantineEntry>;
	if (
		typeof candidate.path !== "string"
		|| typeof candidate.firstSeenAt !== "number"
		|| typeof candidate.lastSeenAt !== "number"
		|| (candidate.direction !== "disk-to-crdt" && candidate.direction !== "crdt-to-disk")
		|| !Array.isArray(candidate.reasons)
		|| typeof candidate.count !== "number"
	) {
		return null;
	}

	const reasons = normalizeReasons(
		candidate.reasons.filter((reason): reason is string => typeof reason === "string"),
	);
	return {
		path: candidate.path,
		firstSeenAt: candidate.firstSeenAt,
		lastSeenAt: candidate.lastSeenAt,
		direction: candidate.direction,
		reasons,
		prevHash: typeof candidate.prevHash === "string" ? candidate.prevHash : undefined,
		nextHash: typeof candidate.nextHash === "string" ? candidate.nextHash : undefined,
		lastNoticeAt: typeof candidate.lastNoticeAt === "number" ? candidate.lastNoticeAt : undefined,
		lastNotifiedFingerprint: typeof candidate.lastNotifiedFingerprint === "string"
			? candidate.lastNotifiedFingerprint
			: undefined,
		count: candidate.count,
	};
}

function normalizeReasons(reasons: string[]): string[] {
	return Array.from(new Set(reasons)).sort();
}
