/**
 * TelemetryRuntimeHost — the only channel through which debug/Observer code
 * (src/telemetry/) reaches product state.
 *
 * The debug runtime ships inside main.js and runs in the same realm as the
 * sync engine. There is no bundle boundary, no loader, and no ABI check
 * standing between them — and there never really was: both halves always
 * shared one V8 realm.
 *
 * THIS INTERFACE IS THE ONLY THING BETWEEN DEBUG CODE AND THE CRDT.
 *
 * It is a type-level guarantee, and it is load-bearing precisely because no
 * runtime isolation backs it up. `getSyncState()` returns a `SyncReadPort` —
 * read-only scalars and read-only methods — never `VaultSync`, never a
 * `Y.Text`/`Y.Map`, never anything with a mutating method. Widen this
 * interface and you have handed the debug runtime the document.
 *
 * What may appear here:
 *   - settings access
 *   - read-only product state snapshots (plain scalars, defensive copies)
 *   - identity / hashing helpers
 *   - lifecycle hooks (cleanup, logging)
 *
 * FORBIDDEN in this interface:
 *   forceCrdtContent, forceSyncFileFromDisk, setQaNetworkHold,
 *   pauseEditorBindingPropagation, runVfsTortureTest, anything Unsafe,
 *   anything __qaOnly — and, above all, any live VaultSync or Yjs handle.
 */

import type { App } from "obsidian";
import type { VaultSyncSettings } from "../settings";
import type { TraceSink } from "../observability/traceSink";
import type { FrontmatterQuarantineEntry } from "../sync/frontmatterQuarantine";
import type { ReconciliationState } from "../runtime/reconciliationController";
import type { VaultSyncReceiptSnapshot } from "../sync/vaultSync";


/**
 * Read-only snapshot of runtime state passed through to DiagnosticsService.
 * All fields are plain scalars — no object handles.
 */
export type RuntimeDiagnosticsState = Readonly<
	Pick<
		ReconciliationState,
		| "reconciled"
		| "reconcileInFlight"
		| "reconcilePending"
		| "lastReconcileStats"
		| "lastReconciledGeneration"
		| "untrackedFileCount"
	> & {
		awaitingFirstProviderSyncAfterStartup: boolean;
		openFileCount: number;
	}
>;

/**
 * SyncReadPort — strictly read-only view of VaultSync state for debug use.
 *
 * This replaces the broad `VaultSync` handle that was previously passed to
 * telemetry. All mutating methods (queueRename, handleDelete, ensureFile,
 * forceReplaceYText, etc.) and mutable Yjs objects (Y.Text, Y.Map) are absent.
 *
 * Enforcement is entirely nominal: debug code never receives a VaultSync
 * reference, it receives this interface, and the type system refuses every
 * method not listed here. main.ts builds the adapter inline so the narrowing
 * is visible at the one place it happens.
 */
export interface SyncReadPort {
	// ------------------------------------------------------------------
	// Connection / auth state — all readonly scalars
	// ------------------------------------------------------------------
	readonly connected: boolean;
	readonly fatalAuthError: boolean;
	readonly fatalAuthCode: string | null;
	readonly fatalAuthDetails: {
		readonly clientSchemaVersion: number | null;
		readonly roomSchemaVersion: number | null;
		readonly reason: string | null;
	} | null;
	readonly localReady: boolean;
	readonly providerSynced: boolean;
	readonly isInitialized: boolean;
	readonly connectionGeneration: number;

	// ------------------------------------------------------------------
	// Timestamp state
	// ------------------------------------------------------------------
	readonly lastLocalUpdateAt: number | null;
	readonly lastLocalUpdateWhileConnectedAt: number | null;
	readonly lastRemoteUpdateAt: number | null;

	// ------------------------------------------------------------------
	// Server receipt / ACK state
	// ------------------------------------------------------------------
	readonly serverReceipt: VaultSyncReceiptSnapshot;
	readonly svEchoCounters: {
		readonly customMessageSeenCount: number;
		readonly svEchoSeenCount: number;
		readonly acceptedCount: number;
		readonly rejectedCount: number;
		readonly rejectedOversizeCount: number;
		readonly rejectedInvalidCount: number;
		readonly bytesMax: number;
	};

	// ------------------------------------------------------------------
	// Persistence health
	// ------------------------------------------------------------------
	readonly idbError: boolean;
	readonly idbErrorDetails: {
		readonly kind: string;
		readonly name: string | null;
		readonly message: string | null;
		readonly phase: "open" | "wait" | "runtime";
		readonly at: string;
	} | null;

	// ------------------------------------------------------------------
	// Schema
	// ------------------------------------------------------------------
	readonly supportedSchemaVersion: number;
	readonly storedSchemaVersion: number | null;

	// ------------------------------------------------------------------
	// Path / content reads — returns plain strings, never mutable Yjs objects
	// ------------------------------------------------------------------

	/** Returns the string content of the CRDT document at path, or null. */
	getPathContent(path: string): string | null;
	/** Returns the stable fileId for the CRDT text at path, or undefined. */
	getFileIdForPath(path: string): string | undefined;
	/** Returns true if the path has been tombstone-deleted in the CRDT. */
	isPathTombstoned(path: string): boolean;
	/** Returns a snapshot of currently active markdown paths. */
	getActiveMarkdownPaths(): readonly string[];
	/** Returns the count of blob paths. */
	readonly blobPathCount: number;
	/** Returns recent vault sync log entries. */
	getRecentEvents(limit?: number): ReadonlyArray<{ ts: string; msg: string }>;
	/** Returns the current reconcile mode. */
	getSafeReconcileMode(): import("../sync/vaultSync").ReconcileMode;
}

export interface DiskMirrorSnapshot {
	readonly activeObserverCount: number;
}

export interface BlobSyncSnapshot {
	readonly pendingUploads: number;
	readonly pendingDownloads: number;
}

export interface TelemetryRuntimeHost {
	// Telemetry is an Obsidian module and may use App for UI, diagnostics export,
	// and trace persistence. Domain state must still cross this boundary as values.
	readonly app: App;
	getSettings(): VaultSyncSettings;

	/**
	 * Narrow read-only view of sync state.
	 * Returns null if VaultSync has not been initialised yet.
	 *
	 * NOTE: this replaces the previous getVaultSync(): VaultSync | null handle.
	 * The Observer tier must not receive a mutable VaultSync reference.
	 */
	getSyncState(): SyncReadPort | null;

	getTraceSink(): TraceSink;

	// Domain diagnostics cross this boundary as scalar snapshots, never manager instances.
	getDiskMirrorSnapshot(): DiskMirrorSnapshot | null;
	getBlobSyncSnapshot(): BlobSyncSnapshot | null;
	getEventRing(): ReadonlyArray<{ ts: string; msg: string }>;
	getFrontmatterQuarantineEntries(): readonly FrontmatterQuarantineEntry[];
	getRuntimeDiagnosticsState(): RuntimeDiagnosticsState;
	collectOpenFileTraceState(): Promise<Array<Record<string, unknown>>>;

	getPluginVersion(): string;
	/** Server semver from the last capability fetch, or null if never fetched. */
	getServerVersion(): string | null;
	isMarkdownPathSyncable(path: string): boolean;
	log(msg: string): void;
}
