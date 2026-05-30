/**
 * YAOS QA Debug API — Puppeteer harness (qa/harness/)
 *
 * Exposes a narrow, deterministic control surface for the QA harness.
 * Only registered when settings.qaDebugMode is true.
 * NEVER enable in production vaults.
 *
 * This file lives in qa/harness/ and is NOT compiled into main.js or
 * telemetry.js. It is used by the Puppeteer harness and dev tooling only.
 *
 * The API surface is conceptually split into two ports:
 *   - YaosDebugPort: safe, read-only or non-mutating debug capabilities
 *   - YaosUnsafeQaPort: scenario control and unsafe mutation
 */

import type { App, MarkdownView } from "obsidian";
import { Notice } from "obsidian";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { ConnectionController } from "../../src/runtime/connectionController";
import type { FlightTraceController } from "../../src/telemetry/debug/flightTraceController";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { FLIGHT_KIND } from "../../src/telemetry/debug/flightEvents";
import { yTextToString } from "../../src/utils/format";
import { forceReplaceYText } from "../../src/sync/diff";

/**
 * Health report for the CRDT editor binding on a given path.
 * Returned by getEditorBindingHealth(path).
 */
export interface EditorBindingHealth {
	/** A MarkdownView leaf for this path is open in the workspace. */
	leafOpen: boolean;
	/** The leaf has an active EditorBinding registered in EditorBindingManager. */
	bound: boolean;
	/** The CM6 y-codemirror ySyncFacet is configured on the editor. */
	hasSyncFacet: boolean;
	/** The ySyncFacet's Y.Text is the same object as the CRDT Y.Text for this path. */
	yTextMatchesExpected: boolean | null;
	/** No known binding issues (bound + hasSyncFacet + yTextMatchesExpected). */
	healthy: boolean;
	/** Binding is settling (CM6 compartment update in progress — not yet unhealthy). */
	settling: boolean;
	/** Diagnostic issue tokens from the binding health check. */
	issues: string[];
}

export interface ReceiptSnapshot {
	/** Opaque ID of the current unconfirmed candidate. Null if none. */
	candidateId: string | null;
	/** Timestamp (ms) when the current candidate was captured. Null if no candidate. */
	capturedAt: number | null;
	/** ID of the last candidate that the server confirmed. Null if never confirmed. */
	lastConfirmedCandidateId: string | null;
	/** Timestamp (ms) of the last confirmed server receipt echo. Null if never confirmed. */
	lastConfirmedAt: number | null;
}

export interface YaosQaDebugApi {
	// Readiness
	isLocalReady(): boolean;
	isProviderSynced(): boolean;
	isProviderConnected(): boolean;
	isReconciled(): boolean;
	isReconcileInFlight(): boolean;

	// Provider control — for real offline simulation in QA scenarios
	disconnectProvider(reason?: string): void;
	connectProvider(reason?: string): void;
	/**
	 * Hard offline hold: blocks ALL reconnect paths (visibility handler, network
	 * handler, reconnect timer, manual reconnect) until explicitly released.
	 * Use this instead of disconnectProvider() for reliable offline simulation.
	 */
	setQaNetworkHold(mode: "offline" | "online"): void;

	// Wait helpers (resolve when condition true, reject on timeout)
	waitForLocalReady(timeoutMs: number): Promise<void>;
	waitForProviderSynced(timeoutMs: number): Promise<void>;
	waitForProviderDisconnected(timeoutMs: number): Promise<void>;
	waitForReconciled(timeoutMs: number): Promise<void>;
	/** local ready + provider synced + reconciled + no reconcile in flight */
	waitForIdle(timeoutMs: number): Promise<void>;
	/**
	 * Waits for a server receipt that was confirmed AFTER `afterTimestamp`.
	 * Use this instead of the global `waitForMemoryReceipt()` to avoid
	 * false-passes from stale confirmations.
	 */
	waitForReceiptAfter(afterTimestamp: number, timeoutMs: number): Promise<void>;
	/** Snapshot the current receipt state for action-relative waiting. */
	getReceiptSnapshot(): ReceiptSnapshot;
	/** @deprecated Use waitForReceiptAfter(timestamp). This checks global state and can give false-passes. */
	waitForMemoryReceipt(timeoutMs: number): Promise<void>;
	/** File appears in the vault (disk) */
	waitForFile(path: string, timeoutMs: number): Promise<void>;

	// Content hashes (SHA-256 hex)
	getDiskHash(path: string): Promise<string | null>;
	getCrdtHash(path: string): Promise<string | null>;
	getEditorHash(path: string): Promise<string | null>;

	/**
	 * QA-ONLY. Unsafe. Do not call in production code.
	 *
	 * Forces CRDT Y.Text content for a path to an arbitrary value.
	 * originClass "local" = treated as a local repair (DiskMirror will not
	 * echo it back to disk). "remote" = treated as a remote write (DiskMirror
	 * WILL write it to disk — use only if that is the intended behaviour).
	 *
	 * Returns hashes before and after so the caller can assert divergence.
	 */
	__qaOnlyForceCrdtContentUnsafe(
		path: string,
		content: string,
		opts: { originClass: "local" | "remote"; createIfMissing?: boolean },
	): Promise<{ beforeHash: string | null; afterHash: string | null; fileExisted: boolean }>;

	// Path sets
	getActiveMarkdownPaths(): string[];
	getDiskMarkdownPaths(): string[];

	/**
	 * Returns the CRDT editor binding health for a given path.
	 * Use this to verify that y-codemirror is fully bound and the CRDT Y.Text
	 * matches the expected text — not just that a Markdown leaf is open.
	 *
	 * Prefer waitForCrdtBinding() in the harness when you need to wait for healthy.
	 */
	getEditorBindingHealth(path: string): EditorBindingHealth;

	// Status
	getServerReceiptState(): "confirmed" | "pending" | "unknown" | "no-candidate";
	getConnectionState(): string;

	// Flight trace
	startFlightTrace(mode: string, secret?: string): Promise<void>;
	stopFlightTrace(): Promise<void>;
	exportFlightTrace(privacy: "safe" | "full"): Promise<string>;

	// Force operations
	forceReconcile(): Promise<void>;
	forceReconnect(): void;
	/**
	 * QA-ONLY. Unsafe. Do not call in production code.
	 *
	 * Directly invokes syncFileFromDisk for a path. Deterministically
	 * exercises the editor-bound recovery code path without waiting for
	 * a real filesystem event. Use ONLY in forced-recovery regression
	 * scenarios — NOT as a substitute for natural event-pipeline tests.
	 */
	__qaOnlyForceSyncFileFromDiskUnsafe(path: string, reason?: "create" | "modify"): Promise<void>;

	/** QA-ONLY. Unsafe. Pause editor->CRDT propagation for a bound path. */
	__qaOnlyPauseEditorBindingPropagationUnsafe(path: string): Promise<boolean>;
	/** QA-ONLY. Unsafe. Resume editor->CRDT propagation for a bound path. */
	__qaOnlyResumeEditorBindingPropagationUnsafe(path: string): Promise<boolean>;

	/**
	 * QA-ONLY. Unsafe.
	 *
	 * Emits a qa.phase flight event marking the start of a scenario lifecycle
	 * phase (setup/run/assert/cleanup). Analyzers use these markers to scope
	 * their assertions — e.g. tombstones after "cleanup" are expected.
	 */
	__qaOnlyEmitPhaseUnsafe(phase: "setup" | "run" | "assert" | "cleanup"): Promise<void>;

	/**
	 * Wait for a NEW device.witness.settled event for a path emitted AFTER
	 * this call begins. Pre-existing settled events in the buffer are ignored.
	 *
	 * This is NOT a current-state check. It proves that the device freshly
	 * converged after the call was made. If the device already settled before
	 * this call, trigger a new dirty event first (e.g. via markDirty or a
	 * real file operation) so the tracker re-evaluates.
	 *
	 * Rejects if:
	 *   - no active flight trace (reason: no_active_trace)
	 *   - both expectedContent and expectedStateHash provided (reason: usage_error)
	 *   - a device.witness.diverged event arrives after wait start
	 *   - timeoutMs elapses without a matching settled event
	 */
	witnessDeviceSettled(
		path: string,
		options: {
			expectedContent?: string;
			expectedStateHash?: string;
			timeoutMs: number;
		},
	): Promise<void>;

	/**
	 * Compute the witness-domain stateHash for a given content string.
	 * Uses the active trace's salt. Rejects if no trace is active.
	 */
	computeWitnessStateHash(content: string): Promise<string>;

	/**
	 * Phase 2: Get the stable local deviceId for this device.
	 * Constant for the duration of the active flight trace session.
	 */
	getDeviceId(): string;

	/**
	 * Phase 2+3: Get active trace identity for cross-device trace verification.
	 * Returns null if no trace is active.
	 * qaTraceSecretHash is SHA-256("yaos-qa-trace-secret:" + qaTraceSecret).
	 * hasQaTraceSecret is false when no qaTraceSecret is set.
	 * scenarioRunId/scenarioId are null when not set via Set scenario run ID command.
	 */
	getActiveTraceInfo(): {
		localTraceId: string;
		/** @deprecated use localTraceId */
		traceId: string;
		qaTraceSecretHash: string;
		deviceId: string;
		hasQaTraceSecret: boolean;
		scenarioRunId: string | null;
		scenarioId: string | null;
	} | null;

	/**
	 * Phase 2: Get the current runtime state for mobile-background detection.
	 */
	getRuntimeState(): "foreground" | "background" | "suspended" | "unknown";

	/**
	 * Phase 2: Read the in-memory witness buffer (for cross-device primitives).
	 * Returns undefined if no tracker is active.
	 */
	getWitnessBuffer?(): ReadonlyArray<import("../../src/telemetry/diagnostics/deviceWitnessTracker").WitnessBufferEntry> | undefined;

	/**
	 * Phase 2: Current local witness seq (for seq-anchoring in cross-device primitives).
	 */
	currentWitnessSeq?(): number;

	/**
	 * Phase 2: Read witness checkpoint segments for a traceId through this device's
	 * QA debug API. The desktop controller calls this once per device with that
	 * device's handle — devices never read each other's filesystem (Requirement 26).
	 */
	readWitnessCheckpoint?(traceId: string): Promise<{
		segments: Array<{ index: number; content: string }>;
		deviceId: string;
		status: "ok" | "tracker_inactive" | "trace_not_found";
	}>;

	/**
	 * Phase 2: Export in-memory witness segments as a single NDJSON string.
	 * Use this for manual mobile/desktop export when CDP is not available.
	 * Returns null if no tracker is active or no segments exist.
	 */
	exportWitnessSegments?(traceId: string): string | null;

	/**
	 * QA-ONLY. Unsafe. Clear witness suppression for a path so the tracker
	 * re-emits a settled event on the next markDirty even if content is unchanged.
	 * Use before triggering dirty in witnessQuorum setup.
	 */
	__qaOnlyClearWitnessSuppressionUnsafe?(path: string): void;

	/**
	 * QA-ONLY. Unsafe. Trigger a witness dirty event for a path.
	 * Use after clearing suppression to force re-evaluation.
	 */
	__qaOnlyTriggerWitnessDirtyUnsafe?(path: string): void;

	/**
	 * Phase 3: Set the cross-device scenario run identity.
	 * Must be called before any witness event is emitted under the run.
	 * No-op if no flight trace is active.
	 */
	__qaOnlySetScenarioRunIdUnsafe?(scenarioRunId: string, scenarioId: string): void;

	/**
	 * Phase 3: Advance the scenario step index.
	 * stepIndex must be a non-negative integer strictly greater than the current step.
	 * Requires scenarioRunId to be set first.
	 * Emits a qa.scenario.step flight event.
	 * No-op if no flight trace is active.
	 */
	__qaOnlyAdvanceScenarioStepUnsafe?(stepIndex: number, label?: string): void;

	/**
	 * QA-ONLY. Unsafe.
	 *
	 * Sets an in-memory-only external edit policy override.
	 * Does NOT persist to settings, does NOT push update metadata.
	 * Pass null to clear and revert to the real setting.
	 * Returns the previous effective policy.
	 */
	__qaOnlySetExternalEditPolicyOverrideUnsafe(
		policy: "always" | "closed-only" | "never" | null,
	): Promise<{ previous: "always" | "closed-only" | "never" }>;
}

// -----------------------------------------------------------------------
// Compile-time port assignability checks.
// These ensure YaosQaDebugApi is assignable to both YaosDebugPort and
// YaosUnsafeQaPort. If any method signature drifts, this file will fail
// to compile with a clear type error showing the incompatibility.
// -----------------------------------------------------------------------
import type { YaosDebugPort } from "../../src/telemetry/debug/ports/yaosDebugPort";
import type { YaosUnsafeQaPort } from "./ports/yaosUnsafeQaPort";

// Full assignability checks — not just method names, but full signatures.
// If YaosQaDebugApi is not assignable to a port, the compiler will show
// exactly which methods have incompatible signatures.
type _AssertDebugPortAssignable = YaosQaDebugApi extends YaosDebugPort ? true : never;
type _AssertUnsafePortAssignable = YaosQaDebugApi extends YaosUnsafeQaPort ? true : never;

// These assignments will fail to compile if the types are not assignable.
const _debugPortCheck: _AssertDebugPortAssignable = true;
const _unsafePortCheck: _AssertUnsafePortAssignable = true;
void _debugPortCheck; void _unsafePortCheck;

// -----------------------------------------------------------------------
// Plugin interface — only the properties we actually touch
// -----------------------------------------------------------------------

interface PluginHandle {
	app: App;
	getVaultSync(): VaultSync | null;
	getReconciliationController(): ReconciliationController;
	getConnectionController(): ConnectionController | null;
	getFlightTraceController(): FlightTraceController | null;
	getEditorBindings(): EditorBindingManager | null;
	getDiagnosticsDir(): Promise<string | undefined> | undefined;
	sha256Hex(text: string): Promise<string>;
	startQaFlightTrace(mode?: string): Promise<void>;
	stopQaFlightTrace(): Promise<void>;
	exportFlightTrace(privacy: "safe" | "full"): Promise<string | null>;
	runReconciliation(): Promise<void>;
	disconnectProvider(reason?: string): void;
	connectProvider(reason?: string): void;
	getDeviceWitnessTracker?(): import("../../src/telemetry/diagnostics/deviceWitnessTracker").DeviceWitnessTracker | null;
	/** Scenario state controller (Puppeteer-owned). */
	getScenarioController?(): import("./scenarioStateController").ScenarioStateController | null;
	/** SHA-256 hash of the active qaTraceSecret, computed at trace start. */
	getQaTraceSecretHash?(): string | null;
	/** Engine control port — present when Puppeteer harness is active. */
	getEngineControlPort(): import("../../src/runtime/engineControlPort").EngineControlPort;
}

// -----------------------------------------------------------------------
// Internal poll helper
// -----------------------------------------------------------------------

function waitFor(
	predicate: () => boolean,
	intervalMs: number,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (predicate()) {
			resolve();
			return;
		}
		const start = Date.now();
		const timer = setInterval(() => {
			if (predicate()) {
				clearInterval(timer);
				resolve();
				return;
			}
			if (Date.now() - start >= timeoutMs) {
				clearInterval(timer);
				reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
			}
		}, intervalMs);
	});
}

// -----------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------

export function buildQaDebugApi(plugin: PluginHandle): YaosQaDebugApi {
	const { app } = plugin;
	const POLL_INTERVAL = 250;

	async function sha256(text: string): Promise<string> {
		return plugin.sha256Hex(text);
	}

	const api: YaosQaDebugApi = {
		// -- Readiness ----------------------------------------------------------

		isLocalReady(): boolean {
			return plugin.getVaultSync()?.localReady ?? false;
		},

		isProviderSynced(): boolean {
			return plugin.getVaultSync()?.providerSynced ?? false;
		},

		isProviderConnected(): boolean {
			return plugin.getVaultSync()?.connected ?? false;
		},

		disconnectProvider(reason?: string): void {
			plugin.disconnectProvider(reason ?? "qa-disconnect");
		},

		connectProvider(reason?: string): void {
			plugin.connectProvider(reason ?? "qa-connect");
		},

		setQaNetworkHold(mode: "offline" | "online"): void {
			plugin.getConnectionController()?.setQaNetworkHold(mode);
		},

		isReconciled(): boolean {
			return plugin.getReconciliationController().isReconciled;
		},

		isReconcileInFlight(): boolean {
			return plugin.getReconciliationController().isReconcileInFlight;
		},

		// -- Wait helpers -------------------------------------------------------

		waitForLocalReady(timeoutMs): Promise<void> {
			return waitFor(() => api.isLocalReady(), POLL_INTERVAL, timeoutMs);
		},

		waitForProviderSynced(timeoutMs): Promise<void> {
			return waitFor(() => api.isProviderSynced(), POLL_INTERVAL, timeoutMs);
		},

		waitForProviderDisconnected(timeoutMs): Promise<void> {
			return waitFor(() => !api.isProviderConnected(), POLL_INTERVAL, timeoutMs);
		},

		waitForReconciled(timeoutMs): Promise<void> {
			return waitFor(() => api.isReconciled(), POLL_INTERVAL, timeoutMs);
		},

		waitForIdle(timeoutMs): Promise<void> {
			return waitFor(
				() =>
					api.isLocalReady() &&
					api.isProviderSynced() &&
					api.isReconciled() &&
					!api.isReconcileInFlight(),
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		getReceiptSnapshot(): ReceiptSnapshot {
			const vs = plugin.getVaultSync();
			return {
				candidateId: vs?.serverReceiptCandidateId ?? null,
				capturedAt: vs?.serverReceiptCandidateCapturedAt ?? null,
				lastConfirmedCandidateId: vs?.lastConfirmedReceiptCandidateId ?? null,
				lastConfirmedAt: vs?.lastKnownServerReceiptEchoAt ?? null,
			};
		},

		waitForReceiptAfter(afterTimestamp: number, timeoutMs: number): Promise<void> {
			return waitFor(
				() => {
					const vs = plugin.getVaultSync();
					if (!vs) return false;
					const capturedAt = vs.serverReceiptCandidateCapturedAt;
					const confirmedId = vs.lastConfirmedReceiptCandidateId;
					const candidateId = vs.serverReceiptCandidateId;
					const confirmedAt = vs.lastKnownServerReceiptEchoAt;

					// A candidate must have been captured AFTER the action.
					// That same candidate (by ID) must then be confirmed.
					if (capturedAt !== null && capturedAt > afterTimestamp) {
						if (confirmedId !== null && confirmedId === candidateId) {
							return true;
						}
					}

					// Fallback: if no pending candidate but confirmed timestamp is recent,
					// the server already processed everything before we could observe the ID.
					if (confirmedAt !== null && confirmedAt > afterTimestamp) {
						return true;
					}

					return false;
				},
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		waitForMemoryReceipt(timeoutMs): Promise<void> {
			return waitFor(
				() => plugin.getVaultSync()?.serverAppliedLocalState === true,
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		waitForFile(path, timeoutMs): Promise<void> {
			return waitFor(
				() => app.vault.getAbstractFileByPath(path) !== null,
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		// -- Content hashes -----------------------------------------------------

		async getDiskHash(path): Promise<string | null> {
			const file = app.vault.getFileByPath(path);
			if (!file) return null;
			try {
				const content = await app.vault.read(file);
				return sha256(content);
			} catch {
				return null;
			}
		},

		async getCrdtHash(path): Promise<string | null> {
			const vaultSync = plugin.getVaultSync();
			if (!vaultSync) return null;
			const text = vaultSync.getTextForPath(path);
			if (!text) return null;
			const content = yTextToString(text);
			if (content === null) return null;
			return sha256(content);
		},

		async getEditorHash(path): Promise<string | null> {
			let content: string | null = null;
			app.workspace.iterateAllLeaves((leaf) => {
				if (content !== null) return;
				const view = leaf.view as unknown as { file?: { path?: string }; editor?: { getValue?: () => string } };
				if (view?.file?.path === path && typeof view.editor?.getValue === "function") {
					content = view.editor.getValue();
				}
			});
			if (content === null) return null;
			return sha256(content);
		},

		async __qaOnlyForceCrdtContentUnsafe(
			path: string,
			content: string,
			opts: { originClass: "local" | "remote"; createIfMissing?: boolean },
		): Promise<{ beforeHash: string | null; afterHash: string | null; fileExisted: boolean }> {
			const vaultSync = plugin.getVaultSync();
			if (!vaultSync) return { beforeHash: null, afterHash: null, fileExisted: false };

			const existingText = vaultSync.getTextForPath(path);
			const fileExisted = existingText !== null;

			if (!fileExisted && !opts.createIfMissing) {
				return { beforeHash: null, afterHash: null, fileExisted: false };
			}

			const ytext = existingText ?? vaultSync.ensureFile(path, content, "qa");
			if (!ytext) return { beforeHash: null, afterHash: null, fileExisted };

			// Compute before hash from current Y.Text content.
			const beforeContent = yTextToString(ytext);
			const beforeHash = beforeContent !== null ? await sha256(beforeContent) : null;

			// "local" origin = in LOCAL_STRING_ORIGIN_SET → DiskMirror ignores it.
			// "remote" origin = provider-like string not in set → DiskMirror writes to disk.
			// We use the provider object itself for remote to guarantee correct routing.
			const origin = opts.originClass === "local"
				? "disk-sync"          // a known local origin
				: (vaultSync.provider as unknown); // provider object = remote origin

			forceReplaceYText(ytext, content, origin as string);

			const afterContent = yTextToString(ytext);
			const afterHash = afterContent !== null ? await sha256(afterContent) : null;
			return { beforeHash, afterHash, fileExisted };
		},

		// -- Path sets ----------------------------------------------------------

		getActiveMarkdownPaths(): string[] {
			return plugin.getVaultSync()?.getActiveMarkdownPaths() ?? [];
		},

		getDiskMarkdownPaths(): string[] {
			return app.vault.getMarkdownFiles().map((f) => f.path);
		},

		getEditorBindingHealth(path: string): EditorBindingHealth {
			const editorBindings = plugin.getEditorBindings();

			// Find a MarkdownView leaf for this path.
			let targetView: MarkdownView | null = null;
			app.workspace.iterateAllLeaves((leaf) => {
				if (targetView) return;
				const view = leaf.view as unknown as { file?: { path?: string } };
				if (view?.file?.path === path) {
					targetView = leaf.view as unknown as MarkdownView;
				}
			});

			if (!targetView) {
				return {
					leafOpen: false,
					bound: false,
					hasSyncFacet: false,
					yTextMatchesExpected: null,
					healthy: false,
					settling: false,
					issues: ["no-leaf"],
				};
			}

			if (!editorBindings) {
				return {
					leafOpen: true,
					bound: false,
					hasSyncFacet: false,
					yTextMatchesExpected: null,
					healthy: false,
					settling: false,
					issues: ["bindings-unavailable"],
				};
			}

			const health = editorBindings.getBindingHealthForView(targetView);
			const collab = editorBindings.getCollabDebugInfoForView(targetView);

			return {
				leafOpen: true,
				bound: health.bound,
				hasSyncFacet: collab?.hasSyncFacet ?? false,
				yTextMatchesExpected: collab?.yTextMatchesExpected ?? null,
				// Require all three to be affirmatively true.
				// null/unknown is NOT treated as healthy — it means the binding
				// state has not fully settled and the caller should wait longer.
				healthy:
					health.healthy === true &&
					(collab?.hasSyncFacet ?? false) === true &&
					collab?.yTextMatchesExpected === true,
				settling: health.settling,
				issues: health.issues,
			};
		},

		// -- Status -------------------------------------------------------------

		getServerReceiptState(): "confirmed" | "pending" | "unknown" | "no-candidate" {
			const vaultSync = plugin.getVaultSync();
			if (!vaultSync) return "no-candidate";
			const state = vaultSync.serverAppliedLocalState;
			if (state === true) return "confirmed";
			if (state === false) return "pending";
			return "no-candidate";
		},

		getConnectionState(): string {
			return plugin.getConnectionController()?.getState().kind ?? "disconnected";
		},

		// -- Flight trace -------------------------------------------------------

		async startFlightTrace(mode, secret): Promise<void> {
			// If a secret is provided, update settings before starting the trace
			if (secret) {
				const p = plugin as unknown as { settings?: { qaTraceSecret?: string }; saveData?: (d: unknown) => Promise<void> };
				if (p.settings) {
					p.settings.qaTraceSecret = secret;
					await p.saveData?.(p.settings);
				}
			}
			await plugin.startQaFlightTrace(mode);
		},

		async stopFlightTrace(): Promise<void> {
			await plugin.stopQaFlightTrace();
		},

		async exportFlightTrace(privacy): Promise<string> {
			const path = await plugin.exportFlightTrace(privacy);
			if (!path) throw new Error("Flight trace export failed — check that a trace is active");
			return path;
		},

		// -- Force operations ---------------------------------------------------

		async forceReconcile(): Promise<void> {
			await plugin.runReconciliation();
		},

		forceReconnect(): void {
			plugin.getConnectionController()?.reconnect("qa-force-reconnect");
		},

		async ingestDiskFileNow(path: string, reason: "create" | "modify" = "modify"): Promise<void> {
			await plugin.getEngineControlPort().ingestDiskFileNow(path, reason);
		},
		async pauseEditorPropagation(path: string): Promise<boolean> {
			return plugin.getEngineControlPort().pauseEditorPropagation(path);
		},
		async resumeEditorPropagation(path: string): Promise<boolean> {
			return plugin.getEngineControlPort().resumeEditorPropagation(path);
		},
		async setExternalEditPolicyOverride(
			policy: "always" | "closed-only" | "never" | null,
		): Promise<{ previous: "always" | "closed-only" | "never" }> {
			const previous = plugin.getEngineControlPort().setExternalEditPolicyOverride(policy);
			return { previous };
		},
		async __qaOnlyEmitPhaseUnsafe(phase: "setup" | "run" | "assert" | "cleanup"): Promise<void> {
			plugin.getFlightTraceController()?.record({
				priority: "important",
				kind: FLIGHT_KIND.qaPhase,
				severity: "info",
				scope: "diagnostics",
				source: "diagnostics",
				layer: "diagnostics",
				data: { phase },
			});
		},

		async witnessDeviceSettled(
			path: string,
			options: {
				expectedContent?: string;
				expectedStateHash?: string;
				timeoutMs: number;
			},
		): Promise<void> {
			if (options.expectedContent !== undefined && options.expectedStateHash !== undefined) {
				throw Object.assign(new Error("witnessDeviceSettled: provide expectedContent OR expectedStateHash, not both"), { reason: "usage_error" });
			}
			const tracker = plugin.getDeviceWitnessTracker?.();
			if (!tracker) {
				throw Object.assign(new Error("witnessDeviceSettled: no active flight trace"), { reason: "no_active_trace" });
			}

			let expectedHash: string | undefined = options.expectedStateHash;
			if (options.expectedContent !== undefined) {
				expectedHash = await tracker.computeWitnessStateHash(options.expectedContent);
			}

			// Anchor: only consider events emitted after this call begins.
			const startSeq = tracker.currentWitnessSeq();
			const startTime = Date.now();

			return new Promise((resolve, reject) => {
				const check = () => {
					const buf = tracker.getWitnessBuffer();
					// Only consider events after startSeq.
					for (const e of buf) {
						if (e.seq <= startSeq) continue;
						if (e.path !== path) continue;
						if (e.kind === "diverged") {
							reject(Object.assign(
								new Error(`witnessDeviceSettled: diverged for ${path}: ${e.data.reason}`),
								{ reason: e.data.reason, data: e.data },
							));
							return;
						}
						if (e.kind === "settled") {
							if (expectedHash === undefined || e.data.stateHash === expectedHash) {
								resolve();
								return;
							}
						}
					}
					if (Date.now() - startTime >= options.timeoutMs) {
						// Collect last known observation data after startSeq.
						const last = [...buf].reverse().find((e) => e.path === path && e.seq > startSeq);
						reject(Object.assign(new Error(`witnessDeviceSettled: timeout for ${path}`), {
							reason: "timeout",
							lastObserved: last?.data ?? null,
						}));
						return;
					}
					setTimeout(check, 250);
				};
				check();
			});
		},

		async computeWitnessStateHash(content: string): Promise<string> {
			const tracker = plugin.getDeviceWitnessTracker?.();
			if (!tracker) throw Object.assign(new Error("computeWitnessStateHash: no active flight trace"), { reason: "no_active_trace" });
			return tracker.computeWitnessStateHash(content);
		},

		getDeviceId(): string {
			// deviceId is the stable local UUID from the active flight trace context
			const ftc = plugin.getFlightTraceController();
			return ftc?.context?.deviceId ?? "unknown";
		},

		getActiveTraceInfo() {
			const ftc = plugin.getFlightTraceController();
			const ctx = ftc?.context;
			if (!ctx) return null;
			const qaTraceSecretHash = plugin.getQaTraceSecretHash?.();
			const scenarioCtrl = plugin.getScenarioController?.();
			const scenarioState = scenarioCtrl?.getScenarioStepState();
			const hash = qaTraceSecretHash ?? "";
			const hasQaTraceSecret = hash.startsWith("sha256:");
			return {
				localTraceId: ctx.traceId,
				traceId: ctx.traceId, // backward compat
				qaTraceSecretHash: hash,
				deviceId: ctx.deviceId,
				hasQaTraceSecret,
				scenarioRunId: scenarioState?.scenarioRunId ?? null,
				scenarioId: scenarioState?.scenarioId ?? null,
			};
		},

		getRuntimeState(): "foreground" | "background" | "suspended" | "unknown" {
			const tracker = plugin.getDeviceWitnessTracker?.();
			if (!tracker) return "unknown";
			return tracker.getRuntimeState();
		},

		getWitnessBuffer() {
			return plugin.getDeviceWitnessTracker?.()?.getWitnessBuffer();
		},

		currentWitnessSeq() {
			return plugin.getDeviceWitnessTracker?.()?.currentWitnessSeq() ?? 0;
		},

		__qaOnlyClearWitnessSuppressionUnsafe(path: string): void {
			plugin.getDeviceWitnessTracker?.()?.clearSuppressionForPath(path);
		},

		__qaOnlyTriggerWitnessDirtyUnsafe(path: string): void {
			plugin.getDeviceWitnessTracker?.()?.markDirty(path, "disk-write");
		},

		async readWitnessCheckpoint(traceId: string) {
			const deviceId = api.getDeviceId();
			const tracker = plugin.getDeviceWitnessTracker?.();
			if (!tracker) {
				return { segments: [], deviceId, status: "tracker_inactive" as const };
			}
			// Read from in-memory witness segment buffer (no filesystem)
			const segments = tracker.getCheckpointSegments();
			const filtered = segments.filter((seg) => {
				const firstLine = seg.content.split("\n")[0];
				if (!firstLine) return false;
				try {
					const header = JSON.parse(firstLine) as Record<string, unknown>;
					return header.traceId === traceId;
				} catch {
					return false;
				}
			});
			return {
				segments: filtered,
				deviceId,
				status: filtered.length > 0 ? "ok" as const : "trace_not_found" as const,
			};
		},

		exportWitnessSegments(traceId: string): string | null {
			const tracker = plugin.getDeviceWitnessTracker?.();
			if (!tracker) return null;
			const segments = tracker.getCheckpointSegments().filter((seg) => {
				const firstLine = seg.content.split("\n")[0];
				if (!firstLine) return false;
				try {
					const header = JSON.parse(firstLine) as Record<string, unknown>;
					return header.traceId === traceId;
				} catch { return false; }
			});
			if (segments.length === 0) return null;
			return segments.map((s) => s.content).join("");
		},

		__qaOnlySetScenarioRunIdUnsafe(scenarioRunId: string, scenarioId: string): void {
			plugin.getScenarioController?.()?.setScenarioRunId(scenarioRunId, scenarioId);
		},

		__qaOnlyAdvanceScenarioStepUnsafe(stepIndex: number, label?: string): void {
			const scenarioCtrl = plugin.getScenarioController?.();
			if (!scenarioCtrl) return;
			const state = scenarioCtrl.getScenarioStepState();
			if (!state.scenarioRunId) {
				new Notice("set scenarioRunId via 'YAOS QA: Set scenario run ID' first");
				return;
			}
			if (!Number.isInteger(stepIndex) || stepIndex < 0) {
				new Notice(`scenarioStepIndex must be a non-negative integer, got: ${stepIndex}`);
				return;
			}
			if (state.stepIndex !== null && stepIndex <= state.stepIndex) {
				new Notice(`scenarioStepIndex must be strictly greater than current (${state.stepIndex}), got: ${stepIndex}`);
				return;
			}
			const ok = scenarioCtrl.advanceScenarioStep(stepIndex, label);
			if (!ok) return;
			// Emit qa.scenario.step flight event
			plugin.getFlightTraceController()?.record({
				priority: "important",
				kind: FLIGHT_KIND.qaScenarioStep,
				severity: "info",
				scope: "diagnostics",
				source: "diagnostics",
				layer: "diagnostics",
				mono: performance.now(),
				data: {
					scenarioRunId: state.scenarioRunId,
					scenarioId: state.scenarioId,
					scenarioStepIndex: stepIndex,
					stepLabel: label,
					deviceId: api.getDeviceId(),
					monotonicMs: performance.now(),
					enteredAt: new Date().toISOString(),
				},
			});
		},
	};

	return api;
}
