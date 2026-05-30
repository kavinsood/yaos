/**
 * TelemetryRuntimeHost — minimal interface that main.ts exposes to the
 * telemetry runtime.
 *
 * Telemetry code accesses product state exclusively through this interface.
 * Product code never imports telemetry modules directly.
 *
 * This interface exposes only read-only / passive capabilities:
 *   - settings access
 *   - read-only product state snapshots
 *   - identity / hashing helpers
 *   - lifecycle hooks (cleanup, logging)
 *
 * FORBIDDEN in this interface:
 *   forceCrdtContent, forceSyncFileFromDisk, setScenarioRunId,
 *   advanceScenarioStep, setQaNetworkHold, pauseEditorBindingPropagation,
 *   runVfsTortureTest, anything Unsafe, anything __qaOnly
 *
 * ARCHITECTURAL NOTE:
 *   The broad object handles (getVaultSync, getReconciliationController, etc.)
 *   are accepted in this cut because the Observer implementation mostly reads
 *   from them. A future cleanup should replace them with narrow read-only
 *   ports/snapshots so the passive boundary is enforced by types, not convention.
 */

import type { App } from "obsidian";
import type { VaultSync, ReconcileMode } from "../sync/vaultSync";
import type { ReconciliationController } from "../runtime/reconciliationController";
import type { ConnectionController } from "../runtime/connectionController";
import type { EditorBindingManager } from "../sync/editorBinding";
import type { VaultSyncSettings } from "../settings";
import type { TraceSink } from "../observability/traceSink";
import type { TraceHttpContext } from "../observability/traceContext";
import type { DiskMirror } from "../sync/diskMirror";
import type { BlobSyncManager } from "../sync/blobSync";
import type { FrontmatterQuarantineEntry } from "../sync/frontmatterQuarantine";

/**
 * Read-only snapshot of runtime state passed through to DiagnosticsService.
 * All fields are plain scalars — no object handles.
 */
export interface RuntimeDiagnosticsState {
	reconciled: boolean;
	reconcileInFlight: boolean;
	reconcilePending: boolean;
	lastReconcileStats: {
		at: string;
		mode: ReconcileMode;
		plannedCreates: number;
		plannedUpdates: number;
		flushedCreates: number;
		flushedUpdates: number;
		safetyBrakeTriggered: boolean;
		safetyBrakeReason: string | null;
	} | null;
	awaitingFirstProviderSyncAfterStartup: boolean;
	lastReconciledGeneration: number;
	untrackedFileCount: number;
	openFileCount: number;
}

export interface TelemetryRuntimeHost {
	readonly app: App;
	getSettings(): VaultSyncSettings;
	getVaultSync(): VaultSync | null;
	getReconciliationController(): ReconciliationController;
	getConnectionController(): ConnectionController | null;
	getEditorBindings(): EditorBindingManager | null;
	getTraceSink(): TraceSink;
	getTraceHttpContext(): TraceHttpContext | undefined;

	// ---------------------------------------------------------------------------
	// Real product state — fed into DiagnosticsService.
	// These are read-only accessors; callers must not mutate via the returned
	// objects. The DiskMirror and BlobSyncManager handles are needed because
	// DiagnosticsService calls their read-only .getDebugSnapshot() methods.
	// ---------------------------------------------------------------------------
	getDiskMirror(): DiskMirror | null;
	getBlobSync(): BlobSyncManager | null;
	getEventRing(): ReadonlyArray<{ ts: string; msg: string }>;
	getRecentServerTrace(): readonly unknown[];
	getFrontmatterQuarantineEntries(): readonly FrontmatterQuarantineEntry[];
	getRuntimeDiagnosticsState(): RuntimeDiagnosticsState;
	collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>>;

	sha256Hex(text: string): Promise<string>;
	getPluginVersion(): string;
	isMarkdownPathSyncable(path: string): boolean;
	/** Register a cleanup to run on plugin unload. */
	registerCleanup(cleanup: () => void): void;
	log(msg: string): void;
}
