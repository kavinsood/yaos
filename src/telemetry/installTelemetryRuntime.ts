/**
 * installTelemetryRuntime — constructs the passive debug/Observer machinery
 * given a TelemetryRuntimeHost.
 *
 * This is a normal module inside main.js. It used to be a separate bundle
 * entry point loaded by eval; it no longer is, and there is no ABI, no loader
 * and no dynamic import left. main.ts calls it directly when settings.debug
 * (or qaDebugMode) is on, and holds the returned handle.
 *
 * The handle stays a named seam rather than being inlined into main.ts: it is
 * the one list of everything product code is allowed to ask the debug runtime
 * to do, and it is short on purpose.
 *
 * Observer contract:
 *   - May contain: FlightRecorder, SafeDiagnostics,
 *     FlightTraceSink / recorder adapter, redaction/path hashing,
 *     safe support bundle export, passive trace recording.
 *   - Must NOT: mutate sync state, CRDT state, editor state, network state,
 *     or the filesystem except for safe export/write-to-user-approved channels.
 *   - Must NOT: contain VFS torture, scenario steppers, unsafe CRDT forcing,
 *     forced sync, network holds, or editor-pause controls.
 *
 * Mutation harness (Puppeteer) lives in qa/ and is never imported from here.
 */

import type { Plugin } from "obsidian";
import { Notice } from "obsidian";
import type { TelemetryRuntimeHost } from "./telemetryRuntimeHost";
import { FlightTraceController } from "./debug/flightTraceController";
import { FlightTraceSink } from "./debug/flightTraceSink";
import { DiagnosticsService } from "./diagnostics/diagnosticsService";
import type { FlightPathEventInput, FlightEventInput } from "../observability/flightEnvelope";
import type { TraceSink } from "../observability/traceSink";
import type { FrontmatterQuarantineEntry } from "../sync/frontmatterQuarantine";
import type {
	TraceEventDetails,
	TraceHttpContext,
} from "../observability/traceContext";

/**
 * Handle returned to main.ts after the debug runtime is installed.
 *
 * This interface contains ONLY passive/observer capabilities.
 * FORBIDDEN: forceCrdtContent, forceSyncFileFromDisk, setQaNetworkHold,
 *   pauseEditorBindingPropagation, runVfsTortureTest, anything Unsafe,
 *   anything __qaOnly.
 */
export interface TelemetryRuntimeHandle {
	// TraceSink adapter — product code routes events here
	readonly traceSink: TraceSink;

	// Called by main.ts on every path event (from reconciliation, sync)
	recordFlightPathEvent(event: FlightPathEventInput): void;
	recordFlightEvent(event: FlightEventInput): void;

	// Flight trace lifecycle. There is no start/stop pair: recording is a pure
	// function of settings.debug, and refreshFlightTraceState applies it.
	setupFlightTrace(deps: {
		getDocSchemaVersion(): number | null;
		buildCheckpoint(): Promise<Record<string, unknown>>;
		isIndexedDbRelatedError(error: unknown): boolean;
		isObsidianFileMetadataRaceError(error: unknown): boolean;
		handleIndexedDbDegraded(source: string, error?: unknown): void;
	}): void;
	refreshFlightTraceState(reason: string): Promise<void>;
	recordTrace(source: string, message: string, details?: TraceEventDetails): void;
	scheduleTraceCheckpoint(reason: string): void;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getRecentServerTrace(): readonly unknown[];
	refreshServerTrace(): Promise<void>;

	// Passive trace commands (safe, read-only diagnostic operations).
	// includeFilenames only widens the export header; event lines are identical.
	exportDebugTrace(includeFilenames: boolean): Promise<void>;
	clearFlightLogs(): Promise<void>;

	/**
	 * Fingerprint of the derived path-pseudonymisation salt, `sha256:<32 hex>`,
	 * or null when no trace is active. Lets two devices in one vault confirm
	 * they are producing correlatable pathIds. Read-only.
	 */
	getPathSaltFingerprint(): string | null;

	// ---------------------------------------------------------------------------
	// QA harness accessors — read-only references to internal Observer objects.
	// Used by qa/obsidian-harness/ to assemble window.__YAOS_DEBUG__.
	// Optional so existing callers are unaffected.
	// ---------------------------------------------------------------------------

	/** Returns the FlightTraceController instance (for QA harness phase recording). */
	getFlightTraceController?(): FlightTraceController | null;

	readonly diagnosticsService: DiagnosticsService;

	// Called on plugin unload
	dispose(): void;


	/**
	 * Register all debug commands with the plugin.
	 * Called once during initSync, after product commands are registered.
	 * The debug runtime owns: trace export and log clearing.
	 */
	registerCommands(plugin: Pick<Plugin, "addCommand">): void;
}

/**
 * Path-event kinds that admit a file into the CRDT. For these (and for the
 * target side of an observed rename) the recorder annotates whether sync
 * policy excluded the path, which is the difference between "never admitted"
 * and "admitted then lost".
 */
const ADMISSION_KINDS: Record<string, true> = {
	"crdt.file.created": true,
	"crdt.file.renamed": true,
	"crdt.file.revived": true,
};

export async function installTelemetryRuntime(host: TelemetryRuntimeHost): Promise<TelemetryRuntimeHandle> {
	let flightTrace: FlightTraceController | null = null;

	// -----------------------------------------------------------------------
	// DiagnosticsService
	// -----------------------------------------------------------------------

	const diagnosticsService = new DiagnosticsService({
		app: host.app,
		getSettings: () => host.getSettings(),
		getSyncState: () => host.getSyncState(),
		getDiskMirrorSnapshot: () => host.getDiskMirrorSnapshot(),
		getBlobSyncSnapshot: () => host.getBlobSyncSnapshot(),
		getTraceHttpContext: () => flightTrace?.httpContext,
		getEventRing: () => host.getEventRing() as Array<{ ts: string; msg: string }>,
		getRecentServerTrace: () => [...(flightTrace?.getRecentServerTrace() ?? [])],
		getFrontmatterQuarantineEntries: () => host.getFrontmatterQuarantineEntries() as FrontmatterQuarantineEntry[],
		getState: () => host.getRuntimeDiagnosticsState(),
		isMarkdownPathSyncable: (path) => host.isMarkdownPathSyncable(path),
		collectOpenFileTraceState: () => host.collectOpenFileTraceState(),
		getServerVersion: () => host.getServerVersion(),
		log: (message) => host.log(message),
	});

	// -----------------------------------------------------------------------
	// TraceSink (FlightTraceSink adapter)
	// -----------------------------------------------------------------------

	const traceSink = new FlightTraceSink((event) => handle.recordFlightPathEvent(event));

	// -----------------------------------------------------------------------
	// recordFlightPathEvent — core routing logic (passive event routing)
	// -----------------------------------------------------------------------

	function recordFlightPathEvent(event: FlightPathEventInput): void {
		const isAdmissionOrRenameTarget =
			ADMISSION_KINDS[event.kind] === true ||
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

		void flightTrace?.recordPath(event);
	}

	// -----------------------------------------------------------------------
	// Trace export (passive, safe)
	//
	// Redaction is a property of the export, not a persistent mode. The
	// recorder always writes hardened event lines; includeFilenames only adds
	// the pathId → path directory and unredacted identity to the header.
	// -----------------------------------------------------------------------

	async function exportDebugTrace(includeFilenames: boolean): Promise<void> {
		const controller = flightTrace;
		if (!controller) {
			new Notice("Debug mode is off — there is no trace to export.", 6000);
			return;
		}
		const diagDir = await diagnosticsService.ensureDiagnosticsDir().catch(() => null);
		if (!diagDir) {
			new Notice("Could not resolve diagnostics directory.", 4000);
			return;
		}
		const result = await controller.exportTrace({ diagDir, includeFilenames });
		if (result.ok) {
			new Notice(`Debug trace exported: ${result.path}`, 6000);
		} else {
			new Notice(`Export failed: ${result.reason}`, 6000);
		}
	}

	// -----------------------------------------------------------------------
	// FlightTrace setup
	// -----------------------------------------------------------------------

	function setupFlightTrace(deps: {
		getDocSchemaVersion(): number | null;
		buildCheckpoint(): Promise<Record<string, unknown>>;
		isIndexedDbRelatedError(error: unknown): boolean;
		isObsidianFileMetadataRaceError(error: unknown): boolean;
		handleIndexedDbDegraded(source: string, error?: unknown): void;
	}): void {
		flightTrace = new FlightTraceController({
			app: host.app,
			getSettings: () => host.getSettings(),
			getPluginVersion: () => host.getPluginVersion(),
			getDocSchemaVersion: () => deps.getDocSchemaVersion(),
			buildCheckpoint: () => deps.buildCheckpoint(),
			collectTraceHeaderInput: () => diagnosticsService.collectTraceHeaderInput(),
			isIndexedDbRelatedError: (error) => deps.isIndexedDbRelatedError(error),
			isObsidianFileMetadataRaceError: (error) => deps.isObsidianFileMetadataRaceError(error),
			handleIndexedDbDegraded: (source, error) => deps.handleIndexedDbDegraded(source, error),
			log: (message) => host.log(message),
		});
	}

	/**
	 * Apply settings.debug to the recorder. This is the whole lifecycle: main.ts
	 * calls it once at startup and again whenever settings change.
	 */
	async function refreshFlightTraceState(reason: string): Promise<void> {
		await flightTrace?.refreshFromSettings(reason);
	}

	// -----------------------------------------------------------------------
	// Dispose
	// -----------------------------------------------------------------------

	function dispose(): void {
		void flightTrace?.stop();   // flush/stop flight trace on unload (fire-and-forget)
	}

	// -----------------------------------------------------------------------
	// registerCommands — passive debug command surface only.
	//
	// Allowed: export the trace (redacted or with filenames), clear trace logs.
	// There is deliberately no start/stop command: recording follows
	// settings.debug, so a command could not desynchronise from it.
	//
	// Forbidden: run VFS torture, force CRDT, force sync, pause editor
	// binding, unsafe-local export, network hold / offline hold controls.
	// -----------------------------------------------------------------------

	function registerTelemetryCommands(plugin: Pick<Plugin, "addCommand">): void {
		plugin.addCommand({
			id: "export-debug-trace",
			name: "Export debug trace",
			callback: () => { void exportDebugTrace(false); },
		});
		plugin.addCommand({
			id: "export-debug-trace-with-filenames",
			name: "Export debug trace with filenames",
			callback: () => { void exportDebugTrace(true); },
		});
		plugin.addCommand({
			id: "clear-debug-trace-logs",
			name: "Clear debug trace logs",
			callback: () => {
				void (flightTrace?.clearLogs() ?? Promise.resolve()).then(() => {
					new Notice("Debug trace logs cleared.", 4000);
				});
			},
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
		recordTrace(source, message, details) {
			flightTrace?.recordTrace(source, message, details);
		},
		scheduleTraceCheckpoint(reason) {
			flightTrace?.scheduleCheckpoint(reason);
		},
		getTraceHttpContext: () => flightTrace?.httpContext,
		getRecentServerTrace: () => flightTrace?.getRecentServerTrace() ?? [],
		refreshServerTrace: () => flightTrace?.refreshServerTrace() ?? Promise.resolve(),
		setupFlightTrace,
		refreshFlightTraceState,
		exportDebugTrace,
		clearFlightLogs: () => flightTrace?.clearLogs() ?? Promise.resolve(),
		getPathSaltFingerprint: () => flightTrace?.pathSaltFingerprint ?? null,
		getFlightTraceController: () => flightTrace,
		diagnosticsService,
		dispose,
		registerCommands: registerTelemetryCommands,
	};

	return handle;
}
