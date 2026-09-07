export interface FrontmatterQuarantineEntry {
	path: string;
	bodyId?: string;
	state?: "whole-blocked" | "properties-held";
	boundaryVersion?: "frontmatter-boundary-v1";
	settlementRevision?: number;
	settlementAgreement?: "whole" | "body-only";
	settlementBodyHashPrefix?: string;
	settlementServerPropertiesHashPrefix?: string;
	settlementDiskPropertiesHashPrefix?: string;
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

export type FrontmatterQuarantineEvidence = Partial<Pick<FrontmatterQuarantineEntry,
	| "bodyId"
	| "settlementRevision"
	| "settlementAgreement"
	| "settlementBodyHashPrefix"
	| "settlementServerPropertiesHashPrefix"
	| "settlementDiskPropertiesHashPrefix"
>>;

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
			bodyId: normalized.bodyId ?? existing.bodyId,
			state: normalized.state ?? existing.state,
			boundaryVersion: normalized.boundaryVersion ?? existing.boundaryVersion,
			settlementRevision: normalized.settlementRevision ?? existing.settlementRevision,
			settlementAgreement: normalized.settlementAgreement ?? existing.settlementAgreement,
			settlementBodyHashPrefix: normalized.settlementBodyHashPrefix ?? existing.settlementBodyHashPrefix,
			settlementServerPropertiesHashPrefix: normalized.settlementServerPropertiesHashPrefix
				?? existing.settlementServerPropertiesHashPrefix,
			settlementDiskPropertiesHashPrefix: normalized.settlementDiskPropertiesHashPrefix
				?? existing.settlementDiskPropertiesHashPrefix,
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

export function clearResolvedFrontmatterQuarantinePath(
	entries: FrontmatterQuarantineEntry[],
	path: string,
	currentPropertiesHash: string | undefined,
	currentSettlementAgreement?: "whole" | "body-only",
): FrontmatterQuarantineEntry[] {
	return entries.filter((entry) => entry.path !== path
		|| (entry.state === "properties-held" && entry.prevHash === currentPropertiesHash
			&& currentSettlementAgreement !== "whole"));
}

export function buildFrontmatterQuarantineDebugLines(
	entries: FrontmatterQuarantineEntry[],
	limit = 3,
): string[] {
	const visibleEntries = entries.slice(0, limit);
	const propertiesHeld = entries.filter((entry) => entry.state === "properties-held").length;
	const lines = [
		`Frontmatter quarantines: ${entries.length}`,
		`Frontmatter quarantine states: wholeBlocked=${entries.length - propertiesHeld}, propertiesHeld=${propertiesHeld}`,
	];
	for (const entry of visibleEntries) {
		const noticeAt = entry.lastNoticeAt
			? new Date(entry.lastNoticeAt).toISOString()
			: "never";
		const noticeFingerprint = entry.lastNotifiedFingerprint
			? entry.lastNotifiedFingerprint.slice(0, 24)
			: "none";
		lines.push(
			`Frontmatter quarantine: ${entry.path} [${entry.direction}/${entry.state ?? "whole-blocked"}] x${entry.count} ${entry.reasons.join(", ")} (bodyId=${entry.bodyId ?? "unknown"}, settlement=${entry.settlementAgreement ?? "unknown"}@${entry.settlementRevision ?? "unknown"}, bodyHash=${entry.settlementBodyHashPrefix ?? "unknown"}, serverPropertiesHash=${entry.settlementServerPropertiesHashPrefix ?? "unknown"}, diskPropertiesHash=${entry.settlementDiskPropertiesHashPrefix ?? "unknown"}, lastNotice=${noticeAt}, noticeFingerprint=${noticeFingerprint})`,
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
		bodyId: validIdentity(candidate.bodyId) ? candidate.bodyId : undefined,
		state: candidate.state === "properties-held" ? "properties-held" : "whole-blocked",
		boundaryVersion: candidate.boundaryVersion === "frontmatter-boundary-v1"
			? candidate.boundaryVersion
			: undefined,
		settlementRevision: typeof candidate.settlementRevision === "number"
			&& Number.isSafeInteger(candidate.settlementRevision) && candidate.settlementRevision >= 1
			? candidate.settlementRevision
			: undefined,
		settlementAgreement: candidate.settlementAgreement === "whole" || candidate.settlementAgreement === "body-only"
			? candidate.settlementAgreement
			: undefined,
		settlementBodyHashPrefix: validHashPrefix(candidate.settlementBodyHashPrefix)
			? candidate.settlementBodyHashPrefix
			: undefined,
		settlementServerPropertiesHashPrefix: validHashPrefix(candidate.settlementServerPropertiesHashPrefix)
			? candidate.settlementServerPropertiesHashPrefix
			: undefined,
		settlementDiskPropertiesHashPrefix: validHashPrefix(candidate.settlementDiskPropertiesHashPrefix)
			? candidate.settlementDiskPropertiesHashPrefix
			: undefined,
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

function validIdentity(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validHashPrefix(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{12}$/.test(value);
}

function normalizeReasons(reasons: string[]): string[] {
	return Array.from(new Set(reasons)).sort();
}
