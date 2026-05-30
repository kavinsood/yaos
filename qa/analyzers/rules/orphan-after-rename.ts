import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

/**
 * Rule: orphan-after-rename
 *
 * disk.rename.observed is now emitted as TWO events sharing the same opId:
 *   - renameRole: "source" (oldPath → oldPathId)
 *   - renameRole: "target" (newPath → newPathId)
 *
 * After both fire, the trace should show:
 *   (a) crdt.file.renamed with newPathId
 *   (b) NO crdt.file.created for newPathId after the rename (identity lost)
 *   (c) NO crdt.file.tombstoned for newPathId before the cleanup phase
 *
 * Phase-marker logic:
 *   Tombstones that happen during the cleanup phase (after qa.phase{phase:"cleanup"})
 *   are expected scenario teardown and are not flagged.
 *
 * Backward compatibility:
 *   Traces without qa.phase events fall back to using disk.delete.observed
 *   as a proxy for "intentional user delete" (the old heuristic).
 *
 * Also flags:
 *   - target-role disk.rename.observed with no matching crdt.file.renamed
 */
const WINDOW_MS = 15_000;

export function checkOrphanAfterRename(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	// Find all target-role rename events (the new path side).
	// Pre-dual-event traces had no renameRole; fall back to any disk.rename.observed.
	const targetRenames = events.filter((e) => {
		if (e.kind !== "disk.rename.observed") return false;
		const role = (e.data as Record<string, unknown> | undefined)?.renameRole;
		return role === "target" || role === undefined;
	});

	if (targetRenames.length === 0) return findings;

	// Build set of pathIds that appear as a SOURCE in a rename event within this trace.
	// A pathId that is both a rename target AND a subsequent rename source is an
	// intermediate hop in a rename chain (e.g. A→B→C: B is target of A→B and source
	// of B→C). YAOS collapses chains into a single CRDT rename (A→C), so B never gets
	// a crdt.file.renamed event. These intermediate hops are exempt from the hard failure.
	const sourcePathIds = new Set(
		events
			.filter((e) =>
				e.kind === "disk.rename.observed"
				&& (e.data as Record<string, unknown> | undefined)?.renameRole === "source",
			)
			.map((e) => e.pathId)
			.filter((id): id is string => !!id && id !== "p:unavailable"),
	);

	// Determine cleanup phase start time from qa.phase markers (taxonomy v5+).
	const cleanupPhaseTs = events
		.filter((e) => e.kind === "qa.phase" && (e.data as Record<string, unknown> | undefined)?.phase === "cleanup")
		.reduce((min, e) => Math.min(min, e.ts), Infinity);
	const hasCleanupPhaseMarker = cleanupPhaseTs < Infinity;

	for (const renameEvent of targetRenames) {
		const newPathId = renameEvent.pathId;
		if (!newPathId || newPathId === "p:unavailable") continue;

		// Intermediate chain hop: this path was immediately renamed again.
		// YAOS collapses the chain in the CRDT batch, so no crdt.file.renamed
		// will appear for this intermediate path. This is correct behavior.
		if (sourcePathIds.has(newPathId)) continue;

		// Find the source-role event with the same opId to get oldPathId.
		const sourceEvent = events.find((e) =>
			e.kind === "disk.rename.observed"
			&& e.opId === renameEvent.opId
			&& (e.data as Record<string, unknown> | undefined)?.renameRole === "source",
		);
		const oldPathId = sourceEvent?.pathId ?? "unknown";

		const renameTs = renameEvent.ts;

		// (a) crdt.file.renamed must appear within window.
		//     If not, check whether this is a pre-CRDT race recovery or a true silent drop.
		const crdtRenamed = events.find((e) =>
			e.kind === "crdt.file.renamed"
			&& e.pathId === newPathId
			&& e.ts >= renameTs
			&& e.ts - renameTs <= WINDOW_MS,
		);

		if (!crdtRenamed) {
			// Determine whether the source file ever had a CRDT identity before the rename.
			// If oldPath had a crdt.file.created event before the rename fired, YAOS should
			// have had a fileId and the rename should have produced crdt.file.renamed.
			// If it did NOT, this is the pre-CRDT race: rename fired before ensureFile ran.
			const sourceHadCrdtIdentityBeforeRename = events.some((e) =>
				e.kind === "crdt.file.created"
				&& e.pathId === oldPathId
				&& e.ts < renameTs,
			);

			// In the race case, the valid recovery outcome is crdt.file.created at newPath
			// (content redirected, new fileId assigned). Only accept this downgrade when:
			//   1. Source had NO prior CRDT identity (true race — no fileId to rename from)
			//   2. crdt.file.created at newPath appeared within window
			const crdtCreatedAsRecovery = !sourceHadCrdtIdentityBeforeRename
				? events.find((e) =>
					e.kind === "crdt.file.created"
					&& e.pathId === newPathId
					&& e.ts >= renameTs
					&& e.ts - renameTs <= WINDOW_MS,
				)
				: undefined;

			if (crdtCreatedAsRecovery) {
				// Pre-CRDT race recovery: content preserved at newPath, but via a new
				// fileId rather than an identity-preserving rename. Warning, not hard failure.
				findings.push({
					rule: "orphan-after-rename",
					severity: "warning",
					pathId: newPathId,
					eventSeqs: [renameEvent.seq, crdtCreatedAsRecovery.seq],
					description:
						`disk.rename.observed for pathId=${newPathId} was handled via race recovery ` +
						`(crdt.file.created instead of crdt.file.renamed) — rename fired before CRDT ` +
						`had a fileId for oldPath=${oldPathId}. Content preserved; fileId is new.`,
				});
			} else {
				// Either source had a CRDT identity (real identity-loss bug) or no
				// crdt.file.created appeared at all (content lost entirely).
				const reason = sourceHadCrdtIdentityBeforeRename
					? `source pathId=${oldPathId} had a prior CRDT identity — this is identity loss, not race recovery`
					: `no crdt.file.created or crdt.file.renamed for pathId=${newPathId} within ${WINDOW_MS}ms`;
				findings.push({
					rule: "orphan-after-rename",
					severity: "hard",
					pathId: newPathId,
					eventSeqs: [renameEvent.seq],
					description:
						`disk.rename.observed (seq=${renameEvent.seq}, opId=${renameEvent.opId ?? "?"}) ` +
						`was not followed by crdt.file.renamed for pathId=${newPathId} within ${WINDOW_MS}ms ` +
						`— ${reason}. oldPathId=${oldPathId}`,
				});
			}
			continue;
		}

		// (b) crdt.file.created AFTER rename = identity lost.
		const crdtCreatedAfterRename = events.find((e) =>
			e.kind === "crdt.file.created"
			&& e.pathId === newPathId
			&& e.ts > crdtRenamed.ts,
		);
		if (crdtCreatedAfterRename) {
			findings.push({
				rule: "orphan-after-rename",
				severity: "hard",
				pathId: newPathId,
				eventSeqs: [renameEvent.seq, crdtRenamed.seq, crdtCreatedAfterRename.seq],
				description:
					`crdt.file.created appeared after crdt.file.renamed for pathId=${newPathId} — ` +
					`file identity was lost (rename + create instead of identity-preserving rename). ` +
					`oldPathId=${oldPathId}`,
			});
		}

		// (c) crdt.file.tombstoned without revive = spurious tombstone.
		// A tombstone is intentional if:
		//   - Phase markers: it happened at or after the cleanup phase start, OR
		//   - Fallback (no cleanup marker in trace): disk.delete.observed preceded it.
		const tombstonedAfterRename = events.find((e) =>
			e.kind === "crdt.file.tombstoned"
			&& e.pathId === newPathId
			&& e.ts > crdtRenamed.ts
			&& e.ts - crdtRenamed.ts <= WINDOW_MS,
		);
		if (tombstonedAfterRename) {
			const isIntentional =
				// Phase-marker check (cleanup phase event in trace = teardown)
				(hasCleanupPhaseMarker && tombstonedAfterRename.ts >= cleanupPhaseTs)
				// Fallback heuristic: disk.delete.observed preceded the tombstone
				|| events.some((e) =>
					e.kind === "disk.delete.observed"
					&& e.pathId === newPathId
					&& e.ts <= tombstonedAfterRename.ts,
				);

			if (!isIntentional) {
				const revivedAfter = events.find((e) =>
					e.kind === "crdt.file.revived"
					&& e.pathId === newPathId
					&& e.ts > tombstonedAfterRename.ts,
				);
				if (!revivedAfter) {
					const markerNote = hasCleanupPhaseMarker
						? `cleanup phase starts at ${cleanupPhaseTs}`
						: "no cleanup phase marker (fallback: disk.delete.observed)";
					findings.push({
						rule: "orphan-after-rename",
						severity: "hard",
						pathId: newPathId,
						eventSeqs: [crdtRenamed.seq, tombstonedAfterRename.seq],
						description:
							`crdt.file.tombstoned appeared for pathId=${newPathId} after rename ` +
							`without an intentional delete signal (${markerNote}) and no revive — ` +
							`renamed file may have been tombstoned by the system. oldPathId=${oldPathId}`,
					});
				}
			}
		}
	}

	return findings;
}
