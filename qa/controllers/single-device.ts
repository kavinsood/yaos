#!/usr/bin/env bun
/**
 * qa:obsidian — Run a single-device QA scenario against a live Obsidian instance.
 *
 * Usage:
 *   bun run qa:obsidian --scenario single-device-basic-edit --port 9222 \
 *     --vault /path/to/vault [--out-dir qa-runs/]
 *
 * Requires Obsidian launched with:
 *   /path/to/Obsidian --remote-debugging-port=9222
 *
 * Exit code 0 = PASS. Exit code 1 = FAIL.
 */

import { resolve, join } from "path";
import { readFileSync } from "fs";
import { ObsidianClient } from "./obsidian-client.mjs";
import { ArtifactCollector } from "./collect-artifacts";
import { analyzeTrace } from "../analyzers/analyzer";
import { formatReport } from "../analyzers/report";
import { resolveTraceExportPath } from "./trace-path";

function parseArgs(args: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("--") && args[i + 1] && !args[i + 1]!.startsWith("--")) {
			result[a.slice(2)] = args[i + 1]!;
			i++;
		}
	}
	return result;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const scenario = args.scenario;
	const port = Number(args.port ?? 9222);
	const vaultPath = args.vault ? resolve(args.vault) : null;
	const outDir = resolve(args["out-dir"] ?? "qa-runs");
	const device = args.device ?? "A";

	if (!scenario) {
		console.error(
			"Usage: bun run qa:obsidian --scenario <id> [--port 9222] [--vault /path] " +
			"[--out-dir qa-runs/] [--device A]",
		);
		process.exit(1);
	}

	const collector = new ArtifactCollector(outDir, scenario, device, vaultPath ?? "unknown");
	await collector.init();

	const logLines: string[] = [];
	function log(msg: string): void {
		const line = `[${new Date().toISOString()}] ${msg}`;
		console.log(line);
		logLines.push(line);
	}

	log(`Starting scenario: ${scenario}`);
	log(`Port: ${port}, Device: ${device}`);
	if (vaultPath) log(`Vault: ${vaultPath}`);

	const client = new ObsidianClient({ port });

	try {
		log("Connecting to Obsidian…");
		await client.connect();
		log("Connected.");

		log("Waiting for QA APIs…");
		await client.waitForQaReady(30_000);
		log("QA APIs ready.");

		// Take pre-run manifest
		const preMani = await client.manifest();
		await collector.saveManifest(preMani, "manifest-pre");
		log("Pre-run manifest saved.");

		// Flight trace is already recording: the prepared vault sets debug:true.

		// Run the scenario
		log(`Running scenario: ${scenario}…`);
		const result = await client.runScenario(scenario);
		log(`Scenario ${result.passed ? "PASSED" : "FAILED"} in ${result.durationMs}ms`);
		if (result.errors.length > 0) {
			for (const e of result.errors) log(`  ERROR: ${e}`);
		}
		if (result.warnings.length > 0) {
			for (const w of result.warnings) log(`  WARN: ${w}`);
		}

		// Export trace and collect. Analysis is a required part of a passing run.
		log("Exporting flight trace…");
		const tracePath = await client.exportTrace("safe");
		if (!tracePath) throw new Error("trace export returned no path");
		log(`Trace exported: ${tracePath}`);
		const fullTracePath = resolveTraceExportPath(tracePath, vaultPath);
		await collector.collectTrace(fullTracePath);

		// Post-run manifest
		const postMani = await client.manifest();
		await collector.saveManifest(postMani, "manifest-post");
		log("Post-run manifest saved.");

		// Save result
		await collector.saveResult(result);

		// Analyze the collected trace. Missing, malformed, or failing analysis
		// makes the run fail closed.
		const traceCollected = join(collector.runDirectory, "flight-trace.ndjson");
		try {
			const raw = readFileSync(traceCollected, "utf-8");
			const report = analyzeTrace(raw, { traceFile: traceCollected, scenarioId: scenario });
			await collector.saveAnalyzerReport(report);
			log(formatReport(report));
			if (!report.passed) {
				log("Analyzer found hard failures — marking run as FAIL.");
				result.passed = false;
			}
		} catch (err) {
			log(`ERROR: trace analysis failed: ${String(err)}`);
			result.passed = false;
		}

		// Write log
		await collector.writeLog(logLines.join("\n"));
		log(`Artifacts in: ${collector.runDirectory}`);

		process.exit(result.passed ? 0 : 1);
	} catch (err) {
		log(`Fatal error: ${String(err)}`);
		await collector.writeLog(logLines.join("\n"));
		process.exit(1);
	} finally {
		await client.close();
	}
}

await main();
