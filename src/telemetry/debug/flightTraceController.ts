import type { App } from "obsidian";
import {
	appendTraceParams,
	type TraceEventDetails,
	type TraceHttpContext,
} from "../../observability/traceContext";
import { obsidianRequest } from "../../utils/http";
import type { VaultSyncSettings } from "../../settings";
import { FlightRecorder } from "./flightRecorder";
import {
	FLIGHT_EVENT_SCHEMA_VERSION,
	type FlightEventInput,
	type FlightPathEventInput,
} from "../../observability/flightEnvelope";
import { FLIGHT_KIND, FLIGHT_TAXONOMY_VERSION } from "../../observability/flightTaxonomy";
import type { FlightExportResult, TraceContext } from "./flightEvents";
import { PathIdentityResolver, deriveSaltFingerprint, deriveVaultPathSalt } from "./pathIdentity";
import { buildTraceHeader, type TraceHeaderStateInput } from "../diagnostics/diagnosticsBundle";
import { getOrCreateLocalDeviceId } from "../../sync/indexedDbCandidateStore";
import { randomId } from "../../utils/randomId";
import { sha256TextHex } from "../../utils/sha256";
import { formatUnknown } from "../../utils/format";

export type FlightTraceDeps = {
	app: App;
	getSettings(): VaultSyncSettings;
	getPluginVersion(): string;
	getDocSchemaVersion(): number | null;
	buildCheckpoint(): Promise<Record<string, unknown>>;
	/** Point-in-time world state for the export header; null if sync is down. */
	collectTraceHeaderInput(): Promise<TraceHeaderStateInput | null>;
	isIndexedDbRelatedError(error: unknown): boolean;
	isObsidianFileMetadataRaceError(error: unknown): boolean;
	handleIndexedDbDegraded(source: string, error?: unknown): void;
	/** Injectable to make startup cancellation deterministic and keep IDB ownership at the boundary. */
	getLocalDeviceId?(): Promise<string>;
	log(message: string): void;
};

const RUNTIME_TICK_MS = 5_000;
const SERVER_TRACE_TICKS = 3;
const CHECKPOINT_DEBOUNCE_MS = 250;

/**
 * The recorder always runs in "safe" mode: raw vault paths, the server URL,
 * the vault id and the device name never reach the on-disk log. Whether an
 * *export* reveals filenames is decided per export, and only ever by adding a
 * pathId directory to the header — never by rewriting the event lines.
 */
const RECORDING_MODE = "safe" as const;

/**
 * Canonicalize a server host URL to its origin for stable hashing.
 * Falls back to the raw string if URL parsing fails.
 */
function canonicalizeHost(host: string): string {
	try {
		return new URL(host).origin;
	} catch {
		return host;
	}
}

const SENSITIVE_TRACE_DETAIL_KEY = /path|host|token|vault|device|filename|content/i;

function sanitizeTraceText(value: string, settings: VaultSyncSettings): string {
	let safe = value;
	for (const secret of [
		settings.host,
		settings.token ?? "",
		settings.vaultId,
		settings.deviceName,
	].filter(Boolean)) {
		safe = safe.split(secret).join("[redacted]");
	}
	return safe
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(token|authorization|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/(?:https?|wss?):\/\/\S+/gi, "[redacted-url]")
		.replace(/\S*[\\/]\S*/g, "[redacted-path]")
		.replace(/\b[\w.-]+\.(?:[cm]?[jt]sx?|md)(?::\d+(?::\d+)?)?/gi, "[redacted-file]")
		.slice(0, 2_048);
}

function sanitizeTraceDetails(
	details: TraceEventDetails,
	settings: VaultSyncSettings,
): Record<string, unknown> {
	const sanitizeValue = (value: unknown): unknown => {
		if (value === null || typeof value === "number" || typeof value === "boolean") return value;
		if (typeof value === "string") return sanitizeTraceText(value, settings);
		if (Array.isArray(value)) return value.map(sanitizeValue);
		if (typeof value !== "object") return undefined;
		const safe: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			if (SENSITIVE_TRACE_DETAIL_KEY.test(key)) continue;
			const sanitized = sanitizeValue(nested);
			if (sanitized !== undefined) safe[key] = sanitized;
		}
		return safe;
	};
	return sanitizeValue(details) as Record<string, unknown>;
}

function describeCrash(
	reason: unknown,
	location?: { file?: string; line?: number; column?: number },
): TraceEventDetails {
	const value = reason && typeof reason === "object"
		? reason as { name?: unknown; message?: unknown; stack?: unknown }
		: null;
	const details: TraceEventDetails = {};
	if (typeof value?.name === "string" && value.name) details.name = value.name;
	if (typeof value?.message === "string" && value.message) {
		details.message = value.message;
	} else if (typeof reason === "string" && reason) {
		details.message = reason;
	} else if (reason !== undefined && reason !== null) {
		details.message = formatUnknown(reason);
	}
	if (typeof value?.stack === "string" && value.stack) details.stack = value.stack;
	if (location?.file) details.file = "[redacted-file]";
	if (typeof location?.line === "number") details.line = location.line;
	if (typeof location?.column === "number") details.column = location.column;
	return details;
}

/**
 * Debug tracing is diagnostic-only: its setup must never own product
 * availability. Keeping this boundary explicit also makes the onload contract
 * independently testable without constructing the full plugin.
 */
export async function setupFlightTraceBestEffort(
	setupAndStart: () => Promise<void>,
	reportFailure: (error: unknown) => void,
): Promise<void> {
	try {
		await setupAndStart();
	} catch (error) {
		try {
			reportFailure(error);
		} catch {
			// A diagnostic reporter is diagnostic too; it cannot regain
			// ownership of product availability.
		}
	}
}

export class FlightTraceController {
	private recorder: FlightRecorder | null = null;
	private pathIdentity: PathIdentityResolver | null = null;
	private runtimeInterval: number | null = null;
	private checkpointDebounceTimer: number | null = null;
	private runtimeTicks = 0;
	private checkpointInFlight = false;
	private serverInFlight = false;
	private recentServerTrace: unknown[] = [];
	private lastMetadataRaceRejectionAt = 0;
	private errorHandler: ((event: ErrorEvent) => void) | null = null;
	private rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
	private enabled = false;
	private desiredEnabled = false;
	private lifecycleGeneration = 0;
	private lifecycleChain: Promise<void> = Promise.resolve();
	private activeTransition: {
		desired: boolean;
		generation: number;
		promise: Promise<void>;
	} | null = null;
	private pathSalt: string | null = null;
	private saltFingerprint: string | null = null;

	/** Pending recordPath() promises — stop/flush drains these before shutdown. */
	private pendingPathPromises = new Set<Promise<void>>();

	constructor(private readonly deps: FlightTraceDeps) {}

	get isEnabled(): boolean {
		return this.enabled;
	}

	get currentRecorder(): FlightRecorder | null {
		return this.recorder;
	}

	get context(): TraceContext | null {
		return this.recorder?.context ?? null;
	}

	get httpContext(): TraceHttpContext | undefined {
		const context = this.recorder?.context;
		if (!context) return undefined;
		const settings = this.deps.getSettings();
		return {
			traceId: context.traceId,
			bootId: context.bootId,
			deviceName: settings.deviceName || "unknown-device",
			vaultId: settings.vaultId || "unknown-vault",
		};
	}

	getRecentServerTrace(): readonly unknown[] {
		return this.recentServerTrace;
	}

	/** Current seq counter (last assigned seq). Used for causedByEvents linkage. */
	get currentSeq(): number {
		return this.recorder?.currentSeq ?? 0;
	}

	/**
	 * Shareable fingerprint of the vault-scoped path pseudonymization salt.
	 * Two devices configured against the same vault report the same value and
	 * their traces can be merged; null while no trace is running.
	 */
	get pathSaltFingerprint(): string | null {
		return this.saltFingerprint;
	}

	start(): Promise<void> {
		if (!this.deps.getSettings().debug) return this.requestLifecycle(false);
		return this.requestLifecycle(true);
	}

	/**
	 * The whole lifecycle. `debug` is the only switch: on records, off does not.
	 */
	refreshFromSettings(reason: string): Promise<void> {
		if (!this.deps.getSettings().debug) return this.requestLifecycle(false);
		const wasEnabled = this.enabled;
		const transition = this.requestLifecycle(true);
		if (wasEnabled) return transition;
		return transition.then(() => {
			if (this.enabled) this.deps.log(`Debug trace recording started (${reason})`);
		});
	}

	stop(): Promise<void> {
		return this.requestLifecycle(false);
	}

	private requestLifecycle(desired: boolean): Promise<void> {
		if (this.activeTransition?.desired === desired) {
			return this.activeTransition.promise;
		}
		if (
			this.desiredEnabled === desired
			&& !this.activeTransition
			&& ((desired && this.enabled) || (!desired && !this.enabled && !this.recorder))
		) {
			return this.lifecycleChain;
		}

		this.desiredEnabled = desired;
		const generation = ++this.lifecycleGeneration;
		const transition = this.lifecycleChain.then(() =>
			desired ? this.performStart(generation) : this.performStop());
		this.activeTransition = { desired, generation, promise: transition };
		this.lifecycleChain = transition.catch(() => undefined);
		void transition.then(
			() => this.finishTransition(desired, generation),
			() => this.finishTransition(desired, generation),
		);
		return transition;
	}

	private finishTransition(desired: boolean, generation: number): void {
		if (this.activeTransition?.generation === generation) {
			this.activeTransition = null;
		}
		if (
			desired
			&& generation === this.lifecycleGeneration
			&& !this.enabled
		) {
			// A missing configuration or failed start is retryable on the next
			// settings refresh; do not leave the desired state falsely satisfied.
			this.desiredEnabled = false;
		}
	}

	private async performStart(generation: number): Promise<void> {
		if (this.enabled) return;
		const settings = this.deps.getSettings();
		const vaultId = settings.vaultId.trim();
		const host = settings.host;
		if (!settings.debug || !vaultId || !host) return;

		const [vaultIdHash, serverHostHash, deviceId, pathSalt] = await Promise.all([
			sha256TextHex(vaultId),
			sha256TextHex(canonicalizeHost(host)),
			(this.deps.getLocalDeviceId?.() ?? getOrCreateLocalDeviceId())
				.catch(() => `ephemeral-${randomId(14)}`),
			deriveVaultPathSalt(sha256TextHex, vaultId),
		]);
		const saltFingerprint = await deriveSaltFingerprint(sha256TextHex, pathSalt);
		const currentSettings = this.deps.getSettings();
		if (
			generation !== this.lifecycleGeneration
			|| !this.desiredEnabled
			|| !currentSettings.debug
			|| currentSettings.vaultId.trim() !== vaultId
			|| currentSettings.host !== host
		) return;

		const recorder = new FlightRecorder(this.deps.app, {
			mode: RECORDING_MODE,
			deviceId,
			vaultIdHash,
			serverHostHash,
			pluginVersion: this.deps.getPluginVersion(),
			docSchemaVersion: this.deps.getDocSchemaVersion() ?? undefined,
		});
		this.recorder = recorder;
		this.pathIdentity = new PathIdentityResolver(sha256TextHex, { salt: pathSalt });
		this.pathSalt = pathSalt;
		this.saltFingerprint = saltFingerprint;
		this.enabled = true;
		try {
			this.startRuntimeComposition();
			this.record({
				priority: "important",
				kind: FLIGHT_KIND.debugTraceStarted,
				severity: "info",
				scope: "diagnostics",
				source: "diagnostics",
				layer: "diagnostics",
				data: { mode: RECORDING_MODE },
			});
			this.recordTrace("trace", "trace-session-start", {
				enableAttachmentSync: currentSettings.enableAttachmentSync,
				externalEditPolicy: currentSettings.externalEditPolicy,
			});
			this.scheduleCheckpoint("plugin-load");
		} catch (error) {
			this.enabled = false;
			this.stopRuntimeComposition();
			this.recorder = null;
			this.pathIdentity = null;
			this.pathSalt = null;
			this.saltFingerprint = null;
			await recorder.shutdown().catch(() => undefined);
			throw error;
		}
	}

	private async performStop(): Promise<void> {
		const recorder = this.recorder;
		if (this.enabled && recorder) {
			this.record({
				priority: "important",
				kind: FLIGHT_KIND.debugTraceStopped,
				severity: "info",
				scope: "diagnostics",
				source: "diagnostics",
				layer: "diagnostics",
				data: { mode: RECORDING_MODE },
			});
		}
		this.enabled = false;
		this.stopRuntimeComposition();
		if (this.pendingPathPromises.size > 0) {
			await Promise.allSettled([...this.pendingPathPromises]);
			this.pendingPathPromises.clear();
		}
		this.recentServerTrace = [];
		this.lastMetadataRaceRejectionAt = 0;
		if (this.recorder === recorder) {
			this.recorder = null;
			this.pathIdentity = null;
			this.pathSalt = null;
			this.saltFingerprint = null;
		}
		await recorder?.shutdown();
	}

	record(event: FlightEventInput): void {
		if (!this.enabled) return;
		this.recorder?.record(event);
	}

	recordTrace(source: string, message: string, details?: TraceEventDetails): void {
		if (!this.enabled) return;
		this.recordRuntimeEvent(source, message, details, "info");
	}

	scheduleCheckpoint(reason: string): void {
		if (!this.enabled || !this.recorder) return;
		if (this.checkpointDebounceTimer !== null) {
			window.clearTimeout(this.checkpointDebounceTimer);
		}
		this.checkpointDebounceTimer = window.setTimeout(() => {
			this.checkpointDebounceTimer = null;
			void this.emitCheckpoint(reason);
		}, CHECKPOINT_DEBOUNCE_MS);
	}

	async refreshServerTrace(): Promise<void> {
		await this.fetchServerTrace();
	}

	/**
	 * Record a path-scoped event. Returns a Promise that resolves after the
	 * event has been written to the pending queue (path identity resolved).
	 * Callers on the hot path may fire-and-forget; flush() drains all pending
	 * promises before reading the session file.
	 */
	recordPath(event: FlightPathEventInput): Promise<void> {
		if (!this.enabled) return Promise.resolve();
		const p = this.resolveAndRecord(event);
		this.pendingPathPromises.add(p);
		void p.finally(() => this.pendingPathPromises.delete(p));
		return p;
	}

	/**
	 * Reserve a seq and record a path-scoped event, returning the reserved seq.
	 * Use this when the caller needs the seq for causedByEvents linkage.
	 * The seq is reserved synchronously before any async work.
	 */
	reserveAndRecordPath(event: FlightPathEventInput): number {
		if (!this.enabled) return 0;
		const seq = this.recorder?.reserveSeq() ?? 0;
		const p = this.resolveAndRecordWithSeq(event, seq);
		this.pendingPathPromises.add(p);
		void p.finally(() => this.pendingPathPromises.delete(p));
		return seq;
	}

	/**
	 * Flush: drain all pending path-identity promises, then flush the recorder.
	 * Must be called before reading the session file for export.
	 */
	async flush(): Promise<void> {
		if (this.pendingPathPromises.size > 0) {
			await Promise.allSettled([...this.pendingPathPromises]);
			this.pendingPathPromises.clear();
		}
		await this.recorder?.flushNow();
		// Drain the write chain too.
		// FlightRecorder.flushNow() already chains onto writeChain; awaiting it
		// is sufficient — no extra handle needed here.
	}

	async getPathId(path: string): Promise<{ pathId: string }> {
		if (!this.pathIdentity) {
			return { pathId: "p:unavailable" };
		}
		return await this.pathIdentity.getPathIdentity(path);
	}

	/**
	 * Delete all flight log files.
	 * If a trace is active, stops it first.
	 */
	async clearLogs(): Promise<void> {
		if (this.enabled || this.recorder || this.activeTransition) {
			await this.stop();
		}
		await clearFlightLogs(this.deps.app);
	}

	// -----------------------------------------------------------------------
	// Export
	// -----------------------------------------------------------------------

	/**
	 * Export the current trace session as one NDJSON file: a self-describing
	 * header line stating what world the trace was recorded in, followed by the
	 * recorded events in causal `seq` order.
	 *
	 * `includeFilenames` defaults to false. The redacted export is the one a
	 * user can hand to a stranger; the unredacted one additionally carries the
	 * pathId → vault path directory and the server URL, vault id and device name.
	 */
	async exportTrace(options: {
		diagDir: string;
		includeFilenames?: boolean;
	}): Promise<FlightExportResult> {
		const includeFilenames = options.includeFilenames ?? false;
		if (!this.enabled || !this.recorder) {
			return { ok: false, reason: "trace-not-active" };
		}

		const recorder = this.recorder;

		// Structural mode checks.
		if (!recorder.exportable) {
			return { ok: false, reason: "trace-not-exportable" };
		}
		// Flush before reading: the user is told to export, never to stop first.
		try {
			await this.flush();
		} catch {
			return { ok: false, reason: "flush-failed" };
		}
		// Per-export redaction only rewrites the header. A recorder that wrote
		// raw paths into its event lines can never produce a redacted export.
		if (!includeFilenames && !recorder.safeToShare) {
			return { ok: false, reason: "trace-unsafe-for-safe-export" };
		}

		let combinedContent = "";
		let segmentCount = 0;
		try {
			const segments = await recorder.getAllSessionSegmentPaths();
			for (const segPath of segments) {
				try {
					combinedContent += await this.deps.app.vault.adapter.read(segPath);
					segmentCount++;
				} catch {
					// Segment might have been cleaned up by retention — skip
				}
			}
		} catch {
			return { ok: false, reason: "write-failed" };
		}

		if (!combinedContent && segmentCount === 0) {
			return { ok: false, reason: "write-failed" };
		}

		const state = await this.deps.collectTraceHeaderInput().catch((err: unknown) => {
			this.deps.log(`debug trace export: header state unavailable: ${String(err)}`);
			return null;
		});
		// Every path the header will name must already have a pseudonym, so the
		// header's file lists join against the event lines by pathId.
		if (state && this.pathIdentity) {
			await this.pathIdentity.prime([...state.diskHashes.keys(), ...state.crdtHashes.keys()]);
		}

		const { header, leakDetected } = await buildTraceHeader(
			{
				state,
				trace: {
					traceId: recorder.context.traceId,
					bootId: recorder.currentBootId,
					deviceId: recorder.context.deviceId,
					vaultIdHash: recorder.context.vaultIdHash,
					serverHostHash: recorder.context.serverHostHash,
					pluginVersion: recorder.context.pluginVersion,
					flightEventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
					flightEventTaxonomyVersion: FLIGHT_TAXONOMY_VERSION,
					exportedAt: new Date().toISOString(),
					eventCount: combinedContent.split("\n").filter(Boolean).length,
					segmentCount,
					segmentsRotated: segmentCount > 1,
					pathIdentityDegraded: recorder.pathIdentityDegraded,
					droppedEventCount: recorder.redactionStats.droppedCount,
					droppedEventCountByKind: recorder.redactionStats.droppedByKind,
					pathPseudonymSaltFingerprint: this.saltFingerprint,
					pathDirectory: this.pathIdentity?.directory() ?? [],
				},
			},
			// Same salt as the recorder's pseudonyms: paths the redactor catches
			// inside free-form text land in the same namespace as the event lines.
			{ redacted: !includeFilenames, salt: this.pathSalt ?? undefined },
		);

		if (leakDetected) {
			this.deps.log("debug trace export: a vault path survived redaction, export refused");
			return { ok: false, reason: "trace-unsafe-for-safe-export" };
		}

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const variant = includeFilenames ? "with-filenames" : "redacted";
		const outPath = `${options.diagDir}/debug-trace-${variant}-${stamp}.ndjson`;

		try {
			await this.deps.app.vault.adapter.write(
				outPath,
				`${JSON.stringify(header)}\n${combinedContent}`,
			);
			return { ok: true, path: outPath, includesFilenames: includeFilenames };
		} catch {
			return { ok: false, reason: "write-failed" };
		}
	}

	// -----------------------------------------------------------------------
	// Private
	// -----------------------------------------------------------------------

	private async resolveAndRecord(event: FlightPathEventInput): Promise<void> {
		// Reserve seq synchronously so causal order is preserved regardless of
		// async path identity resolution time.
		const reservedSeq = this.recorder?.reserveSeq();
		await this._resolveAndRecordCore(event, reservedSeq);
	}

	private async resolveAndRecordWithSeq(event: FlightPathEventInput, reservedSeq: number): Promise<void> {
		await this._resolveAndRecordCore(event, reservedSeq);
	}

	private async _resolveAndRecordCore(event: FlightPathEventInput, reservedSeq: number | undefined): Promise<void> {
		const identity = await this.getPathId(event.path);
		const { path: _removedPath, ...rest } = event;
		this.recorder?.record({ ...rest, pathId: identity.pathId }, { reservedSeq });
		// Emit path.identity.degraded if the resolver fell back to FNV.
		if (this.pathIdentity?.hasDegraded) {
			this.recorder?.markPathIdentityDegraded();
			this.record({
				priority: "critical",
				kind: FLIGHT_KIND.pathIdentityDegraded,
				severity: "error",
				scope: "diagnostics",
				source: "traceRuntime",
				layer: "diagnostics",
				data: { affectedPath: identity.pathId },
			});
		}
	}

	private startRuntimeComposition(): void {
		// Defensive even though lifecycle transitions are serialized: a future
		// restart cannot orphan an older listener set.
		this.stopRuntimeComposition();
		this.runtimeInterval = window.setInterval(() => {
			this.runtimeTicks++;
			this.scheduleCheckpoint("interval");
			if (this.runtimeTicks % SERVER_TRACE_TICKS === 0) void this.fetchServerTrace();
		}, RUNTIME_TICK_MS);
		this.errorHandler = (event: ErrorEvent): void => {
			const error: unknown = event.error ?? event.message;
			const details = describeCrash(error, {
				file: event.filename,
				line: event.lineno,
				column: event.colno,
			});
			if (this.deps.isIndexedDbRelatedError(error)) {
				this.recordCrashEvent("window-error-indexeddb", details);
				this.deps.handleIndexedDbDegraded("window-error", error);
				this.scheduleCheckpoint("window-error-indexeddb");
				event.preventDefault();
				return;
			}
			this.recordCrashEvent("window-error", details);
			this.scheduleCheckpoint("window-error");
		};
		this.rejectionHandler = (event: PromiseRejectionEvent): void => {
			const details = describeCrash(event.reason);
			if (this.deps.isIndexedDbRelatedError(event.reason)) {
				this.recordCrashEvent("unhandled-rejection-indexeddb", details);
				this.deps.handleIndexedDbDegraded("unhandled-rejection", event.reason);
				this.scheduleCheckpoint("unhandled-rejection-indexeddb");
				event.preventDefault();
				return;
			}
			if (this.deps.isObsidianFileMetadataRaceError(event.reason)) {
				const now = Date.now();
				if (now - this.lastMetadataRaceRejectionAt >= RUNTIME_TICK_MS) {
					this.lastMetadataRaceRejectionAt = now;
					this.recordCrashEvent("unhandled-rejection-file-metadata-race", details);
					this.scheduleCheckpoint("unhandled-rejection-file-metadata-race");
				}
				event.preventDefault();
				return;
			}
			this.recordCrashEvent("unhandled-rejection", details);
			this.scheduleCheckpoint("unhandled-rejection");
		};
		if (typeof window.addEventListener === "function") {
			window.addEventListener("error", this.errorHandler);
			window.addEventListener("unhandledrejection", this.rejectionHandler);
		}
	}

	private stopRuntimeComposition(): void {
		if (this.checkpointDebounceTimer !== null) {
			window.clearTimeout(this.checkpointDebounceTimer);
			this.checkpointDebounceTimer = null;
		}
		if (this.runtimeInterval !== null) {
			window.clearInterval(this.runtimeInterval);
			this.runtimeInterval = null;
		}
		if (this.errorHandler) {
			if (typeof window.removeEventListener === "function") {
				window.removeEventListener("error", this.errorHandler);
			}
			this.errorHandler = null;
		}
		if (this.rejectionHandler) {
			if (typeof window.removeEventListener === "function") {
				window.removeEventListener("unhandledrejection", this.rejectionHandler);
			}
			this.rejectionHandler = null;
		}
		this.runtimeTicks = 0;
	}

	private recordRuntimeEvent(
		source: string,
		message: string,
		details: TraceEventDetails | undefined,
		severity: "info" | "error",
	): void {
		if (!this.recorder) return;
		const event = /^[a-z0-9][a-z0-9_.:-]*$/i.test(message) ? message.slice(0, 160) : "free-form-message";
		const safeSource = /^[a-z0-9_.:-]+$/i.test(source) ? source.slice(0, 80) : "unknown-source";
		const safeDetails = details ? sanitizeTraceDetails(details, this.deps.getSettings()) : undefined;
		this.recorder.record({
			priority: severity === "error" ? "critical" : "verbose",
			kind: FLIGHT_KIND.debugTraceEvent,
			severity,
			scope: "diagnostics",
			source: "traceRuntime",
			layer: "diagnostics",
			data: {
				source: safeSource,
				event,
				...(safeDetails && Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {}),
			},
		});
	}

	private recordCrashEvent(message: string, details: TraceEventDetails): void {
		this.recordRuntimeEvent("trace", message, details, "error");
		const recorder = this.recorder;
		if (!recorder) return;
		// Window crash callbacks cannot await, but starting the recorder's write
		// chain here makes the critical event durable without waiting for the
		// normal one-second buffer timer.
		void recorder.flushNow().catch(() => {
			this.deps.log("debug trace crash evidence could not be flushed");
		});
	}

	private async emitCheckpoint(reason: string): Promise<void> {
		const recorder = this.recorder;
		if (!this.enabled || !this.desiredEnabled || !recorder || this.checkpointInFlight) return;
		this.checkpointInFlight = true;
		try {
			const state = await this.deps.buildCheckpoint();
			if (
				this.enabled
				&& this.desiredEnabled
				&& recorder === this.recorder
			) {
				recorder.record({
					priority: "important",
					kind: FLIGHT_KIND.debugTraceCheckpoint,
					severity: "info",
					scope: "diagnostics",
					source: "diagnostics",
					layer: "diagnostics",
					data: { reason, state },
				});
			}
		} catch {
			if (this.enabled && recorder === this.recorder) {
				this.recordRuntimeEvent("trace", "checkpoint-build-failed", undefined, "error");
			}
		} finally {
			this.checkpointInFlight = false;
		}
	}

	private async fetchServerTrace(): Promise<void> {
		const recorder = this.recorder;
		if (!this.enabled || !this.desiredEnabled || !recorder || this.serverInFlight) return;
		const settings = this.deps.getSettings();
		if (!settings.debug || !settings.host || !settings.token || !settings.vaultId) return;
		this.serverInFlight = true;
		try {
			const host = settings.host.replace(/\/$/, "");
			const roomId = settings.vaultId;
			const url = appendTraceParams(`${host}/vault/${encodeURIComponent(roomId)}/debug/recent`, this.httpContext);
			const response = await obsidianRequest({
				url,
				method: "GET",
				headers: { Authorization: `Bearer ${settings.token}` },
			});
			if (response.status !== 200) throw new Error(`server debug fetch failed (${response.status})`);
			const payload = response.json as { recent?: unknown[]; roomId?: unknown };
			if (typeof payload.roomId === "string" && payload.roomId !== roomId) {
				throw new Error("server debug fetch returned a mismatched room");
			}
			if (
				!this.enabled
				|| !this.desiredEnabled
				|| recorder !== this.recorder
				|| !this.deps.getSettings().debug
			) return;
			this.recentServerTrace = Array.isArray(payload.recent) ? payload.recent.slice(-120) : [];
			this.scheduleCheckpoint("server-trace-refresh");
		} catch {
			if (this.enabled && recorder === this.recorder) {
				this.recordRuntimeEvent("trace", "server-trace-fetch-failed", undefined, "error");
			}
		} finally {
			this.serverInFlight = false;
		}
	}
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Clear all flight log files. Pure filesystem helper — no recorder, settings,
 * or vaultId required. The logs directory is deterministic.
 */
export async function clearFlightLogs(app: App): Promise<void> {
	const root = `${app.vault.configDir}/plugins/yaos/flight-logs`;
	try {
		const exists = await app.vault.adapter.exists(root);
		if (!exists) return;
		const listing = await app.vault.adapter.list(root);
		for (const filePath of listing.files) {
			try { await app.vault.adapter.remove(filePath); } catch { /* skip */ }
		}
		for (const dir of listing.folders) {
			await deleteDirectoryRecursive(app, dir);
		}
		// Try to remove the root itself
		try { await app.vault.adapter.rmdir(root, false); } catch { /* ok */ }
	} catch { /* nothing to clear */ }
}

async function deleteDirectoryRecursive(app: App, dir: string): Promise<void> {
	try {
		const listing = await app.vault.adapter.list(dir);
		for (const filePath of listing.files) {
			try { await app.vault.adapter.remove(filePath); } catch { /* skip */ }
		}
		for (const subDir of listing.folders) {
			await deleteDirectoryRecursive(app, subDir);
		}
		try { await app.vault.adapter.rmdir(dir, false); } catch { /* ok */ }
	} catch { /* skip */ }
}
