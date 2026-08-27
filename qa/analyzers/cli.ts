#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { analyzeTrace } from "./analyzer";
import { formatReport } from "./report";

const args = process.argv.slice(2);
const positional = args.filter((argument) => !argument.startsWith("--"));
const scenarioFlag = args.findIndex((argument) => argument === "--scenario");
const scenarioId = scenarioFlag >= 0 ? args[scenarioFlag + 1] : undefined;
const jsonFlag = args.includes("--json");
const outFlag = args.findIndex((argument) => argument === "--out");
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
} catch (error) {
	console.error(`Failed to read trace file: ${String(error)}`);
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
