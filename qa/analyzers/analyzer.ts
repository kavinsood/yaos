/**
 * Reusable YAOS flight trace analysis. CLI concerns live in `cli.ts` so this
 * module remains safe to bundle into the Obsidian QA harness.
 */

import { parseNdjson } from "./flight-event";
import { buildReport } from "./report";
import type { AnalyzerFinding } from "./report";
import { checkScenarioExpectations } from "./scenario-expectations";

// Rules
import { checkUnsafeOverwrite } from "./rules/unsafe-overwrite";
import { checkRecoveryLoop } from "./rules/recovery-loop";
import { checkDeleteThenRevive } from "./rules/delete-then-revive";
import { checkSelfWriteSuppressionMiss } from "./rules/self-write-suppression-miss";
import { checkStuckReceipt } from "./rules/stuck-receipt";
import { checkDiskCrdtIdleMismatch } from "./rules/disk-crdt-idle-mismatch";
import { checkMissingPathId } from "./rules/missing-path-id";
import { checkRedactionFailure } from "./rules/redaction-failure";
import { checkDroppedCriticalEvent } from "./rules/dropped-critical-event";
import { checkOrphanAfterRename } from "./rules/orphan-after-rename";
import { checkActiveExcludedPath } from "./rules/active-excluded-path";

const ALL_RULES = [
	{ id: "unsafe-overwrite", check: checkUnsafeOverwrite },
	{ id: "recovery-loop", check: checkRecoveryLoop },
	{ id: "delete-then-revive", check: checkDeleteThenRevive },
	{ id: "self-write-suppression-miss", check: checkSelfWriteSuppressionMiss },
	{ id: "stuck-receipt", check: checkStuckReceipt },
	{ id: "disk-crdt-idle-mismatch", check: checkDiskCrdtIdleMismatch },
	{ id: "missing-path-id", check: checkMissingPathId },
	{ id: "redaction-failure", check: checkRedactionFailure },
	{ id: "dropped-critical-event", check: checkDroppedCriticalEvent },
	{ id: "orphan-after-rename", check: checkOrphanAfterRename },
	{ id: "active-excluded-path", check: checkActiveExcludedPath },
] as const;

export function analyzeTrace(
	ndjsonContent: string,
	opts: { traceFile?: string; scenarioId?: string } = {},
): ReturnType<typeof buildReport> {
	const { events, issues } = parseNdjson(ndjsonContent);
	const allFindings: AnalyzerFinding[] = [];
	if (issues.length > 0) {
		const preview = issues
			.slice(0, 10)
			.map((issue) => `${issue.line} (${issue.reason})`)
			.join(", ");
		allFindings.push({
			rule: "malformed-flight-event",
			severity: "hard",
			eventSeqs: [],
			description:
				`Trace contains ${issues.length} malformed nonblank line(s): ${preview}` +
				(issues.length > 10 ? ", …" : ""),
		});
	}
	const applicableRules: string[] = [];
	const notApplicableRules: Array<{ rule: string; reason: string }> = [];
	for (const rule of ALL_RULES) {
		let applicable = true;
		for (const finding of rule.check(events)) {
			if (
				finding.severity === "warning"
				&& finding.eventSeqs.length === 0
				&& finding.description.startsWith("COVERAGE:")
			) {
				applicable = false;
				notApplicableRules.push({
					rule: rule.id,
					reason: finding.description.slice("COVERAGE:".length).trim(),
				});
			} else {
				allFindings.push(finding);
			}
		}
		if (applicable) applicableRules.push(rule.id);
	}
	allFindings.push(...checkScenarioExpectations(events, opts.scenarioId));
	return buildReport(
		opts.traceFile ?? "unknown",
		events.length,
		allFindings,
		{ applicableRules, notApplicableRules },
		opts.scenarioId,
	);
}
