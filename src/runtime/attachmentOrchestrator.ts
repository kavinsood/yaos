import { type App, Notice } from "obsidian";
import { BlobSyncManager, type BlobQueueSnapshot } from "../sync/blobSync";
import type { BlobHashCache } from "../sync/blobHashCache";
import type { VaultSync } from "../sync/vaultSync";
import type { RuntimeConfig } from "./runtimeConfig";
import { formatUnknown } from "../utils/format";
import type { TraceHttpContext, TraceRecord } from "../observability/traceContext";
import type { PreservedUnresolvedEntry } from "../sync/preservedUnresolved";

interface AttachmentOrchestratorDeps {
	app: App;
	getVaultSync(): VaultSync | null;
	getRuntimeConfig(): RuntimeConfig;
	getServerSupportsAttachments(): boolean;
	getTraceHttpContext(): TraceHttpContext | undefined;
	getBlobHashCache(): BlobHashCache;
	getExcludePatterns(): string[];
	persistBlobQueue(snapshot: BlobQueueSnapshot): Promise<void>;
	clearPersistedBlobQueue(): Promise<void>;
	getPreservedUnresolvedEntries(): PreservedUnresolvedEntry[];
	onPreservedUnresolvedChanged(): void;
	trace: TraceRecord;
	scheduleTraceStateSnapshot(reason: string): void;
	refreshStatusBar(): void;
	log(message: string): void;
}

export class AttachmentOrchestrator {
	private blobSync: BlobSyncManager | null = null;
	private savedBlobQueue: BlobQueueSnapshot | null = null;
	private shownAttachmentNudge = false;
	private downloadGateLayoutReady: boolean;
	private downloadGateStartupReady = false;
	/**
	 * Serializes periodic queue checkpoints with terminal stop/destroy state.
	 * A terminal clear must run after any earlier status-tick save so a delayed
	 * checkpoint cannot resurrect a queue that has already drained.
	 */
	private queuePersistence = Promise.resolve();

	constructor(private readonly deps: AttachmentOrchestratorDeps) {
		this.downloadGateLayoutReady = deps.app.workspace.layoutReady;
		deps.app.workspace.onLayoutReady(() => {
			const firstReady = !this.downloadGateLayoutReady;
			this.downloadGateLayoutReady = true;
			if (firstReady) {
				this.deps.trace("trace", "blob-download-layout-ready", {});
				this.deps.log("Blob download gate: workspace layout ready");
			}
			this.maybeOpenDownloadGate("layout-ready");
		});
	}

	get manager(): BlobSyncManager | null {
		return this.blobSync;
	}

	hydrateSavedQueue(snapshot: BlobQueueSnapshot | null): void {
		this.savedBlobQueue = snapshot;
	}

	start(reason: string, runInitialReconcile: boolean): void {
		if (this.blobSync) return;
		const runtimeConfig = this.deps.getRuntimeConfig();
		if (!runtimeConfig.enableAttachmentSync || !this.deps.getServerSupportsAttachments()) return;

		const vaultSync = this.deps.getVaultSync();
		if (!vaultSync) return;
		if (!runtimeConfig.host || !runtimeConfig.deviceToken) return;

		const blobSync = new BlobSyncManager(
			this.deps.app,
			vaultSync,
			{
				host: runtimeConfig.host,
				deviceToken: runtimeConfig.deviceToken,
				vaultId: runtimeConfig.vaultId,
				maxAttachmentSizeKB: runtimeConfig.maxAttachmentSizeKB,
				attachmentConcurrency: runtimeConfig.attachmentConcurrency,
				debug: runtimeConfig.debug,
				trace: this.deps.getTraceHttpContext(),
			},
			this.deps.getBlobHashCache(),
			this.deps.trace,
			this.deps.getPreservedUnresolvedEntries(),
			() => this.deps.onPreservedUnresolvedChanged(),
		);

		this.blobSync = blobSync;
		blobSync.startObservers();
		this.deps.log(`Attachment sync engine started (${reason})`);

		if (this.savedBlobQueue) {
			blobSync.importQueue(this.savedBlobQueue);
			this.savedBlobQueue = null;
		}

		this.maybeOpenDownloadGate(`engine-start:${reason}`);

		if (runInitialReconcile) {
			try {
				const result = blobSync.reconcile("authoritative", this.deps.getExcludePatterns());
				this.deps.log(
					`Attachment reconcile (${reason}): queued ` +
					`${result.uploadQueued} uploads, ${result.downloadQueued} downloads, ${result.skipped} skipped`,
				);
			} catch (err) {
				this.deps.log(`Attachment reconcile (${reason}) failed: ${formatUnknown(err)}`);
			}
		}
	}

	async stop(reason: string): Promise<void> {
		if (!this.blobSync) return;
		await this.stopActiveManager();
		this.deps.log(`Attachment sync engine stopped (${reason})`);
	}

	async destroy(): Promise<void> {
		try {
			await this.stopActiveManager();
		} finally {
			this.shownAttachmentNudge = false;
			this.downloadGateStartupReady = false;
		}
	}

	private async stopActiveManager(): Promise<void> {
		const blobSync = this.blobSync;
		if (!blobSync) return;

		// Clear the public handle before the first await. This prevents a status
		// tick from appending a stale checkpoint after terminal persistence has
		// been queued for this manager.
		this.blobSync = null;
		try {
			await this.persistQueueSnapshot(blobSync.exportQueue());
		} finally {
			blobSync.destroy();
		}
	}

	async refresh(reason = "settings-change"): Promise<void> {
		if (!this.deps.getVaultSync()) return;
		const runtimeConfig = this.deps.getRuntimeConfig();
		if (runtimeConfig.enableAttachmentSync && this.deps.getServerSupportsAttachments()) {
			this.start(reason, true);
		} else {
			await this.stop(reason);
		}
		this.deps.refreshStatusBar();
	}

	handleStatusTick(): void {
		const blobSync = this.blobSync;
		if (!blobSync) return;
		void this.persistQueueSnapshot(blobSync.exportQueue());
	}

	private persistQueueSnapshot(snapshot: BlobQueueSnapshot): Promise<void> {
		const persist = snapshot.uploads.length > 0 || snapshot.downloads.length > 0
			? () => this.deps.persistBlobQueue(snapshot)
			: () => this.deps.clearPersistedBlobQueue();
		const queued = this.queuePersistence.then(persist, persist);

		// Keep the lane live after a failed periodic checkpoint while ensuring
		// failures are observable instead of becoming unhandled rejections.
		this.queuePersistence = queued.catch((error) => {
			this.deps.log(`Attachment queue persistence failed: ${formatUnknown(error)}`);
		});
		return queued;
	}

	markStartupReady(reason: string): void {
		if (this.downloadGateStartupReady) return;
		this.downloadGateStartupReady = true;
		this.deps.trace("trace", "blob-download-startup-ready", { reason });
		this.deps.log(`Blob download gate: startup ready (${reason})`);
		this.maybeOpenDownloadGate(`startup-ready:${reason}`);
	}

	notifyUnsupportedAttachmentCreate(): void {
		if (this.shownAttachmentNudge) return;
		this.shownAttachmentNudge = true;
		new Notice(
			"This file won't sync yet. Attachment sync needs object storage. Open settings for setup.",
			10000,
		);
	}

	private maybeOpenDownloadGate(reason: string): void {
		if (!this.blobSync) return;
		if (this.blobSync.isDownloadGateOpen) return;
		if (!this.downloadGateLayoutReady || !this.downloadGateStartupReady) return;
		this.deps.trace("trace", "blob-download-gate-open", {
			reason,
			pendingDownloads: this.blobSync.pendingDownloads,
		});
		this.blobSync.openDownloadGate(reason);
		this.deps.scheduleTraceStateSnapshot(`blob-download-gate:${reason}`);
	}
}
