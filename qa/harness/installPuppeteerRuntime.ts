/**
 * installPuppeteerRuntime — QA / Puppeteer harness entry point.
 *
 * This file lives in qa/harness/ and is NOT compiled into main.js or
 * telemetry.js. It mounts window.__YAOS_DEBUG__, registers unsafe QA
 * commands, runs the VFS torture test, and manages scenario run/step state.
 *
 * For the production-shipped passive Observer, see:
 *   src/telemetry/installTelemetryRuntime.ts
 *
 * Mutation commands registered here (Puppeteer-only, not shipped):
 *   - qa-set-scenario-run-id
 *   - qa-advance-scenario-step
 *   - qa-export-witness-bundle-unsafe
 *   - debug-vfs-torture-test
 */

import type { App, MarkdownView, Plugin } from "obsidian";
import { Notice } from "obsidian";
import type { LabRuntimeHost } from "../../src/lab/labRuntimeHost";
import type { EngineControlPort } from "../../src/runtime/engineControlPort";
import { FlightTraceController } from "../../src/lab/debug/flightTraceController";
import { FlightTraceSink } from "../../src/lab/debug/flightTraceSink";
import { DeviceWitnessTracker } from "../../src/lab/diagnostics/deviceWitnessTracker";
import { DiagnosticsService } from "../../src/lab/diagnostics/diagnosticsService";
import { buildQaDebugApi } from "./qaDebugApi";
import { runVfsTortureTest } from "./vfsTortureTest";
import type { FlightMode, FlightPathEventInput, FlightEventInput } from "../../src/lab/debug/flightEvents";
import type { ProductFlightPathEventInput } from "../../src/observability/traceSink";
import type { TraceEventDetails } from "../../src/observability/traceContext";
import { PersistentTraceLogger } from "../../src/lab/debug/trace";

/**
 * PuppeteerRuntimeHost extends LabRuntimeHost with the Engine control port.
 *
 * This interface is local to qa/harness/ — it is never visible in src/.
 * The product plugin satisfies it only when built with __YAOS_QA_HARNESS_ENABLED__=true
 * (i.e., via `npm run build:qa-product`).  The method is dynamically attached
 * to the plugin instance in main.ts inside the QA gate block.
 *
 * Callers must cast: `installLabRuntime(plugin as unknown as PuppeteerRuntimeHost)`
 */
interface PuppeteerRuntimeHost extends LabRuntimeHost {
	getEngineControlPort(): EngineControlPort;
}
import type { TraceLoggerPort, TraceLoggerConfig } from "../../src/observability/traceLogger";
import { ScenarioStateController } from "./scenarioStateController";

/**
 * Handle returned to main.ts after lab runtime is installed.
 * All methods use primitive types only — no lab types leak through.
 */
export interface LabRuntimeHandle {
	// TraceSink adapter — product code routes events here
	readonly traceSink: import("../../src/observability/traceSink").TraceSink;

	// Called by main.ts on every path event (from reconciliation, sync)
	recordFlightPathEvent(event: ProductFlightPathEventInput | FlightPathEventInput): void;
	recordFlightEvent(event: FlightEventInput): void;

	// Witness notifications from main.ts hot path
	markWitnessDirty(path: string, origin: string): void;

	// Flight trace lifecycle
	setupFlightTrace(deps: {
		getDocSchemaVersion(): number | null;
		buildCheckpoint(): Promise<Record<string, unknown>>;
	}): void;
	refreshFlightTraceState(reason: string): Promise<void>;
	scheduleTraceStateSnapshot(reason: string): void;

	// QA trace commands
	startQaFlightTrace(mode?: string): Promise<void>;
	stopQaFlightTrace(): Promise<void>;
	exportSafeFlightTrace(): Promise<void>;
	exportFullFlightTrace(): Promise<void>;
	showTimelineForCurrentFile(): void;
	clearFlightLogs(): Promise<void>;

	// QA witness commands
	qaExportWitnessBundle(privacyMode: "safe" | "unsafe-local"): Promise<void>;
	qaShowDeviceIdentity(): void;
	qaSetScenarioRunId(): void;
	qaAdvanceScenarioStep(): void;
	qaRefreshWitnessCurrentFile(): void;

	// Witness state hash (used for recovery state correlation)
	computeWitnessStateHash(content: string): Promise<string | null>;

	// QA trace secret hash (for cross-device identity verification)
	getQaTraceSecretHash(): string | null;

	// Diagnostics — typed as unknown to avoid nominal type mismatch between
	// src/lab/diagnostics/diagnosticsService and src/diagnostics/diagnosticsService.
	// They are structurally identical; call sites cast as needed.
	readonly diagnosticsService: unknown;

	// Dev
	runVfsTortureTest(): Promise<void>;

	// QA debug API mount/unmount
	mountQaDebugApi(): void;
	unmountQaDebugApi(): void;

	// Called on plugin unload
	dispose(): void;

	/** Creates a PersistentTraceLogger bound to the lab. Used by TraceRuntimeController. */
	createTraceLogger(app: App, config: TraceLoggerConfig): TraceLoggerPort;

	/**
	 * Register all lab/QA commands with the plugin.
	 * Called once during initSync, after product commands are registered.
	 * Lab owns: flight trace commands, torture test, all qa-* witness commands.
	 */
	registerCommands(plugin: Pick<Plugin, "addCommand">): void;
}

export async function installLabRuntime(host: PuppeteerRuntimeHost): Promise<LabRuntimeHandle> {
	let flightTrace: FlightTraceController | null = null;
	let deviceWitnessTracker: DeviceWitnessTracker | null = null;
	let _qaTraceSecretHash: string | null = null;
	// Puppeteer-owned scenario state controller (injected into tracker via config)
	const scenarioController = new ScenarioStateController();

	// Witness observer refs for cleanup
	let _witnessTextObservers: Map<string, { ytext: import("yjs").Text; handler: (...args: unknown[]) => void }> | null = null;
	let _witnessIdToTextHandler: (() => void) | null = null;
	let _witnessMetaHandler: (() => void) | null = null;

	// -----------------------------------------------------------------------
	// DiagnosticsService
	// -----------------------------------------------------------------------

	const diagnosticsService = new DiagnosticsService({
		app: host.app,
		getSettings: () => host.getSettings(),
		getVaultSync: () => host.getVaultSync(),
		getDiskMirror: () => null,
		getBlobSync: () => null,
		getTraceHttpContext: () => host.getTraceHttpContext(),
		getEventRing: () => [],
		getRecentServerTrace: () => [],
		getFrontmatterQuarantineEntries: () => [],
		getState: () => ({
			reconciled: false,
			reconcileInFlight: false,
			reconcilePending: false,
			lastReconcileStats: null,
			awaitingFirstProviderSyncAfterStartup: false,
			lastReconciledGeneration: 0,
			untrackedFileCount: 0,
			openFileCount: 0,
			blockedDivergenceCount: undefined as unknown as number,
			lastBlockedDivergenceAt: undefined as unknown as number,
		}),
		isMarkdownPathSyncable: (path) => host.isMarkdownPathSyncable(path),
		collectOpenFileTraceState: () => Promise.resolve([]),
		sha256Hex: (text) => host.sha256Hex(text),
		log: (message) => host.log(message),
	});

	// -----------------------------------------------------------------------
	// TraceSink (FlightTraceSink adapter)
	// -----------------------------------------------------------------------

	const traceSink = new FlightTraceSink((event) => handle.recordFlightPathEvent(event));

	// -----------------------------------------------------------------------
	// recordFlightPathEvent — core routing logic (was private in main.ts)
	// -----------------------------------------------------------------------

	function recordFlightPathEvent(event: ProductFlightPathEventInput | FlightPathEventInput): void {
		const admissionKinds = new Set([
			"crdt.file.created",
			"crdt.file.renamed",
			"crdt.file.revived",
		]);
		const isAdmissionOrRenameTarget =
			admissionKinds.has(event.kind) ||
			(event.kind === "disk.rename.observed" &&
				(event.data as Record<string, unknown> | undefined)?.renameRole === "target");

		if (isAdmissionOrRenameTarget) {
			const excludedByPolicy = !host.isMarkdownPathSyncable(event.path);
			event = {
				...event,
				data: {
					...(event.data as Record<string, unknown> | undefined ?? {}),
					excludedByPolicy,
				},
			};
		}

		const isRecoveryDecisionMd =
			event.kind === "recovery.decision" && event.path.endsWith(".md");

		if (!isRecoveryDecisionMd) {
			void flightTrace?.recordPath(event);
		}

		if (
			(event.kind === "recovery.decision" || event.kind === "recovery.apply.done") &&
			event.path.endsWith(".md")
		) {
			deviceWitnessTracker?.markDirty(event.path, "recovery");
		}

		if (isRecoveryDecisionMd) {
			const data = event.data as Record<string, unknown> | undefined;
			const recoveryStateHash = data?.recoveryStateHash as string | undefined;
			if (flightTrace) {
				const recoverySeq = flightTrace.reserveAndRecordPath(event);
				deviceWitnessTracker?.notifyPrecursorEvent(event.path, "recovery", recoverySeq);
				deviceWitnessTracker?.handleRecoveryDecision(event.path, recoveryStateHash);
			} else {
				deviceWitnessTracker?.handleRecoveryDecision(event.path, recoveryStateHash);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Witness tracker lifecycle
	// -----------------------------------------------------------------------

	function _startDeviceWitnessTracker(mode: FlightMode): void {
		_stopDeviceWitnessTracker();
		const sink = flightTrace;
		const ctx = flightTrace?.context;
		if (!sink || !ctx) return;

		const vaultSync = host.getVaultSync();
		deviceWitnessTracker = new DeviceWitnessTracker({
			flightMode: mode,
			traceContext: ctx,
			sink,
			qaTraceSecret: host.getSettings().qaTraceSecret || null,
			stateSecret: ctx.deviceId,
			platform: "desktop",
			// Inject Puppeteer scenario context so tracker can annotate events
			getScenarioContext: () => scenarioController,
			getPathId: async (path: string) => {
				try {
					const result = await flightTrace?.getPathId(path);
					return result?.pathId ?? null;
				} catch {
					return null;
				}
			},
			readDiskContent: async (path: string) => {
				try {
					const file = host.app.vault.getAbstractFileByPath(path);
					if (!file) return null;
					const { TFile } = await import("obsidian");
					if (!(file instanceof TFile)) return null;
					return await host.app.vault.read(file as InstanceType<typeof TFile>);
				} catch {
					return null;
				}
			},
			readCrdtContent: (path: string) => {
				return vaultSync?.getTextForPath(path)?.toString() ?? null;
			},
			isCrdtTombstoned: (path: string) => {
				return vaultSync?.isPathTombstoned(path) ?? false;
			},
			getFileId: (path: string) => {
				return vaultSync?.getFileIdForText(vaultSync?.getTextForPath(path) ?? null as unknown as import("yjs").Text) ?? undefined;
			},
			sampleEditor: (path: string) => {
				try {
					const leaf = host.app.workspace.getLeavesOfType("markdown").find(
						(l) => (l.view as MarkdownView).file?.path === path
					);
					if (!leaf) return { kind: "not_open" as const, content: null };
					const content = (leaf.view as MarkdownView).editor?.getValue() ?? null;
					return { kind: "healthy_sampled" as const, content };
				} catch {
					return { kind: "not_open" as const, content: null };
				}
			},
		});

		// Wire Y.Doc observers
		if (vaultSync) {
			_witnessTextObservers = new Map();

			const metaHandler = () => {
				const vs = host.getVaultSync();
				if (!vs) return;
				for (const [fileId] of vs.meta.entries()) {
					const meta = vs.meta.get(fileId);
					if (!meta || vs.isFileMetaDeleted(meta)) continue;
					deviceWitnessTracker?.markDirty(meta.path, "remote-apply");
				}
			};
			_witnessMetaHandler = metaHandler;
			vaultSync.meta.observe(metaHandler);

			const idToTextHandler = () => {
				deviceWitnessTracker?.markDirty("*", "remote-apply");
			};
			_witnessIdToTextHandler = idToTextHandler;
		}
	}

	function _stopDeviceWitnessTracker(): void {
		if (_witnessMetaHandler) {
			host.getVaultSync()?.meta.unobserve(_witnessMetaHandler);
			_witnessMetaHandler = null;
		}
		_witnessIdToTextHandler = null;
		if (_witnessTextObservers) {
			for (const [, { ytext, handler }] of _witnessTextObservers) {
				ytext.unobserve(handler as Parameters<typeof ytext.unobserve>[0]);
			}
			_witnessTextObservers = null;
		}
		deviceWitnessTracker?.dispose();
		deviceWitnessTracker = null;
	}

	// -----------------------------------------------------------------------
	// Witness bundle / export helpers
	// -----------------------------------------------------------------------

	function _buildBundleHeader(privacyMode: "safe" | "unsafe-local"): Record<string, unknown> {
		const ftc = flightTrace;
		const ctx = ftc?.context;
		const tracker = deviceWitnessTracker;
		return {
			bundleVersion: 1,
			privacyMode,
			traceId: ctx?.traceId ?? null,
			deviceId: ctx?.deviceId ?? null,
			witnessSeq: tracker?.currentWitnessSeq() ?? null,
			exportedAt: new Date().toISOString(),
		};
	}

	function _buildBundleString(privacyMode: "safe" | "unsafe-local"): string {
		const tracker = deviceWitnessTracker;
		const header = _buildBundleHeader(privacyMode);
		const segments = tracker?.getCheckpointSegments() ?? [];
		const lines = [JSON.stringify(header), ...segments.map(s => s.content)];
		return lines.join("\n");
	}

	async function _persistCheckpointSegmentsIfSafe(): Promise<void> {
		const tracker = deviceWitnessTracker;
		if (!tracker) return;
		const diagDir = await host.getDiagnosticsDir();
		if (!diagDir) return;
		// Checkpoint persistence is handled by the tracker itself during flush
	}

	// -----------------------------------------------------------------------
	// QA commands
	// -----------------------------------------------------------------------

	async function startQaFlightTrace(mode?: string): Promise<void> {
		const resolved = (mode ?? host.getSettings().qaTraceMode) as FlightMode;
		await flightTrace?.start(resolved, host.getSettings().qaTraceSecret || null, {
			manualStart: true,
		});
		const secret = host.getSettings().qaTraceSecret ?? "";
		try {
			const bytes = new TextEncoder().encode(`yaos-qa-trace-secret:${secret}`);
			const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
			const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
			_qaTraceSecretHash = `sha256:${hex}`;
		} catch {
			_qaTraceSecretHash = `len:${secret.length}`;
		}
		_startDeviceWitnessTracker(resolved);
		new Notice(`QA flight trace started (mode: ${resolved}).`, 4000);
	}

	async function stopQaFlightTrace(): Promise<void> {
		await _persistCheckpointSegmentsIfSafe();
		_stopDeviceWitnessTracker();
		await flightTrace?.stop();
		new Notice("QA flight trace stopped.", 4000);
	}

	async function exportFlightTrace(requestedPrivacy: "safe" | "full"): Promise<void> {
		const controller = flightTrace;
		if (!controller) {
			new Notice("No active flight trace to export.", 4000);
			return;
		}
		const diagDir = await host.getDiagnosticsDir();
		if (!diagDir) {
			new Notice("Could not resolve diagnostics directory.", 4000);
			return;
		}
		const result = await controller.exportTrace({ requestedPrivacy: requestedPrivacy, diagDir });
		if (result.ok) {
			new Notice(`Flight trace exported: ${result.path}`, 6000);
		} else {
			new Notice(`Export failed: ${result.reason}`, 6000);
		}
	}

	async function qaExportWitnessBundle(privacyMode: "safe" | "unsafe-local"): Promise<void> {
		if (!host.getSettings().qaDebugMode) return;
		const tracker = deviceWitnessTracker;
		const ftc = flightTrace;
		if (!tracker || !ftc) {
			new Notice("No active witness tracker. Start a QA trace first.", 5000);
			return;
		}
		const bundleStr = _buildBundleString(privacyMode);
		new Notice(`Witness bundle ready (${bundleStr.length} chars). Check console.`, 4000);
		console.log("[yaos:qa] witness bundle:", bundleStr);
	}

	function qaShowDeviceIdentity(): void {
		if (!host.getSettings().qaDebugMode) return;
		const ftc = flightTrace;
		const ctx = ftc?.context;
		const tracker = deviceWitnessTracker;
		new Notice(
			`Device: ${ctx?.deviceId ?? "unknown"}\nTrace: ${ctx?.traceId ?? "none"}\nWitness seq: ${tracker?.currentWitnessSeq() ?? "n/a"}`,
			8000,
		);
	}

	function qaSetScenarioRunId(): void {
		if (!host.getSettings().qaDebugMode) return;
		if (!deviceWitnessTracker) {
			new Notice("No active witness tracker.", 4000);
			return;
		}
		// Prompt via modal would be ideal; fallback to window.prompt
		const runId = (typeof window !== "undefined" ? window.prompt("Scenario run ID:") : null) ?? "";
		const scenarioId = (typeof window !== "undefined" ? window.prompt("Scenario ID:") : null) ?? "";
		if (runId && scenarioId) {
			scenarioController.setScenarioRunId(runId, scenarioId);
			new Notice(`Scenario: ${scenarioId} / Run: ${runId}`, 4000);
		}
	}

	function qaAdvanceScenarioStep(): void {
		if (!host.getSettings().qaDebugMode) return;
		const api = (window as unknown as Record<string, unknown>).__YAOS_DEBUG__ as { __qaOnlyAdvanceScenarioStepUnsafe?(step: number, label?: string): void } | undefined;
		if (!api?.__qaOnlyAdvanceScenarioStepUnsafe) {
			new Notice("QA debug API not mounted. Enable qaDebugMode and start a trace.", 5000);
			return;
		}
		if (!deviceWitnessTracker) {
			new Notice("No active witness tracker.", 4000);
			return;
		}
		const stepStr = (typeof window !== "undefined" ? window.prompt("Step index (integer):") : null) ?? "";
		const step = parseInt(stepStr, 10);
		if (!Number.isInteger(step) || step < 0) {
			new Notice("Invalid step index.", 4000);
			return;
		}
		const label = (typeof window !== "undefined" ? window.prompt("Step label (optional):") : null) ?? undefined;
		const ok = scenarioController.advanceScenarioStep(step, label || undefined);
		if (ok) {
			new Notice(`Scenario step advanced to ${step}${label ? ` (${label})` : ""}.`, 3000);
		} else {
			new Notice("Step rejected (backwards or no scenario run ID set).", 4000);
		}
	}

	function qaRefreshWitnessCurrentFile(): void {
		if (!host.getSettings().qaDebugMode) return;
		const tracker = deviceWitnessTracker;
		if (!tracker) {
			new Notice("No active witness tracker.", 4000);
			return;
		}
		const activeFile = host.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No active file.", 4000);
			return;
		}
		tracker.markDirty(activeFile.path, "unknown");
		new Notice(`Witness refresh queued for ${activeFile.path}`, 3000);
	}

	// -----------------------------------------------------------------------
	// QA debug API mount
	// -----------------------------------------------------------------------

	function mountQaDebugApi(): void {
		const api = buildQaDebugApi({
			app: host.app,
			getVaultSync: () => host.getVaultSync(),
			getReconciliationController: () => host.getReconciliationController(),
			getConnectionController: () => host.getConnectionController(),
			getFlightTraceController: () => flightTrace,
			getEditorBindings: () => host.getEditorBindings(),
			getDiagnosticsDir: () => host.getDiagnosticsDir(),
			sha256Hex: (text) => host.sha256Hex(text),
			startQaFlightTrace: (mode) => startQaFlightTrace(mode),
			stopQaFlightTrace,
			exportFlightTrace: async (privacy) => {
				await exportFlightTrace(privacy === "safe" ? "safe" : "full");
				return null;
			},
			runReconciliation: async () => { await host.getReconciliationController().runReconciliation("conservative"); },
			disconnectProvider: (reason) => host.getConnectionController()?.setQaNetworkHold("offline"),
			connectProvider: (reason) => host.getConnectionController()?.setQaNetworkHold("online"),
			getDeviceWitnessTracker: () => deviceWitnessTracker,
			getScenarioController: () => scenarioController,
			getQaTraceSecretHash: () => _qaTraceSecretHash,
			getEngineControlPort: () => host.getEngineControlPort(),
		});
		host.onLabApiMounted(api);
		host.log("QA debug API mounted at window.__YAOS_DEBUG__");
		new Notice("YAOS: QA debug mode active. window.__YAOS_DEBUG__ is available.", 6000);
	}

	function unmountQaDebugApi(): void {
		host.onLabApiUnmounted();
	}

	// -----------------------------------------------------------------------
	// FlightTrace setup
	// -----------------------------------------------------------------------

	function setupFlightTrace(deps: {
		getDocSchemaVersion(): number | null;
		buildCheckpoint(): Promise<Record<string, unknown>>;
	}): void {
		flightTrace = new FlightTraceController({
			app: host.app,
			getSettings: () => host.getSettings(),
			getPluginVersion: () => host.getPluginVersion(),
			getDocSchemaVersion: deps.getDocSchemaVersion,
			buildCheckpoint: deps.buildCheckpoint,
			registerCleanup: (cleanup) => host.registerCleanup(cleanup),
			log: (message) => host.log(message),
		});
	}

	async function refreshFlightTraceState(reason: string): Promise<void> {
		await flightTrace?.refreshFromSettings(reason);
	}

	function scheduleTraceStateSnapshot(reason: string): void {
		// No-op: snapshot scheduling happens internally in FlightTraceController
		void reason;
	}

	// -----------------------------------------------------------------------
	// Dispose
	// -----------------------------------------------------------------------

	function dispose(): void {
		void flightTrace?.stop();   // flush/stop flight trace on unload (fire-and-forget)
		_stopDeviceWitnessTracker();
		unmountQaDebugApi();
	}

	// -----------------------------------------------------------------------
	// registerCommands — lab/QA command surface
	// -----------------------------------------------------------------------

	function registerLabCommands(plugin: Pick<Plugin, "addCommand">): void {
		// Flight trace commands (registered whenever lab is loaded)
		plugin.addCommand({
			id: "qa-flight-trace-start",
			name: "Start QA flight trace",
			callback: () => { void startQaFlightTrace(); },
		});
		plugin.addCommand({
			id: "qa-flight-trace-stop",
			name: "Stop QA flight trace",
			callback: () => { void stopQaFlightTrace(); },
		});
		plugin.addCommand({
			id: "qa-flight-trace-export-safe",
			name: "Export safe QA flight trace",
			callback: () => { void exportFlightTrace("safe"); },
		});
		plugin.addCommand({
			id: "qa-flight-trace-export-full",
			name: "Export QA flight trace with filenames",
			callback: () => { void exportFlightTrace("full"); },
		});
		plugin.addCommand({
			id: "qa-flight-trace-timeline-current-file",
			name: "Show timeline for current file",
			callback: () => { new Notice("Timeline view not yet implemented in lab runtime.", 4000); },
		});
		plugin.addCommand({
			id: "qa-flight-trace-clear-logs",
			name: "Clear flight logs",
			callback: () => {
				void (flightTrace?.clearLogs() ?? Promise.resolve()).then(() => {
					new Notice("Flight logs cleared.", 4000);
				});
			},
		});

		// Torture test — gated on settings.debug
		plugin.addCommand({
			id: "debug-vfs-torture-test",
			name: "Run filesystem torture test (debug)",
			checkCallback: (checking: boolean) => {
				if (!host.getSettings().debug) return false;
				if (!checking) { void handle.runVfsTortureTest(); }
				return true;
			},
		});

		// QA witness commands — only meaningful when qaDebugMode is on, but always registered
		plugin.addCommand({
			id: "qa-export-witness-bundle",
			name: "YAOS QA: Export witness bundle",
			callback: () => { void qaExportWitnessBundle("safe"); },
		});
		plugin.addCommand({
			id: "qa-export-witness-bundle-unsafe",
			name: "YAOS QA: Export witness bundle (unsafe local debug)",
			callback: () => { void qaExportWitnessBundle("unsafe-local"); },
		});
		plugin.addCommand({
			id: "qa-show-device-identity",
			name: "YAOS QA: Show device identity for QA",
			callback: () => { qaShowDeviceIdentity(); },
		});
		plugin.addCommand({
			id: "qa-set-scenario-run-id",
			name: "YAOS QA: Set scenario run ID",
			callback: () => { qaSetScenarioRunId(); },
		});
		plugin.addCommand({
			id: "qa-advance-scenario-step",
			name: "YAOS QA: Advance scenario step",
			callback: () => { qaAdvanceScenarioStep(); },
		});
		plugin.addCommand({
			id: "qa-refresh-witness-current-file",
			name: "YAOS QA: Refresh witness for current file",
			callback: () => { qaRefreshWitnessCurrentFile(); },
		});
	}

	// -----------------------------------------------------------------------
	// Handle
	// -----------------------------------------------------------------------

	const handle: LabRuntimeHandle = {
		traceSink,
		recordFlightPathEvent,
		recordFlightEvent(event) {
			flightTrace?.record(event);
		},
		markWitnessDirty(path, origin) {
			deviceWitnessTracker?.markDirty(path, origin as Parameters<DeviceWitnessTracker["markDirty"]>[1]);
		},
		setupFlightTrace,
		refreshFlightTraceState,
		scheduleTraceStateSnapshot,
		startQaFlightTrace,
		stopQaFlightTrace,
		exportSafeFlightTrace: () => exportFlightTrace("safe"),
		exportFullFlightTrace: () => exportFlightTrace("full"),
		showTimelineForCurrentFile() {
			new Notice("Timeline view not yet implemented in lab runtime.", 4000);
		},
		clearFlightLogs: () => flightTrace?.clearLogs() ?? Promise.resolve(),
		qaExportWitnessBundle,
		qaShowDeviceIdentity,
		qaSetScenarioRunId,
		qaAdvanceScenarioStep,
		qaRefreshWitnessCurrentFile,
		async computeWitnessStateHash(content: string): Promise<string | null> {
			if (!deviceWitnessTracker) return null;
			try {
				return await deviceWitnessTracker.computeWitnessStateHash(content);
			} catch {
				return null;
			}
		},
		getQaTraceSecretHash(): string | null {
			return _qaTraceSecretHash;
		},
				diagnosticsService,
		runVfsTortureTest: () => {
			const vs = host.getVaultSync();
			if (!vs) {
				new Notice("No vault sync active.", 4000);
				return Promise.resolve();
			}
			return runVfsTortureTest({
				app: host.app,
				vaultSync: vs,
				settings: host.getSettings(),
				reconciliationController: host.getReconciliationController(),
				editorWorkspace: null,
		diagnosticsService,
				getBlobSync: () => null,
				getTraceHttpContext: () => host.getTraceHttpContext(),
				eventRing: [],
				log: (msg) => host.log(msg),
			});
		},
		mountQaDebugApi,
		unmountQaDebugApi,
		dispose,
		createTraceLogger(app: App, config: TraceLoggerConfig): TraceLoggerPort {
			return new PersistentTraceLogger(app, config);
		},
		registerCommands: registerLabCommands,
	};

	return handle;
}
