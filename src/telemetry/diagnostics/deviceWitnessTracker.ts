/**
 * DeviceWitnessTracker — Layer 4 Phase 1 + Phase 2
 *
 * A strictly read-only diagnostics module that emits `device.witness.settled`
 * and `device.witness.diverged` flight events after observing that a device's
 * CRDT, disk, and (when open and healthy) editor all agree on a single salted
 * content hash for a Markdown path across a stability window.
 *
 * Invariants:
 *   INV-OBS-01: observability cannot affect availability
 *   INV-OBS-02: bounded trace writes
 *   INV-SEC-02: no secrets or content leaks in safe modes
 *   INV-EDIT-01/02: no recovery-cycle disturbance
 *   INV-SAFETY-02: no self-write round-trip
 *
 * Hash construction: session-salted SHA-256 pseudonym (not HMAC).
 *   SHA-256(secret || "\0yaos-state-v1\0" || normalizedContent)
 * Normalization: Unicode NFC then \n line endings (Requirement 4.1).
 * Domain separator is intentionally distinct from PathIdentityResolver's "\0"
 * so path pseudonyms and content pseudonyms never share an input domain.
 * For qa-safe mode the shared qaTraceSecret is used so two devices in the
 * same QA run produce comparable hashes.
 *
 * Phase 2 additions:
 *   - causedByEvents seq linkage on every emitted witness event (Req 12)
 *   - runtimeState field on every emitted witness event (Req 19)
 *   - mobile-background guard: emits unavailable instead of settled/diverged (Req 19)
 *   - recoveryStateHash precision path for recovery_emitted_old_hash (Req 11)
 *   - checkpoint NDJSON export while flight trace active (Req 22-25)
 *   - Three new DivergenceReasons: checkpoint_write_failed, unavailable, checkpoint_path_inside_vault
 */

import { FLIGHT_KIND } from "../debug/flightEvents";
import type { FlightSink, TraceContext } from "../debug/flightEvents";
import {
	computeWitnessStateHash as _computeWitnessStateHash,
	computeDeletedWitnessStateHash,
} from "./witnessStateHash";

// -----------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------

export type StateKind = "present" | "deleted";

export type OriginClass =
	| "local-edit"
	| "local-repair"
	| "remote-apply"
	| "disk-write"
	| "recovery"
	| "conflict-artifact"
	| "tombstone"
	| "unknown";

export type EditorSampleKind = "not_open" | "healthy_sampled" | "settling" | "unhealthy";

export type DivergenceReason =
	| "disk_crdt_mismatch"
	| "editor_crdt_mismatch"
	| "stale_hash_after_newer_witness"
	| "recovery_emitted_old_hash"
	| "settle_timeout"
	| "read_failed"
	| "hash_failed"
	| "editor_unhealthy"
	| "missing_file_id"
	// Phase 2 additive entries (Requirement 1.2):
	| "checkpoint_write_failed"
	| "unavailable"
	| "checkpoint_path_inside_vault";

/** Phase 2: runtime state for mobile-background detection (Requirement 19). */
export type RuntimeState = "foreground" | "background" | "suspended" | "unknown";

/** Phase 2: causedByEvents seq linkage (Requirement 12). */
export interface CausedByEvents {
	lastDiskWriteSeq?: number;
	lastCrdtUpdateSeq?: number;
	lastRecoverySeq?: number;
	lastRemoteApplySeq?: number;
	lastConflictArtifactSeq?: number;
	lastTombstoneSeq?: number;
}

export interface FileObservation {
	crdtHash: string | undefined;
	diskHash: string | undefined;
	editorHash: string | undefined;
	editorSampleKind: EditorSampleKind;
	fileOpen: boolean;
	dirty: boolean;
	stateKind: StateKind;
}

export interface WitnessBufferEntry {
	kind: "settled" | "diverged";
	path: string;
	seq: number;
	data: Record<string, unknown>;
}

/**
 * Scenario context injected by the Puppeteer harness (via qa/).
 * The tracker reads this passively — it never mutates scenario state.
 * Scenario annotation (setScenarioRunId, advanceScenarioStep) lives in qa/.
 */
export interface ScenarioContext {
	readonly scenarioRunId: string | null;
	readonly scenarioId: string | null;
	readonly stepIndex: number | null;
	readonly stepLabel: string | undefined;
}

export interface WitnessTrackerConfig {
	/** Vault config directory path (e.g. ".obsidian"). Used to filter out non-note paths. */
	configDir?: string;
	/** Milliseconds to wait after last dirty trigger before evaluating. Default: 2000 */
	stableAfterMs?: number;
	/**
	 * Grace window for "settling" editor state before treating as diverged.
	 * Default: 750ms (matches BASE_BINDING_SETTLE_WINDOW_MS).
	 */
	editorSettleGraceMs?: number;
	/** Salt secret for stateHash computation (session-salted SHA-256). */
	stateSecret: string;
	/** In qa-safe mode, use qaTraceSecret instead of stateSecret. */
	qaTraceSecret?: string | null;
	/** Flight mode — determines which secret to use. */
	flightMode: "safe" | "qa-safe" | "full" | "local-private";
	/** The flight sink to emit events through. */
	sink: FlightSink;
	/** Trace context for envelope fields. */
	traceContext: TraceContext;
	/** Read CRDT content for a path. Returns null if not found or tombstoned. */
	readCrdtContent(path: string): string | null;
	/** Check if a path is tombstoned in the CRDT. */
	isCrdtTombstoned(path: string): boolean;
	/** Get fileId for a path. Returns undefined if not yet assigned. */
	getFileId(path: string): string | undefined;
	/** Read disk content for a path. Returns null if file absent. */
	readDiskContent(path: string): Promise<string | null>;
	/** Get editor sample kind and content for a path. */
	sampleEditor(path: string): { kind: EditorSampleKind; content: string | null };
	/** Platform: desktop or mobile. */
	platform: "desktop" | "mobile";
	/** Timeout for pending-fileId paths in ms. Default: 10000 */
	pathPendingTimeoutMs?: number;
	/** Max witness buffer entries (oldest dropped when exceeded). Default: 1000 */
	maxWitnessBufferEvents?: number;
	/** Max history entries per (fileId, stateKind). Default: 20 */
	maxHistoryPerFile?: number;
	/** Max suppression set size. Default: 5000 */
	maxSuppressedEntries?: number;
	/**
	 * Phase 2: Resolve a salted pathId for a raw path.
	 * Used to include pathId in checkpoint lines without raw path leakage.
	 * If not provided, pathId is omitted from checkpoint lines.
	 */
	getPathId?(path: string): Promise<string | null>;
	/**
	 * Phase 2: Max checkpoint segment size in bytes before rotation. Default: 10MB.
	 */
	checkpointSegmentMaxBytes?: number;
	/**
	 * Phase 2: Max retained segments per (traceId, deviceId). Default: 5.
	 */
	checkpointMaxSegments?: number;
	/**
	 * Phase 3: Injected by Puppeteer harness (qa/) for scenario step annotation.
	 * The tracker reads this passively to annotate witness events.
	 * Scenario mutation (setScenarioRunId, advanceScenarioStep) lives in qa/,
	 * not on this class. Optional — omit for production/passive telemetry use.
	 */
	getScenarioContext?(): ScenarioContext | null;
}

// -----------------------------------------------------------------------
// Internal state
// -----------------------------------------------------------------------

/** Origin severity order for coalescing (higher index = more severe). */
const ORIGIN_SEVERITY: OriginClass[] = [
	"unknown",
	"local-edit",
	"disk-write",
	"local-repair",
	"remote-apply",
	"tombstone",
	"conflict-artifact",
	"recovery",
];

function moreSeveOrigin(a: OriginClass, b: OriginClass): OriginClass {
	return ORIGIN_SEVERITY.indexOf(a) >= ORIGIN_SEVERITY.indexOf(b) ? a : b;
}

/**
 * Origins that can legitimately produce an old hash without it being a
 * stale-rewind bug. Local edits are user-intentional — the user is allowed
 * to type the same content again.
 */
const STALE_EXEMPT_ORIGINS = new Set<OriginClass>(["local-edit"]);

interface PendingObservation {
	path: string;
	fileId: string | undefined;
	originClass: OriginClass;
	timer: ReturnType<typeof setTimeout> | null;
	pendingFileIdTimer: ReturnType<typeof setTimeout> | null;
	settlingTimer: ReturnType<typeof setTimeout> | null;
	lastDirtyAt: number;
	lastLocalEditAt?: number;
	lastRemoteApplyAt?: number;
	lastDiskWriteAt?: number;
	lastRecoveryAt?: number;
	// Phase 2: causedByEvents seq tracking (Requirement 12)
	lastDiskWriteSeq?: number;
	lastCrdtUpdateSeq?: number;
	lastRecoverySeq?: number;
	lastRemoteApplySeq?: number;
	lastConflictArtifactSeq?: number;
	lastTombstoneSeq?: number;
	// Phase 2: seq at which the stability window opened (for causedByEvents scoping)
	windowOpenSeq: number;
}

interface WitnessRecord {
	stateHash: string;
	seq: number;
}

// -----------------------------------------------------------------------
// Hash construction — delegated to shared witnessStateHash module (Phase 2 Req 10.3)
// -----------------------------------------------------------------------

async function computeStateHash(secret: string, content: string): Promise<string | null> {
	return _computeWitnessStateHash(secret, content);
}

async function computeDeletedStateHash(secret: string, fileId: string): Promise<string | null> {
	return computeDeletedWitnessStateHash(secret, fileId);
}

// -----------------------------------------------------------------------
// DeviceWitnessTracker
// -----------------------------------------------------------------------

export class DeviceWitnessTracker {
	private readonly stableAfterMs: number;
	private readonly editorSettleGraceMs: number;
	private readonly secret: string;
	private readonly sessionId: string;
	private readonly maxWitnessBufferEvents: number;
	private readonly maxHistoryPerFile: number;
	private readonly maxSuppressedEntries: number;

	private disposed = false;

	/** Per-path pending observations. */
	private pending = new Map<string, PendingObservation>();

	/** Suppression set: (sessionId|fileId|stateKind|stateHash) */
	private suppressed = new Set<string>();

	/** Per-(fileId|stateKind) ordered witness history. */
	private witnessHistory = new Map<string, WitnessRecord[]>();

	/** Latest settled record per (fileId|stateKind). */
	private latestSettled = new Map<string, WitnessRecord>();

	/** In-memory buffer for QA probe. Capped at maxWitnessBufferEvents. */
	private witnessBuffer: WitnessBufferEntry[] = [];

	/** Monotonically increasing local seq counter. */
	private localSeq = 0;

	// Phase 2: in-memory checkpoint segments (no filesystem — avoids vault-root issues)
	private readonly checkpointSegmentMaxBytes: number;
	private readonly checkpointMaxSegments: number;
	private checkpointSegmentIndex = 1;
	private checkpointSegmentSize = 0;
	private checkpointWriteFailedAt = 0;
	/** In-memory checkpoint segments: segmentIndex → NDJSON string */
	private checkpointSegments = new Map<number, string>();

	// Phase 3: scenario context is read from config.getScenarioContext() (injected by Puppeteer).
	// The tracker does NOT own scenario mutation — that lives in qa/.
	private get _scenarioContext(): ScenarioContext | null {
		return this.config.getScenarioContext?.() ?? null;
	}

	constructor(private readonly config: WitnessTrackerConfig) {
		this.stableAfterMs = config.stableAfterMs ?? (config.platform === "mobile" ? 4000 : 2000);
		this.editorSettleGraceMs = config.editorSettleGraceMs ?? 750;
		this.secret = (config.flightMode === "qa-safe" && config.qaTraceSecret)
			? config.qaTraceSecret
			: config.stateSecret;
		this.sessionId = config.traceContext.traceId;
		this.maxWitnessBufferEvents = config.maxWitnessBufferEvents ?? 1000;
		this.maxHistoryPerFile = config.maxHistoryPerFile ?? 20;
		this.maxSuppressedEntries = config.maxSuppressedEntries ?? 5000;
		this.checkpointSegmentMaxBytes = config.checkpointSegmentMaxBytes ?? 10 * 1024 * 1024;
		this.checkpointMaxSegments = config.checkpointMaxSegments ?? 5;
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Mark a path dirty, scheduling a stability-window evaluation.
	 * Safe to call from any sync path — never throws.
	 */
	markDirty(path: string, originClass: OriginClass): void {
		if (this.disposed) return;
		try {
			this._markDirty(path, originClass);
		} catch { /* fail-open */ }
	}

	/**
	 * Phase 2: Notify the tracker of a precursor event seq for causedByEvents linkage.
	 * Call this when a relevant flight event is emitted for a path.
	 * Safe to call from any sync path — never throws.
	 */
	notifyPrecursorEvent(
		path: string,
		kind: "disk-write" | "crdt-update" | "recovery" | "remote-apply" | "conflict-artifact" | "tombstone",
		seq: number,
	): void {
		if (this.disposed) return;
		try {
			const obs = this.pending.get(path);
			if (!obs) return;
			switch (kind) {
				case "disk-write": obs.lastDiskWriteSeq = seq; break;
				case "crdt-update": obs.lastCrdtUpdateSeq = seq; break;
				case "recovery": obs.lastRecoverySeq = seq; break;
				case "remote-apply": obs.lastRemoteApplySeq = seq; break;
				case "conflict-artifact": obs.lastConflictArtifactSeq = seq; break;
				case "tombstone": obs.lastTombstoneSeq = seq; break;
			}
		} catch { /* fail-open */ }
	}

	/**
	 * Phase 2: Handle a recovery.decision event with recoveryStateHash for precision path.
	 * Requirement 11: immediate detection of stale-recovery emission.
	 * recoverySeq is unused — causedByEvents.lastRecoverySeq is populated by
	 * notifyPrecursorEvent when the flight recorder seq is available.
	 */
	handleRecoveryDecision(path: string, recoveryStateHash: string | undefined): void {
		if (this.disposed) return;
		if (!recoveryStateHash) return;
		// Req 11.4: only accept values with the witness-domain prefix "h:"
		if (!recoveryStateHash.startsWith("h:")) return;
		try {
			this._handleRecoveryDecisionPrecisionPath(path, recoveryStateHash);
		} catch { /* fail-open */ }
	}

	/**
	 * Observe current state for a path without emitting any event.
	 */
	async observeNow(path: string): Promise<FileObservation> {
		try {
			return await this._observeNow(path);
		} catch {
			return {
				crdtHash: undefined,
				diskHash: undefined,
				editorHash: undefined,
				editorSampleKind: "not_open",
				fileOpen: false,
				dirty: false,
				stateKind: "present",
			};
		}
	}

	/** Current local seq — used by QA probe to anchor buffer reads. */
	currentWitnessSeq(): number {
		return this.localSeq;
	}

	/** Read the in-memory witness buffer (for QA probe). */
	getWitnessBuffer(): ReadonlyArray<WitnessBufferEntry> {
		return this.witnessBuffer;
	}

	/** Compute the witness-domain stateHash for a given content string. */
	async computeWitnessStateHash(content: string): Promise<string> {
		const h = await computeStateHash(this.secret, content);
		if (h === null) throw new Error("crypto.subtle unavailable — cannot compute witness state hash");
		return h;
	}

	/**
	 * Phase 2 QA: Clear suppression for a path so the next markDirty re-emits
	 * a settled event even if the content hasn't changed.
	 * Use this before triggering a dirty event in witnessQuorum setup.
	 */
	clearSuppressionForPath(path: string): void {
		if (this.disposed) return;
		const fileId = this.config.getFileId(path);
		if (!fileId) return;
		for (const stateKind of ["present", "deleted"] as const) {
			const histKey = `${fileId}|${stateKind}`;
			const latest = this.latestSettled.get(histKey);
			if (latest) {
				const suppressKey = `${this.sessionId}|${fileId}|${stateKind}|${latest.stateHash}`;
				this.suppressed.delete(suppressKey);
			}
		}
	}

	/** Phase 2: Get current runtime state for mobile-background detection. */
	getRuntimeState(): RuntimeState {
		return this._getRuntimeState();
	}

	/**
	 * Phase 2: Read in-memory checkpoint segments for QA API export.
	 * Returns segments sorted by index. Each segment is a NDJSON string.
	 */
	getCheckpointSegments(): Array<{ index: number; content: string }> {
		return [...this.checkpointSegments.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([index, content]) => ({ index, content }));
	}

	/** Dispose: cancel all timers, clear all state. Terminal — markDirty is a no-op after this. */
	dispose(): void {
		this.disposed = true;
		for (const obs of this.pending.values()) {
			if (obs.timer) clearTimeout(obs.timer);
			if (obs.pendingFileIdTimer) clearTimeout(obs.pendingFileIdTimer);
			if (obs.settlingTimer) clearTimeout(obs.settlingTimer);
		}
		this.pending.clear();
		this.suppressed.clear();
		this.witnessHistory.clear();
		this.latestSettled.clear();
		this.witnessBuffer = [];
		// Keep checkpoint segments after dispose — they are read-only artifacts
	}

	// -----------------------------------------------------------------------
	// Internal: dirty trigger
	// -----------------------------------------------------------------------

	private _markDirty(path: string, originClass: OriginClass): void {
		if (!this._isMarkdownPath(path)) return;

		const now = Date.now();
		const existing = this.pending.get(path);

		if (existing) {
			if (existing.timer) clearTimeout(existing.timer);
			if (existing.settlingTimer) {
				clearTimeout(existing.settlingTimer);
				existing.settlingTimer = null;
			}
			existing.originClass = moreSeveOrigin(existing.originClass, originClass);
			existing.lastDirtyAt = now;
			this._updateTimestamps(existing, originClass, now);
			existing.timer = setTimeout(() => void this._evaluate(path), this.stableAfterMs);
		} else {
			const obs: PendingObservation = {
				path,
				fileId: this.config.getFileId(path),
				originClass,
				timer: null,
				pendingFileIdTimer: null,
				settlingTimer: null,
				lastDirtyAt: now,
				windowOpenSeq: this.localSeq,
			};
			this._updateTimestamps(obs, originClass, now);

			if (!obs.fileId) {
				const pendingMs = this.config.pathPendingTimeoutMs ?? 10_000;
				obs.pendingFileIdTimer = setTimeout(() => {
					// Re-check: fileId may have appeared since the timer was set.
					const current = this.pending.get(path);
					if (!current) return;
					const fileId = this.config.getFileId(path);
					if (fileId) {
						current.fileId = fileId;
						if (current.pendingFileIdTimer) {
							clearTimeout(current.pendingFileIdTimer);
							current.pendingFileIdTimer = null;
						}
						void this._evaluate(path);
						return;
					}
					this._emitMissingFileId(path);
					this.pending.delete(path);
				}, pendingMs);
			}

			obs.timer = setTimeout(() => void this._evaluate(path), this.stableAfterMs);
			this.pending.set(path, obs);
		}
	}

	private _updateTimestamps(obs: PendingObservation, originClass: OriginClass, now: number): void {
		if (originClass === "local-edit") obs.lastLocalEditAt = now;
		if (originClass === "remote-apply") obs.lastRemoteApplyAt = now;
		if (originClass === "disk-write") obs.lastDiskWriteAt = now;
		if (originClass === "recovery") obs.lastRecoveryAt = now;
	}

	// -----------------------------------------------------------------------
	// Internal: evaluation after stability window
	// -----------------------------------------------------------------------

	private async _evaluate(path: string): Promise<void> {
		const obs = this.pending.get(path);
		if (!obs) return;

		if (!obs.fileId) {
			obs.fileId = this.config.getFileId(path);
		}
		if (!obs.fileId) {
			// Still no fileId — pending-fileId timer will handle it.
			return;
		}

		if (obs.pendingFileIdTimer) {
			clearTimeout(obs.pendingFileIdTimer);
			obs.pendingFileIdTimer = null;
		}

		this.pending.delete(path);

		try {
			await this._evaluateWithFileId(path, obs);
		} catch { /* fail-open */ }
	}

	private async _evaluateWithFileId(path: string, obs: PendingObservation): Promise<void> {
		const fileId = obs.fileId!;

		// Phase 2: mobile-background guard (Requirement 19)
		const runtimeState = this._getRuntimeState();
		const isUnavailable = runtimeState !== "foreground";

		const observation = await this._observeNow(path);
		const { crdtHash, diskHash, editorHash, editorSampleKind, stateKind } = observation;

		const causedByEvents = this._buildCausedByEvents(obs);

		const commonData: Record<string, unknown> = {
			stateKind,
			editorSampleKind,
			fileOpen: observation.fileOpen,
			originClass: obs.originClass,
			stableAfterMs: this.stableAfterMs,
			runtimeState,
			causedByEvents,
		};
		if (obs.lastLocalEditAt !== undefined) commonData.lastLocalEditAt = obs.lastLocalEditAt;
		if (obs.lastRemoteApplyAt !== undefined) commonData.lastRemoteApplyAt = obs.lastRemoteApplyAt;
		if (obs.lastDiskWriteAt !== undefined) commonData.lastDiskWriteAt = obs.lastDiskWriteAt;
		if (obs.lastRecoveryAt !== undefined) commonData.lastRecoveryAt = obs.lastRecoveryAt;
		// Phase 3: scenario step fields — read passively from injected context (Puppeteer sets this)
		const scenarioCtx = this._scenarioContext;
		if (scenarioCtx?.stepIndex !== null && scenarioCtx?.stepIndex !== undefined) commonData.scenarioStepIndex = scenarioCtx.stepIndex;
		if (scenarioCtx?.stepLabel !== undefined) commonData.scenarioStepLabel = scenarioCtx.stepLabel;
		if (scenarioCtx?.scenarioRunId !== null && scenarioCtx?.scenarioRunId !== undefined) commonData.scenarioRunId = scenarioCtx.scenarioRunId;
		if (scenarioCtx?.scenarioId !== null && scenarioCtx?.scenarioId !== undefined) commonData.scenarioId = scenarioCtx.scenarioId;

		// Phase 2: if unavailable, emit unavailable divergence instead of normal evaluation
		if (isUnavailable) {
			await this._emitDiverged(path, fileId, "unavailable", {
				...commonData,
				suppressedReason: "unavailable",
			});
			return;
		}

		// hash_failed / read_failed for CRDT.
		if (crdtHash === undefined && stateKind === "present") {
			await this._emitDiverged(path, fileId, "read_failed", { ...commonData, authority: "crdt" });
			return;
		}
		// read_failed for disk.
		if (diskHash === undefined && stateKind === "present") {
			await this._emitDiverged(path, fileId, "read_failed", { ...commonData, authority: "disk" });
			return;
		}

		// Editor unhealthy.
		if (editorSampleKind === "unhealthy") {
			await this._emitDiverged(path, fileId, "editor_unhealthy", { ...commonData, crdtHash, diskHash });
			return;
		}

		// Editor settling — reschedule up to editorSettleGraceMs, then settle_timeout.
		if (editorSampleKind === "settling") {
			const elapsed = Date.now() - obs.lastDirtyAt;
			if (elapsed < this.editorSettleGraceMs) {
				// Re-queue after remaining grace window.
				const remaining = this.editorSettleGraceMs - elapsed;
				// Put back into pending so a new dirty trigger can reset it.
				this.pending.set(path, obs);
				obs.settlingTimer = setTimeout(() => void this._evaluate(path), remaining);
				return;
			}
			// Grace window expired — emit settle_timeout.
			await this._emitDiverged(path, fileId, "settle_timeout", {
				...commonData,
				crdtHash,
				diskHash,
				editorSampleKind: "settling",
			});
			return;
		}

		// Disk/CRDT mismatch (covers deleted-state disk-present case too).
		if (crdtHash !== diskHash) {
			await this._emitDiverged(path, fileId, "disk_crdt_mismatch", { ...commonData, crdtHash, diskHash });
			return;
		}

		// Editor/CRDT mismatch (when editor is open and healthy).
		if (editorSampleKind === "healthy_sampled" && editorHash !== crdtHash) {
			await this._emitDiverged(path, fileId, "editor_crdt_mismatch", {
				...commonData, crdtHash, diskHash, editorHash,
			});
			return;
		}

		// All agree — stateHash is the agreed hash.
		const stateHash = crdtHash!;

		// Stale-hash detection: only flag non-local-edit origins.
		const histKey = `${fileId}|${stateKind}`;
		if (!STALE_EXEMPT_ORIGINS.has(obs.originClass)) {
			const latest = this.latestSettled.get(histKey);
			if (latest && latest.stateHash !== stateHash) {
				const history = this.witnessHistory.get(histKey) ?? [];
				const priorEntry = history.find((r) => r.stateHash === stateHash);
				if (priorEntry && priorEntry.seq < latest.seq) {
					const reason = obs.originClass === "recovery"
						? "recovery_emitted_old_hash"
						: "stale_hash_after_newer_witness";
					await this._emitDiverged(path, fileId, reason, {
						...commonData,
						stateHash,
						priorLatestStateHash: latest.stateHash,
						priorLatestSeq: latest.seq,
					});
					return;
				}
			}
		}

		// Duplicate suppression.
		// Per Req 9.3: when a new dirty trigger changes stateHash, clear the prior
		// suppression entry so re-convergence to an old hash can re-emit one settled.
		const suppressKey = `${this.sessionId}|${fileId}|${stateKind}|${stateHash}`;
		const latestForPath = this.latestSettled.get(histKey);
		if (latestForPath && latestForPath.stateHash !== stateHash) {
			// Content changed — clear suppression for the prior hash so future
			// re-convergence to it can emit a fresh settled witness.
			const priorKey = `${this.sessionId}|${fileId}|${stateKind}|${latestForPath.stateHash}`;
			this.suppressed.delete(priorKey);
		}
		if (this.suppressed.has(suppressKey)) return;

		// Emit settled.
		const seq = ++this.localSeq;
		const data: Record<string, unknown> = {
			...commonData,
			stateHash,
			crdtHash,
			diskHash,
			diskMatchesCrdt: true,
		};
		if (editorSampleKind === "healthy_sampled") {
			data.editorHash = editorHash;
			data.editorMatchesCrdt = true;
		}

		// Add to suppression set (with cap).
		if (this.suppressed.size >= this.maxSuppressedEntries) {
			const first: string | undefined = this.suppressed.values().next().value as string | undefined;
			if (first !== undefined) this.suppressed.delete(first);
		}
		this.suppressed.add(suppressKey);

		// Update history (with cap).
		const record: WitnessRecord = { stateHash, seq };
		const hist = this.witnessHistory.get(histKey) ?? [];
		hist.push(record);
		if (hist.length > this.maxHistoryPerFile) hist.splice(0, hist.length - this.maxHistoryPerFile);
		this.witnessHistory.set(histKey, hist);
		this.latestSettled.set(histKey, record);

		// Add to buffer (with cap).
		this._pushBuffer({ kind: "settled", path, seq, data });

		// Phase 2: checkpoint write — fire-and-forget, never blocks witness emission (B4)
		void this._appendCheckpoint({ kind: "settled", path, seq, data });

		try {
			await this.config.sink.recordPath({
				kind: FLIGHT_KIND.deviceWitnessSettled,
				scope: "file",
				source: "deviceWitness",
				layer: "diagnostics",
				priority: this.config.flightMode === "qa-safe" ? "important" : "verbose",
				severity: "info",
				decision: "settled",
				reason: "hashes_agree_after_stability_window",
				opId: `witness-${seq}`,
				fileId,
				path,
				data,
			});
		} catch { /* fail-open */ }
	}

	// -----------------------------------------------------------------------
	// Internal: observation
	// -----------------------------------------------------------------------

	private async _observeNow(path: string): Promise<FileObservation> {
		const isTombstoned = this.config.isCrdtTombstoned(path);
		const stateKind: StateKind = isTombstoned ? "deleted" : "present";
		const fileId = this.config.getFileId(path);

		if (stateKind === "deleted") {
			let crdtHash: string | undefined;
			let diskHash: string | undefined;

			if (fileId) {
				const h = await computeDeletedStateHash(this.secret, fileId);
				if (h === null) {
					return {
						crdtHash: undefined, diskHash: undefined, editorHash: undefined,
						editorSampleKind: "not_open", fileOpen: false,
						dirty: this.pending.has(path), stateKind: "deleted",
					};
				}
				crdtHash = h;
				let diskContent: string | null;
				try {
					diskContent = await this.config.readDiskContent(path);
				} catch {
					diskContent = null;
				}
				// diskHash equals crdtHash only when file is absent (correctly deleted).
				// If file still exists on disk, diskHash is undefined → triggers disk_crdt_mismatch.
				diskHash = diskContent === null ? h : undefined;
			}

			// Sample editor even for deleted state — an open editor with content
			// on a tombstoned file is a relevant divergence signal.
			const editorSample = this.config.sampleEditor(path);
			const editorSampleKind = editorSample.kind;
			const fileOpen = editorSampleKind !== "not_open";
			let editorHash: string | undefined;
			if (editorSampleKind === "healthy_sampled" && editorSample.content !== null) {
				const h = await computeStateHash(this.secret, editorSample.content);
				editorHash = h ?? undefined;
			}

			return {
				crdtHash, diskHash, editorHash,
				editorSampleKind, fileOpen,
				dirty: this.pending.has(path), stateKind: "deleted",
			};
		}

		// Present state.
		let crdtHash: string | undefined;
		let diskHash: string | undefined;
		let editorHash: string | undefined;
		let editorSampleKind: EditorSampleKind = "not_open";
		let fileOpen = false;

		// CRDT read.
		const crdtContent = this.config.readCrdtContent(path);
		if (crdtContent !== null) {
			const h = await computeStateHash(this.secret, crdtContent);
			if (h === null) {
				// crypto unavailable — hash_failed
				return {
					crdtHash: undefined, diskHash: undefined, editorHash: undefined,
					editorSampleKind: "not_open", fileOpen: false,
					dirty: this.pending.has(path), stateKind: "present",
				};
			}
			crdtHash = h;
		}

		// Disk read.
		try {
			const diskContent = await this.config.readDiskContent(path);
			if (diskContent !== null) {
				diskHash = (await computeStateHash(this.secret, diskContent)) ?? undefined;
			}
		} catch {
			diskHash = undefined;
		}

		// Editor sample.
		const editorSample = this.config.sampleEditor(path);
		editorSampleKind = editorSample.kind;
		fileOpen = editorSampleKind !== "not_open";
		if (editorSampleKind === "healthy_sampled" && editorSample.content !== null) {
			editorHash = (await computeStateHash(this.secret, editorSample.content)) ?? undefined;
		}

		return { crdtHash, diskHash, editorHash, editorSampleKind, fileOpen, dirty: this.pending.has(path), stateKind: "present" };
	}

	// -----------------------------------------------------------------------
	// Internal: emit helpers
	// -----------------------------------------------------------------------

	private async _emitDiverged(
		path: string,
		fileId: string,
		reason: DivergenceReason,
		data: Record<string, unknown>,
	): Promise<void> {
		const seq = ++this.localSeq;
		this._pushBuffer({ kind: "diverged", path, seq, data: { ...data, reason } });
		// Phase 2: checkpoint write — fire-and-forget, never blocks witness emission (B4)
		void this._appendCheckpoint({ kind: "diverged", path, seq, data: { ...data, reason } });
		try {
			await this.config.sink.recordPath({
				kind: FLIGHT_KIND.deviceWitnessDiverged,
				scope: "file",
				source: "deviceWitness",
				layer: "diagnostics",
				priority: "important",
				severity: "warn",
				decision: "diverged",
				reason,
				opId: `witness-${seq}`,
				fileId,
				path,
				data,
			});
		} catch { /* fail-open */ }
	}

	private _emitMissingFileId(path: string): void {
		const seq = ++this.localSeq;
		this._pushBuffer({ kind: "diverged", path, seq, data: { reason: "missing_file_id" } });
		try {
			this.config.sink.record({
				kind: FLIGHT_KIND.deviceWitnessDiverged,
				scope: "diagnostics",
				source: "deviceWitness",
				layer: "diagnostics",
				priority: "important",
				severity: "warn",
				decision: "diverged",
				reason: "missing_file_id",
				opId: `witness-${seq}`,
				data: { reason: "missing_file_id" },
			});
		} catch { /* fail-open */ }
	}

	private _pushBuffer(entry: WitnessBufferEntry): void {
		this.witnessBuffer.push(entry);
		if (this.witnessBuffer.length > this.maxWitnessBufferEvents) {
			this.witnessBuffer.splice(0, this.witnessBuffer.length - this.maxWitnessBufferEvents);
		}
	}

	// -----------------------------------------------------------------------
	// Internal: path filter
	// -----------------------------------------------------------------------

	private _isMarkdownPath(path: string): boolean {
		if (!path.endsWith(".md")) return false;
		// eslint-disable-next-line obsidianmd/hardcoded-config-path
		const configDir = this.config.configDir ?? ".obsidian";
		if (path.startsWith(configDir + "/")) return false;
		return true;
	}

	// -----------------------------------------------------------------------
	// Phase 2: runtime state (Requirement 19)
	// -----------------------------------------------------------------------

	private _getRuntimeState(): RuntimeState {
		if (this.config.platform === "mobile") {
			try {
				if (typeof document !== "undefined" && document.visibilityState === "hidden") {
					return "background";
				}
			} catch {
				return "unknown";
			}
		}
		return "foreground";
	}

	// -----------------------------------------------------------------------
	// Phase 2: causedByEvents (Requirement 12)
	// -----------------------------------------------------------------------

	private _buildCausedByEvents(obs: PendingObservation): CausedByEvents {
		const result: CausedByEvents = {};
		if (obs.lastDiskWriteSeq !== undefined && obs.lastDiskWriteSeq > obs.windowOpenSeq) {
			result.lastDiskWriteSeq = obs.lastDiskWriteSeq;
		}
		if (obs.lastCrdtUpdateSeq !== undefined && obs.lastCrdtUpdateSeq > obs.windowOpenSeq) {
			result.lastCrdtUpdateSeq = obs.lastCrdtUpdateSeq;
		}
		if (obs.lastRecoverySeq !== undefined && obs.lastRecoverySeq > obs.windowOpenSeq) {
			result.lastRecoverySeq = obs.lastRecoverySeq;
		}
		if (obs.lastRemoteApplySeq !== undefined && obs.lastRemoteApplySeq > obs.windowOpenSeq) {
			result.lastRemoteApplySeq = obs.lastRemoteApplySeq;
		}
		if (obs.lastConflictArtifactSeq !== undefined && obs.lastConflictArtifactSeq > obs.windowOpenSeq) {
			result.lastConflictArtifactSeq = obs.lastConflictArtifactSeq;
		}
		if (obs.lastTombstoneSeq !== undefined && obs.lastTombstoneSeq > obs.windowOpenSeq) {
			result.lastTombstoneSeq = obs.lastTombstoneSeq;
		}
		return result;
	}

	// -----------------------------------------------------------------------
	// Phase 2: recoveryStateHash precision path (Requirement 11)
	// -----------------------------------------------------------------------

	private _handleRecoveryDecisionPrecisionPath(
		path: string,
		recoveryStateHash: string,
	): void {
		if (!this._isMarkdownPath(path)) return;
		const fileId = this.config.getFileId(path);
		if (!fileId) return;

		// Check both present and deleted stateKinds
		for (const stateKind of ["present", "deleted"] as const) {
			const histKey = `${fileId}|${stateKind}`;
			const latest = this.latestSettled.get(histKey);
			if (!latest) continue;

			const history = this.witnessHistory.get(histKey) ?? [];
			// Find a prior settled record with this hash that is strictly older than latest
			const priorEntry = history.find(
				(r) => r.stateHash === recoveryStateHash && r.seq < latest.seq,
			);
			if (!priorEntry) continue;

			// Precision path: emit recovery_emitted_old_hash immediately.
			// causedByEvents is empty here — notifyPrecursorEvent populates lastRecoverySeq
			// when the flight recorder seq is available (B11: no magic 0).
			const runtimeState = this._getRuntimeState();
			const causedByEvents: CausedByEvents = {};
			const data: Record<string, unknown> = {
				stateKind,
				originClass: "recovery",
				stableAfterMs: this.stableAfterMs,
				runtimeState,
				causedByEvents,
				recoveryStateHash,
				priorLatestStateHash: latest.stateHash,
				priorLatestSeq: latest.seq,
				precisionPath: true,
			};
			const seq = ++this.localSeq;
			this._pushBuffer({ kind: "diverged", path, seq, data: { ...data, reason: "recovery_emitted_old_hash" } });
			void this._appendCheckpoint({ kind: "diverged", path, seq, data: { ...data, reason: "recovery_emitted_old_hash" } });
			try {
				void this.config.sink.recordPath({
					kind: FLIGHT_KIND.deviceWitnessDiverged,
					scope: "file",
					source: "deviceWitness",
					layer: "diagnostics",
					priority: "important",
					severity: "warn",
					decision: "diverged",
					reason: "recovery_emitted_old_hash",
					opId: `witness-${seq}`,
					fileId,
					path,
					data,
				});
			} catch { /* fail-open */ }
			return; // only emit once per decision
		}
	}

	// -----------------------------------------------------------------------
	// Phase 2: in-memory checkpoint segments (Requirements 22-25)
	//
	// Checkpoint segments are stored in-memory (not on filesystem) to avoid
	// vault-root path issues. The QA API reads them via getCheckpointSegments().
	// This is the correct approach for Phase 2: no filesystem dependency,
	// no vault.adapter with absolute paths, no fail-closed path guard needed.
	// -----------------------------------------------------------------------

	private async _appendCheckpoint(entry: WitnessBufferEntry): Promise<void> {
		if (this.disposed) return;
		try {
			// Resolve pathId before writing — no async patching after the fact (Fix 2)
			const fileId = this.config.getFileId(entry.path);
			let pathId: string | null = null;
			if (this.config.getPathId && entry.path) {
				try {
					pathId = await this.config.getPathId(entry.path);
				} catch { /* best-effort */ }
			}

			// Write header if this is a new segment (size === 0)
			if (this.checkpointSegmentSize === 0) {
				const header = JSON.stringify({
					kind: "checkpoint.segment.header",
					traceId: this.config.traceContext.traceId,
					deviceId: this.config.traceContext.deviceId,
					segmentIndex: this.checkpointSegmentIndex,
					firstSeq: entry.seq,
				}) + "\n";
				const existing = this.checkpointSegments.get(this.checkpointSegmentIndex) ?? "";
				this.checkpointSegments.set(this.checkpointSegmentIndex, existing + header);
				this.checkpointSegmentSize += header.length;
			}

			// Build line once with all fields resolved — no patching later
			const lineObj: Record<string, unknown> = {
				kind: entry.kind === "settled" ? "device.witness.settled" : "device.witness.diverged",
				seq: entry.seq,
				fileId: fileId ?? null,
				data: entry.data,
			};
			if (pathId) lineObj.pathId = pathId;
			const line = JSON.stringify(lineObj) + "\n";

			const existing = this.checkpointSegments.get(this.checkpointSegmentIndex) ?? "";
			this.checkpointSegments.set(this.checkpointSegmentIndex, existing + line);
			this.checkpointSegmentSize += line.length;

			// Rotate if over size limit
			if (this.checkpointSegmentSize >= this.checkpointSegmentMaxBytes) {
				this._rotateCheckpointSegment();
			}
		} catch {
			this._emitCheckpointWriteFailed();
		}
	}

	private _rotateCheckpointSegment(): void {
		this.checkpointSegmentIndex++;
		this.checkpointSegmentSize = 0;
		// Delete oldest segment if over max
		const oldestIndex = this.checkpointSegmentIndex - this.checkpointMaxSegments;
		if (oldestIndex >= 1) {
			this.checkpointSegments.delete(oldestIndex);
		}
	}

	private _emitCheckpointWriteFailed(): void {
		if (this.disposed) return;
		const now = Date.now();
		if (now - this.checkpointWriteFailedAt < 60_000) return;
		this.checkpointWriteFailedAt = now;
		const seq = ++this.localSeq;
		this._pushBuffer({ kind: "diverged", path: "", seq, data: { reason: "checkpoint_write_failed" } });
		try {
			this.config.sink.record({
				kind: FLIGHT_KIND.deviceWitnessDiverged,
				scope: "diagnostics",
				source: "deviceWitness",
				layer: "diagnostics",
				priority: "important",
				severity: "warn",
				decision: "diverged",
				reason: "checkpoint_write_failed",
				opId: `witness-${seq}`,
				data: { reason: "checkpoint_write_failed" },
			});
		} catch { /* fail-open */ }
	}
}
