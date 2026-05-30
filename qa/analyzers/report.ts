/**
 * Analyzer report types and formatting.
 */

export interface AnalyzerFinding {
	rule: string;
	severity: "hard" | "warning";
	pathId?: string;
	opId?: string;
	eventSeqs: number[];
	description: string;
}

export interface AnalyzerReport {
	scenarioId?: string;
	traceFile: string;
	analyzedAt: string;
	passed: boolean;

	summary: {
		hardFailures: number;
		warnings: number;
		checkedEvents: number;
		incompleteOps: number;
		hashMismatches: number;
	criticalDrops: number;
	redactionFailures: number;
	scenarioFailures: number;
	};

	failures: AnalyzerFinding[];
	warnings: AnalyzerFinding[];
}

export function buildReport(
	traceFile: string,
	checkedEvents: number,
	findings: AnalyzerFinding[],
	scenarioId?: string,
): AnalyzerReport {
	const failures = findings.filter((f) => f.severity === "hard");
	const warnings = findings.filter((f) => f.severity === "warning");

	const criticalDrops = findings.filter((f) => f.rule === "dropped-critical-event").length;
	const redactionFailures = findings.filter((f) => f.rule === "redaction-failure").length;
	const hashMismatches = findings.filter((f) => f.rule === "disk-crdt-idle-mismatch").length;
	const incompleteOps = findings.filter((f) => f.rule === "stuck-receipt").length;
	const scenarioFailures = findings.filter((f) => f.rule === "scenario-expectation-missing").length;

	return {
		scenarioId,
		traceFile,
		analyzedAt: new Date().toISOString(),
		passed: failures.length === 0,
		summary: {
			hardFailures: failures.length,
			warnings: warnings.length,
			checkedEvents,
			incompleteOps,
			hashMismatches,
			criticalDrops,
			redactionFailures,
			scenarioFailures,
		},
		failures,
		warnings,
	};
}

export function formatReport(report: AnalyzerReport): string {
	const lines: string[] = [];
	const icon = report.passed ? "PASS" : "FAIL";
	lines.push(`Analyzer: ${icon}`);
	if (report.scenarioId) lines.push(`Scenario: ${report.scenarioId}`);
	lines.push(`Trace: ${report.traceFile}`);
	lines.push(`Analyzed: ${report.analyzedAt}`);
	lines.push("");
	lines.push(`Events checked: ${report.summary.checkedEvents}`);
	lines.push(`Hard failures:  ${report.summary.hardFailures}`);
	lines.push(`Warnings:       ${report.summary.warnings}`);
	lines.push(`Critical drops: ${report.summary.criticalDrops}`);
	lines.push(`Redaction fail: ${report.summary.redactionFailures}`);
	lines.push(`Scenario reqs:  ${report.summary.scenarioFailures}`);
	lines.push(`Hash mismatches:${report.summary.hashMismatches}`);
	lines.push(`Stuck receipts: ${report.summary.incompleteOps}`);

	if (report.failures.length > 0) {
		lines.push("");
		lines.push("HARD FAILURES:");
		for (const f of report.failures) {
			lines.push(`  [${f.rule}] ${f.description}`);
			if (f.pathId) lines.push(`    pathId=${f.pathId}`);
			if (f.opId) lines.push(`    opId=${f.opId}`);
			if (f.eventSeqs.length > 0) lines.push(`    seqs=${f.eventSeqs.slice(0, 5).join(",")}`);
		}
	}

	if (report.warnings.length > 0) {
		lines.push("");
		lines.push("WARNINGS:");
		for (const w of report.warnings) {
			lines.push(`  [${w.rule}] ${w.description}`);
			if (w.pathId) lines.push(`    pathId=${w.pathId}`);
		}
	}

	return lines.join("\n");
}
