/**
 * Shared types for the YAOS QA harness.
 */

import type { App } from "obsidian";
import type { YaosQaDebugApi } from "../../src/qaDebugApi";

// -----------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------

export interface VaultManifestEntry {
	path: string;
	sha256: string;
	bytes: number;
	kind: "markdown" | "attachment" | "other";
}

export interface VaultManifest {
	generatedAt: string;
	fileCount: number;
	files: VaultManifestEntry[];
}

export interface ManifestDiff {
	match: boolean;
	differ: Array<{ path: string; aSha: string; bSha: string }>;
	missingOnB: string[];
	extraOnB: string[];
}

// -----------------------------------------------------------------------
// Scenario
// -----------------------------------------------------------------------

export type DeleteMode = "vault-delete" | "trash" | "adapter-remove";

export interface QaRunOptions {
	timeoutMs?: number;
	role?: "A" | "B" | "C";
}

/**
 * Phase marker emitted into the trace so the analyzer can scope events.
 * setup → run → assert → (trace export + analyze) → cleanup
 */
export type QaPhase = "setup" | "run" | "assert" | "cleanup";

export interface QaResult {
	id: string;
	/** True only if BOTH scenario assertions AND analyzer passed. */
	passed: boolean;
	scenarioPassed: boolean;
	analyzerPassed: boolean;
	durationMs: number;
	errors: string[];
	warnings: string[];
	tracePath: string | null;
	analyzerReport: unknown | null;
}

export interface QaContext {
	app: App;
	yaos: YaosQaDebugApi;

	/**
	 * Emit a qa.phase flight event marking the start of a scenario lifecycle
	 * phase. Called automatically by the harness run() loop; scenarios may
	 * also call it to sub-divide long phases for analyzer clarity.
	 */
	phase(name: "setup" | "run" | "assert" | "cleanup"): Promise<void>;

	// Vault operations (real Obsidian APIs)
	createFile(path: string, content: string): Promise<void>;
	modifyFile(path: string, content: string): Promise<void>;
	appendToFile(path: string, text: string): Promise<void>;
	deleteFile(path: string, mode?: DeleteMode): Promise<void>;
	renameFile(oldPath: string, newPath: string): Promise<void>;

	/**
	 * Write via Obsidian adapter — bypasses vault event pipeline but NOT the OS watcher.
	 * Use for: adapter-layer tests.
	 * For real external FS writes (OS watcher path), use the Node controller.
	 */
	writeAdapterFile(path: string, content: string): Promise<void>;
	deleteAdapterFile(path: string): Promise<void>;

	// Editor operations
	openFile(path: string): Promise<void>;
	closeFile(path: string): Promise<void>;
	typeIntoFile(path: string, text: string): Promise<void>;
	replaceFileContent(path: string, content: string): Promise<void>;
	runCommand(commandId: string): Promise<void>;

	// Wait helpers
	waitForIdle(timeoutMs?: number): Promise<void>;
	waitForMemoryReceipt(timeoutMs?: number): Promise<void>;
	waitForFile(path: string, timeoutMs?: number): Promise<void>;
	/** Wait until YAOS has seeded the file into CRDT (getCrdtHash non-null). */
	waitForCrdtFile(path: string, timeoutMs?: number): Promise<void>;
	/** Wait until disk hash == CRDT hash. Use after modifyFile on existing files. */
	waitForDiskCrdtConverge(path: string, timeoutMs?: number): Promise<void>;
	/** Wait until a MarkdownView leaf is active. Does NOT prove CRDT binding. */
	waitForActiveMarkdownLeaf(path: string, timeoutMs?: number): Promise<void>;
	/**
	 * Wait until the CRDT editor binding is fully healthy for this path:
	 * leaf open + ySyncFacet present + Y.Text matches CRDT Y.Text.
	 * Use this instead of waitForActiveMarkdownLeaf for binding-sensitive tests.
	 */
	waitForCrdtBinding(path: string, timeoutMs?: number): Promise<void>;
	sleep(ms: number): Promise<void>;

	// Assertions
	assert: {
		fileExists(path: string): Promise<void>;
		fileNotExists(path: string): Promise<void>;
		fileContent(path: string, content: string): Promise<void>;
		fileHash(path: string, expectedHash: string): Promise<void>;
		diskEqualsCrdt(path: string): Promise<void>;
		noConflictCopies(dir?: string): Promise<void>;
	};
}

export interface QaScenario {
	id: string;
	title: string;
	tags: string[];
	requiredPlugins?: string[];

	/**
	 * Recording mode for the flight trace during this scenario.
	 * Separate from exportPrivacy — these are different concepts.
	 * "qa-safe" = record without filenames (default).
	 * "safe" = same redaction but standard mode.
	 * "full" = include filenames (requires explicit confirmation).
	 */
	traceRecordingMode?: "qa-safe" | "safe";

	/**
	 * Privacy level for the exported trace artifact.
	 * Defaults to "safe". Only set "full" if filenames are needed for RCA.
	 */
	traceExportPrivacy?: "safe" | "full";

	setup(ctx: QaContext): Promise<void>;
	run(ctx: QaContext): Promise<void>;
	assert(ctx: QaContext): Promise<void>;
	cleanup?(ctx: QaContext): Promise<void>;
}

// -----------------------------------------------------------------------
// Console API
// -----------------------------------------------------------------------

export interface TypingOptions {
	intervalMs?: number;
}

export interface QaConsoleApi {
	help(): void;
	scenarios(): string[];
	run(id: string, opts?: QaRunOptions): Promise<QaResult>;

	// Vault operations
	createFile(path: string, content: string): Promise<void>;
	modifyFile(path: string, content: string): Promise<void>;
	appendToFile(path: string, text: string): Promise<void>;
	deleteFile(path: string, mode?: DeleteMode): Promise<void>;
	renameFile(oldPath: string, newPath: string): Promise<void>;
	writeAdapterFile(path: string, content: string): Promise<void>;
	deleteAdapterFile(path: string): Promise<void>;

	// Editor operations
	openFile(path: string): Promise<void>;
	closeFile(path: string): Promise<void>;
	typeIntoFile(path: string, text: string, opts?: TypingOptions): Promise<void>;
	replaceFileContent(path: string, content: string): Promise<void>;
	runCommand(commandId: string): Promise<void>;

	// Wait
	waitForIdle(timeoutMs?: number): Promise<void>;
	waitForMemoryReceipt(timeoutMs?: number): Promise<void>;
	waitForFile(path: string, timeoutMs?: number): Promise<void>;
	/** Wait until YAOS has seeded the file into CRDT. */
	waitForCrdtFile(path: string, timeoutMs?: number): Promise<void>;
	/** Wait until disk hash == CRDT hash. Use after modifyFile on existing files. */
	waitForDiskCrdtConverge(path: string, timeoutMs?: number): Promise<void>;
	/** Wait until a MarkdownView leaf is active. Does NOT prove CRDT binding. */
	waitForActiveMarkdownLeaf(path: string, timeoutMs?: number): Promise<void>;
	/** Wait until CRDT editor binding is fully healthy (leaf + ySyncFacet + Y.Text match). */
	waitForCrdtBinding(path: string, timeoutMs?: number): Promise<void>;

	// Assertions
	assertFileExists(path: string): Promise<void>;
	assertFileNotExists(path: string): Promise<void>;
	assertFileHash(path: string, expectedHash: string): Promise<void>;
	assertDiskEqualsCrdt(path: string): Promise<void>;
	assertNoConflictCopies(dirPath?: string): Promise<void>;

	// Manifests
	manifest(): Promise<VaultManifest>;
	compareManifest(expected: VaultManifest): Promise<ManifestDiff>;

	// Flight trace
	startTrace(recordingMode?: string, secret?: string): Promise<void>;
	stopTrace(): Promise<void>;
	/** Export the active trace. exportPrivacy is separate from recordingMode. */
	exportTrace(exportPrivacy?: "safe" | "full"): Promise<string>;
	analyzeTrace(tracePath: string, scenarioId?: string): Promise<unknown>;
	exportTraceWithAnalyzer(exportPrivacy?: "safe" | "full", scenarioId?: string): Promise<{ tracePath: string; report: unknown }>;

	// Plugin state
	plugins(): Array<{ id: string; version: string; enabled: boolean }>;
}
