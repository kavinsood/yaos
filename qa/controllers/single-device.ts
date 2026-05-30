#!/usr/bin/env bun
/**
 * qa:obsidian — Run a single-device QA scenario against a live Obsidian instance.
 *
 * Usage:
 *   bun run qa:obsidian --scenario single-device-basic-edit --port 9222 \
 *     --vault /path/to/vault [--trace qa-safe] [--out-dir qa-runs/]
 *
 * Requires Obsidian launched with:
 *   /path/to/Obsidian --remote-debugging-port=9222
 *
 * Exit code 0 = PASS. Exit code 1 = FAIL.
 */

import { resolve, join } from "path";
import { readFileSync } from "fs";
import { ObsidianClient } from "./obsidian-client";
import { ArtifactCollector } from "./collect-artifacts";
import { analyzeTrace } from "../analyzers/analyzer";
import { formatReport } from "../analyzers/report";

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
	const traceMode = args.trace ?? "qa-safe";
	const outDir = resolve(args["out-dir"] ?? "qa-runs");
	const device = args.device ?? "A";

	if (!scenario) {
		console.error(
			"Usage: bun run qa:obsidian --scenario <id> [--port 9222] [--vault /path] " +
			"[--trace qa-safe] [--out-dir qa-runs/] [--device A]",
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

		// Start flight trace
		log(`Starting flight trace (mode=${traceMode})…`);
		await client.startTrace(traceMode);

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

		// Stop trace and collect
		log("Stopping flight trace…");
		const tracePath = await client.stopAndExportTrace("safe");
		log(`Trace exported: ${tracePath}`);
		if (tracePath && vaultPath) {
			const fullTracePath = tracePath.startsWith("/")
				? tracePath
				: join(vaultPath, ".obsidian", tracePath);
			await collector.collectTrace(fullTracePath).catch((e) =>
				log(`Warning: could not collect trace: ${e}`),
			);
		}

		// Post-run manifest
		const postMani = await client.manifest();
		await collector.saveManifest(postMani, "manifest-post");
		log("Post-run manifest saved.");

		// Save result
		await collector.saveResult(result);

		// Analyze trace if collected
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
		} catch {
			log("Warning: could not analyze trace (not found or parse error).");
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
