/**
 * QA harness API implementation.
 * Registered as window.__YAOS_QA__ by the harness plugin.
 */

import type { App } from "obsidian";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";
import type {
	QaConsoleApi,
	QaContext,
	QaResult,
	QaRunOptions,
	QaScenario,
	VaultManifest,
	ManifestDiff,
} from "./types";
import { analyzeTrace } from "../analyzers/analyzer";
import { sleep, waitForIdle, waitForMemoryReceipt, waitForFile, waitForCrdtFile, waitForDiskCrdtConverge, waitForActiveMarkdownLeaf, waitForCrdtBinding } from "./wait";
import {
	createFile,
	modifyFile,
	appendToFile,
	deleteFile,
	renameFile,
	writeAdapterFile,
	deleteAdapterFile,
} from "./vault-ops";
import {
	openFile,
	closeFile,
	typeIntoFile,
	replaceFileContent,
	runCommand,
} from "./editor-ops";
import {
	assertFileExists,
	assertFileNotExists,
	assertFileContent,
	assertFileHash,
	assertDiskEqualsCrdt,
	assertNoConflictCopies,
} from "./assertions";
import { buildVaultManifest, diffManifests } from "./manifest-builder";

const DEFAULT_IDLE_TIMEOUT = 15_000;
const DEFAULT_RECEIPT_TIMEOUT = 30_000;
const DEFAULT_FILE_TIMEOUT = 15_000;

function getYaos(): YaosQaDebugApi {
	const api = (window as unknown as Record<string, unknown>).__YAOS_DEBUG__ as YaosQaDebugApi | undefined;
	if (!api) throw new Error("window.__YAOS_DEBUG__ not found — is YAOS loaded with qaDebugMode enabled?");
	return api;
}

function buildContext(app: App): QaContext {
	const yaos = getYaos();
	return {
		app,
		yaos,

		phase: (name) => yaos.__qaOnlyEmitPhaseUnsafe(name),

		createFile: (path, content) => createFile(app, path, content),
		modifyFile: (path, content) => modifyFile(app, path, content),
		appendToFile: (path, text) => appendToFile(app, path, text),
		deleteFile: (path, mode) => deleteFile(app, path, mode),
		renameFile: (old, next) => renameFile(app, old, next),

		writeAdapterFile: (path, content) => writeAdapterFile(app, path, content),
		deleteAdapterFile: (path) => deleteAdapterFile(app, path),

		openFile: (path) => openFile(app, path),
		closeFile: (path) => closeFile(app, path),
		typeIntoFile: (path, text) => typeIntoFile(app, path, text),
		replaceFileContent: (path, content) => replaceFileContent(app, path, content),
		runCommand: (id) => runCommand(app, id),

		waitForIdle: (ms) => waitForIdle(yaos, ms ?? DEFAULT_IDLE_TIMEOUT),
		waitForMemoryReceipt: (ms) => waitForMemoryReceipt(yaos, ms ?? DEFAULT_RECEIPT_TIMEOUT),
		waitForFile: (path, ms) => waitForFile(yaos, path, ms ?? DEFAULT_FILE_TIMEOUT),
		waitForCrdtFile: (path, ms) => waitForCrdtFile(yaos, path, ms),
		waitForDiskCrdtConverge: (path, ms) => waitForDiskCrdtConverge(yaos, path, ms),
		waitForActiveMarkdownLeaf: (path, ms) => waitForActiveMarkdownLeaf(app, yaos, path, ms),
		waitForCrdtBinding: (path, ms) => waitForCrdtBinding(yaos, path, ms),
		sleep,

		assert: {
			fileExists: (path) => assertFileExists(app, path),
			fileNotExists: (path) => assertFileNotExists(app, path),
			fileContent: (path, content) => assertFileContent(app, path, content),
			fileHash: (path, hash) => assertFileHash(app, yaos, path, hash),
			diskEqualsCrdt: (path) => assertDiskEqualsCrdt(yaos, path),
			noConflictCopies: (dir) => assertNoConflictCopies(app, dir),
		},
	};
}

export function buildQaConsoleApi(app: App, scenarioRegistry: Map<string, QaScenario>): QaConsoleApi {

	const api: QaConsoleApi = {
		help(): void {
			const methods = [
				"help()                               — show this message",
				"scenarios()                          — list registered scenario IDs",
				"run(id, opts?)                       — run a scenario (returns QaResult with scenarioPassed+analyzerPassed)",
				"createFile(path, content)            — create/overwrite via Obsidian API",
				"modifyFile(path, content)            — modify via Obsidian API",
				"appendToFile(path, text)             — append via Obsidian API",
				"deleteFile(path)                     — delete via Obsidian API",
				"renameFile(old, new)                 — rename via Obsidian API",
				"writeAdapterFile(path, content)      — write via Obsidian adapter (NOT real external)",
				"deleteAdapterFile(path)              — delete via Obsidian adapter",
				"openFile(path)                       — open in MarkdownView",
				"closeFile(path)                      — close leaf",
				"typeIntoFile(path, text)             — type character-by-character into editor",
				"replaceFileContent(path, content)    — editor.setValue() (blunt — setup only)",
				"runCommand(commandId)                — execute Obsidian command",
				"waitForIdle(ms?)                     — wait for YAOS idle state",
				"yaos.getReceiptSnapshot()            — snapshot receipt state before an action",
				"yaos.waitForReceiptAfter(ts, ms)     — action-relative receipt wait (preferred)",
				"yaos.disconnectProvider(reason?)     — real offline disconnect",
				"yaos.connectProvider(reason?)        — reconnect provider",
				"yaos.waitForProviderDisconnected(ms) — wait for confirmed disconnect",
				"waitForMemoryReceipt(ms?)            — [deprecated] global receipt wait",
				"waitForFile(path, ms?)               — wait for file to appear on disk",
				"waitForCrdtBinding(path, ms?)         — wait for healthy CRDT editor binding",
				"assertFileExists(path)               — throws if not found",
				"assertFileNotExists(path)            — throws if found",
				"assertFileHash(path, hash)           — throws if disk hash mismatches",
				"assertDiskEqualsCrdt(path)           — throws if disk ≠ CRDT",
				"assertNoConflictCopies(dir?)         — throws if conflict copies found",
				"manifest()                           — snapshot current vault",
				"compareManifest(expected)            — diff two manifests",
				"startTrace(recordingMode?, secret?)  — start QA flight trace",
				"stopTrace()                          — stop flight trace",
				"exportTrace(exportPrivacy?)          — export flight trace (returns path)",
				"analyzeTrace(tracePath, scenarioId?) — run analyzer on a trace file",
				"exportTraceWithAnalyzer(privacy?)    — export + analyze in one call",
				"plugins()                            — list installed plugins",
			];
			console.log("[YAOS QA]\n" + methods.join("\n"));
		},

		scenarios(): string[] {
			return [...scenarioRegistry.keys()];
		},

		async run(id, opts?: QaRunOptions): Promise<QaResult> {
			const scenario = scenarioRegistry.get(id);
			if (!scenario) {
				return {
					id,
					passed: false,
					scenarioPassed: false,
					analyzerPassed: false,
					durationMs: 0,
					errors: [`Unknown scenario: ${id}`],
					warnings: [],
					tracePath: null,
					analyzerReport: null,
				};
			}

			const ctx = buildContext(app);
			const errors: string[] = [];
			const warnings: string[] = [];
			const start = Date.now();

			// Recording mode and export privacy are separate concepts.
			const recordingMode = scenario.traceRecordingMode ?? "qa-safe";
			const exportPrivacy: "safe" | "full" = scenario.traceExportPrivacy ?? "safe";

			let tracePath: string | null = null;
			let analyzerReport: unknown = null;
			let analyzerPassed = true; // assume pass unless analyzer explicitly fails

			// Phase: start trace BEFORE setup so all events are captured.
			// Stop any previously running trace first to prevent event bleed.
			try {
				await api.stopTrace();
			} catch {
				// ignore — no trace was running
			}
			try {
				await api.startTrace(recordingMode);
			} catch (traceStartErr) {
				warnings.push(`trace start failed: ${String(traceStartErr)}`);
			}

			// Phase: setup
			await ctx.phase("setup");
			try {
				await scenario.setup(ctx);
			} catch (setupErr) {
				errors.push(`setup: ${setupErr instanceof Error ? setupErr.message : String(setupErr)}`);
			}

			// Phase: run + assert (only if setup succeeded)
			if (errors.length === 0) {
				await ctx.phase("run");
				try {
					await scenario.run(ctx);
				} catch (runErr) {
					errors.push(runErr instanceof Error ? runErr.message : String(runErr));
				}

				await ctx.phase("assert");
				try {
					await scenario.assert(ctx);
				} catch (assertErr) {
					errors.push(assertErr instanceof Error ? assertErr.message : String(assertErr));
				}
			}

			const scenarioPassed = errors.length === 0;

			// Phase: cleanup marker — emitted BEFORE trace export so analyzers
			// can see the phase boundary and know that events after this point
			// are intentional teardown (expected tombstones, deletes, etc.).
			// The actual cleanup() call runs AFTER export so teardown events
			// themselves are not included in the scenario trace.
			await ctx.phase("cleanup");

			// Phase: export trace + analyze.
			try {
			const bundle = await api.exportTraceWithAnalyzer(exportPrivacy, scenario.id);
				tracePath = bundle.tracePath;
				analyzerReport = bundle.report;
				const reportPassed = (analyzerReport as { passed?: boolean } | null)?.passed;
				analyzerPassed = reportPassed !== false; // null/undefined = no finding = pass
				console.log(`[YAOS QA] Trace exported: ${tracePath}`);
				console.log("[YAOS QA] Analyzer report:", analyzerReport);
				if (!analyzerPassed) {
					warnings.push("analyzer found hard failures in trace");
				}
			} catch (traceErr) {
				warnings.push(`trace export/analyzer failed: ${String(traceErr)}`);
			}

			// Run actual cleanup — outside trace window (after export).
			try {
				await scenario.cleanup?.(ctx);
			} catch (cleanErr) {
				warnings.push(`cleanup: ${String(cleanErr)}`);
			}

			// passed = BOTH scenario assertions AND analyzer must pass.
			const passed = scenarioPassed && analyzerPassed;
			const durationMs = Date.now() - start;

			const result: QaResult = {
				id,
				passed,
				scenarioPassed,
				analyzerPassed,
				durationMs,
				errors,
				warnings,
				tracePath,
				analyzerReport,
			};

			const icon = passed ? "✓" : "✗";
			const failParts: string[] = [];
			if (!scenarioPassed) failParts.push(`scenario(${errors.length} errors)`);
			if (!analyzerPassed) failParts.push("analyzer");
			const suffix = passed ? "" : ` [${failParts.join(", ")}]`;
			console.log(
				`[YAOS QA] ${icon} ${id} (${durationMs}ms)${suffix}` +
				(errors.length ? "\n  " + errors.join("\n  ") : ""),
			);
			return result;
		},

		// Vault ops
		createFile: (path, content) => createFile(app, path, content),
		modifyFile: (path, content) => modifyFile(app, path, content),
		appendToFile: (path, text) => appendToFile(app, path, text),
		deleteFile: (path, mode) => deleteFile(app, path, mode),
		renameFile: (old, next) => renameFile(app, old, next),
		writeAdapterFile: (path, content) => writeAdapterFile(app, path, content),
		deleteAdapterFile: (path) => deleteAdapterFile(app, path),

		// Editor ops
		openFile: (path) => openFile(app, path),
		closeFile: (path) => closeFile(app, path),
		typeIntoFile: (path, text, opts) => typeIntoFile(app, path, text, opts),
		replaceFileContent: (path, content) => replaceFileContent(app, path, content),
		runCommand: (id) => runCommand(app, id),

		// Wait
		waitForIdle: (ms) => waitForIdle(getYaos(), ms ?? DEFAULT_IDLE_TIMEOUT),
		waitForMemoryReceipt: (ms) => waitForMemoryReceipt(getYaos(), ms ?? DEFAULT_RECEIPT_TIMEOUT),
		waitForFile: (path, ms) => waitForFile(getYaos(), path, ms ?? DEFAULT_FILE_TIMEOUT),
		waitForCrdtFile: (path, ms) => waitForCrdtFile(getYaos(), path, ms),
		waitForDiskCrdtConverge: (path, ms) => waitForDiskCrdtConverge(getYaos(), path, ms),
		waitForActiveMarkdownLeaf: (path, ms) => waitForActiveMarkdownLeaf(app, getYaos(), path, ms),
		waitForCrdtBinding: (path, ms) => waitForCrdtBinding(getYaos(), path, ms),

		// Assertions
		assertFileExists: (path) => assertFileExists(app, path),
		assertFileNotExists: (path) => assertFileNotExists(app, path),
		assertFileHash: (path, hash) => assertFileHash(app, getYaos(), path, hash),
		assertDiskEqualsCrdt: (path) => assertDiskEqualsCrdt(getYaos(), path),
		assertNoConflictCopies: (dir) => assertNoConflictCopies(app, dir),

		// Manifests
		manifest: () => buildVaultManifest(app),
		async compareManifest(expected: VaultManifest): Promise<ManifestDiff> {
			const current = await buildVaultManifest(app);
			return diffManifests(expected, current);
		},

		// Flight trace
		async startTrace(recordingMode = "qa-safe", secret?: string): Promise<void> {
			await getYaos().startFlightTrace(recordingMode, secret);
		},
		async stopTrace(): Promise<void> {
			await getYaos().stopFlightTrace();
		},
		async exportTrace(exportPrivacy: "safe" | "full" = "safe"): Promise<string> {
			return getYaos().exportFlightTrace(exportPrivacy);
		},

		async analyzeTrace(tracePath: string, scenarioId?: string): Promise<unknown> {
			const raw = await app.vault.adapter.read(tracePath);
			return analyzeTrace(raw, { traceFile: tracePath, scenarioId });
		},

		async exportTraceWithAnalyzer(
			exportPrivacy: "safe" | "full" = "safe",
			scenarioId?: string,
		): Promise<{ tracePath: string; report: unknown }> {
			const tracePath = await getYaos().exportFlightTrace(exportPrivacy);
			const report = await api.analyzeTrace(tracePath, scenarioId);
			return { tracePath, report };
		},

		// Plugin state
		plugins() {
			const installedPlugins = (app as unknown as {
				plugins: { plugins: Record<string, { manifest: { version: string } }> };
			}).plugins.plugins;
			return Object.entries(installedPlugins).map(([id, p]) => ({
				id,
				version: p.manifest.version,
				enabled: true,
			}));
		},
	};

	return api;
}
