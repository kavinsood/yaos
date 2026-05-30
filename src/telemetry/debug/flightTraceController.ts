import type { App } from "obsidian";
import { randomBase64Url } from "../../utils/base64url";
import type { VaultSyncSettings } from "../../settings";
import { FlightRecorder, type FlightRecorderOptions } from "./flightRecorder";
import {
	FLIGHT_KIND,
	FLIGHT_EVENT_SCHEMA_VERSION,
	FLIGHT_TAXONOMY_VERSION,
	type FlightEvent,
	type FlightEventInput,
	type FlightExportResult,
	type FlightMode,
	type FlightPathEventInput,
	type TraceContext,
} from "./flightEvents";
import type { ProductFlightPathEventInput } from "../../observability/traceSink";
import { PathIdentityResolver } from "./pathIdentity";
import { sha256Hex, getOrCreateLocalDeviceId } from "../../sync/indexedDbCandidateStore";

/**
 * Looser input type that accepts both FlightPathEventInput and ProductFlightPathEventInput.
 * The controller normalizes priority (defaults to "important") and validates at runtime.
 */
type AnyPathEventInput = ProductFlightPathEventInput | FlightPathEventInput;

type QaTraceState = {
	enabled: boolean;
	mode: FlightMode;
	qaTraceSecret: string | null;
	/** True if the trace was started via the manual command (not from settings). */
	manualStart: boolean;
};

export type FlightTraceDeps = {
	app: App;
	getSettings(): VaultSyncSettings;
	getPluginVersion(): string;
	getDocSchemaVersion(): number | null;
	buildCheckpoint(): Promise<Record<string, unknown>>;
	registerCleanup(cleanup: () => void): void;
	log(message: string): void;
};

const DEFAULT_CHECKPOINT_MS = 30_000;

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

/**
 * Canonicalize a vaultId for stable hashing.
 */
function canonicalizeVaultId(vaultId: string): string {
	return vaultId.trim();
}

export class FlightTraceController {
	private recorder: FlightRecorder | null = null;
	private pathIdentity: PathIdentityResolver | null = null;
	private checkpointTimer: ReturnType<typeof setInterval> | null = null;
	private state: QaTraceState = {
		enabled: false,
		mode: "safe",
		qaTraceSecret: null,
		manualStart: false,
	};

	/** Pending recordPath() promises — flush() drains these before reading. */
	private pendingPathPromises = new Set<Promise<void>>();

	constructor(private readonly deps: FlightTraceDeps) {}

	get isEnabled(): boolean {
		return this.state.enabled;
	}

	get currentRecorder(): FlightRecorder | null {
		return this.recorder;
	}

	get context(): TraceContext | null {
		return this.recorder?.context ?? null;
	}

	/** Current seq counter (last assigned seq). Used for causedByEvents linkage. */
	get currentSeq(): number {
		return this.recorder?.currentSeq ?? 0;
	}

	/**
	 * Start a trace. If called from the manual command, manualStart=true so
	 * that refreshFromSettings() will not stop it on the next settings save.
	 */
	async start(
		mode: FlightMode,
		qaTraceSecret?: string | null,
		options: { manualStart?: boolean } = {},
	): Promise<void> {
		if (this.state.enabled) return;
		const settings = this.deps.getSettings();
		if (!settings.vaultId || !settings.host) return;

		const [vaultIdHash, serverHostHash, deviceId] = await Promise.all([
			sha256Hex(canonicalizeVaultId(settings.vaultId)),
			sha256Hex(canonicalizeHost(settings.host)),
			getOrCreateLocalDeviceId(),
		]);
		const recorderOptions: FlightRecorderOptions = {
			mode,
			deviceId,
			vaultIdHash,
			serverHostHash,
			pluginVersion: this.deps.getPluginVersion(),
			docSchemaVersion: this.deps.getDocSchemaVersion() ?? undefined,
		};
		this.recorder = new FlightRecorder(this.deps.app, recorderOptions);
		this.pathIdentity = new PathIdentityResolver(sha256Hex, {
			mode,
			pathSecret: randomBase64Url(16),
			qaTraceSecret: qaTraceSecret ?? null,
		});
		this.state = {
			enabled: true,
			mode,
			qaTraceSecret: qaTraceSecret ?? null,
			manualStart: options.manualStart ?? false,
		};
		this.startCheckpointLoop();
		this.record({
			priority: "important",
			kind: FLIGHT_KIND.qaTraceStarted,
			severity: "info",
			scope: "diagnostics",
			source: "diagnostics",
			layer: "diagnostics",
			data: {
				mode,
				manualStart: this.state.manualStart,
			},
		});
		this.deps.registerCleanup(() => {
			void this.stop();
		});
	}

	/**
	 * Called from settings refresh. Only starts/stops settings-driven traces.
	 * Does NOT stop a manually-started trace.
	 */
	async refreshFromSettings(reason: string): Promise<void> {
		const settings = this.deps.getSettings();
		if (!settings.qaTraceEnabled) {
			// Stop only if this was a settings-driven trace (not a manual start).
			if (this.state.enabled && !this.state.manualStart) {
				await this.stop();
			}
			return;
		}
		if (this.state.enabled) return; // already running (manual or settings)
		// full and local-private modes must NOT auto-resume from settings.
		// They require explicit manual start each session for privacy safety.
		const mode = settings.qaTraceMode;
		if (mode === "full" || mode === "local-private") {
			this.deps.log(
				`QA flight recorder: ${mode} mode requires manual start (settings-driven auto-start refused)`,
			);
			return;
		}
		await this.start(mode, settings.qaTraceSecret || null, {
			manualStart: false,
		});
		this.deps.log(`QA flight recorder enabled (${reason}, mode=${mode})`);
	}

	async stop(): Promise<void> {
		if (!this.state.enabled) return;
		this.record({
			priority: "important",
			kind: FLIGHT_KIND.qaTraceStopped,
			severity: "info",
			scope: "diagnostics",
			source: "diagnostics",
			layer: "diagnostics",
			data: { mode: this.state.mode },
		});
		this.stopCheckpointLoop();
		await this.flush();
		await this.recorder?.shutdown();
		this.recorder = null;
		this.pathIdentity = null;
		this.state = { enabled: false, mode: "safe", qaTraceSecret: null, manualStart: false };
	}

	record(event: FlightEventInput): void {
		this.recorder?.record(event);
	}

	/**
	 * Record a path-scoped event. Returns a Promise that resolves after the
	 * event has been written to the pending queue (path identity resolved).
	 * Callers on the hot path may fire-and-forget; flush() drains all pending
	 * promises before reading the session file.
	 */
	recordPath(event: AnyPathEventInput): Promise<void> {
		const p = this.resolveAndRecord(event as FlightPathEventInput);
		this.pendingPathPromises.add(p);
		void p.finally(() => this.pendingPathPromises.delete(p));
		return p;
	}

	/**
	 * Reserve a seq and record a path-scoped event, returning the reserved seq.
	 * Use this when the caller needs the seq for causedByEvents linkage.
	 * The seq is reserved synchronously before any async work.
	 */
	reserveAndRecordPath(event: AnyPathEventInput): number {
		const seq = this.recorder?.reserveSeq() ?? 0;
		const p = this.resolveAndRecordWithSeq(event as FlightPathEventInput, seq);
		this.pendingPathPromises.add(p);
		void p.finally(() => this.pendingPathPromises.delete(p));
		return seq;
	}

	/** @deprecated Use recordPath(). Kept for backward compatibility. */
	recordPathEvent(event: FlightPathEventInput): void {
		void this.recordPath(event);
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

	async getPathId(path: string): Promise<{ pathId: string; path?: string }> {
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
		if (this.state.enabled) {
			await this.stop();
		}
		await clearFlightLogs(this.deps.app);
	}

	// -----------------------------------------------------------------------
	// Export
	// -----------------------------------------------------------------------

	/**
	 * Export the current trace session.
	 * Validates mode, flushes, writes manifest line, copies NDJSON.
	 */
	async exportTrace(options: {
		requestedPrivacy: "safe" | "full";
		diagDir: string;
	}): Promise<FlightExportResult> {
		if (!this.state.enabled || !this.recorder) {
			return { ok: false, reason: "trace-not-active" };
		}

		const recorder = this.recorder;

		// Structural mode checks.
		if (!recorder.exportable) {
			return { ok: false, reason: "trace-not-exportable" };
		}
		// Flush before reading.
		try {
			await this.flush();
		} catch {
			return { ok: false, reason: "flush-failed" };
		}
		if (options.requestedPrivacy === "safe" && !recorder.safeToShare) {
			return { ok: false, reason: "trace-unsafe-for-safe-export" };
		}

		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const modeLabel = this.state.mode;
		const outName = `flight-trace-${modeLabel}-${stamp}.ndjson`;
		const outPath = `${options.diagDir}/${outName}`;

		// Build manifest line (always first in the output file).
		// We read segments first so we can include the count in the manifest.
		let combinedContent = "";
		let segmentCount = 0;
		try {
			const segments = await recorder.getAllSessionSegmentPaths();
			for (const segPath of segments) {
				try {
					const segContent = await this.deps.app.vault.adapter.read(segPath);
					combinedContent += segContent;
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

		const manifest: FlightEvent = {
			eventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
			taxonomyVersion: FLIGHT_TAXONOMY_VERSION,
			ts: Date.now(),
			seq: 0, // manifest is not a recorded sequence event
			kind: FLIGHT_KIND.exportManifest,
			severity: "info",
			scope: "diagnostics",
			source: "traceRuntime",
			layer: "diagnostics",
			priority: "critical",
			traceId: recorder.context.traceId,
			bootId: recorder.context.bootId,
			deviceId: recorder.context.deviceId,
			vaultIdHash: recorder.context.vaultIdHash,
			serverHostHash: recorder.context.serverHostHash,
			pluginVersion: recorder.context.pluginVersion,
			data: {
				mode: this.state.mode,
				includesFilenames: recorder.includesFilenames,
				schemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
				taxonomyVersion: FLIGHT_TAXONOMY_VERSION,
				exportedAt: new Date().toISOString(),
				segmentCount,
				eventCount: combinedContent.split("\n").filter(Boolean).length,
				bootId: recorder.currentBootId,
				traceId: recorder.context.traceId,
				pathIdentityDegraded: recorder.pathIdentityDegraded,
				rotated: segmentCount > 1,
				redaction: recorder.redactionStats,
			},
		};
		const manifestLine = JSON.stringify(manifest) + "\n";

		try {
			await this.deps.app.vault.adapter.write(outPath, manifestLine + combinedContent);
			return {
				ok: true,
				path: outPath,
				includesFilenames: recorder.includesFilenames,
			};
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
		this.recorder?.record(
			{
				...rest,
				pathId: identity.pathId,
				// Include raw path only in full/local-private mode.
				...(identity.path !== undefined ? { path: identity.path } : {}),
			},
			{ reservedSeq },
		);
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

	private startCheckpointLoop(): void {
		if (this.checkpointTimer) return;
		this.checkpointTimer = setInterval(() => {
			void this.emitCheckpoint();
		}, DEFAULT_CHECKPOINT_MS);
	}

	private stopCheckpointLoop(): void {
		if (this.checkpointTimer) {
			clearInterval(this.checkpointTimer);
			this.checkpointTimer = null;
		}
	}

	private async emitCheckpoint(): Promise<void> {
		if (!this.recorder) return;
		const state = await this.deps.buildCheckpoint();
		this.recorder.record({
			priority: "important",
			kind: FLIGHT_KIND.qaCheckpoint,
			severity: "info",
			scope: "diagnostics",
			source: "diagnostics",
			layer: "diagnostics",
			data: { state },
		});
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

