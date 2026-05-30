import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

/**
 * Rule: active-excluded-path
 *
 * No CRDT file should become (or remain) active under an excluded path prefix.
 * Excluded paths include .trash/, .obsidian/, and user-configured exclude patterns.
 *
 * Fires a hard failure if crdt.file.created, crdt.file.renamed, or crdt.file.revived
 * is observed for a path marked `excludedByPolicy: true` in the event data, AND no
 * tombstone follows within the window (outside the cleanup phase).
 *
 * This rule works in both safe-mode and full traces because it reads `data.excludedByPolicy`
 * rather than the raw path. The product embeds this flag in `recordFlightPathEvent`
 * (main.ts) at the event source, where the exclusion policy is known.
 *
 * Backward compatibility: traces emitted before `excludedByPolicy` was added to events
 * (pre-QA-9 fix) will not have this field. For those traces the rule falls back to
 * checking raw paths (if available) against known always-excluded prefixes (.trash/,
 * .obsidian/). If neither is available, a coverage warning is emitted.
 *
 * Architecture note: this invariant is enforced in the product by
 * onRenameBatchFlushed → vaultSync.handleDelete for excluded destinations.
 * If this rule fires, that guard has failed or a new admission path exists
 * that bypasses the post-rename policy enforcement.
 */

const WINDOW_MS = 10_000;

const ADMISSION_KINDS = new Set([
	"crdt.file.created",
	"crdt.file.renamed",
	"crdt.file.revived",
]);

// Fallback: always-excluded prefixes for traces without excludedByPolicy metadata.
const ALWAYS_EXCLUDED_PREFIXES = [".trash/", ".obsidian/"];

function isExcludedByPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
	return ALWAYS_EXCLUDED_PREFIXES.some((p) => normalized.startsWith(p));
}

export function checkActiveExcludedPath(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	// Determine cleanup phase start.
	const cleanupPhaseTs = events
		.filter((e) => e.kind === "qa.phase" && (e.data as Record<string, unknown> | undefined)?.phase === "cleanup")
		.reduce((min, e) => Math.min(min, e.ts), Infinity);

	// Determine which coverage mode we're in.
	// Priority: data.excludedByPolicy (added in main.ts since QA-9 fix).
	// Fallback: raw path matching against known prefixes.
	// Neither: coverage warning.
	const hasExcludedByPolicyField = events.some(
		(e) => ADMISSION_KINDS.has(e.kind) &&
			(e.data as Record<string, unknown> | undefined)?.excludedByPolicy !== undefined,
	);
	const hasPathData = events.some((e) => typeof e.path === "string" && e.path.length > 0);

	if (!hasExcludedByPolicyField && !hasPathData) {
		findings.push({
			rule: "active-excluded-path",
			severity: "warning",
			description:
				"COVERAGE: no excludedByPolicy metadata or unredacted path fields in trace — " +
				"active-excluded-path rule could not run. " +
				"This trace was recorded before policy metadata was added to flight events " +
				"(pre-QA-9 fix). Re-run the scenario with the current plugin to get full coverage.",
		});
		return findings;
	}

	for (const e of events) {
		if (!ADMISSION_KINDS.has(e.kind)) continue;

		const data = e.data as Record<string, unknown> | undefined;

		// Determine if this admission is for an excluded path.
		// Prefer the embedded policy flag; fall back to path matching.
		let isExcluded: boolean;
		if (data?.excludedByPolicy !== undefined) {
			isExcluded = data.excludedByPolicy === true;
		} else if (typeof e.path === "string" && e.path.length > 0) {
			isExcluded = isExcludedByPath(e.path);
		} else {
			// No metadata and no path — skip this event silently.
			continue;
		}

		if (!isExcluded) continue;

		// This admission event is for an excluded path. Check for tombstone within window.
		const tombstone = events.find((t) =>
			t.kind === "crdt.file.tombstoned"
			&& t.pathId === e.pathId
			&& t.ts >= e.ts
			&& t.ts - e.ts <= WINDOW_MS,
		);

		if (!tombstone) {
			const isCleanup = cleanupPhaseTs < Infinity && e.ts >= cleanupPhaseTs;
			if (!isCleanup) {
				const pathDesc = typeof e.path === "string" && e.path.length > 0
					? `"${e.path}"`
					: `pathId=${e.pathId ?? "unknown"}`;
				findings.push({
					rule: "active-excluded-path",
					severity: "hard",
					pathId: e.pathId,
					eventSeqs: [e.seq],
					description:
						`${e.kind} for excluded path ${pathDesc} (seq=${e.seq}) ` +
						`with no crdt.file.tombstoned within ${WINDOW_MS}ms — ` +
						`excluded path became a live active CRDT entry. ` +
						`The post-rename policy guard (onRenameBatchFlushed) failed or ` +
						`a new admission path bypasses path exclusion checks.`,
				});
			}
		}
	}

	return findings;
}
