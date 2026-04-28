import { type App, arrayBufferToHex, MarkdownView, TFile, normalizePath } from "obsidian";
import * as Y from "yjs";
import type { VaultSync } from "./vaultSync";
import type { EditorBindingManager } from "./editorBinding";
import { ORIGIN_SEED } from "../types";
import { ORIGIN_RESTORE } from "./snapshotClient";
import type { TraceRecord } from "../debug/trace";
import { formatUnknown, yTextToString } from "../utils/format";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
	type FrontmatterValidationResult,
} from "./frontmatterGuard";

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
const OPEN_FILE_ACTIVE_GRACE_MS = 1200;
const SUPPRESS_MS = 500;
const MAX_CONCURRENT_WRITES = 5;
const BURST_THRESHOLD = 20;

/** String origins that should NOT trigger a disk write. */
const LOCAL_STRING_ORIGINS = new Set([
	ORIGIN_SEED,
	"disk-sync",
	ORIGIN_RESTORE,
]);

/**
 * Determine whether a Yjs transaction origin is local (should NOT trigger
 * a disk write).
 *
 * The sync provider applies remote updates with `transactionOrigin = provider`.
 * y-codemirror applies local editor updates with `transactionOrigin = YSyncConfig`.
 *
 * We only treat provider-origin transactions as remote.
 */
function isLocalOrigin(origin: unknown, provider: unknown): boolean {
	if (origin === provider) return false; // remote update from server
	if (typeof origin === "string") return LOCAL_STRING_ORIGINS.has(origin);
	if (origin == null) return true; // local transact() without explicit origin
	// Non-null object origins (e.g. y-codemirror's YSyncConfig) are local.
	return true;
}

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
}

export class DiskMirror {
	private suppressedPaths = new Map<string, SuppressionEntry>();
	private openPaths = new Set<string>();

	/** Deduped write queue. Order doesn't matter — deduplication does. */
	private writeQueue = new Set<string>();
	private forcedWritePaths = new Set<string>();
	/** Debounce timers per path. */
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private openWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingOpenWrites = new Set<string>();
	/** True while the drain loop is running. */
	private draining = false;
	private drainPromise: Promise<void> | null = null;
	private pathWriteLocks = new Map<string, Promise<void>>();

	/** Per-file Y.Text observers. Only attached for open/active files. */
	private textObservers = new Map<
		string,
		{ ytext: import("yjs").Text; handler: (event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => void }
	>();

	private mapObserverCleanups: (() => void)[] = [];

	private readonly debug: boolean;

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
		private isMarkdownPathSyncable: (path: string) => boolean = () => true,
	) {
		this.debug = debug;
	}

	private isPathSyncable(path: string): boolean {
		return this.isMarkdownPathSyncable(normalizePath(path));
	}

	private clearPendingWrites(path: string): void {
		const normalized = normalizePath(path);
		this.pendingOpenWrites.delete(normalized);
		this.writeQueue.delete(normalized);
		this.forcedWritePaths.delete(normalized);

		const pending = this.debounceTimers.get(normalized);
		if (pending) {
			clearTimeout(pending);
			this.debounceTimers.delete(normalized);
		}

		const openPending = this.openWriteTimers.get(normalized);
		if (openPending) {
			clearTimeout(openPending);
			this.openWriteTimers.delete(normalized);
		}
	}

	// -------------------------------------------------------------------
	// Map observers (structural: add/delete)
	// -------------------------------------------------------------------

	startMapObservers(): void {
		const metaObserver = (event: import("yjs").YMapEvent<import("../types").FileMeta>) => {
			if (isLocalOrigin(event.transaction.origin, this.vaultSync.provider)) {
				return;
			}
			event.changes.keys.forEach((change, fileId) => {
				const oldMeta = change.oldValue as import("../types").FileMeta | undefined;
				const newMeta = this.vaultSync.meta.get(fileId);
				const oldPath = typeof oldMeta?.path === "string" ? normalizePath(oldMeta.path) : null;
				const newPath = typeof newMeta?.path === "string" ? normalizePath(newMeta.path) : null;
				const wasDeleted = this.vaultSync.isFileMetaDeleted(oldMeta);
				const isDeleted = this.vaultSync.isFileMetaDeleted(newMeta);

				// Remote tombstone transition.
				if (newPath && isDeleted && !wasDeleted) {
					void this.handleRemoteDelete(newPath);
					return;
				}

				// Remote undelete/restore transition.
				if (newPath && !isDeleted && wasDeleted) {
					this.scheduleWrite(newPath);
					return;
				}

				// Remote rename/move transition from meta.path.
				if (oldPath && newPath && oldPath !== newPath && !isDeleted) {
					void this.handleRemoteRename(oldPath, newPath);
					return;
				}

				// Remote create/update where the file is active.
				if ((change.action === "add" || change.action === "update") && newPath && !isDeleted) {
					this.scheduleWrite(newPath);
				}
			});
		};
		this.vaultSync.meta.observe(metaObserver);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.meta.unobserve(metaObserver),
		);

		// ---------------------------------------------------------------
		// afterTransaction: catch remote content edits to CLOSED files.
		//
		// Per-file Y.Text observers only cover open files. When a remote
		// device edits a note that is closed locally, the Y.Text changes
		// in memory but nothing writes it to disk. This handler inspects
		// every non-local transaction for changed Y.Text instances,
		// reverse-maps them to paths, and schedules writes for any path
		// that doesn't already have a per-file observer (i.e. closed).
		// ---------------------------------------------------------------
		const afterTxnHandler = (txn: Y.Transaction) => {
			if (isLocalOrigin(txn.origin, this.vaultSync.provider)) return;

			for (const [changedType] of txn.changed) {
				if (!(changedType instanceof Y.Text)) continue;

				// Reverse lookup: find the fileId that owns this Y.Text
				const fileId = this.findFileIdForText(changedType);
				if (!fileId) continue;

				// Map fileId → path via meta (pathToId is path→id, not id→path)
				const meta = this.vaultSync.meta.get(fileId);
				if (!meta || this.vaultSync.isFileMetaDeleted(meta)) continue;

				const path = normalizePath(meta.path);
				if (!this.isPathSyncable(path)) continue;

					// Skip if this path is already open (handled by per-file observer policy)
					if (this.openPaths.has(path)) continue;

				this.log(`afterTxn: remote content change to closed file "${path}"`);
				this.scheduleWrite(path);
			}
		};
		this.vaultSync.ydoc.on("afterTransaction", afterTxnHandler);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.ydoc.off("afterTransaction", afterTxnHandler),
		);

		this.log("Map observers started");
	}

	/**
	 * Reverse-lookup: given a Y.Text instance, find the fileId.
	 * Uses VaultSync's WeakMap for O(1) lookup, with O(n) fallback.
	 */
	private findFileIdForText(ytext: Y.Text): string | null {
		// Fast path: WeakMap lookup
		const cached = this.vaultSync.getFileIdForText(ytext);
		if (cached) return cached;

		// Slow fallback: scan idToText (should rarely happen)
		for (const [fileId, text] of this.vaultSync.idToText.entries()) {
			if (text === ytext) return fileId;
		}
		return null;
	}

	// -------------------------------------------------------------------
	// Per-file observers (lazy)
	// -------------------------------------------------------------------

	notifyFileOpened(path: string): void {
		path = normalizePath(path);
		this.trace?.("disk", "notifyFileOpened", { path });
		this.openPaths.add(path);
		if (this.writeQueue.delete(path)) {
			this.forcedWritePaths.delete(path);
			this.scheduleOpenWrite(path);
		}
		const closedTimer = this.debounceTimers.get(path);
		if (closedTimer) {
			clearTimeout(closedTimer);
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
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		}
		const openTimer = this.openWriteTimers.get(path);
		if (openTimer) {
			clearTimeout(openTimer);
			this.openWriteTimers.delete(path);
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		} else if (this.pendingOpenWrites.delete(path)) {
			this.queueImmediateWrite(path, "file-closed");
		}
		this.unobserveText(path);
	}

	private observeText(path: string): void {
		if (this.textObservers.has(path)) return;

		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) return;

		const handler = (_event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => {
			if (isLocalOrigin(txn.origin, this.vaultSync.provider)) return;
			const originLabel = describeOrigin(txn.origin, this.vaultSync.provider);
			this.log(`text observer: remote change to "${path}" (origin=${originLabel})`);
			this.scheduleWrite(path);
		};

		ytext.observe(handler);
		this.textObservers.set(path, { ytext, handler });
		this.log(`observeText: watching "${path}" (remote-only)`);
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
		if (!this.isPathSyncable(path)) {
			this.clearPendingWrites(path);
			this.log(`scheduleWrite: "${path}" outside sync scope, skipping`);
			return;
		}
		if (this.openPaths.has(path)) {
			this.scheduleOpenWrite(path);
			return;
		}

		this.scheduleClosedWrite(path);
	}

	private scheduleClosedWrite(path: string): void {
		// Clear existing debounce for this path
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);

		// Use longer debounce when queue is deep (burst scenario)
		const delay = this.writeQueue.size >= BURST_THRESHOLD ? DEBOUNCE_BURST_MS : DEBOUNCE_MS;

		this.debounceTimers.set(
			path,
			setTimeout(() => {
				this.debounceTimers.delete(path);
				this.writeQueue.add(path);
					void this.kickDrain();
			}, delay),
		);
	}

	private scheduleOpenWrite(path: string): void {
		this.pendingOpenWrites.add(path);

		const existing = this.openWriteTimers.get(path);
		if (existing) clearTimeout(existing);

		this.openWriteTimers.set(
			path,
				setTimeout(() => {
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
					await new Promise((r) => setTimeout(r, 200));
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

	// -------------------------------------------------------------------
	// Disk write
	// -------------------------------------------------------------------

	async flushWrite(path: string, force = false): Promise<void> {
		path = normalizePath(path);
		if (!this.isPathSyncable(path)) {
			this.clearPendingWrites(path);
			this.log(`flushWrite: "${path}" outside sync scope, skipping`);
			return;
		}
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

				await this.suppressWrite(path, content);
				await this.app.vault.modify(existing, content);
				this.log(`flushWrite: updated "${path}" (${content.length} chars)`);
			} else {
				if (this.shouldBlockFrontmatterWrite(path, null, content)) {
					return;
				}
				await this.suppressWrite(path, content);
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
			}
		} catch (err) {
			console.error(`[yaos] flushWrite failed for "${path}":`, err);
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

	private async handleRemoteDelete(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.isPathSyncable(normalized)) {
			this.clearPendingWrites(normalized);
			this.log(`handleRemoteDelete: "${normalized}" outside sync scope, skipping`);
			return;
		}
		const wasOpen = this.openPaths.has(normalized);
		const wasObserved = this.textObservers.has(normalized);
		const wasSuppressed = this.isSuppressed(normalized);
		this.unobserveText(normalized);
		this.openPaths.delete(normalized);
		this.clearPendingWrites(normalized);
		this.trace?.("disk", "remote-delete", {
			path,
			normalizedPath: normalized,
			wasOpen,
			wasObserved,
			wasSuppressed,
		});
		// Unbind editor before suppressed delete so the vault `delete` event
		// (which skips unbind due to suppression) doesn't leave a stale binding.
		this.editorBindings.unbindByPath(normalized);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			try {
				this.suppressDelete(path);
				await this.app.vault.delete(file);
				this.log(`handleRemoteDelete: deleted "${path}" from disk`);
			} catch (err) {
				console.error(
					`[yaos] handleRemoteDelete failed for "${path}":`,
					err,
				);
			}
		}
	}

	private async handleRemoteRename(oldPath: string, newPath: string): Promise<void> {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		if (oldNormalized === newNormalized) return;
		if (!this.isPathSyncable(oldNormalized) || !this.isPathSyncable(newNormalized)) {
			this.clearPendingWrites(oldNormalized);
			this.clearPendingWrites(newNormalized);
			this.log(`handleRemoteRename: "${oldNormalized}" -> "${newNormalized}" outside sync scope, skipping`);
			return;
		}

		const wasOpen = this.openPaths.delete(oldNormalized);
		if (wasOpen) {
			this.openPaths.add(newNormalized);
		}
		this.pendingOpenWrites.delete(oldNormalized);

		const oldDebounce = this.debounceTimers.get(oldNormalized);
		if (oldDebounce) {
			clearTimeout(oldDebounce);
			this.debounceTimers.delete(oldNormalized);
		}
		const oldOpenDebounce = this.openWriteTimers.get(oldNormalized);
		if (oldOpenDebounce) {
			clearTimeout(oldOpenDebounce);
			this.openWriteTimers.delete(oldNormalized);
		}

		this.writeQueue.delete(oldNormalized);
		this.forcedWritePaths.delete(oldNormalized);
		this.unobserveText(oldNormalized);

		this.editorBindings.updatePathsAfterRename(new Map([[oldNormalized, newNormalized]]));

		const oldFile = this.app.vault.getAbstractFileByPath(oldNormalized);
		if (oldFile instanceof TFile) {
			try {
				const target = this.app.vault.getAbstractFileByPath(newNormalized);
				if (target instanceof TFile) {
					this.suppressDelete(oldNormalized);
					await this.app.vault.delete(oldFile);
				} else {
					const dir = newNormalized.substring(0, newNormalized.lastIndexOf("/"));
					if (dir) {
						const dirNode = this.app.vault.getAbstractFileByPath(normalizePath(dir));
						if (!dirNode) {
							await this.app.vault.createFolder(dir);
						}
					}
					await this.app.fileManager.renameFile(oldFile, newNormalized);
				}
				this.log(`handleRemoteRename: "${oldNormalized}" -> "${newNormalized}"`);
			} catch (err) {
				console.error(`[yaos] handleRemoteRename failed for "${oldNormalized}" -> "${newNormalized}":`, err);
			}
		}

		if (wasOpen) {
			this.observeText(newNormalized);
			this.scheduleOpenWrite(newNormalized);
		} else {
			this.scheduleWrite(newNormalized);
		}
	}

	// -------------------------------------------------------------------
	// Suppression
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		return this.getActiveSuppression(path) !== null;
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
		if (!entry) return false;

		this.suppressedPaths.delete(path);
		return entry.kind === "delete";
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
				clearTimeout(timer);
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
			clearTimeout(timer);
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
	} {
		return {
			observedPaths: Array.from(this.textObservers.keys()),
			openPaths: Array.from(this.openPaths.keys()),
			openPendingPaths: Array.from(this.pendingOpenWrites.keys()),
			queuedWrites: Array.from(this.writeQueue.keys()),
			debounceCount: this.debounceTimers.size,
			openDebounceCount: this.openWriteTimers.size,
			suppressedCount: this.suppressedPaths.size,
		};
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

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

		for (const cleanup of this.mapObserverCleanups) {
			cleanup();
		}
		this.mapObserverCleanups = [];

		for (const [, obs] of this.textObservers) {
			obs.ytext.unobserve(obs.handler);
		}
		this.textObservers.clear();

		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.openWriteTimers.values()) {
			clearTimeout(timer);
		}
		this.openWriteTimers.clear();

		this.writeQueue.clear();
		this.pendingOpenWrites.clear();
		this.openPaths.clear();
		this.forcedWritePaths.clear();
		this.suppressedPaths.clear();
		this.pathWriteLocks.clear();
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

	private async suppressWrite(path: string, content: string): Promise<void> {
		// Record the exact content we wrote so vault modify/create events can
		// acknowledge our own write by observed state, not just timing.
		const fingerprint = await this.fingerprintContent(content);
		this.suppressedPaths.set(normalizePath(path), {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
		});
	}

	private suppressDelete(path: string): void {
		this.suppressedPaths.set(normalizePath(path), {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
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
			return false;
		}

		if (
			typeof file.stat?.size === "number"
			&& typeof entry.expectedBytes === "number"
			&& file.stat.size !== entry.expectedBytes
		) {
			this.suppressedPaths.delete(path);
			this.log(
				`suppression: "${path}" ${event} size mismatch ` +
				`(expected=${entry.expectedBytes}, observed=${file.stat.size})`,
			);
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
				this.suppressedPaths.delete(path);
				this.log(`suppression: acknowledged "${path}" ${event}`);
				return true;
			}
		} catch {
			// If the file cannot be read here, fall through and let normal sync handle it.
		}

		this.suppressedPaths.delete(path);
		this.log(`suppression: "${path}" ${event} fingerprint mismatch`);
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

	private runPathWriteLocked(path: string, work: () => Promise<void>): Promise<void> {
		// All flush paths funnel through one per-path promise chain so direct
		// flushes cannot overlap with queued writes for the same file.
		const previous = this.pathWriteLocks.get(path) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		let tracked: Promise<void>;
		tracked = next.finally(() => {
			if (this.pathWriteLocks.get(path) === tracked) {
				this.pathWriteLocks.delete(path);
			}
		});
		this.pathWriteLocks.set(path, tracked);
		return tracked;
	}
}
