/**
 * YAOS QA Debug API — desktop automation harness (qa/harness/)
 *
 * Exposes a narrow, deterministic control surface for the QA harness.
 * Only registered when settings.qaDebugMode is true.
 * NEVER enable in production vaults.
 *
 * This file lives in qa/harness/ and is NOT compiled into main.js or
 * telemetry.js. It is used by desktop automation and developer tooling only.
 *
 * The API surface is conceptually split into two ports:
 *   - YaosDebugPort: safe, read-only or non-mutating debug capabilities
 *   - YaosUnsafeQaPort: scenario control and unsafe mutation
 */

import { MarkdownView, type App } from "obsidian";
import type { VaultSync } from "../../src/sync/vaultSync";
import type { ReconciliationController } from "../../src/runtime/reconciliationController";
import type { ConnectionController } from "../../src/runtime/connectionController";
import type { FlightTraceController } from "../../src/telemetry/debug/flightTraceController";
import type { EditorBindingManager } from "../../src/sync/editorBinding";
import { FLIGHT_KIND } from "../../src/observability/flightTaxonomy";
import { yTextToString } from "../../src/utils/format";
import { forceReplaceYText } from "../../src/sync/diff";
import {
	isReceiptWaitReadyAfter,
	isReceiptWaitReadyAfterCheckpoint,
	type ReceiptWaitCheckpoint,
	type ReceiptWaitState,
} from "./receiptWaitReadiness";

export { isReceiptWaitReadyAfter, isReceiptWaitReadyAfterCheckpoint } from "./receiptWaitReadiness";
export type { ReceiptWaitCheckpoint, ReceiptWaitState } from "./receiptWaitReadiness";

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
	/** Opaque ID of the latest receipt candidate, retained after confirmation. */
	candidateId: string | null;
	/** Timestamp (ms) when the current candidate was captured. Null if no candidate. */
	capturedAt: number | null;
	/** ID of the last candidate that the server confirmed. Null if never confirmed. */
	lastConfirmedCandidateId: string | null;
	/** Timestamp (ms) of the last confirmed server receipt echo. Null if never confirmed. */
	lastConfirmedAt: number | null;
	/** Whether the current candidate still needs a matching server confirmation. */
	hasUnconfirmedCandidate: boolean;
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
	 * Waits until a receipt candidate captured strictly AFTER `afterTimestamp`
	 * is confirmed by matching candidate identity. This fails closed when the
	 * action did not produce an ack-tracked local candidate.
	 */
	waitForReceiptAfter(afterTimestamp: number, timeoutMs: number): Promise<void>;
	/** Snapshot the current receipt state for diagnostics. */
	getReceiptSnapshot(): ReceiptSnapshot;
	/**
	 * Capture an opaque receipt checkpoint immediately before an action that may
	 * confirm an already-pending candidate (such as reconnecting this device).
	 * This renderer-local API snapshots synchronously; transport adapters expose
	 * their own asynchronous bridge contract.
	 */
	captureReceiptCheckpoint(): ReceiptWaitCheckpoint;
	/**
	 * Wait for either the captured pending candidate's confirmation or a new
	 * post-checkpoint candidate's confirmation. Never accepts a candidate that
	 * was already confirmed when the checkpoint was captured.
	 */
	waitForReceiptAfterCheckpoint(
		checkpoint: ReceiptWaitCheckpoint,
		timeoutMs: number,
	): Promise<void>;
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

	// Flight trace. Recording is a pure function of the product's settings.debug,
	// which qa/scripts/prepare-vault-lib.ts sets to true — there is deliberately
	// no start/stop here, so a scenario cannot desynchronise from the recorder.
	exportFlightTrace(privacy: "safe" | "full"): Promise<string>;

	// Force operations
	forceReconcile(): Promise<void>;
	forceReconnect(): void;
	/**
	 * QA-ONLY. Unsafe. Do not call in production code.
	 *
	 * Triggers a deterministic disk→CRDT ingest for a single path, bypassing
	 * the dirty queue. Exercises the editor-bound recovery code path without
	 * waiting for a real filesystem event. Use ONLY in forced-recovery
	 * regression scenarios — NOT as a substitute for natural event-pipeline
	 * tests.
	 */
	ingestDiskFileNow(path: string, reason?: "create" | "modify"): Promise<void>;

	/** QA-ONLY. Unsafe. Pause editor↔CRDT propagation for a bound path. */
	pauseEditorPropagation(path: string): Promise<boolean>;
	/** QA-ONLY. Unsafe. Resume editor↔CRDT propagation for a bound path. */
	resumeEditorPropagation(path: string): Promise<boolean>;

	/**
	 * QA-ONLY. Unsafe.
	 *
	 * Emits a qa.phase flight event marking the start of a scenario lifecycle
	 * phase (setup/run/assert/cleanup). Analyzers use these markers to scope
	 * their assertions — e.g. tombstones after "cleanup" are expected.
	 */
	__qaOnlyEmitPhaseUnsafe(phase: "setup" | "run" | "assert" | "cleanup"): Promise<void>;

	/**
	 * Phase 2: Get the stable local deviceId for this device.
	 * Constant for the duration of the active flight trace session.
	 */
	getDeviceId(): string;

	/**
	 * Phase 2+3: Get active trace identity for cross-device trace verification.
	 * Returns null if no trace is active.
	 *
	 * pathSaltFingerprint is `sha256:<hex>` over the path-pseudonymisation salt,
	 * which is derived from settings.vaultId. Two devices in the same vault
	 * therefore report the same fingerprint and their pathIds correlate.
	 */
	getActiveTraceInfo(): {
		localTraceId: string;
		pathSaltFingerprint: string;
		deviceId: string;
	} | null;

	/**
	 * Phase 2: Get the current runtime state for mobile-background detection.
	 */
	getRuntimeState(): "foreground" | "background" | "suspended" | "unknown";

	/**
	 * QA-ONLY. Unsafe.
	 *
	 * Sets an in-memory-only external edit policy override.
	 * Does NOT persist to settings, does NOT push update metadata.
	 * Pass null to clear and revert to the real setting.
	 * Returns the previous effective policy.
	 */
	setExternalEditPolicyOverride(
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
	exportFlightTrace(privacy: "safe" | "full"): Promise<string | null>;
	runReconciliation(): Promise<void>;
	disconnectProvider(reason?: string): void;
	connectProvider(reason?: string): void;
	/** Fingerprint of the derived path salt, `sha256:<hex>`, or null when idle. */
	getPathSaltFingerprint(): string | null;
	/** Engine control port — present when the QA automation harness is active. */
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

function readReceiptWaitState(vaultSync: VaultSync | null): ReceiptWaitState | null {
	if (!vaultSync) return null;
	const receipt = vaultSync.getServerReceiptSnapshot();
	return {
		candidateId: receipt.candidateId,
		capturedAt: receipt.candidateCapturedAt,
		lastConfirmedCandidateId: receipt.lastConfirmedCandidateId,
		lastConfirmedAt: receipt.lastKnownServerReceiptEchoAt,
		hasUnconfirmedCandidate: receipt.hasUnconfirmedCandidate,
	};
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
			if (mode === "offline") {
				plugin.disconnectProvider("qa-network-hold-offline");
			} else {
				plugin.connectProvider("qa-network-hold-online");
			}
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
			const receipt = readReceiptWaitState(plugin.getVaultSync());
			return {
				candidateId: receipt?.candidateId ?? null,
				capturedAt: receipt?.capturedAt ?? null,
				lastConfirmedCandidateId: receipt?.lastConfirmedCandidateId ?? null,
				lastConfirmedAt: receipt?.lastConfirmedAt ?? null,
				hasUnconfirmedCandidate: receipt?.hasUnconfirmedCandidate ?? false,
			};
		},

		captureReceiptCheckpoint(): ReceiptWaitCheckpoint {
			const receipt = readReceiptWaitState(plugin.getVaultSync());
			return {
				checkpointAt: Date.now(),
				candidateId: receipt?.candidateId ?? null,
				candidateWasUnconfirmed: receipt?.hasUnconfirmedCandidate ?? false,
			};
		},

		waitForReceiptAfter(afterTimestamp: number, timeoutMs: number): Promise<void> {
			return waitFor(
				() => {
					const receipt = readReceiptWaitState(plugin.getVaultSync());
					return receipt !== null && isReceiptWaitReadyAfter(afterTimestamp, receipt);
				},
				POLL_INTERVAL,
				timeoutMs,
			);
		},

		waitForReceiptAfterCheckpoint(
			checkpoint: ReceiptWaitCheckpoint,
			timeoutMs: number,
		): Promise<void> {
			return waitFor(
				() => {
					const receipt = readReceiptWaitState(plugin.getVaultSync());
					return receipt !== null && isReceiptWaitReadyAfterCheckpoint(checkpoint, receipt);
				},
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
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file?.path === path) {
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
			// "remote" origin = an origin not in that set → DiskMirror writes to disk.
			// We use the provider object itself for remote to guarantee correct
			// routing. forceReplaceYText takes `origin: unknown` because a Yjs
			// transaction origin is compared by identity, never parsed.
			const origin = opts.originClass === "local"
				? "disk-sync"          // a known local origin
				: vaultSync.provider;  // provider object = remote origin

			forceReplaceYText(ytext, content, origin);

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
				const view = leaf.view;
				if (view instanceof MarkdownView && view.file?.path === path) {
					targetView = view;
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
			const state = vaultSync.getServerReceiptSnapshot().serverAppliedLocalState;
			if (state === true) return "confirmed";
			if (state === false) return "pending";
			return "no-candidate";
		},

		getConnectionState(): string {
			return plugin.getConnectionController()?.getState().kind ?? "disconnected";
		},

		// -- Flight trace -------------------------------------------------------
		//
		// No startFlightTrace/stopFlightTrace: the recorder follows settings.debug.

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

		getDeviceId(): string {
			// deviceId is the stable local UUID from the active flight trace context
			const ftc = plugin.getFlightTraceController();
			return ftc?.context?.deviceId ?? "unknown";
		},

		getActiveTraceInfo() {
			const ftc = plugin.getFlightTraceController();
			const ctx = ftc?.context;
			if (!ctx) return null;
			return {
				localTraceId: ctx.traceId,
				pathSaltFingerprint: plugin.getPathSaltFingerprint() ?? "",
				deviceId: ctx.deviceId,
			};
		},

		getRuntimeState(): "foreground" | "background" | "suspended" | "unknown" {
			const visibility = typeof document === "undefined" ? undefined : document.visibilityState;
			if (visibility === "visible") return "foreground";
			if (visibility === "hidden") return "background";
			return "unknown";
		},
	};

	return api;
}
