import { type App, Notice } from "obsidian";
import { BlobSyncManager, type BlobQueueSnapshot } from "../sync/blobSync";
import type { BlobHashCache } from "../sync/blobHashCache";
import type { VaultSync } from "../sync/vaultSync";
import type { RuntimeConfig } from "./runtimeConfig";
import { formatUnknown } from "../utils/format";
import type { TraceHttpContext, TraceRecord } from "../debug/trace";

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
		if (!runtimeConfig.host || !runtimeConfig.token) return;

		const blobSync = new BlobSyncManager(
			this.deps.app,
			vaultSync,
			{
				host: runtimeConfig.host,
				token: runtimeConfig.token,
				vaultId: runtimeConfig.vaultId,
				maxAttachmentSizeKB: runtimeConfig.maxAttachmentSizeKB,
				attachmentConcurrency: runtimeConfig.attachmentConcurrency,
				debug: runtimeConfig.debug,
				trace: this.deps.getTraceHttpContext(),
			},
			this.deps.getBlobHashCache(),
			this.deps.trace,
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
		const snapshot = this.blobSync.exportQueue();
		if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
			await this.deps.persistBlobQueue(snapshot);
		}
		this.blobSync.destroy();
		this.blobSync = null;
		this.deps.log(`Attachment sync engine stopped (${reason})`);
	}

	destroy(): void {
		if (this.blobSync) {
			const snapshot = this.blobSync.exportQueue();
			if (snapshot.uploads.length > 0 || snapshot.downloads.length > 0) {
				void this.deps.persistBlobQueue(snapshot);
			}
		}
		this.blobSync?.destroy();
		this.blobSync = null;
		this.shownAttachmentNudge = false;
		this.downloadGateStartupReady = false;
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
		if (!this.blobSync) return;
		if (this.blobSync.pendingUploads > 0 || this.blobSync.pendingDownloads > 0) {
			void this.deps.persistBlobQueue(this.blobSync.exportQueue());
		} else {
			void this.deps.clearPersistedBlobQueue();
		}
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
