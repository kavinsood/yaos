import type { FlightEvent } from "../flight-event";
import type { AnalyzerFinding } from "../report";

const RELEVANT_KINDS = new Set(["reconcile.file.decision"]);

/**
 * Rule: unsafe overwrite
 *
 * Flag when reconcile.file.decision has:
 *   - decision === "preserve-conflict" with reason === "missing-baseline" AND
 *   - conflictRisk is "ambiguous" (i.e., we don't know if disk changed) AND
 *   - the file WAS in the updatedOnDisk set (meaning CRDT→disk would follow)
 *
 * Also flags when decision is "apply-remote-to-disk" but disk actually
 * differed from CRDT in a way that bypassed conflict preservation.
 *
 * Note: with baselineHash=null (current implementation), ALL decisions
 * where disk≠CRDT result in "preserve-conflict". The "ambiguous" case
 * means we proceeded without a known baseline — that warrants a warning.
 */
export function checkUnsafeOverwrite(events: FlightEvent[]): AnalyzerFinding[] {
	const findings: AnalyzerFinding[] = [];

	const relevant = events.filter((e) => RELEVANT_KINDS.has(e.kind));

	if (relevant.length === 0) {
		findings.push({
			rule: "unsafe-overwrite",
			severity: "warning",
			eventSeqs: [],
			description:
				"COVERAGE: no reconcile.file.decision events seen — " +
				"unsafe-overwrite rule could not fire",
		});
		return findings;
	}

	for (const e of relevant) {
		const d = (e.data ?? {}) as Record<string, unknown>;
		const decision = d.decision as string | undefined;
		const reason = d.reason as string | undefined;
		const conflictRisk = d.conflictRisk as string | undefined;

		// Case 1: missing-baseline preserve-conflict (ambiguous authority)
		if (
			decision === "preserve-conflict" &&
			reason === "missing-baseline" &&
			conflictRisk === "ambiguous"
		) {
			findings.push({
				rule: "unsafe-overwrite",
				severity: "warning",
				pathId: e.pathId,
				opId: e.opId,
				eventSeqs: [e.seq],
				description:
					`reconcile.file.decision: preserve-conflict/missing-baseline with conflictRisk=ambiguous ` +
					`for pathId=${e.pathId ?? "unknown"} — no baseline to determine safe authority`,
			});
		}

		// Case 2: apply-remote-to-disk despite both sides changing (should have been preserve-conflict)
		if (decision === "apply-remote-to-disk" && reason === "both-changed") {
			findings.push({
				rule: "unsafe-overwrite",
				severity: "hard",
				pathId: e.pathId,
				opId: e.opId,
				eventSeqs: [e.seq],
				description:
					`reconcile.file.decision: apply-remote-to-disk with reason=both-changed ` +
					`for pathId=${e.pathId ?? "unknown"} — CRDT overwrote disk changes without preservation`,
			});
		}
	}

	return findings;
}
