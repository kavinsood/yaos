/**
 * K2 (§7.5): client semantic-reset build cost on desktop (measured) and a
 * mobile-class device (inferred, two ways).
 *
 * Mobile-class method (DECISIONS.md: worker thread + duty-cycle throttling,
 * plus desktop × 4–6, all labelled inferred):
 *   - every sample is a fresh child process `node --expose-gc k2-worker.mjs`
 *     whose builder runs in a worker_thread (cold JIT, as a once-a-day reset is);
 *   - throttled modes duty-cycle the whole child with SIGSTOP/SIGCONT from a
 *     governor thread (k2-governor.mjs; cpulimit's mechanism), 20 ms period:
 *       duty25 → 5 ms run / 15 ms stopped  (≈4× slowdown)
 *       duty17 → 3.4 ms run / 16.6 ms stopped (≈6× slowdown);
 *   - each sample also times a fixed SHA-256 calibration workload so the
 *     *effective* slowdown actually achieved is reported next to the target;
 *   - desktop p50 × 4 and × 6 are reported as the second inferred estimate.
 *   Caveats (in K2.md): duty-cycling a fast core models lower throughput, not
 *   smaller caches / memory bandwidth / JavaScriptCore (iOS WKWebView) vs V8,
 *   thermal throttling, or jetsam memory limits — hence "inferred".
 *
 * Also: server-equivalence per fixture (builder vs server prepareSemanticReset
 * on the real ywasm engine) and peak worker heap.
 *
 * Usage: node tests/run-typescript.mjs --test-aliases scripts/relay2/reset/k2.ts
 *          [--n 10] [--modes desktop,duty25,duty17] [--fixtures a,b] [--out file.json]
 */
import { execFileSync, spawn } from "node:child_process";
import { cpus, loadavg, totalmem } from "node:os";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Worker } from "node:worker_threads";
import * as Y from "yjs";
import { ywasmCrdtEngine as crdtEngine } from "@yaos/crdt-engine";
import { prepareSemanticReset } from "../../../server/src/semanticCompaction";
import { canonicalMarkdownHash } from "../../../server/src/shared/markdownCodec";
import { buildFreshSnapshot } from "./builder";
import { ALL_FIXTURES, FIXTURE_DIR, loadFixture } from "./fixtures";
import type { K2SampleResult } from "./k2-task";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKTREE = fileURLToPath(new URL("../../..", import.meta.url));
const RESULTS = "/Users/kavin/personal/obsidiansync/experiments/results/relay2";
const BASE_SHA = "5dd32f31d3c380605db44558d089d37adaa293d5";
const CALIBRATION_ITERATIONS = 2_000;
const PERIOD_MS = 20;

const MODES: Record<string, { duty: number | null; label: string }> = {
	desktop: { duty: null, label: "desktop (measured)" },
	duty25: { duty: 0.25, label: "mobile-class: 25% duty SIGSTOP/SIGCONT (inferred, ≈4×)" },
	duty17: { duty: 1 / 6, label: "mobile-class: 16.7% duty SIGSTOP/SIGCONT (inferred, ≈6×)" },
};

interface Governor { cycles: number; runningMs: number; stoppedMs: number; elapsedMs: number; achievedDuty: number }
interface Sample extends K2SampleResult {
	index: number; wallMs: number; loadavg1: number; governor: Governor | null;
	heapSamples: number; peakWorkerHeapUsedBytes: number; peakWorkerHeapPlusExternalBytes: number;
}

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1]! : fallback;
}

function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
	return {
		n: sorted.length, min: sorted[0]!, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted[sorted.length - 1]!,
		mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
	};
}

async function runChild(fixture: string, duty: number | null): Promise<Omit<Sample, "index">> {
	const input = JSON.stringify({
		fixturePath: join(FIXTURE_DIR, `${fixture}.update`), guid: `k2-${fixture}`,
		calibrationIterations: CALIBRATION_ITERATIONS,
	});
	const started = performance.now();
	const load = loadavg()[0]!;
	const child = spawn(process.execPath, ["--expose-gc", "--no-warnings", join(HERE, "k2-worker.mjs"), input], {
		cwd: WORKTREE, stdio: ["ignore", "pipe", "pipe"],
	});
	let governor: Worker | null = null;
	let governorResult: Promise<Governor> | null = null;
	const flag = new SharedArrayBuffer(4);
	if (duty !== null) {
		governor = new Worker(join(HERE, "k2-governor.mjs"), { workerData: { pid: child.pid, duty, periodMs: PERIOD_MS, flag } });
		governorResult = new Promise((resolve) => governor!.once("message", resolve));
	}
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	const code: number = await new Promise((resolve) => child.on("exit", (exitCode) => resolve(exitCode ?? -1)));
	Atomics.store(new Int32Array(flag), 0, 1);
	const governorStats = governorResult ? await governorResult : null;
	await governor?.terminate();
	const line = stdout.split("\n").find((candidate) => candidate.startsWith("K2RESULT "));
	if (code !== 0 || !line) throw new Error(`k2 child failed (${code}): ${stderr.slice(-2000)}`);
	const result = JSON.parse(line.slice("K2RESULT ".length)) as Omit<Sample, "index" | "wallMs" | "loadavg1" | "governor">;
	return { ...result, wallMs: performance.now() - started, loadavg1: load, governor: governorStats };
}

/** Builder vs the server's own prepareSemanticReset on the real (Node) ywasm engine. */
async function equivalence(fixture: string) {
	const { state } = loadFixture(fixture);
	const clientDoc = new Y.Doc({ guid: `k2-${fixture}` });
	Y.applyUpdate(clientDoc, state);
	const client = await buildFreshSnapshot(clientDoc);
	let server: ReturnType<typeof prepareSemanticReset> | null = null;
	const serverDoc = crdtEngine.openDocument(`k2-${fixture}`, state);
	try {
		const started = performance.now();
		server = prepareSemanticReset(serverDoc, "body");
		const serverMs = performance.now() - started;
		const serverText = crdtEngine.readText(server.document, "body");
		const reopened = crdtEngine.openDocument(`k2-${fixture}`, client.snapshot);
		// Deep equality: ywasm returns plain-object map values with a different key order.
		const sameRoots = isDeepStrictEqual(crdtEngine.snapshotRoots(reopened), crdtEngine.snapshotRoots(server.document));
		crdtEngine.destroyDocument(reopened);
		return {
			sameText: serverText === client.content,
			sameHash: (await canonicalMarkdownHash(serverText)) === client.contentHash,
			sameRootSnapshot: sameRoots,
			sameBeforeCensus: server.previous.totalStructs === client.before.totalStructs
				&& server.previous.deletedStructs === client.before.deletedStructs
				&& server.previous.encodedStateBytes === client.before.encodedStateBytes,
			sameFreshCensus: server.fresh.totalStructs === client.after.totalStructs
				&& server.fresh.deletedStructs === client.after.deletedStructs,
			freshBytesClient: client.after.encodedStateBytes,
			freshBytesServer: server.fresh.encodedStateBytes,
			freshBytesDeltaNote: "ywasm client ids are 53-bit, yjs 32-bit: varint length differs by ≤ a few bytes per client",
			serverYwasmPrepareMs: serverMs,
			clientJsBuildMs: client.timings.totalMs,
		};
	} finally {
		if (server) crdtEngine.destroyDocument(server.document);
		crdtEngine.destroyDocument(serverDoc);
		clientDoc.destroy();
	}
}

async function main(): Promise<void> {
	const n = Number(arg("n", "10"));
	const modes = arg("modes", "desktop,duty25,duty17").split(",");
	const fixtures = arg("fixtures", ALL_FIXTURES.join(",")).split(",");
	const startedAt = new Date().toISOString();
	const stamp = startedAt.replace(/[:.]/g, "-");
	const out = arg("out", join(RESULTS, `K2-local-${stamp}.json`));
	const spikeSha = execFileSync("git", ["-C", WORKTREE, "rev-parse", "HEAD"]).toString().trim();
	const report: Record<string, unknown> = {
		scenario: "K2-local", host: "local", startedAt, baseSha: BASE_SHA, spikeSha,
		machine: { cpu: cpus()[0]?.model, cores: cpus().length, memBytes: totalmem(), node: process.version },
		method: {
			sample: "fresh child process per sample; builder in a worker_thread; wall-clock performance.now()",
			throttle: `SIGSTOP/SIGCONT duty cycle of the child process, period ${PERIOD_MS} ms (cpulimit mechanism)`,
			calibration: `${CALIBRATION_ITERATIONS}× SHA-256 over 64 KiB, per sample; effective slowdown = calibration / desktop calibration p50`,
			heap: "Worker#getHeapStatistics polled every 2 ms (used_heap_size + external_memory), includes the loaded doc",
			labels: { desktop: "measured", duty25: "inferred", duty17: "inferred", desktopX4: "inferred", desktopX6: "inferred" },
		},
		n, fixtures: {},
	};
	const fixtureReports = report.fixtures as Record<string, unknown>;
	for (const fixture of fixtures) {
		const { meta } = loadFixture(fixture);
		let equivalent: unknown;
		try { equivalent = await equivalence(fixture); }
		catch (error) { equivalent = { error: String(error) }; }
		console.log(`${fixture}: equivalence ${JSON.stringify(equivalent)}`);
		const perMode: Record<string, unknown> = {};
		for (const mode of modes) {
			const config = MODES[mode];
			if (!config) throw new Error(`unknown mode ${mode}`);
			const samples: Sample[] = [];
			for (let index = 0; index < n; index++) {
				const sample = { index, ...await runChild(fixture, config.duty) };
				samples.push(sample);
				console.log(`${fixture} ${mode} #${index}: build=${sample.buildMs.toFixed(1)}ms policy=${sample.policyMs.toFixed(1)}ms calib=${sample.calibrationMs.toFixed(1)}ms load=${sample.loadMs.toFixed(0)}ms duty=${sample.governor?.achievedDuty.toFixed(3) ?? "-"} peakHeap=${(sample.peakWorkerHeapPlusExternalBytes / 1e6).toFixed(1)}MB`);
			}
			perMode[mode] = {
				label: config.label, targetDuty: config.duty,
				summary: {
					buildMs: stats(samples.map((s) => s.buildMs)),
					policyMs: stats(samples.map((s) => s.policyMs)),
					resetTotalMs: stats(samples.map((s) => s.resetTotalMs)),
					calibrationMs: stats(samples.map((s) => s.calibrationMs)),
					loadMs: stats(samples.map((s) => s.loadMs)),
					peakWorkerHeapPlusExternalBytes: stats(samples.map((s) => s.peakWorkerHeapPlusExternalBytes)),
					achievedDuty: config.duty === null ? null : stats(samples.map((s) => s.governor!.achievedDuty)),
				},
				samples,
			};
		}
		const desktop = perMode.desktop as { summary: { buildMs: ReturnType<typeof stats>; resetTotalMs: ReturnType<typeof stats>; calibrationMs: ReturnType<typeof stats> } } | undefined;
		if (desktop) {
			for (const mode of modes.filter((m) => m !== "desktop")) {
				const entry = perMode[mode] as { summary: { calibrationMs: ReturnType<typeof stats>; buildMs: ReturnType<typeof stats> } ; effectiveSlowdown?: unknown };
				entry.effectiveSlowdown = {
					calibrationP50Ratio: entry.summary.calibrationMs.p50 / desktop.summary.calibrationMs.p50,
					buildP50Ratio: entry.summary.buildMs.p50 / desktop.summary.buildMs.p50,
				};
			}
			perMode.desktopX4 = { label: "desktop × 4 (inferred)", resetTotalMsP50: desktop.summary.resetTotalMs.p50 * 4, resetTotalMsP90: desktop.summary.resetTotalMs.p90 * 4, buildMsP50: desktop.summary.buildMs.p50 * 4 };
			perMode.desktopX6 = { label: "desktop × 6 (inferred)", resetTotalMsP50: desktop.summary.resetTotalMs.p50 * 6, resetTotalMsP90: desktop.summary.resetTotalMs.p90 * 6, buildMsP50: desktop.summary.buildMs.p50 * 6 };
		}
		fixtureReports[fixture] = { meta, equivalence: equivalent, modes: perMode };
		writeFileSync(out, `${JSON.stringify({ ...report, endedAt: new Date().toISOString() }, null, 2)}\n`);
	}
	report.endedAt = new Date().toISOString();
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`wrote ${out}`);
}

await main();
