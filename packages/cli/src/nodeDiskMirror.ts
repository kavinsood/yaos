import chokidar, { type FSWatcher } from "chokidar";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { ensureDirectoryDurable, writeFileAtomic } from "./fs";
import type { Dirent, Stats } from "node:fs";
import * as nodePath from "node:path";
import * as Y from "yjs";
import type { ExternalEditPolicy } from "../../../src/settings";
import { applyDiffToYText } from "../../../src/sync/diff";
import { isExcluded } from "../../../src/sync/exclude";
import {
	isFrontmatterBlocked,
	validateFrontmatterTransition,
} from "../../../src/sync/frontmatterGuard";
import type { ReconcileMode, ReconcileResult, VaultSync } from "../../../src/sync/vaultSync";
import { isMarkdownSyncable, ORIGIN_SEED } from "../../../src/types";
import { normalizeVaultPath } from "../../../src/utils/normalizeVaultPath";

const WRITE_DEBOUNCE_MS = 300;
const WRITE_DEBOUNCE_BURST_MS = 1_000;
const WRITE_BURST_THRESHOLD = 20;
const MARKDOWN_DIRTY_SETTLE_MS = 350;
const SUPPRESS_MS = 500;
const MAX_CONCURRENT_WRITES = 5;
const WATCHER_STABILITY_MS = 200;
const WATCHER_POLL_MS = 50;

const LOCAL_STRING_ORIGINS = new Set([
	ORIGIN_SEED,
	"disk-sync",
]);

type DirtyReason = "create" | "modify";

interface SuppressionEntry {
	kind: "write" | "delete";
	expiresAt: number;
	expectedBytes?: number;
	expectedHash?: string;
}

interface ScannedDiskState {
	contents: Map<string, string>;
	presentPaths: Set<string>;
}

interface DirtyFile {
	path: string;
	reason: DirtyReason;
	content: string;
	stats: Stats | null;
}

export interface NodeDiskMirrorOptions {
	rootDir: string;
	deviceName: string;
	debug: boolean;
	excludePatterns: string[];
	maxFileSizeKB: number;
	externalEditPolicy: ExternalEditPolicy;
	frontmatterGuardEnabled: boolean;
	configDir?: string;
}

export interface NodeDiskMirrorDebugSnapshot {
	watcherReady: boolean;
	dirtyCount: number;
	deletedCount: number;
	queuedWrites: string[];
	suppressedCount: number;
}

function isLocalOrigin(origin: unknown, provider: unknown): boolean {
	if (origin === provider) return false;
	if (typeof origin === "string") return LOCAL_STRING_ORIGINS.has(origin);
	if (origin == null) return true;
	return true;
}

export class NodeDiskMirror {
	private readonly rootDir: string;
	private readonly configDir: string;
	private readonly maxFileSize: number;
	private watcher: FSWatcher | null = null;
	private watcherReady = false;
	private mapObserverCleanups: Array<() => void> = [];
	private dirtyMarkdownPaths = new Map<string, DirtyReason>();
	private deletedMarkdownPaths = new Set<string>();
	private markdownDrainPromise: Promise<void> | null = null;
	private markdownDrainTimer: ReturnType<typeof setTimeout> | null = null;
	private lastMarkdownDirtyAt = 0;
	private suppressedPaths = new Map<string, SuppressionEntry>();
	private writeQueue = new Set<string>();
	private forcedWritePaths = new Set<string>();
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private writeDrainPromise: Promise<void> | null = null;
	private pathWriteLocks = new Map<string, Promise<void>>();

	constructor(
		private readonly vaultSync: VaultSync,
		private readonly options: NodeDiskMirrorOptions,
	) {
		this.rootDir = nodePath.resolve(options.rootDir);
		this.configDir = options.configDir ?? ".obsidian";
		this.maxFileSize = options.maxFileSizeKB * 1024;
	}

	startMapObservers(): void {
		if (this.mapObserverCleanups.length > 0) return;

		const metaObserver = (event: Y.YMapEvent<import("../../../src/types").FileMeta>) => {
			if (isLocalOrigin(event.transaction.origin, this.vaultSync.provider)) {
				return;
			}
			event.changes.keys.forEach((change, fileId) => {
				const oldMeta = change.oldValue as import("../../../src/types").FileMeta | undefined;
				const newMeta = this.vaultSync.meta.get(fileId);
				const oldPath = typeof oldMeta?.path === "string" ? normalizeVaultPath(oldMeta.path) : null;
				const newPath = typeof newMeta?.path === "string" ? normalizeVaultPath(newMeta.path) : null;
				const wasDeleted = this.vaultSync.isFileMetaDeleted(oldMeta);
				const isDeleted = this.vaultSync.isFileMetaDeleted(newMeta);

				if (newPath && isDeleted && !wasDeleted) {
					void this.handleRemoteDelete(newPath);
					return;
				}

				if (newPath && !isDeleted && wasDeleted) {
					this.scheduleWrite(newPath);
					return;
				}

				if (oldPath && newPath && oldPath !== newPath && !isDeleted) {
					void this.handleRemoteRename(oldPath, newPath);
					return;
				}

				if ((change.action === "add" || change.action === "update") && newPath && !isDeleted) {
					this.scheduleWrite(newPath);
				}
			});
		};

		this.vaultSync.meta.observe(metaObserver);
		this.mapObserverCleanups.push(() => this.vaultSync.meta.unobserve(metaObserver));

		const afterTxnHandler = (txn: Y.Transaction) => {
			if (isLocalOrigin(txn.origin, this.vaultSync.provider)) return;

			for (const [changedType] of txn.changed) {
				if (!(changedType instanceof Y.Text)) continue;
				const fileId = this.vaultSync.getFileIdForText(changedType);
				if (!fileId) continue;
				const meta = this.vaultSync.meta.get(fileId);
				if (!meta || this.vaultSync.isFileMetaDeleted(meta)) continue;
				this.scheduleWrite(meta.path);
			}
		};

		this.vaultSync.ydoc.on("afterTransaction", afterTxnHandler);
		this.mapObserverCleanups.push(() => this.vaultSync.ydoc.off("afterTransaction", afterTxnHandler));
	}

	async reconcileFromDisk(mode: ReconcileMode): Promise<ReconcileResult> {
		const disk = await this.scanMarkdownFiles();
		const result = this.vaultSync.reconcileVault(
			disk.contents,
			disk.presentPaths,
			mode,
			this.options.deviceName,
		);

		for (const path of result.createdOnDisk) {
			this.queueImmediateWrite(path, `reconcile-create:${mode}`, true);
		}
		for (const path of result.updatedOnDisk) {
			this.queueImmediateWrite(path, `reconcile-update:${mode}`, true);
		}
		await this.kickWriteDrain();
		return result;
	}

	async startWatching(): Promise<void> {
		if (this.watcher) return;

		const watcher = chokidar.watch(".", {
			cwd: this.rootDir,
			persistent: true,
			ignoreInitial: true,
			alwaysStat: true,
			awaitWriteFinish: {
				stabilityThreshold: WATCHER_STABILITY_MS,
				pollInterval: WATCHER_POLL_MS,
			},
			ignored: [(rawPath, stats) => this.shouldIgnoreWatchPath(rawPath, stats ?? null)],
		});

		watcher
			.on("add", (rawPath, stats) => this.onDiskAdd(rawPath, stats ?? null))
			.on("change", (rawPath, stats) => this.onDiskChange(rawPath, stats ?? null))
			.on("unlink", (rawPath) => this.onDiskDelete(rawPath))
			.on("error", (error) => {
				console.error("[yaos-cli] chokidar watcher error:", error);
			});

		this.watcher = watcher;
		await new Promise<void>((resolve, reject) => {
			watcher.once("ready", () => {
				this.watcherReady = true;
				resolve();
			});
			watcher.once("error", reject);
		});
	}

	async stop(): Promise<void> {
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
			this.markdownDrainTimer = null;
		}
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		await this.markdownDrainPromise;
		await this.writeDrainPromise;
		if (this.watcher) {
			await this.watcher.close();
			this.watcher = null;
		}
		this.watcherReady = false;
		for (const cleanup of this.mapObserverCleanups) {
			cleanup();
		}
		this.mapObserverCleanups = [];
		this.dirtyMarkdownPaths.clear();
		this.deletedMarkdownPaths.clear();
		this.writeQueue.clear();
		this.forcedWritePaths.clear();
		this.suppressedPaths.clear();
		this.pathWriteLocks.clear();
	}

	getDebugSnapshot(): NodeDiskMirrorDebugSnapshot {
		return {
			watcherReady: this.watcherReady,
			dirtyCount: this.dirtyMarkdownPaths.size,
			deletedCount: this.deletedMarkdownPaths.size,
			queuedWrites: Array.from(this.writeQueue),
			suppressedCount: this.suppressedPaths.size,
		};
	}

	private onDiskAdd(rawPath: string, stats: Stats | null): void {
		const path = this.normalizeEventPath(rawPath);
		if (!path || this.shouldIgnoreNormalizedPath(path, stats)) return;
		this.markMarkdownDirty(path, "create");
	}

	private onDiskChange(rawPath: string, stats: Stats | null): void {
		const path = this.normalizeEventPath(rawPath);
		if (!path || this.shouldIgnoreNormalizedPath(path, stats)) return;
		this.markMarkdownDirty(path, "modify");
	}

	private onDiskDelete(rawPath: string): void {
		const path = this.normalizeEventPath(rawPath);
		if (!path || !this.isMarkdownPathSyncable(path)) return;
		this.deletedMarkdownPaths.add(path);
		this.dirtyMarkdownPaths.delete(path);
		this.lastMarkdownDirtyAt = Date.now();
		this.scheduleMarkdownDrain();
	}

	private markMarkdownDirty(path: string, reason: DirtyReason): void {
		const previous = this.dirtyMarkdownPaths.get(path);
		if (previous !== "create") {
			this.dirtyMarkdownPaths.set(path, reason);
		}
		this.deletedMarkdownPaths.delete(path);
		this.lastMarkdownDirtyAt = Date.now();
		this.scheduleMarkdownDrain();
	}

	private scheduleMarkdownDrain(): void {
		if (this.markdownDrainTimer) {
			clearTimeout(this.markdownDrainTimer);
		}

		this.markdownDrainTimer = setTimeout(() => {
			this.markdownDrainTimer = null;
			const sinceLastDirty = Date.now() - this.lastMarkdownDirtyAt;
			if (sinceLastDirty < MARKDOWN_DIRTY_SETTLE_MS) {
				this.scheduleMarkdownDrain();
				return;
			}
			void this.kickMarkdownDrain();
		}, MARKDOWN_DIRTY_SETTLE_MS);
	}

	private kickMarkdownDrain(): Promise<void> {
		if (this.markdownDrainPromise) return this.markdownDrainPromise;
		this.markdownDrainPromise = this.drainDirtyMarkdownPaths().finally(() => {
			this.markdownDrainPromise = null;
			if (this.dirtyMarkdownPaths.size > 0 || this.deletedMarkdownPaths.size > 0) {
				this.scheduleMarkdownDrain();
			}
		});
		return this.markdownDrainPromise;
	}

	private async drainDirtyMarkdownPaths(): Promise<void> {
		if (this.dirtyMarkdownPaths.size === 0 && this.deletedMarkdownPaths.size === 0) return;

		const batchDirty = Array.from(this.dirtyMarkdownPaths.entries());
		const batchDeletes = Array.from(this.deletedMarkdownPaths);
		this.dirtyMarkdownPaths.clear();
		this.deletedMarkdownPaths.clear();

		const survivingDeletes = new Set<string>();
		for (const path of batchDeletes) {
			if (!this.consumeDeleteSuppression(path)) {
				survivingDeletes.add(path);
			}
		}

		const dirtyFiles: DirtyFile[] = [];
		for (const [path, reason] of batchDirty) {
			const current = await this.readDirtyFile(path, reason);
			if (!current) continue;
			const suppressed = reason === "create"
				? await this.shouldSuppressWriteEvent(path, "create", current.stats)
				: await this.shouldSuppressWriteEvent(path, "modify", current.stats);
			if (suppressed) continue;
			dirtyFiles.push(current);
		}

		const renamePairs = this.inferRenamePairs(
			dirtyFiles.filter((entry) => entry.reason === "create"),
			survivingDeletes,
		);

		for (const [oldPath, newPath] of renamePairs) {
			this.vaultSync.queueRename(oldPath, newPath);
			survivingDeletes.delete(oldPath);
		}

		for (const path of survivingDeletes) {
			this.vaultSync.handleDelete(path, this.options.deviceName);
		}

		for (const dirtyFile of dirtyFiles) {
			if (dirtyFile.reason === "create" && this.vaultSync.isPendingRenameTarget(dirtyFile.path)) {
				continue;
			}
			await this.syncFileFromDisk(dirtyFile.path, dirtyFile.content);
		}
	}

	private inferRenamePairs(
		creates: DirtyFile[],
		deletes: Set<string>,
	): Map<string, string> {
		const renames = new Map<string, string>();
		for (const create of creates) {
			const exactBasenameMatches = this.findRenameCandidates(create, deletes, true);
			const candidates = exactBasenameMatches.length === 1
				? exactBasenameMatches
				: this.findRenameCandidates(create, deletes, false);
			if (candidates.length !== 1) continue;
			const oldPath = candidates[0];
			if (!oldPath) continue;
			renames.set(oldPath, create.path);
			deletes.delete(oldPath);
		}
		return renames;
	}

	private findRenameCandidates(
		create: DirtyFile,
		deletes: Set<string>,
		requireSameBasename: boolean,
	): string[] {
		const matches: string[] = [];
		const newBasename = nodePath.posix.basename(create.path);
		for (const oldPath of deletes) {
			if (requireSameBasename && nodePath.posix.basename(oldPath) !== newBasename) {
				continue;
			}
			const oldText = this.vaultSync.getTextForPath(oldPath);
			if (!oldText) continue;
			if (oldText.toJSON() !== create.content) continue;
			matches.push(oldPath);
		}
		return matches;
	}

	private async readDirtyFile(path: string, reason: DirtyReason): Promise<DirtyFile | null> {
		const absolutePath = this.toAbsolutePath(path);
		try {
			const [stats, content] = await Promise.all([
				fs.stat(absolutePath),
				fs.readFile(absolutePath, "utf8"),
			]);
			if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
				this.log(
					`syncFileFromDisk: skipping "${path}" (${Math.round(content.length / 1024)} KB exceeds limit)`,
				);
				return null;
			}
			return { path, reason, content, stats };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`[yaos-cli] failed reading dirty file "${path}":`, error);
			}
			return null;
		}
	}

	private async syncFileFromDisk(path: string, content: string): Promise<void> {
		if (!this.isMarkdownPathSyncable(path)) return;
		if (this.options.externalEditPolicy === "never") {
			this.log(`syncFileFromDisk: skipping "${path}" (external edit policy: never)`);
			return;
		}

		const existingText = this.vaultSync.getTextForPath(path);
		if (existingText) {
			const crdtContent = existingText.toJSON();
			if (crdtContent === content) return;
			if (this.shouldBlockFrontmatterIngest(path, crdtContent, content, "disk-to-crdt")) {
				return;
			}
			applyDiffToYText(existingText, crdtContent, content, "disk-sync");
			return;
		}

		if (this.shouldBlockFrontmatterIngest(path, null, content, "disk-to-crdt-seed")) {
			return;
		}

		this.vaultSync.ensureFile(path, content, this.options.deviceName);
	}

	private shouldBlockFrontmatterIngest(
		path: string,
		previousContent: string | null,
		nextContent: string,
		reason: string,
	): boolean {
		if (!this.options.frontmatterGuardEnabled) return false;
		const validation = validateFrontmatterTransition(previousContent, nextContent);
		if (!isFrontmatterBlocked(validation)) return false;
		this.log(
			`frontmatter ingest blocked for "${path}" ` +
				`(${validation.reasons.join(", ") || validation.risk}) [${reason}]`,
		);
		return true;
	}

	private scheduleWrite(path: string): void {
		path = normalizeVaultPath(path);
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);
		const delay = this.writeQueue.size >= WRITE_BURST_THRESHOLD
			? WRITE_DEBOUNCE_BURST_MS
			: WRITE_DEBOUNCE_MS;
		this.debounceTimers.set(
			path,
			setTimeout(() => {
				this.debounceTimers.delete(path);
				this.writeQueue.add(path);
				void this.kickWriteDrain();
			}, delay),
		);
	}

	private queueImmediateWrite(path: string, reason: string, force = false): void {
		path = normalizeVaultPath(path);
		if (force) {
			this.forcedWritePaths.add(path);
		}
		this.writeQueue.add(path);
		this.log(`queueImmediateWrite: "${path}" (${reason}${force ? ", forced" : ""})`);
		void this.kickWriteDrain();
	}

	private kickWriteDrain(): Promise<void> {
		if (this.writeDrainPromise) return this.writeDrainPromise;
		this.writeDrainPromise = this.drainWriteQueue().finally(() => {
			this.writeDrainPromise = null;
		});
		return this.writeDrainPromise;
	}

	private async drainWriteQueue(): Promise<void> {
		while (this.writeQueue.size > 0) {
			if (this.writeQueue.size > WRITE_BURST_THRESHOLD) {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}

			const batch: string[] = [];
			for (const path of this.writeQueue) {
				batch.push(path);
				if (batch.length >= MAX_CONCURRENT_WRITES) break;
			}
			for (const path of batch) {
				this.writeQueue.delete(path);
			}

			const results = await Promise.allSettled(
				batch.map((path) => {
					const force = this.forcedWritePaths.delete(path);
					return this.flushWrite(path, force);
				}),
			);
			for (let i = 0; i < results.length; i++) {
				const result = results[i];
				if (result != null && result.status === "rejected") {
					console.error(`[yaos-cli] write failed for "${batch[i]}":`, result.reason);
				}
			}
		}
	}

	private async flushWrite(path: string, force = false): Promise<void> {
		path = normalizeVaultPath(path);
		return this.runPathWriteLocked(path, () => this.flushWriteUnlocked(path, force));
	}

	private async flushWriteUnlocked(path: string, _force: boolean): Promise<void> {
		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) return;
		const content = ytext.toJSON();
		const absolutePath = this.toAbsolutePath(path);
		const currentContent = await this.readFileIfExists(absolutePath);
		if (currentContent === content) return;
		if (this.shouldBlockFrontmatterWrite(path, currentContent, content)) return;

		await ensureDirectoryDurable(nodePath.dirname(absolutePath));
		await this.suppressWrite(path, content);
		await writeFileAtomic(absolutePath, content);
	}

	private shouldBlockFrontmatterWrite(
		path: string,
		previousContent: string | null,
		nextContent: string,
	): boolean {
		if (!this.options.frontmatterGuardEnabled) return false;
		const validation = validateFrontmatterTransition(previousContent, nextContent);
		if (!isFrontmatterBlocked(validation)) return false;
		this.log(
			`frontmatter write blocked for "${path}" ` +
				`(${validation.reasons.join(", ") || validation.risk})`,
		);
		return true;
	}

	private async handleRemoteDelete(path: string): Promise<void> {
		path = normalizeVaultPath(path);
		this.deletedMarkdownPaths.delete(path);
		this.dirtyMarkdownPaths.delete(path);
		this.writeQueue.delete(path);
		this.forcedWritePaths.delete(path);
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
		}

		this.suppressDelete(path);
		const absolutePath = this.toAbsolutePath(path);
		try {
			await fs.rm(absolutePath, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.error(`[yaos-cli] remote delete failed for "${path}":`, error);
			}
		}
	}

	private async handleRemoteRename(oldPath: string, newPath: string): Promise<void> {
		oldPath = normalizeVaultPath(oldPath);
		newPath = normalizeVaultPath(newPath);
		if (oldPath === newPath) return;

		this.deletedMarkdownPaths.delete(oldPath);
		this.dirtyMarkdownPaths.delete(oldPath);
		this.dirtyMarkdownPaths.delete(newPath);
		this.writeQueue.delete(oldPath);
		this.forcedWritePaths.delete(oldPath);
		const oldTimer = this.debounceTimers.get(oldPath);
		if (oldTimer) {
			clearTimeout(oldTimer);
			this.debounceTimers.delete(oldPath);
		}

		const newContent = this.vaultSync.getTextForPath(newPath)?.toJSON() ?? this.vaultSync.getTextForPath(oldPath)?.toJSON() ?? null;
		if (newContent != null) {
			await this.suppressWrite(newPath, newContent);
		}
		this.suppressDelete(oldPath);

		const oldAbsolutePath = this.toAbsolutePath(oldPath);
		const newAbsolutePath = this.toAbsolutePath(newPath);
		let needsWriteFallback = false;
		try {
			await ensureDirectoryDurable(nodePath.dirname(newAbsolutePath));
			await fs.rename(oldAbsolutePath, newAbsolutePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.log(`remote rename fell back to write for "${oldPath}" -> "${newPath}"`);
			}
			needsWriteFallback = true;
		}

		if (needsWriteFallback) {
			// Write the new file first, then delete the old file after the
			// write completes. Deleting before the write risks losing both
			// files if the write also fails.
			this.queueImmediateWrite(newPath, "remote-rename", true);
			await this.kickWriteDrain();
			await fs.rm(oldAbsolutePath, { force: true }).catch(() => undefined);
		} else {
			this.queueImmediateWrite(newPath, "remote-rename", true);
		}
	}

	private consumeDeleteSuppression(path: string): boolean {
		path = normalizeVaultPath(path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;
		this.suppressedPaths.delete(path);
		return entry.kind === "delete";
	}

	private async shouldSuppressWriteEvent(
		path: string,
		event: "modify" | "create",
		stats: Stats | null,
	): Promise<boolean> {
		path = normalizeVaultPath(path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;
		if (entry.kind !== "write") {
			this.suppressedPaths.delete(path);
			return false;
		}

		if (
			stats
			&& typeof entry.expectedBytes === "number"
			&& stats.size !== entry.expectedBytes
		) {
			this.suppressedPaths.delete(path);
			this.log(
				`suppression: "${path}" ${event} size mismatch ` +
					`(expected=${entry.expectedBytes}, observed=${stats.size})`,
			);
			return false;
		}

		try {
			const content = await fs.readFile(this.toAbsolutePath(path), "utf8");
			const fingerprint = this.fingerprintContent(content);
			if (
				fingerprint.bytes === entry.expectedBytes
				&& fingerprint.hash === entry.expectedHash
			) {
				this.suppressedPaths.delete(path);
				return true;
			}
		} catch {
			// Fall through and let normal sync handle it.
		}

		this.suppressedPaths.delete(path);
		return false;
	}

	private getActiveSuppression(path: string): SuppressionEntry | null {
		path = normalizeVaultPath(path);
		const entry = this.suppressedPaths.get(path);
		if (!entry) return null;
		if (Date.now() < entry.expiresAt) {
			return entry;
		}
		this.suppressedPaths.delete(path);
		return null;
	}

	private async suppressWrite(path: string, content: string): Promise<void> {
		const fingerprint = this.fingerprintContent(content);
		this.suppressedPaths.set(normalizeVaultPath(path), {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
		});
	}

	private suppressDelete(path: string): void {
		this.suppressedPaths.set(normalizeVaultPath(path), {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
		});
	}

	private fingerprintContent(content: string): { bytes: number; hash: string } {
		const bytes = Buffer.byteLength(content, "utf8");
		const hash = createHash("sha256").update(content, "utf8").digest("hex");
		return { bytes, hash };
	}

	private runPathWriteLocked(path: string, work: () => Promise<void>): Promise<void> {
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

	private async scanMarkdownFiles(): Promise<ScannedDiskState> {
		const contents = new Map<string, string>();
		const presentPaths = new Set<string>();
		await this.scanDirectory("", contents, presentPaths);
		return { contents, presentPaths };
	}

	private async scanDirectory(
		relativeDir: string,
		contents: Map<string, string>,
		presentPaths: Set<string>,
	): Promise<void> {
		const absoluteDir = relativeDir
			? this.toAbsolutePath(relativeDir)
			: this.rootDir;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(absoluteDir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}

		for (const entry of entries) {
			const relativePath = normalizeVaultPath(
				relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
			);
			const absolutePath = this.toAbsolutePath(relativePath);
			let stats: Stats;
			try {
				stats = await fs.lstat(absolutePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (stats.isDirectory()) {
				if (isExcluded(`${relativePath}/`, this.options.excludePatterns, this.configDir)) {
					continue;
				}
				await this.scanDirectory(relativePath, contents, presentPaths);
				continue;
			}
			if (!stats.isFile()) continue;
			if (!this.isMarkdownPathSyncable(relativePath)) continue;
			presentPaths.add(relativePath);
			let content: string;
			try {
				content = await fs.readFile(absolutePath, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (this.maxFileSize > 0 && content.length > this.maxFileSize) {
				continue;
			}
			contents.set(relativePath, content);
		}
	}

	private shouldIgnoreWatchPath(rawPath: string, stats: Stats | null): boolean {
		const path = this.normalizeEventPath(rawPath);
		if (!path) return false;
		return this.shouldIgnoreNormalizedPath(path, stats);
	}

	private shouldIgnoreNormalizedPath(path: string, stats: Stats | null): boolean {
		if (stats?.isDirectory()) {
			return isExcluded(`${path}/`, this.options.excludePatterns, this.configDir);
		}
		if (stats === null) {
			// No stats available yet — don't prune. Chokidar will re-evaluate
			// with stats once it has them, so directories like "notes.v2" are
			// not incorrectly excluded.
			return false;
		}
		return !this.isMarkdownPathSyncable(path);
	}

	private isMarkdownPathSyncable(path: string): boolean {
		return isMarkdownSyncable(path, this.options.excludePatterns, this.configDir);
	}

	private normalizeEventPath(rawPath: string): string | null {
		const normalized = normalizeVaultPath(rawPath);
		return normalized.length > 0 ? normalized : null;
	}

	private toAbsolutePath(vaultPath: string): string {
		const parts = normalizeVaultPath(vaultPath)
			.split("/")
			.filter((segment) => segment.length > 0);
		const absolute = nodePath.join(this.rootDir, ...parts);
		const relative = nodePath.relative(this.rootDir, absolute);
		if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
			throw new Error(`Path traversal rejected: "${vaultPath}" resolves outside vault root`);
		}
		return absolute;
	}

	private async readFileIfExists(absolutePath: string): Promise<string | null> {
		try {
			return await fs.readFile(absolutePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			throw error;
		}
	}

	private log(message: string): void {
		if (this.options.debug) {
			console.debug(`[yaos-cli:disk] ${message}`);
		}
	}
}
