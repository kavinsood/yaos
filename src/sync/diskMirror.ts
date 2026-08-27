import { type App, arrayBufferToHex, MarkdownView, TFile, normalizePath } from "obsidian";
import type { VaultSync } from "./vaultSync";
import type { EditorBindingManager } from "./editorBinding";
import type { TraceRecord } from "../observability/traceContext";
import { formatUnknown, yTextToString } from "../utils/format";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	type FrontmatterValidationResult,
} from "./frontmatterGuard";
import { isLocalOrigin } from "./origins";
import { contentBaselineHash } from "./diskIndex";
import { decideClosedFileConflict } from "./closedFileConflict";
import {
	createMarkdownConflictArtifact,
} from "../runtime/reconcile/markdownConflictArtifact";
import { PreservedUnresolvedRegistry, type PreservedUnresolvedEntry, type PreservedUnresolvedReason } from "./preservedUnresolved";
import { safeMarkdownPath } from "./pathPolicy";
export { isLocalOrigin };

export interface DiskSettlementOptions {
	getBaseline(path: string): {
		contentHash: string | null;
		lastDiskIndexPersistedAt?: number;
	} | null;
	commitLocalBody(input: {
		bodyId: string;
		path: string;
		content: string;
		reason: "external-edit" | "delete-revive";
	}): Promise<void>;
	settleClosedBody?(path: string): Promise<void>;
	isPathAllowed?(path: string): boolean;
	isBodyLive?(bodyId: string): boolean;
}

export type DeleteSettlement = "deleted" | "revived" | "preserved-unresolved";


/**
 * Handles writeback from Y.Text -> disk with:
 *   - Remote-only writes (skip local yCollab/seed/disk-sync origins)
 *   - Lazy per-file Y.Text observers
 *   - Concurrency-limited write queue (prevents burst I/O on git pull)
 *   - Loop suppression via timed path suppression
 */

const DEBOUNCE_MS = 300;
const DEBOUNCE_BURST_MS = 1000;
const OPEN_FILE_IDLE_MS = 1500;
const BODY_OBSERVER_RETRY_MS = 100;
const BODY_OBSERVER_RETRY_LIMIT = 100;
const OPEN_FILE_ACTIVE_GRACE_MS = 1200;
const SUPPRESS_MS = 10_000;
const MAX_CONCURRENT_WRITES = 5;
const BURST_THRESHOLD = 20;

function describeOrigin(origin: unknown, provider: unknown): string {
	if (origin === provider) return "provider-remote";
	if (typeof origin === "string") return origin;
	if (origin == null) return "null";
	if (typeof origin === "object") {
		const constructorName =
			(origin as { constructor?: { name?: string } }).constructor?.name;
		return constructorName || "object";
	}
	return formatUnknown(origin);
}

interface SuppressionEntry {
	kind: "write" | "delete";
	expiresAt: number;
	expectedBytes?: number;
	expectedHash?: string;
	remainingAcks?: number;
}

function hashPrefix(hash: string | null | undefined): string | null {
	return typeof hash === "string" ? hash.slice(0, 12) : null;
}


export class DiskMirror {
	private suppressedPaths = new Map<string, SuppressionEntry>();
	private openPaths = new Set<string>();

	/**
	 * Tracks new paths being renamed by DiskMirror in response to remote
	 * metadata changes (handleRemoteRename). Consumed by the vault rename
	 * event handler in main.ts via consumeRemoteRename(), which both reads
	 * and removes the marker in a single call (consume-on-use, matching the
	 * suppressedPaths / consumeDeleteSuppression pattern).
	 */
	private _pendingRemoteRenameNewPaths = new Set<string>();

	/**
	 * Consume the remote-rename marker for `newPath` if present.
	 * Returns true if the rename was DiskMirror-originated (passive receiver).
	 * Removes the marker atomically — safe to call from the vault rename handler.
	 *
	 * @internal Used by main.ts vault rename handler.
	 */
	consumeRemoteRename(newPath: string): boolean {
		const normalized = normalizePath(newPath);
		if (this._pendingRemoteRenameNewPaths.has(normalized)) {
			this._pendingRemoteRenameNewPaths.delete(normalized);
			return true;
		}
		return false;
	}

	/** Deduped write queue. Order doesn't matter — deduplication does. */
	private writeQueue = new Set<string>();
	private forcedWritePaths = new Set<string>();

	/**
	 * Paths where a remote-delete was received but no baseline was available
	 * to verify local state. These files were preserved on disk to avoid data
	 * loss, but must NOT be auto-revived by later import/scan passes.
	 *
	 * A path is removed from this set when:
	 * - The user explicitly edits/creates the file (vault modify/create event)
	 * - The file is deleted locally by the user
	 * - A future remote-delete arrives with a real baseline
	 *
	 * This prevents `importUntrackedFiles()` or reconcile scans from
	 * accidentally resurrecting a legitimately deleted file.
	 */
	private preservedUnresolved: PreservedUnresolvedRegistry;
	readonly preservedUnresolvedPaths: ReadonlySet<string>;
	/** Debounce timers per path. */
	private debounceTimers = new Map<string, number>();
	private openWriteTimers = new Map<string, number>();
	private pendingOpenWrites = new Set<string>();
	private bodyObserverRetryTimers = new Map<string, number>();
	private bodyObserverRetryAttempts = new Map<string, number>();
	/** True while the drain loop is running. */
	private draining = false;
	private drainPromise: Promise<void> | null = null;
	private pathWriteLocks = new Map<string, Promise<void>>();

	/** Per-file Y.Text observers. Only attached for open/active files. */
	private textObservers = new Map<
		string,
		{ ytext: import("yjs").Text; handler: (event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => void }
	>();


	private _flightEventHandler: ((event: Record<string, unknown>) => void) | null = null;

	/**
	 * Called after every successful `flushWrite` with the normalized path and
	 * the SHA-256 content hash of what was written.
	 *
	 * The hash is pre-computed here (where the content is in scope) to keep
	 * the caller free of crypto concerns. Use to update disk index baselines.
	 */
	private _onDiskWriteCallback: ((path: string, contentHash: string) => void) | null = null;

	/**
	 * Per-path timestamp of the most recent successful `flushWrite`. Updated
	 * on every `vault.modify` and `vault.create` we issue. Read by the main
	 * vault.on("modify") handler so `disk.modify.observed` events can carry
	 * a writerGuess (yaos-write vs external) for RCA.
	 */
	private lastDiskWriteOkAt = new Map<string, number>();

	private readonly debug: boolean;
	private settlement: DiskSettlementOptions | null = null;


	constructor(
		private app: App,
		private vaultSync: VaultSync,
		private editorBindings: EditorBindingManager,
		debug: boolean,
		private trace?: TraceRecord,
		private frontmatterGuardEnabled: () => boolean = () => true,
		private onFrontmatterValidated?: (
			path: string,
			direction: "crdt-to-disk",
			reason: "flush-write",
			validation: FrontmatterValidationResult,
			previousContent: string | null,
			nextContent: string,
		) => void,
		private getDeviceName: () => string = () => "unknown-device",
		initialPreservedUnresolved: PreservedUnresolvedEntry[] = [],
		private onPreservedUnresolvedChanged?: () => void,
	) {
		this.debug = debug;
		this.preservedUnresolved = new PreservedUnresolvedRegistry(
			initialPreservedUnresolved.filter((entry) => entry.kind === "markdown"),
		);
		this.preservedUnresolvedPaths = this.preservedUnresolved.paths;
	}

	setFlightEventHandler(handler: (event: Record<string, unknown>) => void): void {
		this._flightEventHandler = handler;
	}

	/**
	 * Register a callback that fires after every successful `flushWrite`.
	 * The callback receives the normalized path and the SHA-256 hash of the
	 * content written (pre-computed in diskMirror to avoid redundant re-reads).
	 * Use this to update content-hash baselines in the disk index.
	 */
	setDiskWriteCallback(callback: (path: string, contentHash: string) => void): void {
		this._onDiskWriteCallback = callback;
	}
	configureSettlement(options: DiskSettlementOptions | null): void {
		this.settlement = options;
	}
	markPendingPath(path: string, bodyId: string): void {
		this.vaultSync.markPendingRenameTarget(normalizePath(path), bodyId);
	}

	clearPendingPath(path: string, bodyId: string): void {
		this.vaultSync.clearPendingRenameTarget(normalizePath(path), bodyId);
	}


	async settleBody(input: {
		path: string;
		bodyId: string;
		generation: number;
		content: string;
	}): Promise<"settled" | "preserved-unresolved"> {
		const path = this.acceptPath(input.path);
		if (!path) return "preserved-unresolved";
		return this.runPathWriteLocked(path, () => this.settleBodyUnlocked({ ...input, path }));
	}
	async discardStaleBody(input: {
		path: string;
		bodyId: string;
		expectedContent: string;
	}): Promise<boolean> {
		const path = this.acceptPath(input.path);
		if (!path) return false;
		return this.runPathWriteLocked(path, async () => {
			if (this.openPaths.has(path) || this.editorBindings.isBound(path)) {
				this.recordPreservedUnresolved(path, "body-open-deferred");
				return false;
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return true;
			let content: string;
			try {
				content = await this.app.vault.read(file);
			} catch {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return false;
			}
			if (content !== input.expectedContent) {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return false;
			}

			this.suppressDelete(path, 2);
			await this.deleteLocalReplica(file);
			this.clearPreservedUnresolved(path);
			this.log(`discarded stale settlement for ${input.bodyId} at "${path}"`);
			return true;
		});
	}
	async settleRename(input: {
		from: string;
		to: string;
		bodyId: string;
		currentContent: string;
	}): Promise<"moved" | "source-absent" | "source-deleted" | "preserved-unresolved"> {
		const from = this.acceptPath(input.from);
		const to = this.acceptPath(input.to);
		if (!from || !to) return "preserved-unresolved";
		const source = this.app.vault.getAbstractFileByPath(from);
		if (!(source instanceof TFile)) return "source-absent";
		const target = this.app.vault.getAbstractFileByPath(to);
		if (target instanceof TFile) {
			const [sourceContent, targetContent] = await Promise.all([
				this.app.vault.read(source),
				this.app.vault.read(target),
			]);
			if (
				sourceContent !== input.currentContent
				|| targetContent !== input.currentContent
				|| this.openPaths.has(from)
				|| this.editorBindings.isBound(from)
			) {
				this.recordPreservedUnresolved(from, "path-collision");
				return "preserved-unresolved";
			}
			this.suppressDelete(from, 2);
			await this.deleteLocalReplica(source);
			this.clearPreservedUnresolved(from);
			this.log(`removed exact previous rename source "${from}" for ${input.bodyId}`);
			return "source-deleted";
		}
		if (target) {
			this.recordPreservedUnresolved(from, "path-collision");
			return "preserved-unresolved";
		}
		await this.moveBodies([{ from, to, bodyId: input.bodyId }]);
		return "moved";
	}


	async moveBodies(moves: Array<{ from: string; to: string; bodyId: string }>): Promise<void> {
		const normalized = moves.map((move) => {
			const from = this.acceptPath(move.from);
			const to = this.acceptPath(move.to);
			if (!from || !to) throw new Error("structural batch contains an unsafe path");
			return { ...move, from, to };
		}).filter((move) => move.from !== move.to);
		if (normalized.length === 0) return;

		const fromPaths = new Set<string>();
		const toPaths = new Set<string>();
		for (const move of normalized) {
			if (fromPaths.has(move.from)) throw new Error(`Duplicate move source: ${move.from}`);
			if (toPaths.has(move.to)) throw new Error(`Duplicate move destination: ${move.to}`);
			fromPaths.add(move.from);
			toPaths.add(move.to);
		}
		for (const move of normalized) {
			const target = this.app.vault.getAbstractFileByPath(move.to);
			if (target && !fromPaths.has(move.to)) {
				throw new Error(`Move destination already exists: ${move.to}`);
			}
		}

		const staged: Array<{
			move: { from: string; to: string; bodyId: string };
			temp: string;
		}> = [];
		const completed: typeof staged = [];
		try {
			for (const move of normalized) {
				const source = this.app.vault.getAbstractFileByPath(move.from);
				if (!(source instanceof TFile)) continue;
				const slash = move.from.lastIndexOf("/");
				const dir = slash >= 0 ? move.from.slice(0, slash + 1) : "";
				let temp: string;
				do {
					temp = `${dir}.yaos-moving-${move.bodyId}-${Math.random().toString(36).slice(2)}.md`;
				} while (this.app.vault.getAbstractFileByPath(temp));
				const content = await this.app.vault.read(source);
				await this.suppressWrite(temp, content, 2);
				this.markPendingPath(temp, move.bodyId);
				this.suppressDelete(move.from, 2);
				this._pendingRemoteRenameNewPaths.add(temp);
				await this.app.fileManager.renameFile(source, temp);
				staged.push({ move, temp });
			}
			for (const item of staged) {
				await this.ensureParentFolder(item.move.to);
				const temporary = this.app.vault.getAbstractFileByPath(item.temp);
				if (!(temporary instanceof TFile)) {
					throw new Error(`Staged move disappeared: ${item.temp}`);
				}
				const content = await this.app.vault.read(temporary);
				await this.suppressWrite(item.move.to, content, 2);
				this.markPendingPath(item.move.to, item.move.bodyId);
				this.suppressDelete(item.temp, 2);
				this._pendingRemoteRenameNewPaths.add(item.move.to);
				await this.app.fileManager.renameFile(temporary, item.move.to);
				this.clearPendingPath(item.temp, item.move.bodyId);
				completed.push(item);
			}
			this.editorBindings.updatePathsAfterRename(
				new Map(normalized.map((move) => [move.from, move.to])),
			);
			this.expireRemoteRenameMarkers([
				...staged.map((item) => item.temp),
				...normalized.map((move) => move.to),
			]);
			for (const move of normalized) this.clearPendingPath(move.to, move.bodyId);
		} catch (error) {
			let rollbackFailed = false;
			for (const item of [...completed].reverse()) {
				const target = this.app.vault.getAbstractFileByPath(item.move.to);
				if (!(target instanceof TFile)) continue;
				try {
					const content = await this.app.vault.read(target);
					await this.suppressWrite(item.move.from, content, 2);
					this.suppressDelete(item.move.to, 2);
					this._pendingRemoteRenameNewPaths.add(item.move.from);
					await this.app.fileManager.renameFile(target, item.move.from);
				} catch {
					rollbackFailed = true;
				}
			}
			for (const item of staged) {
				if (completed.includes(item)) continue;
				const temporary = this.app.vault.getAbstractFileByPath(item.temp);
				if (!(temporary instanceof TFile)) continue;
				try {
					const content = await this.app.vault.read(temporary);
					await this.suppressWrite(item.move.from, content, 2);
					this.suppressDelete(item.temp, 2);
					this._pendingRemoteRenameNewPaths.add(item.move.from);
					await this.app.fileManager.renameFile(temporary, item.move.from);
				} catch {
					rollbackFailed = true;
				}
			}
			if (rollbackFailed) {
				for (const move of normalized) {
					this.recordPreservedUnresolved(move.from, "structural-batch-failed");
					this.recordPreservedUnresolved(move.to, "structural-batch-failed");
				}
			}
			this.expireRemoteRenameMarkers([
				...staged.map((item) => item.temp),
				...normalized.flatMap((move) => [move.from, move.to]),
			]);
			for (const item of staged) this.clearPendingPath(item.temp, item.move.bodyId);
			for (const move of normalized) this.clearPendingPath(move.to, move.bodyId);
			throw error;
		}
	}
	private expireRemoteRenameMarkers(paths: readonly string[]): void {
		window.setTimeout(() => {
			for (const path of paths) this._pendingRemoteRenameNewPaths.delete(path);
		}, SUPPRESS_MS);
	}


	async deleteBody(input: {
		path: string;
		bodyId: string;
		generation: number;
		baselineContent?: string | null;
	}): Promise<DeleteSettlement> {
		const path = this.acceptPath(input.path);
		if (!path) return "preserved-unresolved";
		if (
			this.settlement?.isBodyLive?.(input.bodyId)
			|| this.openPaths.has(path)
			|| this.editorBindings.isBound(path)
		) {
			this.recordPreservedUnresolved(path, "body-open-deferred");
			return "preserved-unresolved";
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.clearPreservedUnresolved(path);
			return "deleted";
		}

		let diskContent: string;
		try {
			diskContent = await this.app.vault.read(file);
		} catch {
			this.recordPreservedUnresolved(path, "remote-delete-read-failed");
			return "preserved-unresolved";
		}
		if (input.baselineContent == null) {
			this.recordPreservedUnresolved(path, "remote-delete-missing-baseline");
			return "preserved-unresolved";
		}
		if (diskContent !== input.baselineContent) {
			if (!this.settlement) {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return "preserved-unresolved";
			}
			try {
				await this.settlement.commitLocalBody({
					bodyId: input.bodyId,
					path,
					content: diskContent,
					reason: "delete-revive",
				});
				this.clearPreservedUnresolved(path);
				return "revived";
			} catch {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
				return "preserved-unresolved";
			}
		}

		this.editorBindings.unbindByPath(path);
		this.suppressDelete(path, 2);
		await this.deleteLocalReplica(file);
		this.clearPreservedUnresolved(path);
		return "deleted";
	}


	private acceptPath(path: string): string | null {
		const canonical = safeMarkdownPath(path);
		if (!canonical || this.settlement?.isPathAllowed?.(canonical) === false) {
			this.log(`disk mutation rejected unsafe path "${path}"`);
			return null;
		}
		return normalizePath(canonical);
	}

	// -------------------------------------------------------------------
	// Map observers (structural: add/delete)
	// -------------------------------------------------------------------


	/**
	 * Reverse-lookup: given a Y.Text instance, find the fileId.
	 * Uses VaultSync's WeakMap for O(1) lookup, with O(n) fallback.
	 */

	// -------------------------------------------------------------------
	// Per-file observers (lazy)
	// -------------------------------------------------------------------

	notifyFileOpened(path: string): void {
		path = normalizePath(path);
		if (
			"acquireEditorBody" in this.vaultSync
			&& typeof this.vaultSync.acquireEditorBody === "function"
		) {
			this.scheduleBodyObserverRetry(path);
		}
		this.trace?.("disk", "notifyFileOpened", { path });
		this.openPaths.add(path);
		if (this.writeQueue.delete(path)) {
			this.forcedWritePaths.delete(path);
			this.scheduleOpenWrite(path);
		}
		const closedTimer = this.debounceTimers.get(path);
		if (closedTimer) {
			window.clearTimeout(closedTimer);
			this.debounceTimers.delete(path);
			this.writeQueue.delete(path);
			this.scheduleOpenWrite(path);
		}
		this.observeText(path);
	}

	notifyFileClosed(path: string): void {
		path = normalizePath(path);
		this.trace?.("disk", "notifyFileClosed", { path });
		this.openPaths.delete(path);
		// Flush any pending debounce for this path
		const bodyRetry = this.bodyObserverRetryTimers.get(path);
		if (bodyRetry !== undefined) window.clearTimeout(bodyRetry);
		this.bodyObserverRetryTimers.delete(path);
		this.bodyObserverRetryAttempts.delete(path);
		const timer = this.debounceTimers.get(path);
		if (timer) {
			window.clearTimeout(timer);
			this.debounceTimers.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		}
		const openTimer = this.openWriteTimers.get(path);
		if (openTimer) {
			window.clearTimeout(openTimer);
			this.openWriteTimers.delete(path);
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		} else if (this.pendingOpenWrites.delete(path)) {
			this.queueImmediateWrite(path, "file-closed");
		}
		this.unobserveText(path);
		if (this.settlement?.settleClosedBody) {
			void this.settlement.settleClosedBody(path).catch(() => {
				this.recordPreservedUnresolved(path, "body-settlement-failed");
			});
		}
	}

	private observeText(path: string): void {
		const ytext = this.vaultSync.getTextForPath(path);
		const existing = this.textObservers.get(path);
		if (!ytext) {
			if (existing) this.unobserveText(path);
			return;
		}
		if (existing?.ytext === ytext) return;
		if (existing) this.unobserveText(path);

		const handler = (_event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => {
			const bodyOrigin = this.vaultSync.getBodyOrigin(path);
			if (isLocalOrigin(txn.origin, bodyOrigin)) return;
			const originLabel = describeOrigin(txn.origin, bodyOrigin);
			this.log(`text observer: remote change to "${path}" (origin=${originLabel})`);
			this.scheduleWrite(path);
		};

		ytext.observe(handler);
		this.textObservers.set(path, { ytext, handler });
		this.bodyObserverRetryAttempts.delete(path);
		this.log(`observeText: watching "${path}" (remote-only)`);
	}

	private scheduleBodyObserverRetry(path: string): void {
		if (this.textObservers.has(path) || this.bodyObserverRetryTimers.has(path)) return;
		const attempts = this.bodyObserverRetryAttempts.get(path) ?? 0;
		if (attempts >= BODY_OBSERVER_RETRY_LIMIT) return;
		this.bodyObserverRetryAttempts.set(path, attempts + 1);
		const timer = window.setTimeout(() => {
			this.bodyObserverRetryTimers.delete(path);
			if (!this.openPaths.has(path)) return;
			this.observeText(path);
			if (!this.textObservers.has(path)) this.scheduleBodyObserverRetry(path);
		}, BODY_OBSERVER_RETRY_MS);
		this.bodyObserverRetryTimers.set(path, timer);
	}
	/** Reattach after a body load or server replacement changes Y.Text identity. */
	notifyBodyAvailable(path: string): void {
		path = normalizePath(path);
		if (this.openPaths.has(path)) this.observeText(path);
	}


	private unobserveText(path: string): void {
		const obs = this.textObservers.get(path);
		if (obs) {
			obs.ytext.unobserve(obs.handler);
			this.textObservers.delete(path);
			this.log(`unobserveText: stopped watching "${path}"`);
		}
	}

	/** Set of currently observed paths (for external cleanup). */
	getObservedPaths(): Set<string> {
		return new Set(this.textObservers.keys());
	}

	// -------------------------------------------------------------------
	// Write scheduling (debounce + concurrency-limited queue)
	// -------------------------------------------------------------------

	scheduleWrite(path: string): void {
		path = normalizePath(path);
		if (this.openPaths.has(path)) {
			this.scheduleOpenWrite(path);
			return;
		}

		this.scheduleClosedWrite(path);
	}

	private scheduleClosedWrite(path: string): void {
		// Clear existing debounce for this path
		const existing = this.debounceTimers.get(path);
		if (existing) window.clearTimeout(existing);

		// Use longer debounce when queue is deep (burst scenario)
		const delay = this.writeQueue.size >= BURST_THRESHOLD ? DEBOUNCE_BURST_MS : DEBOUNCE_MS;

		this.debounceTimers.set(
			path,
			window.setTimeout(() => {
				this.debounceTimers.delete(path);
				this.writeQueue.add(path);
					void this.kickDrain();
			}, delay),
		);
	}

	private scheduleOpenWrite(path: string): void {
		this.pendingOpenWrites.add(path);

		const existing = this.openWriteTimers.get(path);
		if (existing) window.clearTimeout(existing);

		this.openWriteTimers.set(
			path,
				window.setTimeout(() => {
					this.openWriteTimers.delete(path);
					if (!this.pendingOpenWrites.has(path)) return;

					const ytext = this.vaultSync.getTextForPath(path);
					const crdtContent = yTextToString(ytext);
					if (
						this.isActivelyViewedPath(path)
						&& this.hasFocusedEditorUnflushedChanges(path, crdtContent)
					) {
						this.log(`open-write: deferring "${path}" (active editor has unflushed changes)`);
						this.scheduleOpenWrite(path);
						return;
					}

				if (this.hasRecentEditorActivity(path)) {
					this.log(`open-write: deferring "${path}" (recent editor activity)`);
					this.scheduleOpenWrite(path);
					return;
				}

				this.pendingOpenWrites.delete(path);
				this.writeQueue.add(path);
				void this.kickDrain();
			}, OPEN_FILE_IDLE_MS),
		);
	}

	/** Start the drain loop if not already running. */
	private kickDrain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = null;
		});
		return this.drainPromise;
	}

	/**
	 * Drain the write queue with bounded concurrency.
	 * Processes up to MAX_CONCURRENT_WRITES in parallel, then loops.
	 */
	private async drain(): Promise<void> {
		this.draining = true;

		try {
			while (this.writeQueue.size > 0) {
				// If the queue is very deep, log a warning and pause briefly
				if (this.writeQueue.size > BURST_THRESHOLD) {
					this.log(`drain: ${this.writeQueue.size} writes queued (burst), cooling down 200ms`);
					await new Promise((r) => window.setTimeout(r, 200));
				}

				// Take up to MAX_CONCURRENT_WRITES from the queue
				const batch: string[] = [];
				for (const path of this.writeQueue) {
					batch.push(path);
					if (batch.length >= MAX_CONCURRENT_WRITES) break;
				}
				for (const path of batch) {
					this.writeQueue.delete(path);
				}

				// Execute writes in parallel
				await Promise.all(
					batch.map((path) => {
						const force = this.forcedWritePaths.delete(path);
						return this.flushWrite(path, force);
					}),
				);
			}
		} finally {
			this.draining = false;
		}
	}

	private async settleBodyUnlocked(input: {
		path: string;
		bodyId: string;
		generation: number;
		content: string;
	}): Promise<"settled" | "preserved-unresolved"> {
		const { path, bodyId, content } = input;
		if (this.openPaths.has(path) || this.editorBindings.isBound(path)) {
			this.recordPreservedUnresolved(path, "body-open-deferred");
			return "preserved-unresolved";
		}

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) {
			this.recordPreservedUnresolved(path, "path-collision");
			return "preserved-unresolved";
		}
		if (!(existing instanceof TFile)) {
			const written = await this.writeSettledBody(path, null, content);
			if (!written) return "preserved-unresolved";
			this.clearPreservedUnresolved(path);
			this.trace?.("disk", "body-settled", {
				path,
				bodyId,
				generation: input.generation,
				action: "create",
			});
			return "settled";
		}

		let diskContent: string;
		try {
			diskContent = await this.app.vault.read(existing);
		} catch {
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
		const [diskHash, remoteHash] = await Promise.all([
			contentBaselineHash(diskContent),
			contentBaselineHash(content),
		]);
		if (diskHash === remoteHash) {
			this._onDiskWriteCallback?.(path, remoteHash);
			this.clearPreservedUnresolved(path);
			return "settled";
		}

		const baseline = this.settlement?.getBaseline(path) ?? null;
		const decision = decideClosedFileConflict({
			baselineHash: baseline?.contentHash ?? null,
			diskHash,
			crdtHash: remoteHash,
			diskMtime: existing.stat.mtime,
			lastDiskIndexPersistedAt: baseline?.lastDiskIndexPersistedAt,
		});

		if (decision.kind === "apply-remote-to-disk") {
			const written = await this.writeSettledBody(path, diskContent, content);
			if (!written) return "preserved-unresolved";
			this.clearPreservedUnresolved(path);
			return "settled";
		}
		if (decision.kind === "import-disk-to-crdt") {
			return this.commitDiskWinner(bodyId, path, diskContent, "external-edit", diskHash);
		}
		if (decision.kind === "no-op") {
			this._onDiskWriteCallback?.(path, remoteHash);
			this.clearPreservedUnresolved(path);
			return "settled";
		}

		const preservedContent = decision.preserveDisk ? diskContent : content;
		const preservedSource = decision.preserveDisk ? "disk" : "crdt";
		try {
			await createMarkdownConflictArtifact(this.app, path, preservedContent, {
				deviceName: this.getDeviceName(),
				reason: `closed-file-${decision.reason}`,
				source: preservedSource,
				trace: (message: string, details: Record<string, unknown>) =>
					this.trace?.("conflict", message, details),
			});
		} catch {
			this.recordPreservedUnresolved(path, "conflict-artifact-write-failed");
			return "preserved-unresolved";
		}

		if (decision.winner === "disk") {
			return this.commitDiskWinner(bodyId, path, diskContent, "external-edit", diskHash);
		}
		const written = await this.writeSettledBody(path, diskContent, content);
		if (!written) return "preserved-unresolved";
		this.clearPreservedUnresolved(path);
		return "settled";
	}

	private async commitDiskWinner(
		bodyId: string,
		path: string,
		content: string,
		reason: "external-edit" | "delete-revive",
		contentHash: string,
	): Promise<"settled" | "preserved-unresolved"> {
		if (!this.settlement) {
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
		try {
			await this.settlement.commitLocalBody({ bodyId, path, content, reason });
			this._onDiskWriteCallback?.(path, contentHash);
			this.clearPreservedUnresolved(path);
			return "settled";
		} catch {
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return "preserved-unresolved";
		}
	}

	private async writeSettledBody(
		path: string,
		previousContent: string | null,
		content: string,
	): Promise<boolean> {
		if (this.shouldBlockFrontmatterWrite(path, previousContent, content)) {
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return false;
		}
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			await this.suppressWrite(path, content, existing instanceof TFile ? 1 : 2);
			if (existing instanceof TFile) {
				await this.app.vault.modify(existing, content);
			} else {
				await this.ensureParentFolder(path);
				await this.app.vault.create(path, content);
			}
			this.lastDiskWriteOkAt.set(path, Date.now());
			this._onDiskWriteCallback?.(path, await contentBaselineHash(content));
			return true;
		} catch {
			this.recordPreservedUnresolved(path, "body-settlement-failed");
			return false;
		}
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash < 0) return;
		const parts = path.slice(0, slash).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
			} else if (existing instanceof TFile) {
				throw new Error(`Cannot create sync folder over file: ${current}`);
			}
		}
	}

	// -------------------------------------------------------------------
	// Disk write
	// -------------------------------------------------------------------

	async flushWrite(path: string, force = false): Promise<void> {
		path = normalizePath(path);
		return this.runPathWriteLocked(path, () => this.flushWriteUnlocked(path, force));
	}

	private async flushWriteUnlocked(path: string, force: boolean): Promise<void> {
		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) {
			this.log(`flushWrite: no Y.Text for "${path}", skipping`);
			return;
		}
		const content = ytext.toJSON();

		if (!force && this.openPaths.has(path)) {
			if (
				this.isActivelyViewedPath(path)
				&& this.hasFocusedEditorUnflushedChanges(path, content)
			) {
				this.log(`flushWrite: deferring open "${path}" (active editor has unflushed changes)`);
				this.scheduleOpenWrite(path);
				return;
			}
			if (this.hasRecentEditorActivity(path)) {
				this.log(`flushWrite: deferring open "${path}" (recent editor activity)`);
				this.scheduleOpenWrite(path);
				return;
			}
		}

		const normalized = normalizePath(path);

		try {
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing instanceof TFile) {
				const currentContent = await this.app.vault.read(existing);
				if (currentContent === content) {
					this.log(`flushWrite: "${path}" unchanged, skipping`);
					return;
				}
				if (this.shouldBlockFrontmatterWrite(path, currentContent, content)) {
					return;
				}

				await this.suppressWrite(path, content, 1);
				await this.app.vault.modify(existing, content);
				this.log(`flushWrite: updated "${path}" (${content.length} chars)`);
				this.lastDiskWriteOkAt.set(normalized, Date.now());
				this._onDiskWriteCallback?.(normalized, await contentBaselineHash(content));
				this._flightEventHandler?.({
					priority: "important",
					kind: "disk.write.ok",
					severity: "info",
					scope: "file",
					source: "diskMirror",
					layer: "disk",
					path: normalized,
					data: { contentLength: content.length, isCreate: false },
				});
			} else {
				if (this.shouldBlockFrontmatterWrite(path, null, content)) {
					return;
				}
				await this.suppressWrite(path, content, 2);
				const dir = normalized.substring(0, normalized.lastIndexOf("/"));
				if (dir) {
					const dirExists =
						this.app.vault.getAbstractFileByPath(normalizePath(dir));
					if (!dirExists) {
						await this.app.vault.createFolder(dir);
					}
				}
				await this.app.vault.create(normalized, content);
				this.log(
					`flushWrite: created "${path}" on disk (${content.length} chars)`,
				);
				this.lastDiskWriteOkAt.set(normalized, Date.now());
				this._onDiskWriteCallback?.(normalized, await contentBaselineHash(content));
				this._flightEventHandler?.({
					priority: "important",
					kind: "disk.write.ok",
					severity: "info",
					scope: "file",
					source: "diskMirror",
					layer: "disk",
					path: normalized,
					data: { contentLength: content.length, isCreate: true },
				});
			}
		} catch (err) {
			console.error(`[yaos] flushWrite failed for "${path}":`, err);
			this._flightEventHandler?.({
				priority: "critical",
				kind: "disk.write.failed",
				severity: "error",
				scope: "file",
				source: "diskMirror",
				layer: "disk",
				path: normalized,
				data: { error: err instanceof Error ? err.message : String(err) },
			});
		}
	}

	private shouldBlockFrontmatterWrite(
		path: string,
		previousContent: string | null,
		nextContent: string,
	): boolean {
		if (!this.frontmatterGuardEnabled()) return false;

		const validation = validateFrontmatterTransition(previousContent, nextContent);
		this.onFrontmatterValidated?.(
			path,
			"crdt-to-disk",
			"flush-write",
			validation,
			previousContent,
			nextContent,
		);
		if (!isFrontmatterBlocked(validation)) return false;

		this.log(
			`frontmatter write blocked for "${path}" ` +
			`(${validation.reasons.join(", ") || validation.risk})`,
		);
		return true;
	}



	private async deleteLocalReplica(file: TFile): Promise<"trash"> {
		await this.app.fileManager.trashFile(file);
		return "trash";
	}

	// -------------------------------------------------------------------
	// Suppression
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		return this.getActiveSuppression(path) !== null;
	}

	/**
	 * Per-path timestamp of the most recent successful YAOS-issued
	 * `flushWrite`. Returns null if YAOS has never written this path in
	 * this session. Used by main.ts to label `disk.modify.observed` events
	 * with writer attribution.
	 */
	getLastDiskWriteOkAt(path: string): number | null {
		const v = this.lastDiskWriteOkAt.get(normalizePath(path));
		return v === undefined ? null : v;
	}

	async shouldSuppressModify(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "modify");
	}

	async shouldSuppressCreate(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "create");
	}

	consumeDeleteSuppression(path: string): boolean {
		path = normalizePath(path);
		const entry = this.getActiveSuppression(path);
		if (!entry || entry.kind !== "delete") return false;
		const remaining = Math.max(0, (entry.remainingAcks ?? 1) - 1);
		if (remaining === 0) this.suppressedPaths.delete(path);
		else entry.remainingAcks = remaining;
		return true;
	}

	/**
	 * Returns true if this path was preserved during a remote-delete because
	 * no baseline was available to verify local state.
	 *
	 * Callers (importUntrackedFiles, reconcile scans) MUST check this before
	 * auto-reviving tombstones for local files.
	 */
	isPreservedUnresolved(path: string): boolean {
		return this.preservedUnresolvedPaths.has(normalizePath(path));
	}

	/**
	 * Clear the preserved-unresolved marker for a path. Called when evidence
	 * arrives that the user intentionally wants this file to exist:
	 * - User explicitly edits the file (vault modify event, not suppressed)
	 * - User creates a new file at this path
	 * - User deletes the file locally
	 * - A future remote-delete arrives with a real baseline
	 */
	clearPreservedUnresolved(path: string): void {
		const normalized = normalizePath(path);
		if (this.preservedUnresolved.resolve(normalized)) {
			this.onPreservedUnresolvedChanged?.();
			this.trace?.("disk", "preserved-unresolved-cleared", {
				path: normalized,
				reason: "user-action-or-baseline-available",
			});
		}
	}

	recordPreservedUnresolved(
		path: string,
		reason: PreservedUnresolvedReason,
	): void {
		this.preservedUnresolved.record({
			path: normalizePath(path),
			kind: "markdown",
			reason,
		});
		this.onPreservedUnresolvedChanged?.();
	}

	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[] {
		return this.preservedUnresolved.getEntries();
	}

	async flushOpenWrites(reason: string): Promise<void> {
		const targets = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			targets.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			targets.add(path);
		}
		if (targets.size === 0) return;

		for (const path of targets) {
			const timer = this.openWriteTimers.get(path);
			if (timer) {
				window.clearTimeout(timer);
				this.openWriteTimers.delete(path);
			}
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, reason, true);
		}

		await this.kickDrain();
	}

	async flushOpenPath(path: string, reason: string): Promise<void> {
		path = normalizePath(path);
		const timer = this.openWriteTimers.get(path);
		const hadTimer = !!timer;
		if (timer) {
			window.clearTimeout(timer);
			this.openWriteTimers.delete(path);
		}
		const wasPending = this.pendingOpenWrites.delete(path);
		const wasQueued = this.writeQueue.has(path);
		if (!wasPending && !hadTimer && !wasQueued) {
			return;
		}
		this.queueImmediateWrite(path, reason, true);
		await this.kickDrain();
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get activeObserverCount(): number {
		return this.textObservers.size;
	}

	get pendingWriteCount(): number {
		return (
			this.writeQueue.size
			+ this.debounceTimers.size
			+ this.openWriteTimers.size
		);
	}

	getDebugSnapshot(): {
		observedPaths: string[];
		openPaths: string[];
		openPendingPaths: string[];
		queuedWrites: string[];
		debounceCount: number;
		openDebounceCount: number;
		suppressedCount: number;
		preservedUnresolved: ReturnType<PreservedUnresolvedRegistry["getSummary"]>;
	} {
		return {
			observedPaths: Array.from(this.textObservers.keys()),
			openPaths: Array.from(this.openPaths.keys()),
			openPendingPaths: Array.from(this.pendingOpenWrites.keys()),
			queuedWrites: Array.from(this.writeQueue.keys()),
			debounceCount: this.debounceTimers.size,
			openDebounceCount: this.openWriteTimers.size,
			suppressedCount: this.suppressedPaths.size,
			preservedUnresolved: this.preservedUnresolved.getSummary(),
		};
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

	/**
	 * Flush all pending writes and await completion before teardown.
	 *
	 * Safe ordering for plugin unload:
	 *   1. flushAllPendingWrites()  ← all writes complete, callbacks fire, hashes recorded
	 *   2. caller saves disk index  ← persists content hashes to data.json
	 *   3. destroy()                ← nothing pending, safe to clear state
	 *
	 * Covers:
	 *   - writeQueue (debounced bulk writes)
	 *   - pendingOpenWrites / openWriteTimers (deferred editor writes)
	 *   - existing drain promise (if already draining)
	 */
	async flushAllPendingWrites(): Promise<void> {
		// 1. Flush all pending open-file writes immediately (cancel their timers,
		//    flush now with force=true so editor guards don't defer again).
		const openPending = new Set<string>([
			...this.pendingOpenWrites,
			...this.openWriteTimers.keys(),
		]);
		for (const timer of this.openWriteTimers.values()) {
			window.clearTimeout(timer);
		}
		this.openWriteTimers.clear();
		this.pendingOpenWrites.clear();
		if (openPending.size > 0) {
			await Promise.all([...openPending].map((p) => this.flushWrite(p, true)));
		}

		// 2. Also flush anything sitting in the debounce timer queue (those
		//    haven't made it into writeQueue yet).
		const debouncePending = new Set<string>(this.debounceTimers.keys());
		for (const timer of this.debounceTimers.values()) {
			window.clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const path of debouncePending) {
			this.writeQueue.add(path);
		}

		// 3. Drain the write queue. If a drain is already running, await it
		//    then do one more pass to catch any items added during this flush.
		if (this.drainPromise) {
			await this.drainPromise;
		}
		if (this.writeQueue.size > 0) {
			await this.kickDrain();
		}

		// 4. Await any outstanding per-path write locks.
		if (this.pathWriteLocks.size > 0) {
			await Promise.allSettled(this.pathWriteLocks.values());
		}
	}

	destroy(): void {
		const pendingFinalWrites = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			pendingFinalWrites.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			pendingFinalWrites.add(path);
		}
		for (const path of pendingFinalWrites) {
			void this.flushWrite(path, true);
		}


		for (const [, obs] of this.textObservers) {
			obs.ytext.unobserve(obs.handler);
		}
		this.textObservers.clear();

		for (const timer of this.debounceTimers.values()) {
			window.clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.openWriteTimers.values()) {
			window.clearTimeout(timer);
		}
		this.openWriteTimers.clear();
		for (const timer of this.bodyObserverRetryTimers.values()) {
			window.clearTimeout(timer);
		}
		this.bodyObserverRetryTimers.clear();
		this.bodyObserverRetryAttempts.clear();

		this.writeQueue.clear();
		this.pendingOpenWrites.clear();
		this.openPaths.clear();
		this.forcedWritePaths.clear();
		this.suppressedPaths.clear();
		this.preservedUnresolved.clear();
		this.pathWriteLocks.clear();
		this.lastDiskWriteOkAt.clear();
		this.log("DiskMirror destroyed");
	}

	private log(msg: string): void {
		this.trace?.("disk", msg);
		if (this.debug) {
			console.debug(`[yaos:disk] ${msg}`);
		}
	}

	private hasRecentEditorActivity(path: string): boolean {
		const lastEditorActivity = this.editorBindings.getLastEditorActivityForPath(path);
		if (lastEditorActivity == null) return false;
		return Date.now() - lastEditorActivity < OPEN_FILE_ACTIVE_GRACE_MS;
	}

	private hasFocusedEditorUnflushedChanges(path: string, expectedCrdtContent: string | null): boolean {
		if (expectedCrdtContent == null) return false;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file?.path !== path) return false;
		try {
			return activeView.editor.getValue() !== expectedCrdtContent;
		} catch {
			// If the editor instance is in flux, conservatively defer one cycle.
			return true;
		}
	}

	private isActivelyViewedPath(path: string): boolean {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			return false;
		}
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path === path;
	}

	private queueImmediateWrite(path: string, reason: string, force = false): void {
		path = normalizePath(path);
		if (force) {
			this.forcedWritePaths.add(path);
		}
		this.writeQueue.add(path);
		this.log(`queueImmediateWrite: "${path}" (${reason}${force ? ", forced" : ""})`);
		void this.kickDrain();
	}

	private getActiveSuppression(path: string): SuppressionEntry | null {
		path = normalizePath(path);
		const entry = this.suppressedPaths.get(path);
		if (!entry) return null;
		if (Date.now() < entry.expiresAt) {
			return entry;
		}
		this.suppressedPaths.delete(path);
		return null;
	}

	private async suppressWrite(path: string, content: string, remainingAcks = 1): Promise<void> {
		// Record the exact content before mutation so create/modify event order is
		// irrelevant and each matching Obsidian event consumes one acknowledgement.
		const fingerprint = await this.fingerprintContent(content);
		this.suppressedPaths.set(normalizePath(path), {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
			remainingAcks,
		});
	}

	private suppressDelete(path: string, remainingAcks = 1): void {
		this.suppressedPaths.set(normalizePath(path), {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
			remainingAcks,
		});
	}

	private async shouldSuppressWriteEvent(
		file: TFile,
		event: "modify" | "create",
	): Promise<boolean> {
		const path = normalizePath(file.path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;

		if (entry.kind !== "write") {
			this.suppressedPaths.delete(path);
			this.log(`suppression: "${path}" ${event} did not match pending delete`);
			this.trace?.("disk", "suppression-mismatch", {
				path,
				event,
				expectedKind: entry.kind,
				observedKind: "write",
				reason: "kind-mismatch",
			});
			this._flightEventHandler?.({
				priority: "critical",
				kind: "disk.event.not_suppressed",
				severity: "warn",
				scope: "file",
				source: "diskMirror",
				layer: "disk",
				path,
				data: { event, reason: "kind-mismatch", expectedKind: entry.kind },
			});
			return false;
		}


		try {
			// Read back the file only when a suppression candidate exists. This
			// keeps the hot path cheap while making self-event detection causal.
			const content = await this.app.vault.read(file);
			const fingerprint = await this.fingerprintContent(content);
			if (
				fingerprint.bytes === entry.expectedBytes
				&& fingerprint.hash === entry.expectedHash
			) {
				const remaining = Math.max(0, (entry.remainingAcks ?? 1) - 1);
				if (remaining === 0) this.suppressedPaths.delete(path);
				else entry.remainingAcks = remaining;
				this.log(`suppression: acknowledged "${path}" ${event} (${remaining} remaining)`);
				this.trace?.("disk", "suppression-acknowledged", {
					path,
					event,
					kind: entry.kind,
					expectedBytes: entry.expectedBytes,
					expectedHashPrefix: hashPrefix(entry.expectedHash),
					remainingAcks: remaining,
				});
				return true;
			}
		} catch (err) {
			this.trace?.("disk", "suppression-mismatch", {
				path,
				event,
				expectedKind: entry.kind,
				reason: "read-failed",
				error: formatUnknown(err),
			});
			// If the file cannot be read here, fall through and let normal sync handle it.
		}

		this.suppressedPaths.delete(path);
		this.log(`suppression: "${path}" ${event} fingerprint mismatch`);
		this.trace?.("disk", "suppression-mismatch", {
			path,
			event,
			expectedKind: entry.kind,
			expectedBytes: entry.expectedBytes,
			expectedHashPrefix: hashPrefix(entry.expectedHash),
			reason: "fingerprint-mismatch",
		});
		this._flightEventHandler?.({
			priority: "critical",
			kind: "disk.event.not_suppressed",
			severity: "warn",
			scope: "file",
			source: "diskMirror",
			layer: "disk",
			path,
			data: {
				event,
				reason: "fingerprint-mismatch",
				expectedBytes: entry.expectedBytes,
				expectedHashPrefix: hashPrefix(entry.expectedHash),
			},
		});
		return false;
	}

	private async fingerprintContent(content: string): Promise<{ bytes: number; hash: string }> {
		const bytes = new TextEncoder().encode(content);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return {
			bytes: bytes.length,
			hash: arrayBufferToHex(digest),
		};
	}

	private runPathWriteLocked<T>(path: string, work: () => Promise<T>): Promise<T> {
		// All flush paths funnel through one per-path promise chain so direct
		// flushes cannot overlap with queued writes for the same file.
		const previous = this.pathWriteLocks.get(path) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		let tracked: Promise<void>;
		tracked = next.then(
			() => undefined,
			() => undefined,
		).finally(() => {
			if (this.pathWriteLocks.get(path) === tracked) {
				this.pathWriteLocks.delete(path);
			}
		});
		this.pathWriteLocks.set(path, tracked);
		return next;
	}
}
