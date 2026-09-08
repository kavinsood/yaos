import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateFrozenTrace, PATHOLOGY_PROFILES, readTraceManifest, validateFrozenTrace } from "./trace";
import { additionalHighWaterBytes } from "./metrics";
import type { LabMeasurement } from "./types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TYPESCRIPT_RUNNER = join(REPO_ROOT, "tests/run-typescript.mjs");
const CHILD = join(REPO_ROOT, "scripts/pathology-lab/child.ts");
const PREPARE = join(REPO_ROOT, "scripts/pathology-lab/prepare.ts");
const DEFAULT_ARMS = [
	"body-current",
	"body-rematerialize",
	"body-semantic-reset",
	"server-current",
	"server-semantic-compaction",
	"server-semantic-compaction-soak",
	"server-validated-once",
	"server-persistent-exact",
	"server-persistent-periodic",
	"socket-admission-current",
	"socket-validation-mirror",
	"socket-production-mirror",
	"socket-apply-floor",
	"checkpoint-current",
	"checkpoint-live",
	"reconstruct-current",
	"reconstruct-self-contained",
	"root-current",
	"root-semantic-reset",
	"root-production-semantic-reset",
	"pin-retention",
	"epoch-current-risk",
] as const;

interface Arguments {
	profile: string;
	seed: number;
	outputDirectory: string;
	traceDirectory: string | null;
	corpusRoots: string[];
	arms: string[];
	generateOnly: boolean;
	reportOnly: boolean;
	resultRoots: string[];
	maxOldSpaceMiB: number;
}

function valueAfter(argv: readonly string[], flag: string): string | null {
	const index = argv.indexOf(flag);
	return index < 0 ? null : argv[index + 1] ?? null;
}

function parseArguments(argv: readonly string[]): Arguments {
	const profile = valueAfter(argv, "--profile") ?? "quick";
	if (!PATHOLOGY_PROFILES[profile]) throw new Error(`unknown profile ${profile}; choose ${Object.keys(PATHOLOGY_PROFILES).join(", ")}`);
	const seed = Number(valueAfter(argv, "--seed") ?? 0x5eed_c0de);
	if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("--seed must be a uint32");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outputDirectory = resolve(valueAfter(argv, "--output") ?? join(REPO_ROOT, "qa-runs/pathology-lab", `${profile}-${stamp}`));
	const armsValue = valueAfter(argv, "--arms");
	const arms = armsValue ? armsValue.split(",").map((value) => value.trim()).filter(Boolean) : [...DEFAULT_ARMS];
	const maxOldSpaceMiB = Number(valueAfter(argv, "--max-old-space-mib") ?? 2048);
	if (!Number.isSafeInteger(maxOldSpaceMiB) || maxOldSpaceMiB < 128) throw new Error("--max-old-space-mib must be an integer >= 128");
	return {
		profile,
		seed,
		outputDirectory,
		traceDirectory: valueAfter(argv, "--trace"),
		corpusRoots: (valueAfter(argv, "--corpus") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
		arms,
		generateOnly: argv.includes("--generate-only"),
		reportOnly: argv.includes("--report-only"),
		resultRoots: (valueAfter(argv, "--result-roots") ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => resolve(value)),
		maxOldSpaceMiB,
	};
}

function atomicJson(path: string, value: unknown): void {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

function mib(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

function percentReduction(before: number | null, after: number | null): number | null {
	if (before === null || after === null || before <= 0) return null;
	return 100 * (1 - after / before);
}

function measurementMap(measurements: readonly LabMeasurement[]): Map<string, LabMeasurement> {
	return new Map(measurements.map((measurement) => [measurement.arm, measurement]));
}

function normalizeMeasurement(measurement: LabMeasurement): LabMeasurement {
	return {
		...measurement,
		peakAdditionalRssBytes: additionalHighWaterBytes(measurement.baseline, measurement.peak.maxRssBytes),
	};
}

function importMeasurements(root: string): LabMeasurement[] {
	const individual = readdirSync(root)
		.filter((name) => /^result-.+\.json$/.test(name))
		.map((name) => normalizeMeasurement(JSON.parse(readFileSync(join(root, name), "utf8")) as LabMeasurement));
	if (individual.length > 0) return individual;
	const aggregatePath = join(root, "results.json");
	if (!existsSync(aggregatePath)) return [];
	const aggregate = JSON.parse(readFileSync(aggregatePath, "utf8")) as { measurements?: LabMeasurement[] };
	return (aggregate.measurements ?? []).map(normalizeMeasurement);
}

function writeMarkdownReport(path: string, traceDirectory: string, measurements: readonly LabMeasurement[]): void {
	const manifest = readTraceManifest(traceDirectory);
	const byArm = measurementMap(measurements);
	const bodyCurrent = byArm.get("body-current");
	const bodyRemat = byArm.get("body-rematerialize");
	const bodySemantic = byArm.get("body-semantic-reset");
	const serverCurrent = byArm.get("server-current");
	const serverCompaction = byArm.get("server-semantic-compaction");
	const serverCompactionSoak = byArm.get("server-semantic-compaction-soak");
	const serverLean = byArm.get("server-validated-once");
	const serverPersistentExact = byArm.get("server-persistent-exact");
	const serverPersistentPeriodic = byArm.get("server-persistent-periodic");
	const socketCurrent = byArm.get("socket-admission-current");
	const socketMirror = byArm.get("socket-validation-mirror");
	const socketProductionMirror = byArm.get("socket-production-mirror");
	const socketFloor = byArm.get("socket-apply-floor");
	const rootCurrent = byArm.get("root-current");
	const rootSemantic = byArm.get("root-semantic-reset");
	const rootProductionSemantic = byArm.get("root-production-semantic-reset");
	const checkpointCurrent = byArm.get("checkpoint-current");
	const checkpointLive = byArm.get("checkpoint-live");
	const reconstructCurrent = byArm.get("reconstruct-current");
	const reconstructSelfContained = byArm.get("reconstruct-self-contained");
	const rows = measurements.map((measurement) => {
		const settledDelta = Math.max(0, measurement.settled.rssBytes - measurement.baseline.rssBytes);
		const scope = measurement.counters.truncated === true
			? ` (${String(measurement.counters.frames)}/${String(measurement.counters.traceFrames)} frames)`
			: "";
		return `| ${measurement.arm}${scope} | ${measurement.elapsedMs.toFixed(1)} | ${mib(measurement.peakAdditionalRssBytes)} | ${mib(settledDelta)} | ${measurement.encodedStateBytes === null ? "—" : mib(measurement.encodedStateBytes)} | ${measurement.census?.structs.toLocaleString() ?? "—"} | ${measurement.census?.deletedStructs.toLocaleString() ?? "—"} |`;
	});
	const comparison = (label: string, before: number | null, after: number | null): string => {
		const reduction = percentReduction(before, after);
		return reduction === null ? `- ${label}: not measured.` : `- ${label}: ${reduction.toFixed(1)}% reduction.`;
	};
	const cpuPerFrame = (measurement: LabMeasurement | undefined): number | null => {
		const frames = Number(measurement?.counters.frames);
		return measurement && Number.isSafeInteger(frames) && frames > 0
			? (measurement.cpuUserMicros + measurement.cpuSystemMicros) / frames
			: null;
	};
	const epoch = byArm.get("epoch-current-risk");
	const pin = byArm.get("pin-retention");
	const periodicLedgerUnderestimate = serverPersistentPeriodic?.counters.ledgerUnderestimateMaximumBytes;
	const rematerializationHighWater = bodyRemat?.counters.interventionNewHighWaterBytes;
	const semanticResetHighWater = bodySemantic?.counters.interventionNewHighWaterBytes;
	const soak = serverCompactionSoak?.counters;
	const productionRoot = rootProductionSemantic?.counters;
	const bodyEpochFenceImplemented = typeof soak?.compactions === "number"
		&& soak.compactions > 0
		&& soak.staleEpochRejections === soak.compactions
		&& soak.fenceCalls === soak.compactions;
	const latencyLine = (label: string, measurement: LabMeasurement | undefined): string => measurement
		? `- ${label}: mean ${Number(measurement.counters.latencyMeanMs).toFixed(1)}ms, p95 ${Number(measurement.counters.latencyP95Ms).toFixed(1)}ms, p99 ${Number(measurement.counters.latencyP99Ms).toFixed(1)}ms, first decile ${Number(measurement.counters.latencyFirstDecileMeanMs).toFixed(1)}ms, last decile ${Number(measurement.counters.latencyLastDecileMeanMs).toFixed(1)}ms.`
		: `- ${label}: not measured.`;
	const report = `# YAOS pathology lab report

Generated ${new Date().toISOString()} from frozen trace \`${traceDirectory}\`.

## Trace

- Profile: ${manifest.profile.name}
- Source: ${manifest.source.kind}${manifest.source.path ? ` (\`${manifest.source.path}\`)` : ""}
- Base Markdown: ${manifest.base.utf8Bytes.toLocaleString()} bytes
- Frozen wire updates: ${manifest.updates.frames.toLocaleString()} frames / ${manifest.updates.bytes.toLocaleString()} payload bytes
- Frozen candidates: ${manifest.candidates.frames.toLocaleString()} frames / ${manifest.candidates.bytes.toLocaleString()} payload bytes / ${manifest.candidates.maximumFrameBytes?.toLocaleString() ?? "legacy manifest"} largest frame
- Final history: ${manifest.final.census.structs.toLocaleString()} structs, ${manifest.final.census.deletedStructs.toLocaleString()} deleted, ${manifest.final.encodedStateBytes.toLocaleString()} encoded bytes

## Measurements

Peak RSS is the operating system high-water mark from an isolated process. Settled RSS is sampled after converged forced GC. Both are net of that child process's post-import baseline.

| Arm | elapsed ms | peak +MiB | settled +MiB | encoded MiB | structs | deleted |
|---|---:|---:|---:|---:|---:|---:|
${rows.join("\n")}

## Intervention deltas

${comparison("rematerialization encoded state", bodyCurrent?.encodedStateBytes ?? null, bodyRemat?.encodedStateBytes ?? null)}
${comparison("semantic-reset encoded state", bodyCurrent?.encodedStateBytes ?? null, bodySemantic?.encodedStateBytes ?? null)}
${comparison("semantic-reset struct count", bodyCurrent?.census?.structs ?? null, bodySemantic?.census?.structs ?? null)}
${comparison("validated-once server CPU", serverCurrent ? serverCurrent.cpuUserMicros + serverCurrent.cpuSystemMicros : null, serverLean ? serverLean.cpuUserMicros + serverLean.cpuSystemMicros : null)}
${comparison("persistent exact-validation server CPU", serverCurrent ? serverCurrent.cpuUserMicros + serverCurrent.cpuSystemMicros : null, serverPersistentExact ? serverPersistentExact.cpuUserMicros + serverPersistentExact.cpuSystemMicros : null)}
${comparison("persistent periodic-validation server CPU", serverCurrent ? serverCurrent.cpuUserMicros + serverCurrent.cpuSystemMicros : null, serverPersistentPeriodic ? serverPersistentPeriodic.cpuUserMicros + serverPersistentPeriodic.cpuSystemMicros : null)}
${comparison("production semantic-compaction encoded state", serverCurrent?.encodedStateBytes ?? null, serverCompaction?.encodedStateBytes ?? null)}
${comparison("production semantic-compaction struct count", serverCurrent?.census?.structs ?? null, serverCompaction?.census?.structs ?? null)}
${comparison("socket validation-mirror CPU", socketCurrent ? socketCurrent.cpuUserMicros + socketCurrent.cpuSystemMicros : null, socketMirror ? socketMirror.cpuUserMicros + socketMirror.cpuSystemMicros : null)}
${comparison("production socket validation-mirror CPU per frame", cpuPerFrame(socketCurrent), cpuPerFrame(socketProductionMirror))}
${comparison("socket raw-apply floor CPU", socketCurrent ? socketCurrent.cpuUserMicros + socketCurrent.cpuSystemMicros : null, socketFloor ? socketFloor.cpuUserMicros + socketFloor.cpuSystemMicros : null)}
${comparison("live checkpoint peak RSS", checkpointCurrent?.peakAdditionalRssBytes ?? null, checkpointLive?.peakAdditionalRssBytes ?? null)}
${comparison("live checkpoint CPU", checkpointCurrent ? checkpointCurrent.cpuUserMicros + checkpointCurrent.cpuSystemMicros : null, checkpointLive ? checkpointLive.cpuUserMicros + checkpointLive.cpuSystemMicros : null)}
${comparison("self-contained reconstruction peak RSS", reconstructCurrent?.peakAdditionalRssBytes ?? null, reconstructSelfContained?.peakAdditionalRssBytes ?? null)}
${comparison("root semantic-reset encoded state", rootCurrent?.encodedStateBytes ?? null, rootSemantic?.encodedStateBytes ?? null)}
${comparison("root semantic-reset struct count", rootCurrent?.census?.structs ?? null, rootSemantic?.census?.structs ?? null)}
${comparison("production root semantic-reset struct count", rootCurrent?.census?.structs ?? null, rootProductionSemantic?.census?.structs ?? null)}

## Latency slope

${latencyLine("production candidate path", serverCurrent)}
${latencyLine("persistent periodic candidate control", serverPersistentPeriodic)}
${latencyLine("clone-per-frame socket control", socketCurrent)}
${latencyLine("persistent socket validation mirror", socketMirror)}
${latencyLine("production socket validation mirror", socketProductionMirror)}

## Repeated semantic-compaction soak

- Content and durable recovery equivalent: ${String(soak?.contentEquivalent ?? "not measured")} / ${String(soak?.durableRecoveryEquivalent ?? "not measured")}.
- Repeated resets: ${String(soak?.compactions ?? "not measured")}; stale old-epoch candidates rejected: ${String(soak?.staleEpochRejections ?? "not measured")}; socket fences invoked: ${String(soak?.fenceCalls ?? "not measured")}.
- Fresh client sets generated: ${String(soak?.regeneratedClientSets ?? "not measured")} (old Yjs identities are discarded after every reset).
- Maximum structs at reset boundaries: ${String(soak?.maximumStructs ?? "not measured")} / ceiling ${String(soak?.maximumStructsCeiling ?? "not measured")}.
- Maximum encoded state at reset boundaries: ${typeof soak?.maximumEncodedBytes === "number" ? `${mib(soak.maximumEncodedBytes)} MiB` : "not measured"} / ceiling ${typeof soak?.maximumEncodedBytesCeiling === "number" ? `${mib(soak.maximumEncodedBytesCeiling)} MiB` : "not measured"}.
- Maximum post-reset structs: ${String(soak?.maximumPostResetStructs ?? "not measured")} / ceiling ${String(soak?.maximumPostResetStructsCeiling ?? "not measured")}.
- Maximum post-reset encoded state: ${typeof soak?.maximumPostResetEncodedBytes === "number" ? `${mib(soak.maximumPostResetEncodedBytes)} MiB` : "not measured"} / ceiling ${typeof soak?.maximumPostResetEncodedBytesCeiling === "number" ? `${mib(soak.maximumPostResetEncodedBytesCeiling)} MiB` : "not measured"}.
- Elapsed time: ${serverCompactionSoak ? `${serverCompactionSoak.elapsedMs.toFixed(1)} ms` : "not measured"} / ceiling ${typeof soak?.elapsedMsCeiling === "number" ? `${soak.elapsedMsCeiling.toLocaleString()} ms` : "not measured"} (passed: ${String(soak?.elapsedCeilingPassed ?? "not measured")}).
- Durable reconstruction time: ${typeof soak?.reconstructionMs === "number" ? `${Number(soak.reconstructionMs).toFixed(1)} ms` : "not measured"} / ceiling ${typeof soak?.reconstructionMsCeiling === "number" ? `${Number(soak.reconstructionMsCeiling).toLocaleString()} ms` : "not measured"} (passed: ${String(soak?.reconstructionCeilingPassed ?? "not measured")}).
- Peak additional process RSS: ${serverCompactionSoak ? `${mib(serverCompactionSoak.peakAdditionalRssBytes)} MiB` : "not measured"} / ceiling ${typeof soak?.peakAdditionalRssBytesCeiling === "number" ? `${mib(soak.peakAdditionalRssBytesCeiling)} MiB` : "not measured"} (passed: ${String(soak?.peakAdditionalRssCeilingPassed ?? "not measured")}).
- All soak regression ceilings passed: ${String(soak?.allRegressionCeilingsPassed ?? "not measured")}.

## Full production socket replay

- Frames replayed: ${String(socketProductionMirror?.counters.frames ?? "not measured")} / ${String(socketProductionMirror?.counters.traceFrames ?? "not measured")} (complete: ${String(socketProductionMirror?.counters.completeTracePassed ?? "not measured")}).
- Elapsed time: ${socketProductionMirror ? `${socketProductionMirror.elapsedMs.toFixed(1)} ms` : "not measured"} / ceiling ${String(socketProductionMirror?.counters.elapsedMsCeiling ?? "not measured")} ms (passed: ${String(socketProductionMirror?.counters.elapsedCeilingPassed ?? "not measured")}).
- Peak additional process RSS: ${socketProductionMirror ? `${mib(socketProductionMirror.peakAdditionalRssBytes)} MiB` : "not measured"} / ceiling ${typeof socketProductionMirror?.counters.peakAdditionalRssBytesCeiling === "number" ? `${mib(socketProductionMirror.counters.peakAdditionalRssBytesCeiling)} MiB` : "not measured"} (passed: ${String(socketProductionMirror?.counters.peakAdditionalRssCeilingPassed ?? "not measured")}).
- All production socket regression ceilings passed: ${String(socketProductionMirror?.counters.allRegressionCeilingsPassed ?? "not measured")}.

## Production root semantic reset

- SQL authority preserved: Canvas ${String(productionRoot?.sqlCanvasPreserved ?? "not measured")}; active attachment ${String(productionRoot?.sqlAttachmentPreserved ?? "not measured")}; attachment tombstone ${String(productionRoot?.sqlTombstonePreserved ?? "not measured")}.
- Ephemeral marker maps removed: ${String(productionRoot?.markerMapsRemoved ?? "not measured")}; lifecycle proofs migrated/rebased: ${String(productionRoot?.proofsMigrated ?? "not measured")}.
- Durable reconstruction equivalent to the resident reset state: ${String(productionRoot?.durableRootEquivalent ?? "not measured")}.
- Post-reset structs: ${String(rootProductionSemantic?.census?.structs ?? "not measured")} / ceiling ${String(productionRoot?.structCeiling ?? "not measured")} (passed: ${String(productionRoot?.structCeilingPassed ?? "not measured")}).
- Elapsed time: ${rootProductionSemantic ? `${rootProductionSemantic.elapsedMs.toFixed(1)} ms` : "not measured"} / ceiling ${String(productionRoot?.elapsedMsCeiling ?? "not measured")} ms (passed: ${String(productionRoot?.elapsedCeilingPassed ?? "not measured")}).
- All production root regression ceilings passed: ${String(productionRoot?.allRegressionCeilingsPassed ?? "not measured")}.
- Additional process RSS was ${rootProductionSemantic ? `${mib(rootProductionSemantic.peakAdditionalRssBytes)} MiB` : "not measured"}. This is informational only: an OS high-water mark established during fixture construction can legitimately yield a zero incremental value, so the root arm does not invent an RSS pass/fail ceiling.

The soak RSS value is the high-water mark of one Node process containing the
server live document and validation mirror, Node SQLite, the test harness, and
simulated client documents. The child used a ${String(soak?.processOldSpaceMiB ?? "not recorded")} MiB V8 old-space cap,
which does not cap total process RSS. These empirical ceilings catch lab
regressions; passing the process-RSS ceiling does not claim that a deployed
Cloudflare Worker stays within a 128 MiB isolate limit. That requires separate
deployed Worker measurements of server-only isolate memory.

## Safety evidence

- Current epoch-risk reproduction crossed stale history into the fresh document: ${String(epoch?.counters.staleHistoryCrossedEpoch ?? "not measured")}.
- Production body-epoch fence demonstrated: ${serverCompactionSoak ? String(bodyEpochFenceImplemented) : "not measured"}.
- Rematerialization intervention added a new RSS high-water increment of ${typeof rematerializationHighWater === "number" ? `${mib(rematerializationHighWater)} MiB` : "not measured"}; semantic reset added ${typeof semanticResetHighWater === "number" ? `${mib(semanticResetHighWater)} MiB` : "not measured"}.
- Periodic input-byte ledger maximum exact-size underestimation: ${typeof periodicLedgerUnderestimate === "number" ? `${periodicLedgerUnderestimate.toLocaleString()} bytes` : "not measured"}. A non-zero value means it is not a safe admission bound.
- Checkpoint bytes retained solely while pins were live: ${typeof pin?.counters.pinRetainedBytes === "number" ? `${mib(pin.counters.pinRetainedBytes)} MiB` : "not measured"}.

Raw measurements are in \`results.json\`; the frozen trace manifest contains SHA-256 digests for every artifact.
`;
	writeFileSync(path, report, { mode: 0o600 });
}

function runChild(arm: string, traceDirectory: string, maxOldSpaceMiB: number): LabMeasurement {
	const needsFixture = ["checkpoint-current", "checkpoint-live", "reconstruct-current"].includes(arm);
	const fixtureDirectory = needsFixture ? mkdtempSync(join(tmpdir(), "yaos-pathology-prepared-")) : null;
	const fixturePath = fixtureDirectory ? join(fixtureDirectory, "vault.sqlite") : undefined;
	try {
		if (fixturePath) {
			const prepare = spawnSync(process.execPath, [
				TYPESCRIPT_RUNNER,
				"--test-aliases",
				PREPARE,
				JSON.stringify({ traceDirectory, databasePath: fixturePath, checkpoint: arm === "reconstruct-current" }),
			], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 });
			if (prepare.status !== 0) throw new Error(`${arm} fixture preparation failed: ${(prepare.stderr || prepare.stdout).slice(-4_000)}`);
		}
		const spec = JSON.stringify({ arm, traceDirectory, fixturePath, maxOldSpaceMiB });
		const child = spawnSync(
			process.execPath,
			[
				"--expose-gc",
				`--max-old-space-size=${maxOldSpaceMiB}`,
				TYPESCRIPT_RUNNER,
				"--test-aliases",
				CHILD,
				spec,
			],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				timeout: 30 * 60_000,
			},
		);
		if (child.status !== 0) {
			throw new Error(`${arm} failed (${child.status ?? "signal/timeout"}):\n${(child.stderr || child.stdout).slice(-4_000)}`);
		}
		const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
		if (!line) throw new Error(`${arm} returned no measurement`);
		const measurement = normalizeMeasurement(JSON.parse(line) as LabMeasurement);
		if (measurement.format !== "yaos-pathology-measurement-v1" || measurement.arm !== arm) {
			throw new Error(`${arm} returned a malformed measurement`);
		}
		return measurement;
	} finally {
		if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2));
	mkdirSync(args.outputDirectory, { recursive: true, mode: 0o700 });
	const traceDirectory = args.traceDirectory ? resolve(args.traceDirectory) : join(args.outputDirectory, "trace");
	let manifest;
	if (args.traceDirectory) {
		manifest = validateFrozenTrace(traceDirectory);
	} else {
		console.log(`Generating ${args.profile} frozen trace in ${traceDirectory}`);
		manifest = generateFrozenTrace({
			outputDirectory: traceDirectory,
			profile: PATHOLOGY_PROFILES[args.profile]!,
			seed: args.seed,
			corpusRoots: args.corpusRoots,
		});
		validateFrozenTrace(traceDirectory);
	}
	console.log(`Trace: ${manifest.updates.frames.toLocaleString()} wire updates, ${manifest.candidates.frames.toLocaleString()} candidates, ${manifest.final.census.structs.toLocaleString()} structs`);
	if (args.generateOnly) return;

	const imported = args.resultRoots.flatMap(importMeasurements);
	const measurementsByArm = new Map(imported.map((measurement) => [measurement.arm, measurement]));
	if (args.reportOnly && measurementsByArm.size === 0) {
		throw new Error("--report-only found no individual or aggregate measurements in --result-roots");
	}
	for (const arm of args.reportOnly ? [] : args.arms) {
		console.log(`Running ${arm}...`);
		const measurement = runChild(arm, traceDirectory, args.maxOldSpaceMiB);
		measurementsByArm.set(arm, measurement);
		atomicJson(join(args.outputDirectory, `result-${arm}.json`), measurement);
		console.log(`  ${measurement.elapsedMs.toFixed(1)} ms, peak +${mib(measurement.peakAdditionalRssBytes)} MiB, ${measurement.census?.structs.toLocaleString() ?? "—"} structs`);
	}
	const measurements = [...measurementsByArm.values()].sort((left, right) => {
		const leftIndex = DEFAULT_ARMS.indexOf(left.arm as typeof DEFAULT_ARMS[number]);
		const rightIndex = DEFAULT_ARMS.indexOf(right.arm as typeof DEFAULT_ARMS[number]);
		return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
	});
	atomicJson(join(args.outputDirectory, "results.json"), {
		format: "yaos-pathology-results-v1",
		generatedAt: new Date().toISOString(),
		traceDirectory,
		manifest,
		measurements,
	});
	writeMarkdownReport(join(args.outputDirectory, "report.md"), traceDirectory, measurements);
	console.log(`Report: ${join(args.outputDirectory, "report.md")}`);
}

await main();
