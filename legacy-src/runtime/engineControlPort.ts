/**
 * EngineControlPort — type-only interface for QA harness Engine control.
 *
 * This file is type-only (no runtime code, fully erased at build time).
 * It lives in src/runtime/ so main.ts can reference it without importing from qa/.
 *
 * The concrete instance is assembled in main.ts as a private field.
 * The Puppeteer harness (qa/harness/) receives it through PluginHandle.getEngineControlPort().
 *
 * IMPORTANT: This interface must not appear in main.js or telemetry.js public
 * API surface. It is passed at runtime only through the Puppeteer harness path
 * (settings.qaDebugMode). Normal production users never receive it.
 *
 * Do not expose this through TelemetryRuntimeHost.
 * Do not mount on window. Do not ship as a product command.
 */

import type { ExternalEditPolicy } from "../settings";

export interface EngineControlPort {
	/** Trigger a deterministic disk→CRDT ingest for a single path. Bypasses the dirty queue. */
	ingestDiskFileNow(path: string, reason: "create" | "modify"): Promise<void>;
	/** Pause editor↔CRDT propagation for an open-and-bound path. Returns true if paused. */
	pauseEditorPropagation(path: string): boolean;
	/** Resume editor↔CRDT propagation for a previously paused path. Returns true if resumed. */
	resumeEditorPropagation(path: string): boolean;
	/** Set a transient in-memory external edit policy override (no persist, no settings save). Returns previous effective policy. */
	setExternalEditPolicyOverride(policy: ExternalEditPolicy | null): ExternalEditPolicy;
}

/**
 * Internal disk-ingest port registered by ReconciliationController during construction.
 * Stored in main.ts private state; never exposed publicly.
 */
export interface DiskIngestPort {
	ingestDiskFileNow(path: string, reason: "create" | "modify"): Promise<void>;
}
