#!/usr/bin/env bun
/**
 * qa:two-device -- Run a two-device QA scenario against two live Obsidian instances.
 *
 * Usage:
 *   bun run qa:two-device --scenario offline-handoff-create \
 *     --port-a 9222 --port-b 9223 \
 *     --vault-a /path/to/vault-a --vault-b /path/to/vault-b \
 *     [--out-dir qa-runs/]
 *
 * Both Obsidian instances must be started with:
 *   /path/to/Obsidian --remote-debugging-port=922X --user-data-dir=/tmp/obs-X
 *
 * Exit code 0 = PASS on both devices. Exit code 1 = any failure.
 */

import { resolve, join } from "path";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { ObsidianClient } from "./obsidian-client.mjs";
import { TWO_DEVICE_SCENARIOS } from "./two-device-scenarios";
import { ArtifactCollector } from "./collect-artifacts";
import { analyzeTrace } from "../analyzers/analyzer";
import { formatReport } from "../analyzers/report";
/** Collect build identity for the QA run. */
async function collectBuildIdentity(
	clientA: ObsidianClient,
	clientB: ObsidianClient,
	log: (msg: string) => void,
): Promise<Record<string, unknown>> {
	// Git info (from the machine running the test)
	let gitCommit = "unknown";
	let gitDirty = "unknown";
	let gitDiffStat = "";
	try {
		gitCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
		const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
		gitDirty = status.length > 0 ? "dirty" : "clean";
		if (gitDirty === "dirty") {
			gitDiffStat = execSync("git diff --stat", { encoding: "utf-8" }).trim();
		}
	} catch { /* not in a git repo */ }

	// Runtime info from both instances.
	let identityA: Record<string, string> = {};
	let identityB: Record<string, string> = {};
	try {
		identityA = await clientA.getBuildIdentity();
	} catch (error) {
		log(`Warning: could not collect build identity from A: ${String(error)}`);
	}
	try {
		identityB = await clientB.getBuildIdentity();
	} catch (error) {
		log(`Warning: could not collect build identity from B: ${String(error)}`);
	}

	const identity: Record<string, unknown> = {
		gitCommit,
		gitWorkingTree: gitDirty,
		...(gitDiffStat ? { gitDiffStat } : {}),
		runTimestamp: new Date().toISOString(),
		deviceA: identityA,
		deviceB: identityB,
	};

	log(`Build identity: git=${gitCommit.slice(0, 10)} (${gitDirty})`);
	if (gitDiffStat) log(`  Dirty files:\n${gitDiffStat.split("\n").map(l => "    " + l).join("\n")}`);
	log(`  Device A: plugin=${identityA.pluginVersion ?? "?"}, bundle=${(identityA.bundleHash ?? "?").slice(0, 12)}..., electron=${identityA.electronVersion ?? "?"}, vault=${identityA.vaultName ?? "?"}`);
	log(`  Device B: plugin=${identityB.pluginVersion ?? "?"}, bundle=${(identityB.bundleHash ?? "?").slice(0, 12)}..., electron=${identityB.electronVersion ?? "?"}, vault=${identityB.vaultName ?? "?"}`);

	// Verify both vaults loaded the same bundle
	if (identityA.bundleHash && identityB.bundleHash &&
		identityA.bundleHash !== "unknown" && identityB.bundleHash !== "unknown") {
		if (identityA.bundleHash === identityB.bundleHash) {
			log(`  Bundle match: A == B ✓`);
		} else {
			log(`  WARNING: Bundle mismatch! A=${identityA.bundleHash.slice(0, 12)} B=${identityB.bundleHash.slice(0, 12)}`);
		}
	}

	return identity;
}

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

// -----------------------------------------------------------------------
// Collect trace from vault and run analyzer
// -----------------------------------------------------------------------

async function collectAndAnalyze(
	client: ObsidianClient,
	collector: ArtifactCollector,
	vaultPath: string | null,
	device: string,
	scenario: string,
	log: (msg: string) => void,
): Promise<boolean> {
	try {
		const tracePath = await client.exportTrace("safe");
		if (!tracePath) throw new Error("trace export returned no path");
		if (!vaultPath && !tracePath.startsWith("/")) {
			throw new Error("vault path is required to collect a relative trace export");
		}
		log(`Device ${device} trace export path: ${tracePath}`);

		const fullTracePath = tracePath.startsWith("/")
			? tracePath
			: join(vaultPath!, tracePath);
		await collector.collectTrace(fullTracePath);

		const traceInArtifacts = join(collector.runDirectory, "flight-trace.ndjson");
		if (!existsSync(traceInArtifacts)) {
			throw new Error("collected trace is missing from the artifact directory");
		}
		const raw = readFileSync(traceInArtifacts, "utf-8");
		const report = analyzeTrace(raw, { traceFile: traceInArtifacts, scenarioId: scenario });
		await collector.saveAnalyzerReport(report);
		log(`Device ${device} analyzer: ${report.passed ? "PASS" : "FAIL"}`);
		log(formatReport(report));
		return report.passed;
	} catch (err) {
		log(`ERROR: trace collection/analyzer failed for device ${device}: ${String(err)}`);
		return false;
	}
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const scenario = args.scenario;
	const portA = Number(args["port-a"] ?? 9222);
	const portB = Number(args["port-b"] ?? 9223);
	const vaultA = args["vault-a"] ? resolve(args["vault-a"]) : null;
	const vaultB = args["vault-b"] ? resolve(args["vault-b"]) : null;
	const outDir = resolve(args["out-dir"] ?? "qa-runs");

	if (!scenario) {
		console.error(
			"Usage: bun run qa:two-device --scenario <id> --port-a 9222 --port-b 9223 " +
			"[--vault-a /path] [--vault-b /path] [--out-dir qa-runs/]",
		);
		console.error("Available scenarios:", Object.keys(TWO_DEVICE_SCENARIOS).join(", "));
		process.exit(1);
	}


	const scenarioFn = TWO_DEVICE_SCENARIOS[scenario];
	if (!scenarioFn) {
		console.error(`Unknown two-device scenario: ${scenario}`);
		console.error("Available:", Object.keys(TWO_DEVICE_SCENARIOS).join(", "));
		process.exit(1);
	}

	const collectorA = new ArtifactCollector(outDir, scenario, "A", vaultA ?? "unknown");
	const collectorB = new ArtifactCollector(outDir, scenario, "B", vaultB ?? "unknown");
	await collectorA.init();
	await collectorB.init();

	const logLines: string[] = [];
	function log(msg: string): void {
		const line = `[${new Date().toISOString()}] ${msg}`;
		console.log(line);
		logLines.push(line);
	}

	const clientA = new ObsidianClient({ port: portA });
	const clientB = new ObsidianClient({ port: portB });

	try {
		log(`Connecting to Obsidian A (port ${portA})...`);
		await clientA.connect();
		log(`Connecting to Obsidian B (port ${portB})...`);
		await clientB.connect();
		log("Connected to both instances.");

		log("Waiting for QA APIs on both devices...");
		await Promise.all([clientA.waitForQaReady(30_000), clientB.waitForQaReady(30_000)]);
		log("QA APIs ready on both devices.");

		// Auto-detect vault paths from live instances if not provided as CLI args.
		// Required for trace collection -- flight traces are exported relative to vault root.
		const resolvedVaultA = vaultA ?? await clientA.evalRaw<string>("app.vault.adapter.basePath").catch(() => null);
		const resolvedVaultB = vaultB ?? await clientB.evalRaw<string>("app.vault.adapter.basePath").catch(() => null);
		if (resolvedVaultA) log(`Vault A path: ${resolvedVaultA}`);
		if (resolvedVaultB) log(`Vault B path: ${resolvedVaultB}`);

		// Collect and record build identity
		const buildIdentity = await collectBuildIdentity(clientA, clientB, log);
		await collectorA.writeLog(JSON.stringify(buildIdentity, null, 2), "build-identity.json");
		await collectorB.writeLog(JSON.stringify(buildIdentity, null, 2), "build-identity.json");

		// Pre-run manifests
		const [maniA, maniB] = await Promise.all([
			clientA.manifest().catch(() => null),
			clientB.manifest().catch(() => null),
		]);
		if (maniA) await collectorA.saveManifest(maniA, "manifest-pre");
		if (maniB) await collectorB.saveManifest(maniB, "manifest-pre");
		log("Pre-run manifests saved.");

		// No trace start: recording follows each vault's settings.debug, which
		// qa/scripts/prepare-vault-lib.ts sets to true.

		// Run the two-device scenario
		log(`Running two-device scenario: ${scenario}...`);
		const start = Date.now();
		const scenarioResult = await scenarioFn(clientA, clientB, log);
		const { passedA, passedB, errors, evidence } = scenarioResult;
		const durationMs = Date.now() - start;
		log(`Scenario done in ${durationMs}ms. A: ${passedA ? "PASS" : "FAIL"}, B: ${passedB ? "PASS" : "FAIL"}`);
		if (errors.length > 0) {
			for (const e of errors) log(`  ERROR: ${e}`);
		}

		// Collect post-run manifests
		const [postManiA, postManiB] = await Promise.all([
			clientA.manifest().catch(() => null),
			clientB.manifest().catch(() => null),
		]);
		if (postManiA) await collectorA.saveManifest(postManiA, "manifest-post");
		if (postManiB) await collectorB.saveManifest(postManiB, "manifest-post");
		log("Post-run manifests saved.");

		// Collect traces and run analyzer on each
		const [analyzerPassedA, analyzerPassedB] = await Promise.all([
			collectAndAnalyze(clientA, collectorA, resolvedVaultA, "A", scenario, log),
			collectAndAnalyze(clientB, collectorB, resolvedVaultB, "B", scenario, log),
		]);

		const overallPassed = passedA && passedB && analyzerPassedA && analyzerPassedB;
		const result = { passed: overallPassed, durationMs, errors, warnings: [] as string[], evidence };
		if (!analyzerPassedA) result.errors.push("Device A: analyzer found hard failures");
		if (!analyzerPassedB) result.errors.push("Device B: analyzer found hard failures");

		await collectorA.saveResult({ passed: passedA && analyzerPassedA, durationMs, errors, warnings: [], evidence });
		await collectorB.saveResult({ passed: passedB && analyzerPassedB, durationMs, errors, warnings: [], evidence });

		await collectorA.writeLog(logLines.join("\n"));
		log(`Artifacts A: ${collectorA.runDirectory}`);
		log(`Artifacts B: ${collectorB.runDirectory}`);

		process.exit(overallPassed ? 0 : 1);
	} catch (err) {
		log(`Fatal error: ${String(err)}`);
		await collectorA.writeLog(logLines.join("\n"));
		process.exit(1);
	} finally {
		await clientA.close();
		await clientB.close();
	}
}

await main();
