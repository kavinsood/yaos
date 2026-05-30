import { normalizePath, type App } from "obsidian";
import { randomBase64Url } from "../../utils/base64url";
import {
	FLIGHT_EVENT_SCHEMA_VERSION,
	FLIGHT_TAXONOMY_VERSION,
	FLIGHT_KIND,
	type FlightEvent,
	type FlightEventInput,
	type FlightMode,
	type FlightPriority,
	type TraceContext,
} from "./flightEvents";

const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_MAX_PENDING_LINES = 3000;
const DEFAULT_MAX_PENDING_CHARS = 768 * 1024;

// Rotation / retention defaults (spec: P2-6)
const MAX_ACTIVE_FILE_BYTES = 10 * 1024 * 1024;  // 10 MB
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;         // 100 MB
const MAX_DAYS = 7;

/** Keys that must never appear in data for safe/qa-safe events. */
const SENSITIVE_DATA_KEYS = new Set([
	"path",
	"requestedPath",
	"resolvedPath",
	"oldPath",
	"newPath",
	"host",
	"token",
	"vaultId",
	"deviceName",
	"qaTraceSecret",
]);

/** Keys that must never appear in ANY mode's event data. */
const ABSOLUTELY_FORBIDDEN_KEYS = new Set(["token", "qaTraceSecret"]);

export type FlightRecorderOptions = {
	mode: FlightMode;
	traceId?: string;
	bootId?: string;
	deviceId: string;
	vaultIdHash: string;
	serverHostHash: string;
	pluginVersion: string;
	docSchemaVersion?: number;
	flushIntervalMs?: number;
	maxPendingLines?: number;
	maxPendingChars?: number;
};

type PendingEntry = {
	line: string;
	priority: FlightPriority;
};

type DropStats = {
	count: number;
	reason: string;
	byPriority: { verbose: number; important: number; critical: number };
};

function nowMono(): number | undefined {
	if (typeof performance !== "undefined" && typeof performance.now === "function") {
		return performance.now();
	}
	return undefined;
}

function ensurePrefixDir(path: string): string {
	return normalizePath(path);
}

export class FlightRecorder {
	readonly mode: FlightMode;
	private readonly traceId: string;
	private readonly bootId: string;
	private readonly deviceId: string;
	private readonly vaultIdHash: string;
	private readonly serverHostHash: string;
	private readonly pluginVersion: string;
	private readonly docSchemaVersion?: number;
	private readonly flushIntervalMs: number;
	private readonly maxPendingLines: number;
	private readonly maxPendingChars: number;

	private seq = 0;
	private pendingEntries: PendingEntry[] = [];
	private pendingChars = 0;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private writeChain: Promise<void> = Promise.resolve();
	private dropStats: DropStats = {
		count: 0,
		reason: "",
		byPriority: { verbose: 0, important: 0, critical: 0 },
	};

	// Redaction tracking (P0-9)
	private redactionDroppedCount = 0;
	private redactionDroppedByKind = new Map<string, number>();

	// Path identity degradation flag (P0-10)
	private _pathIdentityDegraded = false;

	// Rotation tracking
	private currentFileIndex = 1;
	private bytesWrittenToCurrentFile = 0;

	private readonly eventRing: FlightEvent[] = [];
	private readonly byPathId = new Map<string, FlightEvent[]>();
	private readonly byOpId = new Map<string, FlightEvent[]>();
	private readonly ringLimit = 6000;

	/** True for safe and qa-safe — safe to share with others. */
	get safeToShare(): boolean {
		if (this._pathIdentityDegraded) return false;
		return this.mode === "safe" || this.mode === "qa-safe";
	}

	/** True for full and local-private — contains raw filenames. */
	get includesFilenames(): boolean {
		return this.mode === "full" || this.mode === "local-private";
	}

	/** False for local-private — export is structurally refused. */
	get exportable(): boolean {
		return this.mode !== "local-private";
	}

	get pathIdentityDegraded(): boolean {
		return this._pathIdentityDegraded;
	}

	markPathIdentityDegraded(): void {
		this._pathIdentityDegraded = true;
	}

	get redactionStats(): { droppedCount: number; droppedByKind: Record<string, number> } {
		return {
			droppedCount: this.redactionDroppedCount,
			droppedByKind: Object.fromEntries(this.redactionDroppedByKind),
		};
	}

	constructor(private readonly app: App, options: FlightRecorderOptions) {
		this.mode = options.mode;
		this.traceId = options.traceId ?? `trace-${randomBase64Url(10)}`;
		this.bootId = options.bootId ?? `boot-${randomBase64Url(10)}`;
		this.deviceId = options.deviceId;
		this.vaultIdHash = options.vaultIdHash;
		this.serverHostHash = options.serverHostHash;
		this.pluginVersion = options.pluginVersion;
		this.docSchemaVersion = options.docSchemaVersion;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_MS;
		this.maxPendingLines = options.maxPendingLines ?? DEFAULT_MAX_PENDING_LINES;
		this.maxPendingChars = Math.min(
			options.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS,
			MAX_ACTIVE_FILE_BYTES / 2,
		);
	}

	get context(): TraceContext {
		return {
			traceId: this.traceId,
			bootId: this.bootId,
			deviceId: this.deviceId,
			vaultIdHash: this.vaultIdHash,
			serverHostHash: this.serverHostHash,
			pluginVersion: this.pluginVersion,
			docSchemaVersion: this.docSchemaVersion,
		};
	}

	get currentSessionPath(): string {
		return this.sessionPath();
	}

	get currentBootId(): string {
		return this.bootId;
	}

	/**
	 * Get all segment paths for the current boot session.
	 * Returns paths sorted by segment index (ascending).
	 */
	async getAllSessionSegmentPaths(): Promise<string[]> {
		const dir = this.sessionDir();
		const prefix = `${this.bootId}-`;
		try {
			const listing = await this.app.vault.adapter.list(dir);
			const segments = listing.files
				.filter((f) => {
					const name = f.split("/").pop() ?? "";
					return name.startsWith(prefix) && name.endsWith(".ndjson");
				})
				.sort((a, b) => {
					const aIdx = this.extractSegmentIndex(a);
					const bIdx = this.extractSegmentIndex(b);
					return aIdx - bIdx;
				});
			return segments;
		} catch {
			// Directory might not exist yet
			return [this.sessionPath()];
		}
	}

	get recentEvents(): FlightEvent[] {
		return this.eventRing.slice();
	}

	getRecentEventsForPath(pathId: string, limit = 100): FlightEvent[] {
		const events = this.byPathId.get(pathId) ?? [];
		return events.slice(-limit);
	}

	getTimelineForPath(pathId: string): FlightEvent[] {
		return this.byPathId.get(pathId) ?? [];
	}

	getTimelineForOp(opId: string): FlightEvent[] {
		return this.byOpId.get(opId) ?? [];
	}

	/** Reserve a sequence number synchronously. Used by the controller to maintain causal order for async path events. */
	reserveSeq(): number {
		return ++this.seq;
	}

	/** Current seq (last assigned). Does not increment. */
	get currentSeq(): number {
		return this.seq;
	}

	record(event: FlightEventInput, options?: { reservedSeq?: number }): void {
		// Token and qaTraceSecret are forbidden in ALL modes, not just safe.
		if (event.data) {
			const forbidden = this.findForbiddenKey(event.data);
			if (forbidden) {
				console.error(
					`[yaos/flight] Absolutely forbidden key "${forbidden}" in event data (kind=${String(event.kind)}) — dropping event`,
				);
				this.redactionDroppedCount++;
				this.redactionDroppedByKind.set(String(event.kind), (this.redactionDroppedByKind.get(String(event.kind)) ?? 0) + 1);
				this.recordRedactionFailure(String(event.kind), forbidden);
				return;
			}
		}

		// In safe/qa-safe mode, deep-scan data for sensitive keys before writing.
		if (this.safeToShare && event.data) {
			const leaked = this.findSensitiveKey(event.data);
			if (leaked) {
				console.error(
					`[yaos/flight] Sensitive key "${leaked}" found in event data (kind=${String(event.kind)}) — dropping event, emitting redaction.failure`,
				);
				this.redactionDroppedCount++;
				this.redactionDroppedByKind.set(String(event.kind), (this.redactionDroppedByKind.get(String(event.kind)) ?? 0) + 1);
				this.recordRedactionFailure(String(event.kind), leaked);
				return;
			}
		}

		const full: FlightEvent = {
			...event,
			eventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
			taxonomyVersion: FLIGHT_TAXONOMY_VERSION,
			ts: Date.now(),
			mono: event.mono ?? nowMono(),
			seq: options?.reservedSeq ?? ++this.seq,
			traceId: this.traceId,
			bootId: this.bootId,
			deviceId: this.deviceId,
			vaultIdHash: this.vaultIdHash,
			serverHostHash: this.serverHostHash,
			pluginVersion: this.pluginVersion,
			docSchemaVersion: this.docSchemaVersion,
		};
		const line = JSON.stringify(full) + "\n";
		const { admitted, flushedImmediately } = this.admit(event.priority, line);
		if (!admitted) return;

		this.queueEntry({ line, priority: event.priority });
		this.indexEvent(full);

		if (flushedImmediately) {
			// Critical event under critical-only pressure: already flushed inline.
		} else {
			this.scheduleFlush();
		}
	}

	async flushNow(): Promise<void> {
		// Emit any accumulated drop stats first.
		if (this.dropStats.count > 0) {
			const dropped: FlightEvent = {
				eventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
				taxonomyVersion: FLIGHT_TAXONOMY_VERSION,
				ts: Date.now(),
				seq: ++this.seq,
				kind: FLIGHT_KIND.flightEventsDropped,
				severity: "warn",
				scope: "diagnostics",
				source: "traceRuntime",
				layer: "diagnostics",
				priority: "critical",
				traceId: this.traceId,
				bootId: this.bootId,
				deviceId: this.deviceId,
				vaultIdHash: this.vaultIdHash,
				serverHostHash: this.serverHostHash,
				pluginVersion: this.pluginVersion,
				data: {
					count: this.dropStats.count,
					reason: this.dropStats.reason,
					droppedByPriority: { ...this.dropStats.byPriority },
				},
			};
			this.dropStats = {
				count: 0,
				reason: "",
				byPriority: { verbose: 0, important: 0, critical: 0 },
			};
			this.pendingEntries.push({ line: JSON.stringify(dropped) + "\n", priority: "critical" });
			this.pendingChars += (JSON.stringify(dropped) + "\n").length;
		}

		if (this.pendingEntries.length === 0) return;
		const chunk = this.pendingEntries.map((e) => e.line).join("");
		this.pendingEntries = [];
		this.pendingChars = 0;
		await this.enqueueWrite(async () => {
			await this.ensureDir(this.sessionDir());
			// Check if we need to rotate before writing.
			if (this.bytesWrittenToCurrentFile + chunk.length > MAX_ACTIVE_FILE_BYTES) {
				await this.rotateFile();
			}
			await this.app.vault.adapter.append(this.sessionPath(), chunk);
			this.bytesWrittenToCurrentFile += chunk.length;
		});
	}

	async shutdown(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flushNow();
		await this.writeChain;
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	private extractSegmentIndex(filePath: string): number {
		const name = filePath.split("/").pop() ?? "";
		const match = name.match(/-(\d+)\.ndjson$/);
		return match?.[1] ? parseInt(match[1], 10) : 0;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flushNow();
		}, this.flushIntervalMs);
	}

	/**
	 * Admission check.
	 * Returns { admitted: true, flushedImmediately: false } if there is budget.
	 * Returns { admitted: true, flushedImmediately: true } if critical event
	 *   triggered an immediate flush (caller should not re-schedule flush).
	 * Returns { admitted: false } if the event is dropped.
	 */
	private admit(
		priority: FlightPriority,
		_line: string,
	): { admitted: boolean; flushedImmediately: boolean } {
		const underBudget =
			this.pendingEntries.length < this.maxPendingLines &&
			this.pendingChars < this.maxPendingChars;

		if (underBudget) {
			return { admitted: true, flushedImmediately: false };
		}

		if (priority === "critical") {
			// Try to evict verbose then important to make room.
			this.evictLowestPriority(priority);
			// If still over budget after eviction, flush immediately.
			if (
				this.pendingEntries.length >= this.maxPendingLines ||
				this.pendingChars >= this.maxPendingChars
			) {
				void this.flushNow();
				return { admitted: true, flushedImmediately: true };
			}
			return { admitted: true, flushedImmediately: false };
		}

		// Non-critical: try to drop lower priority first; if we are the lowest, drop self.
		const dropped = this.evictLowestPriority(priority);
		if (!dropped) {
			// We are already the lowest priority — drop self.
			this.dropStats.count += 1;
			this.dropStats.reason = "pending-buffer-cap";
			this.dropStats.byPriority[priority] += 1;
			return { admitted: false, flushedImmediately: false };
		}
		return { admitted: true, flushedImmediately: false };
	}

	/**
	 * Evicts the lowest-priority entry that is strictly below `callerPriority`.
	 * Priority order: verbose < important < critical.
	 * Returns true if an entry was evicted.
	 */
	private evictLowestPriority(callerPriority: FlightPriority): boolean {
		const priorityOrder: FlightPriority[] = ["verbose", "important", "critical"];
		const callerRank = priorityOrder.indexOf(callerPriority);

		for (const candidate of priorityOrder) {
			if (priorityOrder.indexOf(candidate) >= callerRank) break; // don't evict same/higher
			const idx = this.pendingEntries.findIndex((e) => e.priority === candidate);
			if (idx >= 0) {
				const evicted = this.pendingEntries.splice(idx, 1)[0]!;
				this.pendingChars -= evicted.line.length;
				this.dropStats.count += 1;
				this.dropStats.reason = "pending-buffer-cap";
				this.dropStats.byPriority[candidate] += 1;
				return true;
			}
		}
		return false;
	}

	private queueEntry(entry: PendingEntry): void {
		this.pendingEntries.push(entry);
		this.pendingChars += entry.line.length;

		// Hard-cap: if still over after admission, evict lowest-priority from front
		while (
			this.pendingEntries.length > this.maxPendingLines ||
			this.pendingChars > this.maxPendingChars
		) {
			// Find the first verbose entry, then first important, never critical
			const candidateIdx = this.findEvictableIdx();
			if (candidateIdx < 0) break; // only criticals remain — stop
			const evicted = this.pendingEntries.splice(candidateIdx, 1)[0]!;
			this.pendingChars -= evicted.line.length;
			this.dropStats.count += 1;
			this.dropStats.reason = "pending-buffer-cap";
			this.dropStats.byPriority[evicted.priority] += 1;
		}
	}

	private findEvictableIdx(): number {
		// Prefer evicting from the front of the queue (oldest) within each tier.
		for (const tier of ["verbose", "important"] as FlightPriority[]) {
			const idx = this.pendingEntries.findIndex((e) => e.priority === tier);
			if (idx >= 0) return idx;
		}
		return -1; // only criticals left
	}

	private indexEvent(event: FlightEvent): void {
		this.eventRing.push(event);
		if (this.eventRing.length > this.ringLimit) {
			this.eventRing.splice(0, this.eventRing.length - this.ringLimit);
			// Rebuild indexes after trim so stale keys are removed.
			this.rebuildIndexesFromRing();
			return; // rebuildIndexesFromRing already indexed the new event
		}
		if (event.pathId) {
			const list = this.byPathId.get(event.pathId) ?? [];
			list.push(event);
			this.byPathId.set(event.pathId, list);
		}
		if (event.opId) {
			const list = this.byOpId.get(event.opId) ?? [];
			list.push(event);
			this.byOpId.set(event.opId, list);
		}
	}

	private rebuildIndexesFromRing(): void {
		this.byPathId.clear();
		this.byOpId.clear();
		for (const event of this.eventRing) {
			if (event.pathId) {
				const list = this.byPathId.get(event.pathId) ?? [];
				list.push(event);
				this.byPathId.set(event.pathId, list);
			}
			if (event.opId) {
				const list = this.byOpId.get(event.opId) ?? [];
				list.push(event);
				this.byOpId.set(event.opId, list);
			}
		}
	}

	private enqueueWrite(task: () => Promise<void>): Promise<void> {
		const next = this.writeChain.then(task, task);
		this.writeChain = next.catch(() => undefined);
		return next;
	}

	private sessionDir(): string {
		const day = new Date().toISOString().slice(0, 10);
		return ensurePrefixDir(`${this.logsRoot()}/${day}`);
	}

	private sessionPath(): string {
		return ensurePrefixDir(`${this.sessionDir()}/${this.bootId}-${this.currentFileIndex}.ndjson`);
	}

	private logsRoot(): string {
		return ensurePrefixDir(`${this.app.vault.configDir}/plugins/yaos/flight-logs`);
	}

	/**
	 * Rotate the active file: emit flight.logs.rotated, increment the file
	 * index, and enforce total retention limits.
	 */
	private async rotateFile(): Promise<void> {
		// Emit rotation event into the current file before closing it.
		const rotationEvent: FlightEvent = {
			eventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
			taxonomyVersion: FLIGHT_TAXONOMY_VERSION,
			ts: Date.now(),
			seq: ++this.seq,
			kind: FLIGHT_KIND.flightLogsRotated,
			severity: "info",
			scope: "diagnostics",
			source: "traceRuntime",
			layer: "diagnostics",
			priority: "important",
			traceId: this.traceId,
			bootId: this.bootId,
			deviceId: this.deviceId,
			vaultIdHash: this.vaultIdHash,
			serverHostHash: this.serverHostHash,
			pluginVersion: this.pluginVersion,
			data: {
				fileIndex: this.currentFileIndex,
				bytesWritten: this.bytesWrittenToCurrentFile,
			},
		};
		await this.app.vault.adapter.append(
			this.sessionPath(),
			JSON.stringify(rotationEvent) + "\n",
		);

		// Increment to a new file.
		this.currentFileIndex++;
		this.bytesWrittenToCurrentFile = 0;

		// Enforce total size limit (delete oldest day directories first).
		await this.enforceRetention();
	}

	/**
	 * Delete oldest day-level directories under flight-logs/ until total size
	 * falls below MAX_TOTAL_BYTES.
	 */
	private async enforceRetention(): Promise<void> {
		try {
			const root = this.logsRoot();
			const rootExists = await this.app.vault.adapter.exists(root);
			if (!rootExists) return;

			const listing = await this.app.vault.adapter.list(root);
			const dayDirs = listing.folders
				.map((d) => d.split("/").pop() ?? "")
				.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
				.sort(); // ascending: oldest first

			// Remove directories older than MAX_DAYS.
			const today = new Date().toISOString().slice(0, 10);
			const cutoff = new Date(Date.now() - MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
			for (const dir of dayDirs) {
				if (dir < cutoff) {
					await this.deleteDirectory(`${root}/${dir}`);
				}
			}

			// Check total size; if still over limit, delete oldest day dirs.
			let totalBytes = await this.estimateTotalBytes(root);
			const remainingDirs = dayDirs.filter((d) => d >= cutoff && d !== today);
			for (const dir of remainingDirs) {
				if (totalBytes <= MAX_TOTAL_BYTES) break;
				const dirSize = await this.estimateTotalBytes(`${root}/${dir}`);
				await this.deleteDirectory(`${root}/${dir}`);
				totalBytes -= dirSize;
			}
		} catch {
			// Retention enforcement failures are non-fatal.
		}
	}

	private async estimateTotalBytes(dir: string): Promise<number> {
		try {
			const listing = await this.app.vault.adapter.list(dir);
			let total = 0;
			for (const filePath of listing.files) {
				try {
					const stat = await this.app.vault.adapter.stat(filePath);
					total += stat?.size ?? 0;
				} catch { /* skip */ }
			}
			for (const subDir of listing.folders) {
				total += await this.estimateTotalBytes(subDir);
			}
			return total;
		} catch {
			return 0;
		}
	}

	private async deleteDirectory(dir: string): Promise<void> {
		try {
			const listing = await this.app.vault.adapter.list(dir);
			for (const filePath of listing.files) {
				try {
					await this.app.vault.adapter.remove(filePath);
				} catch { /* skip */ }
			}
			for (const subDir of listing.folders) {
				await this.deleteDirectory(subDir);
			}
			// Remove the now-empty directory (best-effort).
			try {
				await this.app.vault.adapter.rmdir(dir, false);
			} catch { /* ok if not empty or not found */ }
		} catch { /* skip */ }
	}

	/**
	 * Delete all files under the flight-logs root.
	 * Called by "YAOS: Clear flight logs" command.
	 */
	async clearAllLogs(): Promise<void> {
		const root = this.logsRoot();
		await this.deleteDirectory(root);
		this.currentFileIndex = 1;
		this.bytesWrittenToCurrentFile = 0;
	}

	private async ensureDir(dir: string): Promise<void> {
		const normalized = normalizePath(dir);
		if (!normalized) return;
		const parts = normalized.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			try {
				await this.app.vault.adapter.mkdir(current);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.toLowerCase().includes("exists")) continue;
				if (await this.app.vault.adapter.exists(current)) continue;
				throw error;
			}
		}
	}

	// -----------------------------------------------------------------------
	// Privacy guard
	// -----------------------------------------------------------------------

	/**
	 * Deep-scan a data object for sensitive key names.
	 * Returns the first offending key name, or null if clean.
	 */
	private findSensitiveKey(obj: Record<string, unknown>): string | null {
		for (const key of Object.keys(obj)) {
			if (SENSITIVE_DATA_KEYS.has(key)) return key;
			const val = obj[key];
			if (val && typeof val === "object" && !Array.isArray(val)) {
				const nested = this.findSensitiveKey(val as Record<string, unknown>);
				if (nested) return nested;
			}
		}
		return null;
	}

	private findForbiddenKey(obj: Record<string, unknown>): string | null {
		for (const key of Object.keys(obj)) {
			if (ABSOLUTELY_FORBIDDEN_KEYS.has(key)) return key;
			const val = obj[key];
			if (val && typeof val === "object" && !Array.isArray(val)) {
				const nested = this.findForbiddenKey(val as Record<string, unknown>);
				if (nested) return nested;
			}
		}
		return null;
	}

	private recordRedactionFailure(originalKind: string, leakedKey: string): void {
		const event: FlightEvent = {
			eventSchemaVersion: FLIGHT_EVENT_SCHEMA_VERSION,
			taxonomyVersion: FLIGHT_TAXONOMY_VERSION,
			ts: Date.now(),
			seq: ++this.seq,
			kind: FLIGHT_KIND.redactionFailure,
			severity: "error",
			scope: "diagnostics",
			source: "traceRuntime",
			layer: "diagnostics",
			priority: "critical",
			traceId: this.traceId,
			bootId: this.bootId,
			deviceId: this.deviceId,
			vaultIdHash: this.vaultIdHash,
			serverHostHash: this.serverHostHash,
			pluginVersion: this.pluginVersion,
			data: { originalKind, leakedKey },
		};
		const line = JSON.stringify(event) + "\n";
		this.pendingEntries.push({ line, priority: "critical" });
		this.pendingChars += line.length;
		this.scheduleFlush();
	}
}
