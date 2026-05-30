import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

/** Scopes that should always have a pathId. */
const PATH_SCOPED_KINDS = new Set([
	"disk.create.observed",
	"disk.modify.observed",
	"disk.delete.observed",
	"disk.event.suppressed",
	"disk.event.not_suppressed",
	"disk.write.planned",
	"disk.write.ok",
	"disk.write.failed",
	"crdt.file.created",
	"crdt.file.updated",
	"crdt.file.tombstoned",
	"crdt.file.revived",
	"reconcile.file.decision",
	"reconcile.writeback.applied",
	"reconcile.writeback.skipped",
	"recovery.decision",
	"recovery.apply.start",
	"recovery.apply.done",
	"recovery.postcondition.failed",
	"recovery.quarantined",
]);

/**
 * Rule: missing path ID
 *
 * Any path-scoped event (disk/crdt/recovery/reconcile) without a pathId is
 * a warning — it means the event cannot be correlated to other events for
 * that file.
 */
export function checkMissingPathId(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];
	const pathScopedSeen = events.some((e) => PATH_SCOPED_KINDS.has(e.kind));
	if (!pathScopedSeen) {
		findings.push({
			rule: "missing-path-id",
			severity: "warning",
			eventSeqs: [],
			description:
				"COVERAGE: no path-scoped events seen at all — " +
				"missing-path-id rule had nothing to check",
		});
		return findings;
	}

	for (const e of events) {
		if (PATH_SCOPED_KINDS.has(e.kind) && !e.pathId) {
			findings.push({
				rule: "missing-path-id",
				severity: "warning",
				opId: e.opId,
				eventSeqs: [e.seq],
				description: `Event kind=${e.kind} (seq=${e.seq}) has no pathId`,
			});
		}
	}

	return findings;
}
