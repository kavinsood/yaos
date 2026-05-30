#!/usr/bin/env bun
/**
 * YAOS flight trace analyzer.
 *
 * Usage:
 *   bun run qa:analyze path/to/flight-trace.ndjson [--scenario id] [--json]
 *
 * Exit code 0 = PASS (zero hard failures).
 * Exit code 1 = FAIL (at least one hard failure).
 */

import { readFileSync, writeFileSync } from "fs";
import { parseNdjson } from "./flight-event";
import { buildReport, formatReport } from "./report";
import type { AnalyzerFinding } from "./report";
import { checkScenarioExpectations } from "./scenario-expectations";

// Rules
import { checkUnsafeOverwrite } from "./rules/unsafe-overwrite";
import { checkRecoveryLoop } from "./rules/recovery-loop";
import { checkDeleteThenRevive } from "./rules/delete-then-revive";
import { checkSelfWriteSuppressionMiss } from "./rules/self-write-suppression-miss";
import { checkStuckReceipt } from "./rules/stuck-receipt";
import { checkFalseSafeToClose } from "./rules/false-safe-to-close";
import { checkDiskCrdtIdleMismatch } from "./rules/disk-crdt-idle-mismatch";
import { checkMissingPathId } from "./rules/missing-path-id";
import { checkRedactionFailure } from "./rules/redaction-failure";
import { checkDroppedCriticalEvent } from "./rules/dropped-critical-event";
import { checkOrphanAfterRename } from "./rules/orphan-after-rename";
import { checkActiveExcludedPath } from "./rules/active-excluded-path";

const ALL_RULES = [
	checkUnsafeOverwrite,
	checkRecoveryLoop,
	checkDeleteThenRevive,
	checkSelfWriteSuppressionMiss,
	checkStuckReceipt,
	checkFalseSafeToClose,
	checkDiskCrdtIdleMismatch,
	checkMissingPathId,
	checkRedactionFailure,
	checkDroppedCriticalEvent,
	checkOrphanAfterRename,
	checkActiveExcludedPath,
];

export function analyzeTrace(
	ndjsonContent: string,
	opts: { traceFile?: string; scenarioId?: string } = {},
): ReturnType<typeof buildReport> {
	const events = parseNdjson(ndjsonContent);
	const allFindings: AnalyzerFinding[] = [];
	for (const rule of ALL_RULES) {
		allFindings.push(...rule(events));
	}
	allFindings.push(...checkScenarioExpectations(events, opts.scenarioId));
	return buildReport(opts.traceFile ?? "unknown", events.length, allFindings, opts.scenarioId);
}

// -----------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------

if (import.meta.main) {
	const args = process.argv.slice(2);
	const positional = args.filter((a) => !a.startsWith("--"));
	const scenarioFlag = args.findIndex((a) => a === "--scenario");
	const scenarioId = scenarioFlag >= 0 ? args[scenarioFlag + 1] : undefined;
	const jsonFlag = args.includes("--json");
	const outFlag = args.findIndex((a) => a === "--out");
	const outFile = outFlag >= 0 ? args[outFlag + 1] : undefined;

	if (positional.length === 0) {
		console.error(
			"Usage: bun run qa:analyze path/to/flight-trace.ndjson [--scenario id] [--json] [--out report.json]",
		);
		process.exit(1);
	}

	let raw: string;
	try {
		raw = readFileSync(positional[0]!, "utf-8");
	} catch (err) {
		console.error(`Failed to read trace file: ${String(err)}`);
		process.exit(1);
	}

	const report = analyzeTrace(raw, { traceFile: positional[0], scenarioId });

	if (jsonFlag || outFile) {
		const json = JSON.stringify(report, null, 2);
		if (outFile) {
			writeFileSync(outFile, json, "utf-8");
			console.log(`Analyzer report written to ${outFile}`);
		} else {
			console.log(json);
		}
	} else {
		console.log(formatReport(report));
	}

	process.exit(report.passed ? 0 : 1);
}
