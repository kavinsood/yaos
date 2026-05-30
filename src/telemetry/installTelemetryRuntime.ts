/**
 * installTelemetryRuntime — wires passive Observer machinery given a
 * TelemetryRuntimeHost.
 *
 * This is the single entry point for the telemetry/observer runtime.
 * main.ts imports this ONLY via dynamic import when settings.debug or
 * settings.qaDebugMode is true. In a production build with code splitting
 * this file and all its transitive imports stay out of the main chunk.
 *
 * Observer contract:
 *   - May contain: FlightRecorder, DeviceWitnessTracker, SafeDiagnostics,
 *     FlightTraceSink / recorder adapter, redaction/path hashing,
 *     safe support bundle export, passive trace recording.
 *   - Must NOT: mutate sync state, CRDT state, editor state, network state,
 *     or the filesystem except for safe export/write-to-user-approved channels.
 *   - Must NOT: contain VFS torture, scenario steppers, unsafe CRDT forcing,
 *     forced sync, network holds, or editor-pause controls.
 *
 * Mutation harness (Puppeteer) lives in qa/ and is never imported from here.
 */

import type { App, MarkdownView, Plugin } from "obsidian";
import { Notice } from "obsidian";
import type { TelemetryRuntimeHost } from "./telemetryRuntimeHost";
import { FlightTraceController } from "./debug/flightTraceController";
import { FlightTraceSink } from "./debug/flightTraceSink";
import { DeviceWitnessTracker } from "./diagnostics/deviceWitnessTracker";
import { DiagnosticsService } from "./diagnostics/diagnosticsService";
import type { FlightMode, FlightPathEventInput, FlightEventInput } from "./debug/flightEvents";
import type { ProductFlightPathEventInput } from "../observability/traceSink";
import { PersistentTraceLogger } from "./debug/trace";
import type { TraceLoggerPort, TraceLoggerConfig } from "../observability/traceLogger";

/**
 * Handle returned to main.ts after telemetry runtime is installed.
 * All methods use primitive types only — no telemetry types leak through.
 *
 * This interface contains ONLY passive/observer capabilities.
 * FORBIDDEN: forceCrdtContent, forceSyncFileFromDisk, setScenarioRunId,
 *   advanceScenarioStep, setQaNetworkHold, pauseEditorBindingPropagation,
 *   runVfsTortureTest, anything Unsafe, anything __qaOnly.
 */
export interface TelemetryRuntimeHandle {
	// TraceSink adapter — product code routes events here
	readonly traceSink: import("../observability/traceSink").TraceSink;

	// Called by main.ts on every path event (from reconciliation, sync)
	recordFlightPathEvent(event: ProductFlightPathEventInput | FlightPathEventInput): void;
	recordFlightEvent(event: FlightEventInput): void;

	// Witness notifications from main.ts hot path (passive — marks for re-evaluation)
	markWitnessDirty(path: string, origin: string): void;

	// Flight trace lifecycle
	setupFlightTrace(deps: {
		getDocSchemaVersion(): number | null;
		buildCheckpoint(): Promise<Record<string, unknown>>;
	}): void;
	refreshFlightTraceState(reason: string): Promise<void>;
	scheduleTraceStateSnapshot(reason: string): void;

	// Passive trace commands (safe, read-only diagnostic operations)
	startTelemetryTrace(mode?: string): Promise<void>;
	stopTelemetryTrace(): Promise<void>;
	exportSafeFlightTrace(): Promise<void>;
	exportFullFlightTrace(): Promise<void>;
	showTimelineForCurrentFile(): void;
	clearFlightLogs(): Promise<void>;

	// Safe witness commands (read-only / passive)
	exportSafeWitnessBundle(): Promise<void>;
	showDeviceIdentity(): void;
	refreshWitnessCurrentFile(): void;

	// Witness state hash (used for recovery state correlation — passive computation)
	computeWitnessStateHash(content: string): Promise<string | null>;

	// QA trace secret hash (for cross-device identity verification — read-only)
	getQaTraceSecretHash(): string | null;

	// ---------------------------------------------------------------------------
	// QA harness accessors — read-only references to internal Observer objects.
	// Used by qa/obsidian-harness/ to assemble window.__YAOS_DEBUG__.
	// Optional so existing callers are unaffected.
	// ---------------------------------------------------------------------------

	/** Returns the DeviceWitnessTracker instance (for QA harness witness primitives). */
	getDeviceWitnessTracker?(): import("./diagnostics/deviceWitnessTracker").DeviceWitnessTracker | null;
	/** Returns the FlightTraceController instance (for QA harness phase recording). */
	getFlightTraceController?(): import("./debug/flightTraceController").FlightTraceController | null;

	// Diagnostics — typed as unknown to avoid nominal type mismatch between
	// src/telemetry/diagnostics/diagnosticsService and src/diagnostics/diagnosticsService.
	// They are structurally identical; call sites cast as needed.
	readonly diagnosticsService: unknown;

	// Called on plugin unload
	dispose(): void;

	/** Creates a PersistentTraceLogger bound to the telemetry runtime. */
	createTraceLogger(app: App, config: TraceLoggerConfig): TraceLoggerPort;

	/**
	 * Register all telemetry commands with the plugin.
	 * Called once during initSync, after product commands are registered.
	 * Telemetry owns: passive trace commands, safe export, read-only device identity.
	 */
	registerCommands(plugin: Pick<Plugin, "addCommand">): void;
}

export async function installTelemetryRuntime(host: TelemetryRuntimeHost): Promise<TelemetryRuntimeHandle> {
	let flightTrace: FlightTraceController | null = null;
	let deviceWitnessTracker: DeviceWitnessTracker | null = null;
	let _qaTraceSecretHash: string | null = null;

	// Witness observer refs for cleanup
	let _witnessTextObservers: Map<string, { ytext: import("yjs").Text; handler: (...args: unknown[]) => void }> | null = null;
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let _witnessIdToTextHandler: (() => void) | null = null;
	let _witnessMetaHandler: (() => void) | null = null;

	// -----------------------------------------------------------------------
	// DiagnosticsService
	// -----------------------------------------------------------------------

	const diagnosticsService = new DiagnosticsService({
		app: host.app,
		getSettings: () => host.getSettings(),
		getVaultSync: () => host.getVaultSync(),
		getDiskMirror: () => host.getDiskMirror(),
		getBlobSync: () => host.getBlobSync(),
		getTraceHttpContext: () => host.getTraceHttpContext(),
		getEventRing: () => host.getEventRing() as Array<{ ts: string; msg: string }>,
		getRecentServerTrace: () => host.getRecentServerTrace() as unknown[],
		getFrontmatterQuarantineEntries: () => host.getFrontmatterQuarantineEntries() as import("../sync/frontmatterQuarantine").FrontmatterQuarantineEntry[],
		getState: () => host.getRuntimeDiagnosticsState(),
		isMarkdownPathSyncable: (path) => host.isMarkdownPathSyncable(path),
		collectOpenFileTraceState: () => host.collectOpenFileTraceState(),
		sha256Hex: (text) => host.sha256Hex(text),
		log: (message) => host.log(message),
	});

	// -----------------------------------------------------------------------
	// TraceSink (FlightTraceSink adapter)
	// -----------------------------------------------------------------------

	const traceSink = new FlightTraceSink((event) => handle.recordFlightPathEvent(event));

	// -----------------------------------------------------------------------
	// recordFlightPathEvent — core routing logic (passive event routing)
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
				event.data?.renameRole === "target");

		if (isAdmissionOrRenameTarget) {
			const excludedByPolicy = !host.isMarkdownPathSyncable(event.path);
			event = {
				...event,
				data: {
					...(event.data ?? {}),
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
			const data = event.data;
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
			configDir: host.app.vault.configDir,
			flightMode: mode,
			traceContext: ctx,
			sink,
			qaTraceSecret: host.getSettings().qaTraceSecret || null,
			stateSecret: ctx.deviceId,
			platform: "desktop",
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
					return await host.app.vault.read(file);
				} catch {
					return null;
				}
			},
			readCrdtContent: (path: string) => {
				// Yjs Text has a proper toString() implementation
				// eslint-disable-next-line @typescript-eslint/no-base-to-string
				return host.getVaultSync()?.getTextForPath(path)?.toString() ?? null;
			},
			isCrdtTombstoned: (path: string) => {
				return host.getVaultSync()?.isPathTombstoned(path) ?? false;
			},
			getFileId: (path: string) => {
				const vaultSync = host.getVaultSync();
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
	// Witness bundle / export helpers (safe mode only — no unsafe-local)
	// -----------------------------------------------------------------------

	function _buildBundleHeader(privacyMode: "safe"): Record<string, unknown> {
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

	function _buildBundleString(privacyMode: "safe"): string {
		const tracker = deviceWitnessTracker;
		const header = _buildBundleHeader(privacyMode);
		const segments = tracker?.getCheckpointSegments() ?? [];
		const lines = [JSON.stringify(header), ...segments.map(s => s.content)];
		return lines.join("\n");
	}

	async function _persistCheckpointSegmentsIfSafe(): Promise<void> {
		const tracker = deviceWitnessTracker;
		if (!tracker) return;
		const diagDir = await diagnosticsService.ensureDiagnosticsDir().catch(() => null);
		if (!diagDir) return;
		// Checkpoint persistence is handled by the tracker itself during flush
	}

	// -----------------------------------------------------------------------
	// Telemetry / trace commands (passive, safe)
	// -----------------------------------------------------------------------

	async function startTelemetryTrace(mode?: string): Promise<void> {
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
		new Notice(`Telemetry trace started (mode: ${resolved}).`, 4000);
	}

	async function stopTelemetryTrace(): Promise<void> {
		await _persistCheckpointSegmentsIfSafe();
		_stopDeviceWitnessTracker();
		await flightTrace?.stop();
		new Notice("Telemetry trace stopped.", 4000);
	}

	async function exportFlightTrace(requestedPrivacy: "safe" | "full"): Promise<void> {
		const controller = flightTrace;
		if (!controller) {
			new Notice("No active flight trace to export.", 4000);
			return;
		}
		const diagDir = await diagnosticsService.ensureDiagnosticsDir().catch(() => null);
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

	async function exportSafeWitnessBundle(): Promise<void> {
		const tracker = deviceWitnessTracker;
		const ftc = flightTrace;
		if (!tracker || !ftc) {
			new Notice("No active witness tracker. Start a telemetry trace first.", 5000);
			return;
		}
		const bundleStr = _buildBundleString("safe");
		new Notice(`Witness bundle ready (${bundleStr.length} chars). Check console.`, 4000);
		console.debug("[yaos:telemetry] witness bundle:", bundleStr);
	}

	function showDeviceIdentity(): void {
		const ftc = flightTrace;
		const ctx = ftc?.context;
		const tracker = deviceWitnessTracker;
		new Notice(
			`Device: ${ctx?.deviceId ?? "unknown"}\nTrace: ${ctx?.traceId ?? "none"}\nWitness seq: ${tracker?.currentWitnessSeq() ?? "n/a"}`,
			8000,
		);
	}

	function refreshWitnessCurrentFile(): void {
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
			getDocSchemaVersion: () => deps.getDocSchemaVersion(),
			buildCheckpoint: () => deps.buildCheckpoint(),
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
	}

	// -----------------------------------------------------------------------
	// registerCommands — passive telemetry command surface only
	//
	// Allowed: enable/start passive trace, stop passive trace, export safe
	// support bundle, export safe telemetry bundle, show read-only device
	// identity, show recent telemetry state, clear telemetry logs.
	//
	// Forbidden: set scenario run ID, advance scenario step, run VFS torture,
	// force CRDT, force sync, pause editor binding, unsafe-local export,
	// network hold / offline hold controls.
	// -----------------------------------------------------------------------

	function registerTelemetryCommands(plugin: Pick<Plugin, "addCommand">): void {
		// Passive flight trace commands
		plugin.addCommand({
			id: "telemetry-trace-start",
			name: "Start telemetry trace",
			callback: () => { void startTelemetryTrace(); },
		});
		plugin.addCommand({
			id: "telemetry-trace-stop",
			name: "Stop telemetry trace",
			callback: () => { void stopTelemetryTrace(); },
		});
		plugin.addCommand({
			id: "telemetry-trace-export-safe",
			name: "Export safe telemetry trace",
			callback: () => { void exportFlightTrace("safe"); },
		});
		plugin.addCommand({
			id: "telemetry-trace-export-full",
			name: "Export telemetry trace with filenames",
			callback: () => { void exportFlightTrace("full"); },
		});
		plugin.addCommand({
			id: "telemetry-trace-timeline-current-file",
			name: "Show timeline for current file",
			callback: () => { new Notice("Timeline view not yet implemented in telemetry runtime.", 4000); },
		});
		plugin.addCommand({
			id: "telemetry-trace-clear-logs",
			name: "Clear telemetry logs",
			callback: () => {
				void (flightTrace?.clearLogs() ?? Promise.resolve()).then(() => {
					new Notice("Telemetry logs cleared.", 4000);
				});
			},
		});

		// Safe witness bundle export (safe mode only — no unsafe-local)
		plugin.addCommand({
			id: "telemetry-export-witness-bundle",
			name: "Export safe witness bundle",
			callback: () => { void exportSafeWitnessBundle(); },
		});

		// Read-only device identity
		plugin.addCommand({
			id: "telemetry-show-device-identity",
			name: "Show device identity",
			callback: () => { showDeviceIdentity(); },
		});

		// Passive witness refresh (re-evaluates current file state, no mutation)
		plugin.addCommand({
			id: "telemetry-refresh-witness-current-file",
			name: "Refresh witness for current file",
			callback: () => { refreshWitnessCurrentFile(); },
		});
	}

	// -----------------------------------------------------------------------
	// Handle
	// -----------------------------------------------------------------------

	const handle: TelemetryRuntimeHandle = {
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
		startTelemetryTrace,
		stopTelemetryTrace,
		exportSafeFlightTrace: () => exportFlightTrace("safe"),
		exportFullFlightTrace: () => exportFlightTrace("full"),
		showTimelineForCurrentFile() {
			new Notice("Timeline view not yet implemented in telemetry runtime.", 4000);
		},
		clearFlightLogs: () => flightTrace?.clearLogs() ?? Promise.resolve(),
		exportSafeWitnessBundle,
		showDeviceIdentity,
		refreshWitnessCurrentFile,
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
		getDeviceWitnessTracker: () => deviceWitnessTracker,
		getFlightTraceController: () => flightTrace,
		diagnosticsService,
		dispose,
		createTraceLogger(app: App, config: TraceLoggerConfig): TraceLoggerPort {
			return new PersistentTraceLogger(app, config);
		},
		registerCommands: registerTelemetryCommands,
	};

	return handle;
}
