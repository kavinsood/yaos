/**
 * YaosDebugPort — safe debug capabilities for the product runtime.
 *
 * These are capabilities that any debug consumer (status UI, diagnostics,
 * flight recorder, health checks) can use without risk to product data.
 *
 * Nothing in this interface mutates CRDT state, forces network changes,
 * or controls QA scenario machinery.
 *
 * IMPORTANT: This interface must remain assignable from YaosQaDebugApi.
 * See the compile-time check in qa/harness/qaDebugApi.ts.
 */

/**
 * Editor binding health — structural type compatible with YaosQaDebugApi.
 * Uses index signature to accept any additional fields the real API may have.
 */
export interface EditorBindingHealth {
	readonly leafOpen: boolean;
	readonly bound: boolean;
	readonly hasSyncFacet: boolean;
	readonly yTextMatchesExpected: boolean | null;
	readonly healthy: boolean;
	readonly settling: boolean;
	readonly issues: readonly string[];
}

/**
 * Receipt snapshot — structural type compatible with YaosQaDebugApi.
 */
export interface ReceiptSnapshot {
	readonly candidateId: string | null;
	readonly capturedAt: number | null;
	readonly lastConfirmedCandidateId: string | null;
	readonly lastConfirmedAt: number | null;
}

export interface YaosDebugPort {
	// --- State queries (read-only) ---
	isLocalReady(): boolean;
	isProviderSynced(): boolean;
	isProviderConnected(): boolean;
	isReconciled(): boolean;
	isReconcileInFlight(): boolean;
	getConnectionState(): string;
	getServerReceiptState(): "confirmed" | "pending" | "unknown" | "no-candidate";
	getReceiptSnapshot(): ReceiptSnapshot;
	getActiveMarkdownPaths(): string[];
	getDiskMarkdownPaths(): string[];
	getEditorBindingHealth(path: string): EditorBindingHealth;
	getRuntimeState(): "foreground" | "background" | "suspended" | "unknown";

	// --- Hash queries (read-only, async for disk I/O) ---
	getDiskHash(path: string): Promise<string | null>;
	getCrdtHash(path: string): Promise<string | null>;
	getEditorHash(path: string): Promise<string | null>;

	// --- Waiting (non-mutating) ---
	waitForIdle(timeoutMs: number): Promise<void>;
	waitForLocalReady(timeoutMs: number): Promise<void>;
	waitForProviderSynced(timeoutMs: number): Promise<void>;
	waitForReconciled(timeoutMs: number): Promise<void>;
	waitForFile(path: string, timeoutMs: number): Promise<void>;
	waitForReceiptAfter(afterTimestamp: number, timeoutMs: number): Promise<void>;

	// --- Safe actions (no data mutation) ---
	forceReconcile(): Promise<void>;
	forceReconnect(): void;
	disconnectProvider(reason?: string): void;
	connectProvider(reason?: string): void;

	// --- Flight trace (observability only) ---
	startFlightTrace(mode: string, secret?: string): Promise<void>;
	stopFlightTrace(): Promise<void>;
	exportFlightTrace(privacy: "safe" | "full"): Promise<string>;
	getActiveTraceInfo(): Record<string, unknown> | null;
}
