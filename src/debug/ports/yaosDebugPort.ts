/**
 * YaosDebugPort — safe debug capabilities for the product runtime.
 *
 * These are capabilities that any debug consumer (status UI, diagnostics,
 * flight recorder, health checks) can use without risk to product data.
 *
 * Nothing in this interface mutates CRDT state, forces network changes,
 * or controls QA scenario machinery.
 */

export interface EditorBindingHealth {
	readonly path: string;
	readonly hasCm6Extension: boolean;
	readonly hasYjsBinding: boolean;
	readonly isQaPaused: boolean;
	readonly editorViewExists: boolean;
}

export interface ReceiptSnapshot {
	readonly serverAppliedLocalState: boolean | null;
	readonly lastServerReceiptEchoAt: number | null;
	readonly lastKnownServerReceiptEchoAt: number | null;
	readonly hasCandidateSv: boolean;
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
